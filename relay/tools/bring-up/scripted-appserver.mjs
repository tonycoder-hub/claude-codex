#!/usr/bin/env node
/**
 * A scripted app-server: real JSON-RPC over NDJSON on stdio, scripted answers.
 *
 * `bin/imrelay.mjs --replay` needs something on the other end of
 * `AppServerClient`. A fake client object would have been less code, but it
 * would also have skipped the parts most likely to be wrong: the NDJSON
 * framing, the id correlation, and the notification fan-out. This process
 * speaks the real wire format, so the only thing scripted is what a turn
 * *says* -- the path it travels is the production path.
 *
 * What is deliberately NOT claimed: these are not the app-server's verified
 * parameter spellings. `src/imrelay/projection.mjs` documents that the
 * lifecycle notifications are unverified and reads both the flat and the
 * nested form; this process emits the nested form, which is the one that
 * projection's `readTurn` actually requires. If the real app-server differs,
 * the projection is where that is absorbed, not here.
 *
 * Diagnostics go to stderr. Stdout is NDJSON and nothing else -- a stray
 * `console.log` here corrupts the stream for the client.
 *
 * Env:
 *   IMRELAY_SCRIPT_DELAY_MS  ms between deltas (default 90)
 *   IMRELAY_SCRIPT_REPLY     override the reply text for every turn
 */
import { createInterface } from 'node:readline';

const DELAY_MS = Number(process.env.IMRELAY_SCRIPT_DELAY_MS ?? 90);
const OVERRIDE = process.env.IMRELAY_SCRIPT_REPLY ?? null;

let threads = 0;
let turns = 0;
let items = 0;

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });
const notify = (method, params) => write({ jsonrpc: '2.0', method, params });
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * What a turn says. Scripted, but shaped like a real answer: a short
 * acknowledgement that quotes the prompt, so a transcript or a video frame
 * shows that the text on the card came from the text in the chat.
 */
function scriptFor(input) {
  if (OVERRIDE !== null) return OVERRIDE;
  const asked = String(input ?? '').trim();
  return [
    `收到：「${asked}」。`,
    '这条回复由常驻 Mac 上的 Claude Code 产生，',
    '经 app-server 的 JSON-RPC 流式推送，',
    '再由 relay 折叠成一张会自己长大的卡片。',
    '每个 delta 都是一次 streamText，卡片外壳只在状态真的变了时才重写。',
  ].join('');
}

/** Stream one turn's worth of notifications for a thread. */
async function runTurn(threadId, turnId, input) {
  const itemId = `it_${++items}`;
  notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
  notify('item/started', { threadId, item: { id: itemId, itemType: 'agentMessage' } });

  // The streaming shape: `{ itemId, delta }`, carrying no thread id at all.
  // Routing this is what item ownership in the daemon is for.
  const text = scriptFor(input);
  for (const chunk of text.match(/[\s\S]{1,12}/g) ?? []) {
    await sleep(DELAY_MS);
    notify('item/agentMessage/delta', { itemId, delta: chunk });
  }

  await sleep(DELAY_MS);
  notify('item/completed', { threadId, item: { id: itemId, itemType: 'agentMessage', text } });
  notify('thread/tokenUsage/updated', { threadId, usage: { inputTokens: 1200, outputTokens: text.length } });
  notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
}

const pending = [];
let draining = false;

/** Turns run one at a time per process, in arrival order. */
async function drain() {
  if (draining) return;
  draining = true;
  while (pending.length > 0) {
    const job = pending.shift();
    try {
      await runTurn(job.threadId, job.turnId, job.input);
    } catch (error) {
      process.stderr.write(`scripted-appserver: turn failed: ${error?.message ?? error}\n`);
    }
  }
  draining = false;
}

function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      return reply(id, { serverInfo: { name: 'scripted-appserver', version: '0.0.0' } });
    case 'thread/start':
      return reply(id, { threadId: `th_${++threads}` });
    case 'thread/resume':
      return reply(id, { threadId: params?.threadId ?? `th_${++threads}` });
    case 'turn/start': {
      const threadId = params?.threadId ?? null;
      if (threadId === null) return fail(id, -32602, 'turn/start needs a threadId');
      const turnId = `tn_${++turns}`;
      reply(id, { turnId });
      // Queued, not awaited: the response has to go out before the stream, or
      // the client folds notifications for a turn it has not been told about.
      pending.push({ threadId, turnId, input: params?.input ?? '' });
      void drain();
      return undefined;
    }
    case 'turn/interrupt':
      return reply(id, {});
    default:
      if (id === undefined) return undefined;   // a notification we ignore
      return fail(id, -32601, `scripted-appserver does not implement ${method}`);
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const text = line.trim();
  if (text === '') return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    process.stderr.write(`scripted-appserver: undecodable line: ${text.slice(0, 120)}\n`);
    return;
  }
  try {
    handle(message);
  } catch (error) {
    process.stderr.write(`scripted-appserver: ${error?.message ?? error}\n`);
    if (message?.id !== undefined) fail(message.id, -32603, String(error?.message ?? error));
  }
});

process.stdin.on('end', () => process.exit(0));
