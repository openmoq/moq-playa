/**
 * Real MoQT SUBSCRIBE/object delivery into the LOC pipeline. Output witnesses
 * record typed decoder/enqueue/schedule callbacks, not native PCM or atomic
 * MSE splices. Enqueue acceptance is not a draw or presentation observation.
 * Only the raw target transform is held; old routes keep running.
 *
 * Public selectMedia API, with one canonical adopted reference token and
 * independent video/audio raw maps.
 */
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { codecDescriptionFromInit } from '@openmoq/locmaf';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { videoInit } from '../../locmaf/test-support/cmaf.js';
import { MoqtPlayer } from '../src/player.js';
import type { AudioDecoderLike, AudioOutputLike, VideoDecoderLike, VideoRendererLike } from '../src/interfaces.js';
import type { MediaSelectionSnapshot } from '../src/player-selection-state.js';
import type { PlayerError } from '../src/errors.js';
import { audioPeer, gate, type AudioDraft } from './audio-selection.js';

export const mediaRefs = {
  catalog: { namespace: ['live', 'program-selection'], name: 'catalog' },
  oldVideo: { namespace: ['show', 'old', 'picture'], name: 'video' },
  oldAudio: { namespace: ['show', 'old', 'sound'], name: 'audio' },
  nextVideo: { namespace: ['show', 'next', 'picture'], name: 'video' },
  nextAudio: { namespace: ['show', 'next', 'sound'], name: 'audio' },
  viewVideo: { namespace: ['show', 'old', 'alternate-picture'], name: 'video' },
} as const;
export type MediaKey = Exclude<keyof typeof mediaRefs, 'catalog'>;
export const mediaTracks = {
  oldVideo: { media: 'video', renderGroup: 1, altGroup: 11, alias: 200n, group: 800n, scale: 90_000n, marker: 11 },
  oldAudio: { media: 'audio', renderGroup: 1, altGroup: 21, alias: 201n, group: 70n, scale: 48_000n, marker: 21 },
  nextVideo: { media: 'video', renderGroup: 2, altGroup: 31, alias: 300n, group: 3n, scale: 60_000n, marker: 31 },
  nextAudio: { media: 'audio', renderGroup: 2, altGroup: 41, alias: 301n, group: 901n, scale: 96_000n, marker: 41 },
  viewVideo: { media: 'video', renderGroup: 1, altGroup: 12, alias: 302n, group: 1700n, scale: 45_000n, marker: 51 },
} as const;

export interface MediaFixtureOptions {
  readonly videoOnly?: boolean;
  readonly unsupportedOutputTiming?: boolean;
  readonly automaticVideo?: boolean;
  readonly changedTargetVideoInit?: boolean;
  readonly targetAudioConfig?: Uint8Array;
  readonly refuseTargetAudioConfig?: boolean;
}
export interface MediaOutputPoint {
  readonly key: MediaKey;
  readonly rawTimestampUs: number;
  readonly renderTimeUs: number;
}

export type MediaDecoderEvent = { readonly media: 'video' | 'audio'; readonly decoder: number } & (
  | { readonly kind: 'configure'; readonly bytes: Uint8Array; readonly codec: string }
  | { readonly kind: 'reset' | 'destroy' }
);

export async function mediaSelectionFixture(draft: AudioDraft = 18, options: MediaFixtureOptions = {}) {
  const peers = [audioPeer(draft), audioPeer(draft)];
  const wire = peers[0]!;
  const errors: PlayerError[] = [], selections: MediaSelectionSnapshot[] = [];
  const enqueuedVideo: MediaOutputPoint[] = [], scheduledAudio: MediaOutputPoint[] = [];
  const decodedVideo: MediaOutputPoint[] = [], decodedAudio: MediaOutputPoint[] = [];
  const decoderEvents: MediaDecoderEvent[] = [];
  const transportCalls: string[] = [];
  const holds = new Map<MediaKey, ReturnType<typeof gate>>();
  let now = 10_000_000;
  const clock = { now: () => now };
  const keys = Object.keys(mediaTracks) as MediaKey[];
  const keyForMarker = (marker: number): MediaKey => {
    const key = keys.find(key => mediaTracks[key].marker === marker);
    if (!key) throw new Error(`Unknown media payload marker ${marker}`);
    return key;
  };
  const point = (value: unknown, renderTimeUs: number): MediaOutputPoint => {
    if (typeof value !== 'object' || value === null || !('timestamp' in value) || typeof value.timestamp !== 'number'
      || !('marker' in value) || typeof value.marker !== 'number') throw new Error('Output has no decoded payload identity');
    return { key: keyForMarker(value.marker), rawTimestampUs: value.timestamp, renderTimeUs };
  };
  let decoderCount = 0;
  function makeVideo(): VideoDecoderLike {
    const decoder = ++decoderCount;
    const videoDecoder: VideoDecoderLike = {
      ...(options.unsupportedOutputTiming ? {} : { supportsOutputTiming: true }),
      configure(bytes, codec) { decoderEvents.push({ media: 'video', decoder, kind: 'configure', bytes: bytes.slice(), codec }); },
      decode(chunk, renderTimeUs, input, renderTiming) {
        const marker = chunk.data[5];
        if (marker === undefined) throw new Error('Video payload has no marker');
        const frame = { timestamp: chunk.timestamp, marker, close() {} };
        decodedVideo.push(point(frame, renderTimeUs)); videoDecoder.onFrame?.(frame, renderTimeUs, null, input, renderTiming);
      },
      flush: async () => {},
      reset() { decoderEvents.push({ media: 'video', decoder, kind: 'reset' }); },
      destroy() { decoderEvents.push({ media: 'video', decoder, kind: 'destroy' }); },
      queueDepth: 0, onFrame: null, onError: null,
    };
    return videoDecoder;
  }
  function makeAudio(): AudioDecoderLike {
    const decoder = ++decoderCount;
    const audioDecoder: AudioDecoderLike = {
      configure(bytes, codec) {
        decoderEvents.push({ media: 'audio', decoder, kind: 'configure', bytes: bytes.slice(), codec });
        const target = options.targetAudioConfig;
        if (options.refuseTargetAudioConfig && target && bytes.length === target.length
            && bytes.every((value, index) => value === target[index])) {
          throw new Error('Target audio decoder configuration refused');
        }
      },
      decode(chunk, renderTimeUs, input) {
        const marker = chunk.data[1];
        if (marker === undefined) throw new Error('Audio payload has no marker');
        const data = { timestamp: chunk.timestamp, marker, close() {} };
        decodedAudio.push(point(data, renderTimeUs)); audioDecoder.onData?.(data, renderTimeUs, input);
      },
      flush: async () => {},
      reset() { decoderEvents.push({ media: 'audio', decoder, kind: 'reset' }); },
      destroy() { decoderEvents.push({ media: 'audio', decoder, kind: 'destroy' }); },
      queueDepth: 0, onData: null, onError: null,
    };
    return audioDecoder;
  }
  const renderer: VideoRendererLike = {
    enqueue(frame, renderTimeUs) { enqueuedVideo.push(point(frame, renderTimeUs)); },
    flush() {}, destroy() {}, onFirstFrame: null, onFrameRendered: null, onStall: null,
  };
  const output: AudioOutputLike = {
    schedule(data, renderTimeUs) { scheduledAudio.push(point(data, renderTimeUs)); },
    currentPlayoutTimeUs: 0, flush() {}, destroy() {},
  };
  const avc = codecDescriptionFromInit(videoInit());
  if (!avc) throw new Error('Fixture has no AVC configuration');
  const nextAvc = avc.slice();
  // A valid, different AVCDecoderConfigurationRecord level; not corrupt bytes.
  if (options.changedTargetVideoInit) nextAvc[3] = 41;
  const catalog = new TextEncoder().encode(JSON.stringify({ version: 1, tracks: keys.map(key => {
    const track = mediaTracks[key], ref = mediaRefs[key];
    return { name: ref.name, namespace: ref.namespace.join('/'), packaging: 'loc', role: track.media,
      renderGroup: track.renderGroup, altGroup: track.altGroup, isLive: true,
      ...(track.media === 'video' ? { codec: 'avc1.640028', width: 640, height: 360, bitrate: 100_000,
        initData: Buffer.from(key === 'nextVideo' ? nextAvc : avc).toString('base64') }
        : { codec: 'opus', samplerate: 48_000, channelConfig: '2', lang: 'en' }) };
  }) }));
  let connectionCount = 0;
  const player = new MoqtPlayer({ url: 'https://media-selection.invalid/live', namespace: mediaRefs.catalog.namespace,
    draftVersion: draft, clock, autoQuality: options.automaticVideo === true, catalogBootstrap: 'subscribe', reconnectAttempts: 0,
    connectionTimeoutMs: 1000, cmafBootstrapTimeoutMs: 0, maxBufferDepth: 2048,
    ...(options.videoOnly ? { disableAudio: true } : {}),
    selection: { renderGroup: 1,
      ...(options.automaticVideo ? { videoAltGroup: 11 } : { videoTrack: mediaRefs.oldVideo }),
      ...(options.videoOnly ? {} : { audioTrack: mediaRefs.oldAudio }) },
    createConnection: () => peers[connectionCount++]!.client,
    createTransport: async url => { transportCalls.push(url); return peers[transportCalls.length - 1]!.start(); },
    createVideoDecoder: makeVideo, createRenderer: () => renderer,
    createAudioDecoder: makeAudio, createAudioOutput: () => output,
    objectTransform: async object => {
      const key = keys.find(key => mediaTracks[key].alias === object.trackAlias);
      if (key) await holds.get(key)?.promise;
      return object;
    },
  });
  player.on('error', event => { errors.push(event.error); });
  player.on('selection_changed', event => { selections.push(event.selection); });
  async function send(key: MediaKey, ptsUs: bigint, object = 0n, peer = wire) {
    const track = mediaTracks[key];
    const ticks = ptsUs * track.scale;
    if (ticks % 1_000_000n !== 0n) throw new Error('Fixture timestamp is not exact in its declared LOC timescale');
    const extensions = encodeLocHeaders({ timestamp: ticks / 1_000_000n, timescale: track.scale,
      ...(key === 'nextAudio' && options.targetAudioConfig ? { audioConfig: options.targetAudioConfig } : {}),
      ...(track.media === 'video' ? { videoFrameMarking: { startOfFrame: true, endOfFrame: true, independent: true,
        discardable: false, baseLayerSync: false, temporalId: 0 } } : {}) },
    { locVersion: 4, wireProfile: locWireProfileForDraft(draft) });
    const payload = track.media === 'video' ? Uint8Array.of(0, 0, 0, 1, 0x65, track.marker)
      : Uint8Array.of(0x48, track.marker, Number(object));
    await peer.send(mediaRefs[key], payload, track.group, object, extensions); await flush(512);
  }
  function tick(deltaUs = 20_000) { now += deltaUs; player.tick(); }
  async function sendOld(ptsUs: bigint, object: bigint) {
    await send('oldVideo', ptsUs, object);
    if (!options.videoOnly) await send('oldAudio', ptsUs, object);
    tick(); await flush(512);
  }
  async function destroy() {
    await player.destroy(); for (const hold of holds.values()) hold.resolve();
    await flush(512); for (const peer of peers) await peer.close();
  }
  try {
    await player.load(); await wire.accept(mediaRefs.catalog, 100n); await wire.send(mediaRefs.catalog, catalog, 1n);
    await wire.accept(mediaRefs.oldVideo, mediaTracks.oldVideo.alias);
    if (!options.videoOnly) await wire.accept(mediaRefs.oldAudio, mediaTracks.oldAudio.alias);
    await sendOld(10_000_000n, 0n);
  } catch (error) { await destroy(); throw error; }
  return { renderer, player, api: player, wire, peers, catalog, clock, transportCalls, errors, selections,
    enqueuedVideo, scheduledAudio, decodedVideo, decodedAudio, decoderEvents,
    send, sendOld, tick, destroy,
    accept(key: MediaKey) { return wire.accept(mediaRefs[key], mediaTracks[key].alias); },
    hold(key: MediaKey) {
      if (holds.has(key)) throw new Error(`Transform already held for ${key}`);
      const held = gate(); holds.set(key, held); return held.resolve;
    },
  };
}
