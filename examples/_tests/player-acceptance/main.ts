import { Player } from '@openmoq/playa';
import { createWebTransport } from '@openmoq/browser';
import type { WebTransportLike } from '@openmoq/webtransport';

interface Sample {
  wallMs: number;
  mediaTimeS: number;
  presentedMediaTimeS: number;
  presentedFrames: number;
  pictureDigest: string;
  pictureChange: number;
  markerMatches: boolean;
  audioRms: number;
  audioPeakHz: number;
  paused: boolean;
  seeking: boolean;
  visibility: string;
  bufferedRanges: { start: number; end: number }[];
}

const video = document.querySelector<HTMLVideoElement>('#video')!;
const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const params = new URLSearchParams(location.search);
const pinHex = params.get('hash')!;
if (!/^[a-f0-9]{64}$/.test(pinHex)) throw new Error('Missing local certificate pin');
const pin = Uint8Array.from(pinHex.match(/../g)!, (byte) => parseInt(byte, 16)).buffer;
const createTransport = createWebTransport({ certHash: pin, draftVersion: 18 });
const transports: WebTransportLike[] = [];
const transportOutcomes: Promise<{ status: string; reason?: string }>[] = [];
const events: { timeMs: number; type: string; data: unknown }[] = [];
const samples: Sample[] = [];
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

const player = new Player(null, {
  url: params.get('url')!, namespace: params.get('ns')!,
  video, canvas, certHash: pin, draftVersion: 18, autoQuality: false,
  moqtPlayerConfig: {
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

const probeCanvas = document.createElement('canvas');
probeCanvas.width = 64;
probeCanvas.height = 36;
const probe = probeCanvas.getContext('2d', { willReadFrequently: true })!;

function observeFrame(_time: number, metadata: VideoFrameCallbackMetadata): void {
  presentedFrames = metadata.presentedFrames;
  presentedMediaTimeS = metadata.mediaTime;
  callbackHandle = video.requestVideoFrameCallback(observeFrame);
}
callbackHandle = video.requestVideoFrameCallback(observeFrame);

function sample(): void {
  if (!recording || !analyser) return;
  probe.drawImage(video, 0, 0, 64, 36);
  const pixels = probe.getImageData(0, 0, 64, 36).data;
  let hash = 2166136261;
  let difference = 0;
  for (let i = 0; i < pixels.length; i++) {
    if (i % 4 === 3) continue;
    hash = Math.imul(hash ^ pixels[i]!, 16777619);
    if (previousPixels) difference += Math.abs(pixels[i]! - previousPixels[i]!);
  }
  const marker = (2 * 64 + 2) * 4;
  const markerMatches = pixels[marker]! < 60 && pixels[marker + 1]! > 180 && pixels[marker + 2]! < 60;
  previousPixels = pixels;
  const waveform = new Float32Array(analyser.fftSize);
  const spectrum = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatTimeDomainData(waveform);
  analyser.getFloatFrequencyData(spectrum);
  const audioRms = Math.sqrt(waveform.reduce((sum, value) => sum + value * value, 0) / waveform.length);
  let peak = 0;
  for (let i = 1; i < spectrum.length; i++) if (spectrum[i]! > spectrum[peak]!) peak = i;
  const ranges = video.buffered;
  samples.push({
    wallMs: performance.now(), mediaTimeS: video.currentTime,
    presentedMediaTimeS, presentedFrames, pictureDigest: (hash >>> 0).toString(16),
    pictureChange: difference / (64 * 36 * 3), markerMatches,
    audioRms, audioPeakHz: audioRms > 0.015 ? peak * audioContext!.sampleRate / analyser.fftSize : 0,
    paused: video.paused, seeking: video.seeking, visibility: document.visibilityState,
    bufferedRanges: Array.from({ length: ranges.length }, (_, i) => ({ start: ranges.start(i), end: ranges.end(i) })),
  });
}

document.querySelector('#start')!.addEventListener('click', () => {
  void (async () => {
    audioContext = new AudioContext();
    await audioContext.resume();
    source = audioContext.createMediaElementSource(video);
    gain = audioContext.createGain();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;
    source.connect(gain).connect(analyser).connect(audioContext.destination);
    await player.load();
    player.play();
  })().catch((error: unknown) => { startupError = String(error); });
}, { once: true });

const acceptance = {
  get startupError() { return startupError; },
  get presentedFrames() { return presentedFrames; },
  get currentTime() { return video.currentTime; },
  begin(silent: boolean): void {
    gain!.gain.value = silent ? 0 : 1;
    samples.length = 0;
    previousPixels = undefined;
    recording = true;
    sample();
    timer = setInterval(sample, 250);
  },
  finish() {
    recording = false;
    clearInterval(timer);
    return { samples: [...samples], events: [...events], startupError };
  },
  async destroy() {
    recording = false;
    clearInterval(timer);
    video.cancelVideoFrameCallback(callbackHandle);
    await player.destroy();
    source?.disconnect();
    gain?.disconnect();
    analyser?.disconnect();
    await audioContext?.close();
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
