import { describe, expect, it, vi } from 'vitest';
import { buildChunk, buildInit, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { CmafAssembler } from './cmaf-assembler.js';
import { readBaseMediaDecodeTime } from './mp4-box.js';

type MediaType = 'video' | 'audio';

function init(type: MediaType, timescale: number) {
  return buildInit({ trackId: type === 'video' ? 1 : 2, timescale, handler: type === 'video' ? 'vide' : 'soun' });
}

function media(type: MediaType, timescale: number, timeS: bigint) {
  return buildChunk({ trackId: type === 'video' ? 1 : 2, bmdt: timeS * BigInt(timescale),
    samples: [{ duration: timescale / 2, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(0, 0, 0, 0) });
}

describe('CMAF initialization changes on an ongoing timeline', () => {
  it.each([
    ['video', 12288, 60000],
    ['video', 60000, 12288],
    ['audio', 48000, 44100],
    ['audio', 44100, 48000],
    ['video', 12288, 12288],
  ] as const)('preserves the shared origin when %s changes from %i to %i Hz', (type, oldScale, nextScale) => {
    const other: MediaType = type === 'video' ? 'audio' : 'video';
    const otherScale = other === 'video' ? 90000 : 48000;
    const segments: Array<{ type: MediaType; start: bigint | null }> = [];
    const discontinuity = vi.fn();
    const assembler = new CmafAssembler({
      onSegment: (mediaType, bytes) => { segments.push({ type: mediaType, start: readBaseMediaDecodeTime(bytes) }); },
      onDiscontinuity: discontinuity,
    });
    try {
      assembler.setInitSegment(type, init(type, oldScale));
      assembler.setInitSegment(other, init(other, otherScale));
      assembler.push(type, type, 10n, media(type, oldScale, 100n));
      assembler.push(other, other, 10n, media(other, otherScale, 100n));
      expect(segments).toEqual([{ type, start: 0n }, { type: other, start: 0n }]);

      assembler.setInitSegment(type, init(type, nextScale));
      assembler.push(type, type, 11n, media(type, nextScale, 101n));
      assembler.push(other, other, 11n, media(other, otherScale, 101n));
      expect(segments.slice(2)).toEqual([
        { type, start: BigInt(nextScale) }, { type: other, start: BigInt(otherScale) },
      ]);
      expect(discontinuity).not.toHaveBeenCalled();
    } finally { assembler.destroy(); }
  });
});
