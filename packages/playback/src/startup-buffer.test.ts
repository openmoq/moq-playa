/**
 * Tests for StartupBuffer — holds frames before first drain to allow
 * jitter estimation warmup and prevent initial stutter.
 *
 * @see draft-ietf-moq-loc-01 §4.2 (decode order)
 * @module
 */

import { describe, it, expect } from 'vitest';
import { StartupBuffer, classifyNetwork } from './startup-buffer.js';

describe('classifyNetwork', () => {
  it('LAN: RTT < 1ms → minFrames=2, maxWaitMs=80', () => {
    const params = classifyNetwork(0.5);
    expect(params.minFrames).toBe(2);
    expect(params.maxWaitMs).toBe(80);
  });

  it('near-LAN: RTT 1-5ms → minFrames=3', () => {
    const params = classifyNetwork(3);
    expect(params.minFrames).toBe(3);
  });

  it('metro WAN: RTT 5-50ms → minFrames=8', () => {
    const params = classifyNetwork(30);
    expect(params.minFrames).toBe(8);
  });

  it('long-haul WAN: RTT > 50ms → minFrames=12', () => {
    const params = classifyNetwork(100);
    expect(params.minFrames).toBe(12);
  });
});

describe('StartupBuffer', () => {
  it('holds frames until minFrames reached', () => {
    const buf = new StartupBuffer({ minFrames: 3, maxWaitMs: 500 });
    expect(buf.shouldDrain).toBe(false);

    buf.recordFrame(0);
    expect(buf.shouldDrain).toBe(false);

    buf.recordFrame(33);
    expect(buf.shouldDrain).toBe(false);

    buf.recordFrame(66);
    expect(buf.shouldDrain).toBe(true);
  });

  it('drains on maxWaitMs even if minFrames not reached', () => {
    const buf = new StartupBuffer({ minFrames: 10, maxWaitMs: 100 });

    buf.recordFrame(0);
    buf.recordFrame(33);
    expect(buf.shouldDrain).toBe(false);

    // Simulate time passing beyond maxWaitMs
    buf.recordFrame(110);
    expect(buf.shouldDrain).toBe(true);
  });

  it('stays drained once transitioned', () => {
    const buf = new StartupBuffer({ minFrames: 2, maxWaitMs: 500 });

    buf.recordFrame(0);
    buf.recordFrame(33);
    expect(buf.shouldDrain).toBe(true);

    // Further frames don't change state
    buf.recordFrame(66);
    expect(buf.shouldDrain).toBe(true);
  });

  it('reset returns to buffering state', () => {
    const buf = new StartupBuffer({ minFrames: 2, maxWaitMs: 500 });

    buf.recordFrame(0);
    buf.recordFrame(33);
    expect(buf.shouldDrain).toBe(true);

    buf.reset();
    expect(buf.shouldDrain).toBe(false);
  });

  it('reports frameCount and elapsedMs', () => {
    const buf = new StartupBuffer({ minFrames: 5, maxWaitMs: 500 });

    buf.recordFrame(100);
    buf.recordFrame(133);
    buf.recordFrame(166);

    expect(buf.frameCount).toBe(3);
    expect(buf.elapsedMs).toBeCloseTo(66, 0);
  });

  it('zero frames → elapsedMs is 0', () => {
    const buf = new StartupBuffer({ minFrames: 3, maxWaitMs: 500 });
    expect(buf.frameCount).toBe(0);
    expect(buf.elapsedMs).toBe(0);
  });

  it('uses accelerated EMA alpha during startup', () => {
    // The startup buffer should provide a faster alpha for the
    // adaptive controller to use during warmup
    const buf = new StartupBuffer({ minFrames: 5, maxWaitMs: 500 });
    expect(buf.warmupEmaAlpha).toBe(0.25); // 4x faster than standard 0.0625
  });
});
