import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { LocmafEncoder, LocmafGroupState, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { buildChunk, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { fixture, retainedHandoff, exactRetainedOutput, init } from '../test-support/seek-live-mse.js';
import type { MoqtPlayer } from './player.js';

interface Probe {
  clock: { now(): number };
  videoPayloadMeasurement: object | null;
  readVideoReceivedRate(): number | null;
  captureSeekVideoMeasurementOwner(connection: unknown, manager: unknown): unknown;
  sameVideoMeasurementOwner(a: unknown, b: unknown): boolean;
}
const internal = (player: MoqtPlayer) => player as unknown as Probe;
type Action = 'unchanged' | 'revoke-auto' | 'throw-epoch' | 'cancel-resource';
type Trace = { event: string; [key: string]: unknown };

beforeEach(() => vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function warm(draft: 18 | 22) {
  const f = await fixture(draft, true, undefined, { receiptClock: true });
  try {
    await retainedHandoff(f, false); f.complete(3); await flush(512); exactRetainedOutput(f);
    for (let index = 0; index < 13; index++) {
      f.setNow(600_000 + index * 500_000); f.advance(10 + index * 0.5); f.player.tick(); await flush(512);
      const encoder = new LocmafEncoder(), group = new LocmafGroupState();
      const chunk = buildChunk({ trackId: 1, bmdt: BigInt(12000 + index * 500),
        samples: [{ duration: 500, size: 1000, flags: SYNC_FLAGS }], mdat: new Uint8Array(1000) });
      const payload = serializeLocmafObject(encoder.encode(chunk, group, parseLocmafTrackContext(init), false, 0n));
      const stream = await f.server.openSubgroup(201n, BigInt(4 + index), 0n, { publisherPriority: 128, endOfGroup: true });
      await f.server.sendObject(stream, 0n, payload); await f.server.closeSubgroup(stream); await flush(512);
      expect(f.submissions).toHaveLength(5 + index); f.complete(4 + index); await flush(512); f.player.tick();
    }
    expect(f.nativeBytes).toHaveLength(17); expect(f.resources).toHaveLength(1); expect(f.errors).toEqual([]);
    expect(f.player.state).toBe('playing'); expect(f.player.selection.autoQuality).toBe(true);
    expect(internal(f.player).readVideoReceivedRate()).toBeGreaterThan(0);
    return f;
  } catch (error) { await f.destroy(); throw error; }
}

describe.each([18, 22] as const)('MSE warm read final accessor draft%i', draft => {
  it.each(['unchanged', 'revoke-auto', 'throw-epoch', 'cancel-resource'] as const)
  ('constant epoch accessor action=%s refuses revoked/unavailable evidence', async (action: Action) => {
    const f = await warm(draft), p = internal(f.player), resource = f.resources[0]!;
    const descriptor = Object.getOwnPropertyDescriptor(resource, 'epoch')!;
    const epoch = resource.epoch, sentinel = new Error('epoch observation unavailable');
    let active: Trace[] = [], afterClock = false, captureDepth = 0, comparisonDepth = 0;
    let finalOrdinal = 0, fireOrdinal: number | null = null, actionCount = 0;
    const originalCapture = p.captureSeekVideoMeasurementOwner.bind(p);
    const capture = vi.spyOn(p, 'captureSeekVideoMeasurementOwner').mockImplementation((connection, manager) => {
      captureDepth++; active.push({ event: 'capture.enter', afterClock });
      try { return originalCapture(connection, manager); }
      finally { active.push({ event: 'capture.exit', afterClock }); captureDepth--; }
    });
    const originalSame = p.sameVideoMeasurementOwner.bind(p);
    const same = vi.spyOn(p, 'sameVideoMeasurementOwner').mockImplementation((a, b) => {
      comparisonDepth++; active.push({ event: 'compare.enter', afterClock });
      try { return originalSame(a, b); }
      finally { active.push({ event: 'compare.exit', afterClock }); comparisonDepth--; }
    });
    const originalClock = p.clock.now.bind(p.clock);
    const clock = vi.spyOn(p.clock, 'now').mockImplementation(() => {
      const now = originalClock(); afterClock = true; active.push({ event: 'clock.return', now }); return now;
    });
    Object.defineProperty(resource, 'epoch', { configurable: true, enumerable: descriptor.enumerable === true, get: () => {
      const site = captureDepth > 0 ? 'owner-capture' : comparisonDepth > 0 ? 'final-owner-comparison' : 'outside';
      const isFinal = afterClock && site === 'final-owner-comparison';
      const ordinal = isFinal ? ++finalOrdinal : null;
      active.push({ event: 'epoch.get', afterClock, site, ordinal,
        stack: new Error().stack?.split('\n').slice(1, 7) });
      if (isFinal && fireOrdinal !== null && ordinal === fireOrdinal) {
        actionCount++; active.push({ event: 'action', action, ordinal });
        if (action === 'revoke-auto') f.player.setAutoQuality(false);
        else if (action === 'throw-epoch') throw sentinel;
        else if (action === 'cancel-resource') resource.cancel();
      }
      return epoch; // The accessor always preserves the correct epoch identity.
    } });
    const calibration: Trace[] = [], checked: Trace[] = [];
    let warmValue: number | null | undefined, returned: number | null | undefined, thrown: unknown;
    try {
      active = calibration; afterClock = false; finalOrdinal = 0;
      warmValue = p.readVideoReceivedRate(); active.push({ event: 'read.return', value: warmValue });
      expect(warmValue).toBeGreaterThan(0);
      const accesses = calibration.filter(row => row.event === 'epoch.get' && row.afterClock && row.site === 'final-owner-comparison');
      // Select from an executed, healthy trace rather than an unexplained
      // physical getter count. Each retained owner route reads epoch once;
      // the last observed final comparison access is the vulnerable b.route.
      expect(accesses.length).toBeGreaterThan(0);
      fireOrdinal = Number(accesses.at(-1)!.ordinal);
      const lastEpoch = calibration.map(row => row.event).lastIndexOf('epoch.get');
      expect(calibration[lastEpoch]).toBe(accesses.at(-1));
      expect(calibration.slice(lastEpoch + 1).map(row => row.event)).toEqual(['compare.exit', 'read.return']);
      active = checked; afterClock = false; finalOrdinal = 0;
      try { returned = p.readVideoReceivedRate(); active.push({ event: 'read.return', value: returned }); }
      catch (error) { thrown = error; active.push({ event: 'read.throw', sameSentinel: error === sentinel }); }
      expect(actionCount, 'the selected final getter really executed the requested action').toBe(1);
      if (action === 'unchanged') {
        expect(thrown).toBeUndefined(); expect(returned).toBe(warmValue);
        expect(f.player.selection.autoQuality).toBe(true); expect(p.videoPayloadMeasurement).not.toBeNull();
      } else if (action === 'throw-epoch') {
        expect.soft(thrown, 'optional MSE evidence failure must not escape the measurement read').toBeUndefined();
        expect(returned, 'unavailable epoch evidence must return unknown').toBeNull();
      } else {
        if (action === 'revoke-auto') {
          expect(f.player.selection.autoQuality).toBe(false);
          expect(p.videoPayloadMeasurement, 'public mode retirement really cleared the owned estimator').toBeNull();
          expect(resource.current).toBe(true);
        } else expect(resource.current, 'the exact existing resource was cancelled by its own accessor').toBe(false);
        expect(thrown).toBeUndefined();
        expect(returned, 'final accessor action retired the authority before the warm value could be returned').toBeNull();
      }
      expect(f.resources).toHaveLength(1); expect(f.player.state).toBe('playing'); expect(f.errors).toEqual([]);
    } finally {
      fireOrdinal = null;
      Object.defineProperty(resource, 'epoch', descriptor);
      clock.mockRestore(); same.mockRestore(); capture.mockRestore();
      await f.destroy();
    }
  });
});
