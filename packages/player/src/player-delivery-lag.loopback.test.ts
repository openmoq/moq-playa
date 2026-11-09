/** SDK input and controlled output witnesses; no native/network-capacity claim. */
import { describe, expect, it, vi } from 'vitest';
import { DeliveryLagDetector } from '@openmoq/playback';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { setup as seekLiveSetup } from '../test-support/post-seek-measurement.js';
import { fixture, baseline, rising, deliveries, unchanged, commitLower, refs, SOURCE_EPOCH_US, identity,
  type Delivery } from '../test-support/delivery-lag.js';

describe('LOC live-video delivery trend adaptation', () => {
  it('requests the actual lower rung on a rising trend and commits only after ACK and independent target media', async () => {
    const f = await fixture();
    try {
      await f.feed(baseline()); unchanged(f);
      expect(f.enqueued).toContain(11);
      expect(f.received[0]).toEqual({ track: refs.high.name, captureUs: SOURCE_EPOCH_US });
      await f.feed(rising());
      expect(f.lowerRequests().map(({ name, namespace }) => ({ name, namespace })), 'rising delivery lag must request the lower rung').toEqual([refs.low]);
      await commitLower(f, true);
    } finally { await f.destroy(); }
  });

  it.each(['flat', 'absorbed jitter'] as const)('holds the current rung for %s delivery', async kind => {
    const f = await fixture();
    try {
      const points = deliveries(0, 100, i => 20_000 + (kind === 'absorbed jitter' && i % 25 === 0 ? 350_000 : 0));
      await f.feed(points); unchanged(f);
      expect(f.enqueued).toContain(11); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('does not interpret a currently draining excess as a new downshift decision', async () => {
    const f = await fixture();
    try {
      await f.feed(baseline());
      // Observe the complete queued history before asking for an ABR decision.
      await f.feed(rising(), { tick: false });
      await f.feed(deliveries(90, 40, i => 1_000_000 - (i - 90) * 10_000), { tick: false });
      for (let i = 0; i < 8; i++) f.tick();
      unchanged(f); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('does not infer a trend from one high-lag sample before both windows have evidence', async () => {
    const f = await fixture();
    try {
      await f.feed(deliveries(0, 1, () => 900_000));
      unchanged(f); expect(f.enqueued).toContain(11); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it.each(['finite', 'manual', 'paused'] as const)('ignores rising delivery for a %s owner', async mode => {
    const f = await fixture({ finite: mode === 'finite', manual: mode === 'manual' });
    try {
      await f.feed(baseline());
      if (mode === 'paused') {
        await f.feed(rising(), { tick: false });
        f.player.pause();
      }
      if (mode === 'paused') f.advance(20_000);
      else await f.feed(rising());
      unchanged(f);
      expect(f.received.filter(event => event.track === refs.high.name)).toHaveLength(90);
      if (mode === 'paused') expect(f.player.state).toBe('paused');
      if (mode === 'manual') expect(f.player.selection.autoQuality).toBe(false);
      expect(f.errors).toEqual([]);
      if (mode === 'manual') {
        await f.player.selectVideoTrack(refs.low);
        expect(f.lowerRequests().map(({ name, namespace }) => ({ name, namespace }))).toEqual([refs.low]);
        await commitLower(f, false);
      }
    } finally { await f.destroy(); }
  });

  it('does not act on a queued rising history after the actual source session closes', async () => {
    const f = await fixture();
    try {
      await f.feed(baseline()); await f.feed(rising(), { tick: false });
      const switching: string[] = [];
      f.player.on('quality_switching', event => { switching.push(event.toTrackName); });
      f.wire.transport.close({ closeCode: 0, reason: 'source ended before the next policy tick' });
      await flush(512); expect(f.closed).toBe(true);
      // Closure may legitimately stop installed requests. The queued history
      // must add no adaptation or wire action AFTER that completed cleanup.
      const afterClose = { requests: structuredClone(f.wire.requests), control: structuredClone(f.wire.control),
        stopped: [...f.wire.stopped], switching: [...switching], switched: [...f.switched] };
      expect(f.lowerRequests()).toEqual([]); expect(f.switched).toEqual([]);
      f.advance(20_000); await flush(512);
      expect(f.wire.requests).toEqual(afterClose.requests); expect(f.wire.control).toEqual(afterClose.control);
      expect(f.wire.stopped).toEqual(afterClose.stopped); expect(switching).toEqual(afterClose.switching);
      expect(f.switched).toEqual(afterClose.switched); expect(f.switched).toEqual([]);
      expect(f.lowerRequests()).toEqual([]); expect(f.player.selection.video).toEqual(identity(refs.high));
      expect(f.wire.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('honors reentrant pause from the raw media event before using that receipt for adaptation', async () => {
    const f = await fixture();
    try {
      await f.feed(baseline());
      const trend = rising();
      await f.feed(trend.slice(0, -1), { tick: false });
      let paused = false;
      f.player.on('media_object', () => { if (!paused) { paused = true; f.player.pause(); } });
      await f.send(trend.at(-1)!);
      expect(paused).toBe(true); unchanged(f); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('resumes on a fresh live group without borrowing the discarded pre-pause trend', async () => {
    const f = await fixture();
    try {
      await f.feed(baseline()); await f.feed(rising(), { tick: false }); f.player.pause(); await flush(256);
      f.player.play(); await flush(256); f.newGroup();
      await f.feed(deliveries(120, 30, () => 20_000));
      unchanged(f);
      expect(f.player.selection.autoQuality).toBe(true);
      expect(f.wire.control.some(message => message.type === 'REQUEST_UPDATE')).toBe(true);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('does not borrow missing capture timestamps as lag evidence after a valid baseline', async () => {
    const f = await fixture();
    try {
      await f.feed(baseline()); await f.feed(rising(), { timestamp: false });
      unchanged(f);
      expect(f.received.filter(event => event.captureUs === undefined)).toHaveLength(50);
      expect(f.enqueued).toContain(11); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('rebases exact bigint capture differences before numeric measurement', async () => {
    const record = vi.spyOn(DeliveryLagDetector.prototype, 'record');
    const f = await fixture();
    try {
      const epoch = 2n ** 60n;
      const translated = (points: readonly Delivery[]) => points.map(point => ({
        ...point, captureUs: epoch + point.captureUs - SOURCE_EPOCH_US,
      }));
      await f.feed(translated(baseline()));
      expect(f.received[0]?.captureUs).toBe(epoch);
      expect(record.mock.calls.slice(0, 3)).toEqual([[0, 0], [40_000, 40_000], [80_000, 80_000]]);
      await f.feed(translated(rising()));
      expect(f.lowerRequests().map(({ name, namespace }) => ({ name, namespace }))).toEqual([refs.low]);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it.each([
    { before: undefined, after: undefined, requests: 1, label: 'continuous Unix domain' },
    { before: undefined, after: 1_000_000n, requests: 0, label: 'Unix to explicit microsecond media domain' },
    { before: 90_000n, after: 90_000n, requests: 1, label: 'continuous 90 kHz media domain' },
    { before: 90_000n, after: 1_000_000n, requests: 0, label: 'changed media timescale' },
  ])('uses only a continuous measurement epoch: $label', async ({ before, after, requests }) => {
    const f = await fixture();
    try {
      const prior = before === undefined ? {} : { timescale: before };
      await f.feed(baseline(), prior);
      await f.feed(rising(), { ...prior, tick: false });
      const point = deliveries(90, 1, () => 1_000_000)[0]!;
      await f.send(point, after === undefined ? {} : { timescale: after });
      expect(f.received.at(-1)?.captureUs).toBe(point.captureUs);
      expect(f.lowerRequests()).toHaveLength(requests);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('withdraws a queued trend when automatic quality is disabled and enabled again', async () => {
    const f = await fixture();
    try {
      await f.feed(baseline()); await f.feed(rising(), { tick: false });
      f.player.setAutoQuality(false); f.player.setAutoQuality(true); f.tick();
      unchanged(f); expect(f.player.selection.autoQuality).toBe(true); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });


});



describe('LOC lag consumer-admission ownership', () => {
  it('records the admission clock after a held transform, not the earlier wire receipt time', async () => {
    let release!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const record = vi.spyOn(DeliveryLagDetector.prototype, 'record');
    const f = await fixture({ objectTransform: async object => {
      if (object.kind === 'data' && object.payload[5] === 33) { entered = true; await gate; }
      return object;
    } });
    const arrivals: number[] = [];
    const stop = f.wire.client.observeObjectReceipts(event => {
      if (event.origin === 'subgroup' && event.trackAlias === 200n && event.payloadBytes > 0) arrivals.push(f.nowUs);
    });
    try {
      await f.feed(baseline());
      await f.send(rising()[0]!, { marker: 33, tick: false });
      expect(entered).toBe(true); expect(arrivals).toHaveLength(41); expect(arrivals.at(-1)).toBe(2_620_000);
      expect(f.received).toHaveLength(40); expect(f.decoded.some(frame => frame.marker === 33)).toBe(false);
      f.elapse(200_000); release(); await flush(512); f.tick(); await flush(256);
      expect(f.received).toHaveLength(41); expect(f.decoded.some(frame => frame.marker === 33)).toBe(true);
      expect(f.errors).toEqual([]); unchanged(f);
      expect(record.mock.calls.at(-1), 'source delta1600ms; actual consumer admission1800ms after first input, not wire1600ms')
        .toEqual([1_600_000, 1_800_000]);
    } finally { release(); stop(); await f.destroy(); }
  });

  it('a held input keeps its pre-transform measurement owner across an automatic-mode roundtrip', async () => {
    let release!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const record = vi.spyOn(DeliveryLagDetector.prototype, 'record');
    const f = await fixture({ objectTransform: async object => {
      if (object.kind === 'data' && object.payload[5] === 33) { entered = true; await gate; }
      return object;
    } });
    try {
      await f.feed(baseline()); const before = record.mock.calls.length;
      await f.send(rising()[0]!, { marker: 33, tick: false }); expect(entered).toBe(true);
      f.player.setAutoQuality(false); f.player.setAutoQuality(true);
      release(); await flush(512); f.tick(); await flush(256);
      expect(f.decoded.some(frame => frame.marker === 33), 'measurement retirement does not suppress legitimate playback').toBe(true);
      expect(f.player.selection.autoQuality).toBe(true); unchanged(f); expect(f.errors).toEqual([]);
      expect(record.mock.calls.slice(before), 'do not recapture a successor measurement owner after transform').toEqual([]);
    } finally { release(); await f.destroy(); }
  });

  it('collects only actual accepted seek-live LOC admissions without enabling playing frame switching', async () => {
    const record = vi.spyOn(DeliveryLagDetector.prototype, 'record');
    const h = await seekLiveSetup(18), { f } = h;
    try {
      await h.readyLive();
      h.advance(600_000); await h.sendLive(201n, 5n, 0n, 3500n);
      expect(h.receipts.filter(({ event }) => event.origin === 'subgroup' && event.trackAlias === 201n)).toHaveLength(2);
      expect(h.decodeTimes.map(row => row.timestamp)).toContain(3_500_000);
      expect(f.outputs).toHaveLength(1); expect(f.requests.filter(request => request.name === 'video')).toHaveLength(2);
      expect(f.errors).toEqual([]);
      expect(record.mock.calls, 'exclude history/JOIN and use same retained consumer source epoch')
        .toEqual([[0, 0], [200_000, 500_000]]);
    } finally { await h.close(); }
  });
});

describe('LOC collector warning and declined-attempt policy', () => {
  it('honors a logger that disables automatic quality before the request starts', async () => {
    const f = await fixture();
    try {
      await f.feed(baseline()); await f.feed(rising(), { tick: false });
      let observed = false;
      f.onWarning(message => {
        if (message.startsWith('Video delivery trend')) { observed = true; f.player.setAutoQuality(false); }
      });
      f.tick(); await flush(256);
      expect(observed).toBe(true); unchanged(f); expect(f.player.selection.autoQuality).toBe(false);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('requires fresh evidence after a logger consumes the observation window', async () => {
    const f = await fixture();
    try {
      await f.feed(baseline()); await f.feed(rising(), { tick: false });
      let observed = false;
      f.onWarning(message => {
        if (message.startsWith('Video delivery trend')) { observed = true; f.elapse(1_000_000); }
      });
      f.tick(); await flush(256);
      expect(observed).toBe(true); unchanged(f); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('rate-limits declined attempts without discarding the unchanged live source history', async () => {
    const f = await fixture({ cooldownMs: 100 });
    try {
      await f.feed(baseline()); await f.feed(rising(), { tick: false });
      let attempts = 0;
      f.player.hooks.beforeSubscribe.add(intent => {
        if (intent.trackName !== refs.low.name) return intent;
        attempts++; return null;
      });
      f.tick(); await flush(256);
      expect(attempts).toBe(1); unchanged(f);
      for (let i = 0; i < 20; i++) f.tick();
      await flush(256); expect(attempts).toBe(1); unchanged(f);
      f.advance(100_000); await flush(256);
      expect(attempts).toBe(2); unchanged(f); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});
