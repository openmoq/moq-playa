import { expect, it } from 'vitest';
import { encodeObjectDatagram, encodeObjectDatagram18 } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';
import { object, streamHeader } from './testkit/object-reception.js';

type Draft = 16 | 18 | 22;
function datagram(draft: Draft, status: bigint, properties = false): Uint8Array {
  const encode = draft === 16 ? encodeObjectDatagram : encodeObjectDatagram18;
  return encode({ typeByte: properties ? 0x21 : 0x20, trackAlias: 41n,
    groupId: 7n, objectId: 2n, publisherPriority: 128, isEndOfGroup: false,
    extensions: properties ? new Uint8Array([0]) : undefined,
    status, payload: new Uint8Array(0) });
}
for (const draft of [16, 18, 22] as const) {
  for (const status of [3n, 4n]) {
    for (const carrier of ['subgroup', 'datagram'] as const) {
      it(`draft${draft} actual wire status${status} ${carrier} contributes its own location`, async () => {
        const f = await connectedPair(draft);
        f.server.onSubscribe = id => { void f.server.acceptSubscribe(id, 41n); };
        let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
        try {
          const id = await f.client.subscribe(ns('wire-status'), nm('video')); await flush(128);
          const owner = f.client.session.getSubscription(id)!;
          let received = 0;
          f.client.onObject = (_stream, o) => { if (o.kind === 'gap' && o.status === status) received++; };
          f.client.onDatagram = d => { if (d.status === status) received++; };
          if (carrier === 'subgroup') {
            writer = (await f.b.createUnidirectionalStream()).getWriter();
            await writer.write(streamHeader(draft, { trackAlias: 41n, groupId: 7n }));
            await writer.write(object(draft, 2n, new Uint8Array(0), null, { status }));
          } else {
            const dw = f.b.datagrams.writable.getWriter();
            try { await dw.write(datagram(draft, status)); } finally { dw.releaseLock(); }
          }
          await flush(128);
          expect(received, 'decoded actual status Object reached public delivery').toBe(1);
          expect(owner.largestLocation).toEqual({ groupId: 7n, objectId: 2n });
          if (writer) { await writer.close(); writer = undefined; await flush(128); }
          expect(owner.largestLocation).toEqual({ groupId: 7n, objectId: 2n });
          expect(f.errors).toEqual([]);
        } finally {
          if (writer) await writer.abort(new Error('done')).catch(() => {});
          await f.client.close(); await f.server.close();
        }
      });
    }
  }
  for (const fault of ['invalid', 'truncated', 'properties'] as const) {
    it(`draft${draft} subgroup status ${fault} cannot contribute a head`, async () => {
      const f = await connectedPair(draft);
      f.server.onSubscribe = id => { void f.server.acceptSubscribe(id, 41n); };
      let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
      try {
        const id = await f.client.subscribe(ns('wire-negative'), nm('video')); await flush(128);
        const owner = f.client.session.getSubscription(id)!;
        writer = (await f.b.createUnidirectionalStream()).getWriter();
        await writer.write(streamHeader(draft, { trackAlias: 41n, groupId: 7n, properties: fault === 'properties' }));
        const bytes = object(draft, 2n, new Uint8Array(0), null, {
          status: fault === 'invalid' ? 2n : 3n,
          ...(fault === 'properties' ? { properties: new Uint8Array([0]) } : {}),
        });
        await writer.write(fault === 'truncated' ? bytes.subarray(0, bytes.length - 1) : bytes);
        await flush(128);
        expect(owner.largestLocation).toBeUndefined();
        if (fault === 'truncated') {
          expect(f.client.session.state).toBe('established');
          await writer.close(); writer = undefined; await flush(128);
        }
        expect(f.client.session.state).toBe('closed');
        expect(owner.largestLocation).toBeUndefined();
        expect(f.a.closeInfo?.closeCode).toBe(3);
      } finally {
        if (writer) await writer.abort(new Error('done')).catch(() => {});
        await f.client.close(); await f.server.close();
      }
    });
  }
  for (const fault of ['invalid', 'truncated', 'properties', 'payload'] as const) {
    it(`draft${draft} datagram status ${fault} cannot contribute a head`, async () => {
      const f = await connectedPair(draft);
      f.server.onSubscribe = id => { void f.server.acceptSubscribe(id, 41n); };
      try {
        const id = await f.client.subscribe(ns('wire-negative'), nm('video')); await flush(128);
        const owner = f.client.session.getSubscription(id)!;
        let bytes = datagram(draft, fault === 'invalid' ? 2n : 3n, fault === 'properties');
        if (fault === 'truncated') bytes = bytes.subarray(0, bytes.length - 1);
        if (fault === 'payload') bytes = new Uint8Array([...bytes, 1]);
        const writer = f.b.datagrams.writable.getWriter();
        try { await writer.write(bytes); } finally { writer.releaseLock(); }
        await flush(128);
        expect(owner.largestLocation).toBeUndefined();
        expect(f.client.session.state).toBe(fault === 'truncated' ? 'established' : 'closed');
        if (fault !== 'truncated') expect(f.a.closeInfo?.closeCode).toBe(3);
      } finally { await f.client.close(); await f.server.close(); }
    });
  }
}
