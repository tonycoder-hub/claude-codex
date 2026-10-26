// Drive the REAL chain end to end, unattended: passkey, real renderer, real turn.
//
// drive-mobile.mjs drives probe-server.mjs, which has no authentication. The
// real surface has, and that is the point of it -- so until now the end-to-end
// test needed a human to approve a passkey prompt, which meant it was never run
// twice the same way and never run at all from a script.
//
// CDP's WebAuthn domain closes that gap honestly. `addVirtualAuthenticator`
// installs a software authenticator into the browser's own credential stack, so
// `navigator.credentials.create()` and `.get()` take their normal code paths and
// the relay's verifier (src/auth/ceremony.mjs) does its normal attestation and
// assertion checks against real CBOR and a real COSE key. Nothing in the server
// is stubbed or bypassed. What is simulated is exactly one thing: the user
// gesture that would otherwise be a fingerprint.
//
// ORIGIN, NOT HOST. The surface pins its relying party from CODEX_RELAY_RP_ORIGIN
// at first run and never again, and real-chain.sh sets it to
// http://localhost:PORT. WebAuthn compares the origin string, so this driver
// must say `localhost`; 127.0.0.1 is an equally secure context and still fails
// the comparison, with an error that reads like a key problem rather than a
// hostname problem. That cost an hour once.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return '';
  }
};

/**
 * Where local.sh leaves the three files that say which chain is live.
 *
 * Overridable so the refusal paths below can be exercised without a test
 * writing over the handoff of a chain somebody is using. local.sh honours the
 * same variable.
 */
const HANDOFF = process.env.DRIVE_HANDOFF_DIR || '/tmp';

const PORT = process.env.DRIVE_PORT || read(`${HANDOFF}/real-chain-port`);
const SCRATCH = process.env.DRIVE_SCRATCH || read(`${HANDOFF}/real-chain-scratch`);
if (!PORT) throw new Error('no surface port; set DRIVE_PORT to the one local.sh printed');

const ORIGIN = `http://localhost:${PORT}`;

// A handoff file is not evidence that the chain it names is alive. These three
// sat in /tmp naming a surface that had been dead for an hour, and the run
// against them reported `enrol-link ok` -- a green step, read out of a dead
// chain's log -- before every later step failed on a refused connection. The
// first green was the damaging one: it said the link was found, and it was,
// in a file nothing had written to since the chain exited.
//
// So the handoff is checked before anything is driven, and the two ways it can
// be stale are reported separately, because they have different fixes. Only
// when the value came from the file: an explicit DRIVE_PORT is the caller
// saying they know what they are pointing at.
if (!process.env.DRIVE_PORT) {
  const recordedPid = Number(read(`${HANDOFF}/real-chain-pid`));
  const alive = (() => {
    if (!recordedPid) return null; // written by an older local.sh, or not at all
    try { process.kill(recordedPid, 0); return true; } catch { return false; }
  })();
  if (alive === false) {
    throw new Error(
      `${HANDOFF}/real-chain-* names surface pid ${recordedPid}, which is not running. `
      + 'That handoff is from a chain that has exited; start one with '
      + 'tools/bring-up/local.sh --real --keep, or set DRIVE_PORT/DRIVE_SCRATCH by hand.',
    );
  }
  const answering = await fetch(`${ORIGIN}/`, { redirect: 'manual' }).then(() => true, () => false);
  if (!answering) {
    throw new Error(
      `nothing is listening on ${ORIGIN}, which is the port ${HANDOFF}/real-chain-port names. `
      + 'Driving on would report the enrolment link it finds in a stale log as found.',
    );
  }
}

// "Is the chain I am about to drive the one I think it is?" on its own, without
// a browser, a passkey or a turn. Operationally it is the cheap thing to run
// before a long drive; for the suite it is what keeps the test of the skip path
// from launching Chrome at a dead port and waiting out the timeout.
if (process.env.DRIVE_PREFLIGHT_ONLY === '1') {
  console.log(JSON.stringify({ preflight: 'ok', origin: ORIGIN, scratch: SCRATCH || null }));
  process.exit(0);
}

const OUT = process.argv[2] || '/private/tmp/ji-probe/real';
const WAIT_MS = Number(process.env.DRIVE_WAIT || 30000);
const TURN = process.env.DRIVE_TURN || '';
// A turn cannot start without a project, so driving a turn implies picking one.
// Opt-in only. A turn used to imply a pick, on the assumption that a thread
// needs a project -- it does not. The renderer's own projectless path
// (`projectless-thread-cwd`, consulted when the thread's roots are empty or
// `~`) is the route a browser can actually take, because every entry the
// picker offers here opens a NATIVE directory dialog. Measured on real10:
// picking one left a modal over the composer and the turn sent nothing.
const PICK = process.env.DRIVE_PICK === '1';
const TURN_WAIT_MS = Number(process.env.DRIVE_TURN_WAIT || 120000);
/** Where the real renderer is mounted. `/app` without the slash 308s to this. */
const APP_PATH = process.env.DRIVE_APP_PATH || '/app/';

// The enrolment link is announced on stderr as `${origin}/#enroll=${token}`,
// once, at startup. It is single-use and expires in ten minutes, so this reads
// the log rather than caching anything.
//
// The LAST one in the log, not the first: `kill -USR1` on the surface appends
// a fresh link, and the one at the top is by then the one some earlier run
// already spent. Taking the first was survivable only for as long as nothing
// else had enrolled before this -- which stopped being true the moment
// `local.sh --last-mile` brought the chain up, because its own ceremony burns
// the startup link before this driver ever opens a browser. `local.sh` has
// always read the same log with `tail -1`; this is the same rule.
function enrolUrl() {
  if (process.env.DRIVE_ENROL_URL) return process.env.DRIVE_ENROL_URL;
  const log = read(`${SCRATCH}/surface.log`);
  const all = [...log.matchAll(/#enroll=([A-Za-z0-9._~+/=-]+)/g)];
  if (all.length === 0) return null;
  return `${ORIGIN}/#enroll=${all[all.length - 1][1]}`;
}

const DEVICE = {
  width: Number(process.env.DRIVE_W || 390),
  height: Number(process.env.DRIVE_H || 844),
  deviceScaleFactor: Number(process.env.DRIVE_DPR || 3),
  mobile: true,
};
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const DEBUG_PORT = await new Promise((res, rej) => {
  const s = net.createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => res(port));
  });
});
fs.mkdirSync(OUT, { recursive: true });

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = fs.mkdtempSync(os.tmpdir() + '/ji-real-chrome-');
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + profile, '--remote-debugging-port=' + DEBUG_PORT,
  '--enable-automation', '--hide-scrollbars',
  '--window-size=' + DEVICE.width + ',' + DEVICE.height,
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => (chromeErr += d));

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      return (await r.json()).webSocketDebuggerUrl;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error('chrome devtools never came up: ' + chromeErr.slice(0, 500));
}

const ws = new WebSocket(await wsUrl());
let id = 0;
const pending = new Map();
const collected = {
  console: [],
  exceptions: [],
  failedRequests: [],
  logEntries: [],
  ws: [],
  // Every off-origin URL the real renderer ATTEMPTS, blocked or not. The
  // shipped index.html carries a `<meta>` CSP that permits a dozen third
  // parties -- ab.chatgpt.com, api.mapbox.com, cdn.plaid.com, wss://chatgpt.com
  // among them -- and this relay's standing rule is that private content does
  // not leave this machine. An attempt that the CSP or the network kills is
  // still the fact that decides whether the served CSP needs tightening, so it
  // is recorded here rather than inferred from the absence of a failure.
  offOrigin: [],
};
let sessionId = null;

// Opt-in frame capture, off unless DRIVE_CAST=1. The fifteen checks below
// are the thing this file exists for and they are already proven green; a
// recording must not be able to change their outcome. So the capture is a
// separate `case` in the dispatch below plus two calls, and with the flag
// unset not one byte of the existing path runs differently.
const CAST = process.env.DRIVE_CAST === '1';
const castDir = `${OUT}/cast`;
let castFrames = 0;
let castLog = null;
if (CAST) {
  fs.rmSync(castDir, { recursive: true, force: true });
  fs.mkdirSync(castDir, { recursive: true });
  castLog = fs.openSync(`${castDir}/frames.jsonl`, 'w');
}

function send(method, params = {}, sess = sessionId) {
  const mid = ++id;
  const msg = { id: mid, method, params };
  if (sess) msg.sessionId = sess;
  ws.send(JSON.stringify(msg));
  return new Promise((res, rej) => pending.set(mid, { res, rej }));
}

await new Promise((r) => ws.addEventListener('open', r));

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    return m.error ? rej(new Error(m.method + ': ' + JSON.stringify(m.error))) : res(m.result);
  }
  const p = m.params || {};
  switch (m.method) {
    case 'Page.screencastFrame': {
      // Ack first and unconditionally. Chrome sends at most one unacked
      // frame, so a throw between here and the ack does not drop a frame --
      // it ends the recording silently and leaves the run looking fine.
      send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
      if (!CAST || castLog === null) break;
      const n = castFrames++;
      const name = `frame-${String(n).padStart(6, '0')}.jpg`;
      try {
        fs.writeFileSync(`${castDir}/${name}`, Buffer.from(p.data, 'base64'));
        // `metadata.timestamp` is the page's own capture time in seconds and
        // is what the frames must be spaced by; a local clock here would
        // record when this process got round to the socket instead.
        fs.writeSync(castLog, JSON.stringify({
          n, name, t: p.metadata?.timestamp ?? null,
          w: p.metadata?.deviceWidth ?? null, h: p.metadata?.deviceHeight ?? null,
        }) + '\n');
      } catch (err) {
        collected.console.push({ type: 'cast-error', text: String(err && err.message) });
      }
      break;
    }
    case 'Runtime.consoleAPICalled':
      collected.console.push({
        type: p.type,
        text: (p.args || [])
          .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '<' + a.type + '>')
          .join(' ')
          .slice(0, 1500),
      });
      break;
    case 'Runtime.exceptionThrown': {
      const d = p.exceptionDetails || {};
      collected.exceptions.push({
        text: d.text,
        desc: (d.exception && (d.exception.description || d.exception.value)) || null,
        url: d.url,
        line: d.lineNumber,
      });
      break;
    }
    case 'Network.requestWillBeSent': {
      // `data:`, `blob:` and `about:` never leave the process, and our own
      // origin is the relay itself. Everything else is egress.
      const u = (p.request && p.request.url) || '';
      if (u && !u.startsWith(ORIGIN) && !/^(data|blob|about|chrome|devtools):/.test(u)) {
        collected.offOrigin.push({ url: u.slice(0, 300), type: p.type, initiator: p.initiator?.type });
      }
      break;
    }
    case 'Network.loadingFailed':
      collected.failedRequests.push({ url: (p.request && p.request.url) || p.requestId, err: p.errorText });
      break;
    case 'Network.responseReceived':
      if (p.response && p.response.status >= 400) {
        collected.failedRequests.push({ url: p.response.url, err: 'HTTP ' + p.response.status });
      }
      break;
    case 'Log.entryAdded':
      collected.logEntries.push({
        level: p.entry.level,
        src: p.entry.source,
        text: String(p.entry.text).slice(0, 700),
      });
      break;
    // The frames ARE the relay. A boot that paints and carries no frames is the
    // failure this driver exists to tell apart from success.
    case 'Network.webSocketCreated':
      collected.ws.push({ ev: 'created', url: p.url });
      break;
    case 'Network.webSocketClosed':
      collected.ws.push({ ev: 'closed' });
      break;
    case 'Network.webSocketFrameError':
      collected.ws.push({ ev: 'error', err: p.errorMessage });
      break;
    case 'Network.webSocketFrameSent':
      collected.ws.push({ ev: 'sent', len: (p.response?.payloadData || '').length, head: (p.response?.payloadData || '').slice(0, 260) });
      break;
    case 'Network.webSocketFrameReceived':
      collected.ws.push({ ev: 'recv', len: (p.response?.payloadData || '').length, head: (p.response?.payloadData || '').slice(0, 260) });
      break;
  }
});

// A DevTools port number does not say whose browser answered. A fixed port once
// sent a probe into a desktop Chrome full of somebody's real tabs, and with a
// virtual authenticator in play the stakes are higher than a stray screenshot:
// refusing is the only safe answer.
const { arguments: argv } = await send('Browser.getBrowserCommandLine', {}, null);
if (!argv.some((a) => a === '--user-data-dir=' + profile)) {
  ws.close();
  chrome.kill('SIGKILL');
  throw new Error('that DevTools port belongs to a browser we did not start; refusing to drive it');
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, null);
({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, null));
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
await send('Page.enable');

await send('Emulation.setDeviceMetricsOverride', DEVICE);
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
await send('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA, platform: 'iPhone' });

// `internal` + resident keys is the platform-authenticator shape the relay asks
// for, and the one a phone would actually present. `isUserVerified` and
// `automaticPresenceSimulation` stand in for the biometric; everything else --
// attestation object, COSE key, signature counter, assertion signature -- is
// produced for real and verified for real at the other end.
if (CAST) {
  // After the device metrics override, so every frame is already at the
  // phone's dimensions rather than being letterboxed later.
  await send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 });
}

await send('WebAuthn.enable', { enableUI: false });
const { authenticatorId } = await send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    return { __err: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '') };
  }
  return r.result.value;
};

const shot = async (name) => {
  try {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
    return `${OUT}/${name}.png`;
  } catch (err) {
    return `<screenshot failed: ${err.message}>`;
  }
};

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// The page's rendered text, with its length kept alongside it.
//
// `innerText` deliberately, not `textContent`: only the first is what a person
// can read. Measured on the home screen at 390x844, the two disagree by a lot
// -- 249 characters rendered against 768 in the markup -- because the second
// counts text in collapsed menus and offscreen panels that nobody is looking
// at. Anything that asks "is there a page here" has to ask the smaller number.
//
// The length is carried because two assertions downstream are phrase-ABSENCE
// tests: `no-snag` passes when "hit a snag" is missing and `project-chosen`
// passes when "choose project" is missing, and both of those are also true of
// a page with no text at all. On an empty string they pass without looking at
// anything, which is how a renderer stuck on its onboarding screen -- 784
// nodes of chrome, no text, no failed request -- went on being reported green.
// So each of them now requires a non-empty reading before an absence counts as
// evidence. A `textContent` fallback would have defeated exactly that, since
// the onboarding screen's markup is not empty even when its screen is.
const PAGE_TEXT = `(() => {
  const text = document.body.innerText || '';
  return { text, len: text.length };
})()`;

// ---------------------------------------------------------------- enrol

const report = { origin: ORIGIN, appPath: APP_PATH, device: DEVICE, steps: [] };
const step = (name, detail) => {
  report.steps.push({ name, ...detail });
  const ok = detail.ok === undefined ? '' : detail.ok ? 'ok   ' : 'FAIL ';
  console.log(`${ok}${name}  ${JSON.stringify(detail).slice(0, 300)}`);
};

const url = enrolUrl();
step('enrol-link', { ok: !!url, found: !!url, from: url ? `${SCRATCH}/surface.log` : null });

if (url) {
  await send('Page.navigate', { url });
  await settle(2500);
  // Click the real button rather than calling enroll() directly: the point is
  // to exercise the page the user actually gets, including its hash handling.
  // Before the click, because a successful enrolment is a navigation: with an
  // archive mounted, web/app.mjs:890 hands the browser to the mount prefix the
  // moment the ceremony returns. Taken afterwards -- which is where it was --
  // this captured `/app/`, so `01-enrol.png` and `02-app.png` came out
  // byte-identical and the relay's own page was never photographed at all.
  //
  // That identity was the truth and not a broken helper, which is the part
  // worth writing down: two identical screenshots looked like a capture bug
  // for long enough to be worth a comment saying it was not one.
  report.enrolShot = await shot('01-enrol');

  const clicked = await ev(`(() => {
    const b = document.querySelector('#enrollButton');
    if (!b) return {clicked:false, why:'no #enrollButton'};
    b.click();
    return {clicked:true};
  })()`);
  step('enrol-click', { ok: clicked?.clicked === true, ...clicked });
  await settle(5000);
}

const status = await ev(`fetch('/auth/status').then(r => r.json()).catch(e => ({__fetchErr: String(e)}))`);
step('auth-status', { ok: status?.enrolled === true, status });

// `enrolled` is a fact about the relay, not about this browser, and the two
// come apart in exactly one way that costs an hour: an enrolment link is single
// use, so a second run against a surviving chain reads the spent link out of
// the same log, gets 403 from begin, and arrives at `/app/` with no session.
// That failure then presents as a renderer that will not boot -- a 401 body has
// a DOM too. Ask for the thing that actually has to work.
const appStatus = await ev(
  `fetch('${APP_PATH}', {redirect: 'follow'}).then(r => r.status).catch(e => String(e))`,
);
step('app-session', {
  ok: appStatus === 200,
  status: appStatus,
  why: appStatus === 401 ? 'no session for this browser -- the enrolment link was probably already spent' : undefined,
});

// ---------------------------------------------------------------- the real app

// A tap on both halves of the host conversation, installed before the document
// exists so it is registered ahead of the renderer's own listeners.
//
// The two paths are not symmetric and neither is visible from outside the page:
// outbound is a `codex-message-from-view` CustomEvent (the bridge call is the
// other path and the host deliberately ignores it, or everything would arrive
// twice), inbound is a MessageEvent dispatched on the window. A WS frame log
// shows the app-server conversation and says nothing about this one, so a
// renderer that stalls on an unanswered host type looks identical to one that
// stalls on anything else. Record the types, not the payloads: the payloads
// carry thread content.
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const tap = { out: [], in: [], outTally: {}, inTally: {} };
    Object.defineProperty(window, '__relayTap', { value: tap, enumerable: false });
    const bump = (t, k) => { t[k] = (t[k] || 0) + 1; };
    // An endpoint path and a method name say which conversation a frame belongs
    // to; a body says what the user is working on. Only the former is recorded,
    // and a URL is reduced to its path so a query string cannot smuggle one in.
    const where = (d) => {
      try {
        if (typeof d.url === 'string') return new URL(d.url, location.origin).pathname;
      } catch { /* a URL that will not parse is not a path worth guessing at */ }
      return undefined;
    };
    tap.pending = {};
    addEventListener('codex-message-from-view', (e) => {
      const d = e.detail || {};
      if (typeof d.type !== 'string') return;
      bump(tap.outTally, d.type);
      const note = {
        type: d.type, keys: Object.keys(d).sort(), path: where(d),
        method: typeof d.method === 'string' ? d.method
          : typeof d.request?.method === 'string' ? d.request.method : undefined,
        key: typeof d.key === 'string' ? d.key : undefined,
        // The startup gate's one observable side effect. Its effect is
        // [k]-dependent and returns early on a falsy k, so every frame of this
        // type is the gate telling us what it resolved to: 'app' means the gate
        // opened and the blank page is BELOW it, 'onboarding' means it did not.
        // Cheaper than any amount of reading, and it is already on the wire.
        mode: typeof d.mode === 'string' ? d.mode : undefined,
        // The renderer's own boot narration, 90-odd lines of it, which the host
        // drops as telemetry and nobody has read yet. Taking it is safe because
        // the bundle has already done the classification for us: every call
        // site splits its context into safe and sensitive halves, so the safe
        // half is copied and the sensitive half is never touched. The message
        // itself is a developer string literal, not user content.
        // (No backticks below this line -- this whole block is inside one.)
        level: d.type === 'log-message' && typeof d.level === 'string' ? d.level : undefined,
        log: d.type === 'log-message' && typeof d.message === 'string'
          ? d.message.slice(0, 300) : undefined,
        safe: d.type === 'log-message' && d.tags && typeof d.tags.safe === 'object'
          ? JSON.stringify(d.tags.safe).slice(0, 300) : undefined,
      };
      if (d.requestId != null) tap.pending[String(d.requestId)] = note;
      if (tap.out.length < 400) tap.out.push(note);
    }, true);
    addEventListener('message', (e) => {
      const d = e.data;
      if (!d || typeof d !== 'object' || typeof d.type !== 'string') return;
      bump(tap.inTally, d.type);
      if (d.requestId != null) delete tap.pending[String(d.requestId)];
      if (tap.in.length < 400) tap.in.push({ type: d.type, keys: Object.keys(d).sort() });
    }, true);
  })()`,
});

await send('Page.navigate', { url: ORIGIN + APP_PATH });
await settle(WAIT_MS);

// Unanswered outbound types are the interesting ones, and "unanswered" is only
// legible against what came back, so both tallies are kept side by side.
const tap = await ev(`(() => {
  const t = window.__relayTap;
  if (!t) return { installed: false };
  return { installed: true, outTally: t.outTally, inTally: t.inTally,
           outTypes: Object.keys(t.outTally).length, inTypes: Object.keys(t.inTally).length,
           // What the host was asked for and never answered. Two of the four
           // blocking outbound types have no timeout at all, so one entry here
           // is a permanently stalled corner of the UI with a clean console.
           unanswered: Object.values(t.pending),
           fetchPaths: t.out.filter(o => o.type === 'fetch').map(o => o.path),
           mcpMethods: t.out.filter(o => o.type === 'mcp-request').map(o => o.method),
           sharedKeys: t.out.filter(o => o.type === 'shared-object-subscribe').map(o => o.key),
           out: t.out.slice(0, 200), in: t.in.slice(0, 200) };
})()`);
report.tap = tap;

const boot = await ev(`(() => {
  const de = document.documentElement;
  const root = document.querySelector('#root') || document.body.firstElementChild;
  const send_ = [...document.querySelectorAll('button,[role="button"]')]
    .map(b => ({label: b.getAttribute('aria-label') || (b.textContent||'').trim().slice(0,24),
                disabled: b.disabled === true || b.getAttribute('aria-disabled') === 'true'}))
    .filter(b => /send/i.test(b.label));
  const pageText_ = ${PAGE_TEXT};
  return {
    href: location.href,
    title: document.title,
    domNodeCount: document.getElementsByTagName('*').length,
    rootChildren: root ? root.children.length : 0,
    styleSheets: document.styleSheets.length,
    // The startup logo with nothing behind it is what an unanswered handshake
    // looks like, so it is measured rather than eyeballed.
    stillStartupLoader: !!document.querySelector('[class*="startup"],[class*="splash"]'),
    dataset: {...de.dataset},
    innerWidth: innerWidth, innerHeight: innerHeight, dpr: devicePixelRatio,
    coarsePointer: matchMedia('(pointer: coarse)').matches,
    bootMetaPresent: !!document.querySelector('meta[name="codex-relay-boot"]'),
    touchCssPresent: [...document.styleSheets].some(s => (s.href||'').includes('host-touch')),
    hostBootPresent: [...document.scripts].some(s => (s.src||'').includes('host-boot')),
    safeHeaderLeft: getComputedStyle(de).getPropertyValue('--spacing-token-safe-header-left').trim(),
    sidebarWidth: (() => { const n = document.querySelector('.sidebar-navigation');
      return n ? Math.round(n.getBoundingClientRect().width) : null; })(),
    composer: (() => { const c = document.querySelector('[contenteditable="true"]');
      if (!c) return null; const r = c.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })(),
    sendButtons: send_,
    bodyText: pageText_.text.slice(0, 600),
    bodyTextLen: pageText_.len,
    // A mounted-but-empty tree and a tree that never mounted both read as
    // domNodeCount in the dozens, and only the markup tells them apart. The
    // renderer uses a hash router whose initial navigate target is
    // \`Pj ?? location.pathname\`, so the hash and search are what decide which
    // route it lands on -- worth recording next to what actually rendered.
    rootHtml: root ? root.innerHTML.slice(0, ${process.env.DRIVE_DEEP ? 60000 : 1500}) : null,
    locationParts: {pathname: location.pathname, search: location.search, hash: location.hash},
    initialRouteMeta: document.querySelector('meta[name="initial-route"]')?.content ?? null,
  };
})()`);
// A node count and a spinner check are not enough, measured: a renderer with
// no workspace root to open renders its onboarding screen, which is 784 nodes
// of chrome -- comfortably over this threshold -- with no startup loader, no
// console error and no failed request. It is also completely blank, and this
// line called it a boot.
//
// So ask for text and for a composer. Those are the two things the onboarding
// screen does not have and every screen worth driving does, and `Send` is the
// control the rest of this driver goes on to click.
const booted = (boot?.bodyTextLen ?? 0) > 0 && (boot?.sendButtons?.length ?? 0) > 0;
step('app-boot', {
  ok: boot?.domNodeCount > 400 && !boot?.stillStartupLoader && booted,
  domNodeCount: boot?.domNodeCount,
  bodyTextLen: boot?.bodyTextLen,
  stillStartupLoader: boot?.stillStartupLoader,
  hostBootPresent: boot?.hostBootPresent,
  safeHeaderLeft: boot?.safeHeaderLeft,
  sidebarWidth: boot?.sidebarWidth,
  sendButtons: boot?.sendButtons,
  why: booted ? undefined
    : 'rendered chrome but no text and no composer -- the onboarding screen looks like this, '
      + 'and a surface with no CODEX_RELAY_WORKSPACE_ROOTS is how you get there',
});
report.boot = boot;

// ------------------------------------------------------- what a phone suffers
//
// The mobile layer's own suite asserts what it WRITES: a 44px custom property,
// an 8px outset, dvh units, insets divided by the window zoom. None of that is
// evidence about the page, because the renderer's layout is the other half of
// every one of those numbers -- it can paint a 28px button inside a 44px
// target, and it can put a control under the home indicator whatever the inset
// says. So this measures the rendered result at 390x844 instead.
//
// Three things are measured and a fourth deliberately is not. Horizontal
// overflow, because the overflowing part is off-screen and invisible on a
// screenshot. Tap reachability, by hit-testing the painted edges rather than
// by reading a width. Input font size, because anything under 16px makes iOS
// zoom the whole page on focus and there is no way back out. What is NOT
// measured is the soft keyboard: Chrome's emulation has no `interactive-widget`
// behaviour to exercise, so a pass here says nothing about it, and claiming
// otherwise would be the kind of result that is worse than no result.
const fit = await ev(`(() => {
  const de = document.documentElement;
  const cs = getComputedStyle(de);
  const vw = innerWidth;
  const prop = (n) => cs.getPropertyValue(n).trim() || null;

  // Horizontal overflow, attributed. The widest offender is what to fix, so
  // the list is sorted by how far past the viewport it reaches.
  const over = [];
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right <= vw + 1 && r.left >= -1) continue;
    const s = getComputedStyle(el);
    if (s.position === 'fixed' && r.width <= 1) continue;
    over.push({
      tag: el.tagName.toLowerCase(),
      cls: (el.className && String(el.className).slice(0, 48)) || null,
      left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width),
      past: Math.round(Math.max(r.right - vw, -r.left)),
      overflowX: s.overflowX,
    });
  }
  over.sort((a, b) => b.past - a.past);

  // Tap reachability, classified rather than counted.
  //
  // web/host-touch.css:323-332 puts an 8px \`::after\` outset on every button,
  // [role=button], [role=tab], [role=menuitem], [role=switch] and icon anchor,
  // which lifts a measured 28px control to 28+8+8 = 44. What it does NOT claim
  // is that all four of those edges survive: :317-321 records the trade-off
  // out loud -- in a dense toolbar the expanded areas overlap and the later
  // sibling wins -- so a toolbar button losing two sides to its neighbours is
  // the design working, not failing.
  //
  // The failure mode worth detecting is the other one, and it is a real bug
  // this repo already had: the bundle's own \`._Button:after\` carries
  // \`pointer-events: none\`, and until :331 declared \`pointer-events: auto\`
  // every Button had a hit area that was bigger and ignored taps. That shows
  // up as a side where the tap lands on the BACKGROUND -- not on a sibling
  // control, not off-viewport. So each side is labelled and only \`dead\`
  // counts against the stylesheet.
  const target = parseFloat(prop('--codex-touch-target') || '44') || 44;
  const outset = parseFloat(prop('--codex-touch-outset') || '8') || 8;
  const SELECTOR = 'button,[role="button"],[role="tab"],[role="menuitem"],[role="switch"],a[href][aria-label]';
  const controls = [...document.querySelectorAll(SELECTOR + ',a[href],input,select,textarea')];
  const isControl = (n) => !!(n && n.closest && n.closest(SELECTOR));
  const small = [];
  const thieves = [];
  const tally = { self: 0, clipped: 0, ancestor: 0, sibling: 0, edge: 0, dead: 0 };
  let dead = 0;
  let clippedControls = 0;
  let missedControls = 0;
  let hidden = 0;
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.width >= target && r.height >= target) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // The centre first. A control whose own centre does not resolve to it is
    // clipped, covered or visually hidden, and no outset can make it tappable
    // -- that is a different defect from the one measured here, so it is
    // counted separately rather than blamed on the outset.
    const atCentre = document.elementFromPoint(cx, cy);
    if (!atCentre || !(atCentre === el || el.contains(atCentre) || atCentre.contains(el))) {
      hidden += 1;
      if (small.length < 24) {
        small.push({
          tag: el.tagName.toLowerCase(),
          label: (el.getAttribute('aria-label') || (el.textContent || '').trim()).slice(0, 24) || null,
          w: Math.round(r.width), h: Math.round(r.height), verdict: 'not-visible',
        });
      }
      continue;
    }
    // What the stylesheet actually produced on this control. The rule is
    // written at specificity 0,0,1 (\`:where(...)::after\`) and the bundle has
    // rules at 0,1,0 on the same pseudo (\`._Button_eg66f_2:after\` sets
    // \`pointer-events: none\`), so whether our declarations survive is a
    // per-control fact and not something the stylesheet can promise.
    const cs = getComputedStyle(el);
    const as = getComputedStyle(el, '::after');
    const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
    // \`inset\` on an absolutely positioned pseudo resolves against the padding
    // box; \`r\` is the border box. A bordered control therefore gets a hit area
    // smaller than outset arithmetic claims, and the shortfall appears on the
    // right and bottom edges first because those are where the two boxes
    // diverge in the direction the probe walks.
    const pad = {
      left: r.left + num(cs.borderLeftWidth), top: r.top + num(cs.borderTopWidth),
      right: r.right - num(cs.borderRightWidth), bottom: r.bottom - num(cs.borderBottomWidth),
    };
    const afterBox = as.position === 'absolute' && as.content !== 'none' ? {
      left: pad.left + num(as.left), top: pad.top + num(as.top),
      right: pad.right - num(as.right), bottom: pad.bottom - num(as.bottom),
    } : null;
    const pseudo = {
      content: as.content, pe: as.pointerEvents, pos: as.position, elPos: cs.position,
      inset: num(as.top) + '/' + num(as.right) + '/' + num(as.bottom) + '/' + num(as.left),
      // The control's own overflow, which decides whether the rule can do
      // anything for it at all.
      elOv: cs.overflowX + '/' + cs.overflowY,
      border: num(cs.borderTopWidth) + '/' + num(cs.borderRightWidth) + '/'
        + num(cs.borderBottomWidth) + '/' + num(cs.borderLeftWidth),
      w: afterBox ? Math.round(afterBox.right - afterBox.left) : null,
      h: afterBox ? Math.round(afterBox.bottom - afterBox.top) : null,
      // How far the delivered box falls short of --codex-touch-target, which
      // is the honest version of what the rule achieves: the target is the
      // threshold that selects which controls need help, never a promise
      // about the result, and for a bordered control the result is 2px under
      // the arithmetic in the rule's own comment.
      shortW: afterBox ? Math.round(target - (afterBox.right - afterBox.left)) : null,
      shortH: afterBox ? Math.round(target - (afterBox.bottom - afterBox.top)) : null,
    };
    // Which ancestor, if any, clips a point out of the pseudo's box. Walks to
    // the root rather than stopping at the first scroller, because the clip
    // that matters is any ancestor whose box excludes the point on an axis it
    // does not let overflow -- that is the one that removed the region from
    // hit-testing, and naming it is what turns a failing side into a decision.
    const clipperFor = (x, y) => {
      // Starts at the control, not its parent. A pseudo-element is clipped by
      // its originating element first, and a control that truncates its own
      // label does clip -- so the outset is void on every side of it, and no
      // ancestor is at fault.
      let n = el;
      while (n && n !== document.documentElement) {
        const s = getComputedStyle(n);
        const b = n.getBoundingClientRect();
        const outX = s.overflowX !== 'visible' && (x < b.left || x > b.right);
        const outY = s.overflowY !== 'visible' && (y < b.top || y > b.bottom);
        if (outX || outY) {
          return {
            cls: String(n.className || '').slice(0, 46) || n.tagName.toLowerCase(),
            overflow: s.overflowX + '/' + s.overflowY,
            axis: outX && outY ? 'both' : outX ? 'x' : 'y',
          };
        }
        n = n.parentElement;
      }
      return null;
    };
    const inAfter = (x, y) => (afterBox
      ? x >= afterBox.left && x < afterBox.right && y >= afterBox.top && y < afterBox.bottom
      : false);
    // Sampled from the padding box, because that is the box the pseudo is
    // laid out against and so the only one the rule can promise. Sampling the
    // border box instead -- which this probe did through real19 -- puts the
    // right and bottom points exactly on the pseudo's exclusive edge for any
    // control with a border, and reports a 2px layout fact as a tap failure.
    // One pixel inside on every side, so a point on a boundary is never the
    // thing under test.
    const probes = [
      ['left', pad.left - outset + 1, cy],
      ['right', pad.right + outset - 1, cy],
      ['top', cx, pad.top - outset + 1],
      ['bottom', cx, pad.bottom + outset - 1],
    ];
    const sides = {};
    for (const [name, x, y] of probes) {
      if (x < 0 || y < 0 || x > vw || y > innerHeight) { sides[name] = 'edge'; tally.edge += 1; continue; }
      const at = document.elementFromPoint(x, y);
      if (at && (at === el || el.contains(at))) { sides[name] = 'self'; tally.self += 1; continue; }
      // An ancestor hit is a MISS, recorded apart from \`dead\` only because its
      // cause is narrower. An ancestor is always painted beneath its own
      // descendant, so nothing can be sitting on top of the outset here: the
      // outset simply was not hit-testable at this point, either because a
      // more specific bundle rule took \`pointer-events\` away or because the
      // box never reached. Counting it as \`self\` -- as this probe did through
      // real18 -- reports the left and top edges of every control as working
      // for no reason other than that a control's own row is usually what sits
      // behind it.
      // Clipping is checked first and only where the box did cover the point:
      // it is the cause, and the element the hit landed on is downstream of it.
      const clip = inAfter(x, y) ? clipperFor(x, y) : null;
      const kind = clip
        ? 'clipped'
        : at && at.contains(el)
          ? 'ancestor'
          : isControl(at)
            ? 'sibling'
            : 'dead';
      sides[name] = kind;
      tally[kind] += 1;
      if (kind !== 'sibling') {
        // Name the element that took it. A dead side is a claim the stylesheet
        // makes and the page does not honour, and the only way to know whether
        // that is fixable in CSS is to know what is on top: a decorative
        // overlay that should never have been hit-testable is three lines, a
        // real sibling block is a layout question.
        if (thieves.length < 24) {
          const ts = at ? getComputedStyle(at) : null;
          thieves.push({
            of: (el.getAttribute('aria-label') || (el.textContent || '').trim()).slice(0, 24) || el.tagName.toLowerCase(),
            side: name,
            kind,
            // The deciding field. True means the probe point was inside the
            // pseudo's own box and something beat it on hit-testing; false
            // means the box never covered the point and no amount of
            // pointer-events would have helped.
            inAfter: inAfter(x, y),
            clip,
            // Everything under the point, nearest first, with the ancestry
            // relation to the control spelled out. The question this answers
            // is whether the control is in the stack at all.
            stack: document.elementsFromPoint(x, y).slice(0, 7).map((n) => {
              const s = getComputedStyle(n);
              const b = n.getBoundingClientRect();
              return (n === el ? 'SELF ' : el.contains(n) ? 'in ' : n.contains(el) ? 'anc ' : 'cousin ')
                + n.tagName.toLowerCase()
                + '.' + (String(n.className || '').split(' ')[0] || '-')
                + ' ov=' + s.overflowX + '/' + s.overflowY
                + ' pe=' + s.pointerEvents
                + ' r=' + Math.round(b.left) + ',' + Math.round(b.top)
                + '+' + Math.round(b.width) + 'x' + Math.round(b.height);
            }),
            pseudoPe: pseudo.pe,
            afterW: pseudo.w,
            afterH: pseudo.h,
            tag: at ? at.tagName.toLowerCase() : null,
            cls: (at && at.className && String(at.className).slice(0, 56)) || null,
            role: at ? at.getAttribute('role') : null,
            pe: ts ? ts.pointerEvents : null,
            pos: ts ? ts.position : null,
            z: ts ? ts.zIndex : null,
            // Whether it is even related. A later sibling of one of the
            // button's ancestors is the ordinary case; something out of the
            // subtree entirely is an overlay.
            rel: at && el.parentElement && el.parentElement.contains(at) ? 'uncle' : 'elsewhere',
          });
        }
      }
    }
    // \`dead\` and \`ancestor\` are faults in this stylesheet; \`clipped\` is a
    // limitation of expanding a hit area at all, recorded apart from both so
    // that it can be reported rather than either hidden or mistaken for a bug
    // with a CSS fix.
    const deadSides = Object.values(sides).filter((v) => v === 'dead' || v === 'ancestor').length;
    const clippedSides = Object.values(sides).filter((v) => v === 'clipped').length;
    if (deadSides > 0) dead += 1;
    if (clippedSides > 0) clippedControls += 1;
    if (deadSides + clippedSides > 0) missedControls += 1;
    if (small.length < 24) {
      small.push({
        tag: el.tagName.toLowerCase(),
        label: (el.getAttribute('aria-label') || (el.textContent || '').trim()).slice(0, 24) || null,
        w: Math.round(r.width), h: Math.round(r.height),
        sides, pseudo,
        verdict: deadSides > 0 ? 'dead-side' : clippedSides > 0 ? 'clipped' : 'covered',
      });
    }
  }

  // The resizers, which the same stylesheet removes rather than enlarges: a
  // 4px col-resize handle cannot be operated by touch and sits where it can
  // only steal taps (web/host-touch.css:369-376).
  const resizers = [...document.querySelectorAll('[role="separator"]')].map((el) => {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), display: getComputedStyle(el).display };
  });

  // Anything a tap focuses. Under 16px and iOS zooms the page, which is the
  // one layout failure the user cannot undo by scrolling.
  const typable = [...document.querySelectorAll('input,textarea,select,[contenteditable="true"]')]
    .map((el) => ({ tag: el.tagName.toLowerCase(), size: Math.round(parseFloat(getComputedStyle(el).fontSize) * 10) / 10 }));

  return {
    viewport: document.querySelector('meta[name="viewport"]')?.content ?? null,
    props: {
      target: prop('--codex-touch-target'), outset: prop('--codex-touch-outset'),
      zoom: prop('--codex-window-zoom'),
    },
    // The traffic-light inset, which is the single largest layout defect on a
    // phone: every iOS user-agent contains "like Mac OS X", so the bundle
    // takes the macOS branch, fails the version probe and reserves 98px of a
    // 390px viewport for window controls that do not exist. \`6px\` is what the
    // same expression computes for a platform with no window controls. Read
    // off the frame rather than the root because that is where the rule is
    // scoped (web/host-touch.css:127-130).
    headerInset: (() => {
      const frame = document.querySelector('[data-app-shell-frame]');
      if (!frame) return null;
      const fcs = getComputedStyle(frame);
      return {
        left: fcs.getPropertyValue('--spacing-token-safe-header-left').trim() || null,
        right: fcs.getPropertyValue('--spacing-token-safe-header-right').trim() || null,
      };
    })(),
    // \`-webkit-app-region: drag\` is applied by 21 rules across six shipped
    // stylesheets, including a 390x46 strip across the top of a phone. Whether
    // mobile WebKit swallows taps over a drag region was inferred rather than
    // measured, and this at least establishes what the computed value is where
    // the browser exposes it.
    appRegion: (() => {
      const bar = document.querySelector('[class*="Toolbar"]') || document.querySelector('header');
      if (!bar) return null;
      const v = getComputedStyle(bar).webkitAppRegion;
      return v === undefined ? 'not-exposed' : (v || 'empty');
    })(),
    scrollWidth: de.scrollWidth, innerWidth: vw,
    scrollHeight: de.scrollHeight, innerHeight: innerHeight,
    overflowing: over.slice(0, 12), overflowingCount: over.length,
    smallControls: small, smallDead: dead, smallHidden: hidden, sideTally: tally,
    smallMissed: missedControls,
    smallClipped: clippedControls,
    thieves,
    resizers,
    typable, typableUnder16: typable.filter((t) => t.size < 16),
    hasTouchClass: de.classList.contains('codex-touch') || de.dataset.codexTouch === 'true' || null,
  };
})()`);
report.fit = fit;
step('mobile-fit', {
  // Four pass/fail claims, each one something the stylesheet asserts:
  // nothing overflows a 390px viewport; nothing a tap focuses is under 16px,
  // which is the iOS auto-zoom the user cannot undo; no visible small control
  // has an outset edge that fails for a reason this stylesheet could fix; and
  // the traffic-light inset is 6px rather than the 98px the bundle computes
  // from an iPhone user-agent.
  //
  // A side lands in one of five buckets, and only two of them are faults:
  //
  //   self      the tap reached the control. The pass.
  //   sibling   another control took it. Legitimate: an expanded hit area may
  //             overlap anything that is itself a tap target, and the trade-off
  //             is already argued in web/host-touch.css.
  //   clipped   the control or an ancestor clips the pseudo out of existence
  //             at that point. Reported with the clipping element named, and
  //             NOT judged, because no stylesheet can expand a hit area past a
  //             clip -- a control that truncates its own label carries
  //             `overflow: hidden` and so cannot be helped by this rule at all.
  //             The only route to a larger target there is to enlarge the
  //             control, which means changing the shipped layout.
  //   ancestor   the tap reached a container the control sits in. A FAULT, and
  //             the one this probe used to hide: it counted an ancestor hit as
  //             `self` through real18, which passed the left and top edge of
  //             every control for no better reason than that a control's own
  //             row is usually what sits behind it.
  //   dead       anything else took it. A FAULT: something is painted over the
  //             outset, which is a stacking-order bug.
  //
  // `smallDead` counts controls with an `ancestor` or `dead` side, so this
  // criterion is stricter than the one real18 failed, not looser. What changed
  // the number from 5 to 0 was a measurement error: an absolutely positioned
  // pseudo-element is laid out against its originating element's PADDING box,
  // while `getBoundingClientRect()` returns the BORDER box, so for any control
  // with a 1px border this probe was sampling the right and bottom points at
  // exactly the pseudo's exclusive edge and reporting a 2px layout fact as a
  // tap failure.
  ok: fit?.overflowingCount === 0
    && (fit?.typableUnder16?.length ?? 1) === 0
    && fit?.smallDead === 0
    && fit?.headerInset?.left === '6px',
  overflowingCount: fit?.overflowingCount ?? null,
  widest: fit?.overflowing?.[0] ?? null,
  smallDead: fit?.smallDead ?? null,
  smallMissed: fit?.smallMissed ?? null,
  smallClipped: fit?.smallClipped ?? null,
  smallHidden: fit?.smallHidden ?? null,
  sideTally: fit?.sideTally ?? null,
  thieves: fit?.thieves ?? null,
  headerInset: fit?.headerInset ?? null,
  typableUnder16: fit?.typableUnder16 ?? null,
  scrollWidth: fit?.scrollWidth ?? null,
  innerWidth: fit?.innerWidth ?? null,
});

// ------------------------------------------------------ what is actually up
//
// A blank page with a healthy message bus has two completely different causes
// that look identical from outside: the startup gate returned null, or a lazy
// route chunk never resolved and a Suspense boundary is still showing its
// fallback. The DOM cannot tell them apart -- both are the same centred logo --
// and guessing wrong costs a whole chain restart, because an enrolment link is
// single use. The fiber tree can tell them apart: a pending Suspense boundary
// has a non-null memoizedState, and a settled one does not.
//
// Reading React internals off a minified build is ugly and it is still the
// cheapest honest answer available. Component names are mangled, so what this
// reports is structure -- tags, depth, and which boundaries are pending --
// rather than names it cannot trust.
if (process.env.DRIVE_DEEP) {
  report.fiber = await ev(`(() => {
    const host = document.querySelector('#root') || document.body;
    const key = Object.keys(host).find((k) => k.startsWith('__reactContainer'));
    if (!key) return { found: false, hostTag: host.tagName, keys: Object.keys(host).slice(0, 8) };
    const TAGS = {0:'Function',1:'Class',3:'Root',5:'Host',6:'Text',7:'Fragment',9:'Context.Consumer',
                  10:'Context.Provider',11:'ForwardRef',12:'Profiler',13:'Suspense',14:'Memo',15:'SimpleMemo',
                  16:'Lazy',22:'Offscreen',23:'LegacyHidden',24:'Cache',31:'Activity'};
    const name = (f) => {
      const t = f.type;
      if (typeof t === 'string') return t;
      if (typeof t === 'function') return t.displayName || t.name || 'anon';
      if (t && typeof t === 'object') return t.displayName || t._payload?.status != null
        ? ('lazy:' + (t._payload?.status ?? '?')) : (t.$$typeof ? String(t.$$typeof).slice(7, -1) : 'obj');
      return String(t);
    };
    const suspense = [];
    const lazy = [];
    let count = 0, maxDepth = 0;
    const walk = (f, depth) => {
      if (!f || count > 20000) return;
      count += 1;
      if (depth > maxDepth) maxDepth = depth;
      if (f.tag === 13) {
        // memoizedState non-null on a Suspense fiber IS the pending flag.
        suspense.push({ depth, pending: f.memoizedState !== null,
                        fallbackShown: f.memoizedState !== null,
                        parent: f.return ? name(f.return) : null });
      }
      if (f.tag === 16) lazy.push({ depth, status: f.type?._payload?.status ?? null });
      walk(f.child, depth + 1);
      walk(f.sibling, depth);
    };
    // React stores the HostRoot FIBER on this key, not the FiberRoot, so there
    // is no .current to step through -- and stepping through one that is not
    // there walks nothing and reports a healthy zero.
    const container = host[key];
    walk(container?.current ?? container, 0);
    return { found: true, fibers: count, maxDepth,
             suspense, suspensePending: suspense.filter((s) => s.pending).length,
             lazy, lazyUnresolved: lazy.filter((l) => l.status !== 1).length };
  })()`);

  report.domSplit = await ev(`(() => ({
    head: document.head.getElementsByTagName('*').length,
    body: document.body.getElementsByTagName('*').length,
    modulePreloads: document.querySelectorAll('link[rel="modulepreload"]').length,
    rootExists: !!document.querySelector('#root'),
    // Chunks the document fetched after boot: a route that never arrives is a
    // route whose chunk request is missing from here.
    lateScripts: performance.getEntriesByType('resource')
      .filter((r) => r.initiatorType === 'script' || /\\.js(\\?|$)/.test(r.name))
      .map((r) => ({ p: new URL(r.name, location.origin).pathname.split('/').pop(),
                     ms: Math.round(r.duration), size: r.transferSize })).slice(0, 120),
  }))()`);
}
report.bootShot = await shot('02-app');

// ------------------------------------------------- why the gate stays closed
//
// The renderer holds its loading indicator until `Lka(...)` returns a target,
// and every one of that function's null branches is an input the host supplies.
// Reading the host's own record of what it announced, and then re-announcing to
// see whether anything moves, separates "the host never said it" from "the host
// said it too early for anyone to hear".
if (process.env.PROBE_GATE) {
  report.hostState = await ev(`(async () => {
    const h = window.__codexRelayHostBoot;
    if (!h) return { present: false };
    const announced = await Promise.race([
      Promise.resolve(h.announced).then((v) => v, (e) => ({ rejected: String(e?.message ?? e) })),
      new Promise((r) => setTimeout(() => r('PENDING'), 2000)),
    ]);
    return {
      present: true, announced, ok: h.ok, failures: h.failures, layers: h.layers,
      // stats is a getter on the link and a method on the fetch layer; ask for
      // whichever one is there. (No backticks in here -- this is inside one.)
      link: h.link ? { stats: h.link.stats, pending: h.link.pending, armed: h.link.armed,
                       started: h.link.started, closed: h.link.closed, hostId: h.link.hostId } : null,
      fetch: typeof h.hostFetch?.stats === 'function' ? h.hostFetch.stats() : (h.hostFetch?.stats ?? null),
    };
  })()`);

  const snap = `(() => { const r = document.querySelector('#root');
    return { nodes: document.getElementsByTagName('*').length,
             children: r ? r.children.length : 0,
             html: r ? r.innerHTML.slice(0, 300) : null }; })()`;

  report.gate = { before: await ev(snap) };
  // Re-announce with exactly what the host announced the first time. A second
  // announcement is not something the host would ever send -- the link refuses
  // it -- but the question here is only whether the renderer was listening when
  // the first one went past.
  const v = report.hostState?.announced;
  if (v && typeof v === 'object' && typeof v.appServerVersion === 'string') {
    await ev(`(() => { window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'codex-app-server-initialized', hostId: 'local',
      appServerVersion: ${JSON.stringify(v.appServerVersion)},
      installedCodexVersion: ${JSON.stringify(v.installedCodexVersion ?? v.appServerVersion)},
      transport: 'relay' } })); return true; })()`);
    await settle(2500);
    report.gate.afterInitialized = await ev(snap);
    await ev(`(() => { window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'codex-app-server-connection-changed', hostId: 'local', state: 'connected' } }));
      return true; })()`);
    await settle(2000);
    report.gate.afterConnected = await ev(snap);
  }
  step('gate-probe', {
    ok: (report.gate.afterInitialized?.nodes ?? 0) > (report.gate.before?.nodes ?? 0),
    before: report.gate.before?.nodes,
    afterInitialized: report.gate.afterInitialized?.nodes,
    afterConnected: report.gate.afterConnected?.nodes,
    announced: report.hostState?.announced,
  });
  report.gateShot = await shot('02b-gate');
}

// ------------------------------------------------------- choosing a project
//
// The startup gate opens as soon as `workspace-root-options` returns one root,
// but a root is not a SELECTION. The selected project lives in global state
// under SELECTED_PROJECT and starts unset, and `projectless-workspace-root`
// answers null, so a fresh relay session lands on a fully mounted app whose
// Send button is enabled and whose turn still goes nowhere. Measured on real8:
// one `config/read` with `cwd:"~"` and no `thread/start` at all.
//
// So drive the picker a thumb would, and record what it OFFERED as well as
// what was chosen -- an empty picker and an unselected project produce the
// same screen, and only one of them is a host bug.
//
// (No backticks below this line -- this whole block is inside one.)
if (PICK) {
  const open = await ev(`(() => {
    const hit = [...document.querySelectorAll('button,[role="button"],[role="combobox"]')]
      .find(el => /choose project|select project/i.test(el.innerText || el.getAttribute('aria-label') || ''));
    if (!hit) return {ok:false, why:'no project control'};
    const r = hit.getBoundingClientRect();
    return {ok:true, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2),
            w: Math.round(r.width), h: Math.round(r.height),
            label: (hit.innerText || '').slice(0, 80)};
  })()`);
  step('project-control', { ok: open?.ok === true, ...open });

  if (open?.ok) {
    for (const type of ['touchStart', 'touchEnd']) {
      await send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchStart' ? [{ x: open.x, y: open.y }] : [],
      });
    }
    await settle(1200);
    report.pickerShot = await shot('02c-picker');

    // Enumerate before choosing. Whatever the picker lists is the host's
    // `workspace-root-options` answer rendered back, so this doubles as a
    // read-back assertion on the endpoint that unblocked the gate.
    const offered = await ev(`(() => {
      const nodes = [...document.querySelectorAll(
        '[role="option"],[role="menuitem"],[role="menuitemradio"],[cmdk-item],li button,[role="dialog"] button')];
      return nodes.map(el => {
        const r = el.getBoundingClientRect();
        return {text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
                x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2),
                w: Math.round(r.width), h: Math.round(r.height)};
      }).filter(o => o.text && o.w > 0 && o.h > 0).slice(0, 40);
    })()`);
    report.projectOptions = offered;
    step('project-options', { ok: Array.isArray(offered) && offered.length > 0, count: offered?.length ?? 0,
      texts: (offered || []).slice(0, 8).map((o) => o.text) });

    // "Add a folder on this computer" opens a native directory dialog, which a
    // browser cannot satisfy -- tapping it leaves a modal over the composer.
    // The dialog's own chrome (Add / Cancel / Create project / Close dialog)
    // is not a project either. Choose only from rows that look like a real
    // root; prefer the scratch workspace, and fall back rather than guessing
    // at a label vocabulary.
    const chrome = /^(add|cancel|create project|close dialog|skip to content)$/i;
    const candidates = (offered || [])
      .filter((o) => !chrome.test(o.text) && !/add a folder/i.test(o.text));
    const want = candidates.find((o) => o.text.includes('workspace'))
      || candidates.find((o) => /[/\\]/.test(o.text))
      || candidates[0];
    if (!want) {
      // Not a failure: an empty picker is the expected shape of a host with no
      // project, and the projectless path exists for exactly this. Close the
      // dialog so it does not sit over the composer, and carry on.
      for (const type of ['keyDown', 'keyUp']) {
        await send('Input.dispatchKeyEvent', {
          type, key: 'Escape', code: 'Escape',
          windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
        });
      }
      await settle(800);
      step('project-chosen', {
        ok: true,
        picked: null,
        projectless: true,
        why: 'the picker offered no root a browser can choose; closed it and left the thread projectless',
      });
    }
    if (want) {
      for (const type of ['touchStart', 'touchEnd']) {
        await send('Input.dispatchTouchEvent', {
          type,
          touchPoints: type === 'touchStart' ? [{ x: want.x, y: want.y }] : [],
        });
      }
      await settle(1500);
      const now = await ev(`(() => { const t = ${PAGE_TEXT}; return {
        bodyText: t.text.slice(0, 400),
        bodyTextLen: t.len,
        stillChoosing: /choose project/i.test(t.text),
      }; })()`);
      // `stillChoosing === false` passes on an empty string as readily as on a
      // page that moved on, so the text has to be non-empty for the absence of
      // the phrase to mean anything.
      step('project-chosen', {
        ok: now?.stillChoosing === false && (now?.bodyText ?? '') !== '',
        picked: want.text,
        ...now,
      });
      report.projectShot = await shot('02d-project');
    }
  }
}

// ---------------------------------------------------------------- a real turn

if (TURN) {
  const before = collected.ws.length;

  // Escape first, unconditionally -- a no-op when nothing is open. A modal
  // left over from the picker sits above the composer and swallows both the
  // insertText and the Send tap, which is precisely how real10 reached
  // `sent: 0, received: 0` with an enabled Send button on screen. Record
  // whether one was actually there, so a silent turn is never ambiguous again.
  const modalBefore = await ev(`(() => {
    const d = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')]
      .filter(el => el.getBoundingClientRect().width > 0);
    return {count: d.length, text: (d[0]?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120)};
  })()`);
  if ((modalBefore?.count ?? 0) > 0) {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', {
        type, key: 'Escape', code: 'Escape',
        windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
      });
    }
    await settle(800);
  }
  const modalAfter = await ev(`(() => [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')]
    .filter(el => el.getBoundingClientRect().width > 0).length)()`);
  step('composer-clear', {
    ok: modalAfter === 0,
    modalsBefore: modalBefore?.count ?? 0,
    modalsAfter: modalAfter,
    was: modalBefore?.text || null,
  });

  const focused = await ev(`(() => {
    const c = document.querySelector('[contenteditable="true"]');
    if (!c) return {ok:false, why:'no composer'};
    const r = c.getBoundingClientRect();
    return {ok:true, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)};
  })()`);
  if (focused?.ok) {
    for (const type of ['touchStart', 'touchEnd']) {
      await send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchStart' ? [{ x: focused.x, y: focused.y }] : [],
      });
    }
    await settle(700);
    // insertText, not `.value =`: this is a ProseMirror contenteditable and a
    // direct property write is invisible to it.
    await send('Input.insertText', { text: TURN });
    await settle(900);
    report.composedShot = await shot('03-composed');

    // Enter is deliberately NOT used. On a coarse pointer the composer keymap
    // routes Enter to the newline command before it ever reaches emit('submit')
    // -- measured, and the reason the touch layer enlarges the Send button
    // instead of faking keystrokes. So drive the control a thumb would.
    const sent = await ev(`(() => {
      const b = [...document.querySelectorAll('button,[role="button"]')]
        .find(b => /send/i.test(b.getAttribute('aria-label') || ''));
      if (!b) return {ok:false, why:'no Send button'};
      if (b.disabled || b.getAttribute('aria-disabled') === 'true') return {ok:false, why:'Send is disabled'};
      const r = b.getBoundingClientRect();
      return {ok:true, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2),
              w: Math.round(r.width), h: Math.round(r.height)};
    })()`);
    step('send-button', { ok: sent?.ok === true, ...sent });

    // The Send button measures 28x28 and is SUPPOSED to. The touch layer does
    // not grow the visible pill -- that would change paint on an icon button
    // with a background -- it adds an `::after` overlay outset by
    // (44 - 28) / 2 = 8px per side. getBoundingClientRect() on the button
    // reports the painted box, so 28x28 says nothing either way about the hit
    // area, and reading it as a defect would be reading the wrong box.
    //
    // What actually distinguishes a working hit area from the bundle's
    // `pointer-events: none` bug is whether a point in the outset RING hit
    // tests to the button. elementFromPoint answers that directly.
    if (sent?.ok) {
      const ring = await ev(`(() => {
        const b = [...document.querySelectorAll('button,[role="button"]')]
          .find(b => /send/i.test(b.getAttribute('aria-label') || ''));
        if (!b) return {ok:false, why:'no Send button'};
        const r = b.getBoundingClientRect();
        const target = parseFloat(getComputedStyle(document.documentElement)
          .getPropertyValue('--codex-touch-target')) || 44;
        const outset = (target - Math.min(r.width, r.height)) / 2;
        if (outset <= 0) return {ok:true, alreadyBigEnough:true, w:r.width, h:r.height, target};
        // Four points, each in the ring: outside the painted box, inside the
        // intended target. 2px in from the ring's outer edge to stay clear of
        // the boundary itself.
        const probes = {
          left:   [r.left - outset + 2,  r.top + r.height/2],
          right:  [r.right + outset - 2, r.top + r.height/2],
          top:    [r.left + r.width/2,   r.top - outset + 2],
          bottom: [r.left + r.width/2,   r.bottom + outset - 2],
        };
        const out = {};
        for (const [side, [x, y]] of Object.entries(probes)) {
          const el = document.elementFromPoint(Math.round(x), Math.round(y));
          out[side] = el === b || b.contains(el) ? 'button'
            : (el === null ? 'null' : (el.tagName || '?').toLowerCase()
               + (el.getAttribute && el.getAttribute('aria-label') ? '[' + el.getAttribute('aria-label') + ']' : ''));
        }
        const hits = Object.values(out).filter(v => v === 'button').length;
        return {ok: hits === 4, hits, sides: out, outset, target,
                painted: [Math.round(r.width), Math.round(r.height)]};
      })()`);
      step('send-hit-area', {
        ok: ring?.ok === true,
        painted: ring?.painted,
        target: ring?.target,
        outset: ring?.outset,
        hits: ring?.hits,
        sides: ring?.sides,
      });
      report.sendHitArea = ring;
    }

    if (sent?.ok) {
      for (const type of ['touchStart', 'touchEnd']) {
        await send('Input.dispatchTouchEvent', {
          type,
          touchPoints: type === 'touchStart' ? [{ x: sent.x, y: sent.y }] : [],
        });
      }
      // Wait for the turn to say it is over, not for the wire to go quiet.
      //
      // Quiet was the original rule, and it is wrong for exactly the case this
      // drive exists to prove. The model thinks between frames: measured at
      // 15.3s of API time inside a 17s turn, against a quiet window of six
      // 1500ms ticks. So the loop returned while the composer still read
      // "Thinking", the snapshot below caught that instead of the reply, and
      // both `turn` and `no-snag` went green over a turn that had not
      // finished. The adapter's own runs.jsonl recorded `turn.completed`
      // eighteen seconds after the drive had already written its report.
      //
      // `turn/completed` is what the app-server sends when it is actually
      // done. Quiet stays as the fallback, because a turn that dies without
      // completing sends nothing either, and waiting out TURN_WAIT_MS on every
      // failure would cost two minutes a run.
      let quiet = 0;
      let seen = collected.ws.length;
      const deadline = Date.now() + TURN_WAIT_MS;
      const finished = () => collected.ws.slice(before).some(
        (f) => f.ev === 'recv' && (f.head ?? '').includes('"method":"turn/completed"'));
      while (Date.now() < deadline && quiet < 6 && !finished()) {
        await settle(1500);
        if (collected.ws.length === seen) quiet += 1;
        else {
          quiet = 0;
          seen = collected.ws.length;
        }
      }
      // The frame lands before the renderer has painted what it announces.
      if (finished()) await settle(2500);
    }
  } else {
    step('compose', { ok: false, ...focused });
  }

  const frames = collected.ws.slice(before);
  const sentF = frames.filter((f) => f.ev === 'sent');
  const recvF = frames.filter((f) => f.ev === 'recv');
  const completed = recvF.some(
    (f) => (f.head ?? '').includes('"method":"turn/completed"'));
  const after = await ev(`(() => { const t = ${PAGE_TEXT}; return {
    bodyText: t.text.slice(0, 2000),
    bodyTextLen: t.len,
    domNodeCount: document.getElementsByTagName('*').length,
  }; })()`);
  report.turn = {
    // Frames moved in both directions AND the server said the turn finished.
    // Counting frames alone passes on a turn that was still thinking when the
    // wait gave up, which is the one state this step exists to tell apart
    // from a reply.
    ok: sentF.length > 0 && recvF.length > 0 && completed,
    completed,
    sent: sentF.length,
    received: recvF.length,
    sentHeads: sentF.slice(0, 6).map((f) => f.head),
    recvHeads: recvF.slice(0, 10).map((f) => f.head),
    after,
  };
  step('turn', {
    ok: report.turn.ok, completed, sent: report.turn.sent, received: report.turn.received,
  });
  report.turnShot = await shot('04-turn');
}

// ------------------------------------------------- what the host itself saw
//
// The middleware runs in the page, not in the surface, so none of its counters
// reach surface.log -- grepping there for a missed endpoint finds nothing and
// reads like proof there was none. `__codexRelayHostBoot` is the installed
// handle; these are the counters that name a host bug rather than a UI one:
// `fetch.unknown` and `endpoint-unimplemented` mean the renderer asked for
// something no builtin answers, and `foreignHostId` means it addressed a host
// that is not us.
report.hostStats = await ev(`(() => {
  const h = globalThis.__codexRelayHostBoot;
  if (!h) return {present: false};
  const pick = (o) => {
    if (!o || typeof o !== 'object') return null;
    const out = {};
    for (const k of Object.keys(o)) { const v = o[k]; if (typeof v === 'number' || typeof v === 'boolean') out[k] = v; }
    return out;
  };
  const fetchStats = typeof h.hostFetch?.stats === 'function' ? h.hostFetch.stats() : h.hostFetch?.stats;
  return {
    present: true,
    ok: h.ok === true,
    failures: (h.failures || []).map(f => ({layer: f.layer, why: String(f.error?.message ?? f.error ?? '').slice(0, 160)})),
    layers: (h.layers || []).map(l => l.layer ?? l.name).filter(Boolean),
    fetch: pick(fetchStats),
    link: pick(h.link?.stats),
    bus: pick(h.bus?.stats),
    touch: pick(h.touch?.stats),
    // The capability protocol, end to end. \`exported\` proves the renderer was
    // handed an \`["export", id]\`; \`called\` proves it sent one back as a
    // pipeline push. Zero \`called\` with a rendered reply would mean the page
    // survived for some other reason and the namespace fix is unproven.
    capnweb: pick(typeof h.handshake?.session?.stats === 'function' ? h.handshake.session.stats() : h.handshake?.session?.stats),
    namespaces: (() => { try { return h.namespaces?.stats?.() ?? null; } catch { return null; } })(),
    // Not the count -- the dispositions. \`foreignHostId\` climbing says the
    // renderer addressed a host this link does not serve, which is ordinary
    // (web/hostlink/link.mjs:772 explains why a second hostId is not
    // pathology). What it cannot say is whether those frames were ANSWERED,
    // and for \`mcp-request\` that is the whole question: the renderer's
    // \`createRequest\` defaults its deadline to zero and arms no timer, so a
    // frame recorded and not answered is a promise left in its table for the
    // life of the page. 'answered' and 'dropped' read identically in the
    // count and differently in a hang.
    foreignFrames: (() => {
      try {
        const tally = {};
        for (const f of (h.link?.foreignFrames ?? [])) {
          const k = (f.type ?? '?') + ':' + (f.disposition ?? '?');
          tally[k] = (tally[k] ?? 0) + 1;
        }
        return tally;
      } catch { return null; }
    })(),
  };
})()`);
// A foreign frame this link only RECORDED is a renderer promise with no
// deadline and no retry behind it. `refuseForeignRequest` answers the two types
// that carry one and returns 'dropped' for the rest, which is correct for a
// notification and a hang for a request -- so the assertion is about the
// request-carrying types specifically, not about the tally being empty.
const hangingForeign = Object.entries(report.hostStats?.foreignFrames ?? {})
  .filter(([k, n]) => n > 0
    && /^(mcp-request|thread-prewarm-start):/.test(k)
    && !k.endsWith(':answered'));

step('host-stats', {
  ok: report.hostStats?.present === true && report.hostStats?.ok === true
    && hangingForeign.length === 0,
  ...(hangingForeign.length ? { hangingForeign } : {}),
  failures: report.hostStats?.failures?.length ?? null,
  unknownFetch: report.hostStats?.fetch?.unknown ?? null,
  unimplemented: report.hostStats?.fetch?.unimplemented ?? null,
  foreignHostId: report.hostStats?.link?.foreignHostId ?? null,
  foreignFrames: report.hostStats?.foreignFrames ?? null,
});
const nsCalls = report.hostStats?.namespaces?.calls ?? {};
step('host-namespaces', {
  // The calls map is the real evidence: it can only be non-empty if the
  // renderer parsed our ["export", id], built a stub from it, and pushed a
  // pipeline call back. `exported` alone would only prove we sent one.
  ok: Object.values(nsCalls).some((n) => n > 0) && (report.hostStats?.capnweb?.exported ?? 0) > 0,
  exported: report.hostStats?.capnweb?.exported ?? null,
  called: report.hostStats?.capnweb?.called ?? null,
  threw: report.hostStats?.capnweb?.threw ?? null,
  calls: report.hostStats?.namespaces?.calls ?? null,
  presented: report.hostStats?.namespaces?.presented ?? null,
});
// ------------------------------------------------- what the host wrote down
//
// The ring is the only place that names WHICH endpoints went unanswered. The
// counter says 15 and a count cannot be acted on; the entries carry the
// endpoint, so a drive now ends with a list to go implement.
//
// It is also the one assertion in this file about what is NOT in a value. The
// ring's own header promises no paths, no urls, no identifiers, and two of its
// writers quote text from outside this repository -- an app-server error and a
// browser DOMException. Unit tests pin that against a fake window; this pins it
// against the real renderer on a real chain, where the strings are real.
report.degradations = await ev(`(() => {
  const h = globalThis.__codexRelayHostBoot;
  if (!h || typeof h.degradations !== 'function') return {present: false};
  const snap = h.degradations();
  const s = JSON.stringify(snap);
  const field = (name) => [...new Set(snap.entries.map((e) => e[name]).filter((v) => v != null))].sort();
  return {
    present: true,
    capacity: snap.capacity,
    dropped: snap.dropped,
    bytes: s.length,
    counts: snap.counts,
    entryCount: snap.entries.length,
    kinds: [...new Set(snap.entries.map((e) => e.kind))].sort(),
    fields: [...new Set(snap.entries.flatMap((e) => Object.keys(e)))].sort(),
    endpoints: field('endpoint'),
    types: field('type'),
    layers: field('layer'),
    // The rows themselves, in order, when asked for. A set of distinct type
    // names answers "what went unclaimed" and cannot answer "when" -- and for
    // one of these the two questions have different answers. \`mcp-request\` is
    // claimed by the hostlink layer (web/hostlink/link.mjs:1551), so its
    // presence in the set means some of them arrived before that subscription
    // existed, which the sequence numbers show and the set hides. Behind the
    // flag because these rows are the one part of the snapshot with renderer
    // strings in it, and the leak tests above are what license printing them.
    ...(${process.env.DRIVE_DEEP ? 'true' : 'false'} ? { entries: snap.entries } : {}),
    // Plain substring tests rather than patterns: this runs through two
    // template literals before it reaches the page, and a regex that loses a
    // backslash on the way fails open.
    leaks: {
      socketUrl: s.includes('ws://') || s.includes('wss://'),
      fetchUrl: s.includes('codex-fetch://'),
      relayOrigin: s.includes(location.host),
      absolutePath: s.includes('/Users/') || s.includes('/private/') || s.includes('/var/folders/'),
      bearer: s.includes('Bearer ') || s.includes('eyJ'),
      reasonField: Object.keys(Object.assign({}, ...snap.entries)).includes('reason'),
    },
  };
})()`);
step('host-degradations', {
  ok: report.degradations?.present === true
    && Object.values(report.degradations.leaks ?? {true: true}).every((v) => v === false),
  entryCount: report.degradations?.entryCount ?? null,
  dropped: report.degradations?.dropped ?? null,
  bytes: report.degradations?.bytes ?? null,
  kinds: report.degradations?.kinds ?? null,
  endpoints: report.degradations?.endpoints ?? null,
  leaks: report.degradations?.leaks ?? null,
});

// The crash this all exists to remove rendered as a snag card, not as a blank
// page, so "the reply is in the DOM" is not on its own enough.
//
// An empty reading is not the absence of a snag card, it is the absence of
// evidence either way, and this line reported the first as the second for as
// long as it tested `innerText` alone.
//
// A non-empty reading is not enough either. A run whose enrolment link had
// already been spent never mounted the app, and the 24 characters of
// onboarding chrome it did render contain no snag phrase -- so this step
// reported green on a page that had never seen a turn, in a drive where nine
// other steps were red. And the step ran at all on drives started without
// DRIVE_TURN, where it could only ever read the empty string: a red that
// means "nothing was asked of me" teaches people to skim past reds.
//
// So: only when a turn was driven, and only green when that turn finished.
if (TURN) {
  const snagText = report.turn?.after?.bodyText ?? '';
  const snag = /hit a snag|went wrong|Something went wrong/i.test(snagText);
  step('no-snag', {
    ok: !snag && snagText !== '' && report.turn?.completed === true,
    snag,
    read: snagText.length,
    turnCompleted: report.turn?.completed ?? false,
  });
}

// The focus layer, which is the only one whose failure is silence on both
// sides. Everything else here proves itself by producing something; this one
// proves itself by an absence -- `outbound-unclaimed` not carrying
// `electron-window-focus-request` -- and an absence is exactly what a layer
// that installed and then did nothing also produces.
//
// So this asks the layer what it did, and then asks the page to change state
// and asks again. A layer that answered the startup request once and then went
// quiet passes the first half and fails the second, and that is the shape that
// matters on a phone: TanStack Query's visibility listener was REPLACED by the
// renderer (app-initial@10008777), so after the first answer the host is the
// only thing that can tell it the tab came back. One answer and silence leaves
// a phone that never refetches after the user switches apps.
report.focus = await ev(`(() => {
  const h = globalThis.__codexRelayHostBoot;
  const f = h && h.focus;
  if (!f || typeof f.stats !== 'function') return {present: false};
  return {present: true, read: f.read(), stats: f.stats()};
})()`);
if (report.focus?.present) {
  // A real hidden/visible round trip, not a dispatched event: a synthetic
  // `visibilitychange` proves the listener is bound and nothing about whether
  // the browser ever fires one.
  //
  // How the page is sent away and brought back was settled by measurement
  // against a scratch Chrome, because three plausible methods do not work and
  // two of them fail by SUCCEEDING:
  //
  //   Emulation.setPageVisibilityOverride   gone from this Chrome (-32601)
  //   Page.setWebLifecycleState 'frozen'    hides it, and a frozen page runs
  //                                         no listeners, so it never comes
  //                                         back -- measured here as a layer
  //                                         that pushed false and never true,
  //                                         which is the exact phone symptom
  //                                         this probe exists to detect, faked
  //                                         entirely by the probe
  //   ...followed by 'active'               returns ok, stays hidden
  //
  // What works is handing "front" to a second tab and taking it back, which is
  // also what the real gesture is. It suspends nothing, so the socket and the
  // host's own timers survive it, and `document.hasFocus()` moves with it --
  // which matters because the layer reads visibility AND focus, not either.
  //
  // Twice, not once: the first handover reliably changes state and sometimes
  // does not deliver its events, having raced the page's own startup focus.
  // The second is the one measured. A probe that reports the flaky half would
  // make this step a coin toss and the layer would get the blame.
  //
  // CDP failures are CAPTURED rather than swallowed, because a swallowed
  // refusal reads exactly like a layer that stopped pushing, and that would
  // blame this repo for the browser's release notes.
  const cdp = async (method, params, sess) => {
    try {
      await send(method, params, sess);
      return null;
    } catch (e) {
      return `${method}: ${String(e?.message ?? e).slice(0, 160)}`;
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 450));
  const focusStats = () => ev(`globalThis.__codexRelayHostBoot?.focus?.stats() ?? null`);

  let cdpErr = await cdp('Page.bringToFront', {});
  const other = await send('Target.createTarget', { url: 'about:blank' }).catch(() => null);
  const otherSession = other
    ? (await send('Target.attachToTarget', { targetId: other.targetId, flatten: true }).catch(() => null))?.sessionId
    : null;
  if (!otherSession) {
    report.focus.emulationError = cdpErr ?? 'could not open a second tab to take the foreground';
  } else {
    for (const round of [1, 2]) {
      cdpErr = (await cdp('Page.bringToFront', {}, otherSession)) ?? cdpErr;
      await settle();
      if (round === 2) report.focus.afterHide = await focusStats();
      cdpErr = (await cdp('Page.bringToFront', {})) ?? cdpErr;
      await settle();
      if (round === 2) report.focus.afterShow = await focusStats();
    }
    await send('Target.closeTarget', { targetId: other.targetId }).catch(() => {});
    report.focus.emulationError = cdpErr;
  }
}
// Both halves have to have been OBSERVABLE before either can be asserted: the
// browser accepted the calls, and the page was actually seen to go hidden. A
// method that returns success and fires nothing is the failure mode measured
// above, and it is indistinguishable from a dead layer unless the hidden
// reading is checked on its own.
const emulated = report.focus?.present === true
  && report.focus?.emulationError == null
  && report.focus?.afterHide?.lastSent === false;
step('host-focus', {
  // Four claims that fail separately. The layer is there; it ANSWERED the
  // renderer's request rather than only claiming the type, which is the half
  // that unblocks the onboarding route; it told the renderer the page went
  // away; and it told it the page came BACK, which is the half a phone
  // depends on and the only one a one-way layer fails.
  //
  // `lastSent === true` rather than a push count: a count going up says
  // something was sent and not which value, and the two are the difference
  // between a tab that refetches on return and one that never does.
  ok: report.focus?.present === true
    && (report.focus?.stats?.requestsAnswered ?? 0) > 0
    && (report.focus?.afterShow?.deliverFailures ?? 1) === 0
    && (!emulated || (report.focus?.afterHide?.lastSent === false
      && report.focus?.afterShow?.lastSent === true)),
  ...(emulated ? {} : { unprovable: 'hide-show-round-trip', emulationError: report.focus?.emulationError ?? null }),
  requestsAnswered: report.focus?.stats?.requestsAnswered ?? null,
  pushedAtTurnEnd: report.focus?.stats?.pushed ?? null,
  pushedAfterHideShow: report.focus?.afterShow?.pushed ?? null,
  sentOnHide: report.focus?.afterHide?.lastSent ?? null,
  sentOnShow: report.focus?.afterShow?.lastSent ?? null,
  deliverFailures: report.focus?.afterShow?.deliverFailures ?? null,
  observerFailures: report.focus?.afterShow?.observerFailures ?? null,
});

// ---------------------------------------------------------------- out

report.collected = {
  ...collected,
  ws: collected.ws.slice(0, 200),
  wsFrameCount: collected.ws.length,
};
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));

console.log(`\n=== EXCEPTIONS (${collected.exceptions.length}) ===`);
for (const e of collected.exceptions.slice(0, 10)) console.log(JSON.stringify(e).slice(0, 300));
console.log(`=== FAILED REQUESTS (${collected.failedRequests.length}) ===`);
for (const f of collected.failedRequests.slice(0, 15)) console.log(JSON.stringify(f).slice(0, 220));
console.log(`=== WS (${collected.ws.length} events) ===`);
for (const f of collected.ws.slice(0, 12)) console.log(JSON.stringify(f).slice(0, 240));
// Grouped by origin, because the question is "which third parties did this
// page reach for", not "how many times".
const byOrigin = new Map();
for (const r of collected.offOrigin) {
  let o = r.url;
  try {
    o = new URL(r.url).origin;
  } catch {}
  byOrigin.set(o, (byOrigin.get(o) || 0) + 1);
}
console.log(`=== OFF-ORIGIN ATTEMPTS (${collected.offOrigin.length} requests, ${byOrigin.size} origins) ===`);
for (const [o, n] of [...byOrigin].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x ${o}`);
console.log(`\nreport    ${OUT}/report.json`);

if (CAST) {
  try {
    await send('Page.stopScreencast');
  } catch {
    // Already gone; the frames on disk are what matter.
  }
  if (castLog !== null) fs.closeSync(castLog);
  console.log(`cast      ${castFrames} frames -> ${castDir}`);
}

try {
  await send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
} catch {
  // The browser is about to die anyway; a failure to tidy up is not news.
}
ws.close();
chrome.kill('SIGKILL');
fs.rmSync(profile, { recursive: true, force: true });
