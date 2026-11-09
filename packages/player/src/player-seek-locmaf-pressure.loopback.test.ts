import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { locSeekFixture } from '../test-support/loc-seek.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { LocmafEncoder, LocmafGroupState, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { buildChunk, videoInit, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { concat } from '../../locmaf/test-support/bytes.js';

beforeEach(() => vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const idr = Uint8Array.of(0, 0, 0, 2, 0x65, 0x88), delta = Uint8Array.of(0, 0, 0, 2, 0x41, 0x88);
const count = 12;
function packet() {
  const chunk = buildChunk({ bmdt: 90000n, samples: Array.from({ length: count }, (_, i) => ({ duration: 9000,
    size: 6, flags: i === 0 ? SYNC_FLAGS : NON_SYNC_FLAGS })), mdat: concat(...Array.from({ length: count }, (_, i) => i === 0 ? idr : delta)) });
  return serializeLocmafObject(new LocmafEncoder().encode(chunk, new LocmafGroupState(), parseLocmafTrackContext(videoInit()), false, 0n));
}

describe('LOCMAF pre-adoption native queue drain', () => {
  it.each([false, true])('finishes after a legacy queue drains independently of output: early output=%s', async earlyOutput => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = await locSeekFixture(18, false, true, { frameVideo: true, producingOutput: true });
    try {
      await f.player.seek(2000); await flush(128);
      const decoder = f.outputs[0]!.decoder, emit = decoder.decode;
      let depth = 0;
      const pending: Array<() => void> = [];
      const emitAll = () => { for (const run of pending.splice(0)) run(); };
      Object.defineProperty(decoder, 'queueDepth', { configurable: true, get: () => depth });
      decoder.decode = vi.fn((chunk, time, input, context) => {
        ++depth; pending.push(() => emit.call(decoder, chunk, time, input, context));
        queueMicrotask(() => { depth = 0; if (earlyOutput && pending.length >= 8) emitAll(); });
      });
      const nativeFlush = vi.fn(async () => { emitAll(); }); decoder.flush = nativeFlush;
      const id = f.fetchIds[0]!;
      await f.server.acceptFetch(id, { endOfTrack: 1, endLocation: { group: 3n, object: 1n } });
      const stream = await f.server.openFetchStream(id);
      await f.server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: 0n, publisherPriority: 128, payload: packet() });
      await f.server.closeFetchStream(stream); await flush(1024);
      await vi.advanceTimersByTimeAsync(10); await flush(1024);
      expect(f.errors).toEqual([]);
      expect(depth, 'actual native input queue has drained independently of output').toBe(0);
      expect(decoder.decode, 'all bounded samples must reach the decoder before terminal flush').toHaveBeenCalledTimes(count);
      expect(nativeFlush).toHaveBeenCalled();
      f.advance(100000); await flush(256);
      expect(f.seeked).toHaveBeenCalledOnce();
      expect(f.seeked.mock.calls[0]![0].actualTimeMs).toBe(2000);
    } finally { await f.destroy(); }
  });
});
