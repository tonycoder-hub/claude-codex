// The assembler. One module, loaded before the renderer's own entry, that
// stands up everything Electron would otherwise have handed the page.
//
// Every other module under web/ was built and proved alone, against the
// measured bundle, with no caller: the bridge installs onto a window, the bus
// captures and delivers, the fetch layer answers endpoints, the services layer
// returns reply arrays, the link joins the bus to a JSON-RPC client. This file
// is the one place they meet, and it exists because the order they meet in is
// not negotiable.
//
// WHY ORDER IS THE WHOLE JOB
//
// The renderer reads four bridge members SYNCHRONOUSLY at module-eval time
// (`getSentryInitOptions`, `getBuildFlavor`, `getSharedObjectSnapshotValue`,
// `getSystemThemeVariant` -- see web/host-bridge.mjs), so the bridge has to be
// on the window before the entry script runs, not merely before React mounts.
// That is arranged in the document rather than here: src/renderer/boot.mjs
// inserts our tag immediately ahead of the bundle's single non-async module
// entry, and module scripts execute in document order, so by the time the
// renderer evaluates anything this file has already returned.
//
// The same ordering buys the rest of it. Of the renderer's 189 inbound types
// exactly three are buffered until a subscriber mounts -- `mcp-request-delivery`,
// `mcp-response` and `personal-workspace-access-blocked`. For every other type
// a reply that arrives before its subscriber is DROPPED, in silence, with no
// error anywhere. A host that installs late therefore does not fail; it answers
// into a void and the renderer waits. Installing before the entry means the
// subscriber cannot be late relative to us, because it does not exist yet.
//
// WHAT A FAILURE HERE LOOKS LIKE, AND WHY THERE IS A BANNER
//
// Four outbound types block something and three of them have no timeout at all:
// an unanswered `fetch` stalls the entire non-conversation data layer, an
// unanswered `mcp-request` stalls every conversation operation, and an
// unanswered workspace pick stalls onboarding. None of them log. The renderer's
// startup logo simply keeps spinning with a clean console, which is the single
// most expensive failure mode this repository has, because it is
// indistinguishable from a dozen unrelated ones.
//
// So nothing in this file is allowed to throw out of the module. Each layer is
// installed inside its own try, a failed layer is recorded, and -- for every
// layer whose absence hangs the renderer -- a failure paints a fixed banner over
// the page carrying the reason. A phone has no devtools to read, so a console
// line is not a diagnostic there; the banner is. The one exception is the touch
// layer, which is reported but not bannered: its absence leaves a page that is
// awkward rather than one that never finishes loading, and a banner for a
// cosmetic fault teaches the user to ignore banners.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO
//
// It never defines `electronBridge.sendMessageFromView` as a delivery path. The
// renderer's transport sends every outbound message twice over -- it calls that
// member AND dispatches a `codex-message-from-view` CustomEvent unconditionally
// -- so the CustomEvent is the complete record and the bridge call is a subset
// of it. web/host-bus.mjs listens on the CustomEvent only, and this file never
// reaches for the other path. Hooking both would deliver every `mcp-request`
// twice, the server would answer both, and the second answer would arrive for a
// request id already settled: an intermittent duplicate tool call that reads as
// a retry rather than as a bug.
//
// It also never chooses the app server's version. `link.startFromHandshake()`
// asks the server and announces what it says, and when the server's reply
// carries nothing comparable the link throws and this file banners the throw.
// Substituting a literal is the one repair that must not be made here: the
// renderer treats `0.0.0` as a wildcard that force-enables every version gate,
// including the one that strips `turnTrigger` out of `turn/start` -- so a
// convenient default turns `turn/steer` into `turn/start` and the user watches a
// steer start a fresh turn with no error on either side.

import { base64urlDecode } from './base64url.mjs';
import { installElectronBridge } from './host-bridge.mjs';
import { createCapnwebSession } from './host-capnweb.mjs';
import { createHostFetch, SETTINGS_KEY } from './host-fetch.mjs';
import { installHandshake } from './host-handshake.mjs';
import { createHostFiles } from './host-files.mjs';
import { createHostNamespaces } from './host-namespaces.mjs';
import { createHostFocus } from './host-focus.mjs';
import { createHostServices, HOST_SERVICE_TYPES } from './host-services.mjs';
import { installHostTouch } from './host-touch.mjs';
import { HOST_ID_LOCAL, TRANSPORT_WEBSOCKET } from './host-protocol.mjs';
import { createHostLink } from './hostlink/link.mjs';
import { createWebSocketTransport } from '../src/appserver/transport-websocket.mjs';

/**
 * The meta tag the surface writes our configuration into.
 *
 * This is the one string spelled twice -- src/renderer/boot.mjs writes it and
 * this file reads it -- and it is spelled twice because a module under web/ may
 * import only from web/ or from the mounted /src/appserver/ directory, which are
 * the only paths a browser can resolve. A misspelling on either side is not an
 * error, it is an absent config, so the copies are pinned together by a test
 * that patches a document with the writer and reads it back with the reader
 * rather than by a shared constant neither half can reach.
 */
export const BOOT_META_NAME = 'codex-relay-boot';

/** Where the banner is parked, so a second failure replaces it rather than stacking. */
const FAILURE_BANNER_ID = 'codex-relay-boot-failure';

/**
 * Key prefixes for the two stores this file hands out.
 *
 * Two prefixes rather than one, because the two key spaces are minted by
 * different authorities: the fetch layer's keys are endpoint names it chose,
 * and the services layer's are `something-v1` storage names the renderer's own
 * atom factory chose. A collision between them would present as one feature
 * reading another's value, which is a bug with no stack trace at all.
 */
const FETCH_STORE_PREFIX = 'codex-relay-host:fetch:';
const ATOM_STORE_PREFIX = 'codex-relay-host:atom:';
const SHARED_OBJECT_STORE_PREFIX = 'codex-relay-host:shared:';

/** The default websocket path, matching the surface's own default. */
const DEFAULT_WS_PATH = '/ws';

/** Raised when the document carries no config, or an unreadable one. */
export class BootConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BootConfigError';
  }
}

/**
 * Read the configuration the surface wrote into the document.
 *
 * Three lines of decode, deliberately the inverse of what src/renderer/boot.mjs
 * encodes: base64url, UTF-8, JSON. Both halves go through web/base64url.mjs, so
 * the format has nowhere to drift to.
 *
 * Every failure is raised rather than defaulted. A page whose config did not
 * arrive is a page whose websocket path, bridge values and codex home are all
 * guesses, and every one of those guesses produces a renderer that boots and
 * then stalls -- which is exactly the outcome worth trading for a banner that
 * names the missing tag.
 *
 * @param {object} doc a Document
 * @returns {object} the decoded config
 */
export function readBootConfig(doc) {
  if (!doc || typeof doc.querySelector !== 'function') {
    throw new BootConfigError('readBootConfig: a document with querySelector is required');
  }
  const meta = doc.querySelector(`meta[name="${BOOT_META_NAME}"]`);
  if (!meta) {
    throw new BootConfigError(
      `the document carries no <meta name="${BOOT_META_NAME}">; it was served unpatched`,
    );
  }
  const content = typeof meta.getAttribute === 'function'
    ? meta.getAttribute('content')
    : meta.content;
  if (typeof content !== 'string' || content === '') {
    throw new BootConfigError(`<meta name="${BOOT_META_NAME}"> has no content`);
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64urlDecode(content)));
  } catch (error) {
    throw new BootConfigError(`the boot config did not decode: ${error?.message ?? error}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BootConfigError('the boot config decoded to something that is not an object');
  }
  return parsed;
}

/**
 * Paint a failure over the page.
 *
 * The styles are inline and the colours are literal because this has to work in
 * the one situation where our own stylesheet may be the thing that failed, and
 * the z-index is the maximum a 32-bit signed int allows because the bundle's own
 * overlays run as high as 42 and its modals higher. It returns the element so a
 * test can read the text a person would read, and it swallows its own failures
 * because a reporter that throws inside a catch block replaces a diagnosable
 * fault with an undiagnosable one.
 */
export function showBootFailure(window, message) {
  const text = `Codex relay host failed to start.\n${message}`;
  try {
    window.console?.error?.(text);
  } catch {
    // A console that throws is not worth a second thought.
  }
  try {
    const doc = window.document;
    if (!doc || typeof doc.createElement !== 'function') return null;
    const host = doc.body ?? doc.documentElement;
    if (!host || typeof host.appendChild !== 'function') return null;

    const existing = typeof doc.getElementById === 'function' ? doc.getElementById(FAILURE_BANNER_ID) : null;
    const banner = existing ?? doc.createElement('div');
    banner.id = FAILURE_BANNER_ID;
    banner.setAttribute?.(
      'style',
      'position:fixed;top:0;left:0;right:0;z-index:2147483647;'
      + 'background:#7f1d1d;color:#fff;padding:10px 14px;'
      + 'font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap',
    );
    banner.textContent = text;
    if (!existing) host.appendChild(banner);
    return banner;
  } catch {
    // The page is in a worse state than this function can report on. The
    // console line above has already gone out.
    return null;
  }
}

/**
 * The websocket URL for the app-server relay.
 *
 * Built off the document's own location so that the one deployment variable --
 * which origin the phone reached -- never has to be configured. The scheme is
 * derived rather than carried for the same reason: a configured `ws://` on a
 * page served over https is refused by the browser as mixed content, and the
 * error names the socket rather than the config that chose it.
 */
export function webSocketUrl(window, wsPath = DEFAULT_WS_PATH) {
  const url = new URL(wsPath, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

/**
 * A key-value store over `localStorage`, with a memory fallback.
 *
 * This is here rather than in the modules that consume it because the choice is
 * a deployment one. Both the fetch layer and the services layer default to
 * memory, which is correct for their own suites and wrong for a page: global
 * state, settings and the renderer's dismissal atoms all live in those stores,
 * so an in-memory default means onboarding replays on every pull-to-refresh.
 * `localStorage` is the one persistent store a browser offers that needs no
 * protocol on the relay side.
 *
 * Values are JSON round-tripped even in the memory fallback. That is not
 * laziness -- it is the only way the fallback is no more permissive than the
 * real thing. A fallback that stored object identity would let a Map, a Date or
 * a function pass in testing and fail on a phone, which is the class of bug a
 * fallback exists to avoid rather than to introduce.
 *
 * The probe is a write, not a read. Safari in private browsing supplies a
 * `localStorage` that exists and throws on `setItem`, so presence is not
 * availability and the only honest test is to try it.
 */
export function createBootStorage(window, { report = () => {} } = {}) {
  let storage = null;
  try {
    const candidate = window.localStorage ?? null;
    if (candidate && typeof candidate.setItem === 'function') {
      const probe = `${FETCH_STORE_PREFIX}probe`;
      candidate.setItem(probe, '1');
      candidate.removeItem(probe);
      storage = candidate;
    }
  } catch (error) {
    report('storage-unavailable', { reason: error?.message ?? String(error) });
    storage = null;
  }
  if (storage === null) report('storage-in-memory', {});

  const memory = new Map();
  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

  const kv = {
    persistent: storage !== null,

    read(prefix, key) {
      const full = `${prefix}${key}`;
      if (storage === null) return clone(memory.get(full));
      let raw;
      try {
        raw = storage.getItem(full);
      } catch (error) {
        report('storage-read-failed', { key: full, reason: error?.message ?? String(error) });
        return undefined;
      }
      if (raw === null || raw === undefined) return undefined;
      try {
        return JSON.parse(raw);
      } catch (error) {
        // A value somebody else wrote under our prefix, or one left by an older
        // encoding. Treated as absent rather than thrown: every consumer has a
        // defined behaviour for absent and none has one for a parse error.
        report('storage-value-unreadable', { key: full, reason: error?.message ?? String(error) });
        return undefined;
      }
    },

    write(prefix, key, value) {
      const full = `${prefix}${key}`;
      if (storage === null) {
        memory.set(full, clone(value));
        return;
      }
      try {
        storage.setItem(full, JSON.stringify(value));
      } catch (error) {
        // A full quota or a private-browsing refusal. Reported and swallowed:
        // the consumers above translate a store failure into a visible,
        // recoverable outcome (`{success:false}`, an empty state), and an
        // exception here would instead become an unanswered message.
        report('storage-write-failed', { key: full, reason: error?.message ?? String(error) });
      }
    },

    remove(prefix, key) {
      const full = `${prefix}${key}`;
      if (storage === null) {
        memory.delete(full);
        return;
      }
      try {
        storage.removeItem(full);
      } catch (error) {
        report('storage-delete-failed', { key: full, reason: error?.message ?? String(error) });
      }
    },

    /** Every key under one prefix, with the prefix stripped back off. */
    keys(prefix) {
      if (storage === null) {
        return [...memory.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
      }
      const found = [];
      try {
        for (let i = 0; i < storage.length; i += 1) {
          const full = storage.key(i);
          if (typeof full === 'string' && full.startsWith(prefix)) found.push(full.slice(prefix.length));
        }
      } catch (error) {
        report('storage-enumerate-failed', { reason: error?.message ?? String(error) });
      }
      return found;
    },
  };

  return {
    persistent: kv.persistent,

    /**
     * The async `{get, set}` web/host-fetch.mjs asks for. Async because its
     * contract is, not because this implementation needs to be: a store that
     * resolves synchronously still costs no macrotask, which matters because
     * `persisted-atom-sync-request` has a 5000 ms fuse on the renderer's side.
     */
    fetchStore: {
      async get(key) {
        return kv.read(FETCH_STORE_PREFIX, String(key));
      },
      async set(key, value) {
        kv.write(FETCH_STORE_PREFIX, String(key), value ?? null);
      },
    },

    /**
     * The Map-shaped store web/host-services.mjs asks for: `get`, `set`,
     * `delete`, `entries`, all synchronous. `entries()` is what answers a
     * whole-state sync, so it reads the key list each time rather than caching
     * -- a cache here would go stale against a second tab, and two tabs on one
     * phone is the ordinary case rather than the exotic one.
     */
    atomStore: {
      get: (key) => kv.read(ATOM_STORE_PREFIX, String(key)),
      set: (key, value) => kv.write(ATOM_STORE_PREFIX, String(key), value ?? null),
      delete: (key) => kv.remove(ATOM_STORE_PREFIX, String(key)),
      entries: () => kv
        .keys(ATOM_STORE_PREFIX)
        .map((key) => [key, kv.read(ATOM_STORE_PREFIX, key)])
        .filter(([, value]) => value !== undefined)
        .values(),
    },

    /**
     * The shared-object snapshot, which is the one store read SYNCHRONOUSLY
     * and before anything else.
     *
     * `electronBridge.getSharedObjectSnapshotValue(key)` is called from the
     * atom initializer during boot, so this has to be readable with no await
     * and no round trip -- which is why it is backed by the same localStorage
     * kv as the other two rather than by the relay wire. In Electron the
     * equivalent cache lives in the preload and is seeded from main on every
     * reload; here it is seeded from the last page that wrote it.
     *
     * `set` does NOT coerce undefined to null, unlike `atomStore` above. For
     * an atom, null and absent are the same thing. For a shared object they
     * are not: `undefined` is how the renderer says DELETE, and null is a
     * value a shared object can hold. Writing null for a delete would make
     * `pending_worktrees` null on the next load, and that key's atom guards
     * for `undefined` only before calling `.find` on it.
     */
    sharedObjectStore: {
      get: (key) => kv.read(SHARED_OBJECT_STORE_PREFIX, String(key)),
      set: (key, value) => {
        if (value === undefined) {
          kv.remove(SHARED_OBJECT_STORE_PREFIX, String(key));
          return;
        }
        kv.write(SHARED_OBJECT_STORE_PREFIX, String(key), value);
      },
      delete: (key) => kv.remove(SHARED_OBJECT_STORE_PREFIX, String(key)),
      entries: () => kv
        .keys(SHARED_OBJECT_STORE_PREFIX)
        .map((key) => [key, kv.read(SHARED_OBJECT_STORE_PREFIX, key)])
        .filter(([, value]) => value !== undefined)
        .values(),
    },
  };
}

/**
 * Seed settings the host needs the renderer to agree with, without clobbering
 * anything the user has since chosen.
 *
 * There is exactly one entry's worth of reason for this to exist and it is
 * measured: on iOS, focusing an input whose computed font size is under 16px
 * zooms the whole page, and the renderer sizes its own text off this settings
 * value. web/host-touch.css raises the CSS token and floors the rendered size
 * at `max(16px, 1em)`, but it cannot reach every field the renderer sizes from
 * its settings, so the two halves have to agree. Absent keys only: a seed that
 * overwrote would silently undo a choice the user made on the settings screen
 * one reload earlier.
 */
async function seedSettings(store, defaults, report) {
  const entries = Object.entries(defaults ?? {});
  if (entries.length === 0) return 0;
  let stored;
  try {
    stored = await store.get(SETTINGS_KEY);
  } catch (error) {
    report('settings-seed-failed', { reason: error?.message ?? String(error) });
    return 0;
  }
  const values = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};
  let added = 0;
  for (const [key, value] of entries) {
    if (Object.hasOwn(values, key)) continue;
    values[key] = value;
    added += 1;
  }
  if (added === 0) return 0;
  try {
    await store.set(SETTINGS_KEY, values);
  } catch (error) {
    report('settings-seed-failed', { reason: error?.message ?? String(error) });
    return 0;
  }
  report('settings-seeded', { added });
  return added;
}

// ---- the degradations, kept so they can be read afterwards -----------------
//
// WHY ANYTHING IS KEPT
//
// A great deal of what this host does when it cannot do what the renderer
// asked is invisible on purpose: an endpoint with no shape answers `{}`
// (web/host-fetch.mjs:782), a namespace member rejects with its reason in the
// message (web/host-namespaces.mjs:222), a frame carrying somebody else's
// hostId is dropped (web/hostlink/link.mjs:674). Every one of those goes
// through `report` below -- and in the only configuration that ships `onEvent`
// is null, because the entry at the bottom of this file calls
// `bootFromDocument(window)` with no options. So each of them went nowhere,
// and the only way to learn that a session hit three foreign-hostId frames and
// forty unknown endpoints was to have been watching while it happened.
//
// WHAT THIS IS NOT FOR: COUNTING
//
// Every "how many" already has a home on the same handle a reader holds:
// `link.stats` (web/hostlink/link.mjs:1373), `hostFetch.stats()`
// (web/host-fetch.mjs:925), `bus.stats` (web/host-bus.mjs:162),
// `namespaces.stats()` (web/host-namespaces.mjs:697), `handshake.record`,
// `handshake.session.stats()`, and `layers`/`failures` right here. What none
// of them can say is WHICH endpoint, WHICH member, WHICH method, and in what
// order relative to each other. That is what this keeps -- and a kind whose
// whole content is "it happened, n times", with the n already on the handle,
// is excluded below rather than retained.
//
// WHAT MAY NEVER BE IN IT
//
// No user content and no secret: no message bodies, no file contents, no
// paths, no tokens, no session or relay identifiers. That cannot be a rule for
// callers to keep -- `report` is called from seven layers and the next one
// will not have read this -- so it is enforced here, by construction, in three
// steps:
//
//   1. a kind absent from RETAINED_DEGRADATIONS is not recorded at all;
//   2. of a retained kind, only the fields its row names are copied, so a
//      layer that later adds a `body` or a `path` to an event it already
//      reports cannot widen what is kept;
//   3. a copied field must be a string, a number, a boolean or null. An array
//      or an object is refused, because that is the shape a payload arrives
//      in -- and it is why the two capnweb rows keep no `path`, which arrives
//      as an array (web/host-capnweb.mjs:419).
//
// Strings are truncated to MAX_DEGRADATION_TEXT. That bounds the buffer first
// and is a safety net second: `endpoint` is a path segment off a URL the
// renderer built, so its length was never ours to assume.
//
// The exclusions that are decisions rather than oversights:
//
//   * the foreign hostId itself. The event is retained -- it is the one this
//     buffer was asked for -- but with the message `type` only. A hostId is
//     not drawn from a set this host owns: the renderer writes the literals
//     `local` (app-initial-60d038a052d7.js@9232346), `chatgpt`
//     (app-primary-c9f7ac16cee9.js@1676920) and `pages`
//     (content-ad94302e6bcf.js@7408), and main keys its connection registry by
//     `hostConfig.id` (main-C3nRcJ3D.js@14357, and `f.hostConfig.id===`local``
//     @197037), so what lands in that field is whatever a host config carries.
//     `link.stats.foreignHostId` already has the count; the types are the part
//     worth keeping and the id is the part that cannot be shown to be safe.
//   * every `url` and every `requestId` (web/host-fetch.mjs:811, :831). A
//     `codex-fetch://` URL carries the query string the renderer built out of
//     whatever the user typed, and a requestId identifies one request for as
//     long as it is in flight and nothing after that.
//   * `namespaces:clipboard-write` entirely: it reports the LENGTH of the text
//     the user copied (web/host-namespaces.mjs:451), which is a measurement of
//     user content -- and a copy that worked is not a degradation anyway.
//   * `services:handled` except for the outcomes in DEGRADED_SERVICE_OUTCOMES,
//     and then only its `type` and `outcome`: the same event also carries
//     `key`, `root` and `roots` (web/host-services.mjs:478, :513), which are
//     filesystem paths.
//   * `reason` wherever it was written outside this repository. The link's
//     reasons quote an app-server error and the storage ones quote the
//     browser, and nothing bounds what either can say. The four kept below are
//     literals from our own modules -- host-bridge's config refusal,
//     host-namespaces' decline table, host-handshake's two settle paths.
//
//     THERE IS NO FIFTH. An earlier version of this list made one exception,
//     `layer-failed` for `app-server`, on the grounds that it "quotes the
//     server's own userAgent and nothing else". That is true of exactly one of
//     the throws that reaches it -- the no-comparable-version one, which is at
//     web/hostlink/link.mjs:1693 and not at the :1457 that sentence cited --
//     and `layer-failed` is written from two other places that were not read
//     when it was written:
//
//       - the same rejection arm catches the initialize call itself, and a
//         peer that answers with a JSON-RPC error has its `message` copied
//         verbatim by `RpcError.fromResponse` (src/appserver/client.mjs:68-73).
//         The app server is a real process on a real machine and its errors
//         name paths on it.
//       - `layer('link', ...)` constructs the websocket, and
//         `resolveWebSocket` does it unwrapped (`new Ctor(String(target))`,
//         src/appserver/transport-websocket.mjs:32). A browser that refuses
//         the connection throws a DOMException quoting the URL it refused,
//         which is this relay's, `wsPath` and all.
//
//     Both were reproduced at runtime, and both are pinned by tests in
//     test/web/host-boot.test.mjs asserting on the serialised snapshot. The
//     general lesson is the one host-handshake and host-fetch each learned
//     separately: a field is as safe as its WORST writer, and a row reasoned
//     from one caller says nothing about the next.
//   * the peers' protocol faults: `link:malformed-request`,
//     `:duplicate-request-id`, `:malformed-response`, `:unknown-response-id`,
//     `:malformed-mcp-event` and `fetch:body-unparseable`. Each says the other
//     end sent nonsense, not that this host declined to do something, and each
//     is already counted on `link.stats`.
//   * the pure counts: `fetch:reply-dropped` (`hostFetch.stats().dropped`),
//     `fetch:request-duplicate` (`.unanswerable`, and the first request keeps
//     its answer, so nothing is lost), `link:event-stream-limit-reached`
//     (`link.stats.mcpEventSubscriptionsRefused`) and `handshake:duplicate`
//     (`handshake.ignoredCount`).
//   * every `touch:` event. That layer's degradations are cosmetic by
//     definition -- the reason it is the one layer whose failure is reported
//     without a banner -- and a touch layer that did not install at all is
//     already here as `layer-failed`.
//   * `focus:pushed`, which is a success and fires on every tab switch. Its
//     `isFocused` is also the one field in this file that is a direct
//     observation of the person rather than of the software: retained, it
//     would be a timestamp-free but strictly ordered record of every time they
//     looked at the page and looked away. `focus.stats()` has the counts for
//     anyone debugging, and they do not outlive the page.
//
//     `focus:deliver-failed` IS kept, with `isFocused`, and the asymmetry is
//     deliberate: one of those is a sample of a habit and the other is a
//     single event that cannot recur without the first one having worked.

/**
 * How many entries the ring keeps.
 *
 * This runs for the life of a page that may be open for hours, and nothing
 * rate-limits the events below: `fetch:endpoint-unimplemented` fires once per
 * poll of an endpoint nobody implemented, which is every few seconds, forever.
 * An unbounded array here would make the diagnostics layer the thing that
 * leaks, which is the most embarrassing available outcome.
 *
 * 256 is sized to hold one of everything this host can distinguish, counted
 * rather than guessed. The dominant axis is the endpoint name: KNOWN_ENDPOINTS
 * has 150 entries (web/host-fetch.mjs:227), 133 of which reach
 * `endpoint-unimplemented` today because only 17 have a builtin
 * (web/host-fetch.mjs:1088), and an endpoint reaches at most ONE of the two
 * endpoint-carrying rows -- it either has a handler, and can throw, or it does
 * not, and is unimplemented -- so those two rows together are bounded by 150.
 * `namespaces:declined` adds one per declined member, of which there are three
 * (web/host-namespaces.mjs:501, :641, :648). The other 37 rows of
 * RETAINED_DEGRADATIONS are one-of-a-kind. A session that degraded in every
 * distinct way it is able to distinguish is therefore 190 entries, and the
 * remaining 66 are headroom for the rows keyed by a message type or a method
 * name: those domains are open, because the next App update adds types.
 *
 * THIS NUMBER WAS 192 AND WAS WRONG, which is the argument for recomputing it
 * here rather than trusting the paragraph above on a later read. The same
 * arithmetic was written against a 102-entry endpoint table; the table has
 * since grown to 150 without this constant moving, so the "52 of headroom" it
 * claimed was in fact 2, and one busy session could have evicted the record of
 * everything that was not an endpoint. Nothing failed and no test went red --
 * the ring is bounded either way, and a bound doing its job and a bound set
 * from a stale premise look identical from outside. Re-derive it when
 * KNOWN_ENDPOINTS moves.
 *
 * Past that the oldest entry goes and `dropped` counts it, while the per-kind
 * totals survive eviction -- so a flood of one endpoint can make the record of
 * everything else older, but cannot make it look as though it never happened.
 * The cost is bounded by construction: 192 entries of a few short fields, every
 * string capped at MAX_DEGRADATION_TEXT, is tens of kilobytes.
 */
export const MAX_DEGRADATIONS = 256;

/** The longest any one retained string may be. See the header on `endpoint`. */
const MAX_DEGRADATION_TEXT = 160;

/**
 * The kinds the ring keeps, and the only fields it keeps off each of them.
 *
 * A row is here if its arrival means the renderer asked for something and did
 * not get it, or that this host installed or persisted less than it meant to.
 * The kinds are the ones `report` emits, which are prefixed by the layer they
 * came from -- see the note on `report` for why that is true now and was not
 * before.
 */
const RETAINED_DEGRADATIONS = new Map([
  // Boot's own. `layer-failed` is the one row also readable from `failures`
  // below, and it is kept anyway because it anchors the sequence: a declined
  // member three entries after a layer that did not install explains itself,
  // and the two read apart do not.
  //
  // It keeps the layer NAME and not the reason, and the reason it does not is
  // worth stating here rather than only in the header: this row is written
  // from `layer()` for any of seven layers and from the app-server rejection
  // arm, and two of those paths carry text nobody in this repository wrote.
  // `failures` on the handle still has the full reason for a reader looking at
  // the page now, and the banner still shows it to the user whose page it is.
  // What `snapshot()` exports is the record that outlives the page.
  ['layer-failed', ['layer']],
  ['transport-error', []],
  ['outbound-unclaimed', ['type']],
  // The seed that did not land is the iOS zoom: an input under 16px zooms the
  // whole page on focus, and this is the half of the fix that is not CSS.
  ['settings-seed-failed', []],

  // The stores. Global state, settings and every dismissal atom live here, so
  // each of these is a value the renderer believes it wrote or read and that
  // is not there -- the difference between a session that onboards once and
  // one that onboards on every pull-to-refresh. None of them has a counter.
  // The `key` they carry is left behind: it names a renderer atom.
  ['storage-unavailable', []],
  ['storage-in-memory', []],
  ['storage-read-failed', []],
  ['storage-write-failed', []],
  ['storage-delete-failed', []],
  ['storage-enumerate-failed', []],
  ['storage-value-unreadable', []],
  // The shared-object seed, which is the one store read that happens before
  // anything can report a `storage-` kind: it runs at step 0, above the
  // bridge, because the bridge's snapshot is frozen at install. A failure here
  // is not a lost write -- it is the previous page's writes not reaching this
  // one, so `getSharedObjectSnapshotValue` answers from the bridge defaults and
  // a key the renderer stored last session reads as though it had never been
  // set. It carries no key: the whole enumeration failed, not one entry.
  ['shared-object-seed-failed', []],

  // The fetch layer. `endpoint` is the entire point of keeping these: the
  // count is already on `hostFetch.stats().unknown`, and only the names say
  // which endpoint the next App update needs a shape for.
  // `shaped` rides along with `known` for the same reason and on the same
  // terms: a boolean this repository computed, which sorts the endpoint list
  // into "answered from the measured shape table" and "answered from the
  // blank". The second set is the work; without the field a census of a real
  // session cannot point at it. See web/host-fetch.mjs `routeFor`.
  ['fetch:endpoint-unimplemented', ['endpoint', 'known', 'shaped']],
  ['fetch:endpoint-threw', ['endpoint']],
  ['fetch:url-unroutable', []],
  // No requestId on it, so nothing can ever answer it and the renderer -- which
  // has no timeout on this type -- waits for the life of the page.
  ['fetch:request-unanswerable', []],
  ['fetch:deliver-failed', []],
  ['fetch:store-write-failed', []],

  // The namespaces: the members this host serves and cannot implement. The
  // reason is a literal from that module's own decline table, and it is what
  // the renderer was told too, so keeping it costs nothing and reading it
  // saves a trip through the source.
  ['namespaces:declined', ['member', 'reason']],
  ['namespaces:open-in-declined', ['target']],
  ['namespaces:clipboard-unavailable', []],

  // The handshake, and the capnweb session behind it. The renderer awaits
  // `session.services` with no timeout, so every one of these is a candidate
  // for the startup logo spinning forever -- the failure this file's header
  // calls the most expensive one in the repository.
  ['handshake:unanswered', ['reason']],
  ['handshake:failed', ['reason']],
  ['handshake:refused-foreign-source', []],
  ['capnweb:send-failed', []],
  ['capnweb:push-unsupported', ['op']],
  ['capnweb:frame-unrecognised', ['shape']],
  ['capnweb:frame-unhandled', ['op']],

  // The link. `must-succeed-repaired` is the one to read first: it is the
  // host substituting a result for a method the renderer cannot survive the
  // failure of, which is the closest this codebase comes to a fake success and
  // is therefore the thing a reader most wants named rather than counted.
  ['link:foreign-host-id', ['type']],
  ['link:unanswerable-request', []],
  ['link:uncarryable-result', ['method', 'resultType']],
  ['link:must-succeed-repaired', ['method']],
  ['link:emit-failed', ['type']],
  // On close the link rejects every outstanding approval (link.mjs:1290). The
  // renderer renders the disconnect, but nothing tells it which calls died.
  ['link:transport-closed', []],
  ['link:restart-requested', []],
  ['link:restart-handler-threw', []],

  // The services layer. Gated: see DEGRADED_SERVICE_OUTCOMES.
  ['services:handled', ['type', 'outcome']],
  ['services:threw', ['type']],
  ['services:undelivered', ['type']],

  // The focus layer, and only its failure: `focus:pushed` is deliberately not
  // here for the same reason `services:handled`'s successes are gated out --
  // it fires on every tab switch, and on a phone that is constant.
  //
  // A delivery that throws is kept because of what the renderer does with this
  // type and nothing else does: the focus atom starts at `null` (not `false`),
  // so a renderer that is never told is in neither state, and the renderer has
  // handed TanStack Query's focus manager this message as its ONLY event
  // source in place of `visibilitychange`. One dropped push is therefore a
  // query layer that stops refetching for the life of the page, with nothing
  // on screen to say so. `isFocused` rides along because which direction was
  // lost decides what is stale: a lost `false` leaves it refetching in the
  // background, a lost `true` leaves it not refetching in the foreground.
  ['focus:deliver-failed', ['isFocused']],
]);

/**
 * The `services:handled` outcomes that are degradations.
 *
 * That layer reports one event per message handled (web/host-services.mjs:308)
 * and most of them are ordinary successes -- `stored`, `deleted`, `answered`,
 * `emitted`, and now `mirrored` and `cleared` from the shared-object mirror --
 * which would flood a ring this size with the renderer's atom traffic inside a
 * minute. The mirror's two deserve naming rather than silent omission: they
 * are high-frequency for the same reason `stored` is, and the mirror is a
 * best-effort copy whose success is not a fact anyone needs to read later.
 *
 * These six are the ones where the renderer asked and did not get it: a store
 * that refused, a message we could not read, a type nobody claimed, the
 * onboarding workspace pick this host cancels because no browser picker yields
 * a filesystem path, the skip it has to refuse, and a `shared-object-set`
 * dropped for want of a usable key.
 */
const DEGRADED_SERVICE_OUTCOMES = new Set([
  'store-failed',
  'malformed',
  'unclaimed',
  'canceled',
  'refused',
  'ignored',
]);

/**
 * A bounded record of the things this host could not do.
 *
 * ORDERING. Each entry carries a sequence number over RETAINED entries, not
 * over all events, which makes `entries[0].seq - 1` equal to `dropped` and lets
 * a reader confirm the two agree. A sequence over everything would be more
 * information and worse: a gap of four hundred between two entries would read
 * as four hundred lost degradations where four hundred ordinary events merely
 * went past.
 *
 * NO TIMESTAMP. `Date.now()` is available here and is deliberately not used.
 * What it would add is duration arithmetic a reader can get by sampling twice;
 * what it would cost is a precise record, held for the life of the page, of
 * when the person was using it -- which is exactly the class of metadata the
 * paragraph above promises this buffer does not keep.
 */
function createDegradationRing() {
  /** @type {{seq: number, kind: string}[]} */
  const entries = [];
  const counts = Object.create(null);
  let dropped = 0;
  let seq = 0;

  return {
    /**
     * Record one event, if it is one of the retained kinds.
     *
     * The whole body is inside a try for the reason web/host-namespaces.mjs
     * gives at its own `report`: a diagnostic must not be able to take down the
     * call it is observing. Nothing in here should throw, which is precisely
     * the claim a catch exists to make unfalsifiable.
     */
    record(event) {
      try {
        const kind = event?.kind;
        const fields = typeof kind === 'string' ? RETAINED_DEGRADATIONS.get(kind) : undefined;
        if (fields === undefined) return;
        if (kind === 'services:handled' && !DEGRADED_SERVICE_OUTCOMES.has(event.outcome)) return;

        seq += 1;
        const entry = { seq, kind };
        for (const field of fields) {
          const value = event[field];
          if (typeof value === 'string') {
            entry[field] = value.length > MAX_DEGRADATION_TEXT
              ? `${value.slice(0, MAX_DEGRADATION_TEXT)}...`
              : value;
          } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
            entry[field] = value;
          }
          // Everything else -- an array, an object, a function, an absent
          // field -- is left out. See step 3 of the header.
        }
        counts[kind] = (counts[kind] ?? 0) + 1;

        entries.push(entry);
        if (entries.length > MAX_DEGRADATIONS) {
          // `shift()` on an array of this many small objects is nothing, and a
          // modular write index would be a second thing to get wrong in a layer
          // whose entire promise is that it cannot break anything.
          entries.shift();
          dropped += 1;
        }
      } catch {
        // A diagnostic that costs a host call is worse than no diagnostic.
      }
    },

    /** A copy at both levels: entries are rebuilt, not handed out. */
    snapshot() {
      return {
        capacity: MAX_DEGRADATIONS,
        dropped,
        counts: { ...counts },
        entries: entries.map((entry) => ({ ...entry })),
      };
    },
  };
}

/**
 * Assemble the host onto a window.
 *
 * Synchronous by design: everything the renderer reads during its own
 * synchronous boot is in place by the time this returns, and the one round trip
 * -- the app server's `initialize` handshake -- is left on the returned
 * `announced` promise rather than awaited, because awaiting it would mean the
 * renderer's entry evaluates with no bridge on the window.
 *
 * @param {object} options
 * @param {object} options.window the window to assemble onto
 * @param {object} options.config the decoded boot config
 * @param {object} [options.transport] an app-server transport, for a caller that
 *   has one already; by default a websocket is opened at `config.wsPath`
 * @param {object} [options.storage] a store pair as returned by
 *   createBootStorage, for a caller that wants a different backing store
 * @param {(kind: string, detail: object) => void} [options.onEvent]
 * @param {(window: object, message: string) => unknown} [options.showFailure]
 */
export function installHostBoot({
  window,
  config,
  transport = null,
  storage = null,
  onEvent = null,
  showFailure = showBootFailure,
} = {}) {
  if (!window || typeof window !== 'object') {
    throw new TypeError('installHostBoot: a window is required');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('installHostBoot: a decoded boot config object is required');
  }

  const ring = createDegradationRing();

  /**
   * Every event this assembly emits: to the ring first, to the caller second.
   *
   * `kind` is written AFTER the detail is spread, and that is a repair rather
   * than a style. The sub-layers below hand their own event object through as
   * `detail`, and that object carries its own `kind`, so `{kind: 'link:' +
   * event.kind, ...event}` resolved back to the UNPREFIXED name: every prefix
   * this file computes was being discarded at the moment it was applied, and
   * `fetch:endpoint-unimplemented` reached a consumer as
   * `endpoint-unimplemented`. That is worse than cosmetic, because the
   * unprefixed names collide across layers -- `failed`, `duplicate`,
   * `rejected`, `request-unanswerable` against `unanswerable-request` -- so a
   * consumer filtering on one of them was filtering on several. The ordering
   * here is the one web/host-protocol.mjs:395 already uses, for the same
   * reason: the known keys are written after the spread so that a caller
   * cannot shadow them.
   *
   * One event still arrives pre-clobbered by the same bug one module down:
   * host-capnweb's `exported` carries a `kind` FIELD of its own
   * (`'function' | 'namespace'`, web/host-capnweb.mjs:301), so it reaches this
   * file as `kind: 'function'` and leaves it as `capnweb:function`. That is
   * that module's to fix, it is not a retained kind, and it is noted here
   * rather than worked around.
   *
   * The ring is told BEFORE `onEvent` runs, so a consumer that throws -- or
   * one that mutates the event it was handed -- cannot cost the host its
   * record of what went wrong.
   */
  const report = (kind, detail = {}) => {
    const event = { ...detail, kind };
    ring.record(event);
    if (typeof onEvent !== 'function') return;
    try {
      onEvent(event);
    } catch {
      // The discipline every other host module follows: an observer is a
      // diagnostic, and one that throws must not be able to take down the thing
      // it is observing.
    }
  };

  /** @type {{name: string, ok: boolean, reason: string | null}[]} */
  const layers = [];
  const failures = [];

  /**
   * Install one layer, and keep going if it fails.
   *
   * `visible` is the question "does the absence of this layer hang the
   * renderer?" -- true for every layer that answers a blocking outbound type,
   * false for the touch layer, whose absence is a page that is merely awkward on
   * a phone. Only a visible failure paints the banner, because a banner for a
   * cosmetic fault is a banner the user learns to dismiss unread.
   */
  const layer = (name, visible, install) => {
    try {
      const value = install();
      layers.push({ name, ok: true, reason: null });
      report('layer-installed', { layer: name });
      return value;
    } catch (error) {
      const reason = error?.message ?? String(error);
      layers.push({ name, ok: false, reason });
      failures.push({ name, reason, visible });
      report('layer-failed', { layer: name, reason });
      if (visible) {
        try {
          showFailure(window, `${name}: ${reason}`);
        } catch {
          // See showBootFailure: a reporter that throws inside a catch turns a
          // diagnosable fault into an undiagnosable one.
        }
      }
      return null;
    }
  };

  // 0. The stores, which install nothing and are up here only because the
  //    bridge below needs one. `getSharedObjectSnapshotValue` is read
  //    synchronously from an atom initializer during boot, so the snapshot has
  //    to be complete before the bridge is built -- there is no later moment to
  //    fill it in, and a key read once is never read again.
  const stores = storage ?? createBootStorage(window, { report });

  /**
   * The shared-object snapshot the bridge will answer from.
   *
   * Three layers, last wins: the bridge's own defaults (applied inside
   * `installElectronBridge`, and the reason `pending_worktrees` is `[]` rather
   * than absent), then whatever the surface put in the boot config, then what
   * the last page wrote through `shared-object-set`.
   *
   * The stored layer wins because it is the newer one. This is the relay's
   * stand-in for Electron's preload re-seeding itself off main on every reload
   * (`A=ipcRenderer.sendSync('codex_desktop:get-shared-object-snapshot')??{}`,
   * preload.js@2863); without it a reload drops whatever the page had set, and
   * on a phone a reload is something the browser does on its own.
   */
  const storedSharedObjects = (() => {
    const seeded = {};
    try {
      for (const [key, value] of stores.sharedObjectStore.entries()) {
        if (typeof key === 'string' && value !== undefined) seeded[key] = value;
      }
    } catch (error) {
      // A store that cannot be enumerated is a boot that continues with the
      // config's snapshot, not a boot that fails. Reported so the loss is
      // visible rather than inferred from a missing draft.
      report('shared-object-seed-failed', { reason: error?.message ?? String(error) });
    }
    return seeded;
  })();

  // 1. The bridge, first among the things that install, because its four
  //    synchronous readers are the earliest thing in the renderer and the only
  //    ones with no slack at all.
  const bridge = layer('bridge', true, () => installElectronBridge({
    window,
    config: {
      ...(config.bridge ?? {}),
      sharedObjectSnapshot: {
        ...(config.bridge?.sharedObjectSnapshot ?? {}),
        ...storedSharedObjects,
      },
    },
  }));

  // 2. The touch layer. Safe before React mounts -- that is the case it was
  //    designed for, and its MutationObserver is what picks the app-shell frame
  //    up when the renderer finally renders one.
  const touch = config.touch?.enabled === false
    ? null
    : layer('touch', false, () => installHostTouch({
      window,
      ...(typeof config.touch?.stylesheetHref === 'string'
        ? { stylesheetHref: config.touch.stylesheetHref }
        : {}),
      onEvent: (kind, detail) => report(`touch:${kind}`, detail ?? {}),
    }));

  // 3. The link, which OWNS the bus. This is the one piece of the assembly that
  //    is not a free choice: createHostLink builds its own bus internally, so a
  //    second createHostBus here would put two capture listeners on the same
  //    window and hand every outbound message to both. Everything downstream
  //    therefore takes the bus out of the link rather than making one.
  const link = layer('link', true, () => {
    const wire = transport ?? createWebSocketTransport(
      webSocketUrl(window, typeof config.wsPath === 'string' && config.wsPath !== '' ? config.wsPath : DEFAULT_WS_PATH),
      { onError: (error) => report('transport-error', { reason: error?.message ?? String(error) }) },
    );
    return createHostLink({
      window,
      transport: wire,
      hostId: typeof config.hostId === 'string' && config.hostId !== '' ? config.hostId : HOST_ID_LOCAL,
      onEvent: (event) => report(`link:${event?.kind ?? 'event'}`, event ?? {}),
      onProtocolError: (error) => report('link:protocol-error', { reason: error?.message ?? String(error) }),
      // The renderer asks for a restart when it has decided its host is
      // unhealthy, and the link's own note on that path is why this handler is
      // not left null: with nobody listening, the renderer settles down to wait
      // for a `codex-app-server-initialized` that is not coming.
      //
      // Nothing in a browser tab can restart a process on the relay host, and
      // re-announcing is refused -- correctly -- because a second announcement
      // would have the renderer stand up a second request client against the
      // same hostId. What DOES produce a clean restart is a page reload: a new
      // socket, a new link, a fresh handshake. So the only useful thing this
      // handler can do is say so, to the person holding the phone, in the one
      // channel that reaches them.
      onRestartRequested: () => {
        try {
          showFailure(window, 'the app server was asked to restart, which this host cannot do. Reload the page.');
        } catch {
          // See showBootFailure.
        }
      },
    });
  });
  const bus = link?.bus ?? null;

  // 4. The capnweb handshake. The renderer opens a MessageChannel, posts port2
  //    to its own window, and then awaits `session.services` with NO timeout --
  //    so an unanswered handshake is the startup logo forever. Subscribing here,
  //    before the entry runs, is what makes being late impossible.
  //    The namespaces the handshake answers with. Built as its own layer so
  //    that a throw in here paints the banner naming `namespaces` rather than
  //    `handshake`, and so a probe can read its call counters.
  //    `appInfo` comes from the same config the Electron bridge already
  //    requires, because `appInfo.get()` is the one member whose RESULT the
  //    renderer derefs bare -- and because `version`/`buildNumber` are what a
  //    feedback submission reports as `app_version`/`app_build`, so a default
  //    here becomes a placeholder in somebody's bug report.
  //    The resident machine's filesystem, over the client the link already
  //    owns. Built here, between the link and the namespaces, because that is
  //    the only window in this function where both facts are true: the client
  //    exists, and nothing has been handed to the renderer yet.
  //
  //    NOT visible, unlike its two neighbours. A failed bridge or a failed link
  //    is a renderer that cannot work and has to say so on the screen; a failed
  //    file layer is two namespace members that go back to rejecting with the
  //    message they shipped with, which is a missing feature rather than a
  //    broken page. Painting a banner over the whole app for it would be the
  //    wrong trade on a phone.
  //
  //    `call` is a closure rather than `link.client.call` bound once, so the
  //    client is dereferenced at call time: the first read may well happen
  //    before or after a reconnection, and whichever client is current then is
  //    the one that should carry it.
  const files = link === null ? null : layer('files', false, () => createHostFiles({
    //    It forwards its third argument, which is the one that makes the
    //    deadline a cancellation rather than only a rejection: `client.call`
    //    takes `{ signal }` and marks an aborted entry abandoned, so the
    //    socket stops holding a reply nobody is waiting for any more. Dropping
    //    the argument here still gives the caller its error -- the deadline is
    //    raced, not delegated -- but leaves the request live on the transport,
    //    which on a phone that has already given up is a reply arriving for a
    //    screen that moved on.
    call: (method, params, options) => link.client.call(method, params, options),
    onEvent: (event) => report(`files:${event?.kind ?? 'event'}`, event ?? {}),
  }));

  const namespaces = layer('namespaces', true, () => createHostNamespaces({
    onEvent: (event) => report(`namespaces:${event?.kind ?? 'event'}`, event ?? {}),
    // Null when the layer above failed or was disabled, and null is a
    // supported value: the member then writes through `navigator` itself.
    appInfo: {
      version: config.bridge?.appVersion,
      buildNumber: config.bridge?.buildNumber,
      buildFlavor: config.bridge?.buildFlavor,
    },
    // Null is a supported value here too, and it is the pre-existing
    // behaviour: `workspaceFiles.read` and `fileAttachments.countFolderFiles`
    // go back to rejecting with a message that names the adapter.
    files,
  }));

  //    `services` defaults to `{}` in installHandshake, and that default is
  //    what crashed the page: 117 of the renderer's 125 namespaces degrade
  //    on absence, 8 do not. Passing the real object is the fix; passing `{}`
  //    on a failed namespaces layer is still better than not answering the
  //    handshake at all, because an unanswered `services` pull is a startup
  //    logo forever.
  const handshake = layer('handshake', true, () => installHandshake({
    window,
    services: namespaces?.services ?? {},
    createSession: (port, mainObject) => createCapnwebSession(port, mainObject, {
      onEvent: (event) => report(`capnweb:${event?.kind ?? 'event'}`, event ?? {}),
    }),
    onEvent: (event) => report(`handshake:${event?.kind ?? 'event'}`, event ?? {}),
  }));

  // 5. The fetch layer. `deliver` is injected because web/host-bus.mjs exposes
  //    no typed emitter for `fetch-response` and never will -- the bus's typed
  //    emitters are the app-server lifecycle, and an endpoint layer is not that.
  //    The generic `bus.deliver` is the seam, and routing through it rather than
  //    dispatching a MessageEvent here is what keeps `bus.stats.emitted` a true
  //    count of what reached the renderer.
  const hostFetch = bus === null ? null : layer('fetch', true, () => {
    const created = createHostFetch({
      deliver: (message) => bus.deliver(message),
      // The same filesystem the two namespace members got, because the four
      // file endpoints in there answer the same questions through the other of
      // the renderer's two host channels. Null when the link failed, which
      // each of those endpoints turns into its own 501.
      files,
      store: stores.fetchStore,
      codexHome: config.fetch?.codexHome ?? null,
      workspacesRoot: config.fetch?.workspacesRoot ?? null,
      worktreesSegment: config.fetch?.worktreesSegment ?? null,
      workspaceRoots: Array.isArray(config.fetch?.workspaceRoots) ? config.fetch.workspaceRoots : [],
      projectlessRoot: typeof config.fetch?.projectlessRoot === 'string'
        ? config.fetch.projectlessRoot
        : null,
      accountInfo: config.fetch?.accountInfo ?? null,
      onEvent: (event) => report(`fetch:${event?.kind ?? 'event'}`, event ?? {}),
    });
    created.attach(bus);
    return created;
  });

  // 6. The services layer: persisted atoms, and the three onboarding types that
  //    also have no timeout. It RETURNS replies rather than posting them, which
  //    is why the subscription below is a loop over its own claimed types and
  //    not a single wildcard -- the bus fans a type to its typed handlers only,
  //    so a wildcard subscriber would also be handed traffic the link owns.
  const services = bus === null ? null : layer('services', true, () => {
    const created = createHostServices({
      store: stores.atomStore,
      // The same store the bridge's snapshot was seeded from, closing the
      // loop: what the page writes here is what the next load reads there.
      sharedObjects: stores.sharedObjectStore,
      onEvent: (event) => report('services:handled', event ?? {}),
    });
    for (const type of HOST_SERVICE_TYPES) {
      bus.on(type, (message) => {
        // `handle` is documented never to reject, and the rejection arm is here
        // anyway: the contract belongs to another module, and the cost of being
        // wrong about it is an unanswered onboarding dialog.
        created.handle(message).then(
          (replies) => {
            for (const reply of replies) {
              try {
                bus.deliver(reply);
              } catch (error) {
                report('services:undelivered', {
                  type: reply?.type,
                  reason: error?.message ?? String(error),
                });
              }
            }
          },
          (error) => report('services:threw', { type: message?.type, reason: error?.message ?? String(error) }),
        );
      });
    }
    return created;
  });

  // 7. Window focus. Last of the subscribing layers and the smallest, but the
  //    one with the sharpest failure: see its header for the atom that starts
  //    at `null`, and for why a host that answers the first request and then
  //    goes quiet is worse off than one that never answers -- the renderer
  //    hands TanStack Query's focus manager this message as its ONLY event
  //    source, replacing the library's own `visibilitychange` listener.
  const focus = bus === null ? null : layer('focus', false, () => createHostFocus({
    window,
    deliver: (message) => bus.deliver(message),
    onEvent: (kind, detail) => report(`focus:${kind}`, detail ?? {}),
  }).attach(bus));

  // Outbound traffic nobody claimed. The bus keeps this off `onAny` for
  // `log-message` only, so what arrives here is genuinely new -- a type the next
  // App update added. Reported rather than ignored, because the alternative is
  // finding out about it from a user describing a button that does nothing.
  //
  // It only means that as long as everything already read IS claimed, which is
  // what `ELECTRON_ONLY_PUSHES` is for: twenty-five types that a sweep found owe
  // a tab nothing are consumed by the services layer rather than left to arrive
  // here every session and make this line unreadable.
  if (bus !== null) {
    bus.onAny((message) => report('outbound-unclaimed', { type: message?.type ?? null }));
  }

  // The settings seed is a write, so it cannot be synchronous against an async
  // store. It is deliberately not awaited by anything the renderer waits on: the
  // worst case is one early `get-settings` answered without the seed, and the
  // renderer refetches that query on its own invalidations.
  const seeded = hostFetch === null
    ? Promise.resolve(0)
    : seedSettings(stores.fetchStore, config.settings ?? {}, report);

  /**
   * The handshake with the app server, and the one place the renderer is told
   * what version it is talking to.
   *
   * Not awaited here, and the failure arm matters more than the success one: a
   * link that cannot name a comparable version throws, and the throw has to
   * become a banner rather than a substituted literal. See the file header on
   * why `0.0.0` is the one answer that is worse than no answer.
   */
  const announced = link === null
    ? Promise.resolve(null)
    : link.startFromHandshake({
      transport: TRANSPORT_WEBSOCKET,
      // Both optional, and both left absent rather than defaulted. The link
      // falls `installedCodexVersion` back to the version the server reported,
      // which is the right answer when the relay has not been told the CLI's
      // own version, and `isSnapshot` only annotates the announcement.
      ...(typeof config.installedCodexVersion === 'string' && config.installedCodexVersion !== ''
        ? { installedCodexVersion: config.installedCodexVersion }
        : {}),
      ...(typeof config.isSnapshot === 'boolean' ? { isSnapshot: config.isSnapshot } : {}),
    }).then(
      (resolved) => {
        report('app-server-announced', {
          appServerVersion: resolved.appServerVersion,
          installedCodexVersion: resolved.installedCodexVersion,
        });
        return resolved;
      },
      (error) => {
        const reason = error?.message ?? String(error);
        failures.push({ name: 'app-server', reason, visible: true });
        report('layer-failed', { layer: 'app-server', reason });
        try {
          showFailure(window, `app-server: ${reason}`);
        } catch {
          // See showBootFailure.
        }
        return null;
      },
    );

  return {
    get bridge() {
      return bridge;
    },
    get touch() {
      return touch;
    },
    get link() {
      return link;
    },
    get bus() {
      return bus;
    },
    get handshake() {
      return handshake;
    },
    get namespaces() {
      return namespaces;
    },
    get hostFetch() {
      return hostFetch;
    },
    get services() {
      return services;
    },
    get focus() {
      return focus;
    },
    get stores() {
      return stores;
    },
    /** Resolves with the versions the server reported, or null if it could not. */
    announced,
    /** Resolves with how many settings keys the seed actually wrote. */
    seeded,
    /** Every layer, in install order, with the reason any of them failed. */
    get layers() {
      return layers.map((entry) => ({ ...entry }));
    },
    /** The failures a person should be told about, including a late one. */
    get failures() {
      return failures.map((entry) => ({ ...entry }));
    },
    /**
     * Everything this host could not do, as `{capacity, dropped, counts,
     * entries}`. See the section above `installHostBoot` for what is in it.
     *
     * A FUNCTION, and the reason is the reader on the other end rather than
     * taste. web/host-namespaces.mjs returns its `stats` beside the services
     * object because every own key on that object becomes a namespace the page
     * can see; the equivalent constraint here is that this handle is what the
     * entry at the bottom of this file parks on `globalThis.__codexRelayHostBoot`,
     * and the only reader that picks it up off a phone is a CDP
     * `Runtime.evaluate` with `returnByValue: true` (tools/probe/bridge-readout.mjs:90),
     * which can carry back only what serialises. This handle as a whole does
     * not: `announced` and `seeded` are promises and `bus`, `link` and
     * `handshake` are live objects with listeners on them. So a probe cannot
     * read the handle, only an expression naming a serialisable part of it --
     * and a function is what lets it name this part and nothing else. An array
     * property would also be live host state within reach of any page script
     * that can spell the global, which is the same reason `layers` and
     * `failures` above hand back copies.
     */
    degradations: () => ring.snapshot(),
    get ok() {
      return failures.length === 0;
    },
    /**
     * Tear the host down. Only tests and a hot reload have a use for this.
     *
     * `handshake.unsubscribe()` stops the window listener; it deliberately does
     * NOT touch the session it produced, because staying subscribed after a
     * session exists is how a second handshake gets counted instead of passing
     * unseen -- see web/host-handshake.mjs. That leaves the session itself to
     * this function, and until now nothing closed it. The session owns the
     * MessagePort the renderer transferred, with `onmessage` assigned; an
     * uninstalled host that keeps that assignment keeps the port alive, keeps
     * the renderer's end of the channel entangled with a dead host, and -- in
     * the one place uninstall is actually used, a hot reload -- leaves the old
     * session answering capnweb frames on a port the new one knows nothing
     * about. `close()` is idempotent, so calling it on a handshake that never
     * produced a session, or twice, is a no-op.
     */
    async uninstall() {
      if (link) await link.close();
      touch?.uninstall?.();
      // Before the handshake, and for the same reason the touch layer is: it
      // holds window listeners, and a host left with live listeners after a
      // hot reload pushes focus changes through a bus the new one replaced.
      focus?.uninstall?.();
      handshake?.unsubscribe?.();
      handshake?.session?.close?.();
      bridge?.uninstall?.();
    },
  };
}

/**
 * Read the config out of the document and assemble.
 *
 * Separated from installHostBoot so that a config that did not arrive -- the
 * served document was not patched, or was patched by an older surface -- is
 * reported as exactly that, with the tag named, instead of as six downstream
 * layers that each failed for their own reason.
 */
export function bootFromDocument(window, options = {}) {
  let config;
  try {
    config = readBootConfig(window?.document);
  } catch (error) {
    showBootFailure(window, error?.message ?? String(error));
    return null;
  }
  try {
    return installHostBoot({ window, config, ...options });
  } catch (error) {
    // installHostBoot throws only on a bad window or a bad config, both of which
    // are already covered above -- but it runs at the top of a module script,
    // where an escaped throw is a page that stops loading with one line in a
    // console no phone can open.
    showBootFailure(window, error?.message ?? String(error));
    return null;
  }
}

// The entry. Guarded on `window === globalThis` rather than on the presence of a
// document, because that is the test that distinguishes a browser from this
// suite with no false answer in either direction -- and because guarding on the
// meta tag instead would make an unpatched document boot nothing at all, in
// silence, which is the failure this file exists to make visible.
if (typeof globalThis.window === 'object' && globalThis.window !== null && globalThis.window === globalThis) {
  globalThis.__codexRelayHostBoot = bootFromDocument(globalThis.window);
}
