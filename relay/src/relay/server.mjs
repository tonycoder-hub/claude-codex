// The relay: a rendezvous point for a *client* that wants to reach a *server*
// when neither of them can accept a connection.
//
// The shape is three sockets and one rule. An end holds a `/control` socket
// open and announces a name. A client asks for that name at `/attach/<end>`.
// The relay mints a one-time pairing, tells the end to dial back at `/pair`
// with it, and then joins the two sockets and stops understanding anything.
//
// That last part is the whole point. From the moment two sockets are joined
// this process never parses a byte it carries: text stays text, binary stays
// binary, nothing is reordered, re-encoded or "fixed". A relay that understood
// the payload would be a second implementation of somebody else's protocol,
// which is how fidelity gets lost -- and it is precisely the ignorance that
// lets a client and a server which have never heard of each other talk.
//
// Two decisions deserve their rationale written down, because both look like
// omissions until you have debugged the alternative:
//
//  1. A registration lives exactly as long as its control socket. Nothing
//     expires on a timer, and `lastSeenAt` is reporting, not policy. A sleeping
//     laptop must not look like a departed one -- a liveness timer turns a
//     closed lid into an unregistration and the end comes back to find its name
//     taken by nothing at all.
//
//  2. A client's frames are buffered until pairing completes, rather than
//     dropped. The client speaks first here: the App Server handshake is a
//     request, not a greeting, so the frames in flight while the end is still
//     dialling back are the `initialize` call. Dropping them does not lose a
//     round trip, it loses the session.
//
// Dependency-free by constraint: node:http, node:crypto, and this repo's own
// RFC 6455 endpoint. No `ws`, which is also what the other implementation of
// this protocol depends on and what ours deliberately does not.

import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { acceptUpgrade, refuseUpgrade, isSendableCloseCode, CLOSE } from '../surface/ws.mjs';
import {
  ATTACH_AS_PARAM,
  FRAME_ANNOUNCE,
  FRAME_ANNOUNCED,
  FRAME_DIAL_BACK,
  FRAME_HEARTBEAT,
  HTTP_NO_SUCH_PATH,
  HTTP_TOKEN_REJECTED,
  REFUSE,
  RELAY_PAIRING_HEADER,
  RELAY_TOKEN_HEADER,
  UPGRADE_UNAUTHORIZED,
  parseControlFrame,
  parseRelayPath,
  recordFromAnnounce,
} from './protocol.mjs';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Every relay-initiated close uses one code. The protocol pins the *reasons*
 * verbatim and says nothing about codes, so a single honest one beats a
 * taxonomy invented here: all of them are "the relay will not do this", which
 * is what 1008 means.
 */
const REFUSED = CLOSE.policyViolation;

/** Attachments are keyed by the pair, so the separator must not be a legal name char. */
const pairKey = (endId, clientEnd) => `${endId}\u0000${clientEnd}`;

/**
 * @param {object} options
 * @param {string|null} [options.token] the shared secret; null means no auth
 * @param {number} [options.pairingTimeoutMs] how long a client waits for a dial-back
 */
export function createRelayServer({
  token = null,
  host = '127.0.0.1',
  port = 0,
  pairingTimeoutMs = 10_000,
  logger = silentLogger,
  now = Date.now,
  shutdownGraceMs = 250,
  wsLimits = {},
} = {}) {
  /** end name -> { ws, record } */
  const ends = new Map();
  /** pairKey -> attachment */
  const attachments = new Map();
  /** pairing -> attachment, awaiting a dial-back. Strictly one-time. */
  const pending = new Map();
  /** Every live endpoint and its socket, for shutdown only. */
  const live = new Set();

  if (token === null) logger.warn('relay.unauthenticated', {});

  // Hash the configured token once. Comparing digests rather than the secrets
  // themselves is what makes the comparison timing-safe for *any* pair of
  // inputs: timingSafeEqual throws on a length mismatch, and "did it throw?"
  // is itself the length oracle we are trying not to hand out.
  const tokenDigest = token === null ? null : createHash('sha256').update(String(token)).digest();

  function tokenAccepted(presented) {
    if (tokenDigest === null) return true;
    if (typeof presented !== 'string' || presented === '') return false;
    return timingSafeEqual(createHash('sha256').update(presented).digest(), tokenDigest);
  }

  /** The published view: every registration, ordered by end name. */
  function snapshot() {
    return [...ends.values()]
      .map((entry) => entry.record)
      // Code-unit order, not locale order: two relays on two machines must
      // answer in the same sequence, and localeCompare does not promise that.
      .sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
  }

  // ---- HTTP ---------------------------------------------------------------

  function sendJson(req, res, status, body) {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': payload.length,
      'Cache-Control': 'no-store',
    });
    // A HEAD gets the headers and no body, which is the one thing a JSON
    // helper has to remember not to get wrong.
    if (req.method === 'HEAD') return res.end();
    return res.end(payload);
  }

  const server = createServer((req, res) => {
    const { route } = parseRelayPath(req.url);
    // Auth before routing: an unauthenticated prober should not be able to
    // tell `/ends` from `/nonsense`.
    if (!tokenAccepted(req.headers[RELAY_TOKEN_HEADER])) {
      // The route, never the raw target. Today no secret rides in a path and
      // the protocol works to keep it that way; logging the parsed route makes
      // that property hold by construction rather than by vigilance.
      logger.warn('relay.http_denied', { method: req.method, route });
      return sendJson(req, res, 401, HTTP_TOKEN_REJECTED);
    }
    if (route === 'ends' && (req.method === 'GET' || req.method === 'HEAD')) {
      return sendJson(req, res, 200, { ends: snapshot() });
    }
    return sendJson(req, res, 404, HTTP_NO_SUCH_PATH);
  });

  // ---- upgrades -----------------------------------------------------------

  server.on('upgrade', (req, socket, head) => {
    // An upgraded socket is nobody's responsibility but ours: without this
    // listener a reset peer is an uncaught exception that takes the relay with
    // it, which is the one failure that must never be possible here.
    socket.on('error', (err) => logger.debug('relay.socket_error', { message: err?.message }));

    if (!tokenAccepted(req.headers[RELAY_TOKEN_HEADER])) {
      logger.warn('relay.upgrade_denied', {});
      // Exactly the bytes the contract names: a status line and nothing else.
      // `end(...)` rather than `write(...)` so they are guaranteed to flush
      // before the socket goes -- the bytes on the wire are identical, and a
      // bare destroy() can drop a pending write.
      socket.end(UPGRADE_UNAUTHORIZED, () => socket.destroy());
      return;
    }

    const parsed = parseRelayPath(req.url);
    if (parsed.route === 'control') return openControl(req, socket, head);
    if (parsed.route === 'pair') return openPair(req, socket, head);
    if (parsed.route === 'attach') return openAttach(req, socket, head, parsed);
    // Not in the contract, which names no behaviour for an unknown upgrade
    // path. An honest HTTP refusal beats a dangling socket: a peer that gets
    // neither bytes nor a close waits on a handshake that will never arrive.
    return refuseUpgrade(socket, 404, 'no such relay path');
  });

  function accept(req, socket, head, route) {
    const ws = acceptUpgrade(req, socket, head, {
      ...wsLimits,
      onError: (err, where) => logger.debug('relay.ws_error', { route, where, message: err?.message }),
    });
    if (!ws) {
      logger.warn('relay.handshake_refused', { route });
      return null;
    }
    const entry = { ws, socket };
    live.add(entry);
    ws.onClose(() => live.delete(entry));
    return ws;
  }

  // ---- /control: the end registers ----------------------------------------

  function openControl(req, socket, head) {
    const ws = accept(req, socket, head, 'control');
    if (!ws) return;
    // One socket holds at most one name. `held` is this socket's claim, and it
    // is the only authority for retiring a registration -- see onClose.
    let held = null;

    ws.onMessage((data, isBinary) => {
      // Binary frames are ignored wholesale. The control channel is JSON text;
      // an end sending bytes here is not saying anything we understand, and
      // guessing would be worse than silence.
      if (isBinary) return;
      const frame = parseControlFrame(data);
      if (!frame) return;
      if (frame.kind === FRAME_ANNOUNCE) {
        held = announce(ws, frame, held);
        return;
      }
      if (frame.kind === FRAME_HEARTBEAT) {
        heartbeat(ws, held);
        return;
      }
      // Any other kind: ignored, on purpose. Forward compatibility is free
      // here and a protocol error would cost an end its registration.
    });

    ws.onClose((code, reason) => {
      // The registration dies with the socket -- and only if this socket still
      // owns it. A stale socket closing late must not evict whoever took the
      // name over in the meantime.
      if (held !== null && ends.get(held)?.ws === ws) {
        ends.delete(held);
        logger.info('relay.end_gone', { end: held, code, reason });
      }
    });
  }

  function announce(ws, frame, held) {
    const name = typeof frame.end === 'string' ? frame.end : '';
    if (name === '') {
      ws.close(REFUSED, REFUSE.announceWithoutEnd());
      return held;
    }
    const existing = ends.get(name);
    // "Already announced" means *from a live socket*. A registration whose
    // socket is gone is nobody's, and the end coming back must be able to
    // retake its own name.
    if (existing && existing.ws !== ws && existing.ws.open) {
      logger.warn('relay.announce_conflict', { end: name });
      ws.close(REFUSED, REFUSE.endTaken(name));
      return held;
    }
    const at = now();
    const mine = Boolean(existing && existing.ws === ws);
    // A re-announce on the same socket is an update, and it is the only way an
    // end reports going busy -- there is no separate frame kind for that -- so
    // announcedAt has to survive it. A takeover from a dead socket is a new
    // registration and starts a new announcedAt.
    const announcedAt = mine ? existing.record.announcedAt : at;
    // Announcing a second name from one socket releases the first. The contract
    // does not say; this is the only reading that keeps "a registration lives
    // as long as its control socket" true for both names at once.
    if (held !== null && held !== name && ends.get(held)?.ws === ws) ends.delete(held);

    ends.set(name, { ws, record: recordFromAnnounce({ ...frame, end: name }, { announcedAt, lastSeenAt: at }) });
    ws.send(JSON.stringify({ kind: FRAME_ANNOUNCED, end: name }));
    logger.info('relay.announced', { end: name, busy: frame.busy === true, update: mine });
    return name;
  }

  function heartbeat(ws, held) {
    const entry = held === null ? undefined : ends.get(held);
    // Only the owning socket may touch the record. A heartbeat from a socket
    // that lost the name is a no-op, not a rewrite of someone else's liveness.
    if (entry && entry.ws === ws) entry.record.lastSeenAt = now();
  }

  // ---- /attach: the client asks for an end --------------------------------

  function openAttach(req, socket, head, { endId, clientEnd }) {
    const ws = accept(req, socket, head, 'attach');
    if (!ws) return;

    if (clientEnd === '') {
      ws.close(REFUSED, REFUSE.attachWithoutClientEnd());
      return;
    }
    const end = ends.get(endId);
    if (!end || !end.ws.open) {
      logger.info('relay.attach_no_end', { end: endId, clientEnd });
      ws.close(REFUSED, REFUSE.noSuchEnd(endId));
      return;
    }
    // Keyed by the *pair*, never by the client name alone. One client
    // legitimately fans out to several ends under one identity -- that is the
    // normal case, not an abuse -- and keying by name would make the relay
    // refuse a client its own second end.
    const key = pairKey(endId, clientEnd);
    const current = attachments.get(key);
    if (current && current.ws.open) {
      logger.warn('relay.attach_duplicate', { end: endId, clientEnd });
      ws.close(REFUSED, REFUSE.clientAlreadyAttached(clientEnd, endId));
      return;
    }

    const pairing = randomUUID();
    const attachment = { key, pairing, endId, clientEnd, ws, peer: null, backlog: [], timer: null };
    attachments.set(key, attachment);
    pending.set(pairing, attachment);

    ws.onMessage((data, isBinary) => {
      if (attachment.peer) return forward(attachment.peer, data, isBinary);
      // The client speaks first; these frames are the handshake. Held in
      // order, replayed on pairing. Bounded by the websocket endpoint's own
      // message and queue caps rather than by a second cap here.
      attachment.backlog.push({ data, isBinary });
      return undefined;
    });

    ws.onClose((code, reason) => {
      if (attachments.get(key) === attachment) attachments.delete(key);
      // The *pending* entry deliberately outlives the client. An end that
      // dials back a moment too late has to be told which thing went wrong:
      // "the client that asked for this pairing is gone" is a different fact
      // from "I have never heard of this pairing", and only one of them means
      // the end should stop trying. The dial-back timer still reclaims the
      // entry, so this is a delay and not a leak.
      attachment.backlog = [];
      logger.info('relay.client_gone', { end: endId, clientEnd, code, reason });
      if (attachment.peer) closePeer(attachment.peer, code, reason);
    });

    attachment.timer = setTimeout(() => {
      if (pending.get(pairing) !== attachment) return;
      pending.delete(pairing);
      logger.warn('relay.no_dial_back', { end: endId, clientEnd, ms: pairingTimeoutMs });
      ws.close(REFUSED, REFUSE.noDialBack(endId));
    }, pairingTimeoutMs);
    // Unref'd: a relay waiting on a dial-back must never be the handle that
    // keeps a process from exiting.
    attachment.timer.unref();

    end.ws.send(JSON.stringify({ kind: FRAME_DIAL_BACK, pairing, clientEnd }));
    // No pairing in this record, nor in any other. It is a one-time credential
    // that buys a joined socket, and the protocol keeps it out of paths for
    // exactly the same reason it stays out of logs.
    logger.info('relay.attach', { end: endId, clientEnd });
  }

  // ---- /pair: the end dials back ------------------------------------------

  function openPair(req, socket, head) {
    const presented = req.headers[RELAY_PAIRING_HEADER];
    const ws = accept(req, socket, head, 'pair');
    if (!ws) return;

    const attachment = typeof presented === 'string' ? pending.get(presented) : undefined;
    if (!attachment) {
      logger.warn('relay.pair_unknown', {});
      ws.close(REFUSED, REFUSE.unknownPairing());
      return;
    }
    // Consumed on sight, before anything else can go wrong. A pairing is
    // strictly one-time even when the join it was minted for cannot happen.
    pending.delete(presented);
    clearPairingTimer(attachment);

    if (!attachment.ws.open) {
      logger.info('relay.pair_client_gone', { end: attachment.endId, clientEnd: attachment.clientEnd });
      ws.close(REFUSED, REFUSE.clientGone());
      return;
    }
    join(attachment, ws);
  }

  function join(attachment, endWs) {
    const clientWs = attachment.ws;
    // Stop buffering, join, replay -- all three in this one synchronous block,
    // so no client frame can slip in between and arrive ahead of the backlog.
    attachment.peer = endWs;
    const backlog = attachment.backlog;
    attachment.backlog = [];

    endWs.onMessage((data, isBinary) => forward(clientWs, data, isBinary));
    endWs.onClose((code, reason) => {
      attachment.peer = null;
      logger.info('relay.end_side_closed', { end: attachment.endId, clientEnd: attachment.clientEnd, code });
      closePeer(clientWs, code, reason);
    });

    for (const frame of backlog) forward(endWs, frame.data, frame.isBinary);
    logger.info('relay.paired', { end: attachment.endId, clientEnd: attachment.clientEnd, replayed: backlog.length });
  }

  /**
   * One frame, one direction, verbatim. The only thing carried besides the
   * bytes is which opcode they arrived under: a binary frame stays binary even
   * if it would survive being read as text, because the peer's framing is part
   * of its protocol and not ours to normalise.
   */
  function forward(target, data, isBinary) {
    try {
      target.send(isBinary && typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    } catch (err) {
      // One joined pair's bad frame ends that pair at worst, never the relay.
      logger.warn('relay.forward_failed', { message: err?.message });
    }
  }

  function closePeer(ws, code, reason) {
    // Pass the peer's own code through when it is sendable: the survivor should
    // learn why the other side left. 1006 and friends never go on the wire, so
    // they become "going away", which is what happened from here.
    try {
      ws.close(isSendableCloseCode(code) ? code : CLOSE.goingAway, reason ?? '');
    } catch {
      /* already down */
    }
  }

  function clearPairingTimer(attachment) {
    if (attachment.timer) {
      clearTimeout(attachment.timer);
      attachment.timer = null;
    }
  }

  // ---- lifecycle ----------------------------------------------------------

  function listen() {
    return new Promise((res, rej) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        rej(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        const addr = server.address();
        logger.info('relay.listening', { host: addr.address, port: addr.port, auth: token !== null });
        res(addr);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  async function close() {
    for (const attachment of pending.values()) clearPairingTimer(attachment);
    pending.clear();
    for (const entry of live) {
      try {
        entry.ws.close(CLOSE.goingAway, 'relay shutting down');
      } catch {
        /* ignore */
      }
    }
    const closed = new Promise((res) => server.close(() => res()));
    server.closeIdleConnections();
    // Not unref'd, deliberately: at shutdown this timer may be the last handle
    // standing, and an unref'd last handle never fires. Upgraded sockets are no
    // longer the http server's to close, so a peer that ignores our close frame
    // has to be hung up on by hand.
    const grace = setTimeout(() => {
      server.closeAllConnections();
      for (const entry of live) entry.socket?.destroy();
    }, shutdownGraceMs);
    await closed;
    clearTimeout(grace);
    logger.info('relay.closed', {});
  }

  return {
    server,
    listen,
    close,
    snapshot,
    address: () => server.address(),
    get endCount() {
      return ends.size;
    },
    get attachmentCount() {
      return attachments.size;
    },
    get pendingCount() {
      return pending.size;
    },
  };
}
