// A paired relay socket, dressed as something an http server will accept.
//
// This is the hinge the whole provider abstraction turns on. Node's http server
// takes its connections from an event, not from a listener, so
// `server.emit('connection', duplex)` feeds it a connection it never accepted.
// Once that works, a provider's job reduces to *producing sockets* -- and
// "reachable from the outside" stops being an architectural property of the
// server and becomes a plug-in. Verified on this host against plain, keep-alive
// and upgrade requests, listening and not.
//
// What the dressing cannot supply is the honest part, and it is listed where it
// is told rather than in a README: a relayed connection has no network identity
// at all. No peer address, no port, no TLS state. The only thing it can say
// about who is on the other side is the relay client end *name*, which is a
// name and not an address, and must never be treated as one.

import { Duplex } from 'node:stream';
import { CLOSE } from '../surface/ws.mjs';

/**
 * Wrap a joined relay websocket as a duplex byte stream.
 *
 * Every write becomes one binary frame and every inbound frame becomes bytes:
 * what travels here is a TCP stream, so the text opcode is never used -- a
 * request body is not obliged to be valid UTF-8 and a text frame would put it
 * through validation it will not survive.
 *
 * @param {import('../surface/ws.mjs').WsConnection} ws
 * @param {{ clientEnd?: string|null, logger?: object }} [meta]
 * @returns {Duplex}
 */
export function wsDuplex(ws, { clientEnd = null, logger } = {}) {
  let readableEnded = false;

  const duplex = new Duplex({
    // When the peer's half of the stream ends, ours must end too. An http
    // server that kept writing a response into a stream whose reader is gone
    // would hold the pairing open forever.
    allowHalfOpen: false,

    // No inbound flow control: this repo's websocket endpoint delivers whole
    // messages and has no pause. Backpressure upward is therefore advisory --
    // what actually bounds memory is the endpoint's own message and queue caps,
    // which close the socket rather than buffer past them.
    read() {},

    write(chunk, encoding, cb) {
      if (!ws.open) return cb(new Error('the relay stream is closed'));
      try {
        ws.send(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
        return cb();
      } catch (err) {
        return cb(err);
      }
    },

    final(cb) {
      try {
        ws.close(CLOSE.normal, 'stream ended');
      } catch {
        /* already down */
      }
      cb();
    },

    destroy(err, cb) {
      try {
        ws.close(err ? CLOSE.internalError : CLOSE.normal, err ? 'stream failed' : 'stream closed');
      } catch {
        /* already down */
      }
      cb(err);
    },
  });

  ws.onMessage((data) => {
    // A text frame is still bytes to us. Re-encoding is the only thing that
    // can be done with it and it round-trips exactly, so nothing is lost.
    duplex.push(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  });

  ws.onClose((code, reason) => {
    logger?.debug?.('relay.stream_closed', { clientEnd, code, reason });
    if (readableEnded) return;
    readableEnded = true;
    // EOF upward. allowHalfOpen:false then finishes the writable side, so the
    // http server sees a socket that is simply over.
    duplex.push(null);
  });

  // The net.Socket surface Node's http server and this repo's websocket code
  // reach for. Each one is a deliberate no-op rather than a missing method,
  // because the alternative is a TypeError deep inside a request.
  Object.assign(duplex, {
    setNoDelay() { return duplex; },
    setKeepAlive() { return duplex; },
    setTimeout(ms, cb) {
      if (cb) duplex.once('timeout', cb);
      return duplex;
    },
    ref() { return duplex; },
    unref() { return duplex; },
    address() { return {}; },
    destroySoon() { duplex.end(); },
    // Stated, not omitted: there is no address behind a relayed socket. Code
    // that needs a peer identity must ask for the client end name and know
    // that it is a name.
    remoteAddress: undefined,
    remotePort: undefined,
    localAddress: undefined,
    localPort: undefined,
    // The relay hop may well have been TLS. This process cannot know, so it
    // does not claim to: `false` here means "not encrypted *by me*".
    encrypted: false,
    relayClientEnd: clientEnd,
  });

  return duplex;
}
