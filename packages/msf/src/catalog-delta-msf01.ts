/**
 * MSF-01 op-array delta parsing (draft-ietf-moq-msf-01 §5.3).
 *
 * The MSF-01 delta dialect is an ORDERED array of operations:
 *   { "deltaUpdate": [ { "op": "add"|"remove"|"clone", "tracks": [...] }, ... ] }
 * distinct from the MSF-00 grouped-field delta ({ deltaUpdate:true, addTracks,
 * removeTracks, cloneTracks }) parsed by `parseDeltaUpdate`. The op array
 * preserves inter-operation document order, which the grouped form cannot.
 *
 * `parseMsf01Delta` is a PARSE-LAYER projection: op tracks are normalized to
 * their recognized fields (unknown dropped, lowercase `mimetype` dropped,
 * template validated, finite-number hardening applied) with NO base catalog
 * consulted. `applyMsf01Delta` is the STATEFUL counterpart (mirroring
 * `applyCatalogUpdate` for the MSF-00 dialect): it executes the operations in
 * document order against a `CatalogState`, resolving clone parents, preserving
 * the MSF-01/CMSF-01 root fields, and re-validating reference integrity.
 *
 * @see draft-ietf-moq-msf-01 §5.3
 * @module
 */

import { namespaceDisplay, referenceIdentityKey, resolveTrackNamespace, trackIdentityKey } from './track-identity.js';
import type { CatalogNamespaceContext } from './track-identity.js';
import type { CatalogTrack, CatalogState, Msf01Delta, Msf02Delta, Msf02DeltaOp, Msf02DeltaOpKind } from './types.js';
import { parseTrack, validateTargetLatencyConsistency, extractRecognizedOptionalFields, validateLocmafVersion, validateReferences } from './catalog-msf00.js';
import { assertFiniteMsf01Delta, assertFiniteCatalogNumbers } from './catalog-validate.js';

import { validateMsf02Encoding, validateMsf02Fields } from './catalog-msf02.js';
import { resolveTrackDependencies } from './selection.js';

const VALID_OPS = new Set<string>(['add', 'remove', 'clone']);

/**
 * Parse an MSF-01 op-array delta document.
 *
 * @throws {Error} malformed JSON / non-object root / illegal `version`/`tracks`
 *   root field / non-array `deltaUpdate` / malformed operation / unknown op /
 *   non-array op `tracks` / non-finite number.
 */
export function parseMsf01Delta(json: string | Uint8Array): Msf01Delta {
    return parseOpDelta(json) as Msf01Delta;
}

/** Parse MSF-02 §5.3; throws on invalid roots, operations, fields or encoding. */
export function parseMsf02Delta(json: string | Uint8Array): Msf02Delta {
    return parseOpDelta(json, 'draft-02') as Msf02Delta;
}

function parseOpDelta(json: string | Uint8Array, msfDraft?: 'draft-02'): Msf01Delta | Msf02Delta {
    const dialect = msfDraft ? 'MSF-02' : 'MSF-01';
    if (msfDraft) validateMsf02Encoding(json);
    const text = typeof json === 'string' ? json : new TextDecoder().decode(json);
    const raw: unknown = JSON.parse(text);

    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`${dialect} delta must be a JSON object (§5.3)`);
    }
    const obj = raw as Record<string, unknown>;

    if (msfDraft) {
        if (typeof obj['generatedAt'] !== 'number') throw new Error('MSF-02 generatedAt is required (§5.3)');
        for (const field of ['isComplete', 'publishTracks', 'initDataList', 'contentProtections']) {
            if (field in obj) throw new Error(`Illegal MSF-02 delta root field "${field}" (§5.3)`);
        }
    }
    // §5.3: a delta MUST NOT carry an independent catalog `version` or `tracks`
    // field — those belong to a full catalog, never a delta.
    if ('version' in obj) {
        throw new Error(`illegal delta field "version": an ${dialect} delta MUST NOT contain a version field (§5.3)`);
    }
    if ('tracks' in obj) {
        throw new Error(`illegal delta field "tracks": an ${dialect} delta MUST NOT contain an independent tracks field (§5.3)`);
    }

    if (!Array.isArray(obj['deltaUpdate'])) {
        throw new Error('deltaUpdate must be an array of operations (§5.3)');
    }
    if ((obj['deltaUpdate'] as unknown[]).length === 0) {
        throw new Error('deltaUpdate must contain at least one operation (§5.3)');
    }

    const deltaUpdate = (obj['deltaUpdate'] as unknown[]).map((op, i) => parseOp(op, i, msfDraft));

    const delta = {
        ...(typeof obj['generatedAt'] === 'number' ? { generatedAt: obj['generatedAt'] } : {}),
        deltaUpdate,
    } as Msf01Delta | Msf02Delta;

    // A JSON overflow exponent (1e999 → Infinity) is accepted by typeof === 'number';
    // reject the delta before returning it, on the same contract as a catalog.
    assertFiniteMsf01Delta(delta, msfDraft);
    return delta;
}

/** Parse a single delta operation ({ op, tracks }). */
function parseOp(raw: unknown, index: number, msfDraft?: 'draft-02'): Msf02DeltaOp {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`deltaUpdate[${index}] operation must be a JSON object (§5.3)`);
    }
    const o = raw as Record<string, unknown>;

    const op = o['op'];
    if (typeof op !== 'string') {
        throw new Error(`deltaUpdate[${index}]: op is required and must be a string (§5.3)`);
    }
    if (!VALID_OPS.has(op) && !(msfDraft && op === 'update')) {
        throw new Error(`unknown delta operation "${op}"; expected one of add, remove, clone${msfDraft ? ', update' : ''} (§5.3)`);
    }
    if (!Array.isArray(o['tracks'])) {
        throw new Error(`deltaUpdate[${index}]: tracks is required and must be an array (§5.3)`);
    }

    const tracks = (o['tracks'] as unknown[]).map((t, j) => parseOpTrack(t, index, j, msfDraft, op));
    return { op: op as Msf02DeltaOpKind, tracks };
}

/**
 * Parse a single op track into a PARTIAL track: recognized fields present-only,
 * no defaults injected (an `add` may omit packaging/isLive, a `remove` carries
 * only a name, a `clone` carries parentName/parentNamespace). Unknown fields are
 * dropped, the lowercase `mimetype` misspelling stays unknown, and the template
 * is validated — all via the shared M1 field extractor.
 */
function parseOpTrack(raw: unknown, opIndex: number, trackIndex: number, msfDraft?: 'draft-02', op?: string): Partial<CatalogTrack> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`deltaUpdate[${opIndex}].tracks[${trackIndex}] must be a JSON object (§5.3)`);
    }
    const obj = raw as Record<string, unknown>;

    if (msfDraft) {
        validateMsf02Fields(obj, true);
        if (op === 'remove' && Object.keys(obj).some(k => k !== 'name' && k !== 'namespace')) {
            throw new Error('MSF-02 remove permits only name and namespace (§5.1.6)');
        }
        if ((op === 'clone' || op === 'update') && typeof obj['parentName'] !== 'string') {
            throw new Error('MSF-02 clone/update requires parentName (§5.1.6)');
        }
        if (op === 'add' && ('parentName' in obj || 'parentNamespace' in obj)) {
            throw new Error('MSF-02 parent fields require clone/update (§5.2.34–35)');
        }
        if (op === 'add') parseTrack(obj, trackIndex, undefined, false, msfDraft);
    }
    if (!(msfDraft && op === 'update') && typeof obj['name'] !== 'string') {
        throw new Error(`deltaUpdate[${opIndex}].tracks[${trackIndex}]: name is required and must be a string (§5.3)`);
    }

    return {
        ...(typeof obj['name'] === 'string' ? { name: obj['name'] } : {}),
        // Identity / clone-context fields carried PRESENT-ONLY (no defaults). An
        // op-track packaging is kept verbatim (not enum-restricted) to mirror the
        // projection contract — the base catalog owns full-track validation.
        ...(typeof obj['packaging'] === 'string' ? { packaging: obj['packaging'] as CatalogTrack['packaging'] } : {}),
        ...(typeof obj['isLive'] === 'boolean' ? { isLive: obj['isLive'] } : {}),
        ...(typeof obj['namespace'] === 'string' ? { namespace: obj['namespace'] } : {}),
        ...(typeof obj['parentName'] === 'string' ? { parentName: obj['parentName'] } : {}),
        ...(typeof obj['parentNamespace'] === 'string' ? { parentNamespace: obj['parentNamespace'] } : {}),
        ...extractRecognizedOptionalFields(obj, String(obj['name'] ?? obj['parentName']), msfDraft),
    };
}

// ─── Application (stateful) ───────────────────────────────────────────

/** Namespace-qualified track identity (§5.1.11), on resolved wire fields. */
function trackKey(t: Parameters<typeof trackIdentityKey>[0]): string {
    return trackIdentityKey(t);
}

/**
 * Materialize an `add` op track (a present-only partial) into a full track:
 * supply the MSF-00 defaults for the required triple and inherit the catalog
 * namespace (§5.1.10) when the track omits one.
 */
function materializeAddTrack(
    t: Partial<CatalogTrack>, catalogNamespace?: CatalogNamespaceContext,
): CatalogTrack {
    const track = {
        ...t,
        name: t.name!,
        packaging: t.packaging ?? 'loc',
        isLive: t.isLive ?? true,
    } as CatalogTrack;
    // Resolution is computed here, never carried from the operation's JSON:
    // a delta entry declares `namespace` text at most.
    const resolvedNamespace = resolveTrackNamespace(track.namespace, catalogNamespace);
    const inheritedText = track.namespace ?? (typeof catalogNamespace === 'string'
        ? catalogNamespace
        : resolvedNamespace !== undefined ? namespaceDisplay(resolvedNamespace.fields) : undefined);
    return {
        ...track,
        ...(inheritedText !== undefined ? { namespace: inheritedText } : {}),
        ...(resolvedNamespace !== undefined ? { resolvedNamespace } : {}),
    };
}

/**
 * Resolve a `clone` op against the CURRENT (in-progress) track list — so an
 * `add` earlier in the same delta can be a clone parent — then inherit the
 * parent's attributes and apply the clone's overrides. The clone-instruction
 * fields (parentName/parentNamespace) are stripped from the resulting track.
 */
function applyCloneOp(
    t: Partial<CatalogTrack>, tracks: readonly CatalogTrack[],
    catalogNamespace?: CatalogNamespaceContext,
): CatalogTrack {
    const parentName = t.parentName;
    if (parentName === undefined) {
        throw new Error(`Clone operation for track "${t.name ?? ''}" requires parentName (§5.3)`);
    }
    // §5.2.34: "If this field is missing from a clone operation, then the
    // namespace of the catalog is assumed." Matching any same-name track
    // instead would clone whichever one happened to come first.
    const parentKey = referenceIdentityKey(
        { name: parentName, ...(t.parentNamespace !== undefined ? { namespace: t.parentNamespace } : {}) },
        catalogNamespace);
    const parent = tracks.find((x) => trackKey(x) === parentKey);
    if (!parent) {
        const ns = t.parentNamespace !== undefined ? ` in namespace "${t.parentNamespace}"` : '';
        throw new Error(`Cannot clone track "${t.name ?? ''}": parent track "${parentName}"${ns} not found in the current catalog (§5.3)`);
    }
    const { parentName: _pn, parentNamespace: _pns, ...overrides } = t;
    const cloned = { ...parent, ...overrides, name: t.name! } as CatalogTrack;
    // A clone that DECLARES its own namespace must not keep the parent's
    // resolution: the spread would carry wire fields describing a namespace
    // this track no longer claims. One that declares none inherits the
    // parent's attributes, resolution included, which is the same namespace.
    if (overrides.namespace !== undefined) {
        const resolvedNamespace = resolveTrackNamespace(overrides.namespace, catalogNamespace);
        const { resolvedNamespace: _stale, ...withoutParentResolution } = cloned;
        return {
            ...withoutParentResolution,
            ...(resolvedNamespace !== undefined ? { resolvedNamespace } : {}),
        };
    }
    if (cloned.namespace === undefined) {
        const resolvedNamespace = resolveTrackNamespace(undefined, catalogNamespace);
        const inheritedText = typeof catalogNamespace === 'string'
            ? catalogNamespace
            : resolvedNamespace !== undefined ? namespaceDisplay(resolvedNamespace.fields) : undefined;
        return {
            ...cloned,
            ...(inheritedText !== undefined ? { namespace: inheritedText } : {}),
            ...(resolvedNamespace !== undefined ? { resolvedNamespace } : {}),
        };
    }
    return cloned;
}

/**
 * Apply an MSF-01 op-array delta to a catalog state.
 *
 * Operations execute in document ORDER (§5.3): add/remove/clone are applied
 * sequentially, so a clone can reference a parent added earlier in the same
 * delta. The MSF-01/CMSF-01 root fields (initDataList/contentProtections/
 * publishTracks) carry forward unchanged — the op-array dialect mutates only the
 * track list. After all operations apply, finite-number hardening and reference
 * integrity (initRef → initDataList, contentProtectionRefIDs → contentProtections)
 * are re-validated against the resulting state, so a delta that introduces a
 * dangling reference rejects the whole update.
 *
 * @throws {Error} clone parent not found / duplicate add or clone name / removed
 *   track not found / dangling reference / non-finite number.
 * @see draft-ietf-moq-msf-01 §5.3
 */
export function applyMsf01Delta(
    state: CatalogState,
    delta: Msf01Delta,
    catalogNamespace?: CatalogNamespaceContext,
): CatalogState {
    return applyOpDelta(state, delta, catalogNamespace);
}

/** Apply MSF-02 operations atomically; the base and its tracks remain unchanged on failure. */
export function applyMsf02Delta(state: CatalogState, delta: Msf02Delta, catalogNamespace?: CatalogNamespaceContext): CatalogState {
    if (state.msfDraft !== 'draft-02') throw new Error('MSF-02 delta requires a draft-02 base');
    return applyOpDelta(state, delta, catalogNamespace, 'draft-02');
}

function applyOpDelta(state: CatalogState, delta: Msf01Delta | Msf02Delta,
    catalogNamespace?: CatalogNamespaceContext, msfDraft?: 'draft-02'): CatalogState {
    let tracks: CatalogTrack[] = [...state.tracks];

    for (const op of delta.deltaUpdate) {
        if (op.op === 'add') {
            for (const raw of op.tracks) {
                const track = msfDraft ? parseTrack({ ...raw,
                    ...(raw.packagingMetadata ? { packagingMetadata: Object.entries(raw.packagingMetadata)
                        .map(([key, value]) => `${key}=${value}`).join(';') } : {}),
                }, 0, catalogNamespace, false, msfDraft)
                    : materializeAddTrack(raw, catalogNamespace);
                if (tracks.some((x) => trackKey(x) === trackKey(track))) {
                    throw new Error(`Cannot add track "${track.name}" in namespace "${track.namespace ?? ''}": track already exists (§5.1.11)`);
                }
                tracks.push(track);
            }
        } else if (op.op === 'remove') {
            for (const raw of op.tracks) {
                const ns = raw.namespace ?? (typeof catalogNamespace === 'string' ? catalogNamespace : '');
                const key = referenceIdentityKey(
                    { name: raw.name!, ...(raw.namespace !== undefined ? { namespace: raw.namespace } : {}) },
                    catalogNamespace);
                if (!tracks.some((x) => trackKey(x) === key)) {
                    throw new Error(`Cannot remove track "${raw.name}" in namespace "${ns}": track not found in the current catalog (§5.3)`);
                }
                tracks = tracks.filter((x) => trackKey(x) !== key);
            }
        } else if (msfDraft && op.op === 'update') {
            for (const raw of op.tracks) {
                const key = referenceIdentityKey({ name: raw.parentName!,
                    ...(raw.parentNamespace !== undefined ? { namespace: raw.parentNamespace } : {}) }, catalogNamespace);
                const index = tracks.findIndex(t => trackKey(t) === key);
                const parent = tracks[index];
                if (!parent) throw new Error('MSF-02 update parent not found (§5.3)');
                if ((raw.name !== undefined && raw.name !== parent.name)
                    || (raw.namespace !== undefined && referenceIdentityKey({ name: parent.name, namespace: raw.namespace }, catalogNamespace) !== key)) {
                    throw new Error('MSF-02 update must not rename a track (§5.1.6)');
                }
                if (!parent.isLive && raw.isLive === true) throw new Error('MSF-02 isLive cannot become true after false (§5.2.8)');
                const { parentName: _pn, parentNamespace: _pns, ...fields } = raw;
                tracks[index] = { ...parent, ...fields };
            }
        } else {
            for (const raw of op.tracks) {
                const cloned = applyCloneOp(raw, tracks, catalogNamespace);
                if (tracks.some((x) => trackKey(x) === trackKey(cloned))) {
                    throw new Error(`Cannot clone track "${cloned.name}" in namespace "${cloned.namespace ?? ''}": track already exists (§5.1.11)`);
                }
                tracks.push(cloned);
            }
        }
    }

    if (msfDraft) {
        tracks = tracks.map(t => {
            // Validate with the shared parser, preserving the resolved namespace's provenance.
            const { namespace, resolvedNamespace, packagingMetadata, ...fields } = t;
            const parsed = parseTrack({ ...fields,
                ...(resolvedNamespace?.source === 'inherited' ? {} : namespace !== undefined ? { namespace } : {}),
                ...(packagingMetadata ? { packagingMetadata: Object.entries(packagingMetadata).map(([k, v]) => `${k}=${v}`).join(';') } : {}),
            }, 0, resolvedNamespace?.fields ?? catalogNamespace, false, msfDraft);
            return { ...parsed, ...(resolvedNamespace ? { resolvedNamespace } : {}) };
        });
        validateTargetLatencyConsistency(tracks);
        for (const track of tracks) resolveTrackDependencies(track, tracks, { msfDraft });
    }
    const generatedAt = delta.generatedAt ?? state.generatedAt;
    const next: CatalogState = {
        version: state.version,
        ...(msfDraft ? { msfDraft } : {}),
        tracks,
        ...(generatedAt !== undefined ? { generatedAt } : {}),
        ...(state.isComplete !== undefined ? { isComplete: state.isComplete } : {}),
        ...(state.initDataList !== undefined ? { initDataList: state.initDataList } : {}),
        ...(state.contentProtections !== undefined ? { contentProtections: state.contentProtections } : {}),
        ...(state.publishTracks !== undefined ? { publishTracks: state.publishTracks } : {}),
    };

    assertFiniteCatalogNumbers(next);
    validateReferences(next);
    // LOCMAF §5: an add may omit locmafVersion and a clone may change packaging
    // while inheriting it — re-check the presence rule on the applied state.
    for (const t of next.tracks) validateLocmafVersion(t);
    return next;
}
