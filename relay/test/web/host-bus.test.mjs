// The bus, tested on the two failures that look like success.
//
// Double delivery and a swapped payload field are both invisible at runtime.
// The first shows up days later as an intermittent duplicate tool call; the
// second shows up as a UI that boots, connects, and never resolves a single
// request. Neither throws, neither logs. So the outbound tests drive the
// renderer's REAL transport (both paths, bridge installed) and count
// deliveries, and the inbound tests assert on the presence of one field name
// and the absence of the other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createHostBus } from '../../web/host-bus.mjs';
import { installElectronBridge } from '../../web/host-bridge.mjs';
import { isDeliverable } from '../../web/host-protocol.mjs';
import {
  bridgeConfig,
  collect,
  dispatchMessageFromView,
  makeWindow,
  postMessageFromView,
} from './host-fakes.mjs';

/** A window with the bridge installed, so the renderer's both-paths send runs. */
function harness({ hostId } = {}) {
  const window = makeWindow();
  const bridgeHandle = installElectronBridge({ window, config: bridgeConfig() });
  const bus = createHostBus(hostId ? { window, hostId } : { window });
  const inbound = collect(window, 'message');
  return { window, bus, bridgeHandle, inbound };
}

// ---- exactly-once capture --------------------------------------------------

test('a message sent down BOTH renderer paths is delivered exactly once', () => {
  // This is the duplicate-delivery trap. The renderer calls
  // electronBridge.sendMessageFromView AND dispatches the CustomEvent, every
  // time. The bus listens to the CustomEvent only. If it ever also hooked the
  // bridge member, this count would be 2 and the symptom downstream would be a
  // tool call that ran twice.
  const { window, bus } = harness();
  const seen = [];
  bus.on('mcp-request', (message) => seen.push(message));

  dispatchMessageFromView(window, 'mcp-request', {
    hostId: 'local',
    request: { id: 1, method: 'thread/start', params: {} },
  });

  assert.equal(seen.length, 1, 'exactly once, not twice');
  assert.equal(seen[0].request.id, 1);
  assert.equal(bus.stats.captured, 1);
});

test('the bridge really was installed, so the both-paths test means something', () => {
  // Guard against the above passing because sendMessageFromView was absent.
  const { window } = harness();
  assert.equal(typeof window.electronBridge.sendMessageFromView, 'function');
  const event = dispatchMessageFromView(window, 'mcp-request', {});
  assert.equal(event.__codexForwardedViaBridge, true, 'the bridge path was taken too');
});

test('still exactly once with several subscribers and several messages', () => {
  const { window, bus } = harness();
  const a = [];
  const b = [];
  bus.on('mcp-request', (m) => a.push(m));
  bus.on('mcp-request', (m) => b.push(m));
  for (let i = 1; i <= 3; i += 1) {
    dispatchMessageFromView(window, 'mcp-request', { hostId: 'local', request: { id: i } });
  }
  assert.deepEqual(a.map((m) => m.request.id), [1, 2, 3]);
  assert.deepEqual(b.map((m) => m.request.id), [1, 2, 3]);
});

test('with no bridge at all the CustomEvent still carries everything', () => {
  // The whole reason the CustomEvent is the capture point: it fires whether or
  // not the bridge exists.
  const window = makeWindow();
  const bus = createHostBus({ window });
  const seen = [];
  bus.on('codex-app-server-restart', (m) => seen.push(m));
  dispatchMessageFromView(window, 'codex-app-server-restart', { hostId: 'local' });
  assert.equal(seen.length, 1);
});

// ---- outbound routing ------------------------------------------------------

test('each outbound type reaches only its own handler', () => {
  const { window, bus } = harness();
  const requests = [];
  const abandons = [];
  bus.on('mcp-request', (m) => requests.push(m));
  bus.on('mcp-request-abandon', (m) => abandons.push(m));

  dispatchMessageFromView(window, 'mcp-request', { request: { id: 1 } });
  dispatchMessageFromView(window, 'mcp-request-abandon', { requestId: 1 });

  assert.equal(requests.length, 1);
  assert.equal(abandons.length, 1);
  assert.equal(abandons[0].requestId, 1);
});

test('an unrecognised outbound type reaches onAny instead of throwing', () => {
  // The renderer's own switch has no default branch and ignores what it does
  // not know. A host stricter than the thing it imitates breaks on the next
  // app update rather than on ours.
  const { window, bus } = harness();
  const unknown = [];
  bus.onAny((m) => unknown.push(m));

  assert.doesNotThrow(() => {
    dispatchMessageFromView(window, 'some-future-message-type', { whatever: true });
  });
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].type, 'some-future-message-type');
  assert.equal(bus.stats.unclaimed, 1);
});

test('onAny does not see what a typed handler already claimed', () => {
  const { window, bus } = harness();
  const any = [];
  bus.on('mcp-request', () => {});
  bus.onAny((m) => any.push(m));
  dispatchMessageFromView(window, 'mcp-request', { request: { id: 1 } });
  assert.deepEqual(any, []);
  assert.equal(bus.stats.claimed, 1);
});

test('a type whose last handler unsubscribed falls back to onAny', () => {
  const { window, bus } = harness();
  const any = [];
  const off = bus.on('mcp-request', () => {});
  bus.onAny((m) => any.push(m));
  off();
  dispatchMessageFromView(window, 'mcp-request', { request: { id: 1 } });
  assert.equal(any.length, 1, 'otherwise an unsubscribe would silently blackhole a type');
});

test('log-message is dropped and does not reach onAny', () => {
  const { window, bus } = harness();
  const any = [];
  bus.onAny((m) => any.push(m));
  dispatchMessageFromView(window, 'log-message', { level: 'info', text: 'x' });
  assert.deepEqual(any, [], 'telemetry must not bury the traffic that matters');
  assert.equal(bus.stats.droppedLogMessages, 1);
});

test('log-message can still be subscribed to explicitly', () => {
  const { window, bus } = harness();
  const logs = [];
  bus.on('log-message', (m) => logs.push(m));
  dispatchMessageFromView(window, 'log-message', { level: 'info' });
  assert.equal(logs.length, 1, 'the drop is a default, not a prohibition');
  assert.equal(bus.stats.droppedLogMessages, 0);
});

test('a malformed outbound detail is counted and handed to onAny, not thrown', () => {
  const { window, bus } = harness();
  const any = [];
  bus.onAny((m) => any.push(m));
  for (const detail of [null, undefined, 'a string', 42, { noType: true }, { type: 7 }]) {
    assert.doesNotThrow(() => postMessageFromView(window, detail));
  }
  assert.equal(bus.stats.malformed, 6);
  assert.equal(any.length, 6);
});

test('one throwing subscriber does not starve the others', () => {
  const { window, bus } = harness();
  const seen = [];
  bus.on('mcp-request', () => { throw new Error('boom'); });
  bus.on('mcp-request', (m) => seen.push(m));
  assert.doesNotThrow(() => dispatchMessageFromView(window, 'mcp-request', { request: { id: 1 } }));
  assert.equal(seen.length, 1);
});

test('on and onAny refuse bad arguments', () => {
  const { bus } = harness();
  assert.throws(() => bus.on('', () => {}), /type/);
  assert.throws(() => bus.on(null, () => {}), /type/);
  assert.throws(() => bus.on('mcp-request', null), /function/);
  assert.throws(() => bus.onAny('not a function'), /function/);
});

test('createHostBus refuses a missing window', () => {
  assert.throws(() => createHostBus(), /window/);
  assert.throws(() => createHostBus({ window: null }), /window/);
});

// ---- THE TRAP: the inbound payload field -----------------------------------

test('an emitted mcp-response carries `message` and NOT `response`', () => {
  const { bus, inbound } = harness();
  bus.emitMcpResponse({ id: 42, result: { threadId: 't_1' } });

  const [data] = inbound.data();
  assert.equal(data.type, 'mcp-response');
  assert.deepEqual(data.message, { id: 42, result: { threadId: 't_1' } });
  assert.equal(
    'response' in data,
    false,
    'inbound is `message`; `response` is the word the RENDERER uses on its way out',
  );
});

test('the renderer answering a request uses `response`, the opposite word', () => {
  // Captured from the outbound side, this is the same `mcp-response` type with
  // the other field name. If the two were ever unified, one direction would
  // break and neither would say so.
  const { window, bus } = harness();
  const answers = [];
  bus.on('mcp-response', (m) => answers.push(m));

  dispatchMessageFromView(window, 'mcp-response', {
    hostId: 'local',
    response: { id: '0de0ea84-0000-4000-8000-000000000000', result: { decision: 'approved' } },
    requestMethod: 'item/tool/approve',
  });

  assert.equal(answers.length, 1);
  assert.equal('response' in answers[0], true, 'outbound is `response`');
  assert.equal('message' in answers[0], false, 'and must not be `message`');
  assert.equal(answers[0].response.id, '0de0ea84-0000-4000-8000-000000000000');
});

test('the two directions of mcp-response do not share a field name', () => {
  const { window, bus, inbound } = harness();
  const outbound = [];
  bus.on('mcp-response', (m) => outbound.push(m));

  bus.emitMcpResponse({ id: 1, result: 'in' });
  dispatchMessageFromView(window, 'mcp-response', { hostId: 'local', response: { id: 'u', result: 'out' } });

  const inboundKeys = Object.keys(inbound.data()[0]);
  const outboundKeys = Object.keys(outbound[0]);
  assert.equal(inboundKeys.includes('message'), true);
  assert.equal(inboundKeys.includes('response'), false);
  assert.equal(outboundKeys.includes('response'), true);
  assert.equal(outboundKeys.includes('message'), false);
});

test('emitMcpResponse refuses a payload with neither result nor error', () => {
  // The renderer's own behaviour here is to log "Invalid MCP message: missing
  // result/error" and drop it, which presents as one request that never
  // settles, long after the mistake. Loud at the call site instead.
  const { bus, inbound } = harness();
  assert.throws(() => bus.emitMcpResponse({ id: 1 }), /result or an error/);
  assert.throws(() => bus.emitMcpResponse({}), /result or an error/);
  assert.deepEqual(inbound.data(), [], 'and nothing was delivered on the way to throwing');
});

test('emitMcpResponse refuses a payload with both', () => {
  const { bus } = harness();
  assert.throws(
    () => bus.emitMcpResponse({ id: 1, result: 'x', error: { code: -1, message: 'y' } }),
    /never both/,
  );
});

test('an error response is delivered under message, same as a result', () => {
  const { bus, inbound } = harness();
  bus.emitMcpResponse({ id: 9, error: { code: -32603, message: 'internal' } });
  const [data] = inbound.data();
  assert.deepEqual(data.message, { id: 9, error: { code: -32603, message: 'internal' } });
  assert.equal('result' in data.message, false);
});

// ---- inbound delivery mechanics --------------------------------------------

test('inbound messages arrive as a MessageEvent with a null source', () => {
  // A hand-built MessageEvent has source === null, which satisfies the first
  // clause of the renderer's guard outright so the origin check is never
  // reached. This is how the Electron preload delivers, too.
  const { bus, inbound } = harness();
  bus.emitConnectionChanged({ state: 'connected' });

  const [event] = inbound.events;
  assert.equal(event.type, 'message');
  assert.equal(event.source, null, 'a set source that is not the window would be REJECTED');
  assert.equal(isDeliverable(event.data), true);
});

test('every emitter produces something that clears the renderer guard', () => {
  const { bus, inbound } = harness();
  bus.emitMcpResponse({ id: 1, result: 1 });
  bus.emitMcpNotification({ method: 'item/started', params: { itemId: 'i' } });
  bus.emitMcpEventNotification({
    notification: { method: 'notifications/message', params: { level: 'info' } },
    subscriptionId: 's-1',
  });
  bus.emitMcpRequest({ request: { id: 'u', method: 'item/tool/approve', params: {} } });
  bus.emitRequestDelivery({ update: { type: 'outcome-unknown' } });
  bus.emitAppServerInitialized({ appServerVersion: '1', installedCodexVersion: '2' });
  bus.emitConnectionChanged({ state: 'connected' });
  bus.emitFatalError({ errorMessage: 'gone' });
  bus.emitPersonalWorkspaceAccessBlocked({ extra: { reason: 'r' } });

  const data = inbound.data();
  assert.equal(data.length, 9);
  assert.deepEqual(data.map((m) => m.type), [
    'mcp-response',
    'mcp-notification',
    'mcp-event-notification',
    'mcp-request',
    'mcp-request-delivery',
    'codex-app-server-initialized',
    'codex-app-server-connection-changed',
    'codex-app-server-fatal-error',
    'personal-workspace-access-blocked',
  ]);
  for (const message of data) {
    assert.equal(isDeliverable(message), true, `${message.type} must clear the guard`);
    assert.equal(message.hostId, 'local', `${message.type} must carry a hostId`);
  }
});

test('an MCP event notification is four fields, and the wire method is not one of them', () => {
  // The frame the Electron main process sends is `{type, hostId, notification,
  // subscriptionId}` and nothing else. In particular the wire method that
  // identified it -- `mcpServer/event/stream/notification` -- does not travel:
  // it is what tells a host to REWRITE the frame, and the renderer's consumer
  // matches on `subscriptionId` instead. Pinned by exact key set, because an
  // extra key here is a host inventing protocol.
  const { bus, inbound } = harness();
  const notification = { method: 'notifications/message', params: { level: 'info', data: 'hi' } };
  bus.emitMcpEventNotification({ notification, subscriptionId: 'sub-7' });
  const [message] = inbound.data();
  assert.deepEqual(Object.keys(message), ['type', 'hostId', 'notification', 'subscriptionId']);
  assert.deepEqual(message, {
    type: 'mcp-event-notification',
    hostId: 'local',
    notification,
    subscriptionId: 'sub-7',
  });
  assert.equal(message.notification, notification, 'the inner notification is passed, not rebuilt');
});

test('an MCP event notification missing either payload field is refused, not half-sent', () => {
  // Both fields are load-bearing on the renderer's side: the consumer filters on
  // hostId and then matches `hostSubscriptionId===subscriptionId`, so an event
  // with no id reaches no subscription and an event with no notification has
  // nothing to deliver. The builder throws rather than emitting a frame that
  // would be dropped silently at the far end; the link validates before it gets
  // here, which is why this throw is a programming-error backstop.
  const { bus, inbound } = harness();
  assert.throws(() => bus.emitMcpEventNotification({ subscriptionId: 's' }), /notification/);
  assert.throws(
    () => bus.emitMcpEventNotification({ notification: { method: 'notifications/message' } }),
    /subscriptionId/,
  );
  assert.throws(() => bus.emitMcpEventNotification(), /notification/);
  assert.equal(inbound.data().length, 0, 'nothing may reach the renderer from a refused build');
});

test('a non-default hostId reaches every emitter', () => {
  const { bus, inbound } = harness({ hostId: 'remote-1' });
  assert.equal(bus.hostId, 'remote-1');
  bus.emitConnectionChanged({ state: 'connected' });
  bus.emitMcpResponse({ id: 1, result: 1 });
  for (const message of inbound.data()) assert.equal(message.hostId, 'remote-1');
});

test('an emitter returns the exact object it delivered', () => {
  const { bus, inbound } = harness();
  const returned = bus.emitMcpNotification({ method: 'turn/completed', params: {} });
  assert.equal(returned, inbound.data()[0]);
});

test('a server-initiated request id is not renumbered into the integer space', () => {
  const { bus, inbound } = harness();
  const request = { id: 'c0ffee00-0000-4000-8000-000000000000', method: 'item/tool/approve', params: {} };
  bus.emitMcpRequest({ request });
  assert.equal(inbound.data()[0].request.id, request.id);
  assert.equal(typeof inbound.data()[0].request.id, 'string');
});

test('an integer response id stays an integer', () => {
  const { bus, inbound } = harness();
  bus.emitMcpResponse({ id: 17, result: null });
  assert.equal(inbound.data()[0].message.id, 17);
  assert.equal(typeof inbound.data()[0].message.id, 'number');
});

// ---- teardown --------------------------------------------------------------

test('stop unsubscribes the capture side', () => {
  const { window, bus } = harness();
  const seen = [];
  bus.on('mcp-request', (m) => seen.push(m));
  dispatchMessageFromView(window, 'mcp-request', { request: { id: 1 } });
  bus.stop();
  dispatchMessageFromView(window, 'mcp-request', { request: { id: 2 } });

  assert.equal(seen.length, 1);
  assert.equal(bus.running, false);
  assert.doesNotThrow(() => bus.stop());
});

test('emitting after stop throws rather than silently doing nothing', () => {
  // A torn-down host still being handed replies is a sequencing bug. A no-op
  // there presents as a renderer hanging on a request its caller believes was
  // answered.
  const { bus, inbound } = harness();
  bus.stop();
  assert.throws(() => bus.emitMcpResponse({ id: 1, result: 1 }), /stopped/);
  assert.throws(() => bus.emitConnectionChanged({ state: 'connected' }), /stopped/);
  assert.deepEqual(inbound.data(), []);
});

test('stats are a copy, not the live counters', () => {
  const { window, bus } = harness();
  const snapshot = bus.stats;
  dispatchMessageFromView(window, 'log-message', {});
  assert.equal(snapshot.captured, 0, 'a reader holds a snapshot');
  assert.equal(bus.stats.captured, 1);
});

// ---- the generic deliver ---------------------------------------------------

test('deliver carries a message the typed emitters do not cover', () => {
  // Two host layers answer types that are not app-server lifecycle at all --
  // the fetch layer replies to 95 endpoints and the services layer returns
  // persisted-atom and workspace replies for its caller to post -- and neither
  // will ever earn a typed emitter here. This is their seam.
  const { bus, inbound } = harness();
  const message = { type: 'fetch-response', requestId: 'request-1', status: 200, body: { ok: true } };
  const returned = bus.deliver(message);

  assert.deepEqual(inbound.data(), [message]);
  assert.equal(returned, message, 'returned for a caller that wants to log what it sent');
});

test('deliver is counted, so emitted stays a count of what reached the renderer', () => {
  // The alternative to this method was for those layers to dispatch
  // `new MessageEvent('message', {data})` at the window themselves. That works
  // and is wrong: `stats.emitted` would then read zero on a page answering
  // hundreds of fetches a minute, and that counter is the one number that says
  // whether the host answered anything at all.
  const { bus } = harness();
  bus.deliver({ type: 'fetch-response', requestId: 'r', status: 200, body: null });
  bus.deliver({ type: 'persisted-atom-sync', state: {}, hasHydrated: true, error: null });
  bus.emitConnectionChanged({ state: 'connected' });
  assert.equal(bus.stats.emitted, 3, 'every inbound path goes through the one counter');
});

test('deliver lands on the same window event the typed emitters use', () => {
  // Not a tautology: a `message` event whose `source` is not null is refused by
  // the handshake's sender check, and the subtlety is documented once, in this
  // module's header, precisely because there is one dispatch site.
  const { window, bus } = harness();
  const events = [];
  window.addEventListener('message', (event) => events.push(event));
  bus.deliver({ type: 'fetch-response', requestId: 'r', status: 200, body: null });

  assert.equal(events.length, 1);
  assert.equal(events[0].source, null, 'the one dispatch site keeps this true for every inbound type');
});

test('deliver refuses to run after the bus is stopped', () => {
  const { bus, inbound } = harness();
  bus.stop();
  assert.throws(() => bus.deliver({ type: 'fetch-response', requestId: 'r' }), /stopped/);
  assert.deepEqual(inbound.data(), []);
});

test('deliver passes the message through unvalidated, on purpose', () => {
  // host-protocol.mjs validates at construction, which is where a stack trace
  // still names the builder. A second check here could only ever say
  // "something somewhere built this wrong", which is not a diagnostic.
  const { bus, inbound } = harness();
  bus.deliver({ type: 'not-a-type-the-renderer-knows' });
  assert.deepEqual(inbound.data(), [{ type: 'not-a-type-the-renderer-knows' }]);
});

// ---- the seam stays a seam -------------------------------------------------

test('host-bus imports nothing from src/ and opens no socket', async () => {
  // The bus is the bus, not the wiring. If it ever grows a transport import,
  // it stops being testable without one -- and the exhaustive message-shape
  // coverage above is only cheap because there is nothing to stand up.
  const source = await readFile(new URL('../../web/host-bus.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(imports, ['./host-protocol.mjs'], 'one import, and it is the vocabulary');
  assert.equal(/\bnew WebSocket\b/.test(source), false);
  assert.equal(/node:net|node:http|appserver/.test(source), false);
});
