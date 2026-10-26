// WebAuthn registration and assertion verification, from the raw ceremony outputs.
//
// The security model here is a single-user personal relay, and that shapes two
// deliberate choices:
//
//  - Attestation provenance is NOT a trust input. We parse the attestationObject
//    only to lift out the credential public key; we do not require a particular
//    authenticator vendor or validate an attestation certificate chain. The thing
//    that gates a new credential is the single-use bootstrap token at enrolment
//    (see store/session), and the thing that authenticates afterwards is the
//    assertion signature over our challenge bound to our rpId and origin. Demanding
//    attestation would add cert-chain machinery that protects against a threat this
//    deployment does not have.
//  - User verification defaults to required. A relay that can drive the resident
//    machine should want the phone's biometric/PIN on the login ceremony, not just
//    user presence.
//
// What IS checked, and must be: rpIdHash == SHA-256(rpId); clientData.type is the
// right ceremony; the challenge matches the one we issued; the origin matches
// exactly; UP (and UV when required) are set; and for assertions the signature
// verifies over authenticatorData || SHA-256(clientDataJSON) and the signature
// counter did not regress (clone detection).

import { createHash, createPublicKey, verify as cryptoVerify, constants as cryptoConstants } from 'node:crypto';
import { decode as cborDecode, decodeFirst as cborDecodeFirst } from './cbor.mjs';
import { coseToSpki } from './cose.mjs';
import { base64urlDecode, timingSafeEqual, toBytes } from './bytes.mjs';

export class WebAuthnError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebAuthnError';
  }
}

function sha256(bytes) {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

/** Parse the 37+ byte authenticatorData structure. */
export function parseAuthenticatorData(input) {
  const data = toBytes(input);
  if (data.length < 37) throw new WebAuthnError('authenticatorData too short');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const rpIdHash = data.subarray(0, 32);
  const flagsByte = data[32];
  const flags = {
    up: !!(flagsByte & 0x01),
    uv: !!(flagsByte & 0x04),
    be: !!(flagsByte & 0x08),
    bs: !!(flagsByte & 0x10),
    at: !!(flagsByte & 0x40),
    ed: !!(flagsByte & 0x80),
  };
  const signCount = view.getUint32(33);

  let offset = 37;
  let aaguid, credentialId, credentialPublicKeyCose;
  if (flags.at) {
    if (data.length < offset + 18) throw new WebAuthnError('attested credential data truncated');
    aaguid = data.subarray(offset, offset + 16);
    offset += 16;
    const credIdLen = view.getUint16(offset);
    offset += 2;
    if (data.length < offset + credIdLen) throw new WebAuthnError('credential id truncated');
    credentialId = data.subarray(offset, offset + credIdLen);
    offset += credIdLen;
    // The COSE key is the next CBOR item. decodeFirst reports how many bytes it
    // consumed, so credential-data parsing stays exact even when extension bytes
    // (ED flag) trail the key -- we never rely on "decode the rest".
    const rest = data.subarray(offset);
    const { value, length } = cborDecodeFirst(rest);
    credentialPublicKeyCose = value;
    offset += length;
  }

  return { rpIdHash, flags, signCount, aaguid, credentialId, credentialPublicKeyCose, rawLength: data.length, bytesConsumed: offset };
}

function parseClientData(clientDataJSON, { expectedType, expectedChallenge, expectedOrigin }) {
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(toBytes(clientDataJSON))); }
  catch { throw new WebAuthnError('clientDataJSON is not valid UTF-8 JSON'); }

  if (parsed.type !== expectedType) {
    throw new WebAuthnError(`clientData.type is ${parsed.type}, expected ${expectedType}`);
  }
  let challengeBytes;
  try { challengeBytes = base64urlDecode(parsed.challenge); }
  catch { throw new WebAuthnError('clientData.challenge is not valid base64url'); }
  if (!timingSafeEqual(challengeBytes, toBytes(expectedChallenge))) {
    throw new WebAuthnError('challenge mismatch');
  }
  if (parsed.origin !== expectedOrigin) {
    throw new WebAuthnError(`origin ${parsed.origin} does not match expected ${expectedOrigin}`);
  }
  return parsed;
}

/**
 * Verify a registration (navigator.credentials.create) response.
 * @returns {{ credentialId: Uint8Array, coseAlg: number, spki: Uint8Array,
 *             verify: object, signCount: number, aaguid: Uint8Array, fmt: string,
 *             uv: boolean, backupEligible: boolean, backupState: boolean }}
 */
export function verifyRegistration({
  attestationObject,
  clientDataJSON,
  expectedChallenge,
  expectedOrigin,
  expectedRpId,
  requireUserVerification = true,
}) {
  parseClientData(clientDataJSON, {
    expectedType: 'webauthn.create',
    expectedChallenge,
    expectedOrigin,
  });

  let att;
  try { att = cborDecode(attestationObject); }
  catch (err) { throw new WebAuthnError(`attestationObject is not valid CBOR: ${err.message}`); }
  if (!(att instanceof Map)) throw new WebAuthnError('attestationObject is not a map');

  const fmt = att.get('fmt');
  const authDataBytes = att.get('authData');
  if (!(authDataBytes instanceof Uint8Array)) throw new WebAuthnError('attestationObject missing authData');

  const authData = parseAuthenticatorData(authDataBytes);
  const expectedRpIdHash = sha256(toBytes(expectedRpId));
  if (!timingSafeEqual(authData.rpIdHash, expectedRpIdHash)) {
    throw new WebAuthnError('rpIdHash does not match expected rpId');
  }
  if (!authData.flags.up) throw new WebAuthnError('user presence flag not set');
  if (requireUserVerification && !authData.flags.uv) {
    throw new WebAuthnError('user verification required but not performed');
  }
  if (!authData.flags.at || !authData.credentialPublicKeyCose) {
    throw new WebAuthnError('no attested credential data present');
  }

  const { spki, coseAlg, verify } = coseToSpki(authData.credentialPublicKeyCose);

  return {
    credentialId: authData.credentialId,
    coseAlg,
    spki,
    verify,
    signCount: authData.signCount,
    aaguid: authData.aaguid,
    fmt: typeof fmt === 'string' ? fmt : 'unknown',
    uv: authData.flags.uv,
    backupEligible: authData.flags.be,
    backupState: authData.flags.bs,
  };
}

function nodeVerify(verifyDescriptor, signedData, spkiDer, signature) {
  const keyObject = createPublicKey({ key: Buffer.from(spkiDer), format: 'der', type: 'spki' });
  const sig = Buffer.from(toBytes(signature));
  const data = Buffer.from(toBytes(signedData));

  switch (verifyDescriptor.kind) {
    case 'ed25519':
      return cryptoVerify(null, data, keyObject, sig);
    case 'ec':
      return cryptoVerify(verifyDescriptor.hash, data, { key: keyObject, dsaEncoding: 'der' }, sig);
    case 'rsa':
      return cryptoVerify(verifyDescriptor.hash, data, keyObject, sig);
    case 'rsa-pss':
      return cryptoVerify(verifyDescriptor.hash, data, {
        key: keyObject,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
      }, sig);
    default:
      throw new WebAuthnError(`unknown verify kind ${verifyDescriptor.kind}`);
  }
}

/**
 * Verify an assertion (navigator.credentials.get) response.
 * @returns {{ newSignCount: number, uv: boolean }}
 */
export function verifyAssertion({
  authenticatorData,
  clientDataJSON,
  signature,
  expectedChallenge,
  expectedOrigin,
  expectedRpId,
  credentialSpki,
  verifyDescriptor,
  storedSignCount = 0,
  requireUserVerification = true,
}) {
  parseClientData(clientDataJSON, {
    expectedType: 'webauthn.get',
    expectedChallenge,
    expectedOrigin,
  });

  const authBytes = toBytes(authenticatorData);
  const authData = parseAuthenticatorData(authBytes);
  const expectedRpIdHash = sha256(toBytes(expectedRpId));
  if (!timingSafeEqual(authData.rpIdHash, expectedRpIdHash)) {
    throw new WebAuthnError('rpIdHash does not match expected rpId');
  }
  if (!authData.flags.up) throw new WebAuthnError('user presence flag not set');
  if (requireUserVerification && !authData.flags.uv) {
    throw new WebAuthnError('user verification required but not performed');
  }

  const clientDataHash = sha256(toBytes(clientDataJSON));
  const signedData = new Uint8Array(authBytes.length + clientDataHash.length);
  signedData.set(authBytes, 0);
  signedData.set(clientDataHash, authBytes.length);

  if (!nodeVerify(verifyDescriptor, signedData, credentialSpki, signature)) {
    throw new WebAuthnError('assertion signature verification failed');
  }

  // Clone detection: a counter that does not advance (when either side uses one)
  // means two authenticators share a credential.
  const newCount = authData.signCount;
  if (!(newCount === 0 && storedSignCount === 0) && newCount <= storedSignCount) {
    throw new WebAuthnError(`signature counter did not increase (${newCount} <= ${storedSignCount})`);
  }

  return { newSignCount: Math.max(newCount, storedSignCount), uv: authData.flags.uv };
}
