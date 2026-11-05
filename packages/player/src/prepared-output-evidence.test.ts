import { describe, expect, it } from 'vitest';
import type { MoqtObject } from '@openmoq/transport';
import { varint } from '@openmoq/transport';
import type { LocHeaders } from '@openmoq/loc';
import { LocmafEncoder, LocmafGroupState, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { buildChunk, buildInit, NON_SYNC_FLAGS, SYNC_FLAGS, videoInit } from '../../locmaf/test-support/cmaf.js';
import { annexBToLengthPrefixed } from '../../browser/src/nal-framing.js';
import { PreparedOutputEvidence } from './prepared-output-evidence.js';

const object = (payload: Uint8Array, id = 0n): MoqtObject => ({ kind: 'data', payload,
  trackAlias: varint(1), groupId: varint(90), objectId: varint(id), subgroupId: varint(0), publisherPriority: 0 });
const marking = (independent: boolean): LocHeaders => ({ captureTimestamp: 90_040_000n,
  videoFrameMarking: { independent, startOfFrame: true, endOfFrame: true,
    discardable: false, baseLayerSync: false, temporalId: 0 } });
const idr = Uint8Array.of(0, 0, 0, 2, 0x65, 0x88);
const delta = Uint8Array.of(0, 0, 0, 2, 0x41, 0x88);
const chunk = (flags: number, cto = 3600, bmdt = 8_100_000n) => buildChunk({ bmdt,
  samples: [{ duration: 3000, size: 6, flags, cto }], mdat: idr });
const concat = (...parts: Uint8Array[]) => {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
};

describe('prepared output evidence', () => {
  it('requires an independent LOC frame rather than treating any timestamped object as usable video', () => {
    const evidence = new PreparedOutputEvidence('loc', 'video', 'avc1.640028');
    expect(evidence.inspect(object(delta, 1n), marking(false))).toBe(false);
    expect(evidence.firstPresentationTimeUs).toBeNull();
    expect(evidence.inspect(object(idr, 2n), marking(true))).toBe(true);
    expect(evidence.firstPresentationTimeUs).toBe(90_040_000n);
  });

  it('does not override explicit dependent marking with object zero', () => {
    const evidence = new PreparedOutputEvidence('loc', 'video', 'avc1.640028');
    expect(evidence.inspect(object(idr), marking(false))).toBe(false);
    expect(evidence.firstPresentationTimeUs).toBeNull();
  });

  it('uses the LOC group-start rule when marking is absent, not the numeric group position', () => {
    const evidence = new PreparedOutputEvidence('loc', 'video', 'avc1.640028');
    expect(evidence.inspect(object(idr, 1n), { captureTimestamp: 90_000_000n })).toBe(false);
    expect(evidence.inspect(object(idr), { captureTimestamp: 90_000_000n })).toBe(true);
    expect(evidence.sourcePresentationTimeUs).toBe(90_000_000n);
  });

  it('refuses a known delta bitstream advertised as independent', () => {
    const evidence = new PreparedOutputEvidence('loc', 'video', 'avc1.640028');
    expect(evidence.inspect(object(delta), marking(true))).toBe(false);
    expect(evidence.firstPresentationTimeUs).toBeNull();
    expect(evidence.inspect(object(idr), marking(true))).toBe(true);
  });

  it.each([3, 4])('accepts the same independently marked HEVC IDR with a %s-byte Annex B prefix', prefix => {
    const payload = concat(prefix === 3 ? Uint8Array.of(0, 0, 1) : Uint8Array.of(0, 0, 0, 1),
      Uint8Array.of(0x26, 0x01, 0x80));
    const canonical = annexBToLengthPrefixed(payload, 4);
    expect(canonical).toEqual(Uint8Array.of(0, 0, 0, 3, 0x26, 0x01, 0x80));
    expect(new PreparedOutputEvidence('loc', 'video', 'hev1.1.6.L93.90').inspect(object(canonical), marking(true))).toBe(true);
    expect(new PreparedOutputEvidence('loc', 'video', 'hev1.1.6.L93.90').inspect(object(payload), marking(true))).toBe(true);
    expect(new PreparedOutputEvidence('loc', 'video', 'hev1.1.6.L93.90').inspect(object(payload), marking(false))).toBe(false);
  });

  it('leaves ordinary audio readiness independent of video markings', () => {
    const evidence = new PreparedOutputEvidence('loc');
    expect(evidence.inspect(object(delta, 1n), marking(false))).toBe(true);
    expect(evidence.sourcePresentationTimeUs).toBe(90_040_000n);
  });

  it('requires source timing and actual data for LOC', () => {
    const evidence = new PreparedOutputEvidence('loc', 'video');
    expect(() => evidence.inspect(object(idr), { videoFrameMarking: marking(true).videoFrameMarking! })).toThrow(/source timestamp/);
    expect(evidence.inspect(object(new Uint8Array()), marking(true))).toBe(false);
    expect(evidence.firstPresentationTimeUs).toBeNull();
  });

  for (const packaging of ['cmaf', 'locmaf'] as const) {
    const encode = (bytes: Uint8Array) => packaging === 'locmaf'
      ? serializeLocmafObject({ kind: 'rawBoxes', boxes: bytes }) : bytes;
    it(`requires sync sample evidence for ${packaging}, including a nonzero composition offset`, () => {
      const evidence = new PreparedOutputEvidence(packaging, 'video'); evidence.setInit(videoInit());
      expect(evidence.inspect(object(encode(chunk(NON_SYNC_FLAGS))))).toBe(false);
      expect(evidence.firstPresentationTimeUs).toBeNull();
      expect(evidence.inspect(object(encode(chunk(SYNC_FLAGS))))).toBe(true);
      expect(evidence.sourcePresentationTimeUs).toBe(90_040_000n);
    });

    it(`does not mistake a ${packaging} initialization header for independently coded media`, () => {
      const evidence = new PreparedOutputEvidence(packaging, 'video'); evidence.setInit(videoInit());
      expect(evidence.inspect(object(encode(videoInit())))).toBe(false);
      expect(evidence.firstPresentationTimeUs).toBeNull();
    });

    for (const role of ['audio', 'video'] as const) {
      it.each([1, 2])(`accepts ${role} ${packaging} objects with %s successive CMSF chunks`, count => {
        const bytes = count === 1 ? chunk(SYNC_FLAGS)
          : concat(chunk(SYNC_FLAGS), chunk(NON_SYNC_FLAGS, 3600, 8_103_000n));
        const evidence = new PreparedOutputEvidence(packaging, role);
        evidence.setInit(role === 'audio' ? buildInit({ trackId: 1, timescale: 90_000, handler: 'soun' }) : videoInit());
        let usable = false;
        expect(() => { usable = evidence.inspect(object(encode(bytes))); }).not.toThrow();
        expect(usable).toBe(true);
        expect(evidence.sourcePresentationTimeUs).toBe(90_040_000n);
        expect(evidence.firstPresentationTimeUs).toBe(90_040_000n);
      });
    }

    it.each([false, true])(`requires the first ${packaging} chunk's sync witness without trimming: firstSync=%s`, firstSync => {
      const bytes = concat(chunk(firstSync ? SYNC_FLAGS : NON_SYNC_FLAGS), chunk(SYNC_FLAGS, -1800, 8_103_000n),
        chunk(SYNC_FLAGS, 3600, 8_106_000n));
      const evidence = new PreparedOutputEvidence(packaging, 'video'); evidence.setInit(videoInit());
      let usable = false;
      expect(() => { usable = evidence.inspect(object(encode(bytes))); }).not.toThrow();
      expect(usable).toBe(firstSync);
      const expected = firstSync ? 90_040_000n : null;
      expect(evidence.sourcePresentationTimeUs).toBe(expected);
      expect(evidence.firstPresentationTimeUs).toBe(expected);
    });

    it.each(['truncated-box', 'sample-outside-mdat', 'missing-mdat', 'wrong-track'] as const)(
      `rejects ${packaging} malformed trailing %s without publishing an earlier readiness witness`, kind => {
        const valid = chunk(SYNC_FLAGS), moofSize = new DataView(valid.buffer).getUint32(0);
        const tail = kind === 'truncated-box' ? Uint8Array.of(0, 0, 0, 8)
          : kind === 'missing-mdat' ? valid.slice(0, moofSize)
          : buildChunk({ bmdt: 8_103_000n, trackId: kind === 'wrong-track' ? 2 : 1,
            samples: [{ duration: 3000, size: kind === 'sample-outside-mdat' ? 99 : 6, flags: SYNC_FLAGS }], mdat: idr });
        const bytes = concat(valid, tail), evidence = new PreparedOutputEvidence(packaging, 'video');
        evidence.setInit(videoInit());
        // Deliberately bypass serializer validation to exercise the receiver.
        const payload = packaging === 'locmaf' ? concat(Uint8Array.of(4), bytes) : bytes;
        expect(() => evidence.inspect(object(payload))).toThrow();
        expect(evidence.sourcePresentationTimeUs).toBeNull();
        expect(evidence.firstPresentationTimeUs).toBeNull();
      });
  }

  for (const full of [false, true]) {
    it.each([false, true])(`uses ${full ? 'full-header' : 'raw-box'} LOCMAF sample flags: sync=%s`, sync => {
      const init = videoInit(), bytes = chunk(sync ? SYNC_FLAGS : NON_SYNC_FLAGS);
      const wire = serializeLocmafObject(full
        ? new LocmafEncoder().encode(bytes, new LocmafGroupState(), parseLocmafTrackContext(init), true, 0n)
        : { kind: 'rawBoxes', boxes: bytes });
      const evidence = new PreparedOutputEvidence('locmaf', 'video'); evidence.setInit(init);
      expect(evidence.inspect(object(wire))).toBe(sync);
      expect(evidence.firstPresentationTimeUs).toBe(sync ? 90_040_000n : null);
    });
  }

  it('retains split-CMAF compatibility without calling its first half usable video', () => {
    const evidence = new PreparedOutputEvidence('cmaf', 'video'); evidence.setInit(videoInit());
    const bytes = chunk(SYNC_FLAGS), size = new DataView(bytes.buffer).getUint32(0);
    expect(evidence.inspect(object(bytes.slice(0, size)))).toBe(false);
    expect(evidence.firstPresentationTimeUs).toBeNull();
    expect(evidence.inspect(object(bytes.slice(size), 1n))).toBe(true);
    expect(evidence.firstPresentationTimeUs).toBe(90_040_000n);
  });

  it('does not apply the video random-access requirement to independent audio samples', () => {
    const evidence = new PreparedOutputEvidence('cmaf');
    evidence.setInit(buildInit({ trackId: 1, timescale: 90_000, handler: 'soun' }));
    expect(evidence.inspect(object(chunk(NON_SYNC_FLAGS)))).toBe(true);
    expect(evidence.firstPresentationTimeUs).toBe(90_040_000n);
  });
});
