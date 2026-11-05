import { expect, it } from 'vitest';
import { createControlCodec, SetupParam, varint } from '@openmoq/transport';
import type { ControlMessage, DraftVersion, FetchOptions, MoqtObject } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
import { MoqtConnectionError } from './adapter-error.js';
import { TransportSim, flush } from './testkit/stream-sim.js';

const bytes = (s: string) => Uint8Array.from(s.match(/../g)!.map(x => parseInt(x, 16)));
const small = (value: bigint) => {
  if (value < 0n || value > 63n) throw new Error('literal fixture field exceeds common single-byte domain');
  return value.toString(16).padStart(2, '0');
};
const exact = [bytes('4e')], other = [bytes('4f')], name = bytes('76');
const requested: FetchOptions = { startGroup: 7n, startObject: 0n, endGroup: 7n, endObject: 4n, groupOrder: 'ascending' };

async function fixture(draft: DraftVersion = 22) {
  const conn = new MoqtConnection(draft), transport = new TransportSim();
  const objects: { stream: bigint; value: MoqtObject }[] = [], messages: ControlMessage[] = [], errors: Error[] = [];
  const codec = createControlCodec(draft);
  conn.onObject = (stream, value) => { objects.push({ stream, value }); };
  conn.onMessage = message => { messages.push(message); };
  conn.onError = error => { errors.push(error); };
  if (draft >= 18) {
    transport.openIncomingUni().push(bytes('af000000'));
    await conn.connect(transport);
  } else {
    const connecting = conn.connect(transport); await flush(128);
    transport.bidi[0]!.push(codec.encode({ type: 'SERVER_SETUP', parameters: new Map([[SetupParam.MAX_REQUEST_ID, [varint(63)]]]) }));
    await connecting;
  }
  const request = async (options: FetchOptions = requested, namespace = exact) => {
    const index = draft >= 18 ? transport.bidi.length : 0;
    const id = await conn.fetch(namespace, name, options);
    return { id, control: transport.bidi[index]! };
  };
  const pushRawOk = async (r: Awaited<ReturnType<typeof request>>, inclusiveEnd = 3n, group = 7n) => {
    const wire = draft === 14 ? bytes('180006' + small(r.id) + '0100' + small(group) + small(inclusiveEnd + 1n) + '00')
      : codec.encode({ type: 'FETCH_OK', requestId: r.id, endOfTrack: 0,
          endLocation: { group, object: draft === 22 ? inclusiveEnd : inclusiveEnd + 1n }, parameters: new Map() });
    r.control.push(wire); await flush(512);
  };
  const acceptedOk = async (r: Awaited<ReturnType<typeof request>>, inclusiveEnd = 3n, group = 7n) => {
    await pushRawOk(r, inclusiveEnd, group);
    expect(messages.find(m => m.type === 'FETCH_OK' && m.requestId === r.id)).toMatchObject({
      type: 'FETCH_OK', endLocation: { group, object: draft >= 22 ? inclusiveEnd : inclusiveEnd + 1n },
    });
  };
  const data = async (id: bigint, entries: string, fin = false) => {
    const stream = transport.openIncomingUni().push(bytes('05' + small(id) + entries));
    if (fin) stream.closeReadable();
    await flush(1024); return stream;
  };
  const first = (objectId: bigint, payload = 'aa') => draft === 14
    ? '0700' + small(objectId) + '800001' + payload
    : '1f0700' + small(objectId) + '8001' + payload;
  const ids = () => objects.filter(o => o.value.kind === 'data').map(o => o.value.objectId);
  const assertRequestRefused = (r: Awaited<ReturnType<typeof request>>) => {
    expect(conn.session.getFetch(r.id)).toBeUndefined();
    expect(errors.some(error => error instanceof MoqtConnectionError && !error.isFatal)).toBe(true);
    expect(transport.closeInfo).toBeUndefined();
    if (draft >= 18) expect(r.control.writeAborted).toBe(true);
    else {
      const cancel = codec.encode({ type: 'FETCH_CANCEL', requestId: r.id });
      expect([...r.control.writtenBytes().slice(-cancel.length)]).toEqual([...cancel]);
      expect(r.control.writeAborted).toBe(false);
    }
  };
  return { conn, transport, objects, messages, errors, codec, request, pushRawOk, acceptedOk, data, first, ids, assertRequestRefused, draft };
}

for (const draft of [14, 16, 18, 22] as const) {
  it(`draft${draft} same-group whole-end request accepts a nonzero start`, async () => {
    const f = await fixture(draft);
    try {
      const r = await f.request({ ...requested, startObject: 2n, endObject: 0n });
      if (draft >= 22) await f.acceptedOk(r, 40n);
      else {
        r.control.push(draft === 14 ? bytes('180006' + small(r.id) + '0100070000')
          : f.codec.encode({ type: 'FETCH_OK', requestId: r.id, endOfTrack: 0, endLocation: { group: 7n, object: 0n }, parameters: new Map() }));
        await flush(512);
      }
      await f.data(r.id, f.first(40n), true);
      expect(f.ids()).toEqual([40n]); expect(f.errors).toEqual([]); expect(f.transport.closeInfo).toBeUndefined();
    } finally { await f.conn.close(); }
  });
  it(`draft${draft} rejects ordinary DATA above the known requested end before delivery`, async () => {
    const f = await fixture(draft);
    try {
      const r = await f.request(); await f.acceptedOk(r); expect(f.errors).toEqual([]);
      await f.data(r.id, f.first(5n));
      expect(f.ids()).toEqual([]);
      f.assertRequestRefused(r);
      expect(f.transport.closeInfo).toBeUndefined();
    } finally { await f.conn.close(); }
  });
  it(`draft${draft} rejects ordinary DATA below a known requested start before delivery`, async () => {
    const f = await fixture(draft);
    try {
      const r = await f.request({ ...requested, startObject: 2n }); await f.acceptedOk(r); expect(f.errors).toEqual([]);
      await f.data(r.id, f.first(1n));
      expect(f.ids()).toEqual([]);
      f.assertRequestRefused(r);
      expect(f.transport.closeInfo).toBeUndefined();
    } finally { await f.conn.close(); }
  });
  it(`draft${draft} accepts the exact inclusive end with its own response convention`, async () => {
    const f = await fixture(draft);
    try {
      const r = await f.request(); await f.acceptedOk(r); await f.data(r.id, f.first(3n), true);
      expect(f.ids()).toEqual([3n]); expect(f.errors).toEqual([]); expect(f.transport.closeInfo).toBeUndefined();
    } finally { await f.conn.close(); }
  });
  it(`draft${draft} out-of-request DATA cancels only its FETCH using draft-appropriate transport`, async () => {
    const f = await fixture(draft);
    try {
      const r = await f.request(); await f.acceptedOk(r); await f.data(r.id, f.first(5n));
      f.assertRequestRefused(r);
    } finally { await f.conn.close(); }
  });
}

it('draft22 literal DATA0,1,5 delivers only0,1 for a request through3', async () => {
  const f = await fixture();
  try {
    const r = await f.request(); await f.acceptedOk(r); expect(f.errors).toEqual([]);
    await f.data(r.id, '1f0700008001a01700018001b11700048001c3');
    expect(f.ids()).toEqual([0n, 1n]); f.assertRequestRefused(r);
  } finally { await f.conn.close(); }
});

for (const fin of [false, true]) it(`draft22 valid DATA ${fin ? 'FIN ' : ''}before OK remains deliverable`, async () => {
  const f = await fixture();
  try {
    const r = await f.request(); await f.data(r.id, f.first(3n), fin);
    expect(f.ids()).toEqual([3n]); expect(f.errors).toEqual([]);
    await f.acceptedOk(r); expect(f.errors).toEqual([]); expect(f.ids()).toEqual([3n]);
  } finally { await f.conn.close(); }
});

it('draft22 known request bound rejects bad DATA even before OK', async () => {
  const f = await fixture();
  try {
    const r = await f.request(); await f.data(r.id, f.first(5n));
    expect(f.ids()).toEqual([]); f.assertRequestRefused(r);
    expect(f.messages.filter(m => m.type === 'FETCH_OK')).toEqual([]);
    expect(f.transport.closeInfo).toBeUndefined();
  } finally { await f.conn.close(); }
});

for (const fin of [false, true]) it(`draft22 late smaller OK detects retained extrema after DATA${fin ? ' FIN' : ''}`, async () => {
  const f = await fixture();
  try {
    const r = await f.request({ ...requested, endObject: 6n });
    await f.data(r.id, f.first(5n), fin);
    expect(f.ids()).toEqual([5n]); expect(f.errors).toEqual([]);
    await f.pushRawOk(r, 3n);
    expect(f.messages.filter(m => m.type === 'FETCH_OK')).toEqual([]);
    f.assertRequestRefused(r);
  } finally { await f.conn.close(); }
});

it('draft22 effective response end is enforced even inside a wider requested range', async () => {
  const f = await fixture();
  try {
    const r = await f.request({ ...requested, endObject: 6n }); await f.acceptedOk(r, 3n);
    await f.data(r.id, f.first(5n));
    expect(f.ids()).toEqual([]); f.assertRequestRefused(r);
  } finally { await f.conn.close(); }
});

it('draft22 bound fault cancels only its FETCH while same-track owners and namespace sibling alias0 deliver', async () => {
  const f = await fixture();
  try {
    const subscribe = async (namespace: Uint8Array[], alias: bigint) => {
      const index = f.transport.bidi.length, id = await f.conn.subscribe(namespace, name);
      const stream = f.transport.bidi[index]!;
      stream.push(f.codec.encode({ type: 'SUBSCRIBE_OK', requestId: id, trackAlias: alias, parameters: new Map() }));
      await flush(512); return stream;
    };
    const a = await subscribe(exact, 16n), b = await subscribe(exact.map(x => x.slice()), 17n);
    const unrelatedAlias0 = await subscribe(other, 0n);
    const bad = await f.request();
    const sameTrack = await f.request({ ...requested, startObject: 6n, endObject: 8n });
    const unrelated = await f.request(requested, other);
    await f.acceptedOk(bad); await f.acceptedOk(sameTrack, 7n); await f.acceptedOk(unrelated);
    await f.data(bad.id, f.first(5n));
    f.transport.openIncomingUni().push(bytes('101007800601b0'));
    f.transport.openIncomingUni().push(bytes('101107800601b0'));
    f.transport.openIncomingUni().push(bytes('100007800601b2')); await flush(512);
    await f.data(sameTrack.id, f.first(6n, 'b0'));
    await f.data(unrelated.id, f.first(3n, 'c1'));
    const healthy = f.objects.filter(o => o.value.kind === 'data' && o.value.payload[0] !== 0xaa);
    expect(healthy.map(o => o.value.kind === 'data' ? [...o.value.payload] : []))
      .toEqual([[0xb0], [0xb0], [0xb2], [0xb0], [0xc1]]);
    expect([a.writeAborted, b.writeAborted, sameTrack.control.writeAborted]).toEqual([false, false, false]);
    expect(unrelatedAlias0.writeAborted).toBe(false); expect(unrelated.control.writeAborted).toBe(false);
    f.assertRequestRefused(bad);
    expect(f.objects.some(o => o.value.kind === 'data' && o.value.payload[0] === 0xaa)).toBe(false);
  } finally { await f.conn.close(); }
});

it('draft18 relative Joining FETCH has unknown start and must not invent one', async () => {
  const f = await fixture(18);
  try {
    const sub = await f.conn.subscribe(exact, name);
    f.transport.bidi[0]!.push(f.codec.encode({ type: 'SUBSCRIBE_OK', requestId: sub, trackAlias: 16n, parameters: new Map() }));
    await flush(512);
    const id = await f.conn.joiningFetch({ joiningFetchType: 'relative', joiningRequestId: sub, joiningStart: 5n });
    expect(f.conn.session.getFetch(id)?.startGroup).toBeUndefined();
    f.transport.bidi[1]!.push(f.codec.encode({ type: 'FETCH_OK', requestId: id, endOfTrack: 0, endLocation: { group: 7n, object: 4n }, parameters: new Map() }));
    await flush(512); await f.data(id, '1f0200008001aa', true);
    expect(f.objects.filter(o => o.value.kind === 'data').map(o => o.value.groupId)).toEqual([2n]);
    expect(f.errors).toEqual([]); expect(f.transport.closeInfo).toBeUndefined();
  } finally { await f.conn.close(); }
});

it('same-connection alias0 subscription and synthetic alias0 FETCH both retain healthy delivery', async () => {
  const f = await fixture();
  try {
    const sub = await f.conn.subscribe(other, name);
    f.transport.bidi[0]!.push(f.codec.encode({ type: 'SUBSCRIBE_OK', requestId: sub, trackAlias: 0n, parameters: new Map() }));
    await flush(512);
    const r = await f.request(); await f.acceptedOk(r);
    f.transport.openIncomingUni().push(bytes('100007800001bb')); await flush(512);
    await f.data(r.id, f.first(3n, 'cc'));
    expect(f.objects.filter(o => o.value.kind === 'data').map(o => o.value.kind === 'data' ? [...o.value.payload] : []))
      .toEqual([[0xbb], [0xcc]]);
    expect(f.errors).toEqual([]); expect(f.transport.closeInfo).toBeUndefined();
  } finally { await f.conn.close(); }
});

it('draft22 range marker is not an ordinary DATA range violation', async () => {
  const f = await fixture();
  try {
    const r = await f.request(); await f.acceptedOk(r); await f.data(r.id, f.first(3n) + '808c0704', true);
    expect(f.objects.map(o => [o.value.kind, o.value.objectId])).toEqual([['data', 3n], ['gap', 4n]]);
    expect(f.errors).toEqual([]); expect(f.transport.closeInfo).toBeUndefined();
  } finally { await f.conn.close(); }
});

it('draft22 below-start OK retains the mandatory session error', async () => {
  const f = await fixture();
  try {
    const r = await f.request({ ...requested, startObject: 2n }); await f.pushRawOk(r, 1n);
    expect(f.transport.closeInfo?.closeCode).toBeDefined(); expect(f.transport.closeInfo?.closeCode).not.toBe(0);
  } finally { await f.conn.close(); }
});

for (const draft of [14, 16, 18, 22] as const) {
  it(`draft${draft} API endObject0 retains whole-end-group request semantics`, async () => {
    const f = await fixture(draft);
    try {
      const r = await f.request({ ...requested, endObject: 0n });
      if (draft >= 22) await f.acceptedOk(r, 40n);
      else {
        r.control.push(draft === 14 ? bytes('180006' + small(r.id) + '0100070000')
          : f.codec.encode({ type: 'FETCH_OK', requestId: r.id, endOfTrack: 0, endLocation: { group: 7n, object: 0n }, parameters: new Map() }));
        await flush(512);
      }
      await f.data(r.id, f.first(40n), true);
      expect(f.ids()).toEqual([40n]); expect(f.errors).toEqual([]); expect(f.transport.closeInfo).toBeUndefined();
    } finally { await f.conn.close(); }
  });
  it(`draft${draft} API endObject1 includes exactly object0 with the draft's response encoding`, async () => {
    const f = await fixture(draft);
    try {
      const r = await f.request({ ...requested, endObject: 1n }); await f.acceptedOk(r, 0n);
      await f.data(r.id, f.first(0n), true);
      expect(f.ids()).toEqual([0n]); expect(f.errors).toEqual([]); expect(f.transport.closeInfo).toBeUndefined();
    } finally { await f.conn.close(); }
  });
}

for (const draft of [18, 22] as const) for (const groupOrder of ['ascending', 'descending'] as const) {
  it(`draft${draft} compares cross-group locations independently of ${groupOrder} delivery order`, async () => {
    const f = await fixture(draft);
    try {
      const r = await f.request({ startGroup: 7n, startObject: 2n, endGroup: 8n, endObject: 2n, groupOrder });
      await f.acceptedOk(r, 1n, 8n);
      const wire = groupOrder === 'ascending' ? '1f0700028001aa1f0000018001bb' : '1f0800018001aa1f0000038001bb';
      await f.data(r.id, wire, true);
      expect(f.objects.filter(o => o.value.kind === 'data').map(o => [o.value.groupId, o.value.objectId]))
        .toEqual(groupOrder === 'ascending' ? [[7n, 2n], [8n, 1n]] : [[8n, 1n], [7n, 3n]]);
      expect(f.errors).toEqual([]); expect(f.transport.closeInfo).toBeUndefined();
    } finally { await f.conn.close(); }
  });
}

it('draft22 explicit response EndObject0 cannot be mistaken for a whole-group sentinel', async () => {
  const f = await fixture();
  try {
    const r = await f.request({ ...requested, endObject: 1n }); await f.acceptedOk(r, 0n);
    await f.data(r.id, f.first(1n)); expect(f.ids()).toEqual([]); f.assertRequestRefused(r);
  } finally { await f.conn.close(); }
});

it('draft18 whole-group response end clamps DATA after a nonzero start', async () => {
  const f = await fixture(18);
  try {
    const r = await f.request({ ...requested, startObject: 2n, endGroup: 9n, endObject: 0n });
    r.control.push(f.codec.encode({ type: 'FETCH_OK', requestId: r.id, endOfTrack: 0, endLocation: { group: 7n, object: 0n }, parameters: new Map() }));
    await flush(512); expect(f.transport.closeInfo).toBeUndefined();
    const stream = await f.data(r.id, f.first(40n)); expect(f.ids()).toEqual([40n]);
    stream.push(bytes('1f0000008001bb')); await flush(1024);
    expect(f.ids()).toEqual([40n]); f.assertRequestRefused(r);
  } finally { await f.conn.close(); }
});

for (const draft of [18, 22] as const) it(`draft${draft} inbound standalone FETCH preserves a whole-group zero after a nonzero start`, async () => {
  const f = await fixture(draft);
  const received: ControlMessage[] = [];
  f.conn.onFetch = (_id, fetch) => { received.push(fetch); };
  try {
    f.transport.pushIncomingBidi().push(f.codec.encode({ type: 'FETCH', requestId: 1n, parameters: new Map(), fetch: {
      fetchType: 1, trackNamespace: exact, trackName: name,
      startLocation: { group: 7n, object: 2n }, endLocation: { group: 7n, object: 0n },
    } }));
    await flush(1024);
    expect(received).toEqual([expect.objectContaining({ fetch: expect.objectContaining({
      startLocation: { group: 7n, object: 2n }, endLocation: { group: 7n, object: 0n },
    }) })]);
    expect(f.errors).toEqual([]); expect(f.transport.closeInfo).toBeUndefined();
  } finally { await f.conn.close(); }
});

for (const draft of [18, 22] as const) it(`draft${draft} bare acceptance advertises the known requested coverage in its wire convention`, async () => {
  const f = await fixture(draft);
  try {
    const incoming = f.transport.pushIncomingBidi().push(f.codec.encode({ type: 'FETCH', requestId: 1n, parameters: new Map(), fetch: {
      fetchType: 1, trackNamespace: exact, trackName: name,
      startLocation: { group: 7n, object: 2n }, endLocation: { group: 7n, object: 4n },
    } }));
    await flush(1024); await f.conn.acceptFetch(1n);
    expect([...incoming.writtenBytes()]).toEqual([...bytes(draft === 18 ? '18000400070400' : '18000400070300')]);
    expect(f.errors).toEqual([]);
  } finally { await f.conn.close(); }
});

for (const draft of [18, 22] as const) for (const objectId of [3n, 5n]) {
  it(`draft${draft} control parameter validation precedes late FETCH range policy after DATA${objectId}`, async () => {
    const f = await fixture(draft);
    try {
      const r = await f.request({ ...requested, endObject: 6n });
      await f.data(r.id, f.first(objectId));
      expect(f.ids()).toEqual([objectId]); expect(f.errors).toEqual([]);
      r.control.push(bytes(draft === 18 ? '180006000704012201' : '180006000703012201'));
      await flush(1024);
      expect(f.transport.closeInfo?.closeCode).toBe(3);
    } finally { await f.conn.close(); }
  });
}

for (const draft of [18, 22] as const) {
  it(`draft${draft} valid late FETCH response with a smaller end remains request-local`, async () => {
    const f = await fixture(draft);
    try {
      const r = await f.request({ ...requested, endObject: 6n });
      await f.data(r.id, f.first(5n));
      expect(f.ids()).toEqual([5n]); expect(f.errors).toEqual([]);
      await f.pushRawOk(r, 3n);
      expect(f.messages.filter(message => message.type === 'FETCH_OK')).toEqual([]);
      f.assertRequestRefused(r);
    } finally { await f.conn.close(); }
  });
}

it('draft22 literal DATA0,1,5 decodes unchanged when all three are requested', async () => {
  const f = await fixture();
  try {
    const r = await f.request({ ...requested, endObject: 6n }); await f.acceptedOk(r, 5n);
    await f.data(r.id, '1f0700008001a01700018001b11700048001c3', true);
    expect(f.ids()).toEqual([0n, 1n, 5n]); expect(f.errors).toEqual([]);
    expect(f.transport.closeInfo).toBeUndefined();
  } finally { await f.conn.close(); }
});
