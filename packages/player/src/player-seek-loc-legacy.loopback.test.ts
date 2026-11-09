import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageParam, varint, encodeFetchHeader, encodeFetchObject, FetchFlags, FetchSubgroupMode,
  writeVarint, varintEncodingLength, writeLocation, locationEncodingLength } from '@openmoq/transport';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { locSeekFixture as fixture } from '../test-support/loc-seek.js';

beforeEach(() => vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
function integer(value: bigint): Uint8Array {
  const checked = varint(value), out = new Uint8Array(varintEncodingLength(checked));
  writeVarint(checked, out, 0);
  return out;
}
// The SDK owns both control directions; this peer supplies literal legacy FETCH
// DATA because the SDK publisher's FETCH stream helper supports modern drafts.
function dataPacket(draft: 14 | 16, group: bigint, object: bigint, payload: Uint8Array, extensions: Uint8Array): Uint8Array {
  if (draft === 14) {
    // draft14 10.4.4: G, SG, O, priority8, extensions length/bytes, payload length/bytes.
    return concat([integer(group), integer(0n), integer(object), Uint8Array.of(128),
      integer(BigInt(extensions.length)), extensions, integer(BigInt(payload.length)), payload]);
  }
  // draft16 10.4.4: explicit locations, priority and extension block.
  return encodeFetchObject({ flags: varint(FetchFlags.GROUP_ID | FetchFlags.OBJECT_ID | FetchFlags.PRIORITY
    | FetchFlags.EXTENSIONS | FetchSubgroupMode.EXPLICIT), groupId: group, subgroupId: 0n, objectId: object,
    publisherPriority: 128, isDatagram: false, extensions, payload });
}
async function turn(): Promise<void> {
  await flush(512);
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  await flush(512);
}
function headers(draft: 14 | 16, timestamp: bigint, independent: boolean): Uint8Array {
  const encoded = encodeLocHeaders({ timestamp, timescale: 1000n,
    videoFrameMarking: { independent, startOfFrame: true, endOfFrame: true,
      discardable: false, baseLayerSync: false, temporalId: 0 } },
    { wireProfile: locWireProfileForDraft(draft), locVersion: 4 });
  if (!encoded) throw new Error('Expected nonempty LOC test properties');
  return encoded;
}
const payload = (independent: boolean) => Uint8Array.of(0, 0, 0, 2, independent ? 0x65 : 0x41, 0x88);

describe('literal legacy FETCH envelopes with properties', () => {
  it.each([[14, '05000300008002010001aa'], [16, '05003f0300008002010001aa']] as const)('matches the draft%i envelope', (draft, literal) => {
    expect(Buffer.from(concat([encodeFetchHeader({ requestId: 0n }),
      dataPacket(draft, 3n, 0n, Uint8Array.of(0xaa), Uint8Array.of(1, 0))])).toString('hex')).toBe(literal);
  });
});

describe.each([14, 16] as const)('legacy LOC historical continuation draft%i', draft => {
  it('keeps paused legacy rendition selection unavailable without disturbing its positioned output', async () => {
    const f = await fixture(draft, false, true, { producingOutput: true, alternative: true, catalogVersion: '1',
      timeline: [[1000, [3, 0], 0], [3000, [4, 0], 0], [3100, [4, 1], 0]] });
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    try {
      await f.player.seek(2000); await flush(128);
      const id = f.fetchIds[0]!;
      await f.server.acceptFetch(id, { endOfTrack: 1, endLocation: { group: 4n, object: 1n } });
      writer = (await f.b.createUnidirectionalStream()).getWriter();
      await writer.write(encodeFetchHeader({ requestId: id }));
      for (const [group, object, timestamp] of [[3n, 0n, 1000n], [3n, 1n, 2100n], [4n, 0n, 3000n]] as const) {
        await writer.write(dataPacket(draft, group, object, payload(object === 0n), headers(draft, timestamp, object === 0n)));
      }
      await writer.close(); writer.releaseLock(); writer = undefined; await turn();
      expect(f.seeked).toHaveBeenCalledOnce(); expect(f.player.playbackPositionMs).toBe(2100);
      f.player.pause(); await turn();
      expect(f.player.availableVideoTracks.map(track => track.name)).toContain('alternate-video');
      const fetch = vi.spyOn(f.client, 'fetch'), subscribe = vi.spyOn(f.client, 'subscribe'), hook = vi.fn();
      f.player.hooks.beforeSubscribe.add(intent => { hook(intent); return intent; });
      const old = f.outputs[0]!, resets = vi.mocked(old.decoder.reset).mock.calls.length;
      const state: { error?: unknown } = {};
      const done = f.player.selectVideoTrack({ name: 'alternate-video', namespace: ['live', 'show'] })
        .catch(error => { state.error = error; });
      await turn();
      expect(state.error).toBeInstanceOf(Error);
      expect((state.error as Error).message).toMatch(/draft 18 or 22/);
      await done;
      expect(fetch).not.toHaveBeenCalled(); expect(subscribe).not.toHaveBeenCalled(); expect(hook).not.toHaveBeenCalled();
      expect(f.outputs).toHaveLength(1); expect(old.draw).toHaveBeenCalledOnce();
      expect(old.decoder.reset).toHaveBeenCalledTimes(resets); expect(old.decoder.destroy).not.toHaveBeenCalled();
      expect(f.player.state).toBe('paused'); expect(f.player.playbackPositionMs).toBe(2100); expect(f.errors).toEqual([]);
    } finally {
      if (writer) { try { await writer.close(); } catch { /* Retirement may have closed the request. */ } writer.releaseLock(); }
      await f.destroy();
    }
  });

  it.each([false, true])('positions from accepted history and continues only for a live source=%s', async isLive => {
    if (isLive) vi.useFakeTimers();
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    let destroy = async () => {};
    try {
      const f = await fixture(draft, false, true, { producingOutput: true, isLive, catalogVersion: '1',
        timeline: [[1000, [3, 0], 0], [3000, [4, 0], 0], [3100, [4, 1], 0]] });
      destroy = f.destroy;
      await f.player.seek(2000); await flush(128);
      expect(f.fetchIds).toHaveLength(1); expect(f.seeked).not.toHaveBeenCalled();
      const id = f.fetchIds[0]!;
      await f.server.acceptFetch(id, { endOfTrack: isLive ? 0 : 1, endLocation: { group: 4n, object: 1n } });
      const stream = await f.b.createUnidirectionalStream(); writer = stream.getWriter();
      await writer.write(encodeFetchHeader({ requestId: id }));
      for (const [group, object, timestamp] of [[3n, 0n, 1000n], [3n, 1n, 2100n], [4n, 0n, 3000n]] as const) {
        await writer.write(dataPacket(draft, group, object, payload(object === 0n), headers(draft, timestamp, object === 0n)));
      }
      await writer.close(); writer.releaseLock(); writer = undefined; await turn();
      expect(f.errors).toEqual([]); expect(f.seeked).toHaveBeenCalledOnce(); expect(f.outputs[0]!.draw).toHaveBeenCalledOnce();
      expect(f.player.playbackPositionMs).toBe(2100); expect(f.update).not.toHaveBeenCalled();
      const subscriptions = f.requests.filter(request => request.name === 'video');
      expect(subscriptions, 'an adopted historical graph at a live index tip needs a fresh live request').toHaveLength(isLive ? 2 : 1);
      if (!isLive) return;

      const sub = subscriptions[1]!, head = { group: 4n, object: 2n };
      const headBytes = new Uint8Array(locationEncodingLength(head)); writeLocation(head, headBytes, 0);
      await f.server.acceptSubscribe(sub.id, 202n, { parameters: new Map([[MessageParam.LARGEST_OBJECT, [headBytes]]]) });
      await turn(); expect(f.joins).toHaveLength(1);
      const join = f.joins[0]!, range = f.server.resolveJoiningFetch(join.id);
      expect(join.message.fetch).toEqual({ fetchType: 3, joiningRequestId: sub.id, joiningStart: 4n });
      await f.server.acceptFetch(join.id, { endOfTrack: 0, endLocation: range.endLocation });
      const prefix = await f.b.createUnidirectionalStream(); writer = prefix.getWriter();
      await writer.write(encodeFetchHeader({ requestId: join.id }));
      for (const [object, timestamp] of [[0n, 3000n], [1n, 3100n], [2n, 3200n]] as const) {
        await writer.write(dataPacket(draft, 4n, object, payload(object === 0n), headers(draft, timestamp, object === 0n)));
      }
      await writer.close(); writer.releaseLock(); writer = undefined; await turn();
      const live = await f.server.openSubgroup(202n, 4n, 0n, { hasExtensions: true });
      await f.server.sendObject(live, 3n, payload(false), headers(draft, 3300n, false));
      await f.server.closeSubgroup(live); await turn();
      expect(vi.mocked(f.outputs[0]!.decoder.decode).mock.calls.map(([chunk]) => chunk.timestamp))
        .toEqual([1_000_000, 2_100_000, 3_000_000, 3_100_000, 3_200_000, 3_300_000]);
      const ended = vi.fn(), recovery = vi.fn();
      f.player.on('track_ended', ended); f.player.on('recovery_action', recovery);
      await f.server.publishDone(sub.id, varint(2n), 'finite legacy live input'); await flush(256);
      await vi.advanceTimersByTimeAsync(10_001); await flush(512);
      expect(ended).not.toHaveBeenCalled();
      f.advance(2_000_000); await flush(512); f.player.tick(); await flush(256);
      expect(f.player.playbackPositionMs).toBe(3300); expect(ended).toHaveBeenCalledOnce();
      f.advance(4_000_000); await vi.advanceTimersByTimeAsync(1500); await flush(256);
      expect(ended).toHaveBeenCalledOnce(); expect(recovery).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally {
      if (writer) { try { await writer.close(); } catch { /* peer may already be closed */ } writer.releaseLock(); }
      await destroy(); vi.useRealTimers();
    }
  });
});
