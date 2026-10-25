// The fetch endpoint layer, tested against the one property that matters.
//
// Every other host module in this repo can be wrong in a way that throws. This
// one cannot: the renderer's `sendRequest` has no timeout, so the failure mode
// of a mistake here is a promise that never settles under a react-query layer
// that spins forever with a clean console. A test suite that only checked the
// endpoints we implemented would pass while the product hung on the ninety we
// did not.
//
// So the assertions below are mostly about SILENCE being impossible. An unknown
// endpoint, a malformed URL, a handler that throws, a store that rejects, a
// prototype-shaped endpoint name and all ninety-odd names observed in the
// bundle each get a "exactly one reply went out" assertion. Shape assertions
// come second, and only for shapes that were measured off the real bundle --
// where a reader does not guard its field access, the comment says which reader
// and what it does.
//
// The end-to-end test at the bottom drives a real window and a real bus rather
// than calling `handle` directly, with an electronBridge present, because the
// renderer sends every message along two paths and a layer that answered both
// would reply twice to one request.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DICTATION_STREAM_URL,
  FETCH_URL_PREFIX,
  FetchEndpointError,
  KNOWN_ENDPOINTS,
  createHostFetch,
  createMemoryStore,
  parseFetchUrl,
  shapedEmptyBody,
} from '../../web/host-fetch.mjs';
import { INBOUND, OUTBOUND } from '../../web/host-protocol.mjs';
import { createHostBus } from '../../web/host-bus.mjs';
import { collect, dispatchMessageFromView, makeWindow } from './host-fakes.mjs';

let ids = 0;

/**
 * One renderer `fetch`, built the way the measured `sendRequest` builds it:
 * a UUID-shaped requestId, the endpoint interpolated into the URL, and the
 * params as `JSON.stringify(params)` -- which is `undefined`, not a string,
 * when there are no params at all.
 */
function request(endpoint, params) {
  ids += 1;
  return {
    type: OUTBOUND.fetch,
    requestId: `request-${ids}`,
    method: 'POST',
    url: `${FETCH_URL_PREFIX}${endpoint}`,
    body: params === undefined ? undefined : JSON.stringify(params),
  };
}

function host(options = {}) {
  const posted = [];
  const events = [];
  const fetchHost = createHostFetch({
    deliver: (message) => posted.push(message),
    onEvent: (event) => events.push(event),
    ...options,
  });
  return { fetchHost, posted, events, kinds: () => events.map((event) => event.kind) };
}

/** Send one request and return the reply, insisting there was exactly one. */
async function ask(fetchHost, posted, endpoint, params) {
  const before = posted.length;
  const message = request(endpoint, params);
  await fetchHost.handle(message);
  const replies = posted.slice(before);
  assert.equal(replies.length, 1, `${endpoint} must answer exactly once`);
  assert.equal(replies[0].requestId, message.requestId);
  assert.equal(replies[0].type, INBOUND.fetchResponse);
  return replies[0];
}

async function body(fetchHost, posted, endpoint, params) {
  const reply = await ask(fetchHost, posted, endpoint, params);
  assert.equal(reply.responseType, 'success');
  assert.equal(reply.status, 200);
  return reply.body;
}

// ---- the regression that matters most -----------------------------------

test('an unimplemented endpoint still gets exactly one fetch-response', async () => {
  const { fetchHost, posted } = host();

  const reply = await ask(fetchHost, posted, 'compile-latex-artifact', { path: '/tmp/x.tex' });

  assert.deepEqual(reply, {
    type: INBOUND.fetchResponse,
    requestId: reply.requestId,
    responseType: 'success',
    status: 200,
    headers: {},
    body: {},
  });
  assert.equal(fetchHost.stats().unknown, 1);
  assert.equal(fetchHost.pending, 0, 'nothing may be left owed');
});

test('an endpoint nobody has ever seen is answered too, and named as unseen', async () => {
  const { fetchHost, posted, events } = host();

  await ask(fetchHost, posted, 'an-endpoint-from-a-future-build');

  const unimplemented = events.find((event) => event.kind === 'endpoint-unimplemented');
  assert.deepEqual(unimplemented, {
    kind: 'endpoint-unimplemented',
    endpoint: 'an-endpoint-from-a-future-build',
    known: false,
    shaped: false,
  });
});

test('the endpoint vocabulary includes the names only the producer revealed', () => {
  // A call-site scan is a sample and the main process's dispatch object is the
  // producer, so the list is the union of both readings. These three are why:
  // each is requested by the shipped renderer through a chunk-local alias the
  // scan did not recognise, and each was reported by the diagnostics as a name
  // nobody had ever seen until the dispatch keys were read.
  //
  // Pinned by name, not by count. The sweep below iterates this same list, so
  // it cannot notice a name leaving it, and a length assertion would pass under
  // any 150 names.
  for (const endpoint of [
    'ambient-suggestions',
    'external-agent-import-status',
    'global-dictation-hotkey-state',
  ]) {
    assert.ok(KNOWN_ENDPOINTS.includes(endpoint), `${endpoint} must be a known endpoint`);
  }

  // `claude-cowork` sits in the same region of the main bundle as a key, but it
  // keys a provider-adapter map rather than the dispatch object -- the one name
  // of the 46 candidates deliberately not added.
  assert.equal(KNOWN_ENDPOINTS.includes('claude-cowork'), false);

  // Sorted and unique, because the list is merged from two readings by hand and
  // a duplicate would quietly double a name in the sweep's count.
  assert.deepEqual([...KNOWN_ENDPOINTS], [...new Set(KNOWN_ENDPOINTS)].sort());
});

test('every endpoint name observed in the bundle is answered exactly once', async () => {
  // The whole-list sweep. Routing has a default branch rather than a lookup,
  // and this is the assertion that the branch is reachable for every name we
  // know about -- including the ones whose built-in refuses with a status,
  // since a refusal is an answer and a hang is not.
  const { fetchHost, posted } = host();

  for (const endpoint of KNOWN_ENDPOINTS) {
    await fetchHost.handle(request(endpoint));
  }

  assert.equal(posted.length, KNOWN_ENDPOINTS.length);
  for (const reply of posted) {
    assert.equal(reply.type, INBOUND.fetchResponse);
    assert.equal(typeof reply.requestId, 'string');
    if (reply.responseType === 'success') {
      // `'body' in e ? e.body : JSON.parse(e.bodyJsonString)` is the measured
      // decode, so a success envelope without the key makes the renderer parse
      // undefined, throw inside its own try, and reject. The key must exist
      // even when the value is null.
      assert.ok('body' in reply, `${reply.requestId} has no body key`);
    } else {
      assert.equal(reply.responseType, 'error');
      assert.equal(typeof reply.error, 'string');
    }
  }

  const stats = fetchHost.stats();
  assert.equal(stats.received, KNOWN_ENDPOINTS.length);
  assert.equal(stats.answered, KNOWN_ENDPOINTS.length);
  assert.equal(stats.unanswerable, 0);
  assert.equal(fetchHost.pending, 0);
});

test('an endpoint named like an Object prototype member routes like any other name', async () => {
  // Both the shape table and the caller handler map are looked up by a name
  // that arrived in a URL. On a plain object literal, `constructor` resolves to
  // a function off the prototype chain, which a naive table would then call as
  // a shape factory.
  const { fetchHost, posted } = host({ handlers: {} });

  for (const endpoint of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const reply = await ask(fetchHost, posted, endpoint);
    assert.equal(reply.responseType, 'success');
    assert.deepEqual(reply.body, {}, `${endpoint} must fall into the shaped-empty default`);
  }
  assert.equal(fetchHost.stats().unknown, 4);
});

// ---- the endpoints implemented for real ---------------------------------

test('get-settings answers the measured two-map shape', async () => {
  const { fetchHost, posted } = host();

  assert.deepEqual(await body(fetchHost, posted, 'get-settings'), {
    values: {},
    configuredValues: {},
  });
});

test('a setting written through set-setting is readable by both read endpoints', async () => {
  const { fetchHost, posted } = host();

  assert.deepEqual(await body(fetchHost, posted, 'set-setting', { key: 'git-worktree-root', value: '/w' }), {});
  assert.deepEqual(await body(fetchHost, posted, 'get-setting', { key: 'git-worktree-root' }), {
    value: '/w',
  });
  assert.deepEqual(await body(fetchHost, posted, 'get-settings'), {
    values: { 'git-worktree-root': '/w' },
    configuredValues: {},
  });
});

test('an unset setting answers null, which is what makes the renderer use its own default', async () => {
  // Measured: `(await HW(`get-setting`,{params:{key:e.key}})).value??e.default`.
  const { fetchHost, posted } = host();

  assert.deepEqual(await body(fetchHost, posted, 'get-setting', { key: 'never-set' }), { value: null });
});

test('global state round-trips, and the write reports success the way the renderer reads it', async () => {
  // `if(!(await r(`set-global-state`,{params:{key:t,value:a}})).success) throw
  // Error(`Failed to persist global state`)` -- a missing `success` field is a
  // throw on the read-modify-write path, not a shrug.
  const { fetchHost, posted } = host();
  const projects = { 'project-1': { rootPaths: ['/src'] } };

  assert.deepEqual(await body(fetchHost, posted, 'set-global-state', { key: 'local-projects', value: projects }), {
    success: true,
  });
  assert.deepEqual(await body(fetchHost, posted, 'get-global-state', { key: 'local-projects' }), {
    value: projects,
  });
});

test('an unwritten global-state key answers null rather than an invented default', async () => {
  // `bxn(e,t){return xxn(e,t)??tmt(e)}` -- the renderer supplies the per-key
  // default itself, so null is the correct answer for every key and this module
  // never has to know the key vocabulary.
  const { fetchHost, posted } = host();

  assert.deepEqual(await body(fetchHost, posted, 'get-global-state', { key: 'selected-project' }), {
    value: null,
  });
});

test('a store that cannot write answers success:false instead of rejecting the fetch', async () => {
  // The renderer's optimistic path rolls its cache back on `success:false`
  // (`if(!e){...i.setData(e=>e===o?a:e)}`). Reporting the same failure as a
  // rejected fetch would leave the optimistic value on screen instead.
  const { fetchHost, posted, kinds } = host({
    store: {
      async get() {
        return undefined;
      },
      async set() {
        throw new Error('disk is full');
      },
    },
  });

  const reply = await ask(fetchHost, posted, 'set-global-state', { key: 'k', value: 1 });
  assert.equal(reply.responseType, 'success');
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { success: false });
  assert.ok(kinds().includes('store-write-failed'));
});

test('workspace-root-options answers an array, because the renderer calls includes on it', async () => {
  // `let{roots:e}=await Wu(`workspace-root-options`,...); if(!e.includes(t))`.
  const empty = host();
  assert.deepEqual(await body(empty.fetchHost, empty.posted, 'workspace-root-options'), { roots: [] });

  const configured = host({ workspaceRoots: ['/a', '/b'] });
  assert.deepEqual(await body(configured.fetchHost, configured.posted, 'workspace-root-options'), {
    roots: ['/a', '/b'],
  });
});

test('the roots list handed out is a copy, not the caller array', async () => {
  const workspaceRoots = ['/a'];
  const { fetchHost, posted } = host({ workspaceRoots });

  const answered = await body(fetchHost, posted, 'workspace-root-options');
  answered.roots.push('/injected');
  assert.deepEqual(workspaceRoots, ['/a']);
});

test('git-origins answers an empty origin list, which short-circuits every measured reader', async () => {
  const { fetchHost, posted } = host();

  assert.deepEqual(await body(fetchHost, posted, 'git-origins', { dirs: ['/a'], hostId: 'local' }), {
    origins: [],
  });
});

test('list-pinned-threads answers an array, because the renderer indexes into it', async () => {
  // `let{threadIds:a}=await Wu(`list-pinned-threads`,...); let o=a.indexOf(e)`.
  const empty = host();
  assert.deepEqual(await body(empty.fetchHost, empty.posted, 'list-pinned-threads'), { threadIds: [] });

  const seeded = host({ store: createMemoryStore({ 'pinned-thread-ids': ['t-1', 't-2'] }) });
  assert.deepEqual(await body(seeded.fetchHost, seeded.posted, 'list-pinned-threads'), {
    threadIds: ['t-1', 't-2'],
  });
});

test('inbox-items never answers a bare empty object', async () => {
  // The selector is `new Set(t?.unreadRunCounts.unreadRuns.map(e=>e.threadId))`.
  // The optional chain stops at the query data, so once data exists both nested
  // names are mandatory -- `{}` throws inside a selector rather than rendering
  // an empty inbox.
  const { fetchHost, posted } = host();

  const answered = await body(fetchHost, posted, 'inbox-items', { limit: 200 });
  assert.ok(Array.isArray(answered.items));
  assert.ok(Array.isArray(answered.unreadRunCounts.unreadRuns));
  assert.ok(Array.isArray(answered.unreadRunCounts.automationIds));
  assert.equal(answered.unreadRunCounts.total, 0);
  assert.equal(answered.nextOffset, null, 'the infinite query reads nextOffset as its page param');
});

test('account-info answers a null-shaped account rather than an empty object', async () => {
  const defaulted = host();
  assert.deepEqual(await body(defaulted.fetchHost, defaulted.posted, 'account-info'), {
    accountId: null,
    authenticatedUserId: null,
    email: null,
    plan: null,
    platform: null,
  });

  const accountInfo = { accountId: 'acct-1', authenticatedUserId: 'user-1', email: 'a@b.invalid', plan: 'plus', platform: 'web' };
  const configured = host({ accountInfo });
  assert.deepEqual(await body(configured.fetchHost, configured.posted, 'account-info'), accountInfo);
});

test('codex-home answers the measured three fields when it is configured', async () => {
  const { fetchHost, posted } = host({
    codexHome: '/home/u/.codex',
    workspacesRoot: '/home/u/.codex/workspaces',
    worktreesSegment: 'worktrees',
  });

  assert.deepEqual(await body(fetchHost, posted, 'codex-home', { hostId: 'local' }), {
    codexHome: '/home/u/.codex',
    workspacesRoot: '/home/u/.codex/workspaces',
    worktreesSegment: 'worktrees',
  });
});

test('an unconfigured codex-home refuses with a status rather than inventing a path', async () => {
  // The renderer normalises this path unguarded while building the
  // managed-worktree root list, so an empty or absent one is a prefix that
  // matches everything or nothing. A non-2xx success envelope settles the
  // promise by rejecting, which is the measured HTTP path.
  const { fetchHost, posted } = host();

  const reply = await ask(fetchHost, posted, 'codex-home', { hostId: 'local' });
  assert.equal(reply.responseType, 'success');
  assert.equal(reply.status, 501);
  assert.deepEqual(reply.body, { error: 'codex-home is not configured on this host' });
  assert.equal(fetchHost.stats().rejected, 1, 'a non-2xx is counted apart from a 2xx');
});

// ---- the projectless pair -------------------------------------------------
//
// These two are what separate "the app mounted" from "the app can do
// anything". Measured on a real chain: with one workspace root configured the
// startup gate opened, the composer rendered and Send was enabled -- and
// tapping Send produced one `config/read` with `cwd:"~"` and no `thread/start`
// at all, because a root is a place threads may live and a project is a
// selection, and nothing had made one.

test('projectless-workspace-root answers the configured root, and null when there is none', async () => {
  // The reader is `BW(Q,`projectless-workspace-root`,{select:({workspaceRoot:e})=>e})`
  // -- an unguarded destructure of the body, so the KEY is mandatory even when
  // the value is null.
  const unset = host();
  assert.deepEqual(await body(unset.fetchHost, unset.posted, 'projectless-workspace-root'), {
    workspaceRoot: null,
  });

  const configured = host({ projectlessRoot: '/srv/work' });
  assert.deepEqual(
    await body(configured.fetchHost, configured.posted, 'projectless-workspace-root'),
    { workspaceRoot: '/srv/work' },
  );
});

test('projectless-thread-cwd answers the three fields the renderer destructures', async () => {
  // `let{cwd:a,outputDirectory:o,workspaceRoot:s}=await Wu(`projectless-thread-cwd`,...)`
  // -- three unguarded reads, so three mandatory keys.
  const { fetchHost, posted } = host({ projectlessRoot: '/srv/work' });

  assert.deepEqual(await body(fetchHost, posted, 'projectless-thread-cwd', {
    hostId: 'local',
    directoryName: 'thread-ru',
    createSplitDirectories: false,
    prompt: 'hello',
  }), {
    cwd: '/srv/work',
    outputDirectory: '/srv/work',
    workspaceRoot: '/srv/work',
  });
});

test('outputDirectory is never null, because a null one is a throw in the renderer', async () => {
  // Not a style preference. The measured guard is
  //   if(A===`projectless`&&j==null&&D!==`durable`&&!t)
  //     throw Error(`Projectless conversations require an output directory`)
  // so answering `{outputDirectory: null}` would settle the fetch and then
  // fail the turn one layer further in, where nothing names this endpoint.
  const { fetchHost, posted } = host({ projectlessRoot: '/srv/work' });
  const answered = await body(fetchHost, posted, 'projectless-thread-cwd', { hostId: 'local' });
  assert.notEqual(answered.outputDirectory, null);
  assert.equal(typeof answered.outputDirectory, 'string');
});

test('an unconfigured projectless root refuses rather than answering an undefined cwd', async () => {
  // The blanket `{}` fallback is what this replaces, and it is the exact
  // measured failure: `cwd` comes back undefined, the renderer resolves it to
  // `~`, and the turn goes nowhere with nothing on the wire to say why. A 501
  // settles the promise and names the missing configuration.
  const { fetchHost, posted } = host();

  const reply = await ask(fetchHost, posted, 'projectless-thread-cwd', { hostId: 'local' });
  assert.equal(reply.responseType, 'success');
  assert.equal(reply.status, 501);
  assert.deepEqual(reply.body, { error: 'projectless-thread-cwd requires a projectless root' });
  assert.equal(fetchHost.stats().rejected, 1);
});

test('the directory name the renderer suggests is not honoured, and not silently dropped either', async () => {
  // Desktop generates a fresh directory per projectless thread. This module
  // has no filesystem, so it answers its configured root for every request --
  // which means two threads share a directory. That is a real difference from
  // desktop, and the test states it so that a future filesystem-backed handler
  // changes a failing assertion rather than a comment nobody reads.
  const { fetchHost, posted } = host({ projectlessRoot: '/srv/work' });

  const first = await body(fetchHost, posted, 'projectless-thread-cwd', { directoryName: 'alpha' });
  const second = await body(fetchHost, posted, 'projectless-thread-cwd', { directoryName: 'beta' });
  assert.deepEqual(first, second, 'the suggested name does not reach the answer');
  assert.equal(first.cwd, '/srv/work');
});

test('a handler replaces the projectless builtin, which is how a real generator arrives', async () => {
  const { fetchHost, posted } = host({
    projectlessRoot: '/srv/work',
    handlers: {
      'projectless-thread-cwd': (params) => ({
        cwd: `/srv/work/${params?.directoryName ?? 'gen'}`,
        outputDirectory: `/srv/work/${params?.directoryName ?? 'gen'}/out`,
        workspaceRoot: '/srv/work',
      }),
    },
  });

  assert.deepEqual(await body(fetchHost, posted, 'projectless-thread-cwd', { directoryName: 'alpha' }), {
    cwd: '/srv/work/alpha',
    outputDirectory: '/srv/work/alpha/out',
    workspaceRoot: '/srv/work',
  });
});

test('read-file refuses rather than claiming the file was empty, and an injected reader replaces it', async () => {
  const refusing = host();
  const refusal = await ask(refusing.fetchHost, refusing.posted, 'read-file', { path: '/etc/hosts' });
  assert.equal(refusal.status, 501);
  assert.notEqual(refusal.body?.error, undefined);

  const reading = host({
    handlers: {
      'read-file': async (params) => ({ contents: `contents of ${params.path}` }),
    },
  });
  assert.deepEqual(await body(reading.fetchHost, reading.posted, 'read-file', { path: '/etc/hosts' }), {
    contents: 'contents of /etc/hosts',
  });
});

// ---- the four file endpoints ----------------------------------------------
//
// These answer the same questions as `workspaceFiles.read` through the other
// of the renderer's two host channels, and they answer them in a DIFFERENT
// shape: a size limit here returns a null payload where the namespace member
// throws, and a missing file here has to reject with a message a consumer
// pattern-matches. Both differences are transcribed from the App rather than
// chosen, so each gets a test that says which.

/** A `files` double. Values are byte arrays; `stat` is derived from presence. */
function fsDouble(contents = {}, { stat = {} } = {}) {
  return {
    readBytes: async (path) => {
      const found = contents[path];
      if (found === undefined) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      return found;
    },
    metadata: async (path, { throwIfMissing = false } = {}) => {
      if (contents[path] === undefined) {
        if (throwIfMissing) throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
        return null;
      }
      return { isFile: true, isDirectory: false, modifiedAtMs: 1700, createdAtMs: 1600, ...stat };
    },
    readDirectory: async () => [],
    countFolderFiles: async () => null,
  };
}

const utf8 = (text) => new TextEncoder().encode(text);

test('read-file returns the file as a string, and a BOM is not part of it', async () => {
  // Every measured consumer destructures `contents` bare and one hands it
  // straight to JSON.parse, so this is a string or it is a crash. The BOM
  // detail is the App's: it builds this with `Response#text()`, which strips
  // one, and TextDecoder strips one unless told not to -- so a UTF-8 file
  // saved by Notepad parses as JSON on both hosts.
  const { fetchHost, posted } = host({
    files: fsDouble({ '/w/a.json': utf8('\uFEFF{"ok":true}') }),
  });
  assert.deepEqual(
    await body(fetchHost, posted, 'read-file', { path: '/w/a.json' }),
    { contents: '{"ok":true}' },
  );
});

test('read-file still refuses without a filesystem, and a caller handler still wins', async () => {
  // The refusal is not dead code: `files` is null on every page whose link to
  // the resident machine failed, and the rest of this endpoint surface works
  // there. The injected-handler path is the seam the renderer tests use.
  const bare = host();
  const refusal = await ask(bare.fetchHost, bare.posted, 'read-file', { path: '/etc/hosts' });
  assert.equal(refusal.status, 501);
  assert.match(refusal.body.error, /requires a host file reader/);

  const reading = host({
    files: fsDouble({ '/etc/hosts': utf8('from the filesystem') }),
    handlers: { 'read-file': async (params) => ({ contents: `handler saw ${params.path}` }) },
  });
  assert.deepEqual(await body(reading.fetchHost, reading.posted, 'read-file', { path: '/etc/hosts' }), {
    contents: 'handler saw /etc/hosts',
  }, 'an explicit handler outranks the filesystem, which is what makes it a test seam');
});

test('a relative path is refused by every file endpoint', async () => {
  // Same argument as the namespace member: this host has no workspace root to
  // re-root onto, so the adapter would resolve it against ITS cwd and answer
  // with a real file nobody asked for.
  const { fetchHost, posted } = host({ files: fsDouble({ 'a.txt': utf8('x') }) });
  for (const endpoint of ['read-file', 'read-file-metadata', 'read-file-binary']) {
    const reply = await ask(fetchHost, posted, endpoint, { path: 'a.txt' });
    assert.equal(reply.status, 501, `${endpoint} must not read a relative path`);
    assert.match(reply.body.error, /does not re-root/);
  }
});

test('a missing file rejects with text the renderer can classify', async () => {
  // The one hard requirement on an error MESSAGE anywhere in this layer. A
  // measured consumer decides a file's existence by matching the rejection for
  // `ENOENT`, `No such file or directory` or `(os error 2)`; anything else
  // leaves its `exists` field null, which is neither true nor false and
  // renders as neither. So this endpoint must not swallow the adapter's
  // wording, and must not substitute its own.
  const { fetchHost, posted } = host({ files: fsDouble({}) });
  const reply = await ask(fetchHost, posted, 'read-file-metadata', { path: '/w/gone' });
  assert.equal(reply.responseType, 'error');
  assert.match(reply.error, /ENOENT|No such file or directory|\(os error 2\)/);
});

test('read-file-metadata omits contentKind when nothing was sampled', async () => {
  // Omitted and not null, because one consumer tests `contentKind !== 'text'`
  // and throws `File is not text`. A null there fails closed on every file,
  // including the text files the check exists to admit.
  const { fetchHost, posted } = host({ files: fsDouble({ '/w/a.txt': utf8('hello') }) });
  const result = await body(fetchHost, posted, 'read-file-metadata', { path: '/w/a.txt' });
  assert.equal('contentKind' in result, false, 'no sample limit means the question was not asked');
  assert.deepEqual(result, { createdAtMs: 1600, isFile: true, mtimeMs: 1700, sizeBytes: null });
});

test('a sample limit buys both the content kind and the only size this host can know', async () => {
  // `sizeBytes` is null above and a number here, which is a cost model and not
  // an inconsistency: the adapter's stat carries no size, so the only way to
  // learn one is to transfer the file -- and a sample has already transferred
  // it. The App reports null here too for every ssh and cloud workspace, for
  // exactly the same missing field, which is why every consumer guards it.
  const { fetchHost, posted } = host({ files: fsDouble({ '/w/a.txt': utf8('hello there') }) });
  const result = await body(fetchHost, posted, 'read-file-metadata', {
    path: '/w/a.txt', contentSampleByteLimit: 4096, contentSampleMaxFileBytes: 268435456,
  });
  assert.equal(result.contentKind, 'text');
  assert.equal(result.sizeBytes, 11);
});

test('a creation time of zero is null, because that is what an unknown birthtime is', async () => {
  // Some filesystems have no birthtime and report 0. The App nulls it with an
  // explicit `> 0` check rather than passing a 1970 timestamp to a date
  // formatter.
  const { fetchHost, posted } = host({
    files: fsDouble({ '/w/a': utf8('x') }, { stat: { createdAtMs: 0 } }),
  });
  const result = await body(fetchHost, posted, 'read-file-metadata', { path: '/w/a' });
  assert.equal(result.createdAtMs, null);
});

test('the content kind of an image is image, which is what routes it to a viewer', async () => {
  // The App reaches this through the `file-type` package, which this page
  // cannot load. A hand-written signature table replaces it, and the test that
  // matters is not that the table is complete -- it is not -- but that the
  // kinds which decide a VIEWER come out right. A PNG reported as `binary`
  // renders as a download link next to a photograph.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const pdf = utf8('%PDF-1.7\n...');
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  const svg = utf8('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>');
  const mp3 = utf8('ID3\u0003\u0000');
  const { fetchHost, posted } = host({
    files: fsDouble({
      '/w/a.png': png, '/w/a.pdf': pdf, '/w/a.zip': zip, '/w/a.svg': svg, '/w/a.mp3': mp3,
      '/w/a.txt': utf8('plain'), '/w/a.bin': new Uint8Array([1, 2, 0, 3]),
    }),
  });
  const kindOf = async (path) => (await body(fetchHost, posted, 'read-file-metadata', {
    path, contentSampleByteLimit: 4096,
  })).contentKind;

  assert.equal(await kindOf('/w/a.png'), 'image');
  assert.equal(await kindOf('/w/a.pdf'), 'pdf');
  assert.equal(await kindOf('/w/a.zip'), 'archive', 'by extension, so a .docx is one too');
  assert.equal(await kindOf('/w/a.svg'), 'image', 'markup, sniffed before the magic-byte table');
  assert.equal(await kindOf('/w/a.mp3'), 'audio');
  assert.equal(await kindOf('/w/a.txt'), 'text', 'nothing recognised it, so the control-char test ran');
  assert.equal(await kindOf('/w/a.bin'), 'binary', 'and a NUL made it binary');
});

test('read-file-binary returns base64 and a mime type only when one was recognised', async () => {
  const { fetchHost, posted } = host({
    files: fsDouble({ '/w/a.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      '/w/a.ts': utf8('export {}') }),
  });
  const image = await body(fetchHost, posted, 'read-file-binary', { path: '/w/a.png' });
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.contentsBase64, 'iVBORw0KGgo=');

  const source = await body(fetchHost, posted, 'read-file-binary', { path: '/w/a.ts' });
  assert.equal('mimeType' in source, false, 'the sniffer here has no text fallback, so text has no mime');
  assert.notEqual(source.contentsBase64, null);
});

test('read-file-binary answers over-limit with a null payload, not an error', async () => {
  // The opposite of `workspaceFiles.read`, which throws for the same input.
  // Both are transcribed: the App reads `maxBytes + 1` here specifically so it
  // can detect overflow and return null, and exactly `maxBytes` is allowed by
  // both. Every consumer of this endpoint null-checks the field, so null is a
  // value the renderer is built for and an error is not.
  const { fetchHost, posted } = host({ files: fsDouble({ '/w/big': utf8('0123456789') }) });
  assert.deepEqual(
    await body(fetchHost, posted, 'read-file-binary', { path: '/w/big', maxBytes: 4 }),
    { contentsBase64: null },
  );
  assert.notEqual(
    (await body(fetchHost, posted, 'read-file-binary', { path: '/w/big', maxBytes: 10 })).contentsBase64,
    null,
    'exactly at the limit is not over it',
  );
});

test('an https path and a cloud task are unavailable rather than fetched', async () => {
  // The App resolves one family of URL here -- GitHub release assets and user
  // attachments -- with a `gh auth token`. This host has neither, and fetching
  // an arbitrary URL from the page would send a workspace path to a third
  // party. `durable` is a cloud task's filesystem, reached through an
  // environment id this relay has no executor for. The App returns the same
  // null for both when it cannot resolve them.
  // With no filesystem at all, to pin that both are answered from the shape of
  // the request alone.
  const { fetchHost, posted, kinds } = host();
  assert.deepEqual(
    await body(fetchHost, posted, 'read-file-binary', { path: 'https://github.com/o/r/x.png' }),
    { contentsBase64: null },
  );
  assert.deepEqual(
    await body(fetchHost, posted, 'read-file-binary', { path: '/w/a', hostId: 'durable' }),
    { contentsBase64: null },
  );
  assert.ok(kinds().includes('read-file-binary-url'));
  assert.ok(kinds().includes('read-file-binary-durable'));
});

test('read-git-file-binary is shaped, unavailable, and correct in being so', async () => {
  // The only one of the four that cannot throw in the App: not a worktree, a
  // path escaping the repository, a non-zero `git show`, an empty blob and any
  // exception in the git worker all collapse to this same object. Its single
  // consumer treats null as routine and renders no preview, so this host is
  // indistinguishable from a checkout where the file is not in HEAD.
  //
  // Reading a real blob would need `git show` on the resident machine, and the
  // adapter's surface is three fs calls with no process execution. So this is
  // the edge of what the relay can do -- and it is still better than a 501,
  // which would reach that consumer as `isError` where null is silent.
  const { fetchHost, posted } = host({ files: fsDouble({ '/w/a': utf8('x') }) });
  assert.deepEqual(
    await body(fetchHost, posted, 'read-git-file-binary', { cwd: '/w', path: 'a', ref: 'head' }),
    { contentsBase64: null },
  );
  // Including with no filesystem at all, because it never needed one.
  const bare = host();
  assert.deepEqual(
    await body(bare.fetchHost, bare.posted, 'read-git-file-binary', { cwd: '/w', path: 'a' }),
    { contentsBase64: null },
  );
});

test('a caller handler wins over a built-in', async () => {
  const { fetchHost, posted } = host({
    handlers: { 'get-settings': async () => ({ values: { theme: 'dark' }, configuredValues: {} }) },
  });

  assert.deepEqual(await body(fetchHost, posted, 'get-settings'), {
    values: { theme: 'dark' },
    configuredValues: {},
  });
});

test('a handler is handed the parsed params, and no params at all arrives as undefined', async () => {
  const seen = [];
  const { fetchHost, posted } = host({
    handlers: {
      'paths-exist': async (params, context) => {
        seen.push({ params, endpoint: context.endpoint });
        return {};
      },
    },
  });

  await ask(fetchHost, posted, 'paths-exist', { paths: ['/a'] });
  await ask(fetchHost, posted, 'paths-exist');

  assert.deepEqual(seen, [
    { params: { paths: ['/a'] }, endpoint: 'paths-exist' },
    { params: undefined, endpoint: 'paths-exist' },
  ]);
});

test('a handler that returns nothing falls back to the shaped empty', async () => {
  // `body:undefined` would make the renderer run `JSON.parse(undefined)`, throw
  // inside its own try and reject, so a forgotten return would present as the
  // endpoint being broken rather than as empty.
  const { fetchHost, posted } = host({ handlers: { 'inbox-items': async () => {} } });

  const answered = await body(fetchHost, posted, 'inbox-items');
  assert.ok(Array.isArray(answered.unreadRunCounts.unreadRuns));
});

// ---- failure paths all converge on one reply ----------------------------

test('a handler that throws still yields exactly one reply', async () => {
  const { fetchHost, posted, kinds } = host({
    handlers: {
      'gh-pr-create': async () => {
        throw new Error('no github token');
      },
    },
  });

  const reply = await ask(fetchHost, posted, 'gh-pr-create', { title: 't' });
  assert.deepEqual(reply, {
    type: INBOUND.fetchResponse,
    requestId: reply.requestId,
    responseType: 'error',
    error: 'no github token',
    status: 500,
  });
  assert.ok(kinds().includes('endpoint-threw'));
  assert.equal(fetchHost.stats().failed, 1);
  assert.equal(fetchHost.pending, 0, 'a throw may not leave a request owed');
});

test('a handler that throws a non-Error still produces a readable reply', async () => {
  const { fetchHost, posted } = host({
    handlers: {
      'write-file': async () => {
        throw 'a bare string';
      },
    },
  });

  const reply = await ask(fetchHost, posted, 'write-file', { path: '/a' });
  assert.equal(reply.responseType, 'error');
  assert.equal(reply.error, 'a bare string');
});

test('a FetchEndpointError becomes a non-2xx success envelope, which is how the renderer rejects', async () => {
  const { fetchHost, posted } = host({
    handlers: {
      'gh-pr-merge': async () => {
        throw new FetchEndpointError('conflict', { status: 409, body: { reason: 'behind base' } });
      },
    },
  });

  const reply = await ask(fetchHost, posted, 'gh-pr-merge', {});
  assert.deepEqual(reply, {
    type: INBOUND.fetchResponse,
    requestId: reply.requestId,
    responseType: 'success',
    status: 409,
    headers: {},
    body: { reason: 'behind base' },
  });
});

test('a malformed url still yields exactly one reply, as the measured refusal frame', async () => {
  const { fetchHost, posted, kinds } = host();

  const message = { type: OUTBOUND.fetch, requestId: 'bad-url', method: 'POST', url: 'https://example.invalid/x' };
  await fetchHost.handle(message);

  assert.deepEqual(posted, [
    {
      type: INBOUND.fetchResponse,
      requestId: 'bad-url',
      responseType: 'error',
      error: 'cannot route host fetch url: https://example.invalid/x',
      status: 400,
    },
  ]);
  assert.ok(kinds().includes('url-unroutable'));
  assert.equal(fetchHost.pending, 0);
});

test('every unroutable url shape is answered, including the ones that are not strings', async () => {
  const { fetchHost, posted } = host();
  const urls = [undefined, null, 42, '', 'vscode://codex/', 'vscode://other/get-settings', {}];

  for (const [index, url] of urls.entries()) {
    await fetchHost.handle({ type: OUTBOUND.fetch, requestId: `u-${index}`, url });
  }

  assert.equal(posted.length, urls.length);
  for (const reply of posted) assert.equal(reply.responseType, 'error');
});

test('a body that is not JSON is refused rather than guessed at', async () => {
  // Unreachable from a real renderer, which produced the string with
  // JSON.stringify. The branch exists because the alternative to a reply is
  // silence, and inventing the params of a write endpoint is worse than saying
  // no to it.
  const { fetchHost, posted, kinds } = host();

  await fetchHost.handle({
    type: OUTBOUND.fetch,
    requestId: 'bad-body',
    url: `${FETCH_URL_PREFIX}set-setting`,
    body: '{not json',
  });

  assert.equal(posted.length, 1);
  assert.equal(posted[0].responseType, 'error');
  assert.equal(posted[0].status, 400);
  assert.ok(kinds().includes('body-unparseable'));
});

test('a fetch with no usable requestId is counted rather than answered', async () => {
  // A reply the renderer's pending table cannot match is indistinguishable from
  // no reply at all, so there is nothing worth sending -- but it must not pass
  // unnoticed either.
  const { fetchHost, posted, kinds } = host();

  await fetchHost.handle({ type: OUTBOUND.fetch, url: `${FETCH_URL_PREFIX}get-settings` });
  await fetchHost.handle({ type: OUTBOUND.fetch, requestId: '', url: `${FETCH_URL_PREFIX}get-settings` });
  await fetchHost.handle({ type: OUTBOUND.fetch, requestId: 7, url: `${FETCH_URL_PREFIX}get-settings` });

  assert.deepEqual(posted, []);
  assert.equal(fetchHost.stats().unanswerable, 3);
  assert.equal(kinds().filter((kind) => kind === 'request-unanswerable').length, 3);
});

test('a duplicate requestId does not take over the first request reply slot', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { fetchHost, posted, kinds } = host({
    handlers: {
      'status-summary': async () => {
        await gate;
        return { summary: 'first' };
      },
    },
  });

  const first = fetchHost.handle({ type: OUTBOUND.fetch, requestId: 'same', url: `${FETCH_URL_PREFIX}status-summary` });
  await fetchHost.handle({ type: OUTBOUND.fetch, requestId: 'same', url: `${FETCH_URL_PREFIX}get-settings` });
  assert.deepEqual(posted, [], 'the second must not answer on behalf of the first');

  release();
  await first;
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].body, { summary: 'first' });
  assert.ok(kinds().includes('request-duplicate'));
});

// ---- cancellation --------------------------------------------------------

test('cancel-fetch sends no response and makes a later completion a no-op', async () => {
  // Fire and forget: by the time `cancel-fetch` leaves, the renderer has
  // already deleted its own pending entry and rejected locally with an
  // AbortError, so a reply afterwards matches nothing.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { fetchHost, posted, kinds } = host({
    handlers: {
      'branch-diff-stats': async () => {
        await gate;
        return { files: 3 };
      },
    },
  });

  const message = request('branch-diff-stats', { base: 'main' });
  const settled = fetchHost.handle(message);
  assert.equal(fetchHost.pending, 1);

  assert.equal(fetchHost.cancel(message.requestId), true);
  assert.equal(fetchHost.pending, 0);

  release();
  await settled;

  assert.deepEqual(posted, [], 'a cancelled request must stay silent');
  const stats = fetchHost.stats();
  assert.equal(stats.cancelled, 1);
  assert.equal(stats.dropped, 1, 'the completion was dropped, not answered');
  assert.equal(stats.answered, 0);
  assert.ok(kinds().includes('reply-dropped'));
});

test('a cancel for a request we never held is silent and counted', async () => {
  const { fetchHost, posted, kinds } = host();

  assert.equal(fetchHost.cancel('never-seen'), false);
  assert.equal(fetchHost.cancel(undefined), false);

  assert.deepEqual(posted, []);
  assert.equal(fetchHost.stats().cancelMissed, 2);
  assert.ok(kinds().includes('cancel-unmatched'));
});

test('cancelling one request does not disturb another', async () => {
  const gates = new Map();
  const { fetchHost, posted } = host({
    handlers: {
      'file-diff': async (params) => {
        await new Promise((resolve) => gates.set(params.path, resolve));
        return { path: params.path };
      },
    },
  });

  const keep = request('file-diff', { path: '/keep' });
  const drop = request('file-diff', { path: '/drop' });
  const settled = Promise.all([fetchHost.handle(keep), fetchHost.handle(drop)]);
  await new Promise((resolve) => setImmediate(resolve));

  fetchHost.cancel(drop.requestId);
  for (const resolve of gates.values()) resolve();
  await settled;

  assert.equal(posted.length, 1);
  assert.equal(posted[0].requestId, keep.requestId);
  assert.deepEqual(posted[0].body, { path: '/keep' });
});

// ---- URL parsing ---------------------------------------------------------

test('the endpoint name is the path after the prefix, without query or fragment', () => {
  assert.equal(parseFetchUrl('vscode://codex/get-settings'), 'get-settings');
  assert.equal(parseFetchUrl('vscode://codex/read-file?hostId=local'), 'read-file');
  assert.equal(parseFetchUrl('vscode://codex/read-file#frag'), 'read-file');
  assert.equal(parseFetchUrl('vscode://codex/a/nested/name'), 'a/nested/name');
});

test('only the two tunnelled url forms parse, and the dictation literal is one of them', () => {
  // The measured guard is `!t.startsWith(`vscode://codex/`) && t !==
  // `/codex/dictation-stream-connect-info`` -- everything else in the same
  // client goes to the browser's own fetch and never reaches a host.
  assert.equal(parseFetchUrl(DICTATION_STREAM_URL), DICTATION_STREAM_URL);
  assert.equal(parseFetchUrl('vscode://codex/'), null);
  assert.equal(parseFetchUrl('/codex/dictation-stream-connect-info/extra'), null);
  assert.equal(parseFetchUrl('https://example.invalid/get-settings'), null);
  assert.equal(parseFetchUrl(undefined), null);
  assert.equal(parseFetchUrl(123), null);
});

test('the dictation endpoint is answered, because it is tunnelled too', async () => {
  const { fetchHost, posted } = host();

  const message = {
    type: OUTBOUND.fetch,
    requestId: 'dictation',
    method: 'POST',
    url: DICTATION_STREAM_URL,
  };
  await fetchHost.handle(message);

  assert.equal(posted.length, 1);
  assert.equal(posted[0].responseType, 'success');
  assert.deepEqual(posted[0].body, {});
});

// ---- the store and the shape table --------------------------------------

test('the memory store serialises, so a later mutation of a stored value is not visible', async () => {
  const store = createMemoryStore();
  const value = { rootPaths: ['/a'] };

  await store.set('k', value);
  value.rootPaths.push('/injected');

  assert.deepEqual(await store.get('k'), { rootPaths: ['/a'] });
  assert.equal(await store.get('absent'), undefined);
});

test('the memory store hands out a fresh copy on every read', async () => {
  const store = createMemoryStore({ k: { n: 1 } });

  const first = await store.get('k');
  first.n = 2;

  assert.deepEqual(await store.get('k'), { n: 1 });
});

test('shapedEmptyBody hands back a fresh object each time', () => {
  // These become react-query cache entries that the renderer's own reducers
  // spread and rewrite, so two requests sharing one object would let one
  // request's cache mutation show up in the other.
  const first = shapedEmptyBody('inbox-items');
  const second = shapedEmptyBody('inbox-items');

  assert.notEqual(first, second);
  first.items.push({ id: 'x' });
  assert.deepEqual(second.items, []);
  assert.deepEqual(shapedEmptyBody('an-unknown-endpoint'), {});
});

test('the startup endpoints the real bundle asks for answer with a shape', () => {
  // Every one of these was found by driving the real renderer to first paint:
  // it requested the endpoint, this module had no name for it, and the reply
  // was `{}`. The shapes are read out of the bundle's own consumers, so this
  // test fails if someone rounds one of them back off to a bare object.
  const measured = {
    'codex-command-keymap-state': { bindings: [], keymapPath: null, supported: false },
    'os-info': { platform: 'web' },
    'locale-info': { ideLocale: null, systemLocale: null },
    'is-copilot-api-available': { available: false },
    'list-automations': { items: [] },
  };

  for (const [endpoint, shape] of Object.entries(measured)) {
    assert.ok(KNOWN_ENDPOINTS.includes(endpoint), `${endpoint} is not a known endpoint`);
    assert.deepEqual(shapedEmptyBody(endpoint), shape);
  }
});

test('mcp-codex-config answers null, which is what the sibling branch answers', () => {
  // The only entry in the table that is NOT there to prevent a TypeError.
  // `(await r(`mcp-codex-config`,...)).config` off a bare `{}` is undefined and
  // throws nothing; the reason to shape it is that the non-local branch of the
  // very same expression returns a literal null, so null is the vocabulary and
  // undefined is a value the rest of the pipeline never otherwise sees.
  assert.ok(KNOWN_ENDPOINTS.includes('mcp-codex-config'));
  const body = shapedEmptyBody('mcp-codex-config');
  assert.deepEqual(body, { config: null });
  assert.ok('config' in body, 'present-as-null and absent are different bytes to the app server');
});

test('the keymap shape answers the read that took the real page down', () => {
  // The measured consumer, transcribed: the atom is
  // `{...t, primaryNumberShortcutTarget: void 0}` when the query data is
  // non-null, and `rHr` then reads `t?.bindings.filter(...)` off it. `{}`
  // clears the `?.` and throws on `.filter`, which is how an endpoint nobody
  // had named reached React's error boundary.
  const read = (data) => {
    const atom = data == null ? data : { ...data, primaryNumberShortcutTarget: undefined };
    return atom?.bindings.filter((binding) => binding.command === 'thread1');
  };

  assert.throws(() => read({}), TypeError);
  assert.equal(read(null), undefined);
  assert.deepEqual(read(shapedEmptyBody('codex-command-keymap-state')), []);
});

// ---- the seven from the second real-chain drive -------------------------
//
// Same provenance as the five above -- the real renderer asked, this table had
// no name for it, the reply was `{}` -- with one addition: each was traced from
// the endpoint name to the call site that consumes the answer before it was
// written down. Two of them turned out to want a null body, which no row above
// does. So the tests below pin the body, and then pin the property that forced
// it by transcribing the consumer that has that property.

test('the seven endpoints from the second drive answer their measured shape', () => {
  const measured = {
    'get-copilot-api-proxy-info': null,
    'developer-instructions': { instructions: '' },
    'paths-exist': { existingPaths: [] },
    'local-custom-agents': { agents: [] },
    'mcp-codex-config': { config: null },
    'wsl-bash-availability': { available: false, distro: null },
    'fast-mode-rollout-metrics': null,
  };

  for (const [endpoint, shape] of Object.entries(measured)) {
    assert.ok(KNOWN_ENDPOINTS.includes(endpoint), `${endpoint} is not a known endpoint`);
    assert.deepEqual(shapedEmptyBody(endpoint), shape);
  }
});

test('a null shape still reaches the renderer as a body key rather than a missing one', async () => {
  // `'body' in e ? e.body : JSON.parse(e.bodyJsonString)` is the measured
  // decode, so `body: null` and no body key at all are not the same thing: the
  // second makes the renderer parse undefined, throw inside its own try and
  // reject. A null shape has to survive the envelope builder to be worth
  // anything.
  const { fetchHost, posted } = host();

  for (const endpoint of ['get-copilot-api-proxy-info', 'fast-mode-rollout-metrics']) {
    const reply = await ask(fetchHost, posted, endpoint, { startTimeMs: 0, maxRollouts: 100 });
    assert.equal(reply.responseType, 'success');
    assert.equal(reply.status, 200);
    assert.ok('body' in reply, `${endpoint} must carry a body key`);
    assert.equal(reply.body, null);
  }
});

test('the copilot proxy answer is null, because {} configures a provider with no url', () => {
  // The measured builder, transcribed from app-shared-59042e7300f7.js@1974689:
  //   let l={},u=await n(),d;
  //   if(u!=null){d=zN;let{baseUrl:e,secret:t}=u;l.model_provider=zN,
  //     l[`model_providers.${zN}`]={name:BEt,base_url:e,
  //     experimental_bearer_token:t,wire_api:`responses`}}else d=null
  // This runs for every thread, and its output is the config a turn starts
  // with. The `{}` rows are the point of the test: they are what this host
  // would be sending if the shape table had let the blank through.
  const build = (proxyInfo) => {
    const config = {};
    let modelProvider = null;
    if (proxyInfo != null) {
      modelProvider = 'copilot';
      const { baseUrl, secret } = proxyInfo;
      config.model_provider = 'copilot';
      config['model_providers.copilot'] = {
        base_url: baseUrl,
        experimental_bearer_token: secret,
        wire_api: 'responses',
      };
    }
    return { config, modelProvider };
  };

  assert.deepEqual(build(shapedEmptyBody('get-copilot-api-proxy-info')), {
    config: {},
    modelProvider: null,
  });
  assert.equal(build({}).config.model_provider, 'copilot', '{} clears the u!=null guard');
  assert.equal(build({}).config['model_providers.copilot'].base_url, undefined);
});

test('the fast-mode metrics answer is null, because {} renders a NaN estimate', () => {
  // Transcribed from app-primary-c9f7ac16cee9.js@211701 (the store) and @212172
  // (the banner). The fetch result is guarded with `e==null`, but every guard
  // after that is a numeric comparison, and `undefined < n` is false -- so `{}`
  // is the one answer that gets past both and reaches the arithmetic. `SBe` is
  // a threshold constant whose value does not matter here; any number shows the
  // same property.
  const store = (metrics) =>
    metrics == null
      ? null
      : {
          estimatedSavedMs: metrics.estimatedSavedMs,
          rolloutCountWithCompletedTurns: metrics.rolloutCountWithCompletedTurns,
        };
  const banner = (atom) => {
    if (atom == null || atom.rolloutCountWithCompletedTurns < 1 || atom.estimatedSavedMs < 60_000) {
      return null;
    }
    const minutes = Math.round(atom.estimatedSavedMs / 60_000);
    return {
      savedHours: Math.floor(minutes / 60),
      savedMinutes: minutes % 60,
      threadCount: atom.rolloutCountWithCompletedTurns,
    };
  };

  assert.equal(banner(store(shapedEmptyBody('fast-mode-rollout-metrics'))), null);

  const fromBlank = banner(store({}));
  assert.notEqual(fromBlank, null, '{} trips neither numeric guard');
  assert.ok(Number.isNaN(fromBlank.savedHours), 'and the banner then renders NaN hours');
  assert.equal(fromBlank.threadCount, undefined);
});

test('developer-instructions answers a string, because the side chat calls trim on it', () => {
  // `let[c,{instructions:l}]=await Promise.all([...])` and then
  // `developerInstructions:l.trim()?`${l}\n\n${Ifs}`:Ifs`
  // (app-initial-60d038a052d7.js@8600897). The destructure is unguarded and so
  // is the method call, which makes this the one endpoint in the batch where
  // null and `{}` fail in exactly the same way.
  const base = 'You are in a side conversation';
  const sideChat = (answered) => {
    const { instructions } = answered;
    return instructions.trim() ? `${instructions}\n\n${base}` : base;
  };

  assert.equal(sideChat(shapedEmptyBody('developer-instructions')), base);
  assert.throws(() => sideChat(null), TypeError);
  assert.throws(() => sideChat({}), TypeError);
});

test('paths-exist answers an array under the measured key, and claims nothing exists', async () => {
  // The dangerous reader is `new Set(s?.existingPaths.map(an)??[])`
  // (review-file-tree-pane-86f41c3f14f9.js@34087) -- optional chaining on the
  // container, a bare `.map` on the field, so `{}` throws inside a render.
  const { fetchHost, posted } = host();
  const asked = ['/srv/work/AGENTS.md', '/srv/work/README.md'];
  const answered = await body(fetchHost, posted, 'paths-exist', { hostId: 'local', paths: asked });

  assert.deepEqual(answered, { existingPaths: [] });

  const read = (data) => new Set(data?.existingPaths.map((path) => path) ?? []);
  assert.equal(read(answered).size, 0, "the consumer's map must not throw");
  assert.throws(() => read({}), TypeError);
  assert.equal(read(null).size, 0);

  // The answer is correlated with the request -- the real host returns the
  // subset of the sent paths that exist (`i.filter((e,t)=>o.has(a[t]??``))`,
  // main-C3nRcJ3D.js@1375609) -- so echoing the request back would be a claim,
  // and the claim `/init` acts on is "AGENTS.md is already here, skip".
  for (const path of asked) assert.ok(!answered.existingPaths.includes(path));
});

test('local-custom-agents survives its select and the filter that reads the result', () => {
  // `function sTn(e){return{roles:e.agents}}`
  // (app-shared-59042e7300f7.js@3475121) is a react-query select, so it runs
  // against the body itself with no guard, and the list then reads
  // `_e?.roles.filter(e=>!ye.has(e.roleName))??[]`
  // (app-initial-60d038a052d7.js@10227214) -- container guarded, field not.
  // Two unguarded reads in series is what makes `{}` a render-time throw.
  const select = (data) => ({ roles: data.agents });
  const list = (selected) => selected?.roles.filter((role) => role.roleName !== 'reviewer') ?? [];

  assert.deepEqual(list(select(shapedEmptyBody('local-custom-agents'))), []);
  assert.throws(() => select(null), TypeError);
  assert.throws(() => list(select({})), TypeError);
});

test('mcp-codex-config answers the key, and its null value contributes no overrides', () => {
  // `.config` is read off the body with nothing in front of it
  // (app-shared-59042e7300f7.js@3620001), so the key is mandatory. The value is
  // consumed as `if(e)for(let[t,n]of Object.entries(e))l[t]=n`
  // (app-shared-59042e7300f7.js@1974689), and null is the value the renderer's
  // own non-local branch hands that consumer -- which is why it is the value
  // every consumer is known to survive, and why `{}` is not needed to be safe.
  const read = (answered) => answered.config;
  const apply = (config) => {
    const overrides = {};
    if (config) for (const [key, value] of Object.entries(config)) overrides[key] = value;
    return overrides;
  };

  const answered = shapedEmptyBody('mcp-codex-config');
  assert.deepEqual(answered, { config: null });
  assert.equal(read(answered), null);
  assert.deepEqual(apply(read(answered)), {});
  assert.throws(() => read(null), TypeError);
});

test('wsl-bash-availability answers the record the real producer answers with no distro', async () => {
  // `return e==null?{available:!1,distro:null}:new Promise(...)`
  // (application-network-startup-DN7Ktmlk.js@56366) is the host's own answer
  // when no distribution is eligible, which is this host's permanent state.
  const { fetchHost, posted } = host();
  const answered = await body(fetchHost, posted, 'wsl-bash-availability');
  assert.deepEqual(answered, { available: false, distro: null });

  // `let n;try{n=await gt(...)}catch{o({distro:null});return}
  //  if(!n.available){o({distro:n.distro});return}`
  // (general-settings-658418b16f6c.js@125393): `n.available` is OUTSIDE the
  // try, so a null body is an unhandled TypeError in a click handler rather
  // than the caught failure sitting next to it.
  const onSelect = (value) => (value.available ? 'enabled' : { distro: value.distro });
  assert.deepEqual(onSelect(answered), { distro: null }, 'the error state the renderer sets');
  assert.throws(() => onSelect(null), TypeError);

  // `a.distro??<this WSL distribution>` (general-settings-658418b16f6c.js
  // @124704) is where that value is rendered, and null is what reaches the
  // localized fallback instead of printing as part of a sentence.
  assert.equal(answered.distro ?? 'this WSL distribution', 'this WSL distribution');
});

// ---- the four from the shaped-vs-blank census ---------------------------
//
// Different provenance from the two batches above: these did not come from
// watching a startup, they came from reading `endpoint-unimplemented` rows with
// `shaped: false` out of a running session and then measuring each one in the
// production bundles. Three shapes are literals the real host sends for a
// platform or configuration that cannot answer; the fourth is the renderer's
// own fallback constant.

test('the four endpoints from the census answer their measured shape', () => {
  const measured = {
    'external-agent-import-status': { importedSessionCount: 0, latestImportedAtMs: null },
    'worktree-shell-environment-config': { shellEnvironment: null },
    'global-dictation-hotkey-state': {
      supported: false,
      configuredHotkey: null,
      configuredToggleHotkey: null,
    },
    'ambient-suggestions': {
      file: { projectRoot: '', generatedAtMs: null, currentSuggestionIds: [], suggestions: [] },
    },
  };

  for (const [endpoint, shape] of Object.entries(measured)) {
    assert.ok(KNOWN_ENDPOINTS.includes(endpoint), `${endpoint} is not a known endpoint`);
    assert.deepEqual(shapedEmptyBody(endpoint), shape);
  }
});

test('ambient-suggestions survives the optimistic update behind accepting a suggestion', () => {
  // The reason this row exists, and the reason no first-paint drive found it.
  // Transcribed from new-chat-suggestion-source-debug-state-399c302a5808.js:
  //   function b(e,t,n,r){e.query.snapshot(N,t).setData(e=>e==null?e:
  //     {file:{...e.file,suggestions:e.file.suggestions.map(e=>
  //       e.id===n?{...e,status:r}:e)}})}
  // home-ambient-suggestions-content-337c7cd61e3c.js@2334 imports it as `Zn`
  // and runs it from the `ambient-suggestion-set-status` mutation's `onMutate`,
  // so it fires when a user taps a suggestion -- not during render. The guard
  // covers the body and not the field, which is the inbox-items trait, and it
  // is why `{}` here is a TypeError inside a mutation callback.
  const onMutate = (cached, id, status) =>
    cached == null
      ? cached
      : {
          file: {
            ...cached.file,
            suggestions: cached.file.suggestions.map((suggestion) =>
              suggestion.id === id ? { ...suggestion, status } : suggestion,
            ),
          },
        };

  const answered = shapedEmptyBody('ambient-suggestions');
  assert.deepEqual(onMutate(answered, 'suggestion-1', 'accepted'), {
    file: { projectRoot: '', generatedAtMs: null, currentSuggestionIds: [], suggestions: [] },
  });
  assert.throws(() => onMutate({}, 'suggestion-1', 'accepted'), TypeError);
  assert.throws(() => onMutate({ file: null }, 'suggestion-1', 'accepted'), TypeError);
  assert.equal(onMutate(null, 'suggestion-1', 'accepted'), null);
});

test('ambient-suggestions answers the file shape rather than null, which null would fail', () => {
  // Null passes the mutation guard above, so it would be tempting -- and the
  // other two readers are what rule it out. The readiness atom is
  //   R=r(u,(e,{get:t})=>{let n=t(N,e);return n.data!=null||n.isError})
  // so a null body is neither data nor an error and the surface never settles;
  // the selector is
  //   z=...{let i=r(N,{...}).data?.file;
  //     return D(i?.currentSuggestionIds??[],i?.suggestions??[])}
  // which is defaulted on both arguments and therefore safe either way. The
  // measured file shape is the only answer that satisfies all three readers at
  // once, which is also why the host sends it instead of null.
  const settled = (query) => query.data != null || query.isError;
  const select = (query) => {
    const file = query.data?.file;
    const ids = file?.currentSuggestionIds ?? [];
    const suggestions = file?.suggestions ?? [];
    return ids
      .map((id) => suggestions.find((suggestion) => suggestion.id === id))
      .filter((suggestion) => suggestion?.status === 'pending');
  };

  const answered = shapedEmptyBody('ambient-suggestions');
  assert.equal(settled({ data: answered, isError: false }), true);
  assert.equal(settled({ data: null, isError: false }), false, 'null never settles');
  assert.deepEqual(select({ data: answered }), [], 'and the shape selects to no suggestions');
});

test('global-dictation-hotkey-state reports unsupported, so the nudge never offers a hotkey', () => {
  // `function yFi({hotkeyState:e,isGlobalDictationEnabled:t,nudgeState:n}){
  //   return t&&n===`eligible`&&e?.supported===!0}`
  // (app-initial-60d038a052d7.js@4694207); the component returns null when it
  // is false. The test pins both halves of why `supported:false` is written out
  // rather than left absent: the gate tests `===!0`, so an absent field would
  // also suppress the nudge -- and the row says it on purpose, because this
  // host serves no `global-dictation-set-hotkey` for the nudge to call.
  const shows = (hotkeyState) =>
    true && 'eligible' === 'eligible' && hotkeyState?.supported === true;

  const answered = shapedEmptyBody('global-dictation-hotkey-state');
  assert.equal(answered.supported, false);
  assert.equal(shows(answered), false);
  assert.equal(shows({}), false, 'an absent field is not true either');
  assert.equal(shows({ supported: true }), true, 'and the gate does open on a real state');

  // The hotkey pair's own reader is fully optional-chained
  // (`hBe`, app-primary-c9f7ac16cee9.js@207546), so the nulls are a shape
  // rather than a requirement -- it answers null for "no hotkey configured".
  const resolve = (state) =>
    state?.configuredHotkey == null
      ? state?.configuredToggleHotkey == null
        ? null
        : { hotkey: state.configuredToggleHotkey, mode: 'toggle' }
      : { hotkey: state.configuredHotkey, mode: 'hold' };
  assert.equal(resolve(answered), null);
});

test('worktree-shell-environment-config answers a null environment, not a missing key', () => {
  // `async function ven(e,t,n,r,i){try{let{shellEnvironment:t}=await n();
  //  if(t==null)return e;...}catch(n){return i.warning(`Failed to apply
  //  worktree shell environment config`,...),e}}`
  // (app-shared-59042e7300f7.js@2802811). The whole body is a try/catch that
  // returns the start config unchanged, so this endpoint failing was always
  // survivable -- that is why turns worked while it answered 501. What it was
  // not is quiet, and the point of the row is to take the `t==null` arm, which
  // is the branch written for a host with no environment to apply, instead of
  // the catch arm that logs at every turn start.
  const warnings = [];
  const apply = async (startConfig, read) => {
    try {
      const { shellEnvironment } = await read();
      if (shellEnvironment == null) return startConfig;
      return { ...startConfig, env: shellEnvironment };
    } catch (error) {
      warnings.push(String(error.message));
      return startConfig;
    }
  };

  const startConfig = { cwd: '/srv/work' };
  return Promise.all([
    apply(startConfig, async () => shapedEmptyBody('worktree-shell-environment-config')),
    apply(startConfig, async () => {
      throw new Error('501 worktree-shell-environment-config');
    }),
  ]).then(([shaped, failed]) => {
    assert.deepEqual(shaped, startConfig, 'the guard arm, with no warning');
    assert.deepEqual(failed, startConfig, 'the catch arm reaches the same config');
    assert.deepEqual(warnings, ['501 worktree-shell-environment-config']);
  });
});

test('external-agent-import-status answers the renderer\'s own fallback, field for field', () => {
  // `let D=L_e(`external-agent-import-status`,E).data??yHs` then
  // `D.latestImportedAtMs` (app-initial-60d038a052d7.js@9203389), over
  // `yHs={importedSessionCount:0,latestImportedAtMs:null}` (@9218517). When a
  // renderer names its own shape for an absent answer, matching it exactly is
  // what makes the answered path and the absent path the same path -- so the
  // test is an equality against that constant rather than against a shape this
  // repository chose.
  const rendererFallback = { importedSessionCount: 0, latestImportedAtMs: null };
  const read = (data) => data ?? rendererFallback;

  const answered = shapedEmptyBody('external-agent-import-status');
  assert.deepEqual(answered, rendererFallback);
  assert.deepEqual(read(answered), read(undefined), 'answered and absent read alike');
  assert.equal(read(answered).latestImportedAtMs, null);
});

test('external-agent-import-detect answers a shape its unguarded consumer can destructure', () => {
  // The renderer's own module-level empty for this query,
  // `JZi={items:[],unsupportedProjects:[]}` (app-initial-60d038a052d7.js
  // @4994712).
  const rendererFallback = { items: [], unsupportedProjects: [] };
  const answered = shapedEmptyBody('external-agent-import-detect');
  assert.deepEqual(answered, rendererFallback);

  // The foreground consumer (@4996068) would have survived `{}` on its own:
  // every read is optional-chained with a default. Asserting it anyway, because
  // it is the reason this endpoint looked harmless.
  assert.deepEqual(answered?.items ?? rendererFallback.items, []);
  assert.deepEqual(answered?.unsupportedProjects ?? rendererFallback.unsupportedProjects, []);

  // The background sync path is the one that needed the shape: `let{items:a}=`
  // followed by `a.filter(...)` with nothing in between (@9106924). Written out
  // rather than described, so the test fails the same way the renderer would.
  const consume = (body) => {
    const { items } = body;
    return items.filter(Boolean).length;
  };
  assert.equal(consume(answered), 0);
  assert.throws(() => consume({}), TypeError, 'a bare {} is what this shape exists to prevent');
});

test('the two remote-connection mutations stay unshaped, and say so in the census', async () => {
  // Deliberate, and worth a test because the obvious next move after four new
  // rows is a fifth and a sixth. Both are fire-and-forget `useEffect` syncs
  // with their own `.catch` that logs `sync_failed` and reads no reply
  // (app-initial-60d038a052d7.js@9650092 and @9651112), so a shape would be an
  // invented connection list discarded by a caller that never looks. They are
  // reported with `shaped: false`, which is the census row that says the blank
  // was a decision.
  const { fetchHost, posted, events } = host();

  for (const endpoint of [
    'set-remote-control-connections-enabled',
    'set-remote-wsl-connections-enabled',
  ]) {
    assert.deepEqual(shapedEmptyBody(endpoint), {}, `${endpoint} must stay unshaped`);
    const reply = await ask(fetchHost, posted, endpoint, { enabled: false });
    assert.equal(reply.responseType, 'success');
    assert.deepEqual(reply.body, {});
  }

  assert.deepEqual(
    events.filter((event) => event.kind === 'endpoint-unimplemented'),
    [
      {
        kind: 'endpoint-unimplemented',
        endpoint: 'set-remote-control-connections-enabled',
        known: true,
        shaped: false,
      },
      {
        kind: 'endpoint-unimplemented',
        endpoint: 'set-remote-wsl-connections-enabled',
        known: true,
        shaped: false,
      },
    ],
  );
});

test('a shaped endpoint is still counted unimplemented, because a shape is not a handler', async () => {
  // `endpoint-unimplemented` could mean "no shape" or "nothing is routing
  // this". It has always meant the second -- `os-info` and the other four
  // shapes measured at first paint have no builtin and are still reported --
  // and seven new rows must not quietly change that, or the diagnostics stop
  // naming the endpoints that still need a real answer.
  const { fetchHost, posted, events } = host();

  await ask(fetchHost, posted, 'paths-exist', { paths: ['/a'] });
  await ask(fetchHost, posted, 'os-info');

  assert.deepEqual(
    events.filter((event) => event.kind === 'endpoint-unimplemented'),
    [
      { kind: 'endpoint-unimplemented', endpoint: 'paths-exist', known: true, shaped: true },
      { kind: 'endpoint-unimplemented', endpoint: 'os-info', known: true, shaped: true },
    ],
  );
  assert.equal(fetchHost.stats().unknown, 2);

  // A handler is the thing that takes an endpoint out of that count.
  const routed = host({ handlers: { 'paths-exist': () => ({ existingPaths: ['/a'] }) } });
  assert.deepEqual(await body(routed.fetchHost, routed.posted, 'paths-exist', { paths: ['/a'] }), {
    existingPaths: ['/a'],
  });
  assert.equal(routed.fetchHost.stats().unknown, 0);
  assert.equal(routed.kinds().includes('endpoint-unimplemented'), false);
});

test('the handler override path is unchanged by the new shapes, in both directions', async () => {
  // `shapedEmptyBody` is exported as the fallback a caller who replaces a
  // builtin lands on, and `handle` falls back to it when a handler returns
  // nothing. A handler that answers must still win outright; a handler that
  // forgets to answer now gets the measured shape, which for
  // `fast-mode-rollout-metrics` is the null its reader guards for rather than
  // the `{}` that would reach the arithmetic.
  const answering = host({
    handlers: {
      'developer-instructions': async (params) => ({ instructions: `cwd is ${params.cwd}` }),
    },
  });
  assert.deepEqual(
    await body(answering.fetchHost, answering.posted, 'developer-instructions', { cwd: '/srv/work' }),
    { instructions: 'cwd is /srv/work' },
  );

  const forgetful = host({ handlers: { 'fast-mode-rollout-metrics': async () => {} } });
  const reply = await ask(forgetful.fetchHost, forgetful.posted, 'fast-mode-rollout-metrics');
  assert.ok('body' in reply);
  assert.equal(reply.body, null);
});

// ---- construction and bookkeeping ---------------------------------------

test('a fetch layer with no way to answer is refused at construction', () => {
  // The alternative is a module that routes correctly and replies into nothing,
  // which is the permanent spinner this file exists to prevent -- found in a UI
  // that never loads instead of at the call site that built it.
  assert.throws(() => createHostFetch(), TypeError);
  assert.throws(() => createHostFetch({}), TypeError);
  assert.throws(() => createHostFetch({ deliver: 'not a function' }), TypeError);
});

test('a deliver that throws is named rather than left to escape into a bus listener', async () => {
  const events = [];
  const fetchHost = createHostFetch({
    deliver: () => {
      throw new Error('the bus is stopped');
    },
    onEvent: (event) => events.push(event),
  });

  await fetchHost.handle(request('get-settings'));

  assert.ok(events.some((event) => event.kind === 'deliver-failed'));
  assert.equal(fetchHost.pending, 0);
});

test('an onEvent that throws does not take the request down with it', async () => {
  const posted = [];
  const fetchHost = createHostFetch({
    deliver: (message) => posted.push(message),
    onEvent: () => {
      throw new Error('observer is broken');
    },
  });

  await fetchHost.handle(request('get-settings'));

  assert.equal(posted.length, 1);
});

test('the counters add up, and the copy they hand out is not the live object', async () => {
  const { fetchHost, posted } = host({
    handlers: {
      'a-throwing-endpoint': async () => {
        throw new Error('nope');
      },
      'a-refusing-endpoint': async () => {
        throw new FetchEndpointError('no', { status: 503 });
      },
    },
  });

  await fetchHost.handle(request('get-settings'));
  await fetchHost.handle(request('an-unimplemented-endpoint'));
  await fetchHost.handle(request('a-throwing-endpoint'));
  await fetchHost.handle(request('a-refusing-endpoint'));

  const stats = fetchHost.stats();
  assert.equal(stats.received, 4);
  assert.equal(stats.answered, posted.length);
  assert.equal(stats.answered, stats.succeeded + stats.rejected + stats.failed);
  assert.deepEqual(
    { succeeded: stats.succeeded, rejected: stats.rejected, failed: stats.failed, unknown: stats.unknown },
    { succeeded: 2, rejected: 1, failed: 1, unknown: 1 },
  );

  stats.received = 999;
  assert.equal(fetchHost.stats().received, 4);
});

// ---- end to end over a real bus and a real window -----------------------

test('attached to a real bus, one renderer fetch produces exactly one window message', async () => {
  // The renderer's transport sends every message along BOTH paths -- the bridge
  // call and the CustomEvent -- so a host that answered both would reply twice
  // to one request. The bridge is defined here precisely so that a regression
  // on that point fails this test rather than presenting as an intermittent
  // duplicate somewhere else.
  const window = makeWindow();
  window.electronBridge = { sendMessageFromView: async () => {} };
  const bus = createHostBus({ window });
  const inbound = collect(window, 'message');

  const fetchHost = createHostFetch({
    deliver: (message) => window.dispatchEvent(new MessageEvent('message', { data: message })),
    workspaceRoots: ['/projects/one'],
  });
  const detach = fetchHost.attach(bus);

  dispatchMessageFromView(window, OUTBOUND.fetch, {
    requestId: 'over-the-bus',
    method: 'POST',
    url: `${FETCH_URL_PREFIX}workspace-root-options`,
    body: JSON.stringify({ hostId: 'local' }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(inbound.data(), [
    {
      type: INBOUND.fetchResponse,
      requestId: 'over-the-bus',
      responseType: 'success',
      status: 200,
      headers: {},
      body: { roots: ['/projects/one'] },
    },
  ]);
  assert.equal(bus.stats.claimed, 1);

  detach();
  bus.stop();
});

test('a cancel-fetch over the bus silences the reply', async () => {
  const window = makeWindow();
  const bus = createHostBus({ window });
  const inbound = collect(window, 'message');

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fetchHost = createHostFetch({
    deliver: (message) => window.dispatchEvent(new MessageEvent('message', { data: message })),
    handlers: {
      'gh-pr-search': async () => {
        await gate;
        return { items: [] };
      },
    },
  });
  const detach = fetchHost.attach(bus);

  dispatchMessageFromView(window, OUTBOUND.fetch, {
    requestId: 'aborted',
    url: `${FETCH_URL_PREFIX}gh-pr-search`,
    body: JSON.stringify({ query: 'is:open' }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchHost.pending, 1);

  dispatchMessageFromView(window, OUTBOUND.cancelFetch, { requestId: 'aborted' });
  release();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(inbound.data(), []);
  assert.equal(fetchHost.stats().cancelled, 1);

  detach();
  bus.stop();
});

test('detaching stops the layer from seeing further renderer traffic', async () => {
  const window = makeWindow();
  const bus = createHostBus({ window });

  const fetchHost = createHostFetch({
    deliver: (message) => window.dispatchEvent(new MessageEvent('message', { data: message })),
  });
  fetchHost.attach(bus)();

  dispatchMessageFromView(window, OUTBOUND.fetch, {
    requestId: 'after-detach',
    url: `${FETCH_URL_PREFIX}get-settings`,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fetchHost.stats().received, 0);
  assert.equal(bus.stats.unclaimed, 1, 'the bus reports it as unclaimed rather than losing it');

  bus.stop();
});

test('attach refuses anything that is not a bus', () => {
  const fetchHost = createHostFetch({ deliver: () => {} });

  assert.throws(() => fetchHost.attach(), TypeError);
  assert.throws(() => fetchHost.attach({}), TypeError);
});
