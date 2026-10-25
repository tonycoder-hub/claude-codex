import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createPublicKey } from 'node:crypto';
import { verifyRegistration, verifyAssertion, WebAuthnError } from '../../src/auth/webauthn.mjs';
import { coseToSpki } from '../../src/auth/cose.mjs';
import { makeCredential, registrationResponse, assertionResponse } from './vectors.mjs';

const RP_ID = 'relay.example.ts.net';
const ORIGIN = 'https://relay.example.ts.net';

for (const alg of ['ES256', 'EdDSA', 'RS256']) {
  test(`${alg}: full register + assert round-trip`, () => {
    const credential = makeCredential({ alg });
    const regChallenge = new Uint8Array(randomBytes(32));

    const reg = verifyRegistration({
      ...registrationResponse({ credential, rpId: RP_ID, challenge: regChallenge, origin: ORIGIN }),
      expectedChallenge: regChallenge,
      expectedOrigin: ORIGIN,
      expectedRpId: RP_ID,
    });

    assert.deepEqual(reg.credentialId, credential.credentialId);
    assert.ok(reg.spki instanceof Uint8Array);
    assert.equal(reg.uv, true);

    const authChallenge = new Uint8Array(randomBytes(32));
    const result = verifyAssertion({
      ...assertionResponse({ credential, rpId: RP_ID, challenge: authChallenge, origin: ORIGIN, signCount: 5 }),
      expectedChallenge: authChallenge,
      expectedOrigin: ORIGIN,
      expectedRpId: RP_ID,
      credentialSpki: reg.spki,
      verifyDescriptor: reg.verify,
      storedSignCount: 0,
    });
    assert.equal(result.newSignCount, 5);
  });
}

test('COSE keys import cleanly into node:crypto', () => {
  for (const alg of ['ES256', 'EdDSA', 'RS256']) {
    const { coseKey } = makeCredential({ alg });
    const { spki } = coseToSpki(coseKey);
    const key = createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' });
    assert.equal(key.type, 'public');
  }
});

test('rejects a challenge mismatch at registration', () => {
  const credential = makeCredential({ alg: 'ES256' });
  const challenge = new Uint8Array(randomBytes(32));
  assert.throws(() => verifyRegistration({
    ...registrationResponse({ credential, rpId: RP_ID, challenge, origin: ORIGIN }),
    expectedChallenge: new Uint8Array(randomBytes(32)), // different
    expectedOrigin: ORIGIN,
    expectedRpId: RP_ID,
  }), /challenge mismatch/);
});

test('rejects a wrong origin', () => {
  const credential = makeCredential({ alg: 'ES256' });
  const challenge = new Uint8Array(randomBytes(32));
  assert.throws(() => verifyRegistration({
    ...registrationResponse({ credential, rpId: RP_ID, challenge, origin: 'https://evil.example' }),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    expectedRpId: RP_ID,
  }), /origin/);
});

test('rejects a wrong rpId (rpIdHash mismatch)', () => {
  const credential = makeCredential({ alg: 'ES256' });
  const challenge = new Uint8Array(randomBytes(32));
  assert.throws(() => verifyRegistration({
    ...registrationResponse({ credential, rpId: 'other.ts.net', challenge, origin: ORIGIN }),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    expectedRpId: RP_ID,
  }), /rpIdHash/);
});

test('requires user verification when asked', () => {
  const credential = makeCredential({ alg: 'ES256' });
  const challenge = new Uint8Array(randomBytes(32));
  assert.throws(() => verifyRegistration({
    ...registrationResponse({ credential, rpId: RP_ID, challenge, origin: ORIGIN, uv: false }),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    expectedRpId: RP_ID,
    requireUserVerification: true,
  }), /user verification/);
});

test('detects a signature-counter regression (clone)', () => {
  const credential = makeCredential({ alg: 'ES256' });
  const regChallenge = new Uint8Array(randomBytes(32));
  const reg = verifyRegistration({
    ...registrationResponse({ credential, rpId: RP_ID, challenge: regChallenge, origin: ORIGIN }),
    expectedChallenge: regChallenge, expectedOrigin: ORIGIN, expectedRpId: RP_ID,
  });
  const authChallenge = new Uint8Array(randomBytes(32));
  assert.throws(() => verifyAssertion({
    ...assertionResponse({ credential, rpId: RP_ID, challenge: authChallenge, origin: ORIGIN, signCount: 3 }),
    expectedChallenge: authChallenge, expectedOrigin: ORIGIN, expectedRpId: RP_ID,
    credentialSpki: reg.spki, verifyDescriptor: reg.verify,
    storedSignCount: 10, // stored is ahead -> regression
  }), /counter did not increase/);
});

test('rejects a tampered assertion signature', () => {
  const credential = makeCredential({ alg: 'ES256' });
  const regChallenge = new Uint8Array(randomBytes(32));
  const reg = verifyRegistration({
    ...registrationResponse({ credential, rpId: RP_ID, challenge: regChallenge, origin: ORIGIN }),
    expectedChallenge: regChallenge, expectedOrigin: ORIGIN, expectedRpId: RP_ID,
  });
  const authChallenge = new Uint8Array(randomBytes(32));
  const assertion = assertionResponse({ credential, rpId: RP_ID, challenge: authChallenge, origin: ORIGIN, signCount: 2 });
  assertion.signature[assertion.signature.length - 1] ^= 0xff; // flip a byte
  assert.throws(() => verifyAssertion({
    ...assertion,
    expectedChallenge: authChallenge, expectedOrigin: ORIGIN, expectedRpId: RP_ID,
    credentialSpki: reg.spki, verifyDescriptor: reg.verify, storedSignCount: 0,
  }), WebAuthnError);
});
