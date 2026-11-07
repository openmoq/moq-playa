/**
 * Tests for DeliveryLagDetector.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { DeliveryLagDetector } from './delivery-lag-detector.js';

const FRAME_US = 33_333;
/** Sender clock offset — the detector must only ever see its trend. */
const EPOCH_US = 1_762_000_000_000_000;

/** Deliver `count` frames from `fromFrame`, each arriving `lagAt(i)` after capture. */
function deliver(d: DeliveryLagDetector, fromFrame: number, count: number, lagAt: (i: number) => number): number {
    let arrivalUs = 0;
    for (let i = fromFrame; i < fromFrame + count; i++) {
        const captureUs = i * FRAME_US;
        arrivalUs = captureUs + lagAt(i);
        d.record(EPOCH_US + captureUs, arrivalUs);
    }
    return arrivalUs;
}

describe('DeliveryLagDetector', () => {
    it('is not congested while lag stays flat, whatever the clock offset', () => {
        const d = new DeliveryLagDetector();
        const now = deliver(d, 0, 300, () => 20_000);
        expect(d.isCongested(now)).toBe(false);
        expect(d.excessLagUs(now)).toBe(0);
    });

    it('rides out a keyframe burst that the link absorbs within the window', () => {
        const d = new DeliveryLagDetector();
        // Every 60th frame queues the next few behind it by up to 400ms.
        const now = deliver(d, 0, 600, i => 20_000 + Math.max(0, 400_000 - (i % 60) * 100_000));
        expect(d.isCongested(now)).toBe(false);
    });

    it('reports congestion when lag grows past the threshold', () => {
        const d = new DeliveryLagDetector();
        deliver(d, 0, 150, () => 20_000);
        // Link at 2/3 of the stream rate: lag grows half a second per second.
        const now = deliver(d, 150, 60, i => 20_000 + (i - 150) * FRAME_US / 2);
        expect(d.excessLagUs(now)!).toBeGreaterThan(300_000);
        expect(d.isCongested(now)).toBe(true);
    });

    it('does not report a draining queue as congestion', () => {
        const d = new DeliveryLagDetector();
        deliver(d, 0, 150, () => 20_000);
        deliver(d, 150, 60, i => 20_000 + (i - 150) * FRAME_US / 2);
        // After a downshift the backlog drains: still far above baseline, shrinking.
        const now = deliver(d, 210, 30, i => 1_000_000 - (i - 210) * 10_000);
        expect(d.excessLagUs(now)!).toBeGreaterThan(300_000);
        expect(d.isCongested(now)).toBe(false);
    });

    it('resets on a backwards capture discontinuity instead of reading it as lag', () => {
        const d = new DeliveryLagDetector();
        deliver(d, 0, 300, () => 20_000);
        // Publisher restarts its timeline: captures jump back 9s, arrivals keep going.
        let now = 0;
        for (let i = 0; i < 30; i++) {
            now = 300 * FRAME_US + i * FRAME_US + 20_000;
            d.record(EPOCH_US + i * FRAME_US, now);
        }
        expect(d.isCongested(now)).toBe(false);
        expect(d.excessLagUs(now)).toBe(0);
    });

    it('has no opinion when nothing arrived in the last window', () => {
        const d = new DeliveryLagDetector();
        const last = deliver(d, 0, 300, () => 20_000);
        expect(d.excessLagUs(last + 2_000_000)).toBeNull();
        expect(d.isCongested(last + 2_000_000)).toBe(false);
    });
});
