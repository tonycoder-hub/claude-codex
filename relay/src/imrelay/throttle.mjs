// The pacer: decides *when* a card is allowed to be rewritten.
//
// This is the module that determines whether streaming a turn into a chat
// message is viable at all, so it is worth being explicit about the shape of the
// problem it solves.
//
// A browser client re-renders on every frame for free. A chat message cannot:
// each visible change is an API call against a per-app frequency limit, and the
// agent emits deltas far faster than that limit allows. So between the
// projection (which folds every delta) and the transport (which can only be
// called so often) there has to be something that drops *intermediate* states
// while never dropping the *final* one.
//
// "Never drops the final one" is the entire correctness story. The obvious
// implementation -- a leading-edge throttle, "send now if the last send was more
// than N ms ago, otherwise ignore" -- has exactly one bug, and it is fatal here:
// the last delta of a turn almost always arrives inside the cooldown window, so
// it gets ignored, nothing further ever arrives to trigger a send, and the card
// is left permanently showing the second-to-last state. On a phone that reads as
// "the agent stopped mid-sentence". So this pacer is a *trailing-edge* coalescer
// with a pending-revision high-water mark: a note that cannot be sent now is
// remembered, not discarded, and `poll()` will keep saying "flush" until the
// pending revision has actually been written.
//
// Three separate limits are modelled, because they fail differently:
//
//   1. **Coalescing interval** (`minIntervalMs`) -- self-imposed. How often *we*
//      choose to rewrite one card. Tuned for legibility and budget, not
//      correctness; raising it costs smoothness and nothing else.
//   2. **App-wide rate limit** (`TokenBucket`) -- imposed by the platform, shared
//      across every card this app touches. Exceeding it earns an error response
//      for a request that was going to be useful, so the bucket is checked
//      before the interval and is the only limit that can starve a flush
//      indefinitely.
//   3. **Server-signalled backoff** (`failed({ retryAfterMs })`) -- what to do
//      when the platform says no anyway. Keeps the pending revision.
//
// There are no timers in here and no clock reads. Every method takes `now`, so
// a test can drive a whole turn through in zero wall-clock time, and the
// production loop can be a single `setInterval` that polls every pacer.

/**
 * A plain token bucket, shared by every card belonging to one app.
 *
 * Fractional refill on purpose: a limit expressed as "N per minute" with a
 * whole-token-per-tick refill arrives in bursts that look nothing like the
 * limit it is modelling.
 */
export class TokenBucket {
  #capacity;
  #perMs;
  #tokens;
  #at;

  /**
   * @param {object} init
   * @param {number} init.capacity Burst size, in requests.
   * @param {number} init.refillPerSecond Sustained rate.
   * @param {number} [init.now] Starting timestamp.
   * @param {number} [init.tokens] Starting fill; defaults to full.
   */
  constructor({ capacity, refillPerSecond, now = 0, tokens = null }) {
    if (!(capacity > 0)) throw new RangeError('a bucket needs a positive capacity');
    if (!(refillPerSecond > 0)) throw new RangeError('a bucket needs a positive refill rate');
    this.#capacity = capacity;
    this.#perMs = refillPerSecond / 1000;
    this.#tokens = tokens === null ? capacity : Math.min(capacity, Math.max(0, tokens));
    this.#at = now;
  }

  get capacity() { return this.#capacity; }

  /** Current fill, after accounting for elapsed time. Read-only. */
  level(now) {
    this.#advance(now);
    return this.#tokens;
  }

  /** Spend one token if there is one. Returns whether it was spent. */
  take(now) {
    this.#advance(now);
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }

  /** How long until a token is available. 0 when one already is. */
  waitMs(now) {
    this.#advance(now);
    if (this.#tokens >= 1) return 0;
    return Math.ceil((1 - this.#tokens) / this.#perMs);
  }

  #advance(now) {
    if (!(now > this.#at)) return; // also covers NaN and clocks going backwards
    this.#tokens = Math.min(this.#capacity, this.#tokens + (now - this.#at) * this.#perMs);
    this.#at = now;
  }
}

/** What `poll()` can say. */
export const PACE = Object.freeze({
  /** Nothing is owed; the written card matches the projection. */
  idle: 'idle',
  /** Write this revision now. */
  flush: 'flush',
  /** Something is owed but not yet permitted; come back after `afterMs`. */
  wait: 'wait',
});

/**
 * One card's write schedule.
 *
 * Usage is a three-step cycle, and skipping step three is the mistake to avoid:
 * `note()` when the projection changes, `poll(now)` to ask whether to write, and
 * **`settled(revision, now)` once the write succeeded**. Without `settled`, the
 * pacer keeps believing the card is stale and rewrites it forever.
 */
export class CardPacer {
  #minIntervalMs;
  #bucket;
  #pending = null; // highest revision noted but not yet written
  #written = null; // highest revision confirmed written
  #lastFlushAt = null;
  #urgent = false;
  #notBefore = null; // server-signalled backoff floor

  /**
   * @param {object} [init]
   * @param {number} [init.minIntervalMs] Self-imposed gap between writes to this
   *   card. See `pacingFor()` for deriving it from a platform limit.
   * @param {TokenBucket} [init.bucket] App-wide limit, shared across cards.
   */
  constructor({ minIntervalMs = 1000, bucket = null } = {}) {
    if (!(minIntervalMs >= 0)) throw new RangeError('minIntervalMs must be >= 0');
    this.#minIntervalMs = minIntervalMs;
    this.#bucket = bucket;
  }

  /** Highest revision written to the card, or null if it has never been written. */
  get written() { return this.#written; }
  /** Highest revision owed, or null when nothing is owed. */
  get pending() { return this.#pending; }

  /**
   * The projection moved to `revision`.
   *
   * @param {number} revision
   * @param {object} [options]
   * @param {boolean} [options.urgent] Skip the coalescing interval at the next
   *   opportunity. For state changes a person is actively waiting on -- an
   *   approval appearing, the turn ending, an error. It does **not** bypass the
   *   app-wide rate limit, because that one is not ours to bypass.
   */
  note(revision, { urgent = false } = {}) {
    if (!Number.isFinite(revision)) throw new TypeError('a revision must be a finite number');
    // Revisions only move forward. A lower one means the caller swapped
    // projections behind our back; keep the higher so we cannot under-write.
    if (this.#pending === null || revision > this.#pending) this.#pending = revision;
    if (urgent) this.#urgent = true;
  }

  /**
   * @param {number} now
   * @returns {{action: string, revision?: number, afterMs?: number, urgent?: boolean}}
   */
  poll(now) {
    if (this.#pending === null) return { action: PACE.idle };
    if (this.#written !== null && this.#pending <= this.#written) {
      // Written already caught up -- can happen when `settled` was called with a
      // revision ahead of what was noted.
      this.#pending = null;
      this.#urgent = false;
      return { action: PACE.idle };
    }

    const waits = [];
    if (this.#notBefore !== null && now < this.#notBefore) waits.push(this.#notBefore - now);
    // The very first write is never delayed by the coalescing interval: a card
    // that takes a second to appear after the person pressed send reads as the
    // bot being broken, and there is nothing to coalesce with yet.
    if (!this.#urgent && this.#lastFlushAt !== null) {
      const earliest = this.#lastFlushAt + this.#minIntervalMs;
      if (now < earliest) waits.push(earliest - now);
    }
    if (waits.length > 0) {
      return { action: PACE.wait, afterMs: Math.ceil(Math.max(...waits)), revision: this.#pending };
    }

    // Checked last so a bucket token is never spent on a flush that the interval
    // or a backoff would have refused anyway.
    if (this.#bucket !== null && !this.#bucket.take(now)) {
      return { action: PACE.wait, afterMs: this.#bucket.waitMs(now), revision: this.#pending };
    }

    const revision = this.#pending;
    const urgent = this.#urgent;
    this.#lastFlushAt = now;
    this.#urgent = false;
    // `#pending` is deliberately *not* cleared here. It is cleared by
    // `settled()`. If the write fails, or the process dies between poll and
    // write, the next poll still knows a write is owed.
    return { action: PACE.flush, revision, urgent };
  }

  /** The transport accepted a write carrying `revision`. */
  settled(revision, now = null) {
    if (!Number.isFinite(revision)) throw new TypeError('a revision must be a finite number');
    if (this.#written === null || revision > this.#written) this.#written = revision;
    if (this.#pending !== null && this.#pending <= this.#written) this.#pending = null;
    if (now !== null) this.#lastFlushAt = now;
    this.#notBefore = null;
  }

  /**
   * The write failed. The pending revision is kept, so the next permitted poll
   * re-offers it: a dropped update is a stale card, and a stale card is the one
   * failure mode this whole module exists to prevent.
   *
   * @param {number} now
   * @param {object} [options]
   * @param {number} [options.retryAfterMs] Honour a server-signalled delay.
   */
  failed(now, { retryAfterMs = null } = {}) {
    const floor = retryAfterMs === null ? now + this.#minIntervalMs : now + retryAfterMs;
    if (this.#notBefore === null || floor > this.#notBefore) this.#notBefore = floor;
  }
}

/**
 * Turn a platform limit into a per-card coalescing interval.
 *
 * The arithmetic is trivial and the point of naming it is that it is the whole
 * viability argument in one line: a per-app ceiling of `updatesPerSecond`, split
 * across `concurrentCards` live turns, leaves each card `updatesPerSecond /
 * concurrentCards` writes per second. Reserve a slice of the ceiling for the
 * non-streaming traffic -- new messages, completion notices, approval cards --
 * and what is left is the streaming interval.
 *
 * @param {object} limits
 * @param {number} limits.updatesPerSecond The platform's per-app ceiling.
 * @param {number} [limits.concurrentCards] How many turns may stream at once.
 * @param {number} [limits.reserveFraction] Share of the ceiling held back for
 *   traffic that is not streaming updates.
 * @returns {{ minIntervalMs: number, perCardPerSecond: number, bucket: { capacity: number, refillPerSecond: number } }}
 */
export function pacingFor({ updatesPerSecond, concurrentCards = 1, reserveFraction = 0.25 } = {}) {
  if (!(updatesPerSecond > 0)) throw new RangeError('updatesPerSecond must be positive');
  if (!Number.isInteger(concurrentCards) || concurrentCards < 1) {
    throw new RangeError('concurrentCards must be a positive integer');
  }
  if (!(reserveFraction >= 0 && reserveFraction < 1)) {
    throw new RangeError('reserveFraction must be in [0, 1)');
  }
  const forStreaming = updatesPerSecond * (1 - reserveFraction);
  const perCardPerSecond = forStreaming / concurrentCards;
  return {
    perCardPerSecond,
    minIntervalMs: Math.ceil(1000 / perCardPerSecond),
    // Capacity 1 on purpose: a burst allowance on a *streaming* path just means
    // several rewrites land in the same animation frame, which nobody can read,
    // and then the sustained path is starved for the next second.
    bucket: { capacity: Math.max(1, Math.floor(updatesPerSecond)), refillPerSecond: updatesPerSecond },
  };
}
