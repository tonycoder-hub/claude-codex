import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, CodecError } from '../../src/tunnel/codec.mjs';

/** encode -> decode must return a value structurally identical to the input. */
function roundTrip(value) {
  return decode(encode(value));
}

/** The whole point: the encoded form survives a JSON round-trip untouched. */
function throughJson(value) {
  return decode(JSON.parse(JSON.stringify(encode(value))));
}

test('primitives round-trip, including the ones JSON mangles', () => {
  for (const v of ['hi', '', 0, 1, -1, 3.5, 1e300, true, false, null]) {
    assert.deepEqual(roundTrip(v), v);
    assert.deepEqual(throughJson(v), v);
  }
});

test('undefined survives as undefined, not null', () => {
  assert.equal(roundTrip(undefined), undefined);
  assert.equal(throughJson(undefined), undefined);
  // and as an object value, where JSON would drop the key entirely
  const obj = throughJson({ a: undefined, b: 1 });
  assert.ok('a' in obj, 'the key must survive');
  assert.equal(obj.a, undefined);
  assert.equal(obj.b, 1);
});

test('non-finite numbers and negative zero are preserved', () => {
  assert.ok(Number.isNaN(throughJson(NaN)));
  assert.equal(throughJson(Infinity), Infinity);
  assert.equal(throughJson(-Infinity), -Infinity);
  assert.ok(Object.is(throughJson(-0), -0), 'must be -0, not 0');
  assert.ok(!Object.is(throughJson(0), -0), '0 must stay 0');
});

test('bigint round-trips through JSON', () => {
  assert.equal(throughJson(123n), 123n);
  assert.equal(throughJson(-9007199254740993n), -9007199254740993n);
});

test('Date round-trips, including an invalid Date', () => {
  const d = new Date('2026-10-22T03:04:05.678Z');
  assert.equal(throughJson(d).getTime(), d.getTime());
  assert.ok(Number.isNaN(throughJson(new Date(NaN)).getTime()));
});

test('RegExp keeps source and flags', () => {
  const re = throughJson(/ab+c/giu);
  assert.equal(re.source, 'ab+c');
  assert.equal(re.flags, 'giu');
});

test('ArrayBuffer and every typed array round-trip by bytes and type', () => {
  const ab = throughJson(new Uint8Array([1, 2, 3, 255]).buffer);
  assert.deepEqual([...new Uint8Array(ab)], [1, 2, 3, 255]);

  const views = [
    new Int8Array([-1, 0, 127]),
    new Uint8Array([0, 128, 255]),
    new Uint8ClampedArray([0, 255]),
    new Int16Array([-30000, 30000]),
    new Uint16Array([0, 65535]),
    new Int32Array([-1, 2 ** 31 - 1]),
    new Uint32Array([0, 2 ** 32 - 1]),
    new Float32Array([1.5, -2.25]),
    new Float64Array([Math.PI, -0]),
    new BigInt64Array([-5n, 5n]),
    new BigUint64Array([0n, 18446744073709551615n]),
  ];
  for (const view of views) {
    const out = throughJson(view);
    assert.equal(out.constructor.name, view.constructor.name, 'type must be preserved');
    assert.deepEqual(out, view);
  }
});

test('a typed array over a sliced buffer encodes only its own window', () => {
  const backing = new Uint8Array([9, 9, 1, 2, 3, 9]).buffer;
  const view = new Uint8Array(backing, 2, 3); // [1,2,3]
  const out = throughJson(view);
  assert.deepEqual([...out], [1, 2, 3]);
  assert.equal(out.byteLength, 3);
});

test('DataView round-trips', () => {
  const dv = new DataView(new Uint8Array([1, 2, 3, 4]).buffer);
  const out = throughJson(dv);
  assert.ok(out instanceof DataView);
  assert.equal(out.getUint32(0), dv.getUint32(0));
});

test('Map and Set round-trip, including non-string keys', () => {
  const map = new Map([['a', 1], [2, 'b'], [true, new Uint8Array([7])]]);
  const out = throughJson(map);
  assert.ok(out instanceof Map);
  assert.equal(out.get('a'), 1);
  assert.equal(out.get(2), 'b');
  assert.deepEqual(out.get(true), new Uint8Array([7]));

  const set = throughJson(new Set([1, 'x', 1]));
  assert.ok(set instanceof Set);
  assert.deepEqual([...set], [1, 'x']);
});

test('Error round-trips name, message, cause, and custom fields', () => {
  class CeremonyError extends Error {
    constructor(m, status) { super(m); this.name = 'CeremonyError'; this.status = status; }
  }
  const out = throughJson(new CeremonyError('nope', 403));
  assert.equal(out.message, 'nope');
  assert.equal(out.name, 'CeremonyError');
  assert.equal(out.status, 403);

  const typed = throughJson(new TypeError('bad', { cause: new RangeError('why') }));
  assert.ok(typed instanceof TypeError);
  assert.equal(typed.message, 'bad');
  assert.ok(typed.cause instanceof RangeError);
  assert.equal(typed.cause.message, 'why');
});

test('a data object whose own key is $t is escaped and restored', () => {
  const sneaky = { $t: 'ta', c: 'not really a typed array', nested: { $t: 'u' } };
  assert.deepEqual(throughJson(sneaky), sneaky);
});

test('a realistic capnweb frame round-trips end to end', () => {
  const frame = ['resolve', 0, {
    bytes: new Uint8Array([137, 80, 78, 71]), // a PNG magic header
    label: undefined,
    when: new Date(1000),
    counts: new Map([['a', 1n]]),
    ratio: -0,
    missing: NaN,
  }];
  const out = throughJson(frame);
  assert.equal(out[0], 'resolve');
  assert.equal(out[1], 0);
  assert.deepEqual(out[2].bytes, new Uint8Array([137, 80, 78, 71]));
  assert.equal(out[2].label, undefined);
  assert.ok('label' in out[2]);
  assert.equal(out[2].when.getTime(), 1000);
  assert.equal(out[2].counts.get('a'), 1n);
  assert.ok(Object.is(out[2].ratio, -0));
  assert.ok(Number.isNaN(out[2].missing));
});

test('functions and symbols are refused rather than silently dropped', () => {
  assert.throws(() => encode(() => {}), CodecError);
  assert.throws(() => encode(Symbol('x')), CodecError);
  assert.throws(() => encode({ ok: 1, bad: () => {} }), CodecError);
});

test('SharedArrayBuffer is refused with a clear error', (t) => {
  if (typeof SharedArrayBuffer === 'undefined') return t.skip('no SharedArrayBuffer');
  assert.throws(() => encode(new SharedArrayBuffer(8)), CodecError);
});

test('a cycle is rejected by the depth guard instead of overflowing', () => {
  const a = {};
  a.self = a;
  assert.throws(() => encode(a), CodecError);
});

test('unknown tags on decode are rejected', () => {
  assert.throws(() => decode({ $t: 'zzz' }), CodecError);
  assert.throws(() => decode({ $t: 'n', v: 'bogus' }), CodecError);
  assert.throws(() => decode({ $t: 'ta', c: 'NopeArray', b: '' }), CodecError);
});
