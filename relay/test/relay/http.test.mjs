import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_TOKEN, announcedEnd, httpRequest, rawUpgrade, startRelay, waitFor } from './harness.mjs';

test('GET /ends on an empty relay is an empty list', async (t) => {
  const { port } = await startRelay(t);
  const res = await httpRequest(port, '/ends');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ends: [] });
  assert.match(res.headers['content-type'], /application\/json/);
});

test('an announced end appears in /ends with the whole record', async (t) => {
  const { port } = await startRelay(t);
  const before = Date.now();
  await announcedEnd(t, port, {
    end: 'alpha',
    connection: 'conn-1',
    pid: 1234,
    host: 'resident-mac',
    cwd: '/Users/someone/work',
    runtime: 'node 22',
    listen: '127.0.0.1:8792',
    busy: false,
  });

  const record = await waitFor(async () => (await httpRequest(port, '/ends')).json.ends[0], { label: 'the record' });
  assert.equal(record.end, 'alpha');
  assert.equal(record.connection, 'conn-1');
  assert.equal(record.pid, 1234);
  assert.equal(record.host, 'resident-mac');
  assert.equal(record.cwd, '/Users/someone/work');
  assert.equal(record.runtime, 'node 22');
  assert.equal(record.listen, '127.0.0.1:8792');
  assert.equal(record.busy, false);
  assert.equal(typeof record.announcedAt, 'number');
  assert.equal(typeof record.lastSeenAt, 'number');
  assert.ok(record.announcedAt >= before && record.announcedAt <= Date.now());
});

test('/ends is sorted by end name ascending, whatever order they arrived in', async (t) => {
  const { port } = await startRelay(t);
  for (const end of ['zulu', 'alpha', 'Mike', 'bravo']) {
    await announcedEnd(t, port, { end, pid: 1 });
  }
  const res = await waitFor(async () => {
    const r = await httpRequest(port, '/ends');
    return r.json.ends.length === 4 ? r : null;
  }, { label: 'four ends' });
  // Code-unit order, so an upper-case name sorts before the lower-case ones.
  assert.deepEqual(res.json.ends.map((r) => r.end), ['Mike', 'alpha', 'bravo', 'zulu']);
});

test('any other http path is a 404 with the relay body', async (t) => {
  const { port } = await startRelay(t);
  for (const path of ['/', '/control', '/attach/alpha', '/ends/', '/nonsense']) {
    const res = await httpRequest(port, path);
    assert.equal(res.status, 404, path);
    assert.deepEqual(res.json, { error: 'no such relay path' });
  }
});

test('a token-protected relay rejects http without the header', async (t) => {
  const { port } = await startRelay(t, { token: TEST_TOKEN });
  const res = await httpRequest(port, '/ends');
  assert.equal(res.status, 401);
  assert.deepEqual(res.json, { error: 'relay token rejected' });
});

test('a wrong token is rejected, including one that is merely a prefix', async (t) => {
  const { port } = await startRelay(t, { token: TEST_TOKEN });
  for (const token of ['', 'wrong', TEST_TOKEN.slice(0, -1), `${TEST_TOKEN}x`, TEST_TOKEN.toUpperCase()]) {
    const res = await httpRequest(port, '/ends', { token });
    assert.equal(res.status, 401, JSON.stringify(token));
  }
  const good = await httpRequest(port, '/ends', { token: TEST_TOKEN });
  assert.equal(good.status, 200);
});

test('the token is rejected before the path is routed', async (t) => {
  const { port } = await startRelay(t, { token: TEST_TOKEN });
  // An unauthenticated prober must not be able to tell a real path from a
  // fictional one: both answer 401, never 404.
  assert.equal((await httpRequest(port, '/ends')).status, 401);
  assert.equal((await httpRequest(port, '/nonsense')).status, 401);
});

test('a null token means no auth, and a presented token is simply ignored', async (t) => {
  const { port } = await startRelay(t, { token: null });
  assert.equal((await httpRequest(port, '/ends')).status, 200);
  assert.equal((await httpRequest(port, '/ends', { token: 'whatever' })).status, 200);
});

test('a HEAD of /ends gets the headers and no body', async (t) => {
  const { port } = await startRelay(t);
  const res = await httpRequest(port, '/ends', { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.text, '');
  assert.equal(res.headers['content-length'], String(Buffer.byteLength('{"ends":[]}')));
});

test('a rejected upgrade gets a bare 401 status line and the socket goes', async (t) => {
  const { port } = await startRelay(t, { token: TEST_TOKEN });
  for (const path of ['/control', '/pair', '/attach/alpha?as=phone']) {
    const res = await rawUpgrade(port, path);
    assert.equal(res.statusLine, 'HTTP/1.1 401 Unauthorized', path);
    // No headers, no body: the peer asked for a protocol switch, so there is
    // nothing it would read.
    assert.equal(res.raw, 'HTTP/1.1 401 Unauthorized\r\n\r\n', path);
  }
});

test('an upgrade with the right token is not refused', async (t) => {
  const { port } = await startRelay(t, { token: TEST_TOKEN });
  const res = await rawUpgrade(port, '/control', { token: TEST_TOKEN });
  assert.equal(res.statusLine, 'HTTP/1.1 101 Switching Protocols');
});

test('an unknown upgrade path is answered, not left dangling', async (t) => {
  const { port } = await startRelay(t);
  const res = await rawUpgrade(port, '/nowhere');
  assert.equal(res.statusLine, 'HTTP/1.1 404 Not Found');
});

test('no log record ever carries the token', async (t) => {
  const { port, logger } = await startRelay(t, { token: TEST_TOKEN });
  await httpRequest(port, '/ends', { token: 'a-wrong-token' });
  await httpRequest(port, '/ends', { token: TEST_TOKEN });
  await rawUpgrade(port, '/control');
  const text = logger.text();
  assert.equal(text.includes(TEST_TOKEN), false);
  assert.equal(text.includes('a-wrong-token'), false);
  assert.ok(logger.records.some((r) => r.event === 'relay.http_denied'));
  assert.ok(logger.records.some((r) => r.event === 'relay.upgrade_denied'));
});
