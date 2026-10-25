import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshSessions, startSurface, browserClient, fakeUpstream, waitFor, collectLogger } from './harness.mjs';

// Deliberately irregular spacing and key order: the relay must not reformat,
// re-encode, or reorder a single byte of what it carries.
const REQUEST = '{"jsonrpc":"2.0","id":7,"method":"session/new","params":{"cwd":"/tmp/x","model":"sonnet",  "nested":{"a":[1,2,3]}}}';
const RESPONSE = '{"jsonrpc":"2.0","id":7,"result":{"sessionId":"s-1","items":[]}}';
const NOTIFICATION = '{"jsonrpc":"2.0","method":"session/update","params":{"delta":"hello  world","n":2}}';

/** A surface with one fake upstream per client, each tracked for assertions. */
async function relaySurface(t, { createUpstream, logger = collectLogger({}), ...overrides } = {}) {
  const sessions = freshSessions();
  const upstreams = [];
  const surface = await startSurface({
    sessions,
    logger,
    createUpstream: createUpstream ?? (() => {
      const upstream = fakeUpstream();
      upstreams.push(upstream);
      return upstream;
    }),
    ...overrides,
  });
  t.after(() => surface.close());

  const connect = async (subject = 'cred-phone') => {
    const { token } = sessions.issue({ subject });
    const client = browserClient(surface.port, { cookie: `${sessions.cookieName}=${token}` });
    t.after(() => client.ws.close());
    await client.opened;
    return client;
  };
  return { ...surface, sessions, upstreams, connect };
}

test('a JSON-RPC request reaches the upstream byte-identically and the reply comes back', async (t) => {
  const { upstreams, connect } = await relaySurface(t);
  const client = await connect();

  client.send(REQUEST);
  const upstream = await waitFor(() => upstreams[0], { label: 'the upstream' });
  await waitFor(() => upstream.received.length === 1, { label: 'the relayed request' });
  // Byte-identical, not merely JSON-equivalent.
  assert.equal(upstream.received[0], REQUEST);
  assert.deepEqual(Buffer.from(upstream.received[0], 'utf8'), Buffer.from(REQUEST, 'utf8'));

  upstream.push(RESPONSE);
  assert.equal(await client.next(), RESPONSE);
});

test('a notification from the upstream reaches the browser', async (t) => {
  const { upstreams, connect } = await relaySurface(t);
  const client = await connect();
  const upstream = await waitFor(() => upstreams[0], { label: 'the upstream' });

  upstream.push(NOTIFICATION);
  assert.equal(await client.next(), NOTIFICATION);
  // Nothing was invented in the other direction.
  assert.equal(upstream.received.length, 0);
});

test('binary frames pass through untouched in both directions', async (t) => {
  const { upstreams, connect } = await relaySurface(t);
  const client = await connect();
  const bytes = Buffer.from([0x00, 0x01, 0x80, 0xfe, 0xff]);

  client.send(bytes);
  const upstream = await waitFor(() => upstreams[0], { label: 'the upstream' });
  await waitFor(() => upstream.received.length === 1, { label: 'the relayed bytes' });
  assert.deepEqual(Buffer.from(upstream.received[0]), bytes);

  upstream.push(bytes);
  assert.deepEqual(await client.next(), bytes);
});

test('frames sent before the upstream is ready are flushed in order', async (t) => {
  let release;
  const held = new Promise((res) => { release = res; });
  const upstreams = [];
  const { connect } = await relaySurface(t, {
    createUpstream: async () => {
      await held;
      const upstream = fakeUpstream();
      upstreams.push(upstream);
      return upstream;
    },
  });

  const client = await connect();
  client.send('{"id":1,"method":"a"}');
  client.send('{"id":2,"method":"b"}');
  client.send('{"id":3,"method":"c"}');
  // Give the frames time to arrive while the upstream is still dialling.
  await new Promise((res) => setTimeout(res, 30));
  release();

  const upstream = await waitFor(() => upstreams[0], { label: 'the upstream' });
  await waitFor(() => upstream.received.length === 3, { label: 'the flushed backlog' });
  assert.deepEqual(upstream.received, ['{"id":1,"method":"a"}', '{"id":2,"method":"b"}', '{"id":3,"method":"c"}']);
});

test('closing the browser socket closes its upstream', async (t) => {
  const { upstreams, connect } = await relaySurface(t);
  const client = await connect();
  const upstream = await waitFor(() => upstreams[0], { label: 'the upstream' });

  client.ws.close(1000, 'done for now');
  await waitFor(() => upstream.closed, { label: 'the upstream close' });
  assert.equal(upstream.closedWith.code, 1000);
});

test('an upstream close takes the browser socket down with a meaningful code', async (t) => {
  const { upstreams, connect } = await relaySurface(t);
  const client = await connect();
  const upstream = await waitFor(() => upstreams[0], { label: 'the upstream' });

  upstream.close(1001, 'app-server going away');
  const { code } = await client.closed;
  assert.equal(code, 1001);
});

test('an upstream that dies abnormally becomes 1011 at the browser', async (t) => {
  const { upstreams, connect } = await relaySurface(t);
  const client = await connect();
  const upstream = await waitFor(() => upstreams[0], { label: 'the upstream' });

  // 1006 is never sendable on the wire, so the browser must learn about it some
  // other way rather than seeing a bare socket drop.
  upstream.kill(1006, 'app-server crashed');
  const { code } = await client.closed;
  assert.equal(code, 1011);
});

test('two clients get independent upstreams and their traffic never crosses', async (t) => {
  const { upstreams, connect } = await relaySurface(t);
  const a = await connect('cred-phone');
  const b = await connect('cred-laptop');

  await waitFor(() => upstreams.length === 2, { label: 'two upstreams' });
  const [upA, upB] = upstreams;
  assert.notEqual(upA, upB);

  a.send('{"id":1,"method":"for-a"}');
  b.send('{"id":2,"method":"for-b"}');
  await waitFor(() => upA.received.length === 1 && upB.received.length === 1, { label: 'both requests' });
  assert.deepEqual(upA.received, ['{"id":1,"method":"for-a"}']);
  assert.deepEqual(upB.received, ['{"id":2,"method":"for-b"}']);

  upA.push('{"id":1,"result":"to-a"}');
  upB.push('{"id":2,"result":"to-b"}');
  assert.equal(await a.next(), '{"id":1,"result":"to-a"}');
  assert.equal(await b.next(), '{"id":2,"result":"to-b"}');
});

test('killing one client upstream leaves the other session working', async (t) => {
  const { upstreams, connect, surface } = await relaySurface(t);
  const a = await connect('cred-phone');
  const b = await connect('cred-laptop');
  await waitFor(() => upstreams.length === 2, { label: 'two upstreams' });
  const [upA, upB] = upstreams;

  upA.kill(1006, 'this one peer has a bad day');
  assert.equal((await a.closed).code, 1011);

  // The surface is still up, B's session is untouched, and it can still relay.
  b.send(REQUEST);
  await waitFor(() => upB.received.length === 1, { label: "B's request" });
  assert.equal(upB.received[0], REQUEST);
  upB.push(RESPONSE);
  assert.equal(await b.next(), RESPONSE);
  assert.equal(upB.closed, false);

  // And a brand new client still connects afterwards.
  const c = await connect('cred-tablet');
  await waitFor(() => upstreams.length === 3, { label: "C's upstream" });
  c.send('{"id":9,"method":"after-the-crash"}');
  await waitFor(() => upstreams[2].received.length === 1, { label: "C's request" });
  assert.equal(surface.clients >= 2, true);
});

test('an upstream whose send throws ends only that session', async (t) => {
  const upstreams = [];
  const { connect } = await relaySurface(t, {
    createUpstream: () => {
      const upstream = fakeUpstream();
      // The first client's upstream is poisoned; the second one is fine.
      if (upstreams.length === 0) upstream.send = () => { throw new Error('socket is gone'); };
      upstreams.push(upstream);
      return upstream;
    },
  });

  const a = await connect('cred-phone');
  const b = await connect('cred-laptop');
  await waitFor(() => upstreams.length === 2, { label: 'two upstreams' });

  a.send('{"id":1,"method":"doomed"}');
  assert.equal((await a.closed).code, 1011);

  b.send('{"id":2,"method":"fine"}');
  await waitFor(() => upstreams[1].received.length === 1, { label: "B's request" });
  assert.deepEqual(upstreams[1].received, ['{"id":2,"method":"fine"}']);
});

test('an upstream that cannot be dialled closes the browser socket with 1011', async (t) => {
  let attempts = 0;
  const { connect, logger } = await relaySurface(t, {
    createUpstream: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('connect ECONNREFUSED');
      return fakeUpstream();
    },
  });

  const a = await connect();
  assert.equal((await a.closed).code, 1011);
  assert.ok(logger.records.some((r) => r.event === 'relay.upstream_unavailable'));

  // The server survived a failed dial and still serves the next client.
  const b = await connect();
  b.send('{"id":1,"method":"still-here"}');
  assert.equal(b.ws.readyState, WebSocket.OPEN);
});

test('an upstream created after the browser left is closed, not leaked', async (t) => {
  let created = null;
  let release;
  const held = new Promise((res) => { release = res; });
  const { connect } = await relaySurface(t, {
    createUpstream: async () => {
      await held;
      created = fakeUpstream();
      return created;
    },
  });

  const client = await connect();
  client.ws.close(1000, 'changed my mind');
  await client.closed;
  release();

  const upstream = await waitFor(() => created, { label: 'the late upstream' });
  await waitFor(() => upstream.closed, { label: 'the late upstream close' });
  assert.equal(upstream.closedWith.code, 1001);
});

test('a browser backlog larger than the cap closes with 1009 instead of buffering', async (t) => {
  let release;
  const held = new Promise((res) => { release = res; });
  const { connect } = await relaySurface(t, {
    maxPendingBytes: 4096,
    createUpstream: async () => { await held; return fakeUpstream(); },
  });

  const client = await connect();
  for (let i = 0; i < 8; i++) client.send('x'.repeat(1024));
  const { code } = await client.closed;
  assert.equal(code, 1009);
  release();
});

test('logging records method names and sizes, never payloads', async (t) => {
  const logger = collectLogger({});
  const { upstreams, connect } = await relaySurface(t, { logger });
  const client = await connect();

  client.send(REQUEST);
  const upstream = await waitFor(() => upstreams[0], { label: 'the upstream' });
  await waitFor(() => upstream.received.length === 1, { label: 'the relayed request' });
  upstream.push(NOTIFICATION);
  await client.next();

  const text = logger.text();
  assert.ok(logger.records.some((r) => r.event === 'ws.open'));
  const toUpstream = logger.records.find((r) => r.event === 'relay.to_upstream');
  assert.equal(toUpstream.method, 'session/new');
  assert.equal(toUpstream.bytes, Buffer.byteLength(REQUEST));
  assert.equal(logger.records.find((r) => r.event === 'relay.to_browser').method, 'session/update');
  // The params -- the actual content -- are nowhere in the log.
  assert.equal(text.includes('/tmp/x'), false);
  assert.equal(text.includes('hello  world'), false);
  assert.equal(text.includes('sessionId'), false);
});
