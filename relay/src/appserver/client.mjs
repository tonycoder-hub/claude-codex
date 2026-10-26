// A JSON-RPC 2.0 client for the Codex app-server, with no transport in it.
//
// The app-server protocol is bidirectional in a way that most JSON-RPC clients
// are not built for. Three distinct kinds of traffic arrive on one pipe:
//
//   * responses to calls we made (`thread/start`, `turn/start`, ...);
//   * notifications, which are the entire streaming story -- `item/started`,
//     `item/agentMessage/delta`, `turn/completed`, `thread/tokenUsage/updated`;
//   * *requests from the server*, which carry an id and block until answered --
//     two approvals, a permission grant, a user-input question, two pickers, an
//     MCP elicitation, a dynamic tool call and a clock read. All nine are named
//     in SERVER_REQUEST_METHODS at the bottom of this file, which is the list a
//     host registers handlers for.
//
// That third kind is the reason this file exists rather than a fifty-line
// promise map. If a server→client request goes unanswered, the server does not
// time out and move on -- it sits on an unresolved promise and the turn stalls
// forever with the UI showing "awaiting approval". So an unregistered method
// gets a -32601 response rather than silence: a client that cannot approve
// commands must still say so.
//
// Everything here is isomorphic. No node: imports, no timers, no globals, no
// console -- the transport is injected, and anything the client swallows on your
// behalf (a malformed frame, a handler that threw) goes to `onProtocolError`.
//
// A transport is any object shaped like:
//
//   { send(obj), onMessage(cb), onClose(cb), close() }
//
// where `cb` receives objects that are already parsed. Framing, reconnection and
// backpressure are its problem, not this file's.
//
// Two sections at the bottom are exceptions to "knows nothing about the
// methods", and each is there because the alternative is a failure with no
// symptom at all: `approvalResponder`, because the server turns an unrecognised
// decision into a silent refusal, and the `initialize` handshake, because the
// version string it returns is what the renderer gates half its features on.
// Neither is reachable from the class, so the class itself stays method-blind.

export const JSONRPC_VERSION = '2.0';

/** Pass this as a method to `on()` to observe every notification. */
export const ANY_NOTIFICATION = '*';

/** The JSON-RPC 2.0 reserved codes we produce or recognise. */
export const ERROR_CODES = Object.freeze({
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
});

/**
 * A JSON-RPC error, in both directions: it is what `call()` rejects with when
 * the peer returns an error object, and what a request handler can throw to
 * control the `code`/`message`/`data` the peer sees instead of a bare -32603.
 */
export class RpcError extends Error {
  constructor(message, { code = ERROR_CODES.internalError, data } = {}) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }

  /** Build one from the `error` member of a response. */
  static fromResponse(error, method) {
    const code = Number.isInteger(error?.code) ? error.code : ERROR_CODES.internalError;
    const message = typeof error?.message === 'string' && error.message !== ''
      ? error.message
      : `the peer rejected ${method} with code ${code}`;
    const rpcError = new RpcError(message, { code, data: error?.data });
    rpcError.method = method;
    return rpcError;
  }
}

/** Something arrived that is not a JSON-RPC message, or is one we cannot place. */
export class ProtocolError extends Error {
  constructor(message, { payload = null } = {}) {
    super(message);
    this.name = 'ProtocolError';
    this.payload = payload;
  }
}

/** The pipe went away. Every in-flight call rejects with one of these. */
export class TransportClosedError extends Error {
  constructor(message = 'the app-server transport closed') {
    super(message);
    this.name = 'TransportClosedError';
  }
}

/**
 * Translate a thrown handler value into a JSON-RPC error member. Stacks are
 * deliberately not forwarded: the peer gets a code and a message, not our
 * internals.
 */
function toErrorMember(thrown) {
  if (thrown instanceof RpcError) {
    const member = { code: thrown.code, message: thrown.message };
    if (thrown.data !== undefined) member.data = thrown.data;
    return member;
  }
  // A handler may forward an error member it got from somewhere else verbatim.
  if (thrown && typeof thrown === 'object' && Number.isInteger(thrown.code) && typeof thrown.message === 'string') {
    const member = { code: thrown.code, message: thrown.message };
    if (thrown.data !== undefined) member.data = thrown.data;
    return member;
  }
  return {
    code: ERROR_CODES.internalError,
    message: thrown instanceof Error ? thrown.message : String(thrown),
  };
}

/** What an aborted call should reject with. */
function abortReason(signal) {
  if (signal.reason !== undefined && signal.reason !== null) return signal.reason;
  const error = new Error('the call was aborted');
  error.name = 'AbortError';
  return error;
}

export class AppServerClient {
  #transport;
  #onProtocolError;
  #onClose;
  /** Our outbound id -> { resolve, reject, detach, method, abandoned }. */
  #pending = new Map();
  /** method (or ANY_NOTIFICATION) -> Set of notification handlers. */
  #notifications = new Map();
  /** method -> the single handler that answers server→client requests. */
  #requests = new Map();
  #nextId = 1;
  #closed = false;

  /**
   * @param {{ send: Function, onMessage: Function, onClose: Function, close: Function }} transport
   * @param {object} [hooks]
   * @param {(error: Error) => void} [hooks.onProtocolError] Everything the client
   *   swallowed so it would not throw into the transport: malformed frames,
   *   uncorrelatable responses, notification handlers that threw.
   * @param {() => void} [hooks.onClose] Fired once, after in-flight calls reject.
   */
  constructor(transport, { onProtocolError = null, onClose = null } = {}) {
    for (const member of ['send', 'onMessage', 'onClose', 'close']) {
      if (typeof transport?.[member] !== 'function') {
        throw new TypeError(`transport is missing ${member}()`);
      }
    }
    this.#transport = transport;
    this.#onProtocolError = onProtocolError;
    this.#onClose = onClose;
    transport.onMessage((message) => this.#receive(message));
    transport.onClose(() => this.#teardown());
  }

  get closed() {
    return this.#closed;
  }

  /** How many calls are waiting for a response. Abandoned ones do not count. */
  get pendingCount() {
    let live = 0;
    for (const entry of this.#pending.values()) if (!entry.abandoned) live++;
    return live;
  }

  /**
   * Make a request and resolve with its `result`.
   *
   * Ids are monotonic integers from 1. Aborting is local only -- the app-server
   * has no generic cancel, so an aborted `turn/start` keeps running and
   * `turn/interrupt` is the protocol-level way to stop it. We stop listening,
   * and a response that arrives afterwards is discarded silently rather than
   * reported as an unknown id.
   */
  call(method, params, { signal } = {}) {
    if (typeof method !== 'string' || method === '') {
      return Promise.reject(new TypeError('a call needs a non-empty method name'));
    }
    if (this.#closed) {
      return Promise.reject(new TransportClosedError(`cannot call ${method}: the transport is closed`));
    }
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, method, detach: null, abandoned: false };
      if (signal) {
        const onAbort = () => {
          entry.abandoned = true;
          entry.detach = null;
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        entry.detach = () => signal.removeEventListener('abort', onAbort);
      }
      this.#pending.set(id, entry);

      const message = { jsonrpc: JSONRPC_VERSION, id, method };
      if (params !== undefined) message.params = params;
      try {
        this.#transport.send(message);
      } catch (error) {
        this.#pending.delete(id);
        entry.detach?.();
        if (!entry.abandoned) reject(error);
      }
    });
  }

  /**
   * Fire a notification. Dropped silently once the transport is closed: a
   * notification has no reply to wait for, so there is nothing to report to and
   * nobody who could act on a throw.
   */
  notify(method, params) {
    if (typeof method !== 'string' || method === '') {
      throw new TypeError('a notification needs a non-empty method name');
    }
    if (this.#closed) return;
    const message = { jsonrpc: JSONRPC_VERSION, method };
    if (params !== undefined) message.params = params;
    this.#send(message);
  }

  /**
   * Subscribe to a notification method, or to `ANY_NOTIFICATION` for all of
   * them. Returns an unsubscribe function.
   *
   * The wildcard is an observer, not a fallback: it fires for every notification
   * whether or not a method-specific handler also saw it. That is what a relay
   * forwarding the whole item stream to a browser actually wants, and a
   * "fires only if nothing else did" wildcard would silently stop forwarding the
   * moment someone added a local handler.
   */
  on(method, handler) {
    if (typeof method !== 'string' || method === '') {
      throw new TypeError('a subscription needs a non-empty method name');
    }
    if (typeof handler !== 'function') throw new TypeError('a subscription needs a handler');
    let handlers = this.#notifications.get(method);
    if (!handlers) {
      handlers = new Set();
      this.#notifications.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      const current = this.#notifications.get(method);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.#notifications.delete(method);
    };
  }

  /**
   * Register the handler that answers a server→client request. Its return value
   * (awaited, so an async handler is fine) becomes the response `result`;
   * throwing produces an error response, and throwing an `RpcError` chooses the
   * code.
   *
   * One handler per method, and a second registration throws rather than
   * shadowing the first -- two subsystems both believing they own approvals is a
   * bug worth finding at startup. Use the returned unregister to replace one.
   */
  handle(method, handler) {
    if (typeof method !== 'string' || method === '') {
      throw new TypeError('a request handler needs a non-empty method name');
    }
    if (typeof handler !== 'function') throw new TypeError('a request handler needs a function');
    if (this.#requests.has(method)) {
      throw new Error(`a request handler for ${method} is already registered`);
    }
    this.#requests.set(method, handler);
    return () => {
      if (this.#requests.get(method) === handler) this.#requests.delete(method);
    };
  }

  /** Close the transport and reject everything in flight. Idempotent. */
  close() {
    if (!this.#closed) {
      try {
        this.#transport.close();
      } catch (error) {
        this.#report(error);
      }
    }
    this.#teardown();
  }

  // -- inbound ---------------------------------------------------------------

  #receive(message) {
    // The outermost guard in the whole file: nothing below may throw back into
    // the transport's data handler.
    try {
      this.#route(message);
    } catch (error) {
      this.#report(error instanceof Error ? error : new ProtocolError(String(error), { payload: message }));
    }
  }

  #route(message) {
    if (Array.isArray(message)) {
      // The app-server never batches, but a conforming peer is allowed to, and a
      // batch of one valid request is not worth refusing. Each element is routed
      // on its own so one bad element cannot take out the rest.
      for (const element of message) this.#receive(element);
      return;
    }
    if (message === null || typeof message !== 'object') {
      throw new ProtocolError('inbound message is not a JSON-RPC object', { payload: message });
    }
    // Absent `jsonrpc` is tolerated; a *wrong* one means we are talking to
    // something we do not understand, and guessing would be worse than saying so.
    if (message.jsonrpc !== undefined && message.jsonrpc !== JSONRPC_VERSION) {
      throw new ProtocolError(
        `unsupported jsonrpc version ${JSON.stringify(message.jsonrpc)}`,
        { payload: message },
      );
    }

    const id = message.id ?? null;
    if ('method' in message) {
      if (typeof message.method !== 'string' || message.method === '') {
        throw new ProtocolError('inbound message has no usable method', { payload: message });
      }
      if (id !== null) {
        // Belt and braces: #serve catches the handler itself, so this can only
        // fire if #serve is ever changed to let something through.
        this.#serve(id, message.method, message.params).catch((error) => this.#report(error));
        return;
      }
      if ('id' in message) {
        // id:null plus a method is neither a request we can answer nor a
        // notification. Nobody is waiting, so there is nothing to reply to.
        throw new ProtocolError(
          `inbound request ${message.method} carries a null id and cannot be answered`,
          { payload: message },
        );
      }
      this.#dispatchNotification(message.method, message.params);
      return;
    }

    // No method: it is a response.
    if (id === null) {
      // The reference server emits {id: null, error} for a frame it could not
      // parse at all. There is no call to fail, so surface it and carry on.
      const detail = typeof message.error?.message === 'string' ? message.error.message : 'no detail';
      throw new ProtocolError(`peer reported an uncorrelated error: ${detail}`, { payload: message });
    }
    const key = this.#pendingKey(id);
    if (key === null) {
      throw new ProtocolError(`response for unknown request id ${JSON.stringify(id)}`, { payload: message });
    }
    const entry = this.#pending.get(key);
    this.#pending.delete(key);
    entry.detach?.();
    if (entry.abandoned) return; // aborted; the caller already saw a rejection

    if (message.error !== undefined && message.error !== null) {
      entry.reject(RpcError.fromResponse(message.error, entry.method));
      return;
    }
    if (!('result' in message)) {
      entry.reject(new ProtocolError(
        `response to ${entry.method} has neither result nor error`,
        { payload: message },
      ));
      return;
    }
    entry.resolve(message.result);
  }

  /**
   * Find the pending entry for a response id. We only ever send integers, but
   * some JSON-RPC servers echo ids back as strings, and failing to correlate
   * would hang the call forever -- a cheap normalisation beats a mystery.
   */
  #pendingKey(id) {
    if (this.#pending.has(id)) return id;
    if (typeof id === 'string' && /^-?\d+$/.test(id)) {
      const asNumber = Number(id);
      if (this.#pending.has(asNumber)) return asNumber;
    }
    return null;
  }

  async #serve(id, method, params) {
    const handler = this.#requests.get(method);
    if (!handler) {
      // Load-bearing. The server awaits this response; silence stalls the turn.
      this.#reply(id, undefined, {
        code: ERROR_CODES.methodNotFound,
        message: `this client has no handler for ${method}`,
      });
      return;
    }
    let result;
    try {
      result = await handler(params ?? {}, { method, id });
    } catch (thrown) {
      this.#reply(id, undefined, toErrorMember(thrown));
      return;
    }
    // `undefined` is not JSON, and the protocol's own server normalises a missing
    // result to null, so match it rather than emitting a result-less response.
    this.#reply(id, result === undefined ? null : result);
  }

  #dispatchNotification(method, params) {
    const direct = this.#notifications.get(method);
    const wildcard = this.#notifications.get(ANY_NOTIFICATION);
    // An unhandled notification is normal, not an error: the item stream carries
    // plenty a given client does not care about.
    if (direct) for (const handler of [...direct]) this.#invoke(handler, params, method);
    if (wildcard) for (const handler of [...wildcard]) this.#invoke(handler, params, method);
  }

  /** Call a consumer callback without letting it escape. */
  #invoke(handler, params, method) {
    try {
      const outcome = handler(params, method);
      // An async handler's rejection is just as invisible as a sync throw.
      if (outcome && typeof outcome.then === 'function') {
        outcome.then(undefined, (error) => this.#report(error));
      }
    } catch (error) {
      this.#report(error);
    }
  }

  // -- outbound --------------------------------------------------------------

  #reply(id, result, error) {
    const response = { jsonrpc: JSONRPC_VERSION, id };
    if (error) response.error = error;
    else response.result = result ?? null;
    this.#send(response);
  }

  #send(message) {
    if (this.#closed) return;
    try {
      this.#transport.send(message);
    } catch (error) {
      // Nothing is awaiting this write, so a throw would land in whatever
      // unrelated stack happened to trigger it.
      this.#report(error);
    }
  }

  // -- lifecycle -------------------------------------------------------------

  #teardown() {
    if (this.#closed) return;
    this.#closed = true;
    const error = new TransportClosedError();
    for (const entry of this.#pending.values()) {
      entry.detach?.();
      if (!entry.abandoned) entry.reject(error);
    }
    this.#pending.clear();
    if (this.#onClose) {
      try {
        this.#onClose();
      } catch (hookError) {
        this.#report(hookError);
      }
    }
  }

  #report(error) {
    if (!this.#onProtocolError) return;
    try {
      this.#onProtocolError(error);
    } catch {
      /* a reporting hook that throws has nowhere left to report to */
    }
  }
}

// -- the server-initiated request surface ------------------------------------
//
// Every method the app server can ASK US, and the reason getting this list wrong
// is expensive: `#serve` answers an unregistered method with -32601, the server
// reads -32601 as a refusal, and the renderer -- which was never asked -- paints
// nothing. The user watches the turn take a direction they did not approve, with
// a clean console on both sides. Silence would stall the turn; a refusal is
// worse, because a stall at least looks like a bug.
//
// The authority for the list is the renderer's own bulk-decline sweep, the one
// it runs over `conversation.requests` when a host disconnects, because that
// code has to name every method that can be sitting in that table:
//
//   item/commandExecution/requestApproval -> replyWithCommandExecutionApprovalDecision(decline)
//   item/fileChange/requestApproval       -> replyWithFileChangeApprovalDecision(decline)
//   item/permissions/requestApproval      -> replyWithPermissionsRequestApprovalResponse(
//                                              {permissions:{}, scope:'turn'})
//   item/tool/requestUserInput            -> replyWithUserInputResponse({answers:{}})
//   item/tool/requestOptionPicker         -> replyWithOptionPickerResponse({action:'dismiss', ...})
//   mcpServer/elicitation/request         -> replyWithMcpServerElicitationResponse(decline)
//
// plus `item/tool/call`, which the sweep reaches through its dynamic-tool
// branch. That sweep is NOT quite exhaustive, though, and the last two entries
// below are the proof. `item/tool/requestSetupCodexContextPicker` arrives on the
// wire and the renderer answers it IMMEDIATELY, from inside its inbound
// dispatcher, with `{action:'dismiss', selectedSources:[]}`. Because it is
// answered on arrival it never enters `conversation.requests`, so the disconnect
// sweep has no reason to mention it -- and a list derived from the sweep alone
// would leave that one method refusing itself.
//
// The NINTH entry is here for the same reason and on the same kind of evidence.
// `currentTime/read` arrives on the wire and the renderer answers it from inside
// that same dispatcher -- the switch that also holds `attestation/generate` and
// `account/chatgptAuthTokens/refresh`:
//
//   case`currentTime/read`:s(p,{id:xj(f),result:{currentTimeAt:Math.floor(Date.now()/1e3)}});break;
//
// That the dispatcher is the RENDERER's and not the Electron main process's is
// settled by the arm immediately before it, which mutates renderer conversation
// state -- `n.requests.push(Rf(t)),n.hasUnreadTurn=!0` -- and by `xj`, the
// renderer's id mapper, which is `function xj(e){return e}`. So this method is
// answered on arrival too, never enters `conversation.requests`, and is missing
// from the disconnect sweep for exactly the reason the context picker is.
//
// Note what relaying it costs us: nothing. The reply is `{currentTimeAt}` in
// epoch SECONDS -- `Math.floor(Date.now()/1e3)`, not milliseconds -- and the
// RENDERER computes it, so no code of ours reads a clock to answer this method.
// An earlier version of this comment had it in the absent list below, reasoning
// that a clock is a question a host can answer correctly and so a host duty
// rather than something to relay. That was wrong twice: the renderer never asks
// us for the answer, and while the method was missing from this table `#serve`
// refused it -32601, which is the one outcome that guarantees the renderer is
// not asked either.
//
// Deliberately ABSENT, and the distinction matters more than the inclusions:
//
//   * `item/plan/requestImplementation` is in the renderer's request registry
//     and looks exactly like the others, but it is SYNTHESISED locally and never
//     travels. The renderer pushes it into `e.requests` itself with an id of the
//     form `implement-plan:<turnId>`; nothing on the wire produces one.
//     Registering a handler for it would be dead code that reads as coverage.
//   * `attestation/generate` is answered by the Electron main process from
//     macOS App Attest, and the renderer's dispatcher has it on a bare `break`.
//     We have no attestation key and must not forge one, so -32601 is the honest
//     answer and the default path already gives it.
//   * `account/chatgptAuthTokens/refresh` is dropped by both the renderer and
//     main in the shipped product. Our -32601 is strictly better behaved than
//     their silence.

export const SERVER_REQUEST_METHODS = Object.freeze({
  commandExecution: 'item/commandExecution/requestApproval',
  fileChange: 'item/fileChange/requestApproval',
  permissions: 'item/permissions/requestApproval',
  userInput: 'item/tool/requestUserInput',
  optionPicker: 'item/tool/requestOptionPicker',
  setupContextPicker: 'item/tool/requestSetupCodexContextPicker',
  mcpElicitation: 'mcpServer/elicitation/request',
  dynamicToolCall: 'item/tool/call',
  currentTime: 'currentTime/read',
});

// -- the MCP event stream ----------------------------------------------------
//
// Three wire names that are not requests the server makes of us, and so are not
// in the table above, but which a host cannot forward generically either. They
// live here because this file is where wire spellings live.
//
// `mcpServer/event/stream/notification` is the one the Electron main process
// REWRITES rather than forwards. Its notification router intercepts the method
// by name and returns before the generic path can see it:
//
//   if(this.notifyInternalNotificationHandlers(e,a),e.method===`mcpServer/event/stream/notification`)
//     return this.mcpEventStreams.handleNotification(e),{routeKind:`notification`,method:e.method};
//
// and `handleNotification` turns the `{notification, subscriptionId}` params
// into a renderer message of a type of its own. The renderer-facing shape is
// recorded in web/host-protocol.mjs and the rewrite itself is in
// web/hostlink/link.mjs; what matters here is the spelling and the reason a
// host must match on it. Forwarding this method as an ordinary notification
// produces wire traffic that looks perfectly correct and no MCP tool events in
// the UI at all -- and nothing is logged, because the renderer's notification
// gate allows the method through (`"mcpServer/event/stream/notification":!0`)
// and then has no handler that does anything with it.
//
// `start` and `stop` are the two REQUESTS the renderer makes to open and close
// such a stream, and they are where either side learns a subscriptionId at all:
// main reads it off their params in `prepareRequest` and keys its owner table on
// it, which is how it knows which streams to terminate when the host connection
// goes away.
export const MCP_EVENT_STREAM_METHODS = Object.freeze({
  start: 'mcpServer/event/stream/start',
  stop: 'mcpServer/event/stream/stop',
  notification: 'mcpServer/event/stream/notification',
});

/**
 * The method on the INNER notification that ends a stream.
 *
 * Not an app-server method, which is why it is a constant of its own rather
 * than an entry in the table above: it is the `notification.method` of the
 * MCP-level event carried inside `mcpServer/event/stream/notification`. Both
 * sides of the shipped product treat it as terminal -- main drops the
 * subscription from its owner table
 * (``n.method===`notifications/events/terminated`&&this.owners.delete(r)``) and
 * the renderer drops it from its own
 * (``t.notification.method===`notifications/events/terminated`&&this.subscriptions.delete(n)``)
 * -- which also makes it the only honest way to tell the renderer that a stream
 * it is still waiting on will produce nothing more.
 */
export const MCP_EVENT_TERMINATED_METHOD = 'notifications/events/terminated';

// -- approvals ---------------------------------------------------------------
//
// The one place this file knows anything about what the methods MEAN, and it
// earns its keep. The server funnels our reply through a `normalizeDecision`
// that recognises exactly four strings and **silently returns 'decline' for
// everything else**. So `{ decision: 'approve' }` is not an error anywhere: the
// call looks like a clean round-trip, the server declines the tool, and the only
// symptom is an agent that mysteriously refuses to run anything.
//
// A typo that costs an afternoon of debugging is worth one guard, so wrap an
// approval handler in `approvalResponder` and a decision the server would not
// recognise becomes a loud error response instead -- which fails the turn with a
// readable message rather than quietly neutering it.
//
// The guard applies to exactly TWO of the nine methods, because the nine do not
// share a reply shape -- see DECISION_REQUEST_METHODS below. The count moves
// every time the wire set grows; the SCOPE must not, because widening it by one
// method is how a guard against silent refusals becomes a cause of them.

/**
 * The three methods a human calls "the approvals". A strict subset of
 * SERVER_REQUEST_METHODS, spelled out by name rather than derived by filtering,
 * because this is the set the relay's UI subscribes to and a filter would let it
 * drift silently when the wire set next grows.
 */
export const APPROVAL_METHODS = Object.freeze({
  commandExecution: SERVER_REQUEST_METHODS.commandExecution,
  fileChange: SERVER_REQUEST_METHODS.fileChange,
  userInput: SERVER_REQUEST_METHODS.userInput,
});

/**
 * The only two methods whose reply is a decision, and the reason this constant
 * exists rather than being inlined at the one call site.
 *
 * The nine server-initiated methods answer in EIGHT different shapes, measured
 * against the renderer's own reply helpers:
 *
 *   item/commandExecution/requestApproval -> { decision }
 *   item/fileChange/requestApproval       -> { decision }
 *   item/permissions/requestApproval      -> { permissions, scope }
 *   item/tool/requestUserInput            -> { answers }
 *   item/tool/requestOptionPicker         -> { action, selectedOptions, freeformAnswer }
 *   item/tool/requestSetupCodexContextPicker -> { action, selectedSources }
 *   mcpServer/elicitation/request         -> an MCP elicitation result
 *   item/tool/call                        -> whatever the named tool returns
 *   currentTime/read                      -> { currentTimeAt }, in epoch seconds
 *
 * Nine methods, eight shapes: the two approvals are the only pair that shares
 * one, which is the arithmetic the number in the first line is making.
 *
 * So a validator that insists on a `decision` key is correct for two of the
 * nine and would reject every permission grant, every option pick, every
 * dynamic tool result and the clock read -- turning the guard that exists to
 * prevent silent refusals into a cause of them. Hence the scoping, and hence
 * this list.
 */
export const DECISION_REQUEST_METHODS = Object.freeze([
  SERVER_REQUEST_METHODS.commandExecution,
  SERVER_REQUEST_METHODS.fileChange,
]);

/** True for the two methods whose reply the server reads as a decision. */
export function isDecisionRequestMethod(method) {
  return DECISION_REQUEST_METHODS.includes(method);
}

/** Every decision the server's `normalizeDecision` actually recognises. */
export const APPROVAL_DECISIONS = Object.freeze(['accept', 'acceptForSession', 'decline', 'cancel']);

/**
 * The two object-shaped decisions the server also accepts, both of which it maps
 * to `acceptForSession`.
 */
const AMENDMENT_KEYS = ['acceptWithExecpolicyAmendment', 'applyNetworkPolicyAmendment'];

function isAmendment(decision) {
  return decision !== null
    && typeof decision === 'object'
    && AMENDMENT_KEYS.some((key) => key in decision);
}

/**
 * Wrap a decision function into a handler for `client.handle()`.
 *
 * `decide` may return a bare string (`'accept'`), a full `{ decision }` object,
 * or a promise for either; the wrapper normalises to `{ decision }`, which is
 * the shape the server reads.
 *
 * The normalisation applies ONLY to the methods in DECISION_REQUEST_METHODS. For
 * any other method the handler's return value is relayed byte-for-byte, because
 * the other seven shapes have no `decision` key and the guard would refuse all
 * of them. That makes the wrapper safe to apply uniformly across a registry --
 * which matters, because the alternative is each host remembering which two of
 * nine to wrap, and the cost of forgetting is a request that answers itself.
 *
 * @param {(params: object, context: { method: string, id: unknown }) => unknown} decide
 */
export function approvalResponder(decide) {
  if (typeof decide !== 'function') throw new TypeError('approvalResponder needs a decision function');
  return async (params, context) => {
    const outcome = await decide(params, context);
    if (!isDecisionRequestMethod(context?.method)) return outcome;
    const decision = outcome !== null && typeof outcome === 'object' && 'decision' in outcome
      ? outcome.decision
      : outcome;
    if (isAmendment(decision)) return { decision };
    if (!APPROVAL_DECISIONS.includes(decision)) {
      throw new RpcError(
        `${JSON.stringify(decision)} is not an approval decision; expected one of ${APPROVAL_DECISIONS.join(', ')}`,
        { code: ERROR_CODES.invalidParams, data: { expected: [...APPROVAL_DECISIONS] } },
      );
    }
    return { decision };
  };
}

// -- the initialize handshake ------------------------------------------------
//
// The second place this file knows what a method means, and the justification is
// the same as the first: the alternative is a failure with no symptom.
//
// The renderer gates a long list of features on the app server's version. Every
// gate runs the version through one semver comparison helper against a table of
// minimum versions, and the two failure modes are both silent:
//
//   * An UNPARSEABLE version makes every comparison false, so the renderer
//     strips `turnTrigger` from every `turn/start` it sends. The turn still
//     runs. It just runs without the field, and nothing is logged.
//   * The literal '0.0.0' is a WILDCARD that force-enables every one of those
//     gates -- and is then explicitly excluded by two checks that do not use the
//     helper: the thread-list refresh gate and main's own history check. So
//     '0.0.0' is simultaneously the most permissive and the least permissive
//     answer, which is the worst of both and impossible to reason about from a
//     bug report.
//
// A host therefore must not guess. The server knows, and `initialize` is where
// it says so: the reply's `userAgent` opens with `<name>/<version>`, where the
// version is the app server's compatibility version -- the same string the
// adapter builds from CLAUDE_CODEX_COMPAT_VERSION, defaulting to a real release
// number rather than a wildcard. Extracting it is three lines and removes the
// guess entirely.

export const INITIALIZE_METHOD = 'initialize';

/**
 * The version string that is a wildcard to most of the renderer's gates and a
 * refusal to the rest. Exported so a host can reject it by name instead of
 * open-coding the literal and losing the reason.
 */
export const APP_SERVER_VERSION_WILDCARD = '0.0.0';

// Three numeric components, optional prerelease and build metadata. The
// renderer's own parser is a semver regex of the same shape; what matters for
// correctness here is that this is no LOOSER than the renderer's, because a
// version we accept and it cannot parse is exactly the silent-gate failure
// above.
const APP_SERVER_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** True for a version string the renderer can actually compare. */
export function isAppServerVersion(value) {
  return typeof value === 'string' && APP_SERVER_VERSION_PATTERN.test(value);
}

/**
 * Pull the app server's version out of the `userAgent` that `initialize`
 * returns.
 *
 * The adapter builds that string as
 * `<name>/<compatVersion> (<os>; <cpu>) <originator> (<name>; <clientVersion>)`,
 * so the version is the token between the first `/` and the first space. Note
 * which version that is: the leading one is the app server's, and the one in the
 * trailing parenthetical is the version the CLIENT sent in -- ours. Reading the
 * wrong one would report the relay's version as the server's, which is how a
 * host ends up gating features on its own release number.
 *
 * @returns {string | null} null when the string is absent or malformed, so the
 *   caller is forced to decide rather than being handed a plausible-looking lie.
 */
export function appServerVersionFromUserAgent(userAgent) {
  if (typeof userAgent !== 'string') return null;
  const match = /^[^/\s]+\/([^\s]+)/.exec(userAgent.trim());
  const version = match?.[1];
  return isAppServerVersion(version) ? version : null;
}

/**
 * Run the handshake and report the version the server named.
 *
 * `clientInfo` is OUR identity. The server echoes it into the trailing
 * parenthetical of the userAgent and gates nothing on it, which is why a
 * placeholder is acceptable here and would not be acceptable for the version
 * this function returns.
 *
 * @param {AppServerClient} client
 * @returns {Promise<{result: object, appServerVersion: string | null}>}
 *   `appServerVersion` is null when the server's reply carried no usable
 *   version. The caller owns that case: this function will not substitute a
 *   wildcard, because every caller that wants one can ask for it out loud.
 */
export async function initializeAppServer(client, { clientInfo, capabilities = {} } = {}) {
  if (!clientInfo || typeof clientInfo.name !== 'string' || typeof clientInfo.version !== 'string') {
    throw new TypeError('initializeAppServer needs a clientInfo with a name and a version');
  }
  const result = await client.call(INITIALIZE_METHOD, { clientInfo, capabilities });
  return {
    result: result ?? null,
    appServerVersion: appServerVersionFromUserAgent(result?.userAgent),
  };
}
