/** Cross-check the public observation against the independent native draw sensor. */
export function assessVideoPresentation(samples) {
  const failures = new Set();
  if (!samples.length) failures.add('no-samples');
  for (const sample of samples) {
    const observation = sample.videoPresentation;
    if (sample.outputKind === 'video') {
      if (observation !== null) failures.add('unexpected-mse-observation');
      continue;
    }
    if (!observation) {
      failures.add('missing-canvas-observation');
      continue;
    }
    if (!Number.isFinite(sample.nativeDrawTimestampUs) || !Number.isInteger(sample.nativeDrawTimestampUs)) {
      failures.add('missing-native-draw-timestamp');
      continue;
    }
    const expected = Number.isSafeInteger(sample.nativeDrawTimestampUs)
      ? BigInt(sample.nativeDrawTimestampUs).toString() : null;
    if (observation.frameTimestampUs !== expected) failures.add('draw-timestamp-mismatch');
    if (observation.timestampDomain !== 'unknown') failures.add('inferred-timestamp-origin');
    if (!Number.isFinite(observation.renderedAtUs)) failures.add('invalid-render-clock');
    if (!Number.isFinite(sample.nativeDrawTimeMs)) failures.add('missing-native-draw-clock');
    // The harness factory's AudioAlignedClock maps to performance.now(). Allow
    // 20 ms for that correlation and sampling overhead, not arbitrary custom clocks.
    else if (Math.abs(observation.renderedAtUs / 1000 - sample.nativeDrawTimeMs) > 20) {
      failures.add('draw-clock-mismatch');
    }
  }
  return [...failures].sort();
}
