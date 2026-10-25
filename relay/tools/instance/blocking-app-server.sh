#!/bin/sh
# A CODEX_CLI_PATH stand-in that never exits.
#
# The Codex App respawns its `CODEX_CLI_PATH app-server` child instantly, with no
# backoff, so a child that exits is a hot loop -- this once produced ~35,000
# processes at roughly 500/min, and the storm is invisible from the relay end.
#
# A lab instance with an empty CODEX_HOME has no claude-codex/runtime.env, so the
# real shim would `exit 78` immediately and trigger exactly that. Point
# CODEX_CLI_PATH here instead when a probe only needs the browser process up (for
# example: is the remote debugging port answering?) and does not need a working
# app-server.
#
# It holds stdin open and answers nothing, so the renderer will block waiting for
# its first response. That is the intended trade: a blocked renderer is observable
# and harmless, a respawn storm is neither.
exec cat >/dev/null
