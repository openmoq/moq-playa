import assert from 'node:assert/strict';
import { assessPlayback } from './assessment.mjs';

/** Observe native output while required replacement subscriptions remain pending. */
export async function checkHandover(page, controlUrl, expected, outcome, evidence, options = {}) {
  const reject = outcome !== 'accept';
  const control = async (path, method = 'GET') => {
    const response = await fetch(`${controlUrl}/${path}`, { method, signal: AbortSignal.timeout(5000) });
    const body = await response.json();
    assert.ok(response.ok, JSON.stringify(body));
    return body;
  };
  await page.evaluate(() => window.playerAcceptance.begin(false));
  await control('goaway', 'POST');
  const deadline = performance.now() + 5000;
  let pending;
  do {
    pending = await control('status');
    if (pending.held > 0) break;
    await page.waitForTimeout(50);
  } while (performance.now() < deadline);
  evidence.pending = pending;
  assert.ok(pending.held > 0, 'Replacement never issued the held request');
  assert.ok(pending.events.some(event => event.relay === 'target' && event.type === 'subscribe' && event.name === 'catalog'),
    'Replacement catalog request was not observed');
  if (outcome !== 'catalog-timeout') {
    assert.ok(pending.events.some(event => event.relay === 'target' && event.type === 'fetch'),
      'Replacement did not use catalog Joining FETCH');
    assert.ok(pending.events.some(event => event.relay === 'target' && event.type === 'subscribe' && event.name !== 'catalog'),
      'Replacement never reached media preparation');
  }
  await page.waitForTimeout(5250);
  const during = await page.evaluate(() => window.playerAcceptance.finish());
  evidence.during = during;
  const beforeRelease = await control('status');
  evidence.beforeRelease = beforeRelease;
  assert.equal(during.transportState.length, 2, 'Expected an old and a replacement transport');
  assert.equal(during.transportState[0].closedAtMs, null, 'Old transport closed before replacement acceptance');
  assert.deepEqual(during.events.filter(event => event.type === 'error'), [], 'Player error before replacement response');
  assert.ok(beforeRelease.objects.source > pending.objects.source, 'Old relay stopped delivering before replacement acceptance');
  assert.equal(beforeRelease.objects.target, pending.objects.target, 'Held replacement sent live objects');
  assert.ok(!beforeRelease.events.some(event => event.relay === 'target' && event.type === 'released' && event.name !== 'catalog'),
    'Replacement media acceptance was not held');
  assert.equal(beforeRelease.events.filter(event => event.relay === 'source' && event.type === 'unsubscribe').length, 0,
    'Old media unsubscribed before replacement acceptance');
  const continuity = assessPlayback(during.samples, expected);
  evidence.continuity = continuity;
  assert.deepEqual(continuity.failures, [], 'Old playback did not continue while replacement was pending');

  await page.evaluate(() => window.playerAcceptance.begin(false));
  await control('release', 'POST');
  await page.waitForFunction((reject) => {
    const state = window.playerAcceptance;
    return reject ? state.errors.length > 0 : state.transportState[0]?.closedAtMs !== null;
  }, reject, { timeout: 15000 });
  evidence.resolved = await control('status');
  await page.waitForTimeout(7250);
  const after = await page.evaluate(() => window.playerAcceptance.finish());
  evidence.after = after;
  const final = await control('status');
  evidence.relay = final;
  assert.deepEqual(final.errors, [], 'Local relay control failure');
  const playerErrors = after.events.filter(event => event.type === 'error');
  if (reject) {
    assert.equal(playerErrors.length, 1, 'Expected exactly one refused-handover diagnostic');
    assert.equal(playerErrors[0].data.severity, 'recoverable');
    assert.match(playerErrors[0].data.message, /migration|handover/i);
    assert.equal(after.transportState[0].closedAtMs, null, 'Refused replacement retired the old transport');
    assert.notEqual(after.transportState[1].closedAtMs, null, 'Refused replacement leaked its transport');
    if (outcome === 'reject') {
      assert.ok(final.events.some(event => event.relay === 'target' && event.type === 'refused'), 'Refusal control never executed');
    } else {
      // A relay forwards only new Objects to SUBSCRIBE (d18 §10.7), so the
      // subscription-only fallback never receives the published catalog.
      assert.match(playerErrors[0].data.message, /Handover timeout/i);
      assert.equal(final.events.filter(event => event.relay === 'target' && event.type === 'subscribe' && event.name !== 'catalog').length,
        0, 'Nonconforming catalog retrieval reached media preparation');
    }
  } else {
    assert.deepEqual(playerErrors, [], 'Player error during handover');
    assert.notEqual(after.transportState[0].closedAtMs, null, 'Old transport was never retired');
    assert.equal(after.transportState[1].closedAtMs, null, 'Replacement transport died');
    assert.ok(final.objects.target > evidence.resolved.objects.target, 'Replacement stopped delivering after adoption');
    const subscriptions = events => events.filter(event => event.relay === 'target' && event.type === 'subscribe');
    const requested = subscriptions(final.events);
    assert.deepEqual(requested, subscriptions(evidence.resolved.events), 'Adoption initiated another subscription');
    assert.deepEqual(requested.filter(event => event.name !== 'catalog').map(event => event.name).sort(),
      ['audio-en', 'video-360'], 'Adoption repeated or lost a required media subscription');
    const cancelled = new Set(final.events.filter(event => event.relay === 'target' && event.type === 'unsubscribe')
      .map(event => event.requestId));
    // The deliberate hold can trigger catalog retries before readiness. Only
    // one catalog subscription may survive; none may restart after adoption.
    assert.equal(requested.filter(event => event.name === 'catalog' && !cancelled.has(event.requestId)).length, 1,
      'Expected exactly one surviving catalog subscription');
  }
  const playback = assessPlayback(after.samples, expected);
  evidence.playback = playback;
  assert.deepEqual(playback.failures, [], 'Playback failed across handover');
  if (options.timelineContinuity) checkTimelineContinuity(during, after, evidence);
}

/**
 * One presentation timeline across the switch.
 *
 * A retained media origin that is mis-scaled when a replacement's
 * initialization changes the timescale places the new media at the wrong
 * decode time. The symptom is a buffered SET that splits, or a playhead that
 * leaves the range it is being fed from — not a buffer start that moves.
 * Normal back-buffer eviction advances the start, so requiring it to stay put
 * would reject healthy playback.
 */
function checkTimelineContinuity(during, after, evidence) {
  const ranges = (sample) => sample.bufferedRanges ?? [];
  const held = during.samples.at(-1);
  const last = after.samples.at(-1);
  const continuity = {
    heldEnd: ranges(held).at(-1)?.end ?? null,
    finalEnd: ranges(last).at(-1)?.end ?? null,
    heldMediaTimeS: held.mediaTimeS,
    finalMediaTimeS: last.mediaTimeS,
    maxRanges: Math.max(...after.samples.map((s) => ranges(s).length)),
    startsSeen: [...new Set(after.samples.map((s) => ranges(s)[0]?.start ?? null))],
  };
  evidence.timelineContinuity = continuity;
  assert.ok(continuity.finalEnd !== null, 'Expected buffered ranges on the MSE path');

  // Forward media time, with no restart at the seam.
  let previous = held.mediaTimeS;
  for (const sample of after.samples) {
    assert.ok(sample.mediaTimeS >= previous - 0.05,
      `Media time went backwards across the handover: ${previous} → ${sample.mediaTimeS}`);
    previous = sample.mediaTimeS;
  }
  assert.ok(continuity.finalMediaTimeS > continuity.heldMediaTimeS + 1,
    'Playhead did not advance after adopting the replacement');

  // The replacement's media joins the SAME range the old source filled, and
  // keeps extending it. A mis-scaled origin lands elsewhere and splits the set.
  assert.equal(continuity.maxRanges, 1,
    `Replacement media split the buffered set into ${continuity.maxRanges} ranges`);
  assert.ok(continuity.finalEnd > continuity.heldEnd,
    `Buffered end did not advance after adoption: ${continuity.heldEnd} → ${continuity.finalEnd}`);

  // The playhead stays inside what is actually buffered — the relationship a
  // wrongly placed replacement breaks even when a range still exists.
  for (const sample of after.samples) {
    const range = ranges(sample).find((r) => sample.mediaTimeS >= r.start - 0.5 && sample.mediaTimeS <= r.end + 0.5);
    assert.ok(range, `Playhead ${sample.mediaTimeS} outside buffered ${JSON.stringify(ranges(sample))}`);
  }
}
