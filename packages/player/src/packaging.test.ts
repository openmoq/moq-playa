/**
 * isMsePackaging — the single predicate for "this track goes through MSE /
 * CMAF init bootstrap, not the LOC WebCodecs pipeline".
 *
 * @see draft-ietf-moq-cmsf-00 §3 (CMAF Packaging)
 * @see draft-einarsson-moq-locmaf-01 §6 (CMAF Header Delivery)
 * @module
 */

import { describe, it, expect } from 'vitest';
import { isMsePackaging } from './packaging.js';
import { isMsePackaging as exported } from './index.js';

describe('isMsePackaging', () => {
  it('is true for cmaf and locmaf', () => {
    expect(isMsePackaging('cmaf')).toBe(true);
    expect(isMsePackaging('locmaf')).toBe(true);
  });

  it('is false for loc, metadata packagings, init and undefined', () => {
    for (const p of ['loc', 'mediatimeline', 'eventtimeline', 'init', undefined]) {
      expect(isMsePackaging(p), String(p)).toBe(false);
    }
  });

  it('is exported from the package entry point', () => {
    expect(exported).toBe(isMsePackaging);
  });
});
