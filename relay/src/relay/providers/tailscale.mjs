// Ingress provider: Tailscale Funnel.
//
// Written to spec and NOT VERIFIED ON THE RESIDENT MAC. That is not a caveat
// tucked in a footnote, it is exported as `VERIFIED_ON_RESIDENT = false` and a
// test asserts it, because the one thing worse than an unverified provider is
// an unverified provider that reads like a verified one. The resident Mac is
// MDM-enrolled, and the client has never been installed there -- note that
// this says "never attempted", not "cannot be": the managed payload once
// cited as proof of a ban turned out to carry no install restriction at all.
// See docs/12 section 2.
// Whoever flips that constant should have run the route end to end first.
//
// Read this part even if you skip the rest, because it is the reason this file
// exists rather than being a stub: **of every candidate in docs/04, Funnel is
// the only one that supplies the hostname.** Every other route leaves us
// needing a domain we do not have, and WebAuthn cannot proceed without one --
// an IP address is not a valid RP ID, so no passkey, so no auth. Funnel hands
// over `<node>.<tailnet>.ts.net`, a real name with a real certificate, for no
// DNS work at all. It closes two blockers with one install.
//
// ---------------------------------------------------------------------------
// T1, which Funnel passes, and the residual that it does not remove.
//
// docs/04 section T1: the browser's TLS must be terminated by a local process,
// and the private key for the cert the browser validates must not exist on a
// third party's machine. A third party that only forwards ciphertext it cannot
// read passes. Tailscale's own documentation is explicit on both halves:
//
//   "Funnel relay servers do not decrypt the traffic between public devices and
//    your device. This ensures that Tailscale cannot access or read any
//    content."
//   "The Tailscale server running on your device receives the encrypted request
//    from the TCP proxy. It then terminates the TLS connection..."
//   "Your certificate's private key and your Let's Encrypt (ACME) account's
//    private key are generated and stored locally on your machine and Tailscale
//    never sees them."
//
// So the relay is an SNI-routed byte pipe and the key is ours -- the same
// property that makes the ssh+socat route acceptable, and the same clause
// the outbound-multiplexing shape leans on. Verified against vendor documentation,
// not against this machine.
//
// The residual, stated because nobody else will: **Tailscale controls the
// `ts.net` zone.** It writes the DNS TXT records our node uses to answer its
// DNS-01 challenges. It therefore cannot read our traffic, but it could satisfy
// a DNS-01 challenge for our name under an account of its own and obtain a
// second valid certificate. The standard mitigation is RFC 8657 CAA
// `accounturi`, pinning issuance to our ACME account -- and **that mitigation
// is unavailable here**, because setting a CAA record on `ts.net` requires
// controlling `ts.net`. On our own domain we can pin; on a `ts.net` name we
// cannot. That is the price of not having to own a domain, and it is a real
// price rather than a theoretical one. `tlsResidual` in FUNNEL_MODES says so in
// a field so it survives being skimmed.
// ---------------------------------------------------------------------------
// Shape: listener-configuring, for the same reason ssh.mjs is.
//
// tailscaled owns the public listener. We keep our own local listener and point
// it there; no socket is ever handed to this module, so there is nothing to
// emit at target.server. Hence LISTENER_CONFIGURING and hence validateTarget
// demanding target.host and target.port.
//
//     phone -> funnel relay (SNI routing, no decryption)
//           -> tailscaled on the Mac
//           -> Mac 127.0.0.1:<target.port>
//
// ---------------------------------------------------------------------------
// Foreground, never `--bg`, and this one is a safety property rather than taste.
//
// `tailscale funnel --bg` registers the funnel in tailscaled's state and
// returns. The exposure then outlives our process: if we crash, a port on this
// Mac stays published to the public internet with nothing supervising it, until
// somebody remembers to run `funnel off`. Running in the foreground ties the
// exposure to the child's lifetime, so the worst case is an ingress that is
// gone rather than an ingress that is unattended. `--bg` is refused, not
// defaulted away from.

import { spawn as nodeSpawn } from 'node:child_process';

import { LISTENER_CONFIGURING } from '../provider-shapes.mjs';
import { validateTarget } from '../provider.mjs';

/** Must match the listener-configuring constant in `src/relay/provider.mjs`. */
export const PROVIDER_SHAPE = LISTENER_CONFIGURING;

export const PROVIDER_NAME = 'tailscale';

/**
 * Has this route been run end to end on the resident Mac? No. Exported so the
 * claim is a value a test can assert rather than a sentence in a comment that
 * nobody has to keep true.
 */
export const VERIFIED_ON_RESIDENT = false;

/**
 * The two ways Funnel can hand traffic over, and where TLS lands in each.
 *
 * Both pass T1 -- that is the interesting part, and the reason is different in
 * each case. In `https` mode tailscaled terminates, and tailscaled is a local
 * process holding a local key, which is exactly what T1 asks for; our surface
 * then receives plaintext HTTP over loopback, which never leaves the machine.
 * In `tcp` mode the TLS stream arrives at our port intact and the surface
 * terminates it itself, using a cert from `tailscale cert`.
 */
export const FUNNEL_MODES = Object.freeze({
  /** tailscaled is an HTTPS reverse proxy: it terminates TLS and speaks HTTP to us. */
  https: Object.freeze({
    flag: '--https',
    localScheme: 'http',
    tlsTerminatedBy: 'tailscaled',
    surfaceReceives: 'plaintext-http-over-loopback',
    passesT1: true,
    needsOwnCertificate: false,
    tlsResidual: 'tailscale controls the ts.net zone and could issue a second cert; CAA pinning unavailable',
  }),
  /**
   * `--tls-terminated-tcp`: tailscaled still terminates TLS, but forwards a
   * plain TCP stream instead of parsing HTTP. Useful when the surface wants the
   * bytes without a reverse proxy in front of them.
   */
  tcp: Object.freeze({
    flag: '--tls-terminated-tcp',
    localScheme: 'tcp',
    tlsTerminatedBy: 'tailscaled',
    surfaceReceives: 'plaintext-tcp-over-loopback',
    passesT1: true,
    needsOwnCertificate: false,
    tlsResidual: 'as https mode: the zone is not ours, so issuance cannot be pinned',
  }),
  /**
   * `--tcp`: the stream is forwarded untouched, so the TLS the browser started
   * arrives at our port intact. The strictest reading of T1 and the only mode
   * where tailscaled holds no key on our behalf at all -- but the surface must
   * then present a cert for the ts.net name itself, which means running
   * `tailscale cert` and keeping it renewed.
   *
   * Do not read the CLI reference's phrase "forwarding unencrypted TCP packets"
   * as "the browser's TLS is gone". It describes the *local* leg: tailscaled
   * does no TLS work, so what it hands us is whatever the client sent, which on
   * port 443 is a TLS ClientHello.
   */
  raw: Object.freeze({
    flag: '--tcp',
    localScheme: 'tcp',
    tlsTerminatedBy: 'surface',
    surfaceReceives: 'tls-stream',
    passesT1: true,
    needsOwnCertificate: true,
    tlsResidual: 'as https mode, plus certificate renewal becomes ours to run',
  }),
});

export const FUNNEL_MODE_NAMES = Object.freeze(Object.keys(FUNNEL_MODES));

/**
 * What the route can do, and what it needs from somewhere other than this file.
 * Exported so the capability claims are a test rather than a paragraph.
 */
export const TAILSCALE_CAPABILITIES = Object.freeze({
  /** Funnel publishes 443, 8443 or 10000, and nothing else. */
  publicPorts: Object.freeze([443, 8443, 10000]),
  /** A WebSocket upgrade over Funnel is documented as supported. */
  websocketUpgrade: true,
  /** The whole point: the route arrives with a working DNS name and cert. */
  suppliesHostname: true,
  /** ...which is what makes a passkey possible without owning a domain. */
  suppliesWebauthnRpId: true,
  /** It is a client install, and on a managed Mac that is the blocking step. */
  requiresNewSoftwareOnResident: true,
  /** tailscaled dials out; no inbound reachability needed here. */
  requiresInboundReachabilityOnResident: false,
  /** No VPS, no republisher, no second host of any kind. */
  requiresSecondHost: false,
  /** Two switches in the admin console that no amount of local config replaces. */
  requiresTailnetPolicy: Object.freeze(['funnel node attribute', 'HTTPS certificates enabled']),
  /** Nothing is ever passed as a value: the daemon holds the node key. */
  credentialShape: 'node key held by tailscaled; never a value in argv or env',
});

/** Refusals that are a property of the route, not of a caller's typo. */
export class TailscaleIngressError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TailscaleIngressError';
    this.code = code;
  }
}

/**
 * Funnel will only publish one of three ports. Checked here rather than
 * discovered from the daemon's error text, because the set is a documented
 * product constraint and a typo in it should fail while somebody is wiring.
 *
 * @param {number} port
 * @returns {number}
 */
export function assertFunnelPort(port) {
  if (!Number.isInteger(port)) throw new TypeError('the funnel port must be an integer');
  if (!TAILSCALE_CAPABILITIES.publicPorts.includes(port)) {
    throw new TailscaleIngressError(
      'unsupported-funnel-port',
      `funnel publishes only ${TAILSCALE_CAPABILITIES.publicPorts.join(', ')}, not ${port}`,
    );
  }
  return port;
}

/**
 * @param {string} mode
 * @returns {string}
 */
export function assertFunnelMode(mode) {
  if (!FUNNEL_MODE_NAMES.includes(mode)) {
    throw new TypeError(`funnelMode must be one of ${FUNNEL_MODE_NAMES.join(', ')}`);
  }
  return mode;
}

/**
 * Pull the node's public name out of `tailscale status --json`.
 *
 * `DNSName` comes back fully qualified with a trailing dot, which is correct
 * DNS and wrong for every other use: it is not a valid WebAuthn RP ID and it
 * is not what goes in a URL. Stripped here, once, rather than at each of the
 * four call sites that would otherwise each get it slightly different.
 *
 * @param {string|object} raw stdout from `tailscale status --json`, or the parsed object
 * @returns {string} e.g. `mac.tailnet-name.ts.net`
 */
export function parseNodeName(raw) {
  let status;
  if (typeof raw === 'string') {
    try {
      status = JSON.parse(raw);
    } catch {
      throw new TailscaleIngressError('status-unparseable', 'tailscale status --json did not return json');
    }
  } else {
    status = raw;
  }

  const name = status?.Self?.DNSName;
  if (typeof name !== 'string' || name === '') {
    throw new TailscaleIngressError(
      'node-name-missing',
      'tailscale status reported no Self.DNSName -- is this node logged in?',
    );
  }
  const trimmed = name.replace(/\.$/, '');
  if (!trimmed.includes('.')) {
    throw new TailscaleIngressError('node-name-missing', `Self.DNSName is not a fully qualified name: ${trimmed}`);
  }
  return trimmed;
}

/**
 * Build the argv. Separate from the spawn so the refusals are testable without
 * a daemon, which is the only way this file can be tested at all right now.
 *
 * @param {object} options
 * @param {number} options.funnelPort      the public port, one of 443/8443/10000
 * @param {string} options.funnelMode      see FUNNEL_MODES
 * @param {number} options.localPort       the surface's own port
 * @param {boolean} [options.background]   refused; see the header
 * @returns {string[]}
 */
export function buildFunnelArgs({ funnelPort, funnelMode, localPort, background = false }) {
  assertFunnelPort(funnelPort);
  assertFunnelMode(funnelMode);
  if (!Number.isInteger(localPort) || localPort <= 0 || localPort > 65535) {
    throw new TypeError('localPort must be a valid tcp port');
  }
  if (background) {
    throw new TailscaleIngressError(
      'background-funnel-refused',
      'refusing --bg: a backgrounded funnel outlives this process and survives reboots, '
        + 'leaving a port published to the public internet with nothing supervising it',
    );
  }

  const { flag, localScheme } = FUNNEL_MODES[funnelMode];
  // The flag carries the *public* port and the trailing argument is the local
  // target. Both are spelled out: `tailscale funnel 8443` is legal and means
  // the opposite of what a reader of this file would assume -- it publishes on
  // the default port and treats 8443 as the local target. An explicit flag and
  // an explicit target URL cannot be misread that way.
  //
  // The target must be a URL rather than a bare port for the tcp forwarders,
  // and giving one in every mode keeps the three argv shapes parallel.
  return ['funnel', `${flag}=${funnelPort}`, `${localScheme}://127.0.0.1:${localPort}`];
}

/**
 * No secret should ever reach argv here -- the node key lives in tailscaled --
 * so this is a cheap assertion that stays true rather than a hard problem.
 *
 * @param {string[]} argv
 */
export function assertNoSecretsInArgv(argv) {
  for (const arg of argv) {
    if (/^[A-Za-z0-9+/=_-]{24,}$/.test(arg) && !/^\d+$/.test(arg)) {
      throw new TailscaleIngressError(
        'secret-in-argv',
        'an argument looks like a credential; tailscale takes none, so this is a wiring mistake',
      );
    }
  }
  return argv;
}

/**
 * @param {object} [options]
 * @param {number} [options.funnelPort] default 443
 * @param {'https'|'tcp'|'raw'} [options.funnelMode] default 'https'
 * @param {string} [options.tailscalePath] default 'tailscale'
 * @param {boolean} [options.background] refused
 * @returns {import('../provider.mjs').Provider}
 */
export function createTailscaleProvider({
  funnelPort = 443,
  funnelMode = 'https',
  tailscalePath = 'tailscale',
  background = false,
  // Injection seams. Nothing in this module's suite spawns a real tailscale.
  spawn = nodeSpawn,
  runStatus = null,
} = {}) {
  // Checkable now, so a misconfiguration fails at wiring time rather than at
  // the moment somebody's phone is waiting on it.
  assertFunnelPort(funnelPort);
  assertFunnelMode(funnelMode);
  if (background) {
    throw new TailscaleIngressError(
      'background-funnel-refused',
      'refusing --bg: a backgrounded funnel outlives this process',
    );
  }

  return {
    name: PROVIDER_NAME,
    shape: PROVIDER_SHAPE,

    async start({ target, logger }) {
      validateTarget(target, PROVIDER_SHAPE);

      logger?.warn?.('provider.tailscale.unverified', {
        verifiedOnResident: VERIFIED_ON_RESIDENT,
        note: 'written to spec; see docs/13-tailscale.md',
      });

      const status = runStatus
        ? await runStatus()
        : await readStatus({ tailscalePath, spawn });
      const nodeName = parseNodeName(status);

      const args = assertNoSecretsInArgv(
        buildFunnelArgs({ funnelPort, funnelMode, localPort: target.port, background }),
      );

      const child = spawn(tailscalePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      const state = { exited: false, stderr: '', stopping: false };
      child.stderr?.setEncoding?.('utf8');
      child.stderr?.on?.('data', (chunk) => {
        state.stderr = `${state.stderr}${chunk}`.slice(-4096);
      });
      child.once?.('exit', (code, signal) => {
        state.exited = true;
        if (!state.stopping) {
          // Not retried here. A funnel that will not start is almost always a
          // tailnet policy refusal, and retrying a policy refusal is a loop
          // that never converges and never says why.
          logger?.error?.('provider.tailscale.exited', { code, signal, stderr: state.stderr.slice(-512) });
        }
      });

      const mode = FUNNEL_MODES[funnelMode];
      const publicUrl = `https://${nodeName}${funnelPort === 443 ? '' : `:${funnelPort}`}/`;

      logger?.info?.('provider.tailscale.started', {
        pid: child.pid,
        funnelPort,
        funnelMode,
        localPort: target.port,
        // The two facts a reader of the log actually wants about privacy.
        tlsTerminatedBy: mode.tlsTerminatedBy,
        relayDecrypts: false,
      });

      return {
        kind: PROVIDER_NAME,
        publicUrl,
        /** The RP ID a passkey registers against. The whole reason for this route. */
        webauthnRpId: nodeName,
        tlsTerminatedBy: mode.tlsTerminatedBy,
        verifiedOnResident: VERIFIED_ON_RESIDENT,
        async stop() {
          // `startProvider` wraps stop to be idempotent, but a provider that
          // relies on its caller for that is one direct call away from sending
          // a second signal to a pid it no longer owns.
          if (state.stopping) return;
          state.stopping = true;
          if (state.exited) return;
          // SIGTERM, then let the foreground funnel tear itself down. There is
          // deliberately no `funnel off` here: issuing it would also clear a
          // funnel somebody else configured on this node.
          child.kill?.('SIGTERM');
        },
      };
    },
  };
}

export default { createTailscaleProvider, name: PROVIDER_NAME, shape: PROVIDER_SHAPE };

// --- internals --------------------------------------------------------------

/**
 * `tailscale status --json`, collected. Factored out so `runStatus` can replace
 * the whole thing in a test without stubbing child_process twice.
 */
async function readStatus({ tailscalePath, spawn }) {
  return await new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(tailscalePath, ['status', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (cause) {
      reject(
        new TailscaleIngressError(
          'client-missing',
          `could not run ${tailscalePath}: ${cause?.message ?? cause}. The client is not installed.`,
        ),
      );
      return;
    }
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on?.('data', (c) => {
      out += c;
    });
    child.stderr?.on?.('data', (c) => {
      err += c;
    });
    child.once?.('error', (cause) => {
      reject(
        new TailscaleIngressError(
          'client-missing',
          `could not run ${tailscalePath}: ${cause?.message ?? cause}. The client is not installed.`,
        ),
      );
    });
    child.once?.('exit', (code) => {
      if (code === 0) resolve(out);
      else reject(new TailscaleIngressError('status-failed', `tailscale status exited ${code}: ${err.slice(-512)}`));
    });
  });
}
