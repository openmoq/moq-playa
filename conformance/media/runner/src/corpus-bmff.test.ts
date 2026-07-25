import { describe, it, expect } from 'vitest';
import { loadDomain } from './load-corpus.js';
import { executionCapability } from './capabilities.js';
import { runBmff } from './bmff-exec.js';
import { comparePlaya } from './exec-compare.js';

const loaded = loadDomain('bmff');

describe('corpus/bmff — executable (mp4-box utilities; total functions, never throw)', () => {
  it('has the expected number of bmff vectors', () => {
    expect(loaded.vectors.length).toBe(7);
  });

  for (const { entry, bytes } of loaded.vectors) {
    it(`${entry.id}`, () => {
      expect(entry.kind).toBe('bmff-structure');
      expect(executionCapability(entry).capability).toBe('executable');
      // The op under test comes from the ENTRY (input contract), never inferred
      // from the expected output.
      expect(entry.operation, `${entry.id}: entry.operation`).toBeDefined();
      const actual = runBmff(bytes!, entry.operation!);
      const cmp = comparePlaya(entry, actual);
      expect(cmp.ok, cmp.detail).toBe(true);
    });
  }
});
