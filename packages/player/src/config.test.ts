/**
 * Tests for MoqtPlayerConfig validation, defaults, and merging.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { validateConfig, DEFAULT_PLAYER_CONFIG, type MoqtPlayerConfig } from './config.js';

/** Minimal valid config — only required fields. */
function minConfig(overrides?: Partial<MoqtPlayerConfig>): MoqtPlayerConfig {
  return { url: 'https://relay.example.com/moq', namespace: 'live', ...overrides };
}

// ─── DEFAULT_PLAYER_CONFIG shape ─────────────────────────────────────

describe('DEFAULT_PLAYER_CONFIG', () => {
  it('has all expected default fields', () => {
    expect(DEFAULT_PLAYER_CONFIG.maxRequestId).toBe(10_000);
    expect(DEFAULT_PLAYER_CONFIG.connectionTimeoutMs).toBe(10_000);
    expect(DEFAULT_PLAYER_CONFIG.reconnectAttempts).toBe(3);
    expect(DEFAULT_PLAYER_CONFIG.reconnectDelayMs).toBe(1_000);
    expect(DEFAULT_PLAYER_CONFIG.reconnectBackoff).toBe('exponential');
    expect(DEFAULT_PLAYER_CONFIG.moqtImplementation).toBe('proto-moq');
    expect(DEFAULT_PLAYER_CONFIG.gapTimeoutMs).toBe(500);
    expect(DEFAULT_PLAYER_CONFIG.driftThresholdMs).toBe(200);
    expect(DEFAULT_PLAYER_CONFIG.maxBufferDepth).toBe(500);
    expect(DEFAULT_PLAYER_CONFIG.maxCatchUpRate).toBe(1.0);
    expect(DEFAULT_PLAYER_CONFIG.catchUpThresholdMs).toBe(500);
    expect(DEFAULT_PLAYER_CONFIG.catchUpRecoveryMs).toBe(50);
    expect(DEFAULT_PLAYER_CONFIG.lateFrameThresholdMs).toBe(100);
    expect(DEFAULT_PLAYER_CONFIG.maxDriftMs).toBe(500);
    expect(DEFAULT_PLAYER_CONFIG.autoQuality).toBe(true);
    expect(DEFAULT_PLAYER_CONFIG.startLevel).toBe('auto');
    expect(DEFAULT_PLAYER_CONFIG.qualitySwitchCooldownMs).toBe(5_000);
    expect(DEFAULT_PLAYER_CONFIG.maxConsecutiveGaps).toBe(5);
    expect(DEFAULT_PLAYER_CONFIG.maxDecodeErrors).toBe(10);
    expect(DEFAULT_PLAYER_CONFIG.gapEscalationWindowMs).toBe(10_000);
    expect(DEFAULT_PLAYER_CONFIG.cmafBootstrapTimeoutMs).toBe(10_000);
    expect(DEFAULT_PLAYER_CONFIG.livenessTimeoutMs).toBe(10_000);
    expect(DEFAULT_PLAYER_CONFIG.livenessResetProbeMs).toBe(2_000);
    expect(DEFAULT_PLAYER_CONFIG.livenessMaxRestarts).toBe(3);
    expect(DEFAULT_PLAYER_CONFIG.livenessRestartBackoffMs).toBe(1_000);
    expect(DEFAULT_PLAYER_CONFIG.livenessHealthyResetMs).toBe(30_000);
    expect(DEFAULT_PLAYER_CONFIG.audioScheduleAheadMs).toBe(200);
    expect(DEFAULT_PLAYER_CONFIG.logLevel).toBe('none');
  });

  it('can be spread over user config', () => {
    const user: MoqtPlayerConfig = { url: 'https://r.example.com', namespace: 'ns', gapTimeoutMs: 1000 };
    const merged = { ...DEFAULT_PLAYER_CONFIG, ...user };
    expect(merged.gapTimeoutMs).toBe(1000);
    expect(merged.maxBufferDepth).toBe(500); // default kept
    expect(merged.url).toBe('https://r.example.com');
  });

  it('user undefined fields do NOT override defaults when spread', () => {
    // This tests the merge pattern: explicit undefined should override,
    // but omitted fields should keep defaults.
    const user: MoqtPlayerConfig = { url: 'u', namespace: 'n' };
    const merged = { ...DEFAULT_PLAYER_CONFIG, ...user };
    expect(merged.maxRequestId).toBe(10_000);
  });
});

// ─── Validation ──────────────────────────────────────────────────────

describe('validateConfig', () => {
  it('passes with minimal valid config', () => {
    expect(() => validateConfig(minConfig())).not.toThrow();
  });

  // ── subscriberPriority ──

  it('rejects subscriberPriority > 255', () => {
    expect(() => validateConfig(minConfig({ subscriberPriority: 256 }))).toThrow(RangeError);
  });

  it('rejects subscriberPriority < 0', () => {
    expect(() => validateConfig(minConfig({ subscriberPriority: -1 }))).toThrow(RangeError);
  });

  it('rejects subscriberPriority non-integer', () => {
    expect(() => validateConfig(minConfig({ subscriberPriority: 1.5 }))).toThrow(RangeError);
  });

  it('accepts subscriberPriority 0', () => {
    expect(() => validateConfig(minConfig({ subscriberPriority: 0 }))).not.toThrow();
  });

  it('accepts subscriberPriority 255', () => {
    expect(() => validateConfig(minConfig({ subscriberPriority: 255 }))).not.toThrow();
  });

  // ── maxCatchUpRate ──

  it('rejects maxCatchUpRate < 1.0', () => {
    expect(() => validateConfig(minConfig({ maxCatchUpRate: 0.9 }))).toThrow(RangeError);
  });

  it('accepts maxCatchUpRate === 1.0', () => {
    expect(() => validateConfig(minConfig({ maxCatchUpRate: 1.0 }))).not.toThrow();
  });

  it('accepts maxCatchUpRate 1.05', () => {
    expect(() => validateConfig(minConfig({ maxCatchUpRate: 1.05 }))).not.toThrow();
  });

  // ── reconnectAttempts ──

  it('rejects reconnectAttempts < 0', () => {
    expect(() => validateConfig(minConfig({ reconnectAttempts: -1 }))).toThrow(RangeError);
  });

  it('accepts reconnectAttempts 0 (disable reconnect)', () => {
    expect(() => validateConfig(minConfig({ reconnectAttempts: 0 }))).not.toThrow();
  });

  // ── CMAF bootstrap ──

  it('accepts cmafBootstrapTimeoutMs 0 (disables the bootstrap deadlines)', () => {
    expect(() => validateConfig(minConfig({ cmafBootstrapTimeoutMs: 0 }))).not.toThrow();
  });

  it('rejects negative cmafBootstrapTimeoutMs', () => {
    expect(() => validateConfig(minConfig({ cmafBootstrapTimeoutMs: -1 }))).toThrow(RangeError);
  });

  // ── warm start (joining FETCH) ──

  it('accepts warmStartCurrentGroup true/false/undefined', () => {
    expect(() => validateConfig(minConfig({ warmStartCurrentGroup: true }))).not.toThrow();
    expect(() => validateConfig(minConfig({ warmStartCurrentGroup: false }))).not.toThrow();
    expect(() => validateConfig(minConfig({}))).not.toThrow();
  });

  it('rejects warmStartCurrentGroup with an explicit non-LargestObject subscriptionFilter (d16 §9.16.2 fatality)', () => {
    expect(() => validateConfig(minConfig({
      warmStartCurrentGroup: true,
      subscriptionFilter: { type: 'NextGroupStart' },
    }))).toThrow(RangeError);
  });

  it('accepts warmStartCurrentGroup with an explicit LargestObject subscriptionFilter', () => {
    expect(() => validateConfig(minConfig({
      warmStartCurrentGroup: true,
      subscriptionFilter: { type: 'LargestObject' },
    }))).not.toThrow();
  });

  it('accepts warmStartCurrentGroup with the deprecated LatestObject compatibility alias', () => {
    // LatestObject encodes as the same wire filter type (0x2) as LargestObject.
    expect(() => validateConfig(minConfig({
      warmStartCurrentGroup: true,
      subscriptionFilter: { type: 'LatestObject' },
    }))).not.toThrow();
  });

  // ── connection authority ──

  it('accepts non-empty authority', () => {
    expect(() => validateConfig(minConfig({ authority: 'proto-moq' }))).not.toThrow();
  });

  it('rejects empty authority', () => {
    expect(() => validateConfig(minConfig({ authority: '' }))).toThrow(RangeError);
  });

  it('rejects blank authority', () => {
    expect(() => validateConfig(minConfig({ authority: '   ' }))).toThrow(RangeError);
  });

  // ── media liveness ──

  it('accepts livenessTimeoutMs 0 (disables the liveness monitor)', () => {
    expect(() => validateConfig(minConfig({ livenessTimeoutMs: 0 }))).not.toThrow();
  });

  it('rejects negative livenessTimeoutMs', () => {
    expect(() => validateConfig(minConfig({ livenessTimeoutMs: -1 }))).toThrow(RangeError);
  });

  it('rejects livenessMaxRestarts 0', () => {
    expect(() => validateConfig(minConfig({ livenessMaxRestarts: 0 }))).toThrow(RangeError);
  });

  it('rejects livenessMaxRestarts non-integer', () => {
    expect(() => validateConfig(minConfig({ livenessMaxRestarts: 1.5 }))).toThrow(RangeError);
  });

  it('rejects livenessResetProbeMs <= 0', () => {
    expect(() => validateConfig(minConfig({ livenessResetProbeMs: 0 }))).toThrow(RangeError);
  });

  it('rejects livenessRestartBackoffMs <= 0', () => {
    expect(() => validateConfig(minConfig({ livenessRestartBackoffMs: 0 }))).toThrow(RangeError);
  });

  it('rejects livenessHealthyResetMs <= 0', () => {
    expect(() => validateConfig(minConfig({ livenessHealthyResetMs: 0 }))).toThrow(RangeError);
  });

  // ── timeout ms fields ──

  it('rejects connectionTimeoutMs <= 0', () => {
    expect(() => validateConfig(minConfig({ connectionTimeoutMs: 0 }))).toThrow(RangeError);
  });

  it('rejects gapTimeoutMs <= 0', () => {
    expect(() => validateConfig(minConfig({ gapTimeoutMs: -100 }))).toThrow(RangeError);
  });

  it('rejects qualitySwitchCooldownMs <= 0', () => {
    expect(() => validateConfig(minConfig({ qualitySwitchCooldownMs: 0 }))).toThrow(RangeError);
  });

  it('rejects audioScheduleAheadMs <= 0', () => {
    expect(() => validateConfig(minConfig({ audioScheduleAheadMs: 0 }))).toThrow(RangeError);
  });

  // ── startLevel ──

  it('accepts startLevel "auto"', () => {
    expect(() => validateConfig(minConfig({ startLevel: 'auto' }))).not.toThrow();
  });

  it('accepts startLevel "lowest"', () => {
    expect(() => validateConfig(minConfig({ startLevel: 'lowest' }))).not.toThrow();
  });

  it('accepts startLevel 0', () => {
    expect(() => validateConfig(minConfig({ startLevel: 0 }))).not.toThrow();
  });

  it('accepts startLevel positive integer', () => {
    expect(() => validateConfig(minConfig({ startLevel: 3 }))).not.toThrow();
  });

  it('rejects startLevel negative', () => {
    expect(() => validateConfig(minConfig({ startLevel: -1 }))).toThrow(RangeError);
  });

  it('rejects startLevel non-integer number', () => {
    expect(() => validateConfig(minConfig({ startLevel: 1.5 }))).toThrow(RangeError);
  });

  // ── maxBufferDepth ──

  it('rejects maxBufferDepth <= 0', () => {
    expect(() => validateConfig(minConfig({ maxBufferDepth: 0 }))).toThrow(RangeError);
  });

  it('rejects maxBufferDepth non-integer', () => {
    expect(() => validateConfig(minConfig({ maxBufferDepth: 1.5 }))).toThrow(RangeError);
  });

  // ── maxRequestId ──

  it('rejects maxRequestId <= 0', () => {
    expect(() => validateConfig(minConfig({ maxRequestId: 0 }))).toThrow(RangeError);
  });

  // ── maxConsecutiveGaps ──

  it('rejects maxConsecutiveGaps <= 0', () => {
    expect(() => validateConfig(minConfig({ maxConsecutiveGaps: 0 }))).toThrow(RangeError);
  });

  // ── maxDecodeErrors ──

  it('rejects maxDecodeErrors <= 0', () => {
    expect(() => validateConfig(minConfig({ maxDecodeErrors: 0 }))).toThrow(RangeError);
  });

  // ── capLevelToResolution ──

  it('rejects capLevelToResolution with width <= 0', () => {
    expect(() => validateConfig(minConfig({ capLevelToResolution: { width: 0, height: 720 } }))).toThrow(RangeError);
  });

  it('rejects capLevelToResolution with height <= 0', () => {
    expect(() => validateConfig(minConfig({ capLevelToResolution: { width: 1280, height: -1 } }))).toThrow(RangeError);
  });

  it('accepts valid capLevelToResolution', () => {
    expect(() => validateConfig(minConfig({ capLevelToResolution: { width: 1280, height: 720 } }))).not.toThrow();
  });

  // ── targetLatencyMs ──

  it('rejects targetLatencyMs <= 0', () => {
    expect(() => validateConfig(minConfig({ targetLatencyMs: 0 }))).toThrow(RangeError);
  });

  it('accepts targetLatencyMs > 0', () => {
    expect(() => validateConfig(minConfig({ targetLatencyMs: 1000 }))).not.toThrow();
  });

  // ── deliveryTimeoutMs ──

  it('rejects deliveryTimeoutMs <= 0', () => {
    expect(() => validateConfig(minConfig({ deliveryTimeoutMs: 0 }))).toThrow(RangeError);
  });

  // ── catchUpRecoveryMs (§5.1.16) ──

  it('rejects catchUpRecoveryMs <= 0', () => {
    expect(() => validateConfig(minConfig({ catchUpRecoveryMs: 0 }))).toThrow(RangeError);
  });

  it('accepts catchUpRecoveryMs > 0', () => {
    expect(() => validateConfig(minConfig({ catchUpRecoveryMs: 50 }))).not.toThrow();
  });

  // ── draftVersion ──

  it('accepts draftVersion 14', () => {
    expect(() => validateConfig(minConfig({ draftVersion: 14 }))).not.toThrow();
  });

  it('accepts draftVersion 16', () => {
    expect(() => validateConfig(minConfig({ draftVersion: 16 }))).not.toThrow();
  });

  it('draftVersion is optional (defaults to undefined)', () => {
    const config = minConfig();
    expect(config.draftVersion).toBeUndefined();
  });
});
