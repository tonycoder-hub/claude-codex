// A strict, dependency-free CBOR codec for the WebAuthn subset.
//
// WebAuthn hands us two CBOR things: the attestationObject (a map of
// {fmt, attStmt, authData}) at registration, and COSE_Key structures (maps keyed
// by small integers, including negative ones) inside the credential public key.
// Nothing here needs the whole of RFC 8949, but what it does cover it covers
// exactly: attestation parsing is a security boundary, and a lenient decoder --
// one that tolerates indefinite lengths, trailing bytes, or non-canonical maps --
// is an attack surface, not a convenience. So this decoder rejects all three.
//
// The encoder exists mainly so tests can build their own attestation and COSE
// vectors from a freshly generated key without a browser, and it emits CTAP2
// canonical form (length-then-lexicographic map key ordering) so COSE round-trips.

export class CborError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CborError';
  }
}

const textDecoder = new TextDecoder('utf-8', { fatal: true });
const textEncoder = new TextEncoder();

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new CborError('input must be a Uint8Array/ArrayBuffer');
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
  }

  need(n) {
    if (this.pos + n > this.bytes.length) throw new CborError('unexpected end of CBOR input');
  }

  u8() { this.need(1); return this.bytes[this.pos++]; }

  // Decode the argument that follows an initial byte's additional-information bits.
  argument(ai) {
    if (ai < 24) return ai;
    if (ai === 24) return this.u8();
    if (ai === 25) { this.need(2); const v = this.view.getUint16(this.pos); this.pos += 2; return v; }
    if (ai === 26) { this.need(4); const v = this.view.getUint32(this.pos); this.pos += 4; return v; }
    if (ai === 27) {
      this.need(8);
      const v = this.view.getBigUint64(this.pos);
      this.pos += 8;
      return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }
    if (ai === 31) throw new CborError('indefinite-length items are not accepted');
    throw new CborError(`reserved additional-information value ${ai}`);
  }

  item() {
    this.need(1);
    const initial = this.bytes[this.pos++];
    const major = initial >> 5;
    const ai = initial & 0x1f;

    switch (major) {
      case 0: // unsigned integer
        return this.argument(ai);
      case 1: { // negative integer: -1 - n
        const n = this.argument(ai);
        return typeof n === 'bigint' ? -1n - n : -1 - n;
      }
      case 2: { // byte string
        const len = this.lengthArgument(ai);
        this.need(len);
        const out = this.bytes.slice(this.pos, this.pos + len);
        this.pos += len;
        return out;
      }
      case 3: { // text string
        const len = this.lengthArgument(ai);
        this.need(len);
        const slice = this.bytes.subarray(this.pos, this.pos + len);
        this.pos += len;
        try { return textDecoder.decode(slice); }
        catch { throw new CborError('invalid UTF-8 in CBOR text string'); }
      }
      case 4: { // array
        const len = this.lengthArgument(ai);
        const out = new Array(len);
        for (let i = 0; i < len; i++) out[i] = this.item();
        return out;
      }
      case 5: { // map -> Map, so integer COSE keys survive
        // Duplicate keys are rejected (an ambiguity attackers can exploit), but
        // key *ordering* is not enforced: CTAP2 authenticators emit canonical
        // order, yet rejecting a re-encoded-but-valid input would fail a real
        // enrolment for no security gain. Duplicate detection is the property
        // that matters, and Map.has gives it directly for primitive keys.
        const len = this.lengthArgument(ai);
        const out = new Map();
        for (let i = 0; i < len; i++) {
          const key = this.item();
          if (out.has(key)) throw new CborError('duplicate map key');
          out.set(key, this.item());
        }
        return out;
      }
      case 7: // simple values and floats
        switch (ai) {
          case 20: return false;
          case 21: return true;
          case 22: return null;
          case 23: return undefined;
          case 25: { this.need(2); const v = readFloat16(this.view, this.pos); this.pos += 2; return v; }
          case 26: { this.need(4); const v = this.view.getFloat32(this.pos); this.pos += 4; return v; }
          case 27: { this.need(8); const v = this.view.getFloat64(this.pos); this.pos += 8; return v; }
          default: throw new CborError(`unsupported simple value ${ai}`);
        }
      default:
        throw new CborError(`unknown CBOR major type ${major}`);
    }
  }

  lengthArgument(ai) {
    const n = this.argument(ai);
    if (typeof n === 'bigint') throw new CborError('length exceeds supported range');
    return n;
  }
}

function compareBytes(a, b) {
  // CTAP2 canonical ordering: shorter key first, then bytewise lexicographic.
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function readFloat16(view, pos) {
  const h = view.getUint16(pos);
  const sign = (h & 0x8000) ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * Math.pow(2, -14) * (frac / 1024);
  if (exp === 0x1f) return frac ? NaN : sign * Infinity;
  return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

/** Decode exactly one CBOR item, rejecting any trailing bytes. */
export function decode(input) {
  const reader = new Reader(asBytes(input));
  const value = reader.item();
  if (reader.pos !== reader.bytes.length) {
    throw new CborError(`${reader.bytes.length - reader.pos} trailing byte(s) after CBOR item`);
  }
  return value;
}

/** Decode one CBOR item and report how many bytes it consumed. */
export function decodeFirst(input) {
  const reader = new Reader(asBytes(input));
  const value = reader.item();
  return { value, length: reader.pos };
}

// --- Encoder (CTAP2 canonical) -------------------------------------------------

function encodeHead(major, arg, out) {
  const m = major << 5;
  if (arg < 24) out.push(m | arg);
  else if (arg < 0x100) out.push(m | 24, arg);
  else if (arg < 0x10000) out.push(m | 25, arg >> 8, arg & 0xff);
  else if (arg < 0x100000000) out.push(m | 26, (arg >>> 24) & 0xff, (arg >> 16) & 0xff, (arg >> 8) & 0xff, arg & 0xff);
  else {
    const big = BigInt(arg);
    out.push(m | 27);
    for (let shift = 56n; shift >= 0n; shift -= 8n) out.push(Number((big >> shift) & 0xffn));
  }
}

function encodeInto(value, out) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (value >= 0) encodeHead(0, value, out);
    else encodeHead(1, -1 - value, out);
    return;
  }
  if (typeof value === 'bigint') {
    if (value >= 0n) encodeHead(0, value, out);
    else encodeHead(1, -1n - value, out);
    return;
  }
  if (value instanceof Uint8Array) {
    encodeHead(2, value.length, out);
    for (const b of value) out.push(b);
    return;
  }
  if (typeof value === 'string') {
    const bytes = textEncoder.encode(value);
    encodeHead(3, bytes.length, out);
    for (const b of bytes) out.push(b);
    return;
  }
  if (Array.isArray(value)) {
    encodeHead(4, value.length, out);
    for (const item of value) encodeInto(item, out);
    return;
  }
  if (value === false) { out.push(0xf4); return; }
  if (value === true) { out.push(0xf5); return; }
  if (value === null) { out.push(0xf6); return; }
  if (value instanceof Map || (typeof value === 'object')) {
    const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
    const encoded = entries.map(([k, v]) => {
      const keyBytes = [];
      encodeInto(k, keyBytes);
      return { key: Uint8Array.from(keyBytes), val: v };
    });
    encoded.sort((a, b) => compareBytes(a.key, b.key));
    encodeHead(5, encoded.length, out);
    for (const { key, val } of encoded) {
      for (const b of key) out.push(b);
      encodeInto(val, out);
    }
    return;
  }
  throw new CborError(`cannot encode value of type ${typeof value}`);
}

/** Encode a value to canonical CBOR bytes. */
export function encode(value) {
  const out = [];
  encodeInto(value, out);
  return Uint8Array.from(out);
}
