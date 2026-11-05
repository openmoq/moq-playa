/** Real draft-18 request streams and peer responses; no native output claim. */
import { expect, it, vi } from 'vitest';
import { createControlCodec, varint } from '@openmoq/transport';
import { MoqtConnection } from '../../packages/webtransport/src/index.js';
import { connectedPair, withProtocol } from '../../packages/webtransport/src/testkit/pair.js';
import { createLoopback, flush } from '../../packages/webtransport/src/testkit/loopback.js';
import { observeProgramSwitchWire } from './program-switch-wire-observer.mjs';
import { assessProgramSwitchSubscriptions } from './program-switch.mjs';
import type { ProgramSwitchVariant } from './program-switch.fixture.mjs';

const namespace = ['program', 'one/field', '日本語'];
const enc = new TextEncoder(), ns = () => namespace.map(field => enc.encode(field)), name = () => enc.encode('video');

it('records the exact API identity once only after the real draft-18 peer accepts its request stream', async () => {
  const h = await connectedPair(), sensor = observeProgramSwitchWire(); sensor.connection(h.client);
  const requests: Array<{ id: bigint; namespace: string[]; name: string }> = [];
  h.server.onSubscribe = (id, fields, track) => requests.push({ id, namespace: fields.map(field => new TextDecoder().decode(field)), name: new TextDecoder().decode(track) });
  const owned: bigint[] = [], message = vi.fn(); h.client.onMessage = message;
  try {
    const id = await h.client.subscribe(ns(), name(), { onRequestId: requestId => {
      expect(h.a.bidiOut).toHaveLength(0); owned.push(requestId);
    } });
    await flush(512);
    expect(owned).toEqual([id]); expect(requests).toEqual([{ id, namespace, name: 'video' }]);
    const wire = createControlCodec(18).decode(h.a.bidiOut[0]!.out.writtenBytes(), 0).message;
    expect(wire).toMatchObject({ type: 'SUBSCRIBE', trackNamespace: ns(), trackName: name() });
    expect(sensor.snapshot().subscriptions).toEqual([]);
    await h.server.acceptSubscribe(id, 77n); await flush(512);
    expect(sensor.snapshot()).toEqual({ connections: 1, overflow: false, subscriptions: [
      { timeMs: expect.any(Number), requestId: String(id), namespace, name: 'video' },
    ] });
    sensor.snapshot().subscriptions[0]!.namespace[0] = 'changed snapshot';
    expect(sensor.snapshot().subscriptions[0]!.namespace).toEqual(namespace);
    expect(h.client.onMessage).toBe(message);
    expect(message.mock.calls.filter(([value]) => value.type === 'SUBSCRIBE_OK')).toHaveLength(1);
    expect(h.errors).toEqual([]);
  } finally { sensor.dispose(); await h.client.close(); await h.server.close(); }
});

it.each(['namespace', 'name'] as const)('preserves a leading BOM in the accepted %s identity without passing an unprefixed match', async field => {
  const entry = (name: string, role: 'video' | 'audio', renderGroup: number, altGroup: number) => ({ name, role, renderGroup, altGroup,
    sourceTrack: name, offsetUs: '0', firstPresentationTimeUs: '0', firstLocTimeUs: '0', timescale: 48000, samples: 1,
    compositionOffsetsTicks: [0], durationTicks: [960] });
  const tracks: ProgramSwitchVariant['tracks'] = {
    oldVideo: entry('video-360', 'video', 1, 1), oldAudio: entry('audio-en', 'audio', 1, 2),
    viewVideo: entry('video-view', 'video', 1, 4), nextVideo: entry('video-next', 'video', 2, 11), nextAudio: entry('audio-es-next', 'audio', 2, 12),
  };
  for (const prefix of ['', '\uFEFF']) {
    const h = await connectedPair(), sensor = observeProgramSwitchWire(); sensor.connection(h.client);
    const exactNamespace = [field === 'namespace' ? `${prefix}test` : 'test'];
    const exactNames = ['catalog', tracks.oldVideo.name, tracks.oldAudio.name, tracks.viewVideo.name]
      .map(name => field === 'name' ? `${prefix}${name}` : name);
    const requests: Array<{ namespace: Uint8Array[]; name: Uint8Array }> = [], responses: Promise<void>[] = [];
    h.server.onSubscribe = (id, fields, track) => {
      requests.push({ namespace: fields, name: track });
      responses.push(h.server.acceptSubscribe(id, BigInt(requests.length + 10)));
    };
    try {
      const ids: bigint[] = [];
      for (const track of exactNames) ids.push(await h.client.subscribe(exactNamespace.map(value => enc.encode(value)), enc.encode(track)));
      await flush(512); await Promise.all(responses); await flush(512);
      expect(requests).toEqual(exactNames.map(track => ({ namespace: exactNamespace.map(value => enc.encode(value)), name: enc.encode(track) })));
      const assessment = assessProgramSwitchSubscriptions(sensor.snapshot(), 'test', 'view', tracks);
      expect(assessment.passed).toBe(prefix === '');
      if (prefix === '') expect(assessment.failures).toEqual([]);
      else expect(assessment.failures).toContain('media-subscriptions');
      expect(sensor.snapshot().subscriptions.map(({ requestId, namespace, name }) => ({ requestId, namespace, name })))
        .toEqual(ids.map((id, index) => ({ requestId: String(id), namespace: exactNamespace, name: exactNames[index] })));
      expect(h.errors).toEqual([]);
    } finally { sensor.dispose(); await h.client.close(); await h.server.close(); }
  }
});

it('does not count a peer-refused subscription', async () => {
  const h = await connectedPair(), sensor = observeProgramSwitchWire(); sensor.connection(h.client);
  try {
    const id = await h.client.subscribe(ns(), name()); await flush(512);
    await h.server.rejectSubscribe(id, 0x10n, 'not available'); await flush(512);
    expect(sensor.snapshot()).toEqual({ connections: 1, overflow: false, subscriptions: [] });
  } finally { sensor.dispose(); await h.client.close(); await h.server.close(); }
});

it('preserves a throwing owner callback and emits no request or acceptance', async () => {
  const h = await connectedPair(), sensor = observeProgramSwitchWire(); sensor.connection(h.client);
  const error = new Error('owner declined'), owner = vi.fn(() => { throw error; });
  try {
    await expect(h.client.subscribe(ns(), name(), { onRequestId: owner })).rejects.toBe(error);
    expect(owner).toHaveBeenCalledOnce(); expect(h.a.bidiOut).toEqual([]);
    expect(sensor.snapshot().subscriptions).toEqual([]);
  } finally { sensor.dispose(); await h.client.close(); await h.server.close(); }
});

it('preserves request validation failures without counting or invoking the caller owner callback', async () => {
  const h = await connectedPair(), sensor = observeProgramSwitchWire(); sensor.connection(h.client);
  const owner = vi.fn();
  try {
    await expect(h.client.subscribe(ns(), name(), { terminalDeliveryCompletion: 'streams', onRequestId: owner })).rejects.toThrow(/require/);
    expect(owner).not.toHaveBeenCalled(); expect(h.a.bidiOut).toEqual([]);
    expect(sensor.snapshot().subscriptions).toEqual([]);
  } finally { sensor.dispose(); await h.client.close(); await h.server.close(); }
});

it('preserves all encoded subscription options and application message callback ownership', async () => {
  const h = await connectedPair(), sensor = observeProgramSwitchWire(); sensor.connection(h.client);
  const owner = vi.fn(), drained = vi.fn(), message = vi.fn(); h.client.onMessage = message;
  try {
    const id = await h.client.subscribe(ns(), name(), { onRequestId: owner, subscriberPriority: varint(73), groupOrder: varint(2),
      deliveryTimeout: varint(250), terminalDelivery: 'drain', terminalDeliveryCompletion: 'streams',
      terminalDeliveryStatuses: [2n], onDrained: drained });
    await flush(512);
    const frame = createControlCodec(18).decode(h.a.bidiOut[0]!.out.writtenBytes(), 0).message;
    expect(frame.type).toBe('SUBSCRIBE');
    if (frame.type !== 'SUBSCRIBE') throw new Error('No SUBSCRIBE frame');
    expect(frame.parameters.get(0x20n)).toEqual([73n]);
    expect(frame.parameters.get(0x22n)).toEqual([2n]);
    expect(frame.parameters.get(0x02n)).toEqual([250n]);
    expect(owner).toHaveBeenCalledExactlyOnceWith(id);
    await h.server.acceptSubscribe(id, 77n); await flush(512);
    expect(h.client.onMessage).toBe(message); expect(drained).not.toHaveBeenCalled();
    const stream = await h.server.openSubgroup(77n, 0n, 0n);
    await h.server.sendObject(stream, 0n, Uint8Array.of(1)); await h.server.closeSubgroup(stream); await flush(512);
    await h.server.publishDone(id, varint(2n), 'finished'); await flush(512);
    expect(drained).toHaveBeenCalledExactlyOnceWith(id);
    expect(h.errors).toEqual([]);
  } finally { sensor.dispose(); await h.client.close(); await h.server.close(); }
});

it('does not count an allocated request when opening its transport request stream fails', async () => {
  const { a, b } = createLoopback(), client = new MoqtConnection(18), server = new MoqtConnection(18, { role: 'server' });
  const failure = new Error('request stream unavailable');
  // Real SETUP and peer, with one explicit public WebTransport failure boundary.
  const transport = { ...withProtocol(a, 'moqt-18'), createBidirectionalStream: async () => { throw failure; } };
  await Promise.all([client.connect(transport), server.connect(b)]);
  const sensor = observeProgramSwitchWire(); sensor.connection(client);
  const owner = vi.fn();
  try {
    await expect(client.subscribe(ns(), name(), { onRequestId: owner })).rejects.toBe(failure); await flush(512);
    expect(owner).toHaveBeenCalledOnce(); expect(sensor.snapshot().subscriptions).toEqual([]);
    expect(a.bidiOut).toHaveLength(0);
  } finally { sensor.dispose(); await client.close(); await server.close(); }
});

it('ignores peer ACKs for requests admitted before observation and distinguishes equal names in different namespace tuples', async () => {
  const h = await connectedPair(), sensor = observeProgramSwitchWire();
  try {
    const earlier = await h.client.subscribe([enc.encode('unobserved')], name());
    sensor.connection(h.client);
    const first = await h.client.subscribe(ns(), name());
    const secondNamespace = ['program/one', 'field', '日本語'];
    const second = await h.client.subscribe(secondNamespace.map(field => enc.encode(field)), name()); await flush(512);
    await h.server.acceptSubscribe(earlier, 10n); await h.server.acceptSubscribe(second, 12n); await h.server.acceptSubscribe(first, 11n);
    await flush(512);
    expect(sensor.snapshot().subscriptions.map(({ requestId, namespace, name }) => ({ requestId, namespace, name }))).toEqual([
      { requestId: String(second), namespace: secondNamespace, name: 'video' },
      { requestId: String(first), namespace, name: 'video' },
    ]);
    expect(h.errors).toEqual([]);
  } finally { sensor.dispose(); await h.client.close(); await h.server.close(); }
});

it('correlates an immediately accepting real peer without depending on subscribe promise/ACK ordering', async () => {
  const h = await connectedPair(), sensor = observeProgramSwitchWire(); sensor.connection(h.client);
  const responses: Promise<void>[] = [];
  h.server.onSubscribe = id => { responses.push(h.server.acceptSubscribe(id, 77n)); };
  try {
    const id = await h.client.subscribe(ns(), name()); await flush(512); await Promise.all(responses); await flush(512);
    expect(sensor.snapshot().subscriptions).toEqual([
      { timeMs: expect.any(Number), requestId: String(id), namespace, name: 'video' },
    ]);
    expect(h.errors).toEqual([]);
  } finally { sensor.dispose(); await h.client.close(); await h.server.close(); }
});

it.each(['pending', 'refused'] as const)('bounds the entire admission history at 64 with %s requests and discloses overflow', async mode => {
  const h = await connectedPair(), sensor = observeProgramSwitchWire(); sensor.connection(h.client);
  const ids: bigint[] = [], peerRequests: bigint[] = [];
  h.server.onSubscribe = id => { peerRequests.push(id); };
  try {
    for (let index = 0; index < 65; index++) {
      const id = await h.client.subscribe(ns(), enc.encode(`track-${index}`)); ids.push(id); await flush(64);
      if (mode === 'refused' && index < 64) { await h.server.rejectSubscribe(id, 0x10n, 'not available'); await flush(64); }
    }
    expect(peerRequests).toEqual(ids);
    expect(sensor.snapshot()).toEqual({ connections: 1, overflow: true, subscriptions: [] });
    for (const [index, id] of ids.entries()) {
      if (mode === 'pending' || index === 64) { await h.server.acceptSubscribe(id, BigInt(index + 1)); await flush(64); }
    }
    expect(sensor.snapshot().overflow).toBe(true);
    expect(sensor.snapshot().subscriptions).toHaveLength(mode === 'pending' ? 64 : 0);
    expect(sensor.snapshot().subscriptions.some(item => item.requestId === String(ids[64]))).toBe(false);
    expect(h.errors).toEqual([]);
  } finally { sensor.dispose(); await h.client.close(); await h.server.close(); }
});

it('disposes pending observation without changing application callbacks or accepting late ACKs', async () => {
  const h = await connectedPair(), sensor = observeProgramSwitchWire(), original = h.client.subscribe;
  const message = vi.fn(); h.client.onMessage = message;
  sensor.connection(h.client);
  try {
    const first = await h.client.subscribe(ns(), name()); await flush(512);
    expect(sensor.snapshot().subscriptions).toEqual([]); expect(h.client.subscribe).not.toBe(original);
    sensor.dispose(); sensor.dispose(); expect(h.client.subscribe).toBe(original);
    await h.server.acceptSubscribe(first, 11n); await flush(512);
    const second = await h.client.subscribe(ns(), enc.encode('audio')); await flush(512);
    await h.server.acceptSubscribe(second, 12n); await flush(512);
    expect(sensor.snapshot()).toEqual({ connections: 1, overflow: false, subscriptions: [] });
    expect(h.client.onMessage).toBe(message);
    expect(message.mock.calls.filter(([value]) => value.type === 'SUBSCRIBE_OK')).toHaveLength(2);
    expect(h.errors).toEqual([]);
  } finally { sensor.dispose(); await h.client.close(); await h.server.close(); }
});
