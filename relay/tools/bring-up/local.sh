#!/bin/bash
# The whole chain on one machine, in one command: no domain, no VPS, no quota,
# and nothing shared with production.
#
#   browser ──http──▶ surface ──ws──▶ claude-codex adapter ──▶ MockRuntime
#   localhost:PORT     this repo       app-server --listen       no Claude Code
#
# This is the answer to "what do I set to bring it up", and it is deliberately
# the one configuration that needs a decision from nobody. `localhost` is the
# only hostname a browser treats as a secure context without a certificate, and
# the only valid WebAuthn RP ID available with no domain: an IP address is not a
# registrable domain, so `http://127.0.0.1` cannot carry a passkey at all, and
# `--rp-id 127.0.0.1` would be refused by the browser rather than by us. The
# public deployment in docs/12 still needs a real name. This does not.
#
# Run it on the resident Mac. The adapter is the only thing that can reach
# Claude Code and it only exists there; everything else in this repository is
# developed and tested on the dev host.
#
#   tools/bring-up/local.sh                bring it up and wait, printing the URL
#   tools/bring-up/local.sh --check        run every leg, report, exit
#   tools/bring-up/local.sh --last-mile    ...and drive the browser through it too
#   tools/bring-up/local.sh --real         put Claude Code at the far end, not the mock
#
# This file used to say the last mile could not be automated, because
# registering a passkey "needs a human at a platform authenticator". That was
# true of a human's fingers and not of the ceremony: --last-mile hands the
# browser a WebAuthn virtual authenticator, which makes the credential, the
# CBOR, the ES256 signature and our verification of it all real and simulates
# only the thumb. See last-mile.mjs. With --real as well, the answer that comes
# back is Claude's.

set -uo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
# The default is the first build that exists, newest location first, and the
# order is measured rather than a preference. Both builds were started the same
# way with isolated homes and asked `config/read`:
#
#   ~/.codex-cc/claude-codex/runtime  initialize ok, config/read ERROR
#                                     "require is not defined"
#   ~/.codex-relay/dist               initialize ok, config/read ok, 26 keys
#
# The older build has a bare `require('node:fs')` inside resolveCodexBinary()
# in an ESM module that never calls createRequire, so the PATH walk throws.
# `config/read` reaches it and is the one call the renderer never catches, so
# under --real the shipped bundle stops at 67 DOM nodes. The mock never sees
# it: CLAUDE_CODEX_MOCK=1 returns before the faulty call, which is why this
# script passed for months while --real could not have worked.
#
# Preferring the standalone build is also the safer of the two for an unrelated
# reason: it is not inside production's runtime directory.
default_adapter() {
  for candidate in \
    "$HOME/.codex-relay/dist/src/adapter.mjs" \
    "$HOME/.codex-cc/claude-codex/runtime/dist/src/adapter.mjs"
  do
    [ -f "$candidate" ] && { echo "$candidate"; return; }
  done
  echo "$HOME/.codex-relay/dist/src/adapter.mjs"
}
ADAPTER=${CODEX_ADAPTER:-$(default_adapter)}
CHECK=no
KEEP=no
LAST_MILE=no
REAL=no
for a in "$@"; do
  case "$a" in
    --check) CHECK=yes ;;
    --keep) KEEP=yes ;;
    --last-mile) LAST_MILE=yes ;;
    --real) REAL=yes ;;
    -h|--help) sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

failures=0
fail() { echo "  FAIL  $*"; failures=$((failures + 1)); }
pass() { echo "  ok    $*"; }

# ---- refuse to touch production -------------------------------------------
#
# Every line in this block is load-bearing. The adapter runs
# `store.recoverStaleInProgressTurns()` on EVERY start, `ws://` mode included,
# so an instance sharing production's store marks every `inProgress` turn
# `interrupted` -- which really did interrupt three live threads on 2026-10-19.
# The bundle's `Contents/Resources/codex` is never the right thing to execute
# here either: with `CLAUDE_CODEX_RUNTIME_ENV` unset it falls back to
# production's runtime.env and becomes exactly that shared instance.
case "$ADAPTER" in
  *Contents/Resources/codex)
    echo "refusing to run the bundle shim at $ADAPTER" >&2
    echo "it falls back to production's runtime.env; point CODEX_ADAPTER at runtime/dist/src/adapter.mjs" >&2
    exit 1 ;;
esac
[ -f "$ADAPTER" ] || { echo "no adapter at $ADAPTER (set CODEX_ADAPTER)" >&2; exit 1; }

SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/codex-relay-local.XXXXXX")
unset CLAUDE_CODEX_SOCKET_PATH            # or we would connect to the running adapter
export CODEX_HOME="$SCRATCH/codex-home"
export CLAUDE_CODEX_HOME="$SCRATCH/adapter-home"   # isolates state.sqlite
export CLAUDE_CODEX_DEBUG_LOG="$SCRATCH/debug.jsonl"
if [ "$REAL" = yes ]; then
  # Real Claude Code. The isolation above is what makes this safe to do at all;
  # none of it is relaxed here, only the mock switch is dropped.
  unset CLAUDE_CODEX_MOCK
  # The Agent SDK raises "Native CLI binary for darwin-arm64 not found" unless
  # it is told where Claude Code is, and `claude` is commonly a shell alias,
  # which a spawned process cannot see. So: an absolute path, or a clear error.
  if [ -z "${CLAUDE_CODEX_CLI:-}" ]; then
    for c in "$HOME/.local/bin/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
      [ -x "$c" ] && { export CLAUDE_CODEX_CLI="$c"; break; }
    done
  fi
  [ -n "${CLAUDE_CODEX_CLI:-}" ] || {
    echo "--real needs a claude binary; set CLAUDE_CODEX_CLI to its absolute path" >&2
    exit 1
  }
else
  export CLAUDE_CODEX_MOCK=1              # MockRuntime: no Claude Code, no quota
fi
# Somewhere for a thread to run. src/surface/main.mjs:237 spells out what
# happens without it, and it happened here: the renderer's startup gate reads
# `workspace-root-options`, renders the onboarding screen until it sees at
# least one root, and the only way off that screen is a native folder picker
# that a browser tab does not have. The page is then 784 nodes of chrome with
# `bodyText: ""` and a centred logo -- no failed request, no console error,
# nothing on the wire. The surface logs `surface.no_workspace_roots` on
# startup; this script read that log for an enrolment link and never for the
# warning, so it reported all legs green against a renderer that could not
# render. tools/bring-up/real-chain.sh set this from the day it was written.
#
# A scratch directory rather than a real one on purpose: the run should leave
# nothing behind, and an empty root is enough to get past the gate. Override
# CODEX_RELAY_WORKSPACE_ROOTS to drive the chain against actual code.
export CODEX_RELAY_WORKSPACE_ROOTS="${CODEX_RELAY_WORKSPACE_ROOTS:-$SCRATCH/workspace}"
mkdir -p "$CODEX_HOME" "$CLAUDE_CODEX_HOME" "$SCRATCH/workspace"

adapter_pid=
surface_pid=
cleanup() {
  [ -n "$surface_pid" ] && kill "$surface_pid" 2>/dev/null
  [ -n "$adapter_pid" ] && kill "$adapter_pid" 2>/dev/null
  wait 2>/dev/null
  if [ "$KEEP" = yes ]; then echo "logs kept in $SCRATCH"; else rm -rf "$SCRATCH"; fi
}
trap cleanup EXIT INT TERM

# A free port, asked of the kernel rather than guessed: 8787 is this repo's
# default and was already taken on the machine this was written for.
free_port() {
  node -e '
    const net = require("node:net");
    let port = Number(process.argv[1]);
    const attempt = () => {
      const probe = net.createServer();
      probe.once("error", () => { port += 1; attempt(); });
      probe.listen(port, "127.0.0.1", () => probe.close(() => console.log(port)));
    };
    attempt();
  ' "$1"
}

wait_tcp() {
  for _ in $(seq 1 60); do
    node -e '
      const net = require("node:net");
      const s = net.connect(Number(process.argv[1]), "127.0.0.1");
      s.on("connect", () => { s.destroy(); process.exit(0); });
      s.on("error", () => process.exit(1));
    ' "$1" && return 0
    sleep 0.25
  done
  return 1
}

SLOT=$(free_port "${SLOT_PORT:-8899}")
PORT=$(free_port "${SURFACE_PORT:-8787}")
echo "scratch $SCRATCH"
if [ "$REAL" = yes ]; then
  echo "slot    ws://127.0.0.1:$SLOT   (adapter, REAL runtime -- $CLAUDE_CODEX_CLI)"
else
  echo "slot    ws://127.0.0.1:$SLOT   (adapter, mock runtime)"
fi
echo "surface http://localhost:$PORT"

# The shipped Codex renderer, served out of the App's own asar under /app/.
# Optional, and the run is still useful without it -- the relay's hand-written
# chat UI exercises the same host middleware -- but without it `--real` means
# only "real Claude Code at the far end", not "the real UI in front of it",
# and fidelity to the shipped UI is the point of the exercise. Leaving it
# unset is how this script spent its life answering 404 for /app/ while
# reporting all legs green, because nothing it checks looks there.
#
# Reading app.asar at byte offsets is read-only and safe. What must never
# happen is executing the bundle's own `codex` binary: it falls back to
# production's runtime.env, and its startup recovery marks every inProgress
# turn interrupted. Nothing here runs it; this opens the archive as a file.
ASAR=${CODEX_RELAY_ASAR:-/Applications/Codex cc.app/Contents/Resources/app.asar}
if [ -f "$ASAR" ]; then
  export CODEX_RELAY_ASAR="$ASAR"
  echo "app     /app/ from $ASAR"
else
  echo "app     no asar at $ASAR -- /app/ will 404, serving the relay's own UI only"
fi
echo

# ---- leg 1: the app-server slot -------------------------------------------
echo "== adapter =="
node "$ADAPTER" app-server --listen "ws://127.0.0.1:$SLOT" >"$SCRATCH/adapter.log" 2>&1 &
adapter_pid=$!
if wait_tcp "$SLOT"; then
  pass "slot accepting on $SLOT (pid $adapter_pid)"
else
  fail "slot never accepted; adapter log follows"
  sed 's/^/        /' "$SCRATCH/adapter.log"
  exit 1
fi

if node "$REPO/tools/probe/appserver-slice.mjs" --url "ws://127.0.0.1:$SLOT" \
     --prompt 'Reply with exactly: slice-ok' --timeout 60000 >"$SCRATCH/slice.log" 2>&1; then
  pass "full turn over the slot: $(grep -c 'item/' "$SCRATCH/slice.log") item lines"
else
  fail "the vertical slice did not complete; tail follows"
  tail -15 "$SCRATCH/slice.log" | sed 's/^/        /'
fi

# ---- leg 2: the surface ----------------------------------------------------
echo
echo "== surface =="
# The file key store, not the Keychain. On macOS `defaultKeyStore` prefers the
# Keychain, which is right for a resident deployment and wrong for a scratch run
# that should leave nothing behind.
CODEX_RELAY_HOST=127.0.0.1 \
CODEX_RELAY_PORT="$PORT" \
CODEX_RELAY_STATIC="$REPO/web" \
CODEX_RELAY_STATE="$SCRATCH/surface-state" \
CODEX_RELAY_KEY_FILE="$SCRATCH/surface-state/session-key" \
CODEX_RELAY_RP_ID=localhost \
CODEX_RELAY_RP_ORIGIN="http://localhost:$PORT" \
CODEX_RELAY_UPSTREAM="ws://127.0.0.1:$SLOT" \
  node --input-type=module -e "
    import { main } from '$REPO/src/surface/main.mjs';
    await main();
  " >"$SCRATCH/surface.log" 2>&1 &
surface_pid=$!

if wait_tcp "$PORT"; then
  pass "surface listening on $PORT (pid $surface_pid)"
  # The handoff drive-real.mjs reads. It was written by real-chain.sh, which no
  # longer exists, so the files sat in /tmp pointing at whatever chain died
  # last -- and a driver run against them reported `enrol-link ok` from a dead
  # chain's log before failing every later step on a refused connection. Green
  # on a surface that had not existed for an hour.
  #
  # The pid goes in beside them so the reader can tell a stale handoff from a
  # live one, which is the part a port number alone cannot say.
  HANDOFF="${DRIVE_HANDOFF_DIR:-/tmp}"
  printf '%s\n' "$PORT" > "$HANDOFF/real-chain-port"
  printf '%s\n' "$SCRATCH" > "$HANDOFF/real-chain-scratch"
  printf '%s\n' "$surface_pid" > "$HANDOFF/real-chain-pid"
  pass "handoff written to $HANDOFF/real-chain-{port,scratch,pid}"
else
  fail "surface never listened; log follows"
  sed 's/^/        /' "$SCRATCH/surface.log"
  exit 1
fi

code() { curl -s --noproxy '*' --path-as-is -o /dev/null -w '%{http_code}' "http://localhost:$PORT$1"; }
expect() {
  local got
  got=$(code "$1")
  if [ "$got" = "$2" ]; then pass "$1 -> $got"; else fail "$1 -> $got, expected $2"; fi
}

# The module graph a browser actually walks, for BOTH documents, derived from
# the entry points rather than listed here. test/web/module-resolution.test.mjs
# proves the specifiers resolve to files; this proves the server answers them
# over HTTP, which is a different failure and a quieter one -- the renderer's
# startup waits on host silence forever, so a 404 on any module below is a
# blank page with a spinning logo and nothing in the console.
#
# Derived because the two hand-written lists this replaced had drifted: the
# second-document one named nine modules when the graph had thirteen, missing
# host-files.mjs and host-namespaces.mjs, so the loop built to catch that
# failure would have reported green through it.
expect / 200
expect /index.html 200
expect /style.css 200
expect /host-touch.css 200
graph=$(node "$REPO/tools/bring-up/module-graph.mjs") || {
  fail "could not derive the module graph"
  exit 1
}
for p in $graph; do
  expect "$p" 200
done
pass "module graph: $(printf '%s\n' "$graph" | wc -l | tr -d ' ') modules, derived from both entry points"

for p in /src/surface/server.mjs /src/ /package.json /../package.json /.git/config; do
  expect "$p" 404
done

# And the mount itself, but only when there was an archive to mount. The
# assertion is "not 404" rather than a particular code: unauthenticated, /app/
# answers whatever the session gate decides, and pinning that number here would
# turn a probe of the mount into a probe of the gate. 404 is the single answer
# that means the shipped renderer is not being served at all -- which is what
# this script reported, green, for its whole life before the mount was wired
# in, because nothing it checked ever looked at /app/.
if [ -n "${CODEX_RELAY_ASAR:-}" ]; then
  app_code=$(code /app/)
  if [ "$app_code" = 404 ]; then
    fail "/app/ -> 404, the archive did not mount"
  else
    pass "/app/ -> $app_code (shipped renderer mounted from the asar)"
  fi

  # Serving the renderer and starving it are different failures and only the
  # first one shows up as an HTTP code. The surface says so in its log; read it
  # rather than re-deriving the condition here, so the check tracks whatever the
  # surface decides counts as "nowhere to work" instead of drifting from it.
  if grep -q 'no_workspace_roots' "$SCRATCH/surface.log"; then
    fail "the surface has no workspace root -- the renderer will stay on its onboarding screen"
  else
    pass "workspace root $CODEX_RELAY_WORKSPACE_ROOTS (the renderer's startup gate has somewhere to open)"
  fi
fi

# The first device has to get in somehow. On a fresh state directory the surface
# prints the one link that can authorise it, and without that line the chain is
# up and still unusable by anybody. Only the fragment is matched and nothing is
# echoed: the token is single-use, but it is still a token.
if grep -q '#enroll=[A-Za-z0-9_-]\{8,\}' "$SCRATCH/surface.log"; then
  pass "surface printed an enrolment link"
else
  fail "no enrolment link in the surface log -- nobody could enrol"
fi

# The last mile. Everything above is the chain with a browser-shaped hole in
# the middle of it; this is the only check that closes the hole, so it is also
# the only one that can fail for a reason the others cannot see.
if [ "$LAST_MILE" = yes ] && [ "$failures" -eq 0 ]; then
  echo
  echo "== last mile =="
  # Through the environment, not argv: the link carries a bootstrap token and
  # argv is world-readable in `ps`.
  if RELAY_LINK=$(grep -o "http://localhost:$PORT/#enroll=[A-Za-z0-9_-]*" "$SCRATCH/surface.log" | tail -1) \
     node "$REPO/tools/bring-up/last-mile.mjs"; then
    pass "browser to $([ "$REAL" = yes ] && echo Claude || echo mock) and back"
  else
    fail "the last mile did not complete"
  fi
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "all legs green."
else
  echo "$failures check(s) failed."
fi

if [ "$CHECK" = yes ]; then
  exit $((failures > 0))
fi

# Printed here rather than left in the log, because this is the one command
# whose whole purpose is to hand it over. On a state directory that already has
# a passkey there is no link and none is needed.
LINK=$(grep -o "http://localhost:$PORT/#enroll=[A-Za-z0-9_-]*" "$SCRATCH/surface.log" | tail -1)
cat <<EOF

Open this on the device with the authenticator:

    ${LINK:-http://localhost:$PORT}

The passkey ceremony is the one step nothing above can do for you -- it needs an
authenticator and a human. Everything behind it is already proved. The link is
single use and expires in ten minutes; kill -USR1 $surface_pid prints another.
Ctrl-C stops both processes and removes $SCRATCH.
EOF
wait "$surface_pid"
