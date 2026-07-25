/**
 * LibMoQ MSF fixture import: spec-exact MSF-01/CMSF-01 normalization projectors
 * and the hermetic/refresh byte source. Extracted from the authoring script so
 * every piece is unit-testable (build-corpus.ts is a run-on-import CLI).
 *
 * The projectors are the INDEPENDENTLY-DERIVED normalization contract a future
 * MSF-01/CMSF-01 parser must satisfy. Field sets come straight from the drafts
 * (MSF-01 §5.1/§5.2, CMSF-01 §3.1/§4.1); every projector is an explicit allowlist
 * so unknown / legacy / nested-unknown keys are dropped, never copied through.
 *
 * @module
 */

import { join } from 'node:path';

/** number → decimal string, recursively; arrays/objects preserved; other scalars kept. */
export function numStrDeep(v: unknown): unknown {
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(numStrDeep);
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = numStrDeep(val);
    return o;
  }
  return v; // string | boolean | null
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Project an allowlisted object: only listed keys survive, each via numStrDeep. */
function pick(raw: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of allowed) if (k in raw) o[k] = numStrDeep(raw[k]);
  return o;
}

// ── MSF-01 track object (§5.2) + CMSF-01 track extension (§4.1.2) ──
// Exact JSON field names from the draft field table. Note: `bitrate` IS the
// Maximum Bitrate field (§5.2.22) — there is no `maxBitrate`; and MSF-01 uses
// `initRef` + the root `initDataList`, NOT the MSF-00 per-track initData/initTrack.
export const MSF01_TRACK_FIELDS: readonly string[] = [
  'namespace', 'name', 'packaging', 'eventType', 'isLive', 'targetLatency', 'buffers',
  'role', 'label', 'renderGroup', 'altGroup', 'initRef', 'depends', 'template',
  'temporalId', 'spatialId', 'codec', 'mimeType', 'framerate', 'timescale',
  'bitrate', 'avgBitrate', 'maxGopDuration', 'maxGroupDuration',
  'width', 'height', 'samplerate', 'channelConfig', 'displayWidth', 'displayHeight',
  'lang', 'parentName', 'parentNamespace', 'trackDuration', 'connectionUri',
  'token', 'encryptionScheme', 'cipherSuite', 'keyId', 'trackBaseKey', 'authInfo',
  'accessibility', 'contentProtectionRefIDs',
];

/** A LOC/CMAF URL object (§4.1.1.4.2-.4): { url, type }. */
export function projectUrl(raw: Record<string, unknown>): Record<string, unknown> {
  return pick(raw, ['url', 'type']);
}
/** A DRM System object (CMSF-01 §4.1.1.4). URL sub-objects are explicitly re-projected. */
export function projectDrmSystem(raw: Record<string, unknown>): Record<string, unknown> {
  const o = pick(raw, ['systemID', 'pssh', 'robustness']);
  for (const k of ['laURL', 'certURL', 'authorizationURL']) if (isObj(raw[k])) o[k] = projectUrl(raw[k] as Record<string, unknown>);
  return o;
}
/** A Content Protection object (CMSF-01 §4.1.1): { refID, defaultKID, scheme, drmSystem }. */
export function projectContentProtection(raw: Record<string, unknown>): Record<string, unknown> {
  const o = pick(raw, ['refID', 'defaultKID', 'scheme']);
  if (isObj(raw['drmSystem'])) o['drmSystem'] = projectDrmSystem(raw['drmSystem']);
  return o;
}
/** An Initialization Data List entry (MSF-01 §5.1.7): { id, type, data }. */
export function projectInitDataEntry(raw: Record<string, unknown>): Record<string, unknown> {
  return pick(raw, ['id', 'type', 'data']);
}
/** A track object (§5.2 + §4.1.2). Unknown/legacy fields are dropped. */
export function projectMsf01Track(raw: Record<string, unknown>): Record<string, unknown> {
  return pick(raw, MSF01_TRACK_FIELDS);
}

function projectTrackArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isObj).map((t) => projectMsf01Track(t as Record<string, unknown>)) : [];
}

/**
 * Canonical MSF version normalization (§5.1.1). The version suffix in a
 * "draft-XX" spelling identifies an Internet-Draft REVISION, not a future
 * numeric MSF version — so it is NOT decoded arithmetically. Only the one
 * observed, supported alias is recognized: `draft-01` denotes MSF version 1 and
 * normalizes to "1" (matching LibMoQ's typed parser, which maps both "1" and
 * "draft-01" to version 1). "1" and numeric 1 are already canonical. Every other
 * spelling (draft-1, draft-00, draft-02, draft-99, malformed) is UNSUPPORTED and
 * is preserved verbatim — a detection vector rejects such versions rather than
 * silently coercing them.
 */
const VERSION_ALIASES: Readonly<Record<string, string>> = { 'draft-01': '1' };
export function normalizeCatalogVersion(v: unknown): string {
  const s = String(v);
  return VERSION_ALIASES[s] ?? s;
}

/** Independent MSF-01/CMSF-01 catalog projection (root §5.1 + tracks §5.2 + §5.1.7 + CMSF §4.1). */
export function msf01Project(text: string): unknown {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const out: Record<string, unknown> = { catalogVersion: normalizeCatalogVersion(raw['version']) };
  if (typeof raw['generatedAt'] === 'number') out['generatedAt'] = String(raw['generatedAt']);
  if (typeof raw['isComplete'] === 'boolean') out['isComplete'] = raw['isComplete'];
  out['tracks'] = projectTrackArray(raw['tracks']);
  if (Array.isArray(raw['publishTracks'])) out['publishTracks'] = projectTrackArray(raw['publishTracks']); // §5.1.5
  if (Array.isArray(raw['contentProtections'])) out['contentProtections'] = (raw['contentProtections'] as unknown[]).filter(isObj).map((c) => projectContentProtection(c as Record<string, unknown>));
  if (Array.isArray(raw['initDataList'])) out['initDataList'] = (raw['initDataList'] as unknown[]).filter(isObj).map((e) => projectInitDataEntry(e as Record<string, unknown>));
  return out;
}

/** Delta projection (§5.3): ordered operations, each op's tracks normalized. */
export function msf01DeltaProject(text: string): unknown {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const ops = (raw['deltaUpdate'] as Record<string, unknown>[]).map((op) => ({ op: op['op'], tracks: projectTrackArray(op['tracks']) }));
  const out: Record<string, unknown> = {};
  if (typeof raw['generatedAt'] === 'number') out['generatedAt'] = String(raw['generatedAt']);
  out['deltaUpdate'] = ops;
  return out;
}

// ── Hermetic / refresh byte source ──────────────────────────────────────

export interface ImportDeps {
  /** Run a program directly (NO shell). Returns stdout. */
  readonly execFile: (cmd: string, args: readonly string[]) => string;
  readonly readFile: (path: string) => Uint8Array;
  readonly sha256: (bytes: Uint8Array) => string;
}

export interface ImportOptions {
  readonly refresh: boolean;
  readonly root?: string | undefined;
  readonly libmoqCommit: string;
  readonly fixtureDir: string;
  readonly snapshotDir: string;
  readonly corpusFile: string;
  readonly fixture: string;
  readonly pinnedSha: string;
}

/**
 * Get the fixture bytes. Hermetic default: read the checked-in snapshot. Refresh
 * mode: read from `root` after verifying its HEAD is the pinned commit. The
 * pinned SHA-256 gates the bytes in either mode. The git verification uses the
 * injected `execFile` (a direct exec, never a shell), so a `root` containing
 * spaces or shell metacharacters is passed through literally.
 */
export function readImportedFixture(opts: ImportOptions, deps: ImportDeps): { text: string; bytes: Uint8Array } {
  let bytes: Uint8Array;
  let origin: string;
  if (opts.refresh) {
    if (opts.root === undefined || opts.root === '') {
      throw new Error('LIBMOQ_REFRESH=1 requires LIBMOQ_ROOT=<path to a libmoq worktree at the pinned commit>');
    }
    const head = deps.execFile('git', ['-C', opts.root, 'rev-parse', 'HEAD']).trim();
    if (head !== opts.libmoqCommit) {
      throw new Error(`LibMoQ HEAD ${head} != pinned ${opts.libmoqCommit}; check out the pinned commit before refreshing the snapshot.`);
    }
    bytes = deps.readFile(join(opts.root, opts.fixtureDir, opts.fixture));
    origin = `LibMoQ ${opts.fixture}`;
  } else {
    bytes = deps.readFile(join(opts.snapshotDir, opts.corpusFile));
    origin = `snapshot ${opts.corpusFile}`;
  }
  const got = deps.sha256(bytes);
  if (got !== opts.pinnedSha) throw new Error(`${origin}: SHA-256 ${got} != pinned ${opts.pinnedSha}; refusing to import non-matching bytes.`);
  return { text: new TextDecoder().decode(bytes), bytes };
}
