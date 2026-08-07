import { describe, expect, it } from 'vitest';
import { explicitRelayUrl, relayOrigin, relayCandidates, parseCertHashHex } from './relay-url.js';

describe('explicitRelayUrl', () => {
  it('preserves an explicitly configured endpoint byte-exactly, including path and encoded query', () => {
    const url = 'https://10.64.17.14:4433/moq-relay?token=a%2Fb';
    expect(explicitRelayUrl(`?url=${encodeURIComponent(url)}`)).toBe(url);
  });

  it('returns undefined when ?url= is absent', () => {
    expect(explicitRelayUrl('')).toBeUndefined();
    expect(explicitRelayUrl('?ns=live')).toBeUndefined();
  });

  it('returns undefined for an empty ?url=', () => {
    expect(explicitRelayUrl('?url=')).toBeUndefined();
  });
});

describe('relayOrigin', () => {
  it('derives https://<host>:4433 from a hostname', () => {
    expect(relayOrigin('relay.example.com')).toBe('https://relay.example.com:4433');
  });

  it('accepts an IPv4 literal', () => {
    expect(relayOrigin('10.64.17.14')).toBe('https://10.64.17.14:4433');
  });

  it('brackets a bare IPv6 hostname', () => {
    expect(relayOrigin('::1')).toBe('https://[::1]:4433');
  });

  it('leaves a pre-bracketed IPv6 hostname untouched', () => {
    expect(relayOrigin('[::1]')).toBe('https://[::1]:4433');
  });

  it('never retains the page (Vite) port — hostname only feeds the origin', () => {
    // The old default appended ":4433" to the full origin, producing
    // "http://localhost:5173:4433". Hostname-based derivation cannot.
    expect(relayOrigin('localhost')).toBe('https://localhost:4433');
  });

  it('throws an actionable error for an empty hostname instead of silently assuming localhost', () => {
    expect(() => relayOrigin('')).toThrow(/hostname/i);
    expect(() => relayOrigin('')).toThrow(/\?url=/);
  });
});

describe('relayCandidates', () => {
  it('returns exactly [/moq, /moq-relay, /] on the derived origin, in that order', () => {
    expect(relayCandidates('relay.example.com')).toEqual([
      'https://relay.example.com:4433/moq',
      'https://relay.example.com:4433/moq-relay',
      'https://relay.example.com:4433/',
    ]);
  });

  it('brackets IPv6 in every candidate', () => {
    expect(relayCandidates('::1')).toEqual([
      'https://[::1]:4433/moq',
      'https://[::1]:4433/moq-relay',
      'https://[::1]:4433/',
    ]);
  });
});

describe('parseCertHashHex', () => {
  it('round-trips plain hex to bytes', () => {
    const buf = parseCertHashHex('abcd01');
    expect(Array.from(new Uint8Array(buf))).toEqual([0xab, 0xcd, 0x01]);
  });

  it('strips separators (colons, spaces) before parsing', () => {
    const buf = parseCertHashHex('AB:CD 01');
    expect(Array.from(new Uint8Array(buf))).toEqual([0xab, 0xcd, 0x01]);
  });

  it('throws on an odd number of hex chars', () => {
    expect(() => parseCertHashHex('abc')).toThrow(/odd number of hex chars/);
  });
});
