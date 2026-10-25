// The resident machine's filesystem, as far as a browser page can reach it.
//
// Every other module in web/ answers the renderer out of its own head: a
// shaped empty, a stored atom, a legible refusal. This one is different. It is
// the first layer that reaches past the page and returns something the page
// could not have known, which is why it exists as its own file rather than as
// three helpers inside host-namespaces.mjs -- the contracts it serves live with
// their own comment blocks in the modules that own them, and what belongs here
// is the one thing they share: the adapter's `fs/*` methods, and the exact
// distance between those methods and the ones the Electron host has.
//
// WHAT THE ADAPTER ACTUALLY SERVES
//
// Three methods, measured from the adapter rather than assumed (its
// `src/server.mjs`, the `fs/*` arms of its dispatch switch):
//
//   fs/readFile      {path}  -> {dataBase64}
//                    `(await readFile(path)).toString('base64')`. The WHOLE
//                    file. There is no offset, no length, no byte limit.
//   fs/getMetadata   {path}  -> {isDirectory, isFile, isSymlink,
//                               createdAtMs, modifiedAtMs}
//                    `birthtimeMs` and `mtimeMs` off a `stat`. Note what is
//                    absent: there is no `size`.
//   fs/readDirectory {path}  -> {entries: [{fileName, isDirectory, isFile}]}
//                    `readdir(path, {withFileTypes: true})`.
//
// THE THREE PLACES THIS IS WEAKER THAN THE APP'S OWN HOST
//
// Each is a consequence of that surface, not an oversight, and each is here
// rather than in a commit message because the next person to read a 2 GB
// transfer in a log should find the reason in the file that caused it.
//
//   1. `maxBytes` is enforced AFTER the bytes have crossed the relay. The
//      App's host stats first and throws without reading at all, then reads
//      `maxBytes + 1` bytes and throws again if it got them all
//      (`readFileSampleBytes(path, maxBytes + 1)`). Neither move is available
//      here: `fs/readFile` has no byte limit and `fs/getMetadata` has no
//      `size`, so there is nothing to compare a limit against until the file
//      is already in hand. The OBSERVABLE contract is identical -- same
//      rejection, same message, nothing truncated is ever passed off as whole
//      -- and only the cost differs. A caller asking for 64 KB of a huge file
//      gets the right answer and pays for the whole file to arrive first.
//   2. The etag's size component comes from the bytes actually read, because
//      `fs/getMetadata` has no `size` to take it from. If anything this is the
//      more accurate of the two: it is the length of what the caller is
//      holding, not the length the directory entry claimed.
//   3. `createdAtMs` is `birthtimeMs`, while the App's etag uses `ctimeMs`.
//      Those are different clocks -- creation time versus inode-change time --
//      so a metadata-only change such as a `chmod` moves the App's etag and
//      does not move ours. For an etag whose job is "did the CONTENT change",
//      not noticing a `chmod` is the harmless direction.
//
// WHY THE ETAG FORMAT IS COPIED EXACTLY ANYWAY
//
// `missing` or `stat:<base64url sha256>`, which is the App's own spelling
// (`e == null ? 'missing' : 'stat:' + sha256(`${mtimeMs}:${ctimeMs}:${size}`)
// .digest('base64url')`). The inputs differ, per 2 and 3 above, so the DIGEST
// of a given file is not the one the App would mint -- and that is fine,
// because an etag is an opaque cache key that is only ever compared against
// another etag from the same host. What is not fine is changing its SHAPE:
// anything in the renderer that pattern-matches `missing` or splits on the
// `stat:` prefix keeps working only if the prefix is still there.
//
// The digest runs through `crypto.subtle`, which needs a secure context --
// already guaranteed, because the passkey ceremony that gets a phone into this
// app at all needs the same thing. The non-cryptographic fallback below is for
// a dev loopback over plain http, and it is not a weaker claim: the hash was
// never about secrecy, only about packing three numbers into one short string.
//
// WHY THERE IS A BASE64 DECODER HERE AND NOT A REUSED ONE
//
// web/base64url.mjs is deliberately STRICT about its alphabet: a `+` or a `/`
// arriving there means somebody handed it standard base64 where base64url was
// required, and its header says that is worth a loud error rather than a
// silently mangled WebAuthn challenge. The adapter speaks standard base64 with
// padding, so the two cannot share a decoder without taking away the thing
// that makes the strict one useful. Hand-rolled rather than `atob` for the
// reason that module gives: the code the phone loads is the code `node --test`
// runs, and `atob` hands back a latin1 string that has to be unpacked anyway.

const STANDARD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const DECODE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < STANDARD.length; i += 1) table[STANDARD.charCodeAt(i)] = i;
  return table;
})();

const URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * How many bytes of a file decide whether it is text.
 *
 * The App's sniffer is handed `bytes.subarray(0, 4096)` by its caller, so this
 * is the caller's number rather than the sniffer's, and it is replicated here
 * so that a file which is text for the first 4 KB and binary afterwards gets
 * the same verdict in both hosts.
 */
export const SNIFF_BYTES = 4096;

/**
 * How long a single `fs/*` call may take before it becomes a rejection.
 *
 * There is no deadline anywhere else on this client, and that is deliberate
 * for the traffic it was built for: web/hostlink/link.mjs explains that the
 * RENDERER computes its own per-request deadline, so a second one here could
 * only ever settle a request the renderer still believes is in flight. A call
 * this host makes on its own behalf has no such owner. Nothing would settle
 * it, and an unsettled file read is a spinner that never stops on a screen
 * with no console to look at -- the exact failure this directory keeps
 * trading for a legible message.
 *
 * Generous, because the bytes cross the phone's network link and not a local
 * pipe: this module runs in the browser, so a read is the resident machine's
 * disk plus a relay hop plus however much mobile signal there is. Sixty
 * seconds is long enough that a large attachment on a slow connection is not
 * cut off, and short enough that a wedged socket is reported while the user is
 * still looking at the screen that asked.
 */
export const FILE_CALL_TIMEOUT_MS = 60_000;

/**
 * The file and directory budget for a folder count.
 *
 * 1000, from the App's walker, where the same constant caps both the files
 * counted and the directories descended into.
 */
export const FOLDER_FILE_CAP = 1000;

export class HostFilesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HostFilesError';
  }
}

/** Standard base64, padded or not, to bytes. */
export function decodeBase64(input) {
  if (typeof input !== 'string') throw new HostFilesError('expected a base64 string');
  // Padding carries no information once the length is known, and whitespace is
  // what a base64 string picks up from being pretty-printed somewhere upstream.
  let clean = '';
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (c === '=' || c === '\n' || c === '\r' || c === ' ' || c === '\t') continue;
    clean += c;
  }
  if (clean.length % 4 === 1) throw new HostFilesError('base64 string has a 1-character tail, which encodes nothing');

  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const code = clean.charCodeAt(i);
    const value = code < 128 ? DECODE[code] : -1;
    if (value < 0) throw new HostFilesError('base64 string has a character outside the standard alphabet');
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o] = (acc >>> bits) & 0xff;
      o += 1;
    }
  }
  return out.subarray(0, o);
}

/** Bytes to standard base64, padded, which is what `fs/writeFile` wants. */
export function encodeBase64(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += STANDARD[(n >>> 18) & 63] + STANDARD[(n >>> 12) & 63] + STANDARD[(n >>> 6) & 63] + STANDARD[n & 63];
  }
  const left = bytes.length - i;
  if (left === 1) {
    const n = bytes[i] << 16;
    out += STANDARD[(n >>> 18) & 63] + STANDARD[(n >>> 12) & 63] + '==';
  } else if (left === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += STANDARD[(n >>> 18) & 63] + STANDARD[(n >>> 12) & 63] + STANDARD[(n >>> 6) & 63] + '=';
  }
  return out;
}

function base64url(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += URL_ALPHABET[(n >>> 18) & 63] + URL_ALPHABET[(n >>> 12) & 63]
      + URL_ALPHABET[(n >>> 6) & 63] + URL_ALPHABET[n & 63];
  }
  const left = bytes.length - i;
  if (left === 1) {
    const n = bytes[i] << 16;
    out += URL_ALPHABET[(n >>> 18) & 63] + URL_ALPHABET[(n >>> 12) & 63];
  } else if (left === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += URL_ALPHABET[(n >>> 18) & 63] + URL_ALPHABET[(n >>> 12) & 63] + URL_ALPHABET[(n >>> 6) & 63];
  }
  return out;
}

/**
 * Is this run of bytes text?
 *
 * The App asks two questions in order and this answers only the second one.
 * First it runs the bytes through the `file-type` package and, if a magic
 * number identifies them, takes the verdict from the mime type. Only when
 * nothing is recognised does it fall back to the scan below: text unless the
 * UTF-8 decode contains a control character under 32 that is not one of
 * 7..14 (bell, backspace, tab, newline, vertical tab, form feed, return).
 *
 * This implements the fallback arm alone, because the magic arm is a
 * dependency and this directory has none. The two arms disagree in exactly one
 * direction that matters: a file whose magic says text while its bytes contain
 * a NUL -- a UTF-16 `.reg` file is the real example, since `x-ms-regedit` is on
 * the App's hand-written list of text mime types. Such a file comes back here
 * as a blob. That is the conservative direction: the caller gets the exact
 * bytes instead of a string with a NUL every other character.
 *
 * Note what does NOT make a file binary: invalid UTF-8. The decoder is
 * non-fatal in both hosts, so a bad sequence becomes U+FFFD, which is well
 * above 32 and so reads as text -- deliberately matched, because a latin1 text
 * file is still a text file to the person who opened it.
 */
export function isTextBytes(bytes, window = SNIFF_BYTES) {
  if (bytes.byteLength === 0) return true;
  // The window is the caller's, because the App's two callers of this test
  // disagree about it. `workspaceFiles.read`'s auto arm passes
  // `bytes.subarray(0, 4096)` and so looks at a screenful of a large file;
  // `read-file-metadata` passes a sample the CALLER already bounded with
  // `contentSampleByteLimit` and looks at all of it. Defaulting to 4096 keeps
  // the first behaviour and lets the second ask for the whole sample, which
  // matters whenever that limit is larger than this one.
  const decoded = new TextDecoder('utf-8').decode(
    window === Infinity ? bytes : bytes.subarray(0, window),
  );
  for (let i = 0; i < decoded.length; i += 1) {
    const code = decoded.charCodeAt(i);
    if (code < 32 && (code < 7 || code > 14)) return false;
  }
  return true;
}

/**
 * The App's etag, over the inputs this host can get.
 *
 * `null` metadata is `missing`, which is the App's own word for it and a value
 * the renderer already handles -- see the header on why the digest differs from
 * the App's for the same file while the shape does not.
 */
/**
 * How far in to look for an SVG, which the App sniffs before anything else.
 */
export const SVG_SNIFF_BYTES = 512;

/**
 * The extensions the App calls an archive, verbatim from its own set.
 *
 * Extension and not mime, which looks like an oddity and is load-bearing: a
 * `.docx` is a zip and its mime says so, so classifying on mime would make
 * every Office document `binary` and leave `archive` reachable only by a bare
 * `.zip`.
 */
const ARCHIVE_EXTENSIONS = new Set([
  '7z', 'Z', 'apk', 'bz2', 'docm', 'docx', 'epub', 'gz', 'jar', 'odp', 'ods', 'odt',
  'potm', 'potx', 'ppsm', 'ppsx', 'pptm', 'pptx', 'rar', 'tar', 'tar.gz', 'xlsm',
  'xlsx', 'xpi', 'xz', 'zip', 'zst',
]);

/** Mime types the App calls text despite not being `text/*`. */
const TEXT_MIMES = new Set([
  'application/eps',
  'application/postscript',
  'application/rtf',
  'application/x-ms-regedit',
  'application/xml',
]);

/**
 * Magic-byte signatures, in the order they are tested.
 *
 * The App reaches this through the `file-type` package, which this page cannot
 * have: it is a dependency with its own dependencies, and this directory ships
 * as plain modules a browser loads directly. So the table is written out, and
 * the honest scope of it is worth stating -- `file-type` recognises several
 * hundred formats and this recognises about forty.
 *
 * What makes forty enough is WHERE the answer is used. Every one of the seven
 * `contentKind` values routes a file to a viewer, and an unrecognised file
 * does not fail: it falls through to the same text-or-binary test the App
 * falls through to, and lands on `binary`, which is the kind that means
 * "download it". So a format missing from this table is previewed as a
 * download rather than inline -- a visibly poorer answer, never a wrong one.
 * The formats that are here are the ones where that difference is a photo or a
 * video somebody expected to see.
 *
 * `offset` is where the magic sits; `bytes` is a byte array, or a string for
 * ASCII magic. A `brand` entry matches an ISO-BMFF `ftyp` box, which is how a
 * `.mp4`, a `.mov`, an `.m4a`, a `.heic` and an `.avif` are told apart -- they
 * share a container and differ only in that four-character code.
 */
const SIGNATURES = [
  { magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: 'image/png', ext: 'png' },
  { magic: [0xff, 0xd8, 0xff], mime: 'image/jpeg', ext: 'jpg' },
  { magic: 'GIF8', mime: 'image/gif', ext: 'gif' },
  { magic: [0x42, 0x4d], mime: 'image/bmp', ext: 'bmp' },
  { magic: [0x00, 0x00, 0x01, 0x00], mime: 'image/x-icon', ext: 'ico' },
  { magic: [0x49, 0x49, 0x2a, 0x00], mime: 'image/tiff', ext: 'tif' },
  { magic: [0x4d, 0x4d, 0x00, 0x2a], mime: 'image/tiff', ext: 'tif' },
  { magic: '%PDF', mime: 'application/pdf', ext: 'pdf' },
  { magic: 'ID3', mime: 'audio/mpeg', ext: 'mp3' },
  { magic: [0xff, 0xfb], mime: 'audio/mpeg', ext: 'mp3' },
  { magic: [0xff, 0xf3], mime: 'audio/mpeg', ext: 'mp3' },
  { magic: [0xff, 0xf2], mime: 'audio/mpeg', ext: 'mp3' },
  { magic: 'fLaC', mime: 'audio/x-flac', ext: 'flac' },
  { magic: 'OggS', mime: 'audio/ogg', ext: 'ogg' },
  { magic: [0x1a, 0x45, 0xdf, 0xa3], mime: 'video/webm', ext: 'webm' },
  { magic: 'PK\u0003\u0004', mime: 'application/zip', ext: 'zip' },
  { magic: 'PK\u0005\u0006', mime: 'application/zip', ext: 'zip' },
  { magic: 'PK\u0007\u0008', mime: 'application/zip', ext: 'zip' },
  { magic: [0x1f, 0x8b], mime: 'application/gzip', ext: 'gz' },
  { magic: 'BZh', mime: 'application/x-bzip2', ext: 'bz2' },
  { magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], mime: 'application/x-7z-compressed', ext: '7z' },
  { magic: 'Rar!\u001a\u0007', mime: 'application/x-rar-compressed', ext: 'rar' },
  { magic: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], mime: 'application/x-xz', ext: 'xz' },
  { magic: [0x28, 0xb5, 0x2f, 0xfd], mime: 'application/zstd', ext: 'zst' },
  { magic: 'ustar', offset: 257, mime: 'application/x-tar', ext: 'tar' },
];

/** `ftyp` brands, which decide a kind inside one shared container. */
const BRANDS = new Map([
  ['heic', { mime: 'image/heic', ext: 'heic' }],
  ['heix', { mime: 'image/heic', ext: 'heic' }],
  ['hevc', { mime: 'image/heic-sequence', ext: 'heic' }],
  ['mif1', { mime: 'image/heif', ext: 'heif' }],
  ['avif', { mime: 'image/avif', ext: 'avif' }],
  ['avis', { mime: 'image/avif', ext: 'avif' }],
  ['M4A ', { mime: 'audio/mp4', ext: 'm4a' }],
  ['M4B ', { mime: 'audio/mp4', ext: 'm4b' }],
  ['qt  ', { mime: 'video/quicktime', ext: 'mov' }],
  ['M4V ', { mime: 'video/x-m4v', ext: 'm4v' }],
]);

function startsWith(bytes, magic, offset = 0) {
  const pattern = typeof magic === 'string'
    ? Array.from(magic, (character) => character.charCodeAt(0))
    : magic;
  if (bytes.byteLength < offset + pattern.length) return false;
  for (let i = 0; i < pattern.length; i += 1) {
    if (bytes[offset + i] !== pattern[i]) return false;
  }
  return true;
}

const ascii = (bytes, offset, length) => {
  let out = '';
  for (let i = offset; i < offset + length && i < bytes.byteLength; i += 1) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
};

/**
 * `{ mime, ext }` for a recognised format, or null.
 *
 * RIFF and ISO-BMFF are handled ahead of the table because both are
 * containers: four different kinds share the leading bytes and only a later
 * field separates them, so a table entry on the prefix alone would claim a
 * `.webp` was a `.wav`.
 */
export function detectFileType(bytes) {
  if (bytes == null || bytes.byteLength === 0) return null;

  if (startsWith(bytes, 'RIFF')) {
    const form = ascii(bytes, 8, 4);
    if (form === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
    if (form === 'WAVE') return { mime: 'audio/vnd.wave', ext: 'wav' };
    if (form === 'AVI ') return { mime: 'video/vnd.avi', ext: 'avi' };
    return null;
  }

  if (startsWith(bytes, 'ftyp', 4)) {
    const brand = ascii(bytes, 8, 4);
    const known = BRANDS.get(brand);
    if (known != null) return known;
    // Everything else in this container is video, which is what the brands
    // `isom`, `iso2`, `mp41`, `mp42` and `mmp4` all are. Defaulting rather
    // than listing them keeps an unknown future brand playable instead of
    // turning it into a download.
    return { mime: 'video/mp4', ext: 'mp4' };
  }

  for (const signature of SIGNATURES) {
    if (startsWith(bytes, signature.magic, signature.offset ?? 0)) {
      return { mime: signature.mime, ext: signature.ext };
    }
  }
  return null;
}

/** An SVG is text, so it is sniffed as text -- within a bounded window. */
function isSvg(bytes) {
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, SVG_SNIFF_BYTES));
  return /<svg[\s>]/i.test(head);
}

/**
 * `{ kind, mimeType }` for bytes a format was recognised in, else null.
 *
 * The order is the App's and it is not arbitrary: SVG first, because an SVG is
 * an image whose magic bytes are markup and a generic sniffer would call it
 * text or XML.
 */
function classify(bytes) {
  if (bytes == null || bytes.byteLength === 0) return null;
  if (isSvg(bytes)) return { kind: 'image', mimeType: 'image/svg+xml' };

  const type = detectFileType(bytes);
  if (type == null) return null;
  const { mime, ext } = type;
  if (mime === 'application/pdf') return { kind: 'pdf', mimeType: mime };
  if (mime.startsWith('image/')) return { kind: 'image', mimeType: mime };
  if (mime.startsWith('audio/')) return { kind: 'audio', mimeType: mime };
  if (mime.startsWith('video/')) return { kind: 'video', mimeType: mime };
  if (mime.startsWith('text/') || TEXT_MIMES.has(mime)) return { kind: 'text', mimeType: mime };
  if (ARCHIVE_EXTENSIONS.has(ext)) return { kind: 'archive', mimeType: mime };
  return { kind: 'binary', mimeType: mime };
}

/**
 * One of the App's seven content kinds, or null for null bytes.
 *
 * Null means "nobody asked" -- the App's metadata endpoint passes null here
 * whenever the caller supplied no sample limit -- and it is the one case where
 * the field is left off the response entirely. Empty bytes are not that case:
 * they are `text`, because an empty file is a readable file.
 */
export function detectContentKind(bytes) {
  if (bytes == null) return null;
  const classified = classify(bytes);
  if (classified != null) return classified.kind;
  return isTextBytes(bytes, Infinity) ? 'text' : 'binary';
}

/** The mime type of a recognised format, or null -- including for plain text. */
export function detectMimeType(bytes) {
  return classify(bytes)?.mimeType ?? null;
}

export async function etagFor(metadata, size) {
  if (metadata == null) return 'missing';
  const material = `${metadata.modifiedAtMs}:${metadata.createdAtMs}:${size}`;
  const subtle = globalThis.crypto?.subtle;
  if (subtle == null) {
    // A dev loopback over plain http. Same job, same shape, no digest: the
    // three numbers are already a change detector, and hiding them behind a
    // hash was never what made the etag work.
    return `stat:plain-${metadata.modifiedAtMs}-${metadata.createdAtMs}-${size}`;
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(material));
  return `stat:${base64url(new Uint8Array(digest))}`;
}

/**
 * The separator for joining a child onto a directory path.
 *
 * The App asks its execution host (`await host.platformPath()`); the adapter
 * exposes no equivalent, so this reads the shape of the path it was given. A
 * drive letter or a UNC prefix means Windows and everything else means POSIX --
 * and the fallback is the safe one anyway, because Windows accepts `/` in the
 * APIs behind `fs/readDirectory`.
 */
function separatorFor(path) {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(path) ? '\\' : '/';
}

/**
 * The adapter-backed filesystem.
 *
 * `call` is the app-server client's `call(method, params)` -- injected rather
 * than imported so that the one socket the link owns stays the only one, and
 * so a test can drive this against a recorded adapter without a transport.
 */
export function createHostFiles({ call, onEvent = null, timeoutMs = FILE_CALL_TIMEOUT_MS } = {}) {
  if (typeof call !== 'function') {
    throw new TypeError('createHostFiles: call must be a function that reaches the app server');
  }

  const stats = {
    readFile: 0, getMetadata: 0, readDirectory: 0, bytes: 0, errors: 0, truncatedWalks: 0, timeouts: 0,
  };

  const report = (kind, detail) => {
    if (typeof onEvent !== 'function') return;
    try {
      onEvent({ kind, ...detail });
    } catch {
      // A reporting sink that throws must not take a file read with it. Same
      // rule as every other onEvent in web/.
    }
  };

  /**
   * One `fs/*` call, with a deadline it cannot outlive.
   *
   * The signal AND the race are both here, and neither is redundant. The
   * signal is what actually cancels: the client drops the call and stops
   * waiting for a reply that is no longer wanted. The race is what makes the
   * deadline a property of THIS module rather than a request of the
   * transport's -- an injected `call` that ignores its options, which is what
   * a test fake and an older client both are, would otherwise have no deadline
   * at all and the hang would be back.
   *
   * The timer is always cleared. A pending `setTimeout` holds the event loop
   * open, which under `node --test` turns a passing file into a hanging one.
   */
  const invoke = async (method, params) => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        stats.timeouts += 1;
        // Rejected BEFORE the abort, and the order is load-bearing: a real
        // transport rejects its own promise from the abort listener
        // (src/appserver/client.mjs:194), so aborting first hands the race an
        // `AbortError: This operation was aborted` and the caller never learns
        // which method timed out or that a deadline is what ended it. The
        // abort still happens, one line later, and still releases the socket;
        // its rejection is simply the loser of a race that has already
        // settled, which `Promise.race` counts as handled.
        reject(new HostFilesError(
          `${method} on the resident machine did not answer within ${timeoutMs}ms`,
        ));
        controller?.abort();
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        call(method, params, controller === null ? undefined : { signal: controller.signal }),
        deadline,
      ]);
    } catch (error) {
      stats.errors += 1;
      report('fs-error', { method, reason: error?.message ?? String(error) });
      throw error;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };

  /** The whole file, as bytes. */
  const readBytes = async (path) => {
    const result = await invoke('fs/readFile', { path });
    const data = result?.dataBase64;
    if (typeof data !== 'string') {
      // Worth its own error rather than a decode failure: an adapter that
      // answered without `dataBase64` is a version mismatch, and a message
      // naming the field is what makes that readable from a phone.
      stats.errors += 1;
      throw new HostFilesError('the adapter answered fs/readFile without dataBase64');
    }
    const bytes = decodeBase64(data);
    stats.readFile += 1;
    stats.bytes += bytes.byteLength;
    return bytes;
  };

  /**
   * `stat`, or null when the path is not there.
   *
   * Null rather than a throw because every caller here wants the same thing
   * from a missing path -- the App's own `stat` wrapper swallows ENOENT to null
   * for the same reason -- and because the one unavoidable use of this is
   * minting an etag, where "no stat" is a legal answer and a rejection is not.
   */
  const metadata = async (path, { throwIfMissing = false } = {}) => {
    try {
      const result = await invoke('fs/getMetadata', { path });
      stats.getMetadata += 1;
      return result ?? null;
    } catch (error) {
      // The option exists because one consumer needs the opposite of the
      // default, and needs it for a reason worth naming. `read-file-metadata`
      // is how the renderer asks whether a file EXISTS, and the consumer that
      // asks decides by matching the rejection's text for `ENOENT`, `No such
      // file or directory` or `(os error 2)`. A null here would answer "the
      // file is there and has no attributes", which that consumer reads as
      // neither existing nor missing.
      if (throwIfMissing) throw error;
      return null;
    }
  };

  const readDirectory = async (path) => {
    const result = await invoke('fs/readDirectory', { path });
    stats.readDirectory += 1;
    return Array.isArray(result?.entries) ? result.entries : [];
  };

  /**
   * How many files are under a folder, counting recursively.
   *
   * The App's walker, transcribed: files only, a budget of FOLDER_FILE_CAP
   * shared between the count and the directories descended into, and `null`
   * -- not a number -- when the directory budget runs out, so that a caller
   * cannot mistake a truncated walk for a small folder.
   *
   * It skips symlinks without spending a round trip on them, which the App
   * cannot do: it re-stats every subdirectory with `followSymlinks: false` to
   * check. That stat is redundant against `readdir(..., {withFileTypes: true})`,
   * because a symlink's dirent reports neither `isFile` nor `isDirectory` -- so
   * `if (!entry.isDirectory) continue` has already dropped it. The behaviours
   * agree, including on the detail that a symlink to a FILE is not counted by
   * either host.
   */
  const countFolderFiles = async (folderPath) => {
    const sep = separatorFor(folderPath);
    let directories = FOLDER_FILE_CAP;

    const walk = async (dir, remaining) => {
      const entries = await readDirectory(dir);
      let seen = 0;
      for (const entry of entries) {
        if (entry?.isFile === true) {
          seen += 1;
          if (seen === remaining) return seen;
          continue;
        }
        if (entry?.isDirectory !== true) continue;
        if (directories === 0) return null;
        directories -= 1;
        const child = dir.endsWith(sep) ? `${dir}${entry.fileName}` : `${dir}${sep}${entry.fileName}`;
        const sub = await walk(child, remaining - seen);
        if (sub == null) return null;
        seen += sub;
        if (seen === remaining) return seen;
      }
      return seen;
    };

    const counted = await walk(folderPath, FOLDER_FILE_CAP);
    if (counted == null) stats.truncatedWalks += 1;
    return counted;
  };

  return {
    readBytes,
    metadata,
    readDirectory,
    countFolderFiles,
    /** A copy, so a reader cannot edit the counters it is reading. */
    stats: () => ({ ...stats }),
  };
}
