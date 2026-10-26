// Answering the renderer's `connect-app-host` handshake.
//
// Early in boot the renderer opens a MessageChannel, keeps port1, and posts
// port2 to its OWN window:
//
//   window.postMessage({ type: 'connect-app-host', port: port2 },
//                      window.location.origin, [port2])
//
// then speaks capnweb over port1 and awaits `session.services`. Note who
// creates the channel: the renderer does. We are not opening a connection, we
// are picking up a port that has been left on the doorstep for whoever is
// listening. In Electron that is the preload script. Here it is this module.
//
// WHY THIS MATTERS MORE THAN IT LOOKS: `await services` has no timeout. If
// nobody answers, the renderer does not fail, retry, or log -- it waits
// forever, and what you see is a UI that got most of the way through boot and
// then stopped, with a clean console. That failure is indistinguishable from a
// dozen others, which is why this module keeps a record instead of just
// working or not: an unanswered handshake is reported as unanswered, with a
// reason, so the next person does not spend an afternoon on it.
//
// ANSWERING WITH `{}` IS NOT ENOUGH, and the sentence that used to stand here
// saying it was is worth leaving a scar for. It was carefully reasoned and
// narrowly true: the five consumers of the `services` OBJECT really do guard
// it with `!= null`. What it never asked is whether anything guards what is
// INSIDE it. Nothing does, for 8 of the renderer's 125 namespaces, and the
// empty default took the real page to its error boundary at first paint.
//
// The general shape of the mistake: a guard on a container says nothing about
// its fields, and `{}` is the one answer that satisfies every `!= null` check
// while supplying none of what those checks were protecting. web/host-fetch.mjs
// learned the same lesson independently, one layer down, and its SHAPED_EMPTY
// table is the same correction.
//
// `services` is a parameter for exactly this reason. web/host-namespaces.mjs
// builds the real object and web/host-boot.mjs wires the two together. `{}`
// survives only as the DEFAULT, because an unanswered handshake is strictly
// worse than a thin one -- see the paragraph above: no timeout, no retry, no
// log, a startup logo forever.
//
// NEVER CALL port.start() -- this has already cost us once.
//
// It is the obvious thing to do with a freshly received MessagePort and it
// silently destroys the session. capnweb's MessagePort transport calls
// `start()` itself and attaches its `message` listener synchronously on the
// next line. Starting the port before handing it over flushes the queue
// immediately, so the peer's already-queued FIRST message is dispatched to a
// port with no listeners yet and is dropped on the floor. Nothing throws. The
// port is live, the session exists, and the opening message of the
// conversation is simply gone. There is no `port.start()` anywhere in this
// file and there must not be one.
//
// The capnweb session factory is injected rather than imported. Finding the
// bundler's copy of capnweb and reaching into it is a rabbit hole with a
// version-coupling problem at the bottom of it; whoever wires this up supplies
// `createSession(port, mainObject)`. Until then the factory is null, and a
// handshake arrives, is recorded as unanswered, and says why -- which is a far
// better state than a module that pretends it connected.

import { CONNECT_APP_HOST } from './host-protocol.mjs';

/** What `status` can be. */
export const HANDSHAKE_STATUS = Object.freeze({
  waiting: 'waiting',
  answered: 'answered',
  unanswered: 'unanswered',
  failed: 'failed',
});

/**
 * Listen for the renderer's handshake and answer it.
 *
 * @param {{
 *   window: object,
 *   createSession?: ((port: object, mainObject: object) => object) | null,
 *   services?: object,
 *   onEvent?: ((event: {kind: string, reason?: string}) => void) | null,
 * }} args
 */
export function installHandshake({
  window,
  createSession = null,
  services = {},
  onEvent = null,
} = {}) {
  if (!window || typeof window !== 'object') {
    throw new TypeError('installHandshake: a window is required');
  }

  // The object the renderer reaches across the port for. `services` is a plain
  // property: `await` on a non-promise resolves it, so there is nothing to gain
  // from wrapping it and a getter would just be a place for a throw to hide.
  const mainObject = { services };

  let status = HANDSHAKE_STATUS.waiting;
  let reason = null;
  let session = null;
  let error = null;
  let seenCount = 0;
  let ignoredCount = 0;
  let refusedCount = 0;
  let listening = true;

  const report = (kind, detail) => {
    if (typeof onEvent !== 'function') return;
    try {
      onEvent({ kind, ...detail });
    } catch {
      // An observer that throws must not take the handshake down with it.
    }
  };

  const settleUnanswered = (why) => {
    status = HANDSHAKE_STATUS.unanswered;
    reason = why;
    report('unanswered', { reason: why });
  };

  function onMessage(event) {
    const data = event?.data;
    if (!data || typeof data !== 'object' || data.type !== CONNECT_APP_HOST) return;

    // The renderer posts this to itself, so the only legitimate sender is this
    // same window. Anything else is a frame or an extension offering us a port,
    // and it is counted rather than ignored -- a refusal nobody can see is the
    // same as no check at all.
    //
    // The type is checked before the sender on purpose: that ordering is what
    // makes a foreign handshake countable instead of invisible.
    if (event.source !== window) {
      refusedCount += 1;
      report('refused-foreign-source', {});
      return;
    }

    seenCount += 1;
    if (seenCount > 1) {
      // A second channel would leave the first one connected and unreferenced,
      // with two sessions racing to answer the same `services` await. The
      // duplicate is counted and dropped; the first session stands.
      ignoredCount += 1;
      report('duplicate', {});
      return;
    }

    const port = data.port;
    if (!port || typeof port !== 'object') {
      settleUnanswered('the connect-app-host message carried no port');
      return;
    }
    if (typeof createSession !== 'function') {
      settleUnanswered('no capnweb session factory was injected; the handshake went unanswered');
      return;
    }

    try {
      // Straight through, un-started. See the header.
      session = createSession(port, mainObject);
      status = HANDSHAKE_STATUS.answered;
      reason = null;
      report('answered', {});
    } catch (caught) {
      status = HANDSHAKE_STATUS.failed;
      error = caught;
      reason = `the capnweb session factory threw: ${caught?.message ?? caught}`;
      report('failed', { reason });
      // Not rethrown: this runs inside a window listener, where a throw becomes
      // an unhandled error far from anything that could act on it. The record
      // is the report.
    }
  }

  window.addEventListener('message', onMessage);

  return {
    /**
     * Stop listening. Note that this is NOT called automatically once a session
     * is established -- staying subscribed is what lets a second handshake be
     * counted instead of passing unseen.
     */
    unsubscribe: () => {
      if (!listening) return;
      listening = false;
      window.removeEventListener('message', onMessage);
    },
    get listening() {
      return listening;
    },
    get status() {
      return status;
    },
    get reason() {
      return reason;
    },
    get session() {
      return session;
    },
    get error() {
      return error;
    },
    get mainObject() {
      return mainObject;
    },
    /**
     * How many `connect-app-host` messages arrived from this window --
     * ARRIVALS, not acceptances. A second handshake still moves this, because
     * the fact that the renderer handshook twice is the interesting one and it
     * would disappear if the counter only advanced on success. The number
     * actually acted on is `seenCount - ignoredCount`, and it is never above 1.
     */
    get seenCount() {
      return seenCount;
    },
    /** How many arrivals were refused as duplicates of the first. */
    get ignoredCount() {
      return ignoredCount;
    },
    get refusedCount() {
      return refusedCount;
    },
    /** A flat snapshot, for logging or for an assertion that wants one object. */
    get record() {
      return Object.freeze({
        status,
        reason,
        seenCount,
        ignoredCount,
        refusedCount,
        answered: status === HANDSHAKE_STATUS.answered,
      });
    },
  };
}
