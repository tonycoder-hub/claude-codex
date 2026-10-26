// The renderer: a projection snapshot in, card JSON 2.0 out.
//
// Split from `projection.mjs` so the fold stays protocol-agnostic and all the
// platform-shaped knowledge -- tag names, the 30 KB ceiling, which buttons an
// approval may legally offer -- lives in one file that can be rewritten when the
// card schema moves without touching the state machine.
//
// ## Two outputs, because there are two endpoints
//
// A streaming card is written through two different calls with very different
// costs, and the renderer's main job is to let the caller pick:
//
//   * `streamContent` -- the cumulative text of the agent's output, pushed with
//     `PUT /cardkit/v1/cards/:card_id/elements/:element_id/content`. Cheap,
//     intended to be called many times a second, and the platform animates it as
//     a typewriter **only when the previous text is a prefix of the new text**.
//   * `card` + `shellDigest` -- everything that is not the streaming text:
//     header, status, approval blocks, buttons, footer. Pushed with a full
//     card-entity update. `shellDigest` changes if and only if one of those
//     parts changed, so the caller can skip the expensive call on the common
//     path where only text grew.
//
// The cumulative-not-delta semantics are a gift, not a nuisance: the projection
// already holds the whole accumulated buffer, so a retried or re-ordered update
// converges instead of duplicating text. There is no delta bookkeeping anywhere
// in this subsystem, and a dropped update is self-healing by the next one.
//
// ## Verified platform facts this file encodes
//
//   * `schema: "2.0"`, with elements under `body.elements` (1.0 put them at the
//     top level; mixing the two renders nothing).
//   * the rich-text/Markdown component's `tag` has the fixed value `markdown`,
//     and it is the only component whose content can be stream-updated;
//   * a button attaches callback data as
//     `behaviors: [{ type: 'callback', value: {...} }]`, and that `value` comes
//     back as `event.action.value`;
//   * `config.update_multi` must be `true` -- 2.0 supports nothing else, and
//     streaming refuses `false` outright (error 300302);
//   * `interactive` content is capped at 30 KB; a streaming element's content at
//     100,000 characters.
//
// ## The privacy knob
//
// `detail` is the only mitigation this design has for the fact that the platform
// terminates TLS and therefore reads everything a card says. It is a real lever,
// not a checkbox:
//
//   * `full` -- the turn's output streams into the chat. Maximum utility, and
//     the private content is on someone else's servers.
//   * `brief` -- status, counts, and a short tail of the output. Enough to know
//     whether to walk to the machine.
//   * `notify` -- no model output and no diffs at all. The card becomes a pure
//     *control surface*: it says a turn is running, how many tools it has used,
//     and what is waiting for approval; the content stays on the Mac. Approval
//     summaries survive even here, because a person cannot approve a command
//     they are not shown, and a card that asks for blind consent is worse than
//     no card.

import { TURN_STATUS } from './projection.mjs';
import { LARK_LIMITS } from './transport.mjs';

/** The one element the streaming endpoint writes to. */
export const STREAM_ELEMENT_ID = 'turn_output';

/** How much of a turn a card is allowed to disclose. */
export const DETAIL = Object.freeze({
  full: 'full',
  brief: 'brief',
  notify: 'notify',
});

/** `action.value` discriminators. Short because the card has a byte budget. */
export const ACTION = Object.freeze({
  approval: 'ap',
  interrupt: 'int',
});

/**
 * The buttons an approval may offer, in the order they are shown.
 *
 * Every `decision` here is a member of the adapter's closed four-value set. That
 * is not a style preference: the adapter's `normalizeDecision` silently maps
 * anything it does not recognise to `decline`, so a button carrying `approve`
 * would round-trip cleanly and refuse every tool call. `inbound.mjs` re-checks
 * the value on the way back in, because a card's `value` is attacker-influenced
 * data by the time it returns.
 */
export const APPROVAL_BUTTONS = Object.freeze([
  { decision: 'accept', label: '批准', type: 'primary' },
  { decision: 'acceptForSession', label: '本会话都批准', type: 'default' },
  { decision: 'decline', label: '拒绝', type: 'danger' },
  { decision: 'cancel', label: '中止这一轮', type: 'text' },
]);

/**
 * Which buttons to show for one approval.
 *
 * The request's own `availableDecisions` wins when it has one -- the server is
 * the authority on what it will accept, and rendering a button it would reject
 * is how you get a card that looks like it works. Falls back to the full set
 * when the field is absent, and never renders a decision outside
 * `APPROVAL_BUTTONS`, so the vocabulary cannot widen by accident.
 */
export function buttonsFor(approval) {
  const offered = approval?.decisions;
  if (!Array.isArray(offered) || offered.length === 0) return APPROVAL_BUTTONS;
  const chosen = APPROVAL_BUTTONS.filter((button) => offered.includes(button.decision));
  return chosen.length > 0 ? chosen : APPROVAL_BUTTONS;
}

const HEADER_TEMPLATE = Object.freeze({
  [TURN_STATUS.pending]: 'grey',
  [TURN_STATUS.running]: 'blue',
  [TURN_STATUS.completed]: 'green',
  [TURN_STATUS.failed]: 'red',
  [TURN_STATUS.interrupted]: 'grey',
});

const STATUS_LABEL = Object.freeze({
  [TURN_STATUS.pending]: '排队中',
  [TURN_STATUS.running]: '执行中',
  [TURN_STATUS.completed]: '已完成',
  [TURN_STATUS.failed]: '失败',
  [TURN_STATUS.interrupted]: '已中断',
});

const encoder = new TextEncoder();

/** UTF-8 length, because the platform's 30 KB is bytes and emoji are four. */
export function byteLength(text) {
  return encoder.encode(text).length;
}

/**
 * Keep the tail of a long string.
 *
 * The tail, not the head: streaming output is read as it arrives, so the part a
 * person has not seen yet is at the end. Dropping the end to preserve the
 * beginning would hide exactly the newest text, which is the only part the
 * update was sent to deliver.
 */
export function clipTail(text, maxChars, marker = '…（前文已省略）\n') {
  if (typeof text !== 'string') return '';
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  if (marker.length >= maxChars) return text.slice(text.length - maxChars);
  return marker + text.slice(text.length - (maxChars - marker.length));
}

/**
 * Render a snapshot.
 *
 * @param {object} snapshot From `TurnProjection#snapshot()`.
 * @param {object} [options]
 * @param {string} [options.detail] One of `DETAIL`.
 * @param {string} [options.title] Header title; defaults to the thread id.
 * @param {string} [options.endId] Which resident end is running this turn.
 * @param {number} [options.briefChars] Tail length kept in `brief` mode.
 * @param {number} [options.cardByteBudget] Override the 30 KB ceiling.
 * @param {boolean} [options.streaming] Set `config.streaming_mode`.
 * @param {boolean} [options.interrupt] Include the 中断 button. Defaults on.
 *   Turn it **off** when nothing is listening for card callbacks: the button's
 *   `behaviors: [{ type: 'callback' }]` needs a business endpoint to answer
 *   inside 3 seconds, and a button that silently does nothing is worse on a
 *   phone than no button at all. `CARD_STRATEGY.snapshot` in `daemon.mjs` has
 *   no callback route, so it passes `false`.
 * @returns {{
 *   card: object, streamElementId: string, streamContent: string,
 *   shellDigest: string, bytes: number, truncated: boolean, revision: number
 * }}
 */
export function renderCard(snapshot, options = {}) {
  const {
    detail = DETAIL.full,
    title = null,
    endId = null,
    briefChars = 280,
    cardByteBudget = LARK_LIMITS.cardContentBytes,
    streaming = null,
    interrupt = true,
  } = options;
  if (!Object.hasOwn(DETAIL, detail)) throw new RangeError(`${detail} is not a detail level`);

  const streamContent = clipTail(
    outputText(snapshot, detail, briefChars),
    LARK_LIMITS.streamContentChars,
  );
  // Streaming mode follows the turn unless overridden: a terminal card is never
  // written again, so leaving it on would hold a card entity in a mode that
  // auto-expires in ten minutes and blocks callback-time updates.
  const streamOn = streaming === null ? !snapshot.terminal : streaming;

  let budget = streamContent.length;
  let truncated = streamContent.length < outputText(snapshot, detail, briefChars).length;
  let card = buildCard(snapshot, { detail, title, endId, streamOn, interrupt, streamText: streamContent });
  let bytes = byteLength(JSON.stringify(card));

  // A card that exceeds the ceiling is rejected whole (error 200860), so a
  // too-large card is a *lost* update, not a clipped one. Halve the embedded
  // text until it fits. The loop is bounded by the halving, and the floor of 0
  // is reachable: a card with no output text at all still fits, because
  // everything else in it is bounded by the item and approval counts.
  while (bytes > cardByteBudget && budget > 0) {
    budget = Math.floor(budget / 2);
    const clipped = clipTail(streamContent, budget);
    truncated = true;
    card = buildCard(snapshot, { detail, title, endId, streamOn, interrupt, streamText: clipped });
    bytes = byteLength(JSON.stringify(card));
  }

  return {
    card,
    streamElementId: STREAM_ELEMENT_ID,
    // The streaming endpoint has its own, far larger budget, so it carries the
    // full text even when the embedded copy had to be cut to fit the card.
    streamContent,
    shellDigest: digestShell(card),
    bytes,
    truncated,
    revision: snapshot.revision,
  };
}

/**
 * A stable string that changes iff something other than the streaming text
 * changed. The caller compares it to the previous one to decide whether a full
 * card update is owed on top of the cheap text push.
 *
 * Not hashed: this is compared, never stored or transmitted, and a hash would
 * add a `node:crypto` import plus the chance of pretending a collision is
 * impossible.
 */
export function digestShell(card) {
  const copy = structuredClone(card);
  for (const element of copy?.body?.elements ?? []) {
    if (element?.element_id === STREAM_ELEMENT_ID) element.content = '';
  }
  return JSON.stringify(copy);
}

// -- construction ------------------------------------------------------------

function outputText(snapshot, detail, briefChars) {
  if (detail === DETAIL.notify) return '';
  const parts = [];
  for (const item of snapshot.items) {
    if (item.text === '') continue;
    // Reasoning is the model thinking out loud; it is long, it is the least
    // useful thing on a phone screen, and in `brief` it is the first to go.
    if (detail === DETAIL.brief && item.kind !== null && /reasoning/i.test(item.kind)) continue;
    parts.push(item.text);
  }
  const joined = parts.join('\n\n');
  return detail === DETAIL.brief ? clipTail(joined, briefChars) : joined;
}

function buildCard(snapshot, { detail, title, endId, streamOn, interrupt, streamText }) {
  const elements = [];

  elements.push({ tag: 'markdown', element_id: STREAM_ELEMENT_ID, content: streamText });

  const tools = toolSummary(snapshot);
  if (tools !== null) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', element_id: 'tools', content: tools });
  }

  for (const approval of snapshot.approvals) {
    elements.push({ tag: 'hr' });
    elements.push(...approvalElements(approval, snapshot, detail));
  }

  if (interrupt && !snapshot.terminal && snapshot.status === TURN_STATUS.running) {
    elements.push({
      tag: 'button',
      element_id: 'interrupt',
      text: { tag: 'plain_text', content: '中断' },
      type: 'text',
      behaviors: [{ type: 'callback', value: { a: ACTION.interrupt, t: snapshot.turnId ?? '' } }],
    });
  }

  const footer = footerText(snapshot, endId);
  if (footer !== null) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', element_id: 'footer', content: footer });
  }

  const card = {
    schema: '2.0',
    config: {
      // 2.0 supports only `true`, and streaming rejects `false`. Stated
      // explicitly rather than relying on the default so the constraint is
      // visible at the place it would otherwise be violated.
      update_multi: true,
      streaming_mode: streamOn,
      summary: { content: `${STATUS_LABEL[snapshot.status] ?? snapshot.status}` },
    },
    header: {
      title: {
        tag: 'plain_text',
        content: title ?? `Claude Code · ${shortId(snapshot.threadId)}`,
      },
      template: HEADER_TEMPLATE[snapshot.status] ?? 'grey',
    },
    body: { elements },
  };
  if (streamOn) {
    // `print_frequency_ms` / `print_step` are client-side rendering parameters,
    // not a server-side call interval. The pacer owns the call interval.
    card.config.streaming_config = { print_strategy: 'fast' };
  }
  return card;
}

/**
 * One line per tool-ish item, with its state. Shown at every detail level
 * including `notify`: "it ran six commands" is metadata about progress, and
 * without it a `notify` card cannot distinguish working from wedged.
 */
function toolSummary(snapshot) {
  const rows = [];
  for (const item of snapshot.items) {
    if (item.kind === null) continue;
    if (/agentMessage|reasoning/i.test(item.kind)) continue;
    const mark = item.status === 'completed' ? '✓' : '·';
    rows.push(`${mark} ${item.kind}`);
  }
  if (rows.length === 0) return null;
  return rows.join('\n');
}

function approvalElements(approval, snapshot, detail) {
  const out = [];
  const lines = [`**需要批准 · ${approval.kind}**`, approval.summary];

  if (detail === DETAIL.full && approval.kind === 'fileChange') {
    // `item/fileChange/requestApproval` carries no diff. The diff, if it arrived
    // at all, is on the item the approval names -- which is why this correlates
    // on `itemId` here rather than trusting the approval payload.
    const item = approval.itemId === null
      ? null
      : snapshot.items.find((candidate) => candidate.id === approval.itemId) ?? null;
    if (item?.patch) lines.push('```diff\n' + clipTail(item.patch, 2000) + '\n```');
    else lines.push('_（补丁尚未到达，不要盲批）_');
  }

  if (!approval.byButton) {
    // `item/tool/requestUserInput` answers with `{ answers }`, free text. There
    // is no vocabulary a button could encode, and a button that tried would be
    // coerced to `decline`. So say so and route it to a reply instead.
    lines.push('_这一条需要文字回复，按钮无法作答。_');
  }

  out.push({ tag: 'markdown', element_id: `ask_${approval.requestId}`, content: lines.join('\n\n') });

  if (approval.byButton) {
    out.push({
      tag: 'column_set',
      element_id: `ans_${approval.requestId}`,
      columns: buttonsFor(approval).map((button) => ({
        tag: 'column',
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: button.label },
          type: button.type,
          behaviors: [{
            type: 'callback',
            // `r` is the server's UUID request id, echoed back verbatim.
            value: { a: ACTION.approval, r: approval.requestId, d: button.decision },
          }],
        }],
      })),
    });
  }
  return out;
}

function footerText(snapshot, endId) {
  const bits = [];
  bits.push(STATUS_LABEL[snapshot.status] ?? snapshot.status);
  if (endId !== null) bits.push(`end \`${endId}\``);
  if (snapshot.usage?.totalTokens != null) bits.push(`${snapshot.usage.totalTokens} tokens`);
  if (snapshot.error !== null) bits.push(`错误：${snapshot.error}`);
  if (snapshot.truncatedNote) bits.push(snapshot.truncatedNote);
  return bits.length === 0 ? null : bits.join(' · ');
}

function shortId(id) {
  if (typeof id !== 'string' || id === '') return 'new';
  return id.length <= 8 ? id : id.slice(0, 8);
}
