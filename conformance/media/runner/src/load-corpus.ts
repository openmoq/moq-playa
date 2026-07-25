/**
 * Corpus loader — reads a domain manifest and its referenced files, verifying
 * containment, byte length, SHA-256, and (for short `*.bin`) the inline hex.
 *
 * Default operation is READ-ONLY. Regeneration is opt-in via `GEN_CORPUS=1` and
 * is permitted ONLY for `implementation-generated` entries whose generator is
 * this repository — {@link assertRegenerable} refuses to rewrite spec-derived or
 * third-party vectors under any circumstances.
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateManifest } from './validate.js';
import { jsonSchemaValidate } from './schema-json.js';
import { toHex } from './canonical.js';
import { isFileInput, isTombstone, type CorpusEntry, type DomainManifest } from './schema-types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The domains present in the corpus. */
export const CORPUS_DOMAINS = ['properties', 'loc', 'catalog', 'bmff'] as const;
export type CorpusDomain = (typeof CORPUS_DOMAINS)[number];

/** Absolute path of the canonical corpus vectors root. */
export function vectorsRoot(): string {
  // conformance/media/runner/src → ../../vectors
  return resolve(HERE, '../../vectors');
}

export interface LoadedVector {
  readonly entry: CorpusEntry;
  /** Present for file-input entries; the verified on-disk bytes. */
  readonly bytes?: Uint8Array;
}

/** A retired entry: inert, referencing no file, never executed or counted. */
export interface Tombstone {
  readonly id: string;
  readonly retired: { readonly reason: string };
}

export interface LoadedDomain {
  readonly domain: string;
  readonly manifest: DomainManifest;
  /** ACTIVE vectors only — tombstones are excluded. */
  readonly vectors: readonly LoadedVector[];
  /** Retained tombstones (ids reserved, inert). */
  readonly tombstones: readonly Tombstone[];
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Load and fully verify one domain (e.g. `"loc"`, `"properties"`, `"catalog"`,
 * `"bmff"`). Throws deterministically on a malformed manifest, a schema
 * violation, a missing/mismatched file, or a path-escape attempt.
 */
export function loadDomain(domain: string, baseDir: string = vectorsRoot()): LoadedDomain {
  const dir = join(baseDir, domain);
  const manifestPath = join(dir, 'manifest.json');

  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch (err) {
    throw new Error(`corpus: cannot read manifest ${manifestPath}: ${(err as Error).message}`);
  }

  let manifest: DomainManifest;
  try {
    manifest = JSON.parse(raw) as DomainManifest;
  } catch (err) {
    throw new Error(`corpus: manifest ${manifestPath} is not valid JSON: ${(err as Error).message}`);
  }

  // Structural (JSON Schema, ajv) THEN semantic (TS validator) validation.
  const jsonProblems = jsonSchemaValidate(manifest);
  const problems = [...jsonProblems.map((s) => `[schema] ${s}`), ...validateManifest(manifest, `${domain}/manifest.json`)];
  if (problems.length > 0) {
    throw new Error(`corpus: schema validation failed for ${domain}:\n  - ${problems.join('\n  - ')}`);
  }
  if (manifest.domain !== domain) {
    throw new Error(`corpus: manifest domain "${manifest.domain}" does not match directory "${domain}"`);
  }

  const tombstones: Tombstone[] = [];
  const vectors: LoadedVector[] = [];
  for (const entry of manifest.vectors) {
    if (isTombstone(entry)) { // inert: never dereference input; excluded from active vectors
      tombstones.push({ id: entry.id, retired: entry.retired });
      continue;
    }
    const fi = isFileInput(entry.input) ? entry.input : null;
    if (fi === null) { vectors.push({ entry }); continue; }

    // Containment: the resolved path must stay inside the domain directory.
    const filePath = resolve(dir, fi.file);
    const rel = relative(dir, filePath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`corpus: entry ${entry.id} file "${fi.file}" escapes the domain directory`);
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(filePath));
    } catch (err) {
      throw new Error(`corpus: entry ${entry.id} cannot read file ${filePath}: ${(err as Error).message}`);
    }

    if (bytes.length !== fi.byteLength) {
      throw new Error(`corpus: entry ${entry.id} byteLength ${fi.byteLength} != on-disk ${bytes.length}`);
    }
    const digest = sha256Hex(bytes);
    if (digest !== fi.sha256) {
      throw new Error(`corpus: entry ${entry.id} sha256 mismatch (manifest ${fi.sha256}, file ${digest})`);
    }
    if (fi.hex !== undefined && toHex(bytes) !== fi.hex) {
      throw new Error(`corpus: entry ${entry.id} inline hex does not match file bytes`);
    }
    vectors.push({ entry, bytes });
  }

  return { domain, manifest, vectors, tombstones };
}

/** Whether opt-in regeneration is requested this run. */
export function isGenEnabled(): boolean {
  return process.env['GEN_CORPUS'] === '1';
}

/**
 * Guard for the authoring/regeneration path: only `implementation-generated`
 * entries produced by THIS repo may be machine-regenerated. Spec-derived and
 * third-party bytes are hand-reviewed artifacts and must never be silently
 * rewritten by a generator run.
 *
 * @throws {Error} if the entry is not regenerable.
 */
export function assertRegenerable(entry: CorpusEntry): void {
  if (entry.provenance.class !== 'implementation-generated') {
    throw new Error(
      `corpus: refusing to regenerate ${entry.id} — provenance.class is "${entry.provenance.class}", ` +
      `only implementation-generated entries may be regenerated`,
    );
  }
  if (!/playa/i.test(entry.provenance.generator)) {
    throw new Error(
      `corpus: refusing to regenerate ${entry.id} — generator "${entry.provenance.generator}" is not this repo`,
    );
  }
}
