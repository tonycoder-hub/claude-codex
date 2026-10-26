// Mounts exist for one reason: the page imports two modules from src/appserver,
// which is outside the directory the surface serves. The obvious alternative --
// widen staticRoot to the repository root and let the page be /web/index.html --
// publishes .git, test/ and docs/ to a surface that is reached from a phone.
// So these tests care much more about what a mount *cannot* reach than about
// what it serves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startSurface, tempDir, fakeUpstream } from './harness.mjs';

/**
 * Two sibling directories under one parent, shaped like the repository: the
 * page directory, the module directory the page needs, and a third thing that
 * must stay unreachable no matter what the request says.
 */
function repoShapedTree() {
  const parent = tempDir('relay-mount-');
  const web = join(parent, 'web');
  const appserver = join(parent, 'src', 'appserver');
  mkdirSync(web);
  mkdirSync(appserver, { recursive: true });
  mkdirSync(join(parent, 'src', 'surface'), { recursive: true });
  mkdirSync(join(parent, '.git'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>page</title>\n');
  writeFileSync(join(web, 'appserver.mjs'), "import '../src/appserver/client.mjs';\n");
  writeFileSync(join(appserver, 'client.mjs'), 'export const client = 1;\n');
  writeFileSync(join(appserver, 'index.html'), '<!doctype html><title>mount index</title>\n');
  writeFileSync(join(parent, 'src', 'surface', 'server.mjs'), 'export const server = 1;\n');
  writeFileSync(join(parent, '.git', 'config'), '[remote "origin"]\n');
  writeFileSync(join(parent, 'secrets.env'), 'TOKEN=must-never-be-served\n');
  return { parent, web, appserver };
}

/** The prefix main.mjs actually uses, mirroring the repository path. */
const MOUNT = '/src/appserver/';

async function mounted(t, staticMounts) {
  const tree = repoShapedTree();
  const surface = await startSurface({
    staticRoot: tree.web,
    staticMounts: staticMounts ?? { [MOUNT]: tree.appserver },
    createUpstream: () => fakeUpstream(),
  });
  t.after(() => surface.close());
  return { ...tree, get: (path) => fetch(`http://127.0.0.1:${surface.port}${path}`) };
}

test('a mount serves the directory it names, and / still serves the page', async (t) => {
  const { get } = await mounted(t);

  const page = await get('/index.html');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>page<\/title>/);

  const module = await get('/src/appserver/client.mjs');
  assert.equal(module.status, 200);
  assert.equal(module.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.match(await module.text(), /export const client/);
});

test('the mount prefix beats / even though / matches it too', async (t) => {
  // Were the longest prefix not chosen first, this would resolve inside web/
  // and 404. It is the one behaviour the ordering exists for.
  const { get } = await mounted(t);
  const res = await get('/src/appserver/client.mjs');
  assert.equal(res.status, 200);
  await res.text();
});

test('mounting /src/appserver/ does not mount /src/', async (t) => {
  // The prefix mirrors a repository path, which is the one thing about it that
  // could mislead a reader. It does not widen to the directory above it.
  const { get } = await mounted(t);
  for (const path of ['/src/', '/src/surface/server.mjs', '/src/appserverX/client.mjs']) {
    const res = await get(path);
    const body = await res.text();
    assert.ok(res.status === 403 || res.status === 404, `${path} -> ${res.status}`);
    assert.doesNotMatch(body, /export const server/, path);
  }
});

test("the page's relative specifier lands on the mount, as the browser resolves it", async (t) => {
  // web/appserver.mjs is served at /appserver.mjs and imports
  // '../src/appserver/client.mjs'. A browser clamps `../` at the document
  // root, so that specifier becomes /src/appserver/client.mjs -- which is why
  // the mount is spelled this way and not something tidier. Resolve it the
  // same way here rather than trusting the reasoning.
  const { get } = await mounted(t);
  const page = await get('/appserver.mjs');
  assert.equal(page.status, 200);
  const specifier = (await page.text()).match(/import '([^']+)'/)?.[1];
  assert.equal(specifier, '../src/appserver/client.mjs');
  const resolved = new URL(specifier, 'http://127.0.0.1/appserver.mjs').pathname;
  assert.equal(resolved, '/src/appserver/client.mjs');
  const module = await get(resolved);
  assert.equal(module.status, 200);
  assert.match(await module.text(), /export const client/);
});

test('a mount cannot be climbed out of, however the request is spelled', async (t) => {
  const { get } = await mounted(t);
  // ../../ out of the mount reaches the repository parent in the filesystem,
  // which is exactly what must not be reachable. Each of these is either
  // normalised away by the URL parser or refused by the containment check;
  // the test does not care which, only that nothing is served.
  const climbs = [
    '/src/appserver/../../secrets.env',
    '/src/appserver/../../.git/config',
    '/src/appserver/%2e%2e/%2e%2e/secrets.env',
    '/src/appserver/..%2f..%2fsecrets.env',
    '/src/appserver/....//....//secrets.env',
  ];
  for (const path of climbs) {
    const res = await get(path);
    const body = await res.text();
    assert.ok(res.status === 403 || res.status === 404 || res.status === 400, `${path} -> ${res.status}`);
    assert.doesNotMatch(body, /must-never-be-served/, path);
    assert.doesNotMatch(body, /remote "origin"/, path);
  }
});

test('the page directory cannot reach its unmounted siblings', async (t) => {
  // The whole point of mounting instead of widening: with staticRoot at the
  // repository root these would all be 200.
  //
  // `/../src/appserver/client.mjs` is deliberately absent from this list. It
  // is 200, and should be: fetch normalises the `..` away before the request
  // leaves, so what arrives is `/src/appserver/client.mjs` -- the mount. The
  // page's own import resolves by exactly that rule, which is the point.
  const { get } = await mounted(t);
  for (const path of ['/../secrets.env', '/../.git/config', '/../src/surface/server.mjs']) {
    const res = await get(path);
    const body = await res.text();
    assert.ok(res.status === 403 || res.status === 404, `${path} -> ${res.status}`);
    assert.doesNotMatch(body, /must-never-be-served/, path);
  }
});

test('a path under no mount and under no root is not found', async (t) => {
  const { get } = await mounted(t);
  const res = await get('/vendor/something-else/x.mjs');
  assert.equal(res.status, 404);
  await res.text();
});

test('the mount root itself serves its index, with or without the trailing slash', async (t) => {
  const { get } = await mounted(t);
  for (const path of ['/src/appserver/', '/src/appserver']) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /mount index/, path);
  }
});

test('a malformed mount prefix is refused at construction, not at request time', async (t) => {
  const tree = repoShapedTree();
  const build = (staticMounts) => startSurface({
    staticRoot: tree.web,
    staticMounts,
    createUpstream: () => fakeUpstream(),
  });
  // A prefix without the trailing slash would make /src/appserverX match.
  await assert.rejects(() => build({ '/src/appserver': tree.appserver }), /must start and end with \//);
  await assert.rejects(() => build({ 'src/appserver/': tree.appserver }), /must start and end with \//);
  // Serving / is staticRoot's job; two code paths for it would be one too many.
  await assert.rejects(() => build({ '/': tree.appserver }), /staticRoot/);
});

test('mounts work with no static root at all', async (t) => {
  // The surface is allowed to serve only mounted modules and no page, because
  // route B eventually serves the page out of the App bundle instead.
  const tree = repoShapedTree();
  const surface = await startSurface({
    staticMounts: { '/src/appserver/': tree.appserver },
    createUpstream: () => fakeUpstream(),
  });
  t.after(() => surface.close());
  const get = (path) => fetch(`http://127.0.0.1:${surface.port}${path}`);

  const module = await get('/src/appserver/client.mjs');
  assert.equal(module.status, 200);
  await module.text();

  const page = await get('/index.html');
  assert.equal(page.status, 404);
  await page.text();
});
