# Brief — codex-relay-web

## Goal

Let a phone browser open a web page that is **the real Codex App UI**, authenticated
with a passkey, where every turn executes via Claude Code on a resident machine
(Mac `end-main`, or `.21` workers) through the existing relay fleet.

Two hard requirements:

1. Frontend style **completely identical** to the Codex App. Forking the app and
   writing a middle layer is explicitly allowed.
2. A **production-grade relay**: one-click auth setup, binding the network
   session / user token to a **passkey (WebAuthn)**, then "open the page on a
   phone and it just works".

Overriding design constraint: **minimum invasiveness**. Multi-device trigger,
resident-machine execution.

## The idea that makes requirement 1 tractable

The Codex renderer is a **plain web app**: `/webview/index.html` plus
`/webview/assets/**`, with a single relative-path ES module entry. The host it
talks to is reachable through a small, fully readable surface. So the design does
not reimplement the Codex interface — it **serves the App's own renderer bytes
over HTTP and bridges them to the App's own host process**. Fidelity becomes
identity rather than resemblance, and it does not drift when the App updates.

## What already exists (verified on disk)

- `claude-codex` adapter (upstream `github.com/fuergaosi233/claude-codex`): sits in
  the slot where the Codex App spawns `CODEX_CLI_PATH app-server`, speaks the Codex
  **app-server JSON-RPC** protocol, executes with the Claude Agent SDK.
  Canonical repo on `.21`:
  `work/claude-codex-residency-20261018`, branch
  `experiment/residency-orchestration`.
- A running relay fleet: `~/.codex-relay/` with `relay` + `surface` + 5 ends.
  LaunchAgents `local.codexrelay.{end-main,worker-1,worker-2,worker-3,worker21,tunnel}`
  are loaded. Surface page on loopback 8792 (an `ssh -L` to `.21`), relay on 8790.
- `/Applications/Codex MTP.app` — an APFS clone of `Codex cc.app` turned into a
  surface-only desktop instance via its `MacOS/ChatGPT` wrapper plus its own
  `runtime.env`. **This proves the "fork the bundle" pattern works.**

## Bundle internals

See [01-bundle-facts.md](01-bundle-facts.md) for the verified readings and the
commands that reproduce them. The three that shape the architecture:

- **`OnlyLoadAppFromAsar` is enabled** (verified by disassembling the fuse
  accessors, not inferred). A plain `Contents/Resources/app/` directory is never
  consulted. An earlier draft of this brief claimed that directory was a free,
  asar-untouched injection point — **that claim is refuted and must not be built
  on**.
- **`EmbeddedAsarIntegrityValidation` is enabled**, and the Info.plist hash is
  SHA256 of the header JSON bytes verbatim, with all 20,814 entries carrying their
  own integrity blocks. Any change inside `app.asar` means walking the whole chain
  and re-signing.
- **`electronBridge` is not the real contract.** The startup-blocking
  `connect-app-host` capnweb MessagePort (~90 services,
  `encodingLevel='structuredClonable'`) is. Its tunnel must be binary and
  structured-clone faithful; JSON silently corrupts `undefined`, `Date`, `BigInt`,
  `Infinity`/`NaN` and typed arrays.

Non-asar parts of the bundle — notably the `MacOS/ChatGPT` shell wrapper — are
outside the integrity hash and cost only an ad-hoc re-signature to change.

## Constraints that are not negotiable

- **This Mac is not a build host.** Nothing compiles, tests, packages or installs
  dependencies here. All authoring, building and testing happens on `.21`
  (`<dev-host>:<workdir>`, node v22.22.0), and built output is
  copied to the Mac. Reading, inspecting, running already-built code, `launchctl`
  and `codesign` on the Mac are fine.
- Runtime code injected into the App's main process uses **only Node/Electron
  builtins** — the bundle ships no `ws` and there is no install step on the Mac.
- Secrets stay out of output and off disk. No tokens, cookies, session ids, relay
  identifiers or private keys in reports or chat.
- Never touch the production `Codex cc.app`, its `~/.codex-cc` state, or the
  running fleet's processes. Work on clones, each with its own `CODEX_HOME`,
  `CLAUDE_CODEX_RUNTIME_ENV` and `--user-data-dir`.
- Private content does not leave this machine or reach another model. This rules
  out any ingress that terminates TLS on a third party as a *default*.
- Internal services: ≤10 requests in flight, ≤10 QPS.

## Known runtime hazards to design against

- **A child the App respawns must not exit.** The App restarts its
  `CODEX_CLI_PATH app-server` child instantly with no backoff; exiting is a hot
  loop that once produced ~35,000 processes at 500/min. Exit only after the far
  side has answered something.
- **A self-created `BrowserWindow` is silently ignored.** `isTrustedIpcSender`
  requires the sender's `webContents.id` to be in the window manager's private
  registry. An untrusted sender gets `null`/`{}`/`'light'`/`false` back, which
  yields a null sentry config and an immediate TypeError on first deref. Any
  window must be created through the App's own window-creation path.
- **No per-window app state.** `getContextForWebContents` returns one global
  singleton, and `sendMessageToAllWindows` hits every window including hidden ones.
- **One dropped, duplicated or reordered `message-for-view` frame permanently
  wedges that client** — there is no host-side timeout. The tunnel needs a
  monotonic per-direction sequence and a gap detector, and on a gap it should
  destroy and recreate the window rather than attempt a resync.
- **A never-focused hidden `primary` window latches `lastActivePrimaryWindow`**
  (`??=`), so every host-initiated reveal would target it.
- **`initializeNodeNetworkPermissions` runs before bootstrap** and can relaunch
  Electron under the Node permission model. It is `unrestricted` today, but if it
  ever runs without `--allow-net`, a listener inside the main process dies. The
  HTTP/WS surface must therefore be a **separate process**.
- **CSP must be rewritten by appending only to `connect-src`**, leaving every
  other directive byte-identical.
- Naive stubs for `showContextMenu`, `startLinkDrag` and `getPathForFile` break
  the UI in exactly the ways that read as "not pixel-identical".

## Shape

```
phone browser ──HTTPS+WSS──► ingress ──► codex-relay-web  (separate process, loopback)
                                           ├─ serves /webview/** straight out of app.asar
                                           ├─ rewrites index.html: CSP + bridge shim
                                           ├─ passkey (WebAuthn) → signed session
                                           └─ one tunnel per client
                                                 │
                                       a trusted window in a forked Codex instance
                                                 │
                                       the App's own main process
                                                 │ spawns CODEX_CLI_PATH app-server
                                           claude-codex adapter (relay-proxy)
                                                 │
                                          relay ──► ends ──► Claude Code
```

How that window is obtained is the open mechanism question —
see [02-fork-mechanism.md](02-fork-mechanism.md).
