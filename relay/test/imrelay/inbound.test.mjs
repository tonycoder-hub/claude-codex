import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InboundGate, INTENT, IGNORED, EVENT_TYPES, TEXT_DECISIONS } from '../../src/imrelay/inbound.mjs';
import { ACTION } from '../../src/imrelay/cards.mjs';
import { APPROVAL_DECISIONS } from '../../src/appserver/client.mjs';
import { messageEvent, cardActionEvent } from './fakes.mjs';

const ALLOWED = 'oc_allowed';

function gate(init = {}) {
  return new InboundGate({ chats: [ALLOWED], ...init });
}

// -- the fuse ----------------------------------------------------------------

test('an empty allowlist accepts nothing and there is no wildcard', () => {
  const closed = new InboundGate();
  assert.equal(closed.allowedChatCount, 0);
  for (const chatId of [ALLOWED, 'oc_internal_readonly', '*', '']) {
    const result = closed.accept(messageEvent({ chatId, text: 'please run rm -rf' }));
    assert.equal(result.intent, INTENT.ignored);
  }
  // There is no constructor argument that means "all chats".
  assert.throws(() => new InboundGate({ chats: '*' }), TypeError);
});

test('a message from a chat that is not allowlisted produces no intent', () => {
  const result = gate().accept(messageEvent({ chatId: 'oc_somewhere_else' }));
  assert.equal(result.intent, INTENT.ignored);
  assert.equal(result.reason, IGNORED.chatNotAllowed);
});

test('the bot does not hear itself', () => {
  const result = gate().accept(messageEvent({ senderType: 'app', text: 'my own card text' }));
  assert.equal(result.reason, IGNORED.notFromUser);
});

// -- de-duplication ----------------------------------------------------------

test('a re-pushed event is recognised and not acted on twice', () => {
  const inbound = gate();
  const envelope = messageEvent({ text: 'build it', eventId: 'ev_fixed' });

  const first = inbound.accept(envelope, 0);
  assert.equal(first.intent, INTENT.prompt);
  // The platform re-pushes an event whose handler took longer than 3 seconds.
  const second = inbound.accept(envelope, 3100);
  assert.equal(second.intent, INTENT.ignored);
  assert.equal(second.reason, IGNORED.duplicate);
});

test('de-duplication happens before the allowlist, so a rejected event is not re-examined', () => {
  const inbound = gate();
  const envelope = messageEvent({ chatId: 'oc_not_allowed', eventId: 'ev_dup' });
  assert.equal(inbound.accept(envelope, 0).reason, IGNORED.chatNotAllowed);
  assert.equal(inbound.accept(envelope, 10).reason, IGNORED.duplicate);
});

test('the de-duplication memory expires and is bounded', () => {
  const inbound = gate({ dedupeWindowMs: 1000, dedupeMax: 3 });
  const envelope = messageEvent({ text: 'hi', eventId: 'ev_old' });
  inbound.accept(envelope, 0);
  assert.equal(inbound.accept(envelope, 500).reason, IGNORED.duplicate);
  // Long past the re-push window; a genuinely new event may reuse the id.
  assert.equal(inbound.accept(envelope, 50000).intent, INTENT.prompt);

  for (let index = 0; index < 20; index += 1) {
    inbound.accept(messageEvent({ text: 'x' }), 50000);
  }
  assert.ok(inbound.rememberedEvents <= 3);
});

// -- the handler contract ----------------------------------------------------

test('accept is synchronous, because the handler has three seconds', () => {
  const result = gate().accept(messageEvent({ text: 'anything' }));
  assert.equal(typeof result.then, 'undefined');
  assert.equal(result.intent, INTENT.prompt);
});

test('no envelope can make accept throw', () => {
  const inbound = gate();
  const junk = [
    null, undefined, {}, { header: {} }, { header: { event_id: 'e', event_type: 't' } },
    { header: { event_id: 'e2', event_type: EVENT_TYPES.message }, event: null },
    { header: { event_id: 'e3', event_type: EVENT_TYPES.message }, event: { sender: null } },
    { header: { event_id: 'e4', event_type: EVENT_TYPES.cardAction }, event: {} },
    { header: { event_id: 5, event_type: EVENT_TYPES.message }, event: {} },
  ];
  for (const envelope of junk) {
    const result = inbound.accept(envelope, 0);
    assert.equal(result.intent, INTENT.ignored, JSON.stringify(envelope));
  }
});

// -- prompts -----------------------------------------------------------------

test('a plain message becomes a prompt keyed on its chat', () => {
  const result = gate().accept(messageEvent({ text: 'ship it', messageId: 'om_42' }), 7);
  assert.equal(result.intent, INTENT.prompt);
  assert.equal(result.text, 'ship it');
  assert.equal(result.lane, ALLOWED);
  assert.equal(result.chatId, ALLOWED);
  assert.equal(result.messageId, 'om_42');
  assert.equal(result.freshThread, false);
  assert.equal(result.endId, null);
  assert.equal(result.at, 7);
});

test('mention placeholders are stripped and a mention-only message is ignored', () => {
  const inbound = gate();
  assert.equal(inbound.accept(messageEvent({ text: '@_user_1 run the tests' })).text, 'run the tests');
  assert.equal(inbound.accept(messageEvent({ text: '@_all  @_user_2  ' })).reason, IGNORED.emptyText);
});

test('content that is not the documented JSON string is refused', () => {
  const inbound = gate();
  assert.equal(inbound.accept(messageEvent({ content: 'not json' })).reason, IGNORED.malformed);
  assert.equal(inbound.accept(messageEvent({ content: '{"body":"wrong key"}' })).reason, IGNORED.malformed);
});

test('a non-text message is refused rather than guessed at', () => {
  const result = gate().accept(messageEvent({ messageType: 'image', content: '{"image_key":"x"}' }));
  assert.equal(result.reason, IGNORED.unsupportedMessageType);
});

test('/new asks for a fresh thread and /end pins an end', () => {
  const inbound = gate();
  const fresh = inbound.accept(messageEvent({ text: '/new start over' }));
  assert.equal(fresh.freshThread, true);
  assert.equal(fresh.text, 'start over');

  const pinned = inbound.accept(messageEvent({ text: '/end mac-studio do the thing' }));
  assert.equal(pinned.endId, 'mac-studio');
  assert.equal(pinned.text, 'do the thing');
});

test('/stop is an interrupt, not a prompt', () => {
  const result = gate().accept(messageEvent({ text: '/stop' }));
  assert.equal(result.intent, INTENT.interrupt);
  assert.equal(result.lane, ALLOWED);
});

test('a slash word that is not a command stays part of the prompt', () => {
  const inbound = gate();
  assert.equal(inbound.accept(messageEvent({ text: '/usr/bin/env python' })).text, '/usr/bin/env python');
  assert.equal(inbound.accept(messageEvent({ text: '/deploy now' })).text, '/deploy now');
});

test('a command with nothing after it is not an empty prompt', () => {
  assert.equal(gate().accept(messageEvent({ text: '/new' })).reason, IGNORED.emptyText);
});

test('lanes can be keyed on the platform thread instead of the chat', () => {
  const inbound = gate({ laneBy: 'thread' });
  const threaded = inbound.accept(messageEvent({ text: 'in a topic', threadId: 'omt_9' }));
  assert.equal(threaded.lane, `${ALLOWED}#omt_9`);
  assert.equal(threaded.threadRoot, 'omt_9');

  const loose = inbound.accept(messageEvent({ text: 'no topic' }));
  assert.equal(loose.lane, ALLOWED);
  assert.throws(() => new InboundGate({ laneBy: 'whatever' }), RangeError);
});

// -- decisions from a button -------------------------------------------------

test('a card button becomes a decision intent carrying the server request id', () => {
  const result = gate().accept(cardActionEvent({
    value: { a: ACTION.approval, r: 'b2f0a0c6-0000-4000-8000-000000000001', d: 'accept' },
  }), 11);
  assert.equal(result.intent, INTENT.decision);
  assert.equal(result.requestId, 'b2f0a0c6-0000-4000-8000-000000000001');
  assert.equal(result.decision, 'accept');
  assert.equal(result.via, 'button');
  assert.equal(result.chatId, ALLOWED);
  assert.equal(result.callbackToken, 'c-placeholder');
});

test('an out-of-vocabulary decision is refused, not coerced to decline', () => {
  const inbound = gate();
  for (const bogus of ['approve', 'yes', 'DECLINE', '', null, 42, { decision: 'accept' }]) {
    const result = inbound.accept(cardActionEvent({ value: { a: ACTION.approval, r: 'r1', d: bogus } }));
    assert.equal(result.intent, INTENT.ignored, `${JSON.stringify(bogus)} got through`);
    assert.equal(result.reason, IGNORED.badDecision);
  }
  // The legal four do get through.
  for (const decision of APPROVAL_DECISIONS) {
    const result = inbound.accept(cardActionEvent({ value: { a: ACTION.approval, r: 'r1', d: decision } }));
    assert.equal(result.intent, INTENT.decision);
  }
});

test('an action value that arrived as a JSON string is parsed', () => {
  const result = gate().accept(cardActionEvent({
    value: JSON.stringify({ a: ACTION.approval, r: 'r1', d: 'decline' }),
  }));
  assert.equal(result.intent, INTENT.decision);
  assert.equal(result.decision, 'decline');
});

test('a malformed action value is ignored', () => {
  const inbound = gate();
  assert.equal(inbound.accept(cardActionEvent({ value: 'not json' })).reason, IGNORED.badAction);
  assert.equal(inbound.accept(cardActionEvent({ value: [] })).reason, IGNORED.badAction);
  assert.equal(inbound.accept(cardActionEvent({ value: { a: 'mystery' } })).reason, IGNORED.badAction);
  assert.equal(
    inbound.accept(cardActionEvent({ value: { a: ACTION.approval, d: 'accept' } })).reason,
    IGNORED.badAction,
    'an approval with no request id cannot be answered',
  );
});

test('an interrupt button becomes an interrupt intent', () => {
  const result = gate().accept(cardActionEvent({ value: { a: ACTION.interrupt, t: 'tu_1' } }));
  assert.equal(result.intent, INTENT.interrupt);
  assert.equal(result.turnId, 'tu_1');
});

test('a card action from an unlisted chat is ignored', () => {
  const result = gate().accept(cardActionEvent({
    chatId: 'oc_elsewhere', value: { a: ACTION.approval, r: 'r1', d: 'accept' },
  }));
  assert.equal(result.reason, IGNORED.chatNotAllowed);
});

// -- decisions by typing, the fallback for contested card callbacks ----------

test('the typed decision words map onto the legal vocabulary and nothing else', () => {
  assert.deepEqual(Object.keys(TEXT_DECISIONS), ['/ok', '/always', '/no', '/abort']);
  for (const decision of Object.values(TEXT_DECISIONS)) {
    assert.ok(APPROVAL_DECISIONS.includes(decision), `${decision} would be coerced to decline`);
  }
});

test('typing a decision produces an intent with no request id, to be resolved by lane', () => {
  const inbound = gate();
  for (const [word, decision] of Object.entries(TEXT_DECISIONS)) {
    const result = inbound.accept(messageEvent({ text: word }), 3);
    assert.equal(result.intent, INTENT.decision, word);
    assert.equal(result.decision, decision);
    assert.equal(result.requestId, null, 'a person cannot be asked to quote a UUID');
    assert.equal(result.lane, ALLOWED);
    assert.equal(result.via, 'text');
  }
});

test('a typed decision may carry a comment after it', () => {
  const result = gate().accept(messageEvent({ text: '/no too risky on prod' }));
  assert.equal(result.intent, INTENT.decision);
  assert.equal(result.decision, 'decline');
});

test('a typed decision is still gated by the chat allowlist', () => {
  const result = new InboundGate().accept(messageEvent({ text: '/ok' }));
  assert.equal(result.intent, INTENT.ignored);
});

test('the typed path keeps working under thread lanes', () => {
  const result = gate({ laneBy: 'thread' }).accept(messageEvent({ text: '/ok', threadId: 'omt_3' }));
  assert.equal(result.lane, `${ALLOWED}#omt_3`);
  assert.equal(result.decision, 'accept');
});

test('the operator identity is deliberately not extracted', () => {
  const result = gate().accept(cardActionEvent({ value: { a: ACTION.approval, r: 'r1', d: 'accept' } }));
  assert.equal(result.operator, null);
  assert.equal(JSON.stringify(result).includes('ou_someone'), false);
});

// -- /ai dispatch and gated chats --------------------------------------------

test('/ai is a bare dispatch prefix that strips itself', () => {
  const result = gate().accept(messageEvent({ text: '/ai rename the handler' }));
  assert.equal(result.intent, INTENT.prompt);
  assert.equal(result.text, 'rename the handler');
  // It is not /new: the thread continues.
  assert.equal(result.freshThread, false);
});

test('/ai with nothing after it is not a prompt', () => {
  const result = gate().accept(messageEvent({ text: '/ai' }));
  assert.equal(result.intent, INTENT.ignored);
  assert.equal(result.reason, IGNORED.emptyText);
});

test('an ungated chat relays plain messages, as a direct chat should', () => {
  const result = gate().accept(messageEvent({ text: 'rename the handler' }));
  assert.equal(result.intent, INTENT.prompt);
  assert.equal(result.text, 'rename the handler');
});

test('a gated chat ignores people talking to each other', () => {
  const g = gate({ requireCommand: true });
  for (const text of ['rename the handler', 'lunch?', 'ai, do this', '/nope x']) {
    const result = g.accept(messageEvent({ text }));
    assert.equal(result.intent, INTENT.ignored, text);
    assert.equal(result.reason, IGNORED.notAddressed, text);
  }
});

test('a gated chat still hears every command, not just /ai', () => {
  const g = gate({ requireCommand: true });
  assert.equal(g.accept(messageEvent({ text: '/ai go' })).intent, INTENT.prompt);
  assert.equal(g.accept(messageEvent({ text: '/new go' })).intent, INTENT.prompt);
  assert.equal(g.accept(messageEvent({ text: '/stop' })).intent, INTENT.interrupt);
  assert.equal(g.accept(messageEvent({ text: '/ok' })).intent, INTENT.decision);
  assert.equal(g.accept(messageEvent({ text: '/mine' })).intent, INTENT.hold);
});

test('gating does not run before the cheaper filters', () => {
  // A disallowed chat is disallowed even when it says the magic word, and the
  // bot still does not hear itself.
  const g = gate({ requireCommand: true });
  assert.equal(g.accept(messageEvent({ chatId: 'oc_elsewhere', text: '/ai go' })).reason,
    IGNORED.chatNotAllowed);
  assert.equal(g.accept(messageEvent({ senderType: 'app', text: '/ai go' })).reason,
    IGNORED.notFromUser);
});

// -- take-over ---------------------------------------------------------------

test('/mine and /release are intents of their own, carrying no operator id', () => {
  const held = gate().accept(messageEvent({ text: '/mine' }));
  assert.equal(held.intent, INTENT.hold);
  assert.equal(held.lane, ALLOWED);
  assert.equal('operator' in held, false);
  assert.equal('userId' in held, false);
  assert.equal(gate().accept(messageEvent({ text: '/release' })).intent, INTENT.release);
});

test('words after /mine cannot become a prompt: hold carries no text', () => {
  for (const text of ['/mine', '/mine for a sec', '/release now please']) {
    const result = gate().accept(messageEvent({ text }));
    assert.ok(result.intent === INTENT.hold || result.intent === INTENT.release, text);
    assert.equal('text' in result, false, text);
  }
});

test('a prompt that merely starts with a path is still a prompt', () => {
  // The guard that makes /ai work must not have made every slash a command.
  const result = gate().accept(messageEvent({ text: '/src/imrelay/inbound.mjs needs a look' }));
  assert.equal(result.intent, INTENT.prompt);
  assert.equal(result.text, '/src/imrelay/inbound.mjs needs a look');
});

// -- reviewing the daily draft digest ---------------------------------------

test('/drafts is a question and needs no handle', () => {
  const result = gate().accept(messageEvent({ text: '/drafts' }));
  assert.equal(result.intent, INTENT.draft);
  assert.equal(result.action, 'list');
  assert.equal(result.ref, null);
});

test('the three verbs that act on a draft carry its handle', () => {
  const cases = [
    ['/send d2', 'send', 'd2', ''],
    ['/skip d2', 'discard', 'd2', ''],
    ['/edit d2 say it shorter', 'edit', 'd2', 'say it shorter'],
  ];
  for (const [text, action, ref, tail] of cases) {
    const result = gate().accept(messageEvent({ text }));
    assert.equal(result.intent, INTENT.draft, text);
    assert.equal(result.action, action, text);
    assert.equal(result.ref, ref, text);
    assert.equal(result.text, tail, text);
  }
});

test('a bare /send is refused rather than guessed at', () => {
  for (const text of ['/send', '/skip', '/edit']) {
    const result = gate().accept(messageEvent({ text }));
    assert.equal(result.intent, INTENT.ignored, text);
    assert.equal(result.reason, IGNORED.noDraftHandle, text);
  }
});

test('only /edit has anywhere to put trailing words', () => {
  const sent = gate().accept(messageEvent({ text: '/send d1 looks good to me' }));
  assert.equal(sent.action, 'send');
  assert.equal(sent.ref, 'd1');
  assert.equal(sent.text, '');
});

test('an /edit with no replacement still reaches the book, which refuses it', () => {
  // The parser does not adjudicate emptiness -- `digest.mjs` does, so that
  // the reviewer gets one consistent refusal whatever the route in.
  const result = gate().accept(messageEvent({ text: '/edit d1' }));
  assert.equal(result.action, 'edit');
  assert.equal(result.text, '');
});

test('review verbs are commands, so a gated group hears them', () => {
  const g = gate({ requireCommand: true });
  assert.equal(g.accept(messageEvent({ text: '/drafts' })).intent, INTENT.draft);
  assert.equal(g.accept(messageEvent({ text: '/send d1' })).intent, INTENT.draft);
});
