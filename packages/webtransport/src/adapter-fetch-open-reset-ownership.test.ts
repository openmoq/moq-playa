import { expect, it } from 'vitest';
import { MoqtConnection } from './adapter.js';
import { createLoopback, flush } from './testkit/loopback.js';
import type { WebTransportLike } from './types.js';
const ns = [new TextEncoder().encode('live')], name = new TextEncoder().encode('video');
async function setup(draft: 18 | 22) {
  const { a, b } = createLoopback();
  let armed = false, allocations = 0, exposed = 0, resetEntered = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const failure = new Error('header completion rejected');
  const transport: WebTransportLike = {
    incomingUnidirectionalStreams: b.incomingUnidirectionalStreams,
    incomingBidirectionalStreams: b.incomingBidirectionalStreams,
    datagrams: b.datagrams, closed: b.closed, close: info => b.close(info),
    createBidirectionalStream: () => b.createBidirectionalStream(),
    createUnidirectionalStream: async () => {
      const w = await b.createUnidirectionalStream();
      if (armed && ++allocations === 1) {
        const get = w.getWriter.bind(w);
        w.getWriter = () => {
          const writer = get(), write = writer.write.bind(writer);
          writer.write = async bytes => { await write(bytes); exposed++; throw failure; };
          return writer;
        };
      }
      return w;
    },
    resetSendStream: async (writer, reason) => { resetEntered = true; await gate; await writer.abort(reason); },
  };
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  client.onError = server.onError = () => {};
  await Promise.all([client.connect(a), server.connect(transport)]);
  let id = -1n; server.onFetch = value => { id = value; };
  await client.fetch(ns, name, { startGroup: 1n, startObject: 0n, endGroup: 1n, endObject: 1n });
  await flush(64); expect(id).not.toBe(-1n);
  await server.acceptFetch(id, { endLocation: { group: 1n, object: 1n } }); armed = true;
  return { server, id, failure, release, state: () => ({ allocations, exposed, resetEntered }),
    async cleanup() { release(); await flush(64); await client.close(); await server.close(); await flush(32); } };
}
it.each([18, 22] as const)('draft%s refuses second FETCH allocation while exposed-header reset is held', async draft => {
  const p = await setup(draft);
  try {
    let settled = false;
    const first = p.server.openFetchStream(p.id).then(() => { settled = true; return null; }, e => { settled = true; return e; });
    await flush(64);
    expect(p.state().exposed).toBe(1); expect(settled).toBe(false);
    await expect(p.server.openFetchStream(p.id)).rejects.toThrow();
    expect(p.state().allocations).toBe(1);
    p.release(); expect(await first).toBe(p.failure);
  } finally { await p.cleanup(); }
});
it.each([22] as const)('draft%s exposed header spends the response allowance after reset completion too', async draft => {
  const p = await setup(draft);
  try {
    const first = p.server.openFetchStream(p.id).catch(e => e);
    await flush(64); expect(p.state().exposed).toBe(1);
    p.release(); expect(await first).toBe(p.failure);
    await expect(p.server.openFetchStream(p.id)).rejects.toThrow();
    expect(p.state().allocations).toBe(1);
  } finally { await p.cleanup(); }
});
