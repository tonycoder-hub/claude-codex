import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderCard, digestShell, clipTail, byteLength, buttonsFor,
  DETAIL, ACTION, STREAM_ELEMENT_ID, APPROVAL_BUTTONS,
} from '../../src/imrelay/cards.mjs';
import { TurnProjection } from '../../src/imrelay/projection.mjs';
import { LARK_LIMITS } from '../../src/imrelay/transport.mjs';
import { APPROVAL_DECISIONS } from '../../src/appserver/client.mjs';
import { turnStream, feed } from './fakes.mjs';
import { commandApprovalParams, userInputParams } from '../appserver/fakes.mjs';

function runningTurn({ chunks = ['hello'] } = {}) {
  const projection = new TurnProjection({ chatKey: 'oc_1', threadId: 'th_abcdef123' });
  projection.apply('turn/started', { threadId: 'th_abcdef123', turn: { id: 'tu_1', status: 'inProgress' } });
  projection.apply('item/started', { item: { id: 'it_1', itemType: 'agentMessage' } });
  for (const chunk of chunks) {
    projection.apply('item/agentMessage/delta', { itemId: 'it_1', delta: chunk });
  }
  return projection;
}

function elementsOf(card) {
  return card?.body?.elements ?? [];
}

function findElement(card, elementId) {
  return elementsOf(card).find((element) => element.element_id === elementId) ?? null;
}

function allButtons(card) {
  const out = [];
  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      if (node?.tag === 'button') out.push(node);
      if (Array.isArray(node?.elements)) walk(node.elements);
      if (Array.isArray(node?.columns)) walk(node.columns);
    }
  };
  walk(elementsOf(card));
  return out;
}

// -- shape -------------------------------------------------------------------

test('a rendered card is schema 2.0 with elements under body', () => {
  const rendered = renderCard(runningTurn().snapshot());
  assert.equal(rendered.card.schema, '2.0');
  assert.ok(Array.isArray(rendered.card.body.elements));
  // 1.0 put elements at the top level; mixing renders nothing.
  assert.equal('elements' in rendered.card, false);
  assert.equal(rendered.card.config.update_multi, true, '2.0 supports nothing else');
});

test('the streaming element is a markdown component with a stable id', () => {
  const rendered = renderCard(runningTurn({ chunks: ['abc'] }).snapshot());
  const element = findElement(rendered.card, STREAM_ELEMENT_ID);
  assert.equal(element.tag, 'markdown', 'the rich-text component tag is the fixed value markdown');
  assert.equal(element.content, 'abc');
  assert.equal(rendered.streamElementId, STREAM_ELEMENT_ID);
  assert.equal(rendered.streamContent, 'abc');
  // turn/started, item/started, one delta.
  assert.equal(rendered.revision, 3);
});

test('streaming mode follows the turn and carries a client-side print strategy', () => {
  const live = renderCard(runningTurn().snapshot());
  assert.equal(live.card.config.streaming_mode, true);
  assert.equal(live.card.config.streaming_config.print_strategy, 'fast');

  const done = new TurnProjection({ chatKey: 'oc_1' });
  feed(done, turnStream({ chunks: ['x'] }));
  const finished = renderCard(done.snapshot());
  assert.equal(finished.card.config.streaming_mode, false);
  assert.equal('streaming_config' in finished.card.config, false);
});

test('a running turn offers an interrupt button and a finished one does not', () => {
  const live = renderCard(runningTurn().snapshot());
  const interrupt = allButtons(live.card).find(
    (button) => button.behaviors?.[0]?.value?.a === ACTION.interrupt,
  );
  assert.ok(interrupt, 'a turn in flight must be stoppable from the phone');
  assert.equal(interrupt.behaviors[0].value.t, 'tu_1');

  const done = new TurnProjection({ chatKey: 'oc_1' });
  feed(done, turnStream({ chunks: ['x'] }));
  assert.equal(allButtons(renderCard(done.snapshot()).card).length, 0);
});

test('interrupt: false drops the button and nothing else', () => {
  // For routes with no card-callback endpoint. A button whose `callback`
  // behaviour nobody answers inside 3 seconds is worse on a phone than no
  // button: it reads as the relay having frozen.
  const snapshot = runningTurn({ chunks: ['hello'] }).snapshot();
  const withButton = renderCard(snapshot);
  const without = renderCard(snapshot, { interrupt: false });
  assert.equal(allButtons(withButton.card).length, 1);
  assert.equal(allButtons(without.card).length, 0);
  assert.ok(!JSON.stringify(without.card).includes('callback'));
  // The output itself, the header and the footer must be untouched.
  assert.equal(
    findElement(without.card, 'turn_output').content,
    findElement(withButton.card, 'turn_output').content,
  );
  assert.deepEqual(without.card.header, withButton.card.header);
  assert.equal(without.streamContent, withButton.streamContent);
  assert.ok(without.bytes < withButton.bytes);
  // Default is on, so no existing caller changes behaviour.
  assert.equal(allButtons(renderCard(snapshot, {}).card).length, 1);
});

// -- approvals ---------------------------------------------------------------

test('approval buttons carry callback behaviors and only legal decisions', () => {
  const projection = runningTurn();
  projection.openApproval({
    requestId: 'req-uuid-1',
    method: 'item/commandExecution/requestApproval',
    params: commandApprovalParams(),
  });
  const rendered = renderCard(projection.snapshot());

  const buttons = allButtons(rendered.card).filter(
    (button) => button.behaviors?.[0]?.value?.a === ACTION.approval,
  );
  assert.ok(buttons.length > 0);
  for (const button of buttons) {
    assert.equal(button.behaviors[0].type, 'callback', 'a button callback attaches as behaviors');
    assert.equal(button.behaviors[0].value.r, 'req-uuid-1', 'the UUID request id rides back verbatim');
    assert.ok(
      APPROVAL_DECISIONS.includes(button.behaviors[0].value.d),
      `${button.behaviors[0].value.d} would be silently coerced to decline`,
    );
  }
  assert.match(findElement(rendered.card, 'ask_req-uuid-1').content, /npm test/);
});

test('buttonsFor prefers the decisions the server offered and never widens them', () => {
  assert.deepEqual(buttonsFor({ decisions: null }), APPROVAL_BUTTONS);
  assert.deepEqual(buttonsFor(undefined), APPROVAL_BUTTONS);

  const narrowed = buttonsFor({ decisions: ['accept', 'decline'] });
  assert.deepEqual(narrowed.map((button) => button.decision), ['accept', 'decline']);

  // A decision the renderer has no button for cannot conjure one.
  const unknown = buttonsFor({ decisions: ['teleport'] });
  assert.deepEqual(unknown, APPROVAL_BUTTONS);
  for (const button of APPROVAL_BUTTONS) {
    assert.ok(APPROVAL_DECISIONS.includes(button.decision));
  }
});

test('a user-input request renders no buttons and says why', () => {
  const projection = runningTurn();
  projection.openApproval({
    requestId: 'req-ui', method: 'item/tool/requestUserInput', params: userInputParams(),
  });
  const rendered = renderCard(projection.snapshot());
  const approvalButtons = allButtons(rendered.card).filter(
    (button) => button.behaviors?.[0]?.value?.a === ACTION.approval,
  );
  assert.equal(approvalButtons.length, 0, 'a button here would be coerced to decline');
  assert.match(findElement(rendered.card, 'ask_req-ui').content, /文字回复/);
});

test('a file-change approval refuses to show a diff it has not received', () => {
  const projection = runningTurn();
  projection.apply('item/started', { item: { id: 'it_2', itemType: 'fileChange' } });
  projection.openApproval({
    requestId: 'req-fc', method: 'item/fileChange/requestApproval', params: { itemId: 'it_2' },
  });
  const before = renderCard(projection.snapshot(), { detail: DETAIL.full });
  assert.match(findElement(before.card, 'ask_req-fc').content, /不要盲批/);

  projection.apply('item/fileChange/patchUpdated', { itemId: 'it_2', patch: '--- a\n+++ b\n+added' });
  const after = renderCard(projection.snapshot(), { detail: DETAIL.full });
  assert.match(findElement(after.card, 'ask_req-fc').content, /\+added/);
});

// -- the privacy knob --------------------------------------------------------

test('notify detail emits no model output and no diff but still names the command', () => {
  const projection = runningTurn({ chunks: ['private model output that must not leave'] });
  projection.apply('item/started', { item: { id: 'it_2', itemType: 'fileChange' } });
  projection.apply('item/fileChange/patchUpdated', { itemId: 'it_2', patch: 'SECRET DIFF BODY' });
  projection.openApproval({
    requestId: 'req-1',
    method: 'item/commandExecution/requestApproval',
    params: commandApprovalParams(),
  });

  const rendered = renderCard(projection.snapshot(), { detail: DETAIL.notify });
  const serialised = JSON.stringify(rendered.card);
  assert.equal(rendered.streamContent, '');
  assert.equal(findElement(rendered.card, STREAM_ELEMENT_ID).content, '');
  assert.equal(serialised.includes('private model output'), false);
  assert.equal(serialised.includes('SECRET DIFF BODY'), false);
  // A person cannot approve a command they are not shown.
  assert.match(findElement(rendered.card, 'ask_req-1').content, /npm test/);
  // And it still says whether anything is happening.
  assert.match(serialised, /fileChange/);
});

test('brief detail keeps a readable tail and drops reasoning', () => {
  const projection = runningTurn({ chunks: ['answer text'] });
  projection.apply('item/started', { item: { id: 'it_r', itemType: 'reasoning' } });
  projection.apply('item/reasoning/delta', { itemId: 'it_r', delta: 'long internal monologue' });

  const full = renderCard(projection.snapshot(), { detail: DETAIL.full });
  assert.match(full.streamContent, /long internal monologue/);

  const brief = renderCard(projection.snapshot(), { detail: DETAIL.brief, briefChars: 200 });
  assert.equal(brief.streamContent.includes('long internal monologue'), false);
  assert.match(brief.streamContent, /answer text/);
});

test('brief detail clips to the requested length', () => {
  const projection = runningTurn({ chunks: ['x'.repeat(5000), 'TAIL'] });
  const brief = renderCard(projection.snapshot(), { detail: DETAIL.brief, briefChars: 50 });
  assert.ok(brief.streamContent.length <= 50);
  assert.match(brief.streamContent, /TAIL$/, 'the newest text is what survives');
});

test('an unknown detail level is refused rather than defaulted', () => {
  assert.throws(() => renderCard(runningTurn().snapshot(), { detail: 'everything' }), RangeError);
});

// -- budgets -----------------------------------------------------------------

test('clipTail keeps the tail and marks the cut', () => {
  assert.equal(clipTail('abcdef', 100), 'abcdef');
  assert.match(clipTail('abcdefghij', 8), /ghij$/);
  assert.equal(clipTail('abcdef', 0), '');
  assert.equal(clipTail(null, 10), '');
  // A marker longer than the budget must not produce a string over budget.
  assert.equal(clipTail('abcdef', 3, 'LONG MARKER').length, 3);
});

test('byteLength counts UTF-8 bytes, not code units', () => {
  assert.equal(byteLength('abc'), 3);
  assert.equal(byteLength('中文'), 6);
  assert.equal(byteLength('😀'), 4);
});

test('an oversized card is clamped to fit instead of being rejected whole', () => {
  const projection = runningTurn({ chunks: ['字'.repeat(60000)] });
  const rendered = renderCard(projection.snapshot());

  assert.ok(
    rendered.bytes <= LARK_LIMITS.cardContentBytes,
    `${rendered.bytes} bytes exceeds the 30 KB ceiling and would be rejected whole`,
  );
  assert.equal(rendered.truncated, true);
  // The streaming endpoint has its own, far larger budget, so the full text
  // still goes out that way.
  assert.ok(rendered.streamContent.length > 30 * 1024);
  assert.ok(rendered.streamContent.length <= LARK_LIMITS.streamContentChars);
});

test('the streaming content respects the 100,000 character limit', () => {
  const projection = runningTurn({ chunks: ['a'.repeat(250000)] });
  const rendered = renderCard(projection.snapshot());
  assert.equal(rendered.streamContent.length, LARK_LIMITS.streamContentChars);
  assert.match(rendered.streamContent, /a$/);
});

// -- the cheap/expensive split ----------------------------------------------

test('the shell digest is unchanged when only the streaming text grew', () => {
  const short = renderCard(runningTurn({ chunks: ['a'] }).snapshot());
  const long = renderCard(runningTurn({ chunks: ['a', 'bcdefghij'] }).snapshot());
  assert.notEqual(short.streamContent, long.streamContent);
  assert.equal(
    short.shellDigest,
    long.shellDigest,
    'growing text must not force the expensive full-card update',
  );
});

test('the shell digest changes when an approval appears', () => {
  const projection = runningTurn();
  const before = renderCard(projection.snapshot()).shellDigest;
  projection.openApproval({
    requestId: 'req-1',
    method: 'item/commandExecution/requestApproval',
    params: commandApprovalParams(),
  });
  assert.notEqual(renderCard(projection.snapshot()).shellDigest, before);
});

test('the shell digest changes when the turn ends', () => {
  const projection = runningTurn();
  const before = renderCard(projection.snapshot()).shellDigest;
  projection.conclude('completed');
  assert.notEqual(renderCard(projection.snapshot()).shellDigest, before);
});

test('digestShell blanks the streaming element without mutating the card', () => {
  const rendered = renderCard(runningTurn({ chunks: ['keep me'] }).snapshot());
  digestShell(rendered.card);
  assert.equal(findElement(rendered.card, STREAM_ELEMENT_ID).content, 'keep me');
});

test('the footer names the end and the error when there is one', () => {
  const projection = runningTurn();
  projection.apply('thread/tokenUsage/updated', { inputTokens: 3, outputTokens: 4 });
  projection.conclude('failed', { error: 'transport closed' });
  const rendered = renderCard(projection.snapshot(), { endId: 'mac-studio' });
  const footer = findElement(rendered.card, 'footer').content;
  assert.match(footer, /mac-studio/);
  assert.match(footer, /7 tokens/);
  assert.match(footer, /transport closed/);
});
