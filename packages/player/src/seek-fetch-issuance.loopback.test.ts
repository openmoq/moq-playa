import { afterEach, describe, expect, it, vi } from 'vitest';
import { varint, writeLocation, locationEncodingLength } from '@openmoq/transport';
import { MoqtConnection } from '@openmoq/webtransport';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { SeekFetchRequests } from './seek-fetch-requests.js';
import { SeekRoleRetrieval } from './seek-role-retrieval.js';
import type { TimelineState } from './timeline-manager.js';
import type { SeekTrack } from './seek-retrieval-contracts.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
const enc = new TextEncoder(), dec = new TextDecoder();
const track = { namespace: ['a/b', '雪'], name: 'video' }, start = { groupId: 3n, objectId: 0n };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

// SDK issuance/transport proof only. The host acknowledges opaque Object work;
// it does not pretend to prepare media or prove native playback.
async function fixture(draft: 16 | 18 | 22, options: {
  authorization?: ReturnType<typeof deferred<void>>;
  write?: ReturnType<typeof deferred<void>>;
  liveIndex?: boolean;
  timelineFailure?: Error;
  noIndex?: boolean;
} = {}) {
  const { a, b } = createLoopback();
  let armed = false, writes = 0;
  const wrap = (stream: WritableStream<Uint8Array>) => {
    const writer = stream.getWriter();
    return new WritableStream<Uint8Array>({
      async write(bytes) { await writer.write(bytes); if (armed && ++writes === 1 && options.write) await options.write.promise; },
      close: () => writer.close(), abort: reason => writer.abort(reason),
    });
  };
  const uni = a.createUnidirectionalStream.bind(a), bidi = a.createBidirectionalStream.bind(a);
  a.createUnidirectionalStream = async () => wrap(await uni());
  a.createBidirectionalStream = async () => { const stream = await bidi(); return { readable: stream.readable, writable: wrap(stream.writable) }; };
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const roles: SeekRoleRetrieval[] = [], helpers: SeekFetchRequests[] = [];
  const requests: Array<{ id: bigint; name: string }> = [], transportErrors: string[] = [];
  let authCalls = 0;
  client.onError = server.onError = error => { transportErrors.push(error.message); };
  await Promise.all([client.connect(a, { authorization: { relayUrl: 'https://issuance.invalid/moq', getTokens: async context => {
    if (context.operation === 'FETCH') { authCalls++; await options.authorization?.promise; }
    return [{ tokenType: 1n, value: Uint8Array.of(1) }];
  } } }), server.connect(b, draft === 16 ? { maxRequestId: varint(1000n) } : {})]);
  armed = true;
  const requestOwners = () => [...helpers, ...roles.map(role => role.requests)];
  client.onMessage = message => { requestOwners().some(owner => owner.handleControl(message)); };
  client.onDataStream = (id, header) => { requestOwners().some(owner => owner.handleStreamOpen(id, header)); };
  client.onStreamClosed = id => { requestOwners().some(owner => owner.handleStreamClose(id)); };
  server.onFetch = (id, message) => { requests.push({ id, name: message.fetch.fetchType === 1 ? dec.decode(message.fetch.trackName) : 'join' }); };
  const timeline: TimelineState = { trackName: 'timeline', trackDuration: undefined, isLive: options.liveIndex ?? false,
    depends: ['video', 'audio'], entries: options.noIndex ? [] : [4000, 6000, 8000, 10000].map((mediaPts, i) => ({ mediaPts, location: [3, i], wallclockTime: 0 })) };
  function helper() { const errors = vi.fn(); const owner = new SeekFetchRequests(client, { isCurrent: () => true, onError: errors }); helpers.push(owner); return { owner, errors }; }
  function role(name: 'video' | 'audio' = 'video', onFailure?: () => void) {
    const roleTrack: SeekTrack = { ...track, name, role: name, sourceKey: name, packaging: 'cmaf', codec: 'fixture', init: new Uint8Array() };
    const pages = new Map<object, { accepted: boolean; fin: boolean; drained: boolean }>();
    const received: bigint[] = [], accepted = vi.fn(), failed = vi.fn(), ended = vi.fn();
    let current = true, withdrawNext = false;
    const drain = (identity: object) => { const page = pages.get(identity)!; if (page.accepted && page.fin && !page.drained) { page.drained = true; owner.onPageDrained(identity); } };
    const owner = new SeekRoleRetrieval({ connection: client, track: roleTrack, location: start,
      timeoutMs: 1000, maxObjects: 16, maxBytes: 1024, isCurrent: () => { if (withdrawNext) { withdrawNext = false; queueMicrotask(() => { current = false; }); } return current; }, getTimeline: () => { if (options.timelineFailure) throw options.timelineFailure; return timeline; },
      canProbeLive: () => false, admitHead: () => false, beforeSubscribe: () => true,
      beginPage: identity => { pages.set(identity, { accepted: false, fin: false, drained: false }); return {
        onObject: async object => { received.push(object.objectId); }, onClosed: terminal => { if (terminal === 'fin') { pages.get(identity)!.fin = true; drain(identity); } },
      }; },
      acceptPage: (identity, eot) => { accepted(identity, eot); pages.get(identity)!.accepted = true; drain(identity); },
      beginLive: () => { throw new Error('Fixture does not enter live'); }, capture: () => undefined, discard: vi.fn(),
      consume: async (object, input, admitted, deliver) => { if (admitted()) await deliver(object, input); },
      onBridgeAdded: () => { throw new Error('Fixture does not open bridge'); }, onBridgeRemoved: vi.fn(), onEnded: ended, onProgress: vi.fn(),
      onFailure: (error, kind) => { failed(error, kind); onFailure?.(); },
    });
    roles.push(owner);
    return { owner, received, accepted, failed, ended, withdraw() { current = false; }, withdrawAfterNextOwnershipCheck() { withdrawNext = true; } };
  }
  async function body(index: number, objects: readonly bigint[], eot: 0 | 1, endExclusive: bigint) {
    const id = requests[index]!.id;
    await server.acceptFetch(id, { endOfTrack: eot, endLocation: { group: 3n, object: draft === 22 ? endExclusive - 1n : endExclusive } });
    const stream = await server.openFetchStream(id);
    for (const objectId of objects) await server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId, publisherPriority: 128, payload: Uint8Array.of(Number(objectId)) });
    await server.closeFetchStream(stream); await flush(512); return stream;
  }
  cleanups.push(async () => { for (const role of roles) role.cancel(); for (const owner of helpers) owner.dispose(); options.authorization?.resolve(); options.write?.resolve(); await client.close(); await server.close(); });
  return { client, server, a, b, requests, transportErrors, role, helper, body, authCalls: () => authCalls };
}

describe.each([16, 18, 22] as const)('first request issuance draft %i', draft => {
  it('exposes async authorization rejection to the awaiting role caller', async () => {
    const authorization = deferred(), f = await fixture(draft, { authorization }), r = f.role();
    r.owner.pump(); const selected = Promise.resolve(r.owner.firstIssued); void selected.catch(() => {});
    await flush(200); expect(f.requests).toEqual([]); authorization.reject(new Error('credential denied'));
    await flush(512); expect(r.failed).toHaveBeenCalledOnce(); expect(r.accepted).not.toHaveBeenCalled();
    await expect(selected).rejects.toMatchObject({ name: 'AuthorizationError' });
  });
  it('exposes actual async request write failure without claiming response acceptance', async () => {
    const write = deferred(), f = await fixture(draft, { write }), r = f.role();
    r.owner.pump(); const selected = Promise.resolve(r.owner.firstIssued); void selected.catch(() => {});
    await flush(256); expect(f.requests).toHaveLength(1); write.reject(new Error('local write failed'));
    await flush(512); await expect(selected).rejects.toBeInstanceOf(Error); expect(r.accepted).not.toHaveBeenCalled();
  });
  it('fulfills issuance after the SDK write without fabricating FETCH_OK or FIN', async () => {
    const f = await fixture(draft), r = f.role(); r.owner.pump();
    await expect(r.owner.firstIssued).resolves.toEqual(expect.any(BigInt));
    expect(f.requests).toHaveLength(1); await expect(r.owner.firstIssued).resolves.toBe(f.requests[0]!.id);
    expect(r.accepted).not.toHaveBeenCalled(); expect(r.ended).not.toHaveBeenCalled(); expect(r.failed).not.toHaveBeenCalled();
  });
});

describe.each([18, 22] as const)('issuance independent of page progress draft %i', draft => {
  it.each(['resolve', 'reject'] as const)('DATA/FIN and the next page precede first write %s without rebinding the Promise', async outcome => {
    const write = deferred(), f = await fixture(draft, { write, liveIndex: true }), r = f.role();
    r.owner.pump(); const first = r.owner.firstIssued; let settled = false; void Promise.resolve(first).then(() => { settled = true; }, () => { settled = true; });
    await flush(256); const closed = await f.body(0, [0n, 1n], 0, 2n); await flush(512);
    expect(r.owner.requests.handleStreamClose(closed)).toBe(false);
    expect(r.owner.requests.handleControl({type:'FETCH_OK',requestId:varint(f.requests[0]!.id),endOfTrack:0,endLocation:{group:3n,object:draft===22?1n:2n},parameters:new Map()})).toBe(false);
    expect(r.received).toEqual([0n, 1n]); expect(f.requests).toHaveLength(2); expect(settled).toBe(false);
    expect(r.owner.firstIssued).toBe(first); expect(r.failed).not.toHaveBeenCalled();
    if (outcome === 'resolve') { write.resolve(); await expect(first).resolves.toBe(f.requests[0]!.id); }
    else { write.reject(new Error('first write failed after page advanced')); await expect(first).rejects.toThrow('first write failed after page advanced'); }
    await flush(512); expect(r.owner.firstIssued).toBe(first);
    await f.body(1,[2n],0,3n); expect(r.received).toEqual([0n,1n,2n]); expect(r.failed).not.toHaveBeenCalled();
  });
  it('cancellation releases first issuance locally and owns a late authorization rejection', async () => {
    const authorization = deferred(), f = await fixture(draft, { authorization }), r = f.role();
    r.owner.pump(); const first = r.owner.firstIssued; r.owner.cancel(); r.owner.cancel();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' }); authorization.reject(new Error('late credentials'));
    await flush(512); expect(f.requests).toEqual([]); expect(r.failed).not.toHaveBeenCalled();
  });
  it('canceling video cannot reject audio issuance or cancel its real request', async () => {
    const authorization = deferred(), f = await fixture(draft, { authorization }), v = f.role(), a = f.role('audio');
    v.owner.pump(); a.owner.pump(); v.owner.cancel(); await expect(v.owner.firstIssued).rejects.toMatchObject({ name: 'AbortError' });
    authorization.resolve(); await expect(a.owner.firstIssued).resolves.toEqual(expect.any(BigInt));
    expect(f.requests.map(request => request.name)).toEqual(['audio']); expect(a.failed).not.toHaveBeenCalled();
  });
});

it('openIssued preserves the legacy cancel API while ignoring returned-Promise rejections safely', async () => {
  const authorization = deferred(), f = await fixture(18, { authorization }), h = f.helper();
  const legacy = h.owner.open(track, start, { onObject: () => {} }); expect(typeof legacy).toBe('function'); legacy();
  const issued = h.owner.openIssued(track, start, { onObject: () => {} }); expect(typeof issued.cancel).toBe('function'); issued.cancel();
  await expect(issued.issued).rejects.toMatchObject({ name: 'AbortError' }); authorization.reject(new Error('ignored late failure'));
  await flush(512); expect(f.requests).toEqual([]); expect(h.errors).not.toHaveBeenCalled();
});
it('onFailure cancellation reentry preserves the actual first authorization error', async () => {
  const authorization = deferred(), f = await fixture(18, { authorization }); let cancel = () => {};
  const r = f.role('video', () => { cancel(); }); cancel = () => r.owner.cancel();
  r.owner.pump(); authorization.reject(new Error('credential denied')); await flush(512);
  await expect(r.owner.firstIssued).rejects.toMatchObject({ name: 'AuthorizationError' }); expect(r.failed).toHaveBeenCalledOnce();
});

it('actual SDK can return an ID after pre-send cancellation, while issued rejects and no FETCH is emitted', async () => {
  const f = await fixture(18), sdk = vi.spyOn(f.client, 'fetch'); let withdraw = false;
  const owner = new SeekFetchRequests(f.client, { isCurrent: () => { if (withdraw) { withdraw = false; owner.dispose(); } return true; }, onError: vi.fn() });
  const attempt = owner.openIssued(track, start, { onObject: () => {} }); withdraw = true;
  await expect(attempt.issued).rejects.toMatchObject({ name: 'AbortError' }); await flush(512);
  const result = sdk.mock.results[0]; if (result?.type !== 'return') throw new Error('Missing actual SDK return');
  await expect(result.value).resolves.toEqual(expect.any(BigInt)); expect(f.requests).toEqual([]);
  owner.dispose();
});
it('canceling a pending real write settles issuance locally and owns its late failure', async () => {
  const write = deferred(), f = await fixture(18, { write }), h = f.helper();
  const attempt = h.owner.openIssued(track, start, { onObject: () => {} }); await flush(256);
  expect(f.requests).toHaveLength(1); attempt.cancel(); attempt.cancel();
  await expect(attempt.issued).rejects.toMatchObject({ name: 'AbortError' });
  write.reject(new Error('write failed after cancellation')); await flush(512); expect(h.errors).not.toHaveBeenCalled();
});
describe.each([16, 18, 22] as const)('additive Joining issuance draft %i', draft => {
  it('uses actual associated subscription ownership and keeps response acceptance separate', async () => {
    const f = await fixture(draft), h = f.helper(), response = vi.fn(); let incoming: bigint | undefined;
    f.server.onSubscribe = id => { incoming = id; };
    f.server.setLargestLocationProvider(() => ({ group: 3n, object: 2n }));
    const sub = await f.client.subscribe(track.namespace.map(field => enc.encode(field)), enc.encode(track.name),
      { subscriptionFilter: { type: 'LargestObject' }, groupOrder: varint(1n) });
    await flush(256); expect(incoming).toBe(sub); const head = { group: 3n, object: 2n };
    const legacy = new Uint8Array(locationEncodingLength(head)); writeLocation(head, legacy, 0);
    await f.server.acceptSubscribe(sub, 80n, { parameters: new Map([[0x09n, [draft === 16 ? legacy : head]]]) }); await flush(256);
    const attempt = h.owner.joinIssued(sub, 3n, { onObject: () => {} }, response);
    if (draft === 22) { await expect(attempt.issued).rejects.toThrow(/Joining FETCH|draft.?22/); expect(f.requests).toEqual([]); }
    else {
      await expect(attempt.issued).resolves.toEqual(expect.any(BigInt)); expect(f.requests).toHaveLength(1);
      expect(f.server.resolveJoiningFetch(f.requests[0]!.id)).toEqual({ startLocation: { group: 3n, object: 0n }, endLocation: { group: 3n, object: 3n } });
      expect(h.errors).not.toHaveBeenCalled();
    }
    expect(response).not.toHaveBeenCalled(); expect(f.client.session.getSubscription(sub)?.isActive).toBe(true);
  });
});

it('withdrawal between SDK completion and role resolution cannot publish a stale first-issued success', async () => {
  const write = deferred(), f = await fixture(18, { write }), r = f.role();
  r.owner.pump(); await flush(256); expect(f.requests).toHaveLength(1);
  r.withdrawAfterNextOwnershipCheck(); write.resolve();
  await expect(r.owner.firstIssued).rejects.toMatchObject({ name: 'AbortError' }); expect(r.failed).not.toHaveBeenCalled();
});

it('planning failure rejects firstIssued before any SDK request, even when onFailure cancels reentrantly', async () => {
  const failure = new Error('timeline planning failed'), f = await fixture(18, {timelineFailure:failure});let cancel=()=>{};
  const r=f.role('video',()=>{cancel();});cancel=()=>r.owner.cancel();r.owner.pump();
  await expect(r.owner.firstIssued).rejects.toBe(failure);expect(r.failed).toHaveBeenCalledExactlyOnceWith(failure,'planning');expect(f.requests).toEqual([]);
});
it('waiting for an index leaves firstIssued pending until local cancellation', async () => {
  const f=await fixture(18,{liveIndex:true,noIndex:true}),r=f.role();let settled=false;
  void r.owner.firstIssued.then(()=>{settled=true;},()=>{settled=true;});r.owner.pump();await flush(512);
  expect(settled).toBe(false);expect(f.requests).toEqual([]);expect(r.failed).not.toHaveBeenCalled();
  r.owner.cancel();await expect(r.owner.firstIssued).rejects.toMatchObject({name:'AbortError'});
});
it('a later-page planning error cannot replace the first pending SDK emission outcome', async () => {
  const write=deferred(), options:{write:ReturnType<typeof deferred<void>>;liveIndex:boolean;timelineFailure?:Error}={write,liveIndex:true};
  const f=await fixture(18,options),r=f.role();r.owner.pump();const first=r.owner.firstIssued;let settled=false;
  void first.then(()=>{settled=true;},()=>{settled=true;});await flush(256);
  options.timelineFailure=new Error('later-page planning failed');await f.body(0,[0n,1n],0,2n);await flush(512);
  expect(r.failed).toHaveBeenCalledExactlyOnceWith(options.timelineFailure,'planning');expect(settled).toBe(false);
  write.resolve();await expect(first).resolves.toBe(f.requests[0]!.id);
});
it('dispose after healthy response/DATA/FIN still owns and rejects the unsettled first issuance locally', async () => {
  const write=deferred(),f=await fixture(18,{write,liveIndex:true}),r=f.role();r.owner.pump();
  const outcome: Array<{state:string;name?:string}> = [];
  void r.owner.firstIssued.then(()=>{outcome.push({state:'fulfilled'});},error=>{outcome.push({state:'rejected',name:error.name});});
  await flush(256);const closed=await f.body(0,[0n,1n],0,2n);await flush(512);
  expect(r.owner.requests.handleStreamClose(closed)).toBe(false);expect(outcome).toEqual([]);
  r.owner.requests.dispose();await flush(512);
  expect(outcome).toEqual([{state:'rejected',name:'AbortError'}]);
  await expect(r.owner.firstIssued).rejects.toMatchObject({name:'AbortError'});expect(r.failed).not.toHaveBeenCalled();
  // The original writer remains held until fixture cleanup; local settlement
  // cannot be credited to resolving or rejecting that SDK Promise.
});

describe('failure normalization first winner',()=>{
  it('owns an already-observed response failure before coercion reenters disposal',async()=>{
    const write=deferred(),f=await fixture(18,{write}),h=f.helper();
    const cause={toString(){h.owner.dispose();return 'response callback failed';}};
    const attempt=h.owner.openIssued(track,start,{onObject:()=>{}},()=>{throw cause;});
    await flush(256);expect(f.requests).toHaveLength(1);
    await f.server.acceptFetch(f.requests[0]!.id,{endLocation:{group:3n,object:1n}});await flush(512);
    await expect(attempt.issued).rejects.toMatchObject({name:'Error',message:'response callback failed'});
  });
  it('owns a first planning failure before its coercion reenters role cancellation',async()=>{
    let cancel=()=>{};
    const failure:Error & {toString():string}={name:'PlanningFailure',message:'planning callback failed',toString(){cancel();return 'planning callback failed';}};
    const f=await fixture(18,{timelineFailure:failure}),r=f.role();cancel=()=>r.owner.cancel();r.owner.pump();
    await expect(r.owner.firstIssued).rejects.toMatchObject({name:'Error',message:'planning callback failed'});
    expect(f.requests).toEqual([]);
  });
  it('contains a throwing coercion rather than leaking it to transport or leaving issuance unsettled',async()=>{
    const write=deferred(),f=await fixture(18,{write}),h=f.helper();
    const cause={toString(){throw new Error('coercion escaped');}};
    const attempt=h.owner.openIssued(track,start,{onObject:()=>{}},()=>{throw cause;});
    let state='pending';void attempt.issued.then(()=>{state='fulfilled';},()=>{state='rejected';});
    await flush(256);expect(f.requests).toHaveLength(1);
    await f.server.acceptFetch(f.requests[0]!.id,{endLocation:{group:3n,object:1n}});await flush(512);
    expect.soft(f.transportErrors,'failure conversion must stay within request ownership').toEqual([]);
    expect(state,'owned callback failure must reject the unsettled issuance').toBe('rejected');
  });
  it('retains an ordinary Error when its error observer disposes reentrantly',async()=>{
    const write=deferred(),f=await fixture(18,{write}),h=f.helper(),cause=new Error('ordinary callback failed');
    h.errors.mockImplementation(()=>h.owner.dispose());
    const attempt=h.owner.openIssued(track,start,{onObject:()=>{}},()=>{throw cause;});
    await flush(256);expect(f.requests).toHaveLength(1);
    await f.server.acceptFetch(f.requests[0]!.id,{endLocation:{group:3n,object:1n}});await flush(512);
    await expect(attempt.issued).rejects.toBe(cause);expect(f.transportErrors).toEqual([]);
  });
});
