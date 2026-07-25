import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDomain, vectorsRoot, CORPUS_DOMAINS } from './load-corpus.js';

/**
 * Drift guard: the top-level MANIFEST.json counts must be DERIVED from the
 * actual domain manifests, so a hand-edited manifest without a rebuild fails
 * here rather than silently disagreeing.
 */
describe('corpus MANIFEST.json index', () => {
  const indexPath = join(vectorsRoot(), '..', 'MANIFEST.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as {
    corpusSchema: string;
    domains: Record<string, number>;
    totalVectors: number;
  };

  const actual: Record<string, number> = {};
  let total = 0;
  for (const d of CORPUS_DOMAINS) {
    const loaded = loadDomain(d);
    const n = loaded.vectors.length + loaded.tombstones.length; // index counts all manifest entries
    actual[d] = n;
    total += n;
  }

  it('declares the corpus schema', () => {
    expect(index.corpusSchema).toBe('moq-media-corpus/1');
  });

  it('per-domain counts match the loaded manifests exactly', () => {
    expect(index.domains).toEqual(actual);
  });

  it('total matches the sum of loaded vectors', () => {
    expect(index.totalVectors).toBe(total);
    expect(total).toBe(127);
  });
});
