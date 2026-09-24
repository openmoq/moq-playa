/**
 * isMsePackaging — the single predicate for "this track goes through MSE /
 * CMAF init bootstrap, not the LOC WebCodecs pipeline".
 *
 * @see draft-ietf-moq-cmsf-00 §3 (CMAF Packaging)
 * @see draft-einarsson-moq-locmaf-01 §6 (CMAF Header Delivery)
 * @module
 */

import { describe, it, expect } from 'vitest';
import { isMsePackaging, usesMsePath } from './packaging.js';
import { isMsePackaging as exported, usesMsePath as exportedUsesMsePath } from './index.js';

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

describe('usesMsePath (draft-einarsson-moq-locmaf-01 §16 consumption path)', () => {
  it('cmaf always takes MSE; locmaf takes MSE unless the frame path is selected', () => {
    expect(usesMsePath('cmaf', undefined)).toBe(true);
    expect(usesMsePath('cmaf', 'frame')).toBe(true);
    expect(usesMsePath('locmaf', undefined)).toBe(true);
    expect(usesMsePath('locmaf', 'mse')).toBe(true);
    expect(usesMsePath('locmaf', 'frame')).toBe(false);
  });

  it('never routes loc, metadata packagings, init or undefined to MSE', () => {
    for (const p of ['loc', 'mediatimeline', 'eventtimeline', 'init', undefined]) {
      expect(usesMsePath(p, undefined), String(p)).toBe(false);
      expect(usesMsePath(p, 'frame'), String(p)).toBe(false);
    }
  });

  it('is exported from the package entry point', () => {
    expect(exportedUsesMsePath).toBe(usesMsePath);
  });
});
