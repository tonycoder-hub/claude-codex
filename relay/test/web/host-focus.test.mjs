// The focus layer, tested on the one property that makes it worth having.
//
// A relay that answers `electron-window-focus-request` once and then goes
// quiet passes every obvious test: the request got a reply, the atom left
// `null`, the splash advanced. It is also strictly worse than a relay that
// answers nothing, because the renderer hands this message to TanStack Query
// as its ONLY focus event source in place of `visibilitychange`
// (`Pvc(){IGe.setEventListener(Fvc)}`, app-initial@10008777) -- so a host that
// stops pushing has taken the browser's own refetch-on-focus away and put
// nothing back. On a phone, where the browser backgrounds the tab every time
// the person reads a message, that is the whole feature.
//
// So the assertions below are about what happens AFTER the first answer: that
// a transition pushes, that a non-transition does not, that the layer survives
// a deliver that throws, and that uninstall actually detaches. The first-reply
// tests are here too, and they are the easy half.
//
// The window is a hand-built fake rather than host-fakes' `makeWindow`,
// because every test here turns on `document.hasFocus()` and
// `document.visibilityState` -- two properties that fake deliberately does not
// have, and that six other suites would gain for no reason if it did.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHostFocus, readWindowFocus } from '../../web/host-focus.mjs';
import { INBOUND, OUTBOUND, OUTBOUND_EVENT, isDeliverable } from '../../web/host-protocol.mjs';
import { createHostBus } from '../../web/host-bus.mjs';

/**
 * A window with controllable focus and visibility.
 *
 * Real EventTarget on both the window and the document, so `focus`, `blur` and
 * `visibilitychange` go through the same dispatch the browser uses. The two
 * state properties are plain and settable: a test flips them and then fires
 * the event, which is the order a browser does it in.
 */
function makeWindow({ focused = true, visibility = 'visible', noHasFocus = false } = {}) {
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  const counts = { window: new Map(), document: new Map() };

  const track = (which, type, delta) => {
    counts[which].set(type, (counts[which].get(type) ?? 0) + delta);
  };

  const document = {
    visibilityState: visibility,
    addEventListener: (type, listener, options) => {
      track('document', type, 1);
      documentTarget.addEventListener(type, listener, options);
    },
    removeEventListener: (type, listener, options) => {
      track('document', type, -1);
      documentTarget.removeEventListener(type, listener, options);
    },
    dispatchEvent: (event) => documentTarget.dispatchEvent(event),
  };
  if (!noHasFocus) document.hasFocus = () => focused;

  const window = {
    document,
    addEventListener: (type, listener, options) => {
      track('window', type, 1);
      windowTarget.addEventListener(type, listener, options);
    },
    removeEventListener: (type, listener, options) => {
      track('window', type, -1);
      windowTarget.removeEventListener(type, listener, options);
    },
    dispatchEvent: (event) => windowTarget.dispatchEvent(event),

    /** Flip the browser's answer, then fire what a browser would fire. */
    goBackground() {
      focused = false;
      document.visibilityState = 'hidden';
      windowTarget.dispatchEvent(new Event('blur'));
      documentTarget.dispatchEvent(new Event('visibilitychange'));
    },
    goForeground() {
      focused = true;
      document.visibilityState = 'visible';
      documentTarget.dispatchEvent(new Event('visibilitychange'));
      windowTarget.dispatchEvent(new Event('focus'));
    },
    setFocused(value) {
      focused = value;
    },
    _listenerCount: (which, type) => counts[which].get(type) ?? 0,
  };
  return window;
}

/** A focus layer plus everything it delivered and reported, in order. */
function harness(windowOptions = {}, focusOptions = {}) {
  const window = makeWindow(windowOptions);
  const delivered = [];
  const events = [];
  const focus = createHostFocus({
    window,
    deliver: (message) => delivered.push(message),
    now: () => 1_700_000_000_000,
    onEvent: (kind, detail) => events.push({ kind, ...detail }),
    ...focusOptions,
  });
  return { window, focus, delivered, events, flags: () => delivered.map((m) => m.isFocused) };
}

// ---- reading what the browser says ----------------------------------------

test('focus is visibility and hasFocus together, the way main ands its three', () => {
  // main: `!isSystemSuspended && !isScreenLocked && window.isFocused() === true`.
  assert.equal(readWindowFocus(makeWindow({ focused: true, visibility: 'visible' })), true);
  assert.equal(readWindowFocus(makeWindow({ focused: false, visibility: 'visible' })), false);
  assert.equal(readWindowFocus(makeWindow({ focused: true, visibility: 'hidden' })), false);
  assert.equal(readWindowFocus(makeWindow({ focused: false, visibility: 'hidden' })), false);
});

test('an embedding with no hasFocus degrades to visibility, not to false', () => {
  // A hard `false` here is the answer that strands the onboarding splash, and
  // "the page is on screen" is a true statement without `hasFocus`.
  assert.equal(readWindowFocus(makeWindow({ noHasFocus: true, visibility: 'visible' })), true);
  assert.equal(readWindowFocus(makeWindow({ noHasFocus: true, visibility: 'hidden' })), false);
});

test('a missing document or a throwing one reads as not focused', () => {
  assert.equal(readWindowFocus(undefined), false);
  assert.equal(readWindowFocus({}), false);
  assert.equal(readWindowFocus({ document: null }), false);
  assert.equal(
    readWindowFocus({
      document: {
        visibilityState: 'visible',
        hasFocus() { throw new Error('detached'); },
      },
    }),
    false,
  );
});

test('a document with no visibilityState at all is treated as visible', () => {
  // Node's own fakes are like this, and so is any embedding that predates the
  // Page Visibility API. Defaulting to hidden would strand the splash there.
  assert.equal(readWindowFocus({ document: { hasFocus: () => true } }), true);
  assert.equal(readWindowFocus({ document: { hasFocus: () => false } }), false);
});

// ---- answering the request -------------------------------------------------

test('the request is answered with a deliverable inbound message', async () => {
  const { focus, delivered } = harness({ focused: true });
  focus.answer();

  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0], {
    type: INBOUND.electronWindowFocusChanged,
    isFocused: true,
  });
  assert.equal(isDeliverable(delivered[0]), true, 'the renderer would hand this to its switch');
  assert.equal(focus.stats().requestsAnswered, 1);
});

test('a blurred answer carries occurredAtMs and a focused one does not', () => {
  // Main stamps the blur and not the focus, and the renderer's idle logic
  // reads the stamp. A stamp on the focused branch would be a field nobody
  // sends, which is the kind of divergence that only shows up as a bug later.
  const { focus, delivered } = harness({ focused: false });
  focus.answer();
  assert.deepEqual(delivered[0], {
    type: INBOUND.electronWindowFocusChanged,
    isFocused: false,
    occurredAtMs: 1_700_000_000_000,
  });
});

test('every request is answered, even when the answer has not changed', () => {
  // Main answers unconditionally. The renderer asks from three separate mount
  // effects, and the second and third subscribers have nothing until they are
  // told -- a deduped answer would leave two of the three on `null`.
  const { focus, delivered } = harness({ focused: true });
  focus.answer();
  focus.answer();
  focus.answer();
  assert.equal(delivered.length, 3);
  assert.equal(focus.stats().requestsAnswered, 3);
  assert.equal(focus.stats().unchanged, 0, 'a request is not an observation');
});

test('attach claims the request on a real bus, through the renderer transport', () => {
  // Driven through the CustomEvent the renderer actually dispatches rather
  // than through a bus method, because the thing worth proving is that the bus
  // counts this as CLAIMED -- an unclaimed one is what boot reports as
  // `outbound-unclaimed`, and the whole point of this layer is that this type
  // stops appearing there.
  const window = makeWindow({ focused: true });
  const bus = createHostBus({ window });
  const delivered = [];
  const focus = createHostFocus({
    window,
    deliver: (message) => {
      bus.deliver(message);
      delivered.push(message);
    },
  }).attach(bus);

  assert.equal(focus.type, OUTBOUND.electronWindowFocusRequest);
  window.dispatchEvent(new CustomEvent(OUTBOUND_EVENT, {
    detail: { type: OUTBOUND.electronWindowFocusRequest },
  }));

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].isFocused, true);
  assert.equal(bus.stats.claimed, 1);
  assert.equal(bus.stats.unclaimed, 0, 'this type is no longer one nobody reads');
  assert.equal(bus.stats.emitted, 1, 'delivering through the bus keeps its count true');

  bus.stop();
  focus.uninstall();
});

test('attach without a bus is refused rather than silently doing nothing', () => {
  const { focus } = harness();
  assert.throws(() => focus.attach(undefined), /bus/);
  assert.throws(() => focus.attach({}), /bus/);
});

test('a window or deliver that cannot work is refused at construction', () => {
  assert.throws(() => createHostFocus({ deliver: () => {} }), /window/);
  assert.throws(() => createHostFocus({ window: {}, deliver: () => {} }), /window/);
  assert.throws(() => createHostFocus({ window: makeWindow() }), /deliver/);
});

// ---- pushing for the life of the page --------------------------------------

test('backgrounding and foregrounding each push exactly once', () => {
  // Both fire two DOM events. Without the dedupe the renderer's focus-duration
  // span (app-initial@8820278) would get a close with no open and then an open
  // it never closes.
  const { window, focus, flags } = harness({ focused: true });
  focus.answer();

  window.goBackground();
  window.goForeground();
  window.goBackground();

  assert.deepEqual(flags(), [true, false, true, false]);
  assert.equal(focus.stats().pushed, 4);
  assert.equal(focus.stats().unchanged, 3, 'the second event of each pair read as no change');
});

test('the first observation pushes even when it agrees with the initial state', () => {
  // `lastSent` starts at null, not at whatever the browser said at install:
  // the renderer has been told nothing, and `null` is exactly the state its
  // atom is stuck in.
  const { window, focus, flags } = harness({ focused: true });
  window.dispatchEvent(new Event('focus'));
  assert.deepEqual(flags(), [true]);
  assert.equal(focus.stats().unchanged, 0);
});

test('a request after a push re-answers without disturbing the dedupe', () => {
  const { window, focus, flags } = harness({ focused: true });
  window.goBackground();
  focus.answer();
  window.goForeground();

  assert.deepEqual(flags(), [false, false, true]);
  assert.equal(focus.stats().requestsAnswered, 1);
  assert.equal(focus.stats().pushed, 3);
});

test('refresh is the DOM event, callable by hand', () => {
  const { window, focus, flags } = harness({ focused: true });
  focus.refresh();
  window.setFocused(false);
  focus.refresh();
  focus.refresh();
  assert.deepEqual(flags(), [true, false]);
  assert.equal(focus.read(), false, 'read has no side effect and no memory');
});

// ---- the failures ----------------------------------------------------------

test('a deliver that throws is recorded and does not poison lastSent', () => {
  // If the throw marked the value as sent, the next real transition in the
  // same direction would be deduped away and the renderer would never recover.
  const window = makeWindow({ focused: true });
  const events = [];
  let failNext = true;
  const delivered = [];
  const focus = createHostFocus({
    window,
    deliver: (message) => {
      if (failNext) throw new Error('the bus is gone');
      delivered.push(message);
    },
    onEvent: (kind, detail) => events.push({ kind, ...detail }),
  });

  focus.answer();
  assert.equal(focus.stats().deliverFailures, 1);
  assert.equal(focus.stats().pushed, 0);
  assert.deepEqual(events, [{ kind: 'deliver-failed', isFocused: true, reason: 'the bus is gone' }]);

  failNext = false;
  window.dispatchEvent(new Event('focus'));
  assert.deepEqual(delivered.map((m) => m.isFocused), [true], 'the retry was not deduped away');
});

test('an onEvent that throws is counted and never reaches the caller', () => {
  // These run from a window listener, where a throw is swallowed by the
  // dispatcher and leaves nothing behind at all.
  const window = makeWindow({ focused: true });
  const focus = createHostFocus({
    window,
    deliver: () => {},
    onEvent: () => { throw new Error('the reporter is broken'); },
  });
  assert.doesNotThrow(() => focus.answer());
  assert.equal(focus.stats().observerFailures, 1);
  assert.equal(focus.stats().pushed, 1, 'the push itself still happened');
});

test('no onEvent at all is fine', () => {
  const window = makeWindow();
  const focus = createHostFocus({ window, deliver: () => {} });
  assert.doesNotThrow(() => focus.answer());
  assert.equal(focus.stats().pushed, 1);
});

// ---- installing and removing -----------------------------------------------

test('the listeners are the three a browser fires, and uninstall removes them', () => {
  const { window, focus } = harness();
  assert.equal(window._listenerCount('window', 'focus'), 1);
  assert.equal(window._listenerCount('window', 'blur'), 1);
  assert.equal(window._listenerCount('document', 'visibilitychange'), 1);

  focus.uninstall();
  assert.equal(window._listenerCount('window', 'focus'), 0);
  assert.equal(window._listenerCount('window', 'blur'), 0);
  assert.equal(window._listenerCount('document', 'visibilitychange'), 0);
});

test('uninstall stops the pushes', () => {
  const { window, focus, delivered } = harness({ focused: true });
  focus.answer();
  focus.uninstall();
  window.goBackground();
  assert.equal(delivered.length, 1);
});

test('uninstall twice, and a target that is already gone, are both survivable', () => {
  const { focus } = harness();
  focus.uninstall();
  assert.doesNotThrow(() => focus.uninstall());

  const window = makeWindow();
  const broken = createHostFocus({ window, deliver: () => {} });
  window.removeEventListener = () => { throw new Error('detached'); };
  assert.doesNotThrow(() => broken.uninstall());
});

test('a document with no addEventListener installs the window half only', () => {
  // Not hypothetical: host-fakes' `makeWindow` is exactly this shape, and so
  // is any embedding that hands over a document-like object.
  const windowTarget = new EventTarget();
  const window = {
    document: { visibilityState: 'visible', hasFocus: () => true },
    addEventListener: (t, l) => windowTarget.addEventListener(t, l),
    removeEventListener: (t, l) => windowTarget.removeEventListener(t, l),
    dispatchEvent: (e) => windowTarget.dispatchEvent(e),
  };
  const delivered = [];
  const focus = createHostFocus({ window, deliver: (m) => delivered.push(m) });
  assert.doesNotThrow(() => window.dispatchEvent(new Event('blur')));
  assert.deepEqual(delivered.map((m) => m.isFocused), [true]);
  focus.uninstall();
});

test('stats are a copy and carry what was last sent', () => {
  const { window, focus } = harness({ focused: true });
  assert.equal(focus.stats().lastSent, null, 'null until something has been sent');
  focus.answer();
  assert.equal(focus.stats().lastSent, true);
  window.goBackground();
  assert.equal(focus.stats().lastSent, false);

  const snapshot = focus.stats();
  snapshot.pushed = 999;
  assert.notEqual(focus.stats().pushed, 999);
});
