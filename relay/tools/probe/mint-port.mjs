#!/usr/bin/env node
// Probe 4: can the renderer mint a SECOND host session just by asking?
//
// app-shared.js builds the host connection like this:
//
//   const { port1, port2 } = new MessageChannel();
//   window.postMessage({ type: 'connect-app-host', port: port2 }, origin, [port2]);
//   capnweb(port1, ourServices);
//
// The port is created renderer-side, not handed down by main. So the question is
// no longer "can we steal the app's port" but the much better one: can we just do
// the same thing again and get our own independent session? If yes, every browser
// client gets a real host endpoint with no membrane and no extra windows.
//
// Three outcomes matter, and the third is why this runs on a lab instance only:
//   ACCEPTED  -- our port answers, and the app keeps working
//   IGNORED   -- main never binds it; we hold a dead port
//   HIJACKED  -- main rebinds the single session to us and the app breaks
//
//   node probe/mint-port.mjs [port] [--url-contains <substr>]

import { Cdp, waitForEndpoint } from '../src/cdp/client.mjs';

const port = Number(process.argv[2] ?? 19333);
const ui = process.argv.indexOf('--url-contains');
const urlNeedle = ui === -1 ? 'index.html' : process.argv[ui + 1];

// Health of the app's own session: if minting a port steals the single host
// connection, the UI stops being able to talk to main and this degrades.
const HEALTH = `(() => {
  try {
    const b = window.electronBridge;
    const root = document.getElementById('root') || document.body;
    return {
      trusted: typeof b.getSentryInitOptions() === 'object',
      bridgeMembers: Object.keys(b).length,
      rootLength: root ? root.innerHTML.length : 0,
      readyState: document.readyState,
    };
  } catch (err) { return { error: String(err && err.message).slice(0, 120) }; }
})()`;

const MINT = `(async () => {
  const seen = [];
  const { port1, port2 } = new MessageChannel();

  port1.addEventListener('message', (ev) => {
    const d = ev.data;
    seen.push({
      kind: typeof d,
      isArray: Array.isArray(d),
      // capnweb frames are small JSON-ish arrays; record shape, not payload.
      preview: (() => {
        try { return JSON.stringify(d).slice(0, 160); } catch { return '<unserialisable>'; }
      })(),
      portsTransferred: ev.ports ? ev.ports.length : 0,
    });
  });
  port1.addEventListener('messageerror', (ev) => seen.push({ kind: 'messageerror' }));
  port1.start();

  // Exactly what the app does.
  window.postMessage({ type: 'connect-app-host', port: port2 }, window.location.origin, [port2]);

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(1500);
  const afterBind = seen.length;

  // capnweb's main export is import id 0; pulling it is the cheapest way to make
  // a live session say something back.
  let sendError = null;
  try { port1.postMessage(['pull', 0]); }
  catch (err) { sendError = String(err && err.message).slice(0, 160); }
  await wait(2500);

  return {
    framesBeforePull: afterBind,
    framesTotal: seen.length,
    frames: seen.slice(0, 8),
    sendError,
  };
})()`;

const version = await waitForEndpoint(port, { timeoutMs: 30_000 });
const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
const { targetInfos } = await cdp.send('Target.getTargets');
const target = targetInfos.find((t) => t.type === 'page' && (t.url ?? '').includes(urlNeedle));
if (!target) {
  process.stderr.write(`no page target containing ${JSON.stringify(urlNeedle)}\n`);
  process.exit(1);
}

const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
const page = cdp.session(sessionId);

const evaluate = async (expression, awaitPromise = false) => {
  const res = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, { timeoutMs: 60_000 });
  if (res.exceptionDetails) return { threw: res.exceptionDetails.text, detail: res.exceptionDetails.exception?.description?.slice(0, 300) };
  return res.result.value;
};

const before = await evaluate(HEALTH);
const mint = await evaluate(MINT, true);
const after = await evaluate(HEALTH);

const answered = (mint.framesTotal ?? 0) > 0;
const appHealthy = after?.trusted === true && (after?.rootLength ?? 0) > 200
  && (before?.rootLength ?? 0) > 0 && after.rootLength >= before.rootLength * 0.5;

const verdict = mint.threw
  ? `MINT THREW -- ${mint.threw}`
  : answered && appHealthy
    ? 'ACCEPTED -- our port got frames and the app still works (S2 is live)'
    : answered && !appHealthy
      ? 'HIJACKED -- our port answers but the app degraded; one session only'
      : !answered && appHealthy
        ? 'IGNORED -- main did not bind our port; the app is unharmed'
        : 'INCONCLUSIVE -- no frames and the app looks unhealthy';

process.stdout.write(JSON.stringify({
  verdict, target: (target.url ?? '').slice(0, 90), before, mint, after,
}, null, 2) + '\n');
cdp.close();
