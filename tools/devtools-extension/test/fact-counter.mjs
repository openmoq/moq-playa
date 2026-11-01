// TEST-ONLY monotonic fact counting for the panel's PAGE lane. The gates keep only a bounded ring of applied frames
// (diagnosis), so ring LENGTH is not monotonic: a full ring shifts out as many frames as it adds. The counter counts
// FACTS carried by each applied frame — batch events and snapshot facts — and never hello/ack or other control
// frames, so "no fact after detach" is a statement about a number that can only grow. Scalar only; no payloads.
export function countFacts(text) {
  let m; try { m = JSON.parse(text); } catch { return 0; }
  if (!m || typeof m !== 'object') return 0;
  if (m.kind === 'batch' && Array.isArray(m.events)) return m.events.length;
  if (m.kind === 'snapshot' && Array.isArray(m.facts)) return m.facts.length;
  return 0;
}
/** Scalar metadata of a frame for failure evidence (no facts, no payloads). */
export function frameMeta(text) {
  let m; try { m = JSON.parse(text); } catch { return { kind: 'unparsable' }; }
  return { kind: m?.kind ?? 'unknown', ...(m?.fromSeq !== undefined ? { fromSeq: m.fromSeq, toSeq: m.toSeq } : {}), ...(m?.watermark !== undefined ? { watermark: m.watermark } : {}) };
}

// Validity guard for the sampled counters. A comparison of two samples proves nothing when the wrapper was never
// installed (undefined === undefined) or a value went NaN (Object.is(NaN, NaN) is true for strict assertions), so
// every sample is checked before it is compared: facts and frames must be nonnegative safe integers; the sample
// taken after the attached live/recording evidence must be POSITIVE on both; the completed-detach sample may not
// regress; and after the progress check the fact count must equal the completed-detach value exactly (frames may
// not regress either). A missing, NaN, or zero counter after a positive workload is a failure, never inactivity.
const counterFields = ['facts', 'frames'];
const nonnegativeInteger = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export function validateCounterSample(sample, label) {
  const failures = [];
  if (!sample || typeof sample !== 'object') return [`${label}: sample is ${sample === undefined ? 'undefined' : JSON.stringify(sample)} (counter not installed?)`];
  for (const f of counterFields) if (!nonnegativeInteger(sample[f])) failures.push(`${label}.${f} is not a nonnegative safe integer: ${String(sample[f])}`);
  return failures;
}
export function validateFactCounterWitness({ preRequest, atCompletedDetach, afterProgressCheck }) {
  const failures = [...validateCounterSample(preRequest, 'preRequest'), ...validateCounterSample(atCompletedDetach, 'atCompletedDetach'), ...validateCounterSample(afterProgressCheck, 'afterProgressCheck')];
  if (failures.length) return { ok: false, failures };
  for (const f of counterFields) if (preRequest[f] <= 0) failures.push(`preRequest.${f} must be positive after the attached live/recording workload, got ${preRequest[f]}`);
  for (const f of counterFields) if (atCompletedDetach[f] < preRequest[f]) failures.push(`${f} regressed between the detach request and its completion: ${preRequest[f]} → ${atCompletedDetach[f]}`);
  if (afterProgressCheck.facts !== atCompletedDetach.facts) failures.push(`facts moved after the COMPLETED detach: ${atCompletedDetach.facts} → ${afterProgressCheck.facts}`);
  if (afterProgressCheck.frames < atCompletedDetach.frames) failures.push(`frames regressed after the completed detach: ${atCompletedDetach.frames} → ${afterProgressCheck.frames}`);
  return { ok: failures.length === 0, failures };
}

/**
 * Coverage of a test-only bounded frame ring for an ABSENCE claim over the frames applied since `cutoffIndex` (a
 * monotonic frame index). The claim is admissible only if no frame at or after the cutoff fell out of the ring:
 * i.e. the ring is not full since the cutoff, or its lowest retained index is <= cutoff. Returns the reasons otherwise.
 */
export function ringCoverage({ cutoffIndex, firstRetainedIndex, nextIndex, evictedSinceCutoff }) {
  const failures = [];
  for (const [k, v] of Object.entries({ cutoffIndex, nextIndex })) if (!Number.isSafeInteger(v) || v < 0) failures.push(`${k} is not a nonnegative safe integer: ${String(v)}`);
  if (firstRetainedIndex !== null && (!Number.isSafeInteger(firstRetainedIndex) || firstRetainedIndex < 0)) failures.push(`firstRetainedIndex is invalid: ${String(firstRetainedIndex)}`);
  if (!Number.isSafeInteger(evictedSinceCutoff) || evictedSinceCutoff < 0) failures.push(`evictedSinceCutoff is invalid: ${String(evictedSinceCutoff)}`);
  if (failures.length) return { ok: false, failures };
  if (nextIndex < cutoffIndex) failures.push(`cutoff ${cutoffIndex} lies beyond the frames applied so far (${nextIndex})`);
  if (nextIndex > cutoffIndex && firstRetainedIndex === null) failures.push('frames were applied since the cutoff but none is retained');
  if (firstRetainedIndex !== null && firstRetainedIndex > cutoffIndex) failures.push(`frames ${cutoffIndex}..${firstRetainedIndex - 1} applied since the cutoff fell out of the ring (${evictedSinceCutoff} evicted)`);
  return { ok: failures.length === 0, failures };
}
