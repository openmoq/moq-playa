import { vi } from 'vitest';
import { type TrackPropertyValue } from '@openmoq/transport';
import { MoqtConnection } from '@openmoq/webtransport';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { SeekRoleRetrieval } from '../src/seek-role-retrieval.js';
import type { SeekRetrievalTrack, SeekRoleBridgeOwner } from '../src/seek-role-retrieval.js';
import type { TimelineState } from '../src/timeline-manager.js';

const dec = new TextDecoder();

// Transport ownership only. The controlled output host acknowledges work;
// these payloads are not evidence of format preparation or native playback.
async function fixture(draft: 18 | 22, live = false, observation?: NonNullable<ConstructorParameters<typeof SeekRoleRetrieval>[0]['liveObservation']>) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const requests: Array<{ id: bigint; name: string; namespace: string[] }> = [];
  const owners: SeekRoleRetrieval[] = [], errors: string[] = [];
  const bridges: SeekRoleBridgeOwner[] = [], subscriptions: bigint[] = [], joins: bigint[] = [];
  const generic = vi.fn(), cancelled = vi.spyOn(client, 'fetchCancel');
  client.onError = server.onError = error => { errors.push(error.message); };
  server.onFetch = (id, message) => {
    if (message.fetch.fetchType !== 1) { joins.push(id); return; }
    requests.push({ id, name: dec.decode(message.fetch.trackName), namespace: message.fetch.trackNamespace.map(field => dec.decode(field)) });
  };
  server.onSubscribe = id => { subscriptions.push(id); };
  server.setLargestLocationProvider(() => ({ group: 3n, object: 2n }));
  client.onMessage = message => { if (!bridges.some(owner => owner.bridge?.handleControl(message))) owners.some(owner => owner.requests.handleControl(message)); };
  client.onDataStream = (id, header) => { if (!bridges.some(owner => owner.bridge?.handleStreamOpen(id, header))) owners.some(owner => owner.requests.handleStreamOpen(id, header)); };
  client.onStreamClosed = (id, _code, terminal) => { if (!bridges.some(owner => owner.bridge?.handleStreamClose(id, terminal))) owners.some(owner => owner.requests.handleStreamClose(id)); };
  client.onObject = (id, object) => { if (!bridges.some(owner => owner.bridge?.handleObject(id, object))) generic(id, object); };
  await Promise.all([client.connect(a), server.connect(b)]);
  const timeline: TimelineState = { trackName: 'timeline', trackDuration: undefined, isLive: live,
    depends: ['video', 'audio'], entries: [{ mediaPts: 4000, location: [3, 0], wallclockTime: 0 },
      ...(live ? [{ mediaPts: 4020, location: [3, 1] as const, wallclockTime: 0 }] : [])] };
  function role(name: 'video' | 'audio') {
    const track: SeekRetrievalTrack = { role: name, name, namespace: ['a/b', 'show'] };
    const received: number[] = [], ended = vi.fn(), failures = vi.fn(), accepted = vi.fn();
    const liveProperties: Array<ReadonlyMap<bigint, readonly TrackPropertyValue[]>> = [];
    const liveCancelled = vi.fn();
    let onBeginLive: (() => void) | undefined;
    let identity: object | null = null;
    const owner = new SeekRoleRetrieval({ connection: client, track, location: { groupId: 3n, objectId: 0n },
      timeoutMs: 1000, maxObjects: 16, maxBytes: 1024, isCurrent: () => true, getTimeline: () => timeline,
      canProbeLive: () => live, admitHead: () => live, beforeSubscribe: () => true,
      beginPage: page => {
        identity = page;
        return { onObject: async object => { if (object.kind === 'data') received.push(object.payload[0]!); },
          onClosed: terminal => { if (terminal === 'fin') owner.onPageDrained(page); } };
      },
      acceptPage: accepted, beginLive: (_owner, properties) => {
        if (!live) throw new Error('Finite fixture cannot enter live input');
        liveProperties.push(properties); onBeginLive?.();
        return { onObject: async object => { if (object.kind === 'data') received.push(object.payload[0]!); },
          endTrack: async () => {}, cancel: liveCancelled };
      },
      capture: () => undefined, discard: vi.fn(),
      ...(observation ? { liveObservation: observation } : {}),
      consume: async (object, _input, current, deliver) => { if (current()) await deliver(object); },
      onBridgeAdded: bridge => { if (!live) throw new Error('Finite fixture cannot open a bridge'); bridges.push(bridge); },
      onBridgeRemoved: bridge => { const index = bridges.indexOf(bridge); if (index >= 0) bridges.splice(index, 1); },
      onEnded: ended, onProgress: vi.fn(), onFailure: failures,
    });
    owners.push(owner); owner.pump();
    return { owner, received, ended, failures, accepted, liveProperties, liveCancelled,
      beforeLive(callback: () => void) { onBeginLive = callback; }, page: () => identity };
  }
  async function accept(index: number) {
    const request = requests[index]; if (!request) throw new Error('Missing real FETCH');
    await server.acceptFetch(request.id, { endOfTrack: 1, endLocation: { group: 3n, object: draft === 22 ? 1n : 2n } });
    const stream = await server.openFetchStream(request.id); await flush(128); return stream;
  }
  async function send(stream: bigint, object: bigint, value: number) {
    await server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: object,
      publisherPriority: 128, payload: Uint8Array.of(value) });
    await flush(256);
  }
  return { client, server, requests, errors, cancelled, generic, role, accept, send, subscriptions, joins, bridges,
    async destroy() { for (const owner of owners) owner.cancel(); await client.close(); await server.close(); } };
}


export { fixture };
