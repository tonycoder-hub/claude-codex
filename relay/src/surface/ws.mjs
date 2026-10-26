// A small RFC 6455 endpoint over a raw socket, because Node ships a WebSocket
// *client* and no server, and this repo stays dependency-free.
//
// The scope is deliberate: the common path has to be exactly right (handshake,
// masking, fragmentation, the three control frames, 7/16/64-bit lengths), and
// everything else has to be *refused cleanly* rather than half-handled. A
// hostile client must not be able to make this allocate on its say-so, so every
// cheap check -- reserved bits, opcode, mask presence, declared length against
// the caps -- happens on the frame header, before a single payload byte is
// waited for. That ordering is the whole anti-DoS story: a client claiming a
// 10 GiB payload is closed on its first 10 bytes, so the read buffer can never
// hold more than one capped frame plus a header.
//
// One class serves both directions. A server endpoint sends unmasked frames and
// requires masked ones; a client endpoint does the reverse. That symmetry is
// what lets the surface relay upstream over the same code the browser talks to,
// rather than carrying two framing implementations that drift apart.
//
// Not implemented, on purpose: permessage-deflate and every other extension
// (RSV bits are therefore a protocol error, which is correct when nothing was
// negotiated), subprotocol selection, and per-frame streaming of partial
// payloads to the caller. See the notes in the surface README-less report.

import { createHash, randomBytes } from 'node:crypto';

/**
 * The magic constant from RFC 6455 section 1.3. Worth a test of its own (and it
 * has one): a single wrong character here produces a handshake that this
 * implementation happily agrees with itself about and every real client
 * rejects, which is a miserable thing to debug from a phone.
 */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
};

export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  unsupportedData: 1003,
  noStatus: 1005,
  abnormal: 1006,
  invalidPayload: 1007,
  policyViolation: 1008,
  tooBig: 1009,
  internalError: 1011,
};

const EMPTY = Buffer.alloc(0);
const MAX_CONTROL_PAYLOAD = 125;
const utf8 = new TextDecoder('utf-8', { fatal: true });

const DEFAULT_LIMITS = {
  // 4 MiB is comfortably above any JSON-RPC frame the app-server sends and well
  // below "one client can exhaust the box".
  maxMessageBytes: 4 * 1024 * 1024,
  maxFrameBytes: 4 * 1024 * 1024,
  maxQueueBytes: 8 * 1024 * 1024,
  closeTimeoutMs: 5_000,
};

export class UpgradeError extends Error {
  constructor(message, { status = 400 } = {}) {
    super(message);
    this.name = 'UpgradeError';
    this.status = status;
  }
}

/** The Sec-WebSocket-Accept value for a given Sec-WebSocket-Key. */
export function acceptValue(key) {
  return createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}

/**
 * Validate an upgrade request and return the accept value, or throw
 * UpgradeError carrying the HTTP status the caller should answer with.
 */
export function handshakeAccept(req) {
  if (req.method !== 'GET') {
    throw new UpgradeError('a websocket upgrade must be a GET', { status: 405 });
  }
  if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
    throw new UpgradeError('Upgrade header must be "websocket"', { status: 400 });
  }
  // Connection is a comma-separated token list; "keep-alive, Upgrade" is legal.
  const connection = String(req.headers.connection ?? '').toLowerCase();
  if (!connection.split(',').some((token) => token.trim() === 'upgrade')) {
    throw new UpgradeError('Connection header must contain the "Upgrade" token', { status: 400 });
  }
  if (String(req.headers['sec-websocket-version'] ?? '').trim() !== '13') {
    // 426 is the status the RFC asks for, and the response must advertise what
    // we do speak so a client can retry correctly.
    throw new UpgradeError('only websocket version 13 is supported', { status: 426 });
  }
  const key = String(req.headers['sec-websocket-key'] ?? '').trim();
  // The key is 16 random bytes, base64. Checking that it round-trips rejects
  // both the wrong length and a non-canonical encoding, which is what a
  // confused (or probing) client sends.
  const decoded = Buffer.from(key, 'base64');
  if (decoded.length !== 16 || decoded.toString('base64') !== key) {
    throw new UpgradeError('missing or malformed Sec-WebSocket-Key', { status: 400 });
  }
  return acceptValue(key);
}

const STATUS_TEXT = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  426: 'Upgrade Required',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/**
 * Answer a rejected upgrade with a real HTTP response. A dangling socket leaves
 * the client waiting on a handshake that will never arrive, which is the most
 * annoying possible failure to debug from a phone.
 */
export function refuseUpgrade(socket, status = 400, message = 'bad request') {
  if (!socket || socket.destroyed) return;
  const body = `${message}\n`;
  const headers = [
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Bad Request'}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
  ];
  if (status === 426) headers.push('Sec-WebSocket-Version: 13');
  try {
    // Destroy once the response has flushed: a refused client that never
    // closes its end would otherwise leave a half-open socket behind, and an
    // upgrade socket is not one the http server will clean up for us.
    socket.end(`${headers.join('\r\n')}\r\n\r\n${body}`, () => socket.destroy());
  } catch {
    socket.destroy();
  }
}

/**
 * Complete a server-side handshake. Returns a WsConnection, or null after
 * having answered the socket with an HTTP error -- so a caller's `upgrade`
 * handler is `const ws = acceptUpgrade(...); if (!ws) return;`.
 */
export function acceptUpgrade(req, socket, head, options = {}) {
  let accept;
  try {
    accept = handshakeAccept(req);
  } catch (err) {
    if (!(err instanceof UpgradeError)) throw err;
    refuseUpgrade(socket, err.status, err.message);
    return null;
  }
  socket.setNoDelay(true);
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', '',
  ].join('\r\n'));
  return new WsConnection(socket, { ...options, role: 'server', head });
}

/** Close codes an endpoint may put on the wire (RFC 6455 section 7.4). */
export function isSendableCloseCode(code) {
  if (!Number.isInteger(code)) return false;
  if (code >= 3000 && code <= 4999) return true;
  return code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006;
}

/** Serialise one frame. `mask` is set by client endpoints only. */
export function encodeFrame(opcode, payload = EMPTY, mask = false) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = body.length;
  const extra = len < 126 ? 0 : len < 65536 ? 2 : 8;
  const header = Buffer.allocUnsafe(2 + extra + (mask ? 4 : 0));
  header[0] = 0x80 | opcode; // FIN: this implementation never fragments its output
  header[1] = (mask ? 0x80 : 0) | (extra === 0 ? len : extra === 2 ? 126 : 127);
  if (extra === 2) header.writeUInt16BE(len, 2);
  else if (extra === 8) {
    header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
    header.writeUInt32BE(len % 2 ** 32, 6);
  }
  if (!mask) return Buffer.concat([header, body]);
  const key = randomBytes(4);
  key.copy(header, 2 + extra);
  const out = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) out[i] = body[i] ^ key[i & 3];
  return Buffer.concat([header, out]);
}

function closePayload(code, reason) {
  const text = Buffer.from(String(reason ?? ''), 'utf8');
  // The whole control payload is capped at 125 bytes, two of which are the code.
  const body = Buffer.allocUnsafe(2 + Math.min(text.length, MAX_CONTROL_PAYLOAD - 2));
  body.writeUInt16BE(code, 0);
  text.copy(body, 2, 0, body.length - 2);
  return body;
}

/**
 * One WebSocket connection. The surface only needs four verbs, so that is what
 * this exposes: `send`, `close`, `onMessage`, `onClose`.
 */
export class WsConnection {
  #socket;
  #masked;       // do our outbound frames carry a mask?
  #expectMask;   // must inbound frames carry one?
  #limits;
  #onError;

  #buf = EMPTY;
  #state = 'open'; // open -> closing -> closed
  #queued = 0;
  #closeTimer = null;
  #localClose = null; // the close we sent, if we were the one to start it

  #fragmentOpcode = null;
  #fragments = [];
  #fragmentBytes = 0;

  #messageHandlers = [];
  #closeHandlers = [];
  #deferred = null; // bytes read before the caller could register handlers

  constructor(socket, { role = 'server', head, onError, ...limits } = {}) {
    this.#socket = socket;
    this.#masked = role === 'client';
    this.#expectMask = role === 'server';
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
    this.#onError = onError ?? (() => {});

    socket.on('data', (chunk) => this.#feed(chunk));
    socket.on('drain', () => { if (this.#state === 'open') socket.resume(); });
    socket.on('error', (err) => {
      this.#onError(err, 'socket');
      this.#finish(CLOSE.abnormal, 'socket error');
    });
    socket.on('end', () => this.#finish(CLOSE.abnormal, 'peer closed the socket'));
    socket.on('close', () => this.#finish(CLOSE.abnormal, 'socket closed'));

    // A peer may speak in the same packet as the handshake. A client whose
    // protocol opens with a request rather than a greeting always does, and a
    // relay replaying a backlog onto a freshly paired socket does it on
    // purpose. Dispatching those bytes from inside this constructor would run
    // the message handlers before the caller holding the half-built
    // connection has had a single line in which to register one, so the first
    // message -- the `initialize`, the one that matters -- would vanish with
    // nothing anywhere to show for it. Pre-read bytes therefore wait one turn
    // of the loop (past the microtask that resolves an awaited handshake),
    // and whatever the socket delivers meanwhile queues behind them so the
    // stream still arrives in order.
    if (head && head.length) {
      this.#deferred = [head];
      setImmediate(() => this.#flushDeferred());
    }
  }

  get closed() { return this.#state === 'closed'; }
  /**
   * Is this endpoint still able to carry a message? Narrower than `!closed`,
   * which stays true all the way through a closing handshake. A caller that
   * must decide whether a *peer* is reachable right now -- the relay asking
   * whether an end is still there to be dialled -- needs the narrow question.
   */
  get open() { return this.#state === 'open'; }
  /** Bytes handed to the kernel but not yet flushed -- the backpressure gauge. */
  get bytesQueued() { return this.#queued; }

  onMessage(cb) { this.#messageHandlers.push(cb); return this; }
  onClose(cb) { this.#closeHandlers.push(cb); return this; }

  /** Send a text frame for a string, a binary frame for bytes. */
  send(data) {
    if (this.#state !== 'open') return false;
    const binary = typeof data !== 'string';
    const payload = binary ? Buffer.from(data) : Buffer.from(data, 'utf8');
    if (payload.length > this.#limits.maxMessageBytes) {
      this.#fail(CLOSE.tooBig, 'message exceeds the message cap');
      return false;
    }
    return this.#write(binary ? OPCODE.binary : OPCODE.text, payload);
  }

  ping(payload = EMPTY) {
    if (this.#state !== 'open') return false;
    return this.#write(OPCODE.ping, Buffer.from(payload).subarray(0, MAX_CONTROL_PAYLOAD));
  }

  /**
   * Start a closing handshake. The socket is half-closed so the peer sees EOF
   * even if it never echoes, and a timer destroys it if the echo never comes.
   */
  close(code = CLOSE.normal, reason = '') {
    if (this.#state !== 'open') return;
    this.#state = 'closing';
    const safe = isSendableCloseCode(code) ? code : CLOSE.internalError;
    this.#localClose = { code: safe, reason };
    this.#write(OPCODE.close, closePayload(safe, reason));
    try { this.#socket.end(); } catch { /* already gone */ }
    // A peer that never echoes does not get to keep the socket. Report our own
    // code when that happens: "we hung up because the frame was malformed" is
    // the useful fact, and 1006 would throw it away.
    this.#closeTimer = setTimeout(() => this.#finish(safe, reason), this.#limits.closeTimeoutMs);
    this.#closeTimer.unref();
  }

  #write(opcode, payload) {
    if (this.#socket.destroyed) return false;
    const frame = encodeFrame(opcode, payload, this.#masked);
    // Control frames bypass the queue cap: they are <= 127 bytes and refusing
    // to send a close frame because the queue is full would be perverse.
    if (opcode < 0x8 && this.#queued + frame.length > this.#limits.maxQueueBytes) {
      this.#fail(CLOSE.tooBig, 'outbound queue exceeds the byte cap');
      return false;
    }
    this.#queued += frame.length;
    const flushed = this.#socket.write(frame, () => { this.#queued -= frame.length; });
    // Real backpressure: stop reading while our own output is congested, so a
    // ping flood cannot outrun the socket we are writing pongs to.
    if (!flushed) this.#socket.pause();
    return flushed;
  }

  #feed(chunk) {
    // Pre-read bytes are still waiting their turn: queue behind them rather
    // than overtaking them.
    if (this.#deferred !== null) {
      this.#deferred.push(chunk);
      return;
    }
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    try {
      this.#parse();
    } catch (err) {
      this.#onError(err, 'parse');
      this.#fail(CLOSE.internalError, 'frame parser failed');
    }
  }

  #flushDeferred() {
    const chunks = this.#deferred;
    this.#deferred = null;
    if (chunks === null) return;
    // One turn of the loop is all the caller gets. If it still has not
    // registered a handler, these frames are about to be parsed and dispatched
    // to nobody -- which is the exact loss this deferral exists to prevent,
    // just moved one tick later. Report it instead of letting it vanish: a
    // caller that awaits real I/O before calling onMessage lands here, and the
    // fix is always to register synchronously after the handshake.
    if (this.#messageHandlers.length === 0 && this.#state !== 'closed') {
      this.#onError(
        new Error('pre-read frames arrived before any message handler was registered'),
        'deferred',
      );
    }
    for (const chunk of chunks) {
      if (this.#state === 'closed') return;
      this.#feed(chunk);
    }
  }

  #parse() {
    for (;;) {
      if (this.#state === 'closed') return;
      const b = this.#buf;
      if (b.length < 2) return;

      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const high = b.readUInt32BE(2);
        // The RFC reserves the most significant bit of a 64-bit length.
        if (high & 0x8000_0000) return this.#fail(CLOSE.protocolError, 'payload length has the reserved bit set');
        len = high * 2 ** 32 + b.readUInt32BE(6);
        if (!Number.isSafeInteger(len)) return this.#fail(CLOSE.tooBig, 'payload length is beyond a safe integer');
        offset = 10;
      }

      // Everything below is decided from the header alone, so an absurd
      // declared length never costs us a buffer.
      if ((b[0] & 0x70) !== 0) return this.#fail(CLOSE.protocolError, 'reserved bits must be zero');
      if (opcode > 0x2 && opcode < 0x8) return this.#fail(CLOSE.protocolError, `reserved opcode 0x${opcode.toString(16)}`);
      if (opcode > 0xa) return this.#fail(CLOSE.protocolError, `reserved opcode 0x${opcode.toString(16)}`);
      if (masked !== this.#expectMask) {
        return this.#fail(
          CLOSE.protocolError,
          this.#expectMask ? 'client frames must be masked' : 'server frames must not be masked',
        );
      }
      if (opcode >= 0x8) {
        if (!fin) return this.#fail(CLOSE.protocolError, 'control frames must not be fragmented');
        if (len > MAX_CONTROL_PAYLOAD) return this.#fail(CLOSE.protocolError, 'control frame payload too long');
      } else {
        if (len > this.#limits.maxFrameBytes) return this.#fail(CLOSE.tooBig, 'frame exceeds the frame cap');
        if (this.#fragmentBytes + len > this.#limits.maxMessageBytes) {
          return this.#fail(CLOSE.tooBig, 'message exceeds the message cap');
        }
      }

      const total = offset + (masked ? 4 : 0) + len;
      if (b.length < total) return; // bounded: len is already capped above

      let payload;
      if (masked) {
        const key = b.subarray(offset, offset + 4);
        payload = Buffer.allocUnsafe(len);
        const start = offset + 4;
        for (let i = 0; i < len; i++) payload[i] = b[start + i] ^ key[i & 3];
      } else {
        payload = Buffer.from(b.subarray(offset, offset + len)); // copy: b gets sliced away
      }
      this.#buf = b.subarray(total);

      if (!this.#handle(fin, opcode, payload)) return;
    }
  }

  /** Returns false when the connection has been torn down mid-stream. */
  #handle(fin, opcode, payload) {
    if (opcode === OPCODE.close) { this.#receiveClose(payload); return false; }
    if (opcode === OPCODE.ping) { this.#write(OPCODE.pong, payload); return this.#state === 'open'; }
    if (opcode === OPCODE.pong) return true;

    if (opcode === OPCODE.continuation) {
      if (this.#fragmentOpcode === null) {
        this.#fail(CLOSE.protocolError, 'continuation frame without a started message');
        return false;
      }
      this.#fragments.push(payload);
      this.#fragmentBytes += payload.length;
      if (!fin) return true;
      const opener = this.#fragmentOpcode;
      const full = Buffer.concat(this.#fragments);
      this.#fragmentOpcode = null;
      this.#fragments = [];
      this.#fragmentBytes = 0;
      return this.#deliver(opener, full);
    }

    if (this.#fragmentOpcode !== null) {
      this.#fail(CLOSE.protocolError, 'data frame arrived inside a fragmented message');
      return false;
    }
    if (fin) return this.#deliver(opcode, payload);
    this.#fragmentOpcode = opcode;
    this.#fragments = [payload];
    this.#fragmentBytes = payload.length;
    return true;
  }

  #deliver(opcode, payload) {
    let message = payload;
    if (opcode === OPCODE.text) {
      try {
        message = utf8.decode(payload);
      } catch {
        // 1007 exists for exactly this: well-framed, wrongly-encoded.
        this.#fail(CLOSE.invalidPayload, 'text frame is not valid UTF-8');
        return false;
      }
    }
    for (const cb of this.#messageHandlers) {
      try {
        cb(message, opcode === OPCODE.binary);
      } catch (err) {
        // A throwing application handler must not kill the read loop, and must
        // certainly not take the process with it.
        this.#onError(err, 'onMessage');
      }
    }
    return this.#state === 'open';
  }

  #receiveClose(payload) {
    let code = CLOSE.noStatus;
    let reason = '';
    if (payload.length === 1) {
      this.#fail(CLOSE.protocolError, 'close payload must be empty or at least two bytes');
      return;
    }
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (!isSendableCloseCode(code) && code !== 1015) {
        this.#fail(CLOSE.protocolError, `close frame carries reserved code ${code}`);
        return;
      }
      try {
        reason = utf8.decode(payload.subarray(2));
      } catch {
        this.#fail(CLOSE.invalidPayload, 'close reason is not valid UTF-8');
        return;
      }
    }
    if (this.#state === 'open') {
      // Echo the handshake back before hanging up, as the RFC requires.
      this.#state = 'closing';
      this.#write(OPCODE.close, closePayload(code === CLOSE.noStatus ? CLOSE.normal : code, ''));
      try { this.#socket.end(); } catch { /* already gone */ }
    }
    this.#finish(code, reason);
  }

  #fail(code, reason) {
    this.#onError(new Error(`websocket protocol failure: ${reason}`), 'protocol');
    this.close(code, reason);
    return false;
  }

  #finish(code, reason) {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    // If we started the handshake and the peer dropped the socket instead of
    // answering, the close we sent is still the real explanation.
    if (code === CLOSE.abnormal && this.#localClose) {
      code = this.#localClose.code;
      reason = this.#localClose.reason;
    }
    if (this.#closeTimer) { clearTimeout(this.#closeTimer); this.#closeTimer = null; }
    this.#buf = EMPTY;
    this.#fragments = [];
    this.#fragmentBytes = 0;

    // Let the socket go, but only once whatever we last wrote (a close frame,
    // usually) has actually flushed. This matters more than it looks: a socket
    // handed over by an http `upgrade` is no longer tracked by that server, so
    // closeAllConnections() will not touch it, and a half-open one lingers
    // forever -- holding the process alive and a graceful shutdown open.
    const socket = this.#socket;
    if (!socket.destroyed) {
      const destroy = () => socket.destroy();
      socket.end();
      if (socket.writableFinished) destroy();
      else socket.once('finish', destroy);
      const linger = setTimeout(destroy, 1_000);
      linger.unref();
    }
    for (const cb of this.#closeHandlers) {
      try {
        cb(code, reason);
      } catch (err) {
        this.#onError(err, 'onClose');
      }
    }
  }
}
