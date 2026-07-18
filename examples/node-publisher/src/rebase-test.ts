/**
 * Red-first test smoke for cmaf-loop-rebase: tfdt rebasing across loop
 * iterations so a looped CMAF fixture presents a CONTINUOUS media timeline
 * instead of replaying timestamps (which wedges MSE players at the loop
 * seam: the timeline-overlap dropper discards the replayed segments).
 *
 * Exit 0 = all assertions pass; non-zero otherwise (house smoke style).
 */
import { analyzeLoopSpan, rebaseTfdtCopy } from './cmaf-loop-rebase.js';

const te = new TextEncoder();
let failures = 0;
function check(name: string, fn: () => void): void {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`FAIL  ${name}: ${(err as Error).message}`); }
}
function assertEq(actual: unknown, expected: unknown, what: string): void {
  const a = typeof actual === 'bigint' ? actual.toString() : JSON.stringify(actual);
  const e = typeof expected === 'bigint' ? expected.toString() : JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

// ─── Box builders (mirrors the mse-adapter test helpers) ─────────────
function u32(v: number): Uint8Array {
  const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v); return b;
}
function u64(v: bigint): Uint8Array {
  const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v); return b;
}
function cat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}
function fourcc(t: string): Uint8Array { return te.encode(t); }
function box(type: string, body: Uint8Array): Uint8Array {
  return cat(u32(8 + body.byteLength), fourcc(type), body);
}
function fullBox(type: string, version: number, flags: number, body: Uint8Array): Uint8Array {
  const vf = new Uint8Array([version & 0xff, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]);
  return box(type, cat(vf, body));
}
const tfdt32 = (bmd: number) => fullBox('tfdt', 0, 0, u32(bmd));
const tfdt64 = (bmd: bigint) => fullBox('tfdt', 1, 0, u64(bmd));
function tfhd(trackId: number, defaultDur?: number): Uint8Array {
  const flags = defaultDur !== undefined ? 0x8 : 0;
  const body = defaultDur !== undefined ? cat(u32(trackId), u32(defaultDur)) : u32(trackId);
  return fullBox('tfhd', 0, flags, body);
}
/** trun with optional per-sample durations (flag 0x100). */
function trun(sampleCount: number, sampleDurations?: number[]): Uint8Array {
  if (sampleDurations) {
    return fullBox('trun', 0, 0x100, cat(u32(sampleCount), ...sampleDurations.map(u32)));
  }
  return fullBox('trun', 0, 0, u32(sampleCount));
}
function seg(opts: { tfdt: Uint8Array; defaultDur?: number; trun: Uint8Array; extraTraf?: Uint8Array }): Uint8Array {
  const traf = box('traf', cat(tfhd(1, opts.defaultDur), opts.tfdt, opts.trun));
  const moofBody = opts.extraTraf ? cat(traf, opts.extraTraf) : traf;
  return cat(box('styp', new Uint8Array(8)), box('moof', moofBody), box('mdat', new Uint8Array(16)));
}

// ─── Tests ───────────────────────────────────────────────────────────
console.log('[rebase-test]');

check('span from default sample duration (tfhd)', () => {
  const chunks = [
    seg({ tfdt: tfdt32(0), defaultDur: 100, trun: trun(5) }),      // 0..500
    seg({ tfdt: tfdt32(500), defaultDur: 100, trun: trun(5) }),    // 500..1000
  ];
  const span = analyzeLoopSpan(chunks);
  assertEq(span, 1000n, 'span');
});

check('span from per-sample trun durations', () => {
  const chunks = [
    seg({ tfdt: tfdt32(0), trun: trun(3, [100, 120, 80]) }),       // 0..300
    seg({ tfdt: tfdt32(300), trun: trun(2, [150, 150]) }),         // 300..600
  ];
  assertEq(analyzeLoopSpan(chunks), 600n, 'span');
});

check('rebase v0 tfdt adds the delta and touches ONLY the tfdt payload', () => {
  const original = seg({ tfdt: tfdt32(500), defaultDur: 100, trun: trun(5) });
  const before = original.slice();
  const rebased = rebaseTfdtCopy(original, 1000n);
  assertEq(analyzeLoopSpan([rebased]) !== null, true, 'still parseable');
  // Original untouched
  assertEq(Buffer.compare(Buffer.from(original), Buffer.from(before)), 0, 'original unmodified');
  // Exactly 4 bytes differ (the u32 BMD), and the new BMD reads 1500.
  let diffs = 0;
  for (let i = 0; i < original.byteLength; i++) if (original[i] !== rebased[i]) diffs++;
  if (diffs === 0 || diffs > 4) throw new Error(`expected 1-4 differing bytes, got ${diffs}`);
  const reparsed = analyzeLoopSpan([rebased]);
  assertEq(reparsed, 500n, 'span invariant under rebase (single 500-tick chunk)');
  // And the BMD itself moved 500 → 1500:
  let bmdSeen = -1;
  for (let i = 0; i + 16 <= rebased.byteLength; i++) {
    if (rebased[i + 4] === 0x74 && rebased[i + 5] === 0x66 && rebased[i + 6] === 0x64 && rebased[i + 7] === 0x74) {
      bmdSeen = new DataView(rebased.buffer, rebased.byteOffset + i + 12, 4).getUint32(0);
    }
  }
  assertEq(bmdSeen, 1500, 'rebased BMD');
});

check('rebase v1 (64-bit) tfdt', () => {
  const original = seg({ tfdt: tfdt64(1_000_000n), defaultDur: 100, trun: trun(5) });
  const rebased = rebaseTfdtCopy(original, 5_000_000n);
  assertEq(analyzeLoopSpan([rebased]), 500n, 'span invariant');
  // BMD moved 1,000,000 → 6,000,000 (64-bit read at tfdt payload):
  let bmd = -1n;
  for (let i = 0; i + 20 <= rebased.byteLength; i++) {
    if (rebased[i + 4] === 0x74 && rebased[i + 5] === 0x66 && rebased[i + 6] === 0x64 && rebased[i + 7] === 0x74 && rebased[i + 8] === 1) {
      bmd = new DataView(rebased.buffer, rebased.byteOffset + i + 12, 8).getBigUint64(0);
    }
  }
  assertEq(bmd, 6_000_000n, 'rebased 64-bit BMD');
});

check('multi-traf moof: every traf tfdt is rebased', () => {
  const traf2 = box('traf', cat(tfhd(2, 50), tfdt32(500), trun(4)));
  const original = seg({ tfdt: tfdt32(500), defaultDur: 100, trun: trun(5), extraTraf: traf2 });
  const rebased = rebaseTfdtCopy(original, 250n);
  // Both tfdts moved: locate them by scanning for the fullBox pattern.
  let found = 0;
  for (let i = 0; i + 16 <= rebased.byteLength; i++) {
    if (rebased[i + 4] === 0x74 && rebased[i + 5] === 0x66 && rebased[i + 6] === 0x64 && rebased[i + 7] === 0x74) {
      const bmd = new DataView(rebased.buffer, rebased.byteOffset + i + 12, 4).getUint32(0);
      assertEq(bmd, 750, `traf ${found} bmd`);
      found++;
    }
  }
  assertEq(found, 2, 'tfdt count');
});

check('v0 overflow throws loudly', () => {
  const original = seg({ tfdt: tfdt32(0xffff_ff00), defaultDur: 100, trun: trun(1) });
  let threw = false;
  try { rebaseTfdtCopy(original, 0x1_0000_0000n); } catch { threw = true; }
  assertEq(threw, true, 'threw');
});

check('non-CMAF payload (no moof) → analyzeLoopSpan returns null, rebase throws', () => {
  const locChunk = te.encode('loc-frame-payload-not-mp4');
  assertEq(analyzeLoopSpan([locChunk]), null, 'analyze null');
  let threw = false;
  try { rebaseTfdtCopy(locChunk, 100n); } catch { threw = true; }
  assertEq(threw, true, 'rebase threw');
});

if (failures > 0) { console.error(`[rebase-test] FAIL (${failures})`); process.exit(1); }
console.log('[rebase-test] PASS');
