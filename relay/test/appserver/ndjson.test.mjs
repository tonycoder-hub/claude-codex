import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NdjsonDecoder, NdjsonError, encodeNdjson } from '../../src/appserver/ndjson.mjs';

/** A decoder plus the arrays it fills, which is what every test here wants. */
function harness() {
  const messages = [];
  const errors = [];
  const decoder = new NdjsonDecoder({
    onMessage: (value) => messages.push(value),
    onError: (error) => errors.push(error),
  });
  return { decoder, messages, errors };
}

const bytes = (text) => new TextEncoder().encode(text);

test('a decoder needs somewhere to put its messages', () => {
  assert.throws(() => new NdjsonDecoder(), TypeError);
  assert.throws(() => new NdjsonDecoder({ onMessage: 'nope' }), TypeError);
});

test('one object per line', () => {
  const { decoder, messages } = harness();
  decoder.push('{"jsonrpc":"2.0","id":1,"result":{"threadId":"t1"}}\n');
  assert.deepEqual(messages, [{ jsonrpc: '2.0', id: 1, result: { threadId: 't1' } }]);
});

test('an object split across chunk boundaries is reassembled', () => {
  const { decoder, messages } = harness();
  decoder.push('{"method":"item/agent');
  assert.deepEqual(messages, [], 'nothing is emitted until the newline arrives');
  assert.ok(decoder.buffered > 0);
  decoder.push('Message/delta","params":{"delta":"hel');
  assert.deepEqual(messages, []);
  decoder.push('lo"}}\n');
  assert.deepEqual(messages, [{ method: 'item/agentMessage/delta', params: { delta: 'hello' } }]);
  assert.equal(decoder.buffered, 0);
});

test('a newline arriving on its own completes the line', () => {
  const { decoder, messages } = harness();
  decoder.push('{"a":1}');
  decoder.push('\n');
  assert.deepEqual(messages, [{ a: 1 }]);
});

test('several objects in one chunk all come out, in order', () => {
  const { decoder, messages } = harness();
  decoder.push('{"n":1}\n{"n":2}\n{"n":3}\n');
  assert.deepEqual(messages.map((m) => m.n), [1, 2, 3]);
});

test('a chunk ending mid-object keeps only the tail', () => {
  const { decoder, messages } = harness();
  decoder.push('{"n":1}\n{"n":2}\n{"n":');
  assert.deepEqual(messages.map((m) => m.n), [1, 2]);
  decoder.push('3}\n');
  assert.deepEqual(messages.map((m) => m.n), [1, 2, 3]);
});

test('CRLF line endings are tolerated', () => {
  const { decoder, messages, errors } = harness();
  decoder.push('{"n":1}\r\n{"n":2}\r\n');
  assert.deepEqual(messages.map((m) => m.n), [1, 2]);
  assert.deepEqual(errors, [], 'a stray \\r must not become a parse error');
});

test('blank and whitespace-only lines are skipped silently', () => {
  const { decoder, messages, errors } = harness();
  decoder.push('\n\n{"n":1}\n   \n\r\n{"n":2}\n');
  assert.deepEqual(messages.map((m) => m.n), [1, 2]);
  assert.deepEqual(errors, []);
});

test('a malformed line is reported and the next good line still arrives', () => {
  const { decoder, messages, errors } = harness();
  decoder.push('{"n":1}\n{ this is not json }\n{"n":2}\n');
  assert.deepEqual(messages.map((m) => m.n), [1, 2], 'the stream survives one bad line');
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof NdjsonError);
  assert.equal(errors[0].line, '{ this is not json }');
  assert.match(errors[0].message, /not valid JSON/);
  assert.ok(errors[0].cause instanceof SyntaxError);
});

test('a very long bad line is previewed in the message but kept whole on .line', () => {
  const { decoder, errors } = harness();
  const long = `{${'x'.repeat(500)}`;
  decoder.push(`${long}\n`);
  assert.equal(errors[0].line, long);
  assert.ok(errors[0].message.includes('...'));
  assert.ok(errors[0].message.length < 300);
});

test('byte chunks decode, including a multi-byte character split across them', () => {
  const { decoder, messages, errors } = harness();
  const line = bytes('{"text":"café — über"}\n');
  // Cut between the two bytes of "é" so a non-streaming decode would emit U+FFFD.
  const split = 13;
  assert.equal(line[split] & 0xc0, 0x80, 'the split must land mid-character for this test to mean anything');
  decoder.push(line.subarray(0, split));
  decoder.push(line.subarray(split));
  assert.deepEqual(errors, []);
  assert.deepEqual(messages, [{ text: 'café — über' }]);
});

test('Buffer and ArrayBuffer chunks both work', () => {
  const { decoder, messages } = harness();
  decoder.push(Buffer.from('{"n":1}\n'));
  const view = bytes('{"n":2}\n');
  decoder.push(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  assert.deepEqual(messages.map((m) => m.n), [1, 2]);
});

test('flush delivers a final line that never got its newline', () => {
  const { decoder, messages } = harness();
  decoder.push('{"n":1}\n{"last":true}');
  assert.deepEqual(messages, [{ n: 1 }]);
  decoder.flush();
  assert.deepEqual(messages, [{ n: 1 }, { last: true }]);
  decoder.flush();
  assert.equal(messages.length, 2, 'flushing twice must not duplicate');
});

test('flush on an empty buffer is a no-op', () => {
  const { decoder, messages, errors } = harness();
  decoder.push('{"n":1}\n');
  decoder.flush();
  assert.equal(messages.length, 1);
  assert.deepEqual(errors, []);
});

test('reset forgets a partial line', () => {
  const { decoder, messages, errors } = harness();
  decoder.push('{"half":');
  decoder.reset();
  assert.equal(decoder.buffered, 0);
  decoder.push('{"n":1}\n');
  assert.deepEqual(messages, [{ n: 1 }]);
  assert.deepEqual(errors, [], 'the abandoned half-line must not resurface as garbage');
});

test('a throwing message handler is reported and does not stop the chunk', () => {
  const seen = [];
  const errors = [];
  const decoder = new NdjsonDecoder({
    onMessage: (value) => {
      seen.push(value.n);
      if (value.n === 2) throw new Error('handler exploded');
    },
    onError: (error) => errors.push(error),
  });
  assert.doesNotThrow(() => decoder.push('{"n":1}\n{"n":2}\n{"n":3}\n'));
  assert.deepEqual(seen, [1, 2, 3], 'the third line is still delivered');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /handler exploded/);
  assert.equal(errors[0].line, '{"n":2}');
});

test('a throwing error hook cannot escape either', () => {
  const decoder = new NdjsonDecoder({
    onMessage: () => {},
    onError: () => {
      throw new Error('reporting exploded');
    },
  });
  assert.doesNotThrow(() => decoder.push('nonsense\n'));
});

test('a bad line with no error hook is simply dropped', () => {
  const messages = [];
  const decoder = new NdjsonDecoder({ onMessage: (value) => messages.push(value) });
  assert.doesNotThrow(() => decoder.push('nonsense\n{"n":1}\n'));
  assert.deepEqual(messages, [{ n: 1 }]);
});

test('a handler that pushes re-entrantly does not corrupt the buffer', () => {
  const messages = [];
  let decoder;
  decoder = new NdjsonDecoder({
    onMessage: (value) => {
      messages.push(value);
      if (value.n === 1) decoder.push('{"n":99}\n');
    },
  });
  decoder.push('{"n":1}\n{"n":2}\n');
  assert.deepEqual(messages.map((m) => m.n), [1, 99, 2]);
  assert.equal(decoder.buffered, 0);
});

test('JSON scalars are legal NDJSON values, not just objects', () => {
  const { decoder, messages } = harness();
  decoder.push('null\n42\n"text"\n[1,2]\n');
  assert.deepEqual(messages, [null, 42, 'text', [1, 2]]);
});

test('the encoder appends exactly one newline and escapes any inside', () => {
  const line = encodeNdjson({ method: 'turn/start', params: { text: 'two\nlines' } });
  assert.equal(line.at(-1), '\n');
  assert.equal(line.split('\n').length, 2, 'an embedded newline must be escaped, not framed');
  assert.deepEqual(JSON.parse(line), { method: 'turn/start', params: { text: 'two\nlines' } });
});

test('the encoder and decoder round-trip through each other', () => {
  const { decoder, messages } = harness();
  const originals = [
    { jsonrpc: '2.0', id: 1, method: 'thread/start', params: { cwd: '/tmp' } },
    { jsonrpc: '2.0', method: 'item/reasoning/textDelta', params: { delta: 'é\r\n\t' } },
    { jsonrpc: '2.0', id: 1, result: null },
  ];
  decoder.push(originals.map(encodeNdjson).join(''));
  assert.deepEqual(messages, originals);
});

test('the encoder refuses a value JSON cannot represent', () => {
  assert.throws(() => encodeNdjson(undefined), NdjsonError);
  assert.throws(() => encodeNdjson({ big: 1n }), TypeError); // JSON.stringify's own refusal
});
