// A transport over a Node byte stream: a child process's stdio, a unix socket,
// or a TCP socket. All three are the same thing once you have NDJSON framing,
// which is why there is one file rather than three.
//
// The one Node-only file in this directory. The client above it never imports
// it, so a browser build that only uses the WebSocket transport pulls none of
// this in.
//
// Two behaviours that look like paranoia and are not:
//
//   * Inbound messages are queued until `onMessage` is registered. A socket can
//     deliver data in the same tick it connects, and `createStdioTransport(sock)`
//     has to attach its `data` listener immediately or lose bytes -- so there is
//     necessarily a window before the client is constructed.
//   * `send` swallows EPIPE and friends. Writing to a stream whose far end just
//     went away throws synchronously, and an app-server peer disconnecting is a
//     routine event, not a reason to take down whatever happened to be sending.

import { NdjsonDecoder, encodeNdjson } from './ndjson.mjs';

/** Errors that just mean "the other end is gone". Dropping the write is correct. */
const DISCONNECT_CODES = new Set(['EPIPE', 'ECONNRESET', 'EBADF', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);

function isDisconnect(error) {
  return DISCONNECT_CODES.has(error?.code);
}

/**
 * Work out which stream to read and which to write.
 *
 * Note the order: a `net.Socket` has boolean `readable`/`writable` properties,
 * so the "pair of streams" check has to come after the duplex check or a socket
 * would be mistaken for `{ readable: true, writable: true }`.
 */
function resolveStreams(source) {
  if (!source || typeof source !== 'object') {
    throw new TypeError('createStdioTransport needs a stream, a stream pair, or a child process');
  }
  if (typeof source.write === 'function' && typeof source.on === 'function') {
    return { readable: source, writable: source }; // a duplex: socket, PTY, ...
  }
  // A ChildProcess (or `process` itself): read its stdout, write its stdin.
  if (source.stdin && source.stdout) return { readable: source.stdout, writable: source.stdin };
  if (typeof source.readable === 'object' && typeof source.writable === 'object') {
    return { readable: source.readable, writable: source.writable };
  }
  throw new TypeError('createStdioTransport could not find a readable and a writable in its argument');
}

/**
 * @param {object} source A duplex stream, a `{ readable, writable }` pair, or a
 *   ChildProcess.
 * @param {object} [hooks]
 * @param {(error: Error) => void} [hooks.onError] Decode failures and stream
 *   errors. Disconnect-shaped errors are not reported: they are the close event.
 * @returns {{ send: Function, onMessage: Function, onClose: Function, close: Function }}
 */
export function createStdioTransport(source, { onError = null } = {}) {
  const { readable, writable } = resolveStreams(source);

  let messageHandler = null;
  let closeHandler = null;
  const inboxBacklog = [];
  let closed = false;

  const report = (error) => {
    if (!onError) return;
    try {
      onError(error);
    } catch {
      /* ignored on purpose */
    }
  };

  const deliver = (value) => {
    if (messageHandler) messageHandler(value);
    else inboxBacklog.push(value);
  };

  const decoder = new NdjsonDecoder({ onMessage: deliver, onError: report });

  const fireClose = () => {
    if (closed) return;
    closed = true;
    // A stream that ends mid-line still owes us that line.
    try {
      decoder.flush();
    } catch (error) {
      report(error);
    }
    if (closeHandler) closeHandler();
  };

  readable.on('data', (chunk) => {
    try {
      decoder.push(chunk);
    } catch (error) {
      report(error);
    }
  });
  readable.on('end', fireClose);
  readable.on('close', fireClose);
  readable.on('error', (error) => {
    if (!isDisconnect(error)) report(error);
    fireClose();
  });
  // A duplex whose write side dies is just as dead; for a stream pair the
  // writable is a separate object that can fail on its own.
  if (writable !== readable) {
    writable.on('close', fireClose);
    writable.on('error', (error) => {
      if (!isDisconnect(error)) report(error);
      fireClose();
    });
  }

  return {
    send(message) {
      if (closed || writable.destroyed || writable.writableEnded) return;
      let line;
      try {
        line = encodeNdjson(message);
      } catch (error) {
        report(error); // our own bug, not the peer's: never reaches the wire
        return;
      }
      try {
        writable.write(line);
      } catch (error) {
        if (!isDisconnect(error)) report(error);
      }
    },

    onMessage(callback) {
      if (typeof callback !== 'function') throw new TypeError('onMessage needs a callback');
      messageHandler = callback;
      // Hand over anything that arrived before the client was wired up.
      while (inboxBacklog.length > 0) callback(inboxBacklog.shift());
    },

    onClose(callback) {
      if (typeof callback !== 'function') throw new TypeError('onClose needs a callback');
      closeHandler = callback;
      if (closed) callback(); // already gone; do not leave the caller waiting
    },

    close() {
      // End the write side first so an already-buffered final message still
      // lands, and only tear the handle down once that flush completes --
      // destroying immediately after `end()` would discard it. `end`'s callback
      // is the no-timer way to sequence that.
      const release = () => {
        try {
          if (typeof readable.destroy === 'function') readable.destroy();
        } catch (error) {
          if (!isDisconnect(error)) report(error);
        }
      };
      try {
        if (typeof writable.end === 'function' && !writable.writableEnded) writable.end(release);
        else release();
      } catch (error) {
        if (!isDisconnect(error)) report(error);
        release();
      }
      fireClose();
    },
  };
}
