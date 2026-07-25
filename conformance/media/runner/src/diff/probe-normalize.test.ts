import { describe, it, expect } from 'vitest';
import { normalizeProbeResult, framerateFromMillis } from './probe-normalize.js';
import { normalizeCatalogVersion } from '../libmoq-import.js';

describe('probe-normalize — framerateMillis → exact decimal framerate', () => {
  it('divides by 1000 exactly (integer results)', () => {
    expect(framerateFromMillis('30000')).toBe('30');
    expect(framerateFromMillis('15000')).toBe('15');
    expect(framerateFromMillis('0')).toBe('0');
  });
  it('keeps fractional frame rates exact (no Number)', () => {
    expect(framerateFromMillis('29970')).toBe('29.97');
    expect(framerateFromMillis('23976')).toBe('23.976');
    expect(framerateFromMillis('1')).toBe('0.001');
  });
  it('stays exact for values beyond Number.MAX_SAFE_INTEGER', () => {
    expect(framerateFromMillis('9007199254740993000')).toBe('9007199254740993');
    expect(framerateFromMillis('18446744073709551615')).toBe('18446744073709551.615');
  });
  it('rejects a non-decimal-string millis value', () => {
    expect(() => framerateFromMillis(30 as unknown)).toThrow(/decimal string/);
    expect(() => framerateFromMillis('3.5')).toThrow(/decimal string/);
  });
});

describe('probe-normalize — catalog result', () => {
  it('renames version → catalogVersion and preserves other fields verbatim', () => {
    const r = normalizeProbeResult({ version: '1', generatedAt: '1700000000000', isComplete: true, tracks: [] }, 'catalog-parse');
    expect(r).toEqual({ catalogVersion: '1', generatedAt: '1700000000000', isComplete: true, tracks: [] });
  });

  it('draft-version: the probe pre-normalizes draft-01 to "1"; adapter and corpus rule agree', () => {
    // LibMoQ's typed parser maps both "1" and "draft-01" to version 1, so a
    // draft-01 catalog reaches the adapter already carrying version "1".
    const r = normalizeProbeResult({ version: '1', tracks: [] }, 'catalog-parse') as { catalogVersion: string };
    expect(r.catalogVersion).toBe('1');
    // …exactly the value the corpus's canonical normalization produces for "draft-01".
    expect(normalizeCatalogVersion('draft-01')).toBe('1');
  });

  it('reshapes a track template object → the corpus 6-tuple array', () => {
    const r = normalizeProbeResult({
      version: '1',
      tracks: [{ name: 'v', packaging: 'loc', isLive: true, template: {
        startMediaMs: '0', deltaMediaMs: '2002', startGroup: '0', startObject: '0',
        deltaGroup: '1', deltaObject: '0', startWallclockMs: '1759924158381', deltaWallclockMs: '2002',
      } }],
    }, 'catalog-parse') as { tracks: Array<Record<string, unknown>> };
    expect(r.tracks[0]!['template']).toEqual(['0', '2002', ['0', '0'], ['1', '0'], '1759924158381', '2002']);
  });

  it('preserves wide integers as strings and array order (depends)', () => {
    const r = normalizeProbeResult({
      version: '1',
      tracks: [{ name: 'v', packaging: 'loc', isLive: true, bitrate: '18446744073709551615', depends: ['a', 'b', 'c'] }],
    }, 'catalog-parse') as { tracks: Array<Record<string, unknown>> };
    expect(r.tracks[0]!['bitrate']).toBe('18446744073709551615');
    expect(r.tracks[0]!['depends']).toEqual(['a', 'b', 'c']);
  });

  it('preserves nested CMSF structures and maps authURL → authorizationURL', () => {
    const r = normalizeProbeResult({
      version: '1', tracks: [],
      initDataList: [{ id: 'i', type: 'inline', data: 'AAAB' }],
      contentProtections: [{ refID: '1', defaultKID: ['kid'], scheme: 'cbcs', drmSystem: {
        systemID: 's', laURL: { url: 'u', type: 'EME' }, authURL: { url: 'a' }, pssh: 'p', robustness: 'HW',
      } }],
    }, 'catalog-parse') as { contentProtections: Array<Record<string, unknown>>; initDataList: unknown };
    expect(r.initDataList).toEqual([{ id: 'i', type: 'inline', data: 'AAAB' }]);
    expect(r.contentProtections[0]!['drmSystem']).toEqual({
      systemID: 's', laURL: { url: 'u', type: 'EME' }, authorizationURL: { url: 'a' }, pssh: 'p', robustness: 'HW',
    });
  });

  it('omits absent fields (does not fabricate them)', () => {
    const r = normalizeProbeResult({ version: '1', tracks: [{ name: 'v', packaging: 'loc', isLive: true }] }, 'catalog-parse') as { tracks: Array<Record<string, unknown>> };
    expect(Object.keys(r.tracks[0]!).sort()).toEqual(['isLive', 'name', 'packaging']);
  });
});

describe('probe-normalize — delta result preserves operation order', () => {
  it('maps deltaUpdate ops in order and normalizes each op track', () => {
    const r = normalizeProbeResult({
      generatedAt: '42',
      deltaUpdate: [
        { op: 'add', tracks: [{ name: 'a', packaging: 'loc', isLive: true, framerateMillis: '15000' }] },
        { op: 'clone', tracks: [{ name: 'b', parentName: 'a' }] },
      ],
    }, 'catalog-delta-parse');
    expect(r).toEqual({
      generatedAt: '42',
      deltaUpdate: [
        { op: 'add', tracks: [{ name: 'a', packaging: 'loc', isLive: true, framerate: '15' }] },
        { op: 'clone', tracks: [{ name: 'b', parentName: 'a' }] },
      ],
    });
  });
});

describe('probe-normalize — strict: unknown probe fields are rejected', () => {
  it('rejects an unknown root field', () => {
    expect(() => normalizeProbeResult({ version: '1', tracks: [], somethingNew: 1 }, 'catalog-parse')).toThrow(/unrecognized probe field "somethingNew" in catalog result/);
  });
  it('rejects an unknown track field', () => {
    expect(() => normalizeProbeResult({ version: '1', tracks: [{ name: 'v', packaging: 'loc', isLive: true, futureField: 'x' }] }, 'catalog-parse')).toThrow(/unrecognized probe field "futureField" in track/);
  });
  it('rejects an unknown drmSystem field', () => {
    expect(() => normalizeProbeResult({ version: '1', tracks: [], contentProtections: [{ refID: '1', defaultKID: [], scheme: 'x', drmSystem: { systemID: 's', mystery: 1 } }] }, 'catalog-parse')).toThrow(/unrecognized probe field "mystery" in drmSystem/);
  });
  it('rejects an unknown template field', () => {
    expect(() => normalizeProbeResult({ version: '1', tracks: [{ name: 'v', packaging: 'loc', isLive: true, template: { startMediaMs: '0', extra: '1' } }] }, 'catalog-parse')).toThrow(/unrecognized probe field "extra" in template/);
  });
});
