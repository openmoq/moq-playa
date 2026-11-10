/**
 * `--net-shape PRESET` wins over `PLAYER_NET_SHAPE`; neither leaves the run
 * unshaped. The shaper lives outside the acceptance overlay that tail
 * campaigns copy onto older baselines, so it is loaded only when asked for.
 */
export async function netShapeOption(argv, env) {
  const index = argv.indexOf('--net-shape');
  const preset = index >= 0 ? argv[index + 1] : env.PLAYER_NET_SHAPE || null;
  if (preset === null) return null;
  const { netShapePresets } = await import(new URL('../net-shaper/presets.mjs', import.meta.url).href);
  if (!Object.hasOwn(netShapePresets, preset)) {
    throw new Error(`Unknown net shape ${preset}; known: ${Object.keys(netShapePresets).join(', ')}`);
  }
  const seconds = Number(env.PLAYER_NET_SHAPE_SECONDS ?? 45);
  if (!Number.isFinite(seconds * 1000) || !(seconds > 0)) throw new Error('PLAYER_NET_SHAPE_SECONDS must be finite and positive');
  const seed = Number(env.PLAYER_NET_SHAPE_SEED ?? 1);
  if (!Number.isSafeInteger(seed)) throw new Error('PLAYER_NET_SHAPE_SEED must be a safe integer');
  return { preset, params: netShapePresets[preset], durationMs: seconds * 1000, seed };
}

/** The browser dials the shaper; only the port differs, so the pinned certificate hash is unchanged. */
export function shapedUrl(relayUrl, port) {
  const url = new URL(relayUrl);
  url.port = String(port);
  return url.href;
}

/**
 * One time base for the browser and the shaper: seconds since the downlink's
 * first packet, which is also the origin of any capacity schedule.
 */
export function summarizeAbrTrace(trace, shaper) {
  const origin = shaper?.down.firstPacketMs != null ? shaper.startedAtEpochMs + shaper.down.firstPacketMs : null;
  const at = event => {
    const epochMs = trace.timeOrigin + event.timeMs;
    return Math.round((origin === null ? epochMs - trace.timeOrigin : epochMs - origin)) / 1000;
  };
  const switches = trace.events.filter(event => event.type === 'quality_switched')
    .map(event => ({ atS: at(event), from: event.data.fromTrackName, to: event.data.toTrackName, reason: event.data.reason }));
  // A retry loop can fail the same switch thousands of times; keep one row per run of repeats.
  const failedSwitches = [];
  for (const event of trace.events.filter(event => event.type === 'quality_switch_failed')) {
    const row = { atS: at(event), from: event.data.fromTrackName, to: event.data.toTrackName, reason: event.data.reason, error: event.data.error };
    const last = failedSwitches.at(-1);
    if (last && ['from', 'to', 'reason', 'error'].every(key => last[key] === row[key])) { last.repeats++; last.lastAtS = row.atS; }
    else failedSwitches.push({ ...row, repeats: 1, lastAtS: row.atS });
  }
  const stalls = trace.events.filter(event => event.type === 'stall')
    .map(event => ({ atS: at(event), detectedAfterMs: event.data.durationMs, ...(event.data.cause ? { cause: event.data.cause } : {}) }));
  const recoveries = trace.events.filter(event => event.type === 'stall_recovered')
    .map(event => ({ atS: at(event), durationMs: event.data.durationMs }));
  const ages = trace.events.filter(event => event.type === 'stats' && Number.isFinite(event.data.captureTimestampAgeMs))
    .map(event => ({ atS: at(event), ageMs: event.data.captureTimestampAgeMs }));
  const down = shaper?.down;
  // Delivery is bursty per fragment, so 100 ms samples alias; report 1 s means.
  const perSecond = [];
  for (const sample of down?.timeline ?? []) {
    if (down.firstPacketMs === null || sample.tMs < down.firstPacketMs) continue;
    const second = Math.floor((sample.tMs - down.firstPacketMs) / 1000);
    (perSecond[second] ??= []).push(sample);
  }
  const downlinkMbps = Array.from(perSecond, samples => samples ? Math.round(samples.reduce((sum, item) => sum + item.deliveredBps, 0)
    / samples.length / 1e4) / 100 : null);
  const queueMaxBytes = Array.from(perSecond, samples => samples ? Math.max(...samples.map(item => item.queueBytes)) : null);
  return {
    timeBase: origin === null ? 'page timeOrigin' : 'shaper downlink first packet',
    switches, failedSwitches, stalls, recoveries,
    stalledMs: recoveries.reduce((sum, item) => sum + item.durationMs, 0),
    captureAge: ages.length ? { samples: ages.length, maxMs: Math.max(...ages.map(item => item.ageMs)), last: ages.at(-1) } : null,
    ...(down ? { shaper: { deliveredBps: down.deliveredBps, deliveredPackets: down.deliveredPackets,
      lossPackets: down.lossPackets, tailPackets: down.tailPackets, maxQueueBytes: down.queue.maxBytes,
      latenessP99Ms: down.lateness.p99Ms, latenessMaxMs: down.lateness.maxMs, downlinkMbps, queueMaxBytes } } : {}),
  };
}

/** Audio level above which a sample counts as audible (the startup check's bound). */
export const AUDIBLE_RMS = 0.015;
/** Required RMS-positive fraction of valid cadence observations. */
export const MIN_AUDIBLE_FRACTION = 0.8;

/**
 * Sampled output evidence for an already-playing, expected-audio fixture.
 * The caller declares its clock window, minimum duration and timer cadence.
 * Each nominal cadence slot admits at most one observation; every complete
 * interior slot must be present. The final partial slot is optional. This
 * tolerates nearest-slot scheduling skew without counting bursts as coverage.
 * Boundary/adjacent gaps can approach twice the period; the result reports them.
 * RMS-positive sample fraction is not an audible-time or speaker measurement.
 */
export function assessAudioContinuity(samples, observation) {
  const invalid = reason => ({samples: Array.isArray(samples) ? samples.length : 0,
    evidenceValid: false, audibleFraction: null, longestSilentObservationSpanMs: null,
    passed: false, failures: [reason]});
  if (!observation) return invalid('observation window required');
  const {startMs, endMs, minimumDurationMs, samplePeriodMs} = observation;
  if (![startMs,endMs,minimumDurationMs,samplePeriodMs].every(Number.isFinite)
      || startMs < 0 || endMs <= startMs || minimumDurationMs <= 0 || samplePeriodMs <= 0) {
    return invalid('invalid observation window');
  }
  const durationMs = endMs - startMs;
  if (durationMs < minimumDurationMs) return invalid('observation shorter than requested duration');
  const requiredSlots = Math.floor((durationMs - samplePeriodMs / 2) / samplePeriodMs) + 1;
  const lastSlot = Math.round(durationMs / samplePeriodMs);
  if (!Number.isSafeInteger(requiredSlots) || requiredSlots < 2 || !Number.isSafeInteger(lastSlot)) {
    return invalid('observation window cannot establish sampling cadence');
  }
  if (!Array.isArray(samples)) return invalid('observations must be an array');
  const slots = new Set();
  let requiredObserved = 0, previousMs = null, audible = 0;
  let longestSilentObservationSpanMs = 0, silenceStartMs = null, maxObservedGapMs = 0;
  for (const sample of samples) {
    if (sample === null || typeof sample !== 'object') return invalid('invalid observation record');
    const {wallMs, audioRms} = sample;
    if (!Number.isFinite(wallMs) || !Number.isFinite(audioRms) || audioRms < 0) {
      return invalid('invalid sample time or RMS');
    }
    if (wallMs < startMs || wallMs > endMs) return invalid('sample outside observation window');
    if (previousMs !== null && wallMs <= previousMs) return invalid('sample time is not strictly increasing');
    const slot = Math.round((wallMs - startMs) / samplePeriodMs);
    if (!Number.isSafeInteger(slot) || slot < 0 || slot > lastSlot) return invalid('sample outside cadence range');
    if (slots.has(slot)) return invalid('multiple observations in one cadence slot');
    slots.add(slot);
    if (slot < requiredSlots) requiredObserved++;
    maxObservedGapMs = Math.max(maxObservedGapMs, wallMs - (previousMs ?? startMs));
    previousMs = wallMs;
    if (audioRms > AUDIBLE_RMS) { audible++; silenceStartMs = null; }
    else {
      silenceStartMs ??= wallMs;
      longestSilentObservationSpanMs = Math.max(longestSilentObservationSpanMs, wallMs - silenceStartMs);
    }
  }
  if (requiredObserved !== requiredSlots) return invalid('observation window has uncovered cadence slots');
  maxObservedGapMs = Math.max(maxObservedGapMs, endMs - previousMs);
  const audibleFraction = audible / samples.length;
  const passed = audibleFraction >= MIN_AUDIBLE_FRACTION;
  return {samples: samples.length, evidenceValid: true, audibleFraction,
    longestSilentObservationSpanMs, maxObservedGapMs, requiredSlots, observedSlots: slots.size,
    passed, failures: passed ? [] : ['RMS-positive sample fraction below the required fraction']};
}

/**
 * Calibration run, not a quality gate: let ABR react to the shaped link for
 * the configured time while the ordinary observer keeps sampling output.
 */
export async function observeShapedAbr(page, evidence, durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('Observation duration must be finite and positive');
  evidence.initialSelection = await page.evaluate(() => window.playerAcceptance.selection);
  await page.evaluate(duration => window.playerAcceptance.begin(false, duration), durationMs);
  const deadline = Date.now() + durationMs;
  evidence.levels = [];
  while (Date.now() < deadline) {
    await page.waitForTimeout(Math.min(1000, Math.max(0, deadline - Date.now())));
    const { currentLevel } = await page.evaluate(() => window.playerAcceptance.selection);
    if (evidence.levels.at(-1)?.level !== currentLevel) evidence.levels.push({ atMs: Date.now(), level: currentLevel });
  }
  return page.evaluate(() => window.playerAcceptance.finish());
}
