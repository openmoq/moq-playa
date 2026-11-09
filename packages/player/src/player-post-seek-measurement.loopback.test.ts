import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { setup, measurements, coded, properties, PAYLOAD_BYTES } from '../test-support/post-seek-measurement.js';
beforeEach(() => vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each([18, 22] as const)('output-owned seek live measurement draft%i', draft => {
  it('ordinary accepted LOC receipts still warm rate and measure source cadence', async () => {
    const h = await setup(draft), { f } = h;
    try {
      for (let index = 0; index <= 12; index++) {
        h.advance(100_000 + index * 500_000);
        await h.sendLive(200n, BigInt(index + 1), 0n, BigInt(1000 + index * 500));
      }
      const ordinary = h.receipts.filter(({ event }) => event.origin === 'subgroup' && event.trackAlias === 200n);
      expect(ordinary).toHaveLength(13);
      expect(h.samples()).toEqual(ordinary.map(({ event, nowUs }) => [event.payloadBytes, nowUs]));
      expect(vi.mocked(f.decoder.decode).mock.calls.length).toBeGreaterThan(0);
      expect(measurements(f.player).readVideoReceivedRate()).toBeCloseTo(16, 6);
      expect(measurements(f.player).estimatedGopDurationUs).toBe(500_000);
      expect(f.errors).toEqual([]);
    } finally { await h.close(); }
  });

  it('delayed standalone historical FETCH never establishes rate or live cadence', async () => {
    // G3/Object0=1000ms, G4/Object0=2500ms: an accidentally measured
    // historical pair would be1500ms, observably different from fallback.
    const h = await setup(draft, {}, 2500n), { f } = h;
    try {
      await h.landHistory(true);
      expect(h.receipts.filter(({ event }) => event.origin === 'fetch')).toHaveLength(3);
      expect(h.decodeTimes.map(row => row.timestamp)).toContain(2_100_000);
      expect(h.decodeTimes.map(row => row.timestamp)).toContain(2_500_000);
      expect(h.samples(), 'history is excluded even though the selected owned output really consumed it').toEqual([]);
      expect(measurements(f.player).readVideoReceivedRate()).toBeNull();
      expect(measurements(f.player).estimatedGopDurationUs).toBe(2_000_000);
      expect(f.errors).toEqual([]);
    } finally { await h.close(); }
  });

  it('fresh accepted bridge payload warms selected received rate without restoring ordinary subscriptions', async () => {
    const h = await setup(draft), { f } = h;
    try {
      const bridge = await h.readyLive();
      expect(f.client.session.getSubscription(bridge.sub.id)?.trackAlias).toBe(201n);
      for (let index = 0; index <= 12; index++) {
        h.advance(600_000 + index * 500_000);
        await h.sendLive(201n, BigInt(5 + index), 0n, BigInt(3500 + index * 500));
      }
      const suffix = h.receipts.filter(({ event }) => event.origin === 'subgroup' && event.trackAlias === 201n);
      expect(suffix).toHaveLength(14); expect(suffix.every(({ event }) => event.payloadBytes === PAYLOAD_BYTES)).toBe(true);
      expect(f.outputs).toHaveLength(1); expect(f.outputs[0]!.decoder.configure).toHaveBeenCalledOnce();
      expect(h.decodeTimes.some(row => row.timestamp === 9_500_000), 'fresh Group17 decoded on the retained graph').toBe(true);
      expect(f.errors).toEqual([]);
      expect(measurements(f.player).readVideoReceivedRate(), 'accepted new bridge wire bytes must warm current received rate').toBeCloseTo(16, 2);
    } finally { await h.close(); }
  });

  it('consecutive fresh bridge Group starts replace the fallback with their actual source cadence', async () => {
    const h = await setup(draft), { f } = h;
    try {
      await h.readyLive();
      h.advance(600_000); await h.sendLive(201n, 5n, 0n, 3500n);
      expect(measurements(f.player).estimatedGopDurationUs,
        'excluded history/prefix Group4/Object0 must not anchor the first eligible Group5/Object0').toBe(2_000_000);
      h.advance(1_100_000); await h.sendLive(201n, 6n, 0n, 4000n);
      expect(h.receipts.filter(({ event }) => event.origin === 'subgroup' && event.trackAlias === 201n)
        .map(({ event }) => [event.groupId, event.objectId])).toEqual([[4n, 3n], [5n, 0n], [6n, 0n]]);
      expect(h.decodeTimes.map(row => row.timestamp)).toContain(4_000_000);
      expect(f.outputs).toHaveLength(1); expect(f.errors).toEqual([]);
      expect(measurements(f.player).estimatedGopDurationUs, 'actual same-source half-second live Group starts').toBe(500_000);
    } finally { await h.close(); }
  });

  it('JOIN/FILL held before FIN excludes prefix and retains the live wire time rather than the later consume time', async () => {
    const h = await setup(draft), { f } = h;
    try {
      const bridge = await h.beginBridge();
      expect(h.samples(), 'initial FETCH and actual accepted JOIN/FILL inputs are history').toEqual([]);
      h.advance(400_000); await h.sendLive(201n, 4n, 3n, 3300n);
      const live = h.receipts.filter(({ event }) => event.origin === 'subgroup' && event.trackAlias === 201n);
      expect(live).toHaveLength(1); expect(live[0]!.nowUs).toBe(400_000);
      expect(h.decodeTimes.some(row => row.timestamp === 3_300_000), 'prefix FIN still gates real live consumption').toBe(false);
      expect.soft(h.samples(), 'accepted live receipt must already be observed BEFORE prefix FIN, without waiting for consumeLive')
        .toEqual([[PAYLOAD_BYTES, 400_000]]);
      h.advance(1_100_000); await bridge.finish();
      const consumed = h.decodeTimes.find(row => row.timestamp === 3_300_000);
      expect(consumed, 'same raw live Object must really reach the retained output after prefix FIN').toEqual({ timestamp: 3_300_000, nowUs: 1_100_000 });
      expect(h.receipts.filter(({ event }) => event.origin === 'subgroup' && event.trackAlias === 201n)).toHaveLength(1);
      expect(f.outputs).toHaveLength(1); expect(f.errors).toEqual([]);
      expect(h.samples(), 'only the original live wire receipt, never JOIN/FILL or drain-time resampling').toEqual([[PAYLOAD_BYTES, 400_000]]);
    } finally { await h.close(); }
  });

  it('SDK-parked pre-ACK replay retains its old receipt identity and cannot become a fresh accepted-live measurement', async () => {
    const h = await setup(draft), { f } = h;
    try {
      const bridge = await h.beginBridge(async () => {
        h.advance(400_000); await h.sendLive(201n, 4n, 3n, 3300n);
        h.advance(450_000); await h.sendLive(201n, 5n, 0n, 3500n);
        h.advance(500_000); await h.sendLive(201n, 6n, 0n, 4000n);
        expect(h.rawDeliveries).toEqual([]);
        expect(h.receipts.filter(({ event }) => event.origin === 'subgroup' && event.trackAlias === 201n)).toHaveLength(3);
      });
      await vi.waitFor(() => expect(h.rawDeliveries.filter(row => row.kind === 'data')).toHaveLength(3), { timeout: 1000, interval: 5 });
      const arrivals = h.receipts.filter(({ event }) => event.origin === 'subgroup' && event.trackAlias === 201n);
      expect(arrivals.map(({ event, nowUs }) => [event.groupId, event.objectId, nowUs]))
        .toEqual([[4n, 3n, 400_000], [5n, 0n, 450_000], [6n, 0n, 500_000]]);
      for (const arrival of arrivals) {
        const replay = h.rawDeliveries.find(row => row.group === arrival.event.groupId && row.object === arrival.event.objectId)!;
        expect(replay.nowUs).toBe(800_000);
        expect(replay.receipt, 'each later callback retains its earlier opaque SDK receipt').toBe(arrival.event.receipt);
      }
      expect(h.decodeTimes.some(row => row.timestamp === 3_300_000)).toBe(false);
      h.advance(1_100_000); await bridge.finish();
      expect(h.decodeTimes.find(row => row.timestamp === 3_300_000)).toEqual({ timestamp: 3_300_000, nowUs: 1_100_000 });
      expect(h.decodeTimes.map(row => row.timestamp)).toContain(3_500_000);
      expect(h.decodeTimes.map(row => row.timestamp)).toContain(4_000_000);
      expect(h.samples(), 'ACK replay and later queue drain cannot acquire arrival eligibility retroactively').toEqual([]);
      expect(measurements(f.player).readVideoReceivedRate()).toBeNull();
      expect(measurements(f.player).estimatedGopDurationUs,
        'the excluded pre-ACK consecutive Object0 pair has500ms spacing and cannot establish cadence').toBe(2_000_000);
      expect(f.outputs).toHaveLength(1); expect(f.errors).toEqual([]);
    } finally { await h.close(); }
  });

  it('retiring the graph while live is prefix-blocked cannot publish its queued bytes into the next seek owner', async () => {
    const h = await setup(draft), { f } = h;
    try {
      const bridge = await h.beginBridge();
      h.advance(400_000); await h.sendLive(201n, 4n, 3n, 3300n);
      expect(h.receipts.filter(({ event }) => event.origin === 'subgroup' && event.trackAlias === 201n)).toHaveLength(1);
      expect(h.decodeTimes.some(row => row.timestamp === 3_300_000)).toBe(false);
      const callsAtRetirement = h.samples().length;
      await f.player.seek(2000); await flush(512);
      expect(f.fetchIds).toHaveLength(2); expect(f.fetchIds[1]).not.toBe(f.fetchIds[0]);
      // Replacement adoption, not merely seek preparation, retires the prior graph.
      await f.server.acceptFetch(f.fetchIds[1]!, { endOfTrack: 0,
        endLocation: { group: 4n, object: draft === 22 ? 0n : 1n } });
      const replacement = await f.server.openFetchStream(f.fetchIds[1]!);
      for (const [group, object, timestamp] of [[3n, 0n, 1000n], [3n, 1n, 2100n], [4n, 0n, 3000n]] as const) {
        await f.server.sendFetchObject(replacement, { groupId: group, subgroupId: 0n, objectId: object, publisherPriority: 128,
          extensions: properties(draft, object, timestamp), payload: coded(object === 0n) });
      }
      await f.server.closeFetchStream(replacement); await flush(512);
      expect(f.seeked).toHaveBeenCalledTimes(2); expect(f.outputs).toHaveLength(2);
      expect(f.outputs[0]!.decoder.destroy).toHaveBeenCalledOnce();
      // All old prefix bytes were really received before cancellation. Closing
      // the publisher stream after retirement is not another live receipt.
      h.advance(1_100_000); await bridge.finish();
      expect(h.samples().slice(callsAtRetirement)).toEqual([]);
      expect(h.decodeTimes.some(row => row.timestamp === 3_300_000)).toBe(false);
      expect(measurements(f.player).readVideoReceivedRate()).toBeNull();
      expect(measurements(f.player).estimatedGopDurationUs).toBe(2_000_000);
      expect(f.errors).toEqual([]);
    } finally { await h.close(); }
  });
});
