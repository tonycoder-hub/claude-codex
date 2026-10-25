// Rewriting the shipped webview/index.html so our middleware boots alongside
// the real renderer.
//
// Pure string in, string out. The bytes arrive from src/renderer/asar.mjs and
// leave towards an HTTP response; keeping the thing in the middle free of both
// ends is what lets test/renderer/boot.test.mjs assert on whole documents
// rather than on a mock of a file system. There is no fs, no archive and no
// network below this line.
//
// FIVE EDITS, AND WHY EACH ONE IS THE SHAPE IT IS
//
//   1. A module script at /host-boot.mjs, inserted immediately BEFORE the
//      bundle's single non-async module entry. Module scripts execute in
//      document order, so preceding the entry is the whole mechanism by which
//      our middleware installs its window listeners before the renderer's
//      first `postMessage` goes out. `async` is the one attribute that breaks
//      that guarantee -- an async module runs when it finishes loading, not
//      where it sits -- which is why the search below disqualifies async
//      scripts rather than simply taking the first module it finds.
//
//   2. The boot configuration as a meta tag, not an inline script. This is not
//      a style preference. The shipped CSP has no 'unsafe-inline' in
//      script-src (it carries 'self', one sha256 and 'wasm-unsafe-eval'), so
//      an inline <script> that handed our module its configuration would be
//      refused by the browser, and refused with a console line nobody reads
//      before concluding the relay is broken. A meta tag is markup; CSP has no
//      opinion about it. The payload is base64url of UTF-8 JSON, whose
//      alphabet is A-Za-z0-9-_ and therefore contains not one character that
//      needs escaping in a double-quoted attribute value.
//
//   3. viewport-fit=cover appended to the existing viewport meta. The shipped
//      meta is width=device-width, initial-scale=1.0 with no viewport-fit, and
//      without viewport-fit=cover iOS does not extend the page under the safe
//      areas at all: every env(safe-area-inset-*) in the design system
//      resolves to 0. There are six such declarations in the renderer's own
//      CSS (the responsive sheet's padding-bottom among them), so they are
//      inert today. Appending is deliberate -- the original attribute value is
//      kept verbatim and the new directive is added to the end of it, because
//      re-serialising a parsed directive list is exactly how you lose a
//      directive you did not know was there.
//
//   4. A stylesheet link at /host-touch.css, inserted immediately AFTER the
//      bundle's last stylesheet link. Our rules and the bundle's collide at
//      equal specificity on stable, unhashed selectors, and at equal
//      specificity the later rule wins. Position is therefore load-bearing,
//      which is why it is anchored to the bundle's stylesheet rather than to
//      the end of the head.
//
//   5. The Content Security Policy narrowed in place, in the three directives
//      that are this renderer's outbound data paths. It is the only edit that
//      changes what the renderer is ALLOWED to do rather than what it loads,
//      so it has a section of its own below.
//
// Both of our own URLs are absolute, and that is not an accident either. Every
// asset reference in the shipped document is relative (./assets/...), because
// it is loaded from a file next to its assets; our two files live at the
// document root while index.html is served under an archive mount prefix, so a
// relative specifier would resolve inside the mount and 404. Absolute,
// same-origin paths are also precisely what script-src 'self' permits.
//
// EDIT 5: THE CONTENT SECURITY POLICY, WHICH USED TO BE PASSED THROUGH
//
// Everything the other four edits load is already permitted by the shipped
// policy, and that half of the old reasoning still holds: script-src is
// 'self' plus one sha256 plus 'wasm-unsafe-eval', style-src is 'self'
// 'unsafe-inline', so a same-origin external module and a same-origin
// stylesheet both load, and a wss:// back to the origin that served the page
// is covered by connect-src's 'self'. That was confirmed empirically rather
// than derived from the grammar -- a probe run with PROBE_KEEP_CSP=1 injected
// its own <script src="/__probe/bootstrap.js"> into the otherwise unmodified
// document and it loaded and executed. Nothing we add needs relaxing.
//
// The other half of the old reasoning was wrong, and it was wrong about the
// one thing in this file that is a promise to a person rather than a working
// page. It said that leaving connect-src alone was a privacy property this
// relay got for free. It is not free and it was not a property.
//
// WHY THE SHIPPED POLICY DOES NOT BLOCK THE TELEMETRY POST
//
// The renderer carries a Statsig client that posts to a hard-coded absolute
// URL. assets__app-initial-60d038a052d7.js contains `https://chatgpt.com/ces/v1`
// and `https://chatgpt.com/ces/v1/rgstr` and hands the second to the event
// sender as `logEventUrl`; app-shared-59042e7300f7.js sends a batch with
// `fetch`, or with `navigator.sendBeacon` when the page is unloading. Neither
// route goes anywhere near this relay's host layers: web/host-fetch.mjs only
// ever sees the renderer's one universal `vscode://codex/...` RPC, and
// everything else the renderer wants it fetches itself. For this client the
// CSP is the only thing between a conversation and the network.
//
// The shipped connect-src does not list `https://chatgpt.com`. It lists
// `wss://chatgpt.com`. To CSP those are the same source. `scheme-part`
// matching in CSP3 returns Matches when the expression's scheme is "wss" and
// the URL's is "https" (w3c/webappsec-csp index.bs, `scheme-part` matching,
// case 4), the expression carries no port-part and the URL is on the default
// port, and the expression carries no path-part so every path matches. WebKit
// implements that case literally --
//
//   // Step 1.4: A is "wss" and B is "https".
//   if (scheme == "wss"_s && urlScheme == "https"_s)
//       return SchemeMatchResult::Match;
//
// -- in ContentSecurityPolicySource::schemeMatches, and every browser on an
// iPhone is WebKit. So the policy this file was forwarding byte for byte
// permits exactly the POST the old comment said it blocked, from an
// authenticated phone session, with the user's transcript in the body.
//
// Chromium's MatchScheme is narrower: it upgrades only http->https and
// ws->wss, so Chrome and the Electron app the bundle was built for refuse that
// post. That is why nobody noticed, and it is the reason this reasoning cites
// an engine's source rather than a measurement on one machine -- "measured
// zero egress" on a desktop says nothing about the phone the relay exists for.
//
// WHAT IS NARROWED, AND TO WHAT
//
// Three directives, by allowlist and not by denylist. CSP_NARROW below names
// what survives; every other source in those three is dropped, including
// sources that do not exist yet. Fail-closed is the whole point -- an App
// update that adds a twelfth telemetry origin is a source this patch has never
// heard of, and the only safe reading of a source this patch has never heard
// of is no.
//
//   connect-src 'self' blob:
//     'self' is the entire relay: the wss:// back to the origin that served
//     the page, and every same-origin request the host modules make. blob:
//     stays because a blob URL is local by construction and cannot be a
//     destination. Eleven sources go: ab.chatgpt.com, api.mapbox.com,
//     cdn.openai.com, events.mapbox.com, learn.chatgpt.com,
//     persistent.oaistatic.com, production.plaid.com, sandbox.plaid.com,
//     wss://chatgpt.com, wss://ws.chatgpt-staging.com and wss://ws.chatgpt.com.
//     This relay dials none of them and one of them is the sink above.
//
//   img-src 'self' blob: data: https://persistent.oaistatic.com
//     The shipped value ends in a bare `https:`. That is a scheme-source: it
//     permits a GET to any https origin there is. It is a wider one-way
//     channel than connect-src ever was -- a GET carries its payload in a path
//     and needs no reply, no CORS and no handler on the far end -- and the
//     policy reasoning this file used to carry did not mention it at all.
//     The only off-origin image host the bundle actually names is
//     persistent.oaistatic.com (two hard-coded default-avatar PNGs, present in
//     both chunks), and it is reachable today only BECAUSE of the scheme-source
//     -- img-src does not list it. So this is the one source that is replaced
//     rather than kept or dropped: `https:` becomes that one origin, which
//     keeps the avatars rendering and is still a strict narrowing, since the
//     origin it names is one of the ones the scheme-source already permitted.
//
//     The cost is real and worth stating: an image in a transcript whose URL
//     points at some other origin stops rendering. That is also the attack.
//     A model-authored `![](https://elsewhere/<secret>)` is the cheapest
//     exfiltration primitive any chat UI has, and it needs no compromise
//     anywhere -- only text in a conversation. The broken image is the control
//     working.
//
//   media-src 'self' blob: data:
//     The same scheme-source for the same reason, with nothing to keep: every
//     sound the renderer plays ships inside the archive and is served from
//     'self'.
//
//   `app:` is dropped from both of those. It is a custom protocol the Electron
//   main process registers at startup; a browser has no handler for it, so it
//   could never have loaded a byte here.
//
// WHAT IS DELIBERATELY LEFT WIDE, AND WHAT THAT COSTS
//
//   frame-src and child-src keep the sandbox, Plaid, Experian and YouTube
//   origins they shipped with. An iframe is a document load with a visible
//   result, nothing in the renderer navigates one without being asked, and
//   web-sandbox.oaiusercontent.com is the Apps feature rather than decoration.
//   It is nonetheless the widest hole left in this policy -- a frame can carry
//   data out in a URL and run script that talks back -- and it is the next one
//   to close if it is ever shown to be reachable unprompted.
//
//   script-src keeps the two off-origin scripts it shipped with: a Plaid link
//   bundle and the Silero voice wasm loader. Both are pinned to an exact path
//   rather than an origin, neither is reachable on a relay that answers no
//   Plaid endpoint and bridges no microphone, and a compromise of either CDN
//   is a compromise of the desktop app as well.
//
//   style-src keeps 'unsafe-inline'. The renderer writes its design tokens as
//   inline style attributes; removing it is a blank page, not a hardening.
//
// FAILING LOUDLY APPLIES TO THIS EDIT TOO. A document with no policy meta at
// all is refused rather than served unprotected, a policy with no connect-src
// is refused because `default-src 'none'` would then govern our own websocket,
// and a connect-src from which 'self' does not survive the filter is refused
// because that is the permanent-spinner failure the last section is about.
// test/renderer/boot.test.mjs patches a byte-for-byte snapshot of the real
// shipped policy, and checks that snapshot against the archive on any machine
// that has one, so the assertions there are about the policy a phone receives
// rather than about a fixture written by the same hand as the patcher.
//
// FAILING LOUDLY
//
// Every validation below ends in a throw, including several where a no-op
// would feel more forgiving. The reason is the failure mode on the other side:
// if our script is not injected, the renderer boots with no host at all, sends
// an `mcp-request`, and waits on it forever -- there is no default timeout on
// that path. The user sees a spinner and a clean console, and nothing anywhere
// says the document was not patched. A thrown error names the exact tag that
// changed, at the moment the archive is read, in the relay's own log. So this
// function validates the document it was written against, and an App update
// that reshapes the head is a startup error rather than a silent blank page.

import { base64urlEncode, base64urlDecode } from '../../web/base64url.mjs';

/**
 * The meta tag our middleware reads its configuration out of, and the two
 * same-origin URLs the surface must serve.
 *
 * These are exported because the browser half cannot import them. A module
 * under web/ may only import from web/ or from the mounted /src/appserver/
 * directory -- those are the only paths the browser can resolve -- so
 * web/host-boot.mjs has to spell the meta name itself. Exporting them at least
 * means the server side, the tests and the surface wiring all read the same
 * three strings, leaving exactly one hand-typed copy to keep honest.
 */
export const BOOT_META_NAME = 'codex-relay-boot';
export const BOOT_MODULE_SRC = '/host-boot.mjs';
export const TOUCH_CSS_HREF = '/host-touch.css';

/** Appended, never substituted. See edit 3 in the header. */
export const VIEWPORT_FIT = 'viewport-fit=cover';

/**
 * Edit 5's table: the only three directives this patch touches, and the only
 * sources that come out the other side of each.
 *
 * `keep` is an allowlist and not a denylist, so that the policy a future App
 * update ships can only ever get smaller on the way through here: a source
 * this table does not recognise is dropped, including one that does not exist
 * yet. `narrow` is the one exception and it is still a narrowing -- it maps a
 * source the shipped policy carries to a strictly smaller one that replaces
 * it, which is how `https:` becomes the single image origin the bundle
 * actually names. Anything added to `narrow` has to satisfy that by
 * inspection; nothing enforces it but this sentence.
 *
 * Matching is exact and case-sensitive against the shipped lowercase
 * spelling, and a directive left with nothing is a refusal rather than a
 * silent `connect-src;` that would block the relay's own socket. See the
 * header for what each entry is for and what the eleven dropped connect-src
 * sources were.
 */
export const CSP_NARROW = Object.freeze({
  'connect-src': Object.freeze({
    keep: Object.freeze(["'self'", 'blob:']),
    narrow: Object.freeze({}),
  }),
  'img-src': Object.freeze({
    // persistent.oaistatic.com appears in both halves on purpose. The shipped
    // policy reaches it only through the scheme-source, so `narrow` is what
    // puts it there; listing it in `keep` as well is what makes this patch
    // idempotent, which matters because the thing most likely to be fed back
    // through here is this patch's own output.
    keep: Object.freeze(["'self'", 'blob:', 'data:', 'https://persistent.oaistatic.com']),
    narrow: Object.freeze({ 'https:': 'https://persistent.oaistatic.com' }),
  }),
  'media-src': Object.freeze({
    keep: Object.freeze(["'self'", 'blob:', 'data:']),
    narrow: Object.freeze({}),
  }),
});

export class IndexHtmlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IndexHtmlError';
  }
}

/**
 * Attribute names and the three value forms HTML allows.
 *
 * A name must start with a letter, which is what keeps the trailing slash of a
 * self-closing tag from being read as an attribute of its own.
 */
const ATTRIBUTE = /([a-zA-Z][-a-zA-Z0-9:_.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * The attributes of one open tag, keyed by lowercased name. A valueless
 * attribute maps to the empty string, which is how the DOM reports it too, so
 * presence is tested with `in` and never by truthiness.
 */
function parseAttributes(text) {
  const attrs = Object.create(null);
  for (const [, name, quoted, single, bare] of text.matchAll(ATTRIBUTE)) {
    // First occurrence wins, matching how a browser resolves a duplicate
    // attribute rather than how a last-write-wins loop would.
    const key = name.toLowerCase();
    if (!(key in attrs)) attrs[key] = quoted ?? single ?? bare ?? '';
  }
  return attrs;
}

/**
 * Every open tag with the given name, in document order, as
 * `{ start, end, attrs }` with `end` exclusive.
 *
 * This is a scanner for one known, machine-generated document, not an HTML
 * parser, and the distinction is worth being explicit about. It skips comment
 * bodies, because a commented-out script tag is a legal thing for a build to
 * leave behind and must not be mistaken for the entry we insert ourselves in
 * front of. The one shape it cannot read is an unescaped `>` inside a quoted
 * attribute value, which the shipped document does not contain; were an update
 * to introduce one, the tag's attributes would come back truncated and the
 * document would be refused by the checks below rather than patched in the
 * wrong place, because every insertion point is a tag's start or end offset
 * and never anything derived from its contents.
 *
 * @param {string} html
 * @param {string} name lowercase tag name
 */
function openTags(html, name) {
  const found = [];
  const opener = new RegExp(`<(?:!--|${name}\\b)`, 'gi');
  let match;
  while ((match = opener.exec(html)) !== null) {
    if (match[0] === '<!--') {
      const close = html.indexOf('-->', match.index + 4);
      if (close < 0) throw new IndexHtmlError('the document contains an unterminated HTML comment');
      opener.lastIndex = close + 3;
      continue;
    }
    const close = html.indexOf('>', match.index);
    if (close < 0) throw new IndexHtmlError(`the document contains an unterminated <${name}> tag`);
    found.push({
      start: match.index,
      end: close + 1,
      attrs: parseAttributes(html.slice(match.index + name.length + 1, close)),
    });
    opener.lastIndex = close + 1;
  }
  return found;
}

/**
 * The whitespace between the start of a line and `index`, or the empty string
 * if anything else sits in front of it on that line.
 *
 * Purely cosmetic, and worth the dozen characters anyway: the first thing
 * anybody debugging a blank page does is view-source, and a patched document
 * whose indentation still lines up is a document they can read.
 */
function indentAt(html, index) {
  const lineStart = html.lastIndexOf('\n', index - 1) + 1;
  const prefix = html.slice(lineStart, index);
  return /^[ \t]*$/.test(prefix) ? prefix : '';
}

/** The value of one comma-separated viewport directive, or null if absent. */
function directiveValue(content, key) {
  for (const part of content.split(',')) {
    const equals = part.indexOf('=');
    if (equals < 0) continue;
    if (part.slice(0, equals).trim().toLowerCase() === key) return part.slice(equals + 1).trim();
  }
  return null;
}

/**
 * Refuse a document that already carries any one of our three markers.
 *
 * NOT for the reason this comment used to give. It said a second patch would
 * install the middleware twice and double every outbound message, and that is
 * not reachable: both tags would be `<script type="module"
 * src="/host-boot.mjs">`, a module map is keyed on the resolved URL, and a
 * module is fetched, instantiated and evaluated exactly once per map however
 * many tags name it. Two tags, one middleware, no duplicate frames. The guard
 * earns its place on two other grounds.
 *
 * The meta tag is the first, and it is the one marker a second patch really
 * does duplicate in a way that changes behaviour. web/host-boot.mjs reads it
 * with querySelector, which answers with the FIRST match in document order,
 * and both patches insert theirs immediately before the bundle entry -- so the
 * newer configuration lands in front of the older one and wins by accident of
 * insertion point rather than by anybody deciding it should. Reverse the order
 * of those two inserts some day and the page silently boots on a stale
 * codexAppSessionId and whatever codexHome the surface was configured with the
 * last time the document was patched. Nothing announces that.
 *
 * The error message is the second. Without this check the document is still
 * refused -- soleEntryScript would find two non-async module entries, ours and
 * the bundle's, and throw -- but it would throw "this document has 2 non-async
 * module entry scripts", which reads as the App having grown a second entry
 * and sends the next person to diff the bundle. Naming the marker we put there
 * ourselves costs three lines and points at what actually happened.
 */
function refuseIfAlreadyPatched({ scripts, metas, links }) {
  const seen = [];
  if (scripts.some((tag) => tag.attrs.src === BOOT_MODULE_SRC)) seen.push(`<script src="${BOOT_MODULE_SRC}">`);
  if (metas.some((tag) => (tag.attrs.name ?? '').toLowerCase() === BOOT_META_NAME)) {
    seen.push(`<meta name="${BOOT_META_NAME}">`);
  }
  if (links.some((tag) => tag.attrs.href === TOUCH_CSS_HREF)) seen.push(`<link href="${TOUCH_CSS_HREF}">`);
  if (seen.length > 0) {
    throw new IndexHtmlError(
      `this document has already been patched (found ${seen.join(', ')}); `
      + 'patching it again would leave two boot configurations in the head, and '
      + 'the renderer reads whichever one comes first',
    );
  }
}

/**
 * The one non-async module entry to insert ourselves in front of.
 *
 * Both the zero case and the many case are errors. Zero means the head no
 * longer looks like the one this was written against. Many means the bundle
 * grew a second entry and whichever one we precede, the other one may already
 * have run -- a coin flip between a working page and a permanent spinner is
 * not a thing to resolve by picking the first match.
 */
function soleEntryScript(scripts) {
  const entries = scripts.filter((tag) => (tag.attrs.type ?? '').trim().toLowerCase() === 'module'
    && typeof tag.attrs.src === 'string'
    && tag.attrs.src.length > 0
    && !('async' in tag.attrs));
  if (entries.length === 0) {
    throw new IndexHtmlError(
      'this document has no non-async module entry script, so there is no '
      + 'position at which our middleware is guaranteed to run before the renderer',
    );
  }
  if (entries.length > 1) {
    const srcs = entries.map((tag) => tag.attrs.src).join(', ');
    throw new IndexHtmlError(
      `this document has ${entries.length} non-async module entry scripts `
      + `(${srcs}); preceding one of them does not precede the others`,
    );
  }
  return entries[0];
}

/** The one viewport meta, which edit 3 extends rather than invents. */
function soleViewportMeta(metas) {
  const viewports = metas.filter((tag) => (tag.attrs.name ?? '').toLowerCase() === 'viewport');
  if (viewports.length === 0) {
    throw new IndexHtmlError(
      'this document has no <meta name="viewport">, which safe-area insets need extended rather than added',
    );
  }
  if (viewports.length > 1) {
    throw new IndexHtmlError(
      `this document has ${viewports.length} viewport metas; which one the browser honours is not ours to guess`,
    );
  }
  return viewports[0];
}

/**
 * The bundle's last stylesheet link, which ours is inserted after.
 *
 * Absent, this is an error rather than a fallback to the end of the head. The
 * position exists so our rules win the equal-specificity ties described in the
 * header; a document with no stylesheet of its own is not the document that
 * reasoning was measured against, and quietly guessing a position would mean
 * finding out on a phone.
 */
function lastStylesheetLink(links) {
  const sheets = links.filter((tag) => (tag.attrs.rel ?? '').trim().toLowerCase() === 'stylesheet');
  if (sheets.length === 0) {
    throw new IndexHtmlError(
      'this document links no stylesheet of its own, so there is no anchor that puts ours after the bundle',
    );
  }
  return sheets[sheets.length - 1];
}

/**
 * The one Content-Security-Policy meta that edit 5 narrows.
 *
 * Absent is an error and not a pass. A document that carries no policy is a
 * document served with no policy at all -- every directive this file reasons
 * about would be wide open, including the connect-src the previous section is
 * entirely about -- and quietly serving that is the opposite of what edit 5 is
 * for. Two of them is an error for the reason two viewports are: an additional
 * policy INTERSECTS with the first rather than replacing it, so which sources
 * actually survive is a function of both, and narrowing one of a pair is a
 * guess about the other.
 */
function soleCspMeta(metas) {
  const found = metas.filter(
    (tag) => (tag.attrs['http-equiv'] ?? '').trim().toLowerCase() === 'content-security-policy',
  );
  if (found.length === 0) {
    throw new IndexHtmlError(
      'this document carries no <meta http-equiv="Content-Security-Policy">, so there is no '
      + 'policy to narrow and nothing keeping the renderer off the network',
    );
  }
  if (found.length > 1) {
    throw new IndexHtmlError(
      `this document carries ${found.length} Content-Security-Policy metas; they intersect rather `
      + 'than replace each other, so narrowing one says nothing about what the page may do',
    );
  }
  return found[0];
}

/**
 * The five named character references an HTML serialiser may put in an
 * attribute value, and the way back.
 *
 * The shipped policy is written with `&#39;` for every `'`, which is why none
 * of this can be skipped: the policy's own directive separator is `;` and
 * `&#39;` ends in one, so splitting the raw attribute value on semicolons cuts
 * `default-src &#39;none&#39;` into three pieces and `script-src` into five.
 * Decoding first is the only way to see the directives that are actually there.
 */
const ATTRIBUTE_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'",
});
const ATTRIBUTE_ESCAPES = Object.freeze({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
});

const unescapeAttribute = (value) => value.replace(
  /&(amp|lt|gt|quot|#39);/g,
  (_whole, name) => ATTRIBUTE_ENTITIES[name],
);

/**
 * The two ways out, tried in order against the value that came in.
 *
 * Escaping `'` inside a double-quoted attribute is optional, and the shipped
 * document does it while a hand-written one would not. Picking a convention
 * and imposing it would mean a document in the other convention came back with
 * every directive silently re-spelled, so instead the convention is DERIVED:
 * whichever of these reproduces the untouched value byte for byte is the one
 * the document is written in, and a value neither reproduces is refused. That
 * is also the guard against conventions not listed here, `&apos;` being the
 * obvious one.
 */
const ATTRIBUTE_ESCAPERS = Object.freeze([
  (value) => value.replace(/[&<>"']/g, (ch) => ATTRIBUTE_ESCAPES[ch]),
  (value) => value.replace(/[&<>"]/g, (ch) => ATTRIBUTE_ESCAPES[ch]),
]);

/**
 * One directive, reduced to what CSP_NARROW says may survive it.
 *
 * Kept sources are copied out of the document rather than written here, so a
 * source that survives is byte-identical to the one that shipped and the
 * keep-list is only ever consulted as a predicate. Leading whitespace is
 * preserved for the same reason the viewport edit appends instead of
 * re-serialising: everything this patch has no reason to change should come
 * out the way it went in.
 */
function narrowDirective(segment, narrowed) {
  const parsed = /^(\s*)(\S+)([\s\S]*)$/.exec(segment);
  if (parsed === null) return segment;
  const [, lead, name, sources] = parsed;
  const rule = CSP_NARROW[name.toLowerCase()];
  if (!rule) return segment;
  narrowed.add(name.toLowerCase());

  const kept = [];
  for (const source of sources.split(/\s+/)) {
    if (source === '') continue;
    // A source that is both kept and substituted-to can arrive twice; a
    // duplicate source is harmless to a browser and confusing to a reader.
    const next = rule.keep.includes(source) ? source : rule.narrow[source];
    if (next !== undefined && !kept.includes(next)) kept.push(next);
  }
  if (kept.length === 0) {
    throw new IndexHtmlError(
      `narrowing ${name} would leave it empty: the shipped policy lists none of `
      + `${[...rule.keep, ...Object.keys(rule.narrow)].join(' ')}, and an empty directive refuses `
      + 'everything including this relay itself',
    );
  }
  return `${lead}${name} ${kept.join(' ')}`;
}

/**
 * Edit 5 over the decoded policy text.
 *
 * Walks the semicolon-separated directives and rewrites only the three in
 * CSP_NARROW, splicing each replacement back where it was so that every other
 * byte -- default-src, frame-src, script-src, the sha256, the trailing
 * semicolon -- survives verbatim.
 */
function narrowPolicy(policy) {
  const narrowed = new Set();
  const out = [];
  let cursor = 0;
  for (;;) {
    const semicolon = policy.indexOf(';', cursor);
    const end = semicolon < 0 ? policy.length : semicolon;
    out.push(narrowDirective(policy.slice(cursor, end), narrowed));
    if (semicolon < 0) break;
    out.push(';');
    cursor = semicolon + 1;
  }
  if (!narrowed.has('connect-src')) {
    throw new IndexHtmlError(
      'this policy has no connect-src, so default-src governs the websocket this relay is built on '
      + 'and this patch cannot tell whether the page would be allowed to open it',
    );
  }
  return out.join('');
}

/**
 * Edit 5, as a replacement of the policy tag's own bytes.
 *
 * The round-trip check is the safety net. This patch decodes the attribute,
 * edits the decoded text and re-encodes it, so it has to prove it re-encodes
 * the UNTOUCHED value to the bytes it was given before it is allowed to write
 * anything -- otherwise a document escaped some other way would come back with
 * every unrelated directive silently re-spelled, which is exactly the class of
 * change this file refuses to make by accident.
 */
function rewriteCsp(html, meta) {
  const raw = meta.attrs.content;
  if (typeof raw !== 'string' || raw === '') {
    throw new IndexHtmlError('the Content-Security-Policy meta has no content attribute to narrow');
  }
  const policy = unescapeAttribute(raw);
  const escape = ATTRIBUTE_ESCAPERS.find((candidate) => candidate(policy) === raw);
  if (escape === undefined) {
    throw new IndexHtmlError(
      'the Content-Security-Policy meta is escaped in a way this patch does not reproduce byte for '
      + 'byte, so narrowing it would rewrite directives it has no business touching',
    );
  }

  const tagText = html.slice(meta.start, meta.end);
  const quoted = `"${raw}"`;
  const at = tagText.indexOf(quoted);
  if (at < 0) {
    throw new IndexHtmlError(
      `the Content-Security-Policy meta has no double-quoted content attribute to narrow: ${tagText}`,
    );
  }
  const rewritten = tagText.slice(0, at)
    + `"${escape(narrowPolicy(policy))}"`
    + tagText.slice(at + quoted.length);
  return { at: meta.start, remove: meta.end - meta.start, insert: rewritten };
}

/**
 * The boot configuration as the attribute value of edit 2.
 *
 * The shape is checked before the encoding because of how JSON.stringify
 * fails: handed something it cannot represent at the top level it answers
 * `undefined` rather than throwing, and encoding that would put the nine
 * characters of the word "undefined" in the meta tag and leave the middleware
 * to discover it by reading a property off a string.
 */
function encodeBootConfig(bootConfig) {
  if (bootConfig === null || typeof bootConfig !== 'object' || Array.isArray(bootConfig)) {
    const got = Array.isArray(bootConfig) ? 'an array' : typeof bootConfig;
    throw new IndexHtmlError(`bootConfig must be a plain object, not ${got}`);
  }
  let json;
  try {
    json = JSON.stringify(bootConfig);
  } catch (err) {
    throw new IndexHtmlError(`bootConfig cannot be serialised as JSON: ${err.message}`);
  }
  if (typeof json !== 'string') {
    throw new IndexHtmlError(
      'bootConfig serialised to nothing at all, which a toJSON returning undefined will do',
    );
  }
  return base64urlEncode(new TextEncoder().encode(json));
}

/**
 * The inverse of edit 2, for the server side and for the tests.
 *
 * The browser gets its own three lines of this in web/host-boot.mjs, because
 * the mount rules forbid it from importing anything under src/renderer/. Both
 * halves decode with web/base64url.mjs and JSON.parse over a TextDecoder, so
 * the format has nowhere to drift to.
 */
export function decodeBootConfig(content) {
  if (typeof content !== 'string') throw new TypeError('the boot meta content must be a string');
  return JSON.parse(new TextDecoder().decode(base64urlDecode(content)));
}

/**
 * Rewrite the shipped index.html so our middleware loads alongside the real
 * renderer. Pure: same input, same output, no side effects.
 *
 * @param {string} html the document as shipped
 * @param {{bootConfig: object}} options
 * @returns {string} the patched document
 * @throws {IndexHtmlError} on a document this patch does not recognise, on one
 *   it has already patched, on a policy it cannot narrow without rewriting
 *   more than it means to, and on a bootConfig it cannot encode
 */
export function patchIndexHtml(html, { bootConfig } = {}) {
  if (typeof html !== 'string') throw new TypeError('patchIndexHtml expects the document as a string');

  const content = encodeBootConfig(bootConfig);

  const scripts = openTags(html, 'script');
  const metas = openTags(html, 'meta');
  const links = openTags(html, 'link');

  refuseIfAlreadyPatched({ scripts, metas, links });

  const entry = soleEntryScript(scripts);
  const viewport = soleViewportMeta(metas);
  const stylesheet = lastStylesheetLink(links);
  const policy = soleCspMeta(metas);

  const entryIndent = indentAt(html, entry.start);
  const sheetIndent = indentAt(html, stylesheet.start);

  const edits = [
    {
      at: entry.start,
      remove: 0,
      insert: `<meta name="${BOOT_META_NAME}" content="${content}">\n${entryIndent}`
        + `<script type="module" src="${BOOT_MODULE_SRC}"></script>\n${entryIndent}`,
    },
    {
      at: stylesheet.end,
      remove: 0,
      insert: `\n${sheetIndent}<link rel="stylesheet" href="${TOUCH_CSS_HREF}">`,
    },
    rewriteViewport(html, viewport),
    rewriteCsp(html, policy),
  ];

  // Applied back to front, so that splicing a later edit leaves the earlier
  // offsets meaning what they meant when they were computed. Re-scanning the
  // document between edits is the other way to stay honest, and it cannot work
  // here: the second scan would find the tags the first edit inserted and
  // refuse the document as already patched.
  let patched = html;
  for (const edit of [...edits].sort((a, b) => b.at - a.at)) {
    patched = patched.slice(0, edit.at) + edit.insert + patched.slice(edit.at + edit.remove);
  }
  return patched;
}

/**
 * Edit 3, as a replacement of the viewport tag's own bytes.
 *
 * Only the content attribute's value is touched, and only by appending, so
 * every other attribute and every other directive survives verbatim. An
 * existing viewport-fit is left exactly as the App shipped it when it already
 * says cover, and refused when it says anything else: overriding a deliberate
 * choice by the renderer's authors is not a thing to do silently, and the
 * alternative value is information worth putting in front of a human.
 */
function rewriteViewport(html, viewport) {
  const existing = directiveValue(viewport.attrs.content ?? '', 'viewport-fit');
  if (existing === 'cover') return { at: viewport.start, remove: 0, insert: '' };
  if (existing !== null) {
    throw new IndexHtmlError(
      `the viewport meta already asks for viewport-fit=${existing}; overriding `
      + 'that silently would change a rendering decision that is not ours',
    );
  }

  const tagText = html.slice(viewport.start, viewport.end);
  const rewritten = tagText.replace(
    /(\bcontent\s*=\s*)(["'])([^"']*)\2/i,
    (_whole, prefix, quote, value) => {
      const base = value.replace(/\s+$/, '').replace(/,$/, '');
      return `${prefix}${quote}${base.length === 0 ? VIEWPORT_FIT : `${base}, ${VIEWPORT_FIT}`}${quote}`;
    },
  );
  if (rewritten === tagText) {
    throw new IndexHtmlError(
      `the viewport meta has no quoted content attribute to extend: ${tagText}`,
    );
  }
  return { at: viewport.start, remove: viewport.end - viewport.start, insert: rewritten };
}
