// The two ceremonies, browser side: fetches and the two `navigator.credentials`
// calls. Everything fiddly lives in webauthn.mjs, so this file stays thin enough
// to read in one go.
//
// The session is an HttpOnly cookie. Nothing here reads `document.cookie` --
// it could not, and should not try. `credentials: 'same-origin'` is what carries
// the session, and "am I logged in?" is a question only the server can answer.
//
// Note that the server does not in fact answer it: /auth/status reports whether
// the relay has any passkey enrolled, and nothing about *this* browser. The one
// authority on whether this browser holds a valid session is the websocket
// upgrade, which is gated on the cookie. So the page does not ask; it connects,
// and treats a refused upgrade as "sign in again". See classifyDisconnect().

import { assertionRequestFrom, creationRequestFrom, assertionPayload, attestationPayload } from './webauthn.mjs';

/**
 * The HTTP surface this page expects. These paths are the browser half of a
 * contract with the surface process, whose handlers are a base64url-decode of
 * the binary fields followed by a spread into the matching `Ceremonies` method
 * (see the comment at the top of webauthn.mjs).
 *
 *   GET  status         -> {enrolled, app: {available, prefix}}
 *   POST loginBegin     -> Ceremonies.startLogin()
 *   POST loginFinish    <- {challengeId, credentialId, authenticatorData, clientDataJSON, signature}
 *                       -> {ok, expiresAt}
 *   POST enrollBegin    <- {bootstrapToken?}   -> Ceremonies.startEnrollment()
 *   POST enrollFinish   <- {challengeId, attestationObject, clientDataJSON, label?}
 *                       -> {ok, credentialId}
 */
export const ENDPOINTS = Object.freeze({
  status: '/auth/status',
  loginBegin: '/auth/login/begin',
  loginFinish: '/auth/login/finish',
  enrollBegin: '/auth/enroll/begin',
  enrollFinish: '/auth/enroll/finish',
  logout: '/auth/logout',
});

export class AuthError extends Error {
  constructor(message, { status = 0, cause } = {}) {
    super(message, { cause });
    this.name = 'AuthError';
    this.status = status;
  }
}

async function request(url, { method = 'POST', body } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      // Carries the HttpOnly session cookie. Without this the relay sees an
      // anonymous request and the whole page looks logged out.
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw new AuthError(`could not reach the relay (${url})`, { cause });
  }

  const text = await response.text();
  let parsed = null;
  if (text !== '') {
    try { parsed = JSON.parse(text); } catch { /* fall through to the status */ }
  }

  if (!response.ok) {
    // CeremonyError carries a human-readable message and a status; prefer it.
    const message = parsed?.error ?? parsed?.message ?? `${response.status} ${response.statusText}`;
    throw new AuthError(message, { status: response.status });
  }
  return parsed ?? {};
}

/**
 * Ask the relay whether it has any passkey enrolled, and whether it is serving
 * the real App.
 *
 * `enrolled` says nothing about the caller's own session -- see the note at the
 * top of this file. It decides one thing only: whether to offer "sign in" or
 * "enrol this device".
 *
 * `app` is the second question, and it is asked here rather than assumed
 * because the prefix is the surface's choice and the availability depends on
 * whether an archive was configured at all. A page that hardcoded the prefix
 * would navigate a relay with no App mounted straight into a 404 and strand the
 * user there, with the chat UI they could have used one redirect behind them.
 *
 * Both fields are normalised rather than passed through: a relay from before
 * this endpoint grew its second field answers without it, and the page has to
 * read that as "no App" rather than as a missing property it then dereferences.
 */
export async function fetchRelayStatus() {
  const body = await request(ENDPOINTS.status, { method: 'GET' });
  const prefix = body?.app?.prefix;
  const usable = typeof prefix === 'string' && prefix.startsWith('/') && prefix.endsWith('/');
  return {
    enrolled: body?.enrolled === true,
    // `available` is the server's claim AND a prefix we could actually navigate
    // to. The two are separate checks because a true flag with a malformed
    // prefix is the one combination that would turn a working chat page into a
    // navigation to nowhere.
    app: { available: body?.app?.available === true && usable, prefix: usable ? prefix : null },
  };
}

/**
 * Is the relay answering HTTP at all?
 *
 * Used to interpret a websocket that closed without ever opening. A refused
 * upgrade and a dead network are indistinguishable from the close event alone
 * (both surface as code 1006 with no detail), but they are easy to tell apart
 * by asking the server a plain HTTP question: an answer of any status means the
 * relay is up and chose to refuse us.
 *
 * Deliberately does not use request(): a 401 or a 503 is still an answer.
 */
export async function isRelayReachable() {
  try {
    await fetch(ENDPOINTS.status, { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    return true;
  } catch {
    return false;
  }
}

export function logout() {
  return request(ENDPOINTS.logout);
}

function describeCeremonyFailure(error, what) {
  // The DOMException names a UA throws are more useful than its messages.
  if (error?.name === 'NotAllowedError') {
    return new AuthError(`${what} was cancelled or timed out`, { cause: error });
  }
  if (error?.name === 'InvalidStateError') {
    return new AuthError('this device already has a passkey for the relay', { cause: error });
  }
  if (error?.name === 'SecurityError') {
    // Overwhelmingly the cause: the page's origin does not match the relay's
    // configured rpId, which no amount of retrying will fix.
    return new AuthError(
      `${what} was refused for this origin -- the relay's rpId must match ${location.hostname}`,
      { cause: error },
    );
  }
  if (error instanceof AuthError) return error;
  return new AuthError(`${what} failed: ${error?.message ?? String(error)}`, { cause: error });
}

/** Drive navigator.credentials.get() against the relay. Resolves to the session info. */
export async function login() {
  if (!globalThis.PublicKeyCredential) {
    throw new AuthError('this browser does not support passkeys');
  }
  const begun = await request(ENDPOINTS.loginBegin);
  const options = assertionRequestFrom(begun);

  let credential;
  try {
    credential = await navigator.credentials.get(options);
  } catch (error) {
    throw describeCeremonyFailure(error, 'the passkey prompt');
  }
  if (!credential) throw new AuthError('no passkey was returned');

  return request(ENDPOINTS.loginFinish, {
    body: assertionPayload(credential, { challengeId: begun.challengeId }),
  });
}

/**
 * Drive navigator.credentials.create(). Needs either a single-use bootstrap
 * token (first device) or an existing session (adding another), which the relay
 * checks before the phone is ever asked to buzz.
 */
export async function enroll({ bootstrapToken = null, label = '' } = {}) {
  if (!globalThis.PublicKeyCredential) {
    throw new AuthError('this browser does not support passkeys');
  }
  const begun = await request(ENDPOINTS.enrollBegin, {
    body: bootstrapToken ? { bootstrapToken } : {},
  });
  const options = creationRequestFrom(begun);

  let credential;
  try {
    credential = await navigator.credentials.create(options);
  } catch (error) {
    throw describeCeremonyFailure(error, 'passkey creation');
  }
  if (!credential) throw new AuthError('no passkey was created');

  return request(ENDPOINTS.enrollFinish, {
    body: attestationPayload(credential, { challengeId: begun.challengeId, label }),
  });
}

/**
 * Lift a bootstrap token out of the URL fragment, e.g. the QR code encodes
 * `https://relay.example.ts.net/#enroll=<token>`.
 *
 * The fragment rather than the query string on purpose: fragments are not sent
 * to the server, so the single-use token stays out of access logs. It is also
 * erased from the address bar immediately, so a screenshot or a shared tab does
 * not carry it, and it is never written anywhere else.
 */
export function takeBootstrapTokenFromUrl() {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (hash === '') return null;
  const token = new URLSearchParams(hash).get('enroll');
  if (!token) return null;
  try {
    history.replaceState(null, '', location.pathname + location.search);
  } catch { /* a failure to tidy the URL must not block enrolment */ }
  return token;
}
