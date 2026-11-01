/**
 * The browser gate's verdict, tested directly. Two false passes a browser
 * run can hide must be refused here: an UNRELATED fatal cannot satisfy the
 * negative control, and an asynchronous renderer error cannot leave the
 * positive run green.
 */
import { describe, expect, it } from 'vitest';
import { gateVerdict, ROW_CACHE_SIGNATURE } from './gate-verdict.mjs';

const ok = {
  fatal: null, before: [4, 1], after: [4, 2], rendererError: null, painted: true, errorCount: 0,
} as const;
const rowCacheFailure =
  "Error: TypeError: Cannot set properties of undefined (setting 'className') at render";

describe('positive mode', () => {
  it('passes a clean run', () => {
    expect(gateVerdict('positive', ok)).toEqual({ pass: true, reasons: [] });
  });

  it('fails on an asynchronous exception even when the DOM is right', () => {
    const v = gateVerdict('positive', { ...ok, errorCount: 2 });
    expect(v.pass).toBe(false);
    expect(v.reasons).toEqual(['2 exception/console.error event(s) on the panel']);
  });

  it('fails on a renderer error', () => {
    expect(gateVerdict('positive', { ...ok, rendererError: rowCacheFailure, after: null }).pass).toBe(false);
  });

  it.each([
    ['missing host/panel', { ...ok, fatal: 'Playa panel not registered' }],
    ['no paint', { ...ok, painted: false }],
    ['wrong setup', { ...ok, before: [4] }],
    ['wrong growth', { ...ok, after: [4, 1] }],
  ] as const)('fails on %s', (_label, evidence) => {
    expect(gateVerdict('positive', evidence).pass).toBe(false);
  });
});

describe('negative row-cache mode', () => {
  it('passes only on the intended failure after a correct setup', () => {
    const v = gateVerdict('negative-row-cache', { ...ok, after: null, rendererError: rowCacheFailure });
    expect(v).toEqual({ pass: true, reasons: [] });
  });

  it('is NOT satisfied by an unrelated fatal such as a missing panel', () => {
    const v = gateVerdict('negative-row-cache', { ...ok, fatal: 'Playa panel not registered', before: null, after: null, painted: false });
    expect(v.pass).toBe(false);
    expect(v.reasons[0]).toMatch(/harness failure: Playa panel not registered/);
  });

  it('is NOT satisfied by a renderer failure with another cause', () => {
    const v = gateVerdict('negative-row-cache', { ...ok, after: null, rendererError: 'Error: codec rejected: invalid-message' });
    expect(v.pass).toBe(false);
    expect(v.reasons).toEqual(['renderer failed for another reason: Error: codec rejected: invalid-message']);
  });

  it('is NOT satisfied when unrelated exceptions accompany the intended failure', () => {
    const v = gateVerdict('negative-row-cache', { ...ok, after: null, rendererError: rowCacheFailure, errorCount: 1 });
    expect(v.pass).toBe(false);
    expect(v.reasons).toEqual(['1 unrelated exception/console.error event(s) on the panel']);
  });

  it('fails when the mutation did not break anything', () => {
    expect(gateVerdict('negative-row-cache', ok).pass).toBe(false);
  });

  it('still requires the known setup before the append', () => {
    expect(gateVerdict('negative-row-cache', { ...ok, before: [1], rendererError: rowCacheFailure }).pass).toBe(false);
  });
});

it('the signature matches the real regression text and not a generic error', () => {
  expect(ROW_CACHE_SIGNATURE.test("TypeError: Cannot set properties of undefined (setting 'className')")).toBe(true);
  expect(ROW_CACHE_SIGNATURE.test("TypeError: Cannot read properties of undefined (reading 'className')")).toBe(true);
  expect(ROW_CACHE_SIGNATURE.test('Error: Playa panel not registered')).toBe(false);
});
