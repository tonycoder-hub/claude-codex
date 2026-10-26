// The projection: app-server `item/*` / `turn/*` notifications in, one
// renderable view of a turn out.
//
// This file exists because an IM surface cannot be a byte pipe. The browser
// client in `03-reframe.md` gets the raw JSON-RPC stream and re-renders on every
// frame, which is correct there and impossible here: a chat message is a single
// mutable object that you are allowed to edit a small, bounded number of times
// per second. So something has to *fold* a few hundred deltas into one document
// and tell the caller "this is what the card should say now".
//
// Three properties the folding has to have, each of which is a bug if missing:
//
//   1. **Monotonic revision.** Every change that would alter the rendered card
//      bumps `revision`; a notification that changes nothing visible does not.
//      The throttle in `throttle.mjs` compares revisions to decide whether an
//      update is owed, so a revision that moves when nothing changed burns the
//      update budget on a no-op, and one that fails to move leaves the card
//      permanently stale.
//   2. **Terminal states are marked, not inferred.** `turn/completed` arrives
//      once; if the projection loses it the card says "running" forever and the
//      person on the phone has no way to tell a slow turn from a dead one.
//   3. **Nothing is dropped silently.** A delta for an item we never saw start,
//      a notification for another thread, a malformed payload -- all of these
//      are *recorded* in `anomalies` rather than thrown or ignored, because the
//      projection runs inside a notification handler whose throw would be
//      swallowed by `AppServerClient#invoke` anyway.
//
// ## What is verified and what is not
//
// Verified elsewhere in this repo (`03-reframe.md` §3, §6.5) and relied on here:
//
//   * the streaming sequence is
//     `item/started -> item/*/delta -> item/completed -> turn/completed`;
//   * a delta payload is `{ itemId, delta }`;
//   * `turn/started` / `turn/completed` are `{ threadId, turn: { id, status } }`;
//   * `item/fileChange/requestApproval` carries **no diff** -- the diff arrives
//     separately as `item/fileChange/patchUpdated` and must be correlated on
//     `itemId`;
//   * server->client request ids are UUID *strings*.
//
// **Not verified:** the exact envelope of `item/started` / `item/completed`.
// The probe in `tools/probe/appserver-slice.mjs` showed the method names and the
// delta shape, not the field names inside the item object. So every read of that
// envelope goes through `itemIdOf()` and `readItemKind()` below, which accept
// the three plausible spellings. When someone finally captures a real payload,
// those two functions are the only things to correct -- that is the whole reason
// they exist as named functions instead of inline property reads.

/** The statuses a turn can be in, as this projection reports them. */
export const TURN_STATUS = Object.freeze({
  pending: 'pending', // created, no `turn/started` seen yet
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  interrupted: 'interrupted',
});

/**
 * Statuses the app-server's `turn.status` has been observed or documented to
 * use, mapped onto ours. An unrecognised status is kept verbatim and recorded as
 * an anomaly rather than coerced, because silently showing "completed" for a
 * status we did not understand is the worst available outcome.
 */
const TURN_STATUS_ALIASES = Object.freeze({
  inProgress: TURN_STATUS.running,
  in_progress: TURN_STATUS.running,
  running: TURN_STATUS.running,
  completed: TURN_STATUS.completed,
  complete: TURN_STATUS.completed,
  failed: TURN_STATUS.failed,
  error: TURN_STATUS.failed,
  interrupted: TURN_STATUS.interrupted,
  cancelled: TURN_STATUS.interrupted,
  canceled: TURN_STATUS.interrupted,
});

/** The three server->client requests that block a turn until answered. */
export const APPROVAL_KINDS = Object.freeze({
  'item/commandExecution/requestApproval': 'commandExecution',
  'item/fileChange/requestApproval': 'fileChange',
  'item/tool/requestUserInput': 'userInput',
});

/**
 * Which approvals a card *button* can answer.
 *
 * `commandExecution` and `fileChange` answer with `{ decision }` drawn from a
 * closed four-value set, which is exactly what a row of buttons encodes.
 * `item/tool/requestUserInput` answers with `{ answers }` -- free text, no
 * vocabulary -- so buttons cannot express it and the card has to ask for a
 * reply instead. Getting this wrong is not cosmetic: the adapter coerces any
 * unrecognised decision to `decline`, so a button wired to a userInput request
 * would look like it worked and refuse the tool.
 */
export const BUTTON_ANSWERABLE = Object.freeze(['commandExecution', 'fileChange']);

/** Cap on recorded anomalies, so a misbehaving peer cannot grow this forever. */
const MAX_ANOMALIES = 32;

const DELTA_METHOD = /^item\/([A-Za-z0-9_]+)\/delta$/;

/**
 * Pull an item id out of a notification payload.
 *
 * Deltas are verified to be `{ itemId, delta }`. The lifecycle notifications
 * are not verified, so accept both the flat and the nested spelling. See the
 * header note.
 */
export function itemIdOf(params) {
  if (!params || typeof params !== 'object') return null;
  const direct = params.itemId;
  if (typeof direct === 'string' && direct !== '') return direct;
  const nested = params.item;
  if (nested && typeof nested === 'object' && typeof nested.id === 'string' && nested.id !== '') {
    return nested.id;
  }
  return null;
}

/**
 * The thread a notification claims, or null when it names none.
 *
 * Exported alongside `itemIdOf` for one reason: the daemon has to decide
 * which projection a notification belongs to *before* any projection can
 * judge it, and a second reader is how the two drift. The daemon had one --
 * it read the flat `params.threadId` only -- so every notification using the
 * nested spelling was unroutable the moment a second turn was open, and the
 * single-open-turn fallback hid it in every test and in the one-lane case.
 */
export function threadIdOf(params) {
  const claimed = params?.threadId ?? params?.thread?.id ?? null;
  return typeof claimed === 'string' && claimed !== '' ? claimed : null;
}

/** Same deal for the item's kind, which drives how the card renders it. */
function readItemKind(params, fallback = null) {
  const nested = params?.item;
  for (const candidate of [nested?.itemType, nested?.type, nested?.kind, params?.itemType]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return fallback;
}

/**
 * Text the server considers final for an item. When present this *replaces* the
 * delta-accumulated buffer rather than appending to it: the deltas are a
 * progressive approximation and the completed payload is authoritative, so
 * concatenating both would double the message.
 */
function readItemText(params) {
  const nested = params?.item;
  for (const candidate of [nested?.text, nested?.content, params?.text]) {
    if (typeof candidate === 'string') return candidate;
  }
  return null;
}

function readTurn(params) {
  const turn = params?.turn;
  if (turn && typeof turn === 'object') return turn;
  return null;
}

/**
 * One turn, folded.
 *
 * Deliberately a mutable class rather than an immutable reducer: a turn is a few
 * hundred string appends, and rebuilding the state object per delta would be
 * quadratic in the output length for no benefit anyone can observe. `snapshot()`
 * is the pure read -- it is what the renderer and the tests look at, and it is a
 * fresh object every time so a caller cannot reach back in and mutate state.
 */
export class TurnProjection {
  #threadId;
  #turnId = null;
  #chatKey;
  #status = TURN_STATUS.pending;
  #rawStatus = null;
  #items = new Map(); // itemId -> item record, insertion-ordered
  #approvals = new Map(); // requestId -> approval record
  #usage = null;
  #error = null;
  #anomalies = [];
  #revision = 0;
  #startedAt = null;
  #endedAt = null;

  /**
   * @param {object} init
   * @param {string} init.chatKey Opaque identifier for the conversation this
   *   turn is being rendered into. The projection never interprets it; it is
   *   carried so a caller juggling many projections can tell them apart.
   * @param {string} [init.threadId] The app-server thread. When set, every
   *   notification naming a *different* thread is rejected -- one end streams
   *   every thread it is running down one socket, so a projection that does not
   *   filter would interleave two conversations into one card.
   * @param {string} [init.turnId]
   */
  constructor({ chatKey, threadId = null, turnId = null } = {}) {
    if (typeof chatKey !== 'string' || chatKey === '') {
      throw new TypeError('a projection needs a non-empty chatKey');
    }
    this.#chatKey = chatKey;
    this.#threadId = threadId;
    this.#turnId = turnId;
  }

  get revision() { return this.#revision; }
  get status() { return this.#status; }
  get threadId() { return this.#threadId; }
  get turnId() { return this.#turnId; }
  /** True once the turn can produce no further output. */
  get terminal() {
    return this.#status === TURN_STATUS.completed
      || this.#status === TURN_STATUS.failed
      || this.#status === TURN_STATUS.interrupted;
  }

  /**
   * Fold one notification in. Returns true when the rendered card would change.
   *
   * Never throws: this is called from a notification handler, and a throw there
   * is swallowed by the client and loses the rest of the stream. Anything
   * unusable lands in `anomalies` instead.
   *
   * @param {string} method JSON-RPC method of the notification.
   * @param {object} params
   * @param {number} [at] Monotonic timestamp, injected rather than read from a
   *   clock so tests are deterministic.
   */
  apply(method, params, at = null) {
    if (typeof method !== 'string' || method === '') {
      return this.#anomaly('notification with no method');
    }
    if (!this.#belongs(params)) {
      return this.#anomaly(`${method} is for another thread`);
    }

    const delta = DELTA_METHOD.exec(method);
    if (delta) return this.#applyDelta(delta[1], params);

    switch (method) {
      case 'turn/started': return this.#applyTurnStarted(params, at);
      case 'turn/completed': return this.#applyTurnCompleted(params, at);
      case 'item/started': return this.#applyItemStarted(params);
      case 'item/updated': return this.#applyItemUpdated(params);
      case 'item/completed': return this.#applyItemCompleted(params);
      case 'item/fileChange/patchUpdated': return this.#applyPatch(params);
      case 'thread/tokenUsage/updated': return this.#applyUsage(params);
      case 'thread/status/changed': return false; // thread-level, not turn-level
      default:
        // Not an error. The item stream carries plenty this projection has no
        // opinion about, and `03-reframe.md` counts over a hundred methods.
        return false;
    }
  }

  /**
   * Record a server->client approval request. Separate from `apply()` because it
   * is a *request*, not a notification: somebody is blocked on the answer, and
   * the card is the only place the answer can come from.
   *
   * @param {object} request
   * @param {string} request.requestId The server's UUID string. Echoed back
   *   verbatim; never reused as an integer.
   * @param {string} request.method One of `APPROVAL_KINDS`.
   * @param {object} [request.params] The request params, as received.
   */
  openApproval({ requestId, method, params = {} } = {}) {
    if (typeof requestId !== 'string' || requestId === '') {
      return this.#anomaly('approval request with no id');
    }
    const kind = APPROVAL_KINDS[method];
    if (!kind) return this.#anomaly(`${method} is not an approval request`);
    if (this.#approvals.has(requestId)) return false; // a retry, not a new ask

    const itemId = itemIdOf(params);
    this.#approvals.set(requestId, {
      requestId,
      kind,
      method,
      itemId,
      // `fileChange` approvals carry no diff (verified). The diff, if it has
      // arrived, is on the item -- which is why correlation happens here, at
      // render time, rather than by mutating the approval later.
      summary: summariseApproval(kind, params),
      byButton: BUTTON_ANSWERABLE.includes(kind),
      // The request tells us which decisions it will accept. Taking the
      // server's word for it beats hardcoding the vocabulary a second time --
      // and intersecting with the known-legal set means a server that offers
      // something new cannot talk us into sending a value the adapter would
      // silently turn into `decline`.
      decisions: readAvailableDecisions(params),
      params,
    });
    return this.#touch();
  }

  /** The approval has been answered (or abandoned); stop showing its buttons. */
  closeApproval(requestId, decision = null) {
    const open = this.#approvals.get(requestId);
    if (!open) return false;
    this.#approvals.delete(requestId);
    if (decision !== null) open.decision = decision;
    return this.#touch();
  }

  /** Approvals still waiting on a human, oldest first. */
  pendingApprovals() {
    return [...this.#approvals.values()].map((entry) => ({ ...entry }));
  }

  /**
   * Force the turn into a terminal state from outside -- the end's socket died,
   * the dispatcher gave up, `turn/interrupt` was issued. The app-server will not
   * send `turn/completed` in any of those cases, and a card stuck on "running"
   * is indistinguishable from a hung one.
   */
  conclude(status, { error = null, at = null } = {}) {
    const resolved = TURN_STATUS[status] ?? null;
    if (resolved === null) return this.#anomaly(`${status} is not a turn status`);
    if (this.#status === resolved && this.#error === error) return false;
    this.#status = resolved;
    this.#rawStatus = status;
    if (error !== null) this.#error = String(error);
    if (this.#endedAt === null) this.#endedAt = at;
    return this.#touch();
  }

  /** A fresh plain object describing everything the renderer may look at. */
  snapshot() {
    return {
      chatKey: this.#chatKey,
      threadId: this.#threadId,
      turnId: this.#turnId,
      status: this.#status,
      rawStatus: this.#rawStatus,
      revision: this.#revision,
      terminal: this.terminal,
      startedAt: this.#startedAt,
      endedAt: this.#endedAt,
      error: this.#error,
      usage: this.#usage === null ? null : { ...this.#usage },
      items: [...this.#items.values()].map((item) => ({ ...item })),
      approvals: this.pendingApprovals(),
      anomalies: [...this.#anomalies],
    };
  }

  // -- folding ---------------------------------------------------------------

  /**
   * Thread filtering. A payload with no thread id at all is accepted: deltas are
   * `{ itemId, delta }` with no thread in them, and refusing those would discard
   * the entire streaming story.
   */
  #belongs(params) {
    if (this.#threadId === null) return true;
    const claimed = threadIdOf(params);
    if (claimed === null) return true;
    return claimed === this.#threadId;
  }

  #applyTurnStarted(params, at) {
    const turn = readTurn(params);
    const id = typeof turn?.id === 'string' ? turn.id : null;
    if (id !== null) this.#turnId = id;
    if (this.#threadId === null && typeof params?.threadId === 'string') {
      this.#threadId = params.threadId;
    }
    if (this.#startedAt === null) this.#startedAt = at;
    return this.#setStatus(turn?.status ?? 'inProgress');
  }

  #applyTurnCompleted(params, at) {
    const turn = readTurn(params);
    const id = typeof turn?.id === 'string' ? turn.id : null;
    // A `turn/completed` for a turn we are not showing must not conclude this
    // card. Only reachable when the caller left `turnId` unpinned and two turns
    // overlap, but the failure mode -- one turn's end marking another's card
    // finished -- is bad enough to guard.
    if (id !== null && this.#turnId !== null && id !== this.#turnId) {
      return this.#anomaly(`turn/completed is for turn ${id}, not ${this.#turnId}`);
    }
    if (id !== null) this.#turnId = id;
    if (this.#endedAt === null) this.#endedAt = at;
    // Items still "running" at turn end are not running. Nothing more will
    // arrive for them, so leaving a spinner on each is a lie.
    for (const item of this.#items.values()) {
      if (item.status === 'running') item.status = 'completed';
    }
    return this.#setStatus(turn?.status ?? 'completed');
  }

  #setStatus(raw) {
    const mapped = TURN_STATUS_ALIASES[raw];
    if (mapped === undefined) {
      this.#rawStatus = typeof raw === 'string' ? raw : null;
      this.#anomaly(`unrecognised turn status ${JSON.stringify(raw)}`);
      return this.#touch();
    }
    const changed = this.#status !== mapped || this.#rawStatus !== raw;
    this.#status = mapped;
    this.#rawStatus = raw;
    return changed ? this.#touch() : false;
  }

  #ensureItem(itemId, kind, { orphan = false } = {}) {
    let item = this.#items.get(itemId);
    if (item) {
      if (item.kind === null && kind !== null) item.kind = kind;
      return item;
    }
    item = {
      id: itemId,
      kind,
      text: '',
      status: 'running',
      deltaCount: 0,
      patch: null,
      orphan,
      order: this.#items.size,
    };
    this.#items.set(itemId, item);
    return item;
  }

  #applyDelta(kindFromMethod, params) {
    const itemId = itemIdOf(params);
    const delta = params?.delta;
    if (itemId === null) return this.#anomaly(`${kindFromMethod} delta has no itemId`);
    if (typeof delta !== 'string') {
      return this.#anomaly(`${kindFromMethod} delta for ${itemId} is not a string`);
    }
    if (delta === '') return false;
    // An unknown itemId creates the item rather than dropping the text. Ordering
    // between `item/started` and the first delta is not something this repo has
    // verified, and losing the model's output to a race is strictly worse than
    // rendering an item whose kind we had to guess from the method name.
    const known = this.#items.has(itemId);
    const item = this.#ensureItem(itemId, kindFromMethod, { orphan: !known });
    if (!known) this.#anomaly(`delta arrived before item/started for ${itemId}`);
    item.text += delta;
    item.deltaCount += 1;
    return this.#touch();
  }

  #applyItemStarted(params) {
    const itemId = itemIdOf(params);
    if (itemId === null) return this.#anomaly('item/started has no item id');
    const item = this.#ensureItem(itemId, readItemKind(params));
    const text = readItemText(params);
    if (typeof text === 'string' && text !== '' && item.text === '') item.text = text;
    item.status = 'running';
    return this.#touch();
  }

  #applyItemUpdated(params) {
    const itemId = itemIdOf(params);
    if (itemId === null) return this.#anomaly('item/updated has no item id');
    const item = this.#ensureItem(itemId, readItemKind(params));
    const text = readItemText(params);
    if (text === null) return false;
    if (item.text === text) return false;
    item.text = text;
    return this.#touch();
  }

  #applyItemCompleted(params) {
    const itemId = itemIdOf(params);
    if (itemId === null) return this.#anomaly('item/completed has no item id');
    const item = this.#ensureItem(itemId, readItemKind(params));
    item.status = 'completed';
    const text = readItemText(params);
    // Authoritative text replaces the accumulation. See `readItemText`.
    if (text !== null) item.text = text;
    return this.#touch();
  }

  #applyPatch(params) {
    const itemId = itemIdOf(params);
    if (itemId === null) return this.#anomaly('patchUpdated has no item id');
    const patch = params?.patch ?? params?.diff ?? params?.unifiedDiff ?? null;
    const asText = typeof patch === 'string'
      ? patch
      : patch === null || patch === undefined
        ? null
        : JSON.stringify(patch);
    if (asText === null) return this.#anomaly(`patchUpdated for ${itemId} carries no patch`);
    const item = this.#ensureItem(itemId, readItemKind(params, 'fileChange'));
    if (item.patch === asText) return false;
    item.patch = asText;
    return this.#touch();
  }

  #applyUsage(params) {
    const source = params?.usage ?? params?.tokenUsage ?? params ?? {};
    const next = {
      inputTokens: numberOrNull(source.inputTokens ?? source.input_tokens),
      outputTokens: numberOrNull(source.outputTokens ?? source.output_tokens),
      totalTokens: numberOrNull(source.totalTokens ?? source.total_tokens),
    };
    if (next.inputTokens === null && next.outputTokens === null && next.totalTokens === null) {
      return this.#anomaly('tokenUsage/updated carries no numbers');
    }
    if (next.totalTokens === null && next.inputTokens !== null && next.outputTokens !== null) {
      next.totalTokens = next.inputTokens + next.outputTokens;
    }
    const same = this.#usage !== null
      && this.#usage.inputTokens === next.inputTokens
      && this.#usage.outputTokens === next.outputTokens
      && this.#usage.totalTokens === next.totalTokens;
    if (same) return false;
    this.#usage = next;
    // Token counts tick constantly and are footer decoration. Bumping the
    // revision for them would spend the whole card-update budget on a number
    // nobody is waiting for, so this is the one visible change that does not
    // ask for a flush of its own -- it rides along with the next real one.
    return false;
  }

  #touch() {
    this.#revision += 1;
    return true;
  }

  /** Returns false so callers can `return this.#anomaly(...)` as "no change". */
  #anomaly(note) {
    if (this.#anomalies.length < MAX_ANOMALIES) this.#anomalies.push(note);
    else if (this.#anomalies.length === MAX_ANOMALIES) this.#anomalies.push('...');
    return false;
  }
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The decisions this request says it will accept, narrowed to the ones the
 * adapter actually recognises.
 *
 * `availableDecisions` is a real field on the real params (see
 * `test/appserver/fakes.mjs`, which was built from the adapter's own
 * `requestApproval`). Narrowing rather than trusting is the point: the adapter
 * coerces an unrecognised decision to `decline` with no error, so offering a
 * button for a value outside the known-legal four would produce a card whose
 * "approve" quietly refuses.
 */
function readAvailableDecisions(params) {
  const offered = params?.availableDecisions;
  if (!Array.isArray(offered)) return null; // caller falls back to its default set
  const narrowed = offered.filter((entry) => LEGAL_DECISIONS.includes(entry));
  return narrowed.length > 0 ? narrowed : null;
}

/** Mirrors `APPROVAL_DECISIONS` in `src/appserver/client.mjs`. */
const LEGAL_DECISIONS = Object.freeze(['accept', 'acceptForSession', 'decline', 'cancel']);

/**
 * A one-line human summary of what is being asked for. Kept here rather than in
 * the renderer because it is protocol knowledge, not layout: which field of an
 * approval payload identifies the thing being approved.
 *
 * `commandExecution` is easy -- the real params carry `command` and `cwd`.
 * `fileChange` is the awkward one and the awkwardness is load-bearing: its real
 * params carry **neither a diff nor a path**, only `itemId`. So there is
 * genuinely nothing to summarise, and the honest summary says to go look at the
 * correlated patch rather than inventing a filename. A card that rendered a
 * confident-looking summary here would be asking for blind consent.
 */
function summariseApproval(kind, params) {
  if (kind === 'commandExecution') {
    const command = params?.command ?? params?.commandLine ?? params?.cmd ?? null;
    const rendered = Array.isArray(command)
      ? command.join(' ')
      : typeof command === 'string' && command !== '' ? command : null;
    if (rendered === null) return 'run a command';
    const cwd = typeof params?.cwd === 'string' && params.cwd !== '' ? params.cwd : null;
    return cwd === null ? rendered : `${rendered}\n(${cwd})`;
  }
  if (kind === 'fileChange') {
    const paths = params?.paths ?? params?.files ?? null;
    if (Array.isArray(paths) && paths.length > 0) {
      return paths.map((entry) => (typeof entry === 'string' ? entry : entry?.path ?? '?')).join(', ');
    }
    const single = params?.path ?? null;
    if (typeof single === 'string' && single !== '') return single;
    return 'apply a file change (the request names no path; see the patch)';
  }
  const questions = params?.questions;
  if (Array.isArray(questions) && questions.length > 0) {
    const headers = questions
      .map((entry) => (typeof entry?.header === 'string' ? entry.header : null))
      .filter((entry) => entry !== null);
    if (headers.length > 0) return headers.join(' / ');
  }
  const question = params?.question ?? params?.prompt ?? null;
  if (typeof question === 'string' && question !== '') return question;
  return 'answer a question';
}
