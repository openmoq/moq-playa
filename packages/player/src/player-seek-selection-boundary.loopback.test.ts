import { afterEach, describe, expect, it, vi } from 'vitest';
import { MoqtConnection, catToken } from '@openmoq/webtransport';
import { LocmafEncoder, LocmafGroupState, parseLocmafTrackContext, readCmafObjectSamples, serializeLocmafObject } from '@openmoq/locmaf';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { buildInit, buildChunk, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { MoqtPlayer } from './player.js';
import type { MediaAppendObserver, MediaSeekResource, MediaSeekSample, MediaSourceLike } from './interfaces.js';
import { QualityController } from './quality-controller.js';
afterEach(() => vi.restoreAllMocks());
const enc = new TextEncoder(), dec = new TextDecoder(), namespace = ['live', 'seek-selection'];
const ref = (name: string) => ({ namespace, name });
type Role = 'video' | 'audio';
const inits = { video: buildInit({ trackId: 1, timescale: 1000, handler: 'vide' }), audio: buildInit({ trackId: 2, timescale: 1000, handler: 'soun' }) };
const role = (name: string): Role => name === 'audio' ? 'audio' : 'video';
const marker = (name: string) => name === 'old-video' ? 11 : name === 'new-video' ? 22 : 33;
const index = [[4000, [3, 0], 0], [6000, [3, 1], 0], [12000, [3, 2], 0], [3600000, [900, 0], 0]];
async function fixture(sameSize = false) {
  const { a, b } = createLoopback(), client = new MoqtConnection(18), server = new MoqtConnection(18, { role: 'server' });
  const subscriptions: Array<{
    id: bigint;
    name: string;
    namespace: string[];
  }> = [], fetches: Array<{
    id: bigint;
    name: string;
    start: {
      group: bigint;
      object: bigint;
    };
    end: {
      group: bigint;
      object: bigint;
    };
  }> = [];
  const authCalls: Array<{
    operation: string;
    name: string;
    namespace: string[];
  }> = [], hooked: string[] = [], qualityEvents: string[] = [];
  const trace: unknown[] = [], errors: string[] = [], switched: string[] = [], wireStates = new Map<string, LocmafGroupState>(), wireEncoders = new Map<string, LocmafEncoder>();
  const subStreams = new Map<string, bigint>(), fetchStreams = new Map<bigint, bigint>(), observers = new Set<MediaAppendObserver>();
  const nativePositions: number[] = [];
  const installed = new Map<Role, Uint8Array>(), offsets = new Map<Role, number>(), blocked = new Set<Role>();
  const appends: Array<{
    role: Role;
    name: string;
    source: string | undefined;
    marker: number;
    pts: string;
    from: 'live' | 'seek';
    resource: object | null;
  }> = [];
  const queued: Array<() => void> = [], leases: Array<{
    roles: Role[];
    outcome: string;
  }> = [];
  let resource: MediaSeekResource | null = null, sample: MediaSeekSample | null = null, positionResolve: ((sample: MediaSeekSample) => void) | null = null, nativeTime = 0, generation = 0;
  const record = (from: 'live' | 'seek', kind: Role, bytes: Uint8Array, name: string, token: object | undefined, source: string | undefined) => {
    const init = installed.get(kind);
    if (!init)
      throw new Error('append without initialized role');
    const read = readCmafObjectSamples(bytes, parseLocmafTrackContext(init))![0]!;
    const submit = () => {
      trace.push({ kind: 'native-append', from, role: kind, name, marker: read.mdat[0], pts: String(read.effective.baseMediaDecodeTime), index: appends.length });
      appends.push({ role: kind, name, source, marker: read.mdat[0]!, pts: String(read.effective.baseMediaDecodeTime), from, resource: from === 'seek' ? resource?.resource ?? null : null });
      if (token)
        for (const observer of [...observers])
          observer({ token, state: 'appended', reason: null });
    };
    if (blocked.has(kind))
      queued.push(submit);
    else
      submit();
  };
  const source: MediaSourceLike = { supportsTrackIdentity: true, mediaElement: {}, onFirstFrame: null, onError: null, onStall: null,
    initialize: vi.fn(config => {
      for (const kind of ['video', 'audio'] as const)
        if (config[kind]) {
          installed.set(kind, config[kind].initData.slice());
          offsets.set(kind, 0);
        }
      return true;
    }),
    appendChunk(kind, bytes, name, _group, token, key) { record('live', kind, bytes, name, token, key); },
    observeAppends(observer) { observers.add(observer); return () => { observers.delete(observer); }; },
    getTimestampOffset: kind => offsets.get(kind), setTimestampOffset(kind, value) { offsets.set(kind, value); },
    changeType: async (kind, _codec, init) => { installed.set(kind, init.slice()); },
    clearTimeline() { }, reset() { generation++; }, destroy() { generation++; resource = null; }, endOfStream() { }, setPlaybackIntent() { },
    holdQueuedAppends(kinds) {
      const own = generation;
      let active = true;
      for (const kind of kinds)
        blocked.add(kind);
      const finish = (discard: boolean) => {
        if (!active || own !== generation)
          return;
        active = false;
        for (const kind of kinds)
          blocked.delete(kind);
        const work = queued.splice(0);
        if (!discard)
          for (const append of work)
            append();
        leases.push({ roles: [...kinds], outcome: discard ? 'discard' : 'resume' });
      };
      return { get current() { return active && own === generation; }, resume() { finish(false); }, discard() { finish(true); } };
    },
    beginSeek(epoch) {
      trace.push({ kind: 'begin-seek-resource' });
      const identity = {};
      sample = null;
      const owned: MediaSeekResource = { epoch, resource: identity, get current() { return resource === owned; },
        initialize(config) {
          for (const kind of ['video', 'audio'] as const)
            if (config[kind]) {
              installed.set(kind, config[kind].initData.slice());
              offsets.set(kind, 0);
            }
          return true;
        }, whenAttached: async () => { },
        appendChunk(kind, bytes, name, _group, token, key) { record('seek', kind, bytes, name, token, key); },
        observeAppends(observer) { observers.add(observer); return () => { observers.delete(observer); }; }, getTimestampOffset: kind => offsets.get(kind), setTimestampOffset(kind, value) { offsets.set(kind, value); },
        position: vi.fn((time: number) => { nativePositions.push(time); return new Promise<MediaSeekSample>(resolve => { positionResolve = resolve; }); }), sample: () => sample && { ...sample, currentTime: nativeTime }, setPlaybackIntent() { }, cancel() {
          if (resource === owned)
            resource = null;
        } };
      resource = owned;
      return owned;
    }
  };
  server.onSubscribe = (id, ns, name) => { trace.push({ kind: 'SUBSCRIBE', id, name: dec.decode(name), namespace: ns.map(field => dec.decode(field)) }); subscriptions.push({ id, namespace: ns.map(field => dec.decode(field)), name: dec.decode(name) }); };
  server.onFetch = (id, message) => {
    if (message.fetch.fetchType !== 1)
      throw new Error('standalone FETCH required');
    expect(message.fetch.trackNamespace.map(field => dec.decode(field))).toEqual(namespace);
    fetches.push({ id, name: dec.decode(message.fetch.trackName), start: message.fetch.startLocation, end: message.fetch.endLocation });
  };
  server.onError = error => { errors.push('peer: ' + error.message); };
  const connected = server.connect(b);
  void connected.catch(error => { errors.push(String(error)); });
  const transportFactory = vi.fn(async () => a);
  const player = new MoqtPlayer({ url: 'https://seek-selection.invalid/moq', namespace, draftVersion: 18, catalogBootstrap: 'subscribe', autoQuality: false,
    authorization: { getTokens: context => { authCalls.push({ operation: context.operation, name: context.trackName ? dec.decode(context.trackName) : '', namespace: (context.namespace ?? []).map(field => dec.decode(field)) }); return [catToken(Uint8Array.of(1))]; } },
    reconnectAttempts: 0, connectionTimeoutMs: 10000, cmafBootstrapTimeoutMs: 0, locmafDecoding: 'mse', logLevel: 'none',
    selection: { renderGroup: 1, videoTrack: ref('old-video'), audioTrack: ref('audio') },
    createConnection: () => client, createTransport: transportFactory, createMediaSource: () => source, createCmafAssembler: callbacks => new CmafAssembler(callbacks) });
  player.hooks.beforeSubscribe.add(intent => { hooked.push(intent.trackName); return intent; });
  for (const event of ['quality_switching', 'quality_switched', 'quality_switch_failed'] as const)
    player.on(event, () => { qualityEvents.push(event); });
  player.on('error', event => { errors.push(event.error.message); });
  player.on('quality_switched', event => { trace.push({ kind: 'quality-switched', name: event.toTrackName }); switched.push(event.toTrackName); });
  async function subscribe(name: string, alias: bigint) {
    const request = subscriptions.filter(sub => sub.name === name).at(-1);
    expect(request?.namespace).toEqual(namespace);
    if (!request)
      throw new Error('missing actual SUBSCRIBE ' + name);
    trace.push({ kind: 'SUBSCRIBE_OK', request: request.id, name, alias });
    await server.acceptSubscribe(request.id, alias);
    await flush(256);
  }
  function payload(name: string, group: bigint, id: bigint, pts: bigint) {
    const kind = role(name), key = name + '/' + group;
    const state = wireStates.get(key) ?? new LocmafGroupState(), encoder = wireEncoders.get(key) ?? new LocmafEncoder();
    wireStates.set(key, state);
    wireEncoders.set(key, encoder);
    const bytes = buildChunk({ trackId: kind === 'video' ? 1 : 2, bmdt: pts, samples: [{ duration: 2000, size: 4, flags: id === 0n ? SYNC_FLAGS : NON_SYNC_FLAGS }], mdat: Uint8Array.of(marker(name), Number(id), 3, 4) });
    return serializeLocmafObject(encoder.encode(bytes, state, parseLocmafTrackContext(inits[kind]), false, id));
  }
  async function publish(alias: bigint, name: string, group: bigint, id: bigint, bytes: Uint8Array) {
    if (name === 'catalog' || name === 'timeline')
      trace.push({ kind: name + '-document', document: JSON.parse(dec.decode(bytes)) });
    const key = name + '/' + group;
    let stream = subStreams.get(key);
    if (stream === undefined) {
      stream = await server.openSubgroup(alias, group, 0n, { publisherPriority: 128 });
      subStreams.set(key, stream);
    }
    await server.sendObject(stream, id, bytes);
    await flush(512);
  }
  async function media(name: string, alias: bigint, group: bigint, id: bigint, pts: bigint) { await publish(alias, name, group, id, payload(name, group, id, pts)); }
  async function destroy() { await player.destroy(); await server.close(); }
  try {
    await player.load();
    await connected;
    await flush(256);
    await subscribe('catalog', 100n);
    const tracks = [{ name: 'old-video', role: 'video', altGroup: 11, bitrate: 100000, width: 640, height: 360 }, { name: 'new-video', role: 'video', altGroup: 11, bitrate: 200000, width: sameSize ? 640 : 1280, height: sameSize ? 360 : 720 },
      { name: 'third-video', role: 'video', altGroup: 11, bitrate: 300000, width: 1920, height: 1080 },
      { name: 'audio', role: 'audio', altGroup: 21, bitrate: 64000, samplerate: 48000, channelConfig: '2', lang: 'en' }].map(track => ({ ...track, packaging: 'locmaf', locmafVersion: '0.3', renderGroup: 1, isLive: true,
      codec: track.role === 'video' ? 'avc1.640028' : 'mp4a.40.2', initRef: track.role + '-init' }));
    await publish(100n, 'catalog', 0n, 0n, enc.encode(JSON.stringify({ version: '1', initDataList: (['video', 'audio'] as const).map(kind => ({ id: kind + '-init', type: 'inline', data: Buffer.from(inits[kind]).toString('base64') })), tracks: [...tracks, { name: 'timeline', packaging: 'mediatimeline', isLive: true, mimeType: 'application/json', depends: ['old-video', 'new-video', 'third-video', 'audio'] }] })));
    await subscribe('old-video', 200n);
    await subscribe('audio', 201n);
    await subscribe('timeline', 300n);
    await publish(300n, 'timeline', 0n, 0n, enc.encode(JSON.stringify(index)));
    await media('old-video', 200n, 900n, 0n, 3600000n);
    await media('audio', 201n, 900n, 0n, 3600000n);
    expect(source.initialize).toHaveBeenCalledOnce();
    expect(player.seekable).toBe(true);
    expect(errors).toEqual([]);
    player.play();
    async function commitVideo() {
      await flush(256);
      await subscribe('new-video', 202n);
      await media('new-video', 202n, 901n, 0n, 3600020n);
      expect(player.selection.video?.name).toBe('new-video');
      expect(switched).toEqual(['new-video']);
      trace.push({ kind: 'selection-committed', selection: player.selection, appendIndex: appends.length });
    }
    return { player, source, appends, fetches, errors, switched, leases, subscriptions, authCalls, hooked, qualityEvents, nativePositions, transportFactory,
      noteRefusal(error: unknown) { trace.push({ kind: 'public-selection-refused', message: error instanceof Error ? error.message : String(error), playbackPositionMs: player.playbackPositionMs }); },
      commitVideo,
      async switchVideo() { await player.selectVideoTrack(ref('new-video')); await commitVideo(); },
      async audio() { await media('audio', 201n, 900n, 1n, 3600020n); },
      async seek() { await player.seek(5000); await flush(512); expect(fetches.map(request => request.name).sort()).toEqual(['audio', 'old-video']); },
      async history(name: string, object = 0n) {
        const request = fetches.find(candidate => candidate.name === name && candidate.start.object === object);
        if (!request)
          throw new Error('missing historical request ' + name + '/' + object);
        let stream = fetchStreams.get(request.id);
        if (stream === undefined) {
          await server.acceptFetch(request.id, { endOfTrack: 0, endLocation: { group: 3n, object: object + 1n } });
          stream = await server.openFetchStream(request.id);
          fetchStreams.set(request.id, stream);
        }
        await server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: object, publisherPriority: 128, payload: payload(name, 3n, object, 4000n + object * 2000n) });
        await flush(512);
      },
      async finishHistory(name: string, object = 0n) {
        const request = fetches.find(candidate => candidate.name === name && candidate.start.object === object);
        if (!request)
          throw new Error('missing page to finish');
        const stream = fetchStreams.get(request.id);
        if (stream === undefined)
          throw new Error('missing accepted stream');
        await server.closeFetchStream(stream);
        await flush(512);
      },
      land() {
        trace.push({ kind: 'native-position-completed', time: 5.125 });
        if (!resource || !positionResolve)
          throw new Error('native position not requested');
        nativeTime = 5.125;
        sample = { epoch: resource.epoch, resource: resource.resource, currentTime: nativeTime, buffered: { start: 4, end: 6 } };
        positionResolve(sample);
      },
      destroy };
  }
  catch (error) {
    await destroy();
    throw error;
  }
}
describe('precommit exclusion', () => {
  it.each(['video', 'media', 'audio'] as const)('refuses %s selection during historical seek preparation before manual lock, hooks, auth, SUB or quality events', async (method) => {
    const f = await fixture();
    try {
      f.player.setAutoQuality(true);
      await f.seek();
      expect(f.player.selection.autoQuality).toBe(true);
      expect(f.appends.filter(row => row.from === 'seek')).toEqual([]);
      // This observes the public method through its original implementation; no controller/state replacement.
      const manual = vi.spyOn(QualityController.prototype, 'lockManual');
      const hooks = f.hooked.length, auth = f.authCalls.length, requests = f.subscriptions.length, events = f.qualityEvents.length;
      const selected = f.player.selection;
      const operation = method === 'video' ? f.player.selectVideoTrack(ref('new-video')) : method === 'media' ? f.player.selectMedia({ videoTrack: ref('old-video') }) : f.player.selectAudioTrack(ref('audio'));
      const outcome = await operation.then(() => null, (error: unknown) => error);
      await flush(512);
      expect.soft(outcome, 'selection must refuse while historical seek is still preparing').toBeInstanceOf(Error);
      expect.soft(manual, 'refusal must precede lockManual').not.toHaveBeenCalled();
      expect.soft(f.hooked.slice(hooks), 'refusal must precede beforeSubscribe').toEqual([]);
      expect.soft(f.authCalls.slice(auth), 'refusal must precede authorization').toEqual([]);
      expect.soft(f.subscriptions.slice(requests), 'refusal must precede wire SUBSCRIBE').toEqual([]);
      expect.soft(f.qualityEvents.slice(events), 'refusal must precede quality events').toEqual([]);
      expect(f.player.selection).toEqual(selected);
      expect(f.errors).toEqual([]);
    }
    finally {
      await f.destroy();
    }
  });
});
describe('reciprocal precommit exclusion', () => {
  it('seek refuses while a real video selection is pending before target media commits', async () => {
    const f = await fixture();
    try {
      await f.player.selectVideoTrack(ref('new-video'));
      await flush(512);
      expect(f.subscriptions.filter(sub => sub.name === 'new-video')).toHaveLength(1);
      expect(f.switched).toEqual([]);
      expect(f.player.selection.video?.name).toBe('old-video');
      await expect(f.player.seek(5000)).rejects.toThrow(/seek/i);
      await flush(512);
      expect(f.fetches).toEqual([]);
      expect(f.appends.filter(row => row.from === 'seek')).toEqual([]);
      expect(f.player.selection.video?.name).toBe('old-video');
      expect(f.errors).toEqual([]);
    }
    finally {
      await f.destroy();
    }
  });
  it('one-shot public beforeSubscribe reentry leaves one admission owner before historical FETCH', async () => {
    const f = await fixture();
    try {
      let entered = false, selecting: Promise<unknown> | undefined;
      f.player.hooks.beforeSubscribe.add(intent => {
        if (!entered && intent.trackName === 'old-video') {
          entered = true;
          selecting = f.player.selectVideoTrack(ref('new-video')).then(() => null, (error: unknown) => error);
        }
        return intent;
      });
      const seeking = await f.player.seek(5000).then(() => null, (error: unknown) => error);
      await flush(512);
      expect(entered).toBe(true);
      expect(selecting).toBeDefined();
      const selected = await selecting;
      if (selected instanceof Error) {
        expect(seeking).toBeNull();
        expect(f.subscriptions.some(sub => sub.name === 'new-video')).toBe(false);
        expect(f.fetches.map(request => request.name).sort()).toEqual(['audio', 'old-video']);
      }
      else {
        expect.soft(seeking, 'a reserved selection must prevent the outer seek from starting old-track retrieval').toBeInstanceOf(Error);
        expect.soft(f.fetches, 'post-hook seek admission must revalidate the media-change reservation').toEqual([]);
        expect(f.subscriptions.filter(sub => sub.name === 'new-video')).toHaveLength(1);
      }
      expect(f.player.selection.video?.name).toBe('old-video');
      expect(f.appends.filter(row => row.from === 'seek')).toEqual([]);
      expect(f.errors).toEqual([]);
    }
    finally {
      await f.destroy();
    }
  });
});
describe('healthy controls', () => {
  it('ordinary committed quality switch keeps established audio', async () => {
    const f = await fixture();
    try {
      await f.switchVideo();
      const boundary = f.appends.length;
      await f.audio();
      expect(f.appends.slice(boundary).map(row => [row.role, row.name, row.marker])).toEqual([['audio', 'audio', 33]]);
      expect(f.appends.some(row => row.name === 'new-video' && row.marker === 22)).toBe(true);
      expect(f.errors).toEqual([]);
    }
    finally {
      await f.destroy();
    }
  });
  it('active historical A/V keeps audio progressing across its next actual FETCH page', async () => {
    const f = await fixture();
    try {
      await f.seek();
      await f.history('old-video');
      await f.history('audio');
      f.land();
      await flush(512);
      expect(f.player.playbackPositionMs).toBe(5125);
      const before = f.appends.filter(row => row.role === 'audio').length;
      await f.finishHistory('audio');
      await f.history('audio', 1n);
      expect(f.appends.filter(row => row.role === 'audio')).toHaveLength(before + 1);
      expect(f.errors).toEqual([]);
    }
    finally {
      await f.destroy();
    }
  });
});
describe('position pending and migration precommit exclusion', () => {
  it('keeps the guard until the actual native position witness settles, then admits an unchanged media selection', async () => {
    const f = await fixture();
    try {
      await f.seek();
      await f.history('old-video');
      await f.history('audio');
      await flush(512);
      expect(f.appends.filter(row => row.from === 'seek').map(row => row.role).sort()).toEqual(['audio', 'video']);
      expect(f.nativePositions).toEqual([5]);
      const hooks = f.hooked.length, auth = f.authCalls.length, requests = f.subscriptions.length, events = f.qualityEvents.length;
      await expect(f.player.selectMedia({ videoTrack: ref('old-video') })).rejects.toThrow(/busy|selection/i);
      await flush(512);
      expect(f.hooked.slice(hooks)).toEqual([]);
      expect(f.authCalls.slice(auth)).toEqual([]);
      expect(f.subscriptions.slice(requests)).toEqual([]);
      expect(f.qualityEvents.slice(events)).toEqual([]);
      f.land();
      await flush(512);
      expect(f.player.playbackPositionMs).toBe(5125);
      await expect(f.player.selectMedia({ videoTrack: ref('old-video') })).resolves.toBeUndefined();
      expect(f.player.selection.video?.name).toBe('old-video');
      expect(f.errors).toEqual([]);
    }
    finally {
      await f.destroy();
    }
  });
  it('migration refuses before transport or authorization while historical seek prepares, leaving the current seek usable', async () => {
    const f = await fixture(), candidate = new MoqtConnection(18);
    try {
      await f.seek();
      const factories = f.transportFactory.mock.calls.length, auth = f.authCalls.length;
      const migrated = vi.fn();
      f.player.on('session_migrated', migrated);
      await expect(f.player.migrate(candidate)).rejects.toThrow(/media selection.*busy/i);
      await flush(512);
      expect(f.transportFactory).toHaveBeenCalledTimes(factories);
      expect(f.authCalls.slice(auth)).toEqual([]);
      expect(migrated).not.toHaveBeenCalled();
      expect(f.player.selection.video?.name).toBe('old-video');
      await f.history('old-video');
      await f.history('audio');
      f.land();
      await flush(512);
      expect(f.player.playbackPositionMs).toBe(5125);
      expect(f.errors).toEqual([]);
    }
    finally {
      await candidate.close();
      await f.destroy();
    }
  });
});
describe('automatic selection during seek preparation', () => {
  async function high() {
    const f = await fixture();
    await f.switchVideo();
    f.player.setAutoQuality(true);
    f.source.getBufferAheadUs = () => 0;
    expect(f.player.selection.video?.name).toBe('new-video');
    return f;
  }
  it.each(['tick', 'stall'] as const)('%s does not propose recovery or change cooldown while seek owns preparation', async (mode) => {
    const f = await high();
    try {
      await f.player.seek(5000);
      await flush(512);
      expect(f.fetches.map(x => x.name).sort()).toEqual(['audio', 'new-video']);
      expect(f.appends.filter(x => x.from === 'seek')).toEqual([]);
      const proposal = vi.spyOn(f.player, 'selectVideoTrack'), before = (f.player as unknown as {
        readonly lastAbrDownshiftUs: number;
      }).lastAbrDownshiftUs;
      if (mode === 'tick') {
        f.player.tick();
        f.player.tick();
        f.player.tick();
      }
      else
        f.source.onStall!(517);
      await flush(512);
      expect.soft(proposal, 'busy seek must suppress automatic proposals before they reach the refusing API').not.toHaveBeenCalled();
      expect((f.player as unknown as {
        readonly lastAbrDownshiftUs: number;
      }).lastAbrDownshiftUs, 'a refused proposal must not start the upshift cooldown').toBe(before);
      expect(f.errors).toEqual([]);
    }
    finally {
      await f.destroy();
    }
  });
  it.each(['tick', 'stall'] as const)('%s retains a healthy emergency proposal outside preparation', async (mode) => {
    const f = await high();
    try {
      const proposal = vi.spyOn(f.player, 'selectVideoTrack');
      if (mode === 'tick')
        f.player.tick();
      else
        f.source.onStall!(517);
      await flush(512);
      expect(proposal).toHaveBeenCalledOnce();
      expect(f.subscriptions.filter(x => x.name === 'old-video')).toHaveLength(2);
      expect(f.errors).toEqual([]);
    }
    finally {
      await f.destroy();
    }
  });
});
describe('selection admission after native callbacks', () => {
  async function anchor(f: Awaited<ReturnType<typeof fixture>>) {
    void f.player.mediaTimelineReference;
    await f.audio();
    const reference = f.player.mediaTimelineReference;
    expect(reference).not.toBeNull();
    return reference!;
  }
  it('native offset getter cannot admit both a newer seek and the older media selection', async () => {
    const f = await fixture(true);
    let selecting: Promise<void> | undefined;
    try {
      const reference = await anchor(f), original = f.source.getTimestampOffset!;
      let once = true, seeking: Promise<void> | undefined;
      f.source.getTimestampOffset = kind => {
        if (once) {
          once = false;
          seeking = f.player.seek(5000);
          void seeking.catch(() => { });
        }
        return original(kind);
      };
      selecting = f.player.selectMedia({ videoTrack: ref('new-video') }, { timeline: { kind: 'reference-map', referenceToken: reference.token,
          video: { sourceTimeUs: 3600020000n, referenceTimeUs: 3600020000n } } });
      const status = { rejected: false };
      void selecting.catch(() => { status.rejected = true; });
      await flush(1024);
      expect(seeking).toBeDefined();
      await seeking;
      expect(f.fetches.map(x => x.name).sort()).toEqual(['audio', 'old-video']);
      expect(status.rejected, 'media selection must recheck seek admission after the native getter').toBe(true);
      expect(f.subscriptions.filter(x => x.name === 'new-video')).toEqual([]);
      expect(f.errors).toEqual([]);
    }
    finally {
      await f.destroy();
      await selecting?.catch(() => { });
    }
  });
  it('the same media selection remains admissible with an ordinary offset getter', async () => {
    const f = await fixture(true);
    let selecting: Promise<void> | undefined;
    try {
      const reference = await anchor(f);
      selecting = f.player.selectMedia({ videoTrack: ref('new-video') }, { timeline: { kind: 'reference-map', referenceToken: reference.token,
          video: { sourceTimeUs: 3600020000n, referenceTimeUs: 3600020000n } } });
      void selecting.catch(() => { });
      await flush(1024);
      expect(f.subscriptions.filter(x => x.name === 'new-video')).toHaveLength(1);
      expect(f.fetches).toEqual([]);
      expect(f.errors).toEqual([]);
    }
    finally {
      await f.destroy();
      await selecting?.catch(() => { });
    }
  });
});
it('video supersession cleanup cannot resume its older selection over a reentrant preparing seek', async () => {
  const f = await fixture();
  let outer: Promise<void> | undefined;
  try {
    await f.player.selectVideoTrack(ref('new-video'));
    await flush(512);
    expect(f.subscriptions.filter(x => x.name === 'new-video')).toHaveLength(1);
    expect(f.player.selection.video?.name).toBe('old-video');
    let seeking: Promise<void> | undefined, once = true;
    f.player.on('quality_switch_failed', () => {
      if (once) {
        once = false;
        seeking = f.player.seek(5000);
        void seeking.catch(() => { });
      }
    });
    outer = f.player.selectVideoTrack(ref('third-video'));
    const result = { rejected: false };
    void outer.catch(() => { result.rejected = true; });
    await flush(1024);
    expect(seeking).toBeDefined();
    await seeking;
    expect(f.fetches.map(x => x.name).sort()).toEqual(['audio', 'old-video']);
    expect(f.subscriptions.filter(x => x.name === 'third-video'), 'older video work must recheck the newly reserved seek after cleanup observers').toHaveLength(0);
    expect(f.player.selection.video?.name).toBe('old-video');
    expect(f.errors).toEqual([]);
  }
  finally {
    await f.destroy();
    await outer?.catch(() => { });
  }
});
it('ordinary video supersession still sends the newer target without a reentrant seek', async () => {
  const f = await fixture();
  let outer: Promise<void> | undefined;
  try {
    await f.player.selectVideoTrack(ref('new-video'));
    await flush(512);
    outer = f.player.selectVideoTrack(ref('third-video'));
    void outer.catch(() => { });
    await outer;
    await flush(512);
    expect(f.subscriptions.filter(x => x.name === 'third-video')).toHaveLength(1);
    expect(f.fetches).toEqual([]);
    expect(f.errors).toEqual([]);
  }
  finally {
    await f.destroy();
    await outer?.catch(() => { });
  }
});
