// Scaffolding for the relay tests.
//
// Every websocket role here -- end, client, dial-back -- is played by Node 22's
// global WebSocket rather than by this repo's own endpoint. That is the point:
// the relay claims wire compatibility with an implementation we do not have the
// sources to, so the tests check it against a third implementation instead of
// against itself. Where a test needs to see raw bytes (a refused upgrade has no
// websocket to speak through), it opens a socket and reads the status line.
//
// `waitFor` and the collecting logger are deliberately re-spelled here instead
// of imported from test/surface/harness.mjs: that module pulls in the whole
// surface, and a relay test should not fail because somebody is mid-edit in a
// file the relay does not use.

import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { createRelayServer } from '../../src/relay/server.mjs';
import { RELAY_PAIRING_HEADER, RELAY_TOKEN_HEADER, attachPath } from '../../src/relay/protocol.mjs';

/** An obvious fixture. Not a secret, and nothing here is deployed. */
export const TEST_TOKEN = 'test-relay-token-not-a-secret';

/** Poll until `predicate` returns something truthy, or give up loudly. */
export async function waitFor(predicate, { timeoutMs = 3000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((res) => setTimeout(res, 5));
  }
}

/** Remembers every record so a test can assert on what was *not* logged. */
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

/** A relay on an ephemeral port, torn down with the test. */
export async function startRelay(t, options = {}) {
  const logger = options.logger ?? collectLogger();
  const relay = createRelayServer({ port: 0, host: '127.0.0.1', shutdownGraceMs: 25, logger, ...options });
  const address = await relay.listen();
  t.after(() => relay.close());
  return { relay, logger, port: address.port };
}

// ---- http ----------------------------------------------------------------

/** One HTTP request against the relay. Resolves even for 4xx -- that is the subject. */
export function httpRequest(port, path, { method = 'GET', token = null } = {}) {
  return new Promise((res, rej) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: token === null ? {} : { [RELAY_TOKEN_HEADER]: token },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* a test may be asserting that it is not JSON */
          }
          res({ status: response.statusCode, headers: response.headers, text, json });
        });
      },
    );
    req.on('error', rej);
    req.end();
  });
}

/**
 * Start a websocket upgrade over a raw socket and resolve the first line the
 * relay answers with. The only way to see a refusal that is not a websocket.
 */
export function rawUpgrade(port, path, { token = null, pairing = null } = {}) {
  return new Promise((res, rej) => {
    const socket = connect({ host: '127.0.0.1', port });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      rej(new Error('the relay never answered the upgrade'));
    }, 3000);
    const finish = (value) => {
      clearTimeout(timer);
      socket.destroy();
      res(value);
    };
    socket.on('error', (err) => {
      clearTimeout(timer);
      rej(err);
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.includes('\r\n\r\n')) finish({ raw: buf.toString('latin1'), statusLine: buf.toString('latin1').split('\r\n')[0] });
    });
    // A server that destroys without answering is also a result worth seeing.
    socket.on('close', () => finish({ raw: buf.toString('latin1'), statusLine: buf.toString('latin1').split('\r\n')[0] }));
    socket.on('connect', () => {
      const headers = [`GET ${path} HTTP/1.1`, 'Host: 127.0.0.1', 'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${Buffer.alloc(16, 3).toString('base64')}`, 'Sec-WebSocket-Version: 13'];
      if (token !== null) headers.push(`${RELAY_TOKEN_HEADER}: ${token}`);
      if (pairing !== null) headers.push(`${RELAY_PAIRING_HEADER}: ${pairing}`);
      socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    });
  });
}

// ---- websocket roles -----------------------------------------------------

/** A websocket client over the platform implementation, with a queue. */
export function wsClient(t, url, { headers = {} } = {}) {
  const ws = new WebSocket(url, Object.keys(headers).length ? { headers } : undefined);
  ws.binaryType = 'arraybuffer';
  const messages = [];
  const waiting = [];
  ws.addEventListener('message', (event) => {
    const value = typeof event.data === 'string' ? event.data : Buffer.from(event.data);
    if (waiting.length) waiting.shift()(value);
    else messages.push(value);
  });
  const opened = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    // A relay refusal arrives as a close *after* a successful handshake, so a
    // test that wants the reason awaits `closed`, not this.
    ws.addEventListener('error', () => rej(new Error('the websocket never opened')));
    ws.addEventListener('close', (event) => rej(Object.assign(
      new Error(`closed before open: ${event.code} ${event.reason}`),
      { code: event.code, reason: event.reason },
    )));
  });
  const closed = new Promise((res) => {
    ws.addEventListener('close', (event) => res({ code: event.code, reason: event.reason }));
  });
  t?.after(() => {
    try {
      ws.close();
    } catch {
      /* already down */
    }
  });
  const next = (timeoutMs = 3000) => (messages.length ? Promise.resolve(messages.shift()) : new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('timed out waiting for a frame')), timeoutMs);
    waiting.push((value) => {
      clearTimeout(timer);
      res(value);
    });
  }));

  return {
    ws,
    opened,
    closed,
    messages,
    next,
    send: (data) => ws.send(data),
    sendJson: (value) => ws.send(JSON.stringify(value)),
    nextJson: async (timeoutMs) => JSON.parse(String(await next(timeoutMs))),
  };
}

const tokenHeaders = (token) => (token === null ? {} : { [RELAY_TOKEN_HEADER]: token });

/**
 * An end's control socket. Announcing is left to the test: half of these tests
 * are about what happens when an end announces badly, twice, or not at all.
 */
export function controlSocket(t, port, { token = null } = {}) {
  return wsClient(t, `ws://127.0.0.1:${port}/control`, { headers: tokenHeaders(token) });
}

/** A client attaching to an end under a client identity. */
export function attachSocket(t, port, { end, as, token = null } = {}) {
  const path = as === undefined ? `/attach/${encodeURIComponent(end)}` : attachPath(end, as);
  return wsClient(t, `ws://127.0.0.1:${port}${path}`, { headers: tokenHeaders(token) });
}

/** An end dialling back with a pairing. */
export function pairSocket(t, port, pairing, { token = null } = {}) {
  return wsClient(t, `ws://127.0.0.1:${port}/pair`, {
    headers: { ...tokenHeaders(token), [RELAY_PAIRING_HEADER]: pairing },
  });
}

/** Announce, wait for the `announced` reply, and hand back the control socket. */
export async function announcedEnd(t, port, fields, { token = null } = {}) {
  const control = controlSocket(t, port, { token });
  await control.opened;
  control.sendJson({ kind: 'announce', ...fields });
  const reply = await control.nextJson();
  if (reply.kind !== 'announced') throw new Error(`expected announced, got ${reply.kind}`);
  return control;
}

/**
 * The common choreography: a client attaches, the end dials back, both ends of
 * a joined pair come back.
 */
export async function joinedPair(t, port, { end, as, token = null } = {}) {
  const control = await announcedEnd(t, port, { end, connection: 'c-1', pid: 4242 }, { token });
  const client = attachSocket(t, port, { end, as, token });
  await client.opened;
  const dial = await control.nextJson();
  const endSide = pairSocket(t, port, dial.pairing, { token });
  await endSide.opened;
  return { control, client, endSide, dial };
}

/** A throwaway http server, for feeding provider-produced sockets into. */
export function echoHttpServer(t, handler) {
  const server = createServer(handler ?? ((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`hello ${req.url}`);
  }));
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  return server;
}
