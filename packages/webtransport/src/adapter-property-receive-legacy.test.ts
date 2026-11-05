import { expect, it } from 'vitest';
import { MoqtConnection } from './adapter.js';
import { TransportSim, flush } from './testkit/stream-sim.js';
import { createControlCodec, decodePropertyBlock, encodeObjectDatagram18 } from '@openmoq/transport';
import type { MoqtObject, ObjectDatagram } from '@openmoq/transport';
import { encodeLocHeaders, parseLocHeaders, locWireProfileForDraft } from '../../loc/src/headers.js';
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map(x => parseInt(x, 16)));
const octet = (n: number | bigint) => Number(n).toString(16).padStart(2, '0');
async function connected(draft: 18 | 22) {
  const conn = new MoqtConnection(draft), transport = new TransportSim(), objects: MoqtObject[] = [], datagrams: ObjectDatagram[] = [], messages: string[] = [], errors: Error[] = [];
  conn.onObject = (_sid, obj) => { objects.push(obj); }; conn.onDatagram = obj => { datagrams.push(obj); };
  conn.onMessage = msg => { messages.push(msg.type); }; conn.onError = e => { errors.push(e); };
  transport.openIncomingUni().push(bytes('af000000')); await conn.connect(transport);
  return { conn, transport, objects, datagrams, messages, errors };
}

for (const draft of [18, 22] as const) for (const version of [1, 4] as const) {
  it(`draft${draft} preserves public LOC${version === 1 ? '01' : '04'} Object timestamp and audio-level delivery`, async () => {
    const f = await connected(draft), wireProfile = locWireProfileForDraft(draft);
    const epochUs = 1_700_000_000_000_000n;
    const audioLevel = { voiceActivity: true, level: 30 };
    const properties = encodeLocHeaders(version === 1 ? { captureTimestamp: epochUs, audioLevel }
      : { timestamp: 90_000n, timescale: 90_000n, timestampIsWallClock: false, audioLevel },
    { locVersion: version, wireProfile })!;
    try {
      expect(wireProfile).toBe('d18-delta-vi64');
      expect(decodePropertyBlock(properties, 0, { profile: wireProfile }).entries.map(entry => entry.id))
        .toEqual(version === 1 ? [0x02n, 0x06n] : [0x08n, 0x0cn, 0x10n]);
      expect(properties.length).toBeLessThan(64);
      await f.conn.subscribe([], bytes('76'));
      f.transport.bidi[0]!.push(bytes('0400021000')); await flush(512);
      const encoded = Array.from(properties, value => octet(value)).join('');
      f.transport.openIncomingUni().push(bytes('1110020700' + octet(properties.length) + encoded + '01aa'));
      await flush(512);
      expect(f.errors).toEqual([]); expect(f.transport.closeInfo).toBeUndefined();
      expect(f.transport.bidi[0]!.writeAborted).toBe(false); expect(f.objects).toHaveLength(1);
      const object = f.objects[0];
      expect(object?.kind).toBe('data');
      if (object?.kind !== 'data') throw new Error('LOC data was not delivered');
      expect(object.payload).toEqual(bytes('aa')); expect(object.extensions).toEqual(properties);
      expect(parseLocHeaders(object.extensions, { wireProfile })).toMatchObject({
        version, audioLevel, captureTimestamp: version === 1 ? epochUs : 1_000_000n,
        ...(version === 4 ? { timestamp: 90_000n, timescale: 90_000n, timestampIsWallClock: false } : {}),
      });
    } finally { await f.conn.close(); }
  });
}

for (const draft of [18, 22] as const) {
  for (const channel of ['fetch', 'subgroup', 'datagram'] as const) for (const [block, valid] of [
    ['2201', false], ['c0400100', false], ['3c010001', false], ['3e010001', false],
    ['02010002', true], ['06010002', true], ['8042010002', true],
  ] as const) it(`draft${draft} ${channel} applies Object scope/multiplicity to ${block}`, async () => {
    const f = await connected(draft);
    try {
      if (channel === 'fetch') { await f.conn.fetch([], bytes('76'), { startGroup: 0n, startObject: 0n, endGroup: 9n, endObject: 0n }); f.transport.bidi[0]!.push(bytes('18000400020900')); }
      else { await f.conn.subscribe([], bytes('76')); f.transport.bidi[0]!.push(bytes('0400021000')); }
      await flush(512); expect(f.errors).toEqual([]);
      if (channel === 'fetch') f.transport.openIncomingUni().push(bytes('05003f02000307' + octet(block.length / 2) + block + '01aa'));
      else if (channel === 'subgroup') f.transport.openIncomingUni().push(bytes('1110020700' + octet(block.length / 2) + block + '01aa'));
      else f.transport.pushDatagram(encodeObjectDatagram18({ typeByte: 1, trackAlias: 16n, groupId: 2n, objectId: 0n, publisherPriority: 7,
        isEndOfGroup: false, extensions: bytes(block), payload: bytes('aa'), status: undefined }));
      await flush(512);
      expect(f.transport.closeInfo).toBeUndefined();
      expect([...f.objects, ...f.datagrams]).toHaveLength(valid ? 1 : 0);
      expect(f.transport.bidi[0]!.writeAborted).toBe(!valid);
      if (valid) { expect(f.errors).toEqual([]); expect([...f.objects, ...f.datagrams][0]).toMatchObject({ payload: bytes('aa') }); }
    } finally { await f.conn.close(); }
  });
  for (const block of ['22010001', '8042010002']) it(`draft${draft} repeated Track property ${block} remains accepted`, async () => {
    const f = await connected(draft);
    try {
      await f.conn.fetch([], bytes('76'), { startGroup: 0n, startObject: 0n, endGroup: 9n, endObject: 0n });
      f.transport.bidi[0]!.push(bytes('1800' + octet(4 + block.length / 2) + '00020900' + block)); await flush(512);
      expect(f.messages).toContain('FETCH_OK'); expect(f.errors).toEqual([]);
      expect(f.transport.bidi[0]!.writeAborted).toBe(false); expect(f.transport.closeInfo).toBeUndefined();
    } finally { await f.conn.close(); }
  });
  for (const context of ['fetch', 'subscribe', 'status', 'publish'] as const) it(`draft${draft} ${context} rejects Object-only Track properties before semantic callbacks`, async () => {
    const f = await connected(draft); let publishes = 0; f.conn.onPublish = () => { publishes++; };
    try {
      const codec = createControlCodec(draft), props = new Map([[0x3en, [1n]]]);
      if (context === 'publish') f.transport.pushIncomingBidi().push(codec.encode({ type: 'PUBLISH', requestId: 1n, trackNamespace: [], trackName: bytes('76'), trackAlias: 16n, parameters: new Map(), trackProperties: props }));
      else {
        if (context === 'fetch') await f.conn.fetch([], bytes('76'), { startGroup: 0n, startObject: 0n, endGroup: 9n, endObject: 0n });
        else if (context === 'subscribe') await f.conn.subscribe([], bytes('76'));
        else await f.conn.trackStatus([], bytes('76'));
        f.transport.bidi[0]!.push(codec.encode(context === 'fetch' ? { type: 'FETCH_OK', requestId: 0n, parameters: new Map(), endLocation: { group: 9n, object: 0n }, endOfTrack: 0, trackProperties: props }
          : context === 'subscribe' ? { type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: 16n, parameters: new Map(), trackProperties: props }
          : { type: 'REQUEST_OK', requestId: 0n, parameters: new Map(), trackProperties: props }));
      }
      await flush(512);
      expect(f.transport.closeInfo).toBeUndefined(); expect(publishes).toBe(0); expect(f.messages).toEqual([]);
      if (context === 'status') {
        // The one-shot topology already FINned its writable half on REQUEST_OK.
        expect(f.transport.bidi[0]!.writeClosed).toBe(true);
        expect(f.transport.bidi[0]!.readCancelled).toBe(true);
        expect(f.errors.some(error => /Track rejected/.test(error.message))).toBe(true);
      } else if (context !== 'publish') expect(f.transport.bidi[0]!.writeAborted).toBe(true);
    } finally { await f.conn.close(); }
  });
}

for (const draft of [18, 22] as const) {
  it(`draft${draft} local Track scope refusal consumes no request or alias ownership`, async () => {
    const f = await connected(draft);
    try {
      await expect(f.conn.publish([], bytes('76'), 42n, { trackProperties: new Map([[0x3en, [1n]]]) })).rejects.toThrow(/object-only/);
      expect(f.transport.bidi).toHaveLength(0);
      const id = await f.conn.publish([], bytes('76'), 42n);
      expect(id).toBe(0n); expect(f.transport.bidi).toHaveLength(1);
      expect(f.errors).toEqual([]); expect(f.transport.closeInfo).toBeUndefined();
    } finally { await f.conn.close(); }
  });
  it(`draft${draft} local Object scope refusal keeps the same subgroup writer and next Object ID usable`, async () => {
    const f = await connected(draft);
    try {
      const id = await f.conn.publish([], bytes('76'), 42n);
      f.transport.bidi[0]!.push(createControlCodec(draft).encode({ type: 'REQUEST_OK', requestId: id, parameters: new Map() })); await flush(512);
      const stream = await f.conn.openSubgroup(42n, 2n, 0n, { hasExtensions: true });
      const writer = f.transport.uniOut.at(-1)!; const before = writer.writtenBytes();
      await expect(f.conn.sendObject(stream, 0n, bytes('aa'), bytes('2201'))).rejects.toThrow(/track-only/);
      expect(writer.writtenBytes()).toEqual(before); expect(writer.writeAborted).toBe(false);
      await f.conn.sendObject(stream, 0n, bytes('aa'), bytes('8042010002'));
      expect(writer.writtenBytes().length).toBeGreaterThan(before.length);
      await f.conn.closeSubgroup(stream); expect(f.errors).toEqual([]); expect(f.conn.getPublishForwardState(id)).toBe(true);
    } finally { await f.conn.close(); }
  });
  it(`draft${draft} local FETCH Object refusal keeps its writer and first-object context`, async () => {
    const f = await connected(draft);
    try {
      f.transport.pushIncomingBidi().push(createControlCodec(draft).encode({ type: 'FETCH', requestId: 1n,
        fetch: { fetchType: 1, trackNamespace: [], trackName: bytes('76'), startLocation: { group: 0n, object: 0n }, endLocation: { group: 9n, object: 0n } }, parameters: new Map() }));
      await flush(512); const stream = await f.conn.openFetchStream(1n);
      const writer = f.transport.uniOut.at(-1)!; const before = writer.writtenBytes();
      const fields = { groupId: 0n, subgroupId: 0n, objectId: 0n, publisherPriority: 7, payload: bytes('aa') };
      await expect(f.conn.sendFetchObject(stream, { ...fields, extensions: bytes('2201') })).rejects.toThrow(/track-only/);
      expect(writer.writtenBytes()).toEqual(before); expect(writer.writeAborted).toBe(false);
      await f.conn.sendFetchObject(stream, { ...fields, extensions: bytes('8042010002') });
      expect(writer.writtenBytes().length).toBeGreaterThan(before.length); await f.conn.closeFetchStream(stream);
      expect(f.errors).toEqual([]); expect(f.transport.closeInfo).toBeUndefined();
    } finally { await f.conn.close(); }
  });
}
