// The host namespaces, tested on what the renderer actually does to them.
//
// Two of these tests are not about behaviour at all, they are about SHAPE, and
// they are the reason the file exists:
//
//   * a namespace this module does not serve must read as `undefined`. 116 of
//     the renderer's 125 namespaces degrade correctly on absence -- 97 are
//     never dereferenced bare at all and 20 more are guarded at every one of
//     their 29 sites. It read 117 and 98 until computerUseSettings turned out
//     to have a bare, unguarded site: the sweep behind those numbers read
//     app-initial and app-shared, and that site is in local-conversation-turn. Serving them an empty object would flip all of those
//     guards to "host present" and send the app into initialisation paths with
//     nothing behind them -- a far worse failure than the one we are fixing,
//     and one that would look like progress.
//
//   * the services object must carry nothing but namespaces. Every own key
//     becomes a property of the renderer's `Se`, so a stray `stats` key is a
//     `Se.stats` in the page.
//
// The rest pin the three members against their call sites in app-initial, as
// read at the offsets quoted in web/host-namespaces.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertServable, createHostNamespaces } from '../../web/host-namespaces.mjs';

/**
 * Swap `globalThis.navigator` for the body of one test.
 *
 * `clipboard.writeText` reads it at CALL time rather than at construction, so
 * a per-test swap is enough -- and that late read is also what makes the
 * gesture fix in web/host-touch.mjs section 4 work without this module
 * knowing about it: the patch goes on the object, not on this call site.
 * Node defines `navigator` as a configurable own property of globalThis, so
 * this restores exactly what was there -- including the case where there was
 * nothing.
 *
 * @param {object} navigator
 * @param {() => Promise<void>} body
 */
async function withNavigator(navigator, body) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: navigator, configurable: true, writable: true, enumerable: false,
  });
  try {
    await body();
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  }
}


test('the served namespaces are exactly the ones with a call site that would throw', () => {
  const { services } = createHostNamespaces();
  assert.deepEqual(Object.keys(services), [
    'appInfo',
    'clipboard',
    'computerUseSettings',
    'customAvatars',
    'fileAttachments',
    'openIn',
    'requestUserInputAutoResolution',
    'workspaceFiles',
  ]);
});

test('the served MEMBERS are exactly the ones called without a guard', () => {
  // The inventory, and the test most likely to fail next. Each entry here was
  // decided by counting call sites in the production bundle that call the
  // member with NO optional chaining on the method: zero such sites means
  // omission is free and buys the bundle's own host-absent branch, one or more
  // means omission buys a TypeError. Adding a member without that count is how
  // this host would start lying to the page again -- most sharply at
  // `workspaceFiles.write`, where a non-null value is read straight into
  // `_meta['openai/resource'].writable = true` and told to the model.
  assert.deepEqual(createHostNamespaces().stats().members, [
    'appInfo.get',
    'clipboard.writeText',
    'computerUseSettings.getAppApprovals',
    'computerUseSettings.getLockedUseState',
    'computerUseSettings.getMessagesReadDecisions',
    'computerUseSettings.getMessagesSendApprovals',
    'computerUseSettings.getSoundMode',
    'computerUseSettings.removeAppApproval',
    'computerUseSettings.removeMessagesReadDecision',
    'computerUseSettings.removeMessagesSendApproval',
    'computerUseSettings.searchMessagesChats',
    'computerUseSettings.setLockedUseEnabled',
    'computerUseSettings.setMessagesReadAccessPolicy',
    'computerUseSettings.setMessagesReadDecision',
    'computerUseSettings.setMessagesSendAllowAllChats',
    'computerUseSettings.setSoundMode',
    'customAvatars.load',
    'customAvatars.loadAvatar',
    'fileAttachments.countFolderFiles',
    'openIn.getTargets',
    'openIn.open',
    'openIn.setGlobalPreferredTarget',
    'requestUserInputAutoResolution.recordConversationActivity',
    'requestUserInputAutoResolution.setConversationPresented',
    'requestUserInputAutoResolution.snooze',
    'workspaceFiles.read',
  ]);
});

test('an omitted member is undefined, which is the answer the bundle checks for', () => {
  // Per-member export exists for exactly this assertion. With a namespace
  // exported whole, the peer's proxy returns a fresh truthy stub for every
  // string property (`RBt`, app-shared @2171311, whose `get` is
  // unconditional and whose `ownKeys` returns []), so none of these could read
  // as absent and every hand-written `== null` branch below would be dead.
  const { services } = createHostNamespaces();
  const omitted = [
    // the bundle throws a written-for-this message when these are absent
    ['customAvatars', 'previewPetInstall'],
    ['customAvatars', 'installPet'],
    // a non-null value here advertises the user's file to the model as writable
    ['workspaceFiles', 'write'],
    // these two have a working browser download behind their absent branch
    ['workspaceFiles', 'saveCopy'],
    ['workspaceFiles', 'downloadCopy'],
    // four failed calls and no icon per attachment chip if served
    ['workspaceFiles', 'getThumbnailDataUrl'],
    ['workspaceFiles', 'createTemporaryFile'],
    ['workspaceFiles', 'releaseTemporaryFile'],
    ['workspaceFiles', 'getMetadata'],
    ['workspaceFiles', 'createDirectory'],
    ['workspaceFiles', 'getDownloadsFolderIcon'],
    ['fileAttachments', 'persistImageFileToTemp'],
    // all three `.clipboard.readText` sites in the bundle are navigator's
    ['clipboard', 'readText'],
    // read as a VALUE and handed to a schema builder; a function is wrong there
    ['clipboard', 'bookmark'],
    // zero renderer references
    ['openIn', 'detectTarget'],
    ['openIn', 'loadTargetIcon'],
    // the one member of a served namespace whose absent branch is the designed
    // one: local-conversation-turn@9861 reads it, finds null, and raises the
    // install-error toast. We cannot open a Chrome page on the user's desktop.
    ['computerUseSettings', 'openChromeExtensionInstallPage'],
  ];
  for (const [ns, member] of omitted) {
    assert.equal(services[ns][member], undefined, `${ns}.${member} must stay absent`);
    assert.equal(member in services[ns], false, `${ns}.${member} must not even be a key`);
  }
});

test('an unserved namespace is undefined, not an empty object', () => {
  // The regression guard for the 117. `Se.hostedThreadFiles == null` has to
  // stay true, so the renderer keeps taking its host-absent branch.
  const { services } = createHostNamespaces();
  for (const absent of ['hostedThreadFiles', 'notifications', 'projects', 'triggers', 'ui']) {
    assert.equal(services[absent], undefined, `${absent} must not be served`);
  }
});

// Every unserved namespace the renderer dereferences BARE somewhere, with the
// site that proves the guard. A text sweep of the shipped chunks for
// `<servicesAlias>.<ns>.<member>` surfaces exactly these 20, at 29 sites; each
// site was read, and each is guarded one level up on the namespace rather than
// by a `?.` on the method. The other 98 unserved namespaces have no bare site
// at all.
//
// This table is the audit. It is here so that adding any of these to the
// services object fails a test instead of silently flipping a guard in a chunk
// nobody is going to open -- the offset is the first thing to go read.
//
// Every offset below is in app-initial or app-shared, which is the whole scope
// the sweep had, and a list drawn from two chunks describes two chunks. A
// re-sweep over all 14,529 shipped chunks for a bare `.<ns>.<member>(` found
// 120 further call sites in 25 namespaces; all but one are guarded one level
// up (`if (c?.threadMetadata == null) throw`, `i.chronicle != null ?`) or are
// not host derefs at all (`Array.map`, `console.debug.bind`, xterm's
// `this.terminal`, the document model's `this.settings`). The exception was
// computerUseSettings, which is now served -- see the block in
// web/host-namespaces.mjs.
const GUARDED_BARE_SITES = [
  ['threadMetadata', 'app-initial@3611816', 'if (Se?.threadMetadata == null) throw'],
  ['realtimeVoice', 'app-initial@4127249', 'if (Se.realtimeVoice != null) try {'],
  ['appUpdates', 'app-initial@8826411', '&& Se.appUpdates != null && Se.appUpdates.takeResumeState()'],
  ['primaryRuntime', 'app-initial@9243926', 'if (Se?.primaryRuntime == null) return null'],
  ['projects', 'app-initial@3185352', 'if (Se.projects != null) { …; return } uu(g, PROJECT_APPEARANCES)'],
  ['browserHost', 'app-initial@4528571', '&& Se.browserHost != null && (… await …)'],
  ['owlBrowserCrashCounter', 'app-initial@9509023', '&& Se?.owlBrowserCrashCounter != null && (…)'],
  ['inAppBrowserIncompleteNavigation', 'app-initial@9509196', '&& Se?.inAppBrowserIncompleteNavigation != null && (…)'],
  ['realtimeContinuity', 'app-initial@9620063', 'v.enabled && Se.realtimeContinuity != null ? … : []'],
  ['realtimeMemory', 'app-initial@9620393', 'x && Se.realtimeMemory != null ? … : …'],
  ['workModeAccess', 'app-initial@9723320', '&& Se?.workModeAccess != null && Se.workModeAccess.publish()'],
  ['startup', 'app-initial@10058324', 'Tbc || Ebc || Dbc || Se.startup?.whenReady == null ? void 0 : …'],
  // These two fall through to HTTP, not to a degrade. host-fetch.mjs answers
  // `get-setting`/`set-setting` and refuses `codex-home` deliberately; serving
  // the namespace here would take the working path away.
  ['settings', 'app-shared@3465648', 'i6?.settings == null ? await HW(`get-setting`) : i6.settings.read()'],
  ['executionPaths', 'app-shared@3241461', 'i6?.executionPaths == null ? await t(`codex-home`) : …'],
  ['statsigEvaluations', 'app-shared@3703210', 'if (i6?.statsigEvaluations != null) return …'],
  ['hostedThreadFiles', 'app-shared@4936989', 'if (t != null && i6.hostedThreadFiles != null) … catch {}'],
  ['pluginIncentives', 'app-shared@5293209', 'if (n == null || i6?.pluginIncentives == null) return'],
  ['pageCompanionTasks', 'app-shared@5421593', 'if (i6?.pageCompanionTasks != null) { …; return } localStorage'],
  ['clientCoordination', 'app-shared@5536322', '&& i6.clientCoordination != null) try {'],
  ['dynamicToolCalls', 'app-shared@5536635', '&& i6.dynamicToolCalls != null && !await …'],
];

test('every namespace with a bare-but-guarded site stays unserved', () => {
  const { services } = createHostNamespaces();
  for (const [ns, site, guard] of GUARDED_BARE_SITES) {
    assert.equal(
      services[ns],
      undefined,
      `${ns} must stay unserved -- ${site} reads it bare but guards it with \`${guard}\`. `
        + 'If you are adding it, go read that site first: serving it flips the guard.',
    );
  }
});

test('the audited list and the served list do not overlap', () => {
  // Cheap, but it is the invariant the table above encodes, and a copy-paste
  // into the wrong array is exactly how a table like this goes stale.
  const { services } = createHostNamespaces();
  const served = new Set(Object.keys(services));
  const overlap = GUARDED_BARE_SITES.map(([ns]) => ns).filter((ns) => served.has(ns));
  assert.deepEqual(overlap, [], 'a namespace cannot be both served and audited-as-absent');
});

test('stats are returned beside the services object, never on it', () => {
  const host = createHostNamespaces();
  assert.equal(typeof host.stats, 'function');
  assert.equal('stats' in host.services, false, 'a stats key here is a `Se.stats` in the page');
  assert.equal('calls' in host.services, false);
});

test('a namespace name the renderer would silently delete is refused', () => {
  // The evaluator does `(t in Object.prototype || t === 'toJSON') ? (…, delete
  // e[t]) : …`, so these would be served, evaluated, dropped, and reported as
  // served. Failing loudly here is the whole point.
  for (const trap of ['toString', 'valueOf', 'constructor', 'hasOwnProperty', 'toJSON']) {
    assert.throws(
      () => assertServable({ [trap]: {} }),
      /collides with Object\.prototype/,
      `${trap} must be refused`,
    );
  }
  assert.deepEqual(assertServable({ workspaceFiles: {} }), { workspaceFiles: {} });
});

test('every served member is callable, because `Se.ns.member` is called not read', () => {
  const { services } = createHostNamespaces();
  for (const [name, namespace] of Object.entries(services)) {
    for (const [member, value] of Object.entries(namespace)) {
      assert.equal(typeof value, 'function', `${name}.${member} must be callable`);
    }
  }
});

// ---- requestUserInputAutoResolution ----------------------------------------

test('the three members the renderer dereferences without a guard are all present', () => {
  const { services } = createHostNamespaces();
  const ns = services.requestUserInputAutoResolution;
  assert.deepEqual(
    Object.keys(ns).sort(),
    ['recordConversationActivity', 'setConversationPresented', 'snooze'],
  );
});

test('setConversationPresented tracks what is on screen, and forgets what leaves', () => {
  const host = createHostNamespaces();
  const ns = host.services.requestUserInputAutoResolution;

  ns.setConversationPresented({ conversationId: 'c1', hostId: 'local', presented: true });
  ns.setConversationPresented({ conversationId: 'c2', hostId: 'local', presented: true });
  assert.equal(host.stats().presented, 2);

  // The cleanup arm of the same useLayoutEffect.
  ns.setConversationPresented({ conversationId: 'c1', hostId: 'local', presented: false });
  assert.equal(host.stats().presented, 1, 'false deletes rather than storing false');

  // Idempotent: React can run an effect twice in development.
  ns.setConversationPresented({ conversationId: 'c2', hostId: 'local', presented: true });
  assert.equal(host.stats().presented, 1);
});

test('the same conversation on two hosts is two entries', () => {
  // `hostId` is `it ?? 'local'` at the call site, so a foreign host id is a
  // real possibility and a conversation id alone is not a key.
  const host = createHostNamespaces();
  const ns = host.services.requestUserInputAutoResolution;
  ns.setConversationPresented({ conversationId: 'c1', hostId: 'local', presented: true });
  ns.setConversationPresented({ conversationId: 'c1', hostId: 'remote', presented: true });
  assert.equal(host.stats().presented, 2);
});

test('every member returns undefined, because every call site discards it', () => {
  const { services } = createHostNamespaces();
  const ns = services.requestUserInputAutoResolution;
  assert.equal(ns.setConversationPresented({ conversationId: 'c', presented: true }), undefined);
  assert.equal(ns.recordConversationActivity({ conversationId: 'c', hostId: 'local' }), undefined);
  assert.equal(ns.snooze({ conversationId: 'c', hostId: 'local', requestId: '7' }), undefined);
});

test('a member called with no argument does not throw', () => {
  // Nothing in the bundle calls these bare, but a stub that throws on a shape
  // it did not expect is a stub that reintroduces the crash it was written to
  // remove -- and `setConversationPresented` runs inside a layout effect.
  const { services } = createHostNamespaces();
  const ns = services.requestUserInputAutoResolution;
  for (const member of Object.values(ns)) {
    assert.doesNotThrow(() => member());
    assert.doesNotThrow(() => member(null));
  }
});

test('calls are counted, so an unexercised stub is distinguishable from a wrong one', () => {
  const host = createHostNamespaces();
  const ns = host.services.requestUserInputAutoResolution;
  assert.deepEqual(host.stats().calls, {});

  ns.recordConversationActivity({ conversationId: 'c', hostId: 'local' });
  ns.recordConversationActivity({ conversationId: 'c', hostId: 'local' });
  assert.equal(host.stats().calls['requestUserInputAutoResolution.recordConversationActivity'], 2);
  assert.equal(host.stats().calls['requestUserInputAutoResolution.snooze'], undefined);
});

test('snooze reports itself, because reaching it means a premise changed', () => {
  // Every snooze call site is gated on host-pushed resolution state, and we
  // push none, so this is unreachable today. If it ever fires, the quiet
  // success is a lie -- the user clicked Snooze and nothing was snoozed -- so
  // the event is the thing that makes it visible.
  const events = [];
  const host = createHostNamespaces({ onEvent: (event) => events.push(event) });
  host.services.requestUserInputAutoResolution.snooze({ conversationId: 'c', hostId: 'local', requestId: '7' });
  assert.deepEqual(events, [{ kind: 'snooze-unexpected', requestId: '7' }]);
});

test('an observer that throws does not take the host call down with it', () => {
  // `setConversationPresented` is called from a useLayoutEffect: a throw there
  // kills the React commit. The observer is a diagnostic and must never be
  // able to cause the fault it is there to report.
  const host = createHostNamespaces({
    onEvent: () => {
      throw new Error('observer is broken');
    },
  });
  assert.doesNotThrow(
    () => host.services.requestUserInputAutoResolution.setConversationPresented({ conversationId: 'c', presented: true }),
  );
  assert.equal(host.stats().presented, 1, 'the call still did its work');
});

test('two hosts do not share state', () => {
  const a = createHostNamespaces();
  const b = createHostNamespaces();
  a.services.requestUserInputAutoResolution.setConversationPresented({ conversationId: 'c', presented: true });
  assert.equal(a.stats().presented, 1);
  assert.equal(b.stats().presented, 0);
  assert.deepEqual(b.stats().calls, {});
});

// ---- appInfo: the one member whose RESULT is dereferenced bare -------------

test('appInfo.get resolves production\'s record, field for field', async () => {
  // `gate.electron @21430` does `let r = await n.appInfo.get(); …
  // r.chatGptDesktopAuthOrigin ?? 'https://chatgpt.com/codex'` and
  // `login-route @26523` does `(await n.appInfo.get()).chatGptDesktopAuthOrigin`
  // -- the RESULT derefed bare, inside the checkout and login-redirect flows.
  // So this is the one member in the file that must not reject.
  const { services } = createHostNamespaces({
    appInfo: { version: '1.2.3', buildNumber: '456', buildFlavor: 'staging' },
  });
  const record = await services.appInfo.get();

  assert.deepEqual(Object.keys(record), [
    'version', 'buildNumber', 'buildFlavor', 'osName', 'systemVersion',
    'appName', 'chatGptDesktopAuthOrigin', 'chatGptApiBaseUrl',
    'appIconMedium', 'dockIconPreviews', 'preloadAttribution',
  ], 'the key set and its order follow main @688927, so the two are diffable');

  assert.equal(record.version, '1.2.3');
  assert.equal(record.buildNumber, '456');
  assert.equal(record.buildFlavor, 'staging');
});

test('the two undefined fields are PRESENT and undefined, as in production', async () => {
  // `chatGptDesktopAuthOrigin: void 0, chatGptApiBaseUrl: void 0` is literally
  // what main @688927 ships -- not null, not absent. Structured clone
  // preserves an undefined object value, so sending them this way reproduces
  // the real record and makes the consumers' `??` fallbacks the designed path
  // rather than a degradation. Null would NOT be equivalent: `null ?? x` and
  // `undefined ?? x` agree, but `JSON.stringify` and every `=== undefined`
  // check in the page do not.
  const record = await createHostNamespaces().services.appInfo.get();
  for (const key of ['chatGptDesktopAuthOrigin', 'chatGptApiBaseUrl']) {
    assert.equal(key in record, true, `${key} must be a key`);
    assert.equal(record[key], undefined, `${key} must be undefined, not null`);
  }
});

test('appInfo.get resolves a PROMISE, because three call sites .catch() it', async () => {
  // `y.current = Se.appInfo.get().catch(wWs)` with `wWs(){return null}` -- a
  // plain object would be a TypeError on `.catch`.
  const returned = createHostNamespaces().services.appInfo.get();
  assert.equal(typeof returned?.then, 'function');
  assert.equal(typeof returned?.catch, 'function');
  await returned;
});

test('the host fields nothing in the page can know are null, not invented', async () => {
  // `osName`/`systemVersion` describe the machine the app runs on. That
  // machine is the resident Mac and the page cannot see it; production itself
  // sends null whenever `lt()` does not recognise the platform. Reporting the
  // PHONE's platform here would be a different fact wearing this one's name,
  // and it would land in a feedback submission as the user's OS.
  const record = await createHostNamespaces().services.appInfo.get();
  for (const key of ['osName', 'systemVersion', 'appIconMedium', 'dockIconPreviews']) {
    assert.equal(record[key], null, `${key} must be null`);
  }
});

test('a missing config gives a placeholder rather than throwing the layer', async () => {
  // The defaults exist so a test -- and a boot with a half-built config -- can
  // build this layer. They are deliberately ugly: '0.0.0' in a bug report is
  // recognisable as a placeholder, where a plausible-looking version is not.
  const record = await createHostNamespaces().services.appInfo.get();
  assert.equal(record.version, '0.0.0');
  assert.equal(record.buildNumber, '0');
});

// ---- clipboard: the one member that does real work ------------------------

test('clipboard.writeText writes through to the browser clipboard', async () => {
  // Five sites read both namespace and method bare off the services object
  // (`Se.clipboard.writeText(…)`, app-initial @2171277 / @4555586 / @5388592 /
  // @5602420 / @8183274), and four of them have no fallback, so declining
  // would leave "Copy path" and "Copy link" dead. share-thread @25369 shows
  // what to delegate to: its own recovery path for a failed host clipboard is
  // `navigator.clipboard.writeText`.
  const written = [];
  await withNavigator({ clipboard: { writeText: async (t) => { written.push(t); } } }, async () => {
    const { services, stats } = createHostNamespaces();
    await services.clipboard.writeText('hello');
    assert.deepEqual(written, ['hello']);
    assert.equal(stats().calls['clipboard.writeText'], 1);
  });
});

test('clipboard.writeText REJECTS when the browser has no clipboard', async () => {
  // A quiet resolve would tell the user their text was copied while the
  // clipboard still holds whatever it held before. The rejection is what makes
  // the app's toast and its manual-copy dialog appear.
  await withNavigator({}, async () => {
    const { services } = createHostNamespaces();
    await assert.rejects(
      () => services.clipboard.writeText('hello'),
      /clipboard\.writeText is unavailable on this host/,
    );
  });
});

test('a non-string argument is coerced rather than passed through', async () => {
  const written = [];
  await withNavigator({ clipboard: { writeText: async (t) => { written.push(t); } } }, async () => {
    const { services } = createHostNamespaces();
    await services.clipboard.writeText(undefined);
    await services.clipboard.writeText(42);
    assert.deepEqual(written, ['', '42']);
  });
});

// ---- openIn: a host with no targets, stated completely --------------------

test('openIn.getTargets resolves a FULL record, not an empty object', async () => {
  // `{}` is worse than nothing: a consumer does `i?.targets.map(...)`, which
  // guards the result and not the array inside it, so a record missing
  // `targets` is a TypeError where a record with an empty array is an empty
  // menu.
  const record = await createHostNamespaces().services.openIn.getTargets();
  assert.deepEqual(record, {
    preferredTarget: null,
    availableTargets: [],
    mode: 'editor',
    targets: [],
  });
  assert.equal(Array.isArray(record.targets), true);
  assert.deepEqual(record.targets.map((t) => t), [], 'the consumer\'s `.map` must not throw');
});

test('openIn.open resolves success:false, because success:true outlives the click', async () => {
  // `{success: true}` makes the caller write a `recent-workspace-files` entry
  // for a file that never opened -- the lie then shows up later as a recent
  // file nobody opened.
  assert.deepEqual(await createHostNamespaces().services.openIn.open({ target: 'vscode' }), {
    success: false,
  });
});

test('openIn.setGlobalPreferredTarget declines, with the reason in the message', async () => {
  // A rejection crosses this wire as `{message}` and nothing else --
  // web/host-capnweb.mjs `settle` builds the frame from `err.message` alone --
  // so a reason on a `code` property would be dropped silently on the way out.
  await assert.rejects(
    () => createHostNamespaces().services.openIn.setGlobalPreferredTarget({ target: 'vscode' }),
    (err) => {
      assert.match(err.message, /openIn\.setGlobalPreferredTarget is unavailable on this host/);
      assert.match(err.message, /nowhere to persist a preference/);
      return true;
    },
  );
});

// ---- customAvatars -------------------------------------------------------

test('customAvatars.load never resolves undefined, because TanStack throws on it', async () => {
  // react-query raises "Query data cannot be undefined" rather than treating
  // undefined as empty, and this feeds a queryFn (app-initial @6013279).
  const loaded = await createHostNamespaces().services.customAvatars.load();
  assert.notEqual(loaded, undefined);
  assert.deepEqual(loaded, { avatarDirectory: null, avatars: [] });
});

test('customAvatars.loadAvatar resolves null, a state the caller renders', async () => {
  assert.equal(await createHostNamespaces().services.customAvatars.loadAvatar('id'), null);
});

// ---- workspaceFiles and fileAttachments ----------------------------------

test('workspaceFiles.read declines rather than being absent', async () => {
  // 14 call sites across 10 chunks, re-measured over all 14,531 renderer
  // files; the earlier count of 12 across 9 missed an aliased call in
  // `images` (`l.read(...)` where `l = t.workspaceFiles`, @5563) and the
  // whole of `artifact-tab-content.electron` (@112572). 13 of the 14 call it
  // unconditionally -- only @112572 probes with `?.read?.(`, while EVERY
  // sibling member in `workspaceFiles` is null-probed at every site. So `read`
  // is measurably the one member of this namespace the renderer treats as
  // mandatory: omitting it is 13 TypeErrors, and a rejection takes the same
  // control path at each of them while being the only one of the two that
  // says why.
  await assert.rejects(
    () => createHostNamespaces().services.workspaceFiles.read({ uri: 'file:///x' }),
    (err) => {
      assert.match(err.message, /workspaceFiles\.read is unavailable on this host/);
      // The reason names the adapter on purpose: this is the one member here
      // with a real implementation available behind the resident-machine
      // tunnel, so the message should point at the work, not at a dead end.
      assert.match(err.message, /resident-machine adapter/);
      return true;
    },
  );
});

test('serving read does not flip the writable advertisement', async () => {
  // The only probe that looks at `read` is artifact-tab-content @75472's
  // combined `read != null && write != null`. It still fails on `write`, so
  // the MCP resource stays advertised read-only -- which is true.
  const { services } = createHostNamespaces();
  assert.notEqual(services.workspaceFiles.read, undefined);
  assert.equal(services.workspaceFiles.write, undefined);
  assert.equal(
    services.workspaceFiles.read != null && services.workspaceFiles.write != null,
    false,
    'the combined probe must stay false',
  );
});

test('countFolderFiles declines rather than resolving a wrong zero', async () => {
  // The single bare call is a queryFn keyed `['folder-file-count', hostId,
  // folderPath]`. A fake 0 would print "0 files" next to a folder that has
  // files; a rejection leaves the count absent, which the chip already
  // renders.
  await assert.rejects(
    () => createHostNamespaces().services.fileAttachments.countFolderFiles({
      folderPath: '/x', hostId: 'local',
    }),
    /unavailable on this host.*rather than zero/s,
  );
});

// ---- the two members that reach a real filesystem -------------------------
//
// Everything above this point describes the host with no disk, which is what
// it is whenever the link to the resident machine failed. These are the same
// two members with `files` supplied. The division is worth keeping: the
// no-disk host is not a degenerate case to be deleted once the adapter works,
// it is the shape the renderer gets on every failed connection.

/** A `files` double, so these tests are about the member and not the adapter. */
function fakeFiles(contents = {}, { folders = {} } = {}) {
  const seen = [];
  return {
    seen,
    readBytes: async (path) => {
      seen.push(['readBytes', path]);
      const found = contents[path];
      if (found === undefined) throw new Error(`ENOENT: ${path}`);
      return found;
    },
    metadata: async (path) => {
      seen.push(['metadata', path]);
      return contents[path] === undefined ? null : { modifiedAtMs: 1000, createdAtMs: 500 };
    },
    readDirectory: async () => [],
    countFolderFiles: async (path) => {
      seen.push(['countFolderFiles', path]);
      return folders[path] ?? null;
    },
  };
}

const utf8 = (text) => new TextEncoder().encode(text);

test('a text read returns text, and the blob key is ABSENT rather than undefined', async () => {
  // The single most load-bearing fact about this return value, and the one
  // the App's implementation satisfies without saying so. 13 of the 14 call
  // sites discriminate the union with `in` -- `if (!('blob' in r)) throw` --
  // and none uses `?.` or `!= null`. A result of `{ blob: undefined, text }`
  // therefore passes `'blob' in r` at 10 sites that then read `.blob` as
  // bytes; one measured consequence is a downloaded file containing the five
  // characters `undefined`.
  const files = fakeFiles({ '/w/a.txt': utf8('hello') });
  const { services } = createHostNamespaces({ files });
  const result = await services.workspaceFiles.read({ path: '/w/a.txt', representation: 'text' });

  assert.equal(result.text, 'hello');
  assert.equal('blob' in result, false, 'the key the caller tests for must not be there at all');
  assert.match(result.etag, /^stat:/);
});

test('a blob read returns base64, and the text key is absent for the same reason', async () => {
  const { services } = createHostNamespaces({ files: fakeFiles({ '/w/b.bin': new Uint8Array([0, 1, 2]) }) });
  const result = await services.workspaceFiles.read({ path: '/w/b.bin', representation: 'blob' });

  assert.equal(result.blob, 'AAEC', 'standard base64, which is what every call site decodes');
  assert.equal('text' in result, false);
});

test('auto sniffs the bytes, which is the only arm a third party can reach', async () => {
  // No first-party site passes `auto`: 10 pass the literal 'blob', 3 pass
  // 'text', and the 14th passes a value parsed out of an MCP app's
  // `_meta['openai/resource'].representation`, whose schema allows only
  // 'blob' and 'text' and whose default is 'auto'. So this branch is both the
  // least-travelled and the only one exposed to input from outside the App.
  const { services } = createHostNamespaces({
    files: fakeFiles({ '/w/t': utf8('plain'), '/w/b': new Uint8Array([104, 0, 105]) }),
  });

  const text = await services.workspaceFiles.read({ path: '/w/t', representation: 'auto' });
  assert.equal(text.text, 'plain');
  assert.equal('blob' in text, false);

  const blob = await services.workspaceFiles.read({ path: '/w/b', representation: 'auto' });
  assert.equal(blob.blob, 'aABp', 'a NUL makes it binary and the union flips');
  assert.equal('text' in blob, false);
});

test('an unrecognised representation rejects instead of resolving undefined', async () => {
  // The App's two switches are exhaustive over the three names with no
  // default, so a fourth name falls out of the function and `undefined`
  // crosses the wire -- which becomes a TypeError on the caller's `.text`,
  // one frame away from anything that names the cause. Measured as
  // unreachable from the shipped renderer, which is what makes rejecting here
  // free rather than a behaviour change.
  const { services } = createHostNamespaces({ files: fakeFiles({ '/w/a': utf8('x') }) });
  await assert.rejects(
    () => services.workspaceFiles.read({ path: '/w/a', representation: 'bytes' }),
    /not one of 'auto', 'blob' or 'text'/,
  );
  await assert.rejects(
    () => services.workspaceFiles.read({ path: '/w/a' }),
    /got representation null/,
    'an omitted representation is the same mistake and gets the same message',
  );
});

test('a relative path is refused, not resolved against somebody else\'s cwd', async () => {
  // The App re-roots a relative path onto the first workspace root and probes
  // for existence. This host cannot: it has no workspace root, and passing
  // the path through means the ADAPTER resolves it -- against its own working
  // directory, on a machine the caller is not looking at. That returns bytes
  // from a real file that is not the file anybody asked for, and a wrong file
  // is the one outcome worse than no file.
  const files = fakeFiles({ '/w/a': utf8('x') });
  const { services } = createHostNamespaces({ files });
  await assert.rejects(
    () => services.workspaceFiles.read({ path: 'a.txt', representation: 'text' }),
    /does not re-root a relative one/,
  );
  await assert.rejects(() => services.workspaceFiles.read({ path: '', representation: 'text' }), /needs a path/);
  assert.deepEqual(files.seen, [], 'and nothing crossed the relay to find that out');
});

test('an absolute windows or UNC path is accepted, because the host may be either', async () => {
  const { services } = createHostNamespaces({
    files: fakeFiles({ 'C:\\w\\a': utf8('win'), '\\\\srv\\share\\a': utf8('unc') }),
  });
  assert.equal((await services.workspaceFiles.read({ path: 'C:\\w\\a', representation: 'text' })).text, 'win');
  assert.equal((await services.workspaceFiles.read({ path: '\\\\srv\\share\\a', representation: 'text' })).text, 'unc');
});

test('over maxBytes rejects with the message the App rejects with', async () => {
  // Not because a caller matches on the text -- all 14 were checked and none
  // surfaces it, each substituting a fixed string of its own or swallowing
  // the rejection entirely. Keeping the wording identical just keeps the diff
  // against the App short.
  const { services } = createHostNamespaces({ files: fakeFiles({ '/w/big': utf8('0123456789') }) });
  await assert.rejects(
    () => services.workspaceFiles.read({ path: '/w/big', maxBytes: 4, representation: 'blob' }),
    /Workspace file exceeds the requested size limit/,
  );
  // Exactly at the limit is not over it.
  assert.equal(
    (await services.workspaceFiles.read({ path: '/w/big', maxBytes: 10, representation: 'text' })).text,
    '0123456789',
  );
});

test('a zero or negative maxBytes rejects every file, including an empty one', async () => {
  // The App's skill loader passes `maxBytes: BUDGET - consumedSoFar` with no
  // floor under it and only a FILE-COUNT guard on the loop, so a large enough
  // earlier file in the same batch drives this to zero and then below it.
  // Rejecting is the right answer for "this batch is already over budget",
  // and it is more defined than the App, where a negative length reaches a
  // byte-limited read whose behaviour there is unspecified.
  const { services } = createHostNamespaces({ files: fakeFiles({ '/w/e': utf8(''), '/w/a': utf8('a') }) });
  await assert.rejects(() => services.workspaceFiles.read({ path: '/w/a', maxBytes: 0, representation: 'text' }));
  await assert.rejects(() => services.workspaceFiles.read({ path: '/w/e', maxBytes: -1, representation: 'text' }));
  assert.equal(
    (await services.workspaceFiles.read({ path: '/w/e', maxBytes: 0, representation: 'text' })).text,
    '',
    'an empty file is still within a budget of zero',
  );
});

test('a read that fails on the far side fails here, with the adapter\'s reason', async () => {
  const { services } = createHostNamespaces({ files: fakeFiles({}) });
  await assert.rejects(
    () => services.workspaceFiles.read({ path: '/w/gone', representation: 'text' }),
    /ENOENT/,
  );
});

test('the etag survives a vanished file instead of taking the read down', async () => {
  // `metadata` answers null for a path that is not there, and the two round
  // trips are concurrent -- so a file deleted between them yields bytes and no
  // stat. `missing` is a legal etag; throwing would turn a race into an error
  // the user sees.
  const { services } = createHostNamespaces({
    files: { ...fakeFiles({ '/w/a': utf8('x') }), metadata: async () => null },
  });
  const result = await services.workspaceFiles.read({ path: '/w/a', representation: 'text' });
  assert.equal(result.etag, 'missing');
  assert.equal(result.text, 'x');
});

test('hostId is recorded and not enforced, because this relay has one host', async () => {
  // The App selects a filesystem out of an execution-host registry by this id.
  // The relay has exactly one and answers every id with it, which is correct
  // while that stays true -- so the id goes in the event log, where a second
  // host would appear as a surprise rather than as a silent wrong answer.
  const events = [];
  const { services } = createHostNamespaces({
    files: fakeFiles({ '/w/a': utf8('x') }),
    onEvent: (event) => events.push(event),
  });
  await services.workspaceFiles.read({ path: '/w/a', representation: 'text', hostId: 'some-other-host' });
  const read = events.find((event) => event.kind === 'read');
  assert.equal(read.hostId, 'some-other-host');
  assert.equal(read.bytes, 1);
});

test('countFolderFiles returns the count, and null for a walk it could not finish', async () => {
  // `null` is not an error and not a zero: the renderer keys a query on
  // `['folder-file-count', hostId, folderPath]` and renders nothing for an
  // absent count, which is the honest rendering of "more files than I was
  // willing to walk".
  const { services } = createHostNamespaces({
    files: fakeFiles({}, { folders: { '/w/small': 7, '/w/empty': 0 } }),
  });
  assert.equal(await services.fileAttachments.countFolderFiles({ folderPath: '/w/small' }), 7);
  assert.equal(await services.fileAttachments.countFolderFiles({ folderPath: '/w/empty' }), 0);
  assert.equal(await services.fileAttachments.countFolderFiles({ folderPath: '/w/huge' }), null);
  await assert.rejects(() => services.fileAttachments.countFolderFiles({}), /folderPath/);
});

test('a host given no filesystem still exports both members, and still declines', async () => {
  // The member list is part of the handshake: the renderer probes for
  // existence and a member that appears only when the link is healthy is a
  // capability that changes under the renderer mid-session. So the difference
  // between a host with a disk and one without is the behaviour of the call,
  // never the shape of the object.
  const withDisk = createHostNamespaces({ files: fakeFiles() });
  assert.deepEqual(
    createHostNamespaces().stats().members,
    withDisk.stats().members,
    'the same members either way',
  );
  await assert.rejects(
    () => createHostNamespaces().services.workspaceFiles.read({ path: '/w/a', representation: 'text' }),
    /resident-machine adapter/,
  );
});

// ---- the shape guards, at member level -----------------------------------

test('a MEMBER name the renderer would silently delete is refused too', () => {
  // Per-member export moved the trap one level down: the evaluator recurses,
  // so `{ns: {toString: fn}}` is now reachable by it. Before per-member export
  // only the namespace name could collide.
  for (const trap of ['toString', 'valueOf', 'constructor', 'hasOwnProperty', 'toJSON']) {
    assert.throws(
      () => assertServable({ ns: { [trap]: () => {} } }),
      /collides with Object\.prototype|toJSON/,
      `ns.${trap} must be refused`,
    );
  }
});

// ---- stats ---------------------------------------------------------------

test('every member counts its calls, so an unexercised stub is distinguishable', async () => {
  const { services, stats } = createHostNamespaces();
  assert.deepEqual(stats().calls, {}, 'nothing is counted before it is called');

  await services.appInfo.get();
  await services.openIn.getTargets();
  await services.workspaceFiles.read({}).catch(() => {});

  assert.equal(stats().calls['appInfo.get'], 1);
  assert.equal(stats().calls['openIn.getTargets'], 1);
  assert.equal(stats().calls['workspaceFiles.read'], 1, 'a declining member still counts');
  assert.equal(stats().calls['clipboard.writeText'], undefined);
});

test('a declining member reports the reason to the observer as well', async () => {
  const seen = [];
  const { services } = createHostNamespaces({ onEvent: (e) => seen.push(e) });
  await services.workspaceFiles.read({}).catch(() => {});

  assert.deepEqual(seen.filter((e) => e.kind === 'declined').map((e) => e.member), [
    'workspaceFiles.read',
  ]);
});

test('an observer that throws does not take a host call down with it', async () => {
  const { services } = createHostNamespaces({
    onEvent: () => { throw new Error('observer is broken'); },
  });
  // The call must still settle normally -- the layout-effect member is the
  // one where a throw is the render, not a logged error.
  services.requestUserInputAutoResolution.setConversationPresented({
    conversationId: 'c', hostId: 'h', presented: true,
  });
  assert.deepEqual(await services.openIn.getTargets(), {
    preferredTarget: null, availableTargets: [], mode: 'editor', targets: [],
  });
});

// The mirror of GUARDED_BARE_SITES: the sites that require a namespace to be
// PRESENT. One entry so far, and it is the one the two-chunk sweep missed.
const BARE_UNGUARDED_SITES = [
  ['computerUseSettings', 'local-conversation-turn@9861',
    'u = n.computerUseSettings.openChromeExtensionInstallPage; if (u == null)'],
];

test('every namespace with a bare UNGUARDED site stays served', () => {
  const { services } = createHostNamespaces();
  for (const [ns, site, deref] of BARE_UNGUARDED_SITES) {
    assert.notEqual(
      services[ns],
      undefined,
      `${ns} must stay served -- ${site} reads it as \`${deref}\`, with the member `
        + 'guarded and the namespace not. Removing it is a TypeError on the turn path.',
    );
  }
});

test('the computer-use getters answer in the shape their consumer reads', async () => {
  // `getLockedUseState` is the one with a shape to get wrong: the mutation's
  // onSuccess in codex-mobile-setup-dialog rebuilds the cache entry as
  // `{computerIconDataURL: t?.computerIconDataURL ?? null, enabled: e,
  // lockIconDataURL: t?.lockIconDataURL ?? null}`, so the two icon fields are
  // read off the PREVIOUS value and `enabled` is the only one read directly.
  const { services } = createHostNamespaces();
  const cus = services.computerUseSettings;

  assert.deepEqual(await cus.getLockedUseState(), {
    enabled: false,
    computerIconDataURL: null,
    lockIconDataURL: null,
  });
  assert.equal(await cus.getSoundMode(), 'off');
  for (const list of ['getAppApprovals', 'getMessagesReadDecisions',
    'getMessagesSendApprovals', 'searchMessagesChats']) {
    assert.deepEqual(await cus[list](), [], `${list} must answer with an empty list`);
  }
});

test('the computer-use setters decline instead of resolving', async () => {
  // The distinction the whole namespace turns on. A no-op setter RESOLVES, the
  // settings UI redraws as though the approval were revoked, and the desktop
  // that actually holds it goes on honouring it. Every one of these must
  // reject, and the reason has to be in the message -- a rejection crosses
  // this wire as `{message}` and nothing else.
  const { services } = createHostNamespaces();
  const cus = services.computerUseSettings;
  const setters = ['removeAppApproval', 'removeMessagesReadDecision',
    'removeMessagesSendApproval', 'setLockedUseEnabled', 'setMessagesReadAccessPolicy',
    'setMessagesReadDecision', 'setMessagesSendAllowAllChats', 'setSoundMode'];

  for (const name of setters) {
    await assert.rejects(
      () => cus[name]('whatever'),
      (err) => {
        assert.match(err.message, new RegExp(`^computerUseSettings\\.${name} is unavailable`));
        assert.match(err.message, /no computer-use desktop/);
        return true;
      },
      `${name} must reject rather than quietly succeed`,
    );
  }
  assert.equal(setters.length, 8);
});
