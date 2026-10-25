// The touch adaptation layer: the small part of mobile that CSS cannot do.
//
// The renderer we serve is the real unmodified Codex bundle, and at 390x844 it
// already works: 0 exceptions, no horizontal overflow, 1133 React nodes, a live
// contenteditable composer. So this is not a port. It is a short list of
// specific defects, and the great majority of them are declarative and live in
// web/host-touch.css. What is left here is the residue -- the things a
// stylesheet has no way to say:
//
//   1. one attribute on an element React owns and has not mounted yet, re-
//      asserted when React overwrites it,
//   2. a tap on the sidebar scrim, which has to become a message,
//   3. the remote-control helpers, which have to become messages too, and
//   4. the clipboard write, which has to happen inside the tap itself and
//      therefore cannot happen in the host stub that the tap eventually
//      reaches.
//
// THERE USED TO BE ONE MORE, AND WHY IT IS GONE IS WORTH KEEPING
//
// It added `.electron-opaque` to <html>, the class the bundle keys its
// frameless-window translucency off, at module evaluation. Measured in
// app-initial, the renderer runs
//
//   let [s,c] = useState(!1);
//   ...
//   useLayoutEffect(() => {
//     let e = document.querySelector('[data-codex-window-type="electron"]');
//     if (e) { if (s && !xg()) { e.classList.add(`electron-opaque`); return }
//              e.classList.remove(`electron-opaque`) }
//   }, [s])
//
// so the first layout effect after mount -- before the first paint anybody sees
// -- took our class straight back off, every time. Posting the one message that
// sets `s`, `electron-window-opaque-surface-changed`, is not a fix either: it is
// not one of the three types the renderer's bus buffers, so anything we send
// before React subscribes is dropped, and the subscription is not observable
// from here. web/host-touch.css now states the three declarations that class
// would have unlocked, directly and without a class.
//
// WHY THERE ARE NO SYNTHETIC KEY EVENTS IN HERE
//
// The temptation on a phone is to fake input: dispatch a KeyboardEvent at the
// composer to submit, at the window to open the command menu. That fails for a
// reason worth writing down. ProseMirror dispatches from its own plugin
// keymaps, and an untrusted KeyboardEvent carries `isTrusted: false`, no
// composition state and no `inputType`; the handlers that do fire then mutate a
// document the browser's own editing machinery does not know changed. What the
// renderer offers instead is far better: it subscribes 50 inbound host message
// types that together are a complete remote control, including a generic
// `run-command` that executes any registered command id. Those are a supported
// API. Key events are a guess.
//
// WHAT WE MUST NOT RACE
//
// `window.codexOs` and `window.codexWindowType` are assigned by the bundle
// entry AFTER this module runs, so writing them here is pointless -- the entry
// wins. Everything below therefore targets the downstream EFFECT (the inset the
// bundle computes, the attribute it renders) rather than the input it computes
// it from.

import { INBOUND } from './host-protocol.mjs';

// The inbound message types this module emits.
//
// A VIEW of web/host-protocol.mjs, not a second table. These eight used to be
// restated here, because that file was pinned by an exhaustive deepEqual owned
// by another agent mid-wave and adding a key would have failed that agent's
// test rather than ours. The wave is over and the duplication is not worth
// keeping: the renderer's inbound switch has 189 cases and NO `default:`, so a
// misspelled type is not an error, it is silence -- nothing throws, nothing
// logs, the message is simply dropped. The only thing that makes that visible
// is one exhaustive table with one exhaustive test, and a private copy here is
// precisely the gap a typo would live in.
//
// Kept as a named export because it says something the protocol table cannot:
// which of the 29 inbound types THIS layer is allowed to send.
export const TOUCH_INBOUND = Object.freeze({
  toggleSidebar: INBOUND.toggleSidebar,
  focusComposer: INBOUND.focusComposer,
  commandMenu: INBOUND.commandMenu,
  navigateToRoute: INBOUND.navigateToRoute,
  stepFontSize: INBOUND.stepFontSize,
  stepWindowZoom: INBOUND.stepWindowZoom,
  resetWindowZoom: INBOUND.resetWindowZoom,
  runCommand: INBOUND.runCommand,
});

// The narrow-viewport gate, duplicated from web/host-touch.css because the two
// files have to agree and neither can import the other. The bundle's own
// responsive-sidebar rule is `@media not all and (width>=768px)`, so this is
// the complement of its breakpoint rather than a number of our choosing;
// test/web/host-touch.test.mjs asserts the stylesheet still says the same.
export const MOBILE_MEDIA_QUERY = '(max-width: 767px)';

// The coarse-pointer gate, for the same reason.
export const COARSE_POINTER_MEDIA_QUERY = '(pointer: coarse)';

// Clamps the renderer applies to the two `step-*` types, recorded here so a
// caller can tell "the host ignored me" from "the host clamped me". Both were
// read from the handlers: the font-size delta is in PIXELS and the window-zoom
// delta is in STEPS OF 0.1, which is exactly the sort of difference that makes
// a `delta: 1` call do something unintended.
export const SANS_FONT_SIZE_RANGE = Object.freeze({ min: 11, max: 16 });
export const WINDOW_ZOOM_RANGE = Object.freeze({ min: 0.5, max: 3 });
export const WINDOW_ZOOM_STEP = 0.1;

// The selector for the app-shell frame. This is an ATTRIBUTE selector and not a
// class for a reason that applies to everything we target: the frame's class is
// `_Layout_yl8z4_2`, a CSS-module hash regenerated by the bundle's build, so a
// class-based lookup would start matching nothing after the next Codex release
// with no error anywhere. `data-app-shell-frame` is written by the shell as
// part of its own contract and survives.
const FRAME_SELECTOR = '[data-app-shell-frame]';

// The attribute that turns on the bundle's own responsive-sidebar mode. It is
// rendered next to `data-app-shell-frame` on the same props object with a
// hardcoded `false`, which is what makes a built-in mobile layout unreachable:
//
//   {..., "data-app-shell-frame":!0, "data-app-shell-responsive-sidebar":!1,
//         "data-app-shell-sidebar-open":fe}
//
// Flipping it to "true" activates three declarations the bundle already ships
// behind its own sub-768px media query. React stringifies boolean `data-*`
// props, so the value the stylesheet matches is the string "true".
const RESPONSIVE_SIDEBAR_ATTRIBUTE = 'data-app-shell-responsive-sidebar';

// The sidebar panel's unhashed global class. A tap whose target IS this element
// (rather than a descendant) is a tap on the scrim, because the scrim is this
// element's `::before`.
const LEFT_PANEL_CLASS = 'app-shell-left-panel';

const STYLESHEET_ID = 'codex-host-touch-stylesheet';

// Resolved against this module's own URL rather than written as a path relative
// to the document, because those are not the same place. The relay mounts web/
// under a prefix and serves the bundle's document from the mount root, so a
// document-relative path would ask for a stylesheet nothing serves -- and the
// failure would be a 404 in a network panel nobody is looking at, with the
// mobile layout simply absent. import.meta.url is the one reference that stays
// correct wherever the page itself is served from.
const DEFAULT_STYLESHEET_HREF = new URL('./host-touch.css', import.meta.url).href;

// Where the handle is parked so a second install can find it. Installing twice
// would double every listener and leave the first install's observer running
// after the second one's uninstall, so idempotency is not a nicety here.
const HANDLE_KEY = '__codexHostTouch';

// The MIME the bundle itself names for a text copy. Not a guess and not the
// spec's default: app-initial declares `kEi=\`text/plain\`` (@4556394) and
// hands it to both the Blob and the ClipboardItem key at @4555586, and
// app-shared spells the same string out twice in one expression at @6498085.
// Section 4 resolves its deferred write with exactly this shape, so that what
// lands on the pasteboard is what the bundle would have put there itself.
const CLIPBOARD_TEXT_MIME = 'text/plain';

// How long a primed-but-unclaimed clipboard write is left open before it is
// abandoned. The thing it is waiting for is one MessagePort hop inside this
// same page -- microseconds -- so this is about three orders of magnitude of
// headroom, chosen short rather than generous because an abandoned prime is
// only harmless once it has actually been rejected: a rejected
// `ClipboardItem` promise aborts the write and leaves the pasteboard alone,
// a pending one leaves the engine holding a claim on it.
const GESTURE_COPY_DEADLINE_MS = 500;

// Which taps are allowed to prime a clipboard write.
//
// This is a ROLE gate and not an identity gate, and the reason is worth
// recording because the identity gate is the one you would reach for first.
// Every copy in the renderer is a context-menu descriptor with a stable id --
// `copy-link`, `workspace-file-copy-path`, `copy-browser-tab-url` -- and none
// of those ids reaches the DOM. app-shared @6468167 renders each descriptor as
//
//   (0,w7.jsx)(v7.Item,{disabled:t.enabled===!1,href:t.href,
//     role:t.type===`radio`?`menuitemradio`:`menuitem`,…},t.id)
//
// where `t.id` is the React key and nothing else, so there is no attribute to
// match on. What IS in the DOM is the role: `menuitem` or `menuitemradio`
// here, `menuitemcheckbox` from the CheckboxItem branch a few hundred bytes
// earlier (the role itself at @833854), plus the ordinary buttons the share
// dialogs use. Matching the localised label text instead was rejected -- the
// i18n catalogs are per-locale chunks, so that gate would hold in English and
// fail silently in every other language.
const COPY_ACTIVATION_SELECTOR = '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],button,[role="button"]';

/**
 * Adapts the live renderer for a touch device.
 *
 * Idempotent: a second call returns the handle from the first and installs
 * nothing. The returned handle's `uninstall()` reverts only what this call
 * actually changed -- a class it did not add stays, an attribute that already
 * read "true" is left as it was found.
 *
 * @param {object} options
 * @param {object} options.window          the window to adapt; injected rather
 *                                         than read from the global so that the
 *                                         tests, which have no DOM, can pass a
 *                                         fake.
 * @param {string} [options.stylesheetHref] href for web/host-touch.css; pass
 *                                          null to skip the link entirely when
 *                                          the page already carries it.
 * @param {(kind: string, detail: object) => void} [options.onEvent] observer for
 *                                          what was and was not applied.
 */
export function installHostTouch(options = {}) {
  const { window: win, stylesheetHref = DEFAULT_STYLESHEET_HREF, onEvent = null } = options;

  if (!win || typeof win !== 'object') {
    throw new TypeError('installHostTouch: a window is required');
  }

  const existing = win[HANDLE_KEY];
  if (existing) {
    existing.noteRedundantInstall();
    return existing;
  }

  const doc = win.document;
  if (!doc || typeof doc !== 'object') {
    throw new TypeError('installHostTouch: window.document is required');
  }

  const root = doc.documentElement;
  if (!root || typeof root !== 'object') {
    throw new TypeError('installHostTouch: window.document.documentElement is required');
  }

  const stats = {
    redundantInstalls: 0,
    framesAdapted: 0,
    reassertions: 0,
    scrimTaps: 0,
    framesForgotten: 0,
    panelTapsIgnored: 0,
    posted: 0,
    // Section 4. `plainCopiesRefused` is the measurement that arms the rest of
    // them: until it moves, nothing below this line does anything at all.
    plainCopiesRefused: 0,
    gesturePrimes: 0,
    gesturePrimesRefused: 0,
    gesturePrimesAbandoned: 0,
    gestureCopies: 0,
  };

  // Mirrors the reporting discipline of the other host modules: an observer is
  // a diagnostic, so one that throws must not be able to take down the thing it
  // is observing. Nothing downstream depends on report() succeeding.
  const report = (kind, detail) => {
    if (typeof onEvent !== 'function') return;
    try {
      onEvent(kind, detail);
    } catch {
      // Swallowed deliberately. See above.
    }
  };

  let active = true;

  // --- outbound-to-renderer: how a host message actually gets delivered -----

  // The renderer listens for inbound host messages on `window.message` and its
  // only sender check is that the event's `source` is this window, which a
  // same-page postMessage satisfies. `'/'` is not a path: it is the literal
  // targetOrigin meaning "this document's own origin", so this cannot post
  // wider than the page it came from and needs no reference to location.
  const post = (message) => {
    stats.posted += 1;
    report('posted', { type: message.type });
    win.postMessage(message, '/');
    return message;
  };

  const requireNonEmptyString = (value, label) => {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`installHostTouch: ${label} must be a non-empty string`);
    }
    return value;
  };

  // Validated rather than forwarded, because of the no-`default:` switch: a
  // `delta` of undefined reaches a handler that does arithmetic on it and the
  // result is a NaN font size, with no exception anywhere to point at the call
  // site. Failing loudly here is the only place the mistake is still visible.
  const requireFiniteNumber = (value, label) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`installHostTouch: ${label} must be a finite number`);
    }
    return value;
  };

  // The affordance layer. Every helper is one inbound message; the point of
  // wrapping them is the payload shapes, which are not guessable and are not
  // uniform.
  const remote = {
    // Drives the same atom the sidebar's own toggle button drives, which is
    // also the atom web/host-touch.css reads through
    // `data-app-shell-sidebar-open`. Note the hyphenated TYPE is distinct from
    // the `toggleSidebar` registered COMMAND id; both exist and they are not
    // interchangeable.
    toggleSidebar: () => post({ type: TOUCH_INBOUND.toggleSidebar }),

    focusComposer: () => post({ type: TOUCH_INBOUND.focusComposer }),

    // `query` is genuinely optional and the two cases are different code
    // paths in the handler, not one path with a default: with a query it
    // opens, sets the text, selects it and suppresses the default view; with
    // no query it toggles. So an explicit empty string is a meaningful
    // argument and must not collapse into "absent".
    commandMenu: (query) =>
      post(query === undefined ? { type: TOUCH_INBOUND.commandMenu } : { type: TOUCH_INBOUND.commandMenu, query }),

    // The payload key is `path`, not `route` or `url`. Measured call shape:
    // `{type:'navigate-to-route', path:'/settings'}`.
    navigateToRoute: (path) => post({ type: TOUCH_INBOUND.navigateToRoute, path: requireNonEmptyString(path, 'path') }),

    // `delta` is in PIXELS, clamped by the renderer to SANS_FONT_SIZE_RANGE
    // (the code font has its own wider range). Mentioned because the next
    // helper's delta is not in the same unit.
    stepFontSize: (delta) => post({ type: TOUCH_INBOUND.stepFontSize, delta: requireFiniteNumber(delta, 'delta') }),

    // `delta` is in STEPS, each WINDOW_ZOOM_STEP of zoom, clamped to
    // WINDOW_ZOOM_RANGE. `stepWindowZoom(1)` is one notch, not a doubling.
    stepWindowZoom: (delta) => post({ type: TOUCH_INBOUND.stepWindowZoom, delta: requireFiniteNumber(delta, 'delta') }),

    resetWindowZoom: () => post({ type: TOUCH_INBOUND.resetWindowZoom }),

    // The widest lever in the inbound surface: it looks the id up in the
    // renderer's command registry and runs it, which is how a phone reaches
    // actions that otherwise only have a keyboard shortcut. An unknown id is
    // silently ignored, like every other unmatched inbound message.
    runCommand: (id) => post({ type: TOUCH_INBOUND.runCommand, id: requireNonEmptyString(id, 'id') }),
  };

  // --- 1. the stylesheet ----------------------------------------------------

  // Injected from here, rather than being a <link> in the page, because the
  // page we serve the bundle through is generated and not ours to edit. The id
  // check means a page that does grow a <link> later does not get a second
  // copy.
  let link = null;
  if (stylesheetHref && typeof doc.createElement === 'function' && doc.head) {
    const found = typeof doc.getElementById === 'function' ? doc.getElementById(STYLESHEET_ID) : null;
    if (found) {
      report('stylesheet-already-present', { href: stylesheetHref });
    } else {
      link = doc.createElement('link');
      link.setAttribute('id', STYLESHEET_ID);
      link.setAttribute('rel', 'stylesheet');
      link.setAttribute('href', stylesheetHref);
      doc.head.appendChild(link);
      report('stylesheet-linked', { href: stylesheetHref });
    }
  }

  // --- 2. the responsive-sidebar attribute ---------------------------------

  // Keyed by element so uninstall can put back exactly what it found,
  // including "there was no attribute".
  //
  // A WeakMap is the obvious way to bound this and it is not available:
  // uninstall() has to ITERATE these entries to restore them, and a WeakMap is
  // deliberately not iterable. So the bound is enforced instead of asserted.
  // The previous comment here claimed the map "is bounded by the number of
  // shell frames the renderer ever mounts, which is one" -- a claim about
  // React, held by a Map that strongly retains every key, in a module whose
  // whole premise is that React remounts things underneath us.
  // forgetDetachedFrames() turns the bound into a property of the map instead:
  // a frame the document no longer contains is dropped, together with the
  // detached element itself, on the next observer delivery.
  const previousResponsiveSidebar = new Map();

  // `isConnected === false` rather than `!frame.isConnected`, because a test
  // double has no `isConnected` at all and `undefined` has to mean "cannot
  // tell", not "detached". Deleting from a Map while iterating its keys is
  // defined behaviour; an entry removed before the iterator reaches it is
  // simply not visited.
  const forgetDetachedFrames = () => {
    for (const frame of previousResponsiveSidebar.keys()) {
      if (frame?.isConnected === false) {
        previousResponsiveSidebar.delete(frame);
        stats.framesForgotten += 1;
      }
    }
  };

  const adaptFrames = () => {
    if (!active) return;
    forgetDetachedFrames();
    if (typeof doc.querySelectorAll !== 'function') return;

    for (const frame of doc.querySelectorAll(FRAME_SELECTOR)) {
      if (typeof frame.getAttribute !== 'function' || typeof frame.setAttribute !== 'function') continue;

      const current = frame.getAttribute(RESPONSIVE_SIDEBAR_ATTRIBUTE);
      // Re-entrancy guard as much as an optimisation: our own write is itself
      // a mutation the observer below will be told about, and without this
      // early return the two would feed each other.
      if (current === 'true') continue;

      if (!previousResponsiveSidebar.has(frame)) {
        previousResponsiveSidebar.set(frame, current);
        stats.framesAdapted += 1;
      } else {
        stats.reassertions += 1;
      }

      frame.setAttribute(RESPONSIVE_SIDEBAR_ATTRIBUTE, 'true');
      report('responsive-sidebar-enabled', { previous: current });
    }
  };

  adaptFrames();

  // The frame usually does not exist yet when this runs -- React has not
  // mounted it -- and when it does exist, React owns the attribute and will
  // write its hardcoded `false` back over ours on any re-render that touches
  // the frame's props. So a one-shot write is not enough in either direction,
  // and an observer is the only mechanism that covers both: it catches the
  // frame appearing and it catches React reverting us.
  let observer = null;
  if (typeof win.MutationObserver === 'function') {
    observer = new win.MutationObserver(adaptFrames);
    // `attributeFilter` implies attributes, and narrowing to the one attribute
    // we care about is what keeps a subtree observer on the whole document
    // from being handed every attribute write in a React application.
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributeFilter: [RESPONSIVE_SIDEBAR_ATTRIBUTE],
    });
    report('observer-started', {});
  } else {
    report('observer-unavailable', {});
  }

  // --- 3. the scrim tap ----------------------------------------------------

  // web/host-touch.css renders the scrim as the sidebar panel's own
  // `::before`, so a tap on the dimmed area reports the panel itself as the
  // event target while a tap on anything in the sidebar reports a descendant.
  // Doing it this way means there is no element of ours inside React's tree to
  // be reconciled away, and no second listener to attach when the panel
  // remounts: one capture-phase listener on the document covers every mount for
  // the life of the page.
  //
  // IT IS NOT THE WHOLE TEST, THOUGH, AND THIS COMMENT USED TO SAY IT WAS.
  // The panel is the event target for two different regions, because a
  // pseudo-element is not an event target: the scrim outside the drawer, and
  // the drawer's own chrome wherever no child covers it. The stylesheet gives
  // the open drawer
  // `padding-block-end: calc(env(safe-area-inset-bottom) / var(--codex-window-zoom))`,
  // which on an iPhone is a strip up to 34px tall across the bottom of the
  // drawer that is unambiguously inside the sidebar and closed it anyway. The
  // one thing that distinguishes the two regions is where the tap landed, so
  // the point is compared against the panel's own border box.
  //
  // `getBoundingClientRect()` and `clientX`/`clientY` are both in the client
  // coordinate space, so the frame's inline `zoom` scales both and the
  // comparison needs no correction for it.
  //
  // A tap we cannot locate -- an element with no layout, a non-finite
  // coordinate, a collapsed rect -- is treated as a scrim tap, which is the
  // behaviour this module shipped with and the one that keeps the drawer
  // closable rather than stuck.
  const tappedInsidePanel = (panel, event) => {
    if (typeof panel.getBoundingClientRect !== 'function') return false;
    const x = event.clientX;
    const y = event.clientY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const rect = panel.getBoundingClientRect();
    if (!rect) return false;
    if (!(rect.right - rect.left > 0) || !(rect.bottom - rect.top > 0)) return false;
    return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
  };

  const onDocumentPointerTap = (event) => {
    if (!active) return;

    // Section 4 rides this listener instead of adding its own. It wants the
    // same event, in the same phase, on the same node: a capture-phase click on
    // the document, which is the last moment before React's delegated handler
    // reaches the menu item and calls its onSelect. A second listener for the
    // same event on the same node would buy nothing and give uninstall a second
    // thing to get right.
    primeGestureCopy(event);

    const target = event?.target;
    if (!target || typeof target !== 'object') return;
    const targetClasses = target.classList;
    if (!targetClasses || typeof targetClasses.contains !== 'function') return;
    if (!targetClasses.contains(LEFT_PANEL_CLASS)) return;

    // The media query is the one value here that genuinely has to be computed:
    // the scrim only exists under MOBILE_MEDIA_QUERY, and on a wide viewport
    // this same target is the panel's ordinary padding, where closing the
    // sidebar would be a surprise.
    if (typeof win.matchMedia !== 'function') return;
    if (!win.matchMedia(MOBILE_MEDIA_QUERY).matches) return;

    if (tappedInsidePanel(target, event)) {
      stats.panelTapsIgnored += 1;
      report('panel-tap-ignored', {});
      return;
    }

    stats.scrimTaps += 1;
    report('scrim-tap', {});
    remote.toggleSidebar();
  };

  let tapListenerAttached = false;
  if (typeof doc.addEventListener === 'function') {
    doc.addEventListener('click', onDocumentPointerTap, true);
    tapListenerAttached = true;
  }

  // --- 4. the clipboard write, which has to happen inside the tap ----------

  // THE DEFECT, AND WHY IT IS NOT FIXABLE IN THE HOST STUB
  //
  // TWENTY-FOUR CALL SITES, ELEVEN OF THEM THROUGH THE HOST. An earlier
  // version of this comment said six, which was the number visible from the
  // paths that had been read at the time rather than a census. A sweep of
  // every non-locale `/webview/assets/*.js` for `.clipboard.writeText(`,
  // printing the receiver with each hit, returns 24. Thirteen call
  // `navigator.clipboard` directly and are page-local, so their write already
  // happens inside their own gesture and they were never broken; the other
  // ELEVEN go through the host services proxy and every one of them was:
  //
  //   app-initial @2171277  `copy-link`             menu descriptor
  //   app-initial @5388592  workspace-file-copy-path  menu descriptor
  //   app-initial @5602420  copy-browser-tab-url      menu descriptor
  //   app-initial @8183274  share dialog button
  //   app-initial @4555586  `DEi`                   unreachable, see the end
  //   app-shared  @6497890  `Cxi`                   the failure handler itself
  //   dialog-2c0ea6e3adfc @70911  file-library share
  //   dialog-84b39b1e3ee8 @35497  the same shape as @8183274
  //   global-dictation-page @13227, @17483
  //   share-thread @25369     the only one with a browser fallback of its own
  //
  // The first three are one line each. app-initial @2171277:
  //
  //   {id:`copy-link`,...,onSelect:()=>{Se.clipboard.writeText(s).catch(()=>Nn(s))}}
  //
  // and @5388592 and @5602420 have the same shape. @8183274 is a dialog
  // button rather than a menu item -- `await Se.clipboard.writeText(
  // e.action.url),a(`copied`)` reached from `p=e=>{e.preventDefault(),
  // e.stopPropagation(),i!==`copying`&&s()}` (@8184947) -- but it is the same
  // story: synchronous, inside the gesture.
  //
  // The count matters for one reason and not for another. It does not change
  // the design: all eleven funnel through the patched
  // `navigator.clipboard.writeText`, so the fix covers sites nobody had read
  // when it was written. It matters because a number in a comment in this repo
  // is evidence, and an uncounted one invites the next reader to trust a floor
  // as a total.
  //
  // `Se` is the host services proxy, so none of those is a clipboard write. It
  // is a capnweb message across a MessagePort, and the implementation it
  // reaches -- web/host-namespaces.mjs's `clipboard.writeText`, which resolves
  // `globalThis.navigator?.clipboard` at call time -- runs in a FRESH TASK.
  // Chromium's transient activation survives that hop (~5s window). WebKit's
  // does not work that way at all: it requires the clipboard write to be
  // ISSUED while the gesture is still being processed, so on iOS Safari every
  // one of them is refused however fast the hop is. No stub on the far side
  // can repair that, because what was lost is already lost by the time the
  // stub runs. This module runs IN the event, so this is where it goes.
  //
  // WHAT THE RENDERER DOES WITH THE REFUSAL, MEASURED RATHER THAN ASSUMED
  //
  // `Nn` is app-shared's `Cxi` (@6497185), reached as `BS as Nn`. Its string
  // path re-imports the rpc chunk and calls `appServices.clipboard.writeText`
  // AGAIN -- same host, same hop -- so it is not a browser fallback, it is a
  // retry of the thing that just failed. What the user is actually left with
  // is `Sxi` (@6496670): a danger toast, `clipboard.copyError.title`
  // "Couldn't copy to clipboard" / `clipboard.copyError.description` "The
  // content wasn't copied. Try again while ChatGPT is focused".
  //
  // A toast is the whole of it: there is no manual-copy dialog on any of these
  // paths. A search of every non-locale chunk for `anualCopy`, `opyManual`,
  // `copy manually` and `select and copy` returns exactly one hit, and it is
  // not one -- page-7f20e793e6b6.js@64103 is an inline `<p role="alert">` in
  // the merchant-settings panel, `merchantSettings.copyError` "Couldn't copy.
  // Select and copy the value manually.", a different screen that offers no
  // selectable copy of the text and that none of the copy paths above can
  // reach. (web/host-namespaces.mjs's clipboard section says a rejection makes
  // "the app's manual-copy dialog appear"; that part of it is not supported by
  // the bundle, and it is not this task's file to correct.) So "let the app's
  // own recovery UX handle it" would mean handing a phone a toast whose advice
  // is wrong -- the page IS focused, and `Cxi` even logs `hasFocus` next to
  // the failure -- and whose retry runs the same refused call again. That is
  // why this section exists at all.
  //
  // WHAT THIS DOES
  //
  // On the capture-phase click, before React's delegated handler calls
  // onSelect, it issues the clipboard write with data that has not arrived
  // yet: `clipboard.write([new ClipboardItem({'text/plain': promise})])`. The
  // promise-valued ClipboardItem is the one sanctioned way to start a write in
  // the gesture and supply the bytes later, and it is not a shape invented
  // here -- the bundle itself uses it, app-shared @6498085:
  //
  //   let t=e.then(e=>new Blob([e],{type:`text/plain`}));
  //   t.catch(()=>{}),c=r.clipboard.write([new ClipboardItem({"text/plain":t})])
  //
  // including the bare `.catch(()=>{})` on the deferred, which is there for the
  // same reason it is here: an unhandled rejection is a process-level event and
  // this promise is expected to reject whenever a prime goes unclaimed.
  // `writeText` is then patched on the live `navigator.clipboard` so that when
  // the host stub finally calls it, one task later, it resolves THIS write
  // instead of starting a new one.
  //
  // WHY THE PATCH IS ON navigator.clipboard.writeText
  //
  // Because that is the single point every copy funnels through and it is the
  // only one of them we are allowed to touch. host-namespaces.mjs reads the
  // clipboard object at call time, so an own-property patch on the instance is
  // visible to it without changing that file; and share-thread @25369 --
  // `await t.clipboard.writeText(e).catch(()=>(n?.throwIfAborted(),
  // navigator.clipboard.writeText(e)))` -- calls the browser API directly from
  // the page, so the same patch serves the one site that does have a browser
  // fallback, without a second mechanism.
  //
  // WHY ARMING IS A MEASUREMENT AND NOT A USER-AGENT TEST
  //
  // "Does transient activation survive a task hop" has no feature to detect:
  // the only way to ask is to perform a write and see. So this does not ask.
  // It lets the FIRST copy go through plainly, exactly as before, and arms
  // only once a plain write has actually been refused. Chromium never refuses
  // one, so on Chromium `armed` stays false for the life of the page, no tap
  // ever primes anything, and the patched `writeText` is a direct call through
  // to the native method -- the desktop path is not merely intended to be
  // unaffected, it is structurally unreachable. The price is stated in the
  // report: the first copy per page load on iOS Safari still fails.
  //
  // WHY THIS CANNOT TURN INTO A FAKE SUCCESS
  //
  // Nothing here ever resolves a copy it did not perform. The claim path
  // returns the real `write()` promise's outcome; if that write rejects, the
  // rejection is propagated after one honest retry of the plain native call,
  // and the renderer's toast appears exactly as it does today. A prime nobody
  // claims is REJECTED rather than left pending: per spec a rejected
  // ClipboardItem promise aborts the write and leaves the pasteboard
  // unmodified, so an abandoned prime cannot leave a stale value behind.
  //
  // WHAT WAS REJECTED, AND WHY
  //
  //   * Placeholder pre-warm -- copy a placeholder inside the gesture and
  //     overwrite it when the real text arrives. The overwrite is a second
  //     clipboard write issued OUTSIDE the gesture, which is precisely the
  //     operation WebKit refuses; when it loses, the user's pasteboard holds a
  //     string this module invented and the app reports success. That is the
  //     fake success, and it is worse than the visible failure it replaces.
  //   * The legacy synchronous path -- a hidden textarea and
  //     `document.execCommand('copy')`, which the bundle itself still carries
  //     as `VCe` (app-shared @731621, its execCommand at @731967). It is
  //     synchronous, which is the right property, but it needs the text AT
  //     gesture time and the text is the one thing that has not arrived.
  //     execCommand has no deferred form, so it cannot address this defect.
  //   * Intercepting the capnweb send. The text is available synchronously
  //     there, so it would work -- and it is far more powerful than the job
  //     needs. web/host-handshake.mjs records that the renderer creates the
  //     MessageChannel, keeps port1 and posts port2 to its own window, so we
  //     never hold the sending port: intercepting would mean patching
  //     `MessagePort.prototype.postMessage` for the whole page and decoding
  //     capnweb's private, unversioned wire format well enough to tell a
  //     clipboard call from any other call. This patch couples to two
  //     published web APIs instead.
  //
  // WHAT IS STILL BROKEN AFTER THIS
  //
  // app-initial's `DEi` (@4555551, `async function DEi(e){try{return await
  // Se.clipboard.writeText(e),!0}...`) is not reachable from a gesture at all:
  // its only caller is `async function OEi(e,t){let n=await e;return
  // t?.throwIfAborted(),DEi(n)}` (@4556270), so it is already one await past
  // the tap before it starts. Nothing in the page can rescue that one.

  // Resolved once, here, rather than per call: the patch below is installed on
  // this exact object, so reading it again later could only disagree with what
  // was patched.
  const clipboard = win.navigator && typeof win.navigator === 'object' ? win.navigator.clipboard : null;

  // Every capability the prime needs, checked before anything is patched. If
  // any is missing the module leaves `navigator` alone entirely, because an
  // intercept that can never prime is a wrapper that changes nothing and can
  // only add a way to be wrong. `Blob` and `ClipboardItem` are read off the
  // injected window, not the global, for the same reason the rest of this file
  // is: the tests have no DOM.
  const canPrimeGestureCopy = Boolean(
    clipboard
      && typeof clipboard === 'object'
      && typeof clipboard.writeText === 'function'
      && typeof clipboard.write === 'function'
      && typeof win.ClipboardItem === 'function'
      && typeof win.Blob === 'function'
      && typeof win.setTimeout === 'function'
      && typeof win.clearTimeout === 'function',
  );

  // The native method, kept so the common path can still reach it, and whether
  // it was an OWN property -- on a real `navigator.clipboard` it is inherited
  // from `Clipboard.prototype`, so restoring it by assignment would leave an
  // own property where the page had none. Same rule as the attribute in
  // section 2: restoring means restoring absence too.
  let nativeWriteText = null;
  let nativeWriteTextWasOwn = false;
  let clipboardIntercepted = false;

  // False until a plain write has been refused in this page. See above.
  let gesturePrimingArmed = false;

  // The one open prime, or null. At most one: a second qualifying tap abandons
  // the first, because two live claims on the pasteboard would race to decide
  // which text the next `writeText` resolves.
  let pendingPrime = null;

  function armGesturePriming(reason) {
    stats.plainCopiesRefused += 1;
    if (gesturePrimingArmed) return;
    gesturePrimingArmed = true;
    report('gesture-priming-armed', { reason });
  }

  // Rejecting rather than dropping is the whole point: a dropped prime stays
  // pending and the engine keeps its claim on the pasteboard, while a rejected
  // one aborts the write with the pasteboard unmodified.
  function abandonPrime(prime, reason) {
    if (prime.timer !== null) {
      win.clearTimeout(prime.timer);
      prime.timer = null;
    }
    if (pendingPrime === prime) pendingPrime = null;
    prime.reject(new Error(`host-touch: clipboard prime ${reason}`));
    stats.gesturePrimesAbandoned += 1;
    report('gesture-prime-abandoned', { reason });
  }

  // Hoisted on purpose: section 3's listener, which is defined above, calls it.
  function primeGestureCopy(event) {
    if (!active || !clipboardIntercepted || !gesturePrimingArmed) return;

    const target = event?.target;
    if (!target || typeof target !== 'object' || typeof target.closest !== 'function') return;
    if (!target.closest(COPY_ACTIVATION_SELECTOR)) return;

    if (pendingPrime) abandonPrime(pendingPrime, 'superseded');

    let resolveText = null;
    let rejectText = null;
    const text = new Promise((resolve, reject) => {
      resolveText = resolve;
      rejectText = reject;
    });
    const blob = text.then((value) => new win.Blob([value], { type: CLIPBOARD_TEXT_MIME }));
    // See @6498085: the deferred is expected to reject whenever a prime goes
    // unclaimed, and an unhandled rejection is a process-level event.
    blob.catch(() => {});

    let write = null;
    try {
      write = clipboard.write([new win.ClipboardItem({ [CLIPBOARD_TEXT_MIME]: blob })]);
    } catch (error) {
      // A synchronous throw here is the engine saying no before it ever
      // returned a promise. Settle the deferred so it cannot sit pending
      // forever, and leave `writeText` to take the plain path.
      rejectText(error);
      stats.gesturePrimesRefused += 1;
      report('gesture-prime-refused', { reason: 'threw' });
      return;
    }

    if (!write || typeof write.then !== 'function') {
      rejectText(new Error('host-touch: clipboard.write did not return a promise'));
      stats.gesturePrimesRefused += 1;
      report('gesture-prime-refused', { reason: 'not-a-promise' });
      return;
    }
    write.catch(() => {});

    const prime = { resolve: resolveText, reject: rejectText, write, timer: null };
    prime.timer = win.setTimeout(() => {
      prime.timer = null;
      if (pendingPrime === prime) abandonPrime(prime, 'expired');
    }, GESTURE_COPY_DEADLINE_MS);

    pendingPrime = prime;
    stats.gesturePrimes += 1;
    report('gesture-prime', {});
  }

  // The unprimed path, and the one Chromium stays on forever. The native call
  // is made SYNCHRONOUSLY -- no `Promise.resolve().then(...)` wrapper -- because
  // a wrapper would put this call one task after the one that invoked it, which
  // is the exact defect this section is about.
  function plainWriteText(text) {
    const result = nativeWriteText.call(clipboard, text);
    if (!result || typeof result.then !== 'function') return result;
    return result.then(undefined, (error) => {
      armGesturePriming('plain-write-rejected');
      throw error;
    });
  }

  function writeTextThroughGesture(text) {
    if (!active || !pendingPrime) return plainWriteText(text);

    const prime = pendingPrime;
    pendingPrime = null;
    if (prime.timer !== null) win.clearTimeout(prime.timer);
    prime.resolve(text);

    return prime.write.then(
      () => {
        stats.gestureCopies += 1;
        report('gesture-copy', {});
      },
      (error) => {
        // The prime was accepted and then failed. Retry plainly: it is a real
        // write whose real outcome is returned, so the worst case is the
        // rejection the renderer would have got anyway, and the best case is a
        // browser whose gesture is still live getting the copy it asked for.
        report('gesture-copy-failed', { message: typeof error?.message === 'string' ? error.message : '' });
        return plainWriteText(text);
      },
    );
  }

  if (!canPrimeGestureCopy) {
    report('gesture-copy-unsupported', { clipboard: Boolean(clipboard) });
  } else {
    nativeWriteText = clipboard.writeText;
    nativeWriteTextWasOwn = Object.prototype.hasOwnProperty.call(clipboard, 'writeText');
    try {
      clipboard.writeText = writeTextThroughGesture;
    } catch {
      // A frozen or accessor-only clipboard. Nothing to clean up: the
      // assignment either took or it did not.
    }
    // Verified rather than assumed, because assigning over an inherited
    // accessor with no setter fails SILENTLY outside strict mode, and this
    // module is a module, where it throws -- both outcomes land here.
    clipboardIntercepted = clipboard.writeText === writeTextThroughGesture;
    report(clipboardIntercepted ? 'clipboard-intercepted' : 'clipboard-intercept-refused', {});
  }

  const handle = {
    get remote() {
      return remote;
    },
    get stats() {
      return { ...stats };
    },
    get stylesheetLink() {
      return link;
    },
    get installed() {
      return active;
    },
    // Both are observable because they are the two facts a caller cannot infer
    // from the outside: whether `navigator.clipboard.writeText` is ours, and
    // whether a plain write has already been refused in this page.
    get clipboardIntercepted() {
      return clipboardIntercepted;
    },
    get gesturePrimingArmed() {
      return gesturePrimingArmed;
    },
    noteRedundantInstall() {
      stats.redundantInstalls += 1;
      report('redundant-install', { count: stats.redundantInstalls });
    },
    uninstall() {
      if (!active) return;
      active = false;

      if (observer) observer.disconnect();

      if (tapListenerAttached && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('click', onDocumentPointerTap, true);
      }

      for (const [frame, previous] of previousResponsiveSidebar) {
        // Restoring means restoring, including restoring absence: setting
        // "false" where there had been no attribute at all would leave the
        // page in a state this module invented.
        if (previous === null || previous === undefined) {
          frame.removeAttribute?.(RESPONSIVE_SIDEBAR_ATTRIBUTE);
        } else {
          frame.setAttribute?.(RESPONSIVE_SIDEBAR_ATTRIBUTE, previous);
        }
      }
      previousResponsiveSidebar.clear();

      if (link) {
        link.remove?.();
        link = null;
      }

      // Order matters: abandon first, so the open write is aborted while the
      // patched `writeText` -- the only thing that could still have claimed it
      // -- is still in place.
      if (pendingPrime) abandonPrime(pendingPrime, 'uninstalled');

      if (clipboardIntercepted && clipboard.writeText === writeTextThroughGesture) {
        try {
          // `delete` first for the real browser case, where `writeText` lives
          // on `Clipboard.prototype` and an own copy is something this module
          // would be leaving behind. Assignment is the fallback for the case
          // the page genuinely did have its own.
          if (nativeWriteTextWasOwn) clipboard.writeText = nativeWriteText;
          else delete clipboard.writeText;
        } catch {
          clipboard.writeText = nativeWriteText;
        }
        clipboardIntercepted = false;
        report('clipboard-restored', {});
      }

      if (win[HANDLE_KEY] === handle) delete win[HANDLE_KEY];
      report('uninstalled', {});
    },
  };

  win[HANDLE_KEY] = handle;
  return handle;
}
