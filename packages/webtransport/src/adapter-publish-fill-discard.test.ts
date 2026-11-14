import { expect, expectTypeOf, it, vi } from 'vitest';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';
import { createControlCodec, encodeFillParameters } from '@openmoq/transport';
import type { IncomingPublish, MoqtConnection, WebTransportLike } from './index.js';

for (const beforeOk of [false, true]) it(`draft23 discards a PUBLISH fill ${beforeOk ? 'before' : 'after'} PUBLISH_OK`, async () => {
  const pair = await connectedPair(23);
  const createError = vi.fn((code: number) => Object.assign(new Error('cancelled'), { streamErrorCode: code }));
  (pair.a as WebTransportLike).createStreamError = createError;
  let incoming: IncomingPublish | undefined;
  const objects: bigint[] = [];
  pair.client.onPublish = publish => { incoming = publish; publish.onObject = object => { objects.push(object.objectId); }; };
  try {
    const id = await pair.server.publish(ns('fill'), nm('video'), 7n, {
      parameters: new Map([[0x23n, [encodeFillParameters()]]]),
    });
    await flush(128); expect(incoming).toBeDefined();
    if (!beforeOk) await pair.client.acceptSubscribe(id, 7n);
    const writer = (await pair.b.createUnidirectionalStream()).getWriter();
    await writer.write(Uint8Array.of(5, Number(id))); await flush(256);
    expect(pair.client.session.state).toBe('established');
    expect(pair.b.uniOut.at(-1)!.readCancelled).toBe(true);
    expect(createError).toHaveBeenCalledWith(1, expect.any(Error));
    if (beforeOk) await pair.client.acceptSubscribe(id, 7n);
    await flush(128);
    const sid = await pair.server.openSubgroup(7n, 1n, 0n);
    await pair.server.sendObject(sid, 0n, Uint8Array.of(1)); await pair.server.closeSubgroup(sid);
    await flush(128);
    expect(objects).toContain(0n); expect(pair.errors).toEqual([]);
    writer.releaseLock();
  } finally { await pair.client.close(); await pair.server.close(); }
});
// The existing public API admits authorization only, so it cannot promise these fills.
for (const draft of [18, 22, 23] as const) it(`draft${draft} SUBSCRIBE_TRACKS API cannot request fills`, async () => {
  type Options = NonNullable<Parameters<MoqtConnection['subscribeTracks']>[1]>;
  expectTypeOf<Options>().not.toHaveProperty('fill');
  expectTypeOf<Options>().not.toHaveProperty('parameters');
  const pair = await connectedPair(draft);
  try {
    await pair.client.subscribeTracks(ns('fill'));
    const message = createControlCodec(draft).decode(pair.a.bidiOut[0]!.out.writtenBytes(), 0).message;
    expect(message.type).toBe('SUBSCRIBE_TRACKS');
    if (message.type !== 'SUBSCRIBE_TRACKS') throw new Error('wrong opener');
    expect(message.parameters.has(0x23n)).toBe(false);
  } finally { await pair.client.close(); await pair.server.close(); }
});
