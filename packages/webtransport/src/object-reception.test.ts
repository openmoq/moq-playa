/**
 * The reception component on its own: a receive outcome and its accounting are
 * settled before any listener runs, so a listener tearing everything down from
 * a callback cannot throw out of observation, drop bytes already received, or
 * turn a decoded Object incomplete. Primitive probes, no transport timing.
 */
import { describe, expect, it } from 'vitest';
import type { ObjectHeaderLayout } from '@openmoq/transport';
import { ObjectReceptionObservers, type ReceptionCarrier, type ObjectReceptionEvent, type ObjectReception } from './object-reception.js';

const carrier = (): ReceptionCarrier => ({ origin: 'subgroup', streamId: 1n, trackAlias: 1n, requestId: null, groupId: 0n, subgroupId: 0n,
  publisherPriority: 0, subgroupFromFirstObject: false });
/** A 2-byte header declaring a 6-byte payload. */
const layout: ObjectHeaderLayout = { kind: 'object', headerBytes: 2, payloadLength: 6n, objectStatus: undefined, propertiesOffset: undefined,
  propertiesLength: 0, groupId: undefined, subgroupId: undefined, objectId: 0n, publisherPriority: undefined, isDatagram: false };

/** One reader at t=10 whose 5 buffered bytes start an Object; `onHeader` runs inside the first listener's header callback. */
function setup(onHeader?: (o: ObjectReceptionObservers) => void, extraListener = false) {
  const tokens = new WeakMap<object, ObjectReception>();
  const o = new ObjectReceptionObservers(() => 10, tokens), reader = {}, events: ObjectReceptionEvent[] = [], second: ObjectReceptionEvent[] = [];
  o.observe(e => { events.push(e); if (e.type === 'header') onHeader?.(o); });
  if (extraListener) o.observe(e => { second.push(e); });
  o.streamRead(reader, 5);
  o.objectsBegin(reader, 5, carrier);
  return { o, reader, events, second, tokens };
}
const types = (events: readonly ObjectReceptionEvent[]) => events.map(e => e.type);

describe('settled before exposure', () => {
  it('a header listener closing everything does not throw out of pending', () => {
    const { o, reader } = setup(x => x.closeAll());
    expect(() => o.pending(reader, new Uint8Array(5), () => layout, carrier)).not.toThrow();
  });

  it('a header-time teardown reports the payload bytes already received in that read, with their time', () => {
    const { o, reader, events } = setup(x => x.closeAll());
    o.pending(reader, new Uint8Array(5), () => layout, carrier);
    expect(types(events)).toEqual(['header', 'end']);
    expect(events.at(-1)).toMatchObject({ type: 'end', outcome: 'interrupted', reason: 'connection-closed', payloadReceived: 3n,
      firstPayloadByteObservedAt: 10, lastPayloadByteObservedAt: 10 });
  });

  it('no progress follows an end: a torn-down attempt reports its bytes in the end only', () => {
    const { o, reader, events, second } = setup(x => x.closeAll(), true);
    o.pending(reader, new Uint8Array(5), () => layout, carrier);
    for (const seen of [events, second]) expect(types(seen), 'every listener: header then end').toEqual(['header', 'end']);
  });

  it('an Object the decoder completed stays complete across a header-time teardown, with its correlation installed', () => {
    const { o, reader, events, second, tokens } = setup(x => x.closeAll(), true);
    const delivered = {};
    o.complete(reader, delivered, 0, layout, new Uint8Array(8), carrier);
    for (const seen of [events, second]) {
      expect(types(seen)).toEqual(['header', 'end']);
      expect(seen.at(-1)).toMatchObject({ type: 'end', outcome: 'complete', payloadReceived: 6n, firstPayloadByteObservedAt: 10,
        lastPayloadByteObservedAt: 10, observedAt: 10 });
    }
    expect(o.receptionFor(delivered)).toBe(events[0]!.reception);
    expect(tokens.get(delivered), 'the shared identity map holds it too').toBe(events[0]!.reception);
  });

  it('an attempt announced earlier still completes when a listener tears down inside its end callback', () => {
    const o = new ObjectReceptionObservers(() => 10), reader = {}, events: ObjectReceptionEvent[] = [];
    o.observe(e => { events.push(e); if (e.type === 'end') o.closeAll(); });
    o.streamRead(reader, 3);
    o.objectsBegin(reader, 3, carrier);
    o.pending(reader, new Uint8Array(3), () => layout, carrier);
    o.objectRead(reader, 3, 5, carrier);
    const delivered = {};
    o.complete(reader, delivered, 0, layout, new Uint8Array(8), carrier);
    expect(types(events)).toEqual(['header', 'progress', 'end']);
    expect(events.at(-1)).toMatchObject({ outcome: 'complete', payloadReceived: 6n });
    expect(o.receptionFor(delivered)).toBe(events[0]!.reception);
  });

  it('ordinary partial reception is a healthy control', () => {
    const { o, reader, events } = setup();
    o.pending(reader, new Uint8Array(5), () => layout, carrier);
    o.closeAll();
    expect(types(events)).toEqual(['header', 'progress', 'end']);
    expect(events.at(-1)).toMatchObject({ outcome: 'interrupted', payloadReceived: 3n });
  });

  it('stream ends carry the Object Status the header carried', () => {
    const { o, reader, events } = setup();
    const status: ObjectHeaderLayout = { ...layout, headerBytes: 3, payloadLength: 0n, objectStatus: 3n };
    o.complete(reader, {}, 0, status, new Uint8Array(3), carrier);
    expect(events.map(e => e.type === 'progress' ? null : e.objectStatus)).toEqual([3n, 3n]);
  });
});
