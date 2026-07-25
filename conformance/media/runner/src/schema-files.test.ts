/**
 * The JSON Schema files under conformance/media/schema/ are a reviewable mirror
 * of the authoritative TypeScript validator. This test guards them against
 * drift: the enums declared in the JSON Schema must match the TS constants.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VECTOR_KINDS, WIRE_PROFILES, STAGES, STATUSES,
  PROVENANCE_CLASSES, EXPECTATION_BASES, DIFFERENTIAL_STATUSES, ERROR_CATEGORIES,
} from './schema-types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, '../../schema');

function readSchema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, name), 'utf-8')) as Record<string, unknown>;
}

describe('JSON Schema files', () => {
  it('both schema files are valid JSON', () => {
    expect(() => readSchema('corpus-manifest.schema.json')).not.toThrow();
    expect(() => readSchema('scenario.schema.json')).not.toThrow();
  });

  const manifest = readSchema('corpus-manifest.schema.json');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const defs = (manifest as any).$defs;
  const entryProps = defs.fullEntry.properties;

  // Flat enums (drift-checked directly against the TS constants).
  const pairs: Array<[string, readonly string[], string[]]> = [
    ['kind', VECTOR_KINDS, entryProps.kind.enum],
    ['wireProfile', WIRE_PROFILES, entryProps.wireProfile.enum],
    ['expectationBasis', EXPECTATION_BASES, entryProps.expectationBasis.enum],
    ['provenance.class', PROVENANCE_CLASSES, defs.provenance.properties.class.enum],
    ['errorCategory', ERROR_CATEGORIES, defs.errorCategory.enum],
  ];

  for (const [name, tsConst, jsonEnum] of pairs) {
    it(`JSON Schema enum for "${name}" matches the TS constant`, () => {
      expect([...jsonEnum].sort()).toEqual([...tsConst].sort());
    });
  }

  it('stage/status/differential.status are discriminated via oneOf consts covering every TS value', () => {
    // expect is a oneOf; collect the const stage/status across its branches.
    const branches = defs.expect.oneOf as Array<{ properties: { status: { const: string }; stage?: { const?: string; enum?: string[] } } }>;
    const statuses = new Set(branches.map((b) => b.properties.status.const));
    expect([...statuses].sort()).toEqual([...STATUSES].sort());
    const stages = new Set(branches.flatMap((b) => b.properties.stage?.const ? [b.properties.stage.const] : (b.properties.stage?.enum ?? [])));
    expect([...stages].sort()).toEqual([...STAGES].sort());
    const diffBranches = defs.differentialEntry.oneOf as Array<{ properties: { status: { enum: string[] } } }>;
    const diffStatuses = new Set(diffBranches.flatMap((b) => b.properties.status.enum));
    expect([...diffStatuses].sort()).toEqual([...DIFFERENTIAL_STATUSES].sort());
  });
});
