import { expect, it } from 'vitest';
import { createControlCodec, MessageParam, locationEncodingLength, writeLocation, varint, type Parameters } from '@openmoq/transport';
import type { IncomingPublish } from './adapter.js';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';
import { object, streamHeader } from './testkit/object-reception.js';

function parameters(draft: 16 | 18 | 22): Parameters {
  if (draft !== 16) return new Map([[MessageParam.LARGEST_OBJECT, [{ group: 8n, object: 2n }]]]);
  const bytes = new Uint8Array(locationEncodingLength({ group: 8n, object: 2n }));
  writeLocation({ group: 8n, object: 2n }, bytes, 0);
  return new Map([[MessageParam.LARGEST_OBJECT, [bytes]]]);
}
for (const draft of [16, 18, 22] as const) {
  for (const terminal of ['refusal', 'session-close', 'done'] as const) {
    it(`draft${draft} IncomingPublish ${terminal} fulfills one immutable final head`, async () => {
      const f = await connectedPair(draft);
      let pub: IncomingPublish | undefined;
      f.server.onPublish = incoming => { pub = incoming; };
      try {
        const id = await f.client.publish(ns('lifetime'), nm('video'), 41n, { parameters: parameters(draft) });
        await flush(128);
        expect(pub).toBeDefined();
        expect(pub!.closed).toBeInstanceOf(Promise);
        expect(pub!.largestLocation).toEqual({ groupId: 8n, objectId: 2n });
        const first = pub!.largestLocation;
        expect(first).not.toBe(pub!.largestLocation);
        expect(Reflect.set(first!, 'groupId', 99n)).toBe(false);
        let calls = 0;
        let final: unknown;
        void pub!.closed.then(snapshot => { calls++; final = snapshot; });
        await flush(64);
        expect(calls).toBe(0);
        if (terminal === 'refusal') await f.server.rejectSubscribe(id, 0x10n, 'not available');
        else if (terminal === 'session-close') await f.server.close();
        else {
          if (terminal === 'done') { await f.server.acceptSubscribe(id, 41n); await flush(128); }
          await f.client.publishDone(id, varint(0n), 'finished');
        }
        await flush(128);
        expect(calls).toBe(1);
        expect(final).toEqual({ largestLocation: { groupId: 8n, objectId: 2n } });
        expect(Object.isFrozen(final)).toBe(true);
        expect(pub!.largestLocation).toEqual({ groupId: 8n, objectId: 2n });
        await f.server.close(); await flush(64);
        expect(calls).toBe(1);
      } finally { await f.client.close(); await f.server.close(); }
    });
  }
}

for (const draft of [18, 22] as const) {
  it(`draft${draft} unpolled partial head survives retirement before reactions and cannot be mutated`, async () => {
    const f = await connectedPair(draft);
    let pub: IncomingPublish | undefined;
    f.server.onPublish = incoming => { pub = incoming; };
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    try {
      const id = await f.client.publish(ns('unpolled'), nm('video'), 41n); await flush(128);
      writer = (await f.a.createUnidirectionalStream()).getWriter();
      await writer.write(streamHeader(draft, { trackAlias: 41n, groupId: 9n }));
      const bytes = object(draft, 2n, new Uint8Array([1, 2, 3, 4]), null);
      await writer.write(bytes.subarray(0, bytes.length - 3)); await flush(128);
      let callbackHead: unknown;
      let reacted = false;
      void pub!.closed.then(snapshot => {
        expect(Reflect.set(snapshot, 'largestLocation', null)).toBe(false);
        expect(Reflect.set(snapshot.largestLocation!, 'groupId', 99n)).toBe(false);
      });
      void pub!.closed.then(snapshot => { reacted = true; callbackHead = snapshot.largestLocation; });
      const rejecting = f.server.rejectSubscribe(id, 0x10n, 'no longer available');
      expect(reacted).toBe(false);
      expect(pub!.largestLocation).toEqual({ groupId: 9n, objectId: 2n });
      await rejecting; await flush(128);
      expect(callbackHead).toEqual({ groupId: 9n, objectId: 2n });
      expect(f.server.session.getIncomingSubscription(id)).toBeUndefined();
    } finally { if (writer) await writer.abort().catch(() => {}); await f.client.close(); await f.server.close(); }
  });
  it(`draft${draft} request reset settles an empty snapshot without rejecting`, async () => {
    const f = await connectedPair(draft);
    let pub: IncomingPublish | undefined;
    f.server.onPublish = incoming => { pub = incoming; };
    try {
      await f.client.publish(ns('reset'), nm('video'), 41n); await flush(128);
      const result = pub!.closed;
      expect(pub!.largestLocation).toBeNull();
      f.a.bidiOut[0]!.out.reset(0);
      await flush(128);
      await expect(result).resolves.toEqual({ largestLocation: null });
      expect(pub!.largestLocation).toBeNull();
    } finally { await f.client.close(); await f.server.close(); }
  });
}

it('shared22 retires the exact PUBLISH while its sibling continues receiving', async () => {
  const f = await connectedPair(22);
  const pubs: IncomingPublish[] = [];
  f.server.onPublish = pub => { pubs.push(pub); void f.server.acceptSubscribe(pub.requestId, pub.trackAlias); };
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  try {
    const first = await f.client.publish(ns('shared'), nm('video'), 41n);
    await f.client.publish(ns('shared'), nm('video'), 41n); await flush(128);
    writer = (await f.a.createUnidirectionalStream()).getWriter();
    await writer.write(streamHeader(22, { trackAlias: 41n, groupId: 7n }));
    await writer.write(object(22, 2n, new Uint8Array([1]), null)); await flush(128);
    let endedA = 0, endedB = 0;
    void pubs[0]!.closed.then(() => { endedA++; });
    void pubs[1]!.closed.then(() => { endedB++; });
    // Raw stream is a deliberately shared carrier; public DONE has no owned stream reservation.
    await f.client.publishDone(first, varint(0n), 'member finished'); await flush(128);
    expect(endedA).toBe(1); expect(endedB).toBe(0);
    await writer.write(object(22, 3n, new Uint8Array([2]), 2n)); await flush(128);
    expect(pubs[0]!.largestLocation).toEqual({ groupId: 7n, objectId: 2n });
    expect(pubs[1]!.largestLocation).toEqual({ groupId: 7n, objectId: 3n });
  } finally { if (writer) await writer.abort().catch(() => {}); await f.client.close(); await f.server.close(); }
});

for (const draft of [16, 18, 22] as const) {
  it(`draft${draft} reentrant onPublish close cannot revive the exposed lifetime`, async () => {
    const f = await connectedPair(draft);
    let pub: IncomingPublish | undefined;
    let closing: Promise<void> | undefined;
    f.server.onPublish = incoming => { pub = incoming; closing = f.server.close(); };
    try {
      await f.client.publish(ns('reentry'), nm('video'), 41n).catch(() => {}); await flush(128);
      expect(pub).toBeDefined();
      await expect(pub!.closed).resolves.toEqual({ largestLocation: null });
      await closing;
      await f.server.acceptSubscribe(pub!.requestId, 41n).catch(() => {});
      expect(f.server.session.getIncomingSubscription(pub!.requestId)?.isActive ?? false).toBe(false);
      expect(pub!.largestLocation).toBeNull();
    } finally { await f.client.close(); await f.server.close(); }
  });
}

for (const draft of [16, 18, 22] as const) {
  it(`draft${draft} truncation retains validated partial head but does not imply complete payload`, async () => {
    const f = await connectedPair(draft);
    let pub: IncomingPublish | undefined;
    let delivered = 0;
    f.server.onPublish = incoming => { pub = incoming; incoming.onObject = () => { delivered++; }; };
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    try {
      await f.client.publish(ns('truncated'), nm('video'), 41n); await flush(128);
      writer = (await f.a.createUnidirectionalStream()).getWriter();
      await writer.write(streamHeader(draft, { trackAlias: 41n, groupId: 7n }));
      const bytes = object(draft, 2n, new Uint8Array([1, 2, 3]), null);
      await writer.write(bytes.subarray(0, bytes.length - 2)); await flush(128);
      expect(delivered).toBe(0);
      await writer.close(); writer = undefined; await flush(128);
      expect(f.b.closeInfo?.closeCode).toBe(3);
      await expect(pub!.closed).resolves.toEqual({ largestLocation: { groupId: 7n, objectId: 2n } });
      expect(delivered).toBe(0);
    } finally { if (writer) await writer.abort().catch(() => {}); await f.client.close(); await f.server.close(); }
  });
}
