// The dispatcher: intents and end states in, a schedule out.
//
// This is the "aggressive" part of the design -- the claim that an IM relay
// should own scheduling rather than have it bolted on. The argument is short:
// the thing a chat message needs decided is *where and when this runs*, and
// every input to that decision already passes through here. Which conversation
// a message belongs to is a property of the message. Which resident machine owns
// that conversation's thread is a property of the binding this file holds.
// Whether that machine is free is a property of the end roster this file reads.
// Putting the queue anywhere else means shipping all three facts somewhere else
// first.
//
// Equally important is what this file does **not** own. Thread and turn state
// live in the app-server, reached through `thread/start`, `thread/resume`,
// `turn/start` and `turn/interrupt`, and the streaming `item/*` notifications.
// This dispatcher never stores a transcript, never counts tokens, never decides
// what a turn produced. It stores exactly three things the app-server cannot
// know: the chat-to-thread binding, the queue, and the set of approvals a human
// has not answered yet.
//
// ## Purity
//
// No timers, no clock reads, no I/O. Every method takes `at`, and every
// consequence comes back as a plain **effect object** for the caller to perform.
// A test drives a whole fleet through a day of scheduling in zero wall-clock
// time, and the production loop is a handful of `await`s around the effect list.
//
// ## The decisions worth arguing with
//
// **1. A thread is pinned to an end, and a dead end queues rather than
// reassigns.** The app-server's thread store is per-installation -- `03-reframe.md`
// traces it to `CLAUDE_CODEX_HOME/state.sqlite` -- so `thread/resume` on a
// different machine cannot find the thread. Silently moving a conversation to a
// free end would therefore drop its entire history while looking like it
// worked. So a bound end going offline makes the lane *wait*, and moving is an
// explicit act (`/end <id>`) that says out loud that context is lost.
//
// **2. One turn per lane, always.** The protocol has no concurrent turns in a
// thread and no generic cancel, only `turn/interrupt`. Serialising per lane is
// not a policy choice, it is the protocol.
//
// **3. An end reported busy that we did not make busy is not schedulable.** The
// resident Mac is also driven by its own desktop app. The relay's `busy` flag is
// the end's self-report; this dispatcher's own count is what it started. When
// those disagree in the direction of "busy but not by us", somebody else is
// using that machine and we stay off it.
//
// **4. A pending approval is never auto-decided.** It would be easy to time one
// out, and both available defaults are wrong: `decline` silently refuses real
// work in a vocabulary where the refusal is indistinguishable from a typo, and
// accepting is a security hole with a timer on it. So an unanswered approval
// holds its end -- which is a real cost -- and the mitigations are a reminder
// effect and a visible "abort this turn" button. The cost is paid deliberately.

import { APPROVAL_DECISIONS } from '../appserver/client.mjs';

/** What `submit()` concluded. */
export const OUTCOME = Object.freeze({
  running: 'running',
  queued: 'queued',
  rejected: 'rejected',
  duplicate: 'duplicate',
  noEnd: 'no-end',
});

/** Effect kinds. A closed set; the caller switches on it exhaustively. */
export const EFFECT = Object.freeze({
  /** Call `turn/start`. `threadId === null` means `thread/start` first. */
  startTurn: 'start-turn',
  /** Call `turn/interrupt`. */
  interruptTurn: 'interrupt-turn',
  /** Say something to the human. `kind` says what. */
  notice: 'notice',
  /** An approval has gone unanswered long enough to mention again. */
  remindApproval: 'remind-approval',
  /** The end running this lane vanished; the turn is lost. */
  orphaned: 'orphaned',
});

/** `notice` kinds, so the renderer can phrase them. */
export const NOTICE = Object.freeze({
  queued: 'queued',
  endOffline: 'end-offline',
  noEnds: 'no-ends',
  queueFull: 'queue-full',
  rehomed: 'rehomed',
  finished: 'finished',
  interruptNothing: 'interrupt-nothing',
  /** A human took the lane over; the relay has stopped acting on it. */
  held: 'held',
  /** The lane was handed back. */
  released: 'released',
  /** `/release` on a lane nobody was holding. */
  releaseNothing: 'release-nothing',
  /** A typed decision arrived with nothing waiting for it. */
  approvalNothing: 'approval-nothing',
  /** A typed decision arrived with several approvals waiting; ask which. */
  approvalAmbiguous: 'approval-ambiguous',
});

/** The promise held for an approval was given up on. */
export class ApprovalAbandoned extends Error {
  constructor(requestId, why) {
    super(`approval ${requestId} was abandoned: ${why}`);
    this.name = 'ApprovalAbandoned';
    this.requestId = requestId;
  }
}

export class Dispatcher {
  #ends = new Map(); // endId -> { endId, busy, present, meta }
  #lanes = new Map(); // lane -> lane record
  #approvals = new Map(); // requestId -> approval record
  #seenEvents = new Set();
  #maxConcurrentPerEnd;
  #maxQueueDepth;
  #approvalReminderMs;
  #seenEventMax;

  /**
   * @param {object} [init]
   * @param {number} [init.maxConcurrentPerEnd] The relay's `/ends` exposes
   *   `busy` as a boolean, so 1 is the only value that matches what the relay
   *   can actually tell us. Higher values are available for an end known to
   *   multiplex, and are then this dispatcher's private belief.
   * @param {number} [init.maxQueueDepth] Per lane. A bound, because a person
   *   typing six messages at a laggy bot should be told no rather than
   *   queueing six turns.
   * @param {number} [init.approvalReminderMs]
   */
  constructor({
    maxConcurrentPerEnd = 1,
    maxQueueDepth = 4,
    approvalReminderMs = 120000,
    seenEventMax = 4096,
  } = {}) {
    if (!Number.isInteger(maxConcurrentPerEnd) || maxConcurrentPerEnd < 1) {
      throw new RangeError('maxConcurrentPerEnd must be a positive integer');
    }
    if (!Number.isInteger(maxQueueDepth) || maxQueueDepth < 1) {
      throw new RangeError('maxQueueDepth must be a positive integer');
    }
    this.#maxConcurrentPerEnd = maxConcurrentPerEnd;
    this.#maxQueueDepth = maxQueueDepth;
    this.#approvalReminderMs = approvalReminderMs;
    this.#seenEventMax = seenEventMax;
  }

  // -- the end roster --------------------------------------------------------

  /**
   * Replace what we believe about the fleet, from the relay's `GET /ends`.
   *
   * Registration on that relay lives exactly as long as an end's control
   * socket and nothing expires on a timer, so absence from this list is
   * authoritative: the end is gone, not merely quiet.
   *
   * @param {Array<{end: string, busy?: boolean}>} ends
   * @param {number} at
   * @returns {{ effects: object[] }}
   */
  observeEnds(ends, at = 0) {
    if (!Array.isArray(ends)) throw new TypeError('observeEnds needs an array');
    const effects = [];
    const seen = new Set();

    for (const entry of ends) {
      const endId = entry?.end;
      if (typeof endId !== 'string' || endId === '') continue;
      seen.add(endId);
      const existing = this.#ends.get(endId);
      if (existing) {
        existing.busy = entry.busy === true;
        existing.present = true;
      } else {
        this.#ends.set(endId, { endId, busy: entry.busy === true, present: true });
      }
    }

    for (const end of this.#ends.values()) {
      if (seen.has(end.endId)) continue;
      if (!end.present) continue;
      end.present = false;
      // Every lane this end was running has lost its turn. The app-server will
      // not send `turn/completed`, so without this the card says "running" for
      // ever.
      for (const lane of this.#lanes.values()) {
        if (lane.endId !== end.endId || lane.running === null) continue;
        const lost = lane.running;
        lane.running = null;
        effects.push({
          type: EFFECT.orphaned, lane: lane.lane, endId: end.endId,
          threadId: lane.threadId, turnId: lane.turnId, requestId: lost.requestId, at,
        });
        effects.push(...this.#abandonApprovalsFor(lane.lane, 'the end went away'));
      }
    }

    effects.push(...this.#schedule(at));
    return { effects };
  }

  /** Ends currently usable, for diagnostics and tests. */
  schedulableEnds() {
    return [...this.#ends.values()]
      .filter((end) => this.#isSchedulable(end))
      .map((end) => end.endId);
  }

  // -- prompts ---------------------------------------------------------------

  /**
   * Take a `prompt` intent from `inbound.mjs`.
   *
   * @param {object} intent
   * @param {number} at
   * @returns {{ outcome: string, effects: object[], lane: string }}
   */
  submit(intent, at = 0) {
    const lane = requireLane(intent);
    const requestId = typeof intent.eventId === 'string' ? intent.eventId : null;

    // Defence in depth: `InboundGate` already de-duplicates on event id, but the
    // consequence of a double-submit is a double-charged turn, so it is worth
    // checking twice.
    if (requestId !== null && this.#seenEvents.has(requestId)) {
      return { outcome: OUTCOME.duplicate, effects: [], lane };
    }
    if (requestId !== null) this.#rememberEvent(requestId);

    const record = this.#lane(lane, intent.chatId ?? null);
    const effects = [];

    // A held lane refuses work rather than queueing it. This is the one place
    // the dispatcher drops a request on the floor on purpose, so the argument
    // is worth writing down: you take a lane over precisely to stop the relay
    // acting in it, and a queue that drains the moment you hand back turns
    // that intent inside out -- the pause would end in a burst of turns you
    // asked for minutes ago and have since dealt with yourself. Refusing is
    // also the honest answer, because it is visible: the human sees "held" and
    // can re-send, where a silent queue looks like nothing happened at all.
    if (record.held) {
      effects.push({ type: EFFECT.notice, lane, kind: NOTICE.held, at, detail: null });
      return { outcome: OUTCOME.rejected, effects, lane };
    }

    // An explicit `/end` that disagrees with the binding is a re-home, and it
    // costs the thread. Said out loud rather than done quietly.
    if (intent.endId && record.endId !== null && record.endId !== intent.endId) {
      effects.push({
        type: EFFECT.notice, lane, kind: NOTICE.rehomed, at,
        detail: { from: record.endId, to: intent.endId },
      });
      record.endId = intent.endId;
      record.threadId = null;
    } else if (intent.endId && record.endId === null) {
      record.endId = intent.endId;
    }

    if (intent.freshThread === true) record.threadId = null;

    if (record.queue.length >= this.#maxQueueDepth) {
      effects.push({
        type: EFFECT.notice, lane, kind: NOTICE.queueFull, at,
        detail: { depth: record.queue.length },
      });
      return { outcome: OUTCOME.rejected, effects, lane };
    }

    record.queue.push({
      requestId,
      text: typeof intent.text === 'string' ? intent.text : '',
      messageId: intent.messageId ?? null,
      at,
      freshThread: intent.freshThread === true,
    });

    const started = this.#schedule(at);
    effects.push(...started);

    const nowRunning = record.running !== null && started.some(
      (effect) => effect.type === EFFECT.startTurn && effect.lane === lane,
    );
    if (nowRunning) return { outcome: OUTCOME.running, effects, lane };

    // It did not start. Say which flavour of "not yet" this is, because
    // "everything is busy" and "the machine your conversation lives on is
    // offline" and "there is no fleet" need different reactions from a human.
    const reason = this.#whyNotRunning(record);
    effects.push({
      type: EFFECT.notice, lane, kind: reason, at,
      detail: { position: record.queue.length, endId: record.endId },
    });
    return {
      outcome: reason === NOTICE.noEnds ? OUTCOME.noEnd : OUTCOME.queued,
      effects,
      lane,
    };
  }

  /**
   * The caller started the turn and learned its ids. Separate from the
   * `startTurn` effect because the ids only exist after the round trip, and
   * `turn/interrupt` needs them.
   */
  turnAccepted({ lane, threadId = null, turnId = null } = {}, at = 0) {
    const record = this.#lanes.get(lane);
    if (!record || record.running === null) return { effects: [] };
    if (typeof threadId === 'string' && threadId !== '') record.threadId = threadId;
    if (typeof turnId === 'string' && turnId !== '') record.turnId = turnId;
    record.running.acceptedAt = at;
    return { effects: [] };
  }

  /**
   * The turn reached a terminal state -- `turn/completed`, a failed
   * `turn/start`, or an interrupt that landed.
   */
  turnFinished({ lane, status = 'completed', error = null } = {}, at = 0) {
    const record = this.#lanes.get(lane);
    if (!record) return { effects: [] };
    const effects = [];
    if (record.running !== null) {
      effects.push({
        type: EFFECT.notice, lane, kind: NOTICE.finished, at,
        detail: { status, error, endId: record.endId, threadId: record.threadId },
      });
      record.running = null;
      record.turnId = null;
    }
    // Any approval still open belonged to the turn that just ended. Nobody is
    // waiting on the far side any more, so the held promises must be settled or
    // the handler leaks -- and they are *rejected*, not answered, because a
    // decision implies a human made one.
    effects.push(...this.#abandonApprovalsFor(lane, `the turn ${status}`));
    effects.push(...this.#schedule(at));
    return { effects };
  }

  /**
   * A human is taking this lane over. Interrupts anything running, drops
   * anything queued, and leaves the lane inert until `release()`.
   *
   * No operator identity is recorded, matching `inbound.mjs`: the chat
   * allowlist has already decided who may drive this relay, and a lane held by
   * "a human" behaves no differently from one held by a named human. Storing
   * an id would only create a second question -- may a different person
   * release it? -- that nothing here needs answered.
   *
   * `/mine` = interrupt + hold, composing with `/stop` = interrupt only.
   *
   * Inertness is maintained here and in `submit()`, by emptying the queue
   * and then refusing to refill it -- not by a guard in the scheduler. A
   * held lane never has a head item, so there is nothing there to skip.
   */
  hold({ lane } = {}, at = 0) {
    if (typeof lane !== 'string' || lane === '') {
      return { outcome: OUTCOME.rejected, effects: [], lane: lane ?? null };
    }
    const record = this.#lane(lane, null);
    const effects = [];
    const wasRunning = record.running !== null;
    if (wasRunning) {
      effects.push({
        type: EFFECT.interruptTurn,
        lane: record.lane,
        endId: record.endId,
        threadId: record.threadId,
        turnId: record.turnId,
        at,
      });
    }
    const dropped = record.queue.length;
    record.queue.length = 0;
    const already = record.held;
    record.held = true;
    effects.push({
      type: EFFECT.notice, lane, kind: NOTICE.held, at,
      detail: { interrupted: wasRunning, dropped, already },
    });
    return { outcome: OUTCOME.running, effects, lane };
  }

  /** Hand the lane back. Anything that arrives after this is relayed again. */
  release({ lane } = {}, at = 0) {
    const record = typeof lane === 'string' ? this.#lanes.get(lane) : undefined;
    if (!record || !record.held) {
      return {
        outcome: OUTCOME.rejected,
        effects: [{
          type: EFFECT.notice, lane: lane ?? null, kind: NOTICE.releaseNothing, at, detail: null,
        }],
        lane: lane ?? null,
      };
    }
    record.held = false;
    const effects = [{ type: EFFECT.notice, lane, kind: NOTICE.released, at, detail: null }];
    // The queue was emptied at hold time, so this schedules nothing in the
    // normal case. It runs anyway because an end may have come back while the
    // lane was held, and because leaving one mutation in the file that does
    // not end in a scheduling pass is how the next one gets forgotten.
    effects.push(...this.#schedule(at));
    return { outcome: OUTCOME.running, effects, lane };
  }

  /** Stop whatever is running in a lane. */
  interrupt({ lane, turnId = null } = {}, at = 0) {
    const resolved = lane ?? this.#laneOfTurn(turnId);
    const record = resolved === null ? null : this.#lanes.get(resolved);
    if (!record || record.running === null) {
      return {
        outcome: OUTCOME.rejected,
        effects: [{
          type: EFFECT.notice, lane: resolved, kind: NOTICE.interruptNothing, at, detail: null,
        }],
      };
    }
    return {
      outcome: OUTCOME.running,
      effects: [{
        type: EFFECT.interruptTurn,
        lane: record.lane,
        endId: record.endId,
        threadId: record.threadId,
        turnId: record.turnId,
        at,
      }],
    };
  }

  // -- approvals -------------------------------------------------------------

  /**
   * Hold a server->client approval request until a card button answers it.
   *
   * Returns the promise that `approvalResponder` from `src/appserver/client.mjs`
   * should be wrapped around:
   *
   *   client.handle(APPROVAL_METHODS.commandExecution, approvalResponder(
   *     (params, ctx) => dispatcher.openApproval({
   *       requestId: ctx.id, lane, method: ctx.method, params,
   *     }).promise,
   *   ));
   *
   * The wrapping is not optional. A decision string the adapter does not
   * recognise is coerced to `decline` *silently*, so the guard in
   * `approvalResponder` is the difference between a loud error and an agent
   * that mysteriously refuses every tool call.
   *
   * @returns {{ promise: Promise<string>, effects: object[] }}
   */
  openApproval({ requestId, lane, method = null, params = null } = {}, at = 0) {
    if (typeof requestId !== 'string' || requestId === '') {
      throw new TypeError('an approval needs the server request id');
    }
    const existing = this.#approvals.get(requestId);
    // A re-delivered request must get the *same* promise. Two promises for one
    // id means one of them is never settled.
    if (existing) return { promise: existing.promise, effects: [] };

    let settle;
    let fail;
    const promise = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
    this.#approvals.set(requestId, {
      requestId, lane, method, params, at, settle, fail, remindedAt: null, promise,
    });
    return { promise, effects: [] };
  }

  /**
   * Answer one, from a `decision` intent.
   *
   * The vocabulary is checked here too. `cards.mjs` only mints legal values and
   * `inbound.mjs` re-checks them, and this is the third check, because the one
   * failure this subsystem cannot afford is an illegal value reaching the
   * adapter -- there it stops being an error and becomes a silent `decline`.
   *
   * `requestId: null` is the typed fallback (`/ok`, `/no`, ...), which cannot
   * name a UUID. It resolves against the lane's single pending approval, and
   * **refuses when that is ambiguous** rather than guessing which of two
   * commands the person meant to allow. Guessing here would run a command nobody
   * approved, which is the one outcome worth being pedantic about.
   */
  answerApproval({ requestId = null, decision, lane = null } = {}, at = 0) {
    if (!APPROVAL_DECISIONS.includes(decision)) {
      return { outcome: OUTCOME.rejected, effects: [], reason: 'not-a-decision' };
    }

    let resolvedId = requestId;
    if (resolvedId === null) {
      if (typeof lane !== 'string' || lane === '') {
        return { outcome: OUTCOME.rejected, effects: [], reason: 'no-request-id-and-no-lane' };
      }
      const candidates = [...this.#approvals.values()]
        .filter((entry) => entry.lane === lane)
        .sort((a, b) => a.at - b.at);
      if (candidates.length === 0) {
        return {
          outcome: OUTCOME.rejected,
          reason: 'nothing-pending',
          lane,
          effects: [{
            type: EFFECT.notice, lane, kind: NOTICE.approvalNothing, at, detail: null,
          }],
        };
      }
      if (candidates.length > 1) {
        return {
          outcome: OUTCOME.rejected,
          reason: 'ambiguous',
          lane,
          effects: [{
            type: EFFECT.notice,
            lane,
            kind: NOTICE.approvalAmbiguous,
            at,
            detail: { pending: candidates.map((entry) => entry.requestId) },
          }],
        };
      }
      resolvedId = candidates[0].requestId;
    }

    const open = this.#approvals.get(resolvedId);
    // A second press of the same button, or a press after the turn ended. Not an
    // error worth shouting about -- the card may legitimately still be on screen.
    if (!open) return { outcome: OUTCOME.duplicate, effects: [] };
    this.#approvals.delete(resolvedId);
    open.settle(decision);
    return {
      outcome: OUTCOME.running, effects: [], lane: open.lane ?? null,
      requestId: resolvedId, decision,
    };
  }

  /** Approvals still waiting, for rendering. */
  pendingApprovals(lane = null) {
    const out = [];
    for (const entry of this.#approvals.values()) {
      if (lane !== null && entry.lane !== lane) continue;
      out.push({
        requestId: entry.requestId, lane: entry.lane, method: entry.method,
        params: entry.params, at: entry.at,
      });
    }
    return out;
  }

  // -- time ------------------------------------------------------------------

  /**
   * Advance the clock. The only thing time does here is produce reminders for
   * approvals; it never decides one. Idempotent between reminder intervals, so
   * polling it often is free.
   */
  tick(at) {
    const effects = [];
    for (const entry of this.#approvals.values()) {
      const since = entry.remindedAt ?? entry.at;
      if (at - since < this.#approvalReminderMs) continue;
      entry.remindedAt = at;
      effects.push({
        type: EFFECT.remindApproval, lane: entry.lane, requestId: entry.requestId,
        waitedMs: at - entry.at, at,
      });
    }
    effects.push(...this.#schedule(at));
    return { effects };
  }

  // -- inspection ------------------------------------------------------------

  /** A plain description of the whole schedule. The tests' main assertion. */
  snapshot() {
    return {
      ends: [...this.#ends.values()].map((end) => ({
        endId: end.endId,
        busy: end.busy,
        present: end.present,
        running: this.#loadOf(end.endId),
        schedulable: this.#isSchedulable(end),
      })),
      lanes: [...this.#lanes.values()].map((lane) => ({
        lane: lane.lane,
        chatId: lane.chatId,
        endId: lane.endId,
        threadId: lane.threadId,
        turnId: lane.turnId,
        running: lane.running === null ? null : { requestId: lane.running.requestId },
        queued: lane.queue.length,
        held: lane.held,
      })),
      approvals: this.pendingApprovals().map((entry) => ({
        requestId: entry.requestId, lane: entry.lane,
      })),
    };
  }

  // -- the scheduler --------------------------------------------------------

  /**
   * One scheduling pass. Called after every mutation; idempotent when nothing
   * can move.
   *
   * Fairness is FIFO by the arrival time of each lane's head item, across all
   * lanes competing for the same end. Head-of-line blocking within a lane is
   * intentional -- that is what "one turn per thread" means -- but between lanes
   * a chatty conversation must not starve a quiet one, and "oldest waiting
   * message first" is the rule that is easy to explain to the person waiting.
   */
  #schedule(at) {
    const effects = [];
    let moved = true;
    // Loop because starting one lane can free nothing but *filling* an end can
    // change which lane is next; bounded by the number of queued items, each of
    // which can start at most once.
    while (moved) {
      moved = false;
      const ready = [];
      for (const lane of this.#lanes.values()) {
        if (lane.running !== null) continue; // one turn per lane
        if (lane.queue.length === 0) continue;
        const endId = lane.endId ?? this.#pickEnd();
        if (endId === null) continue;
        const end = this.#ends.get(endId);
        if (!end || !this.#isSchedulable(end)) continue;
        if (this.#loadOf(endId) >= this.#maxConcurrentPerEnd) continue;
        ready.push({ lane, endId, at: lane.queue[0].at });
      }
      if (ready.length === 0) break;
      // Deterministic: oldest head item wins, lane name breaks ties so a test
      // never depends on Map iteration order.
      ready.sort((a, b) => (a.at - b.at) || (a.lane.lane < b.lane.lane ? -1 : 1));
      const chosen = ready[0];
      const item = chosen.lane.queue.shift();
      chosen.lane.endId = chosen.endId;
      chosen.lane.running = { ...item, startedAt: at };
      if (item.freshThread) chosen.lane.threadId = null;
      effects.push({
        type: EFFECT.startTurn,
        lane: chosen.lane.lane,
        chatId: chosen.lane.chatId,
        endId: chosen.endId,
        // `null` is the instruction to `thread/start` first; a string is the
        // instruction to `thread/resume`.
        threadId: chosen.lane.threadId,
        text: item.text,
        requestId: item.requestId,
        messageId: item.messageId,
        at,
      });
      moved = true;
    }
    return effects;
  }

  /** How many turns *we* started on an end. */
  #loadOf(endId) {
    let count = 0;
    for (const lane of this.#lanes.values()) {
      if (lane.endId === endId && lane.running !== null) count++;
    }
    return count;
  }

  /**
   * An end is schedulable when it is present, under our capacity, and not busy
   * with work we did not start. See decision 3 in the header.
   */
  #isSchedulable(end) {
    if (!end.present) return false;
    const ours = this.#loadOf(end.endId);
    if (ours >= this.#maxConcurrentPerEnd) return false;
    if (end.busy && ours === 0) return false;
    return true;
  }

  /** Least-loaded schedulable end; name breaks ties for determinism. */
  #pickEnd() {
    let best = null;
    for (const end of [...this.#ends.values()].sort((a, b) => (a.endId < b.endId ? -1 : 1))) {
      if (!this.#isSchedulable(end)) continue;
      const load = this.#loadOf(end.endId);
      if (best === null || load < best.load) best = { endId: end.endId, load };
    }
    return best === null ? null : best.endId;
  }

  #whyNotRunning(record) {
    if (this.#ends.size === 0) return NOTICE.noEnds;
    if (record.endId !== null) {
      const end = this.#ends.get(record.endId);
      if (!end || !end.present) return NOTICE.endOffline;
    } else if (this.schedulableEnds().length === 0
      && [...this.#ends.values()].every((end) => !end.present)) {
      return NOTICE.noEnds;
    }
    return NOTICE.queued;
  }

  #lane(lane, chatId) {
    let record = this.#lanes.get(lane);
    if (record) {
      if (record.chatId === null && chatId !== null) record.chatId = chatId;
      return record;
    }
    record = {
      lane, chatId, endId: null, threadId: null, turnId: null, running: null, queue: [],
      held: false,
    };
    this.#lanes.set(lane, record);
    return record;
  }

  #laneOfTurn(turnId) {
    if (typeof turnId !== 'string' || turnId === '') return null;
    for (const lane of this.#lanes.values()) {
      if (lane.turnId === turnId) return lane.lane;
    }
    return null;
  }

  #abandonApprovalsFor(lane, why) {
    const effects = [];
    for (const [requestId, entry] of [...this.#approvals]) {
      if (entry.lane !== lane) continue;
      this.#approvals.delete(requestId);
      // Rejecting makes `approvalResponder` emit a JSON-RPC error response,
      // which is the truth: this client can no longer answer. Resolving with
      // `decline` would claim a human refused.
      entry.fail(new ApprovalAbandoned(requestId, why));
    }
    return effects;
  }

  #rememberEvent(eventId) {
    this.#seenEvents.add(eventId);
    if (this.#seenEvents.size <= this.#seenEventMax) return;
    const oldest = this.#seenEvents.values().next().value;
    this.#seenEvents.delete(oldest);
  }
}

function requireLane(intent) {
  const lane = intent?.lane;
  if (typeof lane !== 'string' || lane === '') throw new TypeError('an intent needs a lane');
  return lane;
}
