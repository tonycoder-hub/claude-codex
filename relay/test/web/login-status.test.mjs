// What the login page is allowed to believe about the relay.
//
// /auth/status answers two questions and the page acts on both: whether any
// passkey is enrolled, which decides what the login screen offers, and whether
// the real App is being served and where, which decides where a successful
// sign-in goes. The second one is newer than some relays, and it is the one
// with a sharp edge: a page that trusted a flag without checking the prefix
// alongside it would navigate a signed-in user into a 404 and strand them
// there, with the chat UI they could have used one redirect behind them.
//
// So every assertion below is about what the page concludes from a body, not
// about the transport -- including the bodies no correct server sends.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ENDPOINTS, fetchRelayStatus } from '../../web/login.mjs';

/** Answer the next status fetch with `body`, and record how it was asked. */
function serving(body, { status = 200 } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(body === null ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('the status is read from the endpoint the surface answers, with the cookie', async (t) => {
  const fake = serving({ enrolled: true, app: { available: true, prefix: '/app/' } });
  t.after(fake.restore);

  const status = await fetchRelayStatus();

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url, ENDPOINTS.status);
  assert.equal(fake.calls[0].init.method, 'GET');
  assert.equal(
    fake.calls[0].init.credentials,
    'same-origin',
    'without this the relay sees an anonymous request and the page looks logged out',
  );
  assert.deepEqual(status, { enrolled: true, app: { available: true, prefix: '/app/' } });
});

test('a relay with no App mounted is reported as having none', async (t) => {
  const fake = serving({ enrolled: true, app: { available: false, prefix: null } });
  t.after(fake.restore);
  assert.deepEqual(await fetchRelayStatus(), {
    enrolled: true,
    app: { available: false, prefix: null },
  });
});

test('a relay from before this field existed reads as having no App', async (t) => {
  // The endpoint's original contract was one key. A page that dereferenced
  // `status.app.available` against that body would throw inside boot(), which
  // is before the login screen is drawn -- so an old relay would present as a
  // blank page rather than as one with nowhere to navigate.
  const fake = serving({ enrolled: true });
  t.after(fake.restore);
  const status = await fetchRelayStatus();
  assert.equal(status.enrolled, true, 'the original contract still reads the same');
  assert.deepEqual(status.app, { available: false, prefix: null });
});

test('a flag without a usable prefix is not available', async (t) => {
  // The combination that would turn a working chat page into a navigation to
  // nowhere. Checked as two separate conditions because the server computes the
  // flag and the prefix from different things.
  for (const prefix of [undefined, null, '', 'app/', '/app', 42, 'https://elsewhere.invalid/app/']) {
    const fake = serving({ enrolled: true, app: { available: true, prefix } });
    const status = await fetchRelayStatus();
    fake.restore();
    assert.deepEqual(
      status.app,
      { available: false, prefix: null },
      `prefix ${JSON.stringify(prefix)} was accepted, and it should not have been`,
    );
  }
});

test('a usable prefix without the flag is not available either', async (t) => {
  const fake = serving({ enrolled: true, app: { prefix: '/app/' } });
  t.after(fake.restore);
  assert.equal((await fetchRelayStatus()).app.available, false, 'the server has the final say');
});

test('enrolled is true only when the server says so, in the one spelling', async (t) => {
  for (const body of [{}, { enrolled: 'yes' }, { enrolled: 1 }, { enrolled: null }, null]) {
    const fake = serving(body);
    const status = await fetchRelayStatus();
    fake.restore();
    assert.equal(status.enrolled, false, `${JSON.stringify(body)} should not read as enrolled`);
  }
});

test('a refused status is an error the page can show, not a silent false', async (t) => {
  // boot() puts this message on the login screen. Degrading to "not enrolled"
  // instead would offer an enrolment that cannot succeed.
  const fake = serving({ error: 'authentication is not configured' }, { status: 503 });
  t.after(fake.restore);
  await assert.rejects(() => fetchRelayStatus(), /authentication is not configured/);
});
