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
 * @module
 */

import type { PropertyEntry, PropertyMap } from '@moqt/transport';
import { LocExtensionId } from './types.js';
import type { LocHeaders, LocExtensionValue } from './types.js';
import { parseVideoFrameMarking, encodeVideoFrameMarking } from './video.js';
import { parseAudioLevel, encodeAudioLevel } from './audio.js';

const CAPTURE_TIMESTAMP = BigInt(LocExtensionId.CAPTURE_TIMESTAMP); // 0x02
const VIDEO_FRAME_MARKING = BigInt(LocExtensionId.VIDEO_FRAME_MARKING); // 0x04
const AUDIO_LEVEL = BigInt(LocExtensionId.AUDIO_LEVEL); // 0x06
const VIDEO_CONFIG = BigInt(LocExtensionId.VIDEO_CONFIG); // 0x0d

/**
 * Interpret an ordered {@link PropertyMap} as LOC-01 headers. Known IDs are
 * mapped to their structured fields; every other ID is kept in `unknown` under
 * its full-width `bigint` id. Value parity is guaranteed by Layer A (even →
 * `bigint`, odd → `Uint8Array`).
 */
export function resolveLocHeaders(propertyMap: PropertyMap): LocHeaders {
  let captureTimestamp: bigint | undefined;
  let videoFrameMarking: LocHeaders['videoFrameMarking'];
  let audioLevel: LocHeaders['audioLevel'];
  let videoConfig: Uint8Array | undefined;
  let unknown: Map<bigint, LocExtensionValue> | undefined;

  for (const { id, value } of propertyMap) {
    if (typeof value === 'bigint') {
      // Even id → integer value.
      switch (id) {
        case CAPTURE_TIMESTAMP:
          captureTimestamp = value;
          break;
        case VIDEO_FRAME_MARKING:
          videoFrameMarking = parseVideoFrameMarking(value);
          break;
        case AUDIO_LEVEL:
          audioLevel = parseAudioLevel(value);
          break;
        default:
          (unknown ??= new Map()).set(id, value);
          break;
      }
    } else {
      // Odd id → length-prefixed bytes.
      switch (id) {
        case VIDEO_CONFIG:
          videoConfig = value;
          break;
        default:
          (unknown ??= new Map()).set(id, value);
          break;
      }
    }
  }

  const result: Record<string, unknown> = {};
  if (captureTimestamp !== undefined) result['captureTimestamp'] = captureTimestamp;
  if (videoFrameMarking !== undefined) result['videoFrameMarking'] = videoFrameMarking;
  if (audioLevel !== undefined) result['audioLevel'] = audioLevel;
  if (videoConfig !== undefined) result['videoConfig'] = videoConfig;
  if (unknown !== undefined) result['unknown'] = unknown;
  return result as LocHeaders;
}

/**
 * Project structured {@link LocHeaders} to an ordered {@link PropertyMap} for
 * encoding. Layer A canonicalises the order (stable ascending id), so the entry
 * order here is not significant.
 */
export function locHeadersToPropertyMap(headers: LocHeaders): PropertyEntry[] {
  const entries: PropertyEntry[] = [];
  if (headers.captureTimestamp !== undefined) {
    entries.push({ id: CAPTURE_TIMESTAMP, value: headers.captureTimestamp });
  }
  if (headers.videoFrameMarking !== undefined) {
    entries.push({ id: VIDEO_FRAME_MARKING, value: encodeVideoFrameMarking(headers.videoFrameMarking) });
  }
  if (headers.audioLevel !== undefined) {
    entries.push({ id: AUDIO_LEVEL, value: encodeAudioLevel(headers.audioLevel) });
  }
  if (headers.videoConfig !== undefined) {
    entries.push({ id: VIDEO_CONFIG, value: headers.videoConfig });
  }
  if (headers.unknown) {
    for (const [id, value] of headers.unknown) entries.push({ id, value });
  }
  return entries;
}
