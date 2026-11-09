import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { decodeFetchLocationFilter, decodeSubscriptionFilter, decodeFillParameters, MessageParam, varint, type ControlMessage, type DataStreamHeader } from '@openmoq/transport';
import { MoqtConnection } from '@openmoq/webtransport';
import { LocmafEncoder, LocmafGroupState, LocmafTrackDecoder, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { readFirstSamplePresentationTime } from '../../browser/src/mp4-box.js';
import { buildInit, buildChunk, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { MoqtPlayer } from './player.js';
import type { MediaAppendObserver, MediaSeekResource, MediaSeekSample, MediaSourceLike } from './interfaces.js';

afterEach(() => vi.useRealTimers());
const enc = new TextEncoder(), dec = new TextDecoder();
const init = buildInit({ trackId: 1, timescale: 1000, handler: 'vide' });
const locations = [[4000, [3, 0], 0], [6000, [3, 1], 0], [8000, [3, 2], 0]] as const;
const expectedPayloads = [Uint8Array.of(41, 42, 43, 44), Uint8Array.of(51, 52, 53, 54), Uint8Array.of(61, 62, 63, 64), Uint8Array.of(71, 72, 73, 74)];

function objects() {
  const encoder = new LocmafEncoder(), state = new LocmafGroupState(), context = parseLocmafTrackContext(init);
  return [4000n, 6000n, 8000n, 10000n].map((bmdt, index) => {
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

type WireFetch = { id: bigint; namespace: string[]; name: string; start: { group: bigint; object: bigint }; end: { group: bigint; object: bigint }; filter?: readonly bigint[] };
// Real player + SDK/Session + format consumers. Native append and landing are controlled witnesses, not browser decoding.
async function fixture(draft: 18 | 22, live: boolean, indexed: readonly (typeof locations)[number][] = locations, options: {connectionTimeoutMs?:number} = {}) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft, { terminatedAliasTtlMs: 50 }), server = new MoqtConnection(draft, { role: 'server' });
  const subscriptions: Array<{ id: bigint; namespace: string[]; name: string; message: ControlMessage }> = [], fetches: WireFetch[] = [], errors: string[] = [];
  const joins: Array<{ id: bigint; message: ControlMessage }> = [], headers: Array<{ id: bigint; header: DataStreamHeader }> = [];
  const wire = vi.spyOn(server.session, 'handleControlMessage');
  const opened = new Map<bigint, bigint>();
  const published = new Map<bigint, { group: bigint; object: bigint }>();
  const streams: bigint[] = [], terminals: Array<{ id: bigint; terminal: string }> = [];
  const observers = new Set<MediaAppendObserver>(), nativeBytes: Uint8Array[] = [];
  const submissions: Array<{ bytes: Uint8Array; token: object; completed: boolean; owner: MediaSeekResource }> = [], resources: MediaSeekResource[] = [];
  const nativeByResource = new Map<MediaSeekResource, Uint8Array[]>();
  const coverage = (owner: MediaSeekResource) => ({ start:4, end:4+(nativeByResource.get(owner)?.length ?? 0)*2 });
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
          submissions.push({ bytes: bytes.slice(), token, completed: false, owner: owned });
        },
        observeAppends(observer) { observers.add(observer); return () => { observers.delete(observer); }; },
        getTimestampOffset: () => 0, setTimestampOffset: vi.fn(), setPlaybackIntent: vi.fn(),
        position: vi.fn(() => new Promise<MediaSeekSample>(resolve => { positionResolve = resolve; })),
        sample: () => sample && { ...sample, currentTime: nativeTime },
        cancel: vi.fn(() => { if (resource === owned) resource = null; }),
      };
      resource = owned; resources.push(owned); nativeByResource.set(owned,[]); return owned;
    },
  };
  server.onSubscribe = (id, namespace, name) => {
    const message = wire.mock.calls.map(([message]) => message).find(message => message.type === 'SUBSCRIBE' && message.requestId === id);
    if (!message || message.type !== 'SUBSCRIBE') throw new Error('Missing actual decoded SUBSCRIBE');
    subscriptions.push({ id, namespace: namespace.map(field => dec.decode(field)), name: dec.decode(name), message });
  };
  server.setLargestLocationProvider(id => {
    const name = subscriptions.find(sub => sub.id === id)?.name;
    const alias = name === 'catalog' ? 100n : name === 'timeline' ? 300n : 200n;
    return published.get(alias) ?? null;
  });
  server.onFetch = (id, message) => {
    const request = message.fetch;
    if (request.fetchType !== 1) { joins.push({ id, message }); return; }
    const raw = message.parameters.get(0x21n)?.[0];
    fetches.push({ id, namespace: request.trackNamespace.map(field => dec.decode(field)), name: dec.decode(request.trackName),
      start: request.startLocation, end: request.endLocation,
      ...(raw instanceof Uint8Array ? { filter: decodeFetchLocationFilter(raw) } : {}) });
  };
  server.onError = error => { errors.push(`peer: ${error.message}`); };
  const connected = server.connect(b); void connected.catch(error => { errors.push(String(error)); });
  const player = new MoqtPlayer({ url: 'https://seek-live.invalid/moq', namespace: ['live', 'show'], draftVersion: draft,
    connectionTimeoutMs: options.connectionTimeoutMs ?? 10_000, disableAudio: true, catalogBootstrap: 'subscribe', locmafDecoding: 'mse', logLevel: 'none',
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
      headers.push({ id, header });
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
      await server.acceptFetch(request.id, { endOfTrack, endLocation: { group: 3n, object: draft === 22 ? endObject - 1n : endObject } });
    }
    async function begin(index: number) {
      const request = fetches[index]; if (!request) throw new Error(`FETCH ${index + 1} was not issued`);
      const stream = await server.openFetchStream(request.id); await flush(128); return stream;
    }
    async function close(stream: bigint) {
      await server.closeFetchStream(stream);
    }
    return { player, client, server, a, b, draft, subscriptions, joins, headers, wire, opened, fetches, errors, submissions, nativeBytes, resources, placements, seeked, ended, source, terminals, nativeByResource,
      accept, begin, close,
      async updateIndex(next: readonly (typeof locations)[number][], group = 1n) { await send(300n, enc.encode(JSON.stringify(next)), group); },
      advance(time: number) { nativeTime = time; },
      publishHead(head: {group:bigint;object:bigint}) { published.set(200n,head); },
      async liveObject(index: number, close = true) {
        const stream = await server.openSubgroup(201n,3n,BigInt(index),{publisherPriority:128}); streams.push(stream);
        await server.sendObject(stream,BigInt(index),payloads[index]!); published.set(200n,{group:3n,object:BigInt(index)}); if(close) await server.closeSubgroup(stream);
        await flush(512); return stream;
      },
      async open(index: number, endObject: bigint, endOfTrack: 0 | 1) {
        await accept(index, endObject, endOfTrack); return begin(index);
      },
      async object(stream: bigint, index: number) {
        await server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: BigInt(index), publisherPriority: 128, payload: payloads[index]! });
        await flush(256);
      },
      complete(index: number) {
        const pending = submissions[index]; if (!pending || pending.completed) throw new Error('Expected one pending native append');
        pending.completed = true; nativeBytes.push(pending.bytes); nativeByResource.get(pending.owner)!.push(pending.bytes);
        if (sample && resource === pending.owner && sample.resource === pending.owner.resource) sample = { ...sample, buffered: coverage(pending.owner) };
        for (const observer of [...observers]) observer({ token: pending.token, state: 'appended', reason: null });
      },
      land(time = 5.125) {
        if (!resource || !positionResolve) throw new Error('Native positioning has not started');
        nativeTime = time; sample = { epoch: resource.epoch, resource: resource.resource, currentTime: nativeTime,
          buffered: coverage(resource) };
        positionResolve(sample);
      },
      async destroy() { for (const stream of streams) await server.closeSubgroup(stream); await player.destroy(); await server.close(); },
    };
  } catch (error) { await player.destroy(); await server.close(); throw error; }
}


async function landHistory(f: Awaited<ReturnType<typeof fixture>>) {
  await f.player.seek(5000); await flush(512);
  expect(f.fetches).toHaveLength(1);
  expect(f.fetches[0]).toMatchObject({ namespace:['live','show'], name:'video', start:{group:3n,object:0n}, end:{group:3n,object:2n} });
  const stream = await f.open(0, 2n, 0);
  await f.object(stream, 0); await f.object(stream, 1); await f.close(stream); await flush(256);
  expect(f.submissions).toHaveLength(1); expect(f.seeked).not.toHaveBeenCalled();
  f.complete(0); await flush(512);
  expect(f.submissions).toHaveLength(2); f.complete(1); await flush(512);
  f.land(); await flush(1024);
  expect(f.nativeBytes.map(mdat)).toEqual(expectedPayloads.slice(0,2));
  expect(f.nativeBytes.map(readFirstSamplePresentationTime)).toEqual([4000n,6000n]);
  expect(f.resources).toHaveLength(1); expect(f.resources[0]!.initialize).toHaveBeenCalledOnce();
  expect(f.resources[0]!.position).toHaveBeenCalledExactlyOnceWith(5);
  expect(f.player.playbackPositionMs).toBe(5125); expect(f.seeked).toHaveBeenCalledOnce();
  expect(f.ended).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
}

it('valid MSF01 initRef fixture has one full object and three dependent deltas at exact indexed/raw times', () => {
  const retained = new LocmafTrackDecoder(init);
  for (let i=0;i<4;i++) {
    if (i) expect(new LocmafTrackDecoder(init).push(3n,BigInt(i),payloads[i]!).kind).toBe('rejected');
    const decoded = retained.push(3n,BigInt(i),payloads[i]!); expect(decoded.kind).toBe('chunk');
    if(decoded.kind!=='chunk') throw new Error('Invalid LOCMAF fixture');
    expect(readFirstSamplePresentationTime(decoded.bytes)).toBe(BigInt(4000+2000*i));
    expect(decoded.mdat).toEqual(expectedPayloads[i]);
  }
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function freshLiveSubscription(f: Fixture) {
  const media=f.subscriptions.filter(sub=>sub.name==='video');
  expect(media, 'after finite history FIN, native append and landing, public seek must probe live with a fresh SUBSCRIBE').toHaveLength(2);
  const sub=media[1]!; expect(sub.id).not.toBe(media[0]!.id);
  expect(sub.namespace).toEqual(['live','show']); expect(sub.name).toBe('video');
  if(sub.message.type!=='SUBSCRIBE') throw new Error('Missing actual SUBSCRIBE');
  const filter=sub.message.parameters.get(MessageParam.SUBSCRIPTION_FILTER)?.[0];
  if(!(filter instanceof Uint8Array)) throw new Error('Missing encoded live subscription filter');
  expect(decodeSubscriptionFilter(filter,f.draft)).toEqual({type:'LargestObject'});
  expect(sub.message.parameters.get(MessageParam.GROUP_ORDER)).toEqual([1n]);
  expect(sub.message.parameters.has(0x23n)).toBe(f.draft===22);
  expect(f.fetches).toHaveLength(1); return sub;
}
async function acknowledgeLive(f: Fixture, sub: Awaited<ReturnType<typeof freshLiveSubscription>>, hold=false,
    head={group:3n,object:2n}) {
  const response=f.a.bidiOut.at(-1)!.in;
  if(hold) response.faults.hold=true;
  f.publishHead(head);
  await f.server.acceptSubscribe(sub.id,201n,{parameters:new Map([[MessageParam.LARGEST_OBJECT,[head]]])});
  await flush(512); return response;
}
async function retainedHandoff(f: Fixture, early: boolean, beforeNativePrefixComplete?: () => Promise<void>) {
  await landHistory(f); const sub=await freshLiveSubscription(f);
  f.player.play(); await flush(256);
  const response=await acknowledgeLive(f,sub,early);
  let prefix: bigint;
  if(f.draft===22) {
    expect(f.joins).toEqual([]);
    const raw=sub.message.type==='SUBSCRIBE'?sub.message.parameters.get(0x23n)?.[0]:undefined;
    if(!(raw instanceof Uint8Array)) throw new Error('Missing actual FILL_PARAMETERS');
    expect(decodeFillParameters(raw)).toMatchObject({filter:{type:'AbsoluteStart',startGroup:3n,startObject:2n},groupOrder:'ascending'});
    prefix=await f.server.openFillStream(sub.id);
    if(early) {
      await f.liveObject(3); await f.object(prefix,2); await f.close(prefix); await flush(512);
      expect(f.submissions).toHaveLength(2); response.releaseHeld(); await flush(1024);
    } else {
      await f.object(prefix,2); await f.close(prefix); await f.liveObject(3);
    }
    expect(f.headers.some(({header})=>header.type==='fetch'&&header.fill&&header.header.requestId===sub.id)).toBe(true);
  } else {
    if(early) {
      await f.liveObject(3); expect(f.submissions).toHaveLength(2);
      response.releaseHeld(); await flush(1024);
    }
    expect(f.joins).toHaveLength(1);
    const join=f.joins[0]!; expect(join.message.type).toBe('FETCH');
    if(join.message.type!=='FETCH') throw new Error('Missing actual Joining FETCH');
    expect(join.message.fetch).toEqual({fetchType:3,joiningRequestId:sub.id,joiningStart:3n});
    const range=f.server.resolveJoiningFetch(join.id);
    expect(range.startLocation).toEqual({group:3n,object:0n}); expect(range.endLocation).toEqual({group:3n,object:3n});
    if(!early) await f.server.acceptFetch(join.id,{endLocation:range.endLocation});
    prefix=await f.server.openFetchStream(join.id);
    // Immutable replay0/1 is real JOIN input. It must not advance/reset the retained decoder.
    await f.object(prefix,0); await f.object(prefix,1); await f.object(prefix,2); await f.close(prefix);
    if(early) await f.server.acceptFetch(join.id,{endLocation:range.endLocation});
    else await f.liveObject(3);
    await flush(1024);
  }
  expect(f.submissions).toHaveLength(3); expect(f.nativeBytes).toHaveLength(2);
  await beforeNativePrefixComplete?.();
  f.complete(2); await flush(1024);
  expect(f.terminals.some(item=>item.id===prefix&&item.terminal==='fin')).toBe(true);
  // Native output submits the next chunk, then its completion holds forward input credit.
  expect(f.submissions).toHaveLength(4); expect(f.nativeBytes).toHaveLength(3);
  expect(f.errors).toEqual([]); expect(f.ended).not.toHaveBeenCalled(); return sub;
}
function exactRetainedOutput(f: Fixture) {
  expect(f.nativeBytes.map(mdat)).toEqual(expectedPayloads);
  expect(f.nativeBytes.map(readFirstSamplePresentationTime)).toEqual([4000n,6000n,8000n,10000n]);
  expect(f.resources).toHaveLength(1); expect(f.resources[0]!.initialize).toHaveBeenCalledOnce();
  expect(f.resources[0]!.position).toHaveBeenCalledExactlyOnceWith(5);
  expect(f.resources[0]!.cancel).not.toHaveBeenCalled();
  expect(f.placements.flatMap(spy=>spy.mock.calls)).toEqual([['video',{sourceTimeUs:4_000_000n,rebasedTimeUs:{numerator:4_000_000n,denominator:1n}}]]);
  expect(f.source.reset).not.toHaveBeenCalled(); expect(f.seeked).toHaveBeenCalledOnce(); expect(f.errors).toEqual([]);
}

describe.each([18,22] as const)('public historical-to-live boundary draft %i', draft => {
  it('healthy indexed history lands through real LOCMAF and actual native append without a fabricated live head', async () => {
    const f=await fixture(draft,true);
    try { await landHistory(f); }
    finally { await f.destroy(); }
  });
  it('issues fresh same-identity LargestObject SUB and retains one native output across prefix/live',async()=>{
    const f=await fixture(draft,true);
    try {
      await retainedHandoff(f,false); f.complete(3); await flush(512);
      expect(f.player.playbackPositionMs).toBe(5125);
      f.advance(7.125); f.player.tick(); await flush(1024);
      expect(f.player.playbackPositionMs).toBe(7125); exactRetainedOutput(f);
      expect(f.fetches).toHaveLength(1); expect(f.subscriptions.filter(sub=>sub.name==='video')).toHaveLength(2);
      expect(f.ended).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });
});



it('native prefix append and forward credit can outlast connectionTimeout without becoming a peer-wait failure',async()=>{
  vi.useFakeTimers({shouldClearNativeTimers:true});
  const f=await fixture(18,true,locations,{connectionTimeoutMs:100});
  try{
    const sub=await retainedHandoff(f,false,async()=>{
      await vi.advanceTimersByTimeAsync(250);await flush(1024);
      expect(f.player.state).toBe('playing');expect(f.errors).toEqual([]);
      expect(f.submissions).toHaveLength(3);expect(f.nativeBytes).toHaveLength(2);
      expect(f.resources[0]!.current).toBe(true);
    });
    f.complete(3);await flush(512);
    await f.server.publishDone(sub.id,varint(2n),'finite live source');await flush(512);
    await vi.advanceTimersByTimeAsync(250);await flush(1024);
    expect(f.player.state).toBe('playing');expect(f.player.playbackPositionMs).toBe(5125);
    expect(f.errors).toEqual([]);expect(f.ended).not.toHaveBeenCalled();
    f.advance(7.125);f.player.tick();await flush(1024);
    exactRetainedOutput(f);expect(f.ended).toHaveBeenCalledExactlyOnceWith({type:'track_ended',mediaType:'video'});
  }finally{await f.destroy();}
});

it('an idle accepted prefix times out as degraded while preserving the landed native clock and resource',async()=>{
  vi.useFakeTimers({shouldClearNativeTimers:true});
  const f=await fixture(22,true,locations,{connectionTimeoutMs:100});
  try{
    await landHistory(f);const sub=await freshLiveSubscription(f);f.player.play();await flush(256);
    await acknowledgeLive(f,sub);await f.server.openFillStream(sub.id);await flush(512);
    await vi.advanceTimersByTimeAsync(99);await flush(256);expect(f.errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);await flush(1024);
    expect(f.errors).toHaveLength(1);expect(f.errors[0]).toMatch(/peer wait timed out/);
    expect(f.resources).toHaveLength(1);expect(f.resources[0]!.current).toBe(true);expect(f.resources[0]!.cancel).not.toHaveBeenCalled();
    expect(f.nativeBytes.map(mdat)).toEqual(expectedPayloads.slice(0,2));expect(f.submissions).toHaveLength(2);
    f.advance(5.5);expect(f.player.playbackPositionMs).toBe(5500);expect(f.player.state).toBe('playing');
    expect(f.seeked).toHaveBeenCalledOnce();expect(f.ended).not.toHaveBeenCalled();
  }finally{await f.destroy();}
});

it('a refused pending live probe preserves the native output and does not repeat for an unchanged index',async()=>{
  vi.useFakeTimers({shouldClearNativeTimers:true});
  const f=await fixture(18,true,locations,{connectionTimeoutMs:100});
  try{
    await landHistory(f);const sub=await freshLiveSubscription(f);f.player.play();await flush(256);
    await f.server.rejectSubscribe(sub.id,3n,'fixture live probe refused');await flush(1024);
    expect(f.errors).toHaveLength(1);expect(f.errors[0]).toMatch(/Live video continuation unavailable/);
    await f.updateIndex(locations);for(let i=0;i<3;i++){f.player.tick();await flush(256);}
    await vi.advanceTimersByTimeAsync(250);await flush(1024);
    expect(f.errors).toHaveLength(1);expect(f.subscriptions.filter(s=>s.name==='video')).toHaveLength(2);expect(f.fetches).toHaveLength(1);
    expect(f.resources).toHaveLength(1);expect(f.resources[0]!.current).toBe(true);expect(f.resources[0]!.cancel).not.toHaveBeenCalled();
    f.advance(5.5);expect(f.player.playbackPositionMs).toBe(5500);expect(f.player.state).toBe('playing');
    expect(f.nativeBytes.map(mdat)).toEqual(expectedPayloads.slice(0,2));expect(f.ended).not.toHaveBeenCalled();
  }finally{await f.destroy();}
});


it('a committed successor seek retires its predecessor probe before late ACK/prefix can touch the current native resource',async()=>{
  const f=await fixture(22,true);
  try{
    await landHistory(f);const sub=await freshLiveSubscription(f);
    const request=f.a.bidiOut.at(-1)!;const response=await acknowledgeLive(f,sub,true);
    const prefix=await f.server.openFillStream(sub.id);await f.object(prefix,2);await f.close(prefix);await flush(512);
    expect(f.submissions).toHaveLength(2);
    await f.player.seek(6000);await flush(512);
    // Admission preserves the previous active output while the successor prepares.
    expect(f.fetches).toHaveLength(2);expect(f.resources).toHaveLength(1);expect(f.resources[0]!.current).toBe(true);
    expect(f.fetches[1]).toMatchObject({start:{group:3n,object:0n},end:{group:3n,object:2n}});
    const history=await f.open(1,2n,0);await f.object(history,0);await f.object(history,1);await f.close(history);await flush(512);
    expect(f.resources).toHaveLength(2);expect(f.resources[0]!.cancel).toHaveBeenCalledOnce();
    expect(f.resources[1]!.current).toBe(true);expect(f.resources[1]!.initialize).toHaveBeenCalledOnce();
    expect(f.submissions).toHaveLength(3);f.complete(2);await flush(512);
    expect(f.submissions).toHaveLength(4);f.complete(3);await flush(512);
    expect(f.resources[1]!.position).toHaveBeenCalledExactlyOnceWith(6);
    f.land(6.125);await flush(1024);expect(f.seeked).toHaveBeenCalledTimes(2);expect(f.player.playbackPositionMs).toBe(6125);
    expect(request.out.writeClosed||request.out.writeAborted||response.readCancelled).toBe(true);
    response.releaseHeld();await flush(1024);
    expect(f.submissions).toHaveLength(4);expect(f.resources).toHaveLength(2);
    expect(f.nativeByResource.get(f.resources[1]!)!.map(mdat)).toEqual(expectedPayloads.slice(0,2));
    expect(f.nativeByResource.get(f.resources[1]!)!.map(readFirstSamplePresentationTime)).toEqual([4000n,6000n]);
    expect(f.resources[1]!.initialize).toHaveBeenCalledOnce();expect(f.resources[1]!.position).toHaveBeenCalledOnce();
    expect(f.resources[1]!.cancel).not.toHaveBeenCalled();expect(f.player.playbackPositionMs).toBe(6125);
    expect(f.seeked).toHaveBeenCalledTimes(2);expect(f.ended).not.toHaveBeenCalled();expect(f.errors).toEqual([]);
  }finally{await f.destroy();}
});

it('destroy releases a pending live probe and fences its late ACK/prefix without creating another native resource',async()=>{
  const f=await fixture(22,true);
  try{
    await landHistory(f);const sub=await freshLiveSubscription(f);
    const request=f.a.bidiOut.at(-1)!;const response=await acknowledgeLive(f,sub,true);
    const prefix=await f.server.openFillStream(sub.id);await f.object(prefix,2);await f.close(prefix);await flush(512);
    expect(f.submissions).toHaveLength(2);await f.player.destroy();await flush(1024);
    expect(request.out.writeClosed||request.out.writeAborted||response.readCancelled).toBe(true);
    response.releaseHeld();await flush(1024);
    expect(f.submissions).toHaveLength(2);expect(f.nativeBytes.map(mdat)).toEqual(expectedPayloads.slice(0,2));
    expect(f.resources).toHaveLength(1);expect(f.resources[0]!.current).toBe(false);
    expect(f.seeked).toHaveBeenCalledOnce();expect(f.ended).not.toHaveBeenCalled();expect(f.errors).toEqual([]);
  }finally{await f.destroy();}
});

describe.each([18,22] as const)('owned terminal bridge boundary draft %i', draft => {
  it('DONE 2 fences public stall while accepted native work is still pending', async () => {
    const f=await fixture(draft,true); const stalled=vi.fn(); f.player.on('stall',stalled);
    try {
      const sub=await retainedHandoff(f,false);
      expect(f.submissions[3]!.completed).toBe(false);
      vi.useFakeTimers(); await f.server.publishDone(sub.id,varint(2n),'finished'); await flush(512);
      expect(f.ended).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
      f.source.onStall!(517);
      expect(stalled,'genuinely ending bridge must not publish a recovery stall while native work is draining').not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });
  it('DONE 2 fences public stall while only SDK late-delivery grace remains', async () => {
    const f=await fixture(draft,true); const stalled=vi.fn(); f.player.on('stall',stalled);
    try {
      const sub=await retainedHandoff(f,false); f.complete(3); f.advance(7.125); f.player.tick(); await flush(1024);
      expect(f.submissions.every(x=>x.completed)).toBe(true); expect(f.errors).toEqual([]);
      vi.useFakeTimers(); await f.server.publishDone(sub.id,varint(2n),'finished'); await flush(512);
      expect(f.ended).not.toHaveBeenCalled();
      f.source.onStall!(517);
      expect(stalled,'terminal bridge must suppress recovery during the SDK late-delivery grace').not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });
  it('healthy nonterminal live delivery continues to publish a real stall', async () => {
    const f=await fixture(draft,true); const stalled=vi.fn(); f.player.on('stall',stalled);
    try {
      await retainedHandoff(f,false); expect(f.ended).not.toHaveBeenCalled();
      f.source.onStall!(517); expect(stalled).toHaveBeenCalledOnce();
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});

it('draft18 JOIN EndOfTrack fences recovery before its accepted native prefix settles', async () => {
  const f=await fixture(18,true); const stalled=vi.fn(); f.player.on('stall',stalled);
  try {
    await landHistory(f); const sub=await freshLiveSubscription(f); f.player.play();
    await acknowledgeLive(f,sub); expect(f.joins).toHaveLength(1);
    const join=f.joins[0]!, range=f.server.resolveJoiningFetch(join.id);
    await f.server.acceptFetch(join.id,{endOfTrack:1,endLocation:range.endLocation});
    const prefix=await f.server.openFetchStream(join.id);
    await f.object(prefix,0); await f.object(prefix,1); await f.object(prefix,2); await f.close(prefix); await flush(512);
    expect(f.submissions).toHaveLength(3); expect(f.submissions[2]!.completed).toBe(false);
    expect(f.ended).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    f.source.onStall!(517);
    expect(stalled,'accepted true EOT must suppress recovery while its native prefix drains').not.toHaveBeenCalled();
  } finally { await f.destroy(); }
});


it('ending intent from a retired output cannot suppress a successor output stall', async () => {
  vi.useFakeTimers({ shouldClearNativeTimers: true });
  const f = await fixture(18, true), stalled = vi.fn(); f.player.on('stall', stalled);
  try {
    const old = await retainedHandoff(f, false);
    await f.server.publishDone(old.id, varint(2n), 'finished'); await flush(512);
    f.source.onStall!(517); expect(stalled).not.toHaveBeenCalled();
    await f.player.seek(6000); await flush(512);
    const next = await f.open(1, 2n, 0); await f.object(next, 0); await f.object(next, 1); await f.close(next); await flush(512);
    expect(f.resources).toHaveLength(2); expect(f.resources[0]!.current).toBe(false);
    expect(f.submissions).toHaveLength(5); f.complete(4); await flush(512);
    expect(f.submissions).toHaveLength(6); f.complete(5); await flush(512); f.land(6.125); await flush(1024);
    expect(f.seeked).toHaveBeenCalledTimes(2); expect(f.player.playbackPositionMs).toBe(6125);
    f.source.onStall!(517); expect(stalled).toHaveBeenCalledOnce();
    expect(f.errors).toEqual([]); expect(f.ended).not.toHaveBeenCalled();
  } finally { await f.destroy(); }
});


it('a complete empty catalog does not turn a draining finite output into a recovery stall', async () => {
  const f = await fixture(22, true), stalled = vi.fn(); f.player.on('stall', stalled);
  try {
    const sub = await retainedHandoff(f, false);
    const stream = await f.server.openSubgroup(100n, 1n, 0n);
    await f.server.sendObject(stream, 0n, enc.encode(JSON.stringify({ version: '1', isComplete: true, tracks: [] })));
    await f.server.closeSubgroup(stream); await flush(1024);
    vi.useFakeTimers(); await f.server.publishDone(sub.id, varint(2n), 'finished'); await flush(512);
    expect(f.ended).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    f.source.onStall!(517); expect(stalled).not.toHaveBeenCalled();
  } finally { await f.destroy(); }
});

it('earlier DONE2 intent survives acceptance of a non-EOT JOIN ending at saved J', async () => {
  const f=await fixture(18,true), stalled=vi.fn(); f.player.on('stall',stalled);
  try {
    await landHistory(f); const sub=await freshLiveSubscription(f); f.player.play();
    await acknowledgeLive(f,sub); expect(f.joins).toHaveLength(1);
    const join=f.joins[0]!, range=f.server.resolveJoiningFetch(join.id);
    // J is Object2; Object3 is the later final live Object. The finite JOIN
    // therefore correctly reports EndOfTrack=0, even though SUB is now done.
    await f.liveObject(3); expect(f.submissions).toHaveLength(2);
    vi.useFakeTimers(); await f.server.publishDone(sub.id,varint(2n),'finished'); await flush(512);
    expect(f.errors).toEqual([]); expect(f.ended).not.toHaveBeenCalled();
    f.source.onStall!(517); expect(stalled,'DONE2 must establish the fence before prefix acceptance').not.toHaveBeenCalled();
    await f.server.acceptFetch(join.id,{endOfTrack:0,endLocation:range.endLocation});
    const prefix=await f.server.openFetchStream(join.id);
    await f.object(prefix,0); await f.object(prefix,1); await f.object(prefix,2); await f.close(prefix); await flush(1024);
    expect(f.submissions).toHaveLength(3); expect(f.submissions[2]!.completed).toBe(false);
    expect(f.ended).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    f.source.onStall!(517);
    expect(stalled,'a non-EOT prefix ACK must not erase the earlier terminal subscription intent').not.toHaveBeenCalled();
  } finally { await f.destroy(); }
});
