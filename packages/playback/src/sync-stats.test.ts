import { describe, expect, it } from 'vitest';
import { SyncController } from './sync.js';

function controller() {
  const now = 1_000_000_000;
  return { now, sync: new SyncController({ driftThresholdUs: 1000, clock: { now: () => 0 }, wallClock: { now: () => now } }) };
}

describe('capture timestamp age observability', () => {
  it('distinguishes unavailable from zero and measures with catch-up disabled', () => {
    const { now, sync } = controller();
    expect(sync.captureTimestampAgeUs).toBeNull();
    expect(sync.latencyUs).toBe(0);
    expect(sync.evaluateCatchUp(BigInt(now - 250_000))).toBeNull();
    expect(sync.captureTimestampAgeUs).toBe(250_000);
    expect(sync.currentRate).toBe(1);
    sync.evaluateCatchUp(BigInt(now));
    expect(sync.captureTimestampAgeUs).toBe(0);
    sync.evaluateCatchUp(BigInt(now + 5000));
    expect(sync.captureTimestampAgeUs).toBe(-5000);
    expect(sync.latencyUs).toBe(-5000);
  });

  it('invalidates the measurement on sync reset', () => {
    const { now, sync } = controller();
    sync.evaluateCatchUp(BigInt(now - 250_000));
    sync.reset();
    expect(sync.captureTimestampAgeUs).toBeNull();
    expect(sync.latencyUs).toBe(0);
  });

  it('invalidates wall-clock age on media-time or missing timestamp observations', () => {
    const { now, sync } = controller();
    sync.evaluateCatchUp(BigInt(now - 250_000));
    expect(sync.evaluateCatchUp(500_000n, false)).toBeNull();
    expect(sync.captureTimestampAgeUs).toBeNull();
    expect(sync.latencyUs).toBe(0);
    sync.evaluateCatchUp(BigInt(now - 100_000), true);
    sync.evaluateCatchUp(0n);
    expect(sync.captureTimestampAgeUs).toBeNull();
  });
});
