/**
 * The relay's outbound sink for the self-hosted OpenLark client.
 *
 * ## Why this exists next to `feishu-sink.mjs` rather than replacing it
 *
 * `feishu-sink.mjs` drives the `feishu-lark` CLI, which authenticates with a
 * user access token obtained by an OAuth device flow. That flow needs a person
 * to approve an app the operator cannot get approved, and the one credential
 * that ever existed for it has been retired, so that route is closed -- see
 * `docs/14-feishu-send.md`, which is marked superseded.
 *
 * This sink reaches the same person through a different door: the self-hosted
 * OpenLark client (`Eric-2369/open-lark`) already holds a live, continuously
 * refreshed session for them, because they use it as their client. Nothing has
 * to be authorised for the relay to borrow it.
 *
 * ## The shape of the path, and why there is a shim in the middle
 *
 *     relay -> allowlistSink -> openLarkSink -> HTTP (loopback)
 *           -> openlark-shim -> `relay-send.ts` in the OpenLark deployment
 *           -> Lark gateway RPC
 *
 * The sink does not talk to OpenLark's own HTTP API, and that is the central
 * design fact. OpenLark's `/api/*` is behind an owner-auth hook (password plus
 * TOTP, which only the person can satisfy) and its optional "agent API" on port
 * 8081 is not enabled in the running service -- the live process has no
 * `LARK_AGENT_LEGACY`, no agent token, and `agentEnabled` requires both. So
 * every HTTP door into that service is shut to the relay.
 *
 * What is open is the credential on disk. `relay-send.ts` loads the
 * deployment's own `SessionVault` and calls the gateway directly, which is the
 * same thing the deployment's `scripts/inspect-*.ts` already do. That script
 * cannot live in this repository: it needs the deployment's gateway, protocol
 * registry and `ImDomain`, and moving those here would mean copying a person's
 * session between repositories. So it stays there, and this side reaches it the
 * way `feishu-sink` reaches `feishu-lark` -- over a loopback shim.
 *
 * ## The one vocabulary difference from the feishu route, which matters
 *
 * `allowlistSink` was written against `oc_`-prefixed open-chat ids, because
 * that is what the platform's REST API addresses. OpenLark's gateway does not
 * use them: it addresses conversations by a 19-digit numeric feed id, and the
 * target chat's conversation object was measured to contain no `oc_` value in
 * any field. There is no `oc_` id to put on the allowlist, so this route's
 * allowlist holds numeric feed ids instead.
 *
 * The *shape* of the fuse is carried over unchanged -- default-deny, sends
 * only, chat-addressed only, ids never echoed into an error -- and the id
 * format is pinned (`OPENLARK_CHAT_ID`) so an `oc_` id cannot be smuggled
 * through a namespace the gateway would resolve differently, or not at all.
 *
 * ## What counts as a send
 *
 * OpenLark's own messenger refuses to report success when the upstream response
 * carried no message id; it throws rather than returning the local pending id
 * it made up to track the send. `relay-send.ts` repeats that check, and so does
 * this sink: a success without a non-empty, non-`local:` message id is a
 * refusal. "Exit code 0" and "HTTP 200" are not evidence that anything left.
 */

import { OPS } from './transport.mjs';

/** Shared secret header. Distinct from the feishu shim's so a nonce for one
 *  cannot be replayed at the other. */
export const OPENLARK_NONCE_HEADER = 'x-imrelay-openlark-nonce';

/**
 * OpenLark feed ids are numeric. An `oc_` open-chat id belongs to the REST
 * API's namespace and is refused rather than silently looked up: the lookup
 * route exists in OpenLark but returns only conversations that are already
 * open, so a silent resolution would turn "not open yet" into "wrong chat" or
 * into a confusing miss. Pinned at the boundary instead.
 */
export const OPENLARK_CHAT_ID = /^[0-9]{10,24}$/;

/** A pending id OpenLark mints locally to track a send; never a real id. */
const PENDING_PREFIX = 'local:';

/** Why each non-send operation cannot go through this route. */
const UNSUPPORTED_REASON = Object.freeze({
  [OPS.patchCard]: 'OpenLark sends immutable messages through this path; there is nothing to patch in place',
  [OPS.createCardEntity]: 'CardKit entities are a platform REST concept with no gateway equivalent here',
  [OPS.updateCardEntity]: 'CardKit entities are a platform REST concept with no gateway equivalent here',
  [OPS.cardSettings]: 'CardKit entities are a platform REST concept with no gateway equivalent here',
  [OPS.streamText]: 'streaming into a card needs a card entity, which this route cannot create',
});

/** Thrown for an operation this route structurally cannot perform. */
export class UnsupportedOpenLarkOp extends Error {
  constructor(op, reason) {
    super(`openlark cannot perform ${String(op)}: ${reason}`);
    this.name = 'UnsupportedOpenLarkOp';
    this.op = op ?? null;
  }
}

/** Thrown when the far side was reached and said no, or could not be reached.
 *  Either way nothing was sent, which is what the pacer needs to hear. */
export class OpenLarkRefused extends Error {
  constructor(message, { rateLimited = false } = {}) {
    super(message);
    this.name = 'OpenLarkRefused';
    this.rateLimited = rateLimited;
  }
}

/**
 * Turn a relay operation descriptor into the shim's request body.
 *
 * Refuses everything but a chat-addressed `message.send`, before anything
 * leaves the process. `replyTo` is refused for the same reason `allowlistSink`
 * refuses `patchCard`: a message id does not name its chat, so there is nothing
 * an allowlist could check it against, and permitting it would make the
 * allowlist bypassable by anything that can produce a message id.
 */
export function toOpenLarkRequest(op) {
  if (!op || typeof op !== 'object') throw new UnsupportedOpenLarkOp(op, 'not an operation descriptor');
  if (op.op !== OPS.sendMessage) {
    throw new UnsupportedOpenLarkOp(op.op, UNSUPPORTED_REASON[op.op] ?? 'it is not a known outbound operation');
  }
  if (typeof op.replyTo === 'string' && op.replyTo !== '') {
    throw new UnsupportedOpenLarkOp(
      op.op,
      'a reply is addressed by message id, which cannot be attributed to an allowlisted chat',
    );
  }
  if (typeof op.receiveId !== 'string' || !OPENLARK_CHAT_ID.test(op.receiveId)) {
    throw new TypeError('message.send needs an OpenLark numeric feed id as receiveId');
  }
  // This route sends text over the gateway. A card would need an entity it
  // cannot create, so a non-text msgType is refused rather than flattened into
  // text, which would post a person's raw card JSON into their chat.
  if (op.msgType !== undefined && op.msgType !== 'text') {
    throw new UnsupportedOpenLarkOp(op.op, `this route sends text, not ${JSON.stringify(op.msgType)}`);
  }
  const text = textOf(op.content);
  if (text === '') throw new TypeError('message.send needs a non-empty text content');
  if (typeof op.uuid !== 'string' || op.uuid === '') {
    // The gateway's own de-duplication is keyed on this. Without it a retry
    // after a timed-out send posts the message twice.
    throw new TypeError('message.send needs a non-empty uuid to make a retry idempotent');
  }
  return Object.freeze({ action: 'send', chatId: op.receiveId, text, clientId: op.uuid });
}

/**
 * Pull the text out of a `message.send` content, accepting both the serialised
 * and the object form -- `toCliInvocation` has to handle both, so this does
 * too rather than making "did you remember to stringify" a per-call-site
 * question with a different answer on each route.
 */
function textOf(content) {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{')) return content;
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed?.text === 'string' ? parsed.text : '';
    } catch {
      // Not JSON after all; it was a bare string that happened to start with a
      // brace. Send it as written rather than dropping it.
      return content;
    }
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

/** Does this failure mean "slow down" rather than "that was wrong"? */
export function openLarkRateLimited(message) {
  const text = String(message ?? '');
  return /\b429\b/.test(text)
    || /rate.?limit/i.test(text)
    || /too many/i.test(text)
    || /频率|过于频繁|请求过快/.test(text);
}

/**
 * A sink that posts one operation to the OpenLark shim and waits for its
 * verdict.
 *
 * Intended as the `inner` of `allowlistSink`, never as a relay's sink directly:
 * it deliberately has no `allowCard`, so using it where CardKit mode expects a
 * card-capable sink fails loudly at the first card write instead of quietly
 * becoming one line in `failures`.
 *
 * @param {object} init
 * @param {string} init.endpoint Absolute URL of the shim's send endpoint.
 * @param {string} init.nonce Shared secret. Required; no default.
 * @param {Function} [init.fetch] Injected for tests.
 * @param {number} [init.timeoutMs] Abort a hung shim rather than wedging the tick.
 */
export function openLarkSink({
  endpoint,
  nonce,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
} = {}) {
  if (typeof endpoint !== 'string' || endpoint === '') throw new TypeError('openLarkSink needs an endpoint');
  // No default: an empty nonce would authenticate every caller, and a sink that
  // can post into a person's chat is not something to leave open by accident.
  if (typeof nonce !== 'string' || nonce === '') throw new TypeError('openLarkSink needs a nonce');
  if (typeof fetchImpl !== 'function') throw new TypeError('openLarkSink needs a fetch');
  if (!(timeoutMs > 0)) throw new RangeError('timeoutMs must be positive');

  return Object.freeze({
    sealed: false,
    async perform(op) {
      const request = toOpenLarkRequest(op);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [OPENLARK_NONCE_HEADER]: nonce },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
      } catch (error) {
        throw new OpenLarkRefused(`the openlark shim did not answer: ${String(error?.message ?? error)}`);
      } finally {
        clearTimeout(timer);
      }

      let body = null;
      try {
        body = await response.json();
      } catch {
        throw new OpenLarkRefused(`the openlark shim answered HTTP ${response.status} with a body that is not JSON`);
      }
      if (body?.ok !== true) {
        const error = String(body?.error ?? `the openlark shim answered HTTP ${response.status}`);
        throw new OpenLarkRefused(error, {
          rateLimited: body?.rateLimited === true || openLarkRateLimited(error),
        });
      }
      if (typeof body.messageId !== 'string' || body.messageId === '') {
        throw new OpenLarkRefused('the openlark shim reported success without a message id');
      }
      if (body.messageId.startsWith(PENDING_PREFIX)) {
        // OpenLark mints `local:<clientId>` to track a send before the upstream
        // answers. Seeing it here means the upstream never confirmed, so this
        // is not a send however cheerful the envelope looks.
        throw new OpenLarkRefused('the openlark shim reported a pending local id, not an upstream message id');
      }
      // Shaped like the platform's own envelope, because that is what the rest
      // of the relay already reads.
      return { code: 0, msg: 'success', data: { message_id: body.messageId } };
    },
  });
}
