import { describe, expect, it } from 'vitest';
import { CONTROLS, INTENDED, IntendedAssertion, intended, negativesVerdict, type NegativeCase } from './negatives-verdict.mjs';

const step = (...names: string[]) => names.map(s => ({ step: s }));
const passed = (name: string, ...steps: string[]): NegativeCase => ({ name, passed: true, error: null, intendedFailure: null, steps: step(...steps) });
const failed = (name: string, error: string, intendedFailure: string | null, ...steps: string[]): NegativeCase => ({ name, passed: false, error, intendedFailure, steps: step(...steps) });
const clean = { fatal: null, errorCount: 0, backendUnchanged: true, inputsUnchanged: true, cleanupProven: true, completed: true };
const all = ['plain', 'two-players', 'silent', 'freeze'];

describe('negatives verdict', () => {
  it('intended() throws a typed witness carrying the assertion name', () => {
    expect(() => intended('no-media-objects', false, '3 media objects')).toThrow(IntendedAssertion);
    try { intended(INTENDED.freeze, false, 'moved'); } catch (e) { expect((e as IntendedAssertion).intended).toBe('presentation-frozen'); expect((e as Error).message).toMatch(/^presentation-frozen: moved/); }
    expect(() => intended('x', true, 'fine')).not.toThrow();
  });
  it('positive: passes only when every requested case passed with clean harness evidence', () => {
    const cases = Object.fromEntries(all.map(n => [n, passed(n, 'a')]));
    expect(negativesVerdict({ ...clean, control: null, expectedCases: all, cases })).toEqual({ pass: true, reasons: [] });
    expect(negativesVerdict({ ...clean, control: null, expectedCases: all, cases: { ...cases, silent: failed('silent', 'AssertionError: x', null) } }).reasons).toEqual(['case silent failed: AssertionError: x']);
    expect(negativesVerdict({ ...clean, control: null, expectedCases: all, cases: { plain: cases.plain! } }).reasons).toEqual(['case two-players did not run', 'case silent did not run', 'case freeze did not run']);
    expect(negativesVerdict({ ...clean, completed: false, control: null, expectedCases: ['plain'], cases: { plain: cases.plain! } }).reasons).toEqual(['the run did not complete']);
  });
  it('both modes: unrelated exceptions, source drift, unproven cleanup and a fatal all fail', () => {
    const cases = { plain: passed('plain', 'attach attempt') };
    expect(negativesVerdict({ ...clean, errorCount: 2, control: null, expectedCases: ['plain'], cases }).reasons).toEqual(['2 exception/console.error event(s) on page, owner or panel']);
    expect(negativesVerdict({ ...clean, backendUnchanged: false, control: null, expectedCases: ['plain'], cases }).reasons).toEqual(['backend source changed during the run (or was not fingerprinted)']);
    expect(negativesVerdict({ ...clean, cleanupProven: null, control: null, expectedCases: ['plain'], cases }).reasons).toEqual(['owned processes/browser/server cleanup not proven']);
    expect(negativesVerdict({ ...clean, inputsUnchanged: false, control: null, expectedCases: ['plain'], cases }).reasons).toEqual(['gate inputs (negative pages, publisher helper, gate and helper files) changed during the run (or were not fingerprinted after)']);
    expect(negativesVerdict({ ...clean, inputsUnchanged: null, control: 'discoverable-plain', expectedCases: ['plain'], cases: { plain: failed('plain', 'IntendedAssertion: no-source-discovered: x', INTENDED.plain, 'attach attempt') } }).pass).toBe(false);
    expect(negativesVerdict({ ...clean, fatal: 'Error: launch failed\n  at x', control: null, expectedCases: ['plain'], cases }).reasons).toEqual(['harness failure: Error: launch failed']);
    const control = { plain: failed('plain', 'IntendedAssertion: no-source-discovered: a source was discovered', INTENDED.plain, 'page', 'attach attempt') };
    expect(negativesVerdict({ ...clean, errorCount: 1, control: 'discoverable-plain', expectedCases: ['plain'], cases: control }).pass).toBe(false);
    expect(negativesVerdict({ ...clean, cleanupProven: false, control: 'discoverable-plain', expectedCases: ['plain'], cases: control }).pass).toBe(false);
    // control mode: the harness must still have completed (re-fingerprint + cleanup) even though the case failure was caught
    expect(negativesVerdict({ ...clean, completed: false, control: 'discoverable-plain', expectedCases: ['plain'], cases: control }).reasons).toEqual(['the run did not complete']);
  });
  it('control: passes only on the NAMED intended assertion after its setup step', () => {
    const ok = { plain: failed('plain', 'IntendedAssertion: no-source-discovered: a source was discovered', INTENDED.plain, 'page', 'attach attempt') };
    expect(negativesVerdict({ ...clean, control: 'discoverable-plain', expectedCases: ['plain'], cases: ok })).toEqual({ pass: true, reasons: [] });
    // a timeout whose text happens to contain the word is NOT the witness
    const timeout = { plain: failed('plain', 'Error: timeout waiting for discovered: null', null, 'page', 'attach attempt') };
    expect(negativesVerdict({ ...clean, control: 'discoverable-plain', expectedCases: ['plain'], cases: timeout }).reasons).toEqual(['control discoverable-plain: expected the intended assertion "no-source-discovered", got a non-intended failure: Error: timeout waiting for discovered: null']);
    // the wrong intended assertion (another case's) is refused
    const wrong = { freeze: failed('freeze', 'AssertionError: the element must be paused', null, 'freeze') };
    expect(negativesVerdict({ ...clean, control: 'no-pause', expectedCases: ['freeze'], cases: wrong }).pass).toBe(false);
    const other = { freeze: failed('freeze', 'IntendedAssertion: no-media-objects: x', INTENDED.silent, 'freeze') };
    expect(negativesVerdict({ ...clean, control: 'no-pause', expectedCases: ['freeze'], cases: other }).reasons).toEqual(['control no-pause: expected the intended assertion "presentation-frozen", got "no-media-objects"']);
    // the intended witness BEFORE the setup step (e.g. thrown during setup) is refused
    const early = { silent: failed('silent', 'IntendedAssertion: no-media-objects: 1 media objects', INTENDED.silent, 'observation window') };
    expect(negativesVerdict({ ...clean, control: 'objects-on-silent', expectedCases: ['silent'], cases: early }).reasons).toEqual(['control objects-on-silent: setup step "control object sent" was not reached (the failure is not the intended one)']);
    // the case passing under a control means the induced condition went undetected
    expect(negativesVerdict({ ...clean, control: 'no-pause', expectedCases: ['freeze'], cases: { freeze: passed('freeze', 'freeze') } }).reasons).toEqual(['control no-pause: the case passed; the induced condition was not detected']);
    // a control must run exactly its own case
    expect(negativesVerdict({ ...clean, control: 'no-pause', expectedCases: ['freeze'], cases: { plain: passed('plain') } }).reasons).toEqual(['control no-pause must run exactly its case freeze']);
    expect(Object.values(CONTROLS).map(c => c.case).sort()).toEqual([...all].sort());
  });
});
