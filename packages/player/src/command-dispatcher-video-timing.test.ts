import { describe, expect, it, vi } from 'vitest';
import type { VideoRenderTiming } from '@openmoq/playback';
import { CommandDispatcher } from './command-dispatcher.js';
import type { VideoDecoderLike, VideoRendererLike } from './interfaces.js';

function fixture() {
    const decoder: VideoDecoderLike = { supportsOutputTiming: true, configure() {}, decode: vi.fn(),
        flush: async () => {}, reset() {}, destroy() {}, queueDepth: 0, onFrame: null, onError: null };
    const renderer: VideoRendererLike = { enqueue: vi.fn(), flush() {}, destroy() {},
        onFirstFrame: null, onFrameRendered: null, onStall: null };
    let ready = true;
    const globalTiming = vi.fn((source: bigint) => Number(source) + 50);
    const cushion = vi.fn(() => 2_000);
    const dispatcher = new CommandDispatcher({ videoDecoder: decoder, renderer,
        hasSyncReference: () => ready, recomputeVideoRenderTime: globalTiming, getPlaybackDelayUs: cushion });
    return { decoder, renderer, dispatcher, globalTiming, cushion, ready(value: boolean) { ready = value; },
        frame(timestamp: number) { return { timestamp, close: vi.fn() }; },
        submit(timestamp: number, renderTiming?: VideoRenderTiming, inputToken?: object) {
            const chunk = { type: 'key' as const, timestamp, data: Uint8Array.of(1) };
            dispatcher.dispatch({ type: 'decode_video', chunk, renderTimeUs: 1,
                ...(renderTiming ? { renderTiming } : {}), ...(inputToken ? { inputToken } : {}) });
            return chunk;
        } };
}

describe('dispatcher producing video timing', () => {
    it('passes timing as fourth decode argument while preserving ordinary arity', () => {
        const f = fixture(), timing = { recomputeRenderTimeUs: () => 10 }, token = {};
        const mapped = f.submit(90, timing, token);
        expect(f.decoder.decode).toHaveBeenLastCalledWith(mapped, 1, token, timing);
        const normal = f.submit(100);
        expect(f.decoder.decode).toHaveBeenLastCalledWith(normal, 1);
        const observed = f.submit(101, undefined, token);
        expect(f.decoder.decode).toHaveBeenLastCalledWith(observed, 1, token);
    });

    it('schedules out-of-order outputs from each producing context with one cushion', () => {
        const f = fixture(), one = f.frame(90_000_000), two = f.frame(91_000_000);
        const a = { recomputeRenderTimeUs: vi.fn(() => 10_000_000) };
        const b = { recomputeRenderTimeUs: vi.fn(() => 11_000_000) };
        f.submit(one.timestamp, a); f.submit(two.timestamp, b);
        f.decoder.onFrame!(two, 1, null, undefined, b);
        f.decoder.onFrame!(one, 1, null, undefined, a);
        expect(f.renderer.enqueue).toHaveBeenNthCalledWith(1, two, 11_002_000);
        expect(f.renderer.enqueue).toHaveBeenNthCalledWith(2, one, 10_002_000);
        expect(f.globalTiming).not.toHaveBeenCalled();
        expect(a.recomputeRenderTimeUs).toHaveBeenCalledOnce();
        expect(b.recomputeRenderTimeUs).toHaveBeenCalledOnce();
    });

    it('retains producing contexts through the hold queue and recomputes at actual release', () => {
        const f = fixture(), held = f.frame(90), current = f.frame(100); let nominal = 10_000;
        const timing = { recomputeRenderTimeUs: () => nominal };
        f.ready(false); f.decoder.onFrame!(held, 1, null, undefined, timing);
        expect(f.renderer.enqueue).not.toHaveBeenCalled();
        nominal = 20_000;
        f.ready(true); f.decoder.onFrame!(current, 1);
        expect(f.renderer.enqueue).toHaveBeenNthCalledWith(1, held, 22_000);
        expect(f.renderer.enqueue).toHaveBeenNthCalledWith(2, current, 150);
        expect(f.globalTiming).toHaveBeenCalledExactlyOnceWith(100n);
        expect(f.cushion).toHaveBeenCalledOnce();
    });

    it('keeps the default output path on global recomputation without a second cushion', () => {
        const f = fixture(), frame = f.frame(100);
        f.decoder.onFrame!(frame, 1);
        expect(f.renderer.enqueue).toHaveBeenCalledWith(frame, 150);
        expect(f.cushion).not.toHaveBeenCalled();
    });

    it.each([null, NaN, Infinity])('discards unavailable mapped timing %s without global fallback', value => {
        const f = fixture(), frame = f.frame(90);
        const observer = { decoded: vi.fn(() => ({})), discarded: vi.fn() };
        f.dispatcher.outputObserver = observer;
        f.decoder.onFrame!(frame, 1, null, undefined, { recomputeRenderTimeUs: () => value });
        f.dispatcher.flush();
        expect(frame.close).toHaveBeenCalledOnce();
        expect(observer.discarded).toHaveBeenCalledTimes(1);
        expect(f.renderer.enqueue).not.toHaveBeenCalled();
        expect(f.globalTiming).not.toHaveBeenCalled();
    });

    it('discards an explicit missing-association signal even before shared sync is ready', () => {
        const f = fixture(), frame = f.frame(90);
        f.ready(false); f.decoder.onFrame!(frame, 1, null, undefined, null);
        expect(frame.close).toHaveBeenCalledOnce();
        f.ready(true); f.decoder.onFrame!(f.frame(100), 1);
        expect(f.renderer.enqueue).toHaveBeenCalledTimes(1);
    });

    it.each(['timing', 'cushion'] as const)('rechecks output ownership after the %s callback', callback => {
        const f = fixture(), frame = f.frame(90);
        const timing = { recomputeRenderTimeUs: () => { if (callback === 'timing') f.dispatcher.flush(); return 10; } };
        if (callback === 'cushion') f.cushion.mockImplementation(() => { f.dispatcher.flush(); return 2_000; });
        f.decoder.onFrame!(frame, 1, null, undefined, timing);
        expect(frame.close).toHaveBeenCalledOnce();
        expect(f.renderer.enqueue).not.toHaveBeenCalled();
    });

    it('closes every held/current frame once when a producing callback resets the output', () => {
        const f = fixture(), first = f.frame(90), second = f.frame(91), current = f.frame(100);
        f.ready(false);
        f.decoder.onFrame!(first, 1, null, undefined, { recomputeRenderTimeUs: () => { f.dispatcher.flush(); return 10; } });
        f.decoder.onFrame!(second, 1, null, undefined, { recomputeRenderTimeUs: () => 20 });
        f.ready(true); f.decoder.onFrame!(current, 1);
        for (const frame of [first, second, current]) expect(frame.close).toHaveBeenCalledOnce();
        expect(f.renderer.enqueue).not.toHaveBeenCalled();
    });

    it('releases a frame and its observation once if its mapped callback throws', () => {
        const f = fixture(), frame = f.frame(90);
        const observer = { decoded: vi.fn(() => ({})), discarded: vi.fn() };
        f.dispatcher.outputObserver = observer;
        expect(() => f.decoder.onFrame!(frame, 1, null, undefined, { recomputeRenderTimeUs: () => { throw new Error('timing lost'); } }))
            .toThrow('timing lost');
        f.dispatcher.flush();
        expect(frame.close).toHaveBeenCalledOnce();
        expect(observer.discarded).toHaveBeenCalledTimes(1);
        expect(f.globalTiming).not.toHaveBeenCalled();
    });

    it('accepts zero nominal time and refuses a nonfinite cushion', () => {
        const f = fixture(), valid = f.frame(90), invalid = f.frame(91);
        f.cushion.mockReturnValueOnce(0).mockReturnValueOnce(Infinity);
        const timing = { recomputeRenderTimeUs: () => 0 };
        f.decoder.onFrame!(valid, 1, null, undefined, timing);
        f.decoder.onFrame!(invalid, 1, null, undefined, timing);
        expect(f.renderer.enqueue).toHaveBeenCalledExactlyOnceWith(valid, 0);
        expect(invalid.close).toHaveBeenCalledOnce();
        expect(valid.close).not.toHaveBeenCalled();
    });
});
