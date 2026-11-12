// Regression probes from the independent evaluations. Real MoqtConnection over TransportSim stream doubles.
import { expect, it, vi } from 'vitest';
import { createControlCodec, encodePropertyBlock } from '@openmoq/transport';
import type { MoqtObject, SubscribeOk } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
import { TransportSim, flush } from './testkit/stream-sim.js';
import { connect as connectDraft, object, streamHeader } from './testkit/object-reception.js';
import { ns, nm } from './testkit/pair.js';

const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);

async function connect(draft: 18 | 22, ttl: number) {
  const conn = new MoqtConnection(draft, { joiningFetchTimeoutMs: ttl });
  const transport = new TransportSim();
  transport.openIncomingUni().push(createControlCodec(draft).encode({ type: 'SETUP', setupOptions: new Map() }));
  await conn.connect(transport);
  conn.onError = () => {};
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  return { conn, transport, codec: createControlCodec(draft) };
}

function publishBytes(draft: 18 | 22, alias: bigint) {
  return createControlCodec(draft).encode({ type: 'PUBLISH', requestId: 1n, trackAlias: alias,
    trackNamespace: ns('probe'), trackName: nm('video'), parameters: new Map(), trackProperties: new Map() } as never);
}

for (const draft of [18, 22] as const) {
  // P1: early Object, PUBLISH, handler installed in onPublish, acceptance after the hold TTL,
  // then the same subgroup stream continues.
  it(`P1 draft${draft} acceptance after the hold TTL: later Objects on the same stream`, async () => {
    const { conn, transport } = await connect(draft, 50);
    const delivered: bigint[] = [];
    conn.onPublish = pub => { pub.onObject = o => delivered.push(o.objectId); };
    try {
      const data = transport.openIncomingUni();
      data.push(streamHeader(draft, { trackAlias: 41n, groupId: 7n }));
      data.push(object(draft, 0n, new Uint8Array([0]), null)); await flush(128);
      const request = transport.pushIncomingBidi();
      request.push(publishBytes(draft, 41n)); await flush(128);
      data.push(object(draft, 1n, new Uint8Array([1]), 0n)); await flush(128);
      await wait(80);
      await conn.acceptSubscribe(1n, 41n); await flush(128); await wait(0);
      const cancelledBeforeAccept = data.readCancelled;
      try { data.push(object(draft, 2n, new Uint8Array([2]), 1n)); } catch { /* reader cancelled */ } await flush(128);
      expect({ delivered, cancelledBeforeAccept }).toEqual({ delivered: [0n, 1n, 2n], cancelledBeforeAccept: false });
    } finally { vi.useRealTimers(); await conn.close(); }
  });

  // P1b: PUBLISH itself arrives after the TTL of the first early Object.
  it(`P1b draft${draft} PUBLISH arriving after the hold TTL: later Objects on the same stream`, async () => {
    const { conn, transport } = await connect(draft, 50);
    const delivered: bigint[] = [];
    conn.onPublish = pub => { pub.onObject = o => delivered.push(o.objectId); };
    try {
      const data = transport.openIncomingUni();
      data.push(streamHeader(draft, { trackAlias: 41n, groupId: 7n }));
      data.push(object(draft, 0n, new Uint8Array([0]), null)); await flush(128);
      await wait(80);
      const request = transport.pushIncomingBidi();
      request.push(publishBytes(draft, 41n)); await flush(128);
      await conn.acceptSubscribe(1n, 41n); await flush(128); await wait(0);
      const cancelledBeforePublish = data.readCancelled;
      try { data.push(object(draft, 1n, new Uint8Array([1]), 0n)); } catch { /* reader cancelled */ } await flush(128);
      expect({ delivered, cancelledBeforePublish }).toEqual({ delivered: [1n], cancelledBeforePublish: false });
    } finally { vi.useRealTimers(); await conn.close(); }
  });

  // P3: an unclaimed hold on another alias shares the byte quota with subscribeTrack's early buffer.
  it(`P3 draft${draft} unknown-alias hold vs a pending subscribeTrack early Object`, async () => {
    const { conn, transport, codec } = await connect(draft, 10_000);
    const generic: bigint[] = [];
    conn.onObject = (_sid, o) => generic.push(o.trackAlias as bigint);
    try {
      const stray = transport.openIncomingUni();
      stray.push(streamHeader(draft, { trackAlias: 50n, groupId: 1n }));
      stray.push(object(draft, 0n, new Uint8Array(8 * 1024 * 1024), null)); await flush(256);
      const got: MoqtObject[] = [];
      const subP = conn.subscribeTrack(ns('a'), nm('1'), { onObject: o => got.push(o) }); await flush(128);
      const early = transport.openIncomingUni();
      early.push(streamHeader(draft, { trackAlias: 60n, groupId: 3n }));
      early.push(object(draft, 0n, new Uint8Array([9]), null)); await flush(128);
      const reqStream = transport.bidi.at(-1)!;
      reqStream.push(codec.encode({ type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: 60n, parameters: new Map(), trackExtensions: new Map() } as SubscribeOk));
      await subP; await flush(128); await wait(0); await flush(128);
      expect(got.map(o => `${o.groupId}/${o.objectId}`)).toEqual(['3/0']);
    } finally { vi.useRealTimers(); await conn.close(); }
  });

}

for (const draft of [18, 22] as const) for (const [remaining, suffix] of [[10, 20], [2, 2]]) {
  // P7: a publish hold's bytes count against the SUBSCRIBE replay window's fatal overflow check.
  it(`P7 draft${draft} unknown-alias hold during a subscribeTrack replay window (${remaining}/${suffix})`, async () => {
    const { conn, transport, codec } = await connect(draft, 10_000);
    let closed = false;
    conn.onClose = () => { closed = true; };
    try {
      const stray = transport.openIncomingUni();
      stray.push(streamHeader(draft, { trackAlias: 50n, groupId: 1n }));
      stray.push(object(draft, 0n, new Uint8Array(8 * 1024 * 1024 - remaining!), null)); await flush(256);
      const got: string[] = [];
      const subP = conn.subscribeTrack(ns('a'), nm('1'), { onObject: o => got.push(`${o.groupId}/${o.objectId}`) }); await flush(128);
      const early = transport.openIncomingUni();
      early.push(streamHeader(draft, { trackAlias: 60n, groupId: 3n }));
      early.push(object(draft, 0n, new Uint8Array([9]), null)); await flush(128);
      const reqStream = transport.bidi.at(-1)!;
      reqStream.push(codec.encode({ type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: 60n, parameters: new Map(), trackExtensions: new Map() } as SubscribeOk));
      early.push(object(draft, 1n, new Uint8Array(suffix!), 0n));
      await flush(256);
      await subP.catch(() => {}); await wait(0); await flush(128);
      expect({ got, closed, state: conn.session.state }).toEqual({ got: ['3/0', '3/1'], closed: false, state: 'established' });
    } finally { vi.useRealTimers(); await conn.close(); }
  });
}

for (const draft of [18, 22] as const) it(`draft${draft} property bytes overflow a claimed hold in order`, async () => {
  const { conn, transport } = await connect(draft, 10_000);
  const delivered: bigint[] = [];
  const errors: Error[] = []; conn.onError = e => errors.push(e);
  conn.onPublish = pub => { pub.onObject = o => delivered.push(o.objectId); };
  try {
    const data = transport.openIncomingUni();
    data.push(streamHeader(draft, { trackAlias: 41n, properties: true }));
    data.push(object(draft, 0n, Uint8Array.of(0), null, { properties: true })); await flush(128);
    transport.pushIncomingBidi().push(publishBytes(draft, 41n)); await flush(128);
    const properties = encodePropertyBlock(Array.from({ length: 129 }, (_, i) => ({ id: 0x31n + 2n * BigInt(i), value: new Uint8Array(65535) })), 'd18-delta-vi64');
    data.push(object(draft, 1n, Uint8Array.of(1), 0n, { properties })); await flush(256);
    data.push(object(draft, 2n, Uint8Array.of(2), 1n, { properties: true })); await flush(128);
    expect(delivered).toEqual([0n, 1n, 2n]);
    expect(conn.session.state).toBe('established');
    expect(errors).toEqual([]);
  } finally { vi.useRealTimers(); await conn.close(); }
});

for (const draft of [16, 18, 22] as const) it(`draft${draft} unclaimed expiry leaves generic delivery readable`, async () => {
  const { connection: conn, transport } = await connectDraft(draft);
  const delivered: bigint[] = [];
  conn.onObject = (_id, o) => delivered.push(o.objectId);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const data = transport.openIncomingUni();
    data.push(streamHeader(draft, { trackAlias: 41n }));
    data.push(object(draft, 0n, Uint8Array.of(0), null)); await flush(128);
    await vi.advanceTimersByTimeAsync(10001);
    expect(data.readCancelled).toBe(false);
    data.push(object(draft, 1n, Uint8Array.of(1), 0n)); await flush(128);
    expect(delivered).toEqual([0n, 1n]);
  } finally { vi.useRealTimers(); await conn.close(); }
});
