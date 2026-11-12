import { expect, it, vi } from 'vitest';
import { varint } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';

it.each([18, 22] as const)('draft%s DONE and FIN complete despite held STOP_SENDING', async draft => {
  const f = await connectedPair(draft);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let undo: { mockRestore(): void } | undefined;
  try {
    let count = 0;
    f.server.onSubscribe = id => { void f.server.acceptSubscribe(id, ++count === 1 ? 7n : 8n); };
    const target = await f.client.subscribeTrack(ns('bounded'), nm('target'));
    const sibling = await f.client.subscribeTrack(ns('bounded'), nm('sibling'));
    // Inject failure into the exact request reader while keeping real endpoints.
    const ctx = (f.server as unknown as { inboundRequestContexts: Map<bigint, { reader: ReadableStreamDefaultReader<Uint8Array> }> }).inboundRequestContexts.get(target.requestId)!;
    undo = vi.spyOn(ctx.reader, 'cancel').mockImplementation(() => held);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const done = f.server.publishDone(target.requestId, varint(2n), 'finished').then(() => { settled = true; });
    await flush(128);
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(true);
    await done;
    expect(f.server.session.state).toBe('established');
    const received: number[] = [];
    sibling.onObject = object => { if (object.kind === 'data') received.push(...object.payload); };
    const stream = await f.server.openSubgroup(8n, 0n, 0n);
    await f.server.sendObject(stream, 0n, Uint8Array.of(42));
    await f.server.closeSubgroup(stream);
    await flush(128);
    expect(received).toEqual([42]);
  } finally { release(); undo?.mockRestore(); vi.useRealTimers(); await f.client.close(); await f.server.close(); }
});
