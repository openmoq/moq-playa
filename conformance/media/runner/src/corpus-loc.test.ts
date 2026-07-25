import { describe, it, expect } from 'vitest';
import { loadDomain } from './load-corpus.js';
import { executionCapability } from './capabilities.js';
import { runLocProperties, runLocEncode, runLocSemantics } from './loc-exec.js';
import { comparePlaya } from './exec-compare.js';
import type { PropertyMapEntryJson, PropertyMapInput, WireProfile } from './schema-types.js';

const loaded = loadDomain('loc');

describe('corpus/loc — executable loc-properties (A+B against parseLocHeaders)', () => {
  const props = loaded.vectors.filter((v) => v.entry.kind === 'loc-properties');

  it('has the expected number of loc-properties vectors', () => {
    expect(props.length).toBe(28); // 10 correct-d16 + 9 d18 decode drivers + 9 d18 encode drivers
  });

  for (const { entry, bytes } of props) {
    it(`${entry.id}`, () => {
      expect(executionCapability(entry).capability).toBe('executable');
      const wireProfile = entry.wireProfile as WireProfile;
      let actual;
      if (entry.expect.stage === 'encode') {
        // Encode driver: run encodeLocHeaders from the propertyMap input.
        const pm = (entry.input as PropertyMapInput).propertyMap;
        actual = runLocEncode(pm, wireProfile);
      } else {
        expect(bytes).toBeInstanceOf(Uint8Array);
        actual = runLocProperties(bytes!, wireProfile);
      }
      const cmp = comparePlaya(entry, actual);
      expect(cmp.ok, cmp.detail).toBe(true);
    });
  }

  it('covers the COMPLETE draft-18 divergence matrix: every value >= 64, both directions — all PROMOTED to pass', () => {
    // The complete set of draft-18 values that diverge from QUIC (>= 64), by label.
    const GE64 = ['64', '127', '128', '16383', '16384', 'epoch', 'max62', 'pow62', 'max64'].sort();
    // The "-diverges" id suffix is historical: these drove the vi64 wiring fix.
    // They now carry NO differential (they pass against production directly).
    const drivers = (prefix: string): typeof props => props.filter((v) => v.entry.id.startsWith(prefix) && v.entry.id.endsWith('-diverges'));
    const labelsFor = (prefix: string): string[] => drivers(prefix)
      .map((v) => v.entry.id.slice(prefix.length).replace(/-diverges$/, ''))
      .sort();
    expect(labelsFor('loc/props-d18-ts-'), 'decode drivers').toEqual(GE64);
    expect(labelsFor('loc/props-d18-encode-'), 'encode drivers').toEqual(GE64);
    // Every driver is fully promoted — no residual divergence record remains.
    for (const v of [...drivers('loc/props-d18-ts-'), ...drivers('loc/props-d18-encode-')]) {
      expect(v.entry.differential?.['playa'], v.entry.id).toBeUndefined();
    }
  });
});

describe('corpus/loc — loc-semantics (Layer B, executable against resolveLocHeaders)', () => {
  const sem = loaded.vectors.filter((v) => v.entry.kind === 'loc-semantics');

  it('has the expected number of loc-semantics vectors', () => {
    expect(sem.length).toBe(4);
  });

  for (const { entry } of sem) {
    it(`${entry.id}`, () => {
      expect(executionCapability(entry).capability).toBe('executable');
      // Its input is a structured PropertyMap; there is no bytes file to run.
      const pm = (entry.input as PropertyMapInput).propertyMap as PropertyMapEntryJson[];
      const actual = runLocSemantics(pm);
      const cmp = comparePlaya(entry, actual);
      expect(cmp.ok, cmp.detail).toBe(true);
    });
  }
});
