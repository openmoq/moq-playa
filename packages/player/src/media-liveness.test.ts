import { describe, expect, it, vi } from 'vitest';
import { MediaLivenessMonitor } from './media-liveness.js';

const VIDEO = { requestId: 4n, trackAlias: 100n, mediaType: 'video' as const, trackName: 'video-hi' };
const AUDIO = { requestId: 6n, trackAlias: 101n, mediaType: 'audio' as const, trackName: 'audio' };

function monitor(overrides?: { livenessTimeoutMs?: number; resetProbeMs?: number }) {
  const onStarved = vi.fn();
  const m = new MediaLivenessMonitor({
    livenessTimeoutMs: overrides?.livenessTimeoutMs ?? 10_000,
    resetProbeMs: overrides?.resetProbeMs ?? 2_000,
    onStarved,
  });
  return { m, onStarved };
}

describe('MediaLivenessMonitor', () => {
  it('does not fire for a registered track before its first object (startup watchdog territory)', () => {
    const { m, onStarved } = monitor();
    m.registerTrack(VIDEO);

    m.check(60_000); // way past any timeout — but the track never armed
    expect(onStarved).not.toHaveBeenCalled();
  });

  it('arms on first arrival and fires once when the track starves', () => {
    const { m, onStarved } = monitor();
    m.registerTrack(VIDEO);

    m.noteArrival(VIDEO.trackAlias, 1_000);
    m.check(10_000); // 9s since arrival — healthy
    expect(onStarved).not.toHaveBeenCalled();

    m.check(11_001); // 10.001s — starved
    expect(onStarved).toHaveBeenCalledOnce();
    expect(onStarved.mock.calls[0]![0]).toMatchObject({ requestId: 4n, trackName: 'video-hi' });

    m.check(20_000); // still starved — same incident, no re-fire
    expect(onStarved).toHaveBeenCalledOnce();
  });

  it('tracks starve independently — one dead track fires while the other flows', () => {
    const { m, onStarved } = monitor();
    m.registerTrack(VIDEO);
    m.registerTrack(AUDIO);

    m.noteArrival(VIDEO.trackAlias, 1_000);
    m.noteArrival(AUDIO.trackAlias, 1_000);
    m.noteArrival(AUDIO.trackAlias, 11_000); // audio keeps flowing

    m.check(11_500);
    expect(onStarved).toHaveBeenCalledOnce();
    expect(onStarved.mock.calls[0]![0]).toMatchObject({ mediaType: 'video' });
  });

  it('an arrival resolves the incident and re-arms detection', () => {
    const { m, onStarved } = monitor();
    m.registerTrack(VIDEO);

    m.noteArrival(VIDEO.trackAlias, 1_000);
    m.check(11_001);
    expect(onStarved).toHaveBeenCalledOnce();

    m.noteArrival(VIDEO.trackAlias, 12_000); // recovered
    m.check(13_000);
    expect(onStarved).toHaveBeenCalledOnce(); // healthy — nothing new

    m.check(22_001); // starves again 10.001s after the recovery arrival
    expect(onStarved).toHaveBeenCalledTimes(2);
  });

  it('a stream reset shortens the fuse to resetProbeMs instead of the full timeout', () => {
    const { m, onStarved } = monitor();
    m.registerTrack(VIDEO);

    m.noteArrival(VIDEO.trackAlias, 1_000);
    m.noteStreamReset(VIDEO.trackAlias, 1_500);

    m.check(3_000); // 1.5s after the reset — within the 2s probe
    expect(onStarved).not.toHaveBeenCalled();

    m.check(3_501); // 2.001s after the reset — successor stream never delivered
    expect(onStarved).toHaveBeenCalledOnce();
  });

  it('a healthy successor stream clears the reset fuse', () => {
    const { m, onStarved } = monitor();
    m.registerTrack(VIDEO);

    m.noteArrival(VIDEO.trackAlias, 1_000);
    m.noteStreamReset(VIDEO.trackAlias, 1_500);
    m.noteArrival(VIDEO.trackAlias, 2_000); // successor delivered — benign reset

    m.check(3_501);
    expect(onStarved).not.toHaveBeenCalled();
    m.check(12_001); // …and the normal timeout anchors to the new arrival
    expect(onStarved).toHaveBeenCalledOnce();
  });

  it('a reset on a not-yet-armed track does not arm the fuse', () => {
    const { m, onStarved } = monitor();
    m.registerTrack(VIDEO);

    m.noteStreamReset(VIDEO.trackAlias, 500); // no object ever arrived
    m.check(60_000);
    expect(onStarved).not.toHaveBeenCalled();
  });

  it('retired tracks neither fire nor accept stale-alias arrivals', () => {
    const { m, onStarved } = monitor();
    m.registerTrack(VIDEO);
    m.noteArrival(VIDEO.trackAlias, 1_000);
    m.retireTrack(VIDEO.requestId);

    m.check(20_000);
    expect(onStarved).not.toHaveBeenCalled();

    // Alias reuse: a NEW subscription re-registers the same alias. A stale
    // arrival must stamp the new entry only from the moment it's registered.
    const fresh = { ...VIDEO, requestId: 9n };
    m.registerTrack(fresh);
    m.check(40_000); // fresh entry unarmed — quiet
    expect(onStarved).not.toHaveBeenCalled();
    m.noteArrival(VIDEO.trackAlias, 40_000);
    m.check(50_001);
    expect(onStarved).toHaveBeenCalledOnce();
    expect(onStarved.mock.calls[0]![0]).toMatchObject({ requestId: 9n });
  });

  it('re-registering an alias re-points stamping to the new subscription (quality switch)', () => {
    const { m, onStarved } = monitor();
    m.registerTrack(VIDEO);
    m.noteArrival(VIDEO.trackAlias, 1_000);

    // Switch: same alias re-registered under a new requestId before the old
    // requestId is retired (make-before-break ordering). The old entry is
    // NOT retired implicitly — the player's per-tick reconcile retires it —
    // but stamping must already resolve to the NEW entry, and the explicit
    // retire must not clobber the re-pointed alias mapping.
    m.registerTrack({ requestId: 12n, trackAlias: VIDEO.trackAlias, mediaType: 'video', trackName: 'video-lo' });
    m.retireTrack(VIDEO.requestId);

    m.noteArrival(VIDEO.trackAlias, 2_000);
    m.check(12_001);
    expect(onStarved).toHaveBeenCalledOnce();
    expect(onStarved.mock.calls[0]![0]).toMatchObject({ requestId: 12n, trackName: 'video-lo' });
  });

  it('re-registering the SAME requestId preserves arming state (reconcile idempotence)', () => {
    const { m, onStarved } = monitor();
    m.registerTrack(VIDEO);
    m.noteArrival(VIDEO.trackAlias, 1_000);

    // The player reconciles every tick — repeated registration of a live
    // subscription must not wipe lastArrivalMs (that would disarm detection).
    m.registerTrack(VIDEO);
    m.check(11_001);
    expect(onStarved).toHaveBeenCalledOnce();

    // Alias remap on SUBSCRIBE_OK: same requestId, new alias — stamps follow.
    m.registerTrack({ ...VIDEO, trackAlias: 200n });
    m.noteArrival(200n, 12_000);
    m.check(13_000);
    expect(onStarved).toHaveBeenCalledOnce(); // arrival resolved the incident
  });

  it('lastArrivalForTrack reports the newest arrival for a track name', () => {
    const { m } = monitor();
    m.registerTrack(VIDEO);
    expect(m.lastArrivalForTrack('video-hi', 'video')).toBeUndefined();
    m.noteArrival(VIDEO.trackAlias, 1_234);
    expect(m.lastArrivalForTrack('video-hi', 'video')).toBe(1_234);
  });

  it('livenessTimeoutMs of 0 disables detection entirely', () => {
    const { m, onStarved } = monitor({ livenessTimeoutMs: 0 });
    m.registerTrack(VIDEO);
    m.noteArrival(VIDEO.trackAlias, 1_000);
    m.noteStreamReset(VIDEO.trackAlias, 1_500);
    m.check(120_000);
    expect(onStarved).not.toHaveBeenCalled();
  });

  it('onStarved reports the duration of the healthy streak that preceded starvation', () => {
    const { m, onStarved } = monitor();
    m.registerTrack(VIDEO);
    // Uninterrupted streak: arrivals every 5s from t=1s to t=41s.
    for (let t = 1_000; t <= 41_000; t += 5_000) m.noteArrival(VIDEO.trackAlias, t);

    m.check(52_000); // starved 11s after the last arrival
    expect(onStarved).toHaveBeenCalledOnce();
    expect(onStarved.mock.calls[0]![2]).toBe(40_000); // 41s − 1s of healthy delivery
  });

  it('a liveness-sized gap breaks the healthy streak (no credit across gaps)', () => {
    const { m, onStarved } = monitor();
    m.registerTrack(VIDEO);
    m.noteArrival(VIDEO.trackAlias, 1_000);
    m.noteArrival(VIDEO.trackAlias, 20_000); // 19s gap > timeout — streak restarts here
    m.noteArrival(VIDEO.trackAlias, 25_000);

    m.check(36_000);
    expect(onStarved).toHaveBeenCalledOnce();
    expect(onStarved.mock.calls[0]![2]).toBe(5_000); // 25s − 20s, NOT 24s
  });

  it('reconcile registers new tracks, keeps known ones armed, retires gone ones', () => {
    const { m, onStarved } = monitor();
    m.reconcile([VIDEO, AUDIO]);
    m.noteArrival(VIDEO.trackAlias, 1_000);
    m.noteArrival(AUDIO.trackAlias, 1_000);

    // Audio unsubscribed; video survives reconcile with stamps intact.
    m.reconcile([VIDEO]);
    m.check(11_001);
    expect(onStarved).toHaveBeenCalledOnce(); // video only — audio retired
    expect(onStarved.mock.calls[0]![0]).toMatchObject({ mediaType: 'video' });
  });

  it('clear() retires everything (stop/destroy)', () => {
    const { m, onStarved } = monitor();
    m.registerTrack(VIDEO);
    m.registerTrack(AUDIO);
    m.noteArrival(VIDEO.trackAlias, 1_000);
    m.noteArrival(AUDIO.trackAlias, 1_000);
    m.clear();

    m.check(60_000);
    expect(onStarved).not.toHaveBeenCalled();
  });
});
