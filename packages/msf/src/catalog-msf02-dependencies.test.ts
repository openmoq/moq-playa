import { describe, expect, it } from 'vitest';
import { parseMsfCatalog, resolveDependencies, resolveTrackDependencies, trackIdentityKey } from './index.js';
const base = { name: 'v', packaging: 'loc', isLive: true };
const parse = (tracks: unknown[]) => parseMsfCatalog(JSON.stringify({ version: 'draft-02', tracks }));

describe('MSF-02 dependency resolution', () => {
    it.each([['missing'], [7], [true], ['v'], ['\uDEAD'], ['\0'], 'v'].map(depends => ({ depends })))('rejects unresolved or malformed dependencies $depends', ({ depends }) => {
        expect(() => parse([{ ...base, depends }])).toThrow(/depend|surrogate|NUL/i);
    });
    it('rejects ambiguous names across namespaces', () => {
        expect(() => parse([{ ...base, namespace: 'a' }, { ...base, namespace: 'b' },
            { ...base, name: 'e', depends: ['v'] }])).toThrow(/depend/i);
    });
    it('resolves ordered names and render groups to full identities across namespaces', () => {
        const { tracks } = parse([{ ...base, namespace: 'a', renderGroup: 1 },
            { ...base, name: 'a', namespace: 'b', renderGroup: 1 },
            { ...base, name: 'e', namespace: 'c', depends: ['a', 1] }]);
        const result = resolveTrackDependencies(tracks[2]!, tracks, { msfDraft: 'draft-02' });
        expect(result.map(trackIdentityKey)).toEqual([tracks[1], tracks[0]].map(t => trackIdentityKey(t!)));
        expect(resolveDependencies(tracks[2]!, tracks, { msfDraft: 'draft-02' }).map(t => t.name)).toEqual(['a', 'v', 'e']);
        expect(() => resolveDependencies(tracks[2]!, tracks)).toThrow();
        const self = parse([{ ...base, renderGroup: 1, depends: [1] }]).tracks;
        expect(resolveTrackDependencies(self[0]!, self, { msfDraft: 'draft-02' })).toEqual([]);
    });
});

it('resolves the only other same-named track across namespaces', () => {
    const { tracks } = parse([{ ...base, namespace: 'a', depends: ['v'] }, { ...base, namespace: 'b' }]);
    expect(resolveTrackDependencies(tracks[0]!, tracks, { msfDraft: 'draft-02' })).toEqual([tracks[1]]);
});

it('cites the declared dependency dialect in legacy resolver failures', () => {
    expect(() => resolveTrackDependencies({ ...base, packaging: 'loc', depends: ['missing'] }, [])).toThrow(/MSF-01 §5.2.14/);
});
