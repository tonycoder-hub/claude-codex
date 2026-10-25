# Bundle facts — verified, with the method that verified them

Subject: `/Applications/Codex cc.app`, version 26.930.21537, build 12776,
Electron 42.3.0, framework `Codex Framework.framework` 154.0.8037.93.

Everything here was established by reading the shipped bytes on the resident Mac.
Where a fact was *inferred*, it says so. Nothing in this file is a guess that is
presented as a reading.

## 1. The Electron fuses

The upstream fuse sentinel `dL7pKGdnNz796PbbjeW0L4m` appears **nowhere** in the
bundle. Codex's Electron fork **renamed it** to:

```
dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX
```

(shared prefix `dL7pKGdnNz796Pbbj`, then `QWNKmHXBZaB9tsX` instead of `eW0L4m`).
Searching for the upstream string returns zero hits and reads as "no fuses", which
is wrong and dangerous. Find the wire by **structure** instead — a version byte, a
length byte, then a run of `0`/`1`/`r`:

```
file: Contents/Frameworks/Codex Framework.framework/Versions/154.0.8037.93/Codex Framework
offset 0xd4cf6ca:  01 09 "010011001"      (version 1, 9 fuses)
fuse chars start at 0xd4cf6cc
```

There are **9** fuses, not the upstream 8. The framework exports exactly nine
`electron::fuses::Is*Enabled()` accessors; the extra one is `WasmTrapHandlers`.

The index of each fuse is **not inferred from a source ordering**. Each accessor is
a 20-byte leaf that loads one fixed byte and compares it to `'1'` (`#0x31`):

```
__ZN8electron5fuses18IsRunAsNodeEnabledEv
  adrp x8, 0xd4cf000 ; ldrb w8, [x8, #0x6cc] ; cmp w8, #0x31 ; cset w0, eq ; ret
```

`RunAsNode` reads `0xd4cf000 + 0x6cc = 0xd4cf6cc`, which is exactly the first fuse
character — so the table is self-anchoring. Disassembling all nine gives:

| idx | byte read | fuse | wire | state |
|---|---|---|---|---|
| 0 | `0x6cc` | RunAsNode | `0` | disabled |
| 1 | `0x6cd` | CookieEncryption | `1` | enabled |
| 2 | `0x6ce` | NodeOptions | `0` | disabled |
| 3 | `0x6cf` | NodeCliInspect | `0` | disabled |
| 4 | `0x6d0` | **EmbeddedAsarIntegrityValidation** | `1` | **enabled** |
| 5 | `0x6d1` | **OnlyLoadAppFromAsar** | `1` | **enabled** |
| 6 | `0x6d2` | LoadBrowserProcessSpecificV8Snapshot | `0` | disabled |
| 7 | `0x6d3` | GrantFileProtocolExtraPrivileges | `0` | disabled |
| 8 | `0x6d4` | WasmTrapHandlers | `1` | enabled |

Reproduce with:

```
nm -arch arm64 "<framework>" | grep electron5fuses
objdump -d --start-address=0x41d7500 --stop-address=0x41d75b4 "<framework>"
```

### What the fuses rule out

- `OnlyLoadAppFromAsar` **enabled** → Electron never consults
  `Contents/Resources/app/`. **Dropping in a plain `app/` directory does nothing.**
  An earlier draft of the brief claimed this was a free, asar-untouched injection
  point. That claim is **refuted**.
- `RunAsNode`, `NodeOptions`, `NodeCliInspect` all **disabled** → no
  `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no `--inspect` on the main process.
  There is no environment-variable path to main-process code execution.
- `EmbeddedAsarIntegrityValidation` **enabled** → `app.asar` is hash-checked at
  load. See §2 for exactly what is hashed.

`--remote-debugging-port` is a **Chromium switch, not a fuse**, so it is not
governed by any of the above.

## 2. What the asar integrity check actually covers

`Contents/Info.plist` carries:

```
ElectronAsarIntegrity = { "Resources/app.asar" = { algorithm = SHA256;
                          hash = 3db6024d6e1e2f6248f55e46b91be74b23cad2bc1f5406d4646ddafe11db3aef } }
```

That hash is the **SHA256 of the header JSON bytes, verbatim** — the `jlen` bytes
starting at file offset 16. Verified: hashing exactly those bytes reproduces
`3db6024d…`. It is *not* the whole file, not the prelude plus header, and not the
header with the prelude prefixed (both were computed and both differ).

Every one of the **20,814** entries carries its own integrity block:

```json
"early-bootstrap.js":{"size":3344,"offset":"3298902","integrity":{"algorithm":"SHA256",
  "hash":"bd83a16d…","blockSize":4194304,"blocks":["bd83a16d…"]}}
```

So the trust chain is:

```
file bytes → per-entry integrity.hash + 4 MiB blocks[] → header JSON
           → SHA256(header JSON) → Info.plist → code signature
```

Modifying anything inside `app.asar` means walking that whole chain. There is no
shortcut that skips a link.

### Layout numbers for a splice

```
prelude            16 bytes      struct <4I = (4, 5780300, 5780296, 5780290)
header JSON        5,780,290 bytes at offset 16
data region        starts 5,780,306, length 541,082,492
total              546,862,798
```

The header is serialized **compact** — `{"size":3017,"offset":"0",…}`, no spaces
after `:` or `,`. Entry `offset` is a **decimal string**, and it is **relative to
the data region start**, not to the file start.

That last detail is what makes a cheap modification possible: growing the header
shifts the data region but **does not invalidate any existing entry's offset**. So
a file can be replaced or added without re-hashing the other 20,813 entries:

1. Append the new bytes at the end of the data region (new `offset` =
   `"541082492"`).
2. **Textually splice** the one affected entry object in the header string,
   leaving every other header byte identical. This sidesteps re-serialization
   entirely — no risk of a formatting difference changing the hash.
3. Write a new 16-byte prelude for the new header length.
4. Stream-copy the original data region verbatim, then append the new blob.
5. SHA256 the new header → write into `Info.plist`.
6. `codesign -f -s -` the bundle.

The old bytes of a replaced entry stay in the file as dead space. Harmless.

`early-bootstrap.js`'s entry text begins at header offset **3525**, and the file is
the Electron entry point (`package.json` → `main`), so it is the natural splice
target for main-process injection.

## 3. The host bridge and the renderer

- Renderer entry: `/webview/index.html`, a single **relative-path** ES module
  (`./assets/index-56e9f72c1d6a.js`) plus modulepreloads and one stylesheet.
  `/webview` is 528.51 MB / 19,845 entries, mostly locales and wasm.
- `/.vite/build/preload.js` (6,909 bytes, fully readable) is the complete
  `contextBridge` surface: `window.codexWindowType` plus `window.electronBridge`
  with 23 members, of which **11 are read synchronously during module
  evaluation**. Five are seeded by `ipcRenderer.sendSync` at preload time.
- Two IPC channels carry the view protocol: `codex_desktop:message-from-view`
  (renderer→host, via `invoke`) and `codex_desktop:message-for-view`
  (host→renderer, re-dispatched as a `window` `MessageEvent`).
- **`electronBridge` is not the whole contract.** The preload also listens for
  `window.postMessage({type:'connect-app-host', port})` and forwards the
  `MessagePort` to the main process. That port carries **capnweb RPC over ~90
  services** at `encodingLevel='structuredClonable'`, and renderer boot **blocks
  on it before first paint**. A JSON transport silently corrupts `undefined`,
  `Date`, `BigInt`, `Infinity`/`NaN`, and `Uint8Array`/`ArrayBuffer` — the tunnel
  for this port must be binary and structured-clone faithful.
- The asar's bundled `node_modules` holds **only native modules**
  (`better-sqlite3`, `node-pty`, `objc-js`, `@worklouder`). There is **no `ws`**,
  so injected main-process code must use Node/Electron builtins only.
- The bundle is minified with **backtick** string literals (`"x"` → `` `x` ``).
  Grepping for `"thread/start"` returns nothing; grep `` `thread/start` ``.

## 4. Free (non-asar) injection points

The integrity hash covers `Resources/app.asar` **only**. Everything else in the
bundle is outside it and costs only a re-signature — and both bundles are already
`Signature=adhoc`, `TeamIdentifier=not set`, so `codesign -f -s -` is the
established path.

`Contents/MacOS/ChatGPT` is already a 7-line shell wrapper in the *production*
bundle:

```sh
#!/bin/sh
export CODEX_HOME="$HOME/.codex-cc"
export CODEX_SPARKLE_ENABLED=false
export CODEX_CLI_PATH="$(dirname "$0")/../Resources/codex"
( /bin/sleep 8; defaults write 'com.openai.codex.cc' SUEnableAutomaticChecks -bool false; … ) &
exec "$(dirname "$0")/ChatGPT.real" --user-data-dir="$HOME/Library/Application Support/Codex cc" "$@"
```

So the wrapper is a **free, zero-integrity-impact place to set environment
variables and append Chromium switches**. `Codex MTP.app` already exploits exactly
this.

`Contents/Resources/codex` is likewise a plain shell shim (1,512 bytes) that
sources `$CLAUDE_CODEX_RUNTIME_ENV` (default `$HOME/.codex-cc/claude-codex/runtime.env`)
and routes `app-server` — with or without leading `-c/--config` globals — to the
adapter, falling through to `codex.real` otherwise.

**The trap:** running a bundle's `Contents/Resources/codex` directly leaves
`CLAUDE_CODEX_RUNTIME_ENV` unset, so the shim falls back to **production's**
runtime.env and starts a real app-server against production's store, whose startup
recovery marks every `inProgress` turn `interrupted`. That destroyed three live
threads on 2026-10-19. Every experimental instance must set its own `CODEX_HOME`,
`CLAUDE_CODEX_RUNTIME_ENV` and `--user-data-dir`.
