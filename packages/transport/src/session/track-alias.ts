/**
 * Track alias manager.
 *
 * Manages the mapping between track aliases (compact numeric identifiers)
 * and full track identities (namespace + name). Track aliases are assigned
 * on SUBSCRIBE_OK/PUBLISH_OK and used on data streams for efficiency.
 *
 * §11.1: each alias maps to exactly ONE track (reusing an alias for a different
 * track is DUPLICATE_TRACK_ALIAS), but a track MAY have several aliases at once
 * (e.g. the §5.1 collision race). Both directions of the mapping are maintained
 * for efficient lookups; the track→alias direction is therefore one-to-many.
 *
 * @see draft-ietf-moq-transport-18 §11.1
 * @module
 */

/**
 * Track identity (namespace + name).
 */
export interface TrackIdentity {
  readonly namespace: Uint8Array[];
  readonly name: Uint8Array;
}

/**
 * Manages track alias mappings for a session.
 */
export class TrackAliasManager {
  /** Alias → Track mapping. §11.1: one alias MUST map to only one track. */
  private readonly aliasToTrack = new Map<bigint, TrackIdentity>();

  /**
   * Track key → set of aliases. §11.1 prohibits ONE alias referring to two
   * different tracks, but NOT multiple aliases for one track — which happens
   * legitimately during the §5.1 race (an inbound PUBLISH advertising one alias
   * while a crossed SUBSCRIBE_OK for the same track assigns a different one). So a
   * track may map to several live aliases at once.
   */
  private readonly trackToAliases = new Map<string, Set<bigint>>();

  /**
   * Alias → set of OWNERS (the request IDs that registered it). Request IDs are
   * unique for the session lifetime (never reused), so an owner is a generation
   * token: a cleanup path for one request must not unregister an alias another
   * request still holds. A single alias→track mapping may legitimately have
   * MULTIPLE live owners at once — e.g. §5.1 a local SUBSCRIBE and an inbound
   * PUBLISH for the SAME track both claiming the peer's chosen alias. `unregister`
   * drops the alias→track mapping only when the LAST owner releases it.
   */
  private readonly aliasToOwner = new Map<bigint, Set<bigint>>();

  /**
   * Register a track alias mapping.
   *
   * @param alias - The numeric track alias
   * @param namespace - Track namespace segments
   * @param name - Track name
   * @param owner - The request ID taking ownership of this alias (generation token)
   * @throws {Error} If the alias is already registered to a DIFFERENT track (§11.1)
   */
  register(alias: bigint, namespace: Uint8Array[], name: Uint8Array, owner?: bigint): void {
    const trackKey = this.computeTrackKey(namespace, name);
    const aliasNum = alias as bigint;

    // §11.1: the ONLY prohibited case — one alias referring to two different
    // tracks. Multiple aliases for one track is permitted (§5.1 race), so there
    // is NO reverse constraint.
    const existingTrack = this.aliasToTrack.get(aliasNum);
    if (existingTrack) {
      const existingKey = this.computeTrackKey(existingTrack.namespace, existingTrack.name);
      if (existingKey !== trackKey) {
        throw new Error(`Alias ${alias} is already registered to a different track`);
      }
      // Same track, idempotent — ADD this owner (do NOT overwrite): multiple live
      // owners of one same-track mapping are legitimate (§5.1).
      if (owner !== undefined) this.addOwner(aliasNum, owner);
      return;
    }

    // Register the mappings (a track may accumulate several aliases).
    this.aliasToTrack.set(aliasNum, { namespace, name });
    let aliases = this.trackToAliases.get(trackKey);
    if (!aliases) {
      aliases = new Set<bigint>();
      this.trackToAliases.set(trackKey, aliases);
    }
    aliases.add(aliasNum);
    if (owner !== undefined) this.addOwner(aliasNum, owner);
  }

  /** Add a request ID to an alias's owner set. */
  private addOwner(aliasNum: bigint, owner: bigint): void {
    let owners = this.aliasToOwner.get(aliasNum);
    if (!owners) {
      owners = new Set<bigint>();
      this.aliasToOwner.set(aliasNum, owners);
    }
    owners.add(owner);
  }

  /**
   * Remove a track alias mapping — CONDITIONAL on ownership. When `owner` is
   * given, that request releases its claim; the alias→track mapping is dropped
   * only when the LAST owner releases it. A release by a request that is not (or
   * no longer) an owner while others still hold the alias is a no-op — so a
   * crossed cleanup for an old request whose alias a newer one still owns cannot
   * drop it. When `owner` is omitted, the alias is removed unconditionally.
   *
   * @param alias - The numeric track alias to remove
   * @param owner - The request ID releasing its claim (generation token)
   */
  unregister(alias: bigint, owner?: bigint): void {
    const aliasNum = alias as bigint;
    // Generation check: drop the mapping only once every owner has released it.
    if (owner !== undefined) {
      const owners = this.aliasToOwner.get(aliasNum);
      if (owners) {
        owners.delete(owner);
        if (owners.size > 0) return; // other live owners remain — keep the mapping
      }
      // owners empty, or the alias had no owner tracking → fall through and drop.
    }
    const track = this.aliasToTrack.get(aliasNum);

    if (track) {
      const trackKey = this.computeTrackKey(track.namespace, track.name);
      const aliases = this.trackToAliases.get(trackKey);
      if (aliases) {
        aliases.delete(aliasNum);
        if (aliases.size === 0) this.trackToAliases.delete(trackKey);
      }
      this.aliasToTrack.delete(aliasNum);
    }
    this.aliasToOwner.delete(aliasNum);
  }

  /**
   * Look up a track by its alias.
   *
   * @param alias - The numeric track alias
   * @returns The track identity, or undefined if not found
   */
  getByAlias(alias: bigint): TrackIdentity | undefined {
    return this.aliasToTrack.get(alias as bigint);
  }

  /**
   * Look up an alias by track identity.
   *
   * @param namespace - Track namespace segments
   * @param name - Track name
   * @returns The track alias, or undefined if not found
   */
  getAliasByTrack(namespace: Uint8Array[], name: Uint8Array): bigint | undefined {
    const trackKey = this.computeTrackKey(namespace, name);
    // A track may hold several aliases (§5.1 race); return the most recently
    // registered one. Raw bigint: a draft-18 server-assigned alias may exceed the
    // QUIC-varint range, so it must not be re-branded through varint().
    const aliases = this.trackToAliases.get(trackKey);
    if (!aliases || aliases.size === 0) return undefined;
    let last: bigint | undefined;
    for (const a of aliases) last = a; // Set preserves insertion order
    return last;
  }

  /**
   * Check if an alias is registered.
   *
   * @param alias - The numeric track alias
   * @returns True if the alias is registered
   */
  hasAlias(alias: bigint): boolean {
    return this.aliasToTrack.has(alias as bigint);
  }

  /**
   * Check if a track is registered.
   *
   * @param namespace - Track namespace segments
   * @param name - Track name
   * @returns True if the track is registered
   */
  hasTrack(namespace: Uint8Array[], name: Uint8Array): boolean {
    const trackKey = this.computeTrackKey(namespace, name);
    return (this.trackToAliases.get(trackKey)?.size ?? 0) > 0;
  }

  /**
   * Get the number of registered track aliases.
   */
  get size(): number {
    return this.aliasToTrack.size;
  }

  /**
   * Remove all track alias mappings.
   */
  clear(): void {
    this.aliasToTrack.clear();
    this.trackToAliases.clear();
    this.aliasToOwner.clear();
  }

  /**
   * Compute a unique key for a track (namespace + name).
   */
  private computeTrackKey(namespace: Uint8Array[], name: Uint8Array): string {
    const parts: string[] = [];
    for (const segment of namespace) {
      parts.push(this.bytesToHex(segment));
    }
    parts.push(this.bytesToHex(name));
    return parts.join('/');
  }

  /**
   * Convert bytes to hex string.
   */
  private bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
