import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { loadDomain, assertRegenerable, isGenEnabled, CORPUS_DOMAINS } from './load-corpus.js';
import { toHex } from './canonical.js';
import type { CorpusEntry, DomainManifest, Provenance } from './schema-types.js';

const SHA = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

function tmpBase(): string {
  return mkdtempSync(join(tmpdir(), 'corpus-'));
}
function writeDomain(base: string, domain: string, manifest: unknown, files: Record<string, Uint8Array> = {}): void {
  const dir = join(base, domain);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
}

const prov: Provenance = { class: 'spec-derived', source: 's', section: '1', generator: 'hand-authored', generatorVersion: 'n/a', command: 'n/a', sourceHash: 'a'.repeat(64) };

function fileEntry(bytes: Uint8Array): CorpusEntry {
  return {
    id: 'properties/tmp', kind: 'property-block-decode', profile: 'transport-18', wireProfile: 'd18-delta-vi64',
    description: 'tmp', input: { file: 'v.bin', byteLength: bytes.length, sha256: SHA(bytes), hex: toHex(bytes) },
    expect: { status: 'ok', stage: 'decode', semantics: { properties: [] } }, expectationBasis: 'normative', provenance: prov,
  };
}
function manifestOf(entry: CorpusEntry): DomainManifest {
  return { corpusSchema: 'moq-media-corpus/1', domain: 'properties', vectors: [entry] };
}

describe('loadDomain — real corpus', () => {
  for (const domain of CORPUS_DOMAINS) {
    it(`loads and verifies the "${domain}" domain`, () => {
      const loaded = loadDomain(domain);
      expect(loaded.vectors.length).toBeGreaterThan(0);
      // Every file-input entry carries verified bytes.
      for (const v of loaded.vectors) {
        if ('file' in v.entry.input) expect(v.bytes).toBeInstanceOf(Uint8Array);
      }
    });
  }
});

describe('loadDomain — deterministic rejection', () => {
  it('rejects a malformed manifest JSON', () => {
    const base = tmpBase();
    try {
      writeDomain(base, 'properties', '{ not json ');
      expect(() => loadDomain('properties', base)).toThrow(/not valid JSON/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('rejects a schema-invalid manifest', () => {
    const base = tmpBase();
    try {
      writeDomain(base, 'properties', { corpusSchema: 'wrong', domain: 'properties', vectors: [] });
      expect(() => loadDomain('properties', base)).toThrow(/schema validation failed/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('rejects a byteLength mismatch', () => {
    const base = tmpBase();
    const bytes = Uint8Array.from([0x06, 0x2a]);
    try {
      const e = fileEntry(bytes);
      (e.input as { byteLength: number }).byteLength = 3;
      (e.input as { hex: string }).hex = '062a2a';
      (e.input as { sha256: string }).sha256 = SHA(Uint8Array.from([0x06, 0x2a, 0x2a]));
      writeDomain(base, 'properties', manifestOf(e), { 'v.bin': bytes });
      expect(() => loadDomain('properties', base)).toThrow(/byteLength/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('rejects a sha256 mismatch', () => {
    const base = tmpBase();
    const bytes = Uint8Array.from([0x06, 0x2a]);
    try {
      const e = fileEntry(bytes);
      (e.input as { sha256: string }).sha256 = 'b'.repeat(64);
      writeDomain(base, 'properties', manifestOf(e), { 'v.bin': bytes });
      expect(() => loadDomain('properties', base)).toThrow(/sha256 mismatch/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('rejects an inline-hex mismatch', () => {
    const base = tmpBase();
    const bytes = Uint8Array.from([0x06, 0x2a]);
    try {
      const e = fileEntry(bytes);
      (e.input as { hex: string }).hex = '0630';
      writeDomain(base, 'properties', manifestOf(e), { 'v.bin': bytes });
      expect(() => loadDomain('properties', base)).toThrow(/inline hex/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('rejects a missing referenced file', () => {
    const base = tmpBase();
    const bytes = Uint8Array.from([0x06, 0x2a]);
    try {
      writeDomain(base, 'properties', manifestOf(fileEntry(bytes))); // no v.bin written
      expect(() => loadDomain('properties', base)).toThrow(/cannot read file/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

describe('regeneration guard', () => {
  it('refuses to regenerate a spec-derived entry', () => {
    expect(() => assertRegenerable(fileEntry(Uint8Array.from([0])))).toThrow(/refusing to regenerate/);
  });

  it('permits regeneration of an implementation-generated playa entry', () => {
    const e = fileEntry(Uint8Array.from([0]));
    (e.provenance as { class: string }).class = 'implementation-generated';
    (e.provenance as { generator: string }).generator = 'playa:build-corpus';
    expect(() => assertRegenerable(e)).not.toThrow();
  });

  it('refuses a third-party entry even if generator names playa', () => {
    const e = fileEntry(Uint8Array.from([0]));
    (e.provenance as { class: string }).class = 'third-party';
    (e.provenance as { generator: string }).generator = 'playa';
    expect(() => assertRegenerable(e)).toThrow(/refusing to regenerate/);
  });

  it('reads GEN_CORPUS from the environment', () => {
    expect(typeof isGenEnabled()).toBe('boolean');
  });
});

describe('loadDomain — tombstones are inert (no input dereference)', () => {
  it('loads a tombstone entry without touching a file', () => {
    const base = tmpBase();
    try {
      const manifest = {
        corpusSchema: 'moq-media-corpus/1', domain: 'properties',
        vectors: [{ id: 'properties/retired-old', retired: { reason: 'superseded by properties/equiv-64-d18' } }],
      };
      writeDomain(base, 'properties', manifest); // no files written
      const loaded = loadDomain('properties', base);
      // A tombstone is NOT an active vector; it lives in a separate list.
      expect(loaded.vectors).toHaveLength(0);
      expect(loaded.tombstones).toHaveLength(1);
      expect(loaded.tombstones[0]!.id).toBe('properties/retired-old');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
