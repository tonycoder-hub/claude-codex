#!/usr/bin/env node
// curl, on the far side of a relay.
//
// The relay provider's whole job is to produce sockets: a client attaches to a
// named end, the relay joins the two websockets, and the bytes that arrive are
// fed into our http server with `server.emit('connection', socket)`. That
// means the thing on the other side is not a browser pointed at a URL -- there
// is no URL -- it is whatever can speak the attach side of the protocol. Until
// now that was only a test.
//
// This bridge is the client side, as a local TCP listener: every connection it
// accepts becomes one attach to the end, so `curl http://127.0.0.1:<port>/`
// reaches the surface through the relay, over the same path a phone's client
// would. It is a probe, not a product -- it has no TLS, no auth of its own and
// no retry.
//
// usage: node tools/probe/relay-bridge.mjs --relay ws://127.0.0.1:9100 \
//          --end resident --as probe --port 9200 [--token-env NAME]
//
// The token comes from a named environment variable, not from argv, because
// argv is readable by anybody who can run `ps`.

import { createServer } from 'node:net';
import { connectUpstream } from '../../src/surface/upstream.mjs';
import { wsDuplex } from '../../src/relay/duplex.mjs';
import { RELAY_TOKEN_HEADER, attachPath } from '../../src/relay/protocol.mjs';

function parseArgs(argv) {
  const out = { relay: null, end: null, as: 'relay-bridge-probe', port: 0, tokenEnv: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--relay': out.relay = next(); break;
      case '--end': out.end = next(); break;
      case '--as': out.as = next(); break;
      case '--port': out.port = Number(next()); break;
      case '--token-env': out.tokenEnv = next(); break;
      default: throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!out.relay) throw new Error('--relay is required: the ws:// base url of the relay');
  if (!out.end) throw new Error('--end is required: the end name the resident announced');
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error('--port must be 0-65535');
  return out;
}

const log = (level, event, fields = {}) => process.stderr.write(`${JSON.stringify({ level, event, ...fields })}\n`);

const args = parseArgs(process.argv.slice(2));
const token = args.tokenEnv ? process.env[args.tokenEnv] : null;
if (args.tokenEnv && (typeof token !== 'string' || token === '')) {
  process.stderr.write(`${args.tokenEnv} is unset or empty, so there is no token to present\n`);
  process.exit(2);
}
const headers = token ? { [RELAY_TOKEN_HEADER]: token } : {};

let seq = 0;
const server = createServer((socket) => {
  const id = (seq += 1);
  // One attach per TCP connection. A second client identity per connection
  // because the relay refuses a client end that is already attached, and a
  // keep-alive curl plus a second curl would otherwise collide.
  const as = `${args.as}-${id}`;
  socket.on('error', (err) => log('warn', 'bridge.socket_error', { id, message: err.message }));
  connectUpstream({
    address: `${args.relay.replace(/\/+$/, '')}${attachPath(args.end, as)}`,
    headers,
  }).then((ws) => {
    const duplex = wsDuplex(ws, { clientEnd: as });
    duplex.on('error', (err) => log('warn', 'bridge.duplex_error', { id, message: err.message }));
    socket.pipe(duplex);
    duplex.pipe(socket);
    log('info', 'bridge.attached', { id, end: args.end, as });
  }, (err) => {
    log('error', 'bridge.attach_failed', { id, end: args.end, message: err.message });
    socket.destroy();
  });
});

server.listen(args.port, '127.0.0.1', () => {
  const addr = server.address();
  process.stdout.write(`${JSON.stringify({ event: 'bridge.listening', port: addr.port, pid: process.pid, end: args.end })}\n`);
});

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close(() => process.exit(0));
  });
}
