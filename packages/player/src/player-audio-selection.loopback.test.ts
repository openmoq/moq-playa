/** Actual 16/18/22 SUBSCRIBE bytes and public pipeline/source boundaries. No native PCM claims. */
import { describe, expect, it, vi } from 'vitest';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { encodeLocHeaders, parseLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { LocmafTrackDecoder, parseLocmafTrackContext, readCmafChunkSamples } from '@openmoq/locmaf';
import { audioPeer, audioSelectionFixture, finiteAudioOutputFixture, gate, identity, refs, type AudioDraft, type AudioPath, type AudioRef } from '../test-support/audio-selection.js';
import { MoqtPlayer } from './player.js';
import { PreparedAudioEvidence } from './prepared-audio-evidence.js';
import { PlayerState } from './state.js';

const drafts: AudioDraft[] = [16, 18, 22];
const paths: AudioPath[] = ['cmaf', 'loc', 'locmaf-mse', 'locmaf-frame'];
type Fixture = Awaited<ReturnType<typeof audioSelectionFixture>>;
function watch(promise: Promise<void>) {
  const state: { status: 'pending' | 'fulfilled' | 'rejected'; error?: unknown } = { status: 'pending' };
  void promise.then(() => { state.status = 'fulfilled'; }, error => { state.status = 'rejected'; state.error = error; });
  return state;
}
const audioCount = (f: Fixture) => f.path === 'cmaf' || f.path === 'locmaf-mse'
  ? f.sourceAppends.filter(item => item.media === 'audio').length : f.decodedAudio.length;
function oldIsOwned(f: Fixture) {
  expect(f.player.selection.audio).toEqual(identity(refs.english));
  expect(f.player.selection.video).toEqual(identity(refs.video));
  expect(f.wire.stopped).not.toContain(f.wire.request(refs.english).id);
  expect(f.wire.stopped).not.toContain(f.wire.request(refs.video).id);
  expect(f.wire.requests.filter(item => item.name === refs.video.name)).toHaveLength(1);
  expect(f.transportCalls).toHaveLength(1); expect(f.wire.transport.closeInfo).toBeUndefined();
}
async function oldStillPlays(f: Fixture, object = 1n) {
  const count = audioCount(f);
  await f.sendAudio('english', 70n, object, BigInt(f.nowUs + 20_000)); f.tick(1); await flush(512);
  expect(audioCount(f)).toBe(count + 1); oldIsOwned(f);
}
async function targetMedia(f: Fixture, group = 70n, object = 2n, pts = 10_040_000n) {
  await f.sendAudio('spanish', group, object, pts); f.tick(1); await flush(512);
}
async function primeReference(f: Fixture, origin = 10_000_000n) {
  void f.player.audioTimelineReference;
  await f.sendAudio('english', 70n, 1n, origin + 20_000n); f.tick(1); await flush(512);
  const reference = f.player.audioTimelineReference;
  if (reference === null) throw new Error('Observed, adopted audio has no current public timeline reference');
  expect(reference.track).toEqual(identity(refs.english));
  expect(reference.observedSourceTimeUs).toBe(origin + 20_000n);
  return reference;
}
function outputPresentationUs(f: Fixture) {
  const append = f.sourceAppends.filter(item => item.media === 'audio').at(-1);
  if (!append?.init) throw new Error('No output with its own accepted CMAF Header');
  const context = parseLocmafTrackContext(append.init), sample = readCmafChunkSamples(append.bytes, context).effective;
  return (sample.baseMediaDecodeTime + BigInt(sample.compositionTimeOffsets[0] ?? 0)) * 1_000_000n / BigInt(context.timescale);
}
function rawSpanishPresentationUs(f: Fixture) {
  const object = f.mediaObjects.filter(item => item.name === refs.spanish.name).at(-1);
  if (!object?.payload) throw new Error('No real target media object');
  let bytes = object.payload;
  if (f.path.startsWith('locmaf')) {
    const decoded = new LocmafTrackDecoder(f.headers.spanish).push(object.group, object.object, bytes);
    if (decoded.kind !== 'chunk') throw new Error('Target did not carry a usable full LOCMAF chunk');
    bytes = decoded.bytes;
  }
  const context = parseLocmafTrackContext(f.headers.spanish), sample = readCmafChunkSamples(bytes, context).effective;
  return (sample.baseMediaDecodeTime + BigInt(sample.compositionTimeOffsets[0] ?? 0)) * 1_000_000n / BigInt(context.timescale);
}

async function replacementCatalog(f: Fixture, removed: readonly AudioRef[] = []) {
  const next = f.peers[1]!;
  const migrating = f.player.migrate(next.client), settled = watch(migrating);
  await flush(512); await next.accept(refs.catalog, 500n);
  const catalog: { tracks: Array<{ name: string; namespace: string }> } = JSON.parse(new TextDecoder().decode(f.catalog));
  catalog.tracks = catalog.tracks.filter(track => !removed.some(ref =>
    ref.name === track.name && ref.namespace.join('/') === track.namespace));
  await next.send(refs.catalog, new TextEncoder().encode(JSON.stringify(catalog)), 1n); await flush(512);
  return { next, migrating, settled };
}

async function replacementMedia(f: Fixture, next: Fixture['wire'], kind: 'english' | 'spanish',
  location = { group: 71n, object: 0n }) {
  await next.accept(refs.video, 600n); await next.accept(refs[kind], 601n);
  const pts = BigInt(f.nowUs + 20_000);
  // Continue video Object 0. Audio may continue the same published identity
  // or start a fresh group when the selected identity changes.
  await f.sendVideo(pts, 1n, next); await f.sendAudio(kind, location.group, location.object, pts, next);
  f.tick(1); await flush(512);
  return pts;
}

describe.each(drafts)('audio selection real-wire draft %s fixture controls', draft => {
  it.each(paths)('starts English through the real %s path while keeping the video request', async path => {
    const f = await audioSelectionFixture(draft, { path });
    try {
      expect(f.wire.requests.map(({ name, namespace }) => ({ name, namespace }))).toEqual([
        refs.catalog, refs.video, refs.english,
      ]);
      expect(f.player.selection.audio).toEqual(identity(refs.english));
      expect(f.player.selection.video).toEqual(identity(refs.video));
      expect(f.renderedVideo.map(point => point.timestamp)).toContain(10_000_000);
      if (path === 'cmaf' || path === 'locmaf-mse') {
        expect(f.sourceAppends.filter(item => item.media === 'audio').map(item => item.track)).toEqual([refs.english.name]);
      } else {
        expect(f.decodedAudio.map(point => point.timestamp)).toContain(10_000_000);
        expect(f.scheduledAudio.map(point => point.timestamp)).toContain(10_000_000);
      }
      expect(f.wire.stopped).toEqual([]);
      expect(f.wire.transport.closeInfo).toBeUndefined();
      expect(f.errors).toEqual([]); expect(f.wire.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});

describe('ordinary CMAF source timing cost boundary', () => {
  it('uses no candidate parser before or after a lazy timeline reference read', async () => {
    const inspect = vi.spyOn(PreparedAudioEvidence.prototype, 'inspectCmaf');
    let f: Fixture | undefined;
    try {
      f = await audioSelectionFixture(18, { path: 'cmaf' });
      await f.sendAudio('english', 70n, 1n, 10_040_000n); f.tick(1); await flush(512);
      expect(f.sourceAppends.filter(item => item.media === 'audio')).toHaveLength(2);
      expect(inspect).not.toHaveBeenCalled();
      expect(f.player.audioTimelineReference).toBeNull();
      await f.sendAudio('english', 70n, 2n, 10_060_000n); f.tick(1); await flush(512);
      expect(f.player.audioTimelineReference).toMatchObject({ track: identity(refs.english), observedSourceTimeUs: 10_060_000n });
      expect(f.sourceAppends.filter(item => item.media === 'audio')).toHaveLength(3);
      expect(inspect).not.toHaveBeenCalled();
      expect(f.wire.requests.map(item => item.name)).toEqual([refs.catalog.name, refs.video.name, refs.english.name]);
      expect(f.errors).toEqual([]);
    } finally { await f?.destroy(); inspect.mockRestore(); }
  });
});

describe('audio runtime intent across a real draft-18 handover', () => {
  it('carries manually adopted Spanish instead of reapplying the English startup constraint', async () => {
    const f = await audioSelectionFixture(18, { path: 'loc', config: {
      selection: { videoTrack: refs.video }, audioConstraints: { lang: 'en' },
    } });
    try {
      oldIsOwned(f);
      const selecting = f.player.selectAudioTrack(refs.spanish), chosen = watch(selecting);
      await flush(512); await f.wire.accept(refs.spanish, 301n); await targetMedia(f);
      expect(chosen.status, String(chosen.error)).toBe('fulfilled'); await selecting;
      expect(f.scheduledAudio.at(-1)?.timestamp).toBe(10_040_000);
      const { next, migrating, settled } = await replacementCatalog(f);
      expect(settled.status, String(settled.error)).toBe('pending');
      expect(next.requests.filter(item => item.name === refs.spanish.name)).toHaveLength(1);
      expect(next.requests.filter(item => item.name === refs.english.name)).toHaveLength(0);
      const pts = await replacementMedia(f, next, 'spanish', { group: 70n, object: 3n });
      expect(settled.status, String(settled.error)).toBe('fulfilled'); await migrating;
      f.player.tick(); await flush(512);
      expect(f.player.selection.audio).toEqual(identity(refs.spanish));
      expect(f.player.selection.video).toEqual(identity(refs.video));
      expect(f.decodedAudio.at(-1)?.bytes[1]).toBe(31);
      expect(f.scheduledAudio.at(-1)?.timestamp).toBe(Number(pts));
      expect(f.renderedVideo.at(-1)?.timestamp).toBe(Number(pts));
      expect(next.requests.filter(item => item.name === refs.video.name)).toHaveLength(1);
      expect(f.transportCalls).toHaveLength(2); expect(next.transport.closeInfo).toBeUndefined();
      expect(f.errors).toEqual([]); expect(next.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('allows automatic startup audio to fall back through a surviving member of its established set', async () => {
    const f = await audioSelectionFixture(18, { path: 'loc', config: { selection: { videoTrack: refs.video } } });
    try {
      oldIsOwned(f);
      const { next, migrating, settled } = await replacementCatalog(f, [refs.english, refs.french]);
      expect(settled.status, String(settled.error)).toBe('pending');
      expect(next.requests.filter(item => item.name === refs.spanish.name)).toHaveLength(1);
      const pts = await replacementMedia(f, next, 'spanish');
      expect(settled.status, String(settled.error)).toBe('fulfilled'); await migrating;
      f.player.tick(); await flush(512);
      expect(f.player.selection.audio).toEqual(identity(refs.spanish));
      expect(f.player.selection.video).toEqual(identity(refs.video));
      expect(f.decodedAudio.at(-1)?.bytes[1]).toBe(31);
      expect(f.scheduledAudio.at(-1)?.timestamp).toBe(Number(pts));
      expect(f.renderedVideo.at(-1)?.timestamp).toBe(Number(pts));
      expect(next.requests.filter(item => item.name === refs.video.name)).toHaveLength(1);
      expect(f.transportCalls).toHaveLength(2); expect(next.transport.closeInfo).toBeUndefined();
      expect(f.errors).toEqual([]); expect(next.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('still rejects loss of a genuinely configured audio pin and leaves the old output usable', async () => {
    const f = await audioSelectionFixture(18, { path: 'loc' });
    try {
      const { next, migrating, settled } = await replacementCatalog(f, [refs.english, refs.french]);
      expect(settled.status).toBe('rejected'); await expect(migrating).rejects.toThrow(/audio/i);
      expect(next.requests.filter(item => item.name === refs.spanish.name)).toHaveLength(0);
      const count = f.decodedAudio.length, pts = BigInt(f.nowUs + 20_000);
      await f.sendAudio('english', 70n, 1n, pts); await f.sendVideo(pts, 1n); f.tick(1); await flush(512);
      expect(f.decodedAudio).toHaveLength(count + 1); expect(f.scheduledAudio.at(-1)?.timestamp).toBe(Number(pts));
      expect(f.renderedVideo.at(-1)?.timestamp).toBe(Number(pts));
      expect(f.player.selection.audio).toEqual(identity(refs.english));
      expect(f.player.selection.video).toEqual(identity(refs.video));
      expect(f.wire.stopped).not.toContain(f.wire.request(refs.english).id);
      expect(f.wire.stopped).not.toContain(f.wire.request(refs.video).id);
      expect(f.wire.transport.closeInfo).toBeUndefined(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('still rejects loss of manually adopted Spanish and keeps its old route usable', async () => {
    const f = await audioSelectionFixture(18, { path: 'loc', config: {
      selection: { videoTrack: refs.video }, audioConstraints: { lang: 'en' },
    } });
    try {
      const selecting = f.player.selectAudioTrack(refs.spanish), chosen = watch(selecting);
      await flush(512); await f.wire.accept(refs.spanish, 301n); await targetMedia(f);
      expect(chosen.status, String(chosen.error)).toBe('fulfilled'); await selecting;
      const { next, migrating, settled } = await replacementCatalog(f, [refs.spanish, refs.french]);
      expect(settled.status).toBe('rejected'); await expect(migrating).rejects.toThrow(/audio/i);
      expect(next.requests.filter(item => item.name === refs.english.name)).toHaveLength(0);
      const count = f.decodedAudio.length, pts = BigInt(f.nowUs + 20_000);
      await f.sendAudio('spanish', 70n, 3n, pts); await f.sendVideo(pts, 1n); f.tick(1); await flush(512);
      expect(f.decodedAudio).toHaveLength(count + 1); expect(f.decodedAudio.at(-1)?.bytes[1]).toBe(31);
      expect(f.scheduledAudio.at(-1)?.timestamp).toBe(Number(pts)); expect(f.renderedVideo.at(-1)?.timestamp).toBe(Number(pts));
      expect(f.player.selection.audio).toEqual(identity(refs.spanish));
      expect(f.wire.stopped).not.toContain(f.wire.request(refs.spanish).id);
      expect(f.wire.stopped).not.toContain(f.wire.request(refs.video).id);
      expect(f.wire.transport.closeInfo).toBeUndefined(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});

describe.each(drafts)('same declared audio set draft %s', draft => {
  it('adopts a finite candidate whose sender FIN and DONE overtake its receiver transform', async () => {
    const f = await audioSelectionFixture(draft, { path: 'loc', finite: true });
    const release = f.holdTransform(301n);
    const ended: Array<'audio' | 'video'> = [];
    f.player.on('track_ended', event => { ended.push(event.mediaType); });
    try {
      const selecting = f.player.selectAudioTrack(refs.spanish), settled = watch(selecting);
      await flush(512); await f.wire.accept(refs.spanish, 301n);
      const receipt = await f.sendFiniteAudio('spanish', 70n, 0n, 10_060_000n);
      expect(receipt).toEqual({ senderFinBeforeDone: true, streamCount: 1n, statusCode: 2n });
      expect(f.errors).toEqual([]); expect(f.wire.errors).toEqual([]);
      await oldStillPlays(f);
      expect(settled.status, String(settled.error)).toBe('pending');
      expect(f.mediaObjects.filter(item => item.name === refs.spanish.name)).toEqual([]);
      expect(ended).toEqual([]);
      await f.sendVideo(10_040_000n, 1n); f.player.tick(); await flush(512);
      expect(f.renderedVideo.at(-1)?.timestamp).toBe(10_040_000);
      release(); await flush(1024); f.tick(1); await flush(512);
      expect(settled.status, String(settled.error)).toBe('fulfilled'); await selecting;
      expect(f.player.selection.audio).toEqual(identity(refs.spanish));
      expect(f.decodedAudio.at(-1)?.timestamp).toBe(10_060_000);
      expect(f.scheduledAudio.at(-1)?.timestamp).toBe(10_060_000);
      for (let i = 0; i < 3; i++) { f.player.tick(); await flush(256); }
      expect(ended).toEqual(['audio']);
      await f.sendVideo(10_080_000n, 2n); f.tick(1); await flush(512);
      expect(f.renderedVideo.at(-1)?.timestamp).toBe(10_080_000);
      expect(ended).toEqual(['audio']);
      expect(f.player.selection.video).toEqual(identity(refs.video));
      expect(f.wire.stopped).not.toContain(f.wire.request(refs.video).id);
      expect(f.wire.requests.filter(item => item.name === refs.video.name)).toHaveLength(1);
      expect(f.transportCalls).toHaveLength(1); expect(f.wire.transport.closeInfo).toBeUndefined();
      expect(f.errors).toEqual([]); expect(f.wire.errors).toEqual([]);
    } finally { release(); await f.destroy(); }
  });

  it.each(paths)('adopts %s only after target ACK, its own init, and usable audio', async path => {
    const f = await audioSelectionFixture(draft, { path });
    try {
      const selectionEvents: typeof f.player.selection[] = [];
      f.player.on('selection_changed', event => {
        expect(f.player.selection).toEqual(event.selection); selectionEvents.push(event.selection);
      });
      const before = f.player.selection, count = audioCount(f);
      const selecting = f.player.selectAudioTrack(refs.spanish), settled = watch(selecting);
      await flush(512);
      expect(f.wire.request(refs.spanish)).toMatchObject(refs.spanish);
      expect(settled.status).toBe('pending'); oldIsOwned(f);
      await f.wire.accept(refs.spanish, 301n);
      expect(settled.status).toBe('pending'); expect(audioCount(f)).toBe(count); oldIsOwned(f);
      await targetMedia(f);
      expect(settled).toMatchObject({ status: 'fulfilled' }); await selecting;
      expect(f.player.selection.audio).toEqual(identity(refs.spanish));
      expect(f.player.selection.video).toEqual(before.video);
      expect(f.player.selection.revision).toBeGreaterThan(before.revision);
      expect(selectionEvents.filter(item => item.audio?.name === refs.spanish.name)).toHaveLength(1);
      expect(f.wire.stopped).toContain(f.wire.request(refs.english).id);
      expect(f.wire.stopped).not.toContain(f.wire.request(refs.video).id);
      expect(f.wire.stopped).not.toContain(f.wire.request(refs.spanish).id);
      expect(f.wire.requests.filter(item => item.name === refs.video.name)).toHaveLength(1);
      expect(f.transportCalls).toHaveLength(1); expect(f.wire.transport.closeInfo).toBeUndefined();
      if (path === 'cmaf' || path === 'locmaf-mse') {
        expect(f.sourceAppends.at(-1)).toMatchObject({ track: refs.spanish.name, group: 70n, init: f.headers.spanish });
      } else {
        expect(f.decodedAudio.at(-1)?.timestamp).toBe(10_040_000);
        expect(f.scheduledAudio.at(-1)?.timestamp).toBe(10_040_000);
      }
      expect(f.errors).toEqual([]); expect(f.wire.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it.each(paths)('rejects unrelated %s audio without a timeline policy and keeps English usable', async path => {
    const f = await audioSelectionFixture(draft, { path, crossSet: true });
    try {
      const selecting = f.player.selectAudioTrack(refs.spanish), settled = watch(selecting);
      await flush(512); expect(settled.status).toBe('rejected');
      await expect(selecting).rejects.toThrow(); await oldStillPlays(f);
    } finally { await f.destroy(); }
  });

  it.each(paths)('refused %s SUBSCRIBE keeps the old audio and video', async path => {
    const f = await audioSelectionFixture(draft, { path });
    try {
      const selecting = f.player.selectAudioTrack(refs.spanish), settled = watch(selecting);
      await flush(512); await f.wire.reject(refs.spanish);
      expect(settled.status).toBe('rejected'); await expect(selecting).rejects.toThrow();
      await oldStillPlays(f);
    } finally { await f.destroy(); }
  });

  it.each(['cmaf', 'locmaf-mse', 'locmaf-frame'] as const)('bad %s target header retains old audio', async path => {
    const f = await audioSelectionFixture(draft, { path, badTargetInit: true });
    try {
      const selecting = f.player.selectAudioTrack(refs.spanish), settled = watch(selecting);
      await flush(512); expect(settled.status).toBe('rejected');
      await expect(selecting).rejects.toThrow(); await oldStillPlays(f);
      expect(f.retypes).toEqual([]);
    } finally { await f.destroy(); }
  });

  it.each(paths)('rejects live-resync on finite %s playback without changing ownership', async path => {
    const f = await audioSelectionFixture(draft, { path, finite: true });
    try {
      const selecting = f.player.selectAudioTrack(refs.spanish, { timeline: { kind: 'live-resync' } });
      const settled = watch(selecting); await flush(512);
      expect(settled.status).toBe('rejected'); await expect(selecting).rejects.toThrow();
      await oldStillPlays(f);
    } finally { await f.destroy(); }
  });
});

describe.each(drafts)('audio candidate ownership draft %s', draft => {
  it.each(['cmaf', 'loc'] as const)('late %s ACK after deadline cannot retire English', async path => {
    const f = await audioSelectionFixture(draft, { path });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let release = async () => {};
    try {
      const selecting = f.player.selectAudioTrack(refs.spanish), settled = watch(selecting);
      await flush(512); release = await f.wire.holdAck(refs.spanish);
      await f.wire.accept(refs.spanish, 301n);
      expect(settled.status).toBe('pending'); oldIsOwned(f);
      await vi.advanceTimersByTimeAsync(3_001); await flush(512);
      expect(settled.status).toBe('rejected'); await expect(selecting).rejects.toThrow();
      await release(); await oldStillPlays(f);
      expect(f.player.selection.audio).toEqual(identity(refs.english));
    } finally { await release(); await f.destroy(); vi.useRealTimers(); }
  });

  it.each(['cmaf', 'loc'] as const)('a held %s target transform cannot adopt after its deadline', async path => {
    const f = await audioSelectionFixture(draft, { path });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const release = f.holdTransform(301n);
    try {
      const selecting = f.player.selectAudioTrack(refs.spanish), settled = watch(selecting);
      await flush(512); await f.wire.accept(refs.spanish, 301n); await targetMedia(f);
      expect(settled.status).toBe('pending'); oldIsOwned(f);
      await vi.advanceTimersByTimeAsync(3_001); await flush(512);
      expect(settled.status).toBe('rejected'); await expect(selecting).rejects.toThrow();
      release(); await flush(512); await oldStillPlays(f);
      expect(f.sourceAppends.some(item => item.track === refs.spanish.name)).toBe(false);
    } finally { release(); await f.destroy(); vi.useRealTimers(); }
  });

  it.each(['cmaf', 'loc'] as const)('overlapping %s selection is busy without another candidate request', async path => {
    const f = await audioSelectionFixture(draft, { path });
    try {
      const selecting = f.player.selectAudioTrack(refs.spanish), settled = watch(selecting); await flush(512);
      const overlapping = f.player.selectAudioTrack(refs.french), overlap = watch(overlapping); await flush(512);
      expect(overlap.status).toBe('rejected'); await expect(overlapping).rejects.toThrow();
      expect(f.wire.requests.some(item => item.name === refs.french.name)).toBe(false); oldIsOwned(f);
      await f.wire.accept(refs.spanish, 301n); await targetMedia(f);
      expect(settled.status).toBe('fulfilled'); await selecting;
      expect(f.player.selection.audio).toEqual(identity(refs.spanish));
    } finally { await f.destroy(); }
  });

  it.each(['cmaf', 'loc'] as const)('destroy fences late %s transform completion', async path => {
    const f = await audioSelectionFixture(draft, { path }); const release = f.holdTransform(301n);
    try {
      const selecting = f.player.selectAudioTrack(refs.spanish), settled = watch(selecting);
      await flush(512); await f.wire.accept(refs.spanish, 301n); await targetMedia(f);
      const count = audioCount(f); await f.player.destroy(); release(); await flush(512);
      expect(settled.status).toBe('rejected'); await expect(selecting).rejects.toThrow();
      expect(audioCount(f)).toBe(count);
      expect(f.player.selection.audio).not.toEqual(identity(refs.spanish));
    } finally { release(); await f.destroy(); }
  });

  it('a public source callback cannot start an overlapping selection during native retype', async () => {
    const f = await audioSelectionFixture(draft, { path: 'cmaf' }); const held = gate();
    let overlap: ReturnType<typeof watch> | undefined;
    f.setRetype(() => { overlap = watch(f.player.selectAudioTrack(refs.french)); return held.promise; });
    try {
      const selecting = f.player.selectAudioTrack(refs.spanish), settled = watch(selecting);
      await flush(512); await f.wire.accept(refs.spanish, 301n); await targetMedia(f);
      expect(overlap?.status).toBe('rejected'); expect(settled.status).toBe('pending');
      expect(f.wire.requests.some(item => item.name === refs.french.name)).toBe(false);
      held.resolve(); await flush(512); f.tick(); await flush(512);
      expect(settled.status).toBe('fulfilled'); await selecting;
    } finally { held.resolve(); await f.destroy(); }
  });

  it('a public decoder configuration callback observes the candidate as busy', async () => {
    const targetAudioConfig = Uint8Array.of(79, 112, 117, 115, 72, 101, 97, 100, 1, 2, 0, 0, 0x80, 0xbb, 0, 0, 0, 0, 0);
    const f = await audioSelectionFixture(draft, { path: 'loc', targetAudioConfig });
    const callbacks: ReturnType<typeof watch>[] = [];
    f.setConfigure(() => { callbacks.push(watch(f.player.selectAudioTrack(refs.french))); });
    try {
      const selecting = f.player.selectAudioTrack(refs.spanish), settled = watch(selecting);
      await flush(512); await f.wire.accept(refs.spanish, 301n); await targetMedia(f);
      expect(settled.status).toBe('fulfilled'); await selecting;
      const delivered = f.mediaObjects.find(item => item.name === refs.spanish.name);
      expect(delivered?.extensions).toBeDefined();
      expect(parseLocHeaders(delivered!.extensions!, { wireProfile: locWireProfileForDraft(draft) }).audioConfig).toEqual(targetAudioConfig);
      expect(callbacks.length).toBeGreaterThan(0);
      expect(callbacks.every(item => item.status === 'rejected')).toBe(true);
      expect(f.wire.requests.some(item => item.name === refs.french.name)).toBe(false);
      expect(f.player.selection.audio).toEqual(identity(refs.spanish));
    } finally { await f.destroy(); }
  });

  it('an isolated public selection observer cannot undo adopted audio', async () => {
    const f = await audioSelectionFixture(draft, { path: 'loc' });
    let callbacks = 0;
    f.player.on('selection_changed', event => {
      if (event.selection.audio?.name !== refs.spanish.name) return;
      expect(f.player.selection.audio).toEqual(identity(refs.spanish));
      callbacks++; throw new Error('application selection observer failure');
    });
    try {
      const selecting = f.player.selectAudioTrack(refs.spanish), settled = watch(selecting);
      await flush(512); await f.wire.accept(refs.spanish, 301n); await targetMedia(f);
      expect(settled.status).toBe('fulfilled'); await selecting;
      expect(callbacks).toBe(1); expect(f.player.selection.audio).toEqual(identity(refs.spanish));
      expect(f.scheduledAudio.at(-1)?.timestamp).toBe(10_040_000);
      expect(f.wire.stopped).toContain(f.wire.request(refs.english).id);
    } finally { await f.destroy(); }
  });

  it('public selection callback reentry cannot erase a later independent attempt', async () => {
    const f = await audioSelectionFixture(draft, { path: 'loc' });
    const callbacks: ReturnType<typeof watch>[] = [];
    f.player.on('selection_changed', event => {
      if (event.selection.audio?.name === refs.spanish.name) callbacks.push(watch(f.player.selectAudioTrack(refs.french)));
    });
    try {
      const first = f.player.selectAudioTrack(refs.spanish), firstState = watch(first);
      await flush(512); await f.wire.accept(refs.spanish, 301n); await targetMedia(f);
      expect(firstState.status).toBe('fulfilled'); await first;
      expect(callbacks).toHaveLength(1); expect(callbacks[0]?.status).toBe('rejected');
      const second = f.player.selectAudioTrack(refs.french), secondState = watch(second);
      await flush(512); await f.wire.accept(refs.french, 302n);
      await f.sendAudio('french', 70n, 3n, 10_060_000n); f.tick(1); await flush(512);
      expect(secondState.status).toBe('fulfilled'); await second;
      expect(f.player.selection.audio).toEqual(identity(refs.french));
      expect(f.scheduledAudio.at(-1)?.timestamp).toBe(10_060_000);
      expect(f.wire.requests.filter(item => item.name === refs.french.name)).toHaveLength(1);
      expect(f.wire.requests.filter(item => item.name === refs.video.name)).toHaveLength(1);
    } finally { await f.destroy(); }
  });

  // Product policy: cancel preparation before automatic session replacement.
  // The transport specs permit started requests to drain; they do not require this preemption policy.
  it.each(['cmaf', 'loc'] as const)('GOAWAY policy cancels a held %s candidate before automatic migration', async path => {
    const f = await audioSelectionFixture(draft, { path }); const release = f.holdTransform(301n);
    try {
      const selecting = f.player.selectAudioTrack(refs.spanish), settled = watch(selecting);
      await flush(512); await f.wire.accept(refs.spanish, 301n); await targetMedia(f);
      expect(settled.status).toBe('pending'); oldIsOwned(f);
      await f.wire.goaway('https://audio-selection.invalid/new');
      expect(settled.status).toBe('rejected'); await expect(selecting).rejects.toThrow();
      const next = f.peers[1]!;
      await next.accept(refs.catalog, 500n); await next.send(refs.catalog, f.catalog, 1n);
      await next.accept(refs.video, 600n); await next.accept(refs.english, 601n);
      const pts = BigInt(f.nowUs + 20_000);
      await f.sendVideo(pts, 0n, next); await f.sendAudio('english', 70n, 0n, pts, next);
      f.tick(1); await flush(512); release(); await flush(512);
      expect(f.player.selection.audio).toEqual(identity(refs.english));
      expect(f.player.selection.video).toEqual(identity(refs.video));
      expect(f.transportCalls).toEqual(['https://audio-selection.invalid/old', 'https://audio-selection.invalid/new']);
      expect(f.sourceAppends.some(item => item.track === refs.spanish.name)).toBe(false);
      expect(f.wire.requests.filter(item => item.name === refs.video.name)).toHaveLength(1);
      expect(next.requests.filter(item => item.name === refs.video.name)).toHaveLength(1);
      expect(f.wire.errors).toEqual([]); expect(next.errors).toEqual([]);
    } finally { release(); await f.destroy(); }
  });
});

describe.each(drafts)('raw-domain audio mapping draft %s', draft => {
  it.each(paths)('%s reference-map preserves raw target time and the next video render schedule', async path => {
    const control = await audioSelectionFixture(draft, { path });
    const f = await audioSelectionFixture(draft, { path, crossSet: true });
    try {
      await primeReference(control); const reference = await primeReference(f);
      await control.sendAudio('english', 70n, 2n, 10_040_000n);
      await control.sendVideo(10_040_000n, 1n); control.tick(1); await flush(512);
      const controlVideo = control.renderedVideo.at(-1);
      expect(controlVideo?.timestamp).toBe(10_040_000);
      const selecting = f.player.selectAudioTrack(refs.spanish, { timeline: { kind: 'reference-map',
        referenceToken: reference.token, sourceTimeUs: 90_000_000n, referenceTimeUs: 10_040_000n } });
      const settled = watch(selecting); await flush(512);
      expect(settled.status, String(settled.error)).toBe('pending'); oldIsOwned(f);
      await f.wire.accept(refs.spanish, 301n);
      expect(f.player.audioTimelineReference?.token).toBe(reference.token);
      await f.sendAudio('spanish', 4n, 0n, 90_000_000n); await f.sendVideo(10_040_000n, 1n);
      f.tick(1); await flush(512);
      expect(settled.status, String(settled.error)).toBe('fulfilled'); await selecting;
      expect(f.player.selection.audio).toEqual(identity(refs.spanish));
      expect(f.renderedVideo.at(-1)).toEqual(controlVideo);
      const adopted = f.player.audioTimelineReference;
      expect(adopted?.track).toEqual(identity(refs.spanish));
      expect(adopted?.observedSourceTimeUs).toBe(90_000_000n);
      expect(adopted?.token).not.toBe(reference.token);
      if (path === 'cmaf' || path === 'locmaf-mse') {
        expect(rawSpanishPresentationUs(f)).toBe(90_000_000n);
        expect(outputPresentationUs(f)).toBe(outputPresentationUs(control));
        expect(f.sourceAppends.at(-1)?.init).toEqual(f.headers.spanish);
      } else {
        expect(f.decodedAudio.at(-1)?.timestamp).toBe(90_000_000);
        expect(f.scheduledAudio.at(-1)?.timestamp).toBe(90_000_000);
        expect(f.scheduledAudio.at(-1)?.renderTimeUs).toBe(control.scheduledAudio.at(-1)?.renderTimeUs);
        if (path === 'loc') expect(f.mediaObjects.find(item => item.name === refs.spanish.name)?.captureTimestamp).toBe(90_000_000n);
      }
      expect(f.wire.stopped).not.toContain(f.wire.request(refs.video).id);
      expect(f.wire.requests.filter(item => item.name === refs.video.name)).toHaveLength(1);
      expect(f.transportCalls).toHaveLength(1); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); await control.destroy(); }
  });

  it.each(['cmaf', 'locmaf-mse'] as const)('%s composes 90s -> raw 1000s -> 990s epoch -> 10s output using presentation time', async path => {
    const f = await audioSelectionFixture(draft, { path, crossSet: true, originUs: 990_000_000n, targetCtoUs: 20_000n });
    try {
      const reference = await primeReference(f, 990_000_000n);
      const first = f.player.selectAudioTrack(refs.spanish, { timeline: { kind: 'reference-map',
        referenceToken: reference.token, sourceTimeUs: 90_000_000n, referenceTimeUs: 1_000_000_000n } });
      const firstState = watch(first); await flush(512);
      expect(firstState.status, String(firstState.error)).toBe('pending');
      await f.wire.accept(refs.spanish, 301n); await f.sendAudio('spanish', 4n, 0n, 90_000_000n); await flush(512);
      expect(firstState.status, String(firstState.error)).toBe('fulfilled'); await first;
      expect(rawSpanishPresentationUs(f)).toBe(90_000_000n);
      expect(outputPresentationUs(f)).toBe(10_000_000n); // CTO makes DTS 89.98s, not presentation 90s.
      const secondReference = f.player.audioTimelineReference;
      if (!secondReference) throw new Error('Mapped audio did not publish its adopted raw domain');
      expect(secondReference.observedSourceTimeUs).toBe(90_000_000n);
      const second = f.player.selectAudioTrack(refs.french, { timeline: { kind: 'reference-map',
        referenceToken: secondReference.token, sourceTimeUs: 5_000_000n, referenceTimeUs: 90_040_000n } });
      const secondState = watch(second); await flush(512);
      expect(secondState.status, String(secondState.error)).toBe('pending');
      await f.wire.accept(refs.french, 302n); await f.sendAudio('french', 999n, 0n, 5_000_000n); await flush(512);
      expect(secondState.status, String(secondState.error)).toBe('fulfilled'); await second;
      expect(outputPresentationUs(f)).toBe(10_040_000n);
      expect(f.player.audioTimelineReference?.observedSourceTimeUs).toBe(5_000_000n);
      expect(f.player.selection.video).toEqual(identity(refs.video));
      expect(f.wire.stopped).not.toContain(f.wire.request(refs.video).id);
    } finally { await f.destroy(); }
  });

  it.each(paths)('%s same declared set inherits an already adopted raw-domain map', async path => {
    const control = await audioSelectionFixture(draft, { path });
    const f = await audioSelectionFixture(draft, { path, crossSet: true, frenchSet: 4 });
    try {
      await primeReference(control); const reference = await primeReference(f);
      const first = f.player.selectAudioTrack(refs.spanish, { timeline: { kind: 'reference-map',
        referenceToken: reference.token, sourceTimeUs: 90_000_000n, referenceTimeUs: 10_040_000n } });
      const firstState = watch(first); await flush(512);
      expect(firstState.status, String(firstState.error)).toBe('pending');
      await f.wire.accept(refs.spanish, 301n); await targetMedia(f, 4n, 0n, 90_000_000n);
      expect(firstState.status, String(firstState.error)).toBe('fulfilled'); await first;
      await control.sendAudio('english', 70n, 2n, 10_040_000n); control.tick(1); await flush(512);
      const second = f.player.selectAudioTrack(refs.french), secondState = watch(second); await flush(512);
      expect(secondState.status, String(secondState.error)).toBe('pending');
      await f.wire.accept(refs.french, 302n);
      await f.sendAudio('french', 4n, 1n, 90_020_000n); await f.sendVideo(10_060_000n, 1n);
      f.tick(1); await flush(512);
      await control.sendAudio('english', 70n, 3n, 10_060_000n); await control.sendVideo(10_060_000n, 1n);
      control.tick(1); await flush(512);
      expect(secondState.status, String(secondState.error)).toBe('fulfilled'); await second;
      expect(f.player.selection.audio).toEqual(identity(refs.french));
      expect(f.renderedVideo.at(-1)).toEqual(control.renderedVideo.at(-1));
      if (path === 'cmaf' || path === 'locmaf-mse') expect(outputPresentationUs(f)).toBe(outputPresentationUs(control));
      else {
        expect(f.decodedAudio.at(-1)?.timestamp).toBe(90_020_000);
        expect(f.scheduledAudio.at(-1)?.renderTimeUs).toBe(control.scheduledAudio.at(-1)?.renderTimeUs);
      }
    } finally { await f.destroy(); await control.destroy(); }
  });

  it.each(['cmaf', 'loc'] as const)('%s rejects another player owner token before retiring old audio', async path => {
    const f = await audioSelectionFixture(draft, { path, crossSet: true });
    const other = await audioSelectionFixture(draft, { path });
    try {
      await primeReference(f); const wrong = await primeReference(other);
      const selecting = f.player.selectAudioTrack(refs.spanish, { timeline: { kind: 'reference-map',
        referenceToken: wrong.token, sourceTimeUs: 90_000_000n, referenceTimeUs: 10_040_000n } });
      const settled = watch(selecting); await flush(512);
      expect(settled.status).toBe('rejected'); await expect(selecting).rejects.toThrow();
      await oldStillPlays(f, 2n);
    } finally { await f.destroy(); await other.destroy(); }
  });

  it.each(['cmaf', 'loc'] as const)('%s rejects a token captured before a later audio adoption', async path => {
    const f = await audioSelectionFixture(draft, { path });
    try {
      const stale = await primeReference(f);
      const first = f.player.selectAudioTrack(refs.spanish), firstState = watch(first); await flush(512);
      await f.wire.accept(refs.spanish, 301n); await targetMedia(f);
      expect(firstState.status).toBe('fulfilled'); await first;
      expect(f.player.audioTimelineReference?.token).not.toBe(stale.token);
      const selecting = f.player.selectAudioTrack(refs.french, { timeline: { kind: 'reference-map',
        referenceToken: stale.token, sourceTimeUs: 5_000_000n, referenceTimeUs: 10_060_000n } });
      const settled = watch(selecting); await flush(512);
      expect(settled.status).toBe('rejected'); await expect(selecting).rejects.toThrow();
      expect(f.player.selection.audio).toEqual(identity(refs.spanish));
      expect(f.wire.stopped).not.toContain(f.wire.request(refs.spanish).id);
      const count = audioCount(f);
      await f.sendAudio('spanish', 70n, 3n, 10_060_000n); f.tick(1); await flush(512);
      expect(audioCount(f)).toBe(count + 1);
    } finally { await f.destroy(); }
  });

  it('subtracts bigint raw anchors before numeric render conversion', async () => {
    const control = await audioSelectionFixture(draft, { path: 'loc' });
    const f = await audioSelectionFixture(draft, { path: 'loc', crossSet: true });
    try {
      await primeReference(control); const reference = await primeReference(f);
      // Large anchors cancel to a safe affine offset; the packet itself stays
      // in the codec's exact numeric range. Number(anchor) loses one microsecond.
      const source = (1n << 54n) + 1n, referenceTimeUs = source - 79_959_993n, packet = 90_000_000n;
      await control.sendAudio('english', 70n, 2n, 10_040_007n); control.tick(1); await flush(512);
      const selecting = f.player.selectAudioTrack(refs.spanish, { timeline: { kind: 'reference-map',
        referenceToken: reference.token, sourceTimeUs: source, referenceTimeUs } });
      const settled = watch(selecting); await flush(512);
      expect(settled.status, String(settled.error)).toBe('pending');
      await f.wire.accept(refs.spanish, 301n); await targetMedia(f, 4n, 0n, packet);
      expect(settled.status, String(settled.error)).toBe('fulfilled'); await selecting;
      expect(f.mediaObjects.find(item => item.name === refs.spanish.name)?.captureTimestamp).toBe(packet);
      expect(f.decodedAudio.at(-1)?.timestamp).toBe(Number(packet));
      expect(f.scheduledAudio.at(-1)?.renderTimeUs).toBe(control.scheduledAudio.at(-1)?.renderTimeUs);
    } finally { await f.destroy(); await control.destroy(); }
  });

  it('a mapped candidate held past its deadline cannot change the old video clock', async () => {
    const control = await audioSelectionFixture(draft, { path: 'loc' });
    const f = await audioSelectionFixture(draft, { path: 'loc', crossSet: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const release = f.holdTransform(301n);
    try {
      await primeReference(control); const reference = await primeReference(f);
      const selecting = f.player.selectAudioTrack(refs.spanish, { timeline: { kind: 'reference-map',
        referenceToken: reference.token, sourceTimeUs: 90_000_000n, referenceTimeUs: 10_040_000n } });
      const settled = watch(selecting); await flush(512);
      expect(settled.status, String(settled.error)).toBe('pending');
      await f.wire.accept(refs.spanish, 301n); await f.sendAudio('spanish', 4n, 0n, 90_000_000n);
      await control.sendVideo(10_040_000n, 1n); control.tick(1); await flush(512);
      await f.sendVideo(10_040_000n, 1n); f.tick(1); await flush(512);
      expect(f.renderedVideo.at(-1)).toEqual(control.renderedVideo.at(-1));
      expect(f.player.audioTimelineReference?.token).toBe(reference.token);
      await vi.advanceTimersByTimeAsync(3_001); await flush(512);
      expect(settled.status).toBe('rejected'); await expect(selecting).rejects.toThrow();
      release(); await flush(512); await oldStillPlays(f, 2n);
      expect(f.player.audioTimelineReference?.token).toBe(reference.token);
    } finally { release(); await f.destroy(); await control.destroy(); vi.useRealTimers(); }
  });
});

describe.each(drafts)('explicit live audio policy draft %s', draft => {
  it.each(['loc', 'locmaf-frame'] as const)('%s live-resync uses a current scheduled-unit adapter witness and leaves video timing intact', async path => {
    const control = await audioSelectionFixture(draft, { path, playheadWitness: true });
    const f = await audioSelectionFixture(draft, { path, crossSet: true, playheadWitness: true });
    try {
      const point = f.scheduledAudio.at(-1), controlPoint = control.scheduledAudio.at(-1);
      if (!point || !controlPoint) throw new Error('No actual scheduled fixture audio');
      expect(f.output.playheadCaptureUs?.()).toBeNull();
      f.advanceTo(point.renderTimeUs); control.advanceTo(controlPoint.renderTimeUs);
      expect(f.output.playheadCaptureUs?.()).toBe(point.timestamp);
      const selecting = f.player.selectAudioTrack(refs.spanish, { timeline: { kind: 'live-resync' } });
      const settled = watch(selecting); await flush(512);
      expect(settled.status, String(settled.error)).toBe('pending');
      await f.wire.accept(refs.spanish, 301n); await f.sendAudio('spanish', 4n, 0n, 90_000_000n);
      const videoPts = BigInt(f.nowUs + 20_000);
      await f.sendVideo(videoPts, 1n); f.tick(1); await flush(512);
      await control.sendVideo(videoPts, 1n); control.tick(1); await flush(512);
      expect(settled.status, String(settled.error)).toBe('fulfilled'); await selecting;
      expect(f.player.selection.audio).toEqual(identity(refs.spanish));
      expect(f.decodedAudio.at(-1)?.timestamp).toBe(90_000_000);
      expect(f.scheduledAudio.at(-1)?.timestamp).toBe(90_000_000);
      expect(f.renderedVideo.at(-1)).toEqual(control.renderedVideo.at(-1));
      // Explicit receiver policy only; this is not a claim about content A/V sync.
    } finally { await f.destroy(); await control.destroy(); }
  });

  it.each(['loc', 'locmaf-frame'] as const)('%s live-resync refuses elapsed clocks/decoder submissions without scheduled output', async path => {
    const f = await audioSelectionFixture(draft, { path, crossSet: true, deferAudioOutput: true, playheadWitness: true });
    try {
      expect(f.decodedAudio.length).toBeGreaterThan(0); expect(f.scheduledAudio).toEqual([]);
      f.tick(20); expect(f.output.playheadCaptureUs?.()).toBeNull();
      const selecting = f.player.selectAudioTrack(refs.spanish, { timeline: { kind: 'live-resync' } });
      const settled = watch(selecting); await flush(512);
      if (settled.status === 'pending' && f.wire.requests.some(item => item.name === refs.spanish.name)) {
        await f.wire.accept(refs.spanish, 301n); await targetMedia(f, 4n, 0n, 90_000_000n);
      }
      expect(settled.status, String(settled.error)).toBe('rejected'); await expect(selecting).rejects.toThrow();
      oldIsOwned(f); expect(f.scheduledAudio).toEqual([]);
    } finally { await f.destroy(); }
  });

  it.each(['cmaf', 'locmaf-mse'] as const)('%s live-resync requires a real media-output adapter clock', async path => {
    const f = await audioSelectionFixture(draft, { path, crossSet: true });
    try {
      expect(f.sourceAppends.length).toBeGreaterThan(0); expect(f.source.mediaElement).toBeNull();
      const selecting = f.player.selectAudioTrack(refs.spanish, { timeline: { kind: 'live-resync' } });
      const settled = watch(selecting); await flush(512);
      if (settled.status === 'pending' && f.wire.requests.some(item => item.name === refs.spanish.name)) {
        await f.wire.accept(refs.spanish, 301n); await targetMedia(f, 4n, 0n, 90_000_000n);
      }
      expect(settled.status, String(settled.error)).toBe('rejected'); await expect(selecting).rejects.toThrow();
      await oldStillPlays(f);
    } finally { await f.destroy(); }
  });
});

describe('audio decoder configuration ownership', () => {
  it.each([false, true])('preserves old output when target configuration is refused: %s', async refused => {
    const f = await audioSelectionFixture(18, { path: 'loc', targetAudioConfig: Uint8Array.of(1, 2, 3) });
    try {
      let configurations = 0;
      // Only the target configuration fails; restoring the old configuration
      // remains a healthy rollback control. Failed undo has its own cases.
      f.setConfigure(() => { if (++configurations === 1 && refused) throw new Error('target AudioDecoder.configure refused'); });
      const selecting = f.player.selectAudioTrack(refs.spanish), result = watch(selecting);
      await flush(512); await f.wire.accept(refs.spanish, 301n);
      await f.sendAudio('spanish', 70n, 1n, 10_040_000n); f.tick(1); await flush(512);
      if (refused) {
        expect.soft(result.status).toBe('rejected');
        expect.soft(f.player.selection.audio).toEqual(identity(refs.english));
        expect.soft(f.wire.stopped).not.toContain(f.wire.request(refs.english).id);
        expect.soft(f.errors).not.toContain('Audio selection failed after adoption');
        expect(configurations).toBe(2); expect(f.player.state).not.toBe(PlayerState.ERROR);
        await oldStillPlays(f);
      } else {
        expect(result.status).toBe('fulfilled'); await selecting;
        expect(f.player.selection.audio).toEqual(identity(refs.spanish));
        expect(f.scheduledAudio.at(-1)?.timestamp).toBe(10_040_000);
      }
    } finally { await f.destroy(); }
  });

  it.each([
    { label: 'Error', failure: new Error('old audio restore refused') },
    { label: 'null', failure: null },
    { label: 'undefined', failure: undefined },
  ])('makes a failed configuration undo fatal even when the adapter throws $label', async ({ failure }) => {
    const targetAudioConfig = Uint8Array.of(79, 112, 117, 115, 72, 101, 97, 100, 1, 2, 0, 0, 0x80, 0xbb, 0, 0, 0, 0, 0);
    const f = await audioSelectionFixture(18, { path: 'loc', targetAudioConfig });
    const failures: Array<{ severity: string; message: string }> = [];
    const selected: typeof f.player.selection[] = [];
    f.player.on('error', event => { failures.push(event.error); });
    f.player.on('selection_changed', event => { selected.push(event.selection); });
    let configurations = 0;
    f.setConfigure(() => {
      if (++configurations === 1) throw new Error('target AudioDecoder.configure refused');
      throw failure;
    });
    try {
      const selecting = f.player.selectAudioTrack(refs.spanish), settled = watch(selecting);
      await flush(512); await f.wire.accept(refs.spanish, 301n);
      await f.sendAudio('spanish', 70n, 1n, 10_040_000n); f.tick(1); await flush(512);
      expect(settled.status).toBe('rejected'); await expect(selecting).rejects.toThrow();
      expect(configurations).toBe(2);
      expect(failures.filter(error => error.severity === 'fatal')).toEqual([
        expect.objectContaining({ message: 'Could not restore audio media state after preparation' }),
      ]);
      expect(f.player.state).toBe(PlayerState.ERROR);
      expect(selected.some(selection => selection.audio?.name === refs.spanish.name)).toBe(false);
      expect(f.wire.stopped).toContain(f.wire.request(refs.english).id);
      expect(f.wire.stopped).toContain(f.wire.request(refs.video).id);
    } finally { await f.destroy(); }
  });
});

describe('explicit audio mapping ownership', () => {
  it('mapped LOC audio survives a missing group without resetting the continuing video clock', async () => {
    const options = { path: 'loc' as const, config: { gapTimeoutMs: 50 } };
    const control = await audioSelectionFixture(18, options);
    const f = await audioSelectionFixture(18, { ...options, crossSet: true });
    const skips: Array<{ mediaType: 'audio' | 'video'; fromGroupId: bigint; toGroupId: bigint }> = [];
    f.player.on('skip_forward', event => { skips.push(event); });
    try {
      await primeReference(control); const reference = await primeReference(f);
      const selecting = f.player.selectAudioTrack(refs.spanish, { timeline: { kind: 'reference-map',
        referenceToken: reference.token, sourceTimeUs: 90_000_000n, referenceTimeUs: 10_040_000n } });
      const settled = watch(selecting); await flush(512); await f.wire.accept(refs.spanish, 301n);
      await f.sendAudio('spanish', 4n, 0n, 90_000_000n);
      await control.sendAudio('english', 70n, 2n, 10_040_000n);
      f.tick(1); control.tick(1); await flush(512);
      expect(settled.status, String(settled.error)).toBe('fulfilled'); await selecting;
      const decodedBefore = f.decodedAudio.length, scheduledBefore = f.scheduledAudio.length;
      // No Group 5 arrives. A complete usable Group 6 must be recovered
      // through the normal gap machinery, with its raw 90s domain intact.
      await f.sendAudio('spanish', 6n, 0n, 92_140_000n);
      await control.sendAudio('english', 70n, 3n, 12_180_000n);
      // The normal adaptive detector may extend its timeout up to 2s.
      // Keep the recovered samples ahead of that deadline, so a late-frame
      // discard cannot masquerade as the missing mapped timing reference.
      f.advanceTo(f.nowUs + 2_100_000); control.advanceTo(control.nowUs + 2_100_000); await flush(512);
      expect(skips).toEqual([{ type: 'skip_forward', mediaType: 'audio', fromGroupId: 4n, toGroupId: 6n }]);
      await f.sendAudio('spanish', 6n, 1n, 92_160_000n);
      await control.sendAudio('english', 70n, 4n, 12_200_000n);
      await f.sendVideo(12_200_000n, 1n); await control.sendVideo(12_200_000n, 1n);
      f.tick(1); control.tick(1); await flush(512);
      expect(control.scheduledAudio.slice(-2).map(point => point.timestamp)).toEqual([12_180_000, 12_200_000]);
      expect(control.renderedVideo.at(-1)?.timestamp).toBe(12_200_000);
      expect.soft(f.renderedVideo.at(-1)).toEqual(control.renderedVideo.at(-1));
      expect.soft(f.renderedVideo.at(-1)?.timestamp).toBe(12_200_000);
      expect.soft(f.decodedAudio).toHaveLength(decodedBefore + 2);
      expect.soft(f.scheduledAudio).toHaveLength(scheduledBefore + 2);
      expect.soft(f.scheduledAudio.slice(-2).map(point => point.timestamp)).toEqual([92_140_000, 92_160_000]);
      expect.soft(f.scheduledAudio.slice(-2).map(point => point.renderTimeUs))
        .toEqual(control.scheduledAudio.slice(-2).map(point => point.renderTimeUs));
      expect(f.player.selection.video).toEqual(identity(refs.video));
      expect(f.wire.stopped).not.toContain(f.wire.request(refs.video).id);
      expect(f.wire.requests.filter(item => item.name === refs.video.name)).toHaveLength(1);
      expect(f.errors).toEqual([]); expect(f.wire.errors).toEqual([]);
    } finally { await f.destroy(); await control.destroy(); }
  });

  it.each([false, true])('honors the first explicit map with buffered old audio: zero=%s', async zero => {
    const f = await audioSelectionFixture(18, { path: 'cmaf', crossSet: true });
    try {
      void f.player.audioTimelineReference;
      await f.sendAudio('english', 70n, 1n, 10_200_000n);
      const reference = f.player.audioTimelineReference;
      if (!reference) throw new Error('Missing real adopted audio reference');
      const source = zero ? 10_040_000n : 90_000_000n;
      const selecting = f.player.selectAudioTrack(refs.spanish, { timeline: { kind: 'reference-map',
        referenceToken: reference.token, sourceTimeUs: source, referenceTimeUs: 10_040_000n } });
      const settled = watch(selecting); await flush(512);
      expect(settled.status, String(settled.error)).toBe('pending');
      await f.wire.accept(refs.spanish, 301n); await f.sendAudio('spanish', 4n, 0n, source);
      expect(settled.status, String(settled.error)).toBe('fulfilled'); await selecting; await flush(512);
      expect(outputPresentationUs(f)).toBe(40_000n); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it.each([false, true])('invalidates a reference after a refused mapped-source restart: %s', async restart => {
    const f = await audioSelectionFixture(18, { path: 'cmaf', crossSet: true });
    try {
      void f.player.audioTimelineReference;
      await f.sendAudio('english', 70n, 1n, 10_020_000n);
      const reference = f.player.audioTimelineReference;
      if (!reference) throw new Error('Missing adopted audio reference');
      const selecting = f.player.selectAudioTrack(refs.spanish, { timeline: { kind: 'reference-map',
        referenceToken: reference.token, sourceTimeUs: 90_000_000n, referenceTimeUs: 10_040_000n } });
      const settled = watch(selecting); await flush(512);
      await f.wire.accept(refs.spanish, 301n); await f.sendAudio('spanish', 4n, 0n, 90_000_000n);
      expect(settled.status, String(settled.error)).toBe('fulfilled'); await selecting; await flush(512);
      const before = f.player.audioTimelineReference;
      if (!before) throw new Error('Mapped audio did not publish its source reference');
      const count = f.sourceAppends.length;
      await f.sendAudio('spanish', 5n, 0n, restart ? 0n : 90_020_000n); await flush(512);
      if (restart) {
        expect.soft(f.sourceAppends).toHaveLength(count); expect(f.player.audioTimelineReference).toBeNull();
      } else {
        expect(f.sourceAppends).toHaveLength(count + 1); expect(f.player.audioTimelineReference?.token).toBe(before.token);
      }
    } finally { await f.destroy(); }
  });
});

describe('audio configure callback lifetime', () => {
  it.each([false, true])('does not configure a decoder after its configure event destroys playback: %s', async destroy => {
    const f = await audioSelectionFixture(18, { path: 'loc', targetAudioConfig: Uint8Array.of(1, 2, 3) });
    let destroyStarted = false, configuredAfterDestroy = 0;
    f.setConfigure(() => { if (destroyStarted) configuredAfterDestroy++; });
    f.player.on('decoder_command', event => {
      if (destroy && !destroyStarted && event.command.type === 'configure' && event.command.mediaType === 'audio') {
        destroyStarted = true;
        void f.player.destroy().catch(() => {});
      }
    });
    try {
      const result = { status: 'pending' };
      const selecting = f.player.selectAudioTrack(refs.spanish);
      void selecting.then(() => { result.status = 'fulfilled'; }, () => { result.status = 'rejected'; });
      await flush(512); await f.wire.accept(refs.spanish, 301n);
      await f.sendAudio('spanish', 70n, 1n, 10_040_000n); f.player.tick(); await flush(512);
      expect(configuredAfterDestroy).toBe(0);
      expect(result.status).toBe(destroy ? 'rejected' : 'fulfilled');
    } finally { await f.destroy(); }
  });
});

describe('live audio graph timing', () => {
  it.each(['loc', 'locmaf-frame'] as const)('%s maps to the current scheduled graph instant with exactly one cushion', async path => {
    const f = await audioSelectionFixture(18, { path, crossSet: true, playheadWitness: true });
    try {
      const point = f.scheduledAudio.at(-1)!;
      f.advanceTo(point.renderTimeUs);
      const now = f.nowUs;
      expect(f.output.playheadCaptureUs?.()).toBe(point.timestamp);
      const selecting = f.player.selectAudioTrack(refs.spanish, { timeline: { kind: 'live-resync' } });
      void selecting.catch(() => {});
      await flush(512); await f.wire.accept(refs.spanish, 301n);
      await f.sendAudio('spanish', 4n, 0n, 90_000_000n); await selecting;
      f.player.tick(); await flush(512);
      expect(f.scheduledAudio.at(-1)?.timestamp).toBe(90_000_000);
      expect(f.scheduledAudio.at(-1)?.renderTimeUs).toBe(now);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});

describe('video gap recovery with mapped audio', () => {
  it.each([false, true])('recovers video after a missing group while audio uses a map: %s', async mapped => {
    const f = await audioSelectionFixture(18, { path: 'loc', crossSet: mapped, config: { gapTimeoutMs: 50 } });
    const videoSkips: Array<{ fromGroupId: bigint; toGroupId: bigint }> = [];
    f.player.on('skip_forward', event => { if (event.mediaType === 'video') videoSkips.push(event); });
    try {
      void f.player.audioTimelineReference;
      await f.sendAudio('english', 70n, 1n, 10_020_000n); f.tick(1); await flush(512);
      if (mapped) {
        const reference = f.player.audioTimelineReference!;
        const selecting = f.player.selectAudioTrack(refs.spanish, { timeline: { kind: 'reference-map',
          referenceToken: reference.token, sourceTimeUs: 90_000_000n, referenceTimeUs: 10_040_000n } });
        void selecting.catch(() => {});
        await flush(512); await f.wire.accept(refs.spanish, 301n);
        await f.sendAudio('spanish', 4n, 0n, 90_000_000n); await selecting;
      } else await f.sendAudio('english', 70n, 2n, 10_040_000n);
      f.tick(1); await flush(512);
      const sendVideo = async (pts: bigint, object: bigint) => {
        await f.wire.send(refs.video, Uint8Array.of(0, 0, 0, 1, 0x65), 802n, object,
          encodeLocHeaders({ captureTimestamp: pts, videoFrameMarking: { startOfFrame: true,
            endOfFrame: true, independent: true, discardable: false, baseLayerSync: false, temporalId: 0 } },
          { wireProfile: locWireProfileForDraft(18) }));
      };
      await sendVideo(12_180_000n, 0n);
      await f.sendAudio(mapped ? 'spanish' : 'english', mapped ? 4n : 70n, mapped ? 1n : 3n,
        mapped ? 92_140_000n : 12_180_000n);
      f.advanceTo(f.nowUs + 2_100_000); await flush(512);
      await sendVideo(12_200_000n, 1n);
      await f.sendAudio(mapped ? 'spanish' : 'english', mapped ? 4n : 70n, mapped ? 2n : 4n,
        mapped ? 92_160_000n : 12_200_000n);
      f.tick(1); await flush(512);
      expect(videoSkips).toEqual([expect.objectContaining({ fromGroupId: 800n, toGroupId: 802n })]);
      expect.soft(f.renderedVideo.at(-1)?.timestamp).toBe(12_200_000);
      expect.soft(f.scheduledAudio.at(-1)?.timestamp).toBe(mapped ? 92_160_000 : 12_200_000);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});

describe('audio output readiness', () => {
  it.each([false, true])('keeps old audio until candidate fits the continuing schedule: late=%s', async late => {
    const f = await audioSelectionFixture(18, { path: 'loc' });
    try {
      f.advanceTo(11_000_000);
      await f.sendAudio('english', 70n, 1n, 11_020_000n); f.tick(1); await flush(512);
      const oldCount = f.scheduledAudio.length;
      const oldPoint = f.scheduledAudio.at(-1)!;
      expect(oldPoint.timestamp).toBe(11_020_000);
      const state = watch(f.player.selectAudioTrack(refs.spanish));
      await flush(512); await f.wire.accept(refs.spanish, 301n);
      await f.sendAudio('spanish', 70n, 0n, late ? 10_000_000n : 11_040_000n); f.tick(1); await flush(512);
      if (late) {
        expect.soft(state.status, String(state.error)).toBe('pending');
        expect.soft(f.wire.stopped).not.toContain(f.wire.request(refs.english).id);
        expect.soft(f.player.selection.audio).toEqual(identity(refs.english));
        expect(f.scheduledAudio.length).toBe(oldCount);
      } else {
        expect(state.status, String(state.error)).toBe('fulfilled');
        expect(f.scheduledAudio.length).toBe(oldCount + 1);
        expect(f.scheduledAudio.at(-1)?.timestamp).toBe(11_040_000);
        expect(f.scheduledAudio.at(-1)?.renderTimeUs).toBe(oldPoint.renderTimeUs + 20_000);
      }
    } finally { await f.destroy(); }
  });

  it('accepts fresh second target audio after a late first object while old audio keeps scheduling', async () => {
    const f = await audioSelectionFixture(18, { path: 'loc' });
    try {
      f.advanceTo(11_000_000);
      await f.sendAudio('english', 70n, 1n, 11_020_000n); f.tick(1); await flush(512);
      const oldCount = f.scheduledAudio.length;
      expect(f.scheduledAudio.at(-1)?.timestamp).toBe(11_020_000);
      const selecting = f.player.selectAudioTrack(refs.spanish), state = watch(selecting);
      await flush(512); await f.wire.accept(refs.spanish, 301n);
      await f.sendAudio('spanish', 70n, 0n, 10_000_000n); f.tick(1); await flush(512);
      expect(state.status, String(state.error)).toBe('pending'); oldIsOwned(f);
      expect(f.scheduledAudio).toHaveLength(oldCount);
      await f.sendAudio('english', 70n, 2n, 11_060_000n); await f.sendVideo(11_060_000n, 1n);
      f.tick(1); await flush(512);
      expect(f.scheduledAudio).toHaveLength(oldCount + 1);
      expect(f.scheduledAudio.at(-1)?.timestamp).toBe(11_060_000); oldIsOwned(f);
      const continuing = f.scheduledAudio.at(-1)!;
      await f.sendAudio('spanish', 70n, 1n, 11_080_000n); await f.sendVideo(11_080_000n, 2n);
      f.tick(1); await flush(512);
      expect(state.status, String(state.error)).toBe('fulfilled'); await selecting;
      expect(f.player.selection.audio).toEqual(identity(refs.spanish));
      expect(f.decodedAudio.at(-1)?.bytes[1]).toBe(31);
      expect(f.scheduledAudio.slice(oldCount + 1).map(point => point.timestamp)).toEqual([11_080_000]);
      expect(f.scheduledAudio.at(-1)?.renderTimeUs).toBe(continuing.renderTimeUs + 20_000);
      expect(f.renderedVideo.at(-1)?.timestamp).toBe(11_080_000);
      expect(f.player.selection.video).toEqual(identity(refs.video));
      expect(f.wire.stopped).toContain(f.wire.request(refs.english).id);
      expect(f.wire.stopped).not.toContain(f.wire.request(refs.video).id);
      expect(f.wire.requests.filter(item => item.name === refs.video.name)).toHaveLength(1);
      expect(f.transportCalls).toHaveLength(1); expect(f.wire.transport.closeInfo).toBeUndefined();
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('times out an exclusively late target without retiring the continuing old output', async () => {
    const f = await audioSelectionFixture(18, { path: 'loc', config: { connectionTimeoutMs: 100 } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      f.advanceTo(11_000_000);
      await f.sendAudio('english', 70n, 1n, 11_020_000n); f.tick(1); await flush(512);
      const oldCount = f.scheduledAudio.length;
      expect(f.scheduledAudio.at(-1)?.timestamp).toBe(11_020_000);
      const selecting = f.player.selectAudioTrack(refs.spanish), state = watch(selecting);
      await flush(512); await f.wire.accept(refs.spanish, 301n);
      await f.sendAudio('spanish', 70n, 0n, 10_000_000n); f.tick(1); await flush(512);
      expect(state.status, String(state.error)).toBe('pending'); oldIsOwned(f);
      expect(f.scheduledAudio).toHaveLength(oldCount);
      await vi.advanceTimersByTimeAsync(99); await flush(512);
      expect(state.status, String(state.error)).toBe('pending'); oldIsOwned(f);
      await f.sendAudio('english', 70n, 2n, 11_060_000n); f.tick(1); await flush(512);
      expect(f.scheduledAudio).toHaveLength(oldCount + 1);
      expect(f.scheduledAudio.at(-1)?.timestamp).toBe(11_060_000);
      await vi.advanceTimersByTimeAsync(2); await flush(512);
      expect(state.status).toBe('rejected'); await expect(selecting).rejects.toThrow(/timed out/i);
      oldIsOwned(f); expect(f.wire.stopped).toContain(f.wire.request(refs.spanish).id);
      await f.sendAudio('english', 70n, 3n, 11_080_000n); await f.sendVideo(11_080_000n, 1n);
      f.tick(1); await flush(512);
      expect(f.scheduledAudio.slice(oldCount).map(point => point.timestamp)).toEqual([11_060_000, 11_080_000]);
      expect(f.decodedAudio.at(-1)?.bytes[1]).toBe(21);
      expect(f.renderedVideo.at(-1)?.timestamp).toBe(11_080_000); oldIsOwned(f);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); vi.useRealTimers(); }
  });
});

describe('automatic audio language preferences during handover', () => {
  it.each([false, true])('keeps language preferences when the active track disappears: %s', async preferred => {
    const old = audioPeer(18), next = audioPeer(18), peers = [old, next];
    const namespace = ['language', 'handover'];
    const ref = (name: string) => ({ namespace, name });
    const catalog = (replacement: boolean) => new TextEncoder().encode(JSON.stringify({ version: 1, tracks:
      (replacement ? [['en', 'en'], ['es-new', 'es-MX']] : [['en', 'en'], ['es-old', 'es'], ['es-new', 'es-MX']])
        .map(([name, lang]) => ({ name, lang, role: 'audio', renderGroup: 1, altGroup: 3,
          codec: 'opus', packaging: 'loc', isLive: true, samplerate: 48000, channelConfig: '2' })) }));
    let connection = 0, transport = 0;
    const player = new MoqtPlayer({ url: 'https://language.invalid/old', namespace, draftVersion: 18,
      disableVideo: true, audioLanguages: preferred ? ['es'] : [], autoQuality: false,
      catalogBootstrap: 'subscribe', reconnectAttempts: 0, connectionTimeoutMs: 1000,
      createConnection: () => peers[connection++]!.client,
      createTransport: async () => peers[transport++]!.start(),
      createAudioDecoder: () => ({ configure() {}, decode() {}, flush: async () => {}, reset() {}, destroy() {},
        queueDepth: 0, onData: null, onError: null }),
      createAudioOutput: () => ({ schedule() {}, flush() {}, destroy() {}, currentPlayoutTimeUs: 0 }),
    });
    try {
      await player.load(); await old.accept(ref('catalog'), 100n); await old.send(ref('catalog'), catalog(false), 1n);
      const initial = preferred ? 'es-old' : 'en';
      await old.accept(ref(initial), 201n);
      await old.send(ref(initial), Uint8Array.of(0x48, 1, 2), 70n, 0n,
        encodeLocHeaders({ captureTimestamp: 10_000_000n }, { wireProfile: locWireProfileForDraft(18) }));
      expect(player.selection.audio?.name).toBe(initial);
      await old.goaway('https://language.invalid/next'); await flush(512);
      await next.accept(ref('catalog'), 300n); await next.send(ref('catalog'), catalog(true), 1n); await flush(512);
      expect(next.requests.filter(request => request.name !== 'catalog').map(request => request.name))
        .toEqual([preferred ? 'es-new' : 'en']);
    } finally {
      await player.destroy(); await old.close(); await next.close();
    }
  });
});

describe('finite adopted audio output ownership', () => {
  it.each([false, true])('selects a same-set language while accepted output plays after wire drain: %s', async drained => {
    const f = await finiteAudioOutputFixture();
    try {
      if (drained) await f.drainAudio();
      const point = f.atOutputHead();
      expect(f.output.playheadCaptureUs?.()).toBe(point.timestamp);
      expect(f.player.selection.audio?.name).toBe('en');
      const selecting = f.player.selectAudioTrack(f.ref('es')), state = watch(selecting);
      await flush(512); await f.wire.accept(f.ref('es'), 301n);
      f.releaseTarget(); const pts = await f.target(); f.player.tick(); await flush(512);
      expect(state.status, String(state.error)).toBe('fulfilled'); await selecting;
      expect(f.player.selection.audio?.name).toBe('es');
      expect(f.scheduled.at(-1)?.timestamp, JSON.stringify({ decoded: f.decoded, delivered: f.delivered,
        commands: f.commands.map(command => command.type) })).toBe(Number(pts));
      expect(f.wire.requests.filter(request => request.name === 'en')).toHaveLength(1);
      expect(f.wire.stopped).not.toContain(f.wire.request(f.ref('video')).id);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('keeps the adopted owner when its old request drains while the target reply is held', async () => {
    const f = await finiteAudioOutputFixture(); let releaseAck = async () => {};
    try {
      const point = f.atOutputHead(); expect(f.output.playheadCaptureUs?.()).toBe(point.timestamp);
      const selecting = f.player.selectAudioTrack(f.ref('es')), state = watch(selecting);
      await flush(512); releaseAck = await f.wire.holdAck(f.ref('es')); await f.wire.accept(f.ref('es'), 301n);
      expect(state.status).toBe('pending');
      await f.drainAudio();
      expect(state.status, String(state.error)).toBe('pending');
      expect(f.player.selection.audio?.name).toBe('en'); expect(f.output.playheadCaptureUs?.()).toBe(point.timestamp);
      await releaseAck(); f.releaseTarget(); const pts = await f.target(); f.player.tick(); await flush(512);
      expect(state.status, String(state.error)).toBe('fulfilled'); await selecting;
      expect(f.player.selection.audio?.name).toBe('es');
      expect(f.scheduled.at(-1)?.timestamp, JSON.stringify({ decoded: f.decoded, delivered: f.delivered,
        commands: f.commands.map(command => command.type) })).toBe(Number(pts));
      expect(f.wire.requests.filter(request => request.name === 'en')).toHaveLength(1);
      expect(f.wire.stopped).not.toContain(f.wire.request(f.ref('video')).id); expect(f.errors).toEqual([]);
    } finally { await releaseAck(); await f.destroy(); }
  });

  it.each(['destroy', 'decoder-error'] as const)('refuses selection after actual terminal output ownership: %s', async terminal => {
    const f = await finiteAudioOutputFixture();
    try {
      await f.drainAudio(); const point = f.atOutputHead();
      expect(f.output.playheadCaptureUs?.()).toBe(point.timestamp);
      const count = f.scheduled.length;
      if (terminal === 'destroy') await f.player.destroy(); else f.failDecoder();
      expect(f.player.state).toBe(terminal === 'destroy' ? PlayerState.ENDED : PlayerState.ERROR);
      const selecting = f.player.selectAudioTrack(f.ref('es')), state = watch(selecting);
      await flush(512); expect(state.status).toBe('rejected'); await expect(selecting).rejects.toThrow();
      expect(f.wire.requests.filter(request => request.name === 'es')).toHaveLength(0);
      expect(f.scheduled).toHaveLength(count);
    } finally { await f.destroy(); }
  });

  it.each(['destroy', 'decoder-error'] as const)('fences a held finite target when its adopted owner becomes terminal: %s', async terminal => {
    const f = await finiteAudioOutputFixture();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await f.drainAudio(); const point = f.atOutputHead();
      expect(f.output.playheadCaptureUs?.()).toBe(point.timestamp);
      const selecting = f.player.selectAudioTrack(f.ref('es')), state = watch(selecting);
      await flush(512); await f.wire.accept(f.ref('es'), 301n); await f.target();
      expect(state.status, String(state.error)).toBe('pending');
      const count = f.scheduled.length;
      if (terminal === 'destroy') await f.player.destroy(); else f.failDecoder();
      f.releaseTarget(); await flush(512); f.player.tick(); await flush(512);
      expect(f.player.state).toBe(terminal === 'destroy' ? PlayerState.ENDED : PlayerState.ERROR);
      expect(state.status).not.toBe('fulfilled'); expect(f.scheduled).toHaveLength(count);
      // Terminal state fences data immediately; an admitted operation may
      // settle through its already armed bounded deadline.
      await vi.advanceTimersByTimeAsync(1001); await flush(512);
      expect(state.status).toBe('rejected'); await expect(selecting).rejects.toThrow();
      expect(f.scheduled).toHaveLength(count);
      expect(f.wire.requests.filter(request => request.name === 'en')).toHaveLength(1);
      expect(f.wire.requests.filter(request => request.name === 'es')).toHaveLength(1);
    } finally { await f.destroy(); vi.useRealTimers(); }
  });

  it.each([false, true])('reserves one owner across a scheduled-playhead callback: reenter=%s', async reenter => {
    const f = await finiteAudioOutputFixture();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await f.drainAudio(); f.atOutputHead();
      let entered = false;
      let inner: { promise: Promise<void>; state: ReturnType<typeof watch> } | undefined;
      f.setPlayheadHook(() => {
        if (reenter && !entered) {
          entered = true;
          const promise = f.player.selectAudioTrack(f.ref('es')); inner = { promise, state: watch(promise) };
        }
      });
      const outer = f.player.selectAudioTrack(f.ref('es')), outerState = watch(outer);
      await flush(512);
      expect(f.wire.requests.filter(request => request.name === 'es')).toHaveLength(1);
      const operations = [{ promise: outer, state: outerState }, ...(inner ? [inner] : [])];
      expect(operations.map(operation => operation.state.status).sort()).toEqual(reenter ? ['pending', 'rejected'] : ['pending']);
      const winner = operations.find(operation => operation.state.status === 'pending');
      expect(winner).toBeDefined();
      await f.wire.accept(f.ref('es'), 301n); f.releaseTarget(); await f.target(); f.player.tick(); await flush(512);
      expect(winner!.state.status, String(winner!.state.error)).toBe('fulfilled'); await winner!.promise;
      expect(f.player.selection.audio?.name).toBe('es');
      expect(f.wire.requests.filter(request => request.name === 'en')).toHaveLength(1);
    } finally {
      await f.destroy(); await flush(512); await new Promise<void>(resolve => { setImmediate(resolve); });
      try { expect(vi.getTimerCount()).toBe(0); expect(unhandled).toEqual([]); }
      finally { process.off('unhandledRejection', onUnhandled); vi.useRealTimers(); }
    }
  });
});
