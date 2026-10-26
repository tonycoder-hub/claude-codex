// The bridge, tested on its counts and its refusals.
//
// Two of the assertions here look like trivia and are not. The renderer counts
// the keys on `getSentryInitOptions()` and uses the count to decide whether
// this window is trusted, and the member list is the surface an unmodified
// bundle probes at boot. Both are counts rather than behaviours, so a test is
// the only thing that can hold them -- nothing in the module would fail at
// runtime if a member went missing, it would just produce a renderer that
// quietly does less.
//
// The names below are typed out rather than imported. Importing the list the
// module exports and comparing it to itself would pass through any rename.
//
// That list is split in two, because 20 of the 22 names the bundle probes are
// installed and two are deliberately not: the worker channel pair is left off
// so that the renderer's own `if(!t)` guard is what fires. An omission like
// that is invisible at runtime -- a stub that resolves instead produces a hang
// with an empty console -- so the last section of this file pins it by
// replaying the renderer's measured worker client against the bridge and
// checking that the call comes back at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installElectronBridge } from '../../web/host-bridge.mjs';
import { bridgeConfig, makeWindow } from './host-fakes.mjs';

/** The 20 members installed, out of the 22 names read off the bundle. */
const INSTALLED_MEMBERS = [
  'windowType',
  'acknowledgeChunkedMessage',
  'getPreloadStartedAtMs',
  'sendMessageFromView',
  'getPathForFile',
  'startFileDrag',
  'startLinkDrag',
  'showContextMenu',
  'getFastModeRolloutMetrics',
  'getSharedObjectSnapshotValue',
  'getInitialSidebarBootstrap',
  'getSystemThemeVariant',
  'subscribeToSystemThemeVariant',
  'triggerSentryTestError',
  'getSentryInitOptions',
  'getDesktopUserAgent',
  'getAppSessionId',
  'getBuildFlavor',
  'isDeviceCheckSupported',
  'isIntelMacBuild',
];

/**
 * The other two: the worker channel, which this bridge does not implement and
 * therefore does not advertise. See the last section of this file.
 */
const OMITTED_MEMBERS = ['sendWorkerMessageFromView', 'subscribeToWorkerMessages'];

const SENTRY_KEYS = [
  'dsn',
  'appVersion',
  'buildNumber',
  'buildFlavor',
  'codexAppSessionId',
  'desktopTraceSampleRate',
  'initialDesktopTraceSampleRate',
];

const SENTRY_IPC = [
  'sendRendererStart',
  'sendScope',
  'sendEnvelope',
  'sendStatus',
  'sendStructuredLog',
  'sendMetric',
];

function install(overrides) {
  const window = makeWindow();
  const handle = installElectronBridge({ window, config: bridgeConfig(overrides) });
  return { window, handle, bridge: handle.bridge };
}

// ---- the counts ------------------------------------------------------------

test('the bridge has exactly 20 members, and they are these 20', () => {
  const { bridge } = install();
  assert.equal(INSTALLED_MEMBERS.length, 20, 'the list in this test must itself be 20 long');
  assert.equal(
    INSTALLED_MEMBERS.length + OMITTED_MEMBERS.length,
    22,
    'the two lists together must still account for every name the bundle probes',
  );
  assert.deepEqual(Object.keys(bridge).sort(), [...INSTALLED_MEMBERS].sort());
  assert.equal(Object.keys(bridge).length, 20);
});

test('every installed member except windowType is callable', () => {
  const { bridge } = install();
  assert.equal(bridge.windowType, 'electron');
  for (const name of INSTALLED_MEMBERS) {
    if (name === 'windowType') continue;
    assert.equal(typeof bridge[name], 'function', `${name} must be callable`);
  }
});

test('getSentryInitOptions returns exactly 7 keys, and they are these 7', () => {
  const { bridge } = install();
  const options = bridge.getSentryInitOptions();
  assert.equal(SENTRY_KEYS.length, 7, 'the list in this test must itself be 7 long');
  assert.equal(
    Object.keys(options).length,
    7,
    'the renderer counts these keys to decide the window is trusted',
  );
  assert.deepEqual(Object.keys(options).sort(), [...SENTRY_KEYS].sort());
});

test('an extra config key cannot make the sentry options eight', () => {
  const { bridge } = install({ tunnelUrl: 'https://nope.invalid', extra: 1 });
  assert.equal(Object.keys(bridge.getSentryInitOptions()).length, 7);
});

test('sentry options are rebuilt per call, so the renderer cannot corrupt ours', () => {
  const { bridge } = install();
  const first = bridge.getSentryInitOptions();
  first.dsn = 'mutated';
  delete first.buildFlavor;
  const second = bridge.getSentryInitOptions();
  assert.equal(Object.keys(second).length, 7);
  assert.notEqual(second.dsn, 'mutated');
});

test('an empty dsn is allowed and still occupies its key', () => {
  // Turning error reporting off must not change the shape the renderer counts.
  const { bridge } = install({ dsn: '' });
  const options = bridge.getSentryInitOptions();
  assert.equal(options.dsn, '');
  assert.equal(Object.keys(options).length, 7);
});

// ---- refusals at install ---------------------------------------------------

test('a missing required config value throws at install, not at read time', () => {
  for (const key of ['appVersion', 'buildNumber', 'buildFlavor', 'codexAppSessionId', 'desktopUserAgent', 'theme']) {
    const config = bridgeConfig();
    delete config[key];
    assert.throws(
      () => installElectronBridge({ window: makeWindow(), config }),
      new RegExp(`config\\.${key}`),
      `a missing ${key} must name itself in the error`,
    );
  }
});

test('an empty string is as missing as an absent key', () => {
  assert.throws(
    () => installElectronBridge({ window: makeWindow(), config: bridgeConfig({ appVersion: '' }) }),
    /config\.appVersion/,
  );
});

test('a non-string required value is refused rather than coerced', () => {
  assert.throws(
    () => installElectronBridge({ window: makeWindow(), config: bridgeConfig({ buildNumber: 17 }) }),
    /config\.buildNumber/,
  );
});

test('a bogus systemThemeVariant is refused at install', () => {
  assert.throws(
    () => installElectronBridge({ window: makeWindow(), config: bridgeConfig({ systemThemeVariant: 'auto' }) }),
    /systemThemeVariant/,
  );
  assert.throws(
    () => installElectronBridge({ window: makeWindow(), config: bridgeConfig({ systemThemeVariant: undefined }) }),
    /systemThemeVariant/,
  );
});

test('install refuses a missing window and a missing config', () => {
  assert.throws(() => installElectronBridge({ config: bridgeConfig() }), /window/);
  assert.throws(() => installElectronBridge({ window: makeWindow() }), /config/);
  assert.throws(() => installElectronBridge(), /window/);
});

// ---- what gets installed ---------------------------------------------------

test('the window advertises itself as electron', () => {
  const { window, bridge } = install();
  assert.equal(window.codexWindowType, 'electron');
  assert.equal(window.electronBridge, bridge);
});

test('the sentry IPC stub has exactly 6 no-ops under the sentry-ipc key', () => {
  const { window } = install();
  const ipc = window.__SENTRY_IPC__['sentry-ipc'];
  assert.equal(SENTRY_IPC.length, 6);
  assert.deepEqual(Object.keys(ipc).sort(), [...SENTRY_IPC].sort());
  for (const name of SENTRY_IPC) {
    assert.equal(typeof ipc[name], 'function');
    assert.equal(ipc[name]('anything', 2, 3), undefined, `${name} must do nothing, quietly`);
  }
});

test('the theme lands on documentElement.dataset', () => {
  const { window, handle } = install({ theme: 'light' });
  assert.equal(window.document.documentElement.dataset.theme, 'light');
  handle.setTheme('dark');
  assert.equal(window.document.documentElement.dataset.theme, 'dark');
  assert.throws(() => handle.setTheme(''), /theme/);
});

// ---- sendMessageFromView is a no-op, and must stay one ---------------------

test('sendMessageFromView returns a thenable the renderer can .catch()', () => {
  // The renderer calls `.catch()` on the result without checking it first, so
  // returning undefined here would be a TypeError on every single send.
  const { bridge } = install();
  const returned = bridge.sendMessageFromView({ type: 'log-message' });
  assert.equal(typeof returned?.then, 'function');
  assert.equal(typeof returned?.catch, 'function');
  return returned;
});

test('sendMessageFromView resolves and never rejects', async () => {
  const { bridge } = install();
  await assert.doesNotReject(() => bridge.sendMessageFromView({ type: 'mcp-request' }));
});

test('sendMessageFromView records nothing anywhere', () => {
  // If this member ever starts delivering, web/host-bus.mjs would see every
  // outbound message twice -- it captures the CustomEvent, which fires anyway.
  const { bridge } = install();
  const before = JSON.stringify(Object.keys(bridge));
  bridge.sendMessageFromView({ type: 'mcp-request', hostId: 'local' });
  assert.equal(JSON.stringify(Object.keys(bridge)), before);
  assert.equal(bridge.sendMessageFromView.length, 0, 'it does not even read its argument');
});

// ---- the theme subscription genuinely works --------------------------------

test('system theme subscribe, notify and unsubscribe', () => {
  const { handle, bridge } = install({ systemThemeVariant: 'dark' });
  const seen = [];
  const off = bridge.subscribeToSystemThemeVariant((variant) => seen.push(variant));

  assert.deepEqual(seen, [], 'subscribing must not fire immediately');
  assert.equal(bridge.getSystemThemeVariant(), 'dark');

  handle.setSystemThemeVariant('light');
  assert.deepEqual(seen, ['light']);
  assert.equal(bridge.getSystemThemeVariant(), 'light', 'the getter moves with the notification');

  off();
  handle.setSystemThemeVariant('dark');
  assert.deepEqual(seen, ['light'], 'an unsubscribed listener hears nothing');
  assert.equal(bridge.getSystemThemeVariant(), 'dark', 'but the value still changed');
});

test('setting the same variant twice notifies once', () => {
  const { handle, bridge } = install({ systemThemeVariant: 'dark' });
  const seen = [];
  bridge.subscribeToSystemThemeVariant((v) => seen.push(v));
  handle.setSystemThemeVariant('light');
  handle.setSystemThemeVariant('light');
  assert.deepEqual(seen, ['light']);
});

test('a bogus variant is refused rather than broadcast', () => {
  const { handle, bridge } = install();
  const seen = [];
  bridge.subscribeToSystemThemeVariant((v) => seen.push(v));
  assert.throws(() => handle.setSystemThemeVariant('auto'), /variant/);
  assert.deepEqual(seen, []);
});

test('subscribeToSystemThemeVariant refuses a non-function', () => {
  const { bridge } = install();
  assert.throws(() => bridge.subscribeToSystemThemeVariant(null), /function/);
  assert.throws(() => bridge.subscribeToSystemThemeVariant('light'), /function/);
});

test('one throwing theme listener does not starve the others', () => {
  const { handle, bridge } = install({ systemThemeVariant: 'dark' });
  const seen = [];
  bridge.subscribeToSystemThemeVariant(() => { throw new Error('boom'); });
  bridge.subscribeToSystemThemeVariant((v) => seen.push(v));
  assert.doesNotThrow(() => handle.setSystemThemeVariant('light'));
  assert.deepEqual(seen, ['light']);
});

test('multiple subscribers each get told, and unsubscribe independently', () => {
  const { handle, bridge } = install({ systemThemeVariant: 'dark' });
  const a = [];
  const b = [];
  const offA = bridge.subscribeToSystemThemeVariant((v) => a.push(v));
  bridge.subscribeToSystemThemeVariant((v) => b.push(v));
  handle.setSystemThemeVariant('light');
  offA();
  handle.setSystemThemeVariant('dark');
  assert.deepEqual(a, ['light']);
  assert.deepEqual(b, ['light', 'dark']);
});

// ---- the synchronously-read values -----------------------------------------

test('the four boot-time reads answer from config with no await', () => {
  const { bridge } = install({
    buildFlavor: 'relay',
    systemThemeVariant: 'light',
    sharedObjectSnapshot: { 'feature.flags': { a: true } },
  });
  assert.equal(bridge.getBuildFlavor(), 'relay');
  assert.equal(bridge.getSystemThemeVariant(), 'light');
  assert.deepEqual(bridge.getSharedObjectSnapshotValue('feature.flags'), { a: true });
  assert.equal(Object.keys(bridge.getSentryInitOptions()).length, 7);
});

test('an unknown shared-object key answers null, not undefined', () => {
  // undefined is indistinguishable from a missing bridge member; null is a
  // value that survives a structured clone and reads as "nothing here".
  const { bridge } = install({ sharedObjectSnapshot: { known: 1 } });
  assert.equal(bridge.getSharedObjectSnapshotValue('unknown'), null);
  assert.equal(bridge.getSharedObjectSnapshotValue('toString'), null, 'and no prototype leakage');
  assert.equal(bridge.getSharedObjectSnapshotValue('known'), 1);
});

test('the snapshot is copied, so a later config edit cannot reach the renderer', () => {
  const window = makeWindow();
  const snapshot = { a: 1 };
  const { bridge } = installElectronBridge({ window, config: bridgeConfig({ sharedObjectSnapshot: snapshot }) });
  snapshot.a = 2;
  assert.equal(bridge.getSharedObjectSnapshotValue('a'), 1);
});

test('the lazily-read sidebar bootstrap defaults to null', () => {
  assert.equal(install().bridge.getInitialSidebarBootstrap(), null);
  assert.deepEqual(install({ sidebarBootstrap: { pinned: [] } }).bridge.getInitialSidebarBootstrap(), { pinned: [] });
});

test('appSessionId follows the sentry session id unless told otherwise', () => {
  const { bridge } = install();
  assert.equal(bridge.getAppSessionId(), bridge.getSentryInitOptions().codexAppSessionId);
  const other = install({ appSessionId: 'second-placeholder' });
  assert.equal(other.bridge.getAppSessionId(), 'second-placeholder');
});

test('getPreloadStartedAtMs is a finite number the renderer can subtract', () => {
  const { bridge } = install({ preloadStartedAtMs: 1234 });
  assert.equal(bridge.getPreloadStartedAtMs(), 1234);
  assert.equal(Number.isFinite(install().bridge.getPreloadStartedAtMs()), true);
});

// ---- the no-ops return shapes that fail loudly if we guessed wrong ---------

test('the no-ops return the safe shape rather than undefined', () => {
  const { bridge } = install();
  assert.equal(bridge.acknowledgeChunkedMessage({ marker: 'x' }), undefined);
  assert.equal(bridge.getPathForFile({}), '', 'a browser has no filesystem path');
  assert.equal(bridge.startFileDrag({}), undefined);
  assert.equal(bridge.startLinkDrag({}), undefined);
  assert.equal(bridge.triggerSentryTestError(), undefined);
  assert.equal(bridge.getFastModeRolloutMetrics(), null);

  // A caller might chain on this, so it is a promise, not undefined. The two
  // worker members used to be asserted here on the same reasoning, which is
  // exactly the reasoning that does not hold for them.
  assert.equal(typeof bridge.showContextMenu([]).then, 'function');
});

test('the two boolean-ish members answer false by default and follow config', () => {
  // NOTE: these are implemented as FUNCTIONS, matching the other callables. If
  // the renderer reads them as bare booleans a function is always truthy, which
  // would select the Intel-Mac path wrongly. That shape is the one guess in
  // host-bridge.mjs not pinned by a reading of the bundle.
  const { bridge } = install();
  assert.equal(bridge.isDeviceCheckSupported(), false);
  assert.equal(bridge.isIntelMacBuild(), false);

  const flagged = install({ isDeviceCheckSupported: true, isIntelMacBuild: true });
  assert.equal(flagged.bridge.isDeviceCheckSupported(), true);
  assert.equal(flagged.bridge.isIntelMacBuild(), true);
});

test('a non-boolean flag is not treated as true', () => {
  const { bridge } = install({ isIntelMacBuild: 'yes' });
  assert.equal(bridge.isIntelMacBuild(), false);
});

// ---- the worker channel is absent on purpose -------------------------------

/**
 * The renderer's worker client, cut down to the parts that decide whether a
 * call ever settles: the synchronous guard, the pending entry, and the send
 * whose rejection is the only thing that clears it. Transcribed from the
 * client in the bundle rather than invented -- a friendlier fake would not
 * reproduce the hang this section exists to keep out.
 */
function rendererWorkerClient(window, workerId = 'git') {
  const pending = new Map();
  let lastId = 0;
  const unsubscribe = window.electronBridge?.subscribeToWorkerMessages?.(workerId, () => {});
  return {
    pending,
    unsubscribe,
    request(method) {
      const send = window.electronBridge?.sendWorkerMessageFromView;
      if (!send) return Promise.reject(new Error('Electron worker bridge is unavailable'));
      lastId += 1;
      const id = `request-${lastId}`;
      const settled = new Promise((resolve, reject) => {
        pending.set(id, { method, resolve, reject });
      });
      send(workerId, { type: 'worker-request', workerId, request: { id, method } }).catch((error) => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        entry.reject(error instanceof Error ? error : new Error(`Failed to send: ${String(error)}`));
      });
      return settled;
    },
  };
}

/** What a still-waiting renderer looks like from here. It is the bug, not a pass. */
const NEVER_SETTLED = Symbol('never settled');

/**
 * Race a renderer-visible promise against a short timer, so that a hang comes
 * back as a value. Awaiting a promise that never settles would stall the whole
 * file and report as a runner timeout, which names neither the member nor the
 * reason.
 */
async function outcomeWithin(promise, ms = 50) {
  let timer;
  const expiry = new Promise((resolve) => {
    timer = setTimeout(() => resolve(NEVER_SETTLED), ms);
  });
  try {
    return await Promise.race([promise.then((value) => ({ resolved: value }), (error) => error), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

test('the two worker members are absent rather than stubbed', () => {
  const { bridge } = install();
  for (const name of OMITTED_MEMBERS) {
    assert.equal(
      name in bridge,
      false,
      `${name} must be absent so the renderer's own guard is what fires`,
    );
    assert.equal(bridge[name], undefined);
  }
});

test('a worker request fails immediately instead of waiting forever', async () => {
  const { window } = install();
  const client = rendererWorkerClient(window);

  const outcome = await outcomeWithin(client.request('status-summary'));

  assert.ok(
    outcome instanceof Error,
    `the renderer must get an error back, not ${String(outcome?.description ?? outcome)}`,
  );
  assert.match(outcome.message, /worker bridge is unavailable/);
  assert.equal(client.pending.size, 0, 'and nothing is left behind waiting to be settled');
});

test('the client used above really does hang on a member that resolves', async () => {
  // Without this, the test above would also pass against a fake that rejects
  // whatever the bridge does, which would pin nothing. This is the state the
  // bridge was in before: a resolved send, a pending entry, no error anywhere.
  const { window } = install();
  window.electronBridge = {
    ...window.electronBridge,
    sendWorkerMessageFromView: () => Promise.resolve(),
    subscribeToWorkerMessages: () => () => {},
  };
  const client = rendererWorkerClient(window);

  const outcome = await outcomeWithin(client.request('status-summary'));

  assert.equal(outcome, NEVER_SETTLED, 'a resolving send leaves the call unsettled');
  assert.equal(client.pending.size, 1, 'and the pending entry nothing will ever clear');
});

test('the absent subscribe member does not throw at the site that calls it', () => {
  // The measured constructor is `window.electronBridge?.subscribeToWorkerMessages?.(id, cb)`,
  // so absence has to read as "no subscription", not as a TypeError during the
  // construction of the git client.
  const { window } = install();
  let client;
  assert.doesNotThrow(() => {
    client = rendererWorkerClient(window);
  });
  assert.equal(client.unsubscribe, undefined);
});

test('no installed member hands the renderer a promise that rejects', async () => {
  // Rejecting instead of omitting was the other available fix for the worker
  // stub, and it is wrong for a reason that generalises to this whole bridge:
  // the renderer drops some of these results on the floor. Its worker client
  // sends worker-request-cancel from an abort listener and ignores the promise
  // that comes back -- no `.catch` on that call -- so a dropped rejection
  // reaches the user as an error-level log-message about an unhandled promise
  // rather than as anything actionable.
  const { bridge } = install();
  for (const name of INSTALLED_MEMBERS) {
    if (name === 'windowType') continue;
    const returned = bridge[name](() => {});
    if (typeof returned?.then !== 'function') continue;
    await assert.doesNotReject(
      () => returned,
      `${name} returns a promise, so it must be one the renderer can safely ignore`,
    );
  }
});

// ---- teardown --------------------------------------------------------------

test('uninstall removes everything it put on the window', () => {
  const { window, handle } = install();
  handle.uninstall();
  assert.equal('electronBridge' in window, false);
  assert.equal('codexWindowType' in window, false);
  assert.equal('__SENTRY_IPC__' in window, false);
});

test('uninstall does not steal a bridge someone else installed after us', () => {
  const { window, handle } = install();
  const replacement = { windowType: 'other' };
  window.electronBridge = replacement;
  handle.uninstall();
  assert.equal(window.electronBridge, replacement);
});

// ---- the shared-object key that is not allowed to be null ------------------

test('pending_worktrees is seeded with an array, because null is a throw', () => {
  // The renderer's atom guards with `n === void 0` and then calls
  // `n.find(...)`. `null` passes that guard. `[]` is the only answer that is
  // both "no pending worktrees" and survivable; `undefined` would read as
  // "still loading" and never resolve.
  const { bridge } = install();
  const read = bridge.getSharedObjectSnapshotValue('pending_worktrees');

  assert.ok(Array.isArray(read), 'an array, not null');
  assert.equal(read.length, 0);
  assert.doesNotThrow(() => read.find((entry) => entry.clientThreadId === 'c1'));
  assert.equal(read.find((entry) => entry.clientThreadId === 'c1') ?? null, null);
});

test('every other key still answers null, which is what their consumers want', () => {
  // Not an oversight: each of these is read behind `?? []`, `!= null`,
  // `=== true` or an isEqual, so null is already their shaped empty. Seeding
  // them would be inventing state the host does not have.
  const { bridge } = install();
  for (const key of [
    'diff_comments',
    'host_config',
    'is_default_browser',
    'remote_control_connections',
    'remote_ssh_connections',
    'remote_wsl_connections',
    'statsig_default_enable_features',
    'statsig_evaluations',
  ]) {
    assert.equal(bridge.getSharedObjectSnapshotValue(key), null, key);
  }
});

test('a caller that supplies its own snapshot still gets the default merged under it', () => {
  const { bridge } = install({ sharedObjectSnapshot: { host_config: { hostId: 'local' } } });

  assert.deepEqual(bridge.getSharedObjectSnapshotValue('pending_worktrees'), []);
  assert.deepEqual(bridge.getSharedObjectSnapshotValue('host_config'), { hostId: 'local' });
});

test('a caller may override the default, because it might actually have worktrees', () => {
  const pending = [{ clientThreadId: 'c1', id: 'w1', hostId: 'local', isPinned: false }];
  const { bridge } = install({ sharedObjectSnapshot: { pending_worktrees: pending } });

  assert.deepEqual(bridge.getSharedObjectSnapshotValue('pending_worktrees'), pending);
});

test('two bridges do not share one array', () => {
  // A frozen module-level default would hand every bridge on the page the same
  // array identity, so a renderer that mutated it in place would mutate the
  // other one's state too.
  const a = install().bridge.getSharedObjectSnapshotValue('pending_worktrees');
  const b = install().bridge.getSharedObjectSnapshotValue('pending_worktrees');

  assert.notEqual(a, b, 'different identities');
  assert.deepEqual(a, b, 'same value');
});

test('an unknown key is still null, so a typo does not silently become an array', () => {
  const { bridge } = install();
  assert.equal(bridge.getSharedObjectSnapshotValue('pending_worktree'), null);
  assert.equal(bridge.getSharedObjectSnapshotValue('constructor'), null);
  assert.equal(bridge.getSharedObjectSnapshotValue('__proto__'), null);
});
