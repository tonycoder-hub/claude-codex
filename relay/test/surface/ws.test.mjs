import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptValue, handshakeAccept, UpgradeError, encodeFrame, isSendableCloseCode, OPCODE } from '../../src/surface/ws.mjs';
import { startEchoWs, rawHandshake, browserClient, clientFrame, closeFrameBody, waitFor } from './harness.mjs';

const fakeRequest = (headers) => ({ method: 'GET', headers: { upgrade: 'websocket', connection: 'Upgrade', ...headers } });

test('the accept value matches the RFC 6455 example', () => {
  // Section 1.3's worked example, which is the one vector everyone agrees on.
  assert.equal(acceptValue('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('handshakeAccept refuses malformed upgrades with a usable status', () => {
  const key = Buffer.alloc(16).toString('base64');
  assert.equal(
    handshakeAccept(fakeRequest({ 'sec-websocket-version': '13', 'sec-websocket-key': key })),
    acceptValue(key),
  );
  // "keep-alive, Upgrade" is a legal Connection header and must be accepted.
  assert.ok(handshakeAccept(fakeRequest({
    connection: 'keep-alive, Upgrade',
    'sec-websocket-version': '13',
    'sec-websocket-key': key,
  })));

  const cases = [
    [{ 'sec-websocket-version': '8', 'sec-websocket-key': key }, 426],
    [{ 'sec-websocket-version': '13' }, 400],
    [{ 'sec-websocket-version': '13', 'sec-websocket-key': 'not base64 at all' }, 400],
    [{ 'sec-websocket-version': '13', 'sec-websocket-key': Buffer.alloc(8).toString('base64') }, 400],
    [{ upgrade: 'h2c', 'sec-websocket-version': '13', 'sec-websocket-key': key }, 400],
    [{ connection: 'keep-alive', 'sec-websocket-version': '13', 'sec-websocket-key': key }, 400],
  ];
  for (const [headers, status] of cases) {
    assert.throws(() => handshakeAccept(fakeRequest(headers)), (err) => {
      assert.ok(err instanceof UpgradeError);
      assert.equal(err.status, status, `expected ${status} for ${JSON.stringify(headers)}`);
      return true;
    });
  }
  assert.throws(() => handshakeAccept({ method: 'POST', headers: {} }), /must be a GET/);
});

test('close codes that may not go on the wire are recognised', () => {
  for (const ok of [1000, 1001, 1009, 1011, 3000, 4999]) assert.equal(isSendableCloseCode(ok), true, `${ok}`);
  for (const bad of [999, 1004, 1005, 1006, 1016, 2999, 5000, undefined, 1000.5]) {
    assert.equal(isSendableCloseCode(bad), false, `${bad}`);
  }
});

test('a valid upgrade is accepted and answered with 101', async (t) => {
  const echo = await startEchoWs();
  t.after(() => echo.close());

  const { status, headers, key, socket } = await rawHandshake(echo.port);
  t.after(() => socket.destroy());
  assert.equal(status, 101);
  assert.equal(headers.upgrade, 'websocket');
  assert.equal(headers.connection, 'Upgrade');
  assert.equal(headers['sec-websocket-accept'], acceptValue(key));
});

test('a bad version is refused with 426 and an advertised version', async (t) => {
  const echo = await startEchoWs();
  t.after(() => echo.close());

  const { status, headers } = await rawHandshake(echo.port, { headers: { 'Sec-WebSocket-Version': '8' } });
  assert.equal(status, 426);
  assert.equal(headers['sec-websocket-version'], '13');
  // A refused upgrade gets a real HTTP response, not a dangling socket.
  assert.equal(headers['content-type'], 'text/plain; charset=utf-8');
});

test('a bad or missing key is refused with 400', async (t) => {
  const echo = await startEchoWs();
  t.after(() => echo.close());

  assert.equal((await rawHandshake(echo.port, { key: 'this-is-not-base64!' })).status, 400);
  assert.equal((await rawHandshake(echo.port, { key: Buffer.alloc(4).toString('base64') })).status, 400);
  assert.equal((await rawHandshake(echo.port, { headers: { 'Sec-WebSocket-Key': null } })).status, 400);
});

test('an unmasked client frame is a protocol error', async (t) => {
  const echo = await startEchoWs();
  t.after(() => echo.close());

  const { status, socket, nextFrame } = await rawHandshake(echo.port);
  t.after(() => socket.destroy());
  assert.equal(status, 101);

  socket.write(clientFrame(OPCODE.text, 'unmasked and therefore illegal', { mask: false }));
  const frame = await nextFrame();
  assert.equal(frame.opcode, OPCODE.close);
  assert.equal(frame.payload.readUInt16BE(0), 1002);
  assert.match(frame.payload.subarray(2).toString('utf8'), /must be masked/);
  // The illegal frame never reached the application.
  assert.equal(echo.events.some((e) => e.type === 'message'), false);
});

test('a text message round-trips through a real WebSocket client', async (t) => {
  const echo = await startEchoWs();
  const client = browserClient(echo.port);
  t.after(async () => { client.ws.close(); await echo.close(); });

  await client.opened;
  client.send('hello surface');
  assert.equal(await client.next(), 'hello surface');
  // Non-ASCII proves the UTF-8 path in both directions.
  client.send('héllo – ✅');
  assert.equal(await client.next(), 'héllo – ✅');
});

test('a binary message round-trips as binary', async (t) => {
  const echo = await startEchoWs();
  const client = browserClient(echo.port);
  t.after(async () => { client.ws.close(); await echo.close(); });

  await client.opened;
  client.send(new Uint8Array([0, 1, 2, 253, 254, 255]));
  const back = await client.next();
  assert.deepEqual(back, Buffer.from([0, 1, 2, 253, 254, 255]));
  assert.equal(echo.events.find((e) => e.type === 'message').binary, true);
});

test('a fragmented message is reassembled before delivery', async (t) => {
  const echo = await startEchoWs();
  t.after(() => echo.close());

  const { socket, nextFrame } = await rawHandshake(echo.port);
  t.after(() => socket.destroy());

  socket.write(clientFrame(OPCODE.text, 'one ', { fin: false }));
  socket.write(clientFrame(OPCODE.continuation, 'two ', { fin: false }));
  socket.write(clientFrame(OPCODE.continuation, 'three', { fin: true }));

  const frame = await nextFrame();
  assert.equal(frame.opcode, OPCODE.text);
  assert.equal(frame.payload.toString('utf8'), 'one two three');
  // The application saw one message, not three.
  assert.equal(echo.events.filter((e) => e.type === 'message').length, 1);
});

test('a continuation with no started message is a protocol error', async (t) => {
  const echo = await startEchoWs();
  t.after(() => echo.close());

  const { socket, nextFrame } = await rawHandshake(echo.port);
  t.after(() => socket.destroy());

  socket.write(clientFrame(OPCODE.continuation, 'orphan'));
  const frame = await nextFrame();
  assert.equal(frame.opcode, OPCODE.close);
  assert.equal(frame.payload.readUInt16BE(0), 1002);
});

test('a ping is answered with a pong carrying the same payload', async (t) => {
  const echo = await startEchoWs();
  t.after(() => echo.close());

  const { socket, nextFrame } = await rawHandshake(echo.port);
  t.after(() => socket.destroy());

  socket.write(clientFrame(OPCODE.ping, 'heartbeat-1'));
  const pong = await nextFrame();
  assert.equal(pong.opcode, OPCODE.pong);
  assert.equal(pong.payload.toString('utf8'), 'heartbeat-1');

  // A pong of our own must be swallowed, not echoed back forever.
  socket.write(clientFrame(OPCODE.pong, 'unsolicited'));
  socket.write(clientFrame(OPCODE.text, 'still alive'));
  const next = await nextFrame();
  assert.equal(next.opcode, OPCODE.text);
  assert.equal(next.payload.toString('utf8'), 'still alive');
});

test('a 64-bit length frame round-trips', async (t) => {
  const echo = await startEchoWs();
  t.after(() => echo.close());

  const { socket, nextFrame } = await rawHandshake(echo.port);
  t.after(() => socket.destroy());

  // 70000 bytes needs the 64-bit form on the way in, and gets it on the way out.
  const payload = Buffer.alloc(70_000, 0x61);
  socket.write(clientFrame(OPCODE.text, payload, { force64: true }));
  const frame = await nextFrame(8000);
  assert.equal(frame.opcode, OPCODE.text);
  assert.equal(frame.lengthBytes, 8);
  assert.equal(frame.payload.length, 70_000);
  assert.equal(frame.payload.equals(payload), true);
});

test('16-bit lengths are used for mid-sized frames', () => {
  assert.equal(encodeFrame(OPCODE.text, Buffer.alloc(125))[1] & 0x7f, 125);
  assert.equal(encodeFrame(OPCODE.text, Buffer.alloc(126))[1] & 0x7f, 126);
  assert.equal(encodeFrame(OPCODE.text, Buffer.alloc(65_535))[1] & 0x7f, 126);
  assert.equal(encodeFrame(OPCODE.text, Buffer.alloc(65_536))[1] & 0x7f, 127);
  // Server frames are never masked.
  assert.equal(encodeFrame(OPCODE.text, Buffer.from('x'))[1] & 0x80, 0);
  assert.equal(encodeFrame(OPCODE.text, Buffer.from('x'), true)[1] & 0x80, 0x80);
});

test('an oversize message is closed with 1009 and never delivered', async (t) => {
  const echo = await startEchoWs({ maxMessageBytes: 1024, maxFrameBytes: 1024 });
  const client = browserClient(echo.port);
  t.after(async () => { client.ws.close(); await echo.close(); });

  await client.opened;
  client.send('x'.repeat(4096));
  const { code } = await client.closed;
  assert.equal(code, 1009);
  assert.equal(echo.events.some((e) => e.type === 'message'), false);
});

test('an oversize declared length is refused on the header alone', async (t) => {
  const echo = await startEchoWs({ maxMessageBytes: 1024, maxFrameBytes: 1024 });
  t.after(() => echo.close());

  const { socket, nextFrame } = await rawHandshake(echo.port);
  t.after(() => socket.destroy());

  // Claim 8 GiB and send ten bytes of header. Nothing should be buffered.
  const header = Buffer.alloc(14);
  header[0] = 0x80 | OPCODE.text;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(8n * 1024n * 1024n * 1024n, 2);
  socket.write(header);

  const frame = await nextFrame();
  assert.equal(frame.opcode, OPCODE.close);
  assert.equal(frame.payload.readUInt16BE(0), 1009);
});

test('a reserved bit or reserved opcode is a protocol error', async (t) => {
  const echo = await startEchoWs();
  t.after(() => echo.close());

  for (const first of [0x80 | 0x40 | OPCODE.text, 0x80 | 0x3]) {
    const { socket, nextFrame } = await rawHandshake(echo.port);
    const frame = clientFrame(OPCODE.text, 'nope');
    frame[0] = first;
    socket.write(frame);
    const reply = await nextFrame();
    assert.equal(reply.opcode, OPCODE.close);
    assert.equal(reply.payload.readUInt16BE(0), 1002, `first byte 0x${first.toString(16)}`);
    socket.destroy();
  }
});

test('invalid UTF-8 in a text frame is closed with 1007', async (t) => {
  const echo = await startEchoWs();
  t.after(() => echo.close());

  const { socket, nextFrame } = await rawHandshake(echo.port);
  t.after(() => socket.destroy());

  socket.write(clientFrame(OPCODE.text, Buffer.from([0xc3, 0x28])));
  const frame = await nextFrame();
  assert.equal(frame.opcode, OPCODE.close);
  assert.equal(frame.payload.readUInt16BE(0), 1007);
});

test('a close code and reason survive the trip in from a client', async (t) => {
  const echo = await startEchoWs();
  t.after(() => echo.close());

  const { socket, nextFrame } = await rawHandshake(echo.port);
  t.after(() => socket.destroy());

  socket.write(clientFrame(OPCODE.close, closeFrameBody(4001, 'going to sleep')));
  const echoed = await nextFrame();
  assert.equal(echoed.opcode, OPCODE.close);
  assert.equal(echoed.payload.readUInt16BE(0), 4001);

  const [closed] = await waitFor(() => (echo.closes().length ? echo.closes() : null), { label: 'the close event' });
  assert.equal(closed.code, 4001);
  assert.equal(closed.reason, 'going to sleep');
});

test('a close code and reason survive the trip out to a client', async (t) => {
  const echo = await startEchoWs();
  const client = browserClient(echo.port);
  t.after(async () => { await echo.close(); });

  await client.opened;
  const server = await waitFor(() => echo.last(), { label: 'the server-side connection' });
  server.close(4002, 'resident machine is going down');

  const { code, reason } = await client.closed;
  assert.equal(code, 4002);
  assert.equal(reason, 'resident machine is going down');
});

test('a close frame with a one-byte payload is a protocol error', async (t) => {
  const echo = await startEchoWs();
  t.after(() => echo.close());

  const { socket, nextFrame } = await rawHandshake(echo.port);
  t.after(() => socket.destroy());

  socket.write(clientFrame(OPCODE.close, Buffer.from([0x03])));
  const frame = await nextFrame();
  assert.equal(frame.opcode, OPCODE.close);
  assert.equal(frame.payload.readUInt16BE(0), 1002);
});

test('a throwing message handler does not kill the connection', async (t) => {
  const echo = await startEchoWs();
  t.after(() => echo.close());

  const { socket, nextFrame } = await rawHandshake(echo.port);
  t.after(() => socket.destroy());

  const server = await waitFor(() => echo.last(), { label: 'the server-side connection' });
  server.onMessage(() => { throw new Error('application handler exploded'); });

  socket.write(clientFrame(OPCODE.text, 'first'));
  assert.equal((await nextFrame()).payload.toString('utf8'), 'first');
  socket.write(clientFrame(OPCODE.text, 'second'));
  assert.equal((await nextFrame()).payload.toString('utf8'), 'second');
  assert.ok(echo.events.some((e) => e.type === 'error' && e.where === 'onMessage'));
});
