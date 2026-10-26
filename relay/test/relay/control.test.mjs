import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announcedEnd, controlSocket, httpRequest, startRelay, waitFor } from './harness.mjs';

/** A clock a test can wind by hand, so timestamp assertions are exact. */
function fakeClock(start = 1_700_000_000_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
      return value;
    },
  };
}

const ends = async (port) => (await httpRequest(port, '/ends')).json.ends;

test('an announce is acknowledged by name', async (t) => {
  const { port } = await startRelay(t);
  const control = controlSocket(t, port);
  await control.opened;
  control.sendJson({ kind: 'announce', end: 'alpha', connection: 'c', pid: 7 });
  assert.deepEqual(await control.nextJson(), { kind: 'announced', end: 'alpha' });
});

test('an announce without an end name is refused by that name', async (t) => {
  const { port } = await startRelay(t);
  for (const frame of [{ kind: 'announce' }, { kind: 'announce', end: '' }, { kind: 'announce', end: 42 }, { kind: 'announce', end: null }]) {
    const control = controlSocket(t, port);
    await control.opened;
    control.sendJson(frame);
    const { reason } = await control.closed;
    assert.equal(reason, 'announce without an end name', JSON.stringify(frame));
  }
  assert.deepEqual(await ends(port), []);
});

test('a second socket cannot take a name a live socket holds', async (t) => {
  const { port } = await startRelay(t);
  const first = await announcedEnd(t, port, { end: 'alpha', connection: 'first', pid: 1 });

  const second = controlSocket(t, port);
  await second.opened;
  second.sendJson({ kind: 'announce', end: 'alpha', connection: 'second', pid: 2 });
  const { reason } = await second.closed;
  assert.equal(reason, 'end alpha is already announced from another connection');

  // The incumbent is untouched -- a refused challenger must not be able to
  // corrupt the record it failed to take.
  const list = await ends(port);
  assert.equal(list.length, 1);
  assert.equal(list[0].connection, 'first');
  assert.equal(list[0].pid, 1);
  assert.equal(first.ws.readyState, WebSocket.OPEN);
});

test('a re-announce on the same socket updates the record and keeps announcedAt', async (t) => {
  const clock = fakeClock();
  const { port } = await startRelay(t, { now: clock.now });
  const control = await announcedEnd(t, port, { end: 'alpha', connection: 'c', pid: 5, busy: false });
  const [first] = await ends(port);
  assert.equal(first.busy, false);

  clock.advance(60_000);
  // Going busy *is* a re-announce: the protocol has no other frame for it.
  control.sendJson({ kind: 'announce', end: 'alpha', connection: 'c', pid: 5, busy: true, cwd: '/new/place' });
  assert.deepEqual(await control.nextJson(), { kind: 'announced', end: 'alpha' });

  const [second] = await waitFor(async () => {
    const list = await ends(port);
    return list[0]?.busy === true ? list : null;
  }, { label: 'the busy update' });
  assert.equal(second.busy, true);
  assert.equal(second.cwd, '/new/place');
  assert.equal(second.announcedAt, first.announcedAt, 'announcedAt survives a re-announce');
  assert.equal(second.lastSeenAt, first.lastSeenAt + 60_000);
});

test('an end that comes back after its socket died retakes its own name', async (t) => {
  const clock = fakeClock();
  const { port } = await startRelay(t, { now: clock.now });
  const first = await announcedEnd(t, port, { end: 'alpha', connection: 'old', pid: 1 });
  const [before] = await ends(port);

  first.ws.close(1000, 'laptop went away');
  await first.closed;
  await waitFor(async () => (await ends(port)).length === 0, { label: 'the registration to go' });

  clock.advance(5_000);
  await announcedEnd(t, port, { end: 'alpha', connection: 'new', pid: 2 });
  const [after] = await ends(port);
  assert.equal(after.connection, 'new');
  // A takeover is a new registration, not an update: this is genuinely a
  // different process, and dating it from the dead one would be a lie.
  assert.equal(after.announcedAt, before.announcedAt + 5_000);
});

test('a name held by a closed socket is available immediately, not after a timeout', async (t) => {
  const { port } = await startRelay(t);
  const first = await announcedEnd(t, port, { end: 'alpha', pid: 1 });
  first.ws.close(1000, 'gone');
  await first.closed;
  // No grace period, no tombstone: the registration is the socket.
  const second = await waitFor(
    () => announcedEnd(t, port, { end: 'alpha', pid: 2 }).catch(() => null),
    { label: 'the name to free up' },
  );
  assert.equal(second.ws.readyState, WebSocket.OPEN);
});

test('a heartbeat moves lastSeenAt and nothing else', async (t) => {
  const clock = fakeClock();
  const { port } = await startRelay(t, { now: clock.now });
  const control = await announcedEnd(t, port, { end: 'alpha', pid: 9 });
  const [before] = await ends(port);

  clock.advance(30_000);
  control.sendJson({ kind: 'heartbeat' });
  const [after] = await waitFor(async () => {
    const list = await ends(port);
    return list[0]?.lastSeenAt !== before.lastSeenAt ? list : null;
  }, { label: 'the heartbeat' });
  assert.equal(after.lastSeenAt, before.lastSeenAt + 30_000);
  assert.equal(after.announcedAt, before.announcedAt);
  assert.equal(after.pid, 9);
});

test('a heartbeat from a socket that owns nothing is ignored', async (t) => {
  const clock = fakeClock();
  const { port } = await startRelay(t, { now: clock.now });
  await announcedEnd(t, port, { end: 'alpha', pid: 1 });
  const [before] = await ends(port);

  const stranger = controlSocket(t, port);
  await stranger.opened;
  clock.advance(10_000);
  stranger.sendJson({ kind: 'heartbeat' });
  // Nothing to wait *for*, so give the relay a chance to do the wrong thing.
  await new Promise((res) => setTimeout(res, 50));
  const [after] = await ends(port);
  assert.equal(after.lastSeenAt, before.lastSeenAt);
  assert.equal(stranger.ws.readyState, WebSocket.OPEN, 'a pointless heartbeat is not an error');
});

test('a silent end is still registered: nothing expires on a timer', async (t) => {
  const { port } = await startRelay(t);
  const control = await announcedEnd(t, port, { end: 'alpha', pid: 1 });
  const [before] = await ends(port);
  // A sleeping laptop must not look like a departed one. There is no liveness
  // timer to wait out, so what this can check is that silence changes nothing.
  await new Promise((res) => setTimeout(res, 200));
  const [after] = await ends(port);
  assert.deepEqual(after, before);
  assert.equal(control.ws.readyState, WebSocket.OPEN);
});

test('the registration dies with the control socket', async (t) => {
  const { port } = await startRelay(t, { shutdownGraceMs: 25 });
  const control = await announcedEnd(t, port, { end: 'alpha', pid: 1 });
  assert.equal((await ends(port)).length, 1);
  // 1000 and 3000-4999 are the only codes the WebSocket API will send.
  control.ws.close(1000, 'closing the lid');
  await waitFor(async () => (await ends(port)).length === 0, { label: 'the registration to go' });
});

test('a stale socket closing late does not evict the end that took over', async (t) => {
  const { port } = await startRelay(t);
  const first = await announcedEnd(t, port, { end: 'alpha', connection: 'old', pid: 1 });
  // Kill the socket without a close handshake, the way a crashed host does.
  first.ws.close();
  await first.closed;
  const second = await waitFor(
    () => announcedEnd(t, port, { end: 'alpha', connection: 'new', pid: 2 }).catch(() => null),
    { label: 'the takeover' },
  );
  await new Promise((res) => setTimeout(res, 50));
  const list = await ends(port);
  assert.equal(list.length, 1);
  assert.equal(list[0].connection, 'new');
  assert.equal(second.ws.readyState, WebSocket.OPEN);
});

test('binary frames on the control channel are ignored entirely', async (t) => {
  const { port } = await startRelay(t);
  const control = controlSocket(t, port);
  await control.opened;
  // The same bytes that would be a valid announce as text.
  control.send(Buffer.from(JSON.stringify({ kind: 'announce', end: 'alpha', pid: 1 })));
  control.send(Buffer.from([0x00, 0xff, 0x80]));
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(await ends(port), [], 'a binary announce registers nothing');
  assert.equal(control.ws.readyState, WebSocket.OPEN, 'and is not an error either');

  // The socket is still good for a real announce afterwards.
  control.sendJson({ kind: 'announce', end: 'alpha', pid: 1 });
  assert.deepEqual(await control.nextJson(), { kind: 'announced', end: 'alpha' });
});

test('unknown frame kinds and junk are ignored, not fatal', async (t) => {
  const { port } = await startRelay(t);
  const control = await announcedEnd(t, port, { end: 'alpha', pid: 1 });
  control.send('not json at all');
  control.sendJson({ kind: 'from-a-newer-build', detail: { a: 1 } });
  control.sendJson({ nokind: true });
  control.sendJson([1, 2, 3]);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(control.ws.readyState, WebSocket.OPEN);
  assert.equal((await ends(port)).length, 1);
  // And the channel still works.
  control.sendJson({ kind: 'announce', end: 'alpha', pid: 1, busy: true });
  assert.deepEqual(await control.nextJson(), { kind: 'announced', end: 'alpha' });
});

test('one socket announcing a second name releases the first', async (t) => {
  const { port } = await startRelay(t);
  const control = await announcedEnd(t, port, { end: 'alpha', pid: 1 });
  control.sendJson({ kind: 'announce', end: 'beta', pid: 1 });
  assert.deepEqual(await control.nextJson(), { kind: 'announced', end: 'beta' });
  const list = await waitFor(async () => {
    const l = await ends(port);
    return l.length === 1 ? l : null;
  }, { label: 'one registration' });
  // Not in the contract. One socket, one registration is the only reading
  // that keeps "a registration lives as long as its control socket" true.
  assert.deepEqual(list.map((r) => r.end), ['beta']);
});

test('two different ends coexist on two sockets', async (t) => {
  const { port } = await startRelay(t);
  await announcedEnd(t, port, { end: 'alpha', pid: 1 });
  await announcedEnd(t, port, { end: 'beta', pid: 2 });
  assert.deepEqual((await ends(port)).map((r) => r.end), ['alpha', 'beta']);
});
