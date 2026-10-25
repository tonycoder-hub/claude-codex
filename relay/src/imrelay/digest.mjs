/**
 * The daily draft digest: the review desk for a 数字分身.
 *
 * The agent reads a day of messages and drafts replies. This file does not do
 * that drafting -- that is an ordinary turn, run through `dispatch.mjs` like
 * any other. What lives here is the narrow, boring part that decides whether
 * any of those drafts ever leaves: a book of pending drafts, a handle for each,
 * and the rule that a human types that handle before anything is sent.
 *
 * Pure, on the same terms as `dispatch.mjs`: no timers, no clock reads, no I/O.
 * Every method takes `at`; every consequence is a plain effect object the
 * caller performs.
 *
 * Five decisions worth arguing, because each one costs something:
 *
 * 1. Nothing sends without a per-draft human act. There is no bulk approve, no
 *    send-unless-you-object, no auto-send once a draft looks confident enough.
 *    This is the only property that distinguishes a drafting assistant from an
 *    account that posts in your name while you are asleep, and it is worth more
 *    than the convenience it costs. The price is real: an unreviewed digest
 *    simply expires and the day's drafts are wasted. That is the correct
 *    failure, and it is cheap -- drafting again tomorrow costs one turn.
 *
 * 2. Drafts expire. A reply written against yesterday's conversation is
 *    answering a message that has since been answered, by someone who has since
 *    moved on. Staleness is the default and freshness is the exception, so the
 *    book refuses an old draft rather than trusting the reviewer to notice the
 *    date. `send()` re-checks the age itself rather than relying on the caller
 *    having run `expire()` first, because the caller is a daemon loop and the
 *    consequence of it having skipped a tick is an out-of-date message sent to
 *    a real person.
 *
 * 3. Handles never restart. `d1` means the same draft for the life of the book,
 *    so a `/send d2` typed hours late lands on the draft the human was looking
 *    at -- which by then is expired and refused -- instead of silently hitting
 *    whatever is second in today's batch. Per-digest numbering would make the
 *    most dangerous command in this file position-dependent.
 *
 * 4. `send` demands an explicit handle; a bare `/send` is refused. `/send`,
 *    `/stop` and `/skip` share a prefix, and on a phone keyboard they are one
 *    autocomplete apart. Three of those four confusions are harmless; the one
 *    that is not puts a message in front of a person. Requiring the handle
 *    means that misfire takes two coincidences rather than one.
 *
 * 5. Chats are allowlisted here as well as at the sink. The allowlist is
 *    checked when a draft is admitted, not only when it is sent, so a draft
 *    aimed at a chat this relay may not write to never reaches the review card
 *    at all -- a human cannot approve what they were never shown.
 */

/** The life of a draft. Terminal states are terminal: nothing leaves them. */
export const DRAFT = Object.freeze({
  pending: 'pending',
  sent: 'sent',
  discarded: 'discarded',
  expired: 'expired',
});

/** Effect kinds. A closed set; the caller switches on it exhaustively. */
export const DIGEST_EFFECT = Object.freeze({
  /** Post this text as a reply. The only effect that reaches another person. */
  sendReply: 'send-reply',
  /** Say something to the reviewer. `kind` says what. */
  notice: 'notice',
});

/** `notice` kinds, so the renderer can phrase them. */
export const DIGEST_NOTICE = Object.freeze({
  opened: 'opened',
  /** A digest with nothing in it, which is a normal quiet day. */
  empty: 'empty',
  /** More drafts than the book will hold; the surplus was refused, not cut. */
  overflow: 'overflow',
  chatNotAllowed: 'chat-not-allowed',
  malformed: 'malformed',
  noSuchDraft: 'no-such-draft',
  /** A handle was given for a draft that is already sent, skipped or stale. */
  alreadyResolved: 'already-resolved',
  needsHandle: 'needs-handle',
  expired: 'expired',
  edited: 'edited',
  discarded: 'discarded',
  sent: 'sent',
});

/** What a review command concluded. */
export const DIGEST_OUTCOME = Object.freeze({
  ok: 'ok',
  rejected: 'rejected',
});

const DAY_MS = 86400000;

export class DraftBook {
  #chats;
  #maxAgeMs;
  #maxDrafts;
  #drafts = new Map();
  #seq = 0;

  /**
   * @param {object} [init]
   * @param {string[]} [init.chats] Chats a draft may be aimed at. Empty admits
   *   nothing, and there is no wildcard -- the same fuse as `InboundGate`.
   * @param {number} [init.maxAgeMs] How long a pending draft stays sendable.
   *   One day by default, matching the cadence it is drafted on.
   * @param {number} [init.maxDrafts] Pending drafts the book will hold at once.
   *   A ceiling on how much a single reviewer is asked to read, not a
   *   performance limit.
   */
  constructor({ chats = [], maxAgeMs = DAY_MS, maxDrafts = 20 } = {}) {
    if (!Array.isArray(chats)) throw new TypeError('chats must be an array of chat ids');
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new RangeError('maxAgeMs must be positive');
    if (!Number.isInteger(maxDrafts) || maxDrafts < 1) throw new RangeError('maxDrafts must be >= 1');
    this.#chats = new Set(chats);
    this.#maxAgeMs = maxAgeMs;
    this.#maxDrafts = maxDrafts;
  }

  get allowedChatCount() {
    return this.#chats.size;
  }

  /**
   * Admit a batch of drafts the agent has produced.
   *
   * Bad items are refused one at a time with a notice naming which and why,
   * rather than the batch being rejected whole or quietly filtered: a digest
   * that silently contains four of the six drafts it should reads, to the
   * person skimming it, exactly like a quiet day.
   *
   * @param {Array<{chatId: string, messageId?: string|null, summary?: string, reply: string}>} items
   * @param {number} at
   * @returns {{ refs: string[], effects: object[] }}
   */
  open(items, at = 0) {
    if (!Array.isArray(items)) throw new TypeError('items must be an array of drafts');
    const effects = [];
    const refs = [];
    for (const [index, item] of items.entries()) {
      const chatId = typeof item?.chatId === 'string' && item.chatId !== '' ? item.chatId : null;
      const reply = typeof item?.reply === 'string' ? item.reply.trim() : '';
      if (chatId === null || reply === '') {
        effects.push(notice(DIGEST_NOTICE.malformed, at, { index }));
        continue;
      }
      if (!this.#chats.has(chatId)) {
        effects.push(notice(DIGEST_NOTICE.chatNotAllowed, at, { index, chatId }));
        continue;
      }
      if (this.#pendingCount() >= this.#maxDrafts) {
        effects.push(notice(DIGEST_NOTICE.overflow, at, {
          index, held: this.#maxDrafts, refused: items.length - index,
        }));
        break;
      }
      this.#seq += 1;
      const ref = `d${this.#seq}`;
      this.#drafts.set(ref, {
        ref,
        chatId,
        messageId: typeof item.messageId === 'string' && item.messageId !== '' ? item.messageId : null,
        summary: typeof item.summary === 'string' ? item.summary : '',
        reply,
        status: DRAFT.pending,
        openedAt: at,
        editedAt: null,
      });
      refs.push(ref);
    }
    effects.push(notice(refs.length === 0 ? DIGEST_NOTICE.empty : DIGEST_NOTICE.opened, at, {
      refs, count: refs.length,
    }));
    return { refs, effects };
  }

  /** Everything still awaiting a decision, oldest first. */
  pending(at = null) {
    const out = [];
    for (const draft of this.#drafts.values()) {
      if (draft.status !== DRAFT.pending) continue;
      if (at !== null && this.#isStale(draft, at)) continue;
      out.push(view(draft));
    }
    return out;
  }

  /**
   * Send one draft. The only path in this file that reaches another person, so
   * it re-validates everything rather than trusting the book's own bookkeeping.
   */
  send({ ref } = {}, at = 0) {
    const handle = normaliseRef(ref);
    if (handle === null) {
      return rejected(notice(DIGEST_NOTICE.needsHandle, at, null));
    }
    const draft = this.#drafts.get(handle);
    if (draft === undefined) {
      return rejected(notice(DIGEST_NOTICE.noSuchDraft, at, { ref: handle }));
    }
    if (draft.status !== DRAFT.pending) {
      return rejected(notice(DIGEST_NOTICE.alreadyResolved, at, {
        ref: handle, status: draft.status,
      }));
    }
    if (this.#isStale(draft, at)) {
      draft.status = DRAFT.expired;
      return rejected(notice(DIGEST_NOTICE.expired, at, {
        ref: handle, ageMs: at - this.#freshAt(draft),
      }));
    }
    draft.status = DRAFT.sent;
    return {
      outcome: DIGEST_OUTCOME.ok,
      effects: [
        {
          type: DIGEST_EFFECT.sendReply,
          ref: handle,
          chatId: draft.chatId,
          replyTo: draft.messageId,
          text: draft.reply,
          at,
        },
        notice(DIGEST_NOTICE.sent, at, { ref: handle, chatId: draft.chatId }),
      ],
    };
  }

  /** Drop a draft. Deliberately the cheap, unguarded one of the pair. */
  discard({ ref } = {}, at = 0) {
    const handle = normaliseRef(ref);
    if (handle === null) {
      return rejected(notice(DIGEST_NOTICE.needsHandle, at, null));
    }
    const draft = this.#drafts.get(handle);
    if (draft === undefined) {
      return rejected(notice(DIGEST_NOTICE.noSuchDraft, at, { ref: handle }));
    }
    if (draft.status !== DRAFT.pending) {
      return rejected(notice(DIGEST_NOTICE.alreadyResolved, at, {
        ref: handle, status: draft.status,
      }));
    }
    draft.status = DRAFT.discarded;
    return { outcome: DIGEST_OUTCOME.ok, effects: [notice(DIGEST_NOTICE.discarded, at, { ref: handle })] };
  }

  /**
   * Replace a draft's text, leaving it pending.
   *
   * Editing is the point of a preview -- a reviewer who can only accept or
   * reject will accept things they would have reworded. The edit refreshes the
   * draft's clock: the reviewer has just read it, so it is as current as their
   * attention, and expiring something they are actively working on would be
   * perverse.
   */
  edit({ ref, text } = {}, at = 0) {
    const handle = normaliseRef(ref);
    if (handle === null) {
      return rejected(notice(DIGEST_NOTICE.needsHandle, at, null));
    }
    const draft = this.#drafts.get(handle);
    if (draft === undefined) {
      return rejected(notice(DIGEST_NOTICE.noSuchDraft, at, { ref: handle }));
    }
    if (draft.status !== DRAFT.pending) {
      return rejected(notice(DIGEST_NOTICE.alreadyResolved, at, {
        ref: handle, status: draft.status,
      }));
    }
    const replacement = typeof text === 'string' ? text.trim() : '';
    if (replacement === '') {
      // An empty edit is not a discard. Guessing between "clear this" and
      // "I fat-fingered send" is not a guess worth making.
      return rejected(notice(DIGEST_NOTICE.malformed, at, { ref: handle }));
    }
    draft.reply = replacement;
    draft.editedAt = at;
    return { outcome: DIGEST_OUTCOME.ok, effects: [notice(DIGEST_NOTICE.edited, at, { ref: handle })] };
  }

  /** Mark everything too old to send. Idempotent. */
  expire(at = 0) {
    const effects = [];
    for (const draft of this.#drafts.values()) {
      if (draft.status !== DRAFT.pending) continue;
      if (!this.#isStale(draft, at)) continue;
      draft.status = DRAFT.expired;
      effects.push(notice(DIGEST_NOTICE.expired, at, {
        ref: draft.ref, ageMs: at - this.#freshAt(draft),
      }));
    }
    return { effects };
  }

  /** A plain description of the book. The tests' main assertion. */
  snapshot() {
    return {
      drafts: [...this.#drafts.values()].map(view),
      pending: this.#pendingCount(),
    };
  }

  #pendingCount() {
    let count = 0;
    for (const draft of this.#drafts.values()) {
      if (draft.status === DRAFT.pending) count += 1;
    }
    return count;
  }

  /** An edit resets the clock; see `edit()`. */
  #freshAt(draft) {
    return draft.editedAt ?? draft.openedAt;
  }

  #isStale(draft, at) {
    if (!Number.isFinite(at)) return false;
    return at - this.#freshAt(draft) > this.#maxAgeMs;
  }
}

// -- helpers -----------------------------------------------------------------

function notice(kind, at, detail) {
  return { type: DIGEST_EFFECT.notice, kind, at, detail };
}

function rejected(effect) {
  return { outcome: DIGEST_OUTCOME.rejected, effects: [effect] };
}

function view(draft) {
  return {
    ref: draft.ref,
    chatId: draft.chatId,
    messageId: draft.messageId,
    summary: draft.summary,
    reply: draft.reply,
    status: draft.status,
    edited: draft.editedAt !== null,
  };
}

/**
 * Handles are matched case-insensitively and tolerate a missing `d` and
 * surrounding space, because they are typed on a phone.
 *
 * The trailing anchor is the part that matters. Without it `d1x` reads as
 * `d1`, so a typo in the most consequential command in this file would send
 * a real message to a real person instead of being refused. Nothing can make
 * `d1` ambiguous with `d12` -- they are different strings -- but a handle
 * with junk stuck to it must not quietly become a valid one.
 */
function normaliseRef(ref) {
  if (typeof ref !== 'string') return null;
  const match = /^d?(\d+)$/i.exec(ref.trim());
  return match === null ? null : `d${Number(match[1])}`;
}
