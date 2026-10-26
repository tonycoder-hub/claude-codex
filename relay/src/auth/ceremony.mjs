// The two ceremonies, as plain logic with no HTTP in sight.
//
// Keeping this transport-free is what lets the whole authentication story be
// tested without a browser, a phone, or a listening socket -- the HTTP layer
// above becomes a thin translation of these calls into requests and cookies.
//
// The gate that matters is on enrolment, not on attestation. Anyone who can reach
// the relay could ask to register a passkey, so "may this credential be added?"
// is answered by one of exactly two things: a single-use bootstrap token (the
// first device, delivered out of band as a QR on the resident machine's own
// screen), or an already-valid session (adding a second device from the first).
// There is no third path, and in particular an empty credential store does not
// implicitly authorise enrolment -- otherwise the window between starting the
// relay and enrolling your phone would be an open door.

import { verifyRegistration, verifyAssertion } from './webauthn.mjs';
import { base64urlEncode, base64urlDecode } from './bytes.mjs';

export class CeremonyError extends Error {
  constructor(message, { status = 400 } = {}) {
    super(message);
    this.name = 'CeremonyError';
    this.status = status;
  }
}

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
// Advertised in preference order. ES256 first because it is what essentially
// every platform authenticator mints; the others cost nothing to accept.
const PUBKEY_PARAMS = [
  { type: 'public-key', alg: -7 },    // ES256
  { type: 'public-key', alg: -8 },    // EdDSA
  { type: 'public-key', alg: -257 },  // RS256
];

export class Ceremonies {
  #store;
  #challenges;
  #bootstrap;
  #sessions;
  #requireUserVerification;

  /**
   * @param {object} deps
   * @param {import('./store.mjs').CredentialStore} deps.credentials
   * @param {import('./store.mjs').EphemeralStore} deps.challenges
   * @param {import('./store.mjs').EphemeralStore} deps.bootstrapTokens
   * @param {import('./session.mjs').SessionManager} deps.sessions
   */
  constructor({ credentials, challenges, bootstrapTokens, sessions, requireUserVerification = true }) {
    this.#store = credentials;
    this.#challenges = challenges;
    this.#bootstrap = bootstrapTokens;
    this.#sessions = sessions;
    this.#requireUserVerification = requireUserVerification;
  }

  get relyingParty() {
    const rp = this.#store.relyingParty;
    if (!rp) throw new CeremonyError('the relying party is not configured yet', { status: 503 });
    return rp;
  }

  /** Mint a single-use enrolment token. The bootstrap CLI renders this as a QR. */
  issueBootstrapToken({ ttlMs = 10 * 60 * 1000, label = 'first device' } = {}) {
    return this.#bootstrap.issue({ label }, { ttlMs });
  }

  get isEnrolled() {
    return this.#store.isEnrolled;
  }

  /**
   * Options for navigator.credentials.create(). Authorisation is checked here
   * rather than only at completion, so an unauthorised caller cannot even make
   * the phone buzz.
   */
  startEnrollment({ bootstrapToken = null, sessionToken = null } = {}) {
    const authorization = this.#authorizeEnrollment({ bootstrapToken, sessionToken });
    const rp = this.relyingParty;

    const challengeId = this.#challenges.issue(
      { purpose: 'enroll', authorization },
      { ttlMs: CHALLENGE_TTL_MS },
    );

    return {
      challengeId,
      publicKey: {
        rp: { id: rp.id, name: rp.name },
        // A single-user relay still needs a stable user handle so the
        // authenticator groups every device under one account instead of
        // offering a fresh "account" per passkey.
        user: {
          id: base64urlEncode(new TextEncoder().encode('codex-relay-owner')),
          name: rp.name,
          displayName: rp.name,
        },
        challenge: challengeId,
        pubKeyCredParams: PUBKEY_PARAMS,
        timeout: CHALLENGE_TTL_MS,
        attestation: 'none',
        // Refuse to re-enrol a key this relay already knows; the browser greys it
        // out instead of creating a confusing duplicate.
        excludeCredentials: this.#store.listCredentials().map((c) => ({ type: 'public-key', id: c.id })),
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: this.#requireUserVerification ? 'required' : 'preferred',
        },
      },
    };
  }

  #authorizeEnrollment({ bootstrapToken, sessionToken }) {
    if (bootstrapToken) {
      // Peeked, not consumed: a token must survive startEnrollment so the user can
      // retry a cancelled Face ID prompt. It is consumed on success instead.
      const ctx = this.#bootstrap.peek(bootstrapToken);
      if (!ctx) throw new CeremonyError('that enrolment link has expired or been used', { status: 403 });
      return { via: 'bootstrap', token: bootstrapToken, label: ctx.label };
    }
    if (sessionToken) {
      let payload;
      try { payload = this.#sessions.verify(sessionToken); }
      catch { throw new CeremonyError('session is not valid for enrolling another device', { status: 403 }); }
      if (!this.#store.findByCredentialId(payload.sub)) {
        throw new CeremonyError('the credential behind this session has been removed', { status: 403 });
      }
      return { via: 'session', label: 'additional device' };
    }
    throw new CeremonyError('enrolling a passkey needs a bootstrap link or an existing session', { status: 403 });
  }

  /** Verify a create() response, store the credential, and return a session. */
  finishEnrollment({ challengeId, attestationObject, clientDataJSON, label }) {
    const ctx = this.#challenges.consume(challengeId);
    if (!ctx || ctx.purpose !== 'enroll') {
      throw new CeremonyError('unknown or expired enrolment challenge', { status: 403 });
    }
    const rp = this.relyingParty;

    const result = verifyRegistration({
      attestationObject,
      clientDataJSON,
      expectedChallenge: base64urlDecode(challengeId),
      expectedOrigin: rp.origin,
      expectedRpId: rp.id,
      requireUserVerification: this.#requireUserVerification,
    });

    const credentialId = base64urlEncode(result.credentialId);
    if (this.#store.findByCredentialId(credentialId)) {
      throw new CeremonyError('that passkey is already enrolled', { status: 409 });
    }

    this.#store.addCredential({
      id: credentialId,
      spki: base64urlEncode(result.spki),
      coseAlg: result.coseAlg,
      verify: result.verify,
      signCount: result.signCount,
      label: label ?? ctx.authorization.label ?? 'passkey',
      aaguid: result.aaguid ? base64urlEncode(result.aaguid) : null,
      backupEligible: result.backupEligible,
      backupState: result.backupState,
    });

    // Burn the bootstrap token only now that a credential actually exists, so a
    // ceremony the user cancelled does not cost them the link.
    if (ctx.authorization.via === 'bootstrap') {
      this.#bootstrap.consume(ctx.authorization.token);
    }

    const { token } = this.#sessions.issue({ subject: credentialId, extra: { label: label ?? 'passkey' } });
    return { credentialId, sessionToken: token, backedUp: result.backupState };
  }

  /** Options for navigator.credentials.get(). */
  startLogin() {
    const rp = this.relyingParty;
    if (!this.#store.isEnrolled) {
      throw new CeremonyError('no passkey is enrolled on this relay yet', { status: 409 });
    }
    const challengeId = this.#challenges.issue({ purpose: 'login' }, { ttlMs: CHALLENGE_TTL_MS });
    return {
      challengeId,
      publicKey: {
        rpId: rp.id,
        challenge: challengeId,
        timeout: CHALLENGE_TTL_MS,
        allowCredentials: this.#store.listCredentials().map((c) => ({ type: 'public-key', id: c.id })),
        userVerification: this.#requireUserVerification ? 'required' : 'preferred',
      },
    };
  }

  /** Verify a get() response and return a session token. */
  finishLogin({ challengeId, credentialId, authenticatorData, clientDataJSON, signature }) {
    const ctx = this.#challenges.consume(challengeId);
    if (!ctx || ctx.purpose !== 'login') {
      throw new CeremonyError('unknown or expired login challenge', { status: 403 });
    }
    const credential = this.#store.findByCredentialId(credentialId);
    if (!credential) throw new CeremonyError('unknown credential', { status: 403 });

    const rp = this.relyingParty;
    const { newSignCount } = verifyAssertion({
      authenticatorData,
      clientDataJSON,
      signature,
      expectedChallenge: base64urlDecode(challengeId),
      expectedOrigin: rp.origin,
      expectedRpId: rp.id,
      credentialSpki: base64urlDecode(credential.spki),
      verifyDescriptor: credential.verify,
      storedSignCount: credential.signCount,
      requireUserVerification: this.#requireUserVerification,
    });

    this.#store.updateSignCount(credentialId, newSignCount);
    const { token, payload } = this.#sessions.issue({
      subject: credentialId,
      extra: { label: credential.label },
    });
    return { sessionToken: token, expiresAt: payload.exp, label: credential.label };
  }

  /**
   * Authenticate an incoming request's session token. Re-checks the credential
   * still exists, so removing a device immediately kills its sessions without
   * waiting for key rotation.
   */
  authenticate(sessionToken) {
    const payload = this.#sessions.verify(sessionToken);
    const credential = this.#store.findByCredentialId(payload.sub);
    if (!credential) throw new CeremonyError('the credential behind this session was removed', { status: 401 });
    return { ...payload, credential };
  }
}
