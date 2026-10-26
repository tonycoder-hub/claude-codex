import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64urlEncode, base64urlDecode, base64urlToArrayBuffer, Base64UrlError } from '../../web/base64url.mjs';
// The server's implementation, used as a reference oracle. The browser codec and
// the relay codec disagreeing by one character is exactly the failure this
// module exists to prevent, so the test asserts against the real other side
// rather than against a hand-copied expectation.
import { base64urlEncode as serverEncode } from '../../src/auth/bytes.mjs';

function bytes(...values) {
  return Uint8Array.from(values);
}

test('every byte value 0-255 round-trips, together and alone', () => {
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) all[i] = i;
  assert.deepEqual(base64urlDecode(base64urlEncode(all)), all);

  // Alone, too: a one-byte payload is the 2-character tail case, where the
  // unused low bits of the second character are the easiest thing to get wrong.
  for (let i = 0; i < 256; i += 1) {
    const one = bytes(i);
    const encoded = base64urlEncode(one);
    assert.equal(encoded.length, 2, `byte ${i} must encode to 2 chars`);
    assert.deepEqual(base64urlDecode(encoded), one, `byte ${i} must survive`);
  }
});

test('the browser codec agrees with the relay codec for every length and tail', () => {
  // Lengths 0..64 cover all three tail remainders many times over.
  for (let length = 0; length <= 64; length += 1) {
    const value = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) value[i] = (i * 37 + length * 11) & 0xff;
    assert.equal(base64urlEncode(value), serverEncode(value), `length ${length} must encode identically`);
  }
  // And the pathological ones: all zeroes and all 0xff, at each tail length.
  for (const fill of [0x00, 0xff, 0x80, 0x7f]) {
    for (const length of [1, 2, 3, 4, 5]) {
      const value = new Uint8Array(length).fill(fill);
      assert.equal(base64urlEncode(value), serverEncode(value));
      assert.deepEqual(base64urlDecode(base64urlEncode(value)), value);
    }
  }
});

test('encoding never emits padding or the standard-base64 alphabet', () => {
  for (let length = 0; length <= 32; length += 1) {
    const value = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) value[i] = (i * 53 + 7) & 0xff;
    const encoded = base64urlEncode(value);
    assert.match(encoded, /^[A-Za-z0-9_-]*$/, `length ${length} produced non-base64url output: ${encoded}`);
    assert.equal(encoded.includes('='), false, 'base64url on the wire carries no padding');
  }
});

test('the empty string and empty buffer are each other', () => {
  assert.equal(base64urlEncode(new Uint8Array(0)), '');
  assert.deepEqual(base64urlDecode(''), new Uint8Array(0));
  assert.equal(base64urlToArrayBuffer('').byteLength, 0);
});

test('padding is tolerated on the way in and changes nothing', () => {
  // Some encoders pad; a challenge that arrives padded must still verify.
  assert.deepEqual(base64urlDecode('QQ=='), bytes(0x41));
  assert.deepEqual(base64urlDecode('QQ'), bytes(0x41));
  assert.deepEqual(base64urlDecode('QUI='), bytes(0x41, 0x42));
  assert.deepEqual(base64urlDecode('QUI'), bytes(0x41, 0x42));
  assert.deepEqual(base64urlDecode('QUJD'), bytes(0x41, 0x42, 0x43));
  // Over-padding is still unambiguous once stripped.
  assert.deepEqual(base64urlDecode('QQ======'), bytes(0x41));
});

test('a length that no byte sequence could produce is rejected', () => {
  // 4 chars -> 3 bytes, so a remainder of 1 character is impossible.
  for (const bad of ['Q', 'QQQQQ', 'QQQQQQQQQ', 'QQQQ====Q']) {
    assert.throws(() => base64urlDecode(bad), Base64UrlError, `${bad} must be rejected`);
  }
  assert.throws(() => base64urlDecode('QQQQQ'), /impossible length/);
});

test('standard base64 is rejected loudly rather than silently mangled', () => {
  assert.throws(() => base64urlDecode('ab+c'), /standard base64, not base64url/);
  assert.throws(() => base64urlDecode('ab/c'), /standard base64, not base64url/);
  assert.throws(() => base64urlDecode('ab c'), Base64UrlError);
  assert.throws(() => base64urlDecode('abéc'), Base64UrlError);
  assert.throws(() => base64urlDecode('ab.c'), Base64UrlError);
  assert.throws(() => base64urlDecode(null), TypeError);
  assert.throws(() => base64urlDecode(undefined), TypeError);
  assert.throws(() => base64urlDecode(bytes(1, 2, 3)), TypeError);
});

test('encoding accepts every byte-shaped input, including an offset view', () => {
  const backing = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe]);
  const expected = serverEncode(Uint8Array.from([0xbe, 0xef]));

  // A subarray shares its buffer with a larger allocation. Encoding `.buffer`
  // by accident here would quietly produce the wrong 6 bytes.
  const view = backing.subarray(2, 4);
  assert.equal(base64urlEncode(view), expected);
  assert.equal(base64urlEncode(new DataView(backing.buffer, 2, 2)), expected);
  assert.equal(base64urlEncode(backing.buffer), serverEncode(backing));
  assert.throws(() => base64urlEncode('not bytes'), TypeError);
  assert.throws(() => base64urlEncode([1, 2, 3]), TypeError);
});

test('base64urlToArrayBuffer returns a real ArrayBuffer sized to the payload', () => {
  const buffer = base64urlToArrayBuffer(serverEncode(bytes(1, 2, 3, 4, 5)));
  // Not a Uint8Array, not a view: WebAuthn is handed the buffer itself, and its
  // length must be the payload length with no slack from the allocation.
  assert.ok(buffer instanceof ArrayBuffer, 'must be an ArrayBuffer');
  assert.equal(buffer.byteLength, 5);
  assert.deepEqual(new Uint8Array(buffer), bytes(1, 2, 3, 4, 5));

  for (let length = 0; length <= 40; length += 1) {
    const value = new Uint8Array(length).fill(0xa5);
    const round = base64urlToArrayBuffer(serverEncode(value));
    assert.equal(round.byteLength, length, `length ${length} must survive exactly`);
    assert.deepEqual(new Uint8Array(round), value);
  }
});

test('a 32-byte challenge, the only size that actually matters, is exact', () => {
  // 32 bytes is 43 unpadded base64url characters -- a 2-byte tail, and the size
  // of every challenge and most credential ids this relay will ever see.
  const challenge = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) challenge[i] = (i * 7 + 3) & 0xff;
  const encoded = serverEncode(challenge);
  assert.equal(encoded.length, 43);
  assert.deepEqual(new Uint8Array(base64urlToArrayBuffer(encoded)), challenge);
  assert.equal(base64urlEncode(base64urlToArrayBuffer(encoded)), encoded);
});
