// A PLAIN application page: the same real `@openmoq/playa` player as the live gate, with NO diagnostics import and NO
// install call — the page an application ships when it never opted in. It exists for the negatives gate, which proves
// that the extension cannot discover or attach to it, that no diagnostic observer is created and that playback goes
// on unchanged. Built minified by the gate's production step. Query: url, ns, hash (cert pin hex).
import { Player } from '@openmoq/playa';
import type { PlayerEventMap } from '@openmoq/playa';

const video = document.querySelector<HTMLVideoElement>('#video')!;
const status = document.querySelector<HTMLPreElement>('#status')!;
const params = new URLSearchParams(location.search);
const pinHex = params.get('hash') ?? '';
if (!/^[a-f0-9]{64}$/.test(pinHex)) throw new Error('Missing local certificate pin');
const pin = Uint8Array.from(pinHex.match(/../g)!, byte => parseInt(byte, 16)).buffer;

type EventRecord = { t: number; type: keyof PlayerEventMap; detail?: string };
const events: EventRecord[] = [];
const remember = (type: keyof PlayerEventMap, detail?: string) => { if (events.length >= 256) events.shift(); events.push({ t: performance.now(), type, ...(detail !== undefined ? { detail } : {}) }); };

const player = new Player(null, {
  url: params.get('url') ?? '', namespace: params.get('ns') ?? '', video,
  certHash: pin, draftVersion: 18, autoQuality: false, startLevel: 0,
  moqtPlayerConfig: { logLevel: 'none', locmafDecoding: 'mse' },
});
player.on('ready', e => remember('ready', `${e.levels.length} levels`));
player.on('statechange', e => { remember('statechange', e.state); status.textContent = player.state; });
player.on('playing', () => remember('playing'));
player.on('error', e => { remember('error', e.message); status.textContent = `error · ${e.message}`; });

const rvfc = { presentedFrames: 0, mediaTime: 0, callbacks: 0 };
if (typeof video.requestVideoFrameCallback === 'function') {
  const onFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => { rvfc.presentedFrames = metadata.presentedFrames; rvfc.mediaTime = metadata.mediaTime; rvfc.callbacks++; video.requestVideoFrameCallback(onFrame); };
  video.requestVideoFrameCallback(onFrame);
}
const live = {
  get state() { return player.state; },
  get events() { return events; },
  get error() { return events.filter(e => e.type === 'error').at(-1)?.detail ?? null; },
  installed: false, bridgeInstalled: false, output: 'video',
  stats: () => player.stats,
  currentTime: () => video.currentTime,
  rvfc: () => ({ ...rvfc }),
  // The engine's PUBLIC diagnostic snapshot carries `mediaStages` only once a media-stage tracker was created by
  // installed tooling; its absence here is the app-side witness that nothing observes this player.
  diagnosticSnapshot: () => { const s = player.diagnosticSource.diagnosticSnapshot(); return { hasMediaStages: 'mediaStages' in s, connections: s.connections.length, destroyed: s.destroyed }; },
};
(window as unknown as { live: typeof live }).live = live;
document.querySelector<HTMLButtonElement>('#start')!.addEventListener('click', async () => {
  try { await player.load(); player.play(); status.textContent = player.state; }
  catch (error) { status.textContent = `error · ${(error as Error)?.message ?? error}`; remember('error', String((error as Error)?.message ?? error)); }
});
