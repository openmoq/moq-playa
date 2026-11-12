import { describe, expect, it, vi } from 'vitest';
import type { DecoderCommand } from '@openmoq/playback';
import { CommandDispatcher } from './command-dispatcher.js';
import type { ConfiguredDecoder } from './command-dispatcher.js';
import type { AudioDecoderLike, VideoDecoderLike } from './interfaces.js';
import { handlePipelineCommand } from './player-pipeline.js';

function video(): VideoDecoderLike {
  return { configure: vi.fn(), decode: vi.fn(), flush: vi.fn(async () => {}), reset: vi.fn(),
    destroy: vi.fn(), queueDepth: 0, onFrame: null, onError: null };
}
function audio(): AudioDecoderLike {
  return { configure: vi.fn(), decode: vi.fn(), flush: vi.fn(async () => {}), reset: vi.fn(),
    destroy: vi.fn(), queueDepth: 0, onData: null, onError: null };
}
const configure = (mediaType: 'video' | 'audio', config = Uint8Array.of(1, 2)): DecoderCommand => ({ type: 'configure', mediaType, config });

describe('successful configure argument receipts', () => {
  it('returns frozen video metadata and owned configuration bytes while preserving the native argument identity', () => {
    const decoder = video(), bytes = Uint8Array.of(1, 2);
    const dispatcher = new CommandDispatcher({ videoDecoder: decoder, videoCodec: 'avc1.640028', videoWidth: 1920, videoHeight: 1080 });
    const receipt = dispatcher.dispatch(configure('video', bytes));
    expect(decoder.configure).toHaveBeenCalledExactlyOnceWith(bytes, 'avc1.640028', 1920, 1080);
    expect(vi.mocked(decoder.configure).mock.calls[0]![0]).toBe(bytes);
    expect(receipt).toEqual({ mediaType: 'video', codec: 'avc1.640028', config: bytes, width: 1920, height: 1080 });
    expect(receipt!.config).not.toBe(bytes); expect(receipt!.config.buffer).not.toBe(bytes.buffer);
    expect(Object.isFrozen(receipt)).toBe(true); dispatcher.destroy();
  });

  it('returns the frozen exact audio arguments without substituting adapter defaults', () => {
    const decoder = audio(), bytes = Uint8Array.of(3, 4);
    const dispatcher = new CommandDispatcher({ audioDecoder: decoder, audioCodec: 'mp4a.40.2', audioSampleRate: 44_100, audioChannels: 6 });
    const receipt = dispatcher.dispatch(configure('audio', bytes));
    expect(decoder.configure).toHaveBeenCalledExactlyOnceWith(bytes, 'mp4a.40.2', 44_100, 6);
    expect(receipt).toEqual({ mediaType: 'audio', codec: 'mp4a.40.2', config: bytes, sampleRate: 44_100, channels: 6 });
    expect(receipt!.config).not.toBe(bytes);
    expect(Object.isFrozen(receipt)).toBe(true); dispatcher.destroy();
  });

  it.each(['video', 'audio'] as const)('omits undefined optional metadata in the %s receipt while preserving native call arity', role => {
    const decoder = role === 'video' ? video() : audio();
    const dispatcher = new CommandDispatcher(role === 'video' ? { videoDecoder: decoder as VideoDecoderLike }
      : { audioDecoder: decoder as AudioDecoderLike });
    const bytes = Uint8Array.of(1), receipt = dispatcher.dispatch(configure(role, bytes));
    expect(decoder.configure).toHaveBeenCalledExactlyOnceWith(bytes, '', undefined, undefined);
    expect(receipt).toEqual({ mediaType: role, codec: '', config: bytes });
    expect(Object.keys(receipt!)).toEqual(['mediaType', 'codec', 'config']); dispatcher.destroy();
  });

  it.each(['video', 'audio'] as const)('has no receipt or config-byte access without a %s adapter', role => {
    const dispatcher = new CommandDispatcher({}), read = vi.fn(() => { throw Error('unused bytes'); });
    const cmd = { type: 'configure' as const, mediaType: role, get config(): Uint8Array { return read(); } };
    expect(dispatcher.dispatch(cmd)).toBeUndefined(); expect(read).not.toHaveBeenCalled(); dispatcher.destroy();
  });

  it.each(['video', 'audio'] as const)('preserves the exact %s configure error instead of publishing success', role => {
    const decoder = role === 'video' ? video() : audio(), failure = Error('native configure failed');
    vi.mocked(decoder.configure).mockImplementation(() => { throw failure; });
    const dispatcher = new CommandDispatcher(role === 'video' ? { videoDecoder: decoder as VideoDecoderLike }
      : { audioDecoder: decoder as AudioDecoderLike });
    let receipt: ConfiguredDecoder | undefined;
    expect(() => { receipt = dispatcher.dispatch(configure(role)); }).toThrow(failure);
    expect(receipt).toBeUndefined(); expect(decoder.configure).toHaveBeenCalledOnce(); dispatcher.destroy();
  });

  it('keeps each receipt attached to its own invocation when configure reenters with newer metadata', () => {
    const decoder = video(), dispatcher = new CommandDispatcher({ videoDecoder: decoder,
      videoCodec: 'avc1.640028', videoWidth: 1920, videoHeight: 1080 });
    let nested: ConfiguredDecoder | undefined;
    vi.mocked(decoder.configure).mockImplementationOnce(() => {
      dispatcher.updateVideoCodec('vp09.00.10.08', 640, 360);
      nested = dispatcher.dispatch(configure('video'));
    });
    const outer = dispatcher.dispatch(configure('video'));
    expect(outer).toEqual({ mediaType: 'video', codec: 'avc1.640028', config: Uint8Array.of(1, 2), width: 1920, height: 1080 });
    expect(nested).toEqual({ mediaType: 'video', codec: 'vp09.00.10.08', config: Uint8Array.of(1, 2), width: 640, height: 360 });
    expect(Object.isFrozen(outer)).toBe(true); expect(Object.isFrozen(nested)).toBe(true);
    expect(vi.mocked(decoder.configure).mock.calls.map(call => call.slice(1))).toEqual([
      ['avc1.640028', 1920, 1080], ['vp09.00.10.08', 640, 360],
    ]); dispatcher.destroy();
  });

  it('preserves method/config getter order and receiver while snapshotting the actual passed metadata', () => {
    const decoder = video(), dispatcher = new CommandDispatcher({ videoDecoder: decoder, videoCodec: 'before' });
    const order: string[] = [], bytes = Uint8Array.of(7);
    const native = vi.fn(function (this: VideoDecoderLike) {
      expect(this).toBe(decoder); order.push('invoke'); dispatcher.updateVideoCodec('after', 9, 9);
    });
    Object.defineProperty(decoder, 'configure', { get() {
      order.push('method'); dispatcher.updateVideoCodec('method', 1, 2); return native;
    } });
    const cmd = { type: 'configure' as const, mediaType: 'video' as const, get config() {
      order.push('bytes'); dispatcher.updateVideoCodec('actual', 3, 4); return bytes;
    } };
    const receipt = dispatcher.dispatch(cmd);
    expect(order).toEqual(['method', 'bytes', 'invoke']);
    expect(native).toHaveBeenCalledExactlyOnceWith(bytes, 'actual', 3, 4);
    expect(receipt).toEqual({ mediaType: 'video', codec: 'actual', config: bytes, width: 3, height: 4 }); dispatcher.destroy();
  });

  it('preserves a throwing configure getter without reading arguments or returning a receipt', () => {
    const decoder = video(), dispatcher = new CommandDispatcher({ videoDecoder: decoder }), failure = Error('configure getter');
    Object.defineProperty(decoder, 'configure', { get() { throw failure; } });
    const read = vi.fn(() => Uint8Array.of(1));
    expect(() => dispatcher.dispatch({ type: 'configure', mediaType: 'video', get config() { return read(); } })).toThrow(failure);
    expect(read).not.toHaveBeenCalled(); dispatcher.destroy();
  });

  it('invokes the actual configure function even if it carries its own call property', () => {
    const decoder = video(), intercepted = vi.fn();
    Object.defineProperty(decoder.configure, 'call', { value: intercepted });
    const dispatcher = new CommandDispatcher({ videoDecoder: decoder, videoCodec: 'actual' });
    const bytes = Uint8Array.of(1), receipt = dispatcher.dispatch(configure('video', bytes));
    expect(decoder.configure).toHaveBeenCalledExactlyOnceWith(bytes, 'actual', undefined, undefined);
    expect(intercepted).not.toHaveBeenCalled();
    expect(receipt).toEqual({ mediaType: 'video', codec: 'actual', config: bytes }); dispatcher.destroy();
  });

  it('returns no configure receipt from decode, reset, flush or playback-rate commands', async () => {
    const decoder = video(), ad = audio(), dispatcher = new CommandDispatcher({ videoDecoder: decoder, audioDecoder: ad });
    const commands: DecoderCommand[] = [
      { type: 'decode_video', chunk: { type: 'key', timestamp: 0, data: Uint8Array.of(1) }, renderTimeUs: 0 },
      { type: 'decode_audio', chunk: { type: 'key', timestamp: 0, data: Uint8Array.of(1) }, renderTimeUs: 0 },
      { type: 'flush', mediaType: 'video' }, { type: 'flush', mediaType: 'audio' },
      { type: 'reset', mediaType: 'video', reason: 'test' }, { type: 'reset', mediaType: 'audio', reason: 'test' },
    ];
    for (const command of commands) expect(dispatcher.dispatch(command)).toBeUndefined();
    await Promise.resolve(); dispatcher.destroy();
  });
});

describe('pipeline configure receipt forwarding', () => {
  it('returns the exact dispatch receipt after one transform and the existing pre-native event', () => {
    const decoder = video(), dispatcher = new CommandDispatcher({ videoDecoder: decoder, videoCodec: 'initial' });
    const bytes = Uint8Array.of(5), transformed = configure('video', bytes), order: string[] = [];
    const transform = vi.fn(() => { order.push('transform'); return transformed; });
    const emit = vi.fn(event => {
      order.push('event'); expect(event.command).toBe(transformed); dispatcher.updateVideoCodec('event-codec', 1280, 720);
    });
    vi.mocked(decoder.configure).mockImplementation(() => { order.push('native'); dispatcher.updateVideoCodec('later'); });
    const dispatched = vi.spyOn(dispatcher, 'dispatch');
    const receipt = handlePipelineCommand(configure('video'), transform, dispatcher, null, emit);
    expect(order).toEqual(['transform', 'event', 'native']); expect(transform).toHaveBeenCalledOnce(); expect(emit).toHaveBeenCalledOnce();
    expect(decoder.configure).toHaveBeenCalledExactlyOnceWith(bytes, 'event-codec', 1280, 720);
    expect(receipt).toEqual({ mediaType: 'video', codec: 'event-codec', config: bytes, width: 1280, height: 720 });
    expect(receipt).toBe(dispatched.mock.results[0]!.value); dispatcher.destroy();
  });

  it('has no receipt on suppression, absent dispatcher, or retirement at the existing event boundary', () => {
    const decoder = video(), dispatcher = new CommandDispatcher({ videoDecoder: decoder }), emit = vi.fn();
    expect(handlePipelineCommand(configure('video'), () => null, dispatcher, null, emit)).toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
    expect(handlePipelineCommand(configure('video'), undefined, null, null, emit)).toBeUndefined();
    expect(emit).toHaveBeenCalledOnce();
    let live = true;
    expect(handlePipelineCommand(configure('video'), undefined, dispatcher, null, () => { live = false; }, undefined, () => live)).toBeUndefined();
    expect(decoder.configure).not.toHaveBeenCalled(); dispatcher.destroy();
  });

  it('keeps reset preservation and transform/event ordering without inventing a configuration', () => {
    const decoder = video(), dispatcher = new CommandDispatcher({ videoDecoder: decoder }), emit = vi.fn();
    const reset: DecoderCommand = { type: 'reset', mediaType: 'video', reason: 'prepared' };
    const dispatched = vi.spyOn(dispatcher, 'dispatch');
    expect(handlePipelineCommand(configure('video'), () => reset, dispatcher, null, emit, 'video')).toBeUndefined();
    expect(dispatched).toHaveBeenCalledExactlyOnceWith(reset, { preserveDecoder: true });
    expect(decoder.reset).not.toHaveBeenCalled(); expect(decoder.configure).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledExactlyOnceWith({ type: 'decoder_command', command: reset }); dispatcher.destroy();
  });

  it('leaves the post-call owner decision with the host while returning historical successful arguments', () => {
    const decoder = video(), dispatcher = new CommandDispatcher({ videoDecoder: decoder, videoCodec: 'vp09.00.10.08' });
    let live = true;
    vi.mocked(decoder.configure).mockImplementation(() => { live = false; dispatcher.destroy(); });
    const receipt = handlePipelineCommand(configure('video'), undefined, dispatcher, null, vi.fn(), undefined, () => live);
    expect(receipt).toEqual({ mediaType: 'video', codec: 'vp09.00.10.08', config: Uint8Array.of(1, 2) });
    expect(live).toBe(false); expect(decoder.destroy).toHaveBeenCalledOnce();
  });
});

describe('configure byte-view ownership', () => {
  it.each(['video', 'audio'] as const)('captures the actual %s getter value instead of reading the command again after dispatch', role => {
    const decoder = role === 'video' ? video() : audio(), first = Uint8Array.of(1), later = Uint8Array.of(9);
    const dispatcher = new CommandDispatcher(role === 'video' ? { videoDecoder: decoder as VideoDecoderLike }
      : { audioDecoder: decoder as AudioDecoderLike });
    let reads = 0;
    const transformed = { type: 'configure' as const, mediaType: role, get config() {
      return ++reads === 1 ? first : later;
    } };
    const transform = vi.fn(() => transformed);
    const receipt = handlePipelineCommand(configure(role), transform, dispatcher, null, vi.fn());
    expect(reads).toBe(1); expect(transform).toHaveBeenCalledOnce();
    expect(vi.mocked(decoder.configure).mock.calls[0]![0]).toBe(first);
    // This is the old post-dispatch ledger read, which no longer supplies the
    // successful configure bytes. There was no newer configure invocation.
    expect(transformed.config).toBe(later);
    expect(receipt!.config).toEqual(Uint8Array.of(1));
    expect(receipt!.config).not.toBe(first); expect(receipt!.config).not.toBe(later);
    expect(decoder.configure).toHaveBeenCalledOnce(); dispatcher.destroy();
  });

  it.each(['video', 'audio'] as const)('snapshots %s bytes before the native callback mutates its original view', role => {
    const decoder = role === 'video' ? video() : audio(), bytes = Uint8Array.of(1, 2);
    vi.mocked(decoder.configure).mockImplementation(view => { expect(view).toBe(bytes); view.fill(9); });
    const dispatcher = new CommandDispatcher(role === 'video' ? { videoDecoder: decoder as VideoDecoderLike }
      : { audioDecoder: decoder as AudioDecoderLike });
    const receipt = dispatcher.dispatch(configure(role, bytes));
    expect(bytes).toEqual(Uint8Array.of(9, 9));
    expect(receipt!.config).toEqual(Uint8Array.of(1, 2));
    bytes.fill(7); expect(receipt!.config).toEqual(Uint8Array.of(1, 2));
    receipt!.config[0] = 4; expect(bytes).toEqual(Uint8Array.of(7, 7));
    expect(Object.isFrozen(receipt)).toBe(true); dispatcher.destroy();
  });

  it('copies only the actual typed-array view through intrinsics without slice, iterator or view-property hooks', () => {
    const backing = Uint8Array.of(99, 1, 2, 88);
    const view = new (class extends Uint8Array {})(backing.buffer, 1, 2);
    const hooks = vi.fn(() => { throw Error('host byte-copy hook invoked'); });
    for (const key of ['slice', 'buffer', 'byteOffset', 'byteLength', Symbol.iterator]) {
      Object.defineProperty(view, key, { get: hooks });
    }
    const decoder = video(), dispatcher = new CommandDispatcher({ videoDecoder: decoder });
    const receipt = dispatcher.dispatch(configure('video', view));
    expect(vi.mocked(decoder.configure).mock.calls[0]![0]).toBe(view);
    expect(receipt!.config).toEqual(Uint8Array.of(1, 2));
    expect(Object.getPrototypeOf(receipt!.config)).toBe(Uint8Array.prototype);
    expect(hooks).not.toHaveBeenCalled();
    backing.fill(9); expect(receipt!.config).toEqual(Uint8Array.of(1, 2)); dispatcher.destroy();
  });
});
