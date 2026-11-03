const basicRange = /^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/i;

/**
 * Player language policy over an already eligible candidate pool. For each
 * preference, choose an exact tag first, then a regional variant in catalog
 * order using RFC 4647 §3.3.1 basic filtering. Only then shorten the preference
 * with §3.4's singleton-aware fallback. This combination is application policy,
 * not strict Lookup (which does not choose more-specific tags).
 *
 * Wildcards and an exhausted list return undefined: the caller supplies its
 * scope-local default. No registry aliases, weights or extended ranges are
 * inferred, and catalog tags are returned unchanged.
 */
export function preferredLanguage<T extends { readonly lang?: string }>(
  candidates: readonly T[], preferences: readonly string[],
): T | undefined {
  for (const range of preferences) {
    if (typeof range !== 'string' || range !== '*' && !basicRange.test(range)) throw new RangeError(`Invalid audio language range: ${range}`);
  }
  const tagged = candidates.flatMap(track => track.lang !== undefined && basicRange.test(track.lang)
    ? [{ track, tag: track.lang.toLowerCase() }] : []);
  for (const preference of preferences) {
    if (preference === '*') continue;
    const parts = preference.toLowerCase().split('-');
    while (parts.length > 0) {
      const range = parts.join('-');
      const exact = tagged.find(item => item.tag === range);
      if (exact) return exact.track;
      const variant = tagged.find(item => item.tag.startsWith(`${range}-`));
      if (variant) return variant.track;
      parts.pop();
      if (parts.at(-1)?.length === 1) parts.pop();
    }
  }
  return undefined;
}
