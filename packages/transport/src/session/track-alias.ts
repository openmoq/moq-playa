/**
 * Track alias manager.
 *
 * Manages the mapping between track aliases (compact numeric identifiers)
 * and full track identities (namespace + name). Track aliases are assigned
 * on SUBSCRIBE_OK/PUBLISH_OK and used on data streams for efficiency.
 *
 * Each track can have at most one alias, and each alias maps to exactly one track.
 * Both directions of the mapping must be maintained for efficient lookups.
 *
 * @see draft-ietf-moq-transport-16 §10
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
  /** Alias → Track mapping. */
  private readonly aliasToTrack = new Map<bigint, TrackIdentity>();

  /** Track key → Alias mapping. */
  private readonly trackToAlias = new Map<string, bigint>();

  /**
   * Register a track alias mapping.
   *
   * @param alias - The numeric track alias
   * @param namespace - Track namespace segments
   * @param name - Track name
   * @throws {Error} If alias is already registered to a different track
   * @throws {Error} If track is already registered with a different alias
   */
  register(alias: bigint, namespace: Uint8Array[], name: Uint8Array): void {
    const trackKey = this.computeTrackKey(namespace, name);
    const aliasNum = alias as bigint;

    // Check for duplicate alias pointing to different track
    const existingTrack = this.aliasToTrack.get(aliasNum);
    if (existingTrack) {
      const existingKey = this.computeTrackKey(existingTrack.namespace, existingTrack.name);
      if (existingKey !== trackKey) {
        throw new Error(`Alias ${alias} is already registered to a different track`);
      }
      // Same track, idempotent - no action needed
      return;
    }

    // Check for track already having a different alias
    const existingAlias = this.trackToAlias.get(trackKey);
    if (existingAlias !== undefined && existingAlias !== aliasNum) {
      throw new Error(`Track is already registered with alias ${existingAlias}`);
    }

    // Register both mappings
    this.aliasToTrack.set(aliasNum, { namespace, name });
    this.trackToAlias.set(trackKey, aliasNum);
  }

  /**
   * Remove a track alias mapping.
   *
   * @param alias - The numeric track alias to remove
   */
  unregister(alias: bigint): void {
    const aliasNum = alias as bigint;
    const track = this.aliasToTrack.get(aliasNum);

    if (track) {
      const trackKey = this.computeTrackKey(track.namespace, track.name);
      this.trackToAlias.delete(trackKey);
      this.aliasToTrack.delete(aliasNum);
    }
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
    // Returns the raw bigint alias: a draft-18 server-assigned alias may exceed
    // the QUIC-varint range, so it must not be re-branded through varint().
    return this.trackToAlias.get(trackKey);
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
    return this.trackToAlias.has(trackKey);
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
    this.trackToAlias.clear();
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
