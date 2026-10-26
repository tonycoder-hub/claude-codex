// These tests drive the *real* Ceremonies class from src/auth, not a mock.
//
// That is deliberate. The shaping functions only have one job -- survive a
// round trip through a real authenticator and a real verifier -- and a mock
// server would happily accept a challenge we decoded wrongly. Here the
// assertion is signed over the exact ArrayBuffer we would have handed
// `navigator.credentials.get()`, and the verifier checks that signature against
// the challenge it issued. Any codec mistake anywhere in the chain fails these.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ceremonies } from '../../src/auth/ceremony.mjs';
import { CredentialStore, EphemeralStore } from '../../src/auth/store.mjs';
import { SessionManager } from '../../src/auth/session.mjs';
import { KeyRing, FileKeyStore } from '../../src/auth/keys.mjs';
import { base64urlDecode as serverDecode, base64urlEncode as serverEncode } from '../../src/auth/bytes.mjs';
import { makeCredential, registrationResponse, assertionResponse } from '../auth/vectors.mjs';

import {
  assertionRequestFrom,
  creationRequestFrom,
  assertionPayload,
  attestationPayload,
  CeremonyShapeError,
} from '../../web/webauthn.mjs';

const RP = { id: 'relay.example.ts.net', name: 'Codex Relay', origin: 'https://relay.example.ts.net' };

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-web-webauthn-'));
  const credentials = new CredentialStore(join(dir, 'credentials.json'));
  credentials.setRelyingParty(RP);
  const sessions = new SessionManager(new KeyRing(new FileKeyStore(join(dir, 'keyring.json'))));
  const ceremonies = new Ceremonies({
    credentials,
    challenges: new EphemeralStore(),
    bootstrapTokens: new EphemeralStore(),
    sessions,
  });
  return { ceremonies, credentials };
}

/** A stand-in for PublicKeyCredential: every binary field a real ArrayBuffer. */
function publicKeyCredential({ rawId, response }) {
  const toBuffer = (u8) => u8.slice().buffer;
  const out = { type: 'public-key', rawId: toBuffer(rawId), id: serverEncode(rawId), response: {} };
  for (const [key, value] of Object.entries(response)) out.response[key] = toBuffer(value);
  return out;
}

/**
 * What the surface's HTTP layer does with a finish body: decode the binary
 * fields from base64url and hand the rest to the ceremony untouched. Written
 * out here so the test proves the browser payload needs no renaming.
 */
function decodeFinishBody(body, binaryFields) {
  const out = { ...body };
  for (const field of binaryFields) out[field] = serverDecode(body[field]);
  return out;
}

test('enrolment options from the real server decode into buffers the UA will accept', () => {
  const { ceremonies } = harness();
  const begun = ceremonies.startEnrollment({ bootstrapToken: ceremonies.issueBootstrapToken() });

  const request = creationRequestFrom(begun);
  const { publicKey } = request;

  assert.ok(publicKey.challenge instanceof ArrayBuffer, 'challenge must be an ArrayBuffer');
  assert.ok(publicKey.user.id instanceof ArrayBuffer, 'user.id must be an ArrayBuffer');
  // The challenge bytes must be the decoding of the challengeId, because that
  // is what the server will compare the signed clientData against.
  assert.deepEqual(new Uint8Array(publicKey.challenge), serverDecode(begun.challengeId));
  assert.deepEqual(new Uint8Array(publicKey.user.id), new TextEncoder().encode('codex-relay-owner'));

  // Non-binary options are passed through verbatim; the UA needs them as-is.
  assert.deepEqual(publicKey.rp, { id: RP.id, name: RP.name });
  assert.deepEqual(publicKey.pubKeyCredParams, begun.publicKey.pubKeyCredParams);
  assert.equal(publicKey.attestation, 'none');
  assert.equal(publicKey.timeout, begun.publicKey.timeout);
  assert.equal(publicKey.authenticatorSelection.userVerification, 'required');
  assert.deepEqual(publicKey.excludeCredentials, [], 'empty on a fresh relay, but present');
});

test('excludeCredentials ids become buffers, so the UA can grey out known keys', () => {
  const { ceremonies } = harness();
  const first = makeCredential({ alg: 'ES256' });
  const bootstrap = ceremonies.issueBootstrapToken();
  const started = ceremonies.startEnrollment({ bootstrapToken: bootstrap });
  const response = registrationResponse({
    credential: first,
    rpId: RP.id,
    challenge: serverDecode(started.challengeId),
    origin: RP.origin,
  });
  const enrolled = ceremonies.finishEnrollment({ challengeId: started.challengeId, ...response, label: 'phone' });

  const again = ceremonies.startEnrollment({ sessionToken: enrolled.sessionToken });
  const { publicKey } = creationRequestFrom(again);
  assert.equal(publicKey.excludeCredentials.length, 1);
  assert.ok(publicKey.excludeCredentials[0].id instanceof ArrayBuffer);
  assert.equal(publicKey.excludeCredentials[0].type, 'public-key');
  assert.deepEqual(new Uint8Array(publicKey.excludeCredentials[0].id), first.credentialId);
});

test('a full enrolment round trip through the browser shaping is accepted', () => {
  const { ceremonies } = harness();
  const credential = makeCredential({ alg: 'ES256' });
  const begun = ceremonies.startEnrollment({ bootstrapToken: ceremonies.issueBootstrapToken() });

  // Sign over the buffer the browser would actually have passed in.
  const { publicKey } = creationRequestFrom(begun);
  const response = registrationResponse({
    credential,
    rpId: RP.id,
    challenge: new Uint8Array(publicKey.challenge),
    origin: RP.origin,
  });
  const fromUA = publicKeyCredential({ rawId: credential.credentialId, response });

  const body = attestationPayload(fromUA, { challengeId: begun.challengeId, label: '  phone  ' });
  assert.deepEqual(Object.keys(body).sort(), ['attestationObject', 'challengeId', 'clientDataJSON', 'label']);
  assert.equal(body.label, 'phone', 'label is trimmed');
  assert.equal(typeof body.attestationObject, 'string');
  assert.equal(body.credentialId, undefined, 'the server derives this from the attestation itself');

  const result = ceremonies.finishEnrollment(decodeFinishBody(body, ['attestationObject', 'clientDataJSON']));
  assert.equal(result.credentialId, serverEncode(credential.credentialId));
  assert.ok(result.sessionToken, 'enrolment yields a session');
  assert.equal(ceremonies.isEnrolled, true);
});

test('a full login round trip through the browser shaping verifies', () => {
  const { ceremonies } = harness();
  const credential = makeCredential({ alg: 'ES256' });
  const enrolBegun = ceremonies.startEnrollment({ bootstrapToken: ceremonies.issueBootstrapToken() });
  ceremonies.finishEnrollment({
    challengeId: enrolBegun.challengeId,
    ...registrationResponse({
      credential,
      rpId: RP.id,
      challenge: new Uint8Array(creationRequestFrom(enrolBegun).publicKey.challenge),
      origin: RP.origin,
    }),
    label: 'phone',
  });

  const begun = ceremonies.startLogin();
  const { publicKey } = assertionRequestFrom(begun);
  assert.ok(publicKey.challenge instanceof ArrayBuffer);
  assert.equal(publicKey.rpId, RP.id);
  assert.equal(publicKey.userVerification, 'required');
  assert.equal(publicKey.allowCredentials.length, 1);
  assert.ok(publicKey.allowCredentials[0].id instanceof ArrayBuffer, 'allowCredentials ids must be buffers');
  assert.deepEqual(new Uint8Array(publicKey.allowCredentials[0].id), credential.credentialId);

  const response = assertionResponse({
    credential,
    rpId: RP.id,
    challenge: new Uint8Array(publicKey.challenge),
    origin: RP.origin,
    signCount: 7,
  });
  const fromUA = publicKeyCredential({ rawId: credential.credentialId, response });

  const body = assertionPayload(fromUA, { challengeId: begun.challengeId });
  assert.deepEqual(
    Object.keys(body).sort(),
    ['authenticatorData', 'challengeId', 'clientDataJSON', 'credentialId', 'signature'],
    'exactly the parameters finishLogin takes, no renaming needed',
  );
  for (const field of ['authenticatorData', 'clientDataJSON', 'signature', 'credentialId']) {
    assert.match(body[field], /^[A-Za-z0-9_-]+$/, `${field} must be base64url on the wire`);
  }

  const result = ceremonies.finishLogin(
    decodeFinishBody(body, ['authenticatorData', 'clientDataJSON', 'signature']),
  );
  assert.ok(result.sessionToken, 'login yields a session');
  assert.equal(result.label, 'phone');
  assert.equal(ceremonies.authenticate(result.sessionToken).sub, serverEncode(credential.credentialId));
});

test('login round-trips for every algorithm the relay advertises', () => {
  for (const alg of ['ES256', 'EdDSA', 'RS256']) {
    const { ceremonies } = harness();
    const credential = makeCredential({ alg });
    const enrolBegun = ceremonies.startEnrollment({ bootstrapToken: ceremonies.issueBootstrapToken() });
    ceremonies.finishEnrollment({
      challengeId: enrolBegun.challengeId,
      ...registrationResponse({
        credential,
        rpId: RP.id,
        challenge: new Uint8Array(creationRequestFrom(enrolBegun).publicKey.challenge),
        origin: RP.origin,
      }),
      label: alg,
    });

    const begun = ceremonies.startLogin();
    const { publicKey } = assertionRequestFrom(begun);
    const fromUA = publicKeyCredential({
      rawId: credential.credentialId,
      response: assertionResponse({
        credential,
        rpId: RP.id,
        challenge: new Uint8Array(publicKey.challenge),
        origin: RP.origin,
      }),
    });
    const body = assertionPayload(fromUA, { challengeId: begun.challengeId });
    const result = ceremonies.finishLogin(
      decodeFinishBody(body, ['authenticatorData', 'clientDataJSON', 'signature']),
    );
    assert.ok(result.sessionToken, `${alg} must verify`);
  }
});

test('a challenge mangled on the way in is caught by the verifier, not ignored', () => {
  // Guards the test itself: if the round-trip tests above passed because the
  // verifier is lax rather than because the codec is right, this would pass too.
  const { ceremonies } = harness();
  const credential = makeCredential({ alg: 'ES256' });
  const enrolBegun = ceremonies.startEnrollment({ bootstrapToken: ceremonies.issueBootstrapToken() });
  ceremonies.finishEnrollment({
    challengeId: enrolBegun.challengeId,
    ...registrationResponse({
      credential,
      rpId: RP.id,
      challenge: serverDecode(enrolBegun.challengeId),
      origin: RP.origin,
    }),
    label: 'phone',
  });

  const begun = ceremonies.startLogin();
  const wrong = serverDecode(begun.challengeId);
  wrong[0] ^= 0xff;
  const fromUA = publicKeyCredential({
    rawId: credential.credentialId,
    response: assertionResponse({ credential, rpId: RP.id, challenge: wrong, origin: RP.origin }),
  });
  const body = assertionPayload(fromUA, { challengeId: begun.challengeId });
  assert.throws(
    () => ceremonies.finishLogin(decodeFinishBody(body, ['authenticatorData', 'clientDataJSON', 'signature'])),
    /challenge/i,
    'one flipped challenge byte must be fatal',
  );
});

test('allowCredentials is omitted rather than sent empty when absent', () => {
  // Discoverable-credential logins send no allowCredentials at all; an empty
  // array is not the same thing to a UA, so the key must disappear.
  const { publicKey } = assertionRequestFrom({
    challengeId: 'QUJD',
    publicKey: { rpId: 'relay.example.ts.net', challenge: 'QUJD', userVerification: 'required' },
  });
  assert.equal('allowCredentials' in publicKey, false);
  assert.deepEqual(new Uint8Array(publicKey.challenge), Uint8Array.from([0x41, 0x42, 0x43]));
});

test('malformed server options and malformed UA results are rejected, not guessed', () => {
  assert.throws(() => assertionRequestFrom(null), CeremonyShapeError);
  assert.throws(() => assertionRequestFrom({}), /no publicKey options/);
  assert.throws(() => assertionRequestFrom({ publicKey: { challenge: 'QUJD' } }), /no challengeId/);
  assert.throws(() => assertionRequestFrom({ challengeId: 'x', publicKey: {} }), /challenge must be a base64url string/);
  assert.throws(
    () => assertionRequestFrom({ challengeId: 'x', publicKey: { challenge: 'QUJD', allowCredentials: [{}] } }),
    /allowCredentials\[0\] has no base64url id/,
  );
  assert.throws(
    () => creationRequestFrom({ challengeId: 'x', publicKey: { challenge: 'QUJD' } }),
    /user\.id must be a base64url string/,
  );

  // A cancelled ceremony resolves with null in some UAs; that must not become
  // a payload full of "undefined" strings.
  assert.throws(() => assertionPayload(null, { challengeId: 'x' }), /no credential was returned/);
  assert.throws(() => attestationPayload(null, { challengeId: 'x' }), /no credential was returned/);
  assert.throws(() => assertionPayload({ rawId: new ArrayBuffer(4) }, { challengeId: 'x' }), /no response/);
  assert.throws(
    () => assertionPayload({ rawId: 'oops', response: {} }, { challengeId: 'x' }),
    /credential\.rawId is not a buffer/,
  );
  assert.throws(
    () => assertionPayload({ rawId: new ArrayBuffer(4), response: { authenticatorData: new ArrayBuffer(1) } }, { challengeId: 'x' }),
    /response\.clientDataJSON is not a buffer/,
  );
  assert.throws(
    () => attestationPayload({ rawId: new ArrayBuffer(4), response: {} }, { challengeId: '' }),
    /challengeId must be echoed back/,
  );
});

test('a label is only sent when the user actually typed one', () => {
  const fromUA = publicKeyCredential({
    rawId: Uint8Array.from([1, 2, 3]),
    response: { attestationObject: Uint8Array.from([4, 5, 6]), clientDataJSON: Uint8Array.from([7, 8]) },
  });
  assert.equal('label' in attestationPayload(fromUA, { challengeId: 'x' }), false);
  assert.equal('label' in attestationPayload(fromUA, { challengeId: 'x', label: '   ' }), false);
  assert.equal(attestationPayload(fromUA, { challengeId: 'x', label: 'iPhone' }).label, 'iPhone');
});
