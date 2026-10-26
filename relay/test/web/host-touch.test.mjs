// What this test is really guarding.
//
// Every defect web/host-touch.mjs and web/host-touch.css address is SILENT. The
// renderer's inbound switch has 189 cases and no `default:`, so a misspelled
// message type does not throw, does not log and is not dropped loudly -- it is
// simply never seen. A selector that names a CSS-module hash matches nothing
// after the next Codex release, with no error. An attribute written once onto
// an element React owns is reverted on the next render, invisibly. So an
// assertion here is not confirming that a happy path works; it is the only
// place where a mobile adaptation that has quietly stopped existing can still
// be noticed.
//
// Which is also why the stylesheet is parsed rather than trusted. It encodes
// most of the policy, it has no runtime of its own to fail in, and the two
// files have to agree on a breakpoint neither can import from the other.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  installHostTouch,
  TOUCH_INBOUND,
  MOBILE_MEDIA_QUERY,
  COARSE_POINTER_MEDIA_QUERY,
  SANS_FONT_SIZE_RANGE,
  WINDOW_ZOOM_RANGE,
  WINDOW_ZOOM_STEP,
} from '../../web/host-touch.mjs';
import { INBOUND } from '../../web/host-protocol.mjs';

const MODULE_PATH = fileURLToPath(new URL('../../web/host-touch.mjs', import.meta.url));

// ---- the type table is a view, not a copy ---------------------------------

test('every type this layer sends is one the protocol table declares', () => {
  // These eight were restated in host-touch.mjs for one wave, because
  // host-protocol.mjs was pinned by an exhaustive deepEqual owned by somebody
  // else at the time. A private copy is exactly where a typo survives: the
  // renderer's inbound switch has 189 cases and no `default:`, so a wrong type
  // is not an error, it is a message that silently goes nowhere. This asserts
  // the copy is gone -- that TOUCH_INBOUND is a selection FROM the protocol
  // table rather than a second table that happens to agree with it today.
  const declared = new Set(Object.values(INBOUND));
  for (const [name, type] of Object.entries(TOUCH_INBOUND)) {
    assert.ok(declared.has(type), `${name} sends ${type}, which no INBOUND entry declares`);
  }
  // And the names line up, so a reader can find the reasoning for any one of
  // them in the place the reasoning lives.
  for (const name of Object.keys(TOUCH_INBOUND)) {
    assert.equal(TOUCH_INBOUND[name], INBOUND[name], `${name} must be INBOUND.${name}`);
  }
});

test('the module reads the types rather than writing them out', () => {
  // The structural half of the test above: a future edit that re-inlines a
  // string literal would still satisfy the value comparison, because the
  // literal and the constant have the same value by construction.
  //
  // Comments are stripped first, and deliberately: the module quotes message
  // shapes like `{type:'navigate-to-route', path:'/settings'}` in prose, which
  // is documentation of the protocol rather than a second source of truth for
  // it. The naive split is safe here only because the file contains no `://`,
  // which this asserts rather than assumes.
  const source = readFileSync(MODULE_PATH, 'utf8');
  assert.equal(source.includes('://'), false, 'the comment strip below would mangle a URL');
  const code = source.split('\n').map((line) => line.split('//')[0]).join('\n');

  for (const type of Object.values(TOUCH_INBOUND)) {
    assert.equal(
      code.includes(`'${type}'`),
      false,
      `${type} is written as a literal in host-touch.mjs; it belongs to INBOUND`,
    );
  }
  assert.match(code, /import \{ INBOUND \} from '\.\/host-protocol\.mjs';/);
});
const STYLESHEET_PATH = fileURLToPath(new URL('../../web/host-touch.css', import.meta.url));

// --- a focused fake document ------------------------------------------------
//
// test/web/host-fakes.mjs models only the message surface: its window has a
// location, an EventTarget and a `documentElement.dataset`, and nothing else,
// because every host module before this one was about messages. This one is
// about the document, so it needs createElement, classList, querySelectorAll,
// matchMedia and a MutationObserver the test can fire by hand. Those live here
// instead of being added to the shared fake because host-fakes.mjs is pinned by
// the other host tests.
//
// Two deliberate choices in the fake, both of which make the module's job
// harder rather than easier:
//
//   - querySelectorAll THROWS on any selector it does not understand, instead
//     of returning an empty list. A fake that quietly matches nothing is how a
//     test passes while the feature is dead.
//   - flushMutations() delivers to every connected observer regardless of what
//     actually changed, because a real MutationObserver also coalesces and
//     over-delivers. The module has to be idempotent per delivery, so the fake
//     should test that rather than hide it.

function fakeElement(doc, tag) {
  const attributes = new Map();
  const classes = new Set();

  const element = {
    tagName: tag,
    children: [],
    parent: null,

    classList: {
      add(name) {
        classes.add(name);
      },
      remove(name) {
        classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
      get length() {
        return classes.size;
      },
    },

    getAttribute(name) {
      if (name === 'class') return classes.size > 0 ? [...classes].join(' ') : null;
      return attributes.has(name) ? attributes.get(name) : null;
    },

    setAttribute(name, value) {
      if (name === 'class') {
        classes.clear();
        for (const token of String(value).split(/\s+/)) if (token) classes.add(token);
      } else {
        attributes.set(name, String(value));
      }
      doc.recordMutation();
    },

    removeAttribute(name) {
      if (name === 'class') classes.clear();
      else attributes.delete(name);
      doc.recordMutation();
    },

    appendChild(child) {
      element.children.push(child);
      child.parent = element;
      doc.recordMutation();
      return child;
    },

    remove() {
      if (element.parent) {
        element.parent.children = element.parent.children.filter((candidate) => candidate !== element);
        element.parent = null;
      }
      doc.recordMutation();
    },

    // Section 4's gate. It walks ancestors because the thing a finger lands on
    // inside a menu item is usually a span or an svg, not the item: a check on
    // the target alone would pass in a test and miss most real taps.
    closest(selector) {
      const parts = selector.split(',').map((part) => part.trim());
      let node = element;
      while (node) {
        if (parts.some((part) => matchesSimpleSelector(node, part))) return node;
        node = node.parent;
      }
      return null;
    },
  };

  return element;
}

function descendants(element) {
  const out = [];
  const stack = [...element.children];
  while (stack.length > 0) {
    const next = stack.pop();
    out.push(next);
    stack.push(...next.children);
  }
  return out;
}

function matchesSelector(element, selector) {
  const attributeOnly = /^\[([a-z-]+)\]$/.exec(selector);
  if (!attributeOnly) {
    throw new Error(`fake querySelectorAll: unsupported selector ${selector}`);
  }
  return element.getAttribute(attributeOnly[1]) !== null;
}

// Same discipline as matchesSelector and for the same reason: a fake that
// quietly matches nothing would let COPY_ACTIVATION_SELECTOR be rewritten into
// something no element can satisfy with every test still green.
function matchesSimpleSelector(element, selector) {
  const attributeValue = /^\[([a-z-]+)="([a-z-]+)"\]$/.exec(selector);
  if (attributeValue) return element.getAttribute(attributeValue[1]) === attributeValue[2];
  if (/^[a-z]+$/.test(selector)) return element.tagName === selector;
  throw new Error(`fake closest: unsupported selector ${selector}`);
}

function fakeDocument() {
  const listeners = [];
  let mutations = 0;

  const doc = {
    selectorsQueried: [],
    recordMutation() {
      mutations += 1;
    },
    get mutationCount() {
      return mutations;
    },
    createElement(tag) {
      return fakeElement(doc, tag);
    },
    querySelectorAll(selector) {
      doc.selectorsQueried.push(selector);
      return descendants(doc.documentElement).filter((element) => matchesSelector(element, selector));
    },
    getElementById(id) {
      return descendants(doc.documentElement).find((element) => element.getAttribute('id') === id) ?? null;
    },
    addEventListener(type, handler, capture = false) {
      listeners.push({ type, handler, capture });
    },
    removeEventListener(type, handler, capture = false) {
      const index = listeners.findIndex(
        (entry) => entry.type === type && entry.handler === handler && entry.capture === capture,
      );
      if (index >= 0) listeners.splice(index, 1);
    },
    get listeners() {
      return [...listeners];
    },
    dispatch(type, event) {
      for (const entry of [...listeners]) {
        if (entry.type === type) entry.handler(event);
      }
    },
  };

  doc.documentElement = fakeElement(doc, 'html');
  doc.head = doc.documentElement.appendChild(fakeElement(doc, 'head'));
  doc.body = doc.documentElement.appendChild(fakeElement(doc, 'body'));
  mutations = 0;

  return doc;
}

function fakeWindow({ media = {}, mutationObserver = true } = {}) {
  const doc = fakeDocument();
  const posted = [];
  const observers = new Set();

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.target = null;
      this.options = null;
    }

    observe(target, options) {
      this.target = target;
      this.options = options;
      observers.add(this);
    }

    disconnect() {
      observers.delete(this);
    }
  }

  const win = {
    document: doc,
    posted,
    observers,
    matchMediaQueries: [],
    postMessage(data, targetOrigin) {
      posted.push({ data, targetOrigin });
    },
    matchMedia(query) {
      win.matchMediaQueries.push(query);
      return { media: query, matches: media[query] === true };
    },
    flushMutations() {
      for (const observer of [...observers]) observer.callback([], observer);
    },
  };

  if (mutationObserver) win.MutationObserver = FakeMutationObserver;

  return win;
}

function mountFrame(win, attributes = {}) {
  const frame = win.document.createElement('div');
  frame.setAttribute('data-app-shell-frame', 'true');
  for (const [name, value] of Object.entries(attributes)) frame.setAttribute(name, value);
  win.document.body.appendChild(frame);
  return frame;
}

function mountLeftPanel(win) {
  const panel = win.document.createElement('aside');
  panel.setAttribute('class', 'app-shell-left-panel pointer-events-auto relative overflow-visible');
  win.document.body.appendChild(panel);
  return panel;
}

const phone = () => fakeWindow({ media: { [MOBILE_MEDIA_QUERY]: true, [COARSE_POINTER_MEDIA_QUERY]: true } });

// --- a fake clipboard, a fake pasteboard, and timers the test can fire ------
//
// Three properties of the real thing are modelled, because section 4 depends
// on all three and a flat stub would hide all three:
//
//   - `writeText` is INHERITED. On every engine it lives on Clipboard.prototype
//     and `navigator.clipboard` has no own copy. A fake with an own method
//     would let an uninstall that restores by assignment look correct while
//     leaving a permanent own property on the real navigator.
//   - a ClipboardItem's data may be a PROMISE, and per spec a rejected one
//     aborts the write leaving the pasteboard unmodified. So the fake resolves
//     the promise before it records anything, and records nothing if it
//     rejects. That is the only reason an abandoned prime is safe.
//   - a refusal is a REJECTED PROMISE, not a throw. WebKit rejects with a
//     NotAllowedError DOMException; the name is reproduced because a stub that
//     rejects with a bare Error would not notice code reading `error.name`.
//
// `settings` is read at call time rather than captured, so one test can make a
// browser that refuses the plain write and then performs the primed one --
// which is exactly the browser this whole section exists for.

class FakeBlob {
  constructor(parts, options) {
    this.parts = parts;
    this.type = options?.type;
  }

  get text() {
    return this.parts.join('');
  }
}

class FakeClipboardItem {
  constructor(data) {
    this.data = data;
    this.types = Object.keys(data);
  }
}

function refusal(what) {
  return Object.assign(new Error(`${what} is not allowed without a user gesture`), { name: 'NotAllowedError' });
}

function fakeClipboard(settings) {
  const pasteboard = [];
  const calls = { writeText: [], write: [] };

  const prototype = {
    writeText(text) {
      calls.writeText.push(text);
      if (!settings.plainWriteSucceeds) return Promise.reject(refusal('writeText'));
      pasteboard.push(text);
      return Promise.resolve();
    },

    write(items) {
      calls.write.push(items[0]);
      if (!settings.primedWriteSucceeds) return Promise.reject(refusal('write'));
      return Promise.resolve(items[0].data['text/plain']).then((blob) => {
        pasteboard.push(blob.text);
      });
    },
  };

  return { object: Object.create(prototype), prototype, settings, calls, pasteboard };
}

function fakeTimers() {
  let nextId = 1;
  const scheduled = new Map();

  return {
    setTimeout(callback, delay) {
      const id = nextId;
      nextId += 1;
      scheduled.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      scheduled.delete(id);
    },
    get pending() {
      return [...scheduled.values()];
    },
    run() {
      const due = [...scheduled.values()];
      scheduled.clear();
      for (const entry of due) entry.callback();
    },
  };
}

function phoneWithClipboard({ plainWriteSucceeds = true, primedWriteSucceeds = true } = {}) {
  const win = phone();
  const timers = fakeTimers();
  const clipboard = fakeClipboard({ plainWriteSucceeds, primedWriteSucceeds });

  win.setTimeout = timers.setTimeout;
  win.clearTimeout = timers.clearTimeout;
  win.Blob = FakeBlob;
  win.ClipboardItem = FakeClipboardItem;
  win.navigator = { clipboard: clipboard.object };
  win.timers = timers;
  win.clipboard = clipboard;

  return win;
}

// A context-menu item as Radix renders it: app-shared @833292 builds it from
// `(0,cy.jsx)(Mg.div,{role:`menuitem`,…})`, and the descriptor's id at @6468167
// is passed as the React key only, so the role is genuinely all there is to
// match. The span is not decoration either -- @832628 is
// `onPointerUp:Wg(e.onPointerUp,e=>{l.current||e.currentTarget?.click()})`, so
// the click that reaches the document is synthesised from wherever the finger
// landed, which is usually a child of the item.
function mountMenuItem(win, role = 'menuitem') {
  const item = win.document.createElement('div');
  item.setAttribute('role', role);
  win.document.body.appendChild(item);
  const label = win.document.createElement('span');
  item.appendChild(label);
  return { item, label };
}

// Lets every already-queued microtask and the fake clipboard's own `.then`
// chain run, which is where a write either lands on the pasteboard or does not.
const settle = () => new Promise((resolve) => { setImmediate(resolve); });

// --- installation -----------------------------------------------------------

test('install links the stylesheet and enables the responsive sidebar', () => {
  const win = phone();
  const frame = mountFrame(win, { 'data-app-shell-responsive-sidebar': 'false' });

  const handle = installHostTouch({ window: win });

  assert.equal(
    win.document.documentElement.classList.length,
    0,
    'adding .electron-opaque here was futile and is gone: the renderer\'s own useLayoutEffect runs classList.remove on mount, before the first paint, because the state it reads starts false',
  );
  assert.equal(
    frame.getAttribute('data-app-shell-responsive-sidebar'),
    'true',
    'the string "true" is what the bundle\'s own sub-768px rules match; React stringifies the boolean prop, so anything else leaves the sidebar taking 240 of 390 pixels',
  );
  assert.equal(handle.stylesheetLink.getAttribute('rel'), 'stylesheet');

  const href = handle.stylesheetLink.getAttribute('href');
  assert.ok(
    href.endsWith('/web/host-touch.css'),
    'the default href is resolved against the module URL, because the relay mounts web/ under a prefix and serves the bundle document from the mount root: a document-relative path would 404 in a network panel nobody is watching, with the mobile layout simply absent',
  );
  assert.equal(
    existsSync(fileURLToPath(href)),
    true,
    'and it has to resolve to a file that is really there, which is the half a path string cannot tell you on its own',
  );
  assert.equal(
    win.document.head.children.length,
    1,
    'the stylesheet is injected rather than written into the served page, because that page is generated and not ours to edit',
  );
});

test('the frame is found by attribute, never by its hashed class', () => {
  const win = phone();
  mountFrame(win);

  installHostTouch({ window: win });

  assert.deepEqual(
    win.document.selectorsQueried,
    ['[data-app-shell-frame]'],
    'the frame class is _Layout_yl8z4_2, a build-generated hash: a class lookup would start matching nothing after the next release with no error anywhere',
  );
});

test('install refuses a missing window or document instead of degrading silently', () => {
  assert.throws(() => installHostTouch(), TypeError);
  assert.throws(() => installHostTouch({ window: null }), TypeError);
  assert.throws(() => installHostTouch({ window: {} }), TypeError);
  assert.throws(() => installHostTouch({ window: { document: {} } }), TypeError);
});

test('a null stylesheetHref skips the link for a page that already carries it', () => {
  const win = phone();

  const handle = installHostTouch({ window: win, stylesheetHref: null });

  assert.equal(handle.stylesheetLink, null);
  assert.equal(win.document.head.children.length, 0);
});

test('an existing stylesheet element is not duplicated', () => {
  const win = phone();
  const preexisting = win.document.createElement('link');
  preexisting.setAttribute('id', 'codex-host-touch-stylesheet');
  win.document.head.appendChild(preexisting);

  const handle = installHostTouch({ window: win });

  assert.equal(win.document.head.children.length, 1);
  assert.equal(handle.stylesheetLink, null, 'a link we did not create must not be removed by our uninstall');
});

// --- idempotency ------------------------------------------------------------

test('installing twice returns the first handle and installs nothing more', () => {
  const win = phone();
  mountFrame(win);

  const first = installHostTouch({ window: win });
  const second = installHostTouch({ window: win });

  assert.equal(second, first, 'a second install must not create a second observer and a second document listener');
  assert.equal(second.stats.redundantInstalls, 1);
  assert.equal(win.document.head.children.length, 1);
  assert.equal(win.observers.size, 1);
  assert.equal(win.document.listeners.length, 1);
});

// --- uninstall --------------------------------------------------------------

test('uninstall reverts every change it made', () => {
  const win = phone();
  const frame = mountFrame(win, { 'data-app-shell-responsive-sidebar': 'false' });

  const handle = installHostTouch({ window: win });
  handle.uninstall();

  assert.equal(frame.getAttribute('data-app-shell-responsive-sidebar'), 'false', 'the value found at install time, not a value we invented');
  assert.equal(win.document.head.children.length, 0);
  assert.equal(win.observers.size, 0);
  assert.equal(win.document.listeners.length, 0);
  assert.equal(handle.installed, false);
  assert.equal(win.__codexHostTouch, undefined, 'the marker has to go or a later install returns a dead handle');
});

test('uninstall restores the absence of an attribute, not a false value', () => {
  const win = phone();
  const frame = mountFrame(win);

  installHostTouch({ window: win }).uninstall();

  assert.equal(
    frame.getAttribute('data-app-shell-responsive-sidebar'),
    null,
    'writing "false" where there had been no attribute would leave the page in a state this module invented',
  );
});

test('install touches no class at all, in either direction', () => {
  const win = phone();
  win.document.documentElement.classList.add('electron-opaque');

  const handle = installHostTouch({ window: win });
  assert.equal(win.document.documentElement.classList.contains('electron-opaque'), true);

  handle.uninstall();

  assert.equal(
    win.document.documentElement.classList.contains('electron-opaque'),
    true,
    'a class this module neither adds nor removes cannot be taken off something else that is relying on it',
  );
});

test('uninstall is idempotent and a fresh install works afterwards', () => {
  const win = phone();
  mountFrame(win, { 'data-app-shell-responsive-sidebar': 'false' });

  const handle = installHostTouch({ window: win });
  handle.uninstall();
  handle.uninstall();

  const again = installHostTouch({ window: win });
  assert.notEqual(again, handle);
  assert.equal(again.installed, true);
  again.uninstall();
});

// --- the attribute React keeps taking back ----------------------------------

test('a frame mounted after install is adapted on the next mutation', () => {
  const win = phone();

  const handle = installHostTouch({ window: win });
  assert.equal(handle.stats.framesAdapted, 0, 'React has not mounted the shell yet when the host modules run');

  const frame = mountFrame(win, { 'data-app-shell-responsive-sidebar': 'false' });
  win.flushMutations();

  assert.equal(frame.getAttribute('data-app-shell-responsive-sidebar'), 'true');
  assert.equal(handle.stats.framesAdapted, 1);
});

test('a React re-render that writes the hardcoded false back is overridden again', () => {
  const win = phone();
  const frame = mountFrame(win, { 'data-app-shell-responsive-sidebar': 'false' });
  const handle = installHostTouch({ window: win });

  frame.setAttribute('data-app-shell-responsive-sidebar', 'false');
  win.flushMutations();

  assert.equal(
    frame.getAttribute('data-app-shell-responsive-sidebar'),
    'true',
    'the frame props carry a hardcoded false, so any render that touches them reverts us',
  );
  assert.equal(handle.stats.reassertions, 1);
});

test('re-asserting the attribute does not feed the observer that watches it', () => {
  const win = phone();
  mountFrame(win, { 'data-app-shell-responsive-sidebar': 'false' });
  const handle = installHostTouch({ window: win });

  win.flushMutations();
  win.flushMutations();
  win.flushMutations();

  assert.equal(
    handle.stats.reassertions,
    0,
    'our own write is a mutation the observer is told about; without an early return on the current value the two feed each other',
  );
});

test('the observer is narrowed to the one attribute in a React subtree', () => {
  const win = phone();
  installHostTouch({ window: win });

  const [observer] = [...win.observers];
  assert.equal(observer.target, win.document.documentElement);
  assert.deepEqual(observer.options, {
    subtree: true,
    childList: true,
    attributeFilter: ['data-app-shell-responsive-sidebar'],
  });
});

test('a frame the document no longer contains is dropped rather than retained forever', () => {
  const win = phone();
  const detached = mountFrame(win, { 'data-app-shell-responsive-sidebar': 'false' });

  const handle = installHostTouch({ window: win });
  assert.equal(handle.stats.framesAdapted, 1);

  detached.remove();
  detached.isConnected = false;
  const replacement = mountFrame(win, { 'data-app-shell-responsive-sidebar': 'false' });
  replacement.isConnected = true;
  win.flushMutations();

  assert.equal(
    handle.stats.framesForgotten,
    1,
    'uninstall has to iterate these entries to restore them, so a WeakMap is not available and the bound has to be enforced instead of asserted about React',
  );
  assert.equal(handle.stats.framesAdapted, 2);
  assert.equal(replacement.getAttribute('data-app-shell-responsive-sidebar'), 'true');

  handle.uninstall();

  assert.equal(
    detached.getAttribute('data-app-shell-responsive-sidebar'),
    'true',
    'and the entry really is gone: a node the document no longer contains is not restored, because there is nothing left to restore it for',
  );
  assert.equal(replacement.getAttribute('data-app-shell-responsive-sidebar'), 'false');
});

test('an element that cannot say whether it is attached is kept rather than guessed about', () => {
  const win = phone();
  const frame = mountFrame(win);

  const handle = installHostTouch({ window: win });
  win.flushMutations();

  assert.equal(
    handle.stats.framesForgotten,
    0,
    'the test doubles have no isConnected, and undefined has to mean "cannot tell" rather than "detached", or pruning would throw away the attribute uninstall owes the page',
  );

  handle.uninstall();
  assert.equal(frame.getAttribute('data-app-shell-responsive-sidebar'), null);
});

test('a missing MutationObserver degrades to a one-shot write rather than throwing', () => {
  const win = fakeWindow({ media: { [MOBILE_MEDIA_QUERY]: true }, mutationObserver: false });
  const frame = mountFrame(win, { 'data-app-shell-responsive-sidebar': 'false' });

  const kinds = [];
  const handle = installHostTouch({ window: win, onEvent: (kind) => kinds.push(kind) });

  assert.equal(frame.getAttribute('data-app-shell-responsive-sidebar'), 'true');
  assert.ok(kinds.includes('observer-unavailable'), 'the degradation has to be reportable, not guessed at');
  handle.uninstall();
});

// --- the affordance layer ---------------------------------------------------

test('every remote helper posts the exact payload the renderer switches on', () => {
  const win = phone();
  const handle = installHostTouch({ window: win });
  const { remote } = handle;

  remote.toggleSidebar();
  remote.focusComposer();
  remote.commandMenu();
  remote.commandMenu('diff');
  remote.navigateToRoute('/settings');
  remote.stepFontSize(1);
  remote.stepWindowZoom(-1);
  remote.resetWindowZoom();
  remote.runCommand('toggleSidebar');

  assert.deepEqual(
    win.posted.map((entry) => entry.data),
    [
      { type: 'toggle-sidebar' },
      { type: 'focus-composer' },
      { type: 'command-menu' },
      { type: 'command-menu', query: 'diff' },
      { type: 'navigate-to-route', path: '/settings' },
      { type: 'step-font-size', delta: 1 },
      { type: 'step-window-zoom', delta: -1 },
      { type: 'reset-window-zoom' },
      { type: 'run-command', id: 'toggleSidebar' },
    ],
    'these keys are not guessable: navigate-to-route takes path (not route or url), and run-command takes id',
  );
  assert.equal(handle.stats.posted, 9);
});

test('an explicit empty query is preserved because it is a different code path', () => {
  const win = phone();
  const { remote } = installHostTouch({ window: win });

  remote.commandMenu('');

  assert.deepEqual(
    win.posted[0].data,
    { type: 'command-menu', query: '' },
    'with a query the handler opens, sets the text and selects it; with no query it toggles, so collapsing "" into absent changes the behaviour',
  );
});

test('inbound messages are posted same-origin, which is what passes the renderer sender guard', () => {
  const win = phone();
  installHostTouch({ window: win }).remote.toggleSidebar();

  assert.equal(
    win.posted[0].targetOrigin,
    '/',
    'the literal "/" is the targetOrigin meaning this document\'s own origin, so the message cannot leave the page',
  );
});

test('a malformed payload is rejected here, because the renderer will not reject it', () => {
  const win = phone();
  const { remote } = installHostTouch({ window: win });

  assert.throws(() => remote.navigateToRoute(), TypeError);
  assert.throws(() => remote.navigateToRoute(''), TypeError);
  assert.throws(() => remote.runCommand(undefined), TypeError);
  assert.throws(() => remote.runCommand(''), TypeError);
  assert.throws(() => remote.stepFontSize(), TypeError);
  assert.throws(() => remote.stepFontSize(Number.NaN), TypeError);
  assert.throws(() => remote.stepWindowZoom('1'), TypeError);

  assert.equal(
    win.posted.length,
    0,
    'a delta of undefined reaches a handler that does arithmetic on it and yields a NaN font size, with no exception to point at the call site',
  );
});

test('the inbound types and the documented clamps are the ones read out of the bundle', () => {
  assert.deepEqual(TOUCH_INBOUND, {
    toggleSidebar: 'toggle-sidebar',
    focusComposer: 'focus-composer',
    commandMenu: 'command-menu',
    navigateToRoute: 'navigate-to-route',
    stepFontSize: 'step-font-size',
    stepWindowZoom: 'step-window-zoom',
    resetWindowZoom: 'reset-window-zoom',
    runCommand: 'run-command',
  });
  assert.equal(Object.isFrozen(TOUCH_INBOUND), true);
  assert.deepEqual(SANS_FONT_SIZE_RANGE, { min: 11, max: 16 });
  assert.deepEqual(WINDOW_ZOOM_RANGE, { min: 0.5, max: 3 });
  assert.equal(WINDOW_ZOOM_STEP, 0.1);
});

test('no key event is ever synthesised', () => {
  const source = readFileSync(MODULE_PATH, 'utf8');

  assert.equal(
    source.includes('new KeyboardEvent'),
    false,
    'an untrusted KeyboardEvent has no composition state and no inputType, so a ProseMirror keymap that does fire then mutates a document the browser editing machinery does not know changed',
  );
  assert.equal(
    source.includes('dispatchEvent'),
    false,
    'the renderer subscribes 50 inbound host types and a generic run-command; faking input is a guess where a supported API exists',
  );
});

// --- the scrim tap ----------------------------------------------------------

test('a tap on the scrim closes the sidebar', () => {
  const win = phone();
  const panel = mountLeftPanel(win);
  installHostTouch({ window: win });

  win.document.dispatch('click', { target: panel });

  assert.deepEqual(
    win.posted.map((entry) => entry.data),
    [{ type: 'toggle-sidebar' }],
    'the scrim is the panel\'s own ::before, so a tap on the dimmed area reports the panel itself as the target',
  );
  assert.ok(
    win.matchMediaQueries.includes(MOBILE_MEDIA_QUERY),
    'the viewport width is the one value here that genuinely has to be computed',
  );
});

test('a tap inside the sidebar does not close it', () => {
  const win = phone();
  const panel = mountLeftPanel(win);
  const navigation = win.document.createElement('nav');
  navigation.setAttribute('class', 'sidebar-navigation');
  panel.appendChild(navigation);
  installHostTouch({ window: win });

  win.document.dispatch('click', { target: navigation });

  assert.equal(win.posted.length, 0, 'a descendant target is real sidebar content, not the scrim');
});

test('a tap on the drawer\'s own safe-area padding does not close it', () => {
  const win = phone();
  const panel = mountLeftPanel(win);
  // A 320px drawer on an 844pt-tall phone. The bottom 34px of it is the
  // safe-area padding the stylesheet adds, which has no child to be the event
  // target, so the panel itself is reported for a tap there just as it is for
  // a tap on the scrim.
  panel.getBoundingClientRect = () => ({ left: 0, top: 0, right: 320, bottom: 844 });
  installHostTouch({ window: win });

  win.document.dispatch('click', { target: panel, clientX: 160, clientY: 820 });

  assert.equal(
    win.posted.length,
    0,
    'the target alone cannot tell the scrim from the drawer, because a pseudo-element is not an event target; only the coordinates can',
  );
});

test('a tap on the scrim beside the drawer still closes it', () => {
  const win = phone();
  const panel = mountLeftPanel(win);
  panel.getBoundingClientRect = () => ({ left: 0, top: 0, right: 320, bottom: 844 });
  const handle = installHostTouch({ window: win });

  win.document.dispatch('click', { target: panel, clientX: 360, clientY: 400 });

  assert.deepEqual(win.posted.map((entry) => entry.data), [{ type: 'toggle-sidebar' }]);
  assert.equal(handle.stats.panelTapsIgnored, 0);
});

test('a tap that cannot be located is still treated as a scrim tap', () => {
  const win = phone();
  const panel = mountLeftPanel(win);
  panel.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0 });
  installHostTouch({ window: win });

  win.document.dispatch('click', { target: panel, clientX: 10, clientY: 10 });

  assert.deepEqual(
    win.posted.map((entry) => entry.data),
    [{ type: 'toggle-sidebar' }],
    'a collapsed rect means no layout to compare against, and the failure mode that matters is a drawer that cannot be closed',
  );
});

test('a wide viewport does not treat the panel as a scrim', () => {
  const win = fakeWindow({ media: { [MOBILE_MEDIA_QUERY]: false } });
  const panel = mountLeftPanel(win);
  installHostTouch({ window: win });

  win.document.dispatch('click', { target: panel });

  assert.equal(
    win.posted.length,
    0,
    'above the breakpoint there is no scrim and this same target is the panel padding, where closing the sidebar would be a surprise',
  );
});

test('the tap listener is capture-phase so a stopped bubble cannot swallow it', () => {
  const win = phone();
  installHostTouch({ window: win });

  assert.deepEqual(
    win.document.listeners.map((entry) => [entry.type, entry.capture]),
    [['click', true]],
  );
});

test('the scrim stops responding after uninstall', () => {
  const win = phone();
  const panel = mountLeftPanel(win);
  const handle = installHostTouch({ window: win });
  handle.uninstall();

  win.document.dispatch('click', { target: panel });

  assert.equal(win.posted.length, 0);
});

test('a malformed click event cannot take the page down', () => {
  const win = phone();
  installHostTouch({ window: win });

  win.document.dispatch('click', {});
  win.document.dispatch('click', { target: null });
  win.document.dispatch('click', { target: {} });

  assert.equal(win.posted.length, 0);
});

// --- the clipboard write that has to happen inside the tap ------------------
//
// What these pin is a timing defect, which is the hardest kind to keep fixed:
// every one of them would also pass against a module that did the write one
// task later, if the assertion were only "the text ended up on the pasteboard".
// So the load-bearing assertions here are about WHEN -- `clipboard.write` must
// have been called before `dispatch()` returns -- and about what is on the
// pasteboard when a write does NOT happen, which is nothing.

test('a page with no clipboard to prime is left exactly as it was found', () => {
  const seen = [];
  const bare = phone();

  const bareHandle = installHostTouch({ window: bare, onEvent: (kind) => seen.push(kind) });

  assert.equal(bareHandle.clipboardIntercepted, false);
  assert.equal(bare.navigator, undefined, 'nothing is created on a window that had no navigator');
  assert.ok(seen.includes('gesture-copy-unsupported'));
  bareHandle.uninstall();

  // A clipboard with `writeText` but no `write`, no `ClipboardItem`: the
  // deferred prime IS the mechanism, so an intercept that could never prime is
  // a wrapper that changes nothing and can only add a way to be wrong.
  const partial = phone();
  const prototype = { writeText: () => Promise.resolve() };
  partial.navigator = { clipboard: Object.create(prototype) };
  partial.setTimeout = () => 1;
  partial.clearTimeout = () => {};
  partial.Blob = FakeBlob;

  const partialHandle = installHostTouch({ window: partial });

  assert.equal(partialHandle.clipboardIntercepted, false);
  assert.equal(
    partial.navigator.clipboard.writeText,
    prototype.writeText,
    'an engine missing ClipboardItem keeps its own writeText untouched',
  );
});

test('a browser whose plain writes work is never armed and never primes', async () => {
  const win = phoneWithClipboard();
  const handle = installHostTouch({ window: win });
  const { item } = mountMenuItem(win);

  await win.navigator.clipboard.writeText('https://chatgpt.com/c/abc');
  win.document.dispatch('click', { target: item });
  await win.navigator.clipboard.writeText('/Users/x/notes.md');
  await settle();

  assert.deepEqual(win.clipboard.pasteboard, ['https://chatgpt.com/c/abc', '/Users/x/notes.md']);
  assert.equal(
    win.clipboard.calls.write.length,
    0,
    'arming is a measurement, not a user-agent test: Chromium never refuses a plain write, so it never reaches the primed path at all',
  );
  assert.equal(handle.gesturePrimingArmed, false);
  assert.equal(handle.stats.gesturePrimes, 0);
  assert.equal(win.timers.pending.length, 0, 'and no tap is holding a deadline open on a browser that does not need one');
});

test('a refused plain write arms priming, and the next tap carries the copy', async () => {
  const win = phoneWithClipboard({ plainWriteSucceeds: false });
  const handle = installHostTouch({ window: win });
  const { label } = mountMenuItem(win);

  await assert.rejects(win.navigator.clipboard.writeText('https://chatgpt.com/c/abc'), /not allowed/);
  assert.equal(handle.gesturePrimingArmed, true);
  assert.equal(handle.stats.plainCopiesRefused, 1);
  assert.deepEqual(win.clipboard.pasteboard, [], 'the first copy of the page really is lost; that is the stated residual');

  // The tap. `label` is the span inside the item, because that is what a finger
  // actually lands on. The write has to be ISSUED before dispatch() returns --
  // everything else in this section is downstream of that one fact.
  win.document.dispatch('click', { target: label });
  assert.equal(win.clipboard.calls.write.length, 1);

  const written = win.clipboard.calls.write[0];
  assert.deepEqual(written.types, ['text/plain'], 'the MIME app-initial names at @4556394, not the spec default');

  // One task later, which is what the capnweb hop costs and what WebKit will
  // not forgive.
  await settle();
  await win.navigator.clipboard.writeText('/Users/x/notes.md');
  await settle();

  assert.deepEqual(win.clipboard.pasteboard, ['/Users/x/notes.md']);
  assert.equal((await written.data['text/plain']).type, 'text/plain', 'the Blob carries the type too, as at app-shared @6498085');
  assert.deepEqual(
    win.clipboard.calls.writeText,
    ['https://chatgpt.com/c/abc'],
    'the served copy never reached the native writeText: it resolved the write that the tap had already started',
  );
  assert.equal(handle.stats.gestureCopies, 1);
  assert.equal(win.timers.pending.length, 0, 'a claimed prime clears its deadline');
});

test('a prime nobody claims is rejected, which aborts the write and leaves the pasteboard alone', async () => {
  const win = phoneWithClipboard({ plainWriteSucceeds: false });
  const handle = installHostTouch({ window: win });
  const { item } = mountMenuItem(win);
  await assert.rejects(win.navigator.clipboard.writeText('https://chatgpt.com/c/abc'));

  win.document.dispatch('click', { target: item });
  assert.equal(win.timers.pending[0].delay, 500);

  // The user tapped a menu item that was not a copy. Nothing will ever claim it.
  win.timers.run();
  await settle();

  await assert.rejects(win.clipboard.calls.write[0].data['text/plain'], /expired/);
  assert.deepEqual(
    win.clipboard.pasteboard,
    [],
    'a rejected ClipboardItem promise aborts the write; dropping the prime instead would leave the engine holding a claim',
  );
  assert.equal(handle.stats.gesturePrimesAbandoned, 1);
});

test('a copy that arrives after the deadline fails honestly instead of inventing a success', async () => {
  const win = phoneWithClipboard({ plainWriteSucceeds: false });
  const handle = installHostTouch({ window: win });
  const { item } = mountMenuItem(win);
  await assert.rejects(win.navigator.clipboard.writeText('https://chatgpt.com/c/abc'));

  win.document.dispatch('click', { target: item });
  win.timers.run();
  await settle();

  await assert.rejects(win.navigator.clipboard.writeText('/Users/x/notes.md'), /not allowed/);

  assert.deepEqual(win.clipboard.pasteboard, []);
  assert.equal(handle.stats.gestureCopies, 0);
  assert.equal(
    handle.stats.plainCopiesRefused,
    2,
    'the renderer gets the same rejection it gets today, which runs its own .catch and raises the "Couldn\'t copy" toast (app-shared @6496670)',
  );
});

test('a primed write the engine refuses falls through to a real write, never a reported one', async () => {
  const win = phoneWithClipboard({ plainWriteSucceeds: false, primedWriteSucceeds: false });
  const handle = installHostTouch({ window: win });
  const { item } = mountMenuItem(win);
  await assert.rejects(win.navigator.clipboard.writeText('https://chatgpt.com/c/abc'));

  win.document.dispatch('click', { target: item });
  assert.equal(win.clipboard.calls.write.length, 1);

  // The engine took the call and then refused the write. A browser whose
  // gesture is still live can still do a plain one, so that is tried -- and
  // what is returned is that write's real outcome, not a claim about it.
  win.clipboard.settings.plainWriteSucceeds = true;
  await win.navigator.clipboard.writeText('/Users/x/notes.md');

  assert.deepEqual(win.clipboard.pasteboard, ['/Users/x/notes.md']);
  assert.deepEqual(win.clipboard.calls.writeText, ['https://chatgpt.com/c/abc', '/Users/x/notes.md']);
  assert.equal(handle.stats.gestureCopies, 0, 'nothing counts a copy the prime did not perform');

  // And when the retry fails too, the rejection reaches the renderer unaltered.
  win.clipboard.settings.plainWriteSucceeds = false;
  win.document.dispatch('click', { target: item });
  await assert.rejects(win.navigator.clipboard.writeText('https://chatgpt.com/c/def'), /not allowed/);

  assert.deepEqual(win.clipboard.pasteboard, ['/Users/x/notes.md']);
});

test('an engine that refuses the prime outright leaves the plain path intact', async () => {
  const win = phoneWithClipboard({ plainWriteSucceeds: false });
  const handle = installHostTouch({ window: win });
  const { item } = mountMenuItem(win);
  await assert.rejects(win.navigator.clipboard.writeText('https://chatgpt.com/c/abc'));

  // Throwing synchronously, before any promise exists, is a different failure
  // from rejecting one, and it happens first: the ClipboardItem constructor and
  // write() both validate their arguments before they start anything.
  win.clipboard.prototype.write = () => {
    throw refusal('write');
  };
  win.document.dispatch('click', { target: item });
  assert.equal(handle.stats.gesturePrimesRefused, 1);

  // And an engine returning something that is not a promise is refused the
  // same way rather than reaching `.then` on undefined.
  win.clipboard.prototype.write = () => undefined;
  win.document.dispatch('click', { target: item });
  assert.equal(handle.stats.gesturePrimesRefused, 2);

  assert.equal(win.timers.pending.length, 0, 'a refused prime schedules no deadline, so nothing is left to expire');

  win.clipboard.settings.plainWriteSucceeds = true;
  await win.navigator.clipboard.writeText('/Users/x/notes.md');

  assert.deepEqual(
    win.clipboard.pasteboard,
    ['/Users/x/notes.md'],
    'the copy still takes the plain path rather than waiting on a prime that was never opened',
  );
});

test('only a tap that could be a copy opens a claim on the pasteboard', async () => {
  const win = phoneWithClipboard({ plainWriteSucceeds: false });
  const handle = installHostTouch({ window: win });
  await assert.rejects(win.navigator.clipboard.writeText('https://chatgpt.com/c/abc'));

  const prose = win.document.createElement('p');
  win.document.body.appendChild(prose);
  win.document.dispatch('click', { target: prose });

  assert.equal(
    win.clipboard.calls.write.length,
    0,
    'tapping a paragraph must not hold a pasteboard claim for half a second; the gate is the role Radix renders, because the descriptor ids at app-shared @6468167 are React keys and never reach the DOM',
  );

  for (const role of ['menuitem', 'menuitemradio', 'menuitemcheckbox', 'button']) {
    const { label } = mountMenuItem(win, role);
    win.document.dispatch('click', { target: label });
  }
  const shareButton = win.document.createElement('button');
  win.document.body.appendChild(shareButton);
  win.document.dispatch('click', { target: shareButton });

  assert.equal(
    win.clipboard.calls.write.length,
    5,
    'the four ARIA roles the menu uses plus the bare <button> of the share dialog at app-initial @8183274',
  );

  handle.uninstall();
  await settle();
});

test('a second qualifying tap abandons the first claim rather than racing it', async () => {
  const win = phoneWithClipboard({ plainWriteSucceeds: false });
  const handle = installHostTouch({ window: win });
  const first = mountMenuItem(win);
  const second = mountMenuItem(win);
  await assert.rejects(win.navigator.clipboard.writeText('https://chatgpt.com/c/abc'));

  win.document.dispatch('click', { target: first.label });
  win.document.dispatch('click', { target: second.label });

  assert.equal(handle.stats.gesturePrimes, 2);
  assert.equal(handle.stats.gesturePrimesAbandoned, 1);
  await assert.rejects(win.clipboard.calls.write[0].data['text/plain'], /superseded/);

  await win.navigator.clipboard.writeText('/Users/x/notes.md');
  await settle();

  assert.deepEqual(
    win.clipboard.pasteboard,
    ['/Users/x/notes.md'],
    'one copy, from the tap the user made last; two live claims would race to decide which text the next writeText resolves',
  );
});

test('the patch is an own property, and uninstall takes it back off', async () => {
  const win = phoneWithClipboard({ plainWriteSucceeds: false });
  const handle = installHostTouch({ window: win });
  const clipboard = win.navigator.clipboard;

  assert.equal(handle.clipboardIntercepted, true);
  assert.equal(Object.prototype.hasOwnProperty.call(clipboard, 'writeText'), true);
  assert.notEqual(clipboard.writeText, win.clipboard.prototype.writeText);

  await assert.rejects(clipboard.writeText('https://chatgpt.com/c/abc'));
  const { item } = mountMenuItem(win);
  win.document.dispatch('click', { target: item });
  assert.equal(win.timers.pending.length, 1);

  handle.uninstall();
  await settle();

  assert.equal(
    Object.prototype.hasOwnProperty.call(clipboard, 'writeText'),
    false,
    'restoring means restoring absence: writeText is inherited from Clipboard.prototype, so an assignment would leave an own property the page never had',
  );
  assert.equal(clipboard.writeText, win.clipboard.prototype.writeText);
  assert.equal(win.timers.pending.length, 0, 'a deadline left running would reject a prime nobody owns any more');
  await assert.rejects(win.clipboard.calls.write[0].data['text/plain'], /uninstalled/);
  assert.deepEqual(win.clipboard.pasteboard, []);
  assert.equal(handle.clipboardIntercepted, false);
});

// --- the observer contract --------------------------------------------------

test('an onEvent that throws cannot take the module down with it', () => {
  const win = phone();
  mountFrame(win, { 'data-app-shell-responsive-sidebar': 'false' });

  const handle = installHostTouch({
    window: win,
    onEvent: () => {
      throw new Error('observer is a diagnostic, not a dependency');
    },
  });

  assert.equal(handle.installed, true);
  handle.remote.toggleSidebar();
  assert.equal(win.posted.length, 1);
  handle.uninstall();
});

// --- the stylesheet ---------------------------------------------------------
//
// Parsed with comments stripped first, which is load-bearing: the comments
// quote the bundle's own hashed rules verbatim as evidence, so a scan of the
// raw text would flag our own citations. What matters is what the SELECTORS
// say.

const stylesheet = readFileSync(STYLESHEET_PATH, 'utf8');
const stylesheetRules = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '');

test('the stylesheet names no CSS-module hash', () => {
  const hashed = stylesheetRules.match(/\._[A-Za-z][A-Za-z0-9]*_[a-z0-9]{4,}_\d+/g);

  assert.equal(
    hashed,
    null,
    'a hash is a build output: naming one buys a selector that silently matches nothing after the next Codex release',
  );
});

test('the stylesheet and the module agree on both gates', () => {
  assert.ok(
    stylesheetRules.includes(`@media ${MOBILE_MEDIA_QUERY} {`),
    'the layout gate has to be the complement of the bundle\'s own @media not all and (width>=768px), and the module reads the same width to decide a scrim tap',
  );
  assert.ok(stylesheetRules.includes(`@media ${COARSE_POINTER_MEDIA_QUERY} {`));
});

test('the traffic-light inset is overridden with the value the bundle would compute itself', () => {
  assert.ok(
    stylesheetRules.includes('--spacing-token-safe-header-left: 6px !important'),
    'every iOS user-agent contains "like Mac OS X", so the inset derivation takes the macOS branch and reserves 98px of a 390px viewport for window controls that do not exist',
  );
  assert.ok(stylesheetRules.includes('--spacing-token-safe-header-right: 0px !important'));

  const framePosition = stylesheetRules.indexOf('[data-app-shell-frame] {');
  const coarsePosition = stylesheetRules.indexOf(`@media ${COARSE_POINTER_MEDIA_QUERY}`);
  assert.ok(
    framePosition >= 0 && framePosition < coarsePosition,
    'the inset is wrong in a desktop browser too, because the bundle entry hardcodes codexWindowType to electron everywhere, so this override must not sit behind a pointer gate',
  );
});

test('the soft-keyboard heights are dynamic, not small', () => {
  assert.ok(stylesheetRules.includes('100dvh'));
  assert.equal(
    stylesheetRules.includes('svh'),
    false,
    'svh is defined not to shrink for the keyboard, and the shell sets overflow hidden, so the composer and its send button end up unreachable',
  );
});

test('the iOS auto-zoom fix uses the bundle\'s own override token', () => {
  assert.ok(
    stylesheetRules.includes('--codex-chat-font-size-override: 16px'),
    'the token is a first-class hook the chrome-extension build already drives, so this is the sanctioned lever rather than a selector we invented',
  );
  assert.ok(stylesheetRules.includes('font-size: max(16px, 1em) !important'), 'max() can only raise a size, never shrink one');
});

test('the frameless-window translucency is turned off without the class the renderer removes', () => {
  assert.equal(
    stylesheetRules.includes('electron-opaque'),
    false,
    'the class is gated behind a useLayoutEffect that removes it on mount, so a rule that needs it is a rule that never applies',
  );
  assert.ok(
    /\[data-codex-window-type='electron'\] \{[^}]*background-color: var\(--app-color-background-surface-under\)/.test(stylesheetRules),
    'the same declaration the bundle\'s own .electron-opaque rule carries, with the class dropped out of the selector',
  );
  assert.ok(stylesheetRules.includes("[data-codex-window-type='electron'] body {"));
  assert.ok(
    stylesheetRules.includes("[data-codex-window-type='electron'] :where([data-theme]) {"),
    'a custom property resolves from the nearest ancestor that declares it, not the most specific one, so a theme scope that redeclares the elevated token needs its own rule exactly as the bundle gives it one',
  );

  const opaqueToken = stylesheetRules.match(
    /--app-color-background-elevated-primary: var\(--app-color-background-elevated-primary-opaque\)/g,
  );
  assert.equal(opaqueToken.length, 2, 'once on body and once on the theme scopes, mirroring the two bundle rules');
});

test('the tap-target floor and the send button outset are consistent', () => {
  assert.ok(stylesheetRules.includes('--codex-touch-target: 44px'));
  assert.ok(stylesheetRules.includes('--codex-touch-outset: 8px'), '(44 - 28) / 2 for the measured 28x28 send button');
  assert.ok(
    stylesheetRules.includes("[aria-label='Send']::after"),
    'the send button is the only submit path on a coarse pointer, because the composer keymap deliberately routes Enter to a newline and a soft keyboard has no Mod key',
  );
  assert.ok(
    /inset: calc\(\(var\(--codex-touch-target\) - 28px\) \/ -2\)/.test(stylesheetRules),
    'expressed as inset rather than width and height, so a bundle rule that sets inset replaces ours instead of over-constraining the box',
  );
});

test('the expanded hit area can actually be hit', () => {
  assert.ok(
    /:where\(button, \[role='button'\], \[role='tab'\], \[role='menuitem'\], \[role='switch'\], a\[href\]\[aria-label\]\)::after \{[^}]*pointer-events: auto/.test(
      stylesheetRules,
    ),
    'this ::after is the same pseudo-element as @layer components ._Button_eg66f_2:after, which declares pointer-events:none; being unlayered wins us the inset but leaves a property we never declared applying to our own box',
  );
  assert.ok(
    /\[aria-label='Send'\]::after \{[^}]*pointer-events: auto/.test(stylesheetRules),
    'the send button is a Button too, and it is the only submit path on a coarse pointer',
  );
});

test('the sweep does not force overflow on a control to defeat its own clip', () => {
  // A pseudo-element is clipped by its originating element before any ancestor
  // sees it, so a control that truncates its label clips the outset away on
  // all four sides -- measured on the composer's project chip, 144x28 with
  // `overflow: hidden`, whose four sides all report clipped with the probe
  // point inside the computed box. `overflow: visible` is the obvious fix and
  // the wrong one: it spills the label the control truncates on purpose, to
  // buy a hit area on one control. The limitation is documented in the
  // stylesheet and reported by the drive instead.
  const coarse = stylesheetRules.slice(stylesheetRules.indexOf('@media (pointer: coarse)'));
  assert.equal(
    /overflow(-x|-y)?: (visible|clip|unset|initial)/.exec(coarse),
    null,
    'a control that truncates its own label clips its own ::after, and no outset reaches past a clip; forcing overflow would spill the label rather than fix the target',
  );
});

test('the hit-area sweep leaves prose links alone', () => {
  const bareAnchorArm = /a\[href\](?!\[aria-label\])/.exec(stylesheetRules);

  assert.equal(
    bareAnchorArm,
    null,
    'markdown paragraphs are 26px apart at the 16px size this file forces (--markdown-line-height is font-size * --leading-relaxed, 1.625), which leaves about 4-5px of half-leading against an 8px outset: a bare a[href] arm puts the overlay into the lines above and below, and WCAG 2.5.8 excludes inline targets for the same reason',
  );
  assert.ok(
    stylesheetRules.includes("a[href][aria-label])::after"),
    'an anchor whose accessible name has to come from an attribute is an icon link, not a link in a sentence, and that is the population this sweep is for',
  );
});

test('the resizers are hidden by their Tailwind group name', () => {
  assert.ok(
    stylesheetRules.includes("[class~='group/panel-resizer']"),
    'a group name is part of the utility contract and survives a rebuild, unlike a module hash; matching it as a class token also avoids escaping the slash',
  );
});

test('app regions are neutralised, since no browser knows what to do with one', () => {
  assert.ok(
    stylesheetRules.includes('-webkit-app-region: no-drag !important'),
    'important is needed for the normal drag declarations, and is knowingly not enough for .\\!draggable, whose own important sits in @layer utilities where the layer order runs the other way round',
  );
});

test('the sidebar is taken out of flow in both states, not merely hidden', () => {
  assert.ok(stylesheetRules.includes('[data-app-shell-frame] .app-shell-left-panel {'));
  assert.ok(
    /\[data-app-shell-frame\] \.app-shell-left-panel \{[^}]*position: fixed/.test(stylesheetRules),
    'the main content inset is animated through a framer-motion value the responsive attribute does not reach, so position fixed is the independent guarantee that 240px cannot crush a 390px viewport',
  );
  assert.ok(stylesheetRules.includes("[data-app-shell-sidebar-open='false'] .app-shell-left-panel"));
  assert.ok(stylesheetRules.includes("[data-app-shell-sidebar-open='true'] .app-shell-left-panel"));
  assert.ok(
    stylesheetRules.includes("[data-app-shell-sidebar-open='true'] .app-shell-left-panel::before"),
    'the scrim is a pseudo-element on the panel so it shares the panel stacking context; a sibling appended to body sits in a different one and could paint over the drawer',
  );
});

test('the drawer is opaque, and nothing paints over it', () => {
  assert.ok(
    stylesheetRules.includes('background-color: var(--color-surface-tertiary, var(--color-surface, canvas)) !important'),
    'the unlayered bundle rule it has to beat is (0,6,0) against our (0,2,0) and sets the background SHORTHAND to 0 0, which resets background-color to transparent; importance is the only lever at a selector we are willing to write',
  );
  assert.ok(
    /\.app-shell-left-panel::after \{\s*display: none;/.test(stylesheetRules),
    'the bundle bleeds the panel background past its right edge with background:inherit, invisible while the panel was transparent and a --radius-2xl stripe over the scrim once it is not',
  );
  assert.ok(
    stylesheetRules.includes('--codex-mobile-drawer-width: min(86vw, 320px)'),
    'one source of truth, because the drawer and the scrim have to agree on the edge to the pixel',
  );
  assert.ok(stylesheetRules.includes('width: var(--codex-mobile-drawer-width) !important'));
  assert.ok(
    /\.app-shell-left-panel::before \{[^}]*inset-inline: var\(--codex-mobile-drawer-width\) 0/.test(stylesheetRules),
    'a z-index:-1 child paints after the stacking-context element\'s own background and before its in-flow descendants (CSS 2.1 Appendix E), so an inset:0 scrim tinted the drawer\'s background 45% black; not overlapping it is the fix',
  );
  assert.equal(
    /\.app-shell-left-panel::before \{[^}]*inset: 0/.test(stylesheetRules),
    false,
    'the full-viewport inset is what caused it',
  );
});

test('safe-area insets are divided by the zoom the frame carries inline', () => {
  const insets = stylesheetRules.match(/env\(safe-area-inset-[a-z]+, 0px\)/g) ?? [];
  const divided = stylesheetRules.match(/calc\(env\(safe-area-inset-[a-z]+, 0px\) \/ var\(--codex-window-zoom, 1\)\)/g) ?? [];

  assert.equal(insets.length, 4, 'bottom and the two inline edges on the frame, plus the open drawer\'s own bottom');
  assert.equal(
    divided.length,
    insets.length,
    'the frame\'s inline style is zoom: var(--codex-window-zoom) with every length in it divided by the same variable, because a length on a zoomed element renders at length x zoom; env() is already in device-correct pixels, so an undivided inset reserves 51px of home indicator at 1.5 zoom and 23px at 0.67',
  );
  assert.ok(stylesheetRules.includes('padding-block-end: calc(env(safe-area-inset-bottom, 0px) / var(--codex-window-zoom, 1))'));
});

test('every important declaration is one of the documented overrides', () => {
  const properties = new Set();
  for (const match of stylesheetRules.matchAll(/([-a-z]+)\s*:[^;{}]*!important/g)) {
    properties.add(match[1]);
  }

  assert.deepEqual(
    [...properties].sort(),
    [
      '--spacing-token-safe-header-left',
      '--spacing-token-safe-header-right',
      '-webkit-app-region',
      'background-color',
      'display',
      'font-size',
      'height',
      'max-width',
      'min-width',
      'opacity',
      'width',
    ],
    'important is the only mechanism that reaches an inline style or another important declaration; anywhere else our later source order already wins at equal specificity, and an unexplained important is a specificity fight we lost without noticing',
  );
});
