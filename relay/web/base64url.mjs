// base64url <-> bytes, for the browser.
//
// This exists as its own module, with no DOM and no Node builtins, for two
// reasons. First, it is the single place WebAuthn clients get wrong: the server
// speaks base64url strings over JSON, but `navigator.credentials` will only
// accept real BufferSources, so every challenge and credential id crosses this
// boundary twice per ceremony and one sloppy conversion produces a signature
// that verifies against nothing. Second, being free of both `atob` and `Buffer`
// means the exact same code runs under `node --test`, so the tests exercise the
// implementation the phone actually loads rather than a Node-flavoured cousin.
//
// The wire form matches src/auth/bytes.mjs: the base64url alphabet, no padding.
// We are deliberately lenient about *receiving* padding (some encoders add it)
// and deliberately strict about the alphabet -- a `+` or `/` means somebody
// handed us standard base64, which is a bug worth a loud error rather than a
// silently mangled challenge.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i += 1) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

export class Base64UrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Base64UrlError';
  }
}

/** Normalise anything byte-shaped to a Uint8Array view without copying. */
export function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('expected an ArrayBuffer or a typed array');
}

export function base64urlEncode(input) {
  const bytes = asBytes(input);
  let out = '';
  let i = 0;

  // Whole 3-byte groups become 4 characters with no padding question to answer.
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[(n >>> 18) & 63] + ALPHABET[(n >>> 12) & 63] + ALPHABET[(n >>> 6) & 63] + ALPHABET[n & 63];
  }

  // The tail is where padding would go; base64url as WebAuthn uses it has none,
  // so a 1-byte tail is 2 characters and a 2-byte tail is 3.
  const left = bytes.length - i;
  if (left === 1) {
    const n = bytes[i] << 16;
    out += ALPHABET[(n >>> 18) & 63] + ALPHABET[(n >>> 12) & 63];
  } else if (left === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += ALPHABET[(n >>> 18) & 63] + ALPHABET[(n >>> 12) & 63] + ALPHABET[(n >>> 6) & 63];
  }
  return out;
}

export function base64urlDecode(str) {
  if (typeof str !== 'string') throw new TypeError('base64url input must be a string');

  // Tolerate padding on the way in, then forget it ever existed.
  let end = str.length;
  while (end > 0 && str.charCodeAt(end - 1) === 0x3d) end -= 1;
  const body = end === str.length ? str : str.slice(0, end);

  // A 4-character group carries 3 bytes, so a remainder of exactly one
  // character cannot have come from any byte sequence at all.
  if (body.length % 4 === 1) {
    throw new Base64UrlError(`base64url string has an impossible length (${body.length} chars)`);
  }

  const outLength = Math.floor((body.length * 3) / 4);
  const out = new Uint8Array(outLength);

  let acc = 0;
  let bits = 0;
  let written = 0;
  for (let i = 0; i < body.length; i += 1) {
    const code = body.charCodeAt(i);
    const value = code < 128 ? LOOKUP[code] : -1;
    if (value < 0) {
      // Name the standard-base64 confusion explicitly; it is the likely cause.
      const hint = code === 0x2b || code === 0x2f
        ? ' (that is standard base64, not base64url -- use - and _)'
        : '';
      throw new Base64UrlError(`invalid base64url character ${JSON.stringify(body[i])} at index ${i}${hint}`);
    }
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written] = (acc >>> bits) & 0xff;
      written += 1;
    }
  }
  return out;
}

/**
 * The form `navigator.credentials` insists on. A Uint8Array is technically a
 * valid BufferSource, but handing WebAuthn a view over a larger buffer is a
 * classic way to sign the wrong bytes, so we always hand over a buffer whose
 * length is exactly the payload.
 */
export function base64urlToArrayBuffer(str) {
  const bytes = base64urlDecode(str);
  // `.buffer` is only safe to expose directly when the view spans all of it.
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
  return bytes.slice().buffer;
}
