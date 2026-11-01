/**
 * Namespace provenance at the real normalization and validation boundary.
 *
 * A track namespace is an ORDERED SET OF FIELDS compared as exact bytes —
 * transport §2.4.1 in draft-22 (0–32 fields), draft-18 (0–32) and draft-16
 * (1–32). A display string is not that identity: under this player's
 * convention `['live/show']` is one field and `'live/show'` is two, and the
 * two are different namespaces on the wire that happen to print the same.
 *
 * Every identity in the catalog package now routes through one shared
 * contract, so these tests pin what that contract decides: what the parsers
 * and deltas resolve, what they refuse to accept from the wire, and the
 * behavior that had to survive the change. Each case states the structure it
 * asserts — exact field arrays — rather than the absence of a thrown error.
 *
 * @see draft-ietf-moq-transport-22 §2.4.1, draft-ietf-moq-msf-01 §5.2.2/§5.2.3
 * @see draft-ietf-moq-catalogformat-01 §3.2.9
 */
import { describe, expect, it } from 'vitest';
import type { CatalogState, CatalogTrack } from '@openmoq/msf';
import {
  applyCatalogUpdate, applyCf01Patch, applyMsf01Delta, buildCatalog, identityKey,
  parseCatalogFormat01, parseDeltaUpdate, parseMsfCatalog,
} from '@openmoq/msf';
import { buildCatalogSelection, resolveSelection, trackIdentityKey } from './catalog-selection.js';

/** The configured namespace as the player would flatten it for the parser. */
const DISPLAY = 'live/show';

const msfCatalog = (tracks: Array<Record<string, unknown>>): string => JSON.stringify({
  version: '1',
  tracks: tracks.map(t => ({ packaging: 'loc', isLive: true, role: 'video', codec: 'av01', ...t })),
});

const cf01Catalog = (body: Record<string, unknown>): string => JSON.stringify({
  version: 1, streamingFormat: 1, streamingFormatVersion: '0.2', ...body,
});

/** The configured namespace as ONE field that happens to contain a slash. */
const ONE_FIELD = ['live/show'] as const;
/** The same text as catalog-declared text, which our convention splits. */
const AS_TEXT = 'live/show';

describe('namespace provenance — wire identity vs display text', () => {
  describe('a one-field context is not the same namespace as two-field text', () => {
    it('MSF keeps an inherited one-field namespace distinct from declared text', () => {
      // Configured ['live/show'] is ONE field. A track that omits `namespace`
      // inherits exactly that. A track that DECLARES "live/show" is catalog
      // text, which this player's convention canonicalizes to two fields.
      // Different namespaces, so §5.2.3 does not make the names collide.
      const parsed = parseMsfCatalog(msfCatalog([
        { name: 'camera' },
        { name: 'camera', namespace: AS_TEXT },
      ]), ONE_FIELD);
      expect(parsed.tracks.map(t => t.resolvedNamespace?.fields)).toEqual([
        ['live/show'],
        ['live', 'show'],
      ]);
      expect(parsed.tracks.map(t => t.resolvedNamespace?.source)).toEqual(['inherited', 'declared']);
    });

    it('cf01 keeps the same pair distinct', () => {
      const parsed = parseCatalogFormat01(cf01Catalog({
        tracks: [
          { name: 'camera', selectionParams: { codec: 'av01' } },
          { name: 'camera', namespace: AS_TEXT, selectionParams: { codec: 'av01' } },
        ],
      }), ONE_FIELD);
      expect(parsed.catalog.tracks.map(t => t.resolvedNamespace?.fields)).toEqual([
        ['live/show'],
        ['live', 'show'],
      ]);
    });

    it('a uniqueness key cannot be collided by a delimiter', () => {
      // Independent of tuples: `${namespace}\0${name}` maps these two distinct
      // pairs to one key, and neither format excludes NUL from either part.
      const parsed = parseMsfCatalog(msfCatalog([
        { name: 'c', namespace: 'a\u0000b' },
        { name: 'b\u0000c', namespace: 'a' },
      ]), DISPLAY);
      expect(parsed.tracks).toHaveLength(2);
    });
  });

  describe('deltas on a genuinely valid pair', () => {
    /** Two legal, wire-distinct identities built through the real parser. */
    const validPair = (): CatalogState => parseMsfCatalog(msfCatalog([
      { name: 'camera' },
      { name: 'camera', namespace: AS_TEXT },
    ]), ONE_FIELD) as CatalogState;

    it('adding a wire-distinct track of the same name is legal', () => {
      const base = parseMsfCatalog(msfCatalog([{ name: 'camera' }]),
        ONE_FIELD) as CatalogState;
      const next = applyMsf01Delta(base, {
        version: 1,
        deltaUpdate: [{ op: 'add', tracks: [
          { name: 'camera', namespace: AS_TEXT, packaging: 'loc', isLive: true,
            role: 'video', codec: 'av01' },
        ] }],
      } as never, ONE_FIELD);
      expect(next.tracks.map(t => t.resolvedNamespace?.fields)).toEqual([
        ['live/show'],
        ['live', 'show'],
      ]);
    });

    it('removing the declared-text identity keeps the inherited one', () => {
      const next = applyMsf01Delta(validPair(), {
        version: 1,
        deltaUpdate: [{ op: 'remove', tracks: [{ name: 'camera', namespace: AS_TEXT }] }],
      } as never, ONE_FIELD);
      expect(next.tracks).toHaveLength(1);
      expect(next.tracks[0]!.resolvedNamespace?.fields).toEqual(['live/show']);
      expect(next.tracks[0]!.resolvedNamespace?.source).toBe('inherited');
    });

    it('removing the inherited identity keeps the declared-text one', () => {
      const next = applyMsf01Delta(validPair(), {
        version: 1,
        deltaUpdate: [{ op: 'remove', tracks: [{ name: 'camera' }] }],
      } as never, ONE_FIELD);
      expect(next.tracks).toHaveLength(1);
      expect(next.tracks[0]!.resolvedNamespace?.fields).toEqual(['live', 'show']);
    });
  });

  describe('the annotation is produced, never accepted', () => {
    it('ignores resolvedNamespace supplied in raw MSF catalog JSON', () => {
      // A catalog declares a namespace STRING and nothing else; the formats
      // have no syntax for wire fields, so a document claiming this
      // annotation is asserting something it cannot say.
      const parsed = parseMsfCatalog(msfCatalog([
        { name: 'spoof', resolvedNamespace: { fields: ['attacker'], source: 'declared' } },
      ]), ONE_FIELD);
      expect(parsed.tracks[0]!.resolvedNamespace).toEqual({
        fields: ['live/show'], source: 'inherited',
      });
    });

    it('ignores resolvedNamespace supplied in a cf01 catalog', () => {
      const parsed = parseCatalogFormat01(cf01Catalog({
        tracks: [{
          name: 'spoof', selectionParams: { codec: 'av01' },
          resolvedNamespace: { fields: ['attacker'], source: 'declared' },
        }],
      }), ONE_FIELD);
      expect(parsed.catalog.tracks[0]!.resolvedNamespace).toEqual({
        fields: ['live/show'], source: 'inherited',
      });
    });

    it('ignores resolvedNamespace supplied in a delta add entry', () => {
      const base = parseMsfCatalog(msfCatalog([{ name: 'first' }]), ONE_FIELD) as CatalogState;
      const next = applyMsf01Delta(base, {
        version: 1,
        deltaUpdate: [{ op: 'add', tracks: [{
          name: 'added', packaging: 'loc', isLive: true, role: 'video', codec: 'av01',
          resolvedNamespace: { fields: ['attacker'], source: 'declared' },
        }] }],
      } as never, ONE_FIELD);
      expect(next.tracks[1]!.resolvedNamespace).toEqual({
        fields: ['live/show'], source: 'inherited',
      });
    });
  });

  describe('missing context stays unresolved', () => {
    it('leaves an omitted namespace unresolved when no context is supplied', () => {
      // Inventing [] or [''] would assert a specific wire namespace nobody
      // supplied. The resolution is completed later against real context.
      const parsed = parseMsfCatalog(msfCatalog([{ name: 'contextless' }]));
      expect(parsed.tracks[0]!.resolvedNamespace).toBeUndefined();
      expect(parsed.tracks[0]!.namespace).toBeUndefined();
    });

    it('still rejects a genuine duplicate without context', () => {
      expect(() => parseMsfCatalog(msfCatalog([
        { name: 'same' }, { name: 'same' },
      ]))).toThrow(/[Dd]uplicate/);
    });

    it('resolves a declared namespace even without context', () => {
      const parsed = parseMsfCatalog(msfCatalog([{ name: 'declared', namespace: 'a/b' }]));
      expect(parsed.tracks[0]!.resolvedNamespace).toEqual({
        fields: ['a', 'b'], source: 'declared',
      });
    });
  });

  describe('field structure is preserved exactly', () => {
    it('treats zero fields and one empty field as different namespaces', () => {
      const none = parseMsfCatalog(msfCatalog([{ name: 't' }]), []);
      const empty = parseMsfCatalog(msfCatalog([{ name: 't' }]), ['']);
      expect(none.tracks[0]!.resolvedNamespace?.fields).toEqual([]);
      expect(empty.tracks[0]!.resolvedNamespace?.fields).toEqual(['']);
      expect(identityKey(none.tracks[0]!.resolvedNamespace!.fields, 't'))
        .not.toBe(identityKey(empty.tracks[0]!.resolvedNamespace!.fields, 't'));
    });

    it('maps the empty TEXT context to one empty field, as the convention implies', () => {
      // Our convention is split-on-slash, and ''.split('/') is [''] — one
      // empty field. Stated rather than left to be discovered.
      const parsed = parseMsfCatalog(msfCatalog([{ name: 't' }]), '');
      expect(parsed.tracks[0]!.resolvedNamespace?.fields).toEqual(['']);
    });

    it('does not retain a caller-mutable alias of the context array', () => {
      const context = ['live', 'show'];
      const parsed = parseMsfCatalog(msfCatalog([{ name: 't' }]), context);
      context[0] = 'mutated';
      expect(parsed.tracks[0]!.resolvedNamespace?.fields).toEqual(['live', 'show']);
    });
  });

  describe('clone parent resolution (msf-01 §5.2.34)', () => {
    /** Two same-name parents that print the same but are wire-distinct. */
    const twoParents = (): CatalogState => parseMsfCatalog(msfCatalog([
      { name: 'parent' },
      { name: 'parent', namespace: AS_TEXT },
    ]), ONE_FIELD) as CatalogState;

    const clone = (base: CatalogState, op: Record<string, unknown>) => applyMsf01Delta(base, {
      version: 1, deltaUpdate: [{ op: 'clone', tracks: [op] }],
    } as never, ONE_FIELD);

    it('assumes the catalog namespace when parentNamespace is omitted', () => {
      // §5.2.34: "If this field is missing from a clone operation, then the
      // namespace of the catalog is assumed." Not "any track of that name".
      const next = clone(twoParents(), { name: 'child', parentName: 'parent' });
      const child = next.tracks.find(t => t.name === 'child')!;
      expect(child.resolvedNamespace?.fields).toEqual(['live/show']);
    });

    it('uses an explicit parentNamespace when given', () => {
      const next = clone(twoParents(), {
        name: 'child', parentName: 'parent', parentNamespace: AS_TEXT,
      });
      const child = next.tracks.find(t => t.name === 'child')!;
      expect(child.resolvedNamespace?.fields).toEqual(['live', 'show']);
    });

    it('is not misled by an earlier same-name parent in another namespace', () => {
      const base = parseMsfCatalog(msfCatalog([
        { name: 'parent', namespace: 'decoy/space', bitrate: 111 },
        { name: 'parent', bitrate: 222 },
      ]), ONE_FIELD) as CatalogState;
      const next = clone(base, { name: 'child', parentName: 'parent' });
      const child = next.tracks.find(t => t.name === 'child')!;
      // The catalog namespace is assumed, so the SECOND parent is the source.
      expect(child.bitrate).toBe(222);
      expect(child.resolvedNamespace?.fields).toEqual(['live/show']);
    });

    it('does not carry the parent resolution into a clone that overrides it', () => {
      const next = clone(twoParents(), {
        name: 'child', parentName: 'parent', namespace: 'elsewhere/entirely',
      });
      const child = next.tracks.find(t => t.name === 'child')!;
      expect(child.resolvedNamespace).toEqual({
        fields: ['elsewhere', 'entirely'], source: 'declared',
      });
    });
  });

  describe('behavior that must survive the change', () => {
    it('rejects a duplicate under the plain string context, as it must', () => {
      // Passing the DISPLAY string means BOTH tracks canonicalize to the same
      // two fields, so these really are one identity declared twice.
      expect(() => parseMsfCatalog(msfCatalog([
        { name: 'camera' },
        { name: 'camera', namespace: DISPLAY },
      ]), DISPLAY)).toThrow(/[Dd]uplicate/);
    });

    it('rejects a genuine duplicate — same name, same resolved namespace', () => {
      expect(() => parseMsfCatalog(msfCatalog([
        { name: 'camera' }, { name: 'camera' },
      ]), DISPLAY)).toThrow(/[Dd]uplicate/);
    });

    it('lets an explicit track namespace override the inherited one', () => {
      const parsed = parseMsfCatalog(msfCatalog([
        { name: 'inherits' },
        { name: 'overrides', namespace: 'other/space' },
      ]), DISPLAY);
      expect(parsed.tracks.map(t => t.namespace)).toEqual([DISPLAY, 'other/space']);
    });

    it('keeps two same-name tracks in plainly different namespaces distinct', () => {
      const parsed = parseMsfCatalog(msfCatalog([
        { name: 'camera', namespace: 'ns/a' },
        { name: 'camera', namespace: 'ns/b' },
      ]), DISPLAY);
      expect(parsed.tracks).toHaveLength(2);
      const selection = buildCatalogSelection(parsed as CatalogState, { catalogNamespace: DISPLAY });
      const ids = selection.scopes.flatMap(s => s.video.flatMap(set => set.tracks.map(t => t.id)));
      expect(trackIdentityKey(ids[0]!)).not.toBe(trackIdentityKey(ids[1]!));
    });

    it('cf01 resolves namespace as track > commonTrackFields > catalog', () => {
      const parsed = parseCatalogFormat01(cf01Catalog({
        commonTrackFields: { packaging: 'loc', namespace: 'common/space' },
        tracks: [
          { name: 'from_common', selectionParams: { codec: 'av01' } },
          { name: 'from_track', namespace: 'track/space', selectionParams: { codec: 'av01' } },
        ],
      }), DISPLAY);
      expect(parsed.catalog.tracks.map(t => t.namespace)).toEqual(['common/space', 'track/space']);
    });

    it('cf01 falls back to the catalog namespace when nothing declares one', () => {
      const parsed = parseCatalogFormat01(cf01Catalog({
        tracks: [{ name: 'plain', selectionParams: { codec: 'av01' } }],
      }), DISPLAY);
      expect(parsed.catalog.tracks[0]!.namespace).toBe(DISPLAY);
    });

    it('a delta-added track inherits the catalog namespace', () => {
      const base = parseMsfCatalog(msfCatalog([{ name: 'first' }]), DISPLAY) as CatalogState;
      const next = applyMsf01Delta(base, {
        version: 1,
        deltaUpdate: [{ op: 'add', tracks: [
          { name: 'second', packaging: 'loc', isLive: true, role: 'video', codec: 'av01' },
        ] }],
      } as never, DISPLAY);
      expect(next.tracks.map(t => t.namespace)).toEqual([DISPLAY, DISPLAY]);
    });

    it('the model carries the parser’s resolved namespace into identity and exclusions', () => {
      const parsed = parseMsfCatalog(msfCatalog([
        { name: 'playable', namespace: 'ns/a' },
        { name: 'unplayable', namespace: 'ns/b', packaging: 'locmaf', locmafVersion: 'draft-99' },
      ]), DISPLAY);
      const selection = buildCatalogSelection(parsed as CatalogState, { catalogNamespace: DISPLAY });
      const offered = selection.scopes.flatMap(s => s.video.flatMap(set => set.tracks.map(t => t.id)));
      expect(offered).toEqual([{ namespaceFields: ['ns', 'a'], name: 'playable' }]);
      expect(selection.excluded.map(e => e.id))
        .toEqual([{ namespaceFields: ['ns', 'b'], name: 'unplayable' }]);
    });
  });

  describe('cf01 patch identity is field-aware, not display text (§3.3)', () => {
    const cf01Track = (extra: Record<string, unknown> = {}) =>
      ({ name: 'camera', packaging: 'loc', selectionParams: { codec: 'av01' }, ...extra });
    const cf01Doc = (tracks: Record<string, unknown>[]) => ({
      version: 1, streamingFormat: 1, streamingFormatVersion: '0.2', tracks,
    });

    it('rejects a replacement that turns zero fields into one empty field', () => {
      // Under a zero-field context an omitted namespace is the empty tuple,
      // while a declared '' is one empty field. Both PRINT as '', so a
      // display-text comparison would wave through a namespace change §3.3
      // forbids outright.
      const raw = cf01Doc([cf01Track()]);
      const base = parseCatalogFormat01(JSON.stringify(raw), []);
      expect(base.catalog.tracks[0]!.resolvedNamespace?.fields).toEqual([]);
      expect(() => applyCf01Patch(base.rawDocument, [
        { op: 'replace', path: '/tracks/0', value: cf01Track({ namespace: '' }) },
      ], [])).toThrow(/namespace/i);
    });

    it('allows a replacement that leaves the namespace exactly as it was', () => {
      const raw = cf01Doc([cf01Track()]);
      const base = parseCatalogFormat01(JSON.stringify(raw), []);
      const next = applyCf01Patch(base.rawDocument, [
        { op: 'replace', path: '/tracks/0', value: cf01Track({ isLive: true }) },
      ], []);
      expect(next.catalog.tracks[0]!.resolvedNamespace?.fields).toEqual([]);
    });

    it('still rejects a replacement that declares a different namespace', () => {
      const raw = cf01Doc([cf01Track({ namespace: 'other/space' })]);
      const base = parseCatalogFormat01(JSON.stringify(raw), ONE_FIELD);
      expect(() => applyCf01Patch(base.rawDocument, [
        { op: 'replace', path: '/tracks/0', value: cf01Track({ namespace: 'third/space' }) },
      ], ONE_FIELD)).toThrow(/namespace/i);
    });

    it('removes a declared namesake and leaves the inherited one in place', () => {
      // The survivor's namespace never changed. Re-deriving its key from the
      // display text 'live/show' would split it into two fields, make it look
      // newly added, and reject a legal removal.
      const base = parseCatalogFormat01(JSON.stringify(cf01Doc([
        cf01Track({ namespace: 'other/space' }), cf01Track(),
      ])), ONE_FIELD);
      const next = applyCf01Patch(base.rawDocument,
        [{ op: 'remove', path: '/tracks/0' }], ONE_FIELD);
      expect(next.catalog.tracks.map(t => t.resolvedNamespace?.fields))
        .toEqual([['live/show']]);
    });

    it('removes the inherited namesake and leaves the declared one in place', () => {
      const base = parseCatalogFormat01(JSON.stringify(cf01Doc([
        cf01Track(), cf01Track({ namespace: 'other/space' }),
      ])), ONE_FIELD);
      const next = applyCf01Patch(base.rawDocument,
        [{ op: 'remove', path: '/tracks/1' }], ONE_FIELD);
      expect(next.catalog.tracks.map(t => t.resolvedNamespace?.fields))
        .toEqual([['live/show']]);
    });

    it('still rejects a remove-and-re-add that lands the same name elsewhere', () => {
      // A whole-track ADD is not a path the raw check can judge, so this is
      // the effective-state comparison doing the work: the name reappears in
      // a namespace it did not occupy before.
      const base = parseCatalogFormat01(JSON.stringify(cf01Doc([
        cf01Track({ namespace: 'other/space' }),
      ])), ONE_FIELD);
      expect(() => applyCf01Patch(base.rawDocument, [
        { op: 'remove', path: '/tracks/0' },
        { op: 'add', path: '/tracks/-', value: cf01Track({ namespace: 'third/space' }) },
      ], ONE_FIELD)).toThrow(/namespace/i);
    });
  });

  describe('MSF-00 clone owns its namespace (§5.1.5, §5.1.36)', () => {
    const msf00 = (tracks: Array<Record<string, unknown>>) => parseMsfCatalog(JSON.stringify({
      version: 1,
      tracks: tracks.map(t => ({ packaging: 'loc', isLive: true, role: 'video', codec: 'av01', ...t })),
    }), ONE_FIELD) as CatalogState;
    const cloneDelta = (entry: Record<string, unknown>) => parseDeltaUpdate(JSON.stringify({
      deltaUpdate: true, cloneTracks: [entry],
    }));

    it('replaces the parent resolution when the clone declares a namespace', () => {
      const next = applyCatalogUpdate(msf00([{ name: 'parent' }]),
        cloneDelta({ name: 'child', parentName: 'parent', namespace: 'other/space' }), ONE_FIELD);
      const child = next.tracks.find(t => t.name === 'child')!;
      expect(child.namespace).toBe('other/space');
      expect(child.resolvedNamespace).toEqual({ fields: ['other', 'space'], source: 'declared' });
    });

    it('carries the parent’s resolution when the clone declares none', () => {
      const next = applyCatalogUpdate(msf00([{ name: 'parent', namespace: 'other/space' }]),
        cloneDelta({ name: 'child', parentName: 'parent' }), ONE_FIELD);
      const child = next.tracks.find(t => t.name === 'child')!;
      expect(child.resolvedNamespace).toEqual({ fields: ['other', 'space'], source: 'declared' });
    });

    it('carries an inherited one-field parent resolution unsplit', () => {
      const next = applyCatalogUpdate(msf00([{ name: 'parent' }]),
        cloneDelta({ name: 'child', parentName: 'parent' }), ONE_FIELD);
      const child = next.tracks.find(t => t.name === 'child')!;
      expect(child.resolvedNamespace).toEqual({ fields: ['live/show'], source: 'inherited' });
    });

    it('fails on an ambiguous bare parent name rather than taking the first', () => {
      // §5.1.36 identifies a parent by name alone and §5.1.11 makes names
      // unique only per namespace. This dialect has no parentNamespace field,
      // and msf-01 §5.2.34's default is not normative here.
      const base = msf00([{ name: 'parent' }, { name: 'parent', namespace: 'other/space' }]);
      expect(() => applyCatalogUpdate(base,
        cloneDelta({ name: 'child', parentName: 'parent' }), ONE_FIELD))
        .toThrow(/ambiguous/i);
    });

    it('still clones from an unambiguous parent that shares no name', () => {
      const next = applyCatalogUpdate(msf00([{ name: 'parent' }, { name: 'other' }]),
        cloneDelta({ name: 'child', parentName: 'parent', bitrate: 600000 }), ONE_FIELD);
      expect(next.tracks.map(t => t.name)).toEqual(['parent', 'other', 'child']);
    });

    it('leaves the parent untouched when the clone duplicates an identity', () => {
      const base = msf00([{ name: 'parent', namespace: 'other/space' }]);
      expect(() => applyCatalogUpdate(base,
        cloneDelta({ name: 'parent', parentName: 'parent' }), ONE_FIELD)).toThrow(/already exists/);
      expect(base.tracks).toHaveLength(1);
      expect(base.tracks[0]!.resolvedNamespace)
        .toEqual({ fields: ['other', 'space'], source: 'declared' });
    });
  });

  describe('the model requires real context rather than inventing it', () => {
    it('refuses to resolve an offered track with no namespace and no context', () => {
      const parsed = parseMsfCatalog(msfCatalog([{ name: 'video' }])) as CatalogState;
      expect(parsed.tracks[0]!.resolvedNamespace).toBeUndefined();
      expect(() => buildCatalogSelection(parsed, { catalogNamespace: undefined }))
        .toThrow(/namespace/i);
    });

    it('refuses to resolve an EXCLUDED track with no namespace and no context', () => {
      // Exclusions carry an identity too; fabricating one there would be the
      // same error reported in a quieter place.
      const parsed = parseMsfCatalog(msfCatalog([{ name: 'subs', role: 'subtitle' }])) as CatalogState;
      expect(() => buildCatalogSelection(parsed, { catalogNamespace: undefined }))
        .toThrow(/namespace/i);
    });

    it('builds without context when every track declares its namespace', () => {
      const parsed = parseMsfCatalog(msfCatalog([{ name: 'video', namespace: 'a/b' }])) as CatalogState;
      const selection = buildCatalogSelection(parsed, { catalogNamespace: undefined });
      expect(selection.scopes.flatMap(s => s.video.flatMap(set => set.tracks.map(t => t.id))))
        .toEqual([{ namespaceFields: ['a', 'b'], name: 'video' }]);
    });

    it('keeps zero fields and one empty field distinct in the model', () => {
      const none = buildCatalogSelection(
        parseMsfCatalog(msfCatalog([{ name: 't' }]), []) as CatalogState, { catalogNamespace: [] });
      const empty = buildCatalogSelection(
        parseMsfCatalog(msfCatalog([{ name: 't' }]), ['']) as CatalogState, { catalogNamespace: [''] });
      const idOf = (s: typeof none) => s.scopes.flatMap(
        sc => sc.video.flatMap(set => set.tracks.map(t => trackIdentityKey(t.id))));
      expect(idOf(none)).toEqual([identityKey([], 't')]);
      expect(idOf(empty)).toEqual([identityKey([''], 't')]);
      expect(idOf(none)).not.toEqual(idOf(empty));
    });
  });

  describe('identity text must encode to distinct UTF-8 bytes', () => {
    const encoder = new TextEncoder();

    it('rejects two namespaces that differ only by an unpaired surrogate', () => {
      // TextEncoder maps a lone surrogate to U+FFFD, so these two namespaces
      // are one namespace on the wire while JS compares them as distinct.
      expect(encoder.encode('\ud800')).toEqual(encoder.encode('�'));
      expect(() => parseMsfCatalog(msfCatalog([
        { name: 'camera', namespace: '\ud800' },
        { name: 'camera', namespace: '�' },
      ]), ONE_FIELD)).toThrow(/UTF-8|surrogate/i);
    });

    it('rejects an ill-formed track NAME on the same contract', () => {
      expect(() => parseMsfCatalog(msfCatalog([{ name: 'cam\ud800' }]), ONE_FIELD))
        .toThrow(/UTF-8|surrogate/i);
    });

    it('rejects an ill-formed field in an injected tuple context', () => {
      expect(() => parseMsfCatalog(msfCatalog([{ name: 'camera' }]), ['live', '\udc00']))
        .toThrow(/UTF-8|surrogate/i);
    });

    it('accepts well-formed non-ASCII and keeps it distinct', () => {
      const parsed = parseMsfCatalog(msfCatalog([
        { name: 'caméra', namespace: 'диск/🎥' },
        { name: 'caméra', namespace: 'диск/🎬' },
      ]), ONE_FIELD) as CatalogState;
      expect(parsed.tracks.map(t => t.resolvedNamespace?.fields))
        .toEqual([['диск', '🎥'], ['диск', '🎬']]);
    });

    it('does not normalize: precomposed and decomposed text stay distinct', () => {
      // NFC folding would merge two identities the transport compares as
      // different bytes — the opposite error to the surrogate collision.
      const parsed = parseMsfCatalog(msfCatalog([
        { name: 'café' }, { name: 'café' },
      ]), ONE_FIELD) as CatalogState;
      expect(parsed.tracks).toHaveLength(2);
      expect(identityKey(['live/show'], 'café'))
        .not.toBe(identityKey(['live/show'], 'café'));
    });
  });

  describe('the resolved annotation is application state, not wire syntax', () => {
    it('survives a spread clone, which is why it stays enumerable', () => {
      const parsed = parseMsfCatalog(msfCatalog([{ name: 't' }]), ONE_FIELD) as CatalogState;
      const copy = { ...parsed.tracks[0]! };
      expect(copy.resolvedNamespace).toEqual({ fields: ['live/show'], source: 'inherited' });
    });

    it('is never emitted by the catalog builder', () => {
      const parsed = parseMsfCatalog(msfCatalog([{ name: 't' }]), ONE_FIELD) as CatalogState;
      const annotated = parsed.tracks[0]!;
      expect(annotated.resolvedNamespace).toBeDefined();
      const payload = new TextDecoder().decode(buildCatalog({
        tracks: [annotated as never],
      }));
      expect(payload).not.toContain('resolvedNamespace');
      expect(JSON.parse(payload).tracks[0]).not.toHaveProperty('resolvedNamespace');
    });
  });

  describe('tracks injected straight into the model are a boundary too', () => {
    // The model is a supported entry point for already-normalized tracks, and
    // it compares identities field by field without ever taking a key — so
    // keying cannot be where the byte contract is enforced for this path.
    const injected = (fields: Partial<CatalogTrack> = {}): CatalogTrack => ({
      name: 'camera', role: 'video', packaging: 'loc', isLive: true, codec: 'av01', ...fields,
    });
    const build = (track: CatalogTrack, catalogNamespace: readonly string[]) =>
      buildCatalogSelection({ version: 1, tracks: [track] }, { catalogNamespace });

    it('rejects an injected track name that would encode with replacement', () => {
      expect(() => build(injected({ name: '\ud800' }), ['live'])).toThrow(/surrogate|UTF-8/i);
    });

    it('rejects ill-formed namespace fields supplied as model context', () => {
      expect(() => build(injected(), ['\ud800'])).toThrow(/surrogate|UTF-8/i);
    });

    it('rejects an ill-formed injected resolvedNamespace before offering the track', () => {
      expect(() => build(injected({
        resolvedNamespace: { fields: ['\ud800'], source: 'declared' },
      }), ['live'])).toThrow(/surrogate|UTF-8/i);
    });

    it('checks an EXCLUDED injected identity on the same contract', () => {
      expect(() => build(injected({
        name: '\ud800', packaging: 'locmaf', locmafVersion: 'unsupported',
      }), ['live'])).toThrow(/surrogate|UTF-8/i);
    });

    it('leaves well-formed injected text alone, decomposition included', () => {
      const model = build(injected({
        name: 'café', resolvedNamespace: { fields: ['café'], source: 'declared' },
      }), ['live']);
      const result = resolveSelection(model);
      expect(result.ok && result.video?.track.id)
        .toEqual({ namespaceFields: ['café'], name: 'café' });
    });
  });
});
