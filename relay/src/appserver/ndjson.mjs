// Newline-delimited JSON, incrementally.
//
// The app-server speaks JSON-RPC over a byte stream -- a child process's stdio,
// a unix socket, a TCP socket -- and byte streams do not respect message
// boundaries. One `data` event can carry half a message, three messages, or
// three and a half; a multi-byte UTF-8 character can be split across two chunks.
// So the only correct place to reassemble lines is a decoder that owns a partial
// line between pushes, which is this.
//
// Two deliberate choices:
//
//   1. A bad line is reported, not thrown. This decoder runs inside a socket's
//      `data` handler, where a throw becomes an uncaught exception that kills the
//      process over one corrupt message. The stream survives; the line does not.
//   2. A handler that throws is reported the same way, for the same reason. The
//      decoder's contract is "the stream keeps moving", and it cannot honour that
//      if a consumer bug can abort the loop halfway through a chunk.
//
// `\r\n` is tolerated because a peer that writes through a Windows-ish stream
// wrapper will produce it, and blank lines are skipped because some peers pad
// with them as a keepalive.

export class NdjsonError extends Error {
  constructor(message, { line = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'NdjsonError';
    /** The offending line, in full, for the consumer to log as it sees fit. */
    this.line = line;
  }
}

/** Enough of a bad line to recognise it in a log, without pasting a whole frame. */
function preview(line, limit = 120) {
  return line.length > limit ? `${line.slice(0, limit)}...` : line;
}

export class NdjsonDecoder {
  #partial = '';
  #text = new TextDecoder('utf-8');
  #onMessage;
  #onError;

  /**
   * @param {object} hooks
   * @param {(value: unknown) => void} hooks.onMessage Called once per parsed line.
   * @param {(error: NdjsonError) => void} [hooks.onError] Called for a line that
   *   would not parse, or for an `onMessage` that threw.
   */
  constructor({ onMessage, onError } = {}) {
    if (typeof onMessage !== 'function') {
      throw new TypeError('an NdjsonDecoder needs an onMessage callback');
    }
    this.#onMessage = onMessage;
    this.#onError = typeof onError === 'function' ? onError : null;
  }

  /** Feed a chunk: a string, a Uint8Array, a Node Buffer, or an ArrayBuffer. */
  push(chunk) {
    const text = this.#partial + this.#decode(chunk);
    const lastBreak = text.lastIndexOf('\n');
    if (lastBreak === -1) {
      this.#partial = text;
      return;
    }
    // Leave the buffer in a consistent state *before* dispatching, so a handler
    // that pushes re-entrantly (or closes the transport) cannot corrupt it.
    this.#partial = text.slice(lastBreak + 1);
    for (const line of text.slice(0, lastBreak).split('\n')) this.#line(line);
  }

  /**
   * Deliver a final line that arrived without its newline. Streams routinely end
   * that way -- a child process that writes its last message and exits -- and
   * silently dropping it would lose the most interesting message of the session.
   */
  flush() {
    const line = this.#partial + this.#text.decode();
    this.#partial = '';
    if (line !== '') this.#line(line);
  }

  /** Forget any partial line. For reuse across reconnects. */
  reset() {
    this.#partial = '';
    this.#text.decode();
  }

  /** Bytes of an incomplete line currently buffered. Useful as a sanity check. */
  get buffered() {
    return this.#partial.length;
  }

  #decode(chunk) {
    if (typeof chunk === 'string') return chunk;
    // `stream: true` is the whole point: it holds back a trailing partial code
    // point instead of emitting U+FFFD for a character split across chunks.
    return this.#text.decode(chunk, { stream: true });
  }

  #line(raw) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') return;
    let value;
    try {
      value = JSON.parse(line);
    } catch (cause) {
      this.#report(new NdjsonError(`line is not valid JSON: ${preview(line)}`, { line, cause }));
      return;
    }
    try {
      this.#onMessage(value);
    } catch (cause) {
      this.#report(new NdjsonError(`the message handler threw: ${cause?.message ?? cause}`, { line, cause }));
    }
  }

  #report(error) {
    if (!this.#onError) return;
    // An onError that throws would defeat the entire point of having one.
    try {
      this.#onError(error);
    } catch {
      /* ignored on purpose */
    }
  }
}

/**
 * The trivial other half. JSON.stringify escapes newlines inside strings, so the
 * single appended `\n` is guaranteed to be the only one in the result -- which is
 * what makes newline framing safe for arbitrary payloads.
 */
export function encodeNdjson(value) {
  const text = JSON.stringify(value);
  if (text === undefined) throw new NdjsonError('value is not JSON-serialisable');
  return `${text}\n`;
}
