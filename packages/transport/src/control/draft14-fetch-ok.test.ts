import { describe, expect, it } from 'vitest';
import { Draft14Codec } from './draft14-codec.js';
import type { FetchOk, Parameters } from './messages.js';
import { MessageParam } from '@openmoq/transport';
import { varint } from '@openmoq/transport';

const codec = new Draft14Codec();
const message = (parameters: Parameters = new Map()): FetchOk => ({ type: 'FETCH_OK', requestId: varint(3n),
  endOfTrack: 0, endLocation: { group: varint(10n), object: varint(5n) }, parameters });

describe('draft-14 FETCH_OK encoding', () => {
  it('writes the section 9.17 fields with the default ascending order', () => {
    // Request 3, ascending, not EOT, Location 10:5, no parameters.
    expect([...codec.encode(message())]).toEqual([0x18, 0, 6, 3, 1, 0, 10, 5, 0]);
  });
  it('writes descending EOT and absolute KVP without duplicating inline Group Order', () => {
    const parameters: Parameters = new Map([[MessageParam.GROUP_ORDER, [varint(2n)]], [varint(64n), [varint(9n)]]]);
    const msg: FetchOk = { ...message(parameters), requestId: varint(64n), endOfTrack: 1,
      endLocation: { group: varint(16384n), object: varint(7n) } };
    const bytes = codec.encode(msg);
    expect([...bytes]).toEqual([0x18, 0, 13, 0x40, 0x40, 2, 1, 0x80, 0, 0x40, 0, 7, 1, 0x40, 0x40, 9]);
    expect(codec.decode(bytes, 0).message).toMatchObject(msg);
    expect(parameters).toEqual(new Map([[MessageParam.GROUP_ORDER, [varint(2n)]], [varint(64n), [varint(9n)]]]));
  });
  it.each([0n, 3n, 256n])('refuses invalid inline Group Order %s instead of truncating', order => {
    expect(() => codec.encode(message(new Map([[MessageParam.GROUP_ORDER, [varint(order)]]])))).toThrow(/FETCH_OK.*Group Order/);
  });
  it('refuses multiple Group Order values', () => {
    expect(() => codec.encode(message(new Map([[MessageParam.GROUP_ORDER, [varint(1n), varint(2n)]]])))).toThrow(/FETCH_OK.*Group Order/);
  });
  it('refuses bytes masquerading as inline Group Order', () => {
    expect(() => codec.encode(message(new Map([[MessageParam.GROUP_ORDER, [Uint8Array.of(2)]]])))).toThrow(/FETCH_OK.*Group Order/);
  });
  it('refuses nonbinary EOT', () => {
    const invalid = { ...message(), endOfTrack: 2 } as unknown as FetchOk;
    expect(() => codec.encode(invalid)).toThrow(/FETCH_OK.*End Of Track/);
  });
  it.each(['trackProperties', 'trackExtensions'] as const)('does not silently drop unsupported %s', field => {
    const invalid = { ...message(), [field]: new Map([[varint(4n), [varint(9n)]]]) };
    expect(() => codec.encode(invalid)).toThrow(/FETCH_OK.*Track/);
  });
});


describe('FETCH_OK absolute params and uint16 boundary', () => {
  it('CONTROL: uses an absolute type for each occurrence and counts repeated remaining KVPs', () => {
    const parameters: Parameters = new Map([[MessageParam.GROUP_ORDER, [varint(2n)]],
      [varint(64n), [varint(9n), varint(10n)]], [varint(66n), [varint(11n)]]]);
    expect([...codec.encode(message(parameters))]).toEqual([
      0x18, 0, 15, 3, 2, 0, 10, 5, 3, 0x40, 0x40, 9, 0x40, 0x40, 10, 0x40, 0x42, 11,
    ]);
    expect(parameters.size).toBe(3);
  });
  it('CONTROL: encodes a full 65535-byte control frame without changing its extent', () => {
    const bytes = codec.encode(message(new Map([[varint(65n), [new Uint8Array(65520)]]])));
    expect([...bytes.subarray(0, 3)]).toEqual([0x18, 0xff, 0xfc]);
    expect(bytes.length).toBe(65535); expect(codec.peekFrameSize(bytes)).toBe(bytes.length);
    expect(codec.decode(bytes, 0).bytesRead).toBe(bytes.length);
  });
  it('rejects one byte beyond the uint16 control payload instead of wrapping Length to zero', () => {
    expect(() => codec.encode(message(new Map([[varint(65n), [new Uint8Array(65524)]]]))))
      .toThrow();
  });
});

it('rejects a FETCH_OK one byte above the TOTAL control-message limit', () => {
  expect(() => codec.encode(message(new Map([[varint(65n), [new Uint8Array(65521)]]])))).toThrow(/65535/);
});
