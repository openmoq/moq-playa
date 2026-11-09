import { describe, expect, it, vi } from 'vitest';
import { varint, type MoqtObject } from '@openmoq/transport';
import type { ObjectReceipt, ObjectReceiptObservation } from '@openmoq/webtransport';
import { fixture, turn } from '../test-support/seek-live-bridge.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
type ReceiptState = { liveReceipts: WeakMap<ObjectReceipt, unknown> | null };
const state = (p: Fixture) => p.bridge as unknown as ReceiptState;
async function accepted(p: Fixture, draft: 18 | 22) {
  await p.acknowledge(); if (draft === 18) await p.openJoin();
  expect(p.accepted).toHaveLength(1);
  expect(p.bridge.acceptedLiveSubscription?.requestId).toBe(p.subId);
}
async function finish(p: Fixture) {
  await p.sendPrefixObject(1n); await p.sendPrefixObject(2n);
  await p.server.closeFetchStream(p.prefixStream); await turn();
}
const liveInputs = (p: Fixture) => p.rawInputs.filter(object => BigInt(object.objectId) === 3n);

describe.each([18, 22] as const)('bridge optional measurement draft%i', draft => {
  it('healthy capture/claim happens once before prefix drain without changing media delivery', async () => {
    const token = {}, capture = vi.fn((_receipt: ObjectReceiptObservation) => token);
    const deliver = vi.fn((_object: MoqtObject, _captured: object) => {});
    const p = await fixture(draft, { observation: { capture, deliver } });
    try {
      await accepted(p, draft); await p.live(3n);
      expect(capture).toHaveBeenCalledOnce(); expect(deliver).toHaveBeenCalledOnce();
      expect(capture.mock.calls[0]![0]).toMatchObject({ origin: 'subgroup', trackAlias: 77n, groupId: 3n, objectId: 3n });
      expect(deliver.mock.calls[0]![1]).toBe(token);
      expect(p.received, 'real media remains behind its prefix FIN').toEqual([]);
      await finish(p);
      expect(p.received).toEqual(['prefix:1', 'prefix:2', 'live:3']);
      expect(capture).toHaveBeenCalledOnce(); expect(deliver).toHaveBeenCalledOnce();
      expect(p.errors).toEqual([]); expect(p.transportErrors).toEqual([]);
    } finally { await p.close(); }
  });

  it('cancelling synchronously inside receipt capture prevents storing and claiming the returned token', async () => {
    let p: Fixture | undefined;
    const token = {}, capture = vi.fn((_receipt: ObjectReceiptObservation) => { p!.bridge.cancel(); return token; });
    const deliver = vi.fn((_object: MoqtObject, _captured: object) => {});
    p = await fixture(draft, { observation: { capture, deliver } });
    try {
      await accepted(p, draft);
      // Retain only the existing epoch's weak map as a bounded white-box store
      // oracle. Playback/requests/receipt creation all remain public SDK paths.
      const map = state(p).liveReceipts;
      expect(map).not.toBeNull();
      await p.live(3n); await turn();
      expect(capture).toHaveBeenCalledOnce(); const receipt = capture.mock.calls[0]![0].receipt;
      expect(map!.has(receipt), 'a callback-retired observation must not be stored into its captured epoch').toBe(false);
      expect(state(p).liveReceipts).toBeNull(); expect(deliver).not.toHaveBeenCalled();
      expect(liveInputs(p)).toEqual([]); expect(p.received).toEqual([]);
      expect(p.bridge.acceptedLiveSubscription).toBeNull();
      expect(p.client.session.state).toBe('established'); expect(p.errors).toEqual([]); expect(p.transportErrors).toEqual([]);
    } finally { await p.close(); }
  });

  it('capture may decline measurement while the accepted live Object still queues and drains normally', async () => {
    const capture = vi.fn((_receipt: ObjectReceiptObservation): object | undefined => undefined);
    const deliver = vi.fn((_object: MoqtObject, _captured: object) => {});
    const p = await fixture(draft, { observation: { capture, deliver } });
    try {
      await accepted(p, draft); await p.live(3n); await finish(p);
      expect(capture).toHaveBeenCalledOnce(); expect(deliver).not.toHaveBeenCalled();
      expect(p.received).toEqual(['prefix:1', 'prefix:2', 'live:3']);
      expect(p.errors).toEqual([]); expect(p.transportErrors).toEqual([]);
    } finally { await p.close(); }
  });

  it('cancelling synchronously inside measurement delivery prevents subsequent queue capture', async () => {
    let p: Fixture | undefined;
    const token = {}, capture = vi.fn((_receipt: ObjectReceiptObservation) => token);
    const deliver = vi.fn((_object: MoqtObject, _captured: object) => { p!.bridge.cancel(); });
    p = await fixture(draft, { observation: { capture, deliver } });
    try {
      await accepted(p, draft); await p.live(3n); await turn();
      expect(capture).toHaveBeenCalledOnce(); expect(deliver).toHaveBeenCalledOnce();
      expect(deliver.mock.calls[0]![1]).toBe(token);
      expect(liveInputs(p), 'no diagnostic/queue capture may follow the cancelling delivery callback').toEqual([]);
      expect(p.received).toEqual([]); expect(state(p).liveReceipts).toBeNull();
      expect(p.errors).toEqual([]); expect(p.transportErrors).toEqual([]);
    } finally { await p.close(); }
  });

  it('DONE withdraws measurement immediately while a previously sent datagram still drains legally', async () => {
    const token = {}, capture = vi.fn((_receipt: ObjectReceiptObservation) => token);
    const deliver = vi.fn((_object: MoqtObject, _captured: object) => {});
    const p = await fixture(draft, { delayDatagrams: true, observation: { capture, deliver } });
    try {
      await accepted(p, draft); await finish(p); await p.live(3n);
      expect(capture).toHaveBeenCalledOnce(); expect(deliver).toHaveBeenCalledOnce();
      await p.server.sendDatagram(77n, 3n, 4n, Uint8Array.of(4));
      expect(p.heldDatagrams).toHaveLength(1); expect(p.datagrams).toEqual([]);
      vi.useFakeTimers(); await p.server.publishDone(p.subId, varint(2n), 'finite'); await turn();
      expect(p.bridge.acceptedLiveSubscription).toBeNull(); expect(state(p).liveReceipts).toBeNull();
      await vi.advanceTimersByTimeAsync(25); await turn();
      expect(p.ended).not.toHaveBeenCalled();
      p.a.injectDatagram(p.heldDatagrams[0]!); await turn();
      expect(p.received).toEqual(['prefix:1', 'prefix:2', 'live:3', 'live:4']);
      expect(p.rawInputs.some(object => object === p.datagrams[0])).toBe(true);
      expect(capture).toHaveBeenCalledOnce(); expect(deliver).toHaveBeenCalledOnce();
      expect(p.ended).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(25); await turn(); expect(p.ended).toHaveBeenCalledOnce();
      expect(p.errors).toEqual([]); expect(p.transportErrors).toEqual([]);
    } finally { await p.close(); }
  });

  it('omitting measurement skips objectReceiptFor for real subgroup and original datagram delivery', async () => {
    const p = await fixture(draft);
    const lookup = vi.spyOn(p.client, 'objectReceiptFor');
    try {
      await accepted(p, draft); await finish(p); await p.live(3n);
      await p.server.sendDatagram(77n, 3n, 4n, Uint8Array.of(4)); await turn();
      expect(p.datagrams).toHaveLength(1);
      expect(p.received).toEqual(['prefix:1', 'prefix:2', 'live:3', 'live:4']);
      expect(lookup).not.toHaveBeenCalled(); expect(state(p).liveReceipts).toBeNull();
      expect(p.errors).toEqual([]); expect(p.transportErrors).toEqual([]);
    } finally { lookup.mockRestore(); await p.close(); }
  });

  it('claims the original datagram receipt once while delivering the exact normalized queue-input identity', async () => {
    const token = {}, capture = vi.fn((_receipt: ObjectReceiptObservation) => token);
    const deliver = vi.fn((_object: MoqtObject, _captured: object) => {});
    const p = await fixture(draft, { observation: { capture, deliver } });
    const originalLookup = p.client.objectReceiptFor.bind(p.client);
    const lookup = vi.spyOn(p.client, 'objectReceiptFor');
    const lease = (p.bridge as unknown as { live: { push(object: MoqtObject): Promise<void> } }).live;
    const push = vi.spyOn(lease, 'push');
    try {
      await accepted(p, draft);
      await p.server.sendDatagram(77n, 3n, 3n, Uint8Array.of(3)); await turn();
      expect(p.datagrams).toHaveLength(1); const original = p.datagrams[0]!;
      expect(capture).toHaveBeenCalledOnce(); expect(capture.mock.calls[0]![0].origin).toBe('datagram');
      expect(capture.mock.calls[0]![0].receipt).toBe(originalLookup(original));
      expect(lookup.mock.calls).toEqual([[original]]);
      expect(deliver).toHaveBeenCalledOnce(); const [normalized, captured] = deliver.mock.calls[0]!;
      expect(captured).toBe(token); expect(normalized).not.toBe(original);
      expect(normalized).toMatchObject({ kind: 'data', trackAlias: 77n, groupId: 3n, subgroupId: 0n, objectId: 3n });
      expect(originalLookup(normalized), 'normalization does not manufacture an SDK receipt').toBeUndefined();
      expect(push).toHaveBeenCalledExactlyOnceWith(normalized);
      expect(p.rawInputs).toEqual([original]); expect(p.received).toEqual([]);
      original.payload.fill(99); await finish(p);
      expect(p.livePayloads).toEqual([[3]]); expect(p.received).toEqual(['prefix:1', 'prefix:2', 'live:3']);
      expect(deliver).toHaveBeenCalledOnce(); expect(capture).toHaveBeenCalledOnce();
      expect(lookup.mock.calls).toEqual([[original]]);
      expect(p.errors).toEqual([]); expect(p.transportErrors).toEqual([]);
    } finally { push.mockRestore(); lookup.mockRestore(); await p.close(); }
  });
});

it.each([0, 1] as const)('draft18 FETCH_OK EndOfTrack=%i exposes correct measurement eligibility and still consumes its final prefix', async endOfTrack => {
  const capture = vi.fn((_receipt: ObjectReceiptObservation) => ({}));
  const deliver = vi.fn((_object: MoqtObject, _captured: object) => {});
  const p = await fixture(18, { observation: { capture, deliver } });
  try {
    await p.acknowledge(); await p.openJoin(undefined, false, endOfTrack);
    expect(p.accepted).toHaveLength(1); expect(p.accepted[0]!.endOfTrack).toBe(endOfTrack === 1);
    expect(p.bridge.acceptedLiveSubscription?.requestId ?? null).toBe(endOfTrack ? null : p.subId);
    expect(p.received).toEqual([]); await finish(p);
    expect(p.received).toEqual(['prefix:1', 'prefix:2']);
    expect(capture).not.toHaveBeenCalled(); expect(deliver).not.toHaveBeenCalled();
    expect(p.client.session.state).toBe('established'); expect(p.errors).toEqual([]); expect(p.transportErrors).toEqual([]);
  } finally { await p.close(); }
});
