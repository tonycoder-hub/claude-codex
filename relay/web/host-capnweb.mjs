// The host end of the renderer's capnweb session, written against the wire.
//
// WHY THIS EXISTS AT ALL, GIVEN THAT CAPNWEB IS ALREADY IN THE PAGE
//
// The renderer bundle ships its own capnweb, and because our middleware runs in
// the same page we can simply borrow it: dynamically importing the bundle's
// app-shared chunk hands back a module whose export `fJt` is
// `newMessagePortRpcSession`, and two lines later the handshake is answered.
// That worked -- it is how the seam was first proven -- and it is not what we
// ship, for one reason: both of those names are build outputs.
//
// The chunk's hash is recoverable. A scan of the shipped archive found exactly
// one `webview/assets` entry matching /^app-shared-[0-9a-f]+\.js$/, out of
// 19,134 -- so the server can discover the filename and hand it to us.
//
// The export name is not. A survey of that module's 7,564 exports found 5,048
// functions and *zero* that a structural rule picks out: the obvious one --
// takes two arguments and mentions postMessage -- matches nothing, because the
// factory delegates to a transport class and never names postMessage itself.
// There is no rule. There is only `fJt`, which is a letter away from being
// something else in the next build, and when it changes the symptom is a boot
// that hangs with a clean console (see host-handshake.mjs on why `await
// services` has no timeout).
//
// So we answer the protocol instead. A protocol is versioned and visible on the
// wire; a minified identifier is neither.
//
// THE MEASURED WIRE
//
// Recorded off a real renderer boot, with the handshake deliberately
// unanswered, by listening on port2 and replying to nothing:
//
//   in    ["push",["pipeline",0,["services"]]]     allocates export id 1
//   in    ["pull",1]                               "resolve it and tell me"
//   out   ["resolve",1,{}]
//   in    ["release",1,1]                          one reference, now returned
//
// and that is the entire conversation. Frames are structured-clone JSON arrays,
// not strings (`typeof 'object'`, `isArray: true`), and carry no transferred
// ports.
//
// WHY THAT RECORDING WAS NOT THE WHOLE STORY
//
// It was a recording of a BOOT. The renderer reaches `services` once, early,
// and if you never drive a turn you never see it reach anything else -- which
// is exactly what happened, and this file used to say so:
//
//   "`services` is read five times, each behind a `!= null` guard [...] An
//    empty object is not a stub standing in for a real implementation -- it is
//    the correct answer. Accordingly this is not a capnweb implementation and
//    must not grow into one."
//
// The five guarded reads are real -- they are the ones in the renderer's own
// `dei()`, which awaits `services` and then conditionally initialises
// threadReadState, statsig, clientCoordination and terminal. But they are not
// the only reads. The resolved object is held as a module singleton (`i6` in
// app-shared, imported as `Se` in app-initial) and is dereferenced from 70
// distinct namespaces all over the app, most of which ARE null-guarded at
// their call sites and 8 of which are not. Driving one real turn reached one
// of the unguarded ones:
//
//   Se.requestUserInputAutoResolution.setConversationPresented?.({...})
//
// -- the `?.` guards the method, not the object -- and the reply, which had
// already arrived intact on the wire, was rendered as "ChatGPT hit a snag".
//
// So the empty object was never the correct answer. It was an answer that is
// indistinguishable from correct until the first turn completes. Serving real
// namespaces means serving CALLABLE members, and a function cannot cross this
// wire by value, so this file does now grow -- by exactly the three things a
// callable export needs, and no further.
//
// THE GRAMMAR, READ OUT OF THE PEER
//
// Not guessed from capnweb's documentation: read out of app-shared, which is
// the actual peer. The relevant findings, with the minified method they came
// from:
//
//   (per member)    A callable crosses as `["export", id]` WHERE IT SITS, so
//                   `{clipboard:{writeText(){}}}` becomes
//                   `{clipboard:{writeText:["export",-1]}}` -- a plain object
//                   carrying one capability, not one capability. See the long
//                   note in `devaluate`; the peer's stub proxy makes the
//                   difference load-bearing.
//   exportStub()    `let t = this.nextExportId--`, seeded at -1. A capability
//                   serialised INTO a message is encoded `["export", id]` with
//                   a NEGATIVE id. Push-allocated exports come from
//                   `this.exports.push(...)` and so are non-negative. The two
//                   id spaces cannot collide; that is the point of the sign.
//
//   sendCall()      `let r = ["pipeline", importId, path]; if (args) r.push(…);
//                   this.send(["push", r])`. A call is a 4-element pipeline
//                   expression; a property get is the same thing with 3. Both
//                   arrive inside a `push`.
//
//   the push case   `let e = new wI(new OI(…).evaluate(n[1])); this.exports
//                   .push({hook: e, refcount: 1})`. The peer EVALUATES ON
//                   PUSH, not on pull. So must we: a call whose result is
//                   never pulled -- which is every fire-and-forget host call
//                   in the app -- would otherwise never run at all. This is
//                   the one place where deferring, as this file originally
//                   did, is not merely lazy but wrong.
//
//   devaluateImpl() `case "array": … return [i]`. Arrays are escaped by
//                   wrapping, because an unwrapped array is the expression
//                   syntax. Everything else structured-clonable passes
//                   through: the MessagePort transport uses the
//                   `structuredClonable` encoding level, under which Date,
//                   bigint, undefined and non-finite numbers are NOT tagged.
//                   Only arrays and capabilities need encoding.
//
// WHAT WE STILL DELIBERATELY DO NOT IMPLEMENT
//
// `remap`, `stream`, `pipe`, promise exports, and capability arguments
// (a renderer passing US a callback). None are reachable from the namespaces
// we serve. Each is named through `onEvent` rather than ignored, because the
// failure mode of silence here is a promise that never settles.

/** The renderer's root object is import 0; `services` hangs off it. */
const SERVICES_PATH = 'services';

/**
 * Encode a host value for the wire.
 *
 * Mirrors the peer's `devaluateImpl` at the `structuredClonable` encoding
 * level, which is the level a MessagePort transport uses. At that level the
 * only things needing encoding are arrays -- escaped by wrapping, since a bare
 * array is the expression syntax -- and anything callable, which becomes a
 * capability.
 *
 * `exportTarget` is injected rather than closed over so that this function
 * stays a pure encoder and the id allocation stays in one place.
 *
 * @param {unknown} value
 * @param {(target: object) => number} exportTarget allocates a negative id
 * @param {number} [depth]
 */
function devaluate(value, exportTarget, depth = 0) {
  // The peer throws past 256. Matching it means a cycle fails here, with our
  // message, rather than three frames later with theirs.
  if (depth >= 256) {
    throw new TypeError('capnweb: serialisation exceeded maximum depth (is there a cycle?)');
  }

  if (typeof value === 'function') return ['export', exportTarget(value)];
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return [value.map((item) => devaluate(item, exportTarget, depth + 1))];

  // Dates, bigints, errors and the rest ride structured clone untouched. Only
  // plain objects are walked, because only a plain object can be carrying a
  // function that needs exporting.
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return value;
  }

  // A plain object stays a plain object, and each callable INSIDE it crosses
  // as its own capability (the `typeof value === 'function'` branch above,
  // reached by the recursion below). This used to promote the whole object to
  // one capability instead, which is wrong in a way that cannot be seen from
  // this side: the peer wraps a received capability in a Proxy whose `get` is
  // unconditional (app-shared @2171311, handler `RBt`):
  //
  //   get(e,t,n){ let r=e.raw; if(t===bI)return r;
  //     if(t in SI.prototype)return r[t];
  //     if(typeof t===`string`) return new SI(r.hook,
  //       r.pathIfPromise?[...r.pathIfPromise,t]:[t]); … }
  //   ownKeys(e){return[]}
  //
  // It never consults the target's own properties, so every string property of
  // an exported object reads back as a non-null, truthy, thenable stub. A
  // namespace exported whole therefore has no absent members on the peer's
  // side, and the renderer cannot tell a method we implemented from one we did
  // not. That is not an abstract concern -- it is the difference between
  //
  //   `Se.workspaceFiles.write != null`  ->  false, so the MCP resource is
  //                                          advertised read-only (correct)
  //   `Se.workspaceFiles.write != null`  ->  true, so the model is told the
  //                                          user's file is writable and the
  //                                          write then fails (a lie)
  //
  // for a `write` we never served. Exporting per member keeps `undefined`
  // expressible, which is the only way to say "this host does not have that"
  // to a peer written against a real Electron host that genuinely lacks
  // methods. `web/host-namespaces.mjs` depends on this and says so.
  const out = {};
  for (const key of Object.keys(value)) out[key] = devaluate(value[key], exportTarget, depth + 1);
  return out;
}

/**
 * Decode a wire value the peer sent us.
 *
 * The inverse of `devaluate`, and deliberately partial: it understands the
 * shapes real arguments arrive in. An expression it does not understand is
 * returned as a described marker rather than as `undefined`, so a stub that
 * receives one can say what it got instead of behaving as though it was
 * called with nothing.
 *
 * @param {unknown} value
 */
function evaluate(value) {
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    // `[[…]]` is an escaped array; `["tag", …]` is an expression. The two are
    // distinguishable because escaping always produces exactly one element and
    // that element is always an array, while every tag is a string.
    if (value.length === 1 && Array.isArray(value[0])) return value[0].map(evaluate);
    if (typeof value[0] === 'string') {
      switch (value[0]) {
        case 'undefined': return undefined;
        case 'date': return new Date(value[1]);
        case 'bigint': return BigInt(value[1]);
        case 'nan': return Number.NaN;
        case 'inf': return Number.POSITIVE_INFINITY;
        case '-inf': return Number.NEGATIVE_INFINITY;
        default:
          // `export`, `import`, `pipeline`, `promise`, `error`, `stream`… A
          // capability the renderer is handing us. We cannot call back, and
          // pretending otherwise would be worse than saying so.
          return { __capnwebUnsupported: value[0] };
      }
    }
    // A bare multi-element array with a non-string head is not a shape the
    // peer's serialiser can produce. Pass it through rather than invent.
    return value;
  }

  const out = {};
  for (const key of Object.keys(value)) out[key] = evaluate(value[key]);
  return out;
}

/**
 * Stand up the host end of a capnweb session on a port.
 *
 * Shaped to be passed straight to `installHandshake({ createSession })`, which
 * calls it with the port the renderer transferred and the main object to serve.
 *
 * @param {MessagePort} port the renderer's port2, not yet started
 * @param {{services?: object}} mainObject what `await session.services` resolves to
 * @param {{onEvent?: ((event: {kind: string, [k: string]: unknown}) => void) | null}} [options]
 * @returns {{close: () => void, stats: () => {
 *   resolved: number, rejected: number, unhandled: number,
 *   called: number, threw: number, exported: number,
 * }}}
 */
export function createCapnwebSession(port, mainObject, { onEvent = null } = {}) {
  if (!port || typeof port.postMessage !== 'function') {
    throw new TypeError('createCapnwebSession: a MessagePort is required');
  }

  /** Expression ids are allocated by the pusher, in order, counting from 1. */
  let nextExportId = 1;
  /** Capability ids are ours to allocate, and count DOWN from -1. See header. */
  let nextCapabilityId = -1;

  /** @type {Map<number, {ok: boolean, value: unknown}>} push id -> evaluated result */
  const pending = new Map();
  /** @type {Map<number, object>} negative id -> the object we exported */
  const capabilities = new Map();
  /** @type {Map<object, number>} the reverse, so re-exporting is stable */
  const capabilityIds = new Map();

  const stats = { resolved: 0, rejected: 0, unhandled: 0, called: 0, threw: 0, exported: 0 };
  let open = true;

  const report = (kind, detail) => {
    if (typeof onEvent !== 'function') return;
    try {
      onEvent({ kind, ...detail });
    } catch {
      // An observer that throws must not take the session down with it.
    }
  };

  const send = (frame) => {
    try {
      port.postMessage(frame);
    } catch (err) {
      // A closed or neutered port. Nothing can be done from here, and throwing
      // would propagate into a port listener where nobody is catching.
      report('send-failed', { message: err?.message ?? String(err) });
    }
  };

  /**
   * Allocate -- or reuse -- a capability id for a target.
   *
   * Reuse matters: the peer's `exportStub` keeps a `reverseExports` map for the
   * same reason, and without it every re-serialisation of the same namespace
   * would mint a new id and leak one table entry per send.
   */
  const exportTarget = (target) => {
    const existing = capabilityIds.get(target);
    if (existing !== undefined) return existing;
    const id = nextCapabilityId--;
    capabilities.set(id, target);
    capabilityIds.set(target, id);
    stats.exported += 1;
    report('exported', { id, kind: typeof target === 'function' ? 'function' : 'namespace' });
    return id;
  };

  /** A stub may be async; capnweb's own targets may be too. */
  const isThenable = (value) =>
    value !== null && (typeof value === 'object' || typeof value === 'function')
      && typeof value.then === 'function';

  /**
   * Encode and send the one frame a `pull` is owed.
   *
   * Every path through `pull` ends here, so encoding happens exactly once and
   * a pull is answered exactly once. An encoding failure is converted into a
   * `reject` rather than thrown: we are inside a port listener, nobody is
   * catching, and an uncaught throw here is the silent hang this whole module
   * exists to avoid.
   */
  function settle(id, ok, value) {
    if (!open) return;
    if (!ok) {
      send(['reject', id, value]);
      stats.rejected += 1;
      report('rejected', { id, message: value?.message ?? null });
      return;
    }
    let encoded;
    try {
      encoded = devaluate(value, exportTarget);
    } catch (err) {
      send(['reject', id, { message: err?.message ?? String(err) }]);
      stats.rejected += 1;
      report('rejected', { id, message: err?.message ?? String(err) });
      return;
    }
    send(['resolve', id, encoded]);
    stats.resolved += 1;
    report('resolved', { id });
  }

  /**
   * Evaluate one pipeline expression, NOW.
   *
   * On-push evaluation is not an optimisation, it is the semantics: the peer
   * does it (see header) and every fire-and-forget host call in the app relies
   * on it. Deferring to `pull` would mean `setConversationPresented` -- whose
   * result nobody reads -- simply never running.
   *
   * Returns the RAW value. Encoding happens in exactly one place, when a
   * `pull` asks for it, because `devaluate` is not idempotent: run twice over
   * a capability, `["export", -1]` would come back as an escaped two-element
   * array and the renderer would receive a list where it expected a stub.
   */
  function evaluatePipeline(expression) {
    const id = expression[1];
    const path = Array.isArray(expression[2]) ? expression[2] : [];
    const hasArgs = expression.length >= 4;

    // The main object. Its only property is `services`.
    if (id === 0) {
      if (path && path.length === 1 && path[0] === SERVICES_PATH && !hasArgs) {
        return { ok: true, value: mainObject?.services ?? {} };
      }
      return { ok: false, value: { message: 'this host serves only `services` on the main object' } };
    }

    const target = capabilities.get(id);
    if (target === undefined) {
      return { ok: false, value: { message: `no such capability: ${id}` } };
    }

    // Walk the path to the member. An EMPTY path addresses the capability
    // itself, and that is the ordinary case now that each callable member is
    // exported on its own: the stub the renderer holds IS the method, so its
    // `apply` trap sends `r.pathIfPromise || []` -- nothing. With no arguments
    // an empty path is instead a dup of the capability, which the `!hasArgs`
    // branch below answers by re-exporting.
    let holder;
    let member = target;
    for (const step of path) {
      if (member === null || (typeof member !== 'object' && typeof member !== 'function')) {
        return { ok: false, value: { message: `cannot read \`${step}\` of a non-object on this capability` } };
      }
      holder = member;
      member = member[step];
    }

    // Name the thing in a rejection. `path.join('.')` is `''` for an empty
    // path, which would read `not callable: ` and name nothing. That arm is
    // unreachable today -- every capability we hand out is a function -- but a
    // message that names nothing costs more to read than the branch costs to
    // keep.
    const label = path.length > 0 ? path.join('.') : `capability ${id}`;

    if (!hasArgs) {
      if (member === undefined) {
        // Honest: the renderer asked for a member we do not serve. Rejecting
        // is louder than resolving `undefined` and is what lets the missing
        // member show up in a report instead of as a later TypeError.
        return { ok: false, value: { message: `no such member: ${label}` } };
      }
      return { ok: true, value: member };
    }

    if (typeof member !== 'function') {
      return { ok: false, value: { message: `not callable: ${label}` } };
    }

    const args = evaluate(expression[3]);
    stats.called += 1;
    try {
      // `holder` is undefined for an empty path: a member exported on its own
      // has no namespace object on this side to bind as a receiver. Every stub
      // in web/host-namespaces.mjs is an arrow function closing over its state
      // for that reason. A longer path still binds the walked parent, so a
      // method that does use `this` keeps working when it is reached through
      // one.
      const result = member.apply(holder, Array.isArray(args) ? args : [args]);
      report('called', { path, id });
      return { ok: true, value: result };
    } catch (err) {
      stats.threw += 1;
      report('call-threw', { path, id, message: err?.message ?? String(err) });
      return { ok: false, value: { message: err?.message ?? String(err) } };
    }
  }

  function onFrame(event) {
    if (!open) return;
    const frame = event?.data;

    // Every frame in this protocol is an array whose first element names the
    // operation. Anything else is not capnweb and is reported rather than
    // ignored, because the alternative is a silent hang.
    if (!Array.isArray(frame) || typeof frame[0] !== 'string') {
      stats.unhandled += 1;
      report('frame-unrecognised', { shape: Array.isArray(frame) ? 'array' : typeof frame });
      return;
    }

    const [op] = frame;

    if (op === 'push') {
      // ["push", ["pipeline", id, path, args?]] -- the peer asks us to
      // evaluate an expression and remember the result under the next id.
      const id = nextExportId++;
      const expression = frame[1];
      const isPipeline = Array.isArray(expression) && expression[0] === 'pipeline';
      const path = isPipeline && Array.isArray(expression[2]) ? expression[2] : null;

      if (!isPipeline) {
        stats.unhandled += 1;
        pending.set(id, { ok: false, value: { message: `unsupported expression: ${expression?.[0]}` } });
        report('push-unsupported', { id, op: Array.isArray(expression) ? expression[0] : typeof expression });
        return;
      }

      let outcome;
      try {
        outcome = evaluatePipeline(expression);
      } catch (err) {
        // Encoding failures land here -- a cycle, an unserialisable value.
        stats.threw += 1;
        outcome = { ok: false, value: { message: err?.message ?? String(err) } };
        report('push-threw', { id, path, message: err?.message ?? String(err) });
      }
      // A fire-and-forget call still returns a promise, and if nobody pulls it
      // a rejection has no handler and surfaces as an unhandled rejection in
      // the page -- noise that looks like our bug and is not. Attaching a sink
      // here is the only place that knows the result exists.
      if (outcome.ok && isThenable(outcome.value)) {
        Promise.resolve(outcome.value).catch(() => {});
      }
      pending.set(id, outcome);
      report('push', { id, path, resolved: outcome.ok });
      return;
    }

    if (op === 'pull') {
      // ["pull", id] -- send the value of the expression pushed under `id`.
      const id = frame[1];
      const outcome = pending.get(id);
      pending.delete(id);

      if (outcome === undefined) {
        // A pull for an id we never saw pushed. Refusing is not the same as
        // staying quiet: an unanswered pull is a promise in the renderer that
        // never settles, so we always send something.
        send(['reject', id, { message: `nothing was pushed under id ${id}` }]);
        stats.rejected += 1;
        report('rejected', { id, path: null });
        return;
      }

      if (outcome.ok) {
        // An async stub returns a promise, and a promise cannot be structure-
        // cloned -- sending one raises DataCloneError on the port and the
        // renderer's pull never settles. So a thenable is awaited here and the
        // frame is sent when it does, which is also what the peer does with
        // its own async targets.
        if (isThenable(outcome.value)) {
          Promise.resolve(outcome.value).then(
            (value) => settle(id, true, value),
            (err) => settle(id, false, { message: err?.message ?? String(err) }),
          );
          report('awaiting', { id });
          return;
        }
        settle(id, true, outcome.value);
        return;
      }

      settle(id, false, outcome.value);
      return;
    }

    if (op === 'release') {
      // ["release", id, refcount] -- the peer is done with an export. Pushed
      // expressions are dropped; capabilities are not. A namespace is a
      // long-lived singleton on our side, and dropping it because the peer
      // released one reference would turn a later call into `no such
      // capability` -- a failure that would look like a protocol bug and is
      // not worth the handful of bytes a retained entry costs.
      const id = frame[1];
      if (pending.has(id)) pending.delete(id);
      report('release', { id, retained: capabilities.has(id) });
      return;
    }

    // abort, resolve, reject inbound, remap, stream, pipe, and anything a
    // future build adds. We are not a peer that issues calls, so none of these
    // should reach us.
    stats.unhandled += 1;
    report('frame-unhandled', { op });
  }

  // NEVER call port.start(). capnweb's own MessagePort transport calls start()
  // and attaches its listener synchronously on the next line; starting a port
  // before a listener exists flushes everything already queued on it into
  // nothing, silently. Assigning `onmessage` both starts the port and installs
  // the listener in one step, which is the only ordering that is safe here.
  port.onmessage = onFrame;
  report('listening', {});

  return {
    close() {
      if (!open) return;
      open = false;
      port.onmessage = null;
      try {
        port.close();
      } catch {
        // Already closed, or never open. Either way there is nothing to undo.
      }
      report('closed', { ...stats });
    },
    stats: () => ({ ...stats }),
  };
}
