// The production upstream: a WebSocket *client* to the app-server slot.
//
// The surface needs both halves of RFC 6455 -- it is a server to the browser
// and a client to the app-server -- so this dials a socket, performs the client
// handshake by hand, and then hands the socket to the same WsConnection the
// browser side uses, with the masking rules flipped. No second framing
// implementation, which is the point.
//
// Both address forms the app-server slot is reachable at are supported, because
// which one you get depends on how the host process was started: a TCP
// `ws://127.0.0.1:port/path`, or a unix socket (`unix:/path/to.sock` or a bare
// absolute path). TCP is the portable case; the unix socket is the one with
// filesystem permissions on it, which is the better answer on a shared box.

import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { WsConnection, acceptValue } from './ws.mjs';

const MAX_HANDSHAKE_BYTES = 16 * 1024;

/**
 * Parse an upstream address into net.connect options plus the request target.
 * @returns {{ connectOptions: object, path: string, hostHeader: string, label: string }}
 */
export function parseUpstreamAddress(address) {
  if (typeof address !== 'string' || address === '') {
    throw new Error('an upstream address is required');
  }
  if (address.startsWith('unix:') || address.startsWith('/')) {
    const raw = address.startsWith('unix:') ? address.slice('unix:'.length) : address;
    // `unix:/run/app.sock:/ws` lets a unix upstream still name a request path.
    const split = raw.indexOf(':');
    const socketPath = split === -1 ? raw : raw.slice(0, split);
    const requestPath = split === -1 ? '/' : raw.slice(split + 1) || '/';
    return {
      connectOptions: { path: socketPath },
      path: requestPath,
      hostHeader: 'localhost',
      label: `unix:${socketPath}${requestPath}`,
    };
  }
  const url = new URL(address);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`unsupported upstream scheme ${url.protocol}`);
  }
  if (url.protocol === 'wss:') {
    // Deliberately not implemented: the app-server slot is local, and a TLS
    // client here would need trust configuration this process has no business
    // owning. Terminate TLS at the ingress instead.
    throw new Error('wss upstreams are not supported; use ws:// or a unix socket');
  }
  const port = Number(url.port || 80);
  return {
    connectOptions: { host: url.hostname, port },
    path: `${url.pathname || '/'}${url.search}`,
    hostHeader: `${url.hostname}:${port}`,
    label: `ws://${url.hostname}:${port}${url.pathname}`,
  };
}

/**
 * Dial an app-server and resolve once the handshake is complete.
 * @param {{ address: string, headers?: object, timeoutMs?: number }} options
 * @returns {Promise<WsConnection>}
 */
export function connectUpstream({ address, headers = {}, timeoutMs = 10_000, onError, ...limits } = {}) {
  const { connectOptions, path, hostHeader } = parseUpstreamAddress(address);
  const key = randomBytes(16).toString('base64');
  const expected = acceptValue(key);

  return new Promise((res, rej) => {
    const socket = connect(connectOptions);
    let buffer = Buffer.alloc(0);
    let settled = false;

    const timer = setTimeout(() => fail(new Error(`upstream handshake timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref();

    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', fail);
      socket.removeListener('close', onClose);
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      rej(err);
    }

    function onClose() {
      fail(new Error('upstream closed the socket during the handshake'));
    }

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffer.length > MAX_HANDSHAKE_BYTES) fail(new Error('upstream handshake response is too long'));
        return;
      }
      const headerText = buffer.subarray(0, end).toString('latin1');
      const head = buffer.subarray(end + 4);
      const [statusLine, ...lines] = headerText.split('\r\n');
      if (!/^HTTP\/1\.1 101 /.test(statusLine)) {
        return fail(new Error(`upstream refused the upgrade: ${statusLine}`));
      }
      const accept = lines
        .map((line) => line.split(':'))
        .find(([name]) => name.toLowerCase() === 'sec-websocket-accept')?.[1]
        ?.trim();
      // Checking the accept value is what proves we are talking to a websocket
      // and not to something that merely says 101.
      if (accept !== expected) return fail(new Error('upstream returned a bad Sec-WebSocket-Accept'));

      settled = true;
      cleanup();
      socket.setNoDelay(true);
      res(new WsConnection(socket, { ...limits, role: 'client', onError, head }));
    }

    socket.on('data', onData);
    socket.on('error', fail);
    socket.on('close', onClose);
    socket.on('connect', () => {
      const request = [
        `GET ${path} HTTP/1.1`,
        `Host: ${hostHeader}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        '', '',
      ].join('\r\n');
      socket.write(request);
    });
  });
}

/**
 * The factory shape createSurface expects: one upstream per authenticated
 * browser socket, dialled fresh so two clients never share a connection.
 */
export function createWsUpstreamFactory({ address, logger, ...options } = {}) {
  parseUpstreamAddress(address); // fail at construction, not on the first client
  return async ({ id } = {}) => {
    const upstream = await connectUpstream({
      ...options,
      address,
      onError: (err, where) => logger?.warn?.('upstream.error', { id, where, message: err?.message }),
    });
    logger?.info?.('upstream.connected', { id });
    return upstream;
  };
}
