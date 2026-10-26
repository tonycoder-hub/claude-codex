// The assembly, tested on the things only the assembly can get wrong.
//
// Every layer this module installs already has its own suite, and those suites
// are where layer behaviour belongs. What none of them can test is the seam:
// the bus being created once rather than twice, a reply arriving before the
// subscriber that wanted it, a failure in layer three leaving layers four
// through six uninstalled, and -- the one that motivated the whole file -- a
// convenient default version turning a steer into a new turn.
//
// So the assertions below are about identity, order, absence and visibility:
//
//   * ONE capture listener on the window. A second bus does not error, does not
//     log and does not drop anything; it duplicates. Every outbound mcp-request
//     goes to the server twice, the server answers both, and the second answer
//     arrives for an id that is already settled. The test for that is a count.
//
//   * NOTHING delivered through `sendMessageFromView`. The renderer's transport
//     calls that bridge member AND dispatches a CustomEvent for every single
//     outbound message, so hooking both is the same duplication by another
//     route. The test is that calling the bridge member sends nothing.
//
//   * NO wildcard version, ever. A handshake that names nothing comparable has
//     to produce a visible failure, not a substituted `0.0.0` -- which the
//     renderer reads as "every version gate passes", including the gate that
//     strips `turnTrigger` out of a steer and makes it a fresh turn.
//
//   * A VISIBLE failure for anything whose absence hangs the page, and no
//     banner for anything whose absence is merely cosmetic.
//
// There is no browser here, no socket and no real app-server. The window is a
// fake over Node's real EventTarget and the transport is the same fake the
// link's own suite uses, so the event plumbing under test is the real plumbing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  BOOT_META_NAME,
  BootConfigError,
  bootFromDocument,
  createBootStorage,
  installHostBoot,
  MAX_DEGRADATIONS,
  readBootConfig,
  showBootFailure,
  webSocketUrl,
} from '../../web/host-boot.mjs';
import {
  BOOT_META_NAME as WRITER_BOOT_META_NAME,
  BOOT_MODULE_SRC,
  patchIndexHtml,
} from '../../src/renderer/boot.mjs';
import { ELECTRON_ONLY_PUSHES, OUTBOUND, OUTBOUND_EVENT } from '../../web/host-protocol.mjs';
import { createHostBus } from '../../web/host-bus.mjs';
import { createHostNamespaces } from '../../web/host-namespaces.mjs';
import { FETCH_URL_PREFIX, SETTINGS_KEY } from '../../web/host-fetch.mjs';
import { fakeTransport, settle } from '../appserver/fakes.mjs';
import { bridgeConfig, recordingPort } from './host-fakes.mjs';
import { JSONRPC_VERSION } from '../../src/appserver/client.mjs';
import { FILE_CALL_TIMEOUT_MS } from '../../web/host-files.mjs';

const SOURCE = new URL('../../web/host-boot.mjs', import.meta.url);

/** The userAgent the live adapter builds, with a real compat version in it. */
const REAL_USER_AGENT = 'codex-relay-web/0.142.3 (macos; aarch64) claude-codex (codex-relay-web; 0.0.0)';

// ---- the fake DOM ----------------------------------------------------------
//
// Deliberately NOT added to test/web/host-fakes.mjs. That file's `makeWindow`
// is pinned by six other suites whose modules read three properties off it, and
// growing it into a DOM to suit this one file would make every one of those
// suites quietly less of a test of the narrow surface its module actually
// touches. This fake is a DOM because this module is the only one that installs
// a stylesheet, reads a meta tag and paints a banner.

let elementIds = 0;

function makeElement(doc, tagName) {
  elementIds += 1;
  const attributes = new Map();
  const classes = new Set();
  const element = {
    tagName: String(tagName).toUpperCase(),
    children: [],
    textContent: '',
    _seq: elementIds,
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
    setAttribute(name, value) {
      attributes.set(name, String(value));
      if (name === 'id') doc._byId.set(String(value), element);
    },
    hasAttribute: (name) => attributes.has(name),
    removeAttribute: (name) => attributes.delete(name),
    appendChild(child) {
      element.children.push(child);
      doc._all.add(child);
      return child;
    },
    remove() {
      doc._all.delete(element);
      if (element.id) doc._byId.delete(element.id);
    },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      get size() {
        return classes.size;
      },
    },
    style: { setProperty: () => {}, removeProperty: () => {} },
    dataset: {},
  };
  // `id`, `rel` and `href` are the three the host modules set as properties
  // rather than through setAttribute, so they have to behave as both.
  for (const name of ['id', 'rel', 'href', 'name', 'content', 'media']) {
    Object.defineProperty(element, name, {
      configurable: true,
      get: () => (attributes.has(name) ? attributes.get(name) : ''),
      set: (value) => element.setAttribute(name, value),
    });
  }
  return element;
}

/**
 * A selector matcher for exactly the two forms the host modules use:
 * `meta[name="x"]` and `[data-attr]`. Anything else throws rather than
 * returning null, because a null from an unsupported selector would read as
 * "the element is not there" and quietly pass a test that proved nothing.
 */
function matches(element, selector) {
  const withTag = /^([a-z]+)?\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
  if (!withTag) throw new Error(`this fake does not implement the selector ${JSON.stringify(selector)}`);
  const [, tag, attr, value] = withTag;
  if (tag && element.tagName !== tag.toUpperCase()) return false;
  if (!element.hasAttribute(attr)) return false;
  return value === undefined || element.getAttribute(attr) === value;
}

function makeDocument() {
  const doc = {
    _all: new Set(),
    _byId: new Map(),
    _listeners: [],
  };
  doc.createElement = (tagName) => makeElement(doc, tagName);
  doc.documentElement = makeElement(doc, 'html');
  doc.head = makeElement(doc, 'head');
  doc.body = makeElement(doc, 'body');
  doc._all.add(doc.documentElement);
  doc._all.add(doc.head);
  doc._all.add(doc.body);
  doc.getElementById = (id) => doc._byId.get(String(id)) ?? null;
  doc.querySelector = (selector) => {
    for (const element of doc._all) if (matches(element, selector)) return element;
    return null;
  };
  doc.querySelectorAll = (selector) => [...doc._all].filter((element) => matches(element, selector));
  // The two properties web/host-focus.mjs reads. Without them the focus layer
  // installs and can never observe a transition, so the boot suite would be
  // asserting against a layer that is structurally unable to do its job.
  doc._focused = true;
  doc.visibilityState = 'visible';
  doc.hasFocus = () => doc._focused;
  doc.addEventListener = (type, listener, capture) => doc._listeners.push({ type, listener, capture });
  doc.removeEventListener = (type, listener) => {
    const at = doc._listeners.findIndex((entry) => entry.type === type && entry.listener === listener);
    if (at >= 0) doc._listeners.splice(at, 1);
  };
  return doc;
}

/** A localStorage that works, or one that refuses the way Safari's does. */
function makeStorage({ refuseWrites = false } = {}) {
  const data = new Map();
  return {
    data,
    get length() {
      return data.size;
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem(key, value) {
      if (refuseWrites) throw new Error('QuotaExceededError: the quota has been exceeded.');
      data.set(key, String(value));
    },
    removeItem: (key) => data.delete(key),
  };
}

function makeHostWindow({
  href = 'https://relay.invalid/app/',
  storage = makeStorage(),
  mobile = true,
} = {}) {
  const target = new EventTarget();
  const document = makeDocument();
  const observers = [];

  // Kept alongside the real EventTarget rather than instead of it, because the
  // plumbing under test has to stay real. EventTarget itself de-duplicates on
  // (type, listener), and so does this Set, so the tally cannot disagree with
  // what the target will actually call.
  const listeners = new Map();

  const window = {
    document,
    localStorage: storage,
    location: { href, origin: new URL(href).origin, protocol: new URL(href).protocol },
    console: { error: (...args) => window._console.push(args.join(' ')), warn: () => {} },
    _console: [],
    _observers: observers,
    matchMedia: (query) => ({ media: query, matches: mobile, addEventListener: () => {}, removeEventListener: () => {} }),
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }

      observe() {}

      disconnect() {}
    },
    addEventListener: (type, listener, options) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
      target.addEventListener(type, listener, options);
    },
    removeEventListener: (type, listener, options) => {
      listeners.get(type)?.delete(listener);
      target.removeEventListener(type, listener, options);
    },
    /** How many distinct listeners of `type` are registered right now. */
    _listenerCount: (type) => listeners.get(type)?.size ?? 0,
    /** Background and foreground the tab, firing what a browser fires. */
    _goBackground() {
      document._focused = false;
      document.visibilityState = 'hidden';
      target.dispatchEvent(new Event('blur'));
    },
    _goForeground() {
      document._focused = true;
      document.visibilityState = 'visible';
      target.dispatchEvent(new Event('focus'));
    },
    dispatchEvent: (event) => target.dispatchEvent(event),
    postMessage(data, targetOrigin = window.location.origin, transfer = []) {
      const event = new MessageEvent('message', { data, origin: targetOrigin });
      Object.defineProperty(event, 'source', { value: window, configurable: true });
      Object.defineProperty(event, 'ports', { value: transfer, configurable: true });
      target.dispatchEvent(event);
      return event;
    },
  };
  return window;
}

/**
 * The renderer's outbound send, both halves of it.
 *
 * Reproduced here rather than imported so that the bridge half is callable
 * independently -- one test below is entirely about the bridge half delivering
 * nothing on its own.
 */
function sendFromView(window, type, payload = {}) {
  const message = { ...payload, type };
  window.electronBridge?.sendMessageFromView?.(message);
  window.dispatchEvent(new CustomEvent('codex-message-from-view', { detail: message }));
  return message;
}

/** Every inbound message the host delivered to the window, in order. */
function collectInbound(window) {
  const data = [];
  window.addEventListener('message', (event) => data.push(event.data));
  return {
    data,
    types: () => data.map((message) => message?.type),
    ofType: (type) => data.filter((message) => message?.type === type),
  };
}

function bootConfig(overrides = {}) {
  return {
    wsPath: '/ws',
    hostId: 'local',
    bridge: bridgeConfig(),
    fetch: { codexHome: '/home/x/.codex' },
    settings: { sansFontSize: 16 },
    ...overrides,
  };
}

/** A fully assembled host on a fake window, with the wire it talks over. */
function harness({ config = bootConfig(), window = makeHostWindow(), ...options } = {}) {
  const fake = fakeTransport();
  const events = [];
  const inbound = collectInbound(window);
  const host = installHostBoot({
    window,
    config,
    transport: fake.transport,
    onEvent: (event) => events.push(event),
    ...options,
  });
  return { window, fake, host, events, inbound, kinds: () => events.map((event) => event.kind) };
}

/** Answer the initialize request the link just sent. */
function answerHandshake(fake, overrides = {}) {
  fake.receive({
    jsonrpc: JSONRPC_VERSION,
    id: fake.last.id,
    result: {
      userAgent: REAL_USER_AGENT,
      codexHome: '/home/x/.codex',
      platformFamily: 'unix',
      platformOs: 'macos',
      ...overrides,
    },
  });
}

function bannerText(window) {
  return window.document.getElementById('codex-relay-boot-failure')?.textContent ?? null;
}

/**
 * The capnweb handshake, posted exactly as the renderer's app-shared.js posts
 * it: the port travels in the message body AND in the transfer list.
 */
function connectAppHost(window, port = recordingPort()) {
  window.postMessage({ type: 'connect-app-host', port }, window.location.origin, [port]);
  return port;
}

// ---- the config the surface writes, read back by the host ------------------

test('the config the patcher writes is the config this module reads', () => {
  // The two halves of the meta tag are in different directories and cannot
  // import each other: a module under web/ may only reach other web/ modules
  // and the mounted appserver directory, which is what the browser can resolve.
  // So the tag name is spelled twice, and this test is what pins the copies
  // together. Without it a rename on either side produces a served page with a
  // config nobody reads and a host that reports a missing tag it can see.
  const config = bootConfig({
    // Two encoding traps, not decoration: a multi-byte character and a quote
    // between them prove the payload survives UTF-8 and never reaches the
    // attribute raw.
    workspaceLabel: 'Ji Xu — "work"',
    nested: { limits: { maxPendingBytes: 1048576, timeoutMs: null } },
  });
  const html = patchIndexHtml(
    '<!doctype html>\n<html><head>\n'
    // The patcher refuses a document with no policy, so even a fixture that is
    // only here for the meta tag has to carry one. See src/renderer/boot.mjs.
    + '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; connect-src &#39;self&#39;;">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
    + '<link rel="stylesheet" href="./assets/app.css">\n'
    + '<script type="module" crossorigin src="./assets/index.js"></script>\n'
    + '</head><body><div id="root"></div></body></html>\n',
    { bootConfig: config },
  );

  const found = /<meta name="codex-relay-boot" content="([^"]*)">/.exec(html);
  assert.ok(found, 'the patcher did not write a tag this module could find');

  const window = makeHostWindow();
  const meta = window.document.createElement('meta');
  meta.setAttribute('name', BOOT_META_NAME);
  meta.setAttribute('content', found[1]);
  window.document.head.appendChild(meta);

  assert.deepEqual(readBootConfig(window.document), config);
});

test('the two copies of the meta name are the same string', () => {
  // The round trip above would catch a drift too, but it would report it as a
  // missing tag -- which reads as a patcher bug rather than as the rename it
  // is. This says it in one line.
  assert.equal(BOOT_META_NAME, WRITER_BOOT_META_NAME);
});

test('the module the document loads is the module this file is', async () => {
  // src/renderer/boot.mjs writes an absolute src into the patched document, and
  // the document root is web/. If the two ever disagree the renderer loads
  // nothing, boots anyway, and waits forever -- there is no error, because a
  // 404 on a module script is reported to a console no phone can open.
  const documentRoot = new URL('../../web/', import.meta.url);
  // The leading slash is the document root, so stripping it is the whole
  // translation from the URL the browser requests to the file that answers it.
  const served = new URL(BOOT_MODULE_SRC.replace(/^\/+/, ''), documentRoot);
  assert.equal(served.href, SOURCE.href, `the document loads ${BOOT_MODULE_SRC}, which is not this file`);
  await readFile(served, 'utf8');
});

test('an unpatched document names the tag that is missing', () => {
  const window = makeHostWindow();
  assert.throws(() => readBootConfig(window.document), (error) => {
    assert.ok(error instanceof BootConfigError);
    assert.match(error.message, /codex-relay-boot/, 'the reader must name the tag it wanted');
    assert.match(error.message, /unpatched/);
    return true;
  });
});

test('a config that does not decode is raised, not defaulted away', () => {
  for (const content of ['', 'not-base64url!!', 'bm90LWpzb24', 'WyJhbiIsImFycmF5Il0']) {
    const window = makeHostWindow();
    const meta = window.document.createElement('meta');
    meta.setAttribute('name', BOOT_META_NAME);
    meta.setAttribute('content', content);
    window.document.head.appendChild(meta);
    assert.throws(() => readBootConfig(window.document), BootConfigError, `${content} passed`);
  }
});

test('bootFromDocument banners a missing config instead of throwing out', () => {
  const window = makeHostWindow();
  assert.equal(bootFromDocument(window), null, 'nothing to assemble, and nothing thrown');
  assert.match(bannerText(window), /codex-relay-boot/);
  assert.equal(window._console.length, 1, 'and the console was told too');
});

// ---- one bus, one capture listener -----------------------------------------

test('the assembly installs exactly one capture listener on the window', async () => {
  // The whole reason this file creates no bus of its own. createHostLink builds
  // one internally; a second createHostBus here would put a second capture
  // listener on the same window and hand every outbound message to both. That
  // failure throws nothing and logs nothing -- it duplicates, and the only
  // symptom is a tool running twice.
  //
  // So it is tested as a count OF LISTENERS, which is not what this test used
  // to do. It used to send one mcp-request and assert the server saw one, with
  // a comment claiming "two listeners would make this two". That claim is
  // false: web/host-bus.mjs fans an outbound message out only to
  // `handlers.get(type)`, and a second bus built by a second caller registers
  // no typed handler of its own, so it receives the event and delivers
  // nothing. The assertion held under the exact mutation its comment named.
  //
  // OUTBOUND_EVENT is registered on a window in exactly one place in this
  // codebase -- createHostBus, web/host-bus.mjs:140 -- so the number of
  // listeners of that type IS the number of buses, with nothing to interpret.
  const { fake, host, window } = harness();
  answerHandshake(fake);
  await host.announced;

  assert.equal(window._listenerCount(OUTBOUND_EVENT), 1, 'the assembly built more than one bus');

  sendFromView(window, OUTBOUND.mcpRequest, {
    hostId: 'local',
    request: { method: 'thread/list', params: {}, id: 'renderer-1' },
  });
  await settle();
  assert.equal(fake.requestsFor('thread/list').length, 1);

  // The negative control, in the test rather than in a commit message, because
  // the point of the rewrite is that the old assertion did not have one. A
  // second bus moves the count and leaves the request total alone -- the two
  // lines below are the measurement that condemned the previous version of
  // this test, and they will keep condemning it if anybody puts it back.
  const second = createHostBus({ window, hostId: 'local' });
  try {
    assert.equal(window._listenerCount(OUTBOUND_EVENT), 2, 'the count must see the second bus');

    sendFromView(window, OUTBOUND.mcpRequest, {
      hostId: 'local',
      request: { method: 'thread/list', params: {}, id: 'renderer-2' },
    });
    await settle();
    assert.equal(
      fake.requestsFor('thread/list').length, 2,
      'one more request, not two: the second bus has no typed handler and delivers nothing',
    );
  } finally {
    second.stop();
  }
  assert.equal(window._listenerCount(OUTBOUND_EVENT), 1, 'and stop() takes its listener back off');
});

test('the bridge member is not a delivery path', async () => {
  // The renderer calls `sendMessageFromView` AND dispatches the CustomEvent for
  // every outbound message, so a host that honoured both would double every
  // request by the other route. web/host-bridge.mjs installs the member as a
  // resolved promise that carries nothing, and this file never reaches for it.
  const { fake, host, window } = harness();
  answerHandshake(fake);
  await host.announced;
  const before = fake.sent.length;

  const result = window.electronBridge.sendMessageFromView({
    hostId: 'local',
    request: { method: 'thread/list', params: {}, id: 'renderer-2' },
    type: OUTBOUND.mcpRequest,
  });
  await settle();

  assert.ok(result instanceof Promise, 'the renderer awaits it, so it must be one');
  assert.equal(fake.sent.length, before, 'the bridge half delivered nothing, which is correct');
});

test('the source never assigns a delivery body to sendMessageFromView', async () => {
  const source = await readFile(SOURCE, 'utf8');
  assert.equal(
    /sendMessageFromView\s*[:=]/.test(source),
    false,
    'defining it here is how every outbound message gets handled twice',
  );
});

// ---- order: installed before anything can be late --------------------------

test('every layer is installed, in the order the renderer needs them', async () => {
  const { host, fake } = harness();
  assert.deepEqual(
    host.layers.map((layer) => layer.name),
    ['bridge', 'touch', 'link', 'files', 'namespaces', 'handshake', 'fetch', 'services', 'focus'],
    'bridge first: four of its members are read synchronously at module-eval time;'
      + ' files between link and namespaces, because it is built from the link\'s client'
      + ' and consumed by two namespace members;'
      + ' focus last, because it is the only layer that answers a renderer request'
      + ' without needing anything any other layer built',
  );
  assert.deepEqual(host.layers.filter((layer) => !layer.ok), []);
  assert.equal(host.ok, true);
  answerHandshake(fake);
  await host.announced;
});

test('the host is assembled synchronously, before the renderer could run', () => {
  // installHostBoot returns having already installed everything the renderer
  // reads during its own synchronous boot. If any of it were awaited, the
  // renderer's entry -- which the patcher places immediately after our tag --
  // would evaluate against a bare window.
  const { host, window, fake } = harness();
  assert.equal(typeof window.electronBridge, 'object');
  assert.equal(typeof window.codexWindowType, 'string');
  assert.ok(host.bus, 'the bus is live');
  assert.ok(host.hostFetch, 'and so is the fetch layer');
  assert.ok(host.services);
  // And the handshake request is already on the wire, un-awaited.
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.last.method, 'initialize');
});

test('the capnweb handshake is answered, and the port is never started', async () => {
  // The renderer awaits `session.services` with NO timeout, so an unanswered
  // handshake is the startup logo forever. Subscribing before the entry script
  // runs is what makes being late impossible.
  const { window, host, fake } = harness();
  const channel = new MessageChannel();
  const frames = [];
  const port = {
    _started: false,
    postMessage: (frame) => frames.push(frame),
    addEventListener: (type, listener) => channel.port1.addEventListener(type, listener),
    removeEventListener: (type, listener) => channel.port1.removeEventListener(type, listener),
    start() {
      port._started = true;
    },
    close: () => {},
  };

  window.postMessage({ type: 'connect-app-host' }, window.location.origin, [port]);
  channel.port2.postMessage(['pull', 1]);
  await settle();

  assert.equal(port._started, false, 'start() flushes the queue into a port with no listeners');
  assert.ok(host.handshake, 'the handshake layer is installed');
  channel.port1.close();
  channel.port2.close();
  answerHandshake(fake);
  await host.announced;
});

// ---- the version, which is the expensive one -------------------------------

test('the announced version is the one the server named', async () => {
  const { fake, host, inbound } = harness();
  answerHandshake(fake);
  const announced = await host.announced;

  const [initialized, changed] = inbound.data;
  assert.equal(initialized.type, 'codex-app-server-initialized');
  assert.equal(initialized.appServerVersion, '0.142.3');
  assert.notEqual(initialized.appServerVersion, '0.0.0', 'the whole reason the server is asked');
  assert.equal(initialized.transport, 'websocket');
  assert.equal(changed.state, 'connected');
  assert.equal(announced.appServerVersion, '0.142.3');
});

test('a server that names nothing comparable produces a banner, not a wildcard', async () => {
  // `0.0.0` is a wildcard the renderer reads as "every version gate passes",
  // including the gate on `turnToolOutput` -- which is what decides whether a
  // steer carries `turnTrigger`. Substituted here, a steer silently becomes a
  // fresh turn and neither side logs anything. A banner is strictly better than
  // a plausible default, which is why this test asserts on BOTH the banner and
  // the absence of the announcement.
  const { fake, host, inbound, window } = harness();
  answerHandshake(fake, { userAgent: 'something-with-no-version' });
  const announced = await host.announced;

  assert.equal(announced, null);
  assert.deepEqual(inbound.ofType('codex-app-server-initialized'), [], 'nothing was announced');
  assert.match(bannerText(window), /app-server/);
  assert.match(bannerText(window), /no comparable version/);
  assert.deepEqual(host.failures.map((failure) => failure.name), ['app-server']);
  assert.equal(host.ok, false);
});

test('a configured installed version is honoured, and an absent one is not invented', async () => {
  const withVersion = harness({ config: bootConfig({ installedCodexVersion: '0.143.0' }) });
  answerHandshake(withVersion.fake);
  await withVersion.host.announced;
  assert.equal(withVersion.inbound.data[0].installedCodexVersion, '0.143.0');

  const without = harness();
  answerHandshake(without.fake);
  await without.host.announced;
  const [initialized] = without.inbound.data;
  assert.equal(
    initialized.installedCodexVersion,
    initialized.appServerVersion,
    'equal is the only pair that does not offer a restart this host cannot perform',
  );
});

// ---- failure has to be visible ---------------------------------------------

test('a failed blocking layer banners and does not stop the others', () => {
  // web/host-bridge.mjs refuses an incomplete config, which is the easiest real
  // failure to induce and exactly the one a surface misconfiguration produces.
  const window = makeHostWindow();
  const { host } = harness({ window, config: bootConfig({ bridge: { appVersion: '' } }) });

  assert.equal(host.ok, false);
  assert.deepEqual(host.failures.map((failure) => failure.name), ['bridge']);
  assert.match(bannerText(window), /^Codex relay host failed to start\./);
  assert.match(bannerText(window), /bridge:/);
  assert.deepEqual(
    host.layers.filter((layer) => layer.ok).map((layer) => layer.name),
    ['touch', 'link', 'files', 'namespaces', 'handshake', 'fetch', 'services', 'focus'],
    'one broken layer must not take the rest of the host down with it',
  );
});

test('a failed cosmetic layer is reported but not bannered', () => {
  // The touch layer's absence is a page that is awkward on a phone, not one
  // that never finishes loading. A banner for that trains the user to dismiss
  // banners unread, which is what makes the next real one invisible.
  const window = makeHostWindow();
  // A documentElement-less document is the one thing host-touch refuses.
  window.document.documentElement = null;
  const { host, kinds } = harness({ window });

  assert.equal(host.touch, null);
  assert.deepEqual(host.failures.map((failure) => failure.name), ['touch']);
  assert.equal(bannerText(window), null, 'no banner for a cosmetic fault');
  assert.ok(kinds().includes('layer-failed'), 'but it is reported');
});

test('a second failure replaces the banner rather than stacking', () => {
  const window = makeHostWindow();
  showBootFailure(window, 'the first thing');
  showBootFailure(window, 'the second thing');
  assert.equal(window.document.querySelectorAll('[id]').length >= 1, true);
  assert.match(bannerText(window), /the second thing/);
  assert.equal(/the first thing/.test(bannerText(window)), false);
});

test('the banner survives a document that can barely be touched', () => {
  // The case this exists for is our own stylesheet or DOM being the thing that
  // failed. A reporter that throws inside a catch block replaces a diagnosable
  // fault with an undiagnosable one, so it must degrade to the console line.
  const broken = { console: { error: () => {} }, document: { createElement: () => { throw new Error('no'); } } };
  assert.equal(showBootFailure(broken, 'anything'), null);
  assert.equal(showBootFailure({}, 'anything'), null);
  assert.equal(showBootFailure({ document: null }, 'anything'), null);
});

test('installHostBoot refuses a window or a config it cannot use', () => {
  assert.throws(() => installHostBoot({ window: null, config: {} }), /a window is required/);
  assert.throws(() => installHostBoot({ window: makeHostWindow(), config: [] }), /boot config object/);
  assert.throws(() => installHostBoot({ window: makeHostWindow(), config: null }), /boot config object/);
});

// ---- the layers are actually wired to the bus ------------------------------

test('an outbound fetch is answered on the window', async () => {
  // The fetch layer takes a `deliver`, and the bus's typed emitters cover the
  // app-server lifecycle only. The generic `bus.deliver` is the seam, and this
  // asserts the seam is connected rather than that the fetch layer works.
  const { window, host, inbound, fake } = harness();
  sendFromView(window, OUTBOUND.fetch, {
    requestId: 'request-1',
    method: 'POST',
    url: `${FETCH_URL_PREFIX}get-settings`,
  });
  await settle();

  const [reply] = inbound.ofType('fetch-response');
  assert.ok(reply, 'an unanswered fetch has NO timeout and stalls the whole data layer');
  assert.equal(reply.requestId, 'request-1');
  assert.equal(host.bus.stats.emitted >= 1, true, 'and the counter saw it, which a hand-rolled dispatch would not');
  answerHandshake(fake);
  await host.announced;
});

test('a persisted-atom sync is answered on the window', async () => {
  const { window, inbound, host, fake } = harness();
  sendFromView(window, OUTBOUND.persistedAtomSyncRequest, {});
  await settle();

  const [reply] = inbound.ofType('persisted-atom-sync');
  assert.ok(reply, 'the renderer degrades after 5000 ms of silence here');
  answerHandshake(fake);
  await host.announced;
});

test('an onboarding workspace pick is declined cleanly rather than left hanging', async () => {
  // No browser has a directory picker that yields a filesystem path the
  // app-server could use -- `showDirectoryPicker()` hands back a handle, not a
  // path -- so no picker is injected. The services layer's clean cancellation
  // is the honest answer, and the type has no timeout, so the alternative is
  // onboarding stuck forever.
  const { window, inbound, host, fake } = harness();
  sendFromView(window, OUTBOUND.pickWorkspaceRootOption, {});
  await settle();

  assert.equal(inbound.data.length >= 1, true, 'this type has no timeout; silence is permanent');
  answerHandshake(fake);
  await host.announced;
});

test('outbound traffic nobody claimed is reported rather than ignored', async () => {
  const { window, events, host, fake } = harness();
  sendFromView(window, 'some-type-the-next-app-update-added', {});
  await settle();

  const unclaimed = events.filter((event) => event.kind === 'outbound-unclaimed');
  assert.deepEqual(unclaimed.map((event) => event.type), ['some-type-the-next-app-update-added']);
  answerHandshake(fake);
  await host.announced;
});

test('a restart request is surfaced, because nothing here can grant it', async () => {
  // With no handler the renderer settles down to wait for an initialized
  // message that is not coming. Re-announcing is refused -- it would have the
  // renderer stand up a second client for the same hostId -- so a reload is the
  // only real restart, and saying so is the only useful thing left.
  const { window, host, fake } = harness();
  answerHandshake(fake);
  await host.announced;

  sendFromView(window, OUTBOUND.appServerRestart, { hostId: 'local' });
  await settle();

  assert.match(bannerText(window), /Reload the page/);
});

// ---- the stores, which is why onboarding stops replaying -------------------

test('state written on one page load is there on the next', async () => {
  // Both layers default to an in-memory store, which is right for their own
  // suites and wrong for a page: global state, settings and the renderer's
  // dismissal atoms all live in them, so a memory default means onboarding
  // replays on every pull-to-refresh.
  const storage = makeStorage();
  const first = harness({ window: makeHostWindow({ storage }) });
  assert.equal(first.host.stores.persistent, true);
  first.host.stores.atomStore.set('onboarding-complete-v1', { done: true });
  answerHandshake(first.fake);
  await first.host.announced;

  const second = harness({ window: makeHostWindow({ storage }) });
  sendFromView(second.window, OUTBOUND.persistedAtomSyncRequest, {});
  await settle();
  const [reply] = second.inbound.ofType('persisted-atom-sync');
  assert.deepEqual(reply.state['onboarding-complete-v1'], { done: true });
  answerHandshake(second.fake);
  await second.host.announced;
});

test('the two key spaces cannot collide', () => {
  const storage = makeStorage();
  const stores = createBootStorage(makeHostWindow({ storage }));
  stores.atomStore.set('settings', { fromAtoms: true });
  const keys = [...storage.data.keys()];
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^codex-relay-host:atom:settings$/);
  assert.equal(storage.data.has('codex-relay-host:fetch:settings'), false);
});

test('a storage that refuses writes degrades to memory, with the same semantics', async () => {
  // Safari in private browsing supplies a localStorage that exists and throws
  // on setItem, so presence is not availability and a write probe is the only
  // honest test. The fallback JSON round-trips for a reason: one that stored
  // object identity would let a Map or a Date pass here and fail on a phone.
  const reports = [];
  const stores = createBootStorage(
    makeHostWindow({ storage: makeStorage({ refuseWrites: true }) }),
    { report: (kind) => reports.push(kind) },
  );
  assert.equal(stores.persistent, false);
  assert.ok(reports.includes('storage-unavailable'));

  const value = { nested: ['a', 1, null] };
  await stores.fetchStore.set('k', value);
  const read = await stores.fetchStore.get('k');
  assert.deepEqual(read, value);
  assert.notEqual(read, value, 'a store that handed back identity would not match the real one');
});

test('a window with no storage at all still boots', async () => {
  const window = makeHostWindow();
  delete window.localStorage;
  const { host, fake } = harness({ window });
  assert.equal(host.ok, true);
  assert.equal(host.stores.persistent, false);
  answerHandshake(fake);
  await host.announced;
});

test('an unreadable stored value reads as absent rather than throwing', () => {
  const storage = makeStorage();
  storage.data.set('codex-relay-host:atom:half-written', '{"not json');
  const reports = [];
  const stores = createBootStorage(makeHostWindow({ storage }), { report: (kind) => reports.push(kind) });
  assert.equal(stores.atomStore.get('half-written'), undefined);
  assert.deepEqual([...stores.atomStore.entries()], [], 'and it is not offered in a whole-state sync');
  assert.ok(reports.includes('storage-value-unreadable'));
});

// ---- the shared-object mirror, across a reload -----------------------------
//
// The mirror only ever pays for itself on a reload. Everything below is
// therefore a two-boot test against one localStorage, because a single-boot
// test would pass just as happily against the `new Map()` default that a
// reload throws away -- and a phone browser reloads tabs on its own schedule.

test('a shared object written by one page is seeded into the next', () => {
  const storage = makeStorage();

  const first = harness({ window: makeHostWindow({ storage }) });
  sendFromView(first.window, OUTBOUND.sharedObjectSet, {
    key: 'diff_comments',
    value: [{ id: 'c1', body: 'here' }],
  });
  assert.equal(first.host.services.stats().sharedObjectsMirrored, 1);

  const second = harness({ window: makeHostWindow({ storage }) });
  assert.deepEqual(
    second.window.electronBridge.getSharedObjectSnapshotValue('diff_comments'),
    [{ id: 'c1', body: 'here' }],
    'this is what Electron gets from the preload re-seeding itself from main',
  );
});

test('the three snapshot layers compose: defaults, then config, then stored', () => {
  // `pending_worktrees: []` is a bridge default and the renderer calls `.find`
  // on it unguarded, so the stored layer must not be able to remove it -- only
  // to replace it with something of the same shape.
  const storage = makeStorage();
  const config = bootConfig({
    bridge: bridgeConfig({ sharedObjectSnapshot: { from_config: 'yes' } }),
  });

  const first = harness({ window: makeHostWindow({ storage }), config });
  assert.deepEqual(first.window.electronBridge.getSharedObjectSnapshotValue('pending_worktrees'), []);
  sendFromView(first.window, OUTBOUND.sharedObjectSet, { key: 'from_page', value: 1 });

  const second = harness({ window: makeHostWindow({ storage }), config });
  const snapshot = second.window.electronBridge.getSharedObjectSnapshotValue.bind(null);
  assert.deepEqual(snapshot('pending_worktrees'), [], 'the default survives');
  assert.equal(snapshot('from_config'), 'yes', 'and so does the configured value');
  assert.equal(snapshot('from_page'), 1, 'and the last page\'s write is on top');
  assert.equal(snapshot('never_set'), null, 'an unseeded key is still null, not undefined');
});

test('a cleared shared object does not come back on the next boot', () => {
  const storage = makeStorage();

  const first = harness({ window: makeHostWindow({ storage }) });
  sendFromView(first.window, OUTBOUND.sharedObjectSet, { key: 'transient', value: { a: 1 } });
  sendFromView(first.window, OUTBOUND.sharedObjectSet, { key: 'transient' });
  assert.equal(first.host.services.stats().sharedObjectsCleared, 1);

  const second = harness({ window: makeHostWindow({ storage }) });
  assert.equal(second.window.electronBridge.getSharedObjectSnapshotValue('transient'), null);
});

test('a stored null survives as null rather than being dropped', () => {
  // `undefined` deletes and `null` is a value: collapsing them would put a
  // null in front of main's `.find` on a key whose guard is for undefined.
  const storage = makeStorage();
  const first = harness({ window: makeHostWindow({ storage }) });
  sendFromView(first.window, OUTBOUND.sharedObjectSet, { key: 'explicit_null', value: null });

  const second = harness({ window: makeHostWindow({ storage }) });
  assert.equal(second.window.electronBridge.getSharedObjectSnapshotValue('explicit_null'), null);
  assert.equal(second.host.stores.sharedObjectStore.get('explicit_null'), null);
});

test('the shared-object key space does not collide with the other two', () => {
  const storage = makeStorage();
  const stores = createBootStorage(makeHostWindow({ storage }));
  stores.atomStore.set('settings', { fromAtoms: true });
  stores.sharedObjectStore.set('settings', { fromSharedObjects: true });
  assert.equal(storage.data.size, 2);
  assert.deepEqual(stores.atomStore.get('settings'), { fromAtoms: true });
  assert.deepEqual(stores.sharedObjectStore.get('settings'), { fromSharedObjects: true });
});

test('an unreadable stored shared object is skipped, not fatal', () => {
  const storage = makeStorage();
  storage.data.set('codex-relay-host:shared:half-written', '{"not json');
  storage.data.set('codex-relay-host:shared:fine', '{"ok":true}');
  const { host, window } = harness({ window: makeHostWindow({ storage }) });

  assert.equal(host.ok, true, 'one bad key does not cost the page its boot');
  assert.deepEqual(window.electronBridge.getSharedObjectSnapshotValue('fine'), { ok: true });
  assert.equal(window.electronBridge.getSharedObjectSnapshotValue('half-written'), null);
});

test('a store that refuses writes loses the mirror and nothing else', () => {
  // The renderer wrote its own copy before dispatching, so the page stays
  // correct for as long as it lives -- only the reload is lost.
  const { host, window } = harness({
    window: makeHostWindow({ storage: makeStorage({ refuseWrites: true }) }),
  });
  sendFromView(window, OUTBOUND.sharedObjectSet, { key: 'k', value: 1 });
  assert.equal(host.ok, true);
  // In-memory fallback: the write lands, it simply does not outlive the page.
  assert.equal(host.stores.persistent, false);
  assert.equal(host.services.stats().sharedObjectsMirrored, 1);
});

// ---- the focus layer, through the whole boot -------------------------------

test('the renderer request is answered, which no other layer would do', () => {
  // Unanswered, the renderer's focus atom stays at `null` -- not `false` --
  // and the first-run splash has no timeout behind it. An already-onboarded
  // user never reaches that route, which is why this went unnoticed through
  // every end-to-end drive until the outbound types were swept.
  const { window, inbound, host } = harness();
  sendFromView(window, OUTBOUND.electronWindowFocusRequest, {});

  const replies = inbound.ofType('electron-window-focus-changed');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].isFocused, true);
  assert.equal(host.focus.stats().requestsAnswered, 1);
});

test('focus keeps pushing after the first answer, because the renderer stopped listening to the browser', () => {
  // `IGe.setEventListener(Fvc)` REPLACES TanStack Query's own
  // `visibilitychange` listener with this message. A host that answered once
  // and went quiet would leave refetch-on-focus wired to a dead source.
  const { window, inbound, host } = harness();
  sendFromView(window, OUTBOUND.electronWindowFocusRequest, {});
  window._goBackground();
  window._goForeground();

  assert.deepEqual(
    inbound.ofType('electron-window-focus-changed').map((m) => m.isFocused),
    [true, false, true],
  );
  assert.equal(host.focus.stats().pushed, 3);
});

test('uninstall detaches the focus listeners with everything else', () => {
  const { window, inbound, host } = harness();
  host.uninstall();
  window._goBackground();
  assert.deepEqual(inbound.ofType('electron-window-focus-changed'), []);
});

test('none of the swept outbound types is reported as unclaimed any more', async () => {
  // That report exists to say "the next App update added a type nobody has
  // read yet". With twenty-seven known types arriving every session it could
  // not say that, which is the real cost of filing them under harmless.
  const { window, host, events, fake } = harness();
  for (const type of [
    OUTBOUND.electronWindowFocusRequest,
    OUTBOUND.sharedObjectSet,
    ...Object.keys(ELECTRON_ONLY_PUSHES),
  ]) {
    sendFromView(window, type, { key: 'k', value: 1 });
  }

  assert.deepEqual(events.filter((event) => event.kind === 'outbound-unclaimed'), []);
  assert.equal(host.bus.stats.unclaimed, 0);

  // And a type nobody has seen still is, which is the point of keeping it.
  sendFromView(window, 'electron-some-future-thing', {});
  assert.deepEqual(
    events.filter((event) => event.kind === 'outbound-unclaimed').map((event) => event.type),
    ['electron-some-future-thing'],
  );
  answerHandshake(fake);
  await host.announced;
});

// ---- the settings seed -----------------------------------------------------

test('settings defaults are seeded, because iOS zooms a sub-16px input', async () => {
  // Measured: focusing an input whose computed font size is under 16px zooms
  // the whole page on iOS, and the renderer sizes its text off this value.
  // host-touch.css raises the CSS token, but it cannot reach every field the
  // renderer sizes from settings, so the two halves have to agree.
  const storage = makeStorage();
  const { host, fake } = harness({ window: makeHostWindow({ storage }) });
  assert.equal(await host.seeded, 1);
  assert.deepEqual(
    JSON.parse(storage.data.get(`codex-relay-host:fetch:${SETTINGS_KEY}`)),
    { sansFontSize: 16 },
  );
  answerHandshake(fake);
  await host.announced;
});

test('the seed never overwrites a value the user chose', async () => {
  const storage = makeStorage();
  storage.data.set(`codex-relay-host:fetch:${SETTINGS_KEY}`, JSON.stringify({ sansFontSize: 22 }));
  const { host, fake } = harness({ window: makeHostWindow({ storage }) });
  assert.equal(await host.seeded, 0, 'a seed that overwrote would undo the settings screen on reload');
  assert.deepEqual(
    JSON.parse(storage.data.get(`codex-relay-host:fetch:${SETTINGS_KEY}`)),
    { sansFontSize: 22 },
  );
  answerHandshake(fake);
  await host.announced;
});

test('the seeded value is what get-settings then answers with', async () => {
  const { window, inbound, host, fake } = harness({ window: makeHostWindow() });
  await host.seeded;
  sendFromView(window, OUTBOUND.fetch, {
    requestId: 'request-settings',
    method: 'POST',
    url: `${FETCH_URL_PREFIX}get-settings`,
  });
  await settle();
  const [reply] = inbound.ofType('fetch-response');
  // The body is the decoded object, not a JSON string: the renderer's own
  // fetch shim hands the parsed value to its caller.
  assert.deepEqual(reply.body.values, { sansFontSize: 16 });
  answerHandshake(fake);
  await host.announced;
});

// ---- the websocket URL -----------------------------------------------------

test('the socket scheme follows the page, so no deployment has to configure it', () => {
  assert.equal(
    webSocketUrl(makeHostWindow({ href: 'https://relay.invalid/app/' }), '/ws'),
    'wss://relay.invalid/ws',
  );
  assert.equal(
    webSocketUrl(makeHostWindow({ href: 'http://127.0.0.1:8787/app/' }), '/ws'),
    'ws://127.0.0.1:8787/ws',
  );
  // A configured ws:// on an https page is refused by the browser as mixed
  // content, and the error names the socket rather than the config that chose
  // it, which is why the scheme is derived and never carried.
  assert.equal(webSocketUrl(makeHostWindow({ href: 'https://relay.invalid/app/' })), 'wss://relay.invalid/ws');
});

// ---- teardown --------------------------------------------------------------

test('uninstall unwinds every layer it installed', async () => {
  const { host, fake, window } = harness();
  answerHandshake(fake);
  await host.announced;
  const port = connectAppHost(window);
  assert.equal(host.handshake.status, 'answered', 'the session has to exist before uninstall can drop it');

  await host.uninstall();

  assert.equal(host.link.closed, true);
  assert.equal(host.touch.installed, false);
  assert.equal(fake.closedByClient, true);
  assert.equal('electronBridge' in window, false, 'the bridge removed what it added');

  // The one layer uninstall used to walk past. `handshake.unsubscribe()` stops
  // the window listener and deliberately leaves the session alone -- see
  // web/host-handshake.mjs on why staying subscribed matters -- so if
  // uninstall does not close the session, nothing does, and the port the
  // renderer transferred stays open with a dead host's onmessage on it.
  assert.equal(port.closed, true, 'the capnweb session kept the renderer port open');
  assert.equal(port.onmessage, null, 'and kept a dead host listening on it');
  assert.equal(host.handshake.listening, false);
});

test('uninstall is still safe when no renderer ever handshook', async () => {
  // The session is created by a message that may never arrive -- an unpatched
  // document, or a renderer that failed before app-shared.js ran. Reaching for
  // `.close()` on that absence must not turn a teardown into a thrown error.
  const { host } = harness();
  assert.equal(host.handshake.session, null);
  await host.uninstall();
  assert.equal(host.handshake.listening, false);
});

test('uninstalling twice closes the session once and throws neither time', async () => {
  const { host, fake, window } = harness();
  answerHandshake(fake);
  await host.announced;
  const port = connectAppHost(window);

  await host.uninstall();
  await host.uninstall();
  assert.equal(port.closed, true);
});

// ---- the namespaces, which is where a completed turn used to die -----------

test('the handshake answers with the namespaces layer, not with an empty object', () => {
  // The seam. Every piece below has its own suite; what none of them can test
  // is that boot actually HANDS the namespaces to the handshake. It did not,
  // for as long as this host existed: `installHandshake` defaults `services`
  // to `{}`, the default was taken, and the renderer got 125 undefined
  // namespaces. 117 of those degrade correctly on absence, which is
  // exactly why the bug survived a boot, a login, a thread list and a
  // streamed turn before killing the page on the 61st.
  const { window, host, fake } = harness();
  const port = connectAppHost(window);

  port.deliver(['push', ['pipeline', 0, ['services']]]);
  port.deliver(['pull', 1]);

  // Every namespace crosses BY VALUE, carrying one capability per member.
  // The ids are part of the contract, not an implementation detail: the page
  // addresses a member by id alone, so reordering the services object
  // re-points every call site in the renderer at a different method. They are
  // allocated in iteration order of the services object, which is why they
  // read alphabetically here.
  assert.deepEqual(
    port.posted,
    [['resolve', 1, {
      appInfo: { get: ['export', -1] },
      clipboard: { writeText: ['export', -2] },
      computerUseSettings: {
        getAppApprovals: ['export', -3],
        getMessagesReadDecisions: ['export', -4],
        getMessagesSendApprovals: ['export', -5],
        searchMessagesChats: ['export', -6],
        getSoundMode: ['export', -7],
        getLockedUseState: ['export', -8],
        removeAppApproval: ['export', -9],
        removeMessagesReadDecision: ['export', -10],
        removeMessagesSendApproval: ['export', -11],
        setLockedUseEnabled: ['export', -12],
        setMessagesReadAccessPolicy: ['export', -13],
        setMessagesReadDecision: ['export', -14],
        setMessagesSendAllowAllChats: ['export', -15],
        setSoundMode: ['export', -16],
      },
      customAvatars: {
        load: ['export', -17],
        loadAvatar: ['export', -18],
      },
      fileAttachments: { countFolderFiles: ['export', -19] },
      openIn: {
        getTargets: ['export', -20],
        open: ['export', -21],
        setGlobalPreferredTarget: ['export', -22],
      },
      requestUserInputAutoResolution: {
        setConversationPresented: ['export', -23],
        recordConversationActivity: ['export', -24],
        snooze: ['export', -25],
      },
      workspaceFiles: { read: ['export', -26] },
    }]],
    'the namespaces cross by value, carrying one capability per member',
  );
  answerHandshake(fake);
  return host.announced;
});

test('a namespace absent from the services object stays absent on the wire', () => {
  // The 60. If this frame ever grows a key for a namespace nobody implemented,
  // the renderer stops taking its host-absent branch for that namespace and
  // starts calling into nothing.
  const { window, host, fake } = harness();
  const port = connectAppHost(window);
  port.deliver(['push', ['pipeline', 0, ['services']]]);
  port.deliver(['pull', 1]);

  const resolved = port.posted[0][2];
  assert.deepEqual(Object.keys(resolved), Object.keys(createHostNamespaces().services));
  for (const absent of ['hostedThreadFiles', 'notifications', 'projects', 'ui']) {
    assert.equal(absent in resolved, false, `${absent} must not appear`);
  }
  answerHandshake(fake);
  return host.announced;
});

test('the call the renderer makes in its layout effect arrives at the host', () => {
  // The exact frame app-initial produces for
  //   Se.requestUserInputAutoResolution.setConversationPresented?.(
  //     {conversationId: u, hostId: d, presented: !0})
  // once `Se.requestUserInputAutoResolution` is a stub: a pipeline push on the
  // capability id we exported, with the argument in capnweb's escaped-array
  // form. Nothing pulls it -- the call site discards the result -- so this
  // also pins that the call runs on push.
  const { window, host, fake } = harness();
  const port = connectAppHost(window);
  port.deliver(['push', ['pipeline', 0, ['services']]]);
  port.deliver(['pull', 1]);

  // -23 is `setConversationPresented` itself -- each member is its own
  // capability -- so the path is empty, which is what the peer's `apply` trap
  // sends for a stub it holds directly. The id comes from the frame asserted
  // above; it is 23 and not 1 because twenty-two members sort ahead of it, and
  // it moved from 9 when computerUseSettings added fourteen.
  port.deliver(['push', ['pipeline', -23, [],
    [[{ conversationId: 'c1', hostId: 'local', presented: true }]]]]);

  assert.equal(host.namespaces.stats().presented, 1);
  assert.equal(
    host.namespaces.stats().calls['requestUserInputAutoResolution.setConversationPresented'],
    1,
  );
  assert.equal(port.posted.length, 1, 'a fire-and-forget call is not answered until it is pulled');
  answerHandshake(fake);
  return host.announced;
});

// ---- what this host could not do, kept where a probe can read it -----------
//
// The thing being tested is a diagnostic, so the tests are mostly about what it
// is NOT: not unbounded, not a live array, not a property, not a channel for
// anything the user typed, and not able to break a host call. The one positive
// claim -- that the four kinds a reader actually needs are in there -- is the
// first test, and it fails without the `report` repair that goes with it.

test('a sub-layer event reaches its consumer under the name this file gave it', async () => {
  // `report` writes `kind` AFTER spreading the detail. It did not, and the
  // sub-layers pass their own event object through as the detail with its own
  // `kind` on it, so every prefix this file computes was discarded at the
  // moment it was applied: `fetch:endpoint-unimplemented` arrived as
  // `endpoint-unimplemented`. Without the repair the second assertion below
  // fails and the first one passes inverted, which is the whole defect in two
  // lines -- and it matters beyond the name, because the unprefixed names
  // collide between layers and a consumer filtering on one was filtering on
  // several.
  const { window, host, fake, kinds } = harness();
  sendFromView(window, OUTBOUND.fetch, {
    requestId: 'request-1',
    method: 'POST',
    url: `${FETCH_URL_PREFIX}no-such-endpoint`,
  });
  await settle();

  assert.ok(kinds().includes('fetch:endpoint-unimplemented'), 'the layer the event came from is part of its name');
  assert.equal(kinds().includes('endpoint-unimplemented'), false, 'the prefix was computed and then thrown away');
  answerHandshake(fake);
  await host.announced;
});

test('the record keeps the events that mean this host could not do the thing', async () => {
  const { window, host, fake } = harness();

  // One endpoint that is in KNOWN_ENDPOINTS with nothing behind it and one that
  // is in no list at all. `known` is the whole difference between "the renderer
  // asked for something we have not built yet" and "the next App update added
  // an endpoint nobody here has heard of", and it is the field that tells a
  // reader which of those they are looking at.
  sendFromView(window, OUTBOUND.fetch, {
    requestId: 'request-1',
    method: 'POST',
    url: `${FETCH_URL_PREFIX}automation-create`,
  });
  sendFromView(window, OUTBOUND.fetch, {
    requestId: 'request-2',
    method: 'POST',
    url: `${FETCH_URL_PREFIX}an-endpoint-from-a-later-app`,
  });
  await settle();

  // A member this host serves and cannot implement, called through the same
  // function object capnweb exports to the renderer.
  //
  // This was `workspaceFiles.read` until that member got a real filesystem
  // behind it, and the swap is worth a note because of HOW it failed. A served
  // member that reaches the app server does not reject when nothing answers --
  // it waits, because a call this host makes on its own behalf has no deadline
  // from the renderer. So `assert.rejects` stopped rejecting and started
  // hanging, and node --test reported it as eleven CANCELLED tests with zero
  // failures: the await never settled, so neither did the ten tests queued
  // behind it. `web/host-files.mjs` now puts a deadline on every fs call,
  // which is the real repair; this line just needs a member that still cannot
  // do the thing, and `setGlobalPreferredTarget` is one on any host, with or
  // without a disk.
  await assert.rejects(() => host.namespaces.services.openIn.setGlobalPreferredTarget({ target: 'vscode' }));
  await settle();

  // A frame addressed to somebody else's host. The renderer multiplexes hosts
  // and keys its clients by hostId, so this one is not ours to answer.
  sendFromView(window, OUTBOUND.mcpRequest, {
    hostId: 'a-host-that-is-not-this-one',
    request: { method: 'thread/list', params: {}, id: 'renderer-1' },
  });
  await settle();

  const { entries, counts, dropped } = host.degradations();
  assert.deepEqual(entries.map((entry) => entry.kind), [
    'fetch:endpoint-unimplemented',
    'fetch:endpoint-unimplemented',
    'namespaces:declined',
    'link:foreign-host-id',
  ]);
  assert.deepEqual(entries[0], {
    seq: 1,
    kind: 'fetch:endpoint-unimplemented',
    endpoint: 'automation-create',
    known: true,
    shaped: false,
  });
  assert.deepEqual(entries[1], {
    seq: 2,
    kind: 'fetch:endpoint-unimplemented',
    endpoint: 'an-endpoint-from-a-later-app',
    known: false,
    shaped: false,
  });
  assert.equal(entries[2].member, 'openIn.setGlobalPreferredTarget', 'which member, not how many members');
  assert.match(entries[2].reason, /nowhere to persist/, 'the decline table is in this repository');
  assert.deepEqual(entries[3], { seq: 4, kind: 'link:foreign-host-id', type: OUTBOUND.mcpRequest });
  assert.equal(
    'hostId' in entries[3], false,
    'the count is already on link.stats; the id is the part that cannot be shown to be safe',
  );
  assert.deepEqual(counts, {
    'fetch:endpoint-unimplemented': 2,
    'namespaces:declined': 1,
    'link:foreign-host-id': 1,
  });
  assert.equal(dropped, 0);
  answerHandshake(fake);
  await host.announced;
});

test('a shaped endpoint and a blank one are both recorded, and say which they are', async () => {
  // `shaped` is only worth a field in the retained row if a reader can act on
  // it, and the census above cannot show that: both of its endpoints answer
  // out of the blank, so a `shaped` that was hardcoded false -- or dropped in
  // the allowlist copy and read back as undefined -- would pass it.
  //
  // This is the pair that tells them apart. `os-info` has no handler and is
  // still reported, exactly as before, but its reply came from the measured
  // shape table in web/host-fetch.mjs; `automation-create` has no handler and
  // no row, so its reply was `{}`. Both are gaps. Only the second is a gap
  // where nobody has yet read what the renderer does with the answer, and a
  // census of a real session is how that list gets found.
  const { window, host } = harness();

  sendFromView(window, OUTBOUND.fetch, {
    requestId: 'request-1',
    method: 'POST',
    url: `${FETCH_URL_PREFIX}os-info`,
  });
  sendFromView(window, OUTBOUND.fetch, {
    requestId: 'request-2',
    method: 'POST',
    url: `${FETCH_URL_PREFIX}automation-create`,
  });
  await settle();

  const rows = host.degradations().entries
    .filter((entry) => entry.kind === 'fetch:endpoint-unimplemented');
  assert.deepEqual(rows.map((entry) => [entry.endpoint, entry.shaped]), [
    ['os-info', true],
    ['automation-create', false],
  ]);
  // And the field is a boolean on both, not a missing key on one of them: an
  // allowlist that copied only truthy values would read as undefined here and
  // deepEqual against `false` would still pass on the sparse side.
  assert.deepEqual(rows.map((entry) => typeof entry.shaped), ['boolean', 'boolean']);
});

test('a layer that did not install is in the record, with the reason it gave', () => {
  // The same failure the banner test induces. It is kept even though `failures`
  // already has it, because it anchors the sequence: a declined member three
  // entries after a layer that did not install explains itself, and the two
  // read apart do not.
  const { host } = harness({ window: makeHostWindow(), config: bootConfig({ bridge: { appVersion: '' } }) });

  const [entry, ...rest] = host.degradations().entries;
  assert.deepEqual(entry, { seq: 1, kind: 'layer-failed', layer: 'bridge' });
  assert.deepEqual(rest, [], 'a bridge failure degrades exactly one layer');
  // The name and not the reason, even here, where the reason is a literal in
  // web/host-bridge.mjs and would have been safe to keep. The row is shared
  // with two writers whose text is not ours (see the note on it), and a field
  // that is safe on six of eight paths is not a safe field.
  assert.equal(
    host.failures[0].reason,
    'installElectronBridge: config.appVersion must be a non-empty string',
    'the full reason is still on the handle for a reader looking at this page',
  );
});

// The two `layer-failed` reasons this host does not write itself. Every other
// path into that kind supplies a short constant from a module in this repo --
// host-bridge's config refusal, host-touch's missing documentElement -- and
// those are the paths the row was read against when it was given a `reason`
// field. The two below are arbitrary text from somewhere else, and the header
// on the ring promises "no file contents, no paths, no tokens, no session or
// relay identifiers". They are separate tests rather than one because they
// leak by different mechanisms and would be fixed by different code if the
// chosen fix were anything other than dropping the field.

test('a file read that times out is cancelled on the transport, not just rejected', async (t) => {
  // The deadline lives in `createHostFiles` and is enforced by a race, so the
  // CALLER gets its error whether or not the signal goes anywhere. What needs
  // a test is the other half: that the request stops occupying the socket.
  // `client.pendingCount` counts only entries that were not abandoned, so it
  // is 1 while the read is live and 0 once the abort reaches the client --
  // and it would stay 1 if this layer's `call` closure dropped its third
  // argument, which it did until this test existed.
  const { host, fake } = harness();
  answerHandshake(fake);
  await host.announced;

  // Enabled only now, so the handshake above ran on real timers.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reading = host.namespaces.services.workspaceFiles.read({ path: '/w/a.txt', representation: 'text' });
  // Two, not one: the member sends `fs/readFile` and `fs/getMetadata` together
  // (web/host-namespaces.mjs:760) so the stat that becomes the etag costs no
  // second round trip. Both are live, so both have to be let go of below.
  assert.equal(host.link.client.pendingCount, 2, 'bytes and stat are both in flight');

  t.mock.timers.tick(FILE_CALL_TIMEOUT_MS);
  await assert.rejects(reading, /did not answer within/);
  assert.equal(host.link.client.pendingCount, 0, 'and it let go of the socket when it gave up');

  // The late reply is then ignored rather than resolving a read whose caller
  // has already been told it failed.
  fake.receive({ jsonrpc: JSONRPC_VERSION, id: fake.last.id, result: { dataBase64: 'aGk=' } });
});

test('an app-server rejection keeps that it failed, not the sentence the peer wrote', async () => {
  // `startFromHandshake` -> `initializeAppServer` -> `client.call(initialize)`,
  // and a peer that answers with a JSON-RPC error gets its `message` copied
  // verbatim into the rejection by `RpcError.fromResponse`
  // (src/appserver/client.mjs:68-73). Whatever the app server chose to say is
  // then this host's `reason`. It is a real adapter on a real machine, so the
  // sentence can name a path on that machine -- which is the one thing a
  // record meant to be read afterwards, by someone other than its owner,
  // cannot hold.
  const PEER_SENTENCE = 'cannot read /Users/someone/private/AGENTS.md';
  const { host, fake, window } = harness();
  fake.receive({
    jsonrpc: JSONRPC_VERSION,
    id: fake.last.id,
    error: { code: -32603, message: `initialize failed: ${PEER_SENTENCE}` },
  });

  assert.equal(await host.announced, null, 'the handshake failed');

  const snapshot = host.degradations();
  const failed = snapshot.entries.filter((entry) => entry.kind === 'layer-failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].layer, 'app-server');
  const serialised = JSON.stringify(snapshot);
  assert.equal(serialised.includes(PEER_SENTENCE), false, 'a peer wrote that sentence, not this host');
  assert.equal(serialised.includes('AGENTS.md'), false, 'and a path out of it is the worst case');
  assert.deepEqual(Object.keys(failed[0]), ['seq', 'kind', 'layer'], 'the row keeps the layer and nothing else');

  // The other half, and the reason the fix costs nothing: the sentence is
  // still on `failures` for a reader looking at this page now, and still on
  // the banner the user is looking at. What it is not in is the record that
  // outlives the page and gets read by somebody else.
  assert.match(host.failures.find((failure) => failure.name === 'app-server').reason, /AGENTS\.md/);
  assert.match(bannerText(window), /app-server:/);
});

test('a socket the browser refuses keeps that the link failed, not the url it refused', () => {
  // `resolveWebSocket` constructs unwrapped -- `new Ctor(String(target))`,
  // src/appserver/transport-websocket.mjs:32 -- so a refusal throws out
  // through host-boot's `layer('link', ...)` with the browser's own
  // DOMException message, and a CSP refusal embeds the URL it refused. That
  // URL is this relay's, including whatever the surface put in `wsPath`.
  const SESSION = 'SESSION-ID-NOBODY-ELSE-SHOULD-SEE';
  const had = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  globalThis.WebSocket = class {
    constructor(url) {
      throw new Error(
        `Refused to connect to '${url}' because it violates the following `
        + "Content Security Policy directive: \"connect-src 'self'\".",
      );
    }
  };
  try {
    // `transport: null` rather than the harness default, so the layer takes
    // the path a page takes and builds its own socket.
    const { host, window } = harness({
      transport: null,
      config: bootConfig({ wsPath: `/ws?session=${SESSION}` }),
    });

    const snapshot = host.degradations();
    const failed = snapshot.entries.filter((entry) => entry.kind === 'layer-failed');
    assert.deepEqual(failed.map((entry) => entry.layer), ['link']);
    const serialised = JSON.stringify(snapshot);
    assert.equal(serialised.includes(SESSION), false, 'a session identifier is in that url');
    assert.equal(serialised.includes('relay.invalid'), false, 'and so is where this relay lives');
    assert.equal(/wss?:\/\//.test(serialised), false, 'no socket url in any field, present or future');
    assert.deepEqual(Object.keys(failed[0]), ['seq', 'kind', 'layer']);

    assert.match(host.failures.find((failure) => failure.name === 'link').reason, new RegExp(SESSION));
    assert.match(bannerText(window), /link:/);
  } finally {
    if (had) Object.defineProperty(globalThis, 'WebSocket', had);
    else delete globalThis.WebSocket;
  }
});

test('the record keeps no url, no request id and nothing the user typed', async () => {
  const { window, host, fake } = harness();

  // The two fetch events that carry a url. A `codex-fetch://` url carries the
  // query string the renderer built out of whatever the user typed, and a
  // requestId identifies one in-flight request and nothing after that.
  sendFromView(window, OUTBOUND.fetch, {
    requestId: 'request-id-nobody-else-should-see',
    method: 'POST',
    url: 'https://example.invalid/?q=what-the-user-typed',
  });
  sendFromView(window, OUTBOUND.fetch, {
    method: 'POST',
    url: `${FETCH_URL_PREFIX}get-settings?q=what-the-user-typed`,
  });
  // And ordinary traffic that is not a degradation at all: an endpoint that
  // worked, and an atom sync the services layer answered.
  sendFromView(window, OUTBOUND.fetch, {
    requestId: 'request-3',
    method: 'POST',
    url: `${FETCH_URL_PREFIX}get-settings`,
  });
  sendFromView(window, OUTBOUND.persistedAtomSyncRequest, {});
  await settle();

  const snapshot = host.degradations();
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.kind),
    ['fetch:url-unroutable', 'fetch:request-unanswerable'],
    'a request that was answered is not a degradation',
  );
  // Asserted on the serialised snapshot rather than field by field, because
  // what has to be true is that the string is not in there ANYWHERE -- in a
  // field somebody adds later as much as in the two these events carry today.
  const serialised = JSON.stringify(snapshot);
  assert.equal(serialised.includes('what-the-user-typed'), false, 'a query string is whatever the user typed');
  assert.equal(serialised.includes('request-id-nobody-else-should-see'), false);
  assert.equal(serialised.includes('example.invalid'), false);

  // The allow-list, pinned as a list. Neither of these kinds has a field worth
  // keeping, so an entry with a third key means the filter stopped filtering.
  for (const entry of snapshot.entries) {
    assert.deepEqual(Object.keys(entry), ['seq', 'kind'], `${entry.kind} grew a field`);
  }
  answerHandshake(fake);
  await host.announced;
});

test('the services layer is kept where it declined and nowhere else', async () => {
  // That layer reports one event per message handled and most of them are
  // ordinary successes, which would flood a ring this size with the renderer's
  // atom traffic inside a minute. The gate is on the outcome, and the two
  // messages below are one of each.
  const { window, host, fake } = harness();
  sendFromView(window, OUTBOUND.persistedAtomSyncRequest, {});
  sendFromView(window, OUTBOUND.pickWorkspaceRootOption, {});
  await settle();

  const { entries } = host.degradations();
  assert.deepEqual(entries, [{
    seq: 1,
    kind: 'services:handled',
    type: OUTBOUND.pickWorkspaceRootOption,
    outcome: 'canceled',
  }], 'answered is not a degradation; a pick this host cannot perform is');
  answerHandshake(fake);
  await host.announced;
});

test('the record is bounded: the oldest goes and the drops are counted', async () => {
  // The case this bound exists for. `fetch:endpoint-unimplemented` fires once
  // per poll of an endpoint nobody implemented, which is every few seconds for
  // the life of a page that may be open for hours.
  const over = 12;
  const { window, host, fake } = harness();
  for (let index = 0; index < MAX_DEGRADATIONS + over; index += 1) {
    sendFromView(window, OUTBOUND.fetch, {
      requestId: `request-${index}`,
      method: 'POST',
      url: `${FETCH_URL_PREFIX}endpoint-number-${index}`,
    });
  }
  await settle();

  const { capacity, dropped, counts, entries } = host.degradations();
  assert.equal(capacity, MAX_DEGRADATIONS, 'a reader has to know what the bound was');
  assert.equal(entries.length, MAX_DEGRADATIONS);
  assert.equal(dropped, over, 'otherwise a truncated record is indistinguishable from a quiet session');
  assert.equal(entries[0].endpoint, `endpoint-number-${over}`, 'the oldest went, not the newest');
  assert.equal(entries.at(-1).endpoint, `endpoint-number-${MAX_DEGRADATIONS + over - 1}`);
  assert.equal(entries[0].seq, dropped + 1, 'the sequence is over retained entries, so these two agree');
  assert.equal(
    counts['fetch:endpoint-unimplemented'], MAX_DEGRADATIONS + over,
    'the per-kind totals survive eviction: a flood can age other evidence out, but not hide itself',
  );
  answerHandshake(fake);
  await host.announced;
});

test('a reader gets a copy, at both levels, and cannot write to the host through it', async () => {
  const { window, host, fake } = harness();
  sendFromView(window, OUTBOUND.fetch, {
    requestId: 'request-1',
    method: 'POST',
    url: `${FETCH_URL_PREFIX}no-such-endpoint`,
  });
  await settle();

  const first = host.degradations();
  first.dropped = 4096;
  first.counts['fetch:endpoint-unimplemented'] = 4096;
  first.entries.push({ seq: 99, kind: 'invented' });
  first.entries[0].endpoint = 'rewritten';

  const second = host.degradations();
  assert.equal(second.dropped, 0);
  assert.equal(second.counts['fetch:endpoint-unimplemented'], 1);
  assert.equal(second.entries.length, 1, 'the array handed out was not the array the ring keeps');
  assert.equal(second.entries[0].endpoint, 'no-such-endpoint', 'nor were the entries in it');
  assert.notEqual(host.degradations().entries, host.degradations().entries, 'and not a shared live array either');
  answerHandshake(fake);
  await host.announced;
});

test('the record is reached by calling, not by reading a property off the handle', async () => {
  // web/host-namespaces.mjs returns its `stats` BESIDE the services object
  // because every own key on that object becomes a namespace the page can see.
  // The equivalent constraint here is the reader on the other end: this handle
  // is what the entry at the bottom of host-boot.mjs parks on
  // `globalThis.__codexRelayHostBoot`, and the only thing that picks it up off
  // a phone is a CDP `Runtime.evaluate` with `returnByValue: true`
  // (tools/probe/bridge-readout.mjs:90), which can carry back only what
  // serialises. The handle cannot -- which is exactly why this is a function
  // naming one serialisable part of it rather than a property on a thing that
  // never crosses.
  const { window, host, fake } = harness();
  sendFromView(window, OUTBOUND.fetch, {
    requestId: 'request-1',
    method: 'POST',
    url: `${FETCH_URL_PREFIX}no-such-endpoint`,
  });
  await settle();

  assert.equal(typeof host.degradations, 'function');
  assert.throws(() => structuredClone(host), 'the handle cannot cross by value, so the snapshot has to');
  const snapshot = host.degradations();
  assert.deepEqual(structuredClone(snapshot), snapshot, 'what a probe gets back is what the host has');

  // No array property holds it. `layers` and `failures` are the only two, they
  // are getters that copy, and the degradation record is deliberately not a
  // third one.
  assert.deepEqual(
    Object.entries(host).filter(([, value]) => Array.isArray(value)).map(([key]) => key),
    ['layers', 'failures'],
  );
  answerHandshake(fake);
  await host.announced;
});

test('a consumer that throws costs the host neither the call nor the record', async () => {
  // The discipline every other host module follows, tested here because this
  // file is now the one that calls the consumer. The second half is why the
  // ring is told BEFORE `onEvent` runs: a broken consumer must not be able to
  // take the record of what went wrong down with it.
  const { window, host, inbound, fake } = harness({
    onEvent: () => {
      throw new Error('the consumer is broken');
    },
  });
  sendFromView(window, OUTBOUND.fetch, {
    requestId: 'request-1',
    method: 'POST',
    url: `${FETCH_URL_PREFIX}no-such-endpoint`,
  });
  await settle();

  const [reply] = inbound.ofType('fetch-response');
  assert.ok(reply, 'an unanswered fetch has no timeout and stalls the whole data layer');
  assert.equal(reply.requestId, 'request-1');
  assert.deepEqual(
    host.degradations().entries.map((entry) => entry.endpoint),
    ['no-such-endpoint'],
    'the ring records first, so the consumer cannot cost it the entry',
  );
  answerHandshake(fake);
  await host.announced;
});
