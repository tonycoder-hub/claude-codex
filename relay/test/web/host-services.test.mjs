// The services, tested on the four ways they could fail while looking fine.
//
// Every failure in this module is quiet. A sync reply that round-trips nothing
// is a page that boots, renders and has forgotten every draft. A record write
// stored as `undefined` is the same page one reload later. A picker that
// returns nothing at all is a dialog with a spinner and an empty console. And
// a `global-state-updated` carrying a bare string invalidates one query per
// character, which is not an error anywhere -- it is a refetch that never
// happens. So the tests below assert on what came back, not on what was
// called: an empty array where a reply was owed is the bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  CONSUMED_WITHOUT_REPLY,
  HOST_SERVICE_TYPES,
  PERSISTED_ATOM_SYNC_FUSE_MS,
  SKIP_WORKSPACE_UNSUPPORTED,
  createHostServices,
} from '../../web/host-services.mjs';
import { ELECTRON_ONLY_PUSHES, INBOUND, OUTBOUND, isDeliverable } from '../../web/host-protocol.mjs';

/** The renderer's send shape: the payload, with `type` written last. */
const sent = (type, payload = {}) => ({ ...payload, type });

/** A services object plus the events it reported, in order. */
function harness(options = {}) {
  const events = [];
  const services = createHostServices({ onEvent: (event) => events.push(event), ...options });
  return { services, events };
}

// ---- the 5000 ms fuse ------------------------------------------------------

test('the sync reply has the three fields the renderer destructures', async () => {
  const { services } = harness();
  const replies = await services.handle(sent(OUTBOUND.persistedAtomSyncRequest, {
    responsePriority: 'critical',
  }));

  assert.equal(replies.length, 1, 'one reply, and never zero: zero is a five second stall');
  assert.deepEqual(replies[0], {
    type: INBOUND.persistedAtomSync,
    state: {},
    canWritePrimaryWindowTabPersistence: true,
  });
  assert.equal(isDeliverable(replies[0]), true, 'the renderer would hand this to its switch');
  assert.equal(services.stats().syncsAnswered, 1);
});

test('an empty store is a complete answer, not a reason to withhold one', async () => {
  // The renderer's fallback is "continue with legacy state only" after the
  // fuse. An empty state object unblocks it immediately instead.
  const { services } = harness();
  const [reply] = await services.handle(sent(OUTBOUND.persistedAtomSyncRequest));
  assert.deepEqual(reply.state, {});
  assert.equal(PERSISTED_ATOM_SYNC_FUSE_MS, 5000, 'the measured fuse, recorded not scheduled');
});

test('the reply needs no macrotask, so none of the fuse is spent here', async () => {
  // A reply built behind a timer would still beat 5000 ms, but it would make
  // this module a thing with a clock in it. The assertion is that a timer
  // queued before the handle has not run by the time the reply resolves.
  const { services } = harness();
  let timerRan = false;
  const pending = services.handle(sent(OUTBOUND.persistedAtomSyncRequest));
  setTimeout(() => {
    timerRan = true;
  }, 0);
  await pending;
  assert.equal(timerRan, false, 'the reply resolved in the same task');
});

// ---- the write side, which is what makes the reply mean anything -----------

test('an update then a sync round-trips the value the renderer wrote', async () => {
  const { services } = harness();
  await services.handle(sent(OUTBOUND.persistedAtomUpdate, {
    key: 'composer-prompt-drafts-v2',
    value: { 'thread-1': 'half a sentence' },
    deleted: false,
  }));
  const [reply] = await services.handle(sent(OUTBOUND.persistedAtomSyncRequest));

  assert.deepEqual(reply.state, {
    'composer-prompt-drafts-v2': { 'thread-1': 'half a sentence' },
  });
  assert.equal(services.stats().atomsStored, 1);
});

test('the injected store is the store, and is not copied on the way in', async () => {
  const store = new Map([['sidebar-section-locations-v1', { main: 'top' }]]);
  const { services } = harness({ store });

  const [reply] = await services.handle(sent(OUTBOUND.persistedAtomSyncRequest));
  assert.deepEqual(reply.state, { 'sidebar-section-locations-v1': { main: 'top' } });

  await services.handle(sent(OUTBOUND.persistedAtomUpdate, { key: 'theme-v1', value: 'dark' }));
  assert.equal(store.get('theme-v1'), 'dark', 'the write landed in the caller`s store');
});

test('an explicit delete and an undefined value both remove the key', async () => {
  // Two spellings of the same thing. The renderer's store deletes on an
  // undefined value and computes its `deleted` flag from that same condition.
  const store = new Map([['a-v1', 1], ['b-v1', 2]]);
  const { services } = harness({ store });

  await services.handle(sent(OUTBOUND.persistedAtomUpdate, { key: 'a-v1', deleted: true }));
  await services.handle(sent(OUTBOUND.persistedAtomUpdate, { key: 'b-v1', value: undefined }));

  const [reply] = await services.handle(sent(OUTBOUND.persistedAtomSyncRequest));
  assert.deepEqual(reply.state, {});
  assert.equal(services.stats().atomsDeleted, 2);
});

test('a record write does not wipe the atom it is updating', async () => {
  // THE TRAP. A record write sends `recordUpdate` INSTEAD of `value`, so a
  // host that stores `message.value` stores undefined and deletes the atom.
  const store = new Map([['drafts-v2', { kept: 'yes' }]]);
  const { services } = harness({ store });

  await services.handle(sent(OUTBOUND.persistedAtomUpdate, {
    key: 'drafts-v2',
    value: undefined,
    deleted: false,
    recordUpdate: { entries: { added: { value: 'new' } } },
  }));

  const [reply] = await services.handle(sent(OUTBOUND.persistedAtomSyncRequest));
  assert.deepEqual(reply.state, { 'drafts-v2': { kept: 'yes', added: 'new' } });
  assert.equal(services.stats().recordsMerged, 1);
  assert.equal(services.stats().atomsDeleted, 0, 'and it was not read as a deletion');
});

test('a null entry deletes, and expectedValue is a compare-and-set', async () => {
  const store = new Map([['r-v1', { gone: 1, guarded: 'old', free: 'x' }]]);
  const { services } = harness({ store });

  await services.handle(sent(OUTBOUND.persistedAtomUpdate, {
    key: 'r-v1',
    recordUpdate: {
      entries: {
        gone: null,
        guarded: { value: 'new', expectedValue: 'stale' },
        free: { value: 'y' },
      },
    },
  }));

  const [reply] = await services.handle(sent(OUTBOUND.persistedAtomSyncRequest));
  assert.deepEqual(
    reply.state['r-v1'],
    { guarded: 'old', free: 'y' },
    'the guarded entry lost the race and was skipped, which is the point of it',
  );
});

test('updateOnly inserts nothing and a non-record base restarts from empty', async () => {
  const store = new Map([['r-v1', 'not a record at all']]);
  const { services } = harness({ store });

  await services.handle(sent(OUTBOUND.persistedAtomUpdate, {
    key: 'r-v1',
    recordUpdate: { entries: { absent: { value: 1, updateOnly: true }, present: { value: 2 } } },
  }));

  const [reply] = await services.handle(sent(OUTBOUND.persistedAtomSyncRequest));
  assert.deepEqual(reply.state['r-v1'], { present: 2 });
});

test('a record write falls back to the legacy key for its base', async () => {
  // How a renamed atom keeps its entries through the first write after the
  // rename: the renderer resolves the base the same way.
  const store = new Map([['old-name-v1', { carried: true }]]);
  const { services } = harness({ store });

  await services.handle(sent(OUTBOUND.persistedAtomUpdate, {
    key: 'new-name-v2',
    recordUpdate: { legacyStorageKey: 'old-name-v1', entries: { fresh: { value: 1 } } },
  }));

  const [reply] = await services.handle(sent(OUTBOUND.persistedAtomSyncRequest));
  assert.deepEqual(reply.state['new-name-v2'], { carried: true, fresh: 1 });
});

test('a rewritten entry moves to the end of the key order', async () => {
  // Not cosmetic: the renderer prunes `maxEntries` by key order when no
  // timestamp field is configured, so an in-place assignment here would make
  // the wrong entry look like the oldest one later.
  const store = new Map([['r-v1', { first: 1, second: 2, third: 3 }]]);
  const { services } = harness({ store });

  await services.handle(sent(OUTBOUND.persistedAtomUpdate, {
    key: 'r-v1',
    recordUpdate: { entries: { first: { value: 9 } } },
  }));

  const [reply] = await services.handle(sent(OUTBOUND.persistedAtomSyncRequest));
  assert.deepEqual(Object.keys(reply.state['r-v1']), ['second', 'third', 'first']);
});

test('an update with no usable key is counted, not stored under one', async () => {
  const { services, events } = harness();
  const replies = await services.handle(sent(OUTBOUND.persistedAtomUpdate, { value: 1 }));

  assert.deepEqual(replies, [], 'the write side is fire and forget either way');
  assert.equal(services.stats().malformed, 1);
  assert.equal(services.stats().atomsStored, 0);
  assert.equal(events.at(-1).outcome, 'malformed');
});

test('a store that throws degrades to an empty state instead of stalling', async () => {
  const broken = {
    get: () => {
      throw new Error('no');
    },
    set: () => {
      throw new Error('no');
    },
    delete: () => {
      throw new Error('no');
    },
    entries: () => {
      throw new Error('no');
    },
  };
  const { services } = harness({ store: broken });

  await services.handle(sent(OUTBOUND.persistedAtomUpdate, { key: 'a-v1', value: 1 }));
  const [reply] = await services.handle(sent(OUTBOUND.persistedAtomSyncRequest));

  assert.deepEqual(reply.state, {}, 'an empty answer beats no answer');
  assert.ok(services.stats().storeFailures >= 2);
});

test('undefined values in the store are dropped from the state we send', async () => {
  // The renderer's hydration skips them, so sending one is sending a key it
  // will not hold.
  const store = new Map([['real-v1', 1], ['hole-v1', undefined]]);
  const { services } = harness({ store });
  const [reply] = await services.handle(sent(OUTBOUND.persistedAtomSyncRequest));
  assert.deepEqual(reply.state, { 'real-v1': 1 });
});

test('a store missing a method is refused at construction, not at use', () => {
  assert.throws(
    () => createHostServices({ store: { get: () => {}, set: () => {} } }),
    /Map-shaped and is missing delete/,
  );
});

// ---- onboarding: the picker that has no timeout ---------------------------

test('with no picker injected the reply is a cancel, never silence', async () => {
  const { services } = harness();
  const replies = await services.handle(sent(OUTBOUND.pickWorkspaceRootOption, {
    allowMultiple: false,
  }));

  assert.deepEqual(replies, [{ type: INBOUND.workspaceRootOptionAddCanceled }]);
  assert.equal(services.stats().picksCanceled, 1);
});

test('a picked folder comes back as one picked message carrying its root', async () => {
  const { services } = harness({ pickWorkspaceRoot: async () => '/home/u/project' });
  const replies = await services.handle(sent(OUTBOUND.pickWorkspaceRootOption, {
    allowMultiple: false,
  }));

  assert.deepEqual(replies, [
    { type: INBOUND.workspaceRootOptionPicked, root: '/home/u/project' },
  ]);
  assert.equal(services.stats().rootsPicked, 1);
});

test('several roots are several messages, and only when allowMultiple said so', async () => {
  const roots = ['/a', '/b', '/c'];
  const multi = harness({ pickWorkspaceRoot: () => roots });
  const single = harness({ pickWorkspaceRoot: () => roots });

  const many = await multi.services.handle(sent(OUTBOUND.pickWorkspaceRootOption, {
    allowMultiple: true,
  }));
  assert.deepEqual(many.map((m) => m.root), ['/a', '/b', '/c']);

  const one = await single.services.handle(sent(OUTBOUND.pickWorkspaceRootOption, {
    allowMultiple: false,
  }));
  assert.deepEqual(one.map((m) => m.root), ['/a'], 'the single-select gets one box checked');
  assert.equal(single.events.at(-1).dropped, 2);
});

test('a picker that cancels, returns junk, or throws all end in one cancel', async () => {
  for (const picker of [
    () => null,
    () => [],
    () => [undefined, ''],
    () => {
      throw new Error('dialog closed');
    },
    async () => {
      throw new Error('dialog closed');
    },
  ]) {
    const { services } = harness({ pickWorkspaceRoot: picker });
    const replies = await services.handle(sent(OUTBOUND.pickWorkspaceRootOption, {}));
    assert.deepEqual(replies, [{ type: INBOUND.workspaceRootOptionAddCanceled }]);
  }
});

test('a picker that rejects does not reject handle', async () => {
  const { services } = harness({
    pickWorkspaceRoot: () => Promise.reject(new Error('denied')),
  });
  await assert.doesNotReject(() => services.handle(sent(OUTBOUND.pickWorkspaceRootOption, {})));
  assert.equal(services.stats().callbackFailures, 1);
});

// ---- onboarding: adding a workspace root ----------------------------------

test('with no adder injected the add request is canceled rather than dropped', async () => {
  const { services } = harness();
  const replies = await services.handle(sent(OUTBOUND.addNewWorkspaceRootOption, {}));
  assert.deepEqual(replies, [{ type: INBOUND.workspaceRootOptionAddCanceled }]);
  assert.equal(services.stats().addsCanceled, 1);
});

test('an added root answers with the project id the renderer selects on', async () => {
  const { services } = harness({
    addWorkspaceRoot: async ({ root }) => ({ projectId: 'p-7', root }),
  });
  const replies = await services.handle(sent(OUTBOUND.addNewWorkspaceRootOption, {
    root: '/home/u/new',
  }));

  assert.deepEqual(replies, [
    { type: INBOUND.workspaceRootOptionAdded, projectId: 'p-7', root: '/home/u/new' },
  ]);
  assert.equal(
    'selectedProjectId' in replies[0],
    false,
    'the switch reads selectedProjectId ?? projectId, so only one of them is ours to write',
  );
  assert.equal(services.stats().rootsAdded, 1);
});

test('an adder that produces no project id is a cancel, not a null project id', async () => {
  // The sidebar's subscriber runs the identical nothing-was-added branch for a
  // null project id as it does for the cancel, and the cancel says so.
  for (const adder of [() => null, () => ({ projectId: null }), () => ({}), () => 'p-7']) {
    const { services } = harness({ addWorkspaceRoot: adder });
    const replies = await services.handle(sent(OUTBOUND.addNewWorkspaceRootOption, {}));
    assert.deepEqual(replies, [{ type: INBOUND.workspaceRootOptionAddCanceled }]);
  }
});

// ---- onboarding: the skip, which does have a reply ------------------------

test('the skip is answered with a failure that clears the pending state', async () => {
  // Acknowledging it without replying leaves the skip button dead for the
  // session: its subscriber is the only thing that calls setPending(null).
  const { services } = harness();
  const replies = await services.handle(sent(OUTBOUND.onboardingSkipWorkspace, {
    initializeGitRepository: true,
  }));

  assert.deepEqual(replies, [
    {
      type: INBOUND.onboardingSkipWorkspaceResult,
      success: false,
      error: SKIP_WORKSPACE_UNSUPPORTED,
    },
  ]);
  assert.match(SKIP_WORKSPACE_UNSUPPORTED, /\S/, 'a failure with no text renders a blank error');
  assert.equal(services.stats().skipsAnswered, 1);
});

test('an injected skip can succeed, and sees the git flag verbatim', async () => {
  const seen = [];
  const { services } = harness({
    skipWorkspace: (args) => {
      seen.push(args);
      return true;
    },
  });
  const replies = await services.handle(sent(OUTBOUND.onboardingSkipWorkspace, {
    initializeGitRepository: false,
  }));

  assert.deepEqual(replies, [{ type: INBOUND.onboardingSkipWorkspaceResult, success: true }]);
  assert.deepEqual(seen, [{ initializeGitRepository: false }]);
  assert.equal('error' in replies[0], false, 'no error key on the success arm');
});

test('a skip that throws becomes the error text the step displays', async () => {
  const { services } = harness({
    skipWorkspace: () => {
      throw new Error('no writable home directory');
    },
  });
  const [reply] = await services.handle(sent(OUTBOUND.onboardingSkipWorkspace, {}));
  assert.equal(reply.success, false);
  assert.equal(reply.error, 'no writable home directory');
});

// ---- the pings the host sends ---------------------------------------------

test('the workspace-root ping is a bare invalidation with no fields', () => {
  const { services } = harness();
  const message = services.emitWorkspaceRootOptionsUpdated();
  assert.deepEqual(message, { type: INBOUND.workspaceRootOptionsUpdated });
  assert.equal(services.stats().emitted, 1);
});

test('global-state keys must be an array, because the renderer iterates them', () => {
  const { services } = harness();
  assert.deepEqual(services.emitGlobalStateUpdated({ keys: ['local-projects'] }), {
    type: INBOUND.globalStateUpdated,
    keys: ['local-projects'],
  });

  // A bare string is the dangerous one: it has `.includes` and it iterates, so
  // it would invalidate one query per character and refetch nothing wanted.
  assert.throws(() => services.emitGlobalStateUpdated({ keys: 'local-projects' }), /array/);
  assert.throws(() => services.emitGlobalStateUpdated({ keys: null }), /array/);
  assert.throws(() => services.emitGlobalStateUpdated({}), /keys/);
  assert.equal(services.stats().emitted, 1, 'a refused emit is not a counted one');
});

test('an empty key list is allowed and stays an array', () => {
  const { services } = harness();
  assert.deepEqual(services.emitGlobalStateUpdated({ keys: [] }).keys, []);
});

// ---- the claims with no reply ---------------------------------------------

test('each fire-and-forget type is consumed and answers nothing', async () => {
  const { services, events } = harness();
  assert.equal(CONSUMED_WITHOUT_REPLY.length, 29);

  for (const type of CONSUMED_WITHOUT_REPLY) {
    const replies = await services.handle(sent(type, { anything: 'at all' }));
    assert.deepEqual(replies, [], `${type} has no inbound counterpart, so it gets no reply`);
  }

  assert.equal(services.stats().consumedWithoutReply, 29);
  assert.equal(services.stats().unclaimed, 0, 'consumed is not the same as unhandled');
  assert.deepEqual(
    events.map((event) => event.outcome),
    Array.from({ length: 29 }, () => 'consumed'),
  );
});

test('the fire-and-forget list is the four it always was plus the swept twenty-five', () => {
  // The four were measured one at a time. The twenty-five came out of a sweep
  // of everything a drive of the shipped renderer sends that nothing on this
  // bus claimed -- 27 types, of which `electron-window-focus-request` blocks
  // (web/host-focus.mjs answers it) and `shared-object-set` is mirrored, so 25
  // are left owing nothing. Asserted as two lists rather than one so that a
  // future addition to the table cannot quietly join the hand-measured four.
  assert.deepEqual(CONSUMED_WITHOUT_REPLY.slice(0, 4), [
    'app-shell-shortcut-state-changed',
    'checkout-webview-presentation-changed',
    'electron-avatar-overlay-restore-ready',
    'shared-object-subscribe',
  ]);
  assert.deepEqual(CONSUMED_WITHOUT_REPLY.slice(4), Object.keys(ELECTRON_ONLY_PUSHES));
  assert.equal(Object.keys(ELECTRON_ONLY_PUSHES).length, 25);
});

test('nothing is consumed twice, and nothing is consumed that is also answered', () => {
  assert.equal(
    new Set(CONSUMED_WITHOUT_REPLY).size,
    CONSUMED_WITHOUT_REPLY.length,
    'a duplicate here would double-count consumedWithoutReply and hide a real claim',
  );
  // The two types the sweep found that are NOT here, named so that deleting
  // either handler fails this rather than silently reclassifying it as
  // harmless -- which is exactly the mistake the sweep existed to catch.
  // They are answered by DIFFERENT layers, which is the part worth pinning:
  // `shared-object-set` is this module's, and `electron-window-focus-request`
  // belongs to web/host-focus.mjs because answering it once is not enough.
  for (const type of [OUTBOUND.electronWindowFocusRequest, OUTBOUND.sharedObjectSet]) {
    assert.equal(CONSUMED_WITHOUT_REPLY.includes(type), false, type);
    assert.equal(Object.hasOwn(ELECTRON_ONLY_PUSHES, type), false, type);
  }
  assert.equal(HOST_SERVICE_TYPES.includes(OUTBOUND.sharedObjectSet), true);
  assert.equal(
    HOST_SERVICE_TYPES.includes(OUTBOUND.electronWindowFocusRequest),
    false,
    'the focus layer claims this one; two claimants would answer it twice',
  );
});

test('every Electron-only push is a real outbound type with a stated reason', () => {
  const outboundValues = new Set(Object.values(OUTBOUND));
  for (const [type, reason] of Object.entries(ELECTRON_ONLY_PUSHES)) {
    assert.equal(outboundValues.has(type), true, `${type} is not in the OUTBOUND table`);
    assert.equal(typeof reason, 'string');
    assert.ok(reason.length > 20, `${type} needs a reason, not a placeholder`);
  }
  assert.equal(Object.isFrozen(ELECTRON_ONLY_PUSHES), true);
});

// ---- the shared-object mirror ---------------------------------------------
//
// This is the half of `shared-object-set` that Electron does in its preload
// and the relay had nowhere to do. Its whole value is measured in reloads: the
// renderer never re-reads the snapshot within one page, so every assertion
// below is really about what the NEXT page finds. The tests are written that
// way on purpose -- a test that only checked `store.get(key)` would pass just
// as happily against a mirror wired to a `new Map()` that the reload discards.

test('a shared-object set is mirrored and answers nothing', async () => {
  const store = new Map();
  const { services, events } = harness({ sharedObjects: store });

  const replies = await services.handle(sent(OUTBOUND.sharedObjectSet, {
    key: 'diff_comments',
    value: [{ id: 'c1' }],
  }));

  assert.deepEqual(replies, [], 'the renderer awaits nothing: this is a write, not a request');
  assert.deepEqual(store.get('diff_comments'), [{ id: 'c1' }]);
  assert.equal(services.stats().sharedObjectsMirrored, 1);
  assert.equal(events.at(-1).outcome, 'mirrored');
});

test('undefined deletes and null is stored, the way main distinguishes them', async () => {
  // main: `set(e,t){t===void 0?delete this.store[e]:this.store[e]=t,...}`.
  // Collapsing the two would put a null `pending_worktrees` in front of a
  // `.find` that is guarded for undefined only.
  const store = new Map([['pending_worktrees', [{ id: 'w1' }]], ['other', 1]]);
  const { services } = harness({ sharedObjects: store });

  await services.handle(sent(OUTBOUND.sharedObjectSet, { key: 'pending_worktrees' }));
  assert.equal(store.has('pending_worktrees'), false, 'undefined is a delete');

  await services.handle(sent(OUTBOUND.sharedObjectSet, { key: 'other', value: null }));
  assert.equal(store.has('other'), true);
  assert.equal(store.get('other'), null, 'null is a value a shared object can hold');

  assert.equal(services.stats().sharedObjectsCleared, 1);
  assert.equal(services.stats().sharedObjectsMirrored, 1);
});

test('a set with no usable key is ignored rather than counted as malformed', async () => {
  const store = new Map();
  const { services, events } = harness({ sharedObjects: store });

  for (const key of [undefined, null, '', 7, {}]) {
    assert.deepEqual(await services.handle(sent(OUTBOUND.sharedObjectSet, { key, value: 1 })), []);
  }

  assert.equal(store.size, 0);
  assert.equal(services.stats().malformed, 0, 'the type was right and the bus delivered it');
  assert.deepEqual(events.map((event) => event.outcome), Array.from({ length: 5 }, () => 'ignored'));
});

test('a store that throws is recorded, not raised', async () => {
  // A localStorage quota, which on a phone is the ordinary case rather than
  // the exotic one. The renderer wrote its own copy before dispatching, so the
  // page is still correct -- only the reload is lost.
  const { services, events } = harness({
    sharedObjects: {
      set() { throw new Error('QuotaExceededError'); },
      delete() { throw new Error('QuotaExceededError'); },
    },
  });

  assert.deepEqual(
    await services.handle(sent(OUTBOUND.sharedObjectSet, { key: 'k', value: 1 })),
    [],
  );
  assert.equal(services.stats().storeFailures, 1);
  assert.equal(events.at(-1).outcome, 'store-failed');
  assert.equal(events.at(-1).key, 'k');
});

test('a sharedObjects without set and delete is refused at construction', () => {
  // Refused here rather than at the first write, because the first write is
  // the renderer's and a throw out of the bus listener leaves nothing behind.
  assert.throws(() => createHostServices({ sharedObjects: {} }), /set/);
  assert.throws(() => createHostServices({ sharedObjects: { set() {} } }), /delete/);
  assert.doesNotThrow(() => createHostServices({ sharedObjects: new Map() }));
});

// ---- the edges of the dispatch -------------------------------------------

test('a type this module was not given is reported, not claimed', async () => {
  const { services } = harness();
  assert.equal(services.owns(OUTBOUND.fetch), false);
  assert.deepEqual(await services.handle(sent(OUTBOUND.fetch, { requestId: 1 })), []);
  assert.equal(services.stats().unclaimed, 1);
  assert.equal(services.stats().handled, 0);
});

test('owns covers every type the switch has a branch for', async () => {
  const { services } = harness({
    pickWorkspaceRoot: () => '/a',
    addWorkspaceRoot: () => ({ projectId: 'p' }),
    skipWorkspace: () => true,
  });
  assert.equal(HOST_SERVICE_TYPES.length, 35);

  for (const type of HOST_SERVICE_TYPES) {
    assert.equal(services.owns(type), true, type);
    await services.handle(sent(type, { key: 'k-v1', value: 1 }));
  }
  assert.equal(services.stats().handled, 35);
  assert.equal(services.stats().unclaimed, 0, 'nothing in the list fell through to unclaimed');
});

test('a message with no type at all is malformed and answers nothing', async () => {
  const { services } = harness();
  for (const message of [undefined, null, 'persisted-atom-sync-request', { type: 7 }, []]) {
    assert.deepEqual(await services.handle(message), []);
  }
  assert.equal(services.stats().malformed, 5);
});

test('stats are a copy, not the live counters', async () => {
  const { services } = harness();
  const snapshot = services.stats();
  await services.handle(sent(OUTBOUND.persistedAtomSyncRequest));
  assert.equal(snapshot.syncsAnswered, 0, 'a reader holds a snapshot');
  assert.equal(services.stats().syncsAnswered, 1);
});

test('an observer that throws does not cost the renderer its reply', async () => {
  const services = createHostServices({
    onEvent: () => {
      throw new Error('logger is broken');
    },
  });
  const replies = await services.handle(sent(OUTBOUND.persistedAtomSyncRequest));
  assert.equal(replies.length, 1);
  assert.equal(services.stats().observerFailures, 1);
});

test('every reply survives a structured clone, which is the real wire', async () => {
  const { services } = harness({
    pickWorkspaceRoot: () => '/a',
    addWorkspaceRoot: () => ({ projectId: 'p-1', root: '/a' }),
    skipWorkspace: () => true,
    store: new Map([['r-v1', { a: 1 }]]),
  });

  const produced = [
    ...(await services.handle(sent(OUTBOUND.persistedAtomSyncRequest))),
    ...(await services.handle(sent(OUTBOUND.pickWorkspaceRootOption, { allowMultiple: false }))),
    ...(await services.handle(sent(OUTBOUND.addNewWorkspaceRootOption, { root: '/a' }))),
    ...(await services.handle(sent(OUTBOUND.onboardingSkipWorkspace, {}))),
    services.emitWorkspaceRootOptionsUpdated(),
    services.emitGlobalStateUpdated({ keys: ['local-projects'] }),
  ];

  assert.equal(produced.length, 6);
  for (const message of produced) {
    assert.equal(isDeliverable(message), true, `${message.type} would reach the switch`);
    assert.deepEqual(structuredClone(message), message, `${message.type} crosses the wire intact`);
  }
});

// ---- the seam stays a seam ------------------------------------------------

test('host-services imports the vocabulary and nothing else', async () => {
  // No window, no transport, no clock. The record-merge rules above are only
  // cheap to pin because there is nothing to stand up, and the one measured
  // timeout on this traffic belongs to the renderer.
  const source = await readFile(new URL('../../web/host-services.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(imports, ['./host-protocol.mjs'], 'one import, and it is the vocabulary');

  // Comments are stripped before the clock and DOM check, because the measured
  // evidence for these handlers is a `window.setTimeout` in the renderer and
  // the citations have to be allowed to name it. Only full-line comments are
  // removed, so a trailing one still counts as code and the strip cannot be
  // used to hide a call behind it.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  assert.equal(/setTimeout|setInterval|Date\.now|performance\.now/.test(code), false);
  assert.equal(/\bwindow\b|\bdocument\b|new WebSocket/.test(code), false);
});
