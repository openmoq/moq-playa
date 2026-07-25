import { describe, it, expect } from 'vitest';
import { validateEntry, validateManifest } from './validate.js';
import type { CorpusEntry } from './schema-types.js';

const SHA = 'a'.repeat(64);

function validDecodeEntry(): CorpusEntry {
  return {
    id: 'properties/basic',
    kind: 'property-block-decode',
    profile: 'transport-18',
    wireProfile: 'd18-delta-vi64',
    description: 'a decode vector',
    input: { file: 'basic.bin', byteLength: 2, sha256: SHA, hex: '062a' },
    expect: { status: 'ok', stage: 'decode', semantics: { properties: [] } },
    expectationBasis: 'normative',
    provenance: { class: 'spec-derived', source: 's', section: '1.4', generator: 'hand-authored', generatorVersion: 'n/a', command: 'n/a', sourceHash: 'a'.repeat(64) },
  };
}

describe('validateEntry — happy path', () => {
  it('accepts a well-formed decode entry', () => {
    expect(validateEntry(validDecodeEntry())).toEqual([]);
  });

  it('accepts an encode entry with a propertyMap input and bytesHex output', () => {
    const e: CorpusEntry = {
      ...validDecodeEntry(),
      id: 'properties/enc',
      input: { propertyMap: [{ id: '2', valueKind: 'varint', value: '42' }] },
      expect: { status: 'ok', stage: 'encode', bytesHex: '022a' },
    };
    expect(validateEntry(e)).toEqual([]);
  });
});

describe('validateEntry — discriminating failures', () => {
  const cases: Array<[string, (e: CorpusEntry) => unknown, RegExp]> = [
    ['bad id slug', (e) => ({ ...e, id: 'NotASlug' }), /stable slug/],
    ['unknown kind', (e) => ({ ...e, kind: 'nope' }), /kind/],
    ['missing wireProfile on property kind', (e) => { const c = { ...e } as Record<string, unknown>; delete c['wireProfile']; return c; }, /wireProfile/],
    ['scope on a non-loc kind', (e) => ({ ...e, scope: 'track' }), /scope/],
    ['unknown expectationBasis', (e) => ({ ...e, expectationBasis: 'guess' }), /expectationBasis/],
    ['unknown error category', (e) => ({ ...e, expect: { status: 'error', stage: 'decode', error: { category: 'made-up' } } }), /error category/],
    ['ok without semantics', (e) => ({ ...e, expect: { status: 'ok', stage: 'decode' } }), /semantics/],
    ['unsorted diagnostics', (e) => ({ ...e, expect: { ...e.expect, diagnostics: ['b', 'a'] } }), /sorted/],
    ['both file and propertyMap', (e) => ({ ...e, input: { file: 'x.bin', byteLength: 1, sha256: SHA, propertyMap: [] } }), /exactly one/],
    ['path escape in file', (e) => ({ ...e, input: { file: '../evil.bin', byteLength: 2, sha256: SHA, hex: '062a' } }), /".." or absolute/],
    ['short bin without hex', (e) => ({ ...e, input: { file: 'x.bin', byteLength: 2, sha256: SHA } }), /mandatory/],
    ['bad sha256', (e) => ({ ...e, input: { file: 'x.bin', byteLength: 2, sha256: 'short', hex: '062a' } }), /sha256/],
    ['hex length mismatch', (e) => ({ ...e, input: { file: 'x.bin', byteLength: 3, sha256: SHA, hex: '062a' } }), /does not match byteLength/],
    ['wide-int as JSON number in propertyMap', (e) => ({ ...e, input: { propertyMap: [{ id: 2, valueKind: 'varint', value: '42' }] }, expect: { status: 'ok', stage: 'encode', bytesHex: '00' } }), /decimal-string u64/],
    ['diverges without currentBehavior', (e) => ({ ...e, differential: { playa: { status: 'diverges', reason: 'x' } } }), /currentBehavior/],
    ['incomplete provenance', (e) => { const c = { ...e, provenance: { ...e.provenance } } as Record<string, unknown>; delete (c['provenance'] as Record<string, unknown>)['sourceHash']; return c; }, /provenance\.sourceHash/],
  ];

  for (const [name, mutate, pattern] of cases) {
    it(`rejects: ${name}`, () => {
      const problems = validateEntry(mutate(validDecodeEntry()));
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.join('\n')).toMatch(pattern);
    });
  }
});

describe('validateEntry — strictness (the cases Codex exercised)', () => {
  const encEntry = (pm: unknown): CorpusEntry => ({
    ...validDecodeEntry(), id: 'properties/strict',
    input: { propertyMap: pm } as never,
    expect: { status: 'ok', stage: 'encode', bytesHex: '00' },
  });

  it('rejects a negative u64 string', () => {
    expect(validateEntry(encEntry([{ id: '-1', valueKind: 'varint', value: '0' }])).join('\n')).toMatch(/unsigned decimal-string u64/);
  });
  it('rejects 2^64 (out of u64 range)', () => {
    expect(validateEntry(encEntry([{ id: '18446744073709551616', valueKind: 'varint', value: '0' }])).join('\n')).toMatch(/\[0, 2\^64-1\]/);
  });
  it('accepts 2^64-1 (the maximum)', () => {
    expect(validateEntry(encEntry([{ id: '18446744073709551615', valueKind: 'varint', value: '0' }]))).toEqual([]);
  });
  it('rejects a float in the semantics projection', () => {
    const e = { ...validDecodeEntry(), expect: { status: 'ok', stage: 'decode', semantics: { x: 1.5 } } };
    expect(validateEntry(e as never).join('\n')).toMatch(/floats are prohibited/);
  });
  it('rejects an out-of-int32 JSON number in semantics (must be a string)', () => {
    const e = { ...validDecodeEntry(), expect: { status: 'ok', stage: 'decode', semantics: { x: 9007199254740993 } } };
    expect(validateEntry(e as never).join('\n')).toMatch(/outside int32 must be a decimal STRING/);
  });
  it('rejects an unknown top-level property (exact keys)', () => {
    const e = { ...validDecodeEntry(), somethingNew: 42 };
    expect(validateEntry(e as never).join('\n')).toMatch(/unknown property/);
  });
  it('rejects a placeholder sourceHash on spec-derived provenance', () => {
    const e = { ...validDecodeEntry(), provenance: { ...validDecodeEntry().provenance, sourceHash: 'n/a' } };
    expect(validateEntry(e as never).join('\n')).toMatch(/64-char SHA-256/);
  });
  it('accepts a tombstone (id + retired only)', () => {
    expect(validateEntry({ id: 'properties/retired-x', retired: { reason: 'superseded' } })).toEqual([]);
  });
  it('requires operation on a bmff-structure entry', () => {
    const e = { ...validDecodeEntry(), kind: 'bmff-structure', wireProfile: undefined, id: 'bmff/x', input: { file: 'x.bin', byteLength: 2, sha256: SHA, hex: '0000' }, expect: { status: 'ok', stage: 'decode', semantics: {} } };
    expect(validateEntry(e as never).join('\n')).toMatch(/operation/);
  });
});

describe('validateManifest', () => {
  it('accepts a minimal manifest', () => {
    expect(validateManifest({ corpusSchema: 'moq-media-corpus/1', domain: 'properties', vectors: [validDecodeEntry()] })).toEqual([]);
  });

  it('rejects a broken manifest (wrong schema tag, non-array vectors)', () => {
    const problems = validateManifest({ corpusSchema: 'nope', domain: 'x', vectors: {} });
    expect(problems.join('\n')).toMatch(/corpusSchema/);
    expect(problems.join('\n')).toMatch(/vectors/);
  });

  it('detects duplicate ids', () => {
    const e = validDecodeEntry();
    const problems = validateManifest({ corpusSchema: 'moq-media-corpus/1', domain: 'properties', vectors: [e, e] });
    expect(problems.join('\n')).toMatch(/duplicate id/);
  });
});
