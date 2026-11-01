// TWO real `@openmoq/playa` players on one page, both opted in to ONE diagnostic registry exactly as an application
// would (`installPlayerDiagnostics` per player, one `installDiagnosticBridge`). The negatives gate uses it to prove
// that switching sources isolates target/source/run identity and that a duplicate registration of the same player —
// through its facade and through its engine — is refused by the real API with the original intact.
// Query: urlA, nsA, urlB, nsB, hash (cert pin hex), exposure.
import { Player } from '@openmoq/playa';
import type { PlayerEventMap } from '@openmoq/playa';
import { installPlayerDiagnostics } from '@openmoq/devtools/player';
import { DiagnosticRegistry, installDiagnosticBridge } from '@openmoq/devtools';

const params = new URLSearchParams(location.search);
const pinHex = params.get('hash') ?? '';
if (!/^[a-f0-9]{64}$/.test(pinHex)) throw new Error('Missing local certificate pin');
const pin = Uint8Array.from(pinHex.match(/../g)!, byte => parseInt(byte, 16)).buffer;
const exposure: 'development' | 'production' = params.get('exposure') === 'production' ? 'production' : 'development';
const registry = new DiagnosticRegistry();

type EventRecord = { t: number; type: keyof PlayerEventMap; detail?: string };
function makePlayer(id: 'a' | 'b') {
  const video = document.querySelector<HTMLVideoElement>(`#video-${id}`)!;
  const status = document.querySelector<HTMLPreElement>(`#status-${id}`)!;
  const events: EventRecord[] = [];
  const remember = (type: keyof PlayerEventMap, detail?: string) => { if (events.length >= 256) events.shift(); events.push({ t: performance.now(), type, ...(detail !== undefined ? { detail } : {}) }); };
  const player = new Player(null, {
    url: params.get(`url${id.toUpperCase()}`) ?? '', namespace: params.get(`ns${id.toUpperCase()}`) ?? '', video,
    certHash: pin, draftVersion: 18, autoQuality: false, startLevel: 0,
    moqtPlayerConfig: { logLevel: 'none', locmafDecoding: 'mse' },
  });
  player.on('statechange', e => { remember('statechange', e.state); status.textContent = player.state; });
  player.on('error', e => { remember('error', e.message); status.textContent = `error · ${e.message}`; });
  const installation = installPlayerDiagnostics(player, { registry, exposure, video, modules: [{ name: `two-players-${id}`, version: '0', buildId: null }] });
  const rvfc = { presentedFrames: 0, mediaTime: 0 };
  if (typeof video.requestVideoFrameCallback === 'function') {
    const onFrame = (_now: number, m: VideoFrameCallbackMetadata) => { rvfc.presentedFrames = m.presentedFrames; rvfc.mediaTime = m.mediaTime; video.requestVideoFrameCallback(onFrame); };
    video.requestVideoFrameCallback(onFrame);
  }
  return {
    player, video, installation,
    view: () => ({ state: player.state, error: events.filter(e => e.type === 'error').at(-1)?.detail ?? null, t: video.currentTime, rvfc: { ...rvfc }, sourceId: installation.source.sourceId, runId: installation.source.runId,
      objectsReceived: player.diagnosticSource.stats.objectsReceived }),
    start: async () => { await player.load(); player.play(); status.textContent = player.state; },
  };
}
const a = makePlayer('a'), b = makePlayer('b');
installDiagnosticBridge(registry);

/** The real API's answer to registering the SAME player again — once through its facade, once through its engine. */
const duplicate = () => {
  const attempt = (label: string, fn: () => unknown) => { try { fn(); return { label, refused: false, message: null }; } catch (e) { return { label, refused: true, message: String((e as Error)?.message ?? e) }; } };
  return [attempt('facade A again', () => installPlayerDiagnostics(a.player, { registry, exposure, video: a.video })),
    attempt('engine of A (diagnosticSource) against the same registry', () => installPlayerDiagnostics(a.player.diagnosticSource, { registry, exposure }))];
};
const live = {
  installed: true, bridgeInstalled: true, exposure,
  a: () => a.view(), b: () => b.view(),
  duplicate,
};
(window as unknown as { live: typeof live }).live = live;
document.querySelector<HTMLButtonElement>('#start')!.addEventListener('click', async () => {
  for (const p of [a, b]) { try { await p.start(); } catch (error) { document.querySelector<HTMLPreElement>(p === a ? '#status-a' : '#status-b')!.textContent = `error · ${(error as Error)?.message ?? error}`; } }
});
