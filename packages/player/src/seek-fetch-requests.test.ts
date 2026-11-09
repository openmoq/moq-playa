import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControlCodec, varint, type ControlMessage, type MoqtObject } from '@openmoq/transport';
import { MoqtConnection, type FetchReceiveContext } from '@openmoq/webtransport';
import { createLoopback } from '../../webtransport/src/testkit/loopback.js';
import { flush } from '../../webtransport/src/testkit/stream-sim.js';
import { SeekFetchRequests, type SeekFetchResponse } from './seek-fetch-requests.js';

function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const track = { namespace: ['a/b', '雪'], name: 'v/one' };
const start = { groupId: 3n, objectId: 0n };
const connections: MoqtConnection[] = [];
afterEach(async () => { for (const connection of connections.splice(0)) await connection.close(); });

async function fixture(draft: 18 | 22, gate?: ReturnType<typeof deferred>, registrationGate?: ReturnType<typeof deferred>) {
  const { a, b } = createLoopback();
  let armed = false;
  const create = a.createBidirectionalStream.bind(a);
  a.createBidirectionalStream = async () => {
    const stream = await create(), writer = stream.writable.getWriter();
    return { readable: stream.readable, writable: new WritableStream<Uint8Array>({
      async write(bytes) { await writer.write(bytes); if (armed && gate) await gate.promise; },
      close: () => writer.close(), abort: reason => writer.abort(reason),
    }) };
  };
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  connections.push(client, server);
  const transportErrors: Error[] = [], errors: Error[] = [], generic = vi.fn(), controls: boolean[] = [], opened: boolean[] = [], closed: boolean[] = [];
  client.onError = server.onError = error => { transportErrors.push(error); };
  await Promise.all([client.connect(a, registrationGate ? { authorization: { relayUrl: 'https://relay.invalid/moq',
    getTokens: async context => { if (context.operation === 'FETCH') await registrationGate.promise; return [{ tokenType: 1n, value: Uint8Array.of(1) }]; } } } : {}), server.connect(b)]);
  armed = true;
  let current = true;
  const owner = new SeekFetchRequests(client, { isCurrent: () => current, onError: error => { errors.push(error); } });
  client.onMessage = message => { controls.push(owner.handleControl(message)); };
  client.onDataStream = (id, header) => { opened.push(owner.handleStreamOpen(id, header)); };
  client.onStreamClosed = id => { closed.push(owner.handleStreamClose(id)); };
  client.onObject = generic;
  const requests: Array<{ id: bigint; namespace: Uint8Array[]; name: Uint8Array }> = [];
  server.onFetch = (id, message) => {
    if (message.fetch.fetchType !== 0x1) throw new Error('Expected standalone FETCH');
    requests.push({ id, namespace: message.fetch.trackNamespace, name: message.fetch.trackName });
  };
  const send = (sid: bigint, object: bigint) => server.sendFetchObject(sid, {
    groupId: 3n, subgroupId: 0n, objectId: object, publisherPriority: 128, payload: Uint8Array.of(Number(object)),
  });
  return { owner, client, server, a, b, requests, errors, transportErrors, generic, controls, opened, closed, send,
    retire() { current = false; }, async destroy() { owner.dispose(); gate?.resolve(); registrationGate?.resolve(); await client.close(); await server.close(); } };
}

describe.each([18, 22] as const)('seek FETCH request ownership draft %i', draft => {
  it('encodes the exact tuple and an ascending open-ended snapshot, claims only its own responses/streams', async () => {
    const p = await fixture(draft), receive = vi.fn(), ended = vi.fn(), response = vi.fn();
    try {
      p.owner.open(track, start, { onObject: receive, onClosed: ended }, response); await flush(200);
      if (p.errors[0]) throw p.errors[0];
      expect(p.requests).toHaveLength(1); const id = p.requests[0]!.id;
      expect(p.requests[0]).toMatchObject({ namespace: track.namespace.map(value => new TextEncoder().encode(value)), name: new TextEncoder().encode(track.name) });
      const outgoing = createControlCodec(draft).decode(p.a.bidiOut[0]!.out.writtenBytes(), 0).message;
      expect(outgoing.type).toBe('FETCH');
      if (outgoing.type !== 'FETCH' || outgoing.fetch.fetchType !== 0x1) throw new Error('Expected standalone FETCH');
      expect(outgoing.fetch.startLocation).toEqual({ group: 3n, object: 0n });
      expect(outgoing.fetch.endLocation).toEqual({ group: 18_446_744_073_709_551_615n, object: 0n });
      expect(outgoing.parameters.get(0x22n)).toEqual([1n]);
      await p.server.acceptFetch(id, { endOfTrack: 1, endLocation: { group: 3n, object: 1n } });
      const sid = await p.server.openFetchStream(id); await p.send(sid, 0n); await p.server.closeFetchStream(sid); await flush(200);
      expect(response).toHaveBeenCalledExactlyOnceWith({ endOfTrack: true, endLocation: { group: 3n, object: 1n } });
      expect(receive).toHaveBeenCalledOnce(); expect(ended).toHaveBeenCalledOnce();
      expect(p.opened).toEqual([true]); expect(p.closed).toEqual([true]); expect(p.controls).toEqual([true]); expect(p.generic).not.toHaveBeenCalled();
      const unrelated: ControlMessage = { type: 'REQUEST_ERROR', requestId: varint(999n), errorCode: 0n, errorReason: 'other', retryInterval: 0n };
      expect(p.owner.handleControl(unrelated)).toBe(false); expect(p.owner.handleStreamOpen(999n, { type: 'fetch', header: { requestId: 999n } })).toBe(false);
      expect(p.owner.handleStreamOpen(999n, { type: 'fetch', fill: true, header: { requestId: id } })).toBe(false);
      expect(p.owner.handleControl({ ...unrelated, type: 'REQUEST_ERROR', requestId: varint(id) })).toBe(false);
      expect(p.errors).toEqual([]); expect(p.transportErrors).toEqual([]);
    } finally { await p.destroy(); }
  });

  it('zero-group control remains healthy through a normal finite response', async () => {
    const p = await fixture(draft), receive = vi.fn();
    try {
      p.owner.open(track, { groupId: 0n, objectId: 0n }, { onObject: receive }); await flush(200);
      expect(p.requests).toHaveLength(1); const id = p.requests[0]!.id;
      await p.server.acceptFetch(id, { endLocation: { group: 0n, object: 0n } }); const sid = await p.server.openFetchStream(id);
      await p.server.sendFetchObject(sid, { groupId: 0n, subgroupId: 0n, objectId: 0n, publisherPriority: 128, payload: Uint8Array.of(1) });
      await p.server.closeFetchStream(sid); await flush(200);
      expect(receive).toHaveBeenCalledOnce(); expect(p.errors).toEqual([]); expect(p.closed).toEqual([true]);
    } finally { await p.destroy(); }
  });

  it.each(['object', 'response'])('owns a throwing %s callback without closing the session or leaking a terminal', async source => {
    const p = await fixture(draft);
    try {
      p.owner.open(track, start, { onObject: async () => { if (source === 'object') throw new Error('object failed'); } },
        () => { if (source === 'response') throw new Error('response failed'); });
      await flush(200); expect(p.requests).toHaveLength(1); const id = p.requests[0]!.id;
      await p.server.acceptFetch(id, { endLocation: { group: 3n, object: 1n } }); await flush(100);
      if (source === 'object') { const sid = await p.server.openFetchStream(id); await p.send(sid, 0n); }
      await flush(250);
      expect(p.errors).toHaveLength(1); expect(p.errors[0]!.message).toContain(source + ' failed');
      expect(p.client.session.state).toBe('established'); expect(p.generic).not.toHaveBeenCalled();
      if (source === 'object') expect(p.closed).toEqual([true]);
    } finally { await p.destroy(); }
  });

  it('holds coalesced Objects and FIN behind receiver credit, retains FIN ownership through reentrant dispose', async () => {
    const p = await fixture(draft), credit = deferred(), objects: MoqtObject[] = [], ended = vi.fn();
    try {
      p.owner.open(track, start, { onObject: object => { objects.push(object); return credit.promise; },
        onClosed: terminal => { ended(terminal); p.owner.dispose(); } }); await flush(200);
      expect(p.requests).toHaveLength(1); const id = p.requests[0]!.id;
      await p.server.acceptFetch(id, { endLocation: { group: 3n, object: draft === 18 ? 2n : 1n } }); const sid = await p.server.openFetchStream(id);
      const pipe = p.b.uniOut.at(-1)!; pipe.faults.hold = true;
      await p.send(sid, 0n); await p.send(sid, 1n); await p.server.closeFetchStream(sid); pipe.releaseHeld(); await flush(200);
      expect(objects.map(object => object.objectId)).toEqual([0n]); expect(ended).not.toHaveBeenCalled(); expect(p.closed).toEqual([]);
      credit.resolve(); await flush(200);
      expect(objects.map(object => object.objectId)).toEqual([0n, 1n]); expect(ended).toHaveBeenCalledExactlyOnceWith('fin'); expect(p.closed).toEqual([true]);
      expect(p.errors).toEqual([]);
    } finally { credit.resolve(); await p.destroy(); }
  });

  it('claims early data/FIN before the outer write resolves and retains the later FETCH_OK through actor disposal', async () => {
    const gate = deferred(), p = await fixture(draft, gate), ended = vi.fn();
    const response = vi.fn((_response: SeekFetchResponse) => { p.owner.dispose(); });
    try {
      p.owner.open(track, start, { onObject: () => {}, onClosed: ended }, response); await flush(200);
      expect(p.requests).toHaveLength(1); const id = p.requests[0]!.id;
      const sid = await p.server.openFetchStream(id); await p.send(sid, 0n); await p.server.closeFetchStream(sid); await flush(200);
      expect(ended).toHaveBeenCalledOnce(); expect(p.closed).toEqual([true]); expect(response).not.toHaveBeenCalled();
      p.client.onMessage = message => { const consumed = p.owner.handleControl(message); p.controls.push(consumed); };
      // The response callback may synchronously retire the actor that requested it.
      await p.server.acceptFetch(id, { endLocation: { group: 3n, object: 0n } }); await flush(200);
      expect(response).toHaveBeenCalledOnce(); expect(p.controls).toEqual([true]); expect(p.generic).not.toHaveBeenCalled();
      gate.resolve(); await flush(200); expect(p.errors).toEqual([]);
    } finally { await p.destroy(); }
  });

  it.each(['registration', 'write'])('cancels while %s is pending and never delivers late work', async phase => {
    const gate = deferred(), p = await fixture(draft, phase === 'write' ? gate : undefined, phase === 'registration' ? gate : undefined), receive = vi.fn(), ended = vi.fn();
    try {
      const cancel = p.owner.open(track, start, { onObject: receive, onClosed: ended }); await flush(200); cancel(); cancel();
      gate.resolve(); await flush(300);
      expect(receive).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled(); expect(p.errors).toEqual([]);
      expect(p.client.session.state).toBe('established');
      if (phase === 'registration') expect(p.requests).toEqual([]);
    } finally { await p.destroy(); }
  });

  it.each(['cancel', 'dispose', 'reset', 'disconnect'])('%s wakes an uncooperative consumer and claims its terminal exactly once', async mode => {
    const p = await fixture(draft), work = deferred(), contexts: FetchReceiveContext[] = [], receive = vi.fn((_object: MoqtObject, context: FetchReceiveContext) => { contexts.push(context); return work.promise; });
    try {
      const cancel = p.owner.open(track, start, { onObject: receive }); await flush(200); expect(p.requests).toHaveLength(1);
      const id = p.requests[0]!.id; await p.server.acceptFetch(id, { endLocation: { group: 3n, object: 1n } });
      const sid = await p.server.openFetchStream(id); await p.send(sid, 0n); await flush(150); expect(receive).toHaveBeenCalledOnce();
      if (mode === 'cancel') cancel(); if (mode === 'dispose') p.owner.dispose();
      if (mode === 'reset') p.b.uniOut.at(-1)!.reset(23); if (mode === 'disconnect') await p.client.close();
      await flush(250); expect(contexts[0]!.signal.aborted).toBe(true); expect(p.closed).toEqual([true]);
      work.reject(new Error('late application rejection')); await flush(100); expect(receive).toHaveBeenCalledOnce();
      expect(p.errors.length).toBe(mode === 'reset' || mode === 'disconnect' ? 1 : 0);
    } finally { await p.destroy(); }
  });

  it('reports a received request error once without interfering with another owned request', async () => {
    const p = await fixture(draft), other = vi.fn();
    try {
      p.owner.open(track, start, { onObject: () => {} });
      p.owner.open({ ...track, name: 'audio' }, start, { onObject: other }); await flush(250);
      expect(p.requests).toHaveLength(2); const first = p.requests[0]!.id, second = p.requests[1]!.id;
      await p.server.rejectFetch(first, 0n, 'no historical data'); await flush(200);
      expect(p.errors).toHaveLength(1); expect(p.errors[0]!.message).toContain('no historical data');
      await p.server.acceptFetch(second, { endLocation: { group: 3n, object: 1n } });
      const sid = await p.server.openFetchStream(second); await p.send(sid, 0n); await p.server.closeFetchStream(sid); await flush(200);
      expect(other).toHaveBeenCalledOnce(); expect(p.controls).toEqual([true, true]); expect(p.generic).not.toHaveBeenCalled(); expect(p.client.session.state).toBe('established');
    } finally { await p.destroy(); }
  });

  it('owns outbound send failure and retires its control ownership', async () => {
    const gate = deferred(), p = await fixture(draft, gate);
    try {
      p.owner.open(track, start, { onObject: () => {} }); await flush(200); expect(p.requests).toHaveLength(1);
      gate.reject(new Error('send failed')); await flush(300);
      expect(p.errors).toHaveLength(1);
      expect(p.owner.handleControl({ type: 'REQUEST_ERROR', requestId: varint(p.requests[0]!.id), errorCode: 0n, errorReason: 'late', retryInterval: 0n })).toBe(false);
      expect(p.client.session.state).toBe('established');
    } finally { await p.destroy(); }
  });

  it('rechecks current ownership after awaited receiver work before admitting another Object', async () => {
    const p = await fixture(draft), work = deferred(), receive = vi.fn(() => work.promise), ended = vi.fn();
    try {
      p.owner.open(track, start, { onObject: receive, onClosed: ended }); await flush(200); expect(p.requests).toHaveLength(1);
      const id = p.requests[0]!.id; await p.server.acceptFetch(id, { endLocation: { group: 3n, object: 2n } });
      const sid = await p.server.openFetchStream(id); await p.send(sid, 0n); await p.send(sid, 1n); await flush(150);
      expect(receive).toHaveBeenCalledOnce(); p.retire(); work.resolve(); await flush(250);
      expect(receive).toHaveBeenCalledOnce(); expect(ended).not.toHaveBeenCalled(); expect(p.closed).toEqual([true]); expect(p.errors).toEqual([]);
    } finally { work.resolve(); await p.destroy(); }
  });

  it('consumes REQUEST_ERROR despite synchronous onClosed disposal', async () => {
    const p = await fixture(draft), closed = vi.fn();
    try {
      p.owner.open(track, start, { onObject: () => {}, onClosed: terminal => { closed(terminal); p.owner.dispose(); } }); await flush(200);
      expect(p.requests).toHaveLength(1); await p.server.rejectFetch(p.requests[0]!.id, 0n, 'no historical data'); await flush(250);
      expect(p.controls).toEqual([true]); expect(closed).toHaveBeenCalledOnce();
      expect(p.owner.handleControl({ type: 'REQUEST_ERROR', requestId: varint(p.requests[0]!.id), errorCode: 0n, errorReason: 'late', retryInterval: 0n })).toBe(false);
    } finally { await p.destroy(); }
  });
});


describe('seek FETCH ownership controls', () => {
  it('preserves an optional explicit endpoint and the legacy wire-width maximum', async () => {
    type Connection = ConstructorParameters<typeof SeekFetchRequests>[0];
    const options: Parameters<Connection['fetch']>[2][] = [];
    const connection: Connection = { joiningFetch: async () => { throw new Error('Joining FETCH not configured in this fixture'); }, draftVersion: 16,
      fetch: async (_namespace, _name, input) => { options.push(input); const id = BigInt(options.length); input.onRequestId?.(id); return id; },
      fetchCancel: async () => {} };
    const owner = new SeekFetchRequests(connection, { isCurrent: () => true, onError: error => { throw error; } });
    owner.open(track, start, { onObject: () => {} });
    owner.open(track, start, { onObject: () => {} }, undefined, { groupId: 5n, objectId: 8n });
    expect(options[0]).toMatchObject({ endGroup: 4_611_686_018_427_387_903n, endObject: 0n, groupOrder: 'ascending' });
    expect(options[1]).toMatchObject({ endGroup: 5n, endObject: 8n }); owner.dispose(); await flush(100);
  });

  it('owns synchronous send failure and an error observer that reenters disposal and throws', async () => {
    type Connection = ConstructorParameters<typeof SeekFetchRequests>[0];
    const cancel = vi.fn(async (_id: bigint) => {}), failed = vi.fn();
    const connection: Connection = { joiningFetch: async () => { throw new Error('Joining FETCH not configured in this fixture'); }, draftVersion: 18, fetch: (_namespace, _name, options) => {
      options.onRequestId?.(4n); throw new Error('synchronous send failure');
    }, fetchCancel: cancel };
    const owner = new SeekFetchRequests(connection, { isCurrent: () => true, onError: error => {
      failed(error); owner.dispose(); throw new Error('observer failed');
    } });
    expect(() => owner.open(track, start, { onObject: () => {} })).not.toThrow(); await flush(100);
    expect(failed).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledExactlyOnceWith(4n);
    expect(owner.handleControl({ type: 'REQUEST_ERROR', requestId: varint(4n), errorCode: 0n, errorReason: 'late', retryInterval: 0n })).toBe(false);
  });

  it('old terminal/rejection cleanup cannot cancel or remove a successor reusing an unsent request ID', async () => {
    type Connection = ConstructorParameters<typeof SeekFetchRequests>[0];
    const options: Parameters<Connection['fetch']>[2][] = [], rejects: Array<(error: unknown) => void> = [], cancel = vi.fn(async (_id: bigint) => {});
    const connection: Connection = { joiningFetch: async () => { throw new Error('Joining FETCH not configured in this fixture'); }, draftVersion: 18, fetch: (_namespace, _name, input) => {
      options.push(input); input.onRequestId?.(0n); return new Promise<bigint>((_resolve, reject) => { rejects.push(reject); });
    }, fetchCancel: cancel };
    const failed = vi.fn(), fresh = vi.fn();
    const owner = new SeekFetchRequests(connection, { isCurrent: () => true, onError: failed });
    owner.open(track, start, { onObject: () => {}, onClosed: () => { owner.open(track, start, { onObject: fresh }); } });
    const context: FetchReceiveContext = { requestId: 0n, streamId: null, signal: new AbortController().signal };
    options[0]!.receiver?.onClosed?.('error', context); rejects[0]!(new Error('old send failed')); await flush(150);
    expect(cancel).not.toHaveBeenCalled();
    expect(owner.handleControl({ type: 'FETCH_OK', requestId: varint(0n), endOfTrack: 0, endLocation: { group: 3n, object: 1n }, parameters: new Map() })).toBe(true);
    owner.dispose(); rejects[1]!(new Error('cancelled successor')); await flush(100);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(0n); expect(failed).toHaveBeenCalledOnce();
  });
});

describe('seek Joining FETCH ownership', () => {
  async function associated(p: Awaited<ReturnType<typeof fixture>>) {
    let incoming: bigint | undefined;
    p.server.onSubscribe = id => { incoming = id; };
    const id = await p.client.subscribe(track.namespace.map(field => new TextEncoder().encode(field)), new TextEncoder().encode(track.name),
      { subscriptionFilter: { type: 'LargestObject' }, groupOrder: varint(1n) });
    await flush(200); expect(incoming).toBe(id);
    await p.server.acceptSubscribe(id, 80n, { parameters: new Map([[0x09n, [{ group: 3n, object: 2n }]]]) });
    await flush(200); p.controls.length = 0; return id;
  }

  it('uses a fresh associated subscription and owns its ascending absolute join through DATA before OK', async () => {
    const p = await fixture(18), receive = vi.fn(), terminal = vi.fn(), response = vi.fn();
    try {
      const sub = await associated(p);
      let request: { id: bigint; message: Extract<ControlMessage, { type: 'FETCH' }> } | undefined;
      p.server.onFetch = (id, message) => { request = { id, message }; };
      p.owner.join(sub, 3n, { onObject: receive, onClosed: terminal }, response); await flush(200);
      expect(request?.message.fetch).toEqual({ fetchType: 3, joiningRequestId: sub, joiningStart: 3n });
      expect(request?.message.parameters.get(0x22n)).toEqual([1n]);
      const id = request!.id;
      expect(p.server.resolveJoiningFetch(id)).toEqual({ startLocation: { group: 3n, object: 0n }, endLocation: { group: 3n, object: 3n } });
      const stream = await p.server.openFetchStream(id);
      for (const object of [0n, 1n, 2n]) await p.send(stream, object);
      await p.server.closeFetchStream(stream); await flush(256);
      expect(receive.mock.calls.map(call => call[0].objectId)).toEqual([0n, 1n, 2n]);
      expect(terminal).toHaveBeenCalledOnce(); expect(response).not.toHaveBeenCalled();
      await p.server.acceptFetch(id, { endLocation: { group: 3n, object: 3n } }); await flush(256);
      expect(response).toHaveBeenCalledExactlyOnceWith({ endOfTrack: false, endLocation: { group: 3n, object: 3n } });
      expect(p.generic).not.toHaveBeenCalled(); expect(p.controls).toEqual([true]); expect(p.errors).toEqual([]); expect(p.transportErrors).toEqual([]);
      expect(p.client.session.getSubscription(sub)?.isActive).toBe(true);
    } finally { await p.destroy(); }
  });

  it('cancels a pending authorization without sending a later join or cancelling its associated subscription', async () => {
    const authorization = deferred(), p = await fixture(18, undefined, authorization);
    try {
      const sub = await associated(p), incoming = vi.fn(); p.server.onFetch = incoming;
      const cancel = p.owner.join(sub, 3n, { onObject: () => {} }); cancel();
      authorization.resolve(); await flush(512);
      expect(incoming).not.toHaveBeenCalled(); expect(p.errors).toEqual([]);
      expect(p.client.session.getSubscription(sub)?.isActive).toBe(true);
    } finally { await p.destroy(); }
  });

  it('cancels only the joined request when its consumer throws', async () => {
    const p = await fixture(18);
    try {
      const sub = await associated(p); let joined: bigint | undefined; p.server.onFetch = id => { joined = id; };
      p.owner.join(sub, 3n, { onObject: () => { throw new Error('join consumer failed'); } }); await flush(256);
      p.server.resolveJoiningFetch(joined!); await p.server.acceptFetch(joined!, { endLocation: { group: 3n, object: 3n } });
      const stream = await p.server.openFetchStream(joined!); await p.send(stream, 0n); await flush(512);
      expect(p.errors).toHaveLength(1); expect(p.errors[0]!.message).toBe('join consumer failed');
      expect(p.client.session.getSubscription(sub)?.isActive).toBe(true); expect(p.transportErrors).toEqual([]);
      const live = await p.server.openSubgroup(80n, 4n, 0n); await p.server.sendObject(live, 0n, Uint8Array.of(9)); await p.server.closeSubgroup(live); await flush(256);
      expect(p.generic).toHaveBeenCalled();
    } finally { await p.destroy(); }
  });

  it('retains the draft-22 no-Joining-FETCH refusal without issuing a request', async () => {
    const p = await fixture(22);
    try {
      const sub = await associated(p), incoming = vi.fn(), join = vi.spyOn(p.client, 'joiningFetch'); p.server.onFetch = incoming;
      p.owner.join(sub, 3n, { onObject: () => {} }); await flush(256);
      expect(incoming).not.toHaveBeenCalled(); expect(join).not.toHaveBeenCalled(); expect(p.errors).toHaveLength(1); expect(p.errors[0]!.message).toMatch(/draft.?22|Joining FETCH/i);
      expect(p.client.session.getSubscription(sub)?.isActive).toBe(true); expect(p.transportErrors).toEqual([]);
    } finally { await p.destroy(); }
  });
});
