// The front end's seam onto the two sibling app-server modules.
//
// web/appserver.mjs is an adapter: the browser code was written against one
// contract and src/appserver/client.mjs exports another. An adapter that is
// never executed is a guess, so these tests drive the real client and the real
// transport over the sibling suite's own socket double, using the sibling
// suite's own copies of the adapter's request params. Nothing here is mocked
// except the socket.
//
// The second half is drift detection. Two values are duplicated between
// web/stream.mjs and src/appserver/client.mjs by necessity -- the reducer is
// pure and must not import a transport -- and a silent divergence in either is
// the specific failure the adapter's docs warn about: a decision string the
// server does not recognise is coerced to 'decline', producing a UI that looks
// like it approved while the tool call was refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FakeWebSocket,
  settle,
  commandApprovalParams,
  fileChangeApprovalParams,
  userInputParams,
} from '../appserver/fakes.mjs';
import { APPROVAL_DECISIONS, APPROVAL_METHODS, ERROR_CODES } from '../../src/appserver/client.mjs';
import { createClientForSocket } from '../../web/appserver.mjs';
import {
  DECISIONS,
  decisionResult,
  userInputResult,
  initialState,
  reduce,
} from '../../web/stream.mjs';

/** An open socket with a client built over it, exactly as app.mjs builds one. */
function harness({ open = true } = {}) {
  const socket = new FakeWebSocket();
  const errors = [];
  const client = createClientForSocket(socket, { onProtocolError: (error) => errors.push(error) });
  if (open) socket.open();
  return {
    socket,
    client,
    errors,
    sent: () => socket.frames.map((text) => JSON.parse(text)),
    deliver: (frame) => socket.deliver(JSON.stringify(frame)),
  };
}

// ---- the adapter actually adapts ------------------------------------------

test('the shim exposes the five methods app.mjs uses', () => {
  const { client } = harness();
  for (const name of ['call', 'onNotification', 'onRequest', 'close', 'notify']) {
    assert.equal(typeof client[name], 'function', `${name} must be callable`);
  }
});

test('onNotification subscribes through the sibling client', () => {
  const { client, deliver } = harness();
  const seen = [];
  client.onNotification('item/agentMessage/delta', (params) => seen.push(params));

  deliver({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { itemId: 'it_1', delta: 'he' } });
  deliver({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { itemId: 'it_1', delta: 'llo' } });
  // A method nobody subscribed to must not reach the handler.
  deliver({ jsonrpc: '2.0', method: 'turn/completed', params: {} });

  assert.deepEqual(seen.map((p) => p.delta), ['he', 'llo']);
});

test('onNotification returns an unsubscribe', () => {
  const { client, deliver } = harness();
  let count = 0;
  const off = client.onNotification('turn/started', () => { count += 1; });
  deliver({ jsonrpc: '2.0', method: 'turn/started', params: {} });
  off();
  deliver({ jsonrpc: '2.0', method: 'turn/started', params: {} });
  assert.equal(count, 1);
});

test('call sends a JSON-RPC request and resolves on the response', async () => {
  const { client, sent, deliver } = harness();
  const pending = client.call('thread/start', {});

  const frame = sent().at(-1);
  assert.equal(frame.jsonrpc, '2.0');
  assert.equal(frame.method, 'thread/start');
  assert.ok(frame.id != null, 'a request must carry an id');

  // The real adapter answers thread/start with a thread envelope.
  deliver({ jsonrpc: '2.0', id: frame.id, result: { thread: { id: 'th_7', turns: [] } } });
  assert.equal((await pending).thread.id, 'th_7');
});

test('a send made before the socket opens is queued, not lost', async () => {
  const { socket, client, sent, deliver } = harness({ open: false });
  // This is why app.mjs builds the client while the socket is CONNECTING.
  const pending = client.call('thread/start', {});
  assert.deepEqual(sent(), [], 'nothing can be written to a CONNECTING socket');

  socket.open();
  const frame = sent().at(-1);
  assert.equal(frame.method, 'thread/start');
  deliver({ jsonrpc: '2.0', id: frame.id, result: { thread: { id: 'th_8' } } });
  assert.equal((await pending).thread.id, 'th_8');
});

// ---- approvals, which is what the shim exists for -------------------------

test('a command approval reaches the handler with the real params and its wire id', async () => {
  const { client, sent, deliver } = harness();
  const calls = [];
  client.onRequest(APPROVAL_METHODS.commandExecution, (params, context) => {
    calls.push({ params, context });
    return decisionResult('acceptForSession');
  });

  const params = commandApprovalParams();
  deliver({ jsonrpc: '2.0', id: 'rq_1', method: APPROVAL_METHODS.commandExecution, params });
  await settle();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.command, 'npm test');
  assert.deepEqual(calls[0].params.availableDecisions, [...APPROVAL_DECISIONS]);
  // The id is the only correlation key the fileChange and userInput requests
  // have, so the handler must receive it.
  assert.equal(calls[0].context.id, 'rq_1');

  assert.deepEqual(sent().at(-1), {
    jsonrpc: '2.0',
    id: 'rq_1',
    result: { decision: 'acceptForSession' },
  });
});

test('a fileChange approval answers with a decision and carries no diff to show', async () => {
  const { client, sent, deliver } = harness();
  let received = null;
  client.onRequest(APPROVAL_METHODS.fileChange, (params) => {
    received = params;
    return decisionResult('decline');
  });

  deliver({
    jsonrpc: '2.0',
    id: 'rq_2',
    method: APPROVAL_METHODS.fileChange,
    params: fileChangeApprovalParams(),
  });
  await settle();

  // The params the UI has to work with: no diff, no availableDecisions, no
  // approvalId. The itemId is the hook the approval card correlates on.
  assert.equal(received.itemId, 'it_2');
  assert.equal(received.changes, undefined, 'a diff here would make the UI simpler, and there is none');
  assert.equal(received.approvalId, undefined);
  assert.deepEqual(sent().at(-1).result, { decision: 'decline' });
});

test('a decision outside the vocabulary is refused loudly instead of becoming a silent decline', async () => {
  const { client, sent, deliver } = harness();
  // The exact bug this guards: a plausible-looking string the server does not
  // recognise. Without the guard it is coerced server-side to 'decline' and the
  // user sees an approval that never happened.
  client.onRequest(APPROVAL_METHODS.commandExecution, () => ({ decision: 'approved' }));

  deliver({
    jsonrpc: '2.0',
    id: 'rq_3',
    method: APPROVAL_METHODS.commandExecution,
    params: commandApprovalParams(),
  });
  await settle();

  const reply = sent().at(-1);
  assert.equal(reply.id, 'rq_3');
  assert.equal(reply.result, undefined, 'a bad decision must not be reported as a result');
  assert.equal(reply.error.code, ERROR_CODES.invalidParams);
  assert.match(reply.error.message, /approved/);
});

test('decisionResult rejects a bad decision before it can reach the wire', () => {
  for (const decision of APPROVAL_DECISIONS) {
    assert.deepEqual(decisionResult(decision), { decision });
  }
  for (const bad of ['approved', 'allow', 'Accept', '', null, undefined]) {
    assert.throws(() => decisionResult(bad), RangeError);
  }
});

test('a user-input request answers with answers keyed by question id', async () => {
  const { client, sent, deliver } = harness();
  client.onRequest(APPROVAL_METHODS.userInput, (params) => userInputResult(
    params.questions,
    { q_branch: { choice: 'main' } },
  ));

  const params = userInputParams({
    questions: [{
      id: 'q_branch',
      header: 'Which branch?',
      options: [{ label: 'main', description: null }, { label: 'Other', description: null }],
    }],
  });
  deliver({ jsonrpc: '2.0', id: 'rq_4', method: APPROVAL_METHODS.userInput, params });
  await settle();

  const reply = sent().at(-1);
  // Not wrapped in {decision} -- this request has a different reply shape, and
  // wrapping it in the approval guard would corrupt it.
  assert.deepEqual(reply.result, { answers: { q_branch: { answers: ['main'] } } });
});

test('a question with no id is still answered, under the key the adapter looks up', () => {
  // The adapter reads `slot[q.id]`, which for a missing id is the property
  // 'undefined'. Emitting that key delivers the answer; omitting the question
  // loses it silently. The sibling suite's fixture has no id, which is why this
  // case is not hypothetical.
  const { questions } = userInputParams();
  assert.equal(questions[0].id, undefined, 'fixture assumption: the adapter does not guarantee an id');

  const result = userInputResult(questions, { undefined: { choice: 'main' } });
  assert.deepEqual(result, { answers: { undefined: { answers: ['main'] } } });
});

// ---- serverRequest/resolved, via the wire id ------------------------------

test('serverRequest/resolved clears a card the server answered elsewhere', () => {
  // The hard case is fileChange: its params carry no approvalId, so the only
  // thing that can match the resolution notice is the JSON-RPC id.
  let state = reduce(initialState(), {
    method: APPROVAL_METHODS.fileChange,
    params: fileChangeApprovalParams(),
    requestId: 1,
    wireId: 'rq_9',
  });
  assert.equal(state.approvals.length, 1);
  assert.equal(state.approvals[0].wireId, 'rq_9');

  // Someone else's id must leave the card alone.
  const untouched = reduce(state, {
    method: 'serverRequest/resolved',
    params: { threadId: 'th_1', requestId: 'rq_other' },
  });
  assert.equal(untouched, state, 'an unrelated resolution must not even re-render');

  state = reduce(state, {
    method: 'serverRequest/resolved',
    params: { threadId: 'th_1', requestId: 'rq_9' },
  });
  assert.deepEqual(state.approvals, []);
});

test('serverRequest/resolved also matches a command approval on its approvalId', () => {
  // Belt and braces: command approvals repeat the request id in their params,
  // so they match either way.
  const state = reduce(initialState(), {
    method: APPROVAL_METHODS.commandExecution,
    params: commandApprovalParams({ approvalId: 'ap_42' }),
    requestId: 2,
    wireId: null,
  });
  assert.equal(state.approvals.length, 1);

  const cleared = reduce(state, {
    method: 'serverRequest/resolved',
    params: { threadId: 'th_1', requestId: 'ap_42' },
  });
  assert.deepEqual(cleared.approvals, []);
});

// ---- drift ----------------------------------------------------------------

test('the reducer decision vocabulary matches the sibling module exactly', () => {
  // If this fails, one of the two lists grew a decision the other does not know
  // about. Reconcile them rather than relaxing the assertion.
  assert.deepEqual([...DECISIONS], [...APPROVAL_DECISIONS]);
});

test('the request methods the UI subscribes to come from the sibling module', () => {
  // app.mjs cannot be imported here -- it touches `document` at module scope --
  // so the method strings are checked against the sibling's map directly.
  assert.deepEqual(APPROVAL_METHODS, {
    commandExecution: 'item/commandExecution/requestApproval',
    fileChange: 'item/fileChange/requestApproval',
    userInput: 'item/tool/requestUserInput',
  });
});
