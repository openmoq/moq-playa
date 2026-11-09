import { expect, it, vi } from 'vitest';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { mediaSelectionMseFixture, mseMediaRefs, mseMediaTracks } from '../test-support/media-selection-mse.js';
import { audioPeer } from '../test-support/audio-selection.js';
import type { TrackRefConfig } from './config.js';

const identity = (ref: { readonly name: string; readonly namespace: readonly string[] }) =>
  ({ name: ref.name, namespaceFields: [...ref.namespace] });
const sourceKey = (ref: { readonly name: string; readonly namespace: readonly string[] }) =>
  JSON.stringify([ref.namespace, ref.name]);

async function fixture(sameName: boolean, options: Parameters<typeof mediaSelectionMseFixture>[0] = {}) {
  const f = await mediaSelectionMseFixture(options);
  try {
    const target = { name: sameName ? mseMediaRefs.oldVideo.name : 'video-low', namespace: ['program', 'one', 'lower-picture'] };
    const catalog = JSON.parse(new TextDecoder().decode(f.catalog)) as { tracks: Array<Record<string, unknown>> };
    const old = catalog.tracks.find(track => track.name === mseMediaRefs.oldVideo.name
      && track.namespace === mseMediaRefs.oldVideo.namespace.join('/'));
    if (!old) throw new Error('No current fixture video');
    catalog.tracks.push({ ...old, name: target.name, namespace: target.namespace.join('/'), bitrate: 50_000 });
    await f.wire.send(mseMediaRefs.catalog, new TextEncoder().encode(JSON.stringify(catalog)), 2n);
    await flush(512);
    expect(f.player.selection.video).toEqual(identity(mseMediaRefs.oldVideo));
    expect(f.player.selection.videoAlternatives).toEqual([identity(mseMediaRefs.oldVideo), identity(target)]);
    return { ...f, target, ladderCatalog: new TextEncoder().encode(JSON.stringify(catalog)) };
  } catch (error) { await f.destroy(); throw error; }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function targetRequests(f: Fixture) {
  return f.wire.requests.filter(request => request.name === f.target.name
    && JSON.stringify(request.namespace) === JSON.stringify(f.target.namespace));
}
async function ready(f: Fixture, accepted = false) {
  if (!accepted) await f.wire.accept(f.target, 401n);
  await f.wire.send(f.target, f.chunk('oldVideo', 1_000_040_000n), 801n);
  await flush(512);
  expect(f.player.selection.video).toEqual(identity(f.target));
  expect(f.appendCalls.filter(append => append.media === 'video').at(-1))
    .toMatchObject({ trackName: f.target.name, sourceKey: sourceKey(f.target), presentationTimeUs: 40_000n });
  expect(f.wire.stopped).toContain(f.wire.request(mseMediaRefs.oldVideo).id);
  expect(f.errors).toEqual([]); expect(f.wire.errors).toEqual([]);
}

it('refuses an ambiguous bare video name before changing mode or issuing another request', async () => {
  const f = await fixture(true);
  try {
    f.player.setAutoQuality(true);
    const before = f.player.selection, count = f.wire.requests.length;
    await expect(f.player.selectVideoTrack(f.target.name)).rejects.toThrow(/ambiguous/i);
    expect(f.player.selection).toEqual(before); expect(f.player.selection.autoQuality).toBe(true);
    expect(f.wire.requests).toHaveLength(count); expect(f.wire.stopped).toEqual([]);
    await f.send('oldVideo', 1_000_020_000n, 1n);
    expect(f.appendCalls.at(-1)).toMatchObject({ sourceKey: sourceKey(mseMediaRefs.oldVideo), presentationTimeUs: 20_000n });
  } finally { await f.destroy(); }
});

it.each([false, true])('keeps an accepted target after the old source fails processing: same-name=%s', async sameName => {
  let rejectOld = false;
  const f = await fixture(sameName, { transform: object => {
    if (rejectOld && object.trackAlias === mseMediaTracks.oldVideo.alias) throw new Error('Old-source transform refused');
    return object;
  } });
  try {
    await f.player.selectVideoTrack(f.target); await f.wire.accept(f.target, 401n);
    const candidate = f.wire.request(f.target).id;
    rejectOld = true; await f.send('oldVideo', 1_000_020_000n, 1n); rejectOld = false;
    expect(f.wire.stopped).toContain(f.wire.request(mseMediaRefs.oldVideo).id);
    expect(f.wire.stopped).not.toContain(candidate);
    await ready(f, true);
  } finally { await f.destroy(); }
});

it('preserves unambiguous legacy string selection through actual target media adoption', async () => {
  const f = await fixture(false);
  try {
    await f.player.selectVideoTrack(f.target.name);
    expect(targetRequests(f)).toHaveLength(1);
    expect(f.player.selection.video).toEqual(identity(mseMediaRefs.oldVideo));
    await ready(f);
  } finally { await f.destroy(); }
});

it.each([false, true])('selects an exact video reference without same-name no-op or old-input adoption: same-name=%s', async sameName => {
  const f = await fixture(sameName);
  try {
    const reference: TrackRefConfig = { name: f.target.name, namespace: [...f.target.namespace] };
    const selecting = f.player.selectVideoTrack(reference);
    const outcome = await selecting.then(() => ({ ok: true, error: undefined }), error => ({ ok: false, error }));
    expect(outcome.ok, String(outcome.error)).toBe(true);
    expect(targetRequests(f)).toHaveLength(1);
    await f.wire.accept(f.target, 401n);
    const before = f.player.selection, appends = f.appendCalls.length;
    // The old owner is still authoritative until the target's actual bytes
    // arrive. A common display name must not turn this into target readiness.
    await f.send('oldVideo', 1_000_020_000n, 1n);
    expect(f.player.selection).toEqual(before);
    expect(f.player.selection.video).toEqual(identity(mseMediaRefs.oldVideo));
    expect(f.wire.stopped).not.toContain(f.wire.request(mseMediaRefs.oldVideo).id);
    expect(f.appendCalls).toHaveLength(appends + 1);
    expect(f.appendCalls.at(-1)).toMatchObject({ sourceKey: sourceKey(mseMediaRefs.oldVideo), presentationTimeUs: 20_000n });
    await ready(f, true);
  } finally { await f.destroy(); }
});

it.each([false, true])('preserves the exact lower-rung identity during automatic MSE downshift: same-name=%s', async sameName => {
  const f = await fixture(sameName), next = audioPeer(18);
  let restoreTransport: (() => void) | undefined;
  try {
    // A catalog update refreshes menus but does not rebuild an existing ABR
    // controller. A real same-identity handover installs this complete ladder
    // through the existing candidate preparation/adoption path.
    f.player.setAutoQuality(true);
    const transport = vi.spyOn(f.wire, 'start').mockImplementationOnce(() => next.start());
    restoreTransport = () => { transport.mockRestore(); };
    const migrating = f.player.migrate(next.client);
    await flush(512); await next.accept(mseMediaRefs.catalog, 100n);
    await next.send(mseMediaRefs.catalog, f.ladderCatalog, 1n);
    await next.accept(mseMediaRefs.oldVideo, 501n); await next.accept(mseMediaRefs.oldAudio, 502n);
    await migrating;
    expect(f.player.selection.video).toEqual(identity(mseMediaRefs.oldVideo));
    expect(f.player.selection.autoQuality).toBe(true);
    // This is an explicit adapter buffer-depth witness, not a native MSE or
    // presentation claim. Zero invokes the existing emergency ABR policy.
    let depthReads = 0;
    f.source.getBufferAheadUs = () => { depthReads++; return 0; };
    const setPlaybackIntent = vi.fn();
    f.source.setPlaybackIntent = setPlaybackIntent;
    f.player.play();
    expect(f.player.state).toBe('playing');
    expect(setPlaybackIntent).toHaveBeenCalledExactlyOnceWith(true);
    f.player.tick(); await flush(512);
    expect(depthReads).toBeGreaterThan(0);
    expect(next.requests.filter(request => request.name === f.target.name
      && JSON.stringify(request.namespace) === JSON.stringify(f.target.namespace))).toHaveLength(1);
    expect(f.player.selection.video).toEqual(identity(mseMediaRefs.oldVideo));
    await next.accept(f.target, 401n);
    await next.send(f.target, f.chunk('oldVideo', 1_000_040_000n), 801n);
    await flush(512);
    expect(f.player.selection.video).toEqual(identity(f.target));
    expect(f.appendCalls.filter(append => append.media === 'video').at(-1))
      .toMatchObject({ trackName: f.target.name, sourceKey: sourceKey(f.target), presentationTimeUs: 40_000n });
    expect(next.stopped).toContain(next.request(mseMediaRefs.oldVideo).id);
    expect(f.player.selection.autoQuality).toBe(true);
    expect(f.errors).toEqual([]); expect(next.errors).toEqual([]);
  } finally { restoreTransport?.(); await f.destroy(); await next.close(); }
});
