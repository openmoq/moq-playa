import { describe, expect, it, vi } from 'vitest';
import { MoqtConnection } from '@openmoq/webtransport';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { buildInit, buildChunk, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { MoqtPlayer } from './player.js';
import type { MoqtPlayerConfig } from './config.js';
import { createMediaDiagnostics } from './media-diagnostics.js';
import type { MediaStageObservation } from './media-diagnostic-types.js';
import type { MediaSourceLike, MediaSeekResource, MediaSeekSample, MediaAppendObserver } from './interfaces.js';

const enc = new TextEncoder(), dec = new TextDecoder();
async function fixture(draft: 18 | 22, endOfTrack: 0 | 1 = 1, objectTransform?: MoqtPlayerConfig['objectTransform']) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const largestByAlias = new Map<bigint, { group: bigint; object: bigint }>();
  server.setLargestLocationProvider(id => {
    const alias = server.session.getIncomingSubscription(id)?.trackAlias;
    return alias === undefined ? null : largestByAlias.get(alias) ?? null;
  });
  const subs: Array<{ id: bigint; name: string }> = [], fetches: Array<{ id: bigint; name: string; namespace: string[] }> = [];
  const errors: string[] = [], observers = new Set<MediaAppendObserver>();
  const init = buildInit({ trackId: 1, timescale: 1000, handler: 'vide' });
  let nativeTime = 90, current: MediaSeekResource | null = null, sample: MediaSeekSample | null = null;
  let land: ((sample: MediaSeekSample) => void) | undefined;
  const tokens: object[] = [], resources: MediaSeekResource[] = [];
  const appended = vi.fn(), stopped = vi.fn(), seeked = vi.fn(), seeking = vi.fn();
  const source: MediaSourceLike = { mediaElement: {}, supportsTrackIdentity: true,
    onFirstFrame: null, onError: null, onStall: null,
    initialize: vi.fn(() => true), appendChunk: vi.fn(), endOfStream: vi.fn(), reset: vi.fn(), destroy: vi.fn(),
    observeAppends(observer) { observers.add(observer); return () => { observers.delete(observer); }; },
    setTimestampOffset: vi.fn(), getTimestampOffset: () => 0, setPlaybackIntent: vi.fn(),
    beginSeek(epoch) {
      current?.cancel(); sample = null;
      const identity = {};
      const resource: MediaSeekResource = { epoch, resource: identity, get current() { return current === resource; },
        initialize: vi.fn(() => true), whenAttached: async () => {},
        appendChunk: (...args) => { tokens.push(args[4]!); appended(...args); },
        observeAppends(observer) { observers.add(observer); return () => { observers.delete(observer); }; },
        getTimestampOffset: () => 0, setTimestampOffset: vi.fn(),
        position: vi.fn(() => new Promise<MediaSeekSample>(resolve => { land = resolve; })),
        sample: () => sample === null ? null : { ...sample, currentTime: nativeTime },
        setPlaybackIntent: vi.fn(), cancel: vi.fn(() => { if (current === resource) current = null; }),
      };
      current = resource; resources.push(resource); return resource;
    },
  };
  server.onSubscribe = (id, _ns, name) => { subs.push({ id, name: dec.decode(name) }); };
  server.onFetch = (id, request) => {
    if (request.fetch.fetchType !== 1) throw new Error('Expected historical standalone FETCH');
    fetches.push({ id, name: dec.decode(request.fetch.trackName), namespace: request.fetch.trackNamespace.map(field => dec.decode(field)) });
  };
  server.onError = error => errors.push(error.message);
  const connected = server.connect(b); void connected.catch(error => errors.push(String(error)));
  const player = new MoqtPlayer({ url: 'https://seek.example/moq', namespace: ['live', 'show'], draftVersion: draft,
    disableAudio: true, catalogBootstrap: 'subscribe', logLevel: 'none',
    createConnection: () => client, createTransport: async () => a,
    createMediaSource: () => source, createCmafAssembler: callbacks => new CmafAssembler(callbacks),
    ...(objectTransform ? { objectTransform } : {}),
  });
  player.on('error', event => errors.push(event.error.message)); player.on('seeked', seeked); player.on('seeking', seeking);
  const update = vi.spyOn(client, 'requestUpdate');
  const streams: bigint[] = [];
  async function send(alias: bigint, bytes: Uint8Array) {
    const stream = await server.openSubgroup(alias, 0n, 0n, { publisherPriority: 128 }); streams.push(stream);
    await server.sendObject(stream, 0n, bytes);
    largestByAlias.set(alias, { group: 0n, object: 0n });
    await flush(256);
  }
  try {
    await player.load(); await connected; await flush(256);
    await server.acceptSubscribe(subs.find(sub => sub.name === 'catalog')!.id, 100n);
    await send(100n, enc.encode(JSON.stringify({ version: '1', initDataList: [{ id: 'video-init', type: 'inline', data: Buffer.from(init).toString('base64') }], tracks: [
      { name: 'video', packaging: 'cmaf', role: 'video', isLive: false, codec: 'avc1.640028',
        width: 640, height: 360, bitrate: 500000, initRef: 'video-init' },
      { name: 'timeline', packaging: 'mediatimeline', isLive: false, mimeType: 'application/json', depends: ['video'] },
    ] })));
    await server.acceptSubscribe(subs.find(sub => sub.name === 'video')!.id, 200n);
    await server.acceptSubscribe(subs.find(sub => sub.name === 'timeline')!.id, 300n);
    await send(300n, enc.encode(JSON.stringify([[4000, [3, 0], 0]])));
    expect(source.initialize).toHaveBeenCalledOnce();
    player.play(); update.mockClear();
    const position = () => (player as MoqtPlayer & { playbackPositionMs?: number | null }).playbackPositionMs;
    async function prepareFetch() {
      expect(fetches).toHaveLength(1);
      const id = fetches[0]!.id;
      await server.acceptFetch(id, { endOfTrack, endLocation: { group: 3n, object: draft === 22 ? 0n : 1n } });
      const stream = await server.openFetchStream(id);
      await flush(128);
      return stream;
    }
    async function deliver(stream?: bigint, duration = 2000) {
      stream ??= await prepareFetch();
      await server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: 0n, publisherPriority: 128,
        payload: buildChunk({ trackId: 1, bmdt: 4000n, samples: [{ duration, size: 4, flags: SYNC_FLAGS }],
          mdat: Uint8Array.of(1, 2, 3, 4) }) });
      await server.closeFetchStream(stream); await flush(256);
    }
    return { player, client, server, source, errors, resources, fetches, update, seeking, seeked, stopped, appended, position, deliver, prepareFetch, send,
      setTime(value: number) { nativeTime = value; },
      append() { for (const observer of [...observers]) observer({ token: tokens[tokens.length - 1]!, state: 'appended', reason: null }); },
      land() { const resource = current!; nativeTime = 5.125; sample = { epoch: resource.epoch, resource: resource.resource,
        currentTime: nativeTime, buffered: { start: 4, end: 6 } }; land!(sample); },
      async destroy() { for (const stream of streams) await server.closeSubgroup(stream); await player.destroy(); await server.close(); },
    };
  } catch (error) { await player.destroy(); await server.close(); throw error; }
}

describe.each([18, 22] as const)('player-owned seek output draft %s', draft => {
  it('keeps the logical transform identity when a second seek follows ordinary subscription retirement', async () => {
    const aliases: bigint[] = [], f = await fixture(draft, 1, object => { aliases.push(BigInt(object.trackAlias)); return object; });
    try {
      await firstLanded(f); expect(aliases).toEqual([200n]); expect(f.player.seekable).toBe(true);
      await f.player.seek(5500); await flush(256);
      const id = f.fetches[1]!.id;
      await f.server.acceptFetch(id, { endOfTrack: 1, endLocation: { group: 3n, object: draft === 22 ? 0n : 1n } });
      await f.deliver(await f.server.openFetchStream(id));
      expect(aliases).toEqual([200n, 200n]); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('preserves a successor admitted by a transform-owner resource getter', async () => {
    const f = await fixture(draft); let nested: Promise<void> | undefined;
    try {
      await firstLanded(f); const prior = f.resources[0]!;
      const read = Object.getOwnPropertyDescriptor(prior, 'current')!.get!.bind(prior);
      let entered = false;
      vi.spyOn(prior, 'current', 'get').mockImplementation(() => {
        const current = read();
        if (!entered) { entered = true; nested = f.player.seek(5250); void nested.catch(() => {}); }
        return current;
      });
      await expect(f.player.seek(5500)).rejects.toThrow(/superseded/); await nested; await flush(256);
      expect(f.fetches).toHaveLength(2); expect(f.position()).toBe(5250); expect(prior.current).toBe(true);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('retires the captured input when a public media observer throws before transfer', async () => {
    const f = await fixture(draft), stages: MediaStageObservation[] = [], receipts: object[] = [];
    const off = f.player.observeMediaStages(event => { stages.push(event); }, { createTracker: createMediaDiagnostics });
    const unobserve = f.client.observeObjectReceipts(event => { receipts.push(event.receipt); });
    f.player.on('media_object', () => { throw new Error('fixture public observer failure'); });
    try {
      await f.player.seek(5000); await flush(256); await f.deliver();
      expect(receipts).toHaveLength(1); expect(f.appended).not.toHaveBeenCalled(); expect(f.resources).toHaveLength(0);
      expect(f.errors).toHaveLength(1);
      expect(stages).toEqual([{ unit: null, inputs: [receipts[0]], stage: 'discarded', reason: 'object processing failed' }]);
    } finally { off(); unobserve(); await f.destroy(); }
  });

  it('does not transfer a receipt to diagnostics installed by a public media observer', async () => {
    const f = await fixture(draft), fresh: MediaStageObservation[] = [];
    let off = f.player.observeMediaStages(() => {}, { createTracker: createMediaDiagnostics });
    f.player.on('media_object', () => {
      off(); off = f.player.observeMediaStages(event => { fresh.push(event); }, { createTracker: createMediaDiagnostics });
    });
    try {
      await f.player.seek(5000); await flush(256); await f.deliver();
      f.append(); await flush(256); f.land(); await flush(256);
      expect(f.seeked).toHaveBeenCalledOnce(); expect(fresh).toEqual([]);
      expect(f.player.diagnosticSnapshot().mediaStages?.unattributedInputCount).toBe(0);
      expect(f.errors).toEqual([]);
    } finally { off(); await f.destroy(); }
  });

  it.each([1000, 2000])('requires parsed target coverage before replacing healthy output (duration %s)', async duration => {
    const f = await fixture(draft);
    try {
      await firstLanded(f); const prior = f.resources[0]!;
      await f.player.seek(5500); await flush(256);
      const id = f.fetches[1]!.id;
      await f.server.acceptFetch(id, { endOfTrack: 0, endLocation: { group: 3n, object: draft === 22 ? 0n : 1n } });
      await f.deliver(await f.server.openFetchStream(id), duration); f.append(); await flush(256);
      if (duration === 1000) {
        expect(prior.current).toBe(true); expect(prior.cancel).not.toHaveBeenCalled();
        expect(f.resources).toHaveLength(1); expect(f.player.state).toBe('playing');
        expect(f.position()).toBe(5125); expect(f.seeked).toHaveBeenCalledOnce();
        expect(f.errors).toHaveLength(1); expect(f.errors[0]).toMatch(/coverage/);
      } else {
        expect(f.resources).toHaveLength(2); expect(prior.current).toBe(false);
        expect(f.resources[1]!.position).toHaveBeenCalledOnce(); expect(f.errors).toEqual([]);
        expect(f.seeked).toHaveBeenCalledOnce(); expect(f.position()).toBe(5500);
      }
    } finally { await f.destroy(); }
  });

  it('does not use paced FETCH progress as live subscription or bandwidth evidence', async () => {
    const f = await fixture(draft);
    const internals = f.player as unknown as {
      stampMediaArrival(alias: bigint): void;
      recordVideoPayload(...args: unknown[]): void;
    };
    const live = vi.spyOn(internals, 'stampMediaArrival'), bandwidth = vi.spyOn(internals, 'recordVideoPayload');
    try {
      await f.send(200n, buildChunk({ trackId: 1, bmdt: 4000n,
        samples: [{ duration: 2000, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(1, 2, 3, 4) }));
      expect(live).toHaveBeenCalled(); expect(bandwidth).toHaveBeenCalled();
      live.mockClear(); bandwidth.mockClear();
      await f.player.seek(5000); await flush(256); await f.deliver();
      expect(f.appended).toHaveBeenCalledOnce();
      expect(live).not.toHaveBeenCalled(); expect(bandwidth).not.toHaveBeenCalled();
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('does not transfer pre-transform receipt ownership to a new observation lifetime', async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(draft, 1, async object => { await wait; return { ...object }; });
    const old: MediaStageObservation[] = [], fresh: MediaStageObservation[] = [];
    const first = f.player.observeMediaStages(event => { old.push(event); }, { createTracker: createMediaDiagnostics });
    let second = () => {};
    try {
      await f.player.seek(5000); await flush(256); await f.deliver();
      expect(f.appended).not.toHaveBeenCalled(); first();
      second = f.player.observeMediaStages(event => { fresh.push(event); }, { createTracker: createMediaDiagnostics });
      release(); await flush(256); expect(f.appended).toHaveBeenCalledOnce();
      f.append(); await flush(256); f.land(); await flush(256);
      expect(f.seeked).toHaveBeenCalledOnce(); expect(old).toEqual([]); expect(fresh).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally { release(); first(); second(); await f.destroy(); }
  });

  it('correlates historical reconstruction and native append with the original FETCH receipt', async () => {
    const f = await fixture(draft), stages: MediaStageObservation[] = [], receipts: object[] = [];
    const off = f.player.observeMediaStages(event => { stages.push(event); }, { createTracker: createMediaDiagnostics });
    const unobserve = f.client.observeObjectReceipts(event => { receipts.push(event.receipt); });
    try {
      await f.player.seek(5000); await flush(256); await f.deliver();
      expect(f.appended).toHaveBeenCalledOnce();
      expect(stages.map(event => event.stage)).toEqual(['reconstructed']);
      expect(receipts).toHaveLength(1); expect(stages[0]!.inputs).toEqual(receipts);
      f.append(); await flush(256);
      expect(stages.map(event => event.stage)).toEqual(['reconstructed', 'appended']);
      expect(stages[1]!.unit).toBe(stages[0]!.unit); expect(stages[1]!.inputs).toEqual(receipts);
      f.land(); await flush(256); expect(f.seeked).toHaveBeenCalledOnce();
      expect(f.player.diagnosticSnapshot().mediaStages?.evidenceLossCount).toBe(0);
    } finally { off(); unobserve(); await f.destroy(); }
  });

  it('keeps native seek credit working after diagnostics detach during a pending append', async () => {
    const f = await fixture(draft), stages: MediaStageObservation[] = [];
    const off = f.player.observeMediaStages(event => { stages.push(event); }, { createTracker: createMediaDiagnostics });
    try {
      await f.player.seek(5000); await flush(256); await f.deliver();
      expect(stages.map(event => event.stage)).toEqual(['reconstructed']); off();
      f.append(); await flush(256); f.land(); await flush(256);
      expect(f.seeked).toHaveBeenCalledOnce(); expect(stages.map(event => event.stage)).toEqual(['reconstructed']);
      expect(f.errors).toEqual([]);
    } finally { off(); await f.destroy(); }
  });

  it('renews the existing first-frame deadline on seek append without pretending a frame rendered', async () => {
    vi.useFakeTimers(); const f = await fixture(draft);
    try {
      await vi.advanceTimersByTimeAsync(9000);
      await firstLanded(f);
      expect(f.player.stats.ttffBreakdown?.firstFrameRenderedMs).toBeNull();
      await vi.advanceTimersByTimeAsync(1500);
      expect(f.player.state).toBe('playing'); expect(f.errors).toEqual([]);
      f.source.onFirstFrame!();
      expect(f.player.stats.ttffBreakdown?.firstFrameRenderedMs).not.toBeNull();
    } finally { await f.destroy(); vi.useRealTimers(); }
  });

  it('reports historical media to public observers and reception counters once', async () => {
    const f = await fixture(draft), media = vi.fn();
    try {
      f.player.on('media_object', media);
      const before = f.player.stats;
      await f.player.seek(5000); await flush(256); await f.deliver();
      expect(media).toHaveBeenCalledOnce();
      const object = media.mock.calls[0]![0];
      expect(object).toMatchObject({ mediaType: 'video', trackName: 'video', groupId: 3n, objectId: 0n, kind: 'data' });
      expect(object.payload).toBeInstanceOf(Uint8Array);
      expect(f.player.stats.objectsReceived - before.objectsReceived).toBe(1);
      expect(f.player.stats.bytesReceived - before.bytesReceived).toBe(object.payload.length);
      expect(f.player.stats.ttffBreakdown?.firstObjectReceivedMs).not.toBeNull();
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('fences historical media after a public object observer replaces its seek', async () => {
    const f = await fixture(draft); let replacement: Promise<void> | undefined;
    try {
      const media = vi.fn(() => { replacement = f.player.seek(5500); void replacement.catch(() => {}); });
      f.player.on('media_object', media);
      await f.player.seek(5000); await flush(256); await f.deliver(); await replacement; await flush(256);
      expect(media).toHaveBeenCalledOnce(); expect(f.fetches).toHaveLength(2);
      expect(f.resources).toHaveLength(0); expect(f.appended).not.toHaveBeenCalled();
      expect(f.position()).toBe(5500); expect(f.seeked).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('does not publish or count media rejected by the application transform', async () => {
    const f = await fixture(draft, 1, () => null), media = vi.fn();
    try {
      f.player.on('media_object', media); const before = f.player.stats;
      await f.player.seek(5000); await flush(256); await f.deliver();
      expect(media).not.toHaveBeenCalled();
      expect(f.player.stats.objectsReceived).toBe(before.objectsReceived);
      expect(f.player.stats.bytesReceived).toBe(before.bytesReceived);
      expect(f.resources).toHaveLength(0);
    } finally { await f.destroy(); }
  });

  it('waits for FETCH acceptance before replacing the native output with early media', async () => {
    const f = await fixture(draft);
    try {
      await f.player.seek(5000); await flush(256);
      const id = f.fetches[0]!.id, stream = await f.server.openFetchStream(id);
      await f.deliver(stream);
      expect(f.errors).toEqual([]);
      expect(f.resources).toHaveLength(0);
      expect(f.appended).not.toHaveBeenCalled(); expect(f.seeked).not.toHaveBeenCalled();
      await f.server.acceptFetch(id, { endOfTrack: 1, endLocation: { group: 3n, object: draft === 22 ? 0n : 1n } });
      await flush(256);
      expect(f.resources).toHaveLength(1); expect(f.appended).toHaveBeenCalledOnce();
      f.append(); await flush(256); f.land(); await flush(256);
      expect(f.seeked).toHaveBeenCalledOnce(); expect(f.position()).toBe(5125);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('preserves established playback when early replacement media is followed by a FETCH refusal', async () => {
    const f = await fixture(draft);
    try {
      await firstLanded(f);
      const prior = f.resources[0]!;
      await f.player.seek(5500); await flush(256);
      const id = f.fetches[1]!.id, stream = await f.server.openFetchStream(id);
      await f.deliver(stream);
      expect(f.resources).toHaveLength(1);
      expect(prior.current).toBe(true); expect(prior.cancel).not.toHaveBeenCalled();
      await f.server.rejectFetch(id, 3n, 'fixture refusal after early media'); await flush(256);
      expect(f.resources).toHaveLength(1); expect(prior.current).toBe(true);
      expect(prior.cancel).not.toHaveBeenCalled(); expect(f.position()).toBe(5125);
      expect(f.seeked).toHaveBeenCalledOnce(); expect(f.player.state).toBe('playing');
      expect(f.errors).toHaveLength(1); expect(f.errors[0]).toMatch(/Seek media preparation failed/);
    } finally { await f.destroy(); }
  });

  it('retrieves history and emits seeked only after its own native landing, then reads without ticks', async () => {
    const f = await fixture(draft);
    try {
      await f.player.seek(5000); await flush(256);
      expect(f.errors).toEqual([]);
      expect(f.fetches).toEqual([{ id: expect.any(BigInt), name: 'video', namespace: ['live', 'show'] }]);
      expect(f.update).not.toHaveBeenCalled(); expect(f.position()).toBe(5000); expect(f.seeked).not.toHaveBeenCalled();
      f.setTime(91); expect(f.position()).toBe(5000);
      await f.deliver(); expect(f.resources).toHaveLength(1); expect(f.appended).toHaveBeenCalledOnce();
      expect(f.resources[0]!.position).not.toHaveBeenCalled();
      f.append(); await flush(256); expect(f.seeked).not.toHaveBeenCalled();
      f.land(); await flush(256);
      expect(f.seeked).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ actualTimeMs: 5125 }));
      expect(f.position()).toBe(5125);
      f.setTime(5.5); expect(f.position()).toBe(5500);
      expect(f.resources[0]!.current).toBe(true); expect(f.resources[0]!.cancel).not.toHaveBeenCalled();
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('lands a paused seek without autoplay and freezes its observed clock until play', async () => {
    const f = await fixture(draft);
    try {
      f.player.pause(); f.update.mockClear();
      await f.player.seek(5000); await flush(256); await f.deliver();
      f.append(); await flush(256); f.land(); await flush(256);
      expect(f.position()).toBe(5125);
      expect(f.resources[0]!.setPlaybackIntent).toHaveBeenLastCalledWith(false);
      f.setTime(5.6); expect(f.position()).toBe(5125);
      f.player.play(); expect(f.position()).toBe(5600);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('a refused seek keeps a held switch recovery; an admitted seek releases it only when it takes over the output', async () => {
    const f = await fixture(draft);
    const held = (f.player as unknown as { videoSwitchRecovery: { owner: object; handle: { activate(): void; revoke(): void } } | null });
    const handle = { activate: vi.fn(), revoke: vi.fn() };
    try {
      held.videoSwitchRecovery = { owner: {}, handle };
      let refusing = true; f.player.hooks.beforeSubscribe.add(intent => refusing ? null : intent);
      await expect(f.player.seek(5000)).rejects.toThrow(/declined by beforeSubscribe/);
      expect(handle.revoke, 'playback is unchanged by a refused seek').not.toHaveBeenCalled();
      expect(held.videoSwitchRecovery?.handle).toBe(handle); expect(f.resources).toEqual([]);
      refusing = false;
      await f.player.seek(5000); await flush(256);
      expect(f.resources, 'admitted, still retrieving: the output is not replaced yet').toEqual([]);
      expect(handle.revoke).not.toHaveBeenCalled();
      await f.deliver();
      expect(f.resources).toHaveLength(1);
      expect(handle.revoke, 'released when the seek replaced the output').toHaveBeenCalledOnce();
      expect(held.videoSwitchRecovery).toBeNull(); expect(handle.activate).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });

  it('rejects invalid admission before a clock owner or native resource exists', async () => {
    const f = await fixture(draft);
    try {
      await expect(f.player.seek(NaN)).rejects.toThrow(/finite/);
      expect(f.position()).toBeNull(); expect(f.resources).toEqual([]); expect(f.fetches).toEqual([]);
      expect(f.seeking).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });

  it('does not report finite FETCH completion as a later playback stall', async () => {
    const f = await fixture(draft), ended = vi.fn(), stalled = vi.fn();
    f.player.on('track_ended', ended); f.player.on('stall', stalled);
    try {
      await f.player.seek(5000); await flush(256); await f.deliver();
      f.append(); await flush(256); f.land(); await flush(256);
      expect(ended).toHaveBeenCalledExactlyOnceWith({ type: 'track_ended', mediaType: 'video' });
      f.source.onStall!(517);
      expect(stalled).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('keeps the old stall eligible during preparation and cancels it before native replacement', async () => {
    const f = await fixture(draft), order: string[] = [], stalled = vi.fn();
    const begin = f.source.beginSeek!.bind(f.source);
    f.source.cancelStallEpisode = () => { order.push('cancel'); };
    f.source.beginSeek = epoch => { order.push('replace'); return begin(epoch); };
    f.player.on('stall', stalled);
    try {
      await f.player.seek(5000); await flush(256);
      expect(order).toEqual([]);
      f.source.onStall!(250); expect(stalled).toHaveBeenCalledOnce();
      await f.deliver();
      expect(order).toEqual(['cancel', 'replace']);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('does not adopt late FETCH media after an unrecoverable output failure', async () => {
    const f = await fixture(draft);
    try {
      await f.player.seek(5000); await flush(256);
      const stream = await f.prepareFetch();
      f.source.onError!(Object.assign(new Error('fixture native failure'), { name: 'MediaGapUnrecoverableError' }));
      expect(f.player.state).toBe('error');
      await f.deliver(stream);
      expect(f.resources).toEqual([]); expect(f.appended).not.toHaveBeenCalled();
      expect(f.seeked).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });

  it('freezes an established seek clock when playback enters an error state', async () => {
    const f = await fixture(draft);
    try {
      await firstLanded(f);
      f.source.onError!(Object.assign(new Error('fixture native failure'), { name: 'MediaGapUnrecoverableError' }));
      expect(f.player.state).toBe('error');
      f.setTime(5.8);
      expect(f.position()).toBe(5125);
    } finally { await f.destroy(); }
  });

  it('samples the owned output once when the engine is paused directly', async () => {
    const f = await fixture(draft);
    try {
      await firstLanded(f); f.setTime(5.6);
      f.player.pause();
      expect(f.position()).toBe(5600);
      f.setTime(5.9); expect(f.position()).toBe(5600);
    } finally { await f.destroy(); }
  });

  it('does not publish a landing when its producing sample enters a fatal state', async () => {
    const f = await fixture(draft);
    try {
      await f.player.seek(5000); await flush(256); await f.deliver();
      f.append(); await flush(256);
      const resource = f.resources[0]!, read = resource.sample.bind(resource);
      vi.spyOn(resource, 'sample').mockImplementation(() => {
        const sample = read();
        f.source.onError!(Object.assign(new Error('fixture native failure'), { name: 'MediaGapUnrecoverableError' }));
        return sample;
      });
      f.land(); await flush(256);
      expect(f.player.state).toBe('error'); expect(f.seeked).not.toHaveBeenCalled();
      expect(resource.setPlaybackIntent).not.toHaveBeenCalledWith(true);
    } finally { await f.destroy(); }
  });
});

async function firstLanded(f: Awaited<ReturnType<typeof fixture>>) {
  await f.player.seek(5000); await flush(256); await f.deliver();
  f.append(); await flush(256); f.land(); await flush(256);
  expect(f.position()).toBe(5125);
}

it('failed uncommitted replacement restores the still-current adopted output clock', async () => {
  const f=await fixture(18);
  try {
    await firstLanded(f); f.setTime(5.5);
    await f.player.seek(5500); await flush(256);
    expect(f.fetches).toHaveLength(2);
    await f.server.rejectFetch(f.fetches[1]!.id, 3n, 'fixture refusal'); await flush(256);
    expect(f.position()).toBe(5500); expect(f.resources[0]!.current).toBe(true);
    expect(f.resources[0]!.cancel).not.toHaveBeenCalled();
    expect(f.errors).toHaveLength(1); expect(f.errors[0]).toMatch(/Seek media preparation failed/);
  } finally { await f.destroy(); }
});

it('a replacement seek admitted during failed-seek fallback sampling must keep its clock ownership', async () => {
  const f=await fixture(18); let nested: Promise<void> | undefined;
  try {
    await firstLanded(f);
    await f.player.seek(5500); await flush(256);
    const prior=f.resources[0]!, read=prior.sample.bind(prior); let reentered=false;
    vi.spyOn(prior,'sample').mockImplementation(() => {
      const observed=read();
      if(!reentered) { reentered=true; nested=f.player.seek(5250); void nested.catch(() => {}); }
      return observed;
    });
    await f.server.rejectFetch(f.fetches[1]!.id, 3n, 'fixture refusal'); await flush(256); await nested;
    expect(reentered).toBe(true); expect(f.fetches).toHaveLength(3);
    expect(f.position()).toBe(5250);
  } finally { await f.destroy(); }
});

it('a newer seek admitted by the public seeking callback keeps its held target', async () => {
  const f=await fixture(18); let nested: Promise<void> | undefined, once=false;
  try {
    f.player.on('seeking', () => { if(!once) { once=true; nested=f.player.seek(5500); void nested.catch(() => {}); } });
    await f.player.seek(5000); await nested; await flush(256);
    expect(f.position()).toBe(5500); expect(f.fetches).toHaveLength(1);
    expect(f.resources).toHaveLength(0); expect(f.errors).toEqual([]);
  } finally { await f.destroy(); }
});

it('unsupported owned output is rejected before clock/native/request mutation', async () => {
  const f=await fixture(18);
  try {
    delete f.source.beginSeek;
    await expect(f.player.seek(5000)).rejects.toThrow(/owned seek output/);
    expect(f.position()).toBeNull(); expect(f.resources).toHaveLength(0);
    expect(f.fetches).toHaveLength(0); expect(f.seeking).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
  } finally { await f.destroy(); }
});


it('FIN without End Of Track leaves ordinary native stall eligible', async () => {
  const f=await fixture(18,0), ended=vi.fn(), stalled=vi.fn();
  f.player.on('track_ended', ended); f.player.on('stall', stalled);
  try {
    await firstLanded(f);
    expect(ended).not.toHaveBeenCalled();
    f.source.onStall!(517);
    expect(stalled).toHaveBeenCalledExactlyOnceWith({type:'stall',durationMs:517});
  } finally { await f.destroy(); }
});


it('a fatal state entered during owned output sampling cannot advance its cached clock',async()=>{
 const f=await fixture(18);
 try {
  await firstLanded(f); f.setTime(5.8);
  const resource=f.resources[0]!, read=resource.sample.bind(resource); let once=false;
  const sample=vi.spyOn(resource,'sample').mockImplementation(()=>{
   const result=read();
   if(!once){once=true; f.source.onError!(Object.assign(new Error('fixture native failure'),{name:'MediaGapUnrecoverableError'}));}
   return result;
  });
  expect(f.position()).toBe(5125);
  expect(f.player.state).toBe('error'); expect(sample).toHaveBeenCalledOnce();
  expect(f.position()).toBe(5125); expect(sample).toHaveBeenCalledOnce();
 } finally {await f.destroy();}
});
it('read(false) holds without invoking an active owned reader',async()=>{
 const f=await fixture(18);
 try {
  await firstLanded(f); f.source.onError!(Object.assign(new Error('fixture native failure'),{name:'MediaGapUnrecoverableError'})); f.setTime(5.8);
  const sample=vi.spyOn(f.resources[0]!,'sample');
  expect(f.position()).toBe(5125); expect(sample).not.toHaveBeenCalled();
 } finally {await f.destroy();}
});
