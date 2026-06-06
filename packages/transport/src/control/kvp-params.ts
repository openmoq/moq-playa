/**
 * Bridge between the control-message semantic parameter model and the draft-14/16
 * KVP wire codec.
 *
 * `Parameters` values are `ParameterValue` (`Varint | Uint8Array | Location`),
 * but the KVP primitive only encodes `KvpValue` (`Varint | Uint8Array`). A
 * `Location`-valued parameter (e.g. LARGEST_OBJECT) has no KVP representation, so
 * the draft-14/16 codecs reject it here rather than silently mis-encoding.
 *
 * @module
 */

import type { KvpValue } from '../primitives/kvp.js';
import type { Parameters } from './messages.js';
import { ProtocolViolationError } from '../errors.js';

/**
 * Narrow control-message {@link Parameters} to KVP wire values, rejecting any
 * `Location`-valued parameter (not encodable as draft-14/16 KVP).
 * @throws {ProtocolViolationError} if a parameter value is a Location.
 */
export function toKvpParams(params: Parameters): Map<bigint, KvpValue[]> {
  const out = new Map<bigint, KvpValue[]>();
  for (const [type, values] of params) {
    out.set(
      type,
      values.map((v): KvpValue => {
        // A semantic param integer is a raw bigint (draft-18 vi64 range). For
        // draft-14/16 the KVP writer (writeVarint) range-checks it at write time,
        // so an out-of-QUIC-range value still throws there — this cast does not
        // relax that guardrail.
        if (typeof v === 'bigint') return v as KvpValue;
        if (v instanceof Uint8Array) return v;
        // Location (object) and Track Namespace tuple (array) values are
        // draft-18-only semantic parameters with no draft-14/16 KVP form.
        const kind = Array.isArray(v) ? 'Track Namespace tuple' : 'Location';
        throw new ProtocolViolationError(
          `${kind}-valued parameter 0x${type.toString(16)} cannot be encoded as draft-14/16 KVP`,
        );
      }),
    );
  }
  return out;
}
