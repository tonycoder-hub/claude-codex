import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DraftBook, DRAFT, DIGEST_EFFECT, DIGEST_NOTICE, DIGEST_OUTCOME,
} from '../../src/imrelay/digest.mjs';

const CHAT = 'oc_allowed';
const DAY = 86400000;

function book(init = {}) {
  return new DraftBook({ chats: [CHAT], ...init });
}

function draft(over = {}) {
  return { chatId: CHAT, messageId: 'om_1', summary: 'asked about the build', reply: 'green since 3pm', ...over };
}

const kinds = (effects) => effects.filter((e) => e.type === DIGEST_EFFECT.notice).map((e) => e.kind);
const sends = (effects) => effects.filter((e) => e.type === DIGEST_EFFECT.sendReply);

// -- the fuse ----------------------------------------------------------------

test('an empty allowlist admits nothing and there is no wildcard', () => {
  const closed = new DraftBook();
  assert.equal(closed.allowedChatCount, 0);
  for (const chatId of [CHAT, '*', '']) {
    const { refs, effects } = closed.open([draft({ chatId })], 0);
    assert.deepEqual(refs, []);
    assert.ok(kinds(effects).includes(DIGEST_NOTICE.malformed)
      || kinds(effects).includes(DIGEST_NOTICE.chatNotAllowed), chatId);
  }
  assert.throws(() => new DraftBook({ chats: '*' }), TypeError);
});

test('a draft aimed at a chat we may not write to never reaches the reviewer', () => {
  const { refs, effects } = book().open([draft({ chatId: 'oc_internal_readonly' })], 0);
  assert.deepEqual(refs, []);
  assert.deepEqual(kinds(effects), [DIGEST_NOTICE.chatNotAllowed, DIGEST_NOTICE.empty]);
});

test('a nonsense configuration is refused', () => {
  assert.throws(() => new DraftBook({ maxDrafts: 0 }), RangeError);
  assert.throws(() => new DraftBook({ maxAgeMs: 0 }), RangeError);
  assert.throws(() => book().open('not an array', 0), TypeError);
});

// -- admission ---------------------------------------------------------------

test('a batch is admitted with handles and a reviewer can read it back', () => {
  const b = book();
  const { refs } = b.open([draft(), draft({ reply: 'tomorrow' })], 0);
  assert.deepEqual(refs, ['d1', 'd2']);
  assert.deepEqual(b.pending().map((d) => [d.ref, d.reply]),
    [['d1', 'green since 3pm'], ['d2', 'tomorrow']]);
});

test('a bad item is refused by name, not dropped on the floor', () => {
  const b = book();
  const { refs, effects } = b.open([draft(), { chatId: CHAT, reply: '   ' }, draft({ chatId: null })], 0);
  assert.deepEqual(refs, ['d1']);
  const malformed = effects.filter((e) => e.kind === DIGEST_NOTICE.malformed);
  assert.deepEqual(malformed.map((e) => e.detail.index), [1, 2]);
});

test('a quiet day says so rather than saying nothing', () => {
  const { refs, effects } = book().open([], 0);
  assert.deepEqual(refs, []);
  assert.deepEqual(kinds(effects), [DIGEST_NOTICE.empty]);
});

test('overflow is reported with a count, never silently truncated', () => {
  const b = book({ maxDrafts: 2 });
  const { refs, effects } = b.open([draft(), draft(), draft(), draft()], 0);
  assert.deepEqual(refs, ['d1', 'd2']);
  const over = effects.find((e) => e.kind === DIGEST_NOTICE.overflow);
  assert.deepEqual(over.detail, { index: 2, held: 2, refused: 2 });
});

test('resolving a draft makes room for the next digest', () => {
  const b = book({ maxDrafts: 1 });
  b.open([draft()], 0);
  assert.deepEqual(b.open([draft()], 1).refs, []);
  b.discard({ ref: 'd1' }, 2);
  assert.deepEqual(b.open([draft()], 3).refs, ['d2']);
});

// -- the only path that reaches a person -------------------------------------

test('sending is the only effect that leaves, and it carries the reply target', () => {
  const b = book();
  b.open([draft()], 0);
  const { outcome, effects } = b.send({ ref: 'd1' }, 10);
  assert.equal(outcome, DIGEST_OUTCOME.ok);
  assert.deepEqual(sends(effects).map((e) => [e.chatId, e.replyTo, e.text]),
    [[CHAT, 'om_1', 'green since 3pm']]);
  assert.equal(b.snapshot().drafts[0].status, DRAFT.sent);
});

test('nothing is sent without a handle, because /send sits next to /stop and /skip', () => {
  const b = book();
  b.open([draft()], 0);
  for (const ref of [undefined, '', '   ', null, 7, 'all', '*']) {
    const { outcome, effects } = b.send({ ref }, 1);
    assert.equal(outcome, DIGEST_OUTCOME.rejected, String(ref));
    assert.equal(sends(effects).length, 0, String(ref));
  }
  assert.equal(b.snapshot().drafts[0].status, DRAFT.pending);
});

test('there is no bulk approve: each draft is sent on its own', () => {
  const b = book();
  b.open([draft(), draft(), draft()], 0);
  assert.equal(sends(b.send({ ref: 'd2' }, 1).effects).length, 1);
  assert.deepEqual(b.pending().map((d) => d.ref), ['d1', 'd3']);
});

test('each handle resolves its own draft and no neighbour', () => {
  const b = book();
  for (let i = 0; i < 12; i += 1) b.open([draft({ reply: `reply ${i}` })], 0);
  assert.equal(sends(b.send({ ref: 'd1' }, 1).effects)[0].text, 'reply 0');
  assert.equal(sends(b.send({ ref: 'd12' }, 1).effects)[0].text, 'reply 11');
});

test('a handle with junk stuck to it is refused, not read as the handle inside', () => {
  const b = book();
  b.open([draft(), draft()], 0);
  for (const ref of ['d1x', 'd1.', 'd1,', 'd1 2', 'd1-send', 'dd1', '1d', 'd 1']) {
    const { outcome, effects } = b.send({ ref }, 1);
    assert.equal(outcome, DIGEST_OUTCOME.rejected, ref);
    assert.equal(sends(effects).length, 0, ref);
  }
  assert.deepEqual(b.pending().map((d) => d.ref), ['d1', 'd2']);
});

test('a handle survives a phone keyboard', () => {
  const b = book();
  b.open([draft(), draft()], 0);
  assert.equal(b.send({ ref: ' D2 ' }, 1).outcome, DIGEST_OUTCOME.ok);
  assert.equal(b.send({ ref: '1' }, 1).outcome, DIGEST_OUTCOME.ok);
});

test('an unknown handle is refused rather than guessed at', () => {
  const b = book();
  b.open([draft()], 0);
  const { outcome, effects } = b.send({ ref: 'd9' }, 1);
  assert.equal(outcome, DIGEST_OUTCOME.rejected);
  assert.deepEqual(kinds(effects), [DIGEST_NOTICE.noSuchDraft]);
});

test('a draft cannot be sent twice, or sent after being skipped', () => {
  const b = book();
  b.open([draft(), draft()], 0);
  b.send({ ref: 'd1' }, 1);
  b.discard({ ref: 'd2' }, 1);
  for (const ref of ['d1', 'd2']) {
    const { outcome, effects } = b.send({ ref }, 2);
    assert.equal(outcome, DIGEST_OUTCOME.rejected, ref);
    assert.deepEqual(kinds(effects), [DIGEST_NOTICE.alreadyResolved], ref);
    assert.equal(sends(effects).length, 0, ref);
  }
});

// -- staleness ---------------------------------------------------------------

test('a draft older than a day is refused even though nobody ran expire()', () => {
  const b = book();
  b.open([draft()], 0);
  const { outcome, effects } = b.send({ ref: 'd1' }, DAY + 1);
  assert.equal(outcome, DIGEST_OUTCOME.rejected);
  assert.deepEqual(kinds(effects), [DIGEST_NOTICE.expired]);
  assert.equal(sends(effects).length, 0);
  assert.equal(b.snapshot().drafts[0].status, DRAFT.expired);
});

test('a draft is sendable right up to the deadline', () => {
  const b = book();
  b.open([draft()], 0);
  assert.equal(b.send({ ref: 'd1' }, DAY).outcome, DIGEST_OUTCOME.ok);
});

test('expire names what went stale and is idempotent', () => {
  const b = book();
  b.open([draft(), draft()], 0);
  b.discard({ ref: 'd2' }, 1);
  const first = b.expire(DAY + 1);
  assert.deepEqual(first.effects.map((e) => e.detail.ref), ['d1']);
  assert.deepEqual(b.expire(DAY + 2).effects, []);
  assert.equal(b.snapshot().drafts[1].status, DRAFT.discarded);
});

test('pending(at) hides what is stale without mutating anything', () => {
  const b = book();
  b.open([draft()], 0);
  assert.deepEqual(b.pending(DAY + 1), []);
  assert.equal(b.snapshot().drafts[0].status, DRAFT.pending);
  assert.deepEqual(b.pending().map((d) => d.ref), ['d1']);
});

// -- editing -----------------------------------------------------------------

test('editing replaces the text, keeps it pending, and is what gets sent', () => {
  const b = book();
  b.open([draft()], 0);
  const { outcome, effects } = b.edit({ ref: 'd1', text: '  green since 3pm, deploy at 5  ' }, 1);
  assert.equal(outcome, DIGEST_OUTCOME.ok);
  assert.deepEqual(kinds(effects), [DIGEST_NOTICE.edited]);
  assert.equal(b.pending()[0].edited, true);
  assert.equal(sends(b.send({ ref: 'd1' }, 2).effects)[0].text, 'green since 3pm, deploy at 5');
});

test('an edit refreshes the clock, so a draft being worked on does not expire', () => {
  const b = book();
  b.open([draft()], 0);
  b.edit({ ref: 'd1', text: 'reworded' }, DAY);
  assert.equal(b.send({ ref: 'd1' }, DAY + 10).outcome, DIGEST_OUTCOME.ok);
});

test('an empty edit is refused rather than read as a discard', () => {
  const b = book();
  b.open([draft()], 0);
  const { outcome, effects } = b.edit({ ref: 'd1', text: '   ' }, 1);
  assert.equal(outcome, DIGEST_OUTCOME.rejected);
  assert.deepEqual(kinds(effects), [DIGEST_NOTICE.malformed]);
  assert.equal(b.pending()[0].reply, 'green since 3pm');
});

test('a resolved draft cannot be edited back to life', () => {
  const b = book();
  b.open([draft()], 0);
  b.send({ ref: 'd1' }, 1);
  assert.equal(b.edit({ ref: 'd1', text: 'wait, no' }, 2).outcome, DIGEST_OUTCOME.rejected);
  assert.equal(b.snapshot().drafts[0].reply, 'green since 3pm');
});

test('discard refuses the same things send does, minus the staleness check', () => {
  const b = book();
  b.open([draft()], 0);
  assert.equal(b.discard({}, 1).outcome, DIGEST_OUTCOME.rejected);
  assert.equal(b.discard({ ref: 'd9' }, 1).outcome, DIGEST_OUTCOME.rejected);
  // Throwing away something stale is still a perfectly good outcome.
  assert.equal(b.discard({ ref: 'd1' }, DAY + 1).outcome, DIGEST_OUTCOME.ok);
});
