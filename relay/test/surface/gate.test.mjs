import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64urlEncode, base64urlDecode } from '../../src/auth/bytes.mjs';
import { freshSessions, startSurface, rawHandshake, browserClient, fakeUpstream, waitFor } from './harness.mjs';

/** A surface whose only job is to decide whether an upgrade may proceed. */
async function gated(t, { sessions = freshSessions(), ...overrides } = {}) {
  const upstreams = [];
  const surface = await startSurface({
    sessions,
    createUpstream: () => { const u = fakeUpstream(); upstreams.push(u); return u; },
    ...overrides,
  });
  t.after(() => surface.close());
  return { ...surface, sessions, upstreams, cookie: (token) => `${sessions.cookieName}=${token}` };
}

test('an upgrade with no cookie is refused with 401 and opens no websocket', async (t) => {
  const { port, upstreams, logger } = await gated(t);

  const { status, headers, socket } = await rawHandshake(port);
  t.after(() => socket.destroy());
  assert.equal(status, 401);
  assert.equal(headers['sec-websocket-accept'], undefined);
  assert.equal(upstreams.length, 0);
  assert.ok(logger.records.some((r) => r.event === 'ws.denied'));
});

test('an upgrade with an unrelated cookie is refused', async (t) => {
  const { port, upstreams } = await gated(t);
  const { status, socket } = await rawHandshake(port, { headers: { Cookie: 'theme=dark; other=1' } });
  t.after(() => socket.destroy());
  assert.equal(status, 401);
  assert.equal(upstreams.length, 0);
});

test('a tampered signature is refused', async (t) => {
  const { port, sessions, cookie, upstreams } = await gated(t);
  const { token } = sessions.issue({ subject: 'cred-phone' });
  const [kid, payload, sig] = token.split('.');
  // Flip a signature byte, not a base64url character -- the trailing character
  // carries spare bits and can re-encode to the same bytes.
  const bytes = base64urlDecode(sig);
  bytes[0] ^= 0xff;

  const { status, socket } = await rawHandshake(port, {
    headers: { Cookie: cookie(`${kid}.${payload}.${base64urlEncode(bytes)}`) },
  });
  t.after(() => socket.destroy());
  assert.equal(status, 401);
  assert.equal(upstreams.length, 0);
});

test('a forged payload under a genuine signature is refused', async (t) => {
  const { port, sessions, cookie, upstreams } = await gated(t);
  const { token } = sessions.issue({ subject: 'cred-phone' });
  const [kid, , sig] = token.split('.');
  const forged = base64urlEncode(new TextEncoder().encode(JSON.stringify({
    v: 1, sub: 'attacker', sid: 'x', iat: Date.now(), exp: Date.now() + 1e9,
  })));

  const { status, socket } = await rawHandshake(port, { headers: { Cookie: cookie(`${kid}.${forged}.${sig}`) } });
  t.after(() => socket.destroy());
  assert.equal(status, 401);
  assert.equal(upstreams.length, 0);
});

test('a session signed by a different keyring is refused', async (t) => {
  const { port, cookie, upstreams } = await gated(t);
  const stranger = freshSessions();
  const { token } = stranger.issue({ subject: 'cred-phone' });

  const { status, socket } = await rawHandshake(port, { headers: { Cookie: cookie(token) } });
  t.after(() => socket.destroy());
  assert.equal(status, 401);
  assert.equal(upstreams.length, 0);
});

test('an expired session is refused', async (t) => {
  const sessions = freshSessions({ ttlMs: 1 });
  const { port, cookie, upstreams } = await gated(t, { sessions });
  const { token } = sessions.issue({ subject: 'cred-phone' });
  await new Promise((res) => setTimeout(res, 10));

  const { status, socket } = await rawHandshake(port, { headers: { Cookie: cookie(token) } });
  t.after(() => socket.destroy());
  assert.equal(status, 401);
  assert.equal(upstreams.length, 0);
});

test('a genuinely signed session is accepted', async (t) => {
  const { port, sessions, cookie, upstreams } = await gated(t);
  const { token } = sessions.issue({ subject: 'cred-phone', extra: { label: 'phone' } });

  const { status, headers, socket, key } = await rawHandshake(port, { headers: { Cookie: cookie(token) } });
  t.after(() => socket.destroy());
  assert.equal(status, 101);
  assert.ok(headers['sec-websocket-accept']);
  assert.notEqual(headers['sec-websocket-accept'], key);
  await waitFor(() => upstreams.length === 1, { label: 'the upstream' });
});

test('the session is handed to the upstream factory but never logged', async (t) => {
  const sessions = freshSessions();
  const seen = [];
  const surface = await startSurface({
    sessions,
    createUpstream: (ctx) => { seen.push(ctx); return fakeUpstream(); },
  });
  t.after(() => surface.close());

  const { token } = sessions.issue({ subject: 'cred-phone' });
  const client = browserClient(surface.port, { cookie: `${sessions.cookieName}=${token}` });
  t.after(() => client.ws.close());
  await client.opened;
  await waitFor(() => seen.length === 1, { label: 'the upstream factory call' });

  assert.equal(seen[0].session.sub, 'cred-phone');
  // The whole point: nothing that reconstructs a session reaches the log.
  const logged = surface.logger.text();
  assert.equal(logged.includes(token), false, 'the session token was logged');
  assert.equal(logged.includes('cred-phone'), false, 'the credential id was logged');
  assert.equal(logged.includes(sessions.cookieName), false, 'the cookie name was logged');
});

test('an upgrade on another path is refused with 404', async (t) => {
  const { port, sessions, cookie, upstreams } = await gated(t);
  const { token } = sessions.issue({ subject: 'cred-phone' });

  const { status, socket } = await rawHandshake(port, { path: '/not-ws', headers: { Cookie: cookie(token) } });
  t.after(() => socket.destroy());
  assert.equal(status, 404);
  assert.equal(upstreams.length, 0);
});

test('a valid session with a malformed upgrade still gets an HTTP error', async (t) => {
  const { port, sessions, cookie, upstreams } = await gated(t);
  const { token } = sessions.issue({ subject: 'cred-phone' });

  const { status, socket } = await rawHandshake(port, {
    headers: { Cookie: cookie(token), 'Sec-WebSocket-Version': '7' },
  });
  t.after(() => socket.destroy());
  assert.equal(status, 426);
  assert.equal(upstreams.length, 0);
});

test('with no upstream configured an authenticated upgrade is refused with 503', async (t) => {
  const sessions = freshSessions();
  const surface = await startSurface({ sessions });
  t.after(() => surface.close());
  const { token } = sessions.issue({ subject: 'cred-phone' });

  const { status, socket } = await rawHandshake(surface.port, {
    headers: { Cookie: `${sessions.cookieName}=${token}` },
  });
  t.after(() => socket.destroy());
  assert.equal(status, 503);
});
