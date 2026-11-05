/** Initial warm-prefix admission over real draft-18 requests and data streams. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MoqtObject, ObjectDatagram } from '@openmoq/transport';
import type { MoqtConnection as PlayerConnection } from '@openmoq/webtransport';
import { encodeObjectDatagram18, encodeSubgroupObject18, encodeFetchHeader, encodeFetchObject, encodeFetchEndOfRange, locationEncodingLength, writeLocation, ObjectStatus, varint } from '@openmoq/transport';
import { connectedPair } from '../../webtransport/src/testkit/pair.js';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { MoqtConnection } from '../../webtransport/src/adapter.js';
import { buildChunk, buildInit, SYNC_FLAGS, videoInit } from '../../locmaf/test-support/cmaf.js';
import { MoqtPlayer } from './player.js';
import type { MoqtPlayerConfig } from './config.js';
import type { SubscriptionManager } from './subscription-manager.js';
import type { MediaSourceLike, AudioDecoderLike } from './interfaces.js';
import { WarmStartHead } from './warm-start-head.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
});
const bytes = (id: number) => Uint8Array.of(0x00, id, 0xff, 0x80);

async function fixture(options: { draft?: 16 | 18 | 22; warm?: boolean; audio?: boolean; audioOnly?: boolean; transform?: MoqtPlayerConfig['objectTransform'] } = {}) {
  const draft = options.draft ?? 18;
  const pair = await connectedPair(draft);
  const { client, server } = pair;
  const requests: Array<{ id: bigint; namespace: string[]; name: string }> = [];
  const fetches: bigint[] = [];
  server.onSubscribe = (id, ns, name) => { requests.push({ id, namespace: ns.map(f => new TextDecoder().decode(f)), name: new TextDecoder().decode(name) }); };
  server.onFetch = id => { fetches.push(id); };
  let nowUs = 0;
  const decodeAudio = vi.fn<AudioDecoderLike['decode']>(), flushAudio = vi.fn(async () => {});
  const warn = vi.fn();
  const decoder: AudioDecoderLike = { configure() {}, decode: decodeAudio, flush: flushAudio,
    reset() {}, destroy() {}, queueDepth: 0, onData: null, onError: null };
  const player = new MoqtPlayer({
    url: 'https://unused.example/moq', namespace: ['catalog'], connection: client as unknown as PlayerConnection,
    createTransport: async () => ({}) as never, draftVersion: draft,
    ...(options.audioOnly ? { disableVideo: true, createAudioDecoder: () => decoder,
      logLevel: 'warn' as const, logger: { warn, error() {}, info() {}, debug() {} } } : {}),
    warmStartCurrentGroup: options.warm ?? true, clock: { now: () => nowUs },
    ...(options.transform ? { objectTransform: options.transform } : {}),
    catalog: { tracks: [
      ...(!options.audioOnly ? [{ name: 'shared', namespace: 'camera/main', packaging: 'loc' as const, isLive: true, role: 'video',
        renderGroup: 1, codec: 'avc1.640028', width: 640, height: 360, bitrate: 500000 }] : []),
      ...(options.audio || options.audioOnly ? [{ name: 'shared', namespace: 'sound/main', packaging: 'loc' as const, isLive: true, role: 'audio',
        renderGroup: 1, codec: 'opus', samplerate: 48000, channelConfig: '2', bitrate: 32000 }] : []),
    ] },
  });
  cleanup.push(async () => { await player.destroy(); await client.close(); await server.close(); });
  const media: Array<{ group: bigint; object: bigint; payload?: Uint8Array }> = [];
  const errors: string[] = [];
  player.on('media_object', e => { media.push({ group: e.groupId, object: e.objectId, ...(e.payload ? { payload: e.payload } : {}) }); });
  player.on('error', e => { errors.push(e.error.message); });
  await player.load(); await flush(256);
  expect(requests).toHaveLength(options.audio ? 2 : 1);
  const manager = (player as unknown as { subscriptionManager: SubscriptionManager }).subscriptionManager;
  const captured: Array<{ source: unknown; input: MoqtObject | ObjectDatagram; context: object }> = [];
  const discarded: Array<{ context: object; reason: string }> = [];
  manager.objectProvenance = {
    capture(source, input) { const context = {}; captured.push({ source, input, context }); return context; },
    discarded(context, reason) { discarded.push({ context, reason }); },
  };
  const raw: MoqtObject[] = [];
  const original = client.onObject!;
  client.onObject = (stream, obj) => { raw.push(obj); original(stream, obj); };
  const accept = async (index = 0, alias = 70n, largest: { group: bigint; object: bigint } | null = { group: 9n, object: 1n }) => {
    const location = largest && { group: varint(largest.group), object: varint(largest.object) };
    const encoded = location && new Uint8Array(locationEncodingLength(location));
    if (location && encoded) writeLocation(location, encoded, 0);
    await server.acceptSubscribe(requests[index]!.id, alias, {
      parameters: new Map(largest ? [[0x09n, [draft === 16 ? encoded : largest]]] : []) as never,
    });
    await flush(256);
  };
  const live = async (object: bigint, payload = bytes(Number(object)), group = 9n, alias = 70n) => {
    const stream = await server.openSubgroup(alias, group, object, { publisherPriority: 128 });
    await server.sendObject(stream, object, payload); await server.closeSubgroup(stream); await flush(256);
  };
  const status = async (code: bigint, group = 9n, object = 0n, holdBody = false) => {
    if (holdBody) {
      if (draft !== 18) throw new Error('Held status-stream fixture requires draft-18');
      const stream = await server.openSubgroup(70n, group, object, { publisherPriority: 128 });
      const pipe = pair.b.uniOut.at(-1)!;
      pipe.faults.hold = true;
      // The public sender handles data objects only. Use its real counted
      // subgroup writer for this status body; FIN and DONE still use server APIs.
      const state = (server as unknown as { outgoingStreams: Map<bigint, {
        writer: WritableStreamDefaultWriter<Uint8Array>; hasExtensions: boolean;
        previousObjectId: bigint; isFirstObject: boolean;
      }> }).outgoingStreams.get(stream)!;
      await state.writer.write(encodeSubgroupObject18({ objectId: object, payload: new Uint8Array(),
        extensions: undefined, status: code }, state.hasExtensions, state.previousObjectId, state.isFirstObject));
      await server.closeSubgroup(stream);
      expect(pipe.writeClosed).toBe(true);
      await flush(256);
      return pipe;
    }
    const writer = pair.b.datagrams.writable!.getWriter();
    try { await writer.write(encodeObjectDatagram18({ typeByte: 0x20, trackAlias: 70n, groupId: group, objectId: object,
      publisherPriority: 128, payload: new Uint8Array(), extensions: undefined, status: code, isEndOfGroup: false })); }
    finally { writer.releaseLock(); }
    await flush(256);
  };
  const openPrefix = async (index = 0, endLocation = { group: 9n, object: 2n }) => {
    const request = draft === 22 ? requests[0]!.id : fetches[index]!;
    expect(request).toBeDefined();
    if (draft !== 22) await server.acceptFetch(request, { endLocation });
    if (draft === 16) {
      // The serving convenience API is draft-18+; use the actual draft-16
      // encoders on its real uni stream without changing received objects.
      const writer = (await pair.b.createUnidirectionalStream()).getWriter();
      await writer.write(encodeFetchHeader({ requestId: varint(request) }));
      return { async send(object: bigint, payload = bytes(Number(object)), group = 9n) {
        await writer.write(encodeFetchObject({ flags: varint(0x1c), groupId: varint(group), subgroupId: varint(0n),
          objectId: varint(object), publisherPriority: 128, isDatagram: false, extensions: undefined, payload }));
        await flush(256);
      }, async nonExistent(object: bigint, group = 9n) {
        await writer.write(encodeFetchEndOfRange({ flags: varint(0x8c), groupId: group, objectId: object, nonExistent: true }));
        await flush(256);
      }, async fin() { await writer.close(); await flush(256); } };
    }
    const stream = draft === 22 ? await server.openFillStream(request) : await server.openFetchStream(request);
    return { stream, async send(object: bigint, payload = bytes(Number(object)), group = 9n) {
      await server.sendFetchObject(stream, { groupId: group, subgroupId: 0n, objectId: object, publisherPriority: 128, payload });
      await flush(256);
    }, async nonExistent(object: bigint, group = 9n) {
      await server.sendFetchEndOfRange(stream, true, group, object); await flush(256);
    }, async fin() { await server.closeFetchStream(stream); await flush(256); } };
  };
  return { ...pair, player, requests, fetches, manager, captured, discarded, raw, media, errors, accept, live, openPrefix, status, decodeAudio, flushAudio, warn,
    tick(ms = 20) { nowUs += ms * 1000; player.tick(); },
    async expire() { nowUs += 1_000_000; await vi.advanceTimersByTimeAsync(1000); await flush(256); } };
}

describe('owner-local initial warm admission', () => {
  it.each([18, 22] as const)('draft-%i missing FETCH ranges leave the group open for later objects', async draft => {
    const h = await fixture({ draft });
    await h.accept(0, 70n, { group: 9n, object: 3n });
    await h.live(4n);
    const pipeline = (h.player as unknown as { videoPipeline: {
      pushObject: (obj: MoqtObject) => void; endedGroups: Set<bigint>;
    } }).videoPipeline;
    const push = vi.spyOn(pipeline, 'pushObject');
    const prefix = await h.openPrefix(0, { group: 9n, object: draft === 18 ? 4n : 3n });
    await prefix.send(0n);
    const pipe = h.b.uniOut.at(-1)!;
    // Absolute Locations 9/1 (DNE), 9/2 (Unknown), then normal Object 9/3.
    // Draft 18 carries a zero Payload Length on each range; 22 omits it.
    pipe.injectRead(Uint8Array.from(draft === 18
      ? [0x80, 0x8c, 9, 1, 0, 0x81, 0x0c, 9, 2, 0]
      : [0x80, 0x8c, 9, 1, 0x81, 0x0c, 9, 2]));
    pipe.injectRead(Uint8Array.of(0x10, 128, 4, 0, 3, 255, 128));
    await prefix.fin();
    expect(push.mock.calls.some(([obj]) => obj.kind === 'data' && obj.objectId === 3n)).toBe(true);
    expect(h.media.some(obj => obj.object === 3n)).toBe(true);
    expect(pipeline.endedGroups.has(9n)).toBe(false);
    expect(h.raw.filter(obj => obj.kind === 'gap').map(obj => obj.status)).toEqual([1n, 0n]);
    await h.status(ObjectStatus.END_OF_GROUP, 9n, 6n);
    expect(pipeline.endedGroups.has(9n)).toBe(true);
    await h.status(ObjectStatus.END_OF_TRACK, 10n);
    expect(h.captured.at(-1)!.input).toMatchObject({ status: ObjectStatus.END_OF_TRACK });
    expect(h.errors).toEqual([]);
  });

  it('classifies actual data and status receipts without treating EOG or empty data as a group start', async () => {
    const h = await fixture(); await h.accept();
    const push = vi.spyOn(WarmStartHead.prototype, 'push');
    try {
      await h.live(0n, bytes(0), 10n); await h.live(1n, bytes(1), 10n);
      await h.live(0n, new Uint8Array(), 11n);
      await h.status(ObjectStatus.END_OF_GROUP, 12n);
      await h.status(ObjectStatus.NORMAL, 13n);
      await h.status(ObjectStatus.END_OF_TRACK, 14n);
      expect(push.mock.calls.map(call => call[0].continuation)).toEqual([
        'group-start', 'ordinary', 'ordinary', 'ordinary', 'ordinary', 'terminal',
      ]);
      expect(h.captured.slice(-3).map(e => (e.input as ObjectDatagram).status)).toEqual([
        ObjectStatus.END_OF_GROUP, ObjectStatus.NORMAL, ObjectStatus.END_OF_TRACK,
      ]);
    } finally { push.mockRestore(); }
  });

  it.each([16, 18, 22] as const)('draft-%i captures live receipt immediately, then transforms exact prefix bytes before the held live suffix', async draft => {
    const transformed: MoqtObject[] = [];
    const h = await fixture({ draft, transform: obj => { transformed.push(obj); return obj; } });
    const pipeline = (h.player as unknown as { videoPipeline: { pushObject: (...args: unknown[]) => void } }).videoPipeline;
    const push = vi.spyOn(pipeline, 'pushObject');
    await h.accept();
    await h.live(2n);
    expect(h.captured).toHaveLength(1);
    expect(h.captured[0]!.source).toBe(h.client);
    expect(h.captured[0]!.input).toBe(h.raw[0]);
    expect(transformed).toEqual([]);
    const prefix = await h.openPrefix(); await prefix.send(0n); await prefix.send(1n); await prefix.fin();
    expect(transformed.map(obj => BigInt(obj.objectId))).toEqual([0n, 1n, 2n]);
    expect(h.media.map(e => e.payload)).toEqual([bytes(0), bytes(1), bytes(2)]);
    expect(h.captured.map(e => e.input)).toEqual(h.raw);
    expect(h.captured.slice(1).every(e => BigInt(e.input.trackAlias) === 0n)).toBe(true);
    expect(push.mock.calls.map(call => call[3] ?? null)).toEqual([{ backfill: true }, { backfill: true }, null]);
    expect(h.errors).toEqual([]);
  });

  it.each([16, 18, 22] as const)('draft-%i FIN ends retrieval without cancelling an admitted async prefix transform or starting the suffix early', async draft => {
    let resolve!: (obj: MoqtObject) => void;
    let first!: MoqtObject;
    const starts: bigint[] = [];
    const h = await fixture({ draft, transform: obj => {
      starts.push(BigInt(obj.objectId));
      if (BigInt(obj.objectId) === 0n) { first = obj; return new Promise<MoqtObject>(r => { resolve = r; }); }
      return obj;
    } });
    await h.accept(); const prefix = await h.openPrefix();
    await prefix.send(0n); await prefix.send(1n); await h.live(2n); await prefix.fin();
    expect(starts).toEqual([0n]);
    resolve(first); await flush(256);
    expect(starts).toEqual([0n, 1n, 2n]);
    expect(h.media.map(e => e.object)).toEqual([0n, 1n, 2n]);
  });

  it.each([16, 18, 22] as const)('draft-%i End of Non-Existent Range in the prefix is a missing object, not END_OF_GROUP', async draft => {
    const h = await fixture({ draft });
    const pipeline = (h.player as unknown as { videoPipeline: { pushObject: (...args: unknown[]) => void; endedGroups: Set<bigint> } }).videoPipeline;
    const push = vi.spyOn(pipeline, 'pushObject');
    const gaps: Array<{ group: bigint; object: bigint; status?: bigint }> = [];
    h.player.on('media_object', e => { if (e.kind === 'gap') gaps.push({ group: e.groupId, object: e.objectId, ...(e.status !== undefined ? { status: e.status } : {}) }); });
    await h.accept();
    await h.live(2n);
    // Largest {9,1}: {9,0} is served and {9,1} does not exist. Group 9 goes on.
    const prefix = await h.openPrefix(); await prefix.send(0n); await prefix.nonExistent(1n); await prefix.fin();
    expect(h.media.map(e => e.object)).toEqual([0n, 1n, 2n]);
    expect(gaps).toEqual([{ group: 9n, object: 1n, status: ObjectStatus.OBJECT_DOES_NOT_EXIST }]);
    expect(push.mock.calls.map(call => (call[0] as MoqtObject).kind)).toEqual(['data', 'gap', 'data']);
    expect(pipeline.endedGroups.has(9n)).toBe(false);
    expect(h.errors).toEqual([]);
  });

  it('abandonment wakes a queued future group without another push; a late rejected transform cannot unsubscribe', async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const h = await fixture({ transform: obj => BigInt(obj.groupId) === 9n && BigInt(obj.objectId) === 0n
      ? new Promise<MoqtObject>((_resolve, r) => { reject = r; }) : obj });
    await h.accept(); const prefix = await h.openPrefix(); await prefix.send(0n); await h.live(0n, bytes(10), 10n);
    expect(h.media).toEqual([]);
    const unsubscribe = vi.spyOn(h.client, 'unsubscribe');
    await h.expire();
    expect(h.media.map(e => [e.group, e.object])).toEqual([[10n, 0n]]);
    reject(new Error('late transform failure')); await flush(256);
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(h.errors).toEqual([]);
    expect(h.discarded).toHaveLength(1);
  });

  it('installs Largest before replaying pre-OK live objects', async () => {
    const starts: bigint[] = [];
    const h = await fixture({ transform: obj => { starts.push(BigInt(obj.objectId)); return obj; } });
    const response = h.a.bidiOut[0]!.in;
    response.faults.hold = true;
    await h.accept();
    await h.live(2n); expect(starts).toEqual([]);
    response.releaseHeld(); await flush(256); expect(starts).toEqual([]);
    const prefix = await h.openPrefix(); await prefix.send(0n); await prefix.send(1n); await prefix.fin();
    expect(starts).toEqual([0n, 1n, 2n]);
  });

  it('admits a pre-OK prefix FIN only after its raw buffered objects enter the gate', async () => {
    const h = await fixture();
    const response = h.a.bidiOut[0]!.in;
    response.faults.hold = true; await h.accept();
    const prefix = await h.openPrefix(); await prefix.send(0n); await prefix.send(1n); await prefix.fin();
    await h.live(2n); expect(h.media).toEqual([]);
    response.releaseHeld(); await flush(256);
    expect(h.media.map(e => e.object)).toEqual([0n, 1n, 2n]);
    expect(h.captured.every(e => e.source === h.client)).toBe(true);
  });

  it.each(['refused', 'cancelled', 'reset'] as const)('wakes a queued next group when its prefix is %s', async terminal => {
    const h = await fixture(); await h.accept(); await h.live(0n, bytes(10), 10n);
    expect(h.media).toEqual([]);
    if (terminal === 'refused') await h.server.rejectFetch(h.fetches[0]!, varint(0x10n), 'unavailable');
    else if (terminal === 'cancelled') await h.player.fetchCancel(h.fetches[0]!);
    else {
      const prefix = await h.openPrefix();
      h.b.uniOut.at(-1)!.faults.resetAfterBytes = 0;
      await prefix.send(0n);
    }
    await flush(256);
    expect(h.media.map(e => [e.group, e.object])).toEqual([[10n, 0n]]);
    expect(h.errors).toEqual([]);
  });

  it('includes in-flight work in the byte bound and releases a queued future group on overflow', async () => {
    let resolve!: (obj: MoqtObject) => void;
    let first!: MoqtObject;
    const h = await fixture({ transform: obj => {
      if (BigInt(obj.groupId) === 9n && BigInt(obj.objectId) === 0n) {
        first = obj; return new Promise<MoqtObject>(r => { resolve = r; });
      }
      return obj;
    } });
    await h.accept(); const prefix = await h.openPrefix(); await prefix.send(0n);
    await h.live(0n, bytes(10), 10n);
    await h.live(3n, new Uint8Array(4 * 1024 * 1024));
    expect(h.media.map(e => [e.group, e.object])).toEqual([[10n, 0n]]);
    resolve(first); await flush(256);
    expect(h.media.map(e => [e.group, e.object])).toEqual([[10n, 0n]]);
    expect(h.discarded.map(e => e.reason).sort()).toEqual(['buffer full', 'route retired']);
  });

  it('does not transform after a capture callback replaces the exact manager registration', async () => {
    const transform = vi.fn((obj: MoqtObject) => obj);
    const h = await fixture({ transform }); await h.accept();
    const contexts: object[] = [];
    h.manager.objectProvenance = {
      capture() { h.manager.unregisterTrack(70n); h.manager.registerTrack(70n, 'shared', 'video', 'loc'); return {}; },
      discarded(context) { contexts.push(context); },
    };
    await h.live(2n);
    expect(transform).not.toHaveBeenCalled(); expect(contexts).toHaveLength(1); expect(h.media).toEqual([]);
  });

  it('rechecks the admitted live guard after an application callback replaces its registration', async () => {
    const h = await fixture(); await h.accept();
    const pipeline = (h.player as unknown as { videoPipeline: { pushObject: (...args: unknown[]) => void } }).videoPipeline;
    const push = vi.spyOn(pipeline, 'pushObject');
    h.player.on('media_object', e => {
      if (e.objectId !== 2n) return;
      h.manager.unregisterTrack(70n); h.manager.registerTrack(70n, 'replacement', 'video', 'loc');
    });
    await h.live(2n); const prefix = await h.openPrefix(); await prefix.send(0n); await prefix.send(1n);
    expect(push.mock.calls.map(call => BigInt((call[0] as MoqtObject).objectId))).toEqual([0n, 1n]);
  });

  it('does not hold or admit a manual FETCH as warm-prefix traffic', async () => {
    const starts: bigint[] = [];
    const h = await fixture({ transform: obj => { starts.push(BigInt(obj.objectId)); return obj; } });
    await h.accept();
    await h.player.fetch('shared', { startGroup: 8, startObject: 0, endGroup: 8, endObject: 1 });
    await flush(256);
    const manual = await h.openPrefix(1); await manual.send(0n, bytes(8), 8n); await manual.fin();
    expect(starts).toEqual([0n]); expect(h.media[0]!.payload).toEqual(bytes(8));
    await h.live(2n); expect(starts).toEqual([0n]);
  });

  it('keeps same-name namespaces and request owners separate when one subscription retires', async () => {
    const h = await fixture({ audio: true });
    expect(h.requests.map(r => r.namespace)).toEqual([['camera', 'main'], ['sound', 'main']]);
    await h.accept(0, 70n); await h.accept(1, 71n);
    await h.live(2n, bytes(22), 9n, 70n); await h.live(2n, bytes(42), 9n, 71n);
    expect(h.media).toEqual([]);
    await h.server.publishDone(h.requests[0]!.id, varint(0n), 'retired video'); await flush(256);
    const audioPrefix = await h.openPrefix(1); await audioPrefix.send(0n, bytes(40)); await audioPrefix.send(1n, bytes(41)); await audioPrefix.fin();
    expect(h.media.map(e => e.payload)).toEqual([bytes(40), bytes(41), bytes(42)]);
    expect(h.discarded.map(e => e.reason)).toEqual(['route retired']);
  });

  it('captures a datagram original receipt while holding it behind the prefix', async () => {
    const h = await fixture(); await h.accept();
    const writer = h.b.datagrams.writable!.getWriter();
    try { await writer.write(encodeObjectDatagram18({ typeByte: 0, trackAlias: 70n, groupId: 9n, objectId: 2n,
      publisherPriority: 128, payload: bytes(2), extensions: undefined, status: undefined, isEndOfGroup: false })); }
    finally { writer.releaseLock(); }
    await flush(256);
    expect(h.captured).toHaveLength(1); expect(h.captured[0]!.input).toHaveProperty('typeByte'); expect(h.media).toEqual([]);
    const prefix = await h.openPrefix(); await prefix.send(0n); await prefix.send(1n); await prefix.fin();
    expect(h.media.map(e => e.object)).toEqual([0n, 1n, 2n]);
  });

  it('treats an explicitly empty Largest as no prefix and keeps ordinary live delivery', async () => {
    const h = await fixture(); await h.accept(0, 70n, null);
    await h.live(0n, bytes(10), 10n);
    const prefix = await h.openPrefix(); await prefix.send(0n); await prefix.fin();
    expect(h.media.map(e => e.payload)).toEqual([bytes(10)]);
  });

  it('draft-22 empty Largest produces no fill and preserves ordinary live delivery', async () => {
    const h = await fixture({ draft: 22 });
    const headers: string[] = [];
    const original = h.client.onDataStream!;
    h.client.onDataStream = (stream, header) => { headers.push(header.type); original(stream, header); };
    await h.accept(0, 70n, null); await h.live(0n, bytes(10), 10n);
    expect(h.fetches).toEqual([]); expect(headers).not.toContain('fetch');
    expect(h.media.map(e => e.payload)).toEqual([bytes(10)]);
  });

  it('settles a held prefix and live tail before public EOT completion and decoder flush', async () => {
    let first!: MoqtObject, resolve!: (obj: MoqtObject) => void;
    const h = await fixture({ audioOnly: true, transform: obj => {
      if (obj.kind === 'data' && BigInt(obj.objectId) === 0n) {
        first = obj; return new Promise<MoqtObject>(r => { resolve = r; });
      }
      return obj;
    } });
    const ended = vi.fn(), recovery = vi.fn();
    h.player.on('track_ended', ended); h.player.on('recovery_action', recovery);
    await h.accept(0, 70n, { group: 0n, object: 1n }); const prefix = await h.openPrefix(0, { group: 0n, object: 2n });
    await prefix.send(0n, bytes(0), 0n); await prefix.send(1n, bytes(1), 0n); await h.live(2n, bytes(2), 0n);
    await h.status(ObjectStatus.END_OF_TRACK, 0n, 3n); await prefix.fin();
    expect(h.media).toEqual([]);
    expect(h.decodeAudio).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled();
    resolve(first); await flush(256);
    expect(h.media.map(e => e.object)).toEqual([0n, 1n, 2n, 3n]);
    expect((h.captured.at(-1)!.input as ObjectDatagram).status).toBe(ObjectStatus.END_OF_TRACK);
    // EOT arrives before decoding; all admitted audio must drain before completion.
    for (let ms = 0; ms < 1500; ms += 20) { h.tick(); await flush(16); }
    expect(h.decodeAudio.mock.calls.map(call => call[0].data)).toEqual([bytes(0), bytes(1), bytes(2)]);
    expect(ended).toHaveBeenCalledExactlyOnceWith({ type: 'track_ended', mediaType: 'audio' });
    expect(h.flushAudio).toHaveBeenCalledOnce();
    expect(recovery).not.toHaveBeenCalled(); expect(h.warn).not.toHaveBeenCalled(); expect(h.errors).toEqual([]);
  });

  it('completes once when EOT follows actual decoder consumption of prefix and tail', async () => {
    const h = await fixture({ audioOnly: true });
    const ended = vi.fn(), recovery = vi.fn();
    h.player.on('track_ended', ended); h.player.on('recovery_action', recovery);
    await h.accept(0, 70n, { group: 0n, object: 1n });
    const prefix = await h.openPrefix(0, { group: 0n, object: 2n });
    await prefix.send(0n, bytes(0), 0n); await prefix.send(1n, bytes(1), 0n); await prefix.fin(); await h.live(2n, bytes(2), 0n);
    for (let i = 0; i < 5; i++) { h.tick(); await flush(16); }
    expect(h.decodeAudio.mock.calls.map(call => call[0].data)).toEqual([bytes(0), bytes(1), bytes(2)]);
    expect(h.flushAudio).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled();
    await h.status(ObjectStatus.END_OF_TRACK, 0n, 3n);
    for (let ms = 0; ms < 1500; ms += 20) { h.tick(); await flush(16); }
    expect(h.decodeAudio).toHaveBeenCalledTimes(3);
    expect(ended).toHaveBeenCalledExactlyOnceWith({ type: 'track_ended', mediaType: 'audio' });
    expect(h.flushAudio).toHaveBeenCalledOnce(); expect(recovery).not.toHaveBeenCalled(); expect(h.warn).not.toHaveBeenCalled(); expect(h.errors).toEqual([]);
  });

  it('settles a held prefix before late EOT and counted DONE produce one finite completion', async () => {
    let first: MoqtObject | undefined, resolve: ((obj: MoqtObject) => void) | undefined;
    const h = await fixture({ audioOnly: true, transform: obj => {
      if (obj.kind === 'data' && BigInt(obj.objectId) === 0n) {
        first = obj; return new Promise<MoqtObject>(r => { resolve = r; });
      }
      return obj;
    } });
    const ended = vi.fn(), unsubscribed = vi.fn(), recovery = vi.fn(), stall = vi.fn(), publicEot = vi.fn();
    h.player.on('track_ended', ended); h.player.on('track_unsubscribed', unsubscribed);
    h.player.on('recovery_action', recovery); h.player.on('stall', stall);
    h.player.on('media_object', event => { if (event.kind === 'gap' && event.status === ObjectStatus.END_OF_TRACK) publicEot(event); });
    const doneCounts: bigint[] = [];
    const original = h.client.onMessage!;
    h.client.onMessage = message => {
      if (message.type === 'PUBLISH_DONE') doneCounts.push(BigInt(message.streamCount));
      original(message);
    };
    try {
      await h.accept(0, 70n, { group: 0n, object: 1n });
      const prefix = await h.openPrefix(0, { group: 0n, object: 2n });
      await prefix.send(0n, bytes(0), 0n); await prefix.send(1n, bytes(1), 0n); await prefix.fin();
      await h.live(2n, bytes(2), 0n);
      const eot = await h.status(ObjectStatus.END_OF_TRACK, 0n, 3n, true);
      expect(eot).toBeDefined(); expect(eot!.writeClosed).toBe(true);
      // Both SUBSCRIBE streams have sender FINs; the Joining FETCH is excluded.
      await h.server.publishDone(h.requests[0]!.id, varint(2n), 'finite'); await flush(256);
      expect(doneCounts).toEqual([2n]);
      eot!.releaseHeld(); await flush(256); h.tick();
      expect(h.media).toEqual([]); expect(h.decodeAudio).not.toHaveBeenCalled();
      expect(ended).not.toHaveBeenCalled(); expect(unsubscribed).not.toHaveBeenCalled();
      expect(publicEot).not.toHaveBeenCalled(); expect(h.flushAudio).not.toHaveBeenCalled();
      expect(first).toBeDefined(); resolve!(first!); await flush(256);
      for (let ms = 0; ms < 1500; ms += 20) { h.tick(); await flush(16); }
      expect(h.media.map(event => event.object)).toEqual([0n, 1n, 2n, 3n]);
      expect(h.decodeAudio.mock.calls.map(call => call[0].data)).toEqual([bytes(0), bytes(1), bytes(2)]);
      expect(publicEot).toHaveBeenCalledOnce();
      expect(ended).toHaveBeenCalledExactlyOnceWith({ type: 'track_ended', mediaType: 'audio' });
      expect(h.flushAudio).toHaveBeenCalledOnce(); expect(unsubscribed).toHaveBeenCalledOnce();
      expect(unsubscribed.mock.calls[0]![0]).toMatchObject({ type: 'track_unsubscribed', trackName: 'shared' });
      expect(recovery).not.toHaveBeenCalled(); expect(stall).not.toHaveBeenCalled();
      expect(h.warn).not.toHaveBeenCalled(); expect(h.errors).toEqual([]);
    } finally { if (first) resolve?.(first); }
  });

  it('passes EOT after expiry without letting EOG at zero open the fallback dependency gate', async () => {
    vi.useFakeTimers();
    let first!: MoqtObject, resolve!: (obj: MoqtObject) => void;
    const h = await fixture({ audioOnly: true, transform: obj => {
      if (obj.kind === 'data' && BigInt(obj.groupId) === 9n) {
        first = obj; return new Promise<MoqtObject>(r => { resolve = r; });
      }
      return obj;
    } });
    const ended = vi.fn(), recovery = vi.fn();
    h.player.on('track_ended', ended); h.player.on('recovery_action', recovery);
    await h.accept(); const prefix = await h.openPrefix(); await prefix.send(0n);
    await h.status(ObjectStatus.END_OF_GROUP, 10n); await h.live(1n, bytes(1), 11n);
    await h.expire(); await h.status(ObjectStatus.END_OF_TRACK, 12n);
    expect(h.media).toEqual([]); expect(ended).not.toHaveBeenCalled();
    resolve(first); await flush(256);
    expect(h.media.map(e => [e.group, e.object, e.payload])).toEqual([[12n, 0n, undefined]]);
    for (let ms = 0; ms < 1500; ms += 20) { h.tick(); await flush(16); }
    expect(h.decodeAudio).not.toHaveBeenCalled();
    expect(ended).toHaveBeenCalledExactlyOnceWith({ type: 'track_ended', mediaType: 'audio' });
    expect(h.flushAudio).toHaveBeenCalledOnce(); expect(recovery).not.toHaveBeenCalled(); expect(h.warn).not.toHaveBeenCalled(); expect(h.errors).toEqual([]);
  });

  it('preserves default-off delivery without creating an initial retrieval', async () => {
    const h = await fixture({ warm: false }); await h.accept();
    expect(h.fetches).toEqual([]); await h.live(2n);
    expect(h.media.map(e => e.payload)).toEqual([bytes(2)]);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function migrationPeer() {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(18), server = new MoqtConnection(18, { role: 'server' });
  const requests: Array<{ id: bigint; name: string }> = [];
  const fetches: bigint[] = [];
  server.onSubscribe = (id, _namespace, name) => { requests.push({ id, name: new TextDecoder().decode(name) }); };
  server.onFetch = id => { fetches.push(id); };
  let serving: Promise<void> | undefined;
  return { client, server, requests, fetches,
    start() { serving = server.connect(b); void serving.catch(() => {}); return a; },
    async accept(name: string, alias: bigint, largest?: { group: bigint; object: bigint }) {
      await flush(256);
      const request = requests.find(r => r.name === name);
      expect(request, `requested ${name}`).toBeDefined();
      await server.acceptSubscribe(request!.id, alias,
        largest ? { parameters: new Map([[0x09n, [largest]]]) as never } : undefined);
      await flush(256);
    },
    async send(alias: bigint, group: bigint, payload: Uint8Array) {
      const stream = await server.openSubgroup(alias, group, 0n, { publisherPriority: 128 });
      await server.sendObject(stream, 0n, payload); await server.closeSubgroup(stream); await flush(256);
    },
    async close() { await client.close(); await server.close(); await serving?.catch(() => {}); },
  };
}

describe('completed warm ownership during public migration', () => {
  it.each(['retained', 'reused', 'retyped', 'prefix-retained'] as const)('keeps source authority until actual retirement: %s alias/buffer', async mode => {
    const prefixPending = mode === 'prefix-retained';
    const old = migrationPeer(), next = migrationPeer();
    const retirement = deferred<void>();
    const held = new Map<bigint, { obj: MoqtObject; resolve: (obj: MoqtObject) => void }>();
    const append = vi.fn<MediaSourceLike['appendChunk']>();
    const changeType = vi.fn(async () => {});
    const source: MediaSourceLike = { initialize: () => true, appendChunk: append, changeType,
      reset() {}, endOfStream() {}, destroy() {}, mediaElement: null, onFirstFrame: null, onError: null, onStall: null };
    const createSource = vi.fn(() => source);
    let transports = 0;
    const player = new MoqtPlayer({
      url: 'https://unused.example/moq', namespace: ['live', 'warm-migration'], draftVersion: 18,
      warmStartCurrentGroup: true, disableAudio: true, catalogBootstrap: 'subscribe',
      // Real loopback peers use the source adapter; public package declarations
      // can resolve a separate build with a distinct private class identity.
      createConnection: () => old.client as unknown as PlayerConnection,
      createTransport: async () => transports++ === 0 ? old.start() : next.start(),
      createMediaSource: createSource,
      createCmafAssembler: callbacks => ({
        push: (type, track, group, payload) => callbacks.onSegment(type, payload, track, group),
        getEpoch: () => null, reset() {}, destroy() {}, setInitSegment() {},
      }),
      objectTransform: obj => {
        const group = BigInt(obj.groupId);
        if (group !== 11n && group !== 13n
            && !(prefixPending && group === 9n && obj.objectId === 0n && BigInt(obj.trackAlias) === 70n)) return obj;
        return new Promise<MoqtObject>(resolve => { held.set(group, { obj, resolve }); });
      },
    });
    const errors: string[] = [];
    player.on('error', e => { errors.push(e.error.message); });
    const originalClose = old.client.close.bind(old.client);
    const close = vi.spyOn(old.client, 'close').mockImplementation(async () => { await retirement.promise; await originalClose(); });
    let migration: Promise<void> | undefined;
    cleanup.push(async () => {
      retirement.resolve();
      for (const op of held.values()) op.resolve(op.obj);
      await migration?.catch(() => {}); await player.destroy(); await old.close(); await next.close();
    });
    const catalog = (init = videoInit()) => new TextEncoder().encode(JSON.stringify({ version: 1, tracks: [
      { name: 'video', namespace: 'camera/main', packaging: 'cmaf', isLive: true, role: 'video', renderGroup: 1,
        codec: 'avc1.640028', width: 640, height: 360, bitrate: 500000, initData: Buffer.from(init).toString('base64') },
    ] }));
    const chunk = (group: bigint) => buildChunk({ trackId: 1, bmdt: group * 3000n,
      samples: [{ duration: 3000, size: 4, flags: SYNC_FLAGS }], mdat: bytes(Number(group)) });
    const groups = () => append.mock.calls.map(call => call[3]);
    await player.load(); await old.accept('catalog', 100n); await old.send(100n, 1n, catalog());
    await old.accept('video', 70n, { group: 9n, object: prefixPending ? 1n : 0n });
    expect(old.fetches).toHaveLength(1);
    await old.server.acceptFetch(old.fetches[0]!, { endLocation: { group: 9n, object: prefixPending ? 2n : 1n } });
    const prefix = await old.server.openFetchStream(old.fetches[0]!);
    await old.server.sendFetchObject(prefix, { groupId: 9n, subgroupId: 0n, objectId: 0n, publisherPriority: 128, payload: chunk(9n) });
    if (!prefixPending) await old.server.closeFetchStream(prefix);
    await flush(256);
    expect(groups()).toEqual(prefixPending ? [] : [9n]);
    await old.send(70n, 10n, chunk(10n));
    if (!prefixPending) {
      await old.send(70n, 11n, chunk(11n)); await old.send(70n, 13n, chunk(13n));
      expect(held.size).toBe(2); expect(groups()).toEqual([9n, 10n]);
    } else expect(held.size).toBe(1);

    migration = player.migrate(next.client as unknown as PlayerConnection); void migration.catch(() => {});
    await flush(512); await next.accept('catalog', 100n);
    await next.send(100n, 1n, catalog(mode === 'retyped' ? buildInit({ trackId: 1, timescale: 60000, handler: 'vide' }) : videoInit()));
    const nextAlias = mode === 'reused' ? 70n : 80n;
    await next.accept('video', nextAlias); await flush(512);
    expect(close).toHaveBeenCalledOnce(); // Adoption occurred; retirement is still held.
    expect(old.requests.find(r => r.name === 'video')!.id).toBe(next.requests.find(r => r.name === 'video')!.id);
    expect(createSource).toHaveBeenCalledOnce();
    expect(changeType).toHaveBeenCalledTimes(mode === 'retyped' ? 1 : 0);
    append.mockClear();
    // The replacement's colliding request ID must not inherit the old prefix fence.
    await next.send(nextAlias, 9n, chunk(9n)); expect(groups()).toEqual([9n]);
    if (prefixPending) {
      await old.server.sendFetchObject(prefix, { groupId: 9n, subgroupId: 0n, objectId: 1n, publisherPriority: 128, payload: chunk(9n) });
      await old.server.closeFetchStream(prefix); await flush(256);
      expect(groups()).toEqual([9n]);
      held.get(9n)!.resolve(held.get(9n)!.obj); await flush(256);
      expect(groups()).toEqual([9n, 9n, 9n, 10n]);
      await next.send(nextAlias, 20n, chunk(20n));
      retirement.resolve(); await migration; expect(errors).toEqual([]);
      return;
    }
    held.get(11n)!.resolve(held.get(11n)!.obj); await flush(256);
    if (mode === 'retained') {
      expect(groups()).toEqual([9n, 11n]);
      expect(append.mock.calls.find(call => call[3] === 11n)?.[1]).toEqual(chunk(11n));
    } else expect(groups()).toEqual([9n]);
    await old.send(70n, 12n, chunk(12n));
    expect(groups()).toEqual(mode === 'retained' ? [9n, 11n, 12n] : [9n]);
    await next.send(nextAlias, 20n, chunk(20n)); expect(groups().at(-1)).toBe(20n);
    retirement.resolve(); await migration; await flush(256);
    const beforeLate = [...groups()];
    held.get(13n)!.resolve(held.get(13n)!.obj); await flush(256);
    expect(groups()).toEqual(beforeLate);
    expect(errors).toEqual([]);
  });
});
