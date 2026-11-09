import { describe, expect, it, vi } from 'vitest';
import type { AudioRenderTiming, DecodeAudioCommand } from '@openmoq/playback';
import type { AudioDecoderLike, AudioOutputLike, AudioProducedTiming } from './interfaces.js';
import { CommandDispatcher } from './command-dispatcher.js';

const context = (): AudioRenderTiming => ({ epoch: {}, sourceTimestampUs: 100n, presentFromSourceUs: 500n,
  recomputeRenderTimeUs: () => 1000 });
const data = () => ({ close: vi.fn() });
function fixture(decoderTiming = true, outputTiming = true) {
  const decoder: AudioDecoderLike & { decode: ReturnType<typeof vi.fn> } = {
    ...(decoderTiming ? { supportsOutputTiming: true as const } : {}), configure: vi.fn(), decode: vi.fn(), flush: async () => {},
    reset: vi.fn(), destroy: vi.fn(), queueDepth: 0, onData: null, onError: null };
  const output: AudioOutputLike & { schedule: ReturnType<typeof vi.fn> } = {
    ...(outputTiming ? { supportsOutputTiming: true as const } : {}), schedule: vi.fn(), flush: vi.fn(), destroy: vi.fn(), currentPlayoutTimeUs: 0 };
  const feedback = vi.fn(), fatal = vi.fn();
  const dispatcher = new CommandDispatcher({ audioDecoder: decoder, audioOutput: output, onFeedback: feedback,
    onError: fatal, getPlaybackDelayUs: () => 250 });
  const command = (c?: AudioRenderTiming, token?: object): DecodeAudioCommand => ({ type: 'decode_audio',
    chunk: { type: 'key', timestamp: 100, data: Uint8Array.of(1) }, renderTimeUs: 1000,
    ...(c ? { renderTiming: c } : {}), ...(token ? { inputToken: token } : {}) });
  const emit = (pcm: ReturnType<typeof data>, timing?: AudioProducedTiming | null, token?: object) => decoder.onData!(pcm, 1000, token, timing);
  return { decoder, output, feedback, fatal, dispatcher, command, emit };
}

describe('dispatcher audio producing context', () => {
  it('preserves exact ordinary decode/schedule call arity, with or without diagnostic input', () => {
    const f = fixture(), cmd = f.command(); f.dispatcher.dispatch(cmd);
    expect(f.decoder.decode.mock.calls[0]).toEqual([cmd.chunk, 1000]);
    const pcm = data(); f.emit(pcm); expect(f.output.schedule.mock.calls[0]).toEqual([pcm, 1250]);
    const token = {}, observed = f.command(undefined, token); f.dispatcher.dispatch(observed);
    expect(f.decoder.decode.mock.calls[1]).toEqual([observed.chunk, 1000, token]);
  });
  it('passes the same producing context as fourth decode argument and the same output witness into schedule', () => {
    const f = fixture(), c = context(), cmd = f.command(c); f.dispatcher.dispatch(cmd);
    expect(f.decoder.decode.mock.calls[0]).toEqual([cmd.chunk, 1000, undefined, c]);
    const pcm = data(), witness = { context: c, sourceOffsetUs: 0 }; f.emit(pcm, witness);
    expect(f.output.schedule.mock.calls[0]).toEqual([pcm, 1250, undefined, witness]); expect(pcm.close).not.toHaveBeenCalled();
  });
  it('keeps native output diagnostics distinct from input identity', () => {
    const f = fixture(), c = context(), input = {}, unit = {}, witness = { context: c, sourceOffsetUs: 0 };
    const decoded = vi.fn(() => unit); f.dispatcher.outputObserver = { decoded, discarded: vi.fn() };
    f.dispatcher.dispatch(f.command(c, input)); const pcm = data(); f.emit(pcm, witness, input);
    expect(decoded).toHaveBeenCalledWith('audio', input, f.output);
    expect(f.output.schedule.mock.calls[0]).toEqual([pcm, 1250, unit, witness]);
  });
  it.each([[false, true, 'decoder unsupported'], [true, false, 'output unsupported']] as const)(
    'refuses armed input with decoder/output capability %s/%s', (decoder, output, reason) => {
      const f = fixture(decoder, output); f.dispatcher.dispatch(f.command(context()));
      expect(f.decoder.decode).not.toHaveBeenCalled(); expect(f.feedback).toHaveBeenCalledWith({ type: 'audio_timing_unavailable', mediaType: 'audio', reason });
      const pcm = data(); f.emit(pcm); expect(pcm.close).toHaveBeenCalledOnce(); expect(f.output.schedule).not.toHaveBeenCalled();
      expect(f.fatal).not.toHaveBeenCalled();
    });
  it.each(['omitted', 'null', 'foreign'] as const)('closes %s producing output without an untrimmed fallback', kind => {
    const f = fixture(), c = context(); f.dispatcher.dispatch(f.command(c)); const pcm = data();
    f.emit(pcm, kind === 'omitted' ? undefined : kind === 'null' ? null : { context: context(), sourceOffsetUs: 0 });
    expect(pcm.close).toHaveBeenCalledOnce(); expect(f.output.schedule).not.toHaveBeenCalled();
    expect(f.feedback).toHaveBeenCalledWith({ type: 'audio_timing_unavailable', mediaType: 'audio', reason: 'output unproven' });
    expect(f.fatal).not.toHaveBeenCalled();
  });
  it('reports retired context as unavailable rather than a fatal decoder error', () => {
    const f = fixture(), live = { value: true }, c = { ...context(), recomputeRenderTimeUs: () => live.value ? 1000 : null };
    f.dispatcher.dispatch(f.command(c)); live.value = false; const pcm = data(); f.emit(pcm, { context: c, sourceOffsetUs: 0 });
    expect(pcm.close).toHaveBeenCalledOnce(); expect(f.output.schedule).not.toHaveBeenCalled(); expect(f.fatal).not.toHaveBeenCalled();
    expect(f.feedback).toHaveBeenCalledWith({ type: 'audio_timing_unavailable', mediaType: 'audio', reason: 'context retired' });
  });
  it('registers context before synchronous native output', () => {
    const f = fixture(), c = context(), pcm = data(), witness = { context: c, sourceOffsetUs: 0 };
    f.decoder.decode.mockImplementation(() => f.emit(pcm, witness)); f.dispatcher.dispatch(f.command(c));
    expect(f.output.schedule.mock.calls[0]![3]).toBe(witness);
  });
  it('retires saved callbacks and contexts on flush, then permits a fresh context', () => {
    const f = fixture(), c = context(); f.dispatcher.dispatch(f.command(c)); const old = f.decoder.onData!;
    f.dispatcher.flush(); const pcm = data(); old(pcm, 1000, undefined, { context: c, sourceOffsetUs: 0 });
    expect(pcm.close).toHaveBeenCalledOnce(); expect(f.output.schedule).not.toHaveBeenCalled();
    const next = context(), witness = { context: next, sourceOffsetUs: 0 }; f.dispatcher.dispatch(f.command(next)); f.emit(data(), witness);
    expect(f.output.schedule.mock.calls[0]![3]).toBe(witness);
  });
  it.each(['reset', 'destroy'] as const)('retires saved output callbacks on %s without reviving unknown PCM', action => {
    const f = fixture(), c = context(); f.dispatcher.dispatch(f.command(c)); const old = f.decoder.onData!;
    if (action === 'reset') f.dispatcher.dispatch({ type: 'reset', mediaType: 'audio', reason: 'seek' });
    else f.dispatcher.destroy();
    const pcm = data(); old(pcm, 1000); expect(pcm.close).toHaveBeenCalledOnce(); expect(f.output.schedule).not.toHaveBeenCalled();
    if (action === 'reset') {
      const next = context(), witness = { context: next, sourceOffsetUs: 0 };
      f.dispatcher.dispatch(f.command(next)); f.emit(data(), witness);
      expect(f.output.schedule.mock.calls[0]![3]).toBe(witness);
    }
  });
  it('cannot submit output when its producing query flushes reentrantly', () => {
    const f = fixture(), query = vi.fn(() => 1000), c = { ...context(), recomputeRenderTimeUs: query };
    f.dispatcher.dispatch(f.command(c)); query.mockImplementationOnce(() => { f.dispatcher.flush(); return 1000; });
    const pcm = data(); f.emit(pcm, { context: c, sourceOffsetUs: 0 });
    expect(pcm.close).toHaveBeenCalledOnce(); expect(f.output.schedule).not.toHaveBeenCalled(); expect(f.fatal).not.toHaveBeenCalled();
  });
  it('cannot schedule after a decoded observer flushes reentrantly', () => {
    const f = fixture(), c = context(), unit = {}, discarded = vi.fn();
    f.dispatcher.outputObserver = { decoded: () => { f.dispatcher.flush(); return unit; }, discarded };
    f.dispatcher.dispatch(f.command(c)); const pcm = data(); f.emit(pcm, { context: c, sourceOffsetUs: 0 });
    expect(pcm.close).toHaveBeenCalledOnce(); expect(discarded).toHaveBeenCalledWith(unit, 'flushed'); expect(f.output.schedule).not.toHaveBeenCalled();
  });
});
