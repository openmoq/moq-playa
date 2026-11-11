import { expect, it } from 'vitest';
import { decodeFillParameters, MessageParam, varint, type FillOptions, type Parameters } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
import { createLoopback, flush } from './testkit/loopback.js';

const ns = [new TextEncoder().encode('live')], name = new TextEncoder().encode('video');
const fill = (subscriberPriority: number): FillOptions => ({ subscriberPriority });
const nestedPriority = (parameters: Parameters): number | undefined => {
  const bytes = parameters.get(0x23n)?.[0];
  expect(bytes).toBeInstanceOf(Uint8Array);
  const decoded = decodeFillParameters(bytes as Uint8Array);
  const value = decoded.parameters.get(0x20n)?.[0];
  const priority = value?.kind === 'uint8' ? value.value : undefined;
  expect(decoded.subscriberPriority).toBe(priority);
  return priority;
};
async function pair(draft: 14 | 16 | 18 | 22 = 22) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  await Promise.all([client.connect(a), server.connect(b)]);
  server.setLargestLocationProvider(() => ({ group: 3n, object: 0n }));
  return { client, server, a, b, close: async () => { await client.close(); await server.close(); } };
}
it.each([0, 42, 255])('SUBSCRIBE carries distinct fill priority %s without changing subscription priority', async priority => {
  const p = await pair();
  try {
    let observed: Parameters | undefined;
    p.server.onMessage = message => { if (message.type === 'SUBSCRIBE') observed = message.parameters; };
    p.server.onSubscribe = id => { void p.server.acceptSubscribe(id, 7n); };
    await p.client.subscribe(ns, name, { subscriberPriority: varint(99n), fill: fill(priority) });
    await flush(128);
    expect(nestedPriority(observed!)).toBe(priority);
    expect(observed!.get(MessageParam.SUBSCRIBER_PRIORITY)?.[0]).toBe(99n);
  } finally { await p.close(); }
});
it.each(['subscribe', 'publish'] as const)('%s owner: update carries independent fill priority', async direction => {
  const p = await pair();
  try {
    let id: bigint;
    if (direction === 'subscribe') {
      p.server.onSubscribe = requestId => { void p.server.acceptSubscribe(requestId, 7n); };
      id = await p.client.subscribe(ns, name, { subscriberPriority: varint(99n) });
      await flush(128);
    } else {
      p.client.onPublish = pub => { void p.client.acceptSubscribe(pub.requestId, pub.trackAlias); };
      id = await p.server.publish(ns, name, 7n, { parameters: new Map([[MessageParam.SUBSCRIBER_PRIORITY, [varint(99n)]]]) });
      await flush(128);
    }
    let observed: Parameters | undefined;
    p.server.onMessage = message => { if (message.type === 'REQUEST_UPDATE') observed = message.parameters; };
    const updateId = await p.client.requestUpdate(id, { subscriberPriority: varint(100n), fill: fill(12) });
    await flush(128);
    expect(updateId).not.toBe(id);
    expect(nestedPriority(observed!)).toBe(12);
    expect(observed!.get(MessageParam.SUBSCRIBER_PRIORITY)?.[0]).toBe(100n);
    const nextId = await p.client.requestUpdate(id, { subscriberPriority: varint(101n), fill: {} });
    await flush(128);
    expect(nextId).not.toBe(updateId);
    expect(nestedPriority(observed!)).toBeUndefined();
    expect(observed!.get(MessageParam.SUBSCRIBER_PRIORITY)?.[0]).toBe(101n);
    await p.client.requestUpdate(id, { fill: fill(44) });
    await flush(128);
    expect(nestedPriority(observed!)).toBe(44);
    expect(observed!.has(MessageParam.SUBSCRIBER_PRIORITY)).toBe(false);
  } finally { await p.close(); }
});

it.each([14, 16, 18] as const)('draft %s refuses FILL rather than silently omitting its priority', async draft => {
 const p = await pair(draft);
 try { await expect(p.client.subscribe(ns, name, { fill: fill(12) })).rejects.toThrow(/FILL_PARAMETERS needs draft 22/); }
 finally { await p.close(); }
});
it.each([-1, 256, 1.5, NaN, Infinity])('invalid priority %s cannot dispatch SUBSCRIBE or update', async priority => {
 const p = await pair();
 try {
  const messages: string[] = [];
  p.server.onMessage = m => { if (m.type === 'SUBSCRIBE' || m.type === 'REQUEST_UPDATE') messages.push(m.type); };
  p.server.onSubscribe = id => { void p.server.acceptSubscribe(id, 7n); };
  await expect(p.client.subscribe(ns, name, { fill: fill(priority) })).rejects.toThrow(/Priority/);
  await flush(64); expect(messages).toEqual([]);
  const id = await p.client.subscribe(ns, name); await flush(64);
  await expect(p.client.requestUpdate(id, { fill: fill(priority) })).rejects.toThrow(/Priority/);
  await flush(64); expect(messages).toEqual(['SUBSCRIBE']);
 } finally { await p.close(); }
});
