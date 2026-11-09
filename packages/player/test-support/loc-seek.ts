import { expect, vi } from 'vitest';
import { MoqtConnection } from '@openmoq/webtransport';
import { varint, type ControlMessage } from '@openmoq/transport';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { CanvasRenderer } from '../../browser/src/canvas-renderer.js';
import { MoqtPlayer } from '../src/player.js';
import type { VideoDecoderLike, VideoRendererLike, AudioDecoderLike, AudioOutputLike, AudioSourcePosition, AudioScheduleObserver } from '../src/interfaces.js';
import type { MoqtPlayerConfig } from '../src/config.js';
import { videoInit, audioInit } from '../../locmaf/test-support/cmaf.js';

const enc = new TextEncoder(), dec = new TextDecoder();

export async function locSeekFixture(draft: 14 | 16 | 18 | 22, audio = false, coverAudio = true, options: {
  configuredDraft?: 14 | 16 | 18 | 22 | null; autoNegotiation?: boolean;
  frameVideo?: boolean; frameAudio?: boolean; frameAlternative?: boolean; reorderVideoOutput?: boolean;
  isLive?: boolean; namespace?: string; audioNamespace?: string; shadowTimeline?: boolean; timelineBeforeOk?: boolean; catalogVersion?: 1 | '1';
  producingOutput?: boolean; audioOnly?: boolean; alternative?: boolean; singleTimelineEntry?: boolean; beforeFactoryReturn?: () => void; connectionTimeoutMs?: number;
  objectTransform?: MoqtPlayerConfig['objectTransform'];
  commandTransform?: MoqtPlayerConfig['commandTransform'];
  timeline?: readonly (readonly [number, readonly [number, number], number])[];
} = {}) {
  const { a, b } = createLoopback();
  if (options.autoNegotiation) Reflect.set(a, 'protocol', `moqt-${draft}`);
  const client = new MoqtConnection(options.autoNegotiation ? undefined : draft), server = new MoqtConnection(draft, { role: 'server' });
  const wire = vi.spyOn(server.session, 'handleControlMessage');
  const joins: Array<{ id: bigint; message: Extract<ControlMessage, { type: 'FETCH' }> }> = [];
  const published = new Map<string, { group: bigint; object: bigint }>();
  const requests: Array<{ id: bigint; name: string; namespace: string[] }> = [];
  const streams: bigint[] = [];
  const errors: string[] = [];
  const fetches: Array<{ namespace: string[]; name: string; group: bigint; object: bigint }> = [];
  const fetchIds: bigint[] = [];
  let now = 100_000;
  let clockHook: (() => void) | undefined;
  server.onFetch = (id, message) => {
    if (message.fetch.fetchType !== 1) {
      if (message.fetch.fetchType !== 3) throw new Error('Expected standalone or absolute Joining FETCH');
      joins.push({ id, message }); return;
    }
    fetchIds.push(id);
    const request = message.fetch;
    fetches.push({ namespace: request.trackNamespace.map(field => dec.decode(field)), name: dec.decode(request.trackName),
      group: request.startLocation.group, object: request.startLocation.object });
  };
  const decoder: VideoDecoderLike = { supportsOutputTiming: true, configure: vi.fn(), decode: vi.fn(),
    flush: async () => {}, reset: vi.fn(), destroy() {}, queueDepth: 0, onFrame: null, onError: null };
  const renderer: VideoRendererLike = { enqueue: vi.fn(), flush: vi.fn(), destroy() {},
    onFirstFrame: null, onFrameRendered: null, onStall: null };
  const audioDecoder: AudioDecoderLike = { supportsOutputTiming: true, configure: vi.fn(), decode: vi.fn(), flush: async () => {}, reset: vi.fn(), destroy: vi.fn(), queueDepth: 0, onData: null, onError: null };
  const audioOutput: AudioOutputLike = { supportsOutputTiming: true, schedule: vi.fn(), flush: vi.fn(), destroy: vi.fn(), observeSchedules: () => () => {}, sampleSourcePosition: () => null, currentPlayoutTimeUs: 0 };
  const audioOutputs: Array<{ decoder: AudioDecoderLike; output: AudioOutputLike; frames: Array<{ close: ReturnType<typeof vi.fn> }>; head: { value: AudioSourcePosition | null } }> = [];
  const outputs: Array<{ decoder: VideoDecoderLike; renderer: VideoRendererLike; draw: ReturnType<typeof vi.fn>; frames: Array<{ timestamp: number; close: ReturnType<typeof vi.fn> }> }> = [];

  server.onSubscribe = (id, ns, name) => {
    requests.push({ id, name: dec.decode(name), namespace: ns.map(field => dec.decode(field)) });
  };
  // Resume acknowledgements need a current publisher head (draft18 §5.1).
  // Catalog and timeline each publish exactly g0/o0 in this fixture.
  server.setLargestLocationProvider(id => {
    const name = requests.find(request => request.id === id)?.name;
    return name === 'catalog' || name === 'timeline' ? { group: 0n, object: 0n } : published.get(name ?? '') ?? null;
  });
  server.onError = error => { errors.push(error.message); };
  const serverConnected = server.connect(b, draft < 18 ? { maxRequestId: varint(100n) } : {});
  void serverConnected.catch(error => errors.push(String(error)));
  const player = new MoqtPlayer({
    url: 'https://seek.example/moq', namespace: ['live', 'show'],
    ...(options.configuredDraft === null ? {} : { draftVersion: options.configuredDraft ?? draft }),
    ...(options.frameVideo || options.frameAudio || options.frameAlternative ? { locmafDecoding: 'frame' as const } : {}),
    clock: { now: () => { const hook = clockHook; clockHook = undefined; hook?.(); return now; } },
    ...(options.alternative ? { selection: { videoTrack: { name: 'video' } } } : {}),
    catalogBootstrap: 'subscribe', disableAudio: !audio, disableVideo: options.audioOnly === true, logLevel: 'none',
    ...(options.connectionTimeoutMs === undefined ? {} : { connectionTimeoutMs: options.connectionTimeoutMs }),
    createConnection: () => client, createTransport: async () => a,
    ...(options.objectTransform ? { objectTransform: options.objectTransform } : {}),
    ...(options.commandTransform ? { commandTransform: options.commandTransform } : {}),
    createVideoDecoder: () => decoder, createRenderer: () => renderer,
    createAudioDecoder: () => audioDecoder, createAudioOutput: () => audioOutput,
    createFrameOutput: ({ clock, audio: needsAudio, video: needsVideo }) => {
      const freshDecoder: VideoDecoderLike = { ...decoder, configure: vi.fn(), decode: vi.fn(), reset: vi.fn(), destroy: vi.fn(), onFrame: null, onError: null };
      const draw = vi.fn(), frames: Array<{ timestamp: number; close: ReturnType<typeof vi.fn> }> = [];
      const freshRenderer: VideoRendererLike = options.producingOutput
        ? new CanvasRenderer({ getContext: () => ({ drawImage: draw, canvas: { width: 640, height: 360 } }) } as unknown as HTMLCanvasElement, { clock })
        : { ...renderer, supportsOutputTiming: true, enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(), observeFrames: () => () => {} };
      if (options.producingOutput) {
        const pending: Array<{ timestamp: number; emit: () => void }> = [];
        freshDecoder.decode = vi.fn((chunk, time, input, context) => {
          const emit = () => {
            const frame = { timestamp: chunk.timestamp, close: vi.fn() }; frames.push(frame);
            freshDecoder.onFrame?.(frame, time, chunk.sourceTimestamp, input, context);
          };
          if (options.reorderVideoOutput) pending.push({ timestamp: chunk.timestamp, emit });
          else emit();
        });
        if (options.reorderVideoOutput) {
          // WebCodecs §4.6 requires VideoDecoder output in presentation order.
          freshDecoder.flush = async () => { for (const output of pending.splice(0).sort((a, b) => a.timestamp - b.timestamp)) output.emit(); };
          freshDecoder.reset = vi.fn(() => { pending.length = 0; });
          freshDecoder.destroy = vi.fn(() => { pending.length = 0; });
        }
      }
      if (needsVideo) outputs.push({ decoder: freshDecoder, renderer: freshRenderer, draw, frames });
      const freshAudio: AudioDecoderLike = { ...audioDecoder, configure: vi.fn(), decode: vi.fn(), reset: vi.fn(), destroy: vi.fn(), onData: null, onError: null };
      const head: { value: AudioSourcePosition | null } = { value: null };
      const schedules = new Set<AudioScheduleObserver>();
      const freshOutput: AudioOutputLike = { ...audioOutput,
        schedule: vi.fn((_data, _time, token) => { if (token) for (const observe of [...schedules]) observe({ token, state: 'scheduled', reason: null }); }),
        observeSchedules: observe => { schedules.add(observe); return () => { schedules.delete(observe); }; },
        flush: vi.fn(), destroy: vi.fn(), sampleSourcePosition: () => head.value };
      const pcm: Array<{ close: ReturnType<typeof vi.fn> }> = [];
      if (options.producingOutput) freshAudio.decode = vi.fn((chunk, time, input, context) => {
        const data = { timestamp: chunk.timestamp, numberOfFrames: 9600, numberOfChannels: 2, sampleRate: 48000, close: vi.fn() };
        pcm.push(data); freshAudio.onData?.(data, time, input, context ? { context, sourceOffsetUs: 0 } : undefined);
      });
      if (needsAudio) audioOutputs.push({ decoder: freshAudio, output: freshOutput, frames: pcm, head });
      options.beforeFactoryReturn?.();
      return { ...(needsVideo ? { videoDecoder: freshDecoder, renderer: freshRenderer } : {}), ...(needsAudio ? { audioDecoder: freshAudio, audioOutput: freshOutput } : {}) };
    },
  });
  const update = vi.spyOn(client, 'requestUpdate');
  const seeking = vi.fn(), seeked = vi.fn(); player.on('seeking', seeking); player.on('seeked', seeked);
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
    await server.sendObject(stream, 0n, enc.encode(JSON.stringify({ version: options.catalogVersion ?? (options.frameVideo || options.frameAudio || options.frameAlternative ? '1' : 1),
      ...(options.frameVideo || options.frameAudio || options.frameAlternative ? { initDataList: [
        ...(options.frameVideo || options.frameAlternative ? [{ id: 'video-init', type: 'inline', data: Buffer.from(videoInit()).toString('base64') }] : []),
        ...(options.frameAudio ? [{ id: 'audio-init', type: 'inline', data: Buffer.from(audioInit()).toString('base64') }] : []),
      ] } : {}), tracks: [
      ...(options.audioOnly ? [] : [{ name: 'video', namespace: options.namespace, packaging: options.frameVideo ? 'locmaf' : 'loc',
        ...(options.frameVideo ? { initRef: 'video-init', locmafVersion: '0.3' } : {}), role: 'video', isLive: options.isLive ?? false, renderGroup: 1, ...(options.alternative ? { altGroup: 1 } : {}),
        codec: 'avc1.640028', width: 640, height: 360, bitrate: 500000 }]),
      ...(options.alternative ? [{ name: 'alternate-video', packaging: options.frameAlternative ? 'locmaf' : 'loc',
        ...(options.frameAlternative ? { initRef: 'video-init', locmafVersion: '0.3' } : {}), role: 'video', isLive: options.isLive ?? false, renderGroup: 1, altGroup: 1,
        codec: 'avc1.640028', width: 640, height: 360, bitrate: 100000 }] : []),
      ...(audio ? [{ name: 'audio', namespace: options.audioNamespace ?? options.namespace,
        packaging: options.frameAudio ? 'locmaf' : 'loc', ...(options.frameAudio ? { initRef: 'audio-init', locmafVersion: '0.3' } : {}),
        role: 'audio', isLive: options.isLive ?? false, renderGroup: 1,
        codec: options.frameAudio ? 'mp4a.40.2' : 'opus', samplerate: 48000, channelConfig: '2', bitrate: 32000 }] : []),
      ...(options.shadowTimeline ? [{ name: 'timeline', namespace: 'live/show',
        packaging: 'mediatimeline', isLive: options.isLive ?? false, mimeType: 'application/json', depends: ['video', 'audio'] }] : []),
      { name: 'timeline', namespace: options.namespace, packaging: 'mediatimeline', isLive: options.isLive ?? false, mimeType: 'application/json',
        depends: options.audioOnly ? ['audio'] : audio && coverAudio ? ['video', 'audio'] : options.alternative ? ['video', 'alternate-video'] : ['video'] },
    ] })));
    await flush(256);
    let releaseTimelineAcceptance: (() => void) | undefined;
    for (const [name, alias] of [['video', 200n], ['audio', 201n], ['timeline', 300n]] as const) {
      if (name === 'audio' && !audio || name === 'video' && options.audioOnly) continue;
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
    const timelinePipe = b.uniOut.at(-1)!;
    const entries = options.timeline ?? (options.singleTimelineEntry ? [[1000, [3, 0], 0]] : [[1000, [3, 0], 0], [3000, [4, 0], 0]]);
    await server.sendObject(timelineStream, 0n, enc.encode(JSON.stringify(entries)));
    let timelineObjectId = 0n;
    await flush(128);
    if (options.timelineBeforeOk) {
      expect(player.seekable).toBe(false);
      releaseTimelineAcceptance!(); await flush(128);
    }
    expect(player.duration).toBe(entries.at(-1)?.[0]); expect(errors).toEqual([]);
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
    return { draft, player, client, server, update, seeking, seeked, decoder, renderer, errors, destroy, unchanged, requests, fetches, fetchIds, outputs, audioOutputs, joins, wire, a, b,
      publishHead: (name: string, value: { group: bigint; object: bigint }) => { published.set(name, { ...value }); },
      setClockHook: (hook: () => void) => { clockHook = hook; },
      setNow: (value: number) => { now = value; },
      advance: (value: number) => { now = value; player.tick(); for (const output of outputs) output.renderer.renderTick?.(now); },
      updateTimeline: async (entries: readonly (readonly [number, readonly [number, number], number])[]) => {
        await server.sendObject(timelineStream, ++timelineObjectId, enc.encode(JSON.stringify(entries))); await flush(256);
      },
      holdTimelineUpdate: async (entries: readonly (readonly [number, readonly [number, number], number])[]) => {
        timelinePipe.faults.hold = true;
        await server.sendObject(timelineStream, ++timelineObjectId, enc.encode(JSON.stringify(entries)));
        return async () => { timelinePipe.releaseHeld(); await flush(256); };
      },
      timelineFormat: () => (player as unknown as { timelineSource: { wireFormat?: string } | null }).timelineSource?.wireFormat,
      // Loopback endpoints settle their own transport.closed promise independently.
      disconnect: async () => { a.close({ closeCode: 0, reason: 'peer disconnected' }); await flush(128); },
    };
  } catch (error) { await destroy(); throw error; }
}
