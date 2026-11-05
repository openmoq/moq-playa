/** Real MoQT peers and public adapter witnesses; no engine internals or PCM claims. */
import { MoqtConnection } from '@openmoq/webtransport';
import { createControlCodec, encodeSubgroupHeader, encodeSubgroupHeader18, encodeSubgroupObject, encodeSubgroupObject18, varint } from '@openmoq/transport';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { codecDescriptionFromInit, LocmafEncoder, LocmafGroupState, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { buildChunk, buildInit, SYNC_FLAGS, videoInit } from '../../locmaf/test-support/cmaf.js';
import { MoqtPlayer } from '../src/player.js';
import type { MoqtPlayerConfig } from '../src/config.js';
import type { DecoderCommand } from '@openmoq/playback';
import { createMediaDiagnostics, type MediaStageObservation } from '../src/media-diagnostics.js';
import type { AudioDecoderLike, AudioOutputLike, MediaSourceLike, VideoDecoderLike, VideoRendererLike } from '../src/interfaces.js';

export type AudioDraft = 16 | 18 | 22 | 23;
export type AudioPath = 'cmaf' | 'loc' | 'locmaf-mse' | 'locmaf-frame';
export interface AudioRef { readonly name: string; readonly namespace: readonly string[] }
export const refs = {
  catalog: { name: 'catalog', namespace: ['live', 'audio-selection'] },
  video: { name: 'video', namespace: ['camera', 'main'] },
  english: { name: 'audio-en', namespace: ['sound', 'english'] },
  spanish: { name: 'audio-es', namespace: ['sound', 'spanish'] },
  french: { name: 'audio-fr', namespace: ['sound', 'french'] },
} as const;
export const identity = (ref: AudioRef) => ({ name: ref.name, namespaceFields: [...ref.namespace] });
const key = (ref: AudioRef) => JSON.stringify([ref.namespace, ref.name]);
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
export function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

export function audioPeer(draft: AudioDraft) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const requests: Array<AudioRef & { id: bigint }> = [], stopped: bigint[] = [], errors: Error[] = [];
  const control: Array<{ type: string; requestId?: string }> = [];
  const aliases = new Map<string, bigint>(), streams = new Map<string, bigint>();
  const heldResponses: Array<() => void> = [];
  let connected: Promise<void> | undefined;
  server.onSubscribe = (id, namespace, name) => {
    requests.push({ id, name: dec.decode(name), namespace: namespace.map(field => dec.decode(field)) });
  };
  server.onSubscribeClosed = id => { stopped.push(id); };
  server.onMessage = message => {
    control.push({ type: message.type, ...('requestId' in message ? { requestId: String(message.requestId) } : {}) });
    // Legacy drafts cancel through UNSUBSCRIBE, not request-stream closure.
    if (draft === 16 && message.type === 'UNSUBSCRIBE') stopped.push(BigInt(message.requestId));
  };
  server.onError = error => { errors.push(error); };
  const request = (ref: AudioRef) => {
    const matches = requests.filter(item => key(item) === key(ref));
    if (matches.length !== 1) throw new Error(`Expected one wire request for ${key(ref)}; got ${matches.length}`);
    return matches[0]!;
  };
  return {
    client, server, requests, stopped, errors, control, transport: a, request,
    start() {
      connected ??= server.connect(b, draft === 16 ? { maxRequestId: varint(1000) } : {});
      void connected.catch(error => { errors.push(error); });
      return a;
    },
    async accept(ref: AudioRef, alias: bigint) {
      await flush(256); await server.acceptSubscribe(request(ref).id, alias);
      aliases.set(key(ref), alias); await flush(256);
    },
    async reject(ref: AudioRef) {
      await flush(256); await server.rejectSubscribe(request(ref).id, 0x10n, 'candidate unavailable'); await flush(256);
    },
    async holdAck(ref: AudioRef) {
      await flush(256);
      const index = requests.indexOf(request(ref));
      const pipe = a.bidiOut[draft === 16 ? 0 : index]!.in;
      pipe.faults.hold = true;
      heldResponses.push(() => { pipe.releaseHeld(); });
      return async () => { pipe.releaseHeld(); await flush(512); };
    },
    async send(ref: AudioRef, payload: Uint8Array, group: bigint, object = 0n, extensions?: Uint8Array) {
      const alias = aliases.get(key(ref));
      if (alias === undefined) throw new Error(`No accepted alias for ${key(ref)}`);
      const streamKey = JSON.stringify([String(alias), String(group)]);
      let stream = streams.get(streamKey);
      if (stream === undefined) {
        stream = await server.openSubgroup(alias, group, 0n, { publisherPriority: 128, hasExtensions: extensions !== undefined });
        streams.set(streamKey, stream);
      }
      await server.sendObject(stream, object, payload, extensions); await flush(256);
    },
    async sendFinite(ref: AudioRef, payload: Uint8Array, group: bigint, object = 0n, extensions?: Uint8Array) {
      const alias = aliases.get(key(ref));
      if (alias === undefined) throw new Error(`No accepted alias for ${key(ref)}`);
      if ([...streams.keys()].some(stream => JSON.parse(stream)[0] === String(alias))) {
        throw new Error('Finite candidate fixture requires exactly its one fresh data stream');
      }
      // The publisher convenience API cannot emit status objects. Encode the
      // entire candidate stream on the real loopback transport instead. Its
      // sole stream is closed BEFORE the correct one-stream DONE is encoded;
      // only objectTransform processing, never sender FIN, may be overtaken.
      const writer = (await b.createUnidirectionalStream()).getWriter();
      const pipe = b.uniOut.at(-1)!;
      const hasExtensions = extensions !== undefined;
      const header = { typeByte: 0x10 | (hasExtensions ? 1 : 0), trackAlias: alias, groupId: group,
        subgroupId: 0n, publisherPriority: 128, hasExtensions, isEndOfGroup: false, isFirstObjectInSubgroup: true };
      const encodeObject = draft === 16 ? encodeSubgroupObject : encodeSubgroupObject18;
      await writer.write((draft === 16 ? encodeSubgroupHeader : encodeSubgroupHeader18)(header));
      await writer.write(encodeObject({ objectId: object, payload, extensions, status: undefined }, hasExtensions, varint(0n), true));
      await writer.write(encodeObject({ objectId: object + 1n, payload: new Uint8Array(), extensions: undefined, status: 4n },
        hasExtensions, varint(object), false));
      await writer.close();
      if (!pipe.writeClosed) throw new Error('Sender FIN did not settle before DONE');
      const id = request(ref).id;
      const done = createControlCodec(draft).encode({ type: 'PUBLISH_DONE', requestId: varint(id),
        statusCode: varint(2n), streamCount: varint(1n), errorReason: 'finite candidate complete' });
      const controlPipe = a.bidiOut[draft === 16 ? 0 : requests.indexOf(request(ref))]!.in;
      controlPipe.injectRead(done);
      await flush(512);
      return { senderFinBeforeDone: pipe.writeClosed, streamCount: 1n, statusCode: 2n };
    },
    async goaway(url: string) {
      const next = requests.reduce((max, item) => item.id > max ? item.id : max, 0n) + 2n;
      await server.sendGoaway({ newSessionUri: url, ...(draft === 18 ? { requestId: next, timeout: 0n } : {}) });
      await flush(512);
    },
    async close() {
      for (const release of heldResponses) release();
      await client.close(); await server.close(); await connected?.catch(() => {});
    },
  };
}

export interface AudioFixtureOptions {
  readonly path?: AudioPath;
  readonly crossSet?: boolean;
  readonly badTargetInit?: boolean;
  readonly finite?: boolean;
  readonly observe?: boolean;
  readonly targetAudioConfig?: Uint8Array;
  readonly originUs?: bigint;
  readonly frenchSet?: number;
  readonly targetCtoUs?: bigint;
  readonly deferAudioOutput?: boolean;
  readonly playheadWitness?: boolean;
  readonly config?: Partial<MoqtPlayerConfig>;
}

export async function audioSelectionFixture(draft: AudioDraft, options: AudioFixtureOptions = {}) {
  const path = options.path ?? 'cmaf', packaging = path.startsWith('locmaf') ? 'locmaf' : path;
  const peers = [audioPeer(draft), audioPeer(draft)];
  const wire = peers[0]!;
  const transportCalls: string[] = [], errors: string[] = [];
  const sourceAppends: Array<{ media: 'video' | 'audio'; track: string; group: bigint | undefined; bytes: Uint8Array; init: Uint8Array | undefined }> = [];
  const headers = {
    english: buildInit({ trackId: 21, timescale: 48000, handler: 'soun', trex: { duration: 960 } }),
    spanish: buildInit({ trackId: 31, timescale: 96000, handler: 'soun', trex: { duration: 1920 } }),
    french: buildInit({ trackId: 41, timescale: 48000, handler: 'soun', trex: { duration: 960 } }),
  };
  const installed = new Map<'video' | 'audio', Uint8Array>();
  const offsets = new Map<'video' | 'audio', number>();
  const retypes: Array<{ media: 'video' | 'audio'; codec: string; init: Uint8Array }> = [];
  let onRetype: (() => void | Promise<void>) | undefined;
  const makeSource = (current: typeof installed, positions: typeof offsets): MediaSourceLike => {
    let destroyed = false;
    return {
    initialize(config) {
      for (const media of ['video', 'audio'] as const) if (config[media]) current.set(media, config[media].initData.slice());
      return true;
    },
    appendChunk(media, bytes, track, group) {
      if (destroyed) throw new Error('Append to a destroyed media source');
      sourceAppends.push({ media, track, group, bytes: bytes.slice(), init: current.get(media)?.slice() });
    },
    async changeType(media, codec, init) {
      retypes.push({ media, codec, init: init.slice() }); await onRetype?.(); current.set(media, init.slice());
    },
    getTimestampOffset: media => positions.get(media), setTimestampOffset: (media, value) => { positions.set(media, value); },
    reset() {}, endOfStream() {}, destroy() { destroyed = true; }, mediaElement: null, onFirstFrame: null, onError: null, onStall: null,
    };
  };
  const source = makeSource(installed, offsets);
  let sourceCount = 0;
  const audioConfigs: Array<{ codec: string; bytes: Uint8Array; rate: number | undefined }> = [];
  const decodedAudio: Array<{ timestamp: number; bytes: Uint8Array; renderTimeUs: number }> = [];
  const renderedVideo: Array<{ timestamp: number; renderTimeUs: number }> = [];
  const scheduledAudio: Array<{ timestamp: number; renderTimeUs: number }> = [];
  const liveSchedules: typeof scheduledAudio = [], nativeAudioOutputs: Array<() => void> = [];
  let onConfigure: (() => void) | undefined;
  const makeAudio = (): AudioDecoderLike => {
    const audio: AudioDecoderLike = {
    configure(bytes, codec, rate) { audioConfigs.push({ codec, bytes: bytes.slice(), rate }); onConfigure?.(); },
    decode(chunk, renderTimeUs, input) {
      decodedAudio.push({ timestamp: chunk.timestamp, bytes: chunk.data.slice(), renderTimeUs });
      const emit = () => audio.onData?.({ timestamp: chunk.timestamp, close() {} }, renderTimeUs, input);
      if (options.deferAudioOutput) nativeAudioOutputs.push(emit); else emit();
    },
    flush: async () => {}, reset() {}, destroy() {}, queueDepth: 0, onData: null, onError: null,
    };
    return audio;
  };
  const makeVideo = (): VideoDecoderLike => {
    const video: VideoDecoderLike = {
    configure() {}, decode(chunk, renderTimeUs, input) {
      video.onFrame?.({ timestamp: chunk.timestamp, close() {} }, renderTimeUs, null, input);
    },
    flush: async () => {}, reset() {}, destroy() {}, queueDepth: 0, onFrame: null, onError: null,
    };
    return video;
  };
  const renderer: VideoRendererLike = {
    enqueue(frame, renderTimeUs) {
      if (typeof frame === 'object' && frame !== null && 'timestamp' in frame && typeof frame.timestamp === 'number') {
        renderedVideo.push({ timestamp: frame.timestamp, renderTimeUs });
      }
    },
    flush() {}, destroy() {}, onFirstFrame: null, onFrameRendered: null, onStall: null,
  };
  const output: AudioOutputLike = {
    schedule(data, renderTimeUs) {
      if (typeof data === 'object' && data !== null && 'timestamp' in data && typeof data.timestamp === 'number') {
        const point = { timestamp: data.timestamp, renderTimeUs };
        scheduledAudio.push(point); liveSchedules.push(point);
      }
    },
    // This graph witness exists only while an actually scheduled fixture unit
    // is playing. Clock advancement without schedule() creates no evidence.
    // It models the adapter boundary, not native PCM.
    ...(options.playheadWitness ? { playheadCaptureUs: () => {
      const point = [...liveSchedules].reverse().find(item => item.renderTimeUs <= now && now < item.renderTimeUs + 20_000);
      return point ? point.timestamp + now - point.renderTimeUs : null;
    } } : {}),
    currentPlayoutTimeUs: 0, flush() { liveSchedules.splice(0); }, destroy() { liveSchedules.splice(0); },
  };
  let now = 10_000_000, connectionCount = 0;
  const transformGates: Array<ReturnType<typeof gate>> = [];
  const transforms = new Map<bigint, ReturnType<typeof gate>>();
  const mediaObjects: Array<{ name: string; group: bigint; object: bigint; extensions?: Uint8Array; captureTimestamp?: bigint; payload?: Uint8Array }> = [];
  const commands: DecoderCommand[] = [], stages: MediaStageObservation[] = [];
  const audioTrack = (kind: 'english' | 'spanish' | 'french') => ({
    name: refs[kind].name, namespace: refs[kind].namespace.join('/'), role: 'audio' as const, packaging,
    renderGroup: 1, altGroup: kind === 'french' && options.frenchSet !== undefined ? options.frenchSet
      : kind === 'english' || !options.crossSet ? 3 : kind === 'spanish' ? 4 : 5,
    isLive: !options.finite, lang: kind === 'english' ? 'en' : kind === 'spanish' ? 'es' : 'fr',
    codec: packaging === 'loc' ? 'opus' : 'mp4a.40.2', samplerate: 48000, channelConfig: '2',
    ...(packaging === 'loc' ? {} : { initData: b64(kind === 'spanish' && options.badTargetInit ? Uint8Array.of(1, 2, 3) : headers[kind]) }),
    ...(packaging === 'locmaf' ? { locmafVersion: '0.3' } : {}),
  });
  const catalog = enc.encode(JSON.stringify({ version: 1, tracks: [
    { name: refs.video.name, namespace: refs.video.namespace.join('/'), role: 'video', packaging: 'loc', isLive: !options.finite,
      renderGroup: 1, altGroup: 1, codec: 'avc1.640028', width: 640, height: 360, bitrate: 100000,
      initData: b64(codecDescriptionFromInit(videoInit())!) },
    audioTrack('english'), audioTrack('spanish'), audioTrack('french'),
  ] }));
  const player = new MoqtPlayer({
    url: 'https://audio-selection.invalid/old', namespace: refs.catalog.namespace, draftVersion: draft,
    connectionTimeoutMs: 100, reconnectAttempts: 0, cmafBootstrapTimeoutMs: 0, autoQuality: false,
    catalogBootstrap: 'subscribe', maxBufferDepth: 2048, clock: { now: () => now },
    selection: { videoTrack: refs.video, audioTrack: refs.english },
    locmafDecoding: path === 'locmaf-frame' ? 'frame' : 'mse',
    createConnection: () => peers[connectionCount++]!.client,
    createTransport: async url => {
      transportCalls.push(url); return peers[transportCalls.length - 1]!.start();
    },
    createMediaSource: () => sourceCount++ === 0 ? source : makeSource(new Map(), new Map()),
    createCmafAssembler: callbacks => new CmafAssembler(callbacks),
    createAudioDecoder: makeAudio, createAudioOutput: () => output,
    createVideoDecoder: makeVideo, createRenderer: () => renderer,
    objectTransform: async object => { await transforms.get(object.trackAlias)?.promise; return object; },
    ...options.config,
  });
  player.on('error', event => { errors.push(event.error.message); });
  player.on('decoder_command', event => { commands.push(event.command); });
  const unobserve = options.observe ? player.observeMediaStages(event => { stages.push(event); }, { createTracker: createMediaDiagnostics }) : () => {};
  player.on('media_object', event => { mediaObjects.push({ name: event.trackName, group: event.groupId, object: event.objectId,
    ...(event.extensions ? { extensions: event.extensions.slice() } : {}),
    ...(event.captureTimestamp === undefined ? {} : { captureTimestamp: event.captureTimestamp }),
    ...(event.payload ? { payload: event.payload.slice() } : {}),
  }); });
  const locmafStates = new Map<string, LocmafGroupState>();
  async function sendAudio(kind: 'english' | 'spanish' | 'french', group = 70n, object = 0n, ptsUs = 10_000_000n, peer = wire, finite = false) {
    const ref = refs[kind];
    const send = finite ? peer.sendFinite : peer.send;
    let receipt: Awaited<ReturnType<typeof peer.sendFinite>> | void;
    if (packaging === 'loc') {
      const marker = kind === 'english' ? 21 : kind === 'spanish' ? 31 : 41;
      receipt = await send(ref, Uint8Array.of(0x48, marker, Number(object)), group, object,
        encodeLocHeaders({ captureTimestamp: ptsUs,
          ...(kind === 'spanish' && options.targetAudioConfig ? { audioConfig: options.targetAudioConfig } : {}),
        }, { wireProfile: locWireProfileForDraft(draft),
          ...(kind === 'spanish' && options.targetAudioConfig ? { locVersion: 4 } : {}),
        }));
    } else {
      const context = parseLocmafTrackContext(headers[kind]);
      const ctoUs = kind === 'spanish' ? options.targetCtoUs ?? 0n : 0n;
      const bytes = buildChunk({ trackId: context.trackId, bmdt: (ptsUs - ctoUs) * BigInt(context.timescale) / 1_000_000n,
        samples: [{ duration: context.timescale / 50, size: 4, flags: SYNC_FLAGS,
          cto: Number(ctoUs * BigInt(context.timescale) / 1_000_000n) }],
        mdat: Uint8Array.of(context.trackId, Number(object), 3, 4) });
      let payload = bytes;
      if (packaging === 'locmaf') {
        const stream = JSON.stringify([kind, String(group), peers.indexOf(peer)]);
        let state = locmafStates.get(stream);
        if (!state) { state = new LocmafGroupState(); locmafStates.set(stream, state); }
        payload = serializeLocmafObject(new LocmafEncoder().encode(bytes, state, context, object === 0n, object));
      }
      receipt = await send(ref, payload, group, object);
    }
    await flush(512);
    return receipt;
  }
  async function sendVideo(ptsUs = 10_000_000n, object = 0n, peer = wire) {
    await peer.send(refs.video, Uint8Array.of(0, 0, 0, 1, 0x65), 800n, object,
      encodeLocHeaders({ captureTimestamp: ptsUs, videoFrameMarking: {
        startOfFrame: true, endOfFrame: true, independent: true, discardable: false, baseLayerSync: false, temporalId: 0,
      } }, { wireProfile: locWireProfileForDraft(draft) }));
  }
  function tick(steps = 8) { for (let i = 0; i < steps; i++) { now += 20_000; player.tick(); } }
  async function destroy() {
    for (const held of transformGates) held.resolve();
    await flush(512); await player.destroy(); unobserve();
    for (const peer of peers) await peer.close();
  }
  try {
    await player.load(); await wire.accept(refs.catalog, 100n); await wire.send(refs.catalog, catalog, 1n);
    await wire.accept(refs.video, 200n); await wire.accept(refs.english, 201n);
    // Establish output at 10.02s; a subsequent 10.04s aligned candidate must
    // arrive on time instead of being made artificially late by this fixture.
    const origin = options.originUs ?? 10_000_000n;
    await sendVideo(origin); await sendAudio('english', 70n, 0n, origin); tick(1); await flush(256);
  } catch (error) {
    await destroy();
    throw new Error(`Audio fixture startup: ${error instanceof Error ? error.message : String(error)}; `
      + `player errors=${JSON.stringify(errors)}; wire errors=${JSON.stringify(wire.errors.map(item => item.message))}`, { cause: error });
  }
  return {
    player, wire, peers, path, catalog, headers, source, output, sourceAppends, installed, retypes, offsets,
    decodedAudio, scheduledAudio, renderedVideo, audioConfigs, mediaObjects, commands, stages, errors, transportCalls,
    get nowUs() { return now; },
    advanceTo(timeUs: number) {
      if (timeUs < now) throw new Error('Fixture clock cannot move backwards');
      now = timeUs; player.tick();
    },
    sendAudio, sendVideo, tick, destroy,
    sendFiniteAudio(kind: 'english' | 'spanish' | 'french', group: bigint, object: bigint, ptsUs: bigint) {
      return sendAudio(kind, group, object, ptsUs, wire, true);
    },
    flushNativeAudio() { for (const emit of nativeAudioOutputs.splice(0)) emit(); },
    setRetype(callback: () => void | Promise<void>) { onRetype = callback; },
    setConfigure(callback: () => void) { onConfigure = callback; },
    holdTransform(alias: bigint) {
      const held = gate(); transforms.set(alias, held); transformGates.push(held); return held.resolve;
    },
    async malformed(ref: AudioRef, group = 70n) { await wire.send(ref, Uint8Array.of(1, 2, 3), group); },
  };
}

/** Finite LOC delivery with a real scheduled output that can outlive its request. */
export async function finiteAudioOutputFixture() {
  const wire = audioPeer(18);
  const namespace = ['finite', 'owned-output'];
  const ref = (name: string) => ({ namespace, name });
  const scheduled: Array<{ timestamp: number; at: number }> = [], playing: typeof scheduled = [];
  const decoders: AudioDecoderLike[] = [];
  const decoded: number[] = [], delivered: string[] = [], commands: DecoderCommand[] = [];
  const errors: Array<{ message: string; severity: string }> = [];
  let now = 10_000_000;
  let onPlayhead: (() => void) | undefined;
  const held = gate();
  const output: AudioOutputLike = {
    schedule(data, at) {
      if (typeof data !== 'object' || data === null || !('timestamp' in data) || typeof data.timestamp !== 'number') {
        throw new Error('Scheduled audio has no decoder timestamp');
      }
      const point = { timestamp: data.timestamp, at }; scheduled.push(point); playing.push(point);
    },
    currentPlayoutTimeUs: 0, flush() { playing.splice(0); }, destroy() { playing.splice(0); },
    playheadCaptureUs() {
      onPlayhead?.();
      const point = [...playing].reverse().find(point => point.at <= now && now < point.at + 20_000);
      return point ? point.timestamp + now - point.at : null;
    },
  };
  const catalog = new TextEncoder().encode(JSON.stringify({ version: 1, tracks: [
    { name: 'video', role: 'video', packaging: 'loc', codec: 'avc1.640028', renderGroup: 1, altGroup: 1, isLive: false },
    ...[['en', 'en'], ['es', 'es']].map(([name, lang]) => ({ name, lang, role: 'audio', packaging: 'loc', codec: 'opus',
      renderGroup: 1, altGroup: 3, isLive: false, samplerate: 48000, channelConfig: '2' })),
  ] }));
  const headers = (pts: bigint) => encodeLocHeaders({ captureTimestamp: pts }, { wireProfile: locWireProfileForDraft(18) });
  const player = new MoqtPlayer({ url: 'https://finite.invalid/live', namespace, draftVersion: 18,
    clock: { now: () => now }, catalogBootstrap: 'subscribe', reconnectAttempts: 0, connectionTimeoutMs: 1000,
    autoQuality: false, createConnection: () => wire.client, createTransport: async () => wire.start(),
    objectTransform: async object => { if (object.trackAlias === 301n) await held.promise; return object; },
    createAudioDecoder: () => {
      const decoder: AudioDecoderLike = {
        configure() {}, decode(chunk, at, input) { decoded.push(chunk.timestamp); decoder.onData?.({ timestamp: chunk.timestamp, close() {} }, at, input); },
        flush: async () => {}, reset() {}, destroy() {}, queueDepth: 0, onData: null, onError: null,
      };
      decoders.push(decoder); return decoder;
    },
    createAudioOutput: () => output,
    createVideoDecoder: () => ({ configure() {}, decode() {}, flush: async () => {}, reset() {}, destroy() {},
      queueDepth: 0, onFrame: null, onError: null }),
    createRenderer: () => ({ enqueue() {}, flush() {}, destroy() {}, onFirstFrame: null, onFrameRendered: null, onStall: null }),
  });
  player.on('error', event => { errors.push(event.error); });
  player.on('media_object', event => { delivered.push(event.trackName); });
  player.on('decoder_command', event => { commands.push(event.command); });
  await player.load(); await wire.accept(ref('catalog'), 100n); await wire.send(ref('catalog'), catalog, 1n);
  await wire.accept(ref('video'), 200n); await wire.accept(ref('en'), 201n);
  const stream = await wire.server.openSubgroup(201n, 70n, 0n, { publisherPriority: 128, hasExtensions: true });
  await wire.server.sendObject(stream, 0n, Uint8Array.of(0x48, 1, 2), headers(10_000_000n));
  await flush(512); now = 10_020_000; player.tick(); await flush(512);
  return {
    player, wire, ref, scheduled, output, errors, decoded, delivered, commands,
    get nowUs() { return now; },
    atOutputHead() {
      const point = scheduled.at(-1);
      if (!point) throw new Error('No actual scheduled finite audio');
      now = point.at; player.tick(); return point;
    },
    async drainAudio() {
      await wire.server.closeSubgroup(stream);
      await wire.server.publishDone(wire.request(ref('en')).id, varint(2n), 'all finite audio delivered');
      await flush(512); player.tick(); await flush(512); player.tick(); await flush(512);
    },
    async target() {
      const pts = BigInt(now + 20_000);
      await wire.send(ref('es'), Uint8Array.of(0x48, 3, 4), 80n, 0n, headers(pts));
      return pts;
    },
    releaseTarget() { held.resolve(); },
    setPlayheadHook(callback: () => void) { onPlayhead = callback; },
    failDecoder() {
      const error = new Error('finite decoder cannot continue'); error.name = 'CodecUnsupportedError';
      decoders.at(-1)?.onError?.(error);
    },
    async destroy() {
      onPlayhead = undefined;
      held.resolve(); await flush(512); await player.destroy();
      await wire.close();
    },
  };
}
