// Where an ingress provider's options come from: the environment, in exactly
// one place.
//
// Until this file existed the registry in provider.mjs had six providers, a
// contract check and 149 passing tests -- and nothing under src/ or bin/
// imported it. The providers were selectable from a test and from nowhere
// else, which is a different defect from "the providers do not work" and reads
// identically from the outside: an operator who sets a variable gets a surface
// that listens on loopback and never says the variable was not read.
//
// This is that missing edge. Three decisions give it its shape:
//
//   1. Unset means loopback, and the caller says so out loud. buildSurface is
//      called with a minimal env by 31 existing tests and with none at all by
//      a developer running `node src/surface/main.mjs`; making the variable
//      mandatory would turn the ordinary path into the unusual one. But quiet
//      is not an option either -- the loopback ingress reports a real URL that
//      no phone can dial -- so the default is logged as a default.
//
//   2. A provider that was *named* and is missing a variable is a hard refusal
//      that names the variable and the consequence. The most expensive failure
//      this project has had is one unset variable producing a page that sits
//      there empty while every check reports green. "Ingress misconfigured" is
//      that same failure with extra steps.
//
//   3. The requirements are data, not a chain of ifs -- the shape
//      bin/imrelay.mjs's MISSING_FOR_LIVE is written in. The resolver walks the
//      table, bin/ingress.mjs prints it, and a test asserts it covers every
//      registered provider. A chain of ifs supports none of those three.
//
// What this file deliberately does NOT do: re-spell the list of provider names.
// An unknown name is handed to selectProvider, whose refusal already lists
// every legal one (provider.mjs:170). Two lists would drift and the wrong one
// would be the one an operator reads.

import { PROVIDERS, selectProvider } from './provider.mjs';

/** The one variable that chooses a route. */
export const INGRESS_ENV = 'CODEX_RELAY_INGRESS';

/** What an unset INGRESS_ENV resolves to. Reported, never silent. */
export const DEFAULT_INGRESS = 'loopback';

/**
 * A configuration refusal, with the variable as a field rather than only as
 * prose. `code` is for a caller that wants to branch; `variable` is for one
 * that wants to put the name somewhere a human will see it without parsing an
 * English sentence back apart.
 */
export class IngressConfigError extends Error {
  constructor(code, message, { variable = null, provider = null } = {}) {
    super(message);
    this.name = 'IngressConfigError';
    this.code = code;
    this.variable = variable;
    this.provider = provider;
  }
}

const TYPES = new Set(['string', 'integer', 'boolean']);
const TRUE_WORDS = new Set(['1', 'true', 'yes', 'on']);
const FALSE_WORDS = new Set(['0', 'false', 'no', 'off']);

/**
 * One row of the table, checked as it is built.
 *
 * The check runs at import time on purpose: a row missing its `consequence` is
 * a row whose refusal cannot say why it matters, and that is the one property
 * this whole file exists to have. Failing at import is noisy; a half-written
 * row that only misbehaves on the day somebody mistypes a variable is not.
 */
function row({ variable, option, type = 'string', required = false, secret = false, consequence }) {
  if (typeof variable !== 'string' || !variable.startsWith('CODEX_RELAY_')) {
    throw new Error(`an ingress requirement needs a CODEX_RELAY_* variable; got ${variable}`);
  }
  if (typeof option !== 'string' || option === '') throw new Error(`${variable} must name a provider option`);
  if (!TYPES.has(type)) throw new Error(`${variable} has unknown type ${type}`);
  if (typeof consequence !== 'string' || consequence === '') {
    throw new Error(`${variable} needs a consequence: a refusal that cannot say what breaks is not worth printing`);
  }
  return Object.freeze({ variable, option, type, required, secret, consequence });
}

const rows = (...entries) => Object.freeze(entries.map(row));

/**
 * Every variable each provider reads, what option it becomes, and what its
 * absence costs.
 *
 * Keys must match PROVIDERS exactly -- test/relay/provider-config.test.mjs
 * asserts that, because a provider that is registered and absent here is a
 * provider an operator can name and cannot configure.
 */
export const PROVIDER_REQUIREMENTS = Object.freeze({
  loopback: rows({
    variable: 'CODEX_RELAY_INGRESS_SCHEME',
    option: 'scheme',
    consequence: 'the reported url says http, which is wrong only if something in front of this is terminating https',
  }),

  relay: rows(
    {
      variable: 'CODEX_RELAY_RELAY_URL',
      option: 'url',
      required: true,
      consequence: 'there is no relay to dial out to, so nothing off this machine can reach the surface at all',
    },
    {
      variable: 'CODEX_RELAY_RELAY_END',
      option: 'end',
      required: true,
      consequence: 'the relay routes by end name; with none the provider has nothing to announce and a client has nothing to attach to',
    },
    {
      variable: 'CODEX_RELAY_RELAY_TOKEN',
      option: 'token',
      secret: true,
      consequence: 'a relay that requires a token refuses the control upgrade with 401 and the ingress never attaches',
    },
  ),

  ssh: rows(
    {
      variable: 'CODEX_RELAY_SSH_HOST',
      option: 'host',
      required: true,
      consequence: 'there is no remote to hold the public listener, which is the whole route',
    },
    {
      variable: 'CODEX_RELAY_SSH_REMOTE_PORT',
      option: 'remotePort',
      type: 'integer',
      required: true,
      consequence: 'sshd would be asked to bind nothing, and the reverse forward is the ingress',
    },
    { variable: 'CODEX_RELAY_SSH_USER', option: 'user', consequence: 'ssh falls back to the local login name on the remote' },
    { variable: 'CODEX_RELAY_SSH_PORT', option: 'sshPort', type: 'integer', consequence: 'sshd is assumed to be on 22' },
    {
      variable: 'CODEX_RELAY_SSH_REMOTE_BIND',
      option: 'remoteBindAddress',
      consequence: 'the remote listener binds 127.0.0.1, reachable only by something already on that host',
    },
    {
      variable: 'CODEX_RELAY_SSH_ACK_GATEWAY_PORTS',
      option: 'acknowledgeRemoteGatewayPorts',
      type: 'boolean',
      consequence: 'a non-loopback remote bind is refused at construction, because sshd silently downgrades it when GatewayPorts is no',
    },
    {
      variable: 'CODEX_RELAY_SSH_PUBLIC_URL',
      option: 'publicUrl',
      consequence: 'the provider reports no public url, so the enrolment link has to be built by hand',
    },
    { variable: 'CODEX_RELAY_SSH_TLS_VARIANT', option: 'tlsVariant', consequence: 'the forward is assumed to carry ciphertext (passthrough)' },
    { variable: 'CODEX_RELAY_SSH_IDENTITY_FILE', option: 'identityFile', consequence: 'ssh picks a key by its own rules' },
    { variable: 'CODEX_RELAY_SSH_IDENTITY_AGENT', option: 'identityAgent', consequence: 'ssh uses whatever SSH_AUTH_SOCK points at' },
    {
      variable: 'CODEX_RELAY_SSH_KNOWN_HOSTS',
      option: 'knownHostsFile',
      consequence: 'host-key checking uses the user default, which a service account may not have',
    },
    {
      variable: 'CODEX_RELAY_SSH_USE_USER_CONFIG',
      option: 'useUserConfig',
      type: 'boolean',
      consequence: 'the user ssh config is ignored, so a Host alias defined there will not resolve',
    },
  ),

  // Two further providers exist in the originating repository and are withheld
  // from this import pending a naming decision; see relay/README.md. Their rows
  // are withheld with them, which is why the keys of this table and the keys of
  // PROVIDERS still have to match exactly -- that equality is what makes a
  // forgotten set of variables go red instead of going quiet.

  // Written to spec and never run on the resident Mac: see VERIFIED_ON_RESIDENT
  // in providers/tailscale.mjs. The defaults (:443, https) are a usable
  // configuration, so all three of these are optional.
  tailscale: rows(
    { variable: 'CODEX_RELAY_TAILSCALE_PORT', option: 'funnelPort', type: 'integer', consequence: 'Funnel is asked for :443' },
    { variable: 'CODEX_RELAY_TAILSCALE_MODE', option: 'funnelMode', consequence: 'Funnel terminates TLS locally (https mode)' },
    { variable: 'CODEX_RELAY_TAILSCALE_PATH', option: 'tailscalePath', consequence: 'the tailscale client is looked up on PATH' },
  ),
});

/** Unset and set-to-blank are the same mistake, and both have to be caught. */
function present(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * One variable's text, turned into the type the option wants.
 *
 * A failure here names the variable and, unless the row is a secret, shows
 * what was found -- "CODEX_RELAY_SSH_REMOTE_PORT must be an integer" with no
 * sight of the offending value sends the reader back to the shell to guess.
 */
function coerce(entry, raw) {
  const text = raw.trim();
  if (entry.type === 'string') return text;
  const found = entry.secret ? 'a value this error will not echo' : JSON.stringify(text);
  if (entry.type === 'integer') {
    // Deliberately strict. Number('8443abc') is NaN but Number('') is 0 and
    // Number(' 80 ') is 80, and a port read out of a typo is the kind of thing
    // that binds somewhere surprising and looks like it worked.
    if (!/^-?\d+$/.test(text)) {
      throw new IngressConfigError(
        'variable-not-an-integer',
        `${entry.variable} must be an integer; found ${found}. ${entry.consequence}`,
        { variable: entry.variable },
      );
    }
    return Number(text);
  }
  const word = text.toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  throw new IngressConfigError(
    'variable-not-a-boolean',
    `${entry.variable} must be one of ${[...TRUE_WORDS].join('/')} or ${[...FALSE_WORDS].join('/')}; found ${found}`,
    { variable: entry.variable },
  );
}

/**
 * Resolve the ingress from an environment.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {{ name: string, options: object, defaulted: boolean, variables: string[] }}
 *   `variables` is the names of the variables that were read -- names only, so
 *   it is safe to log. `options` may contain a secret and is not.
 */
export function resolveIngressConfig(env = process.env) {
  const raw = env[INGRESS_ENV];
  if (!present(raw)) {
    return { name: DEFAULT_INGRESS, options: {}, defaulted: true, variables: [] };
  }
  const name = raw.trim();

  const requirements = PROVIDER_REQUIREMENTS[name];
  if (!requirements) {
    // Not our list to recite. selectProvider's refusal already names every
    // legal provider, so an unknown name is forwarded to it.
    selectProvider(name);
    // Reached only if a provider is registered and has no row here, which the
    // test suite forbids. Saying which half is missing beats a TypeError.
    throw new IngressConfigError(
      'requirements-missing',
      `${name} is a registered provider with no entry in PROVIDER_REQUIREMENTS, so there is no way to configure it`,
      { provider: name },
    );
  }

  const options = {};
  const variables = [];
  for (const entry of requirements) {
    const value = env[entry.variable];
    if (!present(value)) {
      if (!entry.required) continue;
      throw new IngressConfigError(
        'variable-required',
        `${INGRESS_ENV}=${name} needs ${entry.variable}, which is unset or empty. Without it: ${entry.consequence}.`,
        { variable: entry.variable, provider: name },
      );
    }
    options[entry.option] = coerce(entry, value);
    variables.push(entry.variable);
  }

  return { name, options, defaulted: false, variables };
}

/**
 * The table as lines of text, for bin/ingress.mjs and for an error that wants
 * to show an operator the whole route rather than one variable of it.
 */
export function describeIngress(name) {
  const requirements = PROVIDER_REQUIREMENTS[name];
  if (!requirements) throw new IngressConfigError('unknown-provider', `no requirements are recorded for ${name}`, { provider: name });
  return requirements.map((entry) => ({
    variable: entry.variable,
    option: entry.option,
    type: entry.type,
    required: entry.required,
    secret: entry.secret,
    consequence: entry.consequence,
  }));
}

/** Every configurable provider, in registry order. */
export function ingressNames() {
  return Object.keys(PROVIDERS);
}
