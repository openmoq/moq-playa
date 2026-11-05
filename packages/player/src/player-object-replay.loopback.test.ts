/**
 * Same-track alias reuse may deliver an immutable Object more than once: the
 * adapter admits a resubscription onto an alias still guarded by an ordinary
 * unsubscribe, and a late stream of the earlier subscription then routes to
 * the new one inside its window. The adapter delivers each receipt and leaves
 * replay suppression to its consumer, so the CMAF and LOCMAF paths must drop a
 * repeated location before it reaches stateful assembly or reconstruction.
 *
 * The late stream is modelled as a second subgroup stream on the same alias
 * carrying an Object already delivered; at the player boundary the two are
 * indistinguishable. Real peers + real CMAF assembler / LOCMAF codec; the
 * MediaSource is a recording stub, not rendering proof.
 */
import { describe, expect, it } from 'vitest';
import { LocmafEncoder, LocmafGroupState, LocmafTrackDecoder, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import type { MoqtConnection as PlayerConnection } from '@openmoq/webtransport';
import { MoqtConnection } from '../../webtransport/src/adapter.js';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { buildInit, buildChunk, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { MoqtPlayer } from './player.js';
import type { MoqtPlayerConfig } from './config.js';

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
function videoChunks(count: number): Uint8Array[] {
  const context = parseLocmafTrackContext(init.video);
  return Array.from({ length: count }, (_, id) => buildChunk({ trackId: context.trackId,
    bmdt: BigInt(context.timescale) + BigInt(id) * BigInt(context.defaultSampleDuration),
    samples: [{ duration: context.defaultSampleDuration, size: 4, flags: SYNC_FLAGS }],
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

async function fixture(packaging: Packaging) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(18);
  const server = new MoqtConnection(18, { role: 'server' });
  const requests: Array<{ id: bigint; name: string }> = [];
  const errors: string[] = [];
  const appended: Uint8Array[] = [];
  server.onError = error => { errors.push(error.message); };
  server.onSubscribe = (id, _ns, name) => { requests.push({ id, name: dec.decode(name) }); };
  server.onFetch = () => {};
  let started: Promise<void> | undefined;
  const player = new MoqtPlayer({
    url: 'https://replay.example/moq', namespace: ['live', 'show'], draftVersion: 18,
    catalogBootstrap: 'subscribe', locmafDecoding: 'mse',
    createConnection: () => client as unknown as PlayerConnection,
    createTransport: () => { started = server.connect(b, {}); void started.catch(error => errors.push(String(error))); return Promise.resolve(a); },
    createMediaSource: () => ({ initialize: () => true,
      appendChunk: (media: 'video' | 'audio', bytes: Uint8Array) => { if (media === 'video') appended.push(bytes.slice()); },
      reset: () => {}, endOfStream: () => {}, destroy: () => {}, mediaElement: null, onFirstFrame: null, onError: null, onStall: null }),
    createCmafAssembler: options => new CmafAssembler(options),
  } as MoqtPlayerConfig);
  player.on('error', event => errors.push(event.error.message));
  const streams: bigint[] = [];
  const destroy = async () => {
    for (const stream of streams) await server.closeSubgroup(stream);
    await player.destroy(); await flush(256); await client.close(); await server.close(); await started?.catch(() => {});
  };
  /** Open a new subgroup stream of video group 1 (each one stands for a delivery generation). */
  const openVideoStream = async () => {
    const stream = await server.openSubgroup(VIDEO_ALIAS, 1n, 0n, { publisherPriority: 128 });
    streams.push(stream);
    return async (id: bigint, payload: Uint8Array) => { await server.sendObject(stream, id, payload); await flush(256); };
  };
  try {
    const catalog = enc.encode(JSON.stringify({ version: '1',
      initDataList: (['video', 'audio'] as const).map(media => ({ id: media, type: 'inline', data: b64(init[media]) })),
      tracks: (['video', 'audio'] as const).map(media => ({ name: media, role: media, packaging,
        ...(packaging === 'locmaf' ? { locmafVersion: '0.3' } : {}), isLive: true, renderGroup: 1, initRef: media,
        ...(media === 'video' ? { codec: 'avc1.640028', width: 640, height: 360, bitrate: 500000 }
          : { codec: 'mp4a.40.2', samplerate: 48000, channelConfig: '2', bitrate: 128000 }),
      })),
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
    expect(errors).toEqual([]);
  } catch (error) { await destroy(); throw error; }
  return { appended, errors, destroy, openVideoStream };
}

describe('replayed Object locations on the MSE paths', () => {
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

  it('CMAF: a repeated moof Object cannot pair with a later mdat', async () => {
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

  it('CMAF: a repeated moof+mdat Object is not handed to the MediaSource again', async () => {
    const h = await fixture('cmaf');
    try {
      const chunks = videoChunks(2);
      const current = await h.openVideoStream();
      await current(0n, chunks[0]!);
      const late = await h.openVideoStream();
      await late(0n, chunks[0]!);
      await current(1n, chunks[1]!);
      expect(mdats(h.appended)).toEqual(chunks.map(chunk => split(chunk)[1]));
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });
});
