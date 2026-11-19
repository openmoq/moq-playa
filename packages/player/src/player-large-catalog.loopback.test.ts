/** Real SDK catalog deltas and adapter configuration; no native playback claim. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MoqtPlayerConfig } from './config.js';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import type { CatalogState } from '@openmoq/msf';
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
  if (requests.some(r=>r.name==='v')) await server.acceptSubscribe(requests.find(r => r.name === 'v')!.id, 200n); await flush(256); if (requests.some(r=>r.name==='v')) player.play();
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


it.each([1, 'draft-01'])('accepts a large uncompressed %s independent catalog', async version => { const f=await fixture(version as string, {label:'x'.repeat(4*1024*1024)}); try {expect(f.errors).toEqual([]);expect(f.requests.some(r=>r.name==='v')).toBe(true);}finally{await f.close();} });
