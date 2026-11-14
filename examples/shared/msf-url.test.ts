/**
 * MSF URL fragment tests (draft-ietf-moq-msf-01 §11.1).
 *
 * Cover the fragments of the draft's own URLs (§11.1.3), the namespace-name
 * encoding (§11.1.2), `c4m` and `connection` (§11.1.1), and every refusal.
 * Vectors marked "moqxr" are shared with that implementation's
 * `tests/msf_url_test.cpp` so the two parse the same links alike.
 *
 * @module
 */
import { describe, it, expect } from 'vitest';
import { parseMsfFragment } from './msf-url.js';

const DRAFT_TOKEN = 'gqhkYWxnIGVzaGFyqGR0eXBNhdZ9hdWQAY3VybGZlbWlzcwZleWV2aW5uZWlhdGVwQWNyZW5lYnJmcmVqMTIzNDU2NzgwMHZpc3VlZF9hdD0xNzMwNDM';
const fragment = (parameters: string) => parseMsfFragment(`msf:ns--t&${parameters}`);

describe('MSF URL fragment — draft examples (§11.1.3)', () => {
    it('reads the catalog of a three-field namespace', () => {
        expect(parseMsfFragment('msf:customer-livestream-123--catalog')).toEqual({
            namespace: ['customer', 'livestream', '123'], trackName: 'catalog', parameters: [],
        });
    });

    it('reads a non-catalog track with a required WebTransport connection', () => {
        const parsed = parseMsfFragment('msf:customerID-broadcastID--video&connection=wt');
        expect(parsed.trackName).toBe('video');
        expect(parsed.connection).toBe('wt');
    });

    it('returns a subclip range by name, uninterpreted', () => {
        expect(parseMsfFragment('msf:customerID-broadcastID--catalog&location-range=34-64').parameters)
            .toEqual([{ name: 'location-range', value: '34-64' }]);
    });

    it('reads a client token', () => {
        const parsed = parseMsfFragment(`msf:customerID-broadcastID--catalog&c4m=${DRAFT_TOKEN}`);
        expect(parsed.c4m).toHaveLength(87);
        expect(Array.from(parsed.c4m!.subarray(0, 4))).toEqual([0x82, 0xa8, 0x64, 0x61]);
        expect(parsed.parameters).toEqual([]);
    });
});

describe('MSF URL fragment — namespace-name string (§11.1.2)', () => {
    it.each([
        [['a-b'], 't', 'a.2db--t'],
        [['a.b'], 't', 'a.2eb--t'],
        [['a/b'], 't', 'a.2fb--t'],
        [['a b'], 't', 'a.20b--t'],
        [['é'], 't', '.c3.a9--t'],
        [['one'], 'two-three', 'one--two.2dthree'],
        [['a_b', 'C9'], '_', 'a_b-C9--_'],
        [['~'], '%', '.7e--.25'],
    ])('reads %j / %j from %s (moqxr)', (namespace, trackName, encoded) => {
        expect(parseMsfFragment(`msf:${encoded}`)).toMatchObject({ namespace, trackName });
    });

    it('accepts upper-case and unnecessary escapes on input (moqxr)', () => {
        expect(parseMsfFragment('msf:a.2Db--.74').namespace).toEqual(['a-b']);
        expect(parseMsfFragment('msf:a.2Db--.74').trackName).toBe('t');
    });

    it.each([
        ['nodelimiter', 'no "--"'],
        ['a--b--c', 'more than one "--"'],
        ['a----t', 'more than one "--"'],
        ['a--', 'empty track name'],
        ['--t', 'empty namespace field'],
        ['a-b---t', 'must be escaped'],
        ['a.2--t', 'two hexadecimal digits'],
        ['a.zz--t', 'two hexadecimal digits'],
        ['a--t.', 'two hexadecimal digits'],
        ['a~b--t', 'must be escaped'],
        ['a/b--t', 'must be escaped'],
        ['a%2Db--t', 'must be escaped'],
        ['a.ff--t', 'not valid UTF-8'],
        ['', 'no "--"'],
    ])('refuses %j', (encoded, message) => {
        expect(() => parseMsfFragment(`msf:${encoded}`)).toThrow(message);
    });
});

describe('MSF URL fragment — parameters (§11.1, §11.1.1)', () => {
    it('preserves non-reserved parameters verbatim and in order (moqxr)', () => {
        expect(fragment('alpha=1&beta=2&alpha=&x=a=b&p=%26/%3F').parameters).toEqual([
            { name: 'alpha', value: '1' }, { name: 'beta', value: '2' }, { name: 'alpha', value: '' },
            { name: 'x', value: 'a=b' }, { name: 'p', value: '%26/%3F' },
        ]);
    });

    it('matches reserved names case-sensitively (moqxr)', () => {
        const parsed = fragment('Connection=q&C4M=!');
        expect(parsed.connection).toBeUndefined();
        expect(parsed.c4m).toBeUndefined();
        expect(parsed.parameters).toEqual([{ name: 'Connection', value: 'q' }, { name: 'C4M', value: '!' }]);
    });

    it.each([
        ['msf:ns--t&noequals', 'no "="'],
        ['msf:ns--t&=1', 'empty name'],
        ['msf:ns--t&&x=1', 'empty parameter'],
        ['msf:ns--t&x=1&', 'empty parameter'],
        ['msf:ns--t&', 'empty parameter'],
        ['msf:ns--t&x=a?b', 'grammar'],
        ['msf:ns--t&x=a#b', 'grammar'],
        ['msf:ns--t&x=a b', 'grammar'],
        ['msf:ns--t&x=%2', 'grammar'],
        ['msf:ns--t?x=1', 'grammar'],
        ['#msf:ns--t', '"msf:"'],
    ])('refuses %j', (text, message) => {
        expect(() => parseMsfFragment(text)).toThrow(message);
    });

    it('reads connection and refuses other values and repeats (moqxr)', () => {
        expect(fragment('connection=q').connection).toBe('q');
        expect(fragment('connection=wt').connection).toBe('wt');
        expect(parseMsfFragment('msf:ns--t').connection).toBeUndefined();
        expect(fragment('connection=q').parameters).toEqual([]);
        for (const bad of ['connection=tcp', 'connection=Q', 'connection=', 'connection=q&connection=wt', 'connection=q&connection=q']) {
            expect(() => fragment(bad)).toThrow('"connection"');
        }
    });
});

describe('MSF URL fragment — c4m (§11.1.1)', () => {
    it.each([
        ['AAH+/w==', [0, 1, 254, 255]],     // base64, RFC 4648 §4
        ['AAH-_w==', [0, 1, 254, 255]],     // base64url, padded
        ['AAH-_w', [0, 1, 254, 255]],       // base64url, unpadded
        ['YWJj', [97, 98, 99]],
        ['YWI=', [97, 98]],
        ['YWI', [97, 98]],
        ['YQ', [97]],
    ])('decodes %j', (value, expected) => {
        expect(Array.from(fragment(`c4m=${value}`).c4m!)).toEqual(expected);
    });

    it.each([
        '', '=', 'Y', 'YWJjZ', 'Y===', 'YQ=', 'YWJj=', 'YWJj====', 'YR==', 'YR', 'YWJ', 'Y=Q=', '=YQ=',
        'AAH+/w',       // base64 with its padding removed
        'AAH+_w==',     // mixed alphabets
        'YW.j', 'YW%6Aj', 'base64:YWJj',
    ])('refuses %j without echoing it', (value) => {
        let message = '';
        try { fragment(`alpha=1&c4m=${value}`); } catch (error) { message = (error as Error).message; }
        expect(message).toBe('MSF URL "c4m" is not a valid base64 token (§11.1.1)');
    });

    it('does not decode the token fragment of §11.1.1, which is cut short for display', () => {
        expect(() => fragment('c4m=gqhkYWxnIGVzaGFyqGR0eXBNhdZ9hdWQAY3VybGZlbWlzcwZleWV2aW5uZWlhdGVwQWNyZW5lY')).toThrow('"c4m"');
    });

    it('refuses a repeated token (moqxr)', () => {
        expect(() => fragment('c4m=YQ&c4m=Yg')).toThrow('repeats the "c4m"');
        expect(() => fragment('c4m=YQ&c4m=YQ')).toThrow('repeats the "c4m"');
    });

    it('bounds the decoded token at 32 KiB', () => {
        expect(fragment(`c4m=${'A'.repeat(43691)}`).c4m).toHaveLength(32768);
        expect(() => fragment(`c4m=${'A'.repeat(43692)}`)).toThrow('"c4m"');
    });
});
