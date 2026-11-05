import { expect, it, vi } from 'vitest';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { mediaSelectionMseFixture, mseMediaRefs } from '../test-support/media-selection-mse.js';
import { audioPeer } from '../test-support/audio-selection.js';

type Fixture = Awaited<ReturnType<typeof mediaSelectionMseFixture>>;
const identity = (ref: { readonly namespace: readonly string[]; readonly name: string }) =>
  ({ namespaceFields: [...ref.namespace], name: ref.name });
const sourceKey = (ref: { readonly namespace: readonly string[]; readonly name: string }) =>
  JSON.stringify([ref.namespace, ref.name]);

async function adoptProgram(f: Fixture) {
  void f.player.mediaTimelineReference;
  await f.sendOld(1_000_040_000n, 1n);
  const reference = f.player.mediaTimelineReference;
  expect(reference).not.toBeNull();
  if (!reference) throw new Error('No accepted current reference');
  const selecting = f.player.selectMedia({ renderGroup: 2,
    videoTrack: mseMediaRefs.nextVideo, audioTrack: mseMediaRefs.nextAudio }, {
    timeline: { kind: 'reference-map', referenceToken: reference.token,
      video: { sourceTimeUs: 90_000_000n, referenceTimeUs: 1_000_000_000n },
      audio: { sourceTimeUs: 900_000_000n, referenceTimeUs: 1_000_000_000n } },
  });
  await flush(512);
  await f.accept('nextVideo'); await f.accept('nextAudio');
  await f.send('nextVideo', 90_080_000n); await f.send('nextAudio', 900_080_000n);
  await selecting;
  expect(f.player.selection.audio).toEqual(identity(mseMediaRefs.nextAudio));
  expect(f.appendCalls.filter(append => append.media === 'audio').at(-1))
    .toMatchObject({ sourceKey: sourceKey(mseMediaRefs.nextAudio), presentationTimeUs: 80_000n });
}

it.each([false, true])('keeps same-set audio placement and namespace after a prior general MSE adoption=%s', async afterGeneral => {
  const f = await mediaSelectionMseFixture();
  try {
    if (afterGeneral) await adoptProgram(f);
    const currentKey = afterGeneral ? 'nextAudio' : 'oldAudio';
    const current = mseMediaRefs[currentKey];
    const alternative = { namespace: [...current.namespace, 'alternate'], name: current.name };
    const catalog = JSON.parse(new TextDecoder().decode(f.catalog)) as { tracks: Array<Record<string, unknown>> };
    const running = catalog.tracks.find(track => track.name === current.name && track.namespace === current.namespace.join('/'));
    if (!running) throw new Error('No fixture audio catalog entry');
    // Same declared set and identical init/config; only resolved namespace and
    // language differ. The source PTS stays in that set's existing raw domain.
    catalog.tracks.push({ ...running, namespace: alternative.namespace.join('/'), lang: 'es' });
    await f.wire.send(mseMediaRefs.catalog, new TextEncoder().encode(JSON.stringify(catalog)), 2n);
    await flush(512);
    expect(f.player.selection.audioChoices).toContainEqual(identity(alternative));

    const before = f.appendCalls.length;
    const selecting = f.player.selectAudioTrack(alternative);
    await flush(512); await f.wire.accept(alternative, 401n);
    const rawUs = afterGeneral ? 900_100_000n : 1_000_100_000n;
    const bytes = f.chunk(currentKey, rawUs);
    await f.wire.send(alternative, bytes, 950n);
    await flush(512); await selecting;

    expect(f.player.selection.audio).toEqual(identity(alternative));
    expect(f.wire.request(alternative)).toMatchObject(alternative);
    expect(f.appendCalls.slice(before)).toHaveLength(1);
    expect(f.appendCalls.at(-1)).toMatchObject({ media: 'audio', trackName: current.name,
      sourceKey: sourceKey(alternative), presentationTimeUs: 100_000n });
    const videoBefore = f.appendCalls.filter(append => append.media === 'video').length;
    if (afterGeneral) await f.send('nextVideo', 90_120_000n, 1n);
    else await f.send('oldVideo', 1_000_120_000n, 1n);
    expect(f.appendCalls.filter(append => append.media === 'video')).toHaveLength(videoBefore + 1);
    expect(f.appendCalls.at(-1)?.presentationTimeUs).toBe(120_000n);
    expect(f.errors).toEqual([]); expect(f.wire.errors).toEqual([]);
  } finally { await f.destroy(); }
});

it.each([false, true])('continues keyed video after handover chooses a different namespace in the adopted view=%s', async replaceMember => {
  const f = await mediaSelectionMseFixture(), next = audioPeer(18);
  const alternative = { namespace: [...mseMediaRefs.viewVideo.namespace, 'replacement'], name: mseMediaRefs.viewVideo.name };
  let restoreTransport: (() => void) | undefined;
  let restorePush: (() => void) | undefined;
  try {
    const catalog = JSON.parse(new TextDecoder().decode(f.catalog)) as { tracks: Array<Record<string, unknown>> };
    const view = catalog.tracks.find(track => track.name === mseMediaRefs.viewVideo.name
      && track.namespace === mseMediaRefs.viewVideo.namespace.join('/'));
    if (!view) throw new Error('No fixture view catalog entry');
    catalog.tracks.push({ ...view, namespace: alternative.namespace.join('/') });
    await f.wire.send(mseMediaRefs.catalog, new TextEncoder().encode(JSON.stringify(catalog)), 2n);
    await flush(512);
    void f.player.mediaTimelineReference;
    await f.sendOld(1_000_040_000n, 1n);
    const reference = f.player.mediaTimelineReference;
    if (!reference) throw new Error('No accepted current reference');
    const viewing = f.player.selectMedia({ videoTrack: mseMediaRefs.viewVideo }, {
      timeline: { kind: 'reference-map', referenceToken: reference.token,
        video: { sourceTimeUs: 700_000_000n, referenceTimeUs: 1_000_000_000n } },
    });
    await flush(512); await f.accept('viewVideo'); await f.send('viewVideo', 700_080_000n);
    await viewing;
    expect(f.player.selection.video).toEqual(identity(mseMediaRefs.viewVideo));
    expect(f.appendCalls.filter(append => append.media === 'video').at(-1))
      .toMatchObject({ sourceKey: sourceKey(mseMediaRefs.viewVideo), presentationTimeUs: 80_000n });
    f.player.setAutoQuality(true);
    expect(f.player.selection.autoQuality).toBe(true);
    expect(f.player.selection.videoAlternatives).toContainEqual(identity(alternative));

    const target = replaceMember ? alternative : mseMediaRefs.viewVideo;
    if (replaceMember) catalog.tracks = catalog.tracks.filter(track => track !== view);
    // The fixture's application transport factory calls wire.start. Substitute
    // only its next returned transport, paired with the real replacement peer.
    const start = vi.spyOn(f.wire, 'start').mockImplementationOnce(() => next.start());
    restoreTransport = () => { start.mockRestore(); };
    const migrating = f.player.migrate(next.client);
    await flush(512);
    await next.accept(mseMediaRefs.catalog, 100n);
    await next.send(mseMediaRefs.catalog, new TextEncoder().encode(JSON.stringify(catalog)), 1n);
    await next.accept(target, 501n); await next.accept(mseMediaRefs.oldAudio, 502n);
    await migrating;
    expect(f.player.selection.video).toEqual(identity(target));
    expect(next.requests.filter(request => request.name === target.name
      && JSON.stringify(request.namespace) === JSON.stringify(target.namespace))).toHaveLength(1);
    const count = f.appendCalls.filter(append => append.media === 'video').length;
    const pushed = vi.spyOn(f.runningAssembler, 'push');
    restorePush = () => { pushed.mockRestore(); };
    await next.send(target, f.chunk('viewVideo', 700_120_000n), 1701n);
    await flush(512);
    // Observe the real call without changing its bytes, source key or outcome:
    // the adopted route reaches assembly with the full replacement identity.
    expect(pushed.mock.calls.filter(call => call[0] === 'video').map(call => [call[1], call[2], call[6]]))
      .toEqual([[target.name, 1701n, sourceKey(target)]]);
    expect(f.errors).toEqual([]); expect(next.errors).toEqual([]);
    expect(f.appendCalls.filter(append => append.media === 'video')).toHaveLength(count + 1);
    expect(f.appendCalls.filter(append => append.media === 'video').at(-1))
      .toMatchObject({ trackName: target.name, sourceKey: sourceKey(target), presentationTimeUs: 120_000n });
    expect(f.transportCalls).toHaveLength(2);
    expect(f.errors).toEqual([]); expect(next.errors).toEqual([]);
  } finally { restorePush?.(); restoreTransport?.(); await f.destroy(); await next.close(); }
});
