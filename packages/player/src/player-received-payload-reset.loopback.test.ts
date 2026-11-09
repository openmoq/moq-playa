import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MoqtPlayer } from '@openmoq/player';
import { serializeLocmafObject, type LocmafTrackDecoder } from '@openmoq/locmaf';
import type { SubscriptionManager } from './subscription-manager.js';
import type { LivenessTrack } from './media-liveness.js';
import { videoInit } from '../../locmaf/test-support/cmaf.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { fixture, readRate } from '../test-support/received-payload-fixture.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
type ResetOwner = {
  subscriptionManager: SubscriptionManager;
  locmafDecoders: Map<string, LocmafTrackDecoder>;
  mediaKey(name: string, role: string, alias: bigint): string;
  flushForLivenessRestart(track: LivenessTrack): void;
  cmafHoldingForAttach: boolean;
  videoPayloadMeasurement: object | null;
};
const ownerOf = (player: MoqtPlayer) => player as unknown as ResetOwner;
async function warm() {
  const f = await fixture('locmaf');
  try {
    await f.accept();
    for (let index = 0; index < 251; index++) {
      f.setNow(1_000_000 + index * 40_000); await f.send(index, 20_000); f.player.tick();
    }
    expect(readRate(f.player)).toBeCloseTo(4000, 1);
    expect(f.receipts).toHaveLength(251); expect(f.appended).toHaveLength(251);
    const owner = ownerOf(f.player), key = owner.mediaKey('v', 'video', 77n), decoder = owner.locmafDecoders.get(key);
    expect(decoder?.getLastObjectId(11n), 'actual LOCMAF consumer seeded by real wire payload').toBe(0n);
    if (!decoder) throw new Error('Expected real decoder after warmup');
    const generation = owner.subscriptionManager.mediaInputGeneration;
    return { ...f, owner, decoder, key, generation,
      track: { requestId: f.requests[0]!, trackAlias: 77n, mediaType: 'video' as const, trackName: 'v' } };
  } catch (error) { await f.close(); throw error; }
}

it.each(['direct', 'clock-read', 'clock-receipt'] as const)('same-object LOCMAF/MSE liveness retires rate without manager replacement: %s', async mode => {
  const f = await warm();
  try {
    const reset = () => f.owner.flushForLivenessRestart(f.track);
    if (mode === 'direct') reset();
    else if (mode === 'clock-read') {
      f.setClockHook(reset);
      expect(readRate(f.player), 'read captured before clock callback cannot return its retired warm state').toBeNull();
    } else {
      f.setClockHook(reset); f.setNow(11_040_000); await f.send(251, 20_000);
      expect(f.receipts).toHaveLength(252);
    }
    expect(f.owner.subscriptionManager.mediaInputGeneration, 'MSE early-return branch genuinely retains generation').toBe(f.generation);
    expect(f.owner.locmafDecoders.get(f.key), 'reset actually retained the same decoder object').toBe(f.decoder);
    expect(f.decoder.getLastObjectId(11n)).toBe(mode === 'clock-receipt' ? 1n : undefined);
    expect(f.owner.videoPayloadMeasurement, 'in-flight receipt cannot seed the retired measurement after same-object reset').toBeNull();
    expect(readRate(f.player)).toBeNull(); expect(f.errors).toEqual([]); expect(f.transportErrors).toEqual([]);
  } finally { await f.close(); }
});

it('real held-attach reset retires measurement before calling actual assembler reset', async () => {
  const f = await warm();
  const assembler = f.assembler(), originalReset = assembler.reset.bind(assembler);
  const observations: Array<number | null> = [];
  const reset = vi.spyOn(assembler, 'reset').mockImplementation((...args) => {
    observations.push(readRate(f.player)); originalReset(...args);
  });
  try {
    f.setAttached(false); f.setNow(11_040_000); await f.send(251, 20_000);
    expect(f.owner.cmafHoldingForAttach, 'actual wire media encountered public attached=false').toBe(true);
    expect(f.appended).toHaveLength(251);
    f.setAttached(true); expect(f.source.onAttached).toBeTypeOf('function'); f.source.onAttached?.();
    expect(reset).toHaveBeenCalledOnce(); expect(observations).toEqual([null]);
    expect(f.owner.cmafHoldingForAttach).toBe(false);
    expect(f.owner.subscriptionManager.mediaInputGeneration).toBe(f.generation);
    expect(f.owner.locmafDecoders.get(f.key)).toBe(f.decoder);
    expect(f.decoder.getLastObjectId(11n)).toBeUndefined(); expect(readRate(f.player)).toBeNull();
    expect(f.errors).toEqual([]); expect(f.transportErrors).toEqual([]);
  } finally { reset.mockRestore(); await f.close(); }
});

it('an ordinary attach notification without held media preserves the warm rate', async () => {
  const f = await warm();
  try {
    expect(f.owner.cmafHoldingForAttach).toBe(false); f.source.onAttached?.();
    expect(f.owner.locmafDecoders.get(f.key)).toBe(f.decoder);
    expect(f.owner.subscriptionManager.mediaInputGeneration).toBe(f.generation);
    expect(readRate(f.player)).toBeCloseTo(4000, 1); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

it('byte-identical in-band Header preserves the actual decoder/configuration and warm rate', async () => {
  const f = await warm();
  try {
    const beforeMeasurement = f.owner.videoPayloadMeasurement;
    // Same receipt instant: test lifetime preservation without closing a different-rate interval.
    f.setNow(11_000_000);
    const stream = await f.server.openSubgroup(77n, 12n, 0n, { publisherPriority: 128 });
    await f.server.sendObject(stream, 0n, serializeLocmafObject({ kind: 'rawBoxes', boxes: videoInit() }));
    await f.server.closeSubgroup(stream); await flush(128);
    expect(f.receipts).toHaveLength(252); expect(f.owner.locmafDecoders.get(f.key)).toBe(f.decoder);
    expect(f.owner.videoPayloadMeasurement).toBe(beforeMeasurement);
    expect(f.decoder.getLastObjectId(11n)).toBe(0n); expect(readRate(f.player)).toBeCloseTo(4000, 1);
    expect(f.errors).toEqual([]); expect(f.transportErrors).toEqual([]);
  } finally { await f.close(); }
});
