// The sink that can actually reach a person, and the shim that holds the
// credential for it.
//
// The thing being defended against here is specific. `feishu-lark` 0.2.3 exits 0
// no matter what happens, so the only difference between "your message is in the
// group" and "your arguments matched no code path and nothing was sent" is a
// string on stdout. Every green in this file therefore asserts on the *content*
// of what crossed a boundary, not on whether a call returned: what JSON the CLI
// received in its argv, what the CLI printed, what the sink did with that.
//
// Four layers, bottom up:
//
//   1. `readCliResult` against the four stdout shapes that were observed from
//      the real CLI, including `undefined`.
//   2. `toCliInvocation` -- the argument object, field by field.
//   3. `feishuSink` over an injected fetch, and `screen`/`createShim` over a
//      real loopback socket with a **real stub executable** standing in for
//      `feishu-lark`, so the argv round trip is exercised rather than mocked.
//   4. A `Relay` in snapshot mode through `allowlistSink` -> `feishuSink` ->
//      HTTP -> the shim -> the stub CLI. Nothing is sent; everything else is
//      the production path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CLI_TOOL, NONCE_HEADER, UnsupportedOp, CliRefused,
  toCliInvocation, readCliResult, looksRateLimited, feishuSink,
} from '../../src/imrelay/feishu-sink.mjs';
import { OPS, RATE_LIMIT_CODE, allowlistSink, OutboundSealed } from '../../src/imrelay/transport.mjs';
import { createShim, screen, readConfig, runCli, readChatCounts } from '../../tools/bring-up/feishu-shim.mjs';
import { DETAIL } from '../../src/imrelay/cards.mjs';
import { TURN_STATUS } from '../../src/imrelay/projection.mjs';
import { InboundGate } from '../../src/imrelay/inbound.mjs';
import { Dispatcher } from '../../src/imrelay/dispatch.mjs';
import { DraftBook } from '../../src/imrelay/digest.mjs';
import {
  Relay, CARD_STRATEGY, SNAPSHOT_INTERVAL_MS, RATE_LIMIT_BACKOFF_MS, harnessConnection,
} from '../../src/imrelay/daemon.mjs';
import { fakeClock, messageEvent } from './fakes.mjs';

const CHAT = 'oc_only_me';
const NONCE = 'nonce-for-tests-0123456789';

// -- layer 1: what the CLI printed -------------------------------------------

// The exact bytes `message.js` produces: `JSON.stringify({...}, null, 2)`, so
// success is multi-line. A parser written against a single line would pass a
// hand-written fixture and fail the real thing.
const CLI_SUCCESS = '{\n  "message_id": "om_real_1",\n  "chat_id": "oc_only_me",\n  "create_time": "1761400000000"\n}\n';

test('a success is only a success when a string message_id came back', () => {
  const ok = readCliResult(CLI_SUCCESS);
  assert.equal(ok.ok, true);
  assert.equal(ok.messageId, 'om_real_1');
  assert.equal(ok.chatId, 'oc_only_me');
  assert.equal(ok.error, null);

  // `message.js` reads `res.data?.message_id`, so a success envelope carrying
  // no data serialises to `{}`. That is a failure, not a send with a field
  // missing: there is no message in the chat to point at.
  for (const text of ['{}', '{"message_id": null}', '{"message_id": ""}', '{"message_id": 7}']) {
    const read = readCliResult(text);
    assert.equal(read.ok, false, `${text} must not count as a send`);
    assert.match(read.error, /no message_id/);
  }
});

test('the CLI printing `undefined` is a failure, loudly', () => {
  // Reproduced from the real binary: `feishu-lark call feishu_chat --help`
  // prints exactly this and exits 0, because `cmdCall` skips the zod schema and
  // `console.log(undefined)` stringifies. Anything keying off the exit status
  // reports this as a successful send.
  const read = readCliResult('undefined\n');
  assert.equal(read.ok, false);
  assert.equal(read.messageId, null);
  assert.match(read.error, /undefined/);
  assert.match(read.error, /nothing was sent/);
});

test('a returned error object is a failure and keeps the CLI\'s own words', () => {
  const read = readCliResult('{"error":"需要用户授权。请先运行 feishu_auth 工具完成飞书登录授权。\\n缺少的权限: im:chat:read"}');
  assert.equal(read.ok, false);
  assert.match(read.error, /需要用户授权/);
  assert.match(read.error, /im:chat:read/, 'the missing scope is the whole diagnostic; it must survive');
  assert.equal(read.rateLimited, false);
});

test('anything that is not an object with a message_id is a failure', () => {
  for (const text of ['', '   ', 'Error: boom\n    at x', '[]', 'null', '42', '"om_1"', '{oops']) {
    const read = readCliResult(text);
    assert.equal(read.ok, false, `${JSON.stringify(text)} must not count as a send`);
    assert.equal(read.messageId, null);
    assert.ok(typeof read.error === 'string' && read.error.length > 0);
  }
  assert.equal(readCliResult(undefined).ok, false);
  assert.equal(readCliResult(Buffer.from(CLI_SUCCESS)).ok, false, 'a Buffer is not the string contract');
});

test('a long non-JSON stdout is clipped rather than pasted whole into failures', () => {
  const read = readCliResult('x'.repeat(5000));
  assert.equal(read.ok, false);
  assert.ok(read.error.length < 400, `a failure line must stay readable, got ${read.error.length}`);
  assert.match(read.error, /5000 chars/);
});

test('throttling is recognised from prose, because the numeric code is gone by then', () => {
  for (const message of [
    'Too Many Request', 'too many requests', 'rate limit exceeded',
    'request frequency exceeds the limit', 'too frequent, please retry',
    '请求频率超过限制', '操作过于频繁', 'code 99991400',
  ]) {
    assert.equal(looksRateLimited(message), true, `${message} should read as throttling`);
  }
  for (const message of [
    '需要用户授权', 'permission denied', 'chat not found', '', 'invalid request', null,
  ]) {
    assert.equal(looksRateLimited(message), false, `${JSON.stringify(message)} is not throttling`);
  }
  assert.equal(readCliResult('{"error":"Too Many Request"}').rateLimited, true);
  assert.equal(readCliResult('{"error":"chat not found"}').rateLimited, false);
});

// -- layer 2: the argument object --------------------------------------------

test('a text send becomes a send action addressed by chat id', () => {
  const { tool, args } = toCliInvocation({
    op: OPS.sendMessage, receiveId: CHAT, msgType: 'text', content: { text: 'hi' },
  });
  assert.equal(tool, CLI_TOOL);
  assert.deepEqual(args, {
    action: 'send',
    send_as: 'user',
    receive_id_type: 'chat_id',
    receive_id: CHAT,
    msg_type: 'text',
    content: '{"text":"hi"}',
  });
});

test('content crosses as a JSON string, not as an object', () => {
  const { args } = toCliInvocation({
    op: OPS.sendMessage, receiveId: CHAT, msgType: 'interactive',
    content: { schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'x' }] } },
  });
  // The CLI hands `content` straight to the SDK, which wants a string. An
  // object here is rejected by the platform as a malformed card, two hops away
  // from the mistake.
  assert.equal(typeof args.content, 'string');
  assert.deepEqual(JSON.parse(args.content), {
    schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'x' }] },
  });
  // And not double-encoded: a string content is passed through untouched.
  const already = toCliInvocation({
    op: OPS.sendMessage, receiveId: CHAT, msgType: 'text', content: '{"text":"hi"}',
  });
  assert.equal(already.args.content, '{"text":"hi"}');
});

test('the destination is the op\'s, verbatim', () => {
  const { args } = toCliInvocation({
    op: OPS.sendMessage, receiveId: 'oc_somewhere_else', msgType: 'text', content: { text: 'x' },
  });
  assert.equal(args.receive_id, 'oc_somewhere_else');
  assert.notEqual(args.receive_id, CHAT);
  // `receive_id_type` decides what `receive_id` *means*. Flipping it to
  // `open_id` turns a chat id into a (nonexistent) person and the message
  // vanishes, so it is asserted rather than assumed.
  assert.equal(args.receive_id_type, 'chat_id');
  const explicit = toCliInvocation({
    op: OPS.sendMessage, receiveId: 'ou_x', receiveIdType: 'open_id', msgType: 'text', content: {},
  });
  assert.equal(explicit.args.receive_id_type, 'open_id');
});

test('it sends as the person by default, and as the app only when asked', () => {
  // Load-bearing for the premise: the chat is a group with exactly one member.
  // Sending as a bot requires the bot to join it, which makes that false.
  assert.equal(toCliInvocation({ op: OPS.sendMessage, receiveId: CHAT, msgType: 'text', content: {} }).args.send_as, 'user');
  assert.equal(toCliInvocation({ op: OPS.sendMessage, receiveId: CHAT, msgType: 'text', content: {} }, { sendAs: 'bot' }).args.send_as, 'bot');
  assert.throws(
    () => toCliInvocation({ op: OPS.sendMessage, receiveId: CHAT, msgType: 'text', content: {} }, { sendAs: 'tenant' }),
    TypeError,
  );
});

test('a uuid rides along when given and is absent when not', () => {
  const withUuid = toCliInvocation({
    op: OPS.sendMessage, receiveId: CHAT, msgType: 'text', content: {}, uuid: 'run-1-7',
  });
  assert.equal(withUuid.args.uuid, 'run-1-7');
  const without = toCliInvocation({ op: OPS.sendMessage, receiveId: CHAT, msgType: 'text', content: {} });
  assert.ok(!('uuid' in without.args), 'an absent uuid must be absent, not null');
});

test('a replyTo becomes the reply action and stops naming a chat', () => {
  const { args } = toCliInvocation({
    op: OPS.sendMessage, receiveId: CHAT, msgType: 'text', content: { text: 'ok' },
    replyTo: 'om_trigger', replyInThread: true,
  });
  assert.equal(args.action, 'reply');
  assert.equal(args.message_id, 'om_trigger');
  assert.equal(args.reply_in_thread, true);
  // The reply endpoint takes the chat from the message being replied to.
  // Sending both is how you get a reply posted twice.
  assert.ok(!('receive_id' in args));
  assert.ok(!('receive_id_type' in args));
  // An empty replyTo is not a reply.
  assert.equal(
    toCliInvocation({ op: OPS.sendMessage, receiveId: CHAT, msgType: 'text', content: {}, replyTo: '' }).args.action,
    'send',
  );
});

test('every CardKit operation throws instead of answering plausibly', () => {
  // The dangerous alternative is returning `{ code: 0, data: { card_id } }`:
  // `daemon.mjs` reads `created.data.card_id`, so a fabricated id would let the
  // relay stream twenty deltas into an entity that does not exist and record
  // zero failures while the chat shows nothing.
  for (const op of [OPS.createCardEntity, OPS.updateCardEntity, OPS.cardSettings, OPS.streamText, OPS.patchCard]) {
    assert.throws(
      () => toCliInvocation({ op, cardId: 'c1', messageId: 'om_1', elementId: 'e', content: 'x', sequence: 1 }),
      (error) => error instanceof UnsupportedOp && error.op === op,
      `${op} must be refused`,
    );
  }
  assert.throws(() => toCliInvocation({ op: 'message.yolo' }), UnsupportedOp);
  assert.throws(() => toCliInvocation(null), UnsupportedOp);
});

test('a send missing a field the CLI needs is refused here, not discovered later', () => {
  assert.throws(() => toCliInvocation({ op: OPS.sendMessage, msgType: 'text', content: {} }), TypeError);
  assert.throws(() => toCliInvocation({ op: OPS.sendMessage, receiveId: CHAT, content: {} }), TypeError);
  assert.throws(() => toCliInvocation({ op: OPS.sendMessage, receiveId: CHAT, msgType: '', content: {} }), TypeError);
  assert.throws(() => toCliInvocation({ op: OPS.sendMessage, receiveId: '', msgType: 'text', content: {} }), TypeError);
});

// -- layer 3a: the sink over an injected fetch -------------------------------

function fetchStub(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return handler(calls.length, init);
  };
  fn.calls = calls;
  return fn;
}

const jsonResponse = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

test('a permitted send posts the invocation and returns a platform-shaped envelope', async () => {
  const fetchImpl = fetchStub(() => jsonResponse(200, { ok: true, messageId: 'om_1' }));
  const sink = feishuSink({ endpoint: 'http://127.0.0.1:1/send', nonce: NONCE, fetch: fetchImpl });
  const result = await sink.perform({ op: OPS.sendMessage, receiveId: CHAT, msgType: 'text', content: { text: 'hi' } });

  assert.equal(fetchImpl.calls.length, 1);
  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'http://127.0.0.1:1/send');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers[NONCE_HEADER], NONCE, 'without the nonce the shim refuses');
  assert.equal(call.body.tool, CLI_TOOL);
  assert.equal(call.body.args.receive_id, CHAT);
  assert.deepEqual(result, { code: 0, msg: 'success', data: { message_id: 'om_1' } });
});

test('a CardKit op never reaches the wire', async () => {
  const fetchImpl = fetchStub(() => jsonResponse(200, { ok: true, messageId: 'om_1' }));
  const sink = feishuSink({ endpoint: 'http://127.0.0.1:1/send', nonce: NONCE, fetch: fetchImpl });
  await assert.rejects(
    () => sink.perform({ op: OPS.createCardEntity, card: {}, forChat: CHAT }),
    UnsupportedOp,
  );
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(sink.allowCard, undefined, 'no allowCard, so wiring this in bare fails loudly');
});

test('a refusal from the shim becomes a throw carrying the shim\'s reason', async () => {
  const fetchImpl = fetchStub(() => jsonResponse(502, { ok: false, error: '需要用户授权', rateLimited: false }));
  const sink = feishuSink({ endpoint: 'http://127.0.0.1:1/send', nonce: NONCE, fetch: fetchImpl });
  await assert.rejects(
    () => sink.perform({ op: OPS.sendMessage, receiveId: CHAT, msgType: 'text', content: {} }),
    (error) => error instanceof CliRefused && /需要用户授权/.test(error.message) && error.code === undefined,
  );
});

test('a throttled refusal carries the code the daemon backs off on', async () => {
  const fetchImpl = fetchStub(() => jsonResponse(502, { ok: false, error: 'Too Many Request', rateLimited: true }));
  const sink = feishuSink({ endpoint: 'http://127.0.0.1:1/send', nonce: NONCE, fetch: fetchImpl });
  await assert.rejects(
    () => sink.perform({ op: OPS.sendMessage, receiveId: CHAT, msgType: 'text', content: {} }),
    (error) => error.code === RATE_LIMIT_CODE,
  );
});

test('a shim that is not there, or answers nonsense, is a failure and not a send', async () => {
  const dead = feishuSink({
    endpoint: 'http://127.0.0.1:1/send', nonce: NONCE,
    fetch: async () => { throw new Error('ECONNREFUSED'); },
  });
  await assert.rejects(
    () => dead.perform({ op: OPS.sendMessage, receiveId: CHAT, msgType: 'text', content: {} }),
    (error) => error instanceof CliRefused && /did not answer/.test(error.message),
  );

  const garbled = feishuSink({
    endpoint: 'http://127.0.0.1:1/send', nonce: NONCE,
    fetch: async () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError('nope'); } }),
  });
  await assert.rejects(
    () => garbled.perform({ op: OPS.sendMessage, receiveId: CHAT, msgType: 'text', content: {} }),
    CliRefused,
  );

  // The one a careless implementation would let through: 200, ok:true, no id.
  const empty = feishuSink({
    endpoint: 'http://127.0.0.1:1/send', nonce: NONCE,
    fetch: async () => jsonResponse(200, { ok: true }),
  });
  await assert.rejects(
    () => empty.perform({ op: OPS.sendMessage, receiveId: CHAT, msgType: 'text', content: {} }),
    (error) => /without a message id/.test(error.message),
  );
});

test('a shim that never answers is abandoned instead of wedging the tick', async () => {
  const sink = feishuSink({
    endpoint: 'http://127.0.0.1:1/send', nonce: NONCE, timeoutMs: 20,
    fetch: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  await assert.rejects(
    () => sink.perform({ op: OPS.sendMessage, receiveId: CHAT, msgType: 'text', content: {} }),
    CliRefused,
  );
});

test('a sink with no nonce, no endpoint or no fetch refuses to exist', () => {
  assert.throws(() => feishuSink({ nonce: NONCE }), TypeError);
  assert.throws(() => feishuSink({ endpoint: 'http://x/send' }), TypeError);
  assert.throws(() => feishuSink({ endpoint: 'http://x/send', nonce: '' }), TypeError);
  assert.throws(() => feishuSink({ endpoint: 'http://x/send', nonce: NONCE, fetch: null }), TypeError);
  assert.throws(() => feishuSink({ endpoint: 'http://x/send', nonce: NONCE, timeoutMs: 0 }), RangeError);
});

// -- layer 3b: the shim, with a real stub executable -------------------------

/**
 * Write an executable that stands in for `feishu-lark`.
 *
 * A real file run through a real `execFile` rather than an injected function,
 * because the argv round trip is part of what is being tested: the stub records
 * the JSON it was actually handed, so an assertion can look at what crossed the
 * process boundary instead of at what the caller meant to send.
 */
async function stubCli(mode) {
  const dir = await mkdtemp(path.join(tmpdir(), 'feishu-stub-'));
  const record = path.join(dir, 'received.json');
  const bin = path.join(dir, 'feishu-lark-stub.mjs');
  const bodies = {
    success: JSON.stringify(CLI_SUCCESS),
    error: JSON.stringify('{"error":"需要用户授权。缺少的权限: im:message"}\n'),
    throttled: JSON.stringify('{"error":"Too Many Request"}\n'),
    undef: JSON.stringify('undefined\n'),
    junk: JSON.stringify('Error: ENOENT\n    at Object.<anonymous>\n'),
    silent: JSON.stringify(''),
  };
  if (!Object.hasOwn(bodies, mode)) throw new Error(`no stub mode ${mode}`);
  await writeFile(bin, [
    '#!/usr/bin/env node',
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));`,
    `process.stdout.write(${bodies[mode]});`,
    // Every mode exits 0, which is the real CLI's behaviour and the entire
    // reason the stdout contract has to carry the decision.
    'process.exit(0);',
  ].join('\n'), 'utf8');
  await chmod(bin, 0o755);
  return {
    bin,
    dir,
    async received() { return JSON.parse(await readFile(record, 'utf8')); },
    async cleanup() { await rm(dir, { recursive: true, force: true }); },
  };
}

test('runCli decides on stdout, not on the exit code, for all four observed shapes', async () => {
  const expected = [
    ['success', true, null],
    ['error', false, /im:message/],
    ['undef', false, /undefined/],
    ['junk', false, /not JSON/],
    ['silent', false, /printed nothing/],
  ];
  for (const [mode, ok, pattern] of expected) {
    const stub = await stubCli(mode);
    try {
      const outcome = await runCli({ cli: stub.bin, tool: CLI_TOOL, args: { action: 'send', receive_id: CHAT } });
      assert.equal(outcome.ok, ok, `${mode} (the stub exits 0 in every mode)`);
      if (pattern !== null) assert.match(outcome.error, pattern);
      if (ok) assert.equal(outcome.messageId, 'om_real_1');
      // What the CLI was actually handed, read back out of the child process.
      const argv = await stub.received();
      assert.deepEqual(argv.slice(0, 2), ['call', CLI_TOOL]);
      assert.deepEqual(JSON.parse(argv[2]), { action: 'send', receive_id: CHAT });
    } finally {
      await stub.cleanup();
    }
  }
});

test('runCli reports a throttled refusal as throttled', async () => {
  const stub = await stubCli('throttled');
  try {
    const outcome = await runCli({ cli: stub.bin, tool: CLI_TOOL, args: { action: 'send' } });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.rateLimited, true);
  } finally {
    await stub.cleanup();
  }
});

test('a CLI that cannot be run at all is a failure, not a crash', async () => {
  const outcome = await runCli({
    cli: path.join(tmpdir(), 'definitely-not-a-binary-9f2a'), tool: CLI_TOOL, args: {},
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /could not be run|ENOENT/);
});

test('the screen refuses anything it cannot attribute to an allowed chat', () => {
  const config = { chats: [CHAT], sendAs: 'user' };
  const good = { tool: CLI_TOOL, args: { action: 'send', send_as: 'user', receive_id_type: 'chat_id', receive_id: CHAT, content: '{}' } };
  assert.equal(screen(good, config), null);

  const refusals = [
    [{ ...good, args: { ...good.args, receive_id: 'oc_the_internal_group' } }, 403, /allowlist/],
    [{ ...good, args: { ...good.args, action: 'reply', message_id: 'om_1' } }, 403, /send/],
    [{ ...good, args: { ...good.args, receive_id_type: 'open_id' } }, 403, /chat_id/],
    [{ ...good, args: { ...good.args, send_as: 'bot' } }, 403, /sends as/],
    [{ ...good, args: { ...good.args, content: { text: 'hi' } } }, 400, /string/],
    [{ ...good, tool: 'feishu_chat' }, 400, /only runs/],
    [{ ...good, args: null }, 400, /args/],
    [null, 400, /object/],
  ];
  for (const [body, status, pattern] of refusals) {
    const refusal = screen(body, config);
    assert.notEqual(refusal, null, `${JSON.stringify(body).slice(0, 80)} must be refused`);
    assert.equal(refusal.status, status);
    assert.match(refusal.error, pattern);
  }
  // The refusal must not teach the caller the id it got wrong.
  const leak = screen({ ...good, args: { ...good.args, receive_id: 'oc_the_internal_group' } }, config);
  assert.ok(!leak.error.includes('oc_the_internal_group'));
  assert.ok(!leak.error.includes(CHAT));
});

test('the solo-chat check reads the counts where the CLI actually puts them', () => {
  // `feishu_chat get` answers `JSON.stringify({ chat: res.data })` and the
  // platform sends the counts as decimal strings. The first version of this
  // read `parsed.user_count` and compared against the number 1, so it was
  // wrong twice over and reported `user_count=?` followed by OK -- a safety
  // check whose evidence was a constant. This is the shape it must handle.
  const real = { chat: { chat_id: 'oc_x', name: 'me', user_count: '1', bot_count: '0' } };
  assert.deepEqual(readChatCounts(real), { users: 1, bots: 0, solo: true });

  // Someone else is in there: this is the case the whole mode exists to catch.
  assert.equal(readChatCounts({ chat: { user_count: '2', bot_count: '0' } }).solo, false);
  assert.equal(readChatCounts({ chat: { user_count: '1', bot_count: '1' } }).solo, false);

  // Unreadable is not solo. "I could not check" must not render as "fine".
  for (const shape of [{}, { chat: {} }, { chat: { user_count: '1' } }, { chat: { user_count: 'x', bot_count: '0' } },
    { chat: { user_count: null, bot_count: 0 } }, { chat: { user_count: '1.0', bot_count: '0' } }]) {
    assert.equal(readChatCounts(shape).solo, false, `${JSON.stringify(shape)} must not read as solo`);
  }

  // Numbers are accepted too, in case the SDK ever stops stringifying them.
  assert.equal(readChatCounts({ chat: { user_count: 1, bot_count: 0 } }).solo, true);
});

test('readConfig refuses a configuration that would leave the endpoint open', () => {
  assert.throws(() => readConfig({ FEISHU_SHIM_CHATS: CHAT }), /NONCE/);
  assert.throws(() => readConfig({ FEISHU_SHIM_NONCE: 'short', FEISHU_SHIM_CHATS: CHAT }), /NONCE/);
  assert.throws(() => readConfig({ FEISHU_SHIM_NONCE: NONCE }), /CHATS/);
  assert.throws(() => readConfig({ FEISHU_SHIM_NONCE: NONCE, FEISHU_SHIM_CHATS: ' , ' }), /CHATS/);
  assert.throws(() => readConfig({ FEISHU_SHIM_NONCE: NONCE, FEISHU_SHIM_CHATS: CHAT, FEISHU_SHIM_PORT: 'x' }), /PORT/);
  const config = readConfig({ FEISHU_SHIM_NONCE: NONCE, FEISHU_SHIM_CHATS: ` ${CHAT} , oc_b ` });
  assert.deepEqual(config.chats, [CHAT, 'oc_b']);
  assert.equal(config.sendAs, 'user', 'bot is opt-in; it would require joining the chat');
});

/** Start the shim on an ephemeral loopback port. */
async function liveShim(stub, { chats = [CHAT] } = {}) {
  const config = { nonce: NONCE, chats, port: 0, cli: stub.bin, sendAs: 'user' };
  const server = createShim(config);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    endpoint: `http://127.0.0.1:${port}/send`,
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}

test('the shim runs the CLI only for a caller that knows the nonce', async () => {
  const stub = await stubCli('success');
  const shim = await liveShim(stub);
  try {
    const body = JSON.stringify({ tool: CLI_TOOL, args: { action: 'send', send_as: 'user', receive_id_type: 'chat_id', receive_id: CHAT, msg_type: 'text', content: '{"text":"hi"}' } });
    const headers = { 'content-type': 'application/json' };

    const anonymous = await fetch(shim.endpoint, { method: 'POST', headers, body });
    assert.equal(anonymous.status, 401);
    await assert.rejects(stub.received(), 'the CLI must not have run');

    const wrong = await fetch(shim.endpoint, { method: 'POST', headers: { ...headers, [NONCE_HEADER]: `${NONCE}x` }, body });
    assert.equal(wrong.status, 401);
    await assert.rejects(stub.received(), 'a near-miss nonce must not run the CLI either');

    const right = await fetch(shim.endpoint, { method: 'POST', headers: { ...headers, [NONCE_HEADER]: NONCE }, body });
    assert.equal(right.status, 200);
    assert.deepEqual(await right.json(), { ok: true, messageId: 'om_real_1' });
    assert.deepEqual(JSON.parse((await stub.received())[2]).receive_id, CHAT);
  } finally {
    await shim.close();
    await stub.cleanup();
  }
});

test('the shim answers a business refusal as a refusal, with 200 reserved for a real send', async () => {
  const stub = await stubCli('undef');
  const shim = await liveShim(stub);
  try {
    const response = await fetch(shim.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [NONCE_HEADER]: NONCE },
      body: JSON.stringify({ tool: CLI_TOOL, args: { action: 'send', send_as: 'user', receive_id_type: 'chat_id', receive_id: CHAT, msg_type: 'text', content: '{}' } }),
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /undefined/);
  } finally {
    await shim.close();
    await stub.cleanup();
  }
});

test('the shim refuses a route and a body it was not built for', async () => {
  const stub = await stubCli('success');
  const shim = await liveShim(stub);
  try {
    const root = shim.endpoint.replace('/send', '/');
    assert.equal((await fetch(root, { method: 'POST', headers: { [NONCE_HEADER]: NONCE } })).status, 404);
    assert.equal((await fetch(shim.endpoint, { method: 'GET', headers: { [NONCE_HEADER]: NONCE } })).status, 404);
    const notJson = await fetch(shim.endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', [NONCE_HEADER]: NONCE }, body: 'not json',
    });
    assert.equal(notJson.status, 400);
    const huge = await fetch(shim.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [NONCE_HEADER]: NONCE },
      body: JSON.stringify({ tool: CLI_TOOL, args: { content: 'x'.repeat(100 * 1024) } }),
    }).catch((error) => ({ status: `threw: ${error.message}` }));
    assert.ok(huge.status === 413 || String(huge.status).startsWith('threw'), `got ${huge.status}`);
    await assert.rejects(stub.received(), 'none of those may have reached the CLI');
  } finally {
    await shim.close();
    await stub.cleanup();
  }
});

/** One send through a live shim, as the daemon would phrase it. */
function sendTo(endpoint, receiveId) {
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [NONCE_HEADER]: NONCE },
    body: JSON.stringify({
      tool: CLI_TOOL,
      args: {
        action: 'send', send_as: 'user', receive_id_type: 'chat_id',
        receive_id: receiveId, msg_type: 'text', content: '{"text":"hi"}',
      },
    }),
  });
}

test('a chat id that merely resembles an allowed one is not an allowed chat', async () => {
  // The allowlist comment calls itself a fuse: it is the last thing between a
  // turn and the wrong group. So the only match it may make is equality.
  //
  // The file's one existing negative used `oc_the_internal_group`, an id with
  // nothing in common with the allowed one. That distinguishes "exact hit"
  // from "utterly unrelated" and nothing else, which means an entire class of
  // bug -- the comparison quietly getting *looser* -- was invisible: replacing
  // `chats.includes(id)` with `chats.some((c) => c.startsWith(id))` or with a
  // `toLowerCase()` comparison left all 1748 tests green. Each id below is one
  // such relaxation away from CHAT, and each is a plausible thing to write.
  const stub = await stubCli('success');
  const shim = await liveShim(stub);
  try {
    const nearMisses = [
      ['oc_only', 'a strict prefix of an allowed id addresses a different chat (kills `startsWith`)'],
      ['oc_only_me_and_the_team', 'an allowed id being a prefix of this one buys it nothing'],
      ['OC_ONLY_ME', 'chat ids are compared byte for byte, never case-folded'],
      [`${CHAT} `, 'trailing whitespace is not trimmed into a match at send time'],
      [CHAT.slice(1), 'dropping a leading character does not land back inside the allowlist'],
    ];
    for (const [receiveId, why] of nearMisses) {
      const response = await fetch(shim.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [NONCE_HEADER]: NONCE },
        body: JSON.stringify({
          tool: CLI_TOOL,
          args: {
            action: 'send', send_as: 'user', receive_id_type: 'chat_id',
            receive_id: receiveId, msg_type: 'text', content: '{"text":"hi"}',
          },
        }),
      });
      assert.equal(response.status, 403, why);
      await response.text();
      // The status is not the thing that matters. What matters is that no argv
      // ever crossed into the CLI, because that -- not the HTTP code -- is what
      // decides whether a message was addressed to a chat nobody allowed.
      await assert.rejects(stub.received(), `${why}: nothing may have reached the CLI`);
    }

    // The positive control, last: without it every assertion above would still
    // pass on a shim that had been broken into refusing everything.
    const allowed = await sendTo(shim.endpoint, CHAT);
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { ok: true, messageId: 'om_real_1' });
    assert.equal(JSON.parse((await stub.received())[2]).receive_id, CHAT);
  } finally {
    await shim.close();
    await stub.cleanup();
  }
});

test('an empty allowlist permits nothing, instead of failing open to every chat', async () => {
  // The relay side has `an allowlist sink with no chats permits nothing`; the
  // shim side had no equivalent, so `(chats.length > 0 && !chats.includes(id))`
  // -- fail-open on an empty list -- survived the whole suite.
  //
  // `readConfig` does refuse an empty FEISHU_SHIM_CHATS (asserted below, and
  // separately in the readConfig test), so this state is not reachable through
  // the documented startup path. It is pinned anyway because `screen` and
  // `createShim` are exported: the fuse must hold on its own terms rather than
  // on another function elsewhere having been called first.
  assert.throws(
    () => readConfig({ FEISHU_SHIM_NONCE: NONCE, FEISHU_SHIM_CHATS: '' }),
    /CHATS/,
    'config must refuse an empty allowlist rather than start with one',
  );

  const stub = await stubCli('success');
  const shim = await liveShim(stub, { chats: [] });
  try {
    for (const receiveId of [CHAT, 'oc_anything_at_all', '']) {
      const response = await sendTo(shim.endpoint, receiveId);
      assert.equal(response.status, 403, `${receiveId || '(empty)'} must be refused by an empty allowlist`);
      await response.text();
      await assert.rejects(stub.received(), 'an empty allowlist must not let anything reach the CLI');
    }
    // And at the policy function directly, so the refusal is attributable to
    // the allowlist check rather than to some earlier shape check.
    const good = {
      tool: CLI_TOOL,
      args: { action: 'send', send_as: 'user', receive_id_type: 'chat_id', receive_id: CHAT, content: '{}' },
    };
    assert.equal(screen(good, { chats: [CHAT], sendAs: 'user' }), null, 'premise: this body is otherwise fine');
    const refused = screen(good, { chats: [], sendAs: 'user' });
    assert.notEqual(refused, null, 'an empty allowlist must not permit the body it would otherwise permit');
    assert.equal(refused.status, 403);
    assert.match(refused.error, /allowlist/);
  } finally {
    await shim.close();
    await stub.cleanup();
  }
});

// -- layer 4: a relay in snapshot mode ---------------------------------------

function snapshotRelay({
  sink, chats = [CHAT], cardIntervalMs = null, detail = DETAIL.full, laneBy = 'chat',
} = {}) {
  const clock = fakeClock(0);
  const client = (() => {
    const handlers = [];
    let threads = 0;
    let turns = 0;
    return {
      on(method, handler) { handlers.push({ method, handler }); return () => {}; },
      notify(method, params) {
        for (const h of handlers) if (h.method === '*' || h.method === method) h.handler(params, method);
      },
      async call(method) {
        if (method === 'thread/start') return { threadId: `th_${++threads}` };
        if (method === 'turn/start') return { turnId: `tn_${++turns}` };
        return {};
      },
    };
  })();
  const link = harnessConnection();
  const relay = new Relay({
    gate: new InboundGate({ chats, laneBy }),
    dispatcher: new Dispatcher(),
    drafts: new DraftBook({ chats }),
    sink,
    client,
    connection: link,
    now: () => clock.now,
    fetchEnds: async () => [{ end: 'end-1', busy: false }],
    cardStrategy: CARD_STRATEGY.snapshot,
    cardIntervalMs,
    detail,
  });
  return { relay, clock, client, link };
}

/** A sink that records what it was asked to do and can be made to fail. */
function spySink({ fail = null } = {}) {
  const ops = [];
  return {
    ops,
    sealed: false,
    of(kind) { return ops.filter((o) => o.op === kind); },
    get cards() { return ops.filter((o) => o.op === OPS.sendMessage && o.msgType === 'interactive'); },
    async perform(op) {
      ops.push(structuredClone(op));
      const error = fail?.(op, ops.length);
      if (error) throw error;
      return { code: 0, msg: 'success', data: { message_id: `om_${ops.length}` } };
    },
  };
}

async function runTurn(h, deltas) {
  h.link.deliver(messageEvent({ chatId: CHAT, text: 'go' }));
  await h.relay.drain(h.clock.now);
  // `turn/started` is what puts the projection into `running`, and `running` is
  // the only status under which `renderCard` will consider emitting the
  // interrupt button. Without this notification every "there is no button"
  // assertion below passes for the wrong reason -- the card has no button
  // because the turn never started, not because snapshot mode suppressed it --
  // and a mutation flipping `interrupt: false` to `true` survives. It did.
  h.client.notify('turn/started', { threadId: 'th_1', turnId: 'tn_1' });
  h.client.notify('item/started', { threadId: 'th_1', itemId: 'it_1', kind: 'agentMessage' });
  for (const delta of deltas) {
    h.client.notify('item/agentMessage/delta', { itemId: 'it_1', delta });
    await h.relay.flushCards(h.clock.now);
    h.clock.advance(SNAPSHOT_INTERVAL_MS);
  }
}

test('snapshot mode posts whole cards as messages and asks for no CardKit at all', async () => {
  const spy = spySink();
  const h = snapshotRelay({ sink: allowlistSink({ inner: spy, chats: [CHAT] }) });
  await h.relay.start();
  await h.relay.tick(h.clock.now);
  await runTurn(h, ['hello ', 'world']);

  for (const op of [OPS.createCardEntity, OPS.updateCardEntity, OPS.cardSettings, OPS.streamText, OPS.patchCard]) {
    assert.equal(spy.of(op).length, 0, `${op} has no CLI behind it and must never be asked for`);
  }
  assert.ok(spy.cards.length >= 2, `expected a card per flush, got ${spy.cards.length}`);

  const card = spy.cards.at(-1).content;
  // Routing, against the lane's own record. Under the default `laneBy: 'chat'`
  // the lane key and the chat id are the same string, so this pair cannot by
  // itself tell a send addressed by chat id from one addressed by lane key --
  // the threaded test below is what separates them.
  const [lane] = h.relay.snapshot().lanes;
  assert.equal(spy.cards.at(-1).receiveId, lane.chatId);
  assert.equal(spy.cards.at(-1).receiveId, CHAT);
  assert.equal(card.schema, '2.0');
  // Streaming mode holds the entity in a mode that expires in ten minutes and
  // makes the client wait for text that is never coming.
  assert.equal(card.config.streaming_mode, false);
  assert.ok(!('streaming_config' in card.config));
  // The interrupt button is a card callback and nothing on this route answers
  // callbacks, so a button here would be dead on the person's screen. This only
  // means anything while the turn is running -- a finished turn has no button
  // at any setting -- so the status is asserted first.
  assert.equal(lane.status, TURN_STATUS.running, 'premise: a finished turn never has a button');
  const tags = JSON.stringify(card.body.elements);
  assert.ok(!tags.includes('"button"'), `no dead buttons: ${tags.slice(0, 200)}`);
  assert.match(JSON.stringify(card), /world/, 'the delta must actually be in the card');
});

test('a threaded lane is still addressed by chat id, not by lane key', async () => {
  // `InboundGate` keys a lane as `${chatId}#${threadId}` under `laneBy: 'thread'`,
  // so this is the only configuration in which "post to the lane" and "post to
  // the chat" are distinguishable. They have to be distinguishable somewhere:
  // a lane key is not a chat id, the allowlist would refuse it, and a relay
  // that pointed sends at lane keys would be dead on arrival for every threaded
  // chat while every chat-laned test stayed green.
  const spy = spySink();
  const h = snapshotRelay({ sink: allowlistSink({ inner: spy, chats: [CHAT] }), laneBy: 'thread' });
  await h.relay.start();
  await h.relay.tick(h.clock.now);
  h.link.deliver(messageEvent({ chatId: CHAT, text: 'go', threadId: 'omt_thread_1' }));
  await h.relay.drain(h.clock.now);
  h.client.notify('turn/started', { threadId: 'th_1', turnId: 'tn_1' });
  h.client.notify('item/started', { threadId: 'th_1', itemId: 'it_1', kind: 'agentMessage' });
  h.client.notify('item/agentMessage/delta', { itemId: 'it_1', delta: 'hi' });
  await h.relay.flushCards(h.clock.now);

  const [lane] = h.relay.snapshot().lanes;
  assert.equal(lane.lane, `${CHAT}#omt_thread_1`, 'premise: the lane key differs from the chat id');
  assert.equal(lane.chatId, CHAT);
  assert.equal(spy.cards.length, 1);
  assert.equal(spy.cards[0].receiveId, CHAT, 'a lane key is not an address');
});

test('an unlisted chat is stopped by the allowlist before the sink sees it', async () => {
  const spy = spySink();
  const h = snapshotRelay({ sink: allowlistSink({ inner: spy, chats: [CHAT] }) });
  await h.relay.start();
  await h.relay.tick(h.clock.now);
  await assert.rejects(
    () => h.relay.flushCards(h.clock.now).then(() => allowlistSink({ inner: spy, chats: [CHAT] })
      .perform({ op: OPS.sendMessage, receiveId: 'oc_the_internal_group', msgType: 'interactive', content: {} })),
    OutboundSealed,
  );
  assert.equal(spy.ops.length, 0);
});

test('each flush carries a uuid that is stable per revision and unique per lane', async () => {
  const spy = spySink();
  const h = snapshotRelay({ sink: allowlistSink({ inner: spy, chats: [CHAT] }) });
  await h.relay.start();
  await h.relay.tick(h.clock.now);
  await runTurn(h, ['a', 'b', 'c']);

  const uuids = spy.cards.map((o) => o.uuid);
  assert.equal(new Set(uuids).size, uuids.length, `two frames sharing a uuid would be silently dropped: ${uuids}`);
  for (const uuid of uuids) {
    assert.equal(typeof uuid, 'string');
    // The platform caps a send uuid at 50 characters and ignores the message
    // otherwise, which looks exactly like a card that never arrived.
    assert.ok(uuid.length > 0 && uuid.length <= 50, `uuid ${uuid} is ${uuid.length} chars`);
  }
});

test('a retry of the same revision reuses the uuid, so a maybe-sent frame is not duplicated', async () => {
  let thrown = 0;
  const spy = spySink({
    fail: (op) => (op.msgType === 'interactive' && thrown++ === 0 ? new Error('the shim did not answer') : null),
  });
  const h = snapshotRelay({ sink: allowlistSink({ inner: spy, chats: [CHAT] }) });
  await h.relay.start();
  await h.relay.tick(h.clock.now);
  h.link.deliver(messageEvent({ chatId: CHAT, text: 'go' }));
  await h.relay.drain(h.clock.now);
  h.client.notify('item/started', { threadId: 'th_1', itemId: 'it_1', kind: 'agentMessage' });
  h.client.notify('item/agentMessage/delta', { itemId: 'it_1', delta: 'a' });

  await h.relay.flushCards(h.clock.now);              // fails
  assert.equal(h.relay.failures.length, 1, 'the failure must be recorded, not swallowed');
  assert.match(h.relay.failures[0].where, /card/);
  h.clock.advance(SNAPSHOT_INTERVAL_MS * 2);
  await h.relay.flushCards(h.clock.now);              // retries the same revision

  const attempts = spy.cards;
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].uuid, attempts[1].uuid, 'the retry must be idempotent at the platform');
  assert.deepEqual(attempts[0].content, attempts[1].content);
});

test('a revision that renders identically costs no message and still settles', async () => {
  const spy = spySink();
  // `brief` hides reasoning from the output text, and `activityLines` hides
  // reasoning items at *every* detail level, so reasoning is the one thing a
  // model can stream that moves the revision and renders to the same bytes.
  const h = snapshotRelay({ sink: allowlistSink({ inner: spy, chats: [CHAT] }), detail: DETAIL.brief });
  await h.relay.start();
  await h.relay.tick(h.clock.now);
  h.link.deliver(messageEvent({ chatId: CHAT, text: 'go' }));
  await h.relay.drain(h.clock.now);
  h.client.notify('turn/started', { threadId: 'th_1', turnId: 'tn_1' });
  h.client.notify('item/started', { threadId: 'th_1', itemId: 'it_1', kind: 'agentMessage' });
  h.client.notify('item/agentMessage/delta', { itemId: 'it_1', delta: 'a' });
  await h.relay.flushCards(h.clock.now);
  const after = spy.cards.length;
  assert.equal(after, 1);
  const before = h.relay.snapshot().lanes[0].revision;

  // The first version of this test used `delta: ''`, on the belief that an
  // empty delta bumps the revision. It does not -- `projection.mjs` returns
  // false for it -- so the second flush was never attempted and both
  // assertions below passed while measuring nothing. Deleting the whole
  // `lastCard` comparison from the daemon left this test green. Hence the
  // premise assertion: if the revision does not move, the rest proves nothing.
  h.clock.advance(SNAPSHOT_INTERVAL_MS * 2);
  h.client.notify('item/started', { threadId: 'th_1', itemId: 'it_2', kind: 'reasoning' });
  h.client.notify('item/reasoning/delta', { itemId: 'it_2', delta: 'thinking about it' });
  const moved = h.relay.snapshot().lanes[0].revision;
  assert.ok(moved > before, `premise: the revision must move (${before} -> ${moved})`);
  assert.equal(h.relay.snapshot().lanes[0].pending, moved, 'premise: the pacer wants a write');

  await h.relay.flushCards(h.clock.now);
  assert.equal(spy.cards.length, after, 'an identical card must not be posted again');

  // And it has to be *settled*, or `drainCards` spins to its limit and then
  // records a failure for a card that is perfectly up to date.
  assert.equal(h.relay.snapshot().lanes[0].pending, null, 'the skipped revision must still settle');
  h.clock.advance(SNAPSHOT_INTERVAL_MS * 2);
  await h.relay.drainCards(h.clock.now);
  assert.deepEqual(h.relay.failures, []);
  assert.equal(h.relay.snapshot().lanes[0].pending, null);
});

test('snapshot mode is paced off the per-chat send limit, not the CardKit one', async () => {
  const spy = spySink();
  const h = snapshotRelay({ sink: allowlistSink({ inner: spy, chats: [CHAT] }) });
  // 10/s (CardKit, per entity) would give 134ms; 5/s (per chat, shared with
  // every other bot in it) gives 267ms; the legibility floor raises it again.
  assert.equal(h.relay.minIntervalMs, SNAPSHOT_INTERVAL_MS);
  assert.ok(SNAPSHOT_INTERVAL_MS >= 267, 'the floor must not go below what the platform allows');

  await h.relay.start();
  await h.relay.tick(h.clock.now);
  h.link.deliver(messageEvent({ chatId: CHAT, text: 'go' }));
  await h.relay.drain(h.clock.now);
  h.client.notify('item/started', { threadId: 'th_1', itemId: 'it_1', kind: 'agentMessage' });
  h.client.notify('item/agentMessage/delta', { itemId: 'it_1', delta: 'a' });
  await h.relay.flushCards(h.clock.now);
  const after = spy.cards.length;

  // Well inside the interval: an ordinary delta must be coalesced, or a
  // one-minute turn leaves hundreds of messages behind.
  h.clock.advance(Math.floor(SNAPSHOT_INTERVAL_MS / 3));
  h.client.notify('item/agentMessage/delta', { itemId: 'it_1', delta: 'b' });
  await h.relay.flushCards(h.clock.now);
  assert.equal(spy.cards.length, after, 'an ordinary delta inside the window must be coalesced');

  // The end of the turn is urgent and must not wait the window out.
  h.client.notify('turn/completed', { threadId: 'th_1', turnId: 'tn_1', status: 'completed' });
  await h.relay.flushCards(h.clock.now);
  assert.equal(spy.cards.length, after + 1, 'the final frame must land immediately');
  assert.match(JSON.stringify(spy.cards.at(-1).content), /b/, 'and it must carry the coalesced delta');
});

test('an interval below what the platform permits is refused, not quietly clamped', () => {
  assert.throws(
    () => snapshotRelay({ sink: spySink(), cardIntervalMs: 50 }),
    (error) => error instanceof RangeError && /below the 267ms/.test(error.message),
  );
  // A larger one is honoured exactly.
  const h = snapshotRelay({ sink: spySink(), cardIntervalMs: 9000 });
  assert.equal(h.relay.minIntervalMs, 9000);
  assert.throws(() => snapshotRelay({ sink: spySink(), cardIntervalMs: Number.NaN }), RangeError);
});

test('an unknown card strategy is refused at construction', () => {
  assert.throws(
    () => new Relay({
      gate: new InboundGate({ chats: [CHAT] }), dispatcher: new Dispatcher(), drafts: new DraftBook({ chats: [CHAT] }),
      sink: spySink(), client: { call: async () => ({}), on: () => {} }, connection: harnessConnection(),
      now: () => 0, cardStrategy: 'cardkitt',
    }),
    RangeError,
  );
});

test('a throttled failure backs off strictly longer than an ordinary one', async () => {
  // This is the whole reason `feishu-sink.mjs` re-attaches a code it had to
  // guess at from prose: without it both branches behave identically, and the
  // "we handle throttling" branch in `daemon.mjs` would never run.
  //
  // It is also the test that found the branch was *already* a no-op. The
  // previous backoff was a flat 1000ms, and `CardPacer#poll` waits for the
  // longest of its floors -- so against any coalescing interval of a second or
  // more, which is every snapshot run, a throttle changed nothing at all. It
  // now scales off our own interval, so the assertion below can be about the
  // direction of the difference and not just its existence.
  const INTERVAL = 9000;

  /** When does the next attempt get through, to the nearest second? */
  async function retriesAt(error) {
    const spy = spySink({ fail: (op) => (op.msgType === 'interactive' ? error : null) });
    const h = snapshotRelay({ sink: allowlistSink({ inner: spy, chats: [CHAT] }), cardIntervalMs: INTERVAL });
    await h.relay.start();
    await h.relay.tick(h.clock.now);
    h.link.deliver(messageEvent({ chatId: CHAT, text: 'go' }));
    await h.relay.drain(h.clock.now);
    h.client.notify('item/started', { threadId: 'th_1', itemId: 'it_1', kind: 'agentMessage' });
    h.client.notify('item/agentMessage/delta', { itemId: 'it_1', delta: 'a' });
    await h.relay.flushCards(h.clock.now);           // attempt 1, at t=0, fails
    assert.equal(spy.cards.length, 1);
    for (let t = 1000; t <= 40000; t += 1000) {
      h.clock.now = t;
      await h.relay.flushCards(t);
      if (spy.cards.length > 1) return t;
    }
    return null;
  }

  const throttled = new CliRefused('Too Many Request', { rateLimited: true });
  assert.equal(throttled.code, RATE_LIMIT_CODE, 'the sink must carry the code the daemon reads');

  const ordinary = await retriesAt(new CliRefused('chat not found'));
  const slowed = await retriesAt(throttled);
  assert.equal(ordinary, INTERVAL, 'an ordinary failure waits exactly the coalescing interval');
  assert.equal(slowed, INTERVAL * 2, 'being told to slow down must slow us down, not speed us up');
  assert.ok(slowed > ordinary);
});

test('the throttled backoff holds a second even on the fast CardKit pace', async () => {
  // CardKit's interval is 134ms. Doubling that is 268ms, still inside the
  // one-second window the platform's frequency limits are expressed over, so
  // the floor is what has to bind here -- and a retry at 268ms would be the
  // relay arguing with a server that just told it to stop.
  const clock = fakeClock(0);
  const link = harnessConnection();
  const spy = spySink({
    fail: (op) => (op.op === OPS.streamText
      ? Object.assign(new Error('Too Many Request'), { code: RATE_LIMIT_CODE })
      : null),
  });
  let cards = 0;
  const inner = {
    sealed: false,
    ops: spy.ops,
    async perform(op) {
      if (op.op === OPS.createCardEntity) {
        spy.ops.push(structuredClone(op));
        return { code: 0, msg: 'success', data: { card_id: `c_${++cards}` } };
      }
      return spy.perform(op);
    },
  };
  const handlers = [];
  const notifier = {
    on(method, handler) { handlers.push({ method, handler }); return () => {}; },
    notify(method, params) {
      for (const h of handlers) if (h.method === '*' || h.method === method) h.handler(params, method);
    },
    async call(method) {
      if (method === 'thread/start') return { threadId: 'th_1' };
      if (method === 'turn/start') return { turnId: 'tn_1' };
      return {};
    },
  };
  const relay = new Relay({
    gate: new InboundGate({ chats: [CHAT] }),
    dispatcher: new Dispatcher(),
    drafts: new DraftBook({ chats: [CHAT] }),
    sink: allowlistSink({ inner, chats: [CHAT] }),
    client: notifier,
    connection: link,
    now: () => clock.now,
    fetchEnds: async () => [{ end: 'end-1', busy: false }],
  });
  assert.equal(relay.minIntervalMs, 134, 'CardKit pacing, for contrast with snapshot mode');

  await relay.start();
  await relay.tick(clock.now);
  link.deliver(messageEvent({ chatId: CHAT, text: 'go' }));
  await relay.drain(clock.now);
  notifier.notify('item/started', { threadId: 'th_1', itemId: 'it_1', kind: 'agentMessage' });
  notifier.notify('item/agentMessage/delta', { itemId: 'it_1', delta: 'a' });

  await relay.flushCards(0);                           // first streamText, throttled
  const attempts = spy.of(OPS.streamText).length;
  assert.equal(attempts, 1);

  for (const t of [268, 500, 999]) {
    clock.now = t;
    await relay.flushCards(t);
    assert.equal(spy.of(OPS.streamText).length, attempts, `retried at ${t}ms, inside the throttle window`);
  }
  clock.now = 1000;
  await relay.flushCards(1000);
  assert.equal(spy.of(OPS.streamText).length, attempts + 1, 'and it must retry once the second is up');
  assert.equal(RATE_LIMIT_BACKOFF_MS, 1000);
});

// -- the whole stack, with nothing sent --------------------------------------

test('relay -> allowlist -> feishu sink -> shim -> CLI, end to end', async () => {
  const stub = await stubCli('success');
  const shim = await liveShim(stub);
  try {
    const sink = allowlistSink({
      inner: feishuSink({ endpoint: shim.endpoint, nonce: NONCE }),
      chats: [CHAT],
    });
    const h = snapshotRelay({ sink });
    await h.relay.start();
    await h.relay.tick(h.clock.now);
    await runTurn(h, ['你好']);

    assert.deepEqual(h.relay.failures, [], 'nothing may fail on the happy path');
    // What the CLI was handed, read back out of the child process: the
    // strongest right-hand side available without sending anything.
    const argv = await stub.received();
    assert.deepEqual(argv.slice(0, 2), ['call', CLI_TOOL]);
    const args = JSON.parse(argv[2]);
    assert.equal(args.action, 'send');
    assert.equal(args.send_as, 'user');
    assert.equal(args.receive_id, CHAT);
    assert.equal(args.receive_id_type, 'chat_id');
    assert.equal(args.msg_type, 'interactive');
    assert.equal(typeof args.content, 'string');
    const card = JSON.parse(args.content);
    assert.equal(card.schema, '2.0');
    assert.equal(card.config.streaming_mode, false);
    assert.match(args.content, /你好/, 'the model output must survive every hop');
  } finally {
    await shim.close();
    await stub.cleanup();
  }
});

test('the same stack records a failure when the CLI prints `undefined`', async () => {
  const stub = await stubCli('undef');
  const shim = await liveShim(stub);
  try {
    const sink = allowlistSink({
      inner: feishuSink({ endpoint: shim.endpoint, nonce: NONCE }),
      chats: [CHAT],
    });
    const h = snapshotRelay({ sink });
    await h.relay.start();
    await h.relay.tick(h.clock.now);
    await runTurn(h, ['hi']);

    // The failure this whole file exists for: exit code 0, nothing sent. If
    // this list is empty the relay believes it wrote a card into an empty chat.
    assert.ok(h.relay.failures.length > 0, 'an `undefined` from the CLI must surface as a failure');
    assert.match(h.relay.failures[0].where, /card/);
    assert.match(h.relay.failures[0].error, /undefined/);
  } finally {
    await shim.close();
    await stub.cleanup();
  }
});
