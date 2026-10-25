// Reconnect backoff.
//
// Pure and injectable so the schedule can be asserted rather than hoped for:
// the jitter source is a parameter, which is the only way to test "within
// bounds" without a flaky test or a sleep.

export const DEFAULT_BACKOFF = Object.freeze({
  baseMs: 500,
  factor: 2,
  maxMs: 30_000,
  // +/- 25%, so a phone that drops off a tunnel alongside other clients does not
  // bring them all back in lockstep.
  jitter: 0.25,
});

/** Nominal (un-jittered) delay before retry number `attempt`, 1-based. */
export function nominalDelay(attempt, { baseMs, factor, maxMs } = DEFAULT_BACKOFF) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError('attempt must be an integer >= 1');
  // Exponent on a float can overflow to Infinity for large attempts; min() with
  // the cap handles that correctly, so no special case is needed.
  return Math.min(maxMs, baseMs * factor ** (attempt - 1));
}

/**
 * Actual delay to wait, jitter applied. `random` must behave like Math.random
 * (0 <= r < 1). The result is clamped into [0, maxMs] so upward jitter can
 * never push a retry past the advertised ceiling.
 */
export function backoffDelay(attempt, options = DEFAULT_BACKOFF, random = Math.random) {
  const { maxMs, jitter } = options;
  const nominal = nominalDelay(attempt, options);
  const spread = 1 + jitter * (random() * 2 - 1);
  return Math.min(maxMs, Math.max(0, Math.round(nominal * spread)));
}

/** The first `count` nominal delays, for tests and for showing the user. */
export function backoffSchedule(count, options = DEFAULT_BACKOFF) {
  const out = [];
  for (let attempt = 1; attempt <= count; attempt += 1) out.push(nominalDelay(attempt, options));
  return out;
}

/** What to do about a socket that closed. */
export const DISCONNECT = Object.freeze({
  /** A transport problem. Back off and try again. */
  retry: 'retry',
  /** The relay said the session is no good. Retrying cannot fix it. */
  reauth: 'reauth',
  /** The relay is up and refused the upgrade, without saying why. */
  refused: 'refused',
});

/** Close codes that mean the session is the problem, so retrying is pointless. */
const AUTH_CLOSE_CODES = new Set([
  1008, // policyViolation -- what the relay sends when it closes on policy
  4401, // private-use "unauthorized", by convention
  4403, // private-use "forbidden"
]);

/**
 * Decide what a closed socket means.
 *
 * The awkward case this exists for: the relay refuses an unauthenticated
 * upgrade with HTTP 401 *during the handshake*, and browsers deliberately hide
 * the handshake response from JavaScript. All the page sees is an error event
 * and a close with code 1006 and an empty reason -- byte for byte what a phone
 * driving into a tunnel looks like. Guessing wrong either way is a bad failure:
 * guess "network" and the page backs off for half a minute at a time against a
 * session that will never come back; guess "session" and a brief signal drop
 * dumps the user on a login screen for no reason.
 *
 * So the caller supplies one extra fact -- can the relay still be reached over
 * plain HTTP -- and this function stays pure and testable.
 *
 * @param {object} event
 * @param {boolean} event.everOpened did the socket reach OPEN before closing?
 * @param {number} [event.code] the close code
 * @param {boolean|null} [event.serverReachable] HTTP probe result; null if unknown
 * @returns {'retry'|'reauth'|'refused'}
 */
export function classifyDisconnect({ everOpened = false, code = 1006, serverReachable = null } = {}) {
  // An established connection that was closed on policy is unambiguous: the
  // relay had a session, decided against it, and said so in the close frame.
  if (AUTH_CLOSE_CODES.has(code)) return DISCONNECT.reauth;

  // Anything else that happened after a successful handshake is a transport
  // event, including a clean 1000: the relay restarting is worth reconnecting
  // to, and a session that is still valid will be accepted again.
  if (everOpened) return DISCONNECT.retry;

  // The handshake itself failed. If the relay is answering HTTP, it is up and
  // chose to refuse this socket -- overwhelmingly an expired session, though a
  // relay with no upstream configured answers 503 and looks identical here, so
  // the verdict is named for what is actually known.
  if (serverReachable === true) return DISCONNECT.refused;

  // Unreachable, or not probed: assume the network and keep trying.
  return DISCONNECT.retry;
}
