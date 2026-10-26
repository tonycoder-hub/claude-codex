import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Ceremonies } from '../../src/auth/ceremony.mjs';
import { CredentialStore, EphemeralStore } from '../../src/auth/store.mjs';
import { SessionManager } from '../../src/auth/session.mjs';
import { KeyRing, FileKeyStore } from '../../src/auth/keys.mjs';
import { base64urlDecode } from '../../src/auth/bytes.mjs';
import { makeCredential, registrationResponse, assertionResponse } from '../auth/vectors.mjs';
import { startSurface, tempDir, rawHandshake, fakeUpstream } from './harness.mjs';

const RP = { id: 'relay.example.ts.net', name: 'Codex Relay', origin: 'https://relay.example.ts.net' };
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

/** The ceremonies, mounted on a surface, exactly as production wires them. */
async function surfaceWithAuth(t, overrides = {}) {
  const dir = tempDir('relay-auth-http-');
  const credentials = new CredentialStore(join(dir, 'credentials.json'));
  credentials.setRelyingParty(RP);
  const sessions = new SessionManager(new KeyRing(new FileKeyStore(join(dir, 'keyring.json'))));
  const ceremonies = new Ceremonies({
    credentials,
    challenges: new EphemeralStore(),
    bootstrapTokens: new EphemeralStore(),
    sessions,
  });
  const surface = await startSurface({
    ceremonies,
    sessions,
    createUpstream: () => fakeUpstream(),
    ...overrides,
  });
  t.after(() => surface.close());

  const post = async (path, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${surface.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    return { res, body: text ? JSON.parse(text) : null, cookie: res.headers.getSetCookie()[0] ?? null };
  };
  return { ...surface, ceremonies, credentials, sessions, post };
}

const cookieHeader = (setCookie) => setCookie.split(';')[0];

test('the enrolment and login ceremonies work over HTTP and gate the websocket', async (t) => {
  const { post, ceremonies, port, logger, sessions } = await surfaceWithAuth(t);

  // No archive mount on this surface, so the status says the real App is not
  // here. What it says when one *is* mounted is in archive-mount.test.mjs,
  // next to the archive that makes the answer true.
  const status = await fetch(`http://127.0.0.1:${port}/auth/status`);
  assert.deepEqual(await status.json(), { enrolled: false, app: { available: false, prefix: null } });

  // --- enrolment, authorised by a single-use bootstrap token ---------------
  const bootstrapToken = ceremonies.issueBootstrapToken();
  const begun = await post('/auth/enroll/begin', { bootstrapToken });
  assert.equal(begun.res.status, 200);
  assert.equal(begun.body.publicKey.rp.id, RP.id);
  assert.ok(begun.body.challengeId);

  const credential = makeCredential({ alg: 'ES256' });
  const registration = registrationResponse({
    credential,
    rpId: RP.id,
    challenge: base64urlDecode(begun.body.challengeId),
    origin: RP.origin,
  });
  const enrolled = await post('/auth/enroll/finish', {
    challengeId: begun.body.challengeId,
    attestationObject: b64url(registration.attestationObject),
    clientDataJSON: b64url(registration.clientDataJSON),
    label: 'phone',
  });
  assert.equal(enrolled.res.status, 200, JSON.stringify(enrolled.body));
  assert.equal(enrolled.body.ok, true);

  // The cookie must be the hardened one the auth layer defines.
  assert.ok(enrolled.cookie.startsWith(`${sessions.cookieName}=`));
  for (const attr of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=']) {
    assert.ok(enrolled.cookie.includes(attr), `Set-Cookie missing ${attr}`);
  }
  assert.equal(/Domain=/i.test(enrolled.cookie), false);

  // --- that cookie opens a websocket --------------------------------------
  const upgraded = await rawHandshake(port, { headers: { Cookie: cookieHeader(enrolled.cookie) } });
  t.after(() => upgraded.socket.destroy());
  assert.equal(upgraded.status, 101);

  // --- and so does one from a fresh login ---------------------------------
  const loginBegun = await post('/auth/login/begin');
  assert.equal(loginBegun.res.status, 200);
  assert.deepEqual(
    loginBegun.body.publicKey.allowCredentials.map((c) => c.type),
    ['public-key'],
  );
  const assertion = assertionResponse({
    credential,
    rpId: RP.id,
    challenge: base64urlDecode(loginBegun.body.challengeId),
    origin: RP.origin,
    signCount: 5,
  });
  const loggedIn = await post('/auth/login/finish', {
    challengeId: loginBegun.body.challengeId,
    credentialId: b64url(credential.credentialId),
    authenticatorData: b64url(assertion.authenticatorData),
    clientDataJSON: b64url(assertion.clientDataJSON),
    signature: b64url(assertion.signature),
  });
  assert.equal(loggedIn.res.status, 200, JSON.stringify(loggedIn.body));
  assert.ok(loggedIn.body.expiresAt > Date.now());

  const second = await rawHandshake(port, { headers: { Cookie: cookieHeader(loggedIn.cookie) } });
  t.after(() => second.socket.destroy());
  assert.equal(second.status, 101);

  // --- logout clears the cookie -------------------------------------------
  const out = await post('/auth/logout');
  assert.equal(out.res.status, 200);
  assert.ok(out.cookie.includes('Max-Age=0'));

  assert.deepEqual(
    await (await fetch(`http://127.0.0.1:${port}/auth/status`)).json(),
    { enrolled: true, app: { available: false, prefix: null } },
  );

  // Nothing that authenticates anybody ended up in the log.
  const logged = logger.text();
  assert.equal(logged.includes(cookieHeader(enrolled.cookie).split('=').slice(1).join('=')), false);
  assert.equal(logged.includes(bootstrapToken), false);
});

test('a second device enrols from an existing session', async (t) => {
  const { post, ceremonies, sessions } = await surfaceWithAuth(t);
  const first = makeCredential({ alg: 'ES256' });
  const bootstrapToken = ceremonies.issueBootstrapToken();

  const begun = await post('/auth/enroll/begin', { bootstrapToken });
  const registration = registrationResponse({
    credential: first,
    rpId: RP.id,
    challenge: base64urlDecode(begun.body.challengeId),
    origin: RP.origin,
  });
  const enrolled = await post('/auth/enroll/finish', {
    challengeId: begun.body.challengeId,
    attestationObject: b64url(registration.attestationObject),
    clientDataJSON: b64url(registration.clientDataJSON),
  });
  const cookie = cookieHeader(enrolled.cookie);

  // With the first device's cookie and no bootstrap token at all.
  const secondBegun = await post('/auth/enroll/begin', {}, { Cookie: cookie });
  assert.equal(secondBegun.res.status, 200);
  assert.equal(secondBegun.body.publicKey.excludeCredentials.length, 1);

  const other = makeCredential({ alg: 'EdDSA' });
  const otherRegistration = registrationResponse({
    credential: other,
    rpId: RP.id,
    challenge: base64urlDecode(secondBegun.body.challengeId),
    origin: RP.origin,
  });
  const secondEnrolled = await post('/auth/enroll/finish', {
    challengeId: secondBegun.body.challengeId,
    attestationObject: b64url(otherRegistration.attestationObject),
    clientDataJSON: b64url(otherRegistration.clientDataJSON),
    label: 'laptop',
  }, { Cookie: cookie });
  assert.equal(secondEnrolled.res.status, 200, JSON.stringify(secondEnrolled.body));
  assert.notEqual(secondEnrolled.body.credentialId, enrolled.body.credentialId);
  assert.ok(sessions.verify(cookieHeader(secondEnrolled.cookie).split('=').slice(1).join('=')));
});

test('unauthorised and malformed ceremony requests are refused with the ceremony status', async (t) => {
  const { post } = await surfaceWithAuth(t);

  // No bootstrap token and no session: the one case that must never be open.
  const bare = await post('/auth/enroll/begin', {});
  assert.equal(bare.res.status, 403);
  assert.match(bare.body.error, /bootstrap link or an existing session/);

  assert.equal((await post('/auth/enroll/begin', { bootstrapToken: 'invented' })).res.status, 403);
  // Nothing is enrolled yet, so login has nothing to offer.
  assert.equal((await post('/auth/login/begin')).res.status, 409);

  const badFields = await post('/auth/enroll/finish', { challengeId: 'x' });
  assert.equal(badFields.res.status, 400);
  assert.match(badFields.body.error, /missing field attestationObject/);

  const notB64 = await post('/auth/enroll/finish', {
    challengeId: 'x',
    attestationObject: 'not base64url!!',
    clientDataJSON: 'AAAA',
  });
  assert.equal(notB64.res.status, 400);
  assert.match(notB64.body.error, /not base64url/);

  assert.equal((await post('/auth/enroll/begin', 'this is not json')).res.status, 400);
  assert.equal((await post('/auth/nope', {})).res.status, 404);
});

test('an oversize ceremony body is refused rather than buffered', async (t) => {
  const { post } = await surfaceWithAuth(t, { maxBodyBytes: 1024 });
  const huge = await post('/auth/enroll/begin', { bootstrapToken: 'x'.repeat(4096) });
  assert.equal(huge.res.status, 413);
});

test('SameSite can be tightened to Strict for a deployment that wants it', async (t) => {
  const { post, ceremonies } = await surfaceWithAuth(t, { cookieSameSite: 'Strict' });
  const bootstrapToken = ceremonies.issueBootstrapToken();
  const begun = await post('/auth/enroll/begin', { bootstrapToken });
  const credential = makeCredential({ alg: 'ES256' });
  const registration = registrationResponse({
    credential,
    rpId: RP.id,
    challenge: base64urlDecode(begun.body.challengeId),
    origin: RP.origin,
  });
  const enrolled = await post('/auth/enroll/finish', {
    challengeId: begun.body.challengeId,
    attestationObject: b64url(registration.attestationObject),
    clientDataJSON: b64url(registration.clientDataJSON),
  });
  assert.ok(enrolled.cookie.includes('SameSite=Strict'));
  assert.equal(enrolled.cookie.includes('SameSite=Lax'), false);
  assert.ok(enrolled.cookie.includes('HttpOnly'));
  assert.ok(enrolled.cookie.includes('Secure'));

  // The cookie that clears the session has to match the one that set it. While
  // the surface rewrote the attribute at the login call site, this one came out
  // Lax, and nothing noticed.
  const out = await post('/auth/logout');
  assert.ok(out.cookie.includes('SameSite=Strict'), out.cookie);
  assert.ok(out.cookie.includes('Max-Age=0'), out.cookie);
});

test('a SameSite the browser would ignore stops the surface from booting', async (t) => {
  // Refused at construction rather than at first login: `None` is honoured and
  // removes the CSRF property, and anything unrecognised is silently Lax, so a
  // deployment would believe it had asked for something it did not get.
  for (const bad of ['None', 'strict', 'Strict ']) {
    await assert.rejects(() => surfaceWithAuth(t, { cookieSameSite: bad }),
      /SameSite must be Lax or Strict/, `cookieSameSite accepted ${JSON.stringify(bad)}`);
  }
});

test('a session whose credential was removed stops opening websockets', async (t) => {
  const { post, ceremonies, credentials, port } = await surfaceWithAuth(t);
  const bootstrapToken = ceremonies.issueBootstrapToken();
  const begun = await post('/auth/enroll/begin', { bootstrapToken });
  const credential = makeCredential({ alg: 'ES256' });
  const registration = registrationResponse({
    credential,
    rpId: RP.id,
    challenge: base64urlDecode(begun.body.challengeId),
    origin: RP.origin,
  });
  const enrolled = await post('/auth/enroll/finish', {
    challengeId: begun.body.challengeId,
    attestationObject: b64url(registration.attestationObject),
    clientDataJSON: b64url(registration.clientDataJSON),
  });
  const cookie = cookieHeader(enrolled.cookie);

  const before = await rawHandshake(port, { headers: { Cookie: cookie } });
  before.socket.destroy();
  assert.equal(before.status, 101);

  // Removing the device must kill its sessions immediately -- the gate goes
  // through Ceremonies.authenticate, which re-checks the credential.
  assert.equal(credentials.removeCredential(enrolled.body.credentialId), true);
  const after = await rawHandshake(port, { headers: { Cookie: cookie } });
  after.socket.destroy();
  assert.equal(after.status, 401);
});
