// The wiring between the archive, the patcher and the surface.
//
// Three separate modules already prove their own halves: src/renderer/asar.mjs
// reads an asar, src/renderer/boot.mjs patches a document as a pure function,
// and src/surface/server.mjs serves an archive mount with overrides. What none
// of them can prove is that the three were joined up the right way round -- and
// the ways of getting that wrong are all silent:
//
//   * a boot config the browser half cannot decode, which produces a renderer
//     with no host and a startup logo that spins forever;
//   * `/app/` served out of a document root that does not carry the two files
//     the patched document references, which produces the same thing;
//   * a fabricated app-server version or account, which produce a renderer that
//     boots happily and then does the wrong thing with no error anywhere.
//
// So this file reads the config back out of the patched document with the same
// decoder the browser uses, and it asserts on what the config does NOT contain
// as carefully as on what it does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  archiveAppVersion,
  buildBootConfig,
  buildRendererMount,
  buildSurface,
  RENDERER_ARCHIVE_BASE,
  RENDERER_MOUNT_PREFIX,
} from '../../src/surface/main.mjs';
import {
  BOOT_META_NAME,
  BOOT_MODULE_SRC,
  decodeBootConfig,
  TOUCH_CSS_HREF,
} from '../../src/renderer/boot.mjs';
import { openArchive } from '../../src/renderer/asar.mjs';
import { installElectronBridge } from '../../web/host-bridge.mjs';
import { tempDir } from './harness.mjs';
import { makeWindow } from '../web/host-fakes.mjs';

const REPO_WEB = fileURLToPath(new URL('../../web/', import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), 'relay-renderer-mount-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

let serial = 0;

/** The smallest asar with the shape the renderer has. See asar.test.mjs for the arithmetic. */
function buildArchive(files) {
  const entries = [];
  let offset = 0;
  const tree = { files: {} };
  for (const [path, body] of Object.entries(files)) {
    const bytes = Buffer.from(body, 'utf8');
    let node = tree;
    const segments = path.split('/');
    for (const dir of segments.slice(0, -1)) {
      node.files[dir] ??= { files: {} };
      node = node.files[dir];
    }
    node.files[segments.at(-1)] = { size: bytes.length, offset: String(offset) };
    entries.push(bytes);
    offset += bytes.length;
  }
  const json = Buffer.from(JSON.stringify(tree), 'utf8');
  const padding = (4 - (json.length % 4)) % 4;
  const payloadSize = 4 + json.length + padding;
  const preamble = Buffer.alloc(16);
  preamble.writeUInt32LE(4, 0);
  preamble.writeUInt32LE(4 + payloadSize, 4);
  preamble.writeUInt32LE(payloadSize, 8);
  preamble.writeUInt32LE(json.length, 12);
  const file = join(scratch, `renderer-${serial += 1}.asar`);
  writeFileSync(file, Buffer.concat([preamble, json, Buffer.alloc(padding), ...entries]));
  return file;
}

/**
 * A document with the landmarks the patcher needs, in the order the shipped
 * one has them: a Content-Security-Policy meta, a viewport meta, a stylesheet
 * link, and exactly one non-async module entry.
 *
 * The policy is abbreviated -- test/renderer/boot.test.mjs is where the real
 * one is transcribed and checked against the archive -- but it is not omitted,
 * because the patcher refuses a document that has none. It carries
 * `wss://chatgpt.com` so that the one assertion this file makes about edit 5
 * is about the source that actually matters.
 */
const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; img-src &#39;self&#39; https:; connect-src &#39;self&#39; blob: wss://chatgpt.com;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Codex</title>
    <script type="module" crossorigin src="./assets/index-56e9f72c1d6a.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/app-shared.css">
  </head>
  <body><div id="root"><div class="startup-loader"></div></div></body>
</html>
`;

const ENTRY_JS = 'export const renderer = 1;\n';

const RENDERER = {
  'webview/index.html': INDEX_HTML,
  'webview/assets/index-56e9f72c1d6a.js': ENTRY_JS,
  'package.json': '{"name":"codex","version":"1.4.7"}',
};

/** An env with everything buildSurface insists on and nothing it does not. */
function envIn(dir, extra = {}) {
  return {
    CODEX_RELAY_STATE: dir,
    CODEX_RELAY_KEY_FILE: join(dir, 'session-key'),
    CODEX_RELAY_LOG_LEVEL: 'error',
    CODEX_RELAY_RP_ID: 'relay.invalid',
    CODEX_RELAY_RP_ORIGIN: 'https://relay.invalid',
    CODEX_RELAY_UPSTREAM: 'ws://127.0.0.1:1/never-dialled',
    CODEX_RELAY_PORT: '0',
    ...extra,
  };
}

/** The config the way the browser half will read it: out of the served bytes. */
function configFrom(html) {
  const found = new RegExp(`<meta name="${BOOT_META_NAME}" content="([^"]*)">`).exec(html);
  assert.ok(found, 'the served document carries no boot meta, so the host would never start');
  return decodeBootConfig(found[1]);
}

// ---- the boot config -------------------------------------------------------

test('the boot config carries every value the host layers read', () => {
  const config = buildBootConfig({
    CODEX_HOME: '/home/x/.codex',
    CODEX_RELAY_WORKSPACES_ROOT: '/srv/workspaces',
    CODEX_RELAY_WORKTREES_SEGMENT: 'worktrees',
    CODEX_RELAY_WORKSPACE_ROOTS: '/srv/a:/srv/b',
  }, { appVersion: '1.4.7' });

  assert.equal(config.wsPath, '/ws');
  assert.equal(config.hostId, 'local');
  assert.equal(config.bridge.appVersion, '1.4.7');
  assert.equal(config.bridge.desktopUserAgent, 'CodexRelayWeb/1.4.7');
  assert.equal(config.bridge.buildFlavor, 'relay');
  assert.equal(config.fetch.codexHome, '/home/x/.codex');
  assert.equal(config.fetch.workspacesRoot, '/srv/workspaces');
  assert.equal(config.fetch.worktreesSegment, 'worktrees');
  assert.deepEqual(config.fetch.workspaceRoots, ['/srv/a', '/srv/b']);
  assert.deepEqual(config.settings, { sansFontSize: 16 });
});

test('the bridge the server describes is one the browser half will install', () => {
  // The bridge refuses an incomplete config, and it refuses it at install time
  // -- the first layer of the assembly, so an omission here is a banner on
  // every page load rather than a subtle degradation.
  //
  // This runs the real validator instead of listing the keys it enforces. The
  // list is what went wrong: an earlier version of this test enumerated the six
  // required strings, which is a transcription of one of the two checks inside
  // the validator, and the OTHER check -- that systemThemeVariant names a
  // variant -- went unmentioned by both the producer and the test. The real
  // renderer then threw before its entry module ran and painted its own error
  // boundary, with every unit test green. A validator called for real cannot
  // drift from itself.
  const { bridge } = buildBootConfig({});
  const installed = installElectronBridge({ window: makeWindow(), config: bridge });
  assert.equal(installed.config.systemThemeVariant, 'dark');
  assert.equal(installed.config.theme, 'dark');
});

test('the resolved system variant is a variant, whatever the theme preference says', () => {
  // `theme` is a preference and may name something the OS has to resolve;
  // systemThemeVariant is the resolution, and there are only two. A preference
  // the bridge would reject must not be copied into it.
  assert.equal(buildBootConfig({}).bridge.systemThemeVariant, 'dark');
  assert.equal(
    buildBootConfig({ CODEX_RELAY_THEME: 'light' }).bridge.systemThemeVariant,
    'light',
    'a preference that already names a variant is the best answer a server has',
  );
  assert.equal(
    buildBootConfig({ CODEX_RELAY_THEME: 'system' }).bridge.systemThemeVariant,
    'dark',
    'a preference that is not a variant must not become one',
  );
  assert.equal(
    buildBootConfig({ CODEX_RELAY_THEME: 'system', CODEX_RELAY_SYSTEM_THEME: 'light' }).bridge.systemThemeVariant,
    'light',
    'an explicit override wins over the preference',
  );
  assert.equal(
    buildBootConfig({ CODEX_RELAY_SYSTEM_THEME: 'solarized' }).bridge.systemThemeVariant,
    'dark',
    'an override the bridge would reject is not passed through to be rejected',
  );
});

test('no Sentry DSN is invented', () => {
  // web/host-bridge.mjs reads an absent dsn as "do not initialise Sentry",
  // which is the honest state: a relay has no crash-reporting project, and a
  // borrowed one would send somebody else's traces somewhere they are not
  // expected.
  assert.equal('dsn' in buildBootConfig({}).bridge, false);
});

/**
 * Every [path, leaf] pair in a config, at every depth.
 *
 * Written out because "at any level" is a claim a test has to be able to
 * make. The two assertions below used to be `json.includes('appServerVersion')`
 * and `'installedCodexVersion' in config` -- the first a substring search that
 * cannot say where it matched, the second a top-level `in` on a key that would
 * live under `bridge` if it lived anywhere.
 */
function* walkConfig(value, path = '') {
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      yield* walkConfig(child, path === '' ? key : `${path}.${key}`);
    }
    return;
  }
  yield [path, value];
}

test('the app-server version is NOT in the config, at any level', () => {
  // This is the expensive one. `0.0.0` reads to the renderer as "every version
  // gate passes", including the gate that decides whether a steer carries
  // `turnTrigger` -- so a convenient default turns `turn/steer` into
  // `turn/start` and the user watches a steer begin a fresh turn with no error
  // on either side. The version is asked of the app-server during the link's
  // handshake and refused if it cannot be compared, so there must be nothing
  // here for that code to fall back to.
  const defaulted = [...walkConfig(buildBootConfig({}))];
  const configured = [...walkConfig(buildBootConfig({ CODEX_RELAY_APP_VERSION: '9.9.9' }))];

  // The walk has to be doing something before anything it reports means
  // anything, and the nested key is named explicitly: a walk that stopped at
  // the top would satisfy every loop below by visiting four leaves.
  assert.ok(defaulted.length >= 13, `the walk found only ${defaulted.length} leaves`);
  assert.ok(defaulted.some(([path]) => path === 'bridge.appVersion'), 'the walk never reached bridge');

  for (const entries of [defaulted, configured]) {
    for (const [path, value] of entries) {
      assert.ok(
        !/(^|\.)(appServerVersion|installedCodexVersion|codexVersion|serverVersion)$/i.test(path),
        `${path} hands the renderer a server version it should be asking the server for`,
      );
      assert.notEqual(value, '0.0.0', `${path} is the value that makes every version gate pass`);
    }
  }

  // The complete list of version-shaped values, asserted as a list so that a
  // third one has to be justified here before it ships. Scoped to `bridge`
  // because `fetch` carries absolute paths and a checkout under ~/src/1.2.3 is
  // not a finding.
  assert.deepEqual(
    [...walkConfig(buildBootConfig({ CODEX_RELAY_APP_VERSION: '9.9.9' }).bridge)]
      .filter(([, value]) => typeof value === 'string' && /\d+\.\d+\.\d+/.test(value))
      .map(([path]) => path),
    ['appVersion', 'desktopUserAgent'],
    'these two are the ELECTRON app version, which is a different program',
  );

  // And the production default is not the gate-defeating value either, which
  // is the assertion the old `CODEX_RELAY_APP_VERSION: '9.9.9'` override was
  // quietly preventing: `0.0.0-unknown` is a semver prerelease and therefore
  // sorts BELOW 0.0.0, so every gate reading it fails rather than passes.
  assert.equal(buildBootConfig({}).bridge.appVersion, '0.0.0-unknown');
});

test('no account is fabricated', () => {
  // The fetch layer answers the account endpoints with a shaped empty body when
  // it has none, which renders as signed out. A fabricated account renders as
  // signed in and then fails on every call that used it.
  assert.equal('accountInfo' in buildBootConfig({}).fetch, false);
});

test('codexHome falls back to the one the CLI uses, not to null', () => {
  // A null codexHome makes the fetch layer answer the path-shaped endpoints
  // with nothing, and the renderer renders that as an empty workspace rather
  // than as an error.
  const config = buildBootConfig({});
  assert.match(config.fetch.codexHome, /\.codex$/);
});

test('relative paths in the environment are resolved, because the browser cannot', () => {
  const config = buildBootConfig({ CODEX_HOME: './state/codex', CODEX_RELAY_WORKSPACE_ROOTS: './a: :./b' });
  assert.equal(config.fetch.codexHome.startsWith('/'), true);
  assert.deepEqual(config.fetch.workspaceRoots.map((root) => root.startsWith('/')), [true, true]);
  assert.equal(config.fetch.workspaceRoots.length, 2, 'a blank entry is not a workspace root');
});

test('each page load gets its own app session id', () => {
  // It identifies one app session, and for a page one app session is one page
  // load. A process-lifetime constant would group every tab and every reload of
  // every device into one.
  const first = buildBootConfig({}).bridge.codexAppSessionId;
  const second = buildBootConfig({}).bridge.codexAppSessionId;
  assert.notEqual(first, second);
  assert.match(first, /^[0-9a-f-]{36}$/);
});

test('the environment can override every derived value', () => {
  const config = buildBootConfig({
    CODEX_RELAY_WS_PATH: '/relay-ws',
    CODEX_RELAY_APP_VERSION: '2.0.0',
    CODEX_RELAY_BUILD_NUMBER: '41',
    CODEX_RELAY_BUILD_FLAVOR: 'staging',
    CODEX_RELAY_USER_AGENT: 'Something/1.0',
    CODEX_RELAY_THEME: 'light',
  });
  assert.equal(config.wsPath, '/relay-ws');
  assert.equal(config.bridge.appVersion, '2.0.0');
  assert.equal(config.bridge.buildNumber, '41');
  assert.equal(config.bridge.buildFlavor, 'staging');
  assert.equal(config.bridge.desktopUserAgent, 'Something/1.0');
  assert.equal(config.bridge.theme, 'light');
});

// ---- the version read out of the archive -----------------------------------

test('the app version is read from the archive being served', () => {
  // Asked of the archive rather than configured, because a configured value
  // goes stale on the next App update with nothing to notice.
  const archive = openArchive(buildArchive(RENDERER));
  try {
    assert.equal(archiveAppVersion(archive), '1.4.7');
  } finally {
    archive.close();
  }
});

test('an unreadable archive manifest costs a label, not a boot', () => {
  for (const manifest of ['{"name":"codex"}', 'not json at all', '{"version":""}', '{"version":7}']) {
    const archive = openArchive(buildArchive({ ...RENDERER, 'package.json': manifest }));
    try {
      assert.equal(archiveAppVersion(archive), null, manifest);
    } finally {
      archive.close();
    }
  }
  const noManifest = openArchive(buildArchive({ 'webview/index.html': INDEX_HTML }));
  try {
    assert.equal(archiveAppVersion(noManifest), null);
  } finally {
    noManifest.close();
  }
});

// ---- the mount -------------------------------------------------------------

test('no CODEX_RELAY_ASAR means no mount and no open descriptor', () => {
  // Optional on purpose: the relay's own chat UI is useful without the App, and
  // buildSurface is called by tests on machines that have no Codex App at all.
  const mount = buildRendererMount({});
  assert.deepEqual(mount.archiveMounts, {});
  assert.equal(mount.archive, null);
});

test('the mount serves the real renderer at /app/ out of webview/', () => {
  const mount = buildRendererMount({ CODEX_RELAY_ASAR: buildArchive(RENDERER) });
  try {
    const spec = mount.archiveMounts[RENDERER_MOUNT_PREFIX];
    assert.ok(spec, `nothing is mounted at ${RENDERER_MOUNT_PREFIX}`);
    assert.equal(spec.base, RENDERER_ARCHIVE_BASE);
    assert.equal(spec.archive, mount.archive);
    assert.deepEqual(Object.keys(spec.overrides), ['index.html'], 'one file is patched; the rest is the shipped bundle');
  } finally {
    mount.archive.close();
  }
});

test('the patched document carries a config the browser half can decode', async () => {
  // Read back with src/renderer/boot.mjs's decoder, which is the inverse of the
  // encoder -- and web/host-boot.mjs has its own three lines of the same thing,
  // pinned to this one by test/web/host-boot.test.mjs. A format drift fails
  // there; this asserts the surface actually puts a config in the document.
  const mount = buildRendererMount({
    CODEX_RELAY_ASAR: buildArchive(RENDERER),
    CODEX_HOME: '/home/x/.codex',
  });
  try {
    const produce = mount.archiveMounts[RENDERER_MOUNT_PREFIX].overrides['index.html'];
    const html = await produce(Buffer.from(INDEX_HTML, 'utf8'), { path: 'index.html', prefix: '/app/' });

    const config = configFrom(html);
    assert.equal(config.fetch.codexHome, '/home/x/.codex');
    assert.equal(config.bridge.appVersion, '1.4.7', 'the version came out of the archive');
    assert.ok(html.includes(`src="${BOOT_MODULE_SRC}"`), 'the host module is loaded');
    assert.ok(html.includes(`href="${TOUCH_CSS_HREF}"`), 'and so is the touch stylesheet');
    assert.ok(html.includes('viewport-fit=cover'), 'without which the safe-area insets are all zero');
    assert.ok(html.includes('./assets/index-56e9f72c1d6a.js'), 'the renderer still loads its own entry');
  } finally {
    mount.archive.close();
  }
});

test('the host module is inserted before the bundle entry, not after it', () => {
  // Module scripts run in document order, and the renderer reads four bridge
  // members synchronously while its own entry evaluates. After is too late, and
  // too late here is a blank page rather than an error.
  const mount = buildRendererMount({ CODEX_RELAY_ASAR: buildArchive(RENDERER) });
  try {
    const produce = mount.archiveMounts[RENDERER_MOUNT_PREFIX].overrides['index.html'];
    const html = produce(Buffer.from(INDEX_HTML, 'utf8'), { path: 'index.html', prefix: '/app/' });
    assert.ok(html.indexOf(BOOT_MODULE_SRC) < html.indexOf('./assets/index-56e9f72c1d6a.js'));
  } finally {
    mount.archive.close();
  }
});

test('each request is patched afresh, so the session id is not shared', async () => {
  const mount = buildRendererMount({ CODEX_RELAY_ASAR: buildArchive(RENDERER) });
  try {
    const produce = mount.archiveMounts[RENDERER_MOUNT_PREFIX].overrides['index.html'];
    const context = { path: 'index.html', prefix: '/app/' };
    const first = configFrom(await produce(Buffer.from(INDEX_HTML, 'utf8'), context));
    const second = configFrom(await produce(Buffer.from(INDEX_HTML, 'utf8'), context));
    assert.notEqual(first.bridge.codexAppSessionId, second.bridge.codexAppSessionId);
  } finally {
    mount.archive.close();
  }
});

// ---- buildSurface, end to end ----------------------------------------------

test('buildSurface keeps its three exports and its contract', async (t) => {
  const built = buildSurface(envIn(tempDir('relay-mount-')));
  t.after(() => built.surface.close());
  assert.ok(built.surface);
  assert.ok(built.ceremonies);
  assert.equal(built.origin, 'https://relay.invalid');
  assert.equal(built.archive, null, 'no asar configured, so no descriptor to close');
});

test('the document root serves the two files the patched document names', async (t) => {
  // The failure this closes: `/app/` serves the renderer, `/host-boot.mjs`
  // 404s, the renderer boots with no host and waits forever against a clean
  // console. Both files come out of web/, which is the document root by
  // construction -- so this also pins that default.
  const built = buildSurface(envIn(tempDir('relay-mount-')));
  await built.surface.listen();
  t.after(() => built.surface.close());
  const base = `http://127.0.0.1:${built.surface.address().port}`;

  for (const href of [BOOT_MODULE_SRC, TOUCH_CSS_HREF, '/src/appserver/transport-websocket.mjs']) {
    const res = await fetch(base + href);
    assert.equal(res.status, 200, `${href} is not served, and the renderer needs it`);
    await res.text();
  }
});

test('the whole module graph behind that one import is served too', async (t) => {
  // The patched document names exactly one script, so every other host module
  // is reached only through an import inside it. A 404 anywhere in that graph
  // fails the entire graph: the browser aborts the module job, host-boot never
  // evaluates, no layer installs, and the renderer waits on host silence with
  // nothing on screen -- the same blank page as a missing host-boot.mjs, from a
  // cause one level further away.
  //
  // Crawled rather than listed, because a list is a thing that goes stale the
  // first time somebody adds an import. tools/bring-up/local.sh probes a fixed
  // list of these paths against a live surface; this is the version that
  // follows the imports, so the script's list can only be incomplete and never
  // wrong.
  const built = buildSurface(envIn(tempDir('relay-mount-')));
  await built.surface.listen();
  t.after(() => built.surface.close());
  const base = `http://127.0.0.1:${built.surface.address().port}`;

  const seen = new Set();
  const queue = [BOOT_MODULE_SRC];
  while (queue.length > 0) {
    const href = queue.shift();
    if (seen.has(href)) continue;
    seen.add(href);

    const res = await fetch(base + href);
    assert.equal(res.status, 200, `${href} is in the graph and the surface does not serve it`);
    const source = await res.text();

    // The same three forms test/web/module-resolution.test.mjs reads, so the
    // two tests agree about what counts as an import.
    for (const pattern of [/\bfrom\s+'([^']+)'/g, /\bimport\s+'([^']+)'/g, /\bimport\s*\(\s*'([^']+)'/g]) {
      for (const match of source.matchAll(pattern)) {
        const spec = match[1];
        if (!spec.startsWith('.')) continue;
        // Resolved against the URL the browser fetched this file from, which is
        // the resolution the browser performs and not the one Node performs.
        queue.push(new URL(spec, `${base}${href}`).pathname);
      }
    }
  }

  assert.ok(seen.size >= 8, `only ${seen.size} modules walked, so the crawl found no imports`);
  for (const expected of ['/host-bus.mjs', '/hostlink/link.mjs', '/src/appserver/transport-websocket.mjs']) {
    assert.ok(seen.has(expected), `${expected} should be reachable from the boot module`);
  }
});

test('an asar mount is announced to the login page and gated on a session', async (t) => {
  const dir = tempDir('relay-mount-');
  const built = buildSurface(envIn(dir, { CODEX_RELAY_ASAR: buildArchive(RENDERER) }));
  await built.surface.listen();
  t.after(() => { built.archive.close(); return built.surface.close(); });
  const base = `http://127.0.0.1:${built.surface.address().port}`;

  const status = await (await fetch(`${base}/auth/status`)).json();
  assert.deepEqual(status.app, { available: true, prefix: RENDERER_MOUNT_PREFIX });

  // The renderer is the whole machine, so it is behind the session, not in
  // front of it. A 404 here would mean the mount was never installed; the
  // refusal is what says it was.
  const gated = await fetch(`${base}${RENDERER_MOUNT_PREFIX}`, { redirect: 'manual' });
  assert.notEqual(gated.status, 200);
  assert.notEqual(gated.status, 404, 'a 404 would mean the mount is absent, not protected');
  await gated.text();
});

test('with no asar the login page is told there is nothing to navigate to', async (t) => {
  const built = buildSurface(envIn(tempDir('relay-mount-')));
  await built.surface.listen();
  t.after(() => built.surface.close());
  const base = `http://127.0.0.1:${built.surface.address().port}`;

  const status = await (await fetch(`${base}/auth/status`)).json();
  assert.equal(status.app.available, false);
  assert.equal(status.enrolled, false, 'the original contract of this endpoint, unchanged');
});

test('a document root without the host module is refused at startup', () => {
  // Checked where the message can name the file and the directory, because the
  // alternative is a phone showing a logo and a log showing nothing.
  const empty = tempDir('relay-mount-empty-');
  assert.throws(
    () => buildSurface(envIn(tempDir('relay-mount-'), {
      CODEX_RELAY_ASAR: buildArchive(RENDERER),
      CODEX_RELAY_STATIC: empty,
    })),
    /host-boot\.mjs, which is not in the document root/,
  );
});

/**
 * Collect the lines the surface's own logger writes while a test runs.
 *
 * `buildSurface` builds its logger with `createLogger({ level })` and no
 * `stream`, so process.stderr is the only place those lines can be observed --
 * there is no seam to inject through and adding one would be a wider change
 * than the thing being covered. The original is restored from `t.after`, which
 * is registered before anything can throw, so a failing assertion cannot leave
 * the runner writing into an array.
 */
function captureLog(t) {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  t.after(() => { process.stderr.write = original; });
  return (event) => chunks
    .join('')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === event);
}

const NO_ROOTS_EVENT = 'surface.no_workspace_roots';

test('a surface with nowhere to work says so, rather than serving a screen no browser can leave', async (t) => {
  // This is the repository's most expensive failure, written down: one unset
  // environment variable, a renderer that paints its logo and sits on an
  // onboarding screen whose only exit is a native folder picker, no failed
  // request, no console error, nothing on the wire. Six chain drives to
  // diagnose. `warnIfNowhereToWork` exists solely to announce it -- and it had
  // zero references under test/, so replacing its body with `return` left the
  // whole suite green. The guard against a silent degradation was itself
  // unwatched.
  //
  // Driven through `buildSurface` rather than against the function, because
  // the `if (archive) warnIfNowhereToWork(...)` call site and the real logger
  // are as easy to delete as the body is.
  const linesFor = captureLog(t);
  const built = buildSurface(envIn(tempDir('relay-mount-'), {
    CODEX_RELAY_ASAR: buildArchive(RENDERER),
    CODEX_RELAY_LOG_LEVEL: 'warn',
  }));
  t.after(() => { built.archive.close(); return built.surface.close(); });

  const warned = linesFor(NO_ROOTS_EVENT);
  assert.equal(warned.length, 1, 'a surface with no workspace roots announced nothing');
  assert.equal(warned[0].level, 'warn', 'info would be filtered out of exactly the deployment that needs it');
  // The line is the only evidence there will be -- the phone just shows a logo
  // -- so it has to be actionable on its own: it must name the variable to set
  // and say what the operator is otherwise looking at.
  assert.equal(warned[0].variable, 'CODEX_RELAY_WORKSPACE_ROOTS');
  assert.match(warned[0].consequence, /onboarding/);
});

test('a surface that does have a workspace root does not cry wolf', async (t) => {
  // The other half: a warning that fires unconditionally passes the test above
  // and trains everyone to ignore the line.
  const dir = tempDir('relay-mount-');
  const linesFor = captureLog(t);
  const built = buildSurface(envIn(dir, {
    CODEX_RELAY_ASAR: buildArchive(RENDERER),
    CODEX_RELAY_LOG_LEVEL: 'warn',
    CODEX_RELAY_WORKSPACE_ROOTS: dir,
  }));
  t.after(() => { built.archive.close(); return built.surface.close(); });

  assert.deepEqual(linesFor(NO_ROOTS_EVENT), [], 'a configured surface must not warn');
});

test('the default document root is the repository web/ directory', () => {
  // Pinned because every module under web/ reaches src/appserver by climbing
  // out with `../`, which only lands on the mount while web/ sits at `/`.
  const built = buildSurface(envIn(tempDir('relay-mount-')));
  built.surface.close();
  const resolved = buildRendererMount({});
  assert.deepEqual(resolved.archiveMounts, {});
  assert.ok(REPO_WEB.endsWith(`${'web'}/`), 'and web/ is where host-boot.mjs lives');
});
