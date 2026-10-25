// A transport over a client WebSocket, using the global `WebSocket` -- built in
// since Node 18 and universal in browsers. Nothing is imported, which is the
// point: the same file runs on the phone and on the relay host.
//
// WebSocket is message-framed, so this transport does NOT use NDJSON. One JSON
// object per text message, no trailing newline. Sending a newline-framed batch
// over a WebSocket would work by accident with most peers and break the moment
// one of them parsed strictly, so it is not done.
//
// The queue exists because `new WebSocket(url)` returns in CONNECTING, and the
// natural thing to write is `client.call('initialize')` on the very next line.
// Without a queue that call would throw InvalidStateError; with one it lands as
// soon as the handshake finishes. Once the socket is closing or closed the queue
// stops helping and sends are dropped -- a closed pipe has no "later" to flush
// into, and the client's own close handling is what tells callers the truth.

/** The numeric readyState values, so this file does not depend on the class statics. */
const CONNECTING = 0;
const OPEN = 1;

function resolveWebSocket(target, protocols) {
  if (typeof target === 'object' && target !== null && typeof target.send === 'function') {
    return target; // an already-constructed socket (or a test double)
  }
  if (typeof target !== 'string' && !(typeof URL === 'function' && target instanceof URL)) {
    throw new TypeError('createWebSocketTransport needs a URL or a WebSocket');
  }
  const Ctor = globalThis.WebSocket;
  if (typeof Ctor !== 'function') {
    throw new TypeError('no global WebSocket is available; pass a socket instead of a URL');
  }
  return protocols === undefined ? new Ctor(String(target)) : new Ctor(String(target), protocols);
}

/** Pull a text payload out of whatever the platform handed us. */
function messageText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return null;
}

/**
 * @param {string|URL|WebSocket} target A URL to connect to, or a socket to wrap.
 * @param {object} [options]
 * @param {string|string[]} [options.protocols] Subprotocols, when given a URL.
 * @param {(error: Error) => void} [options.onError] Parse failures, unexpected
 *   frame types, and socket errors.
 * @returns {{ send: Function, onMessage: Function, onClose: Function, close: Function, socket: WebSocket }}
 */
export function createWebSocketTransport(target, { protocols, onError = null } = {}) {
  const socket = resolveWebSocket(target, protocols);

  let messageHandler = null;
  let closeHandler = null;
  const inboxBacklog = [];
  const outboxQueue = [];
  let closed = false;

  const report = (error) => {
    if (!onError) return;
    try {
      onError(error);
    } catch {
      /* ignored on purpose */
    }
  };

  // The protocol is text-only. Asking for ArrayBuffer keeps a browser from
  // handing us a Blob, whose async `.text()` would reorder messages.
  try {
    socket.binaryType = 'arraybuffer';
  } catch {
    /* read-only on some implementations; messageText copes either way */
  }

  const flushOutbox = () => {
    while (outboxQueue.length > 0 && socket.readyState === OPEN) {
      const text = outboxQueue.shift();
      try {
        socket.send(text);
      } catch (error) {
        report(error);
        return;
      }
    }
    // Anything still queued when the socket is no longer openable is undeliverable.
    if (socket.readyState !== CONNECTING && socket.readyState !== OPEN) outboxQueue.length = 0;
  };

  const fireClose = () => {
    if (closed) return;
    closed = true;
    outboxQueue.length = 0;
    if (closeHandler) closeHandler();
  };

  socket.addEventListener('open', flushOutbox);
  socket.addEventListener('message', (event) => {
    const text = messageText(event?.data);
    if (text === null) {
      report(new TypeError(`unsupported WebSocket frame type: ${Object.prototype.toString.call(event?.data)}`));
      return;
    }
    if (text.trim() === '') return; // some peers ping with an empty frame
    let value;
    try {
      value = JSON.parse(text);
    } catch (cause) {
      report(new SyntaxError(`WebSocket message is not valid JSON: ${cause.message}`));
      return;
    }
    if (messageHandler) messageHandler(value);
    else inboxBacklog.push(value);
  });
  // A browser's error event carries no detail by design; it is still worth
  // surfacing that something went wrong, and `close` always follows.
  socket.addEventListener('error', () => report(new Error('the WebSocket reported an error')));
  socket.addEventListener('close', fireClose);

  return {
    send(message) {
      if (closed) return;
      let text;
      try {
        text = JSON.stringify(message);
      } catch (error) {
        report(error);
        return;
      }
      if (text === undefined) {
        report(new TypeError('message is not JSON-serialisable'));
        return;
      }
      if (socket.readyState === CONNECTING) {
        outboxQueue.push(text);
        return;
      }
      if (socket.readyState !== OPEN) return; // closing or closed: drop, do not throw
      try {
        socket.send(text);
      } catch (error) {
        // readyState can change between the check and the send.
        report(error);
      }
    },

    onMessage(callback) {
      if (typeof callback !== 'function') throw new TypeError('onMessage needs a callback');
      messageHandler = callback;
      while (inboxBacklog.length > 0) callback(inboxBacklog.shift());
    },

    onClose(callback) {
      if (typeof callback !== 'function') throw new TypeError('onClose needs a callback');
      closeHandler = callback;
      if (closed) callback();
    },

    close(code, reason) {
      try {
        if (socket.readyState === CONNECTING || socket.readyState === OPEN) {
          if (code === undefined) socket.close();
          else socket.close(code, reason);
        }
      } catch (error) {
        report(error);
      }
      // The close event will fire too; fireClose is idempotent, and firing now
      // means a caller who closes a never-opened socket is not left hanging.
      fireClose();
    },

    /** The underlying socket, for readyState checks and extra listeners. */
    socket,
  };
}
