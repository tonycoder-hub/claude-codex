// The fetch endpoint layer: the renderer's whole non-conversation data layer,
// which is ~95 endpoints hiding behind one message type.
//
// WHAT THIS ANSWERS, AND WHY IT IS ONE MODULE RATHER THAN NINETY-FIVE
//
// The renderer has exactly one universal host RPC. Measured at
// assets__app-shared-59042e7300f7.js ~3,278,630:
//
//   async sendRequest(e,t,n){
//     if(!t.startsWith(`vscode://codex/`)&&t!==`/codex/dictation-stream-connect-info`)
//       return this.fetchJson(t,{...n,method:e});
//     let r=crypto.randomUUID(),
//         i={requestId:r,method:e,url:t,headers:n?.headers,body:n?.body,responsePriority:...};
//     return new Promise((e,t)=>{ ... yf.getInstance().dispatchMessage(`fetch`,i) })
//   }
//
// and its caller builds the URL by interpolation, never from a literal:
//
//   async function dxn(e,t,n,r,i,a){
//     let o=(await CU.getInstance().post(`vscode://codex/${e}`,JSON.stringify(t),...)).body;
//     return n?n(o):o }
//
// So files, git, gh, worktrees, global state, settings, the inbox, automations,
// skills, workspace roots and directory listings are not ninety-five message
// types. They are ninety-five POST bodies on one message, and the endpoint name
// lives in the URL path. That is why routing happens here, on the path, and why
// there is nothing else to wire up: a boot that currently shows "Choose
// project" with the Send button disabled is a boot whose data layer is one
// unanswered message wide.
//
// THE CARDINAL RULE: ANSWER EVERY `fetch`, ALWAYS
//
// There is no `setTimeout` anywhere in that `sendRequest` body. The only thing
// that can end the promise early is an external AbortSignal. An unanswered
// `fetch` is therefore not a slow request and not an error -- it is a promise
// that never settles, under a react-query layer that spins forever with a clean
// console. The measured `getRestartBlockers()` even reports
// `web-fetch.pending-request` while one is outstanding, so a single forgotten
// endpoint also blocks app-server restart.
//
// Everything structural about this module follows from that one sentence:
//
//   * `handle` cannot return without either delivering exactly one
//     `fetch-response` or counting the message as unanswerable, and the only
//     unanswerable message is one with no usable `requestId` -- a reply the
//     renderer's pending table cannot match is indistinguishable from silence,
//     so there is nothing to send.
//   * An endpoint nobody implemented falls into a default branch rather than a
//     lookup miss. `routeFor` always returns a function.
//   * A handler that throws, a store that rejects and a URL that will not parse
//     all converge on the same single-reply path.
//
// SUCCESS, NON-2XX AND ERROR ARE THREE OUTCOMES, NOT TWO
//
// The renderer's reader, measured at ~3,273,052:
//
//   onFetchResponse(e){ let t=this.pendingRequests.get(e.requestId); if(t)
//     switch(this.pendingRequests.delete(e.requestId),t.cleanup?.(),e.responseType){
//       case`success`: try{ e.status>=200&&e.status<300
//           ? t.resolve({status:e.status,headers:e.headers,body:`body`in e?e.body:JSON.parse(e.bodyJsonString)})
//           : t.reject(new xU(`body`in e?JSON.stringify(e.body):e.bodyJsonString,e.status)) }catch(e){t.reject(...)}
//         break;
//       case`error`: t.reject(new xU(e.error,e.status,e.errorCode,e.responseStatus)) } }
//
// A success envelope with a non-2xx status REJECTS, with the body stringified
// as the message. That is the renderer modelling HTTP, and it is the right way
// to say "this endpoint exists and the answer is no": the promise settles, the
// caller sees a real status, and nothing hangs. So this module uses the success
// envelope with a 501 for an endpoint it is routing but has no backing store
// for, and reserves the `error` envelope for the cases where there was no HTTP
// answer at all to report.
//
// Where there is a choice, a 2xx with a shaped-empty body beats both, because
// several measured call sites have no catch arm -- see the shape table below.
//
// WHY A SHAPE TABLE AND NOT A BLANKET `{}`
//
// `{}` is a safe default only for endpoints whose callers read fields through
// optional chaining. Several do not. The sharpest measured example is
// `inbox-items`:
//
//   mOn=Ko(q,({get:e})=>{let t=e(pOn).data,
//     r=new Set(t?.unreadRunCounts.unreadRuns.map(e=>e.threadId)), ...
//
// The guard is `t?.` on the query data and NOTHING after it, so once data
// exists `unreadRunCounts` and `unreadRuns` are mandatory; `{}` throws inside a
// selector rather than rendering an empty inbox. `recommended-skills` has the
// same trait on its refresh path (`x(r.skills,e)` on the awaited result, no
// guard), and `workspace-root-options` is read as `e.includes(t)`.
//
// Hence: measured shapes in the table, `{}` for everything else, and nothing
// invented in between. An inferred key is worse than a missing one -- a missing
// key reads as undefined, which is what the caller already handles, while a
// wrongly-named one adds a field the renderer will never look at and hides the
// gap from whoever greps for it next.
//
// WHAT THIS MODULE DOES NOT DO
//
// It opens no socket, touches no filesystem and knows nothing about the relay.
// Everything that needs a real backing store arrives as an option: the global
// state and settings store, the codex home path, the workspace root list. The
// default store is in memory, which is enough to make a session coherent and
// not enough to survive a reload -- stated here rather than discovered later.
//
// `fetch-stream-complete`, `fetch-stream-error` and `fetch-body-resolved` are
// not host messages and have no place here; the streaming path uses the
// browser's own fetch behind an AbortController, and the third is a Sentry span
// name. See the matching warning in web/host-protocol.mjs.
//
// WHAT A USER WILL NOTICE, BECAUSE A MEASURED EMPTY IS STILL AN EMPTY
//
// Every row in the shape table stops a crash or fixes a vocabulary, and not
// one of them implements an endpoint. The shapes are all some spelling of
// "nothing", so the page renders -- and then renders nothing where a real
// Electron host would have had something. The honest list, so that nobody has
// to rediscover it from a bug report:
//
//   * `paths-exist` answers `[]` always. A page artifact will not open ("Page
//     artifact file is unavailable"), an image preview tab will not restore,
//     file artifacts drop out of turns, and the select-workspace page's rows
//     vanish once its `placeholderData:{existingPaths:[l]}`
//     (select-workspace-page-3f0740be5ea2.js@15593) resolves to the real
//     answer -- a row renders only when its root is reported existing. This is
//     the largest single difference in the table and it is irreducible: this
//     module has no filesystem, which is also why `read-file` refuses.
//   * `developer-instructions` answers `''` always, so every turn runs with no
//     project developer instructions -- no AGENTS.md, no desktop context
//     section. A real host assembles them in
//     `getProjectAwareDeveloperInstructions` (main-C3nRcJ3D.js@1372354). The
//     model will not see repository conventions it would see in the app.
//   * `mcp-codex-config` answers `{config:null}`, so no desktop MCP servers,
//     artifact session tools or worktree tools are contributed to any turn.
//   * `local-custom-agents` answers `{agents:[]}`, so no custom roles from any
//     root's `.codex` directory appear in the agents list.
//   * `fast-mode-rollout-metrics` answers null, so the savings banner never
//     appears. The real producer answers a zero-filled record when it finds no
//     sessions directory, which renders nothing either -- the difference is
//     only in which absent-shape is sent.
//   * `wsl-bash-availability` and `get-copilot-api-proxy-info` are differences
//     from a differently-configured host rather than from this one: a Mac has
//     no WSL distribution and a non-Copilot install answers null for the proxy
//     unconditionally (main-C3nRcJ3D.js@1378233). Both match production here.
//   * `ambient-suggestions` answers an empty suggestions file, so the home page
//     never shows a generated suggestion. The real host generates them through
//     a model call per project root; this one has no generator, and the
//     `ambient-suggestions-refresh` that would ask for more is not served
//     either -- which is harmless, because its `select:()=>!0` discards the
//     body and its only effect is to invalidate this query.
//   * `external-agent-import-status` answers zero imported sessions, so the
//     settings page's Claude Code / external-agent import section reports
//     nothing to import.
//   * `global-dictation-hotkey-state` answers `supported:false`, so the
//     global-dictation first-use nudge never appears. That is the same answer
//     the real app gives on any platform without hotkey support, and it is the
//     honest one: a browser tab cannot register a system-wide hotkey.
//   * `worktree-shell-environment-config` answers a null environment, so a
//     worktree's own shell environment is not applied to turns started in it.
//
// TWO ENDPOINTS ARE DELIBERATELY NOT IN THE TABLE
//
// `set-remote-control-connections-enabled` and
// `set-remote-wsl-connections-enabled` are reported unimplemented, with
// `shaped: false`, and they should stay that way. Both are mutations the real
// host answers with a body (`{remoteControlConnections}` and
// `{remoteWslConnections}`, main-C3nRcJ3D.js@1359142), and the renderer's only
// caller of each is a fire-and-forget `useEffect` sync with its own `.catch`
// that logs `[remote-connections/gate-bridge] sync_failed` or
// `[remote-connections/wsl-feature-bridge] sync_failed` and reads no reply
// (app-initial-60d038a052d7.js@9650092 and @9651112). Shaping them would mean
// inventing a connection list on a host that has none, to be discarded by a
// caller that never looks -- so the 501 stands and the warning in the console
// is accurate. The WSL one additionally never fires here: its `enabled` is
// ``n===`windows`&&...``.
//
// All of them are still counted by `stats().unknown` and still fire
// `endpoint-unimplemented`, deliberately -- with `shaped: true`, which is how a
// reader of the diagnostics tells this list apart from the endpoints that fell
// through to the blank. See `routeFor`.

import { detectContentKind, detectMimeType, encodeBase64 } from './host-files.mjs';
import {
  OUTBOUND,
  inboundFetchResponseError,
  inboundFetchResponseSuccess,
} from './host-protocol.mjs';

/**
 * The only two URL forms the renderer tunnels. Everything else in the same
 * client goes to the real network through the browser's fetch and never reaches
 * a host, so a URL that matches neither did not come from a renderer we know.
 *
 * These live here rather than in web/host-protocol.mjs because they are part of
 * one endpoint layer's addressing, not part of the shared message vocabulary --
 * no other module needs to spell them. If a second module ever does, they
 * should move.
 */
export const FETCH_URL_PREFIX = 'vscode://codex/';
export const DICTATION_STREAM_URL = '/codex/dictation-stream-connect-info';

/**
 * The endpoint names the production desktop app is known to use, from two
 * independent readings: a scan of host-fetch call sites across the renderer
 * chunks, and the keys of the main process's own endpoint dispatch object.
 *
 * It started as the first reading alone, and the hazard its own comment named
 * came true. A chunk-local alias the scan did not recognise hides an endpoint,
 * and three of the four endpoints measured for the shape table below --
 * `ambient-suggestions`, `external-agent-import-status` and
 * `global-dictation-hotkey-state` -- were endpoints the shipped renderer
 * demonstrably requests and this list did not contain. The diagnostics were
 * reporting them as names nobody had ever seen.
 *
 * The producer is the better source: the main process dispatches by name from
 * one object literal, so every key in it is an endpoint the real host serves,
 * where a call-site scan is a sample. Reading it added 45 names (each confirmed
 * bound to a function first; `claude-cowork`, a provider-adapter map key, was
 * excluded). The 19 names here that are absent from that object are the git and
 * GitHub endpoints, dispatched from separate tables -- so neither reading is
 * complete on its own and this is the union of both.
 *
 * This list still routes nothing. The default branch does that, and it has to,
 * because the next app build may add a name neither reading could have seen. It
 * exists so that the diagnostics can tell "an endpoint we know about and have
 * not implemented" apart from "a name nobody has ever seen", which are
 * different problems with the same symptom.
 */
export const KNOWN_ENDPOINTS = Object.freeze([
  'account-info',
  'add-context-file',
  'ambient-suggestion-set-status',
  'ambient-suggestions',
  'ambient-suggestions-refresh',
  'app-connect-oauth-callback-url',
  'app-server-connection-state',
  'apply-patch',
  'authorize-remote-control-connections',
  'auto-deny-some-permissions',
  'automation-create',
  'automation-delete',
  'automation-run-archive',
  'automation-run-delete',
  'automation-run-now',
  'automation-update',
  'base-branch',
  'branch-diff-stats',
  'browser-browsing-data-clear',
  'browser-use-approval-mode-write',
  'browser-use-file-transfer-approval-mode-write',
  'browser-use-full-cdp-access-enabled-write',
  'browser-use-history-approval-mode-write',
  'browser-use-origin-state-read',
  'browser-use-session-activity-ended',
  'browser-use-session-route-capture',
  'claude-code-import-status',
  'codex-agents-md',
  'codex-agents-md-save',
  'codex-command-keymap-state',
  'codex-home',
  'compile-latex-artifact',
  'computer-use-frontmost-window',
  'computer-use-native-desktop-app-icon',
  'computer-use-start-capture',
  'delete-all-archived-threads',
  'delete-archived-thread',
  'delete-feedback-desktop-log-archive',
  'delete-remote-control-environment',
  'developer-instructions',
  'discover-remote-ssh-connections',
  'download-internal-plugins',
  'electron-clone-workspace-repo',
  'email-domain-mail-provider',
  'ensure-directory',
  'external-agent-import-detect',
  'external-agent-import-import',
  'external-agent-import-status',
  'external-agent-imported-connectors',
  'fast-mode-rollout-metrics',
  'feedback-desktop-log-archive',
  'file-diff',
  'find-files',
  'generate-commit-message',
  'generate-commit-pull-request-message',
  'generate-pull-request-message',
  'get-configuration',
  'get-copilot-api-proxy-info',
  'get-global-state',
  'get-setting',
  'get-settings',
  'gh-current-user',
  'gh-pr-board',
  'gh-pr-comment-update',
  'gh-pr-create',
  'gh-pr-for-branch',
  'gh-pr-merge',
  'gh-pr-review-thread-update',
  'gh-pr-search',
  'gh-pr-submit-review',
  'gh-pr-update',
  'gh-user-search',
  'git-checkout-branch',
  'git-create-branch',
  'git-merge-base',
  'git-origins',
  'git-push',
  'global-dictation-hotkey-state',
  'global-dictation-set-hotkey',
  'global-dictation-set-toggle-hotkey',
  'has-custom-cli-executable',
  'home-directory',
  'inbox-items',
  'install-recommended-skill',
  'install-remote-codex',
  'is-copilot-api-available',
  'is-packaged',
  'list-automations',
  'list-pinned-threads',
  'local-custom-agents',
  'local-environment-config',
  'local-environment-config-save',
  'locale-info',
  'mcp-codex-config',
  'native-desktop-app-by-bundle-id',
  'native-desktop-app-icon',
  'native-desktop-apps',
  'node-repl-active-execs-kill',
  'openai-api-key',
  'os-info',
  'paths-exist',
  'persisted-atom-sync-request',
  'pick-file',
  'pick-files',
  'prepare-worktree-snapshot',
  'projectless-thread-cwd',
  'projectless-workspace-root',
  'queued-follow-up-send-lock-acquire',
  'queued-follow-up-send-lock-release',
  'read-file',
  'read-file-binary',
  'read-file-metadata',
  'read-git-file-binary',
  'recommended-skills',
  'refresh-remote-connections',
  'refresh-remote-control-connections',
  'remote-workspace-directory-entries',
  'remove-skill',
  'rename-remote-control-environment',
  'reset-codex-command-keybindings',
  'review-summary',
  'save-codex-managed-remote-ssh-connections',
  'save-file',
  'set-codex-command-keybinding',
  'set-configuration',
  'set-global-state',
  'set-local-remote-control-enabled',
  'set-pinned-threads-order',
  'set-remote-connection-auto-connect',
  'set-remote-control-connections-enabled',
  'set-remote-wsl-connections-enabled',
  'set-setting',
  'set-thread-pinned',
  'set-vs-context',
  'settings-read',
  'settings-write',
  'start-remote-chatgpt-login-port-forward',
  'status-summary',
  'stop-remote-chatgpt-login-port-forward',
  'third-party-notices',
  'upload-local-file-over-sftp',
  'upload-worktree-snapshot',
  'workspace-directory-entries',
  'workspace-root-options',
  'worktree-create-managed',
  'worktree-delete',
  'worktree-set-owner-thread',
  'worktree-shell-environment-config',
  'write-file',
  'wsl-bash-availability',
]);

/**
 * The measured shapes, as factories.
 *
 * Factories rather than frozen literals because these objects leave the module
 * and end up as a react-query cache entry, where the renderer's own reducers
 * spread and rewrite them. Handing the same object to two requests would make
 * one request's cache mutation visible to the other.
 *
 * A Map rather than an object literal for a reason with teeth: a lookup on a
 * plain object answers `constructor` and `__proto__` out of the prototype
 * chain, and `constructor` is a function, so an object-literal table would
 * happily "call the factory" for an endpoint named `constructor` and reply with
 * a brand-new Object -- or throw. The endpoint name comes off a URL, so it is
 * not ours to trust.
 */
const SHAPED_EMPTY = new Map([
  // `{roots}` is read as `e.includes(t)`. Measured: `let{roots:e}=await
  // Wu(`workspace-root-options`,{params:{hostId:m.hostId}}); if(!e.includes(t))`
  ['workspace-root-options', () => ({ roots: [] })],
  // `{origins}` is iterated and indexed. An empty array is a complete answer:
  // `if(e?.hostId==null||r.origins.length===0)return r` short-circuits, and the
  // other readers end in `?.root??null`.
  ['git-origins', () => ({ origins: [] })],
  // `{threadIds}` is indexed and mapped: `let{threadIds:a}=await Wu(...);
  // let o=a.indexOf(e)`. The renderer's own cache seeding agrees on the key --
  // `setQueryData(Sg(`list-pinned-threads`),{threadIds:...})`.
  ['list-pinned-threads', () => ({ threadIds: [] })],
  // The mandatory-nesting case from the header. `nextOffset` is the infinite
  // query's page param (`un(e){let{nextOffset:t}=e;return t}`), where null
  // means "no further pages".
  [
    'inbox-items',
    () => ({
      items: [],
      unreadRunCounts: { total: 0, automationIds: [], unreadRuns: [] },
      nextOffset: null,
    }),
  ],
  // `r.skills` is read without a guard on the refresh path. `error` is read as
  // `h.data?.error??(...)`, so null means "no endpoint-level error".
  ['recommended-skills', () => ({ skills: [], error: null })],
  ['pick-files', () => ({ files: [] })],
  // Measured reader: `{configuredValues:i?.configuredValues==null?void 0:{...},
  // values:{...i?.values,[t.key]:n}}`.
  ['get-settings', () => ({ values: {}, configuredValues: {} })],
  // `(await HW(`get-setting`,{params:{key:e.key}})).value??e.default` -- a null
  // value is how the host says "unset", and the renderer supplies the default.
  ['get-setting', () => ({ value: null })],
  // Same trait, via `bxn(e,t){return xxn(e,t)??tmt(e)}`: a null value falls
  // through to the renderer's own per-key default, so null is correct for every
  // key and this module never needs to know the key vocabulary.
  ['get-global-state', () => ({ value: null })],
  // Superseded by the builtin, which answers the configured root. Kept
  // because `shapedEmptyBody` is exported and is what a caller who
  // replaces the builtin through `handlers` falls back to.
  ['projectless-workspace-root', () => ({ workspaceRoot: null })],
  // Every field is read through optional chaining and `??null` at the measured
  // call sites (`n?.accountId`, `n?.authenticatedUserId`, `n?.plan`, `n?.email`,
  // `t?.platform`), so the nulls here are a shape rather than a claim. What
  // makes them harmless is upstream: the access gate returns `{status:
  // `allowed`,accountId:null}` outright for any `authMethod` that is not
  // `chatgpt` or `chatgptAuthTokens`, and never reads `plan` on that branch.
  [
    'account-info',
    () => ({
      accountId: null,
      authenticatedUserId: null,
      email: null,
      plan: null,
      platform: null,
    }),
  ],

  // The five below were measured the hard way: the real bundle was driven to
  // first paint, and every one of these is an endpoint it requested during
  // startup that this table had no name for. Until it did, each answered `{}`.

  // The one that actually took the page down. `rHr` reads
  // `t?.bindings.filter(e=>e.command===...)` -- optional chaining on the
  // container, a bare property access on the field -- over an atom built as
  // `{...t,primaryNumberShortcutTarget:void 0}`. That makes `{}` the single
  // worst answer available: non-null, so the guard passes, with no `bindings`,
  // which is what the guard was there for. The renderer's own default for this
  // state is the literal `{bindings:[],keymapPath:null,supported:!0}`.
  //
  // `supported` is the one field deliberately not copied across. This host
  // keeps no keymap file -- hence the null path -- and serves no
  // `set-codex-command-keybinding`. Claiming support would put a rebinding
  // control on the shortcuts page whose own `onSuccess` runs
  // `setQueryData(key, response)`, writing that unserved endpoint's `{}`
  // straight back into this atom and reproducing the crash from the far side.
  ['codex-command-keymap-state', () => ({ bindings: [], keymapPath: null, supported: false })],
  // Read as `osInfo.data?.platform` through
  // ``l1(e){return e!=null&&e!==`web`?Tpr(e):wpr()}``, where `web` is the
  // renderer's own sentinel for "not a node platform, sniff the browser" and
  // `wpr()` then reads `navigator.platform`. It is also the only answer that
  // stays correct on a phone: the host is a Mac, but the keyboard the shortcut
  // hints describe belongs to whichever device is holding the page.
  ['os-info', () => ({ platform: 'web' })],
  // Read as `o?.ideLocale` and `o?.systemLocale`, both of which end up in
  // `RG(e){if(!e)return null;...}`. Null is a value that pair is already safe
  // for and it says what is true: this host reports no locale, so the renderer
  // keeps its own default.
  ['locale-info', () => ({ ideLocale: null, systemLocale: null })],
  // ``(await t(`is-copilot-api-available`)).available`` and `e?.available??!1`.
  // False is a fact rather than a placeholder -- there is no Copilot API behind
  // a Claude Code relay.
  ['is-copilot-api-available', () => ({ available: false })],
  // `{items}`, mapped with no guard on the update path
  // (`e==null?e:{items:e.items.map(...)}`): the inbox-items trait again, where
  // the container is checked and the field is not.
  ['list-automations', () => ({ items: [] })],

  // The seven below came from a later drive of the same real chain: each was
  // requested, each landed on `{}`, and each shape was then read back out of
  // the bundle before it was written here. Two of them are the reason that
  // second step is not optional -- they are endpoints where `null` is the
  // measured answer and `{}` is the dangerous one, which is the opposite of
  // every entry above.

  // `null` is what the production main process itself answers:
  // ``"get-copilot-api-proxy-info":async()=>null`` (main-C3nRcJ3D.js@1378233),
  // sitting beside the ``"is-copilot-api-available":async()=>({available:!1})``
  // this table already mirrors. The renderer tunnels the whole body as the
  // value -- ``fetchProxyConfig:()=>r(`get-copilot-api-proxy-info`)``
  // (app-shared-59042e7300f7.js@3619723) -- and the thread-config builder reads
  // it as
  //
  //   let l={},u=await n(),d;
  //   if(u!=null){d=zN;let{baseUrl:e,secret:t}=u;l.model_provider=zN,
  //     l[`model_providers.${zN}`]={name:BEt,base_url:e,
  //     experimental_bearer_token:t,wire_api:`responses`}}else d=null
  //
  // (app-shared-59042e7300f7.js@1974689). The else-arm is the branch written
  // for a host with no Copilot proxy. `{}` clears the `u!=null` guard and
  // registers a model provider whose `base_url` is undefined into the config
  // every turn is started with: the page would look correct and the turn would
  // be aimed at nothing.
  ['get-copilot-api-proxy-info', () => null],
  // The only endpoint here where `{}` and `null` are equally fatal, because
  // two different call sites read straight through the container into the
  // field. The side-chat path destructures the body and then calls a string
  // method on it:
  //
  //   let[c,{instructions:l}]=await Promise.all([YNe(e,t),
  //     Wu(`developer-instructions`,{params:{cwd:r,hostId:i,...}})]),
  //   ...developerInstructions:l.trim()?`${l}\n\n${Ifs}`:Ifs
  //
  // (app-initial-60d038a052d7.js@8600897), and the thread-config builder does
  // `o.developerInstructions=i.instructions` on the awaited result
  // (app-shared-59042e7300f7.js@2838387). The empty string is what makes
  // `l.trim()` falsy and sends both sites down their "no extra instructions"
  // arm, and it is the type the real host answers with
  // (``{instructions:await this.getProjectAwareDeveloperInstructions({...})}``,
  // main-C3nRcJ3D.js@1372354). It is also true rather than convenient: this
  // host reads no AGENTS.md and assembles no desktop context section, so there
  // are no project instructions to send.
  ['developer-instructions', () => ({ instructions: '' })],
  // `existingPaths` is a FILTERED SUBSET of the paths the caller sent, in the
  // caller's own spelling. That correlation is only visible on the producing
  // side:
  //
  //   "paths-exist":async({hostId:e,paths:t})=>{...let i=t??[],a=lr(i,r),
  //     o=new Set(await m.Ea(a,n));
  //     return{existingPaths:i.filter((e,t)=>o.has(a[t]??``))}}
  //
  // (main-C3nRcJ3D.js@1375609), so it is neither a map keyed by path nor a
  // parallel array of booleans, and `[]` means "none of the paths you asked
  // about exist". That is the fact here, not a convenience: this module has no
  // filesystem, which is why `read-file` refuses. It is also the SAFE
  // direction, which is the part worth being exact about, because the first
  // version of this comment said `/init` was "the one caller that acts on the
  // answer" and that was never measured. There are five, and all five fail
  // closed on `[]` rather than open:
  //
  //   /init                  app-primary-c9f7ac16cee9.js@1048682
  //                          ``if(t.some(t=>rn(t)===rn(e)))`` -- skips the
  //                          "already initialised" path, so the user action
  //                          proceeds instead of being silently cancelled.
  //   page artifact open     open-6612b70a448e.js@1867
  //                          ``if(!v.some(e=>m(e,g)))throw Error(`Page
  //                          artifact file is unavailable`)``
  //   image preview restore  restore-fa6d43a7e7c3.js@3497
  //                          ``.existingPaths.includes(n)&&R(e,t)`` -> false
  //   artifact tab render    app-initial-60d038a052d7.js@7755757
  //                          ``?.existingPaths.includes(i.params.path)`` -> null
  //   local-thread restore   app-initial-60d038a052d7.js@5414019
  //                          ``.existingPaths.includes(t)`` -> false
  //
  // (The two app-initial sites read through `Fsa`, which is this endpoint:
  // ``Fsa=Vge(q,`paths-exist`,...)`` at app-initial@5392578.) Four more sites
  // read the field without acting on it -- app-initial@2311934, @8629988,
  // local-conversation-thread@254164, local-conversation-turn@72613.
  //
  // So `[]` is not free, and the differences it produces are listed in the
  // module header rather than hidden here: a page artifact will not open, an
  // image preview tab will not restore, and file artifacts drop out of turns.
  // Every one of those is the truth about a host with no filesystem, told by
  // the renderer's own absent-branch. Claiming existence instead would make
  // all five act on a file that is not there.
  //
  // The array is mandatory rather than tidy. The review file tree reads
  // `new Set(s?.existingPaths.map(an)??[])`
  // (review-file-tree-pane-86f41c3f14f9.js@34087) -- optional chaining on the
  // container, a bare `.map` on the field, the inbox-items trait again.
  ['paths-exist', () => ({ existingPaths: [] })],
  // Two unguarded reads in series, which is what makes `{}` a render-time
  // throw rather than an empty list. The query's own `select` is
  // ``function sTn(e){return{roles:e.agents}}``
  // (app-shared-59042e7300f7.js@3475121, directly after the
  // ``uxn(`local-custom-agents`,p)`` it selects for), and the agents list then
  // reads that selected value as `_e?.roles.filter(e=>!ye.has(e.roleName))??[]`
  // (app-initial-60d038a052d7.js@10227214; `sXe` there is this same hook --
  // app-shared exports `oTn as wTt` and app-initial imports `wTt as sXe`). `{}`
  // makes the selector produce `{roles:undefined}`, which the `?.` on the
  // container cannot save.
  //
  // `{agents:[]}` is also what the real host answers when it finds nothing:
  // ``"local-custom-agents":async({roots:e})=>m.Ta({roots:e??[],...})``
  // (main-C3nRcJ3D.js@1366752) ends in
  // ``{agents:Array.from(c.values()).sort(...)}`` (bootstrap-yYZ8rgHq.js@84958)
  // over the roles parsed out of each root's `.codex` directory -- none here,
  // since this host reads no directories.
  ['local-custom-agents', () => ({ agents: [] })],
  // The field is mandatory and its value is deliberately null -- the one place
  // in this batch where the shape proposed to me was changed. `.config` is read
  // off the body with nothing in front of it,
  // ``readCodexConfig:async e=>n===`local`?(await r(`mcp-codex-config`,
  // {params:{cwd:e}})).config:null`` (app-shared-59042e7300f7.js@3620001), so
  // the key has to exist. The value's only consumer is
  // `if(a){let e=await a();if(e)for(let[t,n]of Object.entries(e))l[t]=n}`
  // (app-shared-59042e7300f7.js@1974689), where null and `{}` contribute the
  // same nothing.
  //
  // Null breaks the tie because it is the renderer's own value for "this host
  // contributes no codex config": the ternary above answers a bare null for
  // every non-local host, as do ``buildThreadCodexConfig(e){return
  // this.params.hostId===`local`?this.params.configuration.readCodexConfig(e)
  // :null}`` (app-shared-59042e7300f7.js@3042441) and the main process's
  // ``readCodexConfig:t=>e===`local`?c.buildMcpCodexConfig(t):
  // Promise.resolve(null)`` (main-C3nRcJ3D.js@712198). Every consumer of this
  // value is therefore null-safe by construction, which is a stronger
  // guarantee than the single `if(e)` I could measure. The same row was
  // derived a second time, independently, from the other end: the value is
  // handed to the new-conversation params builder, where present-as-null and
  // absent are different bytes on the wire to the app server, and `undefined`
  // is a value this pipeline otherwise never produces. `{}` would also be a
  // claim: the real ``{config:await this.buildMcpCodexConfig(e)}``
  // (main-C3nRcJ3D.js@1380266) is an enumeration of the desktop MCP servers,
  // artifact session and worktree tools that this host does not run, so
  // "enumerated, found none" is not something it is in a position to say.
  ['mcp-codex-config', () => ({ config: null })],
  // Taken from the producer verbatim: ``return e==null?{available:!1,
  // distro:null}:new Promise(...)`` is what the real host answers when there is
  // no eligible distribution (application-network-startup-DN7Ktmlk.js@56366),
  // and that is this host's permanent situation -- it is a Mac serving a phone.
  // `available` is the read with no slack in it:
  //
  //   let n;try{n=await gt(`wsl-bash-availability`)}catch{o({distro:null});
  //     return}
  //   if(!n.available){o({distro:n.distro});return}
  //
  // (general-settings-658418b16f6c.js@125393) puts `n.available` OUTSIDE the
  // try, so a null body is an unhandled TypeError in a click handler rather
  // than the caught failure beside it. `distro` is then rendered as
  // `a.distro??<this WSL distribution>`
  // (general-settings-658418b16f6c.js@124704) and tested as `r?.distro!=null`
  // (app-initial-60d038a052d7.js@4044314), so null is the value both of its
  // readers already branch on.
  ['wsl-bash-availability', () => ({ available: false, distro: null })],
  // The second null, and the one where `{}` does the most visible damage:
  //
  //   try{let e=await jf(`fast-mode-rollout-metrics`,{params:{startTimeMs:
  //     Date.now()-CBe,maxRollouts:wBe}});if(l||e==null)return;
  //     n.set(BP,{estimatedSavedMs:e.estimatedSavedMs,
  //       rolloutCountWithCompletedTurns:e.rolloutCountWithCompletedTurns,
  //       computedAtMs:Date.now()}),a.failedAtMs=null}catch{...}
  //
  // (app-primary-c9f7ac16cee9.js@211701). `e==null` is an explicit absent
  // branch that leaves the atom unwritten, and the banner reading that atom
  // then stops at `c==null`. `{}` passes `e==null`, stores
  // `estimatedSavedMs:undefined`, and the banner's remaining guards are
  // NUMERIC: ``if(!e||r||c==null||c.rolloutCountWithCompletedTurns<1||
  // c.estimatedSavedMs<SBe){g=null;...}`` (@212172) -- `undefined<1` and
  // `undefined<SBe` are both false, so neither trips and the page renders a
  // personalised "saved NaN hours NaN minutes across undefined threads".
  //
  // The real producer answers a zero-filled record rather than null when it
  // finds no sessions directory -- ``let n=LV(t),r=(0,g.join)(e.codexHome,MV);
  // if(!(0,m.existsSync)(r))return n`` (bootstrap-yYZ8rgHq.js@1649150, over the
  // all-zero record built at @1646121) -- and that record would render nothing
  // too. It is not served because each of its
  // fourteen zeroes is a measurement this host never took; null says there are
  // no rollouts to report, which is what is true.
  ['fast-mode-rollout-metrics', () => null],

  // The four below came from a census of a running session rather than from
  // startup: each had been answering with the blank, each was reported with
  // `shaped: false`, and that field is what made them findable. Every shape is
  // copied from the production host's own absent-answer -- for three of them
  // the main process ships a literal written for exactly this case, a host
  // that cannot do the thing being asked about. One of the four was not a
  // missing value at all but a crash waiting for a tap.

  // The renderer's own fallback, taken from the only call site:
  // ``let D=L_e(`external-agent-import-status`,E).data??yHs`` followed by
  // `D.latestImportedAtMs` (app-initial-60d038a052d7.js@9203389), over
  // ``yHs={importedSessionCount:0,latestImportedAtMs:null}`` (@9218517). The
  // real host delegates to an importer service this relay has none of
  // (``"external-agent-import-status":t=>e.getStatus(t)``,
  // main-C3nRcJ3D.js@1165195), so there is no status to report -- and when a
  // renderer names its own shape for an absent answer, that shape is the one
  // answer guaranteed to be read the way an absent answer was meant to be.
  // The query is `enabled: d==='settings'`, so this is reached by opening
  // settings rather than by first paint.
  ['external-agent-import-status', () => ({ importedSessionCount: 0, latestImportedAtMs: null })],
  // Its sibling, and the only unshaped endpoint the shipped renderer was
  // measured actually requesting -- the static census counts 123 that answer a
  // bare `{}`, but a census of what is never asked for is not a gap. A real
  // drive of the mounted renderer requested eight, of which this was the one
  // with no shape.
  //
  // Two consumers, and only one of them survives `{}`. The foreground reader is
  // fully defended -- `E?.items??eQi` and `E?.unsupportedProjects??tQi`
  // (app-initial-60d038a052d7.js@4996068) -- but the background sync path does
  // ``let{items:a}=await NZi(...)`` and then `a.filter(...)` straight after
  // (@9106924), which on a bare `{}` destructures `undefined` and throws. That
  // it has never been seen to throw is a fact about its caller having a
  // rejection handler, not about the call being safe.
  //
  // The literal is the renderer's own module-level empty for this query,
  // ``JZi={items:[],unsupportedProjects:[]}`` (@4994712) -- the same rule as
  // the entry above: when a renderer writes down what absent looks like, that
  // is the shape guaranteed to be read as absent rather than as a crash.
  ['external-agent-import-detect', () => ({ items: [], unsupportedProjects: [] })],
  // Null is what the host itself answers for a cwd that is not a worktree
  // repository: ``p=Z({shellEnvironment:t==null?null:await kTe(t,i.signal)})``
  // in the git worker (worker.js@1971613), reached through
  // ``"worktree-shell-environment-config":({cwd:e,hostId:t,signal:n})=>
  // this.readWorktreeShellEnvironment(e,t??`local`,n)``
  // (main-C3nRcJ3D.js@1380319). This host runs no git worker, so it is true
  // here for a stronger reason than it is there.
  //
  // This row is the quietest of the four and the one that was costing the most
  // noise. The consumer destructures the field and guards it --
  // ``async function ven(e,t,n,r,i){try{let{shellEnvironment:t}=await n();
  // if(t==null)return e;...}catch(n){return i.warning(`Failed to apply
  // worktree shell environment config`,{safe:{},sensitive:{cwd:t,error:n}}),e}}``
  // (app-shared-59042e7300f7.js@2802811) -- and the whole body is wrapped in a
  // try/catch that returns the unmodified start config. So the 501 was already
  // survivable, which is why turns worked; it just logged a failure at every
  // turn start on a worktree. A measured null takes the `t==null` arm, which is
  // the branch that was written for a host with no shell environment to apply.
  ['worktree-shell-environment-config', () => ({ shellEnvironment: null })],
  // The production main process ships this exact literal as the state of a
  // platform that cannot register a global hotkey:
  //
  //   wL={supported:!1,configuredHotkey:null,configuredToggleHotkey:null},
  //   TL={getState:()=>wL,setHotkey:()=>({success:!1,error:`Not supported.`,
  //     state:wL}),setToggleHotkey:()=>({success:!1,error:`Not supported.`,
  //     state:wL}),syncCommandKeybindings:()=>void 0}
  //
  // (main-C3nRcJ3D.js@1351343) -- the stand-in for the real controller that
  // ``"global-dictation-hotkey-state":async()=>
  // this.globalDictationHotkeyController.getState()`` (@1362952) would reach.
  // A browser tab is that platform, so this is a copy rather than a guess.
  //
  // `supported` is read, and read strictly. The first-use nudge is gated on
  // ``function yFi({hotkeyState:e,isGlobalDictationEnabled:t,nudgeState:n}){
  // return t&&n===`eligible`&&e?.supported===!0}``
  // (app-initial-60d038a052d7.js@4694207, imported into app-primary as `QAe`
  // and returning `null` from the component when false). Because it tests
  // `===!0`, the two nulls on their own would have suppressed the nudge just as
  // well -- an absent field is not `true` either. `supported:false` is here to
  // say it rather than to rely on that, which matters because this host serves
  // no `global-dictation-set-hotkey` for the nudge to call: the renderer's own
  // reader of the hotkey pair is fully optional-chained
  // (``hBe(e){return e?.configuredHotkey==null?e?.configuredToggleHotkey==null?
  // null:{hotkey:e.configuredToggleHotkey,mode:`toggle`}:
  // {hotkey:e.configuredHotkey,mode:`hold`}}``,
  // app-primary-c9f7ac16cee9.js@207546), so nothing downstream would have
  // complained about the omission.
  [
    'global-dictation-hotkey-state',
    () => ({ supported: false, configuredHotkey: null, configuredToggleHotkey: null }),
  ],
  // The one row in this group where the blank was not a missing value but a
  // crash waiting for a tap, which is why no amount of driving to first paint
  // would have found it.
  //
  // Three readers share this query and two are safe. The readiness atom treats
  // a failure as settled (``R=r(u,(e,{get:t})=>{let n=t(N,e);
  // return n.data!=null||n.isError})``) and the suggestion selector defaults
  // both arguments (``z=r(u,({domain:e,hostId:t,projectRoot:n},{get:r})=>{
  // let i=r(N,{domain:e,hostId:t,projectRoot:n}).data?.file;
  // return D(i?.currentSuggestionIds??[],i?.suggestions??[])})``). The third is
  // the optimistic update behind accepting or dismissing a suggestion:
  //
  //   function b(e,t,n,r){e.query.snapshot(N,t).setData(e=>e==null?e:
  //     {file:{...e.file,suggestions:e.file.suggestions.map(e=>
  //       e.id===n?{...e,status:r}:e)}})}
  //
  // (all three in new-chat-suggestion-source-debug-state-399c302a5808.js, whose
  // name undersells it -- home-ambient-suggestions-content-337c7cd61e3c.js@2334
  // imports `b` as `Zn` and runs it from the `ambient-suggestion-set-status`
  // mutation's `onMutate`). The guard is on the body and `e.file.suggestions`
  // is not: the inbox-items trait again, reached this time by a user tapping a
  // suggestion on the home page.
  //
  // The shape is the host's empty file by name. ``"ambient-suggestions":
  // async({domain:e,hostId:t,projectRoot:n})=>{if(!yi(this.getSettingsStore()))
  // return{file:r.oa};let i=await this.getAmbientSuggestionsProjectRoot(n);
  // return i.projectRoot==null?{file:r.oa}:{file:m.ga(t,i.projectRoot,e)}}``
  // (main-C3nRcJ3D.js@1370997) answers `r.oa` on both of its absent branches,
  // and `oa` is
  // ``ur={projectRoot:``,generatedAtMs:null,currentSuggestionIds:[],
  // suggestions:[]}`` (src-CiqPSNHo.js@29170, bound by
  // ``Object.defineProperty(exports,`oa`,{...get:function(){return ur}})``
  // at @187577). That is also the complete field list of the schema beside it
  // (``lr=t.O({projectRoot:t.N().default(``),generatedAtMs:t.D().nullable(),
  // currentSuggestionIds:t.h(t.N()),suggestions:t.h(cr)})``), so nothing is
  // left for a reader to miss. It is what the real host sends when the feature
  // is off; this host generates no suggestions, so it is off.
  [
    'ambient-suggestions',
    () => ({
      file: { projectRoot: '', generatedAtMs: null, currentSuggestionIds: [], suggestions: [] },
    }),
  ],
]);

/**
 * The reply body for an endpoint with no handler behind it.
 *
 * `{}` for anything not in the table: the renderer's readers see undefined,
 * which is the value they already branch on, and the endpoint shows up in
 * `stats().unknown` instead of being papered over.
 *
 * That reasoning holds for a reader that destructures a field and branches on
 * it. It fails for a reader that branches on the container, because `{}` is a
 * present answer with a missing field -- the one shape a `t == null` guard
 * does not cover. Measured against the real bundle, an unknown endpoint
 * feeding a react-query atom took the whole page to its error boundary.
 *
 * `{}` stays the fallback anyway: rejecting would break the many endpoints
 * whose result the renderer ignores, and inventing a shape is worse than an
 * honest blank. What changes is where the work goes -- an endpoint the real UI
 * reaches during startup belongs in the table above, and
 * `endpoint-unimplemented` is the event that says one is still missing.
 *
 * Two measured shapes are `null` rather than an object, which is the opposite
 * correction from every other row: `get-copilot-api-proxy-info` and
 * `fast-mode-rollout-metrics` are read behind explicit `!=null` guards whose
 * absent arm is the one this host wants, and there `{}` is the shape that
 * clears the guard and feeds undefined into a model provider and a banner. So
 * this function's return is not always an object, and a caller treating it as
 * one is reading a guarantee that was never here.
 */
export function shapedEmptyBody(endpoint) {
  const make = SHAPED_EMPTY.get(endpoint);
  return make ? make() : {};
}

/**
 * An endpoint that answered with an HTTP status rather than a value.
 *
 * Thrown by a handler, this becomes a success envelope with that status, which
 * the renderer turns into a rejection whose message is the stringified body.
 * That is the measured HTTP path, so it settles cleanly and reports a real
 * status; a plain Error becomes the `error` envelope instead, which is for
 * "there was no HTTP answer to report".
 */
export class FetchEndpointError extends Error {
  constructor(message, { status = 500, body = null } = {}) {
    super(message);
    this.name = 'FetchEndpointError';
    this.status = status;
    this.body = body;
  }
}

/**
 * The default store: coherent for one page load, gone on reload.
 *
 * It clones on the way in and on the way out, which an in-memory Map does not
 * need to do and a real backing store cannot avoid. Handing back live
 * references would let this module pass against the default store and fail
 * against the serialising one it is meant to be swapped for -- the stored value
 * would appear to track a caller's later mutations.
 *
 * @param {Record<string, unknown>} [initial]
 */
export function createMemoryStore(initial = {}) {
  const data = new Map(Object.entries(initial).map(([key, value]) => [key, structuredClone(value)]));
  return {
    async get(key) {
      return data.has(key) ? structuredClone(data.get(key)) : undefined;
    },
    async set(key, value) {
      data.set(key, structuredClone(value));
    },
  };
}

/** Global state and settings are independent key spaces; keep them apart. */
const GLOBAL_STATE_PREFIX = 'global-state:';
/**
 * Exported, alone among the three, because the assembler seeds defaults into it
 * before the renderer's first `get-settings`. It has to write the same key this
 * module reads, and seeding through a caller-supplied `get-settings` handler is
 * not an option: a caller handler REPLACES the built-in, which would take the
 * `set-setting` read-modify-write below out of the loop and make every change
 * the user then made on the settings screen vanish on reload.
 */
export const SETTINGS_KEY = 'settings';
const PINNED_THREAD_IDS_KEY = 'pinned-thread-ids';

/**
 * Parse the endpoint name out of a tunnelled URL.
 *
 * Done by prefix-strip rather than with the URL constructor, because the
 * renderer builds the string by interpolating a name into a template and never
 * parses it back; a parser here that normalised the path differently than that
 * template produced it would route a name that was never sent. The dictation
 * URL is returned as its own name so that it goes through the same routing
 * table as everything else -- it is tunnelled too, and the cardinal rule has no
 * exceptions.
 *
 * @returns {string | null} null when this is not a URL the renderer tunnels
 */
export function parseFetchUrl(url) {
  if (typeof url !== 'string') return null;
  if (url === DICTATION_STREAM_URL) return DICTATION_STREAM_URL;
  if (!url.startsWith(FETCH_URL_PREFIX)) return null;
  const rest = url.slice(FETCH_URL_PREFIX.length);
  const cut = rest.search(/[?#]/);
  const endpoint = cut === -1 ? rest : rest.slice(0, cut);
  return endpoint === '' ? null : endpoint;
}

/**
 * Stand up the fetch endpoint layer.
 *
 * @param {object} options
 * @param {(message: object) => unknown} options.deliver how a built inbound
 *   message reaches the renderer. Required, and refused when missing: a fetch
 *   layer with no way to answer is precisely the permanent spinner this module
 *   exists to prevent, and the mistake is cheaper to find at construction than
 *   in a UI that never finishes loading. web/host-bus.mjs has no generic
 *   deliver and no emitFetchResponse, so the wiring passes one in.
 * @param {Record<string, (params: unknown, context: object) => unknown>} [options.handlers]
 *   caller-supplied endpoints. These win over the built-ins, so a real file
 *   reader or git bridge can be dropped in without editing this module.
 * @param {{get: (key: string) => Promise<unknown>, set: (key: string, value: unknown) => Promise<void>}} [options.store]
 *   where global state and settings live. Defaults to memory.
 * @param {string | null} [options.codexHome]
 * @param {string | null} [options.workspacesRoot]
 * @param {string | null} [options.worktreesSegment]
 * @param {string[]} [options.workspaceRoots]
 * @param {string | null} [options.projectlessRoot] where a thread runs when
 *   the user has selected no project. Defaults to null, which answers the
 *   projectless endpoints the way a host with no such directory must.
 * @param {object | null} [options.accountInfo]
 * @param {((event: {kind: string, [k: string]: unknown}) => void) | null} [options.onEvent]
 */
export function createHostFetch({
  deliver,
  files = null,
  handlers = {},
  store = createMemoryStore(),
  codexHome = null,
  workspacesRoot = null,
  worktreesSegment = null,
  workspaceRoots = [],
  projectlessRoot = null,
  accountInfo = null,
  onEvent = null,
} = {}) {
  if (typeof deliver !== 'function') {
    throw new TypeError('createHostFetch: a deliver function is required');
  }

  /**
   * The injected filesystem, or a 501 naming the endpoint that wanted it.
   *
   * `files` is null whenever the link to the resident machine failed, and the
   * four file endpoints are the only things in here that need it. A refusal
   * per endpoint keeps the rest of this surface working on a page whose link
   * is down, which is most of what the first paint asks for.
   */
  const requireFiles = (endpoint) => {
    if (files == null) {
      throw new FetchEndpointError('this host has no file reader', {
        status: 501,
        body: { error: `${endpoint} requires a host file reader` },
      });
    }
    return files;
  };

  /**
   * An absolute path, or a 501 rather than a read of the wrong file.
   *
   * The same argument as `workspaceFiles.read`: the App re-roots a relative
   * path onto a workspace root, and this host has none, so passing one through
   * means the ADAPTER resolves it against its own working directory and
   * answers with a real file nobody asked for.
   */
  const requirePath = (params, endpoint) => {
    const path = params?.path;
    if (typeof path !== 'string' || path === '') {
      throw new FetchEndpointError(`${endpoint} needs a path`, {
        status: 501,
        body: { error: `${endpoint} requires a path` },
      });
    }
    if (!/^[\\/]|^[A-Za-z]:[\\/]|^\\\\/.test(path)) {
      throw new FetchEndpointError(`${endpoint} needs an absolute path`, {
        status: 501,
        body: { error: `${endpoint} does not re-root a relative path: ${path}` },
      });
    }
    return path;
  };

  /** The host of a URL, for the log only -- never the path or the query. */
  const hostnameOf = (url) => {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  };

  const stats = {
    received: 0,
    answered: 0,
    succeeded: 0,
    rejected: 0,
    failed: 0,
    unanswerable: 0,
    unknown: 0,
    cancelled: 0,
    cancelMissed: 0,
    dropped: 0,
  };

  /** Request ids we still owe an answer for. Membership is the only state. */
  const inFlight = new Set();

  const report = (kind, detail) => {
    if (typeof onEvent !== 'function') return;
    try {
      onEvent({ kind, ...detail });
    } catch {
      // An observer that throws must not take a request down with it, and must
      // not turn a diagnostic into the unanswered fetch we are here to avoid.
    }
  };

  /**
   * Deliver at most one reply per request id.
   *
   * Every exit path goes through here, so cancellation and double-settle are
   * handled in one place: an id that is no longer in flight was either
   * cancelled or already answered, and in both cases the renderer's pending
   * table has nothing to match, which makes a second reply wasted rather than
   * wrong.
   */
  const settle = (requestId, message, counter) => {
    if (!inFlight.has(requestId)) {
      stats.dropped += 1;
      report('reply-dropped', { requestId });
      return false;
    }
    inFlight.delete(requestId);
    stats.answered += 1;
    stats[counter] += 1;
    try {
      deliver(message);
    } catch (err) {
      // The window is gone, or the bus was stopped. Nothing can be done from
      // inside a request, and throwing would propagate into a bus listener
      // where nobody is catching -- so it is named and counted instead.
      report('deliver-failed', { requestId, message: err?.message ?? String(err) });
    }
    return true;
  };

  const settleSuccess = (requestId, status, body) =>
    settle(
      requestId,
      inboundFetchResponseSuccess({ requestId, status, headers: {}, body }),
      status >= 200 && status < 300 ? 'succeeded' : 'rejected',
    );

  const settleError = (requestId, error, status) =>
    settle(requestId, inboundFetchResponseError({ requestId, error, status }), 'failed');

  // ---- the built-in endpoints ---------------------------------------------

  const globalStateKey = (key) => `${GLOBAL_STATE_PREFIX}${String(key)}`;

  const readSettings = async () => {
    const stored = await store.get(SETTINGS_KEY);
    return stored && typeof stored === 'object' ? stored : {};
  };

  const builtins = new Map([
    [
      'get-global-state',
      async (params) => ({ value: (await store.get(globalStateKey(params?.key))) ?? null }),
    ],
    [
      'set-global-state',
      async (params) => {
        // `{success:false}` is a measured channel, not a fallback. The renderer
        // reads it two ways -- `if(!(await r(`set-global-state`,...)).success)
        // throw Error(`Failed to persist global state`)` on the
        // read-modify-write path, and `if(!e){...i.setData(e=>e===o?a:e)}` on
        // the optimistic path, which rolls its cache back. A store failure
        // reported through this field therefore produces a clean rollback,
        // while the same failure reported as a rejected fetch leaves the
        // optimistic value on screen.
        try {
          await store.set(globalStateKey(params?.key), params?.value ?? null);
          return { success: true };
        } catch (err) {
          report('store-write-failed', {
            endpoint: 'set-global-state',
            key: params?.key,
            message: err?.message ?? String(err),
          });
          return { success: false };
        }
      },
    ],
    [
      'get-settings',
      async () => {
        // `configuredValues` is deliberately left empty rather than mirroring
        // `values`. What the renderer does with it is read as "this setting
        // came from config.toml rather than from a default", which is a claim
        // we cannot make about a value the user set through this host -- and
        // the measured reader treats an absent map as "nothing is configured"
        // (`i?.configuredValues==null?void 0:{...}`) rather than as an error.
        // This reading is inferred from the field name and its one reader, not
        // measured against a real config.
        return { values: await readSettings(), configuredValues: {} };
      },
    ],
    [
      'get-setting',
      async (params) => {
        const values = await readSettings();
        const key = String(params?.key);
        return { value: Object.hasOwn(values, key) ? values[key] : null };
      },
    ],
    [
      'set-setting',
      async (params) => {
        // The renderer awaits this and ignores the result, so the shape is
        // free; what is not free is the write, since `get-settings` is what
        // repaints the settings surface afterwards. Read-modify-write on one
        // stored object keeps the store contract at get/set, with no key
        // enumeration for an injected store to have to implement.
        const values = await readSettings();
        values[String(params?.key)] = params?.value ?? null;
        await store.set(SETTINGS_KEY, values);
        return {};
      },
    ],
    [
      'workspace-root-options',
      async () => ({ roots: Array.isArray(workspaceRoots) ? [...workspaceRoots] : [] }),
    ],
    // ---- the projectless pair ---------------------------------------
    //
    // `workspace-root-options` having a root is what opens the startup gate;
    // it is NOT what lets the composer run. A root is a place threads are
    // allowed to live, a project is a selection, and with no project selected
    // the renderer takes its "projectless" path instead -- measured on a real
    // chain, where the app mounted, Send was enabled, and tapping it produced
    // exactly one `config/read` with `cwd:"~"` and no `thread/start` at all.
    //
    // Two endpoints feed that path, and both destructure the reply without a
    // guard:
    //
    //   zwn = BW(Q,`projectless-workspace-root`,{select:({workspaceRoot:e})=>e})
    //   let{cwd:a,outputDirectory:o,workspaceRoot:s}
    //     = await Wu(`projectless-thread-cwd`,{params:{directoryName,hostId,prompt}})
    //
    // and `outputDirectory` is load-bearing rather than decorative:
    //
    //   if(A===`projectless`&&j==null&&D!==`durable`&&!t)
    //     throw Error(`Projectless conversations require an output directory`)
    //
    // so a null there is not a shaped empty, it is the throw.
    [
      'projectless-workspace-root',
      // Null is a complete answer when no projectless root is configured: the
      // `select` arm above hands null to its readers, which is the same thing
      // the shaped-empty table said before this endpoint had a backing value.
      async () => ({ workspaceRoot: projectlessRoot }),
    ],
    [
      'projectless-thread-cwd',
      async () => {
        if (typeof projectlessRoot !== 'string' || projectlessRoot === '') {
          // A refusal, not a shaped empty, for the same reason `codex-home`
          // refuses: the measured destructure is unguarded, so `{}` hands the
          // renderer `cwd: undefined`, which it resolves to `~` and then runs
          // a turn that goes nowhere with nothing on the wire to say why. A
          // 501 settles the promise and names the missing configuration.
          throw new FetchEndpointError('this host has no projectless workspace', {
            status: 501,
            body: { error: 'projectless-thread-cwd requires a projectless root' },
          });
        }
        // `directoryName` and `createSplitDirectories` are deliberately NOT
        // honoured. Desktop generates a fresh directory per projectless thread
        // under the user's Documents/Codex folder -- this module opens no
        // socket and touches no filesystem, so it cannot create one, and
        // naming a directory that does not exist would move the failure from
        // here to `thread/start`, which is further from the cause. A relay
        // runs projectless threads in its configured root instead; that is a
        // real difference from desktop, stated rather than papered over.
        //
        // cwd and outputDirectory are the same directory for the same reason.
        return {
          cwd: projectlessRoot,
          outputDirectory: projectlessRoot,
          workspaceRoot: projectlessRoot,
        };
      },
    ],
    [
      'git-origins',
      async () => {
        // An empty list is the honest answer from a host with no git bridge,
        // and it is a complete one: the measured readers either short-circuit
        // on `origins.length===0` or end in `?.root??null`. The consequence is
        // that every workspace looks non-git until a real origin source is
        // injected through `handlers`, which is a visible missing feature
        // rather than a hang.
        return { origins: [] };
      },
    ],
    [
      'codex-home',
      async () => {
        if (typeof codexHome !== 'string' || codexHome === '') {
          // Not a shaped empty, on purpose. The measured reader runs
          // `ZN(codexHome)` unguarded while building the managed-worktree root
          // list, so a missing or empty path is not "no codex home" -- it is a
          // path prefix that matches everything or nothing, and it would
          // misclassify worktrees silently. A 501 settles the promise and says
          // so. The two call sites that read this without a catch are explicit
          // user actions, not first paint.
          throw new FetchEndpointError('this host was not configured with a codex home', {
            status: 501,
            body: { error: 'codex-home is not configured on this host' },
          });
        }
        return { codexHome, workspacesRoot, worktreesSegment };
      },
    ],
    [
      'read-file',
      async (params) => {
        // There is no filesystem in a browser page and this module opens no
        // socket, so the only honest answers are a real injected reader or a
        // refusal. An empty-string `contents` is not a third option: it is read
        // as a string and measured by length, so it is indistinguishable from
        // an empty file and would render as one.
        const reader = requireFiles('read-file');
        const bytes = await reader.readBytes(requirePath(params, 'read-file'));
        // `contents` is the only field, always a string, never null: 7 of the
        // 14 measured call sites destructure it bare and one of them hands it
        // straight to `JSON.parse`. The App produces it with `Response#text()`
        // on a stream, and TextDecoder matches that including the part nobody
        // writes down -- a leading BOM is stripped by both, because ignoring
        // it is opt-in in each.
        return { contents: new TextDecoder().decode(bytes) };
      },
    ],
    [
      'read-file-metadata',
      async (params) => {
        const reader = requireFiles('read-file-metadata');
        const path = requirePath(params, 'read-file-metadata');
        const sampleLimit = params?.contentSampleByteLimit ?? null;

        // Measured on the real chain, not assumed: the adapter answers
        // `fs/getMetadata` on a missing path with
        // `ENOENT: no such file or directory, stat '<path>'`, and that text
        // crosses JSON-RPC intact. What does NOT cross is any structured
        // signal -- the error arrives as code -32000 with `data: null`, so
        // neither `errorCode` nor `code` is available to the classifier and
        // the message is its only channel. Confirmed again in production
        // conditions: the shipped renderer read
        // `codex-home/attachments/pasted-text-attachments.json`, which does
        // not exist on a fresh host, took the ENOENT back through this
        // endpoint's sibling member and booted to a usable composer with no
        // exception.
        //
        // Deliberately NOT caught. A missing file has to reach the renderer as
        // a rejection whose message says so: one measured consumer decides
        // `exists` by matching the text for `ENOENT`, `No such file or
        // directory` or `(os error 2)`, and anything else makes `exists` null
        // -- which is neither true nor false and is rendered as neither.
        const metadata = await reader.metadata(path, { throwIfMissing: true });
        const isFile = metadata?.isFile === true;

        // The sample is the whole file, which looks wrong and is what the App
        // does over a remote host. Its gate reads
        // `contentSampleMaxFileBytes == null || typeof size !== 'number' ||
        // size <= limit` -- and an app-server or ssh host has no `size` at
        // all, so the middle clause is true and the gate opens regardless of
        // how large the file is. Its own sampler then pulls the bytes through
        // `fs/readFile`, which answers with the entire file in one chunk. So
        // this host's cost here is the cost the App already pays for every
        // remote workspace, and `contentSampleMaxFileBytes` is accepted and
        // then unused by both of us for the same reason.
        const sample = sampleLimit != null && isFile
          ? (await reader.readBytes(path)).subarray(0, sampleLimit)
          : null;
        const contentKind = detectContentKind(sample);

        return {
          // Omitted, not null, when nothing was sampled. One consumer tests
          // `contentKind !== 'text'` and throws `File is not text`, so a null
          // here fails closed on every file -- and this is also how the App
          // spells it, with a conditional spread.
          ...(contentKind == null ? {} : { contentKind }),
          createdAtMs: typeof metadata?.createdAtMs === 'number' && metadata.createdAtMs > 0
            ? metadata.createdAtMs
            : null,
          isFile,
          mtimeMs: typeof metadata?.modifiedAtMs === 'number' ? metadata.modifiedAtMs : null,
          // Null unless a sample was already paid for, because the adapter's
          // `fs/getMetadata` carries no size and the only way to learn one is
          // to transfer the file. Again not a divergence: the App's own
          // remote-host stat wrapper builds its result from
          // `{isDirectory, isFile, isSymlink, createdAtMs, modifiedAtMs}` and
          // has no size field either, so `sizeBytes: null` is exactly what a
          // cloud or ssh workspace reports today and every consumer already
          // guards it with `sizeBytes != null`.
          sizeBytes: sample == null ? null : sample.byteLength,
        };
      },
    ],
    [
      'read-file-binary',
      async (params) => {
        // Decided before anything is required, because neither answer needs a
        // filesystem OR an absolute path: a URL is not a path at all and
        // `requirePath` would reject it as relative, which is how this arm was
        // unreachable until a test went looking for it. A page whose link to
        // the resident machine is down still answers these two correctly,
        // which is also what the App does -- it resolves them without
        // touching the local filesystem, and nulls them when it cannot.
        const requested = typeof params?.path === 'string' ? params.path : '';
        if (requested.startsWith('https://')) {
          report('read-file-binary-url', { host: hostnameOf(requested) });
          return { contentsBase64: null };
        }
        if (params?.hostId === 'durable') {
          report('read-file-binary-durable', { path: requested });
          return { contentsBase64: null };
        }

        const reader = requireFiles('read-file-binary');
        const path = requirePath(params, 'read-file-binary');
        const maxBytes = params?.maxBytes ?? null;

        // Three in-contract ways to say "not available", all of them a null
        // `contentsBase64` rather than a throw, and all three are the App's
        // own answers for the same inputs. Every measured consumer either
        // null-checks this field or throws its own error on it, so null is a
        // value the renderer is built for -- which is what makes answering it
        // better than a 501 the renderer has no path for.
        if (path.startsWith('https://')) {
          // The App resolves exactly one family of URL here, GitHub release
          // assets and user attachments, with a `gh auth token`. This host has
          // no gh and no token, and fetching an arbitrary https URL from the
          // page would send a workspace path to a third party.
          report('read-file-binary-url', { host: hostnameOf(path) });
          return { contentsBase64: null };
        }
        if (params?.hostId === 'durable') {
          // A cloud task's filesystem, reached through an environment id and
          // an app-server extension request. There is no cloud executor behind
          // this relay, and the App returns the same null when it cannot
          // resolve one.
          report('read-file-binary-durable', { path });
          return { contentsBase64: null };
        }

        const bytes = await reader.readBytes(path);
        // Over the limit is null and not an error, which is the opposite of
        // `workspaceFiles.read`'s answer to the same question. Both are
        // transcribed: the App reads `maxBytes + 1` here precisely so that it
        // can detect overflow and return null, while the namespace member
        // throws. Exactly `maxBytes` is allowed by both.
        if (maxBytes != null && bytes.byteLength > maxBytes) {
          report('read-file-binary-over-limit', { maxBytes, bytes: bytes.byteLength });
          return { contentsBase64: null };
        }

        const mimeType = detectMimeType(bytes);
        return {
          contentsBase64: encodeBase64(bytes),
          // Omitted when unrecognised, which includes every plain text file:
          // the App's sniffer here is the magic-byte one with no text
          // fallback, so a `.ts` file has no mime and its one consumer falls
          // back to the extension and then to application/octet-stream.
          ...(mimeType == null ? {} : { mimeType }),
        };
      },
    ],
    [
      'read-git-file-binary',
      async (params) => {
        // Shaped and permanently unavailable, which for this endpoint alone is
        // a CORRECT answer rather than a stub. It is the only one of the four
        // that cannot throw at all in the App: not a worktree, a path that
        // escapes the repository, a non-zero `git show`, an empty blob, any
        // exception in the git worker and any exception crossing the worker
        // boundary all collapse to this same object. Its single consumer --
        // the binary-preview hook -- therefore treats a null as routine and
        // renders no preview, and cannot distinguish this host from a checkout
        // where the file is simply not in `HEAD`.
        //
        // Serving it is still worth more than refusing it: a 501 would reach
        // that hook as `isError`, which it reports to its caller, where the
        // null path is silent. Reading a blob out of git would need `git show`
        // on the resident machine, and the adapter's surface is three fs calls
        // with no process execution -- so this is the honest edge of what the
        // relay can do, not a gap in the wiring.
        report('read-git-file-binary-unavailable', {
          ref: params?.ref ?? null,
          hasCwd: typeof params?.cwd === 'string' && params.cwd !== '',
        });
        return { contentsBase64: null };
      },
    ],
    [
      'list-pinned-threads',
      async () => {
        const stored = await store.get(PINNED_THREAD_IDS_KEY);
        return { threadIds: Array.isArray(stored) ? stored : [] };
      },
    ],
    ['inbox-items', async () => shapedEmptyBody('inbox-items')],
    [
      'account-info',
      async () => (accountInfo == null ? shapedEmptyBody('account-info') : accountInfo),
    ],
  ]);

  /**
   * The route for an endpoint, which always exists.
   *
   * This is the shape of the cardinal rule: there is no miss to forget. The
   * caller's handlers win, then the built-ins, then a function that answers the
   * shaped empty and counts the endpoint as unimplemented.
   *
   * A row in the shape table does NOT take an endpoint out of that count.
   * `endpoint-unimplemented` and `stats().unknown` mean "nothing is routing
   * this, the reply came out of the table or out of the blank" -- which is
   * still a gap, because a measured empty is not a working endpoint. The
   * `known` field is what separates "we have seen this name in the bundle"
   * from "nobody has ever seen it"; the shape table is what keeps the gap from
   * crashing the page while it is still a gap.
   *
   * `shaped` is the field that makes the count readable. A real drive against
   * the shipped renderer reported fourteen unimplemented endpoints, and eight
   * of them were shape-table rows answering with a body measured out of the
   * bundle -- a difference of kind, not of degree, because those eight are
   * already as correct as an empty host can be while the other six are a
   * blank `{}` whose caller was never checked. Both are gaps; only one set is
   * the next thing to do. Two booleans therefore sort the whole list without
   * carrying a single character of text: `known` says whether anyone has seen
   * the name, `shaped` says whether the answer came from the table.
   *
   * `Object.hasOwn` on `handlers` for the same prototype-chain reason the shape
   * table is a Map -- the endpoint name arrives in a URL, and
   * `handlers.constructor` is a function on any plain object.
   */
  const routeFor = (endpoint) => {
    if (handlers && Object.hasOwn(handlers, endpoint) && typeof handlers[endpoint] === 'function') {
      return handlers[endpoint];
    }
    const builtin = builtins.get(endpoint);
    if (builtin) return builtin;
    return () => {
      stats.unknown += 1;
      report('endpoint-unimplemented', {
        endpoint,
        known: KNOWN_ENDPOINTS.includes(endpoint),
        shaped: SHAPED_EMPTY.has(endpoint),
      });
      return shapedEmptyBody(endpoint);
    };
  };

  /**
   * Answer one renderer `fetch`.
   *
   * Returns a promise so that a test can await the reply, and never a rejected
   * one: the bus fans messages out with `listener(message)` and discards the
   * result, so a rejection here would surface as an unhandled rejection rather
   * than as a failed request.
   *
   * Replies land in a later microtask even when the answer is already in hand.
   * That is safe for this type, unlike for `persisted-atom-sync`: the
   * renderer's client subscribes to `fetch-response` in its constructor
   * (~3,273,052), which runs long before any `sendRequest` can be called, so
   * there is no window in which a reply arrives before the subscriber exists.
   */
  async function handle(message) {
    stats.received += 1;

    const requestId = message?.requestId;
    if (typeof requestId !== 'string' || requestId === '') {
      // Nothing to answer. A `fetch-response` the pending table cannot match is
      // indistinguishable from no reply at all, so sending one would only make
      // the diagnostics lie. The renderer always mints a UUID here, so this is
      // a bug in whoever synthesised the message.
      stats.unanswerable += 1;
      report('request-unanswerable', { url: message?.url ?? null });
      return;
    }

    if (inFlight.has(requestId)) {
      // A duplicate id means two requests would share one reply slot. Counting
      // it as unanswerable rather than overwriting keeps the first request's
      // answer intact.
      stats.unanswerable += 1;
      report('request-duplicate', { requestId });
      return;
    }
    inFlight.add(requestId);

    const endpoint = parseFetchUrl(message?.url);
    if (endpoint === null) {
      // The renderer tunnels exactly two URL forms; anything else reached us by
      // mistake and there is no endpoint to answer for. This is the one case
      // that earns the `error` envelope -- there was no HTTP answer to report,
      // only a request we could not address.
      report('url-unroutable', { requestId, url: message?.url ?? null });
      settleError(requestId, `cannot route host fetch url: ${String(message?.url)}`, 400);
      return;
    }

    let params;
    try {
      // The body is `JSON.stringify(params)` at the measured call site, which
      // is undefined when there are no params -- the no-params endpoints
      // (`get-settings`, `git-origins`, `account-info`) all arrive that way.
      params = typeof message.body === 'string' ? JSON.parse(message.body) : undefined;
    } catch (err) {
      // Unreachable from a real renderer, since it produced the string with
      // JSON.stringify. Kept because the alternative to a reply is silence, and
      // guessing at the params of a write endpoint is worse than refusing it.
      report('body-unparseable', { requestId, endpoint, message: err?.message ?? String(err) });
      settleError(requestId, `host fetch body is not JSON: ${endpoint}`, 400);
      return;
    }

    report('request', { requestId, endpoint, method: message?.method ?? null });

    try {
      const body = await routeFor(endpoint)(params, { endpoint, requestId, message });
      // A handler that returns nothing falls back to the shaped empty rather
      // than sending `body:undefined`. The builder would refuse that anyway,
      // but the point is that `{status,headers,body:undefined}` decodes as
      // `JSON.parse(undefined)` in the renderer, which throws inside its own
      // try and rejects -- a handler forgetting a return would present as that
      // endpoint being broken rather than as empty.
      settleSuccess(requestId, 200, body === undefined ? shapedEmptyBody(endpoint) : body);
    } catch (err) {
      if (err instanceof FetchEndpointError) {
        report('endpoint-status', { requestId, endpoint, status: err.status });
        settleSuccess(requestId, err.status, err.body);
        return;
      }
      report('endpoint-threw', { requestId, endpoint, message: err?.message ?? String(err) });
      settleError(requestId, err?.message ?? String(err), 500);
    }
  }

  /**
   * Drop the work for a request and send nothing.
   *
   * `cancel-fetch` is fire and forget: by the time it leaves, the renderer has
   * already removed its own pending entry and rejected locally with an
   * AbortError, so a reply afterwards matches nothing. Removing the id from
   * `inFlight` is what makes the in-progress completion a no-op -- an awaited
   * store read cannot be unwound, so the drop happens where the answer would
   * have been delivered.
   */
  function cancel(requestId) {
    if (typeof requestId === 'string' && inFlight.delete(requestId)) {
      stats.cancelled += 1;
      report('cancelled', { requestId });
      return true;
    }
    stats.cancelMissed += 1;
    report('cancel-unmatched', { requestId: requestId ?? null });
    return false;
  }

  return {
    handle,
    cancel,

    /**
     * Wire both outbound types onto a bus from web/host-bus.mjs.
     *
     * The bus discards a listener's return value, which is why `handle` is
     * allowed to be async here, and it fans each type to its typed handler
     * only, which is why these are two subscriptions rather than one filter.
     *
     * @returns {() => void} unsubscribe from both
     */
    attach(bus) {
      if (!bus || typeof bus.on !== 'function') {
        throw new TypeError('hostFetch.attach: a host bus is required');
      }
      const offFetch = bus.on(OUTBOUND.fetch, handle);
      const offCancel = bus.on(OUTBOUND.cancelFetch, (message) => cancel(message?.requestId));
      return () => {
        offFetch();
        offCancel();
      };
    },

    /** How many requests have not been answered yet. */
    get pending() {
      return inFlight.size;
    },

    /** A copy, so a caller cannot edit the counters it is reading. */
    stats: () => ({ ...stats }),
  };
}
