// The handshake, tested on the three ways it can go wrong quietly.
//
// There is only one success path here and it is one test. The rest are the
// failures that produce no error message of their own: a port that was started
// before the session attached to it (first message silently dropped), a
// handshake nobody answered (renderer waits forever on `await services`, clean
// console), and a second handshake that quietly replaces a working session.
// None of those three throw in production, which is why they are pinned here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installHandshake } from '../../web/host-handshake.mjs';
import { makeWindow, postFromForeignSource, recordingPort } from './host-fakes.mjs';

/** Post the handshake exactly as app-shared.js does. */
function connect(window, port) {
  return window.postMessage({ type: 'connect-app-host', port }, window.location.origin, [port]);
}

function harness({ createSession, services } = {}) {
  const window = makeWindow();
  const events = [];
  const calls = [];
  const factory =
    createSession === undefined
      ? (port, mainObject) => {
          calls.push({ port, mainObject });
          return { closed: false };
        }
      : createSession;
  const handle = installHandshake({
    window,
    createSession: factory,
    services,
    onEvent: (event) => events.push(event),
  });
  return { window, handle, events, calls };
}

// ---- port.start() is the expensive mistake ---------------------------------

test('the port is never started before it is handed to the session factory', () => {
  // capnweb's MessagePort transport calls start() itself and attaches its
  // listener on the next line. Starting it here flushes the peer's already
  // queued first message to a port with no listeners, and it is gone. Nothing
  // throws; the conversation just begins one message late, forever.
  const { window, handle, calls } = harness();
  const port = recordingPort();
  connect(window, port);

  assert.equal(port.started, 0, 'nothing in this repo may call port.start()');
  assert.equal(handle.status, 'answered');
  assert.equal(calls[0].port, port, 'and the port is handed over un-started');
});

test('the port is still un-started after the factory has had it', () => {
  const started = [];
  const { window } = harness({
    createSession: (port) => {
      started.push(port.started);
      return {};
    },
  });
  const port = recordingPort();
  connect(window, port);
  assert.deepEqual(started, [0], 'the factory receives a port nobody has touched');
});

test('the handshake listener never posts to the port itself', () => {
  const { window } = harness();
  const port = recordingPort();
  connect(window, port);
  assert.deepEqual(port.posted, [], 'speaking on the port is capnweb\'s job, not ours');
  assert.deepEqual(port.listeners, [], 'and so is listening on it');
  assert.equal(port.closed, false);
});

// ---- an unanswered handshake must be visible -------------------------------

test('with no session factory the handshake is recorded, not dropped', () => {
  const window = makeWindow();
  const handle = installHandshake({ window });
  connect(window, recordingPort());

  assert.equal(handle.status, 'unanswered');
  assert.equal(handle.seenCount, 1, 'it arrived');
  assert.equal(handle.session, null, 'and nothing pretends it was answered');
  assert.match(handle.reason, /factory/, 'the reason must say why');
  assert.equal(handle.record.answered, false);
});

test('an unanswered handshake reports through onEvent as well as on the handle', () => {
  const window = makeWindow();
  const events = [];
  installHandshake({ window, onEvent: (event) => events.push(event) });
  connect(window, recordingPort());
  assert.deepEqual(events.map((e) => e.kind), ['unanswered']);
  assert.match(events[0].reason, /factory/);
});

test('a handshake carrying no port is reported separately from a missing factory', () => {
  const { window, handle } = harness();
  window.postMessage({ type: 'connect-app-host' }, window.location.origin);
  assert.equal(handle.status, 'unanswered');
  assert.match(handle.reason, /no port/);
  assert.equal(handle.seenCount, 1);
});

test('before anything arrives the status is waiting, not answered', () => {
  const { handle } = harness();
  assert.equal(handle.status, 'waiting');
  assert.equal(handle.seenCount, 0);
  assert.equal(handle.session, null);
  assert.equal(handle.reason, null);
});

// ---- a second handshake must not open a second session ---------------------

test('a second handshake does not create a second session', () => {
  const { window, handle, calls } = harness();
  const first = recordingPort();
  const second = recordingPort();
  connect(window, first);
  connect(window, second);

  assert.equal(calls.length, 1, 'exactly one session, ever');
  assert.equal(calls[0].port, first, 'and it is the first port, not the last');
  // seenCount counts ARRIVALS, not acceptances: that the renderer handshook
  // twice is the interesting fact, and it would vanish if the counter only
  // moved on success. ignoredCount is how many of those were refused.
  assert.equal(handle.seenCount, 2, 'both arrivals stay visible');
  assert.equal(handle.ignoredCount, 1, 'the duplicate is counted, not invisible');
  assert.equal(handle.seenCount - handle.ignoredCount, 1, 'exactly one was acted on');
  assert.equal(handle.status, 'answered');
});

test('the duplicate is reported through onEvent', () => {
  const { window, events } = harness();
  connect(window, recordingPort());
  connect(window, recordingPort());
  assert.deepEqual(events.map((e) => e.kind), ['answered', 'duplicate']);
});

test('a duplicate arriving after an UNANSWERED handshake is still refused', () => {
  // The tempting bug: treat "no session yet" as "still available".
  const window = makeWindow();
  const handle = installHandshake({ window });
  connect(window, recordingPort());
  connect(window, recordingPort());
  assert.equal(handle.seenCount, 2);
  assert.equal(handle.ignoredCount, 1);
  assert.equal(handle.status, 'unanswered', 'and it does not get retried into a session');
});

// ---- the sender check ------------------------------------------------------

test('a connect-app-host from another source is refused and counted', () => {
  const { window, handle, calls, events } = harness();
  postFromForeignSource(window, { type: 'connect-app-host', port: recordingPort() });

  assert.equal(calls.length, 0, 'a frame or extension does not get to hand us a port');
  assert.equal(handle.refusedCount, 1, 'the refusal is observable');
  assert.equal(handle.seenCount, 0, 'and it does not consume the one real handshake');
  assert.equal(handle.status, 'waiting');
  assert.deepEqual(events.map((e) => e.kind), ['refused-foreign-source']);
});

test('a refused foreign handshake leaves the real one still possible', () => {
  const { window, handle, calls } = harness();
  postFromForeignSource(window, { type: 'connect-app-host', port: recordingPort() });
  connect(window, recordingPort());
  assert.equal(calls.length, 1);
  assert.equal(handle.status, 'answered');
});

test('unrelated window messages are ignored without counting as anything', () => {
  const { window, handle, calls } = harness();
  window.postMessage({ type: 'mcp-response', hostId: 'local', message: { id: 1, result: 1 } });
  window.postMessage({ type: 'connect-app-host-but-not-really', port: recordingPort() });
  window.postMessage('a string');
  window.postMessage(null);
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'mcp-notification' } }));

  assert.equal(calls.length, 0);
  assert.equal(handle.seenCount, 0);
  assert.equal(handle.refusedCount, 0);
  assert.equal(handle.status, 'waiting');
});

// ---- the main object -------------------------------------------------------

test('the session factory gets a main object exposing services', async () => {
  const services = { app: { ping: () => 'pong' } };
  const { window, calls } = harness({ services });
  connect(window, recordingPort());

  const { mainObject } = calls[0];
  assert.equal(mainObject.services, services);
  // `await r6.services` is what the renderer does; a plain property resolves.
  assert.equal(await mainObject.services, services);
});

test('services defaults to an empty object, which is enough to unblock boot', async () => {
  // Every consumer of `services` is `!= null` guarded and the final property
  // read off it is dead, so {} is a complete answer -- but undefined is not.
  const { window, calls, handle } = harness();
  connect(window, recordingPort());
  assert.deepEqual(calls[0].mainObject.services, {});
  assert.notEqual(calls[0].mainObject.services, undefined);
  assert.notEqual(await handle.mainObject.services, null);
});

test('the factory is called with exactly two arguments, port first', () => {
  const seen = [];
  const { window } = harness({ createSession: (...args) => { seen.push(args); return {}; } });
  const port = recordingPort();
  connect(window, port);
  assert.equal(seen[0].length, 2);
  assert.equal(seen[0][0], port);
  assert.equal(typeof seen[0][1], 'object');
});

// ---- a throwing factory ----------------------------------------------------

test('a factory that throws is recorded rather than escaping the listener', () => {
  const boom = new Error('capnweb said no');
  const { window, handle, events } = harness({ createSession: () => { throw boom; } });

  // A throw out of a window listener becomes an unhandled error nowhere near
  // anything that could act on it, so it is caught and kept.
  assert.doesNotThrow(() => connect(window, recordingPort()));
  assert.equal(handle.status, 'failed');
  assert.equal(handle.error, boom);
  assert.match(handle.reason, /capnweb said no/);
  assert.equal(handle.session, null);
  assert.deepEqual(events.map((e) => e.kind), ['failed']);
});

test('an onEvent that throws does not take the handshake down with it', () => {
  const window = makeWindow();
  const handle = installHandshake({
    window,
    createSession: () => ({ ok: true }),
    onEvent: () => { throw new Error('observer blew up'); },
  });
  assert.doesNotThrow(() => connect(window, recordingPort()));
  assert.equal(handle.status, 'answered');
});

// ---- the success path and teardown -----------------------------------------

test('a handshake with a factory yields a session and a clean record', () => {
  const session = { id: 'session' };
  const { window, handle } = harness({ createSession: () => session });
  connect(window, recordingPort());

  assert.equal(handle.status, 'answered');
  assert.equal(handle.session, session);
  assert.equal(handle.reason, null);
  assert.deepEqual({ ...handle.record }, {
    status: 'answered',
    reason: null,
    seenCount: 1,
    ignoredCount: 0,
    refusedCount: 0,
    answered: true,
  });
});

test('the record is frozen, so a reader cannot rewrite history', () => {
  const { window, handle } = harness();
  connect(window, recordingPort());
  assert.throws(() => { handle.record.status = 'unanswered'; }, TypeError);
});

test('unsubscribe stops the listener, and is idempotent', () => {
  const { window, handle, calls } = harness();
  handle.unsubscribe();
  connect(window, recordingPort());
  assert.equal(calls.length, 0);
  assert.equal(handle.seenCount, 0);
  assert.equal(handle.listening, false);
  assert.doesNotThrow(() => handle.unsubscribe());
});

test('the listener stays subscribed after answering, so duplicates stay countable', () => {
  const { window, handle } = harness();
  connect(window, recordingPort());
  assert.equal(handle.listening, true, 'unsubscribing on success would hide a second handshake');
});

test('install refuses a missing window', () => {
  assert.throws(() => installHandshake(), /window/);
  assert.throws(() => installHandshake({ window: null }), /window/);
});
