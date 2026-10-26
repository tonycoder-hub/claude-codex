# Fork mechanism — how we get a trusted host endpoint

The design needs, for each browser client, a live **`connect-app-host`
capnweb session** against a real Codex App main process — the ~90-service host
contract that actually drives threads, streaming and tool calls — tunnelled out
to the surface process, plus enough of `window.electronBridge` to boot the
renderer.

"Trusted" is load-bearing: `isTrustedIpcSender` checks the sender's
`webContents.id` against the window manager's private registry, and an unregistered
sender silently receives `null`/`{}`/`'light'`/`false`, which dies on the first
unguarded deref of the sentry config. So the host endpoint has to originate from a
window the App itself registered, not one we conjured.

> **Revised premise (2026-10-21).** An earlier draft wanted *one trusted
> `BrowserWindow` per client*. Probe 2 refuted the primitive it rested on: this is
> a **single-window app**. There is no `Cmd+N`, no "New Window" menu item;
> `window.open('app://-/index.html')` is denied by the main process's
> `setWindowOpenHandler` (returns no window, creates no target); and the one
> `open-in-new-window` path `.hide()`s the current window before loading the next —
> a reuse model, not coexistence. So "N trusted windows in one process" is not
> available, and the design must get its N host endpoints another way (see
> *Obtaining N host endpoints* below).

Because `OnlyLoadAppFromAsar`, `RunAsNode`, `NodeOptions` and `NodeCliInspect` are
all set the hardened way (see [01-bundle-facts.md](01-bundle-facts.md) §1), there
is **no environment-variable or dropped-directory path** to main-process code.
Exactly two mechanisms remain.

## Mechanism A — splice `app.asar` and inject into the main process

Replace the Electron entry `.vite/build/early-bootstrap.js` with a version that
performs the original work (append Chromium switches → `await
initializeNodeNetworkPermissions()` → `require('./bootstrap-…js')`) and then
installs our own code, which creates windows through the App's own window-creation
path and tunnels them.

Mechanically this is fully specified and cheap, because entry offsets are relative
to the data region:

1. append the new bytes at the end of the data region;
2. **textually splice** the single affected header entry, leaving all other header
   bytes identical (no re-serialization, so no formatting risk);
3. rewrite the 16-byte prelude;
4. stream-copy the data region, append the blob;
5. `SHA256(header JSON)` → `Info.plist`;
6. `codesign -f -s -`.

**Pro** — full main-process control. Windows are created through `registerWindow`,
so trust is structural rather than coaxed. No debugging port is exposed. No CSP
bypass needed.

**Con** — writes a 546 MB file per App version. Requires re-deriving the
`early-bootstrap.js` replacement whenever the App updates, since it must reproduce
whatever the new original does. Keeps `Info.plist`, the header hash and the
signature in lockstep. It is the most invasive option available, which is in
tension with the governing constraint.

## Mechanism B — wrapper-only, drive the App over CDP

`--remote-debugging-port` is a **Chromium switch, not a fuse**, so it is not
governed by the hardened fuses. `Contents/MacOS/ChatGPT` is a plain shell wrapper
**outside the integrity hash**, and `Codex MTP.app` already proves editing it and
re-signing works. So the entire bundle modification is:

```sh
exec "$(dirname "$0")/ChatGPT.real" \
  --user-data-dir="$ISOLATED" \
  --remote-debugging-port=$PORT --remote-debugging-address=127.0.0.1 "$@"
```

`app.asar` is **not touched at all** — no splice, no integrity recompute, nothing
to re-derive on an App update.

The surface process then uses CDP to obtain and instrument a window:
`Target.setDiscoverTargets` / `setAutoAttach` to notice windows,
`Page.addScriptToEvaluateOnNewDocument` to install the tunnel **before** any page
script (early enough to capture the 11 synchronous bridge members and to intercept
the `connect-app-host` `postMessage` before the preload sees it), and
`Page.setBypassCSP` so the tunnel's own socket is not blocked by the `connect-src`
allowlist.

CDP against this app is **already proven to work** — a prior session used
`Page.reload` on it while measuring thread-open latency.

**Pro** — by far the smaller blast radius, and the one that actually honours
"minimum invasiveness". Survives App updates with no re-derivation.

**Con** — a loopback debugging port is an unauthenticated local control channel
(comparable to the relay's existing unauthenticated loopback listener, but it is
new surface and should be acknowledged, not waved past). And intercepting a
`MessagePort` transfer from inside the page is more delicate than owning the
preload — the probe-3 question. The App turning out to be single-window (probe 2)
removed the "must coax N windows" worry, but shifted the weight onto the
host-endpoint strategy instead (S1/S2/S3 above).

## What the probes settled

Each ran against an isolated lab instance, never production.

1. **Does the wrapper-only switch take? — YES.** With only `Contents/MacOS/ChatGPT`
   changed and `app.asar` byte-identical to production, CDP answers on
   `127.0.0.1:19333` (loopback-only per `lsof`), and `Target.getTargets` lists two
   real page targets on `app://-/index.html`, both fully painted
   (`readyState: complete`, `rootHasContent`, `bodyChildCount: 2`), both trusted
   (`getSentryInitOptions()` returns a 7-key object), 22 bridge members,
   `themeGetterStable: true`. **Mechanism B's foundation holds.**

2. **Can we force a second trusted window? — NO, and we no longer need to.**
   `window.open` returns no window and creates no target; the app is single-window
   (above). The design pivots off multi-window entirely.

3. **Can a document-start script see the `connect-app-host` port before the app?
   — YES.** `Page.addScriptToEvaluateOnNewDocument` wrapping `addEventListener`
   measured the order rather than assuming it: our listener was registered first,
   the handshake arrived at t+1493ms carrying one **usable** `MessagePort`, and
   `listenersRegisteredBefore` was 0. (The bundle's own message listeners register
   later -- t+1565ms, +3893ms, +5247ms -- which was the clue that sent us to read
   the handshake source.)

4. **Can the renderer simply mint a second host session? — YES, and this is the
   answer.** See below.

## How the handshake actually works

An earlier draft of this document said the host port was "pushed main -> preload
-> main world". **That was wrong**, and the correction is what collapses the whole
design. From `app-shared.js`:

```js
function lei(e) {
  let { port1: t, port2: n } = new MessageChannel();
  window.postMessage({ type: `connect-app-host`, port: n }, window.location.origin, [n]);
  return vVt(t, e);   // renderer keeps port1 and speaks capnweb on it
}
```

The renderer **creates** the channel. It keeps `port1`, posts `port2` to its own
window so the preload can relay it to main, and runs capnweb over `port1`. The
connection is also bidirectional: the argument is the renderer's own service set,
and `await connection.services` yields main's.

So the port was never main's to hand out, and "intercept the app's port" was
solving the wrong problem.

## Obtaining N host endpoints — settled

**S2 wins, and it is nearly free.** Probe 4 did exactly what `lei` does -- new
`MessageChannel`, same `postMessage` -- from the main world of the resident
window, and main **bound it as an independent capnweb session**:

| observation | value |
|---|---|
| frames main sent unprompted | `["push",["pipeline",0,["services"]]]`, `["pull",1]` |
| reply to our `["pull",0]` | `["resolve",0,["export",-1]]` |
| app's own session afterwards | `trusted: true`, root DOM byte-identical (4612), 22 bridge members |

Main serves one session **per port**, sessions do not disturb each other, and the
app's connection was untouched. One browser client therefore equals one minted
port in the resident window -- no membrane, no extra window, no second instance,
and all clients share the one resident app-server and its live thread state.

That also hands us the wire format for free: capnweb frames are small JSON arrays
-- `["push", expr]`, `["pull", id]`, `["resolve", id, value]`, with `["pipeline",
id, path]` and `["export", n]` as value forms.

The rejected alternatives, kept because a future App build could revive the need:

- **S1 — a capnweb membrane over one intercepted port.** Would have meant
  remapping import/export and promise ids per client: the hardest code in the
  project, and now unnecessary.
- **S3 — one cloned instance per client.** Guaranteed to work and already
  buildable with `make-instance.mjs`, but each clone runs its own app-server and
  does not share the resident desktop's thread state. Kept as the fallback if
  minting is ever refused.

`HostEndpointSource` stays a seam so S3 remains a drop-in, but S2 is the
implementation.

## Decision

**Injection: Mechanism B (wrapper + CDP).** Probe 1 proved it, it leaves
`app.asar` untouched, and it survives App updates with no re-derivation — which is
what "minimum invasiveness" demands. Mechanism A stays fully specified above as the
fallback if a future App build closes the debug port or the host-endpoint strategy
needs main-process code.

**Host endpoint: S2 (mint one port per client), decided by probe 4.** The trigger
turned out to be fully renderer-reachable — it is just `lei`'s one `postMessage` —
so there is nothing opportunistic left to wait on. Each browser client gets its own
independent capnweb session from one minted `MessageChannel` in the resident
window, with no membrane, no extra window and no second instance. `HostEndpointSource`
stays a seam so S3 (cloned instance) remains a drop-in fallback if a future App
build refuses extra sessions; S1 (membrane) is retired as unnecessary.

## The lab instance

Experiments never run against production. Each lab instance is an APFS clone with
its own `CODEX_HOME`, its own `CLAUDE_CODEX_RUNTIME_ENV`, its own
`--user-data-dir`, Sparkle disabled, and `CFBundleURLTypes` removed so it cannot
capture `codex://` links. Running a bundle's `Resources/codex` with
`CLAUDE_CODEX_RUNTIME_ENV` unset falls back to **production's** runtime.env and
corrupts production's thread state — this is not hypothetical, it interrupted three
live threads on 2026-10-19.

`tools/instance/make-instance.mjs` builds one; it is authored and tested on `.21`
and executed on the Mac.
