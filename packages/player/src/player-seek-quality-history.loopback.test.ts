import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageParam } from '@openmoq/transport';
import { MoqtConnection, catToken } from '@openmoq/webtransport';
import { LocmafEncoder, LocmafGroupState, LocmafTrackDecoder, isSyncSampleFlags, parseLocmafTrackContext, readCmafObjectSamples, serializeLocmafObject } from '@openmoq/locmaf';
import { identityKey } from '@openmoq/msf';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { createLoopback, flush, type LoopPipe } from '../../webtransport/src/testkit/loopback.js';
import { buildInit, buildChunk, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { MoqtPlayer } from './player.js';
import { MseSeekPlayback } from './mse-seek-playback.js';
import type { MediaAppendObserver, MediaSeekResource, MediaSeekSample, MediaSourceLike } from './interfaces.js';

afterEach(() => vi.restoreAllMocks());
const enc = new TextEncoder(), dec = new TextDecoder(), namespace = ['live', 'quality-history'];
const ref = (name: string) => ({ namespace, name });
type Role = 'video' | 'audio';
type Location = { group: bigint; object: bigint };
interface Fetch { id: bigint; name: string; namespace: string[]; start: Location; end: Location; order: unknown; }
const inits = { video: buildInit({ trackId: 1, timescale: 1000, handler: 'vide' }), audio: buildInit({ trackId: 2, timescale: 1000, handler: 'soun' }) };
const role = (name: string): Role => name === 'audio' ? 'audio' : 'video';
const marker = (name: string) => name === 'old-video' ? 11 : name === 'new-video' ? 22 : 33;
const timeline = [[4000, [3, 0], 0], [6000, [4, 0], 0], [8000, [4, 1], 0], [10000, [5, 0], 0], [3600000, [900, 0], 0]];

// Real player, SDK and format consumers. Native terminals/position are controlled; this is not browser evidence.
async function fixture(draft: 18 | 22, options: {
  authorization?: ConstructorParameters<typeof MoqtPlayer>[0]['authorization'];
  timelineEntries?: readonly (readonly [number, readonly [number, number], number])[];
  timelineLive?: boolean;
  clock?: ConstructorParameters<typeof MoqtPlayer>[0]['clock'];
} = {}) {
  const { a, b } = createLoopback(), client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const subscriptions: Array<{ id: bigint; name: string; namespace: string[] }> = [], fetches: Fetch[] = [], errors: string[] = [];
  const states = new Map<string, LocmafGroupState>(), encoders = new Map<string, LocmafEncoder>(), payloadCache = new Map<string, Uint8Array>();
  const streams = new Map<string, bigint>(), fetchStreams = new Map<bigint, { id: bigint; pipe: LoopPipe }>();
  const observers = new Set<MediaAppendObserver>(), resources: MediaSeekResource[] = [];
  const installed = new Map<Role, Uint8Array>(), offsets = new Map<Role, number>(), held = new Set<Role>();
  const seeked = vi.fn(), switched = vi.fn(), trace: Array<Record<string, unknown>> = [];
  const fetchCancel = vi.spyOn(client, 'fetchCancel'), unsubscribe = vi.spyOn(client, 'unsubscribe');
  const appends: Array<{ role: Role; name: string; key: string | undefined; marker: number; start: number; end: number; token: object | undefined; owner: object | null; completed: boolean; buffered: boolean; queued: boolean; discarded: boolean; bytes: Uint8Array }> = [];
  const leases: Array<{ roles: Role[]; outcome: 'discard' | 'resume' }> = [];
  let resource: MediaSeekResource | null = null, sample: MediaSeekSample | null = null, now = 0;
  let nativePaused: boolean | undefined = true, nativeRate: number | undefined = 1;
  let nativeClock: (() => number) | undefined;
  let positionResolve: ((sample: MediaSeekSample) => void) | null = null;
  const coverage = (kind: Role) => {
    const parts = appends.filter(row => row.owner === resource?.resource && row.role === kind && row.buffered && !row.discarded).sort((x, y) => x.start - y.start);
    if (!parts.length) return null;
    let end = parts[0]!.end;
    for (const part of parts.slice(1)) { if (part.start > end) break; end = Math.max(end, part.end); }
    return { start: parts[0]!.start, end };
  };
  const commonCoverage = () => {
    const video = coverage('video'), audio = coverage('audio');
    if (!video || !audio) throw new Error('Both native roles need real completed media');
    const common = { start: Math.max(video.start, audio.start), end: Math.min(video.end, audio.end) };
    if (common.end < common.start) throw new Error('Native role coverage does not overlap');
    return common;
  };
  function terminal(index: number) {
    const row = appends[index]; if (!row || row.completed || row.queued || row.discarded) throw new Error('Expected one unheld native append');
    row.completed = true; row.buffered = true;
    if (row.token) for (const observer of [...observers]) observer({ token: row.token, state: 'appended', reason: null });
  }
  function record(kind: Role, bytes: Uint8Array, name: string, token: object | undefined, key: string | undefined, owner: object | null) {
    const init = installed.get(kind); if (!init) throw new Error('Missing actual role initialization');
    const read = readCmafObjectSamples(bytes, parseLocmafTrackContext(init))?.[0]; if (!read) throw new Error('Incomplete native media');
    const start = Number(read.effective.baseMediaDecodeTime + BigInt(read.effective.compositionTimeOffsets[0] ?? 0)) / 1000;
    const end = start + read.effective.durations.reduce((sum, value) => sum + value, 0) / 1000;
    appends.push({ role: kind, name, key, marker: read.mdat[0]!, start, end, token, owner, completed: false, buffered: false, queued: held.has(kind), discarded: false, bytes: bytes.slice() });
    trace.push({ kind: 'native-submission', role: kind, name, key, start, end, marker: read.mdat[0] });
    if (owner === null && !held.has(kind)) terminal(appends.length - 1);
  }
  const initialize = (config: Parameters<MediaSourceLike['initialize']>[0]) => {
    for (const kind of ['video', 'audio'] as const) if (config[kind]) { installed.set(kind, config[kind].initData.slice()); offsets.set(kind, 0); }
    return true;
  };
  const source: MediaSourceLike = { supportsTrackIdentity: true, mediaElement: {}, onFirstFrame: null, onError: null, onStall: null,
    initialize: vi.fn(initialize), appendChunk(kind, bytes, name, _group, token, key) { record(kind, bytes, name, token, key, null); },
    observeAppends(observer) { observers.add(observer); return () => { observers.delete(observer); }; },
    getTimestampOffset: kind => offsets.get(kind), setTimestampOffset(kind, value) { offsets.set(kind, value); },
    changeType: vi.fn(async (kind, _codec, init) => { installed.set(kind, init.slice()); }),
    clearTimeline() {}, reset: vi.fn(), destroy() { resource = null; }, endOfStream: vi.fn(), setPlaybackIntent() {},
    holdQueuedAppends(kinds) {
      if (kinds.some(kind => held.has(kind))) throw new Error('Role queue already held');
      const captured = resource; let active = true; for (const kind of kinds) held.add(kind);
      const finish = (discard: boolean) => {
        if (!active || captured !== resource) return;
        active = false; for (const kind of kinds) held.delete(kind);
        for (const row of appends) if (row.queued && !row.discarded && kinds.includes(row.role)) {
          row.queued = false;
          if (discard) {
            row.discarded = true;
            if (row.token) for (const observer of [...observers]) observer({ token: row.token, state: 'discarded', reason: 'retype' });
          }
        }
        leases.push({ roles: [...kinds], outcome: discard ? 'discard' : 'resume' });
      };
      return { get current() { return active && captured === resource; }, resume() { finish(false); }, discard() { finish(true); } };
    },
    beginSeek(epoch) {
      const identity = {}; sample = null;
      const owned: MediaSeekResource = { epoch, resource: identity, get current() { return resource === owned; },
        initialize: vi.fn(initialize), whenAttached: async () => {},
        appendChunk(kind, bytes, name, _group, token, key) { record(kind, bytes, name, token, key, identity); },
        observeAppends(observer) { observers.add(observer); return () => { observers.delete(observer); }; },
        getTimestampOffset: kind => offsets.get(kind), setTimestampOffset(kind, value) { offsets.set(kind, value); },
        position: vi.fn(() => new Promise<MediaSeekSample>(resolve => { positionResolve = resolve; })),
        sample: () => sample && { ...sample, currentTime: nativeClock?.() ?? now, buffered: commonCoverage(),
          ...(nativePaused === undefined ? {} : { paused: nativePaused }), ...(nativeRate === undefined ? {} : { playbackRate: nativeRate }) },
        setPlaybackIntent: vi.fn(playing => { nativePaused = !playing; }), cancel: vi.fn(() => { if (resource === owned) resource = null; }) };
      resource = owned; resources.push(owned); return owned;
    },
  };
  server.onSubscribe = (id, fields, name) => { subscriptions.push({ id, namespace: fields.map(field => dec.decode(field)), name: dec.decode(name) }); };
  server.onFetch = (id, message) => {
    if (message.fetch.fetchType !== 1) throw new Error('This bounded fixture requires standalone published history');
    const request = message.fetch;
    fetches.push({ id, name: dec.decode(request.trackName), namespace: request.trackNamespace.map(field => dec.decode(field)),
      start: request.startLocation, end: request.endLocation, order: message.parameters.get(MessageParam.GROUP_ORDER)?.[0] });
    trace.push({ kind: 'FETCH', id, name: dec.decode(request.trackName), start: request.startLocation, end: request.endLocation });
  };
  server.onError = error => { errors.push('peer: ' + error.message); };
  const connected = server.connect(b); void connected.catch(error => { errors.push(String(error)); });
  const player = new MoqtPlayer({ url: 'https://quality-history.invalid/moq', namespace, draftVersion: draft,
    catalogBootstrap: 'subscribe', reconnectAttempts: 0, connectionTimeoutMs: 10000, cmafBootstrapTimeoutMs: 0,
    autoQuality: false, locmafDecoding: 'mse', logLevel: 'none',
    ...(options.authorization ? { authorization: options.authorization } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    selection: { renderGroup: 1, videoTrack: ref('old-video'), audioTrack: ref('audio') },
    createConnection: () => client, createTransport: async () => a, createMediaSource: () => source, createCmafAssembler: callbacks => new CmafAssembler(callbacks) });
  player.on('error', event => { errors.push(event.error.message); }); player.on('seeked', seeked); player.on('quality_switched', switched);
  async function acceptSub(name: string, alias: bigint) {
    const request = subscriptions.filter(sub => sub.name === name).at(-1); expect(request?.namespace).toEqual(namespace);
    if (!request) throw new Error('Missing actual subscription: ' + name); await server.acceptSubscribe(request.id, alias); await flush(256);
  }
  function payload(name: string, group: bigint, id: bigint, pts: bigint, duration = 2000) {
    const key = name + '/' + group, objectKey = key + '/' + id, cached = payloadCache.get(objectKey); if (cached) return cached;
    const state = states.get(key) ?? new LocmafGroupState(), encoder = encoders.get(key) ?? new LocmafEncoder(); states.set(key, state); encoders.set(key, encoder);
    const kind = role(name), bytes = buildChunk({ trackId: kind === 'video' ? 1 : 2, bmdt: pts,
      samples: [{ duration, size: 4, flags: id === 0n ? SYNC_FLAGS : NON_SYNC_FLAGS }], mdat: Uint8Array.of(marker(name), Number(id), 3, 4) });
    const encoded = encoder.encode(bytes, state, parseLocmafTrackContext(inits[kind]), false, id);
    const data = serializeLocmafObject(encoded); payloadCache.set(objectKey, data); return data;
  }
  async function publish(name: string, alias: bigint, group: bigint, id: bigint, bytes: Uint8Array) {
    const key = name + '/' + group; let stream = streams.get(key);
    if (stream === undefined) { stream = await server.openSubgroup(alias, group, 0n, { publisherPriority: 128 }); streams.set(key, stream); }
    await server.sendObject(stream, id, bytes); await flush(512);
  }
  async function open(request: Fetch, last: Location, endOfTrack = false) {
    await server.acceptFetch(request.id, { endOfTrack: endOfTrack ? 1 : 0, endLocation: draft === 22 ? last : { group: last.group, object: last.object + 1n } });
    const index = b.uniOut.length, id = await server.openFetchStream(request.id), pipe = b.uniOut[index];
    if (!pipe) throw new Error('Missing actual response pipe'); fetchStreams.set(request.id, { id, pipe }); return id;
  }
  async function send(request: Fetch, group: bigint, id: bigint, pts: bigint, duration = 2000) {
    const stream = fetchStreams.get(request.id); if (!stream) throw new Error('Response stream was not opened');
    await server.sendFetchObject(stream.id, { groupId: group, subgroupId: 0n, objectId: id, publisherPriority: 128, payload: payload(request.name, group, id, pts, duration) }); await flush(512);
  }
  async function completeNative(only?: Role) {
    for (let turn = 0; turn < 8; turn++) {
      await flush(256); const index = appends.findIndex(row => row.owner === resource?.resource && !row.completed && !row.queued && !row.discarded && (only === undefined || row.role === only));
      if (index < 0) return; terminal(index);
    }
    throw new Error('Unexpected native completion backlog');
  }
  async function close(request: Fetch) { await server.closeFetchStream(fetchStreams.get(request.id)!.id); await flush(512); }
  const request = (name: string, group: bigint, object: bigint) => {
    const found = fetches.find(row => row.name === name && row.start.group === group && row.start.object === object);
    expect(found, 'missing issued historical request ' + name + '/' + group + '/' + object).toBeDefined(); return found!;
  };
  async function destroy() { await player.destroy(); await server.close(); }
  try {
    await player.load(); await connected; await flush(256); await acceptSub('catalog', 100n);
    const tracks = [{ name: 'old-video', role: 'video', altGroup: 11, bitrate: 100000, width: 640, height: 360 },
      { name: 'new-video', role: 'video', altGroup: 11, bitrate: 200000, width: 640, height: 360 },
      { name: 'audio', role: 'audio', altGroup: 21, bitrate: 64000, samplerate: 48000, channelConfig: '2', lang: 'en' }]
      .map(track => ({ ...track, packaging: 'locmaf', locmafVersion: '0.3', renderGroup: 1, isLive: true,
        codec: track.role === 'video' ? 'avc1.640028' : 'mp4a.40.2', initRef: track.role + '-init' }));
    await publish('catalog', 100n, 0n, 0n, enc.encode(JSON.stringify({ version: '1', initDataList: (['video', 'audio'] as const).map(kind => ({ id: kind + '-init', type: 'inline', data: Buffer.from(inits[kind]).toString('base64') })),
      tracks: [...tracks, { name: 'timeline', packaging: 'mediatimeline', isLive: options.timelineLive ?? true, mimeType: 'application/json', depends: ['old-video', 'new-video', 'audio'] }] })));
    await acceptSub('old-video', 200n); await acceptSub('audio', 201n); await acceptSub('timeline', 300n);
    await publish('timeline', 300n, 0n, 0n, enc.encode(JSON.stringify(options.timelineEntries ?? timeline)));
    await publish('old-video', 200n, 900n, 0n, payload('old-video', 900n, 0n, 3600000n));
    await publish('audio', 201n, 900n, 0n, payload('audio', 900n, 0n, 3600000n, 1250));
    const target0 = payload('new-video', 4n, 0n, 6000n), target1 = payload('new-video', 4n, 1n, 8000n);
    expect(new LocmafTrackDecoder(inits.video).push(4n, 1n, target1).kind).toBe('rejected');
    const targetDecoder = new LocmafTrackDecoder(inits.video);
    for (const [id, bytes, pts] of [[0n, target0, 6000n], [1n, target1, 8000n]] as const) {
      const decoded = targetDecoder.push(4n, id, bytes);
      if (decoded.kind !== 'chunk') throw new Error('Target fixture did not decode with its retained reference');
      const sample = readCmafObjectSamples(decoded.bytes, parseLocmafTrackContext(inits.video))![0]!;
      expect(sample.effective.baseMediaDecodeTime).toBe(pts);
      expect(isSyncSampleFlags(sample.effective.flags[0]!)).toBe(id === 0n);
    }
    expect(source.initialize).toHaveBeenCalledOnce(); expect(player.seekable).toBe(true); player.play(); expect(errors).toEqual([]);
    return { player, client, server, source, subscriptions, fetches, appends, resources, seeked, switched, errors, leases, trace, fetchCancel, unsubscribe,
      payload, publish, acceptSub, request, open, send, close, completeNative, coverage, terminal,
      repeatNativeTerminal(index: number) {
        const row = appends[index]; if (!row?.completed || row.discarded || !row.token) throw new Error('Expected a completed native append');
        for (const observer of [...observers]) observer({ token: row.token, state: 'appended', reason: null });
      },
      publishNativeRange(kind: Role) {
        const pending = appends.find(row => row.owner === resource?.resource && row.role === kind && !row.completed && !row.queued && !row.discarded);
        if (!pending) throw new Error('No pending native operation to publish before its terminal');
        pending.buffered = true;
      },
      async landHistory() {
        await player.seek(5000); await flush(512);
        const video = request('old-video', 3n, 0n), audio = request('audio', 3n, 0n);
        await open(video, { group: 4n, object: 0n }); await open(audio, { group: 4n, object: 0n });
        await send(video, 3n, 0n, 4000n);
        for (let i = 0; i < 4; i++) await send(audio, 3n, BigInt(i), 4000n + BigInt(i * 500), 500);
        await completeNative();
        expect(coverage('video')).toEqual({ start: 4, end: 6 }); expect(coverage('audio')).toEqual({ start: 4, end: 6 });
        if (!resource || !positionResolve) throw new Error('Actual native positioning was not requested');
        now = 5.125; sample = { epoch: resource.epoch, resource: resource.resource, currentTime: now, buffered: commonCoverage() }; positionResolve(sample);
        await flush(512); expect(player.playbackPositionMs).toBe(5125); expect(seeked).toHaveBeenCalledOnce();
        return { video, audio, resource };
      },
      advance(time: number) { now = time; player.tick(); },
      setNativePlayback(paused: boolean | undefined, rate: number | undefined) { nativePaused = paused; nativeRate = rate; },
      setNativeClock(clock: () => number) { nativeClock = clock; },
      async holdLateVideo(request: Fetch) {
        const stream = fetchStreams.get(request.id)!; stream.pipe.faults.hold = true;
        await send(request, 4n, 0n, 6000n);
        return () => { stream.pipe.releaseHeld(); };
      }, destroy };
  } catch (error) { await destroy(); throw error; }
}

describe.each([18, 22] as const)('public historical quality draft %i', draft => {
  it('cancels pending authorization and refuses its late request ID without disrupting the session', async () => {
    let release!: () => void, called = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(draft, { authorization: { getTokens: async context => {
      if (context.operation === 'FETCH' && context.trackName && dec.decode(context.trackName) === 'new-video') {
        called = true; await held;
      }
      return [catToken(Uint8Array.of(1))];
    } } });
    try {
      const history = await f.landHistory(), selecting = f.player.selectVideoTrack(ref('new-video'));
      void selecting.catch(() => {}); await flush(512); expect(called).toBe(true);
      await f.player.selectVideoTrack(ref('old-video'));
      await expect(selecting).rejects.toThrow(/superseded/i);
      release(); await flush(512);
      expect(f.fetches.filter(request => request.name === 'new-video')).toEqual([]);
      await f.send(history.video, 4n, 0n, 6000n); await f.send(history.audio, 4n, 0n, 6000n); await f.completeNative();
      await f.close(history.video); await flush(512);
      expect(f.request('old-video', 4n, 1n)).toBeDefined();
      expect(f.switched).not.toHaveBeenCalled(); expect(f.errors).toEqual([]); expect(f.resources).toHaveLength(1);
      expect(f.fetchCancel.mock.calls.some(([id]) => id === history.audio.id || id === history.video.id)).toBe(false);
    } finally { release(); await f.destroy(); }
  });

  it('abandons preparation when the playable coast expires during an unsettled native operation', async () => {
    const f = await fixture(draft, { timelineEntries: [
      [4000, [3, 0], 0], [6000, [4, 0], 0], [8000, [5, 0], 0], [10000, [6, 0], 0], [3600000, [900, 0], 0],
    ] });
    try {
      const history = await f.landHistory();
      await f.send(history.audio, 4n, 0n, 6000n); await f.completeNative('audio');
      await f.send(history.video, 4n, 0n, 6000n);
      f.publishNativeRange('video'); f.advance(6.125);
      await f.player.selectVideoTrack(ref('new-video')); await flush(512);
      const target = f.request('new-video', 5n, 0n);
      await f.open(target, { group: 5n, object: 0n }); await f.send(target, 5n, 0n, 8000n);
      expect(f.switched).not.toHaveBeenCalled(); expect(f.leases).toEqual([]);
      expect(f.appends.filter(row => row.owner === history.resource.resource && row.name === 'new-video')).toEqual([]);
      f.advance(8); await f.completeNative('video'); await flush(512);
      expect(f.player.selection.video?.name).toBe('old-video'); expect(f.switched).not.toHaveBeenCalled();
      expect(new Set(f.fetchCancel.mock.calls.map(([id]) => id))).toEqual(new Set([target.id]));
      expect(f.leases).toEqual([]); expect(f.resources).toHaveLength(1); expect(f.seeked).toHaveBeenCalledOnce();
      await f.close(history.video); expect(f.request('old-video', 4n, 1n)).toBeDefined();
      expect(f.errors).toHaveLength(1); expect(f.errors[0]).toMatch(/coast/);
    } finally { await f.destroy(); }
  });

  it('rejects asynchronous target authorization without retiring either current media role', async () => {
    let release!: () => void, called = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(draft, { authorization: { getTokens: async context => {
      if (context.operation === 'FETCH' && context.trackName && dec.decode(context.trackName) === 'new-video') {
        called = true; await held; throw new Error('target credential refused');
      }
      return [catToken(Uint8Array.of(1))];
    } } });
    try {
      const history = await f.landHistory();
      const selecting = f.player.selectVideoTrack(ref('new-video'));
      void selecting.catch(() => {}); await flush(512);
      expect(called).toBe(true); expect(f.fetches.filter(request => request.name === 'new-video')).toEqual([]);
      release(); await expect(selecting).rejects.toMatchObject({ name: 'AuthorizationError' }); await flush(512);
      expect(f.switched).not.toHaveBeenCalled(); expect(f.fetchCancel).not.toHaveBeenCalled();
      await f.send(history.video, 4n, 0n, 6000n); await f.send(history.audio, 4n, 0n, 6000n); await f.completeNative();
      expect(f.appends.filter(row => row.completed && row.owner === history.resource.resource && row.start === 6).map(row => row.name).sort())
        .toEqual(['audio', 'old-video']);
      f.advance(5.375); expect(f.player.playbackPositionMs).toBe(5375);
      expect(f.player.selection.video?.name).toBe('old-video'); expect(f.player.selection.audio?.name).toBe('audio');
      expect(f.resources).toHaveLength(1); expect(f.leases).toEqual([]); expect(f.seeked).toHaveBeenCalledOnce();
      expect(f.errors).toHaveLength(1); expect(f.errors[0]).toMatch(/credential|auth/i);
    } finally { release(); await f.destroy(); }
  });

  it('honors a newer current-track choice from beforeSubscribe without issuing a stale target request', async () => {
    const f = await fixture(draft);
    try {
      const history = await f.landHistory(); let entered = false, inner: Promise<void> | undefined;
      f.player.hooks.beforeSubscribe.add(intent => {
        if (!entered && intent.trackName === 'new-video') {
          entered = true; inner = f.player.selectVideoTrack(ref('old-video')); void inner.catch(() => {});
        }
        return intent;
      });
      await f.player.selectVideoTrack(ref('new-video')); await inner; await flush(512);
      expect(entered).toBe(true); expect(f.fetches.filter(request => request.name === 'new-video')).toEqual([]);
      await f.send(history.video, 4n, 0n, 6000n); await f.send(history.audio, 4n, 0n, 6000n); await f.completeNative();
      expect(f.player.selection.video?.name).toBe('old-video'); expect(f.player.selection.audio?.name).toBe('audio');
      expect(f.switched).not.toHaveBeenCalled(); expect(f.fetchCancel).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
      expect(f.resources).toHaveLength(1); expect(f.leases).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('declines a parsed target whose boundary passed while its media was in flight', async () => {
    const f = await fixture(draft);
    try {
      const history = await f.landHistory();
      await f.player.selectVideoTrack(ref('new-video')); await flush(512);
      const target = f.request('new-video', 4n, 0n);
      await f.send(history.video, 4n, 0n, 6000n); await f.send(history.audio, 4n, 0n, 6000n); await f.completeNative();
      await f.open(target, { group: 4n, object: 0n });
      const releaseTarget = await f.holdLateVideo(target);
      f.advance(6.125); releaseTarget(); await flush(512); await f.completeNative();
      expect(f.player.selection.video?.name).toBe('old-video'); expect(f.switched).not.toHaveBeenCalled();
      expect(f.appends.filter(row => row.owner === history.resource.resource && row.name === 'new-video')).toEqual([]);
      expect(new Set(f.fetchCancel.mock.calls.map(([id]) => id))).toEqual(new Set([target.id]));
      expect(f.leases).toEqual([]); expect(f.resources).toHaveLength(1); expect(f.seeked).toHaveBeenCalledOnce();
      f.advance(6.375); expect(f.player.playbackPositionMs).toBe(6375);
      expect(f.errors).toHaveLength(1); expect(f.errors[0]).toMatch(/coast/);
    } finally { await f.destroy(); }
  });

  it('prepares indexed target video while old audio continues, then retains decoder and native output', async () => {
    const f = await fixture(draft);
    try {
      let oldRaw: Promise<void> | undefined;
      const begin = MseSeekPlayback.prototype.beginPage;
      vi.spyOn(MseSeekPlayback.prototype, 'beginPage').mockImplementation(function(this: MseSeekPlayback, kind, identity) {
        const receiver = begin.call(this, kind, identity);
        return { onObject(object, input) {
          const work = receiver.onObject(object, input);
          if (kind === 'video' && object.groupId === 4n) { oldRaw = work; void work.catch(() => {}); }
          return work;
        }, onClosed: receiver.onClosed };
      });
      const history = await f.landHistory(), native = history.resource;
      expect(native.sample()?.buffered).toEqual({ start: 4, end: 6 });
      const before = { resources: f.resources.length, sourceInit: vi.mocked(f.source.initialize).mock.calls.length,
        init: vi.mocked(native.initialize).mock.calls.length, position: vi.mocked(native.position).mock.calls.length,
        seeked: f.seeked.mock.calls.length, cancels: f.fetchCancel.mock.calls.length };
      const status: { emitted: boolean; error?: unknown } = { emitted: false };
      const selecting = f.player.selectVideoTrack(ref('new-video')).then(() => { status.emitted = true; }, error => { status.error = error; });
      await flush(512);
      expect(status.error, 'historical selection must admit the current adopted video instead of requiring an ordinary subscription').toBeUndefined();
      const first = f.request('new-video', 4n, 0n);
      expect(first.namespace).toEqual(namespace); expect(first.order).toBe(1n); expect(first.end.group).toBeLessThan(900n);
      await selecting; expect(status.emitted).toBe(true); expect(f.player.selection.video?.name).toBe('old-video');
      const audioBefore = f.appends.filter(row => row.owner === native.resource && row.role === 'audio').length;
      await f.send(history.audio, 4n, 0n, 6000n); await f.completeNative();
      expect(f.appends.filter(row => row.owner === native.resource && row.role === 'audio')).toHaveLength(audioBefore + 1);
      expect(f.fetchCancel.mock.calls.slice(before.cancels)).toEqual([]);
      await f.send(history.video, 4n, 0n, 6000n); expect(oldRaw).toBeDefined();
      await f.open(first, { group: 4n, object: 0n }); await f.send(first, 4n, 0n, 6000n);
      expect(f.player.selection.video?.name).toBe('old-video'); expect(f.switched).not.toHaveBeenCalled();
      await f.close(first);
      const second = f.request('new-video', 4n, 1n), delta = f.payload('new-video', 4n, 1n, 8000n);
      expect(new LocmafTrackDecoder(inits.video).push(4n, 1n, delta).kind).toBe('rejected');
      await f.open(second, { group: 5n, object: 0n }); await f.send(second, 4n, 1n, 8000n);
      expect(f.player.selection.video?.name).toBe('old-video');
      await f.send(second, 5n, 0n, 10000n); await f.completeNative();
      expect(f.player.selection.video?.name).toBe('new-video'); expect(f.switched).toHaveBeenCalledOnce();
      expect(f.appends).toContainEqual(expect.objectContaining({ owner: native.resource, name: 'new-video', key: identityKey(namespace, 'new-video'), marker: 22, start: 6, end: 8, completed: true }));
      expect(f.appends.find(row => row.owner === native.resource && row.name === 'new-video')?.key).not.toBe(f.appends.find(row => row.owner === native.resource && row.name === 'old-video')?.key);
      const oldVideoCount = f.appends.filter(row => row.owner === native.resource && row.name === 'old-video').length;
      await expect(oldRaw!).rejects.toMatchObject({ name: 'AbortError' }); await flush(512);
      expect(f.appends.filter(row => row.owner === native.resource && row.name === 'old-video')).toHaveLength(oldVideoCount);
      expect(new Set(f.fetchCancel.mock.calls.slice(before.cancels).map(([id]) => id))).toEqual(new Set([history.video.id]));
      expect(f.leases).toContainEqual({ roles: ['video'], outcome: 'discard' });
      expect(f.appends).toContainEqual(expect.objectContaining({ owner: native.resource, name: 'new-video', key: identityKey(namespace, 'new-video'), marker: 22, start: 8, end: 10, completed: true }));
      await f.close(second);
      expect(f.fetches.some(request => request.name === 'new-video' && request.start.group === 5n && request.start.object === 1n)).toBe(false);
      // Native append completed, but ordinary post-promotion read credit still
      // waits for the actual head to be within five seconds of its end.
      f.advance(7.125); await flush(512);
      const third = f.request('new-video', 5n, 1n), laterDelta = f.payload('new-video', 5n, 1n, 12000n);
      expect(new LocmafTrackDecoder(inits.video).push(5n, 1n, laterDelta).kind).toBe('rejected');
      await f.open(third, { group: 5n, object: 1n }); await f.send(third, 5n, 1n, 12000n); await f.completeNative();
      expect(f.appends).toContainEqual(expect.objectContaining({ owner: native.resource, name: 'new-video', marker: 22, start: 12, end: 14, completed: true }));
      await f.close(history.audio);
      const nextAudio = f.request('audio', 4n, 1n), audioDelta = f.payload('audio', 4n, 1n, 8000n);
      expect(new LocmafTrackDecoder(inits.audio).push(4n, 1n, audioDelta).kind).toBe('rejected');
      await f.open(nextAudio, { group: 4n, object: 1n });
      await f.send(nextAudio, 4n, 1n, 8000n); await f.completeNative(); f.advance(7.375);
      expect(f.player.playbackPositionMs).toBe(7375); expect(f.player.selection.audio?.name).toBe('audio');
      expect(f.fetchCancel.mock.calls.some(([id]) => id === history.audio.id)).toBe(false);
      expect(f.resources).toHaveLength(before.resources); expect(f.source.initialize).toHaveBeenCalledTimes(before.sourceInit);
      expect(native.initialize).toHaveBeenCalledTimes(before.init); expect(native.position).toHaveBeenCalledTimes(before.position);
      expect(f.seeked).toHaveBeenCalledTimes(before.seeked); expect(native.cancel).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('ordinary quality switching still preserves its established audio subscription', async () => {
    const f = await fixture(draft);
    try {
      await f.player.selectVideoTrack(ref('new-video')); await flush(512); await f.acceptSub('new-video', 202n);
      await f.publish('new-video', 202n, 901n, 0n, f.payload('new-video', 901n, 0n, 3602000n));
      expect(f.player.selection.video?.name).toBe('new-video'); expect(f.switched).toHaveBeenCalledOnce();
      const before = f.appends.length; await f.publish('audio', 201n, 900n, 1n, f.payload('audio', 900n, 1n, 3601250n, 250));
      expect(f.appends.slice(before)).toEqual([expect.objectContaining({ role: 'audio', marker: 33, completed: true })]);
      expect(f.resources).toEqual([]); expect(f.fetches).toEqual([]); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('historical audio advances on its original request and decoder without selecting another video', async () => {
    const f = await fixture(draft);
    try {
      const history = await f.landHistory(), before = f.appends.length;
      await f.send(history.audio, 4n, 0n, 6000n); await f.completeNative();
      await f.close(history.audio);
      const next = f.request('audio', 4n, 1n), data = f.payload('audio', 4n, 1n, 8000n);
      expect(new LocmafTrackDecoder(inits.audio).push(4n, 1n, data).kind).toBe('rejected');
      await f.open(next, { group: 4n, object: 1n }); await f.send(next, 4n, 1n, 8000n); await f.completeNative(); f.advance(5.25);
      expect(f.appends.slice(before)).toEqual([
        expect.objectContaining({ role: 'audio', name: 'audio', marker: 33, completed: true, start: 6, end: 8, owner: history.resource.resource }),
        expect.objectContaining({ role: 'audio', name: 'audio', marker: 33, completed: true, start: 8, end: 10, owner: history.resource.resource }),
      ]);
      expect(f.player.playbackPositionMs).toBe(5250); expect(f.player.selection.video?.name).toBe('old-video');
      expect(f.fetchCancel).not.toHaveBeenCalled(); expect(f.resources).toHaveLength(1); expect(f.seeked).toHaveBeenCalledOnce(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});


describe.each([18,22] as const)('historical queue acquisition authority draft %i', draft => {
  it.each([false,true])('releases an acquired native queue when cancellation reenters before return: %s',async reenter=>{
    const f=await fixture(draft);
    try{
      const history=await f.landHistory();
      const original=f.source.holdQueuedAppends;
      if(!original)throw new Error('Required native queue lease');
      let inner:Promise<void>|undefined,entered=false;
      f.source.holdQueuedAppends=kinds=>{
        const lease=original(kinds);
        if(reenter&&!entered){entered=true;inner=f.player.selectVideoTrack(ref('old-video'));void inner.catch(()=>{});}
        return lease;
      };
      await f.player.selectVideoTrack(ref('new-video'));await flush(512);
      const target=f.request('new-video',4n,0n);
      await f.send(history.video,4n,0n,6000n);
      await f.open(target,{group:5n,object:0n});await f.send(target,4n,0n,6000n);
      await f.send(target,4n,1n,8000n);await f.send(target,5n,0n,10000n);await f.completeNative();
      await inner;await flush(512);
      expect(entered).toBe(reenter);
      if(reenter){
        expect(f.player.selection.video?.name).toBe('old-video');expect(f.switched).not.toHaveBeenCalled();
        expect.soft(f.leases,'canceled acquisition must resume its returned native queue').toEqual([{roles:['video'],outcome:'resume'}]);
        await f.send(history.audio,4n,0n,6000n);await f.completeNative();
        expect(f.appends.filter(row=>row.owner===history.resource.resource&&row.name==='old-video'&&row.start===6))
          .toEqual([expect.objectContaining({completed:true,queued:false,discarded:false})]);
        expect(f.resources).toHaveLength(1);expect(history.resource.cancel).not.toHaveBeenCalled();
      }else{
        expect(f.player.selection.video?.name).toBe('new-video');expect(f.switched).toHaveBeenCalledOnce();
        expect(f.leases).toEqual([{roles:['video'],outcome:'discard'}]);
        expect(f.appends).toContainEqual(expect.objectContaining({name:'new-video',start:6,completed:true}));
      }
      expect(f.errors).toEqual([]);
    }finally{await f.destroy();}
  });
});


describe.each([18, 22] as const)('historical actor hold acquisition authority draft %i', draft => {
  it.each([false, true])('releases an actor hold returned after cancellation: %s', async reenter => {
    const f = await fixture(draft);
    try {
      const history = await f.landHistory();
      const descriptor = Object.getOwnPropertyDescriptor(history.resource, 'current');
      if (!descriptor?.get) throw new Error('Required actual native current accessor');
      const original = MseSeekPlayback.prototype.holdRole;
      let insideHold = false, entered = false, inner: Promise<void> | undefined;
      vi.spyOn(MseSeekPlayback.prototype, 'holdRole').mockImplementation(function (this: MseSeekPlayback, ...args) {
        insideHold = true;
        try { return original.apply(this, args); } finally { insideHold = false; }
      });
      Object.defineProperty(history.resource, 'current', { ...descriptor, get() {
        if (insideHold && reenter && !entered) {
          entered = true;
          inner = f.player.selectVideoTrack(ref('old-video'));
          void inner.catch(() => {});
        }
        return descriptor.get!.call(history.resource);
      } });
      const selecting = f.player.selectVideoTrack(ref('new-video'));
      if (reenter) await expect(selecting).rejects.toThrow(/superseded/);
      else {
        await selecting; await flush(512);
        const target = f.request('new-video', 4n, 0n);
        await f.send(history.video, 4n, 0n, 6000n);
        await f.open(target, { group: 5n, object: 0n }); await f.send(target, 4n, 0n, 6000n);
        await f.send(target, 4n, 1n, 8000n); await f.send(target, 5n, 0n, 10000n); await f.completeNative();
      }
      await inner; await flush(512);
      expect(entered).toBe(reenter);
      if (reenter) {
        expect(f.player.selection.video?.name).toBe('old-video'); expect(f.switched).not.toHaveBeenCalled();
        expect(f.leases).toEqual([]);
        await f.send(history.video, 4n, 0n, 6000n); await f.send(history.audio, 4n, 0n, 6000n); await f.completeNative();
        expect(f.appends.filter(row => row.owner === history.resource.resource && row.name === 'old-video' && row.start === 6))
          .toEqual([expect.objectContaining({ completed: true, queued: false, discarded: false })]);
        expect(f.resources).toHaveLength(1); expect(history.resource.cancel).not.toHaveBeenCalled();
      } else {
        expect(f.player.selection.video?.name).toBe('new-video'); expect(f.switched).toHaveBeenCalledOnce();
        expect(f.leases).toEqual([{ roles: ['video'], outcome: 'discard' }]);
        expect(f.appends).toContainEqual(expect.objectContaining({ name: 'new-video', start: 6, completed: true }));
      }
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});

describe.each([18, 22] as const)('actual historical reader credit draft %i', draft => {
  it('keeps physical FIN behind completed native lookahead credit until the head advances', async () => {
    const f = await fixture(draft);
    try {
      const closed: Role[] = [];
      const original = MseSeekPlayback.prototype.beginPage;
      vi.spyOn(MseSeekPlayback.prototype, 'beginPage').mockImplementation(function (this: MseSeekPlayback, kind, id) {
        const receiver = original.call(this, kind, id);
        return { onObject: receiver.onObject, onClosed(terminal) {
          closed.push(kind);
          return receiver.onClosed(terminal);
        } };
      });
      const history = await f.landHistory();
      await f.send(history.video, 4n, 0n, 6000n); await f.send(history.audio, 4n, 0n, 6000n); await f.completeNative();
      await f.close(history.video); await f.close(history.audio);
      const video = f.request('old-video', 4n, 1n), audio = f.request('audio', 4n, 1n);
      await f.open(video, { group: 4n, object: 2n }); await f.open(audio, { group: 4n, object: 1n });
      await f.send(video, 4n, 1n, 8000n); await f.completeNative();
      await f.send(video, 4n, 2n, 10000n); await f.send(audio, 4n, 1n, 8000n, 4000); await f.completeNative();
      expect(f.coverage('video')).toEqual({ start: 4, end: 12 }); expect(f.coverage('audio')).toEqual({ start: 4, end: 12 });
      const closedBefore = closed.filter(kind => kind === 'video').length;
      const fetchesBefore = f.fetches.filter(row => row.name === 'old-video').length;
      await f.close(video); await flush(512);
      expect(closed.filter(kind => kind === 'video')).toHaveLength(closedBefore);
      expect(f.fetches.filter(row => row.name === 'old-video')).toHaveLength(fetchesBefore);
      expect(f.appends.filter(row => row.owner === history.resource.resource && row.name === 'old-video' && row.start === 10))
        .toEqual([expect.objectContaining({ completed: true, queued: false })]);
      f.advance(8); await flush(512);
      expect(closed.filter(kind => kind === 'video')).toHaveLength(closedBefore + 1);
      expect(f.fetches.filter(row => row.name === 'old-video')).toHaveLength(fetchesBefore + 1);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});


describe.each([18, 22] as const)('unsubmitted historical cut during target preparation draft %i', draft => {
  it('keeps old G outside the parser and native output while target authorization is pending', async () => {
    let release!: () => void, called = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(draft, { authorization: { getTokens: async context => {
      if (context.operation === 'FETCH' && context.trackName && dec.decode(context.trackName) === 'new-video') { called = true; await held; }
      return [catToken(Uint8Array.of(1))];
    } } });
    const decode = vi.spyOn(LocmafTrackDecoder.prototype, 'push');
    try {
      const history = await f.landHistory(), initial = f.appends.filter(row => row.name === 'old-video' && row.owner === history.resource.resource).length;
      const selecting = f.player.selectVideoTrack(ref('new-video')); void selecting.catch(() => {}); await flush(512);
      expect(called).toBe(true); expect(f.fetches.filter(request => request.name === 'new-video')).toEqual([]);
      const before = decode.mock.calls.filter(([group]) => group === 4n).length;
      await f.send(history.video, 4n, 0n, 6000n);
      expect(f.appends.filter(row => row.name === 'old-video' && row.owner === history.resource.resource),
        'old G must not enter native output before the candidate is admitted').toHaveLength(initial);
      expect(decode.mock.calls.filter(([group]) => group === 4n)).toHaveLength(before);
      await f.player.selectVideoTrack(ref('old-video')); await expect(selecting).rejects.toThrow(/superseded/i);
      await f.completeNative('video');
      expect(f.appends.filter(row => row.name === 'old-video' && row.owner === history.resource.resource)).toHaveLength(initial + 1);
      expect(decode.mock.calls.filter(([group]) => group === 4n)).toHaveLength(before + 1);
      expect(f.player.selection.video?.name).toBe('old-video'); expect(f.resources).toHaveLength(1);
      expect(f.fetchCancel.mock.calls.some(([id]) => id === history.video.id || id === history.audio.id)).toBe(false);
      expect(f.errors).toEqual([]);
    } finally { release(); decode.mockRestore(); await f.destroy(); }
  });

  it.each([[1, 800], [2, 400]] as const)('refuses held preparation before native coast expires at rate %s', async (rate, elapsedMs) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    let wallUs = 0, release!: () => void, called = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      f = await fixture(draft, { clock: { now: () => wallUs }, authorization: { getTokens: async context => {
        if (context.operation === 'FETCH' && context.trackName && dec.decode(context.trackName) === 'new-video') { called = true; await held; }
        return [catToken(Uint8Array.of(1))];
      } } });
      const history = await f.landHistory(); f.setNativePlayback(false, rate);
      const nativeOrigin = performance.now(); f.setNativeClock(() => 5.125 + (performance.now() - nativeOrigin) / 1000 * rate);
      const rejected = vi.fn(), selecting = f.player.selectVideoTrack(ref('new-video')); void selecting.catch(rejected); await flush(512);
      expect(called).toBe(true); await f.send(history.video, 4n, 0n, 6000n);
      wallUs += elapsedMs * 1000; await vi.advanceTimersByTimeAsync(elapsedMs); await flush(512);
      expect(rejected, 'preparation must expire before the observed old buffer coast, not the generic switch deadline').toHaveBeenCalledOnce();
      await expect(selecting).rejects.toThrow(/coast|buffer|deadline/i);
      expect(f.switched).not.toHaveBeenCalled(); expect(f.player.selection.video?.name).toBe('old-video');
      await f.completeNative('video');
      expect(f.appends.filter(row => row.owner === history.resource.resource && row.name === 'old-video' && row.start === 6)).toHaveLength(1);
      release(); await flush(512); expect(f.fetches.filter(request => request.name === 'new-video')).toEqual([]);
      expect(f.resources).toHaveLength(1); expect(f.seeked).toHaveBeenCalledOnce();
      expect(f.fetchCancel.mock.calls.some(([id]) => id === history.video.id || id === history.audio.id)).toBe(false);
    } finally { release?.(); await f?.destroy(); vi.useRealTimers(); }
  });
});


describe.each([18, 22] as const)('native coast observation controls draft %i', draft => {
  it.each([[true, 1], [false, 0]] as const)('does not infer head progress from pause=%s rate=%s', async (paused, rate) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      f = await fixture(draft, { authorization: { getTokens: async context => {
        if (context.operation === 'FETCH' && context.trackName && dec.decode(context.trackName) === 'new-video') await waiting;
        return [catToken(Uint8Array.of(1))];
      } } });
      const history = await f.landHistory(); f.setNativePlayback(paused, rate);
      const rejected = vi.fn(), selecting = f.player.selectVideoTrack(ref('new-video')); void selecting.catch(rejected); await flush(512);
      await f.send(history.video, 4n, 0n, 6000n);
      await vi.advanceTimersByTimeAsync(1500); await flush(512);
      expect(history.resource.sample()?.currentTime).toBe(5.125);
      expect(rejected, 'the observed native head is stationary, not an elapsed-time projection').not.toHaveBeenCalled();
      expect(f.appends.filter(row => row.owner === history.resource.resource && row.name === 'old-video')).toHaveLength(1);
      await f.player.selectVideoTrack(ref('old-video')); await expect(selecting).rejects.toThrow(/superseded/); await f.completeNative('video');
      expect(f.appends.filter(row => row.owner === history.resource.resource && row.name === 'old-video' && row.start === 6)).toHaveLength(1);
      expect(f.resources).toHaveLength(1); expect(f.errors).toEqual([]);
    } finally { release?.(); await f?.destroy(); vi.useRealTimers(); }
  });

  it.each([undefined, -1])('refuses a forward switch without usable native rate %s and leaves old input active', async rate => {
    const f = await fixture(draft);
    try {
      const history = await f.landHistory(); f.setNativePlayback(false, rate);
      await expect(f.player.selectVideoTrack(ref('new-video'))).rejects.toThrow(rate === undefined ? /rate is unavailable/ : /forward playback/);
      expect(f.fetches.filter(request => request.name === 'new-video')).toEqual([]);
      await f.send(history.video, 4n, 0n, 6000n); await f.completeNative('video');
      expect(f.appends.filter(row => row.owner === history.resource.resource && row.name === 'old-video' && row.start === 6)).toHaveLength(1);
      expect(f.fetchCancel).not.toHaveBeenCalled(); expect(f.player.selection.audio?.name).toBe('audio');
      expect(f.switched).not.toHaveBeenCalled(); expect(f.resources).toHaveLength(1);
    } finally { await f.destroy(); }
  });

  it('re-evaluates a paused preparation after native playback resumes at a faster rate', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      f = await fixture(draft, { authorization: { getTokens: async context => {
        if (context.operation === 'FETCH' && context.trackName && dec.decode(context.trackName) === 'new-video') await waiting;
        return [catToken(Uint8Array.of(1))];
      } } });
      const history = await f.landHistory(); f.setNativePlayback(true, 1);
      const rejected = vi.fn(), selecting = f.player.selectVideoTrack(ref('new-video')); void selecting.catch(rejected); await flush(512);
      await f.send(history.video, 4n, 0n, 6000n); await vi.advanceTimersByTimeAsync(1000); expect(rejected).not.toHaveBeenCalled();
      const nativeOrigin = performance.now(); f.setNativePlayback(false, 2); f.setNativeClock(() => 5.125 + (performance.now() - nativeOrigin) / 1000 * 2);
      await vi.advanceTimersByTimeAsync(400); await flush(512);
      expect(rejected).toHaveBeenCalledOnce(); await expect(selecting).rejects.toThrow(/coast|deadline/i);
      await f.completeNative('video'); expect(f.player.selection.video?.name).toBe('old-video'); expect(f.resources).toHaveLength(1);
    } finally { release?.(); await f?.destroy(); vi.useRealTimers(); }
  });

  it('does not renew the original preparation deadline while the native clock is paused', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      f = await fixture(draft, { authorization: { getTokens: async context => {
        if (context.operation === 'FETCH' && context.trackName && dec.decode(context.trackName) === 'new-video') await waiting;
        return [catToken(Uint8Array.of(1))];
      } } });
      const history = await f.landHistory(); f.setNativePlayback(true, 1);
      const rejected = vi.fn(), selecting = f.player.selectVideoTrack(ref('new-video')); void selecting.catch(rejected); await flush(512);
      await f.send(history.video, 4n, 0n, 6000n); await vi.advanceTimersByTimeAsync(10010); await flush(512);
      expect(rejected).toHaveBeenCalledOnce(); await expect(selecting).rejects.toThrow(/deadline/i);
      await f.completeNative('video'); expect(f.player.selection.video?.name).toBe('old-video'); expect(f.resources).toHaveLength(1);
    } finally { release?.(); await f?.destroy(); vi.useRealTimers(); }
  });
});


describe.each([18, 22] as const)('historical coast timeout without periodic observations draft %i', draft => {
  it('releases its old raw boundary at the armed native coast even while tick is suspended', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      f = await fixture(draft, { authorization: { getTokens: async context => {
        if (context.operation === 'FETCH' && context.trackName && dec.decode(context.trackName) === 'new-video') await waiting;
        return [catToken(Uint8Array.of(1))];
      } } });
      const history = await f.landHistory(), nativeOrigin = performance.now();
      f.setNativePlayback(false, 2); f.setNativeClock(() => 5.125 + (performance.now() - nativeOrigin) / 1000 * 2);
      const rejected = vi.fn(), selecting = f.player.selectVideoTrack(ref('new-video')); void selecting.catch(rejected); await flush(512);
      await f.send(history.video, 4n, 0n, 6000n);
      const ticks = vi.spyOn(f.player, 'tick').mockImplementation(() => {});
      await vi.advanceTimersByTimeAsync(400); await flush(512);
      expect(ticks).toHaveBeenCalled(); expect(rejected).toHaveBeenCalledOnce();
      await expect(selecting).rejects.toThrow(/deadline/i);
      await f.completeNative('video');
      expect(f.appends.filter(row => row.owner === history.resource.resource && row.name === 'old-video' && row.start === 6)).toHaveLength(1);
      expect(f.fetchCancel.mock.calls.some(([id]) => id === history.video.id || id === history.audio.id)).toBe(false);
      expect(f.resources).toHaveLength(1); expect(f.player.selection.video?.name).toBe('old-video');
    } finally { release?.(); await f?.destroy(); vi.useRealTimers(); }
  });
});


describe.each([18, 22] as const)('consumed historical cut admission draft %i', draft => {
  it('refuses a real cut consumed before its return without asking for target credentials or issuing a request', async () => {
    const credentials = vi.fn(async () => [catToken(Uint8Array.of(1))]);
    const f = await fixture(draft, { authorization: { getTokens: credentials } });
    try {
      const history = await f.landHistory(); credentials.mockClear();
      const original = MseSeekPlayback.prototype.holdRole;
      const holds = vi.spyOn(MseSeekPlayback.prototype, 'holdRole').mockImplementation(function(this: MseSeekPlayback, ...args) {
        const cut = original.apply(this, args); cut.resume(); return cut;
      });
      const refusal = await f.player.selectVideoTrack(ref('new-video')).then(() => null, (error: unknown) => error);
      expect(holds).toHaveBeenCalledOnce();
      expect(credentials, 'a known inactive cut cannot authorize new target work').not.toHaveBeenCalled();
      expect(refusal).toMatchObject({ message: expect.stringMatching(/cut is unavailable/) });
      expect(f.fetches.filter(request => request.name === 'new-video')).toEqual([]);
      await f.send(history.video, 4n, 0n, 6000n); await f.completeNative('video');
      expect(f.appends.filter(row => row.owner === history.resource.resource && row.name === 'old-video' && row.start === 6)).toHaveLength(1);
      expect(f.resources).toHaveLength(1); expect(f.fetchCancel).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });
});


describe.each([18,22] as const)('coast observation failure containment draft %i', draft=>{
  it.each(['null','throw'] as const)('refuses unavailable preparation without throwing through tick: %s',async kind=>{
    let release!:()=>void,called=false;
    const held=new Promise<void>(resolve=>{release=resolve;});
    const f=await fixture(draft,{authorization:{getTokens:async context=>{
      if(context.operation==='FETCH'&&context.trackName&&dec.decode(context.trackName)==='new-video'){called=true;await held;}
      return [catToken(Uint8Array.of(1))];
    }}});
    try{
      const history=await f.landHistory();f.setNativePlayback(true,1);
      const rejected=vi.fn(),selecting=f.player.selectVideoTrack(ref('new-video'));void selecting.catch(rejected);
      await flush(512);expect(called).toBe(true);expect(f.fetches.filter(r=>r.name==='new-video')).toEqual([]);
      await f.send(history.video,4n,0n,6000n);await flush(512);
      expect(f.appends.filter(r=>r.name==='old-video'&&r.owner===history.resource.resource&&r.start===6)).toEqual([]);
      vi.spyOn(history.resource,'sample').mockImplementationOnce(()=>{
        if(kind==='throw')throw new Error('native sample temporarily unavailable');
        return null;
      });
      expect.soft(()=>f.player.tick(),'native observation failure must remain inside the switch owner').not.toThrow();
      await flush(512);await f.completeNative('video');
      expect.soft(rejected,'an unavailable coast read must refuse its pending target').toHaveBeenCalledOnce();
      expect.soft(f.appends.filter(r=>r.name==='old-video'&&r.owner===history.resource.resource&&r.start===6),
        'refusal must release the old raw boundary to the same decoder/native output')
        .toEqual([expect.objectContaining({completed:true,queued:false,discarded:false})]);
      expect(history.resource.current).toBe(true);expect(f.resources).toHaveLength(1);
      expect(f.player.selection.video?.name).toBe('old-video');expect(f.switched).not.toHaveBeenCalled();
    }finally{release();await f.destroy();}
  });
});


// Whole-group admission is a new integration requirement, not a claim that the
// previously unqualified first-RAP prototype was published behavior.
describe.each([18, 22] as const)('whole-group historical quality preparation draft%i', draft => {
  it('keeps the old owner until the accepted target group is closed', async () => {
    const f = await fixture(draft);
    try {
      const history = await f.landHistory();
      await f.player.selectVideoTrack(ref('new-video')); await flush(512);
      const target = f.request('new-video', 4n, 0n);
      await f.send(history.video, 4n, 0n, 6000n);
      await f.open(target, { group: 4n, object: 0n });
      await f.send(target, 4n, 0n, 6000n); await f.completeNative();
      expect(f.player.selection.video?.name).toBe('old-video'); expect(f.switched).not.toHaveBeenCalled();
      expect(f.appends.filter(row => row.owner === history.resource.resource && row.name === 'new-video')).toEqual([]);
      expect(f.resources).toHaveLength(1); expect(history.resource.cancel).not.toHaveBeenCalled();
      expect(f.fetchCancel.mock.calls.some(([id]) => id === history.video.id)).toBe(false);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('includes the first higher indexed Location and promotes before that request FIN', async () => {
    const f = await fixture(draft);
    try {
      const history = await f.landHistory();
      await f.player.selectVideoTrack(ref('new-video')); await flush(512);
      const target = f.request('new-video', 4n, 0n);
      expect(target.end).toEqual({ group: 5n, object: 1n });
      expect(target.order).toBe(1n);
      await f.send(history.video, 4n, 0n, 6000n);
      await f.open(target, { group: 5n, object: 0n });
      await f.send(target, 4n, 0n, 6000n); await f.send(target, 4n, 1n, 8000n);
      expect(f.player.selection.video?.name).toBe('old-video'); expect(f.switched).not.toHaveBeenCalled();
      await f.send(target, 5n, 0n, 10000n); await f.completeNative('video');
      expect(f.player.selection.video?.name).toBe('new-video'); expect(f.switched).toHaveBeenCalledOnce();
      expect(f.appends.filter(row => row.owner === history.resource.resource && row.name === 'new-video'))
        .toEqual([6, 8, 10].map(start => expect.objectContaining({ start, completed: true, discarded: false })));
      expect(f.player.selection.audio?.name).toBe('audio');
      expect(f.fetchCancel.mock.calls.some(([id]) => id === history.audio.id)).toBe(false);
      expect(f.resources).toHaveLength(1); expect(history.resource.position).toHaveBeenCalledOnce();
      expect(f.seeked).toHaveBeenCalledOnce(); expect(f.leases).toContainEqual({ roles: ['video'], outcome: 'discard' });
      expect(f.errors).toEqual([]);
      await f.close(target);
    } finally { await f.destroy(); }
  });
});


describe.each([18, 22] as const)('promoted group timing ownership draft%i', draft => {
  it.each([false, true])('retires an irreversible floor contradiction while preserving a healthy successor: %s', async contradicts => {
    const f = await fixture(draft);
    try {
      const history = await f.landHistory(), observations: Array<{ state: string; nativeCurrent: boolean }> = [];
      f.player.on('error', () => { observations.push({ state: f.player.state, nativeCurrent: history.resource.current }); });
      await f.player.selectVideoTrack(ref('new-video')); await flush(512);
      const target = f.request('new-video', 4n, 0n);
      await f.send(history.video, 4n, 0n, 6000n);
      await f.open(target, { group: 5n, object: 0n });
      await f.send(target, 4n, 0n, 6000n); await f.send(target, 4n, 1n, 8000n);
      // Higher DATA closes G before its payload is parsed. Its later parse must
      // still obey the adopted floor, on the new owner's failure path.
      await f.send(target, 5n, 0n, contradicts ? 5999n : 10000n); await f.completeNative(); await flush(512);
      expect(f.switched).toHaveBeenCalledOnce();
      expect(f.appends.filter(row => row.owner === history.resource.resource && row.name === 'new-video'))
        .toHaveLength(contradicts ? 2 : 3);
      if (contradicts) {
        expect(f.player.state).toBe('error'); expect(history.resource.current).toBe(false);
        expect(history.resource.cancel).toHaveBeenCalledOnce();
        expect(observations).toEqual([{ state: 'error', nativeCurrent: false }]);
        expect(new Set(f.fetchCancel.mock.calls.map(([id]) => id))).toEqual(new Set([history.video.id, history.audio.id, target.id]));
        expect(f.leases).toEqual([{ roles: ['video'], outcome: 'discard' }]);
        expect(f.errors).toHaveLength(1);
      } else {
        expect(f.player.state).toBe('playing'); expect(history.resource.current).toBe(true);
        expect(history.resource.cancel).not.toHaveBeenCalled(); expect(observations).toEqual([]);
        expect(f.player.selection.audio?.name).toBe('audio'); expect(f.errors).toEqual([]);
      }
      expect(f.resources).toHaveLength(1); expect(f.seeked).toHaveBeenCalledOnce();
    } finally { await f.destroy(); }
  });
});


describe.each([18, 22] as const)('promoted group failure publication draft%i', draft => {
  it.each(['destroy', 'throw'] as const)('retires native ownership before a reentrant error listener: %s', async action => {
    const f = await fixture(draft);
    let destroyed: Promise<void> | undefined;
    try {
      const history = await f.landHistory(), observations: Array<{ state: string; nativeCurrent: boolean }> = [];
      f.player.on('error', () => {
        observations.push({ state: f.player.state, nativeCurrent: history.resource.current });
        if (action === 'destroy') destroyed = f.player.destroy();
        else throw new Error('Application error listener failed');
      });
      await f.player.selectVideoTrack(ref('new-video')); await flush(512);
      const target = f.request('new-video', 4n, 0n);
      await f.send(history.video, 4n, 0n, 6000n);
      await f.open(target, { group: 5n, object: 0n });
      await f.send(target, 4n, 0n, 6000n); await f.send(target, 4n, 1n, 8000n);
      await f.send(target, 5n, 0n, 5999n); await f.completeNative(); await destroyed; await flush(512);
      expect(observations).toEqual([{ state: 'error', nativeCurrent: false }]);
      expect(history.resource.cancel).toHaveBeenCalledOnce(); expect(history.resource.current).toBe(false);
      expect(f.errors).toHaveLength(1); expect(f.resources).toHaveLength(1);
      expect(f.appends.filter(row => row.owner === history.resource.resource && row.name === 'new-video')).toHaveLength(2);
      expect(f.seeked).toHaveBeenCalledOnce();
    } finally { await f.destroy(); }
  });
});


// Cold probe: a fallible assembler operation after the actor publishes its role.
describe.each([18, 22] as const)('promotion native cleanup draft%i', draft => {
  it.each([false, true])('cleans an irreversible selectTrack failure: %s', async throws => {
    const f = await fixture(draft);
    try {
      const history = await f.landHistory();
      const observations: Array<{ state: string; current: boolean }> = [];
      f.player.on('error', () => observations.push({ state: f.player.state, current: history.resource.current }));
      const original = CmafAssembler.prototype.selectTrack;
      let entered = 0;
      vi.spyOn(CmafAssembler.prototype, 'selectTrack').mockImplementation(function(this: CmafAssembler, ...args: Parameters<CmafAssembler['selectTrack']>) {
        if (args[0] === 'video' && args[1] === 'new-video') {
          entered++;
          if (throws) throw new Error('controlled new-track selection failure');
        }
        return original.apply(this, args);
      });
      await f.player.selectVideoTrack(ref('new-video')); await flush(512);
      const target = f.request('new-video', 4n, 0n);
      await f.send(history.video, 4n, 0n, 6000n);
      await f.open(target, { group: 5n, object: 0n });
      await f.send(target, 4n, 0n, 6000n); await f.send(target, 4n, 1n, 8000n);
      await f.send(target, 5n, 0n, 10000n); await f.completeNative(); await flush(512);
      expect(entered).toBe(1);
      if (throws) {
        expect(f.player.state).toBe('error');
        expect.soft(observations, 'fatal publications must follow native retirement').toEqual([{ state: 'error', current: false }]);
        expect.soft(history.resource.current, 'partly promoted native output must be retired').toBe(false);
        expect.soft(history.resource.cancel).toHaveBeenCalledOnce();
        expect(f.switched).not.toHaveBeenCalled();
      } else {
        expect(f.player.state).toBe('playing'); expect(observations).toEqual([]);
        expect(history.resource.current).toBe(true); expect(history.resource.cancel).not.toHaveBeenCalled();
        expect(f.switched).toHaveBeenCalledOnce();
      }
    } finally { await f.destroy(); }
  });
});


describe.each([18, 22] as const)('native range endpoint readback draft%i', draft => {
  it.each([0, 1, 1.5, 10000])('keeps exact coded joining separate from native shortfall %s us', async shortfallUs => {
    const f = await fixture(draft);
    try {
      const history = await f.landHistory(), sample = history.resource.sample.bind(history.resource);
      vi.spyOn(history.resource, 'sample').mockImplementation(() => {
        const observed = sample();
        return observed && { ...observed, buffered: { ...observed.buffered, end: observed.buffered.end - shortfallUs / 1000000 } };
      });
      await f.player.selectVideoTrack(ref('new-video')); await flush(512);
      const target = f.request('new-video', 4n, 0n);
      await f.send(history.video, 4n, 0n, 6000n);
      await f.open(target, { group: 5n, object: 0n });
      await f.send(target, 4n, 0n, 6000n); await f.send(target, 4n, 1n, 8000n);
      await f.send(target, 5n, 0n, 10000n); await f.completeNative(); await flush(512);
      if (shortfallUs < 2) {
        expect(f.player.selection.video?.name).toBe('new-video'); expect(f.switched).toHaveBeenCalledOnce();
        expect(f.appends.filter(row => row.owner === history.resource.resource && row.name === 'new-video')).toHaveLength(3);
        expect(f.errors).toEqual([]);
      } else {
        expect(f.player.selection.video?.name).toBe('old-video'); expect(f.switched).not.toHaveBeenCalled();
        expect(f.appends.filter(row => row.owner === history.resource.resource && row.name === 'new-video')).toEqual([]);
        expect(f.appends).toContainEqual(expect.objectContaining({ owner: history.resource.resource, name: 'old-video', start: 6, completed: true }));
        expect(f.errors).toHaveLength(1); expect(f.errors[0]).toMatch(/future group join/);
      }
      expect(history.resource.current).toBe(true); expect(history.resource.cancel).not.toHaveBeenCalled();
      expect(f.resources).toHaveLength(1); expect(f.seeked).toHaveBeenCalledOnce();
    } finally { await f.destroy(); }
  });
});


describe.each([18, 22] as const)('lawful cache refusal after promotion draft%i', draft => {
  it('retains accepted native output and audio when a later FETCH is refused', async () => {
    const f = await fixture(draft);
    try {
      const history = await f.landHistory(), severities: string[] = [];
      f.player.on('error', event => severities.push(event.error.severity));
      await f.player.selectVideoTrack(ref('new-video')); await flush(512);
      const target = f.request('new-video', 4n, 0n);
      await f.send(history.audio, 4n, 0n, 6000n); await f.completeNative('audio');
      await f.send(history.video, 4n, 0n, 6000n);
      await f.open(target, { group: 5n, object: 0n });
      await f.send(target, 4n, 0n, 6000n); await f.send(target, 4n, 1n, 8000n);
      await f.send(target, 5n, 0n, 10000n); await f.completeNative(); await f.close(target);
      f.advance(7.125); await flush(512);
      const later = f.request('new-video', 5n, 1n), refusal = vi.fn();
      const onMessage = f.client.onMessage;
      f.client.onMessage = message => { if (message.type === 'REQUEST_ERROR') refusal(message); onMessage?.(message); };
      await f.server.rejectFetch(later.id, 16n, 'not cached'); await flush(512);
      expect(refusal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'REQUEST_ERROR', requestId: later.id, errorCode: 16n, errorReason: 'not cached' }));
      expect.soft(f.player.state).toBe('playing'); expect.soft(history.resource.current).toBe(true);
      expect.soft(history.resource.cancel).not.toHaveBeenCalled(); expect.soft(severities).toEqual(['degraded']);
      expect.soft(f.fetchCancel.mock.calls.some(([id]) => id === history.audio.id)).toBe(false);
      expect(f.player.selection.video?.name).toBe('new-video'); expect(f.player.selection.audio?.name).toBe('audio');
      expect(f.switched).toHaveBeenCalledOnce(); expect(f.resources).toHaveLength(1); expect(f.seeked).toHaveBeenCalledOnce();
      // The SDK's terminal callback can report stream failure before the
      // control message is dispatched; pin the actual refusal above.
      expect(f.errors).toHaveLength(1); expect(f.errors[0]).toMatch(/^Historical video retrieval stopped:/);
      f.advance(7.375); expect(f.player.playbackPositionMs).toBe(7375);
    } finally { await f.destroy(); }
  });
});


describe.each([18, 22] as const)('stalled native head and owned preparation budget draft%i', draft => {
  it('does not renew a running coast budget from an unchanged native head and range', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      f = await fixture(draft, { authorization: { getTokens: async context => {
        if (context.operation === 'FETCH' && context.trackName && dec.decode(context.trackName) === 'new-video') await waiting;
        return [catToken(Uint8Array.of(1))];
      } } });
      const history = await f.landHistory(); f.setNativePlayback(false, 1);
      const rejected = vi.fn(), selecting = f.player.selectVideoTrack(ref('new-video')); void selecting.catch(rejected); await flush(512);
      await f.send(history.video, 4n, 0n, 6000n);
      await vi.advanceTimersByTimeAsync(850); await flush(512);
      expect(history.resource.sample()?.currentTime).toBe(5.125);
      expect(f.player.playbackPositionMs).toBe(5125);
      expect(rejected, 'a stalled native clock must not renew the same preparation budget').toHaveBeenCalledOnce();
      await f.completeNative('video');
      expect(f.appends.filter(row => row.owner === history.resource.resource && row.name === 'old-video' && row.start === 6))
        .toEqual([expect.objectContaining({ completed: true, discarded: false })]);
      expect(f.resources).toHaveLength(1); expect(history.resource.cancel).not.toHaveBeenCalled(); expect(f.switched).not.toHaveBeenCalled();
    } finally { release?.(); await f?.destroy(); vi.useRealTimers(); }
  });
});


describe.each([18, 22] as const)('coast budget capacity accounting draft%i', draft => {
  it.each(['growth', 'faster', 'late-growth'] as const)('does not restore spent capacity after %s', async mode => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      // The initial snapshot must include G4: ordinary live paging with this
      // sparse index ends before G4, so landHistory's ACK would exceed it.
      f = await fixture(draft, { timelineLive: false, timelineEntries: [[4000, [3, 0], 0], [10000, [4, 0], 0], [12000, [5, 0], 0], [3600000, [900, 0], 0]], authorization: { getTokens: async context => {
        if (context.operation === 'FETCH' && context.trackName && dec.decode(context.trackName) === 'new-video') await waiting;
        return [catToken(Uint8Array.of(1))];
      } } });
      const history = await f.landHistory(); f.setNativePlayback(false, 1);
      const rejected = vi.fn(), selecting = f.player.selectVideoTrack(ref('new-video')); void selecting.catch(rejected); await flush(512);
      if (mode === 'faster') {
        await f.send(history.video, 4n, 0n, 10000n);
        await vi.advanceTimersByTimeAsync(500); expect(rejected).not.toHaveBeenCalled();
        f.setNativePlayback(false, 2); f.player.tick();
        await vi.advanceTimersByTimeAsync(150);
      } else {
        if (mode === 'growth') await vi.advanceTimersByTimeAsync(300);
        else vi.spyOn(performance, 'now').mockReturnValue(900);
        await f.send(history.video, 3n, 1n, 6000n); await f.completeNative('video');
        await f.send(history.video, 3n, 2n, 8000n); await f.completeNative('video');
        await f.send(history.audio, 3n, 4n, 6000n); await f.completeNative('audio');
        await f.send(history.audio, 3n, 5n, 8000n); await f.completeNative('audio');
        expect(history.resource.sample()?.buffered.end).toBe(10);
        await f.send(history.video, 4n, 0n, 10000n); f.player.tick();
        if (mode === 'growth') {
          expect(rejected).not.toHaveBeenCalled();
          // Original 775 ms + four seconds of NEW capacity is 4775 ms,
          // rather than a fresh 4775 ms window starting at the 300 ms read.
          await vi.advanceTimersByTimeAsync(4600);
        }
      }
      await flush(512);
      expect(rejected, 'capacity and rate updates must not resurrect spent/expired budget').toHaveBeenCalledOnce();
      expect(history.resource.sample()?.currentTime).toBe(5.125); expect(f.player.playbackPositionMs).toBe(5125);
      expect(f.switched).not.toHaveBeenCalled(); expect(history.resource.current).toBe(true); expect(history.resource.cancel).not.toHaveBeenCalled();
      expect(f.fetchCancel.mock.calls.some(([id]) => id === history.audio.id || id === history.video.id)).toBe(false);
    } finally { release?.(); await f?.destroy(); vi.restoreAllMocks(); vi.useRealTimers(); }
  });
});


// Public track_ended is released only when every selected role has accepted EOT
// and drained its work. It is delivery completion, not native endOfStream.
describe.each([18, 22] as const)('finite historical candidate completion draft%i', draft => {
  it.each([true, false])('owns final candidate FIN and native drainage without changing audio, final=%s', async final => {
    const f = await fixture(draft), ended: string[] = [];
    f.player.on('track_ended', event => { ended.push(event.mediaType); });
    try {
      const history = await f.landHistory(), native = history.resource;
      await f.player.selectVideoTrack(ref('new-video')); await flush(512);
      const target = f.request('new-video', 4n, 0n);
      expect(target.end).toEqual({ group: 5n, object: 1n });
      await f.open(target, final ? { group: 4n, object: 1n } : { group: 5n, object: 0n }, final);
      await f.send(target, 4n, 0n, 6000n); await f.send(target, 4n, 1n, 8000n);
      if (!final) await f.send(target, 5n, 0n, 10000n, 1);
      await f.close(target); // Real final FIN can close G; nonfinal uses ordered higher DATA.
      expect(f.player.selection.video?.name).toBe('old-video'); expect(f.switched).not.toHaveBeenCalled();
      expect(f.appends.filter(row => row.owner === native.resource && row.name === 'new-video')).toEqual([]);
      expect(ended).toEqual([]); expect(native.current).toBe(true); expect(native.cancel).not.toHaveBeenCalled();
      expect(f.fetchCancel.mock.calls.some(([id]) => id === target.id || id === history.audio.id)).toBe(false);

      // Actual same-consumer audio append proves independent ownership during
      // target preparation. Finish audio so premature video EOT would be public.
      const audioBefore = f.appends.filter(row => row.owner === native.resource && row.role === 'audio').length;
      await f.send(history.audio, 4n, 0n, 6000n); await f.completeNative('audio');
      expect(f.appends.filter(row => row.owner === native.resource && row.role === 'audio')).toHaveLength(audioBefore + 1);
      expect(f.player.selection.audio?.name).toBe('audio');
      expect(f.fetchCancel.mock.calls.some(([id]) => id === history.audio.id)).toBe(false);
      await f.close(history.audio);
      const audioFinal = f.request('audio', 4n, 1n);
      await f.open(audioFinal, { group: 4n, object: 1n }, true);
      await f.send(audioFinal, 4n, 1n, 8000n); await f.close(audioFinal);
      expect(ended).toEqual([]);
      const audioIndex = f.appends.findIndex(row => row.owner === native.resource && row.role === 'audio' && !row.completed);
      expect(audioIndex).toBeGreaterThanOrEqual(0); f.terminal(audioIndex); await flush(512);
      expect(ended).toEqual([]); expect(f.player.selection.video?.name).toBe('old-video');
      expect(f.resources).toHaveLength(1); expect(native.current).toBe(true); expect(f.errors).toEqual([]);

      await f.send(history.video, 4n, 0n, 6000n); await flush(512);
      expect(f.player.selection.video?.name).toBe('new-video'); expect(f.switched).toHaveBeenCalledOnce();
      expect(ended).toEqual([]); expect(native.cancel).not.toHaveBeenCalled();
      const expectedAppends = final ? 2 : 3; let lastVideoIndex = -1;
      for (let n = 0; n < expectedAppends; n++) {
        const pending = f.appends.findIndex(row => row.owner === native.resource && row.name === 'new-video' && !row.completed && !row.discarded);
        expect(pending, 'missing controlled target native append').toBeGreaterThanOrEqual(0);
        expect(ended).toEqual([]); expect(f.fetchCancel.mock.calls.some(([id]) => id === target.id)).toBe(false);
        f.terminal(pending); lastVideoIndex = pending; await flush(512);
        if (n + 1 < expectedAppends) expect(ended).toEqual([]);
      }
      expect(f.appends.filter(row => row.owner === native.resource && row.name === 'new-video'))
        .toEqual((final ? [6, 8] : [6, 8, 10]).map(start => expect.objectContaining({ start, completed: true, discarded: false,
          key: identityKey(namespace, 'new-video') })));
      expect(ended.slice().sort()).toEqual(final ? ['audio', 'video'] : []);
      if (final) expect(f.fetches.filter(row => row.name === 'new-video')).toHaveLength(1);

      // Duplicate native terminal observations and completion reconsideration
      // cannot republish the public role-delivery terminal.
      f.repeatNativeTerminal(lastVideoIndex); f.repeatNativeTerminal(audioIndex);
      f.player.tick(); f.player.tick(); await flush(512);
      expect(ended.filter(kind => kind === 'video')).toHaveLength(final ? 1 : 0);
      expect(ended.filter(kind => kind === 'audio')).toHaveLength(final ? 1 : 0);
      expect(f.player.selection.audio?.name).toBe('audio'); expect(native.current).toBe(true);
      expect(native.cancel).not.toHaveBeenCalled(); expect(f.source.endOfStream).not.toHaveBeenCalled();
      expect(native.initialize).toHaveBeenCalledOnce(); expect(native.position).toHaveBeenCalledOnce();
      expect(f.resources).toHaveLength(1); expect(f.seeked).toHaveBeenCalledOnce(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});


// Public SDK terminal reentry after actor publication.
describe.each([18, 22] as const)('committing health authority draft%i', draft => {
  it.each([false, true])('classifies a synchronous SDK terminal after role publication: %s', async cancelDuringCommit => {
    const f = await fixture(draft);
    let cancellation: Promise<void> | undefined, successor: Promise<void> | undefined;
    let targetId: bigint | null = null;
    try {
      const history = await f.landHistory();
      const observations: Array<{ severity: string; state: string; current: boolean }> = [];
      f.player.on('error', event => {
        observations.push({ severity: event.error.severity, state: f.player.state, current: history.resource.current });
        if (event.error.severity === 'degraded') {
          successor = f.player.seek(5500); void successor.catch(() => {});
        }
      });
      const original = CmafAssembler.prototype.selectTrack;
      let entered = 0;
      vi.spyOn(CmafAssembler.prototype, 'selectTrack').mockImplementation(function(this: CmafAssembler, ...args: Parameters<CmafAssembler['selectTrack']>) {
        original.apply(this, args);
        if (args[0] === 'video' && args[1] === 'new-video') {
          entered++;
          if (cancelDuringCommit) {
            if (targetId === null) throw new Error('Target request was not emitted');
            cancellation = f.client.fetchCancel(targetId); void cancellation.catch(() => {});
          }
        }
      });
      await f.player.selectVideoTrack(ref('new-video')); await flush(512);
      const target = f.request('new-video', 4n, 0n); targetId = target.id;
      await f.send(history.video, 4n, 0n, 6000n);
      await f.open(target, { group: 5n, object: 0n });
      await f.send(target, 4n, 0n, 6000n); await f.send(target, 4n, 1n, 8000n);
      await f.send(target, 5n, 0n, 10000n); await cancellation; await flush(512); await f.completeNative();
      expect(entered).toBe(1);
      if (cancelDuringCommit) {
        let successorOutcome = 'not called';
        if (successor) await successor.then(() => { successorOutcome = 'admitted'; }, error => { successorOutcome = String(error); });
        expect.soft(observations, 'irreversible consumer loss must not publish a rollback-capable degraded failure')
          .toEqual([{ severity: 'fatal', state: 'error', current: false }]);
        expect.soft(f.player.state).toBe('error');
        expect.soft(history.resource.current).toBe(false);
        expect.soft(history.resource.cancel).toHaveBeenCalledOnce();
        expect.soft(successorOutcome, 'a spurious degraded publication must not admit a successor over the damaged graph').not.toBe('admitted');
      } else {
        expect(observations).toEqual([]); expect(f.player.state).toBe('playing');
        expect(history.resource.current).toBe(true); expect(history.resource.cancel).not.toHaveBeenCalled();
        expect(f.switched).toHaveBeenCalledOnce();
      }
    } finally { await f.destroy(); }
  });
});


describe.each([18, 22] as const)('coast transition accounting draft%i', draft => {
  it.each(['slower', 'running-pause-resume', 'expired-before-pause'] as const)('preserves spent capacity for %s', async mode => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      f = await fixture(draft, { authorization: { getTokens: async context => {
        if (context.operation === 'FETCH' && context.trackName && dec.decode(context.trackName) === 'new-video') await waiting;
        return [catToken(Uint8Array.of(1))];
      } } });
      const history = await f.landHistory(); f.setNativePlayback(false, 1);
      const selecting = f.player.selectVideoTrack(ref('new-video')), rejected = vi.fn();
      void selecting.catch(rejected); await flush(512); await f.send(history.video, 4n, 0n, 6000n);
      if (mode === 'expired-before-pause') {
        // Observe a newly paused element only after the original 775ms capacity expired.
        vi.spyOn(performance, 'now').mockReturnValue(900); f.setNativePlayback(true, 1); f.player.tick();
      } else {
        await vi.advanceTimersByTimeAsync(500); expect(rejected).not.toHaveBeenCalled();
        if (mode === 'slower') {
          f.setNativePlayback(false, 0.5); f.player.tick();
          // 375 media-ms remain: new deadline=500+375/.5-100=1150ms.
          await vi.advanceTimersByTimeAsync(400); expect(rejected).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(260);
        } else {
          f.setNativePlayback(true, 1); f.player.tick();
          await vi.advanceTimersByTimeAsync(1000); expect(rejected).not.toHaveBeenCalled();
          f.setNativePlayback(false, 1); f.player.tick();
          // Pause preserves 375 media-ms, not a fresh observed 875ms budget.
          await vi.advanceTimersByTimeAsync(200); expect(rejected).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(100);
        }
      }
      await flush(512); expect(rejected).toHaveBeenCalledOnce();
      await expect(selecting).rejects.toThrow(/coast|deadline/i);
      expect(history.resource.sample()?.currentTime).toBe(5.125); expect(f.player.playbackPositionMs).toBe(5125);
      expect(f.player.selection.video?.name).toBe('old-video'); expect(f.player.selection.audio?.name).toBe('audio');
      expect(f.fetchCancel.mock.calls.some(([id]) => id === history.audio.id || id === history.video.id)).toBe(false);
      expect(f.switched).not.toHaveBeenCalled(); expect(history.resource.current).toBe(true); expect(history.resource.cancel).not.toHaveBeenCalled();
      await f.completeNative('video');
      expect(f.appends.filter(row => row.owner === history.resource.resource && row.name === 'old-video' && row.start === 6))
        .toEqual([expect.objectContaining({ completed: true, discarded: false, key: identityKey(namespace, 'old-video') })]);
    } finally { release?.(); await f?.destroy(); vi.restoreAllMocks(); vi.useRealTimers(); }
  });
});
