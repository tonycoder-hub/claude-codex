// The one place this front end touches the JSON-RPC sibling modules.
//
// `src/appserver/client.mjs` and `src/appserver/transport-websocket.mjs` are
// owned by someone else and are not edited from here. The contract this front
// end was briefed on differed from what those modules actually export, so this
// file is the adapter -- the mismatch is absorbed in one place instead of being
// spread through app.mjs:
//
//   briefed                        actual
//   -----------------------------  --------------------------------------------
//   createClient(transport)        new AppServerClient(transport, hooks)
//   onNotification(method, cb)     on(method, handler)      -> unsubscribe
//   onRequest(method, handler)     handle(method, handler)  -> unsubscribe
//   onProtocolError(cb)            a constructor hook, not a method
//   call(method, params, opts)     same
//   close()                        same
//
// Two things are re-exported rather than reimplemented, because the sibling's
// versions are better than a local copy:
//
//   APPROVAL_DECISIONS  the four strings the server's normalizeDecision()
//                       recognises. Anything else is silently coerced to
//                       'decline', so a typo would produce a UI that looks like
//                       it approved while the tool call was actually refused.
//   approvalResponder() turns that silent coercion into a loud RpcError, raised
//                       on the wire instead of swallowed in a click handler.
//
// DEPLOYMENT NOTE: the two specifiers below leave this directory, and they are
// written relative on purpose, because that one spelling resolves correctly in
// both places this file has to work.
//
//   in Node   ../src/appserver/client.mjs  -> <repo>/src/appserver/client.mjs
//   in the browser, from /appserver.mjs, `../` clamps at the document root
//                                        -> /src/appserver/client.mjs
//
// So `src/surface/main.mjs` mounts <repo>/src/appserver at exactly
// `/src/appserver/` and both resolvers agree with no import map and no build
// step. The mount is that one directory and nothing above it: `/src/` itself
// is not served, and test/surface/mounts.test.mjs is what keeps that true.
//
// Two readings that were tried and are wrong. Pointing `staticRoot` at the
// repository root resolves fine but publishes .git, test/ and docs/ to a
// surface reachable from a phone. A `web/src -> ../src` symlink is answered
// 403 by the realpath containment check -- which is the check working.

import {
  AppServerClient,
  APPROVAL_DECISIONS,
  APPROVAL_METHODS,
  approvalResponder,
  DECISION_REQUEST_METHODS,
  ERROR_CODES,
  isDecisionRequestMethod,
  RpcError,
  SERVER_REQUEST_METHODS,
} from '../src/appserver/client.mjs';
import { createWebSocketTransport } from '../src/appserver/transport-websocket.mjs';

/**
 * Re-exported rather than re-derived.
 *
 * This file is the only bridge between the page and the JSON-RPC client, so a
 * browser-side caller that wanted the full list of server-initiated methods --
 * to register handlers, or to say which ones it is deliberately not handling --
 * had no way to reach it and would have retyped three of the nine. The copy
 * this file itself kept is gone with them: it was a correct duplicate of
 * DECISION_REQUEST_METHODS on the day it was written, which is exactly the kind
 * of duplicate that is wrong on the day a ninth method appears. That day has
 * come -- `currentTime/read` is the ninth -- and the re-export carried it here
 * with no edit to the export list at all, which is the whole argument for
 * re-exporting rather than copying.
 */
export {
  APPROVAL_DECISIONS,
  APPROVAL_METHODS,
  approvalResponder,
  DECISION_REQUEST_METHODS,
  ERROR_CODES,
  isDecisionRequestMethod,
  RpcError,
  SERVER_REQUEST_METHODS,
};

/**
 * Wrap a WebSocket into a JSON-RPC client.
 *
 * The socket may still be CONNECTING: the transport queues outbound frames
 * until it opens, which is why the caller builds the client immediately after
 * `new WebSocket(...)` rather than waiting for the open event. Waiting would
 * leave a window in which a server-initiated request arrived before any handler
 * was registered.
 *
 * @param {WebSocket} socket
 * @param {{onProtocolError?: (error: Error) => void, onClose?: () => void}} [hooks]
 */
export function createClientForSocket(socket, { onProtocolError = null, onClose = null } = {}) {
  const transport = createWebSocketTransport(socket, {
    // The transport reports with (error, where); the UI only shows the message.
    onError: onProtocolError ? (error) => onProtocolError(error) : null,
  });
  const client = new AppServerClient(transport, { onProtocolError, onClose });

  return {
    call: (method, params, options) => client.call(method, params, options),
    notify: (method, params) => client.notify(method, params),
    /** @returns {() => void} unsubscribe */
    onNotification: (method, handler) => client.on(method, handler),
    /**
     * Register a handler for a server-initiated request.
     *
     * An approval handler is wrapped in the sibling's `approvalResponder` here,
     * rather than at the call site, so that it cannot be forgotten: a decision
     * the server does not recognise is coerced server-side to 'decline', which
     * shows the user an approval that silently did not happen. Doing it in this
     * one place means no caller of the shim can opt out of the guard by
     * accident.
     *
     * The wrap is scoped to the two methods whose reply IS a decision. The
     * nine server-initiated methods answer in eight different shapes, and
     * `item/tool/requestUserInput` in particular answers with `{answers}`: wrap
     * that one and the guard rewrites a set of answers into a declined
     * approval, turning the thing that prevents silent refusals into a cause of
     * them. The scoping lives in the sibling, next to the list it scopes.
     *
     * @returns {() => void} unsubscribe
     */
    onRequest: (method, handler) => client.handle(
      method,
      isDecisionRequestMethod(method) ? approvalResponder(handler) : handler,
    ),
    close: () => client.close(),
    get closed() { return client.closed; },
    get pendingCount() { return client.pendingCount; },
  };
}
