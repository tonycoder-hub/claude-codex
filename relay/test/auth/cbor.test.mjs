import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, decodeFirst, encode, CborError } from '../../src/auth/cbor.mjs';

const hex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));

test('decodes canonical RFC 8949 examples', () => {
  assert.equal(decode(hex('00')), 0);
  assert.equal(decode(hex('17')), 23);
  assert.equal(decode(hex('1818')), 24);
  assert.equal(decode(hex('190100')), 256);
  assert.equal(decode(hex('1a000f4240')), 1000000);
  assert.equal(decode(hex('20')), -1);
  assert.equal(decode(hex('3863')), -100);
  assert.equal(decode(hex('f4')), false);
  assert.equal(decode(hex('f5')), true);
  assert.equal(decode(hex('f6')), null);
  assert.deepEqual(decode(hex('83010203')), [1, 2, 3]);
});

test('decodes text and byte strings', () => {
  assert.equal(decode(hex('6161')), 'a');
  assert.deepEqual([...decode(hex('43010203'))], [1, 2, 3]);
});

test('maps decode to Map and preserve integer keys', () => {
  // {1: 2, 3: 4}
  const m = decode(hex('a201020304'));
  assert.ok(m instanceof Map);
  assert.equal(m.get(1), 2);
  assert.equal(m.get(3), 4);
});

test('rejects indefinite-length items', () => {
  assert.throws(() => decode(hex('9f00ff')), CborError); // indefinite array
  assert.throws(() => decode(hex('5f41004101ff')), CborError); // indefinite bytes
});

test('rejects trailing bytes at the top level', () => {
  assert.throws(() => decode(hex('0000')), /trailing/);
});

test('decodeFirst reports consumed length and tolerates a trailing item', () => {
  const { value, length } = decodeFirst(hex('182a' + 'f5'));
  assert.equal(value, 42);
  assert.equal(length, 2);
});

test('rejects duplicate map keys but tolerates non-canonical order', () => {
  // map(2): key 3 -> 0, key 1 -> 0  (out of canonical order, but valid) -> accepted
  const m = decode(hex('a203000100'));
  assert.equal(m.get(3), 0);
  assert.equal(m.get(1), 0);
  // map(2): key 1 -> 0, key 1 -> 0  (duplicate) -> rejected
  assert.throws(() => decode(hex('a201000100')), /duplicate/);
});

test('encode produces canonical bytes that round-trip', () => {
  const samples = [
    0, 23, 24, 256, 1000000, -1, -100,
    'hello', new Uint8Array([9, 8, 7]),
    [1, 'two', [3]],
    new Map([[-7, 'es256'], [1, 2], [3, [4, 5]]]),
    true, false, null,
  ];
  for (const s of samples) {
    assert.deepEqual(decode(encode(s)), s);
  }
});

test('encode sorts map keys into CTAP2 canonical order', () => {
  // -7 encodes as 0x26 (1 byte), 1 as 0x01, 3 as 0x03 -> ordering is 1,3,-7
  const bytes = encode(new Map([[-7, 0], [3, 0], [1, 0]]));
  // first key byte after the map head (0xa3) must be 0x01
  assert.equal(bytes[1], 0x01);
});
