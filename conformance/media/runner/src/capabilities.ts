/**
 * Execution capability classification.
 *
 * The corpus schema-validates ALL vectors, but only executes the seams that
 * exist in production. A vector naming a format with no implementation is
 * classified `forward-looking` rather than silently skipped: schema-validated,
 * counted, and reported, but NOT executed against an API that does not exist.
 * Every vector in the corpus is executable today; the classification remains so
 * a future format cannot skip silently. The capability accounting test asserts
 * the exact split.
 *
 * @module
 */

import { isTombstone, type ManifestEntry } from './schema-types.js';

export type ExecutionCapability = 'executable' | 'forward-looking' | 'retired';

export interface Capability {
  readonly capability: ExecutionCapability;
  readonly reason: string;
}

/** How the TypeScript (playa) runner treats this entry. */
export function executionCapability(entry: ManifestEntry): Capability {
  if (isTombstone(entry)) {
    return { capability: 'retired', reason: `tombstone: ${entry.retired.reason}` };
  }
  switch (entry.kind) {
    case 'property-block-decode':
      return { capability: 'executable', reason: 'runs against the shared property-wire core (decodePropertyBlock/encodePropertyBlock)' };
    case 'loc-semantics':
      return { capability: 'executable', reason: 'runs against the Layer-B LOC semantic resolver (resolveLocHeaders)' };
    case 'catalog-parse':
    case 'catalog-delta-parse': {
      // A catalog vector whose playa differential is `unimplemented` names a
      // format Playa has no parser path for. It is forward-looking —
      // machine-visible here, never a silent skip and never a pass — while its
      // currentBehavior stays pinned. A `diverges` differential (Playa parses
      // but disagrees) remains executable.
      // "unimplemented" (a pinned divergence) AND "forward-looking" (no parser
      // path, even when today's wrong parser happens to return a matching error
      // category) are BOTH forward-looking — capability is profile/status-driven,
      // never inferred from an accidental result match. No vector classifies
      // this way today; the branch guards future formats.
      const playaStatus = entry.differential?.['playa']?.status;
      if (playaStatus === 'unimplemented' || playaStatus === 'forward-looking') {
        const prof = entry.profile;
        const reason = entry.kind === 'catalog-delta-parse'
          ? `no parser exists for the ${prof} delta dialect`
          : `no parser exists for the ${prof} catalog format`;
        return { capability: 'forward-looking', reason };
      }
      return { capability: 'executable', reason: 'runs against current production code (parseCatalogAuto)' };
    }
    case 'loc-properties':
    case 'bmff-structure':
      return { capability: 'executable', reason: 'runs against current production code' };
    case 'msfts-validate':
      return {
        capability: 'forward-looking',
        reason: 'no MSFTS implementation exists on either side yet',
      };
  }
}

export interface CapabilityCounts {
  executable: number;
  forwardLooking: number;
}

export function tallyCapabilities(entries: readonly ManifestEntry[]): CapabilityCounts {
  const counts: CapabilityCounts = { executable: 0, forwardLooking: 0 };
  for (const e of entries) {
    if (isTombstone(e)) continue; // tombstones are inert — not counted
    const cap = executionCapability(e).capability;
    if (cap === 'executable') counts.executable++;
    else counts.forwardLooking++;
  }
  return counts;
}
