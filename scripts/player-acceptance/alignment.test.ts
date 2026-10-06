import { describe, expect, it } from 'vitest';
import { inspectAlternatives } from './alignment.js';
import type { LoadedTrack } from '../../examples/node-publisher/src/fixture.js';
import { buildInit, buildChunk, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../packages/locmaf/test-support/cmaf.js';

function track(name: string, timescale = 90000, offset = 0, cto = 0, flags = SYNC_FLAGS): LoadedTrack {
  return {
    meta: { name, packaging: 'cmaf', role: 'video', codec: 'avc1.42c028', init: 'init.mp4', chunks: [] },
    initData: buildInit({ trackId: 1, timescale, handler: 'vide' }),
    chunks: [0, timescale / 2].map((bmdt) => buildChunk({ bmdt: bmdt + offset,
      samples: [{ duration: timescale / 4, size: 4, flags, cto },
        { duration: timescale / 4, size: 4, flags: NON_SYNC_FLAGS }], mdat: new Uint8Array(8) })),
  };
}

describe('acceptance fixture alignment', () => {
  it('records each sample and accepts exact rational alignment across timescales', () => {
    const result = inspectAlternatives([track('low'), track('high', 48000)]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ name: 'low', timescale: 90000, durationTicks: '90000',
      chunks: [{ samples: [{ presentationTicks: '0', durationTicks: '22500', sync: true },
        { presentationTicks: '22500', durationTicks: '22500', sync: false }] },
      { samples: [{ presentationTicks: '45000' }, { presentationTicks: '67500' }] }] });
  });

  it('rejects a one-tick offset rather than rounding to milliseconds', () => {
    expect(() => inspectAlternatives([track('low'), track('high', 90000, 1)])).toThrow(/aligned/);
  });

  it('compares composition times as well as decode times', () => {
    expect(() => inspectAlternatives([track('low'), track('high', 90000, 0, 1)])).toThrow(/aligned/);
  });

  it('rejects a rendition missing its last fragment', () => {
    const high = track('high');
    expect(() => inspectAlternatives([track('low'), { ...high, chunks: high.chunks.slice(0, 1) }])).toThrow(/aligned/);
  });

  it('compares individual durations even when chunk and loop spans match', () => {
    const high = track('high');
    const first = buildChunk({ bmdt: 0, samples: [
      { duration: 15000, size: 4, flags: SYNC_FLAGS },
      { duration: 30000, size: 4, flags: NON_SYNC_FLAGS },
    ], mdat: new Uint8Array(8) });
    expect(() => inspectAlternatives([track('low'), { ...high, chunks: [first, high.chunks[1]!] }])).toThrow(/aligned/);
  });

  it('requires signaled independence rather than treating unspecified flags as proof', () => {
    expect(() => inspectAlternatives([track('low', 90000, 0, 0, 0)])).toThrow(/independent/);
  });

  it('rejects zero-duration samples even within a positive-duration chunk', () => {
    const chunk = buildChunk({ bmdt: 0, samples: [
      { duration: 0, size: 4, flags: SYNC_FLAGS },
      { duration: 45000, size: 4, flags: NON_SYNC_FLAGS },
    ], mdat: new Uint8Array(8) });
    expect(() => inspectAlternatives([{ ...track('low'), chunks: [chunk] }])).toThrow(/positive/);
  });

  it('rejects non-sync group starts', () => {
    expect(() => inspectAlternatives([track('low', 90000, 0, 0, NON_SYNC_FLAGS)])).toThrow(/sync/);
  });

  it('rejects internal decode-time holes', () => {
    const high = track('high');
    expect(() => inspectAlternatives([{ ...high, chunks: [high.chunks[0]!, track('offset', 90000, 1).chunks[1]!] }]))
      .toThrow(/contiguous/);
  });

  it('rejects unsupported or malformed chunks rather than omitting them from the proof', () => {
    expect(() => inspectAlternatives([{ ...track('low'), chunks: [new Uint8Array(4)] }])).toThrow();
  });
});
