// The archive reader, against archives this file builds byte by byte.
//
// Building them here rather than checking one in is the point: the reader's
// whole job is to agree with a format, and a fixture produced by the same
// understanding that produced the reader would agree with it by construction.
// So `buildArchive` writes the four preamble integers and the data region
// independently of how asar.mjs reads them, and the malformed cases below are
// made by corrupting one integer at a time.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive, ArchiveError, openArchive } from '../../src/renderer/asar.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'asar-test-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

let serial = 0;

/**
 * Write an asar whose tree is `{ 'a/b.txt': Buffer|string }`.
 *
 * @param {Record<string, string|Buffer>} files
 * @param {(preamble: Buffer, json: Buffer) => void} [corrupt] mutate before write
 */
function buildArchive(files, corrupt) {
  const entries = [];
  let offset = 0;
  const tree = { files: {} };
  for (const [path, body] of Object.entries(files)) {
    let node = tree;
    const segments = path.split('/');
    for (const dir of segments.slice(0, -1)) {
      node.files[dir] ??= { files: {} };
      node = node.files[dir];
    }
    // A raw node, for the shapes an App update could introduce and this
    // archive has none of today.
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      node.files[segments.at(-1)] = body.__node;
      continue;
    }
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    node.files[segments.at(-1)] = { size: bytes.length, offset: String(offset) };
    entries.push(bytes);
    offset += bytes.length;
  }

  const json = Buffer.from(JSON.stringify(tree), 'utf8');
  // Two nested pickles, and the arithmetic between them is the part worth
  // spelling out, because getting it wrong here produced a four-byte shift
  // that looked exactly like a reader bug:
  //
  //   outer pickle   [0,4)=4            [4,8)=pickleSize
  //   header pickle  [8,12)=payload     [12,16)=jsonLength  [16,…)=json+padding
  //
  //   payload    = 4 + jsonLength + padding   (the length field plus the string)
  //   pickleSize = 4 + payload                (the payload plus its own length)
  //
  // so data begins at 8 + pickleSize = 16 + jsonLength + padding. Padding to a
  // 4-byte boundary is inside both numbers; reproducing it is what proves the
  // reader uses pickleSize rather than 16 + jsonLength.
  const padding = (4 - (json.length % 4)) % 4;
  const payloadSize = 4 + json.length + padding;
  const pickleSize = 4 + payloadSize;
  const preamble = Buffer.alloc(16);
  preamble.writeUInt32LE(4, 0);
  preamble.writeUInt32LE(pickleSize, 4);
  preamble.writeUInt32LE(payloadSize, 8);
  preamble.writeUInt32LE(json.length, 12);
  corrupt?.(preamble, json);

  const file = join(scratch, `fixture-${serial++}.asar`);
  writeFileSync(file, Buffer.concat([preamble, json, Buffer.alloc(padding), ...entries]));
  return file;
}

async function drain(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('reads an entry back whole, through the padded header', async () => {
  const file = buildArchive({ 'webview/index.html': '<!doctype html>', 'webview/assets/app.js': 'export default 1;' });
  const archive = openArchive(file);
  try {
    assert.equal((await drain(archive.createReadStream(archive.stat('webview/index.html')))).toString(), '<!doctype html>');
    assert.equal(archive.read(archive.stat('webview/assets/app.js')).toString(), 'export default 1;');
  } finally {
    archive.close();
  }
});

test('an entry is bounded by its size, not by what follows it', async () => {
  // The failure this guards against is not a crash: a stream that ran to EOF
  // would serve the next file appended to this one, and the browser would show
  // a JS chunk with another chunk glued to its tail.
  const file = buildArchive({ 'a.txt': 'first', 'b.txt': 'second' });
  const archive = openArchive(file);
  try {
    assert.equal((await drain(archive.createReadStream(archive.stat('a.txt')))).toString(), 'first');
  } finally {
    archive.close();
  }
});

test('an empty entry streams as zero bytes rather than throwing a reversed range', async () => {
  const file = buildArchive({ 'empty.css': '', 'after.css': 'body{}' });
  const archive = openArchive(file);
  try {
    assert.equal((await drain(archive.createReadStream(archive.stat('empty.css')))).length, 0);
    assert.equal(archive.read(archive.stat('empty.css')).length, 0);
    assert.equal(archive.read(archive.stat('after.css')).toString(), 'body{}');
  } finally {
    archive.close();
  }
});

test('concurrent streams over one descriptor do not interleave', async () => {
  // Explicit-position reads are pread(2), so the shared fd has no cursor to
  // race over. If that ever stops being true the symptom is this test, not a
  // corrupted asset in a browser.
  const big = (c) => Buffer.alloc(300_000, c);
  const file = buildArchive({ 'one': big('1'), 'two': big('2'), 'three': big('3') });
  const archive = openArchive(file);
  try {
    const [a, b, c] = await Promise.all(['one', 'two', 'three'].map(
      (name) => drain(archive.createReadStream(archive.stat(name))),
    ));
    assert.ok(a.equals(big('1')));
    assert.ok(b.equals(big('2')));
    assert.ok(c.equals(big('3')));
  } finally {
    archive.close();
  }
});

test('a miss, a directory and a prototype key all return null', () => {
  const file = buildArchive({ 'webview/index.html': 'x' });
  const archive = openArchive(file);
  try {
    assert.equal(archive.stat('webview/nope.html'), null);
    assert.equal(archive.stat('webview'), null, 'a directory is not servable');
    // Without Object.hasOwn this walks into Object.prototype and returns a
    // function, which fails later and somewhere else.
    assert.equal(archive.stat('constructor'), null);
    assert.equal(archive.stat('webview/__proto__'), null);
    assert.equal(archive.stat('toString'), null);
  } finally {
    archive.close();
  }
});

test('`..` is a key that does not exist, not a parent reference', () => {
  const file = buildArchive({ 'webview/index.html': 'x', 'secret.txt': 'y' });
  const archive = openArchive(file);
  try {
    assert.equal(archive.stat('webview/../secret.txt'), null);
    // And the harmless ones still resolve, because the walk skips them.
    assert.deepEqual(archive.stat('/webview/./index.html'), archive.stat('webview/index.html'));
    assert.deepEqual(archive.stat('//webview//index.html'), archive.stat('webview/index.html'));
  } finally {
    archive.close();
  }
});

test('the entry shapes we refuse are a miss, not a guess at their bytes', () => {
  // None of these exist in the shipped archive. They are refused so that an
  // App update which introduces one produces a 404 with a log line, instead of
  // a response whose body came from whatever offset happened to be there.
  const file = buildArchive({
    'plain.txt': 'x',
    'linked.txt': { __node: { link: 'plain.txt' } },
    'outside.node': { __node: { size: 1, offset: '0', unpacked: true } },
    'sizeless.txt': { __node: { offset: '0' } },
    'negative.txt': { __node: { size: -1, offset: '0' } },
    'faroff.txt': { __node: { size: 1, offset: '99999999999999999999' } },
    'notanumber.txt': { __node: { size: 1, offset: 'banana' } },
  });
  const archive = openArchive(file);
  try {
    assert.ok(archive.stat('plain.txt'), 'sanity: a plain entry still resolves');
    for (const name of ['linked.txt', 'outside.node', 'sizeless.txt', 'negative.txt', 'faroff.txt', 'notanumber.txt']) {
      assert.equal(archive.stat(name), null, name);
    }
  } finally {
    archive.close();
  }
});

test('a file that is not an asar fails at the preamble, not inside JSON.parse', () => {
  const file = join(scratch, 'not-an-asar.bin');
  writeFileSync(file, Buffer.alloc(4096, 0xff));
  assert.throws(() => openArchive(file), (err) => {
    assert.ok(err instanceof ArchiveError);
    assert.match(err.message, /not an asar|implausible/);
    return true;
  });
});

test('a truncated archive says so instead of returning a short header', () => {
  const file = join(scratch, 'short.asar');
  const preamble = Buffer.alloc(16);
  preamble.writeUInt32LE(4, 0);
  preamble.writeUInt32LE(1000, 4);
  preamble.writeUInt32LE(996, 8);
  preamble.writeUInt32LE(992, 12);
  writeFileSync(file, Buffer.concat([preamble, Buffer.from('{"files":{}}')]));
  assert.throws(() => openArchive(file), /ends inside its header/);
});

test('an implausible header length is refused before it is allocated', () => {
  const file = buildArchive({ 'a.txt': 'x' }, (preamble) => preamble.writeUInt32LE(0xffffffff, 12));
  assert.throws(() => openArchive(file), /implausible header length/);
});

test('a header pickle smaller than its header is refused', () => {
  const file = buildArchive({ 'a.txt': 'x' }, (preamble) => preamble.writeUInt32LE(2, 4));
  assert.throws(() => openArchive(file), /pickle smaller than its header/);
});

test('a header that is not JSON names the archive', () => {
  const file = buildArchive({ 'a.txt': 'x' }, (_preamble, json) => json.write('@@@', 0));
  assert.throws(() => openArchive(file), /unreadable header/);
});

test('a header with no file tree is refused', () => {
  const file = join(scratch, 'treeless.asar');
  const json = Buffer.from('{"notfiles":1}', 'utf8');
  const preamble = Buffer.alloc(16);
  preamble.writeUInt32LE(4, 0);
  preamble.writeUInt32LE(8 + json.length, 4);
  preamble.writeUInt32LE(4 + json.length, 8);
  preamble.writeUInt32LE(json.length, 12);
  writeFileSync(file, Buffer.concat([preamble, json]));
  assert.throws(() => openArchive(file), /no file tree/);
});

test('a directory is refused by path, and the descriptor is not leaked', () => {
  const dir = join(scratch, 'adir.asar');
  mkdirSync(dir, { recursive: true });
  assert.throws(() => openArchive(dir), /is not a file/);
});

test('using a closed archive is an error, not an EBADF from somewhere else', () => {
  const file = buildArchive({ 'a.txt': 'x' });
  const archive = openArchive(file);
  const entry = archive.stat('a.txt');
  archive.close();
  archive.close();  // idempotent: a double close must not close someone else's fd
  assert.throws(() => archive.stat('a.txt'), /archive is closed/);
  assert.throws(() => archive.createReadStream(entry), /archive is closed/);
  assert.throws(() => archive.read(entry), /archive is closed/);
});

test('destroying a stream leaves the archive readable', async () => {
  // The bug this exists for: with fs.createReadStream({ fd, autoClose: false })
  // an explicit destroy() -- which the server calls on every finished response
  // -- closed the archive's own descriptor, so the second asset of a page load
  // failed EBADF. Draining a stream never showed it, because autoClose: false
  // also turned autoDestroy off. The destroy below is the whole test.
  const file = buildArchive({ 'a.js': 'export const a = 1;', 'b.js': 'export const b = 2;' });
  const archive = openArchive(file);
  try {
    const first = archive.createReadStream(archive.stat('a.js'));
    assert.equal((await drain(first)).toString(), 'export const a = 1;');
    // `for await` destroys the stream when it ends, so this is the second
    // destroy and not the first. Both have to be harmless: the server calls
    // one explicitly, and there is no ordering between that and the iterator's.
    first.destroy();
    assert.ok(first.destroyed);

    assert.equal((await drain(archive.createReadStream(archive.stat('b.js')))).toString(), 'export const b = 2;');
    assert.equal(archive.read(archive.stat('b.js')).toString(), 'export const b = 2;');
  } finally {
    archive.close();
  }
});

test('abandoning a stream half-read leaves the archive readable', async () => {
  // A phone that walks out of signal mid-asset. The server destroys the stream
  // with bytes still owed, which is the same path as above but from a state
  // where a read may be in flight.
  const file = buildArchive({ 'big.js': Buffer.alloc(400_000, 'x'), 'after.js': 'tail' });
  const archive = openArchive(file);
  try {
    const stream = archive.createReadStream(archive.stat('big.js'));
    await once(stream, 'readable');
    stream.read();
    stream.destroy();
    await once(stream, 'close');
    assert.equal(archive.read(archive.stat('after.js')).toString(), 'tail');
  } finally {
    archive.close();
  }
});

test('closing the archive mid-stream lets that stream finish, and admits no new ones', async () => {
  // The descriptor outlives close() for as long as something can still read it,
  // because an fd number is reusable the instant it is closed and this process
  // opens files constantly. `stat` is what stops new readers.
  const body = Buffer.alloc(300_000, 'z');
  const file = buildArchive({ 'big': body });
  const archive = openArchive(file);
  const stream = archive.createReadStream(archive.stat('big'));
  const iterator = stream[Symbol.asyncIterator]();
  const chunks = [];

  const first = await iterator.next();
  chunks.push(first.value);
  assert.ok(first.value.length > 0 && first.value.length < body.length, 'the entry arrives in parts');

  archive.close();
  assert.throws(() => archive.stat('big'), /archive is closed/);

  for (let next = await iterator.next(); !next.done; next = await iterator.next()) chunks.push(next.value);
  assert.ok(Buffer.concat(chunks).equals(body), 'the in-flight read finished against a live descriptor');

  archive.close();  // the fd went with the stream; this must still be a no-op
});

test('mtimeMs tracks the archive, which is how a reader knows the App updated', () => {
  const file = buildArchive({ 'a.txt': 'x' });
  const archive = openArchive(file);
  try {
    assert.equal(typeof archive.mtimeMs, 'number');
    assert.ok(archive.mtimeMs > 0);
  } finally {
    archive.close();
  }
});
