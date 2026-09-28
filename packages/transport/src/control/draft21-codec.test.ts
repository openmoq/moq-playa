/**
 * The draft-21 variant of the draft-18 control codec (`createControlCodec(21)`)
 * and the draft-21 LOCATION_FILTER mapping of {@link SubscriptionFilter}.
 */
import { describe, it, expect } from 'vitest';
import { createControlCodec } from './codec.js';
import {
  decodeLocationFilterFields, decodeSubscriptionFilter, encodeFillParameters, encodeSubscriptionFilter,
  validateSubscriptionFilter, type SubscriptionFilter,
} from './subscription-filter.js';
import { bytesToHex } from '../vectors/load-vectors.js';
import type { ControlMessage, Fetch, Goaway } from './messages.js';

const codec18 = createControlCodec(18);
const codec21 = createControlCodec(21);
const enc = (s: string) => new TextEncoder().encode(s);

describe('draft-21 FETCH', () => {
  it('encodes a standalone range as a LOCATION_FILTER (the relay/moqxr vector)', () => {
    const fetch: Fetch = {
      type: 'FETCH',
      requestId: 7n,
      fetch: {
        fetchType: 0x1, trackNamespace: [enc('live')], trackName: enc('video'),
        startLocation: { group: 12n, object: 5n }, endLocation: { group: 15n, object: 10n },
      },
      parameters: new Map(),
    };
    expect(bytesToHex(codec21.encode(fetch))).toBe('1600140701046c69766505766964656f0121040c050309');
  });

  it('an End Object of 0 is the whole End Group: EndObject is omitted', () => {
    const fetch: Fetch = {
      type: 'FETCH', requestId: 1n,
      fetch: {
        fetchType: 0x1, trackNamespace: [enc('live')], trackName: enc('video'),
        startLocation: { group: 2n, object: 0n }, endLocation: { group: 4n, object: 0n },
      },
      parameters: new Map(),
    };
    const decoded = codec21.decode(codec21.encode(fetch), 0).message as Fetch;
    expect(decodeLocationFilterFields(decoded.parameters.get(0x21n)![0] as Uint8Array)).toEqual([2n, 0n, 2n]);
    expect(decoded.fetch).toMatchObject({ startLocation: { group: 2n, object: 0n }, endLocation: { group: 4n, object: 0n } });
  });

  it('has no Joining FETCH', () => {
    const joining: Fetch = {
      type: 'FETCH', requestId: 1n,
      fetch: { fetchType: 0x3, joiningRequestId: 0n, joiningStart: 0n },
      parameters: new Map(),
    };
    expect(() => codec21.encode(joining)).toThrow(/FILL_PARAMETERS/);
    expect(() => codec18.encode(joining)).not.toThrow();
  });
});

describe('draft-21 GOAWAY and PUBLISH_STATE_NOTIFY', () => {
  it('GOAWAY drops the Request ID', () => {
    const goaway: Goaway = { type: 'GOAWAY', newSessionUri: '', timeout: 5000n, requestId: 3n };
    expect(bytesToHex(codec21.encode(goaway))).toBe('100003009388');
    expect((codec18.decode(codec18.encode(goaway), 0).message as Goaway).requestId).toBe(3n);
  });

  it('PUBLISH_STATE_NOTIFY exists only on draft 21', () => {
    const notify = { type: 'PUBLISH_STATE_NOTIFY', parameters: new Map([[0x10n, [1n]]]) } as ControlMessage;
    const bytes = codec21.encode(notify);
    expect(codec21.decode(bytes, 0).message).toMatchObject({ type: 'PUBLISH_STATE_NOTIFY' });
    expect(() => codec18.encode(notify)).toThrow();
    expect(() => codec18.decode(bytes, 0)).toThrow();
  });
});

describe('draft-21 LOCATION_FILTER mapping', () => {
  const fields = (filter: SubscriptionFilter) => decodeLocationFilterFields(encodeSubscriptionFilter(filter, 21));

  it('maps each filter to its draft-21 form', () => {
    expect(fields({ type: 'NextGroupStart' })).toEqual([0n]);
    expect(fields({ type: 'LargestObject' })).toEqual([0n, 0n]);
    expect(fields({ type: 'RelativeStart', groups: 1n })).toEqual([1n]);
    expect(fields({ type: 'AbsoluteStart', startGroup: 12n, startObject: 5n })).toEqual([12n, 5n]);
    expect(fields({ type: 'AbsoluteRange', startGroup: 12n, startObject: 5n, endGroup: 15n })).toEqual([12n, 5n, 3n]);
    expect(fields({ type: 'AbsoluteRange', startGroup: 12n, startObject: 5n, endGroup: 15n, endObject: 7n }))
      .toEqual([12n, 5n, 3n, 7n]);
  });

  it('an open filter from {0, 0} is the zero-length "no filter", not the Next Object', () => {
    expect(encodeSubscriptionFilter({ type: 'AbsoluteStart', startGroup: 0n, startObject: 0n }, 21).length).toBe(0);
  });

  it('decodes back to the same filter', () => {
    const filters: SubscriptionFilter[] = [
      { type: 'NextGroupStart' },
      { type: 'LargestObject' },
      { type: 'RelativeStart', groups: 3n },
      { type: 'AbsoluteStart', startGroup: 12n, startObject: 5n },
      { type: 'AbsoluteStart', startGroup: 0n, startObject: 0n },
      { type: 'AbsoluteRange', startGroup: 12n, startObject: 5n, endGroup: 15n },
      { type: 'AbsoluteRange', startGroup: 12n, startObject: 5n, endGroup: 15n, endObject: 7n },
    ];
    for (const filter of filters) {
      expect(decodeSubscriptionFilter(encodeSubscriptionFilter(filter, 21), 21)).toEqual(filter);
    }
  });

  it('rejects malformed filters', () => {
    expect(validateSubscriptionFilter(new Uint8Array([1, 2, 3, 4, 5]), 21)).toMatch(/more than four/);
    expect(validateSubscriptionFilter(new Uint8Array([0x80]), 21)).toMatch(/truncated/); // vi64: a 2-byte value cut short
  });

  it('draft 21 forms have no draft-18 encoding', () => {
    expect(() => encodeSubscriptionFilter({ type: 'RelativeStart', groups: 1n }, 18)).toThrow(RangeError);
    expect(() => encodeSubscriptionFilter(
      { type: 'AbsoluteRange', startGroup: 1n, startObject: 0n, endGroup: 2n, endObject: 3n }, 18)).toThrow(RangeError);
  });

  it('FILL_PARAMETERS nests a LOCATION_FILTER in a bare parameter sequence', () => {
    expect(bytesToHex(encodeFillParameters({ type: 'RelativeStart', groups: 1n }))).toBe('210101');
    expect(encodeFillParameters().length).toBe(0);
  });
});
