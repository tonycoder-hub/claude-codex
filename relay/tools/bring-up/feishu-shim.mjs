#!/usr/bin/env node
/**
 * The last hop: a loopback HTTP endpoint that runs `feishu-lark` for the relay.
 *
 * ## Why this process exists at all
 *
 * The relay runs on the development host. The credential does not. `feishu-lark`
 * keeps its user access token in the macOS Keychain (`security
 * add-generic-password`), obtained by an OAuth device flow that needs a person
 * to press a button in a browser. Moving that to the development host would mean
 * either copying a user token across machines or re-running the device flow
 * there, and the development host is not where the person is.
 *
 * So the sink stays on the laptop. `ssh -R` makes a laptop-side loopback port
 * reachable from the development host, the relay's `feishuSink` posts to it, and
 * this process is what answers.
 *
 *     ssh -N -o ExitOnForwardFailure=yes -R 18789:127.0.0.1:18789 <dev-host>
 *
 * The alternative -- install the CLI on the development host and let the relay
 * call it directly -- was not taken. The package is not on the public registry
 * (`npm view` 404s), so it would have to be copied as a directory, and the token
 * would then live on a shared machine in `~/.local/share/...` instead of in the
 * laptop's Keychain. One `ssh -R` is less to own than a second copy of someone's
 * credential.
 *
 * ## Why a subprocess per send, and not the MCP server
 *
 * `feishu-lark serve` speaks MCP over stdio, and that route has two real
 * advantages: arguments go through the tool's zod schema (so a malformed call is
 * a typed error rather than the string `undefined`), and nothing lands in
 * `argv`. It was still not chosen, because it needs a long-lived child, request
 * correlation, and a restart policy -- three pieces of machinery whose failure
 * modes are harder to see than the one this route has. `feishu-lark call` is
 * stateless: a wedged call cannot wedge the next one, and its entire contract is
 * four observed stdout shapes, all four of which `readCliResult()` handles and
 * `test/imrelay/feishu-sink.test.mjs` exercises against a stub CLI.
 *
 * The cost is real and is not hidden: the chat id appears in the child's `argv`,
 * so any process on this machine can read it out of `ps` for the lifetime of the
 * call. `execFile` is used rather than a shell, so it never reaches a shell
 * history. It is accepted because this is the user's own laptop and the chat in
 * question is a group he created for himself.
 *
 * ## What guards it
 *
 * This is an unauthenticated local endpoint that can post into a person's chat,
 * so three things gate it and none of them have defaults:
 *
 *   1. It binds `127.0.0.1` only. There is no flag to bind anything else.
 *   2. Every request must carry the nonce from `FEISHU_SHIM_NONCE`, compared
 *      with `timingSafeEqual`. No nonce in the environment, no server.
 *   3. `FEISHU_SHIM_CHATS` is an allowlist of chat ids, and an empty one permits
 *      nothing -- the same fuse `allowlistSink` is, repeated on this side so a
 *      bug on the relay side cannot be the only thing standing between a turn
 *      and the wrong group.
 *
 * Neither the nonce nor the chat ids are ever on the command line: they come
 * from the environment, which `ps` does not show to other users on macOS.
 *
 * ## Usage
 *
 *     FEISHU_SHIM_NONCE=... FEISHU_SHIM_CHATS=oc_... node feishu-shim.mjs --check
 *     FEISHU_SHIM_NONCE=... FEISHU_SHIM_CHATS=oc_... node feishu-shim.mjs
 *
 * `--check` validates the configuration and the CLI's reachability with a
 * read-only call and exits. It sends nothing.
 */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';

import { CLI_TOOL, NONCE_HEADER, readCliResult } from '../../src/imrelay/feishu-sink.mjs';

const DEFAULT_PORT = 18789;
const DEFAULT_CLI = 'feishu-lark';
/** A send that has not answered in this long is a send that did not happen. */
const CALL_TIMEOUT_MS = 15000;
/** Refuse a body big enough to be a mistake. A 30 KB card plus slack. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Read configuration from the environment. Values are never echoed.
 *
 * @param {object} env
 */
export function readConfig(env = process.env) {
  const nonce = env.FEISHU_SHIM_NONCE ?? '';
  if (nonce.length < 16) {
    throw new Error('FEISHU_SHIM_NONCE must be set to at least 16 characters');
  }
  const chats = (env.FEISHU_SHIM_CHATS ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (chats.length === 0) throw new Error('FEISHU_SHIM_CHATS must name at least one chat id');
  const port = Number(env.FEISHU_SHIM_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('FEISHU_SHIM_PORT must be a port number');
  }
  return {
    nonce,
    chats,
    port,
    cli: env.FEISHU_SHIM_CLI ?? DEFAULT_CLI,
    sendAs: env.FEISHU_SHIM_SEND_AS === 'bot' ? 'bot' : 'user',
  };
}

/**
 * Run one CLI invocation and say what happened.
 *
 * The exit code is read and then ignored for the success decision, on purpose:
 * `feishu-lark` 0.2.3 exits 0 for a successful send, for a business refusal, and
 * for arguments that matched no action. Only `readCliResult()` decides, and only
 * a parseable object with a non-empty string `message_id` is a send. The exit
 * code is kept in the diagnostic because a non-zero one means the CLI itself
 * fell over, which is a different problem from the platform saying no.
 *
 * @param {{cli: string, tool: string, args: object}} call
 * @param {Function} [exec] Injected for tests.
 */
export function runCli({ cli, tool, args }, exec = execFile) {
  return new Promise((resolve) => {
    exec(
      cli,
      ['call', tool, JSON.stringify(args)],
      { timeout: CALL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && typeof stdout !== 'string') {
          resolve({ ok: false, messageId: null, error: `the CLI could not be run: ${error.message}`, rateLimited: false });
          return;
        }
        const read = readCliResult(stdout);
        if (read.ok) {
          resolve({ ok: true, messageId: read.messageId, error: null, rateLimited: false });
          return;
        }
        // `killed` is how `execFile` reports its own timeout, and a timed-out
        // send is the one failure where the message may still have landed. The
        // relay's send `uuid` is what keeps the retry from duplicating it.
        const timedOut = error?.killed === true;
        const detail = [
          read.error,
          timedOut ? `(the CLI was killed after ${CALL_TIMEOUT_MS}ms)` : null,
          error && !timedOut ? `(exit ${String(error.code ?? error.signal)})` : null,
          typeof stderr === 'string' && stderr.trim() !== '' ? `(stderr: ${stderr.trim().slice(0, 200)})` : null,
        ].filter((part) => part !== null).join(' ');
        resolve({ ok: false, messageId: null, error: detail, rateLimited: read.rateLimited });
      },
    );
  });
}

/**
 * Decide whether a parsed request body may be executed.
 *
 * Separated from the server so the policy is testable without a socket. Returns
 * `null` when the call is permitted, or `{ status, error }` when it is not.
 */
export function screen(body, { chats, sendAs }) {
  if (body === null || typeof body !== 'object') return { status: 400, error: 'body must be a JSON object' };
  if (body.tool !== CLI_TOOL) return { status: 400, error: `this shim only runs ${CLI_TOOL}` };
  const args = body.args;
  if (args === null || typeof args !== 'object') return { status: 400, error: 'args must be an object' };
  if (args.action !== 'send') {
    // `reply` is refused here for the same reason `allowlistSink` refuses
    // `patchCard`: a message id does not name its chat, so there is no way to
    // check it against the allowlist. Permitting it would make the allowlist
    // bypassable by anything that can produce a message id.
    return { status: 403, error: `this shim only performs action "send", not ${JSON.stringify(args.action)}` };
  }
  if (args.receive_id_type !== 'chat_id') {
    return { status: 403, error: 'this shim only addresses chats, so receive_id_type must be chat_id' };
  }
  if (typeof args.receive_id !== 'string' || !chats.includes(args.receive_id)) {
    // The id is not echoed. A caller that got it wrong does not learn the right
    // one from the error, and the log line says only that it was unlisted.
    return { status: 403, error: 'receive_id is not on this shim\'s allowlist' };
  }
  if (typeof args.content !== 'string') {
    // The CLI passes `content` straight into the SDK, which wants a string. An
    // object here would be rejected by the platform in a way that reads like a
    // malformed card, so it is caught at the boundary where the cause is obvious.
    return { status: 400, error: 'content must be a JSON-serialised string' };
  }
  if (args.send_as !== sendAs) {
    return { status: 403, error: `this shim sends as "${sendAs}"` };
  }
  return null;
}

/**
 * Build the server. Does not listen.
 *
 * @param {object} config From `readConfig()`.
 * @param {object} [hooks]
 * @param {Function} [hooks.exec] Replaces `execFile`, for tests.
 * @param {Function} [hooks.log]
 */
export function createShim(config, { exec = execFile, log = () => {} } = {}) {
  const expected = Buffer.from(config.nonce, 'utf8');

  return createServer((request, response) => {
    const reply = (status, payload) => {
      const text = JSON.stringify(payload);
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      response.end(text);
    };

    if (request.method !== 'POST' || request.url !== '/send') {
      reply(404, { ok: false, error: 'POST /send' });
      return;
    }
    // Length-safe, constant-time. A length mismatch is answered without
    // comparing, which leaks the nonce's length and nothing else.
    const offered = Buffer.from(String(request.headers[NONCE_HEADER] ?? ''), 'utf8');
    if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) {
      log({ what: 'rejected', why: 'nonce' });
      reply(401, { ok: false, error: 'bad or missing nonce' });
      return;
    }

    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reply(413, { ok: false, error: 'body too large' });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', async () => {
      if (response.writableEnded) return;
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reply(400, { ok: false, error: 'body is not JSON' });
        return;
      }
      const refusal = screen(body, config);
      if (refusal !== null) {
        log({ what: 'refused', why: refusal.error });
        reply(refusal.status, { ok: false, error: refusal.error });
        return;
      }
      const outcome = await runCli({ cli: config.cli, tool: body.tool, args: body.args }, exec);
      log({ what: outcome.ok ? 'sent' : 'failed', error: outcome.error });
      // A business failure is a 502: the shim worked, the thing behind it said
      // no. The relay distinguishes on the body's `ok`, not on the status, so
      // this is for whoever is reading `curl` output.
      reply(outcome.ok ? 200 : 502, outcome.ok
        ? { ok: true, messageId: outcome.messageId }
        : { ok: false, error: outcome.error, rateLimited: outcome.rateLimited });
    });
  });
}

// -- entry -------------------------------------------------------------------

/**
 * Validate the configuration and prove the CLI answers, without sending.
 *
 * The read-only call is `feishu_chat get` on the first allowlisted chat, which
 * is the cheapest way to find out whether the stored token is alive *before* a
 * send discovers it is not -- the failure shape otherwise is an exit code of 0
 * and `{"error":"需要用户授权..."}` on stdout, arriving during a demo.
 */
async function check(config) {
  process.stdout.write(`  ok  nonce                      ${config.nonce.length} chars\n`);
  process.stdout.write(`  ok  allowlist                  ${config.chats.length} chat(s)\n`);
  process.stdout.write(`  ok  send_as                    ${config.sendAs}\n`);
  process.stdout.write(`  ok  port                       127.0.0.1:${config.port}\n`);

  const outcome = await new Promise((resolve) => {
    execFile(
      config.cli,
      ['call', 'feishu_chat', JSON.stringify({ action: 'get', chat_id: config.chats[0] })],
      { timeout: CALL_TIMEOUT_MS, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
  });
  if (outcome.error && typeof outcome.stdout !== 'string') {
    process.stderr.write(`  FAIL  cli                      ${outcome.error.message}\n`);
    return 1;
  }
  const text = String(outcome.stdout ?? '').trim();
  if (text === 'undefined' || text === '') {
    process.stderr.write('  FAIL  cli                      printed nothing usable; arguments matched no action\n');
    return 1;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    process.stderr.write(`  FAIL  cli                      not JSON: ${text.slice(0, 200)}\n`);
    return 1;
  }
  if (typeof parsed?.error === 'string') {
    process.stderr.write(`  FAIL  token                    ${parsed.error}\n`);
    return 1;
  }
  // Counts, never ids or names.
  const counts = readChatCounts(parsed);
  process.stdout.write(`  ok  chat reachable             user_count=${counts.users ?? '?'} bot_count=${counts.bots ?? '?'}\n`);
  if (!counts.solo) {
    process.stderr.write(
      '  FAIL  membership               this is not a chat with only you in it, or the counts could '
      + 'not be read; refusing to call the configuration usable\n',
    );
    return 1;
  }
  process.stdout.write('\n  OK  configuration is usable; nothing was sent\n');
  return 0;
}

/**
 * Pull the member counts out of a `feishu_chat get` payload.
 *
 * Two things here were wrong in the first version and both were invisible.
 *
 * The tool returns `JSON.stringify({ chat: res.data })` -- the counts are one
 * level down, under `chat`. Reading `parsed.user_count` therefore yielded
 * `undefined` every single time, printed as `?`, and the check still said OK.
 * That is the whole safety property of this mode reporting success on a
 * constant.
 *
 * And the counts come back from the platform as *strings* (`"1"`, `"0"`), so a
 * `=== 1` comparison is false for a chat that genuinely has one member. Both
 * spellings are accepted and compared numerically.
 *
 * Unreadable counts are NOT solo. "I could not check" must not render the same
 * as "I checked and it is fine" -- this mode exists so that a person can be
 * sure, before anything is sent, that the only recipient is themselves.
 */
export function readChatCounts(parsed) {
  const chat = parsed?.chat ?? parsed ?? {};
  const read = (value) => {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    return null;
  };
  const users = read(chat.user_count);
  const bots = read(chat.bot_count);
  // Strict on both halves. A bot in the chat is an app that receives every
  // message posted there, so "one human, unknown number of bots" is not the
  // thing the person was asked to create. A false FAIL here costs a glance at
  // the two counts printed directly above it; a false OK costs the guarantee.
  return Object.freeze({ users, bots, solo: users === 1 && bots === 0 });
}

async function main(argv) {
  let config;
  try {
    config = readConfig();
  } catch (error) {
    process.stderr.write(`feishu-shim: ${error.message}\n`);
    return 2;
  }
  if (argv.includes('--check')) return check(config);

  const server = createShim(config, {
    log: (entry) => process.stdout.write(`${JSON.stringify({ at: Date.now(), ...entry })}\n`),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // Loopback only. Not configurable: see the header.
    server.listen(config.port, '127.0.0.1', resolve);
  });
  process.stdout.write(`feishu-shim: 127.0.0.1:${config.port}, ${config.chats.length} chat(s), as ${config.sendAs}\n`);
  return new Promise(() => {});
}

// Only run when executed, not when imported by a test.
const invokedDirectly = process.argv[1] !== undefined
  && await realpath(process.argv[1]).catch(() => process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = await main(process.argv.slice(2));
