import { describe, it, expect } from 'vitest';
import { isDraft22, isDraft23, isRequestStreamDraft, isWiredDraft, WIRED_DRAFTS } from './versions.js';

describe('draft versions', () => {
  it('wires drafts 14, 16, 18, 22 and 23 only', () => {
    expect(WIRED_DRAFTS).toEqual([14, 16, 18, 22, 23]);
    for (const v of [14, 16, 18, 22, 23]) expect(isWiredDraft(v)).toBe(true);
    for (const v of [15, 17, 19, 20, 21, 24]) expect(isWiredDraft(v)).toBe(false);
  });

  it('uses the request-stream model from draft 18 on', () => {
    expect(isRequestStreamDraft(14)).toBe(false);
    expect(isRequestStreamDraft(16)).toBe(false);
    expect(isRequestStreamDraft(18)).toBe(true);
    expect(isRequestStreamDraft(22)).toBe(true);
    expect(isRequestStreamDraft(23)).toBe(true);
    expect(isRequestStreamDraft(undefined)).toBe(false);
  });

  it('identifies draft 22', () => {
    expect(isDraft22(18)).toBe(false);
    expect(isDraft22(22)).toBe(true);
    expect(isDraft22(23)).toBe(true);
    expect(isDraft22(undefined)).toBe(false);
  });

  it('identifies draft 23', () => {
    expect(isDraft23(22)).toBe(false);
    expect(isDraft23(23)).toBe(true);
    expect(isDraft23(undefined)).toBe(false);
  });
});
