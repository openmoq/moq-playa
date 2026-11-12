import { expect, it, vi } from 'vitest';
import { MoqtConnection, type WebTransportLike } from '@openmoq/webtransport';
import { varint, encodePropertyBlock, createControlCodec, MessageParam, encodeSubgroupHeader18, type ControlMessage, type TrackProperties } from '@openmoq/transport';
import { encodeSubscriptionFilter } from '../../../packages/transport/src/control/subscription-filter.js';
import { Relay, type RelayOptions } from './relay.js';
import { createLoopback, flush } from '../../../packages/webtransport/src/testkit/loopback.js';
import { object as encodeObject } from '../../../packages/webtransport/src/testkit/object-reception.js';
const ns = [new TextEncoder().encode('demo')], name = new TextEncoder().encode('objects');
async function pair(draft: 16 | 18 | 22) {
  const { a, b } = createLoopback();
  const resetReasons: unknown[] = [];
  const resetWriters: WritableStreamDefaultWriter<Uint8Array>[] = [];
  // Coded transport capability with real loopback stream abort propagation.
  const binding: WebTransportLike = b;
  binding.createStreamError = (code, cause) => Object.assign(new Error('history reset', { cause }), { streamErrorCode: code });
  binding.resetSendStream = async (writer, reason, fin) => {
    resetReasons.push(reason); resetWriters.push(writer);
    try { await writer.abort(reason); }
    catch (error) {
      if (error !== reason || !fin || !await fin.then(() => false, failure => failure === reason)) throw error;
    }
  };
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  await Promise.all([client.connect(a, { maxRequestId: varint(1000n) }), server.connect(b, { maxRequestId: varint(1000n) })]);
  return { client, server, a, b, resetReasons, resetWriters };
}
async function fixture(draft: 16 | 18 | 22 = 18, options: RelayOptions = {}, advertisedHead?: { group: bigint; object: bigint }, doneEffect?: 'throw' | 'close', trackProperties?: TrackProperties) {
  const relay = new Relay(options), up = await pair(draft), down = await pair(draft);
  const peers = [up, down];
  up.server.onMessage = value => { if (value.type === 'PUBLISH_DONE') {
    if (doneEffect === 'throw') throw new Error('chained DONE callback');
    if (doneEffect === 'close') void up.server.close();
  } };
  let publication: Promise<void> | undefined;
  const work: Promise<void>[] = [];
  const bind = (peer: typeof up) => { peer.server.onPublish = p => { publication = relay.handlePublish(peer.server, p); }; };
  bind(up);
  down.server.onFetch = (id, request) => { work.push(relay.handleFetch(down.server, id, request)); };
  const publicationId = await up.client.publish(ns, name, 9n, { ...(advertisedHead ? { parameters: new Map([[MessageParam.LARGEST_OBJECT, [advertisedHead]]]) } : {}), ...(trackProperties ? { trackProperties } : {}) }); await flush(128); await publication;
  const publish = async (group: bigint, ids: bigint[], eog = true, fin = true, peer = up) => {
    const stream = await peer.client.openSubgroup(9n, group, 0n, { endOfGroup: eog });
    for (const id of ids) await peer.client.sendObject(stream, id, Uint8Array.of(Number(group), Number(id)));
    if (fin) await peer.client.closeSubgroup(stream);
    await flush(128); return stream;
  };
  const fetch = async (startGroup: bigint, endGroup: bigint, endObject: bigint, startObject = 0n, groupOrder: 'ascending' | 'descending' = 'ascending', locationFilter?: Uint8Array) => {
    const data: string[] = [], terminal: string[] = [], messages: ControlMessage[] = [];
    down.client.onMessage = m => { messages.push(m); };
    // Public FetchOptions has no relative-filter field. Rewrite only the
    // actual encoded opener; SDK request allocation, decoding, validation,
    // serving and response consumption all remain real.
    const open = down.a.createBidirectionalStream.bind(down.a);
    const wire = locationFilter ? vi.spyOn(down.a, 'createBidirectionalStream').mockImplementationOnce(async () => {
      const stream = await open(), writer = stream.writable.getWriter(), codec = createControlCodec(draft);
      return { ...stream, writable: new WritableStream<Uint8Array>({
        write(bytes) {
          const decoded = codec.decode(bytes, 0).message;
          if (decoded.type === 'FETCH') {
            const parameters = new Map(decoded.parameters); parameters.set(0x21n, [locationFilter]);
            return writer.write(codec.encode({ ...decoded, parameters }));
          }
          return writer.write(bytes);
        },
        close: () => writer.close(), abort: reason => writer.abort(reason),
      }) };
    }) : undefined;
    let id: bigint;
    try { id = await down.client.fetch(ns, name, { startGroup, startObject, endGroup, endObject, groupOrder,
      receiver: { onObject: o => { if (o.kind === 'data') data.push(`${o.groupId}/${o.objectId}`); }, onClosed: t => { terminal.push(t); } } });
    } finally { wire?.mockRestore(); }
    await flush(256);
    return { id, data, terminal, messages };
  };
  const settled = async () => { await Promise.all(work); await flush(256); };
  const replace = async () => { const peer = await pair(draft); peers.push(peer); bind(peer); await peer.client.publish(ns, name, 9n); await flush(128); await publication; return peer; };
  const close = async () => { await Promise.all(peers.flatMap(p => [p.client.close(), p.server.close()])); await Promise.all(work); };
  return { relay, up, down, publicationId, publish, fetch, settled, replace, close };
}
function refused(result: { messages: ControlMessage[]; terminal: string[] }): void {
  expect(result.messages.some(m => m.type === 'REQUEST_ERROR')).toBe(true);
  expect(result.messages.some(m => m.type === 'FETCH_OK')).toBe(false);
  expect(result.terminal).not.toContain('fin');
}
for (const draft of [18, 22] as const) {
  it(`draft${draft} retained same-Group exact endpoint`, async () => {
    const f = await fixture(draft); try {
      await f.publish(4n, [0n, 1n, 2n]); const result = await f.fetch(4n, 4n, 3n); await f.settled();
      expect(result.data).toEqual(['4/0', '4/1', '4/2']); expect(result.terminal).toEqual(['fin']);
      expect(result.messages.find(m => m.type === 'FETCH_OK')).toMatchObject({ endLocation: { group: 4n, object: draft === 18 ? 3n : 2n } });
    } finally { await f.close(); }
  });
  it(`draft${draft} missing internal Object is unknown`, async () => {
    const f = await fixture(draft); try { await f.publish(4n, [0n, 2n]); const result = await f.fetch(4n, 4n, 3n); await f.settled(); refused(result); } finally { await f.close(); }
  });
  it(`draft${draft} out-of-order old Group preserves newest replay and history`, async () => {
    const f = await fixture(draft); try {
      await f.publish(4n, [0n, 1n]); await f.publish(3n, [0n]); const result = await f.fetch(4n, 4n, 2n); await f.settled();
      expect(result.data).toEqual(['4/0', '4/1']); expect(result.terminal).toEqual(['fin']);
    } finally { await f.close(); }
  });
}
for (const mode of ['complete', 'no-eog', 'no-fin', 'skipped-group'] as const) {
  it(`bounded two-Group history ${mode}`, async () => {
    const f = await fixture(18, { historyCache: { maxGroups: 2, maxObjects: 20, maxBytes: 100 } });
    try {
      await f.publish(3n, [0n, 1n], mode !== 'no-eog', mode !== 'no-fin');
      const last = mode === 'skipped-group' ? 5n : 4n;
      await f.publish(last, [0n, 1n]); const result = await f.fetch(3n, last, 2n); await f.settled();
      if (mode === 'complete') { expect(result.data).toEqual(['3/0', '3/1', '4/0', '4/1']); expect(result.terminal).toEqual(['fin']); }
      else refused(result);
    } finally { await f.close(); }
  });
}
for (const limit of ['maxObjects', 'maxBytes'] as const) it(`history ${limit} evicts without false FIN`, async () => {
  const f = await fixture(18, { historyCache: { maxGroups: 2, maxObjects: 20, maxBytes: 100, [limit]: limit === 'maxObjects' ? 2 : 4 } });
  try { await f.publish(3n, [0n, 1n]); await f.publish(4n, [0n, 1n]); const result = await f.fetch(3n, 4n, 2n); await f.settled(); refused(result); } finally { await f.close(); }
});
it('draft16 refuses unsupported serving before FETCH_OK', async () => {
  const f = await fixture(16); try { await f.publish(4n, [0n, 1n]); const result = await f.fetch(4n, 4n, 2n); await f.settled(); refused(result); } finally { await f.close(); }
});
it('cancel while acceptance is held sends no payload or successful FIN; next request works', async () => {
  const f = await fixture(); let release!: () => void;
  const gate = new Promise<void>(yes => { release = yes; });
  const accept = f.down.server.acceptFetch.bind(f.down.server);
  const spy = vi.spyOn(f.down.server, 'acceptFetch').mockImplementationOnce(async (...args) => { await gate; return accept(...args); });
  try {
    await f.publish(4n, [0n, 1n]); const result = await f.fetch(4n, 4n, 2n);
    await f.down.client.fetchCancel(result.id); await flush(128); release(); await f.settled();
    expect(result.data).toEqual([]); expect(result.terminal).not.toContain('fin');
    spy.mockRestore(); const next = await f.fetch(4n, 4n, 2n); await f.settled(); expect(next.data).toEqual(['4/0', '4/1']); expect(next.terminal).toEqual(['fin']);
  } finally { release(); spy.mockRestore(); await f.close(); }
});

for (const draft of [18, 22] as const) it(`draft${draft} descending Groups retain ascending Objects and exact end`, async () => {
  const f = await fixture(draft, { historyCache: { maxGroups: 2 } });
  try { await f.publish(3n, [0n, 1n]); await f.publish(4n, [0n, 1n]);
    const result = await f.fetch(3n, 4n, 2n, 0n, 'descending'); await f.settled();
    expect(result.data).toEqual(['4/0', '4/1', '3/0', '3/1']); expect(result.terminal).toEqual(['fin']);
    expect(result.messages.find(m => m.type === 'FETCH_OK')).toMatchObject({ endLocation: { group: 4n, object: draft === 18 ? 2n : 1n } });
  } finally { await f.close(); }
});

for (const draft of [18, 22] as const) for (const status of [3n, 4n]) it(`draft${draft} actual wire status${status} cannot masquerade as normalized FIN evidence`, async () => {
  const f = await fixture(draft, { historyCache: { maxGroups: 2 } });
  try {
    const writer = (await f.up.a.createUnidirectionalStream()).getWriter();
    await writer.write(encodeSubgroupHeader18({ typeByte: 0x5c, trackAlias: 9n, groupId: 3n, subgroupId: 0n,
      publisherPriority: 128, hasExtensions: false, isEndOfGroup: true, isFirstObjectInSubgroup: true }));
    await writer.write(encodeObject(draft, 0n, Uint8Array.of(3, 0), null));
    await writer.write(encodeObject(draft, 2n, new Uint8Array(), 0n, { status }));
    await writer.close(); await flush(128);
    // Do not publish after EOT. The requested gap is unknown below the status bound.
    if (status === 3n) await f.publish(4n, [0n]);
    const result = await f.fetch(3n, status === 3n ? 4n : 3n, status === 3n ? 1n : 3n); await f.settled(); refused(result);
  } finally { await f.close(); }
});
for (const draft of [18, 22] as const) it(`draft${draft} completed publication retains proved finite history`, async () => {
  const f = await fixture(draft);
  try { await f.publish(4n, [0n, 1n]); await f.up.client.publishDone(f.publicationId, varint(2n), 'track ended'); await flush(256);
    const result = await f.fetch(4n, 4n, 2n); await f.settled(); expect(result.data).toEqual(['4/0', '4/1']); expect(result.terminal).toEqual(['fin']);
  } finally { await f.close(); }
});
for (const draft of [18, 22] as const) it(`draft${draft} accepted-then-rejected await does not send second response or close peer`, async () => {
  const f = await fixture(draft);
  const accept = f.down.server.acceptFetch.bind(f.down.server);
  vi.spyOn(f.down.server, 'acceptFetch').mockImplementationOnce(async (...args) => { await accept(...args); throw new Error('post-accept failure'); });
  try { await f.publish(4n, [0n, 1n]);
    const result = await f.fetch(4n, 4n, 2n); await f.settled();
    expect(result.messages.filter(m => m.type === 'FETCH_OK')).toHaveLength(1);
    expect(result.messages.filter(m => m.type === 'REQUEST_ERROR')).toHaveLength(0);
    expect(result.terminal.some(t => t === 'reset' || t === 'error')).toBe(true);
    expect(f.down.resetReasons.length).toBeGreaterThan(0);
    expect(f.down.resetReasons).toEqual(expect.arrayContaining([expect.objectContaining({ streamErrorCode: 0 })]));
    expect(result.terminal).not.toContain('fin'); expect(f.down.server.session.state).not.toBe('closed');
    const next = await f.fetch(4n, 4n, 2n); await f.settled();
    expect(next.data).toEqual(['4/0', '4/1']); expect(next.terminal).toEqual(['fin']);
  } finally { await f.close(); }
});

it('admitted snapshot survives cache eviction under the same source', async () => {
  const f = await fixture(); let release!: () => void;
  const gate = new Promise<void>(yes => { release = yes; });
  const accept = f.down.server.acceptFetch.bind(f.down.server);
  const spy = vi.spyOn(f.down.server, 'acceptFetch').mockImplementationOnce(async (...args) => { await gate; return accept(...args); });
  try { await f.publish(4n, [0n, 1n]); const result = await f.fetch(4n, 4n, 2n);
    await f.publish(5n, [0n]); release(); await f.settled();
    expect(result.data).toEqual(['4/0', '4/1']); expect(result.terminal).toEqual(['fin']);
  } finally { release(); spy.mockRestore(); await f.close(); }
});
for (const limit of ['requests'] as const) it(`active history ${limit} capacity is reclaimed after cancellation`, async () => {
  const f = await fixture(18, { maxActiveHistoryRequests: 1 });
  let release!: () => void; const gate = new Promise<void>(yes => { release = yes; });
  const accept = f.down.server.acceptFetch.bind(f.down.server);
  const spy = vi.spyOn(f.down.server, 'acceptFetch').mockImplementationOnce(async (...args) => { await gate; return accept(...args); });
  try { await f.publish(4n, [0n, 1n]); const held = await f.fetch(4n, 4n, 2n);
    const refusedWhileHeld = await f.fetch(4n, 4n, 2n); await flush(128); refused(refusedWhileHeld);
    await f.down.client.fetchCancel(held.id); await flush(128); release(); await f.settled();
    spy.mockRestore(); const next = await f.fetch(4n, 4n, 2n); await f.settled(); expect(next.data).toEqual(['4/0', '4/1']); expect(next.terminal).toEqual(['fin']);
  } finally { release(); spy.mockRestore(); await f.close(); }
});
for (const bad of [0, -1, 1.5, Infinity, NaN]) it(`rejects invalid finite history limit ${bad}`, () => {
  expect(() => new Relay({ historyCache: { maxObjects: bad } })).toThrow(RangeError);
});

for (const draft of [18, 22] as const) it(`draft${draft} authoritative missing tail remains unknown after DONE early-discard`, async () => {
  const f = await fixture(draft, {}, { group: 4n, object: 1n });
  try {
    const stream = await f.publish(4n, [0n], true, false);
    const pipe = f.up.a.uniOut.at(-1)!; pipe.faults.hold = true;
    await f.up.client.sendObject(stream, 1n, Uint8Array.of(4, 1)); await f.up.client.closeSubgroup(stream);
    await f.up.client.publishDone(f.publicationId, varint(2n), 'track ended'); await flush(256);
    pipe.releaseHeld(); await flush(256);
    const result = await f.fetch(4n, 4n, 2n); await f.settled(); refused(result);
    // Already retained finite bytes can still be served without claiming the lost tail.
    const prefix = await f.fetch(4n, 4n, 1n); await f.settled(); expect(prefix.data).toEqual(['4/0']); expect(prefix.terminal).toEqual(['fin']);
  } finally { await f.close(); }
});

for (const draft of [18, 22] as const) it(`draft${draft} unobserved tail does not manufacture a Larger acquired head`, async () => {
  const f = await fixture(draft);
  try { const stream = await f.publish(4n, [0n], true, false); const pipe = f.up.a.uniOut.at(-1)!; pipe.faults.hold = true;
    await f.up.client.sendObject(stream, 1n, Uint8Array.of(4, 1)); await f.up.client.closeSubgroup(stream);
    await f.up.client.publishDone(f.publicationId, varint(2n), 'track ended'); await flush(256); pipe.releaseHeld(); await flush(256);
    const result = await f.fetch(4n, 4n, 2n); await f.settled(); expect(result.data).toEqual(['4/0']); expect(result.terminal).toEqual(['fin']);
    expect(result.messages.find(m => m.type === 'FETCH_OK')).toMatchObject({ endLocation: { group: 4n, object: draft === 18 ? 1n : 0n } });
  } finally { await f.close(); }
});

for (const draft of [18, 22] as const) it(`draft${draft} EOG carrier reset cannot prove its tail`, async () => {
  const f = await fixture(draft, { historyCache: { maxGroups: 2 } });
  try {
    const writer = (await f.up.a.createUnidirectionalStream()).getWriter();
    await writer.write(encodeSubgroupHeader18({ typeByte: 0x5c, trackAlias: 9n, groupId: 3n, subgroupId: 0n,
      publisherPriority: 128, hasExtensions: false, isEndOfGroup: true, isFirstObjectInSubgroup: true }));
    await writer.write(encodeObject(draft, 0n, Uint8Array.of(3, 0), null)); await flush(128);
    await writer.abort({ streamErrorCode: 1 }); await flush(128); await f.publish(4n, [0n]);
    const result = await f.fetch(3n, 4n, 1n); await f.settled(); refused(result);
    const retained = await f.fetch(3n, 3n, 1n); await f.settled(); expect(retained.data).toEqual(['3/0']); expect(retained.terminal).toEqual(['fin']);
  } finally { await f.close(); }
});
for (const groups of [1n, 2n]) it(`draft22 relative LOCATION_FILTER ${groups} resolves from captured publication head`, async () => {
  const f = await fixture(22, { historyCache: { maxGroups: 2 } });
  try { await f.publish(0n, [0n]); await f.publish(1n, [0n]);
    const filter = encodeSubscriptionFilter({ type: 'RelativeStart', groups }, 22);
    const result = await f.fetch(0n, 1n, 1n, 0n, 'ascending', filter); await f.settled();
    expect(result.data).toEqual(groups === 1n ? ['1/0'] : ['0/0', '1/0']); expect(result.terminal).toEqual(['fin']);
    expect(result.messages.find(m => m.type === 'FETCH_OK')).toMatchObject({ endLocation: { group: 1n, object: 0n } });
  } finally { await f.close(); }
});
for (const max of [false, true]) for (const type of ['NextGroupStart', 'LargestObject'] as const) {
  if (!max || type !== 'NextGroupStart') it(`draft22 ${type} never replays current head max=${max}`, async () => {
    const group = max ? (1n << 64n) - 1n : 1n, objectId = max ? (1n << 64n) - 1n : 0n;
    const f = await fixture(22);
    try { await f.publish(group, [objectId]);
      const filter = encodeSubscriptionFilter({ type }, 22);
      const result = await f.fetch(0n, group, 0n, 0n, 'ascending', filter); await f.settled(); refused(result);
      expect(result.data).toEqual([]); expect(result.messages.find(m => m.type === 'REQUEST_ERROR')).toMatchObject({ errorCode: 0x11n });
    } finally { await f.close(); }
  });
}
for (const draft of [18, 22] as const) for (const mode of ['done', 'disconnect'] as const) {
  it(`draft${draft} retired immutable cache policy ${mode} preserves only proved prefix`, async () => {
    const f = await fixture(draft, {}, { group: 4n, object: 1n }, undefined);
    try { await f.publish(4n, [0n], false);
      if (mode === 'disconnect') await f.up.client.close();
      else await f.up.client.publishDone(f.publicationId, varint(2n), 'track ended');
      await flush(256);
      const prefix = await f.fetch(4n, 4n, 1n); await f.settled(); expect(prefix.data).toEqual(['4/0']); expect(prefix.terminal).toEqual(['fin']);
      expect(prefix.messages.find(m => m.type === 'FETCH_OK')).toMatchObject({ endOfTrack: 0 });
      const missing = await f.fetch(4n, 4n, 2n); await f.settled(); refused(missing);
    } finally { await f.close(); }
  });
}

it('draft22 current-relative at MAX Group remains a valid finite FETCH', async () => {
  const max = (1n << 64n) - 1n, f = await fixture(22);
  try { await f.publish(max, [0n]);
    const result = await f.fetch(0n, max, 0n, 0n, 'ascending', encodeSubscriptionFilter({ type: 'RelativeStart', groups: 1n }, 22));
    await f.settled(); expect(result.data).toEqual([`${max}/0`]); expect(result.terminal).toEqual(['fin']);
    expect(result.messages.find(m => m.type === 'FETCH_OK')).toMatchObject({ endLocation: { group: max, object: 0n } });
  } finally { await f.close(); }
});


async function distinctObject(f: Awaited<ReturnType<typeof fixture>>, group: bigint, id: bigint,
    endOfGroup = false, fin = true, payload = Uint8Array.of(Number(group), Number(id)), subgroup = id) {
  const stream = await f.up.client.openSubgroup(9n, group, subgroup,
    { publisherPriority: 128, firstObject: true, endOfGroup });
  await f.up.client.sendObject(stream, id, payload);
  if (fin) await f.up.client.closeSubgroup(stream);
  await flush(128); return stream;
}
for (const draft of [18, 22] as const) {
  it(`multicarrier draft${draft} twelve one-Object subgroups retain a normal complete Group`, async () => {
    const f = await fixture(draft, { historyCache: { maxGroups: 40, maxObjects: 480, maxBytes: 64 * 1024 * 1024 } });
    try {
      for (let id = 0n; id < 12n; id++) await distinctObject(f, 3n, id, id === 11n);
      await distinctObject(f, 4n, 0n, true);
      const result = await f.fetch(3n, 4n, 1n); await f.settled();
      expect(result.data).toEqual([...Array.from({ length: 12 }, (_, i) => `3/${i}`), '4/0']);
      expect(result.terminal).toEqual(['fin']);
      expect(result.messages.find(m => m.type === 'FETCH_OK')).toMatchObject({ endLocation: { group: 4n, object: draft === 18 ? 1n : 0n } });
    } finally { await f.close(); }
  });
  it(`multicarrier draft${draft} early EOG bounds survive until all earlier Objects arrive`, async () => {
    const f = await fixture(draft, { historyCache: { maxGroups: 2 } });
    try {
      await distinctObject(f, 3n, 2n, true); await distinctObject(f, 4n, 0n, true);
      const missing = await f.fetch(3n, 4n, 1n); await f.settled(); refused(missing);
      await distinctObject(f, 3n, 0n); await distinctObject(f, 3n, 1n);
      const complete = await f.fetch(3n, 4n, 1n); await f.settled();
      expect(complete.data).toEqual(['3/0', '3/1', '3/2', '4/0']); expect(complete.terminal).toEqual(['fin']);
    } finally { await f.close(); }
  });
  it(`multicarrier draft${draft} missing interior Object is unknown even with exact EOG FIN`, async () => {
    const f = await fixture(draft, { historyCache: { maxGroups: 2 } });
    try { await distinctObject(f, 3n, 0n); await distinctObject(f, 3n, 2n, true); await distinctObject(f, 4n, 0n, true);
      const result = await f.fetch(3n, 4n, 1n); await f.settled(); refused(result);
    } finally { await f.close(); }
  });
  it(`multicarrier draft${draft} EOG header without FIN cannot bridge a Group`, async () => {
    const f = await fixture(draft, { historyCache: { maxGroups: 2 } });
    try { await distinctObject(f, 3n, 0n); await distinctObject(f, 3n, 1n, true, false); await distinctObject(f, 4n, 0n, true);
      const result = await f.fetch(3n, 4n, 1n); await f.settled(); refused(result);
    } finally { await f.close(); }
  });
  it(`multicarrier draft${draft} reset EOG carrier cannot certify Group completion`, async () => {
    const f = await fixture(draft, { historyCache: { maxGroups: 2 } });
    try { await distinctObject(f, 3n, 0n);
      const writer = (await f.up.a.createUnidirectionalStream()).getWriter();
      await writer.write(encodeSubgroupHeader18({ typeByte: 0x5c, trackAlias: 9n, groupId: 3n, subgroupId: 1n,
        publisherPriority: 128, hasExtensions: false, isEndOfGroup: true, isFirstObjectInSubgroup: true }));
      await writer.write(encodeObject(draft, 1n, Uint8Array.of(3, 1), null)); await flush(128);
      await writer.abort({ streamErrorCode: 1 }); await flush(128); await distinctObject(f, 4n, 0n, true);
      const result = await f.fetch(3n, 4n, 1n); await f.settled(); refused(result);
    } finally { await f.close(); }
  });
  it(`multicarrier draft${draft} completed bytes on an unclosed non-EOG carrier remain usable`, async () => {
    const f = await fixture(draft, { historyCache: { maxGroups: 2 } });
    try { await distinctObject(f, 3n, 0n, false, false); await distinctObject(f, 3n, 1n, true); await distinctObject(f, 4n, 0n, true);
      const result = await f.fetch(3n, 4n, 1n); await f.settled();
      expect(result.data).toEqual(['3/0', '3/1', '4/0']); expect(result.terminal).toEqual(['fin']);
    } finally { await f.close(); }
  });
  it(`multicarrier draft${draft} unchanged single-carrier coverage remains valid`, async () => {
    const f = await fixture(draft, { historyCache: { maxGroups: 2 } });
    try { await f.publish(3n, [0n, 1n]); await f.publish(4n, [0n]);
      const result = await f.fetch(3n, 4n, 1n); await f.settled(); expect(result.data).toEqual(['3/0', '3/1', '4/0']); expect(result.terminal).toEqual(['fin']);
    } finally { await f.close(); }
  });
}
for (const draft of [18, 22] as const) {
  it(`multicarrier draft${draft} non-EOG reset does not erase already complete payload`, async () => {
    const f = await fixture(draft, { historyCache: { maxGroups: 2 } });
    try {
      const writer = (await f.up.a.createUnidirectionalStream()).getWriter();
      await writer.write(encodeSubgroupHeader18({ typeByte: 0x54, trackAlias: 9n, groupId: 3n, subgroupId: 0n,
        publisherPriority: 128, hasExtensions: false, isEndOfGroup: false, isFirstObjectInSubgroup: true }));
      await writer.write(encodeObject(draft, 0n, Uint8Array.of(3, 0), null)); await flush(128);
      await writer.abort({ streamErrorCode: 1 }); await flush(128);
      await distinctObject(f, 3n, 1n, true); await distinctObject(f, 4n, 0n, true);
      const result = await f.fetch(3n, 4n, 1n); await f.settled();
      expect(result.data).toEqual(['3/0', '3/1', '4/0']); expect(result.terminal).toEqual(['fin']);
    } finally { await f.close(); }
  });
}
for (const draft of [18, 22] as const) {
  it(`multicarrier draft${draft} held old FIN cannot affect same-connection alias replacement`, async () => {
    const f = await fixture(draft);
    const finishes: bigint[] = [];
    const observed = f.up.server.onSubgroupFin;
    f.up.server.onSubgroupFin = (id, header) => { finishes.push(id); observed?.(id, header); };
    try {
      const old = await f.publish(3n, [0n], true, false);
      const pipe = f.up.a.uniOut.at(-1)!; pipe.faults.hold = true;
      await f.up.client.closeSubgroup(old);
      await f.up.client.publishDone(f.publicationId, varint(2n), 'old source finished'); await flush(256);
      expect(f.up.server.session.getIncomingSubscription(f.publicationId)).toBeUndefined();
      const replacementId = await f.up.client.publish(ns, name, 9n); await flush(256);
      expect(replacementId).not.toBe(f.publicationId);
      expect(f.up.server.session.getIncomingSubscription(replacementId)?.isTerminated).toBe(false);
      await f.publish(3n, [0n, 1n]); const before = finishes.length;
      pipe.releaseHeld(); await flush(256);
      // Existing SDK early-discard prevents the old FIN callback; no fake FIN injection.
      expect(finishes).toHaveLength(before);
      const result = await f.fetch(3n, 3n, 2n); await f.settled();
      expect(result.data).toEqual(['3/0', '3/1']); expect(result.terminal).toEqual(['fin']);
    } finally { await f.close(); }
  });
}

for (const draft of [18, 22] as const) {
  it(`multicarrier draft${draft} reset carrier progression leaves capacity for later complete Groups`, async () => {
    const f = await fixture(draft, { historyCache: { maxGroups: 2, maxObjects: 2 } });
    try {
      for (let groupId = 0n; groupId < 6n; groupId++) {
        const writer = (await f.up.a.createUnidirectionalStream()).getWriter();
        await writer.write(encodeSubgroupHeader18({ typeByte: 0x54, trackAlias: 9n, groupId, subgroupId: 0n,
          publisherPriority: 128, hasExtensions: false, isEndOfGroup: false, isFirstObjectInSubgroup: true }));
        await writer.write(encodeObject(draft, 0n, Uint8Array.of(Number(groupId), 0), null));
        await flush(128); await writer.abort({ streamErrorCode: 1 }); await flush(128);
      }
      await distinctObject(f, 6n, 0n, true);
      await distinctObject(f, 7n, 0n, true);
      const result = await f.fetch(6n, 7n, 1n); await f.settled();
      expect(result.data).toEqual(['6/0', '7/0']); expect(result.terminal).toEqual(['fin']);
    } finally { await f.close(); }
  });
}


for (const draft of [18, 22] as const) it(`draft${draft} MAX Object endpoint stays representable`, async () => {
  const f = await fixture(draft), max = (1n << 64n) - 1n;
  try {
    await f.publish(4n, [max]);
    const result = await f.fetch(4n, 4n, 0n, max); await f.settled();
    expect(result.data).toEqual([`4/${max}`]); expect(result.terminal).toEqual(['fin']);
    expect(result.messages.find(m => m.type === 'FETCH_OK')).toMatchObject({ endLocation: { group: 4n, object: draft === 18 ? 0n : max } });
  } finally { await f.close(); }
});
it('huge unknown ranges are refused by inspecting retained Groups', async () => {
  const f = await fixture(22, { historyCache: { maxGroups: 2 } });
  try {
    await f.publish(0n, [0n]); await f.publish((1n << 64n) - 1n, [0n]);
    const result = await f.fetch(0n, (1n << 64n) - 1n, 0n); await f.settled(); refused(result);
  } finally { await f.close(); }
});
it('zero-length data and distinct subgroup priorities remain fetchable', async () => {
  const f = await fixture();
  try {
    for (const id of [0n, 1n]) {
      const sid = await f.up.client.openSubgroup(9n, 4n, id, { firstObject: true, publisherPriority: Number(id), endOfGroup: id === 1n });
      await f.up.client.sendObject(sid, id, new Uint8Array()); await f.up.client.closeSubgroup(sid);
    }
    await flush(128);
    const result = await f.fetch(4n, 4n, 2n); await f.settled();
    expect(result.data).toEqual(['4/0', '4/1']); expect(result.terminal).toEqual(['fin']);
  } finally { await f.close(); }
});
it('draft22 NextGroupStart at MAX Group saturates and can retrieve the current Group', async () => {
  const f = await fixture(22), max = (1n << 64n) - 1n;
  try {
    await f.publish(max, [0n]);
    const result = await f.fetch(0n, max, 0n, 0n, 'ascending', encodeSubscriptionFilter({ type: 'NextGroupStart' }, 22)); await f.settled();
    expect(result.data).toEqual([`${max}/0`]); expect(result.terminal).toEqual(['fin']);
  } finally { await f.close(); }
});

for (const draft of [18, 22] as const) it(`draft${draft} a closed FETCH owner gets no late abort or second response`, async () => {
  const f = await fixture(draft);
  const accept = f.down.server.acceptFetch.bind(f.down.server);
  vi.spyOn(f.down.server, 'acceptFetch').mockImplementationOnce(async (...args) => {
    await accept(...args);
    await f.down.server.close();
    throw new Error('acceptance completed after its connection closed');
  });
  try {
    await f.publish(4n, [0n]);
    const result = await f.fetch(4n, 4n, 1n);
    await expect(f.settled()).resolves.toBeUndefined();
    expect(result.messages.filter(m => m.type === 'REQUEST_ERROR')).toEqual([]);
  } finally { await f.close(); }
});
for (const draft of [18,22] as const) it(`evaluation same-subgroup FIN attribution draft${draft}`, async()=> {
 const f=await fixture(draft,{historyCache:{maxGroups:2}});
 try {
 const a=await f.up.client.openSubgroup(9n,3n,0n,{endOfGroup:true});
 await f.up.client.sendObject(a,0n,Uint8Array.of(3,0)); await flush(128);
 const b=await f.up.client.openSubgroup(9n,3n,0n,{endOfGroup:true});
 await f.up.client.sendObject(b,1n,Uint8Array.of(3,1)); await flush(128);
 await f.up.client.closeSubgroup(a); await flush(128);
 expect(f.up.server.session.getIncomingSubscription(f.publicationId)?.isTerminated).toBe(false);
 await f.publish(4n,[0n]);
 const result=await f.fetch(3n,4n,1n); await f.settled();

 refused(result);
 } finally {await f.close();}
});

for (const draft of [18,22] as const) it(`evaluation duplicate carrier must not retire valid track draft${draft}`, async()=> {
 const f=await fixture(draft,{historyCache:{maxGroups:2}});
 try {
 const a=await f.up.client.openSubgroup(9n,3n,0n,{endOfGroup:true});
 await f.up.client.sendObject(a,0n,Uint8Array.of(3,0));
 await f.up.client.sendObject(a,1n,Uint8Array.of(3,1)); await flush(128);
 const b=await f.up.client.openSubgroup(9n,3n,0n,{endOfGroup:true});
 await f.up.client.sendObject(b,0n,Uint8Array.of(3,0)); await flush(128);
 await f.up.client.closeSubgroup(a); await flush(128);
 expect(f.up.server.session.getIncomingSubscription(f.publicationId)?.isTerminated).toBe(false);
 await f.up.client.sendObject(b,1n,Uint8Array.of(3,1));
 await f.up.client.closeSubgroup(b); await flush(128);
 expect(f.up.server.session.getIncomingSubscription(f.publicationId)?.isTerminated).toBe(false);
 } finally {await f.close();}
});

for (const draft of [18, 22] as const) for (const overlap of [false, true]) it(`carrier FIN control draft${draft} overlap=${overlap}`, async () => {
  const f = await fixture(draft, { historyCache: { maxGroups: 2 } });
  try {
    const a = await f.up.client.openSubgroup(9n, 3n, 0n, { endOfGroup: true });
    for (const id of [0n, 1n, 2n, 3n]) await f.up.client.sendObject(a, id, Uint8Array.of(3, Number(id)));
    await flush(128);
    if (overlap) {
      const b = await f.up.client.openSubgroup(9n, 3n, 0n, { endOfGroup: true });
      for (const id of [0n, 1n]) await f.up.client.sendObject(b, id, Uint8Array.of(3, Number(id)));
      await flush(128);
    }
    await f.up.client.closeSubgroup(a); await flush(128);
    expect(f.up.server.session.getIncomingSubscription(f.publicationId)?.isTerminated).toBe(false);
    await f.publish(4n, [0n]);
    const result = await f.fetch(3n, 4n, 1n); await f.settled();
    if (overlap) refused(result); else expect(result.messages.some(m => m.type === 'FETCH_OK')).toBe(true);
  } finally { await f.close(); }
});

for (const draft of [18, 22] as const) it(`draft${draft} empty overlapping FIN cannot end another receive stream`, async () => {
  const f = await fixture(draft);
  try {
    const a = await f.up.client.openSubgroup(9n, 3n, 0n, {});
    await f.up.client.sendObject(a, 0n, Uint8Array.of(3, 0)); await flush(128);
    const b = await f.up.client.openSubgroup(9n, 3n, 0n, {});
    await f.up.client.closeSubgroup(b); await flush(128);
    await f.up.client.sendObject(a, 1n, Uint8Array.of(3, 1)); await flush(128);
    expect(f.up.server.session.getIncomingSubscription(f.publicationId)?.isTerminated).toBe(false);
    await f.up.client.closeSubgroup(a); await flush(128);
    expect(f.up.server.session.getIncomingSubscription(f.publicationId)?.isTerminated).toBe(false);
  } finally { await f.close(); }
});
