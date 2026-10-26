// The wiring itself: a surface that actually selects an ingress, starts it,
// and refuses to run when the configuration would produce a page nobody can
// use.
//
// Before this file, src/surface/main.mjs mentioned the word "provider" exactly
// zero times. The registry, six providers and 149 tests were on one side of a
// gap and the only entry point was on the other, so "the ingress providers
// work" was a statement about test/relay/ and about nothing a person could
// start. These tests are about the gap being closed, and the two things that
// could be got quietly wrong while closing it: the default has to stay usable
// for the 31 tests that call buildSurface with a minimal env, and a provider
// that renames this machine must not be allowed to invalidate the pinned
// relying party.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildIngress, buildSurface, startIngress } from '../../src/surface/main.mjs';
import { LISTENER_CONFIGURING, OUTBOUND_MULTIPLEXING } from '../../src/relay/provider.mjs';
import { INGRESS_ENV } from '../../src/relay/provider-config.mjs';
import { collectLogger, tempDir } from './harness.mjs';

const RP = { id: 'relay.example.net', origin: 'https://relay.example.net' };

/** The env a surface needs to be constructible, as test/surface/ spells it. */
function envIn(dir, overrides = {}) {
  return {
    CODEX_RELAY_STATE: dir,
    CODEX_RELAY_KEY_FILE: join(dir, 'session-key'),
    CODEX_RELAY_RP_ID: RP.id,
    CODEX_RELAY_RP_ORIGIN: RP.origin,
    CODEX_RELAY_UPSTREAM: 'ws://127.0.0.1:9/',
    CODEX_RELAY_LOG_LEVEL: 'error',
    // Ephemeral, so a test never collides with a running surface or with the
    // 8787 default.
    CODEX_RELAY_PORT: '0',
    ...overrides,
  };
}

// ---- selection ------------------------------------------------------------

test('with nothing configured the ingress is loopback, and the log says it defaulted', () => {
  const logger = collectLogger();
  const ingress = buildIngress({}, logger);
  assert.equal(ingress.name, 'loopback');
  assert.equal(ingress.defaulted, true);
  assert.equal(ingress.provider.shape, LISTENER_CONFIGURING);
  const line = logger.records.find((record) => record.event === 'surface.ingress_defaulted');
  assert.ok(line, logger.text());
  // The variable is named in the line, because the line's only job is to tell
  // an operator which knob they did not turn.
  assert.equal(line.variable, INGRESS_ENV);
  assert.match(line.consequence, /no phone can dial it/);
});

test('a named provider is selected and logged by name, with the variables it read', () => {
  const logger = collectLogger();
  const ingress = buildIngress({
    [INGRESS_ENV]: 'relay',
    CODEX_RELAY_RELAY_URL: 'ws://127.0.0.1:1',
    CODEX_RELAY_RELAY_END: 'resident',
  }, logger);
  assert.equal(ingress.name, 'relay');
  assert.equal(ingress.defaulted, false);
  assert.equal(ingress.provider.shape, OUTBOUND_MULTIPLEXING);
  const line = logger.records.find((record) => record.event === 'surface.ingress_selected');
  assert.deepEqual(line.variables, ['CODEX_RELAY_RELAY_URL', 'CODEX_RELAY_RELAY_END']);
});

test('a token is never written to the log that reports the selection', () => {
  const logger = collectLogger();
  const token = 'not-a-real-token-but-treated-as-one';
  buildIngress({
    [INGRESS_ENV]: 'relay',
    CODEX_RELAY_RELAY_URL: 'ws://127.0.0.1:1',
    CODEX_RELAY_RELAY_END: 'resident',
    CODEX_RELAY_RELAY_TOKEN: token,
  }, logger);
  assert.equal(logger.text().includes(token), false, logger.text());
  assert.ok(logger.text().includes('CODEX_RELAY_RELAY_TOKEN'), 'the name is not the secret');
});

test('a provider that needs a variable refuses before anything is built', () => {
  const dir = tempDir('relay-ingress-');
  assert.throws(
    () => buildSurface(envIn(dir, { [INGRESS_ENV]: 'relay' })),
    (err) => err.variable === 'CODEX_RELAY_RELAY_URL'
      && /CODEX_RELAY_RELAY_URL/.test(err.message)
      && /nothing off this machine can reach the surface/.test(err.message),
  );
});

test('an unknown ingress name refuses with the list of real ones', () => {
  const dir = tempDir('relay-ingress-');
  assert.throws(
    () => buildSurface(envIn(dir, { [INGRESS_ENV]: 'telepathy' })),
    /unknown ingress provider telepathy; have loopback/,
  );
});

test("a provider's own construction refusal is the one that comes out", () => {
  // The registry is a lookup, not a layer: ssh refuses a non-loopback remote
  // bind without the GatewayPorts waiver, and reaching it by name must not
  // soften that into "ingress misconfigured".
  const dir = tempDir('relay-ingress-');
  assert.throws(
    () => buildSurface(envIn(dir, {
      [INGRESS_ENV]: 'ssh',
      CODEX_RELAY_SSH_HOST: 'remote.example',
      CODEX_RELAY_SSH_REMOTE_PORT: '8443',
      CODEX_RELAY_SSH_REMOTE_BIND: '0.0.0.0',
    })),
    /GatewayPorts/,
  );
});

test('buildSurface hands back the chosen ingress and the pinned relying party', () => {
  const dir = tempDir('relay-ingress-');
  const built = buildSurface(envIn(dir));
  assert.equal(built.ingress.name, 'loopback');
  assert.equal(built.rpId, RP.id);
  // The three keys that existed before this change still exist.
  assert.ok(built.surface && built.ceremonies && built.origin === RP.origin);
});

// ---- starting -------------------------------------------------------------

test('the loopback ingress starts against a listening surface and serves a real request', async (t) => {
  const dir = tempDir('relay-ingress-');
  const { surface, ingress, rpId, logger } = buildSurface(envIn(dir));
  const address = await surface.listen();
  t.after(() => surface.close());

  const handle = await startIngress({ ingress, surface, rpId, logger: collectLogger() });
  t.after(() => handle.stop());

  assert.equal(handle.kind, 'loopback');
  assert.equal(handle.publicUrl, `http://127.0.0.1:${address.port}`);
  // A provider with no opinion about the relying party reports null rather
  // than undefined, so the caller's check needs no branch.
  assert.equal(handle.webauthnRpId, null);

  // The url the provider reported is the url that answers. This is the whole
  // claim: an ingress that reports an address nothing serves is the failure
  // shape this project keeps paying for.
  const response = await fetch(handle.publicUrl);
  assert.notEqual(response.status, 404);
  assert.ok((await response.text()).length > 0);
});

test('starting an ingress before the surface listens is a refusal, not a null port', async () => {
  const dir = tempDir('relay-ingress-');
  const { surface, ingress, rpId } = buildSurface(envIn(dir));
  await assert.rejects(
    () => startIngress({ ingress, surface, rpId, logger: collectLogger() }),
    /call surface\.listen\(\)/,
  );
});

/** A provider that reports whatever RP id it is told to, and records its stop. */
function renamingProvider(webauthnRpId, { shape = LISTENER_CONFIGURING } = {}) {
  const calls = { targets: [], stops: 0 };
  return {
    calls,
    provider: {
      name: 'renaming-test-provider',
      shape,
      async start({ target }) {
        calls.targets.push(target);
        return {
          kind: 'renaming-test-provider',
          publicUrl: 'https://somewhere.example/',
          webauthnRpId,
          stop() { calls.stops += 1; },
        };
      },
    },
  };
}

test('an ingress that renames this machine is refused, and stopped on the way out', async (t) => {
  // The failure being prevented: a Funnel hostname that is not the pinned
  // relying party means every passkey enrolled afterwards is registered
  // against an origin the browser will never validate. Nothing throws,
  // nothing logs, the phone simply never signs in. It cannot be checked
  // before start() -- the name does not exist until then -- so it is checked
  // immediately after, and the provider is stopped rather than left running.
  const dir = tempDir('relay-ingress-');
  const { surface, rpId, logger } = buildSurface(envIn(dir));
  await surface.listen();
  t.after(() => surface.close());

  const { provider, calls } = renamingProvider('mac.tailnet-abcd.ts.net');
  await assert.rejects(
    () => startIngress({ ingress: { name: 'tailscale', provider }, surface, rpId, logger }),
    (err) => /mac\.tailnet-abcd\.ts\.net/.test(err.message)
      && new RegExp(rpId.replace(/\./g, '\\.')).test(err.message)
      && /never validate/.test(err.message),
  );
  assert.equal(calls.stops, 1, 'a refused ingress does not stay running');
});

test('an ingress that reports the same name it was pinned as is allowed', async (t) => {
  // The near neighbour. If the check were written as "has a webauthnRpId at
  // all", this would fail -- and the tailscale route, which is the only reason
  // the field exists, would be unusable even when correctly configured.
  const dir = tempDir('relay-ingress-');
  const { surface, rpId, logger } = buildSurface(envIn(dir));
  await surface.listen();
  t.after(() => surface.close());

  const { provider, calls } = renamingProvider(RP.id);
  const handle = await startIngress({ ingress: { name: 'tailscale', provider }, surface, rpId, logger });
  t.after(() => handle.stop());
  assert.equal(handle.webauthnRpId, RP.id);
  assert.equal(calls.stops, 0);
});

test('the target satisfies both provider shapes from one object', async (t) => {
  // validateTarget only checks what the shape it was given needs, so one
  // target can feed both -- and it has to, because startIngress does not know
  // which shape it got and must not grow a branch that only runs in
  // production.
  const dir = tempDir('relay-ingress-');
  const { surface, rpId, logger } = buildSurface(envIn(dir));
  const address = await surface.listen();
  t.after(() => surface.close());

  for (const shape of [LISTENER_CONFIGURING, OUTBOUND_MULTIPLEXING]) {
    const { provider, calls } = renamingProvider(null, { shape });
    const handle = await startIngress({ ingress: { name: 'shape-test', provider }, surface, rpId, logger });
    const [target] = calls.targets;
    assert.equal(target.host, '127.0.0.1', shape);
    assert.equal(target.port, address.port, shape);
    assert.equal(target.url, `http://127.0.0.1:${address.port}`, shape);
    assert.equal(target.server, surface.server, shape);
    // The identity a provider falls back to is the pinned relying party, not
    // the provider's own name.
    assert.equal(target.name, RP.id, shape);
    await handle.stop();
  }
});
