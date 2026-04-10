/**
 * PassthroughStrategy — no-op codec strategy for unknown codecs.
 *
 * Passes chunk data through unchanged with no format conversion,
 * sanitization, or keyframe gating. Used when the codec string
 * doesn't match any known codec (H.264, HEVC, AV1).
 *
 * @module
 */

import type { CodecStrategy, PreparedChunk } from './codec-strategy.js';

export class PassthroughStrategy implements CodecStrategy {
  readonly gatesAfterReset = false;
  readonly usesDescription = true;
  readonly supportsSoftwarePreference = false;
  readonly optimizeForLatency = true;

  async checkSupport(): Promise<boolean> {
    return true; // Unknown codec — can't check, assume supported
  }

  prepareChunkData(data: Uint8Array): PreparedChunk {
    return { data, droppedReason: null };
  }

  isAcceptableSyncPoint(_data: Uint8Array, chunkType: 'key' | 'delta'): boolean {
    return chunkType === 'key';
  }
}
