// The end side of the relay: register a name, then answer dial-backs with
// sockets.
//
// This is the half that lives on the resident machine. It holds one `/control`
// socket open -- that socket *is* the registration, so it is never allowed to
// idle away -- and each time the relay says "a client wants you, here is a
// pairing", it dials `/pair` and hands the resulting byte stream to its caller.
//
// The websocket client handshake is not reimplemented here: `connectUpstream`
// in src/surface already performs it and returns the same WsConnection the
// server side uses, with the masking rules flipped. One framing implementation,
// used in both roles, is the rule this repo is built on.

import { hostname } from 'node:os';
import { connectUpstream } from '../surface/upstream.mjs';
import { wsDuplex } from './duplex.mjs';
import {
  CONTROL_PATH,
  FRAME_ANNOUNCE,
  FRAME_ANNOUNCED,
  FRAME_DIAL_BACK,
  FRAME_HEARTBEAT,
  PAIR_PATH,
  RELAY_PAIRING_HEADER,
  RELAY_TOKEN_HEADER,
  parseControlFrame,
} from './protocol.mjs';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Turn a relay base URL into the `ws://host:port/path` form connectUpstream
 * wants. `http://` is accepted and mapped, because that is how a relay address
 * tends to get written down when it also answers `GET /ends`.
 */
export function relayEndpoint(baseUrl, path) {
  const url = new URL(baseUrl);
  const scheme = url.protocol === 'http:' ? 'ws:' : url.protocol === 'https:' ? 'wss:' : url.protocol;
  return `${scheme}//${url.host}${path}`;
}

/**
 * Attach to a relay as a named end.
 *
 * @param {object} options
 * @param {string} options.url the relay base URL
 * @param {string} options.end the name to announce
 * @param {string|null} [options.token]
 * @param {(socket: import('node:stream').Duplex, info: { clientEnd: string }) => void} options.onSocket
 * @returns {Promise<{ end: string, setBusy: (busy: boolean) => void, stop: () => Promise<void> }>}
 */
export async function createEnd({
  url,
  end,
  token = null,
  connection = '',
  pid = process.pid,
  host = hostname(),
  cwd = process.cwd(),
  runtime = `node ${process.version}`,
  listen = null,
  busy = false,
  heartbeatMs = 30_000,
  announceTimeoutMs = 10_000,
  logger = silentLogger,
  onSocket,
} = {}) {
  if (typeof end !== 'string' || end === '') throw new Error('an end name is required');
  if (typeof onSocket !== 'function') throw new Error('createEnd needs an onSocket callback');

  const headers = token === null ? {} : { [RELAY_TOKEN_HEADER]: token };
  const control = await connectUpstream({
    address: relayEndpoint(url, CONTROL_PATH),
    headers,
    onError: (err, where) => logger.debug('end.control_error', { where, message: err?.message }),
  });

  const streams = new Set();
  let stopped = false;
  let state = { connection, pid, host, cwd, runtime, listen, busy };

  const announceFrame = () => JSON.stringify({ kind: FRAME_ANNOUNCE, end, ...state });

  let settle;
  const announced = new Promise((res, rej) => {
    settle = { res, rej };
  });

  control.onMessage((data, isBinary) => {
    if (isBinary) return;
    const frame = parseControlFrame(data);
    if (!frame) return;
    if (frame.kind === FRAME_ANNOUNCED) {
      logger.info('end.announced', { end: frame.end });
      settle.res(frame.end);
      return;
    }
    if (frame.kind === FRAME_DIAL_BACK) {
      // The pairing is never logged, here or anywhere: it is a one-time
      // credential and the protocol goes out of its way to keep it off paths
      // for the same reason.
      dialBack(frame).catch((err) => logger.warn('end.dial_back_failed', {
        clientEnd: frame.clientEnd,
        message: err?.message,
      }));
      return;
    }
  });

  control.onClose((code, reason) => {
    // The registration is gone the moment this socket is. There is deliberately
    // no reconnect loop here -- see the limitations listed in provider.mjs;
    // whoever owns the process is better placed to decide when to try again.
    logger.warn('end.control_closed', { end, code, reason });
    settle.rej(new Error(`relay closed the control socket: ${reason || code}`));
  });

  async function dialBack({ pairing, clientEnd }) {
    if (stopped) return;
    const ws = await connectUpstream({
      address: relayEndpoint(url, PAIR_PATH),
      headers: { ...headers, [RELAY_PAIRING_HEADER]: pairing },
      onError: (err, where) => logger.debug('end.pair_error', { where, message: err?.message }),
    });
    const stream = wsDuplex(ws, { clientEnd: typeof clientEnd === 'string' ? clientEnd : null, logger });
    streams.add(stream);
    stream.on('close', () => streams.delete(stream));
    logger.info('end.paired', { end, clientEnd });
    onSocket(stream, { clientEnd });
  }

  const beat = setInterval(() => {
    if (!control.open) return;
    control.send(JSON.stringify({ kind: FRAME_HEARTBEAT }));
  }, heartbeatMs);
  // Unref'd: heartbeats report liveness, they do not hold a process open. The
  // relay expires nothing on a timer, so a missed beat costs a stale
  // lastSeenAt and never the registration.
  beat.unref();

  const timeout = setTimeout(
    () => settle.rej(new Error(`the relay did not answer the announce within ${announceTimeoutMs}ms`)),
    announceTimeoutMs,
  );
  timeout.unref();

  control.send(announceFrame());
  try {
    await announced;
  } catch (err) {
    clearInterval(beat);
    clearTimeout(timeout);
    try {
      control.close();
    } catch {
      /* already down */
    }
    throw err;
  }
  clearTimeout(timeout);

  return {
    end,
    control,
    get streamCount() {
      return streams.size;
    },
    /**
     * Report a state change. A re-announce on the same control socket is how
     * busy is reported -- the protocol has no separate frame for it -- and the
     * relay preserves announcedAt across it.
     */
    update(fields = {}) {
      state = { ...state, ...fields };
      control.send(announceFrame());
    },
    setBusy(next) {
      this.update({ busy: next === true });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(beat);
      for (const stream of streams) stream.destroy();
      streams.clear();
      try {
        control.close();
      } catch {
        /* already down */
      }
      logger.info('end.stopped', { end });
    },
  };
}
