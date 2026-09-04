/**
 * Tests for CmafAssembler.
 *
 * Verifies moof+mdat pairing, tfdt patching, orphan handling,
 * and interleaved audio/video assembly.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest';
import { CmafAssembler } from './cmaf-assembler.js';
import {
  readU32, writeU32, boxType,
  findTfdtOffset, readBaseMediaDecodeTime, patchBaseMediaDecodeTime,
  readSegmentTimeRanges,
} from './mp4-box.js';

// ─── Test helpers ─────────────────────────────────────────────────────

/** Build a minimal moof box with tfdt carrying the given baseMediaDecodeTime. */
function buildMoof(baseMediaDecodeTime: number, sequenceNumber = 1, sampleDuration?: number): Uint8Array {
  // mfhd: size(4) + type(4) + version+flags(4) + sequence_number(4) = 16 bytes
  const mfhd = new Uint8Array(16);
  writeU32(mfhd, 0, 16);
  mfhd[4] = 0x6d; mfhd[5] = 0x66; mfhd[6] = 0x68; mfhd[7] = 0x64; // 'mfhd'
  writeU32(mfhd, 12, sequenceNumber);

  // tfhd: size(4) + type(4) + version+flags(4) + track_id(4) = 16 bytes
  const tfhd = new Uint8Array(sampleDuration === undefined ? 16 : 20);
  writeU32(tfhd, 0, tfhd.byteLength);
  tfhd[4] = 0x74; tfhd[5] = 0x66; tfhd[6] = 0x68; tfhd[7] = 0x64; // 'tfhd'
  if (sampleDuration !== undefined) {
    tfhd[11] = 0x08; // default_sample_duration_present
    writeU32(tfhd, 16, sampleDuration);
  }
  writeU32(tfhd, 12, 1); // track_id = 1

  // tfdt version 0: size(4) + type(4) + version+flags(4) + baseMediaDecodeTime(4) = 16 bytes
  const tfdt = new Uint8Array(16);
  writeU32(tfdt, 0, 16);
  tfdt[4] = 0x74; tfdt[5] = 0x66; tfdt[6] = 0x64; tfdt[7] = 0x74; // 'tfdt'
  tfdt[8] = 0; // version 0
  writeU32(tfdt, 12, baseMediaDecodeTime);

  // trun: size(4) + type(4) + version+flags(4) + sample_count(4) = 16 bytes
  const trun = new Uint8Array(16);
  writeU32(trun, 0, 16);
  trun[4] = 0x74; trun[5] = 0x72; trun[6] = 0x75; trun[7] = 0x6e; // 'trun'
  writeU32(trun, 12, 1); // 1 sample

  // traf = tfhd + tfdt + trun
  const trafContent = new Uint8Array(tfhd.byteLength + tfdt.byteLength + trun.byteLength);
  trafContent.set(tfhd, 0);
  trafContent.set(tfdt, tfhd.byteLength);
  trafContent.set(trun, tfhd.byteLength + tfdt.byteLength);
  const traf = new Uint8Array(8 + trafContent.byteLength);
  writeU32(traf, 0, 8 + trafContent.byteLength);
  traf[4] = 0x74; traf[5] = 0x72; traf[6] = 0x61; traf[7] = 0x66; // 'traf'
  traf.set(trafContent, 8);

  // moof = mfhd + traf
  const moofContent = new Uint8Array(mfhd.byteLength + traf.byteLength);
  moofContent.set(mfhd, 0);
  moofContent.set(traf, mfhd.byteLength);
  const moof = new Uint8Array(8 + moofContent.byteLength);
  writeU32(moof, 0, 8 + moofContent.byteLength);
  moof[4] = 0x6d; moof[5] = 0x6f; moof[6] = 0x6f; moof[7] = 0x66; // 'moof'
  moof.set(moofContent, 8);

  return moof;
}

/** Build an arbitrary MP4 box with the given 4-char type and body. */
function buildBox(type: string, body: Uint8Array): Uint8Array {
  const box = new Uint8Array(8 + body.byteLength);
  writeU32(box, 0, 8 + body.byteLength);
  box[4] = type.charCodeAt(0); box[5] = type.charCodeAt(1);
  box[6] = type.charCodeAt(2); box[7] = type.charCodeAt(3);
  box.set(body, 8);
  return box;
}

/** Concatenate multiple Uint8Arrays. */
function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.byteLength, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) { out.set(a, pos); pos += a.byteLength; }
  return out;
}

/** Build a minimal mdat box with the given payload. */
function buildMdat(payload: Uint8Array): Uint8Array {
  const mdat = new Uint8Array(8 + payload.byteLength);
  writeU32(mdat, 0, 8 + payload.byteLength);
  mdat[4] = 0x6d; mdat[5] = 0x64; mdat[6] = 0x61; mdat[7] = 0x74; // 'mdat'
  mdat.set(payload, 8);
  return mdat;
}

/** Build a version 1 (64-bit) tfdt moof. */
function buildMoofV1(baseMediaDecodeTime: bigint, sequenceNumber = 1): Uint8Array {
  const mfhd = new Uint8Array(16);
  writeU32(mfhd, 0, 16);
  mfhd[4] = 0x6d; mfhd[5] = 0x66; mfhd[6] = 0x68; mfhd[7] = 0x64;
  writeU32(mfhd, 12, sequenceNumber);

  const tfhd = new Uint8Array(16);
  writeU32(tfhd, 0, 16);
  tfhd[4] = 0x74; tfhd[5] = 0x66; tfhd[6] = 0x68; tfhd[7] = 0x64;
  writeU32(tfhd, 12, 1);

  // tfdt version 1: size(4) + type(4) + version+flags(4) + baseMediaDecodeTime(8) = 20 bytes
  const tfdt = new Uint8Array(20);
  writeU32(tfdt, 0, 20);
  tfdt[4] = 0x74; tfdt[5] = 0x66; tfdt[6] = 0x64; tfdt[7] = 0x74;
  tfdt[8] = 1; // version 1
  const view = new DataView(tfdt.buffer);
  view.setBigUint64(12, baseMediaDecodeTime);

  const trun = new Uint8Array(16);
  writeU32(trun, 0, 16);
  trun[4] = 0x74; trun[5] = 0x72; trun[6] = 0x75; trun[7] = 0x6e;
  writeU32(trun, 12, 1);

  const trafContent = new Uint8Array(tfhd.byteLength + tfdt.byteLength + trun.byteLength);
  trafContent.set(tfhd, 0);
  trafContent.set(tfdt, tfhd.byteLength);
  trafContent.set(trun, tfhd.byteLength + tfdt.byteLength);
  const traf = new Uint8Array(8 + trafContent.byteLength);
  writeU32(traf, 0, 8 + trafContent.byteLength);
  traf[4] = 0x74; traf[5] = 0x72; traf[6] = 0x61; traf[7] = 0x66;
  traf.set(trafContent, 8);

  const moofContent = new Uint8Array(mfhd.byteLength + traf.byteLength);
  moofContent.set(mfhd, 0);
  moofContent.set(traf, mfhd.byteLength);
  const moof = new Uint8Array(8 + moofContent.byteLength);
  writeU32(moof, 0, 8 + moofContent.byteLength);
  moof[4] = 0x6d; moof[5] = 0x6f; moof[6] = 0x6f; moof[7] = 0x66;
  moof.set(moofContent, 8);

  return moof;
}

// ─── mp4-box helper tests ─────────────────────────────────────────────

describe('mp4-box tfdt helpers', () => {
  it('findTfdtOffset returns correct offset for version 0', () => {
    const moof = buildMoof(90000);
    const result = findTfdtOffset(moof);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(0);
    expect(boxType(moof, result!.offset)).toBe('tfdt');
  });

  it('findTfdtOffset returns correct offset for version 1', () => {
    const moof = buildMoofV1(90000n);
    const result = findTfdtOffset(moof);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
  });

  it('findTfdtOffset returns null for non-moof data', () => {
    const mdat = buildMdat(new Uint8Array([1, 2, 3]));
    expect(findTfdtOffset(mdat)).toBeNull();
  });

  it('readBaseMediaDecodeTime parses version 0 (uint32)', () => {
    const moof = buildMoof(123456);
    expect(readBaseMediaDecodeTime(moof)).toBe(123456n);
  });

  it('readBaseMediaDecodeTime parses version 1 (uint64)', () => {
    const moof = buildMoofV1(9876543210n);
    expect(readBaseMediaDecodeTime(moof)).toBe(9876543210n);
  });

  it('patchBaseMediaDecodeTime modifies in-place without allocation', () => {
    const moof = buildMoof(90000);
    expect(readBaseMediaDecodeTime(moof)).toBe(90000n);

    patchBaseMediaDecodeTime(moof, 0n);
    expect(readBaseMediaDecodeTime(moof)).toBe(0n);
  });

  it('patchBaseMediaDecodeTime works for version 1 (uint64)', () => {
    const moof = buildMoofV1(9876543210n);
    patchBaseMediaDecodeTime(moof, 1000n);
    expect(readBaseMediaDecodeTime(moof)).toBe(1000n);
  });

  it('rejects values that do not fit the tfdt version', () => {
    expect(() => patchBaseMediaDecodeTime(buildMoof(0), -1n)).toThrow(RangeError);
    expect(() => patchBaseMediaDecodeTime(buildMoof(0), 0x1_0000_0000n)).toThrow(RangeError);
    expect(() => patchBaseMediaDecodeTime(buildMoofV1(0n), -1n)).toThrow(RangeError);
    expect(() => patchBaseMediaDecodeTime(buildMoofV1(0n), 0x1_0000_0000_0000_0000n)).toThrow(RangeError);
  });
});

// ─── CmafAssembler tests ───────────────────────────────────────

describe('CmafAssembler', () => {
  it('pairs moof+mdat into single segment', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });

    const moof = buildMoof(90000);
    const mdat = buildMdat(new Uint8Array([0xCA, 0xFE]));

    assembler.push('video', 't1', 1n, moof);
    expect(onSegment).not.toHaveBeenCalled(); // moof buffered, not emitted

    assembler.push('video', 't1', 1n, mdat);
    expect(onSegment).toHaveBeenCalledTimes(1);

    const [mediaType, segment] = onSegment.mock.calls[0]!;
    expect(mediaType).toBe('video');
    expect(segment.byteLength).toBe(moof.byteLength + mdat.byteLength);
    expect(boxType(segment, 0)).toBe('moof'); // starts with moof
  });

  it('drops orphaned mdat without preceding moof', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });

    const mdat = buildMdat(new Uint8Array([0xCA, 0xFE]));
    assembler.push('video', 't1', 1n, mdat);

    expect(onSegment).not.toHaveBeenCalled();
  });

  it('clearPending drops half-pairs for one media type only (liveness restart)', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });

    // A delivery restart can strand a moof whose mdat never arrived.
    assembler.push('video', 't1', 5n, buildMoof(90000));
    assembler.push('audio', 't1', 5n, buildMoof(48000));

    assembler.clearPending('video');

    // The stale video moof must NOT pair with a post-restart mdat…
    assembler.push('video', 't1', 5n, buildMdat(new Uint8Array([0xCA])));
    expect(onSegment).not.toHaveBeenCalled();

    // …while the audio half-pair (untouched media type) still completes,
    // and the audio epoch was not reset.
    assembler.push('audio', 't1', 5n, buildMdat(new Uint8Array([0xAA])));
    expect(onSegment).toHaveBeenCalledTimes(1);
    expect(onSegment.mock.calls[0]![0]).toBe('audio');
    expect(assembler.getEpoch('audio')).toBe(48000n);
  });

  it('handles interleaved audio and video', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });

    const videoMoof = buildMoof(90000, 1);
    const audioMoof = buildMoof(48000, 1);
    const audioMdat = buildMdat(new Uint8Array([0xAA]));
    const videoMdat = buildMdat(new Uint8Array([0xBB]));

    assembler.push('video', 't1', 1n, videoMoof);
    assembler.push('audio', 't1', 1n, audioMoof);
    assembler.push('audio', 't1', 1n, audioMdat); // audio pair completes first
    assembler.push('video', 't1', 1n, videoMdat); // video pair completes second

    expect(onSegment).toHaveBeenCalledTimes(2);
    expect(onSegment.mock.calls[0]![0]).toBe('audio');
    expect(onSegment.mock.calls[1]![0]).toBe('video');
  });

  it('patches tfdt baseMediaDecodeTime to zero-based', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });

    const moof = buildMoof(500000); // large BMD
    const mdat = buildMdat(new Uint8Array([0x01]));

    assembler.push('video', 't1', 1n, moof);
    assembler.push('video', 't1', 1n, mdat);

    const segment: Uint8Array = onSegment.mock.calls[0]![1];
    // The moof portion should have BMD patched to 0 (first frame = epoch)
    const patchedBMD = readBaseMediaDecodeTime(segment);
    expect(patchedBMD).toBe(0n);
  });

  it('records epoch from first moof per media type', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });

    // First video frame: BMD = 500000 → epoch = 500000, patched to 0
    assembler.push('video', 't1', 1n, buildMoof(500000, 1));
    assembler.push('video', 't1', 1n, buildMdat(new Uint8Array([0x01])));

    // Second video frame: BMD = 503000 → patched to 3000
    assembler.push('video', 't1', 1n, buildMoof(503000, 2));
    assembler.push('video', 't1', 1n, buildMdat(new Uint8Array([0x02])));

    const seg1: Uint8Array = onSegment.mock.calls[0]![1];
    const seg2: Uint8Array = onSegment.mock.calls[1]![1];

    expect(readBaseMediaDecodeTime(seg1)).toBe(0n);
    expect(readBaseMediaDecodeTime(seg2)).toBe(3000n);

    // Audio has separate epoch
    assembler.push('audio', 't1', 1n, buildMoof(100000, 1));
    assembler.push('audio', 't1', 1n, buildMdat(new Uint8Array([0xA1])));

    const seg3: Uint8Array = onSegment.mock.calls[2]![1];
    expect(readBaseMediaDecodeTime(seg3)).toBe(0n); // audio epoch = 100000
  });

  it('exposes epoch per media type', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });

    assembler.push('video', 't1', 1n, buildMoof(500000));
    assembler.push('video', 't1', 1n, buildMdat(new Uint8Array([0x01])));

    expect(assembler.getEpoch('video')).toBe(500000n);
    expect(assembler.getEpoch('audio')).toBeNull();
  });

  it('reset clears pending moofs and epoch', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });

    assembler.push('video', 't1', 1n, buildMoof(500000));
    assembler.reset();

    // mdat after reset should be dropped (no pending moof)
    assembler.push('video', 't1', 1n, buildMdat(new Uint8Array([0x01])));
    expect(onSegment).not.toHaveBeenCalled();

    // Epoch should be cleared — next moof establishes new epoch
    expect(assembler.getEpoch('video')).toBeNull();
  });

  // ─── CMSF §3.3: combined moof+mdat in a single object ──────────────

  it('handles combined moof+mdat in a single object (CMSF §3.3)', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });

    const moof = buildMoof(90000);
    const mdat = buildMdat(new Uint8Array([0xCA, 0xFE]));

    // Combine moof+mdat into a single payload (spec-compliant per CMSF §3.3)
    const combined = new Uint8Array(moof.byteLength + mdat.byteLength);
    combined.set(moof, 0);
    combined.set(mdat, moof.byteLength);

    assembler.push('video', 't1', 1n, combined);

    // Should emit immediately — no buffering needed
    expect(onSegment).toHaveBeenCalledTimes(1);
    const [mediaType, segment] = onSegment.mock.calls[0]!;
    expect(mediaType).toBe('video');
    expect(segment.byteLength).toBe(combined.byteLength);
    expect(boxType(segment, 0)).toBe('moof');
  });

  it('patches tfdt in combined moof+mdat objects', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });

    const moof1 = buildMoof(500000);
    const mdat1 = buildMdat(new Uint8Array([0x01]));
    const combined1 = new Uint8Array(moof1.byteLength + mdat1.byteLength);
    combined1.set(moof1, 0);
    combined1.set(mdat1, moof1.byteLength);

    assembler.push('video', 't1', 1n, combined1);

    // First frame: epoch established, BMD patched to 0
    const seg1: Uint8Array = onSegment.mock.calls[0]![1];
    expect(readBaseMediaDecodeTime(seg1)).toBe(0n);
    expect(assembler.getEpoch('video')).toBe(500000n);

    // Second frame: BMD = 503000 → patched to 3000
    const moof2 = buildMoof(503000, 2);
    const mdat2 = buildMdat(new Uint8Array([0x02]));
    const combined2 = new Uint8Array(moof2.byteLength + mdat2.byteLength);
    combined2.set(moof2, 0);
    combined2.set(mdat2, moof2.byteLength);

    assembler.push('video', 't1', 2n, combined2);

    const seg2: Uint8Array = onSegment.mock.calls[1]![1];
    expect(readBaseMediaDecodeTime(seg2)).toBe(3000n);
  });

  it('does not buffer combined moof+mdat (no pending moof leak)', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });

    const moof = buildMoof(90000);
    const mdat = buildMdat(new Uint8Array([0x01]));
    const combined = new Uint8Array(moof.byteLength + mdat.byteLength);
    combined.set(moof, 0);
    combined.set(mdat, moof.byteLength);

    assembler.push('video', 't1', 1n, combined);
    expect(onSegment).toHaveBeenCalledTimes(1);

    // A subsequent mdat for the same group should be dropped (no pending moof)
    assembler.push('video', 't1', 1n, buildMdat(new Uint8Array([0x02])));
    expect(onSegment).toHaveBeenCalledTimes(1); // still 1
  });

  // ─── CMAF prefix boxes (styp, sidx) ─────────────────────────────

  it('handles styp+moof+mdat — skips styp, patches tfdt, preserves full segment', () => {
    /**
     * CMAF segments from some publishers (e.g., Wowza) include a styp
     * (Segment Type) box before the moof. The assembler must skip past
     * it to find the moof for tfdt patching, but preserve the styp in
     * the emitted segment.
     * @see ISO/IEC 14496-12 §8.16.2 (Segment Type Box)
     */
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });

    const styp = buildBox('styp', new Uint8Array([0x63, 0x6d, 0x66, 0x63, 0, 0, 0, 0])); // cmfc brand
    const moof = buildMoof(90000);
    const mdat = buildMdat(new Uint8Array([0xCA, 0xFE]));

    const combined = concat(styp, moof, mdat);
    assembler.push('video', 't1', 1n, combined);

    expect(onSegment).toHaveBeenCalledOnce();
    const segment = onSegment.mock.calls[0]![1] as Uint8Array;

    // styp preserved at the front
    expect(boxType(segment, 0)).toBe('styp');
    // moof follows after styp, tfdt patched to 0 (first = epoch)
    expect(boxType(segment, styp.byteLength)).toBe('moof');
    const moofPortion = segment.subarray(styp.byteLength);
    expect(readBaseMediaDecodeTime(moofPortion)).toBe(0n);
  });

  it('handles styp+sidx+moof+mdat — skips both prefix boxes before patching', () => {
    /**
     * Wowza segments include styp + sidx (Segment Index) before the moof.
     * The assembler must skip all prefix boxes to find the moof.
     * @see ISO/IEC 14496-12 §8.16.3 (Segment Index Box)
     */
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });

    const styp = buildBox('styp', new Uint8Array([0x63, 0x6d, 0x66, 0x63, 0, 0, 0, 0]));
    const sidx = buildBox('sidx', new Uint8Array(20)); // minimal sidx body
    const moof = buildMoof(500000);
    const mdat = buildMdat(new Uint8Array([0xDE, 0xAD]));

    const combined = concat(styp, sidx, moof, mdat);
    assembler.push('video', 't1', 1n, combined);

    expect(onSegment).toHaveBeenCalledOnce();
    const segment = onSegment.mock.calls[0]![1] as Uint8Array;

    // Full prefix preserved
    expect(boxType(segment, 0)).toBe('styp');
    expect(boxType(segment, styp.byteLength)).toBe('sidx');
    // moof after both prefixes, tfdt patched to 0
    const moofStart = styp.byteLength + sidx.byteLength;
    expect(boxType(segment, moofStart)).toBe('moof');
    expect(readBaseMediaDecodeTime(segment.subarray(moofStart))).toBe(0n);
  });

  it('patches tfdt to zero-based across segments with styp+sidx prefix', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });

    const styp = buildBox('styp', new Uint8Array([0x63, 0x6d, 0x66, 0x63, 0, 0, 0, 0]));
    const sidx = buildBox('sidx', new Uint8Array(20));

    // First: epoch = 90000
    assembler.push('video', 't1', 1n, concat(styp, sidx, buildMoof(90000), buildMdat(new Uint8Array([1]))));
    // Second: 93000 → should become 3000
    assembler.push('video', 't1', 2n, concat(styp, sidx, buildMoof(93000), buildMdat(new Uint8Array([2]))));

    expect(onSegment).toHaveBeenCalledTimes(2);
    const seg2 = onSegment.mock.calls[1]![1] as Uint8Array;
    const moofStart = styp.byteLength + sidx.byteLength;
    expect(readBaseMediaDecodeTime(seg2.subarray(moofStart))).toBe(3000n);
  });
});

// ─── HEVC RASL-strip integration ─────────────────────────────────────

describe('CmafAssembler — HEVC CRA-with-RASL strip', () => {
  /** HEVC NAL unit (header byte derived from type). */
  function hevcNal(nalType: number, payloadLen = 0): Uint8Array {
    const out = new Uint8Array(2 + payloadLen);
    out[0] = (nalType & 0x3f) << 1;
    out[1] = 0x01;
    // payload stays zeros — bytes don't matter for the strip path
    return out;
  }

  /** Build a single sample's bytes from one or more length-prefixed NAL units. */
  function lpSample(...nals: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const n of nals) total += 4 + n.byteLength;
    const out = new Uint8Array(total);
    let o = 0;
    for (const n of nals) {
      writeU32(out, o, n.byteLength);
      o += 4;
      out.set(n, o);
      o += n.byteLength;
    }
    return out;
  }

  function makeBox(type: string, body: Uint8Array): Uint8Array {
    const out = new Uint8Array(8 + body.byteLength);
    writeU32(out, 0, 8 + body.byteLength);
    out[4] = type.charCodeAt(0); out[5] = type.charCodeAt(1);
    out[6] = type.charCodeAt(2); out[7] = type.charCodeAt(3);
    out.set(body, 8);
    return out;
  }

  function makeFullBox(type: string, version: number, flags: number, body: Uint8Array): Uint8Array {
    const vf = new Uint8Array(4);
    vf[0] = version & 0xff;
    vf[1] = (flags >> 16) & 0xff;
    vf[2] = (flags >> 8) & 0xff;
    vf[3] = flags & 0xff;
    return makeBox(type, concat(vf, body));
  }

  /**
   * Build a CMAF moof+mdat for a sequence of HEVC samples. tfhd
   * provides default_sample_duration; trun provides per-sample sizes.
   */
  function buildHevcFragment(samples: Uint8Array[]): Uint8Array {
    const sizes = samples.map(s => s.byteLength);
    const tfhdBody = new Uint8Array(8);
    writeU32(tfhdBody, 0, 1);
    writeU32(tfhdBody, 4, 3000);
    const tfhdBox = makeFullBox('tfhd', 0, 0x000008, tfhdBody);
    const tfdtBox = makeFullBox('tfdt', 0, 0, new Uint8Array(4));
    // trun: sample_duration (0x000100) + sample_size (0x000200) = 0x000300.
    // Per-sample durations are needed so the rewriter can extend the
    // last kept sample to absorb dropped sample time (no presentation gap).
    const sampleDuration = 3000;
    const trunBody = new Uint8Array(4 + 8 * sizes.length);
    writeU32(trunBody, 0, sizes.length);
    for (let i = 0; i < sizes.length; i++) {
      writeU32(trunBody, 4 + 8 * i, sampleDuration);
      writeU32(trunBody, 4 + 8 * i + 4, sizes[i]!);
    }
    const trunBox = makeFullBox('trun', 0, 0x000300, trunBody);
    const trafBox = makeBox('traf', concat(tfhdBox, tfdtBox, trunBox));
    const mfhdBody = new Uint8Array(4);
    writeU32(mfhdBody, 0, 1);
    const mfhdBox = makeFullBox('mfhd', 0, 0, mfhdBody);
    const moofBox = makeBox('moof', concat(mfhdBox, trafBox));
    const mdatPayload = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
    let p = 0;
    for (const s of samples) { mdatPayload.set(s, p); p += s.byteLength; }
    const mdatBox = makeBox('mdat', mdatPayload);
    return concat(moofBox, mdatBox);
  }

  // HEVC NAL types (Annex 7.4.2.2).
  const NAL_AUD = 35;
  const NAL_SEI_PREFIX = 39;
  const NAL_IDR_N_LP = 20;
  const NAL_CRA = 21;
  const NAL_TRAIL_R = 1;
  const NAL_RASL_R = 9;
  const NAL_RASL_N = 8;

  it('strips RASL samples from a CRA-led HEVC fragment (Synamedia shape)', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });

    const sample0 = lpSample(hevcNal(NAL_AUD), hevcNal(NAL_SEI_PREFIX), hevcNal(NAL_CRA, 50));
    const sample1 = lpSample(hevcNal(NAL_AUD), hevcNal(NAL_RASL_R, 40)); // dropped
    const sample2 = lpSample(hevcNal(NAL_AUD), hevcNal(NAL_RASL_N, 30)); // dropped
    const sample3 = lpSample(hevcNal(NAL_AUD), hevcNal(NAL_TRAIL_R, 20));
    const segment = buildHevcFragment([sample0, sample1, sample2, sample3]);
    const originalLen = segment.byteLength;

    assembler.push('video', 'video_hevc', 1n, segment);

    expect(onSegment).toHaveBeenCalledTimes(1);
    const out = onSegment.mock.calls[0]![1] as Uint8Array;
    // mdat shrinks by the dropped sample bytes; trun shrinks by 2
    // sample records (duration + size = 8 bytes each).
    const droppedMdatBytes = sample1.byteLength + sample2.byteLength;
    expect(out.byteLength).toBe(originalLen - droppedMdatBytes - 16);
  });

  it('leaves a CRA-only fragment without RASLs untouched', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });

    const sample0 = lpSample(hevcNal(NAL_AUD), hevcNal(NAL_CRA, 40));
    const sample1 = lpSample(hevcNal(NAL_AUD), hevcNal(NAL_TRAIL_R, 20));
    const segment = buildHevcFragment([sample0, sample1]);
    const originalLen = segment.byteLength;

    assembler.push('video', 'video_hevc', 1n, segment);

    expect(onSegment).toHaveBeenCalledTimes(1);
    const out = onSegment.mock.calls[0]![1] as Uint8Array;
    expect(out.byteLength).toBe(originalLen);
  });

  it('leaves an IDR-led HEVC fragment with RASLs untouched (sample-0 must be CRA to strip)', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });

    // Per the conservative policy: only random-access CRAs trigger
    // stripping. IDR-led fragments carry RASLs the decoder should
    // handle through normal HEVC §8.1 logic.
    const sample0 = lpSample(hevcNal(NAL_AUD), hevcNal(NAL_IDR_N_LP, 40));
    const sample1 = lpSample(hevcNal(NAL_AUD), hevcNal(NAL_RASL_R, 20));
    const segment = buildHevcFragment([sample0, sample1]);
    const originalLen = segment.byteLength;

    assembler.push('video', 'video_hevc', 1n, segment);

    expect(onSegment).toHaveBeenCalledTimes(1);
    const out = onSegment.mock.calls[0]![1] as Uint8Array;
    expect(out.byteLength).toBe(originalLen);
  });

  it('leaves AVC fragments untouched', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });

    // AVC IDR slice header byte = 0x65 (nal_ref_idc=11, type=5).
    // Interpreted as HEVC: ((0x65 >> 1) & 0x3f) = 50 — never CRA(21).
    const avcIdrHeader = 0x65;
    const avcSample = lpSample(new Uint8Array([avcIdrHeader, ...new Array(50).fill(0)]));
    const segment = buildHevcFragment([avcSample]);
    const originalLen = segment.byteLength;

    assembler.push('video', 'video_avc', 1n, segment);

    expect(onSegment).toHaveBeenCalledTimes(1);
    const out = onSegment.mock.calls[0]![1] as Uint8Array;
    expect(out.byteLength).toBe(originalLen);
  });

  /**
   * Audio fragments have no NAL unit structure, so feeding their bytes
   * through the HEVC NAL classifier is meaningless. The strip path must
   * skip them entirely — even crafted byte patterns that happen to look
   * like CRA + RASL must pass through unmodified.
   */
  it('skips audio fragments entirely (no NAL structure to parse)', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });

    // Construct sample bytes that LOOK like CRA + RASL if interpreted
    // as HEVC, but are tagged as audio (mediaType='audio').
    const sample0 = lpSample(hevcNal(NAL_AUD), hevcNal(NAL_CRA, 50));
    const sample1 = lpSample(hevcNal(NAL_AUD), hevcNal(NAL_RASL_R, 40));
    const segment = buildHevcFragment([sample0, sample1]);
    const originalLen = segment.byteLength;

    assembler.push('audio', 'audio_aac', 1n, segment);

    expect(onSegment).toHaveBeenCalledTimes(1);
    const out = onSegment.mock.calls[0]![1] as Uint8Array;
    // Audio path bypasses the strip — segment passes through verbatim.
    expect(out.byteLength).toBe(originalLen);
  });

  // ─── Trex-defaults lifecycle ────────────────────────────────────────

  /** Build a minimal init segment with one trex, optionally with mvex. */
  function buildInit(opts: { withTrex: boolean; defaultDuration?: number }): Uint8Array {
    const moovChildren: Uint8Array[] = [];
    if (opts.withTrex) {
      const trexBody = concat(
        new Uint8Array(4),                       // version+flags
        u32be(1),                                // track_ID
        u32be(1),                                // default_sample_description_index
        u32be(opts.defaultDuration ?? 3000),     // default_sample_duration
        u32be(0),                                // default_sample_size
        u32be(0),                                // default_sample_flags
      );
      const trexBox = makeBox('trex', trexBody);
      const mvexBox = makeBox('mvex', trexBox);
      moovChildren.push(mvexBox);
    }
    return makeBox('moov', concat(...moovChildren));
  }

  function u32be(n: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, n);
    return out;
  }

  it('reset() clears trex defaults parsed from a prior init', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });

    assembler.setInitSegment('video', buildInit({ withTrex: true, defaultDuration: 3000 }));
    expect((assembler as unknown as { videoTrex: unknown }).videoTrex).not.toBeNull();

    assembler.reset();
    expect((assembler as unknown as { videoTrex: unknown }).videoTrex).toBeNull();
  });

  it('setInitSegment() with a trex-less init clears any previously stored trex', () => {
    // Without this, a track switch from a stream that ships trex defaults
    // to one that doesn't would silently keep applying the prior stream's
    // sample defaults to fragments of the new stream.
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });

    assembler.setInitSegment('video', buildInit({ withTrex: true, defaultDuration: 3000 }));
    expect((assembler as unknown as { videoTrex: unknown }).videoTrex).not.toBeNull();

    assembler.setInitSegment('video', buildInit({ withTrex: false }));
    expect((assembler as unknown as { videoTrex: unknown }).videoTrex).toBeNull();
  });

  // ─── Audio reorder tolerance ────────────────────────────────────

  function combinedSeg(bmd: number): Uint8Array {
    return concat(buildMoof(bmd), buildMdat(new Uint8Array([0xAA])));
  }

  it('small backward audio bmd does NOT trigger discontinuity', () => {
    const onSegment = vi.fn();
    const onDiscontinuity = vi.fn();
    const assembler = new CmafAssembler({ onSegment, onDiscontinuity });

    // Forward audio segments
    assembler.push('audio', 'audio-0', 0n, combinedSeg(1000));
    assembler.push('audio', 'audio-0', 1n, combinedSeg(2024));
    assembler.push('audio', 'audio-0', 2n, combinedSeg(3048));

    // Small backward jump: 3 audio frames (3072 ticks at 48kHz = 64ms)
    assembler.push('audio', 'audio-0', 3n, combinedSeg(2000));

    // Should NOT have fired discontinuity
    expect(onDiscontinuity).not.toHaveBeenCalled();
    // Should still have emitted 4 segments
    expect(onSegment).toHaveBeenCalledTimes(4);
  });

  it('large backward audio bmd DOES trigger discontinuity', () => {
    const onSegment = vi.fn();
    const onDiscontinuity = vi.fn();
    const assembler = new CmafAssembler({ onSegment, onDiscontinuity });

    // Forward audio segments at high bmd
    assembler.push('audio', 'audio-0', 0n, combinedSeg(100000));
    assembler.push('audio', 'audio-0', 1n, combinedSeg(101024));

    // Large backward jump: >48000 ticks
    assembler.push('audio', 'audio-0', 2n, combinedSeg(1000));

    expect(onDiscontinuity).toHaveBeenCalledWith('audio', 'audio-0');
  });

  it('any backward video bmd triggers discontinuity', () => {
    const onSegment = vi.fn();
    const onDiscontinuity = vi.fn();
    const assembler = new CmafAssembler({ onSegment, onDiscontinuity });

    // Forward video segments
    assembler.push('video', 'video-0', 0n, combinedSeg(1000));
    assembler.push('video', 'video-0', 1n, combinedSeg(2000));

    // Even small backward jump on video triggers discontinuity
    assembler.push('video', 'video-0', 2n, combinedSeg(1500));

    expect(onDiscontinuity).toHaveBeenCalledWith('video', 'video-0');
  });
});

describe('CmafAssembler non-media payload diagnostics', () => {
  it('warns ONCE per track when dropping a payload with no moof/mdat (e.g. in-band init)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const onSegment = vi.fn();
      const assembler = new CmafAssembler({ onSegment });
      // ftyp-only payload: the shape of an in-band ftyp+moov init segment
      // reaching the assembler (the player layer should have consumed it).
      const ftyp = new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 105, 115, 111, 54, 0, 0, 0, 0]);
      assembler.push('video', 't1', 0n, ftyp);
      assembler.push('video', 't1', 1n, ftyp); // second drop: same track — no second warn
      assembler.push('audio', 't1', 0n, ftyp); // different track: warns again

      expect(onSegment).not.toHaveBeenCalled();
      const dropWarns = warn.mock.calls.filter((c) => /no moof\/mdat/i.test(String(c[0])));
      expect(dropWarns).toHaveLength(2); // video:t1 once, audio:t1 once
    } finally {
      warn.mockRestore();
    }
  });
});

// ─── Shared cross-track epoch (A/V sync — RED5DEV-2315) ──────────

/**
 * When per-track timescales are known (from init segments), the two
 * tracks must be rebased against ONE shared epoch instead of each
 * independently zero-basing at its own first fragment. Per-track
 * zero-basing erases the publisher's timeline alignment: on a
 * mid-stream join, audio delivery starts at the live edge while
 * video waits for the next group (GoP) boundary, so video's first
 * bmd is up to a full GoP ahead of audio's — zeroing both bakes
 * that gap in as a constant A/V desync.
 */
describe('CmafAssembler — shared cross-track epoch (RED5DEV-2315)', () => {
  const VIDEO_TS = 90000;
  const AUDIO_TS = 48000;

  /** mdhd v0 with the given timescale. */
  function mdhdBox(timescale: number): Uint8Array {
    const body = new Uint8Array(20); // creation+modification+timescale+duration+lang
    new DataView(body.buffer).setUint32(8, timescale);
    return makeFullBoxTop('mdhd', 0, 0, body);
  }

  /** Minimal single-track init: moov(trak(mdia(mdhd))). */
  function initWithTimescale(timescale: number): Uint8Array {
    return makeBoxTop('moov', makeBoxTop('trak', makeBoxTop('mdia', mdhdBox(timescale))));
  }

  function makeBoxTop(type: string, body: Uint8Array): Uint8Array {
    return buildBox(type, body);
  }

  function makeFullBoxTop(type: string, version: number, flags: number, body: Uint8Array): Uint8Array {
    const vf = new Uint8Array(4);
    vf[0] = version & 0xff;
    vf[1] = (flags >> 16) & 0xff;
    vf[2] = (flags >> 8) & 0xff;
    vf[3] = flags & 0xff;
    return buildBox(type, concat(vf, body));
  }

  function assemblerWithInits(onDiscontinuity?: ReturnType<typeof vi.fn>) {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment, onDiscontinuity });
    assembler.setInitSegment('video', initWithTimescale(VIDEO_TS));
    assembler.setInitSegment('audio', initWithTimescale(AUDIO_TS));
    return { assembler, onSegment };
  }

  function outBmd(onSegment: ReturnType<typeof vi.fn>, call: number): bigint {
    return readBaseMediaDecodeTime(onSegment.mock.calls[call]![1] as Uint8Array)!;
  }

  it('preserves the A/V offset when tracks start at different decode times', () => {
    const { assembler, onSegment } = assemblerWithInits();

    // Mid-stream join at t=105s: audio starts at the live edge,
    // video 0.75s later at the next GoP boundary.
    assembler.push('audio', 'audio0', 0n, concat(buildMoof(105 * AUDIO_TS), buildMdat(new Uint8Array([0xAA]))));
    assembler.push('video', 'video0', 0n, concat(buildMoof(105.75 * VIDEO_TS), buildMdat(new Uint8Array([0xBB]))));

    expect(outBmd(onSegment, 0)).toBe(0n);                          // audio anchors the epoch
    expect(outBmd(onSegment, 1)).toBe(BigInt(0.75 * VIDEO_TS));     // video keeps its real 0.75s lead
  });

  it('continues each track relative to the shared epoch on later fragments', () => {
    const { assembler, onSegment } = assemblerWithInits();

    assembler.push('audio', 'audio0', 0n, concat(buildMoof(105 * AUDIO_TS), buildMdat(new Uint8Array([1]))));
    assembler.push('video', 'video0', 0n, concat(buildMoof(105.75 * VIDEO_TS), buildMdat(new Uint8Array([2]))));
    // +2s on both tracks
    assembler.push('audio', 'audio0', 1n, concat(buildMoof(107 * AUDIO_TS, 2), buildMdat(new Uint8Array([3]))));
    assembler.push('video', 'video0', 1n, concat(buildMoof(107.75 * VIDEO_TS, 2), buildMdat(new Uint8Array([4]))));

    expect(outBmd(onSegment, 2)).toBe(BigInt(2 * AUDIO_TS));
    expect(outBmd(onSegment, 3)).toBe(BigInt(2.75 * VIDEO_TS));
  });

  it('clamps to its own bmd when the second track starts before the epoch track (no negative tfdt)', () => {
    const { assembler, onSegment } = assemblerWithInits();

    // Video fragment arrives first at t=10s, audio then arrives with
    // EARLIER content (t=9.5s). Rebasing audio against the shared
    // epoch would go negative — it must clamp to its own start.
    assembler.push('video', 'video0', 0n, concat(buildMoof(10 * VIDEO_TS), buildMdat(new Uint8Array([1]))));
    assembler.push('audio', 'audio0', 0n, concat(buildMoof(9.5 * AUDIO_TS), buildMdat(new Uint8Array([2]))));

    expect(outBmd(onSegment, 0)).toBe(0n);
    expect(outBmd(onSegment, 1)).toBe(0n); // clamped, not -0.5s
  });

  it('re-anchors BOTH tracks to one new shared epoch after a publisher restart', () => {
    const onDiscontinuity = vi.fn();
    const { assembler, onSegment } = assemblerWithInits(onDiscontinuity);

    assembler.push('audio', 'audio0', 0n, concat(buildMoof(105 * AUDIO_TS), buildMdat(new Uint8Array([1]))));
    assembler.push('video', 'video0', 0n, concat(buildMoof(105.75 * VIDEO_TS), buildMdat(new Uint8Array([2]))));

    // Publisher restart: both tracks jump backward. Audio (t=1s)
    // detects first and establishes the NEW shared epoch; video
    // (t=1.75s) must adopt it — not zero-base independently.
    assembler.push('audio', 'audio0', 1n, concat(buildMoof(1 * AUDIO_TS, 2), buildMdat(new Uint8Array([3]))));
    assembler.push('video', 'video0', 1n, concat(buildMoof(1.75 * VIDEO_TS, 2), buildMdat(new Uint8Array([4]))));

    expect(onDiscontinuity).toHaveBeenCalledWith('audio', 'audio0');
    expect(onDiscontinuity).toHaveBeenCalledWith('video', 'video0');
    expect(outBmd(onSegment, 2)).toBe(0n);                        // audio re-anchors new epoch at t=1s
    expect(outBmd(onSegment, 3)).toBe(BigInt(0.75 * VIDEO_TS));   // video keeps its 0.75s lead on the new epoch
  });

  it('keeps a looping track on one monotonic output timeline', () => {
    const onSegment = vi.fn();
    const onDiscontinuity = vi.fn();
    const assembler = new CmafAssembler({ onSegment, onDiscontinuity });

    const push = (groupId: bigint, rawBmd: number) => assembler.push(
      'video',
      'video0',
      groupId,
      concat(buildMoof(rawBmd, Number(groupId) + 1, 1_000), buildMdat(new Uint8Array([1]))),
    );

    push(0n, 10_000);
    push(1n, 11_000);
    push(2n, 12_000);
    push(3n, 10_000); // source loop: raw tfdt returns to its first value
    push(4n, 11_000);

    expect(onDiscontinuity).toHaveBeenCalledOnce();
    expect(onSegment.mock.calls.map((_, i) => outBmd(onSegment, i)))
      .toEqual([0n, 1_000n, 2_000n, 3_000n, 4_000n]);
  });

  it('ignores a retired-epoch group that arrives after the loop restart', () => {
    const onSegment = vi.fn();
    const onDiscontinuity = vi.fn();
    const assembler = new CmafAssembler({ onSegment, onDiscontinuity });
    assembler.setInitSegment('audio', initWithTimescale(AUDIO_TS));

    const push = (groupId: bigint, rawBmd: number) => assembler.push(
      'audio',
      'audio0',
      groupId,
      concat(buildMoof(rawBmd, Number(groupId), 1_024), buildMdat(new Uint8Array([1]))),
    );

    push(100n, 4_502_528);
    push(101n, 4_503_552);
    push(102n, 0);         // the loop establishes a new epoch
    push(101n, 4_504_576); // an old-epoch stream finishes late
    push(103n, 1_024);

    expect(onDiscontinuity).toHaveBeenCalledOnce();
    expect(onSegment.mock.calls.map((_, i) => outBmd(onSegment, i)))
      .toEqual([0n, 1_024n, 2_048n, 3_072n]);
  });

  it('does not mistake an older out-of-order group for a source restart', () => {
    const onSegment = vi.fn();
    const onDiscontinuity = vi.fn();
    const assembler = new CmafAssembler({ onSegment, onDiscontinuity });

    const push = (groupId: bigint, rawBmd: number) => assembler.push(
      'video',
      'video0',
      groupId,
      concat(buildMoof(rawBmd, Number(groupId), 1_000), buildMdat(new Uint8Array([1]))),
    );

    push(100n, 10_000);
    push(102n, 12_000);
    push(101n, 11_000);
    push(103n, 13_000);

    expect(onDiscontinuity).not.toHaveBeenCalled();
    expect(onSegment.mock.calls.map((_, i) => outBmd(onSegment, i)))
      .toEqual([0n, 2_000n, 1_000n, 3_000n]);
  });

  it('patches every chunk in a multi-chunk CMSF object', () => {
    const onSegment = vi.fn();
    const onDiscontinuity = vi.fn();
    const assembler = new CmafAssembler({ onSegment, onDiscontinuity });

    const object = (firstBmd: number, sequence: number) => concat(
      buildMoof(firstBmd, sequence, 1_000), buildMdat(new Uint8Array([1])),
      buildMoof(firstBmd + 1_000, sequence + 1, 1_000), buildMdat(new Uint8Array([2])),
    );

    assembler.push('video', 'video0', 100n, object(10_000, 1));
    assembler.push('video', 'video0', 101n, object(0, 3));

    const starts = onSegment.mock.calls.flatMap((call) =>
      readSegmentTimeRanges(call[1] as Uint8Array)!.map((range) => range.startTime));
    expect(onDiscontinuity).toHaveBeenCalledOnce();
    expect(starts).toEqual([0n, 1_000n, 2_000n, 3_000n]);
  });

  it('uses the latest output bmd when newer fragments cannot be duration-scored', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });

    const push = (groupId: bigint, rawBmd: number, duration?: number) => assembler.push(
      'video',
      'video0',
      groupId,
      concat(buildMoof(rawBmd, Number(groupId), duration), buildMdat(new Uint8Array([1]))),
    );

    push(100n, 10_000, 1_000);
    push(101n, 11_000);
    push(102n, 12_000);
    push(103n, 0, 1_000);

    expect(outBmd(onSegment, 3)).toBe(2_000n);
  });

  it('commits a restart before publishing the discontinuity callback', () => {
    const onSegment = vi.fn();
    let assembler!: CmafAssembler;
    const onDiscontinuity = vi.fn(() => {
      assembler.push(
        'video',
        'video0',
        103n,
        concat(buildMoof(1_000, 4, 1_000), buildMdat(new Uint8Array([4]))),
      );
    });
    assembler = new CmafAssembler({ onSegment, onDiscontinuity });

    assembler.push('video', 'video0', 100n,
      concat(buildMoof(10_000, 1, 1_000), buildMdat(new Uint8Array([1]))));
    assembler.push('video', 'video0', 101n,
      concat(buildMoof(11_000, 2, 1_000), buildMdat(new Uint8Array([2]))));
    assembler.push('video', 'video0', 102n,
      concat(buildMoof(0, 3, 1_000), buildMdat(new Uint8Array([3]))));

    expect(onDiscontinuity).toHaveBeenCalledOnce();
    expect(onSegment.mock.calls.map((_, i) => outBmd(onSegment, i)))
      .toEqual([0n, 1_000n, 2_000n, 3_000n]);
  });

  it('contains a throwing discontinuity callback', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({
      onSegment,
      onDiscontinuity: () => { throw new Error('diagnostic failed'); },
    });

    assembler.push('video', 'video0', 100n,
      concat(buildMoof(10_000, 1, 1_000), buildMdat(new Uint8Array([1]))));
    expect(() => assembler.push('video', 'video0', 101n,
      concat(buildMoof(0, 2, 1_000), buildMdat(new Uint8Array([2]))))).not.toThrow();
    expect(onSegment).toHaveBeenCalledTimes(2);
  });

  it('uses one continuation origin for both tracks across a source restart', () => {
    const onDiscontinuity = vi.fn();
    const { assembler, onSegment } = assemblerWithInits(onDiscontinuity);

    const segment = (bmd: number, duration: number, sequence: number) =>
      concat(buildMoof(bmd, sequence, duration), buildMdat(new Uint8Array([sequence])));

    assembler.push('audio', 'audio0', 0n, segment(105 * AUDIO_TS, AUDIO_TS, 1));
    assembler.push('video', 'video0', 0n, segment(105.75 * VIDEO_TS, VIDEO_TS, 1));
    assembler.push('audio', 'audio0', 1n, segment(106 * AUDIO_TS, AUDIO_TS, 2));
    assembler.push('video', 'video0', 1n, segment(106.75 * VIDEO_TS, VIDEO_TS, 2));

    assembler.push('audio', 'audio0', 2n, segment(1 * AUDIO_TS, AUDIO_TS, 3));
    assembler.push('video', 'video0', 2n, segment(1.75 * VIDEO_TS, VIDEO_TS, 3));

    expect(onDiscontinuity).toHaveBeenCalledTimes(2);
    expect(outBmd(onSegment, 4)).toBe(BigInt(2 * AUDIO_TS));
    expect(outBmd(onSegment, 5)).toBe(BigInt(2.75 * VIDEO_TS));
  });

  it('preserves the restart offset when video detects the new epoch first', () => {
    const onDiscontinuity = vi.fn();
    const { assembler, onSegment } = assemblerWithInits(onDiscontinuity);

    const segment = (bmd: number, duration: number, sequence: number) =>
      concat(buildMoof(bmd, sequence, duration), buildMdat(new Uint8Array([sequence])));

    assembler.push('audio', 'audio0', 0n, segment(105 * AUDIO_TS, AUDIO_TS, 1));
    assembler.push('video', 'video0', 0n, segment(105.75 * VIDEO_TS, VIDEO_TS, 1));
    assembler.push('audio', 'audio0', 1n, segment(106 * AUDIO_TS, AUDIO_TS, 2));
    assembler.push('video', 'video0', 1n, segment(106.75 * VIDEO_TS, VIDEO_TS, 2));

    assembler.push('video', 'video0', 2n, segment(1.75 * VIDEO_TS, VIDEO_TS, 3));
    assembler.push('audio', 'audio0', 2n, segment(1 * AUDIO_TS, AUDIO_TS, 3));

    expect(onDiscontinuity).toHaveBeenCalledTimes(2);
    expect(outBmd(onSegment, 4)).toBe(BigInt(2.75 * VIDEO_TS));
    expect(outBmd(onSegment, 5)).toBe(BigInt(2 * AUDIO_TS));
  });

  it('does not rewind the second restarted track when output horizons are asymmetric', () => {
    const onDiscontinuity = vi.fn();
    const { assembler, onSegment } = assemblerWithInits(onDiscontinuity);

    const segment = (bmd: number, duration: number, sequence: number) =>
      concat(buildMoof(bmd, sequence, duration), buildMdat(new Uint8Array([sequence])));

    assembler.push('audio', 'audio0', 100n, segment(100 * AUDIO_TS, AUDIO_TS, 1));
    assembler.push('video', 'video0', 100n, segment(100.75 * VIDEO_TS, VIDEO_TS, 1));
    assembler.push('audio', 'audio0', 101n, segment(101 * AUDIO_TS, AUDIO_TS, 2));
    assembler.push('video', 'video0', 102n, segment(102.75 * VIDEO_TS, VIDEO_TS, 2));

    assembler.push('audio', 'audio0', 103n, segment(1 * AUDIO_TS, AUDIO_TS, 3));
    assembler.push('video', 'video0', 103n, segment(1.75 * VIDEO_TS, VIDEO_TS, 3));

    expect(onDiscontinuity).toHaveBeenCalledTimes(2);
    expect(outBmd(onSegment, 4)).toBe(BigInt(2 * AUDIO_TS));
    expect(outBmd(onSegment, 5)).toBe(BigInt(3.75 * VIDEO_TS));
  });

  it('keeps cumulative output when the video track changes after a restart', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });
    assembler.setInitSegment('video', initWithTimescale(VIDEO_TS));
    const segment = (bmd: number, sequence: number) =>
      concat(buildMoof(bmd, sequence, VIDEO_TS), buildMdat(new Uint8Array([sequence])));

    assembler.push('video', 'videoA', 100n, segment(10 * VIDEO_TS, 1));
    assembler.push('video', 'videoA', 101n, segment(11 * VIDEO_TS, 2));
    assembler.push('video', 'videoA', 102n, segment(0, 3));
    assembler.selectTrack('video', 'videoB');
    assembler.push('video', 'videoB', 103n, segment(VIDEO_TS, 4));
    assembler.push('video', 'videoA', 104n, segment(2 * VIDEO_TS, 5));

    expect(onSegment.mock.calls.map((_, i) => outBmd(onSegment, i)))
      .toEqual([0n, BigInt(VIDEO_TS), BigInt(2 * VIDEO_TS), BigInt(3 * VIDEO_TS)]);
  });

  it('reset clears an explicitly selected track', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });
    const segment = concat(buildMoof(10_000, 1, 1_000), buildMdat(new Uint8Array([1])));

    assembler.selectTrack('video', 'videoB');
    assembler.push('video', 'videoA', 100n, segment);
    expect(onSegment).not.toHaveBeenCalled();

    assembler.reset();
    assembler.push('video', 'videoA', 100n, segment);
    expect(onSegment).toHaveBeenCalledOnce();
  });

  it('advances normally after a restart instead of repeatedly re-anchoring', () => {
    const onDiscontinuity = vi.fn();
    const { assembler, onSegment } = assemblerWithInits(onDiscontinuity);

    assembler.push('audio', 'audio0', 0n, concat(buildMoof(105 * AUDIO_TS), buildMdat(new Uint8Array([1]))));
    assembler.push('video', 'video0', 0n, concat(buildMoof(105.75 * VIDEO_TS), buildMdat(new Uint8Array([2]))));
    assembler.push('audio', 'audio0', 1n, concat(buildMoof(1 * AUDIO_TS, 2), buildMdat(new Uint8Array([3]))));
    assembler.push('video', 'video0', 1n, concat(buildMoof(1.75 * VIDEO_TS, 2), buildMdat(new Uint8Array([4]))));

    assembler.push('audio', 'audio0', 2n, concat(buildMoof(2 * AUDIO_TS, 3), buildMdat(new Uint8Array([5]))));
    assembler.push('video', 'video0', 2n, concat(buildMoof(2.75 * VIDEO_TS, 3), buildMdat(new Uint8Array([6]))));

    expect(onDiscontinuity).toHaveBeenCalledTimes(2);
    expect(outBmd(onSegment, 4)).toBe(BigInt(AUDIO_TS));
    expect(outBmd(onSegment, 5)).toBe(BigInt(1.75 * VIDEO_TS));
  });

  it('treats an mdhd timescale of zero as unknown instead of dividing by zero', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });
    assembler.setInitSegment('audio', initWithTimescale(0));
    assembler.setInitSegment('video', initWithTimescale(VIDEO_TS));

    expect(() => {
      assembler.push('audio', 'audio0', 0n, concat(buildMoof(1000), buildMdat(new Uint8Array([1]))));
      assembler.push('video', 'video0', 0n, concat(buildMoof(VIDEO_TS), buildMdat(new Uint8Array([2]))));
    }).not.toThrow();
    expect(outBmd(onSegment, 0)).toBe(0n);
    expect(outBmd(onSegment, 1)).toBe(0n);
  });

  it('uses the audio mdhd timescale for the one-second reorder window', () => {
    const highRateDiscontinuity = vi.fn();
    const highRate = new CmafAssembler({
      onSegment: vi.fn(),
      onDiscontinuity: highRateDiscontinuity,
    });
    highRate.setInitSegment('audio', initWithTimescale(96000));
    highRate.push('audio', 'audio0', 0n, concat(buildMoof(200000), buildMdat(new Uint8Array([1]))));
    highRate.push('audio', 'audio0', 1n, concat(buildMoof(300000), buildMdat(new Uint8Array([2]))));
    highRate.push('audio', 'audio0', 2n, concat(buildMoof(250000), buildMdat(new Uint8Array([3]))));
    expect(highRateDiscontinuity).not.toHaveBeenCalled();

    const lowRateDiscontinuity = vi.fn();
    const lowRate = new CmafAssembler({
      onSegment: vi.fn(),
      onDiscontinuity: lowRateDiscontinuity,
    });
    lowRate.setInitSegment('audio', initWithTimescale(44100));
    lowRate.push('audio', 'audio0', 0n, concat(buildMoof(100000), buildMdat(new Uint8Array([1]))));
    lowRate.push('audio', 'audio0', 1n, concat(buildMoof(150000), buildMdat(new Uint8Array([2]))));
    lowRate.push('audio', 'audio0', 2n, concat(buildMoof(104000), buildMdat(new Uint8Array([3]))));
    expect(lowRateDiscontinuity).toHaveBeenCalledTimes(1);
  });

  it('falls back to per-track zero-basing when timescales are unknown (no init segments)', () => {
    const onSegment = vi.fn();
    const assembler = new CmafAssembler({ onSegment });

    assembler.push('audio', 'audio0', 0n, concat(buildMoof(105 * AUDIO_TS), buildMdat(new Uint8Array([1]))));
    assembler.push('video', 'video0', 0n, concat(buildMoof(105.75 * VIDEO_TS), buildMdat(new Uint8Array([2]))));

    // Without timescales the gap cannot be scaled across tracks —
    // legacy behavior (each track zero-based) is preserved.
    expect(outBmd(onSegment, 0)).toBe(0n);
    expect(outBmd(onSegment, 1)).toBe(0n);
  });

  it('reset() clears the shared epoch and per-track timescales', () => {
    const { assembler, onSegment } = assemblerWithInits();

    assembler.push('audio', 'audio0', 0n, concat(buildMoof(105 * AUDIO_TS), buildMdat(new Uint8Array([1]))));
    assembler.reset();

    // After reset (and without re-sent inits) behavior reverts to
    // per-track zero-basing — no stale shared epoch leaks through.
    assembler.push('video', 'video0', 0n, concat(buildMoof(200 * VIDEO_TS), buildMdat(new Uint8Array([2]))));
    expect(outBmd(onSegment, 1)).toBe(0n);
  });
});

// ─── Diagnostic epoch-mode control ───────────────────────────────
//
// The shared cross-track epoch (production) preserves the publisher's real A/V
// offset, so a mid-stream join yields audio at 0 and video at +gap. The legacy
// per-track mode zero-bases each track independently, mapping BOTH to 0 and
// ERASING that offset — the pre-RED5DEV-2315 behavior. These pin that the two
// modes produce different startup geometry from IDENTICAL input, so the
// geometry can be isolated in one build.

describe('CmafAssembler — epoch mode is a diagnostic control, not a policy', () => {
  const VIDEO_TS = 90000;
  const AUDIO_TS = 48000;
  function mdhdBox(timescale: number): Uint8Array {
    const body = new Uint8Array(20);
    new DataView(body.buffer).setUint32(8, timescale);
    return buildBox('mdhd', concat(new Uint8Array([0, 0, 0, 0]), body));
  }
  const initWith = (ts: number) => buildBox('moov', buildBox('trak', buildBox('mdia', mdhdBox(ts))));

  /** Mid-stream join: audio at the live edge (105.00s), video at the next GoP (107.73s). */
  function joinWith(mode: 'shared' | 'legacy') {
    const onSegment = vi.fn();
    const asm = new CmafAssembler({ onSegment, epochMode: mode });
    asm.setInitSegment('video', initWith(VIDEO_TS));
    asm.setInitSegment('audio', initWith(AUDIO_TS));
    const geometries: unknown[] = [];
    asm.onStartupGeometry = (g) => geometries.push(g);
    asm.push('audio', 'a0', 0n, concat(buildMoof(105 * AUDIO_TS), buildMdat(new Uint8Array([1]))));
    asm.push('video', 'v0', 0n, concat(buildMoof(107.73 * VIDEO_TS), buildMdat(new Uint8Array([2]))));
    const out = (call: number) => readBaseMediaDecodeTime(onSegment.mock.calls[call]![1] as Uint8Array)!;
    return { audioBmd: out(0), videoBmd: out(1), geometries, onSegment, asm };
  }

  it('shared (default) preserves the offset: audio 0, video +2.73s', () => {
    const { audioBmd, videoBmd } = joinWith('shared');
    expect(audioBmd).toBe(0n);
    expect(videoBmd).toBe(BigInt(Math.round(2.73 * VIDEO_TS)));
  });

  it('legacy zero-bases each track: BOTH 0, offset erased', () => {
    const { audioBmd, videoBmd } = joinWith('legacy');
    expect(audioBmd).toBe(0n);
    expect(videoBmd).toBe(0n); // the pre-fix desync, reproduced deliberately
  });

  it('reports the startup geometry once both first fragments are known', () => {
    const { geometries } = joinWith('shared');
    expect(geometries).toHaveLength(1); // exactly once
    const g = geometries[0] as Record<string, unknown>;
    expect(g['epochMode']).toBe('shared');
    expect(g['audioStartSec']).toBeCloseTo(0, 5);
    expect(g['videoStartSec']).toBeCloseTo(2.73, 5);
    expect(g['gapSec']).toBeCloseTo(2.73, 5);       // the number skew must correlate with
    expect(g['videoTimescale']).toBe(VIDEO_TS);
    expect(g['audioTimescale']).toBe(AUDIO_TS);
    expect(g['audioRawBmd']).toBe(String(105 * AUDIO_TS));
  });

  it('legacy geometry reports a ZERO gap from the same input', () => {
    const g = joinWith('legacy').geometries[0] as Record<string, unknown>;
    expect(g['epochMode']).toBe('legacy');
    expect(g['gapSec']).toBeCloseTo(0, 5);
  });

  it('the production default is shared — legacy must be opted into', () => {
    expect(new CmafAssembler({ onSegment: vi.fn() }).epochMode).toBe('shared');
  });

  it('epochMode is construction-time only — reassignment does not typecheck', () => {
    const asm = new CmafAssembler({ onSegment: vi.fn(), epochMode: 'legacy' });
    expect(asm.epochMode).toBe('legacy');
    // The guarantee is a COMPILE-TIME one: TypeScript rejects the assignment,
    // which @ts-expect-error asserts (the test fails to compile if it ever
    // becomes writable). Performing the assignment at runtime is deliberately
    // NOT done here — it would mutate the very field under test.
    type Writable = { -readonly [K in keyof CmafAssembler]: CmafAssembler[K] };
    const reassign = (a: CmafAssembler): void => {
      // @ts-expect-error — readonly: assignment must not typecheck.
      a.epochMode = 'shared';
    };
    expect(typeof reassign).toBe('function');
    // A widened alias is the only way to write it, i.e. it takes an explicit
    // cast through a mapped type — never an accidental assignment.
    const widened = asm as Writable;
    expect(widened.epochMode).toBe('legacy');
  });

  it('geometry is reported only AFTER the completing segment reaches the sink', () => {
    const seen: string[] = [];
    const onSegment = vi.fn(() => { seen.push('segment'); });
    const asm = new CmafAssembler({ onSegment });
    asm.setInitSegment('video', initWith(VIDEO_TS));
    asm.setInitSegment('audio', initWith(AUDIO_TS));
    asm.onStartupGeometry = () => { seen.push('geometry'); };
    asm.push('audio', 'a0', 0n, concat(buildMoof(105 * AUDIO_TS), buildMdat(new Uint8Array([1]))));
    asm.push('video', 'v0', 0n, concat(buildMoof(107.73 * VIDEO_TS), buildMdat(new Uint8Array([2]))));
    // The second segment must be delivered before geometry announces it.
    expect(seen).toEqual(['segment', 'segment', 'geometry']);
  });

  it('a throwing geometry consumer still delivers the media segment', () => {
    const onSegment = vi.fn();
    const asm = new CmafAssembler({ onSegment });
    asm.setInitSegment('video', initWith(VIDEO_TS));
    asm.setInitSegment('audio', initWith(AUDIO_TS));
    asm.onStartupGeometry = () => { throw new Error('diagnostic consumer exploded'); };
    asm.push('audio', 'a0', 0n, concat(buildMoof(105 * AUDIO_TS), buildMdat(new Uint8Array([1]))));
    expect(() => {
      asm.push('video', 'v0', 0n, concat(buildMoof(107.73 * VIDEO_TS), buildMdat(new Uint8Array([2]))));
    }).not.toThrow();
    expect(onSegment).toHaveBeenCalledTimes(2);
    // ...and the stream keeps flowing afterwards.
    asm.push('audio', 'a0', 1n, concat(buildMoof(107 * AUDIO_TS), buildMdat(new Uint8Array([3]))));
    expect(onSegment).toHaveBeenCalledTimes(3);
  });
});
