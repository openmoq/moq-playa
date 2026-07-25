/**
 * A tombstone must be inert through EVERY consumer: the loader excludes it from
 * active vectors, capability classification labels it `retired`, the tally does
 * not count it, and no domain runner would execute it.
 *
 * @module
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { loadDomain } from './load-corpus.js';
import { executionCapability, tallyCapabilities } from './capabilities.js';
import { toHex } from './canonical.js';
import type { CorpusEntry, TombstoneEntry } from './schema-types.js';

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe('tombstone is inert through every consumer', () => {
  const base = mkdtempSync(join(tmpdir(), 'corpus-tomb-'));
  const bytes = Uint8Array.from([0x02, 0x2a]);
  const active: CorpusEntry = {
    id: 'properties/active', kind: 'property-block-decode', profile: 'transport-18', wireProfile: 'd18-delta-vi64',
    description: 'active', input: { file: 'a.bin', byteLength: 2, sha256: sha(bytes), hex: toHex(bytes) },
    expect: { status: 'ok', stage: 'decode', semantics: { properties: [] } }, expectationBasis: 'normative',
    provenance: { class: 'spec-derived', source: 's', section: '1', generator: 'g', generatorVersion: 'v', command: 'c', sourceHash: 'a'.repeat(64) },
  };
  const tombstone: TombstoneEntry = { id: 'properties/retired', retired: { reason: 'superseded' } };

  mkdirSync(join(base, 'properties'), { recursive: true });
  writeFileSync(join(base, 'properties', 'manifest.json'), JSON.stringify({ corpusSchema: 'moq-media-corpus/1', domain: 'properties', vectors: [active, tombstone] }));
  writeFileSync(join(base, 'properties', 'a.bin'), bytes);

  const loaded = loadDomain('properties', base);

  it('loader: active vectors exclude the tombstone', () => {
    expect(loaded.vectors.map((v) => v.entry.id)).toEqual(['properties/active']);
    expect(loaded.tombstones.map((t) => t.id)).toEqual(['properties/retired']);
  });

  it('capability: the tombstone classifies as "retired", not undefined', () => {
    expect(executionCapability(tombstone).capability).toBe('retired');
  });

  it('tally: the tombstone is not counted', () => {
    const counts = tallyCapabilities([active, tombstone]);
    expect(counts.executable + counts.forwardLooking).toBe(1); // only the active vector
  });

  it('runner iteration only ever sees active vectors', () => {
    for (const { entry } of loaded.vectors) expect(entry.retired).toBeUndefined();
  });

  afterAll(() => rmSync(base, { recursive: true, force: true }));
});
