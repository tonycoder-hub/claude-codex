import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { parseUpstreamAddress, connectUpstream, createWsUpstreamFactory } from '../../src/surface/upstream.mjs';
import { acceptUpgrade, acceptValue } from '../../src/surface/ws.mjs';
import { startEchoWs, tempDir, waitFor } from './harness.mjs';

const listenOn = (server, target) => new Promise((res) => {
  if (typeof target === 'string') server.listen(target, () => res(target));
  else server.listen(0, '127.0.0.1', () => res(server.address().port));
});

/**
 * A bare http server with an upgrade handler of the test's choosing.
 *
 * The socket tracking is not incidental: once a socket has been handed over by
 * an `upgrade` event the http server stops counting it, so neither close() nor
 * closeAllConnections() will ever let it go, and a teardown that waits for one
 * waits forever. Anything in this repo that accepts upgrades has to hang up on
 * its own sockets, tests included.
 */
function upgradeServer(onUpgrade) {
  const server = createServer((req, res) => { res.writeHead(404); res.end('nope'); });
  const sockets = new Set();
  server.on('upgrade', (req, socket, head) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    onUpgrade(req, socket, head);
  });
  return {
    server,
    listen: (target) => listenOn(server, target),
    close: () => new Promise((res) => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      server.close(() => res());
    }),
  };
}

test('upstream addresses parse into connect options', () => {
  const tcp = parseUpstreamAddress('ws://127.0.0.1:4096/app-server');
  assert.deepEqual(tcp.connectOptions, { host: '127.0.0.1', port: 4096 });
  assert.equal(tcp.path, '/app-server');
  assert.equal(tcp.hostHeader, '127.0.0.1:4096');

  const unix = parseUpstreamAddress('unix:/run/codex/app.sock');
  assert.deepEqual(unix.connectOptions, { path: '/run/codex/app.sock' });
  assert.equal(unix.path, '/');

  const unixWithPath = parseUpstreamAddress('unix:/run/codex/app.sock:/rpc');
  assert.deepEqual(unixWithPath.connectOptions, { path: '/run/codex/app.sock' });
  assert.equal(unixWithPath.path, '/rpc');

  assert.deepEqual(parseUpstreamAddress('/run/codex/app.sock').connectOptions, { path: '/run/codex/app.sock' });

  assert.throws(() => parseUpstreamAddress(''), /address is required/);
  assert.throws(() => parseUpstreamAddress('wss://host/x'), /not supported/);
  assert.throws(() => parseUpstreamAddress('http://host/x'), /unsupported upstream scheme/);
});

test('the upstream client round-trips against our own server', async (t) => {
  // Both halves of RFC 6455 from this repo, talking to each other: the client
  // masks, the server unmasks, and nothing in between is a library.
  const echo = await startEchoWs();
  t.after(() => echo.close());

  const upstream = await connectUpstream({ address: `ws://127.0.0.1:${echo.port}/ws` });
  t.after(() => upstream.close(1000, 'test over'));

  const received = [];
  upstream.onMessage((data) => received.push(data));
  upstream.send('{"jsonrpc":"2.0","id":1,"method":"ping"}');
  await waitFor(() => received.length === 1, { label: 'the echo' });
  assert.equal(received[0], '{"jsonrpc":"2.0","id":1,"method":"ping"}');

  // The mask key is random per frame, so the same payload twice must still
  // arrive identically on the other side.
  upstream.send('same');
  upstream.send('same');
  await waitFor(() => received.length === 3, { label: 'both echoes' });
  assert.deepEqual(received.slice(1), ['same', 'same']);

  const big = 'y'.repeat(70_000);
  upstream.send(big);
  await waitFor(() => received.length === 4, { label: 'the large echo', timeoutMs: 8000 });
  assert.equal(received[3], big);
});

test('the upstream client works over a unix socket', async (t) => {
  const socketPath = join(tempDir('relay-upstream-'), 'app.sock');
  const server = upgradeServer((req, socket, head) => {
    const ws = acceptUpgrade(req, socket, head);
    if (!ws) return;
    ws.onMessage((data) => ws.send(`echo:${data}`));
  });
  await server.listen(socketPath);

  const upstream = await connectUpstream({ address: `unix:${socketPath}:/ws` });
  t.after(() => { upstream.close(1000, 'test over'); return server.close(); });
  const received = [];
  upstream.onMessage((data) => received.push(data));
  upstream.send('hello');
  await waitFor(() => received.length === 1, { label: 'the unix echo' });
  assert.equal(received[0], 'echo:hello');
});

test('a masked frame from a server is a protocol error at the client', async (t) => {
  // A server must never mask its frames. Prove the client half enforces it.
  const server = upgradeServer((req, socket) => {
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptValue(req.headers['sec-websocket-key'])}`,
      '', '',
    ].join('\r\n'));
    // ...and then immediately breaks the rules: a masked text frame, "hi".
    socket.write(Buffer.from([0x81, 0x82, 0x00, 0x00, 0x00, 0x00, 0x68, 0x69]));
  });
  const port = await server.listen();
  t.after(() => server.close());

  // This server will not answer our close frame either, so the close timeout is
  // what ends the connection -- shortened here so the test does not wait on it.
  const upstream = await connectUpstream({ address: `ws://127.0.0.1:${port}/ws`, closeTimeoutMs: 200 });
  const { code, reason } = await new Promise((res) => upstream.onClose((c, r) => res({ code: c, reason: r })));
  assert.equal(code, 1002);
  assert.match(reason, /must not be masked/);
});

test('a non-websocket upstream fails the handshake instead of hanging', async (t) => {
  // Something is listening and it speaks HTTP, it just has no websocket at
  // that path -- the misconfiguration we will actually hit in production.
  const server = upgradeServer((req, socket) => {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  const port = await server.listen();
  t.after(() => server.close());

  await assert.rejects(
    connectUpstream({ address: `ws://127.0.0.1:${port}/ws`, timeoutMs: 2000 }),
    /refused the upgrade: HTTP\/1\.1 404/,
  );
});

test('a bad accept value is refused even though the status said 101', async (t) => {
  const server = upgradeServer((req, socket) => {
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: AAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      '', '',
    ].join('\r\n'));
  });
  const port = await server.listen();
  t.after(() => server.close());

  await assert.rejects(
    connectUpstream({ address: `ws://127.0.0.1:${port}/ws`, timeoutMs: 2000 }),
    /bad Sec-WebSocket-Accept/,
  );
});

test('a dead address fails fast and the factory validates at construction', async () => {
  await assert.rejects(connectUpstream({ address: 'unix:/nonexistent/relay.sock', timeoutMs: 1000 }));
  assert.throws(() => createWsUpstreamFactory({ address: 'nonsense://x' }), /unsupported/);
});
