/** Live LOC frame-path fixture (real SDK loopback, drafts 14/16/18/22; default 18): two video renditions in one altGroup plus audio; fake
 *  decoders/renderer; objects sent with explicit group ids; SUBSCRIBE parameters recorded as the server session decoded them. */
import { vi } from 'vitest';
import { MoqtConnection } from '@openmoq/webtransport';
import { varint, type Parameters as MessageParameters } from '@openmoq/transport';
import { codecDescriptionFromInit } from '@openmoq/locmaf';
import { videoInit } from '../../locmaf/test-support/cmaf.js';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { MoqtPlayer } from '../src/player.js';
import type { MoqtPlayerConfig } from '../src/config.js';
import type { VideoDecoderLike, AudioDecoderLike, VideoRendererLike, AudioOutputLike } from '../src/interfaces.js';

export async function liveLocFixture(config: Partial<MoqtPlayerConfig> = {}, draft: 14 | 16 | 18 | 22 = 18) {
  const { a, b } = createLoopback(), client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const requests: Array<{ id: bigint; name: string; parameters?: MessageParameters }> = [];
  const dec = new TextDecoder();
  server.onSubscribe = (id, _ns, name, parameters) => { requests.push({ id, name: dec.decode(name), ...(parameters ? { parameters } : {}) }); };
  const errors: string[] = []; server.onError = e => { errors.push(String(e)); };
  const video: VideoDecoderLike = { configure: vi.fn(), flush: async () => {}, reset() {}, destroy() {}, queueDepth: 0, onFrame: null, onError: null,
    decode: vi.fn((chunk, time, input) => { video.onFrame?.({ timestamp: chunk.timestamp, close() {} }, time, null, input); }) };
  const audio: AudioDecoderLike = { configure: vi.fn(), flush: async () => {}, reset() {}, destroy() {}, queueDepth: 0, onData: null, onError: null,
    decode: vi.fn((chunk, time, input) => { audio.onData?.({ timestamp: chunk.timestamp, close() {} }, time, input); }) };
  const renderer: VideoRendererLike = { flush() {}, destroy() {}, onFirstFrame: null, onFrameRendered: null, onStall: null, enqueue: vi.fn() };
  const output: AudioOutputLike = { flush() {}, destroy() {}, currentPlayoutTimeUs: 0, schedule: vi.fn() };
  let serving: Promise<void> | undefined, clock = 1_000_000;
  const player = new MoqtPlayer({ url: 'https://relay.example/moq', namespace: ['live'], draftVersion: draft, maxBufferDepth: 2048, clock: { now: () => clock },
    createConnection: () => client, createTransport: async () => { serving = server.connect(b, draft === 14 || draft === 16 ? { maxRequestId: varint(1000n) } : {}); void serving.catch(() => {}); return a; },
    createVideoDecoder: () => video, createAudioDecoder: () => audio, createRenderer: () => renderer, createAudioOutput: () => output,
    autoQuality: false, selection: { videoTrack: { name: 'v' } },
    catalog: { tracks: [
      { name: 'v', packaging: 'loc', role: 'video', isLive: true, codec: 'avc1.4D4028', altGroup: 7, bitrate: 100 },
      { name: 'v2', packaging: 'loc', role: 'video', isLive: true, codec: 'avc1.640028', altGroup: 7, bitrate: 200, initData: Buffer.from(codecDescriptionFromInit(videoInit())!).toString('base64') },
      { name: 'a', packaging: 'loc', role: 'audio', isLive: true, codec: 'opus', samplerate: 48000, channelConfig: '2' },
    ] },
    ...config,
  });
  player.on('error', e => { errors.push(e.error.message); });
  const largestByName = new Map<string, { group: bigint; object: bigint }>();
  if (draft !== 16) server.setLargestLocationProvider(id => {
    const name = requests.find(request => request.id === id)?.name;
    return name === undefined ? null : largestByName.get(name) ?? null;
  });
  const update = vi.spyOn(client, 'requestUpdate');
  await player.load(); await flush(128);
  const aliases: Record<string, bigint> = { v: 77n, a: 78n, v2: 79n };
  for (const request of requests) if (request.name !== 'v2') await server.acceptSubscribe(request.id, aliases[request.name]!);
  await flush(128);
  async function send(name: 'v' | 'a' | 'v2', group: bigint, objectId = 0n) {
    const type = name === 'a' ? 'audio' : 'video';
    const extensions = encodeLocHeaders({ captureTimestamp: BigInt(clock) + objectId * 20_000n,
      ...(type === 'video' ? { videoFrameMarking: { startOfFrame: true, endOfFrame: true, independent: objectId === 0n, discardable: false, baseLayerSync: false, temporalId: 0 } } : {}) }, { wireProfile: locWireProfileForDraft(draft) });
    const payload = type === 'video' ? Uint8Array.of(0, 0, 0, 1, objectId === 0n ? 0x65 : 0x41) : Uint8Array.of(0x48, 0);
    const largest = largestByName.get(name);
    if (!largest || group > largest.group || (group === largest.group && objectId > largest.object)) {
      largestByName.set(name, { group, object: objectId });
    }
    const stream = await server.openSubgroup(aliases[name]!, group, 0n, { publisherPriority: 128, hasExtensions: true });
    await server.sendObject(stream, objectId, payload, extensions); await server.closeSubgroup(stream);
    await flush(128);
  }
  function tick(n = 8) { for (let i = 0; i < n; i++) { clock += 20_000; player.tick(); } }
  return { a, b, draft, player, client, server, requests, errors, update, video, audio, send, tick,
    requestOf: (name: string) => requests.find(r => r.name === name),
    async acceptAlternative() { await flush(128); const next = requests.find(r => r.name === 'v2'); if (!next) throw new Error('no v2 request'); await server.acceptSubscribe(next.id, 79n); await flush(128); },
    currentVideoGroup: () => (player as unknown as { videoPipeline: { currentGroupId: bigint } | null }).videoPipeline?.currentGroupId ?? null,
    async close() { await player.destroy(); await server.close(); await serving?.catch(() => {}); } };
}
