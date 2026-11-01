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
 * - A rebased decode time must fit the tfdt version's unsigned field: 2^32
 *   for version 0, 2^64 for version 1. Rebasing throws rather than wrapping
 *   at EITHER width — `setBigUint64` wraps modulo 2^64 silently, which would
 *   publish an overflowed origin as a plausible small timestamp. Regenerate
 *   fixtures with v1 tfdt for multi-day loops; the fixture generator already
 *   emits v1 for new fixtures.
 * - Duration comes from trun per-sample durations or the tfhd default;
 *   fragments relying on trex-only defaults are rejected by analyze (the
 *   fixture validator enforces self-contained fragments).
 *
 * @module
 */
import { parseLocmafTrackContext, parseCmafChunk } from '@openmoq/locmaf';

/** Largest value a version-0 (32-bit) tfdt can carry. */
const U32_MAX = 0xffff_ffffn;
/** Largest value a version-1 (64-bit) tfdt can carry. */
const U64_MAX = 0xffff_ffff_ffff_ffffn;

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
 * Absolute `tfdt` baseMediaDecodeTime of the FIRST fragment, in the track's
 * timescale, or null when the chunks are not parseable CMAF.
 *
 * `analyzeCmafTimeline` reports offsets RELATIVE to the first fragment, which
 * is what pacing needs and exactly what hides a nonzero media origin. This
 * reports the absolute value, so a run can record the decode time a subscriber
 * actually receives first rather than inferring it from a group number.
 */
export function firstFragmentBmd(chunks: readonly Uint8Array[]): bigint | null {
  if (chunks.length === 0) return null;
  return fragmentTiming(chunks[0]!)?.bmd ?? null;
}

export interface CmafTimeline {
  readonly timescale: number;
  readonly offsetsMs: readonly number[];
  readonly durationsMs: readonly number[];
  readonly durationMs: number;
}

/** Decode-time pacing for a single-track fixture, including its final chunk. */
export function analyzeCmafTimeline(init: Uint8Array, chunks: readonly Uint8Array[]): CmafTimeline | null {
  try {
    const context = parseLocmafTrackContext(init);
    const { timescale } = context;
    if (timescale <= 0 || chunks.length === 0) return null;
    const timings = chunks.map((chunk) => {
      // Pacing must reject every fragment that the subsequent loop cannot rebase.
      rebaseTfdtCopy(chunk, 0n);
      const parsed = parseCmafChunk(chunk, context);
      if (!parsed.fits) return null;
      return { bmd: parsed.effective.baseMediaDecodeTime,
        durationTicks: parsed.effective.durations.reduce((sum, duration) => sum + BigInt(duration), 0n) };
    });
    if (timings.some((t) => !t || t.durationTicks <= 0n)) return null;
    const first = timings[0]!;
    const last = timings.at(-1)!;
    if (!first || !last) return null;
    for (let i = 1; i < timings.length; i++) {
      if (timings[i]!.bmd < timings[i - 1]!.bmd + timings[i - 1]!.durationTicks) return null;
    }
    const ms = (ticks: bigint) => Number(ticks) / timescale * 1000;
    const span = last.bmd + last.durationTicks - first.bmd;
    if (span > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return { timescale, offsetsMs: timings.map((t) => ms(t!.bmd - first.bmd)),
      durationsMs: timings.map((t) => ms(t!.durationTicks)), durationMs: ms(span) };
  } catch { return null; }
}

/**
 * Copy `chunk` with every traf's tfdt baseMediaDecodeTime advanced by
 * `deltaTicks`. The input is never mutated (loop iterations all rebase from
 * the ORIGINAL bytes, so offsets never compound).
 *
 * @throws {Error} when the chunk has no parseable moof/tfdt, or when the
 *   resulting decode time does not fit the tfdt version's unsigned field.
 *   Both widths are checked: `DataView.setBigUint64` wraps modulo 2^64 rather
 *   than refusing, so an out-of-range 64-bit value would otherwise be
 *   published as a plausible small timestamp. A NEGATIVE delta is fine as
 *   long as the resulting decode time is still representable.
 */
export function rebaseTfdtCopy(chunk: Uint8Array, deltaTicks: bigint): Uint8Array {
  const out = new Uint8Array(chunk);
  let patched = 0;
  for (const top of boxes(out, 0, out.byteLength)) {
    if (top.type !== 'moof') continue;
    for (const child of boxes(out, top.bodyStart, top.end)) {
      if (child.type !== 'traf') continue;
      const t = parseTraf(out, child);
      if (!t) throw new Error('rebaseTfdtCopy: traf without parseable tfdt/durations');
      const newBmd = t.bmd + deltaTicks;
      const limit = t.tfdtVersion === 1 ? U64_MAX : U32_MAX;
      if (newBmd < 0n || newBmd > limit) {
        throw new Error(
          `rebaseTfdtCopy: version-${t.tfdtVersion} tfdt out of range `
          + `(${newBmd} outside 0..${limit})`
          + (t.tfdtVersion === 0 && newBmd > limit
            ? ' — regenerate the fixture with 64-bit tfdt for long loops' : ''),
        );
      }
      const dv = new DataView(out.buffer, out.byteOffset);
      if (t.tfdtVersion === 1) {
        dv.setBigUint64(t.tfdtPayloadOff, newBmd);
      } else {
        dv.setUint32(t.tfdtPayloadOff, Number(newBmd));
      }
      patched++;
    }
  }
  if (patched === 0) throw new Error('rebaseTfdtCopy: no moof/traf/tfdt found — not a CMAF fragment');
  return out;
}
