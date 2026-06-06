/**
 * PR2.5 — control-codec crash fuzz.
 *
 * Feeds arbitrary / truncated / malformed byte strings to the draft-14/16/18
 * control parser entrypoints and asserts they are CRASH-SAFE: for any input,
 * `peekFrameSize` and `decode` must either return a structurally sane result or
 * throw ONLY an expected parser error class — never a TypeError / ReferenceError
 * / plain Error, never a bytesRead outside the buffer, and never hang.
 *
 * This is not semantic validation: arbitrary bytes are not expected to decode.
 *
 * Env knobs: FC_RUNS (default 200), FC_SEED.
 */
import { describe, it, expect } from 'vitest';
import { createControlCodec, type DraftVersion } from './codec.js';
import { ProtocolViolationError } from '../errors.js';
import { fc, fcParams, fuzzBytes, fuzzOffset, toHex } from '../testkit/arbitraries.js';

/**
 * The ONLY error classes a parser may throw on malformed input. Anything else
 * (TypeError, ReferenceError, plain Error, assertion crash) is a real bug. The
 * thrown report includes the hex input for a minimized counterexample.
 */
function expectParserSafe<T>(label: string, input: Uint8Array, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ProtocolViolationError || e instanceof RangeError) return undefined;
    const name = e instanceof Error ? e.constructor.name : typeof e;
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`${label}: unexpected ${name}: ${message}\n  input(${input.length}B)=0x${toHex(input)}`);
  }
}

/** A returned decode result must consume ≥1 byte and stay within the buffer. */
function assertSaneBytesRead(label: string, input: Uint8Array, offset: number, bytesRead: unknown): void {
  expect(typeof bytesRead, `${label}: bytesRead is a number (0x${toHex(input)})`).toBe('number');
  const n = bytesRead as number;
  expect(Number.isInteger(n), `${label}: bytesRead is an integer (0x${toHex(input)})`).toBe(true);
  expect(n, `${label}: bytesRead > 0 (0x${toHex(input)})`).toBeGreaterThan(0);
  expect(offset + n, `${label}: offset+bytesRead ≤ length (0x${toHex(input)})`).toBeLessThanOrEqual(input.length);
}

const VERSIONS: DraftVersion[] = [14, 16, 18];

for (const version of VERSIONS) {
  const codec = createControlCodec(version);

  describe(`draft-${version} control parser crash fuzz`, () => {
    it('peekFrameSize never hard-crashes and returns undefined or a non-negative integer', () => {
      fc.assert(
        fc.property(fuzzBytes, (buf) => {
          const size = expectParserSafe(`peekFrameSize d${version}`, buf, () => codec.peekFrameSize(buf));
          if (size !== undefined) {
            expect(typeof size).toBe('number');
            expect(Number.isInteger(size)).toBe(true);
            expect(size).toBeGreaterThanOrEqual(0);
          }
        }),
        fcParams(),
      );
    });

    it('decode(buf, 0) never hard-crashes; any returned result is structurally sane', () => {
      fc.assert(
        fc.property(fuzzBytes, (buf) => {
          const result = expectParserSafe(`decode d${version}`, buf, () => codec.decode(buf, 0));
          if (result !== undefined) {
            assertSaneBytesRead(`decode d${version}`, buf, 0, result.bytesRead);
            expect(typeof result.message.type, `message.type is a string (0x${toHex(buf)})`).toBe('string');
          }
        }),
        fcParams(),
      );
    });

    it('decode at a non-zero offset respects the offset and stays in bounds', () => {
      fc.assert(
        fc.property(fuzzBytes, fuzzOffset, (payload, offset) => {
          // Prepend `offset` filler bytes so decoding starts at a non-zero offset.
          const buf = new Uint8Array(offset + payload.length);
          buf.set(payload, offset);
          if (offset >= buf.length) return; // nothing to read at/after offset
          const result = expectParserSafe(`decode@off d${version}`, buf, () => codec.decode(buf, offset));
          if (result !== undefined) {
            assertSaneBytesRead(`decode@off d${version}`, buf, offset, result.bytesRead);
            expect(typeof result.message.type).toBe('string');
          }
        }),
        fcParams(),
      );
    });
  });
}
