import { describe, expect, it } from 'vitest';
import { validateConfig, type MoqtPlayerConfig } from './config.js';
const config = (overrides: Partial<MoqtPlayerConfig>): MoqtPlayerConfig => ({ url: 'https://relay.example/moq', namespace: ['live'], ...overrides });

describe('audio language configuration', () => {
  it('accepts an ordered list, wildcard or empty preference with no default added', () => {
    for (const audioLanguages of [Object.freeze(['es', 'en-US']), ['*'], []]) {
      expect(() => validateConfig(config({ audioLanguages }))).not.toThrow();
    }
    expect(() => validateConfig(config({}))).not.toThrow();
  });
  it.each(['en_US', 'en-*-US', 'en--US'])('rejects malformed language preference %j', range => {
    expect(() => validateConfig(config({ audioLanguages: ['en', range] }))).toThrow(/language range/);
  });
  it('rejects a non-array preference list from an untyped caller', () => {
    expect(() => validateConfig(config({ audioLanguages: 'en' as unknown as readonly string[] }))).toThrow(/audioLanguages/);
    expect(() => validateConfig(config({ audioLanguages: [42] as unknown as readonly string[] }))).toThrow(/audioLanguages/);
  });
  it('ignores selectors for disabled audio', () => {
    expect(() => validateConfig(config({ disableAudio: true, audioLanguages: ['bad_range'] }))).not.toThrow();
  });
});
