// The host service namespaces the renderer dereferences off `await services`.
//
// NOT TO BE CONFUSED WITH web/host-services.mjs, which is the bus layer that
// answers `something-v1` persisted-atom messages. That one is named for the
// renderer's message types; this one is named for the capnweb object. They
// meet nowhere.
//
// WHAT THIS IS FOR
//
// The renderer resolves `services` once, early, keeps it as a module singleton
// (`i6` in app-shared, imported as `Se` in app-initial and under a different
// local alias in every lazy chunk) and then dereferences it for the rest of
// the session. The authoritative list of what it may dereference is not in
// the renderer chunks at all -- it is the registry the MAIN process builds,
// `.vite/build/main-C3nRcJ3D.js` @3247383..@3256150, and it has 125 top-level
// namespaces. This module serves 7 of them.
//
// Of the other 118, 98 are never dereferenced bare anywhere in the shipped
// renderer, and the remaining 20 are null-guarded at every one of their 29
// call sites:
//
//   Se.hostedThreadFiles == null ? void 0 : o          // degrades, correctly
//
// and for those, serving nothing is not a compromise -- it is the right answer,
// and it stays the right answer. Every namespace absent from this module reads
// as `undefined` in the page, every guard fails, and the app takes its
// host-absent path. That is why this module serves a SHORT list and why
// growing it speculatively would be a mistake: adding a namespace flips 1-N
// guards from "no host" to "host present", and the code behind those guards
// expects a host that can actually do the thing.
//
// All 118 omissions have been checked, not assumed. The 29 bare sites were
// read one at a time, and the guard is almost never the `?.` a text sweep can
// see -- it sits one level up, on the NAMESPACE:
//
//   if (Se?.threadMetadata == null) throw Error(`Task emoji editing is
//       unavailable`)                                     // app-initial @3611816
//   !t && Se?.inAppBrowserIncompleteNavigation != null && (t = !0, ...)
//                                                         // app-initial @9509196
//   i6?.settings == null ? (await HW(`get-setting`, ...)).value ?? e.default
//                        : (await i6.settings.read(e.key)).effective
//                                                         // app-shared  @3465648
//
// Two of those are worth knowing about beyond this file, because their
// host-absent branch is not a degrade -- it is an HTTP call. `settings`
// read/write falls through to the `get-setting`/`set-setting` endpoints and
// `executionPaths.readCodexHome` to `codex-home`, all three of which
// web/host-fetch.mjs already answers. Omitting those namespaces is what ROUTES
// settings through the fetch layer, where they actually persist; serving them
// here would take that away.
//
// So a sweep that reports a bare `alias.ns.member` read reports a candidate,
// not a finding. Run it, then read every hit.
//
// 8 namespaces are read with no guard at any level. Those are the whole reason
// this file exists. Classifying each site by whether the NAMESPACE (not the
// method) is protected found exactly these:
//
//   appInfo, clipboard, customAvatars, fileAttachments, openIn,
//   requestUserInputAutoResolution, startup, workspaceFiles
//
// For each of them an undefined namespace is a TypeError, and where the read
// sits inside a layout effect that TypeError takes the React commit with it.
// Which is what happened: a driven turn completed on the wire -- the agent
// reply arrived intact, `turn/completed` status `completed` -- and the page
// then died rendering it on
//
//   Se.requestUserInputAutoResolution.setConversationPresented?.({...})
//
// because the `?.` guards the method and not the object.
//
// Seven of the eight are served below. `startup` is the exception and is NOT
// served; see the note at the bottom of this file, which is about operator
// precedence and is worth reading before anyone adds it.
//
// THE RULE THIS FILE FOLLOWS
//
// Serve the least-powerful thing that keeps the caller correct, and never
// serve a lie. A stub that claims a file was written or text was copied, when
// it did not and was not, costs the user their work and tells them it is
// saved. Rejecting is almost always better -- these call sites are in promise
// chains and event handlers that have error paths. Where a rejection genuinely
// IS fatal to the caller and an empty success is not, the trade is taken
// explicitly and said out loud at that member.
//
// A corollary that decides most of the choices here: AN OMITTED MEMBER IS A
// STRONGER ANSWER THAN A REJECTING ONE. The bundle was written against an
// Electron host whose methods genuinely come and go with the platform and the
// build, so it already contains a correct branch for almost every absent
// member -- an icon instead of a thumbnail, a browser download instead of a
// host save, a checkbox that is not offered. Omission selects that branch.
// Serving a member that can only ever reject replaces "this host cannot do
// that", which the app handles, with "this host tried and failed", which it
// mostly only logs. So a member appears below only when there is a call site
// that would break without it, or when its value is something we genuinely
// know.
//
// WHY A CALLABLE MEMBER REACHES THE PAGE AT ALL
//
// A function cannot be structure-cloned, so serving one means serving a
// capnweb capability -- `['export', id]` -- and trusting the renderer to turn
// that back into something callable. Three things had to be true for that, and
// all three were read out of app-shared-59042e7300f7.js rather than assumed:
//
//   1. The evaluator RECURSES INTO OBJECT PROPERTIES, so an export tag nested
//      inside the resolved `services` is evaluated, not left as a literal
//      two-element array (@2197035):
//
//        if (t instanceof Object) { let e = t; for (let t in e)
//          (t in Object.prototype || t === 'toJSON')
//            ? (this.evaluateImpl(e[t], e, t, i+1), delete e[t])
//            : e[t] = this.evaluateImpl(e[t], e, t, i+1); return e }
//
//   2. An export tag becomes a CALLABLE STUB (@2196914):
//        case 'export': … { let e = this.importer.importStub(t[1]);
//                           this.hooks.push(e); return new xI(e) }
//
//   3. A NEGATIVE id survives the lookup. `imports` is an Array (@2200327) and
//      `importStub` does `this.imports[e]` / `this.imports[e] = t` -- on an
//      array a negative index is an ordinary string property, so it round
//      trips. This is not luck: the renderer's own exporter allocates from
//      `nextExportId = -1` counting down, and its own `getExport` indexes the
//      same way, so negative ids are the convention on both sides.
//
// WHY EACH MEMBER IS EXPORTED SEPARATELY, AND NOT THE NAMESPACE AROUND IT
//
// Because of what (2) returns. `xI` is a Proxy whose `get` handler never
// consults its target (@2171311, `RBt`):
//
//   get(e,t,n){ let r=e.raw; if(t===bI)return r;
//     if(t in SI.prototype)return r[t];
//     if(typeof t===`string`) return new SI(r.hook,
//       r.pathIfPromise?[...r.pathIfPromise,t]:[t]); … }
//   ownKeys(e){return[]}
//
// So every string property of an imported stub is a fresh non-null, truthy,
// thenable `SI`. A namespace handed over as ONE capability therefore has no
// absent members in the page: `ns.write != null` passes for a `write` nobody
// implemented, `ns.saveCopy?.()` stops short-circuiting, and the renderer's
// own host-absent branches become unreachable. web/host-capnweb.mjs
// `devaluate` therefore exports each callable WHERE IT SITS and leaves the
// plain object around it plain. That is what makes the paragraph about
// omission above true rather than aspirational, and this module depends on it:
// if that encoding is ever changed back, every omitted member below silently
// becomes a lie.
//
// AND THE TRAP IN (1)
//
// A property whose name is an `Object.prototype` member -- `toString`,
// `valueOf`, `constructor`, `hasOwnProperty`, … -- or `toJSON` is EVALUATED
// AND THEN DELETED. It would arrive as `undefined` with no error on either
// side: our logs would show it served, the page would show it missing, and
// nothing would connect the two. This applies to member names as much as to
// namespace names, because the evaluator recurses. None of the names below
// collide; `assertServable` makes that a failed test rather than a silent hole
// if that ever changes.

// The three pieces of the App's `workspaceFiles.read` contract that are pure
// functions of bytes: what an etag is, which representation `auto` picks, and
// how a blob is spelled on the wire. The filesystem they read is injected, not
// imported -- see `files` on createHostNamespaces.
import { encodeBase64, etagFor, isTextBytes } from './host-files.mjs';

/** @typedef {{kind: string, [k: string]: unknown}} NamespaceEvent */

/**
 * Refuse a shape the renderer would mangle, and one we would mangle ourselves.
 *
 * Three checks, each for a failure that is invisible from this side:
 *
 *   1. A namespace or member named after an `Object.prototype` member, or
 *      `toJSON`: evaluated and then deleted by the peer (see the trap note).
 *   2. A callable at the TOP level. `services.foo = () => {}` would make
 *      `Se.foo` a stub rather than a namespace, and every `Se.foo.bar` in the
 *      page would then be a pipelined call to a member that does not exist.
 *   3. A member that is neither callable nor a plain value we meant to send.
 *      A nested object two levels down is not a namespace shape the renderer
 *      expects, and getting it wrong shows up as a `no such member` three
 *      frames later.
 *
 * Throws rather than warns, because a warning here is a warning nobody sees
 * until a user hits the one screen that touches the member.
 *
 * @param {object} services
 * @returns {object} the same object, for use as an expression
 */
export function assertServable(services) {
  const reserved = (name) => name === 'toJSON' || name in Object.prototype;

  for (const [name, namespace] of Object.entries(services)) {
    if (reserved(name)) {
      throw new TypeError(
        `host namespace '${name}' collides with Object.prototype and would be deleted by the renderer's evaluator`,
      );
    }
    if (typeof namespace === 'function') {
      throw new TypeError(
        `host namespace '${name}' is callable; a namespace must be a plain object so that its absent members read as undefined`,
      );
    }
    if (namespace === null || typeof namespace !== 'object') {
      throw new TypeError(`host namespace '${name}' must be a plain object, got ${typeof namespace}`);
    }
    for (const member of Object.keys(namespace)) {
      if (reserved(member)) {
        throw new TypeError(
          `host member '${name}.${member}' collides with Object.prototype and would be deleted by the renderer's evaluator`,
        );
      }
    }
  }
  return services;
}

/**
 * Build the object the capnweb handshake serves as `services`.
 *
 * Returns the services object separately from its stats, because everything on
 * the services object becomes a namespace the renderer can see: a `stats` key
 * here would show up in the page as `Se.stats`, which is both wrong and the
 * kind of wrong that only surfaces as someone else's confusing bug report.
 *
 * @param {{
 *   onEvent?: ((event: NamespaceEvent) => void) | null,
 *   appInfo?: {version?: string, buildNumber?: string, buildFlavor?: string, appName?: string} | null,
 * }} [options]
 * @returns {{services: object, stats: () => object}}
 */
export function createHostNamespaces({ onEvent = null, appInfo = null, files = null } = {}) {
  const calls = Object.create(null);

  const report = (kind, detail) => {
    if (typeof onEvent !== 'function') return;
    try {
      onEvent({ kind, ...detail });
    } catch {
      // An observer that throws must not take a host call down with it.
    }
  };

  /** Count every call, so an unexercised stub is distinguishable from a wrong one. */
  const counted = (name, fn) => (...args) => {
    calls[name] = (calls[name] ?? 0) + 1;
    return fn(...args);
  };

  /**
   * A member we must serve and cannot implement.
   *
   * The reason goes in the MESSAGE and not in a `code` property, because a
   * rejection crosses this wire as `{message}` and nothing else --
   * web/host-capnweb.mjs `settle` builds the frame from `err.message` alone,
   * so an own property would be dropped silently on the way out.
   */
  const declines = (name, reason) => counted(name, async () => {
    report('declined', { member: name, reason });
    throw new Error(`${name} is unavailable on this host: ${reason}`);
  });

  // -------------------------------------------------------------------------
  // requestUserInputAutoResolution
  //
  // The host-side feature that auto-answers a pending user-input request after
  // a deadline, unless the user is looking at the conversation or has recently
  // interacted with it. All three members are notifications: every call site
  // discards the return value, none awaits it, so there is no shape to get
  // wrong and no promise to leave unsettled.
  //
  //   setConversationPresented  useLayoutEffect, `{conversationId, hostId,
  //                             presented}`. True on mount, false in the
  //                             cleanup. THIS is the one that crashed the
  //                             page -- a layout effect runs synchronously
  //                             during commit, so a throw there is not a
  //                             logged error, it is the render.
  //
  //   recordConversationActivity  useEffect, from keydown and pointerdown
  //                             listeners, `{conversationId, hostId}`. Gated
  //                             on host-pushed resolution state we never
  //                             push, so the listeners are never attached.
  //                             Served anyway: it is one property, and it is
  //                             on the keystroke path if that gate ever
  //                             opens, so it must stay cheap.
  //
  //   snooze                    an onClick, `{conversationId, hostId,
  //                             requestId}`. Note this one has no `?.` on the
  //                             method either -- but its handler is only
  //                             installed when a scheduled resolutionState
  //                             exists, which requires host state we never
  //                             push, so it is unreachable here.
  //
  // We never auto-resolve anything, so a no-op is both honest and complete.
  // The presented set is kept anyway -- it costs one entry per visible
  // conversation and makes the layer introspectable from a probe, which is
  // how the crash above was found in the first place. Entries are deleted on
  // `presented: false` rather than set to false, so the set stays bounded by
  // what is actually on screen instead of by how many threads were ever
  // opened.
  // -------------------------------------------------------------------------

  /** @type {Set<string>} `hostId\u0000conversationId` of what is on screen */
  const presented = new Set();
  const presentedKey = (arg) => `${arg?.hostId ?? ''}\u0000${arg?.conversationId ?? ''}`;

  const requestUserInputAutoResolution = {
    setConversationPresented: counted('requestUserInputAutoResolution.setConversationPresented', (arg) => {
      const key = presentedKey(arg);
      if (arg?.presented === true) presented.add(key);
      else presented.delete(key);
      report('presented', { presented: arg?.presented === true, count: presented.size });
    }),

    recordConversationActivity: counted('requestUserInputAutoResolution.recordConversationActivity', () => {
      // Nothing to record against: auto-resolution is a host timer and we run
      // none. Counting the call is the entire useful effect.
    }),

    snooze: counted('requestUserInputAutoResolution.snooze', (arg) => {
      // Unreachable in this host -- see the note above. If it ever arrives it
      // means we started pushing resolution state, and this needs a real
      // implementation rather than a quiet success: the user clicked Snooze to
      // stop a timer, and a no-op would let that timer answer a permission
      // prompt on their behalf.
      report('snooze-unexpected', { requestId: arg?.requestId ?? null });
    }),
  };

  // -------------------------------------------------------------------------
  // appInfo
  //
  // One member, `get`, and it is the least optional thing in this file. Every
  // call site reads BOTH the namespace and the method bare:
  //
  //   queryFn: () => i6.appInfo.get()                      (app-shared @5472346)
  //   let r = await n.appInfo.get(); … r.chatGptDesktopAuthOrigin ?? …
  //                                                        (gate.electron @21430)
  //   let i = e && !a ? (await n.appInfo.get()).chatGptDesktopAuthOrigin : …
  //                                                        (login-route @26523)
  //
  // -- so `get` must exist AND must resolve to an object. The last two deref
  // the RESULT bare as well, which is why a rejection is not an option here
  // even though it is elsewhere in this file: it would throw into the checkout
  // flow and into the login redirect. Three further sites `.catch()` the bare
  // return (`y.current = Se.appInfo.get().catch(wWs)`, with
  // `wWs(){return null}`), so it must be a promise and not a plain value.
  //
  // THE RECORD IS PRODUCTION'S OWN SHAPE, field for field. The main process
  // builds it in exactly one place (`.vite/build/main-*.js` @688927):
  //
  //   async get(){ let e=d.t.resolve(); return {
  //     version: m.Xa(m.W()).version, buildNumber: m.Ct.value, buildFlavor: e,
  //     osName: lt(process.platform) ?? null,
  //     systemVersion: typeof process.getSystemVersion===`function`
  //       ? process.getSystemVersion() : null,
  //     appName: g.app.getName(),
  //     chatGptDesktopAuthOrigin: void 0, chatGptApiBaseUrl: void 0,
  //     appIconMedium: await Rce(e), dockIconPreviews: Lce(e),
  //     preloadAttribution: await m.l() } }
  //
  // which settles three things that would otherwise have been guesswork:
  //
  //   - `chatGptDesktopAuthOrigin` and `chatGptApiBaseUrl` are LITERALLY
  //     `undefined` in production -- not null, not absent. Structured clone
  //     preserves an `undefined` object value, so sending them as `undefined`
  //     reproduces the real record exactly, and the consumers' `??` fallbacks
  //     (`'https://chatgpt.com/codex'` in the gate, omission in login-route)
  //     are the designed path rather than a degradation.
  //
  //   - `appIconMedium` and `dockIconPreviews` are null on any platform that
  //     is not darwin -- `Lce` returns null immediately off darwin. Null here
  //     is not a compromise, it is one of the two shapes production ships, and
  //     every consumer is written for it (`a?.dockIconPreviews ?? null`).
  //
  //   - `osName` and `systemVersion` are null in production too whenever
  //     `lt()` does not recognise the platform or `getSystemVersion` is
  //     missing. Which is the honest answer for a relay: they describe the
  //     machine the app runs on, that machine is the resident Mac, and the
  //     page cannot see it. Reporting the phone's browser platform instead
  //     would be a different fact wearing this one's name.
  //
  // The three strings that have to be real come from the boot config, which
  // already requires them for the Electron bridge (`config.bridge.appVersion`,
  // `.buildNumber`, `.buildFlavor` are non-empty-string-checked in
  // web/host-bridge.mjs). There is no filesystem in this scope and no
  // app.asar to read a package.json out of -- this object is built in the page.
  //
  // `version` and `buildNumber` are what a feedback submission reports as
  // `app_version` and `app_build`, so a placeholder here becomes a placeholder
  // in somebody's bug report. That is why they are threaded from the config
  // rather than defaulted; the defaults below exist so that a test can build
  // this layer without one.
  //
  // Field order follows production's. It has no behavioural effect -- it makes
  // the two records diffable by eye.
  // -------------------------------------------------------------------------

  const appInfoRecord = Object.freeze({
    version: typeof appInfo?.version === 'string' ? appInfo.version : '0.0.0',
    buildNumber: typeof appInfo?.buildNumber === 'string' ? appInfo.buildNumber : '0',
    buildFlavor: typeof appInfo?.buildFlavor === 'string' ? appInfo.buildFlavor : 'prod',
    osName: null,
    systemVersion: null,
    appName: typeof appInfo?.appName === 'string' ? appInfo.appName : 'Codex',
    chatGptDesktopAuthOrigin: undefined,
    chatGptApiBaseUrl: undefined,
    appIconMedium: null,
    dockIconPreviews: null,
    preloadAttribution: null,
  });

  const appInfoNamespace = {
    get: counted('appInfo.get', async () => ({ ...appInfoRecord })),
  };

  // -------------------------------------------------------------------------
  // clipboard
  //
  // Production's class (`yfe`, main @831508) has three members: `bookmark`,
  // `readText`, `writeText`. We serve ONE.
  //
  //   writeText   delegates to the browser's own clipboard. The one member in
  //               this file that does real work, and the only one where our
  //               answer is neither "here is a value" nor "this host cannot".
  //
  //               Five call sites read both namespace and method bare off the
  //               services object -- `Se.clipboard.writeText(…)` at
  //               app-initial @2171277 (copy external link), @4555586,
  //               @5388592 (copy path), @5602420, @8183274 -- so it has to
  //               exist. And the bundle itself says what to delegate to:
  //
  //                 async function Ft(e,n){ await t.clipboard.writeText(e)
  //                   .catch(()=>(n?.throwIfAborted(),
  //                               navigator.clipboard.writeText(e))) }
  //
  //               (share-thread @25369). Its recovery path for a failed HOST
  //               clipboard is `navigator.clipboard.writeText` -- exactly the
  //               call below. Four of the five `Se.` sites have no such
  //               fallback, which is why this delegates instead of declining:
  //               declining would leave "Copy path" and "Copy link" dead.
  //
  //   readText    OMITTED. Zero renderer call sites. A byte sweep for
  //               `.clipboard.readText` finds three, and all three have
  //               `navigator` as the receiver (mathlive.min, src-*,
  //               terminal-panel) -- the browser API, not this service. The
  //               page reads its own clipboard directly and never asks the
  //               host to.
  //
  //   bookmark    OMITTED, and here a stub would be actively wrong. The one
  //               reference reads it as a VALUE, not a call:
  //
  //                 try { let e = await Promise.resolve(m.clipboard.bookmark);
  //                       o = ek(i.schema, t, e) } catch { return }
  //
  //               (content-*.js @130025 -- the ProseMirror paste handler that
  //               upgrades a pasted URL into a link card). Per-member export
  //               makes a served member a FUNCTION, so serving `bookmark`
  //               hands `ek` a function where NSPasteboard bookmark data
  //               belongs. Omitted, it is `undefined`, `ek` declines or
  //               throws into that `catch { return }`, and the paste stays the
  //               plain text it already inserted. Production agrees: this
  //               member is darwin-only and returns undefined elsewhere.
  //
  // `writeText` throws rather than resolving when there is no
  // `navigator.clipboard`. A rejection is what the app reacts to; a quiet
  // resolve would tell the user their text was copied when the clipboard still
  // holds whatever it held before.
  //
  // WHAT THE REJECTION ACTUALLY PRODUCES, corrected. This comment used to say
  // it brings up "the app's toast and its manual-copy dialog". There is no
  // manual-copy dialog. `Nn` is app-shared's `Cxi` (@6497185), whose string
  // path re-imports the rpc chunk and calls `appServices.clipboard.writeText`
  // AGAIN -- same host, same hop -- so it is a retry of the call that just
  // failed, not a browser fallback. What the user is left with is `Sxi`
  // (@6496670): a danger toast, `clipboard.copyError.title` "Couldn't copy to
  // clipboard" over `clipboard.copyError.description` "The content wasn't
  // copied. Try again while ChatGPT is focused". A sweep of every non-locale
  // chunk for `anualCopy`, `opyManual`, `copy manually` and `select and copy`
  // returns one hit and it is a different screen (page-7f20e793e6b6.js@64103,
  // the merchant-settings panel). So the honest description of the fallback is
  // a toast whose advice is wrong on a phone -- the page IS focused, and `Cxi`
  // logs `hasFocus` beside the failure.
  //
  // THE GESTURE PROBLEM, and where it is answered. Every capnweb call arrives
  // in a fresh MessagePort task, so this body never runs synchronously inside
  // the click that caused it. Chromium's transient activation window (~5s)
  // survives that hop; WebKit requires the write to be issued while the
  // gesture is still being processed, so a plain `navigator.clipboard
  // .writeText` from here is refused on iOS Safari.
  //
  // That is not fixable from inside this stub and is not fixed here. It is
  // fixed one layer out, in web/host-touch.mjs section 4, which arms a
  // promise-valued ClipboardItem during the click and patches
  // `navigator.clipboard.writeText` so that this call -- one task later --
  // supplies the text to the write already in flight. Nothing is injected into
  // this function: the patch is on the object this body resolves at call time,
  // which is why this body did not have to change and why share-thread@25369,
  // which calls the browser API directly and never reaches a host stub, is
  // covered by the same patch.
  // -------------------------------------------------------------------------

  const clipboard = {
    writeText: counted('clipboard.writeText', async (text) => {
      const value = typeof text === 'string' ? text : String(text ?? '');
      const api = globalThis.navigator?.clipboard;
      if (typeof api?.writeText !== 'function') {
        report('clipboard-unavailable', {});
        throw new Error('clipboard.writeText is unavailable on this host: the browser exposes no clipboard API');
      }
      await api.writeText(value);
      report('clipboard-write', { length: value.length });
    }),
  };

  // -------------------------------------------------------------------------
  // openIn
  //
  // "Open this file in your editor" -- an Electron host shells out to VS Code,
  // Finder, a terminal. A browser cannot, and there is nothing to degrade to,
  // so the honest answer is a host with no targets.
  //
  // Production's class (`t$`, main @2405953) has five members. Two have ZERO
  // renderer references and are omitted on that ground alone:
  // `detectTarget` and `loadTargetIcon` are reachable from the main process
  // only -- `loadTargetIcon` because the icon it loads is fetched for a target
  // that `getTargets` never returns, so no code path asks for one. (A first
  // sweep put `openIn` at three members because the locale catalogs are full
  // of dotted message ids like `fileActions.openIn.failed`; filtering the
  // per-locale chunks and keying on the class's own member names gave the
  // five above, and then the two zeroes.)
  //
  //   getTargets  must resolve a FULL record. `{}` is worse than nothing here:
  //               a consumer does `i?.targets.map(...)`, which guards the
  //               result and not the array inside it, so a record missing
  //               `targets` is a TypeError where a record with an empty array
  //               is an empty menu.
  //
  //   open        resolves `{success: false}`. `{success: true}` is the lie to
  //               avoid: it makes the caller write a `recent-workspace-files`
  //               entry for a file that never opened, so the lie outlives the
  //               click and shows up later as a recent file nobody opened.
  //
  //   setGlobalPreferredTarget  declines. We have nowhere to persist a
  //               preference between a phone and a Mac, and a stub that
  //               accepted it would make the next `getTargets` contradict it.
  // -------------------------------------------------------------------------

  const openIn = {
    getTargets: counted('openIn.getTargets', async () => ({
      preferredTarget: null,
      availableTargets: [],
      mode: 'editor',
      targets: [],
    })),

    open: counted('openIn.open', async (request) => {
      report('open-in-declined', { target: request?.target ?? null });
      return { success: false };
    }),

    setGlobalPreferredTarget: declines(
      'openIn.setGlobalPreferredTarget',
      'there is no editor on this host and nowhere to persist a preference',
    ),
  };

  // -------------------------------------------------------------------------
  // customAvatars
  //
  // Avatar images loaded off the host's disk, plus the "pet" installer.
  //
  //   load        must resolve an object, never undefined: it feeds a TanStack
  //               query, and that library throws "Query data cannot be
  //               undefined" rather than treating undefined as empty. An empty
  //               directory is the right answer for a host with no avatar
  //               directory.
  //
  //   loadAvatar  resolves null -- "no image for that id" -- which is a state
  //               the caller already renders.
  //
  //   previewPetInstall / installPet  OMITTED, and this is the clearest case
  //               in the file for why omission beats a stub. The bundle checks
  //               them by hand rather than with `?.`:
  //
  //                 r = async e => { if (t.customAvatars.previewPetInstall == null)
  //                   throw Error('Pet installation is unavailable on this host'); … }
  //
  //               (webview/assets/pet-install-state-*.js). That message is the
  //               designed host-absent UX, written by someone who expected
  //               hosts to lack this. Omitting the two members is what makes
  //               it reachable. It is also the reason this file cares so much
  //               about the encoding: with the namespace exported whole,
  //               `previewPetInstall == null` would be false, that branch
  //               would be dead, and the install would fail somewhere less
  //               legible instead.
  // -------------------------------------------------------------------------

  const customAvatars = {
    load: counted('customAvatars.load', async () => ({ avatarDirectory: null, avatars: [] })),
    loadAvatar: counted('customAvatars.loadAvatar', async () => null),
  };

  // -------------------------------------------------------------------------
  // workspaceFiles and fileAttachments
  //
  // Both namespaces are PRESENT, and each serves EXACTLY ONE member -- the one
  // the renderer calls without guarding the method.
  //
  // Present, because the namespace deref is unguarded in two places that are
  // not optional about it: a render-time predicate does a bare
  // `Se.workspaceFiles.createTemporaryFile != null`, and a tab-close handler
  // does `Se?.workspaceFiles.releaseTemporaryFile?.(...)` -- `Se` guarded,
  // `workspaceFiles` not. An undefined namespace is a TypeError in a render
  // path, which is the crash class this whole file exists to remove.
  //
  // Nearly empty, because most members are selected by a `!= null` probe whose
  // false branch is a real, working, better path. The rule is mechanical:
  // count the sites that call the member with NO optional chaining on the
  // method. Zero such sites means omission costs nothing and buys the
  // bundle's own host-absent branch. One or more means omission buys a
  // TypeError, and a rejection with a legible message is strictly better --
  // a rejection and a TypeError take the same control path at the call site,
  // but only one of them says why.
  //
  // workspaceFiles, all 10 members of it (an earlier sweep found 7 and missed
  // `getMetadata`, `createDirectory`, `getDownloadsFolderIcon` -- all three
  // classify as omit, so nothing changed, but the gap was real):
  //
  //   read                     SERVED, and implemented -- see the note at the
  //                            end of this block. 12 bare calls across 9
  //                            chunks -- app-initial @4024645, app-primary
  //                            @2185506, app-shared @5125887, dialog @3569,
  //                            images @4953, native-output @791, open @13963,
  //                            text-document-preview @3547, workspace @6492.
  //                            Omitting it is 12 TypeErrors. Serving it costs
  //                            no false positive either: the only probe that
  //                            looks at `read` is artifact-tab-content
  //                            @75472's combined `read != null && write !=
  //                            null`, which still fails on the omitted
  //                            `write`. So the read-only advertisement below
  //                            survives.
  //   write                    omit -> the MCP resource is advertised
  //                            read-only, which is true. 0 bare calls; 4
  //                            value probes, and the first is the whole
  //                            reason this file exports per member:
  //                            `let r = Se.workspaceFiles.write; if (r !=
  //                            null) return async ({uri…` (app-initial
  //                            @4024885), which turns a non-null `write` into
  //                            `_meta['openai/resource'].writable = true` and
  //                            tells the MODEL the user's file is writable.
  //   saveCopy                 omit -> the plain browser anchor download,
  //                            which works. Its single bare call
  //                            (save-cloud-file-copy @1089) sits behind that
  //                            module's own `== null -> throw Error('Cloud
  //                            file …')` at @829, and view-only-header @1568
  //                            degrades to `C(new Blob([…]))`. Omitting
  //                            reaches the better path.
  //   downloadCopy             omit -> same. Its one bare call
  //                            (local-conversation-turn @37279) is gated by
  //                            `== null -> return` at @36971.
  //   getThumbnailDataUrl      omit -> the file-type icon renders, with zero
  //                            round trips. Served-and-rejecting, every
  //                            attachment chip costs four failed calls
  //                            (one + three retries) and shows no icon.
  //   createTemporaryFile /
  //     releaseTemporaryFile   omit -> the feedback dialog does not offer the
  //                            attachment checkboxes. Served, it offers them,
  //                            the user ticks "include document", the
  //                            submission succeeds, and the screenshots are
  //                            captured and thrown away.
  //   getMetadata              omit -> all 4 references are `?.()`.
  //   createDirectory          omit -> its absent paths are hand-written
  //                            `throw Error('Remot…')`.
  //   getDownloadsFolderIcon   omit -> 0 bare calls.
  //
  // fileAttachments, both members of it (`qAe`, main @2073257):
  //
  //   countFolderFiles         SERVED, and implemented. The single bare call is
  //                            a query function:
  //
  //                              queryKey: ['folder-file-count', t, e],
  //                              queryFn: () => Se.fileAttachments
  //                                .countFolderFiles({folderPath: e, hostId: t})
  //
  //                            A fake `0` would print "0 files" next to a
  //                            folder that has files -- a wrong number is
  //                            worse than no number. That argument is why the
  //                            real walk returns `null` and not a count when
  //                            it runs out of budget: an absent count is what
  //                            the chip already renders, and it is the honest
  //                            answer for a folder nobody finished counting.
  //   persistImageFileToTemp   omit -> 1 value-shaped reference, and
  //                            production returns null from it anyway
  //                            whenever the mime type is not in its map.
  //
  // THE TWO SERVED MEMBERS NOW REACH A REAL FILESYSTEM
  //
  // Both of them used to reject, and the rejection message named the adapter
  // on purpose rather than claiming the host had no files at all -- because
  // the relay does have a filesystem, the resident machine's, and the only
  // thing missing was a call path to it. `files` supplies that path:
  // web/host-files.mjs wrapped around the client the link already owns.
  //
  // `read` is the App's contract, arm for arm: `representation` of `auto`,
  // `blob` or `text`, an `etag` on every success, `auto` deciding between
  // `{text}` and `{blob}` by sniffing the first 4096 bytes, and `maxBytes`
  // raising `Workspace file exceeds the requested size limit` -- a THROW and
  // not an `outcome` field, which is the detail an earlier sweep got wrong by
  // reading `write`'s shape and attributing it here.
  //
  // Four differences from the App, all of them consequences of the adapter's
  // surface and all of them written down where they bite. Three are in
  // web/host-files.mjs: `maxBytes` is enforced after the bytes have crossed
  // the relay, the etag's size comes from the bytes rather than from a stat,
  // and its creation-time component is `birthtime` where the App uses `ctime`.
  // The fourth is here: a relative path is REJECTED rather than re-rooted onto
  // the workspace, because the adapter would resolve it against its own
  // working directory and hand back a real file that is not the one anybody
  // asked for.
  //
  // `read` can still reject, and the rejection it keeps is the useful one: the
  // member is built from `files`, and `files` is null when the link failed. A
  // dead link therefore produces the same legible per-call message it always
  // did instead of a namespace that is missing.
  // -------------------------------------------------------------------------

  const workspaceFiles = {
    read: files == null
      // The refusal is still reachable, and still has to be: `files` is null
      // whenever the link failed, and a layer that throws here instead would
      // trade a legible per-call message for a dead renderer.
      ? declines(
        'workspaceFiles.read',
        'this host has no filesystem of its own; reading a workspace file needs the resident-machine adapter, which this layer was not given',
      )
      : counted('workspaceFiles.read', async (request) => {
        const path = request?.path;
        const representation = request?.representation;
        const maxBytes = request?.maxBytes ?? null;

        if (typeof path !== 'string' || path === '') {
          throw new Error('workspaceFiles.read needs a path');
        }
        // The App resolves a relative or foreign-rooted path against the
        // workspace root before reading it (`eX`: normalise, and if the path
        // is not already absolute, re-root it onto the first workspace root
        // and probe for existence). This host does not, and the reason it
        // REJECTS rather than passing the path through is that the adapter
        // would resolve it against its own working directory -- so the
        // pass-through answer is bytes from a real file that is not the file
        // anybody asked for. A wrong file is the one outcome worse than no
        // file.
        if (!/^[\\/]|^[A-Za-z]:[\\/]|^\\\\/.test(path)) {
          throw new Error(
            `workspaceFiles.read needs an absolute path; this host does not re-root a relative one against the workspace: ${path}`,
          );
        }

        // One round trip each, in parallel, which is the shape the App's own
        // no-limit arms use (`Promise.all([readFile, stat])`). The metadata is
        // not optional even though nothing reads it directly: it is the etag.
        const [bytes, metadata] = await Promise.all([files.readBytes(path), files.metadata(path)]);

        // See web/host-files.mjs on why this is checked here and not before
        // the transfer: the adapter has no byte-limited read and its metadata
        // carries no size, so there is nothing to compare against until the
        // bytes have arrived.
        //
        // The message is the App's verbatim, but NOT because a caller matches
        // on it -- I assumed that and it is false. All 14 call sites were
        // measured and none of them surfaces this text: each either replaces
        // the rejection with a fixed string of its own ("Unable to upload
        // file", "Couldn't load this file"), swallows it to `null`, or lets it
        // propagate. Copying the wording is free and keeps a diff against the
        // App short, which is the only reason left to do it. What the callers
        // DO depend on is that it rejects at all.
        //
        // `maxBytes` of 0 reaches here, and negative values do too: the App's
        // skill loader passes `maxBytes: BUDGET - consumedSoFar` with no floor
        // under it, so a large enough earlier file in the same batch drives
        // this below zero. A negative budget rejects every file including an
        // empty one, which is the right answer for "the batch is already over
        // its limit" and is more defined than the App, where a negative length
        // reaches a byte-limited read that does not specify what it does.
        if (maxBytes != null && bytes.byteLength > maxBytes) {
          report('read-over-limit', { maxBytes, bytes: bytes.byteLength });
          throw new Error('Workspace file exceeds the requested size limit');
        }

        const etag = await etagFor(metadata, bytes.byteLength);
        report('read', {
          representation: representation ?? null,
          bytes: bytes.byteLength,
          // Recorded rather than enforced. The App picks a filesystem out of
          // its execution-host registry by this id; the relay has exactly one,
          // the resident machine's, and it answers every id with that one.
          // That is correct while there is one execution host and it is the
          // first thing to revisit if there are ever two -- so the id is in
          // the log, where a second host would show up as a surprise.
          hostId: request?.hostId ?? null,
        });

        // Each arm builds its own object so that the key it does not use is
        // ABSENT, not present and undefined. This looks like a style choice
        // and is the single most load-bearing fact about this return value:
        // 13 of the 14 measured call sites discriminate the union with the
        // `in` operator (`if (!('blob' in r)) throw`), and not one of them
        // uses `?.` or `!= null`. So `{ blob: undefined, text: '...' }` would
        // satisfy `'blob' in r` and hand 10 of those sites an undefined where
        // they expect bytes -- a download whose file contains the five
        // characters `undefined`, in one measured case. The App's
        // implementation happens to get this right; nothing in it says it has
        // to, which is exactly why it is written down here.
        //
        // The result must also stay a plain Object: capnweb defines
        // `Symbol.dispose` on every resolved object result, and 5 of the 14
        // sites read the file into a `using` declaration and dispose it.
        switch (representation) {
          case 'text':
            return { etag, text: new TextDecoder().decode(bytes) };
          case 'blob':
            return { blob: encodeBase64(bytes), etag };
          case 'auto':
            return isTextBytes(bytes)
              ? { etag, text: new TextDecoder().decode(bytes) }
              : { blob: encodeBase64(bytes), etag };
          default:
            // The App returns `undefined` here -- both of its switches are
            // exhaustive over the three names and neither has a default, so an
            // unrecognised representation falls out of the function. That is
            // not worth copying: `undefined` crosses the wire and becomes a
            // TypeError on the caller's `.text`, which is this file's whole
            // argument for rejecting with a reason instead.
            //
            // Measured as unreachable from the shipped renderer, which is what
            // makes the throw safe rather than merely principled: all 14 call
            // sites pass `representation`, 10 as the literal 'blob' and 3 as
            // 'text'. The 14th passes a variable, and that variable is parsed
            // out of an MCP app's request by a schema that allows only 'blob'
            // and 'text' and defaults to 'auto' -- so it is third-party input
            // that has already been validated, and it is also the only caller
            // in the entire bundle that can reach the 'auto' arm above. The
            // literal 'auto' appears at zero call sites.
            throw new Error(
              `workspaceFiles.read got representation ${JSON.stringify(representation ?? null)}, which is not one of 'auto', 'blob' or 'text'`,
            );
        }
      }),
  };

  const fileAttachments = {
    countFolderFiles: files == null
      ? declines(
        'fileAttachments.countFolderFiles',
        'this host cannot enumerate a folder; the count is unavailable rather than zero',
      )
      : counted('fileAttachments.countFolderFiles', async (request) => {
        const folderPath = request?.folderPath;
        if (typeof folderPath !== 'string' || folderPath === '') {
          throw new Error('fileAttachments.countFolderFiles needs a folderPath');
        }
        const count = await files.countFolderFiles(folderPath);
        // `null` is the App's own answer for a walk that hit its directory
        // budget, and it reaches the chip as an absent count rather than a
        // wrong one -- which is the same reason this member used to reject
        // instead of answering zero.
        report('folder-count', { count });
        return count;
      }),
  };

  // -------------------------------------------------------------------------
  // computerUseSettings
  //
  // PRESENT, because the namespace deref is bare in a chunk the turn path
  // loads. local-conversation-turn @9861 does
  //
  //   u = n.computerUseSettings.openChromeExtensionInstallPage;
  //   if (u == null) { l(); return }
  //
  // -- MEMBER guarded, NAMESPACE not. Absent, that is a TypeError in the
  // chrome-computer-use-suggestion handler of a chunk every conversation
  // loads. And the `== null` branch is the designed fallback (it raises the
  // install-error toast), so `openChromeExtensionInstallPage` is the one
  // member deliberately OMITTED: we cannot open a Chrome extension page on
  // the user's desktop from here, and the bundle already knows what to do
  // when we say so.
  //
  // The other fourteen come from computer-use-app-approvals-query, a 2.7KB
  // chunk, and every one is bare on BOTH the namespace and the method --
  // `t.computerUseSettings.getAppApprovals()`, never `?.`. The rule from the
  // workspaceFiles block applies at member level too: omission buys a
  // TypeError, a rejection buys a legible message, and the two take the same
  // control path at the call site.
  //
  // That chunk is NOT route-lazy, which is the part worth not getting wrong.
  // Two chunks import it statically -- codex-mobile-setup-dialog @1387 and
  // plugin-installation-content @3935 -- and both mount the
  // `locked-computer-use` query and wire a mutation whose `mutationFn` is
  // `setLockedUseEnabled`. Those two members are reached by rendering, not by
  // navigating to a settings page.
  //
  // All five getter queries carry `refetchOnWindowFocus: !0`. Now that
  // web/host-focus.mjs delivers real foreground transitions, an absent
  // namespace would be a TypeError on every return to the tab -- the one
  // event a phone generates constantly.
  //
  // No false positive to buy back: nothing probes `Se.computerUseSettings !=
  // null` to decide whether to offer computer use. The gate is the atom at
  // the head of the same chunk, reading two statsig gates and
  // `requirements.computerUse.allowLockedComputerUse`, none of which we feed.
  //
  // Getters answer honestly -- this host has no computer to use, so nothing
  // is approved, nothing is decided, and the locked state is off. Setters
  // DECLINE rather than no-op, and that is the whole point of serving them:
  // a no-op setter resolves, the settings UI redraws as though an approval
  // had been revoked, and the desktop that actually holds that approval goes
  // on honouring it. A rejection says so instead of lying.
  //
  //   getLockedUseState  the mutation's onSuccess rebuilds `{computerIconDataURL,
  //                      enabled, lockIconDataURL}` from the previous value
  //                      with `?.` and `??`, so nulls are accepted and
  //                      `enabled` is the only field read directly.
  //   getSoundMode       `getSoundMode` and `setSoundMode` appear in NO other
  //                      chunk -- the query options object is built and never
  //                      mounted. Served anyway, for one line, because the
  //                      call site is bare if anything ever mounts it.
  // -------------------------------------------------------------------------

  const NO_COMPUTER_USE =
    'this host relays a browser tab and has no computer-use desktop to approve, revoke or lock';

  const computerUseSettings = {
    getAppApprovals: counted('computerUseSettings.getAppApprovals', async () => []),
    getMessagesReadDecisions: counted('computerUseSettings.getMessagesReadDecisions', async () => []),
    getMessagesSendApprovals: counted('computerUseSettings.getMessagesSendApprovals', async () => []),
    searchMessagesChats: counted('computerUseSettings.searchMessagesChats', async () => []),
    getSoundMode: counted('computerUseSettings.getSoundMode', async () => 'off'),
    getLockedUseState: counted('computerUseSettings.getLockedUseState', async () => ({
      enabled: false,
      computerIconDataURL: null,
      lockIconDataURL: null,
    })),

    removeAppApproval: declines('computerUseSettings.removeAppApproval', NO_COMPUTER_USE),
    removeMessagesReadDecision: declines('computerUseSettings.removeMessagesReadDecision', NO_COMPUTER_USE),
    removeMessagesSendApproval: declines('computerUseSettings.removeMessagesSendApproval', NO_COMPUTER_USE),
    setLockedUseEnabled: declines('computerUseSettings.setLockedUseEnabled', NO_COMPUTER_USE),
    setMessagesReadAccessPolicy: declines('computerUseSettings.setMessagesReadAccessPolicy', NO_COMPUTER_USE),
    setMessagesReadDecision: declines('computerUseSettings.setMessagesReadDecision', NO_COMPUTER_USE),
    setMessagesSendAllowAllChats: declines('computerUseSettings.setMessagesSendAllowAllChats', NO_COMPUTER_USE),
    setSoundMode: declines('computerUseSettings.setSoundMode', NO_COMPUTER_USE),
  };

  // -------------------------------------------------------------------------
  // startup -- NOT SERVED, and the reason is operator precedence
  //
  // It appears in the eight because of
  //
  //   let e = Tbc || Ebc || Dbc || Se.startup?.whenReady == null
  //     ? void 0
  //     : Promise.resolve(Se.startup.whenReady()).then(…)
  //
  // where the bare `Se.startup.whenReady()` looks unguarded. It is not: `||`
  // binds tighter than `?:`, so the whole `||` chain is the condition, and the
  // bare deref is only reached when `Se.startup?.whenReady != null` -- which
  // is false when `startup` is absent. A false positive in the sweep; the real
  // count is seven.
  //
  // And serving a PARTIAL startup is strictly worse than serving none, in two
  // directions. `Se.startup != null` mounts a hidden marker span whose ref
  // callback calls `(Se?.startup?.reach(e))?.catch(…)` -- object guarded,
  // return value guarded, METHOD NOT -- so a `startup` without `reach` is a
  // TypeError thrown from a ref callback during commit. And `whenReady`, if
  // served, is consumed by React 19 `use()` inside `<Suspense fallback={
  // <v8 debugName="Startup"/>}>`, so a promise we fail to settle parks the app
  // on that fallback permanently, with no error boundary hit and nothing in
  // the console -- the one place in this file where a mistake hangs instead of
  // crashing.
  //
  // What absence costs: one OTel mark (`host_startup_ready`) and a
  // process-start timing we do not have. What it buys: no Suspense boundary,
  // no marker span, no ref-callback call path at all.
  // -------------------------------------------------------------------------

  const services = assertServable({
    appInfo: appInfoNamespace,
    clipboard,
    computerUseSettings,
    customAvatars,
    fileAttachments,
    openIn,
    requestUserInputAutoResolution,
    workspaceFiles,
  });

  return {
    services,
    stats: () => ({
      namespaces: Object.keys(services).sort(),
      members: Object.entries(services)
        .flatMap(([name, ns]) => Object.keys(ns).map((member) => `${name}.${member}`))
        .sort(),
      calls: { ...calls },
      presented: presented.size,
    }),
  };
}
