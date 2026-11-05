import { expect, it } from 'vitest';
import { MoqtConnection } from './adapter.js';
import { TransportSim, flush } from './testkit/stream-sim.js';
import { createControlCodec, encodeObjectDatagram18, encodeFetchObject18 } from '@openmoq/transport';
import type { MoqtObject } from '@openmoq/transport';
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map(x => parseInt(x, 16)));
const byte = (n: bigint) => n.toString(16).padStart(2, '0');
const range = { startGroup: 0n, startObject: 0n, endGroup: 9n, endObject: 0n };
async function fixture(draft: 18 | 22, holdAbort = false) {
  const conn = new MoqtConnection(draft), transport = new TransportSim(), objects: MoqtObject[] = [], errors: Error[] = [];
  let release!: () => void, held = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const create = transport.createBidirectionalStream.bind(transport);
  if (holdAbort) transport.createBidirectionalStream = async () => {
    const created = await create(); const stream = transport.bidi.at(-1)!; transport.createBidirectionalStream = create;
    return { readable: created.readable, writable: new WritableStream<Uint8Array>({
      write(chunk) { stream.written.push(chunk.slice()); },
      async abort() { held = true; await gate; stream.writeAborted = true; },
    }) };
  };
  conn.onObject = (_id, obj) => { objects.push(obj); }; conn.onError = e => { errors.push(e); };
  transport.openIncomingUni().push(bytes('af000000')); await conn.connect(transport);
  return { conn, transport, objects, errors, release, held: () => held };
}
for (const draft of [18, 22] as const) for (const trigger of ['fetch', 'subgroup', 'datagram', 'track-properties', 'publish-properties', 'track-status', 'held-abort'] as const) {
  it(`draft${draft} malformed ${trigger} revokes exact tuple owners before reset; another namespace stays healthy`, async () => {
    const f = await fixture(draft, trigger === 'held-abort'), codec = createControlCodec(draft);
    const exact = [bytes('4e')], other = [bytes('4f')], name = bytes('76');
    const owned: bigint[] = [], ownedIndices: number[] = [];
    try {
      owned.push(await f.conn.subscribe(exact, name)); ownedIndices.push(0);
      f.transport.bidi[0]!.push(bytes('0400021000'));
      if (draft === 22) {
        owned.push(await f.conn.subscribe(exact.map(x => x.slice()), name.slice())); ownedIndices.push(1);
        f.transport.bidi[1]!.push(bytes('0400021100'));
      }
      const fetchIndex = f.transport.bidi.length, fetch = await f.conn.fetch(exact, name, range);
      owned.push(fetch); ownedIndices.push(fetchIndex);
      const siblingIndex = f.transport.bidi.length, sibling = await f.conn.fetch(exact.map(x => x.slice()), name.slice(), range);
      owned.push(sibling); ownedIndices.push(siblingIndex);
      const otherIndex = f.transport.bidi.length; await f.conn.subscribe(other, name); f.transport.bidi[otherIndex]!.push(bytes('0400021200'));
      const otherFetchIndex = f.transport.bidi.length, otherFetch = await f.conn.fetch(other, name, range);
      for (const index of [fetchIndex, siblingIndex, otherFetchIndex]) {
        if (!(trigger === 'track-properties' && index === fetchIndex)) f.transport.bidi[index]!.push(bytes('18000400090000'));
      }
      await flush(512); expect(f.errors).toEqual([]);
      // Prove two sibling readers are already accepted and capable of delivery.
      const subgroup = f.transport.openIncomingUni().push(bytes('101002070001cc'));
      const first = encodeFetchObject18({ groupId: 2n, subgroupId: 0n, objectId: 0n, publisherPriority: 7, payload: bytes('cc') }, undefined, true, 'ascending');
      const fetchStream = f.transport.openIncomingUni().push(bytes('05' + byte(sibling))).push(first.bytes);
      await flush(512); expect(f.objects.filter(o => o.kind === 'data' && o.payload[0] === 0xcc)).toHaveLength(2);
      f.objects.length = 0;
      if (trigger === 'track-status') {
        const status = await f.conn.trackStatus(exact.map(x => x.slice()), name.slice());
        f.transport.bidi.at(-1)!.push(codec.encode({ type: 'REQUEST_OK', requestId: status, parameters: new Map(), trackProperties: new Map([[0x3en, [1n]]]) }));
      } else if (trigger === 'track-properties') f.transport.bidi[fetchIndex]!.push(codec.encode({ type: 'FETCH_OK', requestId: fetch, parameters: new Map(), endLocation: { group: 9n, object: 0n }, endOfTrack: 0, trackProperties: new Map([[0x3en, [1n]]]) }));
      else if (trigger === 'publish-properties') f.transport.pushIncomingBidi().push(codec.encode({ type: 'PUBLISH', requestId: 1n, trackNamespace: exact, trackName: name, trackAlias: 19n, parameters: new Map(), trackProperties: new Map([[0x3en, [1n]]]) }));
      else if (trigger === 'datagram') f.transport.pushDatagram(encodeObjectDatagram18({ typeByte: 1, trackAlias: 16n, groupId: 3n, objectId: 0n, publisherPriority: 7, extensions: bytes('2201'), payload: bytes('aa'), isEndOfGroup: false, status: undefined }));
      else if (trigger === 'subgroup') f.transport.openIncomingUni().push(bytes('111003070002220101aa'));
      else f.transport.openIncomingUni().push(bytes('05' + byte(fetch) + '3f0200030702220101aa'));
      await flush(1024);
      if (trigger === 'held-abort') expect(f.held()).toBe(true);
      // New streams and bytes on existing readers must both be revoked.
      if (!subgroup.readCancelled) subgroup.push(bytes('0001dd'));
      if (trigger === 'held-abort') expect(fetchStream.readCancelled).toBe(false);
      if (!fetchStream.readCancelled) fetchStream.push(encodeFetchObject18({ groupId: 2n, subgroupId: 0n, objectId: 1n, publisherPriority: 7, payload: bytes('dd') }, first.nextPrior, false, 'ascending').bytes);
      if (draft === 22) f.transport.openIncomingUni().push(bytes('101103070001aa'));
      f.transport.openIncomingUni().push(bytes('101203070001bb'));
      f.transport.openIncomingUni().push(bytes('05' + byte(otherFetch) + '1f0300000701bb'));
      await flush(1024);
      expect(f.objects.filter(o => o.kind === 'data' && (o.payload[0] === 0xaa || o.payload[0] === 0xdd))).toEqual([]);
      expect(f.objects.filter(o => o.kind === 'data' && o.payload[0] === 0xbb)).toHaveLength(2);
      expect(f.transport.bidi[otherIndex]!.writeAborted).toBe(false); expect(f.transport.bidi[otherFetchIndex]!.writeAborted).toBe(false);
      expect(f.transport.closeInfo).toBeUndefined();
      f.release(); await flush(1024);
      expect(ownedIndices.map(i => f.transport.bidi[i]!.writeAborted)).toEqual(owned.map(() => true));
    } finally { f.release(); await flush(512); await f.conn.close(); }
  });
}

for (const draft of [18, 22] as const) it(`draft${draft} unsupported mandatory Track refusal stays request-local with an active sibling`, async () => {
  const f = await fixture(draft);
  try {
    await f.conn.fetch([bytes('4e')], bytes('76'), range);
    const sibling = await f.conn.fetch([bytes('4e')], bytes('76'), range);
    f.transport.bidi[0]!.push(bytes('18000800020900c0400100'));
    f.transport.bidi[1]!.push(bytes('18000400090000')); await flush(512);
    f.transport.openIncomingUni().push(bytes('05' + byte(sibling) + '1f0200030701bb')); await flush(512);
    expect(f.transport.bidi[0]!.writeAborted).toBe(true); expect(f.transport.bidi[1]!.writeAborted).toBe(false);
    expect(f.objects).toEqual([expect.objectContaining({ kind: 'data', payload: bytes('bb') })]); expect(f.transport.closeInfo).toBeUndefined();
  } finally { await f.conn.close(); }
});

for (const draft of [18, 22] as const) for (const duplicate of [false, true]) it(`draft${draft} pending cancellation ${duplicate ? 'rejects a second' : 'tolerates one'} crossed OK while reset is held`, async () => {
  const f = await fixture(draft, true);
  try {
    const sub = await f.conn.subscribe([bytes('4e')], bytes('76'));
    f.transport.bidi[0]!.push(bytes('0400021000')); await flush(512);
    const pending = await f.conn.fetch([bytes('4e')], bytes('76'), range);
    const joining = draft === 18
      ? await f.conn.joiningFetch({ joiningFetchType: 'relative', joiningRequestId: sub, joiningStart: 1n })
      : await f.conn.fetch([bytes('4e')], bytes('76'), range);
    if (draft === 22) await f.conn.subscribe([bytes('4e')], bytes('76'));
    f.transport.openIncomingUni().push(bytes('111002070002220101aa')); await flush(512);
    expect(f.held()).toBe(true);
    f.transport.bidi[1]!.push(bytes('18000400090000'));
    f.transport.bidi[2]!.push(bytes('18000400090000'));
    if (draft === 22) f.transport.bidi[3]!.push(bytes('0400021100'));
    await flush(512);
    f.transport.openIncomingUni().push(bytes('05' + byte(pending) + '1f0200000701aa'));
    f.transport.openIncomingUni().push(bytes('05' + byte(joining) + '1f0200000701aa')); await flush(512);
    expect(f.transport.closeInfo).toBeUndefined(); expect(f.objects).toEqual([]);
    if (duplicate) {
      f.transport.bidi[1]!.push(bytes('18000400090000')); await flush(512);
      // The unchanged request topology rejects an unsolicited second reply
      // before it can be matched or delivered as another successful response.
      expect(f.transport.bidi[1]!.writeAborted).toBe(true);
      expect(f.errors.some(error => /unsolicited response/.test(error.message))).toBe(true);
      expect(f.objects).toEqual([]);
      return;
    }
    f.release(); await flush(1024);
    expect(f.transport.bidi.map(stream => stream.writeAborted)).toEqual(draft === 18 ? [true, true, true] : [true, true, true, true]);
  } finally { f.release(); await flush(512); await f.conn.close(); }
});

for (const draft of [18, 22] as const) it(`draft${draft} malformed FETCH also revokes its accepted incoming PUBLISH owner`, async () => {
  const f = await fixture(draft), codec = createControlCodec(draft);
  let published = false;
  f.conn.onPublish = incoming => { published = true; incoming.onObject = obj => { f.objects.push(obj); }; };
  try {
    const pub = f.transport.pushIncomingBidi().push(codec.encode({ type: 'PUBLISH', requestId: 1n, trackNamespace: [bytes('4e')], trackName: bytes('76'), trackAlias: 19n, parameters: new Map() }));
    await flush(512); expect(published).toBe(true); await f.conn.acceptSubscribe(1n, 19n); await flush(512);
    const fetch = await f.conn.fetch([bytes('4e')], bytes('76'), range);
    const other = await f.conn.fetch([bytes('4f')], bytes('76'), range);
    for (const request of f.transport.bidi) request.push(bytes('18000400090000'));
    await flush(512); expect(f.errors).toEqual([]);
    const oldReader = f.transport.openIncomingUni().push(bytes('101302070001cc')); await flush(512);
    expect(f.objects).toEqual([expect.objectContaining({ payload: bytes('cc') })]); f.objects.length = 0;
    f.transport.openIncomingUni().push(bytes('05' + byte(fetch) + '3f0200030702220101aa')); await flush(1024);
    f.transport.openIncomingUni().push(bytes('101303070001aa'));
    f.transport.openIncomingUni().push(bytes('05' + byte(other) + '1f0300000701bb')); await flush(512);
    expect(pub.writeAborted).toBe(true); expect(oldReader.readCancelled).toBe(true);
    expect(f.transport.bidi[0]!.writeAborted).toBe(true);
    expect(f.transport.bidi[1]!.writeAborted).toBe(false);
    expect(f.objects).toEqual([expect.objectContaining({ payload: bytes('bb') })]); expect(f.transport.closeInfo).toBeUndefined();
  } finally { await f.conn.close(); }
});

it('draft22 malformed live Object fences already-owned fill readers for every exact-Track owner before held reset', async () => {
  const f = await fixture(22, true), codec = createControlCodec(22);
  try {
    for (const alias of [16n, 17n]) {
      const id = await f.conn.subscribe([bytes('4e')], bytes('76'), { fill: { filter: { type: 'RelativeStart', groups: 1n } } });
      f.transport.bidi.at(-1)!.push(codec.encode({ type: 'SUBSCRIBE_OK', requestId: id, trackAlias: alias,
        parameters: new Map([[0x09n, [{ group: 2n, object: 0n }]]]) }));
    }
    await flush(512); expect(f.errors).toEqual([]);
    const first = encodeFetchObject18({ groupId: 1n, subgroupId: 0n, objectId: 0n, publisherPriority: 7, payload: bytes('cc') }, undefined, true, 'ascending');
    f.transport.openIncomingUni().push(bytes('0500')).push(first.bytes);
    const sibling = f.transport.openIncomingUni().push(bytes('0502')).push(first.bytes);
    await flush(512); expect(f.objects).toHaveLength(2); f.objects.length = 0;
    f.transport.openIncomingUni().push(bytes('111003070002220101aa')); await flush(1024);
    expect(f.held()).toBe(true); expect(sibling.readCancelled).toBe(false);
    sibling.push(encodeFetchObject18({ groupId: 1n, subgroupId: 0n, objectId: 1n, publisherPriority: 7, payload: bytes('dd') }, first.nextPrior, false, 'ascending').bytes);
    await flush(512); expect(f.objects).toEqual([]); expect(f.transport.closeInfo).toBeUndefined();
    f.release(); await flush(1024);
    expect(f.transport.bidi.map(stream => stream.writeAborted)).toEqual([true, true]);
  } finally { f.release(); await flush(512); await f.conn.close(); }
});
