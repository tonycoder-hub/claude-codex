/**
 * The process that runs the IM relay.
 *
 * Everything else in `src/imrelay/` is a pure part: no module reads a clock, no
 * module opens a socket, and `transport.mjs` has no imports at all. That design
 * is why the parts are testable, and it is also why, until this file existed,
 * nothing outside `test/` imported any of them. This is the seam where the
 * clock and the I/O live, and it is deliberately the only one.
 *
 * Six decisions are load-bearing here:
 *
 * 1. **The inbound handler enqueues and returns.** The platform re-delivers any
 *    event whose handler takes longer than `eventHandlerDeadlineMs` (3 s), so
 *    `#onEvent` does only the pure routing -- gate, then dispatcher or draft
 *    book -- pushes the effects it gets back onto a queue, and returns
 *    `undefined`. Every network call happens later, in `drain()`. A handler that
 *    awaited a card write would turn one slow API call into a duplicate turn.
 *
 * 2. **Effects are routed by provenance, never by sniffing their shape.**
 *    `EFFECT.notice` and `DIGEST_EFFECT.notice` are both the literal string
 *    `'notice'`, and their payloads differ: the dispatcher's carries a `lane`,
 *    the draft book's does not. Today their `kind` vocabularies happen not to
 *    overlap, but that is a coincidence nobody is maintaining. The queue
 *    therefore records which subsystem produced each batch, because the caller
 *    always knows and a guess would eventually send a draft notice to a lane.
 *
 * 3. **A notice is never sent to a guessed chat.** The notice effect names a
 *    lane, and with `laneBy: 'thread'` a lane is not a chat id. The daemon
 *    remembers the chat each lane was last seen in; if it does not know, the
 *    notice is recorded as a failure rather than delivered somewhere plausible.
 *    Saying nothing is recoverable. Saying it in the wrong group is not.
 *
 * 4. **Every notice kind is phrased here**, because no renderer for notices
 *    exists and phrasing is policy, not mechanism. A kind with no phrasing is
 *    surfaced verbatim rather than dropped, and `daemon.test.mjs` asserts the
 *    table covers `NOTICE` and `DIGEST_NOTICE` exhaustively -- so the fallback
 *    only ever serves a kind added after this file was last read.
 *
 * 5. **The card shell is rewritten only when `shellDigest` changes.**
 *    `wiring.test.mjs` creates the card entity once and thereafter only pushes
 *    `streamText`, which means the status badge and header never move on
 *    screen. Gating a full `updateCardEntity` on the digest costs one extra
 *    write per real shell change instead of one per delta.
 *
 * 6. **This file constructs no network connection.** It takes a long connection
 *    and a sink as arguments. `harnessConnection()` below is a local ingress
 *    that satisfies the same four-member contract from a script, so the daemon
 *    is runnable, and demonstrable, with no credentials anywhere.
 *
 * 7. **The clock is a required argument, not a default.** `gate.accept(envelope,
 *    at)` expires its de-duplication window from `at`, so a daemon that let
 *    `at` default to 0 would keep every event id it had ever seen inside the
 *    window forever and evict only on the 4096-entry cap. The suite would stay
 *    green -- de-duplication still works, just unboundedly -- which is the
 *    shape of bug this project keeps finding. Omitting `now` throws.
 */

import { ANY_NOTIFICATION } from '../appserver/client.mjs';
import { DETAIL, renderCard } from './cards.mjs';
import { DIGEST_EFFECT, DIGEST_NOTICE } from './digest.mjs';
import { EFFECT, NOTICE } from './dispatch.mjs';
import { INTENT } from './inbound.mjs';
import { TurnProjection, itemIdOf, threadIdOf } from './projection.mjs';
import { CardPacer, PACE, TokenBucket, pacingFor } from './throttle.mjs';
import { LARK_LIMITS, OPS, RATE_LIMIT_CODE, assertLongConnection } from './transport.mjs';

/** Which subsystem produced a batch of effects. See decision 2. */
export const ORIGIN = Object.freeze({
  dispatcher: 'dispatcher',
  drafts: 'drafts',
});

/**
 * There is deliberately no allow-list of observed notification methods.
 *
 * An earlier version of this file carried one, naming the eight methods in
 * `projection.apply()`'s switch. That list cannot be right: the streaming
 * path is matched by a regex, `/^item\/([A-Za-z0-9_]+)\/delta$/`, over an open
 * set of item kinds, so an enumeration drops every delta and leaves a card
 * showing item shells with no text in them. `apply()` already returns `false`
 * for anything it has no opinion about and documents that as normal, so the
 * decision is the projection's to make and this file hands it everything.
 */

/**
 * Phrasing for every `NOTICE` kind. Chinese, because the cards are
 * (`cards.mjs` renders 执行中 / 已完成) and a relay that narrates itself in two
 * languages reads like two different programs.
 *
 * Each entry takes the effect's `detail` and returns one line. Entries ignore
 * `detail` unless its shape is actually known -- inventing a field name here
 * would print `undefined` at a human.
 */
const NOTICE_TEXT = Object.freeze({
  [NOTICE.queued]: () => '收到，前面还有任务在跑，这条先排队。',
  [NOTICE.endOffline]: () => '执行端当前离线，任务留在队列里，等它回来再跑。',
  [NOTICE.noEnds]: () => '现在没有可用的执行端，任务没有排队，请稍后再发一次。',
  [NOTICE.queueFull]: () => '队列满了，这条没有收下。等前面的跑完再发。',
  [NOTICE.rehomed]: () => '原来的执行端不在了，这条会换一个执行端重新开始。',
  [NOTICE.finished]: (detail) => {
    const status = typeof detail?.status === 'string' ? detail.status : null;
    if (status === 'interrupted') return '已打断。';
    if (status === 'failed') return '这一轮失败了。';
    return '这一轮结束了。';
  },
  [NOTICE.interruptNothing]: () => '这里没有正在跑的任务，没什么可打断的。',
  [NOTICE.held]: (detail) => {
    const parts = [];
    if (detail?.already === true) return '这条会话本来就在你手上。';
    if (detail?.interrupted === true) parts.push('已打断正在跑的这一轮');
    const dropped = Number.isInteger(detail?.dropped) ? detail.dropped : 0;
    if (dropped > 0) parts.push(`丢掉了排队中的 ${dropped} 条`);
    const tail = parts.length === 0 ? '' : `（${parts.join('，')}）`;
    return `这条会话交给你了${tail}。我不会再接它，/release 交还。`;
  },
  [NOTICE.released]: () => '已交还，我重新开始接这条会话。',
  [NOTICE.releaseNothing]: () => '这条会话没有被接管，不用交还。',
  [NOTICE.approvalNothing]: () => '现在没有等待确认的事项。',
  [NOTICE.approvalAmbiguous]: () => '有不止一项在等确认，请点卡片上的按钮指明是哪一项。',
});

/** Phrasing for every `DIGEST_NOTICE` kind. */
const DRAFT_NOTICE_TEXT = Object.freeze({
  [DIGEST_NOTICE.opened]: (detail) => {
    const held = Number.isInteger(detail?.held) ? detail.held : null;
    return held === null ? '今天的草稿已生成。' : `今天的草稿已生成，共 ${held} 条待你过目。`;
  },
  [DIGEST_NOTICE.empty]: () => '今天没有需要回复的消息，没有生成草稿。',
  [DIGEST_NOTICE.overflow]: (detail) => {
    const refused = Number.isInteger(detail?.refused) ? detail.refused : null;
    return refused === null
      ? '草稿数量超过上限，多出来的没有收下。'
      : `草稿数量超过上限，有 ${refused} 条没有收下。`;
  },
  [DIGEST_NOTICE.chatNotAllowed]: () => '有草稿指向了不在允许名单里的会话，已拒绝。',
  [DIGEST_NOTICE.malformed]: () => '这条草稿的内容不完整，已拒绝。',
  [DIGEST_NOTICE.noSuchDraft]: () => '没有这个编号的草稿。/drafts 看一下当前列表。',
  [DIGEST_NOTICE.alreadyResolved]: () => '这条草稿已经处理过了。',
  [DIGEST_NOTICE.needsHandle]: () => '要指明哪一条，例如 /send d1。没有编号我不会发。',
  [DIGEST_NOTICE.expired]: () => '这条草稿已经过期，不会再发出去。',
  [DIGEST_NOTICE.edited]: () => '已改好，确认后用 /send 发出。',
  [DIGEST_NOTICE.discarded]: () => '已丢弃。',
  [DIGEST_NOTICE.sent]: () => '已发出。',
});

/**
 * Render one notice line. An unknown kind is named rather than swallowed: a
 * silent drop is how a relay stops talking without anyone noticing.
 */
export function noticeText(kind, detail = null) {
  const phrase = Object.hasOwn(NOTICE_TEXT, kind) ? NOTICE_TEXT[kind] : null;
  if (phrase === null) return unphrased(kind, detail);
  return phrase(detail);
}

/** As `noticeText`, for the draft digest's own vocabulary. */
export function draftNoticeText(kind, detail = null) {
  const phrase = Object.hasOwn(DRAFT_NOTICE_TEXT, kind) ? DRAFT_NOTICE_TEXT[kind] : null;
  if (phrase === null) return unphrased(kind, detail);
  return phrase(detail);
}

function unphrased(kind, detail) {
  const tail = detail === null || detail === undefined ? '' : ` ${JSON.stringify(detail)}`;
  return `[${String(kind)}]${tail}`;
}

/** Render the pending-draft list. `DraftBook` has no `list()`; this is it. */
export function draftListText(pending) {
  if (!Array.isArray(pending) || pending.length === 0) return '现在没有待发的草稿。';
  const lines = pending.map((draft) => {
    const head = String(draft?.reply ?? '').replace(/\s+/g, ' ').trim();
    const clipped = head.length > 60 ? `${head.slice(0, 60)}…` : head;
    return `${draft?.ref ?? '?'}  ${clipped}`;
  });
  return [`待发草稿 ${pending.length} 条：`, ...lines, '/send d1 发出 · /edit d1 改写 · /skip d1 丢弃'].join('\n');
}

/**
 * A long connection that satisfies `LONG_CONNECTION_CONTRACT` from a local
 * source instead of a websocket. The relay can be run, driven and watched end
 * to end with no credentials and no egress; `deliver()` is how a script, a
 * stdin reader or a test pushes an envelope in.
 *
 * `deliver` calls the handler **synchronously** and refuses a handler that
 * returns a thenable, mirroring `test/imrelay/fakes.mjs`. The real platform
 * re-pushes an event whose handler has not returned in 3 s, so a handler that
 * awaits is a duplicate-message bug that only shows up under load.
 */
export function harnessConnection() {
  let handler = null;
  let closed = null;
  let started = false;
  let open = false;
  return {
    start() {
      started = true;
      open = true;
      return Promise.resolve();
    },
    onEvent(cb) { handler = cb; },
    onClose(cb) { closed = cb; },
    close() {
      if (!open) return;
      open = false;
      closed?.();
    },
    get started() { return started; },
    get open() { return open; },
    deliver(envelope) {
      if (handler === null) throw new Error('nothing is listening for events yet');
      if (!open) throw new Error('the connection is closed');
      const outcome = handler(envelope);
      if (typeof outcome?.then === 'function') {
        throw new Error('the event handler returned a promise; it must not await the work');
      }
      return outcome;
    },
  };
}

/**
 * How a turn reaches the screen.
 *
 * `cardkit` is the design this subsystem was built for: create a card entity
 * once, then push cumulative text into one of its elements, so the chat shows a
 * single message that types itself. It needs three CardKit endpoints.
 *
 * `snapshot` exists because the only credential route available for the first
 * real send -- the `feishu-lark` CLI as the authorised *user* -- registers no
 * CardKit tool at all. In this mode each flush is a whole new `interactive`
 * message carrying the rendered card: no entity, no streaming, no in-place
 * update. It is strictly worse to look at and it is the only one that can
 * currently reach a person, so both exist rather than one replacing the other.
 *
 * The two differ in more than the op they emit, which is why this is a mode and
 * not a flag read at the call site:
 *
 *   - **Pacing source.** CardKit's ceiling is 10 writes/s *per card entity*;
 *     posting new messages is capped at 5/s *per chat* and shared with every
 *     other bot in it. Using the CardKit number here would authorise twice the
 *     real allowance against the wrong limit.
 *   - **Legibility.** Even 5/s is unreadable when each write is a new message
 *     rather than a rewrite of one, so snapshot mode is additionally floored by
 *     `SNAPSHOT_INTERVAL_MS` and leans on `note(rev, { urgent: true })` for the
 *     final frame instead of on a short interval.
 *   - **The interrupt button.** It is a card callback, and there is no endpoint
 *     answering callbacks on this route, so snapshot mode renders without it.
 */
export const CARD_STRATEGY = Object.freeze({
  cardkit: 'cardkit',
  snapshot: 'snapshot',
});

/**
 * Floor for `snapshot` mode's coalescing interval, in ms.
 *
 * Not derived from a platform limit -- it is a legibility number. The platform
 * would permit 5 sends/s per chat, which `pacingFor` turns into one every
 * 267 ms; a turn that ran for half a minute would then leave over a hundred
 * messages in the chat. Three seconds keeps a 40-second turn to roughly a dozen
 * and still lets the card visibly move. Override with `cardIntervalMs` when a
 * run wants fewer; it cannot be overridden *downwards* past what the platform
 * allows.
 */
export const SNAPSHOT_INTERVAL_MS = 3000;

/**
 * Floor for the pause after the platform says we are going too fast, in ms.
 *
 * The frequency limits this subsystem runs into are expressed per second, so a
 * second is the smallest pause that can clear one. See `Relay#backoffFor`.
 */
export const RATE_LIMIT_BACKOFF_MS = 1000;

/** How many recorded failures to keep. Past this, the oldest are dropped. */
const MAX_FAILURES = 64;

/** How many item->lane mappings to keep. Past this, the oldest is forgotten. */
const MAX_TRACKED_ITEMS = 4096;

/**
 * The interpreter. Construct it with the pure parts plus a connection, a sink
 * and an app-server client; call `start()`, then `tick(now)` on a timer.
 */
export class Relay {
  #gate;
  #dispatcher;
  #drafts;
  #sink;
  #client;
  #connection;
  #detail;
  #pacing;
  #bucket;
  #fetchEnds;
  #now;
  #log;
  #cardStrategy;
  /** Prefix for send `uuid`s, so a retry of one revision is idempotent. */
  #runId;
  #laneSeq = 0;

  /** lane -> the chat it was last seen in. See decision 3. */
  #chatOfLane = new Map();
  /** lane -> { projection, pacer, cardId, shell, sequence, endId, chatId } */
  #cards = new Map();
  /** itemId -> lane, learned from any notification that names both. */
  #itemOwner = new Map();
  /** Effects awaiting I/O, each tagged with the subsystem that produced it. */
  #queue = [];
  #draining = false;
  #failures = [];
  #running = false;

  constructor({
    gate,
    dispatcher,
    drafts,
    sink,
    client,
    connection,
    now,
    fetchEnds = null,
    detail = DETAIL.full,
    concurrentCards = 1,
    cardStrategy = CARD_STRATEGY.cardkit,
    cardIntervalMs = null,
    log = () => {},
  } = {}) {
    if (gate === undefined || dispatcher === undefined || drafts === undefined) {
      throw new TypeError('a relay needs a gate, a dispatcher and a draft book');
    }
    if (typeof sink?.perform !== 'function') throw new TypeError('a relay needs a sink');
    if (typeof client?.call !== 'function') throw new TypeError('a relay needs an app-server client');
    // Decision 7: no default. A silently-zero clock breaks inbound de-duplication
    // in a way no assertion in this repo would notice.
    if (typeof now !== 'function') throw new TypeError('a relay needs a now() clock');
    if (!Object.hasOwn(CARD_STRATEGY, cardStrategy)) {
      throw new RangeError(`${String(cardStrategy)} is not a card strategy`);
    }
    this.#gate = gate;
    this.#dispatcher = dispatcher;
    this.#drafts = drafts;
    this.#sink = sink;
    this.#client = client;
    this.#connection = assertLongConnection(connection);
    this.#detail = detail;
    this.#fetchEnds = fetchEnds;
    this.#now = now;
    this.#log = log;
    this.#cardStrategy = cardStrategy;
    // Base36 seconds, so a `uuid` from a previous process cannot collide with
    // this one's inside the platform's one-hour de-duplication window. Clipped
    // to the last 7 digits, which is ~70 years of seconds and keeps the whole
    // uuid comfortably under `sendUuidMaxChars`.
    this.#runId = Math.floor(Math.abs(Number(now()) || 0) / 1000).toString(36).slice(-7);
    const snapshotMode = cardStrategy === CARD_STRATEGY.snapshot;
    this.#pacing = pacingFor({
      // Snapshot mode posts a new message per flush, so the limit that applies
      // is the per-chat send ceiling, not the per-card-entity one.
      updatesPerSecond: snapshotMode
        ? LARK_LIMITS.sendPerChatPerSecond
        : LARK_LIMITS.cardKitPerCardPerSecond,
      concurrentCards,
    });
    const floor = cardIntervalMs ?? (snapshotMode ? SNAPSHOT_INTERVAL_MS : null);
    if (floor !== null) {
      if (!Number.isFinite(floor) || floor < this.#pacing.minIntervalMs) {
        // Refused rather than clamped: a caller who asked for 50 ms wanted
        // something this route cannot give, and silently giving them 267 ms
        // would make the run look like it honoured the request.
        throw new RangeError(
          `cardIntervalMs ${String(floor)} is below the ${this.#pacing.minIntervalMs}ms `
          + 'the platform limits allow for this strategy',
        );
      }
      this.#pacing = { ...this.#pacing, minIntervalMs: floor };
    }
    // One bucket for the whole app: the platform's limit is per app, not per
    // card, so a bucket per lane would authorise N times the real allowance.
    this.#bucket = new TokenBucket({ ...this.#pacing.bucket, now: 0 });
  }

  get cardStrategy() { return this.#cardStrategy; }

  get minIntervalMs() { return this.#pacing.minIntervalMs; }
  get failures() { return [...this.#failures]; }
  get running() { return this.#running; }

  /** Bind the connection and the notification stream. */
  async start() {
    this.#connection.onEvent((envelope) => this.#onEvent(envelope));
    this.#connection.onClose(() => {
      this.#running = false;
      this.#log({ at: null, what: 'connection-closed' });
    });
    this.#client.on(ANY_NOTIFICATION, (params, method) => this.#onNotification(params, method));
    await this.#connection.start();
    this.#running = true;
    return this;
  }

  /**
   * The synchronous half. Routes one envelope and returns; see decision 1.
   * Never throws into the platform's handler -- a throw there is indistinguishable
   * from a timeout and earns the same re-push.
   */
  #onEvent(envelope) {
    try {
      const intent = this.#gate.accept(envelope, this.#now());
      if (intent.intent === INTENT.ignored) {
        this.#log({ what: 'ignored', reason: intent.reason, detail: intent.detail });
        return undefined;
      }
      if (typeof intent.lane === 'string' && typeof intent.chatId === 'string') {
        this.#chatOfLane.set(intent.lane, intent.chatId);
      }
      this.#log({ what: 'intent', intent: intent.intent, lane: intent.lane, at: intent.at });
      this.#route(intent);
    } catch (error) {
      this.#fail('inbound', error);
    }
    return undefined;
  }

  #route(intent) {
    const at = intent.at ?? 0;
    switch (intent.intent) {
      case INTENT.prompt:
        return this.#fromDispatcher(this.#dispatcher.submit(intent, at));
      case INTENT.interrupt:
        return this.#fromDispatcher(this.#dispatcher.interrupt(intent, at));
      case INTENT.hold:
        return this.#fromDispatcher(this.#dispatcher.hold(intent, at));
      case INTENT.release:
        return this.#fromDispatcher(this.#dispatcher.release(intent, at));
      case INTENT.decision:
        return this.#fromDispatcher(this.#dispatcher.answerApproval(intent, at));
      case INTENT.draft:
        return this.#routeDraft(intent, at);
      default:
        this.#fail('route', new Error(`no route for intent ${String(intent.intent)}`));
        return undefined;
    }
  }

  #routeDraft(intent, at) {
    // `/drafts` has no DraftBook method -- the book holds state, not a view --
    // so the list is rendered here and queued as an ordinary reply.
    if (intent.action === 'list') {
      const text = draftListText(this.#drafts.pending(at));
      this.#queue.push({ origin: ORIGIN.drafts, effect: { type: DIGEST_EFFECT.sendReply, ref: null, chatId: intent.chatId, replyTo: intent.messageId, text, at } });
      return undefined;
    }
    if (intent.action === 'send') return this.#fromDrafts(this.#drafts.send(intent, at));
    if (intent.action === 'discard') return this.#fromDrafts(this.#drafts.discard(intent, at));
    if (intent.action === 'edit') return this.#fromDrafts(this.#drafts.edit(intent, at));
    this.#fail('route', new Error(`no draft action ${String(intent.action)}`));
    return undefined;
  }

  #fromDispatcher(outcome) { return this.#enqueue(ORIGIN.dispatcher, outcome?.effects); }
  #fromDrafts(outcome) { return this.#enqueue(ORIGIN.drafts, outcome?.effects); }

  /**
   * Queue a batch. Every effect-producing method in this subsystem returns
   * `{ effects }`, and an earlier version of this file wrapped that in a
   * second `{ effects }` at four call sites. This function silently returned
   * on the non-array, so the relay stopped telling anyone that a turn had
   * failed and every test still passed. A shape it cannot queue is now a
   * recorded failure.
   */
  #enqueue(origin, effects) {
    if (!Array.isArray(effects)) {
      this.#fail('enqueue', new TypeError(`${origin} produced ${typeof effects}, not an array of effects`));
      return undefined;
    }
    for (const effect of effects) this.#queue.push({ origin, effect });
    return undefined;
  }

  /**
   * Fold one app-server notification into the projection it belongs to.
   *
   * Three ways to decide whose it is, in order:
   *   1. the thread id, when the payload carries one;
   *   2. the item id, against ownership learned from an earlier notification
   *      that named both -- deltas are `{itemId, delta}` and carry no thread,
   *      so this is the only thing that routes the streaming path;
   *   3. the single open turn, when there is exactly one.
   *
   * Anything else is REFUSED rather than broadcast. `TurnProjection` rejects a
   * payload naming a different thread but accepts one naming no thread at all,
   * by design, so broadcasting here would paint one lane's output onto another
   * lane's card. Losing a delta is recoverable; showing a person someone
   * else's conversation is not.
   */
  #onNotification(params, method) {
    const open = [...this.#cards.entries()];
    if (open.length === 0) return;
    // The projection's own readers, not a second pair. Both spellings --
    // flat `threadId` and nested `thread.id`, flat `itemId` and nested
    // `item.id` -- have to be understood identically here and there, or a
    // notification routes to a projection that then refuses it, or worse
    // routes nowhere while exactly one turn is open and nobody notices.
    const thread = threadIdOf(params);
    const item = itemIdOf(params);

    let targets = null;
    if (thread !== null) {
      targets = open.filter(([, s]) => s.projection.threadId === thread);
    } else if (item !== null && this.#itemOwner.has(item)) {
      const owner = this.#itemOwner.get(item);
      targets = open.filter(([lane]) => lane === owner);
    } else if (open.length === 1) {
      targets = open;
    } else {
      this.#fail('notification', new Error(`${method} names neither a thread nor a known item and ${open.length} turns are open`));
      return;
    }

    for (const [lane, state] of targets) {
      if (item !== null) this.#remember(item, lane);
      // Guarded on apply()'s verdict, and the guard is not load-bearing at
      // the sink: `note()` only raises `#pending`, and `poll()` goes idle
      // once `#written` has caught up, so noting a revision that did not
      // move writes nothing. Removing the `if` is an equivalent mutant and
      // no test kills it -- recorded here so the next person to run mutation
      // testing does not spend an hour writing one. It stays because the
      // guard also withholds `urgent`, and that one does carry.
      if (state.projection.apply(method, params, state.lastAt ?? 0)) {
        state.pacer.note(state.projection.revision, { urgent: state.projection.terminal });
      }
    }
  }

  /** Learn which lane an item belongs to, forgetting the oldest past the cap. */
  #remember(itemId, lane) {
    this.#itemOwner.set(itemId, lane);
    if (this.#itemOwner.size <= MAX_TRACKED_ITEMS) return;
    for (const oldest of this.#itemOwner.keys()) {
      this.#itemOwner.delete(oldest);
      break;
    }
  }

  /**
   * The asynchronous half: drain queued effects, then give every open card a
   * chance to flush. Called on a timer; safe to call concurrently (the drain is
   * guarded) and safe to call when there is nothing to do.
   */
  async tick(now) {
    if (this.#fetchEnds !== null) {
      try {
        this.#fromDispatcher(this.#dispatcher.observeEnds(await this.#fetchEnds(), now));
      } catch (error) {
        this.#fail('ends', error);
      }
    }
    this.#fromDispatcher(this.#dispatcher.tick(now));
    this.#fromDrafts(this.#drafts.expire(now));
    await this.drain(now);
    await this.flushCards(now);
  }

  /** Perform every queued effect. One failure never stops the rest. */
  async drain(now = 0) {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0) {
        const { origin, effect } = this.#queue.shift();
        try {
          await this.#perform(origin, effect, now);
        } catch (error) {
          this.#fail(`${origin}:${effect?.type}`, error);
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  async #perform(origin, effect, now) {
    const at = effect?.at ?? now;
    if (origin === ORIGIN.drafts) {
      if (effect.type === DIGEST_EFFECT.sendReply) return this.#say(effect.chatId, effect.text, effect.replyTo, effect.ref);
      if (effect.type === DIGEST_EFFECT.notice) return this.#sayToReviewer(effect);
      throw new Error(`unknown draft effect ${String(effect.type)}`);
    }
    switch (effect.type) {
      case EFFECT.startTurn: return this.#startTurn(effect, at);
      case EFFECT.interruptTurn: return this.#interruptTurn(effect, at);
      case EFFECT.notice: return this.#sayNotice(effect);
      case EFFECT.remindApproval: return this.#remind(effect, at);
      case EFFECT.orphaned: return this.#orphaned(effect, at);
      default: throw new Error(`unknown dispatcher effect ${String(effect.type)}`);
    }
  }

  async #startTurn(effect, at) {
    const { lane, chatId, endId, threadId, text } = effect;
    try {
      let thread = threadId;
      if (thread === null) {
        thread = readId(await this.#client.call('thread/start', { endId }), 'threadId', 'thread_id');
      } else {
        await this.#client.call('thread/resume', { threadId: thread, endId });
      }
      const turnId = readId(await this.#client.call('turn/start', { threadId: thread, input: text }), 'turnId', 'turn_id');
      this.#dispatcher.turnAccepted({ lane, threadId: thread, turnId }, at);
      this.#cards.set(lane, {
        projection: new TurnProjection({ chatKey: lane, threadId: thread, turnId }),
        pacer: new CardPacer({ minIntervalMs: this.#pacing.minIntervalMs, bucket: this.#bucket }),
        cardId: null, shell: null, sequence: 0, endId, chatId, lastAt: at,
        // Snapshot mode only. `lastCard` is the JSON actually posted, so a
        // revision bump that renders identically costs no message; `laneIndex`
        // makes the send uuid unique per lane without hashing the lane name.
        lastCard: null, laneIndex: ++this.#laneSeq,
      });
      this.#log({ what: 'turn-started', lane, threadId: thread, turnId, at });
    } catch (error) {
      this.#fail('start-turn', error);
      this.#fromDispatcher(this.#dispatcher.turnFinished({ lane, status: 'failed', error: String(error?.message ?? error) }, at));
    }
  }

  async #interruptTurn(effect, at) {
    const { lane, threadId, turnId } = effect;
    try {
      await this.#client.call('turn/interrupt', { threadId, turnId });
      this.#cards.get(lane)?.projection.conclude('interrupted', { at });
      this.#fromDispatcher(this.#dispatcher.turnFinished({ lane, status: 'interrupted' }, at));
    } catch (error) {
      this.#fail('interrupt-turn', error);
    }
  }

  async #orphaned(effect, at) {
    const state = this.#cards.get(effect.lane);
    if (state === undefined) return;
    state.projection.conclude('failed', { error: 'the end running this turn went away', at });
    state.pacer.note(state.projection.revision, { urgent: true });
  }

  async #remind(effect, at) {
    const state = this.#cards.get(effect.lane);
    if (state !== undefined) state.pacer.note(state.projection.revision, { urgent: true });
    return this.#sayNotice({ ...effect, kind: NOTICE.approvalNothing, detail: null, remind: true });
  }

  async #sayNotice(effect) {
    const chatId = this.#chatOfLane.get(effect.lane) ?? null;
    if (chatId === null) {
      // Decision 3: a notice with no known chat is dropped loudly, not guessed.
      this.#fail('notice', new Error(`no chat known for lane ${String(effect.lane)}; notice ${String(effect.kind)} not sent`));
      return;
    }
    const text = effect.remind === true
      ? '还有一项在等你确认。'
      : noticeText(effect.kind, effect.detail ?? null);
    await this.#say(chatId, text, null, null);
  }

  async #sayToReviewer(effect) {
    const chatId = effect.chatId ?? this.#reviewerChat();
    if (chatId === null) {
      this.#fail('draft-notice', new Error(`no chat to report ${String(effect.kind)} to`));
      return;
    }
    await this.#say(chatId, draftNoticeText(effect.kind, effect.detail ?? null), null, null);
  }

  /** The chat a draft notice goes to when the effect does not name one. */
  #reviewerChat() {
    for (const chatId of this.#chatOfLane.values()) return chatId;
    return null;
  }

  async #say(chatId, text, replyTo, uuid) {
    const op = { op: OPS.sendMessage, receiveId: chatId, msgType: 'text', content: { text } };
    if (typeof replyTo === 'string') op.replyTo = replyTo;
    if (typeof uuid === 'string') op.uuid = uuid;
    this.#log({ what: 'say', chatId, text });
    return this.#sink.perform(op);
  }

  /** Give every open card one chance to write. */
  async flushCards(now) {
    for (const [lane, state] of this.#cards) {
      state.lastAt = now;
      const decision = state.pacer.poll(now);
      if (decision.action !== PACE.flush) continue;
      try {
        await this.#writeCard(lane, state, decision, now);
      } catch (error) {
        this.#fail('card', error);
        state.pacer.failed(now, { retryAfterMs: this.#backoffFor(error) });
      }
    }
  }

  async #writeCard(lane, state, decision, now) {
    if (this.#cardStrategy === CARD_STRATEGY.snapshot) {
      return this.#writeSnapshotCard(lane, state, decision, now);
    }
    const rendered = renderCard(state.projection.snapshot(), { detail: this.#detail, endId: state.endId });
    if (state.cardId === null) {
      const created = await this.#sink.perform({ op: OPS.createCardEntity, card: rendered.card, forChat: state.chatId });
      state.cardId = created?.data?.card_id ?? null;
      if (state.cardId === null) throw new Error('createCardEntity returned no card_id');
      this.#sink.allowCard(state.cardId, state.chatId);
      state.shell = rendered.shellDigest;
      await this.#sink.perform({ op: OPS.sendMessage, receiveId: state.chatId, msgType: 'interactive', content: { type: 'card', data: { card_id: state.cardId } } });
    } else if (rendered.shellDigest !== state.shell) {
      // Decision 5: the badge and header only move if the whole card is rewritten.
      await this.#sink.perform({ op: OPS.updateCardEntity, cardId: state.cardId, card: rendered.card, sequence: ++state.sequence });
      state.shell = rendered.shellDigest;
    }
    await this.#sink.perform({
      op: OPS.streamText, cardId: state.cardId, elementId: rendered.streamElementId,
      content: rendered.streamContent, sequence: ++state.sequence,
    });
    state.pacer.settled(decision.revision, now);
    this.#log({ what: 'card', lane, revision: decision.revision, bytes: rendered.bytes, truncated: rendered.truncated });
  }

  /**
   * One flush in `snapshot` mode: the whole card, as a new message.
   *
   * Three things here are not in the CardKit path and each is load-bearing.
   *
   *   - `streaming: false`, because `streaming_mode` on a card nobody will ever
   *     update holds the entity in a mode that expires in ten minutes and makes
   *     the client wait for text that is never coming.
   *   - `interrupt: false`, because the button is a card callback and nothing on
   *     this route answers callbacks.
   *   - The `lastCard` comparison. A revision moves whenever the projection
   *     changes, and plenty of changes -- a tool call that renders to nothing in
   *     `brief`, an item completing with no new text -- render to a byte-identical
   *     card. In CardKit mode re-pushing identical text is invisible; here it is
   *     another message in the person's chat. When nothing changed the pacer is
   *     still `settled`, because leaving the revision pending would make
   *     `drainCards` spin to its limit and then record a failure for a card that
   *     is perfectly up to date.
   */
  async #writeSnapshotCard(lane, state, decision, now) {
    const rendered = renderCard(state.projection.snapshot(), {
      detail: this.#detail, endId: state.endId, streaming: false, interrupt: false,
    });
    const json = JSON.stringify(rendered.card);
    if (json === state.lastCard) {
      state.pacer.settled(decision.revision, now);
      this.#log({ what: 'card-unchanged', lane, revision: decision.revision });
      return;
    }
    await this.#sink.perform({
      op: OPS.sendMessage,
      receiveId: state.chatId,
      msgType: 'interactive',
      content: rendered.card,
      uuid: `${this.#runId}-${state.laneIndex}-${decision.revision}`,
    });
    state.lastCard = json;
    state.pacer.settled(decision.revision, now);
    this.#log({ what: 'card', lane, revision: decision.revision, bytes: rendered.bytes, truncated: rendered.truncated });
  }

  /**
   * How long to stay quiet after a failed write. `null` means "the ordinary
   * coalescing interval"; a number means "at least this long".
   *
   * The previous version of this returned a flat `1000` for a throttled write,
   * and that number was wrong in a way nothing could see. `CardPacer#poll`
   * waits for the **longest** of its floors, so a 1000 ms server-signalled
   * backoff is invisible whenever the coalescing interval is already a second
   * or more -- which is every snapshot-mode run. Worse, the thing it was
   * supposed to express is "the platform told us to slow down", and a constant
   * can be *shorter* than the pace we had already chosen for ourselves.
   *
   * So a throttle now doubles our own interval, with a one-second floor for the
   * CardKit path where the interval is 134 ms. That is strictly longer than an
   * ordinary failure's backoff in both strategies, which is both the right
   * behaviour and the only way the branch is observable from outside.
   */
  #backoffFor(error) {
    if (!rateLimited(error)) return null;
    return Math.max(RATE_LIMIT_BACKOFF_MS, this.#pacing.minIntervalMs * 2);
  }

  /**
   * Keep polling while any pacer still holds a pending revision, so the last
   * delta of a turn lands. Without this the card reads as though the model
   * stopped mid-sentence.
   */
  async drainCards(now, { stepMs = null, limit = 64 } = {}) {
    const step = stepMs ?? this.#pacing.minIntervalMs;
    let clock = now;
    for (let i = 0; i < limit; i += 1) {
      const outstanding = [...this.#cards.values()].some((s) => s.pacer.pending !== null);
      if (!outstanding) return clock;
      await this.flushCards(clock);
      clock += step;
    }
    this.#fail('drain-cards', new Error('cards still pending after the flush limit'));
    return clock;
  }

  async stop() {
    this.#running = false;
    this.#connection.close();
  }

  snapshot() {
    return {
      running: this.#running,
      queued: this.#queue.length,
      lanes: [...this.#cards.entries()].map(([lane, s]) => ({
        lane, chatId: s.chatId, cardId: s.cardId, sequence: s.sequence,
        revision: s.projection.revision, status: s.projection.status, pending: s.pacer.pending,
      })),
      knownChats: this.#chatOfLane.size,
      failures: this.#failures.length,
    };
  }

  #fail(where, error) {
    this.#failures.push({ where, error: String(error?.message ?? error) });
    if (this.#failures.length > MAX_FAILURES) this.#failures.shift();
    this.#log({ what: 'failure', where, error: String(error?.message ?? error) });
  }
}

/**
 * True for the platform's rate-limit code or an HTTP 429 carried on an error.
 *
 * Worth knowing who can make this true. A direct HTTP sink would carry the code
 * or the status straight through. The `feishu-lark` route cannot: its
 * `assertLarkOk` discards every numeric code except `99991672` before the error
 * leaves the process, so `feishu-sink.mjs` re-attaches `RATE_LIMIT_CODE` from a
 * **string match** on the message. That match is deliberately fragile and
 * documented as such at `looksRateLimited()`; the alternative was a branch here
 * that reads as "throttling is handled" and provably never runs.
 */
function rateLimited(error) {
  return error?.code === RATE_LIMIT_CODE || error?.status === 429;
}

/**
 * Read an id out of a reply under either spelling. The app-server's envelope
 * field names are NOT verified here -- `projection.mjs` carries the same
 * caveat for `item/*` -- so both the camelCase and snake_case spellings are
 * accepted rather than one being asserted as correct.
 */
function readId(result, ...names) {
  for (const name of names) {
    const value = result?.[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}
