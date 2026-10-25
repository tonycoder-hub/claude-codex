// Tests for the ssh reverse-tunnel ingress provider.
//
// Nothing here spawns a real `ssh`, binds a listener, or reaches a host. The
// child is an injected fake, the clock is an injected fake, and the environment
// is a plain object. That is not only hygiene: the resident Mac carries live
// production forwards built from these exact flags, and a test that could spawn
// the real thing is a test that could collide with one of them on a port.
//
// Two groups carry most of the weight, because they are the two ways this
// provider can be dangerous rather than merely broken:
//
//   * **No hot loop.** A child that exits instantly once produced about 35,000
//     processes in this project at roughly 500 a minute. The tests assert the
//     structural property that makes that impossible -- exactly one bounded
//     delay between consecutive spawns, never below the floor, never above the
//     ceiling -- rather than timing anything.
//   * **No secret on the process table.** argv is world-readable, so the tests
//     check both that a credential-shaped argument is refused and that the
//     refusal does not echo it.
//
// Every wait in this file is step-counted against `setImmediate`, never against
// the wall clock. With an injected instant clock a deadline-bounded wait does
// not wait, it spins -- which has already cost this suite real time once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSshProvider,
  buildSshArgs,
  buildChildEnv,
  assertNoSecretsInArgv,
  classifyExit,
  isRetryable,
  backoffBandFor,
  nextDelayMs,
  EXIT_CLASSES,
  DEFAULT_BACKOFF,
  ENV_ALLOWLIST,
  RESERVED_SSH_OPTIONS,
  SSH_CAPABILITIES,
  TLS_VARIANTS,
  SshIngressError,
  PROVIDER_SHAPE,
} from '../../../src/relay/providers/ssh.mjs';
import {
  LISTENER_CONFIGURING,
  validateProvider,
  startProvider,
} from '../../../src/relay/provider.mjs';

// --- fakes ------------------------------------------------------------------

/**
 * A fake `ssh`. `plan(n)` decides what the nth child does:
 *   { alive: true }                      stays up until it is killed
 *   { stderr, code, signal }             dies on the next microtask
 *   { error: 'spawn ssh ENOENT' }        never starts
 *   { alive: true, ignoreSigterm: true } stays up and ignores SIGTERM
 */
function fakeSsh(plan) {
  const spawns = [];
  function spawn(command, args, options) {
    const n = spawns.length + 1;
    const spec = plan(n) ?? { alive: true };
    const handlers = new Map();
    const stderrHandlers = [];
    const signals = [];
    let dead = false;
    const child = {
      pid: 9000 + n,
      exitCode: null,
      stderr: {
        on(event, fn) {
          if (event === 'data') stderrHandlers.push(fn);
          return child.stderr;
        },
      },
      on(event, fn) {
        handlers.set(event, fn);
        return child;
      },
      kill(signal) {
        signals.push(signal);
        if (spec.ignoreSigterm && signal === 'SIGTERM') return true;
        child.die({ code: null, signal });
        return true;
      },
      // Real ssh writes its diagnostic, then exits, then its stdio closes.
      // The fake keeps that order, because the provider depends on it.
      die({ code = 255, signal = null, stderr = '' } = {}) {
        if (dead) return;
        dead = true;
        if (stderr) for (const fn of stderrHandlers) fn(stderr);
        child.exitCode = code;
        handlers.get('exit')?.(code, signal);
        handlers.get('close')?.(code, signal);
      },
      fail(message) {
        if (dead) return;
        dead = true;
        handlers.get('error')?.(new Error(message));
      },
    };
    spawns.push({ command, args, options, child, signals, spec });
    if (spec.error) queueMicrotask(() => child.fail(spec.error));
    else if (!spec.alive) {
      queueMicrotask(() => child.die({
        code: spec.code ?? 255, signal: spec.signal ?? null, stderr: spec.stderr ?? '',
      }));
    }
    return child;
  }
  return { spawn, spawns };
}

/** An instant clock that records what it was asked to wait for. */
function fakeClock({ hold = [] } = {}) {
  const sleeps = [];
  const sleep = (ms, reason = 'unknown') => {
    sleeps.push({ ms, reason });
    // A held reason never resolves, which is how a test can observe a delay
    // that is still pending without any real time passing.
    if (hold.includes(reason)) return new Promise(() => {});
    return Promise.resolve();
  };
  return { sleep, sleeps, of: (reason) => sleeps.filter((s) => s.reason === reason).map((s) => s.ms) };
}

function recordingLogger() {
  const events = [];
  const at = (level) => (event, data) => { events.push({ level, event, data }); };
  return {
    events,
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    count: (event) => events.filter((e) => e.event === event).length,
  };
}

/**
 * Step-counted, not deadline-bounded. With an instant clock a wall-clock bound
 * would spin instead of waiting, so progress is counted in event-loop turns.
 */
async function waitFor(predicate, label, steps = 2000) {
  for (let i = 0; i < steps; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => { setImmediate(resolve); });
  }
  throw new Error(`waitFor(${label}) did not happen within ${steps} steps`);
}

const TARGET = Object.freeze({ host: '127.0.0.1', port: 8792, name: 'resident' });

/** Fast, jitter-free supervision defaults so assertions are about structure. */
function supervised(overrides = {}) {
  return {
    host: 'remote.invalid',
    user: 'tunnel',
    remotePort: 18443,
    readySettleMs: 10,
    readyPollMs: 10,
    stopGraceMs: 200,
    stopStepMs: 50,
    random: () => 0,
    env: { PATH: '/usr/bin', HOME: '/home/u' },
    backoff: {
      connection: { floorMs: 100, ceilingMs: 800, factor: 2, jitterRatio: 0 },
      forward: { floorMs: 5_000, ceilingMs: 20_000, factor: 2, jitterRatio: 0 },
    },
    ...overrides,
  };
}

const STDERR = Object.freeze({
  // Verbatim from the format strings in ssh(1) on the build host (OpenSSH 9.2p1).
  forward: 'Error: remote port forwarding failed for listen port 18443\n',
  forwardWarning: 'Warning: remote port forwarding failed for listen port 18443\n',
  bindBusy: 'bind: Address already in use\n',
  refused: 'ssh: connect to host remote.invalid port 22: Connection refused\n',
  keepalive: 'Timeout, server remote.invalid not responding.\n',
  banner: 'kex_exchange_identification: Connection closed by remote host\n',
  hostKeyChanged: '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n',
  hostKeyFailed: 'Host key verification failed.\n',
  denied: 'tunnel@remote.invalid: Permission denied (publickey).\n',
});

// --- the contract with the shared interface ---------------------------------

test('the provider is the listener-configuring shape the interface defines', () => {
  const provider = createSshProvider(supervised());
  assert.equal(provider.shape, LISTENER_CONFIGURING);
  assert.equal(PROVIDER_SHAPE, LISTENER_CONFIGURING);
  assert.equal(provider.name, 'ssh');
  assert.equal(validateProvider(provider), provider);
});

test('the shared validator refuses a target that cannot describe the far end of the forward', async () => {
  const provider = createSshProvider(supervised({ spawn: fakeSsh(() => ({ alive: true })).spawn }));
  await assert.rejects(
    () => startProvider(provider, { target: { name: 'resident' } }),
    /needs target\.host and target\.port/,
  );
});

test('a started provider satisfies the handle contract that startProvider enforces', async () => {
  const ssh = fakeSsh(() => ({ alive: true }));
  const clock = fakeClock();
  const provider = createSshProvider(supervised({ spawn: ssh.spawn, sleep: clock.sleep }));
  const handle = await startProvider(provider, { target: TARGET });
  assert.equal(handle.kind, 'ssh');
  assert.equal(handle.publicUrl, null);
  await handle.stop();
  await handle.stop(); // startProvider wraps stop; the provider is idempotent too
});

// --- argv -------------------------------------------------------------------

test('the argv mirrors the flags the production forwards already run with', () => {
  const args = buildSshArgs({
    host: 'remote.invalid', user: 'tunnel', remotePort: 18443,
    targetHost: '127.0.0.1', targetPort: 8792,
  });
  const joined = args.join(' ');
  for (const flag of ['-N', '-T', '-n', '-x']) assert.ok(args.includes(flag), `missing ${flag}`);
  for (const option of [
    'BatchMode=yes',
    'StrictHostKeyChecking=yes',
    'ExitOnForwardFailure=yes',
    'ServerAliveInterval=20',
    'ServerAliveCountMax=3',
    'ConnectionAttempts=1',
    'ForkAfterAuthentication=no',
    'ControlMaster=no',
    'ControlPath=none',
    'PasswordAuthentication=no',
    'NumberOfPasswordPrompts=0',
    'PreferredAuthentications=publickey',
  ]) {
    assert.ok(args.includes(option), `missing -o ${option}`);
  }
  // Retrying is the supervisor's job; ssh must not also retry behind its back.
  assert.ok(joined.includes('ConnectionAttempts=1'));
});

test('the remote forward is spelled with an explicit bind address', () => {
  const args = buildSshArgs({
    host: 'remote.invalid', remotePort: 18443, targetHost: '127.0.0.1', targetPort: 8792,
  });
  const at = args.indexOf('-R');
  assert.notEqual(at, -1);
  // Four fields. The three-field form lets sshd pick the bind address from a
  // server setting we cannot see from the client.
  assert.equal(args[at + 1], '127.0.0.1:18443:127.0.0.1:8792');
  assert.equal(args.at(-1), 'remote.invalid');
});

test('the user ssh config is excluded by default and included only on request', () => {
  const isolated = buildSshArgs({
    host: 'h', remotePort: 1, targetHost: '127.0.0.1', targetPort: 2,
  });
  assert.ok(isolated.includes('-F') && isolated.includes('/dev/null'));

  const inherited = buildSshArgs({
    host: 'h', remotePort: 1, targetHost: '127.0.0.1', targetPort: 2, useUserConfig: true,
  });
  assert.ok(!inherited.includes('/dev/null'));
});

test('an identity is named by path and pinned with IdentitiesOnly', () => {
  const args = buildSshArgs({
    host: 'h', remotePort: 1, targetHost: '127.0.0.1', targetPort: 2,
    identityFile: '/keys/tunnel-ed25519', identityAgent: '/run/agent.sock',
    knownHostsFile: '/keys/known_hosts.tunnel',
  });
  assert.ok(args.includes('IdentityFile=/keys/tunnel-ed25519'));
  assert.ok(args.includes('IdentitiesOnly=yes'));
  assert.ok(args.includes('IdentityAgent=/run/agent.sock'));
  assert.ok(args.includes('UserKnownHostsFile=/keys/known_hosts.tunnel'));
});

test('an option this provider depends on cannot be overridden by a caller', () => {
  for (const option of ['ExitOnForwardFailure', 'ProxyCommand', 'SetEnv', 'StrictHostKeyChecking', 'RemoteForward']) {
    assert.ok(RESERVED_SSH_OPTIONS.includes(option.toLowerCase()), `${option} should be reserved`);
    assert.throws(
      () => buildSshArgs({
        host: 'h', remotePort: 1, targetHost: '127.0.0.1', targetPort: 2,
        extraOptions: { [option]: 'anything' },
      }),
      (err) => err instanceof SshIngressError && err.code === 'reserved-ssh-option',
    );
  }
});

// --- no secret reaches argv --------------------------------------------------

test('a credential-shaped argument is refused before it can reach the process table', () => {
  for (const value of ['hunter2-password', 'my-passphrase', 'ghp_sometoken', 'an api_key', 'Bearer abc']) {
    assert.throws(
      () => assertNoSecretsInArgv(['-o', `Whatever=${value}`]),
      (err) => err instanceof SshIngressError && err.code === 'secret-in-argv',
    );
  }
});

test('the refusal never echoes the value it refused', () => {
  const leak = 'correct-horse-battery-passphrase';
  assert.throws(
    () => assertNoSecretsInArgv(['-o', `Whatever=${leak}`]),
    (err) => err instanceof SshIngressError && !err.message.includes(leak) && !String(err.stack).includes(leak),
  );
});

test('a credential smuggled through an extra option is refused by the same check', () => {
  assert.throws(
    () => buildSshArgs({
      host: 'h', remotePort: 1, targetHost: '127.0.0.1', targetPort: 2,
      extraOptions: { Tag: 'deploy-token-value' },
    }),
    (err) => err instanceof SshIngressError && err.code === 'secret-in-argv',
  );
});

test('an ordinary invocation carries nothing credential-shaped', () => {
  const args = buildSshArgs({
    host: 'remote.invalid', user: 'tunnel', remotePort: 18443,
    targetHost: '127.0.0.1', targetPort: 8792, identityFile: '/keys/tunnel-ed25519',
  });
  assert.deepEqual(assertNoSecretsInArgv(args), args);
});

// --- no secret reaches the environment ---------------------------------------

test('the child environment is an allowlist rather than an inheritance', () => {
  const env = buildChildEnv({
    PATH: '/usr/bin', HOME: '/home/u', SSH_AUTH_SOCK: '/run/agent.sock',
    AWS_SECRET_ACCESS_KEY: 'x', GITHUB_TOKEN: 'y', OPENAI_API_KEY: 'z',
  });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH', 'SSH_AUTH_SOCK']);
  assert.deepEqual([...ENV_ALLOWLIST].sort(), ['HOME', 'PATH', 'SSH_AUTH_SOCK']);
});

test('SSH_ASKPASS and DISPLAY are withheld so ssh has no way to ask for a passphrase', () => {
  const env = buildChildEnv({ PATH: '/usr/bin', SSH_ASKPASS: '/bin/leak', DISPLAY: ':0' });
  assert.equal(env.SSH_ASKPASS, undefined);
  assert.equal(env.DISPLAY, undefined);
});

test('a credential in the parent environment does not reach the spawned child', async () => {
  const ssh = fakeSsh(() => ({ alive: true }));
  const clock = fakeClock();
  const provider = createSshProvider(supervised({
    spawn: ssh.spawn,
    sleep: clock.sleep,
    env: { PATH: '/usr/bin', HOME: '/home/u', RELAY_TOKEN: 'super-secret-value', SSH_ASKPASS: '/bin/leak' },
  }));
  const handle = await provider.start({ target: TARGET, logger: recordingLogger() });
  const { options, args } = ssh.spawns[0];
  assert.deepEqual(Object.keys(options.env).sort(), ['HOME', 'PATH']);
  assert.ok(!JSON.stringify(options.env).includes('super-secret-value'));
  assert.ok(!args.join(' ').includes('super-secret-value'));
  await handle.stop();
});

// --- TLS variants and capabilities -------------------------------------------

test('the passthrough variant leaves no browser-facing key on the remote', () => {
  assert.equal(TLS_VARIANTS.passthrough.remoteHoldsKey, false);
  assert.equal(TLS_VARIANTS.passthrough.tlsTerminatedBy, 'resident');
  assert.equal(TLS_VARIANTS.passthrough.passesT1, true);
});

test('the terminating variant admits the remote holds the key', () => {
  assert.equal(TLS_VARIANTS.terminating.remoteHoldsKey, true);
  assert.equal(TLS_VARIANTS.terminating.tlsTerminatedBy, 'remote');
  assert.equal(TLS_VARIANTS.terminating.passesT1, 'only-if-remote-is-ours');
});

test('the capability record cannot be edited into a different verdict', () => {
  assert.throws(() => { SSH_CAPABILITIES.websocketUpgrade = false; }, TypeError);
  assert.equal(SSH_CAPABILITIES.websocketUpgrade, true);
  assert.equal(SSH_CAPABILITIES.requiresNewSoftwareOnResident, false);
  assert.equal(SSH_CAPABILITIES.requiresPubliclyReachableRemote, true);
});

test('an unknown TLS variant is refused at construction', () => {
  assert.throws(
    () => createSshProvider(supervised({ tlsVariant: 'hopeful' })),
    (err) => err instanceof SshIngressError && err.code === 'unknown-tls-variant',
  );
});

// --- the GatewayPorts precondition -------------------------------------------

test('a non-loopback remote bind is refused without an explicit waiver', () => {
  assert.throws(
    () => createSshProvider(supervised({ remoteBindAddress: '0.0.0.0' })),
    (err) => err instanceof SshIngressError
      && err.code === 'gateway-ports-unacknowledged'
      // The refusal has to name the silent-downgrade failure mode, because that
      // is the only thing that stops somebody "fixing" it by passing the waiver.
      && /silently binds loopback|GatewayPorts/.test(err.message),
  );
});

test('the waiver permits a non-loopback bind and it reaches the forward spec', () => {
  const provider = createSshProvider(supervised({
    remoteBindAddress: '0.0.0.0', acknowledgeRemoteGatewayPorts: true,
  }));
  assert.equal(provider.name, 'ssh');
  const args = buildSshArgs({
    host: 'h', remoteBindAddress: '0.0.0.0', remotePort: 443, targetHost: '127.0.0.1', targetPort: 8792,
  });
  assert.equal(args[args.indexOf('-R') + 1], '0.0.0.0:443:127.0.0.1:8792');
});

test('the loopback forms need no waiver', () => {
  for (const address of ['127.0.0.1', '::1', 'localhost']) {
    assert.doesNotThrow(() => createSshProvider(supervised({ remoteBindAddress: address })));
  }
});

// --- classification -----------------------------------------------------------

test('a refused remote bind is classified apart from a dropped connection', () => {
  assert.equal(classifyExit({ code: 255, stderr: STDERR.forward }), EXIT_CLASSES.FORWARD);
  assert.equal(classifyExit({ code: 255, stderr: STDERR.forwardWarning }), EXIT_CLASSES.FORWARD);
  assert.equal(classifyExit({ code: 255, stderr: STDERR.bindBusy }), EXIT_CLASSES.FORWARD);

  assert.equal(classifyExit({ code: 255, stderr: STDERR.refused }), EXIT_CLASSES.CONNECTION);
  assert.equal(classifyExit({ code: 255, stderr: STDERR.keepalive }), EXIT_CLASSES.CONNECTION);
  assert.equal(classifyExit({ code: 255, stderr: STDERR.banner }), EXIT_CLASSES.CONNECTION);

  // Same exit status for both; only the text tells them apart.
  assert.notEqual(
    classifyExit({ code: 255, stderr: STDERR.forward }),
    classifyExit({ code: 255, stderr: STDERR.refused }),
  );
  assert.notEqual(backoffBandFor(EXIT_CLASSES.FORWARD), backoffBandFor(EXIT_CLASSES.CONNECTION));
});

test('an unacceptable host key outranks every other reading of the same output', () => {
  assert.equal(classifyExit({ code: 255, stderr: STDERR.hostKeyChanged }), EXIT_CLASSES.HOST_KEY);
  assert.equal(classifyExit({ code: 255, stderr: STDERR.hostKeyFailed }), EXIT_CLASSES.HOST_KEY);
  assert.equal(
    classifyExit({ code: 255, stderr: STDERR.hostKeyChanged + STDERR.forward }),
    EXIT_CLASSES.HOST_KEY,
  );
  assert.equal(isRetryable(EXIT_CLASSES.HOST_KEY), false);
});

test('a rejected key is classified as auth and is never retried', () => {
  assert.equal(classifyExit({ code: 255, stderr: STDERR.denied }), EXIT_CLASSES.AUTH);
  assert.equal(isRetryable(EXIT_CLASSES.AUTH), false);
  assert.equal(isRetryable(EXIT_CLASSES.CONFIG), false);
});

test('a clean exit is reported as clean and still retried', () => {
  assert.equal(classifyExit({ code: 0, signal: null, stderr: '' }), EXIT_CLASSES.CLEAN);
  assert.equal(isRetryable(EXIT_CLASSES.CLEAN), true);
  assert.equal(backoffBandFor(EXIT_CLASSES.CLEAN), 'connection');
});

test('an unreadable failure is retried as unknown, and a stop is not a failure', () => {
  assert.equal(classifyExit({ code: 7, stderr: 'something new' }), EXIT_CLASSES.UNKNOWN);
  assert.equal(isRetryable(EXIT_CLASSES.UNKNOWN), true);
  assert.equal(classifyExit({ code: null, signal: 'SIGTERM', stopping: true }), EXIT_CLASSES.STOPPED);
  assert.equal(isRetryable(EXIT_CLASSES.STOPPED), false);
});

// --- backoff arithmetic --------------------------------------------------------

test('a zero floor is refused: a zero floor is the hot loop', () => {
  assert.throws(
    () => createSshProvider(supervised({ backoff: { connection: { floorMs: 0 } } })),
    (err) => err instanceof SshIngressError && err.code === 'backoff-floor-required',
  );
  assert.throws(
    () => createSshProvider(supervised({ backoff: { forward: { floorMs: -1 } } })),
    (err) => err instanceof SshIngressError && err.code === 'backoff-floor-required',
  );
});

test('a ceiling below the floor is refused', () => {
  assert.throws(
    () => createSshProvider(supervised({ backoff: { connection: { floorMs: 1_000, ceilingMs: 100 } } })),
    (err) => err instanceof SshIngressError && err.code === 'backoff-ceiling-required',
  );
});

test('the delay starts at the floor, doubles, and stops at the ceiling', () => {
  const policy = { floorMs: 100, ceilingMs: 800, factor: 2, jitterRatio: 0 };
  const seen = [1, 2, 3, 4, 5, 6, 40].map((attempt) => nextDelayMs({ attempt, policy, random: () => 0 }));
  assert.deepEqual(seen, [100, 200, 400, 800, 800, 800, 800]);
});

test('jitter never escapes the band, at either end', () => {
  const policy = { floorMs: 100, ceilingMs: 800, factor: 2, jitterRatio: 0.5 };
  for (const random of [() => 0, () => 0.5, () => 0.999999]) {
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const delay = nextDelayMs({ attempt, policy, random });
      assert.ok(delay >= policy.floorMs, `delay ${delay} fell under the floor`);
      assert.ok(delay <= policy.ceilingMs, `delay ${delay} escaped the ceiling`);
    }
  }
});

test('the shipped defaults put a forward conflict in a slower band than a blip', () => {
  assert.ok(DEFAULT_BACKOFF.connection.floorMs > 0);
  assert.ok(DEFAULT_BACKOFF.forward.floorMs > DEFAULT_BACKOFF.connection.floorMs);
  assert.ok(DEFAULT_BACKOFF.forward.ceilingMs > DEFAULT_BACKOFF.connection.ceilingMs);
});

// --- supervision ----------------------------------------------------------------

test('a child that exits instantly never hot-loops: one bounded delay per restart', async () => {
  const ssh = fakeSsh(() => ({ stderr: STDERR.refused }));
  const clock = fakeClock();
  const provider = createSshProvider(supervised({
    spawn: ssh.spawn, sleep: clock.sleep, startAttempts: 40,
  }));

  await assert.rejects(
    () => provider.start({ target: TARGET, logger: recordingLogger() }),
    (err) => err instanceof SshIngressError && err.code === 'start-failed',
  );

  const backoffs = clock.of('backoff');
  // The structural claim: consecutive spawns are separated by exactly one delay.
  assert.equal(ssh.spawns.length, 40);
  assert.equal(backoffs.length, 39);
  // The floor, on every single restart including the first.
  assert.ok(backoffs.every((ms) => ms >= 100), `a delay fell under the floor: ${backoffs}`);
  // The ceiling, which it reaches and then holds.
  assert.ok(backoffs.every((ms) => ms <= 800), `a delay escaped the ceiling: ${backoffs}`);
  assert.deepEqual(backoffs.slice(0, 5), [100, 200, 400, 800, 800]);
  assert.equal(backoffs.at(-1), 800);
  // 40 restarts cost at least 40 floors of real time, which at the shipped
  // floor of one second is about 500x slower than the incident this guards.
  assert.ok(backoffs.reduce((a, b) => a + b, 0) >= backoffs.length * 100);
});

test('a forward failure is retried in a slower band than a connection failure', async () => {
  const run = async (stderr) => {
    const ssh = fakeSsh(() => ({ stderr }));
    const clock = fakeClock();
    const provider = createSshProvider(supervised({
      spawn: ssh.spawn, sleep: clock.sleep, startAttempts: 4, maxForwardConflicts: 99,
    }));
    await assert.rejects(() => provider.start({ target: TARGET, logger: recordingLogger() }));
    return clock.of('backoff');
  };

  const connection = await run(STDERR.refused);
  const forward = await run(STDERR.forward);

  assert.deepEqual(connection, [100, 200, 400]);
  assert.deepEqual(forward, [5_000, 10_000, 20_000]);
  // The claim under test: the same number of failures, a different cadence.
  assert.equal(connection.length, forward.length);
  assert.ok(forward[0] > connection[0] * 10);
});

test('a bounded number of forward conflicts gives up rather than retrying forever', async () => {
  const ssh = fakeSsh(() => ({ stderr: STDERR.forward }));
  const clock = fakeClock();
  const provider = createSshProvider(supervised({
    spawn: ssh.spawn, sleep: clock.sleep, maxForwardConflicts: 3, startAttempts: 50,
  }));

  await assert.rejects(
    () => provider.start({ target: TARGET, logger: recordingLogger() }),
    (err) => err instanceof SshIngressError
      && err.code === 'forward-conflict'
      && /no amount of retrying will free it/.test(err.message),
  );
  assert.equal(ssh.spawns.length, 3);
});

test('a host-key failure stops at the first attempt and is never retried', async () => {
  const ssh = fakeSsh(() => ({ stderr: STDERR.hostKeyChanged }));
  const clock = fakeClock();
  const provider = createSshProvider(supervised({ spawn: ssh.spawn, sleep: clock.sleep, startAttempts: 20 }));

  await assert.rejects(
    () => provider.start({ target: TARGET, logger: recordingLogger() }),
    (err) => err instanceof SshIngressError && err.code === `ssh-${EXIT_CLASSES.HOST_KEY}`,
  );
  assert.equal(ssh.spawns.length, 1);
  assert.equal(clock.of('backoff').length, 0);
});

test('a rejected key stops at the first attempt rather than burning MaxAuthTries', async () => {
  const ssh = fakeSsh(() => ({ stderr: STDERR.denied }));
  const clock = fakeClock();
  const provider = createSshProvider(supervised({ spawn: ssh.spawn, sleep: clock.sleep, startAttempts: 20 }));

  await assert.rejects(
    () => provider.start({ target: TARGET, logger: recordingLogger() }),
    (err) => err instanceof SshIngressError && err.code === `ssh-${EXIT_CLASSES.AUTH}`,
  );
  assert.equal(ssh.spawns.length, 1);
});

test('a missing ssh binary is terminal, not something to retry', async () => {
  const ssh = fakeSsh(() => ({ error: 'spawn ssh ENOENT' }));
  const clock = fakeClock();
  const provider = createSshProvider(supervised({ spawn: ssh.spawn, sleep: clock.sleep, startAttempts: 20 }));

  await assert.rejects(
    () => provider.start({ target: TARGET, logger: recordingLogger() }),
    (err) => err instanceof SshIngressError && err.code === `ssh-${EXIT_CLASSES.CONFIG}`,
  );
  assert.equal(ssh.spawns.length, 1);
});

test('the tunnel comes up and reports no public URL unless the operator supplies one', async () => {
  const ssh = fakeSsh(() => ({ alive: true }));
  const clock = fakeClock();
  const logger = recordingLogger();

  const bare = createSshProvider(supervised({ spawn: ssh.spawn, sleep: clock.sleep }));
  const handle = await bare.start({ target: TARGET, logger });
  assert.equal(handle.kind, 'ssh');
  // The bound port is on the remote's loopback. Synthesising a URL for it would
  // be false by construction, so there is no URL.
  assert.equal(handle.publicUrl, null);
  assert.equal(handle.remoteBindAddress, '127.0.0.1');
  assert.equal(handle.remotePort, 18443);
  assert.equal(handle.restarts, 0);
  assert.equal(handle.tls.remoteHoldsKey, false);
  assert.equal(logger.count('provider.ssh.up'), 1);
  await handle.stop();

  const told = createSshProvider(supervised({
    spawn: fakeSsh(() => ({ alive: true })).spawn,
    sleep: fakeClock().sleep,
    publicUrl: 'https://relay.example.com',
  }));
  const second = await told.start({ target: TARGET, logger: recordingLogger() });
  assert.equal(second.publicUrl, 'https://relay.example.com');
  await second.stop();
});

test('a nonsense publicUrl is refused before anything is spawned', () => {
  const ssh = fakeSsh(() => ({ alive: true }));
  assert.throws(() => createSshProvider(supervised({ spawn: ssh.spawn, publicUrl: 'not a url' })));
  assert.equal(ssh.spawns.length, 0);
});

test('the backoff resets after a healthy run instead of ratcheting forever', async () => {
  // Child 2 dies instantly; 1 and 3 stay up. So: healthy, blip, blip, healthy,
  // blip -- and the delay after the second healthy run must be the floor again.
  const ssh = fakeSsh((n) => (n === 2 ? { stderr: STDERR.refused } : { alive: true }));
  const clock = fakeClock();
  const logger = recordingLogger();
  const provider = createSshProvider(supervised({ spawn: ssh.spawn, sleep: clock.sleep }));

  const handle = await provider.start({ target: TARGET, logger });
  assert.equal(handle.restarts, 0);

  ssh.spawns[0].child.die({ code: 255, stderr: STDERR.refused });
  await waitFor(() => logger.count('provider.ssh.up') === 2, 'the third child to come up');
  assert.deepEqual(clock.of('backoff'), [100, 200]);

  ssh.spawns[2].child.die({ code: 255, stderr: STDERR.refused });
  await waitFor(() => ssh.spawns.length === 4, 'a fourth spawn');
  assert.deepEqual(clock.of('backoff'), [100, 200, 100]);
  assert.ok(handle.restarts >= 3);

  await handle.stop();
});

test('supervision after the first success is reported rather than hidden', async () => {
  const ssh = fakeSsh((n) => (n === 1 ? { alive: true } : { alive: true }));
  const clock = fakeClock();
  const logger = recordingLogger();
  const provider = createSshProvider(supervised({ spawn: ssh.spawn, sleep: clock.sleep }));

  const handle = await provider.start({ target: TARGET, logger });
  ssh.spawns[0].child.die({ code: 255, stderr: STDERR.keepalive });
  await waitFor(() => ssh.spawns.length === 2, 'a restart');

  // The shared interface has no degraded state, so the log and the handle are
  // the only places an operator can learn this happened. Both must say so.
  assert.ok(logger.events.some((e) => e.event === 'provider.ssh.exited' && e.data.classified === EXIT_CLASSES.CONNECTION));
  assert.ok(logger.events.some((e) => e.event === 'provider.ssh.backoff' && e.data.band === 'connection'));
  assert.equal(handle.lastExitClass, EXIT_CLASSES.CONNECTION);
  assert.ok(handle.restarts >= 1);
  await handle.stop();
});

// --- teardown --------------------------------------------------------------------

test('stop terminates the child, needs no grace period, and is idempotent', async () => {
  const ssh = fakeSsh(() => ({ alive: true }));
  const clock = fakeClock();
  const logger = recordingLogger();
  const provider = createSshProvider(supervised({ spawn: ssh.spawn, sleep: clock.sleep }));

  const handle = await provider.start({ target: TARGET, logger });
  await handle.stop();

  assert.deepEqual(ssh.spawns[0].signals, ['SIGTERM']);
  // A child that honours SIGTERM must not hold shutdown open for the grace period.
  assert.equal(clock.of('stop-grace').length, 0);
  assert.equal(logger.count('provider.ssh.stopped'), 1);

  await handle.stop();
  await handle.stop();
  assert.deepEqual(ssh.spawns[0].signals, ['SIGTERM']);
  assert.equal(ssh.spawns.length, 1);
});

test('stop escalates to SIGKILL in a counted number of steps, not a spin', async () => {
  const ssh = fakeSsh(() => ({ alive: true, ignoreSigterm: true }));
  const clock = fakeClock();
  const provider = createSshProvider(supervised({
    spawn: ssh.spawn, sleep: clock.sleep, stopGraceMs: 200, stopStepMs: 50,
  }));

  const handle = await provider.start({ target: TARGET, logger: recordingLogger() });
  await handle.stop();

  assert.deepEqual(ssh.spawns[0].signals, ['SIGTERM', 'SIGKILL']);
  // Exactly ceil(200/50). Under an instant fake clock a deadline-bounded loop
  // would have spun here instead of counting.
  assert.deepEqual(clock.of('stop-grace'), [50, 50, 50, 50]);
});

test('stop cuts a pending backoff short instead of waiting it out', async () => {
  // The backoff sleep never resolves. Only an interruptible wait can finish.
  const ssh = fakeSsh((n) => (n === 1 ? { alive: true } : { alive: true }));
  const clock = fakeClock({ hold: ['backoff'] });
  const logger = recordingLogger();
  const provider = createSshProvider(supervised({ spawn: ssh.spawn, sleep: clock.sleep }));

  const handle = await provider.start({ target: TARGET, logger });
  ssh.spawns[0].child.die({ code: 255, stderr: STDERR.refused });
  await waitFor(() => clock.of('backoff').length === 1, 'a pending backoff');

  await handle.stop();

  // It never got to spawn a replacement, and stop did not wait out the delay.
  assert.equal(ssh.spawns.length, 1);
  assert.equal(logger.count('provider.ssh.stopped'), 1);
});

test('stop during the readiness window leaves nothing running', async () => {
  const ssh = fakeSsh(() => ({ alive: true }));
  const clock = fakeClock();
  const provider = createSshProvider(supervised({
    spawn: ssh.spawn, sleep: clock.sleep, readySettleMs: 1_000, readyPollMs: 10,
  }));

  const logger = recordingLogger();
  const starting = provider.start({ target: TARGET, logger });
  const handle = await starting;
  await handle.stop();
  assert.deepEqual(ssh.spawns[0].signals, ['SIGTERM']);
  assert.equal(ssh.spawns.length, 1);
});
