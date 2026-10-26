// Ingress through a relay: nothing can reach this machine, so we dial out.
//
// The provider registers as a named end on a relay, and every time a client
// attaches to that name the relay hands us a socket. Those sockets go straight
// into our own http server via `server.emit("connection", socket)`, so from the
// server's point of view a relayed browser is indistinguishable from a local
// one -- same request parsing, same routing, same websocket upgrade path. No
// branch anywhere in the surface says "this one came in over the relay".
//
// This is the outbound-multiplexing shape, and it is the reason that shape is
// in the interface at all: its whole implementation is "produce sockets".

import { OUTBOUND_MULTIPLEXING } from './provider-shapes.mjs';
import { createEnd } from './end.mjs';

/**
 * @param {object} options
 * @param {string} options.url the relay base URL (`ws://host:port` or `http://host:port`)
 * @param {string|null} [options.token] the relay token, if the relay requires one
 * @param {string} [options.end] the name to announce; defaults to the target's name
 * @returns {import('./provider.mjs').Provider}
 */
export function createRelayProvider({ url, token = null, end, ...endOptions } = {}) {
  if (typeof url !== 'string' || url === '') throw new Error('the relay provider needs a relay url');

  return {
    name: 'relay',
    shape: OUTBOUND_MULTIPLEXING,
    async start({ target, logger }) {
      const name = end ?? target.name;
      if (typeof name !== 'string' || name === '') {
        throw new Error('the relay provider needs an end name, from options.end or target.name');
      }

      const attached = await createEnd({
        ...endOptions,
        url,
        token,
        end: name,
        // Reported for `GET /ends`, where it is a human-readable hint about
        // where this end actually lives -- not an address anybody dials.
        listen: target.url ?? (target.host && target.port ? `${target.host}:${target.port}` : null),
        logger,
        onSocket: (socket, { clientEnd }) => {
          logger.info('provider.relay.connection', { end: name, clientEnd });
          // The entire provider, right here. Node does not care that this
          // connection was never accepted from a listener.
          target.server.emit('connection', socket);
        },
      });

      logger.info('provider.relay.started', { end: name, relay: safeOrigin(url) });

      return {
        kind: 'relay',
        // Deliberately null. There is no URL a browser can be pointed at: the
        // only way in is to attach to this end *through* the relay, which is
        // not a thing an address bar does. Inventing a URL here would be worse
        // than admitting there isn't one.
        publicUrl: null,
        stop: () => attached.stop(),
      };
    },
  };
}

/** Origin only -- a relay URL may carry credentials in it and a log may not. */
function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
