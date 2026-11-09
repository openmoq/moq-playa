import { describe, expect, it, vi } from 'vitest';
import { DeliveryLagDetector, type PlaybackPipeline } from '@openmoq/playback';
import type { ObjectReceipt } from '@openmoq/webtransport';
import type { MediaStageObservation } from './media-diagnostic-types.js';
import { createMediaDiagnostics } from './media-diagnostics.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { fixture, baseline, unchanged, refs } from '../test-support/delivery-lag.js';

interface LagBoundary {
  videoPipeline: Pick<PlaybackPipeline, 'pushObject'> | null;
  subscriptionManager: { readonly mediaInputGeneration: object } | null;
  recordVideoDeliveryLag(object: unknown, headers: unknown, owner: unknown, bytes: number): void;
}

describe('ordinary LOC lag admission boundaries', () => {
  it('healthy Object0 has one owned sample and decodes on the current route', async () => {
    const record = vi.spyOn(DeliveryLagDetector.prototype, 'record'), f = await fixture();
    try {
      await f.send(baseline()[0]!, { marker: 41 });
      expect(f.received).toHaveLength(1); expect(f.decoded.map(frame => frame.marker)).toContain(41);
      expect(record.mock.calls).toEqual([[0, 0]]); unchanged(f); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('Object1 in the same actual GOP retains its admission owner and contributes its timestamped lag sample', async () => {
    const record = vi.spyOn(DeliveryLagDetector.prototype, 'record'), f = await fixture();
    const wire: Array<{ group: bigint; object: bigint }> = [];
    const stop = f.wire.client.observeObjectReceipts(event => {
      if (event.origin === 'subgroup' && event.trackAlias === 200n && event.payloadBytes > 0) wire.push({ group: event.groupId, object: event.objectId });
    });
    try {
      const points = baseline(); await f.send(points[0]!, { marker: 41 }); await f.send(points[1]!, { marker: 42 });
      expect(wire).toEqual([{ group: 70n, object: 0n }, { group: 70n, object: 1n }]);
      expect(f.received).toHaveLength(2); expect(f.decoded.map(frame => frame.marker)).toEqual([41, 42]);
      unchanged(f); expect(f.errors).toEqual([]);
      expect(record.mock.calls, 'all eligible LOC frames retain the owner; Object0-only is cadence policy, not lag policy')
        .toEqual([[0, 0], [40_000, 40_000]]);
    } finally { stop(); await f.destroy(); }
  });

  it.each(['unchanged', 'pause', 'auto-off', 'auto-ABA'] as const)
  ('the actual lag-clock callback action=%s fences media by playback ownership, not automatic mode', async action => {
    const record = vi.spyOn(DeliveryLagDetector.prototype, 'record'), f = await fixture();
    const seam = f.player as unknown as LagBoundary;
    const pipeline = seam.videoPipeline!; expect(pipeline).not.toBeNull();
    const manager = seam.subscriptionManager!, generation = manager.mediaInputGeneration;
    const order: string[] = [], stages: MediaStageObservation[] = [];
    let activeLag = false, fired = 0, receipt: ObjectReceipt | undefined;
    const stopStages = f.player.observeMediaStages(event => { stages.push(event); }, { createTracker: createMediaDiagnostics });
    const stopReceipts = f.wire.client.observeObjectReceipts(event => {
      if (event.origin === 'subgroup' && event.trackAlias === 200n && event.payloadBytes > 0) receipt = event.receipt;
    });
    const originalLag = seam.recordVideoDeliveryLag.bind(seam);
    const lag = vi.spyOn(seam, 'recordVideoDeliveryLag').mockImplementation((...args) => {
      activeLag = true; order.push('lag.enter');
      try { return originalLag(...args); }
      finally { order.push('lag.exit'); activeLag = false; }
    });
    const originalPush = pipeline.pushObject.bind(pipeline);
    const push = vi.spyOn(pipeline, 'pushObject').mockImplementation((...args) => {
      if (args[0].kind === 'data' && args[0].payload[5] === 33) order.push('push.marker33');
      return originalPush(...args);
    });
    const off = f.player.on('media_object', event => {
      if (event.trackName !== refs.high.name || event.kind !== 'data' || event.payload?.[5] !== 33) return;
      order.push('media_object.marker33');
      f.nextClock(() => {
        expect(activeLag, 'the injected callback must be the new lag-admission clock, not a later policy/render read').toBe(true);
        fired++; order.push(`lag.clock.${action}`);
        if (action === 'pause') f.player.pause();
        else if (action === 'auto-off') f.player.setAutoQuality(false);
        else if (action === 'auto-ABA') { f.player.setAutoQuality(false); f.player.setAutoQuality(true); }
      });
    });
    try {
      // This is an eligible Object0 even on the broken Object0-only candidate.
      await f.send(baseline()[0]!, { marker: 33 }); await flush(512);
      expect(receipt).toBeDefined(); expect(fired).toBe(1); expect(lag).toHaveBeenCalledOnce();
      expect(order.slice(0, 4)).toEqual(['media_object.marker33', 'lag.enter', `lag.clock.${action}`, 'lag.exit']);
      const payloadPushes = push.mock.calls.filter(([object]) => object.kind === 'data' && object.payload[5] === 33);
      const dispositions = stages.filter(event => event.stage === 'discarded' && event.inputs.some(input => input === receipt));
      if (action === 'pause') {
        expect(f.player.state).toBe('paused'); expect(manager.mediaInputGeneration).not.toBe(generation);
        expect.soft(payloadPushes, 'retired input must never enter the captured pre-clock pipeline').toHaveLength(0);
        expect.soft(f.decoded.some(frame => frame.marker === 33)).toBe(false);
        expect.soft(dispositions, 'real diagnostic input receives exactly one terminal disposition').toHaveLength(1);
        expect(record).not.toHaveBeenCalled();
      } else {
        expect(f.player.state).toBe('playing'); expect(manager.mediaInputGeneration).toBe(generation);
        expect(payloadPushes).toHaveLength(1); expect(f.decoded.map(frame => frame.marker)).toEqual([33]);
        expect(dispositions).toHaveLength(0);
        expect(stages.filter(event => event.stage === 'decoded' && event.inputs.some(input => input === receipt))).toHaveLength(1);
        expect(f.player.selection.autoQuality).toBe(action !== 'auto-off');
        expect(record.mock.calls).toEqual(action === 'unchanged' ? [[0, 0]] : []);
      }
      unchanged(f); expect(f.errors).toEqual([]);
    } finally { off(); push.mockRestore(); lag.mockRestore(); stopReceipts(); stopStages(); await f.destroy(); }
  });
});
