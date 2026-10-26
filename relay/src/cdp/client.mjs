// A Chrome DevTools Protocol client with no dependencies.
//
// Dependency-free is a requirement, not a preference: the Codex App bundle ships
// only native modules in its node_modules -- there is no `ws` -- and nothing is
// ever installed on the resident Mac. Node's global WebSocket covers it.
//
// Uses the flat session protocol (sessionId on the message) rather than
// Target.sendMessageToTarget, so one socket serves the browser and every page.

const DEFAULT_TIMEOUT_MS = 20_000;

export class CdpError extends Error {
  constructor(method, { code, message, data } = {}) {
    super(`${method} failed: ${message ?? 'unknown error'}${data ? ` (${data})` : ''}`);
    this.name = 'CdpError';
    this.code = code;
    this.method = method;
  }
}

export class Cdp {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #closed = null;

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => this.#onMessage(ev.data));
    ws.addEventListener('close', () => this.#rejectAll(new Error('CDP socket closed')));
    ws.addEventListener('error', () => this.#rejectAll(new Error('CDP socket errored')));
  }

  static async connect(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const ws = new WebSocket(url);
    // CDP frames exceed the default max payload on some builds; binary is unused.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connect timed out: ${url}`)), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`CDP connect failed: ${url}`));
      }, { once: true });
    });
    return new Cdp(ws);
  }

  /** Browser-level WebSocket endpoint for a loopback debugging port. */
  static async endpoint(port, { host = '127.0.0.1', timeoutMs = 5_000 } = {}) {
    const res = await fetch(`http://${host}:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`/json/version returned ${res.status}`);
    const body = await res.json();
    if (!body.webSocketDebuggerUrl) throw new Error('/json/version had no webSocketDebuggerUrl');
    return body;
  }

  #onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id !== undefined && this.#pending.has(msg.id)) {
      const { resolve, reject, method, timer } = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new CdpError(method, msg.error));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      for (const fn of this.#listeners.get(msg.method) ?? []) {
        try { fn(msg.params ?? {}, msg.sessionId); } catch { /* a listener must not kill the pump */ }
      }
      for (const fn of this.#listeners.get('*') ?? []) {
        try { fn(msg); } catch { /* same */ }
      }
    }
  }

  #rejectAll(err) {
    this.#closed ??= err;
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.#pending.clear();
  }

  on(event, handler) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(handler);
    return () => this.#listeners.get(event)?.delete(handler);
  }

  /** Resolve when `event` arrives, or reject on timeout. */
  once(event, { timeoutMs = DEFAULT_TIMEOUT_MS, where = () => true } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out waiting for ${event}`));
      }, timeoutMs);
      const off = this.on(event, (params, sessionId) => {
        if (!where(params, sessionId)) return;
        clearTimeout(timer);
        off();
        resolve({ params, sessionId });
      });
    });
  }

  send(method, params = {}, { sessionId, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, method, timer });
      try { this.#ws.send(JSON.stringify(payload)); }
      catch (err) { this.#pending.delete(id); clearTimeout(timer); reject(err); }
    });
  }

  /** A thin per-session facade, so callers stop threading sessionId by hand. */
  session(sessionId) {
    return {
      sessionId,
      send: (method, params, opts) => this.send(method, params, { ...opts, sessionId }),
      on: (event, handler) => this.on(event, (params, sid) => {
        if (sid === sessionId) handler(params);
      }),
      once: (event, opts = {}) => this.once(event, {
        ...opts,
        where: (params, sid) => sid === sessionId && (opts.where?.(params, sid) ?? true),
      }),
    };
  }

  close() {
    try { this.#ws.close(); } catch { /* already gone */ }
    this.#rejectAll(new Error('CDP client closed by caller'));
  }
}

/** Wait for a loopback debugging port to start answering. */
export async function waitForEndpoint(port, { host = '127.0.0.1', timeoutMs = 60_000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { return await Cdp.endpoint(port, { host }); }
    catch (err) { last = err; await new Promise((r) => setTimeout(r, intervalMs)); }
  }
  throw new Error(`debugging port ${host}:${port} never answered: ${last?.message}`);
}
