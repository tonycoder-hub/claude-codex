#!/usr/bin/env node
// What is actually attachable on a Codex instance's debugging port.
//
// /json/list is not the authoritative answer for Electron -- it reports the
// default browser context, and app windows can be absent from it while very much
// alive. Target.getTargets over the browser socket is the real inventory.
//
//   node inspect-targets.mjs [port] [--watch seconds]

import { Cdp, waitForEndpoint } from '../src/cdp/client.mjs';

const port = Number(process.argv[2] ?? 19333);
const watchIdx = process.argv.indexOf('--watch');
const watchSeconds = watchIdx === -1 ? 0 : Number(process.argv[watchIdx + 1] ?? 10);

const brief = (t) => ({
  type: t.type,
  title: t.title,
  url: (t.url ?? '').slice(0, 110),
  targetId: t.targetId,
  attached: t.attached,
  canAccessOpener: t.canAccessOpener,
  browserContextId: t.browserContextId,
});

const version = await waitForEndpoint(port, { timeoutMs: 30_000 });
const cdp = await Cdp.connect(version.webSocketDebuggerUrl);

const { targetInfos } = await cdp.send('Target.getTargets');
process.stdout.write(JSON.stringify({
  browser: version.Browser,
  targetCount: targetInfos.length,
  targets: targetInfos.map(brief),
  byType: targetInfos.reduce((a, t) => ({ ...a, [t.type]: (a[t.type] ?? 0) + 1 }), {}),
}, null, 2) + '\n');

if (watchSeconds > 0) {
  const seen = [];
  cdp.on('Target.targetCreated', (p) => seen.push({ at: 'created', ...brief(p.targetInfo) }));
  cdp.on('Target.targetInfoChanged', (p) => seen.push({ at: 'changed', ...brief(p.targetInfo) }));
  cdp.on('Target.targetDestroyed', (p) => seen.push({ at: 'destroyed', targetId: p.targetId }));
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  await new Promise((r) => setTimeout(r, watchSeconds * 1000));
  process.stdout.write(`\n--- ${watchSeconds}s of target events ---\n` +
    JSON.stringify(seen, null, 2) + '\n');
}

cdp.close();
