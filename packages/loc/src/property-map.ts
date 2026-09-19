/**
 * LOC Layer B — semantic resolution.
 *
 * The property WIRE (bytes ⇄ ordered {@link PropertyMap}) is Layer A, owned by
 * `@moqt/transport`. This module is Layer B: it interprets a decoded, ordered
 * `PropertyMap` as LOC metadata, and projects structured {@link LocHeaders} back
 * to a `PropertyMap` for encoding. There is NO byte-level parsing here.
 *
 * The Layer A/B split lets the same LOC semantics run over any transport wire
 * profile (draft-14 absolute, draft-16 delta QUIC-varint, draft-18 delta vi64):
 * only Layer A changes per profile; the interpretation below does not.
 *
 * Duplicate known IDs resolve last-wins (a Layer B policy — Layer A preserves the
 * raw duplicates); unknown IDs are preserved losslessly with their full-width
 * `bigint` id, never narrowed.
 *
 * @see draft-ietf-moq-loc-01 §2.3
 * @see draft-ietf-moq-loc-04 §2.3
 * @module
 */

import type { PropertyEntry, PropertyMap } from '@moqt/transport';
import { Loc01PropertyId, Loc04PropertyId } from './types.js';
import type { LocHeaders, LocExtensionValue, LocTrackContext, LocVersion, VideoFrameMarking, AudioLevel } from './types.js';
import { parseVideoFrameMarking, encodeVideoFrameMarking, parseVideoFrameMarkingBytes, encodeVideoFrameMarkingBytes } from './video.js';
import { parseAudioLevel, encodeAudioLevel } from './audio.js';
import { LocHeaderError, LocEncodeError } from './errors.js';

const ID01 = {
  captureTimestamp: BigInt(Loc01PropertyId.CAPTURE_TIMESTAMP),
  videoFrameMarking: BigInt(Loc01PropertyId.VIDEO_FRAME_MARKING),
  audioLevel: BigInt(Loc01PropertyId.AUDIO_LEVEL),
  videoConfig: BigInt(Loc01PropertyId.VIDEO_CONFIG),
} as const;

const ID04 = {
  timescale: BigInt(Loc04PropertyId.TIMESCALE),
  videoFrameMarking: BigInt(Loc04PropertyId.VIDEO_FRAME_MARKING),
  audioLevel: BigInt(Loc04PropertyId.AUDIO_LEVEL),
  videoConfig: BigInt(Loc04PropertyId.VIDEO_CONFIG),
  audioConfig: BigInt(Loc04PropertyId.AUDIO_CONFIG),
  timestamp: BigInt(Loc04PropertyId.TIMESTAMP),
} as const;

const MICROS_PER_SECOND = 1_000_000n;

type Mutable = { -readonly [K in keyof LocHeaders]: LocHeaders[K] };

/**
 * Interpret an ordered {@link PropertyMap} as LOC headers from either draft.
 *
 * One pass collects LOC-01 and LOC-04 candidates separately. Any LOC-04-only id
 * makes the block version 4, and LOC-01 candidates then go to `unknown`, since
 * under LOC-04 those ids are simply unregistered. Only LOC-01 ids means
 * version 1. Duplicate known ids resolve last-wins. Track context fills only
 * fields the object omitted. `captureTimestamp` is always microseconds.
 *
 * @see draft-ietf-moq-loc-01 §2.3
 * @see draft-ietf-moq-loc-04 §2.3, §6.1
 */
export function resolveLocHeaders(propertyMap: PropertyMap, track?: LocTrackContext): LocHeaders {
  // LOC-01 candidates
  let ts01: bigint | undefined;
  let vfm01: bigint | undefined;
  let al01: bigint | undefined;
  // LOC-04 candidates
  let ts04: bigint | undefined;
  let scale04: bigint | undefined;
  let vfm04: Uint8Array | undefined;
  let al04: bigint | undefined;
  let audioConfig: Uint8Array | undefined;
  // Shared
  let videoConfig: Uint8Array | undefined;
  let unknown: Map<bigint, LocExtensionValue> | undefined;
  let saw01 = false;
  let saw04 = false;

  for (const { id, value } of propertyMap) {
    if (typeof value === 'bigint') {
      switch (id) {
        case ID01.captureTimestamp: ts01 = value; saw01 = true; break;
        case ID01.videoFrameMarking: vfm01 = value; saw01 = true; break;
        case ID01.audioLevel: al01 = value; saw01 = true; break;
        case ID04.timestamp: ts04 = value; saw04 = true; break;
        case ID04.timescale: scale04 = value; saw04 = true; break;
        case ID04.audioLevel: al04 = value; saw04 = true; break;
        default: (unknown ??= new Map()).set(id, value); break;
      }
    } else {
      switch (id) {
        case ID04.videoConfig: videoConfig = value; break;
        case ID04.videoFrameMarking: vfm04 = value; saw04 = true; break;
        case ID04.audioConfig: audioConfig = value; saw04 = true; break;
        default: (unknown ??= new Map()).set(id, value); break;
      }
    }
  }

  const out: Mutable = {};
  let version: LocVersion | undefined;
  let timestamp: bigint | undefined;
  let timescale: bigint | undefined;
  let videoFrameMarking: VideoFrameMarking | undefined;
  let audioLevel: AudioLevel | undefined;

  // LOC-01 CaptureTimestamp honoured as-is when a mixed block carries no
  // 0x10 Timestamp: wall-clock microseconds, no Timescale derivation.
  let wallClockCaptureTimestamp: bigint | undefined;

  if (saw04) {
    version = 4;
    if (saw01) {
      if (ts01 !== undefined) {
        if (ts04 !== undefined) (unknown ??= new Map()).set(ID01.captureTimestamp, ts01);
        else wallClockCaptureTimestamp = ts01;
      }
      if (vfm01 !== undefined) (unknown ??= new Map()).set(ID01.videoFrameMarking, vfm01);
      if (al01 !== undefined) (unknown ??= new Map()).set(ID01.audioLevel, al01);
    }
    timestamp = ts04;
    timescale = scale04 ?? track?.timescale;
    if (vfm04 !== undefined) videoFrameMarking = parseVideoFrameMarkingBytes(vfm04);
    if (al04 !== undefined) audioLevel = parseAudioLevel(al04);
  } else if (saw01) {
    version = 1;
    timestamp = ts01;
    if (vfm01 !== undefined) videoFrameMarking = parseVideoFrameMarking(vfm01);
    if (al01 !== undefined) audioLevel = parseAudioLevel(al01);
  } else {
    timescale = track?.timescale;
  }

  videoConfig ??= track?.videoConfig;
  audioConfig ??= track?.audioConfig;

  if (version !== undefined) out.version = version;
  if (wallClockCaptureTimestamp !== undefined) {
    out.captureTimestamp = wallClockCaptureTimestamp;
    out.timestampIsWallClock = true;
    if (timescale !== undefined) {
      if (timescale === 0n) throw new LocHeaderError('timescale', 'must be non-zero');
      out.timescale = timescale;
    }
  } else if (timestamp !== undefined) {
    out.timestamp = timestamp;
    if (timescale !== undefined) {
      if (timescale === 0n) throw new LocHeaderError('timescale', 'must be non-zero');
      out.timescale = timescale;
      out.captureTimestamp = (timestamp * MICROS_PER_SECOND) / timescale;
      out.timestampIsWallClock = false;
    } else {
      out.captureTimestamp = timestamp;
      out.timestampIsWallClock = true;
    }
  } else if (timescale !== undefined) {
    if (timescale === 0n) throw new LocHeaderError('timescale', 'must be non-zero');
    out.timescale = timescale;
  }
  if (videoFrameMarking !== undefined) out.videoFrameMarking = videoFrameMarking;
  if (audioLevel !== undefined) out.audioLevel = audioLevel;
  if (videoConfig !== undefined) out.videoConfig = videoConfig;
  if (audioConfig !== undefined) out.audioConfig = audioConfig;
  if (unknown !== undefined) out.unknown = unknown;
  return out;
}

/**
 * Project structured {@link LocHeaders} to an ordered {@link PropertyMap} for
 * the given LOC version. Layer A canonicalises the order, so entry order here
 * is not significant.
 *
 * Version 4: `timestamp` (else `captureTimestamp`) into 0x10; `timescale` into
 * 0x08 only when `timestamp` was the source. Version 1: microseconds into 0x02,
 * derived from `timestamp` and `timescale` when `captureTimestamp` is absent.
 * Fields that version 1 cannot carry throw {@link LocEncodeError}.
 *
 * @see draft-ietf-moq-loc-01 §2.3
 * @see draft-ietf-moq-loc-04 §2.3
 */
export function locHeadersToPropertyMap(headers: LocHeaders, version: LocVersion = 4): PropertyEntry[] {
  const entries: PropertyEntry[] = [];
  const emitted = new Set<bigint>();
  const emit = (id: bigint, value: LocExtensionValue) => {
    entries.push({ id, value });
    emitted.add(id);
  };

  if (version === 4) {
    if (headers.timestamp !== undefined) {
      emit(ID04.timestamp, headers.timestamp);
      if (headers.timescale !== undefined) emit(ID04.timescale, headers.timescale);
    } else if (headers.captureTimestamp !== undefined) {
      if (headers.timescale !== undefined) {
        throw new LocEncodeError('timescale', 'requires timestamp; captureTimestamp is always microseconds');
      }
      emit(ID04.timestamp, headers.captureTimestamp);
    } else if (headers.timescale !== undefined) {
      emit(ID04.timescale, headers.timescale);
    }
    if (headers.videoFrameMarking !== undefined) {
      emit(ID04.videoFrameMarking, encodeVideoFrameMarkingBytes(headers.videoFrameMarking));
    }
    if (headers.audioLevel !== undefined) {
      emit(ID04.audioLevel, encodeAudioLevel(headers.audioLevel));
    }
    if (headers.videoConfig !== undefined) emit(ID04.videoConfig, headers.videoConfig);
    if (headers.audioConfig !== undefined) emit(ID04.audioConfig, headers.audioConfig);
  } else {
    let micros = headers.captureTimestamp;
    if (headers.timescale !== undefined && headers.timestamp === undefined) {
      throw new LocEncodeError('timescale', 'requires timestamp; captureTimestamp is always microseconds');
    }
    if (micros === undefined && headers.timestamp !== undefined) {
      if (headers.timescale === undefined) {
        micros = headers.timestamp;
      } else if (headers.timescale === 0n) {
        throw new LocEncodeError('timescale', 'must be non-zero');
      } else {
        micros = (headers.timestamp * MICROS_PER_SECOND) / headers.timescale;
      }
    }
    if (micros !== undefined) emit(ID01.captureTimestamp, micros);
    if (headers.videoFrameMarking !== undefined) {
      if (headers.videoFrameMarking.tl0PicIdx !== undefined) {
        throw new LocEncodeError('videoFrameMarking.tl0PicIdx', 'not representable in LOC-01');
      }
      emit(ID01.videoFrameMarking, encodeVideoFrameMarking(headers.videoFrameMarking));
    }
    if (headers.audioLevel !== undefined) {
      emit(ID01.audioLevel, encodeAudioLevel(headers.audioLevel));
    }
    if (headers.videoConfig !== undefined) emit(ID01.videoConfig, headers.videoConfig);
    if (headers.audioConfig !== undefined) {
      throw new LocEncodeError('audioConfig', 'not representable in LOC-01');
    }
  }

  if (headers.unknown) {
    for (const [id, value] of headers.unknown) {
      if (emitted.has(id)) continue;
      entries.push({ id, value });
    }
  }
  return entries;
}
