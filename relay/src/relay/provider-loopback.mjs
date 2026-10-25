// The degenerate ingress: the listener is already exactly where it needs to be.
//
// Worth having as a real provider rather than a special case in the caller.
// Every `if (provider)` branch in the surface is a path that only runs in
// production, and the loopback provider is what deletes them: dev and tests run
// the same code path as Tailscale Serve does, with nothing to configure.
//
// It is the listener-configuring shape taken to zero -- somebody else (the
// surface's own `listen`) made the listener, and this provider's entire job is
// to report where it is.

import { LISTENER_CONFIGURING } from './provider-shapes.mjs';

/**
 * @param {{ scheme?: string }} [options]
 * @returns {import('./provider.mjs').Provider}
 */
export function createLoopbackProvider({ scheme = 'http' } = {}) {
  return {
    name: 'loopback',
    shape: LISTENER_CONFIGURING,
    async start({ target, logger }) {
      // Bracket a literal IPv6 host so the URL is dialable as written.
      const host = target.host.includes(':') ? `[${target.host}]` : target.host;
      const url = `${scheme}://${host}:${target.port}`;
      logger.info('provider.loopback.started', { url });
      return {
        kind: 'loopback',
        // A real, dialable URL that is not remotely public. The field cannot
        // say both of those things at once -- see the limitations in
        // provider.mjs -- and the useful half is the one reported.
        publicUrl: url,
        stop() {
          // Nothing was configured, so there is nothing to undo. A provider
          // whose stop() is empty is a provider that cannot leave a mess
          // behind, which is the nicest property a dev-mode ingress can have.
          logger.info('provider.loopback.stopped', { url });
        },
      };
    },
  };
}
