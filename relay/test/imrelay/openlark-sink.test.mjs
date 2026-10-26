// The OpenLark send route, from the relay's operation descriptor down to a
// real loopback socket with a real stub sender executable.
//
// Layered the same way `feishu-sink.test.mjs` is:
//   1. `toOpenLarkRequest` -- the request body, field by field, including every
//      operation it must refuse.
//   2. `openLarkSink` over an injected fetch, so the success contract and each
//      refusal shape are pinned without a socket.
//   3. `screen` / `readConfig` -- the fuse, on its own terms.
//   4. `createShim` over a real loopback socket with a **real stub executable**
//      standing in for the deployment's `relay-send.ts`, so the stdin round
//      trip is exercised rather than mocked.
//   5. `allowlistSink` -> `openLarkSink` -> HTTP -> shim -> stub, which is the
//      production path with only the credential swapped out.
//
// No real chat id appears here. The ids are made-up 19-digit numbers of the
// right shape, which is the whole point of pinning a format.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import {
  openLarkSink,
  toOpenLarkRequest,
  openLarkRateLimited,
  OpenLarkRefused,
  UnsupportedOpenLarkOp,
  OPENLARK_NONCE_HEADER,
  OPENLARK_CHAT_ID,
} from '../../src/imrelay/openlark-sink.mjs';
import { OPS, allowlistSink, OutboundSealed } from '../../src/imrelay/transport.mjs';
import { createShim, screen, readConfig, runSender } from '../../tools/bring-up/openlark-shim.mjs';

/** A well-formed OpenLark feed id that is not anyone's. */
const CHAT = '7700000000000000001';
const OTHER = '7700000000000000002';
const NONCE = 'nonce-of-sufficient-length';

function sendOp(overrides = {}) {
  return {
    op: OPS.sendMessage,
    receiveId: CHAT,
    msgType: 'text',
    content: JSON.stringify({ text: 'hello' }),
    uuid: 'uuid-1',
    ...overrides,
  };
}

// -- 1. the request body -----------------------------------------------------

test('toOpenLarkRequest builds the sender contract and nothing else', () => {
  assert.deepEqual(toOpenLarkRequest(sendOp()), {
    action: 'send',
    chatId: CHAT,
    text: 'hello',
    clientId: 'uuid-1',
  });
  // Both content spellings, because the relay produces both.
  assert.equal(toOpenLarkRequest(sendOp({ content: { text: 'objecty' } })).text, 'objecty');
  // A bare string that is not JSON is sent as written rather than dropped.
  assert.equal(toOpenLarkRequest(sendOp({ content: 'plain words' })).text, 'plain words');
  // A string that starts with a brace but is not JSON must not become empty.
  assert.equal(toOpenLarkRequest(sendOp({ content: '{not json' })).text, '{not json');
});

test('toOpenLarkRequest refuses every operation this route cannot attribute to a chat', () => {
  const refusals = [
    [{ op: OPS.patchCard, messageId: 'om_1' }, /patch/],
    [{ op: OPS.createCardEntity, forChat: CHAT }, /CardKit/],
    [{ op: OPS.updateCardEntity, cardId: 'c1' }, /CardKit/],
    [{ op: OPS.cardSettings, cardId: 'c1' }, /CardKit/],
    [{ op: OPS.streamText, cardId: 'c1' }, /card entity/],
    [{ op: 'something.invented' }, /not a known outbound operation/],
    [null, /not an operation descriptor/],
  ];
  for (const [op, pattern] of refusals) {
    assert.throws(() => toOpenLarkRequest(op), (error) => {
      assert.ok(error instanceof UnsupportedOpenLarkOp, `${op?.op} must be UnsupportedOpenLarkOp`);
      assert.match(error.message, pattern);
      return true;
    }, `${op?.op} must be refused`);
  }
});

test('toOpenLarkRequest refuses a reply, because a message id names no chat', () => {
  // The neighbour of the allowlist's `patchCard` refusal. If this ever starts
  // passing, the chat allowlist becomes bypassable by anything that can produce
  // a message id.
  assert.throws(
    () => toOpenLarkRequest(sendOp({ replyTo: 'om_whatever' })),
    (error) => error instanceof UnsupportedOpenLarkOp && /message id/.test(error.message),
  );
  // Negative neighbour: an empty or absent replyTo is the ordinary send path.
  assert.equal(toOpenLarkRequest(sendOp({ replyTo: '' })).action, 'send');
  assert.equal(toOpenLarkRequest(sendOp({ replyTo: undefined })).action, 'send');
});

test('toOpenLarkRequest pins the id namespace, so an oc_ id cannot be smuggled in', () => {
  for (const bad of [
    'oc_0123456789abcdef0123456789abcdef',
    'ou_0123456789abcdef',
    '',
    '123',                      // too short
    '7700000000000000001 ',     // trailing space
    ' 7700000000000000001',
    '77000000000000000012345678901',  // too long
    '77000000000000000a1',      // not all digits
  ]) {
    assert.throws(
      () => toOpenLarkRequest(sendOp({ receiveId: bad })),
      TypeError,
      `${JSON.stringify(bad)} must not be accepted as a feed id`,
    );
  }
  // Negative neighbours: the shortest and longest ids the format does allow.
  assert.ok(OPENLARK_CHAT_ID.test('1234567890'));
  assert.ok(OPENLARK_CHAT_ID.test('123456789012345678901234'));
  assert.equal(toOpenLarkRequest(sendOp({ receiveId: '1234567890' })).chatId, '1234567890');
});

test('toOpenLarkRequest refuses a non-text msgType rather than posting raw card JSON', () => {
  assert.throws(
    () => toOpenLarkRequest(sendOp({ msgType: 'interactive', content: { schema: '2.0' } })),
    (error) => error instanceof UnsupportedOpenLarkOp && /sends text/.test(error.message),
  );
  // Negative neighbours: 'text' and an absent msgType are both fine.
  assert.equal(toOpenLarkRequest(sendOp({ msgType: 'text' })).text, 'hello');
  assert.equal(toOpenLarkRequest(sendOp({ msgType: undefined })).text, 'hello');
});

test('toOpenLarkRequest insists on a uuid, so a retry cannot double-post', () => {
  for (const uuid of [undefined, '', 42]) {
    assert.throws(() => toOpenLarkRequest(sendOp({ uuid })), TypeError, `uuid ${JSON.stringify(uuid)} must be refused`);
  }
  assert.equal(toOpenLarkRequest(sendOp({ uuid: 'u' })).clientId, 'u');
});

test('toOpenLarkRequest insists on non-empty text', () => {
  for (const content of ['', '{}', { text: '' }, { nope: 1 }, 42]) {
    assert.throws(
      () => toOpenLarkRequest(sendOp({ content })),
      TypeError,
      `content ${JSON.stringify(content)} must be refused`,
    );
  }
});

// -- 2. the sink over an injected fetch --------------------------------------

function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

function jsonResponse(status, body) {
  return { status, json: async () => body };
}

test('openLarkSink returns the platform envelope on a real message id', async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, { ok: true, messageId: '7199999999999999999' }));
  const sink = openLarkSink({ endpoint: 'http://127.0.0.1:1/send', nonce: NONCE, fetch: fetchImpl });
  assert.deepEqual(await sink.perform(sendOp()), {
    code: 0,
    msg: 'success',
    data: { message_id: '7199999999999999999' },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers[OPENLARK_NONCE_HEADER], NONCE);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    action: 'send', chatId: CHAT, text: 'hello', clientId: 'uuid-1',
  });
});

test('openLarkSink refuses a pending local id, which is OpenLarks own judgement', async () => {
  // OpenLark's messenger mints `local:<clientId>` before the upstream answers
  // and throws rather than returning it. If it ever leaks through, a message
  // that never left would read as sent -- the exact failure this whole route
  // is built to avoid.
  const { fetchImpl } = stubFetch(() => jsonResponse(200, { ok: true, messageId: 'local:uuid-1' }));
  const sink = openLarkSink({ endpoint: 'http://127.0.0.1:1/send', nonce: NONCE, fetch: fetchImpl });
  await assert.rejects(sink.perform(sendOp()), (error) => {
    assert.ok(error instanceof OpenLarkRefused);
    assert.match(error.message, /pending local id/);
    return true;
  });
  // Negative neighbour: an id that merely *contains* "local:" is a real id.
  const near = stubFetch(() => jsonResponse(200, { ok: true, messageId: '77local:1' }));
  const ok = openLarkSink({ endpoint: 'http://127.0.0.1:1/send', nonce: NONCE, fetch: near.fetchImpl });
  assert.equal((await ok.perform(sendOp())).data.message_id, '77local:1');
});

test('openLarkSink refuses a success without a message id', async () => {
  for (const body of [{ ok: true }, { ok: true, messageId: '' }, { ok: true, messageId: 7 }]) {
    const { fetchImpl } = stubFetch(() => jsonResponse(200, body));
    const sink = openLarkSink({ endpoint: 'http://127.0.0.1:1/send', nonce: NONCE, fetch: fetchImpl });
    await assert.rejects(sink.perform(sendOp()), (error) => {
      assert.ok(error instanceof OpenLarkRefused);
      assert.match(error.message, /without a message id/);
      return true;
    }, `${JSON.stringify(body)} must be refused`);
  }
});

test('openLarkSink turns a refusal into OpenLarkRefused and keeps the rate-limit flag', async () => {
  const flagged = stubFetch(() => jsonResponse(502, { ok: false, error: 'nope', rateLimited: true }));
  const a = openLarkSink({ endpoint: 'http://127.0.0.1:1/send', nonce: NONCE, fetch: flagged.fetchImpl });
  await assert.rejects(a.perform(sendOp()), (error) => error.rateLimited === true && /nope/.test(error.message));

  // Inferred from the text when the far side did not set the flag.
  const inferred = stubFetch(() => jsonResponse(502, { ok: false, error: 'HTTP 429 slow down' }));
  const b = openLarkSink({ endpoint: 'http://127.0.0.1:1/send', nonce: NONCE, fetch: inferred.fetchImpl });
  await assert.rejects(b.perform(sendOp()), (error) => error.rateLimited === true);

  // Negative neighbour: an ordinary failure must not be flagged, or the pacer
  // backs off for something that will never succeed.
  const plain = stubFetch(() => jsonResponse(502, { ok: false, error: 'chat not found' }));
  const c = openLarkSink({ endpoint: 'http://127.0.0.1:1/send', nonce: NONCE, fetch: plain.fetchImpl });
  await assert.rejects(c.perform(sendOp()), (error) => error.rateLimited === false);
});

test('openLarkSink treats an unreachable shim as nothing-was-sent', async () => {
  const { fetchImpl } = stubFetch(() => { throw new Error('ECONNREFUSED'); });
  const sink = openLarkSink({ endpoint: 'http://127.0.0.1:1/send', nonce: NONCE, fetch: fetchImpl });
  await assert.rejects(sink.perform(sendOp()), (error) => {
    assert.ok(error instanceof OpenLarkRefused);
    assert.match(error.message, /did not answer/);
    return true;
  });
});

test('openLarkSink treats a non-JSON body as a refusal rather than a send', async () => {
  const { fetchImpl } = stubFetch(() => ({ status: 500, json: async () => { throw new Error('not json'); } }));
  const sink = openLarkSink({ endpoint: 'http://127.0.0.1:1/send', nonce: NONCE, fetch: fetchImpl });
  await assert.rejects(sink.perform(sendOp()), (error) => /not JSON/.test(error.message));
});

test('openLarkSink will not be built without the things that make it safe', () => {
  assert.throws(() => openLarkSink({ nonce: NONCE }), TypeError);
  assert.throws(() => openLarkSink({ endpoint: 'http://x/send' }), TypeError, 'an empty nonce must not be allowed');
  assert.throws(() => openLarkSink({ endpoint: 'http://x/send', nonce: '' }), TypeError);
  assert.throws(() => openLarkSink({ endpoint: 'http://x/send', nonce: NONCE, fetch: 'no' }), TypeError);
  assert.throws(() => openLarkSink({ endpoint: 'http://x/send', nonce: NONCE, timeoutMs: 0 }), RangeError);
  // It must NOT be card-capable: `daemon.mjs` calls `allowCard` unconditionally
  // in CardKit mode, so a missing method is how that mistake stays loud.
  const sink = openLarkSink({ endpoint: 'http://x/send', nonce: NONCE, fetch: async () => jsonResponse(200, {}) });
  assert.equal(sink.allowCard, undefined);
});

test('openLarkRateLimited knows slow-down from wrong', () => {
  for (const yes of ['HTTP 429', 'rate limit exceeded', 'RateLimited', 'too many requests', '请求过快', '过于频繁']) {
    assert.equal(openLarkRateLimited(yes), true, `${yes} is a rate limit`);
  }
  for (const no of ['chat not found', 'no session on disk', '', undefined, 'error 4290000']) {
    assert.equal(openLarkRateLimited(no), false, `${JSON.stringify(no)} is not a rate limit`);
  }
});

// -- 3. the fuse -------------------------------------------------------------

test('the screen refuses anything it cannot attribute to an allowed chat', () => {
  const config = { chats: [CHAT] };
  const good = { action: 'send', chatId: CHAT, text: 'hi', clientId: 'u1' };
  assert.equal(screen(good, config), null);

  const refusals = [
    [{ ...good, chatId: OTHER }, 403, /allowlist/],
    [{ ...good, action: 'reply' }, 403, /send/],
    [{ ...good, action: undefined }, 403, /send/],
    [{ ...good, chatId: 'oc_0123456789abcdef0123456789abcdef' }, 403, /numeric feed id/],
    [{ ...good, chatId: 123 }, 403, /numeric feed id/],
    [{ ...good, text: '' }, 400, /non-empty/],
    [{ ...good, text: { text: 'hi' } }, 400, /non-empty/],
    [{ ...good, text: 'x'.repeat(30001) }, 400, /too long/],
    [{ ...good, clientId: '' }, 400, /clientId/],
    [null, 400, /object/],
    ['a string', 400, /object/],
  ];
  for (const [body, status, pattern] of refusals) {
    const refusal = screen(body, config);
    assert.notEqual(refusal, null, `${JSON.stringify(body).slice(0, 80)} must be refused`);
    assert.equal(refusal.status, status, `${JSON.stringify(body).slice(0, 80)} status`);
    assert.match(refusal.error, pattern);
  }
  // The refusal must not teach the caller the id it got wrong, nor the right one.
  const leak = screen({ ...good, chatId: OTHER }, config);
  assert.ok(!leak.error.includes(OTHER));
  assert.ok(!leak.error.includes(CHAT));
});

test('an empty allowlist permits nothing, whatever else is right', () => {
  const good = { action: 'send', chatId: CHAT, text: 'hi', clientId: 'u1' };
  assert.equal(screen(good, { chats: [CHAT] }), null, 'premise: this body is otherwise fine');
  const refused = screen(good, { chats: [] });
  assert.notEqual(refused, null, 'an empty allowlist must permit nothing');
  assert.equal(refused.status, 403);
});

test('the format gate runs before the membership gate', () => {
  // An operator who put an `oc_` id on the allowlist must still not be able to
  // send to it: the gateway addresses a different namespace, so the format is
  // the outer gate. `readConfig` refuses such an allowlist too, but `screen` is
  // exported, so the fuse must hold on its own terms.
  const oc = 'oc_0123456789abcdef0123456789abcdef';
  const refused = screen({ action: 'send', chatId: oc, text: 'hi', clientId: 'u1' }, { chats: [oc] });
  assert.notEqual(refused, null);
  assert.match(refused.error, /numeric feed id/);
});

test('readConfig has no permissive default', () => {
  const base = {
    OPENLARK_SHIM_NONCE: NONCE,
    OPENLARK_SHIM_CHATS: CHAT,
    OPENLARK_DEPLOY_DIR: '/deploy',
    OPENLARK_DATA_DIR: '/deploy/data',
  };
  const config = readConfig(base);
  assert.deepEqual(config.chats, [CHAT]);
  assert.equal(config.port, 18790);
  assert.equal(config.sender, 'scripts/relay-send.ts');

  assert.throws(() => readConfig({ ...base, OPENLARK_SHIM_NONCE: 'short' }), /at least 16/);
  assert.throws(() => readConfig({ ...base, OPENLARK_SHIM_NONCE: undefined }), /at least 16/);
  assert.throws(() => readConfig({ ...base, OPENLARK_SHIM_CHATS: '' }), /at least one chat/);
  assert.throws(() => readConfig({ ...base, OPENLARK_SHIM_CHATS: undefined }), /at least one chat/);
  assert.throws(() => readConfig({ ...base, OPENLARK_SHIM_CHATS: ' , ' }), /at least one chat/);
  // An `oc_` id in the allowlist is refused at startup, and the error does not
  // carry it.
  const badNamespace = () => readConfig({ ...base, OPENLARK_SHIM_CHATS: 'oc_0123456789abcdef0123456789abcdef' });
  assert.throws(badNamespace, /numeric feed ids/);
  try { badNamespace(); } catch (error) { assert.ok(!error.message.includes('oc_0123456789abcdef0123456789abcdef')); }
  assert.throws(() => readConfig({ ...base, OPENLARK_DEPLOY_DIR: '' }), /OPENLARK_DEPLOY_DIR/);
  assert.throws(() => readConfig({ ...base, OPENLARK_DEPLOY_DIR: undefined }), /OPENLARK_DEPLOY_DIR/);
  assert.throws(() => readConfig({ ...base, OPENLARK_DATA_DIR: undefined }), /OPENLARK_DATA_DIR/);
  assert.throws(() => readConfig({ ...base, OPENLARK_SHIM_PORT: 'http' }), /port number/);
  assert.throws(() => readConfig({ ...base, OPENLARK_SHIM_PORT: '70000' }), /port number/);
});

// -- 4 & 5. a real socket and a real stub sender -----------------------------

/** A stub standing in for the deployment's `relay-send.ts`: reads the request
 *  from stdin, writes an envelope, and records what it was given. */
async function stubSender(dir, bodyScript) {
  const log = join(dir, 'invocations.log');
  const path = join(dir, 'stub-sender.mjs');
  await writeFile(path, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin: input, chats: process.env.OPENLARK_RELAY_CHATS, dataDir: process.env.OPEN_LARK_DATA_DIR, cwd: process.cwd() }) + '\\n');
const request = JSON.parse(input);
${bodyScript}
`, 'utf8');
  await chmod(path, 0o755);
  return { path, log };
}

/** Start a shim whose "runner" is the stub sender, on a real loopback port. */
async function withShim(stub, overrides, run) {
  const config = {
    nonce: NONCE,
    chats: [CHAT],
    port: 0,
    deployDir: process.cwd(),
    dataDir: '/tmp/openlark-data',
    sender: 'ignored-by-stub',
    runner: process.execPath,
    ...overrides,
  };
  // `runSender` calls `exec(runner, ['tsx', sender])`. The stub is a node
  // script, so the runner is node and the stub path replaces 'tsx'.
  const exec = (runner, args, options, callback) =>
    execFile(runner, [stub.path, ...args.slice(1)], options, callback);
  const server = createShim(config, { exec });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base, config);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('the shim carries a send to the sender over stdin and returns its id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openlark-shim-'));
  try {
    const stub = await stubSender(dir, `
      console.log(JSON.stringify({ ok: true, messageId: '71' + request.chatId.slice(2) }));
    `);
    await withShim(stub, {}, async (base) => {
      const response = await fetch(`${base}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [OPENLARK_NONCE_HEADER]: NONCE },
        body: JSON.stringify({ action: 'send', chatId: CHAT, text: 'hello there', clientId: 'u1' }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, messageId: '7100000000000000001' });
    });
    const { readFile } = await import('node:fs/promises');
    const invocations = (await readFile(stub.log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(invocations.length, 1);
    // The whole reason the request travels on stdin: no id in argv, so no id in `ps`.
    assert.deepEqual(invocations[0].argv, ['ignored-by-stub']);
    assert.ok(!JSON.stringify(invocations[0].argv).includes(CHAT));
    assert.deepEqual(JSON.parse(invocations[0].stdin), {
      action: 'send', chatId: CHAT, text: 'hello there', clientId: 'u1',
    });
    // The allowlist is restated to the process that holds the session.
    assert.equal(invocations[0].chats, CHAT);
    assert.equal(invocations[0].dataDir, '/tmp/openlark-data');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the shim will not run the sender at all for a request the fuse refuses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openlark-shim-'));
  try {
    const stub = await stubSender(dir, `console.log(JSON.stringify({ ok: true, messageId: '7199' }));`);
    await withShim(stub, {}, async (base) => {
      const post = (body, headers = { [OPENLARK_NONCE_HEADER]: NONCE }) => fetch(`${base}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      assert.equal((await post({ action: 'send', chatId: OTHER, text: 'x', clientId: 'u' })).status, 403);
      assert.equal((await post({ action: 'reply', chatId: CHAT, text: 'x', clientId: 'u' })).status, 403);
      assert.equal((await post('not json')).status, 400);
      assert.equal((await post({ action: 'send', chatId: CHAT, text: 'x', clientId: 'u' }, {})).status, 401);
      assert.equal((await post({ action: 'send', chatId: CHAT, text: 'x', clientId: 'u' }, {
        [OPENLARK_NONCE_HEADER]: `${NONCE}x`,
      })).status, 401, 'a wrong-length nonce must be rejected, not crash the comparison');
      assert.equal((await post({ action: 'send', chatId: CHAT, text: 'x', clientId: 'u' }, {
        [OPENLARK_NONCE_HEADER]: 'wrong-but-same-length-xxxxx'.slice(0, NONCE.length),
      })).status, 401);
      // Wrong method and wrong path reach nothing either.
      assert.equal((await fetch(`${base}/send`, { method: 'GET' })).status, 404);
      assert.equal((await fetch(`${base}/elsewhere`, {
        method: 'POST', headers: { [OPENLARK_NONCE_HEADER]: NONCE }, body: '{}',
      })).status, 404);
    });
    // The point of the test: the sender was never started, so nothing could
    // have been sent even if the far side were live.
    const { readFile } = await import('node:fs/promises');
    await assert.rejects(readFile(stub.log, 'utf8'), /ENOENT/, 'the sender must not have run at all');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the shim reports a sender refusal as a 502 with ok false', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openlark-shim-'));
  try {
    const stub = await stubSender(dir, `
      console.log(JSON.stringify({ ok: false, error: 'upstream said no', rateLimited: false }));
    `);
    await withShim(stub, {}, async (base) => {
      const response = await fetch(`${base}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [OPENLARK_NONCE_HEADER]: NONCE },
        body: JSON.stringify({ action: 'send', chatId: CHAT, text: 'x', clientId: 'u' }),
      });
      assert.equal(response.status, 502);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.match(body.error, /upstream said no/);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a sender that prints nothing usable is a failure, not a send', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openlark-shim-'));
  try {
    // The shape that matters: exit 0 and cheerful noise. `relay-send.ts` exits
    // 0 for refusals by design, so the exit code cannot be the judgement.
    for (const body of [
      `console.log('sent!'); process.exit(0);`,
      `process.exit(0);`,
      `console.log(JSON.stringify({ ok: true })); process.exit(0);`,
      `console.log(JSON.stringify({ ok: true, messageId: '' })); process.exit(0);`,
    ]) {
      const stub = await stubSender(dir, body);
      await withShim(stub, {}, async (base) => {
        const response = await fetch(`${base}/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [OPENLARK_NONCE_HEADER]: NONCE },
          body: JSON.stringify({ action: 'send', chatId: CHAT, text: 'x', clientId: 'u' }),
        });
        assert.equal(response.status, 502, `${body} must not read as a send`);
        assert.equal((await response.json()).ok, false);
      });
      await rm(stub.log, { force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runSender reads the last envelope line, so sender chatter cannot hide the verdict', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openlark-shim-'));
  try {
    const stub = await stubSender(dir, `
      console.log('tsx: compiling');
      console.log(JSON.stringify({ ok: true, messageId: '7199999999999999999' }));
    `);
    const outcome = await runSender({
      runner: process.execPath,
      deployDir: process.cwd(),
      dataDir: '/tmp/d',
      sender: 'ignored',
      chats: [CHAT],
      request: { action: 'send', chatId: CHAT, text: 'x', clientId: 'u' },
    }, (runner, args, options, callback) => execFile(runner, [stub.path, ...args.slice(1)], options, callback));
    assert.deepEqual(outcome, { ok: true, messageId: '7199999999999999999', error: null, rateLimited: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('main binds loopback only, which is the claim that has no flag to turn off', async () => {
  // This survived a mutation to `0.0.0.0` until it was written: the comment in
  // `openlark-shim.mjs` says "there is no flag to bind anything else", and an
  // unauthenticated endpoint that can post into a person's chat is not
  // something to leave reachable from the network on the strength of a comment.
  const { main } = await import('../../tools/bring-up/openlark-shim.mjs');
  // `readConfig` refuses port 0 on purpose -- an ephemeral port is not
  // something the relay could be configured to find -- so a real one is
  // reserved and released instead of asking for one.
  const { createServer: createProbe } = await import('node:net');
  const probe = createProbe();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const server = await main({
    OPENLARK_SHIM_NONCE: NONCE,
    OPENLARK_SHIM_CHATS: CHAT,
    OPENLARK_DEPLOY_DIR: '/deploy',
    OPENLARK_DATA_DIR: '/deploy/data',
    OPENLARK_SHIM_PORT: String(port),
  });
  try {
    const address = server.address();
    assert.equal(address.address, '127.0.0.1', 'the shim must bind loopback and nothing else');
    assert.notEqual(address.address, '0.0.0.0');
    assert.equal(address.family, 'IPv4');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

// -- the whole production path, credential aside -----------------------------

test('allowlistSink over openLarkSink over the shim over a stub sender', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openlark-shim-'));
  try {
    const stub = await stubSender(dir, `
      console.log(JSON.stringify({ ok: true, messageId: '7188888888888888888' }));
    `);
    await withShim(stub, {}, async (base) => {
      const sink = allowlistSink({
        inner: openLarkSink({ endpoint: `${base}/send`, nonce: NONCE }),
        chats: [CHAT],
      });
      assert.equal(sink.allowedChatCount, 1);
      const envelope = await sink.perform(sendOp());
      assert.equal(envelope.data.message_id, '7188888888888888888');

      // The relay-side fuse stops an unlisted chat before any HTTP happens.
      await assert.rejects(
        sink.perform(sendOp({ receiveId: OTHER })),
        (error) => error instanceof OutboundSealed,
      );
      // And a card op never reaches the OpenLark sink's own refusal.
      await assert.rejects(
        sink.perform({ op: OPS.patchCard, messageId: 'om_1' }),
        (error) => error instanceof OutboundSealed,
      );
    });
    const { readFile } = await import('node:fs/promises');
    const invocations = (await readFile(stub.log, 'utf8')).trim().split('\n');
    assert.equal(invocations.length, 1, 'only the permitted send may have reached the sender');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
