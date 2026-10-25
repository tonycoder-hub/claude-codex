// The first sink in this repository that can actually reach a person.
//
// `transport.mjs` has four sinks and none of them can send: `sealedSink`
// refuses, `allowlistSink` is a wrapper, `printingSink` prints, `recordingSink`
// records. This one hands an operation to the `feishu-lark` CLI running on the
// machine that holds the user's credential, and reports back what the CLI said.
//
// ## Why a CLI and not HTTP
//
// `toHttpRequest()` already renders the exact HTTP a real client would send, so
// the obvious sink is `fetch` plus a `tenant_access_token`. That is not the
// route taken here, for one reason: the credential. Sending as the *tenant*
// (a bot) requires the bot to be a member of the chat, and the chat this is
// being brought up against is a group the user created for himself alone --
// adding a bot to it makes the premise false. Sending as the *user* requires a
// user access token from an OAuth device flow, and that token lives in the
// macOS Keychain under the CLI's own service name. Re-implementing the device
// flow and the Keychain read in order to drive `fetch` would mean this
// repository handles a user token. It does not, and will not.
//
// So the credential stays inside `feishu-lark`, and this sink's whole job is to
// turn an operation descriptor into that CLI's argument object and to decide,
// from the CLI's stdout, whether anything actually happened.
//
// ## Why deciding that is the hard part
//
// `feishu-lark` (0.2.3) **always exits 0**. Success, a business-level refusal,
// and arguments that matched no code path at all are three different strings on
// stdout behind one exit status. The third case is the dangerous one and it was
// reproduced rather than reasoned about:
//
//     $ feishu-lark call feishu_chat --help ; echo "rc=$?"
//     undefined
//     rc=0
//
// `cmdCall` skips the zod schema entirely (zod only guards the MCP path), the
// tool's `switch (args.action)` falls through, `execute` returns `undefined`,
// and `console.log(undefined)` prints the five letters `undefined`. A sink that
// trusted the exit code would report "sent" for every malformed call, the relay
// would mark the card written, and the chat would stay empty. That is this
// project's recurring failure shape -- a green whose right-hand side is weaker
// than the claim -- so `readCliResult()` below treats *only* a parseable JSON
// object carrying a non-empty string `message_id` as a send.
//
// ## What this sink cannot do
//
// Four of the six operations in `OPS` are CardKit calls, and the CLI has no
// CardKit tool: `feishu_im_user_message` exposes `send` and `reply` and nothing
// else, and a grep of all 34 registered tools' schemas for `card_id` finds only
// unrelated calendar/bitable fields. So `createCardEntity`, `updateCardEntity`,
// `cardSettings` and `streamText` **throw**. They specifically do not return a
// plausible `{ code: 0, data: { card_id } }`, because `daemon.mjs` reads
// `created.data.card_id` and would then happily stream every subsequent delta
// into a card entity that was never created -- one visible frame in the chat and
// a relay that believes it wrote twenty. See `CARD_STRATEGY.snapshot` in
// `daemon.mjs` for the mode that works with this sink.

import { OPS, RATE_LIMIT_CODE } from './transport.mjs';

/** The one CLI tool this sink drives. */
export const CLI_TOOL = 'feishu_im_user_message';

/**
 * The CLI release every string in this file was read out of. Bump it together
 * with a re-read of `dist/tools/im/message.js` and `dist/core/api-error.js`:
 * `readCliResult()` depends on observed output shapes, not on a stable contract.
 */
export const CLI_VERSION_VERIFIED = '0.2.3';

/** The header the shim checks. Not a credential; a local anti-confusion token. */
export const NONCE_HEADER = 'x-imrelay-shim-nonce';

/** The ops that have no CLI tool behind them, with the reason, for the error. */
const UNSUPPORTED_REASON = Object.freeze({
  [OPS.createCardEntity]: 'the CLI registers no CardKit tool, so no card entity can be created',
  [OPS.updateCardEntity]: 'the CLI registers no CardKit tool, so a card entity cannot be rewritten',
  [OPS.cardSettings]: 'the CLI registers no CardKit tool, so card settings cannot be changed',
  [OPS.streamText]: 'the CLI registers no CardKit tool, so text cannot be streamed into a card',
  [OPS.patchCard]: 'feishu_im_user_message exposes only send and reply; there is no patch action',
});

/**
 * Thrown for an operation this sink structurally cannot perform.
 *
 * Distinct from `OutboundSealed` on purpose: sealed means "allowed in principle,
 * refused by policy", unsupported means "there is no API behind this at all".
 * Conflating them would make a missing CardKit tool look like something an
 * allowlist entry could fix.
 */
export class UnsupportedOp extends Error {
  constructor(op, reason) {
    super(`${String(op)} cannot be performed through the feishu-lark CLI: ${reason}`);
    this.name = 'UnsupportedOp';
    this.op = op ?? null;
    this.reason = reason;
  }
}

/** Thrown when the CLI ran but did not send anything. Carries the CLI's text. */
export class CliRefused extends Error {
  constructor(message, { rateLimited = false } = {}) {
    super(message);
    this.name = 'CliRefused';
    // `daemon.mjs`'s `rateLimited()` reads `.code`; see `looksRateLimited`.
    if (rateLimited) this.code = RATE_LIMIT_CODE;
  }
}

// -- the pure mapping --------------------------------------------------------

/**
 * Operation descriptor -> the argument object `feishu-lark call` wants.
 *
 * Pure, and the mirror of `toHttpRequest()`: same input, different renderer.
 * Separate from the sink so the argument shape is unit-testable with no CLI,
 * no account and no network -- which matters more here than for the HTTP
 * renderer, because a wrong argument here does not fail, it prints `undefined`.
 *
 * @param {object} op
 * @param {object} [options]
 * @param {'user'|'bot'} [options.sendAs] `user` posts as the authorised person;
 *   `bot` posts as the application and requires the bot to be in the chat.
 * @returns {{ tool: string, args: object }}
 */
export function toCliInvocation(op, { sendAs = 'user' } = {}) {
  if (!op || typeof op !== 'object') throw new UnsupportedOp(op, 'not an operation descriptor');
  if (op.op !== OPS.sendMessage) {
    throw new UnsupportedOp(op.op, UNSUPPORTED_REASON[op.op] ?? 'it is not a known outbound operation');
  }
  if (sendAs !== 'user' && sendAs !== 'bot') throw new TypeError('sendAs must be user or bot');
  if (typeof op.msgType !== 'string' || op.msgType === '') {
    throw new TypeError('message.send needs a non-empty msgType');
  }
  // The platform -- and therefore the CLI, which passes `content` straight
  // through to `im.v1.message.create` -- wants a JSON-serialised *string*.
  // Serialised here for the same reason `toHttpRequest` does it: "did you
  // remember to stringify" must not be a per-call-site question.
  const content = typeof op.content === 'string' ? op.content : JSON.stringify(op.content);
  if (content === undefined) throw new TypeError('message.send needs a content');

  if (typeof op.replyTo === 'string' && op.replyTo !== '') {
    return Object.freeze({
      tool: CLI_TOOL,
      args: pruned({
        action: 'reply',
        send_as: sendAs,
        message_id: op.replyTo,
        msg_type: op.msgType,
        content,
        uuid: op.uuid,
        reply_in_thread: op.replyInThread,
      }),
    });
  }

  if (typeof op.receiveId !== 'string' || op.receiveId === '') {
    throw new TypeError('message.send needs a non-empty receiveId');
  }
  return Object.freeze({
    tool: CLI_TOOL,
    args: pruned({
      action: 'send',
      send_as: sendAs,
      // A relay addresses conversations, never individual people -- same
      // reasoning as `toHttpRequest`.
      receive_id_type: op.receiveIdType ?? 'chat_id',
      receive_id: op.receiveId,
      msg_type: op.msgType,
      content,
      uuid: op.uuid,
    }),
  });
}

/**
 * The CLI's stdout -> what happened.
 *
 * Four shapes were observed from `feishu-lark` 0.2.3, and all four are handled
 * here because three of them are indistinguishable by exit code:
 *
 *   1. `{\n  "message_id": "om_...",\n  "chat_id": ...,\n  "create_time": ... }`
 *      -- `message.js` returns `JSON.stringify({...}, null, 2)` on success, so
 *      the success case is pretty-printed multi-line JSON, not one line.
 *   2. `{"error":"..."}` -- the tool's `catch` **returns** (does not throw) a
 *      one-key object. Covers missing auth, missing scope, and every API-level
 *      refusal.
 *   3. `undefined` -- arguments matched no `case` in the tool's switch. Exit 0.
 *   4. Anything else -- a stack trace, a log line, an empty buffer.
 *
 * Note case 1's `message_id` is read off `res.data?.message_id`, so a success
 * envelope with no data serialises to `{}`. `{}` is therefore a failure here,
 * not a success with a missing field.
 *
 * @param {string} stdout
 * @returns {{ ok: boolean, messageId: string|null, chatId: string|null, error: string|null, rateLimited: boolean }}
 */
export function readCliResult(stdout) {
  const text = typeof stdout === 'string' ? stdout.trim() : '';
  if (text === '') return refusal('the CLI printed nothing at all');
  if (text === 'undefined') {
    return refusal(
      'the CLI printed `undefined`, which is what it prints when the arguments '
      + 'match no action; nothing was sent',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refusal(`the CLI printed something that is not JSON: ${clip(text)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return refusal(`the CLI printed JSON that is not an object: ${clip(text)}`);
  }
  if (typeof parsed.error === 'string') {
    return refusal(parsed.error, { rateLimited: looksRateLimited(parsed.error) });
  }
  if (typeof parsed.message_id !== 'string' || parsed.message_id === '') {
    return refusal(`the CLI returned no message_id, so nothing was sent: ${clip(text)}`);
  }
  return Object.freeze({
    ok: true,
    messageId: parsed.message_id,
    chatId: typeof parsed.chat_id === 'string' ? parsed.chat_id : null,
    error: null,
    rateLimited: false,
  });
}

/**
 * Guess, from an error *string*, whether the platform throttled us.
 *
 * This is string matching and it is fragile, and that is not an oversight --
 * it is the only information left. `assertLarkOk` in the CLI's
 * `core/api-error.js` does `throw new Error(res.msg ?? ...)`: every numeric
 * code except `99991672` is discarded at that line, and the tool's catch then
 * narrows the error to `formatLarkError(err)`, which is `e.msg`. The CLI does
 * export `extractLarkApiCode()`, but no path reachable from
 * `feishu_im_user_message` calls it. So by the time anything observable leaves
 * the process, `99991400` exists only as whatever prose the platform put in
 * `msg`.
 *
 * Why bother at all: without this, `rateLimited(error)` in `daemon.mjs` can
 * never be true on this route, so a throttled send backs off by one coalescing
 * interval instead of a second and the next attempt is throttled too. A
 * deliberately fragile classifier that is wrong sometimes beats a branch that
 * is documented as handling throttling and provably never fires.
 *
 * Verified against CLI `CLI_VERSION_VERIFIED`; re-read `api-error.js` on bump.
 */
export function looksRateLimited(message) {
  if (typeof message !== 'string') return false;
  return /too\s*many\s*requests?/i.test(message)
    || /rate[-\s]?limit/i.test(message)
    || /\bfrequency\b/i.test(message)
    || /frequent/i.test(message)
    || /频率|过于频繁|请求过快/.test(message)
    || /\b99991400\b/.test(message);
}

// -- the sink ----------------------------------------------------------------

/**
 * A sink that posts one operation to the shim and waits for its verdict.
 *
 * Intended as the `inner` of `allowlistSink`, never as a relay's sink directly:
 * `daemon.mjs` calls `sink.allowCard(...)` unconditionally in CardKit mode and
 * the `Relay` constructor only checks for `perform`, so a bare sink would
 * TypeError at the first card write and land as one line in `failures`. This
 * object deliberately has no `allowCard`, so that mistake is loud.
 *
 * @param {object} init
 * @param {string} init.endpoint Absolute URL of the shim's send endpoint.
 * @param {string} init.nonce Shared secret for `NONCE_HEADER`. Required.
 * @param {Function} [init.fetch] Injected for tests; defaults to global fetch.
 * @param {'user'|'bot'} [init.sendAs]
 * @param {number} [init.timeoutMs] Abort a hung shim rather than wedging the tick.
 */
export function feishuSink({
  endpoint,
  nonce,
  fetch: fetchImpl = globalThis.fetch,
  sendAs = 'user',
  timeoutMs = 20000,
} = {}) {
  if (typeof endpoint !== 'string' || endpoint === '') throw new TypeError('feishuSink needs an endpoint');
  // No default: an empty nonce would authenticate every caller, and a sink that
  // can post into a person's chat is not something to leave open by accident.
  if (typeof nonce !== 'string' || nonce === '') throw new TypeError('feishuSink needs a nonce');
  if (typeof fetchImpl !== 'function') throw new TypeError('feishuSink needs a fetch');
  if (!(timeoutMs > 0)) throw new RangeError('timeoutMs must be positive');

  return Object.freeze({
    sealed: false,
    async perform(op) {
      // Throws `UnsupportedOp` for all five non-send operations before anything
      // leaves the process.
      const invocation = toCliInvocation(op, { sendAs });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [NONCE_HEADER]: nonce },
          body: JSON.stringify(invocation),
          signal: controller.signal,
        });
      } catch (error) {
        // An abort and a refused connection are both "nothing was sent", which
        // is what the pacer needs to hear; it keeps the pending revision.
        throw new CliRefused(`the shim did not answer: ${String(error?.message ?? error)}`);
      } finally {
        clearTimeout(timer);
      }

      let body = null;
      try {
        body = await response.json();
      } catch {
        throw new CliRefused(`the shim answered HTTP ${response.status} with a body that is not JSON`);
      }
      if (body?.ok !== true) {
        throw new CliRefused(
          `${String(body?.error ?? `the shim answered HTTP ${response.status}`)}`,
          { rateLimited: body?.rateLimited === true },
        );
      }
      if (typeof body.messageId !== 'string' || body.messageId === '') {
        throw new CliRefused('the shim reported success without a message id');
      }
      // Shaped like the platform's own envelope, because that is what the rest
      // of the relay already reads.
      return { code: 0, msg: 'success', data: { message_id: body.messageId } };
    },
  });
}

// -- helpers -----------------------------------------------------------------

function refusal(error, { rateLimited = false } = {}) {
  return Object.freeze({ ok: false, messageId: null, chatId: null, error, rateLimited });
}

/** Keep a diagnostic short, and keep a whole card out of a log line. */
function clip(text, max = 200) {
  return text.length <= max ? text : `${text.slice(0, max)}…(${text.length} chars)`;
}

function pruned(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
