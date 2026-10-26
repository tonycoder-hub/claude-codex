import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { connectUpstream } from '../../src/surface/upstream.mjs';
import { WsConnection, acceptUpgrade, acceptValue } from '../../src/surface/ws.mjs';
import { wsDuplex } from '../../src/relay/duplex.mjs';
import { attachPath } from '../../src/relay/protocol.mjs';
import {
  LISTENER_CONFIGURING,
  OUTBOUND_MULTIPLEXING,
  PROVIDERS,
  createLoopbackProvider,
  createRelayProvider,
  selectProvider,
  startProvider,
  validateProvider,
  validateTarget,
} from '../../src/relay/provider.mjs';
import { TEST_TOKEN, collectLogger, echoHttpServer, httpRequest, startRelay, waitFor } from './harness.mjs';

const logger = () => collectLogger();

// ---- the interface -------------------------------------------------------

test('a provider must have a name, a known shape, and a start', () => {
  assert.throws(() => validateProvider(null), /must be an object/);
  assert.throws(() => validateProvider({ shape: LISTENER_CONFIGURING, start() {} }), /needs a name/);
  assert.throws(() => validateProvider({ name: 'x', shape: 'magic', start() {} }), /unknown provider shape/);
  assert.throws(() => validateProvider({ name: 'x', shape: LISTENER_CONFIGURING }), /has no start/);
  const ok = { name: 'x', shape: OUTBOUND_MULTIPLEXING, start() {} };
  assert.equal(validateProvider(ok), ok);
});

test('each shape demands what it actually needs from the target', () => {
  // Not a style check: an outbound provider works by emitting connections at a
  // server, and a listener-configuring one has nothing to point at the world.
  assert.throws(() => validateTarget({ host: '127.0.0.1', port: 1 }, OUTBOUND_MULTIPLEXING), /needs target\.server/);
  assert.throws(() => validateTarget({ server: { emit() {} } }, LISTENER_CONFIGURING), /needs target\.host and target\.port/);
  validateTarget({ server: { emit() {} } }, OUTBOUND_MULTIPLEXING);
  validateTarget({ host: '::1', port: 8792 }, LISTENER_CONFIGURING);
});

test('startProvider refuses a handle that does not answer the contract', async () => {
  const target = { host: '127.0.0.1', port: 1 };
  const bad = (handle) => ({ name: 'bad', shape: LISTENER_CONFIGURING, start: async () => handle });
  await assert.rejects(startProvider(bad(null), { target }), /returned no handle/);
  await assert.rejects(startProvider(bad({ publicUrl: null, stop() {} }), { target }), /returned no kind/);
  await assert.rejects(startProvider(bad({ kind: 'bad', stop() {} }), { target }), /publicUrl or null/);
  // `undefined` would read as "not implemented yet" at every call site, which
  // is the one ambiguity this field must not have.
  await assert.rejects(startProvider(bad({ kind: 'bad', publicUrl: undefined, stop() {} }), { target }), /publicUrl or null/);
  await assert.rejects(startProvider(bad({ kind: 'bad', publicUrl: null }), { target }), /returned no stop/);
});

test('stop is idempotent however many shutdown paths call it', async () => {
  let stops = 0;
  const provider = {
    name: 'counting',
    shape: LISTENER_CONFIGURING,
    start: async () => ({ kind: 'counting', publicUrl: null, stop: () => { stops += 1; } }),
  };
  const handle = await startProvider(provider, { target: { host: '127.0.0.1', port: 1 } });
  await Promise.all([handle.stop(), handle.stop()]);
  await handle.stop();
  assert.equal(stops, 1);
});

test('providers are selected by name and built with their own options', () => {
  // The roster itself, and the invariant that each name actually builds, are
  // pinned in registry.test.mjs. Here it is only the lookup that is under test.
  assert.deepEqual(Object.keys(PROVIDERS).sort(), [
    'loopback',
    'relay',
    'ssh',
    'tailscale',
  ]);
  assert.equal(selectProvider('loopback').shape, LISTENER_CONFIGURING);
  assert.equal(selectProvider('relay', { url: 'ws://127.0.0.1:1' }).shape, OUTBOUND_MULTIPLEXING);
  // 'tailscale' stood in for "a name that does not exist" here until
  // tailscale became a provider, at which point this test failed -- which is
  // the test working. Use a name nobody will implement, and assert that it is
  // absent, so the next person to trip this gets told instead of puzzled.
  const ABSENT = 'telepathy';
  assert.ok(!(ABSENT in PROVIDERS), `${ABSENT} is a provider now; this test needs another absent name`);
  assert.throws(() => selectProvider(ABSENT), new RegExp(`unknown ingress provider ${ABSENT}`));
  // Options are bound at construction, so the surface never has to hand a
  // provider's own option names through start().
  assert.throws(() => createRelayProvider({}), /needs a relay url/);
});

// ---- loopback ------------------------------------------------------------

test('the loopback provider reports where the listener already is', async () => {
  const handle = await startProvider(createLoopbackProvider(), {
    target: { host: '127.0.0.1', port: 8792 },
    logger: logger(),
  });
  assert.equal(handle.kind, 'loopback');
  assert.equal(handle.publicUrl, 'http://127.0.0.1:8792');
  await handle.stop();
});

test('the loopback provider brackets an IPv6 host so the url is dialable', async () => {
  const handle = await startProvider(createLoopbackProvider(), {
    target: { host: '::1', port: 8792 },
    logger: logger(),
  });
  assert.equal(handle.publicUrl, 'http://[::1]:8792');
  await handle.stop();
});

// ---- relay ---------------------------------------------------------------

/**
 * A byte stream to an end, through the relay, from the client's side: attach,
 * then treat the joined websocket as the transport it is. Both halves use this
 * repo's own endpoint in its two roles -- there is no second framing
 * implementation anywhere in this suite.
 */
async function dialThroughRelay(t, port, { end, as, token = null }) {
  const ws = await connectUpstream({
    address: `ws://127.0.0.1:${port}${attachPath(end, as)}`,
    headers: token === null ? {} : { 'x-relay-token': token },
  });
  const duplex = wsDuplex(ws, { clientEnd: as });
  t.after(() => duplex.destroy());
  return duplex;
}

/**
 * An http agent that dials nothing: every request on it gets this one duplex.
 * The override lives on the agent because Node honours `options.createConnection`
 * only when there is no agent at all, and `agent: false` quietly installs one.
 */
function duplexAgent(duplex) {
  const agent = new Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = () => duplex;
  return agent;
}

/** One http request over an arbitrary duplex. */
function requestOver(duplex, path, { method = 'GET', body = null } = {}) {
  return new Promise((res, rej) => {
    const req = request(
      { method, path, host: 'relayed.invalid', agent: duplexAgent(duplex) },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => res({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }));
      },
    );
    req.on('error', rej);
    req.end(body ?? undefined);
  });
}

/** A relay, an http server, and the relay provider joining them. */
async function residentThroughRelay(t, { handler, onUpgrade, token = null, end = 'resident' } = {}) {
  const { port, relay } = await startRelay(t, token === null ? {} : { token });
  const server = echoHttpServer(t, handler);
  if (onUpgrade) server.on('upgrade', onUpgrade);
  const providerLogger = logger();
  const handle = await startProvider(createRelayProvider({ url: `ws://127.0.0.1:${port}`, token }), {
    target: { name: end, server, url: '127.0.0.1:0' },
    logger: providerLogger,
  });
  t.after(() => handle.stop());
  return { port, relay, server, handle, providerLogger, end };
}

test('the relay provider announces the target and admits it has no url', async (t) => {
  const { port, handle, end } = await residentThroughRelay(t);
  assert.equal(handle.kind, 'relay');
  // There is no address a browser could be pointed at: the only way in is to
  // attach to this end through the relay.
  assert.equal(handle.publicUrl, null);

  const record = await waitFor(async () => (await httpRequest(port, '/ends')).json.ends[0], { label: 'the registration' });
  assert.equal(record.end, end);
  assert.equal(record.pid, process.pid);
  assert.equal(record.listen, '127.0.0.1:0');
  assert.equal(record.busy, false);
});

test('an http request travels through the relay into the http server', async (t) => {
  const { port } = await residentThroughRelay(t);
  const duplex = await dialThroughRelay(t, port, { end: 'resident', as: 'phone' });
  const res = await requestOver(duplex, '/hello');
  assert.equal(res.status, 200);
  assert.equal(res.body.toString('utf8'), 'hello /hello');
});

test('a request body that is not text survives the trip', async (t) => {
  const bytes = Buffer.from([0x00, 0x80, 0xfe, 0xff, 0xed, 0xa0, 0x80]);
  const { port } = await residentThroughRelay(t, {
    handler: (req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const got = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': got.length });
        res.end(got);
      });
    },
  });
  const duplex = await dialThroughRelay(t, port, { end: 'resident', as: 'phone' });
  const res = await requestOver(duplex, '/echo', { method: 'POST', body: bytes });
  assert.deepEqual(res.body, bytes);
});

test('the server sees a connection it never accepted, and says so honestly', async (t) => {
  let seen = null;
  const { port } = await residentThroughRelay(t, {
    handler: (req, res) => {
      seen = {
        remoteAddress: req.socket.remoteAddress,
        clientEnd: req.socket.relayClientEnd,
        encrypted: req.socket.encrypted,
      };
      res.end('ok');
    },
  });
  const duplex = await dialThroughRelay(t, port, { end: 'resident', as: 'phone-7' });
  await requestOver(duplex, '/who');
  // A relayed connection has no network identity. The only thing it can say
  // about the far side is a *name*, and code that needs a peer must know that.
  assert.equal(seen.remoteAddress, undefined);
  assert.equal(seen.clientEnd, 'phone-7');
  assert.equal(seen.encrypted, false);
});

test('a websocket upgrade survives the whole chain', async (t) => {
  // The target server speaks websocket on its own terms, unaware that its
  // connections arrive over a relay. Four hops of framing: this client, the
  // attach socket, the paired socket, and the upgraded socket inside it.
  const { port } = await residentThroughRelay(t, {
    handler: (req, res) => res.end('not the ws path'),
    onUpgrade: (req, socket, head) => {
      const server = acceptUpgrade(req, socket, head, {});
      if (!server) return;
      server.onMessage((data) => server.send(typeof data === 'string' ? `echo:${data}` : data));
    },
  });

  const duplex = await dialThroughRelay(t, port, { end: 'resident', as: 'phone' });
  const key = randomBytes(16).toString('base64');
  const req = request({
    method: 'GET',
    path: '/ws',
    host: 'relayed.invalid',
    agent: duplexAgent(duplex),
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
    },
  });
  const upgraded = new Promise((res, rej) => {
    req.on('upgrade', (response, socket, head) => res({ response, socket, head }));
    req.on('error', rej);
  });
  req.end();

  const { response, socket, head } = await upgraded;
  assert.equal(response.statusCode, 101);
  assert.equal(response.headers['sec-websocket-accept'], acceptValue(key));

  // Client role of the same endpoint the server used: one framing
  // implementation, both directions, all the way down.
  const ws = new WsConnection(socket, { role: 'client', head });
  t.after(() => ws.close());
  const inbox = [];
  const waiting = [];
  ws.onMessage((data) => (waiting.length ? waiting.shift()(data) : inbox.push(data)));
  const next = () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('timed out waiting for the echo')), 3000);
    waiting.push((value) => {
      clearTimeout(timer);
      res(value);
    });
  }));

  ws.send('through-the-relay');
  assert.equal(await next(), 'echo:through-the-relay');
  const bytes = Buffer.from([0x00, 0xfe, 0xff]);
  ws.send(bytes);
  assert.deepEqual(await next(), bytes);
});

test('provider logs name the client end but never a pairing', async (t) => {
  const { port, providerLogger } = await residentThroughRelay(t);
  const duplex = await dialThroughRelay(t, port, { end: 'resident', as: 'phone' });
  await requestOver(duplex, '/hello');
  assert.ok(providerLogger.records.some((r) => r.event === 'provider.relay.connection' && r.clientEnd === 'phone'));
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(providerLogger.text()), false);
});

test('stopping the provider deregisters the end', async (t) => {
  const { port, handle } = await residentThroughRelay(t);
  await waitFor(async () => (await httpRequest(port, '/ends')).json.ends.length === 1, { label: 'the registration' });
  await handle.stop();
  await waitFor(async () => (await httpRequest(port, '/ends')).json.ends.length === 0, { label: 'the deregistration' });
});

test('the relay provider carries its own token to a protected relay', async (t) => {
  const { port } = await residentThroughRelay(t, { token: TEST_TOKEN });
  const duplex = await dialThroughRelay(t, port, { end: 'resident', as: 'phone', token: TEST_TOKEN });
  const res = await requestOver(duplex, '/hello');
  assert.equal(res.status, 200);
});

test('the relay provider cannot attach to a relay that rejects its token', async (t) => {
  const { port } = await startRelay(t, { token: TEST_TOKEN });
  const server = echoHttpServer(t);
  await assert.rejects(
    startProvider(createRelayProvider({ url: `ws://127.0.0.1:${port}`, token: 'the-wrong-fixture-token' }), {
      target: { name: 'resident', server },
      logger: logger(),
    }),
    /refused the upgrade: HTTP\/1\.1 401/,
  );
});

test('an end name already held by somebody else fails the provider start', async (t) => {
  const { port } = await residentThroughRelay(t);
  const server = echoHttpServer(t);
  await assert.rejects(
    startProvider(createRelayProvider({ url: `ws://127.0.0.1:${port}` }), {
      target: { name: 'resident', server },
      logger: logger(),
    }),
    /already announced from another connection/,
  );
});
