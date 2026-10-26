// A window, for a host that has no DOM.
//
// Node gives us real EventTarget, CustomEvent, MessageEvent and MessageChannel,
// so nothing here reimplements event dispatch -- the fake window is an
// EventTarget with the three or four properties the modules under test actually
// read, and real events go through it. A hand-rolled dispatcher would be the
// one part of the test that could pass while the real thing failed.
//
// ONE HONEST COMPROMISE, stated rather than papered over.
//
// Node's MessageEvent constructor REFUSES an `eventInitDict.source` that is not
// a MessagePort -- in a browser it would accept a Window, but Node has no
// Window type to accept. So `postMessage` below constructs the event and then
// shadows `source` with Object.defineProperty. The shadowed property is a real
// own property and reads exactly as the prototype getter would, so a listener
// doing `event.source === window` cannot tell the difference, which is the only
// thing under test here. What this does NOT reproduce is the browser's transfer
// semantics: a real `postMessage(data, origin, [port])` neuters the port, and
// this fake passes the same object through. No code under test depends on
// neutering -- and a test that needs to prove `port.start()` was never called
// passes a recording stub instead of a real port anyway.

/**
 * @param {{origin?: string}} [options]
 */
export function makeWindow({ origin = 'https://surface.invalid' } = {}) {
  const target = new EventTarget();

  const window = {
    location: { origin },
    document: { documentElement: { dataset: {} } },

    addEventListener: (type, listener, options) => target.addEventListener(type, listener, options),
    removeEventListener: (type, listener, options) =>
      target.removeEventListener(type, listener, options),
    dispatchEvent: (event) => target.dispatchEvent(event),

    /**
     * Post to this window, the way the renderer posts its handshake to itself.
     * The resulting event has `source === window`, by the compromise above.
     */
    postMessage(data, targetOrigin = origin, transfer = []) {
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
 * Post a message that claims to come from somewhere else -- another frame, an
 * extension. `source` is set to a foreign object, which is what the handshake's
 * sender check is supposed to refuse.
 */
export function postFromForeignSource(window, data) {
  const event = new MessageEvent('message', { data });
  Object.defineProperty(event, 'source', { value: { notThisWindow: true }, configurable: true });
  window.dispatchEvent(event);
  return event;
}

/**
 * Collect every event of `type` dispatched on `window`, in order.
 * @returns {{events: object[], data: () => object[], off: () => void}}
 */
export function collect(window, type) {
  const events = [];
  const listener = (event) => events.push(event);
  window.addEventListener(type, listener);
  return {
    events,
    data: () => events.map((event) => event.data),
    details: () => events.map((event) => event.detail),
    off: () => window.removeEventListener(type, listener),
  };
}

/**
 * The renderer's outbound transport, reproduced.
 *
 * This is `gf.postMessage` from the bundle, kept faithful down to the
 * `__codexForwardedViaBridge` flag and the unconditional dispatch, because the
 * single most important property of the capture side is that a message that
 * travels BOTH paths is delivered exactly once. A fake that only dispatched the
 * CustomEvent could never catch a double-capture regression -- it would be
 * testing the bus against a renderer that does not exist.
 */
export function postMessageFromView(window, message) {
  let sentViaBridge = false;
  const bridge = window.electronBridge;
  if (bridge?.sendMessageFromView) {
    bridge.sendMessageFromView(message).catch(() => {});
    sentViaBridge = true;
  }
  const event = new CustomEvent('codex-message-from-view', { detail: message });
  if (sentViaBridge) event.__codexForwardedViaBridge = true;
  window.dispatchEvent(event);
  return event;
}

/**
 * The renderer's `dispatchMessage(type, payload)`: note that `type` is written
 * LAST, so a payload carrying its own `type` loses.
 */
export function dispatchMessageFromView(window, type, payload = {}) {
  return postMessageFromView(window, { ...payload, type });
}

/**
 * A MessagePort stand-in that records whether anyone started it.
 *
 * Deliberately not a real MessagePort: a real one would keep the event loop
 * alive and, more to the point, would make `started` unobservable.
 *
 * `deliver` is how a test plays the peer. It feeds both reception paths -- the
 * `onmessage` property and any `addEventListener('message')` listeners -- which
 * matters because a module is free to choose either, and a fake that only fed
 * one would quietly pass for a module that used the other. What it does NOT
 * reproduce is a real port's queueing: delivery here is immediate and
 * synchronous whether or not the port was ever started, so `started` stays a
 * clean assertion about what the code under test did rather than a precondition
 * for the fake to work at all.
 */
export function recordingPort() {
  const port = {
    started: 0,
    posted: [],
    listeners: [],
    closed: false,
    onmessage: null,
    start() {
      port.started += 1;
    },
    postMessage(message) {
      port.posted.push(message);
    },
    addEventListener(type, listener) {
      port.listeners.push({ type, listener });
    },
    removeEventListener(type, listener) {
      const at = port.listeners.findIndex((e) => e.type === type && e.listener === listener);
      if (at !== -1) port.listeners.splice(at, 1);
    },
    close() {
      port.closed = true;
    },

    /** Play the peer: deliver one frame, as a MessageEvent-shaped object. */
    deliver(data) {
      const event = { data, ports: [] };
      if (typeof port.onmessage === 'function') port.onmessage(event);
      for (const entry of [...port.listeners]) {
        if (entry.type === 'message') entry.listener(event);
      }
      return event;
    },
  };
  return port;
}

/** A config that satisfies installElectronBridge, with no real values in it. */
export function bridgeConfig(overrides = {}) {
  return {
    dsn: 'https://examplekey@sentry.invalid/0',
    appVersion: '0.0.0-test',
    buildNumber: '0',
    buildFlavor: 'test',
    codexAppSessionId: 'app-session-placeholder',
    desktopTraceSampleRate: 0,
    initialDesktopTraceSampleRate: 0,
    desktopUserAgent: 'CodexRelayWebTest/0.0.0',
    theme: 'dark',
    systemThemeVariant: 'dark',
    ...overrides,
  };
}
