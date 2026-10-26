// The host bus: the two directions of renderer traffic, and nothing else.
//
// This module is deliberately not wired to anything. It captures what the
// renderer sends and it delivers what someone tells it to deliver; it does not
// know what an app server is, it opens no socket, and it imports nothing from
// src/. A later commit connects it to a real JSON-RPC client. Keeping that
// seam means the bus can be tested exhaustively with no transport at all, and
// the transport can be swapped without touching a single message shape.
//
// OUTBOUND -- why we listen for a CustomEvent and not for the bridge call.
//
// The renderer's transport sends each message along two paths:
//
//   postMessage(e) {
//     if (electronBridge?.sendMessageFromView) {
//       electronBridge.sendMessageFromView(e).catch(...)   // path 1
//     }
//     window.dispatchEvent(                                // path 2
//       new CustomEvent('codex-message-from-view', { detail: e }))
//   }
//
// Path 2 fires unconditionally -- bridge or no bridge, success or failure. So
// path 2 is the complete record of what the renderer sent and path 1 is a
// subset of it. We listen on path 2 only.
//
// Hooking BOTH is the trap, and it is an attractive one, because hooking
// `sendMessageFromView` looks like the more direct, more "real" integration.
// It would deliver every outbound message to the host TWICE. Two identical
// `mcp-request` frames with the same id go out, the server answers both, and
// the second answer arrives for a request id that has already been settled.
// What that looks like downstream is an intermittent duplicate tool call -- not
// an obvious double-delivery bug. So `sendMessageFromView` stays a no-op in
// web/host-bridge.mjs and this module never touches it.
//
// INBOUND -- why a hand-built MessageEvent passes the renderer's guard.
//
// The renderer refuses any inbound message whose `source` is set and is not its
// own window, and otherwise cross-checks `origin` against its own. A
// MessageEvent constructed by hand has `source === null`, which satisfies the
// first clause outright, so the origin comparison is never reached. That is not
// a loophole we found: it is exactly how the Electron preload delivers, and the
// guard was written around it.
//
// THE TRAP, restated here because this is where it would be made:
// `mcp-response` goes BOTH ways and the payload field differs by direction --
// inbound it is `message`, outbound it is `response`. The emitters below build
// the inbound shape through web/host-protocol.mjs rather than assembling object
// literals, so the two words cannot be interchanged by a typo.
//
// One obligation this module cannot discharge for you: an inbound
// `mcp-response` for hostId `local` arriving before the renderer has registered
// a client for `local` makes the renderer THROW -- it is not buffered and not
// dropped. Emitting is safe only after registration, and that sequencing
// belongs to whoever wires this up.

import {
  HOST_ID_LOCAL,
  OUTBOUND,
  OUTBOUND_EVENT,
  inboundAppServerInitialized,
  inboundConnectionChanged,
  inboundFatalError,
  inboundMcpEventNotification,
  inboundMcpNotification,
  inboundMcpRequest,
  inboundMcpResponse,
  inboundPersonalWorkspaceAccessBlocked,
  inboundRequestDelivery,
  inboundRequestUserInputAutoResolutionSnapshot,
} from './host-protocol.mjs';

/**
 * Build a bus over a window.
 *
 * @param {{window: object, hostId?: string}} args
 */
export function createHostBus({ window, hostId = HOST_ID_LOCAL } = {}) {
  if (!window || typeof window !== 'object') {
    throw new TypeError('createHostBus: a window is required');
  }

  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map();
  /** @type {Set<Function>} */
  const anyHandlers = new Set();
  let running = true;

  const stats = {
    captured: 0,
    claimed: 0,
    unclaimed: 0,
    droppedLogMessages: 0,
    malformed: 0,
    emitted: 0,
  };

  const fanOut = (listeners, message) => {
    for (const listener of [...listeners]) {
      try {
        listener(message);
      } catch {
        // One subscriber throwing must not stop the others from being told, and
        // must not propagate out of a window listener where nothing can catch
        // it. Subscribers that care about their own failures handle them.
      }
    }
  };

  function onOutbound(event) {
    const message = event?.detail;
    stats.captured += 1;

    const type = typeof message === 'object' && message !== null ? message.type : undefined;
    if (typeof type !== 'string') {
      stats.malformed += 1;
      stats.unclaimed += 1;
      fanOut(anyHandlers, message);
      return;
    }

    const claimed = handlers.get(type);
    if (claimed && claimed.size > 0) {
      stats.claimed += 1;
      fanOut(claimed, message);
      return;
    }

    // Telemetry, and a lot of it. It is dropped here rather than passed to
    // onAny, so that a diagnostic subscriber on onAny shows the traffic that
    // matters instead of being buried. Explicitly subscribing with
    // on('log-message', ...) still works and is the opt-in.
    if (type === OUTBOUND.logMessage) {
      stats.droppedLogMessages += 1;
      return;
    }

    stats.unclaimed += 1;
    fanOut(anyHandlers, message);
  }

  window.addEventListener(OUTBOUND_EVENT, onOutbound);

  /** Deliver a built inbound message into the renderer. */
  const deliver = (data) => {
    if (!running) {
      throw new Error('createHostBus: the bus is stopped and cannot deliver');
    }
    stats.emitted += 1;
    // `source` is left at its default null on purpose. See the header.
    window.dispatchEvent(new MessageEvent('message', { data }));
    return data;
  };

  return {
    get hostId() {
      return hostId;
    },
    get running() {
      return running;
    },
    /** A copy, so a caller cannot edit the counters it is reading. */
    get stats() {
      return { ...stats };
    },

    // ---- outbound capture -------------------------------------------------

    /**
     * Subscribe to one outbound type.
     * @param {string} type one of OUTBOUND
     * @returns {() => void} unsubscribe
     */
    on(type, handler) {
      if (typeof type !== 'string' || type === '') {
        throw new TypeError('bus.on: type must be a non-empty string');
      }
      if (typeof handler !== 'function') {
        throw new TypeError('bus.on: handler must be a function');
      }
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
      }
      set.add(handler);
      return () => {
        set.delete(handler);
        if (set.size === 0) handlers.delete(type);
      };
    },

    /**
     * Subscribe to everything no typed handler claimed.
     *
     * This exists so that an outbound type we have never seen is observable
     * rather than fatal. The renderer's own switch has no default branch and
     * ignores what it does not know; a host that threw on an unfamiliar type
     * would be stricter than the thing it is imitating, and would break on the
     * next app update rather than on ours.
     *
     * @returns {() => void} unsubscribe
     */
    onAny(handler) {
      if (typeof handler !== 'function') {
        throw new TypeError('bus.onAny: handler must be a function');
      }
      anyHandlers.add(handler);
      return () => anyHandlers.delete(handler);
    },

    // ---- inbound emit -----------------------------------------------------

    /**
     * Deliver an already-built inbound message.
     *
     * The typed emitters below are the app-server lifecycle: they exist because
     * each one has a precondition worth refusing at the call site. This one has
     * none, and it is here because two host layers answer types that are not
     * lifecycle at all -- web/host-fetch.mjs replies `fetch-response` for 95
     * endpoints, and web/host-services.mjs returns arrays of persisted-atom and
     * workspace replies for its caller to post -- and neither will ever earn a
     * typed emitter of its own.
     *
     * The alternative was for those callers to dispatch
     * `new MessageEvent('message', {data})` at the window themselves. That
     * works, and it is wrong for one reason: it would reproduce the `source`
     * subtlety documented in the header in three places instead of one, and it
     * would make `stats.emitted` a count of lifecycle messages rather than a
     * count of what reached the renderer -- so the one number that tells you
     * whether the host answered anything at all would read zero on a page that
     * was answering hundreds of fetches a minute.
     *
     * The message is passed through unvalidated on purpose. host-protocol.mjs
     * validates at construction, which is where a stack trace still names the
     * builder; a second check here would only be able to say "something
     * somewhere built this wrong".
     *
     * @param {object} message a built inbound message
     * @returns {object} the same message, for a caller that wants to log it
     */
    deliver(message) {
      return deliver(message);
    },

    /**
     * Answer a request the renderer made.
     *
     * Refuses a payload carrying neither a result nor an error, because the
     * renderer's own behaviour there is to log "Invalid MCP message: missing
     * result/error" into a console nobody is reading and then drop it -- which
     * presents as one request that never settles, hours after the mistake. The
     * refusal is raised at the call site instead, where the stack still points
     * at whoever built it. (See host-protocol.mjs; both-at-once is refused
     * there too.)
     */
    emitMcpResponse({ id, result, error, requestMethod, receivedAtMs, trace, hostMetrics } = {}) {
      return deliver(
        inboundMcpResponse({
          hostId,
          id,
          result,
          error,
          requestMethod,
          receivedAtMs,
          trace,
          hostMetrics,
        }),
      );
    },

    /** A server notification: the item stream and the turn lifecycle. */
    emitMcpNotification({ method, params, extra } = {}) {
      return deliver(inboundMcpNotification({ hostId, method, params, extra }));
    },

    /**
     * An MCP event-stream event, which is NOT a notification with a different
     * name on it.
     *
     * The Electron main process REWRITES the server's event-stream notification
     * into this type and forwards nothing else about it, and the renderer's
     * consumer for it is a dedicated subscriber -- it filters on
     * `t.hostId===this.params.hostId` and then on
     * `r.hostSubscriptionId===t.subscriptionId` -- rather than the big switch,
     * whose arm for this type is a grouped no-op. So both payload fields are
     * load-bearing and the builder refuses a message missing either. Emit the
     * same event through `emitMcpNotification` instead and every frame on the
     * wire looks correct while no MCP tool event ever reaches the UI.
     *
     * No `method` argument, deliberately: the wire method is what identifies
     * the frame to REWRITE and it does not travel inward, so passing it would
     * invite a caller to put it on a message the renderer reads nothing like.
     */
    emitMcpEventNotification({ notification, subscriptionId } = {}) {
      return deliver(inboundMcpEventNotification({ hostId, notification, subscriptionId }));
    },

    /**
     * A server-INITIATED request -- this is how an approval reaches the user.
     * Its id is a UUID string and the renderer will echo it back verbatim in an
     * outbound `mcp-response`; nothing here renumbers it.
     */
    emitMcpRequest({ request } = {}) {
      return deliver(inboundMcpRequest({ hostId, request }));
    },

    /** Delivery progress for an in-flight request. */
    emitRequestDelivery({ update } = {}) {
      return deliver(inboundRequestDelivery({ hostId, update }));
    },

    /** The app server is up. */
    emitAppServerInitialized({ appServerVersion, installedCodexVersion, isSnapshot, transport } = {}) {
      return deliver(
        inboundAppServerInitialized({
          hostId,
          appServerVersion,
          installedCodexVersion,
          isSnapshot,
          transport,
        }),
      );
    },

    /**
     * Connection state changed. `connected` is the one the renderer acts on.
     *
     * `isSnapshot` marks a re-send of a state the renderer may already have.
     * It is carried rather than inferred because only the caller knows which
     * of the two this is, and the renderer behaves differently for each.
     */
    emitConnectionChanged({ state, isSnapshot } = {}) {
      return deliver(inboundConnectionChanged({ hostId, state, isSnapshot }));
    },

    /**
     * The pending auto-resolved user-input requests, as a complete set.
     *
     * Always a snapshot -- there is no incremental form of this message -- so
     * unlike the two above it carries no `isSnapshot` flag to distinguish one
     * from the other.
     */
    emitRequestUserInputAutoResolutionSnapshot({ pendingRequests } = {}) {
      return deliver(inboundRequestUserInputAutoResolutionSnapshot({ hostId, pendingRequests }));
    },

    /** The app server died in a way it will not recover from. */
    emitFatalError({ errorMessage } = {}) {
      return deliver(inboundFatalError({ hostId, errorMessage }));
    },

    /** Workspace access refused. The renderer keeps only the latest of these. */
    emitPersonalWorkspaceAccessBlocked({ extra } = {}) {
      return deliver(inboundPersonalWorkspaceAccessBlocked({ hostId, extra }));
    },

    // ---- teardown ---------------------------------------------------------

    /**
     * Unsubscribe from the window and refuse further delivery.
     *
     * Emitting after stop() throws rather than no-opping: a host that has been
     * torn down and is still being handed replies is a sequencing bug, and a
     * silent no-op there would present as a renderer hanging on a request that
     * was, as far as its caller knew, answered.
     */
    stop() {
      if (!running) return;
      running = false;
      window.removeEventListener(OUTBOUND_EVENT, onOutbound);
      handlers.clear();
      anyHandlers.clear();
    },
  };
}
