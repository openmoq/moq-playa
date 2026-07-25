/**
 * Executable catalog path against CURRENT production code
 * (`parseCatalogAuto`). Shared by the authoring script and the runtime tests.
 *
 * The catalog parsers throw plain `Error` (message carries the spec §) or a
 * native `SyntaxError` from `JSON.parse`; we map those onto error CATEGORIES
 * (never message text). The projection stringifies all numeric fields so the
 * manifest itself never carries an imprecise JSON number.
 *
 * @module
 */

import { parseCatalogAuto, parseMsf01Delta, type Catalog, type CatalogTrack, type Msf01Delta } from '@moqt/msf';
import type { ErrorCategory } from './schema-types.js';
import type { ExecResult } from './exec-compare.js';

export type CatalogRunResult = ExecResult;

function numStr(n: number): string {
  // Deterministic, lossless-in-manifest rendering of a parsed numeric field.
  return String(n);
}

/** number → decimal string, recursively; arrays preserved (for the template tuple). */
function numStrDeep(v: unknown): unknown {
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(numStrDeep);
  return v;
}

/** Project a normalized CatalogTrack (shared by tracks and publishTracks). */
function projectTrack(t: CatalogTrack): Record<string, unknown> {
  const o: Record<string, unknown> = { name: t.name, packaging: t.packaging, isLive: t.isLive };
  if (t.namespace !== undefined) o['namespace'] = t.namespace;
  if (t.role !== undefined) o['role'] = t.role;
  if (t.codec !== undefined) o['codec'] = t.codec;
  if (t.mimeType !== undefined) o['mimeType'] = t.mimeType;
  if (t.renderGroup !== undefined) o['renderGroup'] = numStr(t.renderGroup);
  if (t.altGroup !== undefined) o['altGroup'] = numStr(t.altGroup);
  if (t.framerate !== undefined) o['framerate'] = numStr(t.framerate);
  if (t.timescale !== undefined) o['timescale'] = numStr(t.timescale);
  if (t.bitrate !== undefined) o['bitrate'] = numStr(t.bitrate);
  if (t.width !== undefined) o['width'] = numStr(t.width);
  if (t.height !== undefined) o['height'] = numStr(t.height);
  if (t.samplerate !== undefined) o['samplerate'] = numStr(t.samplerate);
  if (t.channelConfig !== undefined) o['channelConfig'] = t.channelConfig;
  if (t.displayWidth !== undefined) o['displayWidth'] = numStr(t.displayWidth);
  if (t.displayHeight !== undefined) o['displayHeight'] = numStr(t.displayHeight);
  if (t.lang !== undefined) o['lang'] = t.lang;
  if (t.label !== undefined) o['label'] = t.label;
  // initData is kept by the parser as an inline base64 STRING (never decoded).
  if (t.initData !== undefined) o['initData'] = t.initData;
  if (t.initTrack !== undefined) o['initTrack'] = t.initTrack;
  if (t.depends !== undefined) o['depends'] = [...t.depends];
  if (t.temporalId !== undefined) o['temporalId'] = numStr(t.temporalId);
  if (t.spatialId !== undefined) o['spatialId'] = numStr(t.spatialId);
  if (t.eventType !== undefined) o['eventType'] = t.eventType;
  if (t.parentName !== undefined) o['parentName'] = t.parentName;
  if (t.parentNamespace !== undefined) o['parentNamespace'] = t.parentNamespace;
  if (t.targetLatency !== undefined) o['targetLatency'] = numStr(t.targetLatency);
  if (t.trackDuration !== undefined) o['trackDuration'] = numStr(t.trackDuration);
  if (t.maxGrpSapStartingType !== undefined) o['maxGrpSapStartingType'] = numStr(t.maxGrpSapStartingType);
  if (t.maxObjSapStartingType !== undefined) o['maxObjSapStartingType'] = numStr(t.maxObjSapStartingType);
  // MSF-01 / CMSF-01.
  if (t.initRef !== undefined) o['initRef'] = t.initRef;
  if (t.template !== undefined) o['template'] = numStrDeep(t.template);
  if (t.contentProtectionRefIDs !== undefined) o['contentProtectionRefIDs'] = [...t.contentProtectionRefIDs];
  return o;
}

/** Project a CMSF-01 URL reference object ({ url, type? }). */
function projectUrl(u: { readonly url: string; readonly type?: string }): Record<string, unknown> {
  return u.type !== undefined ? { url: u.url, type: u.type } : { url: u.url };
}

/** Canonical projection of a normalized Catalog. Numbers become strings. */
export function catalogProjection(cat: Catalog): unknown {
  const out: Record<string, unknown> = {
    catalogVersion: numStr(cat.version),
    ...(cat.generatedAt !== undefined ? { generatedAt: numStr(cat.generatedAt) } : {}),
    ...(cat.isComplete !== undefined ? { isComplete: cat.isComplete } : {}),
    tracks: cat.tracks.map(projectTrack),
  };
  if (cat.publishTracks !== undefined) out['publishTracks'] = cat.publishTracks.map(projectTrack);
  if (cat.contentProtections !== undefined) {
    out['contentProtections'] = cat.contentProtections.map((c) => {
      const co: Record<string, unknown> = { refID: c.refID, defaultKID: [...c.defaultKID], scheme: c.scheme };
      const d = c.drmSystem;
      const drm: Record<string, unknown> = { systemID: d.systemID };
      if (d.laURL !== undefined) drm['laURL'] = projectUrl(d.laURL);
      if (d.certURL !== undefined) drm['certURL'] = projectUrl(d.certURL);
      if (d.authorizationURL !== undefined) drm['authorizationURL'] = projectUrl(d.authorizationURL);
      if (d.pssh !== undefined) drm['pssh'] = d.pssh;
      if (d.robustness !== undefined) drm['robustness'] = d.robustness;
      co['drmSystem'] = drm;
      return co;
    });
  }
  if (cat.initDataList !== undefined) {
    out['initDataList'] = cat.initDataList.map((e) => ({ id: e.id, type: e.type, data: e.data }));
  }
  return out;
}

/**
 * Project a partial delta op-track: every present recognized field, numbers as
 * decimal strings (deep, for the template tuple), everything else verbatim. This
 * mirrors the oracle's allowlist projection element-wise, so a `remove` ref
 * ({name}) and a `clone` override ({parentName, parentNamespace, …}) project to
 * exactly their present fields — no injected packaging/isLive defaults.
 */
function projectDeltaTrack(t: Partial<CatalogTrack>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t)) {
    if (v !== undefined) o[k] = numStrDeep(v);
  }
  return o;
}

/** Canonical projection of an MSF-01 op-array delta (matches msf01DeltaProject). */
export function msf01DeltaProjection(delta: Msf01Delta): unknown {
  const out: Record<string, unknown> = {};
  if (delta.generatedAt !== undefined) out['generatedAt'] = numStr(delta.generatedAt);
  out['deltaUpdate'] = delta.deltaUpdate.map((op) => ({ op: op.op, tracks: op.tracks.map(projectDeltaTrack) }));
  return out;
}

/**
 * Whether the JSON is an MSF-01 op-array delta ({deltaUpdate:[…]}), as opposed
 * to a full catalog or the MSF-00 grouped delta ({deltaUpdate:true}). Swallows a
 * parse error (returns false) so malformed JSON flows to the catalog path and is
 * reported as malformed-json.
 */
function isMsf01OpArrayDelta(json: string): boolean {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return false; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const du = (raw as Record<string, unknown>)['deltaUpdate'];
  // Present and NOT the MSF-00 `true` sentinel ⇒ the op-array dialect (an array
  // normally; a malformed non-array is routed here too so it is rejected as such).
  return du !== undefined && du !== true;
}

/** Map a thrown catalog error to a corpus error category. */
export function categorizeCatalogError(err: unknown): ErrorCategory {
  if (err instanceof SyntaxError) return 'malformed-json';
  const m = err instanceof Error ? err.message : String(err);
  if (/must be a finite number/i.test(m)) return 'value-out-of-range';
  // MSF-01 op-array delta (§5.3) categories — specific words, checked early.
  if (/unknown delta operation/i.test(m)) return 'unknown-delta-op';
  if (/illegal delta field/i.test(m)) return 'illegal-delta-field';
  if (/deltaUpdate must be an array|deltaUpdate must contain at least one operation/i.test(m)) return 'unsupported-delta';
  if (/JSON array|JSON Patch delta/i.test(m)) return 'unsupported-delta';
  if (/Unsupported catalog version|version is required|version.*must be a number/i.test(m)) return 'invalid-version';
  // MSF-01 §5.2.13 / CMSF-01 §4.1.2 reference-topology categories (checked before
  // the generic "is required"/JSON-object rules so their specific words win).
  if (/dangling init reference|references unknown initDataList/i.test(m)) return 'dangling-init-ref';
  if (/Duplicate initDataList id/i.test(m)) return 'duplicate-init-ref';
  if (/dangling content protection reference|references unknown contentProtections/i.test(m)) return 'dangling-protection-ref';
  if (/Duplicate contentProtections refID/i.test(m)) return 'duplicate-protection-ref';
  if (/must be a JSON object/i.test(m)) return 'malformed-json';
  if (/is required|must be one of|must be a boolean|must be a string/i.test(m)) return 'missing-required-field';
  // An unmapped catalog Error is still a deterministic rejection; surface it so
  // the author notices and either adds a mapping or fixes the vector.
  throw err;
}

/** Run production catalog / MSF-01 delta parsing and normalise to a comparable result. */
export function runCatalog(json: string, catalogNamespace?: string): CatalogRunResult {
  try {
    // The MSF-01 op-array delta dialect ({deltaUpdate:[…]}) parses to an ordered
    // operation projection; everything else is a full catalog (incl. the MSF-00
    // grouped delta {deltaUpdate:true}, which the full-catalog parser handles).
    if (isMsf01OpArrayDelta(json)) {
      return { status: 'ok', semantics: msf01DeltaProjection(parseMsf01Delta(json)) };
    }
    const cat = catalogNamespace !== undefined
      ? parseCatalogAuto(json, catalogNamespace)
      : parseCatalogAuto(json);
    return { status: 'ok', semantics: catalogProjection(cat) };
  } catch (err) {
    return { status: 'error', category: categorizeCatalogError(err) };
  }
}
