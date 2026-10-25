#!/usr/bin/env node
// Drive the minimal app-server vertical slice over a WebSocket transport:
//   initialize -> thread/start -> turn/start -> stream item/* -> turn/completed
//
// This exists to settle one question with evidence rather than reading: can a
// plain client outside the Codex App hold a real conversation over the
// app-server protocol? Everything the relay does later is this, plus auth and
// an ingress.
//
// Authored on the dev host, executed on the resident Mac — the adapter is the
// only thing that can reach Claude Code, and it only runs there. The instance
// it talks to must always be an isolated one (its own CLAUDE_CODEX_HOME and a
// ws:// port); pointing this at the production daemon would let that process's
// startup recovery mark live turns `interrupted`.

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};

const url = arg('--url', 'ws://127.0.0.1:8899');
const prompt = arg('--prompt', 'Reply with exactly: slice-ok');
const model = arg('--model');
const cwd = arg('--cwd', process.cwd());
const timeoutMs = Number(arg('--timeout', '120000'));
const verbose = args.includes('--verbose');
const approvalPolicy = arg('--approval-policy');
const sandboxMode = arg('--sandbox');

const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(6);
const log = (dir, text) => process.stdout.write(`${ms()}ms ${dir} ${text}\n`);

// Delta notifications arrive in the hundreds; printing each one buries the
// shape of the exchange. Coalesce them per method and report counts instead.
const deltaCounts = new Map();
const items = new Map();
const approvals = [];
let assistantText = '';

const ws = new WebSocket(url);
const pending = new Map();
let nextId = 1;

function call(method, params) {
  const id = nextId++;
  const frame = { jsonrpc: '2.0', id, method, params };
  log('→', `${method} ${JSON.stringify(params ?? {}).slice(0, 160)}`);
  ws.send(JSON.stringify(frame));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}

function reply(id, result) {
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

let settle;
const done = new Promise((resolve) => { settle = resolve; });

const timer = setTimeout(() => {
  log('!!', `timed out after ${timeoutMs}ms`);
  settle({ ok: false, reason: 'timeout' });
}, timeoutMs);
timer.unref?.();

ws.addEventListener('open', async () => {
  log('..', `connected ${url}`);
  try {
    const init = await call('initialize', {
      clientInfo: { name: 'codex-relay-web-probe', version: '0.0.1' },
      capabilities: {},
    });
    log('←', `initialize ${JSON.stringify(init)}`);

    const thread = await call('thread/start', model ? { model, cwd } : { cwd });
    const threadId = thread?.thread?.id ?? thread?.id ?? thread?.threadId;
    log('←', `thread/start id=${threadId} keys=[${Object.keys(thread ?? {}).join(',')}]`);
    if (!threadId) {
      settle({ ok: false, reason: 'thread/start returned no id' });
      return;
    }

    const turn = await call('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt }],
      cwd,
      ...(approvalPolicy ? { approvalPolicy } : {}),
      ...(sandboxMode ? { sandboxMode } : {}),
    });
    log('←', `turn/start ${JSON.stringify(turn).slice(0, 200)}`);
  } catch (error) {
    log('!!', `request failed: ${error?.message ?? error}`);
    settle({ ok: false, reason: String(error?.message ?? error) });
  }
});

ws.addEventListener('message', (event) => {
  let msg;
  try {
    msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
  } catch {
    log('!!', 'unparseable frame');
    return;
  }

  // A response to something we sent.
  if (msg.id != null && (msg.result !== undefined || msg.error !== undefined) && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(`${msg.error.code}: ${msg.error.message}`)) : resolve(msg.result);
    return;
  }

  // A request *from* the server — this is how approvals arrive. Auto-approving
  // here is only safe because the slice runs a prompt we chose; a real client
  // must put this in front of a human.
  if (msg.id != null && msg.method) {
    // The adapter's normalizeDecision() accepts only
    // accept | acceptForSession | decline | cancel and silently coerces
    // anything else to 'decline' — a wrong value here looks like a working
    // round-trip while actually refusing every tool call.
    const available = msg.params?.availableDecisions;
    if (msg.method === 'item/tool/requestUserInput') {
      const questions = msg.params?.questions ?? [];
      log('⇠', `REQUEST ${msg.method} (${questions.length} question(s)) -> answering 'Other'`);
      reply(msg.id, { answers: questions.map(() => ({ option: 'Other', text: 'slice-probe' })) });
      return;
    }
    log('⇠', `REQUEST ${msg.method} available=${JSON.stringify(available ?? null)} -> accept`);
    approvals.push({ method: msg.method, command: msg.params?.command ?? null });
    reply(msg.id, { decision: 'accept' });
    return;
  }

  const method = msg.method ?? '(no method)';
  const isDelta = /Delta$|delta$/.test(method);
  if (isDelta) {
    deltaCounts.set(method, (deltaCounts.get(method) ?? 0) + 1);
    if (method === 'item/agentMessage/delta') {
      assistantText += msg.params?.delta ?? msg.params?.text ?? '';
    }
    if (verbose) log('⇠', `${method} ${JSON.stringify(msg.params).slice(0, 120)}`);
    return;
  }

  if (method === 'item/started' || method === 'item/completed') {
    const item = msg.params?.item ?? msg.params;
    const kind = item?.type ?? item?.itemType ?? '?';
    items.set(`${item?.id}:${method}`, kind);
    log('⇠', `${method} type=${kind} id=${item?.id ?? '?'}`);
    return;
  }

  log('⇠', `${method} ${JSON.stringify(msg.params ?? {}).slice(0, 180)}`);

  if (method === 'turn/completed') settle({ ok: true, params: msg.params });
  if (method === 'turn/failed' || method === 'error') settle({ ok: false, reason: method });
});

ws.addEventListener('error', () => {
  log('!!', 'websocket error');
  settle({ ok: false, reason: 'websocket error' });
});
ws.addEventListener('close', (e) => {
  log('..', `closed code=${e.code}`);
  settle({ ok: false, reason: `closed ${e.code}` });
});

const outcome = await done;
clearTimeout(timer);

process.stdout.write('\n--- slice summary ---\n');
process.stdout.write(`outcome: ${outcome.ok ? 'TURN COMPLETED' : 'FAILED (' + outcome.reason + ')'}\n`);
process.stdout.write(`elapsed: ${Date.now() - t0}ms\n`);
process.stdout.write(`items seen: ${[...new Set([...items.values()])].join(', ') || '(none)'}\n`);
for (const [m, n] of [...deltaCounts].sort()) process.stdout.write(`deltas: ${m} x${n}\n`);
process.stdout.write(`reverse approval requests: ${approvals.length}\n`);
for (const a of approvals) process.stdout.write(`  ${a.method} command=${JSON.stringify(a.command)}\n`);
if (assistantText) {
  process.stdout.write(`assistant text (${assistantText.length} chars): ${JSON.stringify(assistantText.slice(0, 300))}\n`);
}
try { ws.close(); } catch {}
process.exit(outcome.ok ? 0 : 1);
