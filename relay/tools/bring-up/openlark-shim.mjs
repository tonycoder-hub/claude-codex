#!/usr/bin/env node
/**
 * The last hop for the OpenLark route: a loopback HTTP endpoint that runs the
 * OpenLark deployment's `relay-send.ts` for the relay.
 *
 * ## Why a separate process from the relay
 *
 * The credential is `<dataDir>/session.json` inside the OpenLark deployment,
 * and only that deployment's `SessionVault` knows how to read it. The gateway,
 * protocol registry and `ImDomain` that speak the Lark wire protocol are that
 * deployment's `src/` too. Importing any of it from this repository would mean
 * carrying a copy of a person's session here. So the send happens over there,
 * in a script this repository keeps a copy of at
 * `tools/bring-up/openlark/relay-send.ts`, and this process is the door to it.
 *
 * Unlike the feishu route, both processes live on the same host: the OpenLark
 * service runs on the development host, which is also where the relay runs, so
 * there is no `ssh -R` in this path. Nothing has to be forwarded.
 *
 * ## Why a subprocess per send
 *
 * Same reasoning as `feishu-shim.mjs`: a stateless invocation cannot wedge the
 * next one, and the whole contract is one JSON object in and one JSON object
 * out. The cost is process startup, which for `tsx` is seconds, not
 * milliseconds -- hence a timeout far larger than the feishu route's.
 *
 * One thing is strictly better here, and it is why the request travels on
 * stdin: the chat id never appears in the child's `argv`, so unlike the feishu
 * route it cannot be read out of `ps` by any other process on the machine for
 * the lifetime of the call.
 *
 * ## What guards it
 *
 * This is an unauthenticated local endpoint that can post into a person's chat,
 * so three things gate it and none of them have permissive defaults:
 *
 *   1. It binds `127.0.0.1` only. There is no flag to bind anything else.
 *   2. Every request must carry the nonce from `OPENLARK_SHIM_NONCE`, compared
 *      with `timingSafeEqual`. No nonce in the environment, no server.
 *   3. `OPENLARK_SHIM_CHATS` is an allowlist of chat ids, and an empty one
 *      permits nothing -- the same fuse `allowlistSink` is, repeated on this
 *      side so a bug on the relay side cannot be the only thing standing
 *      between a turn and the wrong group. `relay-send.ts` then checks its own
 *      allowlist a third time, in the process that holds the session.
 *
 * Neither the nonce nor the chat ids are ever on a command line: they come from
 * the environment, and the request body comes from stdin.
 */

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { OPENLARK_NONCE_HEADER, OPENLARK_CHAT_ID } from '../../src/imrelay/openlark-sink.mjs';

const DEFAULT_PORT = 18790;
const MAX_BODY_BYTES = 256 * 1024;
/** `tsx` has to compile the deployment's TypeScript before it can send, and the
 *  gateway round trip follows. Measured at roughly 20s end to end on the
 *  development host, so this is generous rather than tight. */
const CALL_TIMEOUT_MS = 120000;

export { OPENLARK_NONCE_HEADER };

/**
 * Validate the configuration. Every field is required to be meaningful; there
 * is no mode in which this starts up able to send to something unintended.
 */
export function readConfig(env = process.env) {
  const nonce = env.OPENLARK_SHIM_NONCE ?? '';
  if (nonce.length < 16) {
    throw new Error('OPENLARK_SHIM_NONCE must be set to at least 16 characters');
  }
  const chats = (env.OPENLARK_SHIM_CHATS ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (chats.length === 0) throw new Error('OPENLARK_SHIM_CHATS must name at least one chat id');
  const bad = chats.filter((id) => !OPENLARK_CHAT_ID.test(id));
  if (bad.length > 0) {
    // The ids are not echoed, only counted: an operator who pasted an `oc_` id
    // learns that it is the wrong namespace without the log line carrying it.
    throw new Error(`OPENLARK_SHIM_CHATS has ${bad.length} entr(y|ies) that are not OpenLark numeric feed ids`);
  }
  const port = Number(env.OPENLARK_SHIM_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('OPENLARK_SHIM_PORT must be a port number');
  }
  const deployDir = env.OPENLARK_DEPLOY_DIR ?? '';
  if (deployDir === '') {
    throw new Error('OPENLARK_DEPLOY_DIR must point at the OpenLark deployment checkout');
  }
  const dataDir = env.OPENLARK_DATA_DIR ?? '';
  if (dataDir === '') {
    throw new Error('OPENLARK_DATA_DIR must point at the deployment data dir holding session.json');
  }
  return {
    nonce,
    chats,
    port,
    deployDir,
    dataDir,
    sender: env.OPENLARK_SENDER_SCRIPT ?? 'scripts/relay-send.ts',
    runner: env.OPENLARK_RUNNER ?? 'npx',
  };
}

/**
 * Decide whether a parsed request body may be executed.
 *
 * Separated from the server so the policy is testable without a socket.
 * Returns `null` when the call is permitted, or `{ status, error }` when it is
 * not. Deliberately the same shape as `feishu-shim.mjs`'s `screen`, because the
 * policy is the same policy; only the vocabulary of the fields differs.
 */
export function screen(body, { chats }) {
  if (body === null || typeof body !== 'object') return { status: 400, error: 'body must be a JSON object' };
  if (body.action !== 'send') {
    // `reply` is refused here for the same reason `allowlistSink` refuses
    // `patchCard`: a message id does not name its chat, so there is no way to
    // check it against the allowlist. Permitting it would make the allowlist
    // bypassable by anything that can produce a message id.
    return { status: 403, error: `this shim only performs action "send", not ${JSON.stringify(body.action)}` };
  }
  if (typeof body.chatId !== 'string' || !OPENLARK_CHAT_ID.test(body.chatId)) {
    // Checked before membership, so an `oc_` id can never reach the gateway
    // even if someone put one on the allowlist: the format is the outer gate.
    return { status: 403, error: 'chatId must be an OpenLark numeric feed id' };
  }
  if (!chats.includes(body.chatId)) {
    // The id is not echoed. A caller that got it wrong does not learn the right
    // one from the error, and the log line says only that it was unlisted.
    return { status: 403, error: 'chatId is not on this shim\'s allowlist' };
  }
  if (typeof body.text !== 'string' || body.text === '') {
    return { status: 400, error: 'text must be a non-empty string' };
  }
  if (Buffer.byteLength(body.text, 'utf8') > 30000) {
    // The gateway rejects an oversized message with an opaque code, so it is
    // caught at the boundary where the cause is obvious.
    return { status: 400, error: 'text is too long for one message' };
  }
  if (typeof body.clientId !== 'string' || body.clientId === '') {
    // The gateway de-duplicates on this. Without it, a retry after a timed-out
    // send posts the message a second time.
    return { status: 400, error: 'clientId must be a non-empty string' };
  }
  return null;
}

/**
 * Run one send and say what happened.
 *
 * The exit code is read and then ignored for the success decision, on purpose
 * and for the same reason as the feishu route: `relay-send.ts` exits 0 for a
 * send, for a refusal and for a malformed request, because the envelope on
 * stdout is the contract. Only a parseable object with `ok === true` and a
 * non-empty `messageId` is a send.
 *
 * @param {object} call
 * @param {Function} [exec] Injected for tests.
 */
export function runSender({ runner, deployDir, dataDir, sender, chats, request }, exec = execFile) {
  return new Promise((resolve) => {
    const child = exec(
      runner,
      ['tsx', sender],
      {
        cwd: deployDir,
        timeout: CALL_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
        env: {
          ...process.env,
          OPEN_LARK_DATA_DIR: dataDir,
          // `loadConfig()` insists on a connection string, but the sender keeps
          // raw payloads in an in-process PGlite database, so nothing here
          // reaches the service's real one. A placeholder is correct, not a
          // shortcut: pointing it at the live database would mean a second
          // writer on it.
          OPEN_LARK_DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
          NODE_OPTIONS: '--conditions=development',
          // Third statement of the same allowlist, in the process that actually
          // holds the session.
          OPENLARK_RELAY_CHATS: chats.join(','),
        },
      },
      (error, stdout, stderr) => {
        const text = String(stdout ?? '').trim();
        const timedOut = error?.killed === true;
        let parsed = null;
        try {
          parsed = JSON.parse(text.split('\n').filter((line) => line.trim() !== '').pop() ?? '');
        } catch {
          parsed = null;
        }
        if (parsed?.ok === true && typeof parsed.messageId === 'string' && parsed.messageId !== '') {
          resolve({ ok: true, messageId: parsed.messageId, error: null, rateLimited: false });
          return;
        }
        const detail = [
          parsed?.error ? String(parsed.error) : 'the sender printed no usable envelope',
          // A timed-out send is the one failure where the message may still
          // have landed. The `clientId` is what keeps the retry from
          // duplicating it.
          timedOut ? `(the sender was killed after ${CALL_TIMEOUT_MS}ms)` : null,
          error && !timedOut ? `(exit ${String(error.code ?? error.signal)})` : null,
          typeof stderr === 'string' && stderr.trim() !== '' ? `(stderr: ${stderr.trim().slice(0, 200)})` : null,
        ].filter((part) => part !== null).join(' ');
        resolve({ ok: false, messageId: null, error: detail, rateLimited: parsed?.rateLimited === true });
      },
    );
    // The request travels on stdin so that no id reaches `argv`.
    child.stdin?.end(JSON.stringify(request));
  });
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
    const offered = Buffer.from(String(request.headers[OPENLARK_NONCE_HEADER] ?? ''), 'utf8');
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
      const outcome = await runSender({
        runner: config.runner,
        deployDir: config.deployDir,
        dataDir: config.dataDir,
        sender: config.sender,
        chats: config.chats,
        request: body,
      }, exec);
      log({ what: outcome.ok ? 'sent' : 'failed', error: outcome.error });
      // A business failure is a 502: the shim worked, the thing behind it said
      // no. The relay distinguishes on the body's `ok`, not on the status.
      reply(outcome.ok ? 200 : 502, outcome.ok
        ? { ok: true, messageId: outcome.messageId }
        : { ok: false, error: outcome.error, rateLimited: outcome.rateLimited });
    });
  });
}

/** Start the shim. Bound to loopback; there is no flag to change that. */
export async function main(env = process.env) {
  const config = readConfig(env);
  const server = createShim(config, { log: (line) => process.stdout.write(`${JSON.stringify(line)}\n`) });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', resolve);
  });
  process.stdout.write(`  ok  nonce       ${config.nonce.length} chars\n`);
  process.stdout.write(`  ok  allowlist   ${config.chats.length} chat(s)\n`);
  process.stdout.write(`  ok  listening   127.0.0.1:${config.port}/send\n`);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`  FAIL  ${error.message}\n`);
    process.exit(1);
  });
}
