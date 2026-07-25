/**
 * Discrimination tests for the shared media-fuzz oracle — proof it is NOT
 * vacuously green. Each lane's crash-safe oracle and returned-value invariants
 * must actually REJECT the disallowed cases, so a real parser regression would
 * fail the fuzz lanes rather than slip through.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { PropertyWireError } from '@moqt/transport';
import {
  expectParserSafe, allowLocError, allowCatalogError, allowNone,
  assertJsonSafe, assertNoMutation,
} from './media-fuzz.js';

describe('oracle: expectParserSafe', () => {
  it('returns the value on success', () => {
    const r = expectParserSafe('t', 'in', allowNone, () => 42);
    expect(r.ok && r.value).toBe(42);
  });

  it('returns {ok:false} for an ALLOWED rejection', () => {
    const r = expectParserSafe('t', 'in', allowLocError, () => { throw new RangeError('bad'); });
    expect(r.ok).toBe(false);
  });

  it('REJECTS a TypeError (disallowed) with the input in the message', () => {
    expect(() => expectParserSafe('loc', '0xdead', allowLocError, () => { throw new TypeError('boom'); }))
      .toThrow(/unexpected TypeError: boom[\s\S]*input=0xdead/);
  });

  it('REJECTS a non-Error throw (string) where disallowed', () => {
    expect(() => expectParserSafe('loc', '0xbeef', allowLocError, () => { throw 'nope'; }))
      .toThrow(/unexpected string: nope[\s\S]*input=0xbeef/);
  });

  it('REJECTS any throw under allowNone (BMFF totality)', () => {
    expect(() => expectParserSafe('bmff', '0x00', allowNone, () => { throw new RangeError('x'); }))
      .toThrow(/unexpected RangeError/);
  });
});

describe('oracle: allow predicates', () => {
  it('allowLocError: PropertyWireError + RangeError ok; TypeError rejected', () => {
    expect(allowLocError(new PropertyWireError('truncated', 'x'))).toBe(true);
    expect(allowLocError(new RangeError('x'))).toBe(true);
    expect(allowLocError(new TypeError('x'))).toBe(false);
    expect(allowLocError('str')).toBe(false);
  });

  it('allowCatalogError: SyntaxError + base Error ok; a TypeError (extends Error) rejected', () => {
    expect(allowCatalogError(new SyntaxError('x'))).toBe(true);
    expect(allowCatalogError(new Error('x'))).toBe(true);
    // The whole point: do NOT whitelist a TypeError merely because it extends Error.
    expect(allowCatalogError(new TypeError('x'))).toBe(false);
    expect(allowCatalogError(new ReferenceError('x'))).toBe(false);
    expect(allowCatalogError('str')).toBe(false);
  });
});

describe('oracle: assertJsonSafe (malformed returned shapes)', () => {
  it('accepts a clean, serialisable projection', () => {
    expect(() => assertJsonSafe('t', { a: '1', b: ['2', { c: true }], d: null }, 'in')).not.toThrow();
  });

  it('REJECTS a non-finite number', () => {
    expect(() => assertJsonSafe('t', { x: NaN }, 'in')).toThrow(/non-finite number/);
    expect(() => assertJsonSafe('t', { x: Infinity }, 'in')).toThrow(/non-finite number/);
  });

  it('ACCEPTS the STRINGS "NaN"/"Infinity" (legitimate string field values)', () => {
    // A track literally named "NaN" (or a codec string, label, …) is valid data —
    // only actual non-finite NUMBERS are corruption.
    expect(() => assertJsonSafe('t', { name: 'NaN', codec: 'Infinity', label: '-Infinity' }, 'in')).not.toThrow();
  });

  it('REJECTS a non-JSON value (bigint/function) in the projection', () => {
    expect(() => assertJsonSafe('t', { x: 5n }, 'in')).toThrow(/non-JSON bigint/);
    expect(() => assertJsonSafe('t', { x: () => 0 }, 'in')).toThrow(/non-JSON function/);
  });
});

describe('oracle: assertNoMutation (BMFF input-mutation lane)', () => {
  it('accepts an unchanged buffer', () => {
    const a = Uint8Array.of(1, 2, 3);
    expect(() => assertNoMutation('t', a, Uint8Array.of(1, 2, 3), 'in')).not.toThrow();
  });

  it('REJECTS a mutated byte', () => {
    expect(() => assertNoMutation('t', Uint8Array.of(1, 2, 3), Uint8Array.of(1, 9, 3), 'in'))
      .toThrow(/input mutated at byte 1 \(2→9\)/);
  });

  it('REJECTS a length change', () => {
    expect(() => assertNoMutation('t', Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3), 'in'))
      .toThrow(/input length changed 2→3/);
  });
});
