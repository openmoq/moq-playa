/** Real byte assembly with an observable source double; no native playback proof. */
import { describe, expect, it, vi } from 'vitest';
import type { MediaAppendObserver, MediaSourceLike } from '../../packages/player/src/interfaces.js';
import type { ProgramSwitchVariant } from './program-switch.fixture.mjs';
import { observeMseProgramSwitch } from './mse-program-switch-observer.mjs';
import { buildInit, buildChunk, SYNC_FLAGS } from '../../packages/locmaf/test-support/cmaf.js';
import { readFirstSamplePresentationTime } from '../../packages/browser/src/mp4-box.js';

function sourceDouble() {
  const listeners = new Set<MediaAppendObserver>();
  const lease = { current: true, resume: vi.fn(), discard: vi.fn() };
  const append = vi.fn<MediaSourceLike['appendChunk']>();
  const hold = vi.fn<NonNullable<MediaSourceLike['holdQueuedAppends']>>(() => lease);
  const source: MediaSourceLike = {
    supportsTrackIdentity: true, initialize() {}, appendChunk: append, holdQueuedAppends: hold,
    observeAppends(observer) { listeners.add(observer); return () => { listeners.delete(observer); }; },
    getTimestampOffset: () => 3.75, setTimestampOffset: vi.fn(),
    reset() {}, destroy() {}, endOfStream() {}, mediaElement: null, onFirstFrame: null, onError: null, onStall: null,
  };
  return { source, append, hold, lease, listeners };
}
const input = () => buildChunk({ trackId: 1, bmdt: 8_100_000n,
  samples: [{ duration: 3750, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(1, 2, 3, 4) });

it.each([false, true])('binds actual raw/rebased bytes, native offset and only a real append terminal; supplied token %s', supplied => {
  const f = sourceDouble(), sensor = observeMseProgramSwitch();
  expect(sensor.source(f.source)).toBe(f.source);
  const token = {}, producing = {}, sourceKey = JSON.stringify([['live', 'next'], 'video']);
  let inputs: readonly (object | undefined)[] | undefined;
  const assembler = sensor.createAssembler({ onSegment(type, bytes, name, group, units, key) {
    inputs = units;
    f.source.appendChunk(type, bytes, name, group, supplied ? token : undefined, key);
  } });
  assembler.setInitSegment?.('video', buildInit({ trackId: 1, timescale: 90000, handler: 'vide' }));
  const bytes = input(), before = bytes.slice();
  try {
    const result = assembler.push('video', 'video', 7n, bytes, producing, true, sourceKey);
    const placement=assembler.capturePresentationPlacement?.('video');
    expect(placement?.token).toBeDefined();
    expect(result).toEqual({ state: 'emitted', sourcePresentationTimeUs: 90_000_000n,
      sourceDecodeTime: {timeUs:90_000_000n,timescale:90_000,placementToken:placement!.token} });
    expect(bytes).toEqual(before);
    expect(inputs?.[0]).toBe(producing);
    const call = f.append.mock.calls[0]!;
    expect(call[2]).toBe('video'); expect(call[5]).toBe(sourceKey);
    expect(readFirstSamplePresentationTime(call[1])).toBe(0n);
    expect(call[4]).toBe(supplied ? token : call[4]);
    expect(typeof call[4]).toBe('object');
    expect(sensor.snapshot().segments).toMatchObject([{ rawPtsTicks: '8100000', rebasedPtsTicks: '0', endTicks: '3750',
      timescale: 90000, sourceKey, offset: 3.75, state: 'submitted', completedAtMs: null }]);
    for (const listener of f.listeners) void listener({ token: call[4]!, state: 'appended', reason: null });
    expect(sensor.snapshot().segments[0]!.state).toBe('appended');
    expect(sensor.snapshot().segments[0]!.completedAtMs).not.toBeNull();
    expect(sensor.snapshot().failures).toEqual([]);
    expect(f.source.setTimestampOffset).not.toHaveBeenCalled();
    const snapshot = sensor.snapshot(); snapshot.segments[0]!.rawPtsTicks = 'fabricated';
    expect(sensor.snapshot().segments[0]!.rawPtsTicks).toBe('8100000');
    for (const listener of f.listeners) void listener({ token: call[4]!, state: 'appended', reason: null });
    expect(sensor.snapshot().failures).toContain('duplicate append terminal');
  } finally { assembler.destroy(); sensor.dispose(); }
  expect(f.source.appendChunk).toBe(f.append); expect(f.source.holdQueuedAppends).toBe(f.hold); expect(f.listeners.size).toBe(0);
});

function facade() {
  const reference = { token: {}, domain: 'media-time' as const, observedSourceTimeUs: 123n,
    track: { name: 'audio-en', namespaceFields: ['local'] } };
  const player: Parameters<ReturnType<typeof observeMseProgramSwitch>['pageHooks']>[0] = {
    programs: [{ id: 'p2', label: 'next', renderGroup: 2, views: [], audioTracks: [] }],
    views: [{ id: 'v4', label: 'view', levels: [{ index: 0, trackName: 'video-720', label: 'view', codec: 'avc1.42c01e', width: 640, height: 360, bitrate: 100000 }] }],
    mediaTimelineReference: reference, selectProgram: vi.fn(async () => {}), selectView: vi.fn(async () => {}),
  };
  return { player, reference };
}
function variant(): ProgramSwitchVariant {
  const t = (name: string) => ({ name, role: 'video' as const, renderGroup: 1, altGroup: 1, sourceTrack: name, offsetUs: '0',
    firstPresentationTimeUs: '0', firstLocTimeUs: '0', timescale: 90000, samples: 1, compositionOffsetsTicks: [0], durationTicks: [3750] });
  return { kind: 'header-timing-rewrite', metadataOnly: false, mediaBytesUnchanged: false, encodedPayloadUnchanged: true,
    tracks: { oldVideo: t('video-360'), oldAudio: { ...t('audio-en'), role: 'audio' }, nextVideo: t('video-1080'),
      nextAudio: { ...t('audio-es'), role: 'audio' }, viewVideo: t('video-720') },
    maps: { program: { video: { sourceTimeUs: '90000000', referenceTimeUs: '0' }, audio: { sourceTimeUs: '900000000', referenceTimeUs: '0' } },
      view: { video: { sourceTimeUs: '700000000', referenceTimeUs: '0' } } }, fileHashes: {}, encodedPayloadProof: {}, timingEvidence: 'unit control' };
}

describe('optional queue refusal and public facade bridge', () => {
  it('refuses exactly once before queue acquisition, then delegates unchanged and restores', () => {
    const f = sourceDouble(), sensor = observeMseProgramSwitch(), { player } = facade();
    sensor.source(f.source);
    const hooks = sensor.pageHooks(player), roles = ['video', 'audio'] as const;
    hooks.armMseQueueRefusal();
    expect(() => f.source.holdQueuedAppends?.(roles)).toThrow('MSE acceptance injected queue acquisition refusal');
    expect(f.hold).not.toHaveBeenCalled();
    expect(f.source.holdQueuedAppends?.(roles)).toBe(f.lease);
    expect(f.hold.mock.calls[0]![0]).toBe(roles);
    expect(sensor.snapshot().queues.map(item => item.kind)).toEqual(['refused', 'acquire']);
    expect(() => hooks.armMseQueueRefusal()).toThrow();
    sensor.dispose(); sensor.dispose();
    expect(f.source.holdQueuedAppends).toBe(f.hold);
  });
  it.each(['program', 'view'] as const)('uses the actual canonical token and public %s selector, retaining a receipt on refusal', async mode => {
    const f = sourceDouble(), sensor = observeMseProgramSwitch(), { player, reference } = facade();
    sensor.source(f.source);
    const selected = mode === 'program' ? player.selectProgram : player.selectView;
    vi.mocked(selected).mockRejectedValueOnce(new Error('MSE acceptance injected queue acquisition refusal'));
    const result = await sensor.pageHooks(player).selectMseMapped(mode, variant());
    expect(result.refusal).toBe('MSE acceptance injected queue acquisition refusal');
    expect(result.timeline).toMatchObject({ id: mode === 'program' ? 'p2' : 'v4', track: reference.track, observedSourceTimeUs: '123' });
    const call = vi.mocked(selected).mock.calls[0]!;
    expect(call[1]?.timeline?.kind).toBe('reference-map');
    if (call[1]?.timeline?.kind === 'reference-map') expect(call[1].timeline.referenceToken).toBe(reference.token);
    expect(JSON.stringify(result)).not.toContain('referenceToken');
    sensor.dispose();
  });
  it('fails closed on replacement sources, unknown bytes and bounded history overflow', () => {
    const f = sourceDouble(), sensor = observeMseProgramSwitch(); sensor.source(f.source);
    f.source.appendChunk('video', input(), 'unknown', 0n);
    expect(sensor.snapshot().failures).toContain('submission without matching assembler bytes');
    sensor.source(sourceDouble().source);
    expect(sensor.snapshot().failures).toContain('missing or replaced observable native source');
    for (let i = 0; i < 34; i++) f.source.holdQueuedAppends?.(['video']);
    expect(sensor.snapshot().queues).toHaveLength(32);
    expect(sensor.snapshot().overflow).toBe(true);
    sensor.dispose();
  });
});
