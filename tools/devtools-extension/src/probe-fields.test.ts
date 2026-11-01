import { describe, expect, it } from 'vitest';
import { parseProbeFields } from './probe-fields.js';

describe('Probe identity input', () => {
  it('preserves whitespace and empty comma-delimited fields', () => {
    expect(parseProbeFields(' a,,b ')).toEqual([' a', '', 'b ']);
  });
  it('uses only an entirely blank input for no fields', () => {
    expect(parseProbeFields('')).toEqual([]);
    expect(parseProbeFields(' ')).toEqual([' ']);
  });
  it('allows exact field boundaries through a JSON string array', () => {
    expect(parseProbeFields('["a,b","live/show",""," x "]')).toEqual(['a,b', 'live/show', '', ' x ']);
    expect(parseProbeFields('[]')).toEqual([]);
    expect(parseProbeFields('[""]')).toEqual(['']);
  });
  it.each(['["a",1]', '[null]', '["unterminated'])('refuses malformed or non-string array input %s', text => {
    expect(() => parseProbeFields(text)).toThrow();
  });
  it('keeps simple existing input unchanged', () => {
    expect(parseProbeFields('live,show')).toEqual(['live', 'show']);
    expect(parseProbeFields('video-360')).toEqual(['video-360']);
  });
});
