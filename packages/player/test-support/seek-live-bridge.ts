import { afterEach, expect, vi } from 'vitest';
import { MessageParam, varint, writeLocation, locationEncodingLength,
  type Parameters as MessageParameters, type ControlMessage, type MoqtObject, type ObjectDatagram, type TrackProperties } from '@openmoq/transport';
import { MoqtConnection, type TrackSubscription } from '@openmoq/webtransport';
import { createLoopback } from '../../webtransport/src/testkit/loopback.js';
import { flush } from '../../webtransport/src/testkit/stream-sim.js';
import { SeekLiveBridge, type SeekLiveBoundary } from '../src/seek-live-bridge.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = async () => { await flush(200); if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await new Promise<void>(resolve => setTimeout(resolve, 0)); await flush(200); };
const connections: MoqtConnection[] = [];
afterEach(async () => { for (const c of connections.splice(0)) await c.close(); vi.useRealTimers(); });

async function fixture(draft: 14 | 16 | 18 | 22, options: {
  observation?: NonNullable<ConstructorParameters<typeof SeekLiveBridge>[1]['liveObservation']>;
  early?: boolean; head?: { groupId: bigint; objectId: bigint } | null;
  admit?: ReturnType<typeof deferred<boolean>>; work?: ReturnType<typeof deferred<void>>;
  install?: ReturnType<typeof deferred<void>>; maxObjects?: number; delayDatagrams?: boolean;
  subscribeProperties?: TrackProperties; joinProperties?: TrackProperties;
  onAccepted?: (boundary: SeekLiveBoundary) => void;
  subscription?: (sub: TrackSubscription) => TrackSubscription;
} = {}) {
  const { a, b } = createLoopback();
  const heldDatagrams: Uint8Array[] = [];
  if (options.delayDatagrams) b.datagrams.writable = new WritableStream<Uint8Array>({ write(bytes) { heldDatagrams.push(bytes.slice()); } });
  const client = new MoqtConnection(draft, { terminatedAliasTtlMs: 50 }), server = new MoqtConnection(draft, { role: 'server' });
  connections.push(client, server);
  const transportErrors: Error[] = [], errors: Error[] = [], deferredProbe = vi.fn(), ended = vi.fn();
  client.onError = server.onError = error => transportErrors.push(error);
  const credit = draft < 18 ? { maxRequestId: varint(100n) } : {};
  await Promise.all([client.connect(a, credit), server.connect(b, credit)]);
  if (options.subscription) {
    const subscribe = client.subscribeTrack.bind(client);
    vi.spyOn(client, 'subscribeTrack').mockImplementation(async (...args) => options.subscription!(await subscribe(...args)));
  }
  const head = options.head === undefined ? { groupId: 3n, objectId: 2n } : options.head;
  server.setLargestLocationProvider(() => head && ({ group: head.groupId, object: head.objectId }));
  let current = true;
  const abort = new AbortController(), received: string[] = [], rawInputs: Array<MoqtObject | ObjectDatagram> = [], discarded: object[] = [];
  const accepted: SeekLiveBoundary[] = [], boundaries: SeekLiveBoundary[] = [];
  const order: string[] = [], requests: Array<{ id: bigint; message: ControlMessage }> = [], joins: bigint[] = [];
  const generic: MoqtObject[] = [], datagrams: ObjectDatagram[] = [], livePayloads: number[][] = [];
  let subId = -1n, prefixStream = -1n;
  const bridge = new SeekLiveBridge(client, {
    track: { namespace: ['a/b', '雪'], name: 'v/one' }, start: { groupId: 3n, objectId: 1n },
    maxObjects: options.maxObjects ?? 20, maxBytes: 1024, isCurrent: () => current, signal: abort.signal,
    admitHead: async () => options.admit ? options.admit.promise : true,
    ...(options.observation ? { liveObservation: options.observation } : {}),
    capture: object => { rawInputs.push(object); return { original: object }; },
    onDiscard: input => { discarded.push(input); },
    consumePrefix: async (object, _input, admitted) => {
      order.push(`prefix:${object.objectId}:start`); await options.work?.promise;
      if (admitted()) { received.push(`prefix:${object.objectId}`); order.push(`prefix:${object.objectId}:end`); }
    },
    consumeLive: async (object, _input, admitted) => {
      await options.work?.promise; if (admitted()) { received.push(`live:${object.objectId}`); if (object.kind === 'data') livePayloads.push([...object.payload]); }
    },
    onPrefixAccepted: boundary => { accepted.push(boundary); options.onAccepted?.(boundary); },
    onPrefixDrained: async boundary => { order.push('install:start'); await options.install?.promise; boundaries.push(boundary); order.push('install:end'); },
    onTrackEnded: async () => { ended(); }, onDeferred: deferredProbe, onError: error => errors.push(error),
  });
  client.onMessage = message => { bridge.handleControl(message); };
  client.onDataStream = (id, header) => { bridge.handleStreamOpen(id, header); };
  client.onObject = (id, object) => { if (!bridge.handleObject(id, object)) generic.push(object); };
  client.onDatagram = object => { datagrams.push(object); bridge.handleDatagram(object); };
  client.onStreamClosed = (id, _code, terminal) => { bridge.handleStreamClose(id, terminal); };
  const observe = vi.spyOn(server.session, 'handleControlMessage');
  server.onSubscribe = id => { subId = id; const message = observe.mock.calls.map(([message]) => message).find(message => message.type === 'SUBSCRIBE' && message.requestId === id);
    if (!message || message.type !== 'SUBSCRIBE') throw new Error('Missing decoded SUBSCRIBE'); requests.push({ id, message }); };
  server.onFetch = id => { joins.push(id); };
  bridge.start(); await turn();
  const sendPrefixObject = async (object: bigint) => {
    await server.sendFetchObject(prefixStream, { groupId: 3n, subgroupId: 0n, objectId: object, publisherPriority: 128,
      payload: Uint8Array.of(Number(object)) });
  };
  const acknowledge = async (holdResponse = false) => {
    expect(subId).toBeGreaterThanOrEqual(0n);
    const response = a.bidiOut[0]!.in;
    if (options.early) response.faults.hold = true;
    const parameters: MessageParameters = new Map();
    if (head) {
      const location = { group: head.groupId, object: head.objectId };
      if (draft < 18) {
        const bytes = new Uint8Array(locationEncodingLength(location)); writeLocation(location, bytes, 0);
        parameters.set(MessageParam.LARGEST_OBJECT, [bytes]);
      } else parameters.set(MessageParam.LARGEST_OBJECT, [location]);
    }
    await server.acceptSubscribe(subId, 77n, { parameters,
      ...(options.subscribeProperties ? { trackProperties: options.subscribeProperties } : {}) });
    if (draft === 22 && head && head.groupId >= 3n && (head.groupId > 3n || head.objectId >= 1n)) {
      prefixStream = await server.openFillStream(subId);
    }
    if (options.early && !holdResponse) { await flush(150); response.releaseHeld(); }
    await turn();
    return () => response.releaseHeld();
  };
  const openJoin = async (override?: { group: bigint; object: bigint }, beforeOk = false, endOfTrack: 0 | 1 = 0) => {
    expect(joins).toHaveLength(1); const id = joins[0]!;
    const range = server.resolveJoiningFetch(id);
    if (!beforeOk) await server.acceptFetch(id, { endOfTrack, endLocation: override ?? range.endLocation,
      ...(options.joinProperties ? { trackProperties: options.joinProperties } : {}) });
    prefixStream = await server.openFetchStream(id);
    return async () => { if (beforeOk) { await server.acceptFetch(id, { endOfTrack, endLocation: override ?? range.endLocation,
      ...(options.joinProperties ? { trackProperties: options.joinProperties } : {}) }); await turn(); } };
  };
  const live = async (object: bigint, close = true) => {
    const stream = await server.openSubgroup(77n, 3n, object, { publisherPriority: 128 });
    await server.sendObject(stream, object, Uint8Array.of(Number(object)));
    if (close) await server.closeSubgroup(stream);
    await turn(); return stream;
  };
  return { client, server, bridge, a, b, errors, transportErrors, deferredProbe, ended, received, discarded, rawInputs,
    accepted, boundaries, order, requests, joins, generic, datagrams, livePayloads, heldDatagrams, abort, acknowledge, openJoin, sendPrefixObject, live,
    get subId() { return subId; }, get prefixStream() { return prefixStream; },
    retire() { current = false; bridge.cancel(); },
    async close() { bridge.cancel(); options.work?.resolve(); options.install?.resolve(); options.admit?.resolve(false); await client.close(); await server.close(); },
  };
}


export { fixture, deferred, turn, connections };
