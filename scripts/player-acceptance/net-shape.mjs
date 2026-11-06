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
  if (!(seconds > 0)) throw new Error('PLAYER_NET_SHAPE_SECONDS must be positive');
  return { preset, params: netShapePresets[preset], durationMs: seconds * 1000, seed: Number(env.PLAYER_NET_SHAPE_SEED ?? 1) };
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

/**
 * Calibration run, not a quality gate: let ABR react to the shaped link for
 * the configured time while the ordinary observer keeps sampling output.
 */
export async function observeShapedAbr(page, evidence, durationMs) {
  evidence.initialSelection = await page.evaluate(() => window.playerAcceptance.selection);
  await page.evaluate(() => window.playerAcceptance.begin(false));
  const deadline = Date.now() + durationMs;
  evidence.levels = [];
  while (Date.now() < deadline) {
    await page.waitForTimeout(Math.min(1000, Math.max(0, deadline - Date.now())));
    const { currentLevel } = await page.evaluate(() => window.playerAcceptance.selection);
    if (evidence.levels.at(-1)?.level !== currentLevel) evidence.levels.push({ atMs: Date.now(), level: currentLevel });
  }
  return page.evaluate(() => window.playerAcceptance.finish());
}
