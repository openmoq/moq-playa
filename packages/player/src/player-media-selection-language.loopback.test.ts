/** Language choice spans programs; exact track pins remain local to their program. No native MSE/PCM claim. */
import { expect, it, vi } from 'vitest';
import { buildChunk, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { audioPeer, identity, type AudioRef } from '../test-support/audio-selection.js';
import { mediaSelectionMseFixture, mseMediaRefs } from '../test-support/media-selection-mse.js';
import type { MoqtPlayerConfig } from './config.js';
import { selectionIntentFromSelectors } from './configured-selection.js';

type Fixture = Awaited<ReturnType<typeof mediaSelectionMseFixture>>;
interface CatalogTrack { name: string; namespace: string; [property: string]: unknown }
interface CatalogDocument { version: number; tracks: CatalogTrack[] }
const spanishA = { name: 'audio', namespace: ['program', 'one', 'spanish'] } as const;
const spanishB = { name: 'audio', namespace: ['program', 'two', 'spanish'] } as const;
const videoC = { name: 'video', namespace: ['program', 'three', 'picture'] } as const;
const englishC = { name: 'audio', namespace: ['program', 'three', 'english'] } as const;
const spanishC = { name: 'audio', namespace: ['program', 'three', 'spanish'] } as const;
const spanishCAlternate = { name: 'audio', namespace: ['program', 'three', 'alternate-spanish'] } as const;
const sameRef = (a: AudioRef, b: AudioRef) => a.name === b.name && JSON.stringify(a.namespace) === JSON.stringify(b.namespace);
const sourceKey = (ref: AudioRef) => JSON.stringify([ref.namespace, ref.name]);
const referenceFor = (f: Fixture) => {
  const reference = f.player.mediaTimelineReference;
  if (!reference) throw new Error('No accepted source reference');
  return reference;
};

function audioChunk(rawUs: bigint, marker: number, object = 0n) {
  return buildChunk({ trackId: 21, bmdt: rawUs * 48_000n / 1_000_000n,
    samples: [{ duration: 960, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(marker, Number(object), 3, 4) });
}

async function startPrograms(spanishInB = true, config: Partial<MoqtPlayerConfig> = {}, initialLanguage = 'en') {
  const f = await mediaSelectionMseFixture({ timeoutMs: 1000, config });
  try {
    const catalog = JSON.parse(new TextDecoder().decode(f.catalog)) as CatalogDocument;
    const find = (ref: AudioRef) => {
      const track = catalog.tracks.find(track => track.name === ref.name && track.namespace === ref.namespace.join('/'));
      if (!track) throw new Error('Fixture catalog is missing a source track');
      return track;
    };
    const oldAudio = find(mseMediaRefs.oldAudio), nextAudio = find(mseMediaRefs.nextAudio), nextVideo = find(mseMediaRefs.nextVideo);
    oldAudio.lang = initialLanguage;
    catalog.tracks.push({ ...oldAudio, namespace: spanishA.namespace.join('/'), lang: 'es' });
    if (spanishInB) catalog.tracks.push({ ...nextAudio, namespace: spanishB.namespace.join('/'), lang: 'es' });
    catalog.tracks.push(
      { ...nextVideo, namespace: videoC.namespace.join('/'), renderGroup: 3, altGroup: 51 },
      { ...nextAudio, namespace: englishC.namespace.join('/'), renderGroup: 3, altGroup: 61, lang: 'en' },
      { ...nextAudio, namespace: spanishC.namespace.join('/'), renderGroup: 3, altGroup: 61, lang: 'es' },
      { ...nextAudio, namespace: spanishCAlternate.namespace.join('/'), renderGroup: 3, altGroup: 61, lang: 'es' },
    );
    await f.wire.send(mseMediaRefs.catalog, new TextEncoder().encode(JSON.stringify(catalog)), 2n);
    await flush(512);
    void f.player.mediaTimelineReference; await f.sendOld(1_000_040_000n, 1n);
    return { ...f, languageCatalog: catalog };
  } catch (error) { await f.destroy(); throw error; }
}

async function startSpanish(spanishInB = true, config: Partial<MoqtPlayerConfig> = {}) {
  const f = await startPrograms(spanishInB, config);
  try {
    const selecting = f.player.selectAudioTrack(spanishA);
    void selecting.catch(() => {});
    await flush(512); await f.wire.accept(spanishA, 410n);
    await f.wire.send(spanishA, audioChunk(1_000_060_000n, 61), 71n); await flush(512); await selecting;
    expect(f.player.selection.audio).toEqual(identity(spanishA));
    expect(f.sourceAppends.at(-1)).toMatchObject({ media: 'audio', sourceKey: sourceKey(spanishA), marker: 61, presentationTimeUs: 60_000n });
    expect(referenceFor(f).track).toEqual(identity(spanishA));
    return f;
  } catch (error) { await f.destroy(); throw error; }
}

interface Program {
  readonly renderGroup: number;
  readonly video: AudioRef;
  readonly audio: AudioRef;
  readonly videoRawUs: bigint;
  readonly audioRawUs: bigint;
  readonly videoGroup: bigint;
  readonly audioGroup: bigint;
  readonly videoAlias: bigint;
  readonly audioAlias: bigint;
  readonly marker: number;
}
const programB = (audio: AudioRef): Program => ({ renderGroup: 2, video: mseMediaRefs.nextVideo, audio,
  videoRawUs: 90_100_000n, audioRawUs: 900_100_000n, videoGroup: 3n, audioGroup: 901n, videoAlias: 300n, audioAlias: 411n, marker: 62 });
const programC = (audio: AudioRef): Program => ({ renderGroup: 3, video: videoC, audio,
  videoRawUs: 300_100_000n, audioRawUs: 500_100_000n, videoGroup: 30n, audioGroup: 9001n, videoAlias: 500n, audioAlias: 501n, marker: 63 });

function beginProgram(f: Fixture, program: Program, explicitAudio = false) {
  const reference = referenceFor(f), referenceTimeUs = reference.observedSourceTimeUs + 20_000n;
  const selecting = f.player.selectMedia({ renderGroup: program.renderGroup, ...(explicitAudio ? { audioTrack: program.audio } : {}) }, {
    timeline: { kind: 'reference-map', referenceToken: reference.token,
      video: { sourceTimeUs: program.videoRawUs, referenceTimeUs },
      audio: { sourceTimeUs: program.audioRawUs, referenceTimeUs } },
  });
  void selecting.catch(() => {});
  return selecting;
}

async function adoptProgram(f: Fixture, program: Program) {
  const previous = f.player.selection, before = f.wire.requests.length;
  const previousAudio = f.sourceAppends.filter(append => append.media === 'audio').at(-1);
  if (!previousAudio) throw new Error('No accepted current audio');
  const selecting = beginProgram(f, program);
  await flush(512);
  expect(f.wire.requests.slice(before).map(({ name, namespace }) => ({ name, namespace }))).toEqual([program.video, program.audio]);
  expect(f.player.selection).toEqual(previous);
  await f.wire.accept(program.video, program.videoAlias); await f.wire.accept(program.audio, program.audioAlias);
  await f.wire.send(program.video, f.chunk('nextVideo', program.videoRawUs), program.videoGroup);
  await f.wire.send(program.audio, audioChunk(program.audioRawUs, program.marker), program.audioGroup);
  await flush(512); await selecting;
  expect(f.player.selection.scope).toEqual({ kind: 'render-group', renderGroup: program.renderGroup });
  expect(f.player.selection.video).toEqual(identity(program.video));
  expect(f.player.selection.audio).toEqual(identity(program.audio));
  expect(f.sourceAppends.filter(append => append.media === 'video').at(-1)).toMatchObject({ sourceKey: sourceKey(program.video), presentationTimeUs: previousAudio.presentationTimeUs + 20_000n });
  expect(f.sourceAppends.filter(append => append.media === 'audio').at(-1)).toMatchObject({ sourceKey: sourceKey(program.audio), marker: program.marker, presentationTimeUs: previousAudio.presentationTimeUs + 20_000n });
  expect(referenceFor(f).track).toEqual(identity(program.audio));
  expect(f.transportCalls).toHaveLength(1);
  expect(f.errors).toEqual([]); expect(f.wire.errors).toEqual([]);
}

it('carries explicit Spanish from program A through automatic Spanish in programs B and C', async () => {
  const f = await startSpanish();
  try {
    await adoptProgram(f, programB(spanishB));
    await adoptProgram(f, programC(spanishC));
  } finally { await f.destroy(); }
});

it('keeps an explicit Spanish choice ahead of startup English constraints across programs B and C', async () => {
  const f = await startSpanish(true, { audioConstraints: { lang: 'en' } });
  try {
    await adoptProgram(f, programB(spanishB));
    await adoptProgram(f, programC(spanishC));
  } finally { await f.destroy(); }
});

it('retains Spanish for program C after program B offers only an English fallback', async () => {
  const f = await startSpanish(false);
  try {
    await adoptProgram(f, programB(mseMediaRefs.nextAudio));
    await adoptProgram(f, programC(spanishC));
  } finally { await f.destroy(); }
});

it('updates the carried language when the viewer explicitly chooses English in program B', async () => {
  const f = await startSpanish();
  try {
    await adoptProgram(f, programB(spanishB));
    const video = f.player.selection.video, videoRequest = f.wire.request(mseMediaRefs.nextVideo).id;
    const selecting = f.player.selectAudioTrack(mseMediaRefs.nextAudio);
    void selecting.catch(() => {});
    await flush(512); await f.wire.accept(mseMediaRefs.nextAudio, 412n);
    await f.wire.send(mseMediaRefs.nextAudio, audioChunk(900_120_000n, 64), 902n);
    await flush(512); await selecting;
    expect(f.player.selection.video).toEqual(video);
    expect(f.wire.stopped).not.toContain(videoRequest);
    expect(f.player.selection.audio).toEqual(identity(mseMediaRefs.nextAudio));
    expect(f.sourceAppends.at(-1)).toMatchObject({ media: 'audio', sourceKey: sourceKey(mseMediaRefs.nextAudio), marker: 64, presentationTimeUs: 100_000n });
    await adoptProgram(f, programC(englishC));
  } finally { await f.destroy(); }
});

it('keeps the Spanish choice after an explicit English program attempt is refused', async () => {
  const f = await startSpanish();
  try {
    const before = f.player.selection, videoRequest = f.wire.request(mseMediaRefs.oldVideo).id, audioRequest = f.wire.request(spanishA).id;
    const program = programB(mseMediaRefs.nextAudio), requests = f.wire.requests.length;
    const selecting = beginProgram(f, program, true);
    await flush(512);
    expect(f.wire.requests.slice(requests).map(({ name, namespace }) => ({ name, namespace }))).toEqual([program.video, program.audio]);
    await f.wire.accept(program.video, program.videoAlias);
    await f.wire.send(program.video, f.chunk('nextVideo', program.videoRawUs), program.videoGroup);
    await flush(512); await f.wire.reject(program.audio);
    await expect(selecting).rejects.toThrow(/refused/i);
    expect(f.player.selection).toEqual(before);
    expect(f.wire.stopped).not.toContain(videoRequest); expect(f.wire.stopped).not.toContain(audioRequest);
    await f.send('oldVideo', 1_000_080_000n, 2n);
    await f.wire.send(spanishA, audioChunk(1_000_080_000n, 61, 1n), 71n, 1n);
    await flush(512);
    expect(f.sourceAppends.filter(append => append.media === 'video').at(-1)).toMatchObject({ sourceKey: sourceKey(mseMediaRefs.oldVideo), presentationTimeUs: 80_000n });
    expect(f.sourceAppends.at(-1)).toMatchObject({ media: 'audio', sourceKey: sourceKey(spanishA), marker: 61, presentationTimeUs: 80_000n });
    await adoptProgram(f, programC(spanishC));
    expect(f.wire.requests.filter(request => sameRef(request, spanishA))).toHaveLength(1);
  } finally { await f.destroy(); }
});

it('remembers a successful generic explicit audio choice across two automatic program adoptions', async () => {
  const f = await startPrograms();
  try {
    const before = f.player.selection, videoRequest = f.wire.request(mseMediaRefs.oldVideo).id;
    const selecting = f.player.selectMedia({ audioTrack: spanishA }, { timeline: {
      kind: 'reference-map', referenceToken: referenceFor(f).token,
      audio: { sourceTimeUs: 1_000_060_000n, referenceTimeUs: 1_000_060_000n },
    } });
    void selecting.catch(() => {});
    await flush(512);
    expect(f.player.selection).toEqual(before);
    await f.wire.accept(spanishA, 410n);
    await f.wire.send(spanishA, audioChunk(1_000_060_000n, 61), 71n);
    await flush(512); await selecting;
    expect(f.player.selection.audio).toEqual(identity(spanishA));
    expect(f.player.selection.video).toEqual(before.video);
    expect(f.wire.stopped).not.toContain(videoRequest);
    expect(f.sourceAppends.at(-1)).toMatchObject({ media: 'audio', sourceKey: sourceKey(spanishA), marker: 61, presentationTimeUs: 60_000n });
    await adoptProgram(f, programB(spanishB));
    await adoptProgram(f, programC(spanishC));
  } finally { await f.destroy(); }
});

it.each(['generic', 'direct'] as const)('remembers the first explicit language choice through a %s same-current audio no-op', async api => {
  // Startup chose this identity before its language was described as Spanish.
  // No earlier user selection has established a language preference.
  const f = await startPrograms(true, {}, 'es');
  try {
    const before = f.player.selection, requests = f.wire.requests.slice(), stopped = f.wire.stopped.slice(), appends = f.sourceAppends.length;
    if (api === 'generic') await f.player.selectMedia({ audioTrack: mseMediaRefs.oldAudio });
    else await f.player.selectAudioTrack(mseMediaRefs.oldAudio);
    expect(f.player.selection).toEqual(before);
    expect(f.wire.requests).toEqual(requests); expect(f.wire.stopped).toEqual(stopped);
    expect(f.sourceAppends).toHaveLength(appends);
    await adoptProgram(f, programB(spanishB));
    await adoptProgram(f, programC(spanishC));
  } finally { await f.destroy(); }
});

it('ignores an explicit audio selector when audio is disabled at the runtime selector boundary', () => {
  // The shared MSE fixture boots both roles. This is a policy-boundary control,
  // not a claim of disabled-output engine or native device coverage.
  expect(selectionIntentFromSelectors({ audioTrack: spanishA, audioAltGroup: 21 },
    mseMediaRefs.catalog.namespace, { disableAudio: true })).toEqual({ disableAudio: true });
});

it.each([true, false])('requires no timeline map only for the same ungrouped audio identity: current=%s', async current => {
  const f = await startPrograms(true, {}, 'es');
  try {
    for (const track of f.languageCatalog.tracks) {
      if (track.namespace === mseMediaRefs.oldAudio.namespace.join('/') || track.namespace === spanishA.namespace.join('/')) {
        Reflect.deleteProperty(track, 'altGroup');
      }
    }
    await f.wire.send(mseMediaRefs.catalog, new TextEncoder().encode(JSON.stringify(f.languageCatalog)), 3n);
    await flush(512);
    const before = f.player.selection, requests = f.wire.requests.slice(), stopped = f.wire.stopped.slice();
    if (current) await expect(f.player.selectAudioTrack(mseMediaRefs.oldAudio)).resolves.toBeUndefined();
    else await expect(f.player.selectAudioTrack(spanishA)).rejects.toThrow(/explicit timeline mapping/i);
    expect(f.player.selection).toEqual(before);
    expect(f.wire.requests).toEqual(requests); expect(f.wire.stopped).toEqual(stopped);
    await f.send('oldAudio', 1_000_060_000n, 2n);
    expect(f.sourceAppends.at(-1)).toMatchObject({ media: 'audio', sourceKey: sourceKey(mseMediaRefs.oldAudio), presentationTimeUs: 60_000n });
    // Only a successful explicit choice establishes Spanish. A refused request
    // for another Spanish track must leave catalog-order English in force.
    await adoptProgram(f, programB(current ? spanishB : mseMediaRefs.nextAudio));
    await adoptProgram(f, programC(current ? spanishC : englishC));
  } finally { await f.destroy(); }
});

it('carries Spanish into handover fallback after two automatic program adoptions', async () => {
  const f = await startSpanish(true, { audioConstraints: { lang: 'en' } }), next = audioPeer(18);
  let restoreTransport: (() => void) | undefined;
  try {
    await adoptProgram(f, programB(spanishB));
    await adoptProgram(f, programC(spanishC));
    const catalog = structuredClone(f.languageCatalog);
    catalog.tracks = catalog.tracks.filter(track => track.namespace !== spanishC.namespace.join('/'));
    // Substitute the next application-created transport, preserving real
    // adapters, request bytes and the fixture's existing source/assembler.
    const transport = vi.spyOn(f.wire, 'start').mockImplementationOnce(() => next.start());
    restoreTransport = () => { transport.mockRestore(); };
    const migrating = f.player.migrate(next.client);
    void migrating.catch(() => {});
    await flush(512); await next.accept(mseMediaRefs.catalog, 100n);
    await next.send(mseMediaRefs.catalog, new TextEncoder().encode(JSON.stringify(catalog)), 1n);
    await flush(512);
    expect(next.requests.map(({ name, namespace }) => ({ name, namespace })))
      .toEqual([mseMediaRefs.catalog, videoC, spanishCAlternate]);
    await next.accept(videoC, 601n); await next.accept(spanishCAlternate, 602n); await migrating;
    expect(f.player.selection.video).toEqual(identity(videoC));
    expect(f.player.selection.audio).toEqual(identity(spanishCAlternate));
    const appends = f.sourceAppends.length;
    await next.send(videoC, f.chunk('nextVideo', 300_120_000n), 31n);
    await next.send(spanishCAlternate, audioChunk(500_120_000n, 65), 9002n);
    await flush(512);
    expect(f.sourceAppends).toHaveLength(appends + 2);
    expect(f.sourceAppends.filter(append => append.media === 'video').at(-1)).toMatchObject({ sourceKey: sourceKey(videoC), presentationTimeUs: 120_000n });
    expect(f.sourceAppends.at(-1)).toMatchObject({ media: 'audio', sourceKey: sourceKey(spanishCAlternate), marker: 65, presentationTimeUs: 120_000n });
    expect(f.transportCalls).toHaveLength(2);
    expect(f.errors).toEqual([]); expect(next.errors).toEqual([]);
  } finally { restoreTransport?.(); await f.destroy(); await next.close(); }
});
