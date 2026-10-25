// What the host's filesystem does when the adapter is slower, older or more
// hostile than the happy path.
//
// Three groups, and the middle one is the reason this file exists. The codec
// and the walker are transcriptions, so their tests pin arithmetic. The
// sniffer and the etag are the two places where I copied a shape out of the
// App's main process without being able to copy its implementation, so their
// tests pin the BOUNDARIES -- the byte that flips text to binary, the stat
// field that moves the key -- because a transcription that is subtly off is
// worse than one that is obviously off. And `createHostFiles` is tested
// mostly for its failures: a missing field, a throwing stat, a reply that
// never comes.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FOLDER_FILE_CAP,
  HostFilesError,
  SNIFF_BYTES,
  createHostFiles,
  decodeBase64,
  detectContentKind,
  detectFileType,
  detectMimeType,
  encodeBase64,
  etagFor,
  isTextBytes,
} from '../../web/host-files.mjs';

const bytes = (...values) => new Uint8Array(values);

/** A `call` built from a plain object tree, so a test reads as its own fixture. */
function fakeAdapter(tree, { onCall = null } = {}) {
  return async (method, params) => {
    onCall?.(method, params);
    const node = tree[params?.path];
    if (node === undefined) throw new Error(`ENOENT: ${params?.path}`);
    if (method === 'fs/readFile') return { dataBase64: encodeBase64(node) };
    if (method === 'fs/readDirectory') return { entries: node };
    if (method === 'fs/getMetadata') return node;
    throw new Error(`unexpected method ${method}`);
  };
}

const dir = (...entries) => entries;
const file = (name) => ({ fileName: name, isFile: true, isDirectory: false });
const folder = (name) => ({ fileName: name, isFile: false, isDirectory: true });
// A symlink's dirent reports neither, which is the whole reason the walker can
// skip the App's per-subdirectory stat.
const link = (name) => ({ fileName: name, isFile: false, isDirectory: false });

// ---- the codec -------------------------------------------------------------

test('every byte survives the round trip, at all three tail lengths', () => {
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) all[i] = i;
  // 256 % 3 === 1, so slicing off 0, 1 and 2 bytes covers the one-, two- and
  // three-byte tails, which is where a base64 encoder goes wrong if it does.
  for (const drop of [0, 1, 2]) {
    const input = all.subarray(0, 256 - drop);
    assert.deepEqual(decodeBase64(encodeBase64(input)), input, `tail of ${(256 - drop) % 3} bytes`);
  }
  assert.deepEqual(decodeBase64(encodeBase64(bytes())), bytes(), 'an empty file is a legal file');
});

test('padding and whitespace carry no information', () => {
  // The adapter pads, but a base64 string that has been through a JSON
  // pretty-printer or a log somewhere upstream may not arrive that way.
  assert.deepEqual(decodeBase64('QUJD'), bytes(65, 66, 67));
  assertSame('QQ==', 'QQ');
  assertSame('QUJDRA==', 'QU JD\nRA');
  function assertSame(a, b) {
    assert.deepEqual(decodeBase64(a), decodeBase64(b), `${JSON.stringify(a)} and ${JSON.stringify(b)}`);
  }
});

test('a 1-character tail is a truncated transfer and says so', () => {
  // Six bits is not a byte. Accepting it would silently drop the character,
  // and a file one byte short is the kind of corruption that surfaces much
  // later as a parse error in something else.
  assert.throws(() => decodeBase64('QUJDQ'), HostFilesError);
  assert.throws(() => decodeBase64('Q'), /1-character tail/);
});

test('base64url input is rejected rather than quietly mis-decoded', () => {
  // `-` and `_` are valid characters in the OTHER alphabet. Mapping them onto
  // 62 and 63 here would make this function accept both encodings and so make
  // a mismatch between the two undetectable -- and the adapter speaks
  // standard base64, so an encoding that is not standard means something
  // upstream is not the adapter.
  assert.throws(() => decodeBase64('q-_D'), /outside the standard alphabet/);
  assert.throws(() => decodeBase64('QU.D'), HostFilesError);
  assert.throws(() => decodeBase64(undefined), /expected a base64 string/);
});

// ---- the sniffer -----------------------------------------------------------
//
// Transcribed from the App's own: UTF-8 decode the first 4096 bytes, and call
// it binary if any character is below 32 and outside 7..14.

test('an empty file is text, and a NUL byte is what makes a file binary', () => {
  assert.equal(isTextBytes(bytes()), true, 'the App returns text for an empty buffer by an explicit check');
  assert.equal(isTextBytes(bytes(104, 105)), true);
  assert.equal(isTextBytes(bytes(104, 0, 105)), false, 'NUL is below 7');
});

test('the whitespace control characters are text and the others are not', () => {
  // 7..14 is BEL through FF: bell, backspace, tab, LF, VT, FF, CR. The range
  // is the App's and it is wider than it looks -- a bare BEL in a log file
  // keeps that file text.
  for (const code of [7, 8, 9, 10, 11, 12, 13, 14]) {
    assert.equal(isTextBytes(bytes(97, code, 98)), true, `control ${code} is inside the allowed range`);
  }
  for (const code of [1, 6, 15, 31]) {
    assert.equal(isTextBytes(bytes(97, code, 98)), false, `control ${code} is outside it`);
  }
});

test('invalid UTF-8 is still text, because the replacement character is not a control', () => {
  // A deliberate consequence of decoding before testing rather than a gap: a
  // lone continuation byte decodes to U+FFFD, which is far above 32. So a
  // Latin-1 file reads as text and is returned as text, mojibake and all.
  // The alternative -- treating undecodable bytes as binary -- would send
  // every non-UTF-8 source file to the renderer as a base64 blob.
  assert.equal(isTextBytes(bytes(104, 0x80, 105)), true);
  assert.equal(isTextBytes(bytes(0xff, 0xfe)), true);
});

test('only the first sniff window decides, so a NUL past it is missed', () => {
  // Not a bug to fix: it is the App's behaviour, it bounds the work on a large
  // file, and the alternative would mean decoding an entire 45 MiB attachment
  // to answer a question about its first screenful. Pinned so that a future
  // change to SNIFF_BYTES is a decision and not a surprise.
  const long = new Uint8Array(SNIFF_BYTES + 16).fill(97);
  long[SNIFF_BYTES + 4] = 0;
  assert.equal(isTextBytes(long), true, 'the NUL is outside the window');
  const short = new Uint8Array(SNIFF_BYTES + 16).fill(97);
  short[SNIFF_BYTES - 1] = 0;
  assert.equal(isTextBytes(short), false, 'and inside it, it still counts');
});

// The magic-byte table, which stands in for the `file-type` package the App
// imports and this page cannot load. It covers about forty formats where that
// package covers several hundred, and the honest statement of the limitation
// is in the fallthrough: a format the table does not know is handed to the
// text-or-binary test above and comes out `binary`, which the renderer routes
// to a download button. Poorer than a preview, never a wrong claim about the
// bytes. So these tests spend their effort on the three places where the table
// could be wrong rather than merely incomplete: the containers whose leading
// bytes are shared by several kinds, the signature that is not at offset zero,
// and the markup that has no signature at all.

const ascii = (text) => new TextEncoder().encode(text);
const joined = (...parts) => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};
/** RIFF and ISO-BMFF both put the discriminator at offset 8. */
const riff = (form) => joined(ascii('RIFF'), bytes(0, 0, 0, 0), ascii(form), bytes(0, 0, 0, 0));
const ftyp = (brand) => joined(bytes(0, 0, 0, 0x20), ascii('ftyp'), ascii(brand), bytes(0, 0, 0, 0));

test('RIFF is three different kinds and the leading bytes say none of them', () => {
  // The reason this is checked ahead of the table rather than in it: a webp
  // image, a wav recording and an avi video are byte-identical for eight
  // bytes, so a table keyed on a prefix would answer whichever entry it
  // reached first for all three.
  assert.equal(detectContentKind(riff('WEBP')), 'image');
  assert.equal(detectContentKind(riff('WAVE')), 'audio');
  assert.equal(detectContentKind(riff('AVI ')), 'video');
  assert.equal(detectMimeType(riff('WEBP')), 'image/webp');

  // An unknown RIFF form is NOT guessed. RIFF carries formats this table has
  // no kind for, and a container is exactly where a wrong guess is most
  // likely, so it falls through to the text test and lands on binary.
  assert.equal(detectFileType(riff('XXXX')), null);
  assert.equal(detectContentKind(riff('XXXX')), 'binary');
});

test('an ISO-BMFF brand picks the kind, and an unknown brand defaults to video', () => {
  // Same container, four kinds: heic and avif are photographs, m4a is music,
  // mp4 and mov are video. The brand at offset 8 is the only thing that
  // separates them.
  assert.equal(detectContentKind(ftyp('heic')), 'image');
  assert.equal(detectContentKind(ftyp('avif')), 'image');
  assert.equal(detectContentKind(ftyp('M4A ')), 'audio');
  assert.equal(detectContentKind(ftyp('qt  ')), 'video');

  // The default here IS a guess, unlike RIFF's, and it is a safe one: every
  // brand the App's table lists that this one omits -- isom, iso2, mp41, mp42,
  // mmp4 -- is a video file, and a photo library is full of HEICs that would
  // otherwise download instead of opening.
  assert.equal(detectMimeType(ftyp('iso2')), 'video/mp4');
  assert.equal(detectContentKind(ftyp('mmp4')), 'video');
});

test('a tar is recognised from byte 257, which is why offsets are part of the table', () => {
  // The one signature in the table that is not a prefix. A tar begins with a
  // file name, so its first 256 bytes are arbitrary -- and its first bytes are
  // usually printable, which means the text test would have called this file
  // text and the renderer would have opened a 10 MiB archive in an editor.
  const tar = new Uint8Array(512);
  tar.set(ascii('some/file/name'), 0);
  tar.set(ascii('ustar'), 257);
  assert.deepEqual(detectFileType(tar), { mime: 'application/x-tar', ext: 'tar' });
  assert.equal(detectContentKind(tar), 'archive');
});

test('an archive is archive by extension, which is what keeps a .docx out of binary', () => {
  // The App's set is keyed on the EXTENSION its sniffer returns, not on the
  // mime type, and transcribing it the other way would have been the easy
  // mistake: every Office document and every epub is a zip whose mime is
  // `application/zip` or an application/* of its own, so a mime-keyed set
  // sends all of them to `binary` while a .zip next to them says `archive`.
  const zip = bytes(0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0);
  assert.equal(detectContentKind(zip), 'archive');
  assert.equal(detectContentKind(bytes(0x1f, 0x8b, 0x08, 0)), 'archive', 'gzip');
  assert.equal(detectContentKind(bytes(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)), 'archive', '7z');
});

test('SVG is sniffed before the table, because it has no magic bytes to find', () => {
  // Markup, so it is also text, and both answers are defensible -- the App
  // picks `image` and so does this, because an SVG opened in a viewer is what
  // the user meant and an SVG opened in an editor is a surprise. Checked
  // ahead of the table rather than after the text fallthrough for exactly
  // that reason.
  assert.equal(detectContentKind(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>')), 'image');
  assert.equal(detectMimeType(ascii('<?xml version="1.0"?><svg viewBox="0 0 1 1"/>')), 'image/svg+xml');

  // A root element merely starting with "svg" is not one, and prose that
  // mentions the word is not either. The test is `<svg` followed by a space
  // or a close, which is the narrowest thing that still accepts both forms
  // above.
  assert.equal(detectContentKind(ascii('<svgx a="1"/>')), 'text');
  assert.equal(detectContentKind(ascii('an article about <svgs> in general')), 'text');
});

test('an unrecognised format degrades to the text test rather than to a guess', () => {
  // The limitation, stated as a test so that it is visible in the suite
  // instead of only in a comment. A Photoshop file, a sqlite database, a Mach-O
  // binary: none are in this table, all are binary, and all reach `binary`
  // through the control-character test rather than through a signature.
  assert.equal(detectFileType(ascii('8BPS\u0000\u0001')), null, 'photoshop is not in the table');
  assert.equal(detectContentKind(ascii('8BPS\u0000\u0001')), 'binary', 'and a NUL still settles it');
  assert.equal(detectMimeType(ascii('8BPS\u0000\u0001')), null, 'with no mime type invented for it');

  // The failure mode of the fallthrough, also pinned: a binary format whose
  // first bytes happen to be printable reads as text. It is the App's
  // behaviour too, and it is the price of having a fallthrough at all.
  assert.equal(detectContentKind(ascii('MZ printable enough')), 'text');
});

test('nothing, empty and short input are answered without reading past the end', () => {
  assert.equal(detectFileType(null), null);
  assert.equal(detectFileType(bytes()), null);
  assert.equal(detectContentKind(null), null, 'null means no sample was taken, not an empty file');
  assert.equal(detectContentKind(bytes()), 'text', 'an empty file is text, as above');
  // Four bytes of a signature that needs twelve. `startsWith` has to bound
  // itself rather than let an out-of-range read become `undefined === char`.
  assert.equal(detectFileType(ascii('RIFF')), null);
  assert.equal(detectFileType(bytes(0, 0, 0, 0x20)), null, 'an ftyp box with no brand');
});

// ---- the etag --------------------------------------------------------------

test('no stat is the string the App uses, not null or a throw', () => {
  // `missing` is a legal etag and a caller compares it like any other, which
  // is the only reason a read of a vanished file can mint one at all.
  return etagFor(null, 0).then((etag) => assert.equal(etag, 'missing'));
});

test('the etag is opaque, and its alphabet is the one that survives a URL', async () => {
  const etag = await etagFor({ modifiedAtMs: 1, createdAtMs: 2 }, 3);
  assert.match(etag, /^stat:[A-Za-z0-9_-]+$/, 'base64url: no +, no /, no padding');
  // Same stat, same etag -- it is a cache key, so this is the whole contract.
  assert.equal(etag, await etagFor({ modifiedAtMs: 1, createdAtMs: 2 }, 3));
  // And every component moves it, including the size, which is the component
  // this host computes from the bytes it actually received rather than from a
  // stat field the adapter does not send.
  assert.notEqual(etag, await etagFor({ modifiedAtMs: 1, createdAtMs: 2 }, 4), 'size');
  assert.notEqual(etag, await etagFor({ modifiedAtMs: 9, createdAtMs: 2 }, 3), 'mtime');
  assert.notEqual(etag, await etagFor({ modifiedAtMs: 1, createdAtMs: 9 }, 3), 'ctime');
});

test('without WebCrypto the etag degrades to a legible key instead of failing', async () => {
  // Reachable only on a dev loopback over plain http, because the passkey
  // ceremony needs a secure context and so does `crypto.subtle`. It still has
  // to produce SOMETHING: an etag that throws would take the file read down
  // with it, and the fallback satisfies the only property a cache key needs.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true, writable: true });
  try {
    const etag = await etagFor({ modifiedAtMs: 11, createdAtMs: 22 }, 33);
    assert.equal(etag, 'stat:plain-11-22-33', 'the components, unhashed and still distinguishing');
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else delete globalThis.crypto;
  }
});

// ---- the adapter-backed methods -------------------------------------------

test('a filesystem with no way to reach the adapter is refused at construction', () => {
  // Earlier than the first read, because `files` is passed to two namespace
  // members that will call it much later and a TypeError there arrives with
  // no indication of which layer was built wrong.
  assert.throws(() => createHostFiles({}), TypeError);
  assert.throws(() => createHostFiles({ call: 'nope' }), /must be a function/);
});

test('bytes come back decoded, and the counters see them', async () => {
  const files = createHostFiles({ call: fakeAdapter({ '/a.txt': bytes(104, 105, 33) }) });
  assert.deepEqual(await files.readBytes('/a.txt'), bytes(104, 105, 33));
  assert.deepEqual(files.stats(), {
    readFile: 1, getMetadata: 0, readDirectory: 0, bytes: 3, errors: 0, truncatedWalks: 0, timeouts: 0,
  });
});

test('an adapter that answers a read without the data field is named, not decoded', async () => {
  // The decode would throw anyway, with a message about base64. This is a
  // version mismatch between the host and the adapter, and that is a
  // different problem with a different fix.
  const files = createHostFiles({ call: async () => ({ ok: true }) });
  await assert.rejects(() => files.readBytes('/a.txt'), /without dataBase64/);
  assert.equal(files.stats().errors, 1);
});

test('a stat that throws is a null stat, because every caller here wants that', async () => {
  const files = createHostFiles({ call: fakeAdapter({}) });
  assert.equal(await files.metadata('/gone'), null);
  // ...and the throw is still counted. A missing file is routine; a thousand
  // missing files is a path that is wrong, and the only place that shows up is
  // the counter.
  assert.equal(files.stats().errors, 1);
  assert.equal(files.stats().getMetadata, 0);
});

test('a directory listing that is not a list reads as empty', async () => {
  const files = createHostFiles({ call: async () => ({}) });
  assert.deepEqual(await files.readDirectory('/d'), [], 'undefined entries is an empty directory');
});

// ---- the folder walk -------------------------------------------------------

test('files are counted recursively and symlinks are counted by neither host', async () => {
  const files = createHostFiles({
    call: fakeAdapter({
      '/w': dir(file('a'), folder('sub'), link('ln'), file('b')),
      '/w/sub': dir(file('c'), link('also'), folder('deep')),
      '/w/sub/deep': dir(file('d')),
    }),
  });
  // a, b, c, d. The two symlinks are skipped by `!entry.isDirectory`, which is
  // where the App spends a stat to reach the same answer.
  assert.equal(await files.countFolderFiles('/w'), 4);
});

test('a walk that runs out of directory budget is null, never a number', async () => {
  // The distinction this test exists for: `null` means "more than I was
  // willing to look at" and a number means "this is the count". Collapsing
  // them -- returning the partial count -- would show a 50,000-file folder as
  // a 1,000-file folder, which is a lie a caller cannot detect.
  const tree = { '/big': dir(...Array.from({ length: FOLDER_FILE_CAP + 1 }, (_v, i) => folder(`d${i}`))) };
  for (let i = 0; i <= FOLDER_FILE_CAP; i += 1) tree[`/big/d${i}`] = dir();
  const files = createHostFiles({ call: fakeAdapter(tree) });
  assert.equal(await files.countFolderFiles('/big'), null);
  assert.equal(files.stats().truncatedWalks, 1, 'and it is visible as a truncation, not an error');
});

test('hitting the file cap is a number, because the count is complete enough', async () => {
  // The other side of the same coin. The budget is shared, but only the
  // DIRECTORY half produces null: a folder with more files than the cap stops
  // at the cap and reports it, which is what the App does and what the
  // attachment UI wants ("1000+" is a fine thing to render).
  const tree = { '/many': dir(...Array.from({ length: FOLDER_FILE_CAP + 50 }, (_v, i) => file(`f${i}`))) };
  const files = createHostFiles({ call: fakeAdapter(tree) });
  assert.equal(await files.countFolderFiles('/many'), FOLDER_FILE_CAP);
  assert.equal(files.stats().truncatedWalks, 0);
});

test('a windows path is walked with a windows separator', async () => {
  // The adapter joins nothing; this host builds every child path itself, so
  // the separator is its problem. A resident Windows machine would otherwise
  // get `C:\w/sub` and an ENOENT on a directory that is right there.
  const seen = [];
  const files = createHostFiles({
    call: fakeAdapter(
      { 'C:\\w': dir(folder('sub')), 'C:\\w\\sub': dir(file('a')) },
      { onCall: (_m, p) => seen.push(p.path) },
    ),
  });
  assert.equal(await files.countFolderFiles('C:\\w'), 1);
  assert.deepEqual(seen, ['C:\\w', 'C:\\w\\sub']);
});

// ---- the deadline ----------------------------------------------------------

test('an adapter that never answers becomes a rejection, not a spinner', async () => {
  // The defect this was written for. `read` used to decline, so the renderer
  // got an immediate error; serving it turned that into a call on the app
  // server, and a call this host makes on its own behalf has no deadline from
  // the renderer. An unanswered one therefore waited forever -- which in this
  // suite showed up as eleven CANCELLED tests and zero failures, and on a
  // phone would show up as a file that is permanently about to open.
  const files = createHostFiles({ call: () => new Promise(() => {}), timeoutMs: 20 });
  await assert.rejects(() => files.readBytes('/slow'), HostFilesError);
  await assert.rejects(() => files.readBytes('/slow'), /fs\/readFile on the resident machine did not answer within 20ms/);
  assert.equal(files.stats().timeouts, 2, 'a timeout is its own counter: it means the relay, not the file');
});

test('the deadline also cancels, so the transport stops waiting for the reply', async () => {
  // Rejecting alone would leave the app server holding a request nobody wants
  // and, over a reconnect, a reply arriving for a promise that is long gone.
  let signal = null;
  const files = createHostFiles({
    call: (_method, _params, options) => {
      signal = options?.signal ?? null;
      return new Promise(() => {});
    },
    timeoutMs: 20,
  });
  await assert.rejects(() => files.readBytes('/slow'));
  assert.ok(signal, 'the signal reaches the client, which is what makes cancellation possible');
  assert.equal(signal.aborted, true);
});

test('the deadline holds even when the transport ignores the signal', async () => {
  // Which is why the race is not redundant with the signal. An older client,
  // and every test fake in this file, takes two arguments and drops the
  // third; if the deadline were only a request to the transport, those would
  // have no deadline at all and the hang would be back.
  const files = createHostFiles({ call: (method, params) => new Promise(() => {}), timeoutMs: 20 });
  await assert.rejects(() => files.readBytes('/slow'), /did not answer within/);
});

test('a slow answer that arrives in time is not penalised', async () => {
  // The deadline has to be a deadline and not a budget: a read that takes 15ms
  // of a 40ms allowance is a normal read over a phone link, and a timer left
  // armed behind it would hold this process open after the test returned.
  const files = createHostFiles({
    call: async () => new Promise((resolve) => {
      setTimeout(() => resolve({ dataBase64: encodeBase64(bytes(1, 2)) }), 15);
    }),
    timeoutMs: 400,
  });
  assert.deepEqual(await files.readBytes('/ok'), bytes(1, 2));
  assert.equal(files.stats().timeouts, 0);
});

test('the timeout message survives a transport that rejects on abort', async () => {
  // Every other fake in this file ignores the signal, and that is exactly the
  // condition under which rejecting after aborting looks fine. The real client
  // rejects its own promise the moment the signal fires, so it will win the
  // race against a deadline that aborts first -- and the caller gets
  // `AbortError: This operation was aborted`, which names neither the method
  // nor the machine nor the fact that it was a timeout. This is the one
  // transport shape that tells the two orderings apart.
  const files = createHostFiles({
    timeoutMs: 5,
    call: (_method, _params, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')));
    }),
  });

  await assert.rejects(
    () => files.readBytes('/w/a.txt'),
    /fs\/readFile on the resident machine did not answer within 5ms/,
  );
  assert.equal(files.stats().timeouts, 1);
});

// ---- the event channel -----------------------------------------------------

test('a failure is reported to the layer above with the method that failed', async () => {
  // `host-boot.mjs` prefixes these into `files:fs-error` and keeps them in the
  // degradation record, which on a phone is the only place a reader can see
  // that the relay and not the file was the problem.
  const events = [];
  const files = createHostFiles({ call: fakeAdapter({}), onEvent: (event) => events.push(event) });
  await assert.rejects(() => files.readBytes('/gone'));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'fs-error');
  assert.equal(events[0].method, 'fs/readFile');
  assert.match(events[0].reason, /ENOENT/, 'the adapter said why, so this says why');
});

test('a consumer that throws does not take the file read with it', async () => {
  // The same rule the other layers in this directory keep: a diagnostic is
  // never allowed to be the reason a real call failed.
  const files = createHostFiles({
    call: fakeAdapter({ '/a': bytes(7) }),
    onEvent: () => { throw new Error('a broken consumer'); },
  });
  assert.deepEqual(await files.readBytes('/a'), bytes(7));
});
