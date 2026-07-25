/**
 * Actual JSON Schema validation of corpus manifests against
 * `conformance/media/schema/corpus-manifest.schema.json` (draft 2020-12, via
 * ajv). This is the structural gate; {@link validateManifest} in `validate.ts`
 * adds the semantic checks JSON Schema cannot express (u64 numeric range,
 * kind-discriminated requirements, sorted diagnostics, provenance SHA-256).
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// ajv v8 is CJS-first; require sidesteps ESM/CJS interop under the strict tsconfig.
/* eslint-disable @typescript-eslint/no-explicit-any */
const ajvModule = require('ajv/dist/2020') as any;
const Ajv2020 = (ajvModule.default ?? ajvModule) as any;

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, '../../schema');

function read(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, name), 'utf-8')) as Record<string, unknown>;
}

const manifestSchema = read('corpus-manifest.schema.json');
const scenarioSchema = read('scenario.schema.json');
const ajv = new Ajv2020({ allErrors: true, strict: false });
// Register the manifest schema by its filename so the scenario schema's
// `corpus-manifest.schema.json#/$defs/...` $refs resolve.
ajv.addSchema(manifestSchema, 'corpus-manifest.schema.json');
const compiledManifest = ajv.compile(manifestSchema);
const compiledScenario = ajv.compile(scenarioSchema);
/* eslint-enable @typescript-eslint/no-explicit-any */

function fmt(errs: unknown): string[] {
  const errors = (errs ?? []) as Array<{ instancePath?: string; message?: string; keyword?: string }>;
  return errors.map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword ?? 'invalid'}`);
}

/** Validate a manifest against the JSON Schema. Returns problem strings (empty ⇒ valid). */
export function jsonSchemaValidate(manifest: unknown): string[] {
  return compiledManifest(manifest) ? [] : fmt(compiledManifest.errors);
}

/** Validate a scenario against the (finalized) scenario JSON Schema. */
export function jsonSchemaValidateScenario(scenario: unknown): string[] {
  return compiledScenario(scenario) ? [] : fmt(compiledScenario.errors);
}
