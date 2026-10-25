// Two resolvers read every module under `web/`: Node, running this suite, and a
// browser that was handed that same directory as its document root. A relative
// specifier satisfies both only while every served directory sits at the URL
// path that mirrors its repository path -- which is exactly what the mount in
// `src/surface/main.mjs` exists to arrange, and what its own comment says it is
// for. Get that right and a cross-directory import needs no import map and no
// build step. Get it wrong and the page 404s on a file the test suite imported
// without complaint five seconds earlier.
//
// So this file checks that the two resolvers still agree, for every specifier in
// the directory, rather than for the two somebody remembered. They stopped
// agreeing once: the hostlink wiring imported `../../web/host-bus.mjs`, which is
// correct in Node and `/web/host-bus.mjs` -- a 404 -- in the browser. It was
// caught by reading the file, which does not scale, and the reading happened
// only because its author had written the hazard down. The next one will not be
// so considerate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

/**
 * `web/` is what the surface serves at `/`, so it is also the directory the
 * browser clamps `../` at. Both facts come from the same line of main.mjs.
 */
const DOCUMENT_ROOT = join(REPO, 'web');

/** Any origin: only the pathname matters, and `URL` needs one to resolve against. */
const ORIGIN = 'https://surface.invalid';

function mjsFilesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...mjsFilesUnder(full));
    else if (entry.name.endsWith('.mjs')) found.push(full);
  }
  return found;
}

/**
 * The mount prefixes, read out of main.mjs rather than restated here. Restating
 * them would mean a changed mount silently invalidates this test instead of
 * changing its input.
 */
function declaredMountPrefixes() {
  const source = readFileSync(join(REPO, 'src/surface/main.mjs'), 'utf8');
  const literal = /staticMounts:\s*\{([^}]*)\}/.exec(source);
  assert.ok(literal, 'main.mjs no longer has a staticMounts object literal, which this test reads');
  const prefixes = [...literal[1].matchAll(/'(\/[^']*\/)'\s*:/g)].map((match) => match[1]);
  assert.ok(prefixes.length > 0, 'a staticMounts literal with no prefixes in it means the regex is stale');
  return prefixes;
}

/** Every string specifier in a module: static, side-effect-only and dynamic. */
function specifiersIn(source) {
  const patterns = [/\bfrom\s+'([^']+)'/g, /\bimport\s+'([^']+)'/g, /\bimport\s*\(\s*'([^']+)'/g];
  const found = new Set();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

/** What each resolver makes of one specifier read from one file. */
function resolveBoth(file, specifier) {
  const nodeTarget = resolve(join(file, '..'), specifier);
  const urlPath = `/${relative(DOCUMENT_ROOT, file).split(sep).join('/')}`;
  const browserPath = new URL(specifier, ORIGIN + urlPath).pathname;
  return { nodeTarget, urlPath, browserPath };
}

/**
 * The repository file the surface would answer a URL path with. A mount's prefix
 * mirrors its repository path, so dropping the leading slash is the whole
 * translation -- the property the first test below pins.
 */
function servedFileFor(browserPath, mountPrefixes) {
  const mounted = mountPrefixes.some((prefix) => browserPath.startsWith(prefix));
  return mounted ? join(REPO, browserPath.slice(1)) : join(DOCUMENT_ROOT, browserPath.slice(1));
}

test('every served directory sits at the URL path that mirrors its repository path', () => {
  // This is the invariant that lets one specifier spelling satisfy both
  // resolvers. A mount at, say, `/modules/` pointing at `src/appserver` would
  // serve the file perfectly well and break every import that reaches it.
  for (const prefix of declaredMountPrefixes()) {
    const mirrored = join(REPO, prefix.slice(1));
    assert.ok(
      existsSync(mirrored) && statSync(mirrored).isDirectory(),
      `mount ${prefix} should mirror a repository directory, but ${mirrored} is not one`,
    );
  }
  assert.equal(relative(REPO, DOCUMENT_ROOT), 'web', 'the document root is web/, per main.mjs');
});

test('both resolvers land on the same file, for every specifier under web/', () => {
  const mountPrefixes = declaredMountPrefixes();
  let checked = 0;
  for (const file of mjsFilesUnder(DOCUMENT_ROOT)) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of specifiersIn(source)) {
      if (!specifier.startsWith('.')) continue;
      const { nodeTarget, urlPath, browserPath } = resolveBoth(file, specifier);
      const where = `${relative(REPO, file)} imports ${specifier}`;
      assert.ok(existsSync(nodeTarget), `${where}, which does not exist (${nodeTarget})`);
      const served = servedFileFor(browserPath, mountPrefixes);
      assert.ok(
        existsSync(served),
        `${where}; a browser reading ${urlPath} asks for ${browserPath}, which nothing serves`,
      );
      assert.equal(served, nodeTarget, `${where}, and the two resolvers disagree about which file that is`);
      checked += 1;
    }
  }
  assert.ok(checked >= 10, `only ${checked} specifiers checked, which suggests the scan missed most of them`);
});

test('web/ imports nothing bare, because the browser has no node_modules', () => {
  // A bare specifier resolves for the test runner and 404s on the phone, which
  // is the same failure as the one above wearing a different hat. `node:`
  // builtins are the loud version of it and are worth naming separately.
  for (const file of mjsFilesUnder(DOCUMENT_ROOT)) {
    for (const specifier of specifiersIn(readFileSync(file, 'utf8'))) {
      assert.ok(
        specifier.startsWith('.') || specifier.startsWith('/'),
        `${relative(REPO, file)} imports ${specifier}, which only exists under a package manager`,
      );
    }
  }
});

test('the check is not vacuous: web/ really does import across its own boundary', () => {
  const crossing = [];
  for (const file of mjsFilesUnder(DOCUMENT_ROOT)) {
    for (const specifier of specifiersIn(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) continue;
      const { nodeTarget } = resolveBoth(file, specifier);
      if (!nodeTarget.startsWith(DOCUMENT_ROOT + sep)) crossing.push(`${relative(REPO, file)} -> ${specifier}`);
    }
  }
  assert.ok(crossing.length >= 3, `expected imports that leave web/, found ${crossing.length}: ${crossing}`);
});

test('the disagreement this file exists to catch is still detectable', () => {
  // The spelling the hostlink wiring actually shipped with, checked against the
  // place it now lives. Without this, a bug in resolveBoth would make every
  // assertion above pass by agreeing on nothing.
  const file = join(DOCUMENT_ROOT, 'hostlink', 'link.mjs');
  const { nodeTarget, browserPath } = resolveBoth(file, '../../web/host-bus.mjs');
  assert.equal(nodeTarget, join(DOCUMENT_ROOT, 'host-bus.mjs'), 'Node is perfectly happy with it');
  assert.equal(browserPath, '/web/host-bus.mjs', 'and the browser asks for a path nothing serves');
  assert.equal(existsSync(servedFileFor(browserPath, declaredMountPrefixes())), false, 'nothing serves it');
});
