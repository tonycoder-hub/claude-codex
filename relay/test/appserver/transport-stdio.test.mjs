import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AppServerClient,
  TransportClosedError,
  ERROR_CODES,
  APPROVAL_METHODS,
  approvalResponder,
} from '../../src/appserver/client.mjs';
import { createStdioTransport } from '../../src/appserver/transport-stdio.mjs';
import { NdjsonDecoder, encodeNdjson } from '../../src/appserver/ndjson.mjs';
import { settle, commandApprovalParams, fileChangeApprovalParams } from './fakes.mjs';

/**
 * Wait for a condition, letting the event loop turn between attempts. Socket
 * traffic is real I/O even over a unix socket in one process, so a single
 * microtask drain is not enough to assert that bytes arrived. No timers: a
 * `setImmediate` loop yields to the poll phase just as well, and cannot flake
 * on a slow machine the way a fixed sleep can.
 */
async function waitFor(probe, what = 'a condition') {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const value = probe();
    if (value) return value;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
}

const once = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve));

/**
 * A fake app-server on a unix socket: real sockets, real NDJSON framing, real
 * partial writes. A unix socket rather than a TCP port so the test needs no
 * network permission and cannot collide with anything.
 */
async function startFakeServer(onMessage) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-appserver-'));
  const path = join(dir, 'app-server.sock');
  const peers = [];
  const server = net.createServer((socket) => {
    socket.on('error', () => {}); // a client that vanishes is not a test failure
    const peer = {
      socket,
      /** Write one framed message. */
      send(message) {
        socket.write(encodeNdjson(message));
      },
    };
    peers.push(peer);
    const decoder = new NdjsonDecoder({ onMessage: (message) => onMessage(peer, message) });
    socket.on('data', (chunk) => decoder.push(chunk));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  return {
    path,
    /** The connection the client made, once the server has accepted it. */
    firstPeer() {
      return waitFor(() => peers[0], 'the server to accept a connection');
    },
    async close() {
      for (const peer of peers) peer.socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function connect(path) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** A connected duplex socket pair, for transport-only tests. */
async function socketPair() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-pair-'));
  const path = join(dir, 'pair.sock');
  let accept;
  const accepted = new Promise((resolve) => {
    accept = resolve;
  });
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    accept(socket);
  });
  await new Promise((resolve) => server.listen(path, resolve));
  const a = await connect(path);
  a.on('error', () => {});
  const b = await accepted;
  return {
    a,
    b,
    async close() {
      a.destroy();
      b.destroy();
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Collect everything the far end of a pair receives, decoded. */
function sink(socket) {
  const received = [];
  const decoder = new NdjsonDecoder({ onMessage: (message) => received.push(message) });
  socket.on('data', (chunk) => decoder.push(chunk));
  return received;
}

test('a transport needs a stream it can read and write', () => {
  assert.throws(() => createStdioTransport(null), TypeError);
  assert.throws(() => createStdioTransport({}), TypeError);
  assert.throws(() => createStdioTransport('a path'), TypeError);
});

test('objects round-trip over a real socket pair', async () => {
  const pair = await socketPair();
  try {
    const left = createStdioTransport(pair.a);
    const received = sink(pair.b);

    left.send({ jsonrpc: '2.0', id: 1, method: 'thread/start', params: { cwd: '/work' } });
    left.send({ jsonrpc: '2.0', method: 'initialized' });
    await waitFor(() => received.length === 2, 'two frames to arrive');

    assert.deepEqual(received, [
      { jsonrpc: '2.0', id: 1, method: 'thread/start', params: { cwd: '/work' } },
      { jsonrpc: '2.0', method: 'initialized' },
    ]);
  } finally {
    await pair.close();
  }
});

test('a frame split across two writes is still delivered whole', async () => {
  const pair = await socketPair();
  try {
    const left = createStdioTransport(pair.a);
    const received = [];
    left.onMessage((message) => received.push(message));

    const line = encodeNdjson({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'hi' } });
    pair.b.write(line.slice(0, 20));
    await waitFor(() => pair.a.bytesRead >= 20, 'the first half to arrive');
    assert.deepEqual(received, [], 'half a frame is not a message');

    pair.b.write(line.slice(20));
    await waitFor(() => received.length === 1, 'the reassembled frame');
    assert.equal(received[0].params.delta, 'hi');
  } finally {
    await pair.close();
  }
});

test('messages that arrive before onMessage is registered are not lost', async () => {
  const pair = await socketPair();
  try {
    const left = createStdioTransport(pair.a);
    pair.b.write(encodeNdjson({ jsonrpc: '2.0', method: 'turn/started', params: { turnId: 'tu_1' } }));
    await waitFor(() => pair.a.bytesRead > 0, 'the frame to arrive unobserved');

    // Only now does the client get wired up, which is the real sequence when a
    // socket is connected and awaited before the client is constructed.
    const received = [];
    left.onMessage((message) => received.push(message));
    assert.equal(received.length, 1);
    assert.equal(received[0].params.turnId, 'tu_1');
  } finally {
    await pair.close();
  }
});

test('a malformed line is reported and the stream keeps going', async () => {
  const pair = await socketPair();
  try {
    const errors = [];
    const left = createStdioTransport(pair.a, { onError: (error) => errors.push(error) });
    const received = [];
    left.onMessage((message) => received.push(message));

    pair.b.write('{ not json }\n');
    pair.b.write(encodeNdjson({ jsonrpc: '2.0', method: 'turn/completed' }));
    await waitFor(() => received.length === 1, 'the good frame after the bad one');

    assert.equal(received[0].method, 'turn/completed');
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /not valid JSON/);
  } finally {
    await pair.close();
  }
});

test('a final line with no trailing newline is flushed at EOF', async () => {
  const pair = await socketPair();
  try {
    const left = createStdioTransport(pair.a);
    const received = [];
    left.onMessage((message) => received.push(message));
    let closeCount = 0;
    left.onClose(() => {
      closeCount++;
    });

    pair.b.write('{"jsonrpc":"2.0","method":"turn/completed"}'); // no newline
    pair.b.end();
    await once(pair.a, 'close');
    await settle();

    assert.deepEqual(received, [{ jsonrpc: '2.0', method: 'turn/completed' }]);
    assert.equal(closeCount, 1, 'end and close must not both fire the hook');
  } finally {
    await pair.close();
  }
});

test('the far end hanging up closes the transport once', async () => {
  const pair = await socketPair();
  try {
    const left = createStdioTransport(pair.a);
    let closeCount = 0;
    left.onClose(() => {
      closeCount++;
    });
    pair.b.destroy();
    await once(pair.a, 'close');
    await settle();
    assert.equal(closeCount, 1);
    // Writing to the corpse must not throw.
    assert.doesNotThrow(() => left.send({ jsonrpc: '2.0', method: 'too/late' }));
  } finally {
    await pair.close();
  }
});

test('onClose registered after the stream already died still fires', async () => {
  const pair = await socketPair();
  try {
    const left = createStdioTransport(pair.a);
    pair.b.destroy();
    await once(pair.a, 'close');
    await settle();
    let fired = false;
    left.onClose(() => {
      fired = true;
    });
    assert.equal(fired, true, 'otherwise a late subscriber waits forever');
  } finally {
    await pair.close();
  }
});

test('close() flushes an already-queued write before tearing the socket down', async () => {
  const pair = await socketPair();
  try {
    const left = createStdioTransport(pair.a);
    const received = sink(pair.b);

    left.send({ jsonrpc: '2.0', method: 'goodbye' });
    left.close();
    await once(pair.b, 'end');
    assert.deepEqual(received, [{ jsonrpc: '2.0', method: 'goodbye' }]);
  } finally {
    await pair.close();
  }
});

test('a readable/writable pair is accepted as well as a duplex', async () => {
  const pair = await socketPair();
  try {
    // The shape a child process gives you, where the two halves are separate
    // objects rather than one duplex.
    const transport = createStdioTransport({ readable: pair.a, writable: pair.a });
    const received = [];
    transport.onMessage((message) => received.push(message));
    pair.b.write(encodeNdjson({ ok: true }));
    await waitFor(() => received.length === 1);
    assert.deepEqual(received, [{ ok: true }]);
  } finally {
    await pair.close();
  }
});

test('a child-process-shaped object is accepted via stdin/stdout', async () => {
  const pair = await socketPair();
  try {
    const transport = createStdioTransport({ stdin: pair.a, stdout: pair.a });
    const received = [];
    transport.onMessage((message) => received.push(message));
    const sent = sink(pair.b);

    transport.send({ from: 'client' });
    pair.b.write(encodeNdjson({ from: 'server' }));
    await waitFor(() => received.length === 1 && sent.length === 1);
    assert.deepEqual(received, [{ from: 'server' }]);
    assert.deepEqual(sent, [{ from: 'client' }]);
  } finally {
    await pair.close();
  }
});

test('a full conversation with a fake app-server over a unix socket', async () => {
  const serverLog = [];
  const server = await startFakeServer((peer, message) => {
    serverLog.push(message.method ?? `response:${message.id}`);
    if (message.method === 'thread/start') {
      peer.send({ jsonrpc: '2.0', id: message.id, result: { threadId: 'th_7' } });
      return;
    }
    if (message.method === 'turn/start') {
      peer.send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'th_7', turnId: 'tu_1' } });
      peer.send({ jsonrpc: '2.0', method: 'item/started', params: { itemId: 'it_1' } });
      // The adapter brackets the wait with a status change, then blocks on a
      // server→client request until the client answers.
      peer.send({
        jsonrpc: '2.0',
        method: 'thread/status/changed',
        params: { threadId: 'th_7', status: { type: 'active', activeFlags: ['waitingOnApproval'] } },
      });
      peer.send({
        jsonrpc: '2.0',
        id: 'approval-1',
        method: APPROVAL_METHODS.commandExecution,
        params: commandApprovalParams({ threadId: 'th_7', approvalId: 'approval-1' }),
      });
      return;
    }
    if (message.id === 'approval-1') {
      // Mirror the adapter: resolve the request, clear the flag, then let the
      // decision decide what the rest of the turn looks like. These assertions
      // cannot pass unless the real decision crossed the socket.
      peer.send({
        jsonrpc: '2.0',
        method: 'serverRequest/resolved',
        params: { threadId: 'th_7', requestId: 'approval-1' },
      });
      peer.send({
        jsonrpc: '2.0',
        method: 'thread/status/changed',
        params: { threadId: 'th_7', status: { type: 'active', activeFlags: [] } },
      });
      const accepted = message.result?.decision === 'acceptForSession';
      peer.send({
        jsonrpc: '2.0',
        method: 'item/agentMessage/delta',
        params: { itemId: 'it_2', delta: accepted ? 'ran it' : 'declined' },
      });
      peer.send({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { total: 1234 } });
      peer.send({ jsonrpc: '2.0', method: 'turn/completed', params: { turnId: 'tu_1' } });
      peer.send({ jsonrpc: '2.0', id: 2, result: { turnId: 'tu_1', status: 'completed' } });
    }
  });

  const socket = await connect(server.path);
  const protocolErrors = [];
  const transport = createStdioTransport(socket, { onError: (error) => protocolErrors.push(error) });
  const client = new AppServerClient(transport, { onProtocolError: (error) => protocolErrors.push(error) });

  try {
    const notifications = [];
    client.on('*', (params, method) => notifications.push([method, params]));

    const approvals = [];
    client.handle(APPROVAL_METHODS.commandExecution, approvalResponder((params) => {
      approvals.push({ command: params.command, cwd: params.cwd });
      return 'acceptForSession';
    }));

    assert.deepEqual(await client.call('thread/start', { cwd: '/work' }), { threadId: 'th_7' });
    const turn = await client.call('turn/start', { threadId: 'th_7', input: 'run the tests' });
    assert.deepEqual(turn, { turnId: 'tu_1', status: 'completed' });

    assert.deepEqual(approvals, [{ command: 'npm test', cwd: '/work' }], 'the approval round-tripped');
    assert.deepEqual(
      notifications.map(([method]) => method),
      [
        'turn/started',
        'item/started',
        'thread/status/changed',
        'serverRequest/resolved',
        'thread/status/changed',
        'item/agentMessage/delta',
        'thread/tokenUsage/updated',
        'turn/completed',
      ],
    );
    assert.deepEqual(notifications[2][1].status.activeFlags, ['waitingOnApproval']);
    assert.deepEqual(notifications[4][1].status.activeFlags, []);
    assert.equal(notifications[5][1].delta, 'ran it', 'the server saw acceptForSession, not a default');
    assert.deepEqual(protocolErrors, []);
    assert.deepEqual(serverLog, ['thread/start', 'turn/start', 'response:approval-1']);
  } finally {
    client.close();
    await server.close();
  }
});

test('an unhandled approval request is answered -32601 across a real socket', async () => {
  const answers = [];
  const server = await startFakeServer((peer, message) => {
    if (message.method === 'turn/start') {
      peer.send({
        jsonrpc: '2.0',
        id: 'approval-9',
        method: APPROVAL_METHODS.fileChange,
        params: fileChangeApprovalParams(),
      });
      return;
    }
    if (message.id === 'approval-9') {
      answers.push(message);
      peer.send({ jsonrpc: '2.0', id: 1, result: { status: 'failed' } });
    }
  });

  const socket = await connect(server.path);
  const client = new AppServerClient(createStdioTransport(socket));
  try {
    // No handler is registered. The server must still get an answer, or its turn
    // would sit on an unresolved promise forever.
    assert.deepEqual(await client.call('turn/start', { threadId: 'th_1' }), { status: 'failed' });
    assert.equal(answers.length, 1);
    assert.equal(answers[0].error.code, ERROR_CODES.methodNotFound);
    assert.equal(answers[0].result, undefined);
  } finally {
    client.close();
    await server.close();
  }
});

test('the server dropping the socket rejects everything in flight', async () => {
  const server = await startFakeServer(() => {});
  const socket = await connect(server.path);
  const client = new AppServerClient(createStdioTransport(socket));
  try {
    // Settle both into outcomes up front. The rejection arrives from an I/O
    // callback, and a promise whose handler is attached only afterwards counts
    // as an unhandled rejection in between.
    const outcomes = [client.call('thread/start'), client.call('turn/start')]
      .map((call) => call.then(() => null, (error) => error));

    const peer = await server.firstPeer();
    peer.socket.destroy();
    await once(socket, 'close');

    for (const outcome of await Promise.all(outcomes)) {
      assert.ok(outcome instanceof TransportClosedError, `expected a close rejection, got ${outcome}`);
    }
    assert.equal(client.closed, true);
    await assert.rejects(client.call('thread/read'), TransportClosedError);
  } finally {
    await server.close();
  }
});
