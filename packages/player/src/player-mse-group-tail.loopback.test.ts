import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { MoqtPlayer } from './player.js';
import type { MoqtPlayerConfig } from './config.js';
import { MseMediaSource } from '../../browser/src/mse-adapter.js';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { MoqtConnection, type ObjectReceipt } from '@openmoq/webtransport';
import { createLoopback } from '../../webtransport/src/testkit/loopback.js';
import { buildInit, buildChunk, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { parseLocmafTrackContext, readCmafChunkSamples } from '@openmoq/locmaf';
import { varint } from '@openmoq/transport';
import type { CatalogTrack } from '@openmoq/msf';
import { createMediaDiagnostics } from './media-diagnostics.js';
import type { MediaStageObservation } from './media-diagnostic-types.js';
import { MockMediaSource, MockVideoElement } from '../../browser/test-support/mse-native.js';

let source: MockMediaSource;
beforeEach(() => {
  vi.useFakeTimers(); source = new MockMediaSource();
  vi.stubGlobal('MediaSource', class { constructor() { return source; } });
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:review', revokeObjectURL() {} });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const settle = async () => { for (let i = 0; i < 512; i++) await Promise.resolve(); };
async function connectedPair(draft: 14 | 16 | 18 | 22) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const errors: Error[] = [];
  client.onError = server.onError = error => { errors.push(error); };
  await Promise.all([client.connect(a, { maxRequestId: varint(1000) }), server.connect(b, { maxRequestId: varint(1000) })]);
  return { a, client, server, errors };
}
async function fixture(options: { draft?: 14 | 16 | 18 | 22; transform?: MoqtPlayerConfig['objectTransform']; onRelease?: () => void; onRetain?: (player: MoqtPlayer, group: bigint, sourceKey?: string) => void; switching?: boolean; largestProvider?: boolean } = {}) {
  const pair = await connectedPair(options.draft ?? 18), requests: Array<{ id: bigint; ns: string[]; name: string }> = [];
  pair.server.onSubscribe = (id, ns, name) => { requests.push({ id, ns: ns.map(field => new TextDecoder().decode(field)), name: new TextDecoder().decode(name) }); };
  const init = buildInit({ trackId: 1, timescale: 1000, handler: 'vide' });
  const video = new MockVideoElement(), adapter = new MseMediaSource(video as unknown as HTMLVideoElement, { maxAheadSec: Infinity });
  if (options.onRelease) {
    const retain = adapter.retainReceivingGroup.bind(adapter);
    const onRelease = options.onRelease;
    adapter.retainReceivingGroup = (...args) => {
      const release = retain(...args);
      options.onRetain?.(player, args[2], args[4]);
      return () => { release(); onRelease(); };
    };
  }
  source.open();
  const player = new MoqtPlayer({ url: 'https://review.invalid/live', namespace: ['review', 'picture'], draftVersion: options.draft ?? 18,
    ...(options.transform ? { objectTransform: options.transform } : {}),
    connection: pair.client, createTransport: async () => pair.a, disableAudio: true, cmafBootstrapTimeoutMs: 0,
    reconnectAttempts: 0, ...(options.switching ? { autoQuality: false, startLevel: 'lowest' } : {}), catalog: { tracks: [{ name: 'video', namespace: 'review/picture', role: 'video', packaging: 'cmaf',
      codec: 'avc1.640028', isLive: false, initData: Buffer.from(init).toString('base64'), ...(options.switching ? { altGroup: 1, renderGroup: 1, bitrate: 100 } : {}) }, ...(options.switching ? [{ name: 'nextVideo', namespace: 'review/picture', role: 'video', packaging: 'cmaf', codec: 'avc1.640028', isLive: false, initData: Buffer.from(init).toString('base64'), altGroup: 1, renderGroup: 1, bitrate: 200 } satisfies CatalogTrack] : [])] },
    createMediaSource: () => adapter, createCmafAssembler: options => new CmafAssembler(options) });
  const errors: string[] = []; player.on('error', event => { errors.push(event.error.message); });
  await player.load(); await settle();
  expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({ ns: ['review', 'picture'], name: 'video' });
  await pair.server.acceptSubscribe(requests[0]!.id, 10n); await settle();
  const aliases = new Map<bigint, bigint>([[10n, requests[0]!.id]]);
  const largest = new Map<bigint, { group: bigint; object: bigint }>();
  if (options.largestProvider) pair.server.setLargestLocationProvider(id => largest.get(id) ?? null);
  const streams = new Map<string, bigint>();
  const send = async (group: bigint, object: bigint, dts: number, last = false, subgroup = 0n, endOfGroup = true, alias = 10n) => {
    const key = `${alias === 10n ? '' : String(alias) + ':'}${group}:${subgroup}`;
    let stream = streams.get(key);
    if (stream === undefined) { stream = await pair.server.openSubgroup(alias, group, subgroup, { publisherPriority: 128, endOfGroup }); streams.set(key, stream); }
    const bytes = buildChunk({ trackId: 1, bmdt: BigInt(dts), samples: [{ duration: 20, size: 4,
      flags: object === 0n ? SYNC_FLAGS : NON_SYNC_FLAGS }], mdat: Uint8Array.of(Number(group), Number(object), 3, 4) });
    await pair.server.sendObject(stream, object, bytes);
    const request = aliases.get(alias);
    if (request !== undefined) {
      const previous = largest.get(request);
      if (!previous || group > previous.group || group === previous.group && object > previous.object) largest.set(request, { group, object });
    }
    if (last) await pair.server.closeSubgroup(stream); await settle();
  };
  const open = async (group: bigint, alias = 10n) => {
    const key = `${alias === 10n ? '' : String(alias) + ':'}${group}:0`;
    const stream = await pair.server.openSubgroup(alias, group, 0n, { publisherPriority: 128, endOfGroup: true });
    streams.set(key, stream); await settle();
  };
  const close = async (group: bigint, subgroup = 0n) => { await pair.server.closeSubgroup(streams.get(`${group}:${subgroup}`)!); await settle(); };
  const output = () => source.videoBuffer.appendedPayloads.filter(bytes => String.fromCharCode(...bytes.subarray(4, 8)) === 'moof')
    .map(bytes => Number(readCmafChunkSamples(bytes, parseLocmafTrackContext(init)).effective.baseMediaDecodeTime));
  const destroy = async () => { await player.destroy(); await pair.client.close(); await pair.server.close(); };
  const finish = async () => { await pair.server.publishDone(requests[0]!.id, varint(2n), 'finite complete'); await settle(); };
  return { client: pair.client, server: pair.server, player, adapter, send, open, close, output, finish, requests, async acceptName(name: string, alias: bigint) { const request = requests.find(r => r.name === name); expect(request).toBeDefined(); await pair.server.acceptSubscribe(request!.id, alias); aliases.set(alias, request!.id); await settle(); }, native: source, errors, wireErrors: pair.errors, destroy };
}

it.each([100, 1500])('MSE public player preserves old-group tail received after %s ms before releasing the successor', async stallMs => {
  const f = await fixture();
  try {
    await f.send(1n, 0n, 0);
    expect(f.adapter.getCommittedGroupFloor('video', 'video', JSON.stringify([['review', 'picture'], 'video']))).toBe(1n);
    await f.send(2n, 0n, 60, true);
    await vi.advanceTimersByTimeAsync(stallMs);
    await f.send(1n, 1n, 20); await f.send(1n, 2n, 40, true);
    await vi.advanceTimersByTimeAsync(300);
    expect(f.output()).toEqual([0, 20, 40, 60]); expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
  } finally { await f.destroy(); }
});

it('does not invent a missing numeric group before appending fully received finite successor media', async () => {
  const f = await fixture();
  try {
    await f.send(100n, 0n, 0, true); await f.send(900n, 0n, 20, true);
    expect.soft(f.output()).toEqual([0, 20]);
    await vi.advanceTimersByTimeAsync(2100);
    expect(f.output()).toEqual([0, 20]); expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
  } finally { await f.destroy(); }
});

it('retains finite media through wire completion without equating DONE with native playback end', async () => {
  const f = await fixture();
  try {
    await f.send(100n, 0n, 0, true); await f.send(900n, 0n, 20, true);
    await f.finish();
    await vi.advanceTimersByTimeAsync(2100);
    expect(f.output()).toEqual([0, 20]);
    expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
  } finally { await f.destroy(); }
});

it('a prior sparse boundary does not lose an ordinary reordered successor group later', async () => {
  const f = await fixture();
  try {
    await f.send(100n, 0n, 0, true); await f.send(900n, 0n, 20, true);
    await vi.advanceTimersByTimeAsync(2100); expect(f.output()).toEqual([0, 20]);
    await f.send(902n, 0n, 60, true);
    await vi.advanceTimersByTimeAsync(100);
    await f.send(901n, 0n, 40, true);
    await vi.advanceTimersByTimeAsync(300);
    expect(f.output()).toEqual([0, 20, 40, 60]); expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
  } finally { await f.destroy(); }
});

// A subgroup terminal is scoped to that stream, not proof that another
// subgroup's accepted work has completed (transport §10.4).
it('one subgroup FIN cannot release a sibling subgroup still supplying the old tail', async () => {
  const f = await fixture();
  try {
    await f.send(1n, 0n, 0, false, 0n, false);
    await f.send(1n, 1n, 20, false, 1n, true);
    await f.send(2n, 0n, 60, true);
    await f.close(1n);
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.output()).toEqual([0, 20]);
    await f.send(1n, 2n, 40, true, 1n, true);
    expect(f.output()).toEqual([0, 20, 40, 60]);
    expect(f.wireErrors).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.destroy(); }
});

it.each([16, 18, 22] as const)('draft %s FIN waits accepted async tail work rather than just wire receipt', async draft => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  const f = await fixture({ draft, transform: obj => {
    if (obj.groupId === 1n && obj.objectId === 1n) { entered = true; return held.then(() => obj); }
    return obj;
  } });
  try {
    await f.send(1n, 0n, 0);
    await f.send(2n, 0n, 60, true);
    await f.send(1n, 1n, 20); await f.send(1n, 2n, 40, true);
    expect(entered).toBe(true);
    await f.finish(); // Sender FINs precede DONE, while accepted processing is held.
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.output()).toEqual([0]);
    release(); await settle();
    expect(f.output()).toEqual([0, 20, 40, 60]);
    expect(f.wireErrors).toEqual([]); expect(f.errors).toEqual([]);
  } finally { release(); await f.destroy(); }
});

it('overdue FIN cannot restart an expired append wait or admit the old tail', async () => {
  const f = await fixture();
  try {
    await f.send(1n, 0n, 0);
    await f.send(2n, 0n, 60, true);
    await vi.advanceTimersByTimeAsync(2100);
    expect(f.output()).toEqual([0, 60]);
    await f.close(1n);
    await vi.advanceTimersByTimeAsync(2100);
    expect(f.output()).toEqual([0, 60]);
    expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
  } finally { await f.destroy(); }
});

it.each([false, true])('custom source release (throws: %s) settles synchronous and async stream retirement exactly once', async throws => {
  let release!: () => void, releases = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({
    onRelease: () => { releases++; if (throws) throw new Error('custom release failed'); },
    transform: obj => obj.groupId === 1n && obj.objectId === 1n ? held.then(() => obj) : obj,
  });
  try {
    await f.send(1n, 0n, 0);
    await f.send(2n, 0n, 60, true);
    expect(releases).toBe(1); // Synchronous close with no accepted work pending.
    await f.send(1n, 1n, 20); await f.send(1n, 2n, 40, true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(releases).toBe(1); expect(f.output()).toEqual([0]);
    release(); await settle();
    expect(releases).toBe(2); // Deferred FIN release after accepted work settled.
    expect(f.output()).toEqual([0, 20, 40, 60]);
    expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
  } finally { release(); await f.destroy(); }
});

it.each(['healthy', 'destroy'] as const)('release handoff survives synchronous retain-hook %s boundary', async mode => {
  let releases = 0, destroying: Promise<void> | undefined;
  const f = await fixture({ onRelease: () => { releases++; },
    onRetain: player => { if (mode === 'destroy') destroying ??= player.destroy(); } });
  try {
    await f.send(1n, 0n, 0, true); await settle();
    if (destroying) await destroying;
    expect(releases).toBe(1);
  } finally { await f.destroy(); }
});

it.each([false, true])('selected-stream tail lease survives prior quality preparation (switched: %s)', async switched => {
  const f = await fixture({ switching: switched });
  try {
    await f.send(1n, 0n, 0, true);
    const alias = switched ? 11n : 10n;
    if (switched) {
      const selecting = f.player.selectVideoTrack('nextVideo');
      const result = selecting.then(() => null, error => error);
      await settle(); await f.acceptName('nextVideo', alias);
      await f.send(10n, 0n, 20, false, 0n, true, alias);
      expect(await result).toBeNull();
    } else await f.send(10n, 0n, 20, false, 0n, true, alias);
    await f.send(10n, 1n, 40, false, 0n, true, alias);
    expect(f.output()).toHaveLength(3);
    await f.send(11n, 0n, 100, true, 0n, true, alias);
    await vi.advanceTimersByTimeAsync(1500);
    expect.soft(f.output()).toHaveLength(3);
    await f.send(10n, 2n, 60, false, 0n, true, alias);
    await f.send(10n, 3n, 80, true, 0n, true, alias);
    expect(f.output()).toHaveLength(6);
    expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
  } finally { await f.destroy(); }
});

it('draft 14 receiving evidence preserves a reordered old-group tail', async () => {
  const f = await fixture({ draft: 14 });
  try {
    await f.send(1n, 0n, 0); await f.send(2n, 0n, 60, true);
    await vi.advanceTimersByTimeAsync(1500); expect(f.output()).toEqual([0]);
    await f.send(1n, 1n, 20); await f.send(1n, 2n, 40, true);
    expect(f.output()).toEqual([0,20,40,60]); expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
  } finally { await f.destroy(); }
});

it.each([false, true])('adopted first-object stream retains its tail before any post-adoption object (switched: %s)', async switched => {
  const f = await fixture({ switching: switched });
  try {
    await f.send(1n, 0n, 0, true);
    const alias = switched ? 11n : 10n;
    if (switched) {
      const selecting = f.player.selectVideoTrack('nextVideo');
      const result = selecting.then(() => null, error => error);
      await settle(); await f.acceptName('nextVideo', alias);
      await f.send(10n, 0n, 20, false, 0n, true, alias);
      expect(await result).toBeNull();
    } else await f.send(10n, 0n, 20, false, 0n, true, alias);
    expect(f.output()).toHaveLength(2);
    await f.send(11n, 0n, 100, true, 0n, true, alias);
    await vi.advanceTimersByTimeAsync(1500);
    expect.soft(f.output()).toHaveLength(2);
    await f.send(10n, 1n, 40, false, 0n, true, alias);
    await f.send(10n, 2n, 60, false, 0n, true, alias);
    await f.send(10n, 3n, 80, true, 0n, true, alias);
    expect(f.output()).toHaveLength(6);
    expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
  } finally { await f.destroy(); }
});


it.each(['healthy', 'destroy'] as const)('selected-owner batch admission reserves each stream across %s reentry', async mode => {
  const retained: bigint[] = [];
  let releases = 0, destroying: Promise<void> | undefined;
  const f = await fixture({ switching: true, onRelease: () => { releases++; }, onRetain: (player, group) => {
    retained.push(group);
    if (mode === 'destroy' && group === 11n) destroying ??= player.destroy();
  } });
  try {
    await f.send(1n, 0n, 0, true);
    const result = f.player.selectVideoTrack('nextVideo').then(() => null, error => error);
    await settle(); await f.acceptName('nextVideo', 11n);
    await f.open(11n, 11n);
    await f.send(10n, 0n, 20, false, 0n, true, 11n);
    expect(await result).toBeNull();
    await f.send(11n, 0n, 100, true, 0n, true, 11n);
    if (destroying) {
      await destroying;
      expect(retained).toEqual([1n, 11n]);
      expect(releases).toBe(2);
    } else {
      expect(retained).toEqual([1n, 11n, 10n]);
      await vi.advanceTimersByTimeAsync(1500);
      expect(f.output()).toEqual([0, 20]);
      await f.send(10n, 1n, 40, false, 0n, true, 11n);
      await f.send(10n, 2n, 60, false, 0n, true, 11n);
      await f.send(10n, 3n, 80, true, 0n, true, 11n);
      expect(f.output()).toEqual([0, 20, 40, 60, 80, 100]);
      expect(releases).toBe(3);
      expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
    }
  } finally { await f.destroy(); }
});

it('a header-only stream cannot create a predecessor tail wait at selection adoption', async () => {
  const retained: bigint[] = [];
  const f = await fixture({ switching: true, onRelease: () => {}, onRetain: (_player, group) => { retained.push(group); } });
  try {
    await f.send(1n, 0n, 0, true);
    const result = f.player.selectVideoTrack('nextVideo').then(() => null, error => error);
    await settle(); await f.acceptName('nextVideo', 11n);
    await f.open(5n, 11n);
    await f.send(10n, 0n, 20, true, 0n, true, 11n);
    expect(await result).toBeNull();
    await f.send(11n, 0n, 100, true, 0n, true, 11n);
    await vi.advanceTimersByTimeAsync(300);
    expect(retained).toEqual([1n, 11n]);
    expect(f.output()).toEqual([0, 20, 100]);
    expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
  } finally { await f.destroy(); }
});

// Draft18 permits mixed transport delivery. The first uni data stream has local id0; datagrams have no stream id.
it.each(['datagram', 'stream'] as const)('a %s receipt does not forge stream-zero receiving evidence', async mode => {
  const f = await fixture();
  const retain = vi.spyOn(f.adapter, 'retainReceivingGroup');
  try {
    const stream = await f.server.openSubgroup(10n, 1n, 0n, { publisherPriority: 128, endOfGroup: false });
    await settle();
    const bytes = buildChunk({ trackId: 1, bmdt: 0n, samples: [{ duration: 20, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(1,0,3,4) });
    if (mode === 'datagram') await f.server.sendDatagram(10n,1n,0n,bytes);
    else await f.server.sendObject(stream,0n,bytes);
    await settle();
    expect(f.output()).toEqual([0]);
    expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
    const next = buildChunk({ trackId: 1, bmdt: 60n, samples: [{ duration: 20, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(2,0,3,4) });
    await f.server.sendDatagram(10n,2n,0n,next); await settle();
    await vi.advanceTimersByTimeAsync(350);
    expect.soft(f.output()).toEqual(mode === 'datagram' ? [0,60] : [0]);
    expect(retain).toHaveBeenCalledTimes(mode === 'datagram' ? 0 : 1);
    await f.server.closeSubgroup(stream); await settle();
    expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
  } finally { await f.destroy(); }
});

it('the engine forwards its authoritative namespace/name source key to receiving evidence and native appends', async () => {
  const retained: Array<string | undefined> = [];
  const f = await fixture({ onRelease: () => {}, onRetain: (_player, _group, sourceKey) => { retained.push(sourceKey); } });
  const append = vi.spyOn(f.adapter, 'appendChunk');
  const key = JSON.stringify([['review', 'picture'], 'video']);
  try {
    await f.send(1n, 0n, 0);
    expect(retained).toEqual([key]);
    expect(append.mock.calls[0]?.[2]).toBe('video');
    expect(append.mock.calls[0]?.[5]).toBe(key);
    await f.send(2n, 0n, 60, true); await vi.advanceTimersByTimeAsync(1500);
    expect(f.output()).toEqual([0]);
    await f.send(1n, 1n, 20); await f.send(1n, 2n, 40, true);
    expect(f.output()).toEqual([0, 20, 40, 60]);
    expect(retained.every(value => value === key)).toBe(true);
    expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
  } finally { await f.destroy(); }
});

it.each(['reset', 'destroy'] as const)('a receiving callback %s retires the original receipt without borrowing the fresh generation', async mode => {
  let armed = false, reset = false, destroying: Promise<void> | undefined;
  const f = await fixture({ largestProvider: true, onRelease: () => {}, onRetain: player => {
    if (!armed || reset) return;
    reset = true;
    if (mode === 'destroy') destroying = player.destroy();
    else { player.play(); player.pause(); player.play(); }
  } });
  const stages: MediaStageObservation[] = [], receipts: ObjectReceipt[] = [];
  const removeStages = f.player.observeMediaStages(event => { stages.push(event); }, { createTracker: createMediaDiagnostics });
  const removeReceipts = f.client.observeObjectReceipts(event => {
    if (event.origin === 'subgroup') receipts.push(event.receipt);
  });
  try {
    await f.send(1n, 0n, 0, true);
    expect(f.output()).toEqual([0]);
    const before = stages.length;
    armed = true;
    await f.send(2n, 0n, 20);
    expect(reset).toBe(true); expect(f.output()).toEqual([0]);
    expect(receipts).toHaveLength(2);
    if (mode === 'destroy') {
      await destroying;
      expect(stages.slice(before)).toEqual([]);
    } else {
      expect(stages.slice(before)).toEqual([{ unit: null, inputs: [receipts[1]], stage: 'discarded', reason: 'route retired' }]);
      await f.send(3n, 0n, 20, true);
      expect(f.output()).toEqual([0, 20]);
      const fresh = stages.filter(event => event.inputs.includes(receipts[2]!));
      expect(fresh.map(event => event.stage)).toEqual(['reconstructed', 'appended']);
      expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
    }
  } finally { removeReceipts(); removeStages(); await f.destroy(); }
});

it.each(['datagram', 'stream'] as const)('real stream-zero FIN waits only its own accepted work while a %s transform is held', async mode => {
  let release!: () => void, started = false, releases = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ onRelease: () => { releases++; }, transform: obj => {
    if (obj.kind === 'data' && obj.groupId === 1n && obj.objectId === 1n) {
      started = true; return gate.then(() => obj);
    }
    return obj;
  } });
  const ids: bigint[] = [];
  const stop = f.client.observeQlogEvents(event => {
    if (event.type === 'subgroup_header_parsed') ids.push(event.stream_id);
  });
  try {
    // Mixed delivery is valid; this stream does not declare END_OF_GROUP.
    await f.send(1n, 0n, 0, false, 0n, false);
    expect(f.output()).toEqual([0]); expect(ids).toEqual([0n]); expect(releases).toBe(0);
    if (mode === 'stream') await f.send(1n, 1n, 20, false, 0n, false);
    else {
      const payload = buildChunk({ trackId: 1, bmdt: 20n,
        samples: [{ duration: 20, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(1, 1, 3, 4) });
      await f.server.sendDatagram(10n, 1n, 1n, payload); await settle();
    }
    expect(started).toBe(true);
    await f.close(1n); await settle();
    expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
    expect(releases).toBe(mode === 'datagram' ? 1 : 0);
    release(); await settle();
    expect(releases).toBe(1); expect(f.output()).toEqual([0, 20]);
    expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
  } finally { release(); stop(); await settle(); await f.destroy(); }
});
