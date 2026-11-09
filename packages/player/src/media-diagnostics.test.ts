import { describe, expect, it, vi } from 'vitest';
import { MoqtConnection, type ObjectReceipt, type ObjectReceiptObservation } from '@openmoq/webtransport';
import type { MoqtObject } from '@openmoq/transport';
import type { MediaAppendObserver, MediaSourceLike, VideoFrameObserver, AudioScheduleObserver, VideoRendererLike, AudioOutputLike } from './interfaces.js';
import type { PlayerConnectionObservation } from './diagnostics.js';
import { createMediaDiagnostics } from './media-diagnostics.js';
import type { MediaStageObservation } from './media-diagnostic-types.js';

function fixture(limits = {}) {
  const conn = new MoqtConnection(18);
  // A synthetic receipt source exercises local identity/lifetime, not wire parsing.
  const listeners = new Set<(event: ObjectReceiptObservation) => void | Promise<void>>();
  const tokens = new WeakMap<object, ObjectReceipt>();
  const receipts = {
    observe(fn: (event: ObjectReceiptObservation) => void | Promise<void>) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    receiptFor(input: object) { return tokens.get(input); },
    receive(input: MoqtObject, origin: Exclude<ObjectReceiptObservation['origin'], 'fetch'>, lastObjectId: bigint | null = null) {
      if (!listeners.size || tokens.has(input)) return;
      const receipt = Object.freeze({}) as ObjectReceipt; tokens.set(input, receipt);
      const event = { receipt, reception: null, origin, lastObjectId, trackAlias: input.trackAlias, groupId: input.groupId,
        subgroupId: input.subgroupId, objectId: input.objectId, objectStatus: 0n, payloadBytes: 1 };
      for (const fn of listeners) fn(event);
    },
  };
  vi.spyOn(conn, 'observeObjectReceipts').mockImplementation(fn => receipts.observe(fn));
  vi.spyOn(conn, 'objectReceiptFor').mockImplementation(obj => receipts.receiptFor(obj));
  let lifecycle: ((event: PlayerConnectionObservation) => void) | undefined;
  const events: MediaStageObservation[] = [], off = vi.fn();
  const host = { currentConnection: conn, observeConnections(fn: (event: PlayerConnectionObservation) => void) {
    lifecycle = fn; fn({ kind: 'available', connection: conn, endpoint: null }); return off;
  } };
  const tracker = createMediaDiagnostics(host, event => { events.push(event); }, limits);
  const input: MoqtObject = { kind: 'data', trackAlias: 1n, groupId: 2n, subgroupId: 0n, objectId: 0n,
    publisherPriority: 128, payload: Uint8Array.of(1), extensions: undefined };
  const receive = () => { receipts.receive(input, 'subgroup'); return tracker.capture(conn, input)!; };
  let appends: MediaAppendObserver | undefined;
  const remove = vi.fn();
  const source = { observeAppends(fn: MediaAppendObserver) { appends = fn; return remove; } } as Pick<MediaSourceLike, 'observeAppends'> as MediaSourceLike;
  return { conn, receipts, input, tracker, receive, events, host, lifecycle: () => lifecycle!, off, source, remove,
    complete(token: object, state: 'appended' | 'discarded' | 'unavailable' = 'appended') {
      appends!({ token, state, reason: state === 'unavailable' ? 'completion unproven' : null });
    } };
}

function outputTargets() {
  const frames = new Set<VideoFrameObserver>(), schedules = new Set<AudioScheduleObserver>();
  const videoOff = vi.fn(), audioOff = vi.fn();
  const video: VideoRendererLike = {
    enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(), onFirstFrame: null, onFrameRendered: null, onStall: null,
    observeFrames(observer) { frames.add(observer); return () => { frames.delete(observer); videoOff(); }; },
  };
  const audio: AudioOutputLike = {
    schedule: vi.fn(), flush: vi.fn(), destroy: vi.fn(), currentPlayoutTimeUs: 0,
    observeSchedules(observer) { schedules.add(observer); return () => { schedules.delete(observer); audioOff(); }; },
  };
  return { video, audio, videoOff, audioOff,
    frame(token: object, state: 'scheduled' | 'presented' | 'discarded' | 'unavailable', reason: 'flushed' | 'completion unproven' | null = null) {
      for (const observer of [...frames]) observer({ token, state, reason });
    },
    schedule(token: object, state: 'scheduled' | 'released' | 'discarded', reason: 'flushed' | null = null) {
      for (const observer of [...schedules]) observer({ token, state, reason });
    },
  };
}

describe('optional media diagnostics', () => {
  it('requires an observed receipt on the exact known connection and original object', () => {
    const f = fixture();
    expect(f.tracker.capture(f.conn, f.input)).toBeUndefined();
    const context = f.receive(); expect(context).toBeDefined();
    expect(f.tracker.capture(undefined, f.input)).toBe(context);
    expect(f.tracker.capture(new MoqtConnection(18), f.input)).toBeUndefined();
    expect(f.tracker.capture(f.conn, { ...f.input })).toBeUndefined();
    f.lifecycle()({ kind: 'retired', connection: f.conn });
    expect(f.tracker.capture(f.conn, f.input)).toBeUndefined();
    f.tracker.dispose(); expect(f.off).toHaveBeenCalledOnce();
  });
  it('does not acquire receipts from a previous observation lifetime', () => {
    const f = fixture(); const keep = f.receipts.observe(() => {}); f.receive(); f.tracker.dispose();
    const next = createMediaDiagnostics(f.host, () => {});
    expect(next.capture(f.conn, f.input)).toBeUndefined(); next.dispose(); keep();
  });
  it('does not turn a FIN-derived bound into a media input', () => {
    const f = fixture(); f.receipts.receive(f.input, 'group-end', 0n);
    expect(f.tracker.capture(f.conn, f.input)).toBeUndefined(); f.tracker.dispose();
  });
  it('registers the unit before synchronous completion and emits one terminal outcome', () => {
    const f = fixture(); f.tracker.bindMediaSource(f.source);
    const context = f.receive(), unit = f.tracker.reconstruct([context, context])!;
    expect(f.tracker.appendToken(unit, f.source)).toBe(unit);
    f.complete(unit); f.complete(unit); f.tracker.discardUnit(unit, 'flushed');
    expect(f.events.map(e => [e.unit, e.stage, e.inputs])).toEqual([[unit, 'reconstructed', [context]], [unit, 'appended', [context]]]);
    f.tracker.dispose(); expect(f.remove).toHaveBeenCalledOnce();
  });
  it('refuses new units at the bound without evicting pending ownership', () => {
    const f = fixture({ maxUnits: 1 }); f.tracker.bindMediaSource(f.source); const input = f.receive();
    const first = f.tracker.reconstruct([input])!;
    expect(f.tracker.reconstruct([input])).toBeUndefined(); expect(f.tracker.evidenceLossCount).toBe(1);
    expect(f.tracker.appendToken(first, f.source)).toBe(first); f.complete(first);
    expect(f.tracker.reconstruct([input])).toBeDefined(); f.tracker.dispose();
  });
  it('reports unproven completion as evidence loss, never a media discard', () => {
    const f = fixture(); f.tracker.bindMediaSource(f.source); const unit = f.tracker.reconstruct([f.receive()])!;
    f.tracker.appendToken(unit, f.source); f.complete(unit, 'unavailable'); f.complete(unit);
    expect(f.events.map(e => e.stage)).toEqual(['reconstructed']); expect(f.tracker.evidenceLossCount).toBe(1); f.tracker.dispose();
  });
  it('retains the old-source observer until its own admitted units terminate', () => {
    const f = fixture(); f.tracker.bindMediaSource(f.source); const unit = f.tracker.reconstruct([f.receive()])!;
    f.tracker.appendToken(unit, f.source); f.tracker.bindMediaSource(null);
    expect(f.remove).not.toHaveBeenCalled(); f.complete(unit);
    expect(f.events.map(e => e.stage)).toEqual(['reconstructed', 'appended']);
    expect(f.remove).toHaveBeenCalledOnce(); expect(f.tracker.evidenceLossCount).toBe(0); f.tracker.dispose();
  });
  it('keeps append ownership separate across old and replacement sources', () => {
    const f = fixture(); let secondObserver: MediaAppendObserver | undefined;
    const secondOff = vi.fn();
    const second = { observeAppends(fn: MediaAppendObserver) { secondObserver = fn; return secondOff; } } as Pick<MediaSourceLike, 'observeAppends'> as MediaSourceLike;
    const context = f.receive(); f.tracker.bindMediaSource(f.source);
    const old = f.tracker.reconstruct([context])!; f.tracker.appendToken(old, f.source);
    f.tracker.bindMediaSource(second);
    const fresh = f.tracker.reconstruct([context])!; f.tracker.appendToken(fresh, second);
    f.complete(fresh); secondObserver!({ token: old, state: 'appended', reason: null });
    expect(f.events.filter(e => e.stage === 'appended')).toHaveLength(0);
    f.complete(old); expect(f.remove).toHaveBeenCalledOnce();
    secondObserver!({ token: fresh, state: 'appended', reason: null });
    expect(f.events.filter(e => e.stage === 'appended').map(e => e.unit)).toEqual([old, fresh]);
    expect(secondOff).not.toHaveBeenCalled(); f.tracker.dispose(); expect(secondOff).toHaveBeenCalledOnce();
  });
  it('does not fabricate appended evidence for an unobservable custom source', () => {
    const f = fixture(); const context = f.receive(); const unit = f.tracker.reconstruct([context])!;
    const unsupported = {} as MediaSourceLike; f.tracker.bindMediaSource(unsupported);
    expect(f.tracker.appendToken(unit, unsupported)).toBeUndefined(); expect(f.tracker.evidenceLossCount).toBe(0);
    expect(f.tracker.unobservableAppendCount).toBe(1); f.tracker.dispose();
  });
  it('ignores a completion before append admission and refuses reuse of an admitted unit', () => {
    const f = fixture(); f.tracker.bindMediaSource(f.source); const unit = f.tracker.reconstruct([f.receive()])!;
    f.complete(unit); expect(f.events.map(e => e.stage)).toEqual(['reconstructed']);
    expect(f.tracker.appendToken(unit, f.source)).toBe(unit);
    expect(f.tracker.appendToken(unit, f.source)).toBeUndefined();
    f.complete(unit); expect(f.events.map(e => e.stage)).toEqual(['reconstructed', 'appended']); f.tracker.dispose();
  });
  it('releases terminal ownership before calling a listener that admits the next unit', () => {
    const f = fixture({ maxUnits: 1 }); const input = f.receive(); f.tracker.dispose();
    let next: object | undefined;
    const tracker = createMediaDiagnostics(f.host, event => {
      if (event.stage === 'appended') next = tracker.reconstruct([event.inputs[0]!]);
    }, { maxUnits: 1 });
    const fresh = { ...f.input }; f.receipts.receive(fresh, 'subgroup');
    const context = tracker.capture(f.conn, fresh)!; expect(context).not.toBe(input);
    tracker.bindMediaSource(f.source); const unit = tracker.reconstruct([context])!;
    tracker.appendToken(unit, f.source); f.complete(unit);
    expect(next).toBeDefined(); expect(tracker.evidenceLossCount).toBe(0); tracker.dispose();
  });
  it('bounds contributor storage and refuses unproven input identities', () => {
    const f = fixture(); const context = f.receive();
    expect(f.tracker.reconstruct([{}])).toBeUndefined();
    expect(f.tracker.reconstruct(Array.from({ length: 33 }, () => context))).toBeUndefined();
    expect(f.tracker.evidenceLossCount).toBe(1); expect(f.tracker.unattributedInputCount).toBe(1); expect(f.events).toEqual([]); f.tracker.dispose();
  });
  it('contains synchronous and asynchronous sink failures without stranding admitted ownership', async () => {
    const f = fixture(); f.tracker.dispose();
    const tracker = createMediaDiagnostics(f.host, async () => { throw Error('sink'); });
    const fresh = { ...f.input }; f.receipts.receive(fresh, 'subgroup');
    tracker.bindMediaSource(f.source); const unit = tracker.reconstruct([tracker.capture(f.conn, fresh)!])!;
    tracker.appendToken(unit, f.source); f.complete(unit); await Promise.resolve();
    expect(tracker.evidenceLossCount).toBe(0); tracker.dispose();
  });
  it('keeps known contributors without inventing identities for unknown halves', () => {
    const f = fixture(); f.tracker.bindMediaSource(f.source); const known = f.receive();
    const unit = f.tracker.reconstruct([undefined, known, known])!;
    expect(unit).toBeDefined(); f.tracker.appendToken(unit, f.source); f.complete(unit);
    expect(f.events.map(event => event.inputs)).toEqual([[known], [known]]);
    expect(f.tracker.unattributedInputCount).toBe(1); expect(f.tracker.evidenceLossCount).toBe(0); f.tracker.dispose();
  });
  it.each([0, -1, NaN, Infinity, 1.5])('refuses invalid limits %s', value => {
    const host = { currentConnection: null, observeConnections: vi.fn(() => () => {}) };
    expect(() => createMediaDiagnostics(host, () => {}, { maxUnits: value })).toThrow(); expect(host.observeConnections).not.toHaveBeenCalled();
  });
});

describe('LOC diagnostic units', () => {
  it('registers a decoded video unit before scheduled and actual presentation, once per stage', () => {
    const f = fixture(), t = outputTargets(), input = f.receive();
    const unit = f.tracker.decoded('video', input, t.video)!;
    expect(unit).toBeDefined(); expect(Object.keys(unit)).toEqual([]);
    t.frame(unit, 'scheduled'); t.frame(unit, 'scheduled'); t.frame(unit, 'presented'); t.frame(unit, 'presented');
    expect(f.events.map(e => [e.unit, e.stage, e.inputs])).toEqual([
      [unit, 'decoded', [input]], [unit, 'scheduled', [input]], [unit, 'presented', [input]],
    ]);
    expect(f.tracker.evidenceLossCount).toBe(0); f.tracker.dispose();
  });
  it('creates fresh units for several audio outputs and releases without claiming presentation', () => {
    const f = fixture({ maxUnits: 2 }), t = outputTargets(), input = f.receive();
    const first = f.tracker.decoded('audio', input, t.audio)!, second = f.tracker.decoded('audio', input, t.audio)!;
    expect(first).not.toBe(second); t.schedule(first, 'scheduled'); t.schedule(second, 'scheduled');
    t.schedule(first, 'released'); t.schedule(first, 'released');
    expect(f.tracker.decoded('audio', input, t.audio)).toBeDefined();
    expect(f.events.map(e => e.stage)).toEqual(['decoded', 'decoded', 'scheduled', 'scheduled', 'decoded']);
    expect(f.tracker.evidenceLossCount).toBe(0); f.tracker.dispose();
  });
  it('shares the reconstruction budget and reports which media kind was refused', () => {
    const f = fixture({ maxUnits: 1 }), t = outputTargets(), input = f.receive();
    f.tracker.bindMediaSource(f.source); const cmaf = f.tracker.reconstruct([input])!; f.tracker.appendToken(cmaf, f.source);
    expect(f.tracker.decoded('video', input, t.video)).toBeUndefined();
    expect(f.tracker.decoded('audio', input, t.audio)).toBeUndefined();
    expect(f.tracker.refusedVideoCount).toBe(1); expect(f.tracker.refusedAudioCount).toBe(1);
    f.complete(cmaf); const video = f.tracker.decoded('video', input, t.video)!;
    expect(f.tracker.reconstruct([input])).toBeUndefined(); expect(f.tracker.refusedReconstructionCount).toBe(1);
    t.frame(video, 'presented'); expect(f.tracker.decoded('audio', input, t.audio)).toBeDefined();
    expect(f.tracker.evidenceLossCount).toBe(3); f.tracker.dispose();
  });
  it('never consumes pending-unit capacity for unsupported targets, even at a full budget', () => {
    const f = fixture({ maxUnits: 1 }), t = outputTargets(), input = f.receive();
    const { observeFrames: _frames, ...video } = t.video, { observeSchedules: _audio, ...audio } = t.audio;
    const pending = f.tracker.decoded('video', input, t.video)!;
    for (let i = 0; i < 5; i++) {
      expect(f.tracker.decoded('video', input, video)).toBeUndefined();
      expect(f.tracker.decoded('audio', input, audio)).toBeUndefined();
    }
    expect(f.events.filter(e => e.stage === 'decoded')).toHaveLength(11);
    expect(f.tracker.unobservableVideoCount).toBe(5); expect(f.tracker.unobservableAudioCount).toBe(5);
    expect(f.tracker.refusedVideoCount).toBe(0); expect(f.tracker.refusedAudioCount).toBe(0);
    t.frame(pending, 'presented'); expect(f.tracker.decoded('audio', input, t.audio)).toBeDefined();
    expect(f.tracker.evidenceLossCount).toBe(0); f.tracker.dispose();
  });
  it('refuses missing, unknown and previous-lifetime decoder input identities with a valid control', () => {
    const f = fixture(), t = outputTargets(), old = f.receive(); f.tracker.dispose();
    const events: MediaStageObservation[] = [];
    const tracker = createMediaDiagnostics(f.host, e => { events.push(e); });
    expect(tracker.decoded('video', old, t.video)).toBeUndefined();
    expect(tracker.decoded('audio', {}, t.audio)).toBeUndefined();
    expect(tracker.decoded('audio', undefined, t.audio)).toBeUndefined();
    const fresh = { ...f.input }; f.receipts.receive(fresh, 'subgroup');
    expect(tracker.decoded('video', tracker.capture(f.conn, fresh), t.video)).toBeDefined();
    expect(events.map(e => e.stage)).toEqual(['decoded']); expect(tracker.unattributedInputCount).toBe(3); tracker.dispose();
  });
  it('keeps old target observations alive until their own pending units finish', () => {
    const f = fixture(), a = outputTargets(), b = outputTargets(), input = f.receive();
    const old = f.tracker.decoded('video', input, a.video)!, next = f.tracker.decoded('video', input, b.video)!;
    expect(a.videoOff).not.toHaveBeenCalled(); a.frame(next, 'presented'); b.frame(old, 'presented');
    expect(f.events.map(e => e.stage)).toEqual(['decoded', 'decoded']);
    a.frame(old, 'presented'); expect(a.videoOff).toHaveBeenCalledOnce(); b.frame(next, 'presented');
    expect(f.events.filter(e => e.stage === 'presented').map(e => e.unit)).toEqual([old, next]);
    expect(b.videoOff).not.toHaveBeenCalled(); f.tracker.dispose(); expect(b.videoOff).toHaveBeenCalledOnce();
  });
  it('keeps retired audio targets until release, with no terminal stage', () => {
    const f = fixture(), a = outputTargets(), b = outputTargets(), input = f.receive();
    const old = f.tracker.decoded('audio', input, a.audio)!; f.tracker.decoded('audio', input, b.audio);
    expect(a.audioOff).not.toHaveBeenCalled(); a.schedule(old, 'released'); expect(a.audioOff).toHaveBeenCalledOnce();
    expect(f.events.map(e => e.stage)).toEqual(['decoded', 'decoded']); f.tracker.dispose();
  });
  it('unproven draw completion counts evidence loss, not a media discard, and frees capacity', () => {
    const f = fixture({ maxUnits: 1 }), t = outputTargets(), input = f.receive();
    const unit = f.tracker.decoded('video', input, t.video)!;
    t.frame(unit, 'scheduled'); t.frame(unit, 'unavailable', 'completion unproven'); t.frame(unit, 'unavailable', 'completion unproven');
    expect(f.events.map(e => e.stage)).toEqual(['decoded', 'scheduled']); expect(f.tracker.evidenceLossCount).toBe(1);
    expect(f.tracker.decoded('video', input, t.video)).toBeDefined(); f.tracker.dispose();
  });
  it('actual input and output discards stay separate from diagnostic coverage loss', () => {
    const f = fixture(), t = outputTargets(), input = f.receive();
    f.tracker.discarded(input, 'backlog shed'); const unit = f.tracker.decoded('audio', input, t.audio)!;
    t.schedule(unit, 'scheduled'); t.schedule(unit, 'discarded', 'flushed');
    f.tracker.discardUnit(unit, 'output failed');
    expect(f.events.map(e => [e.stage, e.reason])).toEqual([
      ['discarded', 'backlog shed'], ['decoded', null], ['scheduled', null], ['discarded', 'flushed'],
    ]);
    expect(f.tracker.evidenceLossCount).toBe(0); f.tracker.dispose();
  });
  it('frees ownership before terminal listeners reenter at a one-unit limit', () => {
    const f = fixture(), t = outputTargets(); f.tracker.dispose(); let next: object | undefined;
    const tracker = createMediaDiagnostics(f.host, e => {
      if (e.stage === 'presented') next = tracker.decoded('video', e.inputs[0], t.video);
    }, { maxUnits: 1 });
    const fresh = { ...f.input }; f.receipts.receive(fresh, 'subgroup');
    const unit = tracker.decoded('video', tracker.capture(f.conn, fresh), t.video)!; t.frame(unit, 'presented');
    expect(next).toBeDefined(); expect(tracker.refusedVideoCount).toBe(0); tracker.dispose();
  });
  it('dispose inside decoded prevents return of an already retired unit', () => {
    const f = fixture(), t = outputTargets(); f.tracker.dispose();
    const tracker = createMediaDiagnostics(f.host, () => { tracker.dispose(); });
    const fresh = { ...f.input }; f.receipts.receive(fresh, 'subgroup');
    expect(tracker.decoded('video', tracker.capture(f.conn, fresh), t.video)).toBeUndefined();
    expect(t.videoOff).toHaveBeenCalledOnce();
  });
  it('output observer registration failure is coverage loss, not unsupported capability or playback failure', () => {
    const f = fixture(), t = outputTargets(), input = f.receive();
    t.video.observeFrames = () => { throw Error('registration failed'); };
    expect(() => f.tracker.decoded('video', input, t.video)).not.toThrow();
    expect(f.events.map(e => e.stage)).toEqual(['decoded']);
    expect(f.tracker.evidenceLossCount).toBe(1); expect(f.tracker.unobservableVideoCount).toBe(0); f.tracker.dispose();
  });
  it('disposing releases every target even if one custom unsubscribe throws', () => {
    const f = fixture(), t = outputTargets(), input = f.receive();
    t.video.observeFrames = () => () => { throw Error('off'); };
    const unit = f.tracker.decoded('video', input, t.video)!; f.tracker.decoded('audio', input, t.audio);
    expect(() => f.tracker.dispose()).not.toThrow(); expect(t.audioOff).toHaveBeenCalledOnce();
    t.frame(unit, 'presented'); expect(f.events.map(e => e.stage)).toEqual(['decoded', 'decoded']);
  });
});

it('counts actual decoder outputs independently from input identity and unit admission', () => {
  const f = fixture({ maxUnits: 1 }), t = outputTargets(), input = f.receive();
  expect(f.tracker.decodedVideoCount).toBe(0); expect(f.tracker.decodedAudioCount).toBe(0);
  const first = f.tracker.decoded('video', input, t.video)!;
  expect(f.tracker.decoded('video', undefined, t.video)).toBeUndefined();
  expect(f.tracker.decoded('audio', input, t.audio)).toBeUndefined(); // full diagnostic budget, actual output still occurred.
  expect(f.tracker.decodedVideoCount).toBe(2); expect(f.tracker.decodedAudioCount).toBe(1);
  expect(f.tracker.unattributedInputCount).toBe(1); expect(f.tracker.refusedAudioCount).toBe(1);
  t.frame(first, 'presented'); f.tracker.dispose();
  f.tracker.decoded('video', input, t.video); expect(f.tracker.decodedVideoCount).toBe(2);
});
