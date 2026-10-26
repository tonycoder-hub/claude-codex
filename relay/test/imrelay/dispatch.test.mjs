import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Dispatcher, EFFECT, NOTICE, OUTCOME, ApprovalAbandoned,
} from '../../src/imrelay/dispatch.mjs';
import { APPROVAL_DECISIONS } from '../../src/appserver/client.mjs';

const COMMAND_APPROVAL = 'item/commandExecution/requestApproval';

let eventSeq = 0;
function prompt({ lane = 'oc_1', text = 'do it', endId = null, freshThread = false } = {}) {
  eventSeq += 1;
  return { lane, chatId: lane, eventId: `ev_${eventSeq}`, text, endId, freshThread, messageId: null };
}

function of(effects, type) {
  return effects.filter((effect) => effect.type === type);
}

function notices(effects) {
  return of(effects, EFFECT.notice).map((effect) => effect.kind);
}

/** Open an approval and swallow its rejection, for tests not asserting on it. */
function openQuietly(dispatcher, init, at = 0) {
  const held = dispatcher.openApproval({ method: COMMAND_APPROVAL, params: {}, ...init }, at);
  held.promise.catch(() => {});
  return held;
}

// -- the end roster ----------------------------------------------------------

test('with no fleet at all a prompt is refused rather than queued silently', () => {
  const dispatcher = new Dispatcher();
  const { outcome, effects } = dispatcher.submit(prompt(), 0);
  assert.equal(outcome, OUTCOME.noEnd);
  assert.deepEqual(notices(effects), [NOTICE.noEnds]);
});

test('an end appearing lets a prompt run immediately', () => {
  const dispatcher = new Dispatcher();
  dispatcher.observeEnds([{ end: 'e1' }], 0);
  const { outcome, effects } = dispatcher.submit(prompt({ text: 'build' }), 10);

  assert.equal(outcome, OUTCOME.running);
  const [start] = of(effects, EFFECT.startTurn);
  assert.equal(start.endId, 'e1');
  assert.equal(start.text, 'build');
  assert.equal(start.threadId, null, 'null is the instruction to thread/start first');
  assert.equal(start.lane, 'oc_1');
});

test('an end that is busy with work we did not start is left alone', () => {
  const dispatcher = new Dispatcher();
  dispatcher.observeEnds([{ end: 'e1', busy: true }], 0);
  assert.deepEqual(dispatcher.schedulableEnds(), []);

  const { outcome, effects } = dispatcher.submit(prompt(), 0);
  assert.notEqual(outcome, OUTCOME.running);
  assert.deepEqual(of(effects, EFFECT.startTurn), []);

  // Somebody finished at the desktop; the queued prompt goes straight out.
  const freed = dispatcher.observeEnds([{ end: 'e1', busy: false }], 100);
  assert.equal(of(freed.effects, EFFECT.startTurn).length, 1);
});

test('observeEnds refuses anything that is not a roster', () => {
  assert.throws(() => new Dispatcher().observeEnds(null), TypeError);
});

// -- one turn per lane -------------------------------------------------------

test('a second prompt in the same lane queues behind the first', () => {
  const dispatcher = new Dispatcher();
  dispatcher.observeEnds([{ end: 'e1' }], 0);
  dispatcher.submit(prompt({ text: 'first' }), 0);

  const second = dispatcher.submit(prompt({ text: 'second' }), 1);
  assert.equal(second.outcome, OUTCOME.queued);
  assert.deepEqual(of(second.effects, EFFECT.startTurn), []);
  assert.deepEqual(notices(second.effects), [NOTICE.queued]);
  assert.equal(dispatcher.snapshot().lanes[0].queued, 1);
});

test('finishing a turn releases the queue', () => {
  const dispatcher = new Dispatcher();
  dispatcher.observeEnds([{ end: 'e1' }], 0);
  dispatcher.submit(prompt({ text: 'first' }), 0);
  dispatcher.submit(prompt({ text: 'second' }), 1);

  const { effects } = dispatcher.turnFinished({ lane: 'oc_1', status: 'completed' }, 50);
  assert.deepEqual(notices(effects), [NOTICE.finished]);
  const [start] = of(effects, EFFECT.startTurn);
  assert.equal(start.text, 'second');
});

test('a full queue is refused rather than growing without bound', () => {
  const dispatcher = new Dispatcher({ maxQueueDepth: 2 });
  dispatcher.observeEnds([{ end: 'e1' }], 0);
  dispatcher.submit(prompt({ text: 'running' }), 0);
  dispatcher.submit(prompt({ text: 'q1' }), 1);
  dispatcher.submit(prompt({ text: 'q2' }), 2);

  const rejected = dispatcher.submit(prompt({ text: 'q3' }), 3);
  assert.equal(rejected.outcome, OUTCOME.rejected);
  assert.deepEqual(notices(rejected.effects), [NOTICE.queueFull]);
});

test('a repeated event id cannot be charged twice', () => {
  const dispatcher = new Dispatcher();
  dispatcher.observeEnds([{ end: 'e1' }], 0);
  const intent = prompt({ text: 'once' });
  assert.equal(dispatcher.submit(intent, 0).outcome, OUTCOME.running);
  const again = dispatcher.submit(intent, 1);
  assert.equal(again.outcome, OUTCOME.duplicate);
  assert.deepEqual(again.effects, []);
});

test('an intent with no lane is a programming error, not a silent drop', () => {
  assert.throws(() => new Dispatcher().submit({ text: 'x' }), TypeError);
});

// -- fairness ----------------------------------------------------------------

test('lanes waiting for the same end are served oldest message first', () => {
  const dispatcher = new Dispatcher();
  dispatcher.observeEnds([{ end: 'e1' }], 0);
  dispatcher.submit(prompt({ lane: 'a', text: 'occupies the end' }), 0);
  dispatcher.submit(prompt({ lane: 'b', text: 'arrived second' }), 20);
  dispatcher.submit(prompt({ lane: 'c', text: 'arrived first' }), 10);

  const { effects } = dispatcher.turnFinished({ lane: 'a' }, 100);
  const started = of(effects, EFFECT.startTurn);
  assert.equal(started.length, 1, 'only one may run on a single end');
  assert.equal(started[0].text, 'arrived first');

  const next = dispatcher.turnFinished({ lane: 'c' }, 200);
  assert.equal(of(next.effects, EFFECT.startTurn)[0].text, 'arrived second');
});

test('two ends run two lanes at once', () => {
  const dispatcher = new Dispatcher();
  dispatcher.observeEnds([{ end: 'e1' }, { end: 'e2' }], 0);
  const first = dispatcher.submit(prompt({ lane: 'a' }), 0);
  const second = dispatcher.submit(prompt({ lane: 'b' }), 1);

  assert.equal(first.outcome, OUTCOME.running);
  assert.equal(second.outcome, OUTCOME.running);
  const ends = [
    of(first.effects, EFFECT.startTurn)[0].endId,
    of(second.effects, EFFECT.startTurn)[0].endId,
  ];
  assert.deepEqual([...ends].sort(), ['e1', 'e2'], 'the least-loaded end is picked');
});

// -- pinning -----------------------------------------------------------------

test('a lane pinned to an offline end waits instead of silently losing its history', () => {
  const dispatcher = new Dispatcher();
  dispatcher.observeEnds([{ end: 'e1' }], 0);
  dispatcher.submit(prompt({ text: 'first' }), 0);
  dispatcher.turnAccepted({ lane: 'oc_1', threadId: 'th_1', turnId: 'tu_1' }, 1);
  dispatcher.turnFinished({ lane: 'oc_1' }, 2);

  // e1 goes away and a completely free e2 appears.
  dispatcher.observeEnds([{ end: 'e2' }], 10);
  const { outcome, effects } = dispatcher.submit(prompt({ text: 'carry on' }), 20);

  assert.equal(outcome, OUTCOME.queued);
  assert.deepEqual(notices(effects), [NOTICE.endOffline]);
  assert.deepEqual(of(effects, EFFECT.startTurn), [], 'thread/resume on e2 could not find the thread');
  assert.equal(dispatcher.snapshot().lanes[0].threadId, 'th_1', 'the binding survives');
});

test('an end vanishing mid-turn orphans the turn instead of leaving it running forever', () => {
  const dispatcher = new Dispatcher();
  dispatcher.observeEnds([{ end: 'e1' }], 0);
  dispatcher.submit(prompt(), 0);
  dispatcher.turnAccepted({ lane: 'oc_1', threadId: 'th_1', turnId: 'tu_1' }, 1);

  const { effects } = dispatcher.observeEnds([], 5);
  const [orphan] = of(effects, EFFECT.orphaned);
  assert.equal(orphan.lane, 'oc_1');
  assert.equal(orphan.endId, 'e1');
  assert.equal(orphan.turnId, 'tu_1');
  assert.equal(dispatcher.snapshot().lanes[0].running, null);
});

test('moving a lane to another end is said out loud and costs the thread', () => {
  const dispatcher = new Dispatcher();
  dispatcher.observeEnds([{ end: 'e1' }, { end: 'e2' }], 0);
  dispatcher.submit(prompt({ text: 'first' }), 0);
  dispatcher.turnAccepted({ lane: 'oc_1', threadId: 'th_1', turnId: 'tu_1' }, 1);
  dispatcher.turnFinished({ lane: 'oc_1' }, 2);

  const { effects } = dispatcher.submit(prompt({ text: 'move me', endId: 'e2' }), 10);
  const [rehome] = of(effects, EFFECT.notice).filter((effect) => effect.kind === NOTICE.rehomed);
  assert.deepEqual(rehome.detail, { from: 'e1', to: 'e2' });
  assert.equal(of(effects, EFFECT.startTurn)[0].threadId, null, 'context is lost, and the card says so');
});

test('a fresh-thread request drops the binding but keeps the end', () => {
  const dispatcher = new Dispatcher();
  dispatcher.observeEnds([{ end: 'e1' }], 0);
  dispatcher.submit(prompt(), 0);
  dispatcher.turnAccepted({ lane: 'oc_1', threadId: 'th_1', turnId: 'tu_1' }, 1);
  dispatcher.turnFinished({ lane: 'oc_1' }, 2);

  const { effects } = dispatcher.submit(prompt({ freshThread: true }), 10);
  const [start] = of(effects, EFFECT.startTurn);
  assert.equal(start.threadId, null);
  assert.equal(start.endId, 'e1');
});

// -- interrupts --------------------------------------------------------------

test('an interrupt names the turn the app-server needs', () => {
  const dispatcher = new Dispatcher();
  dispatcher.observeEnds([{ end: 'e1' }], 0);
  dispatcher.submit(prompt(), 0);
  dispatcher.turnAccepted({ lane: 'oc_1', threadId: 'th_1', turnId: 'tu_1' }, 1);

  const { effects } = dispatcher.interrupt({ lane: 'oc_1' }, 5);
  const [stop] = of(effects, EFFECT.interruptTurn);
  assert.equal(stop.threadId, 'th_1');
  assert.equal(stop.turnId, 'tu_1');
});

test('an interrupt can be addressed by turn id, as a card button does', () => {
  const dispatcher = new Dispatcher();
  dispatcher.observeEnds([{ end: 'e1' }], 0);
  dispatcher.submit(prompt(), 0);
  dispatcher.turnAccepted({ lane: 'oc_1', threadId: 'th_1', turnId: 'tu_1' }, 1);
  const { effects } = dispatcher.interrupt({ turnId: 'tu_1' }, 5);
  assert.equal(of(effects, EFFECT.interruptTurn).length, 1);
});

test('interrupting nothing says so instead of failing', () => {
  const dispatcher = new Dispatcher();
  const { outcome, effects } = dispatcher.interrupt({ lane: 'oc_1' }, 0);
  assert.equal(outcome, OUTCOME.rejected);
  assert.deepEqual(notices(effects), [NOTICE.interruptNothing]);
});

// -- approvals ---------------------------------------------------------------

test('an approval is held open until a human answers it', async () => {
  const dispatcher = new Dispatcher();
  const { promise } = dispatcher.openApproval({
    requestId: 'req-1', lane: 'oc_1', method: COMMAND_APPROVAL, params: { command: 'rm -rf /' },
  }, 0);

  assert.equal(dispatcher.pendingApprovals('oc_1').length, 1);
  const answered = dispatcher.answerApproval({ requestId: 'req-1', decision: 'accept' }, 10);
  assert.equal(answered.outcome, OUTCOME.running);
  assert.equal(await promise, 'accept');
  assert.equal(dispatcher.pendingApprovals().length, 0);
});

test('an approval needs the server request id', () => {
  assert.throws(() => new Dispatcher().openApproval({ lane: 'oc_1' }), TypeError);
});

test('a re-delivered approval request gets the same promise, not a second one', async () => {
  const dispatcher = new Dispatcher();
  const first = dispatcher.openApproval({ requestId: 'req-1', lane: 'oc_1', method: COMMAND_APPROVAL }, 0);
  const second = dispatcher.openApproval({ requestId: 'req-1', lane: 'oc_1', method: COMMAND_APPROVAL }, 1);
  assert.equal(first.promise, second.promise, 'two promises for one id leaks one of them');
  dispatcher.answerApproval({ requestId: 'req-1', decision: 'decline' });
  assert.equal(await second.promise, 'decline');
});

test('an illegal decision is refused at the dispatcher too', () => {
  const dispatcher = new Dispatcher();
  openQuietly(dispatcher, { requestId: 'req-1', lane: 'oc_1' });
  for (const bogus of ['approve', 'yes', null, undefined, 'Accept']) {
    const result = dispatcher.answerApproval({ requestId: 'req-1', decision: bogus }, 1);
    assert.equal(result.outcome, OUTCOME.rejected);
    assert.equal(result.reason, 'not-a-decision');
  }
  assert.equal(dispatcher.pendingApprovals().length, 1, 'an illegal answer must not consume the ask');

  for (const decision of APPROVAL_DECISIONS) {
    assert.ok(APPROVAL_DECISIONS.includes(decision));
  }
});

test('pressing the same button twice is not an error', () => {
  const dispatcher = new Dispatcher();
  openQuietly(dispatcher, { requestId: 'req-1', lane: 'oc_1' });
  assert.equal(dispatcher.answerApproval({ requestId: 'req-1', decision: 'accept' }).outcome, OUTCOME.running);
  assert.equal(dispatcher.answerApproval({ requestId: 'req-1', decision: 'accept' }).outcome, OUTCOME.duplicate);
});

test('an abandoned approval is rejected, never answered with decline on a human\'s behalf', async () => {
  const dispatcher = new Dispatcher();
  dispatcher.observeEnds([{ end: 'e1' }], 0);
  dispatcher.submit(prompt(), 0);
  const { promise } = dispatcher.openApproval({ requestId: 'req-1', lane: 'oc_1', method: COMMAND_APPROVAL }, 1);

  dispatcher.turnFinished({ lane: 'oc_1', status: 'failed' }, 2);
  await assert.rejects(() => promise, ApprovalAbandoned);
  assert.equal(dispatcher.pendingApprovals().length, 0);
});

test('an end going away abandons the approvals it was holding', async () => {
  const dispatcher = new Dispatcher();
  dispatcher.observeEnds([{ end: 'e1' }], 0);
  dispatcher.submit(prompt(), 0);
  const { promise } = dispatcher.openApproval({ requestId: 'req-1', lane: 'oc_1', method: COMMAND_APPROVAL }, 1);
  dispatcher.observeEnds([], 2);
  await assert.rejects(() => promise, /abandoned/);
});

test('time produces reminders and never a decision', () => {
  const dispatcher = new Dispatcher({ approvalReminderMs: 1000 });
  openQuietly(dispatcher, { requestId: 'req-1', lane: 'oc_1' }, 0);

  assert.deepEqual(of(dispatcher.tick(999).effects, EFFECT.remindApproval), []);
  const [reminder] = of(dispatcher.tick(1000).effects, EFFECT.remindApproval);
  assert.equal(reminder.requestId, 'req-1');
  assert.equal(reminder.waitedMs, 1000);

  // Idempotent between intervals, so polling often is free.
  assert.deepEqual(of(dispatcher.tick(1500).effects, EFFECT.remindApproval), []);
  assert.equal(of(dispatcher.tick(2000).effects, EFFECT.remindApproval).length, 1);

  // However long it waits, nobody decided it.
  dispatcher.tick(10 ** 9);
  assert.equal(dispatcher.pendingApprovals().length, 1);
});

// -- the typed fallback for a contested card callback ------------------------

test('a typed decision resolves the lane\'s single pending approval', async () => {
  const dispatcher = new Dispatcher();
  const { promise } = dispatcher.openApproval({ requestId: 'req-1', lane: 'oc_1', method: COMMAND_APPROVAL }, 0);

  const answered = dispatcher.answerApproval({ requestId: null, lane: 'oc_1', decision: 'accept' }, 5);
  assert.equal(answered.outcome, OUTCOME.running);
  assert.equal(answered.requestId, 'req-1');
  assert.equal(await promise, 'accept');
});

test('a typed decision refuses to guess when two approvals are waiting', () => {
  const dispatcher = new Dispatcher();
  openQuietly(dispatcher, { requestId: 'req-1', lane: 'oc_1' }, 0);
  openQuietly(dispatcher, { requestId: 'req-2', lane: 'oc_1' }, 1);

  const result = dispatcher.answerApproval({ requestId: null, lane: 'oc_1', decision: 'accept' }, 5);
  assert.equal(result.outcome, OUTCOME.rejected);
  assert.equal(result.reason, 'ambiguous');
  assert.deepEqual(notices(result.effects), [NOTICE.approvalAmbiguous]);
  assert.deepEqual(of(result.effects, EFFECT.notice)[0].detail.pending, ['req-1', 'req-2']);
  assert.equal(dispatcher.pendingApprovals().length, 2, 'neither may be decided by a guess');
});

test('a typed decision with nothing waiting says so', () => {
  const dispatcher = new Dispatcher();
  const result = dispatcher.answerApproval({ requestId: null, lane: 'oc_1', decision: 'accept' }, 0);
  assert.equal(result.outcome, OUTCOME.rejected);
  assert.equal(result.reason, 'nothing-pending');
  assert.deepEqual(notices(result.effects), [NOTICE.approvalNothing]);
});

test('a typed decision only resolves approvals from its own lane', () => {
  const dispatcher = new Dispatcher();
  openQuietly(dispatcher, { requestId: 'req-other', lane: 'oc_other' }, 0);
  const result = dispatcher.answerApproval({ requestId: null, lane: 'oc_1', decision: 'accept' }, 1);
  assert.equal(result.reason, 'nothing-pending');
  assert.equal(dispatcher.pendingApprovals('oc_other').length, 1);
});

test('a typed decision with no lane at all is refused', () => {
  const dispatcher = new Dispatcher();
  const result = dispatcher.answerApproval({ requestId: null, decision: 'accept' }, 0);
  assert.equal(result.reason, 'no-request-id-and-no-lane');
});

// -- inspection --------------------------------------------------------------

test('the snapshot describes the whole schedule without exposing internals', () => {
  const dispatcher = new Dispatcher();
  dispatcher.observeEnds([{ end: 'e1' }, { end: 'e2', busy: true }], 0);
  dispatcher.submit(prompt({ lane: 'a' }), 0);
  dispatcher.submit(prompt({ lane: 'a', text: 'queued' }), 1);
  openQuietly(dispatcher, { requestId: 'req-1', lane: 'a' }, 2);

  const snapshot = dispatcher.snapshot();
  assert.deepEqual(snapshot.ends.map((end) => end.endId).sort(), ['e1', 'e2']);
  assert.equal(snapshot.ends.find((end) => end.endId === 'e2').schedulable, false);
  assert.equal(snapshot.lanes[0].queued, 1);
  assert.equal(snapshot.lanes[0].endId, 'e1');
  assert.deepEqual(snapshot.approvals, [{ requestId: 'req-1', lane: 'a' }]);

  // No promises, no settle functions, no params leaking out.
  const serialised = JSON.stringify(snapshot);
  assert.equal(serialised.includes('settle'), false);
});

test('maxConcurrentPerEnd above one is honoured for an end known to multiplex', () => {
  const dispatcher = new Dispatcher({ maxConcurrentPerEnd: 2 });
  dispatcher.observeEnds([{ end: 'e1' }], 0);
  assert.equal(dispatcher.submit(prompt({ lane: 'a' }), 0).outcome, OUTCOME.running);
  assert.equal(dispatcher.submit(prompt({ lane: 'b' }), 1).outcome, OUTCOME.running);
  assert.equal(dispatcher.submit(prompt({ lane: 'c' }), 2).outcome, OUTCOME.queued);
});

test('a dispatcher refuses a nonsense configuration', () => {
  assert.throws(() => new Dispatcher({ maxConcurrentPerEnd: 0 }), RangeError);
  assert.throws(() => new Dispatcher({ maxQueueDepth: 0 }), RangeError);
});

// -- take-over ---------------------------------------------------------------

/** An end that will take work. */
function fleet(dispatcher) {
  dispatcher.observeEnds([{ end: 'e1' }], 0);
  return dispatcher;
}

test('/mine interrupts the running turn and leaves the lane inert', () => {
  const dispatcher = fleet(new Dispatcher());
  dispatcher.submit(prompt(), 0);
  dispatcher.turnAccepted({ lane: 'oc_1', threadId: 't1', turnId: 'u1' }, 1);

  const { effects } = dispatcher.hold({ lane: 'oc_1' }, 2);
  assert.deepEqual(of(effects, EFFECT.interruptTurn).map((e) => e.turnId), ['u1']);
  assert.deepEqual(notices(effects), [NOTICE.held]);
  assert.equal(dispatcher.snapshot().lanes[0].held, true);
});

test('holding an idle lane interrupts nothing and still holds', () => {
  const dispatcher = fleet(new Dispatcher());
  const { effects } = dispatcher.hold({ lane: 'oc_1' }, 0);
  assert.equal(of(effects, EFFECT.interruptTurn).length, 0);
  assert.deepEqual(of(effects, EFFECT.notice)[0].detail,
    { interrupted: false, dropped: 0, already: false });
  assert.equal(dispatcher.snapshot().lanes[0].held, true);
});

test('a held lane refuses work instead of queueing it', () => {
  const dispatcher = fleet(new Dispatcher());
  dispatcher.hold({ lane: 'oc_1' }, 0);
  const { outcome, effects } = dispatcher.submit(prompt({ text: 'and this too' }), 1);
  assert.equal(outcome, OUTCOME.rejected);
  assert.deepEqual(notices(effects), [NOTICE.held]);
  assert.equal(dispatcher.snapshot().lanes[0].queued, 0);
});

test('taking over drops what was already queued, so release is not a burst', () => {
  const dispatcher = fleet(new Dispatcher());
  dispatcher.submit(prompt({ text: 'one' }), 0);   // runs
  dispatcher.submit(prompt({ text: 'two' }), 1);   // queues behind it
  dispatcher.submit(prompt({ text: 'three' }), 2);
  assert.equal(dispatcher.snapshot().lanes[0].queued, 2);

  const { effects } = dispatcher.hold({ lane: 'oc_1' }, 3);
  assert.equal(of(effects, EFFECT.notice)[0].detail.dropped, 2);

  // Finish the interrupted turn first, so the lane is genuinely free: that
  // is the state in which a surviving queue *would* burst on release.
  dispatcher.turnFinished({ lane: 'oc_1', status: 'interrupted' }, 4);
  const released = dispatcher.release({ lane: 'oc_1' }, 5);
  assert.deepEqual(notices(released.effects), [NOTICE.released]);
  assert.equal(of(released.effects, EFFECT.startTurn).length, 0);
  assert.equal(dispatcher.snapshot().lanes[0].queued, 0);
});

test('a held lane never carries a queue, which is why the scheduler needs no guard', () => {
  const dispatcher = fleet(new Dispatcher());
  dispatcher.submit(prompt(), 0);
  dispatcher.submit(prompt(), 1);
  dispatcher.hold({ lane: 'oc_1' }, 2);
  const queued = () => dispatcher.snapshot().lanes[0].queued;
  assert.equal(queued(), 0);
  dispatcher.submit(prompt(), 3);                                     // refused
  assert.equal(queued(), 0);
  dispatcher.turnFinished({ lane: 'oc_1', status: 'interrupted' }, 4); // schedules
  assert.equal(queued(), 0);
  dispatcher.observeEnds([{ end: 'e1', busy: false }], 5);             // schedules
  assert.equal(queued(), 0);
});

test('a held lane is not scheduled even when an end frees up under it', () => {
  const dispatcher = fleet(new Dispatcher());
  dispatcher.submit(prompt(), 0);
  dispatcher.hold({ lane: 'oc_1' }, 1);
  // The interrupt lands; the turn ends; nothing may start in its place.
  const { effects } = dispatcher.turnFinished({ lane: 'oc_1', status: 'interrupted' }, 2);
  assert.equal(of(effects, EFFECT.startTurn).length, 0);
  // Nor when the roster is re-observed.
  const freed = dispatcher.observeEnds([{ end: 'e1', busy: false }], 3);
  assert.equal(of(freed.effects ?? [], EFFECT.startTurn).length, 0);
  assert.equal(dispatcher.snapshot().lanes[0].held, true);
});

test('release hands the lane back and new work runs again', () => {
  const dispatcher = fleet(new Dispatcher());
  dispatcher.hold({ lane: 'oc_1' }, 0);
  dispatcher.release({ lane: 'oc_1' }, 1);
  assert.equal(dispatcher.snapshot().lanes[0].held, false);
  const { outcome, effects } = dispatcher.submit(prompt(), 2);
  assert.equal(outcome, OUTCOME.running);
  assert.equal(of(effects, EFFECT.startTurn).length, 1);
});

test('holding twice is not an error and says so', () => {
  const dispatcher = fleet(new Dispatcher());
  dispatcher.hold({ lane: 'oc_1' }, 0);
  const { effects } = dispatcher.hold({ lane: 'oc_1' }, 1);
  assert.equal(of(effects, EFFECT.notice)[0].detail.already, true);
  assert.equal(dispatcher.snapshot().lanes[0].held, true);
});

test('releasing a lane nobody holds is refused, not silently accepted', () => {
  const dispatcher = fleet(new Dispatcher());
  dispatcher.submit(prompt({ lane: 'oc_live' }), 0);      // exists, not held
  dispatcher.hold({ lane: 'oc_was' }, 1);
  dispatcher.release({ lane: 'oc_was' }, 2);              // exists, no longer held
  for (const lane of ['oc_live', 'oc_was', 'oc_never_seen']) {
    const { outcome, effects } = dispatcher.release({ lane }, 3);
    assert.equal(outcome, OUTCOME.rejected, lane);
    assert.deepEqual(notices(effects), [NOTICE.releaseNothing], lane);
  }
  // ...and the live lane was not disturbed by being released at.
  assert.notEqual(dispatcher.snapshot().lanes.find((l) => l.lane === 'oc_live').running, null);
});

test('holding one lane does not stall another', () => {
  const dispatcher = new Dispatcher({ maxConcurrentPerEnd: 2 });
  fleet(dispatcher);
  dispatcher.hold({ lane: 'oc_1' }, 0);
  const { outcome, effects } = dispatcher.submit(prompt({ lane: 'oc_2' }), 1);
  assert.equal(outcome, OUTCOME.running);
  assert.deepEqual(of(effects, EFFECT.startTurn).map((e) => e.lane), ['oc_2']);
});

test('hold without a lane is refused rather than creating one', () => {
  const dispatcher = fleet(new Dispatcher());
  assert.equal(dispatcher.hold({}, 0).outcome, OUTCOME.rejected);
  assert.equal(dispatcher.hold({ lane: '' }, 0).outcome, OUTCOME.rejected);
  assert.equal(dispatcher.snapshot().lanes.length, 0);
});
