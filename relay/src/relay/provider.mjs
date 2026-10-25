// How the resident machine becomes reachable -- without the surface having to
// know which way.
//
//     start({ target, logger }) -> { kind, publicUrl|null, stop() }
//
// That is the whole interface. It has to fit two genuinely different shapes,
// and it was written by asking what the *difference* between them costs the
// caller, rather than by generalising one of them:
//
//   LISTENER_CONFIGURING -- something else already produces a public TCP
//     listener and the provider only configures it and reports a URL. A
//     Tailscale Serve provider is this: one CLI call points `:443` at a
//     loopback port, and the connections arrive on the surface's own listener
//     as if they were local. So is a VPS doing SNI passthrough. These providers
//     never see a byte; they need to know *where* the listener is.
//
//   OUTBOUND_MULTIPLEXING -- nothing can reach this machine, so the provider
//     dials out, demultiplexes inbound streams, and feeds each one into our
//     http server. The relay provider is this shape. It works because Node's
//     http server takes connections from an event:
//     `server.emit("connection", socket)` serves a connection nobody accepted.
//     Which means a provider of this shape reduces to *producing sockets* --
//     and that, not any cleverness in the interface, is what keeps the
//     abstraction honest.
//
// The two shapes need different things from the target, and the interface says
// so instead of pretending otherwise: a listener-configuring provider needs
// host and port, an outbound-multiplexing one needs the server object.
//
// ---------------------------------------------------------------------------
// What this interface cannot yet express. Listed rather than papered over,
// because a capability flag invented today is a lie told in every provider
// that does not have the capability:
//
//   * Health and recovery. `start` succeeds or throws and `stop` ends it. There
//     is no "attached, lost the relay, retrying" state, so the relay provider
//     does not reconnect -- a dropped control socket ends the attachment and
//     says so in the log. Supervision belongs to whoever owns the process, and
//     until the interface can report degradation, inventing a retry loop here
//     would hide the one fact an operator needs.
//   * Client identity. A relayed connection has no peer address, port or TLS
//     state (see duplex.mjs). PROXY protocol v2 -- which the Tailscale path can
//     supply and the relay path cannot -- has nowhere to be reported.
//   * A URL that changes after start. `publicUrl` is a snapshot, and nothing
//     notifies the caller if it moves.
//   * Reachability scope. `publicUrl` is a URL, not a promise about who can
//     reach it: the loopback provider returns a perfectly real URL that no
//     phone can dial. A caller must not read "public" into the field name.
//   * More than one way in at a time. One provider, one target.
// ---------------------------------------------------------------------------

import { createLoopbackProvider } from './provider-loopback.mjs';
import { createRelayProvider } from './provider-relay.mjs';
import { createSshProvider } from './providers/ssh.mjs';
import { createTailscaleProvider } from './providers/tailscale.mjs';

// Re-exported rather than defined here. This module imports the providers now,
// and the providers need the shape constant; defining it downstream of the
// registry is what made ssh.mjs fail to evaluate. provider-shapes.mjs carries
// the full account.
import { LISTENER_CONFIGURING, OUTBOUND_MULTIPLEXING, PROVIDER_SHAPES } from './provider-shapes.mjs';

export { LISTENER_CONFIGURING, OUTBOUND_MULTIPLEXING, PROVIDER_SHAPES };

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Providers are *constructed* with their own options and then started with a
 * target. That split is deliberate: `start({ target, logger })` is the only
 * thing the surface calls, so the surface never has to learn a provider's
 * option names to hand them through.
 *
 * @typedef {{ name: string, shape: string, start: (ctx: { target: object, logger: object }) => Promise<{ kind: string, publicUrl: string|null, stop: () => any }> }} Provider
 */
export function validateProvider(provider) {
  if (!provider || typeof provider !== 'object') throw new Error('a provider must be an object');
  if (typeof provider.name !== 'string' || provider.name === '') throw new Error('a provider needs a name');
  if (!PROVIDER_SHAPES.includes(provider.shape)) {
    throw new Error(`unknown provider shape ${provider.shape}; expected one of ${PROVIDER_SHAPES.join(', ')}`);
  }
  if (typeof provider.start !== 'function') throw new Error(`provider ${provider.name} has no start()`);
  return provider;
}

/**
 * What a provider is given to work with.
 *
 * @typedef {object} ProviderTarget
 * @property {string} [name] the identity this machine should be reachable as
 * @property {import('node:http').Server} [server] the server that will serve the connections
 * @property {string} [host] where that server's own listener is, if it has one
 * @property {number} [port]
 * @property {string} [url] the local URL form of that listener, if any
 */
export function validateTarget(target, shape) {
  if (!target || typeof target !== 'object') throw new Error('a provider target must be an object');
  if (shape === OUTBOUND_MULTIPLEXING && typeof target.server?.emit !== 'function') {
    // Not a style check: this shape works by emitting connections at the
    // server, so a target without one cannot be served at all.
    throw new Error('an outbound-multiplexing provider needs target.server');
  }
  if (shape === LISTENER_CONFIGURING && (typeof target.host !== 'string' || !Number.isInteger(target.port))) {
    throw new Error('a listener-configuring provider needs target.host and target.port');
  }
  return target;
}

/**
 * Start a provider against a target, checking both ends of the contract so a
 * malformed provider fails at the boundary rather than three layers in.
 *
 * `stop()` is wrapped to be idempotent and awaitable: shutdown paths call it
 * from more than one place (a signal handler and a finally block, typically)
 * and a provider should not have to defend against that itself.
 */
export async function startProvider(provider, { target, logger = silentLogger } = {}) {
  validateProvider(provider);
  validateTarget(target, provider.shape);

  const handle = await provider.start({ target, logger });
  if (!handle || typeof handle !== 'object') throw new Error(`provider ${provider.name} returned no handle`);
  if (typeof handle.kind !== 'string' || handle.kind === '') throw new Error(`provider ${provider.name} returned no kind`);
  if (typeof handle.publicUrl !== 'string' && handle.publicUrl !== null) {
    // A URL or nothing. `undefined` would read as "not implemented yet" at
    // every call site, which is exactly the ambiguity this field must not have.
    throw new Error(`provider ${provider.name} must report a publicUrl or null`);
  }
  if (typeof handle.stop !== 'function') throw new Error(`provider ${provider.name} returned no stop()`);

  let stopped = false;
  return {
    kind: handle.kind,
    publicUrl: handle.publicUrl,
    async stop() {
      if (stopped) return;
      stopped = true;
      await handle.stop();
    },
  };
}

/**
 * The providers that exist today, by name. Values are factories, not instances.
 *
 * Two further providers exist in the originating repository and are withheld
 * from this import pending a naming decision; see relay/README.md. Re-adding
 * them is additive: a factory import and one line in this table.
 */
export const PROVIDERS = Object.freeze({
  loopback: createLoopbackProvider,
  relay: createRelayProvider,
  ssh: createSshProvider,
  // Registered but NOT verified on the resident Mac -- it has never been
  // installed there (never attempted, not cannot be). See docs/13 and 12 §2.
  tailscale: createTailscaleProvider,
});

/** Build a provider by name. */
export function selectProvider(name, options = {}) {
  const factory = PROVIDERS[name];
  if (!factory) throw new Error(`unknown ingress provider ${name}; have ${Object.keys(PROVIDERS).join(', ')}`);
  return validateProvider(factory(options));
}

export {
  createLoopbackProvider,
  createRelayProvider,
  createSshProvider,
  createTailscaleProvider,
};
