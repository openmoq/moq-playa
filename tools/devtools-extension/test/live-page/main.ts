// The live-gate page: a REAL Playa player (facade) playing the toy relay's
// fixture, with diagnostics installed EXPLICITLY the way an application
// would: `installPlayerDiagnostics` from `@openmoq/devtools/player` plus
// `installDiagnosticBridge` on an attached-source registry. Nothing about
// the player is special-cased for the panel; the extension attaches to this
// page like to any other that installed the bridge.
//
// Served by `serve.mjs` (Vite, repo root, `examples/vite.config.ts` aliases
// to workspace sources), or as a minified production build for the
// production arm. Query: url, ns, hash (cert pin hex), output=canvas for the
// genuine LOC/WebCodecs/canvas path (otherwise MSE into <video>), lang for an
// audio-language constraint, exposure=development|production.
import { Player } from '@openmoq/playa';
import type { PlayerEventMap, VideoPresentation } from '@openmoq/playa';
import { installPlayerDiagnostics } from '@openmoq/devtools/player';
import { DiagnosticRegistry, installDiagnosticBridge } from '@openmoq/devtools';

const video = document.querySelector<HTMLVideoElement>('#video')!;
const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const status = document.querySelector<HTMLPreElement>('#status')!;
const params = new URLSearchParams(location.search);
const pinHex = params.get('hash') ?? '';
if (!/^[a-f0-9]{64}$/.test(pinHex)) throw new Error('Missing local certificate pin');
const pin = Uint8Array.from(pinHex.match(/../g)!, byte => parseInt(byte, 16)).buffer;
const exposure: 'development' | 'production' = params.get('exposure') === 'production' ? 'production' : 'development';
const canvasOutput = params.get('output') === 'canvas';
canvas.width = 640; canvas.height = 360;
canvas.hidden = !canvasOutput; video.hidden = canvasOutput;

/** What the browser can decode, read BEFORE playback so a codec-less build fails fast and attributably. */
const codecs = {
  mseH264: typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('video/mp4; codecs="avc1.42c01e"'),
  mseAac: typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"'),
  webCodecsH264: null as boolean | null,
};
if (typeof VideoDecoder !== 'undefined') {
  VideoDecoder.isConfigSupported({ codec: 'avc1.42c01e', codedWidth: 640, codedHeight: 360 })
    .then(r => { codecs.webCodecsH264 = r.supported === true; }, () => { codecs.webCodecsH264 = false; });
} else codecs.webCodecsH264 = false;

type EventRecord = { t: number; type: keyof PlayerEventMap; detail?: string };
const events: EventRecord[] = [];
const remember = (type: keyof PlayerEventMap, detail?: string) => { if (events.length >= 256) events.shift(); events.push({ t: performance.now(), type, ...(detail !== undefined ? { detail } : {}) }); };

const player = new Player(null, {
  url: params.get('url') ?? '', namespace: params.get('ns') ?? '',
  ...(canvasOutput ? { canvas } : { video }),
  certHash: pin, draftVersion: 18, autoQuality: false, startLevel: 0,
  // No audio-language constraint unless asked: the prepared fixture's audio tracks may carry no language tag.
  moqtPlayerConfig: { logLevel: 'none', locmafDecoding: canvasOutput ? 'frame' : 'mse', ...(params.has('lang') ? { audioConstraints: { lang: params.get('lang')! } } : {}) },
});

// The facade's ACTUAL typed events: state comes from `player.state`, never from a cached value.
player.on('ready', e => remember('ready', `${e.levels.length} levels`));
player.on('statechange', e => { remember('statechange', e.state); status.textContent = player.state; });
player.on('playing', () => remember('playing'));
player.on('error', e => { remember('error', e.message); status.textContent = `error · ${e.message}`; });

// Explicit application opt-in. The registry accepts attached sources only; the bridge is a separate step.
// For the canvas path no media element is observed: the adapter must not graph an element playback does not use.
const registry = new DiagnosticRegistry();
const installation = installPlayerDiagnostics(player, { registry, exposure, ...(canvasOutput ? {} : { video }),
  modules: [{ name: 'live-gate-page', version: '0', buildId: null }] });
installDiagnosticBridge(registry);

// The page's OWN presentation evidence for the MSE path (independent of diagnostics, which stop sampling on detach):
// the element's real video-frame callbacks.
const rvfc = { presentedFrames: 0, mediaTime: 0, callbacks: 0 };
if (!canvasOutput && typeof video.requestVideoFrameCallback === 'function') {
  const onFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => { rvfc.presentedFrames = metadata.presentedFrames; rvfc.mediaTime = metadata.mediaTime; rvfc.callbacks++; video.requestVideoFrameCallback(onFrame); };
  video.requestVideoFrameCallback(onFrame);
}
const presentation = (): { frameTimestampUs: string | null; renderedAtUs: number } | null => {
  const p: VideoPresentation | null = player.videoPresentation;
  return p ? { frameTimestampUs: p.frameTimestampUs === null ? null : String(p.frameTimestampUs), renderedAtUs: p.renderedAtUs } : null;
};
const live = {
  get state() { return player.state; },
  get events() { return events; },
  get error() { return events.filter(e => e.type === 'error').at(-1)?.detail ?? null; },
  installed: true, bridgeInstalled: true, sourceId: installation.source.sourceId, runId: installation.source.runId, exposure, output: canvasOutput ? 'canvas' : 'video',
  codecs,
  stats: () => player.stats,
  currentTime: () => (canvasOutput ? player.currentTime / 1000 : video.currentTime),
  presentation,
  rvfc: () => ({ ...rvfc }),
  canvasVisible: () => !canvas.hidden && canvas.getBoundingClientRect().width > 0,
};
(window as unknown as { live: typeof live }).live = live;

document.querySelector<HTMLButtonElement>('#start')!.addEventListener('click', async () => {
  try { await player.load(); player.play(); status.textContent = player.state; }
  catch (error) { status.textContent = `error · ${(error as Error)?.message ?? error}`; remember('error', String((error as Error)?.message ?? error)); }
});
