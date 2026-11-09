import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { locSeekFixture } from '../test-support/loc-seek.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { LocmafEncoder, LocmafGroupState, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { buildChunk, videoInit, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { concat } from '../../locmaf/test-support/bytes.js';

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} }); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const idr = Uint8Array.of(0, 0, 0, 2, 0x65, 0x88), delta = Uint8Array.of(0, 0, 0, 2, 0x41, 0x88);
function packet(count: number) {
  const chunk = buildChunk({ bmdt: 90000n, samples: Array.from({ length: count }, (_, i) => ({ duration: 9000,
    size: 6, flags: i === 0 ? SYNC_FLAGS : NON_SYNC_FLAGS })), mdat: concat(...Array.from({ length: count }, (_, i) => i === 0 ? idr : delta)) });
  return serializeLocmafObject(new LocmafEncoder().encode(chunk, new LocmafGroupState(), parseLocmafTrackContext(videoInit()), false, 0n));
}
async function send(f: Awaited<ReturnType<typeof locSeekFixture>>, count = 12) {
  const id = f.fetchIds[0]!;
  await f.server.acceptFetch(id, { endOfTrack: 1, endLocation: { group: 3n, object: 1n } });
  const stream = await f.server.openFetchStream(id);
  await f.server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: 0n, publisherPriority: 128, payload: packet(count) });
  await f.server.closeFetchStream(stream); await flush(1024);
}
// Read-only resource-boundary observation; it neither wakes nor changes the actor.
function pressureTimer(player: object): unknown {
  const attempt: unknown = Reflect.get(player, 'activeLocSeek') ?? Reflect.get(player, 'preparingLocSeek');
  if (!attempt || typeof attempt !== 'object') throw new Error('Expected an owned LOC attempt');
  const actor: unknown = Reflect.get(attempt, 'playback');
  if (!actor || typeof actor !== 'object') throw new Error('Expected LOC actor');
  return Reflect.get(actor, 'pressureTimer');
}

describe('LOCMAF pressure wakeup ownership', () => {
  it('uses queue observation to reach flush and actual seek without a fallback timer', async () => {
    const f = await locSeekFixture(18, false, true, { frameVideo: true, producingOutput: true });
    const listeners = new Set<() => void>(), off = vi.fn();
    f.decoder.observeQueueDepth = notify => { listeners.add(notify); return () => { listeners.delete(notify); off(); }; };
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      await f.player.seek(2000); await flush(128);
      const decoder = f.outputs[0]!.decoder, emit = decoder.decode;
      let depth = 0;
      const pending: Array<() => void> = [];
      decoder.decode = vi.fn((chunk, time, input, context) => {
        depth++; pending.push(() => emit.call(decoder, chunk, time, input, context));
        queueMicrotask(() => { depth = 0; });
      });
      Object.defineProperty(decoder, 'queueDepth', { get: () => depth });
      const nativeFlush = vi.fn(async () => { for (const emit of pending.splice(0)) emit(); }); decoder.flush = nativeFlush;
      await send(f);
      expect(depth).toBe(0); expect(decoder.decode).toHaveBeenCalledTimes(8); expect(nativeFlush).not.toHaveBeenCalled();
      expect(pressureTimer(f.player)).toBeNull();
      expect(timers.mock.calls.filter(([, delay]) => delay === 10)).toHaveLength(0);
      expect(listeners.size).toBe(1); for (const notify of listeners) notify(); await flush(1024);
      expect(decoder.decode).toHaveBeenCalledTimes(12); expect(nativeFlush).toHaveBeenCalled();
      f.advance(100000); await flush(128); expect(f.seeked).toHaveBeenCalledOnce();
      expect(f.seeked.mock.calls[0]![0].actualTimeMs).toBe(2000); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
    expect(listeners.size).toBe(0); expect(off).toHaveBeenCalledOnce();
  });

  it('keeps one high-pressure legacy timer across ticks and clears it on cancellation', async () => {
    const f = await locSeekFixture(18, false, true, { frameVideo: true, producingOutput: true });
    const timers = vi.spyOn(globalThis, 'setTimeout'), clear = vi.spyOn(globalThis, 'clearTimeout');
    let destroyed = false;
    try {
      await f.player.seek(2000); await flush(128);
      const decoder = f.outputs[0]!.decoder;
      let depth = 0;
      Object.defineProperty(decoder, 'queueDepth', { get: () => depth });
      decoder.decode = vi.fn(() => { depth++; });
      const nativeFlush = vi.fn(async () => {}); decoder.flush = nativeFlush;
      await send(f);
      expect(decoder.decode).toHaveBeenCalledTimes(8);
      const timer = pressureTimer(f.player); expect(timer).not.toBeNull();
      const scheduled = timers.mock.calls.filter(([, delay]) => delay === 10).length; expect(scheduled).toBe(1);
      f.player.tick(); f.player.tick(); f.player.tick(); await flush(128);
      expect(pressureTimer(f.player)).toBe(timer);
      expect(timers.mock.calls.filter(([, delay]) => delay === 10)).toHaveLength(scheduled);
      await f.destroy(); destroyed = true;
      expect(clear).toHaveBeenCalledWith(timer);
      await vi.advanceTimersByTimeAsync(100); await flush(128);
      expect(decoder.decode).toHaveBeenCalledTimes(8); expect(nativeFlush).not.toHaveBeenCalled();
      expect(f.seeked).not.toHaveBeenCalled();
    } finally { if (!destroyed) await f.destroy(); }
  });

  it('does not poll an adopted paused preview while its future frames remain held', async () => {
    const f = await locSeekFixture(18, false, true, { frameVideo: true, producingOutput: true });
    f.player.pause();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      await f.player.seek(2000); await flush(128); await send(f, 24);
      f.advance(100000); await flush(128);
      expect(f.seeked).toHaveBeenCalledOnce(); expect(f.seeked.mock.calls[0]![0].actualTimeMs).toBe(2000);
      expect(f.outputs[0]!.draw).toHaveBeenCalledOnce();
      expect(vi.mocked(f.outputs[0]!.decoder.decode).mock.calls.length).toBeLessThan(24);
      expect(pressureTimer(f.player)).toBeNull();
      expect(timers.mock.calls.filter(([, delay]) => delay === 10)).toHaveLength(0);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});
