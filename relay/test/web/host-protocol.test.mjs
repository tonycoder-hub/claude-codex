// The vocabulary, tested mostly on what it refuses.
//
// A builder that produces the right shape when you feed it the right arguments
// is the easy half and the half that rarely breaks. What breaks is the wrong
// argument reaching a builder that shrugs and emits something plausible, which
// the renderer then ignores without complaint -- its host switch has 188 cases
// and no default branch, so a wrong type is silence rather than an error. These
// tests are weighted accordingly.
//
// The spellings below are typed out as literals on purpose. A test that
// imports the constant it is checking against is a test that asserts a string
// equals itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  APP_SERVER_RESULT_SHAPES,
  BUFFERED_INBOUND_TYPES,
  CHUNK_MARKER,
  CONNECTION_STATE_CONNECTED,
  CONNECT_APP_HOST,
  ELECTRON_ONLY_PUSHES,
  FETCH_RESPONSE_ERROR,
  FETCH_RESPONSE_SUCCESS,
  HOST_ID_LOCAL,
  INBOUND,
  INBOUND_NOTIFICATION_COUNT,
  KNOWN_DROPPED_NOTIFICATION_METHODS,
  OUTBOUND,
  OUTBOUND_EVENT,
  TRANSPORT_WEBSOCKET,
  inboundAppServerInitialized,
  inboundConnectionChanged,
  inboundElectronWindowFocusChanged,
  inboundFatalError,
  inboundFetchResponseError,
  inboundFetchResponseSuccess,
  inboundGlobalStateUpdated,
  inboundMcpEventNotification,
  inboundMcpNotification,
  inboundMcpRequest,
  inboundMcpResponse,
  inboundOnboardingSkipWorkspaceResult,
  inboundPersistedAtomSync,
  inboundPersistedAtomUpdated,
  inboundPersonalWorkspaceAccessBlocked,
  inboundRequestDelivery,
  inboundRequestUserInputAutoResolutionSnapshot,
  inboundSharedObjectUpdated,
  inboundWorkspaceRootOptionAddCanceled,
  inboundWorkspaceRootOptionAdded,
  inboundWorkspaceRootOptionPicked,
  inboundWorkspaceRootOptionsUpdated,
  isBufferedInboundType,
  isChunkedEnvelope,
  isDeliverable,
  outcomeUnknownUpdate,
} from '../../web/host-protocol.mjs';
// The whole namespace as well, for the two tests that assert about what the
// module does NOT export.
import * as protocol from '../../web/host-protocol.mjs';

// ---- the strings themselves ------------------------------------------------

test('the wire spellings are what the bundle says they are', () => {
  assert.equal(HOST_ID_LOCAL, 'local');
  assert.equal(CHUNK_MARKER, 'codex-host-chunked-message-v1');
  assert.equal(OUTBOUND_EVENT, 'codex-message-from-view');
  assert.equal(CONNECT_APP_HOST, 'connect-app-host');
  assert.equal(CONNECTION_STATE_CONNECTED, 'connected');
  assert.equal(TRANSPORT_WEBSOCKET, 'websocket');

  assert.deepEqual({ ...INBOUND }, {
    mcpResponse: 'mcp-response',
    mcpNotification: 'mcp-notification',
    mcpRequest: 'mcp-request',
    mcpRequestDelivery: 'mcp-request-delivery',
    appServerInitialized: 'codex-app-server-initialized',
    connectionChanged: 'codex-app-server-connection-changed',
    fatalError: 'codex-app-server-fatal-error',
    personalWorkspaceAccessBlocked: 'personal-workspace-access-blocked',
    requestUserInputAutoResolutionSnapshot: 'request-user-input-auto-resolution-snapshot',
    mcpEventNotification: 'mcp-event-notification',
    fetchResponse: 'fetch-response',
    persistedAtomSync: 'persisted-atom-sync',
    persistedAtomUpdated: 'persisted-atom-updated',
    sharedObjectUpdated: 'shared-object-updated',
    workspaceRootOptionPicked: 'workspace-root-option-picked',
    workspaceRootOptionAddCanceled: 'workspace-root-option-add-canceled',
    workspaceRootOptionAdded: 'workspace-root-option-added',
    onboardingSkipWorkspaceResult: 'electron-onboarding-skip-workspace-result',
    workspaceRootOptionsUpdated: 'workspace-root-options-updated',
    globalStateUpdated: 'global-state-updated',
    electronWindowFocusChanged: 'electron-window-focus-changed',
    toggleSidebar: 'toggle-sidebar',
    focusComposer: 'focus-composer',
    commandMenu: 'command-menu',
    navigateToRoute: 'navigate-to-route',
    stepFontSize: 'step-font-size',
    stepWindowZoom: 'step-window-zoom',
    resetWindowZoom: 'reset-window-zoom',
    runCommand: 'run-command',
  });

  assert.deepEqual({ ...OUTBOUND }, {
    mcpRequest: 'mcp-request',
    mcpRequestAbandon: 'mcp-request-abandon',
    mcpResponse: 'mcp-response',
    appServerRestart: 'codex-app-server-restart',
    logMessage: 'log-message',
    threadPrewarmStart: 'thread-prewarm-start',
    ready: 'ready',
    fetch: 'fetch',
    cancelFetch: 'cancel-fetch',
    persistedAtomSyncRequest: 'persisted-atom-sync-request',
    persistedAtomUpdate: 'persisted-atom-update',
    pickWorkspaceRootOption: 'electron-pick-workspace-root-option',
    addNewWorkspaceRootOption: 'electron-add-new-workspace-root-option',
    onboardingSkipWorkspace: 'electron-onboarding-skip-workspace',
    sharedObjectSubscribe: 'shared-object-subscribe',
    sharedObjectUnsubscribe: 'shared-object-unsubscribe',
    sharedObjectSet: 'shared-object-set',
    appShellShortcutStateChanged: 'app-shell-shortcut-state-changed',
    checkoutWebviewPresentationChanged: 'checkout-webview-presentation-changed',
    avatarOverlayRestoreReady: 'electron-avatar-overlay-restore-ready',

    // The one that blocks. See ELECTRON_ONLY_PUSHES for why it is not in it.
    electronWindowFocusRequest: 'electron-window-focus-request',

    // The twenty-five a real drive sends that owe nothing back. Spelled out
    // here rather than spread from the table, so that a typo in the table is a
    // failure rather than a tautology.
    viewFocused: 'view-focused',
    setTelemetryUser: 'set-telemetry-user',
    trayMenuThreadsChanged: 'tray-menu-threads-changed',
    electronSetBadgeCount: 'electron-set-badge-count',
    macMenuBarEnabledChanged: 'mac-menu-bar-enabled-changed',
    powerSaveBlockerSet: 'power-save-blocker-set',
    localThreadActivityChanged: 'local-thread-activity-changed',
    heartbeatAutomationThreadStateChanged: 'heartbeat-automation-thread-state-changed',
    codexRuntimesConfigChanged: 'codex-runtimes-config-changed',
    keyboardLayoutMapChanged: 'keyboard-layout-map-changed',
    electronWindowZoomChanged: 'electron-window-zoom-changed',
    electronSetWindowMode: 'electron-set-window-mode',
    electronAppStateSnapshotTrigger: 'electron-app-state-snapshot-trigger',
    electronDesktopFeaturesChanged: 'electron-desktop-features-changed',
    electronSparkleGatesChanged: 'electron-sparkle-gates-changed',
    electronAvatarOverlayFeedbackDiagnosticsChanged:
      'electron-avatar-overlay-feedback-diagnostics-changed',
    avatarOverlayOpenStateRequest: 'avatar-overlay-open-state-request',
    browserSidebarOwnerSync: 'browser-sidebar-owner-sync',
    browserSidebarTweaksEnabledChanged: 'browser-sidebar-tweaks-enabled-changed',
    browserSidebarSiteAnnotationApiEnabledChanged:
      'browser-sidebar-site-annotation-api-enabled-changed',
    browserSidebarAnnotationMultiSelectEnabledChanged:
      'browser-sidebar-annotation-multi-select-enabled-changed',
    browserUseSessionRouteCapture: 'browser-use-session-route-capture',
    globalDictationEnabledChanged: 'global-dictation-enabled-changed',
    workspaceSettingsWebviewPresentationChanged:
      'workspace-settings-webview-presentation-changed',
  });

  assert.equal(FETCH_RESPONSE_SUCCESS, 'success');
  assert.equal(FETCH_RESPONSE_ERROR, 'error');
});

test('the auto-resolution snapshot survives the renderer arm that reads it', () => {
  // The renderer's arm is an unguarded `for (let {conversationId, requestId,
  // resolutionState} of e.pendingRequests)`. That makes the empty array the
  // load-bearing default rather than a convenience: a builder that omitted the
  // field would throw inside the message dispatcher, which is the one place a
  // throw takes the whole inbound stream with it.
  const message = inboundRequestUserInputAutoResolutionSnapshot();
  assert.deepEqual(message, {
    type: 'request-user-input-auto-resolution-snapshot',
    hostId: 'local',
    pendingRequests: [],
  });
  assert.doesNotThrow(() => {
    for (const _entry of message.pendingRequests) void _entry;
  });
  assert.deepEqual(structuredClone(message), message);
});

test('isSnapshot is carried on a connection change and absent when not asked for', () => {
  // Absent rather than `false`: the renderer reads it as `e.isSnapshot || ...`,
  // so the two are equivalent to it -- but an emitted `isSnapshot:false` is a
  // field main never sends, and this module's job is to be indistinguishable
  // from main on the wire.
  assert.deepEqual(inboundConnectionChanged({ state: 'connected' }), {
    type: 'codex-app-server-connection-changed',
    hostId: 'local',
    state: 'connected',
  });
  assert.deepEqual(inboundConnectionChanged({ state: 'connected', isSnapshot: true }), {
    type: 'codex-app-server-connection-changed',
    hostId: 'local',
    state: 'connected',
    isSnapshot: true,
  });
});

test('the two request-carrying outbound types are named, and only those two', () => {
  // `thread-prewarm-start` is the one that is easy to miss: its name describes
  // a feature, so a reader looking for transports does not see it. Main proves
  // they are the same kind of thing -- both arms destructure `t.request` and
  // both answer through `sendAppServerResponseToView`.
  assert.equal(OUTBOUND.mcpRequest, 'mcp-request');
  assert.equal(OUTBOUND.threadPrewarmStart, 'thread-prewarm-start');
  // `mcp-response` carries a response, and `mcp-request-abandon` carries only
  // an id; neither is a request the host has to forward.
  const carriesARequest = ['mcp-request', 'thread-prewarm-start'];
  const outbound = Object.values(OUTBOUND);
  for (const type of carriesARequest) {
    assert.ok(outbound.includes(type), `${type} must be in OUTBOUND to be captured`);
  }
});

test('the type tables are frozen', () => {
  assert.throws(() => { INBOUND.mcpResponse = 'nope'; }, TypeError);
  assert.throws(() => { OUTBOUND.mcpRequest = 'nope'; }, TypeError);
  assert.throws(() => { BUFFERED_INBOUND_TYPES.push('mcp-notification'); }, TypeError);
});

// ---- the buffered three ----------------------------------------------------

test('exactly three inbound types are buffered by the renderer', () => {
  assert.deepEqual([...BUFFERED_INBOUND_TYPES].sort(), [
    'mcp-request-delivery',
    'mcp-response',
    'personal-workspace-access-blocked',
  ]);
});

test('types that are NOT buffered are reported as not buffered', () => {
  // These are the ones it is tempting to send early. They would be dropped.
  for (const type of [
    'mcp-notification',
    'mcp-request',
    'codex-app-server-initialized',
    'codex-app-server-connection-changed',
    'codex-app-server-fatal-error',
    'log-message',
    '',
    // Every type added for the data layer is in this category too, and three of
    // them are replies to something the renderer is already waiting on, which
    // makes answering early the obvious mistake to make.
    'fetch-response',
    'persisted-atom-sync',
    'persisted-atom-updated',
    'shared-object-updated',
    'workspace-root-option-picked',
    'workspace-root-option-add-canceled',
    'workspace-root-option-added',
    'electron-onboarding-skip-workspace-result',
    'workspace-root-options-updated',
    'global-state-updated',
    'mcp-event-notification',
  ]) {
    assert.equal(isBufferedInboundType(type), false, `${type} must not be reported as buffered`);
  }
});

// ---- the guards ------------------------------------------------------------

test('isChunkedEnvelope refuses everything that is not a chunk envelope', () => {
  for (const value of [null, undefined, 0, 1, '', 'marker', true, false, Symbol('m')]) {
    assert.equal(isChunkedEnvelope(value), false);
  }
  assert.equal(isChunkedEnvelope({}), false);
  assert.equal(isChunkedEnvelope({ marker: undefined }), false);
  assert.equal(isChunkedEnvelope({ marker: 'codex-host-chunked-message-v2' }), false);
  assert.equal(isChunkedEnvelope({ marker: 'codex-host-chunked-message-v1' }), true);
});

test('isChunkedEnvelope does not throw on null', () => {
  // `typeof null === 'object'` and `'marker' in null` throws, so the null check
  // has to sit between the two. This pins the order.
  assert.doesNotThrow(() => isChunkedEnvelope(null));
});

test('isDeliverable refuses anything the renderer guard would drop', () => {
  for (const value of [null, undefined, 'mcp-response', 42, true, []]) {
    assert.equal(isDeliverable(value), false);
  }
  assert.equal(isDeliverable({}), false, 'no type at all');
  assert.equal(isDeliverable({ type: 42 }), false, 'a numeric type is not a type');
  assert.equal(isDeliverable({ type: null }), false);
  assert.equal(isDeliverable({ type: '' }), true, 'empty string is still a string to the guard');
  assert.equal(isDeliverable({ type: 'anything-at-all' }), true, 'unknown still reaches the switch');
});

// ---- THE TRAP: the two directions of mcp-response --------------------------

test('an inbound mcp-response carries `message` and never `response`', () => {
  const built = inboundMcpResponse({ id: 7, result: { ok: true } });

  assert.equal(built.type, 'mcp-response');
  assert.equal(built.hostId, 'local');
  assert.deepEqual(built.message, { id: 7, result: { ok: true } });

  // The outbound word must not appear anywhere on an inbound message. If this
  // ever fails, nothing throws in production -- requests just stop resolving.
  assert.equal('response' in built, false, 'inbound uses `message`; `response` is the outbound word');
  assert.equal(built.response, undefined);
});

test('the inbound builder will not accept a pre-built payload under either name', () => {
  // Neither spelling smuggles a payload past the result/error check, which is
  // the whole point of the builder taking id+result rather than an object.
  assert.throws(
    () => inboundMcpResponse({ message: { id: 1, result: 'x' } }),
    /result or an error/,
  );
  assert.throws(
    () => inboundMcpResponse({ response: { id: 1, result: 'x' } }),
    /result or an error/,
  );
});

test('an mcp-response with neither result nor error is refused', () => {
  assert.throws(() => inboundMcpResponse({ id: 1 }), /result or an error/);
  assert.throws(() => inboundMcpResponse({}), /result or an error/);
  assert.throws(
    () => inboundMcpResponse({ id: 1, result: undefined, error: undefined }),
    /result or an error/,
  );
});

test('an mcp-response carrying BOTH result and error is refused', () => {
  assert.throws(
    () => inboundMcpResponse({ id: 1, result: 'x', error: { code: -1, message: 'y' } }),
    /never both/,
  );
});

test('a null result is a real result and survives', () => {
  const built = inboundMcpResponse({ id: 3, result: null });
  assert.deepEqual(built.message, { id: 3, result: null });
  assert.equal('error' in built.message, false);
});

test('an error response has no result key at all', () => {
  const built = inboundMcpResponse({ id: 4, error: { code: -32601, message: 'no such method' } });
  assert.deepEqual(built.message, { id: 4, error: { code: -32601, message: 'no such method' } });
  assert.equal('result' in built.message, false);
});

test('mcp-response ids are echoed verbatim, in whichever space they came from', () => {
  // Integer ids belong to the renderer's own table; nothing may stringify them.
  const integer = inboundMcpResponse({ id: 12, result: 1 });
  assert.equal(integer.message.id, 12);
  assert.equal(typeof integer.message.id, 'number');

  const uuid = inboundMcpResponse({ id: '0de0ea84-0000-4000-8000-000000000000', result: 1 });
  assert.equal(typeof uuid.message.id, 'string');
});

test('optional mcp-response fields are omitted rather than set to undefined', () => {
  const bare = inboundMcpResponse({ id: 1, result: 1 });
  assert.deepEqual(Object.keys(bare).sort(), ['hostId', 'message', 'type']);

  const full = inboundMcpResponse({
    id: 1,
    result: 1,
    requestMethod: 'thread/start',
    receivedAtMs: 5,
    trace: { a: 1 },
    hostMetrics: { b: 2 },
  });
  assert.deepEqual(Object.keys(full).sort(), [
    'hostId', 'hostMetrics', 'message', 'receivedAtMs', 'requestMethod', 'trace', 'type',
  ]);
});

// ---- the other builders ----------------------------------------------------

test('every builder defaults hostId to local and lets it be overridden', () => {
  const built = [
    inboundMcpResponse({ id: 1, result: 1 }),
    inboundMcpNotification({ method: 'item/started' }),
    inboundMcpRequest({ request: { id: 'u', method: 'm' } }),
    inboundRequestDelivery({ update: {} }),
    inboundAppServerInitialized({ appServerVersion: '1', installedCodexVersion: '2' }),
    inboundConnectionChanged({ state: 'connected' }),
    inboundFatalError({ errorMessage: 'gone' }),
    inboundPersonalWorkspaceAccessBlocked({}),
  ];
  for (const message of built) {
    assert.equal(message.hostId, 'local', `${message.type} must default to the local hostId`);
    assert.equal(isDeliverable(message), true, `${message.type} must clear the renderer guard`);
  }

  assert.equal(inboundConnectionChanged({ hostId: 'other', state: 'x' }).hostId, 'other');
});

test('a notification keeps method and params where the renderer looks for them', () => {
  const built = inboundMcpNotification({
    method: 'item/agentMessage/delta',
    params: { itemId: 'it_1', delta: 'he' },
  });
  assert.equal(built.type, 'mcp-notification');
  assert.equal(built.method, 'item/agentMessage/delta');
  assert.deepEqual(built.params, { itemId: 'it_1', delta: 'he' });
});

test('extra fields cannot shadow type, hostId or method', () => {
  // The renderer's own transport writes `type` last for exactly this reason.
  const built = inboundMcpNotification({
    method: 'turn/started',
    extra: { type: 'hijacked', hostId: 'elsewhere', method: 'also-hijacked', seq: 9 },
  });
  assert.equal(built.type, 'mcp-notification');
  assert.equal(built.hostId, 'local');
  assert.equal(built.method, 'turn/started');
  assert.equal(built.seq, 9, 'an extra field that is not reserved still gets through');

  const blocked = inboundPersonalWorkspaceAccessBlocked({
    extra: { type: 'hijacked', hostId: 'elsewhere', reason: 'r' },
  });
  assert.equal(blocked.type, 'personal-workspace-access-blocked');
  assert.equal(blocked.hostId, 'local');
  assert.equal(blocked.reason, 'r');
});

test('a server-initiated request is passed through without renumbering', () => {
  const request = { id: '5e1f2a10-0000-4000-8000-000000000000', method: 'item/tool/approve', params: {} };
  const built = inboundMcpRequest({ request });
  assert.equal(built.type, 'mcp-request');
  assert.equal(built.request, request, 'the request object is handed over as-is');
  assert.equal(built.request.id, '5e1f2a10-0000-4000-8000-000000000000');
});

test('the initialized message omits transport unless one is given', () => {
  const bare = inboundAppServerInitialized({ appServerVersion: '1.2.3', installedCodexVersion: '4.5.6' });
  assert.equal('transport' in bare, false, 'absent takes the non-websocket branch');
  assert.equal('isSnapshot' in bare, false);

  const ws = inboundAppServerInitialized({
    appServerVersion: '1.2.3',
    installedCodexVersion: '4.5.6',
    isSnapshot: true,
    transport: 'websocket',
  });
  assert.equal(ws.transport, 'websocket');
  assert.equal(ws.isSnapshot, true);
});

test('the outcome-unknown update has the stage the renderer writes', () => {
  assert.deepEqual(outcomeUnknownUpdate({ requestId: 11, method: 'thread/start' }), {
    type: 'outcome-unknown',
    delivery: { requestId: 11, method: 'thread/start', stage: 'outcome-unknown' },
  });
});

test('builders survive a structured clone, which is the real wire', () => {
  // Anything a builder emits has to cross an IPC boundary in Electron. A key
  // holding `undefined` or a function would not survive it.
  const messages = [
    inboundMcpResponse({ id: 1, result: { a: [1, 2] } }),
    inboundMcpNotification({ method: 'm', params: { b: null } }),
    inboundRequestDelivery({ update: outcomeUnknownUpdate({ requestId: 2, method: 'm' }) }),
  ];
  for (const message of messages) {
    assert.deepEqual(structuredClone(message), message);
  }
});

// ---- required fields -------------------------------------------------------
//
// Every builder below used to emit a missing required field as an explicit
// `undefined` and let the renderer sort it out, which it does not: the host
// switch has 188 cases and no default branch, so the message is dropped in
// silence. `inboundMcpResponse` refused on that basis from the start; these
// tests hold the other seven to the same standard.

/** @type {Array<[string, Function, object, string[]]>} */
const REQUIRES = [
  ['inboundMcpResponse', inboundMcpResponse, { id: 1, result: 'x' }, ['id']],
  ['inboundMcpNotification', inboundMcpNotification, { method: 'item/completed' }, ['method']],
  ['inboundMcpRequest', inboundMcpRequest, { request: { id: 'u-1', method: 'approve' } }, ['request']],
  ['inboundRequestDelivery', inboundRequestDelivery, { update: { stage: 'sent' } }, ['update']],
  ['outcomeUnknownUpdate', outcomeUnknownUpdate, { requestId: 7, method: 'turn/start' }, ['requestId', 'method']],
  [
    'inboundAppServerInitialized',
    inboundAppServerInitialized,
    { appServerVersion: '1.2.3', installedCodexVersion: '4.5.6' },
    ['appServerVersion', 'installedCodexVersion'],
  ],
  ['inboundConnectionChanged', inboundConnectionChanged, { state: CONNECTION_STATE_CONNECTED }, ['state']],
  ['inboundFatalError', inboundFatalError, { errorMessage: 'the app server is gone' }, ['errorMessage']],
  [
    'inboundFetchResponseSuccess',
    inboundFetchResponseSuccess,
    { requestId: 'r-1', body: { value: null } },
    ['requestId', 'body'],
  ],
  [
    'inboundFetchResponseError',
    inboundFetchResponseError,
    { requestId: 'r-2', error: 'the relay refuses this endpoint' },
    ['requestId', 'error'],
  ],
  ['inboundPersistedAtomSync', inboundPersistedAtomSync, { state: {} }, ['state']],
  ['inboundPersistedAtomUpdated', inboundPersistedAtomUpdated, { key: 'composer-prompt-drafts-v2' }, ['key']],
  ['inboundWorkspaceRootOptionPicked', inboundWorkspaceRootOptionPicked, { root: '/home/u/work' }, ['root']],
  ['inboundWorkspaceRootOptionAdded', inboundWorkspaceRootOptionAdded, { projectId: 'p-1' }, ['projectId']],
  [
    'inboundOnboardingSkipWorkspaceResult',
    inboundOnboardingSkipWorkspaceResult,
    { success: true },
    ['success'],
  ],
  ['inboundSharedObjectUpdated', inboundSharedObjectUpdated, { key: 'k', value: 1 }, ['key', 'value']],
  [
    'inboundMcpEventNotification',
    inboundMcpEventNotification,
    { notification: { method: 'tools/updated' }, subscriptionId: 's-1' },
    ['notification', 'subscriptionId'],
  ],
];

test('a builder with its required fields supplied is happy', () => {
  for (const [name, build, valid] of REQUIRES) {
    assert.doesNotThrow(() => build({ ...valid }), `${name} should accept its own minimal arguments`);
  }
});

test('every required field is refused by name when it is absent', () => {
  for (const [name, build, valid, keys] of REQUIRES) {
    for (const key of keys) {
      const args = { ...valid };
      delete args[key];
      assert.throws(
        () => build(args),
        (err) => {
          assert.ok(err instanceof TypeError, `${name} should refuse a missing ${key} with a TypeError`);
          assert.match(err.message, new RegExp(name), 'the message must say which builder to go look at');
          assert.match(err.message, new RegExp(key), 'and which field');
          return true;
        },
        `${name} emitted a message with ${key} missing instead of refusing`,
      );
    }
  }
});

test('an explicit undefined is refused exactly like an absent key', () => {
  // Because that is what a caller assembling arguments from optional locals
  // actually produces, and it is the case `in` would have let through.
  for (const [name, build, valid, keys] of REQUIRES) {
    for (const key of keys) {
      assert.throws(() => build({ ...valid, [key]: undefined }), new RegExp(`${name} needs ${key}`));
    }
  }
});

test('null passes, because absent and empty are different questions', () => {
  // A null result, a null params and a null update are all things the app
  // server really sends. Conflating them with "you forgot an argument" is how a
  // legitimate null turns into a throw at three in the morning.
  //
  // `inboundGlobalStateUpdated` is the one exception and is not in this table:
  // it type-checks `keys` instead, because a null there throws inside the
  // renderer's own handler rather than being stored harmlessly. See its own
  // tests below.
  for (const [name, build, valid, keys] of REQUIRES) {
    for (const key of keys) {
      assert.doesNotThrow(() => build({ ...valid, [key]: null }), `${name} should let a null ${key} through`);
    }
  }
});

test('transport stays optional, and absence is still a decision', () => {
  // Deliberately NOT promoted to required: the renderer branches on
  // `transport !== 'websocket'`, so an absent transport takes the non-websocket
  // branch like any other non-matching value. See the doc comment on the builder.
  const message = inboundAppServerInitialized({ appServerVersion: '1', installedCodexVersion: '2' });
  assert.ok(!('transport' in message), 'an unsupplied optional field should not exist as a key');
  assert.equal(
    inboundAppServerInitialized({ appServerVersion: '1', installedCodexVersion: '2', transport: TRANSPORT_WEBSOCKET })
      .transport,
    TRANSPORT_WEBSOCKET,
  );
});

test('inboundMcpResponse reports the signature mistake before the narrower one', () => {
  // Called with nothing, both refusals are true. The result/error one names the
  // signature this builder exists to enforce, which is what somebody calling it
  // with no arguments got wrong; a missing id with a real result is a different
  // and narrower mistake.
  assert.throws(() => inboundMcpResponse({}), /result or an error/);
  assert.throws(() => inboundMcpResponse({ result: 'x' }), /inboundMcpResponse needs id/);
  assert.throws(() => inboundMcpResponse({ error: { code: -1, message: 'y' } }), /inboundMcpResponse needs id/);
  // id 0 is a real renderer id and must not read as absent.
  assert.doesNotThrow(() => inboundMcpResponse({ id: 0, result: 'x' }));
});

test('an explicit undefined key survives a structured clone, which is why the reason is deepEqual', () => {
  // This is here because the comment on `withOptional` used to claim the
  // opposite, and the claim was copied into another module's header before
  // anyone checked it. Pinning the fact stops the wrong reason coming back.
  const cloned = structuredClone({ trace: undefined, hostId: 'local' });
  assert.ok('trace' in cloned, 'undefined is structured-cloneable; that was never the reason');
  assert.equal(cloned.trace, undefined);
  // The reasons that are real:
  assert.throws(() => assert.deepStrictEqual({ trace: undefined }, {}), /Expected values to be strictly deep-equal/);
  assert.notEqual('trace' in { trace: undefined }, 'trace' in {});
});

// ---- the data layer and the state pushes -----------------------------------
//
// These builders are tested on their complete emitted shape rather than field
// by field, which is a departure from the rest of this file. The reason is the
// one the module header gives: each is the reply to something that either
// blocks the renderer outright -- `fetch` has no timeout at all -- or silently
// degrades a visible surface, and the renderer validates none of them. There is
// no error path to assert against, so the shape itself is the whole contract.

test('a successful fetch-response is the exact shape onFetchResponse decodes', () => {
  assert.deepEqual(
    inboundFetchResponseSuccess({ requestId: 'r-1', body: { codexHome: '/home/u/.codex' } }),
    {
      type: 'fetch-response',
      requestId: 'r-1',
      responseType: 'success',
      status: 200,
      headers: {},
      body: { codexHome: '/home/u/.codex' },
    },
  );
});

test('the body key is always present, because the renderer tests `in` and not truthiness', () => {
  // `'body' in e ? e.body : JSON.parse(e.bodyJsonString)`. A null body resolves;
  // an absent one parses undefined, throws inside the renderer's try, and
  // rejects. So the key has to exist even when there is nothing in it.
  const empty = inboundFetchResponseSuccess({ requestId: 'r-1', body: null });
  assert.ok('body' in empty, 'a null body must still be a present key');
  assert.equal(empty.body, null);
  assert.equal('bodyJsonString' in empty, false, 'we hold the decoded object; re-encoding it can only throw');
});

test('a non-2xx status is a legal success envelope, not a builder error', () => {
  // The renderer decides 2xx itself on this branch: in range it resolves, out
  // of range it rejects with the body stringified. Both settle the promise,
  // which is the only property that matters.
  const notFound = inboundFetchResponseSuccess({
    requestId: 'r-9',
    status: 404,
    headers: { 'content-type': 'application/json' },
    body: { error: 'no such endpoint' },
  });
  assert.deepEqual(notFound, {
    type: 'fetch-response',
    requestId: 'r-9',
    responseType: 'success',
    status: 404,
    headers: { 'content-type': 'application/json' },
    body: { error: 'no such endpoint' },
  });
});

test('a failed fetch-response carries every field the error constructor reads', () => {
  assert.deepEqual(
    inboundFetchResponseError({
      requestId: 'r-2',
      error: 'the relay refuses this endpoint',
      status: 501,
      errorCode: 'not_implemented',
      responseStatus: 501,
    }),
    {
      type: 'fetch-response',
      requestId: 'r-2',
      responseType: 'error',
      error: 'the relay refuses this endpoint',
      status: 501,
      errorCode: 'not_implemented',
      responseStatus: 501,
    },
  );
});

test('a failed fetch-response omits the three fields it was not given', () => {
  // They are passed positionally into the renderer's error constructor, where
  // undefined is legal, so a refusal that knows only its reason is still a
  // refusal the UI can show.
  const minimal = inboundFetchResponseError({ requestId: 'r-3', error: 'offline' });
  assert.deepEqual(Object.keys(minimal).sort(), ['error', 'requestId', 'responseType', 'type']);
});

test('persisted-atom-sync defaults to the one-window answer', () => {
  assert.deepEqual(inboundPersistedAtomSync({ state: {} }), {
    type: 'persisted-atom-sync',
    state: {},
    canWritePrimaryWindowTabPersistence: true,
  });
  // An empty state is a complete answer and takes 5 s off first paint. A real
  // one is passed through untouched.
  assert.deepEqual(
    inboundPersistedAtomSync({
      state: { 'composer-prompt-drafts-v2': { a: 1 } },
      canWritePrimaryWindowTabPersistence: false,
    }),
    {
      type: 'persisted-atom-sync',
      state: { 'composer-prompt-drafts-v2': { a: 1 } },
      canWritePrimaryWindowTabPersistence: false,
    },
  );
});

test('a persisted-atom-updated push names a key and nothing it was not given', () => {
  assert.deepEqual(inboundPersistedAtomUpdated({ key: 'starter-prompt-dismissals-v1' }), {
    type: 'persisted-atom-updated',
    key: 'starter-prompt-dismissals-v1',
  });
  assert.deepEqual(
    inboundPersistedAtomUpdated({
      key: 'starter-prompt-dismissals-v1',
      value: null,
      deleted: true,
      savedCustomSectionOperationId: 'op-1',
    }),
    {
      type: 'persisted-atom-updated',
      key: 'starter-prompt-dismissals-v1',
      value: null,
      deleted: true,
      savedCustomSectionOperationId: 'op-1',
    },
  );
});

test('the three workspace-picker replies are the shapes that clear its pending state', () => {
  assert.deepEqual(inboundWorkspaceRootOptionPicked({ root: '/home/u/work/repo' }), {
    type: 'workspace-root-option-picked',
    root: '/home/u/work/repo',
  });
  assert.deepEqual(inboundWorkspaceRootOptionAddCanceled(), {
    type: 'workspace-root-option-add-canceled',
  });
  assert.deepEqual(inboundWorkspaceRootOptionAdded({ projectId: 'proj_01' }), {
    type: 'workspace-root-option-added',
    projectId: 'proj_01',
  });
});

test('workspace-root-option-added spells only projectId, because the renderer reads ?? first', () => {
  // The switch is `e.selectedProjectId ?? e.projectId`, so projectId alone is
  // correct and complete. Offering both spellings would be offering a
  // precedence rule the call site cannot see.
  const built = inboundWorkspaceRootOptionAdded({ projectId: 'proj_01' });
  assert.equal('selectedProjectId' in built, false);
  assert.equal(built.selectedProjectId ?? built.projectId, 'proj_01', 'the renderer resolves it to our id');
});

test('the two invalidation pings carry nothing but their type', () => {
  assert.deepEqual(inboundWorkspaceRootOptionsUpdated(), { type: 'workspace-root-options-updated' });
  assert.deepEqual(inboundGlobalStateUpdated({ keys: ['localProjects'] }), {
    type: 'global-state-updated',
    keys: ['localProjects'],
  });
});

test('global-state-updated refuses anything that is not an array of keys', () => {
  // The handler does `e.keys.includes(...)` and then iterates `e.keys`. A null
  // throws inside the renderer. A bare string is worse: it has `.includes` and
  // it iterates, so it invalidates one query key per character and the key the
  // host meant is never refetched, with nothing logged anywhere.
  for (const keys of [null, 'localProjects', 42, { 0: 'localProjects' }, new Set(['localProjects'])]) {
    assert.throws(
      () => inboundGlobalStateUpdated({ keys }),
      (err) => {
        assert.ok(err instanceof TypeError);
        assert.match(err.message, /inboundGlobalStateUpdated needs keys to be an array/);
        return true;
      },
      `keys=${String(keys)} should be refused`,
    );
  }
  // Absent is refused by the usual path, naming the field.
  assert.throws(() => inboundGlobalStateUpdated({}), /inboundGlobalStateUpdated needs keys/);
  // An empty array is not malformed -- it invalidates nothing, which is a thing
  // a caller may legitimately end up with.
  assert.deepEqual(inboundGlobalStateUpdated({ keys: [] }), { type: 'global-state-updated', keys: [] });
});

test('a shared-object update carries the key its subscribers filter on', () => {
  assert.deepEqual(inboundSharedObjectUpdated({ key: 'window-state', value: { zoom: 0.8 } }), {
    type: 'shared-object-updated',
    key: 'window-state',
    value: { zoom: 0.8 },
  });
  // Null is a value a shared object can hold, so it is not treated as absent.
  assert.deepEqual(inboundSharedObjectUpdated({ key: 'window-state', value: null }), {
    type: 'shared-object-updated',
    key: 'window-state',
    value: null,
  });
});

test('the onboarding skip result distinguishes success from a failure with a reason', () => {
  assert.deepEqual(inboundOnboardingSkipWorkspaceResult({ success: true }), {
    type: 'electron-onboarding-skip-workspace-result',
    success: true,
  });
  assert.deepEqual(
    inboundOnboardingSkipWorkspaceResult({ success: false, error: 'could not initialise a git repository' }),
    {
      type: 'electron-onboarding-skip-workspace-result',
      success: false,
      error: 'could not initialise a git repository',
    },
  );
  // The handler reads `e.error ?? null` only on the failure arm, so a success
  // must not carry one.
  assert.equal('error' in inboundOnboardingSkipWorkspaceResult({ success: true }), false);
});

test('mcp-event-notification is the one new builder that is keyed by hostId', () => {
  const notification = { method: 'notifications/tools/list_changed', params: {} };
  assert.deepEqual(inboundMcpEventNotification({ notification, subscriptionId: 'sub-1' }), {
    type: 'mcp-event-notification',
    hostId: 'local',
    notification,
    subscriptionId: 'sub-1',
  });
  assert.equal(
    inboundMcpEventNotification({ hostId: 'durable', notification, subscriptionId: 'sub-1' }).hostId,
    'durable',
  );
});

test('the data-layer builders carry no hostId, because nothing reads one off them', () => {
  // A hostId identifies an app-server client in the renderer's registry and
  // none of these go near it: the fetch tunnel matches on requestId against one
  // pending table, and the persisted-atom and shared-object subscribers key on
  // their own fields. An invented hostId would be a field that looks load
  // bearing and is not.
  const built = [
    inboundFetchResponseSuccess({ requestId: 'r', body: {} }),
    inboundFetchResponseError({ requestId: 'r', error: 'x' }),
    inboundPersistedAtomSync({ state: {} }),
    inboundPersistedAtomUpdated({ key: 'k' }),
    inboundWorkspaceRootOptionPicked({ root: '/r' }),
    inboundWorkspaceRootOptionAddCanceled(),
    inboundWorkspaceRootOptionAdded({ projectId: 'p' }),
    inboundWorkspaceRootOptionsUpdated(),
    inboundOnboardingSkipWorkspaceResult({ success: true }),
    inboundGlobalStateUpdated({ keys: ['k'] }),
    inboundSharedObjectUpdated({ key: 'k', value: 1 }),
  ];
  for (const message of built) {
    assert.equal('hostId' in message, false, `${message.type} should not invent a hostId`);
  }
});

test('every new builder emits a type that is in the INBOUND table', () => {
  // The table is the only place these strings are written down; a builder that
  // emitted a literal of its own would be the exact drift the header warns
  // about, and the renderer would answer it with silence.
  const inboundTypes = new Set(Object.values(INBOUND));
  const built = [
    inboundFetchResponseSuccess({ requestId: 'r', body: {} }),
    inboundFetchResponseError({ requestId: 'r', error: 'x' }),
    inboundPersistedAtomSync({ state: {} }),
    inboundPersistedAtomUpdated({ key: 'k' }),
    inboundWorkspaceRootOptionPicked({ root: '/r' }),
    inboundWorkspaceRootOptionAddCanceled(),
    inboundWorkspaceRootOptionAdded({ projectId: 'p' }),
    inboundWorkspaceRootOptionsUpdated(),
    inboundOnboardingSkipWorkspaceResult({ success: true }),
    inboundGlobalStateUpdated({ keys: ['k'] }),
    inboundSharedObjectUpdated({ key: 'k', value: 1 }),
    inboundElectronWindowFocusChanged({ isFocused: true }),
    inboundElectronWindowFocusChanged({ isFocused: false, occurredAtMs: 1 }),
    inboundMcpEventNotification({ notification: {}, subscriptionId: 's' }),
  ];
  for (const message of built) {
    assert.ok(inboundTypes.has(message.type), `${message.type} is not in the INBOUND table`);
    assert.equal(isDeliverable(message), true, `${message.type} must clear the renderer guard`);
    assert.deepEqual(structuredClone(message), message, `${message.type} must survive the wire`);
  }
});

// ---- the focus reply --------------------------------------------------------

test('the focused reply is exactly the two fields main sends, and no more', () => {
  // Main's arm, verbatim: a focused reply is `{type, isFocused:true}` and a
  // blurred one adds `occurredAtMs`. The renderer reads `occurredAtMs` off the
  // blur to decide how long the window has been away; stamping the focused
  // branch too would be a field nothing sends and something might come to read.
  assert.deepEqual(inboundElectronWindowFocusChanged({ isFocused: true }), {
    type: INBOUND.electronWindowFocusChanged,
    isFocused: true,
  });
  assert.deepEqual(inboundElectronWindowFocusChanged({ isFocused: false, occurredAtMs: 42 }), {
    type: INBOUND.electronWindowFocusChanged,
    isFocused: false,
    occurredAtMs: 42,
  });
  assert.deepEqual(inboundElectronWindowFocusChanged({ isFocused: false }), {
    type: INBOUND.electronWindowFocusChanged,
    isFocused: false,
  });
});

test('isFocused false is a value, not a missing argument', () => {
  // The one shape of bug this builder invites: a `required()` that rejected
  // falsy values would make every blur throw, and a blur that throws inside a
  // window listener is swallowed. The renderer would then never leave focused.
  assert.doesNotThrow(() => inboundElectronWindowFocusChanged({ isFocused: false }));
  assert.throws(() => inboundElectronWindowFocusChanged({}), /isFocused/);
  assert.throws(() => inboundElectronWindowFocusChanged(), /isFocused/);
});

test('a non-boolean isFocused is refused rather than coerced', () => {
  // The atom this feeds starts at `null` and its readers are split: some test
  // `=== true` and some test `!== false`. A string would read as focused in
  // the first set and as not-blurred in the second, which is a state the real
  // app cannot be in and nothing downstream is written to survive.
  for (const bad of ['true', 1, 0, null, {}]) {
    assert.throws(() => inboundElectronWindowFocusChanged({ isFocused: bad }), TypeError);
  }
});

test('the Electron-only table is frozen, complete and disjoint from what is handled', () => {
  assert.equal(Object.isFrozen(ELECTRON_ONLY_PUSHES), true);
  assert.equal(Object.keys(ELECTRON_ONLY_PUSHES).length, 25);

  const outboundValues = new Set(Object.values(OUTBOUND));
  for (const [type, reason] of Object.entries(ELECTRON_ONLY_PUSHES)) {
    assert.ok(outboundValues.has(type), `${type} is not an OUTBOUND type`);
    assert.equal(typeof reason, 'string');
  }

  // The two the sweep found that owe an answer. Their absence here is the
  // whole classification: `electron-window-focus-request` is fire-and-forget
  // and still blocking, which is the distinction a weaker test would miss.
  assert.equal(Object.hasOwn(ELECTRON_ONLY_PUSHES, OUTBOUND.electronWindowFocusRequest), false);
  assert.equal(Object.hasOwn(ELECTRON_ONLY_PUSHES, OUTBOUND.sharedObjectSet), false);
});

// ---- the shapes and counts that are documentation ---------------------------

test('the inbound notification vocabulary is 82, not the 81 the gate table allows', () => {
  // The gate is a strict `=== true` over a 157-entry table: 81 allowed, 76
  // dropped with no logging. `app/list/updated` is handled BEFORE the gate is
  // consulted, which is the entire difference between 81 and 82. The host
  // forwards the whole stream regardless; this number exists so nobody builds a
  // renderer-facing feature on a denied name.
  assert.equal(INBOUND_NOTIFICATION_COUNT, 82);
});

test('the sampled dropped notification methods are the plausible-looking ones', () => {
  assert.deepEqual([...KNOWN_DROPPED_NOTIFICATION_METHODS], [
    'thread/compacted',
    'thread/closed',
    'thread/reverted',
    'warning',
    'command/exec/outputDelta',
    'process/exited',
  ]);
  assert.throws(() => { KNOWN_DROPPED_NOTIFICATION_METHODS.push('thread/started'); }, TypeError);
  // None of them is a host message type, which is the confusion they invite:
  // they are app-server notification METHODS that ride inside mcp-notification.
  const messageTypes = new Set([...Object.values(INBOUND), ...Object.values(OUTBOUND)]);
  for (const method of KNOWN_DROPPED_NOTIFICATION_METHODS) {
    assert.equal(messageTypes.has(method), false, `${method} is a method name, not a message type`);
  }
});

test('the app-server result shapes are pinned on the parts the renderer destructures', () => {
  // The `why` text is prose and is only checked for existence; the shape, the
  // paths read on sight and the must-succeed flag are the load-bearing parts.
  const pinned = Object.fromEntries(
    Object.entries(APP_SERVER_RESULT_SHAPES).map(([method, entry]) => [
      method,
      { shape: entry.shape, read: [...entry.read], mustSucceed: entry.mustSucceed },
    ]),
  );
  assert.deepEqual(pinned, {
    'turn/start': { shape: '{ turn: { id, status } }', read: ['turn.id', 'turn.status'], mustSucceed: false },
    'turn/steer': { shape: '{ turnId }', read: ['turnId'], mustSucceed: false },
    'thread/list': { shape: '{ data: [], nextCursor }', read: ['data', 'nextCursor'], mustSucceed: false },
    'config/read': { shape: '{ config: {...} }', read: ['config'], mustSucceed: true },
  });
  for (const [method, entry] of Object.entries(APP_SERVER_RESULT_SHAPES)) {
    assert.equal(typeof entry.why, 'string', `${method} needs a reason`);
    assert.ok(entry.why.length > 40, `${method}'s reason should say what breaks`);
  }
});

test('config/read is the only result shape marked must-succeed', () => {
  // Two of its four call sites await it and read `.config` with no catch, so a
  // relay that errors it breaks editing a sent message and sending a queued one
  // while a fresh turn still works -- a bug report that reads as random.
  const mustSucceed = Object.entries(APP_SERVER_RESULT_SHAPES)
    .filter(([, entry]) => entry.mustSucceed)
    .map(([method]) => method);
  assert.deepEqual(mustSucceed, ['config/read']);
});

test('the result-shape table is frozen all the way down', () => {
  // A descriptor table somebody can edit at runtime is documentation that lies.
  assert.throws(() => { APP_SERVER_RESULT_SHAPES['turn/start'] = {}; }, TypeError);
  assert.throws(() => { APP_SERVER_RESULT_SHAPES['turn/start'].shape = '{}'; }, TypeError);
  assert.throws(() => { APP_SERVER_RESULT_SHAPES['turn/start'].read.push('turn.model'); }, TypeError);
});

// ---- what this module deliberately does not contain -------------------------

test('the fetch streaming callbacks and the Sentry span are not host message types', () => {
  // `fetch-stream-complete` and `fetch-stream-error` are the argument objects
  // the renderer's streaming helper hands to its own callbacks over a real
  // window.fetch, and `fetch-body-resolved` is a Sentry span name. Adding
  // either here would produce a module that passes its own tests, emits
  // messages nobody subscribes to, and resolves nothing.
  const everything = [...Object.values(INBOUND), ...Object.values(OUTBOUND)];
  for (const type of everything) {
    assert.ok(!type.startsWith('fetch-stream'), `${type} is a renderer-internal callback payload`);
  }
  assert.equal(everything.includes('fetch-body-resolved'), false);
  // The two that ARE host messages, for contrast.
  assert.ok(everything.includes('fetch'));
  assert.ok(everything.includes('fetch-response'));
});

test('nothing here normalises an id, because the renderer normalises nothing either', () => {
  // Its own mapper is `function xj(e){return e}`. A mapper added here would be
  // a scheme the renderer does not share, and `serverRequest/resolved` matches
  // on the raw requestId: a remapped id leaves an undismissable approval card
  // on screen that blocks the composer.
  const offenders = Object.keys(protocol).filter((name) => /normali[sz]e|renumber|remap/i.test(name));
  assert.deepEqual(offenders, []);
});
