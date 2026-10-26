import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore, EphemeralStore } from '../../src/auth/store.mjs';
import { KeyRing, FileKeyStore, KeychainKeyStore, defaultKeyStore, KeyStoreError } from '../../src/auth/keys.mjs';

const tmpFile = (name) => join(mkdtempSync(join(tmpdir(), 'relay-store-')), name);

const sampleCredential = (id = 'cred-1') => ({
  id,
  spki: 'c3BraQ',
  coseAlg: -7,
  verify: { kind: 'ec', hash: 'sha256', dsaEncoding: 'der' },
  signCount: 0,
  label: 'phone',
});

// --- CredentialStore -----------------------------------------------------------

test('starts empty and reports not enrolled', () => {
  const store = new CredentialStore(tmpFile('creds.json'));
  assert.equal(store.isEnrolled, false);
  assert.deepEqual(store.listCredentials(), []);
  assert.equal(store.relyingParty, null);
});

test('persists credentials across instances', () => {
  const path = tmpFile('creds.json');
  const a = new CredentialStore(path);
  a.setRelyingParty({ id: 'relay.example.ts.net', name: 'Codex Relay', origin: 'https://relay.example.ts.net' });
  a.addCredential(sampleCredential());

  const b = new CredentialStore(path);
  assert.equal(b.isEnrolled, true);
  assert.equal(b.relyingParty.id, 'relay.example.ts.net');
  assert.equal(b.findByCredentialId('cred-1').label, 'phone');
  assert.equal(b.findByCredentialId('nope'), null);
});

test('writes the credential file 0600', () => {
  const path = tmpFile('creds.json');
  const store = new CredentialStore(path);
  store.addCredential(sampleCredential());
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('refuses to enrol the same credential twice', () => {
  const store = new CredentialStore(tmpFile('creds.json'));
  store.addCredential(sampleCredential());
  assert.throws(() => store.addCredential(sampleCredential()), /already enrolled/);
});

test('updates the signature counter and last-used stamp', () => {
  const path = tmpFile('creds.json');
  const store = new CredentialStore(path);
  store.addCredential(sampleCredential());
  store.updateSignCount('cred-1', 7);

  const reloaded = new CredentialStore(path);
  const cred = reloaded.findByCredentialId('cred-1');
  assert.equal(cred.signCount, 7);
  assert.ok(cred.lastUsedAt > 0);
});

test('listCredentials hands out copies, not live references', () => {
  const store = new CredentialStore(tmpFile('creds.json'));
  store.addCredential(sampleCredential());
  store.listCredentials()[0].signCount = 999;
  assert.equal(store.findByCredentialId('cred-1').signCount, 0);
});

test('removes a credential', () => {
  const path = tmpFile('creds.json');
  const store = new CredentialStore(path);
  store.addCredential(sampleCredential('a'));
  store.addCredential(sampleCredential('b'));
  assert.equal(store.removeCredential('a'), true);
  assert.equal(store.removeCredential('a'), false);
  assert.deepEqual(new CredentialStore(path).listCredentials().map((c) => c.id), ['b']);
});

test('stores only public material', () => {
  const path = tmpFile('creds.json');
  const store = new CredentialStore(path);
  store.addCredential(sampleCredential());
  const raw = readFileSync(path, 'utf8');
  // The record is an allowlist entry: public key, counter, metadata. Nothing that
  // could sign on the user's behalf should ever appear here.
  for (const forbidden of ['privateKey', '"secret"', 'BEGIN PRIVATE']) {
    assert.ok(!raw.includes(forbidden), `credential file leaked ${forbidden}`);
  }
});

// --- EphemeralStore ------------------------------------------------------------

test('challenges are single-use', () => {
  const eph = new EphemeralStore();
  const id = eph.issue({ purpose: 'login' });
  assert.deepEqual(eph.peek(id), { purpose: 'login' });
  assert.deepEqual(eph.consume(id), { purpose: 'login' });
  assert.equal(eph.consume(id), null, 'a consumed challenge cannot be replayed');
});

test('challenges expire', async () => {
  const eph = new EphemeralStore({ ttlMs: 5 });
  const id = eph.issue({ purpose: 'login' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(eph.peek(id), null);
  assert.equal(eph.consume(id), null);
});

test('unknown ids are null, not throwing', () => {
  const eph = new EphemeralStore();
  assert.equal(eph.consume('never-issued'), null);
});

test('expired entries are swept so the map cannot grow without bound', async () => {
  const eph = new EphemeralStore({ ttlMs: 5 });
  for (let i = 0; i < 50; i++) eph.issue({ i });
  assert.equal(eph.size, 50);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(eph.size, 0);
});

test('issued ids are unique and high-entropy', () => {
  const eph = new EphemeralStore();
  const ids = new Set(Array.from({ length: 500 }, () => eph.issue()));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.ok(id.length >= 40, 'challenge id is too short to be a 32-byte random');
});

// --- KeyRing / key stores ------------------------------------------------------

test('a fresh keyring mints and persists a key', () => {
  const path = tmpFile('keyring.json');
  const a = new KeyRing(new FileKeyStore(path));
  assert.equal(a.keyIds.length, 1);
  assert.equal(a.current().key.length, 32);

  const b = new KeyRing(new FileKeyStore(path));
  assert.deepEqual(b.keyIds, a.keyIds, 'reload must not mint a new key and log everyone out');
  assert.deepEqual([...b.current().key], [...a.current().key]);
});

test('the keyring file is 0600', () => {
  const path = tmpFile('keyring.json');
  new KeyRing(new FileKeyStore(path));
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('rotation keeps a bounded tail', () => {
  const ring = new KeyRing(new FileKeyStore(tmpFile('keyring.json')), { maxKeys: 2 });
  const first = ring.keyIds[0];
  const second = ring.rotate();
  assert.deepEqual(ring.keyIds, [second, first]);
  const third = ring.rotate();
  assert.deepEqual(ring.keyIds, [third, second]);
  assert.equal(ring.get(first), null, 'the oldest key must age out');
});

test('revokeAll leaves exactly one brand-new key', () => {
  const ring = new KeyRing(new FileKeyStore(tmpFile('keyring.json')));
  const before = ring.keyIds[0];
  const after = ring.revokeAll();
  assert.deepEqual(ring.keyIds, [after]);
  assert.notEqual(after, before);
  assert.equal(ring.get(before), null);
});

test('a corrupt keyring fails loudly instead of minting a replacement', () => {
  const path = tmpFile('keyring.json');
  new FileKeyStore(path).save('{not json');
  assert.throws(() => new KeyRing(new FileKeyStore(path)), KeyStoreError);
});

test('Keychain store treats exit 44 as first run, other failures as errors', () => {
  const notFound = Object.assign(new Error('nope'), { status: 44 });
  const locked = Object.assign(new Error('locked'), { status: 36 });

  assert.equal(new KeychainKeyStore({ run: () => { throw notFound; } }).load(), null);
  assert.throws(
    () => new KeychainKeyStore({ run: () => { throw locked; } }).load(),
    /could not read the signing key/,
  );
});

test('Keychain store passes the secret over stdin, never argv', () => {
  const calls = [];
  const store = new KeychainKeyStore({ run: (args, input) => { calls.push({ args, input }); return ''; } });
  store.save('super-secret-keyring');

  const { args, input } = calls[0];
  assert.ok(input.includes('super-secret-keyring'), 'the secret should arrive on stdin');
  assert.ok(!args.join(' ').includes('super-secret-keyring'), 'the secret must never appear in argv (ps leaks it)');
  assert.ok(args.includes('-U'), 'must update in place rather than duplicating the item');
});

test('Keychain round-trips through an in-memory fake', () => {
  let stored = null;
  const run = (args, input) => {
    if (args[0] === 'add-generic-password') { stored = input.trim(); return ''; }
    if (args[0] === 'find-generic-password') {
      if (stored === null) throw Object.assign(new Error('not found'), { status: 44 });
      return `${stored}\n`;
    }
    throw new Error(`unexpected security call ${args[0]}`);
  };
  const a = new KeyRing(new KeychainKeyStore({ run }));
  const b = new KeyRing(new KeychainKeyStore({ run }));
  assert.deepEqual(b.keyIds, a.keyIds);
});

test('defaultKeyStore picks the Keychain on macOS and refuses a silent file fallback', () => {
  assert.ok(defaultKeyStore({ platform: 'darwin' }) instanceof KeychainKeyStore);
  // On macOS a file store has to be asked for by name AND given a path.
  assert.throws(() => defaultKeyStore({ platform: 'darwin', preferFile: true }), KeyStoreError);
  assert.throws(() => defaultKeyStore({ platform: 'linux' }), KeyStoreError);
  assert.ok(defaultKeyStore({ platform: 'linux', filePath: tmpFile('k.json') }) instanceof FileKeyStore);
});
