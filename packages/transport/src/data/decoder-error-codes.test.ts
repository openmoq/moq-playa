import { expect, it } from 'vitest';
import { createDataCodec } from './data-codec.js';
import { ProtocolViolationError } from '../errors.js';

const bytes = (hex: string) => Uint8Array.from(hex.split(' ').map(value => parseInt(value, 16)));
const max = (1n << 64n) - 1n;
for (const draft of [18, 22, 23] as const) {
  const codec = createDataCodec(draft);
  for (const [label, code, decode] of [
    ['datagram invalid status', 0x202, () => codec.decodeObjectDatagram(bytes('20 00 00 00 80 01'), 0)],
    ['datagram non-Normal properties', 0x202, () => codec.decodeObjectDatagram(bytes('21 00 00 00 80 02 02 01 03'), 0)],
    ['datagram reserved flags', 0x200, () => codec.decodeObjectDatagram(bytes('10'), 0)],
    ['datagram conflicting flags', 0x200, () => codec.decodeObjectDatagram(bytes('22'), 0)],
    ['datagram trailing STATUS payload', 0x201, () => codec.decodeObjectDatagram(bytes('20 00 00 00 80 00 aa'), 0)],
    ['subgroup invalid form', 0x200, () => codec.decodeSubgroupHeader(bytes('00'), 0)],
    ['subgroup reserved mode', 0x200, () => codec.decodeSubgroupHeader(bytes('16'), 0)],
    ['fetch invalid header', 0x200, () => codec.decodeFetchHeader(bytes('06'), 0)],
    ['subgroup invalid status', 0x202, () => codec.decodeSubgroupObject(bytes('00 00 01'), 0, false, 0n)],
    ['subgroup non-Normal properties', 0x202, () => codec.decodeSubgroupObject(bytes('00 02 02 01 00 03'), 0, true, 0n)],
    ['subgroup Object ID overflow', 0x400, () => codec.decodeSubgroupObject(bytes('00'), 0, false, max, false)],
    ['fetch Subgroup ID overflow', 0x400, () => codec.decodeFetchObject18!(bytes('02'), 0,
      { groupId: 0n, objectId: 0n, lastObjectSubgroupId: max, lastObjectPriority: 128 }, false, 'ascending')],
  ] as const) it(`draft ${draft} ${label} has the specified code`, () => {
    let error: unknown;
    try { decode(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ProtocolViolationError);
    expect((error as ProtocolViolationError).code).toBe(draft === 23 ? code : undefined);
  });
  it(`draft ${draft} accepts Normal STATUS and empty subgroup properties`, () => {
    expect(codec.decodeObjectDatagram(bytes('20 00 00 00 80 00'), 0).datagram.status).toBe(0n);
    expect(codec.decodeSubgroupObject(bytes('00 00 00 03'), 0, true, 0n).object.status).toBe(3n);
  });
}
