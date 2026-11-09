import { describe, expect, it, vi } from 'vitest';
import { CommandDispatcher } from './command-dispatcher.js';
import type { DecoderFeedback } from '@openmoq/playback';
import type { VideoDecoderLike, VideoRendererLike } from './interfaces.js';

function fixture(events: boolean) {
  let depth = 0;
  const listeners = new Set<() => void>(), off = vi.fn();
  const decoder: VideoDecoderLike = { configure: vi.fn(), decode: vi.fn(() => { depth++; }), flush: vi.fn(async () => {}),
    reset: vi.fn(() => { depth = 0; }), destroy: vi.fn(), get queueDepth() { return depth; }, onFrame: null, onError: null,
    ...(events ? { observeQueueDepth: (observe: () => void) => { listeners.add(observe); return () => { off(); listeners.delete(observe); }; } } : {}) };
  const renderer: VideoRendererLike = { enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(), onFirstFrame: null,
    onFrameRendered: null, onStall: null };
  const feedback: DecoderFeedback[] = [];
  const dispatcher = new CommandDispatcher({ videoDecoder: decoder, renderer, onFeedback: event => feedback.push(event) });
  return { dispatcher, decoder, listeners, off, feedback, empty: () => { depth = 0; },
    fill: () => { for (let index = 0; index < 8; index++) dispatcher.dispatch({ type: 'decode_video',
      chunk: { type: index ? 'delta' : 'key', timestamp: index, data: Uint8Array.of(index) }, renderTimeUs: 0 }); } };
}
describe('video input queue progress without native frame output', () => {
  it('releases pressure on dequeue without requiring output or flush', () => {
    const f = fixture(true);
    try {
      expect(f.dispatcher.hasQueueProgressObserver('video')).toBe(true); f.fill();
      expect(f.feedback).toEqual([{ type: 'queue_pressure', mediaType: 'video', depth: 8, maxRecommended: 8 }]);
      f.empty(); for (const notify of f.listeners) notify();
      expect(f.feedback.at(-1)).toEqual({ type: 'queue_pressure', mediaType: 'video', depth: 0, maxRecommended: 8 });
      expect(f.decoder.flush).not.toHaveBeenCalled();
    } finally { f.dispatcher.destroy(); }
    expect(f.off).toHaveBeenCalledOnce();
  });
  it('can resample a legacy queue getter without inventing an output event', () => {
    const f = fixture(false);
    try {
      expect(f.dispatcher.hasQueueProgressObserver('video')).toBe(false); f.fill(); f.empty();
      expect(f.feedback).toHaveLength(1); f.dispatcher.resampleQueuePressure();
      expect(f.feedback.at(-1)).toMatchObject({ type: 'queue_pressure', depth: 0 });
    } finally { f.dispatcher.destroy(); }
  });
  it('fences saved queue notifications after destroy and releases its exact registration once', () => {
    const f = fixture(true), saved = [...f.listeners][0]!;
    f.fill(); f.dispatcher.destroy(); f.empty(); saved(); f.dispatcher.resampleQueuePressure();
    expect(f.feedback).toHaveLength(1); expect(f.off).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0); expect(f.dispatcher.hasQueueProgressObserver('video')).toBe(false);
  });
});
