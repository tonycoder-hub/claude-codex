// The surface process: static assets, the passkey ceremonies, and an
// authenticated WebSocket relay to the app-server.
//
// The one architectural rule here is that the relay does not understand the
// protocol it carries. Browser frames go upstream byte-identically and upstream
// frames come back byte-identically; there is no translation layer, no
// re-encoding, no "helpful" rewriting of ids. The browser speaks the
// app-server's JSON-RPC directly, and this process only decides *whether* bytes
// may flow (a valid signed session) and *where* they flow to (one upstream per
// authenticated socket). Anything cleverer would make the surface a second
// implementation of a protocol that already exists, which is how fidelity gets
// lost.
//
// The second rule is blast radius. Every per-connection failure -- a dead
// upstream, a hostile frame, a throwing handler -- is caught at that
// connection's boundary and ends exactly one session. No `throw` escapes into
// the server's event handlers, because that is the pid-churn pattern where one
// peer's bad day takes down everyone's.
//
// Logging is structured and deliberately incurious: event name, connection id,
// byte counts, and (for JSON-RPC) the method name. No cookies, no session
// tokens, no credential ids, no payloads -- a log file that reconstructs a
// session is as good as the cookie it came from.

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { resolve, sep, extname, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { parseCookies, assertSameSite, SESSION_COOKIE } from '../auth/session.mjs';
import { base64urlDecode } from '../auth/bytes.mjs';
import { acceptUpgrade, refuseUpgrade, isSendableCloseCode, CLOSE } from './ws.mjs';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  // The rest are here because the shipped renderer ships them: 937 .webp,
  // 67 fonts across three formats, and a handful of sounds. Counted in the
  // archive rather than guessed -- a missing entry here is not a 404, it is an
  // asset served as application/octet-stream, which a browser renders as a
  // download prompt or as nothing at all.
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
};

/**
 * On every response this surface writes, without exception.
 *
 * The thing being protected is not a static site. It is an authenticated
 * session cookie in front of a renderer that can read the user's filesystem
 * through the host bridge and drive a logged-in Codex app, reachable from a
 * phone over a tunnel. Three headers, each closing something that is otherwise
 * open by default:
 *
 *   X-Content-Type-Options: nosniff
 *     CONTENT_TYPES above is an allowlist and everything it does not know is
 *     served as application/octet-stream. Without nosniff a browser is free to
 *     ignore that and decide for itself, which turns "an asset type we forgot"
 *     into "a file in the archive executed as script". The archive holds 546 MB
 *     of other people's build output; we do not get to audit all of it.
 *
 *   X-Frame-Options: SAMEORIGIN, and frame-ancestors 'self' for the browsers
 *   that prefer CSP
 *     Clickjacking an authenticated relay is the cheap attack here: the UI has
 *     destructive affordances one click deep, and a tunnelled origin is a URL
 *     an attacker can guess at or be handed. SAMEORIGIN rather than DENY
 *     because the renderer does frame its own origin -- the shipped policy
 *     lists `frame-src 'self' blob:` -- and DENY would buy nothing extra
 *     against a cross-origin framer while risking a blank Apps panel.
 *     frame-ancestors has to travel as a header: it is one of the three
 *     directives a <meta> CSP is required to ignore, so the renderer's own
 *     policy cannot express it however it is written. A header policy that
 *     names only frame-ancestors constrains nothing else -- policies
 *     intersect, and a directive a policy omits is a directive it has no
 *     opinion about -- so this does not quietly re-open or re-close anything
 *     src/renderer/boot.mjs decided.
 *
 *   Referrer-Policy: no-referrer
 *     Nothing this surface serves has a legitimate reason to tell another
 *     origin where the request came from, and on a tunnel the origin IS the
 *     secret -- a referrer leak hands out the hostname that the session cookie
 *     is scoped to. Note the shipped document carries its own
 *     <meta name="referrer" content="origin">, and for that one document the
 *     meta wins; this header still governs every asset request that is made
 *     before the meta is parsed, and every response that is not that document.
 */
const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': "frame-ancestors 'self'",
  'Referrer-Policy': 'no-referrer',
});

/**
 * `private` on everything the static paths serve, next to the `no-cache` that
 * was already there.
 *
 * `no-cache` means revalidate, not "do not store", so without `private` a
 * shared cache between the phone and this process is entitled to keep a copy
 * of an authenticated response and hand it to the next person who asks. That
 * intermediary is not hypothetical here: the whole point of this surface is to
 * be reached through a tunnel, and a tunnel is exactly the sort of place a
 * caching proxy lives. The revalidation behaviour is unchanged, so the ETag
 * conversation below still works the way it did.
 */
const PRIVATE_CACHE = 'private, no-cache';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** NDJSON to a stream. Fields are whatever the call site passes -- see the rule above. */
export function createLogger({ stream = process.stderr, level = 'info', now = Date.now } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl) => (event, fields = {}) => {
    if (LEVELS[lvl] < threshold) return;
    try {
      stream.write(`${JSON.stringify({ ts: new Date(now()).toISOString(), level: lvl, event, ...fields })}\n`);
    } catch { /* a broken log pipe must never break the relay */ }
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Pull the JSON-RPC method name out of a frame without parsing it. A bounded
 * regex over the head of the string costs nothing and -- unlike JSON.parse --
 * cannot be talked into materialising a megabyte of attacker-shaped objects
 * just so we can write one word to a log.
 */
export function rpcMethod(data) {
  if (typeof data !== 'string') return undefined;
  const match = /"method"\s*:\s*"([^"\\]{1,80})"/.exec(data.slice(0, 512));
  return match ? match[1] : undefined;
}

const byteLength = (data) => (typeof data === 'string' ? Buffer.byteLength(data) : data.length);

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(payload);
}

function sendText(res, status, message) {
  const payload = Buffer.from(`${message}\n`, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': payload.length,
    ...SECURITY_HEADERS,
  });
  res.end(payload);
}

/**
 * A redirect with no body, carrying the query along.
 *
 * The query is copied from the request target rather than rebuilt, so it stays
 * byte-identical: this surface receives bootstrap links in a query, and a
 * re-encoding round trip through URLSearchParams is how base64url-shaped values
 * acquire a `+`. `no-cache` is deliberate on a 308 -- a permanent redirect is
 * cacheable by default and this one is a statement about the mount list, which
 * is configuration, not about the URL space forever.
 */
function sendRedirect(req, res, path) {
  const target = String(req.url ?? '');
  const mark = target.indexOf('?');
  res.writeHead(308, {
    Location: mark === -1 ? path : `${path}${target.slice(mark)}`,
    'Content-Length': 0,
    'Cache-Control': 'no-cache',
    ...SECURITY_HEADERS,
  });
  res.end();
  return undefined;
}

/** Read a bounded JSON body. Oversize bodies are refused, not buffered. */
function readJson(req, maxBytes) {
  return new Promise((res, rej) => {
    const chunks = [];
    let total = 0;
    let overflowed = false;
    req.on('data', (chunk) => {
      // Past the cap we keep draining but stop keeping: the 413 is already on
      // its way out and nothing further is retained.
      if (overflowed) return;
      total += chunk.length;
      if (total > maxBytes) {
        overflowed = true;
        chunks.length = 0;
        rej(Object.assign(new Error('request body too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', rej);
    req.on('end', () => {
      if (total === 0) return res({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('body must be a JSON object');
        }
        res(parsed);
      } catch (err) {
        rej(Object.assign(new Error(`invalid JSON body: ${err.message}`), { status: 400 }));
      }
    });
  });
}

/** base64url -> bytes for the fields a browser sends as strings. */
function requiredBytes(body, field) {
  const value = body[field];
  if (typeof value !== 'string' || value === '') {
    throw Object.assign(new Error(`missing field ${field}`), { status: 400 });
  }
  try {
    return base64urlDecode(value);
  } catch {
    throw Object.assign(new Error(`field ${field} is not base64url`), { status: 400 });
  }
}

function requiredString(body, field) {
  const value = body[field];
  if (typeof value !== 'string' || value === '') {
    throw Object.assign(new Error(`missing field ${field}`), { status: 400 });
  }
  return value;
}

const asBytes = (value) => (Buffer.isBuffer(value) ? value
  : typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value));

/**
 * A validator for bytes this process produced rather than read.
 *
 * It is a hash of the body and not a date, because an override's bytes are a
 * function of the archive *and* of how this process was configured -- the
 * patched index.html changes when the patcher's options change, while the asar
 * underneath keeps its mtime. A date-shaped validator would then tell a phone
 * that holds last boot's copy that nothing has changed, and the phone would
 * keep booting the old shim with no way to notice. A content hash cannot say
 * that.
 */
function overrideEtag(bytes) {
  return `"o${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}"`;
}

/**
 * Normalise one mount's `overrides` into a lookup keyed the way a request
 * arrives: archive-relative, no leading slash.
 *
 * Both shapes are accepted because the two callers want different ones. A
 * caller that can compute its document once (at boot, from bytes it already
 * holds) passes bytes, and pays for the hash once here. A caller that has to
 * see the archive's own copy first -- the patched index.html is a transform of
 * the shipped one, not a replacement for it -- passes a function and gets the
 * entry's bytes handed to it.
 *
 * Everything that can be wrong with an override is wrong at construction, in
 * the spirit of the prefix checks above: a key that no request can ever match
 * is otherwise a mount that silently serves the unpatched document, which is a
 * blank page somewhere much later.
 */
function prepareOverrides(prefix, overrides) {
  const prepared = new Map();
  if (overrides === undefined || overrides === null) return prepared;
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error(`overrides on mount ${JSON.stringify(prefix)} must be a map of path to bytes`);
  }
  for (const [path, value] of Object.entries(overrides)) {
    const key = String(path).replace(/^\/+/, '');
    if (key === '' || key.endsWith('/')) {
      throw new Error(`override ${JSON.stringify(path)} on mount ${JSON.stringify(prefix)} must name a file`);
    }
    if (prepared.has(key)) {
      throw new Error(`two overrides on mount ${JSON.stringify(prefix)} claim ${JSON.stringify(key)}`);
    }
    if (typeof value === 'function') {
      prepared.set(key, { produce: value });
    } else if (typeof value === 'string' || value instanceof Uint8Array) {
      const bytes = asBytes(value);
      prepared.set(key, { bytes, etag: overrideEtag(bytes) });
    } else {
      throw new Error(`override ${JSON.stringify(path)} on mount ${JSON.stringify(prefix)} must be bytes, a string, or a function`);
    }
  }
  return prepared;
}

/**
 * @param {object} options
 * @param {string} [options.host] defaults to 127.0.0.1 -- a wildcard bind has
 *   to be asked for explicitly, because this process is reached through an
 *   authenticated ingress and never by being exposed directly.
 * @param {string} [options.staticRoot] directory served at /
 * @param {Record<string,string>} [options.staticMounts] extra URL-prefix ->
 *   directory pairs, for files the page needs that live outside staticRoot.
 *   Prefixes must begin and end with `/`; longest match wins.
 * @param {Record<string,{archive: import('../renderer/asar.mjs').Archive,
 *   base?: string, requireSession?: boolean,
 *   overrides?: Record<string, Uint8Array|string|((original: Buffer|null,
 *     context: {path: string, prefix: string}) => Uint8Array|string|Promise<Uint8Array|string>)>}>}
 *   [options.archiveMounts] the same, but served out of an asar instead of a
 *   directory. `base` is the prefix inside the archive (`webview`), and
 *   `requireSession` defaults to true. `overrides` maps a mount-relative path
 *   to the bytes to serve there instead of the archive's -- see
 *   prepareOverrides.
 * @param {import('../auth/ceremony.mjs').Ceremonies} [options.ceremonies]
 * @param {import('../auth/session.mjs').SessionManager} [options.sessions]
 * @param {(token: string) => object} [options.authenticate] session verifier
 * @param {(ctx: object) => Promise<object>} options.createUpstream upstream factory
 */
export function createSurface({
  host = process.env.CODEX_RELAY_HOST || '127.0.0.1',
  port = Number(process.env.CODEX_RELAY_PORT ?? 8787),
  staticRoot = process.env.CODEX_RELAY_STATIC || null,
  staticMounts = {},
  archiveMounts = {},
  wsPath = '/ws',
  ceremonies = null,
  sessions = null,
  authenticate = null,
  createUpstream = null,
  logger = silentLogger,
  cookieSameSite = 'Lax',
  allowPublicBind = false,
  maxBodyBytes = 64 * 1024,
  maxPendingBytes = 1024 * 1024,
  shutdownGraceMs = 25,
  ws: wsLimits = {},
} = {}) {
  const cookieName = sessions?.cookieName ?? SESSION_COOKIE;
  // Checked at construction, not at first login: a deployment that mistyped
  // this would otherwise boot clean, serve the page, and fail on the one
  // request that matters, with a 500 and nothing to read.
  assertSameSite(cookieSameSite);
  /**
   * Static serving is a list of mounts rather than a single root, because the
   * front end needs two modules that live outside it and both alternatives are
   * worse. Widening `staticRoot` to the repository root would publish `.git`,
   * `test/` and `docs/` to a surface that is reachable from a phone; a symlink
   * out of the root is refused by the containment check in serveStatic, and
   * should be. So the one directory the page legitimately needs is named
   * explicitly, under a URL prefix whose name says that exposure is deliberate.
   *
   * Longest prefix wins, so a mount stays reachable even though `/` matches it
   * too. Each mount carries its own lazily-resolved realpath, for the same
   * reason the root had one: resolving it also proves the directory exists.
   */
  const mounts = [];
  const assertPrefix = (prefix) => {
    if (!prefix.startsWith('/') || !prefix.endsWith('/')) {
      throw new Error(`static mount prefix ${JSON.stringify(prefix)} must start and end with /`);
    }
    if (prefix === '/') throw new Error('serve / with staticRoot, not with a mount');
    if (mounts.some((m) => m.prefix === prefix)) {
      throw new Error(`two mounts claim ${JSON.stringify(prefix)}`);
    }
  };
  for (const [prefix, dir] of Object.entries(staticMounts)) {
    assertPrefix(prefix);
    mounts.push({ prefix, root: resolve(dir), realRoot: null });
  }
  /**
   * An archive mount is the same idea with a different backing store: the
   * shipped renderer is 19,845 files inside a 546 MB asar, and unpacking it to
   * serve it would create a second copy that goes stale when the App updates.
   *
   * It defaults to requiring a session where a directory mount does not, and
   * the asymmetry is deliberate rather than nervous. `web/` is our own shell --
   * it has to be readable before login, because logging in is what it is for.
   * The renderer is somebody else's proprietary bundle, nothing in it is needed
   * to authenticate, and this surface is reachable from a phone. So the default
   * is the one that is safe to get wrong.
   *
   * An archive mount may also override individual paths. That exists because
   * the one document we have to change -- index.html, which has to carry our
   * host shim before the bundle's module entry runs -- must not be changed
   * where it lives: the asar belongs to the App, the App replaces it on every
   * update, and a mutated copy is both a licence question and a file that goes
   * stale silently. Overriding at serve time keeps the archive read-only and
   * keeps the transform in one pure function, which is testable without a
   * server.
   */
  for (const [prefix, spec] of Object.entries(archiveMounts)) {
    assertPrefix(prefix);
    if (!spec?.archive) throw new Error(`archive mount ${JSON.stringify(prefix)} has no archive`);
    const base = spec.base ? `${String(spec.base).replace(/^\/+|\/+$/g, '')}/` : '';
    mounts.push({
      prefix,
      archive: spec.archive,
      base,
      requireSession: spec.requireSession !== false,
      overrides: prepareOverrides(prefix, spec.overrides),
    });
  }
  mounts.sort((a, b) => b.prefix.length - a.prefix.length);
  if (staticRoot) mounts.push({ prefix: '/', root: resolve(staticRoot), realRoot: null });

  /**
   * Where the real App is served, for /auth/status to point a client at. The
   * first archive mount is it: an archive mount is by construction the shipped
   * bundle, and a deployment that mounted two of them would still want the
   * longest-prefix winner, which is where the sort above has just put it.
   */
  const appMount = mounts.find((m) => m.archive) ?? null;

  const verifySession = authenticate
    ?? (ceremonies ? (token) => ceremonies.authenticate(token)
      : sessions ? (token) => sessions.verify(token)
        : () => { throw new Error('the surface has no session verifier configured'); });

  /**
   * The auth module defaults to SameSite=Lax and documents why (enrolment starts
   * with a cross-site top-level navigation, which Strict would break). A
   * deployment that wants Strict says so here, and we pass the choice down
   * rather than rewriting the serialized header: the __Host- rules and the
   * attribute order belong to one file, and both the cookie that logs in and the
   * cookie that logs out have to carry the same answer.
   */
  const sessionCookie = (token) => sessions.cookie(token, { sameSite: cookieSameSite });
  const clearSessionCookie = () => sessions.clearCookie({ sameSite: cookieSameSite });

  const connections = new Set();
  const server = createServer();
  server.on('request', (req, res) => {
    handleRequest(req, res).catch((err) => {
      const status = err?.status ?? 500;
      logger.warn('http.error', { method: req.method, path: safePath(req.url), status, message: err?.message });
      if (!res.headersSent) sendJson(res, status, { error: err?.message ?? 'internal error' });
      else res.destroy();
    });
  });
  server.on('upgrade', (req, socket, head) => {
    // Attached first: an upgrade socket with no error listener is an uncaught
    // exception waiting for a client that disappears mid-handshake.
    socket.on('error', (err) => logger.warn('ws.socket_error', { message: err.message }));
    try {
      handleUpgrade(req, socket, head);
    } catch (err) {
      logger.error('ws.upgrade_failed', { message: err?.message });
      refuseUpgrade(socket, 500, 'internal error');
    }
  });
  server.on('clientError', (err, socket) => {
    logger.debug('http.client_error', { code: err?.code });
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  function safePath(url) {
    // Log the path only, never the query: a bootstrap link rides in a query.
    const q = String(url ?? '').indexOf('?');
    return q === -1 ? String(url ?? '') : String(url).slice(0, q);
  }

  function parsePath(url) {
    try {
      return new URL(url, 'http://surface.invalid').pathname;
    } catch {
      return null;
    }
  }

  // ---- HTTP ---------------------------------------------------------------

  async function handleRequest(req, res) {
    const pathname = parsePath(req.url);
    if (pathname === null) return sendText(res, 400, 'malformed request target');

    if (pathname.startsWith('/auth/')) return handleAuth(req, res, pathname);
    if (pathname === wsPath) {
      // A plain GET on the websocket path means the client forgot to upgrade.
      return sendText(res, 426, 'this endpoint requires a websocket upgrade');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'method not allowed');
    if (mounts.length === 0) return sendText(res, 404, 'not found');
    return serveStatic(req, res, pathname);
  }

  /**
   * What a client needs to know to leave the login page for the real App: is
   * there one, and at which URL prefix.
   *
   * The prefix is the only thing reported, and deliberately: the archive's path
   * on disk and its `base` inside the archive are this process's business, and
   * naming them here would publish filesystem layout to an endpoint that
   * answers before anybody has authenticated. A URL the client is about to
   * navigate to is not a secret -- it is a 401 away from being useful.
   *
   * `available` reports what a navigation would actually get rather than what
   * was configured. A `stat` walks the header tree that is already in memory,
   * so it costs no I/O, and it throws in exactly the case where a configured
   * mount answers 503 anyway: the archive was closed under us because the App
   * updated. Telling the client "not available" then is the difference between
   * a message and a blank page.
   */
  function appMountStatus() {
    if (!appMount) return { available: false, prefix: null };
    let entry;
    try {
      entry = appMount.archive.stat(`${appMount.base}index.html`);
    } catch {
      return { available: false, prefix: appMount.prefix };
    }
    return { available: entry !== null || appMount.overrides.has('index.html'), prefix: appMount.prefix };
  }

  async function handleAuth(req, res, pathname) {
    if (!ceremonies || !sessions) return sendJson(res, 503, { error: 'authentication is not configured' });
    if (pathname === '/auth/status' && req.method === 'GET') {
      // `enrolled` keeps its exact meaning and spelling -- it is this
      // endpoint's original contract and the login page branches on it. `app`
      // is additive, and exists so the page can navigate to the renderer
      // instead of hardcoding a prefix this process chose.
      return sendJson(res, 200, { enrolled: ceremonies.isEnrolled, app: appMountStatus() });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });

    const body = await readJson(req, maxBodyBytes);
    const cookies = parseCookies(req.headers.cookie);
    const sessionToken = cookies[cookieName] ?? null;

    try {
      switch (pathname) {
        case '/auth/enroll/begin': {
          const started = ceremonies.startEnrollment({
            bootstrapToken: typeof body.bootstrapToken === 'string' ? body.bootstrapToken : null,
            sessionToken,
          });
          logger.info('auth.enroll_begin', {});
          return sendJson(res, 200, started);
        }
        case '/auth/enroll/finish': {
          const result = ceremonies.finishEnrollment({
            challengeId: requiredString(body, 'challengeId'),
            attestationObject: requiredBytes(body, 'attestationObject'),
            clientDataJSON: requiredBytes(body, 'clientDataJSON'),
            label: typeof body.label === 'string' ? body.label : undefined,
          });
          logger.info('auth.enroll_finish', { backedUp: result.backedUp });
          return sendJson(res, 200, { ok: true, credentialId: result.credentialId }, {
            'Set-Cookie': sessionCookie(result.sessionToken),
          });
        }
        case '/auth/login/begin': {
          logger.info('auth.login_begin', {});
          return sendJson(res, 200, ceremonies.startLogin());
        }
        case '/auth/login/finish': {
          const result = ceremonies.finishLogin({
            challengeId: requiredString(body, 'challengeId'),
            credentialId: requiredString(body, 'credentialId'),
            authenticatorData: requiredBytes(body, 'authenticatorData'),
            clientDataJSON: requiredBytes(body, 'clientDataJSON'),
            signature: requiredBytes(body, 'signature'),
          });
          logger.info('auth.login_finish', { expiresAt: result.expiresAt });
          return sendJson(res, 200, { ok: true, expiresAt: result.expiresAt }, {
            'Set-Cookie': sessionCookie(result.sessionToken),
          });
        }
        case '/auth/logout':
          logger.info('auth.logout', {});
          return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
        default:
          return sendJson(res, 404, { error: 'no such endpoint' });
      }
    } catch (err) {
      // Ceremony and session errors carry a status and a message written for a
      // user; neither ever contains the token that failed.
      const status = err?.status ?? (err?.name === 'SessionError' ? 401 : 400);
      logger.warn('auth.rejected', { path: pathname, status, reason: err?.message });
      return sendJson(res, status, { error: err?.message ?? 'bad request' });
    }
  }

  // ---- static -------------------------------------------------------------

  async function serveStatic(req, res, pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return sendText(res, 400, 'malformed path');
    }
    // A NUL truncates paths in some syscalls; never let one reach the fs layer.
    if (decoded.includes('\0')) return sendText(res, 400, 'malformed path');

    // Choose the mount before touching the filesystem, and resolve only the
    // remainder of the path inside it. A `..` in that remainder is therefore
    // checked against the mount's own root rather than against `/`'s, so one
    // mount can never be used to read out of another.
    const mount = mounts.find((m) => decoded.startsWith(m.prefix) || decoded === m.prefix.slice(0, -1));
    if (!mount) return sendText(res, 404, 'not found');

    // A request for the bare prefix (`/app`) is a redirect, not a document.
    // The matcher above accepts it, and answering it with the mount's
    // index.html -- which is what this function used to do -- produces a page
    // that loads nothing: every asset reference in the shipped bundle is
    // relative (`./assets/index-56e9f72c1d6a.js`), and a browser resolves
    // those against `/` for a document at `/app` and against `/app/` only when
    // the URL ends in a slash. The result is a blank page whose only symptom
    // is a console of 404s, so the slash is restored before a document is ever
    // produced. The root mount cannot reach this branch: its prefix minus the
    // slash is the empty string, which no pathname equals.
    //
    // 308 rather than 302 because the method and body have to survive: a 302
    // lets a client turn a POST into a GET, and while nothing here accepts a
    // POST on a mount today, a redirect that quietly rewrites requests is not
    // a thing to leave lying in a static server.
    //
    // This runs ahead of the archive mount's session gate, so an anonymous
    // request learns that the prefix exists. That is already public: it is the
    // prefix /auth/status hands out so a client does not have to hardcode it,
    // and the request the redirect points at is still a 401 without a session.
    if (decoded === mount.prefix.slice(0, -1)) return sendRedirect(req, res, mount.prefix);

    const relative = decoded.slice(mount.prefix.length - 1) || '/';
    if (mount.archive) return serveFromArchive(req, res, mount, relative);
    const root = mount.root;

    // `.` + path keeps an absolute or doubled-slash request inside the root,
    // and resolve() collapses any `..` that survived URL normalisation (an
    // encoded `%2e%2e` does). The containment check below is what actually
    // enforces the boundary, before any syscall touches the candidate.
    const candidate = resolve(root, `.${relative.endsWith('/') ? `${relative}index.html` : relative}`);
    if (!contains(root, candidate)) {
      logger.warn('static.traversal_refused', { path: safePath(req.url) });
      return sendText(res, 403, 'forbidden');
    }

    mount.realRoot ??= realpath(root);
    let realRoot;
    try {
      realRoot = await mount.realRoot;
    } catch (err) {
      mount.realRoot = null;
      logger.error('static.root_missing', { message: err.message, mount: mount.prefix });
      return sendText(res, 500, 'static root unavailable');
    }

    let target = candidate;
    let info;
    try {
      info = await stat(target);
      if (info.isDirectory()) {
        target = join(target, 'index.html');
        info = await stat(target);
      }
      // realpath defeats a symlink inside the root that points outside it.
      const real = await realpath(target);
      if (!contains(realRoot, real)) {
        logger.warn('static.escape_refused', { path: safePath(req.url) });
        return sendText(res, 403, 'forbidden');
      }
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'ELOOP') {
        return sendText(res, 404, 'not found');
      }
      throw err;
    }
    if (!info.isFile()) return sendText(res, 404, 'not found');

    const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const lastModified = info.mtime.toUTCString();
    const headers = {
      'Content-Type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      ETag: etag,
      'Last-Modified': lastModified,
      // Revalidate rather than cache blindly: the renderer bytes change under
      // the same names whenever the App is updated.
      'Cache-Control': PRIVATE_CACHE,
      ...SECURITY_HEADERS,
    };

    if (req.headers['if-none-match'] === etag
      || (!req.headers['if-none-match'] && req.headers['if-modified-since'] === lastModified)) {
      res.writeHead(304, {
        ETag: etag,
        'Last-Modified': lastModified,
        'Cache-Control': PRIVATE_CACHE,
        ...SECURITY_HEADERS,
      });
      return res.end();
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      return res.end();
    }

    res.writeHead(200, headers);
    return pipeFile(req, res, createReadStream(target));
  }

  /**
   * The same contract as serveStatic, over an asar.
   *
   * There is no containment check here and none is missing. Resolution walks
   * the archive's header object one key at a time, so `..` is not a parent
   * reference -- it is a key that no archive has. The explicit refusal below
   * exists only so the attempt shows up in the log the way it does for a
   * directory mount; drop it and the request is still a 404.
   */
  async function serveFromArchive(req, res, mount, relative) {
    if (mount.requireSession) {
      try {
        verifySession(parseCookies(req.headers.cookie)[cookieName]);
      } catch (err) {
        logger.warn('static.denied', { path: safePath(req.url), reason: err?.message ?? 'no session' });
        return sendText(res, 401, 'authentication required');
      }
    }
    if (relative.split('/').includes('..')) {
      logger.warn('static.traversal_refused', { path: safePath(req.url) });
      return sendText(res, 403, 'forbidden');
    }

    let wanted = relative.endsWith('/') ? `${relative}index.html` : relative;

    // Checked against the normalised path, so `/app/` and `/app/index.html`
    // are the same override -- and before the archive is consulted, so a mount
    // may serve a document the bundle does not contain at all. It is the
    // directory *fallback* below that an override cannot intercept: an
    // override on `nested/index.html` is not found by a request for
    // `/app/nested`, which is why the bare prefix now redirects rather than
    // resolving an index in place.
    const override = mount.overrides.get(wanted.replace(/^\/+/, ''));
    if (override) return serveOverride(req, res, mount, override, wanted);

    let entry;
    let mtimeMs;
    try {
      const inside = (p) => mount.base + p.replace(/^\/+/, '');
      entry = mount.archive.stat(inside(wanted));
      // A directory resolves to its index, as it does under a directory mount.
      // Only `/app/` needs this today; having the two mounts answer the same
      // request differently is the kind of difference nobody discovers until a
      // link that works on the desktop 404s on a phone.
      if (!entry && !wanted.endsWith('/')) {
        const asDir = `${wanted}/index.html`;
        entry = mount.archive.stat(inside(asDir));
        if (entry) wanted = asDir;
      }
      mtimeMs = mount.archive.mtimeMs;
    } catch (err) {
      // The archive was closed under us, or its descriptor died. That is the
      // renderer being unavailable, not this request being wrong, and saying so
      // here keeps it out of the 500 that an unhandled throw would produce.
      logger.error('static.archive_unavailable', { message: err.message });
      return sendText(res, 503, 'renderer unavailable');
    }
    if (!entry) return sendText(res, 404, 'not found');

    // Identity, not freshness: an entry's bytes are fixed by where they sit in
    // an immutable archive, so offset and size identify them exactly, and the
    // archive's own mtime is what changes when the App is updated underneath
    // us. A clock plays no part, which is why this needs no mtime per entry --
    // asar does not store one.
    const etag = `"a${mtimeMs.toString(16)}-${entry.offset.toString(16)}-${entry.size.toString(16)}"`;
    const lastModified = new Date(mtimeMs).toUTCString();
    const headers = {
      'Content-Type': CONTENT_TYPES[extname(wanted).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': entry.size,
      ETag: etag,
      'Last-Modified': lastModified,
      'Cache-Control': PRIVATE_CACHE,
      ...SECURITY_HEADERS,
    };
    if (req.headers['if-none-match'] === etag
      || (!req.headers['if-none-match'] && req.headers['if-modified-since'] === lastModified)) {
      res.writeHead(304, {
        ETag: etag,
        'Last-Modified': lastModified,
        'Cache-Control': PRIVATE_CACHE,
        ...SECURITY_HEADERS,
      });
      return res.end();
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      return res.end();
    }

    let stream;
    try {
      stream = mount.archive.createReadStream(entry);
    } catch (err) {
      // Same failure, later: the headers above already promise a length, so
      // this has to fail before writeHead rather than truncate a response the
      // client is told it may cache.
      logger.error('static.archive_unavailable', { message: err.message });
      return sendText(res, 503, 'renderer unavailable');
    }
    res.writeHead(200, headers);
    return pipeFile(req, res, stream);
  }

  /**
   * One overridden path, served from memory.
   *
   * The whole body is materialised before a single header goes out, for the
   * reason the archive path gives above: Content-Length is a promise, and a
   * transform that throws halfway is a truncated response the client has
   * already been told it may cache. A function override is called per request
   * rather than memoised, because the archive it reads from is replaced
   * underneath this process when the App updates and a cached document would
   * then describe a bundle that is no longer being served. The cost is bounded
   * by what this is for: the shipped webview/index.html is 14,690 bytes, so a
   * read and a transform of it are noise next to the hundreds of asset
   * requests the same page load makes -- and those still stream straight out of
   * the archive, untouched.
   *
   * There is no Last-Modified. See overrideEtag: no date this process can
   * honestly quote changes when the transform's output does, and offering one
   * invites a conditional request that gets a wrong 304.
   */
  async function serveOverride(req, res, mount, override, wanted) {
    let { bytes, etag } = override;
    if (override.produce) {
      try {
        const entry = mount.archive.stat(mount.base + wanted.replace(/^\/+/, ''));
        const original = entry ? mount.archive.read(entry) : null;
        bytes = asBytes(await override.produce(original, { path: wanted, prefix: mount.prefix }));
      } catch (err) {
        // A closed archive and a transform that refuses the bytes it was given
        // are the same thing from here: this document cannot be produced. The
        // message goes to the log and not to the client, because a transform's
        // complaint quotes the document it was handed.
        logger.error('static.override_failed', { path: safePath(req.url), message: err?.message });
        return sendText(res, 503, 'renderer unavailable');
      }
      etag = overrideEtag(bytes);
    }

    const headers = {
      'Content-Type': CONTENT_TYPES[extname(wanted).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': bytes.length,
      ETag: etag,
      'Cache-Control': PRIVATE_CACHE,
      ...SECURITY_HEADERS,
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': PRIVATE_CACHE, ...SECURITY_HEADERS });
      return res.end();
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    res.end(bytes);
    return undefined;
  }

  /**
   * Shared tail: destroy in both directions. A client that disappears mid-asset
   * leaves a read stream pulling bytes out of a 546 MB archive for nobody, and
   * several hundred of those per page load is how a surface starts leaking file
   * handles on a flaky phone connection.
   */
  function pipeFile(req, res, stream) {
    stream.on('error', (err) => {
      logger.warn('static.read_failed', { message: err.message });
      res.destroy();
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    return undefined;
  }

  // ---- websocket gate + relay ---------------------------------------------

  function handleUpgrade(req, socket, head) {
    if (parsePath(req.url) !== wsPath) return refuseUpgrade(socket, 404, 'no websocket endpoint here');

    const token = parseCookies(req.headers.cookie)[cookieName];
    let session;
    try {
      session = verifySession(token);
    } catch (err) {
      // The reason is safe to log (it describes the failure, never the token).
      logger.warn('ws.denied', { reason: err?.message ?? 'no session' });
      return refuseUpgrade(socket, 401, 'authentication required');
    }
    if (!createUpstream) return refuseUpgrade(socket, 503, 'no upstream configured');

    const id = randomBytes(4).toString('hex');
    const ws = acceptUpgrade(req, socket, head, {
      ...wsLimits,
      onError: (err, where) => logger.warn('ws.error', { id, where, message: err?.message }),
    });
    if (!ws) {
      logger.warn('ws.handshake_refused', { id });
      return undefined;
    }
    logger.info('ws.open', { id, clients: connections.size + 1 });
    relay({ id, ws, session, socket });
    return undefined;
  }

  function relay({ id, ws, session, socket }) {
    const entry = { id, ws, socket, upstream: null };
    connections.add(entry);

    let upstream = null;
    let browserGone = false;
    let pending = [];
    let pendingBytes = 0;

    const guard = (where, fn) => {
      try {
        fn();
      } catch (err) {
        // One connection's failure stops at this boundary, every time.
        logger.warn('relay.failed', { id, where, message: err?.message });
        try { ws.close(CLOSE.internalError, 'relay failure'); } catch { /* already down */ }
      }
    };

    ws.onMessage((data) => {
      const bytes = byteLength(data);
      logger.debug('relay.to_upstream', { id, bytes, method: rpcMethod(data) });
      if (!upstream) {
        // The upstream handshake is async; a browser that starts talking
        // immediately must not lose its first frames -- but it must not be able
        // to make us hold an unbounded backlog either.
        pendingBytes += bytes;
        if (pendingBytes > maxPendingBytes) {
          logger.warn('relay.backlog_overflow', { id, bytes: pendingBytes });
          ws.close(CLOSE.tooBig, 'upstream handshake backlog exceeded');
          pending = [];
          return;
        }
        pending.push(data);
        return;
      }
      guard('upstream.send', () => upstream.send(data));
    });

    ws.onClose((code, reason) => {
      browserGone = true;
      connections.delete(entry);
      logger.info('ws.close', { id, code, reason, clients: connections.size });
      if (upstream) guard('upstream.close', () => upstream.close(CLOSE.normal, 'browser disconnected'));
    });

    Promise.resolve()
      .then(() => createUpstream({ id, session, logger }))
      .then((created) => {
        if (browserGone) {
          // Raced: the browser left while we were dialling. Hang up on the
          // upstream rather than leaking it.
          try { created.close(CLOSE.goingAway, 'browser already gone'); } catch { /* ignore */ }
          return;
        }
        upstream = created;
        entry.upstream = created;

        created.onMessage((data) => {
          logger.debug('relay.to_browser', { id, bytes: byteLength(data), method: rpcMethod(data) });
          guard('ws.send', () => ws.send(data));
        });
        created.onClose((code, reason) => {
          entry.upstream = null;
          upstream = null;
          logger.info('relay.upstream_closed', { id, code, reason });
          // Pass a usable code through; anything unsendable (1006 and friends)
          // becomes 1011 so the browser still learns it was not its own fault.
          guard('ws.close', () => ws.close(isSendableCloseCode(code) ? code : CLOSE.internalError, 'upstream closed'));
        });

        const backlog = pending;
        pending = [];
        pendingBytes = 0;
        logger.debug('relay.upstream_ready', { id, backlog: backlog.length });
        for (const frame of backlog) guard('upstream.send', () => created.send(frame));
      })
      .catch((err) => {
        logger.error('relay.upstream_unavailable', { id, message: err?.message });
        guard('ws.close', () => ws.close(CLOSE.internalError, 'upstream unavailable'));
      });
  }

  // ---- lifecycle ----------------------------------------------------------

  function listen() {
    if (!allowPublicBind && (host === '0.0.0.0' || host === '::' || host === '')) {
      throw new Error('refusing to bind a wildcard address; pass allowPublicBind to override');
    }
    return new Promise((res, rej) => {
      const onError = (err) => { server.removeListener('listening', onListening); rej(err); };
      const onListening = () => {
        server.removeListener('error', onError);
        const addr = server.address();
        logger.info('surface.listening', { host: addr.address, port: addr.port, mounts: mounts.map((m) => m.prefix) });
        res(addr);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  async function close() {
    for (const entry of connections) {
      try { entry.ws.close(CLOSE.goingAway, 'surface shutting down'); } catch { /* ignore */ }
      try { entry.upstream?.close(CLOSE.goingAway, 'surface shutting down'); } catch { /* ignore */ }
    }
    const closed = new Promise((res) => server.close(() => res()));
    server.closeIdleConnections();
    // Give the close frames a moment to flush, then take the rest down so a
    // stuck peer cannot hold shutdown open forever. Deliberately not unref'd:
    // this timer is the only thing guaranteeing progress, and an unref'd one
    // never fires if it is the last handle standing -- which is exactly the
    // situation at shutdown.
    const grace = setTimeout(() => {
      server.closeAllConnections();
      // Upgraded sockets are no longer the http server's to close, so a peer
      // that ignores our close frame has to be hung up on by hand.
      for (const entry of connections) entry.socket?.destroy();
    }, shutdownGraceMs);
    await closed;
    clearTimeout(grace);
    logger.info('surface.closed', {});
  }

  return { listen, close, address: () => server.address(), server, get clients() { return connections.size; } };
}

/** Is `child` the same path as `parent`, or inside it? */
export function contains(parent, child) {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}
