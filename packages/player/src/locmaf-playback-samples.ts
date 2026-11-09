import type { LocHeaders, SourceTimestamp } from '@openmoq/loc';
import { ticksToMicros } from '@openmoq/locmaf';
import type { LocmafFrameUnit } from '@openmoq/locmaf';
import type { PlaybackSample } from '@openmoq/playback';

/** Semantic decoder input, never serialized LOC properties or a new wire Object. */
export function locmafPlaybackSamples(role: 'video' | 'audio', units: readonly LocmafFrameUnit[],
  description: Uint8Array | null, rounding: 'floor' | 'nearest' = 'floor'): readonly PlaybackSample[] {
  return Object.freeze(units.map((unit, index) => {
    if (unit.sampleIndex !== index || !Number.isSafeInteger(unit.timescale) || unit.timescale <= 0
        || !Number.isSafeInteger(unit.duration) || unit.duration <= 0) throw new Error('Invalid LOCMAF sample timing');
    // Indexed readers default to floor. Live engine consumers explicitly retain
    // their existing nearest-microsecond projection; source ticks remain exact.
    const scale = BigInt(unit.timescale), time = rounding === 'nearest'
      ? ticksToMicros(unit.presentationTime, unit.timescale) : unit.presentationTime * 1_000_000n / scale;
    const timestamp = Number(time);
    if (!Number.isSafeInteger(timestamp)) throw new Error('LOCMAF sample timestamp is outside the native integer range');
    const duration = Number(rounding === 'nearest' ? ticksToMicros(BigInt(unit.duration), unit.timescale)
      : BigInt(unit.duration) * 1_000_000n / scale);
    const sourceTimestamp: SourceTimestamp = Object.freeze({ ticks: unit.presentationTime, ticksPerSecond: scale, domain: 'media' });
    const headers: LocHeaders = Object.freeze({ captureTimestamp: time, timestamp: unit.presentationTime,
      timescale: scale, timestampIsWallClock: false, ...(duration > 0 ? { duration } : {}),
      ...(role === 'video' ? { videoFrameMarking: Object.freeze({ independent: unit.isSync,
        startOfFrame: true, endOfFrame: true, discardable: !unit.isSync && ((unit.flags >>> 22) & 3) === 2,
        baseLayerSync: false, temporalId: 0 }), ...(unit.isSync && description ? { videoConfig: description } : {}) }
        : description ? { audioConfig: description } : {}) });
    const chunk = Object.freeze({ type: role === 'audio' || unit.isSync ? 'key' as const : 'delta' as const,
      timestamp, ...(duration > 0 ? { duration } : {}), sourceTimestamp, data: unit.data });
    return Object.freeze({ sampleIndex: index, headers, chunk });
  }));
}
