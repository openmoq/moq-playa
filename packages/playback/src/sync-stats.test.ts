import { describe, expect, it } from 'vitest';
import { SyncController } from './sync.js';

function controller() {
  const now = 1_000_000_000;
  return { now, sync: new SyncController({ driftThresholdUs: 1000, clock: { now: () => 0 }, wallClock: { now: () => now } }) };
}

describe('capture timestamp age observability', () => {
  it('distinguishes unavailable from zero and measures without rate policy', () => {
    const { now, sync } = controller();
    expect(sync.captureTimestampAgeUs).toBeNull();
    expect(sync.latencyUs).toBe(0);
    sync.observeCaptureTimestamp(BigInt(now - 250_000));
    expect(sync.captureTimestampAgeUs).toBe(250_000);
    sync.observeCaptureTimestamp(BigInt(now));
    expect(sync.captureTimestampAgeUs).toBe(0);
    sync.observeCaptureTimestamp(BigInt(now + 5000));
    expect(sync.captureTimestampAgeUs).toBe(-5000);
    expect(sync.latencyUs).toBe(-5000);
  });

  it('invalidates the measurement on sync reset', () => {
    const { now, sync } = controller();
    sync.observeCaptureTimestamp(BigInt(now - 250_000));
    sync.reset();
    expect(sync.captureTimestampAgeUs).toBeNull();
    expect(sync.latencyUs).toBe(0);
  });

  it('invalidates wall-clock age on media-time or missing timestamp observations', () => {
    const { now, sync } = controller();
    sync.observeCaptureTimestamp(BigInt(now - 250_000));
    sync.observeCaptureTimestamp(500_000n, false);
    expect(sync.captureTimestampAgeUs).toBeNull();
    expect(sync.latencyUs).toBe(0);
    sync.observeCaptureTimestamp(BigInt(now - 100_000), true);
    sync.observeCaptureTimestamp(0n);
    expect(sync.captureTimestampAgeUs).toBeNull();
  });

  it('does not let an unmeasurable track null out another track\'s measured age', () => {
    const { now, sync } = controller();
    // Video carries wall-clock capture timestamps; audio carries media time.
    sync.observeCaptureTimestamp(BigInt(now - 250_000), true, 'video');
    sync.observeCaptureTimestamp(500_000n, false, 'audio');
    expect(sync.captureTimestampAgeUs).toBe(250_000);
    expect(sync.latencyUs).toBe(250_000);
    sync.observeCaptureTimestamp(0n, undefined, 'audio');
    expect(sync.captureTimestampAgeUs).toBe(250_000);
    sync.observeCaptureTimestamp(BigInt(now - 100_000), true, 'video');
    expect(sync.captureTimestampAgeUs).toBe(100_000);
  });

  it('reports the most recent measurement among tracks that are measurable', () => {
    const { now, sync } = controller();
    sync.observeCaptureTimestamp(BigInt(now - 250_000), true, 'video');
    sync.observeCaptureTimestamp(BigInt(now - 200_000), true, 'audio');
    expect(sync.captureTimestampAgeUs).toBe(200_000);
    // Audio becomes unmeasurable: fall back to video's still-valid age.
    sync.observeCaptureTimestamp(500_000n, false, 'audio');
    expect(sync.captureTimestampAgeUs).toBe(250_000);
    // Once no track is measurable, the age is unavailable again.
    sync.observeCaptureTimestamp(500_000n, false, 'video');
    expect(sync.captureTimestampAgeUs).toBeNull();
  });
});

describe('capture timestamp source bounds', () => {
  it('rejects arbitrary JavaScript source keys without replacing a valid observation', () => {
    const { now, sync } = controller();
    sync.observeCaptureTimestamp(BigInt(now - 250_000), true, 'video');
    for (const source of ['track-1', 'track-2', 'constructor']) {
      expect(() => sync.observeCaptureTimestamp(BigInt(now), true, source as never)).toThrow(TypeError);
      expect(sync.captureTimestampAgeUs).toBe(250_000);
    }
    // The legacy two-argument API still owns an independent default slot.
    sync.observeCaptureTimestamp(BigInt(now - 100_000), true);
    sync.observeCaptureTimestamp(0n);
    expect(sync.captureTimestampAgeUs).toBe(250_000);
    sync.reset();
    expect(sync.captureTimestampAgeUs).toBeNull();
  });
});
