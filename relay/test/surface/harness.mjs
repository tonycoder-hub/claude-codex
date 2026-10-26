// Test scaffolding for the surface: an echo websocket server, a raw-socket
// client that can emit frames no compliant library would, a fake upstream, and
// a logger that remembers everything so tests can assert on what was *not*
// logged.
//
// The raw client deliberately does its own framing rather than reusing
// src/surface/ws.mjs, so the frame tests are checking the implementation
// against an independent reader instead of against itself. Node 22's global
// WebSocket covers the same ground from a third direction.

import { createServer } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { acceptUpgrade } from '../../src/surface/ws.mjs';
import { createSurface } from '../../src/surface/server.mjs';
import { SessionManager } from '../../src/auth/session.mjs';
import { KeyRing, FileKeyStore } from '../../src/auth/keys.mjs';

/** Poll until `predicate` returns something truthy, or give up loudly. */
export async function waitFor(predicate, { timeoutMs = 3000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((res) => setTimeout(res, 5));
  }
}

/** A SessionManager over a throwaway keyring, as test/auth does it. */
export function freshSessions(opts) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-surface-'));
  return new SessionManager(new KeyRing(new FileKeyStore(join(dir, 'keyring.json'))), opts);
}

export function tempDir(prefix = 'relay-surface-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Collects structured log records so a test can assert on their contents. */
export function collectLogger() {
  const records = [];
  const push = (level) => (event, fields = {}) => records.push({ level, event, ...fields });
  return {
    records,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    text: () => JSON.stringify(records),
  };
}

const listening = (server) => new Promise((res, rej) => {
  server.once('error', rej);
  server.listen(0, '127.0.0.1', () => res(server.address().port));
});

/**
 * An http server whose websocket endpoint echoes every message back. No auth,
 * no relay -- this is for exercising src/surface/ws.mjs on its own.
 */
export async function startEchoWs(wsOptions = {}) {
  const server = createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  const events = [];
  const open = new Set();
  const sockets = new Set();
  server.on('upgrade', (req, socket, head) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    const ws = acceptUpgrade(req, socket, head, {
      onError: (err, where) => events.push({ type: 'error', where, message: err.message }),
      ...wsOptions,
    });
    if (!ws) return;
    open.add(ws);
    ws.onMessage((data, binary) => {
      events.push({ type: 'message', data, binary });
      ws.send(data);
    });
    ws.onClose((code, reason) => {
      events.push({ type: 'close', code, reason });
      open.delete(ws);
    });
  });
  const port = await listening(server);
  return {
    port,
    events,
    last: () => [...open].at(-1),
    closes: () => events.filter((e) => e.type === 'close'),
    // An upgraded socket is no longer the http server's to close: neither
    // close() nor closeAllConnections() will touch it, so a raw test client
    // that never answers our close frame would keep teardown waiting forever.
    // Send the close frame, give it a moment to land, then hang up by hand.
    close: () => new Promise((res) => {
      for (const ws of open) ws.close(1001, 'test over');
      setTimeout(() => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => res());
      }, 25);
    }),
  };
}

/** Build a client frame by hand. `mask: false` produces a frame the RFC forbids. */
export function clientFrame(opcode, payload = Buffer.alloc(0), { fin = true, mask = true, force64 = false } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = body.length;
  const extra = force64 ? 8 : len < 126 ? 0 : len < 65536 ? 2 : 8;
  const header = Buffer.alloc(2 + extra + (mask ? 4 : 0));
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] = (mask ? 0x80 : 0) | (extra === 0 ? len : extra === 2 ? 126 : 127);
  if (extra === 2) header.writeUInt16BE(len, 2);
  if (extra === 8) header.writeBigUInt64BE(BigInt(len), 2);
  if (!mask) return Buffer.concat([header, body]);
  const key = randomBytes(4);
  key.copy(header, 2 + extra);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = body[i] ^ key[i & 3];
  return Buffer.concat([header, out]);
}

export function closeFrameBody(code, reason = '') {
  const text = Buffer.from(reason, 'utf8');
  const body = Buffer.alloc(2 + text.length);
  body.writeUInt16BE(code, 0);
  text.copy(body, 2);
  return body;
}

/** An independent reader for the unmasked frames a server sends. */
function frameSink(socket, head) {
  let buf = head ?? Buffer.alloc(0);
  const ready = [];
  const waiting = [];
  let dead = null;

  const settle = () => {
    while (ready.length && waiting.length) waiting.shift().res(ready.shift());
    if (dead) while (waiting.length) waiting.shift().rej(dead);
  };

  const parse = () => {
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      if ((buf[1] & 0x80) !== 0) { dead = new Error('server sent a masked frame'); return; }
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      ready.push({ fin, opcode, payload: Buffer.from(buf.subarray(off, off + len)), lengthBytes: off - 2 });
      buf = buf.subarray(off + len);
    }
  };

  socket.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); parse(); settle(); });
  socket.on('close', () => { dead ??= new Error('socket closed'); settle(); });
  socket.on('error', (err) => { dead ??= err; settle(); });
  parse();

  return (timeoutMs = 3000) => new Promise((res, rej) => {
    if (ready.length) return res(ready.shift());
    if (dead) return rej(dead);
    const timer = setTimeout(() => rej(new Error('timed out waiting for a server frame')), timeoutMs);
    waiting.push({
      res: (frame) => { clearTimeout(timer); res(frame); },
      rej: (err) => { clearTimeout(timer); rej(err); },
    });
  });
}

/**
 * Perform (or deliberately botch) a handshake over a raw socket.
 * Resolves `{ status, headers, nextFrame, socket }`; on a refused upgrade the
 * HTTP status is what the test is after and `nextFrame` is never used.
 */
export function rawHandshake(port, { path = '/ws', headers = {}, key = randomBytes(16).toString('base64') } = {}) {
  return new Promise((res, rej) => {
    const socket = connect({ host: '127.0.0.1', port });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); rej(new Error('handshake timed out')); }, 3000);
    socket.on('error', (err) => { clearTimeout(timer); rej(err); });
    socket.on('data', function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      const lines = buf.subarray(0, end).toString('latin1').split('\r\n');
      const parsed = Object.create(null);
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) parsed[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      res({
        status: Number(lines[0].split(' ')[1]),
        statusLine: lines[0],
        headers: parsed,
        socket,
        key,
        nextFrame: frameSink(socket, buf.subarray(end + 4)),
      });
    });
    const base = {
      Host: `127.0.0.1:${port}`,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
      ...headers,
    };
    const request = [`GET ${path} HTTP/1.1`]
      .concat(Object.entries(base).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`))
      .concat(['', ''])
      .join('\r\n');
    socket.write(request);
  });
}

/** Node 22's global WebSocket, with the extras tests need. */
export function browserClient(port, { path = '/ws', cookie = null } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, cookie ? { headers: { Cookie: cookie } } : undefined);
  const messages = [];
  const waiting = [];
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('message', (event) => {
    const value = typeof event.data === 'string' ? event.data : Buffer.from(event.data);
    if (waiting.length) waiting.shift()(value); else messages.push(value);
  });
  const opened = new Promise((res, rej) => {
    ws.addEventListener('open', () => res(ws));
    ws.addEventListener('error', () => rej(new Error('websocket failed to open')));
    ws.addEventListener('close', (event) => rej(Object.assign(new Error(`closed before open: ${event.code}`), { code: event.code })));
  });
  const closed = new Promise((res) => {
    ws.addEventListener('close', (event) => res({ code: event.code, reason: event.reason }));
  });
  return {
    ws,
    opened,
    closed,
    send: (data) => ws.send(data),
    next: (timeoutMs = 3000) => (messages.length ? Promise.resolve(messages.shift()) : new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('timed out waiting for a message')), timeoutMs);
      waiting.push((value) => { clearTimeout(timer); res(value); });
    })),
  };
}

/**
 * A fake app-server connection: the same four-verb shape the real upstream
 * exposes, plus hooks so a test can speak as the upstream and kill it.
 */
export function fakeUpstream({ onSend } = {}) {
  const received = [];
  const messageHandlers = [];
  const closeHandlers = [];
  let closed = false;
  const api = {
    received,
    get closed() { return closed; },
    closedWith: null,
    send(data) {
      if (closed) throw new Error('upstream is closed');
      received.push(data);
      onSend?.(data, api);
      return true;
    },
    close(code = 1000, reason = '') {
      if (closed) return;
      closed = true;
      api.closedWith = { code, reason };
      for (const cb of closeHandlers) cb(code, reason);
    },
    onMessage(cb) { messageHandlers.push(cb); return api; },
    onClose(cb) { closeHandlers.push(cb); return api; },
    /** Speak as the upstream. */
    push(data) { for (const cb of messageHandlers) cb(data, typeof data !== 'string'); },
    /** Die the way a crashed app-server dies: abnormally, with no close frame. */
    kill(code = 1006, reason = 'upstream died') { api.close(code, reason); },
  };
  return api;
}

/** A surface on an ephemeral port, with the upstreams a test hands it. */
export async function startSurface(options = {}) {
  const logger = options.logger ?? collectLogger();
  const surface = createSurface({ port: 0, host: '127.0.0.1', logger, ...options });
  const address = await surface.listen();
  return { surface, logger, port: address.port, close: () => surface.close() };
}
