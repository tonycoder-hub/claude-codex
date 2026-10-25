// Ingress provider: an ssh reverse tunnel (`ssh -R`) into a remote that
// republishes the bound port.
//
// The verdict first, so nobody has to read the file to learn the answer:
// **this provider works, and it is the only candidate whose transport is
// already installed and already in production use on the resident Mac.** It is
// also the only one with a *server-side* precondition, and that precondition is
// the thing to check before believing any of the rest. See
// `docs/08-ssh-ingress.md`.
//
// The shape of the route, left to right:
//
//     phone -> remote:443 (a republisher: nginx stream + ssl_preread)
//           -> remote 127.0.0.1:<remotePort>   (bound by sshd for our -R)
//           -> the ssh connection, outbound-dialled by the Mac
//           -> Mac 127.0.0.1:<target.port>     (the surface's own listener)
//
// Two properties fall straight out of that picture and they are the whole
// value of this route:
//
//   1. **We never see a byte.** sshd moves the stream and the Mac's ssh client
//      hands it to the surface's *own* listener. There is no socket for this
//      module to produce, nothing to `server.emit('connection', socket)`. So of
//      the two shapes in `../provider.mjs` this is unambiguously
//      **listener-configuring**, and `validateTarget` demands exactly what
//      `-R` needs -- `target.host` and `target.port`, the far end of the
//      forward. The fit is not a coincidence; provider.mjs names "a VPS doing
//      SNI passthrough" as this shape, and the republisher here is that VPS.
//   2. **The key stays on the Mac.** If the republisher does raw TCP / SNI
//      passthrough it never holds a certificate; TLS terminates on the Mac,
//      inside the surface. That is `04-ingress.md`'s Fallback B without the
//      VPS and without WireGuard, because the ssh connection already supplies
//      the outbound-dialled hop that WireGuard was there to supply.
//      A republisher that *terminates* TLS instead is the weak variant and
//      moves the key off the Mac -- see TLS_VARIANTS below.
//
// ---------------------------------------------------------------------------
// The server-side precondition, stated once and loudly.
//
// `sshd` binds remote forwards to the loopback address unless `GatewayPorts` is
// `yes` or `clientspecified`; sshd_config(5) says so and the default is `no`.
// The failure mode is the nasty kind: with `GatewayPorts no` a client that asks
// for a non-loopback bind **does not get an error**. sshd honours the forward
// request and quietly binds loopback anyway, so `ExitOnForwardFailure` -- which
// catches every other forward problem -- does not catch this one. A tunnel that
// looks healthy in every log is simply not reachable.
//
// That is why `remoteBindAddress` defaults to `127.0.0.1` and why anything else
// has to be signed for with `acknowledgeRemoteGatewayPorts`. It is not a style
// check; it is the one mistake this route makes silently.
// ---------------------------------------------------------------------------
// What the shared interface cannot express, and what this module does instead.
//
// `../provider.mjs` says plainly that it has no "attached, lost it, retrying"
// state, and that inventing a retry loop would hide the one fact an operator
// needs. This provider nevertheless *must* supervise: a reverse tunnel whose
// child died is an ingress that is simply gone, and nothing else in the process
// is watching. The compensating control is that supervision here is never
// silent -- every spawn, every classified exit and every backoff delay goes to
// the logger, and the live counters hang off the returned handle
// (`restarts`, `lastExitClass`, `forwardConflicts`). When the interface grows a
// degradation channel, those are what should feed it.
// ---------------------------------------------------------------------------

import { spawn as nodeSpawn } from 'node:child_process';
import { LISTENER_CONFIGURING } from '../provider-shapes.mjs';
import { validateTarget } from '../provider.mjs';

/** Must match the listener-configuring constant in `src/relay/provider.mjs`. */
export const PROVIDER_SHAPE = LISTENER_CONFIGURING;

/**
 * Who holds the browser-facing private key, per republisher. This is the T1
 * judgement in executable form; `docs/08-ssh-ingress.md` is the long version.
 */
export const TLS_VARIANTS = Object.freeze({
  /** nginx `stream` + `ssl_preread`, or any L4 passthrough. Reads SNI, forwards bytes. */
  passthrough: Object.freeze({ tlsTerminatedBy: 'resident', remoteHoldsKey: false, passesT1: true }),
  /** The remote terminates TLS and re-dials plaintext into the forward. */
  terminating: Object.freeze({ tlsTerminatedBy: 'remote', remoteHoldsKey: true, passesT1: 'only-if-remote-is-ours' }),
});

/**
 * What this route can and cannot do. Exported so the capability claims are a
 * test rather than a paragraph.
 */
export const SSH_CAPABILITIES = Object.freeze({
  /** Any local TCP port can be published; the tunnel is byte-transparent. */
  arbitraryTcpPort: true,
  /** A WebSocket upgrade is just bytes in a TCP stream, so yes. */
  websocketUpgrade: true,
  /** Nothing new to install: ssh is already there and already in production use. */
  requiresNewSoftwareOnResident: false,
  /** The resident dials out; it needs no inbound reachability of its own. */
  requiresInboundReachabilityOnResident: false,
  /** ...but the *remote* must be reachable by the phone, which is a separate question. */
  requiresPubliclyReachableRemote: true,
  /** sshd must permit a non-loopback bind, or a republisher must sit on the remote. */
  requiresRemoteGatewayPortsOrRepublisher: true,
  /** With a passthrough republisher the remote holds no key at all. */
  tlsTerminatedBy: 'resident-or-remote, see TLS_VARIANTS',
  /** Authentication is by key or agent. Nothing else is accepted. */
  credentialShape: 'public-key or agent socket; never a value in argv or env',
});

/** Refusals that are a property of the route, not of a caller's typo. */
export class SshIngressError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SshIngressError';
    this.code = code;
  }
}

// --- classifying an exit ----------------------------------------------------

/**
 * Why the child went away. The distinction that earns its keep is
 * `forward` vs `connection`: `ExitOnForwardFailure=yes` turns "that remote port
 * is already bound" into an exit with status 255, and a dropped network turns
 * into an exit with status 255 too. The exit code cannot tell them apart. Only
 * the diagnostic text can, so the diagnostic text is what we read.
 */
export const EXIT_CLASSES = Object.freeze({
  /** The remote refused to bind the listen port. Somebody else owns it. */
  FORWARD: 'forward',
  /** Transport trouble: refused, timed out, reset, keepalive expired. */
  CONNECTION: 'connection',
  /** The session ended with status 0 -- usually sshd going away politely. */
  CLEAN: 'clean',
  /** The key was not accepted. Retrying burns the remote's MaxAuthTries. */
  AUTH: 'auth',
  /** The host key did not match. This is a security event, not a blip. */
  HOST_KEY: 'host-key',
  /** Bad option, missing binary, unresolvable configuration. */
  CONFIG: 'config',
  /** We asked it to stop and it did. */
  STOPPED: 'stopped',
  /** None of the above. Treated as transient, logged as unknown. */
  UNKNOWN: 'unknown',
});

// Every pattern below was taken from the format strings in the ssh(1) binary on
// the build host (OpenSSH 9.2p1), not from memory. The one that matters most is
// the first forward pattern: under `ExitOnForwardFailure=yes` ssh calls
// `fatal()` with "Error: remote port forwarding failed for listen port %d",
// and `fatal` is still printed at `LogLevel=ERROR`, which is why quietening the
// child does not blind the classifier.
const PATTERNS = [
  [EXIT_CLASSES.HOST_KEY, /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i],
  [EXIT_CLASSES.FORWARD, /remote port forwarding failed for listen (?:port|path)|Address already in use|bind: /i],
  [EXIT_CLASSES.AUTH, /Permission denied \(|Too many authentication failures|No supported authentication methods/i],
  [
    EXIT_CLASSES.CONNECTION,
    /ssh: connect to host |Connection refused|Connection timed out|Connection reset|closed by remote host|No route to host|Network is unreachable|kex_exchange_identification|banner exchange|not responding|Could not resolve hostname|Broken pipe/i,
  ],
  [EXIT_CLASSES.CONFIG, /Bad configuration option|command-line: line|ENOENT|unknown option|Bad port|Cannot fork/i],
];

/**
 * @param {{code?: number|null, signal?: string|null, stderr?: string, stopping?: boolean}} exit
 * @returns {string} one of EXIT_CLASSES
 */
export function classifyExit({ code = null, signal = null, stderr = '', stopping = false } = {}) {
  if (stopping) return EXIT_CLASSES.STOPPED;
  const text = String(stderr ?? '');
  for (const [cls, pattern] of PATTERNS) {
    if (pattern.test(text)) return cls;
  }
  // No diagnostic to go on. A clean status 0 from `ssh -N` means the far end
  // closed the session; the tunnel is still gone, so it is retried -- but it is
  // reported as `clean` because an operator reading the log needs to know the
  // difference between "sshd restarted" and "something broke".
  if (signal === null && code === 0) return EXIT_CLASSES.CLEAN;
  return EXIT_CLASSES.UNKNOWN;
}

/** Classes we will try again after. The rest are terminal, on purpose. */
const RETRYABLE = new Set([
  EXIT_CLASSES.FORWARD,
  EXIT_CLASSES.CONNECTION,
  EXIT_CLASSES.CLEAN,
  EXIT_CLASSES.UNKNOWN,
]);

/**
 * `auth`, `host-key` and `config` are deliberately terminal.
 *
 * Not caution -- arithmetic. The build host's sshd runs `MaxAuthTries 4`, so a
 * key that is not accepted will never become accepted by being offered again,
 * and a restart loop against it is an attack on our own account. A changed host
 * key is the one failure where retrying is actively wrong: it is exactly the
 * signature of the thing `StrictHostKeyChecking=yes` is there to stop, and the
 * T1 claim ("TLS terminates on the resident") is void the moment we reconnect
 * to a host we cannot identify.
 */
export function isRetryable(cls) {
  return RETRYABLE.has(cls);
}

/** Which backoff band a class is retried in. */
export function backoffBandFor(cls) {
  return cls === EXIT_CLASSES.FORWARD ? 'forward' : 'connection';
}

// --- backoff ----------------------------------------------------------------

/**
 * Two bands, because the two failures mean different things.
 *
 * `connection` is a blip: come back soon, give up ground slowly, keep trying
 * forever at one attempt a minute, which is what a tunnel is supposed to do.
 *
 * `forward` is "that port on the remote belongs to somebody else". No amount of
 * eagerness frees it, and each attempt is a full key exchange plus an
 * authentication against the remote. So it starts fifteen times further out,
 * ends five times further out, and -- unlike `connection` -- it is *bounded*:
 * after `maxForwardConflicts` the provider stops and says so, because a human
 * has to pick a different port.
 *
 * The floor is the load-bearing number. There is a standing hazard in this
 * project: a child that exits instantly once produced about 35,000 processes at
 * roughly 500 a minute, i.e. one every 120 ms. A positive floor applied to
 * *every* restart -- including the first, including restarts that follow a long
 * healthy run -- is what makes that arithmetic impossible. A ceiling alone
 * would not have helped, because a ceiling is only reached after the damage.
 */
export const DEFAULT_BACKOFF = Object.freeze({
  connection: Object.freeze({ floorMs: 1_000, ceilingMs: 60_000, factor: 2, jitterRatio: 0.2 }),
  forward: Object.freeze({ floorMs: 15_000, ceilingMs: 300_000, factor: 2, jitterRatio: 0.2 }),
});

/**
 * Exponential with jitter, strictly inside `[floorMs, ceilingMs]`.
 *
 * The jitter is applied *upward* from the exponential base and then clamped, so
 * it can never dip under the floor -- which is the only way to keep the floor a
 * guarantee rather than an average. At the ceiling the band collapses and the
 * delay is exactly the ceiling; that is fine here, since there is one tunnel
 * and therefore no herd to disperse.
 *
 * @param {{attempt: number, policy: object, random?: () => number}} args
 */
export function nextDelayMs({ attempt, policy, random = Math.random }) {
  const n = Math.max(1, Math.trunc(attempt));
  const raw = policy.floorMs * policy.factor ** (n - 1);
  const base = Math.min(policy.ceilingMs, Number.isFinite(raw) ? raw : policy.ceilingMs);
  const hi = Math.min(policy.ceilingMs, base * (1 + policy.jitterRatio));
  const delay = base + random() * (hi - base);
  // Round, then re-clamp: rounding a value sitting on the ceiling must not
  // step over it, and rounding near the floor must not step under it.
  return Math.min(policy.ceilingMs, Math.max(policy.floorMs, Math.round(delay)));
}

function assertPolicy(name, policy) {
  if (!policy || typeof policy !== 'object') throw new TypeError(`backoff.${name} must be an object`);
  if (!(policy.floorMs > 0)) {
    throw new SshIngressError('backoff-floor-required', `backoff.${name}.floorMs must be greater than zero: a zero floor is the hot loop`);
  }
  if (!(policy.ceilingMs >= policy.floorMs)) {
    throw new SshIngressError('backoff-ceiling-required', `backoff.${name}.ceilingMs must be at least floorMs`);
  }
  if (!(policy.factor >= 1)) throw new TypeError(`backoff.${name}.factor must be at least 1`);
  if (!(policy.jitterRatio >= 0)) throw new TypeError(`backoff.${name}.jitterRatio must not be negative`);
  return policy;
}

// --- argv and env, with nothing secret in either -----------------------------

/**
 * Options a caller may not override, each for a reason that outlives the caller.
 *
 * The first five are the security posture: a prompt-free, key-only, verified
 * connection that dies rather than pretend a forward exists. The forwarding
 * entries stop a caller smuggling in a second tunnel that `ExitOnForwardFailure`
 * would then take down ours for. The command entries are remote and local code
 * execution. `SetEnv`/`SendEnv` are how a credential in our environment would
 * get to the far end.
 */
export const RESERVED_SSH_OPTIONS = Object.freeze([
  'batchmode', 'stricthostkeychecking', 'exitonforwardfailure',
  'passwordauthentication', 'kbdinteractiveauthentication', 'numberofpasswordprompts',
  'preferredauthentications', 'pubkeyauthentication',
  'remoteforward', 'localforward', 'dynamicforward', 'clearallforwardings',
  'proxycommand', 'proxyusefdpass', 'localcommand', 'permitlocalcommand',
  'forkafterauthentication', 'controlmaster', 'controlpath', 'controlpersist',
  'setenv', 'sendenv', 'forwardagent',
]);

/**
 * Anything that looks like a credential, refused before it can reach argv.
 *
 * `ssh` has no option that legitimately carries a secret *value* -- a key is
 * named by path or reached through an agent socket, which are both references
 * -- so a match here is always a leak in progress and never a false economy.
 */
const SECRET_SHAPED = /pass(?:word|phrase)|secret|token|api[-_]?key|bearer|credential|BEGIN [A-Z ]*PRIVATE KEY/i;

/**
 * Prove no argument carries a value that must not be on a process table.
 *
 * argv is world-readable to every process on the host -- that is the whole
 * reason this exists -- so the error names the position and never echoes the
 * value.
 *
 * @param {string[]} argv
 */
export function assertNoSecretsInArgv(argv) {
  argv.forEach((arg, index) => {
    if (typeof arg !== 'string') throw new TypeError(`ssh argument ${index} is not a string`);
    // An `-o` assignment arrives as one `Key=value` token, and only the value
    // side can carry a secret. Screening the whole token would be stricter in
    // appearance and useless in fact: ssh's own `PasswordAuthentication` and
    // `NumberOfPasswordPrompts` are credential-shaped *names*, so a whole-token
    // screen refuses exactly the two options that make this invocation
    // prompt-free. Splitting on the first `=` keeps the check on the only part
    // a caller controls -- and a value that is itself an assignment, such as
    // `Foo=TOKEN=abc`, still lands in the screened half.
    const assignment = /^([A-Za-z][A-Za-z0-9_]*)=([\s\S]*)$/.exec(arg);
    const subject = assignment === null ? arg : assignment[2];
    if (SECRET_SHAPED.test(subject)) {
      throw new SshIngressError(
        'secret-in-argv',
        `ssh argument ${index} looks like a credential; ssh authenticates by key or agent, `
          + 'so pass an identity file path or an agent socket instead. The value is not echoed.',
      );
    }
  });
  return argv;
}

/**
 * The child's environment, as an allowlist rather than an inheritance.
 *
 * Three names get through. `SSH_AUTH_SOCK` is the interesting one and it is
 * safe for the same reason an `env:NAME` credential reference is safe: it is
 * a *reference*, not a value.
 * The agent holds the key and performs the signature; the socket path is not
 * the key and cannot be turned into it.
 *
 * Two omissions are deliberate and are the actual mechanism, not hygiene:
 * `SSH_ASKPASS` and `DISPLAY` are the only way ssh(1) can obtain a passphrase
 * without a terminal, and they are absent so that it cannot. `BatchMode=yes`
 * says the same thing a second time, from the other side.
 */
export const ENV_ALLOWLIST = Object.freeze(['PATH', 'HOME', 'SSH_AUTH_SOCK']);

export function buildChildEnv(source = process.env) {
  const env = Object.create(null);
  for (const name of ENV_ALLOWLIST) {
    const value = source?.[name];
    if (typeof value === 'string' && value !== '') env[name] = value;
  }
  return env;
}

/**
 * The argv for the supervised child.
 *
 * Every flag here is copied from a forward that is running in production on the
 * resident Mac right now, observed with `ps`. That is the point: this is not a
 * guess at a good ssh invocation, it is the one that has been surviving
 * reboots, sleeps and network changes on that machine.
 *
 *   -N -T -n -x        no command, no tty, no stdin, no X11. `-n` matters more
 *                      than it looks: without it the child inherits our stdin
 *                      and can swallow bytes meant for us.
 *   -F /dev/null       the child's behaviour must not depend on a user ssh
 *                      config that someone edits later. The production forward
 *                      that carries both an -L and an -R does exactly this and
 *                      then spells every option out, which is also why the
 *                      list below is long.
 *   BatchMode=yes      never prompt. With the environment above, cannot prompt.
 *   StrictHostKeyChecking=yes
 *                      load-bearing for T1: "TLS terminates on the resident"
 *                      is a claim about *which* machine is on the other end.
 *   ExitOnForwardFailure=yes
 *                      turn a refused bind into an exit we can classify, rather
 *                      than a live connection with no forward on it.
 *   ConnectionAttempts=1
 *                      retrying is ours. ssh retrying internally would hide
 *                      failures from the classifier and double the real cadence.
 *   ControlMaster=no / ControlPath=none / ControlPersist=no
 *                      a multiplexed session would attach to somebody else's
 *                      master, and then the child's lifetime would no longer be
 *                      the tunnel's lifetime -- which is the single assumption
 *                      this whole supervisor rests on.
 *   ForkAfterAuthentication=no
 *                      stay in the foreground. A child that backgrounds itself
 *                      exits immediately and successfully, which is precisely
 *                      the shape that produced 35,000 processes.
 *   LogLevel=ERROR     quiet, but `fatal()` still prints, so the forward-failure
 *                      diagnostic survives.
 */
export function buildSshArgs({
  host,
  user = null,
  sshPort = 22,
  remoteBindAddress = '127.0.0.1',
  remotePort,
  targetHost,
  targetPort,
  identityFile = null,
  identityAgent = null,
  knownHostsFile = null,
  useUserConfig = false,
  serverAliveIntervalSec = 20,
  serverAliveCountMax = 3,
  connectTimeoutSec = 10,
  extraOptions = {},
}) {
  const args = ['-N', '-T', '-n', '-x'];
  if (!useUserConfig) args.push('-F', '/dev/null');

  const option = (key, value) => args.push('-o', `${key}=${value}`);

  option('BatchMode', 'yes');
  option('RequestTTY', 'no');
  option('StrictHostKeyChecking', 'yes');
  option('ExitOnForwardFailure', 'yes');
  option('ServerAliveInterval', String(serverAliveIntervalSec));
  option('ServerAliveCountMax', String(serverAliveCountMax));
  option('ConnectTimeout', String(connectTimeoutSec));
  option('ConnectionAttempts', '1');
  option('TCPKeepAlive', 'yes');
  option('ForwardAgent', 'no');
  option('ForwardX11', 'no');
  option('ControlMaster', 'no');
  option('ControlPath', 'none');
  option('ControlPersist', 'no');
  option('ForkAfterAuthentication', 'no');
  option('PermitLocalCommand', 'no');
  option('PreferredAuthentications', 'publickey');
  option('PubkeyAuthentication', 'yes');
  option('PasswordAuthentication', 'no');
  option('KbdInteractiveAuthentication', 'no');
  option('NumberOfPasswordPrompts', '0');
  option('LogLevel', 'ERROR');

  if (identityFile) {
    option('IdentityFile', identityFile);
    option('IdentitiesOnly', 'yes');
  }
  if (identityAgent) option('IdentityAgent', identityAgent);
  if (knownHostsFile) option('UserKnownHostsFile', knownHostsFile);

  for (const [key, value] of Object.entries(extraOptions)) {
    if (RESERVED_SSH_OPTIONS.includes(String(key).toLowerCase())) {
      throw new SshIngressError(
        'reserved-ssh-option',
        `ssh option ${key} is set by this provider and may not be overridden`,
      );
    }
    option(key, String(value));
  }

  args.push('-p', String(sshPort));
  // `bind:port:host:port` -- four fields on purpose. The three-field form lets
  // sshd choose the bind address, and what it chooses depends on a server
  // setting we cannot see from here.
  args.push('-R', `${remoteBindAddress}:${remotePort}:${targetHost}:${targetPort}`);
  args.push(user ? `${user}@${host}` : host);

  return assertNoSecretsInArgv(args);
}

// --- small async helpers -----------------------------------------------------

const defaultSleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  // Nothing waits on a stop signal's rejection path; swallow it so a stop that
  // races a failure cannot surface as an unhandled rejection.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

const MAX_STDERR_BYTES = 8192;

/**
 * Wrap a spawned child so the supervisor can ask three questions: has it gone,
 * why, and what did it say. Tolerant of a fake child that has no `stderr`.
 */
function superviseChild(child) {
  const settled = deferred();
  const state = { exited: false, code: null, signal: null, stderr: '', spawnError: null };

  const finish = () => {
    if (state.exited) return;
    state.exited = true;
    settled.resolve(state);
  };

  // `exit` and `close` are not the same moment and the difference decides
  // whether classification works. `exit` fires when the process is gone;
  // `close` fires once its stdio has drained. The entire forward-vs-connection
  // distinction is read out of stderr, so classifying on `exit` would race the
  // last write and occasionally classify a forward failure as `unknown`. We
  // therefore wait for `close`, and keep `exit` only to record status and to
  // let the teardown loop stop waiting as soon as the process is actually gone.
  let processGone = false;

  child.on?.('error', (err) => {
    state.spawnError = err?.message ?? String(err);
    // A spawn error carries its own diagnostic; fold it into the text the
    // classifier reads so there is exactly one input to classification.
    state.stderr = `${state.stderr}${state.spawnError}\n`.slice(-MAX_STDERR_BYTES);
    processGone = true;
    finish();
  });
  child.on?.('exit', (code, signal) => {
    state.code = code ?? null;
    state.signal = signal ?? null;
    processGone = true;
    // No stderr pipe means nothing left to drain, so there is no `close` worth
    // waiting for.
    if (!child.stderr) finish();
  });
  child.on?.('close', (code, signal) => {
    if (state.code === null && code !== undefined && code !== null) state.code = code;
    if (state.signal === null && signal) state.signal = signal;
    processGone = true;
    finish();
  });
  child.stderr?.on?.('data', (chunk) => {
    state.stderr = `${state.stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
  });

  return {
    state,
    settled: settled.promise,
    hasExited: () => state.exited || processGone
      || (child.exitCode !== null && child.exitCode !== undefined),
  };
}

/**
 * SIGTERM, wait out the grace period, then SIGKILL. Safe to call twice.
 *
 * Step-counted rather than deadline-counted, and that is not a detail: `sleep`
 * is an injected seam and the clock is not, so a wall-clock deadline would spin
 * a no-op fake `sleep` at full tilt instead of yielding. Counting steps keeps
 * the grace period honest in production and instant under a fake clock.
 */
async function terminate({ child, hasExited, stopGraceMs, stopStepMs, sleep, logger }) {
  if (!child || hasExited()) return;
  try {
    child.kill('SIGTERM');
  } catch {
    return; // already gone; nothing to escalate to
  }
  const steps = Math.max(1, Math.ceil(stopGraceMs / stopStepMs));
  for (let step = 0; step < steps; step += 1) {
    if (hasExited()) return;
    await sleep(stopStepMs, 'stop-grace');
  }
  if (hasExited()) return;
  try {
    child.kill('SIGKILL');
  } catch { /* raced with its own exit */ }
  logger?.warn?.('provider.ssh.killed', { pid: child.pid });
}

// --- the provider ------------------------------------------------------------

/**
 * Build an ssh reverse-tunnel ingress provider.
 *
 * @param {object} options
 * @param {string} options.host              the remote that will hold the listener
 * @param {string} [options.user]            login name on that remote
 * @param {number} [options.sshPort]         the remote's sshd port
 * @param {number} options.remotePort        the port sshd should bind over there
 * @param {string} [options.remoteBindAddress] default `127.0.0.1`; see the header
 * @param {boolean} [options.acknowledgeRemoteGatewayPorts] waiver for a non-loopback bind
 * @param {string|null} [options.publicUrl]  what the republisher exposes, if anything
 * @param {'passthrough'|'terminating'} [options.tlsVariant]
 * @param {string} [options.sshPath]
 * @param {string|null} [options.identityFile]
 * @param {string|null} [options.identityAgent]
 * @param {string|null} [options.knownHostsFile]
 * @param {boolean} [options.useUserConfig]  include the user's ssh config; off by default
 * @returns {import('../provider.mjs').Provider}
 */
export function createSshProvider({
  host,
  user = null,
  sshPort = 22,
  remotePort,
  remoteBindAddress = '127.0.0.1',
  acknowledgeRemoteGatewayPorts = false,
  publicUrl = null,
  tlsVariant = 'passthrough',
  sshPath = 'ssh',
  identityFile = null,
  identityAgent = null,
  knownHostsFile = null,
  useUserConfig = false,
  serverAliveIntervalSec = 20,
  serverAliveCountMax = 3,
  connectTimeoutSec = 10,
  extraOptions = {},
  backoff = DEFAULT_BACKOFF,
  maxForwardConflicts = 6,
  startAttempts = 3,
  readySettleMs = 1_500,
  readyPollMs = 250,
  stopGraceMs = 5_000,
  stopStepMs = 50,
  // Injection seams. No test spawns a real ssh, binds a listener or reaches a
  // host, so each of these has to be replaceable.
  spawn = nodeSpawn,
  sleep = defaultSleep,
  random = Math.random,
  env = process.env,
} = {}) {
  if (typeof host !== 'string' || host === '') throw new SshIngressError('remote-required', 'the ssh provider needs a remote host');
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw new SshIngressError('remote-port-required', 'the ssh provider needs a remotePort between 1 and 65535');
  }
  if (!Object.hasOwn(TLS_VARIANTS, tlsVariant)) {
    throw new SshIngressError('unknown-tls-variant', `unknown tlsVariant ${tlsVariant}; expected ${Object.keys(TLS_VARIANTS).join(' or ')}`);
  }

  const isLoopbackBind = remoteBindAddress === '127.0.0.1' || remoteBindAddress === '::1' || remoteBindAddress === 'localhost';
  if (!isLoopbackBind && acknowledgeRemoteGatewayPorts !== true) {
    throw new SshIngressError(
      'gateway-ports-unacknowledged',
      `a non-loopback remote bind (${remoteBindAddress}) requires GatewayPorts to be yes or clientspecified in the remote's sshd_config. `
        + 'With the default "no", sshd accepts the request and silently binds loopback anyway, so ExitOnForwardFailure will not catch it '
        + 'and the tunnel will look healthy while being unreachable. Set acknowledgeRemoteGatewayPorts:true only after reading that config.',
    );
  }

  const policies = {
    connection: assertPolicy('connection', { ...DEFAULT_BACKOFF.connection, ...backoff?.connection }),
    forward: assertPolicy('forward', { ...DEFAULT_BACKOFF.forward, ...backoff?.forward }),
  };

  if (publicUrl !== null) {
    if (typeof publicUrl !== 'string' || publicUrl === '') throw new TypeError('publicUrl must be a non-empty string or null');
    new URL(publicUrl); // throws on nonsense, early, before anything is spawned
  }

  return {
    name: 'ssh',
    shape: LISTENER_CONFIGURING,

    async start({ target, logger }) {
      // Re-checked here as well as in `startProvider`, so a direct call gets the
      // same contract. For this shape the check happens to be exactly the thing
      // `-R` needs: where the far end of the forward dials.
      validateTarget(target, LISTENER_CONFIGURING);

      const args = buildSshArgs({
        host,
        user,
        sshPort,
        remoteBindAddress,
        remotePort,
        targetHost: target.host,
        targetPort: target.port,
        identityFile,
        identityAgent,
        knownHostsFile,
        useUserConfig,
        serverAliveIntervalSec,
        serverAliveCountMax,
        connectTimeoutSec,
        extraOptions,
      });
      const childEnv = buildChildEnv(env);

      const state = {
        stopping: false,
        readyOnce: false,
        attempt: 0,
        restarts: 0,
        spawns: 0,
        forwardConflicts: 0,
        lastExitClass: null,
        current: null,
        terminal: null,
      };

      const stopSignal = deferred();
      const firstReady = deferred();

      /** A backoff sleep that a `stop()` can cut short. */
      const delay = async (ms, reason) => {
        await Promise.race([sleep(ms, reason), stopSignal.promise]);
      };

      /**
       * Did this attempt stay up? There is no ready signal to wait for: `ssh -N`
       * says nothing on success, and the only honest evidence that the forward
       * was accepted is that `ExitOnForwardFailure=yes` did *not* make it exit.
       * So readiness is "it survived the settle window" -- a liveness fact, not
       * a reachability proof. provider.mjs already warns that `publicUrl` is not
       * a promise about who can reach it; this is the same caveat, upstream.
       */
      const settle = async (supervised) => {
        const steps = Math.max(0, Math.ceil(readySettleMs / Math.max(1, readyPollMs)));
        for (let step = 0; step < steps; step += 1) {
          if (supervised.hasExited() || state.stopping) return false;
          await delay(readyPollMs, 'ready-poll');
        }
        return !supervised.hasExited() && !state.stopping;
      };

      const loop = (async () => {
        while (!state.stopping) {
          if (state.attempt > 0) {
            const band = backoffBandFor(state.lastExitClass);
            const ms = nextDelayMs({ attempt: state.attempt, policy: policies[band], random });
            logger?.warn?.('provider.ssh.backoff', {
              attempt: state.attempt, band, delayMs: ms, reason: state.lastExitClass,
            });
            await delay(ms, 'backoff');
            if (state.stopping) break;
          }

          let child;
          try {
            child = spawn(sshPath, args, { stdio: ['ignore', 'ignore', 'pipe'], env: childEnv });
          } catch (err) {
            // A synchronous throw is a configuration fault (a bad path, a bad
            // cwd); there is no child to supervise and no point retrying.
            state.terminal = new SshIngressError('spawn-failed', `could not spawn ssh: ${err?.message ?? err}`);
            break;
          }

          state.spawns += 1;
          if (state.spawns > 1) state.restarts += 1;
          const supervised = superviseChild(child);
          state.current = { child, supervised };
          logger?.info?.('provider.ssh.spawned', {
            pid: child.pid, spawns: state.spawns, remotePort, remoteBindAddress,
          });

          if (await settle(supervised)) {
            state.attempt = 0;
            state.forwardConflicts = 0;
            if (!state.readyOnce) {
              state.readyOnce = true;
              firstReady.resolve();
            }
            logger?.info?.('provider.ssh.up', { pid: child.pid, remotePort });
            await Promise.race([supervised.settled, stopSignal.promise]);
          }
          if (state.stopping) break;

          // The process is gone; wait for its stderr to drain before reading a
          // verdict out of it. Already resolved in the common case, and still
          // interruptible by `stop()` in the pathological one.
          await Promise.race([supervised.settled, stopSignal.promise]);
          if (state.stopping) break;

          const cls = classifyExit({ ...supervised.state, stopping: false });
          state.lastExitClass = cls;
          logger?.warn?.('provider.ssh.exited', {
            pid: child.pid, code: supervised.state.code, signal: supervised.state.signal, classified: cls,
          });

          if (!isRetryable(cls)) {
            state.terminal = new SshIngressError(
              `ssh-${cls}`,
              `ssh exited with a ${cls} failure, which is not retried: ${firstLine(supervised.state.stderr) || `status ${supervised.state.code}`}`,
            );
            break;
          }

          if (cls === EXIT_CLASSES.FORWARD) {
            state.forwardConflicts += 1;
            if (state.forwardConflicts >= maxForwardConflicts) {
              state.terminal = new SshIngressError(
                'forward-conflict',
                `remote port ${remotePort} could not be bound after ${state.forwardConflicts} attempts; `
                  + 'something else on the remote owns it and no amount of retrying will free it',
              );
              break;
            }
          }

          state.attempt += 1;
          // Bounded only before the first success. Once the tunnel has been up,
          // a provider that gives up is worse than one that keeps trying at the
          // ceiling, which is one attempt a minute.
          if (!state.readyOnce && state.attempt >= startAttempts) {
            state.terminal = new SshIngressError(
              'start-failed',
              `ssh did not establish the reverse forward in ${startAttempts} attempts (last failure: ${cls})`,
            );
            break;
          }
        }

        if (state.terminal && !state.readyOnce) firstReady.reject(state.terminal);
        if (state.terminal && state.readyOnce) {
          logger?.error?.('provider.ssh.gave-up', { code: state.terminal.code, message: state.terminal.message });
        }
        // A terminal failure after the tunnel was up leaves the ingress down.
        // Nothing in the interface can report that, so the log above and
        // `handle.terminal` are the whole story. See the module header.
      })();
      loop.catch(() => {});

      const stopOnce = async () => {
        state.stopping = true;
        stopSignal.resolve();
        const current = state.current;
        if (current) {
          await terminate({
            child: current.child,
            hasExited: current.supervised.hasExited,
            stopGraceMs,
            stopStepMs,
            sleep,
            logger,
          });
        }
        await loop;
        logger?.info?.('provider.ssh.stopped', { spawns: state.spawns, restarts: state.restarts });
      };

      try {
        await firstReady.promise;
      } catch (err) {
        await stopOnce();
        throw err;
      }

      let stopped = false;
      return {
        kind: 'ssh',
        // Deliberately whatever the caller told us, and `null` otherwise. The
        // port we bind over there is on the remote's *loopback* -- nothing can
        // dial it, not even from the remote's own LAN -- so synthesising
        // `https://<host>:<remotePort>` would be a URL that is false by
        // construction. Only the operator knows what the republisher in front
        // of it publishes, so only the operator can supply it.
        publicUrl,
        remoteBindAddress,
        remotePort,
        tlsVariant,
        tls: TLS_VARIANTS[tlsVariant],
        capabilities: SSH_CAPABILITIES,
        get pid() { return state.current?.child?.pid ?? null; },
        get restarts() { return state.restarts; },
        get forwardConflicts() { return state.forwardConflicts; },
        get lastExitClass() { return state.lastExitClass; },
        get terminal() { return state.terminal; },
        async stop() {
          if (stopped) return;
          stopped = true;
          await stopOnce();
        },
      };
    },
  };
}

function firstLine(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return '';
  return trimmed.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
}

export default createSshProvider;
