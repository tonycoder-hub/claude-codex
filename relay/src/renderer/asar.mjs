// Reading the shipped renderer out of app.asar, without unpacking it.
//
// The renderer we want to serve is 19,845 files and the only copy on the
// machine is inside a 546 MB archive. Unpacking it to a directory would double
// the disk, go stale the moment the App updates, and create a second place
// where the bytes can disagree with the App's. So this reads the archive.
//
// THE FORMAT, read off the shipped archive rather than copied from a spec:
//
//   [0,4)    uint32   4            the pickle holding the next number
//   [4,8)    uint32   pickleSize
//   [8,12)   uint32   payloadSize
//   [12,16)  uint32   jsonLength
//   [16, 16+jsonLength)            the header, JSON
//   data begins at 8 + pickleSize, and every entry's `offset` is relative to it
//
// Note which of those four numbers matter: the second (where the data starts)
// and the fourth (how much JSON to read). The first and third are read only to
// be checked, because a file that is not an asar will usually still parse as
// four integers, and the failure then surfaces as a JSON syntax error pointing
// at a megabyte of binary.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
//   - It does not verify `integrity`. Every entry carries a SHA-256 and a
//     block list. Checking them means hashing 10 MB to answer a request for the
//     main chunk, in order to defend against someone who -- by hypothesis --
//     can already write inside /Applications. That is a cost with no threat
//     behind it.
//   - It refuses `unpacked` and `link` entries instead of following them. The
//     shipped archive has zero of either today; all 19,845 entries carry
//     exactly `size`, `offset` and `integrity`. If an update introduces one, a
//     refusal is a 404 with a line in the log, and the alternative -- a
//     resolver written against no example -- is a silently wrong byte stream.
//
// Nothing here executes anything out of the archive. It is read(2) at an
// offset, and the file descriptor is opened read-only.

import { read, openSync, readSync, closeSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';

const HEADER_PREAMBLE = 16;

// A header larger than this is not an asar we are willing to parse. The shipped
// one is a few megabytes; the bound exists so a corrupt length field asks for a
// sane allocation and gets an error, rather than asking for 4 GB and getting a
// process death that reads like something else.
const MAX_HEADER_BYTES = 64 * 1024 * 1024;

export class ArchiveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArchiveError';
  }
}

/**
 * A read-only view of an asar archive.
 *
 * The header is parsed once, at open, and held in memory; the file descriptor
 * stays open for the life of the archive because the alternative is a reopen on
 * every asset request, and a page load here is several hundred of them.
 */
export class Archive {
  #fd;
  #dataOffset;
  #root;
  #mtimeMs;
  #closed = false;
  #streams = 0;

  /** @param {string} file path to the .asar */
  constructor(file) {
    this.path = file;
    // Stat before open so a directory or a missing file fails with a message
    // naming the path, rather than with an EISDIR from a later read.
    const info = statSync(file);
    if (!info.isFile()) throw new ArchiveError(`${file} is not a file`);
    this.#mtimeMs = info.mtimeMs;

    this.#fd = openSync(file, 'r');
    try {
      const preamble = Buffer.alloc(HEADER_PREAMBLE);
      if (readSync(this.#fd, preamble, 0, HEADER_PREAMBLE, 0) !== HEADER_PREAMBLE) {
        throw new ArchiveError(`${file} is too short to be an asar`);
      }
      // The two checked numbers. Their only job is to make "this is not an
      // asar" fail here instead of inside JSON.parse.
      if (preamble.readUInt32LE(0) !== 4) throw new ArchiveError(`${file} is not an asar (bad pickle header)`);
      const pickleSize = preamble.readUInt32LE(4);
      const jsonLength = preamble.readUInt32LE(12);
      if (jsonLength === 0 || jsonLength > MAX_HEADER_BYTES) {
        throw new ArchiveError(`${file} declares an implausible header length (${jsonLength})`);
      }
      if (pickleSize < jsonLength) {
        throw new ArchiveError(`${file} declares a header pickle smaller than its header`);
      }

      const json = Buffer.alloc(jsonLength);
      if (readSync(this.#fd, json, 0, jsonLength, HEADER_PREAMBLE) !== jsonLength) {
        throw new ArchiveError(`${file} ends inside its header`);
      }
      let header;
      try {
        header = JSON.parse(json.toString('utf8'));
      } catch (err) {
        throw new ArchiveError(`${file} has an unreadable header: ${err.message}`);
      }
      if (!header || typeof header !== 'object' || typeof header.files !== 'object') {
        throw new ArchiveError(`${file} has a header with no file tree`);
      }
      this.#root = header;
      this.#dataOffset = 8 + pickleSize;
    } catch (err) {
      closeSync(this.#fd);
      this.#closed = true;
      throw err;
    }
  }

  /** The archive's own mtime. The renderer's bytes change when this does. */
  get mtimeMs() {
    return this.#mtimeMs;
  }

  /**
   * Resolve a path inside the archive.
   *
   * Traversal is structural rather than textual: the walk descends one key at a
   * time through the header's object tree, so `..` is not a parent reference,
   * it is a key that does not exist. There is no containment check to get wrong
   * because there is no filesystem underneath to escape to.
   *
   * @param {string} relPath e.g. `webview/index.html`, leading slash optional
   * @returns {{ size: number, offset: number } | null} null for a miss, a
   *   directory, or an entry shape we refuse to serve
   */
  stat(relPath) {
    this.#assertOpen();
    let node = this.#root;
    for (const segment of String(relPath).split('/')) {
      if (segment === '' || segment === '.') continue;
      const children = node.files;
      // `Object.hasOwn`, not `children[segment]`: a request for
      // `/webview/constructor` would otherwise walk into Object.prototype and
      // come back with a function, which then fails much further down.
      if (!children || !Object.hasOwn(children, segment)) return null;
      node = children[segment];
    }
    if (!node || typeof node !== 'object') return null;
    if (node.files) return null;                       // a directory
    if (node.link !== undefined || node.unpacked) return null;  // see the header
    if (typeof node.size !== 'number' || node.size < 0) return null;
    const offset = Number(node.offset);
    if (!Number.isSafeInteger(offset) || offset < 0) return null;
    return { size: node.size, offset };
  }

  /**
   * A stream over one entry's bytes.
   *
   * WHY THIS IS NOT fs.createReadStream
   *
   * It was, with `{ fd, start, end, autoClose: false }`, and that is wrong in a
   * way no test that merely drains a stream can see: `autoClose: false` stops
   * the stream from destroying itself at EOF, but an explicit `destroy()` --
   * which the server calls when a response finishes -- still closes the
   * descriptor. The archive's fd would die with the first asset served and
   * every later request would fail EBADF, somewhere else entirely.
   *
   * So the read loop is here instead, and it only ever reads: nothing in this
   * stream's lifecycle can touch the descriptor's lifetime.
   *
   * WHY THE DESCRIPTOR IS SHARED AT ALL
   *
   * Reopening the archive per request would be simpler, and the directory mount
   * already pays that cost per file. But the App replaces app.asar when it
   * updates, and a reopen by path mid-page-load would start reading a *new*
   * archive at offsets taken from the old one's header -- a corrupt asset, under
   * an ETag that says it is the old one. An open descriptor keeps pointing at
   * the inode we parsed, so a page load is served one consistent renderer.
   *
   * Concurrency over that one descriptor is safe because every read passes an
   * explicit position, which is pread(2): it does not move the descriptor's own
   * offset. A page load here runs several hundred of these at once.
   *
   * @param {{ size: number, offset: number }} entry from {@link stat}
   */
  createReadStream(entry) {
    this.#assertOpen();
    // An empty entry is a legitimate asset; `Readable.from([])` holds no
    // reference to the descriptor, so it needs no release either.
    if (entry.size === 0) return Readable.from([]);

    const fd = this.#fd;
    let position = this.#dataOffset + entry.offset;
    let remaining = entry.size;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#release();
    };
    this.#streams += 1;

    return new Readable({
      highWaterMark: 64 * 1024,
      read(wanted) {
        if (remaining === 0) {
          this.push(null);
          return;
        }
        // Bounded by the entry's own size, never by the archive's EOF: a wrong
        // size in the header truncates this response instead of appending
        // whatever follows the entry, which is the next file.
        const length = Math.min(wanted || 64 * 1024, remaining);
        const buf = Buffer.allocUnsafe(length);
        read(fd, buf, 0, length, position, (err, got) => {
          if (err) {
            this.destroy(err);
            return;
          }
          if (got === 0) {
            this.destroy(new ArchiveError('the archive ends inside an entry'));
            return;
          }
          position += got;
          remaining -= got;
          this.push(got === length ? buf : buf.subarray(0, got));
        });
      },
      destroy(err, cb) {
        // Runs exactly once, for an ordinary end as well as for a client that
        // vanished mid-asset, because autoDestroy defaults on.
        release();
        cb(err);
      },
    });
  }

  /** Read one entry whole. For small files only -- the header, a manifest. */
  read(entry) {
    this.#assertOpen();
    const buf = Buffer.alloc(entry.size);
    if (entry.size === 0) return buf;
    const got = readSync(this.#fd, buf, 0, entry.size, this.#dataOffset + entry.offset);
    if (got !== entry.size) throw new ArchiveError('the archive ends inside an entry');
    return buf;
  }

  /**
   * Stop serving, and close the descriptor once nothing is reading it.
   *
   * The deferral is not politeness towards in-flight responses -- they would
   * survive an early close on most systems. It is because a closed fd number is
   * immediately reusable, and this process opens files constantly (every file
   * the directory mount serves). An in-flight read against a recycled number
   * would quietly return somebody else's bytes, at our offsets, to a phone. So
   * the descriptor stays valid for exactly as long as a stream can read it;
   * `stat` starts refusing immediately, which is what stops new ones.
   */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#streams === 0) closeSync(this.#fd);
  }

  #release() {
    this.#streams -= 1;
    if (this.#closed && this.#streams === 0) closeSync(this.#fd);
  }

  #assertOpen() {
    if (this.#closed) throw new ArchiveError('the archive is closed');
  }
}

/** @param {string} file */
export function openArchive(file) {
  return new Archive(file);
}
