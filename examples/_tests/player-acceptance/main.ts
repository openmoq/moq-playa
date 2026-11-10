import { Player } from '@openmoq/playa';
import { createWebTransport, MseMediaSource, WebCodecsVideoDecoder } from '@openmoq/browser';
import { MoqtConnection, type WebTransportLike } from '@openmoq/webtransport';
import type { PlaybackSample } from '../../../scripts/player-acceptance/assessment.mjs';
import type { AudioObservationWindow } from '../../../scripts/player-acceptance/net-shape.mjs';
import { observeAudio, observeCanvas } from './sinks.js';
import { observeLocmafDelivery, assessLocmafDelivery, observeConnectionObjects } from './received.js';
import { observeDecodedSource } from './decoded.js';
import { observeWarmStart } from './warm-start.js';
import { observeNativeMse } from './native-mse.js';
import { observeProgramDecodedSource } from '../../../scripts/player-acceptance/program-switch-observer.mjs';
import { observeProgramSwitchWire } from '../../../scripts/player-acceptance/program-switch-wire-observer.mjs';
import { observeMseProgramSwitch } from '../../../scripts/player-acceptance/mse-program-switch-observer.mjs';
import { createGroupTailProbe } from '../../../scripts/player-acceptance/group-tail.mjs';
import { createMediaDiagnostics } from '@openmoq/player/diagnostics';
import type { TailCheckpoint } from '../../../scripts/player-acceptance/group-tail.mjs';

const video = document.querySelector<HTMLVideoElement>('#video')!;
const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const params = new URLSearchParams(location.search);
const frameOutput = params.get('output') === 'canvas';
const runtimeMedia = params.get('runtimeMedia') === '1';
const webAudioOutput = params.has('audio') ? params.get('audio') === 'webcodecs' : frameOutput;
const warmObserver = params.has('warm') ? observeWarmStart() : undefined;
const locmafObserver = params.has('locmaf') ? observeLocmafDelivery() : undefined;
const mseProgram = params.has('mseProgram') ? observeMseProgramSwitch() : undefined;
// Shaped-link runs let ABR choose; every other case keeps manual selection.
const abr = params.get('abr') === '1';
canvas.width = 640;
canvas.height = 360;
const canvasObserver = frameOutput ? observeCanvas(canvas) : undefined;
const audioObserver = webAudioOutput ? observeAudio() : undefined;
const decodedSource = frameOutput ? runtimeMedia ? observeProgramDecodedSource() : observeDecodedSource() : undefined;
const pinHex = params.get('hash')!;
if (!/^[a-f0-9]{64}$/.test(pinHex)) throw new Error('Missing local certificate pin');
const pin = Uint8Array.from(pinHex.match(/../g)!, (byte) => parseInt(byte, 16)).buffer;
const nativeMse = params.has('nativeMse') ? observeNativeMse() : undefined;
const groupTail = params.has('groupTail') ? createGroupTailProbe({ catalogIdentity: { namespace: [params.get('ns')!], name: 'catalog' } }) : undefined;
groupTail?.installNative();
const createTransport = createWebTransport({ certHash: pin, draftVersion: 18 });
const transports: WebTransportLike[] = [];
const transportOutcomes: Promise<{ status: string; reason?: string }>[] = [];
const transportState: Array<{ url: string; openedAtMs: number; closedAtMs: number | null }> = [];
const events: { timeMs: number; type: string; data: unknown }[] = [];
const nativeEvents: { timeMs: number; type: string }[] = [];
const samples: PlaybackSample[] = [];
const programWire = runtimeMedia ? observeProgramSwitchWire() : undefined;
let startupError: string | null = null;
let presentedFrames = 0;
let presentedMediaTimeS = 0;
let nativeFrameWidth = 0;
let nativeFrameHeight = 0;
let nativeFrameAtMs = 0;
let callbackHandle = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let recording = false;
const SAMPLE_PERIOD_MS = 250;
let observationStartMs: number | null = null;
let observationEndMs: number | null = null;
let minimumObservationDurationMs: number | null = null;
let previousPixels: Uint8ClampedArray | undefined;
let audioContext: AudioContext | undefined;
let source: MediaElementAudioSourceNode | undefined;
let gain: GainNode | undefined;
let analyser: AnalyserNode | undefined;
let firstFrameTimestampUs: number | undefined;

const player = new Player(null, {
  url: params.get('url')!, namespace: params.get('ns')!,
  video, canvas, certHash: pin, draftVersion: 18, autoQuality: abr,
  ...(params.has('gestureAudio') ? { audioActivation: 'gesture' as const } : {}),
  startLevel: abr && !params.has('level') ? 'auto' : Number(params.get('level') ?? 0),
  ...(params.has('altGroup') ? { videoAltGroup: Number(params.get('altGroup')) } : {}),
  moqtPlayerConfig: {
    logLevel: params.has('debug') ? 'debug' : 'none',
    ...(warmObserver ? { warmStartCurrentGroup: params.get('warm') === '1', objectTransform: warmObserver.transform } : {}),
    ...(groupTail ? { objectTransform: groupTail.transform } : {}),
    locmafDecoding: params.get('locmaf') === 'frame' ? 'frame' : 'mse',
    ...(params.get('runtimeAudio') === '1' || runtimeMedia ? {} : { audioConstraints: { lang: params.get('lang') ?? 'en' } }),
    ...(runtimeMedia ? { selection: { renderGroup: 1, videoAltGroup: 1 } } : {}),
    ...(params.get('debug') === 'handover' || nativeMse || groupTail ? { createMediaSource: () => {
      const source = new MseMediaSource(video, nativeMse || groupTail ? { mseImplementation: 'standard' } : {});
      source.debug = params.has('debug');
      mseProgram?.source(source);
      return groupTail ? groupTail.wrapSource(source) : source;
    } } : {}),
    ...(mseProgram ? { createCmafAssembler: callbacks => mseProgram.createAssembler(callbacks) } : {}),
    ...(decodedSource ? { createVideoDecoder: () => decodedSource.wrap(new WebCodecsVideoDecoder()) } : {}),
    createConnection: () => {
      const connection = new MoqtConnection(18);
      programWire?.connection(connection);
      warmObserver?.connection(connection);
      groupTail?.connection(connection);
      if (warmObserver || locmafObserver) {
        observeConnectionObjects(connection, (stream, object) => {
          const source = warmObserver?.record(connection, stream, object);
          locmafObserver?.record(stream, object, source !== 'fetch');
        });
      }
      return connection;
    },
    createTransport: async (url) => {
      const transport = await createTransport(url);
      transports.push(transport);
      const state = { url, openedAtMs: performance.now(), closedAtMs: null as number | null };
      transportState.push(state);
      transportOutcomes.push(transport.closed!.then(
        () => { state.closedAtMs = performance.now(); return { status: 'closed' }; },
        (error: unknown) => { state.closedAtMs = performance.now(); return { status: 'rejected', reason: String(error) }; },
      ));
      return transport;
    },
  },
});

groupTail?.observeDiagnostics(player.diagnosticSource, createMediaDiagnostics);

// Engine-level ABR evidence: the switch reason and stall episodes are not
// carried by the facade's `qualitychange`/`stall` events.
const abrTrace: { timeMs: number; type: string; data: unknown }[] = [];
if (abr) {
  for (const type of ['quality_switching', 'quality_switched', 'quality_switch_failed', 'stall', 'stall_recovered',
    'catch_up_changed'] as const) {
    player.diagnosticSource.on(type, data => abrTrace.push({ timeMs: performance.now(), type,
      data: 'error' in data ? { ...data, error: String(data.error) } : data }));
  }
  player.on('stats', stats => abrTrace.push({ timeMs: performance.now(), type: 'stats', data: {
    bitrate: stats.bitrate, latencyMs: stats.latencyMs, captureTimestampAgeMs: stats.captureTimestampAgeMs ?? null,
    stallCount: stats.stallCount, framesDropped: stats.framesDropped, resolution: stats.resolution } }));
}

for (const type of ['ready', 'playing', 'statechange', 'error', 'stall', 'qualitychange', 'audiochange', 'audiochangefailed',
  'programchange', 'programchangefailed', 'viewchange', 'viewchangefailed'] as const) {
  player.on(type, (data) => events.push({ timeMs: performance.now(), type, data }));
}
if (runtimeMedia) for (const type of ['pause', 'play'] as const) {
  player.on(type, data => events.push({ timeMs: performance.now(), type, data }));
}
for (const type of ['error', 'waiting', 'stalled']) {
  video.addEventListener(type, () => {
    if (recording) nativeEvents.push({ timeMs: performance.now(), type });
  });
}
player.on('ready', () => {
  const expectedOutput = frameOutput ? 'canvas' : 'video';
  if (player.activeMediaType !== expectedOutput) {
    startupError = `Expected ${expectedOutput} output, got ${player.activeMediaType}`;
  }
  canvas.hidden = !frameOutput;
  video.hidden = frameOutput;
});

const probeCanvas = document.createElement('canvas');
probeCanvas.width = 64;
probeCanvas.height = 36;
const probe = probeCanvas.getContext('2d', { willReadFrequently: true })!;

function observeFrame(_time: number, metadata: VideoFrameCallbackMetadata): void {
  presentedFrames = metadata.presentedFrames;
  presentedMediaTimeS = metadata.mediaTime;
  nativeFrameWidth = metadata.width;
  nativeFrameHeight = metadata.height;
  nativeFrameAtMs = performance.now();
  callbackHandle = video.requestVideoFrameCallback(observeFrame);
}
if (!frameOutput) callbackHandle = video.requestVideoFrameCallback(observeFrame);

function audioRms(): number {
  if (!analyser) return 0;
  const waveform = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(waveform);
  return Math.sqrt(waveform.reduce((sum, value) => sum + value * value, 0) / waveform.length);
}

function sample(): void {
  if (!recording || !analyser) return;
  probe.drawImage(frameOutput ? canvas : video, 0, 0, 64, 36);
  if (canvasObserver) {
    firstFrameTimestampUs ??= canvasObserver.timestampUs;
    presentedFrames = canvasObserver.frames;
    presentedMediaTimeS = (canvasObserver.timestampUs - firstFrameTimestampUs) / 1_000_000;
  }
  const pixels = probe.getImageData(0, 0, 64, 36).data;
  let hash = 2166136261;
  let difference = 0;
  for (let i = 0; i < pixels.length; i++) {
    if (i % 4 === 3) continue;
    hash = Math.imul(hash ^ pixels[i]!, 16777619);
    if (previousPixels) difference += Math.abs(pixels[i]! - previousPixels[i]!);
  }
  const marker = (2 * 64 + 2) * 4;
  const markerRgb = Array.from(pixels.slice(marker, marker + 3));
  previousPixels = pixels;
  const spectrum = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(spectrum);
  const rms = audioRms();
  let peak = 0;
  for (let i = 1; i < spectrum.length; i++) if (spectrum[i]! > spectrum[peak]!) peak = i;
  const ranges = video.buffered;
  const presentation = player.videoPresentation;
  samples.push({
    outputKind: frameOutput ? 'canvas' : 'video',
    wallMs: performance.now(), wallEpochMs: Date.now(), mediaTimeS: frameOutput ? player.currentTime / 1000 : video.currentTime,
    presentedMediaTimeS, presentedFrames, pictureDigest: (hash >>> 0).toString(16),
    pictureChange: difference / (64 * 36 * 3), markerRgb,
    videoWidth: canvasObserver?.width ?? video.videoWidth, videoHeight: canvasObserver?.height ?? video.videoHeight,
    ...(!frameOutput ? { nativeFrameWidth, nativeFrameHeight, nativeFrameAtMs } : {}),
    audioContextTimeS: audioContext!.currentTime,
    ...(nativeMse ? { nativeTimestampOffsets: nativeMse.snapshot().buffers.map(buffer => buffer.offset) } : {}),
    ...(canvasObserver ? { frameTimestampUs: canvasObserver.timestampUs } : {}),
    ...(canvasObserver?.lastDrawTimestampUs !== undefined ? { nativeDrawTimestampUs: canvasObserver.lastDrawTimestampUs } : {}),
    ...(canvasObserver?.lastDrawTimeMs !== undefined ? { nativeDrawTimeMs: canvasObserver.lastDrawTimeMs } : {}),
    videoPresentation: presentation ? {
      frameTimestampUs: presentation.frameTimestampUs?.toString() ?? null,
      timestampDomain: presentation.timestampDomain,
      renderedAtUs: presentation.renderedAtUs,
    } : null,
    audioRms: rms, audioPeakHz: rms > 0.015 ? peak * audioContext!.sampleRate / analyser.fftSize : 0,
    paused: frameOutput ? player.state !== 'playing' : video.paused, seeking: frameOutput ? false : video.seeking,
    visibility: document.visibilityState,
    bufferedRanges: frameOutput ? null : Array.from({ length: ranges.length }, (_, i) => ({ start: ranges.start(i), end: ranges.end(i) })),
  });
}

document.querySelector('#start')!.addEventListener('click', () => {
  void (async () => {
    if (!webAudioOutput) {
      audioContext = new AudioContext();
      await audioContext.resume();
      source = audioContext.createMediaElementSource(video);
      gain = audioContext.createGain();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0;
      source.connect(gain).connect(analyser).connect(audioContext.destination);
    }
    await player.load();
    if (params.has('gestureAudio')) await player.unmute();
    player.play();
    if (audioObserver) {
      if (audioObserver.taps.length !== 1) throw new Error(`Expected one player audio output, got ${audioObserver.taps.length}`);
      ({ context: audioContext, analyser } = audioObserver.taps[0]!);
    }
  })().catch((error: unknown) => { startupError = String(error); });
}, { once: true });

function playbackQuality() {
  const native = () => {
    const value = video.getVideoPlaybackQuality?.();
    return value ? { totalVideoFrames: value.totalVideoFrames, droppedVideoFrames: value.droppedVideoFrames,
      displayedVideoFrames: value.totalVideoFrames - value.droppedVideoFrames, creationTimeMs: value.creationTime } : null;
  };
  const before = native();
  const reported = player.stats.videoPlaybackQuality ?? null;
  return { before, reported, after: native() };
}

function snapshot() {
  const locmafDelivery = locmafObserver?.snapshot();
  const audioObservation: AudioObservationWindow | null = observationStartMs !== null
    && observationEndMs !== null && minimumObservationDurationMs !== null
    ? { startMs: observationStartMs, endMs: observationEndMs,
      minimumDurationMs: minimumObservationDurationMs, samplePeriodMs: SAMPLE_PERIOD_MS } : null;
  // Older snapshot producers carry no declared window; absence cannot qualify audio evidence.
  const audioEvidence: { audioObservation?: AudioObservationWindow | null } = { audioObservation };
  return { ...(groupTail ? { groupTail: groupTail.snapshot() } : {}), samples: [...samples], ...audioEvidence, events: [...events], startupError, transportState: [...transportState],
    nativeEvents: [...nativeEvents], nativeError: video.error ? { code: video.error.code, message: video.error.message } : null,
    nativeMse: nativeMse?.snapshot() ?? null,
    warmStart: warmObserver?.snapshot() ?? null,
    programWire: programWire?.snapshot() ?? null,
    playbackQuality: playbackQuality(),
    outputState: { presentedFrames: canvasObserver?.frames ?? presentedFrames,
      currentTime: player.currentTime, audioRms: audioRms(), audioContext: audioContext?.state,
      videoPaused: video.paused, videoTime: video.currentTime, videoReadyState: video.readyState,
      buffered: Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]) },
    decodedSource: decodedSource?.snapshot() ?? null,
    ...(locmafDelivery ? { locmafDelivery, locmafFailures: assessLocmafDelivery(locmafDelivery) } : {}),
    levels: player.levels, videoGroups: player.videoGroups, audioTracks: player.audioTracks };
}

const acceptance = {
  ...(mseProgram ? mseProgram.pageHooks(player) : {}),
  get startupError() { return startupError; },
  get warmReceipts() { return warmObserver?.snapshot().received ?? []; },
  get presentedFrames() { return canvasObserver?.frames ?? presentedFrames; },
  get currentTime() { return frameOutput ? player.currentTime / 1000 : video.currentTime; },
  get audioRms() { return audioRms(); },
  get transportState() { return transportState.map(state => ({ ...state })); },
  get errors() { return events.filter(event => event.type === 'error'); },
  get latestSample() { return samples.at(-1); },
  get abrTrace() { return { timeOrigin: performance.timeOrigin, events: abrTrace.slice() }; },
  get playback() { return playbackPoint(); },
  pausePlayback() {
    const actionAtMs = performance.now(); player.pause();
    return { ...playbackPoint(), actionAtMs };
  },
  resumePlayback() {
    const actionAtMs = performance.now(); player.play();
    return { ...playbackPoint(), actionAtMs };
  },
  get selection() { return { levels: player.levels, currentLevel: player.currentLevel, autoQuality: player.autoQuality,
    currentAudioTrack: player.currentAudioTrack, currentAudioTrackId: player.audioTracks[player.currentAudioTrack]?.id ?? null,
    audioTracks: player.audioTracks }; },
  get mediaSelection() { return { programs: player.programs, views: player.views,
    currentProgram: player.currentProgram, currentView: player.currentView,
    currentAudioTrackId: player.audioTracks[player.currentAudioTrack]?.id ?? null }; },
  async setQuality(index: number) { await player.setQuality(index); },
  async setAudioTrack(index: number) { await player.setAudioTrack(index); },
  async selectAudioTrack(id: string, options?: Parameters<Player['selectAudioTrack']>[1]) {
    await player.selectAudioTrack(id, options);
  },
  async selectAudioTrackMapped(id: string, sourceTimeUs: string, referenceTimeUs: string) {
    // First access may only arm source-time collection. Wait for actual
    // continuing audio to publish a reference; elapsed time is not an anchor.
    let reference = player.audioTimelineReference;
    const deadline = performance.now() + 5_000;
    while (reference === null && performance.now() < deadline) {
      await new Promise<void>(resolve => { setTimeout(resolve, 50); });
      reference = player.audioTimelineReference;
    }
    if (performance.now() >= deadline) throw new Error('Audio timeline reference readiness exceeded the 5s deadline');
    if (reference === null) throw new Error('Current audio has no adopted raw timeline reference');
    // The opaque owner token stays in this realm. Only application anchors
    // and descriptive evidence cross the Playwright boundary.
    await player.selectAudioTrack(id, { timeline: { kind: 'reference-map', referenceToken: reference.token,
      sourceTimeUs: BigInt(sourceTimeUs), referenceTimeUs: BigInt(referenceTimeUs) } });
    return { track: reference.track, domain: reference.domain, observedSourceTimeUs: String(reference.observedSourceTimeUs),
      sourceTimeUs, referenceTimeUs };
  },
  async selectProgramMapped(renderGroup: number, anchors: MediaMapAnchors) {
    const program = player.programs.find(item => item.renderGroup === renderGroup);
    if (!program) throw new Error(`Missing program render group ${renderGroup}`);
    const reference = await mediaReference();
    await player.selectProgram(program.id, { timeline: { kind: 'reference-map', referenceToken: reference.token, ...rawAnchors(anchors) } });
    return { id: program.id, track: reference.track, domain: reference.domain,
      observedSourceTimeUs: String(reference.observedSourceTimeUs), anchors };
  },
  async selectViewMapped(trackName: string, anchors: MediaMapAnchors) {
    const view = player.views.find(item => item.levels.some(level => level.trackName === trackName));
    if (!view) throw new Error(`Missing view track ${trackName}`);
    const reference = await mediaReference();
    await player.selectView(view.id, { timeline: { kind: 'reference-map', referenceToken: reference.token, ...rawAnchors(anchors) } });
    return { id: view.id, track: reference.track, domain: reference.domain,
      observedSourceTimeUs: String(reference.observedSourceTimeUs), anchors };
  },
  snapshot,
  get tailSnapshot() { return groupTail?.snapshot() ?? null; },
  get tailBoundarySettled() { return groupTail?.boundarySettled() ?? false; },
  armTail(mode: 'ordinary' | 'held') { if (!groupTail) throw new Error('Tail probe not enabled'); return groupTail.arm(mode); },
  async settleTailHashes() { await groupTail?.settleHashes(); },
  async settleTailObservations(checkpoint: TailCheckpoint) { await groupTail?.settleObservations(checkpoint); },
  begin(silent: boolean, minimumDurationMs?: number): void {
    if (recording) throw new Error('Observation already recording');
    if (minimumDurationMs !== undefined && (!Number.isFinite(minimumDurationMs) || minimumDurationMs <= 0)) {
      throw new Error('Observation duration must be finite and positive');
    }
    if (webAudioOutput) { if (silent) player.mute(); }
    else gain!.gain.value = silent ? 0 : 1;
    samples.length = 0;
    nativeEvents.length = 0;
    previousPixels = undefined;
    minimumObservationDurationMs = minimumDurationMs ?? null;
    observationEndMs = null;
    recording = true;
    observationStartMs = performance.now();
    sample();
    timer = setInterval(sample, SAMPLE_PERIOD_MS);
  },
  finish() {
    const wasRecording = recording;
    recording = false;
    clearInterval(timer);
    if (wasRecording) observationEndMs = performance.now();
    return snapshot();
  },
  setVolume(value: number) { player.setVolume(value); },
  async setMuted(value: boolean) { if (value) player.mute(); else await player.unmute(); },
  async destroy() {
    const wasRecording = recording;
    recording = false;
    clearInterval(timer);
    if (wasRecording) observationEndMs = performance.now();
    video.cancelVideoFrameCallback(callbackHandle);
    groupTail?.cancel();
    await groupTail?.settleObservations('before-player-destroy');
    await player.destroy();
    mseProgram?.dispose();
    programWire?.dispose();
    await groupTail?.settleObservations('after-player-destroy');
    groupTail?.restore();
    nativeMse?.restore();
    source?.disconnect();
    gain?.disconnect();
    analyser?.disconnect();
    if (!webAudioOutput) await audioContext?.close();
    canvasObserver?.restore();
    audioObserver?.restore();
    const outcomes = await Promise.all(transportOutcomes);
    return {
      state: player.state, transports: transports.length,
      transportOutcomes: outcomes, events: [...events],
      audioState: audioContext?.state, videoSource: video.getAttribute('src'),
      groupTail: groupTail?.snapshot() ?? null,
    };
  },
};

function playbackPoint() {
  return { timeMs: performance.now(), state: player.state,
    presentedFrames: canvasObserver?.frames ?? presentedFrames,
    nativeDrawTimestampUs: canvasObserver?.lastDrawTimestampUs ?? null,
    nativeDrawTimeMs: canvasObserver?.lastDrawTimeMs ?? null,
    currentProgram: player.currentProgram, currentView: player.currentView,
    currentAudioTrackId: player.audioTracks[player.currentAudioTrack]?.id ?? null };
}

interface MediaMapAnchors {
  video?: { sourceTimeUs: string; referenceTimeUs: string };
  audio?: { sourceTimeUs: string; referenceTimeUs: string };
}
function rawAnchors(anchors: MediaMapAnchors) {
  const parse = (anchor: { sourceTimeUs: string; referenceTimeUs: string }) => {
    if (!/^\d+$/.test(anchor.sourceTimeUs) || !/^\d+$/.test(anchor.referenceTimeUs)) throw new Error('Invalid raw media anchor');
    return { sourceTimeUs: BigInt(anchor.sourceTimeUs), referenceTimeUs: BigInt(anchor.referenceTimeUs) };
  };
  return { ...(anchors.video ? { video: parse(anchors.video) } : {}), ...(anchors.audio ? { audio: parse(anchors.audio) } : {}) };
}
async function mediaReference() {
  // Keep the opaque canonical token in this realm; no clock or serialized replacement token.
  let reference = player.mediaTimelineReference;
  const deadline = performance.now() + 5_000;
  while (reference === null && performance.now() < deadline) {
    await new Promise<void>(resolve => { setTimeout(resolve, 50); });
    reference = player.mediaTimelineReference;
  }
  if (performance.now() >= deadline) throw new Error('Media timeline reference readiness exceeded the 5s deadline');
  if (reference === null) throw new Error('Current media has no adopted raw timeline reference');
  return reference;
}

declare global {
  interface Window { playerAcceptance: typeof acceptance }
}
window.playerAcceptance = acceptance;
