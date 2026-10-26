// The CLI entry for the surface process. Deliberately thin: everything
// interesting is in server.mjs, which tests drive in-process without ever
// binding a port on the machine that is building it.
//
// Config comes from the environment because this runs under a process manager
// on the resident machine, not from an interactive shell. The one value that
// never gets a convenient default is the relying party: WebAuthn binds a
// credential to an exact origin, and guessing it wrong produces passkeys that
// silently never work.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSurface, createLogger } from './server.mjs';
import { createWsUpstreamFactory } from './upstream.mjs';
import { openArchive } from '../renderer/asar.mjs';
import { BOOT_MODULE_SRC, TOUCH_CSS_HREF, patchIndexHtml } from '../renderer/boot.mjs';
import { Ceremonies } from '../auth/ceremony.mjs';
import { CredentialStore, EphemeralStore } from '../auth/store.mjs';
import { SessionManager } from '../auth/session.mjs';
import { KeyRing, defaultKeyStore } from '../auth/keys.mjs';
import { selectProvider, startProvider } from '../relay/provider.mjs';
import { INGRESS_ENV, resolveIngressConfig } from '../relay/provider-config.mjs';

// Takes `env` rather than reading process.env, because buildSurface's whole
// signature is a promise that configuration is injectable, and this function
// quietly broke that promise: buildSurface({...}) would read the real
// environment anyway. Nothing noticed, because nothing had ever called it with
// an env of its own.
function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

/**
 * Print the enrolment link, or return null if there is nothing to print.
 *
 * A relay with no passkey enrolled cannot do anything at all, and enrolment
 * needs a bootstrap token that only this process can mint: the token store is
 * an EphemeralStore, so it lives in this process's memory and no CLI run beside
 * it could put a token into it. That is why this is printed by the server
 * rather than issued by a separate command -- the comment on
 * issueBootstrapToken has said "the bootstrap CLI renders this as a QR" since
 * it was written, and that CLI could not have worked.
 *
 * The token goes to stderr as plain text rather than through the logger. That
 * is not a privacy claim -- stderr is the logger's sink too, so under a process
 * manager this lands in the journal either way. What contains it is that it
 * expires in ten minutes and is consumed on first successful use; what the
 * plain text buys is only that a log aggregator does not index it as a field.
 *
 * It prints on a first run and otherwise on SIGUSR1, because "whoever can
 * signal this process" is the same authorisation boundary as "whoever can read
 * this terminal", and the alternative -- an HTTP endpoint that mints enrolment
 * tokens -- would be an unauthenticated way to enrol a passkey on somebody
 * else's relay.
 */
export function announceEnrolment({ ceremonies, origin, force = false, write }) {
  const out = write ?? ((text) => process.stderr.write(text));
  if (ceremonies.isEnrolled && !force) return null;
  const token = ceremonies.issueBootstrapToken();
  const headline = ceremonies.isEnrolled
    ? 'A fresh enrolment link, as asked. It authorises one more passkey:'
    : 'No passkey is enrolled on this relay yet. Open this on the device you want to use:';
  const hint = `Single use, and it expires in 10 minutes. kill -USR1 ${process.pid} prints a new one.`;
  out(`\n${headline}\n\n    ${origin}/#enroll=${token}\n\n${hint}\n\n`);
  return token;
}

/**
 * Where the real renderer is served, and where it lives inside the asar.
 *
 * The prefix is a directory of its own rather than `/` because the relay's own
 * login page has to stay reachable: a phone that is not enrolled, or whose
 * session expired, needs somewhere to go that is not the app. `webview` is the
 * directory the Electron app loads its window from, and the rest of the archive
 * -- the main process, the preload, node_modules -- is not ours to serve.
 */
export const RENDERER_MOUNT_PREFIX = '/app/';
export const RENDERER_ARCHIVE_BASE = 'webview';

/**
 * The document root.
 *
 * `web/` and not a configurable default. Every module under it imports its
 * neighbours with a relative specifier and reaches src/appserver by climbing
 * out with `../`, which only lands on the mount below while the directory sits
 * at `/`. test/web/module-resolution.test.mjs pins exactly that, reading the
 * mount out of this file. CODEX_RELAY_STATIC stays as an override for a
 * deployment that serves a built copy, but leaving it unset no longer produces
 * a surface that serves the renderer at /app/ and 404s the host module the
 * renderer needs -- which is the blank-screen failure, since an unanswered
 * fetch or mcp-request has no timeout on the renderer's side.
 */
const DEFAULT_STATIC_ROOT = fileURLToPath(new URL('../../web/', import.meta.url));

/**
 * The Electron app's own version, read out of the archive we are serving.
 *
 * Asked of the archive rather than configured because a configured value is a
 * value that goes stale on the next App update with nothing to notice. It is
 * best-effort: this one feeds Sentry tags and an About box, so a miss costs a
 * label. The version that must never be guessed is the APP SERVER's, and that
 * one is not here -- web/hostlink/link.mjs asks the server during its handshake
 * and refuses anything it cannot compare, because `0.0.0` reads to the renderer
 * as "every version gate passes" and silently turns a steer into a new turn.
 */
export function archiveAppVersion(archive, logger = null) {
  try {
    const entry = archive.stat('package.json');
    if (!entry) return null;
    const version = JSON.parse(archive.read(entry).toString('utf8')).version;
    return typeof version === 'string' && version !== '' ? version : null;
  } catch (err) {
    logger?.warn?.('surface.archive_version_unreadable', { message: err.message });
    return null;
  }
}

/** A `:`-separated list of paths, resolved and emptied of blanks. */
function pathList(value) {
  return String(value ?? '')
    .split(':')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => resolve(entry));
}

/**
 * The configuration the patched document carries to web/host-boot.mjs.
 *
 * Everything in here is either read from the environment or derived from the
 * archive. Two things are deliberately ABSENT rather than defaulted:
 *
 *   * `installedCodexVersion`. The link falls it back to whatever version the
 *     app-server reports, and for a relay that is the only pair that does not
 *     paint a "restart to update" banner offering an action no browser tab can
 *     perform.
 *   * `accountInfo`. The fetch layer answers the account endpoints with a
 *     shaped empty body when it has none, which renders as a signed-out state.
 *     A fabricated account would render as a signed-in one and then fail on
 *     every call that used it.
 *
 * `codexAppSessionId` is minted per call, not per process: it identifies one
 * app session, and for a page one app session is one page load.
 */
/**
 * Resolve the `light`/`dark` the bridge demands out of a server's environment.
 *
 * Kept next to buildBootConfig rather than imported from web/host-bridge.mjs:
 * the two agree on a two-element vocabulary, and a server reaching into a
 * browser module to borrow a frozen pair of strings costs more than it saves.
 * test/surface/boot-config.test.mjs is what holds them together.
 */
function themeVariant(env) {
  const explicit = env.CODEX_RELAY_SYSTEM_THEME;
  if (explicit === 'light' || explicit === 'dark') return explicit;
  const theme = env.CODEX_RELAY_THEME;
  if (theme === 'light' || theme === 'dark') return theme;
  return 'dark';
}

export function buildBootConfig(env = process.env, { appVersion = null } = {}) {
  const version = appVersion ?? env.CODEX_RELAY_APP_VERSION ?? '0.0.0-unknown';
  const workspaceRoots = pathList(env.CODEX_RELAY_WORKSPACE_ROOTS);
  const workspacesRoot = env.CODEX_RELAY_WORKSPACES_ROOT
    ? resolve(env.CODEX_RELAY_WORKSPACES_ROOT)
    : null;
  return {
    wsPath: env.CODEX_RELAY_WS_PATH || '/ws',
    // One host, and it is the one the renderer keys its default client by.
    // A second hostId would need a second upstream to be worth having.
    hostId: 'local',
    bridge: {
      appVersion: version,
      buildNumber: env.CODEX_RELAY_BUILD_NUMBER || '0',
      // Not `production`. The renderer reads this back for its telemetry tags
      // and its own debug affordances, and a relay is neither the shipped app
      // nor a developer's build; saying so is cheaper than a mislabelled trace.
      buildFlavor: env.CODEX_RELAY_BUILD_FLAVOR || 'relay',
      codexAppSessionId: randomUUID(),
      desktopUserAgent: env.CODEX_RELAY_USER_AGENT || `CodexRelayWeb/${version}`,
      theme: env.CODEX_RELAY_THEME || 'dark',
      // Two different questions, and the renderer asks both. `theme` is the
      // preference and may be a word like `system`; `systemThemeVariant` is
      // what the OS currently resolves to and web/host-bridge.mjs refuses
      // anything but `light` or `dark` -- there is no third answer a window
      // can be painted in. A server has no OS theme to read, so honour an
      // explicit override, else follow the preference when it already names a
      // variant, else dark, which is what the preference defaults to.
      //
      // Measured: leaving this unset is not a missing nicety. installElectron-
      // Bridge throws before the renderer's entry module runs, the host never
      // installs, and the real bundle paints its own "hit a snag" boundary.
      systemThemeVariant: themeVariant(env),
      // `dsn` is left out on purpose: web/host-bridge.mjs treats an absent one
      // as "do not initialise Sentry", and a relay has no crash-reporting
      // project of its own to point at.
    },
    fetch: {
      codexHome: env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homedir(), '.codex'),
      workspacesRoot,
      worktreesSegment: env.CODEX_RELAY_WORKTREES_SEGMENT || null,
      workspaceRoots: workspaceRoots,
      // Where a thread runs when no project is selected. Defaults to the
      // first workspace root rather than to null, because the two are the
      // same directory for every relay that configures one root -- and a
      // relay that configures roots and then cannot start a thread in any
      // of them is the failure this default exists to remove. An explicit
      // override wins, for the case where threads should land somewhere
      // other than the first root.
      projectlessRoot: env.CODEX_RELAY_PROJECTLESS_ROOT
        ? resolve(env.CODEX_RELAY_PROJECTLESS_ROOT)
        : (workspaceRoots[0] ?? null),
    },
    // Measured: iOS zooms the whole page when an input whose computed font size
    // is under 16px takes focus, and the renderer sizes its text off this
    // setting. web/host-touch.css raises the CSS token and floors the rendered
    // size, but it cannot reach every field the renderer sizes from settings,
    // so the two halves have to agree. Seeded only where the key is absent, so
    // a change made on the settings screen survives the next reload.
    settings: { sansFontSize: 16 },
  };
}

/**
 * Refuse to start a surface that would serve the renderer and then starve it.
 *
 * The patched document references two same-origin files by absolute path. If
 * either is missing the renderer still boots -- and then waits forever, because
 * the outbound types the host answers have no timeout and the startup logo
 * spins against a clean console. That is the most expensive failure this
 * repository has, and it is a one-line configuration mistake, so it is checked
 * here where the message can name the file and the directory.
 */
/**
 * Warn when the renderer is served with no workspace root to open.
 *
 * Not an error, because a surface with no roots still serves, still
 * authenticates and still relays -- and refusing to start would turn a
 * degraded relay into no relay at all.
 *
 * But it is not a quiet degradation either. The renderer's startup gate reads
 * `workspace-root-options` and renders the onboarding screen until it sees at
 * least one root, and the only way out of that screen is a native folder
 * picker that a browser tab does not have. So a surface started without roots
 * paints an OpenAI logo on a dark background and stays there, with no failed
 * request, no console error and nothing on the wire to say why. That cost six
 * full chain drives to diagnose once; it costs one line to announce.
 */
function warnIfNowhereToWork(env, logger) {
  if (pathList(env.CODEX_RELAY_WORKSPACE_ROOTS).length > 0) return;
  logger?.warn?.('surface.no_workspace_roots', {
    variable: 'CODEX_RELAY_WORKSPACE_ROOTS',
    consequence: 'the renderer will stay on its onboarding screen, which a browser cannot complete',
  });
}

function assertHostModulesServed(staticRoot) {
  for (const href of [BOOT_MODULE_SRC, TOUCH_CSS_HREF]) {
    const file = join(staticRoot, href.replace(/^\/+/, ''));
    if (!existsSync(file)) {
      throw new Error(
        `the patched renderer loads ${href}, which is not in the document root `
        + `(${staticRoot}). Point CODEX_RELAY_STATIC at the repository's web/ directory.`,
      );
    }
  }
}

/**
 * The `/app/` mount, or nothing at all.
 *
 * CODEX_RELAY_ASAR is optional because the relay's own chat UI is useful
 * without it and because buildSurface is called by tests that have no Codex
 * App installed. With it set, `/app/` serves the shipped renderer out of the
 * archive with one file replaced: index.html, patched to load our middleware
 * ahead of the bundle's own entry. Every other byte the renderer asks for comes
 * out of the asar unmodified, which is the whole premise -- we are not forking
 * the renderer, we are supplying the host it expects.
 */
export function buildRendererMount(env, logger = createLogger({ level: 'error' })) {
  if (!env.CODEX_RELAY_ASAR) return { archiveMounts: {}, archive: null };
  const file = resolve(env.CODEX_RELAY_ASAR);
  const archive = openArchive(file);
  const appVersion = archiveAppVersion(archive, logger);
  logger.info('surface.renderer_mount', { archive: file, prefix: RENDERER_MOUNT_PREFIX, appVersion });

  return {
    archive,
    archiveMounts: {
      [RENDERER_MOUNT_PREFIX]: {
        archive,
        base: RENDERER_ARCHIVE_BASE,
        overrides: {
          // A function, not bytes: the config carries a session id that belongs
          // to one page load, and the patch is cheap enough to redo per request
          // that caching it would only buy a stale id.
          'index.html': (original) => patchIndexHtml(original.toString('utf8'), {
            bootConfig: buildBootConfig(env, { appVersion }),
          }),
        },
      },
    },
  };
}

/**
 * Choose the ingress, before anything binds a port.
 *
 * Construction only -- nothing is dialled, spawned or read from a credential
 * here. That is what makes it safe to do this early, and doing it early is the
 * point: every provider checks what it can at construction (an ssh remote
 * port, a relay url, a Funnel mode), so a
 * mistyped variable is a refusal before the surface listens rather than a
 * surprise after a phone is already waiting on it.
 *
 * Two log lines and nothing in between, because there is no third case:
 * `surface.ingress_defaulted` means nobody asked for a route and this process
 * is reachable from this machine only; `surface.ingress_selected` means one was
 * named. Neither line carries an option value -- CODEX_RELAY_RELAY_TOKEN is a
 * secret and `variables` is names only.
 */
export function buildIngress(env = process.env, logger = createLogger({ level: 'error' })) {
  const { name, options, defaulted, variables } = resolveIngressConfig(env);
  // Reached by name, so a provider's own construction refusal is the one that
  // comes out -- the registry is a lookup, not a layer.
  const provider = selectProvider(name, options);
  if (defaulted) {
    logger.info?.('surface.ingress_defaulted', {
      variable: INGRESS_ENV,
      provider: name,
      consequence: 'the surface is reachable from this machine only; the url it reports is real and no phone can dial it',
    });
  } else {
    logger.info?.('surface.ingress_selected', { provider: name, shape: provider.shape, variables });
  }
  return { name, provider, defaulted, variables };
}

/**
 * Point the chosen ingress at a surface that is already listening.
 *
 * The target carries what *both* shapes need -- the server object for an
 * outbound-multiplexing provider, host and port for a listener-configuring one
 * -- which is legal because validateTarget only checks the fields its own
 * shape uses. One target, either shape, no branch here on which we got.
 *
 * The relying-party check is the reason this function exists rather than three
 * lines in main(). A provider of the tailscale sort publishes this machine
 * under a name it chooses, and that name *is* the WebAuthn origin; the relying
 * party, meanwhile, was pinned into the credential store the first time this
 * surface ever ran. If the two disagree, every passkey enrolled from here is
 * registered against an origin the browser will never validate -- and nothing
 * fails, nothing logs, the page just refuses to sign in forever. So the
 * mismatch is caught here, the provider is stopped, and the process refuses to
 * run. It cannot be caught any earlier: the name does not exist until the
 * provider has started.
 */
export async function startIngress({ ingress, surface, rpId = null, logger = createLogger({ level: 'error' }) }) {
  const addr = surface.address();
  if (!addr) {
    throw new Error('startIngress needs a listening surface: call surface.listen() before pointing an ingress at it');
  }
  const host = addr.address;
  const target = {
    // The identity this machine should be reachable as, which is the relying
    // party and not the provider's name: it is the one name in this process
    // that a browser has already been told to expect. Providers that need a
    // name of their own take it from their own options -- the relay's end name
    // is CODEX_RELAY_RELAY_END, required for exactly that reason -- so this is
    // a fallback and never an override.
    name: rpId,
    server: surface.server,
    host,
    port: addr.port,
    // Bracketed so the string is dialable as written, the same way the loopback
    // provider does it. This one is a hint reported to a relay's `/ends`.
    url: `http://${host.includes(':') ? `[${host}]` : host}:${addr.port}`,
  };

  const handle = await startProvider(ingress.provider, { target, logger });

  if (rpId && handle.webauthnRpId && handle.webauthnRpId !== rpId) {
    await handle.stop();
    throw new Error(
      `the ${ingress.name} ingress publishes this machine as ${handle.webauthnRpId}, but the relying party pinned in the `
      + `credential store is ${rpId}. A passkey enrolled now would be registered against an origin the browser will never `
      + 'validate, and nothing would report it -- the sign-in would simply never succeed. Re-pin CODEX_RELAY_RP_ID and '
      + 'CODEX_RELAY_RP_ORIGIN on a fresh state directory, or choose an ingress that does not rename this machine.',
    );
  }

  logger.info?.('surface.ingress_started', {
    provider: ingress.name,
    kind: handle.kind,
    publicUrl: handle.publicUrl,
    webauthnRpId: handle.webauthnRpId,
  });
  return handle;
}

export function buildSurface(env = process.env) {
  const logger = createLogger({ level: env.CODEX_RELAY_LOG_LEVEL || 'info' });
  const stateDir = resolve(env.CODEX_RELAY_STATE || './state');

  const credentials = new CredentialStore(resolve(stateDir, 'credentials.json'));
  if (!credentials.relyingParty) {
    // First run: pin the relying party from the environment and never again.
    credentials.setRelyingParty({
      id: required(env, 'CODEX_RELAY_RP_ID'),
      name: env.CODEX_RELAY_RP_NAME || 'Codex Relay',
      origin: required(env, 'CODEX_RELAY_RP_ORIGIN'),
    });
  }

  const keyStore = defaultKeyStore({
    filePath: env.CODEX_RELAY_KEY_FILE ? resolve(env.CODEX_RELAY_KEY_FILE) : undefined,
    preferFile: env.CODEX_RELAY_KEY_FILE ? true : false,
  });
  logger.info('surface.key_store', { store: keyStore.description });

  const sessions = new SessionManager(new KeyRing(keyStore));
  const ceremonies = new Ceremonies({
    credentials,
    challenges: new EphemeralStore(),
    bootstrapTokens: new EphemeralStore({ ttlMs: 10 * 60 * 1000 }),
    sessions,
  });

  // Before createSurface, and before anything listens: a mistyped ingress
  // variable should cost a refusal on startup, not a port that is bound and
  // unreachable.
  const ingress = buildIngress(env, logger);

  const staticRoot = env.CODEX_RELAY_STATIC ? resolve(env.CODEX_RELAY_STATIC) : DEFAULT_STATIC_ROOT;
  const { archive, archiveMounts } = buildRendererMount(env, logger);
  if (archive) assertHostModulesServed(staticRoot);
  if (archive) warnIfNowhereToWork(env, logger);

  const surface = createSurface({
    host: env.CODEX_RELAY_HOST || '127.0.0.1',
    port: Number(env.CODEX_RELAY_PORT ?? 8787),
    staticRoot,
    // The page imports two modules from src/appserver. They are mounted rather
    // than copied, so there is exactly one version of the JSON-RPC client, and
    // mounted as one named directory rather than by pointing staticRoot at the
    // repository root, which would serve .git, test/ and docs/ along with the
    // page. The prefix mirrors the repository path because that is where the
    // page's relative specifier lands once the browser clamps `../` at the
    // document root -- see the deployment note in web/appserver.mjs. `/src/`
    // is not served; only this one directory under it is.
    staticMounts: { '/src/appserver/': fileURLToPath(new URL('../appserver/', import.meta.url)) },
    archiveMounts,
    ceremonies,
    sessions,
    logger,
    createUpstream: createWsUpstreamFactory({ address: required(env, 'CODEX_RELAY_UPSTREAM'), logger }),
  });

  // The origin comes back from the store rather than from the environment it was
  // seeded with. They agree on a first run and the store wins afterwards, which
  // is the point: the pinned origin is the one WebAuthn will actually check, so
  // it is the only one an enrolment link may be built from. A link built from a
  // changed env var would open a page whose ceremony is refused by the browser.
  // `archive` comes back so the caller can close its descriptor on shutdown.
  // It is null unless CODEX_RELAY_ASAR was set, and the three existing keys are
  // unchanged, so every caller that destructures what it already destructured
  // is unaffected.
  //
  // `ingress` is the chosen provider, not a started one: starting it needs a
  // listening socket, which buildSurface deliberately does not create. `rpId`
  // comes along because startIngress has to compare it against what the
  // provider publishes, and reading it back out of the store is what keeps that
  // comparison about the pinned value rather than the environment's.
  return {
    surface,
    ceremonies,
    origin: credentials.relyingParty.origin,
    archive,
    ingress,
    rpId: credentials.relyingParty.id,
    logger,
  };
}

export async function main() {
  const { surface, ceremonies, origin, archive, ingress, rpId, logger } = buildSurface();
  await surface.listen();
  const ingressHandle = await startIngress({ ingress, surface, rpId, logger });
  announceEnrolment({ ceremonies, origin });
  process.on('SIGUSR1', () => announceEnrolment({ ceremonies, origin, force: true }));
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      // The archive is closed first and its own close defers the descriptor
      // until nothing is streaming from it, so an in-flight renderer asset
      // finishes rather than reading from a recycled fd number.
      archive?.close();
      // The ingress goes down before the surface does: it is the thing holding
      // a socket to somebody else's process (a relay, an ssh remote, a Funnel
      // child), and leaving that attached while our own server shuts down
      // publishes an end that answers nothing. `stop()` is idempotent by the
      // wrapper in startProvider, so a second signal cannot double-stop it.
      ingressHandle.stop()
        .catch((err) => logger.error?.('surface.ingress_stop_failed', { message: err.message }))
        .then(() => surface.close())
        .then(() => process.exit(0), () => process.exit(1));
    });
  }
  return surface;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${JSON.stringify({ level: 'error', event: 'surface.start_failed', message: err.message })}\n`);
    process.exit(1);
  });
}
