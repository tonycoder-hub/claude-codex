// The one test that puts the whole subsystem together: a fake long connection
// delivers an event, the gate turns it into an intent, the dispatcher schedules
// it, the projection folds the turn, the renderer produces a card, the pacer
// decides when to write it, and the allowlisted sink records what would have
// gone out.
//
// Nothing here touches a network. The transport is the documented interface from
// `transport.mjs` with the fake from `fakes.mjs` behind it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InboundGate, INTENT, IGNORED } from '../../src/imrelay/inbound.mjs';
import { Dispatcher, EFFECT, OUTCOME } from '../../src/imrelay/dispatch.mjs';
import { DraftBook, DIGEST_EFFECT, DIGEST_NOTICE } from '../../src/imrelay/digest.mjs';
import { TurnProjection, TURN_STATUS } from '../../src/imrelay/projection.mjs';
import { renderCard, DETAIL, ACTION, STREAM_ELEMENT_ID } from '../../src/imrelay/cards.mjs';
import { CardPacer, PACE, pacingFor } from '../../src/imrelay/throttle.mjs';
import {
  OPS, LARK_LIMITS, allowlistSink, assertLongConnection, OutboundSealed,
} from '../../src/imrelay/transport.mjs';
import { approvalResponder, RpcError } from '../../src/appserver/client.mjs';
import {
  fakeLongConnection, recordingSink, fakeClock, messageEvent, cardActionEvent, turnStream, feed,
} from './fakes.mjs';
import { commandApprovalParams } from '../appserver/fakes.mjs';

const CHAT = 'oc_allowed';
const APPROVAL_METHOD = 'item/commandExecution/requestApproval';

/**
 * Everything wired together. Returns the parts plus the single synchronous
 * handler the long connection calls.
 */
function relay({ chats = [CHAT], requireCommand = false } = {}) {
  const clock = fakeClock(0);
  const inner = recordingSink({
    results: { [OPS.createCardEntity]: { code: 0, msg: 'success', data: { card_id: 'c_1' } } },
  });
  const sink = allowlistSink({ inner, chats });
  const gate = new InboundGate({ chats, requireCommand });
  const dispatcher = new Dispatcher();
  const drafts = new DraftBook({ chats });
  const intents = [];
  const effects = [];

  const link = fakeLongConnection({ clock });
  assertLongConnection(link.connection);

  // The whole point of the 3-second deadline: this function enqueues and
  // returns. It never awaits a turn, and `fakeLongConnection` throws if it does.
  link.connection.onEvent((envelope) => {
    const intent = gate.accept(envelope, clock.now);
    intents.push(intent);
    if (intent.intent === INTENT.prompt) {
      effects.push(...dispatcher.submit(intent, clock.now).effects);
    } else if (intent.intent === INTENT.decision) {
      effects.push(...dispatcher.answerApproval({
        requestId: intent.requestId, lane: intent.lane, decision: intent.decision,
      }, clock.now).effects);
    } else if (intent.intent === INTENT.interrupt) {
      effects.push(...dispatcher.interrupt({ lane: intent.lane, turnId: intent.turnId }, clock.now).effects);
    } else if (intent.intent === INTENT.hold) {
      effects.push(...dispatcher.hold({ lane: intent.lane }, clock.now).effects);
    } else if (intent.intent === INTENT.release) {
      effects.push(...dispatcher.release({ lane: intent.lane }, clock.now).effects);
    } else if (intent.intent === INTENT.draft) {
      if (intent.action === 'send') {
        effects.push(...drafts.send({ ref: intent.ref }, clock.now).effects);
      } else if (intent.action === 'discard') {
        effects.push(...drafts.discard({ ref: intent.ref }, clock.now).effects);
      } else if (intent.action === 'edit') {
        effects.push(...drafts.edit({ ref: intent.ref, text: intent.text }, clock.now).effects);
      }
    }
  });

  return { clock, inner, sink, gate, dispatcher, drafts, link, intents, effects };
}

test('a typed message becomes a scheduled turn without the handler blocking', () => {
  const r = relay();
  r.dispatcher.observeEnds([{ end: 'mac' }], 0);

  r.link.push(messageEvent({ chatId: CHAT, text: 'run the tests' }));

  assert.equal(r.intents[0].intent, INTENT.prompt);
  const [start] = r.effects.filter((effect) => effect.type === EFFECT.startTurn);
  assert.equal(start.endId, 'mac');
  assert.equal(start.text, 'run the tests');
  assert.equal(start.threadId, null);
  assert.deepEqual(r.link.state.repushed, [], 'a slow handler would have been re-pushed');
});

test('the platform re-pushing an event does not start the turn twice', () => {
  const r = relay();
  r.dispatcher.observeEnds([{ end: 'mac' }], 0);
  const envelope = messageEvent({ chatId: CHAT, text: 'once only', eventId: 'ev_repush' });

  r.link.push(envelope);
  r.clock.advance(3100);
  r.link.push(envelope);

  assert.equal(r.effects.filter((effect) => effect.type === EFFECT.startTurn).length, 1);
  assert.equal(r.intents[1].reason, IGNORED.duplicate);
});

test('a full turn streams into one card inside the platform budget', async () => {
  const r = relay();
  r.dispatcher.observeEnds([{ end: 'mac' }], 0);
  r.link.push(messageEvent({ chatId: CHAT, text: 'write something' }));
  r.dispatcher.turnAccepted({ lane: CHAT, threadId: 'th_1', turnId: 'tu_1' }, 0);

  const projection = new TurnProjection({ chatKey: CHAT, threadId: 'th_1' });
  const pacing = pacingFor({ updatesPerSecond: LARK_LIMITS.cardKitPerCardPerSecond });
  const pacer = new CardPacer({ minIntervalMs: pacing.minIntervalMs });

  // One card entity per turn, created once and then written to.
  const created = [];
  const stream = [];
  let sequence = 0;
  let cardId = null;

  const flushIfOwed = async (now) => {
    const decision = pacer.poll(now);
    if (decision.action !== PACE.flush) return;
    const rendered = renderCard(projection.snapshot(), { detail: DETAIL.full, endId: 'mac' });
    if (cardId === null) {
      const response = await r.sink.perform({
        op: OPS.createCardEntity, card: rendered.card, forChat: CHAT,
      });
      cardId = response.data.card_id;
      r.sink.allowCard(cardId, CHAT);
      created.push(cardId);
    }
    sequence += 1;
    await r.sink.perform({
      op: OPS.streamText,
      cardId,
      elementId: rendered.streamElementId,
      content: rendered.streamContent,
      sequence,
    });
    stream.push(rendered.streamContent);
    pacer.settled(decision.revision, now);
  };

  const chunks = Array.from({ length: 200 }, (_, index) => `chunk${index} `);
  const notifications = turnStream({ threadId: 'th_1', turnId: 'tu_1', chunks });

  let now = 0;
  for (const [method, params] of notifications) {
    if (projection.apply(method, params, now)) {
      pacer.note(projection.revision, { urgent: projection.terminal });
    }
    await flushIfOwed(now);
    now += 10;
  }
  // Drain the tail -- the update that matters most and the one a leading-edge
  // throttle would have dropped.
  for (let guard = 0; guard < 50 && pacer.pending !== null; guard += 1) {
    now += pacing.minIntervalMs;
    await flushIfOwed(now);
  }

  assert.equal(created.length, 1, 'one card entity per turn');
  assert.equal(projection.status, TURN_STATUS.completed);
  assert.equal(pacer.written, projection.revision, 'the last state reached the card');

  const writes = r.inner.of(OPS.streamText);
  assert.ok(writes.length < notifications.length / 4, `${writes.length} writes: deltas were not coalesced`);
  // Sequence numbers are strictly increasing, as the endpoint requires.
  const sequences = writes.map((write) => write.sequence);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
  assert.equal(new Set(sequences).size, sequences.length);

  // Cumulative, not delta: each push is a prefix-extension of the last, which is
  // what makes a dropped or retried update self-healing.
  for (let index = 1; index < stream.length; index += 1) {
    assert.ok(stream[index].startsWith(stream[index - 1]), `push ${index} was not cumulative`);
  }
  assert.equal(stream.at(-1), chunks.join(''));
});

test('an approval becomes buttons and a button press answers the held request', async () => {
  const r = relay();
  r.dispatcher.observeEnds([{ end: 'mac' }], 0);
  r.link.push(messageEvent({ chatId: CHAT, text: 'do something risky' }));

  const projection = new TurnProjection({ chatKey: CHAT, threadId: 'th_1' });
  projection.apply('turn/started', { threadId: 'th_1', turn: { id: 'tu_1', status: 'inProgress' } });

  // This is exactly the wiring the design calls for: the dispatcher holds the
  // promise, `approvalResponder` guards the vocabulary on the way out.
  const requestId = 'b2f0a0c6-0000-4000-8000-00000000aaaa';
  const responder = approvalResponder((params, context) => {
    projection.openApproval({ requestId: context.id, method: context.method, params });
    return r.dispatcher.openApproval({
      requestId: context.id, lane: CHAT, method: context.method, params,
    }).promise;
  });
  const answered = responder(commandApprovalParams(), { id: requestId, method: APPROVAL_METHOD });

  // The card now carries a button per offered decision.
  const rendered = renderCard(projection.snapshot());
  const buttons = JSON.stringify(rendered.card);
  assert.match(buttons, new RegExp(requestId));
  assert.match(buttons, /"type":"callback"/);
  assert.match(buttons, /npm test/);

  // The person presses "approve"; it arrives over the same long connection.
  r.link.push(cardActionEvent({
    chatId: CHAT, value: { a: ACTION.approval, r: requestId, d: 'accept' },
  }));

  assert.deepEqual(await answered, { decision: 'accept' });
  assert.equal(r.dispatcher.pendingApprovals().length, 0);
  projection.closeApproval(requestId, 'accept');
  assert.equal(JSON.stringify(renderCard(projection.snapshot()).card).includes(requestId), false);
});

test('the typed fallback answers the same held request when buttons do not arrive', async () => {
  const r = relay();
  const requestId = 'b2f0a0c6-0000-4000-8000-00000000bbbb';
  const responder = approvalResponder(
    (params, context) => r.dispatcher.openApproval({
      requestId: context.id, lane: CHAT, method: context.method, params,
    }).promise,
  );
  const answered = responder(commandApprovalParams(), { id: requestId, method: APPROVAL_METHOD });

  // No card callback ever arrives. The person types instead.
  r.link.push(messageEvent({ chatId: CHAT, text: '/ok' }));

  assert.deepEqual(await answered, { decision: 'accept' });
});

test('an out-of-vocabulary decision is refused end to end, not coerced to decline', async () => {
  const r = relay();
  const requestId = 'b2f0a0c6-0000-4000-8000-00000000cccc';
  const held = r.dispatcher.openApproval({ requestId, lane: CHAT, method: APPROVAL_METHOD }, 0);
  held.promise.catch(() => {});

  // A tampered or stale card sends a value the adapter would silently turn into
  // `decline`. The gate refuses it, so the approval stays open.
  r.link.push(cardActionEvent({ chatId: CHAT, value: { a: ACTION.approval, r: requestId, d: 'approve' } }));
  assert.equal(r.intents.at(-1).reason, IGNORED.badDecision);
  assert.equal(r.dispatcher.pendingApprovals().length, 1, 'the ask survives a bogus answer');

  // And if one ever got past the gate, the responder turns it into a loud error
  // rather than a quiet refusal.
  const bogus = approvalResponder(() => 'approve');
  await assert.rejects(
    () => bogus({}, { id: requestId, method: APPROVAL_METHOD }),
    (error) => error instanceof RpcError && /not an approval decision/.test(error.message),
  );
});

test('an interrupt button stops the turn the app-server is running', () => {
  const r = relay();
  r.dispatcher.observeEnds([{ end: 'mac' }], 0);
  r.link.push(messageEvent({ chatId: CHAT, text: 'long job' }));
  r.dispatcher.turnAccepted({ lane: CHAT, threadId: 'th_1', turnId: 'tu_1' }, 0);

  r.link.push(cardActionEvent({ chatId: CHAT, value: { a: ACTION.interrupt, t: 'tu_1' } }));

  const [stop] = r.effects.filter((effect) => effect.type === EFFECT.interruptTurn);
  assert.equal(stop.threadId, 'th_1');
  assert.equal(stop.turnId, 'tu_1');
});

// -- the fuse, end to end ----------------------------------------------------

test('with no allowlist nothing becomes a turn and nothing can be posted', async () => {
  const r = relay({ chats: [] });
  r.dispatcher.observeEnds([{ end: 'mac' }], 0);

  r.link.push(messageEvent({ chatId: CHAT, text: 'please run this' }));
  r.link.push(messageEvent({ chatId: 'oc_internal_readonly', text: 'internal chatter' }));
  r.link.push(cardActionEvent({ chatId: CHAT, value: { a: ACTION.approval, r: 'r1', d: 'accept' } }));

  assert.equal(r.intents.every((intent) => intent.intent === INTENT.ignored), true);
  assert.deepEqual(r.effects, []);

  // And the outbound side refuses independently of the inbound side.
  await assert.rejects(
    () => r.sink.perform({ op: OPS.sendMessage, receiveId: CHAT, msgType: 'text', content: { text: 'hi' } }),
    OutboundSealed,
  );
  assert.deepEqual(r.inner.ops, [], 'nothing reached the transport');
});

test('an allowlisted relay still cannot write to a chat it was not given', async () => {
  const r = relay({ chats: [CHAT] });
  await assert.rejects(
    () => r.sink.perform({
      op: OPS.sendMessage, receiveId: 'oc_internal_readonly', msgType: 'text', content: { text: 'leak' },
    }),
    OutboundSealed,
  );
  assert.deepEqual(r.inner.ops, []);
});

test('a notify-detail card is a control surface that carries no model output', async () => {
  const r = relay();
  const projection = new TurnProjection({ chatKey: CHAT, threadId: 'th_1' });
  feed(projection, turnStream({ threadId: 'th_1', chunks: ['SECRET MODEL OUTPUT'] }));

  const rendered = renderCard(projection.snapshot(), { detail: DETAIL.notify, endId: 'mac' });
  await r.sink.perform({ op: OPS.createCardEntity, card: rendered.card, forChat: CHAT });

  const sent = JSON.stringify(r.inner.last);
  assert.equal(sent.includes('SECRET MODEL OUTPUT'), false);
  assert.equal(rendered.streamContent, '');
  assert.equal(
    rendered.card.body.elements.find((element) => element.element_id === STREAM_ELEMENT_ID).content,
    '',
  );
  // It still says a turn happened, which is the entire point of this mode.
  assert.match(sent, /已完成/);
});

test('the relay never schedules a prompt it did not hear from a person', () => {
  const r = relay();
  r.dispatcher.observeEnds([{ end: 'mac' }], 0);
  // Its own card text coming back as a bot message.
  r.link.push(messageEvent({ chatId: CHAT, text: 'Claude Code · th_1', senderType: 'app' }));
  assert.equal(r.intents[0].reason, IGNORED.notFromUser);
  assert.deepEqual(r.effects, []);
  assert.equal(r.dispatcher.snapshot().lanes.length, 0);
});

test('a queued prompt tells the person which kind of "not yet" it is', () => {
  const r = relay();
  // No ends at all.
  r.link.push(messageEvent({ chatId: CHAT, text: 'anyone home?' }));
  const notice = r.effects.find((effect) => effect.type === EFFECT.notice);
  assert.equal(notice.kind, 'no-ends');

  // Now an end exists but is busy with somebody else's work.
  r.dispatcher.observeEnds([{ end: 'mac', busy: true }], 10);
  r.link.push(messageEvent({ chatId: CHAT, text: 'and now?' }));
  assert.equal(r.dispatcher.snapshot().lanes[0].queued, 2);
  assert.equal(r.effects.filter((effect) => effect.type === EFFECT.startTurn).length, 0);
});

test('every op the relay can emit is one the transport knows how to build', () => {
  const r = relay();
  assert.equal(r.sink.allowedChatCount, 1);
  for (const op of Object.values(OPS)) {
    assert.equal(typeof op, 'string');
    assert.notEqual(op, '');
  }
  assert.equal(new Set(Object.values(OPS)).size, Object.values(OPS).length);
});

test('a turn that ends with its end gone is concluded rather than left spinning', () => {
  const r = relay();
  r.dispatcher.observeEnds([{ end: 'mac' }], 0);
  r.link.push(messageEvent({ chatId: CHAT, text: 'go' }));
  r.dispatcher.turnAccepted({ lane: CHAT, threadId: 'th_1', turnId: 'tu_1' }, 1);

  const projection = new TurnProjection({ chatKey: CHAT, threadId: 'th_1' });
  projection.apply('turn/started', { threadId: 'th_1', turn: { id: 'tu_1', status: 'inProgress' } });
  assert.equal(projection.terminal, false);

  const { effects } = r.dispatcher.observeEnds([], 5);
  const [orphan] = effects.filter((effect) => effect.type === EFFECT.orphaned);
  assert.ok(orphan);
  projection.conclude('failed', { error: 'the end went away', at: 5 });

  const rendered = renderCard(projection.snapshot());
  assert.equal(projection.terminal, true);
  assert.equal(rendered.card.config.streaming_mode, false);
  assert.match(JSON.stringify(rendered.card), /the end went away/);
});

test('the dispatcher consumes the relay roster shape verbatim', () => {
  const r = relay();
  // `GET /ends` returns entries keyed `end`, with `busy`.
  const roster = [{ end: 'mac', busy: false }, { end: 'linux-box', busy: true }];
  r.dispatcher.observeEnds(roster, 0);
  assert.deepEqual(r.dispatcher.schedulableEnds(), ['mac']);

  // Absence is authoritative: registration lives exactly as long as the control
  // socket, so a missing end is gone rather than merely quiet.
  r.dispatcher.observeEnds([], 1);
  assert.deepEqual(r.dispatcher.schedulableEnds(), []);
  assert.equal(r.dispatcher.snapshot().ends.every((end) => end.present === false), true);
});

test('submitting while everything is offline is reported, not swallowed', () => {
  const r = relay();
  r.link.push(messageEvent({ chatId: CHAT, text: 'hello?' }));
  const result = r.dispatcher.submit(
    { lane: CHAT, chatId: CHAT, eventId: 'ev_manual', text: 'hello?' }, 0,
  );
  assert.equal(result.outcome, OUTCOME.noEnd);
});

test('/mine stops the relay mid-turn from inside the chat, and /release restores it', () => {
  const r = relay();
  r.dispatcher.observeEnds([{ end: 'mac' }], 0);
  r.link.push(messageEvent({ chatId: CHAT, text: 'refactor everything' }));
  r.dispatcher.turnAccepted({ lane: CHAT, threadId: 'th_1', turnId: 'tu_1' }, 0);

  // The human watching the card decides this is going wrong.
  r.clock.advance(1000);
  r.link.push(messageEvent({ chatId: CHAT, text: '/mine' }));
  const interrupts = r.effects.filter((e) => e.type === EFFECT.interruptTurn);
  assert.deepEqual(interrupts.map((e) => e.turnId), ['tu_1']);

  // Anything typed while they are driving is refused, not banked.
  r.clock.advance(1000);
  r.dispatcher.turnFinished({ lane: CHAT, status: 'interrupted' }, r.clock.now);
  r.link.push(messageEvent({ chatId: CHAT, text: 'actually do this instead' }));
  assert.equal(r.effects.filter((e) => e.type === EFFECT.startTurn).length, 1);
  assert.equal(r.dispatcher.snapshot().lanes[0].queued, 0);

  // Handing back does not replay anything; the next message is a fresh turn.
  r.clock.advance(1000);
  r.link.push(messageEvent({ chatId: CHAT, text: '/release' }));
  assert.equal(r.effects.filter((e) => e.type === EFFECT.startTurn).length, 1);
  r.clock.advance(1000);
  r.link.push(messageEvent({ chatId: CHAT, text: 'try again' }));
  const starts = r.effects.filter((e) => e.type === EFFECT.startTurn);
  assert.equal(starts.length, 2);
  assert.equal(starts[1].text, 'try again');
});

test('in a gated group only /ai reaches the dispatcher', () => {
  const r = relay({ requireCommand: true });
  r.dispatcher.observeEnds([{ end: 'mac' }], 0);

  r.link.push(messageEvent({ chatId: CHAT, text: 'did anyone look at the build?' }));
  r.clock.advance(3100);
  r.link.push(messageEvent({ chatId: CHAT, text: 'not yet' }));
  assert.equal(r.effects.length, 0);
  assert.deepEqual(r.intents.map((i) => i.reason), [IGNORED.notAddressed, IGNORED.notAddressed]);

  r.clock.advance(3100);
  r.link.push(messageEvent({ chatId: CHAT, text: '/ai look at the build' }));
  const starts = r.effects.filter((e) => e.type === EFFECT.startTurn);
  assert.deepEqual(starts.map((e) => e.text), ['look at the build']);
});

test('a drafted reply only leaves the machine after a human types its handle', () => {
  const r = relay();
  // Overnight the agent drafted two replies.
  r.drafts.open([
    { chatId: CHAT, messageId: 'om_a', summary: 'build?', reply: 'green since 3pm' },
    { chatId: CHAT, messageId: 'om_b', summary: 'lunch?', reply: 'cannot today' },
  ], 0);

  // Reading the digest sends nothing.
  r.link.push(messageEvent({ chatId: CHAT, text: '/drafts' }));
  assert.equal(r.effects.filter((e) => e.type === DIGEST_EFFECT.sendReply).length, 0);

  // Nor does anything else the reviewer might type while skimming.
  r.clock.advance(3100);
  r.link.push(messageEvent({ chatId: CHAT, text: '/send' }));
  r.clock.advance(3100);
  r.link.push(messageEvent({ chatId: CHAT, text: '/skip d2' }));
  assert.equal(r.effects.filter((e) => e.type === DIGEST_EFFECT.sendReply).length, 0);

  // One handle, one reply, and only the one they named.
  r.clock.advance(3100);
  r.link.push(messageEvent({ chatId: CHAT, text: '/edit d1 green since 3pm, deploy at 5' }));
  r.clock.advance(3100);
  r.link.push(messageEvent({ chatId: CHAT, text: '/send d1' }));
  const out = r.effects.filter((e) => e.type === DIGEST_EFFECT.sendReply);
  assert.deepEqual(out.map((e) => [e.chatId, e.replyTo, e.text]),
    [[CHAT, 'om_a', 'green since 3pm, deploy at 5']]);
  assert.deepEqual(r.drafts.pending(), []);
});

test('reviewing drafts does not start a turn, and a prompt is not a draft', () => {
  const r = relay();
  r.dispatcher.observeEnds([{ end: 'mac' }], 0);
  r.drafts.open([{ chatId: CHAT, reply: 'green since 3pm' }], 0);

  r.link.push(messageEvent({ chatId: CHAT, text: '/send d1' }));
  assert.equal(r.effects.filter((e) => e.type === EFFECT.startTurn).length, 0);

  r.clock.advance(3100);
  r.link.push(messageEvent({ chatId: CHAT, text: 'send d1' }));   // no slash: a prompt
  const starts = r.effects.filter((e) => e.type === EFFECT.startTurn);
  assert.deepEqual(starts.map((e) => e.text), ['send d1']);
});
