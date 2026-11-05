/** Real LOC18 wire, decode, enqueue and schedule controls; no native atomic-splice claim. */
import { describe, expect, it, vi } from 'vitest';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { mediaRefs, mediaSelectionFixture, type MediaKey } from '../test-support/media-selection.js';
import type { MediaSelectionOptions } from './index.js';

type Fixture = Awaited<ReturnType<typeof mediaSelectionFixture>>;
function watch(promise: Promise<void>) {
  const state: { status: 'pending' | 'fulfilled' | 'rejected'; error?: unknown } = { status: 'pending' };
  void promise.then(() => { state.status = 'fulfilled'; }, error => { state.status = 'rejected'; state.error = error; });
  return state;
}
const identity = (ref: { name: string; namespace: readonly string[] }) => ({ name: ref.name, namespaceFields: [...ref.namespace] });
const nextProgram = { renderGroup: 2, videoTrack: mediaRefs.nextVideo, audioTrack: mediaRefs.nextAudio } as const;
function oldIsOwned(f: Fixture) {
  expect(f.player.selection.video).toEqual(identity(mediaRefs.oldVideo));
  expect(f.player.selection.audio).toEqual(identity(mediaRefs.oldAudio));
  expect(f.wire.stopped).not.toContain(f.wire.request(mediaRefs.oldVideo).id);
  expect(f.wire.stopped).not.toContain(f.wire.request(mediaRefs.oldAudio).id);
  expect(f.transportCalls).toHaveLength(1); expect(f.wire.transport.closeInfo).toBeUndefined();
}
async function reference(f: Fixture) {
  void f.player.mediaTimelineReference;
  await f.sendOld(10_040_000n, 1n);
  const result = f.player.mediaTimelineReference;
  if (!result) throw new Error('Accepted old audio did not publish the canonical media reference');
  expect(result.track).toEqual(identity(mediaRefs.oldAudio));
  expect(result.observedSourceTimeUs).toBe(10_040_000n);
  return result;
}
function maps(referenceToken: object): MediaSelectionOptions {
  return { timeline: { kind: 'reference-map', referenceToken,
    video: { sourceTimeUs: 90_000_000n, referenceTimeUs: 10_000_000n },
    audio: { sourceTimeUs: 900_000_000n, referenceTimeUs: 10_000_000n } } };
}
async function oldStillRuns(f: Fixture) {
  const video = f.enqueuedVideo.length, audio = f.scheduledAudio.length;
  await f.sendOld(10_060_000n, 2n);
  expect(f.enqueuedVideo).toHaveLength(video + 1); expect(f.scheduledAudio).toHaveLength(audio + 1);
  expect(f.enqueuedVideo.at(-1)).toMatchObject({ key: 'oldVideo', rawTimestampUs: 10_060_000 });
  expect(f.scheduledAudio.at(-1)).toMatchObject({ key: 'oldAudio', rawTimestampUs: 10_060_000 });
  oldIsOwned(f);
}

async function stagePair(f: Fixture, hold?: MediaKey, signal?: AbortSignal) {
  const current = await reference(f);
  const before = f.player.selection, eventsBefore = f.selections.length;
  const release = hold ? f.hold(hold) : () => {};
  const selecting = f.player.selectMedia(nextProgram, { ...maps(current.token), ...(signal ? { signal } : {}) });
  const state = watch(selecting);
  await flush(512); await f.accept('nextVideo'); await f.accept('nextAudio');
  await f.send('nextVideo', 90_080_000n); await f.send('nextAudio', 900_080_000n);
  f.tick(0); await flush(512);
  return { selecting, state, release, before, eventsBefore };
}

function noTargetOutput(f: Fixture) {
  for (const points of [f.decodedVideo, f.decodedAudio, f.enqueuedVideo, f.scheduledAudio]) {
    expect(points.filter(point => point.key === 'nextVideo' || point.key === 'nextAudio')).toEqual([]);
  }
}

function targetRequestsReleased(f: Fixture) {
  for (const ref of [mediaRefs.nextVideo, mediaRefs.nextAudio]) {
    const id = f.wire.request(ref).id;
    expect(f.wire.stopped.filter(stopped => stopped === id)).toHaveLength(1);
  }
}

describe('LOC18 media selection', () => {
  it('decodes and enqueues old video and schedules old audio using exact namespace tokens', async () => {
    const f = await mediaSelectionFixture();
    try {
      expect(f.wire.requests.map(({ name, namespace }) => ({ name, namespace }))).toEqual([
        mediaRefs.catalog, mediaRefs.oldVideo, mediaRefs.oldAudio,
      ]);
      oldIsOwned(f);
      expect(f.enqueuedVideo).toEqual([expect.objectContaining({ key: 'oldVideo', rawTimestampUs: 10_000_000 })]);
      expect(f.scheduledAudio).toEqual([expect.objectContaining({ key: 'oldAudio', rawTimestampUs: 10_000_000 })]);
      expect(f.errors).toEqual([]); expect(f.wire.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('keeps old enqueue and schedule callbacks active when target video is ready but target audio processing is held', async () => {
    const f = await mediaSelectionFixture();
    try {
      const current = await reference(f), before = f.player.selection;
      f.hold('nextAudio');
      const selecting = f.player.selectMedia(nextProgram, maps(current.token)), state = watch(selecting);
      await flush(512); await f.accept('nextVideo'); await f.accept('nextAudio');
      await f.send('nextVideo', 90_080_000n); await f.send('nextAudio', 900_080_000n);
      f.tick(0); await flush(512);
      expect(state.status, String(state.error)).toBe('pending');
      expect(f.player.selection).toEqual(before); oldIsOwned(f);
      expect(f.decodedVideo.filter(point => point.key === 'nextVideo')).toEqual([]);
      expect(f.decodedAudio.filter(point => point.key === 'nextAudio')).toEqual([]);
      await oldStillRuns(f);
      expect(state.status).toBe('pending');
      expect(f.enqueuedVideo.some(point => point.key === 'nextVideo')).toBe(false);
      expect(f.scheduledAudio.some(point => point.key === 'nextAudio')).toBe(false);
    } finally { await f.destroy(); }
  });

  it('adopts a jointly mapped pair once while preserving raw timestamps and enqueue/schedule times', async () => {
    const f = await mediaSelectionFixture();
    try {
      const current = await reference(f), before = f.player.selection, eventsBefore = f.selections.length;
      const release = f.hold('nextAudio');
      const selecting = f.player.selectMedia(nextProgram, maps(current.token)), state = watch(selecting);
      await flush(512); await f.accept('nextVideo'); await f.accept('nextAudio');
      expect(f.wire.request(mediaRefs.nextVideo)).toMatchObject(mediaRefs.nextVideo);
      expect(f.wire.request(mediaRefs.nextAudio)).toMatchObject(mediaRefs.nextAudio);
      await f.send('nextVideo', 90_080_000n); await f.send('nextAudio', 900_080_000n);
      await oldStillRuns(f);
      const oldVideo = f.enqueuedVideo.at(-1)!, oldAudio = f.scheduledAudio.at(-1)!;
      expect(state.status, String(state.error)).toBe('pending');
      release(); await flush(512); f.tick(0); await flush(512);
      expect(state.status, String(state.error)).toBe('fulfilled'); await selecting;
      expect(f.player.selection.video).toEqual(identity(mediaRefs.nextVideo));
      expect(f.player.selection.audio).toEqual(identity(mediaRefs.nextAudio));
      expect(f.player.selection.revision).toBe(before.revision + 1);
      expect(f.selections.slice(eventsBefore)).toEqual([f.player.selection]);
      expect(f.decodedVideo.at(-1)).toMatchObject({ key: 'nextVideo', rawTimestampUs: 90_080_000 });
      expect(f.decodedAudio.at(-1)).toMatchObject({ key: 'nextAudio', rawTimestampUs: 900_080_000 });
      expect(f.enqueuedVideo.at(-1)).toEqual({ key: 'nextVideo', rawTimestampUs: 90_080_000,
        renderTimeUs: oldVideo.renderTimeUs + 20_000 });
      expect(f.scheduledAudio.at(-1)).toEqual({ key: 'nextAudio', rawTimestampUs: 900_080_000,
        renderTimeUs: oldAudio.renderTimeUs + 20_000 });
      expect(f.wire.stopped).toContain(f.wire.request(mediaRefs.oldVideo).id);
      expect(f.wire.stopped).toContain(f.wire.request(mediaRefs.oldAudio).id);
      expect(f.wire.stopped).not.toContain(f.wire.request(mediaRefs.nextVideo).id);
      expect(f.wire.stopped).not.toContain(f.wire.request(mediaRefs.nextAudio).id);
      expect(f.transportCalls).toHaveLength(1); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('preserves old video enqueue and audio scheduling when target audio refuses after target video becomes usable', async () => {
    const f = await mediaSelectionFixture();
    try {
      const current = await reference(f), before = f.player.selection, eventsBefore = f.selections.length;
      const selecting = f.player.selectMedia(nextProgram, maps(current.token)), state = watch(selecting);
      await flush(512); await f.accept('nextVideo'); await f.send('nextVideo', 90_080_000n);
      await f.wire.reject(mediaRefs.nextAudio); await flush(512);
      expect(state.status).toBe('rejected'); await expect(selecting).rejects.toThrow();
      expect(f.player.selection).toEqual(before); expect(f.selections).toHaveLength(eventsBefore);
      expect(f.wire.stopped).toContain(f.wire.request(mediaRefs.nextVideo).id);
      expect(f.enqueuedVideo.some(point => point.key === 'nextVideo')).toBe(false);
      expect(f.scheduledAudio.some(point => point.key === 'nextAudio')).toBe(false);
      await oldStillRuns(f);
      expect(f.errors.some(error => error.severity === 'fatal')).toBe(false);
    } finally { await f.destroy(); }
  });

  it('changes only the view while keeping the existing audio owner and request', async () => {
    const f = await mediaSelectionFixture();
    try {
      const current = await reference(f), eventsBefore = f.selections.length;
      const selecting = f.player.selectMedia({ renderGroup: 1, videoTrack: mediaRefs.viewVideo, audioTrack: mediaRefs.oldAudio },
        { timeline: { kind: 'reference-map', referenceToken: current.token,
          video: { sourceTimeUs: 700_000_000n, referenceTimeUs: 10_000_000n } } });
      const state = watch(selecting); await flush(512); await f.accept('viewVideo');
      await f.send('oldAudio', 10_060_000n, 2n); await f.send('viewVideo', 700_060_000n); f.tick(); await flush(512);
      expect(state.status, String(state.error)).toBe('fulfilled'); await selecting;
      expect(f.player.selection.video).toEqual(identity(mediaRefs.viewVideo));
      expect(f.player.selection.audio).toEqual(identity(mediaRefs.oldAudio));
      expect(f.wire.requests.filter(request => request.name === mediaRefs.oldAudio.name
        && JSON.stringify(request.namespace) === JSON.stringify(mediaRefs.oldAudio.namespace))).toHaveLength(1);
      expect(f.wire.requests).toHaveLength(4);
      expect(f.wire.stopped).not.toContain(f.wire.request(mediaRefs.oldAudio).id);
      expect(f.scheduledAudio.at(-1)).toMatchObject({ key: 'oldAudio', rawTimestampUs: 10_060_000 });
      expect(f.enqueuedVideo.at(-1)).toMatchObject({ key: 'viewVideo', rawTimestampUs: 700_060_000 });
      expect(f.selections.slice(eventsBefore)).toEqual([f.player.selection]);
      expect(f.transportCalls).toHaveLength(1); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('refuses an already-cancelled operation before target requests or decoder work', async () => {
    const f = await mediaSelectionFixture();
    try {
      const current = await reference(f), before = f.player.selection;
      const decoderBefore = f.decoderEvents.slice(), requestsBefore = f.wire.requests.slice();
      const controller = new AbortController(); controller.abort();
      await expect(f.player.selectMedia(nextProgram, { ...maps(current.token), signal: controller.signal })).rejects.toThrow(/cancel/i);
      expect(f.player.selection).toEqual(before);
      expect(f.wire.requests).toEqual(requestsBefore); expect(f.decoderEvents).toEqual(decoderBefore);
      await oldStillRuns(f);
      await expect(f.player.selectMedia({ renderGroup: 1 })).resolves.toBeUndefined();
    } finally { await f.destroy(); }
  });

  it.each(['nextVideo', 'nextAudio'] as const)('cancels held %s processing without waiting or admitting its late result', async held => {
    const f = await mediaSelectionFixture(), controller = new AbortController();
    const timers = vi.spyOn(globalThis, 'setTimeout'), clears = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const decoderBefore = f.decoderEvents.slice();
      const pending = await stagePair(f, held, controller.signal);
      expect(pending.state.status, String(pending.state.error)).toBe('pending'); oldIsOwned(f);
      controller.abort(); await flush(512);
      expect(pending.state.status).toBe('rejected'); await expect(pending.selecting).rejects.toThrow(/cancel/i);
      expect(f.player.selection).toEqual(pending.before); expect(f.selections).toHaveLength(pending.eventsBefore);
      targetRequestsReleased(f); expect(f.decoderEvents).toEqual(decoderBefore); noTargetOutput(f);
      const pendingTimers = timers.mock.calls.flatMap((args, index) => args[1] === 1000 ? [timers.mock.results[index]!.value] : []);
      // Selection and individual SUBSCRIBEs own separate timers with this budget.
      expect(pendingTimers.length).toBeGreaterThan(0);
      for (const timer of pendingTimers) expect(clears.mock.calls.some(([cleared]) => cleared === timer)).toBe(true);
      // The operation slot must be free even though the receiver transform has not settled.
      await expect(f.player.selectMedia({ renderGroup: 1 })).resolves.toBeUndefined();
      await oldStillRuns(f);
      pending.release(); await flush(512); f.tick(0); await flush(512);
      noTargetOutput(f); expect(f.player.selection).toEqual(pending.before);
      expect(f.selections).toHaveLength(pending.eventsBefore); expect(f.decoderEvents).toEqual(decoderBefore);
    } finally { timers.mockRestore(); clears.mockRestore(); await f.destroy(); }
  });

  it('destroy settles held preparation and fences late transform callbacks', async () => {
    const f = await mediaSelectionFixture();
    try {
      const pending = await stagePair(f, 'nextAudio');
      expect(pending.state.status).toBe('pending');
      await f.player.destroy(); await flush(512);
      expect(pending.state.status).toBe('rejected'); await expect(pending.selecting).rejects.toThrow(/destroy/i);
      // Session close owns wire cleanup; it need not deliver separate UNSUBSCRIBEs to the peer.
      noTargetOutput(f);
      const callbacksAfterDestroy = f.decoderEvents.slice(), eventsAfterDestroy = f.selections.slice();
      const videoAfterDestroy = f.enqueuedVideo.slice(), audioAfterDestroy = f.scheduledAudio.slice();
      pending.release(); await flush(512); f.tick(0); await flush(512);
      expect(f.decoderEvents).toEqual(callbacksAfterDestroy); expect(f.selections).toEqual(eventsAfterDestroy);
      expect(f.enqueuedVideo).toEqual(videoAfterDestroy); expect(f.scheduledAudio).toEqual(audioAfterDestroy);
      noTargetOutput(f); expect(f.wire.transport.closeInfo).toBeDefined();
    } finally { await f.destroy(); }
  });

  // Local migration policy cancels preparation first; GOAWAY itself permits started requests to drain.
  it('GOAWAY cancels held preparation before replacing the session and cannot adopt its late data', async () => {
    const f = await mediaSelectionFixture();
    try {
      const pending = await stagePair(f, 'nextAudio');
      expect(pending.state.status).toBe('pending');
      await f.wire.goaway('https://media-selection.invalid/replacement'); await flush(512);
      expect(pending.state.status).toBe('rejected'); await expect(pending.selecting).rejects.toThrow(/GOAWAY/i);
      targetRequestsReleased(f); noTargetOutput(f);
      const next = f.peers[1]!;
      await next.accept(mediaRefs.catalog, 500n); await next.send(mediaRefs.catalog, f.catalog, 1n);
      expect(next.requests.map(({ namespace, name }) => ({ namespace, name }))).toEqual([
        mediaRefs.catalog, mediaRefs.oldVideo, mediaRefs.oldAudio,
      ]);
      await next.accept(mediaRefs.oldVideo, 600n); await next.accept(mediaRefs.oldAudio, 601n);
      await f.send('oldVideo', 10_060_000n, 2n, next); await f.send('oldAudio', 10_060_000n, 2n, next);
      f.tick(); await flush(512);
      expect(f.player.selection.video).toEqual(identity(mediaRefs.oldVideo));
      expect(f.player.selection.audio).toEqual(identity(mediaRefs.oldAudio));
      expect(f.enqueuedVideo.at(-1)).toMatchObject({ key: 'oldVideo', rawTimestampUs: 10_060_000 });
      expect(f.scheduledAudio.at(-1)).toMatchObject({ key: 'oldAudio', rawTimestampUs: 10_060_000 });
      const events = f.selections.slice();
      pending.release(); await flush(512); f.tick(0); await flush(512);
      noTargetOutput(f); expect(f.selections).toEqual(events);
      expect(f.transportCalls).toEqual(['https://media-selection.invalid/live', 'https://media-selection.invalid/replacement']);
      expect(next.errors).toEqual([]); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('refuses mapped video without the output timing capability before target requests or physical decoder work', async () => {
    const f = await mediaSelectionFixture(18, { unsupportedOutputTiming: true });
    try {
      const current = await reference(f), before = f.player.selection;
      const callbacks = f.decoderEvents.slice(), requests = f.wire.requests.slice();
      await expect(f.player.selectMedia(nextProgram, maps(current.token))).rejects.toThrow(/producing output timing/i);
      expect(f.player.selection).toEqual(before); expect(f.wire.requests).toEqual(requests);
      expect(f.decoderEvents).toEqual(callbacks); noTargetOutput(f);
      await oldStillRuns(f); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('refuses changed target video initialization before resetting either old decoder', async () => {
    const f = await mediaSelectionFixture(18, { changedTargetVideoInit: true });
    try {
      const callbacks = f.decoderEvents.slice(), pending = await stagePair(f);
      expect(pending.state.status, String(pending.state.error)).toBe('rejected');
      await expect(pending.selecting).rejects.toThrow(/configuration.*safely/i);
      expect(f.player.selection).toEqual(pending.before); expect(f.selections).toHaveLength(pending.eventsBefore);
      expect(f.decoderEvents).toEqual(callbacks); targetRequestsReleased(f); noTargetOutput(f);
      await oldStillRuns(f); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('refuses changed target audio configuration before resetting either old decoder', async () => {
    const config = Uint8Array.of(79, 112, 117, 115, 72, 101, 97, 100, 1, 2, 0, 0, 0x80, 0xbb, 0, 0, 0, 0, 0);
    const f = await mediaSelectionFixture(18, { targetAudioConfig: config, refuseTargetAudioConfig: true });
    try {
      const callbacks = f.decoderEvents.slice(), pending = await stagePair(f);
      expect(pending.state.status, String(pending.state.error)).toBe('rejected');
      await expect(pending.selecting).rejects.toThrow(/configur/i);
      expect(f.player.selection).toEqual(pending.before); expect(f.selections).toHaveLength(pending.eventsBefore);
      expect.soft(f.decoderEvents).toEqual(callbacks); noTargetOutput(f);
      expect.soft(f.errors.some(error => error.severity === 'fatal')).toBe(false);
      const video = f.enqueuedVideo.length, audio = f.scheduledAudio.length;
      await expect(f.sendOld(10_060_000n, 2n)).resolves.toBeUndefined();
      expect(f.enqueuedVideo).toHaveLength(video + 1); expect(f.scheduledAudio).toHaveLength(audio + 1);
      oldIsOwned(f); targetRequestsReleased(f);
    } finally { await f.destroy(); }
  });

  it.each([false, true])('replacement preserves the adopted program scope and automatic video policy: %s', async automaticVideo => {
    const f = await mediaSelectionFixture(18, { automaticVideo });
    try {
      const current = await reference(f);
      expect(f.player.selection.autoQuality).toBe(automaticVideo);
      const selecting = f.player.selectMedia(automaticVideo ? { renderGroup: 2 } : nextProgram, maps(current.token));
      const adopted = watch(selecting);
      await flush(512); await f.accept('nextVideo'); await f.accept('nextAudio');
      await f.send('nextVideo', 90_080_000n); await f.send('nextAudio', 900_080_000n); f.tick(0); await flush(512);
      expect(adopted.status, String(adopted.error)).toBe('fulfilled'); await selecting;
      expect(f.player.selection.scope).toEqual({ kind: 'render-group', renderGroup: 2 });
      expect(f.player.selection.autoQuality).toBe(automaticVideo);
      expect(f.enqueuedVideo.at(-1)).toMatchObject({ key: 'nextVideo' });
      expect(f.scheduledAudio.at(-1)).toMatchObject({ key: 'nextAudio' });
      const next = f.peers[1]!;
      const migrating = f.player.migrate(next.client), state = watch(migrating);
      await flush(512); await next.accept(mediaRefs.catalog, 500n); await next.send(mediaRefs.catalog, f.catalog, 1n);
      expect(state.status, String(state.error)).toBe('pending');
      expect(next.requests.map(({ namespace, name }) => ({ namespace, name }))).toEqual([
        mediaRefs.catalog, mediaRefs.nextVideo, mediaRefs.nextAudio,
      ]);
      await next.accept(mediaRefs.nextVideo, 600n); await next.accept(mediaRefs.nextAudio, 601n);
      await f.send('nextVideo', 90_100_000n, 1n, next); await f.send('nextAudio', 900_100_000n, 1n, next);
      f.tick(); await flush(512);
      expect(state.status, String(state.error)).toBe('fulfilled'); await migrating;
      expect(f.player.selection.video).toEqual(identity(mediaRefs.nextVideo));
      expect(f.player.selection.audio).toEqual(identity(mediaRefs.nextAudio));
      expect(f.player.selection.autoQuality).toBe(automaticVideo);
      expect(f.enqueuedVideo.at(-1)).toMatchObject({ key: 'nextVideo', rawTimestampUs: 90_100_000 });
      expect(f.scheduledAudio.at(-1)).toMatchObject({ key: 'nextAudio', rawTimestampUs: 900_100_000 });
      expect(f.transportCalls).toHaveLength(2); expect(next.errors).toEqual([]); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});
