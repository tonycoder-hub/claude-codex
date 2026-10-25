import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket, CardPacer, PACE, pacingFor } from '../../src/imrelay/throttle.mjs';
import { LARK_LIMITS } from '../../src/imrelay/transport.mjs';

// -- the bucket --------------------------------------------------------------

test('a bucket spends its burst then refills at the sustained rate', () => {
  const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 2, now: 0 });
  assert.equal(bucket.take(0), true);
  assert.equal(bucket.take(0), true);
  assert.equal(bucket.take(0), true);
  assert.equal(bucket.take(0), false);
  // 2/s means one token every 500 ms.
  assert.equal(bucket.waitMs(0), 500);
  assert.equal(bucket.take(499), false);
  assert.equal(bucket.take(500), true);
});

test('refill is fractional, so a slow limit does not arrive in bursts', () => {
  const bucket = new TokenBucket({ capacity: 10, refillPerSecond: 1, now: 0, tokens: 0 });
  assert.equal(bucket.level(250), 0.25);
  assert.equal(bucket.level(500), 0.5);
  assert.equal(bucket.take(999), false);
  assert.equal(bucket.take(1000), true);
});

test('a bucket never exceeds capacity and ignores a clock going backwards', () => {
  const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 100, now: 1000 });
  assert.equal(bucket.level(100000), 2);
  bucket.take(100000);
  assert.equal(bucket.level(0), 1, 'time going backwards must not refill');
});

test('a bucket refuses a nonsense configuration', () => {
  assert.throws(() => new TokenBucket({ capacity: 0, refillPerSecond: 1 }), RangeError);
  assert.throws(() => new TokenBucket({ capacity: 1, refillPerSecond: 0 }), RangeError);
});

// -- the pacer ---------------------------------------------------------------

test('the first write is never delayed', () => {
  const pacer = new CardPacer({ minIntervalMs: 5000 });
  pacer.note(1);
  assert.deepEqual(pacer.poll(0), { action: PACE.flush, revision: 1, urgent: false });
});

test('nothing owed means idle', () => {
  const pacer = new CardPacer({ minIntervalMs: 100 });
  assert.deepEqual(pacer.poll(0), { action: PACE.idle });
});

test('THE bug this module exists for: the final update is not dropped', () => {
  const pacer = new CardPacer({ minIntervalMs: 1000 });

  pacer.note(1);
  assert.equal(pacer.poll(0).action, PACE.flush);
  pacer.settled(1, 0);

  // The last delta of the turn lands inside the cooldown and nothing follows it.
  pacer.note(2);
  const refused = pacer.poll(500);
  assert.equal(refused.action, PACE.wait);
  assert.equal(refused.afterMs, 500);
  assert.equal(refused.revision, 2, 'the owed revision is reported while waiting');

  // A leading-edge throttle would have dropped revision 2 for ever. This one
  // still owes it.
  assert.deepEqual(pacer.poll(1000), { action: PACE.flush, revision: 2, urgent: false });
});

test('pending is a high-water mark cleared only by settled, never by poll', () => {
  const pacer = new CardPacer({ minIntervalMs: 0 });
  pacer.note(4);
  assert.equal(pacer.poll(0).revision, 4);
  assert.equal(pacer.pending, 4, 'polling must not clear the debt');
  // The write failed or the process died; the next poll still owes it.
  assert.equal(pacer.poll(1).revision, 4);
  pacer.settled(4, 1);
  assert.equal(pacer.pending, null);
  assert.equal(pacer.written, 4);
  assert.equal(pacer.poll(2).action, PACE.idle);
});

test('coalescing keeps only the newest revision', () => {
  const pacer = new CardPacer({ minIntervalMs: 1000 });
  pacer.note(1);
  pacer.poll(0);
  pacer.settled(1, 0);

  for (let revision = 2; revision <= 50; revision += 1) pacer.note(revision);
  const flush = pacer.poll(1000);
  assert.equal(flush.action, PACE.flush);
  assert.equal(flush.revision, 50, 'the 48 intermediate states are coalesced away');
});

test('a revision that goes backwards cannot lower the debt', () => {
  const pacer = new CardPacer({ minIntervalMs: 0 });
  pacer.note(9);
  pacer.note(3);
  assert.equal(pacer.poll(0).revision, 9);
});

test('settled ahead of what was noted leaves nothing owed', () => {
  const pacer = new CardPacer({ minIntervalMs: 0 });
  pacer.note(5);
  pacer.settled(7, 0);
  assert.equal(pacer.poll(1).action, PACE.idle);
  assert.equal(pacer.written, 7);
});

test('urgent skips our own interval', () => {
  const pacer = new CardPacer({ minIntervalMs: 10000 });
  pacer.note(1);
  pacer.poll(0);
  pacer.settled(1, 0);

  pacer.note(2);
  assert.equal(pacer.poll(5).action, PACE.wait);
  pacer.note(3, { urgent: true });
  const flush = pacer.poll(5);
  assert.equal(flush.action, PACE.flush);
  assert.equal(flush.revision, 3);
  assert.equal(flush.urgent, true);
});

test('urgent does not skip the platform limit, which is not ours to skip', () => {
  const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1, now: 0 });
  const pacer = new CardPacer({ minIntervalMs: 10000, bucket });
  pacer.note(1);
  assert.equal(pacer.poll(0).action, PACE.flush);
  pacer.settled(1, 0);

  pacer.note(2, { urgent: true });
  const waited = pacer.poll(10);
  assert.equal(waited.action, PACE.wait);
  assert.ok(waited.afterMs > 0, 'the app-wide bucket still applies');
});

test('a bucket token is not spent on a flush the interval would have refused', () => {
  const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1, now: 0 });
  const pacer = new CardPacer({ minIntervalMs: 1000, bucket });
  pacer.note(1);
  pacer.poll(0);
  pacer.settled(1, 0);
  const afterFirst = bucket.level(0);

  pacer.note(2);
  assert.equal(pacer.poll(10).action, PACE.wait);
  assert.equal(pacer.poll(20).action, PACE.wait);
  assert.equal(bucket.level(0), afterFirst, 'refused polls must not drain the bucket');
});

test('a failure keeps the debt and honours a server-signalled backoff', () => {
  const pacer = new CardPacer({ minIntervalMs: 100 });
  pacer.note(1);
  assert.equal(pacer.poll(0).action, PACE.flush);

  pacer.failed(0, { retryAfterMs: 5000 });
  const waited = pacer.poll(100);
  assert.equal(waited.action, PACE.wait);
  assert.equal(waited.afterMs, 4900);
  assert.equal(waited.revision, 1, 'the update is still owed');
  assert.equal(pacer.poll(5000).action, PACE.flush);
});

test('a failure with no retry hint backs off by our own interval', () => {
  const pacer = new CardPacer({ minIntervalMs: 250 });
  pacer.note(1);
  pacer.poll(0);
  pacer.failed(0);
  assert.equal(pacer.poll(100).action, PACE.wait);
  assert.equal(pacer.poll(250).action, PACE.flush);
});

test('a success clears a backoff floor', () => {
  const pacer = new CardPacer({ minIntervalMs: 0 });
  pacer.note(1);
  pacer.poll(0);
  pacer.failed(0, { retryAfterMs: 10000 });
  pacer.settled(1, 0);
  pacer.note(2);
  assert.equal(pacer.poll(1).action, PACE.flush);
});

test('a pacer refuses a non-numeric revision rather than carrying NaN around', () => {
  const pacer = new CardPacer();
  assert.throws(() => pacer.note('3'), TypeError);
  assert.throws(() => pacer.note(Number.NaN), TypeError);
  assert.throws(() => pacer.settled(undefined), TypeError);
  assert.throws(() => new CardPacer({ minIntervalMs: -1 }), RangeError);
});

// -- deriving the pace from the platform limit -------------------------------

test('pacing splits the platform ceiling across concurrent cards', () => {
  const pacing = pacingFor({ updatesPerSecond: 10, concurrentCards: 2, reserveFraction: 0.25 });
  assert.equal(pacing.perCardPerSecond, 3.75);
  assert.equal(pacing.minIntervalMs, 267);
  assert.deepEqual(pacing.bucket, { capacity: 10, refillPerSecond: 10 });
});

test('pacing derived from the documented CardKit limit is legible on a phone', () => {
  const pacing = pacingFor({ updatesPerSecond: LARK_LIMITS.cardKitPerCardPerSecond });
  // 10/s minus a quarter reserve is 7.5/s, i.e. a redraw every ~134 ms.
  assert.equal(pacing.minIntervalMs, 134);
  assert.ok(pacing.perCardPerSecond < LARK_LIMITS.cardKitPerCardPerSecond);
});

test('pacing refuses nonsense rather than producing an interval of Infinity', () => {
  assert.throws(() => pacingFor({ updatesPerSecond: 0 }), RangeError);
  assert.throws(() => pacingFor({ updatesPerSecond: 10, concurrentCards: 0 }), RangeError);
  assert.throws(() => pacingFor({ updatesPerSecond: 10, reserveFraction: 1 }), RangeError);
});

test('a whole simulated turn stays inside the platform budget', () => {
  const pacing = pacingFor({ updatesPerSecond: LARK_LIMITS.cardKitPerCardPerSecond });
  const bucket = new TokenBucket({ ...pacing.bucket, now: 0 });
  const pacer = new CardPacer({ minIntervalMs: pacing.minIntervalMs, bucket });

  // 600 deltas arriving every 10 ms: six seconds of fast streaming.
  let writes = 0;
  let revision = 0;
  for (let tick = 0; tick <= 6000; tick += 10) {
    revision += 1;
    pacer.note(revision);
    const decision = pacer.poll(tick);
    if (decision.action === PACE.flush) {
      writes += 1;
      pacer.settled(decision.revision, tick);
    }
  }
  // Drain the tail, which is the update that matters most.
  let guard = 0;
  while (pacer.pending !== null && guard < 100) {
    const decision = pacer.poll(6000 + (guard + 1) * pacing.minIntervalMs);
    if (decision.action === PACE.flush) {
      writes += 1;
      pacer.settled(decision.revision, 0);
    }
    guard += 1;
  }

  assert.equal(pacer.written, revision, 'the last revision must reach the card');
  assert.ok(writes <= 6 * LARK_LIMITS.cardKitPerCardPerSecond, `${writes} writes exceeds the budget`);
  assert.ok(writes >= 20, `${writes} writes is too choppy to read`);
});
