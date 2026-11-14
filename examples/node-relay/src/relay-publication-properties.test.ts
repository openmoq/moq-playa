import { expect, it, vi } from 'vitest';
import { MoqtConnection, type IncomingPublish } from '@openmoq/webtransport';
import { MessageParam, type ControlMessage, type TrackProperties } from '@openmoq/transport';
import { Relay } from './relay.js';
import { createLoopback, flush } from '../../../packages/webtransport/src/testkit/loopback.js';
import { varint } from '@openmoq/transport';
const ns = [new TextEncoder().encode('demo')], name = new TextEncoder().encode('objects');
async function pair(draft: 18 | 22, relay: Relay) {
  const { a, b } = createLoopback(); const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  relay.setupConnection(server);
  await Promise.all([client.connect(a, { maxRequestId: varint(1000n) }), server.connect(b, { maxRequestId: varint(1000n) })]); return { client, server };
}
async function fixture(draft: 18 | 22) {
  const relay = new Relay(), old = await pair(draft, relay), viewer = await pair(draft, relay); const peers = [old, viewer], tasks: Promise<void>[] = [];
  old.server.onPublish = pub => { tasks.push(relay.handlePublish(old.server, pub)); };
  viewer.server.onFetch = (id, request) => { tasks.push(relay.handleFetch(viewer.server, id, request)); };
  await old.client.publish(ns, name, 9n); await flush(128); await Promise.all(tasks);
  const sid = await old.client.openSubgroup(9n, 4n, 0n, { endOfGroup: true });
  await old.client.sendObject(sid, 0n, Uint8Array.of(4, 0)); await old.client.sendObject(sid, 1n, Uint8Array.of(4, 1)); await old.client.closeSubgroup(sid); await flush(128);
  const fetch = async (group = 4n) => {
    const data: string[] = [], terminal: string[] = [], messages: ControlMessage[] = [];
    viewer.client.onMessage = m => { messages.push(m); };
    await viewer.client.fetch(ns, name, { startGroup: group, startObject: 0n, endGroup: group, endObject: 2n,
      receiver: { onObject: o => { if (o.kind === 'data') data.push(`${o.groupId}/${o.objectId}`); }, onClosed: t => { terminal.push(t); } } });
    await flush(128); return { data, terminal, messages };
  };
  const replacement = async (properties?: TrackProperties, mutate?: (pub: IncomingPublish, conn: MoqtConnection) => void, clearMessage = false) => {
    const peer = await pair(draft, relay); peers.push(peer);
    if (clearMessage) peer.server.onMessage = m => { if (m.type === 'PUBLISH') m.trackProperties?.clear(); };
    const accept = vi.spyOn(peer.server, 'acceptSubscribe'), reject = vi.spyOn(peer.server, 'rejectSubscribe');
    const work: Promise<void>[] = [];
    peer.server.onPublish = pub => { mutate?.(pub, peer.server); work.push(relay.handlePublish(peer.server, pub)); };
    await peer.client.publish(ns, name, 9n, { parameters: new Map([[MessageParam.LARGEST_OBJECT, [{ group: 9n, object: 9n }]]]),
      ...(properties ? { trackProperties: properties } : {}) }); await flush(128); await Promise.all(work); await flush(128);
    return { peer, accept, reject };
  };
  return { viewer, fetch, replacement, settle: async () => { await Promise.all(tasks); await flush(128); },
    close: async () => { await Promise.all(peers.flatMap(p => [p.client.close(), p.server.close()])); await Promise.all(tasks); } };
}
for (const draft of [18, 22] as const) for (const duration of [0n, 1000n]) {
  it(`draft${draft} MAX_CACHE_DURATION=${duration} refuses before replacing an active cached plan`, async () => {
    const f = await fixture(draft); let release!: () => void; const gate = new Promise<void>(yes => { release = yes; });
    const original = f.viewer.server.acceptFetch.bind(f.viewer.server);
    const accept = vi.spyOn(f.viewer.server, 'acceptFetch').mockImplementationOnce(async (...args) => { await gate; return original(...args); });
    try {
      const pending = await f.fetch(); const replacement = await f.replacement(new Map([[0x04n, [duration]]]), undefined, true);
      expect(replacement.accept).not.toHaveBeenCalled(); expect(replacement.reject.mock.calls[0]?.[1]).toBe(3n);
      release(); await f.settle(); expect(pending.data).toEqual(['4/0', '4/1']); expect(pending.terminal).toEqual(['fin']);
      accept.mockRestore(); const beyond = await f.fetch(9n); await f.settle();
      expect(beyond.messages.find(m => m.type === 'REQUEST_ERROR')).toMatchObject({ errorCode: 0x11n });
    } finally { release(); accept.mockRestore(); await f.close(); }
  });
}
for (const draft of [18, 22] as const) for (const mode of ['missing', 'throw'] as const) {
  it(`draft${draft} external metadata getter ${mode} cannot replace predecessor`, async () => {
    const f = await fixture(draft);
    try {
      const replacement = await f.replacement(undefined, (pub, conn) => {
        Object.defineProperty(pub, 'initialTrackProperties', { get() {
          if (mode === 'throw') throw new Error('external metadata getter');
          return mode === 'missing' ? undefined : new Map();
        } });
      });
      expect(replacement.accept).not.toHaveBeenCalled();
      if (mode === 'missing' || mode === 'throw') expect(replacement.reject.mock.calls[0]?.[1]).toBe(3n);
      const retained = await f.fetch(); await f.settle(); expect(retained.data).toEqual(['4/0', '4/1']); expect(retained.terminal).toEqual(['fin']);
    } finally { await f.close(); }
  });
}
for (const draft of [18, 22] as const) it(`draft${draft} known empty metadata allows a normal replacement`, async () => {
  const f = await fixture(draft);
  try { const replacement = await f.replacement(); expect(replacement.accept).toHaveBeenCalledOnce(); expect(replacement.reject).not.toHaveBeenCalled(); }
  finally { await f.close(); }
});
for (const draft of [18,22] as const) it(`evaluation immutable MAX_CACHE_DURATION draft${draft}`, async()=> {
 const f=await fixture(draft); try {
 const replacement=await f.replacement(new Map([[0x0bn,[Uint8Array.of(4,0)]]]));
 expect(replacement.peer.server.session.state).toBe('established');
 expect(replacement.accept).not.toHaveBeenCalled();
 expect(replacement.reject.mock.calls[0]?.[1]).toBe(3n);
 } finally {await f.close();}
});
