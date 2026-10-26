// Test doubles for the IM relay. Like `test/appserver/fakes.mjs`, they record
// and replay and re-implement nothing that is under test.
//
// Not a `*.test.mjs` file, so the shell glob the suite runs with
// (`node --test "test/imrelay/*.test.mjs"`) does not try to execute it.

import { LARK_LIMITS } from '../../src/imrelay/transport.mjs';

/**
 * A long connection that satisfies the contract in `transport.mjs` without
 * going anywhere.
 *
 * It models the one behaviour of the real thing that changes how callers must be
 * written: `push()` measures how long the handler took and records a `repushed`
 * event when that exceeds the platform's 3-second deadline, because the platform
 * re-delivers an event whose handler was slow. A test can therefore demonstrate
 * that the handler is an enqueue rather than an await.
 */
export function fakeLongConnection({ clock = null } = {}) {
  let handler = null;
  let onClosed = null;
  const state = { started: false, closed: false, delivered: [], repushed: [] };

  const connection = {
    start() {
      state.started = true;
      return Promise.resolve();
    },
    onEvent(callback) { handler = callback; },
    onClose(callback) { onClosed = callback; },
    close() {
      state.closed = true;
      onClosed?.();
    },
  };

  return {
    connection,
    state,
    /** Deliver one envelope, as the platform would. */
    push(envelope) {
      if (handler === null) throw new Error('nobody registered onEvent');
      const before = clock === null ? 0 : clock.now;
      const result = handler(envelope);
      if (result && typeof result.then === 'function') {
        throw new Error('the event handler returned a promise; it must not await the work');
      }
      const elapsed = clock === null ? 0 : clock.now - before;
      state.delivered.push(envelope?.header?.event_id ?? null);
      if (elapsed > LARK_LIMITS.eventHandlerDeadlineMs) state.repushed.push(envelope);
      return result;
    },
    /** The platform dropped us. */
    drop() { onClosed?.(); },
  };
}

/**
 * A sink that records operations and never sends anything. Stands in for the
 * real HTTP client *behind* the allowlist, so a test can assert both that the
 * allowlist let the right things through and what they were.
 */
export function recordingSink({ results = {} } = {}) {
  const ops = [];
  return {
    ops,
    sealed: false,
    /** Every recorded op of one kind. */
    of(kind) { return ops.filter((entry) => entry.op === kind); },
    get last() { return ops[ops.length - 1]; },
    async perform(op) {
      ops.push(structuredClone(op));
      const result = results[op.op];
      // A function result lets a test hand out a fresh card id per call;
      // a static one makes every card look like the same card, which hides
      // exactly the cross-talk a multi-lane test is looking for.
      if (typeof result === 'function') return result(op);
      return result ?? { code: 0, msg: 'success', data: {} };
    },
  };
}

/** A clock a test advances by hand. */
export function fakeClock(start = 0) {
  return {
    now: start,
    advance(ms) { this.now += ms; return this.now; },
  };
}

// -- envelope builders -------------------------------------------------------

let eventSeq = 0;
function nextEventId() { return `ev_${++eventSeq}`; }

/** An `im.message.receive_v1` envelope with a text body. */
export function messageEvent({
  text = 'hello',
  chatId = 'oc_allowed',
  eventId = null,
  messageId = 'om_1',
  threadId = null,
  senderType = 'user',
  messageType = 'text',
  content = null,
} = {}) {
  const message = {
    message_id: messageId,
    chat_id: chatId,
    chat_type: 'group',
    message_type: messageType,
    content: content === null ? JSON.stringify({ text }) : content,
    mentions: [],
  };
  if (threadId !== null) message.thread_id = threadId;
  return {
    schema: '2.0',
    header: {
      event_id: eventId ?? nextEventId(),
      event_type: 'im.message.receive_v1',
      create_time: '1700000000000',
      token: 'verification-token-placeholder',
      app_id: 'cli_placeholder',
      tenant_key: 'tenant_placeholder',
    },
    event: {
      sender: { sender_id: { open_id: 'ou_someone' }, sender_type: senderType },
      message,
    },
  };
}

/** A `card.action.trigger` envelope carrying an `action.value`. */
export function cardActionEvent({
  value = {},
  chatId = 'oc_allowed',
  eventId = null,
  messageId = 'om_1',
  token = 'c-placeholder',
} = {}) {
  return {
    schema: '2.0',
    header: {
      event_id: eventId ?? nextEventId(),
      event_type: 'card.action.trigger',
      create_time: '1700000000000',
      token: 'verification-token-placeholder',
      app_id: 'cli_placeholder',
      tenant_key: 'tenant_placeholder',
    },
    event: {
      operator: { open_id: 'ou_someone', union_id: 'on_someone', user_id: 'u_someone' },
      token,
      action: { value, tag: 'button' },
      host: 'im_message',
      context: { open_message_id: messageId, open_chat_id: chatId },
    },
  };
}

// -- app-server notification builders ---------------------------------------

/**
 * The notification sequence a real turn produces, as verified in
 * `docs/03-reframe.md` §3: started, deltas, completed, turn completed.
 */
export function turnStream({
  threadId = 'th_1',
  turnId = 'tu_1',
  itemId = 'it_1',
  kind = 'agentMessage',
  chunks = ['Hello', ', ', 'world'],
} = {}) {
  const out = [
    ['turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } }],
    ['item/started', { threadId, item: { id: itemId, itemType: kind } }],
  ];
  for (const chunk of chunks) out.push([`item/${kind}/delta`, { itemId, delta: chunk }]);
  out.push(['item/completed', { threadId, item: { id: itemId, itemType: kind } }]);
  out.push(['turn/completed', { threadId, turn: { id: turnId, status: 'completed' } }]);
  return out;
}

/** Feed a `[method, params]` list into a projection. */
export function feed(projection, notifications, at = 0) {
  const changed = [];
  for (const [method, params] of notifications) {
    changed.push(projection.apply(method, params, at));
  }
  return changed;
}
