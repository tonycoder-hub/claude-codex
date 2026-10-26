import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialState,
  reduce,
  reduceAll,
  transcript,
  reasoningText,
  isTurnActive,
  isWaitingOnUser,
  decisionResult,
  userInputResult,
  DECISIONS,
  LOCAL_APPROVAL_RESOLVED,
} from '../../web/stream.mjs';

const THREAD = 'th_01J8Z';
const TURN = 't_01J8Z';

function turnObject(overrides = {}) {
  return {
    id: TURN,
    items: [],
    itemsView: 'notLoaded',
    status: 'inProgress',
    error: null,
    startedAt: 1_730_000_000,
    completedAt: null,
    durationMs: null,
    ...overrides,
  };
}

/**
 * A recorded turn, in the order the app-server actually emits it: a reasoning
 * stream, then a command execution and an agent message whose deltas interleave,
 * with an approval request landing in the middle of the stream.
 *
 * Field names and nesting here are copied from the server implementation, not
 * invented -- `item/started` nests a full `item`, the delta notifications carry
 * a flat `itemId`, and the two reasoning deltas duplicate each other.
 */
const RECORDED = [
  { method: 'turn/started', params: { threadId: THREAD, turn: turnObject() } },

  {
    method: 'item/started',
    params: {
      threadId: THREAD,
      turnId: TURN,
      item: { type: 'reasoning', id: 'i_reason', summary: [''], content: [''] },
      startedAtMs: 1_730_000_000_100,
    },
  },
  // The server sends summaryTextDelta and textDelta for the same delta. Both
  // are recorded here because both really arrive.
  { method: 'item/reasoning/summaryTextDelta', params: { threadId: THREAD, turnId: TURN, itemId: 'i_reason', delta: 'Checking ', summaryIndex: 0 } },
  { method: 'item/reasoning/textDelta', params: { threadId: THREAD, turnId: TURN, itemId: 'i_reason', delta: 'Checking ', contentIndex: 0 } },
  { method: 'item/reasoning/summaryTextDelta', params: { threadId: THREAD, turnId: TURN, itemId: 'i_reason', delta: 'the config.', summaryIndex: 0 } },
  { method: 'item/reasoning/textDelta', params: { threadId: THREAD, turnId: TURN, itemId: 'i_reason', delta: 'the config.', contentIndex: 0 } },
  {
    method: 'item/completed',
    params: {
      threadId: THREAD,
      turnId: TURN,
      item: { type: 'reasoning', id: 'i_reason', summary: ['Checking the config.'], content: ['Checking the config.'] },
      completedAtMs: 1_730_000_000_900,
    },
  },

  {
    method: 'item/started',
    params: {
      threadId: THREAD,
      turnId: TURN,
      item: {
        type: 'commandExecution',
        id: 'i_cmd',
        command: 'cat package.json',
        cwd: '/work/codex-relay-web',
        processId: 'claude:tu_1',
        source: 'agent',
        status: 'inProgress',
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
      startedAtMs: 1_730_000_001_000,
    },
  },
  {
    method: 'item/started',
    params: {
      threadId: THREAD,
      turnId: TURN,
      item: { type: 'agentMessage', id: 'i_msg', text: '', phase: null, memoryCitation: null },
      startedAtMs: 1_730_000_001_010,
    },
  },

  // Interleaved: two items streaming at once, which is the normal case.
  { method: 'item/commandExecution/outputDelta', params: { threadId: THREAD, turnId: TURN, itemId: 'i_cmd', delta: '{\n  "name":' } },
  { method: 'item/agentMessage/delta', params: { threadId: THREAD, turnId: TURN, itemId: 'i_msg', delta: 'Let me ' } },
  { method: 'item/commandExecution/outputDelta', params: { threadId: THREAD, turnId: TURN, itemId: 'i_cmd', delta: ' "codex-relay-web"\n}' } },
  { method: 'item/agentMessage/delta', params: { threadId: THREAD, turnId: TURN, itemId: 'i_msg', delta: 'read that.' } },

  // An approval lands mid-turn. The turn is blocked until it is answered.
  {
    method: 'item/commandExecution/requestApproval',
    requestId: 7,
    params: {
      threadId: THREAD,
      turnId: TURN,
      itemId: 'i_cmd2',
      startedAtMs: 1_730_000_002_000,
      approvalId: 'req_7',
      reason: null,
      command: 'rm -rf build',
      cwd: '/work/codex-relay-web',
      commandActions: [],
      additionalPermissions: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    },
  },

  {
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: THREAD,
      turnId: TURN,
      tokenUsage: {
        total: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 95, reasoningOutputTokens: 0, totalTokens: 2095 },
        last: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 95, reasoningOutputTokens: 0, totalTokens: 2095 },
        modelContextWindow: null,
      },
    },
  },
];

test('a recorded turn folds into the transcript the view expects', () => {
  const state = reduceAll(initialState(), RECORDED);

  assert.deepEqual(state.order, ['i_reason', 'i_cmd', 'i_msg'], 'arrival order is render order');
  assert.equal(state.activeTurnId, TURN);
  assert.equal(isTurnActive(state), true);
  assert.equal(state.turn.status, 'inProgress');
  assert.equal(state.droppedDeltas, 0);

  // Interleaved deltas landed on the right items and nowhere else.
  assert.equal(state.items.i_msg.text, 'Let me read that.');
  assert.equal(state.items.i_cmd.output, '{\n  "name": "codex-relay-web"\n}');
  assert.equal(state.items.i_msg.output, '', 'a message has no command output');
  assert.equal(state.items.i_cmd.text, '', 'a command has no message text');

  // Types are carried through so the view can distinguish them visually.
  assert.deepEqual(
    transcript(state).map((i) => i.type),
    ['reasoning', 'commandExecution', 'agentMessage'],
  );
  assert.equal(state.items.i_cmd.wire.command, 'cat package.json', 'per-type fields stay reachable');
  assert.equal(state.items.i_cmd.wire.cwd, '/work/codex-relay-web');

  assert.equal(state.tokenUsage.total.totalTokens, 2095);
});

test('the duplicated reasoning stream is not double-printed', () => {
  // The server emits summaryTextDelta and textDelta for the same delta. If the
  // reducer concatenated both into one buffer the text would appear twice.
  const state = reduceAll(initialState(), RECORDED);
  const item = state.items.i_reason;

  assert.deepEqual(item.reasoning.summary, ['Checking the config.']);
  assert.deepEqual(item.reasoning.content, ['Checking the config.']);
  assert.equal(reasoningText(item), 'Checking the config.', 'rendered once, not twice');
  assert.equal(item.closed, true);
  assert.equal(item.closedBy, 'item');
});

test('reasoning falls back to content when no summary was streamed', () => {
  const state = reduceAll(initialState(), [
    { method: 'turn/started', params: { threadId: THREAD, turn: turnObject() } },
    { method: 'item/started', params: { threadId: THREAD, turnId: TURN, item: { type: 'reasoning', id: 'r', summary: [''], content: [''] } } },
    { method: 'item/reasoning/textDelta', params: { threadId: THREAD, turnId: TURN, itemId: 'r', delta: 'only content', contentIndex: 0 } },
  ]);
  assert.equal(reasoningText(state.items.r), 'only content');
});

test('deltas at distinct indices become separate reasoning blocks', () => {
  const state = reduceAll(initialState(), [
    { method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r', delta: 'first', summaryIndex: 0 } },
    { method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r', delta: 'second', summaryIndex: 1 } },
    { method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r', delta: '!', summaryIndex: 1 } },
  ]);
  assert.deepEqual(state.items.r.reasoning.summary, ['first', 'second!']);
  assert.equal(reasoningText(state.items.r), 'first\n\nsecond!');
});

test('an approval request is visible, carries its itemId, and survives until answered', () => {
  const state = reduceAll(initialState(), RECORDED);

  assert.equal(state.approvals.length, 1, 'an unanswered approval must not be buried');
  const approval = state.approvals[0];
  assert.equal(approval.requestId, 7);
  assert.equal(approval.kind, 'command');
  assert.equal(approval.command, 'rm -rf build');
  assert.equal(approval.cwd, '/work/codex-relay-web');
  assert.equal(approval.turnId, TURN);
  // The fileChange variant has no diff in its params, so the view can only show
  // one by looking up this itemId. It must therefore be preserved.
  assert.equal(approval.itemId, 'i_cmd2');
  assert.deepEqual(approval.decisions, ['accept', 'acceptForSession', 'decline', 'cancel']);

  // Answering it removes it, and only it.
  const answered = reduce(state, { method: LOCAL_APPROVAL_RESOLVED, requestId: 7 });
  assert.deepEqual(answered.approvals, []);
  // A stale resolve is a no-op, by identity.
  assert.equal(reduce(answered, { method: LOCAL_APPROVAL_RESOLVED, requestId: 7 }), answered);
});

test('the decision set is closed, because the server coerces anything else to decline', () => {
  // This is the failure mode worth a loud test: normalizeDecision() on the
  // server recognises exactly these four strings and silently turns everything
  // else into 'decline'. A placeholder like 'approved' would therefore produce
  // a UI that reads as "allowed" while the tool call was refused.
  assert.deepEqual(DECISIONS, ['accept', 'acceptForSession', 'decline', 'cancel']);
  for (const decision of DECISIONS) {
    assert.deepEqual(decisionResult(decision), { decision });
  }
  for (const wrong of ['approved', 'approve', 'allow', 'deny', 'reject', 'Accept', 'ACCEPT', '', null, undefined, 1, {}]) {
    assert.throws(
      () => decisionResult(wrong),
      RangeError,
      `${JSON.stringify(wrong)} must be rejected rather than silently declined`,
    );
  }
  assert.throws(() => decisionResult('approved'), /silently coerced to decline/);
});

test('every decision a command approval offers is one the result builder accepts', () => {
  // Guards the path the buttons actually take: the reducer filters
  // availableDecisions, and every survivor must be usable.
  const state = reduceAll(initialState(), RECORDED);
  for (const decision of state.approvals[0].decisions) {
    assert.deepEqual(decisionResult(decision), { decision });
  }
});

test('serverRequest/resolved clears a card the server resolved on its own', () => {
  // Auto-approved by policy, or answered on another client. Correlation is on
  // approvalId, which is the server's own request id.
  const state = reduceAll(initialState(), RECORDED);
  assert.equal(state.approvals[0].approvalId, 'req_7');

  const cleared = reduce(state, {
    method: 'serverRequest/resolved',
    params: { threadId: THREAD, requestId: 'req_7' },
  });
  assert.deepEqual(cleared.approvals, []);

  // A different request id must not clear someone else's card.
  const untouched = reduce(state, {
    method: 'serverRequest/resolved',
    params: { threadId: THREAD, requestId: 'req_other' },
  });
  assert.equal(untouched, state);
  assert.equal(reduce(state, { method: 'serverRequest/resolved', params: {} }), state);
});

test('waiting-on-user follows the server activeFlags, with the card list as fallback', () => {
  const idle = initialState();
  assert.equal(isWaitingOnUser(idle), false);

  // Before any status notification arrives, a pending card is the only signal.
  const withCard = reduceAll(initialState(), RECORDED);
  assert.equal(isWaitingOnUser(withCard), true);

  // The server saying so is authoritative, even with no card of our own.
  const flagged = reduce(initialState(), {
    method: 'thread/status/changed',
    params: { threadId: THREAD, status: { type: 'active', activeFlags: ['waitingOnApproval'] } },
  });
  assert.equal(isWaitingOnUser(flagged), true);
  assert.equal(flagged.threadStatus.type, 'active');

  const unflagged = reduce(flagged, {
    method: 'thread/status/changed',
    params: { threadId: THREAD, status: { type: 'active', activeFlags: [] } },
  });
  assert.equal(isWaitingOnUser(unflagged), false);

  assert.equal(
    isWaitingOnUser(reduce(initialState(), {
      method: 'thread/status/changed',
      params: { status: { type: 'active', activeFlags: ['waitingOnUserInput'] } },
    })),
    true,
  );

  const quiet = reduce(initialState(), { method: 'thread/status/changed', params: { status: { type: 'idle' } } });
  assert.equal(isWaitingOnUser(quiet), false);
});

test('user input answers are keyed by question id, which is how the server reads them', () => {
  const questions = [
    { id: 'q0', header: 'Env', question: 'Which environment?', options: [{ label: 'staging' }, { label: 'Other' }] },
    { id: 'q1', header: 'Confirm', question: 'Proceed?', options: [{ label: 'yes' }, { label: 'Other' }] },
  ];

  const result = userInputResult(questions, {
    q0: { choice: 'staging' },
    q1: { choice: 'Other', note: 'only after the backup finishes' },
  });

  assert.deepEqual(result, {
    answers: {
      q0: { answers: ['staging'] },
      q1: { answers: ['Other'], notes: 'only after the backup finishes' },
    },
  });

  // The server does `slot[q.id]`. Replicating that lookup here is what proves
  // the shape: an array would make every one of these undefined.
  const slot = result.answers;
  for (const question of questions) {
    assert.ok(slot[question.id], `${question.id} must be reachable by id`);
  }
  assert.equal(Array.isArray(result.answers), false, 'the outer answers is a map, not an array');
});

test('an unanswered question still gets a key, and blank notes are omitted', () => {
  const questions = [{ id: 'q0', question: 'a?' }, { id: 'q1', question: 'b?' }];
  const result = userInputResult(questions, { q0: { choice: '', note: '   ' } });
  assert.deepEqual(result, { answers: { q0: { answers: [] }, q1: { answers: [] } } });

  // Free text alone, with no option picked, is a valid answer -- the server
  // falls back to notes when the picked set is empty.
  assert.deepEqual(
    userInputResult(questions, { q0: { note: 'something else entirely' } }).answers.q0,
    { answers: [], notes: 'something else entirely' },
  );
  assert.deepEqual(userInputResult([], {}), { answers: {} });
  assert.deepEqual(userInputResult(undefined), { answers: {} });

  // A question with no id is answered under the key the server's own lookup
  // produces for it -- `slot[q.id]` with an undefined id reads the property
  // 'undefined'. Skipping the question instead would lose the answer in
  // silence. See the note on userInputResult, and shim.test.mjs, which checks
  // this against the sibling suite's fixture (which indeed has no id).
  assert.deepEqual(
    userInputResult([{ question: 'no id' }], { undefined: { choice: 'yes' } }),
    { answers: { undefined: { answers: ['yes'] } } },
  );
});

test('a duplicate approval request for the same id is not shown twice', () => {
  const request = RECORDED.find((n) => n.method === 'item/commandExecution/requestApproval');
  const once = reduce(initialState(), request);
  const twice = reduce(once, request);
  assert.equal(twice, once, 'identical state object, not merely equal');
  assert.equal(twice.approvals.length, 1);
});

test('a fileChange approval defaults to all four decisions and keeps grantRoot', () => {
  // These params genuinely lack availableDecisions; the server accepts all four
  // regardless, so defaulting to an empty button row would deadlock the turn.
  const state = reduce(initialState(), {
    method: 'item/fileChange/requestApproval',
    requestId: 'r1',
    params: { threadId: THREAD, turnId: TURN, itemId: 'i_fc', startedAtMs: 1, reason: null, grantRoot: null },
  });
  const approval = state.approvals[0];
  assert.equal(approval.kind, 'fileChange');
  assert.deepEqual(approval.decisions, DECISIONS);
  assert.equal(approval.grantRoot, null);
  assert.equal(approval.itemId, 'i_fc');
});

test('a user-input request keeps its questions and offers no decision buttons', () => {
  const state = reduce(initialState(), {
    method: 'item/tool/requestUserInput',
    requestId: 'r2',
    params: {
      threadId: THREAD,
      turnId: TURN,
      itemId: 'i_q',
      questions: [
        {
          id: 'q0',
          header: 'Deploy?',
          question: 'Which environment should I deploy to?',
          isOther: false,
          isSecret: false,
          options: [
            { label: 'staging', description: 'safe' },
            { label: 'Other', description: 'Provide a free-form answer' },
          ],
        },
      ],
    },
  });
  const approval = state.approvals[0];
  assert.equal(approval.kind, 'userInput');
  assert.equal(approval.questions.length, 1);
  assert.equal(approval.questions[0].id, 'q0', 'answers are keyed by this id');
  assert.deepEqual(approval.decisions, []);
});

test('turn/completed closes items still open and retires dead approvals', () => {
  // The command item never got an item/completed -- this is the case that
  // otherwise leaves a spinner on screen for ever.
  const open = reduceAll(initialState(), RECORDED);
  assert.equal(open.items.i_cmd.closed, false);
  assert.equal(open.items.i_msg.closed, false);

  const done = reduce(open, {
    method: 'turn/completed',
    params: {
      threadId: THREAD,
      turn: turnObject({ status: 'completed', completedAt: 1_730_000_003, durationMs: 3000 }),
    },
  });

  assert.equal(done.items.i_cmd.closed, true);
  assert.equal(done.items.i_cmd.closedBy, 'turn');
  assert.equal(done.items.i_cmd.status, 'completed');
  assert.equal(done.items.i_msg.closed, true);
  // Already closed by its own item/completed; must not be re-stamped.
  assert.equal(done.items.i_reason.closedBy, 'item');

  assert.equal(done.activeTurnId, null);
  assert.equal(isTurnActive(done), false);
  assert.equal(done.turn.status, 'completed');
  assert.deepEqual(done.approvals, [], 'an approval for an ended turn cannot be answered');

  // Text accumulated before the close is still there.
  assert.equal(done.items.i_msg.text, 'Let me read that.');
});

test('an interrupted turn stamps its status onto the items it closes', () => {
  const open = reduceAll(initialState(), RECORDED);
  const stopped = reduce(open, {
    method: 'turn/completed',
    params: { threadId: THREAD, turn: turnObject({ status: 'interrupted', error: { message: 'interrupted' } }) },
  });
  assert.equal(stopped.turn.status, 'interrupted');
  assert.equal(stopped.items.i_cmd.status, 'interrupted');
  assert.equal(stopped.items.i_msg.status, 'interrupted');
});

test('a delta that arrives before its item/started is kept, not dropped', () => {
  // Out of order. Discarding this would silently lose model output.
  let state = reduce(initialState(), {
    method: 'item/agentMessage/delta',
    params: { threadId: THREAD, turnId: TURN, itemId: 'i_late', delta: 'early bird' },
  });
  assert.equal(state.items.i_late.text, 'early bird');
  assert.equal(state.items.i_late.type, 'agentMessage', 'type inferred from the delta method');
  assert.deepEqual(state.order, ['i_late']);

  // The late item/started must fill in the real fields without wiping text.
  state = reduce(state, {
    method: 'item/started',
    params: {
      threadId: THREAD,
      turnId: TURN,
      item: { type: 'agentMessage', id: 'i_late', text: '', phase: null, memoryCitation: null },
      startedAtMs: 5,
    },
  });
  assert.equal(state.items.i_late.text, 'early bird', 'an empty wire text must not clobber streamed text');
  assert.equal(state.items.i_late.startedAtMs, 5);
  assert.deepEqual(state.order, ['i_late'], 'and no duplicate row appears');
});

test('a repeated item/started does not reset accumulated text', () => {
  const started = {
    method: 'item/started',
    params: { threadId: THREAD, turnId: TURN, item: { type: 'agentMessage', id: 'm', text: '', phase: null, memoryCitation: null } },
  };
  let state = reduce(initialState(), started);
  state = reduce(state, { method: 'item/agentMessage/delta', params: { itemId: 'm', delta: 'hello' } });
  state = reduce(state, started);
  assert.equal(state.items.m.text, 'hello');
  assert.deepEqual(state.order, ['m']);
});

test('a delta after item/completed is dropped and counted, not appended', () => {
  let state = reduceAll(initialState(), [
    { method: 'item/started', params: { threadId: THREAD, turnId: TURN, item: { type: 'agentMessage', id: 'm', text: '' } } },
    { method: 'item/agentMessage/delta', params: { itemId: 'm', delta: 'final answer' } },
    {
      method: 'item/completed',
      params: { threadId: THREAD, turnId: TURN, item: { type: 'agentMessage', id: 'm', text: 'final answer' }, completedAtMs: 9 },
    },
  ]);
  assert.equal(state.items.m.text, 'final answer');
  assert.equal(state.items.m.completedAtMs, 9);

  const before = state.items.m;
  state = reduce(state, { method: 'item/agentMessage/delta', params: { itemId: 'm', delta: ' AND MORE' } });
  assert.equal(state.items.m.text, 'final answer', 'the completed text is authoritative');
  assert.equal(state.items.m, before, 'the item object itself is untouched');
  assert.equal(state.droppedDeltas, 1, 'but the anomaly is counted, not hidden');
});

test('a duplicate item/completed is idempotent in content', () => {
  // The server really does re-emit item/completed for the same id to express an
  // update to an in-flight item, since there is no item/updated notification.
  const completed = {
    method: 'item/completed',
    params: {
      threadId: THREAD,
      turnId: TURN,
      item: { type: 'mcpToolCall', id: 'x', server: 'claude-code', tool: 'Read', status: 'completed', arguments: {}, result: { content: [] }, error: null, durationMs: 12 },
      completedAtMs: 100,
    },
  };
  const once = reduce(initialState(), completed);
  const twice = reduce(once, completed);
  assert.equal(twice.items.x.text, once.items.x.text);
  assert.equal(twice.items.x.status, 'completed');
  assert.deepEqual(twice.order, ['x'], 'no second row');
  assert.equal(twice.items.x.wire.tool, 'Read');
});

test('item/completed carrying an empty text keeps what was streamed', () => {
  const state = reduceAll(initialState(), [
    { method: 'item/agentMessage/delta', params: { itemId: 'm', delta: 'streamed only' } },
    { method: 'item/completed', params: { turnId: TURN, item: { type: 'agentMessage', id: 'm', text: '' } } },
  ]);
  assert.equal(state.items.m.text, 'streamed only', 'losing the text would be the worse failure');
});

test('file change patches accumulate on the item the approval points at', () => {
  const changes = [
    { path: '/work/a.mjs', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b\n' },
    { path: '/work/new.mjs', kind: { type: 'add' }, diff: '@@ -0,0 +1 @@\n+hi\n' },
  ];
  let state = reduce(initialState(), {
    method: 'item/started',
    params: { threadId: THREAD, turnId: TURN, item: { type: 'fileChange', id: 'fc', changes: [], status: 'inProgress' } },
  });
  state = reduce(state, {
    method: 'item/fileChange/patchUpdated',
    params: { threadId: THREAD, turnId: TURN, itemId: 'fc', changes },
  });
  assert.deepEqual(state.items.fc.changes, changes);
  assert.equal(state.items.fc.type, 'fileChange');

  // A later patch replaces rather than appends; the server sends the whole set.
  state = reduce(state, {
    method: 'item/fileChange/patchUpdated',
    params: { threadId: THREAD, turnId: TURN, itemId: 'fc', changes: [changes[0]] },
  });
  assert.equal(state.items.fc.changes.length, 1);
});

test('structural sharing means the view can re-render exactly one item', () => {
  const before = reduceAll(initialState(), RECORDED);
  const after = reduce(before, { method: 'item/agentMessage/delta', params: { itemId: 'i_msg', delta: '!' } });

  assert.notEqual(after, before, 'state is replaced');
  assert.notEqual(after.items.i_msg, before.items.i_msg, 'the changed item is a new object');
  // This is the property app.mjs relies on to avoid re-rendering the transcript.
  assert.equal(after.items.i_cmd, before.items.i_cmd, 'untouched items keep identity');
  assert.equal(after.items.i_reason, before.items.i_reason);
  assert.equal(after.order, before.order, 'order array is reused when no item is added');
  assert.equal(after.items.i_msg.revision, before.items.i_msg.revision + 1);
});

test('notifications that change nothing return the identical state object', () => {
  const state = reduceAll(initialState(), RECORDED);
  for (const noop of [
    { method: 'turn/plan/updated', params: {} },
    { method: 'item/started', params: {} },
    { method: 'item/completed', params: { item: { type: 'agentMessage' } } },
    { method: 'item/agentMessage/delta', params: { itemId: 'i_msg', delta: '' } },
    { method: 'item/agentMessage/delta', params: { delta: 'no item id' } },
    { method: 'item/fileChange/patchUpdated', params: { itemId: 'x' } },
    { method: 'thread/tokenUsage/updated', params: {} },
    { method: 'error', params: {} },
    { method: 'turn/started', params: { turn: {} } },
    { method: 'turn/completed', params: {} },
    { method: 'fuzzyFileSearch/sessionUpdated', params: { whatever: 1 } },
    { method: 'item/commandExecution/requestApproval', params: {} },
    {},
    null,
  ]) {
    assert.equal(reduce(state, noop), state, `${JSON.stringify(noop)} must be a no-op`);
  }
});

test('a delta for a different thread is ignored', () => {
  // The relay gates on one session, but a resumed thread id mismatch should not
  // smear another conversation into this transcript.
  const state = reduce(initialState(), { method: 'thread/started', params: { thread: { id: THREAD } } });
  assert.equal(state.threadId, THREAD);
  const after = reduce(state, {
    method: 'item/agentMessage/delta',
    params: { threadId: 'th_other', turnId: TURN, itemId: 'nope', delta: 'leak' },
  });
  assert.equal(after, state);
  assert.equal(after.items.nope, undefined);
});

test('errors are recorded with their retry flag and bounded', () => {
  let state = reduce(initialState(), {
    method: 'error',
    params: { threadId: THREAD, turnId: TURN, willRetry: false, error: { message: 'model overloaded' } },
  });
  assert.deepEqual(state.errors, [{ message: 'model overloaded', turnId: TURN, willRetry: false }]);

  for (let i = 0; i < 40; i += 1) {
    state = reduce(state, { method: 'error', params: { turnId: TURN, willRetry: true, error: { message: `e${i}` } } });
  }
  assert.equal(state.errors.length, 20, 'the list cannot grow without bound');
  assert.equal(state.errors.at(-1).message, 'e39');
  assert.equal(state.errors.at(-1).willRetry, true);
});

test('a failed turn arrives as error + turn/completed, since there is no turn/failed', () => {
  const state = reduceAll(initialState(), [
    { method: 'turn/started', params: { threadId: THREAD, turn: turnObject() } },
    { method: 'item/started', params: { threadId: THREAD, turnId: TURN, item: { type: 'agentMessage', id: 'm', text: '' } } },
    { method: 'error', params: { threadId: THREAD, turnId: TURN, willRetry: false, error: { message: 'boom' } } },
    { method: 'turn/completed', params: { threadId: THREAD, turn: turnObject({ status: 'failed', error: { message: 'boom' } }) } },
  ]);
  assert.equal(state.turn.status, 'failed');
  assert.deepEqual(state.turn.error, { message: 'boom' });
  assert.equal(state.errors.at(-1).message, 'boom');
  assert.equal(state.items.m.closed, true, 'the open item is closed by the failure');
  assert.equal(state.items.m.status, 'failed');
  assert.equal(isTurnActive(state), false);
});

test('todo lists arrive as turn/plan/updated, not as an item', () => {
  const plan = [
    { step: 'read the config', status: 'completed' },
    { step: 'write the reducer', status: 'inProgress' },
    { step: 'run the tests', status: 'pending' },
  ];
  const state = reduce(initialState(), { method: 'turn/plan/updated', params: { threadId: THREAD, turnId: TURN, explanation: null, plan } });
  assert.deepEqual(state.plan, plan);
  assert.deepEqual(state.order, [], 'a plan is not a transcript row');
});

test('an unknown item type still renders as a row rather than vanishing', () => {
  // The server has fifteen item types and this UI models four. The rest must
  // still appear, because a silent gap in a transcript is a lie about it.
  const state = reduce(initialState(), {
    method: 'item/started',
    params: {
      threadId: THREAD,
      turnId: TURN,
      item: { type: 'webSearch', id: 'ws', query: 'passkey rpId', action: { type: 'search', query: 'passkey rpId', queries: null } },
    },
  });
  assert.deepEqual(state.order, ['ws']);
  assert.equal(state.items.ws.type, 'webSearch');
  assert.equal(state.items.ws.wire.query, 'passkey rpId');
});

test('the initial state is inert and a fresh one each time', () => {
  const a = initialState();
  const b = initialState();
  assert.deepEqual(a, b);
  assert.notEqual(a.items, b.items, 'no shared mutable structure between sessions');
  assert.deepEqual(transcript(a), []);
  assert.equal(isTurnActive(a), false);
});
