import { describe, expect, it, vi } from 'vitest';
import { MessageParam, type MoqtObject } from '@openmoq/transport';
import type { ObjectReceiptObservation } from '@openmoq/webtransport';
import type { SeekRoleBridgeOwner } from './seek-role-retrieval.js';
import { fixture } from '../test-support/seek-role-retrieval.js';
import { turn } from '../test-support/seek-live-bridge.js';

describe.each([18, 22] as const)('retrieval optional bridge measurement draft%i', draft => {
  it('forwards the exact reserved role owner and observes accepted live while owner.input is still absent', async () => {
    const token = {}, capture = vi.fn((_receipt: ObjectReceiptObservation) => token);
    const deliver = vi.fn((_object: MoqtObject, _captured: object) => {});
    const factory = vi.fn((_owner: SeekRoleBridgeOwner) => ({ capture, deliver }));
    const f = await fixture(draft, true, factory), output = f.role('video');
    try {
      await turn(); expect(f.requests).toHaveLength(1);
      await f.server.acceptFetch(f.requests[0]!.id, { endOfTrack: 0,
        endLocation: { group: 3n, object: draft === 22 ? 0n : 1n } });
      const first = await f.server.openFetchStream(f.requests[0]!.id);
      await f.send(first, 0n, 0); await f.server.closeFetchStream(first); await turn();
      expect(factory).toHaveBeenCalledOnce(); expect(f.bridges).toHaveLength(1);
      const owner = f.bridges[0]!;
      expect(factory.mock.calls[0]![0]).toBe(owner);
      expect(owner.track).toEqual({ role: 'video', name: 'video', namespace: ['a/b', 'show'] });
      expect(owner.input).toBeNull(); expect(f.subscriptions).toHaveLength(1);
      const subId = f.subscriptions[0]!;
      await f.server.acceptSubscribe(subId, 77n, {
        parameters: new Map([[MessageParam.LARGEST_OBJECT, [{ group: 3n, object: 2n }]]]),
      }); await turn();
      let prefix: bigint;
      if (draft === 18) {
        expect(f.joins).toHaveLength(1);
        const id = f.joins[0]!;
        await f.server.acceptFetch(id, { endLocation: f.server.resolveJoiningFetch(id).endLocation });
        prefix = await f.server.openFetchStream(id);
      } else prefix = await f.server.openFillStream(subId);
      await turn();
      expect(owner.accepted).toBe(true); expect(owner.input).toBeNull();
      expect(owner.bridge?.acceptedLiveSubscription?.requestId).toBe(subId);
      const live = await f.server.openSubgroup(77n, 3n, 3n, { publisherPriority: 128 });
      await f.server.sendObject(live, 3n, Uint8Array.of(3)); await f.server.closeSubgroup(live); await turn();
      expect(capture).toHaveBeenCalledOnce(); expect(deliver).toHaveBeenCalledOnce();
      expect(deliver.mock.calls[0]![1]).toBe(token);
      expect(owner.input, 'the role input is installed only after prefix/media drain').toBeNull();
      expect(output.received).toEqual([0]);
      await f.send(prefix, 1n, 1); await f.send(prefix, 2n, 2); await f.server.closeFetchStream(prefix); await turn();
      expect(owner.input).not.toBeNull(); expect(output.received).toEqual([0, 1, 2, 3]);
      expect(capture).toHaveBeenCalledOnce(); expect(deliver).toHaveBeenCalledOnce();
      expect(output.failures).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('observation-factory cancellation retires the reservation before any bridge subscription is emitted', async () => {
    const capture = vi.fn((_receipt: ObjectReceiptObservation) => ({}));
    const deliver = vi.fn((_object: MoqtObject, _captured: object) => {});
    const factory = vi.fn((owner: SeekRoleBridgeOwner) => { owner.cancel(); return { capture, deliver }; });
    const f = await fixture(draft, true, factory), output = f.role('video');
    try {
      await turn(); expect(f.requests).toHaveLength(1);
      await f.server.acceptFetch(f.requests[0]!.id, { endOfTrack: 0,
        endLocation: { group: 3n, object: draft === 22 ? 0n : 1n } });
      const stream = await f.server.openFetchStream(f.requests[0]!.id);
      await f.send(stream, 0n, 0); await f.server.closeFetchStream(stream); await turn();
      expect(output.received).toEqual([0]); expect(factory).toHaveBeenCalledOnce();
      expect(f.bridges).toEqual([]); expect(f.subscriptions).toEqual([]); expect(f.joins).toEqual([]);
      expect(capture).not.toHaveBeenCalled(); expect(deliver).not.toHaveBeenCalled();
      expect(output.failures).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});
