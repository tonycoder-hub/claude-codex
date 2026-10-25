import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACH_AS_PARAM,
  ATTACH_PREFIX,
  CONTROL_PATH,
  ENDS_PATH,
  FRAME_ANNOUNCE,
  FRAME_ANNOUNCED,
  FRAME_DIAL_BACK,
  FRAME_HEARTBEAT,
  PAIR_PATH,
  RELAY_PAIRING_HEADER,
  RELAY_TOKEN_HEADER,
  UPGRADE_UNAUTHORIZED,
  attachPath,
  parseControlFrame,
  parseRelayPath,
  recordFromAnnounce,
} from '../../src/relay/protocol.mjs';

// The literals, spelled out here and nowhere else in the tests. A test that
// imports the string it is checking proves only that the file is consistent
// with itself, and the whole value of this suite is that another
// implementation of the same protocol is already in production.
test('the wire vocabulary is exactly these strings', () => {
  assert.equal(RELAY_TOKEN_HEADER, 'x-relay-token');
  assert.equal(RELAY_PAIRING_HEADER, 'x-relay-pairing');
  assert.equal(ENDS_PATH, '/ends');
  assert.equal(CONTROL_PATH, '/control');
  assert.equal(PAIR_PATH, '/pair');
  assert.equal(ATTACH_PREFIX, '/attach/');
  assert.equal(ATTACH_AS_PARAM, 'as');
  assert.equal(FRAME_ANNOUNCE, 'announce');
  assert.equal(FRAME_ANNOUNCED, 'announced');
  assert.equal(FRAME_HEARTBEAT, 'heartbeat');
  assert.equal(FRAME_DIAL_BACK, 'dial-back');
  assert.equal(UPGRADE_UNAUTHORIZED, 'HTTP/1.1 401 Unauthorized\r\n\r\n');
});

test('an attach path url-encodes both the end id and the client name', () => {
  assert.equal(attachPath('my end/1', 'phone?x'), '/attach/my%20end%2F1?as=phone%3Fx');
  const parsed = parseRelayPath(attachPath('my end/1', 'phone?x'));
  assert.deepEqual(parsed, { route: 'attach', endId: 'my end/1', clientEnd: 'phone?x' });
});

test('routing recognises the four paths and nothing else', () => {
  assert.equal(parseRelayPath('/ends').route, 'ends');
  assert.equal(parseRelayPath('/ends?stale=1').route, 'ends');
  assert.equal(parseRelayPath('/control').route, 'control');
  assert.equal(parseRelayPath('/pair').route, 'pair');
  assert.equal(parseRelayPath('/attach/x?as=y').route, 'attach');
  assert.equal(parseRelayPath('/').route, null);
  assert.equal(parseRelayPath('/ends/').route, null);
  assert.equal(parseRelayPath('/attach').route, null);
  assert.equal(parseRelayPath('/Control').route, null);
  assert.equal(parseRelayPath(undefined).route, null);
});

test('a malformed percent escape in an end id is a refusal, not a throw', () => {
  const parsed = parseRelayPath('/attach/%zz?as=phone');
  assert.equal(parsed.route, 'attach');
  // Left undecoded: it names no registration, so it earns "no end named ...".
  assert.equal(parsed.endId, '%zz');
});

test('a blank or missing client name parses as empty', () => {
  assert.equal(parseRelayPath('/attach/x').clientEnd, '');
  assert.equal(parseRelayPath('/attach/x?as=').clientEnd, '');
  assert.equal(parseRelayPath('/attach/x?as=%20%20').clientEnd, '');
  assert.equal(parseRelayPath('/attach/x?as=%20phone%20').clientEnd, 'phone');
});

test('a record carries every field, typed, however thin the announce was', () => {
  const record = recordFromAnnounce({ end: 'alpha' }, { announcedAt: 10, lastSeenAt: 20 });
  assert.deepEqual(record, {
    end: 'alpha',
    connection: '',
    pid: 0,
    host: null,
    cwd: null,
    runtime: null,
    listen: null,
    busy: false,
    announcedAt: 10,
    lastSeenAt: 20,
  });
  assert.deepEqual(Object.keys(record), [
    'end', 'connection', 'pid', 'host', 'cwd', 'runtime', 'listen', 'busy', 'announcedAt', 'lastSeenAt',
  ]);
});

test('a record keeps what the end said and coerces what it fumbled', () => {
  const record = recordFromAnnounce(
    { end: 'beta', connection: 'c-9', pid: '71', host: 'mac', cwd: '', runtime: 'node', listen: '127.0.0.1:1', busy: 'yes' },
    { announcedAt: 1, lastSeenAt: 2 },
  );
  assert.equal(record.pid, 71);
  assert.equal(record.cwd, null); // an empty cwd and no cwd mean the same thing
  // `busy` is a boolean on the wire; a truthy string is not an end saying yes.
  assert.equal(record.busy, false);
  assert.equal(recordFromAnnounce({ end: 'b', busy: true }, { announcedAt: 1, lastSeenAt: 2 }).busy, true);
  assert.equal(recordFromAnnounce({ end: 'b', pid: 'x' }, { announcedAt: 1, lastSeenAt: 2 }).pid, 0);
});

test('unparseable control chatter is nothing, not an error', () => {
  assert.equal(parseControlFrame('not json'), null);
  assert.equal(parseControlFrame('[1,2]'), null);
  assert.equal(parseControlFrame('null'), null);
  assert.equal(parseControlFrame('"a string"'), null);
  assert.equal(parseControlFrame(Buffer.from('{}')), null);
  assert.deepEqual(parseControlFrame('{"kind":"heartbeat"}'), { kind: 'heartbeat' });
});
