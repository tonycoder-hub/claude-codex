// Structured-clone-faithful value codec for the relay tunnel.
//
// Why this exists: the host endpoint speaks capnweb over a MessagePort, whose
// transport is the structured clone algorithm. The browser speaks to the surface
// over a WebSocket, whose transport is text or binary -- and JSON.stringify is
// NOT a faithful substitute for structured clone. JSON silently turns `undefined`
// into `null` (or drops the key), collapses `NaN`/`Infinity`/`-0`, cannot carry
// the typed-array bytes that tool results and image/audio payloads ride on, and
// loses Date/BigInt/Map/Set/RegExp/Error. Relaying those verbatim is the whole
// job.
//
// There is a second, less obvious boundary with the same problem: we pull capnweb
// frames out of the resident page over CDP, and `Runtime.evaluate` with
// returnByValue runs its own (lossy) serializer -- a Uint8Array comes back as
// `{"0":..,"1":..}`, `undefined` vanishes. So the page encodes each frame with
// THIS codec before handing it to CDP, and the browser decodes with it after the
// WebSocket. The encoded form is deliberately JSON-safe: `encode(value)` returns
// something JSON.stringify round-trips losslessly, so it survives both CDP's
// serializer and the WebSocket unchanged, and `decode` inverts it. That one
// property is why the same source must run in Node (surface + host side) and in a
// browser (the phone), using nothing but universally-available primitives.
//
// Scope, stated honestly: this is faithful for the structured-clone *types*
// capnweb frames actually carry. Like capnweb's own flat wire format, and like
// JSON, it assumes acyclic values -- a cycle is a bug on the producing side, not
// a frame we ever expect, so rather than silently diverge from structured clone's
// cycle support we fail loudly via a depth guard instead of overflowing the
// stack. Primitive wrapper objects (new Number/String/Boolean) and
// SharedArrayBuffer are rejected rather than silently corrupted.

export class CodecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CodecError';
  }
}

// A cycle presents as unbounded recursion; this turns that into a clear error.
// 512 is far deeper than any real capnweb frame and still safe on a default stack.
const MAX_DEPTH = 512;

const TYPED_ARRAYS = {
  Int8Array, Uint8Array, Uint8ClampedArray,
  Int16Array, Uint16Array,
  Int32Array, Uint32Array,
  Float32Array, Float64Array,
  BigInt64Array, BigUint64Array,
};

const ERROR_TYPES = { Error, TypeError, RangeError, ReferenceError, SyntaxError, EvalError, URIError };

// --- base64 over raw bytes, self-contained so neither Buffer nor btoa is needed.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INV = (() => {
  const inv = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64.length; i++) inv[B64.charCodeAt(i)] = i;
  return inv;
})();

function bytesToBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[b2 & 63] : '=';
  }
  return out;
}

function base64ToBytes(str) {
  let len = str.length;
  while (len > 0 && str[len - 1] === '=') len--;
  const out = new Uint8Array((len * 3) >> 2);
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < len; i++) {
    const v = B64_INV[str.charCodeAt(i)];
    if (v < 0) throw new CodecError('invalid base64 in encoded value');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

// --- encode: a real value -> a JSON-safe transit value.

/** Encode a structured-cloneable value into a JSON-safe transit form. */
export function encode(value) {
  return encodeNode(value, 0);
}

function encodeNode(value, depth) {
  if (depth > MAX_DEPTH) {
    throw new CodecError('value is too deeply nested (a cycle, or genuinely huge?)');
  }
  if (value === null) return null;

  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value;
    case 'number':
      // Finite numbers other than -0 are JSON-safe as-is; the rest need a tag.
      return Number.isFinite(value) && !Object.is(value, -0) ? value : { $t: 'n', v: numberTag(value) };
    case 'undefined':
      return { $t: 'u' };
    case 'bigint':
      return { $t: 'bi', v: value.toString() };
    case 'symbol':
      throw new CodecError('a symbol cannot cross the relay');
    case 'function':
      throw new CodecError('a function cannot cross the relay');
    default:
      return encodeObject(value, depth);
  }
}

function numberTag(value) {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  return '-0';
}

function encodeObject(value, depth) {
  if (Array.isArray(value)) {
    return value.map((item) => encodeNode(item, depth + 1));
  }
  if (value instanceof Date) {
    const t = value.getTime();
    return { $t: 'd', v: Number.isNaN(t) ? null : t };
  }
  if (value instanceof RegExp) {
    return { $t: 're', s: value.source, f: value.flags };
  }
  if (value instanceof Map) {
    const e = [];
    for (const [k, v] of value) e.push([encodeNode(k, depth + 1), encodeNode(v, depth + 1)]);
    return { $t: 'm', e };
  }
  if (value instanceof Set) {
    const e = [];
    for (const v of value) e.push(encodeNode(v, depth + 1));
    return { $t: 's', e };
  }
  if (value instanceof ArrayBuffer) {
    return { $t: 'ab', b: bytesToBase64(new Uint8Array(value)) };
  }
  if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) {
    throw new CodecError('SharedArrayBuffer cannot cross process boundaries over the relay');
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const b = bytesToBase64(bytes);
    if (value instanceof DataView) return { $t: 'dv', b };
    return { $t: 'ta', c: value.constructor.name, b };
  }
  if (value instanceof Error) {
    return encodeError(value, depth);
  }
  return encodePlainObject(value, depth);
}

function encodeError(value, depth) {
  const node = { $t: 'e', n: value.name, m: value.message, st: value.stack ?? null };
  if (value.cause !== undefined) node.c = encodeNode(value.cause, depth + 1);
  // Carry custom own-enumerable fields too (our own errors hang `.status` here),
  // skipping the standard ones already captured above.
  const extras = {};
  let hasExtras = false;
  for (const k of Object.keys(value)) {
    if (k === 'name' || k === 'message' || k === 'stack' || k === 'cause') continue;
    extras[k] = encodeNode(value[k], depth + 1);
    hasExtras = true;
  }
  if (hasExtras) node.x = extras;
  return node;
}

function encodePlainObject(value, depth) {
  const out = {};
  let collides = false;
  for (const k of Object.keys(value)) {
    if (k === '$t') collides = true;
    out[k] = encodeNode(value[k], depth + 1);
  }
  // A genuine data object with its own `$t` key would be indistinguishable from
  // one of our tags; escape it so the decoder restores it verbatim.
  return collides ? { $t: 'o', v: out } : out;
}

// --- decode: a JSON-safe transit value -> the original value.

/** Decode a transit form produced by `encode` back into the original value. */
export function decode(node) {
  return decodeNode(node, 0);
}

function decodeNode(node, depth) {
  if (depth > MAX_DEPTH) throw new CodecError('encoded value is too deeply nested');
  if (node === null) return null;
  if (typeof node !== 'object') return node; // string | number | boolean
  if (Array.isArray(node)) return node.map((item) => decodeNode(item, depth + 1));

  const tag = node.$t;
  if (tag === undefined) return decodePlainObject(node, depth);

  switch (tag) {
    case 'u': return undefined;
    case 'n': return numberFromTag(node.v);
    case 'bi': return BigInt(node.v);
    case 'd': return new Date(node.v === null ? NaN : node.v);
    case 're': return new RegExp(node.s, node.f);
    case 'm': {
      const map = new Map();
      for (const [k, v] of node.e) map.set(decodeNode(k, depth + 1), decodeNode(v, depth + 1));
      return map;
    }
    case 's': {
      const set = new Set();
      for (const v of node.e) set.add(decodeNode(v, depth + 1));
      return set;
    }
    case 'ab': return base64ToBytes(node.b).buffer;
    case 'dv': {
      const bytes = base64ToBytes(node.b);
      return new DataView(bytes.buffer, 0, bytes.length);
    }
    case 'ta': return decodeTypedArray(node);
    case 'e': return decodeError(node, depth);
    case 'o': return decodePlainObject(node.v, depth);
    default: throw new CodecError(`unknown encoded tag: ${JSON.stringify(tag)}`);
  }
}

function numberFromTag(v) {
  switch (v) {
    case 'nan': return NaN;
    case 'inf': return Infinity;
    case '-inf': return -Infinity;
    case '-0': return -0;
    default: throw new CodecError(`unknown number tag: ${JSON.stringify(v)}`);
  }
}

function decodeTypedArray(node) {
  const Ctor = TYPED_ARRAYS[node.c];
  if (!Ctor) throw new CodecError(`unknown typed array: ${JSON.stringify(node.c)}`);
  const bytes = base64ToBytes(node.b);
  if (bytes.byteLength % Ctor.BYTES_PER_ELEMENT !== 0) {
    throw new CodecError(`byte length ${bytes.byteLength} is not valid for ${node.c}`);
  }
  return new Ctor(bytes.buffer, 0, bytes.byteLength / Ctor.BYTES_PER_ELEMENT);
}

function decodeError(node, depth) {
  const Ctor = ERROR_TYPES[node.n] ?? Error;
  const err = new Ctor(node.m);
  if (Ctor === Error && node.n) err.name = node.n; // preserve a custom error name
  if (node.st !== null && node.st !== undefined) err.stack = node.st;
  if ('c' in node) err.cause = decodeNode(node.c, depth + 1);
  if (node.x) {
    for (const k of Object.keys(node.x)) err[k] = decodeNode(node.x[k], depth + 1);
  }
  return err;
}

function decodePlainObject(node, depth) {
  const out = {};
  for (const k of Object.keys(node)) out[k] = decodeNode(node[k], depth + 1);
  return out;
}
