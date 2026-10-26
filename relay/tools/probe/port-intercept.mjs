#!/usr/bin/env node
// Probe 3: can we see the connect-app-host MessagePort before the app does?
//
// The preload pushes the host port into the main world with
// window.postMessage(data, origin, [port]). Whoever registered a 'message'
// listener first gets called first -- that is plain DOM dispatch order, not a
// race -- so the question is really whether Page.addScriptToEvaluateOnNewDocument
// runs early enough to register before the bundle does.
//
// Rather than assume it, the probe wraps window.addEventListener and records the
// registration order itself, so "we were first" is measured rather than argued.
// It only observes: nothing is stopped, swallowed or rewritten, because breaking
// the handshake would wedge the window we are measuring.
//
//   node probe/port-intercept.mjs [port] [--url-contains <substr>] [--wait 20]

import { Cdp, waitForEndpoint } from '../src/cdp/client.mjs';

const port = Number(process.argv[2] ?? 19333);
const ui = process.argv.indexOf('--url-contains');
const urlNeedle = ui === -1 ? 'index.html' : process.argv[ui + 1];
const wi = process.argv.indexOf('--wait');
const waitSeconds = wi === -1 ? 20 : Number(process.argv[wi + 1]);

// Installed at document start, before any page script.
const HOOK = `(() => {
  const t0 = performance.now();
  const registrations = [];
  const messages = [];
  window.__probe3 = { t0, registrations, messages, installedAt: Date.now() };

  const origAdd = window.addEventListener.bind(window);
  // Record who registers a message listener, and in what order.
  window.addEventListener = function (type, fn, opts) {
    if (type === 'message') {
      const stack = (new Error().stack || '').split('\\n').slice(2, 4).join(' | ');
      registrations.push({ at: +(performance.now() - t0).toFixed(1), stack: stack.slice(0, 220) });
    }
    return origAdd(type, fn, opts);
  };

  // Ours goes on first, immediately after the hook, so registrations[0] is us.
  origAdd('message', (ev) => {
    const d = ev.data;
    const type = d && typeof d === 'object' ? d.type : typeof d;
    const portCount = ev.ports ? ev.ports.length : 0;
    if (portCount === 0 && type !== 'connect-app-host') return; // keep the log small
    messages.push({
      at: +(performance.now() - t0).toFixed(1),
      type: String(type).slice(0, 60),
      portCount,
      // Prove we hold a real, usable MessagePort rather than a detached husk.
      portUsable: portCount > 0 && typeof ev.ports[0].postMessage === 'function',
      sameOrigin: ev.origin === location.origin,
      listenersRegisteredBefore: registrations.length - 1,
    });
  });
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
await page.send('Page.enable');

const { identifier } = await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: HOOK,
  runImmediately: false,
});

// A reload is not a click: the app re-runs its whole ~8.5s bootstrap, so give it
// room before reading the log.
await page.send('Page.reload', { ignoreCache: false });
await page.once('Page.loadEventFired', { timeoutMs: 60_000 }).catch(() => null);
await new Promise((r) => setTimeout(r, waitSeconds * 1000));

const read = await page.send('Runtime.evaluate', {
  expression: `(() => {
    const p = window.__probe3;
    if (!p) return { installed: false };
    return {
      installed: true,
      messageListenerRegistrations: p.registrations.length,
      weRegisteredFirst: p.registrations.length > 0,
      ourRegistrationIndex: 0,
      otherRegistrations: p.registrations.slice(1, 6),
      messages: p.messages,
      bridgePresent: !!window.electronBridge,
      trusted: (() => { try { return typeof window.electronBridge.getSentryInitOptions() === 'object'; } catch { return null; } })(),
      readyState: document.readyState,
    };
  })()`,
  returnByValue: true,
});

const r = read.result?.value ?? {};
const portMessages = (r.messages ?? []).filter((m) => m.portCount > 0);
const verdict = !r.installed
  ? 'HOOK DID NOT RUN -- addScriptToEvaluateOnNewDocument never executed'
  : portMessages.length === 0
    ? 'NO PORT SEEN -- the handshake did not reach the main world during the window'
    : portMessages.some((m) => m.listenersRegisteredBefore === 0 && m.portUsable)
      ? 'INTERCEPTABLE -- we hold a usable port and no page listener ran before us'
      : 'OBSERVED BUT NOT FIRST -- a page listener was registered ahead of ours';

await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {});

process.stdout.write(JSON.stringify({ verdict, target: (target.url ?? '').slice(0, 90), ...r }, null, 2) + '\n');
cdp.close();
