import { messageReader, observationReader, sourceReader, versionReader } from './model.js';
import type { Message, Observation, SourceDescriptor } from './model.js';
import { InvalidField, record } from './schema.js';
import { MAX_MESSAGE_BYTES } from './limits.js';
export { MAX_MESSAGE_BYTES } from './limits.js';
export { CARRIER_CHANNEL, CARRIER_VERSION, MAX_CARRIER_BYTES, decodeCarrierRequest, decodeCarrierReply,
  encodeCarrierRequest, encodeCarrierReply } from './carrier.js';
export type { CarrierRequest, CarrierReply, CarrierClose, CarrierDecodeResult, RegistryCloseReason } from './carrier.js';

export type {
  AttachmentTarget, SourceTarget, SourceDescriptor, TrackIdentity, Fact, KnownFact,
  UnknownFact, Observation, SequencedObservation, Message, Snapshot, SnapshotScope, Batch,
} from './model.js';
export { cursorFromSnapshot, advanceCursor, refreshCursor, sameTarget } from './cursor.js';
export type { StreamCursor, CursorResult, SnapshotDecision } from './cursor.js';

export const PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 1 });

/** Copy the allowlisted source fields, throwing on invalid input. No raw object is retained. */
export function projectSource(input: unknown): SourceDescriptor {
  return sourceReader(input, '$.source');
}

/** Copy one observation before retention, using exactly the wire decoder's validation. */
export function projectObservation(input: unknown): Observation {
  return observationReader(input, '$.observation');
}

export interface DecodeError {
  readonly code: 'invalid-json' | 'invalid-message' | 'too-large' | 'incompatible-version';
  readonly path: string;
  readonly message: string;
}
export type DecodeResult = { readonly ok: true; readonly message: Message }
  | { readonly ok: false; readonly error: DecodeError };

/** Validate a serialized frame before using it. Unknown additive fields are discarded. */
export function decodeMessage(input: unknown): DecodeResult {
  const fail = (code: DecodeError['code'], path: string, message: string): DecodeResult =>
    ({ ok: false, error: { code, path, message } });
  if (typeof input !== 'string') return fail('invalid-message', '$', 'Expected JSON text');
  if (input.length > MAX_MESSAGE_BYTES || new TextEncoder().encode(input).byteLength > MAX_MESSAGE_BYTES) {
    return fail('too-large', '$', 'Message exceeds the byte limit');
  }
  let value: unknown;
  try { value = JSON.parse(input); }
  catch { return fail('invalid-json', '$', 'Invalid JSON'); }
  try {
    const source = record(value, '$');
    if (source.channel !== 'openmoq-devtools') throw new InvalidField('$.channel', 'diagnostic channel');
    const version = versionReader(source.version, '$.version');
    if (version.major !== PROTOCOL_VERSION.major) return fail('incompatible-version', '$.version', 'Unsupported protocol major');
    return { ok: true, message: messageReader(value, '$') };
  } catch (error) {
    if (error instanceof InvalidField) return fail('invalid-message', error.path, error.message);
    return fail('invalid-message', '$', 'Invalid diagnostic message');
  }
}

/** Sources use the same projection as receivers; never forward their raw internal objects. */
export function encodeMessage(message: Message): string {
  // Project before JSON can coerce invalid values such as Infinity to null.
  const projected = messageReader(message, '$');
  const result = decodeMessage(JSON.stringify(projected));
  if (!result.ok) throw new Error(`${result.error.code} at ${result.error.path}: ${result.error.message}`);
  return JSON.stringify(result.message);
}
