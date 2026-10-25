#!/usr/bin/env node
// Read the Electron fuse wire out of a Codex App bundle, and index it by reading
// the accessors rather than by assuming a source ordering.
//
// Two traps this exists to avoid:
//
//   1. Codex's Electron fork RENAMED the fuse sentinel. Searching for the upstream
//      `dL7pKGdnNz796PbbjeW0L4m` returns zero hits, which reads as "no fuses" --
//      the wrong answer rather than no answer. So the wire is located by structure:
//      a version byte, a length byte, then a run of 0/1/r whose length matches.
//
//   2. This build ships NINE fuses, not upstream's eight (the extra is
//      WasmTrapHandlers). Mapping a 9-char wire onto an 8-entry upstream table
//      silently shifts every index past the insertion point. So each index is read
//      from its own accessor: they are 20-byte leaves of the form
//          adrp x8, <page> ; ldrb w8, [x8, #off] ; cmp w8, #0x31 ; cset w0, eq ; ret
//      and the byte each one loads is the fuse it reports.
//
// Run this after every Codex App update. The answers decide the fork mechanism.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SENTINEL_PREFIX = 'dL7pKGdnNz796Pbbj'; // the part the fork kept
const FUSE_CHAR = { '0': 'disabled', '1': 'enabled', 'r': 'removed' };

function frameworkBinary(bundle) {
  const frameworks = join(bundle, 'Contents', 'Frameworks');
  for (const fw of readdirSync(frameworks)) {
    if (!fw.endsWith('Framework.framework')) continue;
    const versions = join(frameworks, fw, 'Versions');
    if (!existsSync(versions)) continue;
    for (const v of readdirSync(versions)) {
      if (v === 'Current') continue;
      const bin = join(versions, v, fw.replace(/\.framework$/, ''));
      if (existsSync(bin)) return bin;
    }
  }
  throw new Error(`no Electron-style framework binary under ${frameworks}`);
}

// The wire: [version][length][length chars from 0/1/r], right after the sentinel.
function findWire(buf) {
  const found = [];
  for (let i = 0; i + 2 < buf.length; i++) {
    const version = buf[i];
    const len = buf[i + 1];
    if (version < 1 || version > 2) continue;
    if (len < 6 || len > 32) continue;
    let ok = true;
    for (let k = 0; k < len; k++) {
      const c = String.fromCharCode(buf[i + 2 + k]);
      if (!(c in FUSE_CHAR)) { ok = false; break; }
    }
    if (!ok) continue;
    // Reject a run that keeps going: the length byte must describe it exactly.
    const next = String.fromCharCode(buf[i + 2 + len]);
    if (next in FUSE_CHAR) continue;
    const before = buf.subarray(Math.max(0, i - 40), i).toString('latin1');
    found.push({
      versionByteOffset: i,
      version,
      length: len,
      wire: buf.subarray(i + 2, i + 2 + len).toString('latin1'),
      firstFuseOffset: i + 2,
      sentinel: before.includes(SENTINEL_PREFIX)
        ? before.slice(before.indexOf(SENTINEL_PREFIX))
        : null,
    });
  }
  // A real wire is preceded by the sentinel; anything else is a coincidence.
  const sentinelled = found.filter((f) => f.sentinel);
  return { candidates: found, wire: sentinelled.length === 1 ? sentinelled[0] : null, sentinelled };
}

function accessorOffsets(bin) {
  const nm = spawnSync('/usr/bin/nm', ['-arch', 'arm64', bin], {
    encoding: 'utf8', maxBuffer: 1 << 28,
  });
  if (nm.status !== 0) throw new Error(`nm failed: ${(nm.stderr || '').trim()}`);

  const syms = [];
  for (const line of nm.stdout.split('\n')) {
    const m = /^([0-9a-f]+)\s+\S+\s+(__ZN8electron5fuses\d+Is(\w+?)EnabledEv)$/.exec(line.trim());
    if (m) syms.push({ addr: parseInt(m[1], 16), symbol: m[2], fuse: m[3] });
  }
  if (!syms.length) throw new Error('no electron::fuses accessors found');
  syms.sort((a, b) => a.addr - b.addr);

  const lo = syms[0].addr;
  const hi = syms[syms.length - 1].addr + 0x20;
  const dis = spawnSync('/usr/bin/objdump',
    ['-d', `--start-address=0x${lo.toString(16)}`, `--stop-address=0x${hi.toString(16)}`, bin],
    { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (dis.status !== 0) throw new Error(`objdump failed: ${(dis.stderr || '').trim()}`);

  // Walk the disassembly, tracking which accessor we are inside, and take the
  // first `adrp`+`ldrb` pair in each body. Their sum is the byte it reports.
  const byFuse = new Map();
  let cur = null;
  let page = null;
  for (const raw of dis.stdout.split('\n')) {
    const label = /<(__ZN8electron5fuses\d+Is(\w+?)EnabledEv)>:/.exec(raw);
    if (label) { cur = label[2]; page = null; continue; }
    if (!cur || byFuse.has(cur)) continue;
    const adrp = /\badrp\s+x8,\s*(0x[0-9a-f]+)/.exec(raw);
    if (adrp) { page = parseInt(adrp[1], 16); continue; }
    const ldrb = /\bldrb\s+w8,\s*\[x8,\s*#(0x[0-9a-f]+|\d+)\]/.exec(raw);
    if (ldrb && page !== null) {
      const off = ldrb[1].startsWith('0x') ? parseInt(ldrb[1], 16) : Number(ldrb[1]);
      byFuse.set(cur, { byteAddress: page + off, page, offset: off });
    }
  }
  return syms.map((s) => ({ ...s, ...(byFuse.get(s.fuse) ?? {}) }));
}

function main() {
  const bundle = process.argv[2] ?? '/Applications/Codex cc.app';
  const bin = frameworkBinary(bundle);
  const buf = readFileSync(bin);

  const { wire, sentinelled, candidates } = findWire(buf);
  if (!wire) {
    throw new Error(sentinelled.length
      ? `ambiguous: ${sentinelled.length} sentinel-backed wires found`
      : `no sentinel-backed fuse wire; ${candidates.length} structural candidates`);
  }

  const accessors = accessorOffsets(bin);

  // The accessors address the wire by virtual address; for this dylib the
  // __TEXT vmaddr base is 0, so file offset == VA. Prove it rather than assume
  // it: the lowest-addressing accessor must land on the first fuse character.
  const lowest = Math.min(...accessors.map((a) => a.byteAddress ?? Infinity));
  const delta = lowest - wire.firstFuseOffset;

  const fuses = accessors.map((a) => {
    const index = a.byteAddress === undefined ? null : a.byteAddress - delta - wire.firstFuseOffset;
    const char = index !== null && index >= 0 && index < wire.length ? wire.wire[index] : null;
    return {
      index,
      fuse: a.fuse,
      byteAddress: a.byteAddress === undefined ? null : `0x${a.byteAddress.toString(16)}`,
      char,
      state: char ? FUSE_CHAR[char] : 'UNREADABLE',
    };
  }).sort((a, b) => (a.index ?? 99) - (b.index ?? 99));

  const problems = [];
  if (delta !== 0) {
    problems.push(`accessors are offset from the wire by ${delta} bytes; indices are relative, not absolute`);
  }
  if (accessors.length !== wire.length) {
    problems.push(`${accessors.length} accessors but a ${wire.length}-fuse wire`);
  }
  if (fuses.some((f) => f.state === 'UNREADABLE')) {
    problems.push('at least one accessor body did not match the expected adrp/ldrb shape');
  }

  const get = (name) => fuses.find((f) => f.fuse === name)?.state ?? 'UNKNOWN';
  process.stdout.write(JSON.stringify({
    bundle,
    framework: bin,
    sentinel: wire.sentinel,
    sentinelIsUpstream: wire.sentinel === 'dL7pKGdnNz796PbbjeW0L4m',
    wire: wire.wire,
    wireVersion: wire.version,
    firstFuseOffset: `0x${wire.firstFuseOffset.toString(16)}`,
    fuses,
    problems,
    implications: {
      resourcesAppDirectoryIsConsulted: get('OnlyLoadAppFromAsar') !== 'enabled',
      asarIsHashChecked: get('EmbeddedAsarIntegrityValidation') === 'enabled',
      envVarPathToMainProcess:
        get('RunAsNode') === 'enabled' || get('NodeOptions') === 'enabled' ||
        get('NodeCliInspect') === 'enabled',
    },
  }, null, 2) + '\n');

  if (problems.length) process.exit(3);
}

try {
  main();
} catch (err) {
  process.stderr.write(`fuses: ${err.message}\n`);
  process.exit(1);
}
