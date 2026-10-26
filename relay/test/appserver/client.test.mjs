import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AppServerClient,
  RpcError,
  ProtocolError,
  TransportClosedError,
  ERROR_CODES,
  ANY_NOTIFICATION,
  JSONRPC_VERSION,
  APPROVAL_METHODS,
  APPROVAL_DECISIONS,
  approvalResponder,
  APP_SERVER_VERSION_WILDCARD,
  appServerVersionFromUserAgent,
  DECISION_REQUEST_METHODS,
  INITIALIZE_METHOD,
  initializeAppServer,
  isAppServerVersion,
  isDecisionRequestMethod,
  MCP_EVENT_STREAM_METHODS,
  MCP_EVENT_TERMINATED_METHOD,
  SERVER_REQUEST_METHODS,
} from '../../src/appserver/client.mjs';
import { fakeTransport, settle, commandApprovalParams, fileChangeApprovalParams, userInputParams } from './fakes.mjs';

/** A client on a fake transport, with both hooks recording into arrays. */
function harness() {
  const fake = fakeTransport();
  const protocolErrors = [];
  const closes = [];
  const client = new AppServerClient(fake.transport, {
    onProtocolError: (error) => protocolErrors.push(error),
    onClose: () => closes.push('closed'),
  });
  return { fake, client, protocolErrors, closes };
}

test('a transport must have all four members', () => {
  const stub = { send() {}, onMessage() {}, onClose() {}, close() {} };
  assert.doesNotThrow(() => new AppServerClient(stub));
  for (const missing of ['send', 'onMessage', 'onClose', 'close']) {
    const broken = { ...stub };
    delete broken[missing];
    assert.throws(() => new AppServerClient(broken), new RegExp(`missing ${missing}`));
  }
  assert.throws(() => new AppServerClient(null), TypeError);
});

test('a call goes out as a well-formed JSON-RPC request', () => {
  const { fake, client } = harness();
  client.call('thread/start', { cwd: '/work' });
  assert.deepEqual(fake.last, {
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: 'thread/start',
    params: { cwd: '/work' },
  });
});

test('params are omitted entirely when not given, rather than sent as null', () => {
  const { fake, client } = harness();
  client.call('thread/list');
  assert.ok(!('params' in fake.last));
});

test('ids are monotonic integers from 1', () => {
  const { fake, client } = harness();
  for (const method of ['thread/start', 'turn/start', 'thread/read']) client.call(method);
  assert.deepEqual(fake.sent.map((message) => message.id), [1, 2, 3]);
});

test('a result resolves the matching call', async () => {
  const { fake, client } = harness();
  const pending = client.call('thread/start', { cwd: '/work' });
  assert.equal(client.pendingCount, 1);
  fake.receive({ jsonrpc: '2.0', id: 1, result: { threadId: 'th_1' } });
  assert.deepEqual(await pending, { threadId: 'th_1' });
  assert.equal(client.pendingCount, 0);
});

test('a null result resolves rather than hanging', async () => {
  const { fake, client } = harness();
  const pending = client.call('turn/interrupt', { threadId: 'th_1' });
  // The reference server normalises a void handler's return to `result: null`.
  fake.receive({ jsonrpc: '2.0', id: 1, result: null });
  assert.equal(await pending, null);
});

test('responses are correlated by id, not by arrival order', async () => {
  const { fake, client } = harness();
  const first = client.call('thread/read', { threadId: 'a' });
  const second = client.call('thread/read', { threadId: 'b' });
  const third = client.call('thread/read', { threadId: 'c' });

  // Out of order on purpose, with the middle one last.
  fake.receive({ jsonrpc: '2.0', id: 3, result: 'c' });
  fake.receive({ jsonrpc: '2.0', id: 1, result: 'a' });
  fake.receive({ jsonrpc: '2.0', id: 2, result: 'b' });

  assert.deepEqual(await Promise.all([first, second, third]), ['a', 'b', 'c']);
});

test('responses interleaved with notifications and server requests still land', async () => {
  const { fake, client } = harness();
  const deltas = [];
  client.on('item/agentMessage/delta', (params) => deltas.push(params.delta));
  client.handle('item/tool/requestUserInput', () => ({ answers: [] }));

  const turn = client.call('turn/start', { threadId: 'th_1', input: 'hi' });
  fake.receive({ jsonrpc: '2.0', method: 'turn/started', params: { turnId: 'tu_1' } });
  fake.receive({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'he' } });
  fake.receive({ jsonrpc: '2.0', id: 'srv-1', method: 'item/tool/requestUserInput', params: {} });
  fake.receive({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'llo' } });
  fake.receive({ jsonrpc: '2.0', id: 1, result: { turnId: 'tu_1' } });

  assert.deepEqual(await turn, { turnId: 'tu_1' });
  assert.deepEqual(deltas, ['he', 'llo']);
  await settle();
  assert.deepEqual(fake.last, { jsonrpc: JSONRPC_VERSION, id: 'srv-1', result: { answers: [] } });
});

test('an error response rejects with code, message and data preserved', async () => {
  const { fake, client } = harness();
  const pending = client.call('turn/start', { threadId: 'nope' });
  fake.receive({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32000, message: 'unknown thread nope', data: { threadId: 'nope' } },
  });
  const error = await pending.then(() => assert.fail('expected a rejection'), (e) => e);
  assert.ok(error instanceof RpcError);
  assert.equal(error.code, -32000);
  assert.equal(error.message, 'unknown thread nope');
  assert.deepEqual(error.data, { threadId: 'nope' });
  assert.equal(error.method, 'turn/start', 'the method is kept so a log line is useful');
});

test('an error response with no usable message still names the method and code', async () => {
  const { fake, client } = harness();
  const pending = client.call('thread/read');
  fake.receive({ jsonrpc: '2.0', id: 1, error: { code: -32601 } });
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, -32601);
    assert.match(error.message, /thread\/read/);
    return true;
  });
});

test('a response with neither result nor error rejects as a protocol error', async () => {
  const { fake, client } = harness();
  const pending = client.call('thread/read');
  fake.receive({ jsonrpc: '2.0', id: 1 });
  await assert.rejects(pending, ProtocolError);
});

test('a response whose id came back as a string still correlates', async () => {
  const { fake, client } = harness();
  const pending = client.call('thread/start');
  // Some JSON-RPC servers stringify ids; failing to correlate would hang forever.
  fake.receive({ jsonrpc: '2.0', id: '1', result: 'ok' });
  assert.equal(await pending, 'ok');
});

test('a transport close rejects every call in flight', async () => {
  const { fake, client, closes } = harness();
  const calls = [client.call('a'), client.call('b'), client.call('c')];
  fake.receive({ jsonrpc: '2.0', id: 2, result: 'b survived' });
  assert.equal(await calls[1], 'b survived');

  fake.drop();
  assert.equal(client.closed, true);
  assert.equal(client.pendingCount, 0);
  assert.equal(closes.length, 1);
  for (const index of [0, 2]) {
    await assert.rejects(calls[index], TransportClosedError);
  }
});

test('a call after close rejects immediately instead of queueing', async () => {
  const { fake, client } = harness();
  fake.drop();
  await assert.rejects(client.call('thread/start'), TransportClosedError);
  assert.equal(fake.sent.length, 0, 'nothing may be written to a dead transport');
});

test('notify and replies after close are dropped, not thrown', () => {
  const { fake, client } = harness();
  client.handle('item/fileChange/requestApproval', () => ({ decision: 'accept' }));
  fake.drop();
  assert.doesNotThrow(() => client.notify('initialized'));
  assert.equal(fake.sent.length, 0);
});

test('close() closes the transport once and is idempotent', () => {
  const { fake, client, closes } = harness();
  client.close();
  client.close();
  assert.equal(fake.closedByClient, true);
  assert.equal(closes.length, 1);
});

test('a transport whose send throws rejects that call rather than escaping', async () => {
  const transport = {
    send() {
      throw new Error('socket is gone');
    },
    onMessage() {},
    onClose() {},
    close() {},
  };
  const client = new AppServerClient(transport);
  await assert.rejects(client.call('thread/start'), /socket is gone/);
  assert.equal(client.pendingCount, 0);
});

test('an AbortSignal rejects exactly one call and leaves the others alone', async () => {
  const { fake, client } = harness();
  const controller = new AbortController();
  const aborted = client.call('turn/start', { threadId: 'a' }, { signal: controller.signal });
  const other = client.call('turn/start', { threadId: 'b' });

  controller.abort();
  await assert.rejects(aborted, (error) => error.name === 'AbortError');

  fake.receive({ jsonrpc: '2.0', id: 2, result: 'b' });
  assert.equal(await other, 'b');
});

test('an abort reason is what the caller sees', async () => {
  const { client } = harness();
  const controller = new AbortController();
  const reason = new Error('the user navigated away');
  const pending = client.call('turn/start', {}, { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});

test('an already-aborted signal rejects without sending anything', async () => {
  const { fake, client } = harness();
  await assert.rejects(
    client.call('turn/start', {}, { signal: AbortSignal.abort() }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(fake.sent.length, 0);
});

test('a late response to an aborted call is discarded silently', async () => {
  const { fake, client, protocolErrors } = harness();
  const controller = new AbortController();
  const pending = client.call('turn/start', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');

  // The app-server has no generic cancel, so the response is still coming. It
  // must not be reported as an unknown id -- that would be noise on every abort.
  fake.receive({ jsonrpc: '2.0', id: 1, result: 'too late' });
  assert.deepEqual(protocolErrors, []);
  assert.equal(client.pendingCount, 0);
});

test('an aborted call does not reject again when the transport later closes', async () => {
  const { fake, client } = harness();
  const controller = new AbortController();
  const pending = client.call('turn/start', {}, { signal: controller.signal });
  controller.abort();
  const first = await pending.then(() => null, (error) => error);
  fake.drop();
  const second = await pending.then(() => null, (error) => error);
  assert.equal(first, second, 'the rejection reason must not be overwritten');
  assert.equal(first.name, 'AbortError');
});

test('notifications dispatch to a method handler', () => {
  const { fake, client } = harness();
  const seen = [];
  client.on('item/completed', (params, method) => seen.push([method, params.item.id]));
  fake.receive({ jsonrpc: '2.0', method: 'item/completed', params: { item: { id: 'it_1' } } });
  assert.deepEqual(seen, [['item/completed', 'it_1']]);
});

test('several handlers for one method all fire, and unsubscribing removes just one', () => {
  const { fake, client } = harness();
  const seen = [];
  const off = client.on('turn/completed', () => seen.push('a'));
  client.on('turn/completed', () => seen.push('b'));
  fake.receive({ jsonrpc: '2.0', method: 'turn/completed' });
  assert.deepEqual(seen, ['a', 'b']);

  off();
  fake.receive({ jsonrpc: '2.0', method: 'turn/completed' });
  assert.deepEqual(seen, ['a', 'b', 'b']);
});

test('the wildcard sees every notification, including ones a handler also saw', () => {
  const { fake, client } = harness();
  const all = [];
  const specific = [];
  client.on(ANY_NOTIFICATION, (_params, method) => all.push(method));
  client.on('thread/tokenUsage/updated', (params) => specific.push(params.total));

  fake.receive({ jsonrpc: '2.0', method: 'turn/started', params: {} });
  fake.receive({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { total: 42 } });
  fake.receive({ jsonrpc: '2.0', method: 'item/reasoning/textDelta', params: { delta: '.' } });

  assert.deepEqual(all, ['turn/started', 'thread/tokenUsage/updated', 'item/reasoning/textDelta']);
  assert.deepEqual(specific, [42], 'a relay forwarding everything must not shadow local handlers');
});

test('an unknown notification method is not an error', () => {
  const { fake, client, protocolErrors } = harness();
  assert.doesNotThrow(() => fake.receive({ jsonrpc: '2.0', method: 'some/future/event', params: {} }));
  assert.deepEqual(protocolErrors, [], 'clients must tolerate notifications they do not know');
  assert.equal(fake.sent.length, 0, 'a notification is never answered');
});

test('a throwing notification handler is reported and the next handler still runs', () => {
  const { fake, client, protocolErrors } = harness();
  const seen = [];
  client.on('turn/completed', () => {
    throw new Error('handler exploded');
  });
  client.on('turn/completed', () => seen.push('second'));
  assert.doesNotThrow(() => fake.receive({ jsonrpc: '2.0', method: 'turn/completed' }));
  assert.deepEqual(seen, ['second']);
  assert.equal(protocolErrors.length, 1);
  assert.match(protocolErrors[0].message, /handler exploded/);
});

test('an async notification handler that rejects is reported, not left unhandled', async () => {
  const { fake, client, protocolErrors } = harness();
  client.on('turn/started', async () => {
    throw new Error('async explosion');
  });
  fake.receive({ jsonrpc: '2.0', method: 'turn/started' });
  await settle();
  assert.equal(protocolErrors.length, 1);
  assert.match(protocolErrors[0].message, /async explosion/);
});

test('notify sends a request-shaped message without an id', () => {
  const { fake, client } = harness();
  client.notify('initialized');
  assert.deepEqual(fake.last, { jsonrpc: JSONRPC_VERSION, method: 'initialized' });
  client.notify('ping', { n: 1 });
  assert.deepEqual(fake.last, { jsonrpc: JSONRPC_VERSION, method: 'ping', params: { n: 1 } });
});

test('a server command-approval request gets a well-formed response', async () => {
  const { fake, client } = harness();
  const requests = [];
  client.handle(APPROVAL_METHODS.commandExecution, (params, context) => {
    requests.push({ params, context });
    return { decision: 'acceptForSession' };
  });

  fake.receive({
    jsonrpc: '2.0',
    // The reference server ids these with randomUUID(), so an id is a string.
    id: '7f1b0c2e-0000-4000-8000-000000000001',
    method: APPROVAL_METHODS.commandExecution,
    params: commandApprovalParams({ command: 'ls -la' }),
  });
  await settle();

  assert.deepEqual(fake.last, {
    jsonrpc: JSONRPC_VERSION,
    id: '7f1b0c2e-0000-4000-8000-000000000001',
    result: { decision: 'acceptForSession' },
  });
  assert.equal(requests[0].params.command, 'ls -la');
  assert.equal(requests[0].params.approvalId, 'ap_1');
  assert.deepEqual(requests[0].params.availableDecisions, [...APPROVAL_DECISIONS]);
  assert.equal(requests[0].context.method, APPROVAL_METHODS.commandExecution);
  assert.equal(requests[0].context.id, '7f1b0c2e-0000-4000-8000-000000000001');
});

test('an async request handler is awaited before the response goes out', async () => {
  const { fake, client } = harness();
  let release;
  client.handle(APPROVAL_METHODS.fileChange, () => new Promise((resolve) => {
    release = () => resolve({ decision: 'decline' });
  }));

  fake.receive({
    jsonrpc: '2.0',
    id: 9,
    method: APPROVAL_METHODS.fileChange,
    params: fileChangeApprovalParams(),
  });
  await settle();
  assert.equal(fake.sent.length, 0, 'nothing is sent while the user is still deciding');

  release();
  await settle();
  assert.deepEqual(fake.last, { jsonrpc: JSONRPC_VERSION, id: 9, result: { decision: 'decline' } });
});

test('a requestUserInput handler answers with the shape the server expects', async () => {
  const { fake, client } = harness();
  client.handle(APPROVAL_METHODS.userInput, (params) => ({
    answers: params.questions.map((question) => ({ answer: question.options[0].label })),
  }));
  fake.receive({ jsonrpc: '2.0', id: 'q-1', method: APPROVAL_METHODS.userInput, params: userInputParams() });
  await settle();
  assert.deepEqual(fake.last.result, { answers: [{ answer: 'main' }] });
});

test('a request handler returning undefined replies with null, not a bare response', async () => {
  const { fake, client } = harness();
  client.handle(APPROVAL_METHODS.userInput, () => {});
  fake.receive({ jsonrpc: '2.0', id: 4, method: APPROVAL_METHODS.userInput, params: userInputParams() });
  await settle();
  assert.deepEqual(fake.last, { jsonrpc: JSONRPC_VERSION, id: 4, result: null });
});

test('a request handler that throws produces a JSON-RPC error response', async () => {
  const { fake, client } = harness();
  client.handle(APPROVAL_METHODS.fileChange, () => {
    throw new Error('the approval UI is not mounted');
  });
  fake.receive({
    jsonrpc: '2.0',
    id: 11,
    method: APPROVAL_METHODS.fileChange,
    params: fileChangeApprovalParams(),
  });
  await settle();

  assert.deepEqual(fake.last, {
    jsonrpc: JSONRPC_VERSION,
    id: 11,
    error: { code: ERROR_CODES.internalError, message: 'the approval UI is not mounted' },
  });
  assert.ok(!('data' in fake.last.error), 'no stack or internals leak to the peer');
});

test('a handler throwing RpcError chooses the code, message and data', async () => {
  const { fake, client } = harness();
  client.handle(APPROVAL_METHODS.userInput, () => {
    throw new RpcError('the question list was empty', {
      code: ERROR_CODES.invalidParams,
      data: { questions: 0 },
    });
  });
  fake.receive({ jsonrpc: '2.0', id: 12, method: APPROVAL_METHODS.userInput, params: userInputParams() });
  await settle();
  assert.deepEqual(fake.last.error, {
    code: ERROR_CODES.invalidParams,
    message: 'the question list was empty',
    data: { questions: 0 },
  });
});

test('an unregistered server request is answered -32601 so the turn never stalls', async () => {
  const { fake, client, protocolErrors } = harness();
  fake.receive({
    jsonrpc: '2.0',
    id: 'req-1',
    method: 'item/commandExecution/requestApproval',
    params: { command: 'rm -rf /' },
  });
  await settle();

  assert.equal(fake.last.id, 'req-1');
  assert.equal(fake.last.error.code, ERROR_CODES.methodNotFound);
  assert.match(fake.last.error.message, /item\/commandExecution\/requestApproval/);
  assert.ok(!('result' in fake.last));
  assert.deepEqual(protocolErrors, [], 'answering -32601 is the correct outcome, not a fault');
});

test('unregistering a request handler puts the method back to -32601', async () => {
  const { fake, client } = harness();
  const off = client.handle('item/tool/requestUserInput', () => ({ answers: ['yes'] }));
  fake.receive({ jsonrpc: '2.0', id: 1, method: 'item/tool/requestUserInput', params: {} });
  await settle();
  assert.deepEqual(fake.last.result, { answers: ['yes'] });

  off();
  fake.receive({ jsonrpc: '2.0', id: 2, method: 'item/tool/requestUserInput', params: {} });
  await settle();
  assert.equal(fake.last.error.code, ERROR_CODES.methodNotFound);
});

test('registering two handlers for one method is refused', () => {
  const { client } = harness();
  client.handle(APPROVAL_METHODS.fileChange, () => ({}));
  assert.throws(
    () => client.handle(APPROVAL_METHODS.fileChange, () => ({})),
    /already registered/,
  );
});

// -- approvalResponder -------------------------------------------------------
//
// The server funnels our reply through a normalizeDecision that recognises four
// strings and silently answers 'decline' to anything else. These tests exist to
// make sure a typo surfaces here, where it is debuggable, instead of there,
// where it looks like a working round-trip that just happens to refuse.

/** Drive one approval through a client and return the response the peer saw. */
async function respondTo(decide, { method = APPROVAL_METHODS.commandExecution, params } = {}) {
  const { fake, client } = harness();
  client.handle(method, approvalResponder(decide));
  fake.receive({ jsonrpc: '2.0', id: 'ap-1', method, params: params ?? commandApprovalParams() });
  await settle();
  return fake.last;
}

test('approvalResponder needs a decision function', () => {
  assert.throws(() => approvalResponder(), TypeError);
  assert.throws(() => approvalResponder({ decision: 'accept' }), TypeError);
});

test('every decision the server recognises passes through', async () => {
  for (const decision of APPROVAL_DECISIONS) {
    const response = await respondTo(() => decision);
    assert.deepEqual(response.result, { decision }, `${decision} must survive the wrapper`);
  }
});

test('a decision may be returned bare or already wrapped', async () => {
  assert.deepEqual((await respondTo(() => 'accept')).result, { decision: 'accept' });
  assert.deepEqual((await respondTo(() => ({ decision: 'accept' }))).result, { decision: 'accept' });
  assert.deepEqual((await respondTo(async () => 'cancel')).result, { decision: 'cancel' });
});

test('a decision the server would silently downgrade is an error instead', async () => {
  // Each of these reaches normalizeDecision and comes back 'decline' with no
  // error anywhere -- the exact failure this wrapper exists to prevent.
  for (const wrong of ['approve', 'allow', 'yes', 'Accept', 'accepted', true, 1, null, undefined, {}]) {
    const response = await respondTo(() => wrong);
    assert.equal(response.error?.code, ERROR_CODES.invalidParams, `${JSON.stringify(wrong)} slipped through`);
    assert.equal(response.result, undefined, 'a bad decision must not reach the server at all');
    assert.match(response.error.message, /is not an approval decision/);
    assert.deepEqual(response.error.data, { expected: [...APPROVAL_DECISIONS] });
  }
});

test('the rejected decision is named in the message, so the typo is obvious', async () => {
  const response = await respondTo(() => 'acceptforsession');
  assert.match(response.error.message, /"acceptforsession"/);
  assert.match(response.error.message, /accept, acceptForSession, decline, cancel/);
});

test('the object-shaped amendment decisions the server accepts are passed through', async () => {
  // normalizeDecision maps both of these to acceptForSession, so rejecting them
  // would make the wrapper wrong rather than strict.
  for (const key of ['acceptWithExecpolicyAmendment', 'applyNetworkPolicyAmendment']) {
    const decision = { [key]: { rule: 'allow npm test' } };
    const response = await respondTo(() => decision);
    assert.deepEqual(response.result, { decision });
  }
});

test('an unrelated object is still refused, amendment keys or nothing', async () => {
  const response = await respondTo(() => ({ approved: true }));
  assert.equal(response.error.code, ERROR_CODES.invalidParams);
});

test('approvalResponder hands the real params and context to the decision', async () => {
  const seen = [];
  const response = await respondTo((params, context) => {
    seen.push({ params, context });
    return params.availableDecisions.includes('acceptForSession') ? 'acceptForSession' : 'accept';
  });
  assert.deepEqual(response.result, { decision: 'acceptForSession' });
  assert.equal(seen[0].params.command, 'npm test');
  assert.equal(seen[0].params.cwd, '/work');
  assert.equal(seen[0].context.method, APPROVAL_METHODS.commandExecution);
});

test('a decision function that throws still produces an error response', async () => {
  const response = await respondTo(() => {
    throw new Error('no UI attached');
  });
  assert.equal(response.error.code, ERROR_CODES.internalError);
  assert.equal(response.error.message, 'no UI attached');
});

test('approvalResponder works for fileChange, which has no availableDecisions', async () => {
  const response = await respondTo(() => 'accept', {
    method: APPROVAL_METHODS.fileChange,
    params: fileChangeApprovalParams(),
  });
  assert.deepEqual(response.result, { decision: 'accept' });
});

test('a request handler is given {} rather than undefined params', async () => {
  const { fake, client } = harness();
  let received = 'unset';
  client.handle('item/tool/requestUserInput', (params) => {
    received = params;
    return null;
  });
  fake.receive({ jsonrpc: '2.0', id: 1, method: 'item/tool/requestUserInput' });
  await settle();
  assert.deepEqual(received, {});
});

test('the id space of inbound requests never collides with our own', async () => {
  const { fake, client } = harness();
  client.handle('item/fileChange/requestApproval', () => ({ decision: 'accept' }));
  const pending = client.call('turn/start', { threadId: 'th_1' }); // our id 1

  // The server numbers its own requests independently and may well pick 1 too.
  fake.receive({ jsonrpc: '2.0', id: 1, method: 'item/fileChange/requestApproval', params: {} });
  await settle();
  assert.deepEqual(fake.last, { jsonrpc: JSONRPC_VERSION, id: 1, result: { decision: 'accept' } });
  assert.equal(client.pendingCount, 1, 'our call is untouched by the collision');

  fake.receive({ jsonrpc: '2.0', id: 1, result: { turnId: 'tu_1' } });
  assert.deepEqual(await pending, { turnId: 'tu_1' });
});

test('malformed inbound messages are reported and never thrown', () => {
  const { fake, client, protocolErrors } = harness();
  const malformed = [null, 42, 'a string', true, {}, { id: 7, method: 42 }];
  for (const message of malformed) {
    assert.doesNotThrow(() => fake.receive(message), `threw on ${JSON.stringify(message)}`);
  }
  assert.equal(protocolErrors.length, malformed.length);
  for (const error of protocolErrors) assert.ok(error instanceof ProtocolError);
  assert.equal(fake.sent.length, 0, 'a message we cannot parse is not worth answering');
});

test('a malformed message carries the offending payload for logging', () => {
  const { fake, protocolErrors } = harness();
  fake.receive({ nonsense: true });
  assert.deepEqual(protocolErrors[0].payload, { nonsense: true });
});

test('a mismatched jsonrpc version is reported rather than guessed at', () => {
  const { fake, protocolErrors } = harness();
  fake.receive({ jsonrpc: '1.0', method: 'turn/started' });
  assert.match(protocolErrors[0].message, /unsupported jsonrpc version "1.0"/);
});

test('a message with no jsonrpc member is still accepted', () => {
  const { fake, client } = harness();
  const seen = [];
  client.on('turn/started', () => seen.push(1));
  fake.receive({ method: 'turn/started' });
  assert.deepEqual(seen, [1]);
});

test('a response to an id we never sent is reported, not silently dropped', () => {
  const { fake, protocolErrors } = harness();
  fake.receive({ jsonrpc: '2.0', id: 999, result: 'from nowhere' });
  assert.match(protocolErrors[0].message, /unknown request id 999/);
});

test("the peer's uncorrelated parse error is surfaced", () => {
  const { fake, protocolErrors } = harness();
  // Exactly what the reference server sends for a frame it could not parse.
  fake.receive({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Unexpected token' } });
  assert.match(protocolErrors[0].message, /uncorrelated error: Unexpected token/);
});

test('an inbound request with a null id is reported and not answered', () => {
  const { fake, client, protocolErrors } = harness();
  client.handle('item/fileChange/requestApproval', () => ({ decision: 'accept' }));
  fake.receive({ jsonrpc: '2.0', id: null, method: 'item/fileChange/requestApproval', params: {} });
  assert.match(protocolErrors[0].message, /null id and cannot be answered/);
  assert.equal(fake.sent.length, 0);
});

test('a batch array is iterated element by element', async () => {
  const { fake, client } = harness();
  const notes = [];
  client.on(ANY_NOTIFICATION, (_params, method) => notes.push(method));
  client.handle('item/tool/requestUserInput', () => ({ answers: [] }));
  const pending = client.call('thread/start');

  fake.receive([
    { jsonrpc: '2.0', method: 'turn/started', params: {} },
    { jsonrpc: '2.0', id: 1, result: { threadId: 'th_1' } },
    { jsonrpc: '2.0', id: 'srv', method: 'item/tool/requestUserInput', params: {} },
  ]);

  assert.deepEqual(await pending, { threadId: 'th_1' });
  assert.deepEqual(notes, ['turn/started']);
  await settle();
  assert.equal(fake.last.id, 'srv');
});

test('one bad element does not spoil the rest of a batch', async () => {
  const { fake, client, protocolErrors } = harness();
  const pending = client.call('thread/start');
  fake.receive([null, { jsonrpc: '2.0', id: 1, result: 'ok' }]);
  assert.equal(await pending, 'ok');
  assert.equal(protocolErrors.length, 1);
});

test('a call needs a method name', async () => {
  const { client } = harness();
  for (const bad of ['', undefined, null, 42]) {
    await assert.rejects(client.call(bad), TypeError);
  }
  assert.throws(() => client.notify(''), TypeError);
  assert.throws(() => client.on('', () => {}), TypeError);
  assert.throws(() => client.on('x', 'not a function'), TypeError);
  assert.throws(() => client.handle('', () => {}), TypeError);
  assert.throws(() => client.handle('x', null), TypeError);
});

test('a reporting hook that throws cannot take the client down', () => {
  const fake = fakeTransport();
  const client = new AppServerClient(fake.transport, {
    onProtocolError: () => {
      throw new Error('logging exploded');
    },
  });
  assert.doesNotThrow(() => fake.receive(null));
  assert.equal(client.closed, false);
});

test('an onClose hook that throws is reported and close still completes', () => {
  const fake = fakeTransport();
  const protocolErrors = [];
  const client = new AppServerClient(fake.transport, {
    onProtocolError: (error) => protocolErrors.push(error),
    onClose: () => {
      throw new Error('close hook exploded');
    },
  });
  assert.doesNotThrow(() => fake.drop());
  assert.equal(client.closed, true);
  assert.match(protocolErrors[0].message, /close hook exploded/);
});

// -- the server-initiated request surface ------------------------------------
//
// These are the tests for the bug that cost the most and showed the least: a
// short method table. `#serve` answers an unregistered method -32601, the server
// reads that as a refusal, the renderer is never asked, and the user watches a
// turn do something they did not approve of with no error on either side. The
// list below is therefore pinned by literal string, because a table derived from
// another table cannot catch the case where both are short.

test('every method the app server can ask is in the table, spelled exactly', () => {
  assert.deepEqual(SERVER_REQUEST_METHODS, {
    commandExecution: 'item/commandExecution/requestApproval',
    fileChange: 'item/fileChange/requestApproval',
    permissions: 'item/permissions/requestApproval',
    userInput: 'item/tool/requestUserInput',
    optionPicker: 'item/tool/requestOptionPicker',
    setupContextPicker: 'item/tool/requestSetupCodexContextPicker',
    mcpElicitation: 'mcpServer/elicitation/request',
    dynamicToolCall: 'item/tool/call',
    currentTime: 'currentTime/read',
  });
  assert.equal(Object.isFrozen(SERVER_REQUEST_METHODS), true);
});

test('currentTime/read is in the table because the renderer answers it, not us', () => {
  // The ninth entry, and the one that was absent on a plausible-sounding
  // argument: a clock is a question a host can answer correctly, so answering
  // it looked like a host duty. The bundle says otherwise -- the renderer
  // answers it from inside its own inbound dispatcher, with
  // `result:{currentTimeAt:Math.floor(Date.now()/1e3)}` -- so while it was
  // missing here `#serve` refused it -32601 and the renderer was never asked.
  // Pinned as its own test rather than left to the deepEqual above, because the
  // reason it belongs is the thing that was got wrong, not the spelling.
  assert.equal(SERVER_REQUEST_METHODS.currentTime, 'currentTime/read');
  assert.equal(isDecisionRequestMethod(SERVER_REQUEST_METHODS.currentTime), false);
});

test('the MCP event-stream names are pinned, and none of them is a request to us', () => {
  assert.deepEqual(MCP_EVENT_STREAM_METHODS, {
    start: 'mcpServer/event/stream/start',
    stop: 'mcpServer/event/stream/stop',
    notification: 'mcpServer/event/stream/notification',
  });
  assert.equal(Object.isFrozen(MCP_EVENT_STREAM_METHODS), true);
  assert.equal(MCP_EVENT_TERMINATED_METHOD, 'notifications/events/terminated');
  // Deliberately NOT in the table above: start and stop travel the other way
  // (the renderer asks the server) and the notification carries no id, so a
  // handler registered for any of the three could never run. They are pinned by
  // literal string for the reason the table is -- a host that matches the
  // notification on a misspelling forwards it generically, which is traffic that
  // looks correct and delivers no MCP event to the UI at all.
  for (const method of Object.values(MCP_EVENT_STREAM_METHODS)) {
    assert.equal(Object.values(SERVER_REQUEST_METHODS).includes(method), false, method);
  }
  assert.equal(Object.values(SERVER_REQUEST_METHODS).includes(MCP_EVENT_TERMINATED_METHOD), false);
});

test('item/plan/requestImplementation is deliberately absent', () => {
  // It sits in the renderer's request registry next to the nine above and is
  // indistinguishable from them in the UI, but the renderer SYNTHESISES it --
  // it mints the id itself as `implement-plan:<turnId>` -- and no server sends
  // one. A handler for it would be a line that reads as coverage and can never
  // run, which is worse than no line at all.
  assert.equal(
    Object.values(SERVER_REQUEST_METHODS).includes('item/plan/requestImplementation'),
    false,
  );
});

test('the three approval methods are a strict subset of the wire table', () => {
  // APPROVAL_METHODS is the name a human uses for the subset the approval UI
  // subscribes to; it is NOT the set of things the server can ask. Keeping the
  // values sourced from the one table is what makes that relationship checkable
  // instead of a matter of trust.
  for (const method of Object.values(APPROVAL_METHODS)) {
    assert.ok(
      Object.values(SERVER_REQUEST_METHODS).includes(method),
      `${method} must be a method the server can actually send`,
    );
  }
  assert.equal(Object.keys(APPROVAL_METHODS).length, 3);
  assert.ok(Object.keys(SERVER_REQUEST_METHODS).length > Object.keys(APPROVAL_METHODS).length);
});

test('a handler registered for every wire method answers all nine', async () => {
  // The end-to-end form of the same bug: with the short table, five of these
  // nine came back -32601, and the clock read made six. It was absent for a
  // different reason than the other five -- it was believed to be a host duty
  // rather than overlooked -- and refused itself in exactly the same way.
  const { fake, client } = harness();
  for (const method of Object.values(SERVER_REQUEST_METHODS)) {
    client.handle(method, () => ({ answeredBy: method }));
  }
  let id = 0;
  for (const method of Object.values(SERVER_REQUEST_METHODS)) {
    fake.receive({ jsonrpc: JSONRPC_VERSION, id: `req-${(id += 1)}`, method, params: {} });
  }
  await settle();
  assert.equal(fake.sent.length, Object.keys(SERVER_REQUEST_METHODS).length);
  for (const response of fake.sent) {
    assert.equal(response.error, undefined, `${JSON.stringify(response)} must not be a refusal`);
    assert.ok(Object.values(SERVER_REQUEST_METHODS).includes(response.result.answeredBy));
  }
});

// -- the decision guard, scoped ----------------------------------------------

test('only the two decision methods are policed', () => {
  assert.deepEqual(DECISION_REQUEST_METHODS, [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
  ]);
  assert.equal(isDecisionRequestMethod(APPROVAL_METHODS.commandExecution), true);
  assert.equal(isDecisionRequestMethod(APPROVAL_METHODS.fileChange), true);
  for (const method of ['item/permissions/requestApproval', 'item/tool/requestUserInput',
    'item/tool/requestOptionPicker', 'item/tool/requestSetupCodexContextPicker',
    'mcpServer/elicitation/request', 'item/tool/call', 'currentTime/read',
    undefined, '']) {
    assert.equal(isDecisionRequestMethod(method), false, `${String(method)} has no decision to police`);
  }
});

test('the seven non-decision shapes pass through approvalResponder untouched', async () => {
  // The nine methods answer in eight shapes: the two approvals share
  // `{decision}` and the other seven are one apiece. A wrapper that insisted on
  // a `decision` key would turn every permission grant, option pick,
  // elicitation, dynamic tool result and clock read into an invalid-params
  // error -- the guard against silent refusals becoming the cause of loud ones.
  // The count in the name is the number of rows below for that reason.
  const replies = [
    [SERVER_REQUEST_METHODS.permissions, { permissions: { read: ['/work'] }, scope: 'turn' }],
    [SERVER_REQUEST_METHODS.userInput, { answers: { 'Which branch?': 'main' } }],
    [SERVER_REQUEST_METHODS.optionPicker,
      { action: 'submit', selectedOptions: ['main'], freeformAnswer: null }],
    [SERVER_REQUEST_METHODS.setupContextPicker, { action: 'dismiss', selectedSources: [] }],
    [SERVER_REQUEST_METHODS.mcpElicitation, { action: 'accept', content: { token: 'abc' } }],
    [SERVER_REQUEST_METHODS.dynamicToolCall, { content: [{ type: 'text', text: 'ok' }], isError: false }],
    [SERVER_REQUEST_METHODS.currentTime, { currentTimeAt: 1761300000 }],
  ];
  for (const [method, reply] of replies) {
    const { fake, client } = harness();
    client.handle(method, approvalResponder(() => reply));
    fake.receive({ jsonrpc: JSONRPC_VERSION, id: 'x', method, params: {} });
    await settle();
    assert.equal(fake.last.error, undefined, `${method} must not be refused`);
    assert.deepEqual(fake.last.result, reply, `${method} must survive byte for byte`);
    assert.deepEqual(Object.keys(fake.last.result), Object.keys(reply), 'key order too');
  }
});

test('the decision guard still bites on the two methods that have one', async () => {
  // The scoping must not become a hole: these two are exactly where a typo
  // reaches the server's normalizeDecision and comes back a silent decline.
  for (const method of DECISION_REQUEST_METHODS) {
    const response = await respondTo(() => 'approve', { method, params: commandApprovalParams() });
    assert.equal(response.error?.code, ERROR_CODES.invalidParams, `${method} must still be policed`);
  }
});

// -- the initialize handshake ------------------------------------------------
//
// The version in this reply is what the renderer gates half its features on,
// and both ways of getting it wrong are silent: an unparseable string turns
// every gate off (which strips `turnTrigger` from every turn/start and logs
// nothing) and '0.0.0' turns every gate on while two checks that do not use the
// comparison helper treat it as a refusal.

/** The userAgent the live adapter builds, with its real default compat version. */
const REAL_USER_AGENT = 'codex-relay-web/0.142.3 (macos; aarch64) claude-codex (codex-relay-web; 0.0.0)';

test('the app server version is read from the leading token of the userAgent', () => {
  assert.equal(appServerVersionFromUserAgent(REAL_USER_AGENT), '0.142.3');
  // Note which version that is NOT: the trailing parenthetical carries the
  // version the CLIENT sent in. Reading it would report the relay's own release
  // number as the server's, and the relay's package version happens to be the
  // wildcard, so the bug would look exactly like having guessed.
  assert.notEqual(appServerVersionFromUserAgent(REAL_USER_AGENT), APP_SERVER_VERSION_WILDCARD);
});

test('an unusable userAgent yields null rather than a plausible lie', () => {
  for (const junk of [undefined, null, 42, '', 'codex-app', 'codex-app/', 'codex-app/dev',
    'codex-app/1 (macos)', '/0.1.2', 'codex-app 0.1.2']) {
    assert.equal(appServerVersionFromUserAgent(junk), null, `${JSON.stringify(junk)} is not a version`);
  }
});

test('a version is only usable if the renderer could compare it', () => {
  for (const good of ['0.142.3', '1.0.0', '0.0.1', '10.20.30', '1.2.3-alpha.1', '1.2.3+build.5']) {
    assert.equal(isAppServerVersion(good), true, `${good} should be comparable`);
  }
  for (const bad of ['1', '1.2', 'v1.2.3', '1.2.3.4', 'dev', '', ' 1.2.3', '01.2.3', null, 1.23]) {
    assert.equal(isAppServerVersion(bad), false, `${JSON.stringify(bad)} should be refused`);
  }
  // The wildcard parses. That is the trap: it is syntactically fine and
  // semantically poison, so rejecting it is a separate decision from parsing.
  assert.equal(isAppServerVersion(APP_SERVER_VERSION_WILDCARD), true);
  assert.equal(APP_SERVER_VERSION_WILDCARD, '0.0.0');
});

test('initializeAppServer sends one initialize and reports the version it got', async () => {
  const { fake, client } = harness();
  const pending = initializeAppServer(client, {
    clientInfo: { name: 'codex-relay-web', version: '0.0.0' },
  });
  assert.equal(fake.sent.length, 1, 'one call, and nothing else');
  assert.equal(fake.last.method, INITIALIZE_METHOD);
  assert.deepEqual(fake.last.params, {
    clientInfo: { name: 'codex-relay-web', version: '0.0.0' },
    capabilities: {},
  });
  fake.receive({
    jsonrpc: JSONRPC_VERSION,
    id: fake.last.id,
    result: {
      userAgent: REAL_USER_AGENT,
      codexHome: '/home/x/.codex',
      platformFamily: 'unix',
      platformOs: 'macos',
    },
  });
  const handshake = await pending;
  assert.equal(handshake.appServerVersion, '0.142.3');
  assert.equal(handshake.result.codexHome, '/home/x/.codex');
});

test('initializeAppServer declares no capability it cannot relay', async () => {
  // The adapter branches on `capabilities.subAgentActivityCompleted` and starts
  // sending a notification kind when it is true. A relay forwards whatever
  // arrives, so declaring on the renderer's behalf would commit it to traffic
  // its own build may not handle -- an empty object is the only honest default.
  const { fake, client } = harness();
  initializeAppServer(client, { clientInfo: { name: 'x', version: '1.0.0' } });
  assert.deepEqual(fake.last.params.capabilities, {});
});

test('initializeAppServer passes a caller-declared capability through', async () => {
  const { fake, client } = harness();
  initializeAppServer(client, {
    clientInfo: { name: 'x', version: '1.0.0' },
    capabilities: { subAgentActivityCompleted: true },
  });
  assert.deepEqual(fake.last.params.capabilities, { subAgentActivityCompleted: true });
});

test('initializeAppServer refuses to introduce itself without an identity', async () => {
  const { client } = harness();
  await assert.rejects(() => initializeAppServer(client), TypeError);
  await assert.rejects(() => initializeAppServer(client, { clientInfo: {} }), TypeError);
  await assert.rejects(
    () => initializeAppServer(client, { clientInfo: { name: 'x' } }),
    TypeError,
  );
});

test('a handshake that carries no version says so instead of guessing', async () => {
  const { fake, client } = harness();
  const pending = initializeAppServer(client, { clientInfo: { name: 'x', version: '1.0.0' } });
  fake.receive({ jsonrpc: JSONRPC_VERSION, id: fake.last.id, result: { codexHome: '/home/x/.codex' } });
  const handshake = await pending;
  assert.equal(handshake.appServerVersion, null, 'null is a decision the caller has to make');
  assert.deepEqual(handshake.result, { codexHome: '/home/x/.codex' });
});
