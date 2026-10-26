// Where enrolled passkeys live, and where the short-lived ceremony secrets live.
//
// Two different lifetimes, two different homes:
//
//  - Credentials and the relying-party config are durable. They go to one JSON
//    file, written 0600, replaced atomically (temp + rename) so a crash mid-write
//    can never leave a half-file that locks you out of your own relay. A credential
//    record holds only a PUBLIC key and a counter -- nothing secret -- so the file
//    is sensitive (it is your allowlist) but not a key store.
//
//  - Challenges and one-time bootstrap tokens are ephemeral and single-use. They
//    stay in memory with a TTL and are consumed on first use. Persisting a
//    single-use secret across restarts would be strictly worse than losing it: a
//    dropped challenge just means "tap the button again", while a persisted one is
//    a replay window. So they are deliberately not written anywhere.

import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomId, timingSafeEqual } from './bytes.mjs';

export class CredentialStore {
  #path;
  #state;

  constructor(path) {
    this.#path = path;
    this.#state = this.#load();
  }

  #load() {
    if (!existsSync(this.#path)) {
      return { version: 1, rp: null, credentials: [] };
    }
    const raw = readFileSync(this.#path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1) throw new Error(`unsupported store version ${parsed.version}`);
    parsed.credentials ??= [];
    return parsed;
  }

  #persist() {
    const dir = dirname(this.#path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.#path);
    try { chmodSync(this.#path, 0o600); } catch { /* best effort on odd filesystems */ }
  }

  get relyingParty() {
    return this.#state.rp;
  }

  setRelyingParty({ id, name, origin }) {
    this.#state.rp = { id, name, origin };
    this.#persist();
    return this.#state.rp;
  }

  get isEnrolled() {
    return this.#state.credentials.length > 0;
  }

  listCredentials() {
    // Return copies so callers cannot mutate the store behind its back.
    return this.#state.credentials.map((c) => ({ ...c }));
  }

  findByCredentialId(credentialIdB64url) {
    return this.#state.credentials.find((c) => timingSafeEqual(c.id, credentialIdB64url)) ?? null;
  }

  /**
   * @param {{ id: string, spki: string, coseAlg: number, verify: object,
   *           signCount: number, label?: string, aaguid?: string,
   *           backupEligible?: boolean, backupState?: boolean }} record
   *   `id` and `spki` are base64url strings.
   */
  addCredential(record) {
    if (this.findByCredentialId(record.id)) {
      throw new Error('credential already enrolled');
    }
    const now = Date.now();
    this.#state.credentials.push({
      id: record.id,
      spki: record.spki,
      coseAlg: record.coseAlg,
      verify: record.verify,
      signCount: record.signCount ?? 0,
      label: record.label ?? 'passkey',
      aaguid: record.aaguid ?? null,
      backupEligible: record.backupEligible ?? false,
      backupState: record.backupState ?? false,
      createdAt: now,
      lastUsedAt: null,
    });
    this.#persist();
  }

  updateSignCount(credentialIdB64url, newSignCount) {
    const cred = this.findByCredentialId(credentialIdB64url);
    if (!cred) throw new Error('credential not found');
    cred.signCount = newSignCount;
    cred.lastUsedAt = Date.now();
    this.#persist();
  }

  removeCredential(credentialIdB64url) {
    const before = this.#state.credentials.length;
    this.#state.credentials = this.#state.credentials.filter(
      (c) => !timingSafeEqual(c.id, credentialIdB64url),
    );
    const removed = before !== this.#state.credentials.length;
    if (removed) this.#persist();
    return removed;
  }
}

/**
 * In-memory, single-use, TTL'd store for challenges and bootstrap tokens. One
 * instance can serve both kinds since both are "random id -> context, used once,
 * expires".
 */
export class EphemeralStore {
  #entries = new Map();
  #ttlMs;

  constructor({ ttlMs = 5 * 60 * 1000 } = {}) {
    this.#ttlMs = ttlMs;
  }

  /** Issue a fresh id bound to `context`, returns the id. */
  issue(context = {}, { ttlMs = this.#ttlMs, byteLength = 32 } = {}) {
    const id = randomId(byteLength);
    this.#entries.set(id, { context, expiresAt: Date.now() + ttlMs });
    this.#sweep();
    return id;
  }

  /** Look up without consuming (used to echo a challenge back during a ceremony). */
  peek(id) {
    const entry = this.#entries.get(id);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) { this.#entries.delete(id); return null; }
    return entry.context;
  }

  /** Consume: returns the context and removes the entry, or null if absent/expired. */
  consume(id) {
    const ctx = this.peek(id);
    if (ctx !== null) this.#entries.delete(id);
    return ctx;
  }

  #sweep() {
    const now = Date.now();
    for (const [id, entry] of this.#entries) {
      if (entry.expiresAt < now) this.#entries.delete(id);
    }
  }

  get size() {
    this.#sweep();
    return this.#entries.size;
  }
}
