/**
 * catalogformat-01 catalog parsing and JSON Patch delta support.
 *
 * Parses the legacy catalog format used by draft-14 era servers (e.g. moq-rs).
 * Normalizes to the same CatalogTrack / Catalog types as MSF-00.
 *
 * @see draft-ietf-moq-catalogformat-01 §3
 * @module
 */

import fjp from 'fast-json-patch';
const { applyPatch, validate } = fjp;
import type { Catalog, CatalogTrack, Packaging } from './types.js';

/**
 * Extended result from cf01 parsing — includes raw document for future JSON Patch deltas.
 */
export interface Cf01ParseResult {
    /** The normalized catalog (same type as MSF-00 output). */
    catalog: Catalog;
    /** Whether the catalog advertised delta update support. */
    supportsDeltaUpdates: boolean;
    /** The raw parsed JSON document — base for future JSON Patch deltas. */
    rawDocument: Record<string, unknown>;
}

/** Valid packaging values (shared with MSF-00). */
const VALID_PACKAGING = new Set<string>(['loc', 'mediatimeline', 'eventtimeline', 'cmaf']);

/** Video codec prefixes for role inference. */
const VIDEO_CODEC_PREFIXES = ['avc1', 'hev1', 'hvc1', 'vp09', 'av01'];
/** Audio codec prefixes for role inference. */
const AUDIO_CODEC_PREFIXES = ['mp4a', 'opus', 'fLaC', 'Opus'];

/**
 * Parse an independent catalogformat-01 catalog.
 *
 * @param json Raw JSON string or UTF-8 bytes
 * @param catalogNamespace Namespace fallback (catalog track namespace)
 * @param options Parsing options
 * @returns Extended result with raw document for delta patching
 * @throws {Error} If the JSON is invalid or violates spec requirements
 * @see draft-ietf-moq-catalogformat-01 §3
 */
export function parseCatalogFormat01(
    json: string | Uint8Array,
    catalogNamespace?: string,
    options?: { strict?: boolean },
): Cf01ParseResult {
    const text = typeof json === 'string' ? json : new TextDecoder().decode(json);
    const raw: unknown = JSON.parse(text);

    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('Catalog must be a JSON object');
    }

    const obj = raw as Record<string, unknown>;

    return parseCf01Object(obj, catalogNamespace, options);
}

/**
 * Apply a JSON Patch (RFC 6902) delta to a previous cf01 catalog.
 *
 * @param previousRaw The rawDocument from the last Cf01ParseResult
 * @param patchOps JSON Patch operations array
 * @param catalogNamespace Namespace fallback
 * @param options Parsing options
 * @returns New Cf01ParseResult with updated catalog and rawDocument
 * @see draft-ietf-moq-catalogformat-01 §3.3 (Catalog Patch)
 */
export function applyCf01Patch(
    previousRaw: Record<string, unknown>,
    patchOps: unknown[],
    catalogNamespace?: string,
    options?: { strict?: boolean },
): Cf01ParseResult {
    const ops = patchOps as Parameters<typeof applyPatch>[1];

    // Validate patch operations before applying
    const validationError = validate(ops, previousRaw);
    if (validationError) {
        throw new Error(`Invalid JSON Patch: ${validationError.message}`);
    }

    // §3.3: Reject operations that directly target name or namespace
    rejectForbiddenPaths(ops, previousRaw);

    // Parse pre-patch through normalizer to get EFFECTIVE track state
    // (with commonTrackFields inheritance + catalogNamespace resolved)
    const preResult = parseCf01Object(previousRaw, catalogNamespace, options);
    const preEffective = buildEffectiveSnapshots(preResult.catalog.tracks);

    // Deep clone to avoid mutating the original
    const cloned = JSON.parse(JSON.stringify(previousRaw)) as Record<string, unknown>;

    // Apply RFC 6902 operations
    const result = applyPatch(cloned, ops);
    const patchedDoc = result.newDocument as Record<string, unknown>;

    // Parse post-patch through normalizer (same inheritance rules)
    const postResult = parseCf01Object(patchedDoc, catalogNamespace, options);
    const postEffective = buildEffectiveSnapshots(postResult.catalog.tracks);

    // §3.3 + §3.3: validate invariants on EFFECTIVE state
    validatePatchInvariants(preEffective, postEffective);

    return postResult;
}

// ─── Internal ────────────────────────────────────────────────────────

function parseCf01Object(
    obj: Record<string, unknown>,
    catalogNamespace?: string,
    options?: { strict?: boolean },
): Cf01ParseResult {
    // §3.2.6: catalogs-mode check (before anything else)
    if ('catalogs' in obj) {
        throw new Error(
            'Hierarchical catalogs (catalogs-mode) are not supported; ' +
            'only tracks-mode catalogs are parsed.',
        );
    }

    // §3.2: version — required, must be 1
    const rawVersion = obj['version'];
    const version = typeof rawVersion === 'string' ? Number(rawVersion) : rawVersion;
    if (version !== 1) {
        throw new Error(
            `Unsupported catalog version ${String(rawVersion)}; expected 1 (§3.2)`,
        );
    }

    // §3.2.1: streamingFormat — required
    if (!('streamingFormat' in obj)) {
        throw new Error('streamingFormat is required (§3.2.1)');
    }

    // §3.2.2: streamingFormatVersion — required per spec
    if (!('streamingFormatVersion' in obj)) {
        if (options?.strict) {
            throw new Error('streamingFormatVersion is required (§3.2.2)');
        }
        // streamingFormatVersion missing — interop mode (§3.2.2 violation by publisher).
    }

    // supportsDeltaUpdates
    const supportsDeltaUpdates = obj['supportsDeltaUpdates'] === true;

    // §3.2.5: tracks — required (catalogs-mode rejected above)
    if (!('tracks' in obj) || !Array.isArray(obj['tracks'])) {
        throw new Error('Catalog tracks field is required and must be an array (§3.2.5)');
    }

    // §3.2.4: commonTrackFields
    const commonFields = (typeof obj['commonTrackFields'] === 'object' &&
        obj['commonTrackFields'] !== null &&
        !Array.isArray(obj['commonTrackFields']))
        ? obj['commonTrackFields'] as Record<string, unknown>
        : {};

    // Root-level TFC field inheritance (§3.2 "Any track or catalog field
    // declared at the root level is inherited by all tracks or catalogs").
    // TFC fields on the catalog object itself form the outermost inheritance
    // layer: track > commonTrackFields > catalog root > external catalogNamespace.
    const rootFields: Record<string, unknown> = {};
    if (typeof obj['namespace'] === 'string') rootFields['namespace'] = obj['namespace'];
    if (typeof obj['name'] === 'string') rootFields['name'] = obj['name'];

    const tracks = (obj['tracks'] as unknown[]).map((rawTrack, i) =>
        parseCf01Track(rawTrack, i, commonFields, rootFields, catalogNamespace, options),
    );

    // Validate track name uniqueness per namespace
    validateTrackUniqueness(tracks);

    // Validate initTrack references (§3.2.16)
    validateInitTrackRefs(tracks);

    return {
        catalog: { version: 1, tracks },
        supportsDeltaUpdates,
        rawDocument: obj,
    };
}

function parseCf01Track(
    raw: unknown,
    index: number,
    commonFields: Record<string, unknown>,
    rootFields: Record<string, unknown>,
    catalogNamespace?: string,
    options?: { strict?: boolean },
): CatalogTrack {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`Track at index ${index} must be a JSON object`);
    }

    const trackObj = raw as Record<string, unknown>;

    // Generic merge: catalog root first, then commonTrackFields, then track overrides
    // (§3.2: "Any track or catalog field declared at the root level is inherited
    // by all tracks... declared within a track object overwrites any inherited value.")
    const merged: Record<string, unknown> = { ...rootFields, ...commonFields, ...trackObj };

    // Deep merge selectionParams
    const commonSp = commonFields['selectionParams'];
    const trackSp = trackObj['selectionParams'];
    let selectionParams: Record<string, unknown> | undefined;

    if (commonSp || trackSp) {
        const baseSp = (typeof commonSp === 'object' && commonSp !== null && !Array.isArray(commonSp))
            ? commonSp as Record<string, unknown>
            : {};
        const overSp = (typeof trackSp === 'object' && trackSp !== null && !Array.isArray(trackSp))
            ? trackSp as Record<string, unknown>
            : {};

        selectionParams = { ...baseSp, ...overSp };

        // §3.2.17: selectionParams MUST NOT be empty
        if (Object.keys(selectionParams).length === 0) {
            throw new Error(
                `Track at index ${index}: selectionParams MUST NOT be empty (§3.2.17)`,
            );
        }
    }

    // §3.2.10: name — required
    if (typeof merged['name'] !== 'string') {
        throw new Error(`Track at index ${index}: name is required (§3.2.10)`);
    }
    const name = merged['name'] as string;

    // Namespace inheritance: track > commonTrackFields > catalogNamespace
    const namespace = typeof merged['namespace'] === 'string'
        ? merged['namespace'] as string
        : catalogNamespace;

    // Packaging (§3.2.11: required, location TF)
    let packaging: Packaging;
    if (typeof merged['packaging'] === 'string' && VALID_PACKAGING.has(merged['packaging'])) {
        packaging = merged['packaging'] as Packaging;
    } else if (typeof merged['packaging'] === 'string') {
        throw new Error(
            `Track "${name}" at index ${index}: unknown packaging "${merged['packaging']}" (§3.2.11)`,
        );
    } else {
        // Packaging absent after inheritance
        if (options?.strict) {
            throw new Error(
                `Track "${name}" at index ${index}: packaging is required (§3.2.11)`,
            );
        }
        // packaging missing after inheritance — defaulting to 'cmaf' (§3.2.11 violation by publisher).
        packaging = 'cmaf';
    }

    // isLive — not in cf01, default true
    const isLive = typeof merged['isLive'] === 'boolean'
        ? merged['isLive'] as boolean
        : true;

    // Role inference
    let role: string | undefined;
    if (typeof merged['role'] === 'string') {
        role = merged['role'] as string;
    } else {
        role = inferRole(selectionParams);
    }

    // Build CatalogTrack
    const track: CatalogTrack = {
        name,
        packaging,
        isLive,
        ...(namespace !== undefined ? { namespace } : {}),
        ...(role !== undefined ? { role } : {}),
        ...(typeof merged['renderGroup'] === 'number' ? { renderGroup: merged['renderGroup'] as number } : {}),
        ...(typeof merged['altGroup'] === 'number' ? { altGroup: merged['altGroup'] as number } : {}),
        ...(typeof merged['label'] === 'string' ? { label: merged['label'] as string } : {}),
        ...(typeof merged['initData'] === 'string' ? { initData: merged['initData'] as string } : {}),
        ...(typeof merged['initTrack'] === 'string' ? { initTrack: merged['initTrack'] as string } : {}),
        ...(Array.isArray(merged['depends']) ? { depends: merged['depends'] as string[] } : {}),
        ...(typeof merged['temporalId'] === 'number' ? { temporalId: merged['temporalId'] as number } : {}),
        ...(typeof merged['spatialId'] === 'number' ? { spatialId: merged['spatialId'] as number } : {}),
        ...(typeof merged['targetLatency'] === 'number' ? { targetLatency: merged['targetLatency'] as number } : {}),
        ...(typeof merged['trackDuration'] === 'number' ? { trackDuration: merged['trackDuration'] as number } : {}),
        // Flatten selectionParams onto track
        ...(selectionParams ? flattenSelectionParams(selectionParams) : {}),
    };

    return track;
}

function flattenSelectionParams(sp: Record<string, unknown>): Partial<CatalogTrack> {
    const flat: Record<string, unknown> = {};
    if (typeof sp['codec'] === 'string') flat['codec'] = sp['codec'];
    if (typeof sp['mimeType'] === 'string') flat['mimeType'] = sp['mimeType'];
    if (typeof sp['framerate'] === 'number') flat['framerate'] = sp['framerate'];
    if (typeof sp['bitrate'] === 'number') flat['bitrate'] = sp['bitrate'];
    if (typeof sp['width'] === 'number') flat['width'] = sp['width'];
    if (typeof sp['height'] === 'number') flat['height'] = sp['height'];
    if (typeof sp['samplerate'] === 'number') flat['samplerate'] = sp['samplerate'];
    if (typeof sp['channelConfig'] === 'string') flat['channelConfig'] = sp['channelConfig'];
    if (typeof sp['displayWidth'] === 'number') flat['displayWidth'] = sp['displayWidth'];
    if (typeof sp['displayHeight'] === 'number') flat['displayHeight'] = sp['displayHeight'];
    if (typeof sp['lang'] === 'string') flat['lang'] = sp['lang'];
    return flat as Partial<CatalogTrack>;
}

function inferRole(sp?: Record<string, unknown>): string | undefined {
    if (!sp) return undefined;

    // 1. mimeType prefix
    const mimeType = sp['mimeType'];
    if (typeof mimeType === 'string') {
        if (mimeType.startsWith('video/')) return 'video';
        if (mimeType.startsWith('audio/')) return 'audio';
    }

    // 2. codec heuristic
    const codec = sp['codec'];
    if (typeof codec === 'string') {
        const prefix = codec.split('.')[0]!;
        if (VIDEO_CODEC_PREFIXES.includes(prefix)) return 'video';
        if (AUDIO_CODEC_PREFIXES.includes(prefix)) return 'audio';
    }

    return undefined;
}

function validateTrackUniqueness(tracks: CatalogTrack[]): void {
    const seen = new Set<string>();
    for (const track of tracks) {
        const key = `${track.namespace ?? ''}\0${track.name}`;
        if (seen.has(key)) {
            throw new Error(
                `Duplicate track name "${track.name}" in namespace ` +
                `"${track.namespace ?? '(inherited)'}" (§3.2.10)`,
            );
        }
        seen.add(key);
    }
}

function validateInitTrackRefs(tracks: CatalogTrack[]): void {
    const trackNames = new Set(tracks.map(t => t.name));
    for (const track of tracks) {
        if (track.initTrack && trackNames.has(track.initTrack)) {
            throw new Error(
                `initTrack "${track.initTrack}" on track "${track.name}" must not ` +
                `appear in the tracks array (§3.2.16)`,
            );
        }
    }
}

// ─── Patch path validation (§3.3) ─────────────────────────────────

/** Pattern matching /tracks/N/name or /tracks/N/namespace */
const FORBIDDEN_FIELD_RE = /^\/tracks\/\d+\/(name|namespace)(\/|$)/;

/** Pattern matching /tracks/N (whole-track replace) */
const WHOLE_TRACK_RE = /^\/tracks\/(\d+)$/;

/**
 * Pattern matching ANY path that could mutate inherited name or namespace.
 * Covers: /name, /namespace, /commonTrackFields/name, /commonTrackFields/namespace,
 * and /commonTrackFields itself (whole-object replace/remove could change name/ns inside).
 * These are TFC fields (§3.2.9, §3.2.10) — changes here affect all inheriting tracks.
 */
const INHERITED_NAME_NS_FIELD_RE = /^\/(commonTrackFields\/)?(name|namespace)$/;
const COMMON_TRACK_FIELDS_RE = /^\/commonTrackFields$/;

/**
 * Reject patch operations that directly target track name or namespace,
 * or that replace a whole track object (which could change name/namespace).
 *
 * §3.3: "Track namespaces and track names may not be changed across
 * patch updates."
 */
function rejectForbiddenPaths(
    ops: readonly { path?: string; op?: string; value?: unknown }[],
    previousRaw: Record<string, unknown>,
): void {
    const tracks = Array.isArray(previousRaw['tracks']) ? previousRaw['tracks'] as unknown[] : [];

    for (const op of ops) {
        if (!op.path) continue;

        // Block ANY op (add/replace/remove) on inherited name/namespace fields.
        // (§3.3: name and namespace are TFC — any mutation here changes
        // effective identity of all inheriting tracks. Removing an inherited
        // field exposes a lower inheritance layer, which is also a change.)
        if (INHERITED_NAME_NS_FIELD_RE.test(op.path)) {
            const match = INHERITED_NAME_NS_FIELD_RE.exec(op.path)!;
            const source = match[1] ? 'commonTrackFields' : 'root-level';
            throw new Error(
                `Patch operation "${op.op}" targets ${source} ${match[2]} at "${op.path}" ` +
                `— ${match[2]} changes via patch are prohibited (§3.3). ` +
                `Inherited ${match[2]} would change effective identity of all inheriting tracks.`,
            );
        }

        // Block replace/add/remove on /commonTrackFields as a whole object
        // when it would change the name or namespace inside.
        // (Replacing the entire object could smuggle in a different name/namespace.)
        if (COMMON_TRACK_FIELDS_RE.test(op.path)) {
            const prevCommon = (typeof previousRaw['commonTrackFields'] === 'object' &&
                previousRaw['commonTrackFields'] !== null &&
                !Array.isArray(previousRaw['commonTrackFields']))
                ? previousRaw['commonTrackFields'] as Record<string, unknown>
                : {};

            if (op.op === 'remove') {
                // Removing commonTrackFields drops inherited name/namespace
                if ('name' in prevCommon || 'namespace' in prevCommon) {
                    throw new Error(
                        `Patch removes /commonTrackFields which contains ` +
                        `${['name' in prevCommon ? 'name' : '', 'namespace' in prevCommon ? 'namespace' : ''].filter(Boolean).join(' and ')} ` +
                        `— removing inherited name/namespace is prohibited (§3.3).`,
                    );
                }
            } else if (op.op === 'replace' || op.op === 'add') {
                const newCommon = (typeof op.value === 'object' && op.value !== null && !Array.isArray(op.value))
                    ? op.value as Record<string, unknown>
                    : {};
                const prevName = prevCommon['name'];
                const newName = newCommon['name'];
                const prevNs = prevCommon['namespace'];
                const newNs = newCommon['namespace'];
                // Check if name changed (including added or removed)
                if (String(prevName ?? '') !== String(newName ?? '') ||
                    (('name' in prevCommon) !== ('name' in newCommon))) {
                    throw new Error(
                        `Patch ${op.op}s /commonTrackFields with different name ` +
                        `("${String(prevName ?? '')}" → "${String(newName ?? '')}") ` +
                        `— name changes via patch are prohibited (§3.3).`,
                    );
                }
                if (String(prevNs ?? '') !== String(newNs ?? '') ||
                    (('namespace' in prevCommon) !== ('namespace' in newCommon))) {
                    throw new Error(
                        `Patch ${op.op}s /commonTrackFields with different namespace ` +
                        `("${String(prevNs ?? '')}" → "${String(newNs ?? '')}") ` +
                        `— namespace changes via patch are prohibited (§3.3).`,
                    );
                }
            }
        }

        // Block direct /tracks/N/name or /tracks/N/namespace
        if (FORBIDDEN_FIELD_RE.test(op.path)) {
            const match = FORBIDDEN_FIELD_RE.exec(op.path)!;
            throw new Error(
                `Patch operation "${op.op}" targets ${match[1]} at "${op.path}" ` +
                `— ${match[1]} changes via patch are prohibited (§3.3). ` +
                `Remove the track and add a new one instead.`,
            );
        }

        // Block whole-track replace that changes name or namespace
        if (op.op === 'replace' && WHOLE_TRACK_RE.test(op.path)) {
            const idx = Number(WHOLE_TRACK_RE.exec(op.path)![1]);
            const existing = tracks[idx] as Record<string, unknown> | undefined;
            const replacement = op.value as Record<string, unknown> | undefined;
            if (existing && replacement) {
                if (String(existing['name'] ?? '') !== String(replacement['name'] ?? '')) {
                    throw new Error(
                        `Patch replaces whole track at ${op.path} with different name ` +
                        `("${String(existing['name'])}" → "${String(replacement['name'])}") ` +
                        `— name changes via patch are prohibited (§3.3). ` +
                        `Remove the track and add a new one instead.`,
                    );
                }
                const existingNs = existing['namespace'] ?? '';
                const replacementNs = replacement['namespace'] ?? '';
                if (String(existingNs) !== String(replacementNs)) {
                    throw new Error(
                        `Patch replaces whole track at ${op.path} with different namespace ` +
                        `("${String(existingNs)}" → "${String(replacementNs)}") ` +
                        `— namespace changes via patch are prohibited (§3.3). ` +
                        `Remove the track and add a new one instead.`,
                    );
                }
            }
        }
    }
}

// ─── Patch invariant validation (§3.3 / §3.3) ──────────────────

/** Selection-param field names on normalized CatalogTrack (flattened from selectionParams). */
const SELECTION_FIELDS: readonly (keyof CatalogTrack)[] = [
    'codec', 'mimeType', 'framerate', 'bitrate', 'width', 'height',
    'samplerate', 'channelConfig', 'displayWidth', 'displayHeight', 'lang',
] as const;

interface EffectiveSnapshot {
    name: string;
    namespace: string;
    /** Deterministic serialization of effective selection properties. */
    selectionJson: string;
}

/**
 * Build effective snapshots from NORMALIZED CatalogTrack[] (post-inheritance).
 * Keyed by namespace + '\0' + name so same-name tracks in different
 * namespaces are correctly distinguished (§3.2.10).
 */
function buildEffectiveSnapshots(
    tracks: readonly CatalogTrack[],
): Map<string, EffectiveSnapshot> {
    const result = new Map<string, EffectiveSnapshot>();
    for (const t of tracks) {
        const ns = t.namespace ?? '';
        const key = `${ns}\0${t.name}`;
        // Build a deterministic JSON of effective selection properties
        const sel: Record<string, unknown> = {};
        for (const f of SELECTION_FIELDS) {
            if (t[f] !== undefined) sel[f] = t[f];
        }
        result.set(key, {
            name: t.name,
            namespace: ns,
            selectionJson: JSON.stringify(sel, Object.keys(sel).sort()),
        });
    }
    return result;
}

/**
 * Validate that a patch did not violate:
 * - §3.3: track namespace MUST NOT be changed via patch
 *   (direct path changes caught by rejectForbiddenPaths; indirect
 *   changes via commonTrackFields caught here by comparing effective state)
 * - §3.3: selectionParams contents MUST NOT vary across updates
 *   (covers both direct track-level and indirect commonTrackFields changes)
 *
 * Comparison uses EFFECTIVE (post-inheritance) state from the normalizer,
 * not raw document fields. This catches changes via commonTrackFields
 * that bypass raw-document path checks.
 *
 * Matching is by namespace+name (not index position), so removing a
 * track at index 0 and shifting others is valid.
 */
function validatePatchInvariants(
    preEffective: Map<string, EffectiveSnapshot>,
    postEffective: Map<string, EffectiveSnapshot>,
): void {
    for (const [key, pre] of preEffective) {
        const post = postEffective.get(key);
        if (!post) continue; // Track was removed — that's fine

        // §3.3: effective selectionParams MUST NOT vary
        if (pre.selectionJson !== post.selectionJson) {
            throw new Error(
                `Patch changed effective selectionParams of track "${pre.name}" ` +
                `in namespace "${pre.namespace || '(none)'}" ` +
                `— selection property changes via patch are prohibited (§3.3). ` +
                `To change selection properties, remove the track and add with a different name.`,
            );
        }
    }

    // §3.3: Name changes via inherited fields (commonTrackFields/name, root /name)
    // are blocked by rejectForbiddenPaths() via INHERITED_NAME_NS_RE.
    // Effective-state comparison for name is not needed here — remove+add of
    // tracks with different names is a legitimate operation, and heuristic
    // detection of "renames" would produce false positives.

    // §3.3: detect effective namespace changes via commonTrackFields.
    // If a pre-track's key (ns+name) disappears but the same NAME appears
    // under a DIFFERENT namespace in post, AND that new-namespace track
    // did NOT exist pre-patch, it's an indirect namespace change.
    // (If the new-namespace track already existed pre-patch, the
    // disappearance is just a removal — not a rename.)
    const postByName = new Map<string, EffectiveSnapshot[]>();
    for (const snap of postEffective.values()) {
        const list = postByName.get(snap.name) ?? [];
        list.push(snap);
        postByName.set(snap.name, list);
    }

    for (const [key, pre] of preEffective) {
        if (postEffective.has(key)) continue; // Still there — fine
        // Pre-track disappeared. Check if same name exists under different ns
        // that wasn't there before (indicating a namespace change).
        const postMatches = postByName.get(pre.name);
        if (postMatches) {
            for (const post of postMatches) {
                if (post.namespace !== pre.namespace) {
                    const postKey = `${post.namespace}\0${post.name}`;
                    // Only flag if this post-track is NEW (not already in pre)
                    if (!preEffective.has(postKey)) {
                        throw new Error(
                            `Patch effectively changed namespace of track "${pre.name}" ` +
                            `from "${pre.namespace || '(none)'}" to "${post.namespace || '(none)'}" ` +
                            `(possibly via commonTrackFields) ` +
                            `— namespace changes via patch are prohibited (§3.3).`,
                        );
                    }
                }
            }
        }
    }
}
