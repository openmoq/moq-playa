import { describe, expect, it, vi } from 'vitest';
import { createControlCodec, decodeFetchLocationFilter, MAX_VI64, varint } from '@openmoq/transport';
import type { MediaTimelineEntry } from '@openmoq/msf';
import { MoqtConnection } from '@openmoq/webtransport';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { planSeekFetchPage, type SeekFetchCut, type SeekFetchPageInput } from './seek-fetch-pages.js';
import { SeekRoleRetrieval, type SeekRoleBridgeOwner } from './seek-role-retrieval.js';
import type { TimelineState } from './timeline-manager.js';

const before = (groupId: bigint, objectId = 0n): SeekFetchCut => ({ kind: 'before', groupId, objectId });
const entry = (mediaPts: number, group: number, object = 0): MediaTimelineEntry => ({ mediaPts, location: [group, object], wallclockTime: 0 });
const entries = () => [entry(6000, 4), entry(8000, 4, 1), entry(10000, 5), entry(3_600_000, 900)];
const timeline = (index = entries(), isLive = true): TimelineState => ({ trackName: 'timeline', depends: ['video'], entries: index, isLive, trackDuration: undefined });
function planning(draft: 14 | 16 | 18 | 22, index = entries(), preparingGroup?: bigint, cut = before(4n)) {
  const options: SeekFetchPageInput & { preparingGroup?: bigint } = { draftVersion: draft, trackName: 'video',
    timeline: timeline(index), cut, endOfTrack: false, ...(preparingGroup === undefined ? {} : { preparingGroup }) };
  return planSeekFetchPage(options);
}

describe('preparation-only indexed group page boundaries', () => {
  it.each([14, 16, 18, 22] as const)('draft%i includes only the first higher indexed Location', draft => {
    const result = planning(draft, entries(), 4n);
    expect(result).toMatchObject({ kind: 'fetch-page', end: { groupId: 5n, objectId: 1n }, through: before(5n, 1n),
      proof: { requestedThrough: before(5n, 1n) } });
    if (result.kind !== 'fetch-page') throw new Error('Expected finite page');
    const codec = createControlCodec(draft), encoded = codec.encode({ type: 'FETCH', requestId: varint(0), fetch: {
      fetchType: 1, trackNamespace: [new TextEncoder().encode('show')], trackName: new TextEncoder().encode('video'),
      startLocation: { group: result.start.groupId, object: result.start.objectId },
      endLocation: { group: result.end.groupId, object: result.end.objectId } }, parameters: new Map() });
    const decoded = codec.decode(encoded, 0).message;
    if (decoded.type !== 'FETCH' || decoded.fetch.fetchType !== 1) throw new Error('Expected standalone FETCH');
    expect(decoded.fetch.endLocation).toEqual({ group: 5n, object: 1n });
    if (draft === 22) {
      const filter = decoded.parameters.get(0x21n)?.[0];
      if (!(filter instanceof Uint8Array)) throw new Error('Expected LOCATION_FILTER');
      expect(decodeFetchLocationFilter(filter)).toEqual([4n, 0n, 1n, 0n]);
    }
  });

  it('keeps ordinary crossing and within-G page bounds unchanged', () => {
    expect(planning(22)).toMatchObject({ kind: 'fetch-page', end: { groupId: 4n, objectId: 0n }, through: before(5n) });
    const within = [entry(6000, 4), entry(8000, 4, 2), entry(10000, 4, 4), entry(12000, 5)];
    expect(planning(22, within, 4n)).toEqual(planning(22, within));
  });

  it('chooses Location order rather than the remote timed boundary', () => {
    const index = [entry(6100, 900), entry(6000, 4), entry(6001, 7, 8), entry(6002, 5, 9), entry(6003, 5, 2)];
    expect(planning(18, index, 4n)).toMatchObject({ kind: 'fetch-page', end: { groupId: 5n, objectId: 3n }, through: before(5n, 3n) });
  });

  it('group zero is active and an indexed tip cannot trigger a live probe', () => {
    expect(planning(22, [entry(0, 0), entry(2000, 1)], 0n, before(0n))).toMatchObject({ kind: 'fetch-page', through: before(1n, 1n) });
    expect(planning(18, [entry(6000, 4)], 4n)).toEqual({ kind: 'wait-for-index', reason: 'no-new-indexed-range' });
    expect(planning(18, [entry(6000, 4)])).toMatchObject({ kind: 'probe-live' });
  });

  it('does not fabricate publication and retains the enlarged requestedThrough in a stalled proof', () => {
    expect(planning(22, [], 4n)).toEqual({ kind: 'wait-for-index', reason: 'no-index' });
    const first = planning(22, entries(), 4n);
    if (first.kind !== 'fetch-page') throw new Error('Expected page');
    const options: SeekFetchPageInput & { preparingGroup: bigint } = { draftVersion: 22, trackName: 'video', timeline: timeline(),
      cut: before(4n), endOfTrack: false, preparingGroup: 4n, lastNonProgress: first.proof };
    expect(planSeekFetchPage(options)).toEqual({ kind: 'wait-for-index', reason: 'no-new-publication' });
    expect(planSeekFetchPage({ ...options, timeline: timeline([...entries(), entry(3_700_000, 901)]) }))
      .toEqual({ kind: 'wait-for-index', reason: 'no-new-indexed-range' });
  });
});

// Real SDK transport and request ownership; tiny payloads do not assert codec or native readiness.
async function fixture(draft: 18 | 22, settings: { preparing?: bigint | null; isLive?: boolean; index?: MediaTimelineEntry[] } = {}) {
  const { a, b } = createLoopback(), client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const requests: Array<{ id: bigint; start: { group: bigint; object: bigint }; end: { group: bigint; object: bigint } }> = [];
  const subs: bigint[] = [], bridges: SeekRoleBridgeOwner[] = [], errors: string[] = [], received: Array<[bigint, bigint]> = [];
  const accepted = vi.fn(), closed = vi.fn(), failed = vi.fn(), ended = vi.fn(), generic = vi.fn(), canProbe = vi.fn(() => true);
  let preparing = settings.preparing, policyCalls = 0, current = true, onPolicy: (() => void) | undefined;
  const index = timeline(settings.index ?? entries(), settings.isLive ?? true);
  client.onError = server.onError = error => { errors.push(error.message); };
  server.onFetch = (id, message) => {
    if (message.fetch.fetchType !== 1) throw new Error('Expected standalone FETCH');
    requests.push({ id, start: message.fetch.startLocation, end: message.fetch.endLocation });
  };
  server.onSubscribe = id => { subs.push(id); };
  await Promise.all([client.connect(a), server.connect(b)]);
  const options: ConstructorParameters<typeof SeekRoleRetrieval>[0] & { getPreparingGroup: () => bigint | null } = {
    connection: client, track: { role: 'video', namespace: ['show'], name: 'video' },
    location: { groupId: BigInt(index.entries[0]?.location[0] ?? 4), objectId: 0n },
    timeoutMs: 1000, maxObjects: 16, maxBytes: 1024, isCurrent: () => current, getTimeline: () => index,
    getPreparingGroup: () => { policyCalls++; onPolicy?.(); return preparing ?? null; },
    canProbeLive: canProbe, admitHead: () => true, beforeSubscribe: () => true,
    beginPage: page => ({ onObject: async object => { if (object.kind === 'data') received.push([object.groupId, object.objectId]); },
      onClosed: terminal => { closed(terminal); if (terminal === 'fin') owner.onPageDrained(page); } }),
    acceptPage: accepted, beginLive: () => { throw new Error('No live acceptance in this fixture'); },
    capture: () => undefined, discard: vi.fn(), consume: async (object, _input, admitted, deliver) => { if (admitted()) await deliver(object); },
    onBridgeAdded: bridge => { bridges.push(bridge); }, onBridgeRemoved: vi.fn(), onEnded: ended, onProgress: vi.fn(), onFailure: failed,
  };
  const owner = new SeekRoleRetrieval(options);
  client.onMessage = message => { owner.requests.handleControl(message) || bridges.some(item => item.bridge?.handleControl(message)); };
  client.onDataStream = (id, header) => { owner.requests.handleStreamOpen(id, header) || bridges.some(item => item.bridge?.handleStreamOpen(id, header)); };
  client.onStreamClosed = (id, _code, terminal) => { owner.requests.handleStreamClose(id) || bridges.some(item => item.bridge?.handleStreamClose(id, terminal)); };
  client.onObject = generic;
  async function serve(index: number, actual?: { group: bigint; object: bigint }) {
    const request = requests[index]; if (!request) throw new Error('No real FETCH');
    const includesHigher = request.end.group > 5n || request.end.group === 5n && request.end.object > 0n;
    const response = actual ?? (includesHigher ? { group: 5n, object: draft === 22 ? 0n : 1n }
      : { group: 4n, object: draft === 22 ? 1n : 0n });
    await server.acceptFetch(request.id, { endOfTrack: 0, endLocation: response });
    const stream = await server.openFetchStream(request.id);
    for (const [groupId, objectId] of [[4n, 0n], [4n, 1n], ...(includesHigher ? [[5n, 0n]] : [])]) {
      await server.sendFetchObject(stream, { groupId: groupId!, objectId: objectId!, subgroupId: 0n,
        publisherPriority: 128, payload: Uint8Array.of(1) });
    }
    await flush(256); return stream;
  }
  return { owner, client, server, requests, subs, received, accepted, closed, failed, ended, errors, generic, canProbe, index, serve,
    get calls() { return policyCalls; }, setPreparing(value: bigint | null) { preparing = value; },
    setPolicy(callback: () => void) { onPolicy = callback; }, retire() { current = false; },
    async destroy() { owner.cancel(); await client.close(); await server.close(); } };
}

describe.each([18, 22] as const)('preparation request policy through SDK draft%i', draft => {
  it('receives the first indexed higher DATA before FIN instead of ending at whole G', async () => {
    const f = await fixture(draft, { preparing: 4n });
    try {
      f.owner.pump(); await flush(256);
      const stream = await f.serve(0);
      expect(f.received).toEqual([[4n, 0n], [4n, 1n], [5n, 0n]]);
      expect(f.calls).toBe(1); expect(f.closed).not.toHaveBeenCalled(); expect(f.requests[0]?.end).toEqual({ group: 5n, object: 1n });
      expect(f.accepted.mock.calls[0]?.[2]?.through).toEqual(before(5n, 1n));
      expect(f.requests).toHaveLength(1); expect(f.subs).toEqual([]); expect(f.canProbe).not.toHaveBeenCalled();
      expect(f.generic).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
      await f.server.closeFetchStream(stream);
    } finally { await f.destroy(); }
  });

  it('CONTROL: ordinary live range still excludes the higher boundary, and actual response remains authoritative', async () => {
    const f = await fixture(draft);
    try {
      f.owner.pump(); await flush(256); await f.serve(0);
      expect(f.requests[0]?.end).toEqual({ group: 4n, object: 0n });
      expect(f.received).toEqual([[4n, 0n], [4n, 1n]]);
      expect(f.accepted.mock.calls[0]?.[2]?.through).toEqual(draft === 22 ? before(4n, 2n) : before(5n));
      expect(f.closed).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('non-live preparation is finite, while a null policy preserves the initial snapshot', async () => {
    const active = await fixture(draft, { preparing: 4n, isLive: false });
    const ordinary = await fixture(draft, { preparing: null, isLive: false });
    try {
      active.owner.pump(); ordinary.owner.pump(); await flush(256);
      expect(ordinary.requests[0]?.end).toEqual({ group: MAX_VI64, object: 0n });
      expect(active.requests[0]?.end).toEqual({ group: 5n, object: 1n });
      expect(active.calls).toBe(1); expect(ordinary.calls).toBe(1);
    } finally { await active.destroy(); await ordinary.destroy(); }
  });

  it('treats preparation group zero as active for the real non-live request', async () => {
    const f = await fixture(draft, { preparing: 0n, isLive: false,
      index: [entry(0, 0), entry(2000, 1), entry(3_600_000, 900)] });
    try {
      f.owner.pump(); await flush(256);
      expect(f.requests[0]?.start).toEqual({ group: 0n, object: 0n });
      expect(f.requests[0]?.end).toEqual({ group: 1n, object: 1n });
      expect(f.calls).toBe(1); expect(f.subs).toEqual([]); expect(f.failed).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });

  it('waits without requests when the preparation index is missing, then uses new explicit entries', async () => {
    const f = await fixture(draft, { preparing: 4n, isLive: false, index: [] });
    try {
      f.owner.pump(); f.owner.pump(); await flush(256);
      expect(f.requests).toEqual([]); expect(f.subs).toEqual([]); expect(f.calls).toBe(2);
      f.index.entries = entries(); f.owner.pump(); await flush(256);
      expect(f.requests).toHaveLength(1); expect(f.requests[0]?.end).toEqual({ group: 5n, object: 1n });
      expect(f.failed).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('keeps prepromotion at the index tip out of JOIN/FILL, then restores ordinary policy', async () => {
    const f = await fixture(draft, { preparing: 4n });
    try {
      f.owner.pump(); await flush(256); const stream = await f.serve(0);
      f.index.entries = [entry(6000, 4), entry(8000, 4, 1), entry(10000, 5), entry(12000, 5, 1)];
      await f.server.closeFetchStream(stream); await flush(256);
      expect(f.requests).toHaveLength(1); expect(f.subs).toEqual([]); expect(f.canProbe).not.toHaveBeenCalled();
      f.setPreparing(null); f.owner.pump(); await flush(256);
      expect(f.subs).toHaveLength(1); expect(f.canProbe).toHaveBeenCalledOnce();
      expect(f.failed).not.toHaveBeenCalled(); expect(f.ended).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('rechecks cancellation after the single preparation callback', async () => {
    const f = await fixture(draft, { preparing: 0n });
    try {
      f.setPolicy(() => f.retire()); f.owner.pump(); await flush(256);
      expect(f.calls).toBe(1); expect(f.requests).toEqual([]); expect(f.subs).toEqual([]); expect(f.failed).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });

  it('a reentrant page opener cannot be overwritten by the outer policy snapshot', async () => {
    const f = await fixture(draft, { preparing: 4n });
    try {
      let once = false; f.setPolicy(() => { if (!once) { once = true; f.owner.pump(); } });
      f.owner.pump(); await flush(256);
      expect(f.calls).toBe(2); expect(f.requests).toHaveLength(1);
      expect(f.requests[0]?.end).toEqual({ group: 5n, object: 1n }); expect(f.failed).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });
});
