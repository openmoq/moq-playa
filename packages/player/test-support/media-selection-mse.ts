/**
 * Draft-18 SUBSCRIBE/object bytes through a real MoqtPlayer and CmafAssembler.
 * The source records append submissions and models queue leases and exposed
 * timestampOffset cells. It has no native SourceBuffer, playback clock or PCM.
 * Placement observations parse actual assembler/append bytes, not track menus.
 * Every output type uses one unchanged init/config across its catalog choices.
 */
import { LOCMAF_VERSION, parseLocmafTrackContext, readCmafChunkSamples, serializeLocmafObject } from '@openmoq/locmaf';
import type { MoqtObject } from '@openmoq/transport';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { buildChunk, buildInit, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { MoqtPlayer } from '../src/player.js';
import type { MoqtPlayerConfig } from '../src/config.js';
import type { MediaSourceLike } from '../src/interfaces.js';
import type { MediaSelectionSnapshot } from '../src/player-selection-state.js';
import type { PlayerError } from '../src/errors.js';
import { audioPeer, gate } from './audio-selection.js';

export const mseMediaRefs = {
  catalog: { namespace: ['live', 'mse-program-selection'], name: 'catalog' },
  oldVideo: { namespace: ['program', 'one', 'picture'], name: 'video' },
  oldAudio: { namespace: ['program', 'one', 'sound'], name: 'audio' },
  nextVideo: { namespace: ['program', 'two', 'picture'], name: 'video' },
  nextAudio: { namespace: ['program', 'two', 'sound'], name: 'audio' },
  viewVideo: { namespace: ['program', 'one', 'alternate-picture'], name: 'video' },
} as const;
export type MseMediaKey = Exclude<keyof typeof mseMediaRefs, 'catalog'>;
export type MseMediaType = 'video' | 'audio';
export const mseMediaTracks = {
  oldVideo: { media: 'video', renderGroup: 1, altGroup: 11, alias: 200n, group: 800n, marker: 11 },
  oldAudio: { media: 'audio', renderGroup: 1, altGroup: 21, alias: 201n, group: 70n, marker: 21 },
  nextVideo: { media: 'video', renderGroup: 2, altGroup: 31, alias: 300n, group: 3n, marker: 31 },
  nextAudio: { media: 'audio', renderGroup: 2, altGroup: 41, alias: 301n, group: 901n, marker: 41 },
  viewVideo: { media: 'video', renderGroup: 1, altGroup: 12, alias: 302n, group: 1700n, marker: 51 },
} as const;

export interface MseMediaAppend {
  readonly media: MseMediaType;
  readonly trackName: string;
  readonly sourceKey: string | undefined;
  readonly group: bigint | undefined;
  readonly bytes: Uint8Array;
  readonly init: Uint8Array;
  readonly timestampOffset: number | undefined;
  readonly decodeTimeUs: bigint;
  readonly presentationTimeUs: bigint;
  readonly marker: number;
  readonly ctoTicks: number;
}

export async function mediaSelectionMseFixture(options: { timeoutMs?: number; packaging?: 'cmaf' | 'locmaf'; transform?: (object: MoqtObject) => MoqtObject; config?: Partial<MoqtPlayerConfig> } = {}) {
  const packaging = options.packaging ?? 'cmaf';
  const wire = audioPeer(18), keys = Object.keys(mseMediaTracks) as MseMediaKey[];
  const headers = {
    video: buildInit({ trackId: 11, timescale: 90000, handler: 'vide', trex: { duration: 1800 } }),
    audio: buildInit({ trackId: 21, timescale: 48000, handler: 'soun', trex: { duration: 960 } }),
  };
  const installed = new Map<MseMediaType, Uint8Array>();
  // Unknown until initialize/first actual onSegment invokes the source setter.
  // No native offset or playhead is invented from a media clock or elapsed time.
  const timestampOffsets = new Map<MseMediaType, number>();
  const appendCalls: MseMediaAppend[] = [], sourceAppends: MseMediaAppend[] = [], acceptedQueue: MseMediaAppend[] = [];
  const sourceMutations: Array<{ kind: string; media?: MseMediaType; value?: number; trackName?: string; sourceKey?: string | undefined }> = [];
  const assemblers: CmafAssembler[] = [];
  const segments: Array<{ assembler: number; media: MseMediaType; bytes: Uint8Array; trackName: string;
    sourceKey: string | undefined; group: bigint }> = [];
  const sent: Array<{ key: MseMediaKey; group: bigint; object: bigint; bytes: Uint8Array; rawPresentationTimeUs: bigint }> = [];
  const errors: PlayerError[] = [], selections: MediaSelectionSnapshot[] = [], transportCalls: string[] = [];
  const holds = new Map<MseMediaKey, ReturnType<typeof gate>>();
  const leases = new Set<{ active: boolean; roles: ReadonlySet<MseMediaType> }>();
  const blocked = new Set<MseMediaType>();
  let destroyed = false, sourceGeneration = 0, now = 10_000_000;
  const commit = (append: MseMediaAppend) => {
    if (blocked.has(append.media)) acceptedQueue.push(append); else sourceAppends.push(append);
  };
  const source: MediaSourceLike = {
    supportsTrackIdentity: true,
    initialize(config) {
      sourceMutations.push({ kind: 'initialize' });
      for (const media of ['video', 'audio'] as const) if (config[media]) installed.set(media, config[media].initData.slice());
      return true;
    },
    appendChunk(media, bytes, trackName, group, _token, sourceKey) {
      if (destroyed) throw new Error('Append after observable source destruction');
      const init = installed.get(media);
      if (!init) throw new Error(`Append before ${media} initialization`);
      const context = parseLocmafTrackContext(init), read = readCmafChunkSamples(bytes, context);
      const cto = read.effective.compositionTimeOffsets[0] ?? 0, scale = BigInt(context.timescale);
      const decode = read.effective.baseMediaDecodeTime, marker = read.mdat[0];
      if (marker === undefined) throw new Error('Append has no coded payload marker');
      const append = { media, trackName, sourceKey, group, bytes: bytes.slice(), init: init.slice(), timestampOffset: timestampOffsets.get(media),
        decodeTimeUs: decode * 1_000_000n / scale, presentationTimeUs: (decode + BigInt(cto)) * 1_000_000n / scale,
        marker, ctoTicks: cto };
      appendCalls.push(append); commit(append);
    },
    async changeType(media, _codec, init) {
      sourceMutations.push({ kind: 'changeType', media }); installed.set(media, init.slice());
    },
    getTimestampOffset: media => timestampOffsets.get(media),
    setTimestampOffset(media, value) {
      sourceMutations.push({ kind: 'setTimestampOffset', media, value }); timestampOffsets.set(media, value);
    },
    // This observable source has no replay index or committed-floor model.
    // Preserve the exact clear scope and accepted queued records unchanged.
    clearTimeline(media, trackName, sourceKey) {
      sourceMutations.push({ kind: 'clearTimeline', media, trackName, sourceKey });
    },
    holdQueuedAppends(mediaTypes) {
      if (mediaTypes.some(media => blocked.has(media))) throw new Error('Observable source output already leased');
      const generation = sourceGeneration, state = { active: true, roles: new Set(mediaTypes) }; leases.add(state);
      for (const media of mediaTypes) blocked.add(media);
      sourceMutations.push({ kind: 'holdQueuedAppends' });
      const finish = (discard: boolean) => {
        if (!state.active || destroyed || generation !== sourceGeneration) return;
        state.active = false; leases.delete(state);
        for (const media of state.roles) blocked.delete(media);
        const queued = acceptedQueue.splice(0);
        for (const append of queued) {
          if (!state.roles.has(append.media)) acceptedQueue.push(append);
          else if (!discard) commit(append);
        }
        sourceMutations.push({ kind: discard ? 'discardQueuedAppends' : 'resumeQueuedAppends' });
      };
      return { get current() { return state.active && !destroyed && generation === sourceGeneration; },
        resume() { finish(false); }, discard() { finish(true); } };
    },
    reset() {
      sourceMutations.push({ kind: 'reset' }); sourceGeneration++;
      for (const state of leases) state.active = false;
      leases.clear(); blocked.clear(); acceptedQueue.splice(0); installed.clear(); timestampOffsets.clear();
    },
    endOfStream() { sourceMutations.push({ kind: 'endOfStream' }); },
    destroy() {
      sourceMutations.push({ kind: 'destroy' }); destroyed = true; sourceGeneration++;
      for (const state of leases) state.active = false;
      leases.clear(); blocked.clear(); acceptedQueue.splice(0);
    },
    mediaElement: null, onFirstFrame: null, onError: null, onStall: null,
  };
  const catalog = new TextEncoder().encode(JSON.stringify({ version: 1, tracks: keys.map(key => {
    const track = mseMediaTracks[key], ref = mseMediaRefs[key];
    return { name: ref.name, namespace: ref.namespace.join('/'), packaging, role: track.media,
      ...(packaging === 'locmaf' ? { locmafVersion: LOCMAF_VERSION } : {}),
      renderGroup: track.renderGroup, altGroup: track.altGroup, isLive: true,
      initData: Buffer.from(headers[track.media]).toString('base64'),
      ...(track.media === 'video' ? { codec: 'avc1.640028', width: 640, height: 360, bitrate: 100000 }
        : { codec: 'mp4a.40.2', samplerate: 48000, channelConfig: '2', lang: 'en' }) };
  }) }));
  const player = new MoqtPlayer({ url: 'https://mse-program-selection.invalid/live', namespace: mseMediaRefs.catalog.namespace,
    draftVersion: 18, catalogBootstrap: 'subscribe', autoQuality: false, reconnectAttempts: 0,
    connectionTimeoutMs: options.timeoutMs ?? 100, cmafBootstrapTimeoutMs: 0, maxBufferDepth: 2048,
    clock: { now: () => now }, selection: { renderGroup: 1, videoTrack: mseMediaRefs.oldVideo, audioTrack: mseMediaRefs.oldAudio },
    ...options.config,
    createConnection: () => wire.client,
    createTransport: async url => { transportCalls.push(url); return wire.start(); },
    createMediaSource: () => source,
    createCmafAssembler: callbacks => {
      const index = assemblers.length;
      const assembler = new CmafAssembler({ ...callbacks, onSegment(...args) {
        callbacks.onSegment(...args);
        const [media, bytes, trackName, group, , sourceKey] = args;
        segments.push({ assembler: index, media, bytes: bytes.slice(), trackName, sourceKey, group });
      } });
      assemblers.push(assembler); return assembler;
    },
    objectTransform: async object => {
      const key = keys.find(key => mseMediaTracks[key].alias === object.trackAlias);
      if (key) await holds.get(key)?.promise;
      return options.transform?.(object) ?? object;
    },
  });
  player.on('error', event => { errors.push(event.error); });
  player.on('selection_changed', event => { selections.push(event.selection); });
  function chunk(key: MseMediaKey, ptsUs: bigint, object = 0n, ctoUs = 0n) {
    const media = mseMediaTracks[key].media, context = parseLocmafTrackContext(headers[media]), scale = BigInt(context.timescale);
    if ((ptsUs - ctoUs) * scale % 1_000_000n !== 0n || ctoUs * scale % 1_000_000n !== 0n) throw new Error('Fixture needs exact timestamp ticks');
    return buildChunk({ trackId: context.trackId, bmdt: (ptsUs - ctoUs) * scale / 1_000_000n,
      samples: [{ duration: context.timescale / 50, size: 4, flags: SYNC_FLAGS, cto: Number(ctoUs * scale / 1_000_000n) }],
      mdat: Uint8Array.of(mseMediaTracks[key].marker, Number(object), 3, 4) });
  }
  async function sendBytes(key: MseMediaKey, bytes: Uint8Array, ptsUs: bigint, object = 0n) {
    const group = mseMediaTracks[key].group;
    if (packaging === 'locmaf') bytes = serializeLocmafObject({ kind: 'rawBoxes', boxes: bytes });
    sent.push({ key, group, object, bytes: bytes.slice(), rawPresentationTimeUs: ptsUs });
    await wire.send(mseMediaRefs[key], bytes, group, object); await flush(512);
  }
  function send(key: MseMediaKey, ptsUs: bigint, object = 0n, ctoUs = 0n) { return sendBytes(key, chunk(key, ptsUs, object, ctoUs), ptsUs, object); }
  async function sendOld(ptsUs: bigint, object: bigint) {
    await send('oldVideo', ptsUs, object); await send('oldAudio', ptsUs, object); now += 20000; player.tick(); await flush(512);
  }
  async function destroy() {
    await player.destroy(); for (const held of holds.values()) held.resolve();
    await flush(512); await wire.close();
  }
  try {
    await player.load(); await wire.accept(mseMediaRefs.catalog, 100n); await wire.send(mseMediaRefs.catalog, catalog, 1n);
    await wire.accept(mseMediaRefs.oldVideo, mseMediaTracks.oldVideo.alias); await wire.accept(mseMediaRefs.oldAudio, mseMediaTracks.oldAudio.alias);
    await sendOld(1_000_000_000n, 0n);
  } catch (error) { await destroy(); throw error; }
  return { player, wire, source, headers, installed, timestampOffsets, sourceMutations, appendCalls, sourceAppends, acceptedQueue,
    assemblers, segments, sent, errors, selections, transportCalls, catalog, chunk, send, sendBytes, sendOld, destroy,
    get runningAssembler() {
      const assembler = assemblers[0]; if (!assembler) throw new Error('No real running assembler'); return assembler;
    },
    accept(key: MseMediaKey) { return wire.accept(mseMediaRefs[key], mseMediaTracks[key].alias); },
    hold(key: MseMediaKey) {
      if (holds.has(key)) throw new Error(`Transform already held for ${key}`);
      const held = gate(); holds.set(key, held); return held.resolve;
    },
  };
}
