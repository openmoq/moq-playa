import { describe, expect, it, vi, type MockInstance } from 'vitest';
import { decodeFetchLocationFilter, createControlCodec, encodeFetchHeader, encodeFetchObject, FetchFlags, FetchSubgroupMode, varint, writeVarint, varintEncodingLength, MAX_VARINT, MAX_VI64 } from '@openmoq/transport';
import { MoqtConnection } from '@openmoq/webtransport';
import { LocmafEncoder, LocmafGroupState, LocmafTrackDecoder, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { readFirstSamplePresentationTime } from '../../browser/src/mp4-box.js';
import { buildInit, buildChunk, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { MoqtPlayer } from './player.js';
import { MseSeekPlayback } from './mse-seek-playback.js';
import { planSeekFetchPage } from './seek-fetch-pages.js';
import type { MediaAppendObserver, MediaSeekResource, MediaSeekSample, MediaSourceLike } from './interfaces.js';

const enc = new TextEncoder(), dec = new TextDecoder();
const init = buildInit({ trackId: 1, timescale: 1000, handler: 'vide' });
const locations = [[4000, [3, 0], 0], [6000, [3, 1], 0], [12000, [3, 2], 0], [3_600_000, [900, 0], 0]] as const;
const entries = locations.map(([mediaPts, location, wallclockTime]) => ({ mediaPts, location: [...location] as [number, number], wallclockTime }));
const expectedPayloads = [Uint8Array.of(41, 42, 43, 44), Uint8Array.of(51, 52, 53, 54)];

function objects() {
  const encoder = new LocmafEncoder(), state = new LocmafGroupState(), context = parseLocmafTrackContext(init);
  return [4000n, 6000n].map((bmdt, index) => {
    const cmaf = buildChunk({ trackId: 1, bmdt, samples: [{ duration: 2000, size: 4, flags: index ? NON_SYNC_FLAGS : SYNC_FLAGS }], mdat: expectedPayloads[index]! });
    const object = encoder.encode(cmaf, state, context, false, BigInt(index));
    if (object.kind !== 'moof' || object.header.full !== (index === 0)) throw new Error('Expected one full LOCMAF header followed by a delta');
    return serializeLocmafObject(object);
  });
}
const payloads = objects();
function mdat(bytes: Uint8Array): Uint8Array {
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    if (size < 8 || offset + size > bytes.length) throw new Error('Invalid native CMAF boxes');
    if (dec.decode(bytes.subarray(offset + 4, offset + 8)) === 'mdat') return bytes.slice(offset + 8, offset + size);
    offset += size;
  }
  throw new Error('Native media had no mdat');
}

function viBytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(varintEncodingLength(varint(value)));
  writeVarint(varint(value), bytes, 0); return bytes;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; } return bytes;
}
// Draft-14's publisher helper lacks FETCH_OK encoding; this is its §9.17
// wire response, still decoded and validated by the actual client SDK.
function fetchOk14(id: bigint, end: bigint, eot: 0 | 1): Uint8Array {
  const body = concat(viBytes(id), Uint8Array.of(1, eot), viBytes(3n), viBytes(end), Uint8Array.of(0));
  return concat(Uint8Array.of(0x18, body.length >> 8, body.length & 255), body);
}

type WireFetch = { id: bigint; namespace: string[]; name: string; start: { group: bigint; object: bigint }; end: { group: bigint; object: bigint }; filter?: readonly bigint[] };
// Real player + SDK/Session + format consumers. Native append and landing are controlled witnesses, not browser decoding.
async function fixture(draft: 14 | 16 | 18 | 22, live: boolean, indexed: readonly (typeof locations)[number][] = locations) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const subscriptions: Array<{ id: bigint; name: string }> = [], fetches: WireFetch[] = [], errors: string[] = [];
  const legacy = new Map<bigint, WritableStreamDefaultWriter<Uint8Array>>(), opened = new Map<bigint, bigint>();
  const published = new Map<bigint, { group: bigint; object: bigint }>();
  const streams: bigint[] = [], terminals: Array<{ id: bigint; terminal: string }> = [];
  const observers = new Set<MediaAppendObserver>(), nativeBytes: Uint8Array[] = [];
  const submissions: Array<{ bytes: Uint8Array; token: object; completed: boolean }> = [], resources: MediaSeekResource[] = [];
  const placements: Array<MockInstance<CmafAssembler['setPresentationPlacement']>> = [];
  const seeked = vi.fn(), ended = vi.fn();
  let resource: MediaSeekResource | null = null, sample: MediaSeekSample | null = null, nativeTime = 90;
  let positionResolve: ((sample: MediaSeekSample) => void) | undefined;
  const source: MediaSourceLike = { mediaElement: {}, supportsTrackIdentity: true, onFirstFrame: null, onError: null, onStall: null,
    initialize: vi.fn(() => true), appendChunk: vi.fn(), reset: vi.fn(), destroy: vi.fn(), endOfStream: vi.fn(),
    getTimestampOffset: () => 0, setTimestampOffset: vi.fn(), setPlaybackIntent: vi.fn(),
    observeAppends(observer) { observers.add(observer); return () => { observers.delete(observer); }; },
    beginSeek(epoch) {
      resource?.cancel(); sample = null;
      const identity = {};
      const owned: MediaSeekResource = { epoch, resource: identity, get current() { return resource === owned; },
        initialize: vi.fn(() => true), whenAttached: async () => {},
        appendChunk(_role, bytes, _name, _group, token) {
          if (!token) throw new Error('Native append requires an observation token');
          submissions.push({ bytes: bytes.slice(), token, completed: false });
        },
        observeAppends(observer) { observers.add(observer); return () => { observers.delete(observer); }; },
        getTimestampOffset: () => 0, setTimestampOffset: vi.fn(), setPlaybackIntent: vi.fn(),
        position: vi.fn(() => new Promise<MediaSeekSample>(resolve => { positionResolve = resolve; })),
        sample: () => sample && { ...sample, currentTime: nativeTime },
        cancel: vi.fn(() => { if (resource === owned) resource = null; }),
      };
      resource = owned; resources.push(owned); return owned;
    },
  };
  server.onSubscribe = (id, _namespace, name) => { subscriptions.push({ id, name: dec.decode(name) }); };
  server.setLargestLocationProvider(id => {
    const name = subscriptions.find(sub => sub.id === id)?.name;
    const alias = name === 'catalog' ? 100n : name === 'timeline' ? 300n : 200n;
    return published.get(alias) ?? null;
  });
  server.onFetch = (id, message) => {
    const request = message.fetch;
    if (request.fetchType !== 1) throw new Error('Expected standalone historical FETCH');
    const raw = message.parameters.get(0x21n)?.[0];
    fetches.push({ id, namespace: request.trackNamespace.map(field => dec.decode(field)), name: dec.decode(request.trackName),
      start: request.startLocation, end: request.endLocation,
      ...(raw instanceof Uint8Array ? { filter: decodeFetchLocationFilter(raw) } : {}) });
  };
  server.onError = error => { errors.push(`peer: ${error.message}`); };
  const connected = server.connect(b, draft < 18 ? { maxRequestId: varint(1000n) } : {}); void connected.catch(error => { errors.push(String(error)); });
  const player = new MoqtPlayer({ url: 'https://seek-pages.invalid/moq', namespace: ['live', 'show'], draftVersion: draft,
    disableAudio: true, catalogBootstrap: 'subscribe', locmafDecoding: 'mse', logLevel: 'none',
    createConnection: () => client, createTransport: async () => a, createMediaSource: () => source,
    createCmafAssembler: callbacks => {
      const assembler = new CmafAssembler(callbacks); placements.push(vi.spyOn(assembler, 'setPresentationPlacement')); return assembler;
    },
  });
  player.on('error', event => { errors.push(event.error.message); }); player.on('seeked', seeked); player.on('track_ended', ended);
  async function send(alias: bigint, bytes: Uint8Array, group = 0n) {
    const stream = await server.openSubgroup(alias, group, 0n, { publisherPriority: 128 }); streams.push(stream);
    await server.sendObject(stream, 0n, bytes); published.set(alias, { group, object: 0n }); await flush(256);
  }
  try {
    await player.load(); await connected; await flush(256);
    const onDataStream = client.onDataStream;
    client.onDataStream = (id, header) => {
      if (header.type === 'fetch') opened.set(header.header.requestId, id);
      onDataStream?.(id, header);
    };
    const onStreamClosed = client.onStreamClosed;
    client.onStreamClosed = (id, error, terminal) => { terminals.push({ id, terminal }); onStreamClosed?.(id, error, terminal); };
    await server.acceptSubscribe(subscriptions.find(sub => sub.name === 'catalog')!.id, 100n);
    await send(100n, enc.encode(JSON.stringify({ version: '1', initDataList: [{ id: 'video-init', type: 'inline', data: Buffer.from(init).toString('base64') }], tracks: [
      { name: 'video', packaging: 'locmaf', locmafVersion: '0.3', role: 'video', isLive: live, codec: 'avc1.640028', width: 640, height: 360, bitrate: 500000, initRef: 'video-init' },
      { name: 'timeline', packaging: 'mediatimeline', isLive: live, mimeType: 'application/json', depends: ['video'] },
    ] })));
    expect(subscriptions.find(sub => sub.name === 'video'), JSON.stringify({ subscriptions, errors }, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).toBeDefined();
    await server.acceptSubscribe(subscriptions.find(sub => sub.name === 'video')!.id, 200n);
    await server.acceptSubscribe(subscriptions.find(sub => sub.name === 'timeline')!.id, 300n);
    await send(300n, enc.encode(JSON.stringify(live ? indexed : locations.slice(0, 2))));
    expect(source.initialize).toHaveBeenCalledOnce(); player.play(); player.pause();
    async function accept(index: number, endObject: bigint, endOfTrack: 0 | 1) {
      const request = fetches[index]; if (!request) throw new Error(`FETCH ${index + 1} was not issued`);
      if (draft < 18) {
        const bytes = draft === 14 ? fetchOk14(request.id, endObject, endOfTrack)
          : createControlCodec(16).encode({ type: 'FETCH_OK', requestId: varint(request.id), endOfTrack,
            endLocation: { group: 3n, object: endObject }, parameters: new Map([[0x22n, [1n]]]) });
        a.bidiOut[0]!.in.injectRead(bytes);
        await flush(128);
      } else await server.acceptFetch(request.id, { endOfTrack, endLocation: { group: 3n, object: draft === 22 ? endObject - 1n : endObject } });
    }
    async function begin(index: number) {
      const request = fetches[index]; if (!request) throw new Error(`FETCH ${index + 1} was not issued`);
      if (draft >= 18) { const stream = await server.openFetchStream(request.id); await flush(128); return stream; }
      const writer = (await b.createUnidirectionalStream()).getWriter();
      await writer.write(encodeFetchHeader({ requestId: request.id })); await flush(128);
      const stream = opened.get(request.id); if (stream === undefined) throw new Error('Legacy FETCH stream was not identified');
      legacy.set(stream, writer); return stream;
    }
    async function close(stream: bigint) {
      if (legacy.has(stream)) await legacy.get(stream)!.close(); else await server.closeFetchStream(stream);
    }
    return { player, server, fetches, errors, submissions, nativeBytes, resources, placements, seeked, ended, source, terminals,
      accept, begin, close,
      async updateIndex(next: readonly (typeof locations)[number][], group = 1n) { await send(300n, enc.encode(JSON.stringify(next)), group); },
      advance(time: number) { nativeTime = time; },
      async open(index: number, endObject: bigint, endOfTrack: 0 | 1) {
        await accept(index, endObject, endOfTrack); return begin(index);
      },
      async object(stream: bigint, index: number) {
        if (legacy.has(stream)) await legacy.get(stream)!.write(draft === 14
          ? concat(viBytes(3n), viBytes(0n), viBytes(BigInt(index)), Uint8Array.of(128, 0), viBytes(BigInt(payloads[index]!.length)), payloads[index]!)
          : encodeFetchObject({ flags: varint(FetchFlags.GROUP_ID | FetchFlags.OBJECT_ID | FetchFlags.PRIORITY | FetchSubgroupMode.EXPLICIT),
            groupId: 3n, subgroupId: 0n, objectId: BigInt(index), publisherPriority: 128, isDatagram: false, extensions: undefined, payload: payloads[index]! }));
        else await server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: BigInt(index), publisherPriority: 128, payload: payloads[index]! });
        await flush(256);
      },
      complete(index: number) {
        const pending = submissions[index]; if (!pending || pending.completed) throw new Error('Expected one pending native append');
        pending.completed = true; nativeBytes.push(pending.bytes);
        if (sample) sample = { ...sample, buffered: { start: 4, end: 4 + nativeBytes.length * 2 } };
        for (const observer of [...observers]) observer({ token: pending.token, state: 'appended', reason: null });
      },
      land() {
        if (!resource || !positionResolve) throw new Error('Native positioning has not started');
        nativeTime = 5.125; sample = { epoch: resource.epoch, resource: resource.resource, currentTime: nativeTime,
          buffered: { start: 4, end: 4 + nativeBytes.length * 2 } };
        positionResolve(sample);
      },
      async destroy() { for (const stream of streams) await server.closeSubgroup(stream); await player.destroy(); await server.close(); },
    };
  } catch (error) { await player.destroy(); await server.close(); throw error; }
}

it('fixture full+delta preserves exact indexed media time; the delta cannot start a fresh decoder', () => {
  const isolated = new LocmafTrackDecoder(init);
  expect(isolated.push(3n, 1n, payloads[1]!).kind).toBe('rejected');
  const retained = new LocmafTrackDecoder(init);
  for (let index = 0; index < 2; index++) {
    const decoded = retained.push(3n, BigInt(index), payloads[index]!);
    expect(decoded.kind).toBe('chunk');
    if (decoded.kind !== 'chunk') throw new Error('Invalid fixture');
    const rawPts = readFirstSamplePresentationTime(decoded.bytes);
    expect(rawPts).not.toBeNull();
    expect(Math.floor(Number(rawPts) * 1000 / decoded.timescale)).toBe(locations[index]![0]);
    expect(decoded.mdat).toEqual(expectedPayloads[index]);
  }
});

describe.each([14, 16, 18, 22] as const)('public historical page boundary draft %i', draft => {
  it('LIVE starts with the explicitly indexed finite endpoint, not a maximal snapshot', async () => {
    const f = await fixture(draft, true);
    try {
      const plan = planSeekFetchPage({ draftVersion: draft, trackName: 'video', timeline: { entries, depends: ['video'], isLive: true },
        cut: { kind: 'before', groupId: 3n, objectId: 0n }, endOfTrack: false });
      expect(plan).toMatchObject({ kind: 'fetch-page', end: { groupId: 3n, objectId: 1n } });
      await f.player.seek(5000); await flush(512);
      expect(f.fetches).toHaveLength(1); expect(f.errors).toEqual([]);
      expect(f.fetches[0]).toMatchObject({ namespace: ['live', 'show'], name: 'video', start: { group: 3n, object: 0n } });
      expect(f.fetches[0]!.end).toEqual({ group: 3n, object: 1n });
      if (draft === 22) expect(f.fetches[0]!.filter).toEqual([3n, 0n, 0n, 0n]);
    } finally { await f.destroy(); }
  });

  it('LIVE page FIN retains the consumer so the next delta reaches the same native output', async () => {
    const f = await fixture(draft, true);
    try {
      await f.player.seek(5000); await flush(512);
      expect(f.fetches[0]!.end).toEqual({ group: 3n, object: 1n });
      if (draft === 22) expect(f.fetches[0]!.filter).toEqual([3n, 0n, 0n, 0n]);
      const first = await f.open(0, 1n, 0); await f.object(first, 0); await f.close(first); await flush(256);
      expect(f.submissions).toHaveLength(1); expect(f.nativeBytes).toHaveLength(0); expect(f.seeked).not.toHaveBeenCalled();
      f.complete(0); await flush(256); f.land(); await flush(1024);
      expect(f.nativeBytes.map(mdat)).toEqual([expectedPayloads[0]]);
      expect(f.nativeBytes.map(readFirstSamplePresentationTime)).toEqual([4000n]);
      expect(f.player.playbackPositionMs).toBe(5125); expect(f.seeked).toHaveBeenCalledOnce(); expect(f.ended).not.toHaveBeenCalled();
      expect(f.terminals.some(item => item.id === first && item.terminal === 'fin')).toBe(true);
      expect(f.errors).toEqual([]);
      expect(f.fetches, 'accepted first page + FIN + native work settled must issue the next indexed range').toHaveLength(2);
      expect(f.fetches[1]).toMatchObject({ start: { group: 3n, object: 1n }, end: { group: 3n, object: 2n } });
      if (draft === 22) expect(f.fetches[1]!.filter).toEqual([3n, 1n, 0n, 1n]);
      const second = await f.open(1, 2n, 0); await f.object(second, 1);
      expect(f.submissions).toHaveLength(2); expect(f.nativeBytes).toHaveLength(1);
      f.complete(1); await f.close(second); await flush(512);
      expect(f.nativeBytes.map(mdat)).toEqual(expectedPayloads);
      expect(f.nativeBytes.map(readFirstSamplePresentationTime)).toEqual([4000n, 6000n]);
      expect(f.resources).toHaveLength(1); expect(f.resources[0]!.initialize).toHaveBeenCalledOnce();
      expect(f.placements.flatMap(spy => spy.mock.calls)).toEqual([['video', { sourceTimeUs: 4_000_000n, rebasedTimeUs: { numerator: 4_000_000n, denominator: 1n } }]]);
      expect(f.resources[0]!.position).toHaveBeenCalledExactlyOnceWith(5);
      expect(f.seeked).toHaveBeenCalledOnce(); expect(f.ended).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('finite VOD completes once and retains the positioned role for a later rendition change', async () => {
    const f = await fixture(draft, false);
    const started = vi.spyOn(MseSeekPlayback.prototype, 'start');
    try {
      await f.player.seek(5000); await flush(512);
      expect(f.fetches[0]!.end).toEqual({ group: draft >= 18 ? MAX_VI64 : MAX_VARINT, object: 0n });
      const stream = await f.open(0, 2n, 1); await f.object(stream, 0); await f.object(stream, 1);
      await f.close(stream); await flush(256);
      expect(f.submissions).toHaveLength(1); expect(f.nativeBytes).toHaveLength(0); expect(f.seeked).not.toHaveBeenCalled();
      f.complete(0); await flush(256); expect(f.submissions).toHaveLength(2); f.land(); await flush(256);
      expect(f.ended).not.toHaveBeenCalled(); f.complete(1); await flush(1024);
      expect(f.nativeBytes.map(mdat)).toEqual(expectedPayloads); expect(f.fetches).toHaveLength(1);
      expect(f.nativeBytes.map(readFirstSamplePresentationTime)).toEqual([4000n, 6000n]);
      expect(f.resources).toHaveLength(1); expect(f.resources[0]!.initialize).toHaveBeenCalledOnce();
      expect(f.placements.flatMap(spy => spy.mock.calls)).toHaveLength(1);
      expect(f.resources[0]!.position).toHaveBeenCalledExactlyOnceWith(5); expect(f.player.playbackPositionMs).toBe(5125);
      expect(f.seeked).toHaveBeenCalledOnce(); expect(f.ended).toHaveBeenCalledExactlyOnceWith({ type: 'track_ended', mediaType: 'video' });
      expect(f.errors).toEqual([]);
      expect(started).toHaveBeenCalledOnce();
      const actor = started.mock.contexts[0] as MseSeekPlayback;
      const owner = actor.roleOwner('video');
      expect(owner, 'EOT ends retrieval, not ownership of the positioned media graph').not.toBeNull();
      const tick = vi.spyOn(actor, 'tick');
      f.player.tick(); f.player.tick();
      expect(tick, 'a completed retrieval must not sample dormant read credit').not.toHaveBeenCalled();
      expect(f.ended).toHaveBeenCalledOnce();
      const hold = actor.holdRole('video', owner!);
      await hold.nativeSettled;
      expect(hold.current).toBe(true);
      hold.resume();
      expect(actor.roleOwner('video')).toBe(owner);
    } finally {
      const actor = started.mock.contexts[0] as MseSeekPlayback | undefined;
      await f.destroy(); started.mockRestore();
      expect(actor?.roleOwner('video')).toBeNull();
      expect(f.resources[0]?.cancel).toHaveBeenCalledOnce();
    }
  });
  it('waits at the indexed tip and resumes only when that same timeline proves another range', async () => {
    const f = await fixture(draft, true, locations.slice(0, 2));
    try {
      await f.player.seek(5000); await flush(256);
      const first = await f.open(0, 1n, 0); await f.object(first, 0); await f.close(first); await flush(256);
      f.complete(0); await flush(128); f.land(); await flush(512);
      expect(f.fetches).toHaveLength(1); expect(f.ended).not.toHaveBeenCalled();
      f.player.play(); await flush(512);
      expect(f.errors).toEqual([]);
      await f.updateIndex(locations.slice(0, 2)); await flush(512);
      expect(f.fetches).toHaveLength(1);
      await f.updateIndex(locations, 2n); await flush(512);
      expect(f.fetches).toHaveLength(2);
      expect(f.fetches[1]).toMatchObject({ start: { group: 3n, object: 1n }, end: { group: 3n, object: 2n } });
      const second = await f.open(1, 2n, 0); await f.object(second, 1); f.complete(1); await f.close(second); await flush(512);
      expect(f.nativeBytes.map(mdat)).toEqual(expectedPayloads);
      expect(f.resources).toHaveLength(1); expect(f.seeked).toHaveBeenCalledOnce(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('keeps a successor delta and FIN inert until its own acceptance without reinitializing output', async () => {
    const f = await fixture(draft, true);
    try {
      await f.player.seek(5000); await flush(256);
      const first = await f.open(0, 1n, 0); await f.object(first, 0); await f.close(first); await flush(128);
      f.complete(0); await flush(128); f.land(); await flush(512);
      expect(f.fetches).toHaveLength(2);
      const second = await f.begin(1); await f.object(second, 1); await f.close(second); await flush(512);
      expect(f.submissions).toHaveLength(1); expect(f.nativeBytes.map(mdat)).toEqual([expectedPayloads[0]]);
      expect(f.resources).toHaveLength(1); expect(f.seeked).toHaveBeenCalledOnce();
      await f.accept(1, 2n, 0); await flush(256);
      expect(f.submissions).toHaveLength(2); f.complete(1); await flush(512);
      expect(f.nativeBytes.map(mdat)).toEqual(expectedPayloads);
      expect(f.nativeBytes.map(readFirstSamplePresentationTime)).toEqual([4000n, 6000n]);
      expect(f.resources).toHaveLength(1); expect(f.resources[0]!.initialize).toHaveBeenCalledOnce();
      expect(f.resources[0]!.position).toHaveBeenCalledOnce(); expect(f.seeked).toHaveBeenCalledOnce();
      expect(f.errors).toEqual([]); expect(f.ended).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });

  it('preserves accepted playback and its clock when a later indexed range is refused', async () => {
    const f = await fixture(draft, true);
    try {
      await f.player.seek(5000); await flush(256);
      const first = await f.open(0, 1n, 0); await f.object(first, 0); await f.close(first); await flush(128);
      f.complete(0); await flush(128); f.land(); await flush(512);
      expect(f.fetches).toHaveLength(2);
      await f.server.rejectFetch(f.fetches[1]!.id, 3n, 'history no longer cached'); await flush(512);
      expect(f.errors).toHaveLength(1); expect(f.errors[0]).toMatch(/Historical video retrieval stopped/);
      expect(f.player.state).toBe('paused'); expect(f.resources[0]!.current).toBe(true);
      f.advance(5.5); expect(f.player.playbackPositionMs).toBe(5125); // Paused reads stay cached.
      f.player.play(); await flush(512);
      expect(f.player.playbackPositionMs).toBe(5500);
      expect(f.nativeBytes.map(mdat)).toEqual([expectedPayloads[0]]);
      expect(f.resources).toHaveLength(1); expect(f.resources[0]!.initialize).toHaveBeenCalledOnce();
      expect(f.seeked).toHaveBeenCalledOnce(); expect(f.ended).not.toHaveBeenCalled();
      await f.updateIndex(locations); await flush(512);
      expect(f.fetches).toHaveLength(2); expect(f.errors).toHaveLength(1);
    } finally { await f.destroy(); }
  });

  it.each([false, true])('preserves the accepted native position witness; already landed %s', async landed => {
    const f = await fixture(draft, true);
    try {
      await f.player.seek(5000); await flush(512);
      const first = await f.open(0, 1n, 0); await f.object(first, 0);
      await f.close(first); await flush(256);
      expect(f.resources).toHaveLength(1); expect(f.submissions).toHaveLength(1);
      expect(f.nativeBytes).toHaveLength(0); f.complete(0); await flush(512);
      expect(f.resources[0]!.position).toHaveBeenCalledExactlyOnceWith(5);
      expect(f.fetches).toHaveLength(2);
      if (landed) { f.land(); await flush(256); expect(f.seeked).toHaveBeenCalledOnce(); }
      else expect(f.seeked).not.toHaveBeenCalled();
      await f.server.rejectFetch(f.fetches[1]!.id, 3n, 'fixture next page unavailable'); await flush(512);
      expect(f.player.state).toBe('paused'); expect(f.resources[0]!.current).toBe(true);
      expect(f.resources[0]!.cancel).not.toHaveBeenCalled();
      expect(f.player.playbackPositionMs).toBe(landed ? 5125 : 5000);
      if (!landed) { f.land(); await flush(256); }
      expect(f.seeked).toHaveBeenCalledOnce(); expect(f.player.playbackPositionMs).toBe(5125);
      expect(f.fetches).toHaveLength(2); expect(f.errors).toHaveLength(1);
    } finally { await f.destroy(); }
  });
  it('prepares a live target at the only indexed Object with a finite exact endpoint', async () => {
    const f = await fixture(draft, true, locations.slice(0, 1));
    try {
      await f.player.seek(5000); await flush(512);
      expect(f.fetches).toHaveLength(1);
      expect(f.fetches[0]).toMatchObject({ start: { group: 3n, object: 0n }, end: { group: 3n, object: 1n } });
      const stream = await f.open(0, 1n, 1); await f.object(stream, 0); await f.close(stream); await flush(256);
      expect(f.submissions).toHaveLength(1); f.complete(0); await flush(128); f.land(); await flush(512);
      expect(f.nativeBytes.map(mdat)).toEqual([expectedPayloads[0]]); expect(f.resources).toHaveLength(1);
      expect(f.player.playbackPositionMs).toBe(5125); expect(f.seeked).toHaveBeenCalledOnce();
      expect(f.ended).toHaveBeenCalledExactlyOnceWith({ type: 'track_ended', mediaType: 'video' });
      expect(f.fetches).toHaveLength(1); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

});

describe.each([18, 22] as const)('seek role error authority draft %s', draft => {
  it.each([false, true])('rechecks role ownership after a native getter cancels it: %s', async cancelRole => {
    const f = await fixture(draft, true);
    try {
      await f.player.seek(5000); await flush(256);
      const first = await f.open(0, 1n, 0);
      await f.object(first, 0); await f.close(first); await flush(128);
      f.complete(0); await flush(128); f.land(); await flush(512);
      expect(f.fetches).toHaveLength(2); expect(f.errors).toEqual([]);
      type SeekOwners = { activeMseSeek: { retrievals: ReadonlyMap<'video', { cancel(): void }> } | null };
      const video = (f.player as unknown as SeekOwners).activeMseSeek!.retrievals.get('video')!;
      const resource = f.resources[0]!, descriptor = Object.getOwnPropertyDescriptor(resource, 'current')!;
      let reads = 0, once = true;
      Object.defineProperty(resource, 'current', { configurable: true, get() {
        reads++;
        if (once) { once = false; if (cancelRole) video.cancel(); }
        return descriptor.get!.call(resource);
      } });
      await f.server.rejectFetch(f.fetches[1]!.id, 3n, 'range no longer cached'); await flush(512);
      expect(reads).toBeGreaterThan(0); expect(f.player.state).toBe('paused');
      if (cancelRole) expect(f.errors).toEqual([]);
      else { expect(f.errors).toHaveLength(1); expect(f.errors[0]).toMatch(/Historical video retrieval stopped/); }
    } finally { await f.destroy(); }
  });
});

describe('retention lifecycle boundaries',()=>{
  async function finish(f:Awaited<ReturnType<typeof fixture>>) {
    await f.player.seek(5000);await flush(512);
    const stream=await f.open(0,2n,1);await f.object(stream,0);await f.object(stream,1);await f.close(stream);await flush(256);
    f.complete(0);await flush(256);f.land();await flush(256);f.complete(1);await flush(1024);
  }
  it('destroy from track_ended revokes retained host and hold without repeated completion',async()=>{
    const started=vi.spyOn(MseSeekPlayback.prototype,'start');const f=await fixture(18,false);
    let destroy:Promise<void>|undefined,hold:ReturnType<MseSeekPlayback['holdRole']>|undefined;
    try {
      f.player.on('track_ended',()=>{
        const actor=started.mock.contexts[0] as MseSeekPlayback,owner=actor.roleOwner('video');
        expect(owner).not.toBeNull();hold=actor.holdRole('video',owner!);void hold.nativeSettled.catch(()=>{});expect(hold.current).toBe(true);
        destroy=f.player.destroy();
      });
      await finish(f);await destroy;await flush(512);
      const actor=started.mock.contexts[0] as MseSeekPlayback;
      expect(actor.roleOwner('video')).toBeNull();expect(hold!.current).toBe(false);expect(f.resources[0]!.current).toBe(false);
      f.player.tick();await flush(256);expect(f.ended).toHaveBeenCalledOnce();expect(f.fetches).toHaveLength(1);expect(f.errors).toEqual([]);
    } finally {await f.destroy();started.mockRestore();}
  });
  it('new seek keeps completed host until native replacement then revokes held ownership',async()=>{
    const started=vi.spyOn(MseSeekPlayback.prototype,'start');const f=await fixture(22,false);
    try {
      await finish(f);const actor=started.mock.contexts[0] as MseSeekPlayback,owner=actor.roleOwner('video');expect(owner).not.toBeNull();
      const hold=actor.holdRole('video',owner!);await hold.nativeSettled;expect(hold.current).toBe(true);
      await f.player.seek(5000);await flush(512);expect(f.fetches).toHaveLength(2);
      expect(actor.roleOwner('video')).toBe(owner);expect(hold.current).toBe(true);expect(f.resources).toHaveLength(1);
      const next=await f.open(1,2n,1);await f.object(next,0);await f.object(next,1);await f.close(next);await flush(512);
      expect(f.resources).toHaveLength(2);expect(actor.roleOwner('video')).toBeNull();expect(hold.current).toBe(false);
      expect(f.resources[0]!.current).toBe(false);expect(f.resources[1]!.current).toBe(true);
      expect(f.ended).toHaveBeenCalledOnce();expect(f.errors).toEqual([]);
    } finally {await f.destroy();started.mockRestore();}
  });
});
