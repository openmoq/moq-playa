import { expect, it, vi } from 'vitest';
import type { LocmafFrameHeader, LocmafFrameReader, LocmafTrackDecoder } from '@openmoq/locmaf';
import { serializeLocmafObject } from '@openmoq/locmaf';
import { varint } from '@openmoq/transport';
import type { MoqtPlayer } from './player.js';
import type { LivenessTrack } from './media-liveness.js';
import type { PlaybackPipeline, PlaybackSample } from '@openmoq/playback';
import type { MoqtObject } from '@openmoq/transport';
import type { LocHeaders } from '@openmoq/loc';
import type { SubscriptionManager } from './subscription-manager.js';
import { buildInit, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { fixture, sequence } from '../test-support/locmaf-replay.js';

type Owner = {
  mediaKey(name: string, role: string, alias: bigint): string;
  locmafDecoders: Map<string, LocmafTrackDecoder>;
  locmafFrameReaders: Map<string, {reader: LocmafFrameReader; header: LocmafFrameHeader | null}>;
  subscriptionManager: SubscriptionManager;
  videoPipeline: PlaybackPipeline;
  noteLocmafInBandHeader(name: string, bytes: Uint8Array, alias: bigint): void;
  flushForLivenessRestart(track: LivenessTrack): void;
  routeLocmafFrame(media: 'video' | 'audio', name: string, object: MoqtObject, headers: LocHeaders,
    input?: object, delivery?: object, samples?: readonly PlaybackSample[]): void;
};
const ownerOf = (p: MoqtPlayer) => p as unknown as Owner;
const changedHeader = () => buildInit({ trackId: 11, timescale: 180000, handler: 'vide', trex: { duration: 3000, flags: SYNC_FLAGS } });
function readerOf(owner: Owner) {
  const key = owner.mediaKey('shared', 'video', 200n), state = owner.locmafFrameReaders.get(key);
  expect(state?.reader.retainedUsage.groups, 'real wire input must seed one bounded Group').toBe(1);
  if (!state) throw new Error('Expected frame reader');
  return { key, state };
}

it('scoped Header replacement during a loopback media_object callback retires the triggering frame input', async () => {
  const h = await fixture(true), owner = ownerOf(h.player), routed = vi.spyOn(owner, 'routeLocmafFrame');
  try {
    const full = sequence('video')[0]!; await h.send('video', 0n, full.payload, 1n);
    const {key, state} = readerOf(owner), retired = vi.spyOn(state.reader, 'retire');
    const generation = owner.subscriptionManager.mediaInputGeneration;
    let resetObserved = false;
    h.player.on('media_object', event => {
      if (event.mediaType === 'video' && event.groupId === 2n && !resetObserved) {
        owner.noteLocmafInBandHeader('shared', changedHeader(), 200n);
        resetObserved = !owner.locmafFrameReaders.has(key);
      }
    });
    routed.mockClear(); await h.send('video', 0n, full.payload, 2n);
    expect(resetObserved).toBe(true); expect(retired).toHaveBeenCalledOnce();
    expect(owner.subscriptionManager.mediaInputGeneration).toBe(generation);
    expect(owner.locmafFrameReaders.has(key)).toBe(false);
    expect(routed).not.toHaveBeenCalled(); expect(h.errors).toEqual([]);
  } finally { routed.mockRestore(); await h.destroy(); }
});

it('frame reset floor rejects a stale Group before bounded reconstruction while currentGroupId is -1', async () => {
  const h = await fixture(true), owner = ownerOf(h.player);
  try {
    const full = sequence('video')[0]!; await h.send('video', 0n, full.payload, 1n);
    const {state} = readerOf(owner), push = vi.spyOn(state.reader, 'push'), pipeline = owner.videoPipeline;
    pipeline.reset(10n); expect(pipeline.currentGroupId).toBe(-1n);
    pipeline.pushObject({ kind: 'data', trackAlias: varint(200n), groupId: varint(9n), subgroupId: varint(0n),
      objectId: varint(0n), publisherPriority: 128, payload: Uint8Array.of(5, 2, 3, 0) });
    expect(pipeline.bufferedGroupCount).toBe(0);
    await h.send('video', 0n, full.payload, 9n);
    expect(push).not.toHaveBeenCalled(); expect(pipeline.bufferedGroupCount).toBe(0);
    await h.send('video', 0n, full.payload, 10n);
    expect(push).toHaveBeenCalledExactlyOnceWith(10n, 0n, full.payload);
    expect(push.mock.results[0]).toMatchObject({ type: 'return', value: {kind: 'batch', location: {groupId: 10n, objectId: 0n}} });
    expect(pipeline.bufferedGroupCount).toBe(1); expect(h.errors).toEqual([]);
  } finally { await h.destroy(); }
});

it('frame reset floor prevents a stale rawBoxes Header from replacing the current reader', async () => {
  const h = await fixture(true), owner = ownerOf(h.player);
  try {
    await h.send('video', 0n, sequence('video')[0]!.payload, 10n);
    const {key,state} = readerOf(owner), push = vi.spyOn(state.reader, 'push');
    const header = state.reader.snapshotInitialization(); owner.videoPipeline.reset(10n);
    expect(owner.videoPipeline.currentGroupId).toBe(-1n);
    await h.send('video', 0n, serializeLocmafObject({ kind: 'rawBoxes', boxes: changedHeader() }), 9n);
    expect(push).not.toHaveBeenCalled(); expect(owner.locmafFrameReaders.get(key)).toBe(state);
    expect(state.reader.snapshotInitialization()).toEqual(header); expect(h.errors).toEqual([]);
  } finally { await h.destroy(); }
});

it('rawBoxes reset preserves its wire initiator and retires older same-group transformed work', async () => {
  const h = await fixture(true), owner = ownerOf(h.player), routed = vi.spyOn(owner, 'routeLocmafFrame');
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const objects = sequence('video'); await h.send('video', 0n, objects[0]!.payload);
    const {state} = readerOf(owner), push = vi.spyOn(state.reader, 'push'), second = await h.registerSecondAlias();
    let held = false;
    owner.subscriptionManager.objectTransform = async object => {
      if (object.trackAlias === 202n) { held = true; await gate; } return object;
    };
    await second(1n, objects[1]!.payload); expect(held).toBe(true); routed.mockClear();
    const raw = serializeLocmafObject({kind: 'rawBoxes', boxes: objects[1]!.bytes});
    await h.send('video', 2n, raw);
    expect(push).toHaveBeenCalledExactlyOnceWith(1n, 2n, raw);
    expect(push.mock.results[0]).toMatchObject({type: 'return',value: {kind: 'batch',location: {groupId: 1n,objectId: 2n}}});
    expect(routed).toHaveBeenCalledOnce();
    expect(routed.mock.calls[0]?.[2]).toMatchObject({objectId: 2n,trackAlias: 200n,payload: raw});
    expect(routed.mock.calls[0]?.[6]).toHaveLength(1);
    release(); await flush(256); owner.subscriptionManager.objectTransform = null;
    expect(routed).toHaveBeenCalledOnce(); expect(push).toHaveBeenCalledOnce(); expect(h.errors).toEqual([]);
  } finally { release(); owner.subscriptionManager.objectTransform = null; routed.mockRestore(); await h.destroy(); }
});

it.each([true, false])('liveness reset retires the actual namespace consumer and its shared-alias held work (earlier same-name CMAF entry=%s)', async collision => {
  const h = await fixture(false, collision, true), owner = ownerOf(h.player);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const full = sequence('video')[0]!;
    await h.send('video', 0n, full.payload);
    const second = await h.registerSecondAlias();
    const key = owner.mediaKey('shared', 'video', 200n), decoder = owner.locmafDecoders.get(key)!;
    expect(owner.mediaKey('shared', 'video', 202n), 'premise: second real subscription resolves to the SAME consumer').toBe(key);
    expect(decoder.getLastObjectId(1n)).toBe(0n);
    const audioRoute = owner.subscriptionManager.captureRoute(201n);
    expect(audioRoute?.()).toBe(true);
    let held = false;
    owner.subscriptionManager.objectTransform = async object => {
      if (object.trackAlias === 202n) { held = true; await gate; }
      return object;
    };
    await second(0n, full.payload, 2n);
    expect(held, 'premise: real second-alias input is accepted and awaiting its transform').toBe(true);
    owner.flushForLivenessRestart(h.videoLivenessTrack);
    expect.soft(decoder.getLastObjectId(1n), 'liveness must reset the namespace-resolved LOCMAF decoder despite the earlier same-name catalog entry').toBeUndefined();
    release(); await flush(256); owner.subscriptionManager.objectTransform = null;
    expect.soft(decoder.getLastObjectId(2n), 'liveness must retire held work on the other alias of the same namespace consumer').toBeUndefined();
    expect(audioRoute?.(), 'unrelated namespace audio registration must survive').toBe(true);
    expect(h.errors).toEqual([]);
  } finally { release(); owner.subscriptionManager.objectTransform = null; await h.destroy(); }
});
