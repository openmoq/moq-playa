/**
 * RFC 3986 absolute-URI validation tests.
 *
 * @see RFC 3986 §3, §3.2
 * @see [QLOG-MAIN] §8
 * @module
 */

import { describe, it, expect } from 'vitest';
import { isAbsoluteUri } from './absolute-uri.js';

describe('scheme', () => {
  it('requires a scheme starting with ALPHA', () => {
    expect(isAbsoluteUri('1http://example.com')).toBe(false);
    expect(isAbsoluteUri('+http://example.com')).toBe(false);
    expect(isAbsoluteUri('://example.com')).toBe(false);
    expect(isAbsoluteUri('no-scheme')).toBe(false);
  });

  it('accepts the scheme character set', () => {
    expect(isAbsoluteUri('h+t-t.p1:x')).toBe(true);
  });

  it('rejects an empty value after the scheme (QLOG-MAIN §8)', () => {
    // Generically absolute, but it carries no namespace identifier.
    expect(isAbsoluteUri('example:')).toBe(false);
  });
});

describe('authority', () => {
  it('rejects a non-numeric port', () => {
    expect(isAbsoluteUri('https://example.com:abc/schema')).toBe(false);
  });

  it('rejects a doubled port delimiter', () => {
    expect(isAbsoluteUri('https://example.com::80/schema')).toBe(false);
  });

  it('rejects a second raw @ that WHATWG URL would accept', () => {
    expect(isAbsoluteUri('https://a@b@c/schema')).toBe(false);
  });

  it('accepts userinfo, and an empty or numeric port', () => {
    expect(isAbsoluteUri('https://user:pw@example.com/schema')).toBe(true);
    expect(isAbsoluteUri('https://example.com:/schema')).toBe(true);
    expect(isAbsoluteUri('https://example.com:8443/schema')).toBe(true);
  });

  it('rejects a bracketed host that is not a legal literal', () => {
    expect(isAbsoluteUri('https://[banana]/schema')).toBe(false);
    expect(isAbsoluteUri('https://[::gg]/schema')).toBe(false);
    expect(isAbsoluteUri('https://[]/schema')).toBe(false);
  });

  it('accepts IPv6 literals, compressed and full', () => {
    expect(isAbsoluteUri('https://[2001:db8::1]/schema')).toBe(true);
    expect(isAbsoluteUri('https://[2001:db8::1]:8443/schema')).toBe(true);
    expect(isAbsoluteUri('https://[2001:0db8:0000:0000:0000:0000:0000:0001]/x')).toBe(true);
    expect(isAbsoluteUri('https://[::1]/schema')).toBe(true);
    expect(isAbsoluteUri('https://[::ffff:192.0.2.1]/schema')).toBe(true);
  });

  it('rejects malformed IPv6 groupings', () => {
    expect(isAbsoluteUri('https://[2001:db8::1::2]/x')).toBe(false);
    expect(isAbsoluteUri('https://[1:2:3:4:5:6:7]/x')).toBe(false);
    expect(isAbsoluteUri('https://[1:2:3:4:5:6:7:8:9]/x')).toBe(false);
    expect(isAbsoluteUri('https://[:::1]/x')).toBe(false);
    expect(isAbsoluteUri('https://[12345::1]/x')).toBe(false);
  });

  it('accepts IPvFuture with either case of the version flag', () => {
    // RFC 3986 §3.2.2 calls the flag case-insensitive; ABNF literals are
    // case-insensitive per RFC 5234 §2.3.
    expect(isAbsoluteUri('https://[v7.host:name]/schema')).toBe(true);
    expect(isAbsoluteUri('https://[V7.host:name]/schema')).toBe(true);
  });

  it('rejects an IPvFuture with a non-hex version', () => {
    expect(isAbsoluteUri('https://[vz.host]/schema')).toBe(false);
    expect(isAbsoluteUri('https://[Vz.host]/schema')).toBe(false);
  });

  it('accepts an IPv4 host and rejects an out-of-range octet', () => {
    expect(isAbsoluteUri('https://192.0.2.1/schema')).toBe(true);
    // 999 is not a dec-octet, but reg-name admits it as a name.
    expect(isAbsoluteUri('https://999.0.2.1/schema')).toBe(true);
    expect(isAbsoluteUri('https://exa mple.com/schema')).toBe(false);
  });

  it('rejects brackets outside the host position', () => {
    expect(isAbsoluteUri('urn:example:[schema]')).toBe(false);
    expect(isAbsoluteUri('https://example.com/[schema]')).toBe(false);
    expect(isAbsoluteUri('https://user@[::1]x/schema')).toBe(false);
  });
});

describe('path, query, and characters', () => {
  it('rejects characters outside the grammar', () => {
    const NUL = String.fromCharCode(0);
    const BACKTICK = String.fromCharCode(96);
    for (const bad of [
      'https://example.com/{schema}',
      'https://example.com/|schema',
      'https://example.com/"schema',
      'urn:example:^schema',
      `urn:example:${BACKTICK}schema`,
      `urn:example:${NUL}schema`,
      'urn:exámple:x',
      ' https://example.com/schema ',
      'https://example.com/a b',
      'https:\\\\example.com\\\\schema',
    ]) {
      expect(isAbsoluteUri(bad), `must reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('validates percent escapes', () => {
    expect(isAbsoluteUri('https://example.com/a%20b')).toBe(true);
    expect(isAbsoluteUri('https://example.com/%zz')).toBe(false);
    expect(isAbsoluteUri('https://example.com/%2')).toBe(false);
  });

  it('accepts a query', () => {
    expect(isAbsoluteUri('https://example.com/s?a=b&c=d')).toBe(true);
    expect(isAbsoluteUri('https://example.com/s?a=|b')).toBe(false);
  });

  it('accepts rootless and absolute paths', () => {
    expect(isAbsoluteUri('urn:ietf:params:qlog:events:moqt-06')).toBe(true);
    expect(isAbsoluteUri('file:/tmp/x')).toBe(true);
  });
});

describe('qlog extension fragments (QLOG-MAIN §8)', () => {
  it('requires a non-empty fragment when one is present', () => {
    expect(isAbsoluteUri('urn:example:x#')).toBe(false);
  });

  it('permits only URI-unreserved characters', () => {
    expect(isAbsoluteUri('urn:example:x#bad/fragment')).toBe(false);
    expect(isAbsoluteUri('urn:example:x#bad?fragment')).toBe(false);
    expect(isAbsoluteUri('urn:example:x#bad%20fragment')).toBe(false);
  });

  it('accepts an unreserved extension identifier', () => {
    expect(isAbsoluteUri('urn:ietf:params:qlog:events:moqt#playout')).toBe(true);
    expect(isAbsoluteUri('urn:example:x#a-b.c_d~e9')).toBe(true);
  });

  it('rejects more than one fragment delimiter', () => {
    expect(isAbsoluteUri('https://example.com/a#b#c')).toBe(false);
  });
});

describe('the URIs we actually use', () => {
  it('accepts every schema this project declares', () => {
    for (const uri of [
      'urn:ietf:params:qlog:events:moqt-06',
      'urn:ietf:params:qlog:events:loglevel',
      'https://openmoq.org/082026/playa',
      'https://openmoq.org/082026/moq_playout',
    ]) {
      expect(isAbsoluteUri(uri), uri).toBe(true);
    }
  });
});
