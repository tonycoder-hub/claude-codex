// Persisted UI state, workspace onboarding, and the pushes that expect no
// answer: the three groups of renderer traffic that nobody else on the bus
// claims.
//
// Like `web/host-bus.mjs` this module owns no window and no socket, and unlike
// the bus it does not deliver either. `handle(message)` takes a message the
// renderer sent and RESOLVES WITH the inbound messages the host owes in reply;
// the caller delivers them. Two things come out of that split. The property
// that matters most here -- that a blocking request is never answered with
// silence -- becomes an assertion about a returned array instead of an
// assertion about a DOM event somebody has to be listening for. And the same
// object can be driven from a test with no transport at all, which is how the
// record-merge rules below are pinned.
//
// The wiring a caller writes:
//
//   const services = createHostServices({ store, pickWorkspaceRoot });
//   for (const type of HOST_SERVICE_TYPES) {
//     bus.on(type, (message) => {
//       services.handle(message).then((replies) => replies.forEach(deliver));
//     });
//   }
//
// `deliver` is the caller's inbound dispatch. The bus's emitters cover
// app-server traffic only, so supplying one is the wiring's job, not this
// file's.
//
// WHY `handle` IS ASYNC EVEN THOUGH MOST OF IT IS NOT.
//
// One of the five requests cannot be answered synchronously: picking a folder
// means asking a human. Rather than a signature that returns a reply sometimes
// and a promise other times, every path returns a promise. The cost is one
// microtask on the persisted-atom reply, which is the only one of the five with
// a deadline, and its deadline is 5000 ms (see below). Nothing in here reads a
// clock or sets a timer; the one measured timeout belongs to the renderer and
// is the renderer's to fire.
//
// THE 5000 MS FUSE, which is the only self-healing block on this bus.
//
// The renderer sends `persisted-atom-sync-request` and arms
// `window.setTimeout(..., shc)` with `shc = 5e3`. On expiry it logs
// "[persisted-atom] host did not respond to sync request; continuing with
// legacy state only" and hydrates from localStorage alone. So an unanswered
// sync is not a hang -- it is five seconds of stall followed by a page that has
// forgotten every draft, every dismissal and every sidebar tweak, with one line
// in a console nobody on a phone can open.
//
// A sequencing note, because the shape of the renderer's effect decides whether
// a prompt reply is safe. In `assets__app-initial`, the `persisted-atom-sync`
// subscriber is installed at ~9,956,230 and the `persisted-atom-sync-request`
// dispatch that it is waiting for runs at ~9,956,990, inside the same closure:
// SUBSCRIBE THEN DISPATCH. A reply is therefore not at risk of arriving before
// its subscriber exists, which matters because this type is not one of the
// three the renderer buffers. (`web/host-protocol.mjs` reads the ordering the
// other way round, from the dispatch at ~9,956,052. That offset is the
// `persisted-atom-update` write-back inside the atom factory, not the sync
// request. Answering from a later task, as this module does, is safe under
// either reading, so nothing here depends on which is right.)
//
// THE TRAP, and it is the one that makes persistence theatre.
//
// The renderer's write-back is
//
//   function s(e,t,r){ ... dispatchMessage(`persisted-atom-update`,
//     {key:e, value: r==null?t:void 0, deleted: r==null&&t===void 0,
//      recordUpdate:r}) }
//
// Read `value` unconditionally and you store `undefined` for every record atom
// the renderer writes, because a record write sends `recordUpdate` INSTEAD of
// `value` -- the full value is never on the wire. A host that does that looks
// like it persists: the sync reply is well formed, the keys are all there, and
// composer drafts come back empty. So a record write is merged here, from the
// stored base, by the same rules the renderer's own merge uses.
//
// WHAT THIS DELIBERATELY DOES NOT DO.
//
//   No `persisted-atom-updated` push. That type exists for multi-window sync
//   and the relay serves one page, so there is no second window whose writes
//   this one would need to hear about.
//
//   No `shared-object-updated` echo for a `shared-object-set`. In Electron the
//   repository re-broadcasts every write to every subscribed webContents
//   INCLUDING the sender, but the renderer's setter already wrote the value
//   into its own store on the line before it dispatched
//   (`...dispatchMessage('shared-object-set',{key,value}), e.set(fH,key,value)`,
//   app-shared@3164818), so the echo it gets back is idempotent. The relay
//   serves one page, so the echo would have no second window to reach and the
//   only thing it could do here is race its own sender.
//
//   No eviction. The renderer's record merge also enforces `timestampField`,
//   `minNumericValue`, `maxEntries` and `maxBytes`, all of which only ever
//   SHRINK a record. Those are skipped here and the reason is stated at
//   `applyRecordUpdate`.
//
//   No filesystem, and no folder picker. A phone browser has neither. Both the
//   picker and the onboarding skip are injected callbacks, and their default is
//   a clean refusal the user can retry rather than a dialog that never closes.

import {
  ELECTRON_ONLY_PUSHES,
  OUTBOUND,
  inboundGlobalStateUpdated,
  inboundOnboardingSkipWorkspaceResult,
  inboundPersistedAtomSync,
  inboundWorkspaceRootOptionAddCanceled,
  inboundWorkspaceRootOptionAdded,
  inboundWorkspaceRootOptionPicked,
  inboundWorkspaceRootOptionsUpdated,
} from './host-protocol.mjs';

/**
 * The renderer's own deadline on `persisted-atom-sync-request`, in ms.
 *
 * Recorded as a number rather than used as one: nothing here schedules against
 * it. It is the budget a caller is spending if it puts a round trip between the
 * request and `handle`, and the reason the default store is in memory.
 */
export const PERSISTED_ATOM_SYNC_FUSE_MS = 5000;

/**
 * The outbound types consumed with no reply, because each was measured to have
 * no inbound counterpart anywhere in the bundle.
 *
 *   `app-shell-shortcut-state-changed` -- two senders, both pushing the same
 *   ~25-field shortcut-enablement record from a render effect, and no inbound
 *   type that acknowledges it.
 *
 *   `checkout-webview-presentation-changed` -- sent from a layout effect with
 *   `{partition, url}` and again with `url: null` on unmount. The host it was
 *   written for attaches a native webview; there is no reply in either
 *   direction.
 *
 *   `electron-avatar-overlay-restore-ready` -- `{onDemandEnabled,
 *   shouldPrewarmAvatarOverlay}` from a boot effect, alongside the other
 *   feature-gate pushes. Nothing answers it.
 *
 *   `shared-object-subscribe` -- the one that looks like a request and is not.
 *   The subscribing atom reads its FIRST value synchronously off
 *   `window.electronBridge?.getSharedObjectSnapshotValue?.(key)` and subscribes
 *   to `shared-object-updated` for later changes, then dispatches the
 *   subscribe. So the subscribe asks for nothing: answering it with a first
 *   value answers a question the renderer did not ask, and the initial value
 *   has to come from the bridge member or it is never read at all.
 *
 * They are consumed rather than ignored so that a host which reports unknown
 * outbound traffic is not drowned by them -- the shortcut one alone fires on
 * every focus change.
 *
 * The twenty-five that follow them come from `ELECTRON_ONLY_PUSHES`, which is
 * the swept remainder: every outbound type a full drive of the mounted
 * renderer left unclaimed, read send-site-and-main-arm, and found to owe a
 * browser tab nothing. They are listed there with a reason each rather than
 * here, because four hand-written paragraphs are documentation and twenty-nine
 * would be a wall nobody re-reads. Two of the twenty-seven swept are NOT in
 * that table and are handled instead: `electron-window-focus-request` by
 * web/host-focus.mjs, and `shared-object-set` just below.
 *
 * With those claimed, a report of unclaimed outbound traffic means what it is
 * supposed to mean -- the next App update added a type nobody has read yet --
 * instead of meaning "the same twenty-five as yesterday".
 */
export const CONSUMED_WITHOUT_REPLY = Object.freeze([
  OUTBOUND.appShellShortcutStateChanged,
  OUTBOUND.checkoutWebviewPresentationChanged,
  OUTBOUND.avatarOverlayRestoreReady,
  OUTBOUND.sharedObjectSubscribe,
  ...Object.keys(ELECTRON_ONLY_PUSHES),
]);

/** Every outbound type this module claims. Everything else is somebody's. */
export const HOST_SERVICE_TYPES = Object.freeze([
  OUTBOUND.persistedAtomSyncRequest,
  OUTBOUND.persistedAtomUpdate,
  OUTBOUND.pickWorkspaceRootOption,
  OUTBOUND.addNewWorkspaceRootOption,
  OUTBOUND.onboardingSkipWorkspace,
  OUTBOUND.sharedObjectSet,
  ...CONSUMED_WITHOUT_REPLY,
]);

/**
 * What the user reads when onboarding's skip is declined.
 *
 * It is user-facing text: the renderer's handler is `if (e.success) {...;
 * return} setError(e.error ?? null)`, and that error lands on the onboarding
 * step. Exported so a test asserts the same string the UI shows rather than its
 * own copy of it.
 */
export const SKIP_WORKSPACE_UNSUPPORTED =
  'This Codex runs in a browser, which cannot create a workspace folder for you. '
  + 'Choose a folder from the list to continue.';

/**
 * A plain record, by the same test the renderer applies to a record atom before
 * merging into it: anything that is not one parses as `{}` on its side, arrays
 * included, so an array base must not be spread here either.
 */
function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Apply one `recordUpdate` to the value we hold for a key.
 *
 * The rules below are the renderer's, in its order, because the result is read
 * back by its own merge on the next write and a different order shows up as a
 * key that reappears after being deleted:
 *
 *   - `entries[k] === null` DELETES k. A null entry is how a record atom spells
 *     a removal; there is no separate deleted flag inside a record.
 *   - `expectedValue`, when present, is a compare-and-set: the entry is skipped
 *     unless the value we hold for k is already that value. Skipping is the
 *     whole point -- it is how two writers racing on one key do not clobber.
 *   - `updateOnly` means "only if k is already there". Absent key, no insert.
 *   - every other entry is DELETED AND REINSERTED rather than assigned, so k
 *     moves to the end of the key order. That order is not cosmetic: the
 *     renderer's `maxEntries` pruning sorts by it when no `timestampField` is
 *     configured, so an in-place assignment here would make the wrong entry
 *     the oldest one later.
 *
 * FOUR RULES ARE DELIBERATELY NOT HERE: `timestampField`, `minNumericValue`,
 * `maxEntries` and `maxBytes`. All four only ever drop entries, and the
 * renderer re-applies the complete policy over the whole record on its next
 * write to that key, so a host holding a superset is corrected rather than
 * corrupted -- whereas implementing them means guessing the timestamp schema
 * (`H({[timestampField]: iu()})` in the minified source), and guessing it wrong
 * evicts the NEWEST entry instead of the oldest. A larger snapshot is the
 * cheaper error.
 */
function applyRecordUpdate(base, recordUpdate) {
  const merged = isPlainRecord(base) ? { ...base } : {};
  const entries = recordUpdate?.entries;
  if (!isPlainRecord(entries)) return merged;

  for (const [key, entry] of Object.entries(entries)) {
    if (entry?.expectedValue !== undefined && merged[key] !== entry.expectedValue) continue;
    if (entry?.updateOnly) {
      if (!Object.hasOwn(merged, key)) continue;
    } else {
      delete merged[key];
    }
    // A null entry has already done its work by being deleted above.
    if (entry !== null && entry !== undefined) merged[key] = entry.value;
  }
  return merged;
}

/**
 * Build a host for the persisted atoms, the workspace dialogs and the claims
 * that want no answer.
 *
 * `store` is anything Map-shaped -- `get`, `set`, `delete`, `entries`. A `Map`
 * is the default and is the right one for a relay that is restarted as often as
 * the page is reloaded; a caller that wants state to outlive the tab passes a
 * Map-shaped façade over wherever it keeps it. The keys are opaque: they are
 * storage names of the `something-v1` form minted by the renderer's atom
 * factory, not message types, and nothing here interprets one.
 *
 * `pickWorkspaceRoot({allowMultiple})` may return a path, an array of paths,
 * null, or a promise of any of those. Anything that is not a non-empty string
 * is a cancel.
 *
 * `addWorkspaceRoot({root})` returns `{projectId, root}` or null. It exists
 * because `electron-add-new-workspace-root-option` is answered with a project
 * id that only whoever created the project can know.
 *
 * `skipWorkspace({initializeGitRepository})` returns true, `{success, error}`
 * or null. Absent, the skip is declined with `SKIP_WORKSPACE_UNSUPPORTED`.
 *
 * `onEvent({type, outcome, ...})` observes every message handled and every
 * ping emitted. A caller that prefers to be pushed at rather than to read a
 * return value can deliver from here; the returned replies are the same
 * objects.
 *
 * @param {{
 *   store?: {get: Function, set: Function, delete: Function, entries: Function},
 *   pickWorkspaceRoot?: Function,
 *   addWorkspaceRoot?: Function,
 *   skipWorkspace?: Function,
 *   onEvent?: Function,
 * }} [args]
 */
export function createHostServices({
  store = new Map(),
  sharedObjects = new Map(),
  pickWorkspaceRoot,
  addWorkspaceRoot,
  skipWorkspace,
  onEvent,
} = {}) {
  for (const method of ['get', 'set', 'delete', 'entries']) {
    if (typeof store[method] !== 'function') {
      throw new TypeError(
        `createHostServices: store must be Map-shaped and is missing ${method}()`,
      );
    }
  }
  for (const method of ['set', 'delete']) {
    if (typeof sharedObjects[method] !== 'function') {
      throw new TypeError(
        `createHostServices: sharedObjects must be Map-shaped and is missing ${method}()`,
      );
    }
  }

  const stats = {
    handled: 0,
    unclaimed: 0,
    malformed: 0,
    syncsAnswered: 0,
    atomsStored: 0,
    atomsDeleted: 0,
    recordsMerged: 0,
    rootsPicked: 0,
    picksCanceled: 0,
    rootsAdded: 0,
    addsCanceled: 0,
    skipsAnswered: 0,
    sharedObjectsMirrored: 0,
    sharedObjectsCleared: 0,
    consumedWithoutReply: 0,
    emitted: 0,
    storeFailures: 0,
    callbackFailures: 0,
    observerFailures: 0,
  };

  /**
   * Tell the observer, and never let it change the outcome.
   *
   * A logger that throws must not turn an answered request into an unanswered
   * one. It would, too: these handlers run from a window listener, where a
   * throw is swallowed by the bus and the renderer is left waiting with a clean
   * console -- the exact failure this module exists to prevent.
   */
  const note = (event) => {
    if (typeof onEvent !== 'function') return;
    try {
      onEvent(event);
    } catch {
      stats.observerFailures += 1;
    }
  };

  /**
   * The state for a sync reply.
   *
   * Undefined values are dropped rather than sent. The renderer's hydration
   * loop is `Object.entries(state).forEach(([k,v]) => {v !== void 0 &&
   * store.set(k,v)})`, so an undefined value is already the same as an absent
   * key over there; dropping it here keeps what we send equal to what it will
   * hold. A store that throws on read degrades to an empty state, because an
   * empty state is a complete, valid answer that unblocks first paint and a
   * raised error is five seconds of stall.
   */
  const readState = () => {
    const state = {};
    try {
      for (const [key, value] of store.entries()) {
        if (typeof key === 'string' && value !== undefined) state[key] = value;
      }
    } catch (error) {
      stats.storeFailures += 1;
      note({ type: OUTBOUND.persistedAtomSyncRequest, outcome: 'store-failed', error });
      return {};
    }
    return state;
  };

  const readValue = (key) => {
    try {
      return store.get(key);
    } catch (error) {
      stats.storeFailures += 1;
      note({ type: OUTBOUND.persistedAtomUpdate, outcome: 'store-failed', key, error });
      return undefined;
    }
  };

  /** @returns {boolean} whether the write landed */
  const writeValue = (key, value) => {
    try {
      store.set(key, value);
      return true;
    } catch (error) {
      stats.storeFailures += 1;
      note({ type: OUTBOUND.persistedAtomUpdate, outcome: 'store-failed', key, error });
      return false;
    }
  };

  const removeValue = (key) => {
    try {
      store.delete(key);
      return true;
    } catch (error) {
      stats.storeFailures += 1;
      note({ type: OUTBOUND.persistedAtomUpdate, outcome: 'store-failed', key, error });
      return false;
    }
  };

  function answerSyncRequest(message) {
    const state = readState();
    stats.syncsAnswered += 1;
    // `canWritePrimaryWindowTabPersistence` is left at the builder's default of
    // true: the relay serves exactly one page, so there is no second window
    // that could be the primary one.
    const reply = inboundPersistedAtomSync({ state });
    note({
      type: message.type,
      outcome: 'answered',
      keys: Object.keys(state),
      responsePriority: message.responsePriority,
    });
    return [reply];
  }

  function storeAtomUpdate(message) {
    const { key, value, deleted, recordUpdate } = message;
    if (typeof key !== 'string' || key === '') {
      stats.malformed += 1;
      note({ type: message.type, outcome: 'malformed', key });
      return [];
    }

    // Both halves of the renderer's own rule. Its store deletes on an undefined
    // value -- `t === void 0 ? store.delete(key) : store.set(key, t)` -- and the
    // `deleted` flag it sends is computed from exactly that condition, so the
    // two agree on every message the renderer actually sends. Honouring both
    // means a message from a future version that sets only one of them still
    // deletes rather than storing a hole.
    if (deleted === true || (recordUpdate == null && value === undefined)) {
      removeValue(key);
      stats.atomsDeleted += 1;
      note({ type: message.type, outcome: 'deleted', key });
      return [];
    }

    if (recordUpdate != null) {
      // The base can come from a second key. The renderer resolves a record
      // atom's base as `store.get(key) ?? store.get(recordUpdate
      // .legacyStorageKey)`, which is how an atom that was renamed keeps the
      // entries it had under its old name through the first write after the
      // rename.
      const legacy = recordUpdate.legacyStorageKey;
      const base =
        readValue(key) ?? (typeof legacy === 'string' && legacy !== '' ? readValue(legacy) : undefined);
      writeValue(key, applyRecordUpdate(base, recordUpdate));
      stats.recordsMerged += 1;
      note({ type: message.type, outcome: 'record-merged', key });
      return [];
    }

    writeValue(key, value);
    stats.atomsStored += 1;
    note({ type: message.type, outcome: 'stored', key });
    return [];
  }

  /**
   * The one terminal reply both workspace dialogs can always send.
   *
   * `workspace-root-option-add-canceled` carries no fields and exists so that
   * the pending state has a second way to clear. It is what a host sends when
   * it declines to produce a root or a project, which on a phone is most of
   * the time.
   */
  function cancelAdd(type, reason, error) {
    if (type === OUTBOUND.pickWorkspaceRootOption) stats.picksCanceled += 1;
    else stats.addsCanceled += 1;
    note({ type, outcome: 'canceled', reason, error });
    return [inboundWorkspaceRootOptionAddCanceled()];
  }

  async function answerPickRequest(message) {
    const allowMultiple = message.allowMultiple === true;
    if (typeof pickWorkspaceRoot !== 'function') {
      // The decline that keeps onboarding alive. There is no OS folder picker
      // in a phone browser, and this request has no timeout at all, so the
      // alternative to a cancel is a dialog in a pending state with nothing in
      // the console to explain it. A cancel is a button the user can press
      // again.
      return cancelAdd(message.type, 'no-picker');
    }

    let picked;
    try {
      picked = await pickWorkspaceRoot({ allowMultiple });
    } catch (error) {
      stats.callbackFailures += 1;
      return cancelAdd(message.type, 'picker-failed', error);
    }

    const offered = (Array.isArray(picked) ? picked : [picked]).filter(
      (root) => typeof root === 'string' && root !== '',
    );
    // One `root` per message, because the renderer's subscriber is `event =>
    // addRoots([event.root])` -- it reads a single root and appends it. Several
    // roots are therefore several messages, and when the request said
    // `allowMultiple: false` the extras are dropped rather than appended: that
    // flag is the difference between the onboarding single-select and the
    // settings "add folder" row, and three roots arriving at the single-select
    // would check three boxes.
    const chosen = allowMultiple ? offered : offered.slice(0, 1);
    if (chosen.length === 0) return cancelAdd(message.type, 'nothing-picked');

    stats.rootsPicked += chosen.length;
    note({ type: message.type, outcome: 'picked', roots: chosen, dropped: offered.length - chosen.length });
    return chosen.map((root) => inboundWorkspaceRootOptionPicked({ root }));
  }

  async function answerAddRequest(message) {
    if (typeof addWorkspaceRoot !== 'function') return cancelAdd(message.type, 'no-adder');

    let added;
    try {
      added = await addWorkspaceRoot({ root: message.root });
    } catch (error) {
      stats.callbackFailures += 1;
      return cancelAdd(message.type, 'adder-failed', error);
    }

    const projectId = isPlainRecord(added) ? added.projectId : undefined;
    // A missing project id is answered with the cancel rather than with
    // `workspace-root-option-added` carrying a null one. The two are the same
    // thing to the renderer -- the sidebar's subscriber runs the identical
    // "nothing was added" branch for `projectId == null` as its add-canceled
    // subscriber does -- and the cancel says so in its name.
    if (projectId === undefined || projectId === null) {
      return cancelAdd(message.type, 'nothing-added');
    }

    const reply = inboundWorkspaceRootOptionAdded({ projectId });
    // `root` is attached here because the sidebar's subscriber reads it:
    // `handler = e => { setAddedRoot(e.root, e.selectedProjectId ?? e.projectId);
    // ... }`, and it runs before the project-id branch. The builder has no
    // parameter for it, so it is set after the fact rather than written into a
    // literal that would also restate the type string.
    const root = isPlainRecord(added) && typeof added.root === 'string' ? added.root : message.root;
    if (typeof root === 'string' && root !== '') reply.root = root;

    stats.rootsAdded += 1;
    note({ type: message.type, outcome: 'added', projectId, root: reply.root });
    return [reply];
  }

  async function answerSkipRequest(message) {
    // Contrary to its reputation this one does have a reply, and it is load
    // bearing. The onboarding page sets a local pending state to `skip` before
    // dispatching, and the ONLY thing that clears it is its subscriber on
    // `electron-onboarding-skip-workspace-result`, whose first statement is
    // `setPending(null)`. Acknowledging without replying therefore leaves the
    // skip button dead for the rest of the session, with the request guarded by
    // `pending ?? dispatch(...)` so a second press does nothing either.
    let outcome;
    if (typeof skipWorkspace !== 'function') {
      outcome = { success: false, error: SKIP_WORKSPACE_UNSUPPORTED };
    } else {
      try {
        const result = await skipWorkspace({
          initializeGitRepository: message.initializeGitRepository,
        });
        if (result === true || (isPlainRecord(result) && result.success === true)) {
          outcome = { success: true };
        } else {
          const given = isPlainRecord(result) && typeof result.error === 'string' ? result.error : null;
          outcome = { success: false, error: given ?? SKIP_WORKSPACE_UNSUPPORTED };
        }
      } catch (error) {
        stats.callbackFailures += 1;
        // The thrown message is passed through as the user-facing error. It is
        // the only description of the failure that exists, and the alternative
        // is a step that failed and will not say why -- which is what the
        // renderer renders for a result with no error text.
        outcome = {
          success: false,
          error: (error instanceof Error && error.message) || SKIP_WORKSPACE_UNSUPPORTED,
        };
      }
    }

    stats.skipsAnswered += 1;
    note({ type: message.type, outcome: outcome.success ? 'skipped' : 'refused', error: outcome.error });
    return [inboundOnboardingSkipWorkspaceResult(outcome)];
  }

  /**
   * Mirror a `shared-object-set` into the snapshot the bridge reads.
   *
   * NOT a reply, and not a repository either. In Electron the value makes two
   * stops: main's in-memory store, and -- the one that matters to a page --
   * the PRELOAD's cache, which is written on the way out
   * (``sendMessageFromView:async t=>{t.type===`shared-object-set`&&I(t.key,t.value),
   * await e.ipcRenderer.invoke(E,t)}``, preload.js@3472) and read back by
   * `getSharedObjectSnapshotValue:e=>A[e]` (@4215). This is `I`, in the one
   * place the relay has that is equivalent to a preload.
   *
   * WHY IT IS WORTH DOING AT ALL, given the renderer never re-reads the
   * snapshot within a page. The atom family does not dispose -- `tA` passes no
   * family options, so `Pit(undefined)` returns Infinity and the initializer
   * runs once per key per store -- so inside one page lifetime this is
   * write-only. The cost of skipping it is therefore bounded to exactly one
   * event: a reload. Which is the cheap-sounding event that is not cheap here,
   * because a phone browser evicts and reloads tabs on its own schedule, and
   * `diff_comments` is one of the keys that travels this way.
   *
   * WHAT IT STILL DOES NOT MATCH. Electron's preload re-seeds from main on
   * every reload (`A=ipcRenderer.sendSync('codex_desktop:get-shared-object-snapshot')??{}`,
   * preload.js@2863), so there the value survives a reload because MAIN held
   * it. Here it survives only as far as the store the caller supplies: given
   * the boot storage's localStorage-backed one it survives a reload too, and
   * given the default `new Map()` it does not. That is a deliberate choice of
   * default, not an oversight -- a module that reached for persistent storage
   * on its own would be making a deployment decision in a test harness.
   *
   * `undefined` deletes, which is `I`'s first branch and main's
   * (``set(e,t){t===void 0?delete this.store[e]:this.store[e]=t,...}``). `null`
   * is stored, because null is a value a shared object can hold.
   */
  const mirrorSharedObject = (message) => {
    const { key, value } = message;
    if (typeof key !== 'string' || key === '') {
      // Not malformed enough to count as a malformed MESSAGE -- the type was
      // right and the bus delivered it -- but there is no slot to write to.
      note({ type: message.type, outcome: 'ignored', reason: 'no key' });
      return [];
    }
    try {
      if (value === undefined) {
        sharedObjects.delete(key);
        stats.sharedObjectsCleared += 1;
        note({ type: message.type, outcome: 'cleared', key });
      } else {
        sharedObjects.set(key, value);
        stats.sharedObjectsMirrored += 1;
        note({ type: message.type, outcome: 'mirrored', key });
      }
    } catch (error) {
      // A full quota on a localStorage-backed store. The renderer has already
      // written its own copy, so the page is correct until it reloads; raising
      // here would turn a lost reload into a swallowed throw in a listener.
      stats.storeFailures += 1;
      note({ type: message.type, outcome: 'store-failed', key, error });
    }
    return [];
  };

  return {
    /** Whether `handle` claims this outbound type. */
    owns(type) {
      return HOST_SERVICE_TYPES.includes(type);
    },

    /** A copy, so a caller cannot edit the counters it is reading. */
    stats() {
      return { ...stats };
    },

    /**
     * Handle one outbound message.
     *
     * Resolves with the inbound messages to deliver, in order -- empty for the
     * fire-and-forget types, for an unclaimed type, and for a message this
     * module could not read. It does not reject: a store or a callback that
     * throws becomes a reply (a cancel, a refusal, an empty state) rather than
     * an exception, because the caller of last resort is a window listener
     * where a throw is swallowed and the renderer waits forever.
     *
     * @param {{type: string}} message
     * @returns {Promise<object[]>}
     */
    async handle(message) {
      const type = isPlainRecord(message) ? message.type : undefined;
      if (typeof type !== 'string') {
        stats.malformed += 1;
        note({ type: undefined, outcome: 'malformed' });
        return [];
      }
      if (!HOST_SERVICE_TYPES.includes(type)) {
        // Not an error. The renderer's own switch has no default branch and
        // ignores what it does not know; a service that threw on a type it was
        // simply not given would be stricter than the thing it imitates.
        stats.unclaimed += 1;
        note({ type, outcome: 'unclaimed' });
        return [];
      }

      stats.handled += 1;
      switch (type) {
        case OUTBOUND.persistedAtomSyncRequest:
          return answerSyncRequest(message);
        case OUTBOUND.persistedAtomUpdate:
          return storeAtomUpdate(message);
        case OUTBOUND.pickWorkspaceRootOption:
          return answerPickRequest(message);
        case OUTBOUND.addNewWorkspaceRootOption:
          return answerAddRequest(message);
        case OUTBOUND.onboardingSkipWorkspace:
          return answerSkipRequest(message);
        case OUTBOUND.sharedObjectSet:
          return mirrorSharedObject(message);
        default:
          // Only the fire-and-forget types reach here: the ownership check
          // above admits nothing else, and HOST_SERVICE_TYPES is built from
          // the same constants the branches above are. See
          // CONSUMED_WITHOUT_REPLY, and ELECTRON_ONLY_PUSHES behind it, for
          // what was measured about each.
          stats.consumedWithoutReply += 1;
          note({ type, outcome: 'consumed' });
          return [];
      }
    },

    /**
     * The workspace root list changed.
     *
     * A cache-invalidation ping with no fields: the renderer answers it by
     * invalidating its `workspace-root-options` and `git-origins` queries and
     * refetching them as two new `fetch` messages. Which makes this the lever
     * for forcing that refetch without knowing anything about its query cache.
     */
    emitWorkspaceRootOptionsUpdated() {
      const message = inboundWorkspaceRootOptionsUpdated();
      stats.emitted += 1;
      note({ type: message.type, outcome: 'emitted' });
      return message;
    },

    /**
     * These global-state keys are stale.
     *
     * `keys` must be an array and the builder refuses anything else, which is
     * why the counter is incremented after it rather than before: the renderer
     * runs `keys.includes(LOCAL_PROJECTS)` and then `for (const k of keys)`, so
     * a null throws inside its handler and a bare STRING is worse than a throw
     * -- a string has `.includes` and iterates, so one key's worth of intent
     * becomes one invalidation per character and the key meant is never
     * refetched. (`local-projects` is the one value it special-cases, which
     * additionally invalidates the workspace-root and git-origin queries.)
     */
    emitGlobalStateUpdated({ keys } = {}) {
      const message = inboundGlobalStateUpdated({ keys });
      stats.emitted += 1;
      note({ type: message.type, outcome: 'emitted', keys: message.keys });
      return message;
    },
  };
}
