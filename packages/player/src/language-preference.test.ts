import { describe, expect, it } from 'vitest';
import { preferredLanguage } from './language-preference.js';

const en = { name: 'english', lang: 'en' };
const us = { name: 'us', lang: 'en-US' };
const gb = { name: 'gb', lang: 'en-GB' };
const es = { name: 'spanish', lang: 'es' };

describe('audio language preference policy', () => {
  it('honors preference order before catalog order', () => {
    expect(preferredLanguage([en, es], ['es', 'en'])).toBe(es);
  });

  it('compares ASCII tags case-insensitively without changing returned metadata', () => {
    expect(preferredLanguage([us, es], ['EN-us'])).toBe(us);
    expect(us.lang).toBe('en-US');
  });

  it('prefers an exact tag over regional variants in the same candidate pool', () => {
    expect(preferredLanguage([us, en, gb], ['en'])).toBe(en);
  });

  it('accepts a regional variant for a general preference in catalog order', () => {
    expect(preferredLanguage([es, gb, us], ['en'])).toBe(gb);
    expect(preferredLanguage([us, gb, es], ['en'])).toBe(us);
  });

  it('exhausts one preferred range before trying the next', () => {
    expect(preferredLanguage([es, en], ['en-AU', 'es'])).toBe(en);
  });

  it('does not treat a partial subtag as a match', () => {
    expect(preferredLanguage([{ lang: 'eng' }, es], ['en'])).toBeUndefined();
  });

  it('removes a dangling extension singleton while falling back', () => {
    const extension = { lang: 'de-DE-a' };
    const de = { lang: 'de-DE' };
    expect(preferredLanguage([extension, de], ['de-DE-a-foo'])).toBe(de);
  });

  it('does not turn a private-use singleton into a wildcard', () => {
    expect(preferredLanguage([{ lang: 'x-other' }], ['x-private'])).toBeUndefined();
  });

  it('skips wildcard preferences so the caller applies its stated default', () => {
    expect(preferredLanguage([en, es], ['*', 'es'])).toBe(es);
    expect(preferredLanguage([en, es], ['*'])).toBeUndefined();
  });

  it('never borrows candidates or guesses a missing language', () => {
    expect(preferredLanguage<{ name: string; lang?: string }>([en, { name: 'unlabelled' }], ['es'])).toBeUndefined();
    expect(preferredLanguage([], ['es'])).toBeUndefined();
    expect(preferredLanguage([en, es], [])).toBeUndefined();
  });

  it.each(['en_*', 'en-*-US', ' en', 'en\n', '', 'en--US', 'é', 'abcdefghi'])('refuses an invalid basic range %j', range => {
    expect(() => preferredLanguage([en], [range])).toThrow(/language range/);
  });

  it('validates the entire preference list before choosing a match', () => {
    expect(() => preferredLanguage([en], ['en', 'invalid_range'])).toThrow(/language range/);
  });

  it('does not reorder frozen catalog or preference arrays', () => {
    const candidates = Object.freeze([es, en]);
    const preferences = Object.freeze(['en', 'es']);
    expect(preferredLanguage(candidates, preferences)).toBe(en);
    expect(candidates).toEqual([es, en]);
    expect(preferences).toEqual(['en', 'es']);
  });
});
