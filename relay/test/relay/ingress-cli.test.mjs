// The command that answers "which routes exist" and "what would start here".
//
// Both questions used to be answerable only by reading src/relay/provider.mjs,
// which is why the task that produced this work began with the belief that
// there was no registry at all. A listing an operator can run is the cheapest
// possible fix for that class of mistake, so it is worth a test that the
// listing is complete rather than merely non-empty.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS } from '../../src/relay/provider.mjs';
import { INGRESS_ENV, PROVIDER_REQUIREMENTS } from '../../src/relay/provider-config.mjs';
import { run } from '../../bin/ingress.mjs';

/** Run the CLI with a captured stdout and stderr. */
function cli(argv, env = {}) {
  let out = '';
  let err = '';
  const code = run(argv, { env, write: (text) => { out += text; }, fail: (text) => { err += text; } });
  return { code, out, err };
}

test('--list names every registered provider and every variable it reads', () => {
  const { code, out } = cli(['--list']);
  assert.equal(code, 0);
  for (const name of Object.keys(PROVIDERS)) {
    assert.ok(out.includes(`  ${name}\n`), `${name} is missing from the listing`);
  }
  // A listing that omits a variable is the defect this command exists to fix,
  // one level up.
  for (const rows of Object.values(PROVIDER_REQUIREMENTS)) {
    for (const entry of rows) {
      assert.ok(out.includes(entry.variable), `${entry.variable} is missing from the listing`);
      assert.ok(out.includes(entry.consequence), `${entry.variable}'s consequence is missing`);
    }
  }
  // The two honesty markers that must survive a reorganisation of this file.
  assert.match(out, /VERIFIED_ON_RESIDENT=false/);
  // The listing must not imply it is the whole set. Two routes are withheld
  // from this import, and a reader who cannot see that would read this short
  // list as "these are all the routes anyone has built".
  assert.match(out, /withheld from this import/);
  assert.match(out, /relay\/README\.md/);
});

test('--list --json is the same table, machine-readable', () => {
  const { code, out } = cli(['--list', '--json']);
  assert.equal(code, 0);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.map((entry) => entry.provider).sort(), Object.keys(PROVIDERS).sort());
});

test('--check on an empty environment reports the default rather than failing', () => {
  const { code, out } = cli(['--check']);
  assert.equal(code, 0);
  assert.match(out, /\(unset, defaulted to loopback\)/);
  assert.match(out, /this\n *machine only|machine only/);
});

test('--check names the missing variable and exits non-zero', () => {
  // The whole point of having the command: an operator who set the route and
  // not its variables finds out here instead of from a phone.
  const { code, out, err } = cli(['--check'], { [INGRESS_ENV]: 'relay' });
  assert.equal(code, 1);
  assert.equal(out, '');
  assert.match(err, /CODEX_RELAY_RELAY_URL/);
  assert.match(err, /nothing off this machine can reach the surface/);
});

test('--check on a configured route reports the provider and its shape', () => {
  const { code, out } = cli(['--check'], {
    [INGRESS_ENV]: 'relay',
    CODEX_RELAY_RELAY_URL: 'ws://127.0.0.1:1',
    CODEX_RELAY_RELAY_END: 'resident',
    CODEX_RELAY_RELAY_TOKEN: 'not-a-real-token-but-treated-as-one',
  });
  assert.equal(code, 0);
  assert.match(out, /provider +relay/);
  assert.match(out, /shape +outbound-multiplexing/);
  assert.match(out, /CODEX_RELAY_RELAY_TOKEN/);
  // Names, not values. --check is the command somebody will paste into a chat.
  assert.equal(out.includes('not-a-real-token-but-treated-as-one'), false, out);
});

test('--check --json prints no option values either', () => {
  const token = 'not-a-real-token-but-treated-as-one';
  const { code, out } = cli(['--check', '--json'], {
    [INGRESS_ENV]: 'relay',
    CODEX_RELAY_RELAY_URL: 'ws://127.0.0.1:1',
    CODEX_RELAY_RELAY_END: 'resident',
    CODEX_RELAY_RELAY_TOKEN: token,
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(out);
  assert.equal(parsed.provider, 'relay');
  assert.equal(parsed.defaulted, false);
  assert.deepEqual(parsed.variablesRead, ['CODEX_RELAY_RELAY_URL', 'CODEX_RELAY_RELAY_END', 'CODEX_RELAY_RELAY_TOKEN']);
  assert.equal(out.includes(token), false, out);
});

test('an unknown name is forwarded to the registry refusal', () => {
  const { code, err } = cli(['--check'], { [INGRESS_ENV]: 'telepathy' });
  assert.equal(code, 1);
  assert.match(err, /unknown ingress provider telepathy; have loopback/);
});

test('no arguments prints usage and fails, rather than doing something', () => {
  const { code, out } = cli([]);
  assert.equal(code, 2);
  assert.match(out, /usage: ingress/);
  const unknown = cli(['--start']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /unknown argument --start/);
  const both = cli(['--list', '--check']);
  assert.equal(both.code, 2);
  assert.match(both.err, /one at a time/);
});
