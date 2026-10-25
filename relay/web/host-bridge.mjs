// `window.electronBridge`, built for a browser that has no Electron under it.
//
// The renderer we serve is the unmodified Electron bundle. Early in its boot it
// reaches for a preload-injected bridge and reads four values off it
// SYNCHRONOUSLY, at module-eval time, before anything is painted:
//
//   getSentryInitOptions  getBuildFlavor  getSharedObjectSnapshotValue
//   getSystemThemeVariant
//
// A fifth, getInitialSidebarBootstrap, is read lazily and is therefore the only
// one with any slack in it.
//
// In Electron those four come back over `sendSync` -- a blocking round trip to
// the main process, which is exactly the kind of thing you do not get to do in
// a browser. That sounds like the hard part of this port and it is actually the
// easy part: the surface process already knows all four values at the moment it
// serves the page, so they arrive as config and the "blocking round trip"
// becomes a property read. No IPC, no await, no race. This is one of the few
// places where the browser is strictly simpler than the thing we are imitating.
//
// What that simplicity costs is a validation obligation. Because the values are
// handed to us rather than fetched, a missing one is not an error at read time
// -- it is `undefined` flowing into a renderer that has already decided to
// trust it. So installation refuses a config that is short a required value,
// loudly, at install time, where the stack trace still says which key. A
// renderer that boots wrong is far more expensive to diagnose than one that
// does not boot.
//
// getSentryInitOptions must return exactly SEVEN keys. The renderer counts
// them, and the count is how it decides this window is trusted. Six keys and a
// comment about the seventh is a window that silently loses features, so the
// object is assembled from a fixed key list and the list is the contract.
//
// On the members that do nothing: most of the 20 installed here are no-ops,
// because the capability behind them (dragging a file into the OS, a native
// context menu) has no browser equivalent and the renderer guards every one of
// them. Where a no-op has to return something, it returns the shape that fails
// loudly if we guessed the direction wrong: a resolved promise rather than
// undefined where the caller might chain `.catch`, and an unsubscribe function
// rather than undefined where the caller might call the result. Both of those
// are harmless when unused and a TypeError when we were wrong, which is the
// right way round.
//
// That rule has exactly one exception, and it is why this file installs 20
// members rather than all 22 names the bundle probes. The renderer's worker
// channel -- git, computer-use, and the diff, branch and worktree surface
// behind them -- reads an absent sender as its own error case and a present one
// as a working channel, so a polite no-op there is a permanent spinner rather
// than a harmless lie. The reasoning sits at the point in the bridge literal
// where the two members would otherwise be, because that is where the next
// reader who thinks they went missing by accident will look.
//
// ONE SHAPE WE HAD TO GUESS: `isDeviceCheckSupported` and `isIntelMacBuild` are
// implemented as functions returning booleans, matching the other 21 members,
// which are all callables or the plain `windowType` string. If the renderer
// instead reads them as bare booleans, a function is always truthy and both
// would read as true -- selecting an Intel-Mac code path on a machine that is
// not one. That is the one member shape in this file not pinned by a reading of
// the bundle, and it is called out here so it is cheap to fix if it is wrong.

/**
 * The seven keys the renderer counts. Written out rather than inferred from the
 * config object, so that an extra config key cannot quietly make it eight.
 */
export const SENTRY_INIT_OPTION_KEYS = Object.freeze([
  'dsn',
  'appVersion',
  'buildNumber',
  'buildFlavor',
  'codexAppSessionId',
  'desktopTraceSampleRate',
  'initialDesktopTraceSampleRate',
]);

/** The six no-ops the renderer's Sentry transport calls into. */
export const SENTRY_IPC_METHODS = Object.freeze([
  'sendRendererStart',
  'sendScope',
  'sendEnvelope',
  'sendStatus',
  'sendStructuredLog',
  'sendMetric',
]);

/** The value `window.codexWindowType` and `electronBridge.windowType` carry. */
export const WINDOW_TYPE = 'electron';

/** The two variants `getSystemThemeVariant` is allowed to return. */
export const THEME_VARIANTS = Object.freeze(['light', 'dark']);

/**
 * Config keys with no sensible default. Each one either reaches the renderer
 * during its synchronous boot read or is counted into the seven, so `undefined`
 * here is a renderer that boots wrong rather than one that boots degraded.
 *
 * `dsn` is deliberately NOT in this list. An empty DSN is how you turn error
 * reporting off, and it still occupies its key in the seven -- the count is
 * what the renderer checks, not the content.
 */
const REQUIRED_STRING_CONFIG = Object.freeze([
  'appVersion',
  'buildNumber',
  'buildFlavor',
  'codexAppSessionId',
  'desktopUserAgent',
  'theme',
]);

function requireString(config, key) {
  const value = config[key];
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`installElectronBridge: config.${key} must be a non-empty string`);
  }
  return value;
}

function optionalNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Validate and fill in. Returns a flat, frozen record so that nothing
 * downstream has to repeat a `?? default` and risk disagreeing about what the
 * default was.
 */
/**
 * Shared-object keys that must be seeded, because `null` is not a shaped empty
 * for them.
 *
 * `getSharedObjectSnapshotValue` answers `null` for any key it was not seeded
 * with, and for eight of the nine keys this renderer reads that is exactly
 * right -- every one of them guards with `?? []`, with `!= null`, with
 * `=== true`, or by handing the value to an isEqual that compares it against a
 * fresh object. Measured against the shipped bundle:
 *
 *   diff_comments                    gd(t,`diff_comments`)?.[e] ?? []
 *   host_config                      gd(e.get,`host_config`) ?? yc(`local`,null)
 *   is_default_browser               gm(sze,`is_default_browser`) === !0
 *   remote_control_connections       gd(e,`remote_control_connections`) ?? []
 *   remote_ssh_connections           t = gd(...); if (t != null) ...
 *   remote_wsl_connections           gd(e,`remote_wsl_connections`) ?? []
 *   statsig_default_enable_features  isEqual(gd(...), s)
 *   statsig_evaluations              isEqual(gd(...), o)
 *
 * The exception is `pending_worktrees`, whose atom is
 *
 *   VS = We(q,(e,{get:t})=>{ if(e==null) return null
 *                            let n = gd(t,`pending_worktrees`)
 *                            return n===void 0 ? void 0 : _It(n,e) })
 *   function _It(e,t){ return e.find(e=>e.clientThreadId===t) ?? null }
 *
 * -- a guard that tests for `undefined` only and so admits `null` straight
 * into `.find`. The first branch means it is never reached until a thread has
 * a clientThreadId, which is why every boot-time probe missed it: the page
 * mounts, the composer works, and the UI dies on the FIRST REAL TURN with
 * "ChatGPT hit a snag", after the reply has already arrived intact.
 *
 * The seed is `[]` and not `undefined` because `undefined` is that atom's
 * "still loading" state -- nothing would ever resolve it, so the worktree
 * surface would hang instead of crashing. A fresh array per call, because a
 * frozen module-level one would be shared by every bridge on the page.
 */
function sharedObjectDefaults() {
  return { pending_worktrees: [] };
}

function normaliseConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new TypeError('installElectronBridge: config is required');
  }
  for (const key of REQUIRED_STRING_CONFIG) requireString(config, key);

  const variant = config.systemThemeVariant;
  if (!THEME_VARIANTS.includes(variant)) {
    throw new TypeError(
      `installElectronBridge: config.systemThemeVariant must be one of ${THEME_VARIANTS.join(', ')}`,
    );
  }

  return Object.freeze({
    dsn: typeof config.dsn === 'string' ? config.dsn : '',
    appVersion: config.appVersion,
    buildNumber: config.buildNumber,
    buildFlavor: config.buildFlavor,
    codexAppSessionId: config.codexAppSessionId,
    desktopTraceSampleRate: optionalNumber(config.desktopTraceSampleRate, 0),
    initialDesktopTraceSampleRate: optionalNumber(config.initialDesktopTraceSampleRate, 0),

    desktopUserAgent: config.desktopUserAgent,
    theme: config.theme,
    systemThemeVariant: variant,

    // Defaults to the Sentry session id so the two cannot drift apart by
    // accident; override only if the surface really does mint two.
    appSessionId:
      typeof config.appSessionId === 'string' && config.appSessionId !== ''
        ? config.appSessionId
        : config.codexAppSessionId,

    // In Electron this is when the preload script began. There is no preload
    // here, so install time is the closest honest answer, and the renderer only
    // ever subtracts it from `Date.now()`.
    preloadStartedAtMs: optionalNumber(config.preloadStartedAtMs, Date.now()),

    // Defaults first, so a caller that really does know better still wins.
    sharedObjectSnapshot:
      config.sharedObjectSnapshot && typeof config.sharedObjectSnapshot === 'object'
        ? { ...sharedObjectDefaults(), ...config.sharedObjectSnapshot }
        : sharedObjectDefaults(),
    sidebarBootstrap: config.sidebarBootstrap ?? null,
    fastModeRolloutMetrics: config.fastModeRolloutMetrics ?? null,
    isDeviceCheckSupported: config.isDeviceCheckSupported === true,
    isIntelMacBuild: config.isIntelMacBuild === true,
  });
}

/**
 * Install the bridge, the Sentry IPC stub and the theme dataset onto a window.
 *
 * Must run before the renderer's module entry is evaluated -- see the header on
 * the four synchronous reads.
 *
 * @param {{window: object, config: object}} args
 * @returns {{
 *   bridge: object,
 *   config: object,
 *   systemThemeVariant: string,
 *   setSystemThemeVariant: (variant: string) => void,
 *   setTheme: (theme: string) => void,
 *   uninstall: () => void,
 * }}
 */
export function installElectronBridge({ window, config } = {}) {
  if (!window || typeof window !== 'object') {
    throw new TypeError('installElectronBridge: a window is required');
  }
  const settings = normaliseConfig(config);

  let systemThemeVariant = settings.systemThemeVariant;
  const themeListeners = new Set();

  const bridge = {
    windowType: WINDOW_TYPE,

    // We never chunk, so there is never anything to acknowledge. The renderer
    // only reaches this after reassembling an envelope carrying our marker, and
    // nothing in this repo produces one.
    acknowledgeChunkedMessage: () => {},

    getPreloadStartedAtMs: () => settings.preloadStartedAtMs,

    // DO NOT make this deliver anything.
    //
    // The renderer's transport sends every message twice over: it calls this,
    // and then -- unconditionally, bridge or no bridge -- dispatches a
    // `codex-message-from-view` CustomEvent on the window. web/host-bus.mjs
    // captures the CustomEvent, because that is the path that exists whether or
    // not this member does. If this one also delivered, every single outbound
    // message would arrive at the host twice, and the duplicate would look like
    // a retry rather than like a bug.
    //
    // It still has to EXIST and still has to return a promise: the renderer
    // calls `.catch()` on the result without checking it.
    sendMessageFromView: () => Promise.resolve(),

    // Electron hands back a real filesystem path for a dropped File. A browser
    // has no such thing and never will; the empty string is the renderer's
    // "no path" case.
    getPathForFile: () => '',
    startFileDrag: () => {},
    startLinkDrag: () => {},

    // DELIBERATELY ABSENT, and not an oversight: `sendWorkerMessageFromView`
    // and `subscribeToWorkerMessages`.
    //
    // Both were here, written as `() => Promise.resolve()` and `() => () => {}`
    // so that they would look like the same harmless no-op as every member
    // above. They are its opposite. The renderer's worker client reads the
    // sender off the bridge and guards it synchronously, before it allocates
    // anything:
    //
    //   request(e){let t=window.electronBridge?.sendWorkerMessageFromView;
    //     if(!t)return Promise.reject(Error(`Electron worker bridge is unavailable`));
    //
    // and only then builds the pending entry whose one non-worker exit is that
    // same send failing:
    //
    //   c=new Promise((t,r)=>{this.pending.set(n,{method:e.method,resolve:...,reject:r,...})});
    //   t(this.workerId,s).catch(e=>{let t=this.pending.get(n);
    //     t&&(this.pending.delete(n),t.reject(...))});
    //
    // So of the three answers available, resolving is the worst. The guard
    // passes, the pending entry is created, and the only things left that could
    // ever settle it are a `worker-response` from a worker this relay does not
    // run, or an abort from a caller that happened to pass a signal. Every
    // other call -- every git and computer-use request, which is the whole
    // diff, branch and worktree surface -- then waits forever with a clean
    // console, which is the most expensive failure mode this port can produce.
    //
    // Absence beats rejecting, which would also settle the call, because of the
    // cancel path: the abort listener sends `worker-request-cancel` through this
    // same member and drops the returned promise without a `.catch`, so a
    // rejecting member would hand the renderer an unhandled rejection once per
    // cancelled request -- and its global handler reports those as error-level
    // `log-message` traffic, which is noise pointing at the wrong thing.
    // Absence is also the renderer's own designed path, so the text that
    // reaches the user is the sentence its authors wrote for this exact case.
    //
    // Nothing reads either name without optional chaining -- the client's
    // constructor calls `subscribeToWorkerMessages?.()` -- so leaving both out
    // is safe. Putting either back means building the relay behind it: a
    // `worker-response` delivered to the subscriber, carrying the request id
    // and echoing the request's method, because a method mismatch is rejected
    // on arrival rather than ignored.

    showContextMenu: () => Promise.resolve(null),
    getFastModeRolloutMetrics: () => settings.fastModeRolloutMetrics,

    // Read synchronously during boot. An unknown key answers null rather than
    // undefined: null survives a structured clone and reads as "no value",
    // while undefined is indistinguishable from "this bridge member is missing".
    getSharedObjectSnapshotValue: (key) =>
      (Object.hasOwn(settings.sharedObjectSnapshot, key) ? settings.sharedObjectSnapshot[key] : null),

    getInitialSidebarBootstrap: () => settings.sidebarBootstrap,

    getSystemThemeVariant: () => systemThemeVariant,

    /**
     * Register for OS theme changes.
     *
     * Deliberately does NOT invoke the listener with the current value on
     * subscribe: the renderer has already read `getSystemThemeVariant()`
     * synchronously by this point, so an immediate call would be a duplicate
     * of a value it holds.
     */
    subscribeToSystemThemeVariant: (listener) => {
      if (typeof listener !== 'function') {
        throw new TypeError('subscribeToSystemThemeVariant: listener must be a function');
      }
      themeListeners.add(listener);
      return () => {
        themeListeners.delete(listener);
      };
    },

    triggerSentryTestError: () => {},

    // Rebuilt on every call. The renderer is free to mutate what it is handed,
    // and a shared frozen object would either throw under it or leak an edit
    // into the next read.
    getSentryInitOptions: () => {
      const options = {};
      for (const key of SENTRY_INIT_OPTION_KEYS) options[key] = settings[key];
      return options;
    },

    getDesktopUserAgent: () => settings.desktopUserAgent,
    getAppSessionId: () => settings.appSessionId,
    getBuildFlavor: () => settings.buildFlavor,

    // See the header: these two are the one guessed shape in this file.
    isDeviceCheckSupported: () => settings.isDeviceCheckSupported,
    isIntelMacBuild: () => settings.isIntelMacBuild,
  };

  const sentryIpc = {};
  for (const method of SENTRY_IPC_METHODS) sentryIpc[method] = () => {};

  window.codexWindowType = WINDOW_TYPE;
  window.electronBridge = bridge;
  window.__SENTRY_IPC__ = { 'sentry-ipc': sentryIpc };

  const dataset = window.document?.documentElement?.dataset;
  if (dataset) dataset.theme = settings.theme;

  return {
    bridge,
    config: settings,
    get systemThemeVariant() {
      return systemThemeVariant;
    },
    /**
     * Drive a theme change the way the OS would. Listeners are called in
     * registration order and each is isolated, so one throwing listener cannot
     * stop the rest from being told -- a half-notified UI is worse than a
     * logged error.
     */
    setSystemThemeVariant: (variant) => {
      if (!THEME_VARIANTS.includes(variant)) {
        throw new TypeError(
          `setSystemThemeVariant: variant must be one of ${THEME_VARIANTS.join(', ')}`,
        );
      }
      if (variant === systemThemeVariant) return;
      systemThemeVariant = variant;
      for (const listener of [...themeListeners]) {
        try {
          listener(variant);
        } catch {
          // Swallowed on purpose; see above.
        }
      }
    },
    setTheme: (theme) => {
      if (typeof theme !== 'string' || theme === '') {
        throw new TypeError('setTheme: theme must be a non-empty string');
      }
      const target = window.document?.documentElement?.dataset;
      if (target) target.theme = theme;
    },
    uninstall: () => {
      themeListeners.clear();
      if (window.electronBridge === bridge) delete window.electronBridge;
      delete window.codexWindowType;
      delete window.__SENTRY_IPC__;
    },
  };
}
