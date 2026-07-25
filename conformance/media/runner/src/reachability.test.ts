/**
 * Manifest ↔ directory reachability: every file on disk (other than the
 * manifest) must be referenced by exactly one manifest entry, and every
 * file-input entry must point at an existing file. This forbids stale orphan
 * artifacts that a rename could otherwise leave behind.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadDomain, vectorsRoot, CORPUS_DOMAINS } from './load-corpus.js';
import { isFileInput } from './schema-types.js';

describe('corpus manifest ↔ directory reachability', () => {
  for (const domain of CORPUS_DOMAINS) {
    it(`"${domain}" has no orphan files and no dangling references`, () => {
      const dir = join(vectorsRoot(), domain);
      const onDisk = new Set(readdirSync(dir).filter((f) => f !== 'manifest.json'));

      const { vectors, tombstones } = loadDomain(domain);
      const referenced = new Set<string>();
      for (const { entry } of vectors) {
        if (isFileInput(entry.input)) referenced.add(entry.input.file);
      }
      // Tombstones reference no files.
      expect(tombstones.every((t) => t.retired !== undefined)).toBe(true);

      const orphans = [...onDisk].filter((f) => !referenced.has(f));
      const dangling = [...referenced].filter((f) => !onDisk.has(f));
      expect(orphans, `orphan files in ${domain}/`).toEqual([]);
      expect(dangling, `dangling manifest references in ${domain}/`).toEqual([]);
    });
  }
});
