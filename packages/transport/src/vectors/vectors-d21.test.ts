/**
 * Draft-21 cross-implementation wire vectors.
 *
 * `packages/transport/vectors/d21/wire-vectors.txt` is shared with red5-moq-relay:
 * the vectors were produced by (or verified against) moqxr's draft-21 codec, so
 * decoding them here checks Playa against two other implementations. Every
 * control vector must decode with the draft-21 codec and re-encode to the same
 * bytes; the frames playback depends on are also checked field by field.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vectorsDir, bytesToHex, hexToBytes } from './load-vectors.js';
import { createControlCodec } from '../control/codec.js';
import { decodeMessageParams18, DRAFT21_MESSAGE_PARAM_REGISTRY } from '../control/message-params-18.js';
import { decodeLocationFilterFields } from '../control/subscription-filter.js';
import type {
  ControlMessage, Fetch, FetchOk, Goaway, PublishStateNotify, Subscribe, SubscribeOk, PublishDone,
} from '../control/messages.js';

interface Vector {
  readonly name: string;
  readonly kind: 'control' | 'parameter' | 'stream';
  readonly bytes: Uint8Array;
}

function loadD21(): Map<string, Vector> {
  const text = readFileSync(join(vectorsDir('d21'), 'wire-vectors.txt'), 'utf8');
  const vectors = new Map<string, Vector>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const [name, kind, , hex] = trimmed.split(/\s+/);
    vectors.set(name!, { name: name!, kind: kind as Vector['kind'], bytes: hexToBytes(hex!) });
  }
  return vectors;
}

const VECTORS = loadD21();
const codec21 = createControlCodec(21);
const vector = (name: string): Uint8Array => {
  const v = VECTORS.get(name);
  if (v === undefined) throw new Error(`no draft-21 vector ${name}`);
  return v.bytes;
};
const decode = <T extends ControlMessage>(name: string): T => codec21.decode(vector(name), 0).message as T;
const LOCATION_FILTER = 0x21n;
const FILL_PARAMETERS = 0x23n;
const INCLUDE_PROPERTIES = 0x35n;
const LARGEST_OBJECT = 0x09n;
const FORWARD = 0x10n;

describe('draft-21 wire vectors (shared with red5-moq-relay and moqxr)', () => {
  it('loads the full set', () => {
    expect(VECTORS.size).toBeGreaterThanOrEqual(29);
  });

  for (const v of VECTORS.values()) {
    if (v.kind !== 'control') continue;
    it(`${v.name} decodes and re-encodes byte for byte`, () => {
      const { message, bytesRead } = codec21.decode(v.bytes, 0);
      expect(bytesRead).toBe(v.bytes.length);
      expect(bytesToHex(codec21.encode(message))).toBe(bytesToHex(v.bytes));
    });
  }

  it('SUBSCRIBE LOCATION_FILTER forms', () => {
    const filter = (name: string) =>
      decodeLocationFilterFields(decode<Subscribe>(name).parameters.get(LOCATION_FILTER)![0] as Uint8Array);
    expect(filter('subscribe_location_filter_empty')).toEqual([]);
    expect(filter('subscribe_location_filter_next_group')).toEqual([0n]);
    expect(filter('subscribe_location_filter_next_object')).toEqual([0n, 0n]);
    expect(filter('subscribe_location_filter_relative_3')).toEqual([3n]);
    expect(filter('subscribe_location_filter_start_12_5')).toEqual([12n, 5n]);
    expect(filter('subscribe_location_filter_range_12_5_delta_3')).toEqual([12n, 5n, 3n]);
    expect(filter('subscribe_location_filter_range_12_5_delta_3_end_object_7')).toEqual([12n, 5n, 3n, 7n]);
  });

  it('SUBSCRIBE that joins the current group with a fill (the catalog recipe)', () => {
    const sub = decode<Subscribe>('subscribe_join_current_group_with_fill_include_properties_0');
    expect(decodeLocationFilterFields(sub.parameters.get(LOCATION_FILTER)![0] as Uint8Array)).toEqual([0n, 0n]);
    // FILL_PARAMETERS: a bare parameter sequence holding LOCATION_FILTER [1] (the current group).
    expect(bytesToHex(sub.parameters.get(FILL_PARAMETERS)![0] as Uint8Array)).toBe('210101');
    expect(sub.parameters.get(INCLUDE_PROPERTIES)).toEqual([0n]);
  });

  it('SUBSCRIBE_OK carries LARGEST_OBJECT when content exists', () => {
    expect(decode<SubscribeOk>('subscribe_ok_no_largest').parameters.has(LARGEST_OBJECT)).toBe(false);
    expect(decode<SubscribeOk>('subscribe_ok_largest_3_7').parameters.get(LARGEST_OBJECT)).toEqual([{ group: 3n, object: 7n }]);
  });

  it('FETCH carries its range as a LOCATION_FILTER with an inclusive End Object', () => {
    const fetch = decode<Fetch>('fetch_range_12_5_to_15_9');
    expect(fetch.fetch).toMatchObject({
      fetchType: 0x1,
      startLocation: { group: 12n, object: 5n },
      // the draft-18 model's End Object is exclusive (9 inclusive becomes 10)
      endLocation: { group: 15n, object: 10n },
    });
  });

  it('FETCH_OK End Location', () => {
    expect(decode<FetchOk>('fetch_ok_inclusive_end_15_9').endLocation).toEqual({ group: 15n, object: 9n });
  });

  it('GOAWAY has no Request ID', () => {
    const goaway = decode<Goaway>('goaway_no_uri_timeout_5000');
    expect(goaway).toMatchObject({ newSessionUri: '', timeout: 5000n });
    expect(goaway.requestId).toBeUndefined();
  });

  it('PUBLISH_STATE_NOTIFY reports LARGEST_OBJECT and FORWARD', () => {
    const notify = decode<PublishStateNotify>('publish_state_notify_largest_3_7_forward_0');
    expect(notify.type).toBe('PUBLISH_STATE_NOTIFY');
    expect(notify.parameters.get(LARGEST_OBJECT)).toEqual([{ group: 3n, object: 7n }]);
    expect(notify.parameters.get(FORWARD)).toEqual([0n]);
  });

  it('PUBLISH_DONE with an unknown Stream Count (2^64-1)', () => {
    const done = decode<PublishDone>('publish_done_track_ended_unknown_count');
    expect(done.streamCount).toBe((1n << 64n) - 1n);
  });

  it('range-filter parameters are known to the draft-21 registry', () => {
    for (const v of VECTORS.values()) {
      if (v.kind !== 'parameter') continue;
      const counted = new Uint8Array(v.bytes.length + 1);
      counted[0] = 1;
      counted.set(v.bytes, 1);
      const { bytesRead } = decodeMessageParams18(counted, 0, DRAFT21_MESSAGE_PARAM_REGISTRY);
      expect(bytesRead, v.name).toBe(counted.length);
    }
  });
});
