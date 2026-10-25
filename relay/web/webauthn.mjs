// Shaping the two WebAuthn ceremonies, as pure data transforms.
//
// Nothing here touches `navigator` -- these functions turn the JSON the surface
// sends into the dictionary `navigator.credentials` demands, and turn the
// resulting PublicKeyCredential back into the JSON the surface expects. That
// split is what makes the fiddly half testable under `node --test`: the only
// thing left in login.mjs is the two `await navigator.credentials.*` calls and
// some fetches.
//
// The field names below are not invented. They are exactly the parameters of
// `Ceremonies.finishLogin` / `Ceremonies.finishEnrollment` in
// src/auth/ceremony.mjs, so the surface's HTTP layer is a base64url-decode of
// the four binary fields and a spread into the ceremony call -- no renaming,
// nothing to keep in sync.
//
// Direction of travel, which is the whole ballgame:
//
//   server JSON          base64url strings
//        |  decode  ->   ArrayBuffer         (challenge, user.id, credential ids)
//   navigator.credentials.get/create()
//        |  encode  ->   base64url strings   (clientDataJSON, signature, ...)
//   server JSON
//
// Note that `publicKey.challenge` from the surface is the *challengeId* itself
// (see Ceremonies.startLogin); its decoded bytes are what the authenticator
// signs, and the id is echoed back verbatim as `challengeId` so the server can
// find the pending challenge. One string, two jobs.

import { base64urlEncode, base64urlToArrayBuffer } from './base64url.mjs';

export class CeremonyShapeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CeremonyShapeError';
  }
}

function requirePublicKey(begun, what) {
  if (!begun || typeof begun !== 'object' || !begun.publicKey || typeof begun.publicKey !== 'object') {
    throw new CeremonyShapeError(`${what} response has no publicKey options`);
  }
  if (typeof begun.challengeId !== 'string' || begun.challengeId === '') {
    throw new CeremonyShapeError(`${what} response has no challengeId`);
  }
  return begun.publicKey;
}

/** `[{type, id: base64url}]` -> `[{type, id: ArrayBuffer}]`, preserving extras. */
function decodeDescriptors(list, field) {
  if (list == null) return undefined;
  if (!Array.isArray(list)) throw new CeremonyShapeError(`${field} must be an array`);
  return list.map((descriptor, index) => {
    if (!descriptor || typeof descriptor.id !== 'string') {
      throw new CeremonyShapeError(`${field}[${index}] has no base64url id`);
    }
    return { ...descriptor, id: base64urlToArrayBuffer(descriptor.id) };
  });
}

/**
 * Build the argument for `navigator.credentials.get()` from a login/begin body.
 * Returns the full `{ publicKey }` wrapper so the caller can hand the result
 * straight over without remembering to nest it.
 */
export function assertionRequestFrom(begun) {
  const options = requirePublicKey(begun, 'login/begin');
  if (typeof options.challenge !== 'string') {
    throw new CeremonyShapeError('login/begin publicKey.challenge must be a base64url string');
  }

  const publicKey = {
    ...options,
    challenge: base64urlToArrayBuffer(options.challenge),
  };
  const allowCredentials = decodeDescriptors(options.allowCredentials, 'allowCredentials');
  if (allowCredentials === undefined) delete publicKey.allowCredentials;
  else publicKey.allowCredentials = allowCredentials;

  return { publicKey };
}

/** Build the argument for `navigator.credentials.create()` from enroll/begin. */
export function creationRequestFrom(begun) {
  const options = requirePublicKey(begun, 'enroll/begin');
  if (typeof options.challenge !== 'string') {
    throw new CeremonyShapeError('enroll/begin publicKey.challenge must be a base64url string');
  }
  if (!options.user || typeof options.user.id !== 'string') {
    throw new CeremonyShapeError('enroll/begin publicKey.user.id must be a base64url string');
  }

  const publicKey = {
    ...options,
    challenge: base64urlToArrayBuffer(options.challenge),
    // The user handle is bytes too, and it is the field most often left as a
    // string -- Safari rejects the whole call when it is.
    user: { ...options.user, id: base64urlToArrayBuffer(options.user.id) },
  };
  const excludeCredentials = decodeDescriptors(options.excludeCredentials, 'excludeCredentials');
  if (excludeCredentials === undefined) delete publicKey.excludeCredentials;
  else publicKey.excludeCredentials = excludeCredentials;

  return { publicKey };
}

function requireBuffer(value, field) {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
  throw new CeremonyShapeError(`${field} is not a buffer (got ${value === null ? 'null' : typeof value})`);
}

/**
 * Re-encode a `navigator.credentials.get()` result into the login/finish body.
 * Shape matches Ceremonies.finishLogin exactly.
 */
export function assertionPayload(credential, { challengeId }) {
  if (!credential || typeof credential !== 'object') {
    throw new CeremonyShapeError('no credential was returned by the authenticator');
  }
  if (typeof challengeId !== 'string' || challengeId === '') {
    throw new CeremonyShapeError('challengeId must be echoed back as a string');
  }
  const response = credential.response;
  if (!response || typeof response !== 'object') {
    throw new CeremonyShapeError('credential has no response');
  }

  return {
    challengeId,
    // rawId rather than `.id`: both should be the same bytes, but `.id` is a
    // string the UA encoded and rawId is the authority.
    credentialId: base64urlEncode(requireBuffer(credential.rawId, 'credential.rawId')),
    authenticatorData: base64urlEncode(requireBuffer(response.authenticatorData, 'response.authenticatorData')),
    clientDataJSON: base64urlEncode(requireBuffer(response.clientDataJSON, 'response.clientDataJSON')),
    signature: base64urlEncode(requireBuffer(response.signature, 'response.signature')),
  };
}

/**
 * Re-encode a `navigator.credentials.create()` result into the enroll/finish
 * body. Note there is no credentialId here on purpose: the server lifts it out
 * of the attestation object, so sending one would be a claim it cannot trust.
 */
export function attestationPayload(credential, { challengeId, label } = {}) {
  if (!credential || typeof credential !== 'object') {
    throw new CeremonyShapeError('no credential was returned by the authenticator');
  }
  if (typeof challengeId !== 'string' || challengeId === '') {
    throw new CeremonyShapeError('challengeId must be echoed back as a string');
  }
  const response = credential.response;
  if (!response || typeof response !== 'object') {
    throw new CeremonyShapeError('credential has no response');
  }

  const payload = {
    challengeId,
    attestationObject: base64urlEncode(requireBuffer(response.attestationObject, 'response.attestationObject')),
    clientDataJSON: base64urlEncode(requireBuffer(response.clientDataJSON, 'response.clientDataJSON')),
  };
  if (typeof label === 'string' && label.trim() !== '') payload.label = label.trim();
  return payload;
}
