#!/usr/bin/env node
// What ingress routes exist, and what the environment currently selects.
//
// This command exists because the two questions it answers were only
// answerable by reading source. `--list` is the registry, printed with the
// variables each route reads and what each one's absence costs; `--check`
// resolves the live environment exactly the way the surface does -- same
// resolver, same refusals -- and says what would start, without starting it.
//
// Nothing here dials, spawns or reads a credential. `--check` constructs the
// provider, which is where every provider does the checking it can do without
// touching the world, and that is the whole point of running it: a refusal
// costs a second here instead of being discovered by a phone that will not
// load.
//
// No option *value* is ever printed. A variable name is not a secret and
// "which one did you mean" is the whole question; CODEX_RELAY_RELAY_TOKEN's
// contents are not, so set-or-unset is all this prints about it.

import { PROVIDERS } from '../src/relay/provider.mjs';
import {
  INGRESS_ENV,
  PROVIDER_REQUIREMENTS,
  describeIngress,
  resolveIngressConfig,
} from '../src/relay/provider-config.mjs';
import { buildIngress } from '../src/surface/main.mjs';
import { VERIFIED_ON_RESIDENT } from '../src/relay/providers/tailscale.mjs';

const USAGE = `usage: ingress --list [--json]
       ingress --check [--json]

  --list    every ingress route, the variables it reads, and what each one's
            absence costs
  --check   resolve ${INGRESS_ENV} from this environment, construct the
            provider, and report what the surface would start -- or the
            refusal, naming the variable
  --json    machine-readable output

Nothing here starts an ingress. No variable's value is printed.`;

/**
 * What a reader needs told about a route that the requirements table cannot
 * say. Data, not prose in a help string, so each line can be traced to the
 * place that established it.
 */
const NOTES = Object.freeze({
  loopback: 'the default. A real url that only this machine can dial -- nothing remote reaches it',
  relay: 'needs a relay server to dial out to (src/relay/server.mjs; tools/probe/relay-server.mjs starts one)',
  ssh: 'needs a remote that already accepts ssh and will hold the public listener',
  tailscale: `written to spec, VERIFIED_ON_RESIDENT=${VERIFIED_ON_RESIDENT} -- never run end to end on the resident machine`,
});

function parseArgs(argv) {
  const out = { list: false, check: false, json: false, help: false };
  for (const arg of argv) {
    switch (arg) {
      case '--list': out.list = true; break;
      case '--check': out.check = true; break;
      case '--json': out.json = true; break;
      case '-h': case '--help': out.help = true; break;
      default: throw new Error(`unknown argument ${arg}`);
    }
  }
  if (out.list && out.check) throw new Error('--list and --check answer different questions; ask one at a time');
  return out;
}

function listText(write) {
  write(`${INGRESS_ENV} selects one of these. Unset means loopback.\n\n`);
  for (const name of Object.keys(PROVIDERS)) {
    write(`  ${name}\n      ${NOTES[name] ?? ''}\n`);
    const entries = describeIngress(name);
    const required = entries.filter((entry) => entry.required);
    const optional = entries.filter((entry) => !entry.required);
    if (required.length === 0) write('      required: none\n');
    for (const entry of required) {
      write(`      required  ${entry.variable} (${entry.type}) -> ${entry.option}\n`);
      write(`                without it: ${entry.consequence}\n`);
    }
    for (const entry of optional) {
      write(`      optional  ${entry.variable} (${entry.type}${entry.secret ? ', secret' : ''}) -> ${entry.option}\n`);
      write(`                default: ${entry.consequence}\n`);
    }
    write('\n');
  }
  // Said here because the listing otherwise reads as the complete set, and it
  // is not: two routes are withheld from this import. An operator who needs
  // one should learn that it exists and was held back, rather than conclude
  // from a short list that nobody ever considered it.
  write('This listing is not the complete set: two further routes exist in the\n');
  write('originating repository and are withheld from this import pending a\n');
  write('naming decision. See relay/README.md.\n');
  return 0;
}

function checkText(env, write) {
  const resolved = resolveIngressConfig(env);
  const ingress = buildIngress(env);
  write(`${INGRESS_ENV}=${resolved.defaulted ? `(unset, defaulted to ${resolved.name})` : resolved.name}\n`);
  write(`  provider  ${ingress.provider.name}\n`);
  write(`  shape     ${ingress.provider.shape}\n`);
  write(`  read      ${resolved.variables.length ? resolved.variables.join(', ') : 'nothing'}\n`);
  if (NOTES[resolved.name]) write(`  note      ${NOTES[resolved.name]}\n`);
  if (resolved.defaulted) {
    write('\nNo route was asked for, so the surface would be reachable from this\n');
    write('machine only. That is a working configuration and not a remote one.\n');
  }
  return 0;
}

function checkJson(env) {
  const resolved = resolveIngressConfig(env);
  const ingress = buildIngress(env);
  return {
    variable: INGRESS_ENV,
    provider: ingress.provider.name,
    shape: ingress.provider.shape,
    defaulted: resolved.defaulted,
    // Names only. The values are the configuration, and one of them is a token.
    variablesRead: resolved.variables,
    note: NOTES[resolved.name] ?? null,
  };
}

export function run(argv, { env = process.env, write = (text) => process.stdout.write(text), fail = (text) => process.stderr.write(text) } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    fail(`${err.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help || (!args.list && !args.check)) {
    write(`${USAGE}\n`);
    return args.help ? 0 : 2;
  }
  if (args.list) {
    if (!args.json) return listText(write);
    write(`${JSON.stringify(
      Object.keys(PROVIDER_REQUIREMENTS).map((name) => ({ provider: name, note: NOTES[name] ?? null, variables: describeIngress(name) })),
      null,
      2,
    )}\n`);
    return 0;
  }
  try {
    if (args.json) {
      write(`${JSON.stringify(checkJson(env), null, 2)}\n`);
      return 0;
    }
    return checkText(env, write);
  } catch (err) {
    // The refusal is the answer, not a crash: an operator ran --check to find
    // out whether the environment is wrong, and it is. Exit 1 so a script can
    // tell, and print the message, which names the variable.
    fail(`${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(run(process.argv.slice(2)));
}
