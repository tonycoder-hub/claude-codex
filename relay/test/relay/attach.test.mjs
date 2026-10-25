import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { OPCODE, encodeFrame } from '../../src/surface/ws.mjs';
import { attachPath } from '../../src/relay/protocol.mjs';
import {
  announcedEnd,
  attachSocket,
  joinedPair,
  pairSocket,
  startRelay,
  waitFor,
} from './harness.mjs';

// Irregular spacing and key order on purpose: a relay that re-encodes what it
// carries is a relay that has started understanding it.
const REQUEST = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"client":{"name":"codex",  "v":[1,0]}}}';
const RESPONSE = '{"jsonrpc":"2.0","id":1,"result":{"capabilities":{}}}';

test('a client attaching without ?as= is refused by that name', async (t) => {
  const { port } = await startRelay(t);
  await announcedEnd(t, port, { end: 'alpha', pid: 1 });
  for (const as of [undefined, '', '   ']) {
    const client = attachSocket(t, port, { end: 'alpha', as });
    await client.opened;
    const { reason } = await client.closed;
    assert.equal(reason, 'attach without a client end name (?as=)', JSON.stringify(as));
  }
});

test('a client attaching to a name nobody holds is told so', async (t) => {
  const { port } = await startRelay(t);
  const client = attachSocket(t, port, { end: 'ghost', as: 'phone' });
  await client.opened;
  assert.equal((await client.closed).reason, 'no end named ghost is here');
});

test('an end whose control socket died is no longer attachable', async (t) => {
  const { port } = await startRelay(t);
  const control = await announcedEnd(t, port, { end: 'alpha', pid: 1 });
  control.ws.close(1000, 'gone');
  await control.closed;

  const client = await waitFor(async () => {
    const attempt = attachSocket(t, port, { end: 'alpha', as: 'phone' });
    await attempt.opened;
    const closed = await attempt.closed;
    return closed.reason === 'no end named alpha is here' ? attempt : null;
  }, { label: 'the end to stop being attachable' });
  assert.ok(client);
});

test('the end is told to dial back, with a pairing and the client name', async (t) => {
  const { port } = await startRelay(t);
  const control = await announcedEnd(t, port, { end: 'alpha', pid: 1 });
  const client = attachSocket(t, port, { end: 'alpha', as: 'phone' });
  await client.opened;

  const dial = await control.nextJson();
  assert.equal(dial.kind, 'dial-back');
  assert.equal(dial.clientEnd, 'phone');
  assert.match(dial.pairing, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(dial).sort(), ['clientEnd', 'kind', 'pairing']);
});

test('a joined pair carries text verbatim in both directions', async (t) => {
  const { port } = await startRelay(t);
  const { client, endSide } = await joinedPair(t, port, { end: 'alpha', as: 'phone' });

  client.send(REQUEST);
  assert.equal(await endSide.next(), REQUEST);
  endSide.send(RESPONSE);
  assert.equal(await client.next(), RESPONSE);

  // Byte-identical, not merely JSON-equivalent.
  client.send(REQUEST);
  assert.deepEqual(Buffer.from(String(await endSide.next()), 'utf8'), Buffer.from(REQUEST, 'utf8'));
});

test('a joined pair carries bytes that are not text at all', async (t) => {
  const { port } = await startRelay(t);
  const { client, endSide } = await joinedPair(t, port, { end: 'alpha', as: 'phone' });
  // Invalid UTF-8 on purpose: a lone continuation byte and a bare surrogate
  // half. Anything that decoded and re-encoded this would corrupt it.
  const bytes = Buffer.from([0x00, 0x80, 0xfe, 0xff, 0xed, 0xa0, 0x80, 0x7f]);

  client.send(bytes);
  const atEnd = await endSide.next();
  assert.ok(Buffer.isBuffer(atEnd), 'a binary frame stays binary');
  assert.deepEqual(atEnd, bytes);

  endSide.send(bytes);
  const atClient = await client.next();
  assert.ok(Buffer.isBuffer(atClient));
  assert.deepEqual(atClient, bytes);
});

test('frames the client sends before the end dials back are replayed in order', async (t) => {
  const { port } = await startRelay(t);
  const control = await announcedEnd(t, port, { end: 'alpha', pid: 1 });
  const client = attachSocket(t, port, { end: 'alpha', as: 'phone' });
  await client.opened;
  const dial = await control.nextJson();

  // The client speaks first: this is the App Server handshake, not a greeting.
  const sent = ['{"id":1,"method":"initialize"}', '{"id":2,"method":"session/new"}', '{"id":3,"method":"session/list"}'];
  for (const frame of sent) client.send(frame);
  // Let them arrive while the end is still dialling.
  await new Promise((res) => setTimeout(res, 40));

  const endSide = pairSocket(t, port, dial.pairing);
  await endSide.opened;
  const received = [await endSide.next(), await endSide.next(), await endSide.next()];
  assert.deepEqual(received.map(String), sent);

  // And the live path picks up exactly where the backlog left off.
  client.send('{"id":4,"method":"after"}');
  assert.equal(await endSide.next(), '{"id":4,"method":"after"}');
});

test('a backlog mixing text and binary keeps both its order and its opcodes', async (t) => {
  const { port } = await startRelay(t);
  const control = await announcedEnd(t, port, { end: 'alpha', pid: 1 });
  const client = attachSocket(t, port, { end: 'alpha', as: 'phone' });
  await client.opened;
  const dial = await control.nextJson();

  const binary = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  client.send('first-text');
  client.send(binary);
  client.send('third-text');
  await new Promise((res) => setTimeout(res, 40));

  const endSide = pairSocket(t, port, dial.pairing);
  await endSide.opened;
  const a = await endSide.next();
  const b = await endSide.next();
  const c = await endSide.next();
  assert.equal(a, 'first-text');
  assert.ok(Buffer.isBuffer(b));
  assert.deepEqual(b, binary);
  assert.equal(c, 'third-text');
});

test('one client identity fans out to two ends, and both attachments work', async (t) => {
  const { port } = await startRelay(t);
  // The case that keying attachments by client name alone would break: this is
  // normal fan-out, not a duplicate.
  const first = await joinedPair(t, port, { end: 'alpha', as: 'phone' });
  const second = await joinedPair(t, port, { end: 'beta', as: 'phone' });

  first.client.send('to-alpha');
  second.client.send('to-beta');
  assert.equal(await first.endSide.next(), 'to-alpha');
  assert.equal(await second.endSide.next(), 'to-beta');

  // And nothing crossed over.
  first.endSide.send('from-alpha');
  second.endSide.send('from-beta');
  assert.equal(await first.client.next(), 'from-alpha');
  assert.equal(await second.client.next(), 'from-beta');
  assert.deepEqual(first.client.messages, []);
});

test('the same client identity cannot attach to the same end twice', async (t) => {
  const { port } = await startRelay(t);
  const { client } = await joinedPair(t, port, { end: 'alpha', as: 'phone' });

  const duplicate = attachSocket(t, port, { end: 'alpha', as: 'phone' });
  await duplicate.opened;
  assert.equal((await duplicate.closed).reason, 'client end phone is already attached to alpha');
  assert.equal(client.ws.readyState, WebSocket.OPEN, 'the incumbent is untouched');
});

test('two client identities may attach to one end at the same time', async (t) => {
  const { port } = await startRelay(t);
  const control = await announcedEnd(t, port, { end: 'alpha', pid: 1 });

  const phone = attachSocket(t, port, { end: 'alpha', as: 'phone' });
  await phone.opened;
  const phoneDial = await control.nextJson();
  const laptop = attachSocket(t, port, { end: 'alpha', as: 'laptop' });
  await laptop.opened;
  const laptopDial = await control.nextJson();
  assert.notEqual(phoneDial.pairing, laptopDial.pairing);

  const forPhone = pairSocket(t, port, phoneDial.pairing);
  const forLaptop = pairSocket(t, port, laptopDial.pairing);
  await Promise.all([forPhone.opened, forLaptop.opened]);

  phone.send('from-phone');
  laptop.send('from-laptop');
  assert.equal(await forPhone.next(), 'from-phone');
  assert.equal(await forLaptop.next(), 'from-laptop');
});

test('a client may reattach to the same end once its first socket is gone', async (t) => {
  const { port } = await startRelay(t);
  const first = await joinedPair(t, port, { end: 'alpha', as: 'phone' });
  first.client.ws.close(1000, 'moved to another network');
  await first.client.closed;

  const again = await waitFor(async () => {
    const attempt = attachSocket(t, port, { end: 'alpha', as: 'phone' });
    try {
      await attempt.opened;
    } catch {
      return null;
    }
    // A refusal arrives as a close; a success stays open.
    const outcome = await Promise.race([
      attempt.closed.then((c) => ({ closed: c })),
      new Promise((res) => setTimeout(() => res({ open: attempt }), 60)),
    ]);
    return outcome.open ?? null;
  }, { label: 'the reattach to be accepted' });
  assert.equal(again.ws.readyState, WebSocket.OPEN);
});

test('a pairing is one-time: the second dial-back with it is refused', async (t) => {
  const { port } = await startRelay(t);
  const { dial, endSide } = await joinedPair(t, port, { end: 'alpha', as: 'phone' });
  assert.equal(endSide.ws.readyState, WebSocket.OPEN);

  const replay = pairSocket(t, port, dial.pairing);
  await replay.opened;
  assert.equal((await replay.closed).reason, 'unknown or already-used pairing');
  assert.equal(endSide.ws.readyState, WebSocket.OPEN, 'the real pair is undisturbed');
});

test('an unknown or missing pairing is refused the same way', async (t) => {
  const { port } = await startRelay(t);
  for (const pairing of ['', 'not-a-pairing', '00000000-0000-4000-8000-000000000000']) {
    const dialler = pairSocket(t, port, pairing);
    await dialler.opened;
    assert.equal((await dialler.closed).reason, 'unknown or already-used pairing', JSON.stringify(pairing));
  }
});

test('a client whose end never dials back is told that, after the timeout', async (t) => {
  const { port } = await startRelay(t, { pairingTimeoutMs: 60 });
  const control = await announcedEnd(t, port, { end: 'alpha', pid: 1 });
  const client = attachSocket(t, port, { end: 'alpha', as: 'phone' });
  await client.opened;
  // The end hears the dial-back and does nothing with it.
  await control.nextJson();
  assert.equal((await client.closed).reason, 'end alpha did not dial back');
});

test('a pairing discarded by the timeout is not honoured afterwards', async (t) => {
  const { port } = await startRelay(t, { pairingTimeoutMs: 60 });
  const control = await announcedEnd(t, port, { end: 'alpha', pid: 1 });
  const client = attachSocket(t, port, { end: 'alpha', as: 'phone' });
  await client.opened;
  const dial = await control.nextJson();
  await client.closed;

  const late = pairSocket(t, port, dial.pairing);
  await late.opened;
  assert.equal((await late.closed).reason, 'unknown or already-used pairing');
});

test('an end dialling back for a client that left is told which thing went wrong', async (t) => {
  const { port } = await startRelay(t, { pairingTimeoutMs: 5_000 });
  const control = await announcedEnd(t, port, { end: 'alpha', pid: 1 });
  const client = attachSocket(t, port, { end: 'alpha', as: 'phone' });
  await client.opened;
  const dial = await control.nextJson();
  client.ws.close(1000, 'changed my mind');
  await client.closed;

  // "Gone" and "never heard of it" are different facts, and only one of them
  // means the end should stop trying.
  const late = pairSocket(t, port, dial.pairing);
  await late.opened;
  assert.equal((await late.closed).reason, 'the client that asked for this pairing is gone');
});

test('closing the client closes the end side, with its code and reason', async (t) => {
  const { port } = await startRelay(t);
  const { client, endSide } = await joinedPair(t, port, { end: 'alpha', as: 'phone' });
  client.ws.close(4001, 'the phone went to sleep');
  const closed = await endSide.closed;
  assert.equal(closed.code, 4001);
  assert.equal(closed.reason, 'the phone went to sleep');
});

test('closing the end side closes the client', async (t) => {
  const { port } = await startRelay(t);
  const { client, endSide } = await joinedPair(t, port, { end: 'alpha', as: 'phone' });
  endSide.ws.close(4002, 'the app server exited');
  const closed = await client.closed;
  assert.equal(closed.code, 4002);
  assert.equal(closed.reason, 'the app server exited');
});

test('the end control socket going away does not disturb a joined pair', async (t) => {
  const { port } = await startRelay(t);
  const { control, client, endSide } = await joinedPair(t, port, { end: 'alpha', as: 'phone' });
  control.ws.close(1000, 'control socket only');
  await control.closed;
  await new Promise((res) => setTimeout(res, 50));

  // The registration is gone, but a conversation already in progress is not
  // the registration's to end.
  client.send('still talking');
  assert.equal(await endSide.next(), 'still talking');
  assert.equal(client.ws.readyState, WebSocket.OPEN);
});

test('the pairing never appears in a log record', async (t) => {
  const { port, logger } = await startRelay(t, { pairingTimeoutMs: 60 });
  const { dial } = await joinedPair(t, port, { end: 'alpha', as: 'phone' });
  // And again down the refusal paths, which is where a value tends to leak
  // into a message.
  const replay = pairSocket(t, port, dial.pairing);
  await replay.opened;
  await replay.closed;
  const timedOut = attachSocket(t, port, { end: 'alpha', as: 'tablet' });
  await timedOut.opened;
  await timedOut.closed;

  const text = logger.text();
  assert.equal(text.includes(dial.pairing), false);
  // It is not in any path either -- there is no path it could be in.
  assert.equal(text.includes('/pair?'), false);
  assert.ok(logger.records.some((r) => r.event === 'relay.paired'));
  assert.ok(logger.records.some((r) => r.event === 'relay.no_dial_back'));
});

test('a client that speaks in the same packet as its upgrade is still heard', async (t) => {
  // The one way a websocket endpoint loses a message with nothing to show for
  // it: the upgrade request and the first frame arrive in a single read, so
  // the frame is sitting in the handshake's leftover bytes before anybody
  // holds a connection to register a handler on. An App Server client opens
  // with `initialize` and no greeting, which makes this the ordinary case and
  // not a corner -- and the backlog this whole path exists for would be empty
  // exactly when it matters most.
  const { port } = await startRelay(t);
  const control = await announcedEnd(t, port, { end: 'alpha', connection: 'c-1', pid: 4242 });

  const socket = connect({ host: '127.0.0.1', port });
  t.after(() => socket.destroy());
  await new Promise((res, rej) => {
    socket.once('connect', res);
    socket.once('error', rej);
  });
  const headers = [
    `GET ${attachPath('alpha', 'phone')} HTTP/1.1`,
    'Host: 127.0.0.1',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${Buffer.alloc(16, 7).toString('base64')}`,
    'Sec-WebSocket-Version: 13',
  ];
  // Deliberately one write, so the two land in one packet.
  socket.write(Buffer.concat([
    Buffer.from(`${headers.join('\r\n')}\r\n\r\n`, 'latin1'),
    encodeFrame(OPCODE.text, Buffer.from(REQUEST, 'utf8'), true),
  ]));

  const dial = await control.nextJson();
  const endSide = pairSocket(t, port, dial.pairing);
  await endSide.opened;
  assert.equal(await endSide.next(), REQUEST);
});
