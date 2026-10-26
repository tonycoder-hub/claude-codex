import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BACKOFF,
  DISCONNECT,
  backoffDelay,
  backoffSchedule,
  classifyDisconnect,
  nominalDelay,
} from '../../web/backoff.mjs';

test('the schedule doubles from half a second and settles at the ceiling', () => {
  assert.deepEqual(
    backoffSchedule(8),
    [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000],
  );
  assert.equal(nominalDelay(1), 500, 'the first retry is quick enough to feel like a blip');
  assert.equal(nominalDelay(7), DEFAULT_BACKOFF.maxMs, 'the cap is reached, not overshot');
});

test('the schedule is non-decreasing and never exceeds the cap', () => {
  let previous = 0;
  for (let attempt = 1; attempt <= 200; attempt += 1) {
    const delay = nominalDelay(attempt);
    assert.ok(delay >= previous, `attempt ${attempt} went backwards`);
    assert.ok(delay <= DEFAULT_BACKOFF.maxMs, `attempt ${attempt} exceeded the cap`);
    previous = delay;
  }
});

test('a huge attempt number stays a finite number at the cap', () => {
  // 2 ** 1000 overflows to Infinity; the cap has to absorb that rather than
  // handing setTimeout a NaN and reconnecting instantly for ever.
  for (const attempt of [500, 1000, 5000, Number.MAX_SAFE_INTEGER]) {
    const delay = nominalDelay(attempt);
    assert.ok(Number.isFinite(delay), `attempt ${attempt} produced ${delay}`);
    assert.equal(delay, DEFAULT_BACKOFF.maxMs);
  }
});

test('jitter stays inside its band, at both extremes of the random source', () => {
  // random() === 0 is the low edge, random() -> 1 the high edge.
  assert.equal(backoffDelay(1, DEFAULT_BACKOFF, () => 0), 375, '500 * 0.75');
  assert.equal(backoffDelay(1, DEFAULT_BACKOFF, () => 0.5), 500, 'the midpoint is the nominal delay');
  assert.equal(backoffDelay(1, DEFAULT_BACKOFF, () => 1), 625, '500 * 1.25');
  assert.equal(backoffDelay(3, DEFAULT_BACKOFF, () => 0), 1500, '2000 * 0.75');

  // At the cap, upward jitter must be clamped rather than exceeding the ceiling.
  assert.equal(backoffDelay(20, DEFAULT_BACKOFF, () => 1), DEFAULT_BACKOFF.maxMs);
  assert.equal(backoffDelay(20, DEFAULT_BACKOFF, () => 0), 22500, '30000 * 0.75');
});

test('every jittered delay lies within bounds for every attempt', () => {
  const { jitter, maxMs } = DEFAULT_BACKOFF;
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const nominal = nominalDelay(attempt);
    const low = Math.floor(nominal * (1 - jitter));
    for (let trial = 0; trial < 200; trial += 1) {
      const delay = backoffDelay(attempt);
      assert.ok(Number.isInteger(delay), `attempt ${attempt} gave a non-integer ${delay}`);
      assert.ok(delay >= low, `attempt ${attempt} gave ${delay}, below ${low}`);
      assert.ok(delay <= Math.min(maxMs, Math.ceil(nominal * (1 + jitter))), `attempt ${attempt} gave ${delay}`);
      assert.ok(delay <= maxMs, `attempt ${attempt} exceeded the cap with ${delay}`);
      assert.ok(delay > 0, 'a zero delay would be a hot reconnect loop');
    }
  }
});

test('a custom schedule is honoured, including a zero-jitter one', () => {
  const options = { baseMs: 100, factor: 3, maxMs: 1000, jitter: 0 };
  assert.deepEqual(backoffSchedule(5, options), [100, 300, 900, 1000, 1000]);
  assert.equal(backoffDelay(2, options, () => 0), 300, 'no jitter means exactly nominal');
  assert.equal(backoffDelay(2, options, () => 1), 300);
});

test('attempt numbering is 1-based and enforced', () => {
  // An off-by-one here would either skip the first delay or reconnect instantly.
  for (const bad of [0, -1, 1.5, NaN, Infinity, '1', null, undefined]) {
    assert.throws(() => nominalDelay(bad), RangeError, `${String(bad)} must be rejected`);
  }
});

test('the defaults cannot be mutated by a caller', () => {
  assert.throws(() => { DEFAULT_BACKOFF.maxMs = 1; }, TypeError);
  assert.equal(DEFAULT_BACKOFF.maxMs, 30_000);
});

// ---- what a closed socket means -------------------------------------------
//
// The surface refuses an unauthenticated upgrade with HTTP 401 *during the
// handshake*, and browsers hide the handshake response from JavaScript: the
// page sees close code 1006 with an empty reason, which is also exactly what a
// phone losing signal looks like. Guessing wrong is bad in both directions, so
// the caller supplies an HTTP reachability probe and this decides.

test('a policy close means the session is gone, however it arrived', () => {
  for (const code of [1008, 4401, 4403]) {
    assert.equal(
      classifyDisconnect({ everOpened: true, code }),
      DISCONNECT.reauth,
      `close ${code} must send the user back to sign in`,
    );
    // Also decisive before the socket opened, and regardless of reachability.
    assert.equal(classifyDisconnect({ everOpened: false, code, serverReachable: false }), DISCONNECT.reauth);
  }
});

test('an established connection that drops is a transport problem', () => {
  for (const code of [1000, 1001, 1006, 1011, 1012, 1013]) {
    assert.equal(
      classifyDisconnect({ everOpened: true, code }),
      DISCONNECT.retry,
      `close ${code} after a successful handshake is worth retrying`,
    );
  }
});

test('a refused handshake with the relay still answering HTTP is not retried blindly', () => {
  // The relay is up and would not take the socket: retrying on a 30-second
  // backoff against a session that will never come back is the wrong answer.
  assert.equal(
    classifyDisconnect({ everOpened: false, code: 1006, serverReachable: true }),
    DISCONNECT.refused,
  );
});

test('a refused handshake with the relay unreachable is a network problem', () => {
  // The opposite mistake: dumping the user on a login screen because a tunnel
  // blipped. Unknown reachability is treated the same way, because retrying is
  // the recoverable guess.
  assert.equal(
    classifyDisconnect({ everOpened: false, code: 1006, serverReachable: false }),
    DISCONNECT.retry,
  );
  assert.equal(
    classifyDisconnect({ everOpened: false, code: 1006, serverReachable: null }),
    DISCONNECT.retry,
  );
  assert.equal(classifyDisconnect(), DISCONNECT.retry, 'the default must be the recoverable one');
});

test('every verdict is one of the three the caller handles', () => {
  const verdicts = new Set();
  for (const everOpened of [true, false]) {
    for (const code of [1000, 1006, 1008, 4401, 1011]) {
      for (const serverReachable of [true, false, null]) {
        verdicts.add(classifyDisconnect({ everOpened, code, serverReachable }));
      }
    }
  }
  for (const verdict of verdicts) {
    assert.ok(Object.values(DISCONNECT).includes(verdict), `unhandled verdict ${verdict}`);
  }
});
