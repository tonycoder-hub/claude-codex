// The transport seam: every byte that would leave this process, described as
// data instead of sent.
//
// Nothing in this file performs I/O. There is no `fetch`, no `node:http`, no
// WebSocket, and no place to put a credential. It contains three things:
//
//   1. `LARK_LIMITS` -- the platform numbers this design depends on, each with
//      the documentation page it came from. They are code rather than prose
//      because `throttle.mjs` consumes them and `docs/06-im-relay.md` quotes
//      them, and a limit that lives in two places drifts.
//   2. A pure mapping from an *operation descriptor* to `{ method, path, query,
//      body }`. The descriptor is what the dispatcher emits; the HTTP request is
//      what a real client would send. Keeping the mapping pure means the
//      endpoint shapes are unit-testable with no network and no account.
//   3. The outbound **fuse**. This is the part that matters more than it looks.
//
// ## Why the fuse exists
//
// This prototype is developed alongside live internal group chats that are
// read-only by policy: nothing is ever posted into them and nothing is ever
// forwarded out of them. A bug that posts a turn's output into the wrong chat is
// not a test failure, it is a disclosure. So "we did not wire up a credential
// yet" is not the safety property -- the safety property is that **the default
// sink refuses every operation**, and the only way to get a sink that sends
// anything is to hand it an explicit allowlist of chat ids. An empty allowlist
// permits nothing. There is no flag that means "allow all".
//
// That also means the sink is where a real implementation plugs in, and it is
// deliberately a one-method interface (`perform(op)`), so the entire network
// surface of this subsystem is one function that an allowlist wraps.
//
// ## The inbound side
//
// `assertLongConnection()` documents the contract a real long-connection client
// must satisfy and checks it at construction. The connection itself -- the
// outbound WebSocket dial, the protobuf framing, reconnect, the 3-second
// acknowledgement deadline -- is not implemented here and is not implementable
// offline. `test/imrelay/fakes.mjs` has a fake that satisfies the same contract,
// which is what every test in this subsystem runs against.

/**
 * Platform limits, each verified against official documentation on 2026-10-22.
 * Citations are in `docs/06-im-relay.md` §8; the short form is here so the
 * number and its provenance stay together.
 */
export const LARK_LIMITS = Object.freeze({
  /** Long connection: `每个应用最多建立 50 个连接`. */
  maxConnectionsPerApp: 50,
  /**
   * Long connection: an event `需要在 3 秒内处理完成且不抛出异常`, otherwise the
   * platform re-pushes it. This is the single most design-shaping number in the
   * file: it forces the event handler to be an enqueue-and-return, never an
   * await-the-turn, and it forces inbound de-duplication by event id.
   */
  eventHandlerDeadlineMs: 3000,
  /** Card callback: `your business server must respond within 3 seconds`. */
  callbackDeadlineMs: 3000,
  /** `content` cap for a text message: 150 KB. */
  textContentBytes: 150 * 1024,
  /** `content` cap for `interactive` and `post`: 30 KB. */
  cardContentBytes: 30 * 1024,
  /** CardKit streaming element content: 1..100000 characters, cumulative. */
  streamContentChars: 100000,
  /** A message may be edited (`PUT .../messages/:id`) at most 20 times, ever. */
  maxMessageEdits: 20,
  /** Per-card-entity ceiling for CardKit card/element operations: 10 times/s. */
  cardKitPerCardPerSecond: 10,
  /** Single-message frequency control on `PATCH .../messages/:id`: 5 QPS. */
  messagePatchPerSecond: 5,
  /** Sending to one group: 5 QPS, shared by every bot in that group. */
  sendPerChatPerSecond: 5,
  /** Endpoint-level frequency control, per API per app per tenant. */
  endpointPerMinute: 1000,
  endpointPerSecond: 50,
  /** A CardKit card entity, and a patchable message, both age out. */
  cardEntityTtlDays: 14,
  messagePatchWindowDays: 14,
  /** Streaming mode switches itself off 10 minutes after it was last enabled. */
  streamingModeTtlMs: 10 * 60 * 1000,
  /** A card-callback `token` is valid 30 minutes and usable twice. */
  callbackTokenTtlMs: 30 * 60 * 1000,
  callbackTokenUses: 2,
  /** Idempotency: two sends with the same `uuid` collapse for an hour. */
  sendUuidWindowMs: 60 * 60 * 1000,
  sendUuidMaxChars: 50,
});

/** Throttle code `99991400` / HTTP 429 means we exceeded a frequency limit. */
export const RATE_LIMIT_CODE = 99991400;

/**
 * The long-connection wire protocol, as read out of the three official SDKs
 * (`larksuite/oapi-sdk-go` `ws/`, `oapi-sdk-python` `lark_oapi/ws/`,
 * `larksuite/node-sdk` `ws-client/`). The platform documents this mode as
 * "SDK only" and publishes no wire specification, but the SDKs are open source,
 * so these are source-verified rather than guessed.
 *
 * Recorded here because this repository cannot use those SDKs -- the constraint
 * is Node built-ins only -- so if a real client is ever written it is written
 * against these names. Nothing in this subsystem dials anything.
 */
export const LARK_WS = Object.freeze({
  /**
   * Discovery: `POST {domain}/callback/ws/endpoint` with a **PascalCase** body
   * (`AppID`, `AppSecret`), returning `data.URL` (a `wss://` URL carrying
   * `device_id` and `service_id` query parameters) plus a server-issued
   * `ClientConfig`.
   */
  discoveryPath: '/callback/ws/endpoint',
  discoveryBodyFields: Object.freeze(['AppID', 'AppSecret']),
  /** Server-issued, in **seconds**, and re-pushable mid-session over a pong. */
  clientConfigFields: Object.freeze([
    'ReconnectCount', 'ReconnectInterval', 'ReconnectNonce', 'PingInterval',
  ]),
  /** SDK defaults, overwritten by `ClientConfig` on every handshake. */
  defaults: Object.freeze({
    pingIntervalMs: 120000,
    reconnectIntervalMs: 120000,
    reconnectNonceMs: 30000,
    /** -1 means retry for ever. */
    reconnectCount: -1,
  }),
  /** Frames are protobuf `pbbp2.Frame` sent as WebSocket **binary** messages. */
  frameFields: Object.freeze([
    'SeqID', 'LogID', 'service', 'method', 'headers',
    'payload_encoding', 'payload_type', 'payload', 'LogIDNew',
  ]),
  /** `Frame.method`. */
  frameType: Object.freeze({ control: 0, data: 1 }),
  /** The `type` header on a frame. */
  messageType: Object.freeze({ event: 'event', card: 'card', ping: 'ping', pong: 'pong' }),
  /** Frame header keys, including the four that drive chunk reassembly. */
  headers: Object.freeze({
    type: 'type',
    messageId: 'message_id',
    /** Number of fragments; 1 when not split. */
    sum: 'sum',
    /** Fragment index; 0 when not split. */
    seq: 'seq',
    timestamp: 'timestamp',
    traceId: 'trace_id',
    bizRt: 'biz_rt',
    instanceId: 'instance_id',
  }),
  /** HTTP response headers on a failed WebSocket upgrade. */
  handshakeHeaders: Object.freeze(['Handshake-Status', 'Handshake-Msg', 'Handshake-Autherrcode']),
  /**
   * Status codes the SDKs recognise. `forbidden` and `exceedConnLimit` are
   * **terminal** -- reconnecting on those is how you get yourself blocked --
   * while `systemBusy` and `internalError` are retryable.
   */
  codes: Object.freeze({
    ok: 0,
    systemBusy: 1,
    forbidden: 403,
    authFailed: 514,
    internalError: 1000040343,
    exceedConnLimit: 1000040350,
  }),
  /**
   * The client acks every data frame by echoing the inbound frame with a
   * `biz_rt` header and a JSON `{ code, headers, data }` payload, where `data`
   * is base64 of the handler's return value. That `data` field is the channel a
   * card callback's `toast` / `card` response travels back on.
   */
  ackPayloadFields: Object.freeze(['code', 'headers', 'data']),
  /**
   * **The hazard.** A card-button click is documented as configurable for
   * long-connection delivery, but all three official SDKs `return` on a
   * `type: card` data frame *before* writing the ack -- so the platform gets no
   * response inside its 3-second window. `larksuite/node-sdk`'s README states
   * outright that long connection supports event subscriptions and **not**
   * callback subscriptions. Whether the platform tags a card click `event` or
   * `card` is not determinable from source and was not tested here.
   *
   * Consequence for this design: a client written against this constant set must
   * handle **both** message types and ack both, and the relay must keep a
   * text-command path for approvals that does not depend on card callbacks at
   * all. See `inbound.mjs`.
   */
  cardFrameIsContested: true,
});

/**
 * The operations this subsystem is allowed to ask for. A closed set on purpose:
 * the dispatcher emits descriptors, and a descriptor naming an op that is not
 * here cannot be turned into a request, so a typo is a refusal rather than a
 * surprise call.
 */
export const OPS = Object.freeze({
  /** Send a new message (text or card) into a chat. */
  sendMessage: 'message.send',
  /** Rewrite an already-sent `interactive` message in place. */
  patchCard: 'message.patchCard',
  /** Create a CardKit card entity, getting back a `card_id`. */
  createCardEntity: 'cardkit.create',
  /** Full-replace a card entity's JSON. */
  updateCardEntity: 'cardkit.update',
  /** Toggle `streaming_mode` and friends on a card entity. */
  cardSettings: 'cardkit.settings',
  /** Push cumulative text into one streaming element of a card entity. */
  streamText: 'cardkit.streamText',
});

export class OutboundSealed extends Error {
  constructor(message, { op = null } = {}) {
    super(message);
    this.name = 'OutboundSealed';
    this.op = op;
  }
}

export class UnknownOp extends Error {
  constructor(op) {
    super(`${JSON.stringify(op)} is not a known outbound operation`);
    this.name = 'UnknownOp';
  }
}

const BASE = '/open-apis';

/**
 * Translate an operation descriptor into the HTTP request a real client would
 * make. Pure: it builds strings, it does not send them.
 *
 * Every path below is quoted from official documentation, with one exception
 * called out at the `replyTo` branch below.
 *
 * @param {object} op
 * @returns {{ method: string, path: string, query: object, body: object|null, auth: string }}
 */
export function toHttpRequest(op) {
  if (!op || typeof op !== 'object') throw new UnknownOp(op);
  switch (op.op) {
    case OPS.sendMessage:
      requireString(op, 'msgType');
      // A reply is a different endpoint, not a field on a send. This branch
      // started as an absence: the earlier version of this function pruned the
      // body down to `{receive_id, msg_type, content, uuid}`, so an `op.replyTo`
      // -- which `daemon.mjs#say` attaches, and which `digest.mjs`, the
      // dispatcher and `bin/imrelay.mjs` all set -- was dropped here without a
      // word, and every reply rendered as a fresh top-level message. The tests
      // stayed green because they assert on the *descriptor* the relay emitted,
      // never on the request it renders to; nothing looked at this body.
      //
      // The path is the one part of this file that is not quoted from the
      // platform's own docs. The second source is the `feishu-lark` CLI's
      // schema for `feishu_im_user_message`, whose `reply` action takes exactly
      // `message_id`, `content`, `msg_type`, `reply_in_thread` and `uuid` --
      // which matches this shape -- and whose SDK call is
      // `im.v1.message.reply({ path: { message_id } })`. It has still never
      // been exercised against the live endpoint.
      if (typeof op.replyTo === 'string' && op.replyTo !== '') {
        return {
          method: 'POST',
          path: `${BASE}/im/v1/messages/${encodeURIComponent(op.replyTo)}/reply`,
          // No `receive_id_type`: the message being replied to names its chat.
          query: {},
          body: pruned({
            msg_type: op.msgType,
            content: typeof op.content === 'string' ? op.content : JSON.stringify(op.content),
            reply_in_thread: op.replyInThread,
            uuid: op.uuid,
          }),
          auth: 'tenant_access_token',
        };
      }
      requireString(op, 'receiveId');
      return {
        method: 'POST',
        path: `${BASE}/im/v1/messages`,
        // `chat_id` is the only receive_id_type this subsystem uses: a relay
        // addresses conversations, never individual people.
        query: { receive_id_type: op.receiveIdType ?? 'chat_id' },
        body: pruned({
          receive_id: op.receiveId,
          msg_type: op.msgType,
          // The platform wants `content` as a JSON-serialised *string*, not an
          // object. Serialising here rather than at the call site is what keeps
          // "did you remember to stringify" from being a per-call-site bug.
          content: typeof op.content === 'string' ? op.content : JSON.stringify(op.content),
          uuid: op.uuid,
        }),
        auth: 'tenant_access_token',
      };

    case OPS.patchCard:
      requireString(op, 'messageId');
      return {
        method: 'PATCH',
        path: `${BASE}/im/v1/messages/${encodeURIComponent(op.messageId)}`,
        query: {},
        body: { content: typeof op.content === 'string' ? op.content : JSON.stringify(op.content) },
        auth: 'tenant_access_token',
      };

    case OPS.createCardEntity:
      return {
        method: 'POST',
        path: `${BASE}/cardkit/v1/cards`,
        query: {},
        body: {
          type: 'card_json',
          data: typeof op.card === 'string' ? op.card : JSON.stringify(op.card),
        },
        auth: 'tenant_access_token',
      };

    case OPS.updateCardEntity:
      requireString(op, 'cardId');
      return {
        method: 'PUT',
        path: `${BASE}/cardkit/v1/cards/${encodeURIComponent(op.cardId)}`,
        query: {},
        body: pruned({
          card: { type: 'card_json', data: typeof op.card === 'string' ? op.card : JSON.stringify(op.card) },
          sequence: op.sequence,
          uuid: op.uuid,
        }),
        auth: 'tenant_access_token',
      };

    case OPS.cardSettings:
      requireString(op, 'cardId');
      return {
        method: 'PATCH',
        path: `${BASE}/cardkit/v1/cards/${encodeURIComponent(op.cardId)}/settings`,
        query: {},
        body: pruned({
          settings: typeof op.settings === 'string' ? op.settings : JSON.stringify(op.settings),
          sequence: op.sequence,
          uuid: op.uuid,
        }),
        auth: 'tenant_access_token',
      };

    case OPS.streamText: {
      requireString(op, 'cardId');
      requireString(op, 'elementId');
      if (typeof op.content !== 'string') {
        throw new TypeError('streamText needs a string content');
      }
      // `sequence` must be a strictly increasing positive int32 per card entity.
      // Checked here because an out-of-order sequence is rejected by the
      // platform in a way that looks like a dropped update.
      if (!Number.isInteger(op.sequence) || op.sequence < 1 || op.sequence > 2147483647) {
        throw new RangeError('streamText needs an int32 sequence >= 1');
      }
      return {
        method: 'PUT',
        path: `${BASE}/cardkit/v1/cards/${encodeURIComponent(op.cardId)}`
          + `/elements/${encodeURIComponent(op.elementId)}/content`,
        query: {},
        // Cumulative, not a delta: the platform shows a typewriter effect only
        // when the previous text is a prefix of this one. See `cards.mjs`.
        body: pruned({ content: op.content, sequence: op.sequence, uuid: op.uuid }),
        auth: 'tenant_access_token',
      };
    }

    default:
      throw new UnknownOp(op.op);
  }
}

/**
 * The credential exchange, as a descriptor. Present so the auth *shape* is
 * documented in one place and absent from everywhere else; it takes no
 * arguments and names no values.
 *
 * A real implementation reads `app_id` / `app_secret` from the environment,
 * never from a file in this repository, and caches the resulting token against
 * its `expire` (seconds) with a refresh margin -- the exchange is itself
 * rate-limited, so refreshing per request is both wasteful and liable to 429.
 */
export function describeTokenExchange() {
  return Object.freeze({
    method: 'POST',
    path: `${BASE}/auth/v3/tenant_access_token/internal`,
    query: {},
    bodyFields: ['app_id', 'app_secret'],
    resultFields: ['tenant_access_token', 'expire'],
    auth: 'none',
    note: 'credentials come from the environment at runtime; none are stored in this repo',
  });
}

// -- the fuse ----------------------------------------------------------------

/**
 * The default sink: refuses everything, loudly.
 *
 * Every test in this subsystem runs against this or against the recording fake.
 * Nothing in `src/imrelay/` constructs a sink that can reach the network.
 */
export function sealedSink({ reason = 'outbound traffic is sealed in this build' } = {}) {
  return Object.freeze({
    sealed: true,
    async perform(op) {
      throw new OutboundSealed(`${reason}: refused ${op?.op ?? 'an unnamed op'}`, { op: op?.op ?? null });
    },
  });
}

/**
 * Wrap a sink so it can only act on explicitly named destinations.
 *
 * The allowlist is of **chat ids** (for sends) and **card entity ids** (for
 * streaming updates). An operation whose destination is not listed is refused
 * before `inner.perform` is reached, so a dispatcher bug that computes the wrong
 * chat id cannot post to it.
 *
 * Card entity ids are minted at runtime, so the usual wiring is to allow the
 * chats up front and call `allowCard()` as entities are created for them --
 * which also means an entity created for a chat that was never allowed can
 * never be written to.
 *
 * @param {object} init
 * @param {{perform: Function}} init.inner
 * @param {string[]} [init.chats] Chat ids this sink may send to. Empty = none.
 */
export function allowlistSink({ inner, chats = [] } = {}) {
  if (typeof inner?.perform !== 'function') throw new TypeError('allowlistSink needs an inner sink');
  if (!Array.isArray(chats)) throw new TypeError('chats must be an array');
  const allowedChats = new Set(chats.filter((id) => typeof id === 'string' && id !== ''));
  const allowedCards = new Set();

  return Object.freeze({
    sealed: false,
    get allowedChatCount() { return allowedChats.size; },
    /** Permit writes to a card entity, having checked which chat it belongs to. */
    allowCard(cardId, chatId) {
      if (typeof cardId !== 'string' || cardId === '') throw new TypeError('allowCard needs a cardId');
      if (!allowedChats.has(chatId)) {
        throw new OutboundSealed(`cannot bind a card to unlisted chat`, { op: null });
      }
      allowedCards.add(cardId);
    },
    async perform(op) {
      const destination = destinationOf(op);
      if (destination.kind === 'chat') {
        if (!allowedChats.has(destination.id)) {
          throw new OutboundSealed(`${op.op} targets a chat that is not on the allowlist`, { op: op.op });
        }
      } else if (destination.kind === 'card') {
        if (!allowedCards.has(destination.id)) {
          throw new OutboundSealed(`${op.op} targets a card that is not on the allowlist`, { op: op.op });
        }
      } else if (destination.kind === 'message') {
        // A message id does not name its chat, so it cannot be checked against
        // the chat allowlist. The caller must have obtained it from a send this
        // sink already permitted, which is exactly what `allowCard` models for
        // entities -- so until a message allowlist exists, refuse.
        throw new OutboundSealed(
          `${op.op} targets a message id, which this sink cannot attribute to an allowed chat`,
          { op: op.op },
        );
      } else {
        throw new OutboundSealed(`${op.op} has no checkable destination`, { op: op.op });
      }
      return inner.perform(op);
    },
  });
}

/**
 * Which allowlist an operation has to clear. Separate function so a new op
 * cannot be added to `OPS` without someone deciding what guards it -- the
 * `default` branch denies rather than permits.
 */
export function destinationOf(op) {
  switch (op?.op) {
    case OPS.sendMessage:
      return { kind: 'chat', id: op.receiveId };
    case OPS.createCardEntity:
      // Creating an entity sends nothing; it is still gated on the chat it is
      // being created *for*, so an entity for an unlisted chat never exists.
      return { kind: 'chat', id: op.forChat };
    case OPS.updateCardEntity:
    case OPS.cardSettings:
    case OPS.streamText:
      return { kind: 'card', id: op.cardId };
    case OPS.patchCard:
      return { kind: 'message', id: op.messageId };
    default:
      return { kind: 'unknown', id: null };
  }
}

// -- the inbound contract ----------------------------------------------------

/**
 * What a real long-connection client must provide.
 *
 * `start()` dials *outbound* to the platform; there is no listener to bind and
 * no inbound port, which is the entire reason this subsystem is an ingress
 * candidate. `onEvent` receives already-decoded event envelopes. `ack` is the
 * thing most clients forget: the platform expects the handler to finish inside
 * `LARK_LIMITS.eventHandlerDeadlineMs` and re-pushes the event otherwise, so the
 * handler must acknowledge immediately and do the work afterwards.
 */
export const LONG_CONNECTION_CONTRACT = Object.freeze(['start', 'onEvent', 'onClose', 'close']);

export function assertLongConnection(connection) {
  for (const member of LONG_CONNECTION_CONTRACT) {
    if (typeof connection?.[member] !== 'function') {
      throw new TypeError(`a long connection is missing ${member}()`);
    }
  }
  return connection;
}

// -- helpers -----------------------------------------------------------------

function requireString(op, field) {
  if (typeof op[field] !== 'string' || op[field] === '') {
    throw new TypeError(`${op.op} needs a non-empty ${field}`);
  }
}

/** Drop undefined members so request bodies compare equal in tests. */
function pruned(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
