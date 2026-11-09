import { expect, it, vi } from 'vitest';
import { LocmafTrackDecoder, serializeLocmafObject } from '@openmoq/locmaf';
import { varint } from '@openmoq/transport';
import type { MoqtPlayer } from './player.js';
import type { LivenessTrack } from './media-liveness.js';
import type { PlaybackPipeline } from '../../playback/src/pipeline.js';
import type { SubscriptionManager } from './subscription-manager.js';
import { buildInit, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { fixture, sequence } from '../test-support/locmaf-replay.js';

type Owner = {
  mediaKey(name: string, role: string, alias: bigint): string;
  locmafDecoders: Map<string, LocmafTrackDecoder>;
  subscriptionManager: SubscriptionManager;
  videoPipeline: PlaybackPipeline;
  noteLocmafInBandHeader(name: string, bytes: Uint8Array, alias: bigint): void;
  flushForLivenessRestart(track: LivenessTrack): void;
  routeLocmafFrame: MoqtPlayer['routeLocmafFrame'];
};
// Narrow private seam for assertions/reentrant public-callback faults; delivery still uses real peers.
const ownerOf = (p: MoqtPlayer) => p as unknown as Owner;
const changedHeader = () => buildInit({ trackId: 11, timescale: 180000, handler: 'vide', trex: { duration: 3000, flags: SYNC_FLAGS } });

it('scoped Header replacement during a loopback media_object callback must not let that retired raw-frame input seed the new decoder', async () => {
  const h = await fixture(true), owner = ownerOf(h.player);
  const routed = vi.spyOn(owner, 'routeLocmafFrame');
  try {
    const full = sequence('video')[0]!;
    await h.send('video', 0n, full.payload, 1n);
    const key = owner.mediaKey('shared', 'video', 200n), decoder = owner.locmafDecoders.get(key)!;
    expect(decoder.getLastObjectId(1n), 'premise: real wire input seeded the decoder').toBe(0n);
    const generation = owner.subscriptionManager.mediaInputGeneration;
    let resetObserved = false, generationPreserved = false;
    // Synchronous lifecycle seam: real wire input is already inside the engine's
    // public callback. Invoke the actual Header replacement helper at that boundary.
    // No synthetic object is passed directly to the engine or manager.
    h.player.on('media_object', event => {
      if (event.mediaType === 'video' && event.groupId === 2n && !resetObserved) {
        owner.noteLocmafInBandHeader('shared', changedHeader(), 200n);
        resetObserved = !owner.locmafDecoders.has(key);
        generationPreserved = owner.subscriptionManager.mediaInputGeneration === generation;
      }
    });
    routed.mockClear();
    await h.send('video', 0n, full.payload, 2n);
    expect(resetObserved, 'premise: replacement removed the real decoder inside media_object').toBe(true);
    expect(generationPreserved, 'premise: scoped replacement did not change global input generation').toBe(true);
    expect(h.errors).toEqual([]);
    expect.soft(owner.locmafDecoders.get(key)?.getLastObjectId(2n), 'retired in-flight input must not re-seed the replacement decoder').toBeUndefined();
    expect.soft(routed.mock.calls.length, 'retired in-flight input must emit no raw frames').toBe(0);
  } finally { routed.mockRestore(); await h.destroy(); }
});

it('frame reset floor rejects a stale loopback group before LOCMAF reconstruction even while currentGroupId is -1', async () => {
  const h = await fixture(true), owner = ownerOf(h.player);
  try {
    const full = sequence('video')[0]!;
    await h.send('video', 0n, full.payload, 1n);
    const decoder = owner.locmafDecoders.get(owner.mediaKey('shared', 'video', 200n))!;
    expect(decoder.getLastObjectId(1n)).toBe(0n);
    const pipeline = owner.videoPipeline;
    expect(pipeline, 'premise: fixture owns the real root PlaybackPipeline').toBeDefined();
    pipeline.reset(10n);
    expect(pipeline.currentGroupId).toBe(-1n);
    expect(pipeline.bufferedGroupCount).toBe(0);
    // Prove the authoritative rejection boundary behaviorally on the real pipeline.
    pipeline.pushObject({ kind: 'data', trackAlias: varint(200n), groupId: varint(9n), subgroupId: varint(0n), objectId: varint(0n),
      publisherPriority: 128, payload: Uint8Array.of(5, 2, 3, 0) });
    expect(pipeline.bufferedGroupCount, 'premise: pipeline itself rejects Group 9 after reset(10)').toBe(0);
    await h.send('video', 0n, full.payload, 9n);
    expect(pipeline.bufferedGroupCount, 'downstream rejects stale frames, but must not be the first rejection').toBe(0);
    expect(h.errors).toEqual([]);
    expect.soft(decoder.getLastObjectId(9n), 'stale group must not acquire a successful LOCMAF frontier before downstream rejection').toBeUndefined();
    await h.send('video', 0n, full.payload, 10n);
    expect(decoder.getLastObjectId(10n), 'control: fresh group at the real reset floor remains admissible').toBe(0n);
    expect(pipeline.bufferedGroupCount, 'control: real pipeline accepts Group 10').toBe(1);
  } finally { await h.destroy(); }
});

it('frame reset floor prevents a stale rawBoxes Header from replacing the live decoder', async () => {
  const h = await fixture(true), owner = ownerOf(h.player);
  try {
    await h.send('video', 0n, sequence('video')[0]!.payload, 10n);
    const key = owner.mediaKey('shared', 'video', 200n), decoder = owner.locmafDecoders.get(key)!;
    owner.videoPipeline.reset(10n);
    expect(owner.videoPipeline.currentGroupId).toBe(-1n);
    expect(decoder.getLastObjectId(10n)).toBe(0n);
    await h.send('video', 0n, serializeLocmafObject({ kind: 'rawBoxes', boxes: changedHeader() }), 9n);
    expect(h.errors).toEqual([]);
    expect(owner.locmafDecoders.get(key), 'stale Header must leave the current consumer and its Group 10 reference intact').toBe(decoder);
  } finally { await h.destroy(); }
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

it('rawBoxes reset initiator remains live on the raw-frame path while older same-group accepted work retires', async () => {
  const h = await fixture(true), owner = ownerOf(h.player);
  const routed = vi.spyOn(owner, 'routeLocmafFrame');
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const objects = sequence('video');
    await h.send('video', 0n, objects[0]!.payload);
    const second = await h.registerSecondAlias();
    let held = false;
    owner.subscriptionManager.objectTransform = async object => {
      if (object.trackAlias === 202n) { held = true; await gate; }
      return object;
    };
    await second(1n, objects[1]!.payload);
    expect(held).toBe(true);
    routed.mockClear();
    await h.send('video', 2n, serializeLocmafObject({ kind: 'rawBoxes', boxes: objects[1]!.bytes }));
    const decoder = owner.locmafDecoders.get(owner.mediaKey('shared', 'video', 200n))!;
    expect(decoder.getLastObjectId(1n), 'reset initiator records its own successful Location').toBe(2n);
    expect(routed.mock.calls.length, 'valid rawBoxes reset initiator must still emit its frame').toBe(1);
    release(); await flush(256); owner.subscriptionManager.objectTransform = null;
    expect(routed.mock.calls.length, 'older accepted delta must not emit after rawBoxes retired it').toBe(1);
    expect(decoder.getLastObjectId(1n)).toBe(2n);
    expect(h.errors).toEqual([]);
  } finally { release(); owner.subscriptionManager.objectTransform = null; routed.mockRestore(); await h.destroy(); }
});
