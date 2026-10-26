import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPS, LARK_LIMITS, RATE_LIMIT_CODE, toHttpRequest, describeTokenExchange,
  sealedSink, allowlistSink, destinationOf, assertLongConnection,
  OutboundSealed, UnknownOp,
} from '../../src/imrelay/transport.mjs';
import { fakeLongConnection, recordingSink } from './fakes.mjs';

test('sending a message maps to POST im/v1/messages with a stringified content', () => {
  const request = toHttpRequest({
    op: OPS.sendMessage, receiveId: 'oc_1', msgType: 'interactive', content: { schema: '2.0' },
  });
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/open-apis/im/v1/messages');
  assert.deepEqual(request.query, { receive_id_type: 'chat_id' });
  assert.equal(request.body.receive_id, 'oc_1');
  assert.equal(request.body.msg_type, 'interactive');
  // The platform wants a JSON *string* here, not an object.
  assert.equal(typeof request.body.content, 'string');
  assert.deepEqual(JSON.parse(request.body.content), { schema: '2.0' });
  assert.equal(request.auth, 'tenant_access_token');
});

test('an already-stringified content is not double-encoded', () => {
  const request = toHttpRequest({
    op: OPS.sendMessage, receiveId: 'oc_1', msgType: 'text', content: '{"text":"hi"}',
  });
  assert.equal(request.body.content, '{"text":"hi"}');
});

test('a send uuid rides along when given and is absent when not', () => {
  const withUuid = toHttpRequest({
    op: OPS.sendMessage, receiveId: 'oc_1', msgType: 'text', content: { text: 'x' }, uuid: 'u1',
  });
  assert.equal(withUuid.body.uuid, 'u1');
  const without = toHttpRequest({
    op: OPS.sendMessage, receiveId: 'oc_1', msgType: 'text', content: { text: 'x' },
  });
  assert.ok(!('uuid' in without.body));
});

test('a send carrying replyTo renders as a reply, not as a new top-level message', () => {
  // This assertion is the one that was missing. `daemon.mjs#say` attaches
  // `replyTo`, and `daemon.test.mjs` checks it is there -- on the *descriptor*.
  // Nothing looked at the rendered request, where the field was being pruned
  // away, so every "reply" in the suite was green while rendering to a fresh
  // message addressed at the chat.
  const request = toHttpRequest({
    op: OPS.sendMessage, receiveId: 'oc_1', msgType: 'text',
    content: { text: 'ok' }, replyTo: 'om_trigger',
  });
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/open-apis/im/v1/messages/om_trigger/reply');
  assert.equal(request.body.msg_type, 'text');
  assert.equal(JSON.parse(request.body.content).text, 'ok');
  // The reply endpoint takes the chat from the message being replied to;
  // sending a receive_id as well is how a reply gets posted twice.
  assert.ok(!('receive_id' in request.body));
  assert.deepEqual(request.query, {});
});

test('reply-in-thread rides along only when asked for, and a reply id is encoded', () => {
  const threaded = toHttpRequest({
    op: OPS.sendMessage, receiveId: 'oc_1', msgType: 'text', content: {},
    replyTo: 'om_1', replyInThread: true, uuid: 'u7',
  });
  assert.equal(threaded.body.reply_in_thread, true);
  assert.equal(threaded.body.uuid, 'u7');
  const plain = toHttpRequest({
    op: OPS.sendMessage, receiveId: 'oc_1', msgType: 'text', content: {}, replyTo: 'om_1',
  });
  assert.ok(!('reply_in_thread' in plain.body));
  assert.equal(
    toHttpRequest({ op: OPS.sendMessage, receiveId: 'oc_1', msgType: 'text', content: {}, replyTo: 'om/../1' }).path,
    '/open-apis/im/v1/messages/om%2F..%2F1/reply',
  );
  // An empty replyTo is not a reply; it must not produce `/messages//reply`.
  assert.equal(
    toHttpRequest({ op: OPS.sendMessage, receiveId: 'oc_1', msgType: 'text', content: {}, replyTo: '' }).path,
    '/open-apis/im/v1/messages',
  );
});

test('patching a card maps to PATCH on the message id', () => {
  const request = toHttpRequest({ op: OPS.patchCard, messageId: 'om_7', content: { a: 1 } });
  assert.equal(request.method, 'PATCH');
  assert.equal(request.path, '/open-apis/im/v1/messages/om_7');
});

test('a message id with path-hostile characters is encoded', () => {
  const request = toHttpRequest({ op: OPS.patchCard, messageId: 'om/../7', content: {} });
  assert.equal(request.path, '/open-apis/im/v1/messages/om%2F..%2F7');
});

test('creating a card entity declares the card_json type', () => {
  const request = toHttpRequest({ op: OPS.createCardEntity, card: { schema: '2.0' } });
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/open-apis/cardkit/v1/cards');
  assert.equal(request.body.type, 'card_json');
  assert.equal(typeof request.body.data, 'string');
});

test('streaming text maps to the element content endpoint', () => {
  const request = toHttpRequest({
    op: OPS.streamText, cardId: 'c1', elementId: 'turn_output', content: 'abc', sequence: 3,
  });
  assert.equal(request.method, 'PUT');
  assert.equal(request.path, '/open-apis/cardkit/v1/cards/c1/elements/turn_output/content');
  assert.deepEqual(request.body, { content: 'abc', sequence: 3 });
});

test('streaming text refuses a sequence that is not a positive int32', () => {
  for (const sequence of [0, -1, 1.5, 2147483648, '3', undefined]) {
    assert.throws(
      () => toHttpRequest({
        op: OPS.streamText, cardId: 'c1', elementId: 'e', content: 'x', sequence,
      }),
      (error) => error instanceof RangeError || error instanceof TypeError,
      `sequence ${String(sequence)} should be refused`,
    );
  }
});

test('card settings and full card updates target the entity', () => {
  assert.equal(
    toHttpRequest({ op: OPS.cardSettings, cardId: 'c1', settings: { streaming_mode: true } }).path,
    '/open-apis/cardkit/v1/cards/c1/settings',
  );
  assert.equal(
    toHttpRequest({ op: OPS.updateCardEntity, cardId: 'c1', card: { schema: '2.0' } }).path,
    '/open-apis/cardkit/v1/cards/c1',
  );
});

test('an unknown op is refused rather than guessed at', () => {
  assert.throws(() => toHttpRequest({ op: 'message.yolo' }), UnknownOp);
  assert.throws(() => toHttpRequest(null), UnknownOp);
});

test('a send with no receive id is refused', () => {
  assert.throws(
    () => toHttpRequest({ op: OPS.sendMessage, msgType: 'text', content: {} }),
    TypeError,
  );
});

test('the token exchange is described by field name and carries no values', () => {
  const described = describeTokenExchange();
  assert.equal(described.path, '/open-apis/auth/v3/tenant_access_token/internal');
  assert.deepEqual(described.bodyFields, ['app_id', 'app_secret']);
  assert.deepEqual(described.resultFields, ['tenant_access_token', 'expire']);
  // The whole point: names, never values.
  const serialised = JSON.stringify(described);
  assert.ok(!/secret["']?\s*:\s*["'][^"']/.test(serialised));
});

test('the verified platform limits are present and are the documented numbers', () => {
  assert.equal(LARK_LIMITS.maxConnectionsPerApp, 50);
  assert.equal(LARK_LIMITS.eventHandlerDeadlineMs, 3000);
  assert.equal(LARK_LIMITS.cardContentBytes, 30 * 1024);
  assert.equal(LARK_LIMITS.textContentBytes, 150 * 1024);
  assert.equal(LARK_LIMITS.maxMessageEdits, 20);
  assert.equal(LARK_LIMITS.cardKitPerCardPerSecond, 10);
  assert.equal(LARK_LIMITS.messagePatchPerSecond, 5);
  assert.equal(LARK_LIMITS.streamContentChars, 100000);
  assert.equal(RATE_LIMIT_CODE, 99991400);
});

// -- the fuse ---------------------------------------------------------------

test('the sealed sink refuses every operation', async () => {
  const sink = sealedSink();
  assert.equal(sink.sealed, true);
  for (const op of Object.values(OPS)) {
    await assert.rejects(() => sink.perform({ op, receiveId: 'oc_1' }), OutboundSealed);
  }
});

test('an allowlist sink with no chats permits nothing', async () => {
  const inner = recordingSink();
  const sink = allowlistSink({ inner });
  assert.equal(sink.allowedChatCount, 0);
  await assert.rejects(
    () => sink.perform({ op: OPS.sendMessage, receiveId: 'oc_anything', msgType: 'text', content: {} }),
    OutboundSealed,
  );
  assert.equal(inner.ops.length, 0);
});

test('an allowlisted chat gets through and an unlisted one does not', async () => {
  const inner = recordingSink();
  const sink = allowlistSink({ inner, chats: ['oc_ok'] });
  await sink.perform({ op: OPS.sendMessage, receiveId: 'oc_ok', msgType: 'text', content: {} });
  assert.equal(inner.ops.length, 1);
  await assert.rejects(
    () => sink.perform({ op: OPS.sendMessage, receiveId: 'oc_other', msgType: 'text', content: {} }),
    OutboundSealed,
  );
  assert.equal(inner.ops.length, 1, 'the refused op must not reach the inner sink');
});

test('a card can only be bound to an allowlisted chat, and only then written to', async () => {
  const inner = recordingSink();
  const sink = allowlistSink({ inner, chats: ['oc_ok'] });

  // Not bound yet.
  await assert.rejects(
    () => sink.perform({ op: OPS.streamText, cardId: 'c1', elementId: 'e', content: 'x', sequence: 1 }),
    OutboundSealed,
  );
  // Cannot bind to a chat that was never allowed.
  assert.throws(() => sink.allowCard('c1', 'oc_other'), OutboundSealed);

  sink.allowCard('c1', 'oc_ok');
  await sink.perform({ op: OPS.streamText, cardId: 'c1', elementId: 'e', content: 'x', sequence: 1 });
  assert.equal(inner.of(OPS.streamText).length, 1);
});

test('creating an entity is gated on the chat it is created for', async () => {
  const inner = recordingSink();
  const sink = allowlistSink({ inner, chats: ['oc_ok'] });
  await assert.rejects(
    () => sink.perform({ op: OPS.createCardEntity, card: {}, forChat: 'oc_other' }),
    OutboundSealed,
  );
  await sink.perform({ op: OPS.createCardEntity, card: {}, forChat: 'oc_ok' });
  assert.equal(inner.of(OPS.createCardEntity).length, 1);
});

test('patching by message id is refused because it cannot be attributed to a chat', async () => {
  const sink = allowlistSink({ inner: recordingSink(), chats: ['oc_ok'] });
  await assert.rejects(
    () => sink.perform({ op: OPS.patchCard, messageId: 'om_1', content: {} }),
    OutboundSealed,
  );
});

test('an op the allowlist has no rule for is denied, not permitted', async () => {
  assert.deepEqual(destinationOf({ op: 'something.new' }), { kind: 'unknown', id: null });
  const sink = allowlistSink({ inner: recordingSink(), chats: ['oc_ok'] });
  await assert.rejects(() => sink.perform({ op: 'something.new' }), OutboundSealed);
});

test('allowlistSink needs a real inner sink', () => {
  assert.throws(() => allowlistSink({ inner: {} }), TypeError);
  assert.throws(() => allowlistSink({ inner: recordingSink(), chats: 'oc_ok' }), TypeError);
});

// -- the inbound contract ---------------------------------------------------

test('the long-connection contract is checked member by member', () => {
  const { connection } = fakeLongConnection();
  assert.equal(assertLongConnection(connection), connection);
  for (const member of ['start', 'onEvent', 'onClose', 'close']) {
    const broken = { ...connection, [member]: undefined };
    assert.throws(() => assertLongConnection(broken), new RegExp(member));
  }
});
