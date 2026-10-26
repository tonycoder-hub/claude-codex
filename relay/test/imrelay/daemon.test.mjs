// The daemon is the only part of this subsystem that owns a clock and does I/O,
// so it is also the only part whose bugs are invisible to the other tests. Every
// dependency is injected, which is what lets these run with no network, no
// credentials and no real time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InboundGate, IGNORED } from '../../src/imrelay/inbound.mjs';
import { Dispatcher, NOTICE, EFFECT } from '../../src/imrelay/dispatch.mjs';
import { DraftBook, DIGEST_NOTICE, DIGEST_EFFECT } from '../../src/imrelay/digest.mjs';
import { OPS, allowlistSink } from '../../src/imrelay/transport.mjs';
import {
  Relay, ORIGIN, harnessConnection,
  noticeText, draftNoticeText, draftListText,
} from '../../src/imrelay/daemon.mjs';
import { recordingSink, fakeClock, messageEvent } from './fakes.mjs';

const CHAT = 'oc_allowed';
const END = 'end-1';

/** An app-server client that records calls and can push notifications. */
function fakeClient({ results = {}, reject = [] } = {}) {
  const calls = [];
  const handlers = [];
  return {
    calls,
    of(method) { return calls.filter((c) => c.method === method); },
    on(method, handler) { handlers.push({ method, handler }); return () => {}; },
    notify(method, params) {
      for (const h of handlers) if (h.method === '*' || h.method === method) h.handler(params, method);
    },
    async call(method, params) {
      calls.push({ method, params });
      if (reject.includes(method)) throw new Error(`${method} refused`);
      const result = results[method];
      // A function result lets a test give two lanes two different thread
      // ids. With a static `th_1` for both, every routing assertion in this
      // file would pass by accident.
      return typeof result === 'function' ? result(params) : (result ?? {});
    },
  };
}

/** Everything composed, the way `bin/imrelay.mjs` composes it. */
function relay({
  chats = [CHAT], requireCommand = false, dedupeWindowMs = 600000,
  results = {}, reject = [], ends = [{ end: END, busy: false }],
  intercept = null,
} = {}) {
  const clock = fakeClock(0);
  let cards = 0;
  const inner = recordingSink({
    results: {
      [OPS.createCardEntity]: () => ({ code: 0, msg: 'success', data: { card_id: `c_${++cards}` } }),
      ...results,
    },
  });
  // Installed BEFORE the allow-list wraps it, so it holds however
  // `allowlistSink` captures its inner sink.
  if (intercept) {
    const real = inner.perform.bind(inner);
    inner.perform = (op) => intercept(op, real);
  }
  const sink = allowlistSink({ inner, chats });
  const gate = new InboundGate({ chats, requireCommand, dedupeWindowMs });
  const dispatcher = new Dispatcher();
  const drafts = new DraftBook({ chats });
  let threads = 0;
  let turns = 0;
  const client = fakeClient({
    results: {
      'thread/start': () => ({ threadId: `th_${++threads}` }),
      'turn/start': () => ({ turnId: `tn_${++turns}` }),
      ...results,
    },
    reject,
  });
  const link = harnessConnection();
  const log = [];
  const r = new Relay({
    gate, dispatcher, drafts, sink, client, connection: link,
    now: () => clock.now,
    fetchEnds: ends === null ? null : async () => ends,
    log: (line) => log.push(line),
  });
  return { relay: r, clock, inner, sink, gate, dispatcher, drafts, client, link, log };
}

/** Start, deliver one prompt, and let the turn be accepted. */
async function started(over = {}) {
  const h = await relay(over);
  await h.relay.start();
  await h.relay.tick(h.clock.now);   // observeEnds, so a lane is schedulable
  return h;
}

// -- the local ingress -------------------------------------------------------

test('harnessConnection satisfies the long-connection contract and refuses an async handler', async () => {
  const link = harnessConnection();
  for (const member of ['start', 'onEvent', 'onClose', 'close']) {
    assert.equal(typeof link[member], 'function', `${member} must be a function`);
  }
  assert.throws(() => link.deliver(messageEvent({})), /nothing is listening/);
  link.onEvent(() => undefined);
  assert.throws(() => link.deliver(messageEvent({})), /closed/);
  await link.start();
  assert.equal(link.deliver(messageEvent({})), undefined);

  const async_ = harnessConnection();
  async_.onEvent(() => Promise.resolve());
  await async_.start();
  assert.throws(() => async_.deliver(messageEvent({})), /must not await/);
});

test('closing the harness connection twice notifies once', async () => {
  const link = harnessConnection();
  let closes = 0;
  link.onEvent(() => undefined);   // `deliver` checks for a listener first
  link.onClose(() => { closes += 1; });
  await link.start();
  assert.equal(link.open, true);
  link.close();
  link.close();
  assert.equal(closes, 1);
  assert.equal(link.open, false);
  assert.throws(() => link.deliver(messageEvent({})), /closed/);
});

// -- phrasing ----------------------------------------------------------------

test('every dispatcher notice kind has phrasing of its own', () => {
  for (const kind of Object.values(NOTICE)) {
    const text = noticeText(kind, null);
    assert.equal(typeof text, 'string');
    assert.notEqual(text, '', `${kind} rendered empty`);
    assert.ok(!text.startsWith('['), `${kind} fell through to the unphrased fallback`);
  }
});

test('every draft notice kind has phrasing of its own', () => {
  for (const kind of Object.values(DIGEST_NOTICE)) {
    const text = draftNoticeText(kind, null);
    assert.ok(!text.startsWith('['), `${kind} fell through to the unphrased fallback`);
  }
});

test('an unknown notice kind is surfaced rather than dropped', () => {
  assert.equal(noticeText('invented-later', null), '[invented-later]');
  assert.equal(noticeText('invented-later', { n: 1 }), '[invented-later] {"n":1}');
  assert.equal(draftNoticeText('also-later', null), '[also-later]');
});

test('the take-over notice reports what it interrupted and dropped', () => {
  assert.match(noticeText(NOTICE.held, { interrupted: true, dropped: 2, already: false }), /已打断/);
  assert.match(noticeText(NOTICE.held, { interrupted: true, dropped: 2, already: false }), /2 条/);
  assert.match(noticeText(NOTICE.held, { already: true }), /本来就在你手上/);
  // Nothing interrupted, nothing dropped: no empty parenthesis.
  assert.ok(!noticeText(NOTICE.held, { interrupted: false, dropped: 0 }).includes('（'));
});

test('the finished notice distinguishes interrupted from failed from done', () => {
  assert.match(noticeText(NOTICE.finished, { status: 'interrupted' }), /已打断/);
  assert.match(noticeText(NOTICE.finished, { status: 'failed' }), /失败/);
  assert.match(noticeText(NOTICE.finished, { status: 'completed' }), /结束/);
  assert.match(noticeText(NOTICE.finished, null), /结束/);
});

test('the draft list is rendered by the daemon, since DraftBook has no view', () => {
  assert.match(draftListText([]), /没有待发的草稿/);
  assert.match(draftListText(null), /没有待发的草稿/);
  const long = 'x'.repeat(200);
  const text = draftListText([{ ref: 'd1', reply: long }, { ref: 'd2', reply: 'ok' }]);
  assert.match(text, /待发草稿 2 条/);
  assert.match(text, /d1/);
  assert.match(text, /d2/);
  assert.ok(!text.includes(long), 'a 200-char draft must be clipped in the list');
  assert.match(text, /\/send d1/);
});

// -- construction ------------------------------------------------------------

test('a relay refuses to exist without a clock, a sink or a client', () => {
  const parts = {
    gate: new InboundGate({ chats: [CHAT] }),
    dispatcher: new Dispatcher(),
    drafts: new DraftBook({ chats: [CHAT] }),
    sink: recordingSink(),
    client: fakeClient(),
    connection: harnessConnection(),
    now: () => 0,
  };
  assert.doesNotThrow(() => new Relay({ ...parts }));
  assert.throws(() => new Relay({ ...parts, now: undefined }), /now\(\) clock/);
  assert.throws(() => new Relay({ ...parts, now: 0 }), /now\(\) clock/);
  assert.throws(() => new Relay({ ...parts, sink: {} }), /needs a sink/);
  assert.throws(() => new Relay({ ...parts, client: {} }), /app-server client/);
  assert.throws(() => new Relay({ ...parts, gate: undefined }), /gate, a dispatcher/);
  assert.throws(() => new Relay({ ...parts, connection: { start() {}, onEvent() {} } }), /onClose|close/);
});

// -- the synchronous inbound half --------------------------------------------

test('the inbound handler returns undefined, never a promise', async () => {
  const h = await started();
  assert.equal(h.link.deliver(messageEvent({ chatId: CHAT, text: 'hi' })), undefined);
});

test('the gate is given the real clock, so its de-duplication window expires', async () => {
  const h = await started({ dedupeWindowMs: 1000 });
  const event = messageEvent({ chatId: CHAT, text: 'hi', eventId: 'ev_fixed' });

  h.link.deliver(event);
  await h.relay.drain(h.clock.now);
  assert.equal(h.client.of('turn/start').length, 1, 'the first delivery must run');

  // Re-pushed inside the window: the gate itself refuses it, and says why.
  h.link.deliver(event);
  assert.deepEqual(
    h.log.filter((l) => l.what === 'ignored').map((l) => l.reason),
    [IGNORED.duplicate],
  );

  // Past the window the gate forgets the id and accepts the envelope again,
  // which only happens if `accept` was handed a moving clock -- with `at`
  // defaulted to 0 the window never expires and only the 4096-entry cap
  // evicts. The turn still does not re-run, because the dispatcher keeps its
  // own `eventId` ledger with no time window at all; this test is about the
  // gate's clock, and the second layer is what makes a forgotten id safe.
  h.clock.advance(5000);
  await h.relay.tick(h.clock.now);
  h.link.deliver(event);
  await h.relay.drain(h.clock.now);
  assert.equal(
    h.log.filter((l) => l.what === 'ignored').length, 1,
    'past the window the gate must not call it a duplicate any more',
  );
  assert.equal(h.client.of('turn/start').length, 1, 'and the dispatcher still refuses to re-run it');
});

test('an ignored event queues nothing and starts no turn', async () => {
  const h = await started();
  h.link.deliver(messageEvent({ chatId: 'oc_elsewhere', text: 'hi' }));
  await h.relay.drain(h.clock.now);
  assert.equal(h.client.calls.length, 0);
  assert.equal(h.inner.ops.length, 0);
  assert.equal(h.relay.snapshot().queued, 0);
  assert.ok(h.log.some((l) => l.what === 'ignored'));
});

// -- provenance --------------------------------------------------------------

test("both subsystems emit type 'notice' and each is phrased by its own table", async () => {
  // The collision is real: these two constants are the same string.
  assert.equal(EFFECT.notice, DIGEST_EFFECT.notice);

  const h = await started();
  // A dispatcher notice: /release on a lane nobody holds.
  h.link.deliver(messageEvent({ chatId: CHAT, text: '/release' }));
  await h.relay.drain(h.clock.now);
  const sent = h.inner.of(OPS.sendMessage).map((o) => o.content.text);
  assert.ok(sent.some((t) => t.includes('没有被接管')), `dispatcher phrasing missing: ${sent}`);

  // A draft notice: /send for a draft that does not exist.
  h.link.deliver(messageEvent({ chatId: CHAT, text: '/send d9' }));
  await h.relay.drain(h.clock.now);
  const after = h.inner.of(OPS.sendMessage).map((o) => o.content.text);
  assert.ok(after.some((t) => t.includes('没有这个编号')), `draft phrasing missing: ${after}`);
});

test('a notice for a lane whose chat is unknown is recorded, not guessed', async () => {
  // An earlier version of this test built a notice for an unknown lane and
  // then never routed it, so the only thing it actually asserted was the
  // known-lane path. Mutating `#sayNotice` to fall back to the lane name as
  // a chat id left the whole suite green.
  //
  // `openApproval` is the honest seam: the dispatcher holds approval state
  // and `tick` emits a reminder naming that lane, which is exactly what
  // happens when dispatcher state outlives the relay's in-memory chat map.
  const h = await started();
  h.dispatcher.openApproval({ requestId: 'rq_1', lane: 'lane_never_seen' }, 0);
  const before = h.inner.of(OPS.sendMessage).length;

  h.clock.advance(120001);   // past approvalReminderMs
  await h.relay.tick(h.clock.now);

  assert.equal(
    h.inner.of(OPS.sendMessage).length, before,
    'nothing may be sent to a chat the relay had to invent',
  );
  assert.equal(h.relay.failures.length, 1, 'and the drop is recorded, not silent');
  const failure = h.relay.failures.at(-1);
  assert.match(failure.error, /lane_never_seen/, 'the record must name the lane');
  assert.match(failure.error, /no chat known/);
});

test('a known lane still gets its notice, so the refusal is not just a dead path', async () => {
  const h = await started();
  const before = h.inner.of(OPS.sendMessage).length;
  h.link.deliver(messageEvent({ chatId: CHAT, text: '/release' }));
  await h.relay.drain(h.clock.now);
  assert.ok(h.inner.of(OPS.sendMessage).length > before, 'a known lane still gets its notice');
  assert.deepEqual(h.relay.failures, []);
});

test('a producer that returns the wrong shape is reported, not swallowed', async () => {
  // This is the shape of a real bug: every effect-producing method in this
  // subsystem returns `{ effects }`, and four call sites wrapped that in a
  // second `{ effects }`. `#enqueue` saw a non-array and silently returned,
  // so the relay stopped telling anyone a turn had failed -- and the whole
  // suite stayed green, because nothing asserted the non-array branch.
  const h = await started();
  const real = h.dispatcher.submit.bind(h.dispatcher);
  h.dispatcher.submit = (intent, at) => ({ effects: real(intent, at) });   // double-wrapped

  h.link.deliver(messageEvent({ chatId: CHAT, text: 'go' }));
  await h.relay.drain(h.clock.now);

  assert.equal(h.relay.snapshot().queued, 0, 'nothing queueable came out of it');
  assert.equal(h.relay.failures.length, 1, 'a shape the queue cannot take must be recorded');
  assert.match(h.relay.failures.at(-1).error, /not an array of effects/);
  assert.match(h.relay.failures.at(-1).where, /enqueue/);
});

// -- the turn lifecycle ------------------------------------------------------

test('a first prompt starts a thread, starts a turn, and feeds the ids back', async () => {
  const h = await started();
  h.link.deliver(messageEvent({ chatId: CHAT, text: 'look at the relay' }));
  await h.relay.drain(h.clock.now);

  assert.equal(h.client.of('thread/start').length, 1);
  assert.equal(h.client.of('thread/resume').length, 0);
  assert.equal(h.client.of('turn/start').length, 1);
  assert.equal(h.client.of('turn/start')[0].params.threadId, 'th_1');
  assert.equal(h.client.of('turn/start')[0].params.input, 'look at the relay');

  // turnAccepted is what stops the lane being scheduled twice.
  const lane = h.dispatcher.snapshot().lanes.find((l) => l.lane === CHAT);
  assert.equal(lane.turnId, 'tn_1');
  assert.equal(lane.threadId, 'th_1');
  assert.equal(h.relay.snapshot().lanes.length, 1);
});

test('a second prompt in the same lane resumes rather than starting a thread', async () => {
  const h = await started();
  h.link.deliver(messageEvent({ chatId: CHAT, text: 'first' }));
  await h.relay.drain(h.clock.now);
  h.client.notify('turn/completed', { threadId: 'th_1', turnId: 'tn_1' });
  h.dispatcher.turnFinished({ lane: CHAT, status: 'completed' }, h.clock.now);

  h.clock.advance(100);
  h.link.deliver(messageEvent({ chatId: CHAT, text: 'second' }));
  await h.relay.drain(h.clock.now);

  assert.equal(h.client.of('thread/start').length, 1, 'the thread is started once');
  assert.equal(h.client.of('thread/resume').length, 1, 'the second turn resumes it');
  assert.equal(h.client.of('turn/start').length, 2);
});

test('a turn the app-server refuses is reported as finished-failed, not left running', async () => {
  const h = await started({ reject: ['turn/start'] });
  h.link.deliver(messageEvent({ chatId: CHAT, text: 'go' }));
  await h.relay.drain(h.clock.now);

  assert.equal(h.relay.failures.length, 1);
  assert.match(h.relay.failures[0].error, /turn\/start refused/);
  const lane = h.dispatcher.snapshot().lanes.find((l) => l.lane === CHAT);
  assert.equal(lane.turnId, null, 'the lane must not be left holding a turn');
  const texts = h.inner.of(OPS.sendMessage).map((o) => o.content.text);
  assert.ok(texts.some((t) => t.includes('失败')), `the human must be told: ${texts}`);
});

// -- the card loop -----------------------------------------------------------

test('the first flush creates the entity, allowlists it, posts it, then streams', async () => {
  const h = await started();
  h.link.deliver(messageEvent({ chatId: CHAT, text: 'go' }));
  await h.relay.drain(h.clock.now);
  h.client.notify('item/started', { threadId: 'th_1', itemId: 'it_1', kind: 'agentMessage' });
  h.client.notify('item/agentMessage/delta', { itemId: 'it_1', delta: 'hello ' });
  await h.relay.flushCards(h.clock.now);

  const kinds = h.inner.ops.map((o) => o.op);
  assert.deepEqual(
    kinds.filter((k) => k !== OPS.sendMessage),
    [OPS.createCardEntity, OPS.streamText],
  );
  const create = h.inner.of(OPS.createCardEntity)[0];
  assert.equal(create.forChat, CHAT);
  const posted = h.inner.of(OPS.sendMessage).find((o) => o.msgType === 'interactive');
  assert.equal(posted.content.data.card_id, 'c_1', 'the card must actually be posted into the chat');
  assert.equal(h.inner.of(OPS.streamText)[0].sequence, 1);
  assert.match(h.inner.of(OPS.streamText)[0].content, /hello/, 'the delta must reach the card');
});

test('the card shell is rewritten only when it actually changes', async () => {
  const h = await started();
  h.link.deliver(messageEvent({ chatId: CHAT, text: 'go' }));
  await h.relay.drain(h.clock.now);
  h.client.notify('item/started', { threadId: 'th_1', itemId: 'it_1', kind: 'agentMessage' });
  h.client.notify('item/agentMessage/delta', { itemId: 'it_1', delta: 'a' });
  await h.relay.flushCards(h.clock.now);
  assert.equal(h.inner.of(OPS.updateCardEntity).length, 0, 'the create wrote the shell already');

  // More text, same shell: the cheap path only.
  // Not `1000 / cardKitPerCardPerSecond`: the pacer spreads the app-wide
  // allowance across concurrent cards, so its floor is the only honest
  // number here and 101ms is below it.
  h.clock.advance(h.relay.minIntervalMs + 1);
  h.client.notify('item/agentMessage/delta', { itemId: 'it_1', delta: 'b' });
  await h.relay.flushCards(h.clock.now);
  assert.equal(h.inner.of(OPS.updateCardEntity).length, 0, 'text-only deltas must not rewrite the shell');
  assert.equal(h.inner.of(OPS.streamText).length, 2);

  // A terminal turn changes the badge, which lives in the shell.
  h.clock.advance(1000);
  h.client.notify('turn/completed', { threadId: 'th_1', turnId: 'tn_1', status: 'completed' });
  await h.relay.flushCards(h.clock.now);
  assert.equal(h.inner.of(OPS.updateCardEntity).length, 1, 'a finished turn must repaint the shell');
});

test('a finished turn is written through the coalescing interval, not after it', async () => {
  // `urgent` is the whole reason the pacer takes a flag at all, and nothing
  // asserted it: replacing `urgent: projection.terminal` with `urgent: false`
  // left the suite green, because every other test advances the clock past
  // the interval before looking. The interval is the point -- a person who
  // has just been told the turn ended should not wait out a coalescing
  // window to see it.
  const h = await started();
  h.link.deliver(messageEvent({ chatId: CHAT, text: 'go' }));
  await h.relay.drain(h.clock.now);
  h.client.notify('item/started', { threadId: 'th_1', itemId: 'it_1', kind: 'agentMessage' });
  h.client.notify('item/agentMessage/delta', { itemId: 'it_1', delta: 'a' });
  await h.relay.flushCards(h.clock.now);   // this is what sets lastFlushAt
  const before = h.inner.ops.length;

  // Well inside the interval. An ordinary delta has to be coalesced here,
  // or the second half of this test proves nothing.
  h.clock.advance(Math.max(1, Math.floor(h.relay.minIntervalMs / 3)));
  h.client.notify('item/agentMessage/delta', { itemId: 'it_1', delta: 'b' });
  await h.relay.flushCards(h.clock.now);
  assert.equal(h.inner.ops.length, before, 'an ordinary delta must be coalesced');

  h.client.notify('turn/completed', { threadId: 'th_1', turnId: 'tn_1', status: 'completed' });
  await h.relay.flushCards(h.clock.now);
  assert.ok(h.inner.ops.length > before, 'a finished turn must not wait out the interval');
});

test('the item cap forgets the oldest item, not every item', async () => {
  // The eviction loop deletes one key and breaks. Replacing it with a
  // `.clear()` also keeps the map under the cap, and no test could tell:
  // nothing here had ever pushed past 4096 items. The difference is that
  // `clear()` throws away the entry that was added a microsecond ago, so
  // the very next delta for it is unroutable.
  const h = await started({
    chats: [CHAT, 'oc_second'],
    ends: [{ end: END, busy: false }, { end: 'end-2', busy: false }],
  });
  h.link.deliver(messageEvent({ chatId: CHAT, text: 'one' }));
  h.link.deliver(messageEvent({ chatId: 'oc_second', messageId: 'om_2', text: 'two' }));
  await h.relay.drain(h.clock.now);
  assert.equal(h.relay.snapshot().lanes.length, 2, 'two open turns, so a miss is a failure not a fallback');

  // A method the projection has no opinion about: ownership is learned
  // before `apply()` is consulted, so this fills the map without building
  // four thousand item shells to do it.
  for (let i = 0; i < 4096; i++) {
    h.client.notify('item/ignoredByTheProjection', { threadId: 'th_1', itemId: `fill_${i}` });
  }
  h.client.notify('item/ignoredByTheProjection', { threadId: 'th_1', itemId: 'newest' });
  const before = h.relay.failures.length;

  h.client.notify('item/agentMessage/delta', { itemId: 'newest', delta: 'X' });
  assert.equal(h.relay.failures.length, before, 'the newest item must survive the eviction');
});

test('a notification naming neither a thread nor a known item is refused with two turns open', async () => {
  // Two ends, or `maxConcurrentPerEnd: 1` queues the second lane and there is
  // only ever one open card to be ambiguous about.
  const h = await started({
    chats: [CHAT, 'oc_second'],
    ends: [{ end: END, busy: false }, { end: 'end-2', busy: false }],
  });
  h.link.deliver(messageEvent({ chatId: CHAT, text: 'one' }));
  await h.relay.drain(h.clock.now);
  h.clock.advance(10);
  h.link.deliver(messageEvent({ chatId: 'oc_second', messageId: 'om_2', text: 'two' }));
  await h.relay.drain(h.clock.now);
  assert.equal(h.relay.snapshot().lanes.length, 2, 'two cards must be open for this to mean anything');

  const before = h.relay.failures.length;
  h.client.notify('turn/completed', { status: 'completed' });
  assert.equal(h.relay.failures.length, before + 1, 'an unaddressed notification must be refused, not broadcast');
  assert.match(h.relay.failures.at(-1).error, /names neither a thread nor a known item and 2 turns are open/);
});

test('item ownership is learned from the nested spelling too', async () => {
  // Found by running bin/imrelay.mjs, not by this file. The daemon read the
  // flat `params.itemId` while the projection accepted `params.item.id` as
  // well, so a server using the nested spelling taught the daemon nothing --
  // and the single-open-turn fallback hid that completely until a second
  // lane opened, at which point every delta was refused. Two readers for
  // one field; both are now `itemIdOf` and `threadIdOf` from projection.mjs.
  const h = await started({
    chats: [CHAT, 'oc_second'],
    ends: [{ end: END, busy: false }, { end: 'end-2', busy: false }],
  });
  h.link.deliver(messageEvent({ chatId: CHAT, text: 'one' }));
  h.link.deliver(messageEvent({ chatId: 'oc_second', messageId: 'om_2', text: 'two' }));
  await h.relay.drain(h.clock.now);
  assert.equal(h.relay.snapshot().lanes.length, 2);

  // Nested everywhere: `thread.id` and `item.id`, not `threadId`/`itemId`.
  h.client.notify('item/started', { thread: { id: 'th_1' }, item: { id: 'it_one', itemType: 'agentMessage' } });
  h.client.notify('item/started', { thread: { id: 'th_2' }, item: { id: 'it_two', itemType: 'agentMessage' } });
  await h.relay.flushCards(h.clock.now);
  h.clock.advance(1000);
  h.client.notify('item/agentMessage/delta', { itemId: 'it_one', delta: 'NESTED-ONE' });
  h.client.notify('item/agentMessage/delta', { itemId: 'it_two', delta: 'NESTED-TWO' });
  await h.relay.flushCards(h.clock.now);

  assert.deepEqual(h.relay.failures, [], 'the nested spelling must teach ownership');
  const byCard = new Map();
  for (const op of h.inner.of(OPS.streamText)) byCard.set(op.cardId, op.content);
  const [first, second] = h.relay.snapshot().lanes.map((l) => l.cardId);
  assert.match(byCard.get(first), /NESTED-ONE/);
  assert.doesNotMatch(byCard.get(first), /NESTED-TWO/);
  assert.match(byCard.get(second), /NESTED-TWO/);
});

test('a thread-less delta reaches its own card and only its own card', async () => {
  // This is the real streaming shape: `{itemId, delta}`, no thread id at all.
  // Routing it needs ownership learned from the lifecycle notification that
  // named both ids, and getting it wrong paints one person's conversation
  // onto another person's card.
  const h = await started({
    chats: [CHAT, 'oc_second'],
    ends: [{ end: END, busy: false }, { end: 'end-2', busy: false }],
  });
  h.link.deliver(messageEvent({ chatId: CHAT, text: 'one' }));
  h.link.deliver(messageEvent({ chatId: 'oc_second', messageId: 'om_2', text: 'two' }));
  await h.relay.drain(h.clock.now);
  const threads = h.relay.snapshot().lanes.map((l) => l.lane);
  assert.equal(threads.length, 2);

  h.client.notify('item/started', { threadId: 'th_1', itemId: 'it_one', kind: 'agentMessage' });
  h.client.notify('item/started', { threadId: 'th_2', itemId: 'it_two', kind: 'agentMessage' });
  await h.relay.flushCards(h.clock.now);
  const cards = h.relay.snapshot().lanes.map((l) => l.cardId);
  assert.equal(new Set(cards).size, 2, 'two distinct cards, or this proves nothing');

  h.clock.advance(1000);
  h.client.notify('item/agentMessage/delta', { itemId: 'it_one', delta: 'ONLY-ONE' });
  h.client.notify('item/agentMessage/delta', { itemId: 'it_two', delta: 'ONLY-TWO' });
  await h.relay.flushCards(h.clock.now);
  assert.deepEqual(h.relay.failures, [], 'a learnable delta must not be refused');

  const byCard = new Map();
  for (const op of h.inner.of(OPS.streamText)) byCard.set(op.cardId, op.content);
  const [first, second] = cards;
  assert.match(byCard.get(first), /ONLY-ONE/);
  assert.doesNotMatch(byCard.get(first), /ONLY-TWO/, 'cross-talk between lanes');
  assert.match(byCard.get(second), /ONLY-TWO/);
  assert.doesNotMatch(byCard.get(second), /ONLY-ONE/, 'cross-talk between lanes');
});

test('a rate-limited card write backs the pacer off instead of throwing', async () => {
  let thrown = 0;
  const h = await started({
    intercept: (op, real) => {
      if (op.op === OPS.createCardEntity && thrown === 0) {
        thrown += 1;
        const err = new Error('too many requests');
        err.status = 429;
        throw err;
      }
      return real(op);
    },
  });
  h.link.deliver(messageEvent({ chatId: CHAT, text: 'go' }));
  await h.relay.drain(h.clock.now);
  h.client.notify('item/started', { threadId: 'th_1', itemId: 'it_1', kind: 'agentMessage' });
  h.client.notify('item/agentMessage/delta', { itemId: 'it_1', delta: 'x' });

  await h.relay.flushCards(h.clock.now);
  assert.equal(thrown, 1, 'the write must actually have been attempted');
  assert.equal(h.relay.failures.length, 1, 'the failure is recorded');
  assert.equal(h.inner.of(OPS.streamText).length, 0, 'there is no card to stream onto yet');

  // The revision is still pending, so the next poll retries it and the text
  // that arrived during the back-off is not lost.
  h.clock.advance(2000);
  await h.relay.flushCards(h.clock.now);
  assert.equal(h.inner.of(OPS.createCardEntity).length, 1, 'the retry succeeds');
  assert.match(h.inner.of(OPS.streamText).at(-1).content, /x/, 'and the held text lands');
});

test('drainCards keeps polling until the last delta has landed', async () => {
  const h = await started();
  h.link.deliver(messageEvent({ chatId: CHAT, text: 'go' }));
  await h.relay.drain(h.clock.now);
  h.client.notify('item/started', { threadId: 'th_1', itemId: 'it_1', kind: 'agentMessage' });
  for (let i = 0; i < 5; i += 1) {
    h.client.notify('item/agentMessage/delta', { itemId: 'it_1', delta: `part ${i} ` });
  }
  await h.relay.drainCards(h.clock.now);
  assert.equal(h.relay.snapshot().lanes[0].pending, null, 'nothing may be left pending');
  const last = h.inner.of(OPS.streamText).at(-1);
  assert.match(last.content, /part 4/, 'the final delta must be on the card');
});

// -- drafts ------------------------------------------------------------------

test('/drafts lists what is pending without any DraftBook view method', async () => {
  const h = await started();
  assert.equal(typeof h.drafts.list, 'undefined', 'this test exists because there is no list()');
  h.drafts.open([
    { chatId: CHAT, messageId: 'om_a', from: '张三', incoming: '方案什么时候给我', reply: '明天上午发你' },
  ], h.clock.now);
  h.link.deliver(messageEvent({ chatId: CHAT, text: '/drafts' }));
  await h.relay.drain(h.clock.now);
  const text = h.inner.of(OPS.sendMessage).map((o) => o.content.text).join('\n');
  assert.match(text, /待发草稿 1 条/);
  assert.match(text, /明天上午发你/);
});

test('/send puts the draft in front of the person, as a reply, exactly once', async () => {
  const h = await started();
  h.drafts.open([
    { chatId: CHAT, messageId: 'om_a', from: '张三', incoming: '方案什么时候给我', reply: '明天上午发你' },
  ], h.clock.now);
  h.link.deliver(messageEvent({ chatId: CHAT, text: '/send d1' }));
  await h.relay.drain(h.clock.now);

  const replies = h.inner.of(OPS.sendMessage).filter((o) => o.replyTo === 'om_a');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].content.text, '明天上午发你');
  assert.equal(replies[0].uuid, 'd1', 'the handle is the idempotency key');

  // Twice is the failure this whole design exists to prevent.
  h.clock.advance(10);
  h.link.deliver(messageEvent({ chatId: CHAT, messageId: 'om_b', text: '/send d1' }));
  await h.relay.drain(h.clock.now);
  assert.equal(h.inner.of(OPS.sendMessage).filter((o) => o.replyTo === 'om_a').length, 1);
});

// -- bookkeeping -------------------------------------------------------------

test('no notification method is filtered before the projection sees it', async () => {
  // There used to be an allow-list here, naming the methods in
  // `projection.apply()`'s switch. It could not be right: the streaming path
  // is matched by `/^item\\/([A-Za-z0-9_]+)\\/delta$/` over an open set of item
  // kinds, so enumerating it drops every delta and leaves a card showing
  // item shells with no text. An item kind nobody has heard of must still
  // reach the projection and still fold.
  const h = await started();
  h.link.deliver(messageEvent({ chatId: CHAT, text: 'go' }));
  await h.relay.drain(h.clock.now);
  h.client.notify('item/started', { threadId: 'th_1', itemId: 'it_1', kind: 'somethingNewEntirely' });
  h.client.notify('item/somethingNewEntirely/delta', { itemId: 'it_1', delta: 'future text' });
  await h.relay.flushCards(h.clock.now);
  assert.match(
    h.inner.of(OPS.streamText).at(-1).content, /future text/,
    'an item kind this file has never heard of must still reach the card',
  );
  assert.deepEqual(h.relay.failures, []);
});

test('the two effect provenances are named, since both subsystems say "notice"', () => {
  assert.equal(ORIGIN.dispatcher, 'dispatcher');
  assert.equal(ORIGIN.drafts, 'drafts');
});

test('a notification nobody folds is ignored without touching a pacer', async () => {
  const h = await started();
  h.link.deliver(messageEvent({ chatId: CHAT, text: 'go' }));
  await h.relay.drain(h.clock.now);
  const before = h.relay.snapshot().lanes[0].revision;
  h.client.notify('thread/status/changed', { threadId: 'th_1', status: 'idle' });
  assert.equal(h.relay.snapshot().lanes[0].revision, before);
  assert.equal(h.relay.failures.length, 0);
});

test('stop closes the connection and the relay stops reporting itself as running', async () => {
  const h = await started();
  assert.equal(h.relay.running, true);
  await h.relay.stop();
  assert.equal(h.relay.running, false);
  assert.equal(h.link.open, false);
});
