import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AppServerClient,
  ERROR_CODES,
  TransportClosedError,
  APPROVAL_METHODS,
  approvalResponder,
} from '../../src/appserver/client.mjs';
import { createWebSocketTransport } from '../../src/appserver/transport-websocket.mjs';
import { FakeWebSocket, settle, fileChangeApprovalParams, userInputParams } from './fakes.mjs';

/** A transport over a controllable socket, with errors recorded. */
function harness() {
  const socket = new FakeWebSocket();
  const errors = [];
  const transport = createWebSocketTransport(socket, { onError: (error) => errors.push(error) });
  return { socket, transport, errors, frames: socket.frames };
}

const parsed = (socket) => socket.frames.map((text) => JSON.parse(text));

test('a URL or a socket is required', () => {
  assert.throws(() => createWebSocketTransport(123), TypeError);
  assert.throws(() => createWebSocketTransport(null), TypeError);
  assert.throws(() => createWebSocketTransport({}), TypeError);
});

test('a URL is handed to the global WebSocket', () => {
  const original = globalThis.WebSocket;
  const built = [];
  // Substituted rather than connected: this asserts the construction path, and
  // a test has no business opening a socket to find out.
  globalThis.WebSocket = class extends FakeWebSocket {
    constructor(url, protocols) {
      super();
      built.push({ url, protocols });
    }
  };
  try {
    const transport = createWebSocketTransport('wss://relay.example/appserver', { protocols: 'codex' });
    assert.deepEqual(built, [{ url: 'wss://relay.example/appserver', protocols: 'codex' }]);
    assert.ok(transport.socket instanceof FakeWebSocket);
    createWebSocketTransport(new URL('wss://relay.example/other'));
    assert.equal(built[1].url, 'wss://relay.example/other');
    assert.equal(built[1].protocols, undefined, 'no protocols argument when none was asked for');
  } finally {
    globalThis.WebSocket = original;
  }
});

test('binaryType is pinned to arraybuffer so no Blob can reorder messages', () => {
  const { socket } = harness();
  assert.equal(socket.binaryType, 'arraybuffer');
});

test('sends made while CONNECTING are queued and flushed in order on open', () => {
  const { socket, transport } = harness();
  transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  transport.send({ jsonrpc: '2.0', method: 'initialized' });
  assert.deepEqual(socket.frames, [], 'nothing can go out before the handshake finishes');

  socket.open();
  assert.deepEqual(parsed(socket), [
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', method: 'initialized' },
  ]);
});

test('once open, sends go straight out as one JSON object per frame', () => {
  const { socket, transport } = harness();
  socket.open();
  transport.send({ jsonrpc: '2.0', id: 1, method: 'turn/start' });
  assert.equal(socket.frames.length, 1);
  assert.ok(!socket.frames[0].includes('\n'), 'WebSocket frames are not newline-delimited');
  assert.deepEqual(JSON.parse(socket.frames[0]), { jsonrpc: '2.0', id: 1, method: 'turn/start' });
});

test('a send on a closed socket is dropped rather than thrown', () => {
  const { socket, transport } = harness();
  socket.open();
  socket.remoteClose();
  assert.doesNotThrow(() => transport.send({ jsonrpc: '2.0', method: 'too/late' }));
  assert.deepEqual(socket.frames, []);
});

test('queued sends are discarded if the socket dies before opening', () => {
  const { socket, transport } = harness();
  transport.send({ jsonrpc: '2.0', method: 'never/arrives' });
  socket.remoteClose(1006);
  socket.open(); // a pathological socket; the queue must already be gone
  assert.deepEqual(socket.frames, [], 'a message queued for a dead socket has no "later"');
});

test('a message that will not serialise is reported, not thrown', () => {
  const { socket, transport, errors } = harness();
  socket.open();
  const cyclic = {};
  cyclic.self = cyclic;
  assert.doesNotThrow(() => transport.send(cyclic));
  assert.equal(errors.length, 1);
  assert.deepEqual(socket.frames, []);
});

test('an inbound text frame is parsed and delivered', () => {
  const { socket, transport } = harness();
  socket.open();
  const received = [];
  transport.onMessage((message) => received.push(message));
  socket.deliver('{"jsonrpc":"2.0","method":"item/started","params":{"itemId":"it_1"}}');
  assert.deepEqual(received, [{ jsonrpc: '2.0', method: 'item/started', params: { itemId: 'it_1' } }]);
});

test('frames arriving before onMessage is registered are replayed, in order', () => {
  const { socket, transport } = harness();
  socket.open();
  socket.deliver('{"n":1}');
  socket.deliver('{"n":2}');
  const received = [];
  transport.onMessage((message) => received.push(message));
  assert.deepEqual(received.map((message) => message.n), [1, 2]);
});

test('binary frames are decoded as UTF-8 text', () => {
  const { socket, transport } = harness();
  const received = [];
  transport.onMessage((message) => received.push(message));
  const text = '{"text":"café"}';
  socket.deliver(new TextEncoder().encode(text)); // a view
  const view = new TextEncoder().encode(text);
  socket.deliver(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)); // an ArrayBuffer
  assert.deepEqual(received, [{ text: 'café' }, { text: 'café' }]);
});

test('an empty frame is ignored, not reported', () => {
  const { socket, transport, errors } = harness();
  const received = [];
  transport.onMessage((message) => received.push(message));
  socket.deliver('');
  socket.deliver('   ');
  assert.deepEqual(received, []);
  assert.deepEqual(errors, []);
});

test('an unparseable frame is reported and the next one still arrives', () => {
  const { socket, transport, errors } = harness();
  const received = [];
  transport.onMessage((message) => received.push(message));
  socket.deliver('{ not json');
  socket.deliver('{"n":1}');
  assert.deepEqual(received, [{ n: 1 }]);
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof SyntaxError);
});

test('an unsupported frame type is reported rather than crashing the handler', () => {
  const { socket, transport, errors } = harness();
  transport.onMessage(() => {});
  assert.doesNotThrow(() => socket.deliver({ not: 'a frame' }));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /unsupported WebSocket frame type/);
});

test('a socket error is surfaced without being mistaken for a close', () => {
  const { socket, errors, transport } = harness();
  let closed = false;
  transport.onClose(() => {
    closed = true;
  });
  socket.fail();
  assert.equal(errors.length, 1);
  assert.equal(closed, false, 'the close event is what closes the transport');
  socket.remoteClose();
  assert.equal(closed, true);
});

test('the close event fires onClose exactly once', () => {
  const { socket, transport } = harness();
  let closeCount = 0;
  transport.onClose(() => {
    closeCount++;
  });
  socket.open();
  socket.remoteClose();
  socket.remoteClose();
  assert.equal(closeCount, 1);
});

test('close() closes the socket and fires onClose once', () => {
  const { socket, transport } = harness();
  let closeCount = 0;
  transport.onClose(() => {
    closeCount++;
  });
  socket.open();
  transport.close(4000, 'done');
  assert.deepEqual(socket.closeCalls, [{ code: 4000, reason: 'done' }]);
  assert.equal(closeCount, 1);
});

test('close() on a socket that never opened still releases the caller', () => {
  const { socket, transport } = harness();
  let closed = false;
  transport.onClose(() => {
    closed = true;
  });
  transport.close();
  assert.equal(closed, true);
  assert.deepEqual(socket.closeCalls, [{ code: undefined, reason: undefined }]);
});

test('onClose registered after the socket already closed fires immediately', () => {
  const { socket, transport } = harness();
  socket.remoteClose();
  let closed = false;
  transport.onClose(() => {
    closed = true;
  });
  assert.equal(closed, true);
});

test('a client on a WebSocket transport runs a whole turn, approval included', async () => {
  const socket = new FakeWebSocket();
  const protocolErrors = [];
  const client = new AppServerClient(createWebSocketTransport(socket), {
    onProtocolError: (error) => protocolErrors.push(error),
  });

  // The call is made while the handshake is still in flight, which is exactly
  // how a page that constructs its client at module scope behaves.
  const thread = client.call('thread/start', { cwd: '/work' });
  assert.deepEqual(socket.frames, []);
  socket.open();
  assert.deepEqual(parsed(socket)[0], {
    jsonrpc: '2.0',
    id: 1,
    method: 'thread/start',
    params: { cwd: '/work' },
  });

  socket.deliver(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { threadId: 'th_1' } }));
  assert.deepEqual(await thread, { threadId: 'th_1' });

  const deltas = [];
  client.on('item/agentMessage/delta', (params) => deltas.push(params.delta));
  client.handle(APPROVAL_METHODS.fileChange, approvalResponder((params) => {
    assert.equal(params.threadId, 'th_1');
    assert.equal(params.grantRoot, null);
    return 'decline';
  }));

  socket.deliver(JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'hi' } }));
  socket.deliver(JSON.stringify({
    jsonrpc: '2.0',
    id: 'approval-1',
    method: APPROVAL_METHODS.fileChange,
    params: fileChangeApprovalParams(),
  }));
  await settle();

  assert.deepEqual(deltas, ['hi']);
  assert.deepEqual(JSON.parse(socket.frames.at(-1)), {
    jsonrpc: '2.0',
    id: 'approval-1',
    result: { decision: 'decline' },
  });

  const stranded = client.call('turn/start', { threadId: 'th_1' });
  socket.remoteClose();
  await assert.rejects(stranded, TransportClosedError);
  assert.equal(client.closed, true);
  assert.deepEqual(protocolErrors, []);
});

test('an unhandled approval over a WebSocket still gets -32601', async () => {
  const socket = new FakeWebSocket();
  const client = new AppServerClient(createWebSocketTransport(socket));
  socket.open();
  socket.deliver(JSON.stringify({
    jsonrpc: '2.0',
    id: 'approval-2',
    method: APPROVAL_METHODS.userInput,
    params: userInputParams(),
  }));
  await settle();
  const reply = JSON.parse(socket.frames.at(-1));
  assert.equal(reply.id, 'approval-2');
  assert.equal(reply.error.code, ERROR_CODES.methodNotFound);
  client.close();
});
