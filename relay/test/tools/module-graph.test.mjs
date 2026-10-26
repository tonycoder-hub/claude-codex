// The walker that tells local.sh what to probe, checked against the directory.
//
// This exists because of how the thing it replaced failed. local.sh carried the
// list by hand; the list drifted down to nine of thirteen modules; nothing went
// red, because a shorter list is still a list of paths that all return 200. The
// loop reported green while two of the modules it was built to protect went
// unprobed.
//
// A derived list fixes the drift but inherits the shape of the failure: if the
// walk breaks -- a regex that stops matching, a resolution rule that goes stale
// against a changed mount -- it returns fewer paths, every one of them still
// 200, and local.sh still says green. So the test cannot be "the walker ran and
// printed something". It has to be an independent count of what the answer
// should contain, and the only honest source for that is the directory itself.
//
// Hence the pin below: every .mjs under web/ is reachable from one of the two
// entry points. That is a real invariant and not just a convenient one -- web/
// is the document root, so a module nothing imports is either dead or a wiring
// somebody forgot to finish, and both are worth a failing test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const DOCUMENT_ROOT = join(REPO, 'web');
const WALKER = join(REPO, 'tools/bring-up/module-graph.mjs');

/** Run the walker the way local.sh runs it, and split its output the same way. */
function walk(...entries) {
  const stdout = execFileSync(process.execPath, [WALKER, ...entries], { encoding: 'utf8' });
  return stdout.split('\n').filter((line) => line !== '');
}

/** Every .mjs under web/, as the URL path the surface would serve it at. */
function urlPathsUnderDocumentRoot(dir = DOCUMENT_ROOT) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...urlPathsUnderDocumentRoot(full));
    else if (entry.name.endsWith('.mjs')) found.push(`/${relative(DOCUMENT_ROOT, full).split(sep).join('/')}`);
  }
  return found;
}

test('the walk reaches every module in the document root', () => {
  const reached = new Set(walk());
  const missed = urlPathsUnderDocumentRoot().filter((urlPath) => !reached.has(urlPath));
  assert.deepEqual(
    missed,
    [],
    `these live under web/ and nothing imports them from either entry point, so local.sh would never probe them. ` +
      `Either wire them up or delete them -- an unreferenced file in the document root is served and unreachable.`,
  );
});

test('the walk leaves web/ where the imports do', () => {
  // The appserver client is imported across the mount boundary, which is the
  // case the hand list got wrong in the other direction: it listed web/ files
  // only, because those are the ones you see when you look in web/.
  const reached = walk();
  const crossing = reached.filter((urlPath) => !urlPath.startsWith('/host') && urlPath.startsWith('/src/'));
  assert.ok(
    crossing.length >= 2,
    `expected the walk to leave web/ through a mount, reached only ${JSON.stringify(reached)}`,
  );
  assert.ok(reached.includes('/src/appserver/client.mjs'), 'the appserver client is reached through the mount');
});

test('both documents are walked, and neither alone would do', () => {
  // The drift that started this was in the second document's list. Pinning that
  // each entry point contributes something the other does not keeps a future
  // "simplify it to one entry" from quietly halving the probe.
  const both = new Set(walk());
  const login = new Set(walk('/app.mjs'));
  const patched = new Set(walk('/host-boot.mjs'));

  const onlyPatched = [...patched].filter((urlPath) => !login.has(urlPath));
  const onlyLogin = [...login].filter((urlPath) => !patched.has(urlPath));
  assert.ok(onlyPatched.length > 0, 'the patched document reaches modules the login page does not');
  assert.ok(onlyLogin.length > 0, 'and the login page reaches modules the patched document does not');

  for (const urlPath of [...login, ...patched]) {
    assert.ok(both.has(urlPath), `${urlPath} is reachable from an entry point but missing from the combined walk`);
  }
});

test('an entry that does not exist is reported, not skipped', () => {
  // The walker deliberately swallows an unreadable file so the caller's HTTP
  // probe is what reports it. That is only safe while the path still comes out
  // in the list -- swallowing it entirely would turn a missing module into a
  // shorter list and put us back where we started.
  const reached = walk('/app.mjs', '/no-such-module.mjs');
  assert.ok(reached.includes('/no-such-module.mjs'), 'the unreadable path is still printed for the caller to probe');
});

test('a broken walk fails loudly rather than returning a short list', () => {
  assert.throws(
    () => execFileSync(process.execPath, [WALKER, '/no-such-module.mjs'], { encoding: 'utf8', stdio: 'pipe' }),
    /only 1 modules reached/,
    'one reached module is a broken scan, and the caller cannot tell that from a list of paths',
  );
});

test('the output is stable across runs, so a diff of local.sh output means something', () => {
  assert.deepEqual(walk(), walk());
});
