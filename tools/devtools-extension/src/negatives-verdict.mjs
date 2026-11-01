// Pure verdict for the live NEGATIVES gate (test/real-tab-live-negatives.mjs). Both modes require: no fatal, zero
// unrelated exceptions/console errors, unchanged backend source, proven cleanup. The positive mode additionally needs
// every requested case to pass. A CONTROL mode needs exactly its one case to have FAILED on the NAMED intended
// assertion — a typed witness thrown by `intended(...)` after the case's setup step was reached — never on a timeout,
// a harness error or any other assertion that merely mentions a word.
export const INTENDED = Object.freeze({ plain: 'no-source-discovered', 'two-players': 'attached-target-identity', silent: 'no-media-objects', freeze: 'presentation-frozen' });
export const CONTROLS = Object.freeze({
  'discoverable-plain': { case: 'plain', intended: INTENDED.plain, afterStep: 'attach attempt' },
  'swap-identity': { case: 'two-players', intended: INTENDED['two-players'], afterStep: 'both playing' },
  'objects-on-silent': { case: 'silent', intended: INTENDED.silent, afterStep: 'control object sent' },
  'no-pause': { case: 'freeze', intended: INTENDED.freeze, afterStep: 'freeze' },
});
export class IntendedAssertion extends Error {
  constructor(name, message) { super(`${name}: ${message}`); this.name = 'IntendedAssertion'; this.intended = name; }
}
/** Throws the typed witness for the named intended assertion when `condition` is false. */
export function intended(name, condition, message) { if (!condition) throw new IntendedAssertion(name, message); }

export function negativesVerdict({ control, expectedCases, cases, fatal, errorCount, backendUnchanged, inputsUnchanged, cleanupProven, completed }) {
  const reasons = [];
  if (fatal) reasons.push(`harness failure: ${String(fatal).split('\n')[0]}`);
  if (inputsUnchanged !== true) reasons.push('gate inputs (negative pages, publisher helper, gate and helper files) changed during the run (or were not fingerprinted after)');
  if (!(Number.isInteger(errorCount) && errorCount === 0)) reasons.push(`${errorCount} exception/console.error event(s) on page, owner or panel`);
  if (backendUnchanged !== true) reasons.push('backend source changed during the run (or was not fingerprinted)');
  if (cleanupProven !== true) reasons.push('owned processes/browser/server cleanup not proven');
  const list = Object.values(cases ?? {});
  // Both modes: the harness itself must have run to completion (source re-fingerprint, cleanup); in control mode the
  // intended case failure is caught, so completion is a separate requirement.
  if (completed !== true) reasons.push('the run did not complete');
  if (!control) {
    const names = new Set(list.map(c => c.name));
    for (const c of expectedCases ?? []) if (!names.has(c)) reasons.push(`case ${c} did not run`);
    for (const c of list) if (c.passed !== true) reasons.push(`case ${c.name} failed: ${String(c.error ?? 'no evidence').split('\n')[0]}`);
  } else {
    const spec = CONTROLS[control];
    if (!spec) reasons.push(`unknown control ${control}`);
    else if (list.length !== 1 || list[0].name !== spec.case) reasons.push(`control ${control} must run exactly its case ${spec.case}`);
    else {
      const c = list[0];
      if (c.passed === true) reasons.push(`control ${control}: the case passed; the induced condition was not detected`);
      else if (!(c.steps ?? []).some(s => s.step === spec.afterStep)) reasons.push(`control ${control}: setup step "${spec.afterStep}" was not reached (the failure is not the intended one)`);
      else if (c.intendedFailure !== spec.intended) reasons.push(`control ${control}: expected the intended assertion "${spec.intended}", got ${c.intendedFailure ? `"${c.intendedFailure}"` : `a non-intended failure: ${String(c.error ?? '').split('\n')[0]}`}`);
    }
  }
  return { pass: reasons.length === 0, reasons };
}
