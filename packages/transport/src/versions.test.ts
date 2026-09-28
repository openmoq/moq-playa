import { describe, it, expect } from 'vitest';
import { isDraft21, isRequestStreamDraft, isWiredDraft, WIRED_DRAFTS } from './versions.js';

describe('draft versions', () => {
  it('wires drafts 14, 16, 18 and 21 only', () => {
    expect(WIRED_DRAFTS).toEqual([14, 16, 18, 21]);
    for (const v of [14, 16, 18, 21]) expect(isWiredDraft(v)).toBe(true);
    for (const v of [15, 17, 19, 20, 22]) expect(isWiredDraft(v)).toBe(false);
  });

  it('uses the request-stream model from draft 18 on', () => {
    expect(isRequestStreamDraft(14)).toBe(false);
    expect(isRequestStreamDraft(16)).toBe(false);
    expect(isRequestStreamDraft(18)).toBe(true);
    expect(isRequestStreamDraft(21)).toBe(true);
    expect(isRequestStreamDraft(undefined)).toBe(false);
  });

  it('identifies draft 21', () => {
    expect(isDraft21(18)).toBe(false);
    expect(isDraft21(21)).toBe(true);
    expect(isDraft21(undefined)).toBe(false);
  });
});
