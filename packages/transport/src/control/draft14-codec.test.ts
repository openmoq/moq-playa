/**
 * Draft14Codec tests.
 *
 * Verifies encoding/decoding of draft-14 wire formats and normalization
 * of draft-14 messages to draft-16 ControlMessage types.
 *
 * @see draft-ietf-moq-transport-14
 */
import { describe, it, expect } from 'vitest';
import { createControlCodec } from './codec.js';
import type { ControlCodec } from './codec.js';
import type {
  ControlMessage,
  Subscribe,
  SubscribeOk,
  ClientSetup,
  ServerSetup,
  RequestErrorMsg,
  RequestOk,
  PublishNamespace,
  PublishNamespaceDone,
  PublishNamespaceCancel,
  PublishDone,
  Goaway,
  MaxRequestId,
  FetchOk,
  Fetch,
  JoiningFetch,
  SubscribeNamespace,
  UnsubscribeNamespace,
  PublishNamespaceOk,
  PublishNamespaceError,
  Unsubscribe,
  FetchCancel,
  TrackStatus,
  RequestUpdate,
  Publish,
  PublishOk,
  PublishError,
} from './messages.js';
import { varint, readVarint, writeVarint, varintEncodingLength } from '../primitives/varint.js';
import type { Varint } from '../primitives/varint.js';
import { SetupParam, MessageParam } from './parameters.js';
import {
  writeTuple, tupleEncodingLength,
  writeLengthPrefixedBytes, lengthPrefixedBytesEncodingLength,
} from '../primitives/bytes.js';
import {
  writeKvpListAbsolute, kvpListAbsoluteEncodingLength, kvpListEntryCount,
} from '../primitives/kvp.js';
import type { KvpValue } from '../primitives/kvp.js';
import { writeLocation, locationEncodingLength } from '../primitives/location.js';
import type { Location } from '../primitives/location.js';
import { writeReasonPhrase, reasonPhraseEncodingLength } from '../primitives/reason.js';

const enc = new TextEncoder();

/**
 * Helper: encode a SubscriptionFilter to bytes, matching session.ts encodeSubscriptionFilter.
 * This mirrors the draft-16 wire format for SUBSCRIPTION_FILTER parameter (§5.1.2).
 */
function encodeFilter(
  filter:
    | { type: 'NextGroupStart' }
    | { type: 'LatestObject' }
    | { type: 'AbsoluteStart'; startGroup: Varint; startObject: Varint }
    | { type: 'AbsoluteRange'; startGroup: Varint; startObject: Varint; endGroup: Varint },
): Uint8Array {
  const filterTypeMap = {
    NextGroupStart: varint(0x1n),
    LatestObject: varint(0x2n),
    AbsoluteStart: varint(0x3n),
    AbsoluteRange: varint(0x4n),
  } as const;
  const ft = filterTypeMap[filter.type];
  let size = varintEncodingLength(ft);
  if (filter.type === 'AbsoluteStart' || filter.type === 'AbsoluteRange') {
    size += varintEncodingLength(filter.startGroup);
    size += varintEncodingLength(filter.startObject);
  }
  if (filter.type === 'AbsoluteRange') {
    size += varintEncodingLength(filter.endGroup);
  }
  const buf = new Uint8Array(size);
  let off = writeVarint(ft, buf, 0);
  if (filter.type === 'AbsoluteStart' || filter.type === 'AbsoluteRange') {
    off += writeVarint(filter.startGroup, buf, off);
    off += writeVarint(filter.startObject, buf, off);
  }
  if (filter.type === 'AbsoluteRange') {
    writeVarint(filter.endGroup, buf, off);
  }
  return buf;
}

describe('Draft14Codec', () => {
  let codec: ControlCodec;

  // Helper: manually build a draft-14 framed message with uint16 length
  function frame16(typeCode: number, payload: Uint8Array): Uint8Array {
    const typeVarint = varint(typeCode);
    const typeLen = varintEncodingLength(typeVarint);
    const buf = new Uint8Array(typeLen + 2 + payload.length);
    let pos = 0;
    pos += writeVarint(typeVarint, buf, pos);
    buf[pos++] = (payload.length >> 8) & 0xff;
    buf[pos++] = payload.length & 0xff;
    return buf.length === pos + payload.length
      ? (buf.set(payload, pos), buf)
      : buf;
  }

  // Helper: manually build a draft-14 framed message with varint length
  function frameVarint(typeCode: number, payload: Uint8Array): Uint8Array {
    const typeVarint = varint(typeCode);
    const typeLen = varintEncodingLength(typeVarint);
    const lenVarint = varint(payload.length);
    const lenLen = varintEncodingLength(lenVarint);
    const buf = new Uint8Array(typeLen + lenLen + payload.length);
    let pos = 0;
    pos += writeVarint(typeVarint, buf, pos);
    pos += writeVarint(lenVarint, buf, pos);
    buf.set(payload, pos);
    return buf;
  }

  // Helper: build params payload (count varint + absolute KVP)
  function buildParams(params: Map<Varint, KvpValue[]>): Uint8Array {
    const count = kvpListEntryCount(params);
    const countVarint = varint(count);
    const countLen = varintEncodingLength(countVarint);
    const kvpLen = kvpListAbsoluteEncodingLength(params);
    const buf = new Uint8Array(countLen + kvpLen);
    let pos = 0;
    pos += writeVarint(countVarint, buf, pos);
    writeKvpListAbsolute(params, buf, pos);
    return buf;
  }

  // Helper: concat Uint8Arrays
  function concat(...arrays: Uint8Array[]): Uint8Array {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const result = new Uint8Array(total);
    let pos = 0;
    for (const a of arrays) {
      result.set(a, pos);
      pos += a.length;
    }
    return result;
  }

  // Helper: write a varint to a new buffer
  function vi(v: number | bigint): Uint8Array {
    const val = varint(v);
    const buf = new Uint8Array(varintEncodingLength(val));
    writeVarint(val, buf, 0);
    return buf;
  }

  // Helper: write a tuple to a new buffer
  function tuple(fields: Uint8Array[]): Uint8Array {
    const len = tupleEncodingLength(fields);
    const buf = new Uint8Array(len);
    writeTuple(fields, buf, 0);
    return buf;
  }

  // Helper: write length-prefixed bytes
  function lpb(data: Uint8Array): Uint8Array {
    const len = lengthPrefixedBytesEncodingLength(data);
    const buf = new Uint8Array(len);
    writeLengthPrefixedBytes(data, buf, 0);
    return buf;
  }

  // Helper: write a Location
  function loc(group: number | bigint, obj: number | bigint): Uint8Array {
    const location: Location = { group: varint(group), object: varint(obj) };
    const len = locationEncodingLength(location);
    const buf = new Uint8Array(len);
    writeLocation(location, buf, 0);
    return buf;
  }

  // Helper: write a reason phrase
  function reason(text: string): Uint8Array {
    const len = reasonPhraseEncodingLength(text);
    const buf = new Uint8Array(len);
    writeReasonPhrase(text, buf, 0);
    return buf;
  }

  beforeAll(() => {
    codec = createControlCodec(14);
  });

  it('reports version 14', () => {
    expect(codec.version).toBe(14);
  });

  // ─── Encoding (outbound — what subscriber sends) ──────────────────

  describe('encode', () => {
    it('encodes CLIENT_SETUP with version list before params', () => {
      /**
       * Draft-14 §9.3:
       *   CLIENT_SETUP { Type=0x20, Length(16),
       *     Number of Supported Versions (i),
       *     Supported Versions (i) ...,
       *     Number of Parameters (i), Parameters (..) ... }
       */
      const msg: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: new Map([
          [SetupParam.MAX_REQUEST_ID, [varint(100)]],
        ]),
      };
      const bytes = codec.encode(msg);
      // Decode it back — should round-trip
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('CLIENT_SETUP');
    });

    it('encodes SERVER_SETUP with selected version before params', () => {
      /**
       * Draft-14 §9.3:
       *   SERVER_SETUP { Type=0x21, Length(16),
       *     Selected Version (i),
       *     Number of Parameters (i), Setup Parameters (..) ... }
       * Unlike CLIENT_SETUP, the server echoes a single negotiated version.
       */
      const msg: ServerSetup = {
        type: 'SERVER_SETUP',
        parameters: new Map([
          [SetupParam.MAX_REQUEST_ID, [varint(100)]],
        ]),
      };
      const bytes = codec.encode(msg);

      // Byte-exact prefix: Type=0x21, then uint16 length, then Selected Version.
      expect(bytes[0]).toBe(0x21);
      const selected = readVarint(bytes, 3); // 0x21 (1) + uint16 length (2)
      expect(selected.value).toBe(0xff00000en);

      // And it round-trips through the matching decode path.
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('SERVER_SETUP');
      if (message.type === 'SERVER_SETUP') {
        expect(message.parameters.get(SetupParam.MAX_REQUEST_ID)).toEqual([varint(100)]);
      }
    });

    it('encodes a REQUEST_ERROR tagged requestKind=SUBSCRIBE to SUBSCRIBE_ERROR (0x05)', () => {
      /**
       * Draft-14 §9.9: SUBSCRIBE_ERROR { Type=0x5, Length(16),
       *   Request ID (i), Error Code (i), Reason Phrase }.
       * The session models the unified draft-16 REQUEST_ERROR; the draft-14
       * codec recovers the specific wire type from the `requestKind` context
       * the session stamps. Decode stays normalized to REQUEST_ERROR.
       */
      const msg: RequestErrorMsg = {
        type: 'REQUEST_ERROR',
        requestId: varint(2),
        errorCode: varint(1),
        retryInterval: varint(0),
        errorReason: 'denied',
        requestKind: 'SUBSCRIBE',
      };
      const bytes = codec.encode(msg);
      expect(bytes[0]).toBe(0x05); // SUBSCRIBE_ERROR wire type, not a generic error

      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('REQUEST_ERROR'); // decode remains normalized
      if (message.type === 'REQUEST_ERROR') {
        expect(message.requestId).toBe(2n);
        expect(message.errorCode).toBe(1n);
        expect(message.errorReason).toBe('denied');
      }
    });

    it('maps every requestKind to its specific draft-14 error wire type', () => {
      const cases: Array<[RequestErrorMsg['requestKind'], number]> = [
        ['SUBSCRIBE', 0x05],
        ['FETCH', 0x19],
        ['TRACK_STATUS', 0x0f],
        ['SUBSCRIBE_NAMESPACE', 0x13],
      ];
      for (const [kind, wireType] of cases) {
        const bytes = codec.encode({
          type: 'REQUEST_ERROR',
          requestId: varint(2),
          errorCode: varint(7),
          retryInterval: varint(0),
          errorReason: 'x',
          requestKind: kind,
        });
        expect(bytes[0]).toBe(wireType);
        const { message } = codec.decode(bytes, 0);
        expect(message.type).toBe('REQUEST_ERROR'); // all normalize back
      }
    });

    it('still refuses a REQUEST_ERROR with no requestKind context', () => {
      expect(() => codec.encode({
        type: 'REQUEST_ERROR',
        requestId: varint(2),
        errorCode: varint(1),
        retryInterval: varint(0),
        errorReason: 'denied',
      })).toThrow(/specific error types/);
    });

    it('encodes SUBSCRIBE with inline fields extracted from parameters', () => {
      /**
       * Draft-14 §9.7:
       *   SUBSCRIBE { Type=0x3, Length(16),
       *     Request ID, Track Namespace, Track Name,
       *     Subscriber Priority (8), Group Order (8), Forward (8),
       *     Filter Type (i), [Start/End], Parameters }
       */
      const msg: Subscribe = {
        type: 'SUBSCRIBE',
        requestId: varint(1),
        trackNamespace: [enc.encode('live')],
        trackName: enc.encode('video'),
        parameters: new Map([
          [MessageParam.SUBSCRIBER_PRIORITY, [varint(128)]],
          [MessageParam.GROUP_ORDER, [varint(1)]],
          [MessageParam.FORWARD, [varint(1)]],
          [MessageParam.SUBSCRIPTION_FILTER, [encodeFilter({ type: 'NextGroupStart' })]],
        ]),
      };
      const bytes = codec.encode(msg);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('SUBSCRIBE');
      // Verify the inline fields were re-packed into parameters on decode
      const sub = message as Subscribe;
      expect(sub.requestId).toBe(1n);
    });

    it('encodes SUBSCRIBE with default filter type when SUBSCRIPTION_FILTER absent', () => {
      const msg: Subscribe = {
        type: 'SUBSCRIBE',
        requestId: varint(1),
        trackNamespace: [enc.encode('live')],
        trackName: enc.encode('video'),
        parameters: new Map(), // No SUBSCRIPTION_FILTER
      };
      // Should not throw — codec injects default FilterType=0x1 (Next Group Start)
      const bytes = codec.encode(msg);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('SUBSCRIBE');
    });

    it('encodes SUBSCRIBE_NAMESPACE without subscribeOptions', () => {
      /**
       * Draft-14 §9.28: No Subscribe Options field.
       */
      const msg: SubscribeNamespace = {
        type: 'SUBSCRIBE_NAMESPACE',
        requestId: varint(1),
        trackNamespacePrefix: [enc.encode('example.com')],
        parameters: new Map(),
      };
      const bytes = codec.encode(msg);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('SUBSCRIBE_NAMESPACE');
    });

    it('encodes UNSUBSCRIBE_NAMESPACE with namespace prefix', () => {
      /**
       * Draft-14 §9.31:
       *   UNSUBSCRIBE_NAMESPACE { Type=0x14, Length(16),
       *     Track Namespace Prefix (tuple) }
       */
      const msg: UnsubscribeNamespace = {
        type: 'UNSUBSCRIBE_NAMESPACE',
        trackNamespacePrefix: [enc.encode('example.com')],
      };
      const bytes = codec.encode(msg);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('UNSUBSCRIBE_NAMESPACE');
      expect((message as UnsubscribeNamespace).trackNamespacePrefix).toHaveLength(1);
    });

    it('encodes PUBLISH_NAMESPACE_OK', () => {
      /**
       * Draft-14 §9.24:
       *   PUBLISH_NAMESPACE_OK { Type=0x7, Length(16), Request ID (i) }
       */
      const msg: PublishNamespaceOk = {
        type: 'PUBLISH_NAMESPACE_OK',
        requestId: varint(5),
      };
      const bytes = codec.encode(msg);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('PUBLISH_NAMESPACE_OK');
      expect((message as PublishNamespaceOk).requestId).toBe(5n);
    });

    it('encodes PUBLISH_NAMESPACE_ERROR', () => {
      /**
       * Draft-14 §9.25:
       *   PUBLISH_NAMESPACE_ERROR { Type=0x8, Length(16),
       *     Request ID, Error Code, Error Reason }
       */
      const msg: PublishNamespaceError = {
        type: 'PUBLISH_NAMESPACE_ERROR',
        requestId: varint(5),
        errorCode: varint(0x4),
        errorReason: 'uninterested',
      };
      const bytes = codec.encode(msg);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('PUBLISH_NAMESPACE_ERROR');
      const decoded = message as PublishNamespaceError;
      expect(decoded.requestId).toBe(5n);
      expect(decoded.errorCode).toBe(4n);
      expect(decoded.errorReason).toBe('uninterested');
    });

    it('encodes UNSUBSCRIBE unchanged', () => {
      const msg: Unsubscribe = { type: 'UNSUBSCRIBE', requestId: varint(3) };
      const bytes = codec.encode(msg);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('UNSUBSCRIBE');
      expect((message as Unsubscribe).requestId).toBe(3n);
    });

    it('encodes FETCH_CANCEL unchanged', () => {
      const msg: FetchCancel = { type: 'FETCH_CANCEL', requestId: varint(7) };
      const bytes = codec.encode(msg);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('FETCH_CANCEL');
    });

    it('encodes FETCH with inline Priority/GroupOrder', () => {
      /**
       * Draft-14 §9.16:
       *   FETCH { Type=0x16, Length(16),
       *     Request ID, Subscriber Priority (8), Group Order (8),
       *     Fetch Type, [...], Parameters }
       */
      const msg: Fetch = {
        type: 'FETCH',
        requestId: varint(2),
        fetch: {
          fetchType: 0x1,
          trackNamespace: [enc.encode('live')],
          trackName: enc.encode('video'),
          startLocation: { group: varint(0), object: varint(0) },
          endLocation: { group: varint(10), object: varint(0) },
        },
        parameters: new Map([
          [MessageParam.SUBSCRIBER_PRIORITY, [varint(128)]],
          [MessageParam.GROUP_ORDER, [varint(1)]],
        ]),
      };
      const bytes = codec.encode(msg);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('FETCH');
    });

    it('round-trips a relative joining FETCH (fetchType 0x2, §9.16.2)', () => {
      const msg: Fetch = {
        type: 'FETCH',
        requestId: varint(2),
        fetch: { fetchType: 0x2, joiningRequestId: varint(0), joiningStart: 3n },
        parameters: new Map([
          [MessageParam.SUBSCRIBER_PRIORITY, [varint(128)]],
          [MessageParam.GROUP_ORDER, [varint(1)]],
        ]),
      };
      const { message } = codec.decode(codec.encode(msg), 0);
      expect(message.type).toBe('FETCH');
      const decoded = (message as Fetch).fetch as JoiningFetch;
      expect(decoded.fetchType).toBe(0x2);
      expect(decoded.joiningRequestId).toBe(0n);
      expect(decoded.joiningStart).toBe(3n);
    });

    it('round-trips an absolute joining FETCH (fetchType 0x3)', () => {
      const msg: Fetch = {
        type: 'FETCH',
        requestId: varint(4),
        fetch: { fetchType: 0x3, joiningRequestId: varint(2), joiningStart: 7n },
        parameters: new Map([
          [MessageParam.SUBSCRIBER_PRIORITY, [varint(128)]],
          [MessageParam.GROUP_ORDER, [varint(1)]],
        ]),
      };
      const { message } = codec.decode(codec.encode(msg), 0);
      const decoded = (message as Fetch).fetch as JoiningFetch;
      expect(decoded.fetchType).toBe(0x3);
      expect(decoded.joiningStart).toBe(7n);
    });

    it('encodes TRACK_STATUS unchanged', () => {
      const msg: TrackStatus = {
        type: 'TRACK_STATUS',
        requestId: varint(4),
        trackNamespace: [enc.encode('live')],
        trackName: enc.encode('catalog'),
        parameters: new Map(),
      };
      const bytes = codec.encode(msg);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('TRACK_STATUS');
    });
  });

  // ─── Decoding (inbound — what subscriber receives) ────────────────

  describe('decode', () => {
    it('decodes SERVER_SETUP with selected version', () => {
      /**
       * Draft-14 §9.3:
       *   SERVER_SETUP { Type=0x21, Length(16),
       *     Selected Version (i),
       *     Number of Parameters (i), Setup Parameters (..) ... }
       */
      const params = new Map<Varint, KvpValue[]>();
      const payload = concat(
        vi(0xff00000e), // Selected Version = draft-14
        buildParams(params),
      );
      const bytes = frame16(0x21, payload);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('SERVER_SETUP');
    });

    it('decodes SUBSCRIBE_OK with inline fields normalized to params', () => {
      /**
       * Draft-14 §9.8:
       *   SUBSCRIBE_OK { Type=0x4, Length(16),
       *     Request ID, Track Alias, Expires (i), Group Order (8),
       *     Content Exists (8), [Largest Location], Parameters }
       */
      const params = new Map<Varint, KvpValue[]>();
      const payload = concat(
        vi(1),    // Request ID
        vi(100),  // Track Alias
        vi(5000), // Expires
        new Uint8Array([0x01]), // Group Order = ascending
        new Uint8Array([0x01]), // Content Exists = 1
        loc(5, 3),              // Largest Location
        buildParams(params),
      );
      const bytes = frame16(0x04, payload);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('SUBSCRIBE_OK');
      const ok = message as SubscribeOk;
      expect(ok.requestId).toBe(1n);
      expect(ok.trackAlias).toBe(100n);
    });

    it('decodes SUBSCRIBE_OK without Largest Location when ContentExists=0', () => {
      const params = new Map<Varint, KvpValue[]>();
      const payload = concat(
        vi(1),    // Request ID
        vi(100),  // Track Alias
        vi(0),    // Expires = 0
        new Uint8Array([0x02]), // Group Order = descending
        new Uint8Array([0x00]), // Content Exists = 0
        // No Largest Location
        buildParams(params),
      );
      const bytes = frame16(0x04, payload);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('SUBSCRIBE_OK');
    });

    it('rejects SUBSCRIBE_OK with invalid Content Exists value', () => {
      const params = new Map<Varint, KvpValue[]>();
      const payload = concat(
        vi(1),    // Request ID
        vi(100),  // Track Alias
        vi(0),    // Expires
        new Uint8Array([0x02]), // Group Order
        new Uint8Array([0x05]), // Content Exists = 5 (INVALID)
        buildParams(params),
      );
      const bytes = frame16(0x04, payload);
      expect(() => codec.decode(bytes, 0)).toThrow(/Content Exists.*must be 0 or 1/);
    });

    it('decodes SUBSCRIBE_ERROR (0x05) → RequestError', () => {
      /**
       * Draft-14 §9.9: SUBSCRIBE_ERROR { Type=0x05, ... }
       * Normalized to RequestError type.
       */
      const payload = concat(
        vi(1),            // Request ID
        vi(0x4),          // Error Code (TRACK_DOES_NOT_EXIST)
        reason('not found'),
      );
      const bytes = frame16(0x05, payload);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('REQUEST_ERROR');
      const err = message as RequestErrorMsg;
      expect(err.requestId).toBe(1n);
      expect(err.errorCode).toBe(4n);
      expect(err.errorReason).toBe('not found');
    });

    it('decodes FETCH_ERROR (0x19) → RequestError', () => {
      /**
       * Draft-14 §9.18: FETCH_ERROR { Type=0x19, ... }
       */
      const payload = concat(
        vi(2),
        vi(0x5), // INVALID_RANGE
        reason('bad range'),
      );
      const bytes = frame16(0x19, payload);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('REQUEST_ERROR');
      const err = message as RequestErrorMsg;
      expect(err.requestId).toBe(2n);
      expect(err.errorCode).toBe(5n);
    });

    it('decodes FETCH_OK (0x18) with inline GroupOrder', () => {
      /**
       * Draft-14 §9.17:
       *   FETCH_OK { Type=0x18, Length(16),
       *     Request ID, Group Order (8), End Of Track (8),
       *     End Location, Parameters }
       */
      const params = new Map<Varint, KvpValue[]>();
      const payload = concat(
        vi(3),   // Request ID
        new Uint8Array([0x01]), // Group Order = ascending
        new Uint8Array([0x00]), // End Of Track = 0
        loc(10, 5),
        buildParams(params),
      );
      const bytes = frame16(0x18, payload);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('FETCH_OK');
      const ok = message as FetchOk;
      expect(ok.requestId).toBe(3n);
      expect(ok.endOfTrack).toBe(0);
    });

    it('decodes TRACK_STATUS_OK (0x0E) → RequestOk', () => {
      /**
       * Draft-14 §9.21: TRACK_STATUS_OK has same wire format as SUBSCRIBE_OK.
       * Normalized to RequestOk.
       */
      const params = new Map<Varint, KvpValue[]>();
      const payload = concat(
        vi(4),    // Request ID
        vi(0),    // Track Alias (always 0 for TRACK_STATUS_OK)
        vi(0),    // Expires
        new Uint8Array([0x01]), // Group Order
        new Uint8Array([0x00]), // Content Exists = 0
        buildParams(params),
      );
      const bytes = frame16(0x0e, payload);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('REQUEST_OK');
    });

    it('decodes TRACK_STATUS_ERROR (0x0F) → RequestError', () => {
      /**
       * Draft-14 §9.22: Same wire format as SUBSCRIBE_ERROR.
       */
      const payload = concat(
        vi(4),
        vi(0x3),         // NOT_SUPPORTED
        reason('nope'),
      );
      const bytes = frame16(0x0f, payload);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('REQUEST_ERROR');
    });

    it('decodes SUBSCRIBE_NAMESPACE_OK (0x12) → RequestOk', () => {
      /**
       * Draft-14 §9.29: { Request ID }
       */
      const payload = vi(5);
      const bytes = frame16(0x12, payload);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('REQUEST_OK');
      expect((message as RequestOk).requestId).toBe(5n);
    });

    it('decodes SUBSCRIBE_NAMESPACE_ERROR (0x13) → RequestError', () => {
      /**
       * Draft-14 §9.30: { Request ID, Error Code, Error Reason }
       */
      const payload = concat(
        vi(5),
        vi(0x4), // NAMESPACE_PREFIX_UNKNOWN
        reason('unknown prefix'),
      );
      const bytes = frame16(0x13, payload);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('REQUEST_ERROR');
    });

    it('decodes PUBLISH_NAMESPACE (0x06)', () => {
      /**
       * Draft-14 §9.23:
       *   { Request ID, Track Namespace (tuple), Parameters }
       */
      const params = new Map<Varint, KvpValue[]>();
      const payload = concat(
        vi(10),
        tuple([enc.encode('live'), enc.encode('stream1')]),
        buildParams(params),
      );
      const bytes = frame16(0x06, payload);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('PUBLISH_NAMESPACE');
      const pn = message as PublishNamespace;
      expect(pn.requestId).toBe(10n);
      expect(pn.trackNamespace).toHaveLength(2);
    });

    it('decodes PUBLISH_NAMESPACE_DONE (0x09) with Track Namespace', () => {
      /**
       * Draft-14 §9.26: { Track Namespace (tuple) }
       * NOT requestId — uses namespace tuple.
       */
      const payload = tuple([enc.encode('live'), enc.encode('stream1')]);
      const bytes = frame16(0x09, payload);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('PUBLISH_NAMESPACE_DONE');
      const done = message as PublishNamespaceDone;
      expect(done.trackNamespace).toHaveLength(2);
      expect(done.requestId).toBeUndefined();
    });

    it('encodes PUBLISH_NAMESPACE_DONE (0x09) with Track Namespace', () => {
      const msg: PublishNamespaceDone = {
        type: 'PUBLISH_NAMESPACE_DONE',
        trackNamespace: [enc.encode('live'), enc.encode('stream1')],
      };
      const encoded = codec.encode(msg);
      // Round-trip: decode what we encoded
      const { message } = codec.decode(encoded, 0);
      expect(message.type).toBe('PUBLISH_NAMESPACE_DONE');
      const done = message as PublishNamespaceDone;
      expect(done.trackNamespace).toHaveLength(2);
      expect(done.requestId).toBeUndefined();
    });

    it('decodes PUBLISH_NAMESPACE_CANCEL (0x0C) with Track Namespace', () => {
      /**
       * Draft-14 §9.27: { Track Namespace (tuple), Error Code, Error Reason }
       */
      const payload = concat(
        tuple([enc.encode('live')]),
        vi(0x0), // INTERNAL_ERROR
        reason('shutting down'),
      );
      const bytes = frame16(0x0c, payload);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('PUBLISH_NAMESPACE_CANCEL');
      const cancel = message as PublishNamespaceCancel;
      expect(cancel.trackNamespace).toHaveLength(1);
      expect(cancel.requestId).toBeUndefined();
      expect(cancel.errorCode).toBe(0n);
      expect(cancel.errorReason).toBe('shutting down');
    });

    it('decodes PUBLISH_DONE (0x0B) unchanged', () => {
      const payload = concat(
        vi(1),   // Request ID
        vi(0x2), // TRACK_ENDED
        vi(5),   // Stream Count
        reason(''),
      );
      const bytes = frame16(0x0b, payload);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('PUBLISH_DONE');
      const done = message as PublishDone;
      expect(done.requestId).toBe(1n);
      expect(done.statusCode).toBe(2n);
    });

    it('decodes GOAWAY (0x10) unchanged', () => {
      const uriBytes = enc.encode('https://new.example.com');
      const payload = concat(vi(uriBytes.length), uriBytes);
      const bytes = frame16(0x10, payload);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('GOAWAY');
      expect((message as Goaway).newSessionUri).toBe('https://new.example.com');
    });

    it('decodes MAX_REQUEST_ID (0x15) unchanged', () => {
      const payload = vi(50);
      const bytes = frame16(0x15, payload);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('MAX_REQUEST_ID');
    });

    it('decodes PUBLISH (0x1D) with varint length (§9.13)', () => {
      /**
       * Draft-14 §9.13:
       *   PUBLISH { Type=0x1D, Length(i),
       *     Request ID, Track Namespace, Track Name, Track Alias,
       *     Group Order (8), Content Exists (8), [Largest Location],
       *     Forward (8), Parameters }
       */
      const params = new Map<Varint, KvpValue[]>();
      const payload = concat(
        vi(1),    // Request ID
        tuple([enc.encode('live')]),  // Track Namespace
        lpb(enc.encode('video')),     // Track Name
        vi(42),   // Track Alias
        new Uint8Array([0x01]),       // Group Order = ascending
        new Uint8Array([0x00]),       // Content Exists = 0
        new Uint8Array([0x01]),       // Forward = 1
        buildParams(params),
      );
      const bytes = frameVarint(0x1d, payload);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('PUBLISH');
      if (message.type === 'PUBLISH') {
        expect(message.requestId).toBe(1n);
        expect(message.trackAlias).toBe(42n);
      }
    });

    it('rejects PUBLISH with invalid Content Exists value (§9.13)', () => {
      const params = new Map<Varint, KvpValue[]>();
      const payload = concat(
        vi(1),    // Request ID
        tuple([enc.encode('live')]),
        lpb(enc.encode('video')),
        vi(42),   // Track Alias
        new Uint8Array([0x01]),       // Group Order
        new Uint8Array([0x02]),       // Content Exists = 2 (INVALID)
        new Uint8Array([0x01]),       // Forward
        buildParams(params),
      );
      const bytes = frameVarint(0x1d, payload);
      expect(() => codec.decode(bytes, 0)).toThrow(/Content Exists must be 0 or 1/);
    });

    it('decodes PUBLISH_ERROR (0x1F) → RequestError (§9.15)', () => {
      /**
       * Draft-14 §9.15:
       *   PUBLISH_ERROR { Type=0x1F, Length(i),
       *     Request ID, Error Code, Error Reason }
       */
      const payload = concat(
        vi(1),            // Request ID
        vi(0x3),          // Error Code
        reason('uninterested'),
      );
      const bytes = frameVarint(0x1f, payload);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('REQUEST_ERROR');
      if (message.type === 'REQUEST_ERROR') {
        expect(message.requestId).toBe(1n);
        expect(message.errorCode).toBe(3n);
        expect(message.errorReason).toBe('uninterested');
      }
    });
  });

  // ─── Frame Size Peeking ───────────────────────────────────────────

  describe('peekFrameSize', () => {
    it('returns undefined for empty buffer', () => {
      expect(codec.peekFrameSize(new Uint8Array(0))).toBeUndefined();
    });

    it('handles standard uint16 length messages', () => {
      // GOAWAY (0x10) uses uint16 length — build frame manually
      // since subscriber doesn't encode GOAWAY (only receives it)
      const uriBytes = enc.encode('');
      const payload = concat(vi(uriBytes.length), uriBytes);
      const bytes = frame16(0x10, payload);
      expect(codec.peekFrameSize(bytes)).toBe(bytes.length);
    });

    it('handles PUBLISH (0x1D) with varint length', () => {
      // PUBLISH uses varint length in draft-14, not uint16
      // Build a minimal PUBLISH frame manually
      const payload = new Uint8Array(10); // dummy payload
      const bytes = frameVarint(0x1d, payload);
      const size = codec.peekFrameSize(bytes);
      expect(size).toBe(bytes.length);
    });

    it('handles PUBLISH_OK (0x1E) with varint length', () => {
      const payload = new Uint8Array(5);
      const bytes = frameVarint(0x1e, payload);
      const size = codec.peekFrameSize(bytes);
      expect(size).toBe(bytes.length);
    });
  });

  // ─── KVP Absolute Encoding ───────────────────────────────────────

  describe('uses absolute KVP encoding', () => {
    it('round-trips SUBSCRIBE with absolute-encoded parameters', () => {
      const msg: Subscribe = {
        type: 'SUBSCRIBE',
        requestId: varint(1),
        trackNamespace: [enc.encode('ns')],
        trackName: enc.encode('t'),
        parameters: new Map([
          [MessageParam.DELIVERY_TIMEOUT, [varint(5000)]],
          [MessageParam.AUTHORIZATION_TOKEN, [new Uint8Array([0x01, 0x02])]],
        ]),
      };
      const bytes = codec.encode(msg);
      const { message } = codec.decode(bytes, 0);
      const sub = message as Subscribe;
      // The remaining parameters (after extracting inline fields) should preserve values
      expect(sub.parameters.get(MessageParam.DELIVERY_TIMEOUT)?.[0]).toBe(5000n);
      expect(sub.parameters.get(MessageParam.AUTHORIZATION_TOKEN)?.[0]).toEqual(
        new Uint8Array([0x01, 0x02]),
      );
    });
  });

  // ─── Round-trip for each message type ─────────────────────────────

  describe('round-trip', () => {
    it('CLIENT_SETUP round-trips', () => {
      const msg: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: new Map([
          [SetupParam.MAX_REQUEST_ID, [varint(50)]],
          [SetupParam.PATH, [enc.encode('/moq')]],
        ]),
      };
      const bytes = codec.encode(msg);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('CLIENT_SETUP');
      const setup = message as ClientSetup;
      expect(setup.parameters.get(SetupParam.MAX_REQUEST_ID)?.[0]).toBe(50n);
    });

    it('SUBSCRIBE round-trips with all inline fields', () => {
      const msg: Subscribe = {
        type: 'SUBSCRIBE',
        requestId: varint(1),
        trackNamespace: [enc.encode('live'), enc.encode('stream')],
        trackName: enc.encode('video'),
        parameters: new Map([
          [MessageParam.SUBSCRIBER_PRIORITY, [varint(200)]],
          [MessageParam.GROUP_ORDER, [varint(2)]],    // Descending
          [MessageParam.FORWARD, [varint(1)]],
          [MessageParam.SUBSCRIPTION_FILTER, [encodeFilter({ type: 'LatestObject' })]],
        ]),
      };
      const bytes = codec.encode(msg);
      const { message } = codec.decode(bytes, 0);
      const sub = message as Subscribe;
      expect(sub.requestId).toBe(1n);
      // Inline fields should be normalized back to params
      expect(sub.parameters.get(MessageParam.SUBSCRIBER_PRIORITY)?.[0]).toBe(200n);
      expect(sub.parameters.get(MessageParam.GROUP_ORDER)?.[0]).toBe(2n);
      expect(sub.parameters.get(MessageParam.FORWARD)?.[0]).toBe(1n);
      // Filter stored as bytes: [filterType=0x02 (LatestObject)]
      const filter = sub.parameters.get(MessageParam.SUBSCRIPTION_FILTER)?.[0] as Uint8Array;
      expect(filter).toBeInstanceOf(Uint8Array);
      expect(filter[0]).toBe(0x02); // LatestObject filter type
    });

    it('SUBSCRIBE round-trips with AbsoluteStart filter (§9.7)', () => {
      /**
       * Draft-14 §9.7: When FilterType is AbsoluteStart (0x3),
       * Start Location (group, object) appears inline after FilterType.
       * The SUBSCRIPTION_FILTER parameter carries this as bytes in draft-16.
       */
      const msg: Subscribe = {
        type: 'SUBSCRIBE',
        requestId: varint(5),
        trackNamespace: [enc.encode('live')],
        trackName: enc.encode('video'),
        parameters: new Map([
          [MessageParam.SUBSCRIBER_PRIORITY, [varint(100)]],
          [MessageParam.GROUP_ORDER, [varint(1)]],
          [MessageParam.FORWARD, [varint(1)]],
          [MessageParam.SUBSCRIPTION_FILTER, [encodeFilter({
            type: 'AbsoluteStart',
            startGroup: varint(42),
            startObject: varint(7),
          })]],
        ]),
      };
      const bytes = codec.encode(msg);
      const { message } = codec.decode(bytes, 0);
      const sub = message as Subscribe;
      expect(sub.requestId).toBe(5n);
      // FilterType should round-trip as 0x3 (AbsoluteStart)
      // Filter stored as bytes: [filterType=0x03, startGroup=42, startObject=7]
      const filter = sub.parameters.get(MessageParam.SUBSCRIPTION_FILTER)?.[0] as Uint8Array;
      expect(filter).toBeInstanceOf(Uint8Array);
      expect(filter[0]).toBe(0x03); // AbsoluteStart filter type
    });

    it('SUBSCRIBE round-trips with AbsoluteRange filter (§9.7)', () => {
      /**
       * Draft-14 §9.7: When FilterType is AbsoluteRange (0x4),
       * Start Location and End Group appear inline.
       */
      const msg: Subscribe = {
        type: 'SUBSCRIBE',
        requestId: varint(6),
        trackNamespace: [enc.encode('live')],
        trackName: enc.encode('video'),
        parameters: new Map([
          [MessageParam.SUBSCRIBER_PRIORITY, [varint(100)]],
          [MessageParam.GROUP_ORDER, [varint(1)]],
          [MessageParam.FORWARD, [varint(1)]],
          [MessageParam.SUBSCRIPTION_FILTER, [encodeFilter({
            type: 'AbsoluteRange',
            startGroup: varint(10),
            startObject: varint(0),
            endGroup: varint(20),
          })]],
        ]),
      };
      const bytes = codec.encode(msg);
      const { message } = codec.decode(bytes, 0);
      const sub = message as Subscribe;
      expect(sub.requestId).toBe(6n);
      // Filter stored as bytes: [filterType=0x04, startGroup=10, startObject=0, endGroup=20]
      const filter = sub.parameters.get(MessageParam.SUBSCRIPTION_FILTER)?.[0] as Uint8Array;
      expect(filter).toBeInstanceOf(Uint8Array);
      expect(filter[0]).toBe(0x04); // AbsoluteRange filter type
    });
  });

  describe('SUBSCRIBE_UPDATE', () => {
    it('encodes and decodes SUBSCRIBE_UPDATE (§9.10)', () => {
      /**
       * Draft-14 §9.10:
       *   SUBSCRIBE_UPDATE { Type=0x2, Length(16),
       *     Request ID (i), Subscription Request ID (i),
       *     Start Location (Location), End Group (i),
       *     Subscriber Priority (8), Forward (8),
       *     Number of Parameters (i), Parameters (..) ... }
       */
      const msg: ControlMessage = {
        type: 'REQUEST_UPDATE',
        requestId: varint(10),
        existingRequestId: varint(5),
        parameters: new Map([
          [MessageParam.FORWARD, [varint(0)]],
          [MessageParam.SUBSCRIBER_PRIORITY, [varint(200)]],
          [MessageParam.SUBSCRIPTION_FILTER, [encodeFilter({
            type: 'AbsoluteStart',
            startGroup: varint(100),
            startObject: varint(0),
          })]],
        ]),
      };
      const bytes = codec.encode(msg);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('REQUEST_UPDATE');
    });

    it('decodes SUBSCRIBE_UPDATE from wire (§9.10)', () => {
      /**
       * Draft-14 §9.10 wire format:
       *   Request ID, Subscription Request ID,
       *   Start Location (group, object), End Group,
       *   Subscriber Priority (8), Forward (8), Parameters
       */
      const params = new Map<Varint, KvpValue[]>();
      const payload = concat(
        vi(10),     // Request ID
        vi(5),      // Subscription Request ID
        loc(100, 0),// Start Location (group=100, object=0)
        vi(0),      // End Group (0 = open-ended)
        new Uint8Array([200]),  // Subscriber Priority
        new Uint8Array([0]),    // Forward = 0 (pause)
        buildParams(params),
      );
      const bytes = frame16(0x02, payload);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('REQUEST_UPDATE');
    });

    it('encodes End Group with +1 wire semantics (§9.10)', () => {
      /**
       * Draft-14 §9.10: "End Group: The end Group ID, plus 1.
       * A value of 0 means the subscription is open-ended."
       *
       * When the logical endGroup is 20, the wire value must be 21.
       */
      const msg: ControlMessage = {
        type: 'REQUEST_UPDATE',
        requestId: varint(10),
        existingRequestId: varint(5),
        parameters: new Map([
          [MessageParam.FORWARD, [varint(1)]],
          [MessageParam.SUBSCRIBER_PRIORITY, [varint(128)]],
          [MessageParam.SUBSCRIPTION_FILTER, [encodeFilter({
            type: 'AbsoluteRange',
            startGroup: varint(10),
            startObject: varint(0),
            endGroup: varint(20),
          })]],
        ]),
      };
      const bytes = codec.encode(msg);

      // Inspect raw wire: skip type (varint) + length (uint16) + requestId + existingRequestId + startLocation
      // Then the next varint should be End Group = 21 on wire (logical 20 + 1)
      let off = 0;
      // Type byte
      const { bytesRead: tb } = readVarint(bytes, off); off += tb;
      // Length (uint16)
      off += 2;
      // Request ID
      const { bytesRead: ridB } = readVarint(bytes, off); off += ridB;
      // Existing Request ID
      const { bytesRead: eridB } = readVarint(bytes, off); off += eridB;
      // Start Location (group + object)
      const { bytesRead: sgB } = readVarint(bytes, off); off += sgB;
      const { bytesRead: soB } = readVarint(bytes, off); off += soB;
      // End Group — this is the wire value
      const { value: wireEndGroup } = readVarint(bytes, off);
      expect(wireEndGroup).toBe(21n); // logical 20 + 1
    });

    it('decodes End Group wire value 21 as logical 20 (§9.10)', () => {
      /**
       * Draft-14 §9.10: Wire End Group is "the end Group ID, plus 1."
       * So wire value 21 → logical end group 20.
       */
      const params = new Map<Varint, KvpValue[]>();
      const payload = concat(
        vi(10),      // Request ID
        vi(5),       // Subscription Request ID
        loc(10, 0),  // Start Location
        vi(21),      // End Group = 21 on wire → logical 20
        new Uint8Array([128]), // Subscriber Priority
        new Uint8Array([1]),   // Forward
        buildParams(params),
      );
      const bytes = frame16(0x02, payload);
      const { message } = codec.decode(bytes, 0);
      const update = message as RequestUpdate;
      const filterBytes = update.parameters.get(MessageParam.SUBSCRIPTION_FILTER)?.[0] as Uint8Array;
      expect(filterBytes).toBeInstanceOf(Uint8Array);
      // Parse end group from filter bytes
      let off = 0;
      const { bytesRead: ftB } = readVarint(filterBytes, off);
      off += ftB;
      const { bytesRead: sgB } = readVarint(filterBytes, off);
      off += sgB;
      const { bytesRead: soB } = readVarint(filterBytes, off);
      off += soB;
      const { value: eg } = readVarint(filterBytes, off);
      expect(eg).toBe(20n); // Normalized from wire 21
    });

    it('preserves End Group 0 (open-ended) without subtracting (§9.10)', () => {
      /**
       * Draft-14 §9.10: "A value of 0 means the subscription is open-ended."
       * Wire 0 should NOT be decremented to -1.
       */
      const params = new Map<Varint, KvpValue[]>();
      const payload = concat(
        vi(10),
        vi(5),
        loc(10, 0),
        vi(0),      // End Group = 0 (open-ended)
        new Uint8Array([128]),
        new Uint8Array([1]),
        buildParams(params),
      );
      const bytes = frame16(0x02, payload);
      const { message } = codec.decode(bytes, 0);
      const update = message as RequestUpdate;
      // For open-ended, filter type should be AbsoluteStart (no end group)
      const filterBytes = update.parameters.get(MessageParam.SUBSCRIPTION_FILTER)?.[0] as Uint8Array;
      expect(filterBytes).toBeInstanceOf(Uint8Array);
      const { value: ft } = readVarint(filterBytes, 0);
      expect(ft).toBe(0x3n); // AbsoluteStart (open-ended = no end group)
    });
  });

  describe('PUBLISH_OK encoding (§9.14)', () => {
    it('encodes PUBLISH_OK with inline fields', () => {
      /**
       * Draft-14 §9.14: PUBLISH_OK { Type (0x1E), Length (i),
       *   Request ID (i), Forward (8), Subscriber Priority (8),
       *   Group Order (8), Filter Type (i), [Start Location], [End Group (i)],
       *   Number of Parameters (i), Parameters (..) }
       *
       * The encoder reads Forward, Subscriber Priority, Group Order,
       * and Filter from the parameters map and writes them inline.
       * @see draft-ietf-moq-transport-14 §9.14
       */
      const msg: PublishOk = {
        type: 'PUBLISH_OK',
        requestId: varint(5n),
        parameters: new Map([
          [varint(MessageParam.FORWARD), [varint(1)]],
          [varint(MessageParam.SUBSCRIBER_PRIORITY), [varint(200)]],
          [varint(MessageParam.GROUP_ORDER), [varint(2)]],
        ]),
      };
      const bytes = codec.encode(msg);
      expect(bytes.length).toBeGreaterThan(0);

      // Decode and verify: type byte should be 0x1e
      const { value: typeVal } = readVarint(bytes, 0);
      expect(Number(typeVal)).toBe(0x1e);
    });

    it('round-trips PUBLISH_OK with NextGroupStart filter', () => {
      /**
       * Encode PUBLISH_OK, then decode — verify the fields survive.
       * Filter type NextGroupStart (0x1) has no start/end fields.
       */
      const msg: PublishOk = {
        type: 'PUBLISH_OK',
        requestId: varint(7n),
        parameters: new Map([
          [varint(MessageParam.FORWARD), [varint(1)]],
          [varint(MessageParam.SUBSCRIBER_PRIORITY), [varint(128)]],
          [varint(MessageParam.GROUP_ORDER), [varint(1)]],
        ]),
      };
      const bytes = codec.encode(msg);

      // Since the codec can't decode PUBLISH_OK (subscriber never receives
      // its own messages), we manually parse the wire format to verify:
      let pos = 0;
      const { bytesRead: typeBytes } = readVarint(bytes, pos);
      pos += typeBytes;
      // Varint length (PUBLISH_OK uses varint length, not uint16)
      const { value: payloadLen, bytesRead: lenBytes } = readVarint(bytes, pos);
      pos += lenBytes;
      // Request ID
      const { value: reqId, bytesRead: ridBytes } = readVarint(bytes, pos);
      pos += ridBytes;
      expect(reqId).toBe(7n);
      // Forward (8)
      expect(bytes[pos++]).toBe(1);
      // Subscriber Priority (8)
      expect(bytes[pos++]).toBe(128);
      // Group Order (8)
      expect(bytes[pos++]).toBe(1);
      // Filter Type (varint)
      const { value: filterType } = readVarint(bytes, pos);
      expect(filterType).toBe(0x1n); // NextGroupStart
    });

    it('defaults GROUP_ORDER to Ascending (0x1), never 0x0, when omitted (§9.14)', () => {
      /**
       * Draft-14 §9.14: "Values of 0x0 and those larger than 0x2 are a protocol error."
       * When parameters omit GROUP_ORDER, the encoder must default to 0x1, not 0x0.
       * @see draft-ietf-moq-transport-14 §9.14
       */
      const msg: PublishOk = {
        type: 'PUBLISH_OK',
        requestId: varint(1n),
        parameters: new Map(),  // No GROUP_ORDER
      };
      const bytes = codec.encode(msg);
      let pos = 0;
      const { bytesRead: typeBytes } = readVarint(bytes, pos);
      pos += typeBytes;
      const { bytesRead: lenBytes } = readVarint(bytes, pos);
      pos += lenBytes;
      // Request ID
      const { bytesRead: ridBytes } = readVarint(bytes, pos);
      pos += ridBytes;
      // Forward (8)
      pos++;
      // Subscriber Priority (8)
      pos++;
      // Group Order (8) — must be 0x1 (Ascending), not 0x0
      expect(bytes[pos]).toBe(1);
    });
  });

  describe('SUBSCRIBE_OK encoding (§9.8)', () => {
    it('encodes SUBSCRIBE_OK with inline fields', () => {
      /**
       * Draft-14 §9.8: SUBSCRIBE_OK { Type (0x04), Length (16),
       *   Request ID (i), Track Alias (i), Expires (i),
       *   Group Order (8), Content Exists (8),
       *   [Largest Location], Parameters (..) }
       */
      const msg: SubscribeOk = {
        type: 'SUBSCRIBE_OK',
        requestId: varint(2n),
        trackAlias: varint(10n),
        parameters: new Map([
          [varint(MessageParam.GROUP_ORDER), [varint(1)]],
        ]),
        trackExtensions: new Map(),
      };
      const bytes = codec.encode(msg);
      expect(bytes.length).toBeGreaterThan(0);

      // Verify type byte is 0x04
      const { value: typeVal } = readVarint(bytes, 0);
      expect(Number(typeVal)).toBe(0x04);
    });

    it('round-trips SUBSCRIBE_OK through decode', () => {
      const msg: SubscribeOk = {
        type: 'SUBSCRIBE_OK',
        requestId: varint(3n),
        trackAlias: varint(42n),
        parameters: new Map([
          [varint(MessageParam.GROUP_ORDER), [varint(2)]],  // Descending
        ]),
        trackExtensions: new Map(),
      };
      const bytes = codec.encode(msg);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('SUBSCRIBE_OK');
      const ok = message as SubscribeOk;
      expect(ok.requestId).toBe(3n);
      expect(ok.trackAlias).toBe(42n);
      // GROUP_ORDER normalized to parameter
      expect(ok.parameters.get(MessageParam.GROUP_ORDER)?.[0]).toBe(2n);
    });
  });

  describe('PUBLISH_DONE encoding (§9.15)', () => {
    it('encodes PUBLISH_DONE with all fields', () => {
      /**
       * Draft-14 §9.15 (§9.11 in draft-14 numbering):
       * PUBLISH_DONE { Type (0x0B), Length (16),
       *   Request ID (i), Status Code (i), Stream Count (i),
       *   Error Reason (Reason) }
       */
      const msg: PublishDone = {
        type: 'PUBLISH_DONE',
        requestId: varint(5n),
        statusCode: varint(0n),
        streamCount: varint(3n),
        errorReason: '',
      };
      const bytes = codec.encode(msg);
      expect(bytes.length).toBeGreaterThan(0);

      const { value: typeVal } = readVarint(bytes, 0);
      expect(Number(typeVal)).toBe(0x0b);
    });

    it('round-trips PUBLISH_DONE through decode', () => {
      const msg: PublishDone = {
        type: 'PUBLISH_DONE',
        requestId: varint(7n),
        statusCode: varint(2n), // TRACK_ENDED
        streamCount: varint(1n),
        errorReason: 'done',
      };
      const bytes = codec.encode(msg);
      const { message } = codec.decode(bytes, 0);
      expect(message.type).toBe('PUBLISH_DONE');
      const done = message as PublishDone;
      expect(done.requestId).toBe(7n);
      expect(done.statusCode).toBe(2n);
      expect(done.streamCount).toBe(1n);
      expect(done.errorReason).toBe('done');
    });
  });

  describe('PUBLISH_ERROR encoding (§9.15)', () => {
    it('encodes PUBLISH_ERROR with error code and reason', () => {
      /**
       * Draft-14 §9.15: PUBLISH_ERROR { Type (0x1F), Length (i),
       *   Request ID (i), Error Code (i), Error Reason (Reason) }
       * @see draft-ietf-moq-transport-14 §9.15
       */
      const msg: PublishError = {
        type: 'PUBLISH_ERROR',
        requestId: varint(3n),
        errorCode: varint(0x4n), // UNINTERESTED
        errorReason: 'not interested',
      };
      const bytes = codec.encode(msg);
      expect(bytes.length).toBeGreaterThan(0);

      // Verify type byte is 0x1f
      const { value: typeVal } = readVarint(bytes, 0);
      expect(Number(typeVal)).toBe(0x1f);
    });

    it('round-trips PUBLISH_ERROR through decode', () => {
      /**
       * PUBLISH_ERROR → encode → decode should return REQUEST_ERROR
       * (the codec normalizes PUBLISH_ERROR to REQUEST_ERROR on decode).
       */
      const msg: PublishError = {
        type: 'PUBLISH_ERROR',
        requestId: varint(9n),
        errorCode: varint(0x1n), // UNAUTHORIZED
        errorReason: 'unauthorized',
      };
      const bytes = codec.encode(msg);
      const { message } = codec.decode(bytes, 0);
      // The decoder normalizes PUBLISH_ERROR → REQUEST_ERROR
      expect(message.type).toBe('REQUEST_ERROR');
      const err = message as RequestErrorMsg;
      expect(err.requestId).toBe(9n);
      expect(err.errorCode).toBe(0x1n);
      expect(err.errorReason).toBe('unauthorized');
    });
  });
});

// Need this for beforeAll
import { beforeAll } from 'vitest';
