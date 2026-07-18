/**
 * CMAF loop rebasing — continuous media timeline across `--loop` iterations.
 *
 * A looped fixture re-sends the same moof+mdat bytes, so every iteration
 * replays the same `tfdt` baseMediaDecodeTime values. MSE players keep a
 * decode-time timeline: the replayed segments overlap the already-buffered
 * range and are (correctly) dropped, wedging playback at the loop seam.
 *
 * Fix: per loop iteration N, rewrite each fragment's tfdt to
 * `original + N × loopSpan`, where loopSpan is the fixture's total timeline
 * length in the track's timescale — the loop then presents as one endless,
 * continuous stream (what a real live encoder would produce).
 *
 * Toy limitations (documented, loud):
 * - tfdt version 0 (32-bit) overflows after ~2^32 ticks; rebasing throws
 *   rather than wrapping (regenerate fixtures with v1 tfdt for multi-day
 *   loops — the fixture generator already emits v1 for new fixtures).
 * - Duration comes from trun per-sample durations or the tfhd default;
 *   fragments relying on trex-only defaults are rejected by analyze (the
 *   fixture validator enforces self-contained fragments).
 *
 * @module
 */

/** Big-endian u32 at `off`. */
const u32At = (b: Uint8Array, off: number): number =>
  new DataView(b.buffer, b.byteOffset + off, 4).getUint32(0);

interface BoxRange { type: string; start: number; bodyStart: number; end: number }

/** Iterate top-level (or child) boxes of `bytes` within [start, end). */
function* boxes(bytes: Uint8Array, start: number, end: number): Generator<BoxRange> {
  let off = start;
  while (off + 8 <= end) {
    let size = u32At(bytes, off);
    const type = String.fromCharCode(bytes[off + 4]!, bytes[off + 5]!, bytes[off + 6]!, bytes[off + 7]!);
    let bodyStart = off + 8;
    if (size === 1) {
      const big = new DataView(bytes.buffer, bytes.byteOffset + off + 8, 8).getBigUint64(0);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return;
      size = Number(big);
      bodyStart = off + 16;
    }
    if (size < 8 || off + size > end) return; // truncated/malformed — stop
    yield { type, start: off, bodyStart, end: off + size };
    off += size;
  }
}

interface FragmentTiming {
  /** Earliest tfdt BMD across the fragment's trafs. */
  bmd: bigint;
  /** Longest traf duration (ticks) — for a single-track fragment, THE duration. */
  durationTicks: bigint;
}

/** Per-traf: tfdt offset/version + duration from trun/tfhd. */
function parseTraf(bytes: Uint8Array, traf: BoxRange): {
  tfdtPayloadOff: number; tfdtVersion: number; bmd: bigint; durationTicks: bigint;
} | null {
  let tfdtPayloadOff = -1; let tfdtVersion = 0; let bmd = 0n;
  let defaultDur: number | undefined;
  let durationTicks = 0n;

  for (const child of boxes(bytes, traf.bodyStart, traf.end)) {
    if (child.type === 'tfhd') {
      const flags = u32At(bytes, child.bodyStart) & 0xffffff;
      // body: version/flags(4) trackId(4) [baseDataOffset(8)] [sampleDescIdx(4)]
      //       [defaultSampleDuration(4)] ...
      let off = child.bodyStart + 8;
      if (flags & 0x000001) off += 8; // base-data-offset
      if (flags & 0x000002) off += 4; // sample-description-index
      if (flags & 0x000008) { defaultDur = u32At(bytes, off); }
    } else if (child.type === 'tfdt') {
      tfdtVersion = bytes[child.bodyStart]!;
      tfdtPayloadOff = child.bodyStart + 4;
      bmd = tfdtVersion === 1
        ? new DataView(bytes.buffer, bytes.byteOffset + tfdtPayloadOff, 8).getBigUint64(0)
        : BigInt(u32At(bytes, tfdtPayloadOff));
    } else if (child.type === 'trun') {
      const flags = u32At(bytes, child.bodyStart) & 0xffffff;
      const sampleCount = u32At(bytes, child.bodyStart + 4);
      let off = child.bodyStart + 8;
      if (flags & 0x000001) off += 4; // data-offset
      if (flags & 0x000004) off += 4; // first-sample-flags
      const perSampleDur = (flags & 0x000100) !== 0;
      if (perSampleDur) {
        let entrySize = 4; // duration
        if (flags & 0x000200) entrySize += 4; // size
        if (flags & 0x000400) entrySize += 4; // flags
        if (flags & 0x000800) entrySize += 4; // cts offset
        for (let i = 0; i < sampleCount; i++) {
          durationTicks += BigInt(u32At(bytes, off + i * entrySize));
        }
      } else if (defaultDur !== undefined) {
        durationTicks += BigInt(sampleCount) * BigInt(defaultDur);
      } else {
        return null; // trex-only defaults — not self-contained
      }
    }
  }
  if (tfdtPayloadOff < 0) return null;
  return { tfdtPayloadOff, tfdtVersion, bmd, durationTicks };
}

/** Timing of one moof+mdat fragment, or null when it isn't parseable CMAF. */
function fragmentTiming(chunk: Uint8Array): FragmentTiming | null {
  for (const top of boxes(chunk, 0, chunk.byteLength)) {
    if (top.type !== 'moof') continue;
    let bmd: bigint | null = null;
    let durationTicks = 0n;
    for (const child of boxes(chunk, top.bodyStart, top.end)) {
      if (child.type !== 'traf') continue;
      const t = parseTraf(chunk, child);
      if (!t) return null;
      bmd = bmd === null ? t.bmd : (t.bmd < bmd ? t.bmd : bmd);
      if (t.durationTicks > durationTicks) durationTicks = t.durationTicks;
    }
    if (bmd === null) return null;
    return { bmd, durationTicks };
  }
  return null;
}

/**
 * The loop span (ticks in the track's timescale) of a chunk sequence:
 * `(lastBmd + lastDuration) − firstBmd`. Returns null when the chunks are
 * not parseable CMAF fragments (e.g. the synthetic fixture's fake bytes) —
 * callers then skip rebasing.
 */
export function analyzeLoopSpan(chunks: readonly Uint8Array[]): bigint | null {
  if (chunks.length === 0) return null;
  const first = fragmentTiming(chunks[0]!);
  const last = fragmentTiming(chunks[chunks.length - 1]!);
  if (!first || !last) return null;
  return last.bmd + last.durationTicks - first.bmd;
}

/**
 * Copy `chunk` with every traf's tfdt baseMediaDecodeTime advanced by
 * `deltaTicks`. The input is never mutated (loop iterations all rebase from
 * the ORIGINAL bytes, so offsets never compound).
 *
 * @throws {Error} when the chunk has no parseable moof/tfdt, or when a
 *   version-0 (32-bit) tfdt would overflow.
 */
export function rebaseTfdtCopy(chunk: Uint8Array, deltaTicks: bigint): Uint8Array {
  const out = chunk.slice();
  let patched = 0;
  for (const top of boxes(out, 0, out.byteLength)) {
    if (top.type !== 'moof') continue;
    for (const child of boxes(out, top.bodyStart, top.end)) {
      if (child.type !== 'traf') continue;
      const t = parseTraf(out, child);
      if (!t) throw new Error('rebaseTfdtCopy: traf without parseable tfdt/durations');
      const newBmd = t.bmd + deltaTicks;
      const dv = new DataView(out.buffer, out.byteOffset);
      if (t.tfdtVersion === 1) {
        dv.setBigUint64(t.tfdtPayloadOff, newBmd);
      } else {
        if (newBmd > 0xffff_ffffn) {
          throw new Error(
            `rebaseTfdtCopy: version-0 tfdt overflow (${newBmd} > u32) — regenerate the fixture with 64-bit tfdt for long loops`,
          );
        }
        dv.setUint32(t.tfdtPayloadOff, Number(newBmd));
      }
      patched++;
    }
  }
  if (patched === 0) throw new Error('rebaseTfdtCopy: no moof/traf/tfdt found — not a CMAF fragment');
  return out;
}
