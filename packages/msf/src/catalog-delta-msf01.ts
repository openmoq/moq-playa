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

import type { CatalogTrack, CatalogState, Msf01Delta, Msf01DeltaOp, Msf01DeltaOpKind } from './types.js';
import { extractRecognizedOptionalFields, validateReferences } from './catalog-msf00.js';
import { assertFiniteMsf01Delta, assertFiniteCatalogNumbers } from './catalog-validate.js';

const VALID_OPS = new Set<string>(['add', 'remove', 'clone']);

/**
 * Parse an MSF-01 op-array delta document.
 *
 * @throws {Error} malformed JSON / non-object root / illegal `version`/`tracks`
 *   root field / non-array `deltaUpdate` / malformed operation / unknown op /
 *   non-array op `tracks` / non-finite number.
 */
export function parseMsf01Delta(json: string | Uint8Array): Msf01Delta {
    const text = typeof json === 'string' ? json : new TextDecoder().decode(json);
    const raw: unknown = JSON.parse(text);

    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('MSF-01 delta must be a JSON object (§5.3)');
    }
    const obj = raw as Record<string, unknown>;

    // §5.3: a delta MUST NOT carry an independent catalog `version` or `tracks`
    // field — those belong to a full catalog, never a delta.
    if ('version' in obj) {
        throw new Error('illegal delta field "version": an MSF-01 delta MUST NOT contain a version field (§5.3)');
    }
    if ('tracks' in obj) {
        throw new Error('illegal delta field "tracks": an MSF-01 delta MUST NOT contain an independent tracks field (§5.3)');
    }

    if (!Array.isArray(obj['deltaUpdate'])) {
        throw new Error('deltaUpdate must be an array of operations (§5.3)');
    }
    if ((obj['deltaUpdate'] as unknown[]).length === 0) {
        throw new Error('deltaUpdate must contain at least one operation (§5.3)');
    }

    const deltaUpdate = (obj['deltaUpdate'] as unknown[]).map((op, i) => parseOp(op, i));

    const delta: Msf01Delta = {
        ...(typeof obj['generatedAt'] === 'number' ? { generatedAt: obj['generatedAt'] } : {}),
        deltaUpdate,
    };

    // A JSON overflow exponent (1e999 → Infinity) is accepted by typeof === 'number';
    // reject the delta before returning it, on the same contract as a catalog.
    assertFiniteMsf01Delta(delta);
    return delta;
}

/** Parse a single delta operation ({ op, tracks }). */
function parseOp(raw: unknown, index: number): Msf01DeltaOp {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`deltaUpdate[${index}] operation must be a JSON object (§5.3)`);
    }
    const o = raw as Record<string, unknown>;

    const op = o['op'];
    if (typeof op !== 'string') {
        throw new Error(`deltaUpdate[${index}]: op is required and must be a string (§5.3)`);
    }
    if (!VALID_OPS.has(op)) {
        throw new Error(`unknown delta operation "${op}"; expected one of add, remove, clone (§5.3)`);
    }
    if (!Array.isArray(o['tracks'])) {
        throw new Error(`deltaUpdate[${index}]: tracks is required and must be an array (§5.3)`);
    }

    const tracks = (o['tracks'] as unknown[]).map((t, j) => parseOpTrack(t, index, j));
    return { op: op as Msf01DeltaOpKind, tracks };
}

/**
 * Parse a single op track into a PARTIAL track: recognized fields present-only,
 * no defaults injected (an `add` may omit packaging/isLive, a `remove` carries
 * only a name, a `clone` carries parentName/parentNamespace). Unknown fields are
 * dropped, the lowercase `mimetype` misspelling stays unknown, and the template
 * is validated — all via the shared M1 field extractor.
 */
function parseOpTrack(raw: unknown, opIndex: number, trackIndex: number): Partial<CatalogTrack> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`deltaUpdate[${opIndex}].tracks[${trackIndex}] must be a JSON object (§5.3)`);
    }
    const obj = raw as Record<string, unknown>;

    if (typeof obj['name'] !== 'string') {
        throw new Error(`deltaUpdate[${opIndex}].tracks[${trackIndex}]: name is required and must be a string (§5.3)`);
    }

    return {
        name: obj['name'],
        // Identity / clone-context fields carried PRESENT-ONLY (no defaults). An
        // op-track packaging is kept verbatim (not enum-restricted) to mirror the
        // projection contract — the base catalog owns full-track validation.
        ...(typeof obj['packaging'] === 'string' ? { packaging: obj['packaging'] as CatalogTrack['packaging'] } : {}),
        ...(typeof obj['isLive'] === 'boolean' ? { isLive: obj['isLive'] } : {}),
        ...(typeof obj['namespace'] === 'string' ? { namespace: obj['namespace'] } : {}),
        ...(typeof obj['parentName'] === 'string' ? { parentName: obj['parentName'] } : {}),
        ...(typeof obj['parentNamespace'] === 'string' ? { parentNamespace: obj['parentNamespace'] } : {}),
        ...extractRecognizedOptionalFields(obj, obj['name']),
    };
}

// ─── Application (stateful) ───────────────────────────────────────────

/** Namespace-qualified track identity (§5.1.11). */
function trackKey(t: { readonly name: string; readonly namespace?: string }): string {
    return `${t.namespace ?? ''}\0${t.name}`;
}

/**
 * Materialize an `add` op track (a present-only partial) into a full track:
 * supply the MSF-00 defaults for the required triple and inherit the catalog
 * namespace (§5.1.10) when the track omits one.
 */
function materializeAddTrack(t: Partial<CatalogTrack>, catalogNamespace?: string): CatalogTrack {
    const track = {
        ...t,
        name: t.name!,
        packaging: t.packaging ?? 'loc',
        isLive: t.isLive ?? true,
    } as CatalogTrack;
    if (track.namespace === undefined && catalogNamespace !== undefined) {
        return { ...track, namespace: catalogNamespace };
    }
    return track;
}

/**
 * Resolve a `clone` op against the CURRENT (in-progress) track list — so an
 * `add` earlier in the same delta can be a clone parent — then inherit the
 * parent's attributes and apply the clone's overrides. The clone-instruction
 * fields (parentName/parentNamespace) are stripped from the resulting track.
 */
function applyCloneOp(t: Partial<CatalogTrack>, tracks: readonly CatalogTrack[], catalogNamespace?: string): CatalogTrack {
    const parentName = t.parentName;
    if (parentName === undefined) {
        throw new Error(`Clone operation for track "${t.name ?? ''}" requires parentName (§5.3)`);
    }
    const parent = tracks.find((x) => x.name === parentName
        && (t.parentNamespace === undefined || x.namespace === t.parentNamespace));
    if (!parent) {
        const ns = t.parentNamespace !== undefined ? ` in namespace "${t.parentNamespace}"` : '';
        throw new Error(`Cannot clone track "${t.name ?? ''}": parent track "${parentName}"${ns} not found in the current catalog (§5.3)`);
    }
    const { parentName: _pn, parentNamespace: _pns, ...overrides } = t;
    const cloned = { ...parent, ...overrides, name: t.name! } as CatalogTrack;
    if (cloned.namespace === undefined && catalogNamespace !== undefined) {
        return { ...cloned, namespace: catalogNamespace };
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
    catalogNamespace?: string,
): CatalogState {
    let tracks: CatalogTrack[] = [...state.tracks];

    for (const op of delta.deltaUpdate) {
        if (op.op === 'add') {
            for (const raw of op.tracks) {
                const track = materializeAddTrack(raw, catalogNamespace);
                if (tracks.some((x) => trackKey(x) === trackKey(track))) {
                    throw new Error(`Cannot add track "${track.name}" in namespace "${track.namespace ?? ''}": track already exists (§5.1.11)`);
                }
                tracks.push(track);
            }
        } else if (op.op === 'remove') {
            for (const raw of op.tracks) {
                const ns = raw.namespace ?? catalogNamespace ?? '';
                const key = `${ns}\0${raw.name!}`;
                if (!tracks.some((x) => trackKey(x) === key)) {
                    throw new Error(`Cannot remove track "${raw.name}" in namespace "${ns}": track not found in the current catalog (§5.3)`);
                }
                tracks = tracks.filter((x) => trackKey(x) !== key);
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

    const generatedAt = delta.generatedAt ?? state.generatedAt;
    const next: CatalogState = {
        version: state.version,
        tracks,
        ...(generatedAt !== undefined ? { generatedAt } : {}),
        ...(state.isComplete !== undefined ? { isComplete: state.isComplete } : {}),
        ...(state.initDataList !== undefined ? { initDataList: state.initDataList } : {}),
        ...(state.contentProtections !== undefined ? { contentProtections: state.contentProtections } : {}),
        ...(state.publishTracks !== undefined ? { publishTracks: state.publishTracks } : {}),
    };

    assertFiniteCatalogNumbers(next);
    validateReferences(next);
    return next;
}
