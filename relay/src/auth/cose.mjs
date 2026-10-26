// COSE_Key -> SubjectPublicKeyInfo (DER), so a WebAuthn credential public key can
// be imported straight into node:crypto for signature verification.
//
// A COSE_Key is a CBOR map with small integer labels. We cover the three key types
// that passkey authenticators actually mint: EC2/P-256 (ES256, the overwhelming
// default), OKP/Ed25519 (EdDSA), and RSA (RS256). Anything else is refused rather
// than guessed at -- an unknown key type verifying nothing is worse than a clear
// error.
//
// There is a deliberate choice to hand-roll a tiny DER encoder instead of pulling
// a library: it is a few well-understood TLV rules, it keeps the zero-dependency
// promise, and it keeps the trust-critical path readable.

import { CborError } from './cbor.mjs';

// COSE key common labels
const KTY = 1, ALG = 3;
// EC2 / OKP labels
const CRV = -1, X = -2, Y = -3;
// RSA labels
const RSA_N = -1, RSA_E = -2;

// kty values
const KTY_OKP = 1, KTY_EC2 = 2, KTY_RSA = 3;
// crv values
const CRV_P256 = 1, CRV_P384 = 2, CRV_P521 = 3, CRV_ED25519 = 6;

// COSE algorithm identifiers we accept
export const COSE_ALG = {
  ES256: -7,
  ES384: -35,
  ES512: -36,
  EdDSA: -8,
  RS256: -257,
  PS256: -37,
};

export class CoseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CoseError';
  }
}

// --- minimal DER ---------------------------------------------------------------

function derLength(n) {
  if (n < 0x80) return [n];
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>= 8; }
  return [0x80 | bytes.length, ...bytes];
}

function tlv(tag, content) {
  return Uint8Array.from([tag, ...derLength(content.length), ...content]);
}

function derSequence(...parts) {
  const body = concat(parts);
  return tlv(0x30, body);
}

function derBitString(bytes) {
  // 0 unused bits in the final octet.
  return tlv(0x03, concat([Uint8Array.of(0x00), bytes]));
}

function derNull() {
  return Uint8Array.of(0x05, 0x00);
}

function derInteger(bytes) {
  // Unsigned integer: strip leading zeros, then re-pad one zero if the top bit is
  // set so it is not read as negative.
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0x00) start++;
  let content = bytes.subarray(start);
  if (content[0] & 0x80) content = concat([Uint8Array.of(0x00), content]);
  return tlv(0x02, content);
}

function derOid(dotted) {
  const arcs = dotted.split('.').map(Number);
  const first = 40 * arcs[0] + arcs[1];
  const body = [first];
  for (const arc of arcs.slice(2)) {
    if (arc < 0x80) { body.push(arc); continue; }
    const chunk = [];
    let v = arc;
    chunk.unshift(v & 0x7f);
    v >>= 7;
    while (v > 0) { chunk.unshift((v & 0x7f) | 0x80); v >>= 7; }
    body.push(...chunk);
  }
  return tlv(0x06, Uint8Array.from(body));
}

function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

const OID_EC_PUBLIC_KEY = derOid('1.2.840.10045.2.1');
const OID_RSA_ENCRYPTION = derOid('1.2.840.113549.1.1.1');
const OID_ED25519 = derOid('1.3.101.112');
const CRV_OID = {
  [CRV_P256]: derOid('1.2.840.10045.3.1.7'),
  [CRV_P384]: derOid('1.3.132.0.34'),
  [CRV_P521]: derOid('1.3.132.0.35'),
};
const CRV_FIELD_BYTES = { [CRV_P256]: 32, [CRV_P384]: 48, [CRV_P521]: 66 };

function requireBytes(map, label, name) {
  const v = map.get(label);
  if (!(v instanceof Uint8Array)) throw new CoseError(`COSE key missing ${name}`);
  return v;
}

/**
 * Convert a decoded COSE_Key (a Map) into SPKI DER plus a verification descriptor.
 * @param {Map} cose
 * @returns {{ spki: Uint8Array, coseAlg: number, verify: object }}
 *   `verify` names what node:crypto needs: { kind, hash, dsaEncoding? }.
 */
export function coseToSpki(cose) {
  if (!(cose instanceof Map)) throw new CoseError('COSE key must be a CBOR map');
  const kty = cose.get(KTY);
  const alg = cose.get(ALG);
  if (typeof alg !== 'number') throw new CoseError('COSE key missing alg');

  if (kty === KTY_EC2) {
    const crv = cose.get(CRV);
    const oid = CRV_OID[crv];
    const fieldLen = CRV_FIELD_BYTES[crv];
    if (!oid) throw new CoseError(`unsupported EC2 curve ${crv}`);
    const x = requireBytes(cose, X, 'EC2 x');
    const y = requireBytes(cose, Y, 'EC2 y');
    if (x.length !== fieldLen || y.length !== fieldLen) {
      throw new CoseError('EC2 coordinate has wrong length for curve');
    }
    const point = concat([Uint8Array.of(0x04), x, y]); // uncompressed
    const spki = derSequence(
      derSequence(OID_EC_PUBLIC_KEY, oid),
      derBitString(point),
    );
    const hash = alg === COSE_ALG.ES384 ? 'sha384' : alg === COSE_ALG.ES512 ? 'sha512' : 'sha256';
    return { spki, coseAlg: alg, verify: { kind: 'ec', hash, dsaEncoding: 'der' } };
  }

  if (kty === KTY_OKP) {
    const crv = cose.get(CRV);
    if (crv !== CRV_ED25519) throw new CoseError(`unsupported OKP curve ${crv}`);
    const x = requireBytes(cose, X, 'OKP x');
    if (x.length !== 32) throw new CoseError('Ed25519 public key must be 32 bytes');
    const spki = derSequence(derSequence(OID_ED25519), derBitString(x));
    return { spki, coseAlg: alg, verify: { kind: 'ed25519' } };
  }

  if (kty === KTY_RSA) {
    const n = requireBytes(cose, RSA_N, 'RSA n');
    const e = requireBytes(cose, RSA_E, 'RSA e');
    const rsaPublicKey = derSequence(derInteger(n), derInteger(e));
    const spki = derSequence(
      derSequence(OID_RSA_ENCRYPTION, derNull()),
      derBitString(rsaPublicKey),
    );
    const padded = alg === COSE_ALG.PS256;
    return { spki, coseAlg: alg, verify: { kind: padded ? 'rsa-pss' : 'rsa', hash: 'sha256' } };
  }

  throw new CoseError(`unsupported COSE key type ${kty}`);
}

// Re-export so callers can catch either parser error as one family if they want.
export { CborError };
