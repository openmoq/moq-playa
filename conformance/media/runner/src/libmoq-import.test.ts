/**
 * Unit tests for the spec-exact MSF-01/CMSF-01 projectors and the hermetic/
 * refresh byte source. These pin the field-set contract (findings: publishTracks
 * survives; legacy/unknown/nested-unknown fields are dropped) and prove the
 * refresh path never reaches a shell.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import {
  msf01Project, msf01DeltaProject, projectMsf01Track, projectDrmSystem,
  projectContentProtection, projectInitDataEntry, MSF01_TRACK_FIELDS, readImportedFixture,
  type ImportDeps,
} from './libmoq-import.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('MSF-01 projectors — spec-exact field sets', () => {
  it('the track field set excludes the legacy/nonexistent maxBitrate, initData, initTrack', () => {
    for (const f of ['maxBitrate', 'initData', 'initTrack']) expect(MSF01_TRACK_FIELDS).not.toContain(f);
    // …but keeps the real MSF-01 names.
    for (const f of ['bitrate', 'avgBitrate', 'initRef', 'trackDuration', 'contentProtectionRefIDs']) expect(MSF01_TRACK_FIELDS).toContain(f);
  });

  it('projectMsf01Track drops legacy and unknown fields, keeps and stringifies known ones', () => {
    const t = projectMsf01Track({
      name: 'v', packaging: 'cmaf', isLive: true, bitrate: 5000000, avgBitrate: 4000000,
      maxBitrate: 9, initData: 'AAAA', initTrack: 'init', mimetype: 'video/mp4', somethingNew: 1,
    });
    expect(t).toEqual({ name: 'v', packaging: 'cmaf', isLive: true, bitrate: '5000000', avgBitrate: '4000000' });
    for (const dropped of ['maxBitrate', 'initData', 'initTrack', 'mimetype', 'somethingNew']) expect(dropped in t).toBe(false);
  });

  it('the root projector keeps publishTracks (§5.1.5) and normalizes its tracks', () => {
    const text = JSON.stringify({
      version: '1',
      tracks: [{ name: 'v', packaging: 'loc', isLive: true }],
      publishTracks: [{ name: '6', packaging: 'moqlog', role: 'log', connectionUri: 'moqt://x', renderGroup: 2, junk: true }],
    });
    const sem = msf01Project(text) as { publishTracks: Array<Record<string, unknown>> };
    expect(sem.publishTracks).toEqual([{ name: '6', packaging: 'moqlog', role: 'log', connectionUri: 'moqt://x', renderGroup: '2' }]);
    expect('junk' in sem.publishTracks[0]!).toBe(false);
  });

  it('nested protection/init objects are re-projected, dropping UNKNOWN nested keys', () => {
    const cp = projectContentProtection({
      refID: '1', defaultKID: ['kid'], scheme: 'cbcs', bogusTop: 'x',
      drmSystem: { systemID: 'sid', pssh: 'p', laURL: { url: 'u', type: 'EME', extra: 'DROP' }, mystery: 'DROP' },
    });
    expect(cp).toEqual({ refID: '1', defaultKID: ['kid'], scheme: 'cbcs', drmSystem: { systemID: 'sid', pssh: 'p', laURL: { url: 'u', type: 'EME' } } });
  });

  it('projectDrmSystem re-projects laURL/certURL/authorizationURL as {url,type} only', () => {
    const d = projectDrmSystem({ systemID: 's', certURL: { url: 'c', junk: 1 }, authorizationURL: { url: 'a' }, robustness: 'HW' });
    expect(d).toEqual({ systemID: 's', robustness: 'HW', certURL: { url: 'c' }, authorizationURL: { url: 'a' } });
  });

  it('projectInitDataEntry keeps only {id,type,data}', () => {
    expect(projectInitDataEntry({ id: 'x', type: 'inline', data: 'AAAB', junk: 9 })).toEqual({ id: 'x', type: 'inline', data: 'AAAB' });
  });

  it('the delta projector preserves op order and normalizes each op\'s tracks', () => {
    const text = JSON.stringify({ generatedAt: 42, deltaUpdate: [
      { op: 'add', tracks: [{ name: 'a', bitrate: 1, initData: 'x' }] },
      { op: 'remove', tracks: [{ name: 'b' }] },
    ] });
    expect(msf01DeltaProject(text)).toEqual({ generatedAt: '42', deltaUpdate: [
      { op: 'add', tracks: [{ name: 'a', bitrate: '1' }] },
      { op: 'remove', tracks: [{ name: 'b' }] },
    ] });
  });
});

describe('readImportedFixture — hermetic default + refresh verification (no shell)', () => {
  const SHA = 'a'.repeat(64);
  const deps = (over: Partial<ImportDeps> = {}): ImportDeps => ({
    execFile: () => 'deadbeef\n',
    readFile: () => enc('{}'),
    sha256: () => SHA,
    ...over,
  });
  const base = { libmoqCommit: 'deadbeef', fixtureDir: 'media/msf/tests/fixtures', snapshotDir: '/snap', corpusFile: 'libmoq_x.json', fixture: 'x.json', pinnedSha: SHA };

  it('hermetic default reads the snapshot and never invokes git', () => {
    let gitCalls = 0;
    const r = readImportedFixture({ ...base, refresh: false }, deps({ execFile: () => { gitCalls++; return ''; }, readFile: (p) => enc(`snap:${p}`), sha256: () => SHA }));
    expect(gitCalls).toBe(0);
    expect(r.text).toBe('snap:/snap/libmoq_x.json');
  });

  it('refresh verifies HEAD via execFile with LITERAL args — no shell expansion of the path', () => {
    const evil = '/tmp/li bmoq-$HOME-`id`-;rm';
    let seen: readonly string[] = [];
    readImportedFixture(
      { ...base, refresh: true, root: evil },
      deps({ execFile: (cmd, args) => { expect(cmd).toBe('git'); seen = args; return 'deadbeef'; } }),
    );
    // The path reaches git verbatim as a single argv element (argv, not a shell string).
    expect(seen).toEqual(['-C', evil, 'rev-parse', 'HEAD']);
  });

  it('refresh without a root fails loudly', () => {
    expect(() => readImportedFixture({ ...base, refresh: true, root: undefined }, deps())).toThrow(/requires LIBMOQ_ROOT/);
    expect(() => readImportedFixture({ ...base, refresh: true, root: '' }, deps())).toThrow(/requires LIBMOQ_ROOT/);
  });

  it('refresh at the WRONG HEAD is rejected', () => {
    expect(() => readImportedFixture({ ...base, refresh: true, root: '/lib' }, deps({ execFile: () => 'feedface\n' }))).toThrow(/HEAD feedface != pinned deadbeef/);
  });

  it('a SHA-256 mismatch is rejected in both modes', () => {
    expect(() => readImportedFixture({ ...base, refresh: false }, deps({ sha256: () => 'b'.repeat(64) }))).toThrow(/SHA-256 .* != pinned/);
    expect(() => readImportedFixture({ ...base, refresh: true, root: '/lib' }, deps({ sha256: () => 'b'.repeat(64) }))).toThrow(/SHA-256 .* != pinned/);
  });
});
