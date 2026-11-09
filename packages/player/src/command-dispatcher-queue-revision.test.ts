import { describe, expect, it, vi } from 'vitest';
import { CommandDispatcher } from './command-dispatcher.js';
import type { VideoDecoderLike } from './interfaces.js';
import type { DecoderFeedback } from '@openmoq/playback';

function fixture() {
  let depth = 0, resetDuringRead = false;
  let dispatcher: CommandDispatcher;
  const listeners = new Set<() => void>(), feedback: DecoderFeedback[] = [];
  const decoder: VideoDecoderLike = { configure: vi.fn(), decode: vi.fn(() => { ++depth; }), flush: async () => {},
    reset: () => { depth = 0; }, destroy: vi.fn(), onFrame: null, onError: null,
    get queueDepth() {
      const observed = depth;
      if (resetDuringRead) { resetDuringRead = false; dispatcher.dispatch({ type: 'reset', mediaType: 'video', reason: 'gap' }); }
      return observed;
    },
    observeQueueDepth: notify => { listeners.add(notify); return () => { listeners.delete(notify); }; },
  };
  dispatcher = new CommandDispatcher({ videoDecoder: decoder, onFeedback: value => { feedback.push(value); } });
  const fill = () => { for (let i = 0; i < 8; i++) dispatcher.dispatch({ type: 'decode_video',
    chunk: { type: i ? 'delta' : 'key', timestamp: i, data: Uint8Array.of(i) }, renderTimeUs: 0 }); };
  return { dispatcher, decoder, listeners, feedback, fill, armReset: () => { resetDuringRead = true; }, empty: () => { depth = 0; } };
}

describe('video queue snapshot revision authority', () => {
  it('does not publish a pre-reset queue snapshot after its getter resets the output revision', () => {
    const f = fixture();
    try {
      f.fill(); expect(f.feedback).toHaveLength(1);
      f.armReset(); for (const notify of f.listeners) notify();
      expect(f.decoder.queueDepth).toBe(0);
      expect(f.feedback, 'a retired queue read must not reassert HIGH after reset').toHaveLength(1);
    } finally { f.dispatcher.destroy(); }
  });
  it('still reports ordinary current native queue drain', () => {
    const f = fixture();
    try {
      f.fill(); f.empty(); for (const notify of f.listeners) notify();
      expect(f.feedback).toEqual([
        { type: 'queue_pressure', mediaType: 'video', depth: 8, maxRecommended: 8 },
        { type: 'queue_pressure', mediaType: 'video', depth: 0, maxRecommended: 8 },
      ]);
    } finally { f.dispatcher.destroy(); }
  });
});
