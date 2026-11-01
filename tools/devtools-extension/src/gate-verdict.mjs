// Pure verdict logic for the real-DevTools browser gate (test support; not
// bundled into the extension — panel.js never imports it).
//
// The driver collects evidence; this decides. Keeping the decision pure lets
// it be tested directly for the two false passes a browser run can hide:
// an UNRELATED fatal satisfying the negative control, and an asynchronous
// renderer error leaving the positive run green.

/**
 * @typedef {object} GateEvidence
 * @property {string|null} fatal          Harness-level failure: launch, missing host/panel, anchors, timeouts.
 * @property {readonly number[]|null} before  DOM row widths after the snapshot.
 * @property {readonly number[]|null} after   DOM row widths after the narrow-row append.
 * @property {string|null} rendererError  The renderer threw while applying the append.
 * @property {boolean} painted            The panel body had a non-zero width in the real DevTools window.
 * @property {number} errorCount          Runtime.exceptionThrown + console.error on the panel, COUNTED beyond any stored-text bound.
 */

/** @typedef {'positive'|'negative-row-cache'} GateMode */

const same = (a, b) => a !== null && a.length === b.length && a.every((v, i) => v === b[i]);

/** The exact failure the renderer regression produces: the growing narrow
 *  row indexes a cell node that does not exist. */
export const ROW_CACHE_SIGNATURE = /Cannot (set|read) properties of undefined \(.*className/;

/**
 * @param {GateMode} mode
 * @param {GateEvidence} e
 * @returns {{ pass: boolean, reasons: string[] }}
 */
export function gateVerdict(mode, e) {
  const reasons = [];
  // Harness failures are failures in EVERY mode. A negative control that is
  // "satisfied" by a missing panel has proven nothing about the renderer.
  if (e.fatal !== null) reasons.push(`harness failure: ${e.fatal}`);
  if (!e.painted) reasons.push('panel did not paint in the DevTools window');
  if (!same(e.before, [4, 1])) reasons.push(`setup rows ${JSON.stringify(e.before)} ≠ [4,1]`);

  if (mode === 'positive') {
    if (e.rendererError !== null) reasons.push(`renderer error: ${e.rendererError}`);
    if (!same(e.after, [4, 2])) reasons.push(`rows after append ${JSON.stringify(e.after)} ≠ [4,2]`);
    if (e.errorCount > 0) reasons.push(`${e.errorCount} exception/console.error event(s) on the panel`);
  } else {
    // The negative passes only on the INTENDED failure, at the intended step,
    // and with nothing else wrong: the mutation's failure surfaces as the
    // append's own exception, so any additional panel exception or
    // console.error is unrelated noise and disqualifies the run.
    if (e.rendererError === null) reasons.push('mutation did not fail the renderer at the narrow-row append');
    else if (!ROW_CACHE_SIGNATURE.test(e.rendererError)) reasons.push(`renderer failed for another reason: ${e.rendererError}`);
    if (e.errorCount > 0) reasons.push(`${e.errorCount} unrelated exception/console.error event(s) on the panel`);
  }
  return { pass: reasons.length === 0, reasons };
}
