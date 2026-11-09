import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceTimestamp } from '@openmoq/loc';
import type { VideoRenderTiming } from '@openmoq/playback';
import type { VideoDecoderLike, VideoFrameObservation, VideoProducedTiming } from './interfaces.js';
import { CommandDispatcher } from './command-dispatcher.js';
import type { VideoOutputAdmission, VideoOutputAdmissionLease } from './command-dispatcher.js';
import { CanvasRenderer } from '../../browser/src/canvas-renderer.js';

beforeEach(() => vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} }));
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const canvas = { width: 10, height: 10 }, draw = vi.fn();
  const renderer = new CanvasRenderer({ getContext: () => ({ canvas, drawImage: draw }) } as unknown as HTMLCanvasElement,
    { clock: { now: () => 1000 } });
  const decoder: VideoDecoderLike = { supportsOutputTiming: true, configure() {}, decode() {}, reset() {}, destroy() {},
    flush: async () => {}, queueDepth: 0, onFrame: null, onError: null };
  const events: VideoFrameObservation[] = [], feedback = vi.fn(), error = vi.fn();
  const off = renderer.observeFrames(event => { events.push(event); });
  let ready = true;
  const dispatcher = new CommandDispatcher({ videoDecoder: decoder, renderer, getPlaybackDelayUs: () => 0,
    hasSyncReference: () => ready, onFeedback: feedback, onError: error });
  const context: VideoRenderTiming = Object.freeze({ recomputeRenderTimeUs: () => 0 });
  function output(timing = context, id = 0) {
    const frame = { timestamp: 1_000_000 + id, close: vi.fn() };
    const source: SourceTimestamp = { ticks: BigInt(frame.timestamp), ticksPerSecond: 1_000_000n, domain: 'media' };
    decoder.onFrame!(frame, 0, source, undefined, timing); return frame;
  }
  return { renderer, decoder, dispatcher, events, feedback, error, draw, output, context,
    ready(value: boolean) { ready = value; }, close() { off(); dispatcher.destroy(); } };
}

describe('owned decoded video admission', () => {
  it('establishes a reference at actual output before the schedule query', () => {
    const f = fixture(), order: string[] = [], discarded = vi.fn();
    try {
      f.ready(false);
      const timing = { recomputeRenderTimeUs: () => { order.push('schedule'); return 0; } };
      f.dispatcher.installVideoOutputAdmission({ decide(proof) {
        expect(proof.context).toBe(timing); expect(proof.sourceTimestamp.ticks).toBe(1_000_000n);
        order.push('admit'); f.ready(true); return 'enqueue';
      }, discarded });
      f.output(timing); f.renderer.renderTick(0);
      expect(order).toEqual(['admit', 'schedule']); expect(discarded).not.toHaveBeenCalled();
      expect(f.events.at(-1)?.state).toBe('presented');
    } finally { f.close(); }
  });
  it('holds decoded frames until an explicit refresh admits them, without a new decode', () => {
    const f = fixture(), discarded = vi.fn(); let allow = false;
    try {
      const decide = vi.fn((_proof: VideoProducedTiming) => allow ? 'enqueue' as const : 'hold' as const);
      f.dispatcher.installVideoOutputAdmission({ decide, discarded });
      const frame = f.output(); f.renderer.renderTick(0); expect(f.events).toEqual([]);
      f.dispatcher.refreshVideoOutputs(); expect(f.events).toEqual([]); expect(frame.close).not.toHaveBeenCalled();
      allow = true; f.dispatcher.refreshVideoOutputs(); f.renderer.renderTick(0);
      expect(f.events.map(event => event.state)).toEqual(['scheduled', 'presented']);
      expect(frame.close).toHaveBeenCalledOnce(); expect(discarded).not.toHaveBeenCalled();
      expect(decide.mock.calls.every(call => call[0] === decide.mock.calls[0]![0])).toBe(true);
    } finally { f.close(); }
  });
  it('refuses preroll without submitting a frame or losing the diagnostic unit', () => {
    const f = fixture(), unit = {}, diagnosticDiscard = vi.fn(), discarded = vi.fn();
    try {
      f.dispatcher.outputObserver = { decoded: () => unit, discarded: diagnosticDiscard };
      f.dispatcher.installVideoOutputAdmission({ decide: () => 'discard', discarded });
      const frame = f.output(); f.renderer.renderTick(0);
      expect(f.events).toEqual([]); expect(frame.close).toHaveBeenCalledOnce();
      expect(discarded).toHaveBeenCalledOnce(); expect(discarded.mock.calls[0]![1]).toBe('output refused');
      expect(diagnosticDiscard).toHaveBeenCalledExactlyOnceWith(unit, 'output refused');
    } finally { f.close(); }
  });
  it('retires only held outputs belonging to the replaced admission owner', () => {
    const f = fixture(), oldDiscard = vi.fn(), nextDiscard = vi.fn(), nextDecide = vi.fn(() => 'enqueue' as const);
    try {
      f.dispatcher.installVideoOutputAdmission({ decide: () => 'hold', discarded: oldDiscard });
      const old = f.output(); expect(f.events).toEqual([]);
      f.dispatcher.installVideoOutputAdmission({ decide: nextDecide, discarded: nextDiscard });
      expect(old.close).toHaveBeenCalledOnce(); expect(oldDiscard).toHaveBeenCalledOnce();
      expect(nextDecide).not.toHaveBeenCalled();
      f.output(); f.renderer.renderTick(0); expect(f.events.at(-1)?.state).toBe('presented');
      expect(nextDecide).toHaveBeenCalledOnce(); expect(nextDiscard).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
  it.each(['flush', 'destroy'] as const)('settles a held output exactly once on %s', action => {
    const f = fixture(), discarded = vi.fn();
    try {
      const lease = f.dispatcher.installVideoOutputAdmission({ decide: () => 'hold', discarded }); const frame = f.output();
      f.dispatcher[action](); lease.release();
      expect(frame.close).toHaveBeenCalledOnce(); expect(discarded).toHaveBeenCalledOnce();
      expect(discarded.mock.calls[0]![1]).toBe(action === 'flush' ? 'flushed' : 'destroyed'); expect(f.events).toEqual([]);
    } finally { f.close(); }
  });
  it.each(['flush', 'replace', 'destroy'] as const)('fences reentry during a decision: %s', action => {
    const f = fixture(), discarded = vi.fn();
    try {
      f.dispatcher.installVideoOutputAdmission({ decide() {
        if (action === 'replace') f.dispatcher.installVideoOutputAdmission({ decide: () => 'enqueue', discarded() {} });
        else f.dispatcher[action]();
        return 'enqueue';
      }, discarded });
      const frame = f.output(); f.renderer.renderTick(0);
      expect(f.events).toEqual([]); expect(frame.close).toHaveBeenCalledOnce(); expect(discarded).toHaveBeenCalledOnce();
    } finally { f.close(); }
  });
  it('accounts held functional outputs in queue pressure and clears pressure after refresh', () => {
    const f = fixture(), discarded = vi.fn(); let allow = false;
    try {
      f.dispatcher.installVideoOutputAdmission({ decide: () => allow ? 'enqueue' : 'hold', discarded });
      for (let i = 0; i < 8; i++) f.output(f.context, i);
      expect(f.feedback).toHaveBeenCalledWith({ type: 'queue_pressure', mediaType: 'video', depth: 8, maxRecommended: 8 });
      allow = true; f.dispatcher.refreshVideoOutputs();
      expect(f.feedback).toHaveBeenLastCalledWith({ type: 'queue_pressure', mediaType: 'video', depth: 0, maxRecommended: 8 });
      f.renderer.renderTick(0); expect(f.events.filter(event => event.state === 'presented')).toHaveLength(8);
    } finally { f.close(); }
  });
  it('keeps functional hold ownership when diagnostic observation is replaced', () => {
    const f = fixture(), discarded = vi.fn(), unit = {}; let allow = false;
    try {
      f.dispatcher.outputObserver = { decoded: () => unit, discarded() {} };
      f.dispatcher.installVideoOutputAdmission({ decide: () => allow ? 'enqueue' : 'hold', discarded });
      const frame = f.output(); f.dispatcher.outputObserver = undefined;
      allow = true; f.dispatcher.refreshVideoOutputs(); f.renderer.renderTick(0);
      expect(f.events.at(-1)?.outputTiming?.context).toBe(f.context);
      expect(f.events.at(-1)?.token).toBe(f.context); expect(frame.close).toHaveBeenCalledOnce();
      expect(discarded).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
  it('owns an invalid asynchronous decision and reports the failure without leaking the frame', async () => {
    const f = fixture(), discarded = vi.fn();
    const owner: VideoOutputAdmission = { decide: () => 'enqueue', discarded };
    Reflect.set(owner, 'decide', () => Promise.reject(new Error('unexpected async')));
    try {
      f.dispatcher.installVideoOutputAdmission(owner);
      const frame = f.output(); await Promise.resolve(); await Promise.resolve();
      expect(frame.close).toHaveBeenCalledOnce(); expect(f.events).toEqual([]);
      expect(f.error).toHaveBeenCalledOnce(); expect(discarded).toHaveBeenCalledOnce();
    } finally { f.close(); }
  });
  it('keeps the default carrier path when no admission owner is installed', () => {
    const f = fixture(); try {
      const frame = f.output(); f.renderer.renderTick(0);
      expect(f.events.map(event => event.state)).toEqual(['scheduled', 'presented']);
      expect(frame.close).toHaveBeenCalledOnce(); expect(f.error).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
  it.each(['null-source', 'missing-source', 'missing-context', 'unsupported-renderer'] as const)(
    'does not let an armed owner render an unproven output: %s', kind => {
      const f = fixture(), decide = vi.fn(() => 'enqueue' as const), discarded = vi.fn();
      try {
        f.dispatcher.installVideoOutputAdmission({ decide, discarded });
        if (kind === 'unsupported-renderer') Reflect.set(f.renderer, 'supportsOutputTiming', undefined);
        const frame = { timestamp: 1_000_000, close: vi.fn() };
        const source = kind === 'null-source' ? null : kind === 'missing-source' ? undefined
          : { ticks: 1_000_000n, ticksPerSecond: 1_000_000n, domain: 'media' as const };
        f.decoder.onFrame!(frame, 0, source, undefined, kind === 'missing-context' ? undefined : f.context);
        f.renderer.renderTick(0);
        expect(f.events).toEqual([]); expect(frame.close).toHaveBeenCalledOnce();
        expect(decide).not.toHaveBeenCalled(); expect(discarded).not.toHaveBeenCalled();
        expect(f.error).toHaveBeenCalledOnce();
      } finally { f.close(); }
    });
});

describe('video output admission registration lease', () => {
  it('stale release leaves a successor lease and held frame owned until the successor admits it', () => {
    const f = fixture(), discarded = vi.fn(); let allow = false;
    try {
      const stale = f.dispatcher.installVideoOutputAdmission({ decide: () => 'hold', discarded() {} });
      const live = f.dispatcher.installVideoOutputAdmission({ decide: () => allow ? 'enqueue' : 'hold', discarded });
      const frame = f.output();
      expect(stale.current).toBe(false); expect(live.current).toBe(true);
      stale.release(); stale.release();
      expect(live.current).toBe(true); expect(frame.close).not.toHaveBeenCalled(); expect(discarded).not.toHaveBeenCalled();
      allow = true; f.dispatcher.refreshVideoOutputs(); f.renderer.renderTick(0);
      expect(frame.close).toHaveBeenCalledOnce(); expect(f.events.at(-1)?.state).toBe('presented');
      live.release(); expect(live.current).toBe(false);
    } finally { f.close(); }
  });

  it('same-owner reinstallation has a fresh binding; its prior lease cannot release the new registration', () => {
    const f = fixture(), discarded = vi.fn();
    const owner: VideoOutputAdmission = { decide: () => 'hold', discarded };
    try {
      const first = f.dispatcher.installVideoOutputAdmission(owner), old = f.output();
      const second = f.dispatcher.installVideoOutputAdmission(owner);
      expect(first.current).toBe(false); expect(second.current).toBe(true);
      expect(old.close).toHaveBeenCalledOnce(); expect(discarded).toHaveBeenCalledOnce();
      const next = f.output(); first.release();
      expect(second.current).toBe(true); expect(next.close).not.toHaveBeenCalled();
      second.release(); second.release();
      expect(next.close).toHaveBeenCalledOnce(); expect(discarded).toHaveBeenCalledTimes(2);
    } finally { f.close(); }
  });

  it('replacement from old discard during installation returns an already-stale lease without releasing the replacement', () => {
    const f = fixture(), nextDiscard = vi.fn(); let allow = false;
    const next: { lease?: VideoOutputAdmissionLease; frame?: ReturnType<typeof f.output> } = {};
    try {
      const first = f.dispatcher.installVideoOutputAdmission({ decide: () => 'hold', discarded() {
        expect(first.current).toBe(false);
        next.lease = f.dispatcher.installVideoOutputAdmission({ decide: () => allow ? 'enqueue' : 'hold', discarded: nextDiscard });
        next.frame = f.output();
      } });
      f.output();
      const displaced = f.dispatcher.installVideoOutputAdmission({ decide: () => 'hold', discarded() {} });
      if (!next.lease || !next.frame) throw new Error('Replacement callback was not exercised');
      expect(displaced.current).toBe(false); expect(next.lease.current).toBe(true);
      displaced.release(); first.release();
      expect(next.lease.current).toBe(true); expect(next.frame.close).not.toHaveBeenCalled(); expect(nextDiscard).not.toHaveBeenCalled();
      allow = true; f.dispatcher.refreshVideoOutputs(); f.renderer.renderTick(0);
      expect(next.frame.close).toHaveBeenCalledOnce(); expect(f.events.at(-1)?.state).toBe('presented');
      next.lease.release();
    } finally { f.close(); }
  });

  it('replacement from pressure feedback during installation also makes the returned lease stale', () => {
    const f = fixture(), nextDiscard = vi.fn();
    const next: { lease?: VideoOutputAdmissionLease; frame?: ReturnType<typeof f.output> } = {};
    try {
      const first = f.dispatcher.installVideoOutputAdmission({ decide: () => 'hold', discarded() {} });
      for (let i = 0; i < 8; i++) f.output(f.context, i);
      let once = true;
      f.feedback.mockImplementation(() => {
        if (!once) return; once = false;
        expect(first.current).toBe(false);
        next.lease = f.dispatcher.installVideoOutputAdmission({ decide: () => 'hold', discarded: nextDiscard });
        next.frame = f.output();
      });
      const displaced = f.dispatcher.installVideoOutputAdmission({ decide: () => 'hold', discarded() {} });
      if (!next.lease || !next.frame) throw new Error('Pressure replacement callback was not exercised');
      expect(displaced.current).toBe(false); expect(next.lease.current).toBe(true);
      displaced.release();
      expect(next.lease.current).toBe(true); expect(next.frame.close).not.toHaveBeenCalled(); expect(nextDiscard).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it.each(['decide', 'discarded'])('registration %s getter reentry cannot overwrite the installed successor', point => {
    const f = fixture(), discarded = vi.fn();
    const next: { lease?: VideoOutputAdmissionLease; frame?: ReturnType<typeof f.output> } = {};
    const hold: VideoOutputAdmission['decide'] = () => 'hold';
    const noop: VideoOutputAdmission['discarded'] = () => {};
    const install = () => {
      next.lease = f.dispatcher.installVideoOutputAdmission({ decide: hold, discarded });
      next.frame = f.output();
    };
    const outer: VideoOutputAdmission = {
      get decide() { if (point === 'decide') install(); return hold; },
      get discarded() { if (point === 'discarded') install(); return noop; },
    };
    try {
      f.dispatcher.installVideoOutputAdmission({ decide: hold, discarded() {} });
      expect(() => f.dispatcher.installVideoOutputAdmission(outer)).toThrow(/changed during registration/);
      if (!next.lease || !next.frame) throw new Error('Getter replacement was not exercised');
      expect(next.lease.current).toBe(true); expect(next.frame.close).not.toHaveBeenCalled(); expect(discarded).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it('release switches ownership before old discard callbacks install another owner', () => {
    const f = fixture(), nextDiscard = vi.fn();
    const next: { lease?: VideoOutputAdmissionLease; frame?: ReturnType<typeof f.output> } = {};
    let once = true;
    try {
      const first = f.dispatcher.installVideoOutputAdmission({ decide: () => 'hold', discarded() {
        expect(first.current).toBe(false);
        if (once) {
          once = false;
          next.lease = f.dispatcher.installVideoOutputAdmission({ decide: () => 'hold', discarded: nextDiscard });
          next.frame = f.output();
        }
      } });
      for (let i = 0; i < 8; i++) f.output(f.context, i);
      first.release(); first.release();
      if (!next.lease || !next.frame) throw new Error('Release replacement was not exercised');
      expect(next.lease.current).toBe(true); expect(next.frame.close).not.toHaveBeenCalled(); expect(nextDiscard).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it('release pressure feedback can install a successor that remains owned after the old release returns', () => {
    const f = fixture(), discarded = vi.fn();
    const next: { lease?: VideoOutputAdmissionLease; frame?: ReturnType<typeof f.output> } = {};
    let once = true;
    try {
      const first = f.dispatcher.installVideoOutputAdmission({ decide: () => 'hold', discarded() {} });
      for (let i = 0; i < 8; i++) f.output(f.context, i);
      f.feedback.mockImplementation(() => {
        if (!once) return; once = false;
        expect(first.current).toBe(false);
        next.lease = f.dispatcher.installVideoOutputAdmission({ decide: () => 'hold', discarded });
        next.frame = f.output();
      });
      first.release(); first.release();
      if (!next.lease || !next.frame) throw new Error('Release pressure callback was not exercised');
      expect(next.lease.current).toBe(true); expect(next.frame.close).not.toHaveBeenCalled(); expect(discarded).not.toHaveBeenCalled();
      next.lease.release();
      expect(next.frame.close).toHaveBeenCalledOnce(); expect(discarded).toHaveBeenCalledOnce();
    } finally { f.close(); }
  });

  it('current is a pure binding query; destruction and repeated release stay idempotent', () => {
    const f = fixture(), discarded = vi.fn(); let ownerReads = 0, depthReads = 0;
    const hold: VideoOutputAdmission['decide'] = () => 'hold';
    const owner: VideoOutputAdmission = { get decide() { ownerReads++; return hold; },
      get discarded() { ownerReads++; return discarded; } };
    try {
      const lease = f.dispatcher.installVideoOutputAdmission(owner), frame = f.output();
      Reflect.defineProperty(f.decoder, 'queueDepth', { get() { depthReads++; return 0; } });
      const priorOwnerReads = ownerReads;
      expect(lease.current).toBe(true); expect(lease.current).toBe(true);
      expect(ownerReads).toBe(priorOwnerReads); expect(depthReads).toBe(0);
      f.dispatcher.destroy();
      expect(lease.current).toBe(false); lease.release(); lease.release();
      expect(frame.close).toHaveBeenCalledOnce(); expect(discarded).toHaveBeenCalledOnce();
      expect(depthReads).toBe(0);
      expect(() => f.dispatcher.installVideoOutputAdmission(owner)).toThrow(/destroy/);
    } finally { f.close(); }
  });

  it('release does not flush physical frames already handed to the renderer', () => {
    const f = fixture(), discarded = vi.fn();
    try {
      const lease = f.dispatcher.installVideoOutputAdmission({ decide: () => 'enqueue', discarded });
      const frame = f.output(); expect(f.events.at(-1)?.state).toBe('scheduled');
      lease.release(); expect(lease.current).toBe(false);
      expect(frame.close).not.toHaveBeenCalled(); expect(discarded).not.toHaveBeenCalled();
      f.renderer.renderTick(0); expect(frame.close).toHaveBeenCalledOnce(); expect(f.events.at(-1)?.state).toBe('presented');
    } finally { f.close(); }
  });
});

describe('discarded preroll releases functional decode pressure', () => {
  it('clears HIGH after an actual discarded native output drains decoder depth to zero', () => {
    const f = fixture(), discarded = vi.fn(); let depth = 0;
    Reflect.defineProperty(f.decoder, 'queueDepth', { get() { return depth; } });
    try {
      f.dispatcher.installVideoOutputAdmission({ decide: () => 'discard', discarded });
      depth = 8;
      f.dispatcher.dispatch({ type: 'decode_video', chunk: { type: 'key', timestamp: 1_000_000, data: Uint8Array.of(1) }, renderTimeUs: 0 });
      expect(f.feedback).toHaveBeenLastCalledWith({ type: 'queue_pressure', mediaType: 'video', depth: 8, maxRecommended: 8 });
      depth = 0;
      const frame = f.output();
      expect(frame.close).toHaveBeenCalledOnce(); expect(discarded).toHaveBeenCalledOnce(); expect(f.events).toEqual([]);
      expect(f.feedback).toHaveBeenLastCalledWith({ type: 'queue_pressure', mediaType: 'video', depth: 0, maxRecommended: 8 });
      expect(f.error).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  const pressureActions: readonly ('replace' | 'flush' | 'destroy')[] = ['replace', 'flush', 'destroy'];
  it.each(pressureActions)('does not publish old pressure after discard callback %s', action => {
    const f = fixture(); let depth = 0;
    const next: { lease?: VideoOutputAdmissionLease } = {};
    Reflect.defineProperty(f.decoder, 'queueDepth', { get() { return depth; } });
    try {
      f.dispatcher.installVideoOutputAdmission({ decide: () => 'discard', discarded() {
        if (action === 'replace') {
          // The new registration still sees HIGH; only a current output may
          // later sample zero. An unguarded old-output tail would publish LOW.
          depth = 8;
          next.lease = f.dispatcher.installVideoOutputAdmission({ decide: () => 'enqueue', discarded() {} });
          depth = 0;
        } else f.dispatcher[action]();
      } });
      depth = 8;
      f.dispatcher.dispatch({ type: 'decode_video', chunk: { type: 'key', timestamp: 1_000_000, data: Uint8Array.of(1) }, renderTimeUs: 0 });
      expect(f.feedback).toHaveBeenLastCalledWith({ type: 'queue_pressure', mediaType: 'video', depth: 8, maxRecommended: 8 });
      f.feedback.mockClear(); depth = 0;
      const frame = f.output(); expect(frame.close).toHaveBeenCalledOnce(); expect(f.events).toEqual([]);
      expect(f.feedback).not.toHaveBeenCalled();
      if (action === 'replace') {
        if (!next.lease) throw new Error('Discard replacement callback was not exercised');
        expect(next.lease.current).toBe(true);
        const currentFrame = f.output();
        expect(f.feedback).toHaveBeenLastCalledWith({ type: 'queue_pressure', mediaType: 'video', depth: 0, maxRecommended: 8 });
        f.renderer.renderTick(0);
        expect(currentFrame.close).toHaveBeenCalledOnce(); expect(f.events.at(-1)?.state).toBe('presented');
      }
    } finally { f.close(); }
  });
});
