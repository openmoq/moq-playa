import { describe, expect, it, vi } from 'vitest';
import { createProbeRunner } from './index.js';
import type { ProbeOptions } from './index.js';
import { DiagnosticRegistry } from '@openmoq/devtools';
import { createControlCodec, encodeSubgroupHeader18, encodeSubgroupObject18 } from '@openmoq/transport';
import { decodeMessage } from '@openmoq/devtools-protocol';
import { TransportSim, flush } from '../../webtransport/src/testkit/stream-sim.js';

const config = { url: 'https://relay.test/moq', namespace: ['live', 'show'], draft: 22 } as const;
function transport(protocol = 'moqt-22') {
  const t = Object.assign(new TransportSim(), { protocol });
  t.openIncomingUni().push(createControlCodec(22).encode({ type: 'SETUP', setupOptions: new Map() }));
  return t;
}
const clock = { id: 'test', now: () => 10 };

describe('owner-local Probe lifecycle', () => {
  it('sends draft-16 inbound credit and completes the legacy handshake', async () => {
    const codec = createControlCodec(16);
    const t = Object.assign(new TransportSim(), { protocol: 'moqt-16' });
    const runner = createProbeRunner({ ownerId: 'owner', clock, transportFactory: async () => t });
    const run = runner.start({ ...config, draft: 16 }); await flush(150);
    const setup = codec.decode(t.bidi[0]!.writtenBytes(), 0).message;
    if (setup.type !== 'CLIENT_SETUP') throw new Error('Expected legacy setup');
    expect(Array.from(setup.parameters.get(2n)!)).toEqual([100n]);
    t.bidi[0]!.push(codec.encode({ type: 'SERVER_SETUP', parameters: new Map() }));
    await run.ready; await runner.dispose();
  });

  it('completes draft-18 SETUP without the removed MAX_REQUEST_ID option', async () => {
    const codec = createControlCodec(18);
    const t = Object.assign(new TransportSim(), { protocol: 'moqt-18' });
    t.openIncomingUni().push(codec.encode({ type: 'SETUP', setupOptions: new Map() }));
    const runner = createProbeRunner({ ownerId: 'owner', clock, transportFactory: async () => t });
    const run = runner.start({ ...config, draft: 18 }); await run.ready;
    const setup = codec.decode(t.uniOut[0]!.writtenBytes(), 0).message;
    if (setup.type !== 'SETUP') throw new Error('Expected unified setup');
    expect(setup.setupOptions.has(2n)).toBe(false); await runner.dispose();
  });

  it('is inert until start and completes a real draft-22 SETUP before ready', async () => {
    const t = transport(); const factory = vi.fn<ProbeOptions['transportFactory']>(async () => t);
    const runner = createProbeRunner({ ownerId: 'owner', clock, transportFactory: factory });
    expect(factory).not.toHaveBeenCalled();
    const run = runner.start(config);
    const registry = new DiagnosticRegistry({ sourceKind: 'probe' }); registry.register(run.capture);
    await run.ready;
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]?.[0]).toMatchObject({ url: config.url, protocols: ['moqt-22'] });
    expect(t.uniOut[0]?.writtenBytes()[0]).toBe(0xaf);
    await run.stop(); await run.stop(); await runner.dispose();
    expect(t.closeInfo).toBeDefined();
  });

  it('refuses an unobserved protocol under strict policy without sending SETUP', async () => {
    const t = transport(''); const runner = createProbeRunner({ ownerId: 'owner', clock, transportFactory: async () => t });
    const run = runner.start(config);
    await expect(run.ready).rejects.toThrow(/protocol/i);
    expect(t.uniOut).toHaveLength(0);
    await runner.dispose();
  });

  it('permits only explicit compatibility when the protocol is unobserved', async () => {
    const t = transport(''); const runner = createProbeRunner({ ownerId: 'owner', clock, transportFactory: async () => t });
    const run = runner.start({ ...config, policy: 'compatibility' });
    await run.ready; await run.stop();
  });

  it('stops before a pending factory resolves and closes its late result exactly once', async () => {
    let resolve!: (value: TransportSim) => void;
    const pending = new Promise<TransportSim>(r => { resolve = r; });
    const runner = createProbeRunner({ ownerId: 'owner', clock, transportFactory: () => pending });
    const run = runner.start(config); await flush();
    await run.stop(); await expect(run.ready).rejects.toThrow(/cancel/i);
    const t = transport(); const close = vi.spyOn(t, 'close'); resolve(t); await flush(30);
    expect(close).toHaveBeenCalledOnce(); expect(t.uniOut).toHaveLength(0);
    await runner.dispose();
  });

  it('refuses overlap and invalid target input before another factory call', async () => {
    const factory = vi.fn(async () => transport()); const runner = createProbeRunner({ ownerId: 'owner', clock, transportFactory: factory });
    expect(() => runner.start({ ...config, url: 'https://relay.test/#' })).toThrow();
    const run = runner.start(config); expect(() => runner.start(config)).toThrow(/active/i);
    await run.ready; await run.stop();
    const next = runner.start(config); expect(next.source.runId).not.toBe(run.source.runId);
    await next.ready; await runner.dispose();
  });

  it('rejects a native QUIC result from the WebTransport factory', async () => {
    const t = Object.assign(transport(), { kind: 'quic' as const });
    const runner = createProbeRunner({ ownerId: 'owner', clock, transportFactory: async () => t });
    await expect(runner.start(config).ready).rejects.toThrow(/Probe requires WebTransport/);
    expect(t.uniOut).toHaveLength(0); await runner.dispose();
  });

  it('retires a run when its established transport closes remotely', async () => {
    const first = transport(); let calls = 0;
    const runner = createProbeRunner({ ownerId: 'owner', clock, transportFactory: async () => calls++ === 0 ? first : transport() });
    const run = runner.start(config); await run.ready;
    first.close({ reason: 'Peer close' }); await flush(100);
    const next = runner.start(config); await next.ready; await runner.dispose();
  });

  it('does not dial if Stop is immediate', async () => {
    const factory = vi.fn(async () => transport());
    const runner = createProbeRunner({ ownerId: 'owner', clock, transportFactory: factory });
    const run = runner.start(config); await run.stop();
    await expect(run.ready).rejects.toThrow(/cancel/i); expect(factory).not.toHaveBeenCalled();
    await runner.dispose();
  });

  it('does not admit a successor while transport close is unproven', async () => {
    const t = transport(); Object.defineProperty(t, 'closed', { value: new Promise(() => {}) });
    let calls = 0;
    const runner = createProbeRunner({ ownerId: 'owner', clock, closeTimeoutMs: 10,
      transportFactory: async () => calls++ === 0 ? t : transport() });
    try {
      const run = runner.start(config); await run.ready;
      const stopping = run.stop(); void stopping.catch(() => {}); await flush(100);
      expect(() => runner.start(config)).toThrow(/active/);
      await expect(stopping).rejects.toThrow(/timed out/);
      expect(() => runner.start(config)).toThrow(/active/);
    } finally { await runner.dispose().catch(() => {}); }
  });

  it('preserves namespace fields and waits for the actual subscription response', async () => {
    const t = transport(); const runner = createProbeRunner({ ownerId: 'owner', clock, transportFactory: async () => t });
    const run = runner.start({ ...config, namespace: ['live/show', 'part'], trackHints: ['video'] });
    let ready = false; void run.ready.then(() => { ready = true; }, () => {});
    await flush(150); expect(t.bidi).toHaveLength(1); expect(ready).toBe(false);
    const codec = createControlCodec(22);
    const request = codec.decode(t.bidi[0]!.writtenBytes(), 0).message;
    if (request.type !== 'SUBSCRIBE') throw new Error('Expected SUBSCRIBE');
    expect(request.trackNamespace.map(f => new TextDecoder().decode(f))).toEqual(['live/show', 'part']);
    expect(new TextDecoder().decode(request.trackName)).toBe('video');
    t.bidi[0]!.push(codec.encode({ type: 'SUBSCRIBE_OK', requestId: request.requestId, trackAlias: 7n,
      parameters: new Map([[0x09n, [{ group: 4n, object: 0n }]]]), trackProperties: new Map() }));
    await run.ready; expect(ready).toBe(true);
    const stream = t.openIncomingUni();
    stream.push(encodeSubgroupHeader18({ typeByte: 0x14, trackAlias: 7n, groupId: 9007199254740993n,
      subgroupId: 0n, publisherPriority: 5, hasExtensions: false, isEndOfGroup: false }));
    const payload = new TextEncoder().encode('DO_NOT_RETAIN_THIS_PAYLOAD');
    stream.push(encodeSubgroupObject18({ objectId: 0n, extensions: undefined, payload, status: undefined }, false, 0n, true));
    await flush(100);
    const snapshot = run.capture.attach('inspector', 'snapshot');
    const decoded = decodeMessage(snapshot.snapshot);
    expect(decoded).toMatchObject({ ok: true, message: { facts: expect.arrayContaining([
      expect.objectContaining({ fact: expect.objectContaining({ kind: 'object', groupId: '9007199254740993', payloadBytes: payload.byteLength, independence: 'unknown', streamId: null }) }),
    ]) } });
    expect(snapshot.snapshot).not.toContain('DO_NOT_RETAIN_THIS_PAYLOAD');
    snapshot.lease.close(); await runner.dispose();
  });

  it('closes its transport when its diagnostic capture ends', async () => {
    const t = transport(); const runner = createProbeRunner({ ownerId: 'owner', clock, transportFactory: async () => t });
    const run = runner.start(config); await run.ready;
    run.capture.dispose(); await flush(100);
    expect(t.closeInfo).toBeDefined(); await runner.dispose();
  });

  it('owns factory bookkeeping failures and still closes a returned transport', async () => {
    const t = transport(); const close = vi.spyOn(t, 'close');
    Object.defineProperty(t, 'closed', { get() { throw new Error('closed accessor failed'); } });
    const runner = createProbeRunner({ ownerId: 'owner', clock, transportFactory: async () => t });
    await expect(runner.start(config).ready).rejects.toThrow('closed accessor failed');
    expect(close).toHaveBeenCalledOnce(); expect(t.uniOut).toHaveLength(0);
    await runner.dispose().catch(() => {});
  });

  it('treats a rejected closed promise as a settled failed transport and permits retry', async () => {
    const failure = new Error('Handshake failed');
    const first = Object.assign(transport(), { ready: Promise.reject(failure) });
    Object.defineProperty(first, 'closed', { value: Promise.reject(failure) });
    let calls = 0;
    const runner = createProbeRunner({ ownerId: 'owner', clock, transportFactory: async () => calls++ === 0 ? first : transport() });
    const run = runner.start(config); await expect(run.ready).rejects.toThrow('Handshake failed');
    await expect(run.stop()).resolves.toBeUndefined();
    const inspection = run.capture.attach('inspect', 'inspect');
    const snapshot = decodeMessage(inspection.snapshot);
    if (!snapshot.ok || snapshot.message.kind !== 'snapshot') throw new Error('Expected snapshot');
    expect(snapshot.message.facts.some(o => o.fact.kind === 'failure' && o.fact.stage === 'teardown')).toBe(false);
    inspection.lease.close();
    const next = runner.start(config); await next.ready; await runner.dispose();
  });

  it('bounds a factory that never resolves and closes its late result', async () => {
    let resolve!: (t: TransportSim) => void;
    const pending = new Promise<TransportSim>(r => { resolve = r; });
    const runner = createProbeRunner({ ownerId: 'owner', clock, attemptTimeoutMs: 5, transportFactory: () => pending });
    const run = runner.start(config); await expect(run.ready).rejects.toThrow(/timed out/);
    const snapshot = run.capture.attach('inspect', 'failure');
    expect(decodeMessage(snapshot.snapshot)).toMatchObject({ ok: true, message: { facts: expect.arrayContaining([
      expect.objectContaining({ fact: expect.objectContaining({ kind: 'failure', stage: 'dial', outcome: 'timeout', attribution: 'local' }) }),
    ]) } });
    const t = transport(); const close = vi.spyOn(t, 'close'); resolve(t); await flush(100);
    expect(close).toHaveBeenCalledOnce(); expect(t.uniOut).toHaveLength(0);
    snapshot.lease.close(); await runner.dispose();
  });

  it('bounds transport readiness without writing SETUP', async () => {
    const t = Object.assign(transport(), { ready: new Promise(() => {}) });
    const runner = createProbeRunner({ ownerId: 'owner', clock, attemptTimeoutMs: 5, transportFactory: async () => t });
    await expect(runner.start(config).ready).rejects.toThrow(/timed out/);
    expect(t.uniOut).toHaveLength(0); expect(t.closeInfo).toBeDefined(); await runner.dispose();
  });

  it('bounds SETUP when the peer sends no response', async () => {
    const t = Object.assign(new TransportSim(), { protocol: 'moqt-22' });
    const runner = createProbeRunner({ ownerId: 'owner', clock, attemptTimeoutMs: 5, transportFactory: async () => t });
    const run = runner.start(config); await expect(run.ready).rejects.toThrow(/timed out/);
    expect(t.uniOut.length).toBeGreaterThan(0); expect(t.closeInfo).toBeDefined(); await runner.dispose();
  });
});


describe('Probe object and bound provenance', () => {
  it.each([true, false])('distinguishes a FIN marker from an actual wire status object (derived=%s)', async derived => {
    const t = transport(), codec = createControlCodec(22);
    const runner = createProbeRunner({ ownerId: 'owner', clock, transportFactory: async () => t });
    const run = runner.start({ ...config, trackHints: ['video'] });
    try {
      await flush(150);
      t.bidi[0]!.push(codec.encode({ type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: 7n, parameters: new Map(), trackProperties: new Map() }));
      await run.ready;
      const stream = t.openIncomingUni();
      stream.push(encodeSubgroupHeader18({ typeByte: derived ? 0x58 : 0x50, trackAlias: 7n, groupId: 9n, subgroupId: 0n,
        publisherPriority: 128, hasExtensions: false, isEndOfGroup: derived, isFirstObjectInSubgroup: true }));
      stream.push(encodeSubgroupObject18({ objectId: 0n, payload: Uint8Array.of(1), extensions: undefined, status: undefined }, false, 0n, true));
      if (!derived) stream.push(encodeSubgroupObject18({ objectId: 1n, payload: new Uint8Array(), extensions: undefined, status: 3n }, false, 0n, false));
      stream.closeReadable(); await flush(100);
      const inspection = run.capture.attach('inspect', 'inspect');
      try {
        const decoded = decodeMessage(inspection.snapshot);
        if (!decoded.ok || decoded.message.kind !== 'snapshot') throw new Error('Expected snapshot');
        const facts = decoded.message.facts.map(item => item.fact);
        const objects = facts.filter(fact => fact.kind === 'object'), bounds = facts.filter(fact => fact.kind === 'group_bound');
        if (derived) {
          expect(objects.map(object => object.objectId)).toEqual(['0']);
          expect(bounds).toEqual([expect.objectContaining({ trackAlias: '7', groupId: '9', objectId: '1', bound: 'exclusive', evidence: 'end-of-group' })]);
          expect(bounds[0]).not.toHaveProperty('deliveryId');
        } else {
          expect(objects.map(object => [object.objectId, object.objectStatus])).toEqual([['0', '0'], ['1', '3']]);
          expect(bounds).toEqual([]);
        }
      } finally { inspection.lease.close(); }
    } finally { await runner.dispose(); }
  });
});


it.each([null, 0xffffffffffffffffn])('does not invent or overflow a FIN group bound (last=%s)', async last => {
  const t = transport(), codec = createControlCodec(22);
  const runner = createProbeRunner({ ownerId: 'owner', clock, transportFactory: async () => t });
  const run = runner.start({ ...config, trackHints: ['video'] });
  try {
    await flush(150); t.bidi[0]!.push(codec.encode({ type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: 7n, parameters: new Map(), trackProperties: new Map() }));
    await run.ready;
    const stream = t.openIncomingUni();
    stream.push(encodeSubgroupHeader18({ typeByte: 0x58, trackAlias: 7n, groupId: 9n, subgroupId: 0n,
      publisherPriority: 128, hasExtensions: false, isEndOfGroup: true, isFirstObjectInSubgroup: true }));
    if (last !== null) stream.push(encodeSubgroupObject18({ objectId: last, payload: Uint8Array.of(1), extensions: undefined, status: undefined }, false, 0n, true));
    stream.closeReadable(); await flush(100);
    const inspection = run.capture.attach('inspect', 'inspect');
    try {
      const decoded = decodeMessage(inspection.snapshot);
      if (!decoded.ok || decoded.message.kind !== 'snapshot') throw new Error('Expected snapshot');
      const facts = decoded.message.facts.map(item => item.fact);
      expect(facts.filter(fact => fact.kind === 'group_bound')).toEqual(last === null ? [] : [
        expect.objectContaining({ objectId: String(last), bound: 'inclusive', evidence: 'end-of-group' }),
      ]);
      expect(facts.filter(fact => fact.kind === 'object')).toHaveLength(last === null ? 0 : 1);
    } finally { inspection.lease.close(); }
  } finally { await runner.dispose(); }
});

describe('Probe unattributed delivery disclosure', () => {
  it.each(['receipt', 'origin'] as const)('counts missing %s evidence without inventing object identity, with a valid successor control', async missing => {
    const { MoqtConnection } = await import('@openmoq/webtransport');
    const lookup = MoqtConnection.prototype.objectReceiptFor;
    const observe = MoqtConnection.prototype.observeObjectReceipts;
    let suppress = true;
    const spy = missing === 'receipt'
      ? vi.spyOn(MoqtConnection.prototype, 'objectReceiptFor').mockImplementation(function(this: import('@openmoq/webtransport').MoqtConnection, object) { return suppress ? undefined : lookup.call(this, object); })
      : vi.spyOn(MoqtConnection.prototype, 'observeObjectReceipts').mockImplementation(function(this: import('@openmoq/webtransport').MoqtConnection, observer) {
        return observe.call(this, event => { if (!suppress) return observer(event); });
      });
    const t = transport(), codec = createControlCodec(22);
    const runner = createProbeRunner({ ownerId: 'owner', clock, transportFactory: async () => t });
    const run = runner.start({ ...config, trackHints: ['video'] });
    const inspection = run.capture.attach('inspect', 'inspect');
    try {
      await flush(150);
      t.bidi[0]!.push(codec.encode({ type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: 7n, parameters: new Map(), trackProperties: new Map() }));
      await run.ready;
      const stream = t.openIncomingUni();
      stream.push(encodeSubgroupHeader18({ typeByte: 0x50, trackAlias: 7n, groupId: 9n, subgroupId: 0n,
        publisherPriority: 128, hasExtensions: false, isEndOfGroup: false, isFirstObjectInSubgroup: true }));
      stream.push(encodeSubgroupObject18({ objectId: 0n, payload: Uint8Array.of(1), extensions: undefined, status: undefined }, false, 0n, true));
      await flush(100);
      suppress = false;
      stream.push(encodeSubgroupObject18({ objectId: 1n, payload: Uint8Array.of(2), extensions: undefined, status: undefined }, false, 0n, false));
      await flush(100);
      const snapshot = run.capture.attach('read', 'read');
      try {
        const decoded = decodeMessage(snapshot.snapshot);
        if (!decoded.ok || decoded.message.kind !== 'snapshot') throw Error('Expected snapshot');
        const facts = decoded.message.facts.map(item => item.fact);
        expect(facts.filter(f => f.kind === 'object').map(f => f.objectId)).toEqual(['1']);
        expect(facts.filter(f => f.kind === 'group_bound')).toEqual([]);
        expect(facts.find(f => f.kind === 'metric' && f.name === 'diagnostic_unattributed_deliveries')).toMatchObject({
          value: 1, unit: 'count', trackId: null,
        });
        expect(run.source.capabilities).toContain('metrics');
      } finally { snapshot.lease.close(); }
    } finally { inspection.lease.close(); spy.mockRestore(); await runner.dispose(); }
  });
  it('declares zero unattributed deliveries on a run without object callbacks', async () => {
    const t = transport(), runner = createProbeRunner({ ownerId: 'owner', clock, transportFactory: async () => t });
    const run = runner.start(config); await run.ready;
    const inspection = run.capture.attach('inspect', 'inspect');
    try {
      const decoded = decodeMessage(inspection.snapshot);
      if (!decoded.ok || decoded.message.kind !== 'snapshot') throw Error('Expected snapshot');
      expect(decoded.message.facts.map(e => e.fact).find(f => f.kind === 'metric' && f.name === 'diagnostic_unattributed_deliveries')).toMatchObject({ value: 0 });
    } finally { inspection.lease.close(); await runner.dispose(); }
  });
});
