import { expect, it } from 'vitest';
import { SeekCmafInput, SEEK_INTERVAL_BYTES } from './seek-cmaf-input.js';
import { buildInit, buildChunk, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { varint, type MoqtObject } from '@openmoq/transport';

const count = 100;
const bytes = buildChunk({ trackId: 1, bmdt: 0n,
  samples: Array.from({ length: count }, () => ({ duration: 1, size: 4, flags: SYNC_FLAGS, cto: 0 })),
  mdat: new Uint8Array(count * 4) });
const proofBytes = count * SEEK_INTERVAL_BYTES;
function object(id: bigint, payload = bytes): MoqtObject {
  return { kind: 'data', payload, trackAlias: varint(0), subgroupId: varint(0),
    groupId: varint(3), objectId: varint(id), publisherPriority: 128 };
}
function prepare(maxBytes: number, retainIntervals: boolean, indexedObject = 8n) {
  return new SeekCmafInput({ init: buildInit({ trackId: 1, timescale: 1000, handler: 'vide' }),
    packaging: 'cmaf', role: 'video', location: { groupId: 3n, objectId: indexedObject },
    mediaPts: 0, timestampRounding: 'floor', maxObjects: 4, maxBytes, retainTiming: true, retainIntervals });
}

for (const split of [false, true]) {
  it.each([false, true])(`charges cumulative sample proofs; split=${split}, retainIntervals=%s`, retainIntervals => {
    const input = prepare(2 * bytes.length + proofBytes, retainIntervals);
    expect(input.push(object(0n))).toEqual([]);
    let finish: () => ReturnType<SeekCmafInput['push']>;
    if (split) {
      const boundary = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
      expect(boundary).toBeLessThan(bytes.length);
      expect(input.push(object(1n, bytes.subarray(0, boundary)))).toEqual([]);
      finish = () => input.push(object(2n, bytes.subarray(boundary)));
    } else finish = () => input.push(object(1n));
    if (retainIntervals) {
      expect(finish, 'prior retained proof must consume the shared byte budget').toThrow(/budget/);
      expect(input.retainedObjectCount).toBe(0);
    } else expect(finish()).toEqual([]);
    input.cancel();
    expect(input.retainedObjectCount).toBe(0);
  });
}

it('releases proof charges when prepared chunks transfer to the caller', () => {
  const input = prepare(2 * (bytes.length + proofBytes), true, 1n);
  expect(input.push(object(0n))).toEqual([]);
  const transferred = input.push(object(1n));
  expect(transferred).toHaveLength(2);
  expect(transferred.every(chunk => chunk.timing?.intervals?.length === count)).toBe(true);
  expect(input.retainedObjectCount).toBe(0);
  expect(input.push(object(2n))).toHaveLength(1);
  input.cancel();
});

it.each([0, 1, -1, -SEEK_INTERVAL_BYTES])('charges the indexed chunk before readiness at budget delta %s', delta => {
  const input = prepare(2 * (bytes.length + proofBytes) + delta, true, 1n);
  expect(input.push(object(0n))).toEqual([]);
  if (delta < 0) {
    expect(() => input.push(object(1n))).toThrow(/budget/);
    expect(input.ready).toBe(false);
    expect(input.retainedObjectCount).toBe(0);
  } else {
    expect(input.push(object(1n))).toHaveLength(2);
    expect(input.ready).toBe(true);
  }
  input.cancel();
});
