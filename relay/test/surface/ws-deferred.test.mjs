// A peer may speak in the same packet as the handshake, and in this project it
// routinely does: a client whose protocol opens with a request rather than a
// greeting always does, and the relay replays a backlog onto a freshly paired
// socket on purpose. Those pre-read bytes used to be dispatched synchronously
// from the constructor, before the caller had a line in which to register a
// handler, so the first frame -- the `initialize`, the one that matters --
// vanished with nothing anywhere to show for it.
//
// These tests pin both halves of the fix: the frames survive one turn of the
// loop, and if the caller still has not registered a handler by then, that is
// reported rather than being dropped a tick later than before.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { acceptUpgrade, OPCODE } from '../../src/surface/ws.mjs';
import { clientFrame, waitFor } from './harness.mjs';

/**
 * A socket good enough for acceptUpgrade. Deliberately not a PassThrough: the
 * two directions have to stay separate, or the 101 response the connection
 * writes loops straight back into its own parser and is read as a garbage
 * frame. Inbound bytes are delivered with `push`.
 */
function fakeSocket() {
  const written = [];
  const socket = new Duplex({
    read() {},
    write(chunk, _enc, cb) { written.push(chunk); cb(); },
  });
  socket.setNoDelay = () => socket;
  socket.destroySoon = () => socket.destroy();
  socket.written = written;
  return socket;
}

const upgradeRequest = () => ({
  method: 'GET',
  headers: {
    upgrade: 'websocket',
    connection: 'Upgrade',
    'sec-websocket-version': '13',
    'sec-websocket-key': Buffer.alloc(16).toString('base64'),
  },
});

test('a frame pipelined with the handshake survives until a handler exists', async (t) => {
  const socket = fakeSocket();
  t.after(() => socket.destroy());
  const head = clientFrame(OPCODE.text, 'initialize');

  const ws = acceptUpgrade(upgradeRequest(), socket, head, {});
  assert.ok(ws);

  // Registering on the very next line is the supported pattern, and it is the
  // line the old code did not leave room for.
  const seen = [];
  ws.onMessage((data) => seen.push(data.toString('utf8')));

  await waitFor(() => seen.length === 1);
  assert.deepEqual(seen, ['initialize']);
});

test('pre-read frames arriving with no handler are reported, not dropped quietly', async (t) => {
  const socket = fakeSocket();
  t.after(() => socket.destroy());
  const errors = [];

  // A caller that awaits real I/O before registering lands here. Losing the
  // frame is still the outcome -- the parser has nobody to hand it to -- but a
  // silent loss is the one failure shape this module must never produce.
  acceptUpgrade(upgradeRequest(), socket, clientFrame(OPCODE.text, 'initialize'), {
    onError: (err, phase) => errors.push({ message: err.message, phase }),
  });

  await waitFor(() => errors.length > 0);
  assert.equal(errors[0].phase, 'deferred');
  assert.match(errors[0].message, /before any message handler was registered/);
});

test('no pre-read bytes means no report', async (t) => {
  const socket = fakeSocket();
  t.after(() => socket.destroy());
  const errors = [];

  // The overwhelmingly common case: a browser's WebSocket sends nothing until
  // open, so head is empty. It must stay quiet.
  const ws = acceptUpgrade(upgradeRequest(), socket, Buffer.alloc(0), {
    onError: (err, phase) => errors.push({ message: err.message, phase }),
  });
  assert.ok(ws);

  await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
  assert.deepEqual(errors, []);
});

test('bytes arriving after the handshake queue behind the pre-read ones', async (t) => {
  const socket = fakeSocket();
  t.after(() => socket.destroy());

  // Order is the whole point: the deferral must not let a later frame overtake
  // the one that came in the handshake packet.
  const ws = acceptUpgrade(upgradeRequest(), socket, clientFrame(OPCODE.text, 'first'), {});
  const seen = [];
  ws.onMessage((data) => seen.push(data.toString('utf8')));
  socket.push(clientFrame(OPCODE.text, 'second'));

  await waitFor(() => seen.length === 2);
  assert.deepEqual(seen, ['first', 'second']);
});
