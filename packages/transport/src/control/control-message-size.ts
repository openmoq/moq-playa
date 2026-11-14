/**
 * draft-23 MAX_CONTROL_MESSAGE_SIZE (§9.1.8): the largest control message an
 * endpoint will receive. The Setup Option (0x09) is odd, so its value is
 * length-prefixed bytes holding a single vi64.
 *
 * @see draft-ietf-moq-transport-23 §9, §9.1.8
 * @module
 */

import { readVi64 } from '../primitives/vi64.js';

/**
 * The default MAX_CONTROL_MESSAGE_SIZE, and the limit this endpoint
 * advertises. Peers must accept at least this much, so it also bounds what we
 * send.
 */
export const MAX_CONTROL_MESSAGE_SIZE = 65535;

/**
 * Parse a peer's MAX_CONTROL_MESSAGE_SIZE option value.
 * @returns the size, or `'malformed'` if the bytes are not exactly one vi64,
 *   or `'too-small'` if it is below the 65535 minimum.
 */
export function parseMaxControlMessageSize(value: Uint8Array): bigint | 'malformed' | 'too-small' {
  let size: { value: bigint; bytesRead: number };
  try {
    size = readVi64(value, 0);
  } catch {
    return 'malformed';
  }
  if (size.bytesRead !== value.length) return 'malformed';
  return size.value < BigInt(MAX_CONTROL_MESSAGE_SIZE) ? 'too-small' : size.value;
}
