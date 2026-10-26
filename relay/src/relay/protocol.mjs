// The relay wire protocol: paths, headers, frame kinds, and the exact words a
// refusal is spelled with.
//
// This file exists because the protocol is not ours to design. A relay built
// from sources this repo does not have is already carrying four live workers,
// and what follows is an independent implementation of the *same* wire
// contract, so that their ends can register with our relay and their client can
// attach to it. Convergence, not code sharing.
//
// That makes every string here load-bearing in a way an ordinary constant is
// not. `dial-back` spelled `dial_back`, or `?as=` renamed to `?client=`,
// produces a relay that passes its own tests and cannot carry one byte for
// anybody else. Nothing re-spells them; everything imports them from here.
//
// The pairing travels in a *header* and never in a path. That is the protocol's
// decision and worth restating wherever it is touched: paths end up in access
// logs, proxy traces and error messages, and a one-time credential that buys a
// joined socket must not be in any of them. The same rule is why no logging
// call in this directory takes a pairing.

/** Presented on every HTTP request and every websocket upgrade. */
export const RELAY_TOKEN_HEADER = 'x-relay-token';
/** Presented by an end dialling back, and nowhere else. Never in a path. */
export const RELAY_PAIRING_HEADER = 'x-relay-pairing';

/** `GET` -> the registered ends, sorted by name. */
export const ENDS_PATH = '/ends';
/** The end's registration socket. Its lifetime *is* the registration. */
export const CONTROL_PATH = '/control';
/** Where an end dials back to, carrying RELAY_PAIRING_HEADER. */
export const PAIR_PATH = '/pair';
/** `/attach/<urlencoded end id>?as=<client end>` -- a client asking for an end. */
export const ATTACH_PREFIX = '/attach/';
/** The query parameter naming the attaching client. */
export const ATTACH_AS_PARAM = 'as';

// Frame kinds. The relay reads exactly two of these from an end and sends
// exactly two; everything else on the control channel is ignored.
export const FRAME_ANNOUNCE = 'announce';
export const FRAME_ANNOUNCED = 'announced';
export const FRAME_HEARTBEAT = 'heartbeat';
export const FRAME_DIAL_BACK = 'dial-back';

/** The two HTTP bodies the relay ever produces. */
export const HTTP_TOKEN_REJECTED = { error: 'relay token rejected' };
export const HTTP_NO_SUCH_PATH = { error: 'no such relay path' };

/**
 * What a rejected *upgrade* gets: a bare status line and then the socket goes
 * away. Deliberately not a full HTTP response -- the peer asked for a protocol
 * switch, so there is no body it would read.
 */
export const UPGRADE_UNAUTHORIZED = 'HTTP/1.1 401 Unauthorized\r\n\r\n';

/**
 * Every close reason the relay produces, in one place. These are contract
 * text: an end or a client may well be matching on them, so they are built
 * here rather than interpolated at each call site where a word could drift.
 * (The tests assert the literal strings instead of calling these, on purpose --
 * a test that imports the spelling it is checking checks nothing.)
 */
export const REFUSE = Object.freeze({
  announceWithoutEnd: () => 'announce without an end name',
  endTaken: (end) => `end ${end} is already announced from another connection`,
  attachWithoutClientEnd: () => 'attach without a client end name (?as=)',
  noSuchEnd: (endId) => `no end named ${endId} is here`,
  clientAlreadyAttached: (clientEnd, endId) => `client end ${clientEnd} is already attached to ${endId}`,
  unknownPairing: () => 'unknown or already-used pairing',
  clientGone: () => 'the client that asked for this pairing is gone',
  noDialBack: (endId) => `end ${endId} did not dial back`,
});

/** The attach target for an end id and a client identity. */
export function attachPath(endId, clientEnd) {
  return `${ATTACH_PREFIX}${encodeURIComponent(endId)}?${ATTACH_AS_PARAM}=${encodeURIComponent(clientEnd)}`;
}

// A request-target is a path, not a URL, so parsing needs a base. This one is
// never dialled and never appears anywhere; it exists so `new URL` will accept
// the path.
const PARSE_BASE = 'http://relay.invalid';

/**
 * Route a request target. One parser for both the HTTP and the upgrade side, so
 * the two cannot disagree about what `/attach/x` means.
 * @returns {{ route: 'ends'|'control'|'pair'|'attach'|null, endId?: string, clientEnd?: string }}
 */
export function parseRelayPath(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl ?? '/'), PARSE_BASE);
  } catch {
    return { route: null };
  }
  const { pathname } = url;
  if (pathname === ENDS_PATH) return { route: 'ends' };
  if (pathname === CONTROL_PATH) return { route: 'control' };
  if (pathname === PAIR_PATH) return { route: 'pair' };
  if (pathname.startsWith(ATTACH_PREFIX)) {
    const raw = pathname.slice(ATTACH_PREFIX.length);
    let endId;
    try {
      endId = decodeURIComponent(raw);
    } catch {
      // `%zz` is not an end name, but it must not throw out of routing either:
      // the undecodable text matches no registration and earns a clean refusal.
      endId = raw;
    }
    const as = url.searchParams.get(ATTACH_AS_PARAM);
    return { route: 'attach', endId, clientEnd: typeof as === 'string' ? as.trim() : '' };
  }
  return { route: null };
}

const nullableString = (value) => (typeof value === 'string' && value !== '' ? value : null);

/**
 * Normalise an announce frame into the published record shape.
 *
 * Every field is present and of the declared type even when the end left it
 * out, because the record shape is part of the contract: whoever reads `/ends`
 * should never have to branch on a missing key. The nullable fields collapse
 * an empty string to null for the same reason -- `""` and absent mean the same
 * thing to an end reporting its cwd, and a reader should not have to know that.
 */
export function recordFromAnnounce(frame, { announcedAt, lastSeenAt }) {
  const pid = Number(frame.pid);
  return {
    end: String(frame.end),
    connection: typeof frame.connection === 'string' ? frame.connection : '',
    pid: Number.isFinite(pid) ? pid : 0,
    host: nullableString(frame.host),
    cwd: nullableString(frame.cwd),
    runtime: nullableString(frame.runtime),
    listen: nullableString(frame.listen),
    busy: frame.busy === true,
    announcedAt,
    lastSeenAt,
  };
}

/**
 * Parse a control frame. Anything that is not a JSON object -- including every
 * binary frame, which the caller rejects before getting here -- is nothing at
 * all, not an error: an end from a newer build may say things this relay has
 * never heard of, and silence is the only forward-compatible answer.
 */
export function parseControlFrame(data) {
  if (typeof data !== 'string') return null;
  try {
    const frame = JSON.parse(data);
    return frame !== null && typeof frame === 'object' && !Array.isArray(frame) ? frame : null;
  } catch {
    return null;
  }
}
