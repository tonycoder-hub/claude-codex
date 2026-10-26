// Where the session-signing key lives.
//
// This is the one genuinely secret thing the relay holds: whoever has it can mint
// a session cookie and skip the passkey entirely. So the storage rule is strict --
// on macOS it goes in the login Keychain and nowhere else, and the file-backed
// store is never reached by falling back silently; a caller has to ask for it by
// name. A relay that quietly writes its signing key next to its config the first
// time the Keychain is locked is exactly the failure this split exists to prevent.
//
// The secret is handed to `security` over stdin rather than argv, because argv is
// world-readable through ps for as long as the process lives.
//
// Keys are kept as a ring rather than a single value so that rotation is a real
// operation: sign with the newest, still verify against recent ones, and drop the
// stale ones. Rotating is also the revocation primitive -- dropping every old key
// invalidates every outstanding session at once, which is what you want at 2am
// when a phone goes missing.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { base64urlEncode, base64urlDecode, randomId } from './bytes.mjs';

export class KeyStoreError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'KeyStoreError';
  }
}

/** macOS login Keychain, via the `security` CLI. */
export class KeychainKeyStore {
  #service;
  #account;
  #run;

  constructor({ service = 'codex-relay-web', account = 'session-keyring', run } = {}) {
    this.#service = service;
    this.#account = account;
    // Injectable so the logic is testable off a Mac; production uses the real CLI.
    this.#run = run ?? ((args, input) => execFileSync('/usr/bin/security', args, {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
  }

  get description() {
    return `macOS Keychain (service=${this.#service}, account=${this.#account})`;
  }

  load() {
    try {
      const out = this.#run(['find-generic-password', '-a', this.#account, '-s', this.#service, '-w']);
      const trimmed = String(out).trim();
      return trimmed === '' ? null : trimmed;
    } catch (err) {
      // `security` exits 44 when the item simply does not exist yet -- that is a
      // first-run, not a failure. Anything else (locked keychain, denied access)
      // must surface loudly rather than look like "no key yet", which would
      // silently mint a new one and log every device out.
      if (err?.status === 44) return null;
      throw new KeyStoreError(
        `could not read the signing key from the Keychain; unlock it or grant access (security exited ${err?.status})`,
        { cause: err },
      );
    }
  }

  save(value) {
    try {
      // -U updates in place when the item already exists.
      this.#run(
        ['add-generic-password', '-a', this.#account, '-s', this.#service, '-U', '-w'],
        `${value}\n`,
      );
    } catch (err) {
      throw new KeyStoreError(`could not write the signing key to the Keychain (security exited ${err?.status})`, { cause: err });
    }
  }
}

/**
 * A 0600 file. Never selected automatically on macOS -- the caller must opt in,
 * because putting this key on disk is a real downgrade from the Keychain.
 */
export class FileKeyStore {
  #path;

  constructor(path) {
    this.#path = path;
  }

  get description() {
    return `file ${this.#path} (0600)`;
  }

  load() {
    if (!existsSync(this.#path)) return null;
    const raw = readFileSync(this.#path, 'utf8').trim();
    return raw === '' ? null : raw;
  }

  save(value) {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const tmp = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${value}\n`, { mode: 0o600 });
    renameSync(tmp, this.#path);
    try { chmodSync(this.#path, 0o600); } catch { /* best effort */ }
  }
}

/**
 * Pick a store. On macOS that is the Keychain unless the caller explicitly asks
 * for a file; elsewhere a file is the only option and still has to be requested.
 */
export function defaultKeyStore({ platform = process.platform, filePath, preferFile = false } = {}) {
  if (platform === 'darwin' && !preferFile) return new KeychainKeyStore();
  if (!filePath) {
    throw new KeyStoreError('a file-backed key store needs an explicit path (and on macOS, preferFile)');
  }
  return new FileKeyStore(filePath);
}

const KEY_BYTES = 32;
const DEFAULT_MAX_KEYS = 2;

/**
 * An ordered set of signing keys: newest first, used for signing; the rest are
 * accepted for verification until they age out.
 */
export class KeyRing {
  #store;
  #keys;
  #maxKeys;

  constructor(store, { maxKeys = DEFAULT_MAX_KEYS } = {}) {
    this.#store = store;
    this.#maxKeys = maxKeys;
    this.#keys = this.#load();
  }

  #load() {
    const raw = this.#store.load();
    if (raw === null) {
      const fresh = [this.#mint()];
      this.#persist(fresh);
      return fresh;
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (err) { throw new KeyStoreError('the stored signing keyring is not valid JSON', { cause: err }); }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new KeyStoreError('the stored signing keyring is empty or malformed');
    }
    return parsed.map((k) => ({ id: k.id, key: base64urlDecode(k.key), createdAt: k.createdAt }));
  }

  #mint() {
    return { id: randomId(8), key: new Uint8Array(randomBytes(KEY_BYTES)), createdAt: Date.now() };
  }

  #persist(keys = this.#keys) {
    this.#store.save(JSON.stringify(
      keys.map((k) => ({ id: k.id, key: base64urlEncode(k.key), createdAt: k.createdAt })),
    ));
  }

  /** The key new tokens are signed with. */
  current() {
    return this.#keys[0];
  }

  /** Look up a key by id for verification; null once it has aged out. */
  get(id) {
    return this.#keys.find((k) => k.id === id) ?? null;
  }

  /** Add a new signing key, keeping a bounded tail for in-flight sessions. */
  rotate() {
    this.#keys = [this.#mint(), ...this.#keys].slice(0, this.#maxKeys);
    this.#persist();
    return this.current().id;
  }

  /**
   * Drop every existing key and start over. This is the revocation hammer: every
   * outstanding session stops verifying immediately.
   */
  revokeAll() {
    this.#keys = [this.#mint()];
    this.#persist();
    return this.current().id;
  }

  get keyIds() {
    return this.#keys.map((k) => k.id);
  }
}
