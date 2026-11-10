import { describe, expect, it } from 'vitest';
import { formatMetric } from './adapter.js';

describe('metric display formatting', () => {
  it('rounds and scales bitrates', () => {
    expect(formatMetric(2738306.4848224605, 'bps')).toBe('2.74 Mbps');
    expect(formatMetric(96000, 'bps')).toBe('96.0 kbps');
    expect(formatMetric(200, 'bps')).toBe('200 bps');
    expect(formatMetric(999.6, 'bps')).toBe('1000 bps');
  });
  it('keeps integers exact and rounds fractions by unit', () => {
    expect(formatMetric(12, 'ms')).toBe('12 ms');
    expect(formatMetric(7.4567, 'ms')).toBe('7.5 ms');
    expect(formatMetric(138.49, 'ms')).toBe('138 ms');
    expect(formatMetric(1.9444, 'seconds')).toBe('1.94 s');
    expect(formatMetric(2, 'seconds')).toBe('2 s');
    expect(formatMetric(0.333, 'percent')).toBe('0.3 %');
    expect(formatMetric(16782, 'count')).toBe('16,782 count');
    expect(formatMetric(104857.6, 'bytes')).toBe('104.9 KB');
    expect(formatMetric(5e6, 'bytes')).toBe('5.0 MB');
    expect(formatMetric(92, 'bytes')).toBe('92 B');
  });
  it('leaves an unknown unit untouched', () => { expect(formatMetric(3.25, 'frames')).toBe('3.25 frames'); });
  it.each(['seconds', 'percent', 'ms', 'bps', 'bytes', 'count'])('keeps finite samples finite for %s', unit => {
    for (const value of [Number.MAX_VALUE, -Number.MAX_VALUE, 0]) {
      expect(formatMetric(value, unit)).not.toMatch(/Infinity|NaN/);
    }
  });
  it('rounds negative samples and zero without intermediate scaling', () => {
    expect(formatMetric(-1.9444, 'seconds')).toBe('-1.94 s');
    expect(formatMetric(-0.333, 'percent')).toBe('-0.3 %');
    expect(formatMetric(-7.4567, 'ms')).toBe('-7.5 ms');
    expect(formatMetric(0, 'seconds')).toBe('0 s');
    expect(formatMetric(0, 'percent')).toBe('0 %');
    expect(formatMetric(0, 'ms')).toBe('0 ms');
  });
});
