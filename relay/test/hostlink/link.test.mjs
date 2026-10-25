// The wiring, tested on the sequencing nobody can see go wrong.
//
// Three failures motivate most of what follows and none of them throws, logs,
// or shows up in a count of messages delivered:
//
//   * a reply that comes back under the wrong field name -- everything flows,
//     nothing resolves;
//   * a reply correlated to the wrong id space -- the client's integer instead
//     of the renderer's -- which is a turn that hangs while the wire looks
//     perfect;
//   * a reply emitted for hostId `local` before the renderer registered a
//     client, which is the one inbound case that makes the renderer THROW, and
//     which no amount of message-shape testing would catch.
//
// So the assertions here are mostly about absence and order: what did NOT reach
// the window, and in which sequence what did. Everything runs on a fake
// transport and a fake window -- there is no child process, no socket and no
// real app-server anywhere in this file, and there must not be.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  CONNECTION_STATE_DISCONNECTED,
  createHostLink,
  HOST_ERROR_CODE,
  LINK_EVENT,
  MAX_EVENT_STREAM_SUBSCRIPTIONS,
  MAX_FOREIGN_FRAMES,
  MUST_SUCCEED_FALLBACKS,
  SERVER_REQUEST_METHODS,
} from '../../web/hostlink/link.mjs';
import { APP_SERVER_RESULT_SHAPES } from '../../web/host-protocol.mjs';
import { APPROVAL_METHODS, ERROR_CODES, JSONRPC_VERSION } from '../../src/appserver/client.mjs';
import { commandApprovalParams, fakeTransport, settle } from '../appserver/fakes.mjs';
import { collect, dispatchMessageFromView, makeWindow } from '../web/host-fakes.mjs';

const APPROVAL_ID = 'c0ffee00-0000-4000-8000-000000000000';

function harness(options = {}) {
  const window = makeWindow();
  const fake = fakeTransport();
  const events = [];
  const protocolErrors = [];
  const link = createHostLink({
    window,
    transport: fake.transport,
    onEvent: (event) => events.push(event),
    onProtocolError: (error) => protocolErrors.push(error),
    ...options,
  });
  const inbound = collect(window, 'message');
  return { window, fake, link, events, protocolErrors, inbound };
}

/** The renderer's request client, sending through its real transport shape. */
const rendererRequest = (window, request, extra = {}) =>
  dispatchMessageFromView(window, 'mcp-request', { hostId: 'local', request, ...extra });

const kinds = (events) => events.map((event) => event.kind);
const types = (inbound) => inbound.data().map((message) => message.type);

// ---- the two id spaces -----------------------------------------------------

test('a renderer request reaches the app-server and its reply comes back', async () => {
  const { window, fake, link, inbound } = harness();
  rendererRequest(window, { id: 7, method: 'thread/start', params: { cwd: '/work' } });

  // Outbound: the client's OWN id, not the renderer's.
  assert.deepEqual(fake.last, {
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: 'thread/start',
    params: { cwd: '/work' },
  });

  fake.receive({ jsonrpc: JSONRPC_VERSION, id: 1, result: { threadId: 'th_1' } });
  await settle();

  // Inbound: the RENDERER's id, under `message`.
  const [data] = inbound.data();
  assert.equal(data.type, 'mcp-response');
  assert.deepEqual(data.message, { id: 7, result: { threadId: 'th_1' } });
  assert.equal(data.requestMethod, 'thread/start');
  assert.equal(link.stats.forwarded, 1);
  assert.equal(link.stats.results, 1);
});

test('the reply carries `message` and never `response`', async () => {
  // The expensive trap: outbound the renderer writes `response`, inbound it
  // reads `message`. Swapped, every one of these tests still passes except
  // this assertion.
  const { window, fake, inbound } = harness();
  rendererRequest(window, { id: 1, method: 'thread/list' });
  fake.receive({ jsonrpc: JSONRPC_VERSION, id: 1, result: { threads: [] } });
  await settle();

  const [data] = inbound.data();
  assert.equal('message' in data, true);
  assert.equal('response' in data, false);
});

test('a renderer id is never confused with the wire id it travelled under', async () => {
  // Three requests whose renderer ids run backwards against the client's, with
  // the replies arriving out of order. Any correlation that leaned on position
  // or on the other table's id gets this wrong.
  const { window, fake, inbound } = harness();
  rendererRequest(window, { id: 30, method: 'a' });
  rendererRequest(window, { id: 20, method: 'b' });
  rendererRequest(window, { id: 10, method: 'c' });
  assert.deepEqual(fake.sent.map((m) => [m.id, m.method]), [[1, 'a'], [2, 'b'], [3, 'c']]);

  fake.receive({ jsonrpc: JSONRPC_VERSION, id: 2, result: { which: 'b' } });
  fake.receive({ jsonrpc: JSONRPC_VERSION, id: 3, result: { which: 'c' } });
  fake.receive({ jsonrpc: JSONRPC_VERSION, id: 1, result: { which: 'a' } });
  await settle();

  assert.deepEqual(inbound.data().map((m) => m.message), [
    { id: 20, result: { which: 'b' } },
    { id: 10, result: { which: 'c' } },
    { id: 30, result: { which: 'a' } },
  ]);
});

test('params are omitted on the wire when the renderer sent none', () => {
  const { window, fake } = harness();
  rendererRequest(window, { id: 1, method: 'thread/list' });
  assert.equal('params' in fake.last, false, 'an absent params must not become null');
});

test('an integer renderer id stays an integer and a UUID stays a string', async () => {
  const { window, fake, inbound } = harness();
  rendererRequest(window, { id: 4, method: 'thread/start' });
  fake.receive({ jsonrpc: JSONRPC_VERSION, id: 1, result: { ok: true } });
  fake.receive({
    jsonrpc: JSONRPC_VERSION,
    id: APPROVAL_ID,
    method: APPROVAL_METHODS.commandExecution,
    params: commandApprovalParams(),
  });
  await settle();

  // Selected by type, not by position: a server request is emitted inside the
  // transport's data handler, while a reply to the renderer is emitted a
  // microtask later, so the approval overtakes a response that was resolved
  // before it arrived.
  const data = inbound.data();
  const response = data.find((message) => message.type === 'mcp-response');
  const request = data.find((message) => message.type === 'mcp-request');
  assert.equal(typeof response.message.id, 'number');
  assert.equal(typeof request.request.id, 'string');
  assert.equal(request.request.id, APPROVAL_ID);
  assert.deepEqual(data.map((message) => message.type), ['mcp-request', 'mcp-response']);
});

// ---- the gate: nothing inbound before the renderer has a client ------------

test('an app-server notification before the renderer has a client is held, not emitted', () => {
  // Emitting `mcp-notification` early is not fatal -- it is worse than fatal,
  // because the renderer does not buffer that type and drops it with no log at
  // all, so an early item delta is a hole in the transcript.
  const { fake, link, inbound } = harness();
  fake.receive({ jsonrpc: JSONRPC_VERSION, method: 'item/started', params: { itemId: 'it_1' } });

  assert.deepEqual(inbound.data(), [], 'nothing may reach the renderer before it arms');
  assert.equal(link.armed, false);
  assert.equal(link.stats.queued, 1);
  assert.equal(link.pending.queued, 1);
});

test('the renderer own request is the evidence that arms the link', () => {
  const { window, fake, link, inbound } = harness();
  fake.receive({ jsonrpc: JSONRPC_VERSION, method: 'item/started', params: { itemId: 'it_1' } });
  assert.equal(link.armed, false);

  rendererRequest(window, { id: 1, method: 'thread/start' });

  assert.equal(link.armed, true, 'only the request client emits mcp-request');
  assert.deepEqual(types(inbound), ['mcp-notification']);
  assert.equal(link.stats.flushed, 1);
});

test('the queue flushes in arrival order, ahead of the reply that opened it', async () => {
  const { window, fake, link, inbound } = harness();
  fake.receive({ jsonrpc: JSONRPC_VERSION, method: 'item/started', params: { n: 1 } });
  fake.receive({ jsonrpc: JSONRPC_VERSION, method: 'item/completed', params: { n: 2 } });
  assert.equal(link.pending.queued, 2);

  rendererRequest(window, { id: 1, method: 'thread/start' });
  fake.receive({ jsonrpc: JSONRPC_VERSION, id: 1, result: { ok: true } });
  await settle();

  assert.deepEqual(types(inbound), ['mcp-notification', 'mcp-notification', 'mcp-response']);
  assert.deepEqual(inbound.data().slice(0, 2).map((m) => m.params.n), [1, 2]);
});

test('start() announces the host but does NOT arm the link', () => {
  // The announcement is what makes the renderer register. Treating it as proof
  // that the renderer HAS registered is assuming the conclusion, and it would
  // put the throw back on exactly the path this gate exists to close.
  const { fake, link, inbound } = harness();
  fake.receive({ jsonrpc: JSONRPC_VERSION, method: 'item/started', params: {} });
  link.start({ appServerVersion: '1.2.3', installedCodexVersion: '4.5.6' });

  assert.equal(link.armed, false);
  assert.deepEqual(types(inbound), [
    'codex-app-server-initialized',
    'codex-app-server-connection-changed',
  ], 'lifecycle messages are causes, not effects, so they are never gated');
  assert.equal(link.pending.queued, 1, 'the notification is still waiting');
});

test('a reply can only be invented for a request the renderer actually made', async () => {
  // The whole policy in one assertion: an unsolicited response is impossible
  // to emit, because the only producer of responses is a captured request.
  const { fake, link, inbound } = harness();
  fake.receive({ jsonrpc: JSONRPC_VERSION, id: 99, result: { stray: true } });
  await settle();
  assert.deepEqual(inbound.data(), [], 'a response for an id we never sent reaches nobody');
  assert.equal(link.armed, false);
});

test('arm() releases the queue and reports how much it released', () => {
  const { fake, link, inbound, events } = harness();
  fake.receive({ jsonrpc: JSONRPC_VERSION, method: 'item/started', params: {} });
  fake.receive({ jsonrpc: JSONRPC_VERSION, method: 'turn/completed', params: {} });

  assert.equal(link.arm(), 2);
  assert.equal(link.armed, true);
  assert.equal(types(inbound).length, 2);
  assert.equal(link.arm(), 0, 'arming twice releases nothing and is not an error');
  assert.deepEqual(kinds(events).filter((k) => k === LINK_EVENT.armed).length, 1);
});

test('arm() refuses once the link is closed', async () => {
  const { link } = harness();
  await link.close();
  assert.throws(() => link.arm(), /closed/);
});

test('a foreign hostId neither arms the link nor reaches the app-server', () => {
  const { window, fake, link, events } = harness();
  dispatchMessageFromView(window, 'mcp-request', {
    hostId: 'remote-7',
    request: { id: 1, method: 'thread/start' },
  });

  assert.deepEqual(fake.sent, [], 'another host request belongs to another link');
  assert.equal(link.armed, false, 'and is no evidence that THIS host has a client');
  assert.equal(link.stats.foreignHostId, 1);
  assert.ok(kinds(events).includes(LINK_EVENT.foreignHostId));
  // Extended when the drop stopped being silent: the counter still says how
  // many, and the log now says which. See the foreign-frame section below.
  assert.deepEqual(
    link.foreignFrames,
    [{ type: 'mcp-request', hostId: 'remote-7', requestId: 1, disposition: 'answered' }],
    'remembered by identity, not only counted',
  );
});

test('a non-default hostId is the one that counts as ours', async () => {
  const { window, fake, link, inbound } = harness({ hostId: 'remote-7' });
  dispatchMessageFromView(window, 'mcp-request', {
    hostId: 'local',
    request: { id: 1, method: 'thread/start' },
  });
  assert.deepEqual(fake.sent, []);
  assert.equal(link.stats.foreignHostId, 1);

  dispatchMessageFromView(window, 'mcp-request', {
    hostId: 'remote-7',
    request: { id: 1, method: 'thread/start' },
  });
  fake.receive({ jsonrpc: JSONRPC_VERSION, id: 1, result: { ok: true } });
  await settle();
  // Two inbound messages now, and which hostId each carries is the point of
  // the test. #0 is the refusal of the `local` frame and is addressed to
  // `local`; the REPLY is the mcp-response, and that one is ours.
  assert.equal(inbound.data()[0].hostId, 'local');
  assert.equal(inbound.data()[0].type, 'mcp-request-delivery');
  const reply = inbound.data().find((message) => message.type === 'mcp-response');
  assert.equal(reply.hostId, 'remote-7');
});

test('a request with no hostId at all is treated as ours', () => {
  // The renderer always sets one; refusing over a field we only echo would
  // strand a turn for no gain.
  const { window, fake, link } = harness();
  dispatchMessageFromView(window, 'mcp-request', { request: { id: 1, method: 'thread/start' } });
  assert.equal(fake.sent.length, 1);
  assert.equal(link.stats.foreignHostId, 0);
});

// ---- what happens to the frames that are NOT ours -------------------------
//
// A foreign hostId is a normal thing for this renderer to produce. It keys a
// request client per host out of one atom family and gives every one of them
// the same dispatcher, so an ssh environment or a cloud project the user opens
// starts emitting frames on the one window event this link listens to. The
// link must not forward them -- that is what `isOurs` is for -- but until this
// section existed it also did not answer them, and an unanswered renderer
// request hangs forever: its deadline defaults to zero and the timer is armed
// only above zero, with no retry on any path. A real drive of this host ended
// with `foreignHostId: 3`, which is three renderer promises that never settled
// and no record of which three.
//
// The tests below pin both halves of the repair: a bounded log of what went
// past, and -- for the two request-carrying types only -- the same delivery
// failure the Electron main process sends when it has no connection for a
// hostId either.

/** The two frames main answers; everything else it drops, and so do we. */
const foreignRequest = (window, request, extra = {}) =>
  dispatchMessageFromView(window, 'mcp-request', { hostId: 'remote-7', request, ...extra });

test('a foreign request is answered with the failure main sends in its place', () => {
  // Pins main's catch arm around `getAppServerConnection(t.hostId)`: when the
  // host ID has no connection it sends `{type:'failed', delivery:{requestId,
  // method, stage:'not-sent'}, message}` as an `mcp-request-delivery`. That is
  // what the renderer's `onDelivery` turns into `onError(...)`, which is the
  // only thing here that unsticks the caller's promise.
  const { window, fake, link, inbound } = harness();
  foreignRequest(window, { id: 42, method: 'thread/start', params: { cwd: '/work' } });

  assert.deepEqual(fake.sent, [], 'still not forwarded; answering is not relaying');
  assert.equal(inbound.data().length, 1);
  const [refusal] = inbound.data();
  assert.equal(refusal.type, 'mcp-request-delivery');
  assert.equal(refusal.hostId, 'remote-7', "addressed to the FRAME's host, which is the only one that routes");
  assert.deepEqual(refusal.update.delivery, { requestId: 42, method: 'thread/start', stage: 'not-sent' });
  assert.equal(refusal.update.type, 'failed', 'the arm of onDelivery that rejects');
  assert.match(refusal.update.message, /no connection for hostId remote-7/);

  assert.equal(link.stats.foreignHostId, 1);
  assert.equal(link.stats.foreignRequestsRefused, 1);
  assert.equal(link.armed, false, 'somebody else having a client is not evidence that we do');
  assert.equal(link.pending.queued, 0, 'and the refusal is ungated: not held behind our arming');
  assert.equal(link.pending.rendererRequests, 0, 'nothing entered the correlation table');
});

test('a foreign request for `local` is answered by the arm that cannot throw', () => {
  // The reason the refusal is a delivery update and never an `mcp-response`.
  // The renderer's response arm throws `No AppServerRequestClient registered
  // for hostId: local` when the frame names `local` and `local` is not in its
  // registered list; its delivery arm is a guarded `includes(...) && ...` with
  // no throw branch at all. A link configured for some other host is exactly
  // where that difference bites, so it is tested there.
  const { window, link, inbound } = harness({ hostId: 'remote-7' });
  dispatchMessageFromView(window, 'mcp-request', {
    hostId: 'local',
    request: { id: 7, method: 'thread/start' },
  });

  assert.deepEqual(types(inbound), ['mcp-request-delivery'], 'and NOT mcp-response, which can throw');
  assert.equal(inbound.data()[0].hostId, 'local');
  assert.equal(link.stats.foreignRequestsRefused, 1);
});

test('a foreign prewarm is answered on the same path, under its own id', () => {
  // `thread-prewarm-start` has its own copy of main's catch arm sending the
  // same failed delivery, so it gets the same treatment here -- and a host
  // that answered only `mcp-request` would leave the composer's speculative
  // `thread/start` hanging for a host it never had.
  const { window, link, inbound } = harness();
  dispatchMessageFromView(window, 'thread-prewarm-start', {
    hostId: 'remote-7',
    request: { id: 11, method: 'thread/start' },
    source: 'composer',
  });

  assert.deepEqual(types(inbound), ['mcp-request-delivery']);
  assert.deepEqual(inbound.data()[0].update.delivery, {
    requestId: 11,
    method: 'thread/start',
    stage: 'not-sent',
  });
  assert.deepEqual(
    link.foreignFrames,
    [{ type: 'thread-prewarm-start', hostId: 'remote-7', requestId: 11, disposition: 'answered' }],
  );
});

test('a foreign request nobody can be waiting on is recorded, not answered', () => {
  // Two shapes, one rule: answer only what a reply can be keyed to. No id
  // means no promise in the renderer's table to settle. No method name means
  // the delivery would carry an explicit `undefined`, which is the member
  // `web/host-protocol.mjs` exists to keep off the wire -- and main never
  // produces one, because it reads `t.request.method` off a frame its own
  // client always fills in.
  const { window, link, inbound } = harness();
  foreignRequest(window, { method: 'thread/start' });
  foreignRequest(window, { id: 5 });

  assert.deepEqual(inbound.data(), [], 'neither is answerable, so neither is answered');
  assert.equal(link.stats.foreignHostId, 2, 'both still counted');
  assert.equal(link.stats.foreignRequestsRefused, 0);
  assert.deepEqual(link.foreignFrames, [
    { type: 'mcp-request', hostId: 'remote-7', requestId: undefined, disposition: 'unanswerable' },
    { type: 'mcp-request', hostId: 'remote-7', requestId: 5, disposition: 'unanswerable' },
  ]);
});

test('the four types nobody awaits a reply to are recorded and dropped', () => {
  // Main drops a foreign abandon through an optional chain
  // (`getMaybeConnection(t.hostId)?.abandonClientRequest(...)`) and sends
  // nothing for the rest. A renderer->host `mcp-response` is an answer rather
  // than a question; `ready` carries no hostId at all in the bundle, so it is
  // foreign only in a test like this one; and nothing waits on a restart. For
  // all of them absence is what the real host produces, so the record is the
  // entire change.
  const { window, link, inbound, events } = harness();
  dispatchMessageFromView(window, 'mcp-request-abandon', { hostId: 'remote-7', requestId: 3 });
  dispatchMessageFromView(window, 'mcp-response', {
    hostId: 'remote-7',
    response: { id: APPROVAL_ID, result: {} },
  });
  dispatchMessageFromView(window, 'ready', { hostId: 'remote-7' });
  dispatchMessageFromView(window, 'codex-app-server-restart', { hostId: 'remote-7' });

  assert.deepEqual(inbound.data(), [], 'four frames, no reply to any of them');
  assert.equal(link.stats.foreignHostId, 4);
  assert.equal(link.stats.foreignRequestsRefused, 0);
  assert.deepEqual(link.foreignFrames.map((frame) => [frame.type, frame.requestId, frame.disposition]), [
    ['mcp-request-abandon', 3, 'dropped'],
    ['mcp-response', APPROVAL_ID, 'dropped'],
    ['ready', undefined, 'dropped'],
    ['codex-app-server-restart', undefined, 'dropped'],
  ], 'each id read from the field its own type spells it in');
  assert.equal(
    kinds(events).filter((kind) => kind === LINK_EVENT.foreignHostId).length,
    4,
    'one report per frame, carrying what was done about it',
  );
  const [report] = events.filter((event) => event.kind === LINK_EVENT.foreignHostId);
  assert.deepEqual(report, {
    kind: LINK_EVENT.foreignHostId,
    type: 'mcp-request-abandon',
    hostId: 'remote-7',
    requestId: 3,
    disposition: 'dropped',
  });
});

test('the foreign-frame log is capped, and keeps the newest', () => {
  // The producer is the renderer's host list, which grows with every ssh
  // target or cloud project the user touches, so this log has to be bounded or
  // it is a leak. Eviction is oldest-first -- the opposite of
  // rememberEventStream, which refuses new ids because each of its entries has
  // been promised a terminated event. Nothing is promised to these: the total
  // lives in `stats.foreignHostId`, and what a reader wants is the frames
  // nearest the symptom they are chasing.
  const { window, link } = harness();
  const overflow = MAX_FOREIGN_FRAMES + 5;
  for (let id = 1; id <= overflow; id += 1) foreignRequest(window, { id, method: 'thread/start' });

  assert.equal(link.foreignFrames.length, MAX_FOREIGN_FRAMES);
  assert.equal(link.stats.foreignHostId, overflow, 'the count is not capped, only the detail');
  assert.equal(link.foreignFrames[0].requestId, 6, 'the first five were evicted');
  assert.equal(link.foreignFrames[MAX_FOREIGN_FRAMES - 1].requestId, overflow);
});

test('a reader cannot edit the foreign-frame log it is reading', () => {
  // The same rule as `stats` and `pending`: a probe is a reader. Frozen at
  // both levels, because a frozen array of live records would still let a
  // caller rewrite what the host believes it saw.
  const { window, link } = harness();
  foreignRequest(window, { id: 1, method: 'thread/start' });

  assert.throws(() => link.foreignFrames.push({}), TypeError);
  assert.throws(() => {
    link.foreignFrames[0].hostId = 'local';
  }, TypeError);
  assert.equal(link.foreignFrames[0].hostId, 'remote-7');
});

// ---- malformed renderer traffic -------------------------------------------

test('a request frame with no request object is not forwarded and not answered', () => {
  const { window, fake, link, inbound, events } = harness();
  dispatchMessageFromView(window, 'mcp-request', { hostId: 'local' });

  assert.deepEqual(fake.sent, []);
  assert.deepEqual(inbound.data(), [], 'there is no id, so there is nothing to answer');
  assert.equal(link.stats.malformed, 1);
  assert.ok(kinds(events).includes(LINK_EVENT.malformedRequest));
});

test('a request with no id is counted rather than guessed at', () => {
  const { window, fake, link, inbound, events } = harness();
  rendererRequest(window, { method: 'thread/start' });

  assert.deepEqual(fake.sent, []);
  assert.deepEqual(inbound.data(), []);
  assert.ok(kinds(events).includes(LINK_EVENT.unanswerableRequest));
  assert.equal(link.stats.malformed, 1);
});

test('a request with an id but no method is answered with an error, not dropped', async () => {
  // There IS a promise waiting on this id. Silence would hang it forever; an
  // error response settles it with something a human can read.
  const { window, fake, link, inbound } = harness();
  rendererRequest(window, { id: 12 });
  await settle();

  assert.deepEqual(fake.sent, [], 'nothing unspeakable reaches the app-server');
  const [data] = inbound.data();
  assert.equal(data.message.id, 12);
  assert.equal(data.message.error.code, HOST_ERROR_CODE);
  assert.match(data.message.error.message, /no method name/);
  assert.equal('requestMethod' in data, false, 'and no undefined method is attached');
  assert.equal(link.stats.errors, 1);
});

test('a second request under an id already in flight is refused', async () => {
  const { window, fake, link, inbound, events } = harness();
  rendererRequest(window, { id: 5, method: 'turn/start' });
  rendererRequest(window, { id: 5, method: 'turn/start' });

  assert.equal(fake.sent.length, 1, 'two replies for one id would settle it twice');
  assert.equal(link.stats.duplicates, 1);
  assert.ok(kinds(events).includes(LINK_EVENT.duplicateRequestId));

  fake.receive({ jsonrpc: JSONRPC_VERSION, id: 1, result: { ok: true } });
  await settle();
  assert.equal(inbound.data().length, 1);
});

test('an id that was abandoned can be used again', () => {
  const { window, fake, link } = harness();
  rendererRequest(window, { id: 5, method: 'turn/start' });
  dispatchMessageFromView(window, 'mcp-request-abandon', { hostId: 'local', requestId: 5 });
  rendererRequest(window, { id: 5, method: 'turn/start' });

  assert.equal(fake.sent.length, 2, 'the id is free once the renderer let it go');
  assert.equal(link.stats.duplicates, 0);
});

// ---- abandonment ----------------------------------------------------------

test('an abandoned request is never answered, even when the server replies', async () => {
  const { window, fake, link, inbound } = harness();
  rendererRequest(window, { id: 5, method: 'turn/start' });
  dispatchMessageFromView(window, 'mcp-request-abandon', { hostId: 'local', requestId: 5 });
  assert.equal(link.pending.rendererRequests, 0);

  fake.receive({ jsonrpc: JSONRPC_VERSION, id: 1, result: { ok: true } });
  await settle();

  assert.deepEqual(inbound.data(), [], 'the renderer already settled that id');
  assert.equal(link.stats.abandoned, 1);
});

test('abandoning does not try to cancel the turn on the server', () => {
  // There is no generic cancel in the protocol -- `turn/interrupt` is the only
  // thing that stops work, and inventing a cancel frame here would be a method
  // the app-server does not have.
  const { window, fake } = harness();
  rendererRequest(window, { id: 5, method: 'turn/start' });
  dispatchMessageFromView(window, 'mcp-request-abandon', { hostId: 'local', requestId: 5 });
  assert.equal(fake.sent.length, 1, 'nothing extra went out');
});

test('abandoning an id we do not hold is counted, not thrown', () => {
  const { window, link, events } = harness();
  assert.doesNotThrow(() => {
    dispatchMessageFromView(window, 'mcp-request-abandon', { hostId: 'local', requestId: 404 });
  });
  assert.equal(link.stats.unknownIds, 1);
  assert.ok(kinds(events).includes(LINK_EVENT.unknownAbandon));
});

test('an abandon frame with no requestId reports the keys it did carry', () => {
  // `requestId` is the only spelling we have seen. If a build ever uses
  // another, this report is the line that says so instead of a counter nobody
  // can interpret.
  const { window, link, events } = harness();
  dispatchMessageFromView(window, 'mcp-request-abandon', { hostId: 'local', id: 5 });

  assert.equal(link.stats.malformed, 1);
  const event = events.find((e) => e.kind === LINK_EVENT.malformedAbandon);
  assert.deepEqual([...event.keys].sort(), ['hostId', 'id', 'type']);
});

// ---- results the renderer cannot resolve on -------------------------------

test('a null result is re-encoded as {} so the renderer actually resolves', async () => {
  // The renderer reads `result ? onResult : error ? onError : log-and-drop`, so
  // a null result would settle nothing at all. A JSON-RPC null result carries
  // no information, which is the only reason this substitution is honest.
  const { window, fake, inbound } = harness();
  rendererRequest(window, { id: 3, method: 'turn/interrupt' });
  fake.receive({ jsonrpc: JSONRPC_VERSION, id: 1, result: null });
  await settle();

  const [data] = inbound.data();
  assert.deepEqual(data.message, { id: 3, result: {} });
  assert.ok(data.message.result, 'the renderer branch is truthiness, so this must be truthy');
});

test('a falsy-but-meaningful result becomes a loud error instead of a hang', async () => {
  for (const result of [0, '', false]) {
    const { window, fake, link, inbound, events } = harness();
    rendererRequest(window, { id: 3, method: 'some/count' });
    fake.receive({ jsonrpc: JSONRPC_VERSION, id: 1, result });
    await settle();

    const [data] = inbound.data();
    assert.equal(data.message.id, 3);
    assert.equal(data.message.error.code, HOST_ERROR_CODE);
    assert.match(data.message.error.message, /falsy result/);
    assert.equal('result' in data.message, false);
    assert.ok(kinds(events).includes(LINK_EVENT.uncarryableResult));
    assert.equal(link.stats.results, 0);
  }
});

test('an app-server error keeps the code and message the app-server chose', async () => {
  const { window, fake, inbound } = harness();
  rendererRequest(window, { id: 8, method: 'thread/resume' });
  fake.receive({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    error: { code: ERROR_CODES.invalidParams, message: 'no such thread', data: { threadId: 'th_x' } },
  });
  await settle();

  const [data] = inbound.data();
  assert.deepEqual(data.message, {
    id: 8,
    error: { code: ERROR_CODES.invalidParams, message: 'no such thread', data: { threadId: 'th_x' } },
  });
  assert.notEqual(data.message.error.code, HOST_ERROR_CODE, 'a server fault is not a host fault');
});

test('an error with no data member does not grow an undefined one', async () => {
  const { window, fake, inbound } = harness();
  rendererRequest(window, { id: 8, method: 'thread/resume' });
  fake.receive({ jsonrpc: JSONRPC_VERSION, id: 1, error: { code: -32601, message: 'nope' } });
  await settle();

  assert.deepEqual(Object.keys(inbound.data()[0].message.error).sort(), ['code', 'message']);
});

test('every emitted payload survives a structured clone unchanged', async () => {
  const { window, fake, link, inbound } = harness();
  link.start({ appServerVersion: '1.2.3', installedCodexVersion: '4.5.6' });
  rendererRequest(window, { id: 1, method: 'thread/start', params: { cwd: '/w' } });
  fake.receive({ jsonrpc: JSONRPC_VERSION, method: 'item/started', params: { itemId: null } });
  fake.receive({ jsonrpc: JSONRPC_VERSION, id: 1, result: { threadId: 'th_1' } });
  await settle();

  assert.ok(inbound.data().length >= 4);
  for (const message of inbound.data()) {
    assert.deepEqual(structuredClone(message), message, `${message.type} must round-trip`);
  }
});

// ---- the app-server speaking first: notifications and approvals ----------

test('the whole notification stream reaches the renderer verbatim', () => {
  const { window, fake, link, inbound } = harness();
  rendererRequest(window, { id: 1, method: 'turn/start' });
  fake.receive({
    jsonrpc: JSONRPC_VERSION,
    method: 'item/agentMessage/delta',
    params: { itemId: 'it_1', delta: 'he' },
  });

  const [data] = inbound.data();
  assert.equal(data.type, 'mcp-notification');
  assert.equal(data.method, 'item/agentMessage/delta');
  assert.deepEqual(data.params, { itemId: 'it_1', delta: 'he' });
  assert.equal(link.stats.notifications, 1);
});

test('a notification with no params does not carry an undefined one', () => {
  const { window, fake, inbound } = harness();
  rendererRequest(window, { id: 1, method: 'turn/start' });
  fake.receive({ jsonrpc: JSONRPC_VERSION, method: 'turn/completed' });
  assert.equal('params' in inbound.data()[0], false);
});

// ---- the one notification that is rewritten --------------------------------

const eventStreamFrame = (params) => ({
  jsonrpc: JSONRPC_VERSION,
  method: 'mcpServer/event/stream/notification',
  params,
});

const startStream = (window, id, subscriptionId) => rendererRequest(window, {
  id,
  method: 'mcpServer/event/stream/start',
  params: { subscriptionId },
});

test('an event-stream notification is rewritten rather than forwarded', () => {
  // Forwarding it as an ordinary notification is the failure that looks like
  // success: the renderer's gate admits the method, its big switch no-ops on
  // the type, and the subscriber that would have shown the events is keyed on
  // `subscriptionId` and never hears about it. So the frame is reshaped here,
  // exactly as the Electron main process reshapes it, and the four fields are
  // pinned -- including the absence of the wire method, which is what IDENTIFIED
  // the frame and is not part of it.
  const { window, fake, link, inbound } = harness();
  rendererRequest(window, { id: 1, method: 'turn/start' });
  const notification = { method: 'notifications/message', params: { level: 'info', data: 'hi' } };
  fake.receive(eventStreamFrame({ notification, subscriptionId: 'sub-1' }));

  assert.deepEqual(types(inbound), ['mcp-event-notification']);
  const [data] = inbound.data();
  assert.deepEqual(Object.keys(data), ['type', 'hostId', 'notification', 'subscriptionId']);
  assert.deepEqual(data.notification, notification);
  assert.equal(data.subscriptionId, 'sub-1');
  assert.equal('method' in data, false, 'the wire method identifies the frame; it does not travel');
  assert.equal(link.stats.mcpEvents, 1);
  assert.equal(link.stats.notifications, 0, 'and it is not counted as the stream it is not');
});

test('a malformed event-stream frame is dropped, not downgraded and not thrown', () => {
  // Byte-compatible with main's `if(!t.success)return`. The temptation is to
  // fall back to the generic notification path "so nothing is lost", but that
  // path delivers to nobody for this method, so the fallback would only hide
  // the drop. Counted and reported instead.
  const { window, fake, link, inbound, events, protocolErrors } = harness();
  rendererRequest(window, { id: 1, method: 'turn/start' });
  const malformed = [
    undefined,
    'not-an-object',
    null,
    {},
    { notification: { method: 'notifications/message' } },
    { subscriptionId: 'sub-1' },
    { notification: null, subscriptionId: 'sub-1' },
    { notification: { params: {} }, subscriptionId: 'sub-1' },
    { notification: { method: '' }, subscriptionId: 'sub-1' },
    { notification: { method: 'notifications/message' }, subscriptionId: 7 },
    { notification: { method: 'notifications/message' }, subscriptionId: '' },
  ];
  for (const params of malformed) {
    assert.doesNotThrow(() => fake.receive(eventStreamFrame(params)), `${JSON.stringify(params)}`);
  }

  assert.deepEqual(inbound.data(), [], 'nothing reaches the renderer');
  assert.equal(link.stats.mcpEventsDropped, malformed.length);
  assert.equal(link.stats.mcpEvents, 0);
  assert.equal(link.stats.notifications, 0, 'a dropped event is never downgraded');
  assert.equal(
    kinds(events).filter((kind) => kind === LINK_EVENT.malformedMcpEvent).length,
    malformed.length,
  );
  // The builder would have thrown on the missing fields. A throw out of a
  // notification handler is caught by the client and reported as a protocol
  // error, which is a true statement about nothing the server did wrong.
  assert.deepEqual(protocolErrors, []);
});

test('the transport dying terminates every live stream once, after the replies and before the notice', async () => {
  // The renderer releases an MCP subscription only on a terminated event for
  // its id, so a stream the server can no longer feed is a widget that spins
  // until the page is reloaded. Main synthesises exactly these frames in its
  // `clear()`; the reason string is ours because main's describes main's death.
  //
  // Four subscriptions, each known a different way, which is also the test of
  // where the ids come from: two from `start` requests alone, one that the
  // server terminated honestly before the transport died, and one seen only in
  // an event -- the case a host that learned ids from notifications alone would
  // be the only one to catch, and the case main cannot have.
  const { window, fake, link, inbound, events } = harness();
  startStream(window, 1, 'sub-a');
  startStream(window, 2, 'sub-b');
  startStream(window, 3, 'sub-c');
  fake.receive(eventStreamFrame({
    notification: { method: 'notifications/message', params: { level: 'info' } },
    subscriptionId: 'sub-b',
  }));
  fake.receive(eventStreamFrame({
    notification: { method: 'notifications/events/terminated', params: { reason: 'the server said so' } },
    subscriptionId: 'sub-c',
  }));
  fake.receive(eventStreamFrame({
    notification: { method: 'notifications/message', params: { level: 'info' } },
    subscriptionId: 'sub-d',
  }));
  fake.drop();
  await settle();

  const order = types(inbound);
  assert.deepEqual(order, [
    // Three frames passed through before the death.
    'mcp-event-notification',
    'mcp-event-notification',
    'mcp-event-notification',
    // The three `start` requests, stranded: an explanation then a settlement.
    'mcp-request-delivery',
    'mcp-response',
    'mcp-request-delivery',
    'mcp-response',
    'mcp-request-delivery',
    'mcp-response',
    // The sweep: three, because an event is not an ending -- only `sub-c` was
    // terminated, and `sub-b` having produced an event makes it live, not done.
    'mcp-event-notification',
    'mcp-event-notification',
    'mcp-event-notification',
    // And only then the obituary.
    'codex-app-server-connection-changed',
  ]);

  // Stated as positions rather than indices, because the ORDER is the invariant:
  // behind the stranded replies (the header's reason) and ahead of the
  // disconnect notice (a renderer that drops host-keyed state on a
  // non-connected state would have nothing left to deliver these to).
  const data = inbound.data();
  const swept = data.slice(order.lastIndexOf('mcp-response') + 1, order.length - 1);
  assert.deepEqual(swept.map((message) => message.subscriptionId), ['sub-a', 'sub-b', 'sub-d']);
  for (const message of swept) {
    assert.deepEqual(message.notification, {
      method: 'notifications/events/terminated',
      params: { reason: 'the app-server transport closed, so this MCP event stream cannot be fed' },
    });
  }
  assert.equal(link.stats.mcpEventTerminations, 3);
  assert.equal(
    kinds(events).filter((kind) => kind === LINK_EVENT.mcpEventStreamTerminated).length,
    3,
  );
  assert.equal(data[order.length - 1].state, CONNECTION_STATE_DISCONNECTED);
});

test('the subscription set is bounded against the side that chooses the ids', async () => {
  // The backstop in onMcpEventNotification adds whatever `subscriptionId` an
  // event frame carries. That string is the app server's to choose, it is
  // never compared against anything the renderer asked for, and it leaves the
  // set only if a terminated event names it back -- so a server that varies it
  // per notification grows this set once per event for as long as the page is
  // open, inside the phone's renderer. Nothing above the link caps it: neither
  // the transport nor the bus knows how many streams exist.
  const { fake, link, events } = harness();

  const over = 3;
  for (let i = 0; i < MAX_EVENT_STREAM_SUBSCRIPTIONS + over; i += 1) {
    fake.receive(eventStreamFrame({
      notification: { method: 'notifications/message', params: { level: 'info' } },
      subscriptionId: `server-chosen-${i}`,
    }));
  }
  await settle();

  // Delivery is unaffected, which is the half that must not regress: declining
  // to TRACK an id is not declining to forward the event under it. The
  // renderer's subscriber is keyed on the id and would notice immediately.
  assert.equal(link.stats.mcpEvents, MAX_EVENT_STREAM_SUBSCRIPTIONS + over);
  assert.equal(link.stats.mcpEventsDropped, 0);

  assert.equal(link.stats.mcpEventSubscriptionsRefused, over);
  const refusals = events.filter((event) => event.kind === LINK_EVENT.eventStreamLimitReached);
  assert.equal(refusals.length, over, 'every refusal is reported, not just the first');
  assert.equal(refusals[0].limit, MAX_EVENT_STREAM_SUBSCRIPTIONS);
  assert.equal(
    refusals[0].subscriptionId,
    `server-chosen-${MAX_EVENT_STREAM_SUBSCRIPTIONS}`,
    'the FIRST id over the line is the one refused; the earlier ones are kept',
  );

  // Refusal is refuse-the-new, not evict-the-old, and this is how that choice
  // is visible: the sweep still owes a terminated event to all 1024 ids it
  // accepted. Eviction would have left some of those renderer widgets
  // spinning, which is the failure sweepEventStreams exists to prevent.
  fake.drop();
  await settle();
  assert.equal(link.stats.mcpEventTerminations, MAX_EVENT_STREAM_SUBSCRIPTIONS);
});

test('a long-lived stream does not spend the bound once per event', async () => {
  // The cap is on distinct ids held, not on frames seen. A stream that emits
  // ten thousand events is one subscription, and a bound that could not tell
  // those apart would refuse real streams on a busy session -- which is worse
  // than the leak it replaced, because it breaks the sweep for traffic that is
  // entirely legitimate.
  const { window, fake, link, events } = harness();
  startStream(window, 1, 'sub-a');
  for (let i = 0; i < MAX_EVENT_STREAM_SUBSCRIPTIONS + 50; i += 1) {
    fake.receive(eventStreamFrame({
      notification: { method: 'notifications/message', params: { seq: i } },
      subscriptionId: 'sub-a',
    }));
  }
  await settle();

  assert.equal(link.stats.mcpEventSubscriptionsRefused, 0);
  assert.equal(events.filter((event) => event.kind === LINK_EVENT.eventStreamLimitReached).length, 0);

  fake.drop();
  await settle();
  assert.equal(link.stats.mcpEventTerminations, 1, 'one stream, one terminated event');
});

test('a stream already terminated or stopped is not swept a second time', async () => {
  // `sub-b` above proves the first half from the server's side; this is the
  // renderer's side of it, and the reason the `stop` request is read on the way
  // past at all. A duplicate terminated event is not harmless: the renderer
  // deletes the subscription on the first one, so the second arrives for a
  // subscription that no longer exists.
  const { window, fake, link, inbound } = harness();
  startStream(window, 1, 'sub-a');
  rendererRequest(window, {
    id: 2,
    method: 'mcpServer/event/stream/stop',
    params: { subscriptionId: 'sub-a' },
  });
  fake.drop();
  await settle();

  assert.deepEqual(types(inbound).filter((type) => type === 'mcp-event-notification'), []);
  assert.equal(link.stats.mcpEventTerminations, 0);
});

test('closing the link terminates its live streams, under a reason that names the link', async () => {
  // Not covered by the transport hook, which returns early on our own close so
  // that a caller who closed the link is not told the transport died. The
  // renderer outlives the link, which is the same argument that makes close()
  // answer outstanding approvals rather than drop them.
  const { window, fake, link, inbound } = harness();
  startStream(window, 1, 'sub-a');
  startStream(window, 2, 'sub-b');
  await link.close();

  const swept = inbound.data().filter((message) => message.type === 'mcp-event-notification');
  assert.deepEqual(swept.map((message) => message.subscriptionId), ['sub-a', 'sub-b']);
  for (const message of swept) {
    assert.deepEqual(message.notification, {
      method: 'notifications/events/terminated',
      params: { reason: 'the host link closed, so this MCP event stream cannot be fed' },
    });
  }
  assert.equal(link.stats.mcpEventTerminations, 2);
  assert.deepEqual(fake.sent.map((message) => message.method), [
    'mcpServer/event/stream/start',
    'mcpServer/event/stream/start',
  ], 'the two requests were forwarded unchanged on their way past');
});

test('a server approval request reaches the renderer and its answer reaches the server', async () => {
  const { window, fake, link, inbound } = harness();
  link.arm();
  fake.receive({
    jsonrpc: JSONRPC_VERSION,
    id: APPROVAL_ID,
    method: APPROVAL_METHODS.commandExecution,
    params: commandApprovalParams(),
  });

  const [data] = inbound.data();
  assert.equal(data.type, 'mcp-request');
  assert.equal(data.request.id, APPROVAL_ID);
  assert.equal(data.request.method, APPROVAL_METHODS.commandExecution);
  assert.equal(data.request.params.command, 'npm test');

  // The renderer answers with `response`, the opposite word to the one it reads.
  dispatchMessageFromView(window, 'mcp-response', {
    hostId: 'local',
    response: { id: APPROVAL_ID, result: { decision: 'accept' } },
    requestMethod: APPROVAL_METHODS.commandExecution,
  });
  await settle();

  assert.deepEqual(fake.last, {
    jsonrpc: JSONRPC_VERSION,
    id: APPROVAL_ID,
    result: { decision: 'accept' },
  });
  assert.equal(link.stats.serverRequestAnswers, 1);
  assert.equal(link.pending.serverRequests, 0);
});

test('a renderer error answer becomes an error member with the renderer code', async () => {
  const { window, fake, link } = harness();
  link.arm();
  fake.receive({
    jsonrpc: JSONRPC_VERSION,
    id: APPROVAL_ID,
    method: APPROVAL_METHODS.fileChange,
    params: {},
  });
  dispatchMessageFromView(window, 'mcp-response', {
    hostId: 'local',
    response: { id: APPROVAL_ID, error: { code: ERROR_CODES.invalidParams, message: 'the user closed the sheet' } },
  });
  await settle();

  assert.deepEqual(fake.last, {
    jsonrpc: JSONRPC_VERSION,
    id: APPROVAL_ID,
    error: { code: ERROR_CODES.invalidParams, message: 'the user closed the sheet' },
  });
  assert.equal(link.stats.errors, 0, 'this one is the renderer refusing, not the host failing');
});

test('a server request for a method nobody registered is refused by the client', async () => {
  // Load-bearing refusal: the server awaits this reply and nothing times out,
  // so -32601 is the difference between a failed turn and a stalled one.
  const { fake, link, inbound } = harness();
  link.arm();
  fake.receive({ jsonrpc: JSONRPC_VERSION, id: 'x-1', method: 'some/unknown/request', params: {} });
  await settle();

  assert.equal(fake.last.error.code, ERROR_CODES.methodNotFound);
  assert.deepEqual(inbound.data(), [], 'and the renderer was never asked');
  assert.equal(link.stats.serverRequests, 0);
});

test('every method the server can ask is registered, by exact spelling', () => {
  // This assertion used to read `deepEqual(SERVER_REQUEST_METHODS,
  // Object.values(APPROVAL_METHODS))` and passed while five of the then-eight
  // server-initiated methods were unregistered -- which the client answers
  // -32601, which the server reads as a refusal, which the renderer never sees.
  // A sixth joined them later: `currentTime/read` was held out of the table on
  // purpose, on the theory that a clock is a question a host should answer
  // rather than relay, and so self-refused for its trouble.
  // So the list is pinned by literal here: a table compared only against
  // another table cannot catch both of them being short.
  assert.deepEqual([...SERVER_REQUEST_METHODS].sort(), [
    'currentTime/read',
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'item/tool/call',
    'item/tool/requestOptionPicker',
    'item/tool/requestSetupCodexContextPicker',
    'item/tool/requestUserInput',
    'mcpServer/elicitation/request',
  ]);
  // Synthesised by the renderer with an `implement-plan:<turnId>` id of its own
  // and never sent by a server, so a handler for it could never run.
  assert.equal(SERVER_REQUEST_METHODS.includes('item/plan/requestImplementation'), false);
  for (const method of Object.values(APPROVAL_METHODS)) {
    assert.ok(SERVER_REQUEST_METHODS.includes(method), `${method} must still be registered`);
  }
});

test('each of the nine reaches the renderer instead of refusing itself', async () => {
  // The regression test for the bug, stated the way the user experienced it: a
  // permission grant, an option pick, an elicitation or a dynamic tool call
  // that the agent acted on without ever asking. With the short table these
  // produced a -32601 on the wire and NOTHING at the window.
  for (const method of SERVER_REQUEST_METHODS) {
    const { fake, link, inbound } = harness();
    link.arm();
    fake.receive({ jsonrpc: JSONRPC_VERSION, id: APPROVAL_ID, method, params: { threadId: 'th_1' } });
    await settle();

    assert.deepEqual(types(inbound), ['mcp-request'], `${method} must reach the renderer`);
    assert.equal(inbound.data()[0].request.method, method);
    assert.deepEqual(fake.sent, [], `${method} must not be answered by the host`);
    assert.equal(link.pending.serverRequests, 1, `${method} must still be awaiting the user`);
  }
});

test('currentTime/read is asked of the renderer, not answered from a clock here', async () => {
  // The ninth method, and the only one whose absence was an argument rather
  // than an oversight: a clock looked like something a host can answer
  // correctly. The renderer answers it itself -- `result:{currentTimeAt:
  // Math.floor(Date.now()/1e3)}`, epoch SECONDS -- and while the method was
  // missing from the table the client refused it -32601, which is the one
  // outcome that guarantees the renderer is never asked.
  //
  // The empty `fake.sent` below is the whole assertion: no refusal, and no
  // answer invented here either, which also keeps this file's no-clock rule.
  const { window, fake, link, inbound } = harness();
  link.arm();
  fake.receive({
    jsonrpc: JSONRPC_VERSION,
    id: APPROVAL_ID,
    method: 'currentTime/read',
    params: {},
  });
  await settle();

  assert.deepEqual(types(inbound), ['mcp-request']);
  assert.equal(inbound.data()[0].request.method, 'currentTime/read');
  assert.deepEqual(fake.sent, []);
  assert.equal(link.pending.serverRequests, 1);

  dispatchMessageFromView(window, 'mcp-response', {
    hostId: 'local',
    response: { id: APPROVAL_ID, result: { currentTimeAt: 1761300000 } },
  });
  await settle();

  assert.deepEqual(fake.last, {
    jsonrpc: JSONRPC_VERSION,
    id: APPROVAL_ID,
    result: { currentTimeAt: 1761300000 },
  });
});

test('the non-decision reply shapes relay through untouched', async () => {
  // Nine methods, eight shapes: only the two approvals share one. A reply path
  // that normalised to `{decision}`, or validated for one, would reject every
  // grant and every pick -- and since neither side has a timeout, the turn
  // would stall rather than fail.
  const replies = [
    ['item/permissions/requestApproval', { permissions: { read: ['/work'], write: [] }, scope: 'turn' }],
    ['item/tool/requestUserInput', { answers: { 'Which branch?': 'main' } }],
    ['item/tool/requestOptionPicker', { action: 'submit', selectedOptions: ['a'], freeformAnswer: null }],
    ['item/tool/requestSetupCodexContextPicker', { action: 'dismiss', selectedSources: [] }],
    ['mcpServer/elicitation/request', { action: 'accept', content: { nested: { deep: [1, 2, 3] } } }],
    ['item/tool/call', { content: [{ type: 'text', text: 'ok' }], isError: false }],
    ['currentTime/read', { currentTimeAt: 1761300000 }],
  ];
  for (const [method, result] of replies) {
    const { window, fake, link } = harness();
    link.arm();
    fake.receive({ jsonrpc: JSONRPC_VERSION, id: APPROVAL_ID, method, params: {} });
    dispatchMessageFromView(window, 'mcp-response', {
      hostId: 'local',
      response: { id: APPROVAL_ID, result },
    });
    await settle();

    assert.deepEqual(fake.last.result, result, `${method} must survive byte for byte`);
    assert.deepEqual(Object.keys(fake.last.result), Object.keys(result), 'including key order');
    assert.equal(fake.last.error, undefined);
  }
});

test('a reply settles on its id alone, with requestMethod absent or wrong', async () => {
  // The renderer attaches `requestMethod` to its outbound envelope only when
  // tracing is enabled, so behaviour that keyed off its presence would work in
  // development and stall in production. And when it IS present it is the
  // renderer's own bookkeeping, not something to validate against.
  for (const extra of [{}, { requestMethod: 'item/tool/call' }, { requestMethod: '' }]) {
    const { window, fake, link } = harness();
    link.arm();
    fake.receive({
      jsonrpc: JSONRPC_VERSION,
      id: APPROVAL_ID,
      method: 'item/permissions/requestApproval',
      params: {},
    });
    dispatchMessageFromView(window, 'mcp-response', {
      hostId: 'local',
      response: { id: APPROVAL_ID, result: { permissions: {}, scope: 'turn' } },
      ...extra,
    });
    await settle();

    assert.deepEqual(fake.last, {
      jsonrpc: JSONRPC_VERSION,
      id: APPROVAL_ID,
      result: { permissions: {}, scope: 'turn' },
    });
    assert.equal(link.stats.serverRequestAnswers, 1);
  }
});

test('the params of a server request are the same object, not a copy of one', async () => {
  // Identity, not equality, and the strongest statement this suite can make
  // about the forward path: it proves no normalisation, no key renaming and no
  // threadId rewrite can have happened in between. Any of those produces an
  // approval the renderer cannot match to a thread, so no card is painted, and
  // with no timeout on either side the turn waits forever.
  const { fake, link, inbound } = harness();
  link.arm();
  const params = commandApprovalParams({
    threadId: 'th_original',
    unknownFutureField: { kept: true },
  });
  fake.receive({
    jsonrpc: JSONRPC_VERSION,
    id: APPROVAL_ID,
    method: APPROVAL_METHODS.commandExecution,
    params,
  });

  const forwarded = inbound.data()[0].request.params;
  assert.equal(forwarded, params, 'the very object the server sent, by reference');
  assert.deepEqual(Object.keys(forwarded), Object.keys(params), 'no reordering, no additions');
  assert.equal(forwarded.threadId, 'th_original');
  assert.deepEqual(forwarded.unknownFutureField, { kept: true });
  assert.deepEqual(Object.keys(inbound.data()[0].request), ['id', 'method', 'params']);
  assert.equal(link.stats.serverRequests, 1);
});

test('the id the renderer is given is the id the server names later', async () => {
  // The server refers back to its own request id in `serverRequest/resolved`,
  // and the renderer matches that against the id it was handed. An id map
  // anywhere in between -- renumbering a UUID into the integer space, say --
  // would leave the card on screen forever with the turn already finished.
  const { window, fake, link, inbound } = harness();
  link.arm();
  fake.receive({
    jsonrpc: JSONRPC_VERSION,
    id: APPROVAL_ID,
    method: APPROVAL_METHODS.commandExecution,
    params: commandApprovalParams(),
  });
  dispatchMessageFromView(window, 'mcp-response', {
    hostId: 'local',
    response: { id: APPROVAL_ID, result: { decision: 'accept' } },
  });
  await settle();
  fake.receive({
    jsonrpc: JSONRPC_VERSION,
    method: 'serverRequest/resolved',
    params: { requestId: APPROVAL_ID, threadId: 'th_1' },
  });

  const asked = inbound.data().find((message) => message.type === 'mcp-request');
  const resolved = inbound.data().find((message) => message.type === 'mcp-notification');
  assert.equal(asked.request.id, APPROVAL_ID);
  assert.equal(typeof asked.request.id, 'string', 'a server id is a UUID string, never an integer');
  assert.equal(resolved.params.requestId, asked.request.id, 'the same id, both directions');
  assert.equal(fake.last.id, APPROVAL_ID, 'and the same one went back on the wire');
  assert.equal(link.stats.serverRequestAnswers, 1);
});

test('a renderer answer for an id we are not holding is counted, not thrown', () => {
  const { window, link, events } = harness();
  assert.doesNotThrow(() => {
    dispatchMessageFromView(window, 'mcp-response', {
      hostId: 'local',
      response: { id: 'never-asked', result: {} },
    });
  });
  assert.equal(link.stats.unknownIds, 1);
  assert.ok(kinds(events).includes(LINK_EVENT.unknownResponseId));
});

test('a renderer answer with no response object is counted, not thrown', () => {
  const { window, link, events } = harness();
  for (const payload of [{}, { response: null }, { response: 'yes' }, { response: { result: 1 } }]) {
    dispatchMessageFromView(window, 'mcp-response', { hostId: 'local', ...payload });
  }
  assert.equal(link.stats.malformed, 4);
  assert.equal(kinds(events).filter((k) => k === LINK_EVENT.malformedResponse).length, 4);
});

test('an approval held before arming is still held, and the server is not answered', () => {
  const { fake, link, inbound } = harness();
  fake.receive({
    jsonrpc: JSONRPC_VERSION,
    id: APPROVAL_ID,
    method: APPROVAL_METHODS.commandExecution,
    params: {},
  });
  assert.deepEqual(inbound.data(), []);
  assert.deepEqual(fake.sent, [], 'answering it ourselves would be deciding an approval');
  assert.equal(link.pending.serverRequests, 1);
});

// ---- lifecycle -----------------------------------------------------------

test('start() emits initialized then connected, in that order', () => {
  const { link, inbound } = harness();
  link.start({ appServerVersion: '1.2.3', installedCodexVersion: '4.5.6' });

  const [initialized, changed] = inbound.data();
  assert.equal(initialized.appServerVersion, '1.2.3');
  assert.equal(initialized.installedCodexVersion, '4.5.6');
  assert.equal('transport' in initialized, false, 'absent takes the non-websocket branch');
  assert.equal('isSnapshot' in initialized, false);
  assert.equal(changed.state, 'connected');
  assert.equal(link.started, true);
});

test('start() refuses a missing version rather than emitting an undefined one', () => {
  // `inboundAppServerInitialized` writes both version fields unconditionally,
  // so calling it without them produces `{appServerVersion: undefined}` -- an
  // explicit undefined key that does not survive a structured clone. The
  // refusal belongs here, where the stack still names the caller.
  const { link, inbound } = harness();
  assert.throws(() => link.start(), /appServerVersion/);
  assert.throws(() => link.start({ appServerVersion: '1.2.3' }), /installedCodexVersion/);
  assert.throws(() => link.start({ appServerVersion: '', installedCodexVersion: '4.5.6' }), /appServerVersion/);
  assert.throws(() => link.start({ appServerVersion: 1, installedCodexVersion: '4.5.6' }), /appServerVersion/);
  assert.deepEqual(inbound.data(), [], 'and nothing was emitted on the way to throwing');
  assert.equal(link.started, false);
});

test('start() refuses a second announcement', () => {
  const { link } = harness();
  link.start({ appServerVersion: '1.2.3', installedCodexVersion: '4.5.6' });
  assert.throws(
    () => link.start({ appServerVersion: '1.2.3', installedCodexVersion: '4.5.6' }),
    /already been started/,
  );
});

test('start() refuses when the app-server transport is already gone', () => {
  const { fake, link } = harness();
  fake.drop();
  assert.throws(() => link.start({ appServerVersion: '1.2.3', installedCodexVersion: '4.5.6' }), /closed/);
});

// ---- the version the renderer gates on -----------------------------------
//
// `appServerVersion` is not a label. It is the input to every version gate in
// the renderer, and both ways of getting it wrong are silent: an unparseable
// string turns every gate OFF -- which strips `turnTrigger` out of every
// `turn/start` with nothing logged -- and the wildcard '0.0.0' turns every gate
// that uses the comparison helper ON while the two checks that do not use it
// treat the wildcard as a refusal. A host that guesses is rewriting the wire.

test('start() refuses the wildcard version by name', () => {
  const { link, inbound } = harness();
  assert.throws(
    () => link.start({ appServerVersion: '0.0.0', installedCodexVersion: '4.5.6' }),
    /appServerVersion must not be 0\.0\.0/,
  );
  assert.throws(
    () => link.start({ appServerVersion: '1.2.3', installedCodexVersion: '0.0.0' }),
    /installedCodexVersion must not be 0\.0\.0/,
  );
  assert.deepEqual(inbound.data(), [], 'and nothing was emitted on the way to throwing');
  assert.equal(link.started, false);
});

test('start() refuses a version the renderer could not compare', () => {
  const { link } = harness();
  for (const bad of ['1', '1.2', 'v1.2.3', 'dev', 'latest', '1.2.3.4']) {
    assert.throws(
      () => link.start({ appServerVersion: bad, installedCodexVersion: '4.5.6' }),
      /must be a version the renderer can compare/,
      `${bad} silently disables every gated feature`,
    );
  }
  assert.equal(link.started, false);
});

/** The userAgent the live adapter builds, with its real default compat version. */
const REAL_USER_AGENT = 'codex-relay-web/0.142.3 (macos; aarch64) claude-codex (codex-relay-web; 0.0.0)';

/** Answer the handshake the link just sent, the way the adapter answers it. */
function answerHandshake(fake, overrides = {}) {
  fake.receive({
    jsonrpc: JSONRPC_VERSION,
    id: fake.last.id,
    result: {
      userAgent: REAL_USER_AGENT,
      codexHome: '/home/x/.codex',
      platformFamily: 'unix',
      platformOs: 'macos',
      ...overrides,
    },
  });
}

test('startFromHandshake announces the version the server named, not a wildcard', async () => {
  const { fake, link, inbound } = harness();
  const pending = link.startFromHandshake({ transport: 'websocket' });
  answerHandshake(fake);
  const handshake = await pending;

  const [initialized, changed] = inbound.data();
  assert.equal(initialized.type, 'codex-app-server-initialized');
  assert.equal(initialized.appServerVersion, '0.142.3');
  assert.notEqual(initialized.appServerVersion, '0.0.0', 'the whole point of asking');
  assert.equal(initialized.transport, 'websocket');
  assert.equal(changed.state, 'connected');
  assert.equal(link.started, true);
  assert.equal(handshake.appServerVersion, '0.142.3');
  assert.equal(handshake.result.codexHome, '/home/x/.codex');
});

test('installedCodexVersion defaults to the server version, so no restart is offered', async () => {
  // The renderer paints a "restart to update" banner when the installed version
  // is HIGHER than the app-server one. A relay has no second binary to restart
  // into, so equal is the only pair that does not offer an action the host
  // cannot perform.
  const { fake, link, inbound } = harness();
  const pending = link.startFromHandshake();
  answerHandshake(fake);
  await pending;
  const [initialized] = inbound.data();
  assert.equal(initialized.installedCodexVersion, '0.142.3');
  assert.equal(initialized.appServerVersion, initialized.installedCodexVersion);
});

test('a caller may still name the installed version it actually has', async () => {
  const { fake, link, inbound } = harness();
  const pending = link.startFromHandshake({ installedCodexVersion: '0.143.0' });
  answerHandshake(fake);
  await pending;
  assert.equal(inbound.data()[0].installedCodexVersion, '0.143.0');
});

test('a handshake with no usable version fails loudly and announces nothing', async () => {
  const { fake, link, inbound } = harness();
  const pending = link.startFromHandshake();
  answerHandshake(fake, { userAgent: 'codex-app' });
  await assert.rejects(() => pending, /carried no comparable version/);
  assert.deepEqual(inbound.data(), [], 'no announcement from a guess');
  assert.equal(link.started, false);
});

test('a second startFromHandshake during the first is refused', async () => {
  // Without a flag of its own, the second call would see `started === false`
  // -- it is only set once the reply lands -- send a second `initialize`, and
  // announce the host twice, which has the renderer stand up a second request
  // client for one hostId.
  const { fake, link } = harness();
  const pending = link.startFromHandshake();
  await assert.rejects(() => link.startFromHandshake(), /already been started/);
  assert.equal(fake.sent.length, 1, 'and no second handshake went out');
  answerHandshake(fake);
  await pending;
  await assert.rejects(() => link.startFromHandshake(), /already been started/);
});

test('a handshake that failed may be retried on a transport that is still alive', async () => {
  const { fake, link } = harness();
  const first = link.startFromHandshake();
  fake.receive({
    jsonrpc: JSONRPC_VERSION,
    id: fake.last.id,
    error: { code: -32000, message: 'not ready' },
  });
  await assert.rejects(() => first, /not ready/);
  assert.equal(link.started, false);

  const second = link.startFromHandshake();
  answerHandshake(fake);
  await second;
  assert.equal(link.started, true);
});

test('notifications the handshake provokes are held, not dropped', async () => {
  // Measured, not hypothetical: the adapter queues `account/updated` and one
  // `mcpServer/startupStatus/updated` per configured server in a microtask off
  // its `initialize` reply. They therefore arrive before any renderer has
  // registered a request client, which is precisely what the queue is for.
  const { window, fake, link, inbound } = harness();
  const pending = link.startFromHandshake();
  answerHandshake(fake);
  await pending;
  fake.receive({
    jsonrpc: JSONRPC_VERSION,
    method: 'account/updated',
    params: { authMode: 'apikey', planType: null },
  });
  assert.deepEqual(types(inbound), [
    'codex-app-server-initialized',
    'codex-app-server-connection-changed',
  ], 'the notification is still waiting');
  assert.equal(link.stats.queued, 1);

  rendererRequest(window, { id: 1, method: 'thread/list' });
  assert.equal(link.stats.flushed, 1);
  const delivered = inbound.data().find((message) => message.type === 'mcp-notification');
  assert.equal(delivered.method, 'account/updated');
  assert.deepEqual(delivered.params, { authMode: 'apikey', planType: null });
});

// ---- `ready`: the message that un-sticks a renderer that missed the news --
//
// The renderer's startup gate is not this link's gate, and the two fail in
// opposite directions. `Qka()` renders the blossom placeholder until the
// gateway readiness atom stops being 'loading', and exactly one inbound type
// writes it: `codex-app-server-initialized`. So the message that unblocks the
// whole UI is the one the host sends FIRST, before any renderer listener
// exists -- and the renderer's own inbound buffer covers three types, none of
// them this one. `deliverMessage` drops the rest without a word.
//
// Measured on the shipped bundle: a page stuck on blossom is 58 DOM nodes, and
// re-dispatching the announcement by hand takes it to 254.
//
// Main does NOT fix this by queueing. Its app-server sends go through
// `gY.send` -> `chunkedMessageSender.send`, which never consults
// `isWebContentsReady`; WindowManager's `pendingMessages` queue is a different
// path that the app-server connection does not use. What saves the real app is
// `case 'ready'`, which re-sends three snapshots -- connection state,
// initialization, auto-resolution -- on EVERY ready, ahead of the
// `initializationOnly` early-break. These tests pin that, because an
// announcement sent once is an announcement the renderer is free to miss.

/** The renderer's own ready dispatch: no hostId, because it has no host yet. */
const rendererReady = (window, payload = {}) =>
  dispatchMessageFromView(window, 'ready', payload);

test('a ready before the announcement re-sends nothing', () => {
  // Main guards the initialization snapshot with `this.initialized &&`, and
  // here there is not even a connection state to report yet. Saying
  // `connected` before the handshake resolved would be a lie the renderer
  // acts on, and saying `codex-app-server-initialized` with no version is the
  // failure the builders refuse up front.
  const { window, link, inbound, events } = harness();
  rendererReady(window, { initializationOnly: true });

  assert.deepEqual(inbound.data(), [], 'nothing truthful to snapshot yet');
  assert.equal(link.stats.readySignals, 1, 'but the signal is still counted');
  assert.equal(link.stats.snapshotResends, 0);
  assert.ok(kinds(events).includes(LINK_EVENT.rendererReady));
  assert.ok(!kinds(events).includes(LINK_EVENT.snapshotsResent));
});

test('ready re-sends the three snapshots, in the order main sends them', () => {
  const { window, link, inbound } = harness();
  link.start({ appServerVersion: '1.2.3', installedCodexVersion: '4.5.6' });
  rendererReady(window, { initializationOnly: true });

  assert.deepEqual(types(inbound), [
    // The live announcement, in announce()'s order.
    'codex-app-server-initialized',
    'codex-app-server-connection-changed',
    // The re-send, in main's order, which is the other way round.
    'codex-app-server-connection-changed',
    'codex-app-server-initialized',
    'request-user-input-auto-resolution-snapshot',
  ]);

  const [live, , connection, initialized, autoResolution] = inbound.data();
  assert.equal(live.isSnapshot, undefined, 'the FIRST announcement is the real event');
  assert.deepEqual(connection, {
    type: 'codex-app-server-connection-changed',
    hostId: 'local',
    state: 'connected',
    isSnapshot: true,
  });
  assert.deepEqual(initialized, {
    type: 'codex-app-server-initialized',
    hostId: 'local',
    appServerVersion: '1.2.3',
    installedCodexVersion: '4.5.6',
    isSnapshot: true,
  }, 'the same thing it said the first time, flagged as a repeat');
  assert.deepEqual(autoResolution, {
    type: 'request-user-input-auto-resolution-snapshot',
    hostId: 'local',
    pendingRequests: [],
  });
  assert.equal(link.stats.snapshotResends, 1);
});

test('isSnapshot is what makes the repeat safe to repeat', () => {
  // The renderer's subscriber is
  //   e => { e.isSnapshot || (o && t.get(Zk) !== true) || S(e.hostId, ...) }
  // -- the flag short-circuits the restart side effect S() while the switch
  // that writes the version atom still runs. Without it, every re-send would
  // look like a fresh app-server coming up and the renderer would tear down
  // and rebuild state it is in the middle of using.
  const { window, link, inbound } = harness();
  link.start({ appServerVersion: '1.2.3', installedCodexVersion: '4.5.6' });
  rendererReady(window);
  rendererReady(window);

  const initialized = inbound.data().filter((m) => m.type === 'codex-app-server-initialized');
  assert.equal(initialized.length, 3, 'one live, two re-sends');
  assert.deepEqual(initialized.map((m) => m.isSnapshot), [undefined, true, true]);
});

test('every ready re-sends, because the renderer sends more than one', () => {
  // Two effects dispatch it: `{initializationOnly: true}` from above the
  // startup gate, and one carrying `persistedStateResponsePriority` from the
  // app-routes-mounted effect below it. Main re-sends ahead of its
  // `initializationOnly` early-break, so both get the snapshots -- and a host
  // that answered only the second would deadlock: no announcement, no routes,
  // no second ready, no announcement.
  const { window, link } = harness();
  link.start({ appServerVersion: '1.2.3', installedCodexVersion: '4.5.6' });
  rendererReady(window, { initializationOnly: true });
  rendererReady(window, { persistedStateResponsePriority: 'critical' });

  assert.equal(link.stats.readySignals, 2);
  assert.equal(link.stats.snapshotResends, 2, 'the first ready is not special');
});

test('the ready event says which of the two dispatches it was', () => {
  const { window, link, events } = harness();
  link.start({ appServerVersion: '1.2.3', installedCodexVersion: '4.5.6' });
  rendererReady(window, { initializationOnly: true });
  rendererReady(window, { persistedStateResponsePriority: 'critical' });

  assert.deepEqual(
    events.filter((e) => e.kind === LINK_EVENT.rendererReady).map((e) => e.initializationOnly),
    [true, false],
  );
});

test('ready does NOT arm the link', () => {
  // Ready proves a message LISTENER exists. The gate is about the request
  // CLIENT, which the renderer builds in response to the very announcement
  // being re-sent here -- so treating ready as registration would put the
  // throw back on the path the gate exists to close, and would do it at the
  // exact moment the renderer is least able to survive it.
  const { window, fake, link, inbound } = harness();
  link.start({ appServerVersion: '1.2.3', installedCodexVersion: '4.5.6' });
  fake.receive({ jsonrpc: JSONRPC_VERSION, method: 'item/started', params: {} });
  rendererReady(window, { initializationOnly: true });

  assert.equal(link.armed, false);
  assert.equal(link.pending.queued, 1, 'the notification is still waiting');
  assert.ok(!types(inbound).includes('mcp-notification'));
});

test('ready re-sends the state the transport is actually in', async () => {
  // A snapshot is a snapshot of NOW. Replaying `connected` to a renderer that
  // reloaded after the app-server died would leave it waiting on a host that
  // is not there, with no later event to correct it.
  const { window, fake, link, inbound } = harness();
  link.start({ appServerVersion: '1.2.3', installedCodexVersion: '4.5.6' });
  fake.drop();
  await settle();
  rendererReady(window);

  const states = inbound.data()
    .filter((m) => m.type === 'codex-app-server-connection-changed')
    .map((m) => m.state);
  assert.deepEqual(states, ['connected', CONNECTION_STATE_DISCONNECTED, CONNECTION_STATE_DISCONNECTED]);
  assert.equal(
    inbound.data().filter((m) => m.type === 'codex-app-server-initialized').length,
    2,
    'the version is still true even when the transport is gone',
  );
});

test('a ready for another host is not ours to answer', () => {
  const { window, link, inbound } = harness();
  link.start({ appServerVersion: '1.2.3', installedCodexVersion: '4.5.6' });
  dispatchMessageFromView(window, 'ready', { hostId: 'remote-7' });

  assert.equal(link.stats.readySignals, 0);
  assert.equal(link.stats.snapshotResends, 0);
  assert.equal(link.stats.foreignHostId, 1);
  assert.equal(types(inbound).length, 2, 'only the live announcement');
  // Extended with the half the counter cannot carry. A foreign `ready` is
  // still answered with nothing -- it is not a request and the bundle never
  // puts a hostId on one -- but it is now on the record with the reason.
  assert.equal(link.stats.foreignRequestsRefused, 0);
  assert.deepEqual(
    link.foreignFrames,
    [{ type: 'ready', hostId: 'remote-7', requestId: undefined, disposition: 'dropped' }],
  );
});

test('ready after close() re-sends nothing', async () => {
  const { window, link } = harness();
  link.start({ appServerVersion: '1.2.3', installedCodexVersion: '4.5.6' });
  await link.close();
  rendererReady(window);
  assert.equal(link.stats.snapshotResends, 0);
});

// ---- the OTHER request-carrying outbound type ----------------------------
//
// `thread-prewarm-start` is easy to miss because its name describes a feature
// rather than a transport. It is the composer's speculative `thread/start`,
// dispatched from `enqueueRequest('thread/start', ...)` in an envelope of the
// same shape as `mcp-request`, and main answers both arms through the same
// `sendAppServerResponseToView` -- which means the same `mcp-response`. A host
// that forwards only `mcp-request` does not slow the prewarm down; it drops it
// on the floor, and the renderer waits for a reply that cannot come.

const rendererPrewarm = (window, request, extra = {}) =>
  dispatchMessageFromView(window, 'thread-prewarm-start', { hostId: 'local', request, ...extra });

test('a prewarm request reaches the app-server like any other', async () => {
  const { window, fake, inbound } = harness();
  rendererPrewarm(window, { id: 11, method: 'thread/start', params: { cwd: '/work' } }, {
    source: 'composer',
    retainResponse: true,
  });

  assert.deepEqual(fake.last, {
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: 'thread/start',
    params: { cwd: '/work' },
  }, 'the envelope differs; the request inside it does not');

  fake.receive({ jsonrpc: JSONRPC_VERSION, id: 1, result: { threadId: 'th_prewarm' } });
  await settle();

  const [reply] = inbound.data();
  assert.equal(reply.type, 'mcp-response', 'one response path for both request types');
  assert.deepEqual(reply.message, { id: 11, result: { threadId: 'th_prewarm' } },
    'under the RENDERER id, not the client id it went out with');
  assert.equal(reply.requestMethod, 'thread/start');
});

test('a prewarm arms the link, and says so', () => {
  // It is registration evidence for the same reason `mcp-request` is: the
  // renderer cannot have sent it without having built the client that will
  // receive the reply.
  const { window, link, events } = harness();
  rendererPrewarm(window, { id: 11, method: 'thread/start', params: {} });

  assert.equal(link.armed, true);
  const armed = events.find((e) => e.kind === LINK_EVENT.armed);
  assert.equal(armed.reason, 'thread-prewarm-start', 'the receipt names which type it was');
});

test('a prewarm for another host is refused like any other', () => {
  const { window, fake, link, inbound } = harness();
  dispatchMessageFromView(window, 'thread-prewarm-start', {
    hostId: 'remote-7',
    request: { id: 11, method: 'thread/start' },
  });

  assert.deepEqual(fake.sent, []);
  assert.equal(link.armed, false);
  assert.equal(link.stats.foreignHostId, 1);
  // "Like any other" now includes being answered rather than dropped: main's
  // prewarm arm has the same catch, sending the same failed delivery, as its
  // `mcp-request` arm. The shape of it is pinned in the foreign-frame section.
  assert.equal(link.stats.foreignRequestsRefused, 1);
  assert.deepEqual(types(inbound), ['mcp-request-delivery']);
});

test('a malformed prewarm is refused exactly as a malformed request is', () => {
  // Including the part that looks wrong and is not: it still arms. Arming is
  // not a judgement on the frame's contents, it is the observation that the
  // renderer's dispatcher ran -- and the renderer only reaches this dispatcher
  // from inside the client whose absence the gate exists to survive. Refusing
  // to arm here would hold the queue shut over a field we are about to drop.
  const { window, fake, link, events } = harness();
  dispatchMessageFromView(window, 'thread-prewarm-start', { hostId: 'local' });

  assert.deepEqual(fake.sent, [], 'nothing to forward');
  assert.equal(link.stats.malformed, 1);
  assert.equal(link.armed, true);
  assert.equal(events.find((e) => e.kind === LINK_EVENT.armed).reason, 'thread-prewarm-start');
  assert.ok(kinds(events).includes(LINK_EVENT.malformedRequest));
});

// ---- the methods that are not allowed to fail ----------------------------
//
// `config/read` is marked `mustSucceed` in APP_SERVER_RESULT_SHAPES because two
// of its four renderer call sites -- editing a sent message, sending a queued
// one -- await it and read `.config` bare, with no catch between them and the
// user. An error response there is an unhandled rejection mid-interaction while
// a fresh turn works perfectly: a bug report that reads as random.

test('a config/read that the server rejects still reaches the renderer as a result', async () => {
  const { window, fake, link, inbound, events } = harness();
  rendererRequest(window, { id: 4, method: 'config/read' });
  fake.receive({
    jsonrpc: JSONRPC_VERSION,
    id: fake.last.id,
    error: { code: -32000, message: 'the config file is unreadable' },
  });
  await settle();

  const [data] = inbound.data();
  assert.equal(data.type, 'mcp-response');
  assert.deepEqual(data.message, { id: 4, result: { config: {} } });
  assert.equal('error' in data.message, false, 'the two uncaught call sites must not see one');
  assert.equal(link.stats.mustSucceedRepairs, 1);
  assert.equal(link.stats.errors, 0);
  const repaired = events.find((event) => event.kind === LINK_EVENT.mustSucceedRepaired);
  assert.equal(repaired.method, 'config/read');
  assert.match(repaired.reason, /rejected with -32000/, 'a substitution nobody can see is a lie');
});

test('a config/read result missing the key the renderer reads is repaired too', async () => {
  // Same failure from the consumer's point of view: `result.config` is
  // undefined and the loose schema that parses it throws on undefined. The
  // empty object parses, with every setting falling back to its default.
  for (const result of [{}, { configuration: {} }, null]) {
    const { window, fake, link, inbound } = harness();
    rendererRequest(window, { id: 4, method: 'config/read' });
    fake.receive({ jsonrpc: JSONRPC_VERSION, id: fake.last.id, result });
    await settle();
    assert.deepEqual(inbound.data()[0].message, { id: 4, result: { config: {} } },
      `${JSON.stringify(result)} must not reach a bare .config read`);
    assert.equal(link.stats.mustSucceedRepairs, 1);
  }
});

test('a config/read the server answered properly is relayed untouched', async () => {
  const { window, fake, link, inbound } = harness();
  rendererRequest(window, { id: 4, method: 'config/read' });
  const result = { config: { model: 'gpt-5', approvalPolicy: 'on-request' }, extra: 1 };
  fake.receive({ jsonrpc: JSONRPC_VERSION, id: fake.last.id, result });
  await settle();
  assert.deepEqual(inbound.data()[0].message, { id: 4, result });
  assert.equal(link.stats.mustSucceedRepairs, 0, 'no repair when there is nothing to repair');
  assert.equal(link.stats.results, 1);
});

test('each repair hands the renderer an object it owns', async () => {
  // A shared fallback would be passed by reference -- postMessage within one
  // realm does not clone -- so whatever the first consumer did to it would be
  // waiting for the second.
  const { window, fake, inbound } = harness();
  for (const id of [1, 2]) {
    rendererRequest(window, { id, method: 'config/read' });
    fake.receive({ jsonrpc: JSONRPC_VERSION, id: fake.sent.at(-1).id, error: { code: -32000, message: 'no' } });
  }
  await settle();
  const [first, second] = inbound.data();
  assert.notEqual(first.message.result, second.message.result);
  assert.notEqual(first.message.result.config, second.message.result.config);
});

test('a method that is allowed to fail still fails', async () => {
  // The repair is scoped by the descriptor table, not applied to everything. A
  // `turn/start` that silently resolved with a fabricated turn would be far
  // worse than the red error item the renderer shows for a rejection.
  const { window, fake, link, inbound } = harness();
  rendererRequest(window, { id: 5, method: 'turn/start' });
  fake.receive({
    jsonrpc: JSONRPC_VERSION,
    id: fake.last.id,
    error: { code: -32000, message: 'no model' },
  });
  await settle();
  assert.equal(inbound.data()[0].message.error.message, 'no model');
  assert.equal(link.stats.mustSucceedRepairs, 0);
  assert.equal(link.stats.errors, 1);
});

test('every must-succeed method has a fallback that satisfies what the renderer reads', () => {
  // The drift guard. `APP_SERVER_RESULT_SHAPES` is owned by host-protocol.mjs
  // and the fallbacks by this link, so a method marked must-succeed over there
  // with no entry over here would fall back to the error path -- the exact
  // failure the flag exists to prevent, reintroduced by a table that was only
  // half updated.
  const mustSucceed = Object.entries(APP_SERVER_RESULT_SHAPES)
    .filter(([, entry]) => entry.mustSucceed)
    .map(([method]) => method);
  assert.deepEqual(mustSucceed, ['config/read'], 'if this changed, the table below must too');
  assert.deepEqual(Object.keys(MUST_SUCCEED_FALLBACKS), mustSucceed);
  for (const method of mustSucceed) {
    const fallback = MUST_SUCCEED_FALLBACKS[method]();
    for (const path of APP_SERVER_RESULT_SHAPES[method].read) {
      assert.notEqual(fallback[path.split('.')[0]], undefined, `${method} fallback must carry ${path}`);
    }
    assert.ok(fallback, 'a falsy fallback would reach neither arm of the renderer branch');
  }
});

test('a transport that was dead before the link existed does not break construction', () => {
  // The real stdio transport calls an onClose callback SYNCHRONOUSLY from
  // inside `onClose()` when it is already closed -- which happens inside the
  // client constructor, before the bus exists. A close hook that read a `const`
  // bus from there would throw a TDZ ReferenceError on this path and on no
  // other.
  const window = makeWindow();
  const deadTransport = {
    send() {},
    onMessage() {},
    onClose(callback) {
      callback();
    },
    close() {},
  };
  let link;
  assert.doesNotThrow(() => {
    link = createHostLink({ window, transport: deadTransport });
  });
  assert.equal(link.stats.transportClosed, 1);
  assert.throws(() => link.start({ appServerVersion: '1.2.3', installedCodexVersion: '4.5.6' }), /closed/);
});

test('setConnectionState and reportFatalError are ungated and validated', () => {
  const { link, inbound } = harness();
  link.setConnectionState(CONNECTION_STATE_DISCONNECTED);
  link.reportFatalError('the app-server exited');

  assert.deepEqual(types(inbound), [
    'codex-app-server-connection-changed',
    'codex-app-server-fatal-error',
  ]);
  assert.equal(inbound.data()[0].state, 'disconnected');
  assert.equal(inbound.data()[1].errorMessage, 'the app-server exited');
  assert.throws(() => link.setConnectionState(''), /state/);
  assert.throws(() => link.setConnectionState(null), /state/);
  assert.throws(() => link.reportFatalError(''), /errorMessage/);
});

test('a fatal error is never announced on the link own initiative', () => {
  // The renderer does not leave its error state by itself, and only the caller
  // knows whether a reconnect is coming.
  const { fake, link, inbound } = harness();
  link.arm();
  fake.drop();
  assert.equal(types(inbound).includes('codex-app-server-fatal-error'), false);
});

test('the transport dying mid-request settles it before announcing the loss', async () => {
  // The client rejects in-flight calls and THEN calls the close hook, so the
  // rejections are queued microtasks and the hook is synchronous. Announcing
  // the disconnect first would put the obituary ahead of N replies -- and if the
  // renderer drops its local client on a non-connected state, those replies
  // land on an unregistered hostId, which is the one case that throws.
  const { window, fake, link, inbound } = harness();
  rendererRequest(window, { id: 5, method: 'turn/start' });
  fake.drop();
  await settle();

  assert.deepEqual(types(inbound), [
    'mcp-request-delivery',
    'mcp-response',
    'codex-app-server-connection-changed',
  ]);
  const [delivery, response, changed] = inbound.data();
  assert.deepEqual(delivery.update, {
    type: 'outcome-unknown',
    delivery: { requestId: 5, method: 'turn/start', stage: 'outcome-unknown' },
  });
  assert.equal(response.message.id, 5);
  assert.equal(response.message.error.code, HOST_ERROR_CODE);
  assert.equal(changed.state, CONNECTION_STATE_DISCONNECTED);
  assert.equal(link.stats.outcomeUnknown, 1);
  assert.equal(link.stats.transportClosed, 1);
});

test('the outcome-unknown update only goes out when the fate really is unknown', async () => {
  const { window, fake, inbound } = harness();
  rendererRequest(window, { id: 5, method: 'turn/start' });
  fake.receive({ jsonrpc: JSONRPC_VERSION, id: 1, error: { code: -32602, message: 'bad params' } });
  await settle();
  assert.deepEqual(types(inbound), ['mcp-response'], 'a refusal is a known outcome');
});

test('a transport close with an approval outstanding does not leave it dangling', async () => {
  const { fake, link } = harness();
  link.arm();
  fake.receive({
    jsonrpc: JSONRPC_VERSION,
    id: APPROVAL_ID,
    method: APPROVAL_METHODS.commandExecution,
    params: {},
  });
  assert.equal(link.pending.serverRequests, 1);
  fake.drop();
  await settle();
  assert.equal(link.pending.serverRequests, 0);
});

// ---- restart -------------------------------------------------------------

test('a restart request with no handler is reported rather than swallowed', () => {
  // Nothing here can restart a process it did not spawn, and the renderer will
  // now wait for an `initialized` that is not coming. The report is the only
  // thing standing between that and an afternoon of debugging.
  const { window, link, events } = harness();
  dispatchMessageFromView(window, 'codex-app-server-restart', { hostId: 'local' });
  assert.equal(link.stats.restartRequests, 1);
  assert.ok(kinds(events).includes(LINK_EVENT.restartRequested));
  assert.equal(link.armed, false, 'asking for a restart is not evidence of a live client');
});

test('a restart handler is called, and one that throws does not escape', () => {
  const seen = [];
  const { window, link, events } = harness({
    onRestartRequested: (message) => {
      seen.push(message);
      throw new Error('boom');
    },
  });
  assert.doesNotThrow(() => {
    dispatchMessageFromView(window, 'codex-app-server-restart', { hostId: 'local' });
  });
  assert.equal(seen.length, 1);
  assert.ok(kinds(events).includes(LINK_EVENT.restartHandlerThrew));
});

// ---- what the link declines to touch -------------------------------------

test('log-message never reaches the app-server', () => {
  const { window, fake } = harness();
  dispatchMessageFromView(window, 'log-message', { level: 'info', text: 'x' });
  assert.deepEqual(fake.sent, [], 'telemetry is not traffic');
});

test('an outbound type the link does not know is left for the caller onAny', () => {
  // The renderer switch has no default branch and ignores what it does not
  // know. Claiming the wildcard here would hide the next app update behind our
  // counters.
  const { window, link } = harness();
  const unknown = [];
  link.bus.onAny((message) => unknown.push(message));
  dispatchMessageFromView(window, 'hotkey-window-transition', { hostId: 'local' });
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].type, 'hotkey-window-transition');
});

test('the link makes no call of its own', () => {
  const { fake, link } = harness();
  link.start({ appServerVersion: '1.2.3', installedCodexVersion: '4.5.6' });
  link.arm();
  assert.deepEqual(fake.sent, [], 'everything on the wire is the renderer asking for it');
});

test('startFromHandshake makes exactly one call, and it is the handshake', () => {
  // The one exception to the rule above, and it is bounded to one method: the
  // alternative is a host inventing the app-server version, and every string it
  // could invent changes what the renderer does without saying so.
  const { fake, link } = harness();
  link.startFromHandshake();
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.last.method, 'initialize');
  assert.deepEqual(fake.last.params.clientInfo, { name: 'codex-relay-web', version: '0.0.0' });
});

// ---- construction and teardown -------------------------------------------

test('createHostLink refuses what it cannot wire', () => {
  const window = makeWindow();
  const fake = fakeTransport();
  assert.throws(() => createHostLink(), /window/);
  assert.throws(() => createHostLink({ window: null, transport: fake.transport }), /window/);
  assert.throws(() => createHostLink({ window }), /transport/);
  assert.throws(() => createHostLink({ window, transport: 'ws://nope' }), /transport/);
  assert.throws(() => createHostLink({ window, transport: { send() {} } }), /missing onMessage/);
  assert.throws(() => createHostLink({ window, transport: fake.transport, hostId: '' }), /hostId/);
  assert.throws(
    () => createHostLink({ window, transport: fake.transport, serverRequestMethods: ['a', ''] }),
    /non-empty/,
  );
  assert.throws(
    () => createHostLink({ window, transport: fake.transport, serverRequestMethods: ['a', 'a'] }),
    /twice/,
  );
});

test('a refused construction leaves no listener on the window', () => {
  // Validation happens before anything is built, so a bad argument cannot
  // leave half a link subscribed to a window that outlives it.
  const window = makeWindow();
  const fake = fakeTransport();
  assert.throws(() => createHostLink({ window, transport: fake.transport, serverRequestMethods: ['a', 'a'] }));
  const inbound = collect(window, 'message');
  dispatchMessageFromView(window, 'mcp-request', { hostId: 'local', request: { id: 1, method: 'm' } });
  assert.deepEqual(fake.sent, []);
  assert.deepEqual(inbound.data(), []);
});

test('close stops forwarding, stops emitting, and closes the client', async () => {
  const { window, fake, link, inbound } = harness();
  rendererRequest(window, { id: 1, method: 'thread/start' });
  await link.close();

  assert.equal(link.closed, true);
  assert.equal(link.client.closed, true);
  assert.equal(fake.closedByClient, true);
  assert.equal(link.bus.running, false);

  const before = fake.sent.length;
  assert.doesNotThrow(() => rendererRequest(window, { id: 2, method: 'thread/start' }));
  assert.equal(fake.sent.length, before, 'nothing is forwarded after close');
  assert.deepEqual(inbound.data(), [], 'and the in-flight call is answered to nobody');
});

test('close answers an outstanding approval before the transport goes', async () => {
  // The error member is produced by the client in a microtask after the
  // handler promise rejects. Closing the transport in the same tick would
  // discard it and leave the server stalled on a promise rather than failed
  // with a reason -- which is why close() is worth awaiting.
  const { fake, link } = harness();
  link.arm();
  fake.receive({
    jsonrpc: JSONRPC_VERSION,
    id: APPROVAL_ID,
    method: APPROVAL_METHODS.commandExecution,
    params: {},
  });
  await link.close();

  assert.deepEqual(fake.last, {
    jsonrpc: JSONRPC_VERSION,
    id: APPROVAL_ID,
    error: { code: HOST_ERROR_CODE, message: 'the host link closed before the renderer answered' },
  });
});

test('close is idempotent and refuses the lifecycle emitters afterwards', async () => {
  const { link } = harness();
  await link.close();
  await assert.doesNotReject(() => link.close());
  assert.throws(() => link.start({ appServerVersion: '1.2.3', installedCodexVersion: '4.5.6' }), /closed/);
  assert.throws(() => link.setConnectionState('connected'), /closed/);
  assert.throws(() => link.reportFatalError('x'), /closed/);
});

test('an app-server notification after close reaches nothing and throws nothing', async () => {
  const { fake, link, inbound } = harness();
  link.arm();
  await link.close();
  assert.doesNotThrow(() => {
    fake.receive({ jsonrpc: JSONRPC_VERSION, method: 'item/started', params: {} });
  });
  assert.deepEqual(inbound.data(), [], 'a stopped bus must not be delivered to');
});

test('a bus stopped under the link is reported instead of throwing', async () => {
  // Nobody should do this, but a throw out of a promise continuation would
  // land somewhere nothing could act on it.
  const { window, fake, link, events } = harness();
  rendererRequest(window, { id: 1, method: 'thread/start' });
  link.bus.stop();
  fake.receive({ jsonrpc: JSONRPC_VERSION, id: 1, result: { ok: true } });
  await settle();
  assert.ok(kinds(events).includes(LINK_EVENT.emitFailed));
});

test('one throwing event observer does not take the link down', () => {
  const { window, fake } = harness({ onEvent: () => { throw new Error('boom'); } });
  assert.doesNotThrow(() => {
    dispatchMessageFromView(window, 'mcp-request', { hostId: 'remote-9', request: { id: 1, method: 'm' } });
  });
  assert.deepEqual(fake.sent, []);
});

test('stats are a copy and pending is a frozen snapshot', () => {
  const { window, link } = harness();
  const snapshot = link.stats;
  rendererRequest(window, { id: 1, method: 'thread/start' });
  assert.equal(snapshot.forwarded, 0, 'a reader holds a snapshot');
  assert.equal(link.stats.forwarded, 1);
  assert.throws(() => { link.pending.queued = 9; }, TypeError);
});

// ---- the seam ------------------------------------------------------------

test('the link has no transport, no clock and no host-specific import', async () => {
  // It runs in the browser beside the renderer and under the test runner, and
  // the renderer owns every deadline in the system -- a second one here could
  // only settle a request the renderer still believes is in flight.
  const source = await readFile(new URL('../../web/hostlink/link.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]).sort();
  // These exact spellings are also the ones a browser resolves correctly from
  // /hostlink/link.mjs; test/web/module-resolution.test.mjs is what proves that,
  // and this assertion is what stops the list growing without anyone checking.
  assert.deepEqual(imports, [
    '../../src/appserver/client.mjs',
    '../host-bus.mjs',
    '../host-protocol.mjs',
  ], 'both sides of the seam, and nothing else');
  assert.equal(/setTimeout|setInterval|setImmediate|Date\.now/.test(source), false, 'no clock, no timer');
  assert.equal(/\bnew WebSocket\b|node:|child_process/.test(source), false);
});

test('the bus is still the bus: nothing here made it import a transport', async () => {
  // The companion to the seam test in test/web/host-bus.test.mjs, from this
  // side. The wiring went into a directory of its own precisely so that file did
  // not have to change, and a regression would most likely arrive as a
  // convenience import added to the bus "while wiring it up".
  const source = await readFile(new URL('../../web/host-bus.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(imports, ['./host-protocol.mjs']);
  assert.equal(/hostlink|appserver/.test(source), false);
});

// ---- the whole slice -----------------------------------------------------

test('a turn runs end to end: start, stream, approve, complete', async () => {
  const { window, fake, link, inbound } = harness();
  link.start({ appServerVersion: '1.2.3', installedCodexVersion: '4.5.6' });

  // 1. The renderer starts a thread. This is also what arms the link.
  rendererRequest(window, { id: 1, method: 'thread/start', params: { cwd: '/work' } });
  assert.equal(link.armed, true);
  fake.receive({ jsonrpc: JSONRPC_VERSION, id: 1, result: { threadId: 'th_1' } });
  await settle();

  // 2. The renderer starts a turn.
  rendererRequest(window, { id: 2, method: 'turn/start', params: { threadId: 'th_1', input: 'hi' } });
  fake.receive({ jsonrpc: JSONRPC_VERSION, method: 'turn/started', params: { turnId: 'tu_1' } });
  fake.receive({
    jsonrpc: JSONRPC_VERSION,
    method: 'item/agentMessage/delta',
    params: { itemId: 'it_1', delta: 'running' },
  });

  // 3. The server asks for an approval; the user accepts in the renderer.
  fake.receive({
    jsonrpc: JSONRPC_VERSION,
    id: APPROVAL_ID,
    method: APPROVAL_METHODS.commandExecution,
    params: commandApprovalParams(),
  });
  dispatchMessageFromView(window, 'mcp-response', {
    hostId: 'local',
    response: { id: APPROVAL_ID, result: { decision: 'accept' } },
  });
  await settle();

  // 4. The turn completes and the turn/start call returns.
  fake.receive({ jsonrpc: JSONRPC_VERSION, method: 'turn/completed', params: { turnId: 'tu_1' } });
  fake.receive({ jsonrpc: JSONRPC_VERSION, id: 2, result: { turnId: 'tu_1' } });
  await settle();

  assert.deepEqual(types(inbound), [
    'codex-app-server-initialized',
    'codex-app-server-connection-changed',
    'mcp-response',
    'mcp-notification',
    'mcp-notification',
    'mcp-request',
    'mcp-notification',
    'mcp-response',
  ]);
  assert.deepEqual(fake.sent.map((message) => message.method ?? `reply:${message.id}`), [
    'thread/start',
    'turn/start',
    `reply:${APPROVAL_ID}`,
  ]);
  assert.deepEqual(link.pending, { rendererRequests: 0, serverRequests: 0, queued: 0 });
  assert.equal(link.stats.results, 2);
  assert.equal(link.stats.errors, 0);
  assert.equal(link.stats.queued, 0, 'the gate never engaged, which is the point of it');
});
