// Signed session cookies.
//
// A deliberately boring format -- `keyId.payload.signature`, all base64url, HMAC
// SHA-256 over `keyId.payload` -- because the interesting security properties
// here are not cryptographic novelty, they are the boring ones: the key id travels
// in the clear so rotation works, the signature covers the key id so it cannot be
// swapped, expiry is inside the signed payload rather than trusted from the
// cookie's own Max-Age, and comparison is constant-time.
//
// This is not a JWT. There is no algorithm field, so there is no "alg: none" and
// no algorithm-confusion attack; there is exactly one way to verify a token and it
// is not negotiable by the token itself.
//
// The cookie uses the `__Host-` prefix, which browsers only accept when it is
// Secure, Path=/ and has no Domain attribute. That makes the browser enforce the
// deployment rule we already need for WebAuthn -- HTTPS, exact host, no sibling
// subdomain can set or overwrite it.

import { createHmac } from 'node:crypto';
import { base64urlEncode, base64urlDecode, timingSafeEqual, randomId } from './bytes.mjs';

export class SessionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionError';
  }
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SESSION_COOKIE = '__Host-codex_relay';

const encoder = new TextEncoder();

function sign(key, signingInput) {
  return new Uint8Array(createHmac('sha256', Buffer.from(key)).update(signingInput).digest());
}

export class SessionManager {
  #keyring;
  #ttlMs;
  #cookieName;
  #sameSite;

  constructor(keyring, {
    ttlMs = DEFAULT_TTL_MS,
    cookieName = SESSION_COOKIE,
    sameSite = 'Lax',
  } = {}) {
    this.#keyring = keyring;
    this.#ttlMs = ttlMs;
    this.#cookieName = cookieName;
    this.#sameSite = assertSameSite(sameSite);
  }

  get cookieName() {
    return this.#cookieName;
  }

  /**
   * Mint a session token.
   * @param {{ subject: string, ttlMs?: number, extra?: object }} opts
   *   `subject` is the base64url credential id that authenticated.
   */
  issue({ subject, ttlMs = this.#ttlMs, extra = {} }) {
    if (typeof subject !== 'string' || subject === '') {
      throw new SessionError('a session needs a subject');
    }
    const now = Date.now();
    const payload = { v: 1, sub: subject, sid: randomId(12), iat: now, exp: now + ttlMs, ...extra };
    const encoded = base64urlEncode(encoder.encode(JSON.stringify(payload)));
    const { id, key } = this.#keyring.current();
    const signingInput = `${id}.${encoded}`;
    const signature = sign(key, signingInput);
    return { token: `${signingInput}.${base64urlEncode(signature)}`, payload };
  }

  /**
   * Verify a token. Returns the payload, or throws SessionError. Throwing rather
   * than returning null keeps the reason available for logging without tempting a
   * caller to treat a falsy return as "anonymous but fine".
   */
  verify(token) {
    if (typeof token !== 'string') throw new SessionError('missing session token');
    const parts = token.split('.');
    if (parts.length !== 3) throw new SessionError('malformed session token');
    const [keyId, encodedPayload, encodedSignature] = parts;

    const entry = this.#keyring.get(keyId);
    if (!entry) throw new SessionError('session was signed with a retired key');

    const expected = sign(entry.key, `${keyId}.${encodedPayload}`);
    let provided;
    try { provided = base64urlDecode(encodedSignature); }
    catch { throw new SessionError('malformed session signature'); }
    if (!timingSafeEqual(expected, provided)) throw new SessionError('bad session signature');

    let payload;
    try { payload = JSON.parse(Buffer.from(base64urlDecode(encodedPayload)).toString('utf8')); }
    catch { throw new SessionError('malformed session payload'); }

    if (payload.v !== 1) throw new SessionError(`unsupported session version ${payload.v}`);
    if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) {
      throw new SessionError('session expired');
    }
    return payload;
  }

  /** A Set-Cookie value carrying `token`. */
  cookie(token, { maxAgeMs = this.#ttlMs, sameSite = this.#sameSite } = {}) {
    return serializeCookie(this.#cookieName, token, {
      maxAgeSeconds: Math.floor(maxAgeMs / 1000),
      sameSite,
    });
  }

  /**
   * A Set-Cookie value that clears the session. It takes `sameSite` for the
   * same reason `cookie()` does, and a caller that overrides one must override
   * both: a deployment on Strict that cleared on Lax would be writing a logout
   * header that does not match the header it logs in with, which is the kind of
   * asymmetry nobody notices until a browser does.
   */
  clearCookie({ sameSite = this.#sameSite } = {}) {
    return serializeCookie(this.#cookieName, '', { maxAgeSeconds: 0, sameSite });
  }
}

/**
 * The only two SameSite values this design will serialize.
 *
 * `None` is refused rather than passed through: it is the one value that removes
 * the CSRF property the attribute is here for, and the browser would accept it
 * happily because the cookie is already Secure. Anything else is refused because
 * browsers treat an unrecognised SameSite as Lax *silently* -- a typo would
 * weaken nothing, say nothing, and leave the deployment believing it asked for
 * Strict. Refusing is the only version of this that can be noticed.
 */
export function assertSameSite(value) {
  if (value !== 'Lax' && value !== 'Strict') {
    throw new SessionError(`SameSite must be Lax or Strict, not ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Serialize a hardened cookie. SameSite defaults to Lax rather than Strict on
 * purpose: the enrolment flow starts by opening a link (or scanning a QR), and
 * Strict withholds the cookie on exactly that first cross-site top-level
 * navigation, so an already-enrolled phone would look logged out every time it
 * arrived from another app. Lax still withholds it from cross-site subrequests,
 * which is the CSRF property that matters here.
 *
 * A deployment that does its enrolment some other way can ask for Strict, and
 * asks *here* -- this is the one function that writes the attribute, so it is
 * the only place that can promise the value is one a browser honours. The
 * surface used to take the string this returns and rewrite the attribute inside
 * it, which worked and was still wrong twice over: it made a second owner of a
 * format only this file knows, and it rewrote the login cookie while leaving the
 * logout cookie on Lax, because a string rewrite at one call site only ever
 * fixes that one call site.
 */
export function serializeCookie(name, value, { maxAgeSeconds, sameSite = 'Lax' } = {}) {
  assertSameSite(sameSite);
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'Secure', `SameSite=${sameSite}`];
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

/** Parse a Cookie request header into a plain object. */
export function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || header === '') return out;
  for (const piece of header.split(';')) {
    const eq = piece.indexOf('=');
    if (eq === -1) continue;
    const name = piece.slice(0, eq).trim();
    if (name === '') continue;
    out[name] = piece.slice(eq + 1).trim();
  }
  return out;
}
