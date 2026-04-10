/**
 * Independent catalog parsing and validation.
 *
 * @see draft-ietf-moq-msf-00 §5
 * @module
 */

import { MSF_VERSION } from './types.js';
import type { Catalog, CatalogDelta, CatalogObject, CatalogTrack, Packaging } from './types.js';

/**
 * Type guard to discriminate between a Catalog and a CatalogDelta.
 * @see draft-ietf-moq-msf-00 §5.1.2
 */
export function isDelta(obj: CatalogObject): obj is CatalogDelta {
    return 'deltaUpdate' in obj && (obj as CatalogDelta).deltaUpdate === true;
}

/**
 * Set of known packaging values.
 * @see draft-ietf-moq-msf-00 §5.1.12 Table 3
 * @see draft-ietf-moq-cmsf-00 §3.5.1 (adds 'cmaf')
 */
const VALID_PACKAGING = new Set<string>(['loc', 'mediatimeline', 'eventtimeline', 'cmaf']);

/**
 * Parse an independent (non-delta) MSF catalog from JSON.
 *
 * Validates all MUST requirements from the spec:
 * - version must be 1 (§5.1.1)
 * - tracks array must be present (§5.1.8)
 * - each track must have name, packaging, isLive (§5.1.11, §5.1.12, §5.1.15)
 * - track names must be unique per namespace (§5.1.11)
 * - targetLatency MUST NOT appear if isLive=false (§5.1.16)
 * - trackDuration MUST NOT appear if isLive=true (§5.1.37)
 * - eventType required iff packaging="eventtimeline" (§5.1.13)
 * - unknown fields are ignored (§5.1)
 *
 * @param json Raw JSON string or UTF-8 bytes
 * @param catalogNamespace Namespace of the catalog track; tracks without
 *   explicit namespace inherit this value (§5.1.10)
 * @returns Parsed and validated Catalog
 * @throws {Error} If the JSON is invalid or violates spec requirements
 * @see draft-ietf-moq-msf-00 §5
 */
export function parseMsfCatalog(
    json: string | Uint8Array,
    catalogNamespace?: string,
): Catalog {
    const text = typeof json === 'string' ? json : new TextDecoder().decode(json);
    const raw: unknown = JSON.parse(text);

    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('Catalog must be a JSON object');
    }

    const obj = raw as Record<string, unknown>;

    // §5.1.1: version — Required, must be MSF_VERSION (1)
    if (!('version' in obj) || typeof obj['version'] !== 'number') {
        throw new Error('Catalog version is required and must be a number (§5.1.1)');
    }
    if (obj['version'] !== MSF_VERSION) {
        throw new Error(
            `Unsupported catalog version ${obj['version']}; expected ${MSF_VERSION} (§5.1.1)`,
        );
    }

    // §5.1.8: tracks — Required, must be an array
    if (!('tracks' in obj) || !Array.isArray(obj['tracks'])) {
        throw new Error('Catalog tracks field is required and must be an array (§5.1.8)');
    }

    const tracks = (obj['tracks'] as unknown[]).map(
        (raw, i) => parseTrack(raw, i, catalogNamespace),
    );

    // §5.1.11: Track names must be unique per namespace
    validateTrackUniqueness(tracks);

    // §5.1.16: targetLatency consistency within renderGroup and altGroup
    validateTargetLatencyConsistency(tracks);

    // §5.1.7: isComplete MUST NOT be included if false
    if ('isComplete' in obj && obj['isComplete'] !== true) {
        throw new Error('isComplete MUST NOT be included if false (§5.1.7)');
    }

    const catalog: Catalog = {
        version: MSF_VERSION,
        tracks,
        ...(typeof obj['generatedAt'] === 'number' ? { generatedAt: obj['generatedAt'] } : {}),
        ...(obj['isComplete'] === true ? { isComplete: true } : {}),
    };

    return catalog;
}

/**
 * Parse and validate a single track object.
 * Strips unknown fields per §5.1.
 */
function parseTrack(
    raw: unknown,
    index: number,
    catalogNamespace?: string,
): CatalogTrack {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`Track at index ${index} must be a JSON object`);
    }

    const obj = raw as Record<string, unknown>;

    // §5.1.11: name — Required
    if (typeof obj['name'] !== 'string') {
        throw new Error(`Track at index ${index}: name is required and must be a string (§5.1.11)`);
    }
    const name = obj['name'];

    // §5.1.12: packaging — Required
    if (typeof obj['packaging'] !== 'string' || !VALID_PACKAGING.has(obj['packaging'])) {
        throw new Error(
            `Track "${name}" at index ${index}: packaging is required and must be one of ${[...VALID_PACKAGING].join(', ')} (§5.1.12)`,
        );
    }
    const packaging = obj['packaging'] as Packaging;

    // §5.1.15: isLive — Required
    if (typeof obj['isLive'] !== 'boolean') {
        throw new Error(
            `Track "${name}" at index ${index}: isLive is required and must be a boolean (§5.1.15)`,
        );
    }
    const isLive = obj['isLive'];

    // §5.1.16: targetLatency MUST NOT be included if isLive is false
    if (!isLive && obj['targetLatency'] !== undefined) {
        throw new Error(
            `Track "${name}": targetLatency MUST NOT be included when isLive is false (§5.1.16)`,
        );
    }

    // §5.1.37: trackDuration MUST NOT be included if isLive is true
    if (isLive && obj['trackDuration'] !== undefined) {
        throw new Error(
            `Track "${name}": trackDuration MUST NOT be included when isLive is true (§5.1.37)`,
        );
    }

    // §5.1.13: eventType required iff packaging="eventtimeline"
    if (packaging === 'eventtimeline' && typeof obj['eventType'] !== 'string') {
        throw new Error(
            `Track "${name}": eventType is required when packaging is "eventtimeline" (§5.1.13)`,
        );
    }
    if (packaging !== 'eventtimeline' && obj['eventType'] !== undefined) {
        throw new Error(
            `Track "${name}": eventType MUST NOT be used when packaging is not "eventtimeline" (§5.1.13)`,
        );
    }

    // §7.2: mediatimeline tracks MUST have depends and mimeType="application/json"
    // §8.2: eventtimeline tracks MUST have depends and mimeType="application/json"
    if (packaging === 'mediatimeline' || packaging === 'eventtimeline') {
        const section = packaging === 'mediatimeline' ? '§7.2' : '§8.2';
        if (!Array.isArray(obj['depends']) || (obj['depends'] as unknown[]).length === 0) {
            throw new Error(
                `Track "${name}": depends is required for packaging "${packaging}" (${section})`,
            );
        }
        if (obj['mimeType'] !== 'application/json') {
            throw new Error(
                `Track "${name}": mimeType MUST be "application/json" for packaging "${packaging}" (${section})`,
            );
        }
    }

    // §5.1.20: initData MUST be valid Base64
    if (typeof obj['initData'] === 'string' && obj['initData'] !== '') {
        if (!isValidBase64(obj['initData'])) {
            throw new Error(
                `Track "${name}" at index ${index}: initData is not valid Base64 (§5.1.20)`,
            );
        }
    }

    // §5.1.35: lang MUST be a valid BCP 47 language tag
    if (typeof obj['lang'] === 'string') {
        if (!isValidBcp47(obj['lang'])) {
            throw new Error(
                `Track "${name}" at index ${index}: lang "${obj['lang']}" is not a valid BCP 47 language tag (§5.1.35)`,
            );
        }
    }

    // §5.1.36: parentName MUST only appear in clone context (delta cloneTracks)
    if ('parentName' in obj) {
        throw new Error(
            `Track "${name}" at index ${index}: parentName MUST only appear in clone context (§5.1.36)`,
        );
    }

    // §5.1.10: Namespace inheritance — if absent, inherit catalog namespace
    const namespace = typeof obj['namespace'] === 'string'
        ? obj['namespace']
        : catalogNamespace;

    // Build track with only known fields (§5.1: ignore unknown)
    const track: CatalogTrack = {
        name,
        packaging,
        isLive,
        ...(namespace !== undefined ? { namespace } : {}),
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
        ...(typeof obj['initTrack'] === 'string' ? { initTrack: obj['initTrack'] } : {}),
        ...(Array.isArray(obj['depends']) ? { depends: obj['depends'] as string[] } : {}),
        ...(typeof obj['temporalId'] === 'number' ? { temporalId: obj['temporalId'] } : {}),
        ...(typeof obj['spatialId'] === 'number' ? { spatialId: obj['spatialId'] } : {}),
        ...(typeof obj['targetLatency'] === 'number' ? { targetLatency: obj['targetLatency'] } : {}),
        ...(typeof obj['trackDuration'] === 'number' ? { trackDuration: obj['trackDuration'] } : {}),
        ...(typeof obj['eventType'] === 'string' ? { eventType: obj['eventType'] } : {}),
        ...(typeof obj['parentName'] === 'string' ? { parentName: obj['parentName'] } : {}),
        // CMSF extensions (draft-ietf-moq-cmsf-00 §3.5.2)
        ...(typeof obj['maxGrpSapStartingType'] === 'number' ? { maxGrpSapStartingType: obj['maxGrpSapStartingType'] } : {}),
        ...(typeof obj['maxObjSapStartingType'] === 'number' ? { maxObjSapStartingType: obj['maxObjSapStartingType'] } : {}),
    };

    return track;
}

/**
 * Validate that targetLatency is identical across all tracks sharing
 * the same renderGroup or altGroup.
 * @see draft-ietf-moq-msf-00 §5.1.16
 */
function validateTargetLatencyConsistency(tracks: CatalogTrack[]): void {
    validateGroupLatency(tracks, 'renderGroup');
    validateGroupLatency(tracks, 'altGroup');
}

function validateGroupLatency(
    tracks: CatalogTrack[],
    groupField: 'renderGroup' | 'altGroup',
): void {
    const groups = new Map<number, number | undefined>();
    for (const track of tracks) {
        const groupId = track[groupField];
        if (groupId === undefined) continue;
        if (groups.has(groupId)) {
            const existing = groups.get(groupId);
            if (existing !== track.targetLatency) {
                throw new Error(
                    `Tracks in ${groupField} ${groupId} have inconsistent targetLatency values (§5.1.16)`,
                );
            }
        } else {
            groups.set(groupId, track.targetLatency);
        }
    }
}

/**
 * Validate that a string is valid standard Base64 (RFC 4648 §4).
 * Length must be divisible by 4, characters from [A-Za-z0-9+/], with 0-2 trailing '='.
 * @see draft-ietf-moq-msf-00 §5.1.20
 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function isValidBase64(s: string): boolean {
    return s.length % 4 === 0 && BASE64_PATTERN.test(s);
}

/**
 * Basic structural validation for BCP 47 language tags.
 * Format: language[-script][-region][-variant]*[-extension]*[-privateuse]
 * where language is 2-3 alpha chars.
 * @see draft-ietf-moq-msf-00 §5.1.35
 */
const BCP47_PATTERN = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/;

function isValidBcp47(tag: string): boolean {
    return BCP47_PATTERN.test(tag);
}

/**
 * Validate that track names are unique within each namespace.
 * @see draft-ietf-moq-msf-00 §5.1.11
 */
function validateTrackUniqueness(tracks: CatalogTrack[]): void {
    const seen = new Set<string>();
    for (const track of tracks) {
        const key = `${track.namespace ?? ''}\0${track.name}`;
        if (seen.has(key)) {
            throw new Error(
                `Duplicate track name "${track.name}" in namespace "${track.namespace ?? '(inherited)'}" (§5.1.11)`,
            );
        }
        seen.add(key);
    }
}
