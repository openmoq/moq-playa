import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { locSeekFixture as fixture } from '../test-support/loc-seek.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { LocmafEncoder, LocmafGroupState, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { buildChunk, videoInit, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { concat } from '../../locmaf/test-support/bytes.js';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { audioInit } from '../../locmaf/test-support/cmaf.js';

beforeEach(() => vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const idr = Uint8Array.of(0, 0, 0, 2, 0x65, 0x88), dependent = Uint8Array.of(0, 0, 0, 2, 0x41, 0x88);
function history(raw = false, header = false) {
  const context = parseLocmafTrackContext(videoInit()), encoder = new LocmafEncoder(), state = new LocmafGroupState();
  const first = buildChunk({ bmdt: 90000n, samples: [
    { duration: 9000, size: 6, flags: SYNC_FLAGS, cto: 0 },
    { duration: 9000, size: 6, flags: NON_SYNC_FLAGS, cto: 108000 },
    { duration: 9000, size: 6, flags: NON_SYNC_FLAGS, cto: 81000 },
  ], mdat: concat(idr, dependent, dependent) });
  const last = buildChunk({ bmdt: 117000n, samples: [{ duration: 9000, size: 6, flags: NON_SYNC_FLAGS, cto: 108000 }], mdat: dependent });
  if (raw) return [serializeLocmafObject({ kind: 'rawBoxes', boxes: concat(...(header ? [videoInit()] : []), first, last) })];
  return [first, last].map((chunk, index) => {
    const object = encoder.encode(chunk, state, context, false, BigInt(index));
    expect(object.kind).toBe('moof');
    if (object.kind === 'moof') expect(object.header.full).toBe(index === 0);
    return serializeLocmafObject(object);
  });
}
async function sendHistory(f: Awaited<ReturnType<typeof fixture>>, packets: readonly Uint8Array[], lateOk = false) {
  const id = f.fetchIds[0]!;
  const accept = () => f.server.acceptFetch(id, { endOfTrack: 1, endLocation: { group: 3n,
    object: BigInt(packets.length - (f.draft === 22 ? 1 : 0)) } });
  if (!lateOk) await accept();
  const stream = await f.server.openFetchStream(id);
  for (const [index, payload] of packets.entries()) await f.server.sendFetchObject(stream, {
    groupId: 3n, subgroupId: 0n, objectId: BigInt(index), publisherPriority: 128, payload,
  });
  await f.server.closeFetchStream(stream); await flush(256);
  if (lateOk) { expect(f.seeked).not.toHaveBeenCalled(); await accept(); }
  await flush(512);
}

describe.each([18, 22] as const)('LOCMAF historical sample output draft%i', draft => {
  it('does not publish requested time after valid startup without historical or output evidence', async () => {
    const f = await fixture(draft, false, true, { frameVideo: true, producingOutput: true, reorderVideoOutput: true });
    try {
      const stream = await f.server.openSubgroup(200n, 9n, 0n, { publisherPriority: 128, endOfGroup: true });
      await f.server.sendObject(stream, 0n, history()[0]!); await f.server.closeSubgroup(stream); await flush(512);
      f.advance(1000000); await flush(128);
      expect(f.decoder.decode).toHaveBeenCalled(); expect(f.errors).toEqual([]);
      await f.player.seek(2000);
      expect(f.seeked, 'Requested time is not output-driven positioning evidence').not.toHaveBeenCalled();
      await flush(128); expect(f.fetchIds).toHaveLength(1);
      expect(f.outputs[0]!.draw).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
  it.each([false, true])('selects by actual first-sample index and produced B-frame PTS; raw=%s', async raw => {
    const f = await fixture(draft, false, true, { frameVideo: true, producingOutput: true, reorderVideoOutput: true });
    try {
      await f.player.seek(2000); await flush(128); expect(f.seeked).not.toHaveBeenCalled();
      await sendHistory(f, history(raw, raw), true);
      f.advance(100000); await flush(128);
      expect(f.errors).toEqual([]); expect(f.update).not.toHaveBeenCalled();
      expect(f.outputs[0]!.decoder.decode).toHaveBeenCalledTimes(4);
      expect(vi.mocked(f.outputs[0]!.decoder.decode).mock.calls.map(([chunk]) => chunk.timestamp)).toEqual([1000000, 2300000, 2100000, 2500000]);
      expect(f.outputs[0]!.frames.map(frame => frame.timestamp)).toEqual([1000000, 2100000, 2300000, 2500000]);
      expect(f.outputs[0]!.draw).toHaveBeenCalledOnce();
      expect(f.seeked).toHaveBeenCalledExactlyOnceWith({ type: 'seeked', actualTimeMs: 2100, groupId: 3, objectId: 0 });
      expect(f.player.playbackPositionMs).toBe(2100);
    } finally { await f.destroy(); }
  });
  it('keeps Header-only Object zero in ordered replay while anchoring the first media Object', async () => {
    const f = await fixture(draft, false, true, { frameVideo: true, producingOutput: true, reorderVideoOutput: true,
      timeline: [[1000, [3, 1], 0], [3000, [4, 0], 0]] });
    try {
      await f.player.seek(2000); await flush(128);
      await sendHistory(f, [serializeLocmafObject({ kind: 'rawBoxes', boxes: videoInit() }), ...history()]);
      f.advance(100000); await flush(128);
      expect(f.errors).toEqual([]); expect(f.outputs[0]!.decoder.decode).toHaveBeenCalledTimes(4);
      expect(f.outputs[0]!.draw).toHaveBeenCalledOnce();
      expect(f.seeked).toHaveBeenCalledExactlyOnceWith({ type: 'seeked', actualTimeMs: 2100, groupId: 3, objectId: 1 });
    } finally { await f.destroy(); }
  });
  it('finishes after the final produced picture without live-edge recovery through the grace period', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = await fixture(draft, false, true, { frameVideo: true, producingOutput: true, reorderVideoOutput: true });
    const ended = vi.fn(), recovery = vi.fn(); f.player.on('track_ended', ended); f.player.on('recovery_action', recovery);
    try {
      await f.player.seek(2000); await flush(128); await sendHistory(f, history());
      f.advance(100000); await flush(128); expect(f.player.playbackPositionMs).toBe(2100);
      expect(ended).not.toHaveBeenCalled();
      f.advance(300000); await flush(128); expect(f.player.playbackPositionMs).toBe(2300);
      f.advance(500000); await flush(256); f.player.tick(); await flush(128);
      expect(f.player.playbackPositionMs).toBe(2500);
      expect(ended).toHaveBeenCalledExactlyOnceWith({ type: 'track_ended', mediaType: 'video' });
      await vi.advanceTimersByTimeAsync(1500); f.advance(2000000); await flush(128);
      expect(ended).toHaveBeenCalledTimes(1); expect(recovery).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
  it.each([
    { frameVideo: true, frameAudio: false, first: 'video' }, { frameVideo: true, frameAudio: false, first: 'audio' },
    { frameVideo: false, frameAudio: true, first: 'video' }, { frameVideo: false, frameAudio: true, first: 'audio' },
  ] as const)('adopts both selected roles together with mixed packaging: $frameVideo/$frameAudio, $first first', async options => {
    const f = await fixture(draft, true, true, { ...options, producingOutput: true, reorderVideoOutput: true });
    const send = async (role: 'video' | 'audio') => {
      const index = f.fetches.findIndex(request => request.name === role), id = f.fetchIds[index]!;
      let packets: Array<{ payload: Uint8Array; extensions?: Uint8Array }>;
      if (role === 'video' && options.frameVideo) packets = history().map(payload => ({ payload }));
      else if (role === 'audio' && options.frameAudio) {
        const context = parseLocmafTrackContext(audioInit()), media = buildChunk({ trackId: context.trackId, bmdt: 48000n,
          samples: [{ duration: 52800, size: 2, flags: SYNC_FLAGS }, { duration: 9600, size: 2, flags: SYNC_FLAGS },
            { duration: 9600, size: 2, flags: SYNC_FLAGS }], mdat: Uint8Array.of(1, 2, 3, 4, 5, 6) });
        packets = [{ payload: serializeLocmafObject(new LocmafEncoder().encode(media, new LocmafGroupState(), context, false, 0n)) }];
      } else packets = [1000n, 2100n, 2300n].map((timestamp, index) => {
        const extensions = encodeLocHeaders({ timestamp, timescale: 1000n,
          ...(role === 'video' ? { videoFrameMarking: { independent: index === 0, startOfFrame: true, endOfFrame: true,
            discardable: false, baseLayerSync: false, temporalId: 0 } } : {}) }, { locVersion: 4, wireProfile: locWireProfileForDraft(draft) });
        if (extensions === undefined) throw new Error('LOC control needs actual timestamp properties');
        return { payload: role === 'video' ? index === 0 ? idr : dependent : Uint8Array.of(0xf8, 0xff, 0xfe), extensions };
      });
      await f.server.acceptFetch(id, { endOfTrack: 1, endLocation: { group: 3n, object: BigInt(packets.length - (draft === 22 ? 1 : 0)) } });
      const stream = await f.server.openFetchStream(id);
      for (const [index, packet] of packets.entries()) await f.server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n,
        objectId: BigInt(index), publisherPriority: 128, ...packet });
      await f.server.closeFetchStream(stream); await flush(512);
    };
    try {
      await f.player.seek(2000); await flush(128); expect(f.fetchIds).toHaveLength(2);
      await send(options.first); expect(f.seeked).not.toHaveBeenCalled(); expect(f.decoder.reset).not.toHaveBeenCalled();
      await send(options.first === 'video' ? 'audio' : 'video'); f.advance(100000); await flush(256);
      expect(f.errors).toEqual([]); expect(f.seeked).toHaveBeenCalledOnce();
      expect(f.seeked.mock.calls[0]![0].actualTimeMs).toBe(2100);
      expect(f.outputs[0]!.draw).toHaveBeenCalledOnce(); expect(f.audioOutputs[0]!.output.schedule).toHaveBeenCalled();
      expect(f.update).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });
});
