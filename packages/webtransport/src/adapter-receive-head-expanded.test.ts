import { expect, it } from 'vitest';
import { encodeObjectDatagram, encodeObjectDatagram18, encodeSubgroupHeader, encodeSubgroupHeader18 } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';
import { object, streamHeader } from './testkit/object-reception.js';

for (const draft of [16, 18, 22] as const) {
  it(`draft ${draft} partial Normal updates bound owner before complete payload`, async () => {
    const f = await connectedPair(draft);
    f.server.onSubscribe = id => { void f.server.acceptSubscribe(id, 41n); };
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    try {
      const id = await f.client.subscribe(ns('expanded'), nm('video'));
      await flush(128);
      expect(f.client.session.getSubscription(id)?.isActive).toBe(true);
      writer = (await f.b.createUnidirectionalStream()).getWriter();
      const encodeHeader = draft === 16 ? encodeSubgroupHeader : encodeSubgroupHeader18;
      await writer.write(encodeHeader({ typeByte: draft === 16 ? 0x1c : 0x5c,
        trackAlias: 41n, groupId: 7n, subgroupId: 0n, publisherPriority: 128,
        hasExtensions: false, isEndOfGroup: true, isFirstObjectInSubgroup: true }));
      const bytes = object(draft, 2n, new Uint8Array(100), null);
      await writer.write(bytes.subarray(0, bytes.length - 99));
      await flush(128);
      expect(f.client.session.getSubscription(id)?.largestLocation).toEqual({ groupId: 7n, objectId: 2n });
      await writer.write(bytes.subarray(bytes.length - 99));
      await writer.close(); writer = undefined;
      await flush(128);
      expect(f.client.session.getSubscription(id)?.largestLocation, 'synthetic FIN cannot advance head').toEqual({ groupId: 7n, objectId: 2n });
    } finally {
      if (writer) await writer.abort(new Error('done')).catch(() => {});
      await f.client.close(); await f.server.close();
    }
  });
  for (const length of [0, 3]) {
    it(`draft ${draft} Normal datagram EOG payload=${length} contributes own location`, async () => {
      const f = await connectedPair(draft);
      f.server.onSubscribe = id => { void f.server.acceptSubscribe(id, 41n); };
      try {
        const id = await f.client.subscribe(ns('expanded'), nm('video'));
        await flush(128);
        const encode = draft === 16 ? encodeObjectDatagram : encodeObjectDatagram18;
        const bytes = encode({ typeByte: 0x02, trackAlias: 41n, groupId: 7n, objectId: 2n,
          publisherPriority: 128, extensions: undefined, status: undefined, isEndOfGroup: true, payload: new Uint8Array(length) });
        let delivered = 0;
        f.client.onDatagram = d => { expect(d.isEndOfGroup).toBe(true); delivered++; };
        const writer = f.b.datagrams.writable.getWriter();
        try { await writer.write(bytes); } finally { writer.releaseLock(); }
        await flush(128);
        expect(delivered, 'real decoded Normal datagram').toBe(1);
        expect(f.client.session.getSubscription(id)?.largestLocation).toEqual({ groupId: 7n, objectId: 2n });
        expect(f.errors).toEqual([]);
      } finally { await f.client.close(); await f.server.close(); }
    });
  }
}
it('draft22 shared PUBLISH owners each retain head', async () => {
  const f = await connectedPair(22);
  f.client.onPublish = pub => { void f.client.acceptSubscribe(pub.requestId, pub.trackAlias); };
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  try {
    const first = await f.server.publish(ns('shared'), nm('video'), 41n);
    const second = await f.server.publish(ns('shared'), nm('video'), 41n);
    await flush(128);
    const a = f.client.session.getIncomingSubscription(first)!;
    const b = f.client.session.getIncomingSubscription(second)!;
    expect(a.isActive && b.isActive).toBe(true);
    writer = (await f.b.createUnidirectionalStream()).getWriter();
    await writer.write(streamHeader(22, { trackAlias: 41n, groupId: 7n }));
    await writer.write(object(22, 2n, new Uint8Array([1]), null));
    await flush(128);
    expect(a.largestLocation).toEqual({ groupId: 7n, objectId: 2n });
    expect(b.largestLocation).toEqual({ groupId: 7n, objectId: 2n });

  } finally {
    if (writer) await writer.abort(new Error('done')).catch(() => {});
    await f.client.close(); await f.server.close();
  }
});

it('draft22 shared SUBSCRIBE retirement preserves the surviving owner on the same stream', async () => {
  const f = await connectedPair(22);
  f.server.onSubscribe = id => { void f.server.acceptSubscribe(id, 41n); };
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  try {
    const first = await f.client.subscribe(ns('shared'), nm('video'));
    const second = await f.client.subscribe(ns('shared'), nm('video'));
    await flush(128);
    const a = f.client.session.getSubscription(first)!;
    const b = f.client.session.getSubscription(second)!;
    expect(a.isActive && b.isActive).toBe(true);
    writer = (await f.b.createUnidirectionalStream()).getWriter();
    await writer.write(streamHeader(22, { trackAlias: 41n, groupId: 7n }));
    await writer.write(object(22, 2n, new Uint8Array([1]), null));
    await flush(128);
    expect(a.largestLocation).toEqual({ groupId: 7n, objectId: 2n });
    expect(b.largestLocation).toEqual({ groupId: 7n, objectId: 2n });
    await f.client.unsubscribe(first);
    expect(a.isTerminated).toBe(true);
    await writer.write(object(22, 3n, new Uint8Array([1]), 2n)); await flush(128);
    expect(a.largestLocation).toEqual({ groupId: 7n, objectId: 2n });
    expect(b.largestLocation).toEqual({ groupId: 7n, objectId: 3n });
  } finally {
    if (writer) await writer.abort(new Error('done')).catch(() => {});
    await f.client.close(); await f.server.close();
  }
});
for (const draft of [16, 22] as const) {
  it(`draft ${draft} pending partial head remains unattributed after request settlement`, async () => {
    const f = await connectedPair(draft);
    f.server.onSubscribe = () => {};
    let id = -1n;
    const pending = f.client.subscribeTrack(ns('pending'), nm('video'), { onRequestId: n => { id = n; } });
    void pending.catch(() => {});
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    try {
      await flush(128);
      writer = (await f.b.createUnidirectionalStream()).getWriter();
      await writer.write(streamHeader(draft, { trackAlias: 41n, groupId: 7n }));
      const bytes = object(draft, 2n, new Uint8Array(100), null);
      await writer.write(bytes.subarray(0, bytes.length - 99)); await flush(128);
      expect(f.client.session.getSubscription(id)?.largestLocation).toBeUndefined();
      await f.server.acceptSubscribe(id, 41n); await pending;
      expect(f.client.session.getSubscription(id)?.largestLocation).toBeUndefined();
    } finally {
      if (writer) await writer.abort(new Error('done')).catch(() => {});
      await f.client.close(); await f.server.close();
    }
  });
}
for (const draft of [16, 18, 22] as const) {
  it(`draft ${draft} truncated and tombstoned datagrams cannot advance retired owner`, async () => {
    const f = await connectedPair(draft);
    f.server.onSubscribe = id => { void f.server.acceptSubscribe(id, 41n); };
    try {
      const id = await f.client.subscribe(ns('negative'), nm('video')); await flush(128);
      const owner = f.client.session.getSubscription(id)!;
      const writer = f.b.datagrams.writable.getWriter();
      try {
        await writer.write(new Uint8Array([0])); await flush(128);
        expect(owner.largestLocation).toBeUndefined();
        expect(f.client.session.state).toBe('established');
        await f.client.unsubscribe(id);
        const encode = draft === 16 ? encodeObjectDatagram : encodeObjectDatagram18;
        await writer.write(encode({ typeByte: 0, trackAlias: 41n, groupId: 99n, objectId: 2n,
          publisherPriority: 128, extensions: undefined, status: undefined, isEndOfGroup: false, payload: new Uint8Array([1]) }));
        await flush(128);
        expect(owner.largestLocation).toBeUndefined();
        expect(f.client.session.state).toBe('established');
      } finally { writer.releaseLock(); }
    } finally { await f.client.close(); await f.server.close(); }
  });
}
