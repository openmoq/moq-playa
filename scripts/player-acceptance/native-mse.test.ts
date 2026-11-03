import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeNativeMse } from '../../examples/_tests/player-acceptance/native-mse.js';

afterEach(() => vi.unstubAllGlobals());

function nativeSurface() {
  const calls: unknown[] = [];
  const result = Symbol('native result');
  class Buffer {
    private offset = 3.75;
    readonly offsetWrites: number[] = [];
    get timestampOffset() { return this.offset; }
    set timestampOffset(value: number) { this.offsetWrites.push(value); this.offset = value; }
    failure?: Error;
    changeType(...args: unknown[]) {
      calls.push({ receiver: this, args });
      if (this.failure) throw this.failure;
      return result;
    }
  }
  class Source {
    addSourceBuffer(_mime: string) { return new Buffer(); }
  }
  vi.stubGlobal('MediaSource', Source);
  vi.stubGlobal('SourceBuffer', Buffer);
  return { Source, Buffer, calls, result };
}

describe('native MSE acceptance observer', () => {
  it('leaves existing nonzero offsets untouched and delegates original receiver, arguments and result', () => {
    const { Source, calls, result } = nativeSurface();
    const observer = observeNativeMse();
    const source = new Source();
    const video = source.addSourceBuffer('video/mp4');
    const audio = source.addSourceBuffer('audio/mp4');
    expect([video.timestampOffset, audio.timestampOffset]).toEqual([3.75, 3.75]);
    expect(video.changeType('video/mp4; codecs="avc1.42c01e"', result)).toBe(result);
    expect(calls).toEqual([{ receiver: video, args: ['video/mp4; codecs="avc1.42c01e"', result] }]);
    expect(observer.snapshot().calls).toMatchObject([{ bufferId: 0, offsetBefore: 3.75, offsetAfter: 3.75, error: null }]);
    expect([video.offsetWrites, audio.offsetWrites]).toEqual([[], []]);
    video.timestampOffset = 7;
    expect(observer.snapshot().buffers[0]!.offset).toBe(7); // Never repairs the value being measured.
    observer.restore();
  });
  it('propagates native exceptions and restores the original methods', () => {
    const { Source, Buffer } = nativeSurface();
    const originalAdd = Source.prototype.addSourceBuffer, originalChange = Buffer.prototype.changeType;
    const observer = observeNativeMse();
    const video = new Source().addSourceBuffer('video/mp4');
    const error = new Error('native failure');
    video.failure = error;
    expect(() => video.changeType('bad MIME')).toThrow(error);
    expect(observer.snapshot().calls[0]!.error).toContain('native failure');
    observer.restore();
    expect(Source.prototype.addSourceBuffer).toBe(originalAdd);
    expect(Buffer.prototype.changeType).toBe(originalChange);
  });
});
