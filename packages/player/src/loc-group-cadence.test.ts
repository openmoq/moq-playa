import { describe, expect, it } from 'vitest';
import type { LocHeaders } from '@openmoq/loc';
import { LocGroupCadence } from './loc-group-cadence.js';

const wall = (timestamp: bigint): LocHeaders => ({ captureTimestamp: timestamp, timestampIsWallClock: true });
const media = (timestamp: bigint, timescale: bigint): LocHeaders => ({ timestamp, timescale,
  captureTimestamp: timestamp * 1_000_000n / timescale, timestampIsWallClock: false });

describe('LOC group cadence', () => {
  it('measures source time rather than assuming two seconds', () => {
    const cadence = new LocGroupCadence();
    cadence.observe(10n, wall(8_000_000n)); expect(cadence.durationUs).toBeNull();
    cadence.observe(11n, wall(8_500_000n)); expect(cadence.durationUs).toBe(500_000);
  });
  it('subtracts large integer timestamps before converting to Number', () => {
    const cadence = new LocGroupCadence(), origin = 2n ** 60n;
    cadence.observe(1n, wall(origin)); cadence.observe(2n, wall(origin + 123_457n));
    expect(cadence.durationUs).toBe(123_457);
  });
  it('uses raw LOC-04 ticks without rescaling normalized microseconds twice', () => {
    const cadence = new LocGroupCadence();
    cadence.observe(1n, media(900_000n, 90_000n)); cadence.observe(2n, media(945_000n, 90_000n));
    expect(cadence.durationUs).toBe(500_000);
  });
  it('ignores duplicate and lower Groups without moving the anchor', () => {
    const cadence = new LocGroupCadence();
    cadence.observe(3n, wall(3_000_000n)); cadence.observe(3n, wall(8_000_000n));
    cadence.observe(2n, wall(9_000_000n)); cadence.observe(4n, wall(4_000_000n));
    expect(cadence.durationUs).toBe(1_000_000);
  });
  it('does not divide a multi-Group gap into an invented duration', () => {
    const cadence = new LocGroupCadence();
    cadence.observe(1n, wall(0n)); cadence.observe(2n, wall(1_000_000n));
    cadence.observe(5n, wall(7_000_000n)); expect(cadence.durationUs).toBeNull();
    cadence.observe(6n, wall(7_500_000n)); expect(cadence.durationUs).toBe(500_000);
  });
  it.each([{}, { timestampIsWallClock: false }, { timescale: 0n, captureTimestamp: 7n },
    { timescale: 90_000n, timestampIsWallClock: true, captureTimestamp: 7n }] as LocHeaders[])
  ('breaks the pair for missing or inconsistent timestamp metadata %#', headers => {
    const cadence = new LocGroupCadence();
    cadence.observe(1n, wall(0n)); cadence.observe(2n, wall(1_000_000n));
    cadence.observe(3n, headers); expect(cadence.durationUs).toBeNull();
    cadence.observe(4n, wall(2_000_000n)); expect(cadence.durationUs).toBeNull();
    cadence.observe(5n, wall(3_000_000n)); expect(cadence.durationUs).toBe(1_000_000);
  });
  it('restarts at a domain or timescale change', () => {
    const cadence = new LocGroupCadence();
    cadence.observe(1n, wall(0n)); cadence.observe(2n, wall(1_000_000n));
    cadence.observe(3n, media(180_000n, 90_000n)); expect(cadence.durationUs).toBeNull();
    cadence.observe(4n, media(270_000n, 90_000n)); expect(cadence.durationUs).toBe(1_000_000);
    cadence.observe(5n, media(240_000n, 60_000n)); expect(cadence.durationUs).toBeNull();
  });
  it.each([0n, -1n])('restarts on non-increasing source time %s', delta => {
    const cadence = new LocGroupCadence();
    cadence.observe(1n, wall(1_000_000n)); cadence.observe(2n, wall(1_000_000n + delta));
    expect(cadence.durationUs).toBeNull();
    cadence.observe(3n, wall(2_000_000n + delta)); expect(cadence.durationUs).toBe(1_000_000);
  });
  it('does not treat a long valid cadence as a protocol discontinuity', () => {
    const cadence = new LocGroupCadence();
    cadence.observe(1n, wall(0n)); cadence.observe(2n, wall(30_000_000n));
    expect(cadence.durationUs).toBe(30_000_000);
  });
  it('refuses durations that cannot be represented exactly in microseconds', () => {
    const cadence = new LocGroupCadence();
    cadence.observe(1n, wall(0n)); cadence.observe(2n, wall(BigInt(Number.MAX_SAFE_INTEGER) + 1n));
    expect(cadence.durationUs).toBeNull();
  });
  it('reset drops the anchor and measured duration', () => {
    const cadence = new LocGroupCadence();
    cadence.observe(1n, wall(0n)); cadence.observe(2n, wall(1_000_000n)); cadence.reset();
    cadence.observe(3n, wall(2_000_000n)); expect(cadence.durationUs).toBeNull();
  });
  it('subtracts raw ticks before rounding the duration to microseconds', () => {
    const cadence = new LocGroupCadence();
    cadence.observe(1n, media(8n, 90_000n)); cadence.observe(2n, media(9n, 90_000n));
    expect(cadence.durationUs).toBe(11);
  });
});
