import { expect, it, vi } from 'vitest';
import { mediaSelectionMseFixture, mseMediaRefs, mseMediaTracks } from '../test-support/media-selection-mse.js';
import { LocmafEncoder, LocmafGroupState, LocmafTrackDecoder, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { SubscriptionManager } from './subscription-manager.js';
import { boxSize } from '../../browser/src/mp4-box.js';
import { buildChunk, NON_SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';

const cases = [false, true].flatMap(prefix => [false, true].map(split => ({ prefix, split })));
for (const packaging of ['cmaf', 'locmaf'] as const) it.each(cases)(`prepares ${packaging} after joining an open group: prefix=$prefix split=$split`, async ({ prefix, split }) => {
  const f = await mediaSelectionMseFixture({ packaging });
  try {
    void f.player.mediaTimelineReference; await f.sendOld(1_000_040_000n, 1n);
    const reference = f.player.mediaTimelineReference!;
    const selecting = f.player.selectMedia({ renderGroup: 2, videoTrack: mseMediaRefs.nextVideo, audioTrack: mseMediaRefs.nextAudio }, {
      timeline: { kind: 'reference-map', referenceToken: reference.token,
        video: { sourceTimeUs: 90_000_000n, referenceTimeUs: 1_000_000_000n },
        audio: { sourceTimeUs: 900_000_000n, referenceTimeUs: 1_000_000_000n } },
    });
    const state: { result: string; error?: unknown } = { result: 'pending' };
    void selecting.then(() => { state.result = 'fulfilled'; }, error => { state.result = 'rejected'; state.error = error; });
    await flush(512); await f.accept('nextVideo'); await f.accept('nextAudio');
    // Object 0's group-start SAP predates this LargestObject join. A later
    // object in the same group may independently contain another SAP.
    if (prefix) await f.sendBytes('nextVideo', buildChunk({ trackId: 11, bmdt: 8_103_600n,
      samples: [{ duration: 1800, size: 4, flags: NON_SYNC_FLAGS }], mdat: Uint8Array.of(31, 1, 3, 4) }), 90_040_000n, 1n);
    if (split) {
      const bytes = f.chunk('nextVideo', 90_080_000n, 2n), size = boxSize(bytes, 0);
      await f.sendBytes('nextVideo', bytes.subarray(0, size), 90_080_000n, 2n);
      await f.sendBytes('nextVideo', bytes.subarray(size), 90_080_000n, 3n);
    } else await f.send('nextVideo', 90_080_000n, 2n);
    await f.send('nextAudio', 900_080_000n); await flush(512);
    expect(state.result, String(state.error)).toBe('fulfilled'); await selecting;
    expect(f.sourceAppends.filter(a => a.marker === 31).map(a => a.presentationTimeUs)).toEqual([80000n]);
    expect(f.player.selection.video).toEqual({ name: mseMediaRefs.nextVideo.name, namespaceFields: mseMediaRefs.nextVideo.namespace });
    // Group-start Object 0 can arrive on another subgroup after adoption. It
    // is valid publisher media, but precedes the receiver's chosen access point.
    const before = f.sourceAppends.length, raw = f.chunk('nextVideo', 90_000_000n);
    const bytes = packaging === 'locmaf' ? serializeLocmafObject({ kind: 'rawBoxes', boxes: raw }) : raw;
    const stream = await f.wire.server.openSubgroup(mseMediaTracks.nextVideo.alias, mseMediaTracks.nextVideo.group, 1n,
      { publisherPriority: 128 });
    await f.wire.server.sendObject(stream, 0n, bytes); await f.wire.server.closeSubgroup(stream); await flush(512);
    expect(f.sourceAppends).toHaveLength(before);
    expect(f.errors).toEqual([]);
  } finally { await f.destroy(); }
});

it.each([false, true])('adopts LOCMAF SAP with forceFull=%s after a dependent full prefix, preserving later deltas past late earlier data', async forceFull => {
  const f = await mediaSelectionMseFixture({ packaging: 'locmaf', timeoutMs: 1000 });
  const floors = vi.spyOn(SubscriptionManager.prototype, 'setMinimumMediaLocation');
  try {
    void f.player.mediaTimelineReference; await f.sendOld(1_000_040_000n, 1n);
    const reference = f.player.mediaTimelineReference!;
    const selecting = f.player.selectMedia({ renderGroup: 2, videoTrack: mseMediaRefs.nextVideo, audioTrack: mseMediaRefs.nextAudio }, {
      timeline: { kind: 'reference-map', referenceToken: reference.token,
        video: { sourceTimeUs: 90_000_000n, referenceTimeUs: 1_000_000_000n },
        audio: { sourceTimeUs: 900_000_000n, referenceTimeUs: 1_000_000_000n } },
    });
    const state: { result: string; error?: unknown } = { result: 'pending' };
    void selecting.then(() => { state.result = 'fulfilled'; }, error => { state.result = 'rejected'; state.error = error; });
    await flush(512); await f.accept('nextVideo'); await f.accept('nextAudio');
    const encoder = new LocmafEncoder(), groupState = new LocmafGroupState(), context = parseLocmafTrackContext(f.headers.video);
    const prefix = buildChunk({ trackId: 11, bmdt: 8_105_400n,
      samples: [{ duration: 1800, size: 4, flags: NON_SYNC_FLAGS }], mdat: Uint8Array.of(31, 1, 3, 4) });
    const full = encoder.encode(prefix, groupState, context, true, 1n);
    const sap = encoder.encode(f.chunk('nextVideo', 90_080_000n, 2n), groupState, context, forceFull, 2n);
    const next = encoder.encode(f.chunk('nextVideo', 90_100_000n, 3n), groupState, context, false, 3n);
    expect(full.kind).toBe('moof'); expect(sap.kind).toBe('moof'); expect(next.kind).toBe('moof');
    if (sap.kind !== 'moof' || next.kind !== 'moof') throw new Error('Not a compressed fixture');
    expect(sap.header.full).toBe(forceFull); expect(next.header.full).toBe(false);
    const verify = new LocmafTrackDecoder(f.headers.video);
    expect(verify.push(mseMediaTracks.nextVideo.group, 1n, serializeLocmafObject(full)).kind).toBe('chunk');
    const sapRead = verify.push(mseMediaTracks.nextVideo.group, 2n, serializeLocmafObject(sap));
    expect(sapRead.kind).toBe('chunk');
    if (sapRead.kind !== 'chunk') throw new Error('Invalid SAP fixture');
    expect(sapRead.startsWithSync).toBe(true);
    expect(verify.push(mseMediaTracks.nextVideo.group, 3n, serializeLocmafObject(next)).kind).toBe('chunk');
    const send = async (bytes: Uint8Array, id: bigint) => {
      await f.wire.send(mseMediaRefs.nextVideo, bytes, mseMediaTracks.nextVideo.group, id); await flush(512);
    };
    await send(serializeLocmafObject(full), 1n);
    await send(serializeLocmafObject(sap), 2n);
    expect(state.result, String(state.error)).toBe('pending');
    await f.send('nextAudio', 900_080_000n); await flush(512);
    expect(state.result, String(state.error)).toBe('fulfilled'); await selecting;
    expect(floors.mock.calls).toContainEqual([mseMediaTracks.nextVideo.alias, { groupId: mseMediaTracks.nextVideo.group, objectId: 2n }]);
    expect(f.sourceAppends.filter(a => a.marker === 31).map(a => a.presentationTimeUs)).toEqual([80000n]);
    const stream = await f.wire.server.openSubgroup(mseMediaTracks.nextVideo.alias, mseMediaTracks.nextVideo.group, 1n, { publisherPriority: 128 });
    await f.wire.server.sendObject(stream, 0n, serializeLocmafObject({ kind: 'rawBoxes', boxes: f.chunk('nextVideo', 90_000_000n) }));
    await f.wire.server.closeSubgroup(stream); await flush(512);
    await send(serializeLocmafObject(next), 3n);
    expect(f.sourceAppends.filter(a => a.marker === 31).map(a => a.presentationTimeUs)).toEqual([80000n,100000n]);
    expect(f.errors).toEqual([]);
  } finally { floors.mockRestore(); await f.destroy(); }
});
