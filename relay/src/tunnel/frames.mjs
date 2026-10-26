// The framing layer that sits between the structured-clone codec and whatever
// moves bytes (a WebSocket to the browser, CDP Runtime.evaluate to the page).
//
// It does two things the transports below it do not:
//
//   1. It stamps every outbound message with a per-direction monotonic sequence
//      number, and checks that inbound numbers arrive with no gap and no repeat.
//   2. It wraps the codec's transit form in a tiny versioned envelope so a build
//      skew or a corrupted frame is a clean error rather than a mysterious crash
//      three layers up.
//
// Why the gap check is load-bearing, not belt-and-braces: capnweb is a *stateful*
// protocol. Import and export ids are assigned implicitly by position in the
// frame stream, so a single dropped or reordered frame desynchronises both ends
// permanently -- every subsequent id refers to the wrong thing. There is no
// re-request-frame-N recovery; the only correct response to a gap is to tear the
// session down and mint a fresh host endpoint. So the decoder's job is to NOTICE
// the gap immediately and loudly (a GapError carrying what it expected and got),
// not to try to paper over it.
//
// The Framer is transit-level on purpose. The surface mostly shuttles already-
// encoded transit forms between the page boundary and the WebSocket and must not
// re-encode them; the browser and the page hold real values and want the codec
// folded in. So `frame`/`parse` work on transit forms, and `frameValue`/
// `parseValue` are the convenience wrappers for the real-value ends.

import { encode, decode } from './codec.mjs';

export const PROTOCOL_VERSION = 1;

export class FrameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FrameError';
  }
}

/**
 * A missing, repeated, or reordered inbound frame. Because capnweb cannot recover
 * from this, callers should treat it as "this session is dead, reconnect".
 */
export class GapError extends Error {
  constructor({ expected, got }) {
    const direction = got > expected ? 'ahead (frames were lost)' : 'behind (replay or reorder)';
    super(`sequence gap: expected ${expected}, got ${got} -- ${direction}`);
    this.name = 'GapError';
    this.expected = expected;
    this.got = got;
    this.lost = got > expected;
  }
}

export class Framer {
  #out = 0; // seq of the last frame we sent
  #in = 0;  // seq of the last frame we accepted (0 = none yet)

  /** The next outbound frame will carry this sequence number. */
  get nextOutboundSeq() { return this.#out + 1; }
  /** The next inbound frame must carry this sequence number. */
  get nextInboundSeq() { return this.#in + 1; }

  /** Frame an already-encoded transit payload. Returns the wire string. */
  frame(kind, transit = null) {
    if (typeof kind !== 'string' || kind.length === 0) {
      throw new FrameError('a frame needs a non-empty string kind');
    }
    const seq = ++this.#out;
    return JSON.stringify({ p: PROTOCOL_VERSION, q: seq, k: kind, d: transit });
  }

  /** Frame a real value, running it through the codec first. */
  frameValue(kind, value) {
    return this.frame(kind, encode(value));
  }

  /**
   * Parse a wire string into `{ seq, kind, transit }`, enforcing the sequence
   * invariant. Throws GapError on a break, FrameError on anything malformed.
   */
  parse(wire) {
    let msg;
    try {
      msg = JSON.parse(wire);
    } catch {
      throw new FrameError('frame is not valid JSON');
    }
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
      throw new FrameError('frame is not an envelope object');
    }
    if (msg.p !== PROTOCOL_VERSION) {
      throw new FrameError(`unsupported protocol version: ${JSON.stringify(msg.p)}`);
    }
    if (!Number.isSafeInteger(msg.q) || msg.q <= 0) {
      throw new FrameError(`frame has a non-positive-integer sequence: ${JSON.stringify(msg.q)}`);
    }
    if (typeof msg.k !== 'string' || msg.k.length === 0) {
      throw new FrameError('frame has no kind');
    }
    const expected = this.#in + 1;
    if (msg.q !== expected) {
      // State is left untouched: the caller is expected to discard this Framer and
      // reconnect, and advancing #in here would only hide a second gap.
      throw new GapError({ expected, got: msg.q });
    }
    this.#in = msg.q;
    return { seq: msg.q, kind: msg.k, transit: msg.d ?? null };
  }

  /** Parse a wire string and decode its payload back into a real value. */
  parseValue(wire) {
    const { seq, kind, transit } = this.parse(wire);
    return { seq, kind, value: transit === null ? null : decode(transit) };
  }
}
