import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_VARINT, MessageParam, varint, encodeFetchHeader, encodeFetchObject, FetchFlags, FetchSubgroupMode, writeVarint, varintEncodingLength } from '@openmoq/transport';
import { MoqtConnection } from '@openmoq/webtransport';
import { LocmafEncoder, LocmafGroupState, LocmafTrackDecoder, isSyncSampleFlags, parseLocmafTrackContext, readCmafObjectSamples, serializeLocmafObject } from '@openmoq/locmaf';
import { identityKey } from '@openmoq/msf';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { createLoopback, flush, type LoopPipe } from '../../webtransport/src/testkit/loopback.js';
import { buildInit, buildChunk, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { MoqtPlayer } from './player.js';
import type { MediaAppendObserver, MediaSeekResource, MediaSeekSample, MediaSourceLike } from './interfaces.js';

afterEach(() => vi.restoreAllMocks());
const enc = new TextEncoder(), dec = new TextDecoder(), namespace = ['finite', 'legacy-quality'];
const ref = (name: string) => ({ namespace, name });
type Role = 'video' | 'audio';
type Location = { group: bigint; object: bigint };
interface Fetch { id: bigint; name: string; namespace: string[]; start: Location; end: Location; order: unknown; }
const inits = { video: buildInit({ trackId: 1, timescale: 1000, handler: 'vide' }), audio: buildInit({ trackId: 2, timescale: 1000, handler: 'soun' }) };
const role = (name: string): Role => name === 'audio' ? 'audio' : 'video';
const marker = (name: string) => name === 'old-video' ? 11 : name === 'new-video' ? 22 : 33;
const timeline = [[4000, [3, 0], 0], [6000, [4, 0], 0], [8000, [4, 1], 0], [10000, [5, 0], 0], [14000, [6, 0], 0]];

// Both peer forms are checked against literal spec packets, not decoder roundtrips.
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function integer(value: bigint): Uint8Array {
  const checked = varint(value), bytes = new Uint8Array(varintEncodingLength(checked));
  writeVarint(checked, bytes, 0); return bytes;
}
function legacyObject(draft: 14 | 16, group: bigint, object: bigint, payload: Uint8Array): Uint8Array {
  if (payload.length === 0) throw new Error('This data-only peer does not synthesize legacy status objects');
  if (draft === 14) {
    // transport14 10.4.4: G, SG, O, priority8, extension-length0, payload-length, payload.
    return concat([integer(group), integer(0n), integer(object), Uint8Array.of(128), integer(0n), integer(BigInt(payload.length)), payload]);
  }
  // transport16 10.4.4: every location field is explicit, with no extensions.
  return encodeFetchObject({ flags: varint(FetchFlags.GROUP_ID | FetchFlags.OBJECT_ID | FetchFlags.PRIORITY | FetchSubgroupMode.EXPLICIT),
    groupId: group, subgroupId: 0n, objectId: object, publisherPriority: 128, isDatagram: false, extensions: undefined, payload });
}

describe('legacy peer literal packets', () => {
  it.each([[14, '0500030000800001aa'], [16, '05001f0300008001aa']] as const)('matches draft%i FETCH_HEADER + DATA', (draft, literal) => {
    const packet = concat([encodeFetchHeader({ requestId: 0n }), legacyObject(draft, 3n, 0n, Uint8Array.of(0xaa))]);
    expect(Buffer.from(packet).toString('hex')).toBe(literal);
  });
});

// Real SDK control and player; spec-encoded legacy DATA on raw loopback uni streams.
// Controlled native terminals/position: no full SDK publisher or browser claim.
async function fixture(draft: 14 | 16, options: {
  timelineEntries?: readonly (readonly [number, readonly [number, number], number])[];
  videoLast?: Location;
  audioLast?: Location;
} = {}) {
  const { a, b } = createLoopback(), client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const subscriptions: Array<{ id: bigint; name: string; namespace: string[] }> = [], fetches: Fetch[] = [], errors: string[] = [];
  const states = new Map<string, LocmafGroupState>(), encoders = new Map<string, LocmafEncoder>(), payloadCache = new Map<string, Uint8Array>();
  const streams = new Map<string, bigint>();
  const fetchStreams = new Map<bigint, { writer: WritableStreamDefaultWriter<Uint8Array>; pipe: LoopPipe; closed: boolean }>();
  const observers = new Set<MediaAppendObserver>(), resources: MediaSeekResource[] = [];
  const assemblers: CmafAssembler[] = [];
  const responses: Array<{ id: bigint; end: Location; endOfTrack: number }> = [];
  const installed = new Map<Role, Uint8Array>(), offsets = new Map<Role, number>(), held = new Set<Role>();
  const seeked = vi.fn(), switched = vi.fn(), trace: Array<Record<string, unknown>> = [];
  const fetchCancel = vi.spyOn(client, 'fetchCancel'), unsubscribe = vi.spyOn(client, 'unsubscribe');
  const appends: Array<{ role: Role; name: string; key: string | undefined; marker: number; start: number; end: number; token: object | undefined; owner: object | null; completed: boolean; buffered: boolean; queued: boolean; discarded: boolean; bytes: Uint8Array }> = [];
  const leases: Array<{ roles: Role[]; outcome: 'discard' | 'resume' }> = [];
  let resource: MediaSeekResource | null = null, sample: MediaSeekSample | null = null, now = 0;
  let nativePaused: boolean | undefined = true, nativeRate: number | undefined = 1;
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
        sample: () => sample && { ...sample, currentTime: now, buffered: commonCoverage(),
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
  const connected = server.connect(b, { maxRequestId: varint(100n) });
  void connected.catch(error => { errors.push(String(error)); });
  const player = new MoqtPlayer({ url: 'https://quality-history.invalid/moq', namespace, draftVersion: draft,
    catalogBootstrap: 'subscribe', reconnectAttempts: 0, connectionTimeoutMs: 10000, cmafBootstrapTimeoutMs: 0,
    autoQuality: false, locmafDecoding: 'mse', logLevel: 'none',
    selection: { renderGroup: 1, videoTrack: ref('old-video'), audioTrack: ref('audio') },
    createConnection: () => client, createTransport: async () => a, createMediaSource: () => source, createCmafAssembler: callbacks => { const assembler = new CmafAssembler(callbacks); assemblers.push(assembler); return assembler; } });
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
    await server.acceptFetch(request.id, { endOfTrack: endOfTrack ? 1 : 0, endLocation: request.end.group === last.group && request.end.object === 0n
      ? { group: last.group, object: 0n } : { group: last.group, object: last.object + 1n } });
    if (fetchStreams.has(request.id)) throw new Error('One legacy response uni stream per owned request');
    const index = b.uniOut.length, writable = await b.createUnidirectionalStream(), writer = writable.getWriter();
    const pipe = b.uniOut[index];
    if (!pipe) { writer.releaseLock(); throw new Error('Missing actual raw legacy response pipe'); }
    fetchStreams.set(request.id, { writer, pipe, closed: false });
    await writer.write(encodeFetchHeader({ requestId: request.id }));
    return index;
  }
  async function send(request: Fetch, group: bigint, id: bigint, pts: bigint, duration = 2000) {
    const stream = fetchStreams.get(request.id);
    if (!stream || stream.closed) throw new Error('Owned legacy response writer is unavailable');
    await stream.writer.write(legacyObject(draft, group, id, payload(request.name, group, id, pts, duration)));
    await flush(512);
  }
  async function completeNative(only?: Role) {
    for (let turn = 0; turn < 8; turn++) {
      await flush(256); const index = appends.findIndex(row => row.owner === resource?.resource && !row.completed && !row.queued && !row.discarded && (only === undefined || row.role === only));
      if (index < 0) return; terminal(index);
    }
    throw new Error('Unexpected native completion backlog');
  }
  async function finishWriter(stream: { writer: WritableStreamDefaultWriter<Uint8Array>; closed: boolean }) {
    if (stream.closed) return;
    stream.closed = true;
    try { await stream.writer.close(); } finally { stream.writer.releaseLock(); }
  }
  async function close(request: Fetch) {
    const stream = fetchStreams.get(request.id); if (!stream) throw new Error('Missing owned legacy response writer');
    await finishWriter(stream); await flush(512);
  }
  const request = (name: string, group: bigint, object: bigint) => {
    const found = fetches.find(row => row.name === name && row.start.group === group && row.start.object === object);
    expect(found, 'missing issued historical request ' + name + '/' + group + '/' + object).toBeDefined(); return found!;
  };
  async function destroy() {
    try { await player.destroy(); }
    finally {
      try { await Promise.all([...fetchStreams.values()].map(finishWriter)); }
      finally { await server.close(); }
    }
  }
  try {
    await player.load(); await connected; await flush(256);
    const onMessage = client.onMessage;
    client.onMessage = message => {
      if (message.type === 'FETCH_OK') responses.push({ id: message.requestId, end: { ...message.endLocation }, endOfTrack: message.endOfTrack });
      onMessage?.(message);
    };
    await acceptSub('catalog', 100n);
    const tracks = [{ name: 'old-video', role: 'video', altGroup: 11, bitrate: 100000, width: 640, height: 360 },
      { name: 'new-video', role: 'video', altGroup: 11, bitrate: 200000, width: 640, height: 360 },
      { name: 'audio', role: 'audio', altGroup: 21, bitrate: 64000, samplerate: 48000, channelConfig: '2', lang: 'en' }]
      .map(track => ({ ...track, packaging: 'locmaf', locmafVersion: '0.3', renderGroup: 1, isLive: false,
        codec: track.role === 'video' ? 'avc1.640028' : 'mp4a.40.2', initRef: track.role + '-init' }));
    await publish('catalog', 100n, 0n, 0n, enc.encode(JSON.stringify({ version: '1', initDataList: (['video', 'audio'] as const).map(kind => ({ id: kind + '-init', type: 'inline', data: Buffer.from(inits[kind]).toString('base64') })),
      tracks: [...tracks, { name: 'timeline', packaging: 'mediatimeline', isLive: false, mimeType: 'application/json', depends: ['old-video', 'new-video', 'audio'] }] })));
    await acceptSub('old-video', 200n); await acceptSub('audio', 201n); await acceptSub('timeline', 300n);
    await publish('timeline', 300n, 0n, 0n, enc.encode(JSON.stringify(options.timelineEntries ?? timeline)));
    await publish('old-video', 200n, 3n, 0n, payload('old-video', 3n, 0n, 4000n));
    await publish('audio', 201n, 3n, 0n, payload('audio', 3n, 0n, 4000n, 500));
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
    return { player, client, server, source, subscriptions, fetches, appends, resources, assemblers, responses, seeked, switched, errors, leases, trace, fetchCancel, unsubscribe,
      payload, publish, acceptSub, request, open, send, close, completeNative, coverage, terminal,
      async landHistory(finBeforeNative = false) {
        await player.seek(5000); await flush(512);
        const video = request('old-video', 3n, 0n), audio = request('audio', 3n, 0n);
        await open(video, options.videoLast ?? { group: 6n, object: 0n }, true);
        await open(audio, options.audioLast ?? { group: 6n, object: 0n }, true);
        await send(video, 3n, 0n, 4000n);
        for (let i = 0; i < 4; i++) await send(audio, 3n, BigInt(i), 4000n + BigInt(i * 500), 500);
        if (finBeforeNative) {
          await close(video); await close(audio);
          expect(seeked).not.toHaveBeenCalled(); expect(player.playbackPositionMs).toBe(5000);
        }
        await completeNative();
        expect(coverage('video')).toEqual({ start: 4, end: 6 }); expect(coverage('audio')).toEqual({ start: 4, end: 6 });
        if (!resource || !positionResolve) throw new Error('Actual native positioning was not requested');
        now = 5.125; sample = { epoch: resource.epoch, resource: resource.resource, currentTime: now, buffered: commonCoverage() }; positionResolve(sample);
        await flush(512); expect(player.playbackPositionMs).toBe(5125); expect(seeked).toHaveBeenCalledOnce();
        return { video, audio, resource };
      },
      advance(time: number) { now = time; player.tick(); },
      destroy };
  } catch (error) { await destroy(); throw error; }
}

describe.each([14, 16] as const)('finite historical SDK-control/spec-data draft%i', draft => {
  it('positions direct A/V history and releases final EOT only after native work', async () => {
    const f = await fixture(draft, { timelineEntries: [[4000, [3, 0], 0]],
      videoLast: { group: 3n, object: 0n }, audioLast: { group: 3n, object: 3n } });
    const ended: string[] = [];
    f.player.on('track_ended', event => ended.push(event.mediaType));
    try {
      const history = await f.landHistory(true), native = history.resource;
      expect(f.fetches).toHaveLength(2);
      for (const request of [history.video, history.audio]) {
        expect(request.namespace).toEqual(namespace); expect(request.order).toBe(1n);
        expect(request.start).toEqual({ group: 3n, object: 0n });
        expect(request.end).toEqual({ group: MAX_VARINT, object: 0n });
      }
      expect(f.responses).toEqual([
        { id: history.video.id, end: { group: 3n, object: 1n }, endOfTrack: 1 },
        { id: history.audio.id, end: { group: 3n, object: 4n }, endOfTrack: 1 },
      ]);
      expect(ended.slice().sort()).toEqual(['audio', 'video']);
      expect(f.appends.filter(row => row.owner === native.resource && row.role === 'video'))
        .toEqual([expect.objectContaining({ start: 4, end: 6, marker: 11, completed: true,
          key: identityKey(namespace, 'old-video') })]);
      expect(f.appends.filter(row => row.owner === native.resource && row.role === 'audio'))
        .toHaveLength(4);
      f.advance(5.375); expect(f.player.playbackPositionMs).toBe(5375);
      expect(f.resources).toHaveLength(1); expect(native.initialize).toHaveBeenCalledOnce();
      expect(native.position).toHaveBeenCalledOnce(); expect(f.seeked).toHaveBeenCalledOnce();
      expect(native.current).toBe(true); expect(native.cancel).not.toHaveBeenCalled();
      expect(f.switched).not.toHaveBeenCalled(); expect(f.source.changeType).not.toHaveBeenCalled();
      expect(f.source.endOfStream).not.toHaveBeenCalled();
      f.player.tick(); f.player.tick(); await flush(256);
      expect(ended.slice().sort()).toEqual(['audio', 'video']);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('prepares a whole target group, then keeps delta state and audio on the same native resource', async () => {
    const f = await fixture(draft);
    try {
      const history = await f.landHistory(), native = history.resource;
      const before = { assemblers: f.assemblers.length, subscriptions: f.subscriptions.length,
        initializes: vi.mocked(f.source.initialize).mock.calls.length };
      const decoded: Array<{ decoder: LocmafTrackDecoder; group: bigint; object: bigint; marker: number }> = [];
      const original = LocmafTrackDecoder.prototype.push;
      vi.spyOn(LocmafTrackDecoder.prototype, 'push').mockImplementation(function(this: LocmafTrackDecoder, ...args: Parameters<LocmafTrackDecoder['push']>) {
        const result = original.apply(this, args);
        if (result.kind === 'chunk') {
          const read = readCmafObjectSamples(result.bytes, this.context)?.[0];
          if (read) decoded.push({ decoder: this, group: args[0], object: args[1], marker: read.mdat[0]! });
        }
        return result;
      });
      await f.player.selectVideoTrack(ref('new-video')); await flush(512);
      const target = f.request('new-video', 4n, 0n);
      expect(target.namespace).toEqual(namespace); expect(target.order).toBe(1n);
      expect(target.end).toEqual({ group: 5n, object: 1n });
      await f.send(history.video, 4n, 0n, 6000n); // Ordered old cut is held raw.
      await f.send(history.audio, 4n, 0n, 6000n); await f.completeNative('audio');
      await f.send(history.audio, 4n, 1n, 8000n); await f.completeNative('audio');
      await f.open(target, { group: 5n, object: 0n });
      await f.send(target, 4n, 0n, 6000n); await f.send(target, 4n, 1n, 8000n);
      expect(f.player.selection.video?.name).toBe('old-video'); expect(f.switched).not.toHaveBeenCalled();
      expect(f.appends.filter(row => row.owner === native.resource && row.name === 'new-video')).toEqual([]);
      await f.send(target, 5n, 0n, 10000n); // First actual higher DATA closes G4.
      await f.completeNative(); await f.close(target);
      expect(f.player.selection.video?.name).toBe('new-video'); expect(f.switched).toHaveBeenCalledOnce();
      expect(f.responses).toContainEqual({ id: target.id, end: { group: 5n, object: 1n }, endOfTrack: 0 });
      expect(f.appends.filter(row => row.owner === native.resource && row.name === 'new-video'))
        .toEqual([6, 8, 10].map(start => expect.objectContaining({ start, end: start + 2, marker: 22,
          key: identityKey(namespace, 'new-video'), completed: true, discarded: false })));
      expect(f.appends.some(row => row.owner === native.resource && row.name === 'old-video' && row.start === 6)).toBe(false);
      expect(f.fetches.some(row => row.name === 'new-video' && row.start.group === 5n && row.start.object === 1n)).toBe(false);

      // FIN alone does not waive native lookahead credit. An observed head
      // advance releases the next standalone page, without JOIN/FILL.
      f.advance(7.125); await flush(512);
      const later = f.request('new-video', 5n, 1n);
      expect(later.end).toEqual({ group: 5n, object: 0n });
      const delta = f.payload('new-video', 5n, 1n, 12000n);
      expect(new LocmafTrackDecoder(inits.video).push(5n, 1n, delta).kind).toBe('rejected');
      await f.open(later, { group: 5n, object: 1n });
      await f.send(later, 5n, 1n, 12000n); await f.completeNative('video');
      expect(f.responses).toContainEqual({ id: later.id, end: { group: 5n, object: 0n }, endOfTrack: 0 });
      expect(f.appends).toContainEqual(expect.objectContaining({ owner: native.resource, name: 'new-video',
        start: 12, end: 14, marker: 22, completed: true, key: identityKey(namespace, 'new-video') }));
      const targetCalls = decoded.filter(row => row.marker === 22);
      expect(targetCalls.map(row => [row.group, row.object])).toEqual([[4n, 0n], [4n, 1n], [5n, 0n], [5n, 1n]]);
      expect(new Set(targetCalls.map(row => row.decoder)).size).toBe(1);

      await f.send(history.audio, 5n, 0n, 10000n); await f.completeNative('audio');
      const audioDelta = f.payload('audio', 5n, 1n, 12000n);
      expect(new LocmafTrackDecoder(inits.audio).push(5n, 1n, audioDelta).kind).toBe('rejected');
      await f.send(history.audio, 5n, 1n, 12000n); await f.completeNative('audio');
      f.advance(9.375); expect(f.player.playbackPositionMs).toBe(9375);
      expect(f.player.selection.audio?.name).toBe('audio');
      expect(f.fetchCancel.mock.calls.some(([id]) => id === history.audio.id)).toBe(false);
      expect(new Set(f.fetchCancel.mock.calls.map(([id]) => id))).toEqual(new Set([history.video.id]));
      expect(f.assemblers).toHaveLength(before.assemblers); expect(f.subscriptions).toHaveLength(before.subscriptions);
      expect(f.resources).toHaveLength(1); expect(native.initialize).toHaveBeenCalledOnce();
      expect(native.position).toHaveBeenCalledOnce(); expect(f.seeked).toHaveBeenCalledOnce();
      expect(f.source.initialize).toHaveBeenCalledTimes(before.initializes); expect(f.source.changeType).not.toHaveBeenCalled();
      expect(native.current).toBe(true); expect(native.cancel).not.toHaveBeenCalled();
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});
