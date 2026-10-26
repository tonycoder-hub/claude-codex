// Serving the renderer out of an asar, through the same mount list that serves
// directories.
//
// The archive here is built by hand rather than copied from the shipped one:
// these tests are about the mount -- the session gate, prefix ordering,
// revalidation, what a `..` does -- and a 546 MB archive would make every one
// of them slower without making any of them stricter. test/renderer/asar.test.mjs
// is where the format lives, and the reader is additionally checked against the
// real archive on the machine that has one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openArchive } from '../../src/renderer/asar.mjs';
import { Ceremonies } from '../../src/auth/ceremony.mjs';
import { CredentialStore, EphemeralStore } from '../../src/auth/store.mjs';
import { startSurface, tempDir, freshSessions, fakeUpstream } from './harness.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'relay-archive-'));
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
  const file = join(scratch, `renderer-${serial++}.asar`);
  writeFileSync(file, Buffer.concat([preamble, json, Buffer.alloc(padding), ...entries]));
  return file;
}

/**
 * `webview/` is where the real renderer lives inside the real archive, and
 * `package.json` is its sibling: the one file in this fixture that the mount
 * must not reach, placed exactly where a traversal would aim.
 */
const RENDERER = {
  'webview/index.html': '<!doctype html><title>renderer</title>',
  'webview/assets/index.js': 'export const renderer = 1;\n',
  'webview/assets/logo.webp': 'RIFF....WEBP',
  'webview/assets/font.woff2': 'wOF2',
  'webview/assets/empty.css': '',
  'webview/nested/index.html': '<!doctype html><title>nested</title>',
  'package.json': '{"name":"not-the-renderer"}',
};

/** A surface with our own shell at `/` and the renderer at `/app/`. */
async function served(t, { requireSession, overrides, sessions = freshSessions() } = {}) {
  const web = tempDir('relay-archive-web-');
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>login</title>\n');
  const archive = openArchive(buildArchive(RENDERER));
  const spec = { archive, base: 'webview' };
  // Left unset unless a test is about the flag, so that the test asserting the
  // default is reading the default rather than a value it just passed in.
  if (requireSession !== undefined) spec.requireSession = requireSession;
  if (overrides !== undefined) spec.overrides = overrides;
  const surface = await startSurface({
    staticRoot: web,
    sessions,
    archiveMounts: { '/app/': spec },
    createUpstream: () => fakeUpstream(),
  });
  t.after(() => { surface.close(); archive.close(); });
  const cookie = `${sessions.cookieName}=${sessions.issue({ subject: 'cred-phone' }).token}`;
  return {
    port: surface.port,
    logger: surface.logger,
    archive,
    get: (path, init) => fetch(`http://127.0.0.1:${surface.port}${path}`, {
      ...init,
      headers: { Cookie: cookie, ...(init?.headers ?? {}) },
    }),
    anon: (path, init) => fetch(`http://127.0.0.1:${surface.port}${path}`, init),
  };
}

test('the renderer is served out of the archive, with the content types it needs', async (t) => {
  const { get } = await served(t);

  const index = await get('/app/');
  assert.equal(index.status, 200);
  assert.equal(index.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(await index.text(), /<title>renderer<\/title>/);

  const js = await get('/app/assets/index.js');
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.match(await js.text(), /export const renderer/);

  // These two are why the content-type table grew: the shipped renderer is
  // mostly .webp and fonts, and octet-stream on either is a blank page with no
  // error anywhere to explain it.
  const webp = await get('/app/assets/logo.webp');
  assert.equal(webp.headers.get('content-type'), 'image/webp');
  await webp.text();
  const font = await get('/app/assets/font.woff2');
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  await font.text();
});

/** The directive names in a policy, which is all one assertion below needs. */
function directiveNames(policy) {
  return policy.split(';').map((part) => part.trim().split(/\s+/)[0]).filter((name) => name !== '');
}

test('every response carries the four hardening headers, including the empty ones', async (t) => {
  const { get, anon } = await served(t);

  // The document, an asset, a 304 and a 401, because the headers are only
  // worth anything if they are on the response that actually renders -- and
  // the branches easiest to forget are the two that write no body.
  const document = await get('/app/');
  await document.text();
  const asset = await get('/app/assets/index.js');
  const etag = asset.headers.get('etag');
  await asset.text();
  const revalidated = await get('/app/assets/index.js', { headers: { 'If-None-Match': etag } });
  await revalidated.text();
  assert.equal(revalidated.status, 304);
  const denied = await anon('/app/assets/index.js');
  await denied.text();
  assert.equal(denied.status, 401);

  for (const [name, res] of [['document', document], ['asset', asset], ['304', revalidated], ['401', denied]]) {
    // nosniff, because the content-type table is an allowlist and everything
    // it has not heard of is served as octet-stream; without this a browser
    // may decide an unrecognised archive entry is script.
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', name);

    // SAMEORIGIN and frame-ancestors say the same thing to two generations of
    // browser. frame-ancestors has to be a header: a <meta> CSP is required to
    // ignore it, so the policy src/renderer/boot.mjs narrows cannot carry it.
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN', name);
    assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'self'", name);

    // On a tunnel the origin is itself the secret the session is scoped to.
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', name);
  }

  // And the header policy says nothing about anything else, so it cannot
  // quietly re-open or re-close a directive the document's own meta decided.
  // Policies intersect; a directive a policy omits is one it has no opinion on.
  assert.deepEqual(
    directiveNames(document.headers.get('content-security-policy')),
    ['frame-ancestors'],
    'the header policy must name frame-ancestors and nothing else',
  );
});

test('an unauthenticated response is scoped to the browser that asked for it', async (t) => {
  // `no-cache` is revalidate, not "do not store": without `private` a caching
  // proxy between the phone and this process may keep an authenticated
  // response and serve it to whoever asks next. A tunnel is precisely where
  // such a proxy lives.
  const { get } = await served(t);
  for (const path of ['/app/', '/app/assets/index.js', '/app/assets/logo.webp']) {
    const res = await get(path);
    await res.text();
    assert.equal(res.headers.get('cache-control'), 'private, no-cache', path);
  }
});

test('a directory resolves to its index, as it does under a directory mount', async (t) => {
  const { get } = await served(t);
  for (const [path, title] of [
    ['/app', 'renderer'],
    ['/app/', 'renderer'],
    ['/app/index.html', 'renderer'],
    ['/app/nested', 'nested'],
    ['/app/nested/', 'nested'],
  ]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), new RegExp(`<title>${title}</title>`), path);
  }
});

test('an archive mount requires a session by default', async (t) => {
  // The default is the point of the option. A directory mount is open because
  // logging in needs the login page; nothing inside the renderer is needed to
  // authenticate, and this surface is reachable from a phone.
  const { anon, get } = await served(t);
  const denied = await anon('/app/assets/index.js');
  assert.equal(denied.status, 401);
  assert.doesNotMatch(await denied.text(), /export const renderer/);
  const allowed = await get('/app/assets/index.js');
  assert.equal(allowed.status, 200);
  await allowed.text();
});

test('a refusal is logged by path, with no token material in the record', async (t) => {
  const { anon, logger } = await served(t);
  await (await anon('/app/assets/index.js')).text();
  const denial = logger.records.find((r) => r.event === 'static.denied');
  assert.ok(denial, 'the refusal is logged');
  assert.equal(denial.path, '/app/assets/index.js');
  assert.doesNotMatch(logger.text(), /__Host-|eyJ/, 'no cookie name or token in the log');
});

test('a session from another keyring is refused exactly like no session', async (t) => {
  const { port } = await served(t);
  const stranger = freshSessions();
  const { token } = stranger.issue({ subject: 'cred-phone' });
  const res = await fetch(`http://127.0.0.1:${port}/app/assets/index.js`, {
    headers: { Cookie: `${stranger.cookieName}=${token}` },
  });
  assert.equal(res.status, 401);
  await res.text();
});

test('requireSession: false serves without a cookie, for a deployment that asks', async (t) => {
  const { anon } = await served(t, { requireSession: false });
  const res = await anon('/app/assets/index.js');
  assert.equal(res.status, 200);
  await res.text();
});

test('the mount cannot be walked out of, however the request is spelled', async (t) => {
  const { get, logger } = await served(t);
  const climbs = [
    '/app/../package.json',
    '/app/..%2fpackage.json',
    '/app/%2e%2e/package.json',
    '/app/....//....//package.json',
  ];
  for (const path of climbs) {
    const res = await get(path);
    const body = await res.text();
    assert.ok(res.status === 403 || res.status === 404, `${path} -> ${res.status}`);
    assert.doesNotMatch(body, /not-the-renderer/, path);
  }
  assert.doesNotMatch(logger.text(), /not-the-renderer/);
});

test('a directory with no index is a 404, not a listing', async (t) => {
  const { get } = await served(t);
  const res = await get('/app/assets');
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.doesNotMatch(body, /index\.js|logo\.webp/, 'no listing leaked into the body');
});

test('an empty asset is 200 with zero bytes, not a hung response', async (t) => {
  // The reader has a branch for this because the byte range of an empty entry
  // is reversed; here is what that branch looks like from the client side.
  const { get } = await served(t);
  const res = await get('/app/assets/empty.css');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), '0');
  assert.equal((await res.text()).length, 0);
});

test('an entry is served at its own length, not to the end of the archive', async (t) => {
  const { get } = await served(t);
  const res = await get('/app/assets/logo.webp');
  const body = await res.text();
  assert.equal(body, RENDERER['webview/assets/logo.webp']);
  assert.equal(res.headers.get('content-length'), String(body.length));
});

test('a second request revalidates to 304, and the etag identifies the bytes', async (t) => {
  const { get } = await served(t);
  const first = await get('/app/assets/index.js');
  const etag = first.headers.get('etag');
  await first.text();
  assert.ok(etag);
  // `private` scopes it to this browser; `no-cache` is the revalidation this
  // test is actually about. See SECURITY_HEADERS in src/surface/server.mjs.
  assert.equal(first.headers.get('cache-control'), 'private, no-cache');

  const second = await get('/app/assets/index.js', { headers: { 'If-None-Match': etag } });
  assert.equal(second.status, 304);
  assert.equal((await second.text()).length, 0);

  // Two entries in one archive share an mtime, so offset and size are the only
  // things telling their etags apart. If they ever stop doing that, a phone
  // caches the main chunk and renders it as the stylesheet.
  const other = await get('/app/index.html');
  assert.notEqual(other.headers.get('etag'), etag);
  await other.text();
});

test('If-Modified-Since revalidates, but a stale etag still wins over it', async (t) => {
  const { get } = await served(t);
  const first = await get('/app/index.html');
  const lastModified = first.headers.get('last-modified');
  await first.text();
  assert.ok(lastModified);

  const fresh = await get('/app/index.html', { headers: { 'If-Modified-Since': lastModified } });
  assert.equal(fresh.status, 304);
  await fresh.text();

  // The date has one-second resolution and the etag does not, so when the
  // client sends both, the etag is the one that decides.
  const stale = await get('/app/index.html', {
    headers: { 'If-None-Match': '"a0-0-0"', 'If-Modified-Since': lastModified },
  });
  assert.equal(stale.status, 200);
  await stale.text();
});

test('revalidation is still gated: a 304 is not a way around the session', async (t) => {
  const { get, anon } = await served(t);
  const first = await get('/app/assets/index.js');
  const etag = first.headers.get('etag');
  await first.text();
  const res = await anon('/app/assets/index.js', { headers: { 'If-None-Match': etag } });
  assert.equal(res.status, 401);
  await res.text();
});

test('HEAD answers with the length and no body', async (t) => {
  const { get } = await served(t);
  const res = await get('/app/assets/index.js', { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(RENDERER['webview/assets/index.js'].length));
  assert.equal((await res.text()).length, 0);
});

test('/ still serves our own shell, and the archive prefix beats it', async (t) => {
  const { get, anon } = await served(t);
  const shell = await anon('/');
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /<title>login<\/title>/);
  const app = await get('/app/');
  assert.match(await app.text(), /<title>renderer<\/title>/);
});

test('a missing asset is a 404 that says nothing about the archive', async (t) => {
  const { get } = await served(t);
  const res = await get('/app/assets/nope.js');
  assert.equal(res.status, 404);
  assert.equal((await res.text()).trim(), 'not found');
});

test('a bad archive mount is refused at construction, not at request time', async (t) => {
  const archive = openArchive(buildArchive(RENDERER));
  t.after(() => archive.close());
  const build = (archiveMounts, extra = {}) => startSurface({
    archiveMounts,
    createUpstream: () => fakeUpstream(),
    ...extra,
  });
  await assert.rejects(() => build({ '/app': { archive } }), /must start and end with \//);
  await assert.rejects(() => build({ '/app/': {} }), /has no archive/);
  // One prefix, two backing stores, and nothing in the request to say which was
  // meant: the sort would pick whichever was pushed first.
  await assert.rejects(
    () => build({ '/app/': { archive } }, { staticMounts: { '/app/': scratch } }),
    /two mounts claim/,
  );
});

test('an archive closed under the surface is a 503, not a truncated asset', async (t) => {
  // A phone that is told Content-Length and then handed fewer bytes caches the
  // short copy. Failing before the headers go out is the whole reason the
  // archive calls sit inside a guard.
  const archive = openArchive(buildArchive(RENDERER));
  const sessions = freshSessions();
  const surface = await startSurface({
    sessions,
    archiveMounts: { '/app/': { archive, base: 'webview' } },
    createUpstream: () => fakeUpstream(),
  });
  t.after(() => surface.close());
  const cookie = `${sessions.cookieName}=${sessions.issue({ subject: 'cred-phone' }).token}`;
  const url = `http://127.0.0.1:${surface.port}/app/assets/index.js`;

  const before = await fetch(url, { headers: { Cookie: cookie } });
  assert.equal(before.status, 200);
  await before.text();

  archive.close();
  const after = await fetch(url, { headers: { Cookie: cookie } });
  assert.equal(after.status, 503);
  assert.equal((await after.text()).trim(), 'renderer unavailable');
  assert.ok(
    surface.logger.records.some((r) => r.event === 'static.archive_unavailable'),
    'the unavailability is logged once, at error level',
  );
});

// ---- the trailing slash ----------------------------------------------------

test('a request for /app without the trailing slash is a 308, because every reference in the bundle is relative', async (t) => {
  const { get } = await served(t);

  // The whole reason the redirect exists, resolved the way a browser resolves
  // it rather than argued about. The shipped index.html references its entry
  // as `./assets/index-56e9f72c1d6a.js`, and that one specifier means two
  // different paths depending on a single character at the end of the
  // document's own URL -- so served at /app it asks for assets that are not
  // there, and the symptom is a blank page with a console full of 404s.
  assert.equal(new URL('./assets/index.js', 'http://phone.invalid/app').pathname, '/assets/index.js');
  assert.equal(new URL('./assets/index.js', 'http://phone.invalid/app/').pathname, '/app/assets/index.js');

  // `redirect: 'manual'` is load-bearing: Node's fetch follows a 308 by
  // default, which is why the index test above still passes unchanged -- and
  // why without this option there would be nothing here to observe.
  const res = await get('/app', { redirect: 'manual' });
  assert.equal(res.status, 308, 'a 302 may turn a request into a GET; this one must not');
  assert.equal(res.headers.get('location'), '/app/');
  assert.equal(res.headers.get('content-length'), '0');
  assert.equal((await res.text()).length, 0);

  // And the destination is a document, so the redirect terminates.
  const followed = await get('/app/', { redirect: 'manual' });
  assert.equal(followed.status, 200);
  assert.match(await followed.text(), /<title>renderer<\/title>/);
});

test('the redirect carries the query, and nothing but the bare prefix redirects', async (t) => {
  const { get } = await served(t);
  const withQuery = await get('/app?view=threads&id=a%2Fb', { redirect: 'manual' });
  assert.equal(withQuery.status, 308);
  // Copied, not rebuilt: the encoded slash survives, which it would not if the
  // query made a round trip through a parser on the way out.
  assert.equal(withQuery.headers.get('location'), '/app/?view=threads&id=a%2Fb');
  await withQuery.text();

  for (const path of ['/app/', '/app/index.html', '/app/nested', '/app/assets/index.js']) {
    const res = await get(path, { redirect: 'manual' });
    assert.equal(res.status, 200, path);
    await res.text();
  }
});

test('a directory mount redirects its bare prefix by the same rule', async (t) => {
  // The matcher that produced the blank page is shared by both backing stores,
  // so the fix is too. mounts.test.mjs asserts the followed request still
  // lands on the index; this is the hop it now takes to get there.
  const dir = tempDir('relay-archive-dirmount-');
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>mount index</title>\n');
  const surface = await startSurface({
    staticMounts: { '/modules/': dir },
    createUpstream: () => fakeUpstream(),
  });
  t.after(() => surface.close());

  const res = await fetch(`http://127.0.0.1:${surface.port}/modules`, { redirect: 'manual' });
  assert.equal(res.status, 308);
  assert.equal(res.headers.get('location'), '/modules/');
  await res.text();
});

// ---- per-mount overrides ---------------------------------------------------

// What the real override does, in miniature: the host shim has to run before
// the bundle's module entry, so the patch is an insertion into a document that
// otherwise stays byte-for-byte the shipped one. src/renderer owns the real
// transform and tests it as a pure function; this file owns the narrower
// question of whether a mount serves its result instead of the archive's.
const SHIM = '<script type="module" src="/host-boot.mjs"></script>';
const injectShim = (html) => String(html).replace('<title>', `${SHIM}<title>`);

test('an override is served in place of the archive bytes, and is handed the bytes it replaces', async (t) => {
  const seen = [];
  const { get } = await served(t, {
    overrides: {
      'index.html': (original, context) => {
        seen.push({ original, context });
        return injectShim(original.toString('utf8'));
      },
    },
  });

  const res = await get('/app/');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  const body = await res.text();
  assert.equal(body, injectShim(RENDERER['webview/index.html']));
  assert.equal(res.headers.get('content-length'), String(Buffer.byteLength(body)));

  // The transform saw the archive's own copy, which is what makes it a patch
  // rather than a replacement, and the archive keeps the bytes it had.
  assert.equal(seen.length, 1);
  assert.equal(seen[0].original.toString('utf8'), RENDERER['webview/index.html']);
  assert.deepEqual(seen[0].context, { path: '/index.html', prefix: '/app/' });

  // Everything else still comes out of the archive without being looked at.
  const js = await get('/app/assets/index.js');
  assert.equal(await js.text(), RENDERER['webview/assets/index.js']);
  assert.equal(seen.length, 1);
});

test('one override answers for every spelling of the path it claims', async (t) => {
  // A phone arrives at this document four ways -- the redirect above makes the
  // first one the second -- and a mount that patched only one of them would
  // boot the real bundle with no host attached, which looks like a working
  // page right up to the first turn.
  const { get } = await served(t, { overrides: { '/index.html': injectShim } });
  for (const path of ['/app', '/app/', '/app/index.html', '/app//index.html']) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /host-boot/, path);
  }
});

test('an override revalidates on its own content, not on the archive it came from', async (t) => {
  // The patched document changes when the patcher's configuration changes
  // while the asar underneath keeps its mtime, so a date-shaped validator
  // would hand a phone last boot's shim and call it fresh. `version` stands in
  // for that configuration.
  let version = 1;
  const { get } = await served(t, {
    overrides: { 'index.html': () => `<!doctype html><title>v${version}</title>` },
  });

  const first = await get('/app/');
  const etag = first.headers.get('etag');
  assert.ok(etag, 'an override still carries a validator');
  assert.equal(first.headers.get('last-modified'), null, 'and deliberately no date');
  assert.equal(first.headers.get('cache-control'), 'private, no-cache');
  await first.text();

  const revalidated = await get('/app/', { headers: { 'If-None-Match': etag } });
  assert.equal(revalidated.status, 304);
  assert.equal((await revalidated.text()).length, 0);

  version = 2;
  const changed = await get('/app/', { headers: { 'If-None-Match': etag } });
  assert.equal(changed.status, 200, 'different bytes are not a 304');
  assert.notEqual(changed.headers.get('etag'), etag);
  assert.match(await changed.text(), /v2/);

  // The archive's own entries keep their own validators, dates included.
  const asset = await get('/app/assets/index.js');
  assert.notEqual(asset.headers.get('etag'), etag);
  assert.ok(asset.headers.get('last-modified'));
  await asset.text();
});

test('HEAD on an override reports the produced length, with no body', async (t) => {
  const { get } = await served(t, { overrides: { 'index.html': injectShim } });
  const patched = injectShim(RENDERER['webview/index.html']);
  const res = await get('/app/index.html', { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(Buffer.byteLength(patched)));
  // The length the archive would have promised is the one that truncates the
  // patched document at the byte the shim starts.
  assert.notEqual(res.headers.get('content-length'), String(RENDERER['webview/index.html'].length));
  assert.equal((await res.text()).length, 0);
});

test('precomputed bytes are an override too, for a path the archive need not have', async (t) => {
  // The other caller shape: a document computed once at boot rather than per
  // request. `assets/host-boot.mjs` is in no archive at all, which is the
  // point -- a mount can carry a file the bundle does not contain.
  const module = 'export const boot = 1;\n';
  const { get } = await served(t, {
    overrides: {
      'assets/host-boot.mjs': module,
      'assets/logo.webp': Buffer.from('RIFF-ours-WEBP'),
      'assets/empty.css': '',
    },
  });

  const added = await get('/app/assets/host-boot.mjs');
  assert.equal(added.status, 200);
  assert.equal(added.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(added.headers.get('content-length'), String(Buffer.byteLength(module)));
  assert.equal(await added.text(), module);

  // An override also wins over an entry that does exist, and the type still
  // follows the path rather than whatever replaced it.
  const logo = await get('/app/assets/logo.webp');
  assert.equal(logo.headers.get('content-type'), 'image/webp');
  assert.equal(await logo.text(), 'RIFF-ours-WEBP');

  // Zero bytes is a document like any other, as it is for an archive entry.
  const empty = await get('/app/assets/empty.css');
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('content-length'), '0');
  assert.equal((await empty.text()).length, 0);
});

test('an override is behind the same session gate as the archive', async (t) => {
  const { anon, get } = await served(t, { overrides: { 'index.html': injectShim } });
  const denied = await anon('/app/');
  assert.equal(denied.status, 401);
  const body = await denied.text();
  assert.doesNotMatch(body, /host-boot/);
  assert.doesNotMatch(body, /<title>renderer<\/title>/);

  const allowed = await get('/app/');
  assert.equal(allowed.status, 200);
  assert.match(await allowed.text(), /host-boot/);
});

test('a transform that refuses the document is a 503, and never the unpatched copy', async (t) => {
  // The failure that matters most: the one document the renderer cannot boot
  // without is the one being rewritten, so a patcher that cannot find its
  // anchor must not fall back to shipping the original. That would boot the
  // real bundle with no host behind it.
  const { get, logger } = await served(t, {
    overrides: {
      'index.html': () => { throw new Error('no anchor in /private/renderer.asar'); },
    },
  });
  const res = await get('/app/');
  assert.equal(res.status, 503);
  const body = await res.text();
  assert.equal(body.trim(), 'renderer unavailable');
  assert.doesNotMatch(body, /<title>renderer<\/title>/, 'the unpatched document is not a fallback');
  assert.doesNotMatch(body, /private/, "the transform's complaint quotes a path, so it stays in the log");
  const failure = logger.records.find((r) => r.event === 'static.override_failed');
  assert.ok(failure, 'and the log has it');
  assert.equal(failure.path, '/app/');
});

test('an override of an archive that closed under us is a 503, not a half-produced document', async (t) => {
  // What an App update does to a running relay. A transform that is handed the
  // archive's bytes cannot be run at all once those bytes are gone, and the
  // answer has to be the same 503 the raw entries give.
  const { get, archive } = await served(t, { overrides: { 'index.html': injectShim } });
  const before = await get('/app/');
  assert.equal(before.status, 200);
  await before.text();

  archive.close();
  const after = await get('/app/');
  assert.equal(after.status, 503);
  assert.equal((await after.text()).trim(), 'renderer unavailable');
});

test('a malformed override is refused at construction, not at request time', async (t) => {
  const archive = openArchive(buildArchive(RENDERER));
  t.after(() => archive.close());
  const build = (overrides) => startSurface({
    archiveMounts: { '/app/': { archive, base: 'webview', overrides } },
    createUpstream: () => fakeUpstream(),
  });
  await assert.rejects(() => build({ 'index.html': 42 }), /must be bytes, a string, or a function/);
  await assert.rejects(() => build({ 'index.html': null }), /must be bytes, a string, or a function/);
  // A key no request can ever match would leave the mount serving the
  // unpatched document for ever, with nothing anywhere to say why.
  await assert.rejects(() => build({ 'assets/': 'x' }), /must name a file/);
  await assert.rejects(() => build({ '/': 'x' }), /must name a file/);
  // Two spellings of one path, and nothing in a request to say which was meant.
  await assert.rejects(() => build({ 'index.html': 'a', '/index.html': 'b' }), /two overrides/);
  // A list of paths with no bytes beside them would otherwise be read as
  // overrides on the paths "0", "1", "2".
  await assert.rejects(() => build(['index.html']), /must be a map of path to bytes/);
});

// ---- /auth/status ----------------------------------------------------------

/**
 * The same mount with the ceremonies wired in, because /auth/status is a 503
 * without them. Nobody enrols here: an empty credential store is the
 * `enrolled: false` a phone sees before the relay has been set up, which is
 * exactly the state in which the page needs to be told where the App lives.
 */
async function statusSurface(t, { files = RENDERER, overrides } = {}) {
  const sessions = freshSessions();
  const ceremonies = new Ceremonies({
    credentials: new CredentialStore(join(tempDir('relay-archive-status-'), 'credentials.json')),
    challenges: new EphemeralStore(),
    bootstrapTokens: new EphemeralStore(),
    sessions,
  });
  const archive = openArchive(buildArchive(files));
  const spec = { archive, base: 'webview' };
  if (overrides !== undefined) spec.overrides = overrides;
  const surface = await startSurface({
    ceremonies,
    sessions,
    archiveMounts: { '/app/': spec },
    createUpstream: () => fakeUpstream(),
  });
  t.after(() => { surface.close(); archive.close(); });
  return { archive, status: () => fetch(`http://127.0.0.1:${surface.port}/auth/status`) };
}

test('/auth/status says where the real App is served, and leaves enrolled exactly as it was', async (t) => {
  const { status } = await statusSurface(t);
  const res = await status();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { enrolled: false, app: { available: true, prefix: '/app/' } });
});

test('/auth/status names the prefix and nothing else about the mount', async (t) => {
  // This endpoint answers before anybody has authenticated, so the prefix is
  // all it may say. The path of the asar and the `base` inside it are this
  // process's filesystem, and a phone about to navigate to /app/ learns
  // nothing from them that it is entitled to know.
  const { status, archive } = await statusSurface(t);
  const text = await (await status()).text();
  assert.match(text, /"prefix":"\/app\/"/);
  assert.equal(text.includes(archive.path), false, 'no path to the archive');
  assert.equal(text.includes('webview'), false, 'no prefix from inside the archive');
  assert.equal(text.includes('.asar'), false);
});

test('an App mount whose archive has gone reports unavailable rather than a prefix that 503s', async (t) => {
  const { status, archive } = await statusSurface(t);
  assert.deepEqual((await (await status()).json()).app, { available: true, prefix: '/app/' });

  // The App updated: the archive this process holds is closed under it and
  // every path on the mount starts answering 503. The status has to agree with
  // that, or the page navigates straight into it.
  archive.close();
  assert.deepEqual((await (await status()).json()).app, { available: false, prefix: '/app/' });
});

test('an App mount with no index reports unavailable unless an override supplies one', async (t) => {
  // `available` is about what a navigation would get, and a mount whose
  // archive has assets but no document is a mount with nothing to navigate to.
  const bundleWithoutIndex = { 'webview/assets/index.js': 'export const renderer = 1;\n' };
  const bare = await statusSurface(t, { files: bundleWithoutIndex });
  assert.deepEqual((await (await bare.status()).json()).app, { available: false, prefix: '/app/' });

  const supplied = await statusSurface(t, {
    files: bundleWithoutIndex,
    overrides: { 'index.html': '<!doctype html><title>ours</title>' },
  });
  assert.deepEqual((await (await supplied.status()).json()).app, { available: true, prefix: '/app/' });
});
