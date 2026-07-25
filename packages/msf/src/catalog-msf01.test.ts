/**
 * MSF-01 / CMSF-01 catalog-parser tests (production).
 *
 * These exercise the catalog-DOCUMENT support: string/draft version
 * detection, the recognized MSF-01 root + track fields (trackDuration, depends,
 * template, initRef + root initDataList), the CMSF-01 protection metadata
 * (contentProtections + contentProtectionRefIDs), reference-topology validation
 * (dangling / duplicate ids and refIDs), and the preserved drop / opaque / finite
 * semantics. MSF-01 op-array deltas are intentionally NOT implemented here.
 *
 * @module
 */
import { describe, it, expect } from 'vitest';
import { parseCatalogAuto } from './catalog-detect.js';

const parse = (o: unknown): ReturnType<typeof parseCatalogAuto> =>
    parseCatalogAuto(JSON.stringify(o));

describe('MSF-01 — version detection (§5.1.1)', () => {
    it('accepts the numeric version 1 (legacy MSF-00 path, unchanged)', () => {
        expect(parse({ version: 1, tracks: [] }).version).toBe(1);
    });

    it('accepts the string version "1" (canonical MSF-01 spelling)', () => {
        expect(parse({ version: '1', tracks: [] }).version).toBe(1);
    });

    it('accepts the "draft-01" alias and normalizes it to version 1', () => {
        expect(parse({ version: 'draft-01', tracks: [] }).version).toBe(1);
    });

    it('rejects every other draft/version spelling with an unsupported-version error', () => {
        for (const v of ['draft-1', 'draft-00', 'draft-02', 'draft-99', 'draft-abc', '2', 'draft-1.0', '']) {
            expect(() => parse({ version: v, tracks: [] }), v).toThrow(/version/i);
        }
    });

    it('rejects the numeric version 2 (unsupported)', () => {
        expect(() => parse({ version: 2, tracks: [] })).toThrow(/version/i);
    });

    it('rejects a missing version', () => {
        expect(() => parse({ tracks: [] })).toThrow(/version/i);
    });
});

describe('MSF-01 — recognized root & track fields', () => {
    it('parses trackDuration on a VOD loc track (§5.2.35)', () => {
        const cat = parse({ version: '1', tracks: [{ name: 'm', packaging: 'loc', isLive: false, trackDuration: 8072340 }] });
        expect(cat.tracks[0]!.trackDuration).toBe(8072340);
        expect(cat.tracks[0]!.isLive).toBe(false);
    });

    it('parses depends as an array of track names (§5.2.14)', () => {
        const cat = parse({
            version: '1',
            tracks: [
                { name: 'a', packaging: 'loc', isLive: true },
                { name: 'b', packaging: 'loc', isLive: true },
                { name: 't', packaging: 'mediatimeline', isLive: true, mimeType: 'application/json', depends: ['a', 'b'] },
            ],
        });
        expect(cat.tracks[2]!.depends).toEqual(['a', 'b']);
    });

    it('parses the template 6-tuple, preserving the wide wallclock anchor as a number (§5.2.15)', () => {
        const cat = parse({ version: '1', tracks: [{ name: 'v', packaging: 'loc', isLive: true, template: [0, 2002, [0, 0], [1, 0], 1759924158381, 2002] }] });
        expect(cat.tracks[0]!.template).toEqual([0, 2002, [0, 0], [1, 0], 1759924158381, 2002]);
    });

    it('rejects a malformed template (wrong arity) rather than silently dropping it', () => {
        expect(() => parse({ version: '1', tracks: [{ name: 'v', packaging: 'loc', isLive: true, template: [0, 2002, [0, 0]] }] })).toThrow(/template/i);
    });

    it('rejects a template with a negative / non-integer element', () => {
        expect(() => parse({ version: '1', tracks: [{ name: 'v', packaging: 'loc', isLive: true, template: [0, 2002, [0, 0], [1, 0], -1, 2002] }] })).toThrow(/template/i);
        expect(() => parse({ version: '1', tracks: [{ name: 'v', packaging: 'loc', isLive: true, template: [0, 2002, [0, 0], [1, 0], 1.5, 2002] }] })).toThrow(/template/i);
    });

    it('parses publishTracks (§5.1.5) as an array of track objects', () => {
        const cat = parse({ version: '1', tracks: [], publishTracks: [{ name: 'up', packaging: 'loc', isLive: true }] });
        expect(cat.publishTracks?.[0]?.name).toBe('up');
    });
});

describe('MSF-01 — unknown / non-canonical fields (forward-compat drop)', () => {
    it('drops unrecognized root and track fields', () => {
        const cat = parse({ version: '1', futureRoot: 42, tracks: [{ name: 'v', packaging: 'loc', isLive: true, futureField: 'x' }] });
        expect('futureRoot' in cat).toBe(false);
        expect('futureField' in cat.tracks[0]!).toBe(false);
    });

    it('keeps the canonical "mimeType" and drops the lowercase "mimetype" misspelling as unknown (§5.2.19)', () => {
        const cat = parse({ version: '1', tracks: [{ name: 'v', packaging: 'loc', isLive: true, mimeType: 'video/mp4', mimetype: 'application/json' }] });
        expect(cat.tracks[0]!.mimeType).toBe('video/mp4');
        expect('mimetype' in cat.tracks[0]!).toBe(false);
    });
});

describe('MSF-01 — §7.2/§8.2 mimeType is relaxed for the STRING-version profile only', () => {
    // The relaxation exists so a mediatimeline whose only mime spelling is the
    // non-canonical lowercase "mimetype" (dropped as unknown) still parses — the
    // MSF-01 corpus oracle accepts it. It applies ONLY to the string-version
    // (MSF-01/CMSF-01) profile; the numeric MSF-00 path stays strict (§7.2 MUST).
    it('accepts an MSF-01 mediatimeline whose only mime spelling was the dropped lowercase "mimetype"', () => {
        const cat = parse({ version: '1', tracks: [{ name: 't', packaging: 'mediatimeline', isLive: true, depends: ['v'], mimetype: 'application/json' }] });
        expect(cat.tracks[0]!.packaging).toBe('mediatimeline');
        expect(cat.tracks[0]!.mimeType).toBeUndefined();
        expect('mimetype' in cat.tracks[0]!).toBe(false);
    });

    it('accepts an MSF-01 mediatimeline with a non-canonical mimeType', () => {
        const cat = parse({ version: '1', tracks: [{ name: 't', packaging: 'mediatimeline', isLive: true, depends: ['v'], mimeType: 'text/plain' }] });
        expect(cat.tracks[0]!.mimeType).toBe('text/plain');
    });

    it('accepts an MSF-01 eventtimeline with a non-canonical mimeType', () => {
        const cat = parse({ version: '1', tracks: [{ name: 'e', packaging: 'eventtimeline', isLive: true, eventType: 'scores', depends: ['v'], mimeType: 'text/xml' }] });
        expect(cat.tracks[0]!.mimeType).toBe('text/xml');
    });

    it('STILL rejects an MSF-01 mediatimeline / eventtimeline that has no depends (§7.2/§8.2)', () => {
        expect(() => parse({ version: '1', tracks: [{ name: 't', packaging: 'mediatimeline', isLive: true, mimeType: 'application/json' }] })).toThrow(/depends/i);
        expect(() => parse({ version: '1', tracks: [{ name: 'e', packaging: 'eventtimeline', isLive: true, eventType: 'x', mimeType: 'application/json' }] })).toThrow(/depends/i);
    });

    it('does NOT relax the numeric MSF-00 path: a numeric-version mediatimeline still requires mimeType="application/json" (§7.2)', () => {
        // depends present, but the canonical mimeType is absent / non-canonical.
        expect(() => parse({ version: 1, tracks: [{ name: 't', packaging: 'mediatimeline', isLive: true, depends: ['v'] }] })).toThrow(/mimeType/i);
        expect(() => parse({ version: 1, tracks: [{ name: 't', packaging: 'mediatimeline', isLive: true, depends: ['v'], mimeType: 'text/plain' }] })).toThrow(/mimeType/i);
        // eventtimeline likewise (§8.2).
        expect(() => parse({ version: 1, tracks: [{ name: 'e', packaging: 'eventtimeline', isLive: true, eventType: 'x', depends: ['v'], mimeType: 'text/xml' }] })).toThrow(/mimeType/i);
    });
});

describe('MSF-01 — initDataList / initRef reference topology (§5.1.7 / §5.2.13)', () => {
    it('accepts an initRef that resolves to a declared initDataList id', () => {
        const cat = parse({
            version: '1',
            tracks: [{ name: 'v', packaging: 'loc', isLive: true, initRef: 'i1' }],
            initDataList: [{ id: 'i1', type: 'inline', data: 'AAAB' }],
        });
        expect(cat.tracks[0]!.initRef).toBe('i1');
        expect(cat.initDataList).toEqual([{ id: 'i1', type: 'inline', data: 'AAAB' }]);
    });

    it('carries the init data blob verbatim as an OPAQUE string (never decoded)', () => {
        const cat = parse({ version: '1', tracks: [], initDataList: [{ id: 'i1', type: 'cenc', data: 'AAAAAn!!not-base64-decoded' }] });
        expect(cat.initDataList?.[0]?.data).toBe('AAAAAn!!not-base64-decoded');
    });

    it('rejects a dangling initRef (points at an unknown id)', () => {
        expect(() => parse({
            version: '1',
            tracks: [{ name: 'v', packaging: 'loc', isLive: true, initRef: 'missing' }],
            initDataList: [{ id: 'i1', type: 'inline', data: 'AAAB' }],
        })).toThrow(/dangling init reference|unknown initDataList/i);
    });

    it('rejects a duplicate initDataList id', () => {
        expect(() => parse({
            version: '1',
            tracks: [{ name: 'v', packaging: 'loc', isLive: true, initRef: 'i1' }],
            initDataList: [{ id: 'i1', type: 'inline', data: 'AAAB' }, { id: 'i1', type: 'inline', data: 'AAAC' }],
        })).toThrow(/Duplicate initDataList id/i);
    });
});

describe('CMSF-01 — contentProtections / contentProtectionRefIDs (§4.1)', () => {
    const withProtection = (refIDs: string[], protections: unknown[]): unknown => ({
        version: '1',
        tracks: [{ name: 'v', packaging: 'cmaf', isLive: true, initRef: 'i1', contentProtectionRefIDs: refIDs }],
        contentProtections: protections,
        initDataList: [{ id: 'i1', type: 'inline', data: 'AAAB' }],
    });
    const cp = (refID: string, systemID = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed'): unknown => ({
        refID, defaultKID: ['01234567-89ab-cdef-0123-456789abcdef'], scheme: 'cbcs',
        drmSystem: { systemID, laURL: { url: 'https://la.example/x' }, pssh: 'AAAB' },
    });

    it('parses content-protection metadata and preserves the nested drmSystem (opaque only)', () => {
        const cat = parse(withProtection(['1'], [cp('1')]));
        expect(cat.tracks[0]!.contentProtectionRefIDs).toEqual(['1']);
        const prot = cat.contentProtections![0]!;
        expect(prot.refID).toBe('1');
        expect(prot.scheme).toBe('cbcs');
        expect(prot.drmSystem.systemID).toBe('edef8ba9-79d6-4ace-a3c8-27dcd51d21ed');
        expect(prot.drmSystem.laURL?.url).toBe('https://la.example/x');
        // pssh is carried as OPAQUE metadata, never decoded.
        expect(prot.drmSystem.pssh).toBe('AAAB');
    });

    it('rejects a dangling contentProtectionRefIDs entry (unknown refID)', () => {
        expect(() => parse(withProtection(['missing'], [cp('1')])))
            .toThrow(/dangling content protection reference|unknown contentProtections/i);
    });

    it('rejects a duplicate contentProtections refID', () => {
        expect(() => parse(withProtection(['1'], [cp('1'), cp('1', '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b')])))
            .toThrow(/Duplicate contentProtections refID/i);
    });
});

describe('MSF-01 — numeric hardening is preserved', () => {
    it('rejects a non-finite numeric field (JSON overflow exponent) in an MSF-01 catalog', () => {
        expect(() => parseCatalogAuto('{"version":"1","generatedAt":1e999,"tracks":[]}')).toThrow(/finite/i);
    });
});
