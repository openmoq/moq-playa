import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeFetchHeader, encodeFetchObject, FetchFlags, FetchSubgroupMode,
  varint, varintEncodingLength, writeVarint,
} from '@openmoq/transport';
import {
  deserializeLocmafObject, LocmafEncoder, LocmafFieldId, LocmafGroupState,
  parseLocmafTrackContext, serializeLocmafObject, zigzagDecode,
} from '@openmoq/locmaf';
import { buildChunk, NON_SYNC_FLAGS, SYNC_FLAGS, videoInit } from '../../locmaf/test-support/cmaf.js';
import { concat } from '../../locmaf/test-support/bytes.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { locSeekFixture as fixture } from '../test-support/loc-seek.js';

beforeEach(() => vi.stubGlobal('document', {
  hidden: false, addEventListener() {}, removeEventListener() {},
}));
afterEach(() => vi.unstubAllGlobals());

const independent = Uint8Array.of(0, 0, 0, 2, 0x65, 0x88);
const dependent = Uint8Array.of(0, 0, 0, 2, 0x41, 0x88);
const decodeTimes = [1_000_000, 2_300_000, 2_100_000, 2_500_000, 2_600_000];
const presentationTimes = [1_000_000, 2_100_000, 2_300_000, 2_500_000, 2_600_000];
const shapes = ['full and delta', 'raw Header and multiple chunks', 'Header-only before media'] as const;
type Shape = typeof shapes[number];
type Fixture = Awaited<ReturnType<typeof fixture>>;

function history(shape: Shape): Uint8Array[] {
  const first = buildChunk({ bmdt: 90_000n, samples: [
    { duration: 90_000, size: 6, flags: SYNC_FLAGS, cto: 0 },
    { duration: 18_000, size: 6, flags: NON_SYNC_FLAGS, cto: 27_000 },
    { duration: 18_000, size: 6, flags: NON_SYNC_FLAGS, cto: -9_000 },
  ], mdat: concat(independent, dependent, dependent) });
  const second = buildChunk({ bmdt: 216_000n, samples: [
    { duration: 18_000, size: 6, flags: NON_SYNC_FLAGS, cto: 9_000 },
    { duration: 18_000, size: 6, flags: NON_SYNC_FLAGS, cto: 0 },
  ], mdat: concat(dependent, dependent) });
  if (shape === 'raw Header and multiple chunks') {
    return [serializeLocmafObject({ kind: 'rawBoxes', boxes: concat(videoInit(), first, second) })];
  }

  const context = parseLocmafTrackContext(videoInit());
  const encoder = new LocmafEncoder(), state = new LocmafGroupState();
  const firstObject = shape === 'Header-only before media' ? 1n : 0n;
  const packets = [first, second].map((chunk, index) => {
    const payload = serializeLocmafObject(encoder.encode(chunk, state, context, false, firstObject + BigInt(index)));
    const object = deserializeLocmafObject(payload);
    expect(object.kind).toBe('moof');
    if (object.kind !== 'moof') throw new Error('Expected modeled LOCMAF media');
    expect(object.header.full).toBe(index === 0);
    if (index === 0) {
      const offsets = object.header.get(LocmafFieldId.TRUN_SAMPLE_COMPOSITION_TIME_OFFSETS);
      expect(offsets?.kind).toBe('list');
      if (offsets?.kind !== 'list') throw new Error('Expected signed composition offsets');
      expect(offsets.values.map(zigzagDecode)).toEqual([0n, 27_000n, -9_000n]);
    }
    return payload;
  });
  return shape === 'Header-only before media'
    ? [serializeLocmafObject({ kind: 'rawBoxes', boxes: videoInit() }), ...packets]
    : packets;
}

function integer(value: bigint): Uint8Array {
  const checked = varint(value), bytes = new Uint8Array(varintEncodingLength(checked));
  writeVarint(checked, bytes, 0);
  return bytes;
}

// Legacy FETCH data is supplied literally because the SDK publisher's stream
// helper supports modern drafts. Control requests and responses use the SDK.
function dataPacket(draft: 14 | 16, object: bigint, payload: Uint8Array): Uint8Array {
  if (draft === 14) {
    // draft14 §10.4.4: G, SG, O, priority8, extensions length, payload length/data.
    return concat(integer(3n), integer(0n), integer(object), Uint8Array.of(128),
      integer(0n), integer(BigInt(payload.length)), payload);
  }
  // draft16 §10.4.4: explicit locations and priority; no extensions are present.
  return encodeFetchObject({
    flags: varint(FetchFlags.GROUP_ID | FetchFlags.OBJECT_ID | FetchFlags.PRIORITY | FetchSubgroupMode.EXPLICIT),
    groupId: 3n, subgroupId: 0n, objectId: object, publisherPriority: 128,
    isDatagram: false, extensions: undefined, payload,
  });
}

async function sendHistoryBody(f: Fixture, draft: 14 | 16, packets: readonly Uint8Array[]): Promise<void> {
  const stream = await f.b.createUnidirectionalStream(), writer = stream.getWriter();
  try {
    await writer.write(encodeFetchHeader({ requestId: f.fetchIds[0]! }));
    for (const [index, payload] of packets.entries()) {
      await writer.write(dataPacket(draft, BigInt(index), payload));
    }
    await writer.close();
  } finally {
    writer.releaseLock();
  }
  await flush(512);
}

async function establishOldOutput(f: Fixture): Promise<void> {
  vi.mocked(f.decoder.decode).mockImplementation((chunk, time, input, context) => {
    f.decoder.onFrame?.({ timestamp: chunk.timestamp, close: vi.fn() }, time, chunk.sourceTimestamp, input, context);
  });
  const stream = await f.server.openSubgroup(200n, 9n, 0n, { publisherPriority: 128, endOfGroup: true });
  const context = parseLocmafTrackContext(videoInit());
  const chunk = buildChunk({ bmdt: 810_000n,
    samples: [{ duration: 9_000, size: 6, flags: SYNC_FLAGS }], mdat: independent });
  const payload = serializeLocmafObject(new LocmafEncoder().encode(chunk, new LocmafGroupState(), context, false, 0n));
  await f.server.sendObject(stream, 0n, payload);
  await f.server.closeSubgroup(stream);
  await flush(512);
  f.advance(1_000_000);
  await flush(128);
  expect(f.decoder.decode).toHaveBeenCalled();
  expect(f.renderer.enqueue).toHaveBeenCalled();
  expect(f.errors).toEqual([]);
}

function expectOldOutputOwned(f: Fixture): void {
  expect(f.decoder.reset).not.toHaveBeenCalled();
  expect(f.renderer.flush).not.toHaveBeenCalled();
  expect(f.seeked).not.toHaveBeenCalled();
  expect(f.outputs[0]!.draw).not.toHaveBeenCalled();
}

describe.each([14, 16] as const)('legacy LOCMAF historical sample output draft%i', draft => {
  it.each(shapes)('positions from %s only after accepted history and actual target output', async shape => {
    const firstMediaObject = shape === 'Header-only before media' ? 1 : 0;
    const f = await fixture(draft, false, true, {
      frameVideo: true, producingOutput: true, reorderVideoOutput: true,
      timeline: [[1000, [3, firstMediaObject], 0], [3000, [4, 0], 0]],
    });
    let releaseOutput = () => {};
    try {
      await establishOldOutput(f);
      await f.player.seek(2000);
      await flush(128);
      expect(f.fetches).toEqual([{ namespace: ['live', 'show'], name: 'video', group: 3n, object: 0n }]);
      expect(f.outputs).toHaveLength(1);
      const output = f.outputs[0]!, nativeFlush = output.decoder.flush.bind(output.decoder);
      const outputReady = new Promise<void>(resolve => { releaseOutput = resolve; });
      output.decoder.flush = async () => { await outputReady; await nativeFlush(); };
      const packets = history(shape);
      await sendHistoryBody(f, draft, packets);
      expectOldOutputOwned(f);
      expect(output.decoder.decode).not.toHaveBeenCalled();

      // Both legacy versions use a half-open End Location. Object zero is the
      // separate whole-group sentinel; these finite responses end after the last Object.
      await f.server.acceptFetch(f.fetchIds[0]!, {
        endOfTrack: 1, endLocation: { group: 3n, object: BigInt(packets.length) },
      });
      await flush(512);
      const decoded = vi.mocked(output.decoder.decode).mock.calls.map(([chunk]) => chunk);
      expect(decoded.map(chunk => chunk.timestamp)).toEqual(decodeTimes);
      expect(decoded.map(chunk => chunk.sourceTimestamp)).toEqual([90_000n, 207_000n, 189_000n, 225_000n, 234_000n]
        .map(ticks => ({ ticks, ticksPerSecond: 90_000n, domain: 'media' })));
      expect(decoded.map(chunk => chunk.type)).toEqual(['key', 'delta', 'delta', 'delta', 'delta']);
      expect(decoded.map(chunk => chunk.data)).toEqual([independent, dependent, dependent, dependent, dependent]);
      expect(output.frames).toEqual([]);
      expectOldOutputOwned(f);

      releaseOutput();
      await flush(512);
      f.advance(1_000_000);
      await flush(128);
      expect(output.frames.map(frame => frame.timestamp)).toEqual(presentationTimes);
      expect(output.draw).toHaveBeenCalledOnce();
      expect(output.draw.mock.calls[0]![0]).toBe(output.frames[1]);
      expect(f.seeked).toHaveBeenCalledExactlyOnceWith({
        type: 'seeked', actualTimeMs: 2100, groupId: 3, objectId: firstMediaObject,
      });
      expect(f.player.playbackPositionMs).toBe(2100);
      expect(f.fetchIds).toHaveLength(1);
      expect(f.update).not.toHaveBeenCalled();
      expect(f.errors).toEqual([]);
    } finally {
      releaseOutput();
      await f.destroy();
    }
  });

  it('keeps the established output when startup succeeded but historical input is absent', async () => {
    const f = await fixture(draft, false, true, {
      frameVideo: true, producingOutput: true, reorderVideoOutput: true,
    });
    try {
      await establishOldOutput(f);
      await f.player.seek(2000);
      await flush(256);
      expect(f.fetchIds).toHaveLength(1);
      expect(f.outputs).toHaveLength(1);
      expectOldOutputOwned(f);
      expect(f.outputs[0]!.decoder.decode).not.toHaveBeenCalled();
      expect(f.outputs[0]!.frames).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.destroy();
    }
  });
});
