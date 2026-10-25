import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnProjection, TURN_STATUS, APPROVAL_KINDS, BUTTON_ANSWERABLE } from '../../src/imrelay/projection.mjs';
import { APPROVAL_DECISIONS } from '../../src/appserver/client.mjs';
import { turnStream, feed } from './fakes.mjs';
import {
  commandApprovalParams, fileChangeApprovalParams, userInputParams,
} from '../appserver/fakes.mjs';

function fresh(init = {}) {
  return new TurnProjection({ chatKey: 'oc_test', ...init });
}

test('a whole turn folds into accumulated text and a terminal status', () => {
  const projection = fresh();
  const changed = feed(projection, turnStream({ chunks: ['Hello', ', ', 'world'] }));

  assert.deepEqual(changed, [true, true, true, true, true, true, true]);
  const snapshot = projection.snapshot();
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].text, 'Hello, world');
  assert.equal(snapshot.items[0].deltaCount, 3);
  assert.equal(snapshot.items[0].status, 'completed');
  assert.equal(snapshot.status, TURN_STATUS.completed);
  assert.equal(snapshot.turnId, 'tu_1');
  assert.equal(projection.terminal, true);
  assert.equal(snapshot.revision, 7);
  assert.deepEqual(snapshot.anomalies, []);
});

test('the revision is monotonic and only moves on a visible change', () => {
  const projection = fresh();
  feed(projection, turnStream({ chunks: ['a'] }));
  const settled = projection.revision;

  // An empty delta changes nothing on screen.
  assert.equal(projection.apply('item/agentMessage/delta', { itemId: 'it_1', delta: '' }), false);
  // A method this projection has no opinion about.
  assert.equal(projection.apply('thread/status/changed', { threadId: 'th_1' }), false);
  assert.equal(projection.apply('session/whatever', {}), false);
  assert.equal(projection.revision, settled);
});

test('token usage is recorded but deliberately does not ask for a flush', () => {
  const projection = fresh();
  feed(projection, turnStream({ chunks: ['a'] }));
  const before = projection.revision;

  assert.equal(projection.apply('thread/tokenUsage/updated', { inputTokens: 10, outputTokens: 5 }), false);
  assert.equal(projection.revision, before, 'a token count must not spend a card update');
  assert.deepEqual(projection.snapshot().usage, {
    inputTokens: 10, outputTokens: 5, totalTokens: 15,
  });
});

test('a delta for an unknown item keeps the output and records why', () => {
  const projection = fresh();
  assert.equal(projection.apply('item/agentMessage/delta', { itemId: 'it_x', delta: 'kept' }), true);

  const snapshot = projection.snapshot();
  assert.equal(snapshot.items[0].text, 'kept');
  assert.equal(snapshot.items[0].kind, 'agentMessage', 'the kind is recovered from the method name');
  assert.equal(snapshot.items[0].orphan, true);
  assert.equal(snapshot.anomalies.length, 1);
  assert.match(snapshot.anomalies[0], /before item\/started/);
});

test('notifications naming another thread are rejected, not interleaved', () => {
  const projection = fresh({ threadId: 'th_mine' });
  assert.equal(projection.apply('item/started', { threadId: 'th_other', item: { id: 'it_1' } }), false);
  assert.equal(projection.snapshot().items.length, 0);
  assert.match(projection.snapshot().anomalies[0], /another thread/);

  // A payload with no thread at all is accepted: deltas carry no thread id.
  assert.equal(projection.apply('item/agentMessage/delta', { itemId: 'it_1', delta: 'x' }), true);
});

test('a turn ending marks items that were still running', () => {
  const projection = fresh();
  projection.apply('turn/started', { turn: { id: 'tu_1', status: 'inProgress' } });
  projection.apply('item/started', { item: { id: 'it_1', itemType: 'commandExecution' } });
  projection.apply('item/started', { item: { id: 'it_2', itemType: 'agentMessage' } });
  assert.equal(projection.snapshot().items.every((item) => item.status === 'running'), true);

  projection.apply('turn/completed', { turn: { id: 'tu_1', status: 'completed' } });
  assert.equal(projection.snapshot().items.every((item) => item.status === 'completed'), true);
});

test('a turn/completed for a different turn does not conclude this card', () => {
  const projection = fresh();
  projection.apply('turn/started', { turn: { id: 'tu_1', status: 'inProgress' } });
  assert.equal(projection.apply('turn/completed', { turn: { id: 'tu_2', status: 'completed' } }), false);
  assert.equal(projection.status, TURN_STATUS.running);
  assert.match(projection.snapshot().anomalies[0], /for turn tu_2/);
});

test('an unrecognised turn status is kept verbatim rather than coerced', () => {
  const projection = fresh();
  projection.apply('turn/started', { turn: { id: 'tu_1', status: 'wobbling' } });
  const snapshot = projection.snapshot();
  assert.equal(snapshot.rawStatus, 'wobbling');
  assert.notEqual(snapshot.status, TURN_STATUS.completed);
  assert.match(snapshot.anomalies[0], /unrecognised turn status/);
});

test('authoritative text on item/completed replaces the accumulation', () => {
  const projection = fresh();
  projection.apply('item/started', { item: { id: 'it_1', itemType: 'agentMessage' } });
  projection.apply('item/agentMessage/delta', { itemId: 'it_1', delta: 'par' });
  projection.apply('item/agentMessage/delta', { itemId: 'it_1', delta: 'tial' });
  projection.apply('item/completed', { item: { id: 'it_1', itemType: 'agentMessage', text: 'final' } });
  assert.equal(projection.snapshot().items[0].text, 'final', 'must not be "partialfinal"');
});

test('conclude forces a terminal state the app-server will never send', () => {
  const projection = fresh();
  projection.apply('turn/started', { turn: { id: 'tu_1', status: 'inProgress' } });
  assert.equal(projection.conclude('interrupted', { at: 99 }), true);
  assert.equal(projection.status, TURN_STATUS.interrupted);
  assert.equal(projection.terminal, true);
  assert.equal(projection.snapshot().endedAt, 99);

  assert.equal(projection.conclude('interrupted'), false, 'idempotent');
  assert.equal(projection.conclude('nonsense'), false);
  assert.match(projection.snapshot().anomalies.at(-1), /not a turn status/);
});

test('conclude carries an error through to the snapshot', () => {
  const projection = fresh();
  projection.conclude('failed', { error: new Error('end vanished') });
  assert.match(projection.snapshot().error, /end vanished/);
});

// -- approvals ---------------------------------------------------------------

test('a command approval is summarised from the real params and is button-answerable', () => {
  const projection = fresh();
  const method = 'item/commandExecution/requestApproval';
  assert.equal(APPROVAL_KINDS[method], 'commandExecution');

  assert.equal(projection.openApproval({
    requestId: 'b2f0a0c6-0000-4000-8000-000000000001', method, params: commandApprovalParams(),
  }), true);

  const [approval] = projection.pendingApprovals();
  assert.equal(approval.kind, 'commandExecution');
  assert.equal(approval.byButton, true);
  assert.match(approval.summary, /npm test/);
  assert.match(approval.summary, /\/work/);
  // Narrowed against the known-legal vocabulary, never widened.
  assert.ok(approval.decisions.every((entry) => APPROVAL_DECISIONS.includes(entry)));
});

test('a file-change approval admits it has no path instead of inventing one', () => {
  const projection = fresh();
  projection.openApproval({
    requestId: 'r_fc', method: 'item/fileChange/requestApproval', params: fileChangeApprovalParams(),
  });
  const [approval] = projection.pendingApprovals();
  assert.equal(approval.kind, 'fileChange');
  assert.match(approval.summary, /names no path/);
  assert.equal(approval.itemId, 'it_2');
});

test('a user-input request is not button-answerable', () => {
  const projection = fresh();
  projection.openApproval({
    requestId: 'r_ui', method: 'item/tool/requestUserInput', params: userInputParams(),
  });
  const [approval] = projection.pendingApprovals();
  assert.equal(approval.kind, 'userInput');
  assert.equal(approval.byButton, false);
  assert.equal(BUTTON_ANSWERABLE.includes('userInput'), false);
  assert.equal(typeof approval.summary, 'string');
  assert.notEqual(approval.summary, '');
});

test('availableDecisions outside the legal set is narrowed away', () => {
  const projection = fresh();
  projection.openApproval({
    requestId: 'r_odd',
    method: 'item/commandExecution/requestApproval',
    params: { command: 'ls', availableDecisions: ['accept', 'approve', 'yolo'] },
  });
  assert.deepEqual(projection.pendingApprovals()[0].decisions, ['accept']);
});

test('availableDecisions that is entirely illegal falls back to null, not to an empty set', () => {
  const projection = fresh();
  projection.openApproval({
    requestId: 'r_bad',
    method: 'item/commandExecution/requestApproval',
    params: { command: 'ls', availableDecisions: ['approve'] },
  });
  assert.equal(projection.pendingApprovals()[0].decisions, null);
});

test('a re-delivered approval is not a second ask, and closing it clears the buttons', () => {
  const projection = fresh();
  const open = () => projection.openApproval({
    requestId: 'r1', method: 'item/commandExecution/requestApproval', params: commandApprovalParams(),
  });
  assert.equal(open(), true);
  assert.equal(open(), false, 'a retry must not re-ask');
  assert.equal(projection.pendingApprovals().length, 1);

  assert.equal(projection.closeApproval('r1', 'accept'), true);
  assert.equal(projection.pendingApprovals().length, 0);
  assert.equal(projection.closeApproval('r1'), false);
});

test('a malformed approval is recorded rather than thrown', () => {
  const projection = fresh();
  assert.equal(projection.openApproval({ requestId: '', method: 'item/commandExecution/requestApproval' }), false);
  assert.equal(projection.openApproval({ requestId: 'r', method: 'item/nope/requestApproval' }), false);
  assert.equal(projection.snapshot().anomalies.length, 2);
});

// -- robustness --------------------------------------------------------------

test('nothing in the notification stream can make apply throw', () => {
  const projection = fresh();
  const junk = [
    [null, null], ['', {}], ['item/started', null], ['item/started', {}],
    ['item/completed', { item: {} }], ['item/agentMessage/delta', { itemId: 'x', delta: 42 }],
    ['item/agentMessage/delta', { delta: 'x' }], ['turn/started', 'not an object'],
    ['item/fileChange/patchUpdated', { itemId: 'x' }],
    ['thread/tokenUsage/updated', { nothing: true }],
  ];
  for (const [method, params] of junk) {
    assert.doesNotThrow(() => projection.apply(method, params), `${method} threw`);
  }
  assert.ok(projection.snapshot().anomalies.length > 0);
});

test('anomalies are capped so a misbehaving peer cannot grow them forever', () => {
  const projection = fresh();
  for (let index = 0; index < 100; index += 1) projection.apply('item/started', {});
  const { anomalies } = projection.snapshot();
  assert.equal(anomalies.length, 33);
  assert.equal(anomalies.at(-1), '...');
});

test('a patch is correlated onto the item it names', () => {
  const projection = fresh();
  projection.apply('item/started', { item: { id: 'it_2', itemType: 'fileChange' } });
  assert.equal(projection.apply('item/fileChange/patchUpdated', { itemId: 'it_2', patch: '--- a\n+++ b' }), true);
  assert.equal(projection.snapshot().items[0].patch, '--- a\n+++ b');
  assert.equal(
    projection.apply('item/fileChange/patchUpdated', { itemId: 'it_2', patch: '--- a\n+++ b' }),
    false,
    'the same patch twice is not a visible change',
  );
});

test('a snapshot cannot be used to reach back into the projection', () => {
  const projection = fresh();
  feed(projection, turnStream({ chunks: ['a'] }));
  const snapshot = projection.snapshot();
  snapshot.items[0].text = 'tampered';
  snapshot.anomalies.push('tampered');
  assert.equal(projection.snapshot().items[0].text, 'a');
  assert.deepEqual(projection.snapshot().anomalies, []);
});

test('the thread id is adopted from turn/started when it was not known up front', () => {
  const projection = fresh();
  assert.equal(projection.threadId, null);
  projection.apply('turn/started', { threadId: 'th_new', turn: { id: 'tu_1', status: 'inProgress' } });
  assert.equal(projection.threadId, 'th_new');
  // And from then on it filters.
  assert.equal(projection.apply('item/started', { threadId: 'th_other', item: { id: 'x' } }), false);
});
