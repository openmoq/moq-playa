// Reusable public-loopback fixture adapted from player-locmaf-namespace.loopback.test.ts.
// Real catalog/SUBSCRIBE/subgroup peers; observable frame/assembler boundaries, no native rendering.
/** LOCMAF §6/§15: each issued identity owns its Header and reconstruction state.
 * Real peers + real LOCMAF codec; MSE/assembler are stubs, not rendering proof. */
import { expect } from 'vitest';
import { isTrackPackagingSupported, parseCatalogAuto } from '@openmoq/msf';
import { LocmafEncoder, LocmafGroupState, LocmafTrackDecoder, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { MoqtConnection } from '@openmoq/webtransport';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { buildInit, buildChunk, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { MoqtPlayer } from '../src/player.js';

type Media = 'video' | 'audio';
const enc = new TextEncoder();
const dec = new TextDecoder();
const namespaces = { video: ['camera', 'main'], audio: ['sound', 'main'] };
const headers = {
  video: buildInit({ trackId: 11, timescale: 90000, handler: 'vide', trex: { duration: 3000, flags: SYNC_FLAGS } }),
  audio: buildInit({ trackId: 22, timescale: 48000, handler: 'soun', trex: { duration: 1024, flags: SYNC_FLAGS } }),
};
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

function sequence(media: Media, init = headers[media]) {
  const context = parseLocmafTrackContext(init);
  const state = new LocmafGroupState();
  const encoder = new LocmafEncoder();
  const decoder = new LocmafTrackDecoder(init);
  return [0n, 1n].map(id => {
    const source = buildChunk({ trackId: context.trackId,
      bmdt: BigInt(context.timescale) + id * BigInt(context.defaultSampleDuration),
      samples: [{ duration: context.defaultSampleDuration, size: 4, flags: SYNC_FLAGS }],
      mdat: Uint8Array.of(media === 'video' ? 5 : 1, 2, 3, Number(id)),
    });
    const object = encoder.encode(source, state, context, false, id);
    expect(object.kind).toBe('moof'); // Not the rawBoxes escape hatch.
    if (object.kind === 'moof') expect(object.header.full).toBe(id === 0n);
    const payload = serializeLocmafObject(object);
    const canonical = decoder.push(1n, id, payload);
    expect(canonical.kind).toBe('chunk');
    if (canonical.kind !== 'chunk') throw new Error('invalid fixture');
    return { payload, bytes: canonical.bytes };
  });
}

async function fixture(frame = false, collision = false, cmafAudio = collision) {
  let now = 1_000_000;
  const decoded: Array<{timestamp:number;type:string}> = [];
  const { a, b } = createLoopback();
  const client = new MoqtConnection(22);
  const server = new MoqtConnection(22, { role: 'server' });
  const requests: Array<{ id: bigint; name: string; namespace: string[] }> = [];
  const errors: string[] = [];
  const output: Array<{ media: Media; name: string; bytes: Uint8Array }> = [];
  const streams = new Map<string, bigint>();
  server.onError = error => { errors.push(error.message); };
  server.onSubscribe = (id, ns, name) => { requests.push({ id, namespace: ns.map(f => dec.decode(f)), name: dec.decode(name) }); };
  server.onFetch = () => {};
  let started: Promise<void> | undefined;
  const player = new MoqtPlayer({
    url: 'https://locmaf.example/moq', namespace: ['live', 'show'], draftVersion: 22,
    catalogBootstrap: 'subscribe', locmafDecoding: frame ? 'frame' : 'mse',
    clock: { now: () => now },
    createVideoDecoder: () => ({ configure() {}, decode(chunk) { decoded.push({ timestamp: chunk.timestamp, type: chunk.type }); }, flush: async () => {}, reset() {}, destroy() {}, queueDepth: 0, onFrame: null, onError: null }),
    createAudioDecoder: () => ({ configure() {}, decode() {}, flush: async () => {}, reset() {}, destroy() {}, queueDepth: 0, onData: null, onError: null }),
    createRenderer: () => ({ enqueue() {}, flush() {}, destroy() {}, onFirstFrame: null, onFrameRendered: null, onStall: null }),
    createAudioOutput: () => ({ schedule() {}, flush() {}, destroy() {}, currentPlayoutTimeUs: 0 }),
    createConnection: () => client,
    createTransport: () => { started = server.connect(b, {}); void started.catch(error => errors.push(String(error))); return Promise.resolve(a); },
    createMediaSource: () => ({ initialize: () => true, appendChunk: () => {}, reset: () => {}, endOfStream: () => {},
      destroy: () => {}, mediaElement: null, onFirstFrame: null, onError: null, onStall: null }),
    createCmafAssembler: () => ({ push: (media, name, _group, bytes) => { output.push({ media, name, bytes }); },
      getEpoch: () => null, reset: () => {}, destroy: () => {} }),
  });
  player.on('error', event => errors.push(event.error.message));
  const destroy = async () => {
    for (const stream of streams.values()) await server.closeSubgroup(stream);
    await player.destroy(); await flush(256); await client.close(); await server.close(); await started?.catch(() => {});
  };
  const send = async (alias: bigint, id: bigint, payload: Uint8Array, group = 1n) => {
    // LOCMAF §3: all Objects of a group MUST use one ordered subgroup.
    const key = JSON.stringify([String(alias), String(group)]);
    let stream = streams.get(key);
    if (stream === undefined) {
      stream = await server.openSubgroup(alias, group, 0n, { publisherPriority: 128 });
      streams.set(key, stream);
    }
    await server.sendObject(stream, id, payload);
    await flush(256);
  };
  try {
    const catalog = enc.encode(JSON.stringify({ version: '1',
      initDataList: (['video', 'audio'] as const).map(media => ({ id: media, type: 'inline', data: b64(headers[media]) })),
      tracks: (collision ? ['audio', 'video'] as const : ['video', 'audio'] as const).map(media => ({ name: 'shared', namespace: namespaces[media].join('/'),
        role: media, packaging: cmafAudio && media === 'audio' ? 'cmaf' : 'locmaf', ...(cmafAudio && media === 'audio' ? {} : { locmafVersion: '0.3' }), isLive: true, renderGroup: 1, initRef: media,
        ...(media === 'video' ? { codec: 'avc1.640028', width: 640, height: 360, bitrate: 500000 }
          : { codec: 'mp4a.40.2', samplerate: 48000, channelConfig: '2', bitrate: 128000 }),
      })),
    }));
    expect(parseCatalogAuto(catalog, ['live', 'show']).tracks.every(isTrackPackagingSupported)).toBe(true);
    await player.load(); await flush(256);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ name: 'catalog', namespace: ['live', 'show'] });
    await server.acceptSubscribe(requests[0]!.id, 100n); await flush(128);
    await send(100n, 0n, catalog);
    for (const [media, alias] of [['video', 200n], ['audio', 201n]] as const) {
      const matches = requests.filter(r => r.name === 'shared' && JSON.stringify(r.namespace) === JSON.stringify(namespaces[media]));
      expect(matches).toHaveLength(1);
      await server.acceptSubscribe(matches[0]!.id, alias); await flush(128);
    }
    expect(errors).toEqual([]);
  } catch (error) { await destroy(); throw error; }
  const registerSecondAlias = async () => {
    const id = BigInt(await client.subscribe(namespaces.video.map(value => enc.encode(value)), enc.encode('shared')));
    const owner = player as unknown as {
      activeSubscriptions: Map<bigint, { trackName: string; mediaType: 'video'; trackAlias: bigint | null; namespace: string[] }>;
      pendingMediaSubs: Map<bigint, { trackName: string; mediaType: 'video'; packaging: 'locmaf' }>;
    };
    owner.activeSubscriptions.set(id, { trackName: 'shared', mediaType: 'video', trackAlias: null, namespace: namespaces.video });
    owner.pendingMediaSubs.set(id, { trackName: 'shared', mediaType: 'video', packaging: 'locmaf' });
    await flush(256); await server.acceptSubscribe(id, 202n); await flush(256);
    return (id: bigint, payload: Uint8Array, group = 1n) => send(202n, id, payload, group);
  };
  return { player, client, server, output, errors, destroy, registerSecondAlias, decoded,
    advance: (us: number) => { now += us; player.tick(); },
    videoLivenessTrack: { requestId: requests.find(r => r.name === 'shared' && JSON.stringify(r.namespace) === JSON.stringify(namespaces.video))!.id,
      trackAlias: 200n, trackName: 'shared', mediaType: 'video' as const }, send: (media: Media, id: bigint, payload: Uint8Array, group = 1n) => send(media === 'video' ? 200n : 201n, id, payload, group) };
}


export { fixture, sequence, headers, namespaces };
