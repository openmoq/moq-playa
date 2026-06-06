/**
 * Draft18Codec — wire codec increment for SUBSCRIBE (request) and SUBSCRIBE_OK
 * (response). Scope is deliberately narrow (Codex): framing + these two
 * messages. Other message types throw an explicit "not implemented".
 *
 * Guardrails verified here:
 *   - namespace tuple + track-name length use vi64;
 *   - LARGEST_OBJECT encodes Location as two vi64s directly;
 *   - SUBSCRIBE_OK decodes with requestId === undefined (responses omit it);
 *   - a request ID and a track alias above the QUIC range round-trip on d18;
 *   - draft-14/16 still throw when encoding those same out-of-range values.
 */
import { describe, it, expect } from 'vitest';
import { createControlCodec } from './codec.js';
import { varint } from '../primitives/varint.js';
import { readVi64, writeVi64, vi64EncodingLength } from '../primitives/vi64.js';
import { MessageParam } from './parameters.js';
import { SetupOption18 } from './codes-18.js';
import type { Subscribe, SubscribeOk, RequestOk, RequestErrorMsg, RequestUpdate, Fetch, FetchOk, TrackStatus, PublishNamespace, Publish, PublishDone, SubscribeNamespace, SubscribeTracks, PublishBlocked, Namespace, NamespaceDone, Setup, SetupOptionValue, Goaway } from './messages.js';
import type { Location } from '../primitives/location.js';

const codec18 = createControlCodec(18);
const NS = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])]; // "live"
const NAME = new Uint8Array([0x76, 0x69, 0x64]); // "vid"

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

describe('Draft18Codec framing', () => {
  it('encodes Type (vi64) + Length (uint16 BE) + Payload', () => {
    const sub: Subscribe = {
      type: 'SUBSCRIBE', requestId: 0n, trackNamespace: NS, trackName: NAME, parameters: new Map(),
    };
    const bytes = codec18.encode(sub);
    expect(bytes[0]).toBe(0x03); // SUBSCRIBE type, 1-byte vi64
    const len = (bytes[1]! << 8) | bytes[2]!; // uint16 BE
    expect(bytes.length).toBe(3 + len);
    expect(codec18.peekFrameSize(bytes)).toBe(bytes.length);
  });

  it('peekFrameSize returns undefined when the buffer is too short', () => {
    expect(codec18.peekFrameSize(new Uint8Array([0x03]))).toBeUndefined();
  });
});

describe('SUBSCRIBE round-trip (request keeps Request ID)', () => {
  it('round-trips namespace tuple + vi64 name length + params', () => {
    const sub: Subscribe = {
      type: 'SUBSCRIBE',
      requestId: 4n,
      trackNamespace: NS,
      trackName: NAME,
      parameters: new Map([[MessageParam.SUBSCRIBER_PRIORITY, [varint(7n)]]]),
    };
    const { message, bytesRead } = codec18.decode(codec18.encode(sub), 0);
    expect(bytesRead).toBe(codec18.encode(sub).length);
    expect(message.type).toBe('SUBSCRIBE');
    const m = message as Subscribe;
    expect(m.requestId).toBe(4n);
    expect(m.trackNamespace.map(hex)).toEqual(NS.map(hex));
    expect(hex(m.trackName)).toBe(hex(NAME));
    expect(m.parameters.get(MessageParam.SUBSCRIBER_PRIORITY)).toEqual([7n]);
  });

  it('a request ID above the QUIC range round-trips on draft-18', () => {
    const big = 1n << 63n;
    const sub: Subscribe = {
      type: 'SUBSCRIBE', requestId: big, trackNamespace: NS, trackName: NAME, parameters: new Map(),
    };
    const { message } = codec18.decode(codec18.encode(sub), 0);
    expect((message as Subscribe).requestId).toBe(big);
  });
});

describe('SUBSCRIBE_OK round-trip (response omits Request ID)', () => {
  it('decodes with requestId === undefined', () => {
    const ok: SubscribeOk = {
      type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: varint(9n), parameters: new Map(), trackExtensions: new Map(),
    };
    const { message } = codec18.decode(codec18.encode(ok), 0);
    expect(message.type).toBe('SUBSCRIBE_OK');
    expect((message as { requestId?: bigint }).requestId).toBeUndefined();
    expect((message as SubscribeOk).trackAlias).toBe(9n);
  });

  it('a track alias above the QUIC range round-trips on draft-18', () => {
    const big = 1n << 63n;
    const ok: SubscribeOk = {
      type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: big, parameters: new Map(), trackExtensions: new Map(),
    };
    const { message } = codec18.decode(codec18.encode(ok), 0);
    expect((message as SubscribeOk).trackAlias).toBe(big);
  });

  it('round-trips SUBSCRIBE_OK with non-empty Track Properties (after the Parameters block)', () => {
    const ok: SubscribeOk = {
      type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: varint(9n),
      parameters: new Map([[MessageParam.EXPIRES, [varint(5n)]]]),
      // even Type 0x02 → vi64; odd Type 0x03 → bytes.
      trackExtensions: new Map<bigint, (bigint | Uint8Array)[]>([
        [0x02n, [5n]], [0x03n, [new Uint8Array([0xaa])]],
      ]) as never,
    };
    const { message } = codec18.decode(codec18.encode(ok), 0);
    const m = message as SubscribeOk;
    expect(m.parameters.get(MessageParam.EXPIRES)).toEqual([5n]); // params still decode
    const props = m.trackExtensions as never as Map<bigint, (bigint | Uint8Array)[]>;
    expect(props.get(0x02n)).toEqual([5n]);
    expect(props.get(0x03n)).toEqual([new Uint8Array([0xaa])]);
  });

  it('LARGEST_OBJECT Location with a field above the QUIC range round-trips', () => {
    const big = 1n << 63n;
    const loc: Location = { group: big, object: 5n };
    const ok: SubscribeOk = {
      type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: varint(1n),
      parameters: new Map([[MessageParam.LARGEST_OBJECT, [loc]]]),
      trackExtensions: new Map(),
    };
    const { message } = codec18.decode(codec18.encode(ok), 0);
    const decodedLoc = (message as SubscribeOk).parameters.get(MessageParam.LARGEST_OBJECT)![0] as Location;
    expect(decodedLoc.group).toBe(big);
    expect(decodedLoc.object).toBe(5n);
  });

  it('LARGEST_OBJECT is encoded as two vi64s directly (not via QUIC writeLocation)', () => {
    const loc: Location = { group: varint(300n), object: varint(2n) };
    const ok: SubscribeOk = {
      type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: varint(1n),
      parameters: new Map([[MessageParam.LARGEST_OBJECT, [loc]]]),
      trackExtensions: new Map(),
    };
    const bytes = codec18.encode(ok);
    // group 300 as vi64 is 2 bytes (0x812c); the codec must reproduce that.
    const vbuf = new Uint8Array(2);
    writeVi64(300n, vbuf, 0);
    expect(hex(bytes)).toContain(hex(vbuf));
    // sanity: the encoded group decodes back to 300 via vi64.
    expect(readVi64(vbuf, 0).value).toBe(300n);
  });
});

describe('codec fixes (Codex round)', () => {
  it('rejects a SUBSCRIBE with trailing payload bytes', () => {
    const sub: Subscribe = {
      type: 'SUBSCRIBE', requestId: 1n, trackNamespace: NS, trackName: NAME, parameters: new Map(),
    };
    const good = codec18.encode(sub);
    // Append a junk byte inside the framed Length so decode sees trailing data.
    const tampered = new Uint8Array(good.length + 1);
    tampered.set(good, 0);
    tampered[2] = good[2]! + 1; // bump uint16 length low byte by 1
    tampered[good.length] = 0xff; // the extra trailing byte
    expect(() => codec18.decode(tampered, 0)).toThrow(/trailing/i);
  });

  it('rejects SUBSCRIBER_PRIORITY = 256 instead of masking it to 0', () => {
    const sub: Subscribe = {
      type: 'SUBSCRIBE', requestId: 0n, trackNamespace: NS, trackName: NAME,
      parameters: new Map([[MessageParam.SUBSCRIBER_PRIORITY, [256n]]]),
    };
    expect(() => codec18.encode(sub)).toThrow(/0\.\.255|out of range/i);
  });

  it('round-trips a non-Location varint param above the QUIC range (EXPIRES) — vi64, not QUIC varint', () => {
    // Slice 2: the draft18 codec's parameter bridge must NOT re-fold message
    // varints through the QUIC-Varint guard. EXPIRES (kind 'varint') carries the
    // full vi64 range, so 2^63 survives encode→decode unchanged.
    const big = 1n << 63n; // > 2^62-1
    const params = new Map<bigint, unknown[]>([[MessageParam.EXPIRES, [big]]]);
    const ok = {
      type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: varint(1n),
      parameters: params, trackExtensions: new Map(),
    } as unknown as SubscribeOk;
    const { message } = codec18.decode(codec18.encode(ok), 0);
    expect((message as SubscribeOk).parameters.get(MessageParam.EXPIRES)).toEqual([big]);
  });
});

/** Frame a raw payload as Type (vi64) + Length (uint16 BE) + Payload. */
function frame18(type: number, payload: Uint8Array): Uint8Array {
  const tbuf = new Uint8Array(9);
  const tn = writeVi64(BigInt(type), tbuf, 0);
  const out = new Uint8Array(tn + 2 + payload.length);
  out.set(tbuf.subarray(0, tn), 0);
  out[tn] = (payload.length >> 8) & 0xff;
  out[tn + 1] = payload.length & 0xff;
  out.set(payload, tn + 2);
  return out;
}
/** Append a trailing junk byte inside a framed message's Length. */
function withTrailingByte(framed: Uint8Array): Uint8Array {
  const t = new Uint8Array(framed.length + 1);
  t.set(framed, 0);
  t[2] = framed[2]! + 1; // bump uint16 length low byte
  t[framed.length] = 0xff;
  return t;
}

describe('REQUEST_OK round-trip (response omits Request ID)', () => {
  it('decodes with requestId undefined and preserves parameters', () => {
    const ok: RequestOk = {
      type: 'REQUEST_OK', requestId: 0n,
      parameters: new Map([[MessageParam.EXPIRES, [varint(5n)]]]),
    };
    const { message } = codec18.decode(codec18.encode(ok), 0);
    expect(message.type).toBe('REQUEST_OK');
    expect((message as { requestId?: bigint }).requestId).toBeUndefined();
    expect((message as RequestOk).parameters.get(MessageParam.EXPIRES)).toEqual([5n]);
  });

  it('round-trips Track Properties (TRACK_STATUS_OK context) — the codec decodes them regardless of context', () => {
    const ok: RequestOk = {
      type: 'REQUEST_OK', requestId: 0n, parameters: new Map(),
      trackExtensions: new Map([[0x02n, [5n]]]) as never, // even Type → vi64 value
    };
    const { message } = codec18.decode(codec18.encode(ok), 0);
    expect(message.type).toBe('REQUEST_OK');
    expect((message as RequestOk).trackExtensions?.get(0x02n as never)).toEqual([5n]);
  });
});

describe('REQUEST_ERROR round-trip (response omits Request ID)', () => {
  it('round-trips errorCode / retryInterval / reason with requestId undefined', () => {
    const err: RequestErrorMsg = {
      type: 'REQUEST_ERROR', requestId: 0n,
      errorCode: varint(0x10n), retryInterval: varint(3n), errorReason: 'nope',
    };
    const { message } = codec18.decode(codec18.encode(err), 0);
    expect(message.type).toBe('REQUEST_ERROR');
    expect((message as { requestId?: bigint }).requestId).toBeUndefined();
    const m = message as RequestErrorMsg;
    expect(m.errorCode).toBe(0x10n);
    expect(m.retryInterval).toBe(3n);
    expect(m.errorReason).toBe('nope');
  });

  it('a non-REDIRECT error code with trailing Redirect bytes is rejected', () => {
    const err: RequestErrorMsg = {
      type: 'REQUEST_ERROR', requestId: 0n,
      errorCode: varint(0x10n), retryInterval: varint(0n), errorReason: '',
    };
    expect(() => codec18.decode(withTrailingByte(codec18.encode(err)), 0)).toThrow(/Redirect|trailing/i);
  });

  it('errorCode and retryInterval are vi64 — full-uint64 values round-trip (§10.6.2, no QUIC cap)', () => {
    const big = 1n << 63n; // above the QUIC-Varint range
    const err: RequestErrorMsg = {
      type: 'REQUEST_ERROR', requestId: 0n,
      errorCode: big, retryInterval: big + 1n, errorReason: 'moved',
    };
    const { message } = codec18.decode(codec18.encode(err), 0);
    const m = message as RequestErrorMsg;
    expect(m.errorCode).toBe(big);
    expect(m.retryInterval).toBe(big + 1n);
  });

  it('decodes a full-uint64 errorCode without folding it through the QUIC range', () => {
    const payload = new Uint8Array(24);
    let p = writeVi64(1n << 63n, payload, 0); // errorCode > 2^62-1
    p += writeVi64(0n, payload, p); // retryInterval
    p += writeVi64(0n, payload, p); // reason length 0
    const framed = frame18(0x05, payload.subarray(0, p)); // 0x05 = REQUEST_ERROR
    const { message } = codec18.decode(framed, 0);
    expect((message as RequestErrorMsg).errorCode).toBe(1n << 63n);
  });
});

describe('REQUEST_UPDATE (request, §10.9 — keeps its own Request ID, omits Existing)', () => {
  it('round-trips requestId + parameters; existingRequestId is NOT on the wire', () => {
    const update: RequestUpdate = {
      type: 'REQUEST_UPDATE',
      requestId: 4n, // the update's OWN request id
      existingRequestId: 0n, // the target — must NOT be encoded (implicit from stream)
      parameters: new Map([[MessageParam.FORWARD, [varint(0n)]]]),
    };
    const bytes = codec18.encode(update);
    expect(bytes[0]).toBe(0x02); // REQUEST_UPDATE type
    const { message } = codec18.decode(bytes, 0);
    expect(message.type).toBe('REQUEST_UPDATE');
    const m = message as RequestUpdate;
    expect(m.requestId).toBe(4n);
    expect(m.existingRequestId).toBeUndefined(); // stream identifies the target
    expect(m.parameters.get(MessageParam.FORWARD)).toEqual([0n]);
  });

  it('rejects trailing bytes after parameters', () => {
    const update: RequestUpdate = { type: 'REQUEST_UPDATE', requestId: 2n, existingRequestId: 0n, parameters: new Map() };
    const good = codec18.encode(update);
    const t = new Uint8Array(good.length + 1);
    t.set(good, 0);
    t[2] = good[2]! + 1;
    t[good.length] = 0xff;
    expect(() => codec18.decode(t, 0)).toThrow(/trailing/i);
  });

  it('round-trips a TRACK_NAMESPACE_PREFIX (0x34) parameter as a semantic tuple (§10.2.14)', () => {
    const f = (s: string) => new TextEncoder().encode(s);
    const update: RequestUpdate = {
      type: 'REQUEST_UPDATE',
      requestId: 6n,
      existingRequestId: 0n,
      // The semantic value is a Track Namespace tuple (Uint8Array[]), not raw bytes.
      parameters: new Map([[0x34n, [[f('example.com'), f('meeting=123')]]]]),
    };
    const bytes = codec18.encode(update);
    const { message } = codec18.decode(bytes, 0);
    const m = message as RequestUpdate;
    const prefix = m.parameters.get(0x34n);
    expect(prefix).toBeDefined();
    // Decoded back into the same semantic tuple the session can validate/apply.
    expect(prefix![0]).toEqual([f('example.com'), f('meeting=123')]);
  });

  it('rejects encoding a TRACK_NAMESPACE_PREFIX whose field is not a Uint8Array', () => {
    const bad = {
      type: 'REQUEST_UPDATE', requestId: 6n, existingRequestId: 0n,
      parameters: new Map([[0x34n, [['not-bytes' as unknown as Uint8Array]]]]),
    } as unknown as RequestUpdate;
    expect(() => codec18.encode(bad)).toThrow(/non-Uint8Array|Track Namespace tuple/i);
  });
});

describe('SETUP (unified, 0x2F00)', () => {
  it('frames the 0x2F00 type as a 2-byte vi64 + uint16 length', () => {
    const setup = { type: 'SETUP', setupOptions: new Map() } as Setup;
    const bytes = codec18.encode(setup);
    expect(bytes[0]).toBe(0xaf); // vi64(0x2F00) byte 1
    expect(bytes[1]).toBe(0x00); // vi64(0x2F00) byte 2
    expect(bytes[2]).toBe(0x00); // uint16 length high
    expect(bytes[3]).toBe(0x00); // uint16 length low → empty payload
    expect(bytes.length).toBe(4);
    expect(codec18.peekFrameSize(bytes)).toBe(4);
  });

  it('round-trips Setup Options (even→vi64, odd→bytes), no count prefix', () => {
    const CACHE = BigInt(SetupOption18.MAX_AUTH_TOKEN_CACHE_SIZE); // 0x04 even → vi64
    const PATH = BigInt(SetupOption18.PATH); //                       0x01 odd  → bytes
    const opts = new Map<bigint, SetupOptionValue[]>([
      [CACHE, [1024n]],
      [PATH, [new Uint8Array([0x2f, 0x61])]],
    ]);
    const setup: Setup = { type: 'SETUP', setupOptions: opts };
    const { message } = codec18.decode(codec18.encode(setup), 0);
    expect(message.type).toBe('SETUP');
    const decoded = (message as Setup).setupOptions;
    expect(decoded.get(CACHE)).toEqual([1024n]);
    expect(decoded.get(PATH)).toEqual([new Uint8Array([0x2f, 0x61])]);
  });

  it('an even-Type Setup Option value is vi64 (full uint64), not QUIC-capped', () => {
    const big = 1n << 63n; // > 2^62-1: would throw if folded through varint()
    const opts = new Map<bigint, SetupOptionValue[]>([[0x40n, [big]]]); // 0x40 even
    const setup: Setup = { type: 'SETUP', setupOptions: opts };
    const { message } = codec18.decode(codec18.encode(setup), 0);
    expect((message as Setup).setupOptions.get(0x40n)).toEqual([big]);
  });

  it('decodes (does not reject) an unknown Setup Option — session decides', () => {
    const opts = new Map<bigint, SetupOptionValue[]>([[0x42n, [5n]]]); // 0x42 even, unknown
    const setup: Setup = { type: 'SETUP', setupOptions: opts };
    const { message } = codec18.decode(codec18.encode(setup), 0);
    expect((message as Setup).setupOptions.get(0x42n)).toEqual([5n]);
  });

  it('rejects a repeated known singleton (PATH) on encode', () => {
    const PATH = BigInt(SetupOption18.PATH);
    const opts = new Map<bigint, SetupOptionValue[]>([[PATH, [new Uint8Array([1]), new Uint8Array([2])]]]);
    const setup: Setup = { type: 'SETUP', setupOptions: opts };
    expect(() => codec18.encode(setup)).toThrow(/must not be repeated/i);
  });

  it('allows a repeated AUTHORIZATION_TOKEN and an unknown repeated option', () => {
    const AUTH = BigInt(SetupOption18.AUTHORIZATION_TOKEN); // 0x03 odd → bytes, repeatable
    const opts = new Map<bigint, SetupOptionValue[]>([
      [AUTH, [new Uint8Array([1]), new Uint8Array([2])]],
      [0x44n, [1n, 2n]], // unknown even, repeated → allowed
    ]);
    const setup: Setup = { type: 'SETUP', setupOptions: opts };
    const { message } = codec18.decode(codec18.encode(setup), 0);
    const decoded = (message as Setup).setupOptions;
    expect(decoded.get(AUTH)).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
    expect(decoded.get(0x44n)).toEqual([1n, 2n]);
  });
});

describe('FETCH round-trip (request keeps Request ID, §10.12)', () => {
  it('round-trips a standalone fetch with vi64 Locations + params', () => {
    const fetch: Fetch = {
      type: 'FETCH',
      requestId: 6n,
      fetch: {
        fetchType: 0x1,
        trackNamespace: NS,
        trackName: NAME,
        startLocation: { group: 1n, object: 2n },
        endLocation: { group: 9n, object: 4n },
      },
      parameters: new Map([[MessageParam.SUBSCRIBER_PRIORITY, [varint(3n)]]]),
    };
    const bytes = codec18.encode(fetch);
    expect(bytes[0]).toBe(0x16); // FETCH type
    const { message, bytesRead } = codec18.decode(bytes, 0);
    expect(bytesRead).toBe(bytes.length);
    const m = message as Fetch;
    expect(m.requestId).toBe(6n);
    const f = m.fetch as Extract<Fetch['fetch'], { fetchType: 0x1 }>;
    expect(f.fetchType).toBe(0x1);
    expect(f.trackNamespace.map(hex)).toEqual(NS.map(hex));
    expect(hex(f.trackName)).toBe(hex(NAME));
    expect(f.startLocation).toEqual({ group: 1n, object: 2n });
    expect(f.endLocation).toEqual({ group: 9n, object: 4n });
    expect(m.parameters.get(MessageParam.SUBSCRIBER_PRIORITY)).toEqual([3n]);
  });

  it('standalone fetch Locations above the QUIC range round-trip (vi64, no cap)', () => {
    const big = 1n << 63n;
    const fetch: Fetch = {
      type: 'FETCH', requestId: 0n,
      fetch: {
        fetchType: 0x1, trackNamespace: NS, trackName: NAME,
        startLocation: { group: big, object: 0n },
        endLocation: { group: big, object: big },
      },
      parameters: new Map(),
    };
    const { message } = codec18.decode(codec18.encode(fetch), 0);
    const f = (message as Fetch).fetch as Extract<Fetch['fetch'], { fetchType: 0x1 }>;
    expect(f.startLocation.group).toBe(big);
    expect(f.endLocation.object).toBe(big);
  });

  it('round-trips a joining fetch (type 0x2)', () => {
    const fetch: Fetch = {
      type: 'FETCH', requestId: 8n,
      fetch: { fetchType: 0x2, joiningRequestId: 4n, joiningStart: varint(2n) },
      parameters: new Map(),
    };
    const { message } = codec18.decode(codec18.encode(fetch), 0);
    const f = (message as Fetch).fetch as Extract<Fetch['fetch'], { fetchType: 0x2 | 0x3 }>;
    expect(f.fetchType).toBe(0x2);
    expect(f.joiningRequestId).toBe(4n);
    expect(f.joiningStart).toBe(2n);
  });

  it('a joining fetch joiningStart above the QUIC range round-trips (vi64, no cap)', () => {
    const big = 1n << 63n;
    const fetch: Fetch = {
      type: 'FETCH', requestId: 0n,
      fetch: { fetchType: 0x3, joiningRequestId: 1n, joiningStart: big },
      parameters: new Map(),
    };
    const { message } = codec18.decode(codec18.encode(fetch), 0);
    const f = (message as Fetch).fetch as Extract<Fetch['fetch'], { fetchType: 0x2 | 0x3 }>;
    expect(f.joiningStart).toBe(big);
  });

  it('rejects an invalid Fetch Type', () => {
    // Hand-build a FETCH frame with Fetch Type 0x9.
    const body = new Uint8Array(4);
    let p = writeVi64(0n, body, 0);   // requestId
    p += writeVi64(9n, body, p);      // fetchType 0x9 (invalid)
    p += writeVi64(0n, body, p);      // params count 0
    const frame = new Uint8Array(3 + p);
    frame[0] = 0x16;
    frame[1] = (p >> 8) & 0xff;
    frame[2] = p & 0xff;
    frame.set(body.subarray(0, p), 3);
    expect(() => codec18.decode(frame, 0)).toThrow(/Fetch Type/i);
  });

  it('rejects a FETCH with trailing bytes after parameters', () => {
    const fetch: Fetch = {
      type: 'FETCH', requestId: 1n,
      fetch: { fetchType: 0x2, joiningRequestId: 0n, joiningStart: varint(0n) },
      parameters: new Map(),
    };
    const good = codec18.encode(fetch);
    const tampered = new Uint8Array(good.length + 1);
    tampered.set(good, 0);
    tampered[2] = good[2]! + 1; // bump framed Length by 1
    tampered[good.length] = 0xff;
    expect(() => codec18.decode(tampered, 0)).toThrow(/trailing/i);
  });
});

describe('FETCH_OK round-trip (response omits Request ID, §10.13)', () => {
  it('decodes with requestId === undefined; round-trips endOfTrack + endLocation', () => {
    const ok: FetchOk = {
      type: 'FETCH_OK', requestId: 0n, endOfTrack: 1,
      endLocation: { group: 7n, object: 3n },
      parameters: new Map([[MessageParam.SUBSCRIBER_PRIORITY, [varint(5n)]]]),
      trackExtensions: new Map(),
    };
    const bytes = codec18.encode(ok);
    expect(bytes[0]).toBe(0x18); // FETCH_OK type
    const { message } = codec18.decode(bytes, 0);
    expect(message.type).toBe('FETCH_OK');
    expect((message as { requestId?: bigint }).requestId).toBeUndefined();
    const m = message as FetchOk;
    expect(m.endOfTrack).toBe(1);
    expect(m.endLocation).toEqual({ group: 7n, object: 3n });
    expect(m.parameters.get(MessageParam.SUBSCRIBER_PRIORITY)).toEqual([5n]);
  });

  it('endLocation above the QUIC range round-trips (vi64, no cap)', () => {
    const big = 1n << 63n;
    const ok: FetchOk = {
      type: 'FETCH_OK', requestId: 0n, endOfTrack: 0,
      endLocation: { group: big, object: big },
      parameters: new Map(), trackExtensions: new Map(),
    };
    const { message } = codec18.decode(codec18.encode(ok), 0);
    expect((message as FetchOk).endLocation).toEqual({ group: big, object: big });
  });

  it('round-trips FETCH_OK with non-empty Track Properties', () => {
    const ok: FetchOk = {
      type: 'FETCH_OK', requestId: 0n, endOfTrack: 0,
      endLocation: { group: 0n, object: 0n },
      parameters: new Map(),
      // even Type 0x40 → vi64 value; odd Type 0x41 → bytes value.
      trackExtensions: new Map<bigint, (bigint | Uint8Array)[]>([
        [0x40n, [9n]], [0x41n, [new Uint8Array([0xab])]],
      ]) as never,
    };
    const { message } = codec18.decode(codec18.encode(ok), 0);
    const props = (message as FetchOk).trackExtensions as never as Map<bigint, (bigint | Uint8Array)[]>;
    expect(props.get(0x40n)).toEqual([9n]);
    expect(props.get(0x41n)).toEqual([new Uint8Array([0xab])]);
  });

  it('rejects encoding FETCH_OK with End Of Track other than 0 or 1', () => {
    const ok: FetchOk = {
      type: 'FETCH_OK', requestId: 0n, endOfTrack: 2 as never,
      endLocation: { group: 0n, object: 0n }, parameters: new Map(), trackExtensions: new Map(),
    };
    expect(() => codec18.encode(ok)).toThrow(/End Of Track/i);
  });

  it('rejects decoding FETCH_OK with End Of Track other than 0 or 1', () => {
    // Hand-build a FETCH_OK frame with End Of Track = 2.
    const body = new Uint8Array(5);
    let p = 0;
    body[p++] = 2; // endOfTrack (invalid)
    p += writeVi64(0n, body, p); // endLocation.group
    p += writeVi64(0n, body, p); // endLocation.object
    p += writeVi64(0n, body, p); // params count 0
    const frame = new Uint8Array(3 + p);
    frame[0] = 0x18;
    frame[1] = (p >> 8) & 0xff;
    frame[2] = p & 0xff;
    frame.set(body.subarray(0, p), 3);
    expect(() => codec18.decode(frame, 0)).toThrow(/End Of Track/i);
  });
});

describe('TRACK_STATUS round-trip (request keeps Request ID, §10.14)', () => {
  it('round-trips with the same body as SUBSCRIBE (namespace tuple + name + params)', () => {
    const ts: TrackStatus = {
      type: 'TRACK_STATUS',
      requestId: 5n,
      trackNamespace: NS,
      trackName: NAME,
      parameters: new Map(),
    };
    const bytes = codec18.encode(ts);
    expect(bytes[0]).toBe(0x0d); // TRACK_STATUS type
    const { message, bytesRead } = codec18.decode(bytes, 0);
    expect(bytesRead).toBe(bytes.length);
    const m = message as TrackStatus;
    expect(m.type).toBe('TRACK_STATUS');
    expect(m.requestId).toBe(5n);
    expect(m.trackNamespace.map(hex)).toEqual(NS.map(hex));
    expect(hex(m.trackName)).toBe(hex(NAME));
  });

  it('a request ID above the QUIC range round-trips on draft-18', () => {
    const big = 1n << 63n;
    const ts: TrackStatus = {
      type: 'TRACK_STATUS', requestId: big, trackNamespace: NS, trackName: NAME, parameters: new Map(),
    };
    const { message } = codec18.decode(codec18.encode(ts), 0);
    expect((message as TrackStatus).requestId).toBe(big);
  });

  it('rejects a TRACK_STATUS with trailing bytes after parameters', () => {
    const ts: TrackStatus = {
      type: 'TRACK_STATUS', requestId: 1n, trackNamespace: NS, trackName: NAME, parameters: new Map(),
    };
    const good = codec18.encode(ts);
    const tampered = new Uint8Array(good.length + 1);
    tampered.set(good, 0);
    tampered[2] = good[2]! + 1; // bump framed Length by 1
    tampered[good.length] = 0xff;
    expect(() => codec18.decode(tampered, 0)).toThrow(/trailing/i);
  });
});

describe('PUBLISH_NAMESPACE round-trip (request keeps Request ID, §10.15)', () => {
  it('round-trips Request ID + namespace tuple + params (no track name)', () => {
    const pn: PublishNamespace = {
      type: 'PUBLISH_NAMESPACE',
      requestId: 5n,
      trackNamespace: NS,
      parameters: new Map(),
    };
    const bytes = codec18.encode(pn);
    expect(bytes[0]).toBe(0x06); // PUBLISH_NAMESPACE type
    const { message, bytesRead } = codec18.decode(bytes, 0);
    expect(bytesRead).toBe(bytes.length);
    const m = message as PublishNamespace;
    expect(m.type).toBe('PUBLISH_NAMESPACE');
    expect(m.requestId).toBe(5n);
    expect(m.trackNamespace.map(hex)).toEqual(NS.map(hex));
  });

  it('a request ID above the QUIC range round-trips on draft-18', () => {
    const big = 1n << 63n;
    const pn: PublishNamespace = {
      type: 'PUBLISH_NAMESPACE', requestId: big, trackNamespace: NS, parameters: new Map(),
    };
    const { message } = codec18.decode(codec18.encode(pn), 0);
    expect((message as PublishNamespace).requestId).toBe(big);
  });

  it('rejects a PUBLISH_NAMESPACE with trailing bytes after parameters', () => {
    const pn: PublishNamespace = {
      type: 'PUBLISH_NAMESPACE', requestId: 1n, trackNamespace: NS, parameters: new Map(),
    };
    const good = codec18.encode(pn);
    const tampered = new Uint8Array(good.length + 1);
    tampered.set(good, 0);
    tampered[2] = good[2]! + 1;
    tampered[good.length] = 0xff;
    expect(() => codec18.decode(tampered, 0)).toThrow(/trailing/i);
  });

  it('decodes Track Properties on a REQUEST_OK regardless of context — the SESSION enforces validity', () => {
    // The codec is context-free: it cannot know whether this REQUEST_OK answers a
    // TRACK_STATUS (properties valid) or a PUBLISH_NAMESPACE (properties invalid).
    // It decodes them; the request-stream context decides legality in the session.
    const ok: RequestOk = {
      type: 'REQUEST_OK', requestId: 0n, parameters: new Map(),
      trackExtensions: new Map([[0x02n, [7n]]]) as never,
    };
    const { message } = codec18.decode(codec18.encode(ok), 0);
    expect((message as RequestOk).trackExtensions?.get(0x02n as never)).toEqual([7n]);
  });

  it('refuses to encode PUBLISH_NAMESPACE_DONE — removed in draft-18 (§3.3.2)', () => {
    // Withdrawal is a request-stream cancellation; the message has no wire form.
    expect(() => codec18.encode({ type: 'PUBLISH_NAMESPACE_DONE', requestId: 1n } as never))
      .toThrow(/removed in draft-18/i);
  });
});

describe('SUBSCRIBE_NAMESPACE + NAMESPACE/NAMESPACE_DONE (§10.16–10.18)', () => {
  const SUFFIX = [new Uint8Array([0x73, 0x31])]; // "s1"

  it('SUBSCRIBE_NAMESPACE round-trips Request ID + prefix tuple + params', () => {
    const sn: SubscribeNamespace = {
      type: 'SUBSCRIBE_NAMESPACE', requestId: 4n, trackNamespacePrefix: NS, parameters: new Map(),
    };
    const bytes = codec18.encode(sn);
    expect(bytes[0]).toBe(0x50); // SUBSCRIBE_NAMESPACE type
    const { message, bytesRead } = codec18.decode(bytes, 0);
    expect(bytesRead).toBe(bytes.length);
    const m = message as SubscribeNamespace;
    expect(m.type).toBe('SUBSCRIBE_NAMESPACE');
    expect(m.requestId).toBe(4n);
    expect(m.trackNamespacePrefix.map(hex)).toEqual(NS.map(hex));
  });

  it('allows a zero-element namespace prefix', () => {
    const sn: SubscribeNamespace = {
      type: 'SUBSCRIBE_NAMESPACE', requestId: 1n, trackNamespacePrefix: [], parameters: new Map(),
    };
    const { message } = codec18.decode(codec18.encode(sn), 0);
    expect((message as SubscribeNamespace).trackNamespacePrefix).toEqual([]);
  });

  it('NAMESPACE round-trips a suffix tuple (type 0x08, no Request ID)', () => {
    const n: Namespace = { type: 'NAMESPACE', trackNamespaceSuffix: SUFFIX };
    const bytes = codec18.encode(n);
    expect(bytes[0]).toBe(0x08);
    const { message } = codec18.decode(bytes, 0);
    const m = message as Namespace;
    expect(m.type).toBe('NAMESPACE');
    expect(m.trackNamespaceSuffix.map(hex)).toEqual(SUFFIX.map(hex));
    expect((m as { requestId?: bigint }).requestId).toBeUndefined();
  });

  it('NAMESPACE_DONE round-trips a suffix tuple (type 0x0E)', () => {
    const nd: NamespaceDone = { type: 'NAMESPACE_DONE', trackNamespaceSuffix: SUFFIX };
    const bytes = codec18.encode(nd);
    expect(bytes[0]).toBe(0x0e);
    const { message } = codec18.decode(bytes, 0);
    expect((message as NamespaceDone).type).toBe('NAMESPACE_DONE');
    expect((message as NamespaceDone).trackNamespaceSuffix.map(hex)).toEqual(SUFFIX.map(hex));
  });

  it('rejects a NAMESPACE with trailing bytes after the suffix', () => {
    const n: Namespace = { type: 'NAMESPACE', trackNamespaceSuffix: SUFFIX };
    const good = codec18.encode(n);
    const tampered = new Uint8Array(good.length + 1);
    tampered.set(good, 0);
    tampered[2] = good[2]! + 1;
    tampered[good.length] = 0xff;
    expect(() => codec18.decode(tampered, 0)).toThrow(/trailing/i);
  });
});

describe('SUBSCRIBE_TRACKS + PUBLISH_BLOCKED (§10.19–10.20)', () => {
  const SUFFIX = [new Uint8Array([0x73, 0x31])]; // "s1"

  it('SUBSCRIBE_TRACKS round-trips Request ID + prefix tuple + params (type 0x51)', () => {
    const st: SubscribeTracks = {
      type: 'SUBSCRIBE_TRACKS', requestId: 6n, trackNamespacePrefix: NS, parameters: new Map(),
    };
    const bytes = codec18.encode(st);
    expect(bytes[0]).toBe(0x51);
    const { message, bytesRead } = codec18.decode(bytes, 0);
    expect(bytesRead).toBe(bytes.length);
    const m = message as SubscribeTracks;
    expect(m.type).toBe('SUBSCRIBE_TRACKS');
    expect(m.requestId).toBe(6n);
    expect(m.trackNamespacePrefix.map(hex)).toEqual(NS.map(hex));
  });

  it('allows a zero-element SUBSCRIBE_TRACKS prefix', () => {
    const st: SubscribeTracks = {
      type: 'SUBSCRIBE_TRACKS', requestId: 0n, trackNamespacePrefix: [], parameters: new Map(),
    };
    const { message } = codec18.decode(codec18.encode(st), 0);
    expect((message as SubscribeTracks).trackNamespacePrefix).toEqual([]);
  });

  it('PUBLISH_BLOCKED round-trips suffix tuple + track name (type 0x0F, no Request ID)', () => {
    const pb: PublishBlocked = {
      type: 'PUBLISH_BLOCKED', trackNamespaceSuffix: SUFFIX, trackName: NAME,
    };
    const bytes = codec18.encode(pb);
    expect(bytes[0]).toBe(0x0f);
    const { message } = codec18.decode(bytes, 0);
    const m = message as PublishBlocked;
    expect(m.type).toBe('PUBLISH_BLOCKED');
    expect(m.trackNamespaceSuffix.map(hex)).toEqual(SUFFIX.map(hex));
    expect(hex(m.trackName)).toBe(hex(NAME));
    expect((m as { requestId?: bigint }).requestId).toBeUndefined();
  });

  it('rejects a PUBLISH_BLOCKED with trailing bytes after the track name', () => {
    const pb: PublishBlocked = { type: 'PUBLISH_BLOCKED', trackNamespaceSuffix: SUFFIX, trackName: NAME };
    const good = codec18.encode(pb);
    const tampered = new Uint8Array(good.length + 1);
    tampered.set(good, 0);
    tampered[2] = good[2]! + 1;
    tampered[good.length] = 0xff;
    expect(() => codec18.decode(tampered, 0)).toThrow(/trailing/i);
  });
});

describe('PUBLISH round-trip (request keeps Request ID, §10.10)', () => {
  it('round-trips Request ID + namespace + name + Track Alias + params (type 0x1D)', () => {
    const pub: Publish = {
      type: 'PUBLISH', requestId: 7n, trackNamespace: NS, trackName: NAME, trackAlias: 42n,
      parameters: new Map([[MessageParam.SUBSCRIBER_PRIORITY, [varint(3n)]]]),
      trackExtensions: new Map(),
    };
    const bytes = codec18.encode(pub);
    expect(bytes[0]).toBe(0x1d);
    const { message, bytesRead } = codec18.decode(bytes, 0);
    expect(bytesRead).toBe(bytes.length);
    const m = message as Publish;
    expect(m.type).toBe('PUBLISH');
    expect(m.requestId).toBe(7n);
    expect(m.trackNamespace.map(hex)).toEqual(NS.map(hex));
    expect(hex(m.trackName)).toBe(hex(NAME));
    expect(m.trackAlias).toBe(42n);
    expect(m.parameters.get(MessageParam.SUBSCRIBER_PRIORITY)).toEqual([3n]);
  });

  it('requestId and trackAlias above the QUIC range round-trip (vi64)', () => {
    const big = 1n << 63n;
    const pub: Publish = {
      type: 'PUBLISH', requestId: big, trackNamespace: NS, trackName: NAME, trackAlias: big + 1n,
      parameters: new Map(), trackExtensions: new Map(),
    };
    const { message } = codec18.decode(codec18.encode(pub), 0);
    expect((message as Publish).requestId).toBe(big);
    expect((message as Publish).trackAlias).toBe(big + 1n);
  });

  it('round-trips PUBLISH with non-empty Track Properties', () => {
    const pub: Publish = {
      type: 'PUBLISH', requestId: 1n, trackNamespace: NS, trackName: NAME, trackAlias: 1n,
      parameters: new Map(),
      // even Type 0x40 → vi64 value; odd Type 0x41 → bytes value; full-uint64 value.
      trackExtensions: new Map<bigint, (bigint | Uint8Array)[]>([
        [0x40n, [1n << 63n]], [0x41n, [new Uint8Array([0x01, 0x02])]],
      ]) as never,
    };
    const { message } = codec18.decode(codec18.encode(pub), 0);
    const props = (message as Publish).trackExtensions as never as Map<bigint, (bigint | Uint8Array)[]>;
    expect(props.get(0x40n)).toEqual([1n << 63n]);
    expect(props.get(0x41n)).toEqual([new Uint8Array([0x01, 0x02])]);
  });
});

describe('PUBLISH_DONE round-trip (response on PUBLISH stream, §10.11)', () => {
  it('round-trips Status Code + Stream Count + Reason; decodes without Request ID', () => {
    const pd: PublishDone = {
      type: 'PUBLISH_DONE', requestId: 0n, statusCode: varint(3n), streamCount: varint(5n), errorReason: 'bye',
    };
    const bytes = codec18.encode(pd);
    expect(bytes[0]).toBe(0x0b);
    const { message, bytesRead } = codec18.decode(bytes, 0);
    expect(bytesRead).toBe(bytes.length);
    expect(message.type).toBe('PUBLISH_DONE');
    expect((message as { requestId?: bigint }).requestId).toBeUndefined();
    const m = message as PublishDone;
    expect(m.statusCode).toBe(3n);
    expect(m.streamCount).toBe(5n);
    expect(m.errorReason).toBe('bye');
  });

  it('rejects PUBLISH_DONE with trailing bytes after the reason', () => {
    const pd: PublishDone = { type: 'PUBLISH_DONE', requestId: 0n, statusCode: varint(0n), streamCount: varint(0n), errorReason: '' };
    const good = codec18.encode(pd);
    const tampered = new Uint8Array(good.length + 1);
    tampered.set(good, 0);
    tampered[2] = good[2]! + 1;
    tampered[good.length] = 0xff;
    expect(() => codec18.decode(tampered, 0)).toThrow(/trailing/i);
  });

  it('round-trips Status Code + Stream Count above the QUIC range (vi64) byte-identically', () => {
    // Slice 2: draft-18 PUBLISH_DONE Status Code and Stream Count are vi64, so a
    // value above 2^62-1 must survive encode→decode and re-encode byte-identically.
    const big = 1n << 63n; // > 2^62-1
    const pd: PublishDone = {
      type: 'PUBLISH_DONE', requestId: 0n, statusCode: big, streamCount: big + 1n, errorReason: 'gone',
    };
    const bytes = codec18.encode(pd);
    const { message, bytesRead } = codec18.decode(bytes, 0);
    expect(bytesRead).toBe(bytes.length);
    const m = message as PublishDone;
    expect(m.statusCode).toBe(big);
    expect(m.streamCount).toBe(big + 1n);
    expect(m.errorReason).toBe('gone');
    // Re-encode must reproduce the exact wire bytes (no truncation / re-cap).
    expect(codec18.encode({ ...m, requestId: 0n })).toEqual(bytes);
  });
});

describe('draft-14/16 PUBLISH_DONE still reject above-QUIC Status/Stream values', () => {
  const big = 1n << 63n; // > 2^62-1: valid vi64, invalid QUIC varint
  for (const v of [14, 16] as const) {
    it(`draft-${v} throws encoding a PUBLISH_DONE statusCode above the QUIC range`, () => {
      const pd: PublishDone = {
        type: 'PUBLISH_DONE', requestId: 0n, statusCode: big, streamCount: 0n, errorReason: '',
      };
      expect(() => createControlCodec(v).encode(pd)).toThrow(RangeError);
    });
    it(`draft-${v} throws encoding a PUBLISH_DONE streamCount above the QUIC range`, () => {
      const pd: PublishDone = {
        type: 'PUBLISH_DONE', requestId: 0n, statusCode: 0n, streamCount: big, errorReason: '',
      };
      expect(() => createControlCodec(v).encode(pd)).toThrow(RangeError);
    });
  }
});

describe('GOAWAY round-trip (§10.4)', () => {
  it('control-stream form: empty URI + timeout + Request ID round-trips', () => {
    const g: Goaway = { type: 'GOAWAY', newSessionUri: '', timeout: 5000n, requestId: 4n };
    const bytes = codec18.encode(g);
    expect(bytes[0]).toBe(0x10); // GOAWAY type
    const { message, bytesRead } = codec18.decode(bytes, 0);
    expect(bytesRead).toBe(bytes.length);
    const m = message as Goaway;
    expect(m.type).toBe('GOAWAY');
    expect(m.newSessionUri).toBe('');
    expect(m.timeout).toBe(5000n);
    expect(m.requestId).toBe(4n);
  });
  it('control-stream form: non-empty URI + timeout + Request ID round-trips', () => {
    const g: Goaway = { type: 'GOAWAY', newSessionUri: 'https://relay.example/moq', timeout: 1n, requestId: 7n };
    const m = codec18.decode(codec18.encode(g), 0).message as Goaway;
    expect(m.newSessionUri).toBe('https://relay.example/moq');
    expect(m.timeout).toBe(1n);
    expect(m.requestId).toBe(7n);
  });
  it('request-stream form: URI + timeout with NO Request ID decodes with requestId === undefined', () => {
    const g: Goaway = { type: 'GOAWAY', newSessionUri: '', timeout: 0n }; // no requestId
    const m = codec18.decode(codec18.encode(g), 0).message as Goaway;
    expect(m.timeout).toBe(0n);
    expect(m.requestId).toBeUndefined();
  });
  it('round-trips a full-uint64 Timeout and Request ID', () => {
    const big = (1n << 64n) - 1n; // 2^64 - 1
    const g: Goaway = { type: 'GOAWAY', newSessionUri: 'x', timeout: big, requestId: big };
    const m = codec18.decode(codec18.encode(g), 0).message as Goaway;
    expect(m.timeout).toBe(big);
    expect(m.requestId).toBe(big);
  });
  it('rejects encoding a New Session URI longer than 8192 bytes', () => {
    const g: Goaway = { type: 'GOAWAY', newSessionUri: 'a'.repeat(8193), timeout: 0n };
    expect(() => codec18.encode(g)).toThrow(/8192/);
  });
  it('rejects decoding a GOAWAY whose URI length exceeds 8192', () => {
    const uriLen = 8193;
    const head = new Uint8Array(9);
    const n = writeVi64(BigInt(uriLen), head, 0);
    const payload = new Uint8Array(n + uriLen + 1); // + Timeout vi64(0) = one 0x00 byte
    payload.set(head.subarray(0, n), 0);
    expect(() => codec18.decode(frame18(0x10, payload), 0)).toThrow(/8192/);
  });
  it('rejects trailing bytes after the optional Request ID', () => {
    const g: Goaway = { type: 'GOAWAY', newSessionUri: '', timeout: 1n, requestId: 2n };
    const good = codec18.encode(g);
    const tampered = new Uint8Array(good.length + 1);
    tampered.set(good, 0);
    tampered[2] = good[2]! + 1; // grow the uint16 frame length to include the junk byte
    tampered[good.length] = 0xff;
    expect(() => codec18.decode(tampered, 0)).toThrow(/trailing/i);
  });
  it('draft-16 GOAWAY stays URI-only (legacy behavior unchanged)', () => {
    const g: Goaway = { type: 'GOAWAY', newSessionUri: 'https://r.example' };
    const m = createControlCodec(16).decode(createControlCodec(16).encode(g), 0).message as Goaway;
    expect(m.newSessionUri).toBe('https://r.example');
    expect(m.timeout).toBeUndefined();
    expect(m.requestId).toBeUndefined();
  });
});

describe('draft-18 Reason Phrase max length (1024 bytes, §1.4.2)', () => {
  const reqError = (reason: string): RequestErrorMsg =>
    ({ type: 'REQUEST_ERROR', requestId: 0n, errorCode: varint(1n), retryInterval: varint(0n), errorReason: reason });
  const publishDone = (reason: string): PublishDone =>
    ({ type: 'PUBLISH_DONE', requestId: 0n, statusCode: 0n, streamCount: 0n, errorReason: reason } as PublishDone);
  // A REQUEST_ERROR frame whose Reason Phrase Length field is `reasonLen` (errorCode
  // 1 = non-REDIRECT, retryInterval 0), to exercise the DECODE-side guard.
  function reqErrorReasonFrame(reasonLen: number): Uint8Array {
    const head = new Uint8Array(16);
    let p = writeVi64(1n, head, 0);             // errorCode
    p += writeVi64(0n, head, p);                // retryInterval
    p += writeVi64(BigInt(reasonLen), head, p); // Reason Phrase Length
    const payload = new Uint8Array(p + reasonLen);
    payload.set(head.subarray(0, p), 0);
    return frame18(0x05, payload);              // 0x05 = REQUEST_ERROR
  }

  it('encodes a 1024-byte REQUEST_ERROR reason but rejects 1025', () => {
    expect(() => codec18.encode(reqError('a'.repeat(1024)))).not.toThrow();
    expect(() => codec18.encode(reqError('a'.repeat(1025)))).toThrow(/1024/);
  });
  it('encodes a 1024-byte PUBLISH_DONE reason but rejects 1025', () => {
    expect(() => codec18.encode(publishDone('a'.repeat(1024)))).not.toThrow();
    expect(() => codec18.encode(publishDone('a'.repeat(1025)))).toThrow(/1024/);
  });
  it('decodes a 1024-byte reason but rejects a Reason Phrase Length of 1025', () => {
    expect(() => codec18.decode(reqErrorReasonFrame(1024), 0)).not.toThrow();
    expect(() => codec18.decode(reqErrorReasonFrame(1025), 0)).toThrow(/1024/);
  });
});

describe('unsupported draft-18 messages throw clearly', () => {
  it('throws "not implemented" for an unhandled type (MAX_REQUEST_ID has no draft-18 form)', () => {
    // draft-18 has no MAX_REQUEST_ID (request flow control is QUIC stream limits),
    // so encoding it on the draft-18 codec is an explicit "not implemented".
    expect(() => codec18.encode({ type: 'MAX_REQUEST_ID', maxRequestId: varint(1n) } as never)).toThrow(/not.*implement/i);
  });

  it('does NOT decode a 0x1E frame as draft-18 PUBLISH_OK (removed; REQUEST_OK 0x07 is the shorthand)', () => {
    // draft-14/16 PUBLISH_OK is wire type 0x1E, but draft-18 removed it (§10.5 /
    // changelog) — a PUBLISH is accepted with REQUEST_OK (0x07). A 0x1E on a
    // draft-18 control stream is therefore an unknown type, not a PUBLISH_OK.
    const frame = frame18(0x1e, new Uint8Array(0)); // type 0x1E, empty payload
    expect(() => codec18.decode(frame, 0)).toThrow(/not.*implement|0x1e/i);
  });
});

describe('draft-14/16 still reject out-of-range values', () => {
  it('draft-16 throws encoding a SUBSCRIBE requestId above the QUIC range', () => {
    const sub: Subscribe = {
      type: 'SUBSCRIBE', requestId: 1n << 63n, trackNamespace: NS, trackName: NAME, parameters: new Map(),
    };
    expect(() => createControlCodec(16).encode(sub)).toThrow(RangeError);
  });

  it('draft-16 throws encoding a standalone FETCH Location above the QUIC range', () => {
    const fetch: Fetch = {
      type: 'FETCH', requestId: 0n,
      fetch: {
        fetchType: 0x1, trackNamespace: NS, trackName: NAME,
        startLocation: { group: 0n, object: 0n },
        endLocation: { group: 1n << 63n, object: 0n },
      },
      parameters: new Map(),
    };
    expect(() => createControlCodec(16).encode(fetch)).toThrow(RangeError);
  });

  it('draft-16 throws encoding a joining FETCH joiningStart above the QUIC range', () => {
    const fetch: Fetch = {
      type: 'FETCH', requestId: 0n,
      fetch: { fetchType: 0x2, joiningRequestId: 0n, joiningStart: 1n << 63n },
      parameters: new Map(),
    };
    expect(() => createControlCodec(16).encode(fetch)).toThrow(RangeError);
  });

  it('draft-16 throws encoding a KVP message parameter value above the QUIC range', () => {
    // The semantic ParameterValue union widened to raw bigint for draft-18 vi64,
    // but the draft-14/16 KVP writer (writeVarint / varintEncodingLength) remains
    // the guardrail — an above-QUIC parameter integer must NOT silently truncate.
    const sub: Subscribe = {
      type: 'SUBSCRIBE', requestId: 0n, trackNamespace: NS, trackName: NAME,
      parameters: new Map([[MessageParam.EXPIRES, [1n << 63n]]]),
    };
    expect(() => createControlCodec(16).encode(sub)).toThrow(RangeError);
  });
});

describe('Track Properties semantics propagate through full message decode', () => {
  // Encode a message carrying a VALID single-byte known property, then flip the
  // final byte(s) so the property becomes invalid, and confirm decode rejects it.
  it('SUBSCRIBE_OK with an invalid DEFAULT_PUBLISHER_GROUP_ORDER is rejected', () => {
    const ok: SubscribeOk = {
      type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: varint(9n), parameters: new Map(),
      trackExtensions: new Map([[0x22n, [1n]]]) as never, // group order 1 (valid)
    };
    const bytes = codec18.encode(ok);
    bytes[bytes.length - 1] = 0x03; // value 1 → 3 (invalid)
    expect(() => codec18.decode(bytes, 0)).toThrow(/1 or 2/);
  });

  it('PUBLISH with an invalid DYNAMIC_GROUPS is rejected', () => {
    const pub: Publish = {
      type: 'PUBLISH', requestId: 1n, trackNamespace: NS, trackName: NAME, trackAlias: 1n,
      parameters: new Map(),
      trackExtensions: new Map([[0x30n, [1n]]]) as never, // dynamic groups 1 (valid)
    };
    const bytes = codec18.encode(pub);
    bytes[bytes.length - 1] = 0x02; // value 1 → 2 (invalid)
    expect(() => codec18.decode(bytes, 0)).toThrow(/0 or 1/);
  });

  it('FETCH_OK carrying an Object-only Property DECODES at the codec (malformed-track is semantic, not a codec error)', () => {
    const ok: FetchOk = {
      type: 'FETCH_OK', requestId: 0n, endOfTrack: 0, endLocation: { group: 0n, object: 0n },
      parameters: new Map(),
      trackExtensions: new Map([[0x3cn, [1n]]]) as never, // Object-only Property
    };
    const { message } = codec18.decode(codec18.encode(ok), 0);
    const props = (message as FetchOk).trackExtensions as never as Map<bigint, (bigint | Uint8Array)[]>;
    expect(props.get(0x3cn)).toEqual([1n]); // parsed, not rejected
  });

  it('TRACK_STATUS_OK (REQUEST_OK) with an invalid known property is still rejected', () => {
    const ok: RequestOk = {
      type: 'REQUEST_OK', requestId: 0n, parameters: new Map(),
      trackExtensions: new Map([[0x22n, [1n]]]) as never, // group order 1 (valid)
    };
    const bytes = codec18.encode(ok);
    bytes[bytes.length - 1] = 0x00; // value 1 → 0 (invalid: must be 1 or 2)
    expect(() => codec18.decode(bytes, 0)).toThrow(/1 or 2/);
  });
});

describe('REQUEST_ERROR Redirect (§10.6.2)', () => {
  const URI = new TextEncoder().encode('https://relay.example/moq');

  it('round-trips a REQUEST_ERROR WITHOUT a Redirect (non-REDIRECT error code)', () => {
    const err: RequestErrorMsg = {
      type: 'REQUEST_ERROR', requestId: 0n, errorCode: varint(0x1n), retryInterval: varint(0n), errorReason: 'x',
    };
    const { message } = codec18.decode(codec18.encode(err), 0);
    expect((message as RequestErrorMsg).redirect).toBeUndefined();
  });

  it('round-trips REDIRECT with a URI + replacement Full Track Name', () => {
    const err: RequestErrorMsg = {
      type: 'REQUEST_ERROR', requestId: 0n, errorCode: varint(0x34n), retryInterval: varint(5n), errorReason: 'moved',
      redirect: { connectUri: URI, trackNamespace: NS, trackName: NAME },
    };
    const bytes = codec18.encode(err);
    expect(bytes[0]).toBe(0x05); // REQUEST_ERROR wire type
    const { message, bytesRead } = codec18.decode(bytes, 0);
    expect(bytesRead).toBe(bytes.length);
    const m = message as RequestErrorMsg;
    expect(m.errorCode).toBe(0x34n);
    expect(m.redirect).toBeDefined();
    expect(hex(m.redirect!.connectUri)).toBe(hex(URI));
    expect(m.redirect!.trackNamespace.map(hex)).toEqual(NS.map(hex));
    expect(hex(m.redirect!.trackName)).toBe(hex(NAME));
  });

  it('round-trips REDIRECT with zero URI and zero namespace/name (same session / same track)', () => {
    const err: RequestErrorMsg = {
      type: 'REQUEST_ERROR', requestId: 0n, errorCode: varint(0x34n), retryInterval: varint(0n), errorReason: '',
      redirect: { connectUri: new Uint8Array(0), trackNamespace: [], trackName: new Uint8Array(0) },
    };
    const { message } = codec18.decode(codec18.encode(err), 0);
    const r = (message as RequestErrorMsg).redirect!;
    expect(r.connectUri.length).toBe(0);
    expect(r.trackNamespace).toEqual([]);
    expect(r.trackName.length).toBe(0);
  });

  it('rejects encoding a Redirect with a non-REDIRECT error code', () => {
    const err: RequestErrorMsg = {
      type: 'REQUEST_ERROR', requestId: 0n, errorCode: varint(0x1n), retryInterval: varint(0n), errorReason: '',
      redirect: { connectUri: URI, trackNamespace: NS, trackName: NAME },
    };
    expect(() => codec18.encode(err)).toThrow(/not REDIRECT/i);
  });

  it('rejects encoding REDIRECT without a Redirect structure', () => {
    const err: RequestErrorMsg = {
      type: 'REQUEST_ERROR', requestId: 0n, errorCode: varint(0x34n), retryInterval: varint(0n), errorReason: '',
    };
    expect(() => codec18.encode(err)).toThrow(/requires a Redirect/i);
  });

  it('rejects REDIRECT with a missing / truncated Redirect on decode', () => {
    // REQUEST_ERROR header (errorCode 0x34, retry 0, empty reason) with NO Redirect bytes.
    const payload = new Uint8Array(8);
    let p = writeVi64(0x34n, payload, 0);
    p += writeVi64(0n, payload, p);
    p += writeVi64(0n, payload, p); // empty reason phrase (length 0)
    const framed = frame18(0x05, payload.subarray(0, p));
    expect(() => codec18.decode(framed, 0)).toThrow();
  });

  it('rejects trailing bytes after the Track Name in a Redirect', () => {
    const err: RequestErrorMsg = {
      type: 'REQUEST_ERROR', requestId: 0n, errorCode: varint(0x34n), retryInterval: varint(0n), errorReason: '',
      redirect: { connectUri: new Uint8Array(0), trackNamespace: [], trackName: new Uint8Array(0) },
    };
    expect(() => codec18.decode(withTrailingByte(codec18.encode(err)), 0)).toThrow(/trailing/i);
  });

  it('rejects a Redirect namespace with more than 32 fields (size limit still applies)', () => {
    const tooMany = Array.from({ length: 33 }, (_, i) => new Uint8Array([0x61 + (i % 26)]));
    const err: RequestErrorMsg = {
      type: 'REQUEST_ERROR', requestId: 0n, errorCode: varint(0x34n), retryInterval: varint(0n), errorReason: '',
      redirect: { connectUri: new Uint8Array(0), trackNamespace: tooMany, trackName: new Uint8Array(0) },
    };
    expect(() => codec18.encode(err)).toThrow(/maximum is 32|fields/i);
  });
});

describe('Track Properties naming (draft-18 trackProperties; trackExtensions deprecated alias)', () => {
  it('a decoded draft-18 SUBSCRIBE_OK exposes trackProperties AND the deprecated trackExtensions alias', () => {
    const ok: SubscribeOk = {
      type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: varint(9n), parameters: new Map(),
      trackProperties: new Map([[0x02n, [5n]]]) as never,
    };
    const { message } = codec18.decode(codec18.encode(ok), 0);
    const m = message as SubscribeOk;
    expect(m.trackProperties?.get(0x02n as never)).toEqual([5n]);
    expect(m.trackExtensions?.get(0x02n as never)).toEqual([5n]); // back-compat alias still populated
  });

  it('encoding via the deprecated trackExtensions field is byte-for-byte identical to trackProperties', () => {
    const viaNew = codec18.encode({
      type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: varint(9n), parameters: new Map(),
      trackProperties: new Map([[0x02n, [5n]]]),
    } as never);
    const viaOld = codec18.encode({
      type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: varint(9n), parameters: new Map(),
      trackExtensions: new Map([[0x02n, [5n]]]),
    } as never);
    expect([...viaNew]).toEqual([...viaOld]); // codec output unchanged by the rename
  });

  it('PUBLISH and FETCH_OK also expose trackProperties on decode', () => {
    const pub = codec18.decode(codec18.encode({
      type: 'PUBLISH', requestId: 1n, trackNamespace: NS, trackName: NAME, trackAlias: 1n,
      parameters: new Map(), trackProperties: new Map([[0x02n, [7n]]]),
    } as never), 0).message as Publish;
    expect(pub.trackProperties?.get(0x02n as never)).toEqual([7n]);

    const fok = codec18.decode(codec18.encode({
      type: 'FETCH_OK', requestId: 0n, endOfTrack: 0, endLocation: { group: 0n, object: 0n },
      parameters: new Map(), trackProperties: new Map([[0x02n, [9n]]]),
    } as never), 0).message as FetchOk;
    expect(fok.trackProperties?.get(0x02n as never)).toEqual([9n]);
  });
});

describe('Track Properties type is vi64-wide (full uint64, no casts)', () => {
  it('a SUBSCRIBE_OK Track Property carries a full-uint64 value with no `as never` cast', () => {
    const big = 1n << 63n; // above the QUIC-Varint range
    const ok: SubscribeOk = {
      type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: varint(9n), parameters: new Map(),
      trackProperties: new Map([[0x02n, [big]]]), // bigint key + bigint value, accepted directly
    };
    const { message } = codec18.decode(codec18.encode(ok), 0);
    expect((message as SubscribeOk).trackProperties?.get(0x02n)).toEqual([big]);
  });
});

describe('draft-18 Track Namespace / Full Track Name validation (§2.4.1)', () => {
  // Low-level frame builders so we can inject namespaces the ENCODE path now rejects.
  const v = (n: bigint | number): Uint8Array => {
    const b = new Uint8Array(vi64EncodingLength(BigInt(n)));
    writeVi64(BigInt(n), b, 0);
    return b;
  };
  const cat = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  const lenBytes = (b: Uint8Array): Uint8Array => cat(v(b.length), b);
  const tuple = (fields: Uint8Array[]): Uint8Array => cat(v(fields.length), ...fields.map(lenBytes));
  const frame = (typeCode: number, payload: Uint8Array): Uint8Array => {
    const t = v(typeCode);
    const out = new Uint8Array(t.length + 2 + payload.length);
    out.set(t, 0);
    out[t.length] = (payload.length >> 8) & 0xff;
    out[t.length + 1] = payload.length & 0xff;
    out.set(payload, t.length + 2);
    return out;
  };
  const NOPARAMS = v(0); // empty Message Parameters = count 0
  const FIELD = new Uint8Array([0x61]);
  const NAME_B = new Uint8Array([0x62]);

  // ── SUBSCRIBE (0x03) decode ──
  it('decode rejects SUBSCRIBE with an empty namespace FIELD', () => {
    const payload = cat(v(0), tuple([new Uint8Array(0)]), lenBytes(NAME_B), NOPARAMS);
    expect(() => codec18.decode(frame(0x03, payload), 0)).toThrow(/length 0|at least one byte|PROTOCOL_VIOLATION/i);
  });

  it('decode rejects SUBSCRIBE with >32 namespace fields', () => {
    const fields = Array.from({ length: 33 }, () => FIELD);
    const payload = cat(v(0), tuple(fields), lenBytes(NAME_B), NOPARAMS);
    expect(() => codec18.decode(frame(0x03, payload), 0)).toThrow(/maximum is 32|PROTOCOL_VIOLATION/i);
  });

  it('decode rejects SUBSCRIBE with a Full Track Name >4096 bytes', () => {
    const payload = cat(v(0), tuple([FIELD]), lenBytes(new Uint8Array(4096)), NOPARAMS); // 1 + 4096 > 4096
    expect(() => codec18.decode(frame(0x03, payload), 0)).toThrow(/4096|PROTOCOL_VIOLATION/i);
  });

  it('decode ACCEPTS SUBSCRIBE with an EMPTY namespace + valid track name (draft-18)', () => {
    const sub: Subscribe = { type: 'SUBSCRIBE', requestId: 0n, trackNamespace: [], trackName: NAME, parameters: new Map() };
    const { message } = codec18.decode(codec18.encode(sub), 0);
    expect((message as Subscribe).trackNamespace).toEqual([]);
    expect(hex((message as Subscribe).trackName)).toBe(hex(NAME));
  });

  // ── PUBLISH (0x1d) / TRACK_STATUS (0x0d) / FETCH (0x16) decode ──
  it('decode rejects PUBLISH with a Full Track Name >4096 bytes', () => {
    // rid + ns + name(4096) + alias + params + (empty props)
    const payload = cat(v(0), tuple([FIELD]), lenBytes(new Uint8Array(4096)), v(0), NOPARAMS);
    expect(() => codec18.decode(frame(0x1d, payload), 0)).toThrow(/4096|PROTOCOL_VIOLATION/i);
  });

  it('decode rejects TRACK_STATUS with an empty namespace field', () => {
    const payload = cat(v(0), tuple([new Uint8Array(0)]), lenBytes(NAME_B), NOPARAMS);
    expect(() => codec18.decode(frame(0x0d, payload), 0)).toThrow(/length 0|at least one byte|PROTOCOL_VIOLATION/i);
  });

  it('decode rejects standalone FETCH with a Full Track Name >4096 bytes', () => {
    // rid + fetchType(0x1) + ns + name(4096) + start(g,o) + end(g,o) [+ params]
    const payload = cat(v(0), v(0x1), tuple([FIELD]), lenBytes(new Uint8Array(4096)), v(0), v(0), v(0), v(0), NOPARAMS);
    expect(() => codec18.decode(frame(0x16, payload), 0)).toThrow(/4096|PROTOCOL_VIOLATION/i);
  });

  // ── PUBLISH_NAMESPACE (0x06) — full namespace, no track name ──
  it('decode rejects PUBLISH_NAMESPACE with an empty namespace field', () => {
    const payload = cat(v(0), tuple([new Uint8Array(0)]), NOPARAMS);
    expect(() => codec18.decode(frame(0x06, payload), 0)).toThrow(/length 0|at least one byte|PROTOCOL_VIOLATION/i);
  });

  it('decode rejects PUBLISH_NAMESPACE with a namespace >4096 bytes', () => {
    const payload = cat(v(0), tuple([new Uint8Array(4097)]), NOPARAMS);
    expect(() => codec18.decode(frame(0x06, payload), 0)).toThrow(/4096|PROTOCOL_VIOLATION/i);
  });

  it('decode ACCEPTS PUBLISH_NAMESPACE with an EMPTY namespace (draft-18)', () => {
    const pn: PublishNamespace = { type: 'PUBLISH_NAMESPACE', requestId: 0n, trackNamespace: [], parameters: new Map() };
    const { message } = codec18.decode(codec18.encode(pn), 0);
    expect((message as PublishNamespace).trackNamespace).toEqual([]);
  });

  // ── ENCODE rejects the same invalid shapes ──
  it('encode rejects SUBSCRIBE with an empty namespace field', () => {
    const sub: Subscribe = { type: 'SUBSCRIBE', requestId: 0n, trackNamespace: [new Uint8Array(0)], trackName: NAME, parameters: new Map() };
    expect(() => codec18.encode(sub)).toThrow(/length 0|at least one byte|PROTOCOL_VIOLATION/i);
  });

  it('encode rejects SUBSCRIBE with >32 namespace fields', () => {
    const sub: Subscribe = { type: 'SUBSCRIBE', requestId: 0n, trackNamespace: Array.from({ length: 33 }, () => FIELD), trackName: NAME, parameters: new Map() };
    expect(() => codec18.encode(sub)).toThrow(/maximum is 32|PROTOCOL_VIOLATION/i);
  });

  it('encode rejects PUBLISH_NAMESPACE with a namespace >4096 bytes', () => {
    const pn: PublishNamespace = { type: 'PUBLISH_NAMESPACE', requestId: 0n, trackNamespace: [new Uint8Array(4097)], parameters: new Map() };
    expect(() => codec18.encode(pn)).toThrow(/4096|PROTOCOL_VIOLATION/i);
  });
});
