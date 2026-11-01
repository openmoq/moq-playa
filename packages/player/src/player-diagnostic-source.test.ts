import { describe, expect, it, vi } from 'vitest';
import { MoqtConnection, type WebTransportLike } from '@openmoq/webtransport';
import { TransportSim } from '../../webtransport/src/testkit/stream-sim.js';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { MoqtPlayer } from './player.js';

function fixture() {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(18), server = new MoqtConnection(18, {role:'server'});
  const requests: Array<{id: bigint; name: string}> = [];
  server.onSubscribe = (id, _namespace, name) => { requests.push({id,name:new TextDecoder().decode(name)}); };
  let serving: Promise<void> | undefined;
  const transportFactory=vi.fn<() => Promise<WebTransportLike>>(async()=>{serving=server.connect(b); void serving.catch(()=>{});return a;});
  const player = new MoqtPlayer({
    url:'https://user:secret@relay.example/moq?token=secret', namespace:['live/show'], draftVersion:18,
    createConnection:()=>client,
    createTransport:transportFactory,
    knownTracks:{video:{name:'video',codec:'av01.0.08M.08'}},disableAudio:true,
  });
  return {player,client,server,requests,transportFactory, async close(){await player.destroy();await server.close();await serving?.catch(()=>{});}};
}

describe('optional player diagnostic source boundary',()=>{
  it('offers an on-demand idle snapshot without starting a connection',async()=>{
    const h=fixture();
    try { const s=h.player.diagnosticSnapshot(); expect(s.destroyed).toBe(false);expect(s.state).toBe('idle');expect(s.connections).toEqual([]); }
    finally {await h.close();}
  });
  it('reports the actual connection before SETUP, preserves app callbacks and redacts the endpoint',async()=>{
    const h=fixture(), app=vi.fn(), seen:unknown[]=[];
    const connecting=vi.spyOn(h.client,'connect'), observed=vi.fn();
    const qlogRemovers:Array<()=>void>=[];
    const remove=h.player.observeConnections(event=>{
      observed(); seen.push(event);
      if(event.kind==='available') qlogRemovers.push(event.connection.observeQlogEvents(app));
    });
    try {
      await h.player.load();await flush(100);
      expect(seen).toContainEqual({kind:'available',connection:h.client,endpoint:{origin:'https://relay.example',path:'/moq'}});
      expect(observed.mock.invocationCallOrder[0]).toBeLessThan(connecting.mock.invocationCallOrder[0]!);
      await h.server.acceptSubscribe(h.requests.find(r=>r.name==='video')!.id,77n);await flush(100);
      expect(app.mock.calls.some(([e])=>e.type==='control_message_parsed'&&e.message.type==='SUBSCRIBE_OK')).toBe(true);
      const snapshot=h.player.diagnosticSnapshot();
      expect(snapshot.connections[0]?.connection).toBe(h.client);
      expect(JSON.stringify(snapshot.connections.map(c=>c.endpoint))).not.toContain('secret');
    } finally {remove();qlogRemovers.forEach(r=>r());await h.close();}
  });
  it('late attachment reports the current connection and copies track identities without payload/init data',async()=>{
    const h=fixture();
    try {
      await h.player.load();await flush(200);
      const before=h.player.diagnosticSnapshot();
      expect(before.subscriptions).toContainEqual(expect.objectContaining({name:'video',namespace:['live/show'],trackAlias:null}));
      const request = h.requests.find(r=>r.name==='video')!;
      await h.server.acceptSubscribe(request.id,77n);await flush(200);
      const seen=vi.fn();const remove=h.player.observeConnections(seen);
      expect(seen).toHaveBeenCalledWith({kind:'available',connection:h.client,endpoint:{origin:'https://relay.example',path:'/moq'}});
      const snapshot=h.player.diagnosticSnapshot();
      expect(snapshot.subscriptions).toContainEqual(expect.objectContaining({connection:h.client,requestId:request.id,trackAlias:77n,namespace:['live/show'],name:'video'}));
      (snapshot.subscriptions[0]!.namespace as string[])[0]='changed';
      expect(h.player.diagnosticSnapshot().subscriptions[0]!.namespace).toEqual(['live/show']);
      expect(snapshot.tracks.every(track=>!('initData' in track))).toBe(true);remove();
    } finally {await h.close();}
  });
  it('contains throwing observers and reports retirement without leaving listeners after destruction',async()=>{
    const h=fixture(), seen=vi.fn();
    const remove=h.player.observeConnections(event=>{seen(event.kind);throw new Error('diagnostic observer');});
    try {await h.player.load();await h.player.destroy();expect(seen.mock.calls.flat().filter(kind=>kind==='retired')).toHaveLength(1);expect(h.player.diagnosticSnapshot().destroyed).toBe(true);remove();remove();}
    finally {await h.close();}
  });
  it('does not build diagnostic snapshots when nobody observes the player',async()=>{
    const h=fixture();const snapshot=vi.spyOn(h.player,'diagnosticSnapshot');
    try {await h.player.load();expect(snapshot).not.toHaveBeenCalled();}
    finally {await h.close();}
  });
});

it('does not create a transport after an observation reentrantly destroys the player', async () => {
  const h=fixture(), connect=vi.spyOn(h.client,'connect');
  let stopped:Promise<void>|undefined;
  const remove=h.player.observeConnections(event=>{if(event.kind==='available') stopped=h.player.destroy();});
  try {
    await expect(h.player.load()).rejects.toThrow(/destroyed/);
    await stopped;
    expect(connect).not.toHaveBeenCalled();
    expect(h.transportFactory).not.toHaveBeenCalled();
  } finally {remove();await h.close();}
});

it('reports a candidate before its SETUP and does not create its transport after reentrant destruction', async () => {
  const h=fixture();const candidate=new MoqtConnection(18), connect=vi.spyOn(candidate,'connect'), seen=vi.fn();
  let destroyed:Promise<void>|undefined;
  const remove=h.player.observeConnections(event=>{
    if(event.kind==='available'&&event.connection===candidate){seen(event);destroyed=h.player.destroy();}
  });
  try {
    await h.player.load();const factoryCalls=h.transportFactory.mock.calls.length;
    h.transportFactory.mockImplementation(async()=>new TransportSim());
    await expect(h.player.migrate(candidate)).rejects.toThrow(/destroyed|aborted/i);
    await destroyed;
    expect(seen).toHaveBeenCalledOnce();expect(connect).not.toHaveBeenCalled();expect(h.transportFactory).toHaveBeenCalledTimes(factoryCalls);
  } finally {remove();await candidate.close();await h.close();}
});

it('replays an already playing connection to a newly installed media tracker', async () => {
  const { createMediaDiagnostics } = await import('./media-diagnostics.js');
  const h = fixture();
  let tracker: ReturnType<typeof createMediaDiagnostics> | undefined;
  const captured: object[] = [];
  try {
    await h.player.load(); await flush(100);
    const original = h.client.onObject;
    await h.server.acceptSubscribe(h.requests.find(r => r.name === 'video')!.id, 77n); await flush(100);
    tracker = createMediaDiagnostics({
      get currentConnection() { return h.client; },
      observeConnections: listener => h.player.observeConnections(listener),
    }, () => {});
    h.client.onObject = (stream, object) => {
      const context = tracker!.capture(h.client, object);
      if (context) captured.push(context);
      original?.(stream, object);
    };
    const stream = await h.server.openSubgroup(77n, 2n, 0n, { publisherPriority: 128 });
    await h.server.sendObject(stream, 0n, Uint8Array.of(1)); await flush(100);
    expect(captured).toHaveLength(1);
    expect(tracker.reconstruct(captured)).toBeDefined();
  } finally { tracker?.dispose(); await h.close(); }
});
