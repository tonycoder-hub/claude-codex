# codex-relay-web

Open a web page on your phone and you are in **the real Codex App UI** — authenticated
with a passkey, with every turn executing through Claude Code on a resident machine.

This is not a reimplementation of the Codex interface. The page serves the App's own
renderer bytes and bridges them to the App's own host process, so the fidelity is
identity rather than resemblance.

- `docs/00-brief.md` — what exists, what was verified by reading the bundle, and the constraints.

## How this subtree sits in `claude-codex`

This component was developed in its own repository and imported here as a single
squashed commit. A few things follow from where it sits:

- **It is deliberately outside this repo's lint/typecheck boundary.** `npm run check`
  is `biome check src test scripts` (positional paths) and `tsconfig.json` includes
  only `src/**/*.mts` and `test/**/*.mts`. Neither can reach `relay/`. Measured on
  this tree: Biome checks 296 files and none are under `relay/`; `tsc --listFiles`
  loads 552 files and none are under `relay/`.
- **That boundary is load-bearing and fragile.** If someone ever rewrites the `check`
  script as `biome check .`, this subtree immediately contributes ~204 errors, because
  it is written in a different style (semicolons, 2-space, its own import order).
  Adopting Biome here is a reasonable follow-up, but it costs a ~43,000-line
  reformat and should be its own commit, never mixed into a behavior change.
- **Its only CI gate is its own suite**, run by the `relay-test` job via
  `npm run test:relay`. The component has zero runtime and dev dependencies, so that
  job needs no install step.
- **Two ingress providers were withheld from this import** pending a decision about
  whether a vendor name can appear in a public repository. They are additive to
  `src/relay/provider.mjs` (a factory import and one table row each) and live in the
  originating repository. Their absence does not affect any other provider.

## Shape

```
phone browser  ──HTTPS+WSS──►  ingress  ──►  codex-relay-web   (resident Mac)
                                                   │
                                        the Codex App's own main process
                                                   │  spawns the app-server slot
                                               claude-codex adapter
                                                   │
                                           relay ──►  ends  ──►  Claude Code
```

## Constraints this repo is built under

- Built and tested on the development host; built output is deployed to the resident
  Mac. Nothing is compiled or installed on the Mac.
- The runtime code injected into the App's main process uses **only Node/Electron
  builtins** — the App bundle ships no `ws`, and there is no install step on the Mac.
- `app.asar` is never modified. The production app bundle, its state, and the running
  relay fleet are never touched.
