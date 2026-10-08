import { Player } from '@openmoq/playa';
import { createWebTransport, WebCodecsVideoDecoder } from '@openmoq/browser';
import { MoqtConnection, type WebTransportLike } from '@openmoq/webtransport';
import type { PlaybackSample } from '../../../scripts/player-acceptance/assessment.mjs';
import { observeAudio, observeCanvas } from './sinks.js';
import { observeLocmafDelivery, assessLocmafDelivery, observeConnectionObjects } from './received.js';
import { observeDecodedSource } from './decoded.js';

const video = document.querySelector<HTMLVideoElement>('#video')!;
const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const params = new URLSearchParams(location.search);
const frameOutput = params.get('output') === 'canvas';
const webAudioOutput = params.has('audio') ? params.get('audio') === 'webcodecs' : frameOutput;
const locmafObserver = params.has('locmaf') ? observeLocmafDelivery() : undefined;
canvas.width = 640;
canvas.height = 360;
const canvasObserver = frameOutput ? observeCanvas(canvas) : undefined;
const audioObserver = webAudioOutput ? observeAudio() : undefined;
const decodedSource = frameOutput ? observeDecodedSource() : undefined;
const pinHex = params.get('hash')!;
if (!/^[a-f0-9]{64}$/.test(pinHex)) throw new Error('Missing local certificate pin');
const pin = Uint8Array.from(pinHex.match(/../g)!, (byte) => parseInt(byte, 16)).buffer;
const createTransport = createWebTransport({ certHash: pin, draftVersion: 18 });
const transports: WebTransportLike[] = [];
const transportOutcomes: Promise<{ status: string; reason?: string }>[] = [];
const events: { timeMs: number; type: string; data: unknown }[] = [];
const samples: PlaybackSample[] = [];
let startupError: string | null = null;
let presentedFrames = 0;
let presentedMediaTimeS = 0;
let callbackHandle = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let recording = false;
let previousPixels: Uint8ClampedArray | undefined;
let audioContext: AudioContext | undefined;
let source: MediaElementAudioSourceNode | undefined;
let gain: GainNode | undefined;
let analyser: AnalyserNode | undefined;
let firstFrameTimestampUs: number | undefined;

const player = new Player(null, {
  url: params.get('url')!, namespace: params.get('ns')!,
  video, canvas, certHash: pin, draftVersion: 18, autoQuality: false,
  ...(params.has('gestureAudio') ? { audioActivation: 'gesture' as const } : {}),
  startLevel: Number(params.get('level') ?? 0),
  ...(params.has('altGroup') ? { videoAltGroup: Number(params.get('altGroup')) } : {}),
  moqtPlayerConfig: {
    logLevel: params.has('debug') ? 'debug' : 'none',
    locmafDecoding: params.get('locmaf') === 'frame' ? 'frame' : 'mse',
    audioConstraints: { lang: params.get('lang') ?? 'en' },
    ...(decodedSource ? { createVideoDecoder: () => decodedSource.wrap(new WebCodecsVideoDecoder()) } : {}),
    createConnection: () => {
      const connection = new MoqtConnection(18);
      if (locmafObserver) {
        observeConnectionObjects(connection, locmafObserver.record);
      }
      return connection;
    },
    createTransport: async (url) => {
      const transport = await createTransport(url);
      transports.push(transport);
      transportOutcomes.push(transport.closed!.then(
        () => ({ status: 'closed' }),
        (error: unknown) => ({ status: 'rejected', reason: String(error) }),
      ));
      return transport;
    },
  },
});

for (const type of ['ready', 'playing', 'statechange', 'error', 'stall'] as const) {
  player.on(type, (data) => events.push({ timeMs: performance.now(), type, data }));
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

const acceptance = {
  get startupError() { return startupError; },
  get presentedFrames() { return canvasObserver?.frames ?? presentedFrames; },
  get currentTime() { return frameOutput ? player.currentTime / 1000 : video.currentTime; },
  get audioRms() { return audioRms(); },
  begin(silent: boolean): void {
    if (webAudioOutput) { if (silent) player.mute(); }
    else gain!.gain.value = silent ? 0 : 1;
    samples.length = 0;
    previousPixels = undefined;
    recording = true;
    sample();
    timer = setInterval(sample, 250);
  },
  finish() {
    recording = false;
    clearInterval(timer);
    const locmafDelivery = locmafObserver?.snapshot();
    return { samples: [...samples], events: [...events], startupError,
      outputState: { presentedFrames: canvasObserver?.frames ?? presentedFrames,
        currentTime: player.currentTime, audioRms: audioRms(), audioContext: audioContext?.state,
        videoPaused: video.paused, videoTime: video.currentTime, videoReadyState: video.readyState,
        buffered: Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]) },
      decodedSource: decodedSource?.snapshot() ?? null,
      ...(locmafDelivery ? { locmafDelivery, locmafFailures: assessLocmafDelivery(locmafDelivery) } : {}),
      levels: player.levels, videoGroups: player.videoGroups, audioTracks: player.audioTracks };
  },
  setVolume(value: number) { player.setVolume(value); },
  async setMuted(value: boolean) { if (value) player.mute(); else await player.unmute(); },
  async destroy() {
    recording = false;
    clearInterval(timer);
    video.cancelVideoFrameCallback(callbackHandle);
    await player.destroy();
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
    };
  },
};

declare global {
  interface Window { playerAcceptance: typeof acceptance }
}
window.playerAcceptance = acceptance;
