// Being able to name a provider is part of the contract, and until now some of
// them could not be named: `selectProvider('ssh')` threw "unknown ingress
// provider" for the one route whose transport is already running on the
// resident machine.
//
// So these tests are mostly about *which refusal* comes back, which is why
// almost all of them are written on the refusal side.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVIDERS,
  PROVIDER_SHAPES,
  selectProvider,
  startProvider,
  validateProvider,
} from '../../src/relay/provider.mjs';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * The least each provider needs in order to be *constructed*. Nothing here
 * starts anything, dials anything or reads a credential -- construction is the
 * only thing under test.
 */
const CONSTRUCTABLE = {
  loopback: {},
  relay: { url: 'ws://127.0.0.1:1' },
  ssh: { host: 'example.invalid', remotePort: 8443 },
  // Defaults are a usable configuration (:443, https mode), so there is
  // nothing to pass. Constructing it spawns nothing -- the client is only
  // reached in start().
  tailscale: {},
};

test('every registered name builds a provider that satisfies the contract', () => {
  for (const [name, options] of Object.entries(CONSTRUCTABLE)) {
    const provider = selectProvider(name, options);
    assert.equal(validateProvider(provider), provider, `${name} must validate`);
    assert.ok(PROVIDER_SHAPES.includes(provider.shape), `${name} has a known shape`);
  }
});

test('the registry names every provider that exists', () => {
  // A provider that exists in the tree but not here is one an operator cannot
  // ask for, which is the exact defect this file was added for.
  assert.deepEqual(Object.keys(PROVIDERS).sort(), [
    'loopback',
    'relay',
    'ssh',
    'tailscale',
  ]);
  assert.deepEqual(Object.keys(CONSTRUCTABLE).sort(), Object.keys(PROVIDERS).sort());
});

test('the registry cannot be extended at runtime', () => {
  assert.throws(() => {
    'use strict';
    PROVIDERS.smuggled = () => {};
  }, TypeError);
});

test('an unknown name still lists the ones that do exist', () => {
  // The error is the only documentation some operators will read.
  // 'tailscale' stood in for "a name that does not exist" here until
  // tailscale became a provider, at which point this test failed -- which is
  // the test working. Use a name nobody will implement, and assert that it is
  // absent, so the next person to trip this gets told instead of puzzled.
  const ABSENT = 'telepathy';
  assert.ok(!(ABSENT in PROVIDERS), `${ABSENT} is a provider now; this test needs another absent name`);
  assert.throws(
    () => selectProvider(ABSENT),
    (err) => new RegExp(`unknown ingress provider ${ABSENT}`).test(err.message)
      && /tailscale/.test(err.message)
      && /ssh/.test(err.message),
  );
});

test('selecting by name does not swallow a provider\'s own construction refusals', () => {
  // The registry is a lookup, not a layer. A provider that refuses its options
  // has to refuse them just as loudly when it was reached by name.
  assert.throws(() => selectProvider('ssh', {}), /remote host/);
  assert.throws(() => selectProvider('ssh', { host: 'example.invalid' }), /remotePort/);
  assert.throws(() => selectProvider('relay', {}), /needs a relay url/);
});

test('a listener-configuring provider selected by name still needs a real target', async () => {
  // Registration must not let a provider skip the target check it shares with
  // every other provider of its shape.
  await assert.rejects(
    startProvider(selectProvider('ssh', CONSTRUCTABLE.ssh), { target: {}, logger: silent }),
    /needs target\.host and target\.port/,
  );
});
