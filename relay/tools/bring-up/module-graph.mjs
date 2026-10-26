// The URL paths a browser walks to boot one of the two documents, derived.
//
// local.sh used to carry this as two hand-written lists. They drifted, in the
// quiet direction: the second-document list named nine modules when the graph
// had thirteen, so a 404 on host-files.mjs or host-namespaces.mjs -- either of
// which is a blank page with a spinning logo and no console error, because the
// renderer's startup waits on host silence forever -- would have been reported
// green by the loop whose entire job was to catch exactly that.
//
// A list that has to be edited when a module is added will be out of date the
// first time somebody adds a module in a hurry. So this walks the graph from
// the entry point instead, using the same resolution rule the surface uses:
// `web/` is the document root and a mount prefix mirrors its repository path,
// which is what test/web/module-resolution.test.mjs pins and what makes one
// specifier spelling satisfy both Node and a browser.
//
// Resolution only, deliberately -- no HTTP. Whether the server answers is what
// the caller is testing; this says what the caller should ask for. And no
// check that the files exist: module-resolution.test.mjs already proves that
// against the whole directory, and duplicating it here would mean a broken
// import fails in two places with two different messages.
//
// Usage:  node tools/bring-up/module-graph.mjs [entry ...]
//
// Entries are URL paths (`/app.mjs`). With none, both documents' entries are
// walked: `/app.mjs` for the login page and `/host-boot.mjs` for the patched
// one. Output is one URL path per line, entries first, then everything
// reachable from them in discovery order.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const DOCUMENT_ROOT = join(REPO, 'web');

/** Any origin: only the pathname matters, and `URL` needs one to resolve against. */
const ORIGIN = 'https://surface.invalid';

/**
 * The two entry points, one per document.
 *
 * `/app.mjs` is what index.html loads before the handover; `/host-boot.mjs` is
 * what src/renderer/boot.mjs injects into the shipped index.html and is the
 * only script that document loads of ours. Everything else on either side is
 * reached through an import, which is the property that makes a walk complete.
 */
const DEFAULT_ENTRIES = ['/app.mjs', '/host-boot.mjs'];

/** The mount prefixes, read out of main.mjs rather than restated here. */
function mountPrefixes() {
  const source = readFileSync(join(REPO, 'src/surface/main.mjs'), 'utf8');
  const literal = /staticMounts:\s*\{([^}]*)\}/.exec(source);
  if (!literal) throw new Error('main.mjs has no staticMounts literal; this reader is stale');
  return [...literal[1].matchAll(/'(\/[^']*\/)'\s*:/g)].map((match) => match[1]);
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

/** The repository file the surface would answer a URL path with. */
function fileFor(urlPath, prefixes) {
  const mounted = prefixes.some((prefix) => urlPath.startsWith(prefix));
  return mounted ? join(REPO, urlPath.slice(1)) : join(DOCUMENT_ROOT, urlPath.slice(1));
}

const prefixes = mountPrefixes();
const entries = process.argv.slice(2);
const queue = entries.length > 0 ? [...entries] : [...DEFAULT_ENTRIES];
const seen = new Set(queue);
const order = [];

while (queue.length > 0) {
  const urlPath = queue.shift();
  order.push(urlPath);
  let source;
  try {
    source = readFileSync(fileFor(urlPath, prefixes), 'utf8');
  } catch {
    // A path that cannot be read is still worth printing: the caller's probe
    // is what should report it, with an HTTP code beside it. Swallowing it
    // here would turn a missing module into a shorter list nobody notices.
    continue;
  }
  for (const specifier of specifiersIn(source)) {
    if (!specifier.startsWith('.')) continue;
    const next = new URL(specifier, ORIGIN + urlPath).pathname;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(next);
  }
}

// Sorted after the entries so the probe output reads as a stable list rather
// than as whatever order the walk happened to take this time.
const isEntry = (urlPath) => (entries.length > 0 ? entries : DEFAULT_ENTRIES).includes(urlPath);
const walked = order.filter((urlPath) => !isEntry(urlPath)).sort();
for (const urlPath of [...order.filter(isEntry), ...walked]) process.stdout.write(`${urlPath}\n`);

// A walk that found almost nothing is a broken reader, not a small graph, and
// the caller cannot tell the difference from a list of paths.
if (order.length < 5) {
  process.stderr.write(`module-graph: only ${order.length} modules reached; the scan is broken\n`);
  process.exit(1);
}
