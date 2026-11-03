import { describe, expect, it, vi } from 'vitest';
import { MoqtConnection } from '../../packages/webtransport/src/index.js';
import { varint, type MoqtObject } from '../../packages/transport/src/index.js';
import { LocmafEncoder, LocmafGroupState, parseLocmafTrackContext, serializeLocmafObject } from '../../packages/locmaf/src/index.js';
import { buildChunk, videoInit, SYNC_FLAGS } from '../../packages/locmaf/test-support/cmaf.js';
import { observeWarmStart } from '../../examples/_tests/player-acceptance/warm-start.js';
import { observeConnectionObjects, observeLocmafDelivery, assessLocmafDelivery } from '../../examples/_tests/player-acceptance/received.js';

const catalog = { version: '1', tracks: ['video', 'audio'].map(name => ({
  name, packaging: 'locmaf', locmafVersion: '0.3', initRef: name,
})), initDataList: ['video', 'audio'].map(id => ({ id, type: 'inline', data: 'AAAA' })) };
const catalogBytes = new TextEncoder().encode(JSON.stringify(catalog));
const data = (alias: number, group: number, object: number, payload: Uint8Array): MoqtObject => ({
  kind: 'data', trackAlias: varint(alias), groupId: varint(group), subgroupId: 0n,
  objectId: varint(object), publisherPriority: 128, payload,
});

function fixture(warmEnabled = true, locmafEnabled = true) {
  const connection = new MoqtConnection(18);
  const warm = warmEnabled ? observeWarmStart() : undefined;
  const locmaf = locmafEnabled ? observeLocmafDelivery() : undefined;
  warm?.connection(connection);
  // Same single receipt tee as the acceptance page, before player registration.
  observeConnectionObjects(connection, (stream, object) => {
    const source = warm?.record(connection, stream, object);
    locmaf?.record(stream, object, source !== 'fetch');
  });
  const delivered = vi.fn();
  connection.onDataStream = vi.fn();
  connection.onObject = delivered;
  return { connection, warm, locmaf, delivered,
    fetch(stream: number, request = 8) {
      connection.onDataStream?.(BigInt(stream), { type: 'fetch', header: { requestId: BigInt(request) } });
    },
    send(stream: number, object: MoqtObject) { connection.onObject?.(BigInt(stream), object); },
  };
}

function liveMedia(send: (stream: number, object: MoqtObject) => void, aliases = [2, 3]) {
  const context = parseLocmafTrackContext(videoInit());
  for (const alias of aliases) for (const group of [1, 2]) {
    const state = new LocmafGroupState();
    for (const object of [0, 1]) {
      const chunk = buildChunk({ bmdt: (group * 2 + object) * 3000,
        samples: [{ duration: 3000, size: 4, flags: SYNC_FLAGS }], mdat: new Uint8Array(4) });
      const payload = serializeLocmafObject(new LocmafEncoder().encode(chunk, state, context, object === 0, BigInt(object)));
      send(alias * 100 + group * 10, data(alias, group, object, payload));
    }
  }
}

function prefixMedia(): MoqtObject {
  let prefix!: MoqtObject;
  liveMedia((_stream, object) => { prefix ??= object; });
  return { ...prefix, trackAlias: 0n, groupId: 0n };
}

describe('acceptance receipt observer composition', () => {
  it('keeps both witnesses when the player installs its handler afterwards', () => {
    const h = fixture(); h.send(10, prefixMedia());
    expect(h.delivered).toHaveBeenCalledOnce();
    expect(h.warm!.snapshot().received).toHaveLength(1);
    expect(h.locmaf!.snapshot().groups).toHaveLength(1);
  });

  it('does not count valid FETCH media as a third live LOCMAF alias', () => {
    const h = fixture(); h.send(1, data(1, 0, 0, catalogBytes));
    h.fetch(900); h.send(900, prefixMedia()); liveMedia(h.send);
    expect(assessLocmafDelivery(h.locmaf!.snapshot())).toEqual([]);
    expect(new Set(h.locmaf!.snapshot().groups.map(group => group.alias))).toEqual(new Set(['2', '3']));
    expect(h.warm!.snapshot().received.filter(item => item.source === 'prefix'))
      .toEqual([expect.objectContaining({ request: '8', alias: '0', group: '0', object: '0' })]);
    expect(h.delivered).toHaveBeenCalledTimes(10);
  });

  it('retains warm-only receipt observation as a control', () => {
    const h = fixture(true, false); h.send(10, prefixMedia());
    expect(h.warm!.snapshot().received).toEqual([expect.objectContaining({ source: 'live', request: null })]);
    expect(h.delivered).toHaveBeenCalledOnce();
  });

  it('keeps default non-warm LOCMAF qualification healthy', () => {
    const h = fixture(false); h.send(1, data(1, 0, 0, catalogBytes)); liveMedia(h.send);
    expect(h.warm).toBeUndefined();
    expect(assessLocmafDelivery(h.locmaf!.snapshot())).toEqual([]);
    expect(h.delivered).toHaveBeenCalledTimes(9);
  });

  it('preserves catalog JSON received only through FETCH before skipping its media', () => {
    const h = fixture(); h.fetch(900, 0); h.send(900, data(0, 0, 0, catalogBytes)); liveMedia(h.send);
    expect(h.locmaf!.snapshot().catalog?.tracks.map(track => track.name)).toEqual(['video', 'audio']);
    expect(assessLocmafDelivery(h.locmaf!.snapshot())).toEqual([]);
    expect(h.warm!.snapshot().received[0]).toMatchObject({ source: 'prefix', request: '0' });
  });

  it('uses stream headers rather than alias zero to distinguish FETCH from live media', () => {
    const h = fixture(); h.send(1, data(1, 0, 0, catalogBytes));
    h.connection.onDataStream?.(10n, { type: 'subgroup', header: {
      typeByte: 0x50, trackAlias: 0n, groupId: 1n, subgroupId: 0n,
      publisherPriority: 128, hasExtensions: false, isEndOfGroup: false,
    } });
    h.fetch(900); h.send(900, { ...prefixMedia(), trackAlias: 77n }); liveMedia(h.send, [0, 3]);
    expect(assessLocmafDelivery(h.locmaf!.snapshot())).toEqual([]);
    expect(new Set(h.locmaf!.snapshot().groups.map(group => group.alias))).toEqual(new Set(['0', '3']));
    const received = h.warm!.snapshot().received;
    expect(received.find(item => item.alias === '77')).toMatchObject({ source: 'prefix', request: '8' });
    expect(received.filter(item => item.alias === '0').every(item => item.source === 'live')).toBe(true);
  });

  it('scopes equal stream IDs to their own connections', () => {
    const warm = observeWarmStart();
    const first = new MoqtConnection(18), second = new MoqtConnection(18);
    for (const connection of [first, second]) {
      warm.connection(connection); connection.onDataStream = () => {};
    }
    first.onDataStream?.(5n, { type: 'fetch', header: { requestId: 8n } });
    expect(warm.record(first, 5n, prefixMedia())).toBe('fetch');
    expect(warm.record(second, 5n, prefixMedia())).toBe('live');
    expect(warm.snapshot().received.map(item => item.request)).toEqual(['8', null]);
  });

  it('keeps both witnesses exactly once through handler replacement and restoration', () => {
    const h = fixture(); const saved = h.connection.onObject!;
    h.send(10, prefixMedia()); const next = vi.fn(); h.connection.onObject = next;
    h.send(10, prefixMedia()); h.connection.onObject = saved; h.send(10, prefixMedia());
    expect(h.delivered).toHaveBeenCalledTimes(2); expect(next).toHaveBeenCalledOnce();
    expect(h.warm!.snapshot().received).toHaveLength(3);
    expect(h.locmaf!.snapshot().groups[0]?.full).toBe(3);
  });
});
