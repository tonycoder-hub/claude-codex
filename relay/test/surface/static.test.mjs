import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { startSurface, tempDir, fakeUpstream } from './harness.mjs';

/** A static root shaped like the renderer bundle the surface actually serves. */
function assetRoot() {
  const root = tempDir('relay-static-');
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>codex</title>\n');
  writeFileSync(join(root, 'renderer.js'), 'export const ok = 1;\n');
  writeFileSync(join(root, 'renderer.js.map'), '{"version":3}\n');
  writeFileSync(join(root, 'styles.css'), ':root{color:canvastext}\n');
  writeFileSync(join(root, 'manifest.json'), '{"name":"codex"}\n');
  writeFileSync(join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  writeFileSync(join(root, 'inter.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
  writeFileSync(join(root, 'secret-shaped.bin'), 'not served as text\n');
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested', 'index.html'), '<!doctype html><title>nested</title>\n');
  return root;
}

async function surfaceWithAssets(t) {
  const root = assetRoot();
  const surface = await startSurface({ staticRoot: root, createUpstream: () => fakeUpstream() });
  t.after(() => surface.close());
  return { ...surface, root, get: (path, init) => fetch(`http://127.0.0.1:${surface.port}${path}`, init) };
}

test('assets are served with the right content type', async (t) => {
  const { get } = await surfaceWithAssets(t);
  const expected = [
    ['/index.html', 'text/html; charset=utf-8'],
    ['/renderer.js', 'text/javascript; charset=utf-8'],
    ['/renderer.js.map', 'application/json; charset=utf-8'],
    ['/styles.css', 'text/css; charset=utf-8'],
    ['/manifest.json', 'application/json; charset=utf-8'],
    ['/icon.svg', 'image/svg+xml'],
    ['/inter.woff2', 'font/woff2'],
    ['/secret-shaped.bin', 'application/octet-stream'],
  ];
  for (const [path, type] of expected) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('content-type'), type, path);
    await res.text();
  }
});

test('/ serves index.html, and so does a directory', async (t) => {
  const { get } = await surfaceWithAssets(t);
  const root = await get('/');
  assert.equal(root.status, 200);
  assert.match(await root.text(), /<title>codex<\/title>/);

  const nested = await get('/nested/');
  assert.equal(nested.status, 200);
  assert.match(await nested.text(), /nested/);

  const noSlash = await get('/nested');
  assert.equal(noSlash.status, 200);
  await noSlash.text();
});

test('an ETag and Last-Modified drive conditional requests', async (t) => {
  const { get } = await surfaceWithAssets(t);
  const first = await get('/renderer.js');
  await first.text();
  const etag = first.headers.get('etag');
  const lastModified = first.headers.get('last-modified');
  assert.ok(etag, 'expected an ETag');
  assert.ok(lastModified, 'expected a Last-Modified');

  const byEtag = await get('/renderer.js', { headers: { 'If-None-Match': etag } });
  assert.equal(byEtag.status, 304);
  assert.equal(byEtag.headers.get('etag'), etag);
  await byEtag.text();

  const byDate = await get('/renderer.js', { headers: { 'If-Modified-Since': lastModified } });
  assert.equal(byDate.status, 304);
  await byDate.text();

  const stale = await get('/renderer.js', { headers: { 'If-None-Match': '"bogus"' } });
  assert.equal(stale.status, 200);
  await stale.text();
});

test('HEAD returns the headers and no body', async (t) => {
  const { get } = await surfaceWithAssets(t);
  const res = await get('/index.html', { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await res.text(), '');
});

test('traversal out of the static root is refused', async (t) => {
  const { get, logger } = await surfaceWithAssets(t);

  // A path separator encoded as %2f is NOT a separator to the URL parser, so
  // `..%2f..%2f` survives normalisation intact and arrives as a real traversal
  // attempt. These are the ones the containment check has to stop.
  for (const path of [
    '/..%2f..%2fetc%2fhosts',
    '/%2e%2e%2f%2e%2e%2fetc%2fhosts',
    '/nested/..%2f..%2f..%2fetc%2fhosts',
  ]) {
    const res = await get(path);
    assert.equal(res.status, 403, path);
    assert.match(await res.text(), /forbidden/);
  }
  assert.ok(logger.records.some((r) => r.event === 'static.traversal_refused'));

  // Genuine dot segments (encoded or not) are collapsed by URL parsing before
  // the handler ever sees them, and absolute paths are re-rooted. Neither may
  // ever produce a file from outside the root -- which is the property that
  // actually matters, however the request was spelled.
  for (const path of [
    '/../../etc/hosts',
    '/%2e%2e/%2e%2e/etc/hosts',
    '/etc/hosts',
    '//etc/hosts',
    '/./../etc/hosts',
    '/nested/../../../etc/hosts',
  ]) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
    await res.text();
  }
});

test('a symlink pointing outside the root is refused', async (t) => {
  const { get, root } = await surfaceWithAssets(t);
  symlinkSync('/etc/hosts', join(root, 'escape.txt'));

  const res = await get('/escape.txt');
  assert.equal(res.status, 403);
  await res.text();
});

test('a NUL byte in the path is refused before any syscall', async (t) => {
  const { get } = await surfaceWithAssets(t);
  const res = await get('/index%00.html');
  assert.equal(res.status, 400);
  await res.text();
});

test('missing files 404 and non-GET methods 405', async (t) => {
  const { get } = await surfaceWithAssets(t);
  const missing = await get('/nope.js');
  assert.equal(missing.status, 404);
  await missing.text();

  const posted = await get('/index.html', { method: 'POST', body: 'x' });
  assert.equal(posted.status, 405);
  await posted.text();
});

test('a plain GET on the websocket path says to upgrade', async (t) => {
  const { get } = await surfaceWithAssets(t);
  const res = await get('/ws');
  assert.equal(res.status, 426);
  await res.text();
});

test('with no static root configured nothing is served', async (t) => {
  const surface = await startSurface({ createUpstream: () => fakeUpstream() });
  t.after(() => surface.close());
  const res = await fetch(`http://127.0.0.1:${surface.port}/index.html`);
  assert.equal(res.status, 404);
  await res.text();
});
