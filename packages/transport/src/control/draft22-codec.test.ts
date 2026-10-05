/**
 * The draft-22 variant of the draft-18 control codec (`createControlCodec(22)`)
 * and the draft-22 LOCATION_FILTER mapping of {@link SubscriptionFilter}.
 */
import { describe, it, expect } from 'vitest';
import { createControlCodec } from './codec.js';
import {
  decodeFetchLocationFilter, decodeSubscriptionFilter, encodeFillParameters, encodeSubscriptionFilter,
  subscriptionWindow, validateSubscriptionFilter, windowContains, type SubscriptionFilter,
} from './subscription-filter.js';
import { bytesToHex } from '../vectors/load-vectors.js';
import {
  DRAFT22_MESSAGE_PARAM_REGISTRY, decodeMessageParams18, encodeMessageParams18, type MessageParamValue,
} from './message-params-18.js';
import type { ControlMessage, Fetch, Goaway } from './messages.js';

const codec18 = createControlCodec(18);
const codec22 = createControlCodec(22);
const enc = (s: string) => new TextEncoder().encode(s);

describe('draft-22 FETCH', () => {
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
    expect(bytesToHex(codec22.encode(fetch))).toBe('1600140701046c69766505766964656f0121040c050309');
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
    const decoded = codec22.decode(codec22.encode(fetch), 0).message as Fetch;
    expect(decodeFetchLocationFilter(decoded.parameters.get(0x21n)![0] as Uint8Array)).toEqual([2n, 0n, 2n]);
    expect(decoded.fetch).toMatchObject({ startLocation: { group: 2n, object: 0n }, endLocation: { group: 4n, object: 0n } });
  });

  it('has no Joining FETCH', () => {
    const joining: Fetch = {
      type: 'FETCH', requestId: 1n,
      fetch: { fetchType: 0x3, joiningRequestId: 0n, joiningStart: 0n },
      parameters: new Map(),
    };
    expect(() => codec22.encode(joining)).toThrow(/FILL_PARAMETERS/);
    expect(() => codec18.encode(joining)).not.toThrow();
  });
});

describe('draft-22 GOAWAY and PUBLISH_STATE_NOTIFY', () => {
  it('GOAWAY drops the Request ID', () => {
    const goaway: Goaway = { type: 'GOAWAY', newSessionUri: '', timeout: 5000n, requestId: 3n };
    expect(bytesToHex(codec22.encode(goaway))).toBe('100003009388');
    expect((codec18.decode(codec18.encode(goaway), 0).message as Goaway).requestId).toBe(3n);
  });

  it('PUBLISH_STATE_NOTIFY exists only on draft 22', () => {
    const notify = { type: 'PUBLISH_STATE_NOTIFY', parameters: new Map([[0x10n, [1n]]]) } as ControlMessage;
    const bytes = codec22.encode(notify);
    expect(codec22.decode(bytes, 0).message).toMatchObject({ type: 'PUBLISH_STATE_NOTIFY' });
    expect(() => codec18.encode(notify)).toThrow();
    expect(() => codec18.decode(bytes, 0)).toThrow();
  });
});

describe('draft-22 LOCATION_FILTER mapping (§9.20.9)', () => {
  const hex = (filter: SubscriptionFilter) => bytesToHex(encodeSubscriptionFilter(filter, 22));

  it('maps each filter to its typed form', () => {
    expect(hex({ type: 'NextGroupStart' })).toBe('0100');
    expect(hex({ type: 'LargestObject' })).toBe('05');
    expect(hex({ type: 'RelativeStart', groups: 3n })).toBe('0103');
    expect(hex({ type: 'AbsoluteStart', startGroup: 12n, startObject: 5n })).toBe('020c05');
    expect(hex({ type: 'AbsoluteRange', startGroup: 12n, startObject: 5n, endGroup: 15n })).toBe('030c0503');
    expect(hex({ type: 'AbsoluteRange', startGroup: 12n, startObject: 5n, endGroup: 15n, endObject: 7n }))
      .toBe('040c050307');
  });

  it('an open filter from {0, 0} is an absolute start, distinct from the Next Object', () => {
    expect(hex({ type: 'AbsoluteStart', startGroup: 0n, startObject: 0n })).toBe('020000');
    expect(decodeSubscriptionFilter(new Uint8Array([0x00]), 22))
      .toEqual({ type: 'AbsoluteStart', startGroup: 0n, startObject: 0n });
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
      expect(decodeSubscriptionFilter(encodeSubscriptionFilter(filter, 22), 22)).toEqual(filter);
    }
  });

  it('rejects malformed filters', () => {
    expect(validateSubscriptionFilter(new Uint8Array([6]), 22)).toMatch(/unknown Location Filter Type/);
    expect(validateSubscriptionFilter(new Uint8Array([2, 1]), 22)).toMatch(/truncated/);
    expect(validateSubscriptionFilter(new Uint8Array([5, 0]), 22)).toMatch(/after its fields/);
    expect(validateSubscriptionFilter(new Uint8Array([]), 22)).toMatch(/truncated/);
  });

  it('draft 22 forms have no draft-18 encoding', () => {
    expect(() => encodeSubscriptionFilter({ type: 'RelativeStart', groups: 1n }, 18)).toThrow(RangeError);
    expect(() => encodeSubscriptionFilter(
      { type: 'AbsoluteRange', startGroup: 1n, startObject: 0n, endGroup: 2n, endObject: 3n }, 18)).toThrow(RangeError);
  });

  it('FILL_PARAMETERS nests a typed LOCATION_FILTER with no Length', () => {
    expect(bytesToHex(encodeFillParameters({ type: 'RelativeStart', groups: 1n }))).toBe('210101');
    expect(bytesToHex(encodeFillParameters({ type: 'LargestObject' }))).toBe('2105');
    expect(encodeFillParameters().length).toBe(0);
  });

  it('frames the filter by its type, so a following parameter decodes', () => {
    const params = new Map<bigint, readonly MessageParamValue[]>([
      [0x21n, [{ kind: 'locationFilter', value: encodeSubscriptionFilter({ type: 'LargestObject' }, 22) }]],
      [0x22n, [{ kind: 'uint8', value: 2 }]],
    ]);
    const bytes = encodeMessageParams18(params, DRAFT22_MESSAGE_PARAM_REGISTRY);
    expect(bytesToHex(bytes)).toBe('0221050102');
    const back = decodeMessageParams18(bytes, 0, DRAFT22_MESSAGE_PARAM_REGISTRY);
    expect(back.bytesRead).toBe(bytes.length);
    expect(back.params.get(0x22n)).toEqual([{ kind: 'uint8', value: 2 }]);
  });
});

describe('subscription windows (re-applying a filter to a shared Track Alias, §3.1)', () => {
  const L = { group: 5n, object: 3n };
  const inWin = (filter: SubscriptionFilter | undefined, largest: typeof L | undefined, g: bigint, o: bigint) =>
    windowContains(subscriptionWindow(filter, largest), g, o);

  it('resolves the relative forms against Largest Object', () => {
    expect(subscriptionWindow({ type: 'NextGroupStart' }, L)).toEqual({ start: { group: 6n, object: 0n } });
    expect(subscriptionWindow({ type: 'LargestObject' }, L)).toEqual({ start: { group: 5n, object: 4n } });
    expect(subscriptionWindow({ type: 'RelativeStart', groups: 1n }, L)).toEqual({ start: { group: 5n, object: 0n } });
    expect(subscriptionWindow({ type: 'RelativeStart', groups: 9n }, L)).toEqual({ start: { group: 0n, object: 0n } });
  });

  it('with no Largest Object (empty track) every relative start is the beginning', () => {
    expect(subscriptionWindow({ type: 'NextGroupStart' }, undefined)).toEqual({ start: { group: 0n, object: 0n } });
    expect(subscriptionWindow({ type: 'LargestObject' }, undefined)).toEqual({ start: { group: 0n, object: 0n } });
  });

  it('checks start and inclusive end', () => {
    expect(inWin(undefined, L, 0n, 0n)).toBe(true);
    expect(inWin({ type: 'LargestObject' }, L, 5n, 3n)).toBe(false);
    expect(inWin({ type: 'LargestObject' }, L, 5n, 4n)).toBe(true);
    const range = { type: 'AbsoluteRange', startGroup: 2n, startObject: 1n, endGroup: 4n } as const;
    expect(inWin(range, L, 2n, 0n)).toBe(false);
    expect(inWin(range, L, 2n, 1n)).toBe(true);
    expect(inWin(range, L, 4n, 999n)).toBe(true); // whole end group
    expect(inWin(range, L, 5n, 0n)).toBe(false);
    const withEndObject = { ...range, endObject: 7n };
    expect(inWin(withEndObject, L, 4n, 7n)).toBe(true);
    expect(inWin(withEndObject, L, 4n, 8n)).toBe(false);
  });
});
