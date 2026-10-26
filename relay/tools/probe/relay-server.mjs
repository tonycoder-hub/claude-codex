#!/usr/bin/env node
// A relay, started from a shell. The missing half of driving the relay ingress
// by hand.
//
// src/relay/server.mjs has been complete and tested for a while, and the only
// thing that had ever started it was test/relay/harness.mjs. So "the relay
// provider works" was a claim about a test, not about anything a person could
// run: there was no process to point CODEX_RELAY_RELAY_URL at. This is that
// process, and it is a probe rather than a bin/ entry because the relay that
// matters in production is somebody else's -- ours is for driving the route on
// one machine and watching it carry bytes.
//
// usage: node tools/probe/relay-server.mjs [--port N] [--token-env NAME]
//
// The token is taken from a *named environment variable*, never from argv:
// argv is world-readable in `ps`. --token-env names the variable, and the
// variable holds the value.

import { createRelayServer } from '../../src/relay/server.mjs';

function parseArgs(argv) {
  const out = { port: 0, tokenEnv: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--port': out.port = Number(next()); break;
      case '--token-env': out.tokenEnv = next(); break;
      default: throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error('--port must be 0-65535');
  return out;
}

const stderrLogger = {
  write(level, event, fields) {
    process.stderr.write(`${JSON.stringify({ level, event, ...fields })}\n`);
  },
  debug() {},
  info(event, fields = {}) { this.write('info', event, fields); },
  warn(event, fields = {}) { this.write('warn', event, fields); },
  error(event, fields = {}) { this.write('error', event, fields); },
};

const args = parseArgs(process.argv.slice(2));
const token = args.tokenEnv ? process.env[args.tokenEnv] : null;
if (args.tokenEnv && (typeof token !== 'string' || token === '')) {
  process.stderr.write(`${args.tokenEnv} is unset or empty, so there is no token to require\n`);
  process.exit(2);
}

const relay = createRelayServer({ host: '127.0.0.1', port: args.port, token: token ?? null, logger: stderrLogger });
const address = await relay.listen();
// stdout is the machine-readable line a script waits for; everything else is
// on stderr. The port is the fact a caller cannot get any other way when it
// asked for 0.
process.stdout.write(`${JSON.stringify({ event: 'relay.listening', port: address.port, pid: process.pid })}\n`);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    relay.close().then(() => process.exit(0), () => process.exit(1));
  });
}
