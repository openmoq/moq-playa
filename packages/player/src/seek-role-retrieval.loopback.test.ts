import { describe, expect, it } from 'vitest';
import { MessageParam, type TrackPropertyValue } from '@openmoq/transport';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { fixture } from '../test-support/seek-role-retrieval.js';

describe.each([18, 22] as const)('independent seek role requests draft %i', draft => {
  it('forwards request-local track defaults to the page consumer', async () => {
    const f = await fixture(draft);
    try {
      const role = f.role('video'); await flush(128);
      await f.server.acceptFetch(f.requests[0]!.id, { endOfTrack: 1,
        endLocation: { group: 3n, object: draft === 22 ? 1n : 2n },
        trackProperties: new Map([[0x12n, [90_000n]]]),
      });
      await flush(128);
      expect(role.accepted.mock.calls[0]?.[2]?.trackProperties).toEqual(new Map([[0x12n, [90_000n]]]));
      expect(role.failures).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
  it('cancels video without cancelling the accepted audio FETCH or its later data', async () => {
    const f = await fixture(draft);
    try {
      const video = f.role('video'), audio = f.role('audio'); await flush(256);
      expect(f.requests.map(request => [request.namespace, request.name])).toEqual([
        [['a/b', 'show'], 'video'], [['a/b', 'show'], 'audio'],
      ]);
      const vs = await f.accept(0), as = await f.accept(1);
      await f.send(vs, 0n, 11); await f.send(as, 0n, 21);
      video.owner.cancel(); video.owner.cancel(); await flush(256);
      expect(f.cancelled).toHaveBeenCalledExactlyOnceWith(f.requests[0]!.id);
      await f.send(as, 1n, 22); await f.server.closeFetchStream(as); await flush(256);
      expect(video.received).toEqual([11]); expect(audio.received).toEqual([21, 22]);
      expect(video.ended).not.toHaveBeenCalled(); expect(audio.ended).toHaveBeenCalledOnce();
      expect(video.failures).not.toHaveBeenCalled(); expect(audio.failures).not.toHaveBeenCalled();
      expect(f.generic).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
      expect(f.client.session.state).toBe('established');
    } finally { await f.destroy(); }
  });

  it('starts a successor video request while the original audio request continues', async () => {
    const f = await fixture(draft);
    try {
      const previous = f.role('video'), audio = f.role('audio'); await flush(256);
      const oldStream = await f.accept(0), audioStream = await f.accept(1);
      await f.send(oldStream, 0n, 11); await f.send(audioStream, 0n, 21);
      previous.owner.cancel();
      const successor = f.role('video'); await flush(256);
      expect(f.requests.map(request => request.name)).toEqual(['video', 'audio', 'video']);
      expect(new Set(f.requests.map(request => request.id)).size).toBe(3);
      const nextStream = await f.accept(2);
      await f.send(nextStream, 0n, 31); await f.send(audioStream, 1n, 22);
      await f.server.closeFetchStream(nextStream); await f.server.closeFetchStream(audioStream); await flush(256);
      expect(previous.received).toEqual([11]); expect(successor.received).toEqual([31]); expect(audio.received).toEqual([21, 22]);
      expect(successor.ended).toHaveBeenCalledOnce(); expect(audio.ended).toHaveBeenCalledOnce();
      expect(successor.failures).not.toHaveBeenCalled(); expect(audio.failures).not.toHaveBeenCalled();
      expect(f.cancelled).toHaveBeenCalledExactlyOnceWith(f.requests[0]!.id);
      expect(f.generic).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('FEATURE CONTRACT: forwards actual accepted start and normalized response through as the optional receipt', async () => {
    const f = await fixture(draft);
    try {
      const role = f.role('video'); await flush(128); await f.accept(0); await flush(128);
      expect(role.accepted.mock.calls[0]?.[2]).toMatchObject({
        start: { groupId: 3n, objectId: 0n }, through: { kind: 'before', groupId: 3n, objectId: 2n },
        endOfTrack: true, groupOrder: 'ascending', rangeFilters: false,
      });
    } finally { await f.destroy(); }
  });

});

const liveProperties = () => new Map<bigint, TrackPropertyValue[]>([[0x12n, [90_000n]], [0x79n, [Uint8Array.of(1, 2)]]]);
const prefixProperties = () => new Map<bigint, TrackPropertyValue[]>([[0x12n, [48_000n]], [0x79n, [Uint8Array.of(3, 4)]]]);
async function liveFixture(draft: 18 | 22) {
  const f = await fixture(draft, true), role = f.role('video');
  await flush(256);
  await f.server.acceptFetch(f.requests[0]!.id, { endOfTrack: 0, endLocation: { group: 3n, object: draft === 22 ? 0n : 1n } });
  const first = await f.server.openFetchStream(f.requests[0]!.id);
  await f.send(first, 0n, 0); await f.server.closeFetchStream(first);
  await flush(256); await new Promise<void>(resolve => setTimeout(resolve, 0)); await flush(256);
  if (!f.subscriptions.length) { await f.destroy(); throw new Error('Actual live bridge SUBSCRIBE not issued'); }
  await f.server.acceptSubscribe(f.subscriptions[0]!, 77n, { trackProperties: liveProperties(),
    parameters: new Map([[MessageParam.LARGEST_OBJECT, [{ group: 3n, object: 2n }]]]) });
  await flush(256);
  let prefix: bigint;
  if (draft === 18) {
    if (!f.joins.length) { await f.destroy(); throw new Error('Actual Joining FETCH not issued'); }
    await f.server.acceptFetch(f.joins[0]!, { endLocation: f.server.resolveJoiningFetch(f.joins[0]!).endLocation,
      trackProperties: prefixProperties() });
    prefix = await f.server.openFetchStream(f.joins[0]!);
  } else prefix = await f.server.openFillStream(f.subscriptions[0]!);
  await flush(256);
  return { ...f, output: role, prefix };
}

describe.each([18, 22] as const)('role live prefix response provenance draft %i', draft => {
  it('supplies an ordered unfiltered prefix receipt and distinct own live metadata', async () => {
    const f = await liveFixture(draft);
    try {
      expect(f.output.accepted.mock.calls.at(-1)?.[2]).toEqual({
        start: { groupId: 3n, objectId: 1n }, through: { kind: 'before', groupId: 3n, objectId: 3n },
        endOfTrack: false, groupOrder: 'ascending', rangeFilters: false,
        trackProperties: draft === 18 ? prefixProperties() : liveProperties(),
      });
      await f.send(f.prefix, 1n, 1); await f.send(f.prefix, 2n, 2); await f.server.closeFetchStream(f.prefix);
      await flush(256); await new Promise<void>(resolve => setTimeout(resolve, 0)); await flush(256);
      expect(f.output.liveProperties).toEqual([liveProperties()]);
      const stream = await f.server.openSubgroup(77n, 3n, 3n, { publisherPriority: 128 });
      await f.server.sendObject(stream, 3n, Uint8Array.of(3)); await f.server.closeSubgroup(stream);
      await flush(256); await new Promise<void>(resolve => setTimeout(resolve, 0)); await flush(256);
      expect(f.output.received).toEqual([0, 1, 2, 3]); expect(f.output.failures).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('protects later live metadata from callback mutation of accepted prefix metadata', async () => {
    const f = await liveFixture(draft);
    try {
      const properties: unknown = f.output.accepted.mock.calls.at(-1)?.[2]?.trackProperties;
      expect(properties).toBeInstanceOf(Map);
      if (properties instanceof Map) {
        const values: unknown = properties.get(0x79n);
        if (Array.isArray(values) && values[0] instanceof Uint8Array) values[0].fill(99);
        properties.clear();
      }
      await f.send(f.prefix, 1n, 1); await f.send(f.prefix, 2n, 2); await f.server.closeFetchStream(f.prefix);
      await flush(256); await new Promise<void>(resolve => setTimeout(resolve, 0)); await flush(256);
      expect(f.output.liveProperties).toEqual([liveProperties()]);
      expect(f.output.failures).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('disposes a live input returned after synchronous owner cancellation during its metadata handoff', async () => {
    const f = await liveFixture(draft);
    try {
      f.output.beforeLive(() => f.output.owner.cancel());
      await f.send(f.prefix, 1n, 1); await f.send(f.prefix, 2n, 2); await f.server.closeFetchStream(f.prefix);
      await flush(256); await new Promise<void>(resolve => setTimeout(resolve, 0)); await flush(256);
      expect(f.output.liveCancelled).toHaveBeenCalledOnce();
      expect(f.output.received).toEqual([0, 1, 2]); expect(f.output.failures).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});
