import { describe, expect, it, vi } from 'vitest';
import { MediaStageObservers } from './media-stage-observers.js';
import type { MediaDiagnosticRuntime, MediaDiagnosticsFactory, MediaStageObserver } from './media-diagnostic-types.js';

const host = { currentConnection: null, observeConnections: () => () => {} };
function runtime(): MediaDiagnosticRuntime {
  return { decodedVideoCount: 0, decodedAudioCount: 0, decoded: () => undefined, unobservableVideoCount: 0, unobservableAudioCount: 0, refusedReconstructionCount: 0, refusedVideoCount: 0, refusedAudioCount: 0, capture: () => undefined, discarded: () => {}, reconstruct: () => undefined,
    bindMediaSource: () => {}, appendToken: () => undefined, discardUnit: () => {}, dispose: vi.fn(), evidenceLossCount: 0, unobservableAppendCount: 0, unattributedInputCount: 0 };
}
const event = { unit: null, inputs: [{}], stage: 'reconstructed' as const, reason: null };

describe('engine-owned media diagnostic lifetime', () => {
  it('does not construct without a factory and shares only the same or absent factory', () => {
    const value = runtime(), factory = vi.fn(() => value), changed = vi.fn();
    const owner = new MediaStageObservers(host, changed);
    expect(() => owner.observe(() => {})).toThrow(/factory/);
    const a = owner.observe(() => {}, factory), b = owner.observe(() => {}, factory), c = owner.observe(() => {});
    expect(factory).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalledExactlyOnceWith(value);
    expect(() => owner.observe(() => {}, () => runtime())).toThrow(/different factory/);
    a(); b(); expect(value.dispose).not.toHaveBeenCalled(); c(); c();
    expect(value.dispose).toHaveBeenCalledOnce(); expect(owner.runtime).toBeUndefined();
  });
  it('reserves the slot before a reentrant factory and disposes a late return after destroy', () => {
    const value = runtime(), changed = vi.fn(); const owner = new MediaStageObservers(host, changed);
    let nestedOff!: () => void;
    const factory = vi.fn(() => { nestedOff = owner.observe(() => {}); owner.dispose(); return value; });
    const off = owner.observe(() => {}, factory); off(); nestedOff();
    expect(factory).toHaveBeenCalledOnce(); expect(value.dispose).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalledWith(value); expect(owner.runtime).toBeUndefined();
  });
  it('validates the runtime itself, never an implementation-provided validator', () => {
    const changed = vi.fn(), owner = new MediaStageObservers(host, changed);
    const malformed = Object.assign(runtime(), { appendToken: 3, validate: vi.fn(() => true) });
    const factory = (() => malformed) as unknown as MediaDiagnosticsFactory;
    expect(() => owner.observe(() => {}, factory)).toThrow(/appendToken/);
    expect(malformed.dispose).toHaveBeenCalledOnce(); expect(malformed.validate).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
    const off = owner.observe(() => {}, () => runtime()); off();
  });
  it('releases a runtime when activation fails and can construct again', () => {
    const value = runtime(), changed = vi.fn<() => void>(() => { throw Error('activation'); });
    const owner = new MediaStageObservers(host, changed);
    expect(() => owner.observe(() => {}, () => value)).toThrow('activation');
    expect(owner.runtime).toBeUndefined(); expect(value.dispose).toHaveBeenCalledOnce();
    changed.mockImplementation(() => {}); const next = runtime();
    const off = owner.observe(() => {}, () => next); off(); expect(next.dispose).toHaveBeenCalledOnce();
  });
  it('clears failed construction even when an invalid runtime has a throwing dispose getter', () => {
    const owner = new MediaStageObservers(host, () => {});
    const value = Object.defineProperty({}, 'dispose', { get() { throw Error('getter'); } });
    expect(() => owner.observe(() => {}, (() => value) as unknown as MediaDiagnosticsFactory)).toThrow();
    expect(owner.runtime).toBeUndefined(); const off = owner.observe(() => {}, () => runtime()); off();
  });
  it('contains observer faults and copies observations per listener', async () => {
    let emit!: MediaStageObserver;
    const owner = new MediaStageObservers(host, () => {});
    const off = owner.observe(e => { (e.inputs as object[]).length = 0; throw Error('observer'); }, (_host, sink) => { emit = sink; return runtime(); });
    const second = vi.fn(), stopSecond = owner.observe(second);
    const stopThird = owner.observe(async () => { throw Error('async observer'); });
    emit(event); await Promise.resolve(); expect(second.mock.calls[0]![0].inputs).toHaveLength(1); expect(event.inputs).toHaveLength(1);
    off(); stopSecond(); stopThird(); emit(event); expect(second).toHaveBeenCalledOnce();
  });
  it('rechecks membership after a listener destroys the owner', () => {
    let emit!: MediaStageObserver;
    const owner = new MediaStageObservers(host, () => {}), second = vi.fn();
    owner.observe(() => owner.dispose(), (_host, sink) => { emit = sink; return runtime(); });
    owner.observe(second); emit(event); expect(second).not.toHaveBeenCalled();
  });
  it.each(['decoded', 'decodedVideoCount', 'decodedAudioCount', 'refusedVideoCount', 'refusedAudioCount', 'refusedReconstructionCount', 'unobservableVideoCount', 'unobservableAudioCount'] as const)(
    'independently validates the new runtime boundary %s', name => {
      const owner = new MediaStageObservers(host, () => {});
      const value = Object.assign(runtime(), { [name]: name === 'decoded' ? null : NaN });
      expect(() => owner.observe(() => {}, (() => value) as MediaDiagnosticsFactory)).toThrow();
      expect(value.dispose).toHaveBeenCalledOnce(); expect(owner.runtime).toBeUndefined();
    });

});
