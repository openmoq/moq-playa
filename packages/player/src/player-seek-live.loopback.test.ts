import { afterEach, describe, expect, it, vi } from 'vitest';
import { varint } from '@openmoq/transport';
import { LocmafTrackDecoder } from '@openmoq/locmaf';
import { readFirstSamplePresentationTime } from '../../browser/src/mp4-box.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { fixture, landHistory, freshLiveSubscription, acknowledgeLive, retainedHandoff, exactRetainedOutput,
  init, payloads, expectedPayloads, mdat, locations } from '../test-support/seek-live-mse.js';
const enc = new TextEncoder();
afterEach(() => vi.useRealTimers());

it('valid MSF01 initRef fixture has one full object and three dependent deltas at exact indexed/raw times', () => {
  const retained = new LocmafTrackDecoder(init);
  for (let i=0;i<4;i++) {
    if (i) expect(new LocmafTrackDecoder(init).push(3n,BigInt(i),payloads[i]!).kind).toBe('rejected');
    const decoded = retained.push(3n,BigInt(i),payloads[i]!); expect(decoded.kind).toBe('chunk');
    if(decoded.kind!=='chunk') throw new Error('Invalid LOCMAF fixture');
    expect(readFirstSamplePresentationTime(decoded.bytes)).toBe(BigInt(4000+2000*i));
    expect(decoded.mdat).toEqual(expectedPayloads[i]);
  }
});

describe.each([18,22] as const)('public historical-to-live boundary draft %i', draft => {
  it('healthy indexed history lands through real LOCMAF and actual native append without a fabricated live head', async () => {
    const f=await fixture(draft,true);
    try { await landHistory(f); }
    finally { await f.destroy(); }
  });
  it('issues fresh same-identity LargestObject SUB and retains one native output across prefix/live',async()=>{
    const f=await fixture(draft,true);
    try {
      await retainedHandoff(f,false); f.complete(3); await flush(512);
      expect(f.player.playbackPositionMs).toBe(5125);
      f.advance(7.125); f.player.tick(); await flush(1024);
      expect(f.player.playbackPositionMs).toBe(7125); exactRetainedOutput(f);
      expect(f.fetches).toHaveLength(1); expect(f.subscriptions.filter(sub=>sub.name==='video')).toHaveLength(2);
      expect(f.ended).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });
});



it('native prefix append and forward credit can outlast connectionTimeout without becoming a peer-wait failure',async()=>{
  vi.useFakeTimers({shouldClearNativeTimers:true});
  const f=await fixture(18,true,locations,{connectionTimeoutMs:100});
  try{
    const sub=await retainedHandoff(f,false,async()=>{
      await vi.advanceTimersByTimeAsync(250);await flush(1024);
      expect(f.player.state).toBe('playing');expect(f.errors).toEqual([]);
      expect(f.submissions).toHaveLength(3);expect(f.nativeBytes).toHaveLength(2);
      expect(f.resources[0]!.current).toBe(true);
    });
    f.complete(3);await flush(512);
    await f.server.publishDone(sub.id,varint(2n),'finite live source');await flush(512);
    await vi.advanceTimersByTimeAsync(250);await flush(1024);
    expect(f.player.state).toBe('playing');expect(f.player.playbackPositionMs).toBe(5125);
    expect(f.errors).toEqual([]);expect(f.ended).not.toHaveBeenCalled();
    f.advance(7.125);f.player.tick();await flush(1024);
    exactRetainedOutput(f);expect(f.ended).toHaveBeenCalledExactlyOnceWith({type:'track_ended',mediaType:'video'});
  }finally{await f.destroy();}
});

it('an idle accepted prefix times out as degraded while preserving the landed native clock and resource',async()=>{
  vi.useFakeTimers({shouldClearNativeTimers:true});
  const f=await fixture(22,true,locations,{connectionTimeoutMs:100});
  try{
    await landHistory(f);const sub=await freshLiveSubscription(f);f.player.play();await flush(256);
    await acknowledgeLive(f,sub);await f.server.openFillStream(sub.id);await flush(512);
    await vi.advanceTimersByTimeAsync(99);await flush(256);expect(f.errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);await flush(1024);
    expect(f.errors).toHaveLength(1);expect(f.errors[0]).toMatch(/peer wait timed out/);
    expect(f.resources).toHaveLength(1);expect(f.resources[0]!.current).toBe(true);expect(f.resources[0]!.cancel).not.toHaveBeenCalled();
    expect(f.nativeBytes.map(mdat)).toEqual(expectedPayloads.slice(0,2));expect(f.submissions).toHaveLength(2);
    f.advance(5.5);expect(f.player.playbackPositionMs).toBe(5500);expect(f.player.state).toBe('playing');
    expect(f.seeked).toHaveBeenCalledOnce();expect(f.ended).not.toHaveBeenCalled();
  }finally{await f.destroy();}
});

it('a refused pending live probe preserves the native output and does not repeat for an unchanged index',async()=>{
  vi.useFakeTimers({shouldClearNativeTimers:true});
  const f=await fixture(18,true,locations,{connectionTimeoutMs:100});
  try{
    await landHistory(f);const sub=await freshLiveSubscription(f);f.player.play();await flush(256);
    await f.server.rejectSubscribe(sub.id,3n,'fixture live probe refused');await flush(1024);
    expect(f.errors).toHaveLength(1);expect(f.errors[0]).toMatch(/Live video continuation unavailable/);
    await f.updateIndex(locations);for(let i=0;i<3;i++){f.player.tick();await flush(256);}
    await vi.advanceTimersByTimeAsync(250);await flush(1024);
    expect(f.errors).toHaveLength(1);expect(f.subscriptions.filter(s=>s.name==='video')).toHaveLength(2);expect(f.fetches).toHaveLength(1);
    expect(f.resources).toHaveLength(1);expect(f.resources[0]!.current).toBe(true);expect(f.resources[0]!.cancel).not.toHaveBeenCalled();
    f.advance(5.5);expect(f.player.playbackPositionMs).toBe(5500);expect(f.player.state).toBe('playing');
    expect(f.nativeBytes.map(mdat)).toEqual(expectedPayloads.slice(0,2));expect(f.ended).not.toHaveBeenCalled();
  }finally{await f.destroy();}
});


it('a committed successor seek retires its predecessor probe before late ACK/prefix can touch the current native resource',async()=>{
  const f=await fixture(22,true);
  try{
    await landHistory(f);const sub=await freshLiveSubscription(f);
    const request=f.a.bidiOut.at(-1)!;const response=await acknowledgeLive(f,sub,true);
    const prefix=await f.server.openFillStream(sub.id);await f.object(prefix,2);await f.close(prefix);await flush(512);
    expect(f.submissions).toHaveLength(2);
    await f.player.seek(6000);await flush(512);
    // Admission preserves the previous active output while the successor prepares.
    expect(f.fetches).toHaveLength(2);expect(f.resources).toHaveLength(1);expect(f.resources[0]!.current).toBe(true);
    expect(f.fetches[1]).toMatchObject({start:{group:3n,object:0n},end:{group:3n,object:2n}});
    const history=await f.open(1,2n,0);await f.object(history,0);await f.object(history,1);await f.close(history);await flush(512);
    expect(f.resources).toHaveLength(2);expect(f.resources[0]!.cancel).toHaveBeenCalledOnce();
    expect(f.resources[1]!.current).toBe(true);expect(f.resources[1]!.initialize).toHaveBeenCalledOnce();
    expect(f.submissions).toHaveLength(3);f.complete(2);await flush(512);
    expect(f.submissions).toHaveLength(4);f.complete(3);await flush(512);
    expect(f.resources[1]!.position).toHaveBeenCalledExactlyOnceWith(6);
    f.land(6.125);await flush(1024);expect(f.seeked).toHaveBeenCalledTimes(2);expect(f.player.playbackPositionMs).toBe(6125);
    expect(request.out.writeClosed||request.out.writeAborted||response.readCancelled).toBe(true);
    response.releaseHeld();await flush(1024);
    expect(f.submissions).toHaveLength(4);expect(f.resources).toHaveLength(2);
    expect(f.nativeByResource.get(f.resources[1]!)!.map(mdat)).toEqual(expectedPayloads.slice(0,2));
    expect(f.nativeByResource.get(f.resources[1]!)!.map(readFirstSamplePresentationTime)).toEqual([4000n,6000n]);
    expect(f.resources[1]!.initialize).toHaveBeenCalledOnce();expect(f.resources[1]!.position).toHaveBeenCalledOnce();
    expect(f.resources[1]!.cancel).not.toHaveBeenCalled();expect(f.player.playbackPositionMs).toBe(6125);
    expect(f.seeked).toHaveBeenCalledTimes(2);expect(f.ended).not.toHaveBeenCalled();expect(f.errors).toEqual([]);
  }finally{await f.destroy();}
});

it('destroy releases a pending live probe and fences its late ACK/prefix without creating another native resource',async()=>{
  const f=await fixture(22,true);
  try{
    await landHistory(f);const sub=await freshLiveSubscription(f);
    const request=f.a.bidiOut.at(-1)!;const response=await acknowledgeLive(f,sub,true);
    const prefix=await f.server.openFillStream(sub.id);await f.object(prefix,2);await f.close(prefix);await flush(512);
    expect(f.submissions).toHaveLength(2);await f.player.destroy();await flush(1024);
    expect(request.out.writeClosed||request.out.writeAborted||response.readCancelled).toBe(true);
    response.releaseHeld();await flush(1024);
    expect(f.submissions).toHaveLength(2);expect(f.nativeBytes.map(mdat)).toEqual(expectedPayloads.slice(0,2));
    expect(f.resources).toHaveLength(1);expect(f.resources[0]!.current).toBe(false);
    expect(f.seeked).toHaveBeenCalledOnce();expect(f.ended).not.toHaveBeenCalled();expect(f.errors).toEqual([]);
  }finally{await f.destroy();}
});

describe.each([18,22] as const)('owned terminal bridge boundary draft %i', draft => {
  it('DONE 2 fences public stall while accepted native work is still pending', async () => {
    const f=await fixture(draft,true); const stalled=vi.fn(); f.player.on('stall',stalled);
    try {
      const sub=await retainedHandoff(f,false);
      expect(f.submissions[3]!.completed).toBe(false);
      vi.useFakeTimers(); await f.server.publishDone(sub.id,varint(2n),'finished'); await flush(512);
      expect(f.ended).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
      f.source.onStall!(517);
      expect(stalled,'genuinely ending bridge must not publish a recovery stall while native work is draining').not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });
  it('DONE 2 fences public stall while only SDK late-delivery grace remains', async () => {
    const f=await fixture(draft,true); const stalled=vi.fn(); f.player.on('stall',stalled);
    try {
      const sub=await retainedHandoff(f,false); f.complete(3); f.advance(7.125); f.player.tick(); await flush(1024);
      expect(f.submissions.every(x=>x.completed)).toBe(true); expect(f.errors).toEqual([]);
      vi.useFakeTimers(); await f.server.publishDone(sub.id,varint(2n),'finished'); await flush(512);
      expect(f.ended).not.toHaveBeenCalled();
      f.source.onStall!(517);
      expect(stalled,'terminal bridge must suppress recovery during the SDK late-delivery grace').not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });
  it('healthy nonterminal live delivery continues to publish a real stall', async () => {
    const f=await fixture(draft,true); const stalled=vi.fn(); f.player.on('stall',stalled);
    try {
      await retainedHandoff(f,false); expect(f.ended).not.toHaveBeenCalled();
      f.source.onStall!(517); expect(stalled).toHaveBeenCalledOnce();
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});

it('draft18 JOIN EndOfTrack fences recovery before its accepted native prefix settles', async () => {
  const f=await fixture(18,true); const stalled=vi.fn(); f.player.on('stall',stalled);
  try {
    await landHistory(f); const sub=await freshLiveSubscription(f); f.player.play();
    await acknowledgeLive(f,sub); expect(f.joins).toHaveLength(1);
    const join=f.joins[0]!, range=f.server.resolveJoiningFetch(join.id);
    await f.server.acceptFetch(join.id,{endOfTrack:1,endLocation:range.endLocation});
    const prefix=await f.server.openFetchStream(join.id);
    await f.object(prefix,0); await f.object(prefix,1); await f.object(prefix,2); await f.close(prefix); await flush(512);
    expect(f.submissions).toHaveLength(3); expect(f.submissions[2]!.completed).toBe(false);
    expect(f.ended).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    f.source.onStall!(517);
    expect(stalled,'accepted true EOT must suppress recovery while its native prefix drains').not.toHaveBeenCalled();
  } finally { await f.destroy(); }
});


it('ending intent from a retired output cannot suppress a successor output stall', async () => {
  vi.useFakeTimers({ shouldClearNativeTimers: true });
  const f = await fixture(18, true), stalled = vi.fn(); f.player.on('stall', stalled);
  try {
    const old = await retainedHandoff(f, false);
    await f.server.publishDone(old.id, varint(2n), 'finished'); await flush(512);
    f.source.onStall!(517); expect(stalled).not.toHaveBeenCalled();
    await f.player.seek(6000); await flush(512);
    const next = await f.open(1, 2n, 0); await f.object(next, 0); await f.object(next, 1); await f.close(next); await flush(512);
    expect(f.resources).toHaveLength(2); expect(f.resources[0]!.current).toBe(false);
    expect(f.submissions).toHaveLength(5); f.complete(4); await flush(512);
    expect(f.submissions).toHaveLength(6); f.complete(5); await flush(512); f.land(6.125); await flush(1024);
    expect(f.seeked).toHaveBeenCalledTimes(2); expect(f.player.playbackPositionMs).toBe(6125);
    f.source.onStall!(517); expect(stalled).toHaveBeenCalledOnce();
    expect(f.errors).toEqual([]); expect(f.ended).not.toHaveBeenCalled();
  } finally { await f.destroy(); }
});


it('a complete empty catalog does not turn a draining finite output into a recovery stall', async () => {
  const f = await fixture(22, true), stalled = vi.fn(); f.player.on('stall', stalled);
  try {
    const sub = await retainedHandoff(f, false);
    const stream = await f.server.openSubgroup(100n, 1n, 0n);
    await f.server.sendObject(stream, 0n, enc.encode(JSON.stringify({ version: '1', isComplete: true, tracks: [] })));
    await f.server.closeSubgroup(stream); await flush(1024);
    vi.useFakeTimers(); await f.server.publishDone(sub.id, varint(2n), 'finished'); await flush(512);
    expect(f.ended).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    f.source.onStall!(517); expect(stalled).not.toHaveBeenCalled();
  } finally { await f.destroy(); }
});

it('earlier DONE2 intent survives acceptance of a non-EOT JOIN ending at saved J', async () => {
  const f=await fixture(18,true), stalled=vi.fn(); f.player.on('stall',stalled);
  try {
    await landHistory(f); const sub=await freshLiveSubscription(f); f.player.play();
    await acknowledgeLive(f,sub); expect(f.joins).toHaveLength(1);
    const join=f.joins[0]!, range=f.server.resolveJoiningFetch(join.id);
    // J is Object2; Object3 is the later final live Object. The finite JOIN
    // therefore correctly reports EndOfTrack=0, even though SUB is now done.
    await f.liveObject(3); expect(f.submissions).toHaveLength(2);
    vi.useFakeTimers(); await f.server.publishDone(sub.id,varint(2n),'finished'); await flush(512);
    expect(f.errors).toEqual([]); expect(f.ended).not.toHaveBeenCalled();
    f.source.onStall!(517); expect(stalled,'DONE2 must establish the fence before prefix acceptance').not.toHaveBeenCalled();
    await f.server.acceptFetch(join.id,{endOfTrack:0,endLocation:range.endLocation});
    const prefix=await f.server.openFetchStream(join.id);
    await f.object(prefix,0); await f.object(prefix,1); await f.object(prefix,2); await f.close(prefix); await flush(1024);
    expect(f.submissions).toHaveLength(3); expect(f.submissions[2]!.completed).toBe(false);
    expect(f.ended).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    f.source.onStall!(517);
    expect(stalled,'a non-EOT prefix ACK must not erase the earlier terminal subscription intent').not.toHaveBeenCalled();
  } finally { await f.destroy(); }
});
