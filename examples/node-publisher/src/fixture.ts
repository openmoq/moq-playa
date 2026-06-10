/**
 * Fixture contract for the Node publisher example.
 *
 * A fixture is a directory of PREPARED per-track CMAF files plus a manifest — no
 * media parsing happens here (and none is needed to publish: init segments ride in
 * the MSF catalog as base64 `initData`, and each chunk file is one MoQT object).
 *
 *   <fixture>/
 *     manifest.json
 *     video-1080/init.mp4  chunk-000.m4s  chunk-001.m4s ...
 *     video-720/...   video-360/...   audio-en/...   audio-es/...
 *
 * Validation here covers LAYOUT only: the manifest parses, every referenced file
 * exists, and names are usable as MoQT track names. Media correctness (real CMAF
 * boxes, codec strings the browser accepts) is checked by playback, not here.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** One track in the fixture manifest. Field names align with @moqt/msf's
 *  CatalogBuilderTrack so the publisher can map 1:1 into buildCatalog(). */
export interface FixtureTrack {
  /** MoQT track name (and the fixture subdirectory name), e.g. "video-720". */
  readonly name: string;
  /** Catalog packaging. The first demo is CMAF-only. */
  readonly packaging: 'cmaf';
  /** Track role, e.g. "video" | "audio". */
  readonly role: 'video' | 'audio';
  /** WebCodecs-registry codec string, e.g. "avc1.64001f", "mp4a.40.2". */
  readonly codec: string;
  /** Init segment file, relative to the track directory (usually "init.mp4"). */
  readonly init: string;
  /** CMAF chunk files in publish order, relative to the track directory. Each
   *  file is one complete CMAF chunk (moof+mdat) = one MoQT object. */
  readonly chunks: readonly string[];
  // Optional catalog metadata (forwarded into buildCatalog when present):
  readonly width?: number;
  readonly height?: number;
  readonly framerate?: number;
  readonly bitrate?: number;
  readonly samplerate?: number;
  readonly channelConfig?: string;
}

/** The fixture's manifest.json. */
export interface FixtureManifest {
  /** Namespace parts, e.g. ["demo"]. Joined with "/" for display. */
  readonly namespace: readonly string[];
  /** MSF render group shared by all tracks (A/V sync). */
  readonly renderGroup: number;
  /** Nominal chunk duration in milliseconds (drives the publisher's pacing). */
  readonly chunkDurationMs: number;
  readonly tracks: readonly FixtureTrack[];
}

export interface FixtureIssue {
  readonly track: string | null;
  readonly message: string;
}

/** A fixture track with its bytes resolved into memory (same shape whether the
 *  source is the synthetic generator or real files on disk). */
export interface LoadedTrack {
  /** Catalog-facing metadata (same fields as the on-disk manifest contract). */
  readonly meta: FixtureTrack;
  /** Init segment bytes — go into the catalog as base64 initData, NOT published. */
  readonly initData: Uint8Array;
  /** One entry per CMAF chunk = one MoQT object, in publish order. */
  readonly chunks: readonly Uint8Array[];
}

export interface LoadedFixture {
  readonly manifest: FixtureManifest;
  readonly tracks: readonly LoadedTrack[];
}

/** Load a REAL fixture from disk into the same LoadedFixture shape the synthetic
 *  generator produces — the publisher consumes both identically. */
export function loadFixtureFromDisk(dir: string): LoadedFixture {
  const manifest = loadFixtureManifest(dir);
  const tracks: LoadedTrack[] = manifest.tracks.map((meta) => ({
    meta,
    initData: new Uint8Array(readFileSync(join(dir, meta.name, meta.init))),
    chunks: meta.chunks.map((c) => new Uint8Array(readFileSync(join(dir, meta.name, c)))),
  }));
  return { manifest, tracks };
}

// ─── Top-level box validation (no deep media parsing) ──────────────────────

/** List top-level ISO-BMFF box types in `bytes`. Returns null on a malformed walk. */
export function topLevelBoxes(bytes: Uint8Array): string[] | null {
  const types: string[] = [];
  let pos = 0;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (pos + 8 <= bytes.length) {
    let size = dv.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!);
    if (size === 1) {
      // 64-bit largesize
      if (pos + 16 > bytes.length) return null;
      const hi = dv.getUint32(pos + 8);
      const lo = dv.getUint32(pos + 12);
      size = hi * 2 ** 32 + lo;
    } else if (size === 0) {
      size = bytes.length - pos; // box extends to EOF
    }
    if (size < 8 || pos + size > bytes.length) return null;
    types.push(type);
    pos += size;
  }
  return pos === bytes.length ? types : null;
}

/**
 * Box-level media checks (stronger than existence, still no deep parsing):
 * init.mp4 must start with `ftyp` and contain `moov`; every chunk's top-level
 * boxes must include `moof` and `mdat`.
 */
export function validateFixtureBoxes(dir: string): FixtureIssue[] {
  const issues: FixtureIssue[] = [];
  let manifest: FixtureManifest;
  try {
    manifest = loadFixtureManifest(dir);
  } catch (err) {
    return [{ track: null, message: (err as Error).message }];
  }
  for (const t of manifest.tracks) {
    const initPath = join(dir, t.name, t.init);
    if (existsSync(initPath)) {
      const boxes = topLevelBoxes(new Uint8Array(readFileSync(initPath)));
      if (!boxes) issues.push({ track: t.name, message: `${t.init}: malformed box structure` });
      else if (boxes[0] !== 'ftyp' || !boxes.includes('moov')) {
        issues.push({ track: t.name, message: `${t.init}: expected ftyp+moov, got [${boxes.join(', ')}]` });
      }
    }
    for (const c of t.chunks) {
      const p = join(dir, t.name, c);
      if (!existsSync(p)) continue; // layout validation reports missing files
      const boxes = topLevelBoxes(new Uint8Array(readFileSync(p)));
      if (!boxes) issues.push({ track: t.name, message: `${c}: malformed box structure` });
      else if (!boxes.includes('moof') || !boxes.includes('mdat')) {
        issues.push({ track: t.name, message: `${c}: expected moof+mdat, got [${boxes.join(', ')}]` });
      }
    }
  }
  return issues;
}

/** Parse <dir>/manifest.json. Throws on missing file or structurally invalid JSON. */
export function loadFixtureManifest(dir: string): FixtureManifest {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) throw new Error(`fixture manifest not found: ${path}`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as FixtureManifest;
  if (!Array.isArray(raw.namespace) || raw.namespace.length === 0) {
    throw new Error('manifest.namespace must be a non-empty string array');
  }
  if (!Array.isArray(raw.tracks) || raw.tracks.length === 0) {
    throw new Error('manifest.tracks must be a non-empty array');
  }
  if (typeof raw.renderGroup !== 'number' || typeof raw.chunkDurationMs !== 'number') {
    throw new Error('manifest.renderGroup and manifest.chunkDurationMs must be numbers');
  }
  return raw;
}

/**
 * Validate the fixture LAYOUT (no media parsing): every track has a directory,
 * its init + chunk files exist and are non-empty, names are sane MoQT track
 * names, and there are no duplicate tracks. Returns issues (empty = valid).
 */
export function validateFixtureLayout(dir: string): FixtureIssue[] {
  const issues: FixtureIssue[] = [];
  let manifest: FixtureManifest;
  try {
    manifest = loadFixtureManifest(dir);
  } catch (err) {
    return [{ track: null, message: (err as Error).message }];
  }

  const seen = new Set<string>();
  for (const t of manifest.tracks) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(t.name)) {
      issues.push({ track: t.name, message: `track name ${JSON.stringify(t.name)} is not a safe track/directory name` });
      continue;
    }
    if (seen.has(t.name)) { issues.push({ track: t.name, message: 'duplicate track name' }); continue; }
    seen.add(t.name);

    if (t.packaging !== 'cmaf') issues.push({ track: t.name, message: `unsupported packaging ${JSON.stringify(t.packaging)} (first demo is cmaf-only)` });
    if (t.role !== 'video' && t.role !== 'audio') issues.push({ track: t.name, message: `unknown role ${JSON.stringify(t.role)}` });
    if (!t.codec) issues.push({ track: t.name, message: 'missing codec string' });

    const trackDir = join(dir, t.name);
    if (!existsSync(trackDir)) { issues.push({ track: t.name, message: `track directory missing: ${trackDir}` }); continue; }

    const files = [t.init, ...t.chunks];
    if (t.chunks.length === 0) issues.push({ track: t.name, message: 'no chunk files listed' });
    for (const f of files) {
      const p = join(trackDir, f);
      if (!existsSync(p)) issues.push({ track: t.name, message: `referenced file missing: ${t.name}/${f}` });
      else if (statSync(p).size === 0) issues.push({ track: t.name, message: `referenced file is empty: ${t.name}/${f}` });
    }
  }
  return issues;
}
