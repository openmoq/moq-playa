import { describe, expect, it, vi } from 'vitest';
import type { AudioOutputLike, AudioProducedTiming, AudioScheduleObservation, AudioScheduleObserver } from './interfaces.js';
import { FrameAudioOutput } from './frame-audio-output.js';

describe('staging native retirement', () => {
  it.each([false, true])('relays exactly the known terminal and retires callbacks despite native/off failures: %s', throws => {
    const events: AudioScheduleObservation[] = [], known = {}, foreign = {}, epoch = {};
    const data = { numberOfFrames: 480, numberOfChannels: 2, sampleRate: 48_000, close: vi.fn() };
    const incoming = { ...data, close: vi.fn() };
    const nativeFailure = new Error('native destroy'), offFailure = new Error('native off');
    const nativeOff = vi.fn(); let saved: AudioScheduleObserver | undefined;
    const target: AudioOutputLike = {
      supportsOutputTiming: true, currentPlayoutTimeUs: 123, flush: vi.fn(),
      schedule: vi.fn(() => { data.close(); saved?.({ token: known, state: 'scheduled', reason: null }); }),
      destroy: vi.fn(), setPlaybackRate: vi.fn(),
      sampleSourcePosition: vi.fn(() => ({ epoch, sourceTimestampUs: 900n, sourceOffsetUs: 0 })),
      playheadCaptureUs: vi.fn(() => 900),
      observeSchedules(observer) {
        saved = observer;
        return () => {
          nativeOff(); observer({ token: known, state: 'released', reason: null });
          if (throws) throw offFailure;
        };
      },
    };
    const output = new FrameAudioOutput({ target, maxChunks: 2, maxBytes: 4096 });
    const release = output.observeSchedules(event => { events.push(event); if (event.state === 'released') output.destroy(); });
    const proof: AudioProducedTiming = { context: { epoch, sourceTimestampUs: 0n,
      presentFromSourceUs: 0n, recomputeRenderTimeUs: () => 0 }, sourceOffsetUs: 0 };
    output.schedule(data, 0, known, proof); output.activate();
    const inside: { retained?: number; head?: unknown; playhead?: number | null; scalar?: number; rejected?: boolean } = {};
    const lateListener = vi.fn();
    vi.mocked(target.destroy).mockImplementation(() => {
      inside.retained = output.retainedChunkCount;
      inside.head = output.sampleSourcePosition(epoch);
      inside.playhead = output.playheadCaptureUs(); inside.scalar = output.currentPlayoutTimeUs;
      output.activate(); output.setPlaybackRate(1.25); output.observeSchedules(lateListener);
      try { output.schedule(incoming, 0, undefined, proof); inside.rejected = false; }
      catch { inside.rejected = true; }
      saved?.({ token: foreign, state: 'released', reason: null });
      saved?.({ token: known, state: 'scheduled', reason: null });
      saved?.({ token: known, state: 'released', reason: null });
      saved?.({ token: known, state: 'discarded', reason: 'destroyed' });
      if (throws) throw nativeFailure;
    });
    let failure: unknown;
    try { output.destroy(); } catch (error) { failure = error; }
    // A late event after cleanup, including a still-known token in the old
    // implementation, cannot regain callback or source-position authority.
    saved?.({ token: known, state: 'released', reason: null }); release(); output.destroy();
    expect(events).toEqual([{ token: known, state: 'scheduled', reason: null }, { token: known, state: 'released', reason: null }]);
    expect(inside).toEqual({ retained: 0, head: null, playhead: null, scalar: NaN, rejected: true });
    expect(failure).toBe(throws ? nativeFailure : undefined);
    expect(nativeOff).toHaveBeenCalledTimes(1); expect(target.destroy).toHaveBeenCalledTimes(1);
    expect(target.schedule).toHaveBeenCalledTimes(1); expect(target.setPlaybackRate).not.toHaveBeenCalled();
    expect(target.sampleSourcePosition).not.toHaveBeenCalled(); expect(target.playheadCaptureUs).not.toHaveBeenCalled();
    expect(data.close).toHaveBeenCalledTimes(1); expect(incoming.close).toHaveBeenCalledTimes(1);
    expect(lateListener).not.toHaveBeenCalled(); expect(output.sampleSourcePosition(epoch)).toBeNull();
  });
});

describe('staging observer getter ownership', () => {
  it.each([false, true])('preserves the native terminal for PCM forwarded during method-getter registration: %s', reenter => {
    const native = new Set<AudioScheduleObserver>(), token = {}, epoch = {};
    const first: AudioScheduleObservation[] = [], second: AudioScheduleObservation[] = [];
    const data = { numberOfFrames: 480, numberOfChannels: 2, sampleRate: 48_000, close: vi.fn() };
    const proof: AudioProducedTiming = { context: { epoch, sourceTimestampUs: 0n,
      presentFromSourceUs: 0n, recomputeRenderTimeUs: () => 0 }, sourceOffsetUs: 0 };
    let secondOff: (() => void) | undefined, armed = reenter;
    const observer = (event: AudioScheduleObservation) => { second.push(event); };
    const register = vi.fn((listener: AudioScheduleObserver) => {
      native.add(listener); return () => { native.delete(listener); };
    });
    const target: AudioOutputLike = {
      supportsOutputTiming: true, currentPlayoutTimeUs: 0, flush: vi.fn(),
      schedule: vi.fn(() => { data.close(); for (const listener of [...native]) listener({ token, state: 'scheduled', reason: null }); }),
      destroy: vi.fn(() => {
        for (const listener of [...native]) listener({ token, state: 'released', reason: null });
        native.clear();
      }),
      get observeSchedules() {
        if (armed) {
          armed = false;
          secondOff = output.observeSchedules(observer);
          output.schedule(data, 0, token, proof);
        }
        return register;
      },
    };
    const output = new FrameAudioOutput({ target, maxChunks: 2, maxBytes: 4096 });
    output.activate();
    const firstOff = output.observeSchedules(event => { first.push(event); });
    if (!reenter) {
      secondOff = output.observeSchedules(observer);
      output.schedule(data, 0, token, proof);
    }
    output.destroy(); firstOff(); secondOff?.();
    expect({ nativeRegistrations: register.mock.calls.length,
      firstStates: first.map(event => event.state), secondStates: second.map(event => event.state) }).toEqual({
      nativeRegistrations: 1, firstStates: ['scheduled', 'released'], secondStates: ['scheduled', 'released'],
    });
    expect(target.destroy).toHaveBeenCalledTimes(1); expect(data.close).toHaveBeenCalledTimes(1);
  });
});
