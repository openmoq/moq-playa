import type { SourceTimestamp, VideoChunkInit } from '@openmoq/loc';
import type { VideoDecoderLike } from '@openmoq/player';

/** Independent input/output check for the fixed-track, unique-PTS fixtures. */
export function observeDecodedSource() {
  let inputs = 0;
  let outputs = 0;
  let matched = 0;
  const failures: string[] = [];
  const fail = (message: string) => { if (failures.length < 16) failures.push(message); };
  const serialize = (source: SourceTimestamp | null | undefined) =>
    source && typeof source.ticks === 'bigint' && typeof source.ticksPerSecond === 'bigint'
      && source.ticksPerSecond > 0n && ['unix', 'media', 'unknown'].includes(source.domain)
      ? JSON.stringify({ ticks: source.ticks.toString(), ticksPerSecond: source.ticksPerSecond.toString(), domain: source.domain })
      : null;

  return {
    wrap(decoder: VideoDecoderLike): VideoDecoderLike {
      const pending = new Map<number, string | null>();
      const wrapper: VideoDecoderLike = {
        configure(...args) { pending.clear(); decoder.configure(...args); },
        decode(chunk: VideoChunkInit, time: number) {
          inputs++;
          if (pending.has(chunk.timestamp)) fail('duplicate fixture input timestamp');
          if (pending.size >= 256) {
            fail('input observer overflow');
            pending.delete(pending.keys().next().value!);
          }
          pending.set(chunk.timestamp, serialize(chunk.sourceTimestamp));
          decoder.decode(chunk, time);
        },
        flush: () => decoder.flush(),
        reset() { pending.clear(); decoder.reset(); },
        destroy() { pending.clear(); decoder.destroy(); },
        get queueDepth() { return decoder.queueDepth; },
        onFrame: null,
        get onError() { return decoder.onError; },
        set onError(callback) { decoder.onError = callback; },
      };
      decoder.onFrame = (frame, time, source) => {
        outputs++;
        const timestamp = (frame as { timestamp: number }).timestamp;
        const expected = pending.get(timestamp);
        pending.delete(timestamp);
        if (!expected || !source || serialize(source) !== expected) fail('decoded source did not match its input');
        else matched++;
        if (source && !Object.isFrozen(source)) fail('decoded source was mutable');
        if (wrapper.onFrame) wrapper.onFrame(frame, time, source);
        else (frame as { close(): void }).close();
      };
      return wrapper;
    },
    snapshot() { return { inputs, outputs, matched, failures: [...failures] }; },
  };
}
