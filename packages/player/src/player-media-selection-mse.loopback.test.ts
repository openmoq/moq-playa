/** Real request streams and CMAF assembly; observable append calls are not native MSE playback. */
import { expect, it, vi } from 'vitest';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { boxSize } from '../../browser/src/mp4-box.js';
import type { MediaSelectionOptions } from './index.js';
import { mediaSelectionMseFixture, mseMediaRefs, mseMediaTracks } from '../test-support/media-selection-mse.js';

type Fixture = Awaited<ReturnType<typeof mediaSelectionMseFixture>>;
const identity = (ref: { name: string; namespace: readonly string[] }) => ({ name: ref.name, namespaceFields: [...ref.namespace] });
const sourceKey = (ref: { name: string; namespace: readonly string[] }) => JSON.stringify([ref.namespace, ref.name]);
function oldIsOwned(f: Fixture) {
  expect(f.player.selection.video).toEqual(identity(mseMediaRefs.oldVideo));
  expect(f.player.selection.audio).toEqual(identity(mseMediaRefs.oldAudio));
  for (const ref of [mseMediaRefs.oldVideo, mseMediaRefs.oldAudio]) expect(f.wire.stopped).not.toContain(f.wire.request(ref).id);
  expect(f.transportCalls).toHaveLength(1); expect(f.wire.transport.closeInfo).toBeUndefined();
}
async function reference(f: Fixture) {
  expect(f.player.mediaTimelineReference).toBeNull(); // arms real source receipt collection
  await f.sendOld(1_000_040_000n, 1n);
  const value = f.player.mediaTimelineReference;
  expect(value).toMatchObject({ track: identity(mseMediaRefs.oldAudio), observedSourceTimeUs: 1_000_040_000n, domain: 'media-time' });
  if (!value) throw new Error('Accepted old media did not produce a reference');
  return value;
}
const nextProgram = { renderGroup: 2, videoTrack: mseMediaRefs.nextVideo, audioTrack: mseMediaRefs.nextAudio } as const;
function maps(referenceToken: object): MediaSelectionOptions {
  return { timeline: { kind: 'reference-map', referenceToken,
    video: { sourceTimeUs: 90_000_000n, referenceTimeUs: 1_000_000_000n },
    audio: { sourceTimeUs: 900_000_000n, referenceTimeUs: 1_000_000_000n } } };
}
function watch(promise: Promise<void>) {
  const state: { status: 'pending' | 'fulfilled' | 'rejected'; error?: unknown } = { status: 'pending' };
  void promise.then(() => { state.status = 'fulfilled'; }, error => { state.status = 'rejected'; state.error = error; });
  return state;
}
async function beginProgram(f: Fixture, holdAudio = false) {
  const current = await reference(f), before = f.player.selection, events = f.selections.length;
  const release = holdAudio ? f.hold('nextAudio') : () => {};
  const selecting = f.player.selectMedia(nextProgram, maps(current.token)), state = watch(selecting);
  await flush(512);
  // An early unsupported-capability refusal must fail here as an assertion,
  // before any attempt to accept a request which was never issued.
  expect(state.status, String(state.error)).toBe('pending');
  return { current, before, events, release, selecting, state };
}
function noTargetAppend(f: Fixture) {
  expect(f.appendCalls.filter(append => [31, 41, 51].includes(append.marker))).toEqual([]);
}
async function oldStillSubmits(f: Fixture, ptsUs = 1_000_060_000n, object = 2n) {
  const count = f.appendCalls.length;
  await f.sendOld(ptsUs, object);
  expect(f.appendCalls).toHaveLength(count + 2);
  expect(f.appendCalls.slice(-2).map(append => [append.media, append.marker, append.presentationTimeUs]))
    .toEqual([['video', 11, ptsUs - 1_000_000_000n], ['audio', 21, ptsUs - 1_000_000_000n]]);
  expect(f.appendCalls.slice(-2).map(append => [append.trackName, append.sourceKey])).toEqual([
    [mseMediaRefs.oldVideo.name, sourceKey(mseMediaRefs.oldVideo)], [mseMediaRefs.oldAudio.name, sourceKey(mseMediaRefs.oldAudio)],
  ]);
  oldIsOwned(f);
}
function oldPhysicalStateRetained(f: Fixture) {
  expect(f.installed.get('video')).toEqual(f.headers.video); expect(f.installed.get('audio')).toEqual(f.headers.audio);
  expect(f.sourceMutations.filter(event => ['reset', 'destroy', 'changeType'].includes(event.kind))).toEqual([]);
}

it('starts exact-tuple old A/V through real same-config CMAF assembly and recorded source offsets', async () => {
  const f = await mediaSelectionMseFixture();
  try {
    oldIsOwned(f);
    expect(f.wire.requests.map(({ name, namespace }) => ({ name, namespace }))).toEqual([
      mseMediaRefs.catalog, mseMediaRefs.oldVideo, mseMediaRefs.oldAudio,
    ]);
    expect(f.assemblers).toHaveLength(1);
    expect(f.sourceAppends.map(append => [append.media, append.marker, append.presentationTimeUs, append.timestampOffset]))
      .toEqual([['video', mseMediaTracks.oldVideo.marker, 0n, 0], ['audio', mseMediaTracks.oldAudio.marker, 0n, 0]]);
    expect(f.segments.map(segment => segment.bytes)).toEqual(f.sourceAppends.map(append => append.bytes));
    expect(f.timestampOffsets).toEqual(new Map([['video', 0], ['audio', 0]]));
    expect(f.sourceMutations.filter(event => event.kind === 'setTimestampOffset')).toEqual([
      { kind: 'setTimestampOffset', media: 'video', value: 0 }, { kind: 'setTimestampOffset', media: 'audio', value: 0 },
    ]);
    expect(f.runningAssembler.capturePresentationPlacement('audio')?.toRebasedTimeUs(1_000_000_000n))
      .toEqual({ numerator: 0n, denominator: 1n });
    expect(f.errors).toEqual([]); expect(f.wire.errors).toEqual([]);
  } finally { await f.destroy(); }
});

it('captures the canonical raw reference only from accepted old media while later old appends continue', async () => {
  const f = await mediaSelectionMseFixture();
  try {
    const current = await reference(f), placement = f.runningAssembler.capturePresentationPlacement('audio');
    expect(placement?.toRebasedTimeUs(current.observedSourceTimeUs)).toEqual({ numerator: 40000n, denominator: 1n });
    await f.sendOld(1_000_060_000n, 2n);
    expect(f.player.mediaTimelineReference?.token).toBe(current.token);
    expect(f.sourceAppends.slice(-2).map(append => [append.media, append.marker, append.presentationTimeUs]))
      .toEqual([['video', mseMediaTracks.oldVideo.marker, 60000n], ['audio', mseMediaTracks.oldAudio.marker, 60000n]]);
    oldIsOwned(f); expect(f.errors).toEqual([]);
  } finally { await f.destroy(); }
});

it('passes the runtime source identity to old media assembly and appends without changing human track names', async () => {
  const f = await mediaSelectionMseFixture();
  try {
    expect(f.source.supportsTrackIdentity).toBe(true); expect(f.runningAssembler.supportsTrackIdentity).toBe(true);
    for (const [marker, ref] of [[11, mseMediaRefs.oldVideo], [21, mseMediaRefs.oldAudio]] as const) {
      const append = f.appendCalls.find(append => append.marker === marker);
      expect(append?.trackName).toBe(ref.name);
      expect.soft(append?.sourceKey).toBe(sourceKey(ref));
      const segment = f.segments.find(segment => segment.media === (marker === 11 ? 'video' : 'audio'));
      expect(segment?.trackName).toBe(ref.name);
      expect.soft(segment?.sourceKey).toBe(sourceKey(ref));
    }
    oldIsOwned(f); expect(f.errors).toEqual([]);
  } finally { await f.destroy(); }
});

it('adopts same-init MSE A/V namespace tuples together with distinct raw PTS placed on the continuing element timeline', async () => {
  const f = await mediaSelectionMseFixture();
  try {
    const operation = await beginProgram(f, true);
    await f.accept('nextVideo'); await f.accept('nextAudio');
    expect(f.wire.request(mseMediaRefs.nextVideo)).toMatchObject(mseMediaRefs.nextVideo);
    expect(f.wire.request(mseMediaRefs.nextAudio)).toMatchObject(mseMediaRefs.nextAudio);
    await f.send('nextVideo', 90_080_000n, 0n, 40_000n); await f.send('nextAudio', 900_080_000n, 0n, 10_000n);
    expect(operation.state.status).toBe('pending'); noTargetAppend(f); oldPhysicalStateRetained(f);
    await oldStillSubmits(f);
    operation.release(); await flush(512);
    expect(operation.state.status, String(operation.state.error)).toBe('fulfilled'); await operation.selecting;
    expect(f.player.selection.video).toEqual(identity(mseMediaRefs.nextVideo));
    expect(f.player.selection.audio).toEqual(identity(mseMediaRefs.nextAudio));
    expect(f.player.selection.revision).toBe(operation.before.revision + 1);
    expect(f.selections.slice(operation.events)).toEqual([f.player.selection]);
    const video = f.sourceAppends.find(append => append.marker === 31), audio = f.sourceAppends.find(append => append.marker === 41);
    expect(video).toMatchObject({ media: 'video', trackName: mseMediaRefs.nextVideo.name, sourceKey: sourceKey(mseMediaRefs.nextVideo),
      presentationTimeUs: 80000n, decodeTimeUs: 40000n, ctoTicks: 3600, timestampOffset: 0 });
    expect(audio).toMatchObject({ media: 'audio', trackName: mseMediaRefs.nextAudio.name, sourceKey: sourceKey(mseMediaRefs.nextAudio),
      presentationTimeUs: 80000n, decodeTimeUs: 70000n, ctoTicks: 480, timestampOffset: 0 });
    expect(f.sent.filter(input => input.key === 'nextVideo' || input.key === 'nextAudio').map(input => input.rawPresentationTimeUs))
      .toEqual([90_080_000n, 900_080_000n]);
    expect(f.segments.some(segment => segment.bytes.every((value, index) => value === video?.bytes[index]) && segment.bytes.length === video?.bytes.length)).toBe(true);
    for (const ref of [mseMediaRefs.oldVideo, mseMediaRefs.oldAudio]) expect(f.wire.stopped).toContain(f.wire.request(ref).id);
    expect(f.transportCalls).toHaveLength(1); expect(f.errors).toEqual([]);
  } finally { await f.destroy(); }
});

it('maps an MSE view using the adopted reference while retaining the exact audio owner and its request', async () => {
  const f = await mediaSelectionMseFixture();
  try {
    const current = await reference(f), before = f.player.selection, events = f.selections.length;
    const selecting = f.player.selectMedia({ videoTrack: mseMediaRefs.viewVideo }, { timeline: {
      kind: 'reference-map', referenceToken: current.token, video: { sourceTimeUs: 700_000_000n, referenceTimeUs: 1_000_000_000n } } });
    const state = watch(selecting); await flush(512); expect(state.status, String(state.error)).toBe('pending');
    await f.accept('viewVideo'); await f.send('oldAudio', 1_000_080_000n, 2n); await f.send('viewVideo', 700_080_000n, 0n, 40_000n);
    await flush(512); expect(state.status, String(state.error)).toBe('fulfilled'); await selecting;
    expect(f.player.selection.video).toEqual(identity(mseMediaRefs.viewVideo));
    expect(f.player.selection.audio).toEqual(before.audio);
    expect(f.sourceAppends.at(-1)).toMatchObject({ marker: 51, trackName: mseMediaRefs.viewVideo.name,
      sourceKey: sourceKey(mseMediaRefs.viewVideo), presentationTimeUs: 80000n, decodeTimeUs: 40000n, timestampOffset: 0 });
    expect(f.sourceAppends.filter(append => append.media === 'audio').at(-1)).toMatchObject({ marker: 21,
      trackName: mseMediaRefs.oldAudio.name, sourceKey: sourceKey(mseMediaRefs.oldAudio), presentationTimeUs: 80000n });
    expect(f.wire.requests.filter(request => request.name === mseMediaRefs.oldAudio.name
      && JSON.stringify(request.namespace) === JSON.stringify(mseMediaRefs.oldAudio.namespace))).toHaveLength(1);
    expect(f.wire.requests).toHaveLength(4); expect(f.wire.stopped).not.toContain(f.wire.request(mseMediaRefs.oldAudio).id);
    expect(f.selections.slice(events)).toEqual([f.player.selection]); expect(f.errors).toEqual([]);
  } finally { await f.destroy(); }
});

it('keeps both old outputs when ready target video is followed by an unaccepted audio request refusal', async () => {
  const f = await mediaSelectionMseFixture();
  try {
    const operation = await beginProgram(f);
    await f.accept('nextVideo'); await f.send('nextVideo', 90_080_000n, 0n, 40_000n);
    expect(operation.state.status).toBe('pending'); noTargetAppend(f); oldPhysicalStateRetained(f);
    await oldStillSubmits(f);
    await f.wire.reject(mseMediaRefs.nextAudio); await flush(512);
    await expect(operation.selecting).rejects.toThrow();
    expect(f.player.selection).toEqual(operation.before); expect(f.selections).toHaveLength(operation.events);
    noTargetAppend(f); oldPhysicalStateRetained(f); expect(f.acceptedQueue).toEqual([]);
    await oldStillSubmits(f, 1_000_080_000n, 3n); expect(f.errors.some(error => error.severity === 'fatal')).toBe(false);
  } finally { await f.destroy(); }
});

it('does not adopt accepted but incomplete target audio and retains both old outputs at the preparation deadline', async () => {
  vi.useFakeTimers(); let f: Fixture | undefined;
  try {
    f = await mediaSelectionMseFixture({ timeoutMs: 100 });
    const operation = await beginProgram(f);
    await f.accept('nextVideo'); await f.accept('nextAudio'); await f.send('nextVideo', 90_080_000n, 0n, 40_000n);
    const audio = f.chunk('nextAudio', 900_080_000n, 0n, 10_000n);
    await f.sendBytes('nextAudio', audio.subarray(0, boxSize(audio, 0)), 900_080_000n);
    expect(operation.state.status).toBe('pending'); noTargetAppend(f); oldPhysicalStateRetained(f);
    await oldStillSubmits(f); await vi.advanceTimersByTimeAsync(99); expect(operation.state.status).toBe('pending');
    await vi.advanceTimersByTimeAsync(1); await expect(operation.selecting).rejects.toThrow(/timed out/i);
    expect(f.player.selection).toEqual(operation.before); expect(f.selections).toHaveLength(operation.events);
    noTargetAppend(f); oldPhysicalStateRetained(f); expect(f.acceptedQueue).toEqual([]);
    await oldStillSubmits(f, 1_000_080_000n, 3n);
  } finally { await f?.destroy(); vi.useRealTimers(); }
});

it.each(['native offset', 'assembler placement'] as const)('invalidates captured %s before held target media can adopt', async invalidation => {
  const f = await mediaSelectionMseFixture();
  try {
    const operation = await beginProgram(f, true);
    const placement = f.runningAssembler.capturePresentationPlacement('audio');
    expect(placement).not.toBeNull(); expect(f.source.getTimestampOffset?.('audio')).toBe(0);
    await f.accept('nextVideo'); await f.accept('nextAudio');
    await f.send('nextVideo', 90_080_000n, 0n, 40_000n); await f.send('nextAudio', 900_080_000n, 0n, 10_000n);
    expect(operation.state.status).toBe('pending'); noTargetAppend(f);
    if (invalidation === 'native offset') f.timestampOffsets.set('audio', 0.25);
    else {
      f.runningAssembler.setPresentationPlacement('audio', { sourceTimeUs: 1_000_000_000n, rebasedTimeUs: { numerator: 0n, denominator: 1n } });
      expect(f.runningAssembler.capturePresentationPlacement('audio')).toBeNull();
    }
    operation.release(); await flush(512); await expect(operation.selecting).rejects.toThrow();
    expect(f.player.selection).toEqual(operation.before); expect(f.selections).toHaveLength(operation.events);
    noTargetAppend(f); oldPhysicalStateRetained(f); await oldStillSubmits(f);
    if (invalidation === 'native offset') expect(f.source.getTimestampOffset?.('audio')).toBe(0.25);
    else expect(f.runningAssembler.capturePresentationPlacement('audio')?.token).not.toBe(placement?.token);
    expect(f.errors.some(error => error.severity === 'fatal')).toBe(false);
  } finally { await f.destroy(); }
});
