import { describe, it, expect } from 'vitest';
import { loadDomain } from './load-corpus.js';
import { executionCapability } from './capabilities.js';
import { validateEntry } from './validate.js';
import { runPropertyDecode, runPropertyEncode } from './property-exec.js';
import { comparePlaya } from './exec-compare.js';
import { toHex } from './canonical.js';
import type { PropertyMapInput, WireProfile } from './schema-types.js';

const loaded = loadDomain('properties');

describe('corpus/properties — Layer-A property-block codec (executable against the shared core)', () => {
  it('has the expected number of property vectors', () => {
    expect(loaded.vectors.length).toBe(33);
  });

  it('includes the ordering / duplicate / parity contract vectors', () => {
    const ids = loaded.vectors.map((v) => v.entry.id);
    expect(ids).toContain('properties/encode-unsorted-canonical');
    expect(ids).toContain('properties/encode-duplicate-ids');
    expect(ids).toContain('properties/decode-duplicate-ids');
    expect(ids).toContain('properties/encode-parity-mismatch');
  });

  it('every entry is schema-valid', () => {
    for (const { entry } of loaded.vectors) {
      expect(validateEntry(entry), entry.id).toEqual([]);
    }
  });

  it('every entry is executable against the shared property-wire core', () => {
    for (const { entry } of loaded.vectors) {
      expect(executionCapability(entry).capability, entry.id).toBe('executable');
    }
  });

  // Execute each vector, both directions, against the production core.
  for (const { entry, bytes } of loaded.vectors) {
    it(`${entry.id}`, () => {
      const wireProfile = entry.wireProfile as WireProfile;
      if (entry.expect.stage === 'encode') {
        const pm = (entry.input as PropertyMapInput).propertyMap;
        const actual = runPropertyEncode(pm, wireProfile);
        const cmp = comparePlaya(entry, actual);
        expect(cmp.ok, cmp.detail).toBe(true);
      } else {
        expect(bytes, entry.id).toBeInstanceOf(Uint8Array);
        const run = runPropertyDecode(bytes!, wireProfile);
        const cmp = comparePlaya(entry, run.result);
        expect(cmp.ok, cmp.detail).toBe(true);
        // A successful decode must re-encode to the CANONICAL minimal form —
        // `canonicalHex` for a non-minimal input, else the (minimal) input bytes.
        if (run.result.status === 'ok') {
          const target = entry.expect.canonicalHex ?? toHex(bytes!);
          expect(run.canonicalHex, `${entry.id}: canonical re-encode`).toBe(target);
        }
      }
    });
  }

  it('covers both decode and encode directions explicitly (not inferred from input shape)', () => {
    const decode = loaded.vectors.filter((v) => v.entry.expect.stage === 'decode');
    const encode = loaded.vectors.filter((v) => v.entry.expect.stage === 'encode');
    expect(decode.length).toBeGreaterThan(0);
    expect(encode.length).toBeGreaterThan(0);
    for (const v of decode) expect('file' in v.entry.input, v.entry.id).toBe(true);
    for (const v of encode) expect('propertyMap' in v.entry.input, v.entry.id).toBe(true);
  });

  it('carries the byte-value boundary pair (65535 accepted, 65536 rejected)', () => {
    const ids = loaded.vectors.map((v) => v.entry.id);
    expect(ids).toContain('properties/odd-value-65535-accepted');
    expect(ids).toContain('properties/odd-value-65536-rejected');
  });
});
