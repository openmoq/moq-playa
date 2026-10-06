import { describe, expect, it, vi } from 'vitest';
import { varint, type MoqtObject } from '../../packages/transport/src/index.js';
import { LocmafEncoder, LocmafGroupState, parseLocmafTrackContext, serializeLocmafObject } from '../../packages/locmaf/src/index.js';
import { observeLocmafDelivery, assessLocmafDelivery, observeConnectionObjects } from '../../examples/_tests/player-acceptance/received.js';
import { buildChunk, videoInit, SYNC_FLAGS } from '../../packages/locmaf/test-support/cmaf.js';

const catalog = { version: '1', tracks: ['video', 'audio'].map((name) => ({ name, packaging: 'locmaf', locmafVersion: '0.3', initRef: name })),
  initDataList: ['video', 'audio'].map((id) => ({ id, type: 'inline', data: 'AAAA' })) };
const data = (alias: number, group: number, object: number, payload: Uint8Array): MoqtObject => ({
  kind: 'data', trackAlias: varint(alias), groupId: varint(group), subgroupId: varint(0), objectId: varint(object), publisherPriority: 128, payload,
});

function observed(splitStream = false, cmaf = false) {
  const observer = observeLocmafDelivery();
  observer.record(0n, data(1, 0, 0, new TextEncoder().encode(JSON.stringify(catalog))));
  const context = parseLocmafTrackContext(videoInit());
  for (const alias of [2, 3]) for (const group of [0, 1]) {
    const state = new LocmafGroupState();
    for (let object = 0; object < 2; object++) {
      const chunk = buildChunk({ bmdt: (group * 2 + object) * 3000,
        samples: [{ duration: 3000, size: 4, flags: SYNC_FLAGS }], mdat: new Uint8Array(4) });
      const payload = cmaf ? chunk : serializeLocmafObject(new LocmafEncoder().encode(chunk, state, context, object === 0, BigInt(object)));
      observer.record(BigInt(alias * 100 + group * 10 + (splitStream ? object : 0)), data(alias, group, object, payload));
    }
  }
  return observer.snapshot();
}

describe('browser-received LOCMAF qualification', () => {
  it('tees mutable callbacks exactly once when handlers are replaced, saved and restored', () => {
    const first = vi.fn();
    const second = vi.fn();
    const observer = vi.fn();
    const connection = { onObject: first as ((stream: bigint, object: MoqtObject) => void) | undefined };
    observeConnectionObjects(connection, observer);
    const saved = connection.onObject;
    const object = data(2, 0, 0, new Uint8Array(1));
    connection.onObject?.(1n, object);
    connection.onObject = second;
    connection.onObject?.(2n, object);
    connection.onObject = saved;
    connection.onObject?.(3n, object);
    connection.onObject = undefined;
    expect(connection.onObject).toBeUndefined();
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledTimes(3);
    expect(first.mock.contexts).toEqual([connection, connection]);
  });
  it('requires received modern catalog and full/delta groups from both media aliases', () => {
    expect(assessLocmafDelivery(observed())).toEqual([]);
  });
  it('rejects otherwise-decodable plain CMAF in place of LOCMAF Objects', () => {
    expect(assessLocmafDelivery(observed(false, true))).toEqual(['locmaf-full-delta-groups', 'locmaf-media-rejected']);
  });
  it('rejects full/delta Objects split across streams', () => {
    expect(assessLocmafDelivery(observed(true))).toEqual(['locmaf-subgroup-mapping']);
  });
  it('rejects missing init references and incorrect packaging/version', () => {
    for (const change of [{ initResolved: false }, { packaging: 'cmaf' }, { locmafVersion: '0.2' }]) {
      const evidence = observed();
      Object.assign(evidence.catalog!.tracks[0]!, change);
      expect(assessLocmafDelivery(evidence)).toEqual(['locmaf-catalog']);
    }
  });
  it('does not count a single group as group-transition evidence', () => {
    const evidence = observed();
    evidence.groups = evidence.groups.filter((group) => group.group === '0');
    expect(assessLocmafDelivery(evidence)).toEqual(['locmaf-full-delta-groups']);
  });
  it('bounds malformed evidence and retained groups', () => {
    const observer = observeLocmafDelivery();
    for (let i = 0; i < 100; i++) observer.record(1n, data(2, i, 0, Uint8Array.of(255)));
    expect(observer.snapshot().errors).toHaveLength(16);
    const context = parseLocmafTrackContext(videoInit());
    const chunk = buildChunk({ bmdt: 0, samples: [{ duration: 3000, size: 4, flags: SYNC_FLAGS }], mdat: new Uint8Array(4) });
    const payload = serializeLocmafObject(new LocmafEncoder().encode(chunk, new LocmafGroupState(), context, true, 0n));
    for (let group = 0; group < 100; group++) observer.record(BigInt(group), data(2, group, 0, payload));
    expect(observer.snapshot().groups).toHaveLength(32);
    expect(observer.snapshot().groups[0]!.group).toBe('68');
  });
});
