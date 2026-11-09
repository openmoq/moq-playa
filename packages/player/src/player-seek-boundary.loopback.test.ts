import { describe, expect, it, vi } from 'vitest';
import { MoqtConnection } from '@openmoq/webtransport';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { MoqtPlayer } from './player.js';
import type { VideoDecoderLike, VideoRendererLike, AudioDecoderLike, AudioOutputLike } from './interfaces.js';

const enc = new TextEncoder(), dec = new TextDecoder();

async function fixture(draft: 18 | 22, audio = false, coverAudio = true, options: {
  namespace?: string; audioNamespace?: string; shadowTimeline?: boolean; timelineBeforeOk?: boolean; catalogVersion?: 1 | '1';
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
    await server.sendObject(timelineStream, 0n, enc.encode(JSON.stringify([[1000, [3, 0], 0], [3000, [4, 0], 0]])));
    await flush(128);
    if (options.timelineBeforeOk) {
      expect(player.seekable).toBe(false);
      releaseTimelineAcceptance!(); await flush(128);
    }
    expect(player.duration).toBe(3000); expect(errors).toEqual([]);
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
    return { player, update, seeking, errors, destroy, unchanged, requests, fetches,
      timelineFormat: () => (player as unknown as { timelineSource: { wireFormat?: string } | null }).timelineSource?.wireFormat,
      // Loopback endpoints settle their own transport.closed promise independently.
      disconnect: async () => { a.close({ closeCode: 0, reason: 'peer disconnected' }); await flush(128); },
    };
  } catch (error) { await destroy(); throw error; }
}

describe.each([18, 22] as const)('seek admission boundary on draft %s', draft => {
  it.each([1, '1'] as const)('retains the declaring catalog representation %s despite normalized version 1', async catalogVersion => {
    const f = await fixture(draft, false, true, { catalogVersion });
    try { expect(f.timelineFormat()).toBe(catalogVersion === 1 ? 'msf-00' : 'msf-01'); }
    finally { await f.destroy(); }
  });

  it.each([NaN, Infinity, -1])('rejects invalid target %s before changing playback or publishing seeking', async target => {
    const f = await fixture(draft);
    try {
      await expect(f.player.seek(target)).rejects.toThrow(/finite|nonnegative|non-negative/i);
      f.unchanged();
      expect(f.player.state).toBe('playing');
    } finally { await f.destroy(); }
  });

  it('rejects a target before the first indexed sample instead of reporting an admitted seek', async () => {
    const f = await fixture(draft);
    try {
      await expect(f.player.seek(500)).rejects.toThrow(/before.*timeline|before.*sample/i);
      f.unchanged();
      expect(f.player.state).toBe('playing');
    } finally { await f.destroy(); }
  });

  it('does not apply a video-only timeline Location to an established audio track', async () => {
    const f = await fixture(draft, true, false);
    try {
      // MSF-00 §7.2 names the tracks covered by a timeline. Equal Group IDs
      // across unrelated tracks do not establish a seek mapping for the audio.
      expect(f.player.seekable).toBe(false);
      await expect(f.player.seek(3500)).rejects.toThrow(/audio.*timeline|timeline.*audio/i);
      f.unchanged();
    } finally { await f.destroy(); }
  });

  it('admits an indexed target for an established video covered by the timeline', async () => {
    const f = await fixture(draft);
    try {
      expect(f.player.seekable).toBe(true);
      await f.player.seek(3500);
      await flush(128);
      expect(f.fetches).toEqual([{ name: 'video', group: 4n, object: 0n }]);
      expect(f.update).not.toHaveBeenCalled();
      expect(f.seeking).toHaveBeenCalledExactlyOnceWith({ type: 'seeking', targetTimeMs: 3500 }); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('uses a shared Location for audio and video when the timeline declares both identities', async () => {
    const f = await fixture(draft, true, true);
    try {
      expect(f.player.seekable).toBe(true);
      await f.player.seek(3500);
      await flush(128);
      expect(f.fetches).toEqual([{ name: 'video', group: 4n, object: 0n }, { name: 'audio', group: 4n, object: 0n }]);
      expect(f.update).not.toHaveBeenCalled();
      expect(f.seeking).toHaveBeenCalledExactlyOnceWith({ type: 'seeking', targetTimeMs: 3500 }); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('rejects a same-named audio track outside the timeline declaring namespace', async () => {
    const f = await fixture(draft, true, true, { audioNamespace: 'other/show' });
    try {
      expect(f.player.seekable).toBe(false);
      await expect(f.player.seek(3500)).rejects.toThrow(/audio.*timeline|timeline.*audio/i);
      f.unchanged();
    } finally { await f.destroy(); }
  });

  it('uses the issued timeline namespace despite a same-named catalog declaration in another namespace', async () => {
    const f = await fixture(draft, true, true, { namespace: 'other/show', shadowTimeline: true });
    try {
      expect(f.requests.filter(request => request.name === 'timeline').map(request => request.namespace)).toEqual([['other', 'show']]);
      expect(f.player.seekable).toBe(true);
      await f.player.seek(3500);
      await flush(128);
      expect(f.fetches).toEqual([{ name: 'video', group: 4n, object: 0n }, { name: 'audio', group: 4n, object: 0n }]);
      expect(f.update).not.toHaveBeenCalled();
      expect(f.seeking).toHaveBeenCalledExactlyOnceWith({ type: 'seeking', targetTimeMs: 3500 }); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('admits timeline data delivered before SUBSCRIBE_OK after the issued alias resolves', async () => {
    const f = await fixture(draft, false, true, { timelineBeforeOk: true });
    try {
      expect(f.player.seekable).toBe(true);
      await f.player.seek(3500);
      await flush(128);
      expect(f.fetches).toEqual([{ name: 'video', group: 4n, object: 0n }]);
      expect(f.update).not.toHaveBeenCalled();
      expect(f.seeking).toHaveBeenCalledExactlyOnceWith({ type: 'seeking', targetTimeMs: 3500 }); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('withdraws admission after disconnect while retaining historical timeline duration', async () => {
    const f = await fixture(draft);
    try {
      expect(f.player.seekable).toBe(true);
      await f.disconnect();
      expect(f.player.seekable).toBe(false);
      expect(f.player.duration).toBe(3000);
      await expect(f.player.seek(3500)).rejects.toThrow(/declaring identity.*unavailable/i);
      f.unchanged();
    } finally { await f.destroy(); }
  });
});
