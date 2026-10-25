// The wiring: a renderer request becomes a JSON-RPC call, and its reply comes
// back as the one field name that actually settles it.
//
// `web/host-*.mjs` is a bus with nothing on the far end, and
// `src/appserver/client.mjs` is a JSON-RPC client with nothing in front of it.
// Both were built against the real thing and both were deliberately left
// unconnected, because each is exhaustively testable alone and neither needed
// the other to be proved. This file is the only place where they meet, and the
// constraint that gives it a directory of its own rather than a home inside
// either side is that `web/host-bus.mjs` is pinned by its own suite to a single
// import -- the vocabulary -- and nothing else. The bus must stay something you
// can test with no transport at all. So the import that crosses the seam lives
// here, pointing at both sides, and the bus never learns what an app-server is.
//
// It first landed under `src/`, on the reading that "not inside the bus" meant
// "not under `web/`". That was over-reading the constraint -- the bus's import
// list does not depend on where its consumer sits -- and the price was the
// deployment obligation that used to be recorded below. The directory is settled
// by the browser's resolver instead, which is the one reader with no say in it.
//
// WHAT THIS FILE OWNS. A client, a bus, two correlation tables and one gate:
//
//   renderer --mcp-request-->  [id 7]  --> client.call() --> [id 1] --> server
//   renderer <--mcp-response-- [id 7]  <-- resolve       <-- [id 1] <-- server
//
// The two ids in that diagram are the whole job. The renderer mints INTEGER
// ids and owns the promise table and the timeouts for them; the client mints
// its own integers from 1 and owns a different table. They are not the same
// number and must never be assumed to be: the renderer's id is data we echo,
// the client's id is ours. Nothing here coerces or renumbers either.
//
// THE OBLIGATION THIS COMMIT EXISTS TO DISCHARGE.
//
// `web/host-bus.mjs` says it in its header: an inbound `mcp-response` for
// hostId `local` that arrives before the renderer has registered a request
// client for `local` does not get dropped and does not get buffered -- the
// renderer THROWS `No AppServerRequestClient registered for hostId: local`.
// Only `local` throws; a remote hostId merely breaks out of the switch. The bus
// cannot discharge that obligation because it does not know when a reply is
// about to be invented. The wiring does. So:
//
//   POLICY. The link never originates inbound app-server traffic. Every
//   `mcp-response` it emits is caused by an `mcp-request` it captured, and the
//   capture is itself the proof that the renderer has a client -- the request
//   client is the only thing in the renderer that emits `mcp-request`, so its
//   output is a registration receipt. Until such a receipt arrives the link is
//   DISARMED, and app-server traffic that would have gone inward is QUEUED in
//   arrival order and flushed the instant the link arms.
//
// Three things make that the right policy rather than an arbitrary one.
//
//   1. In the designed flow the gate never engages: the receipt precedes any
//      reply by construction, so the queue stays empty and costs a boolean. It
//      engages only for traffic the renderer did not ask for -- a notification
//      from a turn somebody else started, an approval for one, a reply
//      injected by a test or a replayed session -- which is exactly the set of
//      cases that would otherwise have thrown.
//   2. Dropping instead of queueing would be wrong for a different reason:
//      `mcp-notification` is NOT one of the renderer's three buffered types, so
//      an early `item/*` delta is a hole in the transcript with no error
//      anywhere. Queueing is the same answer the renderer's own author reached
//      for the three types they did buffer.
//   3. Leaning on the renderer's buffer instead would not work. Its
//      `deliverOrBufferMessage` holds an early `mcp-response` until someone
//      subscribes, and then drains it into the very switch that throws. The
//      buffer defers the throw, it does not prevent it. The gate therefore has
//      to sit upstream, on our side, which is here.
//
// `arm()` is exposed for a caller that knows registration happened by some
// other route, and `armed` is readable, because a policy you cannot observe is
// indistinguishable from a bug. What the link will NOT do is arm itself on
// `start()`: the `codex-app-server-initialized` announcement is what CAUSES the
// renderer to build its client, so treating it as evidence that the client
// exists would be assuming the conclusion -- and would reintroduce the throw on
// the one path we are here to close.
//
// WHAT THE GATE DOES NOT SOLVE, AND WHAT DOES.
//
// The gate above is about the renderer's REQUEST CLIENT: it stops a reply
// reaching a renderer that has no client to route it to. There is a second,
// earlier window it says nothing about -- the one before the renderer has a
// message LISTENER at all -- and the two are easy to conflate because the
// visible symptom is the same silence.
//
// Measured on the shipped bundle: this host announced the app server with the
// right versions, every layer reported healthy, and the page sat on its
// loading indicator anyway. The announcement was inbound message #0, ahead of
// the renderer's own `window.addEventListener('message', ...)`, and
// `codex-app-server-initialized` is not one of the three types
// `deliverOrBufferMessage` holds -- so `deliverMessage(e,t){let n=this.handlers
// .get(e);if(!n)return;...}` dropped it with no handler and no log. Re-sending
// the identical message after load took the page from 58 DOM nodes to 254.
//
// Queueing it behind the gate would be the wrong repair, and not only because
// of the deadlock the paragraph below describes: the real Electron main
// process does not queue it either. Main's buffer lives on
// `WindowManager.sendMessageToWebContents`, and the app-server connection does
// not go through it -- it sends through `gY.send` -> `chunkedMessageSender`,
// which never consults `isWebContentsReady`. Main loses the first
// announcement in exactly the same way this host did.
//
// What saves main is the other half, which is what this link now implements:
// its `case 'ready'` arm re-sends the connection-state, initialization and
// auto-resolution snapshots on EVERY ready, before the `initializationOnly`
// early-break. The renderer's first `ready` comes from a component ABOVE its
// startup gate, so it arrives while the loading indicator is still up. The
// announcement is therefore not a message that has to land first time; it is a
// message that has to be AVAILABLE when asked for. See `onRendererReady`.
//
// The lifecycle messages are deliberately NOT gated, for that same reason.
// `codex-app-server-initialized`, `codex-app-server-connection-changed` and
// `codex-app-server-fatal-error` are causes, not effects; gating them would
// deadlock the link against a renderer that is waiting to be told there is a
// host at all.
//
// WHY THE LINK CONSTRUCTS THE CLIENT INSTEAD OF ACCEPTING ONE.
//
// `onProtocolError` and `onClose` are constructor hooks on `AppServerClient`,
// not methods -- `web/appserver.mjs` already records that mismatch against what
// it was briefed. A link handed a ready-made client could therefore never learn
// that the transport died, which is the event it most needs: the fate of every
// request in flight at that moment is unknowable, and saying so is a message
// type of its own. So the link takes a transport and owns the client it builds.
//
// ORDER AT DEATH, which is subtle and matters.
//
// The client's teardown rejects every in-flight call and *then* calls
// `onClose`. Those rejections are queued microtasks; the hook runs
// synchronously. If the hook announced the disconnect immediately, the renderer
// would be told the local host is gone while N replies were still queued behind
// that notice -- and if it treats a non-connected `local` host as a reason to
// drop its request client, those replies land on an unregistered hostId, which
// is the one case that throws. So the notice is deferred by exactly one
// microtask and goes out last. Replies first, obituary after.
//
// ONE NOTIFICATION IS REWRITTEN RATHER THAN FORWARDED.
//
// The notification stream goes inward verbatim as `mcp-notification`, with
// exactly one exception: `mcpServer/event/stream/notification` becomes
// `mcp-event-notification` carrying `{hostId, notification, subscriptionId}`.
// That is not a preference. The Electron main process intercepts the method by
// name in its notification router and returns before its own generic path can
// see it, and the renderer's consumer is a dedicated subscriber keyed on
// `subscriptionId` -- so a generic forward is wire traffic that looks entirely
// correct and produces no MCP tool events in the UI at all, with nothing logged
// anywhere, because the renderer's notification gate allows the method through
// and then has no handler that does anything with it.
//
// Two consequences live here rather than in the bus. A frame whose params do
// not validate is DROPPED, the way main drops it, instead of being downgraded
// to a notification nobody consumes. And the live subscription ids are tracked,
// so that a transport death can tell the renderer each stream is over -- main
// synthesises exactly that on the way down, and without it a renderer-side
// subscription waits forever on a host that is gone.
//
// NO CLOCK, NO TIMER, ANYWHERE IN THIS FILE.
//
// The renderer computes its own per-request deadline (down to the exponential
// backoff on `thread/resume`) and owns the promise it would reject. A second
// deadline here could only ever settle a request the renderer still believes is
// in flight, or fire after the renderer already gave up -- two different ways to
// desynchronise the only table that matters. The app-server has no generic
// cancel either (`turn/interrupt` is the protocol-level stop), so the only
// honest local action on abandonment is to stop listening. That also keeps this
// module isomorphic: it runs in the browser beside the renderer and under the
// test runner, with no host-specific import in either case.
//
// The ninth server-initiated method being a clock read (`currentTime/read`)
// does not dent that invariant. The RENDERER answers it, from inside its own
// inbound dispatcher, with a `{currentTimeAt}` in floored epoch seconds -- the
// measured expression is quoted beside the method table in the client rather
// than here, because the assertion that keeps this promise greps THIS file for
// clock calls and cannot tell a quotation from a use. The only thing this file
// does is make sure the method is asked: one the link does not register is
// refused -32601 by the client before the renderer ever sees it, and relaying a
// question about the time is not reading a clock.
//
// FIDELITY GAPS, stated rather than hidden. The Electron main process reads
// `coalesce`, `priority`, `timeoutMs`, `expiresAtMs`, `widget` and
// `retainResponse` off the outbound frame and feeds them to a queueing layer of
// its own. There is no queue here: requests are forwarded immediately in
// arrival order, which is the same order a single app-server would serve them
// in anyway. Those fields are read by nobody in this file, and that is a
// simplification rather than a translation.
//
// DEPLOYMENT, discharged by where this file sits rather than deferred. A browser
// is served this module at `/hostlink/link.mjs`, because `web/` is the document
// root, and every specifier below is written in the one spelling both resolvers
// agree on:
//
//   ../host-bus.mjs                   node  <repo>/web/host-bus.mjs
//                                   browser  /host-bus.mjs
//   ../../src/appserver/client.mjs    node  <repo>/src/appserver/client.mjs
//                                   browser  `../../` clamps at the document
//                                            root -> /src/appserver/client.mjs
//
// The second works because `src/surface/main.mjs` mounts that directory at the
// URL path mirroring its repository path, and says so in its own comment -- the
// same trick, for the same reason, as the deployment note in `web/appserver.mjs`.
// No import map, no build step, and still exactly one copy of the client.
//
// The obligation this replaces asked whoever added the page for a mount or an
// import map. Moving the file was cheaper than either and removes the class
// rather than the instance: test/web/module-resolution.test.mjs now resolves
// every cross-directory specifier under `web/` both ways and insists the two
// land on the same file.

import {
  ANY_NOTIFICATION,
  APP_SERVER_VERSION_WILDCARD,
  AppServerClient,
  initializeAppServer,
  isAppServerVersion,
  MCP_EVENT_STREAM_METHODS,
  MCP_EVENT_TERMINATED_METHOD,
  RpcError,
  SERVER_REQUEST_METHODS as WIRE_SERVER_REQUEST_METHODS,
  TransportClosedError,
} from '../../src/appserver/client.mjs';
import { createHostBus } from '../host-bus.mjs';
import {
  APP_SERVER_RESULT_SHAPES,
  CONNECTION_STATE_CONNECTED,
  HOST_ID_LOCAL,
  inboundRequestDelivery,
  INBOUND,
  OUTBOUND,
  outcomeUnknownUpdate,
} from '../host-protocol.mjs';

/**
 * The code the Electron main process stamps on a failure of its OWN, as
 * recorded in docs/03: `{id, error: {code: -32000, ...}}`. Anything the
 * app-server rejected keeps the code the app-server chose, so a host fault and
 * a server fault stay distinguishable by code alone.
 */
export const HOST_ERROR_CODE = -32000;

/**
 * The connection state for "not connected".
 *
 * UNVERIFIED as a spelling: the renderer branches on `state === 'connected'`
 * and on `state !== 'connected'`, so every other string takes the same path and
 * nothing in the bundle pins which one it expects. It is named here rather than
 * in `web/host-protocol.mjs` because that file is a transcription of strings
 * read off the bundle, and this one was not read off anything.
 */
export const CONNECTION_STATE_DISCONNECTED = 'disconnected';

/**
 * The server-initiated methods the link answers by asking the renderer.
 *
 * Taken WHOLE from the client's table rather than retyped or filtered -- a
 * method name spelled wrong here, or a method left out of the list, is a handler
 * that is never called, and `AppServerClient` answers an unregistered method
 * with -32601 rather than stalling the turn. So the symptom of a short list is
 * not a stall: it is an approval that refuses itself. The server reads the
 * refusal, the renderer is never asked, no card is painted, and the user watches
 * the turn take a direction they did not approve with a clean console on both
 * sides.
 *
 * This used to be `Object.values(APPROVAL_METHODS)`, which is three of the nine
 * -- so a permission grant, an option pick, an MCP elicitation, a dynamic tool
 * call, a context picker and a clock read all self-refused. The full list and
 * the evidence for each entry live next to the table in the client, because that
 * is where the reply shapes are documented too.
 *
 * Note what is NOT in it: `item/plan/requestImplementation` sits in the same
 * renderer-side request registry as these and looks identical from the UI side,
 * but it is SYNTHESISED by the renderer -- it mints the id itself as
 * `implement-plan:<turnId>` -- and never arrives over the wire. Registering a
 * handler for it would add a line that reads as coverage and can never fire.
 */
export const SERVER_REQUEST_METHODS = Object.freeze(Object.values(WIRE_SERVER_REQUEST_METHODS));

/**
 * Who the link says it is during the handshake.
 *
 * Read the two versions in this file carefully, because they are not the same
 * kind of thing. THIS one is ours, it is the relay's package version, and the
 * app server only echoes it into the trailing parenthetical of the userAgent it
 * builds -- nothing compares it to anything. The `appServerVersion` the link
 * announces to the renderer is the SERVER's, it gates half the renderer's
 * features, and it must come from the server rather than from here.
 */
const HOST_CLIENT_INFO = Object.freeze({ name: 'codex-relay-web', version: '0.0.0' });

/**
 * How many MCP event-stream subscriptions this link will remember at once.
 *
 * The set this bounds exists only so the sweep can synthesise a terminated
 * event per live stream on the way down, and it had two ways in. One is the
 * renderer's own `mcpServer/event/stream/start`, which is bounded by the
 * renderer. The other is the backstop in onMcpEventNotification, which adds
 * whatever `subscriptionId` arrives on an event frame -- a string chosen
 * entirely by the app server, never compared against anything, and never
 * removed unless a terminated event names it back. A server that varies that
 * field per notification therefore grows this set once per event, for the life
 * of the page, in the renderer's own heap. Nothing above it caps anything:
 * neither the transport nor the bus has a notion of how many streams exist.
 *
 * 1024 is chosen to be unreachable rather than tuned. A session runs a handful
 * of concurrent streams -- one per tool call that reports progress -- so two
 * orders of magnitude of headroom is still a few tens of kilobytes of short
 * strings, and anything that crosses it is a server behaving in a way no
 * session needs.
 */
export const MAX_EVENT_STREAM_SUBSCRIPTIONS = 1024;

/**
 * How many foreign-hostId frames this link remembers at once.
 *
 * A foreign frame is one the renderer addressed to a host that is not ours, and
 * the only trace of one used to be `stats.foreignHostId` climbing. That counter
 * answers "how many" and nothing else, which is the wrong half of the question:
 * a real drive of this host finished with `foreignHostId: 3` and no way to say
 * which three frames, for which host, under which request ids. The count stays
 * and the identities are kept beside it.
 *
 * Bounded because the producer is not. The renderer MINTS host ids out of user
 * data -- `nTt(e){return `remote-ssh-discovered:${encodeURIComponent(e)}`}` and
 * `rTt(e){return `remote-control:${encodeURIComponent(e)}`}`, app-shared@1953452
 * -- so the number of distinct foreign hosts one page can produce is the number
 * of ssh targets and cloud projects the user touches, each with a client of its
 * own that polls. An unbounded list of their frames is a leak in the renderer's
 * own heap, the same fault MAX_EVENT_STREAM_SUBSCRIPTIONS exists to bound.
 *
 * 64, and EVICT-OLDEST rather than refuse-new -- deliberately the opposite of
 * `rememberEventStream` below. That set refuses new ids because every id
 * already in it has been promised a terminated event on the way down, so
 * dropping one breaks a promise. These records promise nothing to anybody: they
 * are a log, the total is already in `stats.foreignHostId`, and what a probe
 * wants after a user reports a symptom is the frames nearest to it. 64 is an
 * order of magnitude more than that drive produced and is a few kilobytes of
 * short strings when full.
 */
export const MAX_FOREIGN_FRAMES = 64;

/** Everything the link reports through `onEvent`. A closed set. */
export const LINK_EVENT = Object.freeze({
  armed: 'armed',
  queued: 'queued',
  flushed: 'flushed',
  emitFailed: 'emit-failed',
  foreignHostId: 'foreign-host-id',
  malformedRequest: 'malformed-request',
  unanswerableRequest: 'unanswerable-request',
  duplicateRequestId: 'duplicate-request-id',
  malformedAbandon: 'malformed-abandon',
  unknownAbandon: 'unknown-abandon',
  malformedResponse: 'malformed-response',
  unknownResponseId: 'unknown-response-id',
  uncarryableResult: 'uncarryable-result',
  malformedMcpEvent: 'malformed-mcp-event',
  mcpEventStreamTerminated: 'mcp-event-stream-terminated',
  eventStreamLimitReached: 'event-stream-limit-reached',
  mustSucceedRepaired: 'must-succeed-repaired',
  transportClosed: 'transport-closed',
  restartRequested: 'restart-requested',
  restartHandlerThrew: 'restart-handler-threw',
  rendererReady: 'renderer-ready',
  snapshotsResent: 'snapshots-resent',
});

/** The reason an in-flight call was aborted locally. Never leaves this module. */
const ABANDONED = Symbol('abandoned by the renderer');

/**
 * Can the renderer actually resolve on this result?
 *
 * Its branch is `message.result ? onResult(...) : message.error ? onError(...)
 * : log("Invalid MCP message")`, so a FALSY result reaches neither arm: the
 * promise is never settled and the only trace is a line in a console nobody is
 * reading. That is the third distinct way to hang a request and the hardest to
 * find, so it is decided here rather than left to luck.
 *
 * `null` and `undefined` are re-encoded as `{}`. A JSON-RPC result of null
 * carries no information -- it is the protocol's "done, nothing to say", and the
 * client's own reply path normalises the other direction the same way -- so `{}`
 * says the same thing in a form that resolves.
 *
 * `false`, `0`, `''` and friends are refused instead of re-encoded, because
 * each of them does carry information and the renderer has no shape that can
 * hold it. An error response names the problem and fails the turn loudly; a
 * substitution would resolve the renderer's promise with a value the server
 * never sent.
 */
function carryableResult(result) {
  if (result) return { ok: true, value: result };
  if (result === null || result === undefined) return { ok: true, value: {} };
  return { ok: false, value: null };
}

/**
 * The result to hand the renderer when a method it cannot survive the failure of
 * fails anyway.
 *
 * `APP_SERVER_RESULT_SHAPES` marks `config/read` `mustSucceed: true`, and the
 * `why` there is measured: two of its four call sites -- editing a sent message
 * and sending a queued one -- await it and read `.config` bare, with no catch
 * and no error boundary between them and the user. An error response for those
 * two becomes an unhandled rejection mid-interaction while a fresh turn works
 * perfectly, which is a bug report that reads as random.
 *
 * `{config:{}}` is a safe substitute specifically for this method and not by
 * accident: the renderer parses that object with a loose schema that has a
 * catch-all for unknown keys, so an EMPTY config parses and every setting falls
 * back to its default. It is `undefined` that throws. So the repair costs the
 * user default settings for one interaction; the rejection costs them the
 * interaction.
 *
 * Keyed by method and deliberately tiny. A method earns an entry here only when
 * someone has read its consumers and can write down what breaks -- which is why
 * this is a separate table from the descriptors rather than a `fallback` field
 * on them, and why the drift between the two is pinned by a test instead of
 * being resolved by a default.
 *
 * The values are factories, not objects, so each repair hands the renderer a
 * result it owns. A single shared object would be handed to the renderer by
 * reference -- `postMessage` within one realm does not clone -- and whatever it
 * did to the first one would be waiting for the second.
 */
export const MUST_SUCCEED_FALLBACKS = Object.freeze({
  'config/read': () => ({ config: {} }),
});

/** Does the descriptor table say a rejection of this method is unhandled? */
function mustSucceed(method) {
  return APP_SERVER_RESULT_SHAPES[method]?.mustSucceed === true;
}

/**
 * Is every path the renderer reads on sight actually present?
 *
 * A result that arrives but is missing the key the renderer destructures fails
 * in exactly the same place as a rejection -- inside the consumer, with no catch
 * -- so for a must-succeed method it gets the same repair. Only the FIRST
 * segment of each path is checked: the shapes list `turn.id`-style paths, and
 * guessing at nested defaults would be inventing data rather than supplying the
 * container the consumer needs to exist.
 */
function hasReadablePaths(method, result) {
  const read = APP_SERVER_RESULT_SHAPES[method]?.read;
  if (!read) return true;
  if (result === null || typeof result !== 'object') return false;
  return read.every((path) => result[path.split('.')[0]] !== undefined);
}

/** Turn whatever a call rejected with into a JSON-RPC error member. */
function errorMember(error) {
  if (error instanceof RpcError) {
    const member = { code: error.code, message: error.message };
    if (error.data !== undefined) member.data = error.data;
    return member;
  }
  return {
    code: HOST_ERROR_CODE,
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Build the link: one bus, one client, and the gate between them.
 *
 * @param {{
 *   window: object,
 *   transport: {send: Function, onMessage: Function, onClose: Function, close: Function},
 *   hostId?: string,
 *   serverRequestMethods?: readonly string[],
 *   onEvent?: ((event: {kind: string}) => void) | null,
 *   onProtocolError?: ((error: Error) => void) | null,
 *   onRestartRequested?: ((message: object) => void) | null,
 * }} args
 */
export function createHostLink({
  window,
  transport,
  hostId = HOST_ID_LOCAL,
  serverRequestMethods = SERVER_REQUEST_METHODS,
  onEvent = null,
  onProtocolError = null,
  onRestartRequested = null,
} = {}) {
  if (!window || typeof window !== 'object') {
    throw new TypeError('createHostLink: a window is required');
  }
  if (!transport || typeof transport !== 'object') {
    throw new TypeError('createHostLink: an app-server transport is required');
  }
  if (typeof hostId !== 'string' || hostId === '') {
    throw new TypeError('createHostLink: hostId must be a non-empty string');
  }
  // Validated here, before anything is built, and not in the registration loop
  // further down. A bad entry discovered mid-loop would have already created
  // the client and subscribed the bus to the window, so the throw would leave
  // behind half a link listening to a window that outlives it -- and the
  // client's own `handle()` would be the thing to report a duplicate, from a
  // stack that no longer names the caller who passed the list.
  const requestMethods = [];
  for (const method of serverRequestMethods ?? []) {
    if (typeof method !== 'string' || method === '') {
      throw new TypeError('createHostLink: every serverRequestMethod must be a non-empty string');
    }
    if (requestMethods.includes(method)) {
      throw new Error(`createHostLink: serverRequestMethods lists ${method} twice`);
    }
    requestMethods.push(method);
  }

  const stats = {
    forwarded: 0,
    results: 0,
    errors: 0,
    abandoned: 0,
    notifications: 0,
    // Event-stream frames are counted apart from `notifications`, because they
    // do not go inward as one: `mcpEvents` is what was rewritten and forwarded,
    // `mcpEventsDropped` is what failed validation and was dropped the way main
    // drops it, and `mcpEventTerminations` is how many terminated events this
    // link had to synthesise because the transport died under a live stream.
    mcpEvents: 0,
    mcpEventsDropped: 0,
    mcpEventTerminations: 0,
    // Subscription ids this link declined to remember because the set was
    // already at MAX_EVENT_STREAM_SUBSCRIPTIONS. Non-zero means either a
    // server varying subscriptionId per frame or a renderer leaking streams,
    // and in both cases the sweep is no longer complete -- which is worth a
    // number rather than only a one-off report.
    mcpEventSubscriptionsRefused: 0,
    serverRequests: 0,
    serverRequestAnswers: 0,
    outcomeUnknown: 0,
    mustSucceedRepairs: 0,
    queued: 0,
    flushed: 0,
    foreignHostId: 0,
    // Of those foreign frames, how many this link answered with a delivery
    // failure instead of only dropping. The gap between the two numbers is the
    // frames nobody was waiting on -- see `onForeignFrame` for which types
    // those are.
    foreignRequestsRefused: 0,
    malformed: 0,
    duplicates: 0,
    unknownIds: 0,
    restartRequests: 0,
    transportClosed: 0,
    // How many times the renderer said its listeners were up, and how many
    // times that caused a snapshot re-send. The two differ by the readies that
    // arrived before there was anything to re-send, which is a normal startup
    // ordering and not a fault.
    readySignals: 0,
    snapshotResends: 0,
  };

  /** Renderer request id -> { method, controller }. Integer ids. */
  const inFlight = new Map();
  /** Server request id -> { method, resolve, reject }. UUID string ids. */
  const serverRequests = new Map();
  /**
   * The MCP event-stream subscriptions believed to be live, by subscriptionId.
   *
   * Main keeps the same set as a Map of subscriptionId -> owning window, and
   * needs the window because it multiplexes several; one link faces one
   * renderer, so the id is the whole entry. What it is FOR is the sweep at the
   * bottom of this file: on the way down, each id still in here gets a
   * terminated event, because the renderer's subscription table is keyed on
   * these ids and has no other way to learn the stream ended.
   */
  const eventStreamSubscriptions = new Set();

  /**
   * Remember one subscription id, unless the set is full.
   *
   * Full means refuse the new id rather than evict an old one. Eviction looks
   * fairer and is worse: every id already in here is one the sweep has
   * promised a terminated event to, and dropping one silently converts a
   * bounded memory problem into a renderer widget that waits forever -- the
   * precise failure sweepEventStreams exists to prevent. Refusing leaves that
   * promise intact for the first 1024 and breaks it only for ids arriving
   * after a limit no honest session reaches.
   *
   * @returns {boolean} whether the id is now remembered
   */
  function rememberEventStream(subscriptionId) {
    if (eventStreamSubscriptions.has(subscriptionId)) return true;
    if (eventStreamSubscriptions.size >= MAX_EVENT_STREAM_SUBSCRIPTIONS) {
      stats.mcpEventSubscriptionsRefused += 1;
      report(LINK_EVENT.eventStreamLimitReached, {
        subscriptionId,
        limit: MAX_EVENT_STREAM_SUBSCRIPTIONS,
      });
      return false;
    }
    eventStreamSubscriptions.add(subscriptionId);
    return true;
  }
  /** Gated inbound sends, in arrival order. See the header. */
  const queue = [];

  let armed = false;
  let started = false;
  /**
   * What `announce()` told the renderer, kept so a later `ready` can repeat it.
   *
   * Null until the announcement happens, which is also main's condition: its
   * `sendInitializationSnapshot` is guarded by `this.initialized` and sends
   * nothing at all before the app server has finished its handshake.
   */
  let announcement = null;
  /**
   * The connection state as last told to the renderer, for the same reason.
   *
   * Tracked rather than derived from the client: by the time a disconnect has
   * propagated, what the renderer needs on its next `ready` is what we SAID,
   * not what we would say now.
   */
  let connectionState = null;
  // Separate from `started`, and only ever true inside `startFromHandshake`: the
  // handshake is a round trip, so without this a second call during the await
  // would see `started === false`, send its own `initialize`, and announce the
  // host twice.
  let starting = false;
  let closed = false;

  const report = (kind, detail = null) => {
    if (typeof onEvent !== 'function') return;
    try {
      onEvent(detail === null ? { kind } : { kind, ...detail });
    } catch {
      // An observer that throws must not take the link down with it. The same
      // rule the bus and the handshake follow.
    }
  };

  // `let`, not `const`, and checked before use: a transport that is already
  // closed calls back from inside `onClose()` during the client's constructor,
  // which runs BEFORE the line that creates the bus. Reading a `const bus` from
  // there would be a TDZ ReferenceError in a dead-transport edge case and
  // nowhere else -- this repo has already paid once for exactly that shape of
  // fault (see src/relay/provider-shapes.mjs).
  let bus = null;

  /**
   * @param {string} kind
   * @param {() => void} send
   * @param {{gate: boolean}} options
   * @returns {'sent'|'queued'|'failed'|'closed'}
   */
  const emit = (kind, send, { gate }) => {
    if (closed || bus === null) return 'closed';
    if (gate && !armed) {
      queue.push({ kind, send });
      stats.queued += 1;
      report(LINK_EVENT.queued, { type: kind, depth: queue.length });
      return 'queued';
    }
    try {
      send();
      return 'sent';
    } catch (error) {
      // The only way a built message fails to deliver is a bus somebody else
      // stopped. Reported rather than thrown: this runs inside a transport's
      // data handler or a promise continuation, where a throw lands nowhere
      // useful.
      report(LINK_EVENT.emitFailed, { type: kind, reason: error?.message ?? String(error) });
      return 'failed';
    }
  };

  function flush() {
    // Taken whole before sending: a flushed reply can make the renderer send
    // its next request re-entrantly, and that must append to a fresh queue
    // rather than mutate the one being walked.
    const draining = queue.splice(0, queue.length);
    for (const entry of draining) {
      stats.flushed += 1;
      report(LINK_EVENT.flushed, { type: entry.kind });
      try {
        entry.send();
      } catch (error) {
        // One bad send must not strand the rest of the queue behind it.
        report(LINK_EVENT.emitFailed, { type: entry.kind, reason: error?.message ?? String(error) });
      }
    }
    return draining.length;
  }

  function armBy(reason) {
    if (armed) return 0;
    armed = true;
    report(LINK_EVENT.armed, { reason });
    return flush();
  }

  /**
   * The last MAX_FOREIGN_FRAMES foreign frames, oldest first.
   *
   * Entries are frozen on the way in and never edited afterwards, so the
   * `foreignFrames` getter can hand out the array's contents directly instead
   * of rebuilding a copy of each record per read.
   */
  const foreignFrames = [];

  /**
   * The request id a foreign frame is keyed by, which is spelled per type.
   *
   * Three spellings, one per shape, and nothing guessed beyond them:
   * `mcp-request` and `thread-prewarm-start` carry `request.id`,
   * `mcp-request-abandon` carries `requestId`, and the renderer's outbound
   * `mcp-response` carries `response.id` -- the field whose two spellings are
   * documented as this protocol's expensive trap. `ready` and
   * `codex-app-server-restart` carry no id at all and get `undefined`, which is
   * the honest answer rather than a placeholder that reads like one.
   */
  function foreignFrameId(message) {
    const request = message.request;
    if (request !== null && typeof request === 'object') return request.id;
    if (message.requestId !== undefined) return message.requestId;
    const response = message.response;
    if (response !== null && typeof response === 'object') return response.id;
    return undefined;
  }

  /**
   * Answer a foreign request-carrying frame, or say why it was only recorded.
   *
   * Always the delivery failure, never the error response, and `gate: false`.
   * The reasons for all three choices are in `onForeignFrame`.
   *
   * `answered` is the strongest word this function has earned and it is still
   * one step short of what it sounds like. What is verifiable here is that the
   * frame was dispatched onto the bus; that the renderer's pending entry was
   * found and settled happens on the far side of a `postMessage` and is not
   * observable from this module. The gap matters less than it would elsewhere
   * because the payload is itself a failure (`type:'failed'`,
   * `stage:'not-sent'`) -- nothing downstream reads this as a result -- but
   * `stats.foreignRequestsRefused` counts dispatches, not settlements, and a
   * probe reading it should know which.
   *
   * @returns {'answered'|'unanswerable'|'unsent'|'dropped'}
   */
  function refuseForeignRequest(message, theirs, type, requestId) {
    if (type !== OUTBOUND.mcpRequest && type !== OUTBOUND.threadPrewarmStart) return 'dropped';
    const request = message.request;
    const method = request !== null && typeof request === 'object' ? request.method : undefined;
    // No id means no promise to settle and nothing to key a reply to; no method
    // name means the only alternative is an explicit `undefined` on the wire,
    // which is the shape `web/host-protocol.mjs` exists to keep off it. Both are
    // recorded under their own disposition rather than answered badly.
    if (requestId === undefined || typeof method !== 'string' || method === '') return 'unanswerable';
    const outcome = emit(
      INBOUND.mcpRequestDelivery,
      () =>
        bus.deliver(
          inboundRequestDelivery({
            hostId: theirs,
            update: {
              type: 'failed',
              delivery: { requestId, method, stage: 'not-sent' },
              message: `the host serving hostId ${hostId} has no connection for hostId ${theirs}`,
            },
          }),
        ),
      { gate: false },
    );
    return outcome === 'sent' ? 'answered' : 'unsent';
  }

  /**
   * Everything that happens to a frame addressed to another host.
   *
   * WHAT A FOREIGN hostId ACTUALLY IS. Not a mistake and not a stray: the
   * renderer is a multi-host client by construction. Its request clients come
   * out of one atom family and are all built with the SAME dispatcher --
   * `new Bun(e,(e,t)=>bf.dispatchMessage(e,t),!0,...)`, app-shared@5518596 --
   * so every host's frames leave through the single `codex-message-from-view`
   * event this link's bus listens on, and the Electron main process is what
   * normally fans them back out by hostId. The vocabulary is open-ended:
   * besides `local` there are `durable` and `remote-control`
   * (app-shared@1954910) and a cloud id the renderer appends once an account
   * exists (app-initial@7885741), but also ids MINTED from user data and the
   * `environment-git:` / `environment-git:hosted:` prefixes beside them. So a
   * second hostId in a single-host page is not pathology: it is what happens
   * the first time the user opens a remote environment or a cloud project.
   *
   * WHY DROPPING WAS THE WRONG HALF OF THE ANSWER. Not forwarding is right --
   * answering another host's request out of THIS app-server is the thing
   * `isOurs` exists to prevent. But a renderer request that is never answered
   * hangs, in the common case forever: `createRequest` defaults its deadline to
   * zero (`a=n?.timeoutMs??0`, app-shared@3219172) and `startRequest` arms a
   * timer only above zero -- the guard reads `t.timeoutMs>0&&(t.timeoutId=...)`
   * and the elided right-hand side is the window timer call that this file's
   * own no-clock assertion greps for, so it is cited rather than quoted
   * (app-shared@3225231). There is no retry on any path, and only a caller
   * that passed an explicit `timeoutMs` ever rejects. The three frames
   * the real drive dropped were therefore three promises left in the renderer's
   * table for the life of the page.
   *
   * WHAT THE REAL HOST DOES WITH THE SAME FRAME: it answers it.
   * `getConnection(e){let t=this.getMaybeConnection(e);if(!t)throw Error(
   * `Connection for host ID ${e} not found`);return t}`,
   * main-C3nRcJ3D.js@14680, throws for a hostId main has no connection for, and
   * the `mcp-request` arm catches that throw (main-C3nRcJ3D.js@2048708) and
   * sends one of two things: a `mcp-request-delivery` carrying
   * `{type:`failed`,delivery:{requestId,method,stage:`not-sent`},message}` when
   * the frame set `retainResponse`, or otherwise
   * `sendAppServerResponseToView(e,t.hostId,method,{id,error:{code:-32e3,
   * message}},...)`. `thread-prewarm-start` has the identical pair a few
   * hundred bytes later. Both carry the FRAME's hostId rather than main's own
   * -- `sendAppServerResponseToView` stamps `hostId: t`,
   * main-C3nRcJ3D.js@2067207 -- which is the only way either can settle
   * anything, since the renderer routes an inbound reply into the client keyed
   * by that field.
   *
   * SO THIS LINK ANSWERS TOO, WITH ONE OF MAIN'S TWO ANSWERS RATHER THAN THE
   * ONE MAIN WOULD HAVE PICKED. Always the delivery failure, because only one
   * of the pair is safe for every hostId. The renderer's two arms are not
   * alike:
   *
   *   mcp-response         `!r.get(ra).includes(e.hostId)` and then
   *                        ``e.hostId===`local` `` -> THROW `No
   *                        AppServerRequestClient registered for hostId:
   *                        local`                      app-initial@9519226
   *   mcp-request-delivery `r.get(ra).includes(e.hostId)&&r.get(WEe,e.hostId)
   *                        .onDelivery(e.update)`      app-initial@9519800
   *
   * The response arm can take the page to its error boundary for one specific
   * value: a frame for `local` arriving at a link configured with some other
   * hostId, which is exactly the arrangement the `hostId: 'remote-7'` tests set
   * up and exactly the hostId whose registration this file's header is about.
   * The delivery arm has no throw branch at all -- for a host the renderer does
   * not have registered it is a no-op. And choosing it is not a downgrade,
   * because the renderer settles on it identically: `onDelivery` with a
   * `failed` update runs `this.onError(t,new SR(e.delivery,e.message))`
   * (app-shared@3214365), the same rejection an error response reaches.
   *
   * RULED OUT FIRST: A SECOND LINK ON THIS BUS. Answering someone else's frame
   * would be indefensible if a sibling link were about to answer it properly,
   * so that had to be checked rather than assumed. It cannot happen here.
   * `createHostLink` builds its own bus, there is exactly one call site for it
   * in this repo (`web/host-boot.mjs`), and host-boot records in its own
   * comment that a second bus on the same window "would put two capture
   * listeners on the same window and hand every outbound message to both" --
   * a configuration the assembly already refuses. A foreign frame in this page
   * therefore has no host at all behind it, which is precisely why it hangs.
   *
   * UNGATED, for the reason the gate exists. The gate withholds inbound traffic
   * until the renderer has proved it has a request client for OUR hostId. This
   * message is addressed to a DIFFERENT hostId, it was dispatched by that
   * host's own client, and the delivery arm above cannot throw for it either
   * way -- so queueing it would hold another host's turn hostage to a
   * registration that has nothing to do with it.
   *
   * WHAT IS RECORDED AND NOT ANSWERED. `ready` carries no hostId anywhere in
   * the bundle, so it is foreign only in a test. Main drops a foreign
   * `mcp-request-abandon` silently --
   * `getMaybeConnection(t.hostId)?.abandonClientRequest(...)` is
   * optional-chained, main-C3nRcJ3D.js@2050360 -- and nothing awaits one. A
   * renderer->host `mcp-response` is an answer rather than a question, and
   * `codex-app-server-restart` is awaited by nobody. For all four, absence is
   * what the real host produces, so the record is the entire change.
   *
   * Arming is NOT reconsidered here: a foreign `mcp-request` is evidence that
   * SOME host has a client, and the gate is a claim about ours.
   */
  function onForeignFrame(message, theirs) {
    const type = message.type;
    const requestId = foreignFrameId(message);
    const disposition = refuseForeignRequest(message, theirs, type, requestId);
    stats.foreignHostId += 1;
    if (disposition === 'answered') stats.foreignRequestsRefused += 1;
    // Evict before push, so the buffer is never momentarily over its cap.
    if (foreignFrames.length >= MAX_FOREIGN_FRAMES) foreignFrames.shift();
    foreignFrames.push(Object.freeze({ type, hostId: theirs, requestId, disposition }));
    report(LINK_EVENT.foreignHostId, { type, hostId: theirs, requestId, disposition });
  }

  /**
   * Is this outbound frame ours to act on?
   *
   * A present hostId that is not ours belongs to another link -- the renderer
   * multiplexes several hosts and keys its clients by hostId, so forwarding
   * somebody else's request would answer it from the wrong app-server. An
   * ABSENT hostId is treated as ours: the renderer always sets one, there is
   * exactly one host behind this link, and refusing would strand a turn over a
   * field we only ever echo.
   *
   * The whole of what happens to a frame that is NOT ours lives in
   * `onForeignFrame`, so that the five call sites keep reading as one
   * question. They are all spelled `if (closed || !isOurs(message)) return;`,
   * which also means nothing below runs after `close()`: the short circuit is
   * why there is no second closed check down there.
   */
  function isOurs(message) {
    const theirs = message.hostId;
    if (theirs === undefined || theirs === hostId) return true;
    onForeignFrame(message, theirs);
    return false;
  }

  // -- renderer -> app-server -------------------------------------------------

  function settle(id, outcome) {
    // Gone from the table means the renderer stopped waiting -- it abandoned
    // the request, or the link closed. Answering anyway would deliver a reply
    // for an id the renderer has already settled.
    if (!inFlight.delete(id)) return;
    outcome();
  }

  function respond(id, method, payload) {
    emit(
      INBOUND.mcpResponse,
      // `requestMethod` is echoed because the renderer logs with it.
      // `trace`, `receivedAtMs` and `hostMetrics` are deliberately absent: the
      // renderer reports a `response_receipt` metric only when trace AND
      // receivedAtMs are both present, and there is no honest number to put in
      // either. Omitted, not undefined, so the payload survives a clone.
      () => bus.emitMcpResponse({ ...payload, id, requestMethod: method }),
      { gate: true },
    );
  }

  /**
   * Answer a must-succeed method with its fallback rather than an error.
   *
   * Loud by construction: a counter and an `onEvent` report, every time. The
   * repair exists so the renderer does not throw inside a consumer with no
   * catch, and it is only defensible while the operator can see it happening --
   * a substitution nobody can count is indistinguishable from the app server
   * having answered.
   *
   * @returns {boolean} false when this method has no fallback, in which case the
   *   caller's normal error path still runs.
   */
  function repairMustSucceed(id, method, reason) {
    const fallback = MUST_SUCCEED_FALLBACKS[method];
    if (typeof fallback !== 'function') return false;
    stats.mustSucceedRepairs += 1;
    report(LINK_EVENT.mustSucceedRepaired, { method, reason });
    respond(id, method, { result: fallback() });
    return true;
  }

  function onResult(id, method, result) {
    settle(id, () => {
      const carried = carryableResult(result);
      // A result that arrived but cannot be read is the same failure as one that
      // never arrived, from the consumer's point of view, so it gets the same
      // repair -- checked before the uncarryable branch below, which would
      // otherwise turn a readable-but-falsy `config/read` into the error this
      // whole path exists to avoid.
      if (mustSucceed(method) && (!carried.ok || !hasReadablePaths(method, carried.value))) {
        const reason = carried.ok ? 'result missing a path the renderer reads' : 'falsy result';
        if (repairMustSucceed(id, method, reason)) return;
      }
      if (!carried.ok) {
        stats.errors += 1;
        report(LINK_EVENT.uncarryableResult, { method, resultType: typeof result });
        respond(id, method, {
          error: {
            code: HOST_ERROR_CODE,
            message:
              `${method} returned a falsy result, which the renderer cannot resolve on: `
              + 'its branch reads result, then error, then logs and drops',
          },
        });
        return;
      }
      stats.results += 1;
      respond(id, method, { result: carried.value });
    });
  }

  function onCallFailed(id, method, error) {
    settle(id, () => {
      if (error instanceof TransportClosedError) {
        // The request was written to a pipe that then died, so whether it ran
        // is genuinely unknowable. This is the one delivery update whose shape
        // is documented, because the renderer generates it for itself in the
        // same situation. It goes BEFORE the error response: the update
        // explains, the response settles.
        stats.outcomeUnknown += 1;
        emit(
          INBOUND.mcpRequestDelivery,
          () => bus.emitRequestDelivery({ update: outcomeUnknownUpdate({ requestId: id, method }) }),
          { gate: true },
        );
      }
      // After the delivery update, which is still the honest account of what
      // happened, and before the error response, which for these methods is the
      // thing that breaks the user's next interaction.
      if (mustSucceed(method)) {
        const reason = error instanceof RpcError ? `rejected with ${error.code}` : 'call failed';
        if (repairMustSucceed(id, method, reason)) return;
      }
      stats.errors += 1;
      respond(id, method, { error: errorMember(error) });
    });
  }

  /**
   * Forward one renderer-originated app-server request.
   *
   * `outboundType` exists because there are two of them. `mcp-request` is the
   * one everybody knows; `thread-prewarm-start` carries the composer's prewarm
   * `thread/start` in an envelope of the same shape, and main answers both
   * through the same `mcp-response` path. It is threaded through only so the
   * arming event says which type was the registration receipt -- the handling
   * below is identical, because the wire contract is identical.
   */
  function onRendererRequest(message, outboundType = OUTBOUND.mcpRequest) {
    if (closed || !isOurs(message)) return;
    // Arm BEFORE forwarding, so anything queued goes inward ahead of the reply
    // to this request rather than behind it.
    armBy(outboundType);

    const request = message.request;
    if (!request || typeof request !== 'object') {
      stats.malformed += 1;
      report(LINK_EVENT.malformedRequest, { keys: Object.keys(message) });
      return;
    }
    const { id, method } = request;
    if (id === undefined) {
      // No id, no reply: there is nothing to answer and nobody waiting. Counted
      // rather than guessed at.
      stats.malformed += 1;
      report(LINK_EVENT.unanswerableRequest, { keys: Object.keys(request) });
      return;
    }
    if (typeof method !== 'string' || method === '') {
      stats.malformed += 1;
      stats.errors += 1;
      report(LINK_EVENT.malformedRequest, { id, keys: Object.keys(request) });
      // There IS an id here, so the renderer is waiting on a promise. An error
      // response settles it; silence would hang it.
      respond(id, undefined, {
        error: { code: HOST_ERROR_CODE, message: 'the host cannot forward a request with no method name' },
      });
      return;
    }
    if (inFlight.has(id)) {
      // Two live requests under one id would produce two replies for it, and
      // the second would arrive for a promise the renderer already settled.
      // The first stands.
      stats.duplicates += 1;
      report(LINK_EVENT.duplicateRequestId, { id, method });
      return;
    }

    const controller = new AbortController();
    inFlight.set(id, { method, controller });
    stats.forwarded += 1;
    // Read on the way past, forwarded unchanged: two of these requests are the
    // only place a subscriptionId is ever named, and the sweep on the way down
    // needs the ids. See `noteEventStreamRequest`.
    noteEventStreamRequest(method, request.params);
    client.call(method, request.params, { signal: controller.signal }).then(
      (result) => onResult(id, method, result),
      (error) => {
        if (error === ABANDONED) return; // belt and braces; the table check also covers it
        onCallFailed(id, method, error);
      },
    );
  }

  /**
   * The renderer's listeners are up. Re-send what it may have missed.
   *
   * This is main's `case 'ready'` arm, minus the parts that belong to a
   * desktop window. Three things are worth saying about it.
   *
   * It does NOT arm the link, and that is not an oversight. `ready` proves the
   * renderer has a message listener; the gate is about its REQUEST CLIENT,
   * which the renderer builds in response to the very announcement being
   * re-sent here. Arming on `ready` would assume the conclusion in the same
   * way arming on `start()` would -- see the header.
   *
   * It fires on EVERY ready rather than only the first. Main does the same,
   * and the reason is visible in the renderer: the two readies come from two
   * different effects, the second one only after the startup gate opens, and a
   * reloaded or remounted renderer produces more. Re-sending is cheap, and the
   * `isSnapshot` flag is exactly the renderer's affordance for being told
   * something it may already know.
   *
   * The order matches main's: connection state, then initialization, then the
   * auto-resolution set. The initialization message is the one that opens the
   * startup gate, so it goes after the state it should be read against.
   */
  function onRendererReady(message) {
    if (closed || !isOurs(message)) return;
    stats.readySignals += 1;
    report(LINK_EVENT.rendererReady, {
      initializationOnly: message?.initializationOnly === true,
    });

    // Nothing announced yet means nothing to re-announce. This is main's
    // `this.initialized &&` guard, and it is the normal case for the first
    // `ready` of a cold start -- the renderer's listeners can easily be up
    // before the app-server handshake has returned.
    if (announcement === null) return;

    if (connectionState !== null) {
      emit(
        INBOUND.connectionChanged,
        () => bus.emitConnectionChanged({ state: connectionState, isSnapshot: true }),
        { gate: false },
      );
    }
    emit(
      INBOUND.appServerInitialized,
      () => bus.emitAppServerInitialized({ ...announcement, isSnapshot: true }),
      { gate: false },
    );
    // Sent unconditionally and always empty: this host resolves no user input
    // on the renderer's behalf, and the renderer needs to be told that rather
    // than left with whatever a previous session's snapshot put there.
    emit(
      INBOUND.requestUserInputAutoResolutionSnapshot,
      () => bus.emitRequestUserInputAutoResolutionSnapshot({ pendingRequests: [] }),
      { gate: false },
    );
    stats.snapshotResends += 1;
    report(LINK_EVENT.snapshotsResent, { state: connectionState });
  }

  function onRendererAbandon(message) {
    if (closed || !isOurs(message)) return;
    armBy(OUTBOUND.mcpRequestAbandon);

    const id = message.requestId;
    if (id === undefined) {
      // The key list goes into the report on purpose: `requestId` is the only
      // spelling we have seen, and if a build ever uses another one this is the
      // line that says so instead of a counter that silently climbs.
      stats.malformed += 1;
      report(LINK_EVENT.malformedAbandon, { keys: Object.keys(message) });
      return;
    }
    const entry = inFlight.get(id);
    if (!entry) {
      stats.unknownIds += 1;
      report(LINK_EVENT.unknownAbandon, { id });
      return;
    }
    inFlight.delete(id);
    stats.abandoned += 1;
    // Local only, and that is not a shortcut: the protocol has no generic
    // cancel, so an abandoned `turn/start` keeps running and `turn/interrupt`
    // is the only thing that stops it. We stop listening and never answer.
    entry.controller.abort(ABANDONED);
  }

  // -- app-server -> renderer -------------------------------------------------

  function onServerNotification(params, method) {
    if (closed) return;
    // The one method that is rewritten rather than forwarded. Matched by name
    // on the way in, exactly where main matches it -- its router reads
    // `e.method===`mcpServer/event/stream/notification`` and returns before the
    // generic path -- so that there is no window in which an event-stream frame
    // can reach the renderer wearing the wrong type.
    if (method === MCP_EVENT_STREAM_METHODS.notification) {
      onMcpEventNotification(params);
      return;
    }
    stats.notifications += 1;
    emit(INBOUND.mcpNotification, () => bus.emitMcpNotification({ method, params }), { gate: true });
  }

  /**
   * Rewrite one event-stream frame, or drop it.
   *
   * Main's interceptor is, in full:
   *
   *   handleNotification(e){let t=aj.safeParse(e.params);if(!t.success)return;
   *   let{notification:n,subscriptionId:r}=t.data;let i=this.owners.get(r);
   *   i==null||i.isDestroyed()||(i.send(this.options.messageChannel,{type:
   *   `mcp-event-notification`,hostId:this.options.hostId,notification:n,
   *   subscriptionId:r}),n.method===`notifications/events/terminated`&&
   *   this.owners.delete(r))}
   *
   * Four things are read off that and reproduced here. The params are
   * `{notification, subscriptionId}`. The message carries `type`, `hostId`,
   * `notification` and `subscriptionId` and NOTHING else -- not the wire method,
   * which is what identified the frame and does not travel. A frame whose params
   * fail the schema is dropped where it stands, and is NOT forwarded as an
   * ordinary notification instead: that would be a frame the renderer's gate
   * admits, the big switch no-ops, and the event subscriber never sees, so the
   * downgrade buys silence rather than resilience. And a terminated event
   * retires its subscription id, which is the `owners.delete(r)` above and is
   * what keeps the sweep on the way down from announcing a stream twice.
   *
   * The validation is done here rather than left to the builder, which
   * `required()`s both fields and THROWS. The throw would not take the
   * notification stream down -- the client invokes notification handlers inside
   * a try/catch and hands what they throw to `onProtocolError` -- but it would
   * turn a frame the shipped host drops silently into a protocol error with no
   * counter attached, reported from a stack that names the builder rather than
   * the frame. A named counter and an `onEvent` report say more.
   *
   * The type checks beyond presence are the measured schema `aj`:
   *
   *   aj=n.O({notification:n.O({method:n.d(r.yn),params:n.j(n.N(),n.S())
   *   .optional()}),subscriptionId:n.z()})
   *
   * -- a notification object carrying a method, an id, and params that are
   * OPTIONAL, which is why nothing below requires them. Whether `n.z()` is
   * exactly a string check was not measured; the renderer settles it from the
   * other end, where each `hostSubscriptionId` is minted with
   * `crypto.randomUUID()` and matched with `===`, so an id of any other type
   * could not match a subscription of its own even if we forwarded it.
   */
  function onMcpEventNotification(params) {
    // An empty stand-in for params that are not an object at all, so that the
    // one check below reads as the schema rather than as three null guards.
    const frame = params !== null && typeof params === 'object' ? params : {};
    const { notification, subscriptionId } = frame;
    const usable = notification !== null && typeof notification === 'object'
      && typeof notification.method === 'string' && notification.method !== ''
      && typeof subscriptionId === 'string' && subscriptionId !== '';
    if (!usable) {
      // Byte-compatible with main's `if(!t.success)return`: counted and
      // reported on our side, invisible on the renderer's, which is the same
      // thing the renderer has always seen.
      stats.mcpEventsDropped += 1;
      // The type as well as the keys: `{}` and a frame that was never an
      // object at all are different server faults, and this report is the only
      // trace either of them leaves.
      report(LINK_EVENT.malformedMcpEvent, {
        paramsType: params === null ? 'null' : typeof params,
        keys: Object.keys(frame),
      });
      return;
    }
    if (notification.method === MCP_EVENT_TERMINATED_METHOD) {
      eventStreamSubscriptions.delete(subscriptionId);
    } else {
      // Not only where main learns an id (it reads them off the start request;
      // so do we, below) but also a backstop for the one case main cannot have:
      // a link built over a transport whose renderer already had a stream open,
      // whose `start` we therefore never saw.
      //
      // This is the add site that is driven entirely by the server: the id is
      // whatever arrived on the frame. Bounded for that reason -- see
      // rememberEventStream. The event itself is still forwarded, because an
      // id we decline to track is still an event the renderer asked for.
      rememberEventStream(subscriptionId);
    }
    stats.mcpEvents += 1;
    emit(
      INBOUND.mcpEventNotification,
      () => bus.emitMcpEventNotification({ notification, subscriptionId }),
      { gate: true },
    );
  }

  /**
   * Tell the renderer that every event stream still open has ended.
   *
   * Main does this on the way down and the shape is its, with our reason:
   *
   *   clear(){for(let[e,t]of this.owners)t.isDestroyed()||t.send(
   *   this.options.messageChannel,{type:`mcp-event-notification`,hostId:
   *   this.options.hostId,notification:{method:`notifications/events/terminated`,
   *   params:{reason:`MCP host connection closed`}},subscriptionId:e})}
   *
   * The reason string is OURS rather than copied, because main's describes
   * main's teardown and ours would be a lie about which side went away. What is
   * copied is the frame and the necessity, and the necessity is measurable: the
   * renderer puts a timeout on the `start` request only (`{timeoutMs:95e3}`),
   * and releases the subscription itself on nothing but a terminated event for
   * its id --
   * ``t.notification.method===`notifications/events/terminated`&&this.subscriptions.delete(n)``
   * -- or an explicit `unsubscribe`. So a stream the server can no longer feed
   * is not a stream that eventually gives up; it is a widget that waits until
   * the page is reloaded.
   *
   * @returns {number} how many streams were retired
   */
  function sweepEventStreams(reason) {
    const live = [...eventStreamSubscriptions];
    eventStreamSubscriptions.clear();
    for (const subscriptionId of live) {
      stats.mcpEventTerminations += 1;
      report(LINK_EVENT.mcpEventStreamTerminated, { subscriptionId, reason });
      emit(
        INBOUND.mcpEventNotification,
        () => bus.emitMcpEventNotification({
          notification: { method: MCP_EVENT_TERMINATED_METHOD, params: { reason } },
          subscriptionId,
        }),
        { gate: true },
      );
    }
    return live.length;
  }

  /**
   * Remember, or forget, the subscription id an event-stream request names.
   *
   * This is where main learns them too, and from the same field: its
   * `prepareRequest` runs before anything is forwarded, parses
   * `{subscriptionId}` off the params, and does
   * ``n===`mcpServer/event/stream/start`?this.owners.set(i,e):this.owners
   * .delete(i)``. Learning them from the event stream alone would miss the
   * subscription that is opened and produces nothing before the transport dies
   * -- which is a renderer-side waiter with no release and the exact case the
   * sweep exists for.
   *
   * Main's ownership check is not reproduced: it refuses a `start` for an id
   * another window already owns, and there is one renderer here, so there is no
   * one to protect it from. Nor do we refuse anything -- an id we cannot read is
   * one the sweep cannot help, not a request to reject on the app server's
   * behalf.
   */
  function noteEventStreamRequest(method, params) {
    if (method !== MCP_EVENT_STREAM_METHODS.start && method !== MCP_EVENT_STREAM_METHODS.stop) return;
    const { subscriptionId } = params !== null && typeof params === 'object' ? params : {};
    if (typeof subscriptionId !== 'string' || subscriptionId === '') return;
    if (method === MCP_EVENT_STREAM_METHODS.start) rememberEventStream(subscriptionId);
    else eventStreamSubscriptions.delete(subscriptionId);
  }

  /**
   * A server-initiated request: an approval, or a question for the user. Its id
   * is a UUID string minted by the server and the renderer echoes it back
   * verbatim, so nothing here renumbers it into the integer space.
   */
  function onServerRequest(method, id, params) {
    if (closed) {
      return Promise.reject(new RpcError('the host link is closed', { code: HOST_ERROR_CODE }));
    }
    if (serverRequests.has(id)) {
      return Promise.reject(new RpcError(`a server request with id ${String(id)} is already with the renderer`, {
        code: HOST_ERROR_CODE,
      }));
    }
    return new Promise((resolve, reject) => {
      serverRequests.set(id, { method, resolve, reject });
      stats.serverRequests += 1;
      // The reconstruction is `{id, method, params}` and no more. The raw frame
      // the server sent is not handed to a request handler, so a `jsonrpc`
      // member here would be invented rather than forwarded; the three fields
      // the renderer reads are the three we can honestly supply.
      const request = { id, method };
      if (params !== undefined) request.params = params;
      const outcome = emit(INBOUND.mcpRequest, () => bus.emitMcpRequest({ request }), { gate: true });
      if (outcome === 'sent' || outcome === 'queued') return;
      // Could not reach the renderer at all. The server is awaiting this reply
      // and nothing times out on either side, so an error now is the difference
      // between a failed turn and a stalled one.
      serverRequests.delete(id);
      reject(new RpcError('the host could not reach the renderer', { code: HOST_ERROR_CODE }));
    });
  }

  function onRendererResponse(message) {
    if (closed || !isOurs(message)) return;
    armBy(OUTBOUND.mcpResponse);

    // Outbound it is `response`; inbound it is `message`. This is the field
    // whose two spellings are the expensive trap, and this is the only place in
    // the repo that reads the outbound one.
    const response = message.response;
    if (!response || typeof response !== 'object' || response.id === undefined) {
      stats.malformed += 1;
      report(LINK_EVENT.malformedResponse, { keys: Object.keys(message) });
      return;
    }
    const entry = serverRequests.get(response.id);
    if (!entry) {
      // A late answer to something already settled -- plausible rather than
      // fatal, so counted and reported instead of thrown.
      stats.unknownIds += 1;
      report(LINK_EVENT.unknownResponseId, { id: response.id });
      return;
    }
    serverRequests.delete(response.id);
    stats.serverRequestAnswers += 1;
    if (response.error !== undefined && response.error !== null) {
      // Rejecting with an RpcError is what makes the client put the renderer's
      // own code and message on the wire instead of a bare -32603.
      entry.reject(RpcError.fromResponse(response.error, entry.method));
      return;
    }
    // `undefined` is not JSON; the client normalises a missing result to null
    // on its own, and passing null explicitly matches what the server does.
    entry.resolve(response.result === undefined ? null : response.result);
  }

  // Deliberately does NOT arm the link: a restart request is evidence that the
  // renderer is unhappy with its host, not evidence that it has a live client.
  function onRendererRestart(message) {
    if (closed || !isOurs(message)) return;
    stats.restartRequests += 1;
    report(LINK_EVENT.restartRequested, {});
    if (typeof onRestartRequested !== 'function') {
      // Nothing here can restart a process it did not spawn. The renderer will
      // now wait for a `codex-app-server-initialized` that is not coming, which
      // is why the report above is load-bearing rather than decorative.
      return;
    }
    try {
      onRestartRequested(message);
    } catch (error) {
      report(LINK_EVENT.restartHandlerThrew, { reason: error?.message ?? String(error) });
    }
  }

  // -- announcing the host to the renderer ------------------------------------

  /**
   * Refuse a version the renderer cannot use, by name and with the reason.
   *
   * Three rejections, each for a measured failure that produces no error:
   *
   *   * ABSENT. `inboundAppServerInitialized` writes the key unconditionally, so
   *     omitting it emits `{appServerVersion: undefined}` -- an explicit
   *     undefined, which does not survive a structured clone and which every
   *     payload in this repo is supposed to be free of.
   *   * The WILDCARD '0.0.0'. It force-enables every gate that goes through the
   *     renderer's version comparison and is then explicitly excluded by the two
   *     checks that do not -- the thread-list refresh gate and main's history
   *     check. So it is the most permissive and the least permissive answer at
   *     once, and no bug report from a host that sent it can be reasoned about.
   *   * ANYTHING UNPARSEABLE, '1' and 'dev' included. The renderer's comparison
   *     returns false for a version it cannot parse, so every gated feature
   *     turns off -- including the one that strips `turnTrigger` out of every
   *     `turn/start`. The turn still runs. It just runs without the field.
   *
   * Thrown rather than reported, because this is a programming error in the
   * caller and the stack still names them here.
   */
  function requireComparableVersion(key, value) {
    if (typeof value !== 'string' || value === '') {
      throw new TypeError(`createHostLink: start() needs a non-empty ${key}`);
    }
    if (value === APP_SERVER_VERSION_WILDCARD) {
      throw new TypeError(
        `createHostLink: ${key} must not be ${APP_SERVER_VERSION_WILDCARD}; the renderer treats it as a `
        + 'wildcard for most version gates and as a refusal for the rest, so it is never the honest answer',
      );
    }
    if (!isAppServerVersion(value)) {
      throw new TypeError(
        `createHostLink: ${key} must be a version the renderer can compare, not ${JSON.stringify(value)}; `
        + 'an unparseable version silently disables every version-gated feature',
      );
    }
    return value;
  }

  /**
   * `initialized`, then `connected`. The single place either is emitted.
   *
   * Note that this does NOT arm the link. See the header: the announcement is
   * what causes the renderer to register, so it cannot also be the evidence that
   * it has.
   *
   * `transport` here is the renderer-facing LABEL -- the renderer branches on
   * `transport !== 'websocket'` -- and has nothing to do with the app-server
   * transport the link was built on. Same word, two different things, which is
   * why it is renamed the moment it is destructured.
   */
  function announce({ appServerVersion, installedCodexVersion, isSnapshot, transport: transportLabel }) {
    started = true;
    // Recorded BEFORE the send, and recorded whether or not the send lands.
    // The whole point of keeping it is the case where the renderer was not
    // listening, and in that case the emit below reports success: the message
    // was posted, it simply had no handler. What makes the announcement
    // recoverable is that we still know what it said.
    announcement = { appServerVersion, installedCodexVersion, transport: transportLabel };
    connectionState = CONNECTION_STATE_CONNECTED;
    emit(
      INBOUND.appServerInitialized,
      () => bus.emitAppServerInitialized({
        appServerVersion,
        installedCodexVersion,
        isSnapshot,
        transport: transportLabel,
      }),
      { gate: false },
    );
    emit(
      INBOUND.connectionChanged,
      () => bus.emitConnectionChanged({ state: CONNECTION_STATE_CONNECTED }),
      { gate: false },
    );
  }

  /** The shared preconditions for both ways of starting. */
  function checkStartable() {
    if (closed) throw new Error('createHostLink: the link is closed and cannot start');
    if (started || starting) {
      // A second announcement would have the renderer stand up a second request
      // client for the same hostId.
      throw new Error('createHostLink: the link has already been started');
    }
    if (client.closed) {
      throw new Error('createHostLink: the app-server transport is closed; there is nothing to announce');
    }
  }

  // -- construction, in an order where nothing can read a half-built binding --

  const client = new AppServerClient(transport, {
    onProtocolError,
    onClose: () => {
      if (closed) return; // our own close(); the caller already knows
      stats.transportClosed += 1;
      report(LINK_EVENT.transportClosed, {});
      // Every outstanding approval is unanswerable now. Rejecting them keeps
      // the server's handler promises from dangling; the error member they
      // produce will be dropped by a closed client, which is the honest
      // outcome rather than a pretence.
      const stranded = [...serverRequests.values()];
      serverRequests.clear();
      for (const entry of stranded) {
        entry.reject(new RpcError('the app-server transport closed', { code: HOST_ERROR_CODE }));
      }
      // One microtask, and see the header for why it is exactly one: the
      // in-flight calls were rejected immediately before this hook ran, and
      // their replies must reach the renderer ahead of the news that the host
      // is gone.
      Promise.resolve().then(() => {
        if (closed) return;
        // Inside the same deferred microtask, and ahead of the notice, which is
        // the only ordering that is right for all three kinds of traffic. A
        // terminated event is an obituary rather than a reply, so it belongs
        // behind the in-flight replies for the reason the header gives. But it
        // must still arrive BEFORE the disconnect notice: it is addressed to a
        // renderer-side table keyed on our hostId, and a renderer that drops
        // host-keyed state when a host stops being connected would have nothing
        // left for it to land on.
        sweepEventStreams('the app-server transport closed, so this MCP event stream cannot be fed');
        connectionState = CONNECTION_STATE_DISCONNECTED;
        emit(
          INBOUND.connectionChanged,
          () => bus.emitConnectionChanged({ state: CONNECTION_STATE_DISCONNECTED }),
          { gate: false },
        );
      });
    },
  });

  bus = createHostBus({ window, hostId });

  const unsubscribes = [
    bus.on(OUTBOUND.mcpRequest, onRendererRequest),
    // Same handler, because it is the same envelope answered on the same path.
    // See OUTBOUND.threadPrewarmStart for why a second type exists at all.
    bus.on(OUTBOUND.threadPrewarmStart, (message) =>
      onRendererRequest(message, OUTBOUND.threadPrewarmStart)),
    bus.on(OUTBOUND.ready, onRendererReady),
    bus.on(OUTBOUND.mcpRequestAbandon, onRendererAbandon),
    bus.on(OUTBOUND.mcpResponse, onRendererResponse),
    bus.on(OUTBOUND.appServerRestart, onRendererRestart),
    // The wildcard, so the whole notification stream reaches the renderer. It
    // is an observer on the client, not a fallback, so a caller that also
    // subscribes to one method still sees it here.
    client.on(ANY_NOTIFICATION, onServerNotification),
  ];
  for (const method of requestMethods) {
    unsubscribes.push(
      client.handle(method, (params, context) => onServerRequest(context.method, context.id, params)),
    );
  }
  // `bus.onAny` is left unclaimed on purpose: an outbound type nobody here
  // knows is the caller's to see, and claiming the wildcard would hide the next
  // app update's new message behind our counters.

  return {
    get hostId() {
      return hostId;
    },
    /** The bus, for a caller that wants diagnostics or the lifecycle emitters. */
    get bus() {
      return bus;
    },
    /** The owned client, for calls this host makes on its own behalf. */
    get client() {
      return client;
    },
    get armed() {
      return armed;
    },
    get started() {
      return started;
    },
    get closed() {
      return closed;
    },
    /** A copy, so a reader cannot edit the counters it is reading. */
    get stats() {
      return { ...stats };
    },
    /**
     * The foreign frames still remembered, oldest first, for a probe.
     *
     * `{type, hostId, requestId, disposition}` each, capped at
     * MAX_FOREIGN_FRAMES. This is the half `stats.foreignHostId` cannot give:
     * the counter says a frame for another host went past, this says which one
     * and what was done about it. Frozen at both levels, so a reader cannot
     * edit the log it is reading -- the same rule as `stats` and `pending`.
     */
    get foreignFrames() {
      return Object.freeze([...foreignFrames]);
    },
    /** A snapshot of the three things with depth. */
    get pending() {
      return Object.freeze({
        rendererRequests: inFlight.size,
        serverRequests: serverRequests.size,
        queued: queue.length,
      });
    },

    /**
     * Announce the app server to the renderer with versions the CALLER supplies.
     *
     * Use this when the versions are already known from somewhere trustworthy --
     * a supervisor that spawned the server, a handshake run by the caller. When
     * they are not known, `startFromHandshake` asks the server instead of making
     * the caller invent an answer, and inventing an answer is what the
     * validation here exists to prevent: see `requireComparableVersion` for what
     * each rejected value silently breaks.
     */
    start({ appServerVersion, installedCodexVersion, isSnapshot, transport: transportLabel } = {}) {
      checkStartable();
      announce({
        appServerVersion: requireComparableVersion('appServerVersion', appServerVersion),
        installedCodexVersion: requireComparableVersion('installedCodexVersion', installedCodexVersion),
        isSnapshot,
        transport: transportLabel,
      });
    },

    /**
     * Ask the app server what version it is, then announce that.
     *
     * The preferred way to start, because the alternative is a host choosing a
     * version string on the server's behalf and every available choice is wrong:
     * see `requireComparableVersion`. The server already knows, and `initialize`
     * is where it says so -- its reply carries a `userAgent` whose leading
     * `<name>/<version>` is the app server's own compatibility version.
     *
     * `installedCodexVersion` defaults to the same string, and that default is a
     * decision rather than laziness: the renderer compares installed against
     * app-server and paints a "restart to update" banner when installed is the
     * HIGHER of the two. A relay has no second binary to restart into, so equal
     * is the only pair that does not offer the user an action the host cannot
     * perform.
     *
     * Not a notification in sight: the adapter's client-notification handler has
     * an empty body, so the `initialized` notification the Electron client sends
     * after the handshake is accepted and discarded. Sending one would be
     * protocol cosplay. What the handshake DOES produce is immediate inbound
     * traffic -- the adapter queues `account/updated` and one
     * `mcpServer/startupStatus/updated` per configured server in a microtask off
     * the `initialize` reply -- which arrives before any renderer has registered
     * a request client. That traffic is exactly what the queue in this file is
     * for, so it is held rather than dropped, and this is the measured case that
     * proves the gate earns its complexity.
     *
     * @returns {Promise<{appServerVersion: string, installedCodexVersion: string, result: object}>}
     */
    async startFromHandshake({
      clientInfo = HOST_CLIENT_INFO,
      capabilities = {},
      installedCodexVersion,
      isSnapshot,
      transport: transportLabel,
    } = {}) {
      checkStartable();
      starting = true;
      let handshake;
      try {
        handshake = await initializeAppServer(client, { clientInfo, capabilities });
      } finally {
        // Cleared whatever happened. A handshake that failed on a transport that
        // is still alive is worth retrying, and leaving the flag set would
        // retire the link over a transient error.
        starting = false;
      }
      if (handshake.appServerVersion === null) {
        // Deliberately not falling back to a literal. There is no string this
        // code could substitute that does not silently change what the renderer
        // does -- which is the entire bug this method was written to close -- so
        // the caller gets a readable failure and the choice.
        throw new Error(
          'createHostLink: the initialize reply carried no comparable version '
          + `(userAgent: ${JSON.stringify(handshake.result?.userAgent ?? null)}); `
          + 'pass a known appServerVersion to start() instead',
        );
      }
      // Re-checked after the await: the transport can close, or the caller can
      // close the link, while the handshake is in flight.
      checkStartable();
      const resolved = {
        appServerVersion: requireComparableVersion('appServerVersion', handshake.appServerVersion),
        installedCodexVersion: requireComparableVersion(
          'installedCodexVersion',
          installedCodexVersion ?? handshake.appServerVersion,
        ),
      };
      announce({ ...resolved, isSnapshot, transport: transportLabel });
      return { ...resolved, result: handshake.result };
    },

    /**
     * Declare that the renderer has a request client, without waiting for it to
     * prove it. Returns how many queued messages that released.
     *
     * The escape hatch, for a caller who knows registration happened by another
     * route. Everything it releases was held precisely because emitting it
     * early could make the renderer throw, so this is a promise the caller is
     * making on the renderer's behalf.
     */
    arm() {
      if (closed) throw new Error('createHostLink: the link is closed and cannot be armed');
      return armBy('explicit');
    },

    /**
     * Tell the renderer the connection state changed. Ungated -- a lifecycle
     * message is a cause, not an effect.
     */
    setConnectionState(state) {
      if (closed) throw new Error('createHostLink: the link is closed');
      if (typeof state !== 'string' || state === '') {
        throw new TypeError('createHostLink: setConnectionState needs a non-empty state');
      }
      emit(INBOUND.connectionChanged, () => bus.emitConnectionChanged({ state }), { gate: false });
    },

    /**
     * Put the renderer into its error state. Ungated, and not called
     * automatically on a transport close: only the caller knows whether a
     * reconnect is coming, and the renderer does not leave this state by
     * itself.
     */
    reportFatalError(errorMessage) {
      if (closed) throw new Error('createHostLink: the link is closed');
      if (typeof errorMessage !== 'string' || errorMessage === '') {
        throw new TypeError('createHostLink: reportFatalError needs a non-empty errorMessage');
      }
      emit(INBOUND.fatalError, () => bus.emitFatalError({ errorMessage }), { gate: false });
    },

    /**
     * Tear down, in the one order that answers everybody.
     *
     * Returns a promise, and it is worth awaiting only because of step 3: the
     * error members for outstanding approvals are produced by the client in a
     * microtask after their handler promise rejects, so closing the transport
     * in the same tick would discard them and leave the server's turn stalled
     * on a promise instead of failed with a reason. When there are no
     * outstanding approvals -- the usual case -- this is entirely synchronous.
     */
    async close() {
      if (closed) return;

      // 0. Before `closed`, because `emit` refuses once it is set, and the
      //    renderer outlives this link: the same argument as step 2 below, for
      //    the same kind of waiter. The transport-closed hook cannot cover this
      //    path -- it returns early on our own close, by design, so that a
      //    caller who closed the link is not told the transport died -- and a
      //    stream left unterminated here is a widget spinning on a host that
      //    has no socket left.
      sweepEventStreams('the host link closed, so this MCP event stream cannot be fed');
      closed = true;

      // 1. Stop listening for replies to requests the renderer will never get
      //    answers to. Local only; the server keeps working.
      for (const entry of inFlight.values()) entry.controller.abort(ABANDONED);
      inFlight.clear();
      queue.length = 0;

      // 2. Answer every approval still with the renderer, so the server fails
      //    its turn rather than waiting on it forever.
      const outstanding = [...serverRequests.values()];
      serverRequests.clear();
      for (const entry of outstanding) {
        entry.reject(new RpcError('the host link closed before the renderer answered', {
          code: HOST_ERROR_CODE,
        }));
      }

      // 3. Exactly one microtask, so those rejections become sends.
      if (outstanding.length > 0) await Promise.resolve();

      // 4. The link owns the client, so the link closes it. If you need the
      //    client to outlive the link, do not hand its transport to the link.
      for (const off of unsubscribes) {
        try {
          off();
        } catch {
          // An unsubscribe that throws is not a reason to leave the rest subscribed.
        }
      }
      client.close();
      bus.stop();
    },
  };
}
