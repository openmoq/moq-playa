/** Capture completion is separate from an informational playback measurement. */
export function classifyCaseResult(assessment, informational = false, expectedFailure = null) {
  const actual = { ...assessment, failures: [...assessment.failures] };
  if (informational) return { status: 'trace', completed: true, assessment: actual };
  const passed = actual.passed || (expectedFailure !== null
    && actual.failures.length === 1 && actual.failures[0] === expectedFailure);
  return { status: passed ? 'pass' : 'fail', completed: true, passed, assessment: actual };
}

export function formatCaseResult(name, result) {
  const defects = result.assessment.failures.join(', ');
  if (result.status === 'trace') return `TRACE ${name}: ${defects || 'no playback defects observed'} (informational)`;
  return `${result.passed ? 'PASS' : 'FAIL'} ${name}: ${defects || 'healthy output'}`;
}

/** A trace can complete successfully without claiming playback quality passed. */
export function classifyRunResult(cases, errors) {
  if (errors.length || !cases.length || cases.some(result => !result.completed
    || !['pass', 'trace'].includes(result.status))) {
    return { status: 'fail', completed: false, passed: false };
  }
  if (cases.some(result => result.status === 'trace')) return { status: 'trace', completed: true };
  return { status: 'pass', completed: true, passed: true };
}
