// The first device has to get in somehow.
//
// Enrolment needs a bootstrap token, the token store is in this process's
// memory, and until now the only caller of issueBootstrapToken() was a test.
// So a real deployment could boot, serve the page, and have no way to enrol
// anybody -- which is the whole product. These tests are about that one hole
// and the two subtleties in closing it: the link must be built from the pinned
// origin rather than the environment, and the token it prints must be one the
// ceremony actually accepts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildSurface, announceEnrolment } from '../../src/surface/main.mjs';
import { Ceremonies } from '../../src/auth/ceremony.mjs';
import { CredentialStore, EphemeralStore } from '../../src/auth/store.mjs';
import { SessionManager } from '../../src/auth/session.mjs';
import { KeyRing, FileKeyStore } from '../../src/auth/keys.mjs';
import { tempDir } from './harness.mjs';

const RP = { id: 'relay.example.net', name: 'Codex Relay', origin: 'https://relay.example.net' };

function ceremoniesIn(dir, { enrolled = false } = {}) {
  const credentials = new CredentialStore(join(dir, 'credentials.json'));
  credentials.setRelyingParty(RP);
  if (enrolled) {
    credentials.addCredential({ id: 'already-here', spki: 'x', coseAlg: -7, verify: {}, signCount: 0 });
  }
  return new Ceremonies({
    credentials,
    challenges: new EphemeralStore(),
    bootstrapTokens: new EphemeralStore(),
    sessions: new SessionManager(new KeyRing(new FileKeyStore(join(dir, 'keyring.json')))),
  });
}

/** The env a surface needs to be constructible. No port is ever bound here. */
function envIn(dir, overrides = {}) {
  return {
    CODEX_RELAY_STATE: dir,
    CODEX_RELAY_KEY_FILE: join(dir, 'session-key'),
    CODEX_RELAY_RP_ID: RP.id,
    CODEX_RELAY_RP_ORIGIN: RP.origin,
    CODEX_RELAY_UPSTREAM: 'ws://127.0.0.1:9/',
    CODEX_RELAY_LOG_LEVEL: 'error',
    ...overrides,
  };
}

test('with nothing enrolled, the link is printed and its token is one the ceremony accepts', () => {
  const ceremonies = ceremoniesIn(tempDir('relay-enrol-'));
  let printed = '';
  const token = announceEnrolment({ ceremonies, origin: RP.origin, write: (t) => { printed += t; } });

  assert.ok(token, 'a token was minted');
  assert.match(printed, /No passkey is enrolled/);
  assert.ok(printed.includes(`${RP.origin}/#enroll=${token}`), printed);
  assert.match(printed, /kill -USR1 \d+/, 'the operator is told how to get another one');

  // The point of the exercise: the token in that URL authorises the ceremony.
  // A link carrying a token the ceremony rejects would look identical.
  const fromLink = /#enroll=([A-Za-z0-9_-]+)/.exec(printed)[1];
  const begun = ceremonies.startEnrollment({ bootstrapToken: fromLink });
  assert.ok(begun.challengeId);
  assert.equal(begun.publicKey.rp.id, RP.id);
});

test('with a passkey already enrolled it prints nothing at all', () => {
  const ceremonies = ceremoniesIn(tempDir('relay-enrol-'), { enrolled: true });
  let printed = '';
  const token = announceEnrolment({ ceremonies, origin: RP.origin, write: (t) => { printed += t; } });
  assert.equal(token, null, 'no token is minted when none is needed');
  assert.equal(printed, '', 'a running relay does not scatter enrolment links into its own log');
});

test('force prints for a relay that is already enrolled, and says which case it is', () => {
  const ceremonies = ceremoniesIn(tempDir('relay-enrol-'), { enrolled: true });
  let printed = '';
  const token = announceEnrolment({
    ceremonies, origin: RP.origin, force: true, write: (t) => { printed += t; },
  });
  assert.ok(token);
  assert.match(printed, /one more passkey/);
  assert.equal(printed.includes('No passkey is enrolled'), false, 'the two cases read differently');
  assert.ok(ceremonies.startEnrollment({ bootstrapToken: token }).challengeId);
});

test('the link is built from the pinned origin, not from the environment', () => {
  const dir = tempDir('relay-enrol-');
  // First run pins the relying party into the store.
  buildSurface(envIn(dir));
  // A later run with a changed origin: the store wins, because the pinned value
  // is the one the browser will check. A link built from the new env var would
  // open a page whose ceremony the browser refuses, with nothing to read.
  const { ceremonies, origin } = buildSurface(envIn(dir, { CODEX_RELAY_RP_ORIGIN: 'https://typo.example' }));
  assert.equal(origin, RP.origin);
  let printed = '';
  announceEnrolment({ ceremonies, origin, write: (t) => { printed += t; } });
  assert.ok(printed.includes(`${RP.origin}/#enroll=`), printed);
  assert.equal(printed.includes('typo.example'), false);
});

test('buildSurface reads the env it is handed, not the one the process happens to have', () => {
  const dir = tempDir('relay-enrol-');
  const { CODEX_RELAY_RP_ID: _omitted, ...withoutRpId } = envIn(dir);
  const leak = process.env.CODEX_RELAY_RP_ID;
  process.env.CODEX_RELAY_RP_ID = 'leaked-from-the-real-environment.example';
  try {
    // Before the fix this passed by reading process.env, so a caller that
    // injected an env got the machine's configuration without being told.
    assert.throws(() => buildSurface(withoutRpId), /CODEX_RELAY_RP_ID must be set/);
  } finally {
    if (leak === undefined) delete process.env.CODEX_RELAY_RP_ID;
    else process.env.CODEX_RELAY_RP_ID = leak;
  }
});
