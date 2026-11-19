/** Real SDK catalog deltas and adapter configuration; no native playback claim. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MoqtPlayerConfig } from './config.js';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { videoInit } from '../../locmaf/test-support/cmaf.js';
import type { CatalogState } from '@openmoq/msf';
import { catToken } from '@openmoq/webtransport';
import { MoqtConnection } from '@openmoq/webtransport';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { MoqtPlayer } from './player.js';

beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
afterEach(() => vi.useRealTimers());
const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
async function fixture(version = 'draft-02', initial: Record<string, unknown> = {}, config: Partial<MoqtPlayerConfig> = {}, alternate = false, timeline = false) {
  const { a, b } = createLoopback(), client = new MoqtConnection(23), server = new MoqtConnection(23, { role: 'server' });
  const requests: { id: bigint; name: string }[] = [], configurations: unknown[][] = [], destroyed: number[] = [], errors: string[] = [];
  const audioConfigurations: unknown[][] = [], mediaInitializations: unknown[] = [], mediaDestroyed: number[] = [];
  server.onSubscribe = (id, _ns, name) => { requests.push({ id, name: new TextDecoder().decode(name) }); };
  let serving: Promise<void> | undefined, generation = 0;
  const player = new MoqtPlayer({ url: 'https://updates.invalid/moq', namespace: ['live'], draftVersion: 23,
    catalogBootstrap: 'subscribe', autoQuality: false, startLevel: 0, livenessTimeoutMs: 0, connectionTimeoutMs: 1000,
    createConnection: () => client, createTransport: async () => { serving = server.connect(b); return a; },
    createVideoDecoder: () => { const id = ++generation; return {
      configure(...args) { configurations.push(args); }, decode() {}, flush: async () => {}, reset() {}, destroy() { destroyed.push(id); },
      onFrame: null, onError: null,
    }; },
    createAudioDecoder: () => ({ configure(...args) { audioConfigurations.push(args); }, decode() {},
      flush: async () => {}, reset() {}, destroy() {}, onData: null, onError: null }),
    createAudioOutput: () => ({ schedule() {}, flush() {}, destroy() {}, currentPlayoutTimeUs: 0 }),
    createCmafAssembler: callbacks => new CmafAssembler(callbacks),
    createMediaSource: () => ({ initialize(value) { mediaInitializations.push(value); }, appendChunk() {},
      endOfStream() {}, reset() {}, destroy() { mediaDestroyed.push(1); }, currentTime: 0, duration: 0,
      bufferedAhead: 0, playbackRate: 1, onError: null, onFirstFrame: null, onStall: null, onStallRecovered: null }),
    createRenderer: () => ({ enqueue() {}, flush() {}, destroy() {}, onFirstFrame: null, onFrameRendered: null, onStall: null }),
    ...config,
  });
  let catalog: CatalogState | undefined;
  player.on('catalog_updated', event => { catalog = event.catalog; });
  player.on('error', event => { errors.push(event.error.message); });
  await player.load(); await flush(256);
  await server.acceptSubscribe(requests[0]!.id, 100n);
  const stream = await server.openSubgroup(100n, 1n, 0n, { publisherPriority: 128 });
  await server.sendObject(stream, 0n, enc({ version, tracks: [{ name: 'v', role: 'video', packaging: 'loc',
    codec: 'avc1.640028', bitrate: 1000, framerate: 25, isLive: true, initData: 'AQID', altGroup: 1, ...initial },
    ...(alternate ? [{ name: 'low', role: 'video', packaging: 'loc', codec: 'avc1.640028',
      bitrate: 500, framerate: 25, isLive: false, initData: 'AQID', altGroup: 1 }] : []),
    ...(timeline ? [{ name: 'timeline', packaging: 'mediatimeline', isLive: true, mimeType: 'application/json', depends: ['v'] }] : [])] }));
  await flush(256);
  await server.acceptSubscribe(requests.find(r => r.name === 'v')!.id, 200n); await flush(256); player.play();
  let object = 0n;
  return { player, server, requests, configurations, destroyed, errors, audioConfigurations, mediaInitializations, mediaDestroyed, get catalog() { return catalog; },
    async update(fields: Record<string, unknown>) {
      await server.sendObject(stream, ++object, enc({ generatedAt: Number(object), deltaUpdate: [
        { op: 'update', tracks: [{ parentName: 'v', ...fields }] },
      ] })); await flush(512);
    },
    async close() { await player.destroy(); await server.close(); await serving; },
  };
}

it.each([{ codec: 'avc1.640032' }, { initData: 'BAUG' }])('reconfigures a playing draft-02 identity after %j', async fields => {
  const f = await fixture();
  try {
    const before = f.configurations.length;
    await f.update(fields);
    expect(f.configurations.length).toBeGreaterThan(before);
    expect(f.destroyed).toContain(1);
    expect(f.requests.filter(r => r.name === 'v')).toHaveLength(2);
    const configuration = f.configurations.at(-1)!;
    expect(configuration[0]).toEqual(fields.initData ? Uint8Array.of(4, 5, 6) : Uint8Array.of(1, 2, 3));
    expect(configuration[1]).toBe(fields.codec ?? 'avc1.640028');
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

it('adopts bitrate-only changes without restarting the playing graph', async () => {
  const f = await fixture();
  try {
    const before = f.configurations.length;
    await f.update({ bitrate: 2000 });
    expect(f.catalog?.tracks[0]?.bitrate).toBe(2000);
    expect(f.configurations).toHaveLength(before); expect(f.destroyed).toEqual([]);
    expect(f.requests.filter(r => r.name === 'v')).toHaveLength(1);
  } finally { await f.close(); }
});

it('keeps MSF-01 update refusal and the running configuration', async () => {
  const f = await fixture('draft-01');
  try {
    const before = f.configurations.length;
    await f.update({ codec: 'avc1.640032' });
    expect(f.configurations).toHaveLength(before); expect(f.destroyed).toEqual([]);
    expect(f.requests.filter(r => r.name === 'v')).toHaveLength(1);
    expect(f.errors.length).toBeGreaterThan(0);
  } finally { await f.close(); }
});


it.each([{ altGroup: 2 }, { renderGroup: 2 }, { keyframeSpacing: 15 }])('reselects changed selection metadata %j', async fields => {
  const f = await fixture();
  try {
    const count = f.configurations.length;
    await f.update(fields);
    expect(f.configurations.length).toBeGreaterThan(count);
    expect(f.requests.filter(r => r.name === 'v')).toHaveLength(2);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

it('rebuilds LOC to MSE and back for packaging-only updates', async () => {
  const f = await fixture('draft-02', { initData: Buffer.from(videoInit()).toString('base64') });
  try {
    await f.update({ packaging: 'cmaf' });
    expect(f.mediaInitializations).toHaveLength(1); expect(f.destroyed).toContain(1);
    expect(f.errors).toEqual([]);
    const mseRequest = f.requests.filter(r => r.name === 'v').at(-1)!;
    await f.server.acceptSubscribe(mseRequest.id, 201n); await flush(256);
    const count = f.configurations.length;
    await f.update({ packaging: 'loc' });
    expect(f.mediaDestroyed).toEqual([1]); expect(f.configurations.length).toBeGreaterThan(count);
    expect(f.requests.filter(r => r.name === 'v')).toHaveLength(3);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

it('replaces enabled outputs and applies audio decoder metadata', async () => {
  const f = await fixture();
  try {
    await f.update({ role: 'audio', codec: 'opus', samplerate: 48000, channelConfig: '2' });
    expect(f.audioConfigurations.at(-1)?.slice(1)).toEqual(['opus', 48000, 2]);
    expect(f.destroyed).toContain(1);
    await f.server.acceptSubscribe(f.requests.filter(r => r.name === 'v').at(-1)!.id, 201n); await flush(256);
    await f.update({ codec: 'mp4a.40.2', samplerate: 44100, channelConfig: '1' });
    expect(f.audioConfigurations.at(-1)?.slice(1)).toEqual(['mp4a.40.2', 44100, 1]);
    await f.server.acceptSubscribe(f.requests.filter(r => r.name === 'v').at(-1)!.id, 202n); await flush(256);
    await f.update({ role: 'video', codec: 'avc1.640028' });
    expect(f.configurations.at(-1)?.[1]).toBe('avc1.640028');
    expect(f.configurations).toHaveLength(2);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

it('supersedes a reselect whose subscription authorization is still pending', async () => {
  let release!: () => void, subscriptions = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture('draft-02', {}, { authorization: { getTokens: async context => {
    if (context.operation === 'SUBSCRIBE' && context.trackName && new TextDecoder().decode(context.trackName) === 'v'
        && ++subscriptions === 2) await gate;
    return [catToken(Uint8Array.of(1))];
  } } });
  try {
    await f.update({ initData: 'BAUG' });
    expect(f.requests.filter(r => r.name === 'v')).toHaveLength(1);
    await f.update({ initData: 'BwgJ' });
    expect(f.configurations.at(-1)?.[0]).toEqual(Uint8Array.of(7, 8, 9));
    release(); await flush(512);
    expect(f.requests.filter(r => r.name === 'v')).toHaveLength(2);
    expect(f.errors).toEqual([]);
  } finally { release(); await f.close(); }
});

it('does not revive playback when teardown races catalog replacement', async () => {
  const f = await fixture();
  try {
    f.player.on('catalog_updated', () => { void f.player.destroy(); });
    await f.update({ initData: 'BAUG' }); await flush(512);
    expect(f.requests.filter(r => r.name === 'v')).toHaveLength(1);
    expect(f.configurations).toHaveLength(1); expect(f.destroyed).toEqual([1]);
  } finally { await f.close(); }
});


it('retires a pending quality switch before replacing the playing declaration', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture('draft-02', {}, { authorization: { getTokens: async context => {
    if (context.operation === 'SUBSCRIBE' && context.trackName && new TextDecoder().decode(context.trackName) === 'low') await gate;
    return [catToken(Uint8Array.of(1))];
  } } }, true);
  try {
    const switching = f.player.selectVideoTrack('low').then(() => null, error => error);
    await flush(256); await f.update({ initData: 'BAUG' });
    release(); expect(await switching).toBeInstanceOf(Error); await flush(512);
    expect(f.requests.filter(r => r.name === 'low')).toEqual([]);
    expect(f.configurations.at(-1)?.[0]).toEqual(Uint8Array.of(4, 5, 6));
    expect(f.requests.filter(r => r.name === 'v')).toHaveLength(2);
    expect(f.errors).toEqual([]);
  } finally { release(); await f.close(); }
});

it('retries a replacement whose subscription never finishes authorization', async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
  let release!: () => void, subscriptions = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture('draft-02', {}, { connectionTimeoutMs: 20, livenessTimeoutMs: 40, authorization: { getTokens: async context => {
    if (context.operation === 'SUBSCRIBE' && context.trackName && new TextDecoder().decode(context.trackName) === 'v'
        && ++subscriptions === 2) await gate;
    return [catToken(Uint8Array.of(1))];
  } } });
  try {
    await f.update({ initData: 'BAUG' });
    expect(subscriptions).toBe(2);
    await vi.advanceTimersByTimeAsync(21);
    expect(f.player.state).toBe('playing');
    expect(f.errors).toEqual([]);
    expect(subscriptions).toBe(2);
    await vi.advanceTimersByTimeAsync(41); f.player.tick(); await flush(256);
    expect(subscriptions).toBe(3);
    release(); await flush(512);
    expect(f.requests.filter(r => r.name === 'v')).toHaveLength(2);
    await f.server.rejectSubscribe(f.requests.filter(r => r.name === 'v')[1]!.id, 1n, 'no retry');
    await flush(256); await vi.advanceTimersByTimeAsync(25);
    expect(f.errors.some(message => message.includes('Media delivery starved'))).toBe(true);
    expect(f.errors.some(message => message.includes('All media track'))).toBe(false);
  } finally { release(); await f.close(); }
});

it('rejects an ended track becoming live without changing its graph', async () => {
  const f = await fixture('draft-02', { isLive: false });
  try {
    await f.update({ isLive: true });
    expect(f.errors.some(message => message.includes('isLive'))).toBe(true);
    expect(f.destroyed).toEqual([]); expect(f.configurations).toHaveLength(1);
  } finally { await f.close(); }
});


it('does not attach an auxiliary request authorized for the retired graph', async () => {
  let release!: () => void, timelines = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture('draft-02', {}, { authorization: { getTokens: async context => {
    if (context.operation === 'SUBSCRIBE' && context.trackName && new TextDecoder().decode(context.trackName) === 'timeline'
        && ++timelines === 1) await gate;
    return [catToken(Uint8Array.of(1))];
  } } }, false, true);
  try {
    expect(timelines).toBe(1);
    await f.update({ initData: 'BAUG' });
    release(); await flush(512);
    expect(f.requests.filter(r => r.name === 'timeline')).toHaveLength(1);
    expect(f.requests.filter(r => r.name === 'v')).toHaveLength(2);
    expect(f.errors).toEqual([]); expect(f.player.state).toBe('playing');
  } finally { release(); await f.close(); }
});


it('retains the manually selected identity when rebuilding its changed configuration', async () => {
  const f = await fixture('draft-02', {}, {}, true);
  try {
    await f.player.selectVideoTrack('low'); await flush(256);
    await f.server.acceptSubscribe(f.requests.find(r => r.name === 'low')!.id, 201n);
    const stream = await f.server.openSubgroup(201n, 0n, 0n, { publisherPriority: 128, hasExtensions: true });
    await f.server.sendObject(stream, 0n, Uint8Array.of(0, 0, 0, 1, 0x65), encodeLocHeaders({
      captureTimestamp: 1000000n, videoFrameMarking: { startOfFrame: true, endOfFrame: true, independent: true,
        discardable: false, baseLayerSync: false, temporalId: 0 },
    }, { wireProfile: locWireProfileForDraft(23) }));
    await flush(512); f.player.tick(); await flush(256);
    expect(f.player.selection.video?.name).toBe('low');
    const count = f.configurations.length;
    await f.update({ codec: 'avc1.640032' });
    expect(f.configurations).toHaveLength(count); // The formerly playing identity is now inactive.
    await f.update({ parentName: 'low', initData: 'BAUG' });
    expect(f.requests.filter(r => r.name === 'low')).toHaveLength(2);
    expect(f.requests.filter(r => r.name === 'v')).toHaveLength(1);
    expect(f.configurations.at(-1)?.[0]).toEqual(Uint8Array.of(4, 5, 6));
    expect(f.player.selection.autoQuality).toBe(false);
  } finally { await f.close(); }
});

it.each([{ samplerate: 44100 }, { channelConfig: '1' }])('reconfigures audio metadata independently: %j', async fields => {
  const f = await fixture('draft-02', { role: 'audio', codec: 'opus', samplerate: 48000, channelConfig: '2' }, { disableVideo: true });
  try {
    const count = f.audioConfigurations.length;
    await f.update(fields);
    expect(f.audioConfigurations.length).toBe(count + 1);
    expect(f.audioConfigurations.at(-1)?.slice(1)).toEqual(['opus', fields.samplerate ?? 48000, fields.channelConfig ? 1 : 2]);
  } finally { await f.close(); }
});

it('supersedes replacement authorization when its track becomes excluded', async () => {
  let release!: () => void, subscriptions = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture('draft-02', {}, { authorization: { getTokens: async context => {
    if (context.operation === 'SUBSCRIBE' && context.trackName && new TextDecoder().decode(context.trackName) === 'v'
        && ++subscriptions === 2) await gate;
    return [catToken(Uint8Array.of(1))];
  } } }, true);
  try {
    await f.update({ initData: 'BAUG' }); expect(subscriptions).toBe(2);
    await f.update({ encryptionScheme: 'example' });
    release(); await flush(512);
    expect(f.requests.filter(r => r.name === 'v')).toHaveLength(1);
    expect(f.requests.filter(r => r.name === 'low')).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally { release(); await f.close(); }
});

it.each(['before-timeout', 'during-retry'].flatMap(phase => ['accept', 'exhaust'].map(outcome => ({ phase, outcome }))))(
  'monitors unfinished replacement after pause: $phase / $outcome', async ({ phase, outcome }) => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
    let release!: () => void, subscriptions = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture('draft-02', {}, { connectionTimeoutMs: 20, livenessTimeoutMs: 40, livenessRestartBackoffMs: 5,
      authorization: { getTokens: async context => {
        if (context.operation === 'SUBSCRIBE' && context.trackName
            && new TextDecoder().decode(context.trackName) === 'v' && ++subscriptions === 2) await gate;
        return [catToken(Uint8Array.of(1))];
      } } });
    try {
      await f.update({ initData: 'BAUG' });
      if (phase === 'during-retry') { await vi.advanceTimersByTimeAsync(62); f.player.tick(); await flush(256); }
      f.player.pause();
      const pausedCount = subscriptions;
      await vi.advanceTimersByTimeAsync(200);
      expect(f.player.state).toBe('paused'); expect(subscriptions).toBe(pausedCount);
      f.player.play(); f.player.tick();
      await vi.advanceTimersByTimeAsync(39); expect(subscriptions).toBe(pausedCount);
      await vi.advanceTimersByTimeAsync(8); f.player.tick(); await vi.advanceTimersByTimeAsync(10); await flush(256);
      expect(subscriptions).toBe(pausedCount + 1);
      release(); await flush(512);
      if (outcome === 'accept') {
        await f.server.acceptSubscribe(f.requests.filter(r => r.name === 'v').at(-1)!.id, 201n);
        await flush(256);
        expect(f.player.selection.video?.name).toBe('v'); expect(f.player.state).toBe('playing');
        expect(f.errors).toEqual([]);
      } else {
        await vi.advanceTimersByTimeAsync(200);
        expect(f.player.state).toBe('error');
        expect(f.errors.some(message => message.includes('Media delivery starved'))).toBe(true);
      }
    } finally { release(); await f.close(); }
  });


it('keeps unfinished reselection detection disabled when livenessTimeoutMs is zero', async () => {
  vi.useRealTimers(); vi.useFakeTimers();
  let release!: () => void, subscriptions = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture('draft-02', {}, { connectionTimeoutMs: 20, livenessTimeoutMs: 0,
    authorization: { getTokens: async context => {
      if (context.operation === 'SUBSCRIBE' && context.trackName && new TextDecoder().decode(context.trackName) === 'v'
          && ++subscriptions === 2) await gate;
      return [catToken(Uint8Array.of(1))];
    } } });
  try {
    await f.update({ initData: 'BAUG' }); await vi.advanceTimersByTimeAsync(1000);
    expect(subscriptions).toBe(2);
    f.player.pause(); f.player.play(); await vi.advanceTimersByTimeAsync(1000);
    expect(subscriptions).toBe(2); expect(f.errors).toEqual([]);
  } finally { release(); await f.close(); }
});

it.each([0, 1, 8, 64])('does not accelerate exhaustion when pause races a retry by %i microtasks', async gap => {
  vi.useRealTimers(); vi.useFakeTimers();
  async function run(paused: boolean) {
    let release!: () => void, subscriptions = 0, fatalAt: number | undefined;
    const attempts: number[] = [];
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture('draft-02', {}, { connectionTimeoutMs: 20, livenessTimeoutMs: 40, livenessRestartBackoffMs: 5,
      authorization: { getTokens: async context => {
        if (context.operation === 'SUBSCRIBE' && context.trackName && new TextDecoder().decode(context.trackName) === 'v'
            && ++subscriptions === 2) await gate;
        return [catToken(Uint8Array.of(1))];
      } } });
    const start = performance.now();
    f.player.on('error', event => { if (event.error.severity === 'fatal') fatalAt = performance.now() - start; });
    f.player.on('recovery_action', event => { if (event.action.type === 'track_restart') attempts.push(event.action.attempt); });
    try {
      await f.update({ initData: 'BAUG' }); await vi.advanceTimersByTimeAsync(62); f.player.tick(); await flush(256);
      if (paused) {
        f.player.pause(); for (let i = 0; i < gap; i++) await Promise.resolve(); f.player.play(); f.player.tick();
        const before = subscriptions;
        await vi.advanceTimersByTimeAsync(39); expect(subscriptions).toBe(before);
      }
      await vi.advanceTimersByTimeAsync(paused ? 461 : 500);
      expect(f.player.state).toBe('error'); expect(f.errors.some(message => message.includes('Media delivery starved'))).toBe(true);
      expect(attempts).toEqual([1, 2, 3]); expect(fatalAt).toBeDefined();
      return fatalAt!;
    } finally { release(); await f.close(); }
  }
  const uninterrupted = await run(false), paused = await run(true);
  expect(paused).toBeGreaterThanOrEqual(uninterrupted);
});


it.each(['repeated updates', 'paused refusal'])('keeps replacement refusal in recovery after %s', async mode => {
  vi.useRealTimers(); vi.useFakeTimers();
  let release!: () => void, subscriptions = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture('draft-02', {}, { connectionTimeoutMs: 20, livenessTimeoutMs: 40, livenessRestartBackoffMs: 5,
    authorization: { getTokens: async context => {
      if (context.operation === 'SUBSCRIBE' && context.trackName && new TextDecoder().decode(context.trackName) === 'v'
          && ++subscriptions === 2) await gate;
      return [catToken(Uint8Array.of(1))];
    } } });
  try {
    await f.update({ initData: 'BAUG' });
    if (mode === 'repeated updates') {
      for (let t = 0; t < 40; t++) {
        await vi.advanceTimersByTimeAsync(5); if (t % 2 === 0) f.player.tick();
        if (t >= 14 && t % 6 === 2) { f.player.pause(); await Promise.resolve(); f.player.play(); }
      }
      expect(f.errors.some(message => message.includes('too many REQUEST_UPDATEs'))).toBe(true);
    } else {
      await vi.advanceTimersByTimeAsync(62); f.player.tick(); await flush(256);
      f.player.pause(); await flush(256);
      await f.server.rejectSubscribe(f.requests.filter(r => r.name === 'v').at(-1)!.id, 1n, 'no retry');
      await flush(256);
      expect(f.errors.some(message => message.includes('All media track'))).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(f.errors.some(message => message.includes('Media delivery starved'))).toBe(false);
      f.player.play(); f.player.tick(); await vi.advanceTimersByTimeAsync(39);
      expect(subscriptions).toBe(3);
      await vi.advanceTimersByTimeAsync(80);
      expect(f.errors.some(message => message.includes('publisher refused automatic retry'))).toBe(true);
      expect(subscriptions).toBe(3);
    }
    expect(f.errors.some(message => message.includes('All media track'))).toBe(false);
  } finally { release(); await f.close(); }
});


it.each([false, true].flatMap(paused => [0, 101].map(interval => ({ paused, interval }))))(
  'monitors the first replacement refusal; paused=$paused, retry interval=$interval', async ({ paused, interval }) => {
    vi.useRealTimers(); vi.useFakeTimers();
    const f = await fixture('draft-02', {}, { livenessTimeoutMs: 40, livenessRestartBackoffMs: 5,
      authorization: { getTokens: async () => [catToken(Uint8Array.of(1))] } });
    const attempts: number[] = [];
    f.player.on('recovery_action', e => { if (e.action.type === 'track_restart') attempts.push(e.action.attempt); });
    // The publisher facade defaults to zero; encode a positive interval through the real SDK response path.
    const reject = f.server.session.rejectSubscribe.bind(f.server.session);
    const response = vi.spyOn(f.server.session, 'rejectSubscribe').mockImplementation((...args) => reject(...args).map(action =>
      action.type === 'send_control' && action.message.type === 'REQUEST_ERROR'
        ? { ...action, message: { ...action.message, retryInterval: BigInt(interval) as typeof action.message.retryInterval } } : action));
    try {
      await f.update({ initData: 'BAUG' });
      expect(f.requests.filter(r => r.name === 'v')).toHaveLength(2);
      if (paused) f.player.pause();
      await f.server.rejectSubscribe(f.requests.filter(r => r.name === 'v').at(-1)!.id, 1n, 'replacement unavailable');
      response.mockRestore(); await flush(256);
      if (paused) {
        await vi.advanceTimersByTimeAsync(200);
        expect(attempts).toEqual([]); expect(f.player.state).toBe('paused');
        f.player.play(); f.player.tick();
      }
      await vi.advanceTimersByTimeAsync(39);
      expect(attempts).toEqual([]);
      expect(f.errors.some(message => message.includes('Media delivery starved'))).toBe(false);
      if (interval && !paused) { await vi.advanceTimersByTimeAsync(60); expect(attempts).toEqual([]); }
      await vi.advanceTimersByTimeAsync(15); f.player.tick(); await flush(256);
      if (interval) {
        expect(attempts).toEqual([1]);
        expect(f.requests.filter(r => r.name === 'v')).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(300);
        expect(attempts).toEqual([1, 2, 3]);
      } else {
        expect(attempts).toEqual([]);
        expect(f.requests.filter(r => r.name === 'v')).toHaveLength(2);
        expect(f.errors.some(message => message.includes('publisher refused automatic retry'))).toBe(true);
      }
      expect(f.errors.some(message => message.includes('Media delivery starved'))).toBe(true);
      expect(f.errors.some(message => message.includes('All media track'))).toBe(false);
    } finally { response.mockRestore(); await f.close(); }
  });

it('watches an accepted replacement that never delivers media', async () => {
  vi.useRealTimers(); vi.useFakeTimers();
  const f = await fixture('draft-02', {}, { livenessTimeoutMs: 40, livenessRestartBackoffMs: 5,
      authorization: { getTokens: async () => [catToken(Uint8Array.of(1))] } });
  const attempts: number[] = [];
  f.player.on('recovery_action', e => { if (e.action.type === 'track_restart') attempts.push(e.action.attempt); });
  try {
    await f.update({ initData: 'BAUG' });
    await f.server.acceptSubscribe(f.requests.filter(r => r.name === 'v').at(-1)!.id, 201n); await flush(256);
    expect(f.player.selection.video?.name).toBe('v');
    await vi.advanceTimersByTimeAsync(39); expect(attempts).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(attempts).toEqual([1, 2, 3]);
    expect(f.errors.some(message => message.includes('Media delivery starved'))).toBe(true);
  } finally { await f.close(); }
});
