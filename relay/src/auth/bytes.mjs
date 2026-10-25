// Small byte helpers shared across the auth layer. base64url (no padding) is the
// wire form WebAuthn uses everywhere -- challenges, credential ids, raw ids -- so
// it is worth having one correct implementation rather than three almost-correct
// ones scattered around.

import { randomBytes, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';

export function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input === 'string') return new TextEncoder().encode(input);
  throw new TypeError('expected bytes or string');
}

export function base64urlEncode(input) {
  const bytes = toBytes(input);
  return Buffer.from(bytes).toString('base64url');
}

export function base64urlDecode(str) {
  if (typeof str !== 'string') throw new TypeError('base64url input must be a string');
  // Buffer is lenient about padding and both alphabets; reject anything that is
  // not strictly base64url so a malformed challenge cannot slip through as "close
  // enough".
  if (!/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('invalid base64url string');
  return new Uint8Array(Buffer.from(str, 'base64url'));
}

/** Constant-time equality over two byte sequences of any (possibly differing) length. */
export function timingSafeEqual(a, b) {
  const ab = toBytes(a);
  const bb = toBytes(b);
  if (ab.length !== bb.length) {
    // Still touch both to avoid a trivial length oracle on the common path.
    nodeTimingSafeEqual(ab, ab);
    return false;
  }
  return nodeTimingSafeEqual(ab, bb);
}

export function randomId(byteLength = 32) {
  return base64urlEncode(randomBytes(byteLength));
}

export function concatBytes(...chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
