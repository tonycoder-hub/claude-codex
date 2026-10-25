// Test doubles for the appserver client. Deliberately dumb: they record and
// replay, they do not re-implement any of the logic under test.

import { APPROVAL_DECISIONS } from '../../src/appserver/client.mjs';

/**
 * An in-memory transport. `sent` is every object the client handed over, in
 * order; `receive` injects an inbound object; `drop` simulates the pipe dying.
 */
export function fakeTransport() {
  const sent = [];
  let inbound = null;
  let onClosed = null;
  let closedByClient = false;

  return {
    sent,
    /** True once the client called `close()` on us. */
    get closedByClient() {
      return closedByClient;
    },
    /** The last object the client sent, for the common single-message assertion. */
    get last() {
      return sent[sent.length - 1];
    },
    /** Every object the client sent that was a request for `method`. */
    requestsFor(method) {
      return sent.filter((message) => message.method === method);
    },
    /** Push an inbound message at the client, exactly as a real transport would. */
    receive(message) {
      if (!inbound) throw new Error('the client has not registered onMessage yet');
      inbound(message);
    },
    /** Simulate the far end going away. */
    drop() {
      onClosed?.();
    },
    transport: {
      send(message) {
        // Round-trip through JSON so a test can never assert on a value that
        // would not have survived the wire.
        sent.push(JSON.parse(JSON.stringify(message)));
      },
      onMessage(callback) {
        inbound = callback;
      },
      onClose(callback) {
        onClosed = callback;
      },
      close() {
        closedByClient = true;
        onClosed?.();
      },
    },
  };
}

/**
 * A WebSocket stand-in with a controllable readyState. Node has a real
 * WebSocket client but no WebSocket server without a dependency, and the
 * interesting behaviour of the transport -- queue while CONNECTING, drop once
 * CLOSED -- is about readyState transitions, which this exercises directly.
 */
export class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  binaryType = 'blob';
  /** Every text payload passed to `send`, in order. */
  frames = [];
  closeCalls = [];

  #listeners = new Map();

  addEventListener(type, handler) {
    const set = this.#listeners.get(type) ?? new Set();
    set.add(handler);
    this.#listeners.set(type, set);
  }

  send(text) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error(`InvalidStateError: readyState ${this.readyState}`);
    }
    this.frames.push(text);
  }

  close(code, reason) {
    this.closeCalls.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSED;
    this.#emit('close', { code: code ?? 1000, reason });
  }

  // -- driving the double from a test ---------------------------------------

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.#emit('open', {});
  }

  /** Deliver a frame. Pass a string, an ArrayBuffer view, or anything else. */
  deliver(data) {
    this.#emit('message', { data });
  }

  /** Close from the far end, without anyone calling `close()`. */
  remoteClose(code = 1006) {
    this.readyState = FakeWebSocket.CLOSED;
    this.#emit('close', { code });
  }

  fail() {
    this.#emit('error', {});
  }

  #emit(type, event) {
    for (const handler of this.#listeners.get(type) ?? []) handler(event);
  }
}

/** Let queued microtasks (an awaited request handler, say) run to completion. */
export function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

// The real server→client request params, copied from the adapter's
// `requestApproval` / `requestUserInput`. Tests use these rather than `{}` so a
// handler that reaches for a field the protocol actually sends -- `command`,
// `availableDecisions`, `grantRoot` -- is exercised against the real shape.

/** `item/commandExecution/requestApproval`, sent when the tool is Bash. */
export function commandApprovalParams(overrides = {}) {
  return {
    threadId: 'th_1',
    turnId: 'tu_1',
    itemId: 'it_1',
    startedAtMs: 1_700_000_000_000,
    approvalId: 'ap_1',
    reason: null,
    command: 'npm test',
    cwd: '/work',
    commandActions: [],
    additionalPermissions: null,
    proposedExecpolicyAmendment: null,
    proposedNetworkPolicyAmendments: null,
    availableDecisions: [...APPROVAL_DECISIONS],
    ...overrides,
  };
}

/** `item/fileChange/requestApproval`, sent for every other tool. */
export function fileChangeApprovalParams(overrides = {}) {
  return {
    threadId: 'th_1',
    turnId: 'tu_1',
    itemId: 'it_2',
    startedAtMs: 1_700_000_000_000,
    reason: null,
    grantRoot: null,
    ...overrides,
  };
}

/**
 * `item/tool/requestUserInput`. The adapter guarantees an `Other` option on
 * every question, so the fixture carries one too.
 */
export function userInputParams(overrides = {}) {
  return {
    threadId: 'th_1',
    turnId: 'tu_1',
    itemId: 'it_3',
    questions: [{
      header: 'Which branch?',
      options: [
        { label: 'main', description: null },
        { label: 'Other', description: 'Provide a free-form answer' },
      ],
    }],
    ...overrides,
  };
}
