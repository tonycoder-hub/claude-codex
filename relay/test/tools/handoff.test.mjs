// The driver must refuse a handoff that names a chain which is not there.
//
// It did not, and the way it failed is the reason this file is worth its size.
// `/tmp/real-chain-port` and `/tmp/real-chain-scratch` were written by
// real-chain.sh, which no longer exists. Nothing had updated them for an hour.
// A driver run read them, found an enrolment link in the dead chain's log, and
// reported `enrol-link ok` -- a green step, sourced entirely from a surface
// that had already exited -- before every later step failed on a refused
// connection.
//
// The later failures were loud, so the run was not mistaken for a success. But
// the green step was the dangerous part: it answered "is there a link to enrol
// with?" with yes, about a chain that could not have served one. Had the dead
// chain's port been reused by something else that answers HTTP, that run would
// have gone further before failing, and the failures would have pointed at the
// wrong things.
//
// These tests drive the preflight only. It runs before the browser is spawned,
// so they cost a process start and no Chrome.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DRIVER = fileURLToPath(new URL('../../tools/bring-up/drive-real.mjs', import.meta.url));

/**
 * A handoff directory of our own.
 *
 * Never the real `/tmp` one: a test that overwrote it would break whatever
 * chain the developer running the suite had open, which is a rude way to prove
 * a point about staleness.
 */
function handoff({ port, scratch, pid }) {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-test-'));
  if (port !== undefined) writeFileSync(join(dir, 'real-chain-port'), `${port}\n`);
  if (scratch !== undefined) writeFileSync(join(dir, 'real-chain-scratch'), `${scratch}\n`);
  if (pid !== undefined) writeFileSync(join(dir, 'real-chain-pid'), `${pid}\n`);
  return dir;
}

/**
 * Run the driver's preflight and return what it died of, or null if it passed.
 *
 * `DRIVE_PREFLIGHT_ONLY` stops it before the browser. Without that, the one
 * case that is SUPPOSED to get past the preflight goes on to spawn Chrome and
 * wait out its connect timeout -- measured at 37 seconds, in a suite that runs
 * in under one.
 */
function refusal(dir, env = {}) {
  try {
    execFileSync(process.execPath, [DRIVER, join(dir, 'out')], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, DRIVE_HANDOFF_DIR: dir, DRIVE_PREFLIGHT_ONLY: '1', ...env },
      timeout: 60_000,
    });
    return null;
  } catch (e) {
    return String(e.stderr ?? e.message);
  }
}

/** A pid that is not running. 0 and negative numbers mean something else to `kill`. */
const DEAD_PID = 999_991;

test('a handoff naming a dead surface is refused, by pid', () => {
  const dir = handoff({ port: 56657, scratch: '/tmp/gone', pid: DEAD_PID });
  try {
    const err = refusal(dir);
    assert.match(err ?? '', /is not running/, 'the driver should say the recorded surface is gone');
    assert.match(err ?? '', /local\.sh --real/, 'and say how to get a live one');
    assert.doesNotMatch(err ?? '', /enrol/i, 'and get nowhere near reading a log for a link');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a handoff whose pid is alive but whose port is dead is refused too', () => {
  // The two are separate failures. A pid outlives its listener during shutdown,
  // and a port can be inherited by something unrelated -- so checking only the
  // pid would let the second case through. `process.pid` is alive by
  // construction and is listening on nothing.
  const dir = handoff({ port: 56657, scratch: '/tmp/gone', pid: process.pid });
  try {
    const err = refusal(dir);
    assert.match(err ?? '', /nothing is listening on http:\/\/localhost:56657/);
    assert.match(err ?? '', /stale log/, 'the message should say what driving on would have reported');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a handoff with no pid file at all is not treated as dead', () => {
  // An older local.sh wrote two files, not three. Reading a missing pid as a
  // dead one would refuse to drive a chain that is running perfectly well, and
  // the port check below is what should catch it instead.
  const dir = handoff({ port: 56657, scratch: '/tmp/gone' });
  try {
    const err = refusal(dir);
    assert.doesNotMatch(err ?? '', /is not running/, 'a missing pid file is not a dead pid');
    assert.match(err ?? '', /nothing is listening/, 'the port check is what rejects it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an explicit DRIVE_PORT skips the handoff check entirely', () => {
  // Passing the port by hand is the caller saying they know what they are
  // pointing at -- including at a chain they are about to start. Refusing that
  // would make the escape hatch useless.
  const dir = handoff({ port: 1, scratch: '/tmp/gone', pid: DEAD_PID });
  try {
    const err = refusal(dir, { DRIVE_PORT: '56657', DRIVE_SCRATCH: '/tmp/gone' });
    assert.equal(err, null, 'the preflight should pass straight through to the drive');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local.sh writes the three files the driver reads', () => {
  // Names, not behaviour: running local.sh here would start a real chain. The
  // failure this guards is the one that happened -- the writer went away and
  // the reader kept reading -- so the pin is that a writer exists at all.
  const script = execFileSync('cat', [fileURLToPath(new URL('../../tools/bring-up/local.sh', import.meta.url))], {
    encoding: 'utf8',
  });
  for (const name of ['real-chain-port', 'real-chain-scratch', 'real-chain-pid']) {
    assert.match(script, new RegExp(`> "\\$HANDOFF/${name}"`), `local.sh should write ${name}`);
  }
  assert.match(script, /DRIVE_HANDOFF_DIR:-\/tmp/, 'and honour the same override the driver reads');
});
