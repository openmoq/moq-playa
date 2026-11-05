import type { TrackExtensions } from './messages.js';

/**
 * Properties defined for data OBJECTS only — they MUST NOT apply to Tracks (§2.5).
 * The type-space is shared and their KVP/value shape is perfectly valid, so this
 * is NOT a wire-format violation: their presence in a Track Properties block is a
 * MALFORMED TRACK, handled by the semantic layer (session/adapter), not the codec.
 * They are therefore decoded normally here; {@link hasObjectOnlyTrackProperty}
 * lets the semantic layer detect them.
 */
const OBJECT_ONLY_TRACK_PROPERTIES = new Set<bigint>([0x3cn, 0x3en]);

// These Properties have implemented processing or value rules. Other types,
// including externally defined repeatable Properties, remain opaque.
const SUPPORTED_PROPERTY_SCOPES = new Map<bigint, 'track' | 'object' | 'both'>([
  // Draft18 §15.8 overlaps Object TIMESTAMP 0x06 with a Track timeout;
  // supported LOC01 also uses Object 0x02/0x06. Numeric IDs alone cannot
  // identify timeout semantics here, so preserve their Object admission.
  [0x02n, 'both'], [0x06n, 'both'],
  [0x0en, 'track'], [0x22n, 'track'], [0x30n, 'track'],
  ...[...OBJECT_ONLY_TRACK_PROPERTIES].map(type => [type, 'object'] as const),
]);

/** Every type in the mandatory range is Track-only on draft18/22. */
function isMandatoryTrackProperty(type: bigint): boolean {
  return type >= 0x4000n && type <= 0x7fffn;
}

/** A Property scope/multiplicity fault is track-semantic, not malformed KVP
 * encoding. Unknown optional Properties retain all occurrences. */
export function supportedPropertyFault(
  props: ReadonlyMap<bigint, readonly unknown[]>, scope: 'track' | 'object',
): string | null {
  for (const [type, values] of props) {
    if (scope === 'object' && isMandatoryTrackProperty(type)) {
      return `Mandatory Track Property 0x${type.toString(16)} is track-only`;
    }
    const allowed = SUPPORTED_PROPERTY_SCOPES.get(type);
    if (allowed === undefined) continue;
    if (allowed !== 'both' && allowed !== scope) return `Property 0x${type.toString(16)} is ${allowed}-only`;
    // Only the explicitly singleton Gap Properties prohibit repeats in
    // draft18 §12.8/12.9 and draft22 §10.8/10.9. Other repeats stay opaque.
    if (values.length > 1 && OBJECT_ONLY_TRACK_PROPERTIES.has(type)) {
      return `Repeated singleton Property 0x${type.toString(16)}`;
    }
  }
  return null;
}

/** Whether `props` contains a data-Object-only Property (0x3C / 0x3E) — which,
 *  in a Track Properties block, means a malformed track (§2.5). */
export function hasObjectOnlyTrackProperty(props: TrackExtensions): boolean {
  for (const type of props.keys()) {
    if (OBJECT_ONLY_TRACK_PROPERTIES.has(type as bigint)) return true;
  }
  return false;
}

/**
 * Whether `props` contains a Mandatory Track Property (0x4000–0x7FFF) this
 * endpoint does not understand (§2.5.1). Since no Mandatory Track Property is
 * implemented, every classified mandatory type qualifies — the request MUST be rejected
 * (PUBLISH) or cancelled (SUBSCRIBE_OK / FETCH_OK), NOT processed or forwarded.
 */
export function hasUnsupportedMandatoryTrackProperty(props: TrackExtensions): boolean {
  for (const type of props.keys()) {
    if (isMandatoryTrackProperty(type as bigint)) return true;
  }
  return false;
}
