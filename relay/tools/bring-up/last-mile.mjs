// The last mile: enrol a passkey, sign in, push a turn, read the answer.
//
// tools/bring-up/local.sh proves every leg up to the browser and then stops,
// because the passkey ceremony "needs a human". That was true of a human's
// fingers, not of the ceremony: Chrome's WebAuthn virtual authenticator makes
// the credential, the CBOR, the ES256 signature and -- the part that matters --
// our verification of it all real. The only thing simulated is the thumb on the
// sensor. So the step that was documented as unautomatable is automated here,
// and the chain is proved end to end on every run instead of once by hand.
//
// What this does NOT prove: that a particular device has a working platform
// authenticator. That is the device's problem, not the relay's. (The Android
// emulator, for instance, cannot: Google Password Manager is its only
// credential provider and it needs a signed-in account.)
//
// Usage:
//   RELAY_LINK='http://localhost:8891/#enroll=<token>' node last-mile.mjs [--shot out.png]
//
// The link comes through the environment, never argv: it carries a bootstrap
// token and argv is world-readable in `ps`.

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { statSync } from 'node:fs';

const SHOT = argAfter('--shot');
const PROMPT = argAfter('--prompt') ?? 'Reply with exactly: relay is up.';
const KEEP = process.argv.includes('--keep-open');

function argAfter(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

const link = process.env.RELAY_LINK;
if (!link) die('RELAY_LINK is not set (it must carry the #enroll=<token> fragment)');
const origin = new URL(link).origin;

function die(message) {
  console.error(`last-mile: ${message}`);
  process.exit(1);
}

/** Redact the one thing in here that is a secret. */
const safe = (s) => String(s).replace(/#enroll=[A-Za-z0-9_-]+/g, '#enroll=<redacted>');

const CHROME_CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------- CDP client

/**
 * A CDP connection that knows about flat sessions.
 *
 * Page-level domains are addressed with a sessionId rather than on their own
 * socket, which is what lets one connection hold both Browser.* (for the guard
 * below) and WebAuthn.* (for the ceremony).
 */
function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let seq = 0;
  const ready = new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error(`cannot reach ${url}`)); });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const waiter = msg.id && pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(`${msg.method ?? ''} ${msg.error.message}`.trim()));
    else waiter.resolve(msg.result);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 30_000);
  });
  return { ready, send, close: () => ws.close() };
}

// ------------------------------------------------------------------ the run

const profile = await mkdtemp(join(tmpdir(), 'codex-relay-lastmile-'));
const port = await freePort();
const binary = CHROME_CANDIDATES.find((p) => {
  try { return statSync(p).isFile(); } catch { return false; }
});
if (!binary) die(`no Chrome found; set CHROME=<path>. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}`);

const chrome = spawn(binary, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  // Not cosmetic: Browser.getBrowserCommandLine refuses to answer without it.
  // That makes the guard below strictly stronger -- a browser someone is
  // actually using cannot satisfy it even by accident, it can only refuse.
  '--enable-automation',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-sync',
  // A phone-shaped viewport, because that is what this relay is for.
  '--window-size=412,915',
], { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.stderr.on('data', () => {});

let failure = null;
try {
  await main();
} catch (err) {
  failure = err;
} finally {
  if (!KEEP) await cleanup();
}

/**
 * Chrome is still writing to the profile when SIGTERM lands, so removing it
 * immediately loses a race and rmdir reports ENOTEMPTY. Worse, that throw
 * happens in a finally block, where it replaces whatever the run actually
 * failed on. So: wait for the process to be gone, then retry, then give up
 * quietly -- a leftover temp directory is not worth masking a real error.
 */
async function cleanup() {
  chrome.kill('SIGTERM');
  await Promise.race([
    new Promise((r) => chrome.once('exit', r)),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(profile, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
if (failure) {
  console.error(`\n  FAIL  ${safe(failure.message)}\n`);
  process.exit(1);
}

async function main() {
  const version = await waitForDevTools(port);

  const cdp = connect(version.webSocketDebuggerUrl);
  await cdp.ready;

  // The guard. Chrome exposes one DevTools port per instance and a port number
  // alone does not say whose instance answered -- a personal browser left with
  // --remote-debugging-port on is indistinguishable from ours until asked. So
  // before anything else: the browser on the other end must be running on the
  // throwaway profile we just made, or we hang up without touching it.
  const { arguments: argv } = await cdp.send('Browser.getBrowserCommandLine');
  if (!argv.some((a) => a === `--user-data-dir=${profile}`)) {
    cdp.close();
    throw new Error('that DevTools port belongs to a browser we did not start; refusing to drive it');
  }
  step('own browser confirmed', `headless Chrome on a throwaway profile, port ${port}`);

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => cdp.send(method, params, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');

  // The authenticator. `internal` because the page asks for a platform
  // authenticator; resident keys because the relay signs in with a
  // discoverable credential and never sends an allowList; isUserVerified
  // because the relay requires UV and refusing it here would be testing the
  // wrong thing.
  await call('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await call('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  step('virtual authenticator attached', 'ctap2_1, internal transport, resident keys, UV on');

  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result.value;
  };

  /** Poll an expression until it is truthy. Returns the value. */
  const until = async (what, expression, ms = 25_000) => {
    const deadline = Date.now() + ms;
    let last;
    for (;;) {
      last = await evaluate(expression);
      if (last) return last;
      if (Date.now() > deadline) {
        const note = await evaluate(`JSON.stringify({
          // Three states, not two. \`?.hidden\` on a missing element is
          // undefined, so the old two-way read called a document with no
          // \`#chat\` in it "chat" -- which is precisely the document you are
          // looking at when the renderer mount took the browser away, and so
          // the one case where this diagnostic most needs to be right.
          screen: document.getElementById('chat') == null
            ? (document.getElementById('login') == null ? 'neither (navigated away?)' : 'login')
            : (document.getElementById('chat').hidden ? 'login' : 'chat'),
          path: location.pathname,
          phase: document.getElementById('connection')?.dataset.phase ?? null,
          pill: document.getElementById('connection')?.textContent ?? null,
          turn: document.getElementById('turnState')?.textContent ?? null,
          errors: document.getElementById('errors')?.innerText || null,
          note: document.getElementById('loginNote')?.textContent || null,
        })`);
        throw new Error(`timed out waiting for ${what}. The page says: ${note}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  await call('Page.navigate', { url: link });
  await until('the login screen', `(() => {
    const el = document.getElementById('login');
    return !!el && !el.hidden;
  })()`);
  step('page loaded', `${origin} — token taken from the fragment and scrubbed`);

  // Still an assertion, just not a same-tick one: the login screen can paint
  // before the fragment is cleared, and what matters is that the token does not
  // survive in the address bar, not which tick it leaves on.
  await until('the token to leave the address bar', `location.hash === ''`, 5_000);

  await evaluate(`document.getElementById('enrollButton').click()`);
  // The relay serves two faces and a successful enrolment lands on a different
  // one in each. With no archive mounted it reveals the relay's own chat
  // screen; with one, `navigateToApp()` hands the browser straight to the
  // shipped renderer at the mount prefix and `#chat` never exists in that
  // document at all (web/app.mjs:890). So wait for either, and say which.
  //
  // Waiting only for `#chat` is what this did until the mount was wired into
  // local.sh, and it reported "timed out ... the page says screen: chat" --
  // the note's own `?.hidden` reads undefined on a missing element and calls
  // that `chat`, so the failure described a success. Both are fixed here.
  const landed = await until('enrolment to finish', `(() => {
    const el = document.getElementById('chat');
    if (el && !el.hidden) return 'relay-ui';
    if (!el && !document.getElementById('login')) return 'app';
    return null;
  })()`);

  if (landed === 'app') {
    // Assert the handover rather than assume it: a navigation that lands on an
    // error page also removes `#login`.
    const where = await evaluate('location.pathname');
    if (!where.startsWith('/app/')) throw new Error(`enrolment navigated to ${where}, not the app mount`);
    step('passkey enrolled', 'real credential, real signature, verified by the relay');
    step('handed over', `the shipped renderer at ${where} — the session cookie carried it`);

    // Back to the relay's own page to finish the proof. The session cookie now
    // exists, and boot()'s passive probe deliberately does not bounce a browser
    // that arrives at the root (web/app.mjs:878), so this is the one route that
    // reaches the composer with an archive mounted. Driving the shipped
    // renderer's own composer instead is drive-real.mjs's job, not this file's.
    await call('Page.navigate', { url: origin });
    await until('the relay page to recognise the session', `(() => {
      const el = document.getElementById('chat');
      return !!el && !el.hidden;
    })()`);
  } else {
    step('passkey enrolled', 'real credential, real signature, verified by the relay');
  }

  await until('the socket to come up', `document.getElementById('connection')?.dataset.phase === 'live'`);
  step('upgraded', 'session cookie accepted, websocket connected');

  // Send a turn the way a person does: type into the textarea and submit the
  // form, so the page's own handler runs rather than a function we picked.
  await evaluate(`(() => {
    const input = document.getElementById('input');
    input.value = ${JSON.stringify(PROMPT)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('composer').requestSubmit();
    return true;
  })()`);
  step('turn sent', JSON.stringify(PROMPT));

  await until('the turn to start', `document.getElementById('turnState')?.textContent !== 'idle'`, 15_000);
  // The pill settles on "turn completed", not back on "idle" -- it reports the
  // last turn rather than the absence of one.
  const answer = await until(
    'an answer',
    `(() => {
      const t = document.getElementById('transcript');
      const done = /idle|completed/.test(document.getElementById('turnState')?.textContent ?? '');
      const text = t ? t.innerText.trim() : '';
      return done && text ? text : null;
    })()`,
    Number(process.env.LAST_MILE_TURN_MS ?? 180_000),
  );
  const thread = await evaluate(`document.getElementById('threadId')?.textContent ?? ''`);
  step('turn completed', thread ? `thread ${thread}` : 'turn/completed received');

  if (SHOT) {
    const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(SHOT, Buffer.from(data, 'base64'));
    step('screenshot', SHOT);
  }

  const creds = await call('WebAuthn.getCredentials', { authenticatorId });
  console.log(`\n  transcript\n${answer.split('\n').map((l) => `    ${l}`).join('\n')}\n`);
  console.log(`  credential  rp=${creds.credentials[0]?.rpId} resident=${creds.credentials[0]?.isResidentCredential} signCount=${creds.credentials[0]?.signCount}`);
  console.log('\n  OK  browser to Claude and back\n');
  cdp.close();
}

async function waitForDevTools(port) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('Chrome never opened its DevTools port');
    await new Promise((r) => setTimeout(r, 150));
  }
}

function step(label, detail) {
  console.log(`  ok  ${label.padEnd(26)} ${safe(detail ?? '')}`);
}
