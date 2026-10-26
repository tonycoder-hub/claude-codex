import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, SessionError, serializeCookie, assertSameSite, parseCookies, SESSION_COOKIE } from '../../src/auth/session.mjs';
import { KeyRing, FileKeyStore } from '../../src/auth/keys.mjs';
import { base64urlEncode, base64urlDecode } from '../../src/auth/bytes.mjs';

const freshRing = (opts) => new KeyRing(new FileKeyStore(join(mkdtempSync(join(tmpdir(), 'relay-keys-')), 'keyring.json')), opts);

test('issues and verifies a session', () => {
  const sm = new SessionManager(freshRing());
  const { token, payload } = sm.issue({ subject: 'cred-abc' });
  const verified = sm.verify(token);
  assert.equal(verified.sub, 'cred-abc');
  assert.equal(verified.sid, payload.sid);
  assert.equal(verified.v, 1);
});

test('carries extra claims', () => {
  const sm = new SessionManager(freshRing());
  const { token } = sm.issue({ subject: 'c', extra: { label: 'phone' } });
  assert.equal(sm.verify(token).label, 'phone');
});

test('rejects a tampered payload', () => {
  const sm = new SessionManager(freshRing());
  const { token } = sm.issue({ subject: 'cred-abc' });
  const [kid, , sig] = token.split('.');
  const forged = base64urlEncode(new TextEncoder().encode(
    JSON.stringify({ v: 1, sub: 'attacker', sid: 'x', iat: Date.now(), exp: Date.now() + 1e6 }),
  ));
  assert.throws(() => sm.verify(`${kid}.${forged}.${sig}`), /bad session signature/);
});

test('rejects a tampered signature', () => {
  const sm = new SessionManager(freshRing());
  const { token } = sm.issue({ subject: 'cred-abc' });
  const [kid, payload, sig] = token.split('.');
  // Flip a byte rather than a base64url character: a 32-byte HMAC encodes to 43
  // characters whose last one carries spare bits, so editing the final character
  // can decode to the very same bytes and legitimately still verify.
  const bytes = base64urlDecode(sig);
  bytes[0] ^= 0xff;
  assert.throws(() => sm.verify(`${kid}.${payload}.${base64urlEncode(bytes)}`), SessionError);
});

test('rejects a swapped key id (signature covers it)', () => {
  const ring = freshRing();
  const sm = new SessionManager(ring);
  const { token } = sm.issue({ subject: 'cred-abc' });
  const [, payload, sig] = token.split('.');
  ring.rotate();
  const otherKid = ring.keyIds[0];
  assert.throws(() => sm.verify(`${otherKid}.${payload}.${sig}`), /bad session signature/);
});

test('rejects malformed tokens', () => {
  const sm = new SessionManager(freshRing());
  for (const bad of ['', 'a.b', 'a.b.c.d', 'not-a-token', undefined, null, 42]) {
    assert.throws(() => sm.verify(bad), SessionError);
  }
});

test('rejects an expired session', () => {
  const sm = new SessionManager(freshRing(), { ttlMs: 1 });
  const { token } = sm.issue({ subject: 'cred-abc' });
  // exp is in the signed payload, so no clock trickery on the cookie can help.
  return new Promise((resolve) => setTimeout(() => {
    assert.throws(() => sm.verify(token), /expired/);
    resolve();
  }, 10));
});

test('a rotated-out key stops verifying, one rotation still works', () => {
  const ring = freshRing({ maxKeys: 2 });
  const sm = new SessionManager(ring);
  const { token } = sm.issue({ subject: 'cred-abc' });

  ring.rotate();
  assert.equal(sm.verify(token).sub, 'cred-abc', 'one rotation keeps in-flight sessions alive');

  ring.rotate();
  assert.throws(() => sm.verify(token), /retired key/);
});

test('revokeAll invalidates every outstanding session at once', () => {
  const ring = freshRing();
  const sm = new SessionManager(ring);
  const a = sm.issue({ subject: 'phone' }).token;
  const b = sm.issue({ subject: 'laptop' }).token;
  assert.ok(sm.verify(a) && sm.verify(b));

  ring.revokeAll();
  assert.throws(() => sm.verify(a), SessionError);
  assert.throws(() => sm.verify(b), SessionError);
});

test('cookie is hardened and __Host- compatible', () => {
  const sm = new SessionManager(freshRing());
  const { token } = sm.issue({ subject: 'c' });
  const cookie = sm.cookie(token);
  assert.ok(cookie.startsWith(`${SESSION_COOKIE}=${token}`));
  for (const attr of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) {
    assert.ok(cookie.includes(attr), `cookie missing ${attr}`);
  }
  // __Host- forbids a Domain attribute.
  assert.ok(!/Domain=/i.test(cookie));
});

test('clearCookie expires immediately', () => {
  const sm = new SessionManager(freshRing());
  assert.ok(sm.clearCookie().includes('Max-Age=0'));
});

test('a deployment can ask for Strict, and gets it on both cookies', () => {
  const sm = new SessionManager(freshRing(), { sameSite: 'Strict' });
  const { token } = sm.issue({ subject: 'c' });
  for (const cookie of [sm.cookie(token), sm.clearCookie()]) {
    assert.ok(cookie.includes('SameSite=Strict'), cookie);
    assert.equal(cookie.includes('SameSite=Lax'), false, cookie);
  }
});

test('either cookie can be overridden per call, without touching the other', () => {
  const sm = new SessionManager(freshRing());
  const { token } = sm.issue({ subject: 'c' });
  assert.ok(sm.cookie(token, { sameSite: 'Strict' }).includes('SameSite=Strict'));
  assert.ok(sm.clearCookie({ sameSite: 'Strict' }).includes('SameSite=Strict'));
  // The default is untouched by an override -- no per-instance memory.
  assert.ok(sm.cookie(token).includes('SameSite=Lax'));
});

test('a SameSite a browser would silently downgrade is refused, not serialized', () => {
  // `None` would be honoured and would remove the only property the attribute
  // is here for; the rest a browser treats as Lax without telling anybody.
  for (const bad of ['None', 'strict', 'LAX', '', 'Lax; HttpOnly', null, 1]) {
    assert.throws(() => serializeCookie('n', 'v', { sameSite: bad }), SessionError,
      `serializeCookie accepted ${JSON.stringify(bad)}`);
    assert.throws(() => new SessionManager(freshRing(), { sameSite: bad }), SessionError,
      `the constructor accepted ${JSON.stringify(bad)}`);
  }
  // `undefined` is not in that list and must not be: it selects the default
  // parameter, so an explicitly-undefined option means the same as an absent
  // one. `null` does not, which is why it is in the list.
  assert.ok(serializeCookie('n', 'v').includes('SameSite=Lax'));
  assert.ok(serializeCookie('n', 'v', { sameSite: undefined }).includes('SameSite=Lax'));
  assert.equal(assertSameSite('Strict'), 'Strict');
});

test('parseCookies handles real headers', () => {
  const parsed = parseCookies(`${SESSION_COOKIE}=abc.def.ghi; other=1; flag`);
  assert.equal(parsed[SESSION_COOKIE], 'abc.def.ghi');
  assert.equal(parsed.other, '1');
  assert.equal(parsed.flag, undefined);
  // parseCookies returns a null-prototype object on purpose, so compare keys
  // rather than deep-equalling against a normal {} (prototypes differ).
  assert.equal(Object.keys(parseCookies('')).length, 0);
  assert.equal(Object.keys(parseCookies(undefined)).length, 0);
});

test('parseCookies result has no prototype pollution surface', () => {
  const parsed = parseCookies('__proto__=x; constructor=y');
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal({}.x, undefined);
});

test('serializeCookie omits Max-Age when not asked', () => {
  assert.ok(!serializeCookie('n', 'v').includes('Max-Age'));
});
