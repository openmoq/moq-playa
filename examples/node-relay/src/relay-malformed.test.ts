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
async function distinctObject(f: Awaited<ReturnType<typeof fixture>>, group: bigint, id: bigint,
    endOfGroup = false, fin = true, payload = Uint8Array.of(Number(group), Number(id)), subgroup = id) {
  const stream = await f.up.client.openSubgroup(9n, group, subgroup,
    { publisherPriority: 128, firstObject: true, endOfGroup });
  await f.up.client.sendObject(stream, id, payload);
  if (fin) await f.up.client.closeSubgroup(stream);
  await flush(128); return stream;
}
for (const draft of [18, 22] as const) {
  for (const defect of ['conflicting-payload', 'past-EOG-bound'] as const) {
    it(`multicarrier draft${draft} detected ${defect} retires exact upstream owner`, async () => {
      const f = await fixture(draft, { historyCache: { maxGroups: 2 } });
      const received: number[][] = [], terminals: ControlMessage[] = [];
      let accepted: Promise<void> | undefined;
      f.down.server.onSubscribe = (id, namespace, trackName) => { accepted = f.relay.handleSubscribe(f.down.server, id, namespace, trackName); };
      f.down.client.onObject = (_id, object) => { if (object.kind === 'data') received.push([...object.payload]); };
      f.down.client.onMessage = message => { terminals.push(message); };
      try {
        const requestId = await f.down.client.subscribe(ns, name); await flush(128); await accepted;
        const siblingName = new TextEncoder().encode('video-720');
        const siblingId = await f.up.client.publish(ns, siblingName, 10n); await flush(128);
        const siblingData: number[] = [];
        const sibling = await f.down.client.subscribeTrack(ns, siblingName, {
          onObject: object => { if (object.kind === 'data') siblingData.push(...object.payload); },
        });
        await distinctObject(f, 3n, 0n, defect === 'past-EOG-bound');
        const id = defect === 'past-EOG-bound' ? 1n : 0n;
        await distinctObject(f, 3n, id, false, true, Uint8Array.of(99), id);
        await flush(256);
        // Draft22 suppresses a repeated same-Location delivery before this cache.
        // This is a receiver-boundary characterization, not a detected-conflict red.
        if (draft === 22 && defect === 'conflicting-payload') {
          expect(received).not.toContainEqual([99]);
          return;
        }
        // Call-through witness: this is an actual decoded object offered to the cache.
        expect(received).not.toContainEqual([99]);
        expect(f.up.server.session.getIncomingSubscription(f.publicationId)).toBeUndefined();
        expect(terminals.filter(message => message.type === 'PUBLISH_DONE')).toMatchObject([{ requestId, statusCode: 0x12n }]);
        const siblingStream = await f.up.client.openSubgroup(10n, 1n, 0n);
        await f.up.client.sendObject(siblingStream, 0n, Uint8Array.of(77)); await flush(128);
        expect(siblingData).toEqual([77]);
        expect(f.up.server.session.getIncomingSubscription(siblingId)?.isTerminated).toBe(false);
        expect(f.down.server.session.getIncomingSubscription(sibling.requestId)?.isTerminated).toBe(false);
        expect(f.up.server.session.state).not.toBe('closed');
      } finally { await f.close(); }
    });
  }
}

for (const draft of [18, 22] as const) {
  for (const boundary of ['ordinary-subgroup-FIN', 'late-EOG-below-retained'] as const) {
    it(`multicarrier draft${draft} ${boundary} conflict retires exact source`, async () => {
      const f = await fixture(draft);
      try {
        if (boundary === 'ordinary-subgroup-FIN') {
          await distinctObject(f, 3n, 0n);
          await distinctObject(f, 3n, 1n, false, true, Uint8Array.of(99), 0n);
        } else {
          await distinctObject(f, 3n, 2n);
          await distinctObject(f, 3n, 1n, true);
        }
        expect(f.up.server.session.getIncomingSubscription(f.publicationId)).toBeUndefined();
        expect(f.up.server.session.state).not.toBe('closed');
      } finally { await f.close(); }
    });
  }
}

it('multicarrier draft18 duplicate property variation preserves existing live fanout', async () => {
  const f = await fixture(18);
  const received: (Uint8Array | undefined)[] = [];
  let accepted: Promise<void> | undefined;
  f.down.server.onSubscribe = (id, namespace, trackName) => { accepted = f.relay.handleSubscribe(f.down.server, id, namespace, trackName); };
  f.down.client.onObject = (_id, object) => { if (object.kind === 'data') received.push(object.properties); };
  try {
    await f.down.client.subscribe(ns, name); await flush(128); await accepted;
    const properties = [1, 2].map(value => encodePropertyBlock([{ id: 0x101n, value: Uint8Array.of(value) }], 'd18-delta-vi64'));
    for (const value of properties) {
      const stream = await f.up.client.openSubgroup(9n, 3n, 0n, { firstObject: true, hasExtensions: true });
      await f.up.client.sendObject(stream, 0n, Uint8Array.of(3, 0), value); await f.up.client.closeSubgroup(stream); await flush(256);
    }
    expect(f.up.server.session.getIncomingSubscription(f.publicationId)?.isTerminated).toBe(false);
  } finally { await f.close(); }
});

for (const draft of [18, 22] as const) for (const mode of ['malformed', 'malformed-then-replaced', 'ordinary-replacement'] as const) {
  it(`draft${draft} held SUBSCRIBE preserves ${mode} generation cause`, async () => {
    const f = await fixture(draft);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const accept = f.down.server.acceptSubscribe.bind(f.down.server);
    const held = vi.spyOn(f.down.server, 'acceptSubscribe').mockImplementationOnce(async (...args) => { await gate; return accept(...args); });
    const sends = vi.spyOn(f.down.server, 'sendObject');
    let handling: Promise<void> | undefined;
    let entered = false;
    let requestId: bigint | undefined;
    const received: string[] = [];
    const messages: ControlMessage[] = [];
    f.down.client.onMessage = m => messages.push(m);
    f.down.server.onSubscribe = (id, ns, name) => { entered = true; handling = f.relay.handleSubscribe(f.down.server, id, ns, name); };
    try {
      await f.publish(4n, [0n, 1n]);
      const subscription = f.down.client.subscribeTrack(ns, name, {
        filter: { type: 'AbsoluteStart', startGroup: 4n, startObject: 0n },
        onRequestId: id => { requestId = id; },
        onObject: object => { if (object.kind === 'data') received.push(`${object.groupId}/${object.objectId}`); },
      });
      void subscription.catch(() => undefined);
      await flush(128); expect(entered).toBe(true); expect(held).toHaveBeenCalledTimes(1);
      // A real new Group is received after SUBSCRIBE, before acceptance.
      await f.publish(5n, [0n]);
      if (mode !== 'ordinary-replacement') {
        // EOG/FIN established Group5's final Object0. This is actual wire data
        // above that bound, not a duplicate discarded by the SDK.
        const stream = await f.up.client.openSubgroup(9n, 5n, 1n);
        await f.up.client.sendObject(stream, 1n, Uint8Array.of(5, 1));
        await flush(128);
      }
      if (mode !== 'malformed') {
        const replacement = await f.replace();
        await f.publish(6n, [0n], true, true, replacement);
      }
      release(); await handling; await flush(256);
      if (mode === 'ordinary-replacement') {
        expect(received).toEqual(['5/0', '6/0']);
        expect(messages.filter(m => m.type === 'PUBLISH_DONE')).toEqual([]);
      } else {
        expect(sends).not.toHaveBeenCalled();
        expect(received).toEqual([]);
        expect(messages.filter(m => m.type === 'PUBLISH_DONE')).toMatchObject([{ requestId, statusCode: 0x12n }]);
      }
      expect(messages.filter(m => m.type === 'REQUEST_ERROR')).toEqual([]);
    } finally { release(); held.mockRestore(); sends.mockRestore(); await f.close(); }
  });
}

for (const draft of [18, 22] as const) it(`draft${draft} malformed generation aborts an accepted FETCH with exact code and releases capacity`, async () => {
  const f = await fixture(draft, { maxActiveHistoryRequests: 1 });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const send = f.down.server.sendFetchObject.bind(f.down.server);
  const held = vi.spyOn(f.down.server, 'sendFetchObject').mockImplementationOnce(async (...args) => { await send(...args); await gate; });
  try {
    await f.publish(4n, [0n, 1n]);
    const fetched = await f.fetch(4n, 4n, 2n);
    const stream = await f.up.client.openSubgroup(9n, 4n, 1n);
    await f.up.client.sendObject(stream, 2n, Uint8Array.of(99)); await flush(256);
    expect(f.down.resetReasons).toEqual([expect.objectContaining({ streamErrorCode: 0x12 }), expect.objectContaining({ streamErrorCode: 0x12 })]);
    expect(new Set(f.down.resetWriters).size, 'data and request directions reset once each').toBe(2);
    expect(fetched.terminal).toEqual(['reset']);
    expect(fetched.messages.filter(m => m.type === 'REQUEST_ERROR')).toEqual([]);
    expect(f.down.server.session.state).toBe('established');
    release(); await f.settled();
    const replacement = await f.replace(); await f.publish(5n, [0n], true, true, replacement);
    const next = await f.fetch(5n, 5n, 1n); await f.settled();
    expect(next.data).toEqual(['5/0']); expect(next.terminal).toEqual(['fin']);
  } finally { release(); held.mockRestore(); await f.close(); }
});

for (const draft of [18, 22] as const) it(`draft${draft} upstream terminal factory refusal cannot revive malformed fanout`, async () => {
  const f = await fixture(draft);
  const failure = new Error('coded reason unavailable');
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const sent: number[] = [], messages: ControlMessage[] = [];
  f.down.server.onSubscribe = (id, namespace, trackName) => { void f.relay.handleSubscribe(f.down.server, id, namespace, trackName); };
  f.down.client.onMessage = m => messages.push(m);
  try {
    const subscription = await f.down.client.subscribeTrack(ns, name, { onObject: o => { if (o.kind === 'data') sent.push(...o.payload); } });
    await f.publish(4n, [0n]);
    const transport: WebTransportLike = f.up.b;
    transport.createStreamError = () => { throw failure; };
    const bad = await f.up.client.openSubgroup(9n, 4n, 1n);
    await f.up.client.sendObject(bad, 1n, Uint8Array.of(99)); await flush(256);
    const later = await f.up.client.openSubgroup(9n, 5n, 0n);
    await f.up.client.sendObject(later, 0n, Uint8Array.of(88)); await flush(256);
    expect(sent).not.toContain(99); expect(sent).not.toContain(88);
    expect(errors.mock.calls.some(args => args.includes(failure))).toBe(true);
    expect(messages.filter(m => m.type === 'PUBLISH_DONE')).toMatchObject([{ requestId: subscription.requestId, statusCode: 0x12n }]);
  } finally { errors.mockRestore(); await f.close(); }
});

for (const draft of [18, 22] as const) for (const cancel of [false, true]) {
  it(`draft${draft} accepted pending owner terminates once across removal=${cancel}`, async () => {
    const f = await fixture(draft);
    let releaseAccept!: () => void, releaseTerminal!: () => void;
    const acceptanceGate = new Promise<void>(resolve => { releaseAccept = resolve; });
    const terminalGate = new Promise<void>(resolve => { releaseTerminal = resolve; });
    const accept = f.down.server.acceptSubscribe.bind(f.down.server);
    const terminate = f.down.server.terminateMalformedPublication.bind(f.down.server);
    let entered = false, terminating = false, requestId = -1n;
    let handling: Promise<void> | undefined;
    const messages: ControlMessage[] = [];
    const sends = vi.spyOn(f.down.server, 'sendObject');
    vi.spyOn(f.down.server, 'acceptSubscribe').mockImplementationOnce(async (...args) => { await accept(...args); entered = true; await acceptanceGate; });
    vi.spyOn(f.down.server, 'terminateMalformedPublication').mockImplementationOnce(async id => { terminating = true; await terminalGate; return terminate(id); });
    f.down.server.onSubscribe = (id, namespace, trackName) => { requestId = id; handling = f.relay.handleSubscribe(f.down.server, id, namespace, trackName); };
    f.down.client.onMessage = message => messages.push(message);
    try {
      await f.publish(4n, [0n]);
      void f.down.client.subscribeTrack(ns, name).catch(() => {}); await flush(128); expect(entered).toBe(true);
      const bad = await f.up.client.openSubgroup(9n, 4n, 1n);
      await f.up.client.sendObject(bad, 1n, Uint8Array.of(99)); await flush(128);
      releaseAccept(); await flush(128); expect(terminating).toBe(true);
      if (cancel) f.relay.removeSubscription(f.down.server, requestId);
      releaseTerminal(); await handling; await flush(128);
      expect(sends).not.toHaveBeenCalled();
      expect(messages.filter(m => m.type === 'PUBLISH_DONE')).toMatchObject([{ requestId, statusCode: 0x12n }]);
      expect(messages.filter(m => m.type === 'REQUEST_ERROR')).toEqual([]);
      expect(f.down.server.session.state).toBe('established');
    } finally { releaseAccept(); releaseTerminal(); await handling; await f.close(); }
  });
}
