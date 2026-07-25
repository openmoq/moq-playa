/**
 * The corpus is validated against the JSON Schema (ajv) at load time, in
 * addition to the semantic TS validator. This test asserts that (a) the real
 * committed manifests pass the JSON Schema, and (b) the JSON Schema actually has
 * teeth — a manifest with an unknown property or a JSON-number wide field is
 * rejected.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jsonSchemaValidate } from './schema-json.js';
import { validateManifest } from './validate.js';
import { vectorsRoot, CORPUS_DOMAINS } from './load-corpus.js';

const PROV = { class: 'spec-derived', source: 's', section: '1', generator: 'g', generatorVersion: 'v', command: 'c', sourceHash: 'a'.repeat(64) };
function manifestWith(expect: unknown, differential?: unknown): unknown {
  return {
    corpusSchema: 'moq-media-corpus/1', domain: 'properties',
    vectors: [{
      id: 'properties/x', kind: 'property-block-decode', profile: 'p', wireProfile: 'd18-delta-vi64',
      description: 'd', input: { file: 'x.bin', byteLength: 1, sha256: 'a'.repeat(64), hex: '00' },
      expect, expectationBasis: 'normative', provenance: PROV, ...(differential !== undefined ? { differential } : {}),
    }],
  };
}

describe('JSON Schema (ajv) validation', () => {
  for (const domain of CORPUS_DOMAINS) {
    it(`the committed "${domain}" manifest passes the JSON Schema`, () => {
      const manifest = JSON.parse(readFileSync(join(vectorsRoot(), domain, 'manifest.json'), 'utf-8'));
      expect(jsonSchemaValidate(manifest)).toEqual([]);
    });
  }

  it('rejects an unknown top-level entry property', () => {
    const bad = {
      corpusSchema: 'moq-media-corpus/1', domain: 'x',
      vectors: [{ id: 'x/y', bogus: 1 }],
    };
    expect(jsonSchemaValidate(bad).length).toBeGreaterThan(0);
  });

  it('rejects a fileInput byteLength above int32 (2^53 precision hazard)', () => {
    const bad = {
      corpusSchema: 'moq-media-corpus/1', domain: 'x',
      vectors: [{
        id: 'x/y', kind: 'property-block-decode', profile: 'p', wireProfile: 'd18-delta-vi64',
        description: 'd', input: { file: 'x.bin', byteLength: 9007199254740992, sha256: 'a'.repeat(64) },
        expect: { status: 'ok', stage: 'decode', semantics: {} }, expectationBasis: 'normative',
        provenance: { class: 'spec-derived', source: 's', section: '1', generator: 'g', generatorVersion: 'v', command: 'c', sourceHash: 'a'.repeat(64) },
      }],
    };
    expect(jsonSchemaValidate(bad).length).toBeGreaterThan(0);
  });

  it('rejects a JSON-number wide field in a propertyMap (must be a string)', () => {
    const bad = {
      corpusSchema: 'moq-media-corpus/1', domain: 'x',
      vectors: [{
        id: 'x/y', kind: 'property-block-decode', profile: 'p', wireProfile: 'd18-delta-vi64',
        description: 'd', input: { propertyMap: [{ id: 2, valueKind: 'varint', value: '0' }] },
        expect: { status: 'ok', stage: 'encode', bytesHex: '00' }, expectationBasis: 'normative',
        provenance: { class: 'spec-derived', source: 's', section: '1', generator: 'g', generatorVersion: 'v', command: 'c', sourceHash: 'a'.repeat(64) },
      }],
    };
    expect(jsonSchemaValidate(bad).length).toBeGreaterThan(0);
  });
});

describe('contradictory expectations — BOTH validators reject (LibMoQ relies on the JSON Schema)', () => {
  const cases: Array<[string, unknown]> = [
    ['error + bytesHex', manifestWith({ status: 'error', stage: 'decode', error: { category: 'truncated' }, bytesHex: '00' })],
    ['ok decode + bytesHex', manifestWith({ status: 'ok', stage: 'decode', semantics: {}, bytesHex: '00' })],
    ['ok encode + semantics', manifestWith({ status: 'ok', stage: 'encode', bytesHex: '00', semantics: {} })],
    ['error + semantics', manifestWith({ status: 'error', stage: 'decode', error: { category: 'truncated' }, semantics: {} })],
    ['differential pass + currentBehavior', manifestWith({ status: 'ok', stage: 'decode', semantics: {} }, { playa: { status: 'pass', currentBehavior: { status: 'ok', stage: 'decode', semantics: {} } } })],
    ['differential diverges WITHOUT currentBehavior', manifestWith({ status: 'ok', stage: 'decode', semantics: {} }, { playa: { status: 'diverges' } })],
  ];
  for (const [name, m] of cases) {
    it(`JSON Schema rejects: ${name}`, () => expect(jsonSchemaValidate(m).length, name).toBeGreaterThan(0));
    it(`TS validator rejects: ${name}`, () => expect(validateManifest(m).length, name).toBeGreaterThan(0));
  }
});
