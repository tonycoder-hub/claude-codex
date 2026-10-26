// Window focus: the one piece of Electron window management a browser tab
// actually has, and the only unclaimed outbound type whose silence is a hang.
//
// The renderer asks `electron-window-focus-request` from three mount effects
// and main answers every one of them with `electron-window-focus-changed`. The
// request carries no id, arms no timeout and files no pending entry, so by the
// usual test -- "does anything await this?" -- it looks like a push that can be
// dropped. That test is wrong here, and the reason is the atom the reply feeds:
//
//   function xvn(){return null}
//   Zk=rn(q,xvn,{getServerSnapshot:()=>null, onMount:e=>{}})   app-initial@2068333
//
// `null`, not `false`, with exactly one writer -- `MCs(store,isFocused)`,
// app-initial@8820917, reachable only from the subscribers to the reply. Every
// reader tests `=== true`. So with no reply the page is not "assumed focused",
// it is permanently neither, and two first-run onboarding paths stop with no
// timeout behind either: `Rm`'s logo splash never wires `onContinue`
// (onboarding-page@150761, gate `f=u||!c` with `u=q(_r)===!0`), and `vBs`
// renders a static "Thinking" label instead of mounting the component that
// calls `onComplete` (app-initial@9145721) -- whose own `loadingTimeoutSeconds`
// escape hatch is inside that unmounted component and therefore never arms.
//
// WHY THAT WAS NOT CAUGHT BY A DRIVE. An already-onboarded user never reaches
// the `onboarding-page` lazy route, so a relay that answers nothing here still
// paints a complete home screen. A missing answer, a page that looks right,
// every check green: the house failure shape, and the reason this module
// exists rather than a comment filing the type under "Electron-only".
//
// THE HALF THAT MATTERS ON A PHONE, and it is not onboarding. The renderer
// hands TanStack Query's focus manager its own event source:
//
//   function Pvc(){IGe.setEventListener(Fvc)}                  app-initial@10008777
//   function Fvc(e){let t=_s.subscribe(`electron-window-focus-changed`,
//     t=>{let{isFocused:n}=t; return e(n)});
//     return _s.dispatchMessage(`electron-window-focus-request`,{}),t}
//
// `setEventListener` REPLACES the library's default `visibilitychange`
// listener. A host that answers the initial request and then goes quiet has
// therefore made things worse than not answering: refetch-on-focus is now wired
// to a source that never fires, and a phone backgrounds its browser constantly.
// So this module pushes for the life of the page, not once.
//
// WHAT IT DELIBERATELY DOES NOT DO.
//
//   No clock of its own. `occurredAtMs` is stamped from an injected `now` so a
//   test pins the field rather than tolerating it, and the default is the one
//   `Date.now()` in the file.
//
//   No initial unsolicited push. The renderer asks on mount, from all three
//   sites, and an unsolicited message before its subscriber exists is dropped
//   on the floor -- this type is not one of the three the renderer buffers.
//
//   No synthesised `true`. If the browser says the page is not focused then it
//   is not, and the renderer recovers the moment it is. A host that lied here
//   to get past the splash would also be telling the query layer to refetch
//   while the tab is in the background.

import {
  OUTBOUND,
  inboundElectronWindowFocusChanged,
} from './host-protocol.mjs';

/**
 * Read focus the way main computes it, out of what a browser exposes.
 *
 * Main's expression is `!isSystemSuspended && !isScreenLocked &&
 * window.isFocused() === true`. A tab cannot see suspend or screen lock, and
 * `document.hidden` is the closest thing it has to both: a locked phone hides
 * every tab. `hasFocus()` is the direct analogue of `isFocused()`.
 *
 * Both halves are kept even though `hasFocus()` is already false in a hidden
 * tab in every browser measured, because the fallback below is the case this
 * is really written for. An embedding with no `hasFocus` -- the member is
 * optional in principle and absent in some test doubles -- degrades to
 * visibility alone rather than to a hard `false`, because a hard `false` is the
 * answer that strands the splash, and visibility alone is a true statement
 * about a page that is on screen.
 *
 * A throw is treated as "not focused". It is the conservative direction: the
 * renderer corrects it on the next real focus event, whereas a thrown error out
 * of a window listener is swallowed by the bus and leaves nothing behind.
 */
export function readWindowFocus(window) {
  try {
    const document = window?.document ?? null;
    if (document === null) return false;
    const visible = document.visibilityState === undefined
      ? true
      : document.visibilityState !== 'hidden';
    if (typeof document.hasFocus !== 'function') return visible;
    return visible && document.hasFocus() === true;
  } catch {
    return false;
  }
}

/**
 * The focus layer.
 *
 * `deliver` is injected for the same reason web/host-fetch.mjs takes one: the
 * bus exposes typed emitters for the app-server lifecycle and this is not that,
 * so routing through `bus.deliver` keeps `bus.stats.emitted` a true count of
 * what reached the renderer.
 *
 * @param {{window: object, deliver: (message: object) => void,
 *          now?: () => number, onEvent?: (kind: string, detail: object) => void}} options
 */
export function createHostFocus({ window, deliver, now = () => Date.now(), onEvent } = {}) {
  if (!window || typeof window.addEventListener !== 'function') {
    throw new TypeError('createHostFocus: a window with addEventListener is required');
  }
  if (typeof deliver !== 'function') {
    throw new TypeError('createHostFocus: deliver must be a function');
  }

  const stats = {
    requestsAnswered: 0,
    pushed: 0,
    unchanged: 0,
    deliverFailures: 0,
    observerFailures: 0,
  };

  /**
   * The last value the renderer was TOLD, which is not the last value read.
   *
   * `null` until something has been sent, so the first answer always goes out
   * even when it agrees with the initial reading -- the renderer has nothing
   * yet, and `null` is exactly the state its atom is stuck in.
   */
  let lastSent = null;

  const note = (kind, detail) => {
    if (typeof onEvent !== 'function') return;
    try {
      onEvent(kind, detail ?? {});
    } catch {
      stats.observerFailures += 1;
    }
  };

  const send = (isFocused) => {
    const message = isFocused
      ? inboundElectronWindowFocusChanged({ isFocused: true })
      : inboundElectronWindowFocusChanged({ isFocused: false, occurredAtMs: now() });
    try {
      deliver(message);
    } catch (error) {
      // Swallowed rather than thrown: these run from a window listener, where
      // a throw is swallowed anyway and the only trace left is nothing at all.
      stats.deliverFailures += 1;
      note('deliver-failed', { isFocused, reason: error?.message ?? String(error) });
      return;
    }
    lastSent = isFocused;
    stats.pushed += 1;
    note('pushed', { isFocused });
  };

  /** A request is answered unconditionally, the way main answers it. */
  const answerRequest = () => {
    stats.requestsAnswered += 1;
    send(readWindowFocus(window));
  };

  /**
   * An observed transition, sent only when it is one.
   *
   * `focus`, `blur` and `visibilitychange` overlap -- backgrounding a tab fires
   * at least two of them -- and the renderer's subscribers are not all
   * idempotent: the focus-duration span at app-initial@8820278 opens on a
   * `true` it has no span for and closes on a `false`, so a duplicated `true`
   * is a lost span and a duplicated `false` is a close with no open.
   */
  const observed = () => {
    const isFocused = readWindowFocus(window);
    if (isFocused === lastSent) {
      stats.unchanged += 1;
      return;
    }
    send(isFocused);
  };

  const document = window.document ?? null;
  const listeners = [
    [window, 'focus', observed],
    [window, 'blur', observed],
    ...(document && typeof document.addEventListener === 'function'
      ? [[document, 'visibilitychange', observed]]
      : []),
  ];
  for (const [target, event, handler] of listeners) target.addEventListener(event, handler);

  return {
    /** The one outbound type this layer claims. */
    type: OUTBOUND.electronWindowFocusRequest,

    /** Subscribe to the request on a bus. Separate from construction so the
     * listeners above are installed even for a caller driving this by hand. */
    attach(bus) {
      if (!bus || typeof bus.on !== 'function') {
        throw new TypeError('createHostFocus: attach needs a bus with on()');
      }
      bus.on(OUTBOUND.electronWindowFocusRequest, answerRequest);
      return this;
    },

    /** What a browser currently says, with no side effect. */
    read() {
      return readWindowFocus(window);
    },

    /** Answer as though the renderer had just asked. */
    answer: answerRequest,

    /** Re-read and push if it changed, as a DOM event would. */
    refresh: observed,

    stats() {
      return { ...stats, lastSent };
    },

    uninstall() {
      for (const [target, event, handler] of listeners) {
        try {
          target.removeEventListener(event, handler);
        } catch {
          // A target that is already gone. Nothing left to detach from.
        }
      }
    },
  };
}
