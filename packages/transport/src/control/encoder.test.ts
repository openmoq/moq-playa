import { describe, it, expect } from 'vitest';
import { encodeControlMessage } from './encoder.js';
import { decodeControlMessage } from './decoder.js';
import type {
  ControlMessage,
  ClientSetup,
  ServerSetup,
  Goaway,
  MaxRequestId,
  RequestsBlocked,
  RequestOk,
  RequestErrorMsg,
  Subscribe,
  SubscribeOk,
  RequestUpdate,
  Unsubscribe,
  Publish,
  PublishOk,
  PublishDone,
  Fetch,
  FetchOk,
  FetchCancel,
  TrackStatus,
  PublishNamespace,
  Namespace,
  PublishNamespaceDone,
  NamespaceDone,
  PublishNamespaceCancel,
  SubscribeNamespace,
} from './messages.js';
import { varint } from '../primitives/varint.js';
import { readVarint } from '../primitives/varint.js';
import { MessageType } from './codes.js';
import { ProtocolViolationError } from '../errors.js';

/**
 * Round-trip helper: encode → decode → assert structurally equal.
 * Returns the decoded message for additional assertions.
 */
function roundTrip<T extends ControlMessage>(msg: T): ControlMessage {
  const encoded = encodeControlMessage(msg);
  const { message, bytesRead } = decodeControlMessage(encoded, 0);
  expect(bytesRead).toBe(encoded.length);
  return message;
}

/** Helper to compare messages with Uint8Array/Map/bigint fields. */
function expectMsgEqual(a: ControlMessage, b: ControlMessage): void {
  expect(a.type).toBe(b.type);
  const aJson = msgToComparable(a);
  const bJson = msgToComparable(b);
  expect(aJson).toEqual(bJson);
}

function msgToComparable(msg: ControlMessage): unknown {
  return JSON.parse(JSON.stringify(msg, (_key, value) => {
    if (value instanceof Map) return Object.fromEntries(value);
    if (value instanceof Uint8Array) return Array.from(value);
    if (typeof value === 'bigint') return `__bigint__${value.toString()}`;
    return value;
  }));
}

describe('encoder: wire format basics', () => {
  it('framing starts with message type varint', () => {
    const msg: Goaway = { type: 'GOAWAY', newSessionUri: '' };
    const encoded = encodeControlMessage(msg);
    const { value: msgType } = readVarint(encoded, 0);
    expect(msgType).toBe(MessageType.GOAWAY);
  });

  it('framing has uint16 length after type', () => {
    const msg: Goaway = { type: 'GOAWAY', newSessionUri: '' };
    const encoded = encodeControlMessage(msg);
    const { bytesRead: typeLen } = readVarint(encoded, 0);
    // Length is a uint16 big-endian
    const length = (encoded[typeLen]! << 8) | encoded[typeLen + 1]!;
    // Remaining bytes should equal the length field
    expect(encoded.length - typeLen - 2).toBe(length);
  });
});

describe('round-trip: setup messages', () => {
  it('CLIENT_SETUP with no parameters', () => {
    const msg: ClientSetup = { type: 'CLIENT_SETUP', parameters: new Map() };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('CLIENT_SETUP with parameters', () => {
    const params = new Map();
    params.set(varint(0x02), [varint(10)]); // MAX_REQUEST_ID = 10
    params.set(varint(0x05), [new Uint8Array([0x6c, 0x6f, 0x63, 0x61, 0x6c])]); // AUTHORITY = "local"
    const msg: ClientSetup = { type: 'CLIENT_SETUP', parameters: params };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('SERVER_SETUP with no parameters', () => {
    const msg: ServerSetup = { type: 'SERVER_SETUP', parameters: new Map() };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('SERVER_SETUP with parameters', () => {
    const params = new Map();
    params.set(varint(0x02), [varint(100)]); // MAX_REQUEST_ID = 100
    const msg: ServerSetup = { type: 'SERVER_SETUP', parameters: params };
    expectMsgEqual(roundTrip(msg), msg);
  });
});

describe('round-trip: session messages', () => {
  it('GOAWAY with empty URI', () => {
    const msg: Goaway = { type: 'GOAWAY', newSessionUri: '' };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('GOAWAY with URI', () => {
    const msg: Goaway = { type: 'GOAWAY', newSessionUri: 'https://relay.example.com' };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('MAX_REQUEST_ID', () => {
    const msg: MaxRequestId = { type: 'MAX_REQUEST_ID', maxRequestId: varint(42) };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('REQUESTS_BLOCKED', () => {
    const msg: RequestsBlocked = { type: 'REQUESTS_BLOCKED', maximumRequestId: varint(10) };
    expectMsgEqual(roundTrip(msg), msg);
  });
});

describe('round-trip: response messages', () => {
  it('REQUEST_OK with no parameters', () => {
    const msg: RequestOk = { type: 'REQUEST_OK', requestId: varint(0), parameters: new Map() };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('REQUEST_OK with parameters', () => {
    const params = new Map();
    params.set(varint(0x08), [varint(3600)]); // EXPIRES
    const msg: RequestOk = { type: 'REQUEST_OK', requestId: varint(4), parameters: params };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('REQUEST_ERROR', () => {
    const msg: RequestErrorMsg = {
      type: 'REQUEST_ERROR',
      requestId: varint(2),
      errorCode: varint(0x10), // DOES_NOT_EXIST
      retryInterval: varint(0),
      errorReason: 'Track not found',
    };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('REQUEST_ERROR with retry interval', () => {
    const msg: RequestErrorMsg = {
      type: 'REQUEST_ERROR',
      requestId: varint(6),
      errorCode: varint(0x02), // TIMEOUT
      retryInterval: varint(5001), // 5 seconds + 1
      errorReason: 'Upstream timeout',
    };
    expectMsgEqual(roundTrip(msg), msg);
  });
});

describe('round-trip: subscription messages', () => {
  it('SUBSCRIBE', () => {
    const msg: Subscribe = {
      type: 'SUBSCRIBE',
      requestId: varint(0),
      trackNamespace: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])], // ["live"]
      trackName: new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]), // "video"
      parameters: new Map(),
    };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('SUBSCRIBE with parameters', () => {
    const params = new Map();
    params.set(varint(0x20), [varint(1)]); // SUBSCRIBER_PRIORITY
    params.set(varint(0x22), [varint(2)]); // GROUP_ORDER
    const msg: Subscribe = {
      type: 'SUBSCRIBE',
      requestId: varint(2),
      trackNamespace: [
        new Uint8Array([0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65]), // "example"
        new Uint8Array([0x6c, 0x69, 0x76, 0x65]), // "live"
      ],
      trackName: new Uint8Array([0x61, 0x75, 0x64, 0x69, 0x6f]), // "audio"
      parameters: params,
    };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('SUBSCRIBE_OK with no extensions', () => {
    const msg: SubscribeOk = {
      type: 'SUBSCRIBE_OK',
      requestId: varint(0),
      trackAlias: varint(1),
      parameters: new Map(),
      trackExtensions: new Map(),
    };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('SUBSCRIBE_OK with parameters and extensions', () => {
    const params = new Map();
    params.set(varint(0x08), [varint(7200)]); // EXPIRES
    const extensions = new Map();
    extensions.set(varint(0x100), [varint(42)]);
    const msg: SubscribeOk = {
      type: 'SUBSCRIBE_OK',
      requestId: varint(2),
      trackAlias: varint(5),
      parameters: params,
      trackExtensions: extensions,
    };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('REQUEST_UPDATE', () => {
    const params = new Map();
    params.set(varint(0x10), [varint(0)]); // FORWARD = 0 (pause)
    const msg: RequestUpdate = {
      type: 'REQUEST_UPDATE',
      requestId: varint(4),
      existingRequestId: varint(0),
      parameters: params,
    };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('UNSUBSCRIBE', () => {
    const msg: Unsubscribe = { type: 'UNSUBSCRIBE', requestId: varint(0) };
    expectMsgEqual(roundTrip(msg), msg);
  });
});

describe('round-trip: publish messages', () => {
  it('PUBLISH with no extensions', () => {
    const msg: Publish = {
      type: 'PUBLISH',
      requestId: varint(1),
      trackNamespace: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
      trackName: new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]),
      trackAlias: varint(1),
      parameters: new Map(),
      trackExtensions: new Map(),
    };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('PUBLISH_OK', () => {
    const params = new Map();
    params.set(varint(0x02), [varint(500)]); // DELIVERY_TIMEOUT
    const msg: PublishOk = {
      type: 'PUBLISH_OK',
      requestId: varint(1),
      parameters: params,
    };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('PUBLISH_DONE', () => {
    const msg: PublishDone = {
      type: 'PUBLISH_DONE',
      requestId: varint(0),
      statusCode: varint(0x02), // TRACK_ENDED
      streamCount: varint(15),
      errorReason: '',
    };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('PUBLISH_DONE with error reason', () => {
    const msg: PublishDone = {
      type: 'PUBLISH_DONE',
      requestId: varint(2),
      statusCode: varint(0x06), // TOO_FAR_BEHIND
      streamCount: varint(100),
      errorReason: 'Subscriber too slow',
    };
    expectMsgEqual(roundTrip(msg), msg);
  });
});

describe('round-trip: fetch messages', () => {
  it('FETCH standalone', () => {
    const msg: Fetch = {
      type: 'FETCH',
      requestId: varint(6),
      fetch: {
        fetchType: 0x1,
        trackNamespace: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
        trackName: new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]),
        startLocation: { group: varint(0), object: varint(0) },
        endLocation: { group: varint(10), object: varint(0) },
      },
      parameters: new Map(),
    };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('FETCH relative joining', () => {
    const msg: Fetch = {
      type: 'FETCH',
      requestId: varint(8),
      fetch: {
        fetchType: 0x2,
        joiningRequestId: varint(0),
        joiningStart: varint(5),
      },
      parameters: new Map(),
    };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('FETCH absolute joining', () => {
    const msg: Fetch = {
      type: 'FETCH',
      requestId: varint(10),
      fetch: {
        fetchType: 0x3,
        joiningRequestId: varint(2),
        joiningStart: varint(100),
      },
      parameters: new Map(),
    };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('FETCH_OK with no extensions', () => {
    const msg: FetchOk = {
      type: 'FETCH_OK',
      requestId: varint(6),
      endOfTrack: 0,
      endLocation: { group: varint(10), object: varint(5) },
      parameters: new Map(),
      trackExtensions: new Map(),
    };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('FETCH_OK with end of track', () => {
    const msg: FetchOk = {
      type: 'FETCH_OK',
      requestId: varint(6),
      endOfTrack: 1,
      endLocation: { group: varint(50), object: varint(25) },
      parameters: new Map(),
      trackExtensions: new Map(),
    };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('FETCH_CANCEL', () => {
    const msg: FetchCancel = { type: 'FETCH_CANCEL', requestId: varint(6) };
    expectMsgEqual(roundTrip(msg), msg);
  });
});

describe('round-trip: track status', () => {
  it('TRACK_STATUS (same format as SUBSCRIBE)', () => {
    const msg: TrackStatus = {
      type: 'TRACK_STATUS',
      requestId: varint(12),
      trackNamespace: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
      trackName: new Uint8Array([0x63, 0x61, 0x74, 0x61, 0x6c, 0x6f, 0x67]), // "catalog"
      parameters: new Map(),
    };
    expectMsgEqual(roundTrip(msg), msg);
  });
});

describe('round-trip: namespace messages', () => {
  it('PUBLISH_NAMESPACE', () => {
    const msg: PublishNamespace = {
      type: 'PUBLISH_NAMESPACE',
      requestId: varint(1),
      trackNamespace: [
        new Uint8Array([0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65]), // "example"
      ],
      parameters: new Map(),
    };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('NAMESPACE', () => {
    const msg: Namespace = {
      type: 'NAMESPACE',
      trackNamespaceSuffix: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
    };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('PUBLISH_NAMESPACE_DONE', () => {
    const msg: PublishNamespaceDone = {
      type: 'PUBLISH_NAMESPACE_DONE',
      requestId: varint(1),
    };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('NAMESPACE_DONE', () => {
    const msg: NamespaceDone = {
      type: 'NAMESPACE_DONE',
      trackNamespaceSuffix: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
    };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('PUBLISH_NAMESPACE_CANCEL', () => {
    const msg: PublishNamespaceCancel = {
      type: 'PUBLISH_NAMESPACE_CANCEL',
      requestId: varint(1),
      errorCode: varint(0x20), // UNINTERESTED
      errorReason: 'No longer needed',
    };
    expectMsgEqual(roundTrip(msg), msg);
  });

  it('SUBSCRIBE_NAMESPACE', () => {
    const params = new Map();
    params.set(varint(0x03), [new Uint8Array([0x01, 0x02])]); // AUTH TOKEN
    const msg: SubscribeNamespace = {
      type: 'SUBSCRIBE_NAMESPACE',
      requestId: varint(14),
      trackNamespacePrefix: [
        new Uint8Array([0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65]),
      ],
      subscribeOptions: varint(0x02), // both PUBLISH and NAMESPACE
      parameters: params,
    };
    expectMsgEqual(roundTrip(msg), msg);
  });
});

describe('encoder: known byte sequences', () => {
  it('GOAWAY with empty URI encodes correctly', () => {
    const msg: Goaway = { type: 'GOAWAY', newSessionUri: '' };
    const encoded = encodeControlMessage(msg);
    // Type = 0x10 (varint, 1 byte)
    // Length = 1 (uint16, 2 bytes) — payload is just varint(0) for URI length
    // URI Length = 0 (varint, 1 byte)
    // Total: 1 + 2 + 1 = 4 bytes
    expect(encoded.length).toBe(4);
    expect(encoded[0]).toBe(0x10); // GOAWAY type
    expect(encoded[1]).toBe(0x00); // Length high byte
    expect(encoded[2]).toBe(0x01); // Length low byte (1 byte for varint 0)
    expect(encoded[3]).toBe(0x00); // URI length = 0
  });

  it('MAX_REQUEST_ID encodes correctly', () => {
    const msg: MaxRequestId = { type: 'MAX_REQUEST_ID', maxRequestId: varint(10) };
    const encoded = encodeControlMessage(msg);
    // Type = 0x15 (1 byte)
    // Length = 1 (uint16, 2 bytes) — varint(10) is 1 byte
    // Max Request ID = 10 (1 byte)
    expect(encoded.length).toBe(4);
    expect(encoded[0]).toBe(0x15);
    expect(encoded[3]).toBe(10);
  });

  it('UNSUBSCRIBE encodes correctly', () => {
    const msg: Unsubscribe = { type: 'UNSUBSCRIBE', requestId: varint(4) };
    const encoded = encodeControlMessage(msg);
    // Type = 0x0A (1 byte), Length = 1 (2 bytes), Request ID = 4 (1 byte)
    expect(encoded.length).toBe(4);
    expect(encoded[0]).toBe(0x0a);
    expect(encoded[3]).toBe(4);
  });
});

describe('encoder: bounds checks', () => {
  it('throws if GOAWAY URI exceeds 8192 bytes', () => {
    const msg: Goaway = { type: 'GOAWAY', newSessionUri: 'x'.repeat(8193) };
    expect(() => encodeControlMessage(msg)).toThrow(RangeError);
  });

  it('accepts GOAWAY URI at exactly 8192 bytes', () => {
    const msg: Goaway = { type: 'GOAWAY', newSessionUri: 'x'.repeat(8192) };
    expect(() => encodeControlMessage(msg)).not.toThrow();
  });

  it('throws if payload exceeds 65535 bytes', () => {
    // Construct a SUBSCRIBE_NAMESPACE with a huge auth token to overflow uint16
    const params = new Map();
    // An odd-type key with a large bytes value
    params.set(varint(0x03), [new Uint8Array(65535)]); // max allowed per KVP
    // The params + other fields will push total payload > 65535
    const msg: SubscribeNamespace = {
      type: 'SUBSCRIBE_NAMESPACE',
      requestId: varint(1),
      trackNamespacePrefix: [new Uint8Array(100)],
      subscribeOptions: varint(0),
      parameters: params,
    };
    expect(() => encodeControlMessage(msg)).toThrow(RangeError);
  });
});

describe('encoder: sender-side duplicate validation', () => {
  it('throws if DELIVERY_TIMEOUT appears multiple times', () => {
    const params = new Map();
    params.set(varint(0x02), [varint(500), varint(600)]); // DELIVERY_TIMEOUT duplicated
    const msg: Subscribe = {
      type: 'SUBSCRIBE',
      requestId: varint(0),
      trackNamespace: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
      trackName: new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]),
      parameters: params,
    };
    expect(() => encodeControlMessage(msg)).toThrow(/duplicate.*DELIVERY_TIMEOUT/i);
  });

  it('throws if EXPIRES appears multiple times', () => {
    const params = new Map();
    params.set(varint(0x08), [varint(3600), varint(7200)]); // EXPIRES duplicated
    const msg: SubscribeOk = {
      type: 'SUBSCRIBE_OK',
      requestId: varint(0),
      trackAlias: varint(1),
      parameters: params,
      trackExtensions: new Map(),
    };
    expect(() => encodeControlMessage(msg)).toThrow(/duplicate.*EXPIRES/i);
  });

  it('throws if SUBSCRIBER_PRIORITY appears multiple times', () => {
    const params = new Map();
    params.set(varint(0x20), [varint(1), varint(2)]); // SUBSCRIBER_PRIORITY duplicated
    const msg: Subscribe = {
      type: 'SUBSCRIBE',
      requestId: varint(0),
      trackNamespace: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
      trackName: new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]),
      parameters: params,
    };
    expect(() => encodeControlMessage(msg)).toThrow(/duplicate.*SUBSCRIBER_PRIORITY/i);
  });

  it('allows multiple AUTHORIZATION_TOKEN values', () => {
    const params = new Map();
    params.set(varint(0x03), [new Uint8Array([0x01]), new Uint8Array([0x02])]); // AUTH_TOKEN can repeat
    const msg: Subscribe = {
      type: 'SUBSCRIBE',
      requestId: varint(0),
      trackNamespace: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
      trackName: new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]),
      parameters: params,
    };
    expect(() => encodeControlMessage(msg)).not.toThrow();
  });

  it('accepts single values for all known message params', () => {
    const params = new Map();
    params.set(varint(0x02), [varint(500)]);  // DELIVERY_TIMEOUT
    params.set(varint(0x03), [new Uint8Array([0x01])]); // AUTHORIZATION_TOKEN
    params.set(varint(0x20), [varint(1)]);   // SUBSCRIBER_PRIORITY
    const msg: Subscribe = {
      type: 'SUBSCRIBE',
      requestId: varint(0),
      trackNamespace: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
      trackName: new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]),
      parameters: params,
    };
    expect(() => encodeControlMessage(msg)).not.toThrow();
  });

  it('setup messages skip validation (handled by session layer)', () => {
    // Setup params have different rules and are validated in session.ts
    // The encoder should not throw for setup messages
    const params = new Map();
    params.set(varint(0x02), [varint(10), varint(20)]); // MAX_REQUEST_ID duplicated
    const msg: ClientSetup = { type: 'CLIENT_SETUP', parameters: params };
    // Should not throw - setup validation is in session layer
    expect(() => encodeControlMessage(msg)).not.toThrow();
  });
});

describe('decoder: error handling', () => {
  it('throws on truncated message', () => {
    // Just a type byte with no length
    const buf = new Uint8Array([0x10]);
    expect(() => decodeControlMessage(buf, 0)).toThrow();
  });

  it('decodes from non-zero offset', () => {
    const msg: Goaway = { type: 'GOAWAY', newSessionUri: '' };
    const encoded = encodeControlMessage(msg);
    const buf = new Uint8Array(5 + encoded.length);
    buf.set(encoded, 5);
    const { message, bytesRead } = decodeControlMessage(buf, 5);
    expect(message.type).toBe('GOAWAY');
    expect(bytesRead).toBe(encoded.length);
  });

  it('throws if payload is not fully consumed', () => {
    // Hand-craft a MAX_REQUEST_ID with extra trailing bytes in the payload
    // Type 0x15 (1 byte), Length 3 (uint16), payload = varint(10) + 2 junk bytes
    const buf = new Uint8Array([
      0x15,       // type = MAX_REQUEST_ID
      0x00, 0x03, // length = 3
      0x0a,       // varint(10) — MAX_REQUEST_ID value (1 byte)
      0xff, 0xff, // 2 extra bytes (should cause error)
    ]);
    expect(() => decodeControlMessage(buf, 0)).toThrow();
  });

  it('throws ProtocolViolationError on unknown message type (§9)', () => {
    // Type 0x3F (not a known type), Length 0
    const buf = new Uint8Array([0x3f, 0x00, 0x00]);
    try {
      decodeControlMessage(buf, 0);
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProtocolViolationError);
      expect((e as Error).message).toMatch(/Unknown message type/i);
    }
  });

  it('throws ProtocolViolationError on invalid Fetch Type (§9)', () => {
    // Hand-craft a FETCH message with invalid fetch type 0x5
    // FETCH type = 0x16 (varint), then uint16 length, then payload
    const payloadLen = 2; // requestId(1 byte) + fetchType(1 byte)
    const buf = new Uint8Array([
      0x16,                           // FETCH message type (varint)
      0x00, payloadLen,               // uint16 length
      0x01,                           // Request ID = 1
      0x05,                           // Invalid Fetch Type = 0x5
    ]);
    try {
      decodeControlMessage(buf, 0);
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProtocolViolationError);
      expect((e as Error).message).toMatch(/Fetch Type/i);
    }
  });

  it('decoder throws if GOAWAY URI length exceeds 8192 bytes', () => {
    // Hand-craft a GOAWAY message with URI length = 8193
    // GOAWAY type = 0x10, then Length (uint16), then payload (varint URI len + URI bytes)
    // URI length 8193 as varint: 2-byte encoding
    // 8193 = 0x2001 → 2-byte varint: 0x60 0x01 (01 prefix + high 6 bits + low 8 bits)
    // Actually: 2-byte varint format is 01xxxxxx xxxxxxxx where x's hold 14 bits
    // 8193 in binary = 10000000000001 (14 bits) → fits in 2-byte varint
    // High 6 bits: 100000 = 32 = 0x20, Low 8 bits: 00000001 = 1
    // 2-byte varint: 0x40 | 0x20 = 0x60, then 0x01
    const uriLenVarint = [0x60, 0x01]; // 8193 as 2-byte varint
    const payloadLen = uriLenVarint.length + 8193;

    // Full message: type (0x10) + length (uint16 BE) + payload
    const buf = new Uint8Array(3 + payloadLen);
    buf[0] = 0x10; // GOAWAY type
    buf[1] = (payloadLen >> 8) & 0xff;
    buf[2] = payloadLen & 0xff;
    buf[3] = uriLenVarint[0]!;
    buf[4] = uriLenVarint[1]!;
    // URI bytes don't matter since it should throw on length check

    expect(() => decodeControlMessage(buf, 0)).toThrow(RangeError);
  });

  it('decoder accepts GOAWAY URI at exactly 8192 bytes', () => {
    // 8192 = 0x2000 → 2-byte varint: 0x60 0x00
    const uriLenVarint = [0x60, 0x00]; // 8192 as 2-byte varint
    const payloadLen = uriLenVarint.length + 8192;

    const buf = new Uint8Array(3 + payloadLen);
    buf[0] = 0x10; // GOAWAY type
    buf[1] = (payloadLen >> 8) & 0xff;
    buf[2] = payloadLen & 0xff;
    buf[3] = uriLenVarint[0]!;
    buf[4] = uriLenVarint[1]!;
    // Fill with valid ASCII URI chars
    for (let i = 0; i < 8192; i++) {
      buf[5 + i] = 0x61; // 'a'
    }

    const { message } = decodeControlMessage(buf, 0);
    expect(message.type).toBe('GOAWAY');
    expect((message as { newSessionUri: string }).newSessionUri.length).toBe(8192);
  });
});
