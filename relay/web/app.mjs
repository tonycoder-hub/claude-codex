// The UI controller.
//
// Deliberately plain. This is route C: prove the chain end to end with an honest
// surface, so there is no attempt to imitate the Codex app's visual design.
//
// Two rules shape the code:
//
//  - All transcript state changes go through the reducer in stream.mjs. This
//    file never mutates the model, it only renders the difference between two
//    states. Because the reducer shares structure, "what changed" is an
//    identity comparison per item, so a delta touches exactly one text node
//    instead of rebuilding the transcript.
//  - Everything that came from the model, the filesystem or the server is
//    written with textContent or Text.appendData. There is not one innerHTML
//    assignment in this file, and there must never be: a diff hunk or a command
//    output containing markup would otherwise be parsed as markup.

import {
  initialState,
  reduce,
  reasoningText,
  isTurnActive,
  isWaitingOnUser,
  decisionResult,
  userInputResult,
  LOCAL_APPROVAL_RESOLVED,
} from './stream.mjs';
import { createClientForSocket, APPROVAL_METHODS } from './appserver.mjs';
import { backoffDelay, classifyDisconnect, DEFAULT_BACKOFF, DISCONNECT } from './backoff.mjs';
import * as auth from './login.mjs';

const WS_PATH = '/ws';

/** Notifications we subscribe to. The server has many more; this is the subset. */
const SUBSCRIPTIONS = [
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'item/commandExecution/outputDelta',
  'item/fileChange/patchUpdated',
  'turn/started',
  'turn/completed',
  'thread/tokenUsage/updated',
  // Not in the required set, but cheap and the UI lies without them: there is
  // no turn/failed notification, so `error` is the only warning of a failure,
  // and todo lists arrive as turn/plan/updated rather than as items.
  'thread/started',
  'thread/status/changed',
  'turn/plan/updated',
  'item/plan/delta',
  'error',
  // Fires when the server resolves a request itself (auto-approved by policy,
  // or answered on another client), so a stale card comes down.
  'serverRequest/resolved',
];

/**
 * Server-initiated requests this page answers. A turn blocks until each is.
 *
 * Taken from the sibling module rather than retyped. The two approvals answer
 * with {decision}, whose vocabulary the shim polices on the way out;
 * requestUserInput answers with {answers} and has no vocabulary to police,
 * which is the one difference this file still has to know about.
 *
 * THREE OF THE NINE, and the other six are a known limitation rather than an
 * oversight. Named so the gap reads as a list rather than as a subtraction:
 * item/permissions/requestApproval, item/tool/requestOptionPicker,
 * item/tool/requestSetupCodexContextPicker, mcpServer/elicitation/request,
 * item/tool/call and currentTime/read. The nine answer in eight different
 * shapes -- a permissions grant is {permissions, scope}, an option pick is
 * {action, selectedOptions, freeformAnswer}, a dynamic tool call is whatever
 * that tool returns, a clock read is {currentTimeAt} -- and none of the first
 * five has a widget on this page to produce one from.
 *
 * What an unregistered method costs, measured in AppServerClient's own
 * dispatcher: it answers with a methodNotFound error rather than dropping the
 * request, so the turn FAILS with the method name on screen. That is a bad
 * outcome and it is a legible one, and the server is never left waiting.
 * The alternative considered was a declining handler per method, and it was
 * rejected: those decline shapes are not measured, and a guessed shape the
 * server reads as consent is a tool that runs because this page could not draw
 * a dialog. A readable failure is the better trade until somebody has read the
 * five consumers.
 *
 * The sixth is not like those five. `currentTime/read` has no widget because it
 * needs none, and this page could answer it correctly in one line -- the
 * renderer's own answer is `{currentTimeAt: Math.floor(Date.now()/1e3)}`, with
 * no guessing anywhere in it. It is unregistered because what this diagnostic
 * page ANSWERS is a separate decision from what the relay FORWARDS, and only
 * the second was in scope when the method was added to the wire table. Until
 * somebody makes the first, the cost here is the legible failure above.
 *
 * The full renderer, served under the App prefix, registers all nine -- it is
 * the UI those requests were designed for, and it is where a real session
 * belongs. This page is the fallback and the diagnostic.
 */
const INPUT_REQUEST = APPROVAL_METHODS.userInput;
const REQUEST_METHODS = [
  APPROVAL_METHODS.commandExecution,
  APPROVAL_METHODS.fileChange,
  INPUT_REQUEST,
];

const KIND_LABEL = {
  agentMessage: 'assistant',
  userMessage: 'you',
  reasoning: 'thinking',
  commandExecution: 'command',
  fileChange: 'file change',
  webSearch: 'web search',
  mcpToolCall: 'tool',
  dynamicToolCall: 'tool',
  collabAgentToolCall: 'agent',
  subAgentActivity: 'agent',
  plan: 'plan',
  hookPrompt: 'hook',
  imageView: 'image',
  contextCompaction: 'context compacted',
  enteredReviewMode: 'review mode',
  unknown: 'item',
};

const DECISION_LABEL = {
  accept: 'Allow',
  acceptForSession: 'Allow for session',
  decline: 'Deny',
  cancel: 'Cancel turn',
};

// --------------------------------------------------------------------------
// Tiny DOM helpers. `el` never accepts markup, only text.
// --------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

/**
 * Append-only text update. Streaming text only ever grows, so the common case
 * is appending the new suffix to one existing Text node -- the cheapest update
 * the DOM offers, and the reason a long turn does not get slower as it goes.
 * A non-append change (the server replacing streamed text with its final value)
 * falls back to a full assignment.
 */
function growText(host, text) {
  let node = host.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) {
    host.textContent = '';
    node = document.createTextNode('');
    host.appendChild(node);
  }
  if (node.data === text) return;
  if (text.length > node.data.length && text.startsWith(node.data)) {
    node.appendData(text.slice(node.data.length));
  } else {
    node.data = text;
  }
}

// --------------------------------------------------------------------------
// Transcript rendering
// --------------------------------------------------------------------------

const views = new Map(); // itemId -> { root, kindEl, metaEl, bodyEl, changesEl, lastChanges }

function itemMeta(item) {
  const wire = item.wire ?? {};
  switch (item.type) {
    case 'commandExecution': {
      const bits = [];
      if (typeof wire.exitCode === 'number') bits.push(`exit ${wire.exitCode}`);
      if (typeof wire.durationMs === 'number') bits.push(`${wire.durationMs} ms`);
      if (wire.cwd) bits.push(wire.cwd);
      return bits.join(' · ');
    }
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return [wire.tool, wire.status].filter(Boolean).join(' · ');
    case 'webSearch':
      return wire.query ?? '';
    case 'fileChange':
      return `${item.changes.length} file${item.changes.length === 1 ? '' : 's'}`;
    case 'subAgentActivity':
      return wire.kind ?? '';
    case 'imageView':
      return wire.path ?? '';
    default:
      return item.status === 'inProgress' ? '' : (item.status ?? '');
  }
}

/** The one-line summary for an item type this UI does not model in detail. */
function fallbackText(item) {
  const wire = item.wire ?? {};
  if (typeof wire.text === 'string' && wire.text !== '') return wire.text;
  if (item.type === 'userMessage' && Array.isArray(wire.content)) {
    return wire.content
      .map((part) => (typeof part?.text === 'string' ? part.text : part?.path ?? part?.name ?? ''))
      .filter((s) => s !== '')
      .join(' ');
  }
  if (item.type === 'webSearch') return wire.query ?? '';
  if (item.type === 'imageView') return wire.path ?? '';
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
    return wire.error?.message ?? '';
  }
  return '';
}

function createView(item) {
  const root = el('article', `item item-${item.type}`);
  const head = el('div', 'item-head');
  const kindEl = el('span', 'item-kind');
  const metaEl = el('span', 'item-meta');
  head.append(kindEl, metaEl);

  const bodyEl = el('div', 'item-body');
  const changesEl = el('div', 'item-changes');
  changesEl.hidden = true;
  root.append(head, bodyEl, changesEl);

  return { root, kindEl, metaEl, bodyEl, changesEl, lastChanges: null };
}

function renderChanges(view, changes) {
  // Only rebuilt when the reducer handed us a different array, since a patch
  // update replaces the whole set rather than appending to it.
  if (view.lastChanges === changes) return;
  view.lastChanges = changes;
  view.changesEl.textContent = '';
  view.changesEl.hidden = changes.length === 0;

  for (const change of changes) {
    const block = el('div', 'change');
    const kind = change?.kind?.type === 'add' ? 'added' : 'updated';
    block.append(el('div', 'change-path', `${kind}: ${change?.path ?? '(unknown path)'}`));
    if (typeof change?.diff === 'string' && change.diff !== '') {
      // textContent, so a diff that happens to contain markup stays a diff.
      block.append(el('pre', 'change-diff', change.diff));
    }
    view.changesEl.append(block);
  }
}

function renderItem(view, item) {
  view.root.className = `item item-${item.type}${item.closed ? '' : ' item-open'}`;
  view.root.dataset.status = item.status ?? '';
  view.kindEl.textContent = KIND_LABEL[item.type] ?? item.type;
  view.metaEl.textContent = itemMeta(item);

  switch (item.type) {
    case 'commandExecution': {
      const command = item.wire?.command ?? '';
      // The command itself belongs in the head line; output streams below it.
      view.kindEl.textContent = '$';
      growText(view.bodyEl, command ? `${command}\n${item.output}` : item.output);
      view.bodyEl.className = 'item-body item-body-pre';
      break;
    }
    case 'reasoning':
      // Only one of the two duplicated reasoning streams, see stream.mjs.
      growText(view.bodyEl, reasoningText(item));
      break;
    case 'fileChange':
      growText(view.bodyEl, '');
      renderChanges(view, item.changes);
      break;
    case 'agentMessage':
    case 'plan':
      growText(view.bodyEl, item.text);
      break;
    default:
      growText(view.bodyEl, item.text !== '' ? item.text : fallbackText(item));
      break;
  }
}

// --------------------------------------------------------------------------
// The controller
// --------------------------------------------------------------------------

const ui = {};
let state = initialState();
let previous = state;

let relay = null;
let pinned = true;
// A bootstrap token lifted from the URL fragment. Kept in a variable rather
// than put into the token input, so a single-use secret is not displayed on
// screen or picked up in a screenshot.
let urlBootstrapToken = null;
// What /auth/status said on this page load: whether a passkey is enrolled, and
// whether the surface is serving the real App and at which prefix. Kept at
// module scope because the login handlers need the second answer and they run
// long after boot() asked the question.
let relayStatus = { enrolled: false, app: { available: false, prefix: null } };
let localRequestSeq = 0;
const pendingRequests = new Map(); // localId -> { resolve, method }

function dispatch(notification) {
  dispatchAll([notification]);
}

/** Fold several notifications, then render once. Used for replayed history. */
function dispatchAll(notifications) {
  let next = state;
  for (const notification of notifications) next = reduce(next, notification);
  if (next === state) return; // nothing changed; do not touch the DOM at all
  previous = state;
  state = next;

  // If the reducer dropped an approval we are still holding a promise for (the
  // server resolved it itself, or its turn ended), forget the promise without
  // resolving it: the server is no longer waiting, and answering now would be a
  // duplicate response to a request that is already closed.
  if (state.approvals !== previous.approvals && pendingRequests.size > 0) {
    const live = new Set(state.approvals.map((a) => a.requestId));
    for (const requestId of pendingRequests.keys()) {
      if (!live.has(requestId)) pendingRequests.delete(requestId);
    }
  }

  render();
}

function render() {
  // Items: create the new ones, update only those whose identity changed.
  for (const id of state.order) {
    const item = state.items[id];
    let view = views.get(id);
    if (!view) {
      view = createView(item);
      views.set(id, view);
      ui.transcript.append(view.root);
    } else if (previous.items[id] === item) {
      continue; // untouched this frame
    }
    renderItem(view, item);
  }

  renderStatus();
  renderPlan();
  renderErrors();
  renderApprovals();
  stickToBottom();
}

/** Drop the rendered conversation, e.g. when resuming a different thread. */
function resetTranscript() {
  views.clear();
  ui.transcript.textContent = '';
  ui.approvals.textContent = '';
  ui.approvals.hidden = true;
  state = initialState();
  previous = state;
  pinned = true;
}

function renderStatus() {
  const turnActive = isTurnActive(state);
  ui.stop.disabled = !turnActive;
  ui.send.disabled = !relay || relay.phase !== 'live' || turnActive;
  ui.turnState.textContent = turnActive
    ? 'working'
    : state.turn
      ? `turn ${state.turn.status}`
      : 'idle';

  const usage = state.tokenUsage?.total;
  if (usage) {
    const window = state.tokenUsage.modelContextWindow;
    ui.tokens.textContent = `${usage.totalTokens} tokens${window ? ` / ${window}` : ''}`;
    ui.tokens.hidden = false;
  } else {
    ui.tokens.hidden = true;
  }

  // The server tells us when it is blocked on the user via activeFlags; that is
  // more reliable than counting our own cards.
  const waiting = isWaitingOnUser(state);
  if (waiting) ui.turnState.textContent = 'waiting on you';
  ui.turnState.dataset.waiting = waiting ? 'true' : 'false';
  ui.threadId.textContent = state.threadId ? `thread ${state.threadId}` : '';

  if (state.droppedDeltas > 0) {
    ui.dropped.textContent = `${state.droppedDeltas} late delta${state.droppedDeltas === 1 ? '' : 's'} discarded`;
    ui.dropped.hidden = false;
  } else {
    ui.dropped.hidden = true;
  }
}

function renderPlan() {
  if (state.plan === previous.plan) return;
  ui.plan.textContent = '';
  ui.plan.hidden = !state.plan || state.plan.length === 0;
  if (ui.plan.hidden) return;
  const list = el('ul', 'plan-list');
  for (const step of state.plan) {
    const li = el('li', `plan-step plan-${step?.status ?? 'pending'}`, step?.step ?? '');
    list.append(li);
  }
  ui.plan.append(el('div', 'plan-title', 'plan'), list);
}

function renderErrors() {
  if (state.errors === previous.errors) return;
  ui.errors.textContent = '';
  ui.errors.hidden = state.errors.length === 0;
  for (const error of state.errors.slice(-3)) {
    ui.errors.append(el('div', 'error-line', error.willRetry ? `${error.message} (retrying)` : error.message));
  }
}

// --------------------------------------------------------------------------
// Approvals. These block the turn, so they are rendered as a sticky panel
// rather than appended to the transcript where they could scroll out of view.
// --------------------------------------------------------------------------

function answer(requestId, result) {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pendingRequests.delete(requestId);
  pending.resolve(result);
  dispatch({ method: LOCAL_APPROVAL_RESOLVED, requestId });
}

function renderApprovals() {
  if (state.approvals === previous.approvals) return;
  ui.approvals.textContent = '';
  ui.approvals.hidden = state.approvals.length === 0;

  for (const approval of state.approvals) {
    ui.approvals.append(
      approval.kind === 'userInput' ? questionPanel(approval) : approvalPanel(approval),
    );
  }
}

function approvalPanel(approval) {
  const panel = el('section', 'approval');
  panel.append(el('h2', 'approval-title',
    approval.kind === 'command' ? 'Run this command?' : 'Apply this change?'));

  if (approval.kind === 'command') {
    panel.append(el('pre', 'approval-command', approval.command));
    if (approval.cwd) panel.append(el('div', 'approval-meta', `in ${approval.cwd}`));
  } else {
    // The fileChange approval params carry no diff at all -- only an itemId.
    // The patch arrived earlier on item/fileChange/patchUpdated, so the only
    // way to show the user what they are approving is to look it up.
    const item = approval.itemId ? state.items[approval.itemId] : null;
    const changes = item?.changes ?? [];
    if (changes.length === 0) {
      panel.append(el('div', 'approval-meta', 'the patch for this change has not arrived yet'));
    }
    for (const change of changes) {
      panel.append(el('div', 'change-path', change?.path ?? '(unknown path)'));
      if (typeof change?.diff === 'string') panel.append(el('pre', 'change-diff', change.diff));
    }
    if (approval.grantRoot) panel.append(el('div', 'approval-meta', `grants ${approval.grantRoot}`));
  }

  if (approval.reason) panel.append(el('div', 'approval-meta', approval.reason));

  const row = el('div', 'approval-actions');
  for (const decision of approval.decisions) {
    const button = el('button', `decision decision-${decision}`, DECISION_LABEL[decision] ?? decision);
    button.type = 'button';
    // decisionResult enforces the closed set. The server coerces an unknown
    // decision to 'decline' without complaining, so a wrong string here would
    // look like an approval and behave like a refusal.
    button.addEventListener('click', () => answer(approval.requestId, decisionResult(decision)));
    row.append(button);
  }
  panel.append(row);
  return panel;
}

function questionPanel(approval) {
  const panel = el('section', 'approval');
  panel.append(el('h2', 'approval-title', 'The agent is asking'));

  // Answers are keyed by question id and each value is {answers: string[]}.
  const picked = new Map();
  const notes = new Map();

  for (const question of approval.questions) {
    const block = el('div', 'question');
    if (question?.header) block.append(el('div', 'question-header', question.header));
    block.append(el('div', 'question-text', question?.question ?? ''));

    const options = Array.isArray(question?.options) ? question.options : [];
    const group = el('div', 'question-options');
    for (const option of options) {
      const label = el('label', 'question-option');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `q-${approval.requestId}-${String(question?.id)}`;
      radio.value = option?.label ?? '';
      radio.addEventListener('change', () => picked.set(String(question?.id), option?.label ?? ''));
      label.append(radio, el('span', 'question-label', option?.label ?? ''));
      if (option?.description) label.append(el('span', 'question-desc', option.description));
      group.append(label);
    }
    block.append(group);

    const free = document.createElement(question?.isSecret ? 'input' : 'textarea');
    if (question?.isSecret) free.type = 'password';
    free.className = 'question-free';
    free.rows = 2;
    free.placeholder = 'or type an answer';
    free.addEventListener('input', () => notes.set(String(question?.id), free.value));
    block.append(free);

    panel.append(block);
  }

  const row = el('div', 'approval-actions');
  const submit = el('button', 'decision decision-accept', 'Answer');
  submit.type = 'button';
  submit.addEventListener('click', () => {
    const picks = {};
    for (const question of approval.questions) {
      const key = String(question?.id);
      picks[key] = { choice: picked.get(key), note: notes.get(key) };
    }
    // Keyed by question id, not an array -- see userInputResult, including why
    // a question with no id is still answered rather than skipped.
    answer(approval.requestId, userInputResult(approval.questions, picks));
  });
  row.append(submit);
  panel.append(row);
  return panel;
}

// --------------------------------------------------------------------------
// Scroll pinning
// --------------------------------------------------------------------------

const BOTTOM_SLACK_PX = 56;

function atBottom() {
  const node = ui.transcript;
  return node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_SLACK_PX;
}

function stickToBottom() {
  if (!pinned) {
    ui.jump.hidden = false;
    return;
  }
  ui.jump.hidden = true;
  ui.transcript.scrollTop = ui.transcript.scrollHeight;
}

// --------------------------------------------------------------------------
// Connection
// --------------------------------------------------------------------------

const PHASE_TEXT = {
  offline: 'offline',
  connecting: 'connecting',
  live: 'live',
  reconnecting: 'reconnecting',
  dead: 'disconnected',
};

const MAX_ATTEMPTS = 20;

class Relay {
  phase = 'offline';
  attempt = 0;
  #socket = null;
  #client = null;
  #timer = null;
  #countdown = null;
  #stopped = false;
  #turnAbort = null;

  get client() { return this.#client; }

  setPhase(phase, detail = '') {
    this.phase = phase;
    ui.connection.dataset.phase = phase;
    ui.connection.textContent = detail ? `${PHASE_TEXT[phase]} · ${detail}` : PHASE_TEXT[phase];
    ui.reconnect.hidden = phase !== 'dead';
    renderStatus();
  }

  start() {
    this.#stopped = false;
    this.attempt = 0;
    this.#open();
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    clearInterval(this.#countdown);
    this.#abandonRequests();
    if (this.#client) this.#client.close();
    if (this.#socket && this.#socket.readyState <= WebSocket.OPEN) this.#socket.close(1000, 'leaving');
    this.#socket = null;
    this.#client = null;
    this.setPhase('offline');
  }

  #url() {
    const url = new URL(WS_PATH, location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // No token in the URL: the upgrade is gated on the HttpOnly session cookie,
    // which the browser attaches to a same-origin handshake by itself.
    return url.toString();
  }

  #open() {
    clearInterval(this.#countdown);
    this.setPhase(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let socket;
    try {
      socket = new WebSocket(this.#url());
    } catch (error) {
      this.#scheduleRetry(`could not open a socket: ${error.message}`);
      return;
    }
    this.#socket = socket;
    let opened = false;

    // Built now, while the socket is still CONNECTING, rather than in the open
    // handler: the transport queues outbound frames until it opens, and doing
    // it here means every handler is registered before the first inbound frame
    // can arrive. Registering them later leaves a window in which a
    // server-initiated approval could land with nothing listening for it.
    try {
      this.#client = createClientForSocket(socket, {
        onProtocolError: (error) => {
          dispatch({
            method: 'error',
            params: { willRetry: false, error: { message: `protocol: ${error?.message ?? error}` } },
          });
        },
      });
    } catch (error) {
      // A shim or sibling-module problem is a bug, not a network blip, and
      // retrying would just hide it.
      this.setPhase('dead', error.message);
      socket.close(1011, 'client setup failed');
      return;
    }
    this.#wire(this.#client);

    socket.addEventListener('open', () => {
      if (socket !== this.#socket) return;
      opened = true;
      this.attempt = 0;
      // The upgrade succeeded, which is the only proof this browser holds a
      // valid session; if the page was still showing the login screen while
      // the attempt was in flight, this is when it has earned the chat view.
      showChat();
      this.setPhase('live');
      this.#resumeOrStart().catch((error) => this.setPhase('live', `thread error: ${error.message}`));
    });

    socket.addEventListener('close', (event) => {
      if (socket !== this.#socket) return;
      this.#socket = null;
      this.#client = null;
      this.#abandonRequests();
      if (this.#stopped) return this.setPhase('offline');
      this.#afterClose(opened, event.code, event.reason);
    });

    socket.addEventListener('error', () => {
      // 'error' is always followed by 'close'; the close handler owns the retry.
      if (socket === this.#socket) this.setPhase('reconnecting', 'socket error');
    });
  }

  /**
   * Work out whether a closed socket means "try again" or "sign in again".
   *
   * A refused upgrade arrives as code 1006 with no reason, identical to a lost
   * network, so when the socket never opened we ask the relay over plain HTTP
   * whether it is still there. classifyDisconnect holds the actual rule.
   */
  async #afterClose(opened, code, reason) {
    let reachable = null;
    if (!opened) {
      this.setPhase('reconnecting', 'checking the relay');
      reachable = await auth.isRelayReachable();
      // Anything could have happened while that was in flight.
      if (this.#stopped || this.#socket) return;
    }

    const verdict = classifyDisconnect({ everOpened: opened, code, serverReachable: reachable });
    if (verdict === DISCONNECT.reauth) {
      this.setPhase('dead', 'the relay rejected this session');
      showLogin('this session is no longer valid — sign in again');
      return;
    }
    if (verdict === DISCONNECT.refused) {
      // The relay is up and would not take the socket. Almost always an expired
      // or missing session; the wording does not overstate what is known.
      this.setPhase('dead', 'the relay refused the connection');
      showLogin('the relay is reachable but refused the connection — the session has probably expired');
      return;
    }
    this.#scheduleRetry(reason || `closed (${code})`);
  }

  #scheduleRetry(reason) {
    this.attempt += 1;
    if (this.attempt > MAX_ATTEMPTS) {
      this.setPhase('dead', `${reason} after ${MAX_ATTEMPTS} attempts`);
      return;
    }
    const delay = backoffDelay(this.attempt, DEFAULT_BACKOFF);
    const readyAt = Date.now() + delay;

    // Show the countdown. Pretending to be connected while waiting would be
    // the one thing this state machine must never do.
    const tick = () => {
      const left = Math.max(0, Math.ceil((readyAt - Date.now()) / 1000));
      this.setPhase('reconnecting', `${reason} · attempt ${this.attempt} in ${left}s`);
    };
    tick();
    clearInterval(this.#countdown);
    this.#countdown = setInterval(tick, 1000);

    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      clearInterval(this.#countdown);
      if (!this.#stopped) this.#open();
    }, delay);
  }

  /** Retry immediately, e.g. the user tapped retry or the phone came back. */
  retryNow() {
    if (this.#stopped || this.#socket) return;
    clearTimeout(this.#timer);
    clearInterval(this.#countdown);
    this.attempt = 0;
    this.#open();
  }

  #wire(client) {
    for (const method of SUBSCRIPTIONS) {
      client.onNotification(method, (params) => dispatch({ method, params }));
    }

    // Park the request until the user answers it. The pending promise *is* the
    // blocked turn: nothing resolves it except a tap, a resolution elsewhere,
    // or the socket dying.
    const ask = (method) => (params, context) => new Promise((resolve) => {
      localRequestSeq += 1;
      const requestId = localRequestSeq;
      pendingRequests.set(requestId, { resolve, method });
      // Into the reducer, so the prompt is part of the rendered state rather
      // than a floating callback nobody can see.
      //
      // context.id is the JSON-RPC id of the inbound request. Carrying it into
      // the model is what lets `serverRequest/resolved` take down a card the
      // server answered elsewhere, including the two request kinds whose params
      // contain no id of their own.
      dispatch({ method, params, requestId, wireId: context?.id ?? null });
    });

    // The shim wraps the two approval methods in the sibling module's
    // approvalResponder on the way through, so a decision outside the four the
    // server recognises is raised as an RpcError instead of being coerced to a
    // silent 'decline'. Nothing extra is needed here.
    for (const method of REQUEST_METHODS) {
      client.onRequest(method, ask(method));
    }
  }

  /** An approval that can no longer be delivered must not stay on screen. */
  #abandonRequests() {
    for (const [requestId, pending] of pendingRequests) {
      // Decline is the safe default if this somehow still reaches the server.
      pending.resolve(pending.method === INPUT_REQUEST ? { answers: {} } : { decision: 'decline' });
      dispatch({ method: LOCAL_APPROVAL_RESOLVED, requestId });
    }
    pendingRequests.clear();
  }

  async #resumeOrStart(requested = null) {
    const client = this.#client;
    if (!client) return;
    // A reconnect resumes what we already had; a typed id resumes that instead.
    const wanted = requested ?? state.threadId ?? ui.threadInput.value.trim();

    const result = wanted
      ? await client.call('thread/resume', { threadId: wanted })
      : await client.call('thread/start', {});

    // The thread id lives at result.thread.id, not at a top-level threadId.
    const id = result?.thread?.id;
    if (typeof id !== 'string') throw new Error('the relay returned no thread id');

    // Resuming a different conversation must not leave the previous one on
    // screen underneath it.
    if (state.threadId !== null && state.threadId !== id) resetTranscript();

    dispatch({ method: 'thread/started', params: { thread: { id } } });
    ui.threadInput.value = id;

    // thread/resume returns the stored turns. Replaying their items as
    // item/completed reuses the reducer rather than adding a second rendering
    // path, and is idempotent for items we already streamed.
    const turns = Array.isArray(result?.thread?.turns) ? result.thread.turns : [];
    const replay = [];
    for (const turn of turns) {
      for (const item of Array.isArray(turn?.items) ? turn.items : []) {
        if (item && typeof item.id === 'string') {
          replay.push({ method: 'item/completed', params: { threadId: id, turnId: turn.id, item } });
        }
      }
    }
    if (replay.length > 0) dispatchAll(replay);
  }

  /** Switch to another thread id on a live connection. */
  async switchThread(threadId) {
    if (!this.#client || threadId === '' || threadId === state.threadId) return;
    await this.#resumeOrStart(threadId);
  }

  async submit(text) {
    const client = this.#client;
    if (!client || !state.threadId) throw new Error('not connected to a thread');
    this.#turnAbort = new AbortController();
    // turn/start resolves only when the whole turn ends, so it is deliberately
    // not awaited by the caller; progress arrives as notifications.
    return client.call(
      'turn/start',
      { threadId: state.threadId, input: [{ type: 'text', text }] },
      { signal: this.#turnAbort.signal },
    );
  }

  async interrupt() {
    const client = this.#client;
    if (!client || !state.threadId) return;
    await client.call('turn/interrupt', { threadId: state.threadId, turnId: state.activeTurnId ?? undefined });
  }
}

// --------------------------------------------------------------------------
// Login screen
// --------------------------------------------------------------------------

function showLogin(message = '') {
  ui.login.hidden = false;
  ui.chat.hidden = true;
  ui.loginNote.textContent = message;
  if (relay) relay.stop();
}

/**
 * Hand a freshly signed-in browser over to the real App, if there is one.
 *
 * The relay serves two faces. This page is the small one: a text transcript, a
 * composer and a connection indicator, which is enough to drive a turn and is
 * the only thing available on a relay with no archive mounted. The other is the
 * shipped Codex renderer at the prefix /auth/status named, which is what a
 * signed-in user actually wants.
 *
 * Done on an explicit sign-in or enrolment only, and deliberately NOT on the
 * passive session probe in boot(). The probe runs on every load of this page,
 * including a load by somebody who typed the relay's root URL to look at the
 * connection state -- bouncing them would make this page unreachable for the
 * one person most likely to need it.
 *
 * `assign` rather than `replace`: the back button should return to a page the
 * user can sign in from again, which is this one.
 *
 * @returns {boolean} true if a navigation was started, in which case the caller
 *   must not also reveal the chat screen -- the document is going away.
 */
function navigateToApp() {
  if (!relayStatus.app.available) return false;
  location.assign(relayStatus.app.prefix);
  return true;
}

/** Visibility only, and idempotent: the connection is started by connect(). */
function showChat() {
  ui.login.hidden = true;
  ui.chat.hidden = false;
}

function connect() {
  if (!relay) relay = new Relay();
  relay.start();
}

function busy(button, on) {
  button.disabled = on;
  button.dataset.busy = on ? 'true' : 'false';
}

/**
 * Describe the session the relay just handed out.
 *
 * `expiresAt` is epoch milliseconds. It is not a session identifier and not a
 * secret -- the session itself is an HttpOnly cookie this page cannot see --
 * so it is safe to show, and it is the only honest answer to "how long am I
 * signed in for?".
 */
function describeSession(expiresAt) {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return 'signed in';
  try {
    return `signed in until ${new Date(expiresAt).toLocaleString()}`;
  } catch {
    return 'signed in';
  }
}

async function doLogin() {
  busy(ui.loginButton, true);
  ui.loginNote.textContent = 'waiting for your passkey…';
  try {
    const session = await auth.login();
    ui.sessionLabel.textContent = describeSession(session?.expiresAt);
    // The navigation, if one is starting, happens before the websocket is
    // opened: a socket this document will never read from would be one more
    // upstream session for the surface to reap.
    if (navigateToApp()) return;
    showChat();
    connect();
  } catch (error) {
    ui.loginNote.textContent = error.message;
  } finally {
    busy(ui.loginButton, false);
  }
}

async function doEnroll(bootstrapToken) {
  busy(ui.enrollButton, true);
  ui.loginNote.textContent = 'creating a passkey…';
  try {
    // Enrolment sets the session cookie too, so there is no second login step.
    // The response also carries the new credentialId, which is of no use on
    // screen and is not displayed.
    await auth.enroll({ bootstrapToken, label: ui.labelInput.value });
    ui.sessionLabel.textContent = 'signed in';
    if (navigateToApp()) return;
    showChat();
    connect();
  } catch (error) {
    ui.loginNote.textContent = error.message;
  } finally {
    busy(ui.enrollButton, false);
  }
}

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

function cacheDom() {
  for (const id of [
    'login', 'loginNote', 'loginButton', 'enrollButton', 'labelInput', 'enrollPanel', 'tokenInput',
    'chat', 'connection', 'reconnect', 'turnState', 'tokens', 'threadId', 'dropped',
    'transcript', 'jump', 'plan', 'errors', 'approvals',
    'composer', 'input', 'send', 'stop', 'threadInput', 'sessionLabel',
  ]) {
    ui[id] = $(id);
  }
}

function wireDom() {
  ui.loginButton.addEventListener('click', doLogin);
  ui.enrollButton.addEventListener('click', () => doEnroll(ui.tokenInput.value.trim() || urlBootstrapToken));

  ui.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = ui.input.value;
    if (text.trim() === '' || !relay) return;
    ui.input.value = '';
    pinned = true;
    relay.submit(text).catch((error) => {
      dispatch({ method: 'error', params: { willRetry: false, error: { message: error.message } } });
    });
    renderStatus();
  });

  // Enter inserts a newline on a phone keyboard; the button and the
  // modifier-chord are how a turn is sent.
  ui.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      ui.composer.requestSubmit();
    }
  });

  ui.stop.addEventListener('click', () => {
    relay?.interrupt().catch((error) => {
      dispatch({ method: 'error', params: { willRetry: false, error: { message: `interrupt failed: ${error.message}` } } });
    });
  });

  ui.reconnect.addEventListener('click', () => relay?.retryNow());

  // Typing an id and committing it resumes that conversation.
  ui.threadInput.addEventListener('change', () => {
    relay?.switchThread(ui.threadInput.value.trim()).catch((error) => {
      dispatch({ method: 'error', params: { willRetry: false, error: { message: `resume failed: ${error.message}` } } });
    });
  });

  ui.transcript.addEventListener('scroll', () => {
    // Reading the user's intent from the scroll position: once they have
    // scrolled up, new output must not yank the view back down.
    pinned = atBottom();
    ui.jump.hidden = pinned;
  }, { passive: true });

  ui.jump.addEventListener('click', () => {
    pinned = true;
    stickToBottom();
  });

  // A phone that was asleep or out of signal should come back promptly rather
  // than sitting out the rest of a long backoff.
  addEventListener('online', () => relay?.retryNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') relay?.retryNow();
  });
  addEventListener('pagehide', () => relay?.stop());
}

async function boot() {
  cacheDom();
  wireDom();

  urlBootstrapToken = auth.takeBootstrapTokenFromUrl();

  let status;
  try {
    status = await auth.fetchRelayStatus();
  } catch (error) {
    showLogin(error.message);
    return;
  }

  relayStatus = status;
  showLogin(status.enrolled ? '' : 'no passkey is enrolled on this relay yet');
  // Enrolment is only offered when it could actually succeed: with a bootstrap
  // token from the QR, or from an existing session (which, if we have one, the
  // attempt below will prove).
  ui.enrollPanel.hidden = !urlBootstrapToken && status.enrolled;
  ui.loginButton.hidden = !status.enrolled;
  if (urlBootstrapToken) {
    ui.tokenInput.hidden = true;
    ui.loginNote.textContent = 'enrolment link detected — create a passkey below';
  }

  // The relay cannot be asked whether *this* browser is signed in; the only
  // authority is the websocket upgrade, which is gated on the cookie. So try
  // it. If it opens, the open handler reveals the chat screen; if it is
  // refused, the page is already on the login screen where it belongs, and
  // nothing has been claimed in the meantime.
  if (status.enrolled && !urlBootstrapToken) {
    ui.loginNote.textContent = 'checking for an existing session…';
    connect();
  }
}

boot();
