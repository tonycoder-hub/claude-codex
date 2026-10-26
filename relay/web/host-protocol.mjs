// The host vocabulary: every message type that crosses the renderer/host
// boundary, and the pure builders that spell them.
//
// None of these strings are ours to choose. They were read out of the shipped
// renderer bundle, whose host-message switch has 188 cases and no `default:`
// branch. That missing default is the thing to hold on to while reading this
// file: a type we spell wrong is not an error, it is silence. The renderer
// drops it and keeps waiting. So each name is written once, here, and imported
// everywhere else -- never retyped at a call site where a hyphen could drift.
//
// THE TRAP, and it is the expensive one: `mcp-response` travels in BOTH
// directions and the payload field is NOT the same in each.
//
//   host -> renderer   { type:'mcp-response', hostId, message:  { id, result }
//                                                   | { id, error } }
//   renderer -> host   { type:'mcp-response', hostId, response, requestMethod?,
//                                                     trace? }
//
// Swap those two words and you get a bus that looks perfectly wired: events
// flow, listeners fire, nothing throws, and not one request ever resolves.
// Which is why `inboundMcpResponse` below refuses to accept a pre-built
// payload object at all. It takes `id` plus `result` or `error` and assembles
// the `message` wrapper itself, so there is no call site at which the wrong
// word can be typed in the first place.
//
// Two id spaces share the `mcp-request` type and must never be mixed. The
// renderer mints its own request ids as INTEGERS and owns the promise table
// and the timeouts for them; the host echoes those back verbatim and never
// invents one. Server-initiated requests travel the other way with UUID STRING
// ids, and the renderer echoes those back verbatim in its outbound
// `mcp-response`. Nothing here coerces an id to a string or a number, on
// purpose: a coercion would quietly move a reply into the wrong table.
//
// Chunking is sender-optional. The renderer will reassemble a chunked envelope
// if it sees one; we never send one, so the marker below exists for
// recognition only. There is no chunker in this repo and there should not be
// one -- a non-chunked object walks straight through the renderer's guard.
//
// Everything in this file is pure. No DOM, no window, no events. The modules
// that touch a window import their words from here.

/**
 * The hostId every message on this bus carries. The renderer keys its client
 * registry by hostId, and `local` is the one it registers for a co-resident
 * app server.
 *
 * Worth knowing before you emit anything: if an inbound `mcp-response` arrives
 * for `local` and no client has registered for `local` yet, the renderer does
 * not drop it -- it THROWS. Nothing may be emitted for this hostId until the
 * renderer has registered.
 */
export const HOST_ID_LOCAL = 'local';

/** Recognised, never produced. See the header on chunking. */
export const CHUNK_MARKER = 'codex-host-chunked-message-v1';

/**
 * The window event the renderer's transport dispatches on every single send.
 * It fires whether or not `electronBridge.sendMessageFromView` exists, which
 * is what makes it, and not the bridge member, the one correct capture point.
 */
export const OUTBOUND_EVENT = 'codex-message-from-view';

/** The window message the renderer posts to itself to open the capnweb port. */
export const CONNECT_APP_HOST = 'connect-app-host';

/**
 * Host -> renderer. The types we are allowed to send inward.
 */
export const INBOUND = Object.freeze({
  mcpResponse: 'mcp-response',
  mcpNotification: 'mcp-notification',
  mcpRequest: 'mcp-request',
  mcpRequestDelivery: 'mcp-request-delivery',
  appServerInitialized: 'codex-app-server-initialized',
  connectionChanged: 'codex-app-server-connection-changed',
  fatalError: 'codex-app-server-fatal-error',
  personalWorkspaceAccessBlocked: 'personal-workspace-access-blocked',

  // The third of the three snapshots main pushes from its `ready` arm, and the
  // only one of them with no other sender anywhere. Its renderer arm is
  // `for (let {conversationId, requestId, resolutionState} of
  // e.pendingRequests)` -- an unguarded iteration -- so `pendingRequests` is
  // mandatory and the shape for "nothing pending" is an empty array rather
  // than an omission. A host that resolves no user input on the renderer's
  // behalf still has to SEND it: the message is how the renderer learns the
  // set is empty, and skipping it leaves whatever a previous session put
  // there.
  requestUserInputAutoResolutionSnapshot: 'request-user-input-auto-resolution-snapshot',

  // The MCP event stream, which the host REWRITES rather than forwards. The
  // Electron main process turns a server `mcpServer/event/stream/notification`
  // into `{type:'mcp-event-notification', hostId, notification, subscriptionId}`
  // and forwards nothing else about it. A host that passes the notification
  // through as an ordinary `mcp-notification` produces wire traffic that looks
  // entirely correct and no MCP tool events in the UI at all.
  mcpEventNotification: 'mcp-event-notification',

  // The four below look dead if you read only the renderer's big switch: all
  // four sit in grouped `break` arms that do nothing. They are not dead. The
  // bus fans every message to ALL subscribers registered for its type, and the
  // switch is merely one of them -- `deliverMessage(e,t){let n=this.handlers
  // .get(e);if(!n)return;...for(let e of n)e(t,r)}` -- so the real consumer is
  // a dedicated subscriber elsewhere in the bundle and the no-op arm exists
  // only to stop the message falling out of the switch. Never conclude from an
  // empty case that a type is unused.
  fetchResponse: 'fetch-response',
  persistedAtomSync: 'persisted-atom-sync',
  persistedAtomUpdated: 'persisted-atom-updated',
  sharedObjectUpdated: 'shared-object-updated',

  // The onboarding workspace picker's terminal replies. Its three outbound
  // requests have no timeout of any kind, so exactly one of these has to arrive
  // or the step stays spinning with nothing in the console to explain it.
  workspaceRootOptionPicked: 'workspace-root-option-picked',
  workspaceRootOptionAddCanceled: 'workspace-root-option-add-canceled',
  workspaceRootOptionAdded: 'workspace-root-option-added',
  onboardingSkipWorkspaceResult: 'electron-onboarding-skip-workspace-result',

  // Two cache-invalidation pings. Neither carries state: the renderer answers
  // both by re-issuing a `fetch` for whatever query they name, which makes them
  // the way to say "what I told you earlier is stale" without knowing which
  // query is holding it.
  workspaceRootOptionsUpdated: 'workspace-root-options-updated',
  globalStateUpdated: 'global-state-updated',

  // Window focus, and the one inbound type whose ABSENCE is a hang rather than
  // a missing feature. Main answers `electron-window-focus-request` with this,
  // unconditionally and on every request:
  //
  //   case`electron-window-focus-request`:{let t=g.BrowserWindow.fromWebContents(e),
  //     n=!this.isSystemSuspended&&!this.isScreenLocked&&t?.isFocused()===!0;
  //     this.windowManager.sendMessageToWebContents(e,{type:`electron-window-focus-changed`,
  //       isFocused:n,...n?{}:{occurredAtMs:Date.now()}});break}
  //
  // (main-C3nRcJ3D.js@2055066, and the `occurredAtMs`-on-blur half is read:
  // app-initial@8820278 does `jCs(r.current,e.occurredAtMs)` on that branch.)
  //
  // What makes silence expensive is the atom it feeds. `Zk` starts at `null`,
  // not `false` -- `Zk=rn(q,xvn,{getServerSnapshot:()=>null,...})` with
  // `function xvn(){return null}` (app-initial@2068333) -- and its ONLY writer
  // is `MCs`, reached from the subscribers to this type. So with no reply every
  // `=== true` gate on it is permanently false, and two first-run onboarding
  // paths stop dead with no timeout behind either:
  //
  //   `Rm` (onboarding-page@150761) computes `c=a===void 0||a` and `f=u||!c`
  //   with `u=q(_r)===!0`, then wires `onAnimationComplete:(r&&f?o:void 0)`.
  //   Its caller `Yg` (@221681) passes `waitForWindowFocus:wt()!==!0` -- true
  //   in any tab where reduced motion is off -- so `onContinue` is never
  //   wired and the logo sits centred forever.
  //
  //   `vBs` (app-initial@9145721) renders the static "Thinking" label instead
  //   of mounting the component that calls `onComplete`, and the
  //   `loadingTimeoutSeconds` escape hatch is consumed INSIDE that unmounted
  //   component, so it never arms.
  //
  // An already-onboarded relay user never reaches that lazy route, which is why
  // a real drive saw the request go unanswered and still painted a home screen.
  // That is the house failure shape -- a missing answer, a page that looks
  // fine, every check green -- and it is the reason this is answered rather
  // than filed under "Electron-only".
  //
  // The steady-state half matters on a phone: `Pvc(){IGe.setEventListener(Fvc)}`
  // (app-initial@10008777) REPLACES TanStack Query's default visibilitychange
  // listener with one driven by this message, so a tab that is backgrounded and
  // returned to refetches nothing until the host starts pushing these.
  electronWindowFocusChanged: 'electron-window-focus-changed',

  // The remote-control subset. Unlike everything above, these are not things
  // the Electron main process pushes -- they are things a HOST chooses to
  // send, and the renderer treats them exactly the same because its bus does
  // not distinguish. web/host-touch.mjs is the current caller: a phone has no
  // window chrome, no menu bar and no keyboard shortcuts, so the affordances
  // those would have driven have to arrive as messages instead.
  //
  // They live here rather than in that module because the reason they are
  // dangerous is a property of the PROTOCOL, not of the touch layer. The
  // renderer's inbound switch has 189 cases and no `default:`, so a misspelled
  // type is not an error -- nothing throws, nothing logs, the message is
  // dropped in silence. One exhaustive table with one exhaustive test is the
  // only structure that makes that failure visible, and a second table in
  // another file is how a typo gets to live in the gap between them.
  //
  // `runCommand` is the general case and the reason there is no temptation to
  // synthesise key events: it executes any registered command id, which is a
  // supported API where an untrusted KeyboardEvent is a guess.
  toggleSidebar: 'toggle-sidebar',
  focusComposer: 'focus-composer',
  commandMenu: 'command-menu',
  navigateToRoute: 'navigate-to-route',
  stepFontSize: 'step-font-size',
  stepWindowZoom: 'step-window-zoom',
  resetWindowZoom: 'reset-window-zoom',
  runCommand: 'run-command',
});

/**
 * Renderer -> host. The types we expect to see coming out.
 *
 * `logMessage` is telemetry and is listed only so the capture side can
 * recognise it and throw it away; nothing forwards it anywhere.
 */
export const OUTBOUND = Object.freeze({
  mcpRequest: 'mcp-request',
  mcpRequestAbandon: 'mcp-request-abandon',
  mcpResponse: 'mcp-response',
  appServerRestart: 'codex-app-server-restart',
  logMessage: 'log-message',

  // The renderer's SECOND request-carrying outbound type, and the one that is
  // easy to miss because its name describes a feature rather than a transport.
  // Main's arm for it calls `handlePrewarmThreadStart(...)` where `mcp-request`
  // calls `handleClientRequest(...)`, but both arms destructure the same
  // `{request, hostId, priority, source, timeoutMs, expiresAtMs,
  // retainResponse, savedEnvironmentConfig}` envelope and both answer through
  // the same `sendAppServerResponseToView` -> `mcp-response` path. The two
  // differ in server-side bookkeeping, not in the wire contract, so a host
  // that forwards this exactly as it forwards `mcp-request` is correct.
  //
  // A host that does not name it leaves the composer's prewarm `thread/start`
  // unsent -- not merely unlogged. The renderer files that request under its
  // own id and waits, and the prewarmed thread is what the first message in a
  // workspace is handed, so the visible symptom is a first send that hangs
  // while every later one is fast.
  threadPrewarmStart: 'thread-prewarm-start',

  // Less a request than the renderer saying "my listeners are installed now",
  // which is the one fact a host cannot otherwise observe. See
  // `onRendererReady` in `web/hostlink/link.mjs`: this is what separates "the
  // host never announced" from "the host announced before anyone could hear
  // it", and the two have identical symptoms.
  //
  // It arrives TWICE in a healthy session, from two different effects, and the
  // two are not interchangeable. `{initializationOnly: true}` comes from a
  // component above the renderer's own startup gate and therefore arrives even
  // when the page is still showing its loading indicator; the one carrying
  // `persistedStateResponsePriority` comes from the mounted app routes and
  // therefore only after the gate has opened. A host that waits for the second
  // one deadlocks: no announcement, no routes, no ready, no announcement.
  ready: 'ready',

  // The entire non-conversation data layer travels through this ONE type.
  // Files, git, worktrees, global state, settings, the inbox, skills, workspace
  // roots -- roughly 95 endpoints -- are not separate message types; they are
  // POSTs to `vscode://codex/<endpoint>` funnelled through `fetch`. There is no
  // timeout on it: the renderer files the promise under `requestId` in
  // `pendingRequests` and waits, and the measured `sendRequest` body contains no
  // `setTimeout` at all. One unanswered `fetch` is therefore a permanent
  // spinner with a clean console. Answer every one -- with a `fetch-response`
  // of responseType `error` when there is nothing better to say, because a
  // rejected promise is handled and a pending one never is.
  fetch: 'fetch',
  // Sent when a request's AbortSignal fires. The renderer has already deleted
  // its own pending entry and rejected locally by the time this leaves, so the
  // only useful response is to drop the work: a later `fetch-response` for that
  // requestId matches nothing and is merely wasted.
  cancelFetch: 'cancel-fetch',

  // Persisted UI state, and the one blocking request that self-heals: if
  // `persisted-atom-sync` has not arrived in 5000 ms the renderer logs
  // "[persisted-atom] host did not respond to sync request; continuing with
  // legacy state only" and carries on degraded. Answering it is still worth
  // doing -- it is five seconds off first paint.
  persistedAtomSyncRequest: 'persisted-atom-sync-request',
  // The write-back half, fire and forget: `{key, value, deleted, recordUpdate}`.
  // Its `key` is an opaque storage name of the `something-v1` form, NOT a
  // message type -- the bundle is full of those names and they belong to the
  // atom factory, not to this bus. Round-trip them without interpreting them.
  persistedAtomUpdate: 'persisted-atom-update',

  // Onboarding. None of the three has a timeout, and the first two put the page
  // into a pending state that only an inbound reply clears.
  pickWorkspaceRootOption: 'electron-pick-workspace-root-option',
  addNewWorkspaceRootOption: 'electron-add-new-workspace-root-option',
  onboardingSkipWorkspace: 'electron-onboarding-skip-workspace',

  // The shared-object subscription lifecycle, all three fire and forget. The
  // INITIAL value is not a message at all: the renderer reads it synchronously
  // off `electronBridge.getSharedObjectSnapshotValue(key)` and only later
  // changes arrive, as `shared-object-updated`. So a host that answers
  // `shared-object-subscribe` with a first value is answering a question the
  // renderer did not ask, and a host whose bridge returns undefined starts
  // every shared object empty however many updates it pushes afterwards.
  sharedObjectSubscribe: 'shared-object-subscribe',
  sharedObjectUnsubscribe: 'shared-object-unsubscribe',
  sharedObjectSet: 'shared-object-set',

  // Fire-and-forget state pushes with no inbound counterpart anywhere in the
  // bundle. They are named here so the capture side can recognise them and drop
  // them deliberately, rather than report them as unknown traffic: a host that
  // logs every unhandled outbound type will otherwise drown in these. The
  // checkout webview one sends `{partition, url}` and a second with `url:null`
  // on unmount; the avatar overlay one sends `{onDemandEnabled,
  // shouldPrewarmAvatarOverlay}` from a boot effect alongside the rest of the
  // feature-gate pushes.
  appShellShortcutStateChanged: 'app-shell-shortcut-state-changed',
  checkoutWebviewPresentationChanged: 'checkout-webview-presentation-changed',
  avatarOverlayRestoreReady: 'electron-avatar-overlay-restore-ready',

  // The one unclaimed type that is not fire-and-forget. See
  // `INBOUND.electronWindowFocusChanged` for what main answers it with and for
  // why an unanswered one is a hang rather than a missing feature.
  electronWindowFocusRequest: 'electron-window-focus-request',

  // The twenty-four below are the rest of what a real drive of the shipped
  // renderer sends and nothing on this bus claims. (Twenty-five types were
  // swept; `shared-object-unsubscribe` is the twenty-fifth and was already
  // named above.) Their reasons are one line each and live in
  // ELECTRON_ONLY_PUSHES, immediately after this table.
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

/**
 * Outbound types a browser tab owes NOTHING, with the measured reason for each.
 *
 * This table is the result of sweeping every outbound type a full drive of the
 * mounted renderer left unclaimed, reading both the send site and main's arm
 * for each, and asking one question: does anything in the renderer wait on a
 * reply, or stay wrong without one? Twenty-seven types went in. One came back
 * blocking (`electron-window-focus-request`, answered by web/host-focus.mjs),
 * one cosmetic (`shared-object-set`, mirrored by web/host-services.mjs), and
 * these twenty-five came back owing nothing.
 *
 * It is a table rather than twenty-five paragraphs because the finding in each
 * case is the same two sentences -- what native object main would have poked,
 * and why a tab has not got one -- and because the shape is then testable: a
 * type in here that is not in OUTBOUND, or an empty reason, is a drift a test
 * catches rather than a comment nobody re-reads.
 *
 * THE RULE THIS TABLE ENCODES. "Main does nothing with it" is NOT sufficient
 * grounds for membership, and two entries here would have failed that weaker
 * test: `avatar-overlay-open-state-request` is named like a request and main
 * really does have a reply-capable router for `avatar-overlay-*` types, and
 * `electron-window-focus-request` -- which is NOT here -- is fire-and-forget
 * on the renderer's side and would have passed a "does it await?" test easily.
 * The question that sorts them correctly is whether any renderer state stays
 * wrong. For the overlay one, silence IS the right answer: the atom's initial
 * value already means "no overlay window", which is true in a browser.
 *
 * Membership is what stops `outbound-unclaimed` from being noise. That report
 * exists to say "the next App update added a type nobody has read yet", and it
 * can only say that if everything already read is claimed.
 */
export const ELECTRON_ONLY_PUSHES = Object.freeze({
  // Shared-object lifecycle. The release half of a registration the relay
  // deliberately never creates -- `shared-object-subscribe` is consumed
  // without reply -- so there is no subscriber table for it to shrink.
  [OUTBOUND.sharedObjectUnsubscribe]:
    'releases a per-(key, webContents) Map entry in a registration the relay never makes',

  // Focus and identity.
  [OUTBOUND.viewFocused]:
    'main discards it, and a tab observes its own focus directly through the event this wraps',
  [OUTBOUND.setTelemetryUser]:
    'identity for a main-process Sentry scope, Datadog logger and utility worker a relay has none of; '
    + "the renderer's own Sentry user is set locally before this is dispatched",

  // Native chrome: tray, dock, menu bar, window.
  [OUTBOUND.trayMenuThreadsChanged]:
    'a serialized thread snapshot for a macOS status item and a Windows tray menu; a tab has neither',
  [OUTBOUND.electronSetBadgeCount]:
    'the OS dock/taskbar badge; the in-app unread UI is a pure function of a renderer atom and stays '
    + 'correct. The one entry here with a web analogue -- an installed PWA could call setAppBadge',
  [OUTBOUND.macMenuBarEnabledChanged]:
    'adds or removes a macOS status item; the settings checkbox the user sees renders from the '
    + "renderer's own atom, not from any main-process echo",
  [OUTBOUND.electronWindowZoomChanged]:
    'the renderer applies the zoom itself in the same layout effect by writing --codex-window-zoom, '
    + 'and the value is a locally persisted atom',
  [OUTBOUND.electronSetWindowMode]:
    'Electron resizing itself for onboarding and restoring afterwards; a tab cannot resize its viewport',
  [OUTBOUND.powerSaveBlockerSet]:
    'powerSaveBlocker.start/stop so the machine stays awake during a turn; a tab cannot suspend the OS, '
    + 'and every field is recomputed from atoms each tick so nothing goes stale',

  // App lifecycle, updates and local runtimes.
  [OUTBOUND.localThreadActivityChanged]:
    'feeds the native quit-confirmation dialog, the Sparkle "install later?" prompt and relaunch resume',
  [OUTBOUND.heartbeatAutomationThreadStateChanged]:
    "feeds main's local cron/heartbeat scheduler; the relay has no main-side scheduler at all",
  [OUTBOUND.codexRuntimesConfigChanged]:
    "stored in main's shared-object repository and read only by main's native-runtime installer; "
    + 'no renderer code reads the key',
  [OUTBOUND.electronSparkleGatesChanged]:
    'configures the Sparkle updater, its appcast and Windows runtime frameworks; a page updates by reloading',
  [OUTBOUND.electronAppStateSnapshotTrigger]:
    "a telemetry sampler whose pending id lives in MAIN's map, not the renderer's; the relay has no sink",
  [OUTBOUND.electronDesktopFeaturesChanged]:
    'the renderer is the SOURCE of these flags; main spends them on plugins, native pipes, global '
    + 'hotkeys and the application menu',

  // Input the renderer already applied locally.
  [OUTBOUND.keyboardLayoutMapChanged]:
    'the renderer installed the layout map into its own store before dispatching, so non-QWERTY '
    + 'in-page shortcuts keep resolving correctly',
  [OUTBOUND.globalDictationEnabledChanged]:
    'asks main to register a system-wide hotkey and prewarm a native overlay; a tab can do neither',

  // The avatar overlay window.
  [OUTBOUND.electronAvatarOverlayFeedbackDiagnosticsChanged]:
    'toggles a diagnostics flag on the always-on-top native overlay window, which does not exist here. '
    + "Note the `electron-` prefix misses main's `avatar-overlay-*` reply-capable router",
  [OUTBOUND.avatarOverlayOpenStateRequest]:
    "named like a request, and silence encodes the TRUE answer: the atom's initial value already means "
    + '"the overlay window is not open", which is correct in a browser',

  // The embedded in-app browser: a WebContentsView guest page a tab has not got.
  [OUTBOUND.browserSidebarOwnerSync]:
    'tells main which route owns the WebContentsView; the renderer updates its own copy first, on the '
    + 'same line, before dispatching',
  [OUTBOUND.browserSidebarTweaksEnabledChanged]:
    "enables design-tweak accelerators inside the guest page; there is no guest page",
  [OUTBOUND.browserSidebarSiteAnnotationApiEnabledChanged]:
    'configures the site-annotation JS API and its permission gate for the guest page',
  [OUTBOUND.browserSidebarAnnotationMultiSelectEnabledChanged]:
    "a one-way flag for the guest page's comment overlay; main's own loop is guarded on a live view",
  [OUTBOUND.browserUseSessionRouteCapture]:
    'binds a conversation to a native BrowserWindow for a <webview> attach and a main-hosted '
    + 'browser-use MCP server; main sends nothing back even in Electron',
  [OUTBOUND.workspaceSettingsWebviewPresentationChanged]:
    'names the session partitions with a presented <webview> so the native attach path can inject auth',
});

/** The connection state the renderer actually branches on. */
export const CONNECTION_STATE_CONNECTED = 'connected';

/**
 * The transport value the renderer compares against. It branches on
 * `transport !== 'websocket'`, so what matters is whether the string equals
 * this one, not what else it might be.
 */
export const TRANSPORT_WEBSOCKET = 'websocket';

/**
 * The three inbound types the renderer buffers until a handler subscribes.
 * Everything else sent before its handler exists is DROPPED on the floor, so
 * these three are the only types that are safe to emit early -- and
 * `personal-workspace-access-blocked` keeps only the latest, not a queue, so
 * two of them sent early collapse into one.
 *
 * This is a frozen array and not a Set on purpose: `Object.freeze(new Set())`
 * still lets `.add()` through, so a "frozen" Set is a frozen-looking thing
 * anybody can edit. The array really is frozen; membership goes through the
 * predicate below.
 */
export const BUFFERED_INBOUND_TYPES = Object.freeze([
  INBOUND.mcpRequestDelivery,
  INBOUND.mcpResponse,
  INBOUND.personalWorkspaceAccessBlocked,
]);

/** @param {string} type */
export function isBufferedInboundType(type) {
  return BUFFERED_INBOUND_TYPES.includes(type);
}

/**
 * The renderer's own chunk test, with its order preserved. The `!!e` is not
 * decoration: `typeof null === 'object'` and `'marker' in null` throws, so the
 * null check has to happen between those two.
 */
export function isChunkedEnvelope(value) {
  return typeof value === 'object' && !!value && 'marker' in value && value.marker === CHUNK_MARKER;
}

/**
 * Whether the renderer's inbound guard would hand this to its message switch.
 * The guard's final line is a type test and a `typeof msg.type === 'string'`,
 * and that is the whole of it -- an unknown `type` still counts as deliverable
 * here, because "deliverable" means "reaches the switch", not "handled".
 */
export function isDeliverable(message) {
  return typeof message === 'object' && !!message && typeof message.type === 'string';
}

/**
 * Attach optional fields without letting them exist as explicit `undefined`.
 *
 * `{ trace: undefined }` and `{}` are the same thing to the renderer's switch,
 * but they are not the same object: `assert.deepStrictEqual` separates them and
 * so does `in`. Every builder funnels optional fields through here so the
 * emitted shape has only the keys that were actually supplied.
 *
 * An earlier version of this comment also claimed an explicit `undefined` key
 * "cannot survive a structured clone". That is false -- `structuredClone({x:
 * undefined})` returns an object that still has `x` -- and the claim had already
 * been copied into a second module's header before anybody checked it. The real
 * reasons are the two above, and they are enough.
 */
function withOptional(base, optional) {
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) base[key] = value;
  }
  return base;
}

/**
 * Refuse a missing required field.
 *
 * This file's own test header states the problem it exists to catch: "what
 * breaks is the wrong argument reaching a builder that shrugs and emits
 * something plausible, which the renderer then ignores without complaint".
 * `inboundMcpResponse` has refused on that basis since it was written. The
 * other seven builders shrugged -- a missing required field became an explicit
 * `undefined` on the wire, and the renderer's 188-case switch has no default
 * branch, so the result was silence rather than an error. Every builder with a
 * required field now funnels through here.
 *
 * `null` passes. A null `result`, a null `params` and a null `update` are all
 * real values the app server sends, and treating "absent" and "empty" as the
 * same thing is how a legitimate null becomes a throw.
 *
 * @param {string} builder the exported name, so the message says where to look
 * @param {Record<string, unknown>} fields
 */
function required(builder, fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      throw new TypeError(
        `${builder} needs ${key}: the renderer's host switch has no default branch, so a `
          + 'message missing it is dropped in silence rather than refused',
      );
    }
  }
}

/**
 * Host -> renderer reply to a request the RENDERER made.
 *
 * Takes `id` and `result`/`error` rather than a ready-made payload, because
 * the field this ends up under (`message`) is the opposite of the field the
 * renderer uses on its way out (`response`), and a signature that accepts a
 * whole object is a signature that lets you hand over the wrong one. See the
 * header.
 *
 * Presence is tested with `!== undefined` rather than `in`, because callers
 * assemble these from optional locals and `{ result: undefined }` is exactly
 * what that produces: it means "no result", not "a result that is undefined".
 * A `null` result is real and is preserved.
 *
 * Refuses on neither and on both: neither is the case the renderer drops with
 * a log line nobody reads, and both leaves it to the renderer's branch order
 * to decide whether the call succeeded or failed. Either is a bug upstream of
 * here, and both are cheaper to find at the call site.
 */
export function inboundMcpResponse({
  hostId = HOST_ID_LOCAL,
  id,
  result,
  error,
  requestMethod,
  receivedAtMs,
  trace,
  hostMetrics,
} = {}) {
  const hasResult = result !== undefined;
  const hasError = error !== undefined;
  if (!hasResult && !hasError) {
    throw new TypeError(
      'inboundMcpResponse needs a result or an error; the renderer drops a reply with neither',
    );
  }
  if (hasResult && hasError) {
    throw new TypeError(
      'inboundMcpResponse takes a result or an error, never both; the renderer would pick one for you',
    );
  }
  // Checked after the result/error pair, not before it. Both refusals are true
  // for `inboundMcpResponse({})`, and the result/error one is the more
  // diagnostic: it names the signature this builder exists to enforce, which
  // is what somebody who called it with no arguments got wrong. A missing `id`
  // with a real result is the narrower mistake and still refused -- and it is
  // worth refusing, because an mcp-response the renderer cannot match to a
  // registry entry is the one inbound case that makes it throw.
  required('inboundMcpResponse', { id });
  const message = hasResult ? { id, result } : { id, error };
  return withOptional(
    { type: INBOUND.mcpResponse, hostId, message },
    { requestMethod, receivedAtMs, trace, hostMetrics },
  );
}

/**
 * Host -> renderer server notification: the `item/*` stream and the turn
 * lifecycle.
 *
 * `extra` is spread FIRST and the four known keys are written after it, so a
 * caller cannot shadow `type` with a stray field. That is the same ordering
 * the renderer's own transport uses on the way out (`{ ...payload, type }`),
 * and copying it here means neither direction has a way to lose its type.
 */
export function inboundMcpNotification({
  hostId = HOST_ID_LOCAL,
  method,
  params,
  extra = null,
} = {}) {
  required('inboundMcpNotification', { method });
  const base = extra && typeof extra === 'object' ? { ...extra } : {};
  base.type = INBOUND.mcpNotification;
  base.hostId = hostId;
  base.method = method;
  if (params !== undefined) base.params = params;
  return base;
}

/**
 * Host -> renderer server-INITIATED request. Approvals arrive this way, and
 * the renderer answers with an outbound `mcp-response` carrying `response`.
 *
 * `request.id` here is a UUID string minted by the server. It is passed
 * through untouched; see the header on the two id spaces.
 */
export function inboundMcpRequest({ hostId = HOST_ID_LOCAL, request } = {}) {
  required('inboundMcpRequest', { request });
  return { type: INBOUND.mcpRequest, hostId, request };
}

/** Host -> renderer delivery progress for an in-flight request. */
export function inboundRequestDelivery({ hostId = HOST_ID_LOCAL, update } = {}) {
  required('inboundRequestDelivery', { update });
  return { type: INBOUND.mcpRequestDelivery, hostId, update };
}

/**
 * The one delivery update whose shape is documented, because the renderer
 * generates it for itself when a request's fate stops being knowable.
 */
export function outcomeUnknownUpdate({ requestId, method } = {}) {
  required('outcomeUnknownUpdate', { requestId, method });
  return {
    type: 'outcome-unknown',
    delivery: { requestId, method, stage: 'outcome-unknown' },
  };
}

/**
 * Host -> renderer: the app server is up and these are its versions.
 *
 * The renderer branches on `transport !== 'websocket'`, so leaving `transport`
 * out is a decision and not an omission -- absent takes the non-websocket
 * branch, same as any other value that is not that exact string.
 */
export function inboundAppServerInitialized({
  hostId = HOST_ID_LOCAL,
  appServerVersion,
  installedCodexVersion,
  isSnapshot,
  transport,
} = {}) {
  // `transport` stays optional on purpose -- absent takes the non-websocket
  // branch, which is a decision the doc comment above explains. The two version
  // strings are not optional, and `hostlink` was refusing them up front to work
  // around their absence being emitted rather than refused here.
  required('inboundAppServerInitialized', { appServerVersion, installedCodexVersion });
  return withOptional(
    { type: INBOUND.appServerInitialized, hostId, appServerVersion, installedCodexVersion },
    { isSnapshot, transport },
  );
}

/** Host -> renderer connection state. `connected` is the one that matters. */
export function inboundConnectionChanged({ hostId = HOST_ID_LOCAL, state, isSnapshot } = {}) {
  // Omitting this would be worse than refusing it: every state other than
  // 'connected' reads as "not connected", so a forgotten argument would emit a
  // plausible disconnection notice instead of failing.
  required('inboundConnectionChanged', { state });
  // `isSnapshot` is what makes the same message safe to send twice. Main sets
  // it on the copy it pushes from its `ready` arm, and the renderer's
  // subscriber reads it as `e.isSnapshot || <gate> || S(...)` -- so a snapshot
  // still updates the state the UI reads, and skips the side effect that
  // treats an announcement as a server that has just come back from the dead.
  return withOptional({ type: INBOUND.connectionChanged, hostId, state }, { isSnapshot });
}

/**
 * Host -> renderer: which pending user-input requests are being auto-resolved.
 *
 * Third of the three snapshots main sends from its `ready` arm, and the one
 * with the least to say here: this host auto-resolves nothing on the
 * renderer's behalf, so the honest snapshot is an empty list. It is still sent
 * rather than skipped, because an empty list is a fact the renderer acts on
 * and absence is not.
 *
 * `pendingRequests` defaults rather than being `required`, which is the
 * opposite of the choice the other builders make. The reason is the renderer's
 * own arm: it iterates the field with no guard, so the failure mode for a
 * missing one is a TypeError inside the message dispatcher rather than a
 * plausible-but-wrong message. Defaulting to the empty array makes the
 * unparameterised call correct instead of fatal.
 */
export function inboundRequestUserInputAutoResolutionSnapshot({
  hostId = HOST_ID_LOCAL,
  pendingRequests = [],
} = {}) {
  return { type: INBOUND.requestUserInputAutoResolutionSnapshot, hostId, pendingRequests };
}

/** Host -> renderer: the app server is gone and is not coming back by itself. */
export function inboundFatalError({ hostId = HOST_ID_LOCAL, errorMessage } = {}) {
  required('inboundFatalError', { errorMessage });
  return { type: INBOUND.fatalError, hostId, errorMessage };
}

/**
 * Host -> renderer workspace refusal. Buffered by the renderer, but only the
 * latest one survives -- see BUFFERED_INBOUND_TYPES.
 */
export function inboundPersonalWorkspaceAccessBlocked({
  hostId = HOST_ID_LOCAL,
  extra = null,
} = {}) {
  const base = extra && typeof extra === 'object' ? { ...extra } : {};
  base.type = INBOUND.personalWorkspaceAccessBlocked;
  base.hostId = hostId;
  return base;
}

// ---------------------------------------------------------------------------
// The data layer, the state pushes, and the two shapes that are not ours
//
// Everything from here down belongs to one subsystem and shares one failure
// mode. The names are the renderer's whole non-conversation data layer plus the
// state pushes that invalidate it, and not one of them is validated anywhere:
// the renderer files a promise under a requestId and waits, or it subscribes
// and waits, so a hyphen out of place here is not a merge conflict and not an
// error -- it is a page that never finishes loading.
//
// None of the builders below carries a `hostId`. That is not an omission. A
// `hostId` identifies an app-server client in the renderer's client registry,
// and nothing in this group goes near that registry: `fetch-response` is
// matched on `requestId` against a single pending table, the persisted-atom and
// shared-object subscribers key on nothing but their own fields, and the
// measured shapes of all of them have no `hostId`. `mcp-event-notification` is
// the one exception and does carry one, because it IS app-server traffic.
//
// TWO SHAPES THAT LOOK LIKE SIBLINGS OF `fetch-response` AND ARE NOT HOST
// MESSAGES. Do not add them, however symmetrical it would feel:
//
//   `fetch-stream-complete` and `fetch-stream-error` are the argument objects
//   the renderer's streaming helper hands to its OWN `onComplete` / `onError`
//   callbacks. That path calls the browser's real `window.fetch` behind an
//   AbortController and cancels `response.body` itself; nothing about it
//   crosses the host boundary.
//
//   `fetch-body-resolved` is a Sentry span name inside the instrumented fetch
//   wrapper.
//
// Implementing either as a host message produces a module that passes its own
// tests, emits messages nobody is subscribed to, and resolves nothing.
//
// There is also deliberately NO id-normalisation helper here. The renderer's
// own id mapper is `function xj(e){return e}` -- literally the identity
// function -- so ids are echoed verbatim in both directions and there is no
// renumbering scheme to mirror. A mapper added here would be a scheme the
// renderer does not share, and the damage is concrete rather than theoretical:
// `serverRequest/resolved` takes down an approval card by matching the RAW
// `params.requestId`, so a remapped id leaves a card on screen that the user
// cannot dismiss and that blocks the composer.
// ---------------------------------------------------------------------------

/**
 * The two `responseType` values the renderer branches on in `onFetchResponse`.
 *
 * That branch is a two-case switch with no default, inside a function that has
 * already deleted its pending entry. A third spelling therefore settles
 * nothing AND destroys the only record of the request: the promise can never
 * be resolved afterwards, by anybody.
 */
export const FETCH_RESPONSE_SUCCESS = 'success';
export const FETCH_RESPONSE_ERROR = 'error';

/**
 * Host -> renderer: a `fetch` that produced an HTTP answer.
 *
 * `status` is not policed here and 2xx is not enforced, because the renderer
 * makes that decision itself on this branch: `status >= 200 && status < 300`
 * resolves with `{status, headers, body}` and anything else REJECTS with the
 * body stringified as the error message. Both outcomes settle the promise,
 * which is the only property that matters, so a 404 is better expressed as a
 * success envelope with a real status and a real body than as a throw from a
 * builder.
 *
 * `body` is required and may be null. The renderer's decode is `'body' in e ?
 * e.body : JSON.parse(e.bodyJsonString)`, so an absent `body` key does not mean
 * "empty body" -- it means the renderer parses `undefined`, throws inside its
 * own try, and rejects. A `null` body passes the `in` test and resolves, which
 * is what an endpoint with nothing to say should send.
 *
 * There is no `bodyJsonString` parameter and should not be one. We hold the
 * decoded object already; re-encoding it so the renderer can parse it back can
 * only add a `JSON.parse` that might throw.
 */
export function inboundFetchResponseSuccess({ requestId, status = 200, headers = {}, body } = {}) {
  required('inboundFetchResponseSuccess', { requestId, body });
  return {
    type: INBOUND.fetchResponse,
    requestId,
    responseType: FETCH_RESPONSE_SUCCESS,
    status,
    headers,
    body,
  };
}

/**
 * Host -> renderer: a `fetch` that failed before it had an HTTP answer.
 *
 * `error` is required because it becomes the error's message, and the renderer
 * surfaces that string. The other three are optional and omitted when absent:
 * they are passed positionally into the error constructor, where `undefined` is
 * a legal argument, so a refusal that knows only its reason is still a refusal
 * the UI can show. `requestId` is the field with no slack in it -- a reply the
 * pending table cannot match is indistinguishable from no reply at all.
 */
export function inboundFetchResponseError({
  requestId,
  error,
  status,
  errorCode,
  responseStatus,
} = {}) {
  required('inboundFetchResponseError', { requestId, error });
  return withOptional(
    { type: INBOUND.fetchResponse, requestId, responseType: FETCH_RESPONSE_ERROR, error },
    { status, errorCode, responseStatus },
  );
}

/**
 * Host -> renderer: the reply to `persisted-atom-sync-request`.
 *
 * An empty `state` object is a complete, valid answer and unblocks first paint
 * immediately, but `state` is still required: the subscriber destructures it,
 * and "I forgot the argument" and "there is nothing persisted" deserve
 * different outcomes.
 *
 * `canWritePrimaryWindowTabPersistence` is measured only as the second field
 * the subscriber destructures; what it gates is INFERRED from its name, which
 * reads as "is this the window allowed to write tab persistence". It defaults
 * to true here because the relay serves exactly one page, so there is no second
 * window that could be the primary one -- and a default of false would, on that
 * reading, disable tab persistence for the only window there is.
 *
 * One sequencing hazard, since this type is NOT buffered (see
 * BUFFERED_INBOUND_TYPES): the renderer dispatches the request and installs
 * this subscriber in the same effect, and in the bundle the dispatch sits at a
 * lower offset than the `subscribe` call (~9,956,035 against ~9,956,300).
 * Replying synchronously from inside the capture handler therefore risks
 * arriving before the subscriber exists, where it is dropped in silence and the
 * page waits out the full 5000 ms. Reply from a later task.
 */
export function inboundPersistedAtomSync({ state, canWritePrimaryWindowTabPersistence = true } = {}) {
  required('inboundPersistedAtomSync', { state });
  return { type: INBOUND.persistedAtomSync, state, canWritePrimaryWindowTabPersistence };
}

/**
 * Host -> renderer: one persisted atom changed out of band.
 *
 * The subscriber destructures `{key, value, deleted, savedCustomSectionOperationId}`.
 * Only `key` is required: a push with no key names nothing, whereas a push with
 * no `value` is exactly how a deletion is spelled.
 */
export function inboundPersistedAtomUpdated({
  key,
  value,
  deleted,
  savedCustomSectionOperationId,
} = {}) {
  required('inboundPersistedAtomUpdated', { key });
  return withOptional(
    { type: INBOUND.persistedAtomUpdated, key },
    { value, deleted, savedCustomSectionOperationId },
  );
}

/**
 * Host -> renderer: the workspace the user picked.
 *
 * The handler reads `e.root` and nothing else. The path is expected to be
 * absolute and nothing here checks that, because the renderer does not either:
 * a relative path is accepted, stored, and fails later against the filesystem,
 * which is a different module's problem to detect and a worse one to guess at
 * here.
 */
export function inboundWorkspaceRootOptionPicked({ root } = {}) {
  required('inboundWorkspaceRootOptionPicked', { root });
  return { type: INBOUND.workspaceRootOptionPicked, root };
}

/**
 * Host -> renderer: the user backed out of the picker.
 *
 * Carries no fields. It exists so the pending state has a second way to clear,
 * and sending it is how a host declines to implement the picker without leaving
 * onboarding spinning forever.
 */
export function inboundWorkspaceRootOptionAddCanceled() {
  return { type: INBOUND.workspaceRootOptionAddCanceled };
}

/**
 * Host -> renderer: a workspace root was added, and this is the project to
 * select.
 *
 * The switch reads `e.selectedProjectId ?? e.projectId`, so writing only
 * `projectId` is correct and complete. This builder deliberately offers no way
 * to spell the other one: `??` means the two fields are not interchangeable
 * when both are present, and a builder that accepted both would be a builder
 * with a precedence rule nobody reading the call site can see.
 */
export function inboundWorkspaceRootOptionAdded({ projectId } = {}) {
  required('inboundWorkspaceRootOptionAdded', { projectId });
  return { type: INBOUND.workspaceRootOptionAdded, projectId };
}

/**
 * Host -> renderer: the workspace root list changed.
 *
 * A pure cache-invalidation ping with no fields -- the handler invalidates the
 * `workspace-root-options` and `git-origins` queries, which the renderer then
 * refetches as two new `fetch` messages. So this is also the lever for forcing
 * a refetch without knowing anything about the query cache.
 */
export function inboundWorkspaceRootOptionsUpdated() {
  return { type: INBOUND.workspaceRootOptionsUpdated };
}

/**
 * Host -> renderer: the onboarding skip finished.
 *
 * `success` is required because the handler's branch is `if (e.success) {...
 * return} setError(e.error ?? null)`: a message with no `success` is read as a
 * failure with no error text, which renders an onboarding step that failed and
 * will not say why. `error` is optional and only read on the failure arm.
 */
export function inboundOnboardingSkipWorkspaceResult({ success, error } = {}) {
  required('inboundOnboardingSkipWorkspaceResult', { success });
  return withOptional({ type: INBOUND.onboardingSkipWorkspaceResult, success }, { error });
}

/**
 * Host -> renderer: these global-state keys are stale, refetch them.
 *
 * `keys` MUST be an array, and this is the one builder that type-checks an
 * argument rather than merely requiring it, because the usual rule -- null
 * passes, the renderer sorts it out -- does not hold here. The handler is
 * `e.keys.includes(LOCAL_PROJECTS) && ...; for (const t of e.keys) invalidate(t)`,
 * so a null `keys` throws inside the renderer's own handler, and a bare key
 * STRING is worse than a throw: a string has `.includes` and is iterable, so
 * `keys:'codexHome'` quietly invalidates one query key per character and the
 * key the host actually meant is never refetched. That failure is silent and
 * would be hunted for in the wrong module.
 */
export function inboundGlobalStateUpdated({ keys } = {}) {
  required('inboundGlobalStateUpdated', { keys });
  if (!Array.isArray(keys)) {
    throw new TypeError(
      'inboundGlobalStateUpdated needs keys to be an array: the renderer calls keys.includes() and '
        + 'then iterates it, so a null throws inside its handler and a bare string invalidates one '
        + 'query per character',
    );
  }
  return { type: INBOUND.globalStateUpdated, keys };
}

/**
 * Host -> renderer: a shared object changed.
 *
 * Every shared-object subscriber receives every one of these and filters with
 * `message.key === itsOwnKey`, reading only `value` afterwards. Both fields are
 * therefore required: a missing `key` is a message delivered to all of them and
 * used by none, and a missing `value` would set the object to `undefined` for
 * whichever one did match. A `null` value passes, because null is a value a
 * shared object can legitimately hold.
 */
export function inboundSharedObjectUpdated({ key, value } = {}) {
  required('inboundSharedObjectUpdated', { key, value });
  return { type: INBOUND.sharedObjectUpdated, key, value };
}

/**
 * Host -> renderer: the window gained or lost focus.
 *
 * `isFocused` is required, and a boolean is demanded rather than accepted-and-
 * coerced because the state it lands in is tri-valued. `MCs(store, isFocused)`
 * writes straight into an atom whose initial value is `null`, and every reader
 * tests `=== true`; a truthy non-boolean would read as focused in those and
 * `!== false` in the handful written the other way. One type in, one type out.
 *
 * `occurredAtMs` mirrors main exactly: present only on the blur branch, where
 * `jCs(r.current, e.occurredAtMs)` reads it to close a focus-duration span.
 * Sending it alongside `isFocused: true` is therefore not merely redundant --
 * it is the shape main never produces, so it is a shape nothing was written
 * against. Passed explicitly rather than stamped here, because this module
 * reads no clock.
 */
export function inboundElectronWindowFocusChanged({ isFocused, occurredAtMs } = {}) {
  required('inboundElectronWindowFocusChanged', { isFocused });
  if (typeof isFocused !== 'boolean') {
    throw new TypeError(
      'inboundElectronWindowFocusChanged needs isFocused to be a boolean: it is written into an atom '
        + 'that starts at null and whose readers test `=== true`, so a truthy string would read as '
        + 'focused in those and as not-blurred in the ones written `!== false`',
    );
  }
  return isFocused
    ? { type: INBOUND.electronWindowFocusChanged, isFocused: true }
    : withOptional({ type: INBOUND.electronWindowFocusChanged, isFocused: false }, { occurredAtMs });
}

/**
 * Host -> renderer: an MCP server event, rewritten from the server's
 * `mcpServer/event/stream/notification`.
 *
 * Both payload fields are required. The Electron main process always sends both
 * and its subscriber's filtering was not measured, so requiring them keeps us
 * byte-compatible with the host the renderer was built against rather than
 * betting on which one it reads. The big switch's arm for this type is a
 * grouped no-op, which -- see the note on INBOUND -- says nothing about whether
 * a subscriber consumes it.
 */
export function inboundMcpEventNotification({
  hostId = HOST_ID_LOCAL,
  notification,
  subscriptionId,
} = {}) {
  required('inboundMcpEventNotification', { notification, subscriptionId });
  return { type: INBOUND.mcpEventNotification, hostId, notification, subscriptionId };
}

/**
 * The size of the renderer's inbound server-notification vocabulary: 82.
 *
 * The host does not need an allow-list -- it forwards the whole notification
 * stream, and that is the right default. This number is here for the opposite
 * purpose: so nobody builds a renderer-facing feature on a name the renderer
 * DROPS.
 *
 * The gate is `function GTt(e){return WTt(e)?jN[e]===!0:!1}` over a 157-entry
 * table: 81 entries are `!0` and 76 are `!1`, and the test is a strict
 * `=== true`, so both an unknown name and a known-but-denied one return false
 * and are discarded with zero logging. `app/list/updated` is handled BEFORE the
 * gate is consulted, which is why the real vocabulary is 82 and not 81.
 *
 * The denied half is the dangerous half, because it reads like a list of the
 * things you would most want to build on. See
 * KNOWN_DROPPED_NOTIFICATION_METHODS.
 */
export const INBOUND_NOTIFICATION_COUNT = 82;

/**
 * Notification methods the renderer knows about and strictly drops.
 *
 * A SAMPLE of the 76 denied entries, not the whole set -- these are the ones
 * named from the measured table, chosen because each is exactly what somebody
 * would reach for. `thread/compacted`, `thread/closed` and `thread/reverted`
 * look like the thread lifecycle; `warning` looks like the way to surface a
 * warning; `command/exec/outputDelta` and `process/exited` look like command
 * streaming, which actually arrives as `item/commandExecution/outputDelta`.
 *
 * The same trap at scale: 60 of the 71 `codex/event/*` methods are denied. Only
 * `codex/event/session_configured` and the ten `collab_*` events get through,
 * so the `codex/event/agent_message*` family in particular vanishes without a
 * trace.
 *
 * Frozen as an array rather than a Set for the reason given on
 * BUFFERED_INBOUND_TYPES: freezing a Set does not stop `.add`.
 */
export const KNOWN_DROPPED_NOTIFICATION_METHODS = Object.freeze([
  'thread/compacted',
  'thread/closed',
  'thread/reverted',
  'warning',
  'command/exec/outputDelta',
  'process/exited',
]);

/**
 * The app-server RESULT shapes the renderer destructures on sight.
 *
 * Documentation and a hook for tests, NOT validators. Nothing on the wire
 * checks these -- the transport accepts any JSON-shaped result -- and the host
 * must forward results untouched, so a table of descriptors is the honest form:
 * the moment this became a validator it would start rejecting results the real
 * app server sends and the renderer handles fine.
 *
 * Why write them down at all: a wrong shape does not fail at the transport. It
 * throws inside a React render, and the submit path's catch arm turns that into
 * `{type:'error', ...}` pushed into the thread. The user sees their own message
 * become a red error item, which is indistinguishable from the model failing.
 * That is a bug report nobody can act on, so the shapes are pinned here while
 * the evidence for them is still fresh.
 *
 * `read` lists the paths the renderer touches immediately, which is the part
 * that cannot be absent. `mustSucceed` marks a method whose rejection is not
 * handled anywhere.
 */
export const APP_SERVER_RESULT_SHAPES = Object.freeze({
  'turn/start': Object.freeze({
    shape: '{ turn: { id, status } }',
    read: Object.freeze(['turn.id', 'turn.status']),
    mustSucceed: false,
    why: 'The submit path calls `accepted(result.turn.id)` and assigns `result.turn.status` with no '
      + 'guard, inside the try whose catch arm replaces the user message with a red error item.',
  }),
  'turn/steer': Object.freeze({
    shape: '{ turnId }',
    read: Object.freeze(['turnId']),
    mustSucceed: false,
    why: 'Steering resolves straight into `({turn:e})=>({turnId:e.id})` for the turn/start variant '
      + 'and reads `turnId` for this one, so the two methods do NOT share a result shape.',
  }),
  'thread/list': Object.freeze({
    shape: '{ data: [], nextCursor }',
    read: Object.freeze(['data', 'nextCursor']),
    mustSucceed: false,
    why: 'The list is consumed by a react-query `select` that spreads `result.data` before sorting '
      + 'it, so a missing `data` throws inside the select rather than at the call site. An absent '
      + '`nextCursor` reads as "no more pages", which is also what `null` means.',
  }),
  'config/read': Object.freeze({
    shape: '{ config: {...} }',
    read: Object.freeze(['config']),
    mustSucceed: true,
    why: 'Two of the four call sites have no catch -- the edit-message path and the queue-send path '
      + 'both await it and read `.config` bare, where the other two use `.catch(()=>null)`. A relay '
      + 'that errors this method leaves editing a sent message and sending a queued message '
      + 'throwing unhandled mid-interaction while a fresh turn works perfectly, which is a bug '
      + 'report that reads as random.',
  }),
});
