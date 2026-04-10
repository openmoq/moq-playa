/**
 * Delta catalog update parsing and application.
 *
 * @see draft-ietf-moq-msf-00 §5.2
 * @module
 */

import type { CatalogDelta, CatalogState, CatalogTrack, RemoveTrackRef } from './types.js';

/** Fields allowed in a removeTracks entry per §5.1.4. */
const REMOVE_TRACK_ALLOWED_FIELDS = new Set<string>(['name', 'namespace']);

/**
 * Parse a delta catalog update from JSON.
 *
 * Validates all §5.2 requirements:
 * - deltaUpdate must be true
 * - MUST NOT contain version or tracks fields
 * - MUST contain at least one of addTracks, removeTracks, cloneTracks
 * - removeTracks entries: MUST have name, MAY have namespace, MUST NOT have other fields (§5.1.4)
 * - cloneTracks entries: MUST have parentName (§5.1.5)
 *
 * @param json Raw JSON string or UTF-8 bytes
 * @returns Parsed and validated CatalogDelta
 * @throws {Error} If the JSON is invalid or violates spec requirements
 * @see draft-ietf-moq-msf-00 §5.2
 */
export function parseDeltaUpdate(
    json: string | Uint8Array,
): CatalogDelta {
    const text = typeof json === 'string' ? json : new TextDecoder().decode(json);
    const raw: unknown = JSON.parse(text);

    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('Delta update must be a JSON object');
    }

    const obj = raw as Record<string, unknown>;

    // §5.2: deltaUpdate must be true
    if (obj['deltaUpdate'] !== true) {
        throw new Error('Delta update must have deltaUpdate set to true (§5.2)');
    }

    // §5.2: MUST NOT contain version or tracks fields
    if ('version' in obj) {
        throw new Error('Delta update MUST NOT contain a version field (§5.2)');
    }
    if ('tracks' in obj) {
        throw new Error('Delta update MUST NOT contain a tracks field (§5.2)');
    }

    const hasAdd = Array.isArray(obj['addTracks']);
    const hasRemove = Array.isArray(obj['removeTracks']);
    const hasClone = Array.isArray(obj['cloneTracks']);

    // §5.2: MUST contain at least one operation
    if (!hasAdd && !hasRemove && !hasClone) {
        throw new Error(
            'Delta update must contain at least one of addTracks, removeTracks, or cloneTracks (§5.2)',
        );
    }

    // Validate removeTracks entries (§5.1.4)
    let removeTracks: RemoveTrackRef[] | undefined;
    if (hasRemove) {
        removeTracks = (obj['removeTracks'] as unknown[]).map(
            (entry, i) => validateRemoveTrackRef(entry, i),
        );
    }

    // Validate cloneTracks entries (§5.1.5)
    let cloneTracks: CatalogTrack[] | undefined;
    if (hasClone) {
        cloneTracks = (obj['cloneTracks'] as unknown[]).map(
            (entry, i) => validateCloneTrackEntry(entry, i),
        );
    }

    // Parse addTracks entries (regular track objects)
    let addTracks: CatalogTrack[] | undefined;
    if (hasAdd) {
        addTracks = (obj['addTracks'] as unknown[]).map(
            (entry, i) => parseTrackFromRaw(entry, `addTracks[${i}]`),
        );
    }

    const delta: CatalogDelta = {
        deltaUpdate: true,
        ...(typeof obj['generatedAt'] === 'number' ? { generatedAt: obj['generatedAt'] } : {}),
        ...(addTracks ? { addTracks } : {}),
        ...(removeTracks ? { removeTracks } : {}),
        ...(cloneTracks ? { cloneTracks } : {}),
    };

    return delta;
}

/**
 * Apply a delta update to an existing catalog state.
 *
 * Operations are applied sequentially in document order (§5.2):
 * 1. addTracks — add new tracks
 * 2. removeTracks — remove existing tracks
 * 3. cloneTracks — clone from existing tracks with overrides
 *
 * @param state Current catalog state
 * @param delta Parsed delta update
 * @param catalogNamespace Namespace of the catalog track for inheritance
 * @returns New catalog state with delta applied
 * @throws {Error} If the delta violates spec requirements
 * @see draft-ietf-moq-msf-00 §5.2
 */
export function applyCatalogUpdate(
    state: CatalogState,
    delta: CatalogDelta,
    catalogNamespace?: string,
): CatalogState {
    // Work on a mutable copy of tracks
    let tracks = [...state.tracks];

    // §5.2: Operations applied sequentially in document order

    // 1. Add tracks
    if (delta.addTracks) {
        for (const track of delta.addTracks) {
            const resolved = applyNamespaceInheritance(track, catalogNamespace);
            // §5.1.11 + §5.2: namespace+name must be unique / immutable
            const key = trackKey(resolved);
            if (tracks.some(t => trackKey(t) === key)) {
                throw new Error(
                    `Cannot add track "${resolved.name}" in namespace "${resolved.namespace ?? ''}": ` +
                    `track already exists (§5.1.11, §5.2)`,
                );
            }
            tracks.push(resolved);
        }
    }

    // 2. Remove tracks
    if (delta.removeTracks) {
        for (const ref of delta.removeTracks) {
            const ns = ref.namespace ?? catalogNamespace ?? '';
            const key = `${ns}\0${ref.name}`;
            // §5.2: "Remove a track that has been previously declared"
            if (!tracks.some(t => trackKey(t) === key)) {
                throw new Error(
                    `Cannot remove track "${ref.name}" in namespace "${ns}": ` +
                    `track not found in current catalog state (§5.2)`,
                );
            }
            tracks = tracks.filter(t => trackKey(t) !== key);
        }
    }

    // 3. Clone tracks
    if (delta.cloneTracks) {
        for (const clone of delta.cloneTracks) {
            const parentName = clone.parentName!;
            const parent = tracks.find(t => t.name === parentName);
            if (!parent) {
                throw new Error(
                    `Cannot clone track "${clone.name}": parent track "${parentName}" not found (§5.1.5)`,
                );
            }

            // §5.2: Cloned track inherits all attributes except name;
            // redefined attributes overwrite inherited values
            const cloned = cloneTrack(parent, clone, catalogNamespace);

            // Check uniqueness
            const key = trackKey(cloned);
            if (tracks.some(t => trackKey(t) === key)) {
                throw new Error(
                    `Cannot clone track "${cloned.name}" in namespace "${cloned.namespace ?? ''}": ` +
                    `track already exists (§5.1.11, §5.2)`,
                );
            }

            tracks.push(cloned);
        }
    }

    const generatedAt = delta.generatedAt ?? state.generatedAt;

    return {
        version: state.version,
        tracks,
        // §5.1.6: generatedAt from delta replaces base if present
        ...(generatedAt !== undefined ? { generatedAt } : {}),
        ...(state.isComplete !== undefined ? { isComplete: state.isComplete } : {}),
    };
}

// ─── Internal helpers ────────────────────────────────────────────────

function trackKey(track: { name: string; namespace?: string }): string {
    return `${track.namespace ?? ''}\0${track.name}`;
}

function applyNamespaceInheritance(
    track: CatalogTrack,
    catalogNamespace?: string,
): CatalogTrack {
    if (track.namespace !== undefined) return track;
    if (catalogNamespace === undefined) return track;
    return { ...track, namespace: catalogNamespace };
}

/**
 * Validate a removeTracks entry per §5.1.4:
 * MUST have name, MAY have namespace, MUST NOT have other fields.
 */
function validateRemoveTrackRef(raw: unknown, index: number): RemoveTrackRef {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`removeTracks[${index}] must be a JSON object`);
    }

    const obj = raw as Record<string, unknown>;

    if (typeof obj['name'] !== 'string') {
        throw new Error(`removeTracks[${index}]: name is required (§5.1.4)`);
    }

    // §5.1.4: MUST NOT hold any other fields besides name and namespace
    for (const key of Object.keys(obj)) {
        if (!REMOVE_TRACK_ALLOWED_FIELDS.has(key)) {
            throw new Error(
                `removeTracks[${index}]: field "${key}" is not allowed; ` +
                `only name and namespace are permitted (§5.1.4)`,
            );
        }
    }

    return {
        name: obj['name'],
        ...(typeof obj['namespace'] === 'string' ? { namespace: obj['namespace'] } : {}),
    };
}

/**
 * Validate a cloneTracks entry per §5.1.5: MUST include parentName.
 */
function validateCloneTrackEntry(raw: unknown, index: number): CatalogTrack {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`cloneTracks[${index}] must be a JSON object`);
    }

    const obj = raw as Record<string, unknown>;

    if (typeof obj['parentName'] !== 'string') {
        throw new Error(
            `cloneTracks[${index}]: parentName is required (§5.1.5)`,
        );
    }

    // Clone entries may have partial track fields (overrides), but must have name
    if (typeof obj['name'] !== 'string') {
        throw new Error(
            `cloneTracks[${index}]: name is required`,
        );
    }

    return parseTrackFromRaw(raw, `cloneTracks[${index}]`, true);
}

/**
 * Parse a track-like object from raw JSON.
 * For clone tracks, required fields (packaging, isLive) are relaxed since
 * they can be inherited from the parent.
 */
function parseTrackFromRaw(
    raw: unknown,
    label: string,
    _allowPartial = false,
): CatalogTrack {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`${label} must be a JSON object`);
    }

    const obj = raw as Record<string, unknown>;

    if (typeof obj['name'] !== 'string') {
        throw new Error(`${label}: name is required`);
    }

    const track: CatalogTrack = {
        name: obj['name'],
        packaging: (typeof obj['packaging'] === 'string' ? obj['packaging'] : 'loc') as CatalogTrack['packaging'],
        isLive: typeof obj['isLive'] === 'boolean' ? obj['isLive'] : true,
        ...(typeof obj['namespace'] === 'string' ? { namespace: obj['namespace'] } : {}),
        ...(typeof obj['role'] === 'string' ? { role: obj['role'] } : {}),
        ...(typeof obj['renderGroup'] === 'number' ? { renderGroup: obj['renderGroup'] } : {}),
        ...(typeof obj['altGroup'] === 'number' ? { altGroup: obj['altGroup'] } : {}),
        ...(typeof obj['codec'] === 'string' ? { codec: obj['codec'] } : {}),
        ...(typeof obj['mimeType'] === 'string' ? { mimeType: obj['mimeType'] } : {}),
        ...(typeof obj['framerate'] === 'number' ? { framerate: obj['framerate'] } : {}),
        ...(typeof obj['timescale'] === 'number' ? { timescale: obj['timescale'] } : {}),
        ...(typeof obj['bitrate'] === 'number' ? { bitrate: obj['bitrate'] } : {}),
        ...(typeof obj['width'] === 'number' ? { width: obj['width'] } : {}),
        ...(typeof obj['height'] === 'number' ? { height: obj['height'] } : {}),
        ...(typeof obj['samplerate'] === 'number' ? { samplerate: obj['samplerate'] } : {}),
        ...(typeof obj['channelConfig'] === 'string' ? { channelConfig: obj['channelConfig'] } : {}),
        ...(typeof obj['displayWidth'] === 'number' ? { displayWidth: obj['displayWidth'] } : {}),
        ...(typeof obj['displayHeight'] === 'number' ? { displayHeight: obj['displayHeight'] } : {}),
        ...(typeof obj['lang'] === 'string' ? { lang: obj['lang'] } : {}),
        ...(typeof obj['label'] === 'string' ? { label: obj['label'] } : {}),
        ...(typeof obj['initData'] === 'string' ? { initData: obj['initData'] } : {}),
        ...(Array.isArray(obj['depends']) ? { depends: obj['depends'] as string[] } : {}),
        ...(typeof obj['temporalId'] === 'number' ? { temporalId: obj['temporalId'] } : {}),
        ...(typeof obj['spatialId'] === 'number' ? { spatialId: obj['spatialId'] } : {}),
        ...(typeof obj['targetLatency'] === 'number' ? { targetLatency: obj['targetLatency'] } : {}),
        ...(typeof obj['trackDuration'] === 'number' ? { trackDuration: obj['trackDuration'] } : {}),
        ...(typeof obj['eventType'] === 'string' ? { eventType: obj['eventType'] } : {}),
        ...(typeof obj['parentName'] === 'string' ? { parentName: obj['parentName'] } : {}),
    };

    return track;
}

/**
 * Clone a parent track, applying overrides from the clone descriptor.
 * §5.2: Cloned track inherits all attributes of the parent except name.
 * Attributes redefined in the clone overwrite inherited values.
 */
function cloneTrack(
    parent: CatalogTrack,
    overrides: CatalogTrack,
    catalogNamespace?: string,
): CatalogTrack {
    // Start with all parent attributes
    const cloned: CatalogTrack = { ...parent };

    // Apply overrides (only fields that are explicitly set in the clone descriptor)
    const result: Record<string, unknown> = { ...cloned };

    // Name is always from the clone (§5.2: "except the Track Name which MUST be new")
    result['name'] = overrides.name;

    // Remove parentName from final track (it's a clone instruction, not a track field)
    delete result['parentName'];

    // Apply explicit overrides
    if (overrides.namespace !== undefined) result['namespace'] = overrides.namespace;
    if (overrides.packaging !== undefined) result['packaging'] = overrides.packaging;
    if (overrides.isLive !== undefined) result['isLive'] = overrides.isLive;
    if (overrides.role !== undefined) result['role'] = overrides.role;
    if (overrides.renderGroup !== undefined) result['renderGroup'] = overrides.renderGroup;
    if (overrides.altGroup !== undefined) result['altGroup'] = overrides.altGroup;
    if (overrides.codec !== undefined) result['codec'] = overrides.codec;
    if (overrides.mimeType !== undefined) result['mimeType'] = overrides.mimeType;
    if (overrides.framerate !== undefined) result['framerate'] = overrides.framerate;
    if (overrides.timescale !== undefined) result['timescale'] = overrides.timescale;
    if (overrides.bitrate !== undefined) result['bitrate'] = overrides.bitrate;
    if (overrides.width !== undefined) result['width'] = overrides.width;
    if (overrides.height !== undefined) result['height'] = overrides.height;
    if (overrides.samplerate !== undefined) result['samplerate'] = overrides.samplerate;
    if (overrides.channelConfig !== undefined) result['channelConfig'] = overrides.channelConfig;
    if (overrides.displayWidth !== undefined) result['displayWidth'] = overrides.displayWidth;
    if (overrides.displayHeight !== undefined) result['displayHeight'] = overrides.displayHeight;
    if (overrides.lang !== undefined) result['lang'] = overrides.lang;
    if (overrides.label !== undefined) result['label'] = overrides.label;
    if (overrides.initData !== undefined) result['initData'] = overrides.initData;
    if (overrides.depends !== undefined) result['depends'] = overrides.depends;
    if (overrides.temporalId !== undefined) result['temporalId'] = overrides.temporalId;
    if (overrides.spatialId !== undefined) result['spatialId'] = overrides.spatialId;
    if (overrides.targetLatency !== undefined) result['targetLatency'] = overrides.targetLatency;
    if (overrides.trackDuration !== undefined) result['trackDuration'] = overrides.trackDuration;
    if (overrides.eventType !== undefined) result['eventType'] = overrides.eventType;

    // Apply namespace inheritance if needed
    if (result['namespace'] === undefined && catalogNamespace !== undefined) {
        result['namespace'] = catalogNamespace;
    }

    return result as unknown as CatalogTrack;
}
