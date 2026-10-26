// The edge between an environment and a provider.
//
// Everything here is about one failure shape and one only: a route that was
// asked for, a variable that was not set, and a process that carries on and
// serves a page nobody can reach. Six providers were fully implemented and
// fully tested before anything in src/ could select one, so these tests are
// written on the refusal side -- which variable is named, and whether the
// refusal happens at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROVIDERS } from '../../src/relay/provider.mjs';
import {
  DEFAULT_INGRESS,
  INGRESS_ENV,
  IngressConfigError,
  PROVIDER_REQUIREMENTS,
  describeIngress,
  ingressNames,
  resolveIngressConfig,
} from '../../src/relay/provider-config.mjs';

/** A full environment for a provider: every required variable, nothing else. */
function fullEnv(name, overrides = {}) {
  const env = { [INGRESS_ENV]: name };
  for (const entry of PROVIDER_REQUIREMENTS[name]) {
    if (!entry.required) continue;
    env[entry.variable] = entry.type === 'integer' ? '8443' : entry.type === 'boolean' ? 'true' : `value-for-${entry.option}`;
  }
  return { ...env, ...overrides };
}

/**
 * The error, not just the fact that there was one. node:assert's `throws`
 * returns nothing, and every test here is about *which* variable the refusal
 * names, so the error object has to come back.
 */
function refusal(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return assert.fail('expected a refusal, got a resolved configuration');
}

// ---- the table ------------------------------------------------------------

test('every registered provider can be configured, and nothing else is', () => {
  // A provider in PROVIDERS and not here is one an operator can name and
  // cannot configure: resolveIngressConfig would fall through to a refusal
  // that reads as "unknown" for a route that exists. This is the third place
  // that has to list the providers -- the other two are PROVIDERS itself and
  // test/relay/registry.test.mjs -- and it is listed on purpose rather than
  // derived, so adding a provider fails here until its variables are written.
  assert.deepEqual(Object.keys(PROVIDER_REQUIREMENTS).sort(), [
    'loopback',
    'relay',
    'ssh',
    'tailscale',
  ]);
  assert.deepEqual(Object.keys(PROVIDER_REQUIREMENTS).sort(), Object.keys(PROVIDERS).sort());
  assert.deepEqual(ingressNames(), Object.keys(PROVIDERS));
});

test('every row names a variable, an option and a consequence', () => {
  for (const name of Object.keys(PROVIDER_REQUIREMENTS)) {
    for (const entry of describeIngress(name)) {
      assert.match(entry.variable, /^CODEX_RELAY_[A-Z0-9_]+$/, `${name}: ${entry.variable}`);
      assert.ok(entry.option.length > 0, `${name}: ${entry.variable} must map to an option`);
      // The consequence is not decoration. It is the sentence an operator
      // reads at 1am, and a row without one produces a refusal that says a
      // variable is missing and not what that costs.
      assert.ok(entry.consequence.length > 10, `${name}: ${entry.variable} needs a real consequence`);
      assert.ok(['string', 'integer', 'boolean'].includes(entry.type));
    }
  }
});

test('the table cannot be edited at runtime', () => {
  assert.throws(() => {
    'use strict';
    PROVIDER_REQUIREMENTS.smuggled = [];
  }, TypeError);
  assert.throws(() => {
    'use strict';
    PROVIDER_REQUIREMENTS.relay[0].required = false;
  }, TypeError);
});

// ---- the default ----------------------------------------------------------

test('an unset ingress variable is loopback, and says it defaulted', () => {
  // Not a nicety: buildSurface is called with a minimal env by 31 existing
  // tests and with no env at all by a developer. Making this required would
  // turn the ordinary path into the unusual one.
  const resolved = resolveIngressConfig({});
  assert.deepEqual(resolved, { name: DEFAULT_INGRESS, options: {}, defaulted: true, variables: [] });
  assert.equal(resolved.name, 'loopback');
});

test('blank and whitespace are unset, not a provider named ""', () => {
  for (const raw of ['', '   ', '\n', '\t']) {
    const resolved = resolveIngressConfig({ [INGRESS_ENV]: raw });
    assert.equal(resolved.name, DEFAULT_INGRESS, JSON.stringify(raw));
    assert.equal(resolved.defaulted, true, JSON.stringify(raw));
  }
});

test('a named loopback is not a defaulted one', () => {
  // The near neighbour of the case above. They resolve to the same provider
  // and must not report the same thing: one of them means nobody chose.
  const resolved = resolveIngressConfig({ [INGRESS_ENV]: 'loopback' });
  assert.equal(resolved.name, 'loopback');
  assert.equal(resolved.defaulted, false);
});

test('the name is read from the env it was handed, never from process.env', () => {
  const leak = process.env[INGRESS_ENV];
  process.env[INGRESS_ENV] = 'ssh';
  try {
    assert.equal(resolveIngressConfig({}).name, 'loopback');
    assert.equal(resolveIngressConfig({}).defaulted, true);
  } finally {
    if (leak === undefined) delete process.env[INGRESS_ENV];
    else process.env[INGRESS_ENV] = leak;
  }
});

// ---- unknown names --------------------------------------------------------

test('an unknown ingress name is refused with the list of real ones', () => {
  // The refusal is not re-spelled here: selectProvider already lists every
  // legal name, and two lists would drift. What this asserts is that the
  // resolver forwards to it rather than inventing a second message.
  assert.throws(
    () => resolveIngressConfig({ [INGRESS_ENV]: 'telepathy' }),
    (err) => /unknown ingress provider telepathy/.test(err.message)
      && /loopback/.test(err.message)
      && /tailscale/.test(err.message),
  );
});

test('a near-miss name is refused rather than guessed at', () => {
  // These are the mistakes that actually happen: a plural, a different
  // separator, a capital. None of them may resolve to the thing they look
  // like -- a silently-wrong ingress is the failure this file is about.
  for (const name of ['Loopback', 'LOOPBACK', 'loop-back', 'relays', 'tailscale_funnel', 'tail-scale', 'ssh ingress']) {
    assert.throws(
      () => resolveIngressConfig({ [INGRESS_ENV]: name }),
      /unknown ingress provider/,
      `${name} must not resolve`,
    );
  }
});

test('a name with surrounding whitespace is the name', () => {
  // The outer edges are trimmed, because a variable set from a file or a
  // here-doc carries them. Pinned so nobody "fixes" this in either direction
  // by accident: `ssh ingress` above is still not a provider.
  assert.equal(resolveIngressConfig({ [INGRESS_ENV]: '  loopback  ' }).name, 'loopback');
});

// ---- missing variables ----------------------------------------------------

test('every required variable, dropped one at a time, is named in the refusal', () => {
  // Table-driven on purpose. A hand-written case per variable would cover the
  // ones somebody thought of; this covers the ones added later.
  let checked = 0;
  for (const name of Object.keys(PROVIDER_REQUIREMENTS)) {
    for (const entry of PROVIDER_REQUIREMENTS[name]) {
      if (!entry.required) continue;
      checked += 1;
      const env = fullEnv(name);
      delete env[entry.variable];
      const err = refusal(() => resolveIngressConfig(env));
      assert.ok(err instanceof IngressConfigError, `${entry.variable}: ${err.message}`);
      assert.equal(err.code, 'variable-required');
      assert.equal(err.variable, entry.variable);
      assert.ok(err.message.includes(entry.variable), err.message);
      // The consequence travels with the refusal. Without it the operator
      // knows a variable is missing and not why they should care.
      assert.ok(err.message.includes(entry.consequence), err.message);
      assert.ok(err.message.includes(name), err.message);
    }
  }
  // A floor, not a count: it exists to catch a loop that walked nothing, which
  // would otherwise pass as silently as a loop that checked everything. The
  // number is 4 rather than 10 because the two withheld providers carried seven
  // required variables between them; see relay/README.md.
  assert.ok(checked >= 4, `only ${checked} required variables were exercised`);
});

test('a required variable set to blank is as missing as an absent one', () => {
  // The near neighbour that a `in env` check would pass and a deployment
  // actually produces: `CODEX_RELAY_RELAY_URL=` in a unit file, or a shell
  // expansion of something unset.
  for (const blank of ['', ' ', '\t', '\n']) {
    const err = refusal(() => resolveIngressConfig(fullEnv('relay', { CODEX_RELAY_RELAY_URL: blank })));
    assert.ok(err instanceof IngressConfigError, err.message);
    assert.equal(err.code, 'variable-required');
    assert.equal(err.variable, 'CODEX_RELAY_RELAY_URL');
  }
});

test('an optional variable left unset is simply absent from the options', () => {
  const resolved = resolveIngressConfig(fullEnv('relay'));
  assert.equal(Object.hasOwn(resolved.options, 'token'), false);
  assert.deepEqual(resolved.variables, ['CODEX_RELAY_RELAY_URL', 'CODEX_RELAY_RELAY_END']);
});

// ---- mapping and coercion -------------------------------------------------

test('variables become the option names the provider factories declare', () => {
  const resolved = resolveIngressConfig({
    [INGRESS_ENV]: 'ssh',
    CODEX_RELAY_SSH_HOST: 'remote.example',
    CODEX_RELAY_SSH_REMOTE_PORT: '8443',
    CODEX_RELAY_SSH_USER: 'tunnel',
    CODEX_RELAY_SSH_ACK_GATEWAY_PORTS: 'true',
  });
  assert.equal(resolved.name, 'ssh');
  assert.deepEqual(resolved.options, {
    host: 'remote.example',
    remotePort: 8443,
    user: 'tunnel',
    acknowledgeRemoteGatewayPorts: true,
  });
  assert.equal(typeof resolved.options.remotePort, 'number');
});

test('an integer variable that is not an integer is refused, naming it', () => {
  // Number() would take most of these: Number(' 80 ') is 80, Number('') is 0
  // and Number('8443\n') is 8443. A port read out of a typo binds somewhere
  // surprising and looks like it worked, which is why this is strict.
  for (const bad of ['8443x', '80.5', '0x1f', '8_443', 'eight', '+']) {
    const err = refusal(() => resolveIngressConfig(fullEnv('ssh', { CODEX_RELAY_SSH_REMOTE_PORT: bad })));
    assert.ok(err instanceof IngressConfigError, `${bad}: ${err.message}`);
    assert.equal(err.code, 'variable-not-an-integer', `${bad}: ${err.message}`);
    assert.equal(err.variable, 'CODEX_RELAY_SSH_REMOTE_PORT');
  }
  // Surrounding whitespace is a shell artefact, not a typo.
  assert.equal(resolveIngressConfig(fullEnv('ssh', { CODEX_RELAY_SSH_REMOTE_PORT: ' 8443 ' })).options.remotePort, 8443);
});

test('an out-of-range port is refused by the provider, not silently clamped here', () => {
  // The resolver converts; the provider validates. 70000 parses as an integer
  // and must still not produce a running ingress, so this pins where that
  // refusal comes from.
  const resolved = resolveIngressConfig(fullEnv('ssh', { CODEX_RELAY_SSH_REMOTE_PORT: '70000' }));
  assert.equal(resolved.options.remotePort, 70000);
});

test('boolean variables take the words a unit file actually contains', () => {
  for (const [raw, expected] of [['1', true], ['true', true], ['TRUE', true], ['Yes', true], ['on', true],
    ['0', false], ['false', false], ['No', false], ['off', false]]) {
    const resolved = resolveIngressConfig(fullEnv('ssh', { CODEX_RELAY_SSH_ACK_GATEWAY_PORTS: raw }));
    assert.equal(resolved.options.acknowledgeRemoteGatewayPorts, expected, raw);
  }
});

test('a boolean variable that is neither is refused rather than read as true', () => {
  // The near neighbour that matters most: a waiver variable. `Boolean('no')`
  // is true, and this one's whole job is to be an explicit acknowledgement,
  // so anything but a word from the vocabulary has to stop the process.
  for (const bad of ['y', 'n', 'maybe', '2', 'truthy', 'oui']) {
    const err = refusal(() => resolveIngressConfig(fullEnv('ssh', { CODEX_RELAY_SSH_ACK_GATEWAY_PORTS: bad })));
    assert.ok(err instanceof IngressConfigError, `${bad}: ${err.message}`);
    assert.equal(err.code, 'variable-not-a-boolean', `${bad}: ${err.message}`);
    assert.equal(err.variable, 'CODEX_RELAY_SSH_ACK_GATEWAY_PORTS');
  }
});

// ---- secrets --------------------------------------------------------------

test('a secret variable reaches the options and never the reportable fields', () => {
  const token = 'not-a-real-token-but-treated-as-one';
  const resolved = resolveIngressConfig(fullEnv('relay', { CODEX_RELAY_RELAY_TOKEN: token }));
  assert.equal(resolved.options.token, token, 'the provider still gets it');
  // `variables` is what callers log. Names, never values.
  assert.deepEqual(resolved.variables, ['CODEX_RELAY_RELAY_URL', 'CODEX_RELAY_RELAY_END', 'CODEX_RELAY_RELAY_TOKEN']);
  assert.equal(JSON.stringify({ name: resolved.name, defaulted: resolved.defaulted, variables: resolved.variables }).includes(token), false);
  assert.equal(PROVIDER_REQUIREMENTS.relay.find((entry) => entry.option === 'token').secret, true);
});

test('a refusal about a secret variable does not echo what was found', () => {
  // There is no coercion failure for a string today, so this asserts the
  // property on the only path that can reach one: a secret row typed as
  // something other than a string would have to keep its value out of the
  // message, and the test says so before anybody adds one.
  const rows = Object.values(PROVIDER_REQUIREMENTS).flat().filter((entry) => entry.secret);
  assert.ok(rows.length > 0, 'at least one row is a secret, or this test is checking nothing');
  for (const entry of rows) {
    assert.equal(entry.type, 'string', `${entry.variable}: a non-string secret needs its own refusal test`);
  }
});
