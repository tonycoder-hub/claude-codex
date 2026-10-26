// The transcript model: a pure fold over app-server notifications.
//
// `reduce(state, notification) -> state` is the only way the transcript ever
// changes, which buys three things that matter here:
//
//  - It is testable without a DOM. Every interesting case (deltas interleaved
//    across items, a delta that arrives before its item/started, a turn that
//    ends with an item still open, an approval landing mid-turn) is a plain
//    array of notifications and a deepEqual.
//  - It gives the view a cheap change check. State is structurally shared:
//    `next.items[id] !== prev.items[id]` is true only for items that actually
//    changed, so app.mjs re-renders one node per delta instead of the
//    transcript. A notification that changes nothing returns the *same* state
//    object by identity, so the view can skip the frame entirely.
//  - Ordering policy lives in one auditable place rather than in event handlers.
//
// Shapes here were read off the app-server implementation, not guessed. Three
// of them are worth knowing about because they are traps:
//
//  1. `item/reasoning/summaryTextDelta` and `item/reasoning/textDelta` are
//     emitted for the SAME underlying reasoning delta -- the server sends both.
//     They are accumulated into separate buffers (matching the wire item's
//     separate `summary` and `content` arrays) and the view renders only one.
//     Concatenating both into one string double-prints every reasoning token.
//  2. Approval decisions are 'accept' | 'acceptForSession' | 'decline' |
//     'cancel'. Not 'approved'. An unrecognised value is silently treated as
//     'decline' by the server, so a typo here reads as the user refusing.
//  3. `item/fileChange/requestApproval` carries no diff -- only an itemId. The
//     patch arrives separately on `item/fileChange/patchUpdated`, deliberately
//     emitted first. So an approval prompt can only show the diff by looking up
//     the item it points at, which is why approvals keep `itemId` and the view
//     joins them.

/** The exact decision strings the server accepts. Anything else means decline. */
export const DECISIONS = Object.freeze(['accept', 'acceptForSession', 'decline', 'cancel']);

/**
 * Build an approval result, with the decision as a closed set.
 *
 * This throws rather than coercing, and that is the entire point. The server's
 * `normalizeDecision` recognises exactly the four strings above and silently
 * turns anything else into 'decline' -- so a typo, or a placeholder like
 * 'approved', yields a UI that looks like the user allowed the command while
 * the tool call is actually refused, with no error logged anywhere on either
 * side. A loud failure here is the only way that bug ever gets noticed.
 */
export function decisionResult(decision) {
  if (!DECISIONS.includes(decision)) {
    throw new RangeError(
      `"${String(decision)}" is not a decision the server accepts ` +
      `(${DECISIONS.join(' | ')}); it would be silently coerced to decline`,
    );
  }
  return { decision };
}

/** `item/fileChange/requestApproval` omits availableDecisions; all four apply. */
const DEFAULT_DECISIONS = DECISIONS;

/**
 * Build the result for `item/tool/requestUserInput`.
 *
 * The wire shape is an OBJECT KEYED BY QUESTION ID, not an array:
 *
 *   { answers: { q0: { answers: ['staging'], notes: '…' }, q1: … } }
 *
 * The server looks each question up by `question.id` (`slot[q.id]`), so an
 * array would miss every question and answer all of them with nothing. Free
 * text goes in `notes`, which the server uses when the picked set is empty or
 * contains 'Other'.
 *
 * `id` is keyed through String() rather than skipped when it is missing, which
 * looks wrong and is not. Questions reach the adapter from a tool's arguments
 * and are forwarded with their fields untouched, so `id` is not guaranteed to
 * be there -- and the adapter's lookup is a plain property access, `slot[q.id]`,
 * which for a missing id reads the key `'undefined'`. Emitting that exact key
 * is therefore what delivers the answer; omitting the question (the obvious
 * defensive move) hands the user's choice to a lookup that finds nothing and
 * records an empty answer, with no error anywhere. Two id-less questions in one
 * request do collide on that key, but so do the adapter's own `empty` and `out`
 * maps, so there is nothing on this side that could distinguish them.
 *
 * @param questions the `questions` array from the request params
 * @param picks     { [questionId]: { choice?: string, note?: string } }
 */
export function userInputResult(questions, picks = {}) {
  const answers = {};
  for (const question of questions ?? []) {
    const key = String(question?.id);
    const pick = picks[key] ?? {};
    const entry = { answers: typeof pick.choice === 'string' && pick.choice !== '' ? [pick.choice] : [] };
    if (typeof pick.note === 'string' && pick.note.trim() !== '') entry.notes = pick.note;
    answers[key] = entry;
  }
  // Every question gets a key even when unanswered, which is what the server's
  // own "empty" default looks like.
  return { answers };
}

const MAX_ERRORS = 20;

/** Local-only notification methods, fed in by app.mjs. Never seen on the wire. */
export const LOCAL_APPROVAL_RESOLVED = 'local/approvalResolved';

export function initialState() {
  return {
    threadId: null,
    threadStatus: null,
    // Render order of item ids. Replaced (not mutated) when an item is added.
    order: [],
    // id -> item model. Replaced shallowly when any one item changes.
    items: {},
    turn: null,
    activeTurnId: null,
    // Pending approvals / questions, oldest first. These block a turn, so the
    // view must keep them visible.
    approvals: [],
    tokenUsage: null,
    plan: null,
    errors: [],
    // Deltas discarded because their item was already closed. Surfaced so a
    // protocol problem shows up as a number rather than as missing text.
    droppedDeltas: 0,
    revision: 0,
  };
}

function blankItem(id, turnId) {
  return {
    id,
    // 'unknown' until item/started arrives. A delta can legitimately get here
    // first, and dropping it would lose model output.
    type: 'unknown',
    status: 'inProgress',
    closed: false,
    closedBy: null,
    turnId: turnId ?? null,
    text: '',
    // Separate buffers, indexed the way the wire indexes them. See trap 1.
    reasoning: { summary: [], content: [] },
    output: '',
    changes: [],
    // The last full wire item. The view reads per-type fields (command, cwd,
    // exitCode, tool, query, ...) from here, so the reducer does not need a
    // branch for each of the fifteen item types.
    wire: null,
    startedAtMs: null,
    completedAtMs: null,
    revision: 0,
  };
}

/** Append `delta` at `index` in a sparse-ish string array, filling gaps. */
function appendAt(list, index, delta) {
  const at = Number.isInteger(index) && index >= 0 ? index : 0;
  const next = list.slice();
  while (next.length <= at) next.push('');
  next[at] = next[at] + delta;
  return next;
}

/**
 * Commit a changed item into state, cloning only what changed. Returns the same
 * state object when `mutate` reported no change.
 */
function withItem(state, id, turnId, mutate) {
  const existing = state.items[id];
  const base = existing ?? blankItem(id, turnId);
  const patch = mutate(base);
  if (patch === null) return state;

  const next = { ...base, ...patch, revision: base.revision + 1 };
  // A late item/started should not clobber a turnId we already learned, but an
  // orphan placeholder should pick one up.
  if (next.turnId === null && turnId != null) next.turnId = turnId;

  return {
    ...state,
    items: { ...state.items, [id]: next },
    order: existing ? state.order : [...state.order, id],
    revision: state.revision + 1,
  };
}

/**
 * Append streamed text to an item, unless the item is already closed.
 *
 * This is the whole of the duplicate/out-of-order policy, and it is worth being
 * honest about its limits. The protocol gives deltas no sequence number, so two
 * identical consecutive deltas are indistinguishable from the model genuinely
 * emitting the same token twice -- discarding them would corrupt "aa" into "a".
 * What IS detectable, and handled, is a delta arriving after the item was
 * closed by `item/completed` (whose text is authoritative) or by its turn
 * ending. Those are dropped and counted.
 */
function appendStream(state, params, apply) {
  const { threadId, turnId, itemId, delta } = params ?? {};
  if (typeof itemId !== 'string' || typeof delta !== 'string' || delta === '') return state;
  if (state.threadId != null && threadId != null && threadId !== state.threadId) return state;

  const existing = state.items[itemId];
  if (existing && existing.closed) {
    return { ...state, droppedDeltas: state.droppedDeltas + 1, revision: state.revision + 1 };
  }
  return withItem(state, itemId, turnId, (item) => apply(item, delta));
}

/** Fold the authoritative wire item in, without losing streamed text. */
function adoptWireItem(item, wire) {
  const patch = { type: typeof wire.type === 'string' ? wire.type : item.type, wire };
  if (typeof wire.status === 'string') patch.status = wire.status;

  // Prefer the server's final value, but never trade real streamed text for an
  // empty one: some completion paths carry a stub item.
  if (typeof wire.text === 'string' && wire.text !== '') patch.text = wire.text;
  if (Array.isArray(wire.changes)) patch.changes = wire.changes;
  if (typeof wire.aggregatedOutput === 'string' && wire.aggregatedOutput !== '') {
    patch.output = wire.aggregatedOutput;
  }

  const summary = Array.isArray(wire.summary) ? wire.summary.filter((s) => typeof s === 'string') : null;
  const content = Array.isArray(wire.content) ? wire.content.filter((s) => typeof s === 'string') : null;
  if ((summary && summary.some((s) => s !== '')) || (content && content.some((s) => s !== ''))) {
    patch.reasoning = {
      summary: summary && summary.some((s) => s !== '') ? summary : item.reasoning.summary,
      content: content && content.some((s) => s !== '') ? content : item.reasoning.content,
    };
  }
  return patch;
}

function approvalFrom(notification) {
  const { method, params, requestId, wireId } = notification;
  const p = params ?? {};
  const kind = method === 'item/commandExecution/requestApproval'
    ? 'command'
    : method === 'item/fileChange/requestApproval'
      ? 'fileChange'
      : 'userInput';

  const approval = {
    requestId,
    // The JSON-RPC id of the inbound request, which is what
    // `serverRequest/resolved` reports. The only correlation key that works for
    // all three request kinds -- see the comment on that case below.
    wireId: wireId ?? null,
    kind,
    method,
    threadId: p.threadId ?? null,
    turnId: p.turnId ?? null,
    itemId: p.itemId ?? null,
    reason: p.reason ?? null,
    receivedAtMs: typeof p.startedAtMs === 'number' ? p.startedAtMs : null,
  };

  if (kind === 'command') {
    approval.command = typeof p.command === 'string' ? p.command : '';
    approval.cwd = typeof p.cwd === 'string' ? p.cwd : '';
    approval.approvalId = p.approvalId ?? null;
    const offered = Array.isArray(p.availableDecisions)
      ? p.availableDecisions.filter((d) => DECISIONS.includes(d))
      : [];
    approval.decisions = offered.length > 0 ? offered : DEFAULT_DECISIONS;
  } else if (kind === 'fileChange') {
    approval.grantRoot = p.grantRoot ?? null;
    approval.decisions = DEFAULT_DECISIONS;
  } else {
    approval.questions = Array.isArray(p.questions) ? p.questions : [];
    approval.decisions = [];
  }
  return approval;
}

export function reduce(state, notification) {
  if (!notification || typeof notification.method !== 'string') return state;
  const { method } = notification;
  const params = notification.params ?? {};

  switch (method) {
    // ---- thread lifecycle -------------------------------------------------
    case 'thread/started': {
      const id = params.thread?.id;
      if (typeof id !== 'string' || id === state.threadId) return state;
      return { ...state, threadId: id, revision: state.revision + 1 };
    }
    case 'thread/status/changed': {
      if (params.status === undefined) return state;
      return { ...state, threadStatus: params.status, revision: state.revision + 1 };
    }
    case 'thread/tokenUsage/updated': {
      if (!params.tokenUsage) return state;
      return { ...state, tokenUsage: params.tokenUsage, revision: state.revision + 1 };
    }

    // ---- turn lifecycle ---------------------------------------------------
    case 'turn/started': {
      const turn = params.turn;
      if (!turn || typeof turn.id !== 'string') return state;
      return {
        ...state,
        turn: { ...turn, status: turn.status ?? 'inProgress' },
        activeTurnId: turn.id,
        revision: state.revision + 1,
      };
    }
    case 'turn/completed': {
      const turn = params.turn;
      if (!turn || typeof turn.id !== 'string') return state;

      // Close anything still streaming. An item left open after its turn ends
      // would otherwise render as a permanent spinner, and any delta that
      // somehow follows must not be appended to it.
      const items = { ...state.items };
      let closedAny = false;
      for (const id of state.order) {
        const item = items[id];
        if (item.closed) continue;
        if (item.turnId !== null && item.turnId !== turn.id) continue;
        items[id] = {
          ...item,
          closed: true,
          closedBy: 'turn',
          status: item.status === 'inProgress' ? (turn.status ?? 'completed') : item.status,
          revision: item.revision + 1,
        };
        closedAny = true;
      }

      // An approval for a turn that has ended can never be answered; leaving
      // the prompt up would invite the user to tap a dead button.
      const approvals = state.approvals.filter((a) => a.turnId !== null && a.turnId !== turn.id);

      return {
        ...state,
        items: closedAny ? items : state.items,
        turn: { ...turn, status: turn.status ?? 'completed' },
        activeTurnId: state.activeTurnId === turn.id ? null : state.activeTurnId,
        approvals: approvals.length === state.approvals.length ? state.approvals : approvals,
        revision: state.revision + 1,
      };
    }
    case 'turn/plan/updated': {
      if (!Array.isArray(params.plan)) return state;
      return { ...state, plan: params.plan, revision: state.revision + 1 };
    }

    // ---- item lifecycle ---------------------------------------------------
    case 'item/started': {
      const wire = params.item;
      if (!wire || typeof wire.id !== 'string') return state;
      return withItem(state, wire.id, params.turnId, (item) => {
        // Idempotent: a repeated item/started must not reset accumulated text.
        const patch = adoptWireItem(item, wire);
        if (typeof params.startedAtMs === 'number' && item.startedAtMs === null) {
          patch.startedAtMs = params.startedAtMs;
        }
        return patch;
      });
    }
    case 'item/completed': {
      const wire = params.item;
      if (!wire || typeof wire.id !== 'string') return state;
      return withItem(state, wire.id, params.turnId, (item) => ({
        ...adoptWireItem(item, wire),
        closed: true,
        closedBy: 'item',
        status: typeof wire.status === 'string' ? wire.status : 'completed',
        completedAtMs: typeof params.completedAtMs === 'number' ? params.completedAtMs : item.completedAtMs,
      }));
    }

    // ---- streaming --------------------------------------------------------
    case 'item/agentMessage/delta':
      return appendStream(state, params, (item, delta) => ({
        text: item.text + delta,
        type: item.type === 'unknown' ? 'agentMessage' : item.type,
      }));

    case 'item/plan/delta':
      return appendStream(state, params, (item, delta) => ({
        text: item.text + delta,
        type: item.type === 'unknown' ? 'plan' : item.type,
      }));

    case 'item/reasoning/summaryTextDelta':
      return appendStream(state, params, (item, delta) => ({
        reasoning: {
          summary: appendAt(item.reasoning.summary, params.summaryIndex, delta),
          content: item.reasoning.content,
        },
        type: item.type === 'unknown' ? 'reasoning' : item.type,
      }));

    case 'item/reasoning/textDelta':
      return appendStream(state, params, (item, delta) => ({
        reasoning: {
          summary: item.reasoning.summary,
          content: appendAt(item.reasoning.content, params.contentIndex, delta),
        },
        type: item.type === 'unknown' ? 'reasoning' : item.type,
      }));

    case 'item/commandExecution/outputDelta':
      return appendStream(state, params, (item, delta) => ({
        output: item.output + delta,
        type: item.type === 'unknown' ? 'commandExecution' : item.type,
      }));

    case 'item/fileChange/patchUpdated': {
      const { itemId, turnId, changes } = params;
      if (typeof itemId !== 'string' || !Array.isArray(changes)) return state;
      return withItem(state, itemId, turnId, (item) => ({
        changes,
        type: item.type === 'unknown' ? 'fileChange' : item.type,
      }));
    }

    // ---- approvals (fed in from onRequest handlers) ------------------------
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
    case 'item/tool/requestUserInput': {
      if (notification.requestId == null) return state;
      if (state.approvals.some((a) => a.requestId === notification.requestId)) return state;
      return {
        ...state,
        approvals: [...state.approvals, approvalFrom(notification)],
        revision: state.revision + 1,
      };
    }
    case LOCAL_APPROVAL_RESOLVED: {
      const approvals = state.approvals.filter((a) => a.requestId !== notification.requestId);
      if (approvals.length === state.approvals.length) return state;
      return { ...state, approvals, revision: state.revision + 1 };
    }

    /**
     * The server resolved a request by itself -- auto-approved by policy, or
     * answered on another client. The card must come down either way.
     *
     * The `requestId` here is the JSON-RPC id of the request the server sent
     * us, so the correlation key is `wireId`, which the transport layer reads
     * off the envelope and the caller passes in. Matching on the `approvalId`
     * field as well is not redundant: command approvals carry it in their
     * params (the server sets `approvalId: requestId`), so a client that never
     * recorded the envelope id can still match those -- and fileChange and
     * userInput params carry no id at all, which is exactly why `wireId` has
     * to exist.
     */
    case 'serverRequest/resolved': {
      if (params.requestId == null) return state;
      const approvals = state.approvals.filter(
        (a) => a.wireId !== params.requestId && a.approvalId !== params.requestId,
      );
      if (approvals.length === state.approvals.length) return state;
      return { ...state, approvals, revision: state.revision + 1 };
    }

    // ---- errors -----------------------------------------------------------
    case 'error': {
      const message = params.error?.message;
      if (typeof message !== 'string') return state;
      const entry = { message, turnId: params.turnId ?? null, willRetry: params.willRetry === true };
      return {
        ...state,
        errors: [...state.errors, entry].slice(-MAX_ERRORS),
        revision: state.revision + 1,
      };
    }

    default:
      // Unknown methods are not errors. The server implements well over a
      // hundred of them and this UI subscribes to a deliberate subset.
      return state;
  }
}

/** Fold a whole sequence. Convenience for tests and for replaying history. */
export function reduceAll(state, notifications) {
  let next = state;
  for (const n of notifications) next = reduce(next, n);
  return next;
}

/** Items in render order. */
export function transcript(state) {
  return state.order.map((id) => state.items[id]);
}

/**
 * The reasoning text to display for an item. Exists because the server emits
 * the same reasoning delta twice, once as summary and once as content (trap 1
 * above): render the summary when there is one, and never both.
 */
export function reasoningText(item) {
  const summary = item.reasoning.summary.filter((s) => s !== '');
  if (summary.length > 0) return summary.join('\n\n');
  return item.reasoning.content.filter((s) => s !== '').join('\n\n');
}

/** True while the turn is live, i.e. the stop button should be enabled. */
export function isTurnActive(state) {
  return state.activeTurnId !== null;
}

/**
 * True when the turn is blocked on the user.
 *
 * The server says so directly via thread/status/changed's `activeFlags`, which
 * is more trustworthy than inferring it from our own pending list: it is also
 * set when something else is blocking, and cleared when the block lifts for a
 * reason this client never saw. The local list is kept as a fallback for the
 * window before the first status notification arrives.
 */
export function isWaitingOnUser(state) {
  const flags = state.threadStatus?.activeFlags;
  if (Array.isArray(flags)) {
    if (flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput')) return true;
  }
  return state.approvals.length > 0;
}
