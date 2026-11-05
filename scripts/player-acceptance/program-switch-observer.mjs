// @ts-check
/**
 * Input/output timestamp correlation for unique-PTS program fixtures. Preserve
 * the native decoder's producing timing context; never reconstruct it from a
 * current global map. This sensor is not a draw/presentation observation.
 */
export function observeProgramDecodedSource() {
  let inputs = 0, outputs = 0, matched = 0;
  /** @type {string[]} */
  const failures = [];
  const fail = /** @param {string} reason */ reason => { if (failures.length < 16) failures.push(reason); };
  /** @param {import('../../packages/loc/src/types.js').SourceTimestamp | null | undefined} source */
  const serialize = source => source && typeof source.ticks === 'bigint' && typeof source.ticksPerSecond === 'bigint'
    && source.ticksPerSecond > 0n ? JSON.stringify({ ticks: String(source.ticks), ticksPerSecond: String(source.ticksPerSecond), domain: source.domain }) : null;
  return {
    /** @param {import('../../packages/player/src/interfaces.js').VideoDecoderLike} decoder */
    wrap(decoder) {
      /** @type {Map<number, string | null>} */
      const pending = new Map();
      /** @type {import('../../packages/player/src/interfaces.js').VideoDecoderLike} */
      const wrapper = {
        ...(decoder.supportsOutputTiming === true ? { supportsOutputTiming: true } : {}),
        configure(...args) { pending.clear(); decoder.configure(...args); },
        decode(chunk, time, input, renderTiming) {
          inputs++;
          if (pending.has(chunk.timestamp)) fail('duplicate fixture input timestamp');
          if (pending.size >= 256) {
            fail('input observer overflow');
            const oldest = pending.keys().next().value;
            if (oldest !== undefined) pending.delete(oldest);
          }
          pending.set(chunk.timestamp, serialize(chunk.sourceTimestamp));
          decoder.decode(chunk, time, input, renderTiming);
        },
        flush: () => decoder.flush(),
        reset() { pending.clear(); decoder.reset(); },
        destroy() { pending.clear(); decoder.destroy(); },
        get queueDepth() { return decoder.queueDepth; },
        onFrame: null,
        get onError() { return decoder.onError; },
        set onError(value) { decoder.onError = value; },
      };
      decoder.onFrame = (frame, time, source, input, renderTiming) => {
        outputs++;
        const timestamp = typeof frame === 'object' && frame !== null && 'timestamp' in frame ? frame.timestamp : undefined;
        const expected = typeof timestamp === 'number' ? pending.get(timestamp) : null;
        if (typeof timestamp === 'number') pending.delete(timestamp);
        if (!expected || serialize(source) !== expected || !source || !Object.isFrozen(source)) fail('decoded source did not match its immutable input');
        else matched++;
        if (wrapper.onFrame) wrapper.onFrame(frame, time, source, input, renderTiming);
        else if (typeof frame === 'object' && frame !== null && 'close' in frame && typeof frame.close === 'function') frame.close();
      };
      return wrapper;
    },
    snapshot() { return { inputs, outputs, matched, failures: [...failures] }; },
  };
}
