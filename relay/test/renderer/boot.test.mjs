// The index.html patcher, against documents this file builds tag by tag.
//
// The fixture is assembled here rather than checked in, for the same reason
// test/renderer/asar.test.mjs builds its archives: a fixture produced by the
// same reading that produced the patcher would agree with it by construction.
// What is reproduced faithfully is the part the patcher reasons about -- the
// head's tag order, the module entry's attributes, three modulepreloads, the
// stylesheet after them, and the entire Content Security Policy, all read off
// the shipped 14,690-byte /webview/index.html. What is abbreviated is bulk the
// patcher never looks at: the startup-loader's inline CSS is one rule here
// instead of several hundred lines.
//
// The policy is the exception to "assembled here", and deliberately so. This
// file used to carry six invented directives, and because they were invented
// they did not contain `wss://chatgpt.com` -- the source that makes the whole
// telemetry argument in src/renderer/boot.mjs come out the other way round on
// WebKit. A fixture that omits the thing the test is about cannot fail. So
// SHIPPED_DIRECTIVES below is transcribed byte for byte, and the first test in
// the file re-reads it out of app.asar whenever CODEX_RELAY_ASAR names one, so
// the transcription is checked rather than trusted on any machine that has the
// App installed.
//
// Every negative case below is one keyword argument away from the realistic
// one, so a test that fails names the single tag it changed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openArchive } from '../../src/renderer/asar.mjs';
import {
  patchIndexHtml,
  decodeBootConfig,
  IndexHtmlError,
  BOOT_META_NAME,
  BOOT_MODULE_SRC,
  TOUCH_CSS_HREF,
} from '../../src/renderer/boot.mjs';

/**
 * The shipped policy, every directive of it, in document order.
 *
 * Read `connect-src` before changing anything here. It lists `wss://chatgpt.com`
 * and not `https://chatgpt.com`, and under CSP3 scheme-part matching those are
 * the same source to a WebKit browser -- which is the entire reason edit 5
 * exists. A fixture that paraphrases this list is a fixture that cannot
 * disagree with the patcher.
 */
const SHIPPED_DIRECTIVES = [
  "default-src 'none'",
  "img-src 'self' app: blob: data: https:",
  "child-src 'self' blob: codex-sandbox://*.web-sandbox.oaiusercontent.com codex-sandbox://web-sandbox.oaiusercontent.com https://*.web-sandbox.oaiusercontent.com https://web-sandbox.oaiusercontent.com",
  "frame-src 'self' blob: codex-sandbox://*.web-sandbox.oaiusercontent.com codex-sandbox://web-sandbox.oaiusercontent.com https://*.web-sandbox.oaiusercontent.com https://cdn.plaid.com https://cdn.platform.openai.com https://mfe.prod.us-exp-api.experiancs.com https://mfe.uat.us-exp-api.experiancs.com https://web-sandbox.oaiusercontent.com https://www.youtube.com",
  "worker-src 'self' blob:",
  "script-src 'self' 'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk=' 'wasm-unsafe-eval' https://cdn.plaid.com/link/v2/stable/link-initialize.js https://persistent.oaistatic.com/voice/silero-vad-v6/ort-wasm-simd-threaded.30dd851d9c00622940500f71ddd2ff8820c5cb65270816080175b958705385a8.module.js",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "media-src 'self' app: blob: data: https:",
  "connect-src 'self' blob: https://ab.chatgpt.com https://api.mapbox.com https://cdn.openai.com https://events.mapbox.com https://learn.chatgpt.com https://persistent.oaistatic.com https://production.plaid.com https://sandbox.plaid.com wss://chatgpt.com wss://ws.chatgpt-staging.com wss://ws.chatgpt.com",
];

/** Decoded, with the trailing semicolon the document actually carries. */
const SHIPPED_POLICY = `${SHIPPED_DIRECTIVES.join('; ')};`;

/**
 * The attribute value as it appears in the file: every `'` written `&#39;`.
 *
 * Worth doing rather than writing the escaped form out, because it makes the
 * hazard visible. `&#39;` ends in a semicolon, so the raw attribute value
 * cannot be split on semicolons to find its directives -- `default-src
 * &#39;none&#39;` splits into three pieces and `script-src` into five. Edit 5
 * decodes before it edits for exactly this reason, and these tests hand it the
 * escaped bytes so that path is the one under test.
 */
const CSP = SHIPPED_POLICY.replaceAll("'", '&#39;');

/**
 * The policy after edit 5, which is the security claim of this whole change
 * spelled out in full rather than asserted directive by directive.
 *
 * Three lines differ from SHIPPED_DIRECTIVES and the other seven are identical
 * strings; a diff of this array against that one is the complete review of
 * what the patch does to the renderer's permissions.
 */
const NARROWED_DIRECTIVES = SHIPPED_DIRECTIVES.map((directive) => {
  if (directive.startsWith('img-src ')) return "img-src 'self' blob: data: https://persistent.oaistatic.com";
  if (directive.startsWith('media-src ')) return "media-src 'self' blob: data:";
  if (directive.startsWith('connect-src ')) return "connect-src 'self' blob:";
  return directive;
});
const NARROWED_POLICY = `${NARROWED_DIRECTIVES.join('; ')};`;

/**
 * The real archive, when this machine has one.
 *
 * Unset on the Linux host the suite normally runs on, which is why the check
 * below skips rather than fails there: a test that cannot see the App has
 * nothing to say about whether the transcription is current, and saying so out
 * loud is better than a red suite on every machine but one. `webview` is
 * RENDERER_ARCHIVE_BASE from src/surface/main.mjs, named here rather than
 * imported so this file stays a test of the renderer half alone.
 */
const ARCHIVE = process.env.CODEX_RELAY_ASAR || null;

test('the policy transcribed above is the policy the App actually ships', {
  skip: ARCHIVE === null && 'set CODEX_RELAY_ASAR to an app.asar to check this transcription',
}, () => {
  const archive = openArchive(ARCHIVE);
  try {
    const html = archive.read(archive.stat('webview/index.html')).toString('utf8');
    const tag = /<meta[^>]*http-equiv="Content-Security-Policy"[^>]*>/i.exec(html);
    assert.ok(tag, 'the shipped document has no CSP meta, which edit 5 would refuse');
    const shipped = /content="([^"]*)"/i.exec(tag[0])?.[1];

    // Byte for byte against the escaped form, so a changed escaping convention
    // fails here -- where the fix is to update a fixture -- rather than inside
    // rewriteCsp's round-trip guard on a user's phone.
    assert.equal(shipped, CSP, 'the shipped CSP has changed; re-transcribe SHIPPED_DIRECTIVES '
      + 'and re-read src/renderer/boot.mjs to see whether CSP_NARROW still names the right sources');
  } finally {
    archive.close();
  }
});

const ENTRY = '<script type="module" crossorigin src="./assets/index-56e9f72c1d6a.js"></script>';
const STYLESHEET = '<link rel="stylesheet" crossorigin href="./assets/app-shared-6fb15e58cd7f.css">';
const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1.0">';

/** A boot configuration shaped like the real one, plus two encoding traps. */
const CONFIG = {
  wsPath: '/ws',
  archiveMount: '/app/',
  // Not decoration: a multi-byte character and a quote character between them
  // prove the payload survives UTF-8 and never reaches the attribute raw.
  workspaceLabel: 'Ji Xu — "work"',
  limits: { maxPendingBytes: 1048576, timeoutMs: null },
  flags: ['touch', 'safe-area'],
};

function shippedDocument({
  viewport = VIEWPORT,
  entry = ENTRY,
  stylesheet = STYLESHEET,
  extraHead = '',
  csp = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
} = {}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    ${csp}
    ${viewport}
    <title>Codex</title>
    <style>
      .startup-loader{display:flex;width:100%;height:100%;align-items:center;justify-content:center;-webkit-app-region:drag}
    </style>
    ${entry}
    <link rel="modulepreload" crossorigin href="./assets/app-initial-60d038a052d7.js">
    <link rel="modulepreload" crossorigin href="./assets/app-shared-59042e7300f7.js">
    <link rel="modulepreload" crossorigin href="./assets/app-primary-547a6c7b4fb3.js">
    ${stylesheet}${extraHead}
  </head>
  <body tabindex="0" style="outline: none">
    <div id="root"><div class="startup-loader" aria-hidden="true"></div></div>
  </body>
</html>
`;
}

/** The whole CSP tag, so "unchanged" means every byte of it and not just its value. */
function cspTagOf(html) {
  const match = /<meta\s[^>]*http-equiv="Content-Security-Policy"[^>]*>/i.exec(html);
  assert.ok(match, 'this document has no CSP meta, so the test is asserting about nothing');
  return match[0];
}

/** Its content attribute, still escaped, exactly as a browser would read it. */
function cspValueOf(html) {
  const match = /content="([^"]*)"/i.exec(cspTagOf(html));
  assert.ok(match, 'the CSP meta has no quoted content attribute');
  return match[1];
}

/** And decoded, which is the form the directives are legible in. */
const cspPolicyOf = (html) => cspValueOf(html).replaceAll('&#39;', "'");

function viewportContentOf(html) {
  const match = /<meta name="viewport" content="([^"]*)">/i.exec(html);
  assert.ok(match, 'this document has no viewport meta');
  return match[1];
}

function bootMetaContentOf(html) {
  const match = new RegExp(`<meta name="${BOOT_META_NAME}" content="([^"]*)">`).exec(html);
  assert.ok(match, 'this document has no boot meta');
  return match[1];
}

test('a realistic document gets all five edits', () => {
  const html = shippedDocument();
  const patched = patchIndexHtml(html, { bootConfig: CONFIG });

  assert.match(patched, new RegExp(`<meta name="${BOOT_META_NAME}" content="[A-Za-z0-9_-]+">`));
  assert.ok(patched.includes(`<script type="module" src="${BOOT_MODULE_SRC}"></script>`));
  assert.ok(patched.includes(`<link rel="stylesheet" href="${TOUCH_CSS_HREF}">`));
  assert.ok(patched.includes('viewport-fit=cover'));
  assert.notEqual(cspValueOf(patched), CSP, 'edit 5 left the policy exactly as it shipped');

  // Everything the document already had is still there, including the three
  // modulepreloads and the body, so the patch added rather than rewrote.
  const kept = [ENTRY, STYLESHEET, '<div id="root">', 'app-primary-547a6c7b4fb3.js', '<title>Codex</title>'];
  for (const fragment of kept) {
    assert.ok(patched.includes(fragment), `the patch lost ${fragment}`);
  }
});

test('our module is inserted immediately before the entry, with only whitespace between', () => {
  const patched = patchIndexHtml(shippedDocument(), { bootConfig: CONFIG });

  const bootScript = `<script type="module" src="${BOOT_MODULE_SRC}"></script>`;
  const bootAt = patched.indexOf(bootScript);
  const entryAt = patched.indexOf(ENTRY);
  assert.ok(bootAt >= 0 && entryAt >= 0);

  // This is the assertion the whole module exists for. Module scripts execute
  // in document order, so our middleware installs its listeners before the
  // renderer's first outbound message only while nothing executable sits
  // between these two tags.
  const between = patched.slice(bootAt + bootScript.length, entryAt);
  assert.match(between, /^\s*$/, `something was inserted between our module and the entry: ${JSON.stringify(between)}`);

  // And the configuration precedes the module that reads it.
  assert.ok(patched.indexOf(`<meta name="${BOOT_META_NAME}"`) < bootAt);
});

test('our stylesheet goes after the bundle stylesheet, where equal-specificity ties are won', () => {
  const patched = patchIndexHtml(shippedDocument(), { bootConfig: CONFIG });
  assert.ok(patched.indexOf(TOUCH_CSS_HREF) > patched.indexOf('app-shared-6fb15e58cd7f.css'));
});

test('the served policy is exactly the one this file spells out', () => {
  const patched = patchIndexHtml(shippedDocument(), { bootConfig: CONFIG });

  // One assertion for the whole policy rather than one per directive, because
  // the thing worth reviewing is the complete list of what the renderer may
  // still reach, and a per-directive test lets a tenth directive appear
  // unnoticed.
  assert.equal(cspPolicyOf(patched), NARROWED_POLICY);

  // Still escaped the way it arrived, so this is also the round-trip guard
  // observed from outside: the patcher re-encoded the nine directives it did
  // not touch to the bytes they came in as.
  assert.equal(cspValueOf(patched), NARROWED_POLICY.replaceAll("'", '&#39;'));

  // And exactly one policy: a second http-equiv meta would intersect with the
  // first rather than replace it, which is a quieter way to break the page.
  assert.equal([...patched.matchAll(/http-equiv/gi)].length, 1);
});

test('the six directives edit 5 does not claim are passed through verbatim', () => {
  const patched = patchIndexHtml(shippedDocument(), { bootConfig: CONFIG });
  const policy = cspPolicyOf(patched);

  for (const directive of SHIPPED_DIRECTIVES) {
    const name = directive.slice(0, directive.indexOf(' '));
    if (['img-src', 'media-src', 'connect-src'].includes(name)) continue;
    assert.ok(policy.includes(directive), `edit 5 rewrote ${name}, which it has no business touching`);
  }

  // Named individually as well, because "verbatim" is the promise that makes
  // the Apps sandbox, Plaid's link bundle and the voice wasm loader keep
  // working, and a loop is easy to accidentally make vacuous.
  for (const kept of [
    "default-src 'none'",
    'https://web-sandbox.oaiusercontent.com',
    'https://www.youtube.com',
    "'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='",
    'https://cdn.plaid.com/link/v2/stable/link-initialize.js',
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
  ]) {
    assert.ok(policy.includes(kept), `the patch dropped ${kept}`);
  }
});

test('connect-src keeps the relay and loses the telemetry sink', () => {
  const patched = patchIndexHtml(shippedDocument(), { bootConfig: CONFIG });
  const policy = cspPolicyOf(patched);

  // 'self' is not decoration here: it is the wss:// back to the origin that
  // served the page, and without it default-src 'none' takes over and the
  // relay never connects at all.
  assert.ok(policy.includes("connect-src 'self' blob:;"));

  // The renderer posts to https://chatgpt.com/ces/v1/rgstr, hard-coded in
  // assets__app-initial-60d038a052d7.js and fed to Statsig as logEventUrl. The
  // shipped policy permits that POST on WebKit, because CSP3 scheme-part
  // matching treats the wss://chatgpt.com it DOES list as matching an https
  // URL on the same host. Dropping the source is what closes it.
  assert.ok(!policy.includes('chatgpt.com'), 'no spelling of the telemetry host may survive');

  for (const gone of [
    'https://ab.chatgpt.com',
    'https://api.mapbox.com',
    'https://events.mapbox.com',
    'https://learn.chatgpt.com',
    'https://production.plaid.com',
    'https://sandbox.plaid.com',
    'wss://chatgpt.com',
    'wss://ws.chatgpt.com',
    'wss://ws.chatgpt-staging.com',
  ]) {
    assert.ok(!policy.includes(`${gone} `) && !policy.includes(`${gone};`),
      `${gone} is still a connect-src source`);
  }

  // cdn.openai.com and persistent.oaistatic.com are dropped from connect-src
  // too; the latter survives elsewhere, which is why it is checked by
  // directive rather than by substring.
  const connect = /connect-src ([^;]*)/.exec(policy)[1];
  assert.equal(connect, "'self' blob:");
});

test('the bare https: scheme-source is gone from img-src and media-src', () => {
  const policy = cspPolicyOf(patchIndexHtml(shippedDocument(), { bootConfig: CONFIG }));

  // `https:` with nothing after it permits a GET to every https origin there
  // is, which is the cheapest exfiltration channel a chat UI has: a
  // model-authored <img src="https://elsewhere/<secret>"> needs no reply, no
  // CORS and no compromise anywhere. Note the trailing space and semicolon --
  // 'https://persistent.oaistatic.com' contains 'https:' as a prefix, so a
  // bare includes() here would pass no matter what the patch did.
  assert.equal(/img-src ([^;]*)/.exec(policy)[1], "'self' blob: data: https://persistent.oaistatic.com");
  assert.equal(/media-src ([^;]*)/.exec(policy)[1], "'self' blob: data:");
  assert.ok(!/(^|[\s;])https:(\s|;)/.test(policy), 'a bare https: scheme-source survived');

  // app: is dropped from both: it is a protocol the Electron main process
  // registers, and a browser has no handler for it.
  assert.ok(!/(^|[\s;])app:(\s|;)/.test(policy));

  // persistent.oaistatic.com stays BY NAME where it was only reachable by
  // scheme before, because the bundle hard-codes two default-avatar PNGs
  // there. Dropping it would be a visible regression with no security gain.
  assert.ok(policy.includes("img-src 'self' blob: data: https://persistent.oaistatic.com"));
});

test('a document with no policy at all is refused rather than served unprotected', () => {
  assert.throws(() => patchIndexHtml(shippedDocument({ csp: '' }), { bootConfig: CONFIG }), (err) => {
    assert.ok(err instanceof IndexHtmlError);
    assert.match(err.message, /carries no <meta http-equiv="Content-Security-Policy">/);
    return true;
  });
});

test('two policies are refused, because they intersect rather than replace', () => {
  const csp = `<meta http-equiv="Content-Security-Policy" content="${CSP}">\n    `
    + '<meta http-equiv="content-security-policy" content="default-src &#39;none&#39;;">';
  assert.throws(
    () => patchIndexHtml(shippedDocument({ csp }), { bootConfig: CONFIG }),
    /2 Content-Security-Policy metas/,
  );
});

test('a policy with no connect-src is refused, because default-src would govern our socket', () => {
  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; '
    + 'img-src &#39;self&#39; https:;">';
  assert.throws(
    () => patchIndexHtml(shippedDocument({ csp }), { bootConfig: CONFIG }),
    /no connect-src/,
  );
});

test('a connect-src that would narrow to nothing is refused, not emptied', () => {
  // An empty directive is not "no opinion", it is "refuse everything", and the
  // thing it would refuse first is this relay's own websocket. The visible
  // symptom is a phone that spins forever, which is the single hardest failure
  // in this project to diagnose from the device.
  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; '
    + 'connect-src https://ab.chatgpt.com;">';
  assert.throws(() => patchIndexHtml(shippedDocument({ csp }), { bootConfig: CONFIG }), (err) => {
    assert.ok(err instanceof IndexHtmlError);
    assert.match(err.message, /narrowing connect-src would leave it empty/);
    return true;
  });
});

test('a policy escaped some other way is refused rather than silently re-spelled', () => {
  // `&apos;` is valid HTML and means exactly what `&#39;` means, but this patch
  // re-encodes with `&#39;`, so accepting it would rewrite every directive in
  // the document including the seven it promises not to touch. Refusing is the
  // round-trip guard in rewriteCsp doing its job.
  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; '
    + 'connect-src &apos;self&apos; blob:;">';
  assert.throws(() => patchIndexHtml(shippedDocument({ csp }), { bootConfig: CONFIG }), (err) => {
    assert.ok(err instanceof IndexHtmlError);
    assert.match(err.message, /escaped in a way this patch does not reproduce byte for byte/);
    return true;
  });
});

test('an unescaped policy is narrowed and stays unescaped', () => {
  // Nothing requires the App to escape its quotes; a document that does not is
  // its own round trip, so it must go through rather than be refused.
  const csp = `<meta http-equiv="Content-Security-Policy" content="${SHIPPED_POLICY}">`;
  const patched = patchIndexHtml(shippedDocument({ csp }), { bootConfig: CONFIG });

  assert.equal(cspValueOf(patched), NARROWED_POLICY);
  assert.ok(!patched.includes('&#39;'), 'the patch introduced an escaping the document did not use');
});

test('the policy tag keeps its other attributes and its exact spacing', () => {
  const csp = `<meta  http-equiv="Content-Security-Policy"  content="${CSP}"  data-codex="keep" />`;
  const patched = patchIndexHtml(shippedDocument({ csp }), { bootConfig: CONFIG });

  assert.equal(
    cspTagOf(patched),
    `<meta  http-equiv="Content-Security-Policy"  content="${NARROWED_POLICY.replaceAll("'", '&#39;')}"  data-codex="keep" />`,
  );
});

test('narrowing is idempotent, so an already-narrow policy comes out unchanged', () => {
  // The whole-policy equality above would pass a patcher that simply wrote
  // CSP_NARROW out; this is the one that would not, because it hands the
  // patcher a different input and demands the same output.
  const csp = `<meta http-equiv="Content-Security-Policy" content="${NARROWED_POLICY.replaceAll("'", '&#39;')}">`;
  const patched = patchIndexHtml(shippedDocument({ csp }), { bootConfig: CONFIG });
  assert.equal(cspPolicyOf(patched), NARROWED_POLICY);
});

test('nothing we inject is an inline script, because script-src has no unsafe-inline', () => {
  const patched = patchIndexHtml(shippedDocument(), { bootConfig: CONFIG });

  const openTags = [...patched.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
  assert.equal(openTags.length, 2, 'the entry plus ours, and no third script');
  for (const tag of openTags) {
    assert.match(tag, /\ssrc=/, `an inline script would be refused by the CSP: ${tag}`);
  }
});

test('the boot meta content needs no HTML escaping', () => {
  const content = bootMetaContentOf(patchIndexHtml(shippedDocument(), { bootConfig: CONFIG }));

  // base64url is A-Za-z0-9-_ with no padding, so there is no character in it
  // that could terminate the attribute or open an entity. The config above
  // contains a double quote on purpose, to make this a real test.
  assert.match(content, /^[A-Za-z0-9_-]+$/);
  for (const hazard of ['"', "'", '<', '>', '&', '=']) {
    assert.ok(!content.includes(hazard), `${hazard} would have to be escaped`);
  }
});

test('the boot meta decodes back to the exact configuration', () => {
  const patched = patchIndexHtml(shippedDocument(), { bootConfig: CONFIG });
  assert.deepEqual(decodeBootConfig(bootMetaContentOf(patched)), CONFIG);
});

test('the viewport merge keeps every directive that was already there', () => {
  const html = shippedDocument({
    viewport: '<meta name="viewport" content="width=device-width, initial-scale=1.0,'
      + ' interactive-widget=resizes-content, user-scalable=no">',
  });
  const content = viewportContentOf(patchIndexHtml(html, { bootConfig: CONFIG }));

  assert.equal(
    content,
    'width=device-width, initial-scale=1.0, interactive-widget=resizes-content, user-scalable=no, viewport-fit=cover',
  );
  // `1.0` and not `1`: the value is appended to, never re-serialised, so no
  // directive is normalised on the way through.
  assert.ok(content.includes('initial-scale=1.0'));
});

test('the viewport tag keeps its other attributes and its quoting style', () => {
  const html = shippedDocument({
    viewport: "<meta id='vp' name='viewport' content='width=device-width' data-codex='keep'>",
  });
  const patched = patchIndexHtml(html, { bootConfig: CONFIG });
  assert.ok(patched.includes(
    "<meta id='vp' name='viewport' content='width=device-width, viewport-fit=cover' data-codex='keep'>",
  ));
});

test('a viewport that already says cover is left exactly as shipped', () => {
  const viewport = '<meta name="viewport" content="width=device-width, viewport-fit=cover">';
  const patched = patchIndexHtml(shippedDocument({ viewport }), { bootConfig: CONFIG });

  assert.ok(patched.includes(viewport), 'no second viewport-fit, and no rewrite of the tag');
  assert.equal([...patched.matchAll(/viewport-fit/g)].length, 1);
  // The other three edits still happen; only edit 3 is a no-op.
  assert.ok(patched.includes(BOOT_MODULE_SRC) && patched.includes(TOUCH_CSS_HREF));
});

test('a viewport that asks for a different viewport-fit is refused rather than overridden', () => {
  const html = shippedDocument({
    viewport: '<meta name="viewport" content="width=device-width, viewport-fit=contain">',
  });
  assert.throws(() => patchIndexHtml(html, { bootConfig: CONFIG }), (err) => {
    assert.ok(err instanceof IndexHtmlError);
    assert.match(err.message, /already asks for viewport-fit=contain/);
    return true;
  });
});

test('a document with no viewport meta is refused', () => {
  assert.throws(
    () => patchIndexHtml(shippedDocument({ viewport: '' }), { bootConfig: CONFIG }),
    /no <meta name="viewport">/,
  );
});

test('two viewport metas are refused, because which one wins is not ours to guess', () => {
  const html = shippedDocument({ viewport: `${VIEWPORT}\n    <meta name="viewport" content="width=400">` });
  assert.throws(() => patchIndexHtml(html, { bootConfig: CONFIG }), /2 viewport metas/);
});

test('an unquoted viewport content attribute is refused rather than silently skipped', () => {
  const html = shippedDocument({ viewport: '<meta name=viewport content=width=device-width>' });
  assert.throws(() => patchIndexHtml(html, { bootConfig: CONFIG }), /no quoted content attribute to extend/);
});

test('a document with no module entry is refused', () => {
  assert.throws(() => patchIndexHtml(shippedDocument({ entry: '' }), { bootConfig: CONFIG }), (err) => {
    assert.ok(err instanceof IndexHtmlError);
    assert.match(err.message, /no non-async module entry script/);
    return true;
  });
});

test('an async module is not an entry we can precede', () => {
  // Preceding an async module guarantees nothing: it executes when it finishes
  // loading, not where it sits. A document whose only module is async has no
  // position at which our middleware is guaranteed to run first, and saying so
  // is better than inserting a tag that works on a fast network.
  const html = shippedDocument({
    entry: '<script type="module" async crossorigin src="./assets/index-56e9f72c1d6a.js"></script>',
  });
  assert.throws(() => patchIndexHtml(html, { bootConfig: CONFIG }), /no non-async module entry script/);
});

test('a non-module script is not an entry either', () => {
  const html = shippedDocument({ entry: '<script src="./assets/legacy.js"></script>' });
  assert.throws(() => patchIndexHtml(html, { bootConfig: CONFIG }), /no non-async module entry script/);
});

test('two module entries are refused, because preceding one does not precede the other', () => {
  const html = shippedDocument({
    entry: `${ENTRY}\n    <script type="module" crossorigin src="./assets/second-0000.js"></script>`,
  });
  assert.throws(() => patchIndexHtml(html, { bootConfig: CONFIG }), (err) => {
    assert.ok(err instanceof IndexHtmlError);
    assert.match(err.message, /2 non-async module entry scripts/);
    assert.match(err.message, /index-56e9f72c1d6a\.js, \.\/assets\/second-0000\.js/);
    return true;
  });
});

test('an async module alongside the real entry is ignored, not counted', () => {
  const html = shippedDocument({
    entry: `${ENTRY}\n    <script type="module" async src="./assets/analytics-0000.js"></script>`,
  });
  const patched = patchIndexHtml(html, { bootConfig: CONFIG });
  assert.ok(patched.indexOf(BOOT_MODULE_SRC) < patched.indexOf('index-56e9f72c1d6a.js'));
});

test('a commented-out script is not mistaken for the entry', () => {
  const html = shippedDocument({
    entry: `<!-- <script type="module" src="./assets/old-entry.js"></script> -->\n    ${ENTRY}`,
  });
  const patched = patchIndexHtml(html, { bootConfig: CONFIG });

  // Our tag goes in front of the live entry, which means after the comment.
  assert.ok(patched.indexOf('old-entry.js') < patched.indexOf(BOOT_MODULE_SRC));
  assert.ok(patched.indexOf(BOOT_MODULE_SRC) < patched.indexOf('index-56e9f72c1d6a.js'));
});

test('an unterminated comment is refused rather than scanned past', () => {
  const html = shippedDocument({ entry: `<!-- oops\n    ${ENTRY}` });
  assert.throws(() => patchIndexHtml(html, { bootConfig: CONFIG }), /unterminated HTML comment/);
});

test('a document with no stylesheet of its own is refused', () => {
  assert.throws(
    () => patchIndexHtml(shippedDocument({ stylesheet: '' }), { bootConfig: CONFIG }),
    /links no stylesheet of its own/,
  );
});

test('modulepreload links are not mistaken for stylesheets', () => {
  const patched = patchIndexHtml(shippedDocument(), { bootConfig: CONFIG });
  // Ours lands after app-shared's stylesheet, which is the last link in the
  // head; had a modulepreload counted, it would have landed before it.
  assert.ok(patched.indexOf(TOUCH_CSS_HREF) > patched.indexOf('app-shared-6fb15e58cd7f.css'));
  assert.ok(patched.indexOf(TOUCH_CSS_HREF) > patched.indexOf('app-primary-547a6c7b4fb3.js'));
});

test('patching an already-patched document is refused', () => {
  const once = patchIndexHtml(shippedDocument(), { bootConfig: CONFIG });
  assert.throws(() => patchIndexHtml(once, { bootConfig: CONFIG }), (err) => {
    assert.ok(err instanceof IndexHtmlError);
    assert.match(err.message, /already been patched/);

    // The message must say what a second patch would actually cost, and what
    // it costs is NOT two copies of the middleware: both tags would name
    // /host-boot.mjs, and a module map evaluates one URL once however many
    // tags point at it. What does break is the config, because web/host-boot.mjs
    // reads the meta with querySelector and gets whichever copy is first.
    assert.match(err.message, /two boot configurations/);
    assert.ok(!/twice/.test(err.message), 'the double-install claim is not reachable; see boot.mjs');
    return true;
  });
});

test('each of the three markers on its own is enough to refuse the document', () => {
  const cases = [
    [`\n    <script type="module" src="${BOOT_MODULE_SRC}"></script>`, /script src="\/host-boot\.mjs"/],
    [`\n    <meta name="${BOOT_META_NAME}" content="e30">`, /meta name="codex-relay-boot"/],
    [`\n    <link rel="stylesheet" href="${TOUCH_CSS_HREF}">`, /link href="\/host-touch\.css"/],
  ];
  for (const [extraHead, named] of cases) {
    assert.throws(
      () => patchIndexHtml(shippedDocument({ extraHead }), { bootConfig: CONFIG }),
      (err) => {
        assert.match(err.message, /already been patched/);
        assert.match(err.message, named, 'the error names the marker it found');
        return true;
      },
    );
  }
});

test('the patch is a pure function of its inputs', () => {
  const html = shippedDocument();
  assert.equal(
    patchIndexHtml(html, { bootConfig: CONFIG }),
    patchIndexHtml(html, { bootConfig: CONFIG }),
  );
});

test('a bootConfig that is not a plain object is refused', () => {
  const html = shippedDocument();
  for (const [bootConfig, expected] of [
    [undefined, /not undefined/],
    [null, /not object/],
    ['{}', /not string/],
    [42, /not number/],
    [[1, 2], /not an array/],
  ]) {
    assert.throws(() => patchIndexHtml(html, { bootConfig }), (err) => {
      assert.ok(err instanceof IndexHtmlError);
      assert.match(err.message, /bootConfig must be a plain object/);
      assert.match(err.message, expected);
      return true;
    });
  }
  // The options object itself may be omitted, and fails the same way.
  assert.throws(() => patchIndexHtml(html), /bootConfig must be a plain object/);
});

test('a bootConfig that cannot be serialised is refused', () => {
  const html = shippedDocument();

  const circular = { wsPath: '/ws' };
  circular.self = circular;
  assert.throws(() => patchIndexHtml(html, { bootConfig: circular }), (err) => {
    assert.ok(err instanceof IndexHtmlError);
    assert.match(err.message, /cannot be serialised as JSON/);
    return true;
  });

  // JSON.stringify answers `undefined` here rather than throwing, which is the
  // case that would otherwise put the word "undefined" in the meta tag and
  // leave the middleware to find out by reading a property off a string.
  const vanishing = { toJSON() { return undefined; } };
  assert.throws(() => patchIndexHtml(html, { bootConfig: vanishing }), /serialised to nothing at all/);
});

test('a document handed in as something other than a string is a TypeError', () => {
  assert.throws(() => patchIndexHtml(Buffer.from('<html></html>'), { bootConfig: CONFIG }), TypeError);
  assert.throws(() => patchIndexHtml(null, { bootConfig: CONFIG }), TypeError);
});

test('decodeBootConfig refuses a non-string, so a null meta attribute does not become `null`', () => {
  assert.throws(() => decodeBootConfig(null), TypeError);
  assert.throws(() => decodeBootConfig(undefined), TypeError);
});

test('an empty configuration still round-trips', () => {
  const patched = patchIndexHtml(shippedDocument(), { bootConfig: {} });
  assert.deepEqual(decodeBootConfig(bootMetaContentOf(patched)), {});
});

test('the patched head keeps its indentation, because view-source is the first debugging tool', () => {
  const patched = patchIndexHtml(shippedDocument(), { bootConfig: CONFIG });
  for (const line of patched.split('\n')) {
    if (line.includes(BOOT_MODULE_SRC) || line.includes(TOUCH_CSS_HREF) || line.includes(BOOT_META_NAME)) {
      assert.match(line, /^ {4}</, `our tag landed at the wrong indent: ${JSON.stringify(line)}`);
    }
  }
});
