import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControlCodec, encodeSubgroupHeader18, encodeSubgroupObject18, type MoqtObject } from '../../packages/transport/src/index.js';
import { MoqtConnection } from '../../packages/webtransport/src/index.js';
import { TransportSim, flush } from '../../packages/webtransport/src/testkit/stream-sim.js';
import { createLoopback } from '../../packages/webtransport/src/testkit/loopback.js';
import { createMediaDiagnostics } from '../../packages/player/src/media-diagnostics.js';
import type { MediaAppendObserver, MediaStageObserver, MediaStageObservation, PlayerDiagnosticSnapshot } from '../../packages/player/src/index.js';
import { createGroupTailProbe, type GroupTailProbe, type GroupTailSnapshot, type TailCatalogIdentity } from './group-tail.mjs';
import { assessTailRetention, assessTailStimulus, assessTailDiagnostics } from './group-tail-check.mjs';
import { buildInit, buildChunk, SYNC_FLAGS } from '../../packages/locmaf/test-support/cmaf.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.useRealTimers(); });
const bytes = (at = 0) => buildChunk({ trackId: 1, bmdt: BigInt(at), samples: [{ duration: 500, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(1, 2, 3, 4) });
function surface(probe: GroupTailProbe, terminal?: (token: object) => void) {
  const calls: unknown[][] = [], observers = new Set<MediaAppendObserver>();
  class NativeBuffer extends EventTarget {
    timestampOffset = 0; updating = false;
    buffered = { length: 1, start: () => 0, end: () => 7 };
    failure: Error | undefined;
    appendBuffer(...args: unknown[]) { calls.push(args); if (this.failure) throw this.failure; this.updating = true; }
    complete() { this.dispatchEvent(new Event('update')); this.updating = false; this.dispatchEvent(new Event('updateend')); }
  }
  class NativeSource { addSourceBuffer(_mime: string) { return new NativeBuffer(); } }
  probe.installNative(NativeSource as unknown as typeof MediaSource, NativeBuffer as unknown as typeof SourceBuffer);
  let buffer: NativeBuffer;
  const submitted: unknown[][] = [];
  const source = {
    initialize(_config: unknown) { buffer = new NativeSource().addSourceBuffer('video/mp4'); },
    observeAppends(observer: MediaAppendObserver) { observers.add(observer); return () => { observers.delete(observer); }; },
    appendChunk(...args: unknown[]) { submitted.push(args); buffer.appendBuffer((args[1] as Uint8Array).buffer);
      if (terminal && typeof args[4] === 'object' && args[4] !== null) terminal(args[4]); return 'delegated'; },
  };
  probe.wrapSource(source as unknown as Parameters<GroupTailProbe['wrapSource']>[0]);
  source.initialize({ video: { codec: 'avc1.640028', initData: buildInit({ trackId: 1, timescale: 1000, handler: 'vide' }) } });
  return { source, submitted, calls, observers, buffer: () => buffer! };
}
function diagnostics(probe: GroupTailProbe) {
  let listener: MediaStageObserver | undefined;
  const snapshot: PlayerDiagnosticSnapshot = { destroyed: false, state: 'idle', connections: [], tracks: [], subscriptions: [],
    mediaStages: { evidenceLossCount: 0, unattributedInputCount: 0, unobservableAppendCount: 0,
      unobservableVideoCount: 0, unobservableAudioCount: 0, refusedReconstructionCount: 0,
      refusedVideoCount: 0, refusedAudioCount: 0, inputAdmissionRefusalCount: 0 } };
  const off = vi.fn(() => { listener = undefined; });
  let current = snapshot;
  const source = { observeMediaStages: vi.fn((fn: MediaStageObserver) => { listener = fn; return off; }),
    diagnosticSnapshot: () => current };
  probe.observeDiagnostics(source, createMediaDiagnostics);
  return { source, snapshot, off, setSnapshot(value: PlayerDiagnosticSnapshot) { current = value; },
    emit(event: MediaStageObservation) { void listener?.(event); } };
}
async function connection(probe: GroupTailProbe, name = 'video-360') {
  const conn = new MoqtConnection(18), transport = new TransportSim(), codec = createControlCodec(18);
  probe.connection(conn);
  const deliveries: MoqtObject[] = [];
  conn.onObject = vi.fn((_stream, object) => { deliveries.push(object); }); conn.onMessage = vi.fn(); conn.onStreamClosed = vi.fn();
  transport.openIncomingUni().push(codec.encode({ type: 'SETUP', setupOptions: new Map() }));
  await conn.connect(transport);
  const requestId = await conn.subscribe([new TextEncoder().encode('live')], new TextEncoder().encode(name));
  transport.bidi[0]!.push(codec.encode({ type: 'SUBSCRIBE_OK', requestId, trackAlias: 0n, parameters: new Map(), trackExtensions: new Map() }));
  await flush(100); cleanups.push(() => conn.close());
  const object = (group: number, index: number) => ({ kind: 'data', trackAlias: 0n, groupId: BigInt(group), objectId: BigInt(index),
    subgroupId: 0n, publisherPriority: 128, payload: bytes(group * 6000 + index * 500) } as const);
  let stream: ReturnType<TransportSim['openIncomingUni']>;
  const receipt = async (obj: ReturnType<typeof object>, end = false) => {
    deliveries.length = 0; stream = transport.openIncomingUni();
    stream.push(encodeSubgroupHeader18({ typeByte: end ? 0x58 : 0x50, trackAlias: obj.trackAlias, groupId: obj.groupId, subgroupId: obj.subgroupId,
      publisherPriority: 128, hasExtensions: false, isEndOfGroup: end, isFirstObjectInSubgroup: true }));
    stream.push(encodeSubgroupObject18({ objectId: obj.objectId, payload: obj.payload, extensions: undefined, status: undefined }, false, 0n, true));
    await flush(100);
    const delivered = deliveries.at(-1);
    if (!delivered) throw new Error('Expected actual public onObject delivery');
    return delivered;
  };
  const token = (obj: MoqtObject) => { const value = conn.objectReceiptFor(obj); if (!value) throw new Error('Missing public receipt'); return value; };
  return { conn, object, receipt, token, async fin() { stream.closeReadable(); await flush(100); } };
}

describe('tail stimulus and observational delegation', () => {
  it('delegates a missing token without adding an argument or registering an append observer', () => {
    const probe = createGroupTailProbe(); const f = surface(probe);
    const observe = f.source.observeAppends;
    f.source.appendChunk('video', bytes(), 'video-360', 1n);
    expect(f.submitted[0]).toHaveLength(4);
    expect(f.source.observeAppends).toBe(observe);
    probe.restore();
  });
  it('leaves the engine append observer method untouched', () => {
    const probe = createGroupTailProbe();
    const source = { initialize() {}, appendChunk() {}, observeAppends: vi.fn(() => () => {}) };
    const observe = source.observeAppends;
    probe.wrapSource(source as unknown as Parameters<GroupTailProbe['wrapSource']>[0]);
    expect(source.observeAppends).toBe(observe);
    expect(observe).not.toHaveBeenCalled();
    probe.restore();
  });
  it('holds a single exact object across a successor and FIN, then returns the same object and bytes', async () => {
    vi.useFakeTimers();
    const probe = createGroupTailProbe({ now: () => Date.now() });
    const f = surface(probe), c = await connection(probe);
    probe.arm('held'); await c.receipt(c.object(7, 0));
    const original = await c.receipt(c.object(7, 11));
    const promise = Promise.resolve(probe.transform(original));
    let settled = false; void promise.then(() => { settled = true; });
    await c.fin();
    await vi.advanceTimersByTimeAsync(500); await c.receipt(c.object(8, 0));
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await promise).toBe(original);
    expect((await promise)?.kind === 'data' && (await promise) === original).toBe(true);
    await probe.settleHashes();
    expect(assessTailStimulus(probe.snapshot())).toEqual({ passed: true, failures: [] });
    expect(f.submitted).toEqual([]);
    probe.restore(); expect(vi.getTimerCount()).toBe(0);
  });
  it('settles cancellation once with null and never admits an object after destruction', async () => {
    vi.useFakeTimers();
    const probe = createGroupTailProbe({ now: () => Date.now() }); surface(probe); const c = await connection(probe);
    probe.arm('held'); await c.receipt(c.object(0, 0));
    const promise = Promise.resolve(probe.transform(await c.receipt(c.object(0, 11))));
    const completed = vi.fn(); void promise.then(completed);
    probe.cancel(); probe.cancel();
    expect(await promise).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(completed).toHaveBeenCalledTimes(1);
    expect(probe.snapshot().target?.cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0); probe.restore();
  });
  it('judges the actual transform return, not merely timely timer execution', async () => {
    let clock = 0, fire!: () => void;
    const probe = createGroupTailProbe({ now: () => clock, schedule: callback => { fire = callback; return 1; }, unschedule() {} });
    surface(probe); const c = await connection(probe);
    probe.arm('held'); await c.receipt(c.object(0, 0));
    const promise = Promise.resolve(probe.transform(await c.receipt(c.object(0, 11))));
    await c.fin(); clock = 500; await c.receipt(c.object(1, 0));
    clock = 1500; fire(); clock = 2100; await promise; await probe.settleHashes();
    expect(assessTailStimulus(probe.snapshot()).failures).toContain('stimulus-deadline'); probe.restore();
  });
  it('passes ordinary objects through synchronously and permits only one arm', async () => {
    const probe = createGroupTailProbe(); surface(probe); const c = await connection(probe);
    probe.arm('ordinary'); await c.receipt(c.object(1, 0)); const tail = await c.receipt(c.object(1, 11));
    expect(probe.transform(tail)).toBe(tail);
    expect(() => probe.arm('held')).toThrow('exactly once'); probe.restore();
  });
  it('preserves an engine token, delegates native bytes by identity, and requires native update/updateend', async () => {
    const probe = createGroupTailProbe(); const d = diagnostics(probe), c = await connection(probe);
    const input = c.token(await c.receipt(c.object(1, 0))), data = bytes(), token = {};
    const f = surface(probe, unit => d.emit({ unit, inputs: [input], stage: 'appended', reason: null }));
    d.emit({ unit: token, inputs: [input], stage: 'reconstructed', reason: null });
    expect(f.source.appendChunk('video', data, 'video-360', 1n, token)).toBe('delegated');
    expect(f.submitted[0]).toEqual(['video', data, 'video-360', 1n, token]);
    expect(f.submitted[0]![1]).toBe(data); expect(f.calls[0]![0]).toBe(data.buffer);
    expect(probe.snapshot().operations[0]?.updateendAtMs).toBeNull();
    f.buffer().complete(); await probe.settleHashes();
    const snapshot = probe.snapshot();
    expect(snapshot.submissions[0]!.unit).not.toBeNull();
    expect(snapshot.submissions[0]!.outcome?.state).toBe('appended');
    expect(snapshot.errors).toEqual([]); expect(f.observers.size).toBe(0);
    expect(snapshot.submissions[0]!.sha256).toBe(snapshot.operations[0]!.sha256);
    expect(snapshot.operations[0]!.updateAtMs).not.toBeNull(); expect(snapshot.operations[0]!.updateendAtMs).not.toBeNull();
    probe.restore();
  });
  it('preserves the engine observer and does not manufacture a missing append token', () => {
    const probe = createGroupTailProbe(); const f = surface(probe);
    const observe = f.source.observeAppends;
    const off = f.source.observeAppends(() => {});
    f.source.appendChunk('video', bytes(), 'video-360', 1n);
    expect(f.submitted[0]).toHaveLength(4); expect(f.source.observeAppends).toBe(observe);
    expect(f.observers.size).toBe(1);
    expect(probe.snapshot().losses.missingToken).toBe(1);
    expect(probe.snapshot().submissions[0]!.outcome).toBeNull();
    off(); probe.restore();
  });
  it('does not let a rejected second native append steal the first operation completion', () => {
    const probe = createGroupTailProbe(); const f = surface(probe);
    f.source.appendChunk('video', bytes(), 'video-360', 1n);
    f.buffer().failure = new Error('already updating');
    expect(() => f.source.appendChunk('video', bytes(500), 'video-360', 1n)).toThrow('already updating');
    f.buffer().failure = undefined; f.buffer().complete();
    const operations = probe.snapshot().operations;
    expect(operations[0]!.updateAtMs).not.toBeNull();
    expect(operations[0]!.updateendAtMs).not.toBeNull();
    expect(operations[1]!.updateendAtMs).toBeNull();
    probe.restore();
  });
  it('propagates the actual native exception and restores original prototype functions', () => {
    const probe = createGroupTailProbe(); const f = surface(probe), failure = new Error('native append failed');
    f.buffer().failure = failure;
    expect(() => f.source.appendChunk('video', bytes(), 'video-360', 1n)).toThrow(failure);
    expect(probe.snapshot().operations[0]!.error).toContain('native append failed'); probe.restore();
  });
});

async function heldFixture() {
  let clock = 1000;
  let release: () => void = () => { throw new Error('Expected held transform'); };
  const probe = createGroupTailProbe({ now: () => clock, schedule: callback => { release = callback; return 1; }, unschedule() {} });
  cleanups.push(() => probe.restore());
  const d = diagnostics(probe), c = await connection(probe);
  let nextInputs: MediaStageObservation['inputs'] = [];
  const f = surface(probe, unit => d.emit({ unit, inputs: nextInputs, stage: 'appended', reason: null }));
  await probe.settleObservations('baseline-settled');
  probe.arm('held'); await c.receipt(c.object(7, 0));
  const target = await c.receipt(c.object(7, 11)), pending = Promise.resolve(probe.transform(target));
  await c.fin(); clock = 1500;
  const successor = await c.receipt(c.object(8, 0)); nextInputs = [c.token(successor)];
  const unit = {}; clock = 1800;
  d.emit({ unit, inputs: nextInputs, stage: 'reconstructed', reason: null });
  f.source.appendChunk('video', bytes(48000), 'video-360', 8n, unit); f.buffer().complete();
  clock = 2500; release(); expect(await pending).toBe(target); clock = 2501;
  return { probe, d, c, f, target, successor, input: c.token(target) };
}

const fixtureCatalog: TailCatalogIdentity = { namespace: ['tail-proof', 'catalog-scope'], name: 'catalog' };
async function catalogFetchFixture(options: { expected?: TailCatalogIdentity | null;
  actual?: { namespace: readonly string[]; name: string }; standalone?: boolean;
  receiptMode?: 'native' | 'unavailable'; omitProbeHeader?: boolean; bindAliasZero?: boolean; mediaTailCollision?: boolean } = {}) {
    const expected = options.expected === undefined ? fixtureCatalog : options.expected;
    const identity = options.actual ?? fixtureCatalog;
    const probe = createGroupTailProbe(expected ? { catalogIdentity: expected } : {});
    const { a, b } = createLoopback(), client = new MoqtConnection(18), server = new MoqtConnection(18, { role: 'server' });
    const encode = new TextEncoder();
    const trace: Array<{ seq: number; type: string; requestId?: string; joiningRequestId?: string; stream?: string;
      identity?: typeof identity; receiptPresent?: boolean }> = [];
    const errors: string[] = [];
    let sequence = 0;
    const record = (row: Omit<typeof trace[number], 'seq'>) => { const event = { seq: ++sequence, ...row }; trace.push(event); return event; };
    // Legacy-capability controls hide only actual FETCH observations/tokens.
    // Subgroup receipt behavior and real wire/header delivery stay unchanged.
    const masked = new WeakSet<object>();
    const originalReceipts = client.observeObjectReceipts, originalReceiptFor = client.objectReceiptFor;
    const receiptsSpy = vi.spyOn(client, 'observeObjectReceipts').mockImplementation(function (this: MoqtConnection, listener) {
      return originalReceipts.call(this, event => {
        if (options.receiptMode !== 'native' && event.origin === 'fetch') { masked.add(event.receipt); return; }
        return listener(event);
      });
    });
    const receiptSpy = vi.spyOn(client, 'objectReceiptFor').mockImplementation(function (this: MoqtConnection, object) {
      const receipt = originalReceiptFor.call(this, object);
      return receipt && masked.has(receipt) ? undefined : receipt;
    });
    const qlogs: Array<Parameters<MoqtConnection['observeQlogEvents']>[0]> = [];
    const originalObserve = client.observeQlogEvents;
    const spy = vi.spyOn(client, 'observeQlogEvents').mockImplementation(function (this: MoqtConnection, observer) {
      const probeObserver = qlogs.length === 0; qlogs.push(observer);
      return originalObserve.call(this, event => {
        if (probeObserver && options.omitProbeHeader && event.type === 'fetch_header_parsed') return;
        return observer(event);
      });
    });
    probe.connection(client);
    const off = client.observeQlogEvents(event => {
      if (event.type === 'fetch_header_parsed') record({ type: event.type, stream: String(event.stream_id), requestId: String(event.request_id) });
    });
    const deliveries: Array<{ object: MoqtObject; stream: bigint }> = [];
    client.onObject = (stream, object) => { deliveries.push({ stream, object });
      record({ type: 'onObject', stream: String(stream), receiptPresent: Boolean(client.objectReceiptFor(object)) }); };
    client.onMessage = () => {};
    client.onStreamClosed = stream => { record({ type: 'stream-closed', stream: String(stream) }); };
    client.onError = error => { errors.push(String(error)); }; server.onError = error => { errors.push(String(error)); };
    server.onSubscribe = () => {}; server.onFetch = () => {};
    cleanups.push(async () => { await client.close(); await server.close(); off(); probe.restore(); spy.mockRestore(); receiptSpy.mockRestore(); receiptsSpy.mockRestore(); });
      await Promise.all([client.connect(a), server.connect(b)]);
      const subscription = await client.subscribe(identity.namespace.map(field => encode.encode(field)), encode.encode(identity.name), {
        onRequestId: requestId => { record({ type: 'issued-subscribe', requestId: String(requestId), identity }); },
      });
      await flush(128);
      await server.acceptSubscribe(subscription, options.mediaTailCollision ? 0n : 100n, { parameters: new Map([[0x09n, [{ group: 0n, object: 0n }]]]) });
      await flush(128);
      if (options.bindAliasZero) {
        const other = await client.subscribe([encode.encode('unrelated')], encode.encode('audio-en'));
        await flush(128); await server.acceptSubscribe(other, 0n); await flush(128);
      }
      const onRequestId = (requestId: bigint) => { record({ type: 'issued-fetch', requestId: String(requestId),
        ...(!options.standalone ? { joiningRequestId: String(subscription) } : {}), identity }); };
      const fetch = options.standalone
        ? await client.fetch(identity.namespace.map(field => encode.encode(field)), encode.encode(identity.name), {
          startGroup: 0n, startObject: 0n, endGroup: 1n, endObject: 0n, onRequestId })
        : await client.joiningFetch({ joiningFetchType: 'relative', joiningRequestId: subscription, joiningStart: 0n, onRequestId });
      await flush(128);
      const range = options.standalone ? { endLocation: { group: 1n, object: 0n } } : server.resolveJoiningFetch(fetch);
      await server.acceptFetch(fetch, { endLocation: range.endLocation }); await flush(128);
      if (options.mediaTailCollision) {
        probe.arm('held');
        const live = await server.openSubgroup(0n, 0n, 0n, { publisherPriority: 128 });
        await server.sendObject(live, 0n, bytes()); await flush(128);
        await server.closeSubgroup(live); await flush(128);
      }
      const stream = await server.openFetchStream(fetch);
      await server.sendFetchObject(stream, { groupId: 0n, subgroupId: 0n, objectId: options.mediaTailCollision ? 11n : 0n, publisherPriority: 128,
        payload: encode.encode('{"fixture":"catalog"}') });
      await server.closeFetchStream(stream); await flush(128);
      const issued = trace.find(row => row.type === 'issued-fetch');
      const header = trace.find(row => row.type === 'fetch_header_parsed');
      const callback = trace.find(row => row.type === 'onObject' && row.stream === header?.stream);
      expect(issued).toMatchObject({ requestId: String(fetch), identity,
        ...(!options.standalone ? { joiningRequestId: String(subscription) } : {}) });
      expect(header).toMatchObject({ requestId: String(fetch) });
      expect(callback).toMatchObject({ stream: header?.stream, receiptPresent: options.receiptMode === 'native' });
      expect(issued!.seq).toBeLessThan(header!.seq); expect(header!.seq).toBeLessThan(callback!.seq);
      expect(trace.some(row => row.type === 'stream-closed' && row.stream === header?.stream)).toBe(true);
      const delivered = deliveries.find(row => row.object.kind === 'data' && String(row.stream) === header?.stream);
      if (!delivered) throw new Error('Expected actual FETCH object');
      expect(errors).toEqual([]);
      return { probe, client, server, subscription, fetch, delivered, trace, qlog: qlogs[0]! };
}

describe('catalog FETCH when public receipt capability is unavailable', () => {
  it('does not classify a proven catalog FETCH as missing subgroup-tail evidence', async () => {
    const f = await catalogFetchFixture();
    await f.probe.settleObservations('baseline-settled');
    const snapshot = f.probe.snapshot();
    expect(snapshot.errors, JSON.stringify(f.trace)).toEqual([]);
    expect(snapshot.catalogFetch).toMatchObject({ expectedIdentity: fixtureCatalog, receiptCapability: 'unavailable', unavailableReceiptCount: 1 });
    expect(snapshot.catalogFetch.deliveries[0]).toMatchObject({ requestId: String(f.fetch), stream: String(f.delivered.stream), identity: fixtureCatalog });
    expect(snapshot.receipts).toEqual([]); expect(snapshot.stages).toEqual([]); expect(snapshot.submissions).toEqual([]);
    expect(f.client.objectReceiptFor(f.delivered.object)).toBeUndefined();
  });
  it('also requires explicit identity and a parsed header for a standalone catalog FETCH', async () => {
    const f = await catalogFetchFixture({ standalone: true });
    await f.probe.settleObservations('baseline-settled');
    expect(f.probe.snapshot().errors).toEqual([]);
    expect(f.probe.snapshot().catalogFetch.unavailableReceiptCount).toBe(1);
  });
  it.each(['wrong-namespace', 'collapsed-namespace', 'media-FETCH', 'standalone-media-FETCH', 'no-expected-identity'] as const)(
    'preserves missing-receipt failure for %s on a real FETCH', async defect => {
      const actual = defect === 'wrong-namespace' ? { namespace: ['tail-proof', 'other'], name: 'catalog' }
        : defect === 'collapsed-namespace' ? { namespace: ['tail-proof/catalog-scope'], name: 'catalog' }
        : defect === 'media-FETCH' || defect === 'standalone-media-FETCH' ? { namespace: fixtureCatalog.namespace, name: 'video-360' } : fixtureCatalog;
      const f = await catalogFetchFixture({ actual, ...(defect === 'no-expected-identity' ? { expected: null } : {}),
        ...(defect === 'standalone-media-FETCH' ? { standalone: true } : {}) });
      expect(f.probe.snapshot().catalogFetch.unavailableReceiptCount).toBe(0);
      expect(f.probe.snapshot().losses.missingReceipt).toBe(1);
      expect(f.probe.snapshot().errors).toContain('Object delivery has no exact public receipt');
    });
  it('does not exempt unknown or closed streams even with alias zero and a known catalog request', async () => {
    const f = await catalogFetchFixture();
    f.client.onObject!(f.delivered.stream, { ...f.delivered.object });
    f.client.onObject!(999n, { ...f.delivered.object });
    expect(f.probe.snapshot().catalogFetch.unavailableReceiptCount).toBe(1);
    expect(f.probe.snapshot().losses.missingReceipt).toBe(2);
  });
  it('does not join a header to a different or unknown request (synthetic metadata fault)', async () => {
    const f = await catalogFetchFixture();
    await f.qlog({ type: 'fetch_header_parsed', stream_id: f.delivered.stream, request_id: f.fetch + 100n });
    f.client.onObject!(f.delivered.stream, { ...f.delivered.object });
    expect(f.probe.snapshot().catalogFetch.unavailableReceiptCount).toBe(1);
    expect(f.probe.snapshot().losses.missingReceipt).toBe(1);
  });
  it('does not exempt a refused request merely because it reserved a catalog identity (synthetic metadata fault)', async () => {
    const f = await catalogFetchFixture(), encode = new TextEncoder();
    await expect(f.client.fetch(fixtureCatalog.namespace.map(field => encode.encode(field)), encode.encode(fixtureCatalog.name), {
      startGroup: 0n, startObject: 0n, endGroup: 1n, endObject: 0n,
      onRequestId() { throw new Error('ownership refusal control'); },
    })).rejects.toThrow();
    const refused = f.probe.snapshot().catalogFetch.requests.at(-1)!;
    expect(refused.status).toBe('failed');
    await f.qlog({ type: 'fetch_header_parsed', stream_id: f.delivered.stream, request_id: BigInt(refused.requestId) });
    f.client.onObject!(f.delivered.stream, { ...f.delivered.object });
    expect(f.probe.snapshot().catalogFetch.unavailableReceiptCount).toBe(1);
    expect(f.probe.snapshot().losses.missingReceipt).toBe(1);
  });
  it('does not borrow a FETCH header from a different connection (synthetic callback fault)', async () => {
    const f = await catalogFetchFixture(), other = new MoqtConnection(18);
    f.probe.connection(other); other.onObject = () => {};
    other.onObject(f.delivered.stream, { ...f.delivered.object });
    expect(f.probe.snapshot().catalogFetch.unavailableReceiptCount).toBe(1);
    expect(f.probe.snapshot().losses.missingReceipt).toBe(1);
    await other.close();
  });
  it('still fails an actual subgroup media delivery when its object receipt is unavailable', async () => {
    const probe = createGroupTailProbe({ catalogIdentity: fixtureCatalog }); cleanups.push(() => probe.restore());
    const c = await connection(probe), object = await c.receipt(c.object(1, 0));
    const stream = probe.snapshot().receipts.at(-1)!.stream;
    if (stream === null) throw new Error('Expected actual subgroup stream');
    c.conn.onObject!(BigInt(stream), { ...object });
    expect(probe.snapshot().catalogFetch.unavailableReceiptCount).toBe(0);
    expect(probe.snapshot().losses.missingReceipt).toBe(1);
    expect(probe.snapshot().errors).toContain('Object delivery has no exact public receipt');
  });
});

describe('actual public FETCH receipt capability', () => {
  it.each([false, true])('records direct FETCH receipt/owner identity without borrowing alias zero, standalone=%s', async standalone => {
    const f = await catalogFetchFixture({ receiptMode: 'native', standalone, bindAliasZero: true });
    await f.probe.settleObservations('baseline-settled');
    const snapshot = f.probe.snapshot();
    expect(snapshot.errors).toEqual([]);
    expect(snapshot.catalogFetch.receiptCapability).toBe('available');
    expect(snapshot.catalogFetch.unavailableReceiptCount).toBe(0);
    expect(snapshot.catalogFetch.deliveries).toEqual([]);
    expect(snapshot.receipts).toHaveLength(1);
    expect(snapshot.receipts[0]).toMatchObject({ origin: 'fetch', alias: null, requestId: String(f.fetch),
      stream: String(f.delivered.stream), identity: fixtureCatalog });
    expect(f.client.objectReceiptFor(f.delivered.object)).toBeDefined();
    expect(snapshot.target).toBeNull();
  });
  it('direct receipt proof does not require the legacy fallback catalog identity or header exception', async () => {
    const f = await catalogFetchFixture({ receiptMode: 'native', expected: null, omitProbeHeader: true });
    await f.probe.settleObservations('baseline-settled');
    const snapshot = f.probe.snapshot();
    expect(snapshot.catalogFetch.headers).toEqual([]);
    expect(snapshot.catalogFetch.expectedIdentity).toBeNull();
    expect(snapshot.catalogFetch.unavailableReceiptCount).toBe(0);
    expect(snapshot.receipts[0]).toMatchObject({ origin: 'fetch', requestId: String(f.fetch), stream: String(f.delivered.stream), identity: fixtureCatalog });
    expect(snapshot.errors).toEqual([]);
  });
  it('missing receipt and missing parsed header still fail despite a matching configured catalog identity', async () => {
    const f = await catalogFetchFixture({ omitProbeHeader: true });
    expect(f.probe.snapshot().catalogFetch.unavailableReceiptCount).toBe(0);
    expect(f.probe.snapshot().losses.missingReceipt).toBe(1);
    expect(f.probe.snapshot().errors).toContain('Object delivery has no exact public receipt');
  });
  it('a real media FETCH receipt is retained as FETCH evidence, never subgroup-tail evidence', async () => {
    const actual = {namespace: ['other', 'video'], name: 'video-360'};
    const f = await catalogFetchFixture({ receiptMode: 'native', actual, standalone: true, mediaTailCollision: true });
    surface(f.probe);
    const live = f.probe.snapshot().receipts.find(row => row.origin === 'subgroup');
    expect(live).toMatchObject({alias: '0', group: '0', object: '0', identity: actual});
    expect(f.delivered.object).toMatchObject({trackAlias: 0n, groupId: 0n, objectId: 11n});
    expect(f.probe.transform(f.delivered.object)).toBe(f.delivered.object);
    const snapshot = f.probe.snapshot();
    expect(snapshot.receipts.find(row => row.origin === 'fetch')).toMatchObject({origin: 'fetch', identity: actual, requestId: String(f.fetch)});
    expect(snapshot.target).toBeNull(); expect(snapshot.successor).toBeNull();
    expect(snapshot.catalogFetch.unavailableReceiptCount).toBe(0); expect(snapshot.errors).toEqual([]);
  });
  it('a clone cannot borrow a real FETCH receipt after FIN or use its request tuple as a replacement', async () => {
    const f = await catalogFetchFixture({ receiptMode: 'native' });
    f.client.onObject!(f.delivered.stream, {...f.delivered.object});
    f.client.onObject!(999n, {...f.delivered.object});
    expect(f.probe.snapshot().receipts).toHaveLength(1);
    expect(f.probe.snapshot().catalogFetch.unavailableReceiptCount).toBe(0);
    expect(f.probe.snapshot().losses.missingReceipt).toBe(2);
  });
  it('a callback cannot relocate an exact FETCH receipt to another stream', async () => {
    const f = await catalogFetchFixture({ receiptMode: 'native' });
    f.client.onObject!(999n, f.delivered.object);
    expect(f.probe.snapshot().receipts[0]!.stream).toBe(String(f.delivered.stream));
    expect(f.probe.snapshot().errors).toContain('Object callback disagrees with its exact public FETCH stream');
  });
});

describe('public wire receipts with synthetic stages and native sinks (not native proof)', () => {
  it('requires the exact held receipt, distinguishing another connection with the same numeric tuple', async () => {
    const f = await heldFixture(), other = await connection(f.probe);
    const sameTuple = await other.receipt(other.object(7, 11));
    const differentInput = other.token(sameTuple);
    expect(differentInput).not.toBe(f.input);
    f.d.emit({ unit: null, inputs: [differentInput], stage: 'discarded', reason: 'stale group' });
    await f.probe.settleObservations('observations-settled');
    expect(f.probe.boundarySettled()).toBe(false);
    expect(assessTailRetention(f.probe.snapshot(), healthy, healthy, []).causalLoss).toBe(false);
    f.d.emit({ unit: null, inputs: [f.input], stage: 'discarded', reason: 'stale group' });
    await f.probe.settleObservations('observations-settled');
    expect(f.probe.boundarySettled()).toBe(true);
    expect(assessTailRetention(f.probe.snapshot(), healthy, healthy, [])).toMatchObject({ causalLoss: true });
    expect(f.probe.snapshot().errors).toEqual([]);
  });
  it('does not borrow a receipt from an equal-numbered cloned transform object', async () => {
    const probe = createGroupTailProbe(); cleanups.push(() => probe.restore()); surface(probe);
    const c = await connection(probe); probe.arm('held'); await c.receipt(c.object(1, 0));
    const actual = await c.receipt(c.object(1, 11)), clone = { ...actual };
    expect(probe.transform(clone)).toBe(clone);
    expect(probe.snapshot().target).toBeNull(); expect(probe.snapshot().losses.missingReceipt).toBe(1);
  });
  it('maps audio receipts too and excludes FIN-derived group-end bounds from input records', async () => {
    const probe = createGroupTailProbe(); cleanups.push(() => probe.restore()); const d = diagnostics(probe);
    const c = await connection(probe, 'audio-en');
    const audio = await c.receipt(c.object(1, 0), true); await c.fin();
    const input = c.token(audio), unit = {};
    d.emit({ unit, inputs: [input], stage: 'reconstructed', reason: null });
    d.emit({ unit, inputs: [input], stage: 'discarded', reason: 'paused' });
    expect(probe.snapshot().receipts).toHaveLength(1);
    expect(probe.snapshot().receipts[0]!.identity?.name).toBe('audio-en');
    expect(probe.snapshot().stages[0]!.inputs).toEqual([probe.snapshot().receipts[0]!.seq]);
    expect(probe.snapshot().errors).toEqual([]);
  });
  it('records unavailable input/unit mappings as loss rather than making an input-discard witness', async () => {
    const probe = createGroupTailProbe(); cleanups.push(() => probe.restore()); const d = diagnostics(probe);
    d.emit({ unit: {}, inputs: [{}], stage: 'discarded', reason: 'stale group' });
    await probe.settleObservations('observations-settled');
    expect(probe.snapshot().losses).toMatchObject({ missingReceipt: 1, missingUnit: 1 });
    expect(probe.snapshot().stages[0]).toMatchObject({ unit: -1, inputs: [null] });
    expect(probe.boundarySettled()).toBe(false); expect(assessTailDiagnostics(probe.snapshot()).passed).toBe(false);
  });
  it('keeps observers through teardown and preserves live counters when the destroyed snapshot has no runtime', async () => {
    const f = await heldFixture();
    f.probe.cancel(); expect(f.d.off).not.toHaveBeenCalled();
    f.d.emit({ unit: null, inputs: [f.input], stage: 'discarded', reason: 'transform cancelled' });
    await f.probe.settleObservations('before-player-destroy');
    expect(assessTailDiagnostics(f.probe.snapshot(), 'before-player-destroy').passed).toBe(true);
    f.d.setSnapshot({ destroyed: true, state: 'idle', connections: [], tracks: [], subscriptions: [] });
    await f.probe.settleObservations('after-player-destroy');
    expect(f.d.off).not.toHaveBeenCalled();
    expect(f.probe.snapshot().diagnostics.at(-1)!.counters).toBeNull();
    expect(f.probe.snapshot().stages.at(-1)!.reason).toBe('transform cancelled');
    expect(assessTailDiagnostics(f.probe.snapshot(), 'before-player-destroy').passed).toBe(true);
    f.probe.restore(); f.probe.restore(); expect(f.d.off).toHaveBeenCalledTimes(1);
  });
  it('does not replace a missing diagnostic snapshot with measured zeros', async () => {
    const probe = createGroupTailProbe(); cleanups.push(() => probe.restore()); const d = diagnostics(probe);
    d.setSnapshot({ destroyed: false, state: 'idle', connections: [], tracks: [], subscriptions: [] });
    await probe.settleObservations('before-player-destroy');
    expect(probe.snapshot().diagnostics[0]!.counters).toBeNull();
    expect(assessTailDiagnostics(probe.snapshot(), 'before-player-destroy').passed).toBe(false);
  });
  it('counts bounded-record overflow and refuses qualification', async () => {
    const probe = createGroupTailProbe(); cleanups.push(() => probe.restore()); const d = diagnostics(probe);
    for (let i = 0; i < 1050; i++) d.emit({ unit: null, inputs: [], stage: 'discarded', reason: 'paused' });
    await probe.settleObservations('observations-settled');
    expect(probe.snapshot().stages).toHaveLength(1024); expect(probe.snapshot().errors.length).toBeLessThanOrEqual(32);
    expect(probe.snapshot().losses.overflow).toBeGreaterThan(0); expect(assessTailDiagnostics(probe.snapshot()).passed).toBe(false);
  });
});

function evidence(): GroupTailSnapshot {
  const identity = { name: 'video-360', namespace: ['live'] }, hash = 'a'.repeat(64);
  const target = { seq: 1, atMs: 1000, connection: 1, stream: '111', alias: '0', group: '7', object: '11', identity,
    origin: 'subgroup' as const, subgroup: '0', status: '0', payloadBytes: 100,
    heldAtMs: 1000, releaseIssuedAtMs: 2500, returnedAtMs: 2500, cancelled: false,
    raw: { bmdt: '47500', duration: '500', timescale: 1000, startSec: 47.5, endSec: 48, sha256: 'b'.repeat(64) },
    fin: { atMs: 1010, terminal: 'fin', error: null, whilePending: true } };
  const successor = { seq: 2, atMs: 1500, connection: 1, stream: '200', alias: '0', group: '8', object: '0', identity,
    origin: 'subgroup' as const, subgroup: '0', status: '0', payloadBytes: 100, whileHeld: true };
  const submission = (seq: number, group: string, atMs: number, start: number, nativeOperation: number) => ({ seq, group, atMs,
    mediaType: 'video' as const, trackName: 'video-360', bmdt: String(start * 1000), duration: '500', timescale: 1000,
    startSec: start, endSec: start + 0.5, fingerprint: `100:${seq}`, unit: seq === 3 ? 1 : 2, inputs: [seq === 3 ? 2 : 1], nativeOperation,
    outcome: { atMs: nativeOperation + 2500, state: 'appended' as const, reason: null, stage: seq === 3 ? 12 : 13 }, sha256: hash });
  const operation = (seq: number, submission: number, atMs: number) => ({ seq, submission, atMs, bufferId: 0, mediaType: 'video' as const,
    fingerprint: `100:${submission}`, offset: 0, updatingBefore: false, updateAtMs: atMs + 1, updateendAtMs: atMs + 2,
    error: null, ranges: [[0, 6.5]], sha256: hash });
  return { instrumentation: 'synthetic stage identities; not native proof', armed: true, mode: 'held', target, successor, receipts: [target, successor], errors: [], closed: false,
    catalogFetch: { expectedIdentity: null, receiptCapability: 'unavailable', disclosure: 'synthetic observations',
      unavailableReceiptCount: 0, requests: [], headers: [], deliveries: [] },
    losses: { overflow: 0, missingReceipt: 0, missingUnit: 0, missingToken: 0, changedInputs: 0, duplicateTerminal: 0 },
    diagnostics: [
      { seq: 0, atMs: 900, checkpoint: 'baseline-settled', lifetime: 'before-load-through-player-destroy', destroyed: false,
        counters: { evidenceLossCount: 0, unattributedInputCount: 0, unobservableAppendCount: 0, unobservableVideoCount: 0, unobservableAudioCount: 0,
          refusedReconstructionCount: 0, refusedVideoCount: 0, refusedAudioCount: 0, inputAdmissionRefusalCount: 0 } },
      { seq: 99, atMs: 9000, checkpoint: 'observations-settled', lifetime: 'before-load-through-player-destroy', destroyed: false,
        counters: { evidenceLossCount: 0, unattributedInputCount: 0, unobservableAppendCount: 0, unobservableVideoCount: 0, unobservableAudioCount: 0,
          refusedReconstructionCount: 0, refusedVideoCount: 0, refusedAudioCount: 0, inputAdmissionRefusalCount: 0 } },
    ],
    stages: [
      { seq: 10, atMs: 1500, unit: 1, inputs: [2], stage: 'reconstructed', reason: null },
      { seq: 11, atMs: 2500, unit: 2, inputs: [1], stage: 'reconstructed', reason: null },
      { seq: 12, atMs: 2506, unit: 1, inputs: [2], stage: 'appended', reason: null },
      { seq: 13, atMs: 2503, unit: 2, inputs: [1], stage: 'appended', reason: null },
    ],
    submissions: [submission(3, '8', 1500, 6, 6), submission(4, '7', 2500, 5.5, 5)],
    operations: [operation(5, 4, 2501), operation(6, 3, 2504)] };
}
const healthy = { passed: true, failures: [] };
function lossEvidence() {
  const e = evidence();
  e.submissions = e.submissions.filter(row => !row.inputs.includes(e.target!.seq));
  e.operations = e.operations.filter(row => row.submission === e.submissions[0]!.seq);
  e.stages = e.stages.filter(row => !row.inputs.includes(e.target!.seq));
  e.operations[0]!.atMs = 1800; e.operations[0]!.updateAtMs = 1801; e.operations[0]!.updateendAtMs = 1802;
  e.submissions[0]!.outcome!.atMs = 1802; e.stages.find(row => row.stage === 'appended')!.atMs = 1802;
  e.stages.push({ seq: 14, atMs: 2501, unit: null, inputs: [e.target!.seq], stage: 'discarded', reason: 'stale group' });
  return e;
}
describe('tail oracle fault controls (synthetic observations, not native proof)', () => {
  it('accepts update-backed retention with rebased bytes different from raw input tfdt/hash', () => {
    const result = assessTailRetention(evidence(), healthy, healthy, [[0, 7]]);
    expect(result).toMatchObject({ passed: true, causalLoss: false, failures: [] });
  });
  it('identifies pre-MSE loss through the exact positive input discard and earlier native successor completion', () => {
    const e = lossEvidence();
    expect(assessTailRetention(e, healthy, healthy, [[0, 5.5], [6, 7]])).toMatchObject({ passed: false, causalLoss: true });
    e.stages = e.stages.filter(row => row.unit !== null);
    expect(assessTailRetention(e, healthy, healthy, [[0, 7]]).causalLoss).toBe(false);
  });
  it.each(['receipt', 'reason', 'unit', 'before-return', 'unrelated-error', 'native-sha', 'native-update', 'successor-after-return'] as const)(
    'refuses a negative pass for invalid %s evidence', defect => {
      const e = lossEvidence(), discard = e.stages.at(-1)!;
      if (defect === 'receipt') { e.receipts.push({ ...e.target!, seq: 777 }); discard.inputs = [777]; }
      if (defect === 'reason') discard.reason = 'late segment';
      if (defect === 'unit') discard.unit = 9;
      if (defect === 'before-return') discard.atMs = 2499;
      if (defect === 'unrelated-error') e.errors.push('unrelated probe failure');
      if (defect === 'native-sha') e.operations[0]!.sha256 = 'c'.repeat(64);
      if (defect === 'native-update') e.operations[0]!.updateAtMs = null;
      if (defect === 'successor-after-return') e.operations[0]!.updateendAtMs = 2501;
      expect(assessTailRetention(e, healthy, healthy, [[0, 7]]).causalLoss).toBe(false);
    });
  it.each(['reconstructed', 'submitted', 'native-appended'] as const)('refuses contradictory target %s evidence', contradiction => {
    const e = lossEvidence(), retained = evidence();
    if (contradiction === 'reconstructed') e.stages.push(retained.stages.find(row => row.unit === 2)!);
    else e.submissions.push(retained.submissions[1]!);
    if (contradiction === 'native-appended') { e.operations.push(retained.operations[0]!); e.stages.push(...retained.stages.filter(row => row.unit === 2)); }
    expect(assessTailRetention(e, healthy, healthy, [[0, 7]])).toMatchObject({ causalLoss: false, contradictoryTarget: true });
  });
  it('retains expected tail-loss output failures without accepting unrelated observation errors', () => {
    const e = lossEvidence();
    expect(assessTailRetention(e, healthy, { passed: false, failures: ['picture-frozen', 'audio-missing'] }, []).causalLoss).toBe(true);
    expect(assessTailRetention(e, healthy, { passed: false, failures: ['invalid-observation'] }, []).causalLoss).toBe(false);
  });
  it.each(['missing-snapshot', 'destroyed-runtime', 'missing-counter', 'evidence-loss', 'probe-overflow'] as const)('requires real present zero counters: %s', defect => {
    const e = lossEvidence(), d = e.diagnostics.at(-1)!;
    if (defect === 'missing-snapshot') d.counters = null;
    if (defect === 'destroyed-runtime') d.destroyed = true;
    if (defect === 'missing-counter') d.counters = { evidenceLossCount: 0, unattributedInputCount: 0, unobservableAppendCount: 0 };
    if (defect === 'evidence-loss') d.counters = { ...d.counters!, evidenceLossCount: 1 };
    if (defect === 'probe-overflow') e.losses.overflow = 1;
    expect(assessTailDiagnostics(e).passed).toBe(false);
    expect(assessTailRetention(e, healthy, healthy, [[0, 7]]).causalLoss).toBe(false);
  });
  it.each(['successor', 'fin', 'deadline', 'identity'] as const)('rejects an unqualified %s stimulus', defect => {
    const e = evidence();
    if (defect === 'successor') e.successor!.whileHeld = false;
    if (defect === 'fin') e.target!.fin!.whilePending = false;
    if (defect === 'deadline') e.target!.returnedAtMs = 3100;
    if (defect === 'identity') e.successor!.stream = e.target!.stream;
    expect(assessTailStimulus(e).passed).toBe(false);
    expect(assessTailRetention(e, healthy, healthy, [[0, 7]]).causalLoss).toBe(false);
  });
  it.each(['update', 'error', 'bytes', 'range', 'order', 'picture'] as const)('rejects invalid %s output evidence', defect => {
    const e = evidence();
    if (defect === 'update') e.operations[0]!.updateAtMs = null;
    if (defect === 'error') e.operations[0]!.error = 'native error';
    if (defect === 'bytes') e.operations[0]!.sha256 = 'c'.repeat(64);
    if (defect === 'range') e.operations[1]!.ranges = [[0, 5.5], [6, 7]];
    if (defect === 'order') e.operations[1]!.atMs = 1700;
    expect(assessTailRetention(e, healthy, defect === 'picture' ? { passed: false, failures: ['picture-frozen'] } : healthy, [[0, 7]]).passed).toBe(false);
  });
});
