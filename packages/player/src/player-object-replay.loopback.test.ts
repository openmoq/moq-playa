/**
 * Same-track alias reuse may deliver an immutable Object more than once: the
 * adapter admits a resubscription onto an alias still guarded by an ordinary
 * unsubscribe, and a late stream of the earlier subscription then routes to
 * the new one inside its window. The adapter delivers each receipt. LOCMAF
 * guards its decoder reference; legacy split CMAF guards its pending half-pair.
 * Complete CMAF chunks use the real MSE consumer's contained-replay handling.
 *
 * The late stream is modelled as a second subgroup stream on the same alias
 * carrying an Object already delivered; at the player boundary the two are
 * indistinguishable. Real peers + real CMAF assembler / LOCMAF codec. LOCMAF
 * uses a recording sink; complete CMAF uses real MSE with observable native
 * test doubles. Neither fixture claims browser decoding or rendering proof.
 */
import { describe, expect, it, vi } from 'vitest';
import { LocmafEncoder, LocmafGroupState, LocmafTrackDecoder, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { MoqtConnection } from '@openmoq/webtransport';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { buildInit, buildChunk, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { MseMediaSource } from '../../browser/src/mse-adapter.js';
import { MockMediaSource, MockVideoElement } from '../../browser/test-support/mse-native.js';
import { decodeSubscriptionFilter, MessageParam, varint } from '@openmoq/transport';
import { MoqtPlayer } from './player.js';
import type { LivenessTrack } from './media-liveness.js';
import type { MediaSourceLike } from './interfaces.js';

type Packaging = 'cmaf' | 'locmaf';
const enc = new TextEncoder();
const dec = new TextDecoder();
const VIDEO_ALIAS = 200n;
const AUDIO_ALIAS = 201n;
const init = {
  video: buildInit({ trackId: 11, timescale: 90000, handler: 'vide', trex: { duration: 3000, flags: SYNC_FLAGS } }),
  audio: buildInit({ trackId: 22, timescale: 48000, handler: 'soun', trex: { duration: 1024, flags: SYNC_FLAGS } }),
};
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** Canonical video CMAF chunks for Objects 0..count-1 of one group. */
function videoChunks(count: number, duration?: number): Uint8Array[] {
  const context = parseLocmafTrackContext(init.video);
  const sampleDuration = duration ?? context.defaultSampleDuration;
  return Array.from({ length: count }, (_, id) => buildChunk({ trackId: context.trackId,
    bmdt: BigInt(context.timescale) + BigInt(id) * BigInt(sampleDuration),
    samples: [{ duration: sampleDuration, size: 4, flags: SYNC_FLAGS }],
    mdat: Uint8Array.of(5, 2, 3, id),
  }));
}

/** LOCMAF Objects (Object 0 full, the rest deltas) and the chunks they reconstruct to. */
function locmafObjects(count: number): Array<{ payload: Uint8Array; bytes: Uint8Array }> {
  const context = parseLocmafTrackContext(init.video);
  const state = new LocmafGroupState();
  const encoder = new LocmafEncoder();
  const decoder = new LocmafTrackDecoder(init.video);
  return videoChunks(count).map((source, i) => {
    const id = BigInt(i);
    const object = encoder.encode(source, state, context, false, id);
    if (object.kind !== 'moof' || object.header.full !== (id === 0n)) throw new Error('invalid fixture');
    const payload = serializeLocmafObject(object);
    const canonical = decoder.push(1n, id, payload);
    if (canonical.kind !== 'chunk') throw new Error('invalid fixture');
    return { payload, bytes: canonical.bytes };
  });
}

/** Split a moof+mdat chunk into its moof and mdat boxes (legacy split CMAF Objects). */
function split(chunk: Uint8Array): [Uint8Array, Uint8Array] {
  const moofSize = new DataView(chunk.buffer, chunk.byteOffset).getUint32(0);
  return [chunk.subarray(0, moofSize), chunk.subarray(moofSize)];
}

/** The assembler rebases tfdt, so tests compare the mdat each appended segment carries. */
const mdats = (segments: Uint8Array[]) => segments.map(segment => split(segment)[1]);

async function fixture(packaging: Packaging, native = false, draft: 18 | 22 = 18, options: { timeline?: boolean } = {}) {
  const nativeSource = native ? new MockMediaSource() : undefined;
  let nativeAdapter: MseMediaSource | undefined;
  if (nativeSource) {
    vi.stubGlobal('MediaSource', Object.assign(function () { return nativeSource; }, { isTypeSupported: () => true }));
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:replay', revokeObjectURL: () => {} });
    nativeAdapter = new MseMediaSource(new MockVideoElement() as unknown as HTMLVideoElement, { maxAheadSec: Infinity });
  }
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft);
  const server = new MoqtConnection(draft, { role: 'server' });
  const requests: Array<{ id: bigint; name: string }> = [];
  const errors: string[] = [];
  const appended: Uint8Array[] = [];
  let seekDelivery: Promise<void> | undefined;
  const seekUpdates: Array<{ requestId: bigint; existingRequestId: bigint;
    filter: ReturnType<typeof decodeSubscriptionFilter> | null }> = [];
  const recordingSource: MediaSourceLike = {
    ...(options.timeline ? { supportsTrackIdentity: true as const } : {}),
    initialize: () => true,
    appendChunk: (media, bytes) => { if (media === 'video') appended.push(bytes.slice()); },
    reset() {}, endOfStream() {}, destroy() {},
    mediaElement: null, onFirstFrame: null, onError: null, onStall: null,

  };
  server.onError = error => { errors.push(error.message); };
  server.onSubscribe = (id, _ns, name) => { requests.push({ id, name: dec.decode(name) }); };
  server.onMessage = message => {
    if (!options.timeline || message.type !== 'REQUEST_UPDATE'
        || requests.find(request => request.id === message.existingRequestId)?.name !== 'video') return;
    // Draft 18 gives the update its own ID; the adapter stamps the original
    // subscription ID from the existing request-stream context.
    const encodedFilter = message.parameters.get(MessageParam.SUBSCRIPTION_FILTER)?.[0];
    seekUpdates.push({ requestId: message.requestId, existingRequestId: message.existingRequestId,
      filter: encodedFilter instanceof Uint8Array ? decodeSubscriptionFilter(encodedFilter, draft) : null });
    seekDelivery = (async () => {
      const send = await openVideoStream();
      for (const [id, object] of locmafObjects(4).entries()) await send(BigInt(id), object.payload);
    })();
    void seekDelivery.catch(error => { errors.push(String(error)); });
  };
  let started: Promise<void> | undefined;
  const player = new MoqtPlayer({
    url: 'https://replay.example/moq', namespace: ['live', 'show'], draftVersion: draft,
    catalogBootstrap: 'subscribe', locmafDecoding: 'mse',
    createConnection: () => client,
    createTransport: () => { started = server.connect(b, {}); void started.catch(error => errors.push(String(error))); return Promise.resolve(a); },
    createMediaSource: () => nativeAdapter ?? recordingSource,
    createCmafAssembler: options => new CmafAssembler(options),
  });
  player.on('error', event => errors.push(event.error.message));
  const streams: bigint[] = [];
  const videoStreams: bigint[] = [];
  const destroy = async () => {
    for (const stream of streams) await server.closeSubgroup(stream);
    await player.destroy(); await flush(256); await client.close(); await server.close(); await started?.catch(() => {});
    if (native) vi.unstubAllGlobals();
  };
  /** Open a new subgroup stream of video group 1 (each one stands for a delivery generation). */
  const openVideoStream = async (alias = VIDEO_ALIAS, group = 1n) => {
    const stream = await server.openSubgroup(alias, group, 0n, { publisherPriority: 128 });
    streams.push(stream);
    videoStreams.push(stream);
    return async (id: bigint, payload: Uint8Array) => { await server.sendObject(stream, id, payload); await flush(256); };
  };
  try {
    // The peer answers the root player's REQUEST_UPDATE seek with the requested history.
    const catalog = enc.encode(JSON.stringify({ version: '1',
      initDataList: (['video', 'audio'] as const).map(media => ({ id: media, type: 'inline', data: b64(init[media]) })),
      tracks: [...(['video', 'audio'] as const).map(media => ({ name: media, role: media, packaging,
        ...(packaging === 'locmaf' ? { locmafVersion: '0.3' } : {}), isLive: !native && !options.timeline, renderGroup: 1, initRef: media,
        ...(media === 'video' ? { codec: 'avc1.640028', width: 640, height: 360, bitrate: 500000 }
          : { codec: 'mp4a.40.2', samplerate: 48000, channelConfig: '2', bitrate: 128000 }),
      })), ...(options.timeline ? [{ name: 'timeline', packaging: 'mediatimeline', isLive: false,
        mimeType: 'application/json', depends: ['video', 'audio'] }] : [])],
    }));
    await player.load(); await flush(256);
    expect(requests.map(r => r.name)).toEqual(['catalog']);
    await server.acceptSubscribe(requests[0]!.id, 100n); await flush(128);
    const catalogStream = await server.openSubgroup(100n, 0n, 0n, { publisherPriority: 128 });
    streams.push(catalogStream);
    await server.sendObject(catalogStream, 0n, catalog); await flush(256);
    for (const [name, alias] of [['video', VIDEO_ALIAS], ['audio', AUDIO_ALIAS]] as const) {
      const request = requests.find(r => r.name === name);
      expect(request).toBeDefined();
      await server.acceptSubscribe(request!.id, alias); await flush(128);
    }
    if (options.timeline) {
      const request = requests.find(request => request.name === 'timeline'); expect(request).toBeDefined();
      await server.acceptSubscribe(request!.id, 300n); await flush(128);
      const stream = await server.openSubgroup(300n, 0n, 0n, { publisherPriority: 128 }); streams.push(stream);
      // Both fixture tracks start at source PTS 1s in Group 1/Object 0.
      await server.sendObject(stream, 0n, enc.encode(JSON.stringify([[1000, [1, 0], 0]]))); await flush(256);
      expect(player.seekable).toBe(true);
    }
    expect(errors).toEqual([]);
    nativeSource?.open(); await flush(256);
  } catch (error) { await destroy(); throw error; }
  const finishVideo = async () => {
    for (const stream of videoStreams) await server.closeSubgroup(stream);
    await server.publishDone(requests.find(request => request.name === 'video')!.id, varint(2n), 'finite');
    await flush(256);
  };
  // MoqtPlayer exposes no arbitrary second-subscription API. Seed only its
  // request bookkeeping, then exercise real SUBSCRIBE_OK/alias/object routing.
  const registerSecondAlias = async () => {
    const id = BigInt(await client.subscribe(['live', 'show'].map(value => enc.encode(value)), enc.encode('video')));
    const internals = player as unknown as {
      activeSubscriptions: Map<bigint, { trackName: string; mediaType: 'video'; trackAlias: bigint | null; namespace: string[] }>;
      pendingMediaSubs: Map<bigint, { trackName: string; mediaType: 'video'; packaging: Packaging }>;
    };
    internals.activeSubscriptions.set(id, { trackName: 'video', mediaType: 'video', trackAlias: null, namespace: ['live', 'show'] });
    internals.pendingMediaSubs.set(id, { trackName: 'video', mediaType: 'video', packaging });
    await flush(256);
    await server.acceptSubscribe(id, 202n); await flush(256);
    return openVideoStream(202n);
  };
  return { appended, errors, destroy, openVideoStream, player, client, server, nativeSource, finishVideo, registerSecondAlias,
    videoLivenessTrack: { requestId: requests.find(request => request.name === 'video')!.id,
      trackAlias: VIDEO_ALIAS, trackName: 'video', mediaType: 'video' as const },
    async finishSeekDelivery() {
      await flush(256); expect(seekDelivery).toBeDefined(); await seekDelivery; await flush(256);
      const video = requests.find(request => request.name === 'video'); expect(video).toBeDefined();
      expect(seekUpdates).toHaveLength(1);
      expect(seekUpdates[0]).toMatchObject({ existingRequestId: video!.id,
        filter: { type: 'AbsoluteStart', startGroup: 1n, startObject: 0n } });
      expect(seekUpdates[0]!.requestId).not.toBe(video!.id);
      // Both ends accepted the actual update, not a private reset or synthetic
      // history injection detached from the public seek's wire request.
      const serving = server.session.getIncomingSubscription(varint(video!.id));
      // Draft 18 stores the publisher's accepted filter bytes; its materialized
      // publisher locationWindow is a draft-22 path, not this fixture's oracle.
      expect(serving?.currentFilter).toBeInstanceOf(Uint8Array);
      expect(decodeSubscriptionFilter(serving!.currentFilter!, draft)).toEqual({ type: 'AbsoluteStart', startGroup: 1n, startObject: 0n });
      expect(client.session.getSubscription(varint(video!.id))?.locationWindow?.start).toEqual({ group: 1n, object: 0n });
    },
  };
}

function nativeMdats(source: MockMediaSource, mediaType: 'video' | 'audio' = 'video'): Uint8Array[] {
  return source[mediaType === 'video' ? 'videoBuffer' : 'audioBuffer'].appendedPayloads.flatMap(payload => {
    for (let offset = 0; offset + 8 <= payload.length;) {
      const size = new DataView(payload.buffer, payload.byteOffset + offset).getUint32(0);
      if (size < 8) break;
      if (String.fromCharCode(...payload.subarray(offset + 4, offset + 8)) === 'mdat') return [payload.slice(offset, offset + size)];
      offset += size;
    }
    return [];
  });
}

describe('replayed Object locations on the MSE paths', () => {
  it('two simultaneous aliases resolve to the SAME actual LOCMAF decoder and reference', async () => {
    const h = await fixture('locmaf', false, 22);
    try {
      const objects = locmafObjects(4), first = await h.openVideoStream(), second = await h.registerSecondAlias();
      await first(0n, objects[0]!.payload); await first(1n, objects[1]!.payload); await second(1n, objects[1]!.payload);
      await first(2n, objects[2]!.payload); await second(3n, objects[3]!.payload);
      const owner = h.player as unknown as { mediaKey(name: string, role: string, alias: bigint): string; locmafDecoders: Map<string, LocmafTrackDecoder> };
      const firstDecoder = owner.locmafDecoders.get(owner.mediaKey('video', 'video', VIDEO_ALIAS));
      const secondDecoder = owner.locmafDecoders.get(owner.mediaKey('video', 'video', 202n));
      expect(firstDecoder).toBeDefined(); expect(firstDecoder).toBe(secondDecoder);
      expect(owner.locmafDecoders.size).toBe(1); expect(firstDecoder!.getLastObjectId(1n)).toBe(3n);
      expect(mdats(h.appended)).toEqual(objects.map(object => split(object.bytes)[1])); expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('a consumer reset cancels a successful full-header transform parked on its other alias', async () => {
    const h = await fixture('locmaf', false, 22);
    try {
      const objects = locmafObjects(4), first = await h.openVideoStream(), second = await h.registerSecondAlias();
      await first(0n, objects[0]!.payload);
      await second(0n, objects[0]!.payload);
      const owner = h.player as unknown as {
        subscriptionManager: import('./subscription-manager.js').SubscriptionManager;
        flushForLivenessRestart(track: LivenessTrack): void;
      };
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
      let entered = false;
      owner.subscriptionManager.objectTransform = async object => { entered = true; await gate; return object; };
      const full = serializeLocmafObject(new LocmafEncoder().encode(videoChunks(2)[1]!, new LocmafGroupState(), parseLocmafTrackContext(init.video), false, 1n));
      await second(1n, full);
      expect(entered).toBe(true);
      owner.flushForLivenessRestart(h.videoLivenessTrack);
      release(); await flush(256); owner.subscriptionManager.objectTransform = null;
      const decoderOwner = h.player as unknown as { locmafDecoders: Map<string, LocmafTrackDecoder> };
      expect([...decoderOwner.locmafDecoders.values()][0]!.getLastObjectId(1n)).toBeUndefined();
      // The actual liveness ladder requests NextGroupStart. Draft-22's warm
      // start admission owner remains intact and advances to the new group.
      const fresh = await h.openVideoStream(VIDEO_ALIAS, 2n);
      for (let index = 0; index < objects.length; index++) await fresh(BigInt(index), objects[index]!.payload);
      expect(mdats(h.appended)).toEqual([split(objects[0]!.bytes)[1], ...objects.map(object => split(object.bytes)[1])]);
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('reference loss rejects an earlier full copy until native reset, then permits replay recovery', async () => {
    const h = await fixture('locmaf');
    try {
      const objects = locmafObjects(4), current = await h.openVideoStream();
      await current(0n, objects[0]!.payload); await current(1n, objects[1]!.payload);
      await current(3n, objects[3]!.payload); // Missing 2 clears the reference, preserving successful ID 1.
      const late = await h.openVideoStream(); await late(0n, objects[0]!.payload);
      await late(2n, objects[2]!.payload); expect(h.appended).toHaveLength(2);
      const owner = h.player as unknown as { flushForLivenessRestart(track: LivenessTrack): void };
      owner.flushForLivenessRestart(h.videoLivenessTrack);
      const fresh = await h.openVideoStream(); for (let index = 0; index < objects.length; index++) await fresh(BigInt(index), objects[index]!.payload);
      expect(mdats(h.appended)).toEqual([...objects.slice(0, 2), ...objects].map(object => split(object.bytes)[1]));
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('a failed far-future delta does not suppress the next successful full header', async () => {
    const h = await fixture('locmaf');
    try {
      const objects = locmafObjects(3), current = await h.openVideoStream();
      await current(0n, objects[0]!.payload); await current(1000n, objects[1]!.payload);
      const retry = await h.openVideoStream();
      const full = serializeLocmafObject(new LocmafEncoder().encode(videoChunks(2)[1]!, new LocmafGroupState(), parseLocmafTrackContext(init.video), false, 1n));
      await retry(1n, full); await retry(2n, objects[2]!.payload);
      expect(mdats(h.appended)).toEqual(objects.map(object => split(object.bytes)[1])); expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('an unseen older LOCMAF full header is locally stale input, without claiming an exact replay history', async () => {
    const h = await fixture('locmaf');
    try {
      const objects = locmafObjects(4), current = await h.openVideoStream();
      const manager = (h.player as unknown as { subscriptionManager: import('./subscription-manager.js').SubscriptionManager }).subscriptionManager;
      const discard = vi.spyOn(h.player as unknown as { discardMediaInput(input: object | undefined, reason: string): void }, 'discardMediaInput');
      manager.objectProvenance = { capture: (_source, object) => ({ id: object.objectId }),
        discarded: () => {} };
      const full = (id: number) => serializeLocmafObject(new LocmafEncoder().encode(videoChunks(4)[id]!, new LocmafGroupState(), parseLocmafTrackContext(init.video), false, BigInt(id)));
      await current(0n, objects[0]!.payload); await current(2n, full(2));
      const late = await h.openVideoStream(); await late(1n, full(1)); await current(3n, objects[3]!.payload);
      expect(mdats(h.appended)).toEqual([0, 2, 3].map(index => split(objects[index]!.bytes)[1]));
      expect(discard).toHaveBeenCalledExactlyOnceWith({ id: 1n }, 'object processing failed'); expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('public seek starts a native LOCMAF consumer lifetime that accepts the requested locations again', async () => {
    const h = await fixture('locmaf', false, 18, { timeline: true });
    try {
      const objects = locmafObjects(4), current = await h.openVideoStream();
      await current(0n, objects[0]!.payload); await current(1n, objects[1]!.payload);
      h.player.play(); await h.player.seek(1000); await h.finishSeekDelivery();
      expect(mdats(h.appended)).toEqual([...objects.slice(0, 2), ...objects].map(object => split(object.bytes)[1]));
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });
  it('complete CMAF replays are idempotent at the actual MSE/native append and terminal boundary', async () => {
    const h = await fixture('cmaf', true), ended: string[] = [];
    h.player.on('track_ended', event => { ended.push(event.mediaType); });
    try {
      const chunks = videoChunks(2), current = await h.openVideoStream();
      await current(0n, chunks[0]!); const late = await h.openVideoStream(); await late(0n, chunks[0]!);
      await current(1n, chunks[1]!); await h.finishVideo();
      expect(nativeMdats(h.nativeSource!)).toEqual(chunks.map(chunk => split(chunk)[1]));
      expect(ended).toEqual(['video']); expect(h.nativeSource!.videoBuffer.updating).toBe(false);
      expect(h.nativeSource!.readyState).toBe('open'); // Audio/session remain live.
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('native CMAF accepts sparse, reordered complete chunks without an object-ID fence', async () => {
    const h = await fixture('cmaf', true);
    try {
      const chunks = videoChunks(4, 1500), current = await h.openVideoStream(), other = await h.openVideoStream();
      await current(0n, chunks[0]!); await current(4n, chunks[2]!); await other(2n, chunks[1]!); await current(8192n, chunks[3]!);
      await h.finishVideo();
      expect(nativeMdats(h.nativeSource!)).toEqual(chunks.map(chunk => split(chunk)[1]));
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });
  it('normally progressing sparse CMAF IDs do not impose a short playback lifetime', async () => {
    const h = await fixture('cmaf', true);
    try {
      const send = await h.openVideoStream(), chunks = videoChunks(4098, 1500); // 60 fps at 90 kHz.
      for (let index = 0; index < chunks.length; index++) await send(BigInt(index * 2), chunks[index]!);
      expect(nativeMdats(h.nativeSource!)).toEqual(chunks.map(chunk => split(chunk)[1]));
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  }, 15000);

  it('LOCMAF: a repeated delta Object does not discard the rest of its group', async () => {
    const h = await fixture('locmaf');
    try {
      const objects = locmafObjects(4);
      const current = await h.openVideoStream();
      await current(0n, objects[0]!.payload);
      await current(1n, objects[1]!.payload);
      await current(2n, objects[2]!.payload);
      const late = await h.openVideoStream();
      await late(2n, objects[2]!.payload);
      await current(3n, objects[3]!.payload);
      expect(mdats(h.appended)).toEqual(objects.map(o => split(o.bytes)[1]));
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('LOCMAF: a repeated full-header Object does not re-anchor the group', async () => {
    const h = await fixture('locmaf');
    try {
      const objects = locmafObjects(3);
      const current = await h.openVideoStream();
      await current(0n, objects[0]!.payload);
      await current(1n, objects[1]!.payload);
      const late = await h.openVideoStream();
      await late(0n, objects[0]!.payload);
      await current(2n, objects[2]!.payload);
      expect(mdats(h.appended)).toEqual(objects.map(o => split(o.bytes)[1]));
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('LOCMAF: suppresses a repeated init location while admitting a distinct later init and fresh media', async () => {
    const h = await fixture('locmaf');
    try {
      const objects = locmafObjects(3), current = await h.openVideoStream();
      const header = serializeLocmafObject({ kind: 'rawBoxes', boxes: init.video });
      await current(0n, header); await current(1n, objects[0]!.payload); await current(2n, objects[1]!.payload);
      const late = await h.openVideoStream(); await late(0n, header);
      await current(3n, objects[2]!.payload);
      await current(4n, header); // Same bytes at a NEW location are not a replay.
      await current(5n, objects[0]!.payload); await current(6n, objects[1]!.payload);
      expect(mdats(h.appended)).toEqual([0, 1, 2, 0, 1].map(index => split(objects[index]!.bytes)[1]));
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('legacy split CMAF robustness: a repeated moof cannot pair with a later mdat', async () => {
    const h = await fixture('cmaf');
    try {
      const chunks = videoChunks(2);
      const [moofA, mdatA] = split(chunks[0]!);
      const [moofB, mdatB] = split(chunks[1]!);
      const current = await h.openVideoStream();
      await current(0n, moofA);
      await current(1n, mdatA);
      await current(2n, moofB);
      const late = await h.openVideoStream();
      await late(0n, moofA);
      await late(1n, mdatA);
      await current(3n, mdatB);
      expect(mdats(h.appended)).toEqual([mdatA, mdatB]);
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  // Complete-object callback counts are not a replay oracle for a custom sink.
  // Complete-object idempotence is defined by native append and terminal outcomes.

  it.each(['overlap', 'prefix'] as const)('public FETCH shares the live LOCMAF consumer history: %s', async mode => {
    const h = await fixture('locmaf');
    try {
      const objects = locmafObjects(4), current = await h.openVideoStream();
      if (mode === 'overlap') {
        await current(0n, objects[0]!.payload);
        await current(1n, objects[1]!.payload);
      }
      let request: bigint | undefined;
      h.server.onFetch = id => { request = id; };
      await h.player.fetch('video', { startGroup: 1, startObject: mode === 'overlap' ? 1 : 0, endGroup: 1, endObject: 2 });
      await flush(256); expect(request).toBeDefined();
      await h.server.acceptFetch(request!, { endLocation: { group: 1n, object: 2n } });
      await flush(256);
      const stream = await h.server.openFetchStream(request!);
      for (const index of mode === 'overlap' ? [1] : [0, 1]) {
        await h.server.sendFetchObject(stream, { groupId: 1n, subgroupId: 0n, objectId: BigInt(index),
          publisherPriority: 128, payload: objects[index]!.payload });
      }
      await h.server.closeFetchStream(stream); await flush(256);
      if (mode === 'prefix') await current(1n, objects[1]!.payload);
      await current(2n, objects[2]!.payload); await current(3n, objects[3]!.payload);
      expect(mdats(h.appended)).toEqual(objects.map(object => split(object.bytes)[1]));
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it.each(['transform', 'admission'] as const)('liveness restart retires earlier %s work before fresh replay', async phase => {
    const h = await fixture('locmaf');
    try {
      const objects = locmafObjects(4), current = await h.openVideoStream();
      await current(0n, objects[0]!.payload);
      const player = h.player as unknown as {
        subscriptionManager: import('./subscription-manager.js').SubscriptionManager;
        flushForLivenessRestart(track: LivenessTrack): void;
      };
      const manager = player.subscriptionManager;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let stale: Promise<void> | undefined;
      if (phase === 'transform') {
        manager.objectTransform = async object => { await gate; return object; };
        await current(1n, objects[1]!.payload);
      } else {
        const { varint } = await import('@openmoq/transport');
        stale = manager.routeObject(99n, { kind: 'data', trackAlias: varint(VIDEO_ALIAS), groupId: varint(1n),
          subgroupId: varint(0n), objectId: varint(1n), publisherPriority: 128, payload: objects[1]!.payload },
        18, h.client, undefined, { admission: gate.then(() => ({ kind: 'deliver', isLive: () => true, backfill: false })) });
      }
      player.flushForLivenessRestart(h.videoLivenessTrack);
      release(); await stale; await flush(256); manager.objectTransform = null;
      const fresh = await h.openVideoStream();
      for (let index = 0; index < objects.length; index++) await fresh(BigInt(index), objects[index]!.payload);
      expect(mdats(h.appended)).toEqual([split(objects[0]!.bytes)[1], ...objects.map(object => split(object.bytes)[1])]);
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });
});

it('a changed Header retires all groups across aliases before replacing their shared decoder', async () => {
  const h = await fixture('locmaf', true, 22);
  let release!: () => void;
  try {
    const objects = locmafObjects(4), chunks = videoChunks(4);
    await h.registerSecondAlias();
    const old = await h.openVideoStream(202n, 2n);
    await old(0n, objects[0]!.payload);
    const owner = h.player as unknown as { subscriptionManager: import('./subscription-manager.js').SubscriptionManager;
      locmafDecoders: Map<string, LocmafTrackDecoder>; mediaKey(name: string, role: string, alias: bigint): string };
    expect(owner.locmafDecoders.get(owner.mediaKey('video', 'video', VIDEO_ALIAS)))
      .toBe(owner.locmafDecoders.get(owner.mediaKey('video', 'video', 202n)));
    const gate = new Promise<void>(resolve => { release = resolve; }); let entered = false;
    owner.subscriptionManager.objectTransform = async object => {
      if (object.groupId === 2n && object.objectId === 2n) { entered = true; await gate; }
      return object;
    };
    const full = (id: number) => serializeLocmafObject(new LocmafEncoder().encode(chunks[id]!, new LocmafGroupState(), parseLocmafTrackContext(init.video), false, BigInt(id)));
    await old(2n, full(2)); expect(entered).toBe(true);
    const prior = [...owner.locmafDecoders.values()][0]!;
    const changed = new Uint8Array(init.video.length + 8); changed.set(init.video);
    new DataView(changed.buffer).setUint32(init.video.length, 8);
    changed.set(new TextEncoder().encode('free'), init.video.length + 4);
    const headerStream = await h.openVideoStream(VIDEO_ALIAS, 3n);
    await headerStream(0n, serializeLocmafObject({ kind: 'rawBoxes', boxes: changed }));
    expect([...owner.locmafDecoders.values()].includes(prior)).toBe(false);
    release(); await flush(256); owner.subscriptionManager.objectTransform = null;
    const fresh = await h.openVideoStream(VIDEO_ALIAS, 2n);
    await fresh(1n, full(1)); await fresh(2n, full(2)); await fresh(3n, objects[3]!.payload);
    expect(h.errors).toEqual([]);
    expect(nativeMdats(h.nativeSource!)).toEqual(objects.map(object => split(object.bytes)[1]));
  } finally { release?.(); await h.destroy(); }
});

it('public FETCH recovers the same alias after changed Header retires its prior decoder work', async () => {
  const h = await fixture('locmaf', true, 22);
  let release!: () => void;
  try {
    const objects = locmafObjects(4), chunks = videoChunks(4), old = await h.openVideoStream(VIDEO_ALIAS, 2n);
    await old(0n, objects[0]!.payload);
    const owner = h.player as unknown as {
      subscriptionManager: import('./subscription-manager.js').SubscriptionManager;
      locmafDecoders: Map<string, LocmafTrackDecoder>;
    };
    const prior = [...owner.locmafDecoders.values()][0]!;
    const gate = new Promise<void>(resolve => { release = resolve; }); let entered = false;
    owner.subscriptionManager.objectTransform = async object => {
      if (object.groupId === 2n && object.objectId === 2n) { entered = true; await gate; }
      return object;
    };
    const full = (id: number) => serializeLocmafObject(new LocmafEncoder().encode(chunks[id]!, new LocmafGroupState(), parseLocmafTrackContext(init.video), false, BigInt(id)));
    await old(2n, full(2)); expect(entered).toBe(true);
    const changed = new Uint8Array(init.video.length + 8); changed.set(init.video);
    new DataView(changed.buffer).setUint32(init.video.length, 8);
    changed.set(new TextEncoder().encode('free'), init.video.length + 4);
    const header = await h.openVideoStream(VIDEO_ALIAS, 3n);
    await header(0n, serializeLocmafObject({ kind: 'rawBoxes', boxes: changed }));
    expect([...owner.locmafDecoders.values()].includes(prior)).toBe(false);
    release(); await flush(256); owner.subscriptionManager.objectTransform = null;
    let request: bigint | undefined; h.server.onFetch = id => { request = id; };
    await h.player.fetch('video', { startGroup: 2, startObject: 1, endGroup: 2, endObject: 4 });
    await flush(256); expect(request).toBeDefined();
    await h.server.acceptFetch(request!, { endLocation: { group: 2n, object: 3n } }); await flush(256);
    const stream = await h.server.openFetchStream(request!);
    for (const id of [1n, 2n, 3n]) {
      await h.server.sendFetchObject(stream, { groupId: 2n, subgroupId: 0n, objectId: id,
        publisherPriority: 128, payload: id === 3n ? objects[3]!.payload : full(Number(id)) });
    }
    await h.server.closeFetchStream(stream); await flush(256);
    expect(nativeMdats(h.nativeSource!)).toEqual(objects.map(object => split(object.bytes)[1]));
    expect([...owner.locmafDecoders.values()][0]!.getLastObjectId(2n)).toBe(3n);
    expect(h.errors).toEqual([]);
  } finally { release?.(); await h.destroy(); }
});

it.each([false, true])('an unchanged Header preserves accepted work in another group; other alias=%s', async otherAlias => {
  const h = await fixture('locmaf', true, 22);
  let release!: () => void;
  try {
    const objects = locmafObjects(4), chunks = videoChunks(4);
    if (otherAlias) await h.registerSecondAlias();
    const old = await h.openVideoStream(otherAlias ? 202n : VIDEO_ALIAS, 2n);
    await old(0n, objects[0]!.payload); await old(1n, objects[1]!.payload);
    const owner = h.player as unknown as {
      subscriptionManager: import('./subscription-manager.js').SubscriptionManager;
      locmafDecoders: Map<string, LocmafTrackDecoder>;
    };
    const prior = [...owner.locmafDecoders.values()][0]!;
    const gate = new Promise<void>(resolve => { release = resolve; }); let entered = false;
    owner.subscriptionManager.objectTransform = async object => {
      if (object.groupId === 2n && object.objectId === 2n) { entered = true; await gate; }
      return object;
    };
    const full = serializeLocmafObject(new LocmafEncoder().encode(chunks[2]!, new LocmafGroupState(), parseLocmafTrackContext(init.video), false, 2n));
    await old(2n, full); expect(entered).toBe(true);
    const header = await h.openVideoStream(VIDEO_ALIAS, 3n);
    await header(0n, serializeLocmafObject({ kind: 'rawBoxes', boxes: init.video }));
    expect([...owner.locmafDecoders.values()][0]).toBe(prior);
    expect(prior.getLastObjectId(2n)).toBe(1n);
    release(); await flush(256); owner.subscriptionManager.objectTransform = null;
    await old(3n, objects[3]!.payload);
    expect(prior.getLastObjectId(2n)).toBe(3n);
    expect(nativeMdats(h.nativeSource!)).toEqual(objects.map(object => split(object.bytes)[1]));
    expect(h.errors).toEqual([]);
  } finally { release?.(); await h.destroy(); }
});

it('a changed video Header leaves the independent audio decoder and accepted transform alive', async () => {
  const h = await fixture('locmaf', true, 22);
  let release!: () => void, stream: bigint | undefined;
  try {
    const objects = locmafObjects(1), video = await h.openVideoStream(VIDEO_ALIAS, 2n);
    await video(0n, objects[0]!.payload);
    const context = parseLocmafTrackContext(init.audio);
    const audioChunks = [0n, 1n].map(id => buildChunk({ trackId: 22, bmdt: 48000n + id * 1024n,
      samples: [{ duration: 1024, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(7, 8, 9, Number(id)) }));
    const full = (id: number) => serializeLocmafObject(new LocmafEncoder().encode(audioChunks[id]!, new LocmafGroupState(), context, false, BigInt(id)));
    stream = await h.server.openSubgroup(AUDIO_ALIAS, 2n, 0n, { publisherPriority: 128 });
    await h.server.sendObject(stream, 0n, full(0)); await flush(256);
    const owner = h.player as unknown as {
      subscriptionManager: import('./subscription-manager.js').SubscriptionManager;
      locmafDecoders: Map<string, LocmafTrackDecoder>;
      mediaKey(name: string, role: string, alias: bigint): string;
    };
    const audioKey = owner.mediaKey('audio', 'audio', AUDIO_ALIAS), prior = owner.locmafDecoders.get(audioKey)!;
    const registration = owner.subscriptionManager.captureRoute(AUDIO_ALIAS);
    const gate = new Promise<void>(resolve => { release = resolve; }); let entered = false;
    owner.subscriptionManager.objectTransform = async object => {
      if (object.trackAlias === AUDIO_ALIAS && object.objectId === 1n) { entered = true; await gate; }
      return object;
    };
    await h.server.sendObject(stream, 1n, full(1)); await flush(256); expect(entered).toBe(true);
    const changed = new Uint8Array(init.video.length + 8); changed.set(init.video);
    new DataView(changed.buffer).setUint32(init.video.length, 8);
    changed.set(new TextEncoder().encode('free'), init.video.length + 4);
    const header = await h.openVideoStream(VIDEO_ALIAS, 3n);
    await header(0n, serializeLocmafObject({ kind: 'rawBoxes', boxes: changed }));
    expect(owner.locmafDecoders.get(audioKey)).toBe(prior); expect(registration?.()).toBe(true);
    release(); await flush(256); owner.subscriptionManager.objectTransform = null;
    expect(prior.getLastObjectId(2n)).toBe(1n);
    expect(nativeMdats(h.nativeSource!, 'audio')).toEqual(audioChunks.map(chunk => split(chunk)[1]));
    expect(h.errors).toEqual([]);
  } finally { release?.(); if (stream !== undefined) await h.server.closeSubgroup(stream); await h.destroy(); }
});

it('prepares fresh LOCMAF history when seek is requested from a media callback', async () => {
  const h = await fixture('locmaf', false, 18, { timeline: true });
  try {
    const chunks = videoChunks(4), objects = locmafObjects(4);
    const full = serializeLocmafObject(new LocmafEncoder().encode(chunks[1]!, new LocmafGroupState(), parseLocmafTrackContext(init.video), false, 1n));
    h.player.play();
    const current = await h.openVideoStream(); await current(0n, objects[0]!.payload);
    let seeking: Promise<void> | undefined, once = false;
    h.player.on('media_object', event => {
      if (event.mediaType === 'video' && event.objectId === 1n && !once) {
        once = true; seeking = h.player.seek(1000);
      }
    });
    await current(1n, full); await seeking; await h.finishSeekDelivery();
    expect(once).toBe(true); expect(h.errors).toEqual([]);
    // The old callback may complete while replacement input is preparing.
    // The requested history itself must enter a fresh reconstruction lifetime.
    expect(mdats(h.appended.slice(-objects.length))).toEqual(objects.map(object => split(object.bytes)[1]));
  } finally { await h.destroy(); }
});
