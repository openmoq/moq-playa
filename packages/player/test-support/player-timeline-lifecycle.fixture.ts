import { expect, vi } from 'vitest';
import { MoqtConnection } from '@openmoq/webtransport';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { MoqtPlayer } from '../src/player.js';
import type { VideoDecoderLike, VideoRendererLike, AudioDecoderLike, AudioOutputLike } from '../src/interfaces.js';

const enc = new TextEncoder(), dec = new TextDecoder();

export async function fixture(draft: 18 | 22, audio = false, coverAudio = true, options: {
  namespace?: string; audioNamespace?: string; shadowTimeline?: boolean; timelineBeforeOk?: boolean; catalogVersion?: 1 | '1'; skipInitialTimeline?: boolean;
} = {}) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const requests: Array<{ id: bigint; name: string; namespace: string[] }> = [];
  const streams: bigint[] = [];
  const errors: string[] = [];
  const fetches: Array<{ name: string; group: bigint; object: bigint }> = [];
  server.onFetch = (_id, message) => {
    if (message.fetch.fetchType !== 1) throw new Error('Expected standalone history');
    fetches.push({ name: dec.decode(message.fetch.trackName), group: message.fetch.startLocation.group, object: message.fetch.startLocation.object });
  };
  const videoDecoder = (): VideoDecoderLike => ({ supportsOutputTiming: true, configure() {}, decode() {}, reset() {}, destroy() {}, flush: async () => {}, queueDepth: 0, onFrame: null, onError: null });
  const renderer = (): VideoRendererLike => ({ supportsOutputTiming: true, enqueue() {}, flush() {}, destroy() {}, observeFrames: () => () => {}, onFirstFrame: null, onFrameRendered: null, onStall: null });
  const audioDecoder = (): AudioDecoderLike => ({ supportsOutputTiming: true, configure() {}, decode() {}, reset() {}, destroy() {}, flush: async () => {}, queueDepth: 0, onData: null, onError: null });
  const audioOutput = (): AudioOutputLike => ({ supportsOutputTiming: true, schedule() {}, flush() {}, destroy() {}, observeSchedules: () => () => {}, sampleSourcePosition: () => null, currentPlayoutTimeUs: 0 });
  server.onSubscribe = (id, ns, name) => {
    requests.push({ id, name: dec.decode(name), namespace: ns.map(field => dec.decode(field)) });
  };
  server.onError = error => { errors.push(error.message); };
  const serverConnected = server.connect(b, {});
  void serverConnected.catch(error => errors.push(String(error)));
  const player = new MoqtPlayer({
    url: 'https://seek.example/moq', namespace: ['live', 'show'], draftVersion: draft,
    catalogBootstrap: 'subscribe', disableAudio: !audio, logLevel: 'none',
    createConnection: () => client, createTransport: async () => a,
    createVideoDecoder: videoDecoder, createRenderer: renderer, createAudioDecoder: audioDecoder, createAudioOutput: audioOutput,
    createFrameOutput: ({ video, audio }) => ({ ...(video ? { videoDecoder: videoDecoder(), renderer: renderer() } : {}),
      ...(audio ? { audioDecoder: audioDecoder(), audioOutput: audioOutput() } : {}) }),
  });
  const update = vi.spyOn(client, 'requestUpdate');
  const seeking = vi.fn(); player.on('seeking', seeking);
  player.on('error', event => { errors.push(event.error.message); });
  const destroy = async () => {
    for (const id of streams) await server.closeSubgroup(id);
    await player.destroy(); await server.close(); await serverConnected;
  };
  try {
    await player.load(); await flush(128);
    const catalog = requests.find(request => request.name === 'catalog')!;
    expect(catalog).toBeDefined();
    await server.acceptSubscribe(catalog.id, 100n); await flush(64);
    const stream = await server.openSubgroup(100n, 0n, 0n, { publisherPriority: 128 }); streams.push(stream);
    await server.sendObject(stream, 0n, enc.encode(JSON.stringify({ version: options.catalogVersion ?? 1, tracks: [
      { name: 'video', namespace: options.namespace, packaging: 'loc', role: 'video', isLive: false, renderGroup: 1,
        codec: 'av01.0.08M.10', width: 640, height: 360, bitrate: 500000 },
      ...(audio ? [{ name: 'audio', namespace: options.audioNamespace ?? options.namespace,
        packaging: 'loc', role: 'audio', isLive: false, renderGroup: 1,
        codec: 'opus', samplerate: 48000, channelConfig: '2', bitrate: 32000 }] : []),
      ...(options.shadowTimeline ? [{ name: 'timeline', namespace: 'live/show',
        packaging: 'mediatimeline', isLive: false, mimeType: 'application/json', depends: ['video', 'audio'] }] : []),
      { name: 'timeline', namespace: options.namespace, packaging: 'mediatimeline', isLive: false, mimeType: 'application/json',
        depends: audio && coverAudio ? ['video', 'audio'] : ['video'] },
    ] })));
    await flush(256);
    let releaseTimelineAcceptance: (() => void) | undefined;
    for (const [name, alias] of [['video', 200n], ['audio', 201n], ['timeline', 300n]] as const) {
      if (name === 'audio' && !audio) continue;
      const request = requests.find(request => request.name === name)!; expect(request).toBeDefined();
      if (name === 'timeline' && options.timelineBeforeOk) {
        // Accept at the publisher, but hold its real response bytes so media
        // reaches the subscriber before SUBSCRIBE_OK supplies the alias.
        const response = a.bidiOut[requests.indexOf(request)]!.in;
        response.faults.hold = true;
        releaseTimelineAcceptance = () => response.releaseHeld();
      }
      await server.acceptSubscribe(request.id, alias); await flush(128);
    }
    const timelineStream = await server.openSubgroup(300n, 0n, 0n, { publisherPriority: 128 }); streams.push(timelineStream);
    if (!options.skipInitialTimeline) await server.sendObject(timelineStream, 0n, enc.encode(JSON.stringify([[1000, [3, 0], 0], [3000, [4, 0], 0]])));
    await flush(128);
    if (options.timelineBeforeOk) {
      expect(player.seekable).toBe(false);
      releaseTimelineAcceptance!(); await flush(128);
    }
    if (!options.skipInitialTimeline) expect(player.duration).toBe(3000); expect(errors).toEqual([]);
    player.play(); update.mockClear();
    const pipelines = player as unknown as {
      videoPipeline: { reset(): void } | null; audioPipeline: { reset(): void } | null;
      resetMediaClock(): void;
    };
    const reset = vi.spyOn(pipelines, 'resetMediaClock');
    const videoReset = pipelines.videoPipeline && vi.spyOn(pipelines.videoPipeline, 'reset');
    const audioReset = pipelines.audioPipeline && vi.spyOn(pipelines.audioPipeline, 'reset');
    const unchanged = () => {
      expect(update).not.toHaveBeenCalled(); expect(seeking).not.toHaveBeenCalled();
      expect(reset).not.toHaveBeenCalled();
      if (videoReset) expect(videoReset).not.toHaveBeenCalled();
      if (audioReset) expect(audioReset).not.toHaveBeenCalled();
    };
    return { player, client, server, transport: a, update, seeking, errors, destroy, unchanged, requests, fetches,
      sendTimeline: async () => { await server.sendObject(timelineStream, 1n, enc.encode(JSON.stringify([[5000, [5, 0], 0]]))); await flush(128); },
      timelineFormat: () => (player as unknown as { timelineSource: { wireFormat?: string } | null }).timelineSource?.wireFormat,
      // Loopback endpoints settle their own transport.closed promise independently.
      disconnect: async () => { a.close({ closeCode: 0, reason: 'peer disconnected' }); await flush(128); },
    };
  } catch (error) { await destroy(); throw error; }
}
