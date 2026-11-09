import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoqtPlayer } from '@openmoq/player';
import { DiagnosticRegistry } from './registry.js';
import { decodeMessage, encodeMessage, PROTOCOL_VERSION } from '@openmoq/devtools-protocol';
import { installPlayerDiagnostics } from './player.js';

const common = { channel: 'openmoq-devtools', version: PROTOCOL_VERSION } as const;
function player() { return new MoqtPlayer({url:'https://relay.example/moq',namespace:'live'}); }
afterEach(()=>vi.useRealTimers());

describe('optional live player adapter',()=>{
  it('registers explicit exposure without starting detailed observation or sampling', async()=>{
    vi.useFakeTimers(); const engine=player(), registry=new DiagnosticRegistry();
    const observe=vi.spyOn(engine,'observeConnections'), stats=vi.spyOn(engine,'stats','get'), now=vi.fn(()=>1);
    const installation=installPlayerDiagnostics(engine,{registry,exposure:'production',clock:{id:'test',now}});
    try {
      expect(installation.source).toMatchObject({kind:'attached',exposure:'production'});
      expect(observe).not.toHaveBeenCalled();expect(stats).not.toHaveBeenCalled();expect(now).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2000);expect(stats).not.toHaveBeenCalled();expect(now).not.toHaveBeenCalled();
    } finally {installation.dispose();registry.dispose();await engine.destroy();}
  });
  it('collects at four Hz only while attached and stops fully on last detach',async()=>{
    vi.useFakeTimers();const engine=player(), registry=new DiagnosticRegistry();
    const observe=vi.spyOn(engine,'observeConnections'), stats=vi.spyOn(engine,'stats','get');
    const installation=installPlayerDiagnostics(engine,{registry,exposure:'development'});
    const owner=registry.open('owner');
    try {
      const frames=owner.request(encodeMessage({...common,kind:'attach',requestId:'attach',target:{ownerId:'owner',sourceId:installation.source.sourceId,runId:installation.source.runId}}));
      expect(decodeMessage(frames[0])).toMatchObject({ok:true,message:{kind:'snapshot'}});
      expect(observe).toHaveBeenCalledTimes(2);
      const start=stats.mock.calls.length;vi.advanceTimersByTime(1000);
      expect(stats.mock.calls.length-start).toBe(4);
      owner.close();const stopped=stats.mock.calls.length;vi.advanceTimersByTime(2000);
      expect(stats.mock.calls.length).toBe(stopped);expect(vi.getTimerCount()).toBe(0);
    } finally {owner.close();installation.dispose();registry.dispose();await engine.destroy();}
  });
  it('refuses duplicate facade/engine registration and preserves instance identity on reinstall',async()=>{
    const engine=player(),registry=new DiagnosticRegistry();
    const installed=installPlayerDiagnostics({diagnosticSource:engine},{registry,exposure:'development'});
    const first=installed.source;
    expect(()=>installPlayerDiagnostics(engine,{registry,exposure:'production'})).toThrow(/already/);
    installed.dispose();installed.dispose();
    const again=installPlayerDiagnostics(engine,{registry,exposure:'production'});
    try {expect(again.source.sourceId).toBe(first.sourceId);expect(again.source.runId).not.toBe(first.runId);}
    finally {again.dispose();registry.dispose();await engine.destroy();}
  });
  it('requires an explicit valid exposure and refuses a Probe registry',async()=>{
    const engine=player(), registry=new DiagnosticRegistry({sourceKind:'probe'});
    try {expect(()=>installPlayerDiagnostics(engine,{registry,exposure:'production'})).toThrow(/attached|Probe/);}
    finally {registry.dispose();await engine.destroy();}
  });
});

// Real protocol loopback: synthetic object bytes are observed, not decoded.
import { varint, encodeObjectDatagram18, encodeSubgroupHeader18, encodeSubgroupObject18 } from '@openmoq/transport';
import { MoqtConnection, catToken } from '@openmoq/webtransport';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import type { Fact, Message } from '@openmoq/devtools-protocol';
const text=new TextEncoder();
async function live(protocol?: string) {
  const {a,b}=createLoopback();const client=new MoqtConnection(18),server=new MoqtConnection(18,{role:'server'});
  if (protocol !== undefined) Object.defineProperty(a, 'protocol', { value: protocol });
  let videoId:bigint|undefined;
  const credentials:string[]=[];
  server.onSubscribe=(id,_ns,name,parameters)=>{const credential=parameters.get(3n)?.[0];if(credential instanceof Uint8Array)credentials.push(new TextDecoder().decode(credential));if(new TextDecoder().decode(name)==='video'){videoId=id;void server.acceptSubscribe(id,77n);}};
  let serving:Promise<void>|undefined;
  const engine=new MoqtPlayer({url:'https://relay.example/moq?token=secret-query',namespace:['live/show'],draftVersion:18,
    knownTracks:{video:{name:'video',codec:'av01.0.08M.08'}},disableAudio:true,
    authorization:{getTokens:()=>[catToken(text.encode('secret-auth-token'))]},createConnection:()=>client,
    createTransport:async()=>{serving=server.connect(b);void serving.catch(()=>{});return a;}});
  await engine.load();await flush(200);
  return {engine,client,server,credentials,transport:b,get videoId(){return videoId!;},async send(endOfGroup=false){const stream=await server.openSubgroup(77n,9007199254740993n,0n,{publisherPriority:128,endOfGroup});await server.sendObject(stream,0n,text.encode('secret-media-payload'));await server.closeSubgroup(stream);await flush(200);},
    async close(){await engine.destroy();await server.close();await serving?.catch(()=>{});}};
}
function messages(encoded:readonly string[]):Message[]{return encoded.map(raw=>{const d=decodeMessage(raw);if(!d.ok)throw new Error('invalid response');return d.message;});}
function facts(msgs:readonly Message[]):Fact[]{return msgs.flatMap(m=>m.kind==='snapshot'?m.facts.map(v=>v.fact):m.kind==='batch'?m.events.map(v=>v.fact):[]);}
function attach(registry:DiagnosticRegistry,source:{sourceId:string;runId:string}){
  const owner=registry.open('owner');const replies=messages(owner.request(encodeMessage({...common,kind:'attach',requestId:'attach',target:{ownerId:'owner',...source}})));
  const snapshot=replies.find(m=>m.kind==='snapshot');if(!snapshot||snapshot.kind!=='snapshot')throw new Error('attach failed');
  return {owner,snapshot,drain(){const result:Message[]=[];for(let i=0;i<100;i++){const raw=owner.pull();if(raw===null)break;result.push(...messages([raw]));}return result;}};
}

it.each([
  ['moqt-18', 'transport'],
  ['', 'configured'],
  ['unrelated-protocol', 'configured'],
] as const)('labels the draft evidence for protocol %j accurately', async (protocol, evidence) => {
  const h = await live(protocol), registry = new DiagnosticRegistry();
  const installed = installPlayerDiagnostics(h.engine, { registry, exposure: 'development' });
  const attached = attach(registry, installed.source);
  try {
    const session = facts([attached.snapshot]).find(fact => fact.kind === 'session');
    expect(session).toMatchObject({ kind: 'session', draft: 18, draftEvidence: evidence, negotiatedProtocol: protocol || null });
  } finally { attached.owner.close(); installed.dispose(); registry.dispose(); await h.close(); }
});

it('keeps the actual session identity across detach and reattach',async()=>{
  const h=await live(),registry=new DiagnosticRegistry();
  const installed=installPlayerDiagnostics(h.engine,{registry,exposure:'production'});
  try{
    const first=attach(registry,installed.source);const firstSession=facts([first.snapshot]).find(f=>f.kind==='session');first.owner.close();
    const second=attach(registry,installed.source);const secondSession=facts([second.snapshot]).find(f=>f.kind==='session');
    expect(firstSession?.kind).toBe('session');expect(secondSession).toMatchObject({kind:'session',sessionId:firstSession?.kind==='session'?firstSession.sessionId:null});
    second.owner.close();
  }finally{installed.dispose();registry.dispose();await h.close();}
});

it('observes exact real object identity without retaining payloads, init or credentials',async()=>{
  const h=await live(),registry=new DiagnosticRegistry();const installed=installPlayerDiagnostics(h.engine,{registry,exposure:'production'});
  const attached=attach(registry,installed.source);
  try{
    expect(h.credentials.some(value=>value.includes('secret-auth-token'))).toBe(true);
    await h.send();const observed=facts([attached.snapshot,...attached.drain()]);
    const object=observed.find(f=>f.kind==='object');expect(object).toMatchObject({kind:'object',requestId:String(h.videoId),trackAlias:'77',groupId:'9007199254740993',objectId:'0',payloadBytes:20,streamId:null});
    const encoded=JSON.stringify(observed);for(const secret of ['secret-query','secret-auth-token','secret-media-payload'])expect(encoded).not.toContain(secret);
    const binding=observed.find(f=>f.kind==='request'&&f.requestId===String(h.videoId));expect(binding).toMatchObject({state:'accepted',trackAlias:'77'});
    const track=observed.find(f=>f.kind==='track'&&f.displayName==='video');expect(track).toMatchObject({identity:{namespace:['6c6976652f73686f77'],name:'766964656f'}});
  }finally{attached.owner.close();installed.dispose();registry.dispose();await h.close();}
});

it('records sanitized live observations through the owned recorder hook and exports valid bounded qlog',async()=>{
  const h=await live(),registry=new DiagnosticRegistry();const clock={id:'record',value:5,now(){return this.value;}};
  const installed=installPlayerDiagnostics(h.engine,{registry,exposure:'production',clock});
  const attached=attach(registry,installed.source);
  const request=(message:Record<string,unknown>)=>messages(attached.owner.request(encodeMessage({...common,target:attached.snapshot.target,...message} as Message)));
  try{
    const started=request({kind:'record.start',requestId:'record'}).find(m=>m.kind==='record.started');
    if(!started||started.kind!=='record.started')throw new Error('recording did not start');
    await h.send();
    request({kind:'record.stop',requestId:'stop',recordingId:started.recordingId,token:started.token});
    const replies=request({kind:'record.export',requestId:'export',recordingId:started.recordingId,token:started.token});
    let data='';let final=false;
    for(let i=0;i<100;i++){
      for(const reply of replies.splice(0))if(reply.kind==='export.chunk'){data+=reply.data;final=reply.final;}
      if(final)break;
      const raw=attached.owner.pull();if(raw!==null)replies.push(...messages([raw]));
    }
    expect(final).toBe(true);expect(new TextEncoder().encode(data).byteLength).toBeLessThan(8*1024*1024);
    const records=data.split('\x1e').map(part=>part.trim()).filter(Boolean).map(part=>JSON.parse(part));
    expect(records[0].file_schema).toBe('urn:ietf:params:qlog:file:sequential');
    expect(records.slice(1).every(record=>typeof record.time==='number')).toBe(true);
    expect(records.some(record=>record.name==='loglevel:info'&&record.data.message.includes('[devtools_observation:v1]')&&record.data.message.includes('"kind":"object"'))).toBe(true);
    for(const secret of ['secret-query','secret-auth-token','secret-media-payload'])expect(data).not.toContain(secret);
  }finally{attached.owner.close();installed.dispose();registry.dispose();await h.close();}
});

it('observes actual video-frame callbacks only while attached and cancels them on detach',async()=>{
  vi.useFakeTimers();const engine=player(),registry=new DiagnosticRegistry();
  let callback:((now:number,metadata:{mediaTime:number;presentedFrames:number})=>void)|undefined;
  let serial=0;
  const video={currentTime:12,buffered:{length:1,start:()=>0,end:()=>20},paused:false,seeking:false,ownerDocument:{visibilityState:'visible'},
    requestVideoFrameCallback:vi.fn((fn:NonNullable<typeof callback>)=>{callback=fn;return ++serial;}),cancelVideoFrameCallback:vi.fn()};
  const installed=installPlayerDiagnostics(engine,{registry,exposure:'production',video});
  expect(video.requestVideoFrameCallback).not.toHaveBeenCalled();
  const attached=attach(registry,installed.source);
  try{
    expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(1);
    callback!(0,{mediaTime:11.97,presentedFrames:42});vi.advanceTimersByTime(250);
    const observed=facts(attached.drain());
    expect(observed).toContainEqual(expect.objectContaining({kind:'metric',name:'video_presented_frames',value:42,unavailable:null}));
    expect(observed).toContainEqual(expect.objectContaining({kind:'metric',name:'video_buffer_ahead',value:8}));
    attached.owner.close();expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(2);const calls=video.requestVideoFrameCallback.mock.calls.length;
    callback!(300,{mediaTime:12.3,presentedFrames:43});vi.advanceTimersByTime(1000);expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(calls);expect(vi.getTimerCount()).toBe(0);
  }finally{attached.owner.close();installed.dispose();registry.dispose();await engine.destroy();}
});


it('reports a FIN-derived bound without allocating an object delivery for the marker', async () => {
  const h = await live(), registry = new DiagnosticRegistry();
  const installed = installPlayerDiagnostics(h.engine, { registry, exposure: 'development' });
  const attached = attach(registry, installed.source);
  try {
    await h.send(true);
    const observed = facts(attached.drain());
    const bounds = observed.filter(fact => fact.kind === 'group_bound');
    expect(bounds).toEqual([expect.objectContaining({ kind: 'group_bound', trackAlias: '77', groupId: '9007199254740993', objectId: '1', bound: 'exclusive', evidence: 'end-of-group' })]);
    expect(bounds[0]).not.toHaveProperty('deliveryId');
    expect(observed.filter(fact => fact.kind === 'object')).toEqual([expect.objectContaining({ objectId: '0', objectStatus: '0' })]);
  } finally { attached.owner.close(); installed.dispose(); registry.dispose(); await h.close(); }
});


it('reports the exact received delivery as discarded when its successor range excludes it', async () => {
  const h = await live(), registry = new DiagnosticRegistry();
  const installed = installPlayerDiagnostics(h.engine, { registry, exposure: 'development' });
  const attached = attach(registry, installed.source);
  const writer = h.transport.datagrams.writable!.getWriter();
  try {
    await h.client.unsubscribe(h.videoId); await flush(100);
    await h.client.subscribe([text.encode('live/show')], text.encode('video'), { subscriptionFilter: { type: 'AbsoluteStart', startGroup: 10n, startObject: 0n } });
    await flush(100);
    for (const group of [9n, 10n]) {
      await writer.write(encodeObjectDatagram18({ typeByte: 0, trackAlias: 77n, groupId: group, objectId: 0n, publisherPriority: 128,
        payload: Uint8Array.of(1), extensions: undefined, status: undefined, isEndOfGroup: false }));
      await flush(100);
    }
    const observed = facts(attached.drain());
    const objects = observed.filter(fact => fact.kind === 'object');
    expect(objects.map(object => object.groupId)).toEqual(['9', '10']);
    expect(observed.filter(fact => fact.kind === 'stage')).toEqual([
      { kind: 'stage', deliveryId: objects[0]!.deliveryId, unitId: null, stage: 'discarded', reason: 'subscription policy' },
    ]);
  } finally { writer.releaseLock(); attached.owner.close(); installed.dispose(); registry.dispose(); await h.close(); }
});

it('keeps a parsed status object distinct from a FIN-derived group bound', async () => {
  const h = await live(), registry = new DiagnosticRegistry();
  const installed = installPlayerDiagnostics(h.engine, { registry, exposure: 'development' });
  const attached = attach(registry, installed.source);
  const writer = (await h.transport.createUnidirectionalStream()).getWriter();
  try {
    await writer.write(encodeSubgroupHeader18({ typeByte: 0x50, trackAlias: 77n, groupId: 9n, subgroupId: 0n,
      publisherPriority: 128, hasExtensions: false, isEndOfGroup: false, isFirstObjectInSubgroup: true }));
    await writer.write(encodeSubgroupObject18({ objectId: 0n, payload: new Uint8Array(), extensions: undefined, status: 3n }, false, 0n, true));
    await writer.close(); await flush(100);
    const observed = facts(attached.drain());
    expect(observed.filter(fact => fact.kind === 'group_bound')).toEqual([]);
    expect(observed.filter(fact => fact.kind === 'object')).toEqual([expect.objectContaining({ objectId: '0', objectStatus: '3', payloadBytes: 0 })]);
  } finally { writer.releaseLock(); attached.owner.close(); installed.dispose(); registry.dispose(); await h.close(); }
});

it.each([null, 0xffffffffffffffffn])('keeps live-player FIN bounds representable and evidence-based (last=%s)', async last => {
  const h = await live(), registry = new DiagnosticRegistry();
  const installed = installPlayerDiagnostics(h.engine, { registry, exposure: 'development' });
  const attached = attach(registry, installed.source);
  const writer = (await h.transport.createUnidirectionalStream()).getWriter();
  try {
    await writer.write(encodeSubgroupHeader18({ typeByte: 0x58, trackAlias: 77n, groupId: 9n, subgroupId: 0n,
      publisherPriority: 128, hasExtensions: false, isEndOfGroup: true, isFirstObjectInSubgroup: true }));
    if (last !== null) await writer.write(encodeSubgroupObject18({ objectId: last, payload: Uint8Array.of(1), extensions: undefined, status: undefined }, false, 0n, true));
    await writer.close(); await flush(100);
    const observed = facts(attached.drain());
    expect(observed.filter(fact => fact.kind === 'group_bound')).toEqual(last === null ? [] : [
      expect.objectContaining({ objectId: String(last), bound: 'inclusive', evidence: 'end-of-group' }),
    ]);
    expect(observed.filter(fact => fact.kind === 'object')).toHaveLength(last === null ? 0 : 1);
  } finally { writer.releaseLock(); attached.owner.close(); installed.dispose(); registry.dispose(); await h.close(); }
});

import { liveLocFixture } from '../../player/test-support/live-loc.js';
import { videoInit } from '../../locmaf/test-support/cmaf.js';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';

describe('destroy lifecycle finalization', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function inspect(engine: Parameters<typeof installPlayerDiagnostics>[0]) {
    const registry = new DiagnosticRegistry();
    const installation = installPlayerDiagnostics(engine, { registry, exposure: 'development' });
    const owner = registry.open('owner');
    const discover = () => decodeMessage(owner.request(encodeMessage({
        channel: 'openmoq-devtools', version: PROTOCOL_VERSION,
        kind: 'discover', requestId: 'd', ownerId: 'owner',
    }))[0]!);
    expect(discover()).toMatchObject({ ok: true, message: { sources: [{ sourceId: installation.source.sourceId }] } });
    return { discover, close() { installation.dispose(); owner.close(); registry.dispose(); } };
}

it('normal destroy removes the registry source', async () => {
    const engine = new MoqtPlayer({ url: 'https://relay.invalid/moq', namespace: 'live' });
    const view = inspect(engine);
    try {
        await engine.destroy();
        expect(engine.diagnosticSnapshot().destroyed).toBe(true);
        expect(view.discover()).toMatchObject({ ok: true, message: { sources: [] } });
    } finally { view.close(); await engine.destroy(); }
});

it('reentrant load destruction removes the registry without a delivered ENDED event', async () => {
    const transport = vi.fn(async () => { throw new Error('No transport is needed after destruction'); });
    const engine = new MoqtPlayer({ url: 'https://relay.invalid/moq', namespace: 'live', createTransport: transport });
    const view = inspect(engine);
    let destroyed: Promise<void> | undefined;
    engine.on('state_changed', ({ to }) => { if (to === 'loading') destroyed = engine.destroy(); });
    try {
        await engine.load().catch(() => {}); await destroyed;
        expect(destroyed).toBeDefined();
        expect(engine.diagnosticSnapshot().destroyed).toBe(true);
        expect(transport).not.toHaveBeenCalled();
        expect(view.discover()).toMatchObject({ ok: true, message: { sources: [] } });
    } finally { view.close(); await engine.destroy(); }
});

it('a throwing ENDED listener cannot retain the destroyed registry source', async () => {
    const engine = new MoqtPlayer({ url: 'https://relay.invalid/moq', namespace: 'live' });
    engine.on('state_changed', ({ to }) => { if (to === 'ended') throw new Error('application ENDED fault'); });
    const view = inspect(engine);
    try {
        await expect(engine.destroy()).rejects.toThrow('application ENDED fault');
        await engine.destroy();
        expect(engine.diagnosticSnapshot().destroyed).toBe(true);
        expect(view.discover()).toMatchObject({ ok: true, message: { sources: [] } });
    } finally { view.close(); await engine.destroy(); }
});

it('a public media adapter teardown fault cannot retain the destroyed registry source', async () => {
    let armed = false, faults = 0;
    const f = await liveLocFixture({ disableAudio: true,
        createCmafAssembler: callbacks => new CmafAssembler(callbacks),
        catalog: { tracks: [{ name: 'v', role: 'video', isLive: true, codec: 'avc1.640028',
            packaging: 'cmaf', altGroup: 7, bitrate: 100,
            initData: Buffer.from(videoInit()).toString('base64'),
        }] },
        createMediaSource: () => ({
            initialize: () => true, appendChunk() {}, reset() {}, endOfStream() {}, destroy() {},
            mediaElement: null, onFirstFrame: null, onError: null, onStall: null,
            setPlaybackIntent(intent) {
                if (armed && !intent) { faults++; throw new Error('custom media teardown fault'); }
            },
        }),
    });
    const view = inspect(f.player);
    try {
        armed = true;
        await expect(f.player.destroy()).rejects.toThrow('custom media teardown fault');
        await f.player.destroy();
        expect(faults).toBe(1);
        expect(f.player.diagnosticSnapshot().destroyed).toBe(true);
        expect(view.discover()).toMatchObject({ ok: true, message: { sources: [] } });
    } finally {
        armed = false; view.close();
        await f.client.close(); await f.close();
    }
});

it('destroy observers run once; detached and late observers stay detached', async () => {
    const engine = player();
    const detached = vi.fn(), late = vi.fn();
    const remove = engine.observeDestroy(detached);
    remove(); remove();
    const observed = vi.fn(() => {
        void engine.destroy();
        engine.observeDestroy(late);
    });
    const removeObserved = engine.observeDestroy(observed);
    try {
        await engine.destroy(); await engine.destroy();
        removeObserved();
        expect(observed).toHaveBeenCalledTimes(1);
        expect(detached).not.toHaveBeenCalled();
        expect(late).not.toHaveBeenCalled();
    } finally { await engine.destroy(); }
});

it('a throwing destroy observer cannot block a later observer or repeated teardown', async () => {
    const engine = player();
    const failure = vi.fn(() => { throw new Error('observer fault'); });
    const later = vi.fn();
    engine.observeDestroy(failure); engine.observeDestroy(later);
    try {
        await expect(engine.destroy()).resolves.toBeUndefined();
        await engine.destroy();
        expect(failure).toHaveBeenCalledTimes(1);
        expect(later).toHaveBeenCalledTimes(1);
    } finally { await engine.destroy(); }
});

it('the destroy hook runs once even when final ENDED publication throws', async () => {
    const engine = player(), observed = vi.fn();
    engine.observeDestroy(observed);
    engine.on('state_changed', ({ to }) => { if (to === 'ended') throw new Error('ENDED publication fault'); });
    try {
        await expect(engine.destroy()).rejects.toThrow('ENDED publication fault');
        await engine.destroy();
        expect(observed).toHaveBeenCalledTimes(1);
    } finally { await engine.destroy(); }
});

});

it('does not invent an alias binding for an observed FETCH receipt', async () => {
  const h = await live(), registry = new DiagnosticRegistry();
  const installed = installPlayerDiagnostics(h.engine, { registry, exposure: 'development' });
  const attached = attach(registry, installed.source);
  const received: unknown[] = [];
  try {
    const id = await h.client.fetch([text.encode('live/show')], text.encode('video'), {
      startGroup: varint(7n), startObject: varint(0n), endGroup: varint(7n), endObject: varint(1n),
      receiver: { onObject: object => { received.push(object); } },
    });
    await flush(100);
    await h.server.acceptFetch(id, { endLocation: { group: 7n, object: 1n } });
    const stream = await h.server.openFetchStream(id);
    await h.server.sendFetchObject(stream, { groupId: 7n, subgroupId: 0n, objectId: 0n,
      publisherPriority: 128, payload: Uint8Array.of(1) });
    await h.server.closeFetchStream(stream); await flush(200);
    expect(received).toHaveLength(1);
    expect(h.client.objectReceiptFor(received[0] as object)).toBeDefined();
    const observed = attached.drain();
    expect(facts(observed).filter(fact => fact.kind === 'object')).toEqual([]);
    for (const message of observed) if (message.kind === 'batch') {
      expect(message.dropped).toEqual({ dense: '0', sparse: '0' });
    }
    // Subscription-backed observations still retain their proven alias.
    await h.send();
    expect(facts(attached.drain()).filter(fact => fact.kind === 'object')).toEqual([
      expect.objectContaining({ trackAlias: '77' }),
    ]);
  } finally { attached.owner.close(); installed.dispose(); registry.dispose(); await h.close(); }
});
