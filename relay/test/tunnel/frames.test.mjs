import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Framer, GapError, FrameError, PROTOCOL_VERSION } from '../../src/tunnel/frames.mjs';

/** A hand-built wire envelope, for forging the sequence numbers a Framer won't. */
function envelope({ p = PROTOCOL_VERSION, q, k = 'frame', d = null }) {
  return JSON.stringify({ p, q, k, d });
}

test('a framed value arrives intact at the other end', () => {
  const sender = new Framer();
  const receiver = new Framer();
  const wire = sender.frameValue('frame', ['resolve', 0, { bytes: new Uint8Array([1, 2]), x: undefined }]);
  const { seq, kind, value } = receiver.parseValue(wire);
  assert.equal(seq, 1);
  assert.equal(kind, 'frame');
  assert.equal(value[0], 'resolve');
  assert.deepEqual(value[2].bytes, new Uint8Array([1, 2]));
  assert.ok('x' in value[2]);
  assert.equal(value[2].x, undefined);
});

test('outbound sequence numbers are monotonic from 1', () => {
  const f = new Framer();
  assert.equal(f.nextOutboundSeq, 1);
  assert.equal(JSON.parse(f.frame('a')).q, 1);
  assert.equal(JSON.parse(f.frame('b')).q, 2);
  assert.equal(JSON.parse(f.frame('c')).q, 3);
  assert.equal(f.nextOutboundSeq, 4);
});

test('an in-order stream is accepted and advances the inbound counter', () => {
  const sender = new Framer();
  const receiver = new Framer();
  for (let i = 1; i <= 5; i++) {
    const { seq } = receiver.parse(sender.frame('frame'));
    assert.equal(seq, i);
  }
  assert.equal(receiver.nextInboundSeq, 6);
});

test('a lost frame is caught as a GapError that says frames were lost', () => {
  const receiver = new Framer();
  receiver.parse(envelope({ q: 1 }));
  try {
    receiver.parse(envelope({ q: 3 })); // 2 never arrived
    assert.fail('expected a GapError');
  } catch (err) {
    assert.ok(err instanceof GapError);
    assert.equal(err.expected, 2);
    assert.equal(err.got, 3);
    assert.equal(err.lost, true);
  }
});

test('a replayed frame is caught as a GapError that is not a loss', () => {
  const receiver = new Framer();
  receiver.parse(envelope({ q: 1 }));
  receiver.parse(envelope({ q: 2 }));
  try {
    receiver.parse(envelope({ q: 2 })); // replay
    assert.fail('expected a GapError');
  } catch (err) {
    assert.ok(err instanceof GapError);
    assert.equal(err.expected, 3);
    assert.equal(err.got, 2);
    assert.equal(err.lost, false);
  }
});

test('a gap leaves the counter untouched so recovery is the caller\'s choice', () => {
  const receiver = new Framer();
  receiver.parse(envelope({ q: 1 }));
  assert.throws(() => receiver.parse(envelope({ q: 5 })), GapError);
  // The Framer did not quietly resync; the very next expected seq is still 2.
  assert.equal(receiver.nextInboundSeq, 2);
  assert.doesNotThrow(() => receiver.parse(envelope({ q: 2 })));
});

test('the two directions keep independent counters', () => {
  const a = new Framer();
  const b = new Framer();
  // a -> b twice, b -> a once; neither side's inbound count touches its outbound.
  b.parse(a.frame('frame'));
  b.parse(a.frame('frame'));
  a.parse(b.frame('frame'));
  assert.equal(a.nextOutboundSeq, 3);
  assert.equal(a.nextInboundSeq, 2);
  assert.equal(b.nextOutboundSeq, 2);
  assert.equal(b.nextInboundSeq, 3);
});

test('a control frame carries a null payload cleanly', () => {
  const sender = new Framer();
  const receiver = new Framer();
  const { kind, value } = receiver.parseValue(sender.frame('ping'));
  assert.equal(kind, 'ping');
  assert.equal(value, null);
});

test('malformed envelopes are FrameErrors, not crashes', () => {
  const r = new Framer();
  assert.throws(() => r.parse('not json'), FrameError);
  assert.throws(() => r.parse(JSON.stringify([1, 2, 3])), FrameError);
  assert.throws(() => r.parse(envelope({ p: 999, q: 1 })), FrameError);
  assert.throws(() => r.parse(envelope({ q: 0 })), FrameError);
  assert.throws(() => r.parse(envelope({ q: 1.5 })), FrameError);
  assert.throws(() => r.parse(JSON.stringify({ p: PROTOCOL_VERSION, q: 1 })), FrameError); // no kind
});

test('framing an empty kind is refused', () => {
  const f = new Framer();
  assert.throws(() => f.frame(''), FrameError);
  assert.throws(() => f.frame(42), FrameError);
});
