/** Real draft-18 requests and LOC output callbacks; no native presentation claim. */
import { describe, expect, it } from 'vitest';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { audioSelectionFixture, identity, refs, type AudioRef } from '../test-support/audio-selection.js';
import { mediaRefs, mediaSelectionFixture } from '../test-support/media-selection.js';

type AudioFixture = Awaited<ReturnType<typeof audioSelectionFixture>>;
type MediaFixture = Awaited<ReturnType<typeof mediaSelectionFixture>>;
interface CatalogDocument {
  version: number;
  tracks: Array<{ name: string; namespace: string; role: string; renderGroup: number; altGroup: number;
    [property: string]: unknown }>;
}
const encode = (catalog: CatalogDocument) => new TextEncoder().encode(JSON.stringify(catalog));
const decode = (bytes: Uint8Array): CatalogDocument => JSON.parse(new TextDecoder().decode(bytes));
const sameRef = (track: { name: string; namespace: string }, ref: AudioRef) =>
  track.name === ref.name && track.namespace === ref.namespace.join('/');
const requested = (peer: AudioFixture['wire']) => peer.requests.map(({ name, namespace }) => ({ name, namespace }));
function watch(work: Promise<void>) {
  const state: { status: 'pending' | 'fulfilled' | 'rejected'; error?: unknown } = { status: 'pending' };
  void work.then(() => { state.status = 'fulfilled'; }, error => { state.status = 'rejected'; state.error = error; });
  return state;
}

async function replaceEnglish(f: AudioFixture) {
  const next = f.peers[1]!, migrating = f.player.migrate(next.client), state = watch(migrating);
  await flush(512); await next.accept(refs.catalog, 500n);
  const catalog = decode(f.catalog);
  catalog.tracks = catalog.tracks.filter(track => !sameRef(track, refs.english) && !sameRef(track, refs.french));
  await next.send(refs.catalog, encode(catalog), 1n); await flush(512);
  return { next, migrating, state };
}

async function expectAutomaticSpanish(f: AudioFixture) {
  const { next, migrating, state } = await replaceEnglish(f);
  expect(state.status, JSON.stringify({ error: String(state.error), requests: requested(next) })).toBe('pending');
  expect(requested(next)).toEqual([refs.catalog, refs.video, refs.spanish]);
  await next.accept(refs.video, 600n); await next.accept(refs.spanish, 601n);
  const pts = BigInt(f.nowUs + 20_000), audio = f.scheduledAudio.length, video = f.renderedVideo.length;
  await f.sendVideo(pts, 1n, next); await f.sendAudio('spanish', 71n, 0n, pts, next);
  f.tick(1); await flush(512);
  expect(state.status, String(state.error)).toBe('fulfilled'); await migrating;
  expect(f.player.selection.audio).toEqual(identity(refs.spanish));
  expect(f.player.selection.video).toEqual(identity(refs.video));
  expect(f.decodedAudio.at(-1)?.bytes[1]).toBe(31);
  expect(f.scheduledAudio).toHaveLength(audio + 1); expect(f.scheduledAudio.at(-1)?.timestamp).toBe(Number(pts));
  expect(f.renderedVideo).toHaveLength(video + 1); expect(f.renderedVideo.at(-1)?.timestamp).toBe(Number(pts));
  expect(f.transportCalls).toHaveLength(2); expect(f.errors).toEqual([]); expect(next.errors).toEqual([]);
}

async function expectEnglishPinRefusal(f: AudioFixture) {
  const before = f.player.selection, { next, migrating, state } = await replaceEnglish(f);
  expect(state.status, String(state.error)).toBe('rejected'); await expect(migrating).rejects.toThrow(/audio/i);
  expect(requested(next)).toEqual([refs.catalog]); expect(f.player.selection).toEqual(before);
  const pts = BigInt(f.nowUs + 20_000), audio = f.scheduledAudio.length, video = f.renderedVideo.length;
  await f.sendAudio('english', 70n, 1n, pts); await f.sendVideo(pts, 1n); f.tick(1); await flush(512);
  expect(f.scheduledAudio).toHaveLength(audio + 1); expect(f.scheduledAudio.at(-1)?.timestamp).toBe(Number(pts));
  expect(f.renderedVideo).toHaveLength(video + 1); expect(f.renderedVideo.at(-1)?.timestamp).toBe(Number(pts));
  expect(f.wire.stopped).not.toContain(f.wire.request(refs.english).id);
  expect(f.wire.stopped).not.toContain(f.wire.request(refs.video).id);
  expect(f.wire.transport.closeInfo).toBeUndefined(); expect(f.errors).toEqual([]);
}

describe('generic selection audio pin provenance', () => {
  it('retains the initial configured audio pin when same-scope selection omits audio', async () => {
    const f = await audioSelectionFixture(18, { path: 'loc' });
    try {
      const requests = f.wire.requests.slice();
      await f.player.selectMedia({ videoAltGroup: 1 });
      expect(f.wire.requests).toEqual(requests); expect(f.player.selection.audio).toEqual(identity(refs.english));
      await expectEnglishPinRefusal(f);
    } finally { await f.destroy(); }
  });

  it('releases the initial configured audio pin when an audio alternate group is explicitly selected', async () => {
    const f = await audioSelectionFixture(18, { path: 'loc' });
    try {
      const requests = f.wire.requests.slice();
      await f.player.selectMedia({ audioAltGroup: 3 });
      expect(f.wire.requests).toEqual(requests); expect(f.player.selection.audio).toEqual(identity(refs.english));
      await expectAutomaticSpanish(f);
    } finally { await f.destroy(); }
  });

  it('releases a runtime audio track pin when an audio alternate group is explicitly selected', async () => {
    const f = await audioSelectionFixture(18, { path: 'loc', config: { selection: { videoTrack: refs.video } } });
    try {
      const requests = f.wire.requests.slice();
      await f.player.selectMedia({ audioTrack: refs.english });
      await f.player.selectMedia({ audioAltGroup: 3 });
      expect(f.wire.requests).toEqual(requests); expect(f.player.selection.audio).toEqual(identity(refs.english));
      await expectAutomaticSpanish(f);
    } finally { await f.destroy(); }
  });

  it('keeps automatic audio automatic when same-scope selection omits audio', async () => {
    const f = await audioSelectionFixture(18, { path: 'loc', config: { selection: { videoTrack: refs.video } } });
    try {
      await f.player.selectMedia({ videoAltGroup: 1 });
      await expectAutomaticSpanish(f);
    } finally { await f.destroy(); }
  });

  it('refuses replacement loss of an explicitly selected runtime audio track', async () => {
    const f = await audioSelectionFixture(18, { path: 'loc', config: { selection: { videoTrack: refs.video } } });
    try {
      await f.player.selectMedia({ audioTrack: refs.english });
      await expectEnglishPinRefusal(f);
    } finally { await f.destroy(); }
  });
});

const programAlternate = { namespace: ['show', 'next', 'alternate-sound'], name: 'audio' } as const;
async function adoptProgram(f: MediaFixture, pin: boolean) {
  const catalog = decode(f.catalog), target = catalog.tracks.find(track => sameRef(track, mediaRefs.nextAudio));
  if (!target) throw new Error('Fixture catalog has no target-program audio');
  catalog.tracks.push({ ...target, namespace: programAlternate.namespace.join('/') });
  // A public catalog update establishes the alternate BEFORE handover intent
  // is captured. No new alternate relationship is invented on replacement.
  await f.wire.send(mediaRefs.catalog, encode(catalog), 2n); await flush(512);
  void f.player.mediaTimelineReference; await f.sendOld(10_040_000n, 1n);
  const reference = f.player.mediaTimelineReference;
  if (!reference) throw new Error('Accepted old audio has no canonical media reference');
  expect(reference.track).toEqual(identity(mediaRefs.oldAudio)); expect(reference.observedSourceTimeUs).toBe(10_040_000n);
  const selecting = f.player.selectMedia({ renderGroup: 2, ...(pin ? { audioTrack: mediaRefs.nextAudio } : {}) },
    { timeline: { kind: 'reference-map', referenceToken: reference.token,
      video: { sourceTimeUs: 90_000_000n, referenceTimeUs: 10_000_000n },
      audio: { sourceTimeUs: 900_000_000n, referenceTimeUs: 10_000_000n } } });
  const state = watch(selecting);
  await flush(512); await f.accept('nextVideo'); await f.accept('nextAudio');
  await f.send('nextVideo', 90_080_000n); await f.send('nextAudio', 900_080_000n); f.tick(0); await flush(512);
  expect(state.status, String(state.error)).toBe('fulfilled'); await selecting;
  expect(f.player.selection.scope).toEqual({ kind: 'render-group', renderGroup: 2 });
  expect(f.player.selection.audio).toEqual(identity(mediaRefs.nextAudio));
  expect(f.enqueuedVideo.at(-1)).toMatchObject({ key: 'nextVideo', rawTimestampUs: 90_080_000 });
  expect(f.scheduledAudio.at(-1)).toMatchObject({ key: 'nextAudio', rawTimestampUs: 900_080_000 });
  expect(requested(f.wire)).toEqual([mediaRefs.catalog, mediaRefs.oldVideo, mediaRefs.oldAudio, mediaRefs.nextVideo, mediaRefs.nextAudio]);
  return catalog;
}

async function replaceProgramAudio(f: MediaFixture, catalog: CatalogDocument) {
  const next = f.peers[1]!, migrating = f.player.migrate(next.client), state = watch(migrating);
  await flush(512); await next.accept(mediaRefs.catalog, 500n);
  const replacement = { ...catalog, tracks: catalog.tracks.filter(track => !sameRef(track, mediaRefs.nextAudio)) };
  await next.send(mediaRefs.catalog, encode(replacement), 1n); await flush(512);
  return { next, migrating, state };
}

describe('program selection releases only prior-scope audio pins', () => {
  it('allows automatic program audio to use a surviving established alternate after leaving an initially pinned program', async () => {
    const f = await mediaSelectionFixture();
    try {
      const catalog = await adoptProgram(f, false), { next, migrating, state } = await replaceProgramAudio(f, catalog);
      expect(state.status, JSON.stringify({ error: String(state.error), requests: requested(next) })).toBe('pending');
      expect(requested(next)).toEqual([mediaRefs.catalog, mediaRefs.nextVideo, programAlternate]);
      await next.accept(mediaRefs.nextVideo, 600n); await next.accept(programAlternate, 601n);
      const video = f.enqueuedVideo.length, audio = f.scheduledAudio.length;
      await f.send('nextVideo', 90_100_000n, 1n, next);
      await next.send(programAlternate, Uint8Array.of(0x48, 41, 0), 902n, 0n,
        encodeLocHeaders({ timestamp: 86_409_600n, timescale: 96_000n },
          { locVersion: 4, wireProfile: locWireProfileForDraft(18) }));
      f.tick(0); await flush(512);
      expect(state.status, String(state.error)).toBe('fulfilled'); await migrating;
      expect(f.player.selection.audio).toEqual(identity(programAlternate));
      expect(f.player.selection.video).toEqual(identity(mediaRefs.nextVideo));
      expect(f.enqueuedVideo).toHaveLength(video + 1); expect(f.enqueuedVideo.at(-1)?.rawTimestampUs).toBe(90_100_000);
      expect(f.scheduledAudio).toHaveLength(audio + 1); expect(f.scheduledAudio.at(-1)?.rawTimestampUs).toBe(900_100_000);
      expect(f.transportCalls).toHaveLength(2); expect(f.errors).toEqual([]); expect(next.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('refuses loss of a new-program explicit audio pin while both adopted outputs continue', async () => {
    const f = await mediaSelectionFixture();
    try {
      const catalog = await adoptProgram(f, true), before = f.player.selection;
      const { next, migrating, state } = await replaceProgramAudio(f, catalog);
      expect(state.status, String(state.error)).toBe('rejected'); await expect(migrating).rejects.toThrow(/audio/i);
      expect(requested(next)).toEqual([mediaRefs.catalog]); expect(f.player.selection).toEqual(before);
      const video = f.enqueuedVideo.length, audio = f.scheduledAudio.length;
      await f.send('nextVideo', 90_100_000n, 1n); await f.send('nextAudio', 900_100_000n, 1n); f.tick(0); await flush(512);
      expect(f.enqueuedVideo).toHaveLength(video + 1); expect(f.enqueuedVideo.at(-1)?.rawTimestampUs).toBe(90_100_000);
      expect(f.scheduledAudio).toHaveLength(audio + 1); expect(f.scheduledAudio.at(-1)?.rawTimestampUs).toBe(900_100_000);
      expect(f.wire.stopped).not.toContain(f.wire.request(mediaRefs.nextVideo).id);
      expect(f.wire.stopped).not.toContain(f.wire.request(mediaRefs.nextAudio).id);
      expect(f.wire.transport.closeInfo).toBeUndefined(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});
