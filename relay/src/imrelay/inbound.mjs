// The inbound boundary: a platform event envelope in, a normalised intent out.
//
// Everything that arrives here is untrusted in the ordinary sense -- it is
// shaped by whoever typed in the chat, and a card's `action.value` is a string
// that made a round trip through a client. So this file validates rather than
// destructures, and its default posture is to ignore.
//
// Four properties, each of which is a bug report waiting to happen if dropped:
//
// **1. De-duplication is mandatory, not an optimisation.** The platform requires
// the handler to finish inside 3 seconds and *re-pushes the event* otherwise.
// Starting a turn takes much longer than 3 seconds. So without a de-duplicating
// gate, one typed message reliably becomes two, three, or N turns -- the slower
// the machine, the more copies. The gate keys on `header.event_id`.
//
// **2. The handler must not do the work.** Corollary of the same 3-second rule:
// `accept()` is pure and synchronous, and returns an intent for someone else to
// act on later. If this function awaited a turn, every turn would be re-pushed.
//
// **3. The chat allowlist is the inbound fuse.** An empty allowlist accepts
// nothing. This is deliberate and it is the reason this prototype is safe to
// develop next to live internal group chats: those chats are read-only by
// policy, and an unlisted chat produces `ignored`, never an intent, so no
// message from them can become a prompt and nothing can be forwarded out.
//
// **4. The bot must not hear itself.** A relay that posts a card into a chat it
// is also listening to, and does not filter its own traffic, is a loop. The
// filter is `sender_type === 'user'`.
//
// ## The approval vocabulary, re-checked here
//
// A decision reaches the adapter as a string, and the adapter's
// `normalizeDecision` **silently maps anything it does not recognise to
// `decline`**. So an out-of-vocabulary value is not an error anywhere: the call
// succeeds, the tool is refused, and the only symptom is an agent that will not
// run anything. `cards.mjs` only ever mints the four legal values, but the value
// comes back through a client, so it is checked again on arrival. The constant
// is imported from `src/appserver/client.mjs` rather than copied, because two
// copies of a closed vocabulary is how one of them goes stale.
//
// ## Verified payload shapes
//
//   * envelope: `{ schema: '2.0', header: { event_id, event_type, token, ... },
//     event: {...} }`;
//   * `im.message.receive_v1`: `event.sender.sender_type`,
//     `event.message.{message_id, chat_id, chat_type, message_type, content,
//     thread_id}`, with `content` a JSON-encoded **string**;
//   * `card.action.trigger`: `event.{operator, token, action:{value, tag, name},
//     context:{open_message_id, open_chat_id}}`, and this is one of exactly two
//     callbacks deliverable over the long connection. The legacy
//     `card.action.trigger_v1` is webhook-only and is rejected here by omission.

import { APPROVAL_DECISIONS } from '../appserver/client.mjs';
import { ACTION } from './cards.mjs';

export const EVENT_TYPES = Object.freeze({
  message: 'im.message.receive_v1',
  cardAction: 'card.action.trigger',
});

export const INTENT = Object.freeze({
  /** Text a person typed; becomes a turn. */
  prompt: 'prompt',
  /** An approval answer from a card button. */
  decision: 'decision',
  /** Stop the current turn in this lane. */
  interrupt: 'interrupt',
  /** A human is taking this lane over; the relay stops acting on it. */
  hold: 'hold',
  /** A human is handing the lane back. */
  release: 'release',
  /** Reviewing the daily draft digest. `action` says which review verb. */
  draft: 'draft',
  /** Understood and deliberately not acted on. Carries `reason`. */
  ignored: 'ignored',
});

/** Why something was ignored. A closed set so tests can assert on it. */
export const IGNORED = Object.freeze({
  malformed: 'malformed',
  duplicate: 'duplicate',
  unknownEvent: 'unknown-event',
  chatNotAllowed: 'chat-not-allowed',
  notFromUser: 'not-from-user',
  unsupportedMessageType: 'unsupported-message-type',
  emptyText: 'empty-text',
  badAction: 'bad-action',
  badDecision: 'bad-decision',
  /** `requireCommand` is on and this message did not open with a command. */
  notAddressed: 'not-addressed',
  /** A review verb arrived without the draft handle it requires. */
  noDraftHandle: 'no-draft-handle',
});

/** Mention placeholders the platform substitutes into text content. */
const MENTION_PLACEHOLDER = /@_(?:user_\d+|all)\b/g;

/**
 * The command words a message may start with. A closed set: anything else is
 * prompt text, so a message that merely happens to begin with a slash is not
 * silently swallowed.
 */
const COMMANDS = Object.freeze({
  // The dispatch affordance people already reach for in this IM, kept as a
  // bare prefix that means nothing but "this one is for the agent". It is
  // redundant in a direct chat, where every message is already addressed to
  // us, and load-bearing in a group under `requireCommand`.
  '/ai': 'ai',
  '/new': 'new',
  '/stop': 'stop',
  '/end': 'end',
  // Take-over. Borrowed from botmux, whose per-session take-over is the one
  // control that makes an agent sitting in a chat tolerable: the moment it
  // starts doing the wrong thing, a human needs a way to stop it that does
  // not involve finding the machine it runs on.
  '/mine': 'hold',
  '/release': 'release',
  // The daily draft digest. `/send` is the only command in this file that
  // puts text in front of another person, so unlike the rest it refuses to
  // act on its own -- see DRAFT_VERBS.
  '/drafts': 'draft',
  '/send': 'draft',
  '/skip': 'draft',
  '/edit': 'draft',
  // The approval fallback; see TEXT_DECISIONS.
  '/ok': 'decide',
  '/always': 'decide',
  '/no': 'decide',
  '/abort': 'decide',
});

/**
 * Approvals answerable by **typing**, as a fallback for card buttons.
 *
 * This exists because of a specific, unresolved risk. A card-button click
 * (`card.action.trigger`) is documented as deliverable over the long connection,
 * but all three official SDKs `return` on a `type: card` data frame before
 * writing the acknowledgement, and `larksuite/node-sdk`'s README states that
 * long-connection mode supports event subscriptions and **not** callback
 * subscriptions. If that is the platform's behaviour and not merely an SDK gap,
 * every button on every card is inert and approvals cannot be answered at all --
 * which would take the whole design down, because an unanswered approval stalls
 * its turn for ever.
 *
 * A typed reply rides `im.message.receive_v1`, which is unambiguously supported.
 * So these four words are the load-bearing path and the buttons are the
 * convenience, not the other way round.
 *
 * They carry no request id -- a person typing `/ok` cannot be expected to quote a
 * UUID -- so they resolve against the oldest pending approval in the lane, and
 * the dispatcher refuses when that is ambiguous.
 */
/**
 * The review verbs, and whether each needs a draft handle.
 *
 * `/drafts` is the only one that does not: it is a question. The other three
 * act on a specific draft and are refused without one, which matters most for
 * `/send` -- a bare `/send` next to `/stop` and `/skip` on a phone keyboard is
 * one autocomplete away from posting something nobody chose.
 */
export const DRAFT_VERBS = Object.freeze({
  '/drafts': { action: 'list', needsHandle: false, takesText: false },
  '/send': { action: 'send', needsHandle: true, takesText: false },
  '/skip': { action: 'discard', needsHandle: true, takesText: false },
  '/edit': { action: 'edit', needsHandle: true, takesText: true },
});

export const TEXT_DECISIONS = Object.freeze({
  '/ok': 'accept',
  '/always': 'acceptForSession',
  '/no': 'decline',
  '/abort': 'cancel',
});

export class InboundGate {
  #chats;
  #laneBy;
  #seen = new Map(); // event_id -> arrival timestamp, insertion-ordered
  #dedupeWindowMs;
  #dedupeMax;
  #requireCommand;

  /**
   * @param {object} [init]
   * @param {string[]} [init.chats] Chat ids this relay may act on. **Empty
   *   accepts nothing.** There is no wildcard.
   * @param {string} [init.laneBy] `'chat'` (default) maps a whole conversation
   *   to one app-server thread, which is what continuity on a phone wants;
   *   `'thread'` keys on the platform's `thread_id` so each topic in a threaded
   *   group becomes its own app-server thread.
   * @param {number} [init.dedupeWindowMs] How long an event id is remembered.
   *   Must comfortably exceed the platform's re-push interval.
   * @param {number} [init.dedupeMax] Hard cap on remembered ids.
   * @param {boolean} [init.requireCommand] When true, a message is only acted
   *   on if it opens with one of the words in `COMMANDS` -- in practice
   *   `/ai`. Off by default, which is right for a chat that exists to talk to
   *   this relay and wrong for a group of people who also talk to each other.
   *   There is no middle setting keyed on mentions: the platform substitutes
   *   mention placeholders into the text and they are stripped before parsing,
   *   so "was I addressed?" is not reliably answerable from the text, and a
   *   relay that guesses wrong in a group answers messages meant for a human.
   */
  constructor({
    chats = [], laneBy = 'chat', dedupeWindowMs = 600000, dedupeMax = 4096,
    requireCommand = false,
  } = {}) {
    if (!Array.isArray(chats)) throw new TypeError('chats must be an array');
    if (laneBy !== 'chat' && laneBy !== 'thread') throw new RangeError('laneBy must be chat or thread');
    this.#chats = new Set(chats.filter((id) => typeof id === 'string' && id !== ''));
    this.#laneBy = laneBy;
    this.#dedupeWindowMs = dedupeWindowMs;
    this.#dedupeMax = dedupeMax;
    this.#requireCommand = requireCommand === true;
  }

  get allowedChatCount() { return this.#chats.size; }
  get rememberedEvents() { return this.#seen.size; }

  /**
   * Classify one envelope. Pure apart from the de-duplication memory, never
   * throws, never awaits.
   *
   * @param {object} envelope
   * @param {number} at Arrival timestamp, injected.
   */
  accept(envelope, at = 0) {
    const eventId = envelope?.header?.event_id;
    const eventType = envelope?.header?.event_type;
    if (typeof eventId !== 'string' || eventId === '' || typeof eventType !== 'string') {
      return ignored(IGNORED.malformed, 'envelope has no header.event_id / event_type');
    }

    // Before anything else, including the allowlist: a re-push of an event we
    // already acted on must not be re-acted on, and a re-push of one we ignored
    // must not be re-examined.
    this.#expire(at);
    if (this.#seen.has(eventId)) return ignored(IGNORED.duplicate, eventId);
    this.#remember(eventId, at);

    const event = envelope.event;
    if (event === null || typeof event !== 'object') {
      return ignored(IGNORED.malformed, 'envelope has no event object');
    }

    if (eventType === EVENT_TYPES.message) return this.#message(event, eventId, at);
    if (eventType === EVENT_TYPES.cardAction) return this.#cardAction(event, eventId, at);
    return ignored(IGNORED.unknownEvent, eventType);
  }

  // -- a person typed something ----------------------------------------------

  #message(event, eventId, at) {
    // Filtered before the allowlist so a bot echo in an allowed chat is also
    // rejected -- that is the loop this guard exists to break.
    if (event?.sender?.sender_type !== 'user') {
      return ignored(IGNORED.notFromUser, String(event?.sender?.sender_type ?? 'unknown'));
    }
    const message = event.message;
    const chatId = message?.chat_id;
    if (typeof chatId !== 'string' || chatId === '') {
      return ignored(IGNORED.malformed, 'message has no chat_id');
    }
    if (!this.#chats.has(chatId)) return ignored(IGNORED.chatNotAllowed, chatId);

    if (message.message_type !== 'text') {
      // Deliberate. An image or a file would need upload handling and a decision
      // about what reaches the model; neither is in scope, and guessing is worse
      // than saying no.
      return ignored(IGNORED.unsupportedMessageType, String(message.message_type));
    }

    const text = extractText(message.content);
    if (text === null) return ignored(IGNORED.malformed, 'message content is not {"text":...}');
    const cleaned = text.replace(MENTION_PLACEHOLDER, ' ').trim();
    if (cleaned === '') return ignored(IGNORED.emptyText, 'nothing but mentions');

    const parsed = parseCommand(cleaned);
    const lane = this.#lane(chatId, message.thread_id);

    const messageId = typeof message.message_id === 'string' ? message.message_id : null;

    // Gated mode: anything that is not a command is two people talking.
    if (this.#requireCommand && parsed.command === null) {
      return ignored(IGNORED.notAddressed, 'no command word');
    }

    if (parsed.command === 'stop') {
      return { intent: INTENT.interrupt, eventId, at, lane, chatId, messageId };
    }
    // Take-over and hand-back carry no operator identity, for the reason given
    // at the foot of this file: the chat allowlist has already decided who may
    // drive this relay, and a lane held by "a human" behaves no differently
    // from a lane held by a named one.
    // Neither carries text: `/mine for a sec` is not a prompt, and the
    // intent has no field for the tail to arrive in.
    if (parsed.command === 'hold') {
      return { intent: INTENT.hold, eventId, at, lane, chatId, messageId };
    }
    if (parsed.command === 'release') {
      return { intent: INTENT.release, eventId, at, lane, chatId, messageId };
    }
    if (parsed.command === 'draft') {
      if (parsed.draft === null) {
        return ignored(IGNORED.noDraftHandle, `${parsed.verb} needs a draft handle`);
      }
      return {
        intent: INTENT.draft,
        eventId,
        at,
        lane,
        chatId,
        messageId,
        action: parsed.draft.action,
        ref: parsed.draft.ref,
        text: parsed.draft.text,
      };
    }
    if (parsed.command === 'decide') {
      // Re-checked against the imported vocabulary even though the table above is
      // a literal, so that a typo in `TEXT_DECISIONS` fails loudly here instead
      // of being coerced to `decline` three layers down.
      if (!APPROVAL_DECISIONS.includes(parsed.decision)) {
        return ignored(IGNORED.badDecision, `${JSON.stringify(parsed.decision)} is not an approval decision`);
      }
      return {
        intent: INTENT.decision,
        eventId,
        at,
        lane,
        chatId,
        messageId,
        /** No id: resolve against the lane's oldest pending approval. */
        requestId: null,
        decision: parsed.decision,
        callbackToken: null,
        operator: null,
        /** Distinguishes the fallback from a button press in logs and tests. */
        via: 'text',
      };
    }
    if (parsed.text === '') return ignored(IGNORED.emptyText, 'command with no prompt');

    return {
      intent: INTENT.prompt,
      eventId,
      at,
      lane,
      chatId,
      messageId,
      threadRoot: typeof message.thread_id === 'string' ? message.thread_id : null,
      text: parsed.text,
      /** `/new` asks for a fresh app-server thread instead of resuming. */
      freshThread: parsed.command === 'new',
      /** `/end <id>` pins this prompt to one resident end. */
      endId: parsed.endId,
    };
  }

  // -- a person pressed a button ---------------------------------------------

  #cardAction(event, eventId, at) {
    const chatId = event?.context?.open_chat_id;
    if (typeof chatId !== 'string' || chatId === '') {
      return ignored(IGNORED.malformed, 'card action has no context.open_chat_id');
    }
    if (!this.#chats.has(chatId)) return ignored(IGNORED.chatNotAllowed, chatId);

    const value = readActionValue(event?.action?.value);
    if (value === null) return ignored(IGNORED.badAction, 'action.value is not an object');

    const common = {
      eventId,
      at,
      chatId,
      /**
       * Derived from the chat alone, because a card-action context carries no
       * `thread_id`. Under `laneBy: 'thread'` it is therefore only an
       * approximation -- which is harmless, because a button carries an explicit
       * `requestId` and the dispatcher resolves on that. The lane matters only
       * for the text fallback, which does arrive with a real `thread_id`.
       */
      lane: this.#lane(chatId, null),
      messageId: typeof event?.context?.open_message_id === 'string' ? event.context.open_message_id : null,
      /**
       * The card-update credential from the callback. 30 minutes, two uses.
       * Carried through so a caller *may* use the delayed-update path, but the
       * streaming design does not need it: a card entity can be rewritten
       * unconditionally at any time, which is strictly more useful than a
       * two-use token.
       */
      callbackToken: typeof event?.token === 'string' ? event.token : null,
      operator: null, // deliberately not carried; see the note below
      via: 'button',
    };

    if (value.a === ACTION.interrupt) {
      return { intent: INTENT.interrupt, ...common, turnId: asString(value.t) };
    }
    if (value.a === ACTION.approval) {
      const requestId = asString(value.r);
      if (requestId === null) return ignored(IGNORED.badAction, 'approval action has no request id');
      const decision = value.d;
      // The guard this file exists for. Not coerced, not defaulted: refused.
      if (!APPROVAL_DECISIONS.includes(decision)) {
        return ignored(IGNORED.badDecision, `${JSON.stringify(decision)} is not an approval decision`);
      }
      return { intent: INTENT.decision, ...common, requestId, decision };
    }
    return ignored(IGNORED.badAction, `unknown action ${JSON.stringify(value.a)}`);
  }

  // -- lanes and memory ------------------------------------------------------

  /**
   * The serialisation key. One lane runs at most one turn at a time, because the
   * app-server has no concurrent turns within a thread and no generic cancel.
   */
  #lane(chatId, threadId) {
    if (this.#laneBy === 'thread' && typeof threadId === 'string' && threadId !== '') {
      return `${chatId}#${threadId}`;
    }
    return chatId;
  }

  #remember(eventId, at) {
    this.#seen.set(eventId, at);
    // Insertion-ordered Map, so the oldest key is the first one.
    while (this.#seen.size > this.#dedupeMax) {
      const oldest = this.#seen.keys().next().value;
      this.#seen.delete(oldest);
    }
  }

  #expire(at) {
    if (!Number.isFinite(at)) return;
    for (const [eventId, seenAt] of this.#seen) {
      if (at - seenAt <= this.#dedupeWindowMs) break; // insertion order == age order
      this.#seen.delete(eventId);
    }
  }
}

// -- helpers -----------------------------------------------------------------

function ignored(reason, detail = null) {
  return { intent: INTENT.ignored, reason, detail };
}

/**
 * `content` is a JSON-encoded string, not an object -- a fact that costs
 * everyone one debugging session exactly once.
 */
function extractText(content) {
  if (typeof content !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  return typeof parsed?.text === 'string' ? parsed.text : null;
}

/** The docs allow `action.value` to be a string or an object. Accept both. */
function readActionValue(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function asString(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Split a leading command word off the text.
 *
 * `/end <id> <prompt>` consumes two words. A slash-word that is not in `COMMANDS`
 * is left in the text: treating every unknown slash-word as a failed command
 * would eat a perfectly good prompt that happens to start with a path.
 */
function parseCommand(text) {
  const bare = { command: null, text, endId: null, decision: null, draft: null, verb: null };
  const match = /^(\/[a-z]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (match === null) return bare;
  const command = COMMANDS[match[1]];
  if (command === undefined) return bare;
  const rest = (match[2] ?? '').trim();
  if (command === 'end') {
    const split = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
    if (split === null) return { ...bare, command: null, text: '' };
    return { ...bare, command: 'end', text: (split[2] ?? '').trim(), endId: split[1] };
  }
  if (command === 'draft') {
    const spec = DRAFT_VERBS[match[1]];
    if (!spec.needsHandle) {
      return { ...bare, command: 'draft', text: '', draft: { action: spec.action, ref: null, text: '' }, verb: match[1] };
    }
    const split = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
    if (split === null) return { ...bare, command: 'draft', draft: null, verb: match[1] };
    const tail = (split[2] ?? '').trim();
    // Only `/edit` has anywhere to put trailing words. For the others they
    // are dropped rather than refused, matching how `/no too risky` is read.
    return {
      ...bare,
      command: 'draft',
      text: '',
      draft: { action: spec.action, ref: split[1], text: spec.takesText ? tail : '' },
      verb: match[1],
    };
  }
  if (command === 'decide') {
    // Trailing words are ignored rather than rejected: `/no too risky` is a
    // perfectly clear decline, and refusing it over a comment would be hostile.
    return { ...bare, command: 'decide', text: rest, decision: TEXT_DECISIONS[match[1]] ?? null };
  }
  return { ...bare, command, text: rest };
}

// A note on what is deliberately *not* extracted: the operator's identity.
// `event.operator` carries `open_id` / `user_id` / `union_id`, and none of them
// are needed. The chat allowlist already decides who may drive this relay, so
// per-user identity would add a stable personal identifier to every log line and
// every piece of in-memory state in exchange for no authorisation decision that
// is not already made. If per-user authorisation is ever wanted, this is the
// hook -- and it should carry a hash, not the id.
