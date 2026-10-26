// This provider cannot be run against a real daemon from here, so the suite is
// entirely seams and refusals. That is a weakness and it is the honest one: the
// tests prove the argv, the parsing and every refusal, and they prove nothing
// whatsoever about whether Funnel works. VERIFIED_ON_RESIDENT exists so that
// distinction is in the code rather than in somebody's memory of this comment.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  FUNNEL_MODES,
  FUNNEL_MODE_NAMES,
  PROVIDER_NAME,
  PROVIDER_SHAPE,
  TAILSCALE_CAPABILITIES,
  VERIFIED_ON_RESIDENT,
  assertFunnelMode,
  assertFunnelPort,
  assertNoSecretsInArgv,
  buildFunnelArgs,
  createTailscaleProvider,
  parseNodeName,
} from '../../../src/relay/providers/tailscale.mjs';
import { LISTENER_CONFIGURING } from '../../../src/relay/provider-shapes.mjs';

const logger = { info() {}, warn() {}, error() {}, debug() {} };

/** `assert.throws` returns undefined, so it cannot inspect what it validated. */
function caught(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return assert.fail('expected a throw, got none');
}

const STATUS = JSON.stringify({ Self: { DNSName: 'mac.tailnet-abcd.ts.net.' } });

/** A child that behaves enough like one to be killed and to emit exit. */
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.signals = [];
  child.kill = (sig) => child.signals.push(sig);
  return child;
}

const target = { host: '127.0.0.1', port: 8443 };

// --- the unverified claim ---------------------------------------------------

test('this provider says out loud that it has not been run', () => {
  assert.equal(VERIFIED_ON_RESIDENT, false, 'flip this only after running the route end to end');
});

test('starting it warns that it is unverified, every time', async () => {
  const warnings = [];
  const provider = createTailscaleProvider({ spawn: () => fakeChild(), runStatus: async () => STATUS });
  const handle = await provider.start({
    target,
    logger: { ...logger, warn: (event, fields) => warnings.push([event, fields]) },
  });
  const warned = warnings.find(([event]) => event === 'provider.tailscale.unverified');
  assert.ok(warned, 'an unverified provider that starts quietly is the thing to avoid');
  assert.equal(warned[1].verifiedOnResident, false);
  assert.equal(handle.verifiedOnResident, false, 'the handle carries it too, for anything that reports status');
  await handle.stop();
});

// --- shape ------------------------------------------------------------------

test('the shape is listener-configuring: tailscaled owns the listener', () => {
  const provider = createTailscaleProvider();
  assert.equal(provider.name, PROVIDER_NAME);
  assert.equal(provider.name, 'tailscale');
  assert.equal(provider.shape, PROVIDER_SHAPE);
  assert.equal(provider.shape, LISTENER_CONFIGURING);
});

test('a target without host and port is refused by the shared contract', async () => {
  const provider = createTailscaleProvider({ spawn: () => fakeChild(), runStatus: async () => STATUS });
  await assert.rejects(provider.start({ target: {}, logger }), /needs target.host and target.port/);
});

// --- ports and modes --------------------------------------------------------

test('funnel publishes exactly three ports and nothing else', () => {
  assert.deepEqual(TAILSCALE_CAPABILITIES.publicPorts, [443, 8443, 10000]);
  for (const port of [443, 8443, 10000]) assert.equal(assertFunnelPort(port), port);

  const err = caught(() => assertFunnelPort(8080));
  assert.equal(err.code, 'unsupported-funnel-port');
  assert.match(err.message, /443, 8443, 10000/, 'the message should name the alternatives');

  assert.throws(() => assertFunnelPort('443'), TypeError);
  assert.throws(() => assertFunnelPort(undefined), TypeError);
});

test('every mode passes T1, and each one records why separately', () => {
  assert.deepEqual(FUNNEL_MODE_NAMES, ['https', 'tcp', 'raw']);
  for (const name of FUNNEL_MODE_NAMES) {
    const mode = FUNNEL_MODES[name];
    assert.equal(mode.passesT1, true, `${name} should pass T1`);
    assert.ok(['tailscaled', 'surface'].includes(mode.tlsTerminatedBy));
    // The residual is not optional metadata: it is the part a reader skims past.
    assert.match(mode.tlsResidual, /\S/, `${name} must state its residual trust`);
  }
  assert.equal(FUNNEL_MODES.https.tlsTerminatedBy, 'tailscaled');
  // --tls-terminated-tcp says in its own name who terminates. It is the mode
  // most likely to be mislabelled 'surface' by someone pattern-matching on
  // "tcp", so it gets its own assertion.
  assert.equal(FUNNEL_MODES.tcp.tlsTerminatedBy, 'tailscaled');
  assert.equal(FUNNEL_MODES.raw.tlsTerminatedBy, 'surface');
  assert.equal(FUNNEL_MODES.raw.needsOwnCertificate, true, 'raw mode makes renewal ours');
  assert.equal(FUNNEL_MODES.https.needsOwnCertificate, false);
  assert.equal(FUNNEL_MODES.tcp.needsOwnCertificate, false);

  // Whoever terminates must be the one needing a cert. Checked as a relation so
  // the three rows cannot drift into contradicting each other.
  for (const name of FUNNEL_MODE_NAMES) {
    const mode = FUNNEL_MODES[name];
    assert.equal(
      mode.needsOwnCertificate,
      mode.tlsTerminatedBy === 'surface',
      `${name}: needsOwnCertificate must follow from who terminates`,
    );
  }
});

test('the ts.net zone is not ours, and the modes say so where CAA would go', () => {
  assert.match(FUNNEL_MODES.https.tlsResidual, /CAA|pinn/i);
});

test('an unknown mode is refused by name', () => {
  assert.throws(() => assertFunnelMode('passthrough'), /https, tcp, raw/);
  assert.throws(() => assertFunnelMode(undefined), TypeError);
});

// --- argv -------------------------------------------------------------------

test('the argv names both ports explicitly, and the target is a url', () => {
  // `tailscale funnel 8443` is legal and means the opposite of what it looks
  // like -- default public port, 8443 as the local target. Hence both halves
  // spelled out.
  assert.deepEqual(buildFunnelArgs({ funnelPort: 443, funnelMode: 'https', localPort: 8443 }), [
    'funnel',
    '--https=443',
    'http://127.0.0.1:8443',
  ]);
  assert.deepEqual(buildFunnelArgs({ funnelPort: 8443, funnelMode: 'raw', localPort: 9000 }), [
    'funnel',
    '--tcp=8443',
    'tcp://127.0.0.1:9000',
  ]);
  assert.deepEqual(buildFunnelArgs({ funnelPort: 443, funnelMode: 'tcp', localPort: 8443 }), [
    'funnel',
    '--tls-terminated-tcp=443',
    'tcp://127.0.0.1:8443',
  ]);
});

test('a backgrounded funnel is refused, because it outlives us', () => {
  const err = caught(() => buildFunnelArgs({ funnelPort: 443, funnelMode: 'https', localPort: 8443, background: true }));
  assert.equal(err.code, 'background-funnel-refused');
  assert.match(err.message, /outlives this process/);
  assert.match(err.message, /public internet/);

  // And at construction, so it cannot be smuggled in later.
  const early = caught(() => createTailscaleProvider({ background: true }));
  assert.equal(early.code, 'background-funnel-refused');
});

test('a nonsense local port is refused before anything is spawned', () => {
  for (const localPort of [0, -1, 70000, '8443', undefined, 1.5]) {
    assert.throws(() => buildFunnelArgs({ funnelPort: 443, funnelMode: 'https', localPort }), TypeError);
  }
});

test('nothing credential-shaped belongs in argv, since tailscale takes none', () => {
  assert.deepEqual(assertNoSecretsInArgv(['funnel', '--https=443', '8443']), ['funnel', '--https=443', '8443']);
  const err = caught(() => assertNoSecretsInArgv(['funnel', 'tskey-auth-kXxXxXxXxXxXxXxXxXxXxXxX']));
  assert.equal(err.code, 'secret-in-argv');
  // Long runs of digits are ports and timeouts, not secrets.
  assert.deepEqual(assertNoSecretsInArgv(['123456789012345678901234567890']).length, 1);
});

// --- status parsing ---------------------------------------------------------

test('the node name is the point of this route, so parsing it is strict', () => {
  assert.equal(parseNodeName(STATUS), 'mac.tailnet-abcd.ts.net');
  assert.equal(
    parseNodeName({ Self: { DNSName: 'mac.tailnet-abcd.ts.net.' } }),
    'mac.tailnet-abcd.ts.net',
    'the trailing dot is correct DNS and an invalid RP ID',
  );
});

test('a node that is not logged in is reported as such, not as a blank name', () => {
  for (const raw of [{}, { Self: {} }, { Self: { DNSName: '' } }]) {
    const err = caught(() => parseNodeName(raw));
    assert.equal(err.code, 'node-name-missing');
    assert.match(err.message, /logged in|qualified/);
  }
  const short = caught(() => parseNodeName({ Self: { DNSName: 'mac' } }));
  assert.equal(short.code, 'node-name-missing');
});

test('unparseable status is its own failure, distinguishable from a missing name', () => {
  const err = caught(() => parseNodeName('not json at all'));
  assert.equal(err.code, 'status-unparseable');
});

// --- start / stop -----------------------------------------------------------

test('start publishes the ts.net url and the rp id derived from it', async () => {
  const spawns = [];
  const provider = createTailscaleProvider({
    spawn: (bin, args) => {
      spawns.push([bin, args]);
      return fakeChild();
    },
    runStatus: async () => STATUS,
  });

  const handle = await provider.start({ target, logger });
  assert.equal(handle.kind, 'tailscale');
  assert.equal(handle.publicUrl, 'https://mac.tailnet-abcd.ts.net/');
  assert.equal(handle.webauthnRpId, 'mac.tailnet-abcd.ts.net', 'no scheme, no port, no trailing dot');
  assert.equal(handle.tlsTerminatedBy, 'tailscaled');
  assert.deepEqual(spawns, [['tailscale', ['funnel', '--https=443', 'http://127.0.0.1:8443']]]);
  await handle.stop();
});

test('a non-default funnel port appears in the url but never in the rp id', async () => {
  const provider = createTailscaleProvider({
    funnelPort: 8443,
    spawn: () => fakeChild(),
    runStatus: async () => STATUS,
  });
  const handle = await provider.start({ target, logger });
  assert.equal(handle.publicUrl, 'https://mac.tailnet-abcd.ts.net:8443/');
  assert.equal(handle.webauthnRpId, 'mac.tailnet-abcd.ts.net', 'an RP ID is a domain, never host:port');
  await handle.stop();
});

test('the privacy disposition is logged, not just returned', async () => {
  const events = [];
  const provider = createTailscaleProvider({ spawn: () => fakeChild(), runStatus: async () => STATUS });
  const handle = await provider.start({
    target,
    logger: { ...logger, info: (event, fields) => events.push([event, fields]) },
  });
  const started = events.find(([event]) => event === 'provider.tailscale.started');
  assert.ok(started);
  assert.equal(started[1].tlsTerminatedBy, 'tailscaled');
  assert.equal(started[1].relayDecrypts, false);
  await handle.stop();
});

test('stop signals the child and is idempotent', async () => {
  const child = fakeChild();
  const provider = createTailscaleProvider({ spawn: () => child, runStatus: async () => STATUS });
  const handle = await provider.start({ target, logger });
  await handle.stop();
  await handle.stop();
  assert.deepEqual(child.signals, ['SIGTERM'], 'a second stop must not signal twice');
});

test('a child that exits on its own is reported, not retried', async () => {
  const child = fakeChild();
  const errors = [];
  const provider = createTailscaleProvider({ spawn: () => child, runStatus: async () => STATUS });
  const handle = await provider.start({
    target,
    logger: { ...logger, error: (event, fields) => errors.push([event, fields]) },
  });

  child.stderr.emit('data', 'funnel is not enabled for this tailnet\n');
  child.emit('exit', 1, null);

  const failed = errors.find(([event]) => event === 'provider.tailscale.exited');
  assert.ok(failed, 'a funnel that dies must say so');
  assert.match(failed[1].stderr, /not enabled/, 'the tailnet policy refusal is the usual cause');
  await handle.stop();
  assert.deepEqual(child.signals, [], 'an already-exited child is not signalled');
});

test('a missing client is reported as a missing client', async () => {
  const provider = createTailscaleProvider({
    spawn: () => {
      throw Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' });
    },
  });
  await assert.rejects(provider.start({ target, logger }), (err) => {
    assert.equal(err.code, 'client-missing');
    assert.match(err.message, /not installed/);
    return true;
  });
});

// --- capabilities -----------------------------------------------------------

test('the capability claims are checkable, including the awkward ones', () => {
  // The reason this route is worth writing at all.
  assert.equal(TAILSCALE_CAPABILITIES.suppliesHostname, true);
  assert.equal(TAILSCALE_CAPABILITIES.suppliesWebauthnRpId, true);
  // The reason it is not the recommendation.
  assert.equal(TAILSCALE_CAPABILITIES.requiresNewSoftwareOnResident, true);
  // And what no amount of local configuration can supply.
  assert.deepEqual(TAILSCALE_CAPABILITIES.requiresTailnetPolicy, [
    'funnel node attribute',
    'HTTPS certificates enabled',
  ]);
  assert.equal(TAILSCALE_CAPABILITIES.requiresSecondHost, false);
});
