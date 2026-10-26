// Does `npm test` actually run every test in the repo?
//
// It did not. The script was `node --test test/**/*.test.mjs`, unquoted, and
// npm hands a script to sh. sh without `globstar` does not treat `**` as
// "any depth" -- it treats it as an ordinary `*`, so `test/**/*.test.mjs`
// expands to `test/*/*.test.mjs`: exactly one directory below test/. Every
// suite in the repo happened to sit at that depth, so the bug was invisible
// until test/relay/providers/ was added. For one commit, 80 tests covering the
// ssh and tailscale providers -- the newest and least-exercised code in the
// tree -- were not run by `npm test` at all, and nothing said so. The totals
// just quietly read 736 instead of 816.
//
// The fix is to quote the glob so node expands it instead of sh. This file is
// the thing that keeps it fixed, because the failure mode is silence: a
// skipped suite looks exactly like a passing one from the summary line.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'test');

/** Repo-relative, forward-slashed, so comparisons do not depend on platform. */
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function walk(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.name.endsWith('.test.mjs')) found.push(full);
  }
  return found;
}

const script = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts?.test;

test('the test script exists and delegates to node --test', () => {
  assert.equal(typeof script, 'string');
  assert.match(script, /node --test\b/);
});

test('no glob in the test script is left for the shell to expand', () => {
  // Strip the quoted parts, then look for what is left. Anything matching here
  // is a pattern sh will expand, and sh gets `**` wrong.
  const unquoted = script.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');
  assert.deepEqual(
    unquoted.match(/\*\*/g) ?? [],
    [],
    `unquoted ** in the test script -- sh will expand it one level deep: ${script}`,
  );
});

test('the glob, expanded by node, finds every test file that exists', () => {
  const patterns = [...script.matchAll(/["']([^"']*\*[^"']*)["']/g)].map((m) => m[1]);
  assert.ok(patterns.length > 0, `no quoted glob found in: ${script}`);

  const matched = patterns.flatMap((p) => [...fs.globSync(p, { cwd: ROOT })]).map((p) => rel(path.resolve(ROOT, p)));
  const onDisk = walk(TEST_DIR).map(rel);

  assert.deepEqual(
    [...new Set(matched)].sort(),
    [...new Set(onDisk)].sort(),
    'npm test does not run the same set of files that exist on disk',
  );
});

test('at least one suite nests deeply enough for the quoting to matter', () => {
  // Without this, the test above passes vacuously the moment the tree
  // flattens back out, and the regression it guards becomes invisible again.
  const deep = walk(TEST_DIR).map(rel).filter((p) => p.split('/').length >= 4);
  assert.ok(
    deep.length > 0,
    'no test file sits two directories below test/, so shell-vs-node globbing is untested here',
  );
});
