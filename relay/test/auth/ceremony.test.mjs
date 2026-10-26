import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ceremonies, CeremonyError } from '../../src/auth/ceremony.mjs';
import { CredentialStore, EphemeralStore } from '../../src/auth/store.mjs';
import { SessionManager } from '../../src/auth/session.mjs';
import { KeyRing, FileKeyStore } from '../../src/auth/keys.mjs';
import { base64urlDecode } from '../../src/auth/bytes.mjs';
import { makeCredential, registrationResponse, assertionResponse } from './vectors.mjs';

const RP = { id: 'relay.example.ts.net', name: 'Codex Relay', origin: 'https://relay.example.ts.net' };

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-ceremony-'));
  const credentials = new CredentialStore(join(dir, 'credentials.json'));
  credentials.setRelyingParty(RP);
  const sessions = new SessionManager(new KeyRing(new FileKeyStore(join(dir, 'keyring.json'))));
  const ceremonies = new Ceremonies({
    credentials,
    challenges: new EphemeralStore(),
    bootstrapTokens: new EphemeralStore(),
    sessions,
  });
  return { ceremonies, credentials, sessions };
}

/** Run a full enrolment the way a browser would, returning the session token. */
function enroll(ceremonies, { bootstrapToken, sessionToken, credential, label }) {
  const started = ceremonies.startEnrollment({ bootstrapToken, sessionToken });
  const response = registrationResponse({
    credential,
    rpId: RP.id,
    challenge: base64urlDecode(started.challengeId),
    origin: RP.origin,
  });
  return ceremonies.finishEnrollment({ challengeId: started.challengeId, ...response, label });
}

function login(ceremonies, credential, { signCount = 1 } = {}) {
  const started = ceremonies.startLogin();
  const response = assertionResponse({
    credential,
    rpId: RP.id,
    challenge: base64urlDecode(started.challengeId),
    origin: RP.origin,
    signCount,
  });
  return ceremonies.finishLogin({
    challengeId: started.challengeId,
    credentialId: Buffer.from(credential.credentialId).toString('base64url'),
    ...response,
  });
}

test('enrolment needs an authorisation and an empty store is not one', () => {
  const { ceremonies } = harness();
  assert.equal(ceremonies.isEnrolled, false);
  assert.throws(() => ceremonies.startEnrollment(), /bootstrap link or an existing session/);
  assert.throws(() => ceremonies.startEnrollment({ bootstrapToken: 'made-up' }), /expired or been used/);
});

test('a bootstrap token enrols the first device and returns a session', () => {
  const { ceremonies } = harness();
  const token = ceremonies.issueBootstrapToken();
  const credential = makeCredential({ alg: 'ES256' });

  const { credentialId, sessionToken } = enroll(ceremonies, { bootstrapToken: token, credential, label: 'phone' });
  assert.ok(credentialId);
  assert.equal(ceremonies.isEnrolled, true);
  assert.equal(ceremonies.authenticate(sessionToken).sub, credentialId);
});

test('a bootstrap token survives a cancelled ceremony but burns on success', () => {
  const { ceremonies } = harness();
  const token = ceremonies.issueBootstrapToken();

  // User taps the link, then cancels Face ID. The token must still work.
  ceremonies.startEnrollment({ bootstrapToken: token });
  ceremonies.startEnrollment({ bootstrapToken: token });

  enroll(ceremonies, { bootstrapToken: token, credential: makeCredential({ alg: 'ES256' }) });

  assert.throws(
    () => ceremonies.startEnrollment({ bootstrapToken: token }),
    /expired or been used/,
    'the token must be single-use once a credential actually exists',
  );
});

test('an existing session can enrol a second device', () => {
  const { ceremonies } = harness();
  const first = enroll(ceremonies, {
    bootstrapToken: ceremonies.issueBootstrapToken(),
    credential: makeCredential({ alg: 'ES256' }),
    label: 'phone',
  });

  const second = enroll(ceremonies, {
    sessionToken: first.sessionToken,
    credential: makeCredential({ alg: 'EdDSA' }),
    label: 'laptop',
  });

  assert.notEqual(second.credentialId, first.credentialId);
  assert.equal(ceremonies.authenticate(second.sessionToken).credential.label, 'laptop');
});

test('already-enrolled keys are advertised in excludeCredentials', () => {
  const { ceremonies } = harness();
  const first = enroll(ceremonies, {
    bootstrapToken: ceremonies.issueBootstrapToken(),
    credential: makeCredential({ alg: 'ES256' }),
  });
  const started = ceremonies.startEnrollment({ sessionToken: first.sessionToken });
  assert.deepEqual(started.publicKey.excludeCredentials.map((c) => c.id), [first.credentialId]);
  assert.equal(started.publicKey.authenticatorSelection.userVerification, 'required');
});

test('login round-trips and advances the signature counter', () => {
  const { ceremonies, credentials } = harness();
  const credential = makeCredential({ alg: 'ES256' });
  const { credentialId } = enroll(ceremonies, { bootstrapToken: ceremonies.issueBootstrapToken(), credential, label: 'phone' });

  const result = login(ceremonies, credential, { signCount: 4 });
  assert.equal(result.label, 'phone');
  assert.equal(credentials.findByCredentialId(credentialId).signCount, 4);

  // A replayed assertion (same counter) must be refused as a clone.
  assert.throws(() => login(ceremonies, credential, { signCount: 4 }), /counter did not increase/);
});

test('challenges are single-use and purpose-bound', () => {
  const { ceremonies } = harness();
  const credential = makeCredential({ alg: 'ES256' });
  enroll(ceremonies, { bootstrapToken: ceremonies.issueBootstrapToken(), credential });

  const started = ceremonies.startLogin();
  const response = assertionResponse({
    credential, rpId: RP.id, challenge: base64urlDecode(started.challengeId), origin: RP.origin, signCount: 9,
  });
  const args = {
    challengeId: started.challengeId,
    credentialId: Buffer.from(credential.credentialId).toString('base64url'),
    ...response,
  };
  ceremonies.finishLogin(args);
  assert.throws(() => ceremonies.finishLogin(args), /unknown or expired login challenge/);

  // A login challenge must not be usable to complete an enrolment.
  const loginChallenge = ceremonies.startLogin().challengeId;
  assert.throws(() => ceremonies.finishEnrollment({
    challengeId: loginChallenge,
    ...registrationResponse({
      credential: makeCredential({ alg: 'ES256' }), rpId: RP.id,
      challenge: base64urlDecode(loginChallenge), origin: RP.origin,
    }),
  }), /unknown or expired enrolment challenge/);
});

test('login is refused before anything is enrolled', () => {
  const { ceremonies } = harness();
  assert.throws(() => ceremonies.startLogin(), /no passkey is enrolled/);
});

test('an unknown credential id is refused at login', () => {
  const { ceremonies } = harness();
  const enrolled = makeCredential({ alg: 'ES256' });
  enroll(ceremonies, { bootstrapToken: ceremonies.issueBootstrapToken(), credential: enrolled });

  const stranger = makeCredential({ alg: 'ES256' });
  assert.throws(() => login(ceremonies, stranger), /unknown credential/);
});

test('removing a credential immediately invalidates its sessions', () => {
  const { ceremonies, credentials } = harness();
  const credential = makeCredential({ alg: 'ES256' });
  const { credentialId, sessionToken } = enroll(ceremonies, {
    bootstrapToken: ceremonies.issueBootstrapToken(), credential,
  });
  assert.ok(ceremonies.authenticate(sessionToken));

  credentials.removeCredential(credentialId);
  assert.throws(() => ceremonies.authenticate(sessionToken), /was removed/);
});

test('a session from a removed credential cannot enrol a new device', () => {
  const { ceremonies, credentials } = harness();
  const credential = makeCredential({ alg: 'ES256' });
  const { credentialId, sessionToken } = enroll(ceremonies, {
    bootstrapToken: ceremonies.issueBootstrapToken(), credential,
  });
  credentials.removeCredential(credentialId);
  assert.throws(
    () => ceremonies.startEnrollment({ sessionToken }),
    /has been removed/,
    'a revoked device must not be able to bootstrap itself back in',
  );
});

test('errors carry an HTTP status for the transport layer', () => {
  const { ceremonies } = harness();
  try {
    ceremonies.startEnrollment();
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof CeremonyError);
    assert.equal(err.status, 403);
  }
});

test('an unconfigured relying party is a 503, not a crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-ceremony-'));
  const credentials = new CredentialStore(join(dir, 'credentials.json')); // no setRelyingParty
  const ceremonies = new Ceremonies({
    credentials,
    challenges: new EphemeralStore(),
    bootstrapTokens: new EphemeralStore(),
    sessions: new SessionManager(new KeyRing(new FileKeyStore(join(dir, 'k.json')))),
  });
  try {
    ceremonies.startEnrollment({ bootstrapToken: ceremonies.issueBootstrapToken() });
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.status, 503);
  }
});
