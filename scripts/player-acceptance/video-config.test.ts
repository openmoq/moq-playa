import { describe, expect, it } from 'vitest';
import { fixtureVideoConfig, validateFixtureAvc } from './video-config.js';
import { buildInit } from '../../packages/locmaf/test-support/cmaf.js';

describe('acceptance fixture video configuration', () => {
  it('retains the original explicit level/codec defaults', () => {
    expect(fixtureVideoConfig(true)).toEqual({ level: '4.0', codec: 'avc1.42c028' });
    expect(fixtureVideoConfig(false)).toEqual({ level: '3.0', codec: 'avc1.42c01e' });
  });
  it('uses a declared per-track encoder level and expected codec', () => {
    expect(fixtureVideoConfig(true, { videoLevel: '3.0', expectedCodec: 'avc1.42c01e' }))
      .toEqual({ level: '3.0', codec: 'avc1.42c01e' });
  });
  it('rejects incomplete overrides', () => {
    expect(() => fixtureVideoConfig(true, { videoLevel: '3.0' })).toThrow(/together/);
    expect(() => fixtureVideoConfig(true, { expectedCodec: 'avc1.42c01e' })).toThrow(/together/);
  });
  it('checks a valid actual avcC against the independent expectation', () => {
    const init = buildInit({ trackId: 1, timescale: 12288, handler: 'vide' });
    expect(validateFixtureAvc(init, 'avc1.640028')).toBe('avc1.640028');
    expect(() => validateFixtureAvc(init, 'avc1.42c01e')).toThrow(/expected avc1.42c01e/);
  });
});
