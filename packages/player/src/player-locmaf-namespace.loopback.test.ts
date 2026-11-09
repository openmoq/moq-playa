import type { PlaybackSample } from '@openmoq/playback';
/** LOCMAF §6/§15: each issued identity owns its Header and reconstruction state.
 * Real peers + real LOCMAF codec; MSE/assembler are stubs, not rendering proof. */
import { describe, expect, it, vi } from 'vitest';
import { isTrackPackagingSupported, parseCatalogAuto } from '@openmoq/msf';
import type { LocHeaders } from '@openmoq/loc';
import type { MoqtObject } from '@openmoq/transport';
import { LocmafEncoder, LocmafGroupState, LocmafTrackDecoder, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import type { MoqtConnection as PlayerConnection } from '@openmoq/webtransport';
import { MoqtConnection } from '../../webtransport/src/adapter.js';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { buildInit, buildChunk, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { concat, isoBox, vi as vi64 } from '../../locmaf/test-support/bytes.js';
import { MoqtPlayer } from './player.js';
import type { MoqtPlayerConfig } from './config.js';

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

async function fixture(frame = false) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(18);
  const server = new MoqtConnection(18, { role: 'server' });
  const requests: Array<{ id: bigint; name: string; namespace: string[] }> = [];
  const errors: string[] = [];
  const output: Array<{ media: Media; name: string; bytes: Uint8Array }> = [];
  const streams = new Map<string, bigint>();
  server.onError = error => { errors.push(error.message); };
  server.onSubscribe = (id, ns, name) => { requests.push({ id, namespace: ns.map(f => dec.decode(f)), name: dec.decode(name) }); };
  server.onFetch = () => {};
  let started: Promise<void> | undefined;
  const player = new MoqtPlayer({
    url: 'https://locmaf.example/moq', namespace: ['live', 'show'], draftVersion: 18,
    catalogBootstrap: 'subscribe', locmafDecoding: frame ? 'frame' : 'mse',
    createConnection: () => client as unknown as PlayerConnection,
    createTransport: () => { started = server.connect(b, {}); void started.catch(error => errors.push(String(error))); return Promise.resolve(a); },
    createMediaSource: () => ({ initialize: () => true, appendChunk: () => {}, reset: () => {}, endOfStream: () => {},
      destroy: () => {}, mediaElement: null, onFirstFrame: null, onError: null, onStall: null }),
    createCmafAssembler: () => ({ push: (media, name, _group, bytes) => { output.push({ media, name, bytes }); },
      getEpoch: () => null, reset: () => {}, destroy: () => {} }),
  } as MoqtPlayerConfig);
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
      tracks: (['video', 'audio'] as const).map(media => ({ name: 'shared', namespace: namespaces[media].join('/'),
        role: media, packaging: 'locmaf', locmafVersion: '0.3', isLive: true, renderGroup: 1, initRef: media,
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
  return { player, output, errors, destroy, send: (media: Media, id: bigint, payload: Uint8Array, group = 1n) => send(media === 'video' ? 200n : 201n, id, payload, group) };
}

describe('LOCMAF same-name namespace isolation', () => {
  it.each([['video', 'audio'], ['audio', 'video']] as const)('owns decoder/Header with %s arriving before %s', async (first, second) => {
    const h = await fixture();
    try {
      const objects = { video: sequence('video'), audio: sequence('audio') };
      for (const id of [0, 1]) {
        for (const media of [first, second]) {
          await h.send(media, BigInt(id), objects[media][id]!.payload);
          expect(h.output.filter(o => o.media === media).map(o => o.bytes)).toEqual(objects[media].slice(0, id + 1).map(o => o.bytes));
        }
      }
      expect(h.output.map(o => o.name)).toEqual(['shared', 'shared', 'shared', 'shared']);
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('an audio in-band Header does not clear the video delta reference', async () => {
    const h = await fixture();
    try {
      const objects = sequence('video');
      await h.send('video', 0n, objects[0]!.payload);
      await h.send('audio', 0n, serializeLocmafObject({ kind: 'rawBoxes', boxes: headers.audio }));
      await h.send('video', 1n, objects[1]!.payload);
      expect(h.output.filter(o => o.media === 'video').map(o => o.bytes)).toEqual(objects.map(o => o.bytes));
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('wire carriers retain separate audio/video sample timescales for the same group and display name', async () => {
    const h = await fixture(true);
    // Observe the frame-interface boundary without claiming decoder/render output.
    const routed = vi.spyOn(h.player as unknown as {
      routeLocmafFrame: (media: Media, name: string, obj: MoqtObject, headers: LocHeaders, input?: object, delivery?: object, samples?: readonly PlaybackSample[]) => void;
    }, 'routeLocmafFrame');
    try {
      for (const media of ['video', 'audio'] as const) await h.send(media, 0n, sequence(media)[0]!.payload);
      expect(routed.mock.calls.map(([media, name, obj, , , , samples]) => ({ media, name, id: BigInt(obj.objectId), timescale: samples?.[0]?.headers.timescale })))
        .toEqual([
          { media: 'video', name: 'shared', id: 0n, timescale: 90000n },
          { media: 'audio', name: 'shared', id: 0n, timescale: 48000n },
        ]);
    } finally { routed.mockRestore(); await h.destroy(); }
  });

  it('healthy audio cannot mask three malformed video groups with the same name', async () => {
    const h = await fixture();
    const unsubscribed = vi.fn();
    h.player.on('track_unsubscribed', unsubscribed);
    try {
      const malformed = concat(vi64(4), isoBox('free'), Uint8Array.of(42));
      const audio = sequence('audio')[0]!;
      for (const group of [1n, 2n, 3n]) {
        // A successfully reconstructed audio Object must not mark the video's
        // same-numbered group decoded, or reset its consecutive-failure count.
        await h.send('audio', 0n, audio.payload, group);
        await h.send('video', 0n, malformed, group);
        expect(unsubscribed).toHaveBeenCalledTimes(group === 3n ? 1 : 0);
      }
      expect(unsubscribed).toHaveBeenCalledWith(expect.objectContaining({ trackName: 'shared', reason: expect.stringMatching(/Malformed track/) }));
      await h.send('audio', 0n, audio.payload, 4n);
      expect(h.output.filter(o => o.media === 'audio').map(o => o.bytes))
        .toEqual([audio.bytes, audio.bytes, audio.bytes, audio.bytes]);
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });
});
