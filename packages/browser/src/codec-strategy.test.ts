/**
 * Tests for codec strategy factory.
 *
 * Verifies that createCodecStrategy dispatches to the correct strategy
 * implementation based on codec string prefix.
 *
 * @see draft-ietf-moq-msf-00 §5.1.24 (codec string)
 * @module
 */

import { describe, it, expect } from 'vitest';
import { createCodecStrategy } from './codec-strategy.js';
import { H264Strategy } from './codec-strategy-h264.js';
import { HevcStrategy } from './codec-strategy-hevc.js';
import { Av1Strategy } from './codec-strategy-av1.js';
import { PassthroughStrategy } from './codec-strategy-passthrough.js';

describe('createCodecStrategy', () => {
  it('returns H264Strategy for avc1 codec string', () => {
    expect(createCodecStrategy('avc1.640028')).toBeInstanceOf(H264Strategy);
  });

  it('returns H264Strategy for avc3 codec string', () => {
    expect(createCodecStrategy('avc3')).toBeInstanceOf(H264Strategy);
  });

  it('returns HevcStrategy for hvc1 codec string', () => {
    expect(createCodecStrategy('hvc1.1.6.L93.B0')).toBeInstanceOf(HevcStrategy);
  });

  it('returns HevcStrategy for hev1 codec string', () => {
    expect(createCodecStrategy('hev1')).toBeInstanceOf(HevcStrategy);
  });

  it('returns Av1Strategy for av01 codec string', () => {
    expect(createCodecStrategy('av01.0.08M.10')).toBeInstanceOf(Av1Strategy);
  });

  it('returns PassthroughStrategy for vp9', () => {
    expect(createCodecStrategy('vp9')).toBeInstanceOf(PassthroughStrategy);
  });

  it('returns PassthroughStrategy for unknown codec', () => {
    expect(createCodecStrategy('unknown')).toBeInstanceOf(PassthroughStrategy);
  });

  it('handles case-insensitive codec strings', () => {
    expect(createCodecStrategy('AVC1.640028')).toBeInstanceOf(H264Strategy);
    expect(createCodecStrategy('HVC1.1.6.L93.B0')).toBeInstanceOf(HevcStrategy);
    expect(createCodecStrategy('AV01.0.08M.10')).toBeInstanceOf(Av1Strategy);
  });
});
