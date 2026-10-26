#!/usr/bin/env node
/**
 * The IM relay, run as a process.
 *
 * Everything under `src/imrelay/` was correct parts with nothing composing
 * them. `daemon.mjs` composes them; this file is what you can actually run,
 * and what you can watch while it runs.
 *
 * Two modes, and the difference between them is the whole point:
 *
 *   --replay <file>   A real `Relay`, real gate, real dispatcher, real
 *                     projection, real card rendering, and a real
 *                     `AppServerClient` speaking JSON-RPC over NDJSON to
 *                     `tools/bring-up/scripted-appserver.mjs`. Inbound events
 *                     come from a file instead of a socket; outbound HTTP is
 *                     rendered by the production `toHttpRequest()` and printed
 *                     instead of sent. Nothing touches the network.
 *
 *   --live            Refuses, and says exactly what is missing. There is no
 *                     Lark long-connection client and no outbound HTTP sender
 *                     in this repo: `transport.mjs` *describes* the wire
 *                     protocol (`LARK_WS`, `toHttpRequest`,
 *                     `describeTokenExchange`) and its default sink refuses
 *                     everything on purpose. A `--live` that quietly ran in
 *                     replay mode would be the worst possible outcome, because
 *                     it would look like it worked.
 *
 * The transcript is the deliverable. A relay whose behaviour you cannot see is
 * a relay you cannot trust, and the failure shape this project keeps hitting is
 * a green check whose right-hand side is weaker than the claim it implies -- a
 * card that streams nothing, a notice sent to a guessed chat. So this prints
 * every inbound intent, every RPC, every outbound op with the HTTP request it
 * would become, and every recorded failure.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { InboundGate } from '../src/imrelay/inbound.mjs';
import { Dispatcher } from '../src/imrelay/dispatch.mjs';
import { DraftBook } from '../src/imrelay/digest.mjs';
import { OPS, allowlistSink, toHttpRequest } from '../src/imrelay/transport.mjs';
import { Relay, harnessConnection } from '../src/imrelay/daemon.mjs';
import { AppServerClient } from '../src/appserver/client.mjs';
import { createStdioTransport } from '../src/appserver/transport-stdio.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTED = path.join(HERE, '..', 'tools', 'bring-up', 'scripted-appserver.mjs');

const USAGE = `usage: imrelay --replay <file.jsonl> [options]
       imrelay --live

  --replay <file>       inbound events to replay (JSONL)
  --chats a,b           chat allow-list (default: every chat named in the file)
  --require-command     only act on /ai (the OpenLark dispatch affordance)
  --lane-by chat|thread one session per chat, or one per message thread
  --end <id>            the resident end's id (default mac-resident)
  --delay-ms <n>        app-server delta interval (default 90)
  --poll-ms <n>         relay tick interval (default 50)
  --no-colour           plain output
  --json                emit the transcript as JSONL instead of text
  --live                refuse, and say what is missing

A replay line is either a full Lark event envelope, or the shorthand
  {"at": 0, "chat": "oc_demo", "from": "zhang", "text": "/ai have a look"}
where "at" is milliseconds from the start of the run.`;

// -- arguments ---------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    replay: null, chats: null, requireCommand: false, laneBy: 'chat',
    end: 'mac-resident', delayMs: 90, pollMs: 50, colour: true, json: false,
    live: false, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--replay': out.replay = next(); break;
      case '--chats': out.chats = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--require-command': out.requireCommand = true; break;
      case '--lane-by': out.laneBy = next(); break;
      case '--end': out.end = next(); break;
      case '--delay-ms': out.delayMs = Number(next()); break;
      case '--poll-ms': out.pollMs = Number(next()); break;
      case '--no-colour': case '--no-color': out.colour = false; break;
      case '--json': out.json = true; break;
      case '--live': out.live = true; break;
      case '-h': case '--help': out.help = true; break;
      default: throw new Error(`unknown argument ${arg}`);
    }
  }
  if (out.laneBy !== 'chat' && out.laneBy !== 'thread') {
    throw new Error('--lane-by must be chat or thread');
  }
  return out;
}

/**
 * What `--live` would need. Data, not prose, so it stays honest: each entry
 * names the thing that does not exist and where its absence is documented.
 */
const MISSING_FOR_LIVE = Object.freeze([
  ['a Lark long-connection client',
    'src/imrelay/transport.mjs describes the handshake (LARK_WS) but opens no socket'],
  ['an outbound sender for anything but a plain send',
    'src/imrelay/feishu-sink.mjs can post a message through the feishu-lark CLI, '
    + 'and throws for all four CardKit ops because that CLI registers none'],
  ['credentials',
    'describeTokenExchange() names the tenant fields and nothing here stores them; '
    + 'the user route keeps its token in the laptop Keychain, behind tools/bring-up/feishu-shim.mjs'],
  ['a chat the relay may write to',
    'internal group chats are read-only for this project; docs/14-feishu-send.md '
    + 'is the user-operated setup for a group that is not'],
]);

function refuseLive(write) {
  write('--live is not implemented, and will not pretend to be.\n\nWhat is missing:\n');
  for (const [what, why] of MISSING_FOR_LIVE) write(`  - ${what}\n      ${why}\n`);
  write('\nWhat does work: --replay runs the real relay end to end against a\n');
  write('scripted app-server, and prints the HTTP each outbound op would become.\n');
  return 2;
}

// -- the replay script -------------------------------------------------------

let eventSeq = 0;
let messageSeq = 0;

/**
 * The shorthand, expanded into a real `im.message.receive_v1` envelope. The
 * gate parses the real thing, so the shorthand has to become the real thing
 * here rather than the gate learning a second input shape.
 */
function envelopeFor(line) {
  if (line.header && line.event) return line;            // already an envelope
  const message = {
    message_id: line.messageId ?? `om_${++messageSeq}`,
    chat_id: line.chat,
    chat_type: 'group',
    message_type: 'text',
    content: JSON.stringify({ text: line.text ?? '' }),
    mentions: [],
  };
  if (line.thread) message.thread_id = line.thread;
  return {
    schema: '2.0',
    header: {
      event_id: line.eventId ?? `ev_${++eventSeq}`,
      event_type: 'im.message.receive_v1',
      create_time: String(Date.now()),
      token: 'replay',
      app_id: 'replay',
      tenant_key: 'replay',
    },
    event: {
      sender: { sender_id: { open_id: line.openId ?? 'ou_replay' }, sender_type: 'user' },
      message,
    },
  };
}

async function loadScript(file) {
  const text = await readFile(file, 'utf8');
  const lines = [];
  for (const [index, raw] of text.split('\n').entries()) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    try {
      lines.push(JSON.parse(trimmed));
    } catch (error) {
      throw new Error(`${file}:${index + 1} is not JSON: ${error.message}`);
    }
  }
  return lines;
}

/** Every chat the script mentions, for the default allow-list. */
function chatsIn(lines) {
  const chats = new Set();
  for (const line of lines) {
    const id = line.chat ?? line?.event?.message?.chat_id ?? null;
    if (typeof id === 'string' && id !== '') chats.add(id);
  }
  return [...chats];
}

// -- the transcript ----------------------------------------------------------

const PAINT = {
  dim: (s) => `\u001b[2m${s}\u001b[0m`,
  bold: (s) => `\u001b[1m${s}\u001b[0m`,
  green: (s) => `\u001b[32m${s}\u001b[0m`,
  cyan: (s) => `\u001b[36m${s}\u001b[0m`,
  yellow: (s) => `\u001b[33m${s}\u001b[0m`,
  red: (s) => `\u001b[31m${s}\u001b[0m`,
};
const PLAIN = Object.fromEntries(Object.keys(PAINT).map((k) => [k, (s) => s]));

function makeTranscript({ colour, json, started, write }) {
  // `--json` is a machine-readable mode, so it is never painted whatever
  // --colour says; an escape inside a JSON string value is still an escape.
  const c = colour && !json ? PAINT : PLAIN;
  const stamp = (at) => (at / 1000).toFixed(2).padStart(7, ' ');
  return {
    // Exposed so callers that build part of a line can tint it through the
    // same switch. One did not: it wrote the escape for dim inline, so
    // --no-colour emitted a plain transcript with ANSI still in it.
    dim: c.dim,
    line(channel, text, tint = 'dim') {
      const at = Date.now() - started;
      if (json) {
        write(`${JSON.stringify({ at, channel, text })}\n`);
        return;
      }
      write(`${c.dim(stamp(at))}  ${c[tint](channel.padEnd(7))} ${text}\n`);
    },
  };
}

/** One line per outbound op, with the HTTP request it would actually become. */
function describeOp(op) {
  let http = null;
  try {
    const request = toHttpRequest(op);
    http = `${request.method} ${request.path}`;
  } catch (error) {
    http = `(no HTTP mapping: ${error?.message ?? error})`;
  }
  switch (op.op) {
    case OPS.createCardEntity:
      return [`create card for ${op.forChat}`, http];
    case OPS.sendMessage: {
      const body = op.msgType === 'interactive'
        ? `card ${op.content?.data?.card_id}`
        : JSON.stringify(op.content?.text ?? op.content);
      return [`send ${op.msgType} to ${op.receiveId}${op.replyTo ? ` (reply to ${op.replyTo})` : ''}: ${body}`, http];
    }
    case OPS.streamText:
      return [`stream seq=${op.sequence} ${JSON.stringify(op.content ?? '')}`, http];
    case OPS.updateCardEntity:
      return [`rewrite shell seq=${op.sequence}`, http];
    default:
      return [`${op.op}`, http];
  }
}

// -- the sink ----------------------------------------------------------------

/**
 * The innermost sink: prints, and answers plausibly. It never sends.
 *
 * It sits *inside* `allowlistSink`, so an op for a chat that is not on the
 * list is refused before it reaches here and never appears in the transcript
 * as if it had gone out. The refusal surfaces through the relay's own failure
 * list instead, which is where a reader should look for it.
 */
function printingSink(transcript) {
  let cards = 0;
  const ops = [];
  return {
    ops,
    sealed: false,
    async perform(op) {
      ops.push(op);
      const [what, http] = describeOp(op);
      transcript.line('out', `${what}  ${http === null ? '' : transcript.dim(http)}`, 'green');
      if (op.op === OPS.createCardEntity) {
        return { code: 0, msg: 'success', data: { card_id: `c_${++cards}` } };
      }
      return { code: 0, msg: 'success', data: {} };
    },
  };
}

// -- the run -----------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function run(options, write) {
  const started = Date.now();
  const transcript = makeTranscript({ colour: options.colour, json: options.json, started, write });

  const script = await loadScript(options.replay);
  if (script.length === 0) throw new Error(`${options.replay} has no events in it`);
  const chats = options.chats ?? chatsIn(script);
  if (chats.length === 0) throw new Error('no chats: pass --chats, or use the shorthand which names them');

  transcript.line('relay', `chats ${chats.join(', ')}  lane-by ${options.laneBy}`
    + `  ${options.requireCommand ? 'requires /ai' : 'answers everything'}`, 'bold');

  // The app-server: a real client over a real NDJSON transport, to a scripted
  // peer. The only scripted thing is what a turn says.
  const child = spawn(process.execPath, [SCRIPTED], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, IMRELAY_SCRIPT_DELAY_MS: String(options.delayMs) },
  });
  const transport = createStdioTransport(child, {
    onError: (error) => transcript.line('rpc', `transport: ${error?.message ?? error}`, 'red'),
  });
  const client = new AppServerClient(transport, {
    onProtocolError: (error) => transcript.line('rpc', `protocol: ${error?.message ?? error}`, 'red'),
  });

  // Wrap `call` so the transcript shows the round trip. The relay is handed
  // this object, so what is logged is exactly what the relay asked for.
  const rawCall = client.call.bind(client);
  const traced = {
    on: client.on.bind(client),
    async call(method, params) {
      transcript.line('rpc', `-> ${method} ${JSON.stringify(params ?? {})}`, 'cyan');
      const result = await rawCall(method, params);
      transcript.line('rpc', `<- ${method} ${JSON.stringify(result ?? {})}`, 'cyan');
      return result;
    },
  };

  const inner = printingSink(transcript);
  // The CLI owns the ingress: `Relay` keeps its connection private, and a
  // getter for it would exist only so this file could reach back in.
  const connection = harnessConnection();
  const relay = new Relay({
    gate: new InboundGate({ chats, laneBy: options.laneBy, requireCommand: options.requireCommand }),
    dispatcher: new Dispatcher(),
    drafts: new DraftBook({ chats }),
    sink: allowlistSink({ inner, chats }),
    client: traced,
    connection,
    now: () => Date.now(),
    fetchEnds: async () => [{ end: options.end, busy: false }],
    log: (entry) => {
      if (entry.what === 'card') return;        // the sink already printed it
      const { what, ...rest } = entry;
      transcript.line('relay', `${what} ${JSON.stringify(rest)}`);
    },
  });

  await relay.start();
  await relay.tick(Date.now());                 // observeEnds, so a lane is schedulable

  // Deliver on the script's own schedule.
  let delivered = 0;
  const deliveries = script.map(async (line) => {
    await sleep(Math.max(0, Number(line.at ?? 0)));
    const envelope = envelopeFor(line);
    const who = line.from ? `${line.from}: ` : '';
    transcript.line('in', `${envelope.event.message.chat_id}  ${who}${line.text ?? '(envelope)'}`, 'yellow');
    connection.deliver(envelope);
    delivered += 1;
  });

  // Tick until the script is exhausted and nothing is left in flight. The
  // deadline is a backstop, not the normal exit: a relay that will not settle
  // is a result worth printing, not a hang worth waiting out.
  const deadline = Date.now() + 120000;
  let quiet = 0;
  for (;;) {
    await sleep(options.pollMs);
    await relay.tick(Date.now());
    const snapshot = relay.snapshot();
    const busy = snapshot.queued > 0
      || snapshot.lanes.some((lane) => lane.pending !== null || lane.status === 'pending');
    if (delivered === script.length && !busy) {
      quiet += 1;
      if (quiet >= 6) break;                    // settled for ~6 polls running
    } else {
      quiet = 0;
    }
    if (Date.now() > deadline) {
      transcript.line('relay', 'deadline reached with work still in flight', 'red');
      break;
    }
  }
  await Promise.all(deliveries);
  await relay.drainCards(Date.now());

  const failures = relay.failures;
  const lanes = relay.snapshot().lanes;
  transcript.line('relay', `settled: ${lanes.length} lane(s), ${inner.ops.length} outbound op(s), `
    + `${failures.length} failure(s)`, failures.length === 0 ? 'green' : 'red');
  for (const failure of failures) transcript.line('fail', `${failure.where}: ${failure.error}`, 'red');

  await relay.stop();
  client.close?.();
  child.kill();
  return failures.length === 0 ? 0 : 1;
}

// -- entry -------------------------------------------------------------------

async function main(argv) {
  const write = (text) => process.stdout.write(text);
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    write(`${USAGE}\n`);
    return 0;
  }
  if (options.live) return refuseLive(write);
  if (options.replay === null) {
    process.stderr.write(`nothing to do: pass --replay <file> or --live\n\n${USAGE}\n`);
    return 2;
  }
  try {
    return await run(options, write);
  } catch (error) {
    process.stderr.write(`imrelay: ${error?.stack ?? error}\n`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
