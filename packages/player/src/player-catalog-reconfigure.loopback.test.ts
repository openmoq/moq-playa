/** Real SDK catalog deltas and adapter configuration; no native playback claim. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MoqtPlayerConfig } from './config.js';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { videoInit } from '../../locmaf/test-support/cmaf.js';
import type { CatalogState } from '@openmoq/msf';
import { MoqtConnection } from '@openmoq/webtransport';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { MoqtPlayer } from './player.js';

beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
afterEach(() => vi.useRealTimers());
const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
async function fixture(version = 'draft-02', initial: Record<string, unknown> = {}, config: Partial<MoqtPlayerConfig> = {}) {
  const { a, b } = createLoopback(), client = new MoqtConnection(23), server = new MoqtConnection(23, { role: 'server' });
  const requests: { id: bigint; name: string }[] = [], configurations: unknown[][] = [], destroyed: number[] = [], errors: string[] = [];
  const audioConfigurations: unknown[][] = [], mediaInitializations: unknown[] = [], mediaDestroyed: number[] = [];
  server.onSubscribe = (id, _ns, name) => { requests.push({ id, name: new TextDecoder().decode(name) }); };
  let serving: Promise<void> | undefined, generation = 0;
  const player = new MoqtPlayer({ url: 'https://updates.invalid/moq', namespace: ['live'], draftVersion: 23,
    catalogBootstrap: 'subscribe', autoQuality: false, livenessTimeoutMs: 0, connectionTimeoutMs: 1000,
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
    codec: 'avc1.640028', bitrate: 1000, framerate: 25, isLive: true, initData: 'AQID', ...initial }] }));
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
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
