/**
 * MSF-01 op-array delta parser tests (production).
 *
 * Cover the ordered add→clone / remove / unknown-op / illegal-root-field /
 * malformed-structure cases, the recognized-field reuse (unknown dropped,
 * lowercase mimetype dropped, present-only — no injected defaults), finite
 * hardening, and that the legacy MSF-00 grouped delta dialect is unaffected.
 *
 * @module
 */
import { describe, it, expect } from 'vitest';
import { parseMsf01Delta, applyMsf01Delta } from './catalog-delta-msf01.js';
import { parseDeltaUpdate } from './delta.js';
import type { CatalogState, Msf01Delta } from './types.js';

const parse = (o: unknown): ReturnType<typeof parseMsf01Delta> => parseMsf01Delta(JSON.stringify(o));

describe('MSF-01 op-array delta — ordered operations (§5.3)', () => {
    it('preserves add→clone document order (not collapsed into grouped fields)', () => {
        const d = parse({
            deltaUpdate: [
                { op: 'add', tracks: [{ name: 'a', packaging: 'loc', isLive: true }] },
                { op: 'clone', tracks: [{ parentName: 'a', name: 'b' }] },
            ],
        });
        expect(d.deltaUpdate.map((o) => o.op)).toEqual(['add', 'clone']); // ORDER is significant
        expect(d.deltaUpdate[0]!.tracks[0]).toEqual({ name: 'a', packaging: 'loc', isLive: true });
        expect(d.deltaUpdate[1]!.tracks[0]).toEqual({ name: 'b', parentName: 'a' });
    });

    it('parses a remove naming two tracks, in order', () => {
        const d = parse({ deltaUpdate: [{ op: 'remove', tracks: [{ name: 'video' }, { name: 'slides' }] }] });
        expect(d.deltaUpdate).toHaveLength(1);
        expect(d.deltaUpdate[0]!.op).toBe('remove');
        expect(d.deltaUpdate[0]!.tracks).toEqual([{ name: 'video' }, { name: 'slides' }]);
    });

    it('carries generatedAt when present', () => {
        expect(parse({ generatedAt: 1746104606044, deltaUpdate: [{ op: 'remove', tracks: [{ name: 'x' }] }] }).generatedAt).toBe(1746104606044);
    });

    it('preserves the clone parentNamespace and override fields', () => {
        const d = parse({ deltaUpdate: [{ op: 'clone', tracks: [{ parentName: 'v-1080', parentNamespace: 'example.com/custom', name: 'v-720', width: 1280 }] }] });
        expect(d.deltaUpdate[0]!.tracks[0]).toEqual({ name: 'v-720', parentName: 'v-1080', parentNamespace: 'example.com/custom', width: 1280 });
    });
});

describe('MSF-01 op-array delta — recognized-field reuse (present-only)', () => {
    it('injects NO packaging/isLive defaults for an op track that omits them', () => {
        const t = parse({ deltaUpdate: [{ op: 'add', tracks: [{ name: 'slides', role: 'video', bitrate: 750000 }] }] }).deltaUpdate[0]!.tracks[0]!;
        expect(t).toEqual({ name: 'slides', role: 'video', bitrate: 750000 });
        expect('packaging' in t).toBe(false);
        expect('isLive' in t).toBe(false);
    });

    it('drops unknown fields and the lowercase "mimetype" misspelling', () => {
        const t = parse({ deltaUpdate: [{ op: 'add', tracks: [{ name: 'v', packaging: 'loc', isLive: true, futureField: 'x', mimetype: 'application/json', mimeType: 'video/mp4' }] }] }).deltaUpdate[0]!.tracks[0]!;
        expect('futureField' in t).toBe(false);
        expect('mimetype' in t).toBe(false);
        expect(t.mimeType).toBe('video/mp4');
    });

    it('validates a template inside an op track (malformed rejected)', () => {
        expect(() => parse({ deltaUpdate: [{ op: 'add', tracks: [{ name: 'v', template: [0, 2002, [0, 0]] }] }] })).toThrow(/template/i);
    });
});

describe('MSF-01 op-array delta — rejections (§5.3)', () => {
    it('rejects an unknown op with unknown-delta-op wording', () => {
        expect(() => parse({ deltaUpdate: [{ op: 'replace', tracks: [{ name: 'a' }] }] })).toThrow(/unknown delta operation/i);
    });

    it('rejects an illegal root "version" field', () => {
        expect(() => parse({ deltaUpdate: [{ op: 'remove', tracks: [{ name: 'x' }] }], version: '1' })).toThrow(/illegal delta field.*version/i);
    });

    it('rejects an illegal root "tracks" field', () => {
        expect(() => parse({ deltaUpdate: [{ op: 'remove', tracks: [{ name: 'x' }] }], tracks: [] })).toThrow(/illegal delta field.*tracks/i);
    });

    it('rejects a non-array deltaUpdate', () => {
        expect(() => parse({ deltaUpdate: 'nope' })).toThrow(/deltaUpdate must be an array/i);
    });

    it('rejects an empty operation array', () => {
        expect(() => parse({ deltaUpdate: [] })).toThrow(/at least one operation/i);
    });

    it('rejects a non-object operation', () => {
        expect(() => parse({ deltaUpdate: ['nope'] })).toThrow(/operation must be a JSON object/i);
    });

    it('rejects an operation missing op', () => {
        expect(() => parse({ deltaUpdate: [{ tracks: [{ name: 'x' }] }] })).toThrow(/op is required/i);
    });

    it('rejects an operation whose tracks is not an array', () => {
        expect(() => parse({ deltaUpdate: [{ op: 'add', tracks: {} }] })).toThrow(/tracks is required and must be an array/i);
    });

    it('rejects an op track that is not an object, or is missing name', () => {
        expect(() => parse({ deltaUpdate: [{ op: 'add', tracks: ['x'] }] })).toThrow(/must be a JSON object/i);
        expect(() => parse({ deltaUpdate: [{ op: 'add', tracks: [{ packaging: 'loc' }] }] })).toThrow(/name is required/i);
    });

    it('rejects a non-object root', () => {
        expect(() => parseMsf01Delta('[]')).toThrow(/must be a JSON object/i);
    });
});

describe('MSF-01 op-array delta — numeric hardening', () => {
    it('rejects a non-finite generatedAt (JSON overflow exponent)', () => {
        expect(() => parseMsf01Delta('{"generatedAt":1e999,"deltaUpdate":[{"op":"remove","tracks":[{"name":"x"}]}]}')).toThrow(/finite/i);
    });

    it('rejects a non-finite op-track numeric field', () => {
        expect(() => parseMsf01Delta('{"deltaUpdate":[{"op":"add","tracks":[{"name":"v","bitrate":1e999}]}]}')).toThrow(/finite/i);
    });
});

describe('MSF-01 op-array delta — parse-layer scope is intentional (no base catalog)', () => {
    // These pin DELIBERATE parse-layer decisions: a delta is normalized without
    // consulting a base catalog, so reference targets and full add-track validity
    // are resolved by `applyCatalogUpdate`, not here. Changing any of these is a
    // behavior change, not a bug fix.
    it('does NOT run initRef reference validation (no root initDataList in a delta)', () => {
        const d = parse({ deltaUpdate: [{ op: 'add', tracks: [{ name: 'v', packaging: 'loc', isLive: true, initRef: 'i1' }] }] });
        expect(d.deltaUpdate[0]!.tracks[0]!.initRef).toBe('i1'); // accepted, not "dangling"
    });

    it('does NOT run contentProtectionRefIDs reference validation', () => {
        const d = parse({ deltaUpdate: [{ op: 'add', tracks: [{ name: 'v', contentProtectionRefIDs: ['1'] }] }] });
        expect(d.deltaUpdate[0]!.tracks[0]!.contentProtectionRefIDs).toEqual(['1']);
    });

    it('does NOT enforce full add-track required fields (packaging/isLive may be omitted)', () => {
        const d = parse({ deltaUpdate: [{ op: 'add', tracks: [{ name: 'v' }] }] });
        expect(d.deltaUpdate[0]!.tracks[0]).toEqual({ name: 'v' });
    });

    it('drops a root initDataList / contentProtections on a delta (only deltaUpdate + generatedAt are read)', () => {
        const d = parse({ deltaUpdate: [{ op: 'remove', tracks: [{ name: 'x' }] }], initDataList: [{ id: 'i1', type: 'inline', data: 'AAAB' }] });
        expect('initDataList' in d).toBe(false);
    });
});

describe('MSF-00 grouped delta dialect is unaffected by M2', () => {
    it('parseDeltaUpdate still parses the {deltaUpdate:true, addTracks:[…]} form', () => {
        const d = parseDeltaUpdate('{"deltaUpdate":true,"addTracks":[{"name":"new","packaging":"loc","isLive":true,"role":"video"}]}');
        expect(d.deltaUpdate).toBe(true);
        expect(d.addTracks?.[0]?.name).toBe('new');
    });

    it('the op-array parser rejects the MSF-00 boolean deltaUpdate sentinel', () => {
        // deltaUpdate:true is not the op-array dialect; routing keeps them distinct.
        expect(() => parseMsf01Delta('{"deltaUpdate":true,"addTracks":[]}')).toThrow(/deltaUpdate must be an array/i);
    });
});

// ─── applyMsf01Delta (stateful application) ───────────────────────────

const cmsfState = (): CatalogState => ({
    version: 1,
    generatedAt: 1000,
    tracks: [{ name: 'v1080', packaging: 'cmaf', isLive: true, role: 'video', codec: 'avc1.640028', initRef: 'i1', width: 1920, height: 1080 }],
    initDataList: [{ id: 'i1', type: 'inline', data: 'AAAB' }],
    contentProtections: [{ refID: '1', defaultKID: ['kid'], scheme: 'cbcs', drmSystem: { systemID: 'sys' } }],
    publishTracks: [{ name: 'up', packaging: 'loc', isLive: true }],
});
const apply = (state: CatalogState, doc: unknown, ns?: string): CatalogState =>
    applyMsf01Delta(state, parseMsf01Delta(JSON.stringify(doc)) as Msf01Delta, ns);

describe('applyMsf01Delta — ordered application (§5.3)', () => {
    it('add appends a track, materializing present-only defaults and inheriting namespace', () => {
        const st = apply(cmsfState(), { deltaUpdate: [{ op: 'add', tracks: [{ name: 'slides', role: 'video' }] }] }, 'ns');
        const added = st.tracks.find((t) => t.name === 'slides')!;
        expect(added.packaging).toBe('loc'); // default supplied at apply time
        expect(added.isLive).toBe(true);
        expect(added.namespace).toBe('ns'); // §5.1.10 inheritance
        expect(st.tracks).toHaveLength(2);
    });

    it('executes add→clone in order: a clone resolves a parent ADDED earlier in the same delta', () => {
        const st = apply(cmsfState(), {
            deltaUpdate: [
                { op: 'add', tracks: [{ name: 'a', packaging: 'loc', isLive: true, bitrate: 900 }] },
                { op: 'clone', tracks: [{ parentName: 'a', name: 'b', bitrate: 500 }] },
            ],
        });
        const b = st.tracks.find((t) => t.name === 'b')!;
        expect(b).toBeDefined();
        expect(b.packaging).toBe('loc'); // inherited from parent a
        expect(b.bitrate).toBe(500);     // override wins
        expect('parentName' in b).toBe(false); // clone-instruction field stripped
    });

    it('resolves a clone parent by parentName + parentNamespace', () => {
        const base = cmsfState();
        const st = apply(base, { deltaUpdate: [{ op: 'clone', tracks: [{ parentName: 'v1080', parentNamespace: undefined, name: 'v720', width: 1280, height: 720 }] }] });
        const c = st.tracks.find((t) => t.name === 'v720')!;
        expect(c.codec).toBe('avc1.640028'); // inherited
        expect(c.width).toBe(1280);          // override
        expect(c.initRef).toBe('i1');        // inherited → still resolves
    });

    it('rejects a clone whose parent does not exist in the current catalog', () => {
        expect(() => apply(cmsfState(), { deltaUpdate: [{ op: 'clone', tracks: [{ parentName: 'ghost', name: 'x' }] }] }))
            .toThrow(/parent track "ghost".*not found/i);
    });

    it('remove deletes the named track but keeps the root initDataList / contentProtections / publishTracks', () => {
        const st = apply(cmsfState(), { deltaUpdate: [{ op: 'remove', tracks: [{ name: 'v1080' }] }] });
        expect(st.tracks).toHaveLength(0);
        expect(st.initDataList).toEqual([{ id: 'i1', type: 'inline', data: 'AAAB' }]);
        expect(st.contentProtections).toHaveLength(1);
        expect(st.publishTracks).toHaveLength(1);
    });

    it('rejects removing a track that is not in the current catalog', () => {
        expect(() => apply(cmsfState(), { deltaUpdate: [{ op: 'remove', tracks: [{ name: 'ghost' }] }] }))
            .toThrow(/not found in the current catalog/i);
    });

    it('rejects an add whose name collides with an existing track', () => {
        expect(() => apply(cmsfState(), { deltaUpdate: [{ op: 'add', tracks: [{ name: 'v1080', packaging: 'cmaf', isLive: true }] }] }))
            .toThrow(/already exists/i);
    });

    it('applies a sequence add→remove of the SAME track (order matters) leaving it removed', () => {
        const st = apply(cmsfState(), {
            deltaUpdate: [
                { op: 'add', tracks: [{ name: 'tmp', packaging: 'loc', isLive: true }] },
                { op: 'remove', tracks: [{ name: 'tmp' }] },
            ],
        });
        expect(st.tracks.find((t) => t.name === 'tmp')).toBeUndefined();
        expect(st.tracks).toHaveLength(1);
    });
});

describe('applyMsf01Delta — reference integrity is re-validated against the result', () => {
    it('rejects a delta that adds a track with a dangling initRef', () => {
        expect(() => apply(cmsfState(), { deltaUpdate: [{ op: 'add', tracks: [{ name: 'bad', packaging: 'cmaf', isLive: true, initRef: 'missing' }] }] }))
            .toThrow(/initRef "missing".*unknown initDataList/i);
    });

    it('accepts a delta-added track whose initRef resolves against the preserved base initDataList', () => {
        const st = apply(cmsfState(), { deltaUpdate: [{ op: 'add', tracks: [{ name: 'v2', packaging: 'cmaf', isLive: true, codec: 'hvc1.1', initRef: 'i1' }] }] });
        expect(st.tracks.find((t) => t.name === 'v2')!.initRef).toBe('i1');
    });

    it('rejects a delta that adds a track with a dangling contentProtectionRefID', () => {
        expect(() => apply(cmsfState(), { deltaUpdate: [{ op: 'add', tracks: [{ name: 'bad', packaging: 'cmaf', isLive: true, contentProtectionRefIDs: ['99'] }] }] }))
            .toThrow(/contentProtectionRefIDs "99".*unknown contentProtections/i);
    });
});

describe('applyMsf01Delta — an MSF-00 base state stays clean', () => {
    it('an MSF-00 base (no root lists) applies an add with no injected root fields', () => {
        const st = apply({ version: 1, tracks: [{ name: 'v', packaging: 'loc', isLive: true }] },
            { deltaUpdate: [{ op: 'add', tracks: [{ name: 'a', packaging: 'loc', isLive: true }] }] });
        expect(st.tracks).toHaveLength(2);
        expect('initDataList' in st).toBe(false);
        expect('contentProtections' in st).toBe(false);
    });
});

// ─── Publisher round-trip: build CMSF-01 catalog → op-array clone delta ───
// Models the node-publisher example (--catalog-format cmsf-01 --emit-delta):
// the emitted catalog + delta bytes must parse and apply through @moqt/msf.

import { buildCatalog } from './catalog-builder.js';
import { parseCatalogAuto } from './catalog-detect.js';
import type { Catalog } from './types.js';

describe('publisher CMSF-01 catalog + op-array clone delta round-trips through @moqt/msf', () => {
    it('parses the built catalog and applies the emitted clone delta (clone inherits initRef)', () => {
        // 1. buildCatalog cmsf-01 shape (what buildFixtureCatalog emits).
        const catalogBytes = buildCatalog({
            version: '1',
            initDataList: [{ id: 'video-init', type: 'inline', data: 'AAAAGGZ0eXA=' }],
            tracks: [{ name: 'video', packaging: 'cmaf', isLive: true, role: 'video', codec: 'avc1.640028', renderGroup: 1, initRef: 'video-init' }],
        });
        const cat: Catalog = parseCatalogAuto(catalogBytes);
        const state = { ...cat, tracks: [...cat.tracks] };

        // 2. The emitted op-array delta (what buildFixtureDelta emits).
        const deltaBytes = new TextEncoder().encode(JSON.stringify({
            deltaUpdate: [{ op: 'clone', tracks: [{ parentName: 'video', name: 'video-alt', altGroup: 9 }] }],
        }));
        const delta = parseMsf01Delta(deltaBytes);
        expect(delta.deltaUpdate[0]!.op).toBe('clone');

        // 3. Apply: the clone appears, inherits the parent's initRef, resolves.
        const next = applyMsf01Delta(state, delta);
        const alt = next.tracks.find((t) => t.name === 'video-alt')!;
        expect(alt).toBeDefined();
        expect(alt.initRef).toBe('video-init'); // inherited → still resolvable
        expect(alt.altGroup).toBe(9);
        expect(next.initDataList).toHaveLength(1); // root list preserved
    });
});
