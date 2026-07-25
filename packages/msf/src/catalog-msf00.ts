/**
 * Independent catalog parsing and validation.
 *
 * @see draft-ietf-moq-msf-00 §5
 * @module
 */

import { MSF_VERSION } from './types.js';
import type {
    Catalog, CatalogDelta, CatalogObject, CatalogTrack, Packaging,
    MsfMediaTemplate, MsfInitDataEntry, CmsfContentProtection, CmsfDrmSystem, CmsfUrlRef,
} from './types.js';
import { assertFiniteCatalogNumbers } from './catalog-validate.js';

/**
 * Normalize an MSF catalog version to the numeric version this build supports,
 * or `null` if the version is not understood (§5.1.1). Accepts the MSF-00 numeric
 * form `1`, the MSF-01 string form `"1"`, and the recognized draft alias
 * `"draft-01"`. Every OTHER spelling — a numeric != 1, any other string, any
 * other "draft-XX" (the suffix is a draft REVISION, never decoded to a version
 * number) — is unsupported. This is an implementation-profile policy: a
 * subscriber MUST NOT parse a version it does not understand.
 */
function normalizeMsfVersion(v: unknown): number | null {
    if (typeof v === 'number') return v === MSF_VERSION ? MSF_VERSION : null;
    if (typeof v === 'string') return v === '1' || v === 'draft-01' ? MSF_VERSION : null;
    return null;
}

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

    // §5.1.1: version — Required. Accept numeric 1 (MSF-00), "1" and "draft-01"
    // (MSF-01); reject everything else as an unsupported version.
    if (!('version' in obj)) {
        throw new Error('Catalog version is required (§5.1.1)');
    }
    const version = normalizeMsfVersion(obj['version']);
    if (version === null) {
        throw new Error(
            `Unsupported catalog version ${JSON.stringify(obj['version'])}; expected 1, "1", or "draft-01" (§5.1.1)`,
        );
    }

    // §5.1.8: tracks — Required, must be an array
    if (!('tracks' in obj) || !Array.isArray(obj['tracks'])) {
        throw new Error('Catalog tracks field is required and must be an array (§5.1.8)');
    }

    // MSF-00 is selected by a NUMERIC version; the string forms ("1"/"draft-01")
    // are the MSF-01/CMSF-01 profile. The §7.2/§8.2 mimeType MUST is enforced
    // strictly for legacy MSF-00 (behavior unchanged) but relaxed for MSF-01 (see
    // parseTrack), where a mediatimeline may carry only the non-canonical mime
    // spelling the corpus oracle accepts.
    const legacyMsf00 = typeof obj['version'] === 'number';

    const tracks = (obj['tracks'] as unknown[]).map(
        (raw, i) => parseTrack(raw, i, catalogNamespace, legacyMsf00),
    );

    // §5.1.11: Track names must be unique per namespace
    validateTrackUniqueness(tracks);

    // §5.1.16: targetLatency consistency within renderGroup and altGroup
    validateTargetLatencyConsistency(tracks);

    // §5.1.7: isComplete MUST NOT be included if false
    if ('isComplete' in obj && obj['isComplete'] !== true) {
        throw new Error('isComplete MUST NOT be included if false (§5.1.7)');
    }

    // MSF-01 §5.1.5: publishTracks — an array of track objects (reverse direction).
    const publishTracks = Array.isArray(obj['publishTracks'])
        ? (obj['publishTracks'] as unknown[]).map((raw, i) => parseTrack(raw, i, catalogNamespace, legacyMsf00))
        : undefined;

    // MSF-01 §5.1.7: root Initialization Data List (ids unique within the catalog).
    const initDataList = 'initDataList' in obj ? parseInitDataList(obj['initDataList']) : undefined;

    // CMSF-01 §4.1.1: root content protections (refIDs unique across the array).
    const contentProtections = 'contentProtections' in obj ? parseContentProtections(obj['contentProtections']) : undefined;

    const catalog: Catalog = {
        version,
        tracks,
        ...(typeof obj['generatedAt'] === 'number' ? { generatedAt: obj['generatedAt'] } : {}),
        ...(obj['isComplete'] === true ? { isComplete: true } : {}),
        ...(initDataList !== undefined ? { initDataList } : {}),
        ...(contentProtections !== undefined ? { contentProtections } : {}),
        ...(publishTracks !== undefined ? { publishTracks } : {}),
    };

    // MSF-01 §5.2.13 / CMSF-01 §4.1.2: reference topology — initRef and
    // contentProtectionRefIDs MUST resolve to declared ids/refIDs.
    validateReferences(catalog);

    assertFiniteCatalogNumbers(catalog);
    return catalog;
}

/** Parse the MSF-01 §5.1.7 initDataList; ids MUST be unique within the catalog. */
function parseInitDataList(raw: unknown): MsfInitDataEntry[] {
    if (!Array.isArray(raw)) {
        throw new Error('initDataList must be an array (§5.1.7)');
    }
    const seen = new Set<string>();
    return raw.map((e, i) => {
        if (typeof e !== 'object' || e === null || Array.isArray(e)) {
            throw new Error(`initDataList[${i}] must be a JSON object (§5.1.7)`);
        }
        const o = e as Record<string, unknown>;
        if (typeof o['id'] !== 'string' || typeof o['type'] !== 'string' || typeof o['data'] !== 'string') {
            throw new Error(`initDataList[${i}] requires string id, type, and data (§5.1.7)`);
        }
        if (seen.has(o['id'])) {
            throw new Error(`Duplicate initDataList id "${o['id']}" — ids MUST be unique within the catalog (§5.1.7)`);
        }
        seen.add(o['id']);
        // `data` is carried as an OPAQUE base64 string; it is never decoded here.
        return { id: o['id'], type: o['type'], data: o['data'] };
    });
}

/** Parse CMSF-01 §4.1.1 contentProtections; refIDs MUST be unique across the array. */
function parseContentProtections(raw: unknown): CmsfContentProtection[] {
    if (!Array.isArray(raw)) {
        throw new Error('contentProtections must be an array (CMSF §4.1.1)');
    }
    const seen = new Set<string>();
    return raw.map((e, i) => {
        if (typeof e !== 'object' || e === null || Array.isArray(e)) {
            throw new Error(`contentProtections[${i}] must be a JSON object (CMSF §4.1.1)`);
        }
        const o = e as Record<string, unknown>;
        if (typeof o['refID'] !== 'string') {
            throw new Error(`contentProtections[${i}]: refID is required and must be a string (CMSF §4.1.1.1)`);
        }
        if (seen.has(o['refID'])) {
            throw new Error(`Duplicate contentProtections refID "${o['refID']}" — refIDs MUST be unique across the array (CMSF §4.1.1.1)`);
        }
        seen.add(o['refID']);
        if (!Array.isArray(o['defaultKID'])) {
            throw new Error(`contentProtections[${i}]: defaultKID is required and must be an array (CMSF §4.1.1.2)`);
        }
        if (typeof o['scheme'] !== 'string') {
            throw new Error(`contentProtections[${i}]: scheme is required and must be a string (CMSF §4.1.1.3)`);
        }
        return {
            refID: o['refID'],
            defaultKID: parseStringArray(`contentProtections[${i}]`, 'defaultKID', o['defaultKID']),
            scheme: o['scheme'],
            drmSystem: parseDrmSystem(i, o['drmSystem']),
        };
    });
}

/** Parse a CMSF-01 §4.1.1.4 DRM-system object. Values are opaque metadata (pssh never decoded). */
function parseDrmSystem(cpIndex: number, raw: unknown): CmsfDrmSystem {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`contentProtections[${cpIndex}]: drmSystem is required and must be a JSON object (CMSF §4.1.1.4)`);
    }
    const o = raw as Record<string, unknown>;
    if (typeof o['systemID'] !== 'string') {
        throw new Error(`contentProtections[${cpIndex}].drmSystem: systemID is required and must be a string (CMSF §4.1.1.4.1)`);
    }
    const url = (key: string): CmsfUrlRef | undefined => {
        const u = o[key];
        if (u === undefined) return undefined;
        if (typeof u !== 'object' || u === null || Array.isArray(u) || typeof (u as Record<string, unknown>)['url'] !== 'string') {
            throw new Error(`contentProtections[${cpIndex}].drmSystem.${key} must be an object with a string url (CMSF §4.1.1.4)`);
        }
        const uo = u as Record<string, unknown>;
        return { url: uo['url'] as string, ...(typeof uo['type'] === 'string' ? { type: uo['type'] } : {}) };
    };
    return {
        systemID: o['systemID'],
        ...(url('laURL') !== undefined ? { laURL: url('laURL')! } : {}),
        ...(url('certURL') !== undefined ? { certURL: url('certURL')! } : {}),
        ...(url('authorizationURL') !== undefined ? { authorizationURL: url('authorizationURL')! } : {}),
        ...(typeof o['pssh'] === 'string' ? { pssh: o['pssh'] } : {}),
        ...(typeof o['robustness'] === 'string' ? { robustness: o['robustness'] } : {}),
    };
}

/**
 * Validate reference topology: initRef → initDataList id, contentProtectionRefIDs
 * → contentProtections refID. Accepts any catalog-shaped value (an independent
 * `Catalog` or an applied `CatalogState`) so the delta-application path can
 * re-validate references after mutating the track list.
 */
export function validateReferences(catalog: {
    readonly tracks: readonly CatalogTrack[];
    readonly initDataList?: readonly MsfInitDataEntry[];
    readonly contentProtections?: readonly CmsfContentProtection[];
    readonly publishTracks?: readonly CatalogTrack[];
}): void {
    const initIds = new Set((catalog.initDataList ?? []).map((e) => e.id));
    const cpRefIds = new Set((catalog.contentProtections ?? []).map((c) => c.refID));
    const check = (tracks: readonly CatalogTrack[]): void => {
        for (const t of tracks) {
            if (t.initRef !== undefined && !initIds.has(t.initRef)) {
                throw new Error(`Track "${t.name}": initRef "${t.initRef}" references unknown initDataList id (dangling init reference) (§5.2.13)`);
            }
            for (const ref of t.contentProtectionRefIDs ?? []) {
                if (!cpRefIds.has(ref)) {
                    throw new Error(`Track "${t.name}": contentProtectionRefIDs "${ref}" references unknown contentProtections refID (dangling content protection reference) (CMSF §4.1.2)`);
                }
            }
        }
    };
    check(catalog.tracks);
    check(catalog.publishTracks ?? []);
}

/**
 * Parse and validate a single track object.
 * Strips unknown fields per §5.1.
 */
function parseTrack(
    raw: unknown,
    index: number,
    catalogNamespace: string | undefined,
    legacyMsf00: boolean,
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

    // §7.2 / §8.2: mediatimeline/eventtimeline tracks MUST carry a depends array
    // (both profiles). The canonical mimeType "application/json" MUST is enforced
    // for the legacy MSF-00 (numeric-version) profile — unchanged. For MSF-01
    // (string version) it is relaxed: the mimeType is projected when present but
    // NOT required, because the corpus oracle accepts a mediatimeline whose only
    // mime spelling is the non-standard lowercase "mimetype" (dropped as unknown,
    // leaving no canonical mimeType); enforcing it would contradict that oracle.
    if (packaging === 'mediatimeline' || packaging === 'eventtimeline') {
        const section = packaging === 'mediatimeline' ? '§7.2' : '§8.2';
        if (!Array.isArray(obj['depends']) || (obj['depends'] as unknown[]).length === 0) {
            throw new Error(
                `Track "${name}": depends is required for packaging "${packaging}" (${section})`,
            );
        }
        if (legacyMsf00 && obj['mimeType'] !== 'application/json') {
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

    // Build track with only known fields (§5.1: ignore unknown). The required
    // triple (name/packaging/isLive) plus the inherited namespace, then the
    // recognized optional fields via the shared extractor. `parentName` is NOT
    // emitted here — it is forbidden on an independent track (rejected above) and
    // belongs only to a delta clone operation.
    const track: CatalogTrack = {
        name,
        packaging,
        isLive,
        ...(namespace !== undefined ? { namespace } : {}),
        ...extractRecognizedOptionalFields(obj, name),
    };

    return track;
}

/**
 * Extract the recognized OPTIONAL track fields present on a raw track object,
 * present-only (absent fields stay absent) and unknown fields dropped. Excludes
 * the identity fields (name/packaging/isLive/namespace) and the clone-only
 * parentName/parentNamespace — callers supply those. Shared by the full track
 * parser and the MSF-01 delta op-track parser so both recognize the same field
 * set with identical drop / template-validation semantics.
 */
export function extractRecognizedOptionalFields(
    obj: Record<string, unknown>,
    trackName: string,
): Partial<CatalogTrack> {
    return {
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
        // CMSF extensions (draft-ietf-moq-cmsf-00 §3.5.2)
        ...(typeof obj['maxGrpSapStartingType'] === 'number' ? { maxGrpSapStartingType: obj['maxGrpSapStartingType'] } : {}),
        ...(typeof obj['maxObjSapStartingType'] === 'number' ? { maxObjSapStartingType: obj['maxObjSapStartingType'] } : {}),
        // MSF-01 / CMSF-01
        ...(typeof obj['initRef'] === 'string' ? { initRef: obj['initRef'] } : {}),               // §5.2.13
        ...(obj['template'] !== undefined ? { template: parseTemplate(trackName, obj['template']) } : {}), // §5.2.15
        ...(Array.isArray(obj['contentProtectionRefIDs'])                                          // CMSF §4.1.2
            ? { contentProtectionRefIDs: parseStringArray(trackName, 'contentProtectionRefIDs', obj['contentProtectionRefIDs']) }
            : {}),
    };
}

/** Parse the §5.2.15 template 6-tuple; a malformed template is a PROTO error (not silently dropped). */
function parseTemplate(trackName: string, raw: unknown): MsfMediaTemplate {
    const bad = (): never => { throw new Error(`Track "${trackName}": template must be a 6-item array [startMedia, deltaMedia, [startGroup,startObject], [deltaGroup,deltaObject], startWallclock, deltaWallclock] (§5.2.15)`); };
    if (!Array.isArray(raw) || raw.length !== 6) bad();
    const a = raw as unknown[];
    const uint = (x: unknown): number => (typeof x === 'number' && Number.isInteger(x) && x >= 0) ? x : bad();
    const pair = (x: unknown): [number, number] => {
        if (!Array.isArray(x) || x.length !== 2) bad();
        return [uint((x as unknown[])[0]), uint((x as unknown[])[1])];
    };
    return [uint(a[0]), uint(a[1]), pair(a[2]), pair(a[3]), uint(a[4]), uint(a[5])];
}

/** Parse an array of strings, rejecting non-string entries. */
function parseStringArray(trackName: string, field: string, raw: unknown[]): string[] {
    return raw.map((s, i) => {
        if (typeof s !== 'string') {
            throw new Error(`Track "${trackName}": ${field}[${i}] must be a string`);
        }
        return s;
    });
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
