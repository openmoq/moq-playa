import { describe, it, expect } from 'vitest';
import { loadDomain, CORPUS_DOMAINS } from './load-corpus.js';
import { executionCapability, tallyCapabilities } from './capabilities.js';
import type { CorpusEntry } from './schema-types.js';

const allEntries: CorpusEntry[] = CORPUS_DOMAINS.flatMap((d) => loadDomain(d).vectors.map((v) => v.entry));

describe('capability accounting (no silent skips)', () => {
  it('every corpus vector is executable — nothing deferred or unsupported', () => {
    const counts = tallyCapabilities(allEntries);
    // executable = properties(33) + loc-properties(28) + loc-semantics(4)
    //            + catalog(55) + bmff(7) = 127.
    expect(counts.executable).toBe(127);
    expect(counts.forwardLooking).toBe(0);
    expect(counts.executable + counts.forwardLooking).toBe(127);
  });

  it('no vector is forward-looking: every format the corpus names has an implementation', () => {
    const deferred = allEntries.filter((e) => executionCapability(e).capability === 'forward-looking');
    expect(deferred.map((e) => e.id)).toEqual([]);
  });

  it('the property-block and LOC-semantics kinds execute against real code, with a stated reason', () => {
    const layerKinds = allEntries.filter((e) => e.kind === 'property-block-decode' || e.kind === 'loc-semantics');
    expect(layerKinds.length).toBe(37);
    for (const e of layerKinds) {
      expect(executionCapability(e).capability, e.id).toBe('executable');
      expect(executionCapability(e).reason.length).toBeGreaterThan(20);
    }
  });
});
