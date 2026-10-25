#!/usr/bin/env node
// Read the host bridge out of a live Codex window.
//
// The point is the trust signal. isTrustedIpcSender gates the synchronous
// bootstrap getters on the sender's webContents.id being in the window manager's
// private registry; an unregistered sender is not refused loudly, it is handed
// null / {} / 'light' / false. So "getSentryInitOptions() returned an object" is
// the cheapest reliable way to tell a trusted window from one the host is
// quietly ignoring -- and the renderer's own first unguarded deref of that value
// is what turns the untrusted case into a blank screen.
//
// Reports shapes, key names and booleans. Never values: the sentry options carry
// a DSN, and the sidebar bootstrap carries thread content.
//
//   node bridge-readout.mjs [port] [--url-contains <substr>]

import { Cdp, waitForEndpoint } from '../src/cdp/client.mjs';

const port = Number(process.argv[2] ?? 19333);
const i = process.argv.indexOf('--url-contains');
const urlNeedle = i === -1 ? 'index.html' : process.argv[i + 1];

const READOUT = `(() => {
  const shape = (v) => {
    if (v === null) return { kind: 'null' };
    if (v === undefined) return { kind: 'undefined' };
    if (Array.isArray(v)) return { kind: 'array', length: v.length };
    if (typeof v === 'object') return { kind: 'object', keys: Object.keys(v).slice(0, 40) };
    if (typeof v === 'string') return { kind: 'string', length: v.length, empty: v === '' };
    return { kind: typeof v, value: typeof v === 'boolean' ? v : undefined };
  };
  const call = (name, ...args) => {
    const b = window.electronBridge;
    if (!b || typeof b[name] !== 'function') return { kind: 'missing' };
    try { return shape(b[name](...args)); }
    catch (err) { return { kind: 'threw', message: String(err && err.message || err).slice(0, 160) }; }
  };
  const b = window.electronBridge;
  return {
    href: location.href,
    codexWindowType: window.codexWindowType ?? null,
    bridgePresent: !!b,
    bridgeMembers: b ? Object.keys(b).sort() : [],
    bridgeFunctionCount: b ? Object.keys(b).filter((k) => typeof b[k] === 'function').length : 0,
    sync: {
      getSentryInitOptions: call('getSentryInitOptions'),
      getBuildFlavor: call('getBuildFlavor'),
      getSystemThemeVariant: call('getSystemThemeVariant'),
      getInitialSidebarBootstrap: call('getInitialSidebarBootstrap'),
      getAppSessionId: call('getAppSessionId'),
      getDesktopUserAgent: call('getDesktopUserAgent'),
      getPreloadStartedAtMs: call('getPreloadStartedAtMs'),
      windowType: shape(b && b.windowType),
    },
    // getSystemThemeVariant feeds a useSyncExternalStore getSnapshot, so a shim
    // that returns a fresh value each call re-renders forever. Check stability.
    themeGetterStable: (() => {
      if (!b || typeof b.getSystemThemeVariant !== 'function') return null;
      try { return Object.is(b.getSystemThemeVariant(), b.getSystemThemeVariant()); }
      catch { return null; }
    })(),
    documentThemeAttr: document.documentElement.dataset.theme ?? null,
    readyState: document.readyState,
    bodyChildCount: document.body ? document.body.childElementCount : 0,
    // Did the renderer actually paint, or is it a blank shell?
    rootHasContent: (() => {
      const r = document.getElementById('root') || document.body;
      return !!r && r.innerHTML.length > 200;
    })(),
  };
})()`;

const version = await waitForEndpoint(port, { timeoutMs: 30_000 });
const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
const { targetInfos } = await cdp.send('Target.getTargets');

const pages = targetInfos.filter((t) => t.type === 'page' && (t.url ?? '').includes(urlNeedle));
if (!pages.length) {
  process.stderr.write(`no page target whose url contains ${JSON.stringify(urlNeedle)}\n`);
  process.exit(1);
}

const out = [];
for (const t of pages) {
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId: t.targetId, flatten: true,
  });
  const page = cdp.session(sessionId);
  try {
    const res = await page.send('Runtime.evaluate', {
      expression: READOUT, returnByValue: true, awaitPromise: false,
    });
    out.push({
      targetId: t.targetId,
      url: (t.url ?? '').slice(0, 110),
      readout: res.exceptionDetails
        ? { threw: res.exceptionDetails.text, detail: res.exceptionDetails.exception?.description?.slice(0, 300) }
        : res.result.value,
    });
  } catch (err) {
    out.push({ targetId: t.targetId, url: t.url, error: err.message });
  } finally {
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

// The single judgement this probe exists to make.
const verdicts = out.map((o) => {
  const s = o.readout?.sync;
  const trusted = s?.getSentryInitOptions?.kind === 'object';
  return {
    url: o.url,
    trustedSender: trusted,
    reason: trusted
      ? 'getSentryInitOptions returned an object'
      : `getSentryInitOptions was ${s?.getSentryInitOptions?.kind ?? 'unreadable'}`,
  };
});

process.stdout.write(JSON.stringify({ verdicts, detail: out }, null, 2) + '\n');
cdp.close();
