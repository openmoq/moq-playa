/**
 * Track selection — grouping by renderGroup/altGroup and constraint-based filtering.
 *
 * - renderGroup: tracks designed to be rendered together (§5.1.18)
 * - altGroup: alternate versions, subscriber picks one (§5.1.19)
 * - depends: SVC dependency chain resolution (§5.1.21)
 *
 * @see draft-ietf-moq-msf-00 §5.1.18, §5.1.19, §5.1.21
 * @module
 */

import type { CatalogTrack, CatalogState, RenderGroup, AltGroup, TrackConstraints } from './types.js';

/**
 * Group tracks by renderGroup.
 * Tracks with the same renderGroup SHOULD be rendered simultaneously and
 * are time-aligned (§4.2). Tracks without renderGroup are returned as ungrouped.
 *
 * @see draft-ietf-moq-msf-00 §5.1.18
 */
export function groupByRender(
    state: CatalogState,
): { groups: RenderGroup[]; ungrouped: CatalogTrack[] } {
    const map = new Map<number, CatalogTrack[]>();
    const ungrouped: CatalogTrack[] = [];

    for (const track of state.tracks) {
        if (track.renderGroup !== undefined) {
            let arr = map.get(track.renderGroup);
            if (!arr) {
                arr = [];
                map.set(track.renderGroup, arr);
            }
            arr.push(track);
        } else {
            ungrouped.push(track);
        }
    }

    const groups: RenderGroup[] = [];
    for (const [renderGroup, tracks] of map) {
        groups.push({ renderGroup, tracks });
    }

    return { groups, ungrouped };
}

/**
 * Group tracks by altGroup.
 * Alternate tracks represent the same content at different qualities (§5.1.19).
 * A subscriber typically subscribes to ONE track from an alt group.
 * Tracks without altGroup are returned as ungrouped.
 *
 * @see draft-ietf-moq-msf-00 §5.1.19
 */
export function groupByAlt(
    tracks: readonly CatalogTrack[],
): { groups: AltGroup[]; ungrouped: CatalogTrack[] } {
    const map = new Map<number, CatalogTrack[]>();
    const ungrouped: CatalogTrack[] = [];

    for (const track of tracks) {
        if (track.altGroup !== undefined) {
            let arr = map.get(track.altGroup);
            if (!arr) {
                arr = [];
                map.set(track.altGroup, arr);
            }
            arr.push(track);
        } else {
            ungrouped.push(track);
        }
    }

    const groups: AltGroup[] = [];
    for (const [altGroup, groupTracks] of map) {
        groups.push({ altGroup, tracks: groupTracks });
    }

    return { groups, ungrouped };
}

/**
 * Select best track from candidates matching constraints.
 *
 * Filtering order:
 * 1. Filter by codec (if specified)
 * 2. Filter by lang (if specified)
 * 3. Filter by role (if specified)
 * 4. Filter by maxWidth/maxHeight (if specified)
 * 5. Filter by minBitrate (if specified)
 * 6. Filter by maxBitrate (if specified)
 * 7. From remaining, pick highest bitrate (best quality that fits)
 *
 * @see draft-ietf-moq-msf-00 §5.1.19
 */
export function selectTrack(
    candidates: readonly CatalogTrack[],
    constraints: TrackConstraints,
): CatalogTrack | undefined {
    let filtered = [...candidates];

    // Filter by codec
    if (constraints.codec !== undefined) {
        filtered = filtered.filter(t => t.codec === constraints.codec);
    }

    // Filter by language
    if (constraints.lang !== undefined) {
        filtered = filtered.filter(t => t.lang === constraints.lang);
    }

    // Filter by role
    if (constraints.role !== undefined) {
        filtered = filtered.filter(t => t.role === constraints.role);
    }

    // Filter by max resolution
    if (constraints.maxWidth !== undefined) {
        filtered = filtered.filter(t => t.width === undefined || t.width <= constraints.maxWidth!);
    }
    if (constraints.maxHeight !== undefined) {
        filtered = filtered.filter(t => t.height === undefined || t.height <= constraints.maxHeight!);
    }

    // Filter by min bitrate
    if (constraints.minBitrate !== undefined) {
        filtered = filtered.filter(t => t.bitrate !== undefined && t.bitrate >= constraints.minBitrate!);
    }

    // Filter by max bitrate
    if (constraints.maxBitrate !== undefined) {
        filtered = filtered.filter(t => t.bitrate === undefined || t.bitrate <= constraints.maxBitrate!);
    }

    if (filtered.length === 0) return undefined;

    // Pick highest bitrate from remaining (best quality that fits constraints)
    filtered.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
    return filtered[0];
}

/**
 * Resolve full dependency chain for a track (SVC).
 *
 * Returns all tracks needed to decode the target track, in topological order
 * (base layers first, target track last). The target track is included.
 *
 * Per §5.1.21: "the namespace of the dependencies is assumed to match
 * that of the track declaring the dependencies."
 *
 * @throws {Error} If a dependency is not found or circular dependency detected
 * @see draft-ietf-moq-msf-00 §5.1.21
 */
export function resolveDependencies(
    track: CatalogTrack,
    allTracks: readonly CatalogTrack[],
): CatalogTrack[] {
    // Key by namespace + '\0' + name per §5.1.21: dependencies are assumed
    // to be in the same namespace as the declaring track.
    const byKey = new Map<string, CatalogTrack>();
    for (const t of allTracks) {
        byKey.set(trackKey(t), t);
    }

    const result: CatalogTrack[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    function visit(t: CatalogTrack): void {
        const key = trackKey(t);
        if (visited.has(key)) return;

        if (visiting.has(key)) {
            throw new Error(`Circular dependency detected: "${t.name}" (§5.1.21)`);
        }

        visiting.add(key);

        if (t.depends) {
            for (const depName of t.depends) {
                // §5.1.21: namespace of dependencies matches declaring track's namespace
                const depKey = `${t.namespace ?? ''}\0${depName}`;
                const dep = byKey.get(depKey);
                if (!dep) {
                    throw new Error(
                        `Dependency "${depName}" not found for track "${t.name}" in namespace "${t.namespace ?? '(none)'}" (§5.1.21)`,
                    );
                }
                visit(dep);
            }
        }

        visiting.delete(key);
        visited.add(key);
        result.push(t);
    }

    visit(track);
    return result;
}

/** Composite key for track identity: namespace + '\0' + name. */
function trackKey(t: CatalogTrack): string {
    return `${t.namespace ?? ''}\0${t.name}`;
}
