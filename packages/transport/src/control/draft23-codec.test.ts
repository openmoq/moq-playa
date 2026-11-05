/**
 * The draft-23 variant of the draft-18 control codec (`createControlCodec(23)`):
 * varint framing, PAUSED, counted FILL_PARAMETERS, NAMESPACE Parameters,
 * REQUEST_ERROR Error Details and the draft-23 close codes (§12.2).
 */
import { describe, it, expect } from 'vitest';
import { createControlCodec } from './codec.js';
import { MAX_CONTROL_MESSAGE_SIZE } from './draft18-codec.js';
import { encodeFillParameters } from './subscription-filter.js';
import { decodeFillParameters } from './fill-parameters.js';
import { bytesToHex, hexToBytes } from '../vectors/load-vectors.js';
import { writeVi64, vi64EncodingLength } from '../primitives/vi64.js';
import { ProtocolViolationError } from '../errors.js';
import type {
  ControlMessage, FetchOk, Goaway, Namespace, PublishStateNotify, RequestErrorMsg, RequestUpdate, Subscribe,
} from './messages.js';

const codec22 = createControlCodec(22);
const codec23 = createControlCodec(23);
const enc = (s: string) => new TextEncoder().encode(s);
const FORWARD = 0x10n;
const FILL_PARAMETERS = 0x23n;

/** The draft-23 close code a decode of `hex` fails with. */
function decodeCode(hex: string): number | undefined {
  try {
    codec23.decode(hexToBytes(hex), 0);
  } catch (err) {
    if (err instanceof ProtocolViolationError) return err.code;
    throw err;
  }
  throw new Error(`${hex} decoded`);
}

describe('draft-23 framing (§9)', () => {
  it('writes the Length as a vi64', () => {
    const goaway: Goaway = { type: 'GOAWAY', newSessionUri: '', timeout: 5000n };
    expect(bytesToHex(codec23.encode(goaway))).toBe('1003009388');
    // draft 22 keeps its 16-bit Length
    expect(bytesToHex(codec22.encode(goaway))).toBe('100003009388');
    expect(codec23.decode(hexToBytes('1003009388'), 0)).toEqual({ message: goaway, bytesRead: 5 });
  });

  it('uses a multi-byte Length once the body needs it', () => {
    const notify: PublishStateNotify = {
      type: 'PUBLISH_STATE_NOTIFY',
      parameters: new Map([[0x03n, [new Uint8Array(200)]]]),
    };
    const bytes = codec23.encode(notify);
    const body = 1 + 1 + 2 + 200; // count, delta, length, token
    expect(bytesToHex(bytes.subarray(0, 3))).toBe(`22${(0x8000 | body).toString(16)}`);
    expect(codec23.peekFrameSize(bytes)).toBe(bytes.length);
    expect(codec23.decode(bytes, 0).message).toEqual(notify);
  });

  it('peekFrameSize waits for the whole Length field', () => {
    const bytes = codec23.encode({ type: 'PUBLISH_STATE_NOTIFY', parameters: new Map([[0x03n, [new Uint8Array(200)]]]) });
    expect(codec23.peekFrameSize(bytes.subarray(0, 1))).toBeUndefined();
    expect(codec23.peekFrameSize(bytes.subarray(0, 2))).toBeUndefined();
    expect(codec23.peekFrameSize(bytes.subarray(0, 3))).toBe(bytes.length);
  });

  it('refuses a Length above MAX_CONTROL_MESSAGE_SIZE before the body arrives (FIELD_LENGTH_EXCEEDED)', () => {
    const len = BigInt(MAX_CONTROL_MESSAGE_SIZE + 1);
    const header = new Uint8Array(1 + vi64EncodingLength(len));
    header[0] = 0x10;
    writeVi64(len, header, 1);
    expect(() => codec23.peekFrameSize(header)).toThrow(expect.objectContaining({ code: 0x401 }));
    expect(() => codec23.decode(header, 0)).toThrow(expect.objectContaining({ code: 0x401 }));
  });

  it('never sends more than the default MAX_CONTROL_MESSAGE_SIZE', () => {
    const notify: PublishStateNotify = {
      type: 'PUBLISH_STATE_NOTIFY',
      parameters: new Map([[0x03n, [new Uint8Array(MAX_CONTROL_MESSAGE_SIZE)]]]),
    };
    expect(() => codec23.encode(notify)).toThrow(/MAX_CONTROL_MESSAGE_SIZE/);
  });

  it('a body that does not fill its Length is MALFORMED_MESSAGE', () => {
    expect(decodeCode('1004009388')).toBe(0x300); // Length 4, 3 bytes present
    expect(decodeCode('100400938800')).toBe(0x300); // a trailing byte after Timeout
  });

  it('an unknown message type is UNEXPECTED_MESSAGE', () => {
    expect(decodeCode('7f00')).toBe(0x303);
  });
});

describe('draft-23 FETCH response (§9.3)', () => {
  it('FETCH_OK (0x18) is reserved', () => {
    expect(decodeCode('1806000000000000')).toBe(0x303);
    const ok = {
      type: 'FETCH_OK', requestId: 1n, endOfTrack: 0, endLocation: { group: 1n, object: 0n }, parameters: new Map(),
    } as FetchOk;
    expect(() => codec23.encode(ok)).toThrow(/REQUEST_OK/);
    expect(() => codec22.encode(ok)).not.toThrow();
  });
});

describe('draft-23 PAUSED (§9.19.18)', () => {
  const notify = (forward: bigint): PublishStateNotify => ({
    type: 'PUBLISH_STATE_NOTIFY', parameters: new Map([[FORWARD, [forward]]]),
  });

  it('writes FORWARD as PAUSED 0x11 with the value inverted', () => {
    expect(bytesToHex(codec23.encode(notify(0n)))).toBe('2203011101');
    expect(bytesToHex(codec23.encode(notify(1n)))).toBe('2203011100');
    expect(bytesToHex(codec22.encode(notify(0n)))).toBe('220003011000');
  });

  it('reads PAUSED back as the semantic FORWARD', () => {
    expect(codec23.decode(hexToBytes('2203011101'), 0).message).toEqual(notify(0n));
    expect(codec23.decode(hexToBytes('2203011100'), 0).message).toEqual(notify(1n));
  });

  it('an absent PAUSED stays absent (both mean delivering)', () => {
    const msg = codec23.decode(codec23.encode({ type: 'PUBLISH_STATE_NOTIFY', parameters: new Map() }), 0).message;
    expect((msg as PublishStateNotify).parameters.size).toBe(0);
  });

  it('FORWARD 0x10 on the wire is an unknown parameter (INVALID_PARAMETER)', () => {
    expect(decodeCode('2203011000')).toBe(0x305);
  });

  it('PAUSED outside 0-1 is INVALID_PARAMETER', () => {
    expect(decodeCode('2203011102')).toBe(0x305);
  });
});

describe('draft-23 FILL_PARAMETERS (§9.19.15)', () => {
  const update = (fill: Uint8Array): RequestUpdate => ({
    type: 'REQUEST_UPDATE', requestId: 1n, existingRequestId: 0n, parameters: new Map([[FILL_PARAMETERS, [fill]]]),
  });

  it('frames the parameters with a count, not a Length', () => {
    const fill = encodeFillParameters(undefined, 'descending'); // one parameter, GROUP_ORDER 2
    expect(bytesToHex(fill)).toBe('012202');
    // draft 23 writes the counted block as it is; draft 22 wraps it in a Length.
    expect(bytesToHex(codec23.encode(update(fill)))).toBe('020601012301' + '2202');
    expect(bytesToHex(codec22.encode(update(fill)))).toBe('0200070101230' + '3012202');
  });

  it('round-trips the same fill body draft 22 carries', () => {
    const fill = encodeFillParameters({ type: 'AbsoluteStart', startGroup: 4n, startObject: 0n }, 'ascending');
    const decoded = codec23.decode(codec23.encode(update(fill)), 0).message as RequestUpdate;
    const body = decoded.parameters.get(FILL_PARAMETERS)![0] as Uint8Array;
    expect(bytesToHex(body)).toBe(bytesToHex(fill));
    expect(decodeFillParameters(body).groupOrder).toBe('ascending');
  });

  it('an empty fill is a zero count', () => {
    expect(bytesToHex(codec23.encode(update(encodeFillParameters())))).toBe('02040101' + '2300');
  });

  it('refuses a fill block with trailing bytes', () => {
    expect(() => codec23.encode(update(new Uint8Array([0x00, 0x00])))).toThrow(/trailing bytes/);
  });
});

describe('draft-23 NAMESPACE Parameters (§9.15)', () => {
  it('writes an empty Parameters block after the suffix', () => {
    const ns: Namespace = { type: 'NAMESPACE', trackNamespaceSuffix: [enc('a')] };
    expect(bytesToHex(codec23.encode(ns))).toBe('0804010161' + '00');
    expect(bytesToHex(codec22.encode(ns))).toBe('0800030101' + '61');
    expect(codec23.decode(hexToBytes('080401016100'), 0).message)
      .toEqual({ type: 'NAMESPACE', trackNamespaceSuffix: [enc('a')], parameters: new Map() });
  });

  it('a draft-22 NAMESPACE (no Parameters) is MALFORMED_MESSAGE', () => {
    expect(decodeCode('0803010161')).toBe(0x300);
  });
});

describe('draft-23 REQUEST_ERROR Error Details (§9.4.2)', () => {
  const redirect = {
    type: 'REQUEST_ERROR', errorCode: 0x34n, retryInterval: 0n, errorReason: '',
    redirect: { connectUri: new Uint8Array(), trackNamespace: [], trackName: new Uint8Array() },
  } as unknown as RequestErrorMsg;

  it('carries the Redirect as a REDIRECT (0x01) Error Detail', () => {
    expect(bytesToHex(codec23.encode(redirect))).toBe('0508' + '340000' + '0103000000');
    expect(codec23.decode(hexToBytes('05083400000103000000'), 0).message).toMatchObject({
      errorCode: 0x34n, redirect: redirect.redirect,
    });
  });

  it('a REDIRECT code without a REDIRECT detail is MALFORMED_MESSAGE', () => {
    expect(decodeCode('0503340000')).toBe(0x300);
  });

  it('collects every UNSUPPORTED_PROPERTY detail', () => {
    const msg = codec23.decode(hexToBytes('0507330000023e0010'), 0).message as RequestErrorMsg;
    expect(msg.unsupportedProperties).toEqual([0x3en, 0x10n]);
    const reencoded = codec23.encode({ ...msg, requestId: 0n });
    expect(bytesToHex(reencoded)).toBe('0507330000023e0010');
  });

  it('ignores unknown details and known details on the wrong Error Code', () => {
    // DOES_NOT_EXIST with an UNSUPPORTED_PROPERTY detail and a grease detail (0x9D, odd)
    const msg = codec23.decode(hexToBytes('0509100000023e809b01ff'), 0).message as RequestErrorMsg;
    expect(msg.errorCode).toBe(0x10n);
    expect(msg.unsupportedProperties).toBeUndefined();
    expect(msg.errorDetails?.get(0x9dn)).toEqual([new Uint8Array([0xff])]);
  });

  it('allows duplicates of unknown detail types', () => {
    const msg = codec23.decode(hexToBytes('050a100000809d01aa0001bb'), 0).message as RequestErrorMsg;
    expect(msg.errorDetails?.get(0x9dn)).toEqual([new Uint8Array([0xaa]), new Uint8Array([0xbb])]);
  });

  it('draft 22 keeps the inline Redirect', () => {
    expect(bytesToHex(codec22.encode(redirect))).toBe('050006' + '340000' + '000000');
  });
});

describe('draft-23 Track Names (§2.4.1)', () => {
  const subscribe: Subscribe = {
    type: 'SUBSCRIBE', requestId: 0n, trackNamespace: [enc('a')], trackName: new Uint8Array(), parameters: new Map(),
  };

  it('an empty Track Name is PROTOCOL_VIOLATION', () => {
    expect(() => codec23.encode(subscribe)).toThrow(expect.objectContaining({ code: 0x3 }));
    const bytes = codec22.encode(subscribe); // draft 22 allows it
    const d23 = new Uint8Array(bytes.length - 1);
    d23[0] = bytes[0]!;
    d23[1] = bytes[2]!; // a one-byte vi64 Length
    d23.set(bytes.subarray(3), 2);
    expect(decodeCode(bytesToHex(d23))).toBe(0x3);
  });

  it('a non-empty Track Name round-trips', () => {
    const msg: ControlMessage = { ...subscribe, trackName: enc('v') };
    expect(codec23.decode(codec23.encode(msg), 0).message).toMatchObject({ trackName: enc('v') });
  });
});
