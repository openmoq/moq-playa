/**
 * draft-18 Message Parameter codec (§10.2).
 *
 * Wire form: Number of Parameters (vi64), then a count of
 *   Message Parameter { Type Delta (vi64), Value (..) }
 * in ascending Type order. Value encoding is per-type: uint8 / varint (vi64) /
 * Location (two vi64) / Length-prefixed (vi64 len + bytes). Unknown types and
 * Type overflow (> 2^64-1) are PROTOCOL_VIOLATIONs. `kind:'varint'` MUST use vi64.
 */
import { describe, it, expect } from 'vitest';
import {
  encodeMessageParams18,
  decodeMessageParams18,
  messageParams18EncodingLength,
  DEFAULT_MESSAGE_PARAM_REGISTRY,
  type MessageParams18,
  type ParamValueKind,
} from './message-params-18.js';
import { ProtocolViolationError } from '../errors.js';

function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

describe('encodeMessageParams18', () => {
  it('encodes count + ascending Type-Delta with correct deltas', () => {
    // 0x02 (OBJECT_DELIVERY_TIMEOUT, varint=5) and 0x22 (GROUP_ORDER, uint8=7).
    const params: MessageParams18 = new Map([
      [0x02n, [{ kind: 'varint', value: 5n } as const]],
      [0x22n, [{ kind: 'uint8', value: 7 } as const]],
    ]);
    const bytes = encodeMessageParams18(params);
    // count=2; [delta=0x02][varint 0x05]; [delta=0x22-0x02=0x20][uint8 0x07]
    expect(bytesToHex(bytes)).toBe('02' + '02' + '05' + '20' + '07');
  });

  it('encodes an empty parameter set as a single zero count', () => {
    expect(bytesToHex(encodeMessageParams18(new Map()))).toBe('00');
  });

  it('sorts types ascending regardless of insertion order', () => {
    const a = encodeMessageParams18(new Map([
      [0x22n, [{ kind: 'uint8', value: 7 } as const]],
      [0x02n, [{ kind: 'varint', value: 5n } as const]],
    ]));
    const b = encodeMessageParams18(new Map([
      [0x02n, [{ kind: 'varint', value: 5n } as const]],
      [0x22n, [{ kind: 'uint8', value: 7 } as const]],
    ]));
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });
});

describe('round-trip via the default registry', () => {
  const cases: Array<[string, MessageParams18]> = [
    ['uint8', new Map([[0x20n, [{ kind: 'uint8', value: 255 } as const]]])],
    ['varint', new Map([[0x02n, [{ kind: 'varint', value: 1234567n } as const]]])],
    ['location', new Map([[0x09n, [{ kind: 'location', group: 9n, object: 4n } as const]]])],
    ['bytes', new Map([[0x03n, [{ kind: 'bytes', value: new Uint8Array([1, 2, 3]) } as const]]])],
  ];
  for (const [name, params] of cases) {
    it(`round-trips a ${name} parameter`, () => {
      const bytes = encodeMessageParams18(params);
      const { params: decoded, bytesRead } = decodeMessageParams18(bytes, 0, DEFAULT_MESSAGE_PARAM_REGISTRY);
      expect(bytesRead).toBe(bytes.length);
      expect(decoded).toEqual(params);
    });
  }

  it('round-trips a multi-parameter message and reports bytesRead', () => {
    const params: MessageParams18 = new Map([
      [0x02n, [{ kind: 'varint', value: 100n } as const]],
      [0x09n, [{ kind: 'location', group: 1n, object: 2n } as const]],
      [0x20n, [{ kind: 'uint8', value: 5 } as const]],
    ]);
    const bytes = encodeMessageParams18(params);
    const out = decodeMessageParams18(bytes, 0, DEFAULT_MESSAGE_PARAM_REGISTRY);
    expect(out.params).toEqual(params);
    expect(out.bytesRead).toBe(bytes.length);
  });

  it('reads at a non-zero offset', () => {
    const params: MessageParams18 = new Map([[0x20n, [{ kind: 'uint8', value: 9 } as const]]]);
    const bytes = encodeMessageParams18(params);
    const framed = new Uint8Array([0xaa, 0xbb, ...bytes]);
    const out = decodeMessageParams18(framed, 2, DEFAULT_MESSAGE_PARAM_REGISTRY);
    expect(out.params).toEqual(params);
    expect(out.bytesRead).toBe(bytes.length);
  });
});

describe('vi64 — varint values exceed the QUIC range', () => {
  it('round-trips a varint value above 2^62-1 (proves vi64, not QUIC varint)', () => {
    const big = (1n << 63n) + 7n; // > 2^62-1
    const params: MessageParams18 = new Map([[0x02n, [{ kind: 'varint', value: big } as const]]]);
    const bytes = encodeMessageParams18(params);
    const out = decodeMessageParams18(bytes, 0, DEFAULT_MESSAGE_PARAM_REGISTRY);
    expect((out.params.get(0x02n)![0] as { value: bigint }).value).toBe(big);
  });
});

describe('encode-side registry validation', () => {
  it('throws when a known Type uses the wrong wire kind', () => {
    // 0x20 SUBSCRIBER_PRIORITY is uint8; encoding it as a varint must fail.
    const bad: MessageParams18 = new Map([[0x20n, [{ kind: 'varint', value: 5n } as const]]]);
    expect(() => encodeMessageParams18(bad)).toThrow(/expects uint8, got varint/);
  });

  it('throws when encoding a Type not in the registry', () => {
    const bad: MessageParams18 = new Map([[0x7en, [{ kind: 'uint8', value: 1 } as const]]]);
    expect(() => encodeMessageParams18(bad)).toThrow(/unknown message parameter Type/i);
  });

  it('accepts a custom registry that defines the Type', () => {
    const reg: ReadonlyMap<bigint, ParamValueKind> = new Map([[0x7en, 'uint8']]);
    const params: MessageParams18 = new Map([[0x7en, [{ kind: 'uint8', value: 1 } as const]]]);
    const bytes = encodeMessageParams18(params, reg);
    expect(decodeMessageParams18(bytes, 0, reg).params).toEqual(params);
  });

  it('messageParams18EncodingLength validates too', () => {
    const bad: MessageParams18 = new Map([[0x20n, [{ kind: 'bytes', value: new Uint8Array() } as const]]]);
    expect(() => messageParams18EncodingLength(bad)).toThrow(/expects uint8/);
  });
});

describe('TRACK_NAMESPACE_PREFIX (0x34) namespace tuple', () => {
  const f = (s: string) => new TextEncoder().encode(s);

  it('round-trips a multi-field prefix', () => {
    const params: MessageParams18 = new Map([
      [0x34n, [{ kind: 'namespace', value: [f('example.com'), f('meeting=123')] } as const]],
    ]);
    const bytes = encodeMessageParams18(params);
    const { params: decoded, bytesRead } = decodeMessageParams18(bytes, 0, DEFAULT_MESSAGE_PARAM_REGISTRY);
    expect(decoded).toEqual(params);
    expect(bytesRead).toBe(bytes.length);
  });

  it('round-trips an empty (zero-field) prefix', () => {
    const params: MessageParams18 = new Map([[0x34n, [{ kind: 'namespace', value: [] } as const]]]);
    const bytes = encodeMessageParams18(params);
    expect(decodeMessageParams18(bytes, 0, DEFAULT_MESSAGE_PARAM_REGISTRY).params).toEqual(params);
  });

  it('encodes the tuple as vi64 count + vi64-length-prefixed fields', () => {
    const params: MessageParams18 = new Map([[0x34n, [{ kind: 'namespace', value: [f('ab')] } as const]]]);
    const bytes = encodeMessageParams18(params);
    // count(1)=0x01, delta=0x34, field-count(1)=0x01, field-len(1)=0x02, 'ab'
    expect([...bytes]).toEqual([0x01, 0x34, 0x01, 0x02, 0x61, 0x62]);
    expect(messageParams18EncodingLength(params)).toBe(bytes.length);
  });

  // ── structural hardening (§2.4.1) ──
  const nsParams = (value: unknown[]): MessageParams18 =>
    new Map([[0x34n, [{ kind: 'namespace', value } as never]]]);

  it('rejects encoding an empty (zero-length) field', () => {
    expect(() => encodeMessageParams18(nsParams([new Uint8Array(0)]))).toThrow(/length 0|at least one byte/i);
  });

  it('rejects encoding more than 32 fields', () => {
    const fields = Array.from({ length: 33 }, (_, i) => f(`n${i}`));
    expect(() => encodeMessageParams18(nsParams(fields))).toThrow(/maximum is 32/i);
  });

  it('rejects encoding a tuple over 4096 total bytes', () => {
    const fields = [new Uint8Array(4097).fill(1)];
    expect(() => encodeMessageParams18(nsParams(fields))).toThrow(/4096/);
  });

  it('rejects encoding a non-Uint8Array field', () => {
    expect(() => encodeMessageParams18(nsParams(['not-bytes']))).toThrow(/not a Uint8Array/i);
  });

  it('rejects decoding a malformed tuple (empty field) as a PROTOCOL_VIOLATION', () => {
    // count=1, delta=0x34, field-count=1, field-len=0 (empty field).
    const buf = new Uint8Array([0x01, 0x34, 0x01, 0x00]);
    expect(() => decodeMessageParams18(buf, 0, DEFAULT_MESSAGE_PARAM_REGISTRY)).toThrow(ProtocolViolationError);
  });
});

describe('protocol violations', () => {
  it('throws on an unknown parameter type (cannot be skipped)', () => {
    // count=1, delta=0x7E (type 0x7E not in the default registry), then a byte.
    const buf = new Uint8Array([0x01, 0x7e, 0x00]);
    expect(() => decodeMessageParams18(buf, 0, DEFAULT_MESSAGE_PARAM_REGISTRY)).toThrow(ProtocolViolationError);
  });

  it('throws when a cumulative Type exceeds 2^64-1', () => {
    // Custom registry that knows a near-max type, so the overflow guard (not the
    // unknown-type guard) fires. First delta = 2^64-1 → type = 2^64-1 (the max);
    // second delta = 1 → type = 2^64 → PROTOCOL_VIOLATION.
    const max = 18446744073709551615n;
    const reg = new Map<bigint, ParamValueKind>([
      [max, 'uint8'],
      [0n, 'uint8'],
    ]);
    // count=2; delta=ff..ff(9 bytes)=2^64-1; uint8=0; delta=01; uint8=0
    const buf = new Uint8Array([0x02, 0xff, ...new Array(8).fill(0xff), 0x00, 0x01, 0x00]);
    expect(() => decodeMessageParams18(buf, 0, reg)).toThrow(ProtocolViolationError);
  });
});
