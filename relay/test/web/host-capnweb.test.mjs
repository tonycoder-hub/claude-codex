// The capnweb host, tested against the frames a real renderer actually sent.
//
// The whole value of this module is that it answers a measured wire rather
// than calling a minified export, so the tests are written as that wire: the
// exact four frames recorded off a live boot, in order, with the reply compared
// byte for byte. A test that drove it through some friendlier helper API would
// be testing our idea of capnweb instead of capnweb.
//
// The failure this module exists to prevent does not throw. An unanswered pull
// leaves a promise in the renderer that never settles -- no error, no timeout,
// no log, just a UI stopped halfway through boot. So several tests below assert
// that something was SENT, not merely that nothing blew up.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCapnwebSession } from '../../web/host-capnweb.mjs';
import { recordingPort } from './host-fakes.mjs';

/** The renderer's opening move, verbatim from the recording. */
const PUSH_SERVICES = ['push', ['pipeline', 0, ['services']]];
const PULL_1 = ['pull', 1];
const RELEASE_1 = ['release', 1, 1];

function session({ services, main } = {}) {
  const port = recordingPort();
  const events = [];
  const handle = createCapnwebSession(port, main ?? { services: services ?? {} }, {
    onEvent: (event) => events.push(event),
  });
  return { port, handle, events, kinds: () => events.map((e) => e.kind) };
}

test('the measured boot sequence is answered exactly once, with an empty services object', () => {
  const { port, handle } = session();

  port.deliver(PUSH_SERVICES);
  assert.deepEqual(port.posted, [], 'push alone asks for nothing; pull is what asks');

  port.deliver(PULL_1);
  assert.deepEqual(port.posted, [['resolve', 1, {}]]);

  port.deliver(RELEASE_1);
  assert.deepEqual(port.posted, [['resolve', 1, {}]], 'release is bookkeeping, not a question');

  assert.deepEqual(handle.stats(), {
    resolved: 1, rejected: 0, unhandled: 0, called: 0, threw: 0, exported: 0,
  }, 'an empty services object exports nothing, so no capability is minted');
});

test('the port is never started by hand', () => {
  // capnweb's own transport calls start() and attaches its listener on the next
  // line. Starting a port before a listener exists flushes whatever is already
  // queued on it into nothing, silently -- which is how the first attempt at
  // this seam lost the renderer's opening frame. Assigning onmessage starts the
  // port and installs the listener in one step, so there is nothing to order.
  const { port } = session();
  assert.equal(port.started, 0);
  assert.equal(typeof port.onmessage, 'function');
});

test('the session is listening before it returns', () => {
  // The renderer posts its first frame immediately after transferring the port,
  // so anything deferred here -- a promise, a microtask, a dynamic import --
  // is a race. This is the regression test for the version that awaited an
  // import() of the bundle's own capnweb before it could listen.
  const port = recordingPort();
  const handle = createCapnwebSession(port, { services: {} });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);
  assert.deepEqual(port.posted, [['resolve', 1, {}]]);
  handle.close();
});

test('what the host serves is what the caller passed, not a hardcoded blank', () => {
  const services = { somethingLater: true };
  const { port } = session({ services });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);
  assert.deepEqual(port.posted, [['resolve', 1, services]]);
});

test('a main object with no services still answers, because silence is worse', () => {
  const { port } = session({ main: {} });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);
  assert.deepEqual(port.posted, [['resolve', 1, {}]]);
});

test('ids are allocated per push, in order, and pulls are answered against their own path', () => {
  // Two pushes outstanding at once, pulled out of order. If ids were assumed
  // rather than tracked -- say, always 1 -- this is the test that fails.
  const { port } = session();
  port.deliver(PUSH_SERVICES);
  port.deliver(['push', ['pipeline', 0, ['somethingElse']]]);

  port.deliver(['pull', 2]);
  port.deliver(['pull', 1]);

  assert.deepEqual(port.posted, [
    ['reject', 2, { message: 'this host serves only `services` on the main object' }],
    ['resolve', 1, {}],
  ]);
});

test('a path we do not serve is rejected rather than ignored', () => {
  // A rejection surfaces in the renderer as an error somebody can read. Silence
  // surfaces as a promise that never settles, which is the one outcome this
  // module exists to avoid.
  const { port, handle, kinds } = session();
  port.deliver(['push', ['pipeline', 0, ['fileSystem']]]);
  port.deliver(['pull', 1]);

  assert.equal(port.posted.length, 1);
  assert.equal(port.posted[0][0], 'reject');
  assert.equal(handle.stats().rejected, 1);
  assert.ok(kinds().includes('rejected'));
});

test('a pull for an id that was never pushed is refused, not dropped', () => {
  const { port, handle } = session();
  port.deliver(['pull', 7]);
  assert.deepEqual(port.posted, [['reject', 7, { message: 'nothing was pushed under id 7' }]]);
  assert.equal(handle.stats().rejected, 1);
});

test('a pull is answered once; a repeat does not resolve twice', () => {
  // The renderer releases the export after consuming it. A second pull for the
  // same id is therefore not a retry, it is a bug somewhere -- and answering it
  // with `services` again would hide that.
  const { port } = session();
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);
  port.deliver(PULL_1);

  assert.equal(port.posted.length, 2);
  assert.deepEqual(port.posted[0], ['resolve', 1, {}]);
  assert.equal(port.posted[1][0], 'reject');
});

test('frames that are not this protocol are named, not swallowed', () => {
  const { port, handle, events } = session();
  port.deliver('a string');
  port.deliver({ not: 'an array' });
  port.deliver(['abort', 'peer went away']);

  assert.deepEqual(port.posted, []);
  assert.equal(handle.stats().unhandled, 3);
  assert.deepEqual(
    events.filter((e) => e.kind.startsWith('frame-')).map((e) => e.kind),
    ['frame-unrecognised', 'frame-unrecognised', 'frame-unhandled'],
  );
  assert.equal(events.find((e) => e.kind === 'frame-unhandled').op, 'abort');
});

test('a release for an id nobody pushed is reported rather than throwing', () => {
  const { port, handle, kinds } = session();
  port.deliver(['release', 99, 1]);
  assert.deepEqual(port.posted, []);
  assert.ok(kinds().includes('release'));
  assert.equal(handle.stats().unhandled, 0, 'release is understood, just uninteresting');
});

test('closing stops answering and closes the port', () => {
  const { port, handle } = session();
  handle.close();

  assert.equal(port.closed, true);
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);
  assert.deepEqual(port.posted, [], 'a closed session answers nothing');
});

test('closing twice is a no-op', () => {
  const { port, handle } = session();
  handle.close();
  handle.close();
  assert.equal(port.closed, true);
});

test('a port that throws on postMessage does not take the listener down', () => {
  // A neutered or closed port throws from postMessage. That happens inside a
  // port event listener, where a throw goes nowhere useful, so it is reported
  // instead -- and the session stays alive for whatever comes next.
  const port = recordingPort();
  port.postMessage = () => {
    throw new Error('port is closed');
  };
  const events = [];
  const handle = createCapnwebSession(port, { services: {} }, { onEvent: (e) => events.push(e) });

  port.deliver(PUSH_SERVICES);
  assert.doesNotThrow(() => port.deliver(PULL_1));
  assert.ok(events.some((e) => e.kind === 'send-failed'));
  handle.close();
});

test('an observer that throws does not take the session down', () => {
  const port = recordingPort();
  createCapnwebSession(port, { services: {} }, {
    onEvent: () => {
      throw new Error('observer is broken');
    },
  });
  port.deliver(PUSH_SERVICES);
  assert.doesNotThrow(() => port.deliver(PULL_1));
  assert.deepEqual(port.posted, [['resolve', 1, {}]], 'the answer still went out');
});

test('a session needs a port', () => {
  assert.throws(() => createCapnwebSession(null, {}), /MessagePort is required/);
  assert.throws(() => createCapnwebSession({}, {}), /MessagePort is required/);
});

test('it plugs into installHandshake as the createSession seam', async () => {
  // The two modules are written to fit, so prove they fit: a real handshake,
  // answered by this session, with the renderer's own frames behind it.
  const { installHandshake } = await import('../../web/host-handshake.mjs');
  const { makeWindow } = await import('./host-fakes.mjs');

  const window = makeWindow();
  const services = { marker: 'from the handshake' };
  installHandshake({
    window,
    services,
    createSession: (port, mainObject) => createCapnwebSession(port, mainObject),
  });

  const port = recordingPort();
  window.postMessage({ type: 'connect-app-host', port }, window.location.origin, [port]);

  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);
  assert.deepEqual(port.posted, [['resolve', 1, services]]);
});


// ---------------------------------------------------------------------------
// Callable namespaces.
//
// Everything above this line is the boot handshake, which an empty object
// answers. Everything below is what one driven turn proved is also required:
// the resolved `services` object is a long-lived singleton that the app
// dereferences from 125 namespaces, 8 of which are NOT null-guarded at their
// call sites. Serving those means serving functions, and a function cannot
// cross this wire by value -- it crosses as a capability, and the renderer
// then calls it. These tests are that round trip.
// ---------------------------------------------------------------------------

/**
 * The frame a renderer sends to call a member capability.
 *
 * The path is EMPTY, because each callable member is exported on its own: the
 * stub the renderer holds IS the method, and the proxy's `apply` trap sends
 * `r.pathIfPromise || []` (app-shared @2171311).
 */
const callMember = (id, args) =>
  ['push', ['pipeline', id, [], args === undefined ? undefined : [args]]];

test('each callable member crosses as its own capability, inside a plain namespace', () => {
  const { port, handle } = session({ services: { clipboard: { writeText: () => true } } });

  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);

  // NOT `{clipboard: ['export', -1]}`. The namespace stays a plain object and
  // only `writeText` becomes a capability.
  assert.deepEqual(port.posted, [['resolve', 1, { clipboard: { writeText: ['export', -1] } }]]);
  assert.equal(handle.stats().exported, 1);
});

test('a member we do not serve is simply absent, so the peer reads it as undefined', () => {
  // The reason per-member export exists, in one assertion. If the namespace
  // crossed whole, the peer's stub proxy would answer `.write` with a stub and
  // `y7r` (app-initial @4024515) would run
  //   `let r = Se.workspaceFiles.write; if (r != null) return async (...) => r({…})`
  // -- `_7r` then sets `isWritable: true` and `v7r` writes that into the MCP
  // resource's `_meta`, telling the model the user's file is writable. We have
  // no filesystem. A missing key is the honest answer and the only one the
  // renderer can act on correctly.
  const { port } = session({ services: { workspaceFiles: { read: () => 'x' } } });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);

  const frame = port.posted[0][2];
  assert.deepEqual(Object.keys(frame.workspaceFiles), ['read']);
  assert.equal('write' in frame.workspaceFiles, false);
});

test('a namespace of several callables keeps its shape, one capability per member', () => {
  const { port, handle } = session({
    services: { openIn: { getTargets: () => [], open: () => ({ success: false }) } },
  });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);

  assert.deepEqual(port.posted, [['resolve', 1, {
    openIn: { getTargets: ['export', -1], open: ['export', -2] },
  }]]);
  assert.equal(handle.stats().exported, 2);
});

test('a capability id is negative, because the peer allocates the non-negative ones', () => {
  // Read out of app-shared: `exportStub` uses `this.nextExportId--` seeded at
  // -1, while push-allocated exports come from `this.exports.push(...)` and so
  // count up from 0. Handing out a positive id here would alias one of the
  // renderer's own pushes -- a misrouting that no amount of testing on our
  // side would catch, because both ends would be internally consistent.
  const { port } = session({
    services: { a: { f: () => 1 }, b: { g: () => 2 }, c: { h: () => 3 } },
  });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);

  const ids = Object.values(port.posted[0][2]).map((ns) => Object.values(ns)[0][1]);
  assert.deepEqual(ids, [-1, -2, -3]);
  assert.ok(ids.every((id) => id < 0));
});

test('a data-only namespace still crosses by value, so unimplemented ones stay undefined', () => {
  // This is the regression guard for the 60 namespaces we do NOT serve. The
  // renderer's own `dei()` does `i6.threadReadState != null && await ...`, so
  // every namespace absent from `services` must read as `undefined` on the
  // other side. Exporting a capability for an empty object would make all 60
  // of those guards pass and send the app down initialisation paths with
  // nothing behind them.
  const { port } = session({ services: { host_flags: { enabled: true }, nested: { n: { deep: 1 } } } });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);

  assert.deepEqual(port.posted, [['resolve', 1, {
    host_flags: { enabled: true },
    nested: { n: { deep: 1 } },
  }]]);
});

test('an array in a served value is escaped, because a bare array is the expression syntax', () => {
  const { port } = session({ services: { openIn: { targets: ['vscode', 'finder'] } } });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);
  assert.deepEqual(port.posted, [['resolve', 1, { openIn: { targets: [['vscode', 'finder']] } }]]);
});

test('a call runs on push, before any pull -- which is what makes fire-and-forget work', () => {
  // The peer evaluates on push (`this.exports.push({hook: new wI(...evaluate(n[1]))})`)
  // and so must we. Almost every host call in the app discards its result and
  // is never pulled: `setConversationPresented?.({...})` is the one that
  // crashed the page. If evaluation waited for a pull, fixing the crash would
  // produce a method that is reachable and never runs.
  const seen = [];
  const { port, handle } = session({
    services: { requestUserInputAutoResolution: { setConversationPresented: (arg) => { seen.push(arg); } } },
  });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);
  port.posted.length = 0;

  port.deliver(callMember(-1, { conversationId: 'c1', presented: true }));

  assert.deepEqual(seen, [{ conversationId: 'c1', presented: true }], 'ran on push');
  assert.deepEqual(port.posted, [], 'and sent nothing, because nothing was asked for');
  assert.equal(handle.stats().called, 1);
});

test('call arguments are decoded out of the escaped-array form', () => {
  // `sendCall` devaluates the argument LIST, and `devaluateImpl` encodes an
  // array by wrapping it. So two arguments arrive as `[[a, b]]`, and reading
  // that as a single array-shaped first argument would hand every stub in the
  // app the wrong arity.
  const calls = [];
  const { port } = session({ services: { ns: { m: (...args) => { calls.push(args); } } } });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);

  port.deliver(['push', ['pipeline', -1, [], [['first', 2, { k: true }]]]]);
  assert.deepEqual(calls, [['first', 2, { k: true }]]);

  port.deliver(['push', ['pipeline', -1, [], [[]]]]);
  assert.deepEqual(calls[1], [], 'a no-argument call is an empty list, not [undefined]');
});

test('a nested array argument survives one level of unwrapping', () => {
  const calls = [];
  const { port } = session({ services: { ns: { m: (...args) => { calls.push(args); } } } });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);

  // One argument which is itself an array: the list wraps, then the member wraps.
  port.deliver(['push', ['pipeline', -1, [], [[[['a', 'b']]]]]]);
  assert.deepEqual(calls, [[['a', 'b']]]);
});

test('a returned value is sent when pulled, encoded the same way as services', async () => {
  const { port } = session({ services: { appInfo: { get: () => ({ version: '1.2.3', flavor: 'prod' }) } } });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);
  port.posted.length = 0;

  port.deliver(['push', ['pipeline', -1, [], [[]]]]);
  port.deliver(['pull', 2]);
  assert.deepEqual(port.posted, [['resolve', 2, { version: '1.2.3', flavor: 'prod' }]]);
});

test('an async stub is awaited rather than sent as a promise', async () => {
  // A promise cannot be structure-cloned. Posting one raises DataCloneError on
  // the port, which this module catches -- so the visible symptom would be a
  // pull that never settles, i.e. exactly the hang the module exists to avoid.
  const { port, kinds } = session({
    services: { workspaceFiles: { read: async () => 'contents' } },
  });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);
  port.posted.length = 0;

  port.deliver(['push', ['pipeline', -1, [], [['/some/path']]]]);
  port.deliver(['pull', 2]);
  assert.deepEqual(port.posted, [], 'nothing is sent until the promise settles');
  assert.ok(kinds().includes('awaiting'));

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(port.posted, [['resolve', 2, 'contents']]);
});

test('a rejected async stub becomes a reject frame, not an unsettled pull', async () => {
  const { port, handle } = session({
    services: { workspaceFiles: { read: async () => { throw new Error('ENOENT'); } } },
  });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);
  port.posted.length = 0;

  port.deliver(['push', ['pipeline', -1, [], [['/nope']]]]);
  port.deliver(['pull', 2]);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(port.posted, [['reject', 2, { message: 'ENOENT' }]]);
  assert.equal(handle.stats().rejected, 1);
});

test('a fire-and-forget rejection does not become an unhandled rejection in the page', async () => {
  // Nobody pulls this one. Without a sink the promise rejects with no handler,
  // which surfaces in the renderer console as our bug and is not.
  const { port } = session({
    services: { ns: { m: async () => { throw new Error('ignored on purpose'); } } },
  });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);

  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    port.deliver(['push', ['pipeline', -1, [], [[]]]]);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test('a throwing synchronous stub is rejected, and the session stays up', () => {
  const { port, handle } = session({
    services: { ns: { boom: () => { throw new Error('nope'); }, fine: () => 'ok' } },
  });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);
  port.posted.length = 0;

  port.deliver(['push', ['pipeline', -1, [], [[]]]]);
  port.deliver(['pull', 2]);
  assert.deepEqual(port.posted, [['reject', 2, { message: 'nope' }]]);
  assert.equal(handle.stats().threw, 1);

  // Still serving -- `fine` is its own capability, so the throw cannot have
  // taken it with it.
  port.deliver(['push', ['pipeline', -2, [], [[]]]]);
  port.deliver(['pull', 3]);
  assert.deepEqual(port.posted[1], ['resolve', 3, 'ok']);
});

test('a path into a member capability that resolves to nothing is rejected by name', () => {
  // A real renderer cannot send this: `ns.unknown` is `undefined` in the page,
  // so no stub exists to call and no frame is produced. It is here because the
  // rejection is what a protocol mistake should look like -- named, and not a
  // silent `undefined` that surfaces three frames later as someone else's
  // TypeError.
  const { port } = session({ services: { ns: { known: () => 1 } } });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);
  port.posted.length = 0;

  port.deliver(['push', ['pipeline', -1, ['unknown'], [[]]]]);
  port.deliver(['pull', 2]);
  assert.deepEqual(port.posted, [['reject', 2, { message: 'not callable: unknown' }]]);
});

test('a get of a member we do not serve names the path rather than resolving undefined', () => {
  const { port } = session({ services: { ns: { known: () => 1 } } });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);
  port.posted.length = 0;

  port.deliver(['push', ['pipeline', -1, ['missing']]]);
  port.deliver(['pull', 2]);
  assert.deepEqual(port.posted, [['reject', 2, { message: 'no such member: missing' }]]);
});

test('a call on a capability we never issued is refused with its id', () => {
  const { port } = session({ services: { ns: { m: () => 1 } } });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);
  port.posted.length = 0;

  port.deliver(['push', ['pipeline', -99, [], [[]]]]);
  port.deliver(['pull', 2]);
  assert.deepEqual(port.posted, [['reject', 2, { message: 'no such capability: -99' }]]);
});

test('re-exporting the same member reuses its id', () => {
  // The peer keeps a `reverseExports` map for this reason. Without it every
  // re-serialisation mints a new id and leaks a table entry per send -- and
  // the renderer would hold several distinct stubs for one function, so
  // reference counting on either side would stop meaning anything. The
  // dedupe is by identity, so it survives the same function appearing under
  // two namespaces.
  const m = () => 1;
  const { port, handle } = session({ services: { a: { m }, b: { m } } });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);

  assert.deepEqual(port.posted, [['resolve', 1, {
    a: { m: ['export', -1] },
    b: { m: ['export', -1] },
  }]]);
  assert.equal(handle.stats().exported, 1, 'one function, one id');
});

test('releasing a capability does not drop it, because the namespace outlives the reference', () => {
  // The renderer releases its import of `services` right after boot
  // (`["release",1,1]` in the measured wire). If a release dropped the
  // capability table entry, the first host call after boot would be answered
  // `no such capability` -- which would read like a protocol bug and would
  // not be one.
  const { port } = session({ services: { ns: { m: () => 'still here' } } });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);
  port.deliver(['release', -1, 1]);
  port.posted.length = 0;

  port.deliver(['push', ['pipeline', -1, [], [[]]]]);
  port.deliver(['pull', 2]);
  assert.deepEqual(port.posted, [['resolve', 2, 'still here']]);
});

test('a path of length zero re-exports the capability rather than refusing', () => {
  const ns = { m: () => 1 };
  const { port } = session({ services: { ns } });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);
  port.posted.length = 0;

  port.deliver(['push', ['pipeline', -1, []]]);
  port.deliver(['pull', 2]);
  assert.deepEqual(port.posted, [['resolve', 2, ['export', -1]]], 'same object, same id');
});

test('a capability argument is described rather than silently passed as undefined', () => {
  // The renderer handing US a callback is not something the namespaces we
  // serve ask for, and we cannot call back. A stub that received `undefined`
  // would behave as though it had been called with nothing; a marker lets it
  // say what it actually got.
  const calls = [];
  const { port } = session({ services: { ns: { m: (...args) => { calls.push(args); } } } });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);

  port.deliver(['push', ['pipeline', -1, [], [[['export', -5]]]]]);
  assert.deepEqual(calls, [[{ __capnwebUnsupported: 'export' }]]);
});

test('an `undefined` tag in an argument decodes to undefined', () => {
  const calls = [];
  const { port } = session({ services: { ns: { m: (...args) => { calls.push(args); } } } });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);

  port.deliver(['push', ['pipeline', -1, [], [[['undefined'], 'after']]]]);
  assert.deepEqual(calls, [[undefined, 'after']]);
});

test('a non-pipeline expression is refused by name rather than hanging', () => {
  // `remap`, `stream` and `pipe` are real capnweb expressions we do not serve.
  // Pushing one and then pulling it must produce a frame.
  const { port, handle, kinds } = session({ services: { ns: { m: () => 1 } } });
  port.deliver(['push', ['remap', -1, [], [], []]]);
  port.deliver(['pull', 1]);

  assert.equal(port.posted[0][0], 'reject');
  assert.match(port.posted[0][2].message, /remap/);
  assert.ok(kinds().includes('push-unsupported'));
  assert.equal(handle.stats().unhandled, 1);
});

test('a cycle in a served value fails as a reject, not as a throw in a port listener', () => {
  // Nobody is catching inside `onmessage`. An uncaught throw there is the
  // silent hang this module exists to prevent.
  const cyclic = { ns: { m: () => 1 } };
  cyclic.self = cyclic;
  const { port } = session({ services: cyclic });
  port.deliver(PUSH_SERVICES);
  port.deliver(PULL_1);

  assert.equal(port.posted.length, 1);
  assert.equal(port.posted[0][0], 'reject');
  assert.match(port.posted[0][2].message, /depth|cycle/i);
});
