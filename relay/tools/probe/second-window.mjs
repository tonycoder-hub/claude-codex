#!/usr/bin/env node
// Can we get a SECOND trusted window, and did it come from the app's own path?
//
// The surface needs one window per browser client: there is no per-window app
// state, and two renderers sharing one view-protocol channel would interleave
// responses and wedge each other. But a window built by calling the constructor
// ourselves is not registered with the window manager, so isTrustedIpcSender
// refuses it -- quietly, by handing back null, which the renderer then derefs.
//
// window.open from an already-trusted renderer is the interesting case: it goes
// out through the main process's own window-open handling, so if the app allows
// it at all, the result should be registered exactly like any other window.
//
//   node second-window.mjs [port] [--keep]

import { Cdp, waitForEndpoint } from '../src/cdp/client.mjs';

const port = Number(process.argv[2] ?? 19333);
const keep = process.argv.includes('--keep');

const TRUST_CHECK = `(() => {
  const b = window.electronBridge;
  let sentry = 'missing';
  try { sentry = b ? (b.getSentryInitOptions() === null ? 'null' : typeof b.getSentryInitOptions()) : 'no-bridge'; }
  catch (e) { sentry = 'threw:' + String(e && e.message).slice(0, 80); }
  return {
    href: location.href,
    codexWindowType: window.codexWindowType ?? null,
    bridgePresent: !!b,
    bridgeMemberCount: b ? Object.keys(b).length : 0,
    sentryInitOptions: sentry,
    readyState: document.readyState,
    rootHasContent: !!document.body && document.body.innerHTML.length > 200,
  };
})()`;

const version = await waitForEndpoint(port, { timeoutMs: 30_000 });
const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
await cdp.send('Target.setDiscoverTargets', { discover: true });

const before = (await cdp.send('Target.getTargets')).targetInfos;
const seed = before.find((t) => t.type === 'page' && (t.url ?? '').endsWith('index.html'))
  ?? before.find((t) => t.type === 'page');
if (!seed) throw new Error('no page target to open from');

const { sessionId } = await cdp.send('Target.attachToTarget', {
  targetId: seed.targetId, flatten: true,
});
const page = cdp.session(sessionId);

const created = [];
cdp.on('Target.targetCreated', (p) => {
  if (p.targetInfo.type === 'page') created.push(p.targetInfo);
});

// Ask the renderer to open a window the way the app's own code would.
const open = await page.send('Runtime.evaluate', {
  expression: `(() => {
    try {
      const w = window.open('app://-/index.html', '_blank');
      return { called: true, returnedWindow: !!w, closed: w ? w.closed : null };
    } catch (err) {
      return { called: false, error: String(err && err.message || err).slice(0, 200) };
    }
  })()`,
  returnByValue: true,
  userGesture: true,
});

await new Promise((r) => setTimeout(r, 4000));
const after = (await cdp.send('Target.getTargets')).targetInfos;
const beforeIds = new Set(before.map((t) => t.targetId));
const fresh = after.filter((t) => t.type === 'page' && !beforeIds.has(t.targetId));

const results = [];
for (const t of fresh) {
  const att = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const p = cdp.session(att.sessionId);
  // A brand-new window may not have run its scripts yet.
  for (let i = 0; i < 20; i++) {
    const res = await p.send('Runtime.evaluate', {
      expression: TRUST_CHECK, returnByValue: true,
    }).catch((err) => ({ error: err.message }));
    const v = res.result?.value;
    if (v && (v.readyState === 'complete' || i === 19)) { results.push({ targetId: t.targetId, ...v }); break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!keep) await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
}

const verdict = results.length === 0
  ? 'NO NEW WINDOW -- window.open did not produce a page target'
  : results.every((r) => r.sentryInitOptions === 'object')
    ? 'TRUSTED -- the new window passes isTrustedIpcSender'
    : 'UNTRUSTED -- the new window exists but the host is ignoring it';

process.stdout.write(JSON.stringify({
  verdict,
  openCall: open.result?.value ?? open.exceptionDetails?.text,
  pagesBefore: before.filter((t) => t.type === 'page').length,
  pagesAfter: after.filter((t) => t.type === 'page').length,
  newWindows: results,
  targetCreatedEvents: created.map((t) => ({ url: (t.url ?? '').slice(0, 90), openerId: t.openerId })),
  closed: !keep,
}, null, 2) + '\n');

cdp.close();
