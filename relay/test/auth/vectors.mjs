// Build synthetic WebAuthn ceremony outputs from a locally generated key, so the
// verifier can be tested end-to-end with no browser and no authenticator. These
// are real signatures over real COSE keys -- the only thing "synthetic" is that we
// hold the private key instead of a phone's secure enclave.

import { generateKeyPairSync, createHash, sign as cryptoSign, randomBytes } from 'node:crypto';
import { encode as cborEncode } from '../../src/auth/cbor.mjs';
import { concatBytes } from '../../src/auth/bytes.mjs';

const b64urlToBytes = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(b).digest());
const jsonBytes = (obj) => new TextEncoder().encode(JSON.stringify(obj));
const b64url = (b) => Buffer.from(b).toString('base64url');

export function makeCredential({ alg = 'ES256' } = {}) {
  let keys, coseKey;
  const credentialId = new Uint8Array(randomBytes(20));

  if (alg === 'ES256') {
    keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = keys.publicKey.export({ format: 'jwk' });
    coseKey = new Map([[1, 2], [3, -7], [-1, 1], [-2, b64urlToBytes(jwk.x)], [-3, b64urlToBytes(jwk.y)]]);
  } else if (alg === 'EdDSA') {
    keys = generateKeyPairSync('ed25519');
    const jwk = keys.publicKey.export({ format: 'jwk' });
    coseKey = new Map([[1, 1], [3, -8], [-1, 6], [-2, b64urlToBytes(jwk.x)]]);
  } else if (alg === 'RS256') {
    keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = keys.publicKey.export({ format: 'jwk' });
    coseKey = new Map([[1, 3], [3, -257], [-1, b64urlToBytes(jwk.n)], [-2, b64urlToBytes(jwk.e)]]);
  } else {
    throw new Error(`unknown alg ${alg}`);
  }

  return { ...keys, coseKey, credentialId, alg };
}

function flagsByte({ up = true, uv = true, at = false, ed = false }) {
  return (up ? 0x01 : 0) | (uv ? 0x04 : 0) | (at ? 0x40 : 0) | (ed ? 0x80 : 0);
}

export function buildAuthData({ rpId, up = true, uv = true, signCount = 0, credential }) {
  const rpIdHash = sha256(new TextEncoder().encode(rpId));
  const flags = Uint8Array.of(flagsByte({ up, uv, at: !!credential }));
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, signCount);

  if (!credential) return concatBytes(rpIdHash, flags, count);

  const aaguid = new Uint8Array(16); // all zero: "no attestation" aaguid
  const idLen = new Uint8Array(2);
  new DataView(idLen.buffer).setUint16(0, credential.credentialId.length);
  const coseBytes = cborEncode(credential.coseKey);
  return concatBytes(rpIdHash, flags, count, aaguid, idLen, credential.credentialId, coseBytes);
}

export function registrationResponse({ credential, rpId, challenge, origin, uv = true }) {
  const authData = buildAuthData({ rpId, uv, signCount: 0, credential });
  const attestationObject = cborEncode(new Map([
    ['fmt', 'none'],
    ['attStmt', new Map()],
    ['authData', authData],
  ]));
  const clientDataJSON = jsonBytes({ type: 'webauthn.create', challenge: b64url(challenge), origin });
  return { attestationObject, clientDataJSON };
}

export function assertionResponse({ credential, rpId, challenge, origin, signCount = 1, uv = true }) {
  const authenticatorData = buildAuthData({ rpId, uv, signCount });
  const clientDataJSON = jsonBytes({ type: 'webauthn.get', challenge: b64url(challenge), origin });
  const clientDataHash = sha256(clientDataJSON);
  const signedData = concatBytes(authenticatorData, clientDataHash);

  let signature;
  if (credential.alg === 'ES256') {
    signature = cryptoSign('sha256', signedData, { key: credential.privateKey, dsaEncoding: 'der' });
  } else if (credential.alg === 'EdDSA') {
    signature = cryptoSign(null, signedData, credential.privateKey);
  } else if (credential.alg === 'RS256') {
    signature = cryptoSign('sha256', signedData, credential.privateKey);
  }
  return { authenticatorData, clientDataJSON, signature: new Uint8Array(signature) };
}
