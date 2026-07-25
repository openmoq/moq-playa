/**
 * Strict adapter from a `moq-media-probe/1` result to Playa corpus `semantics`.
 *
 * The external probe projects LibMoQ's model with its own field spellings; this
 * adapter translates that representation into the shape the corpus vectors'
 * `expect.semantics` use, and NOTHING more:
 *   - `version` → `catalogVersion`
 *   - track `framerateMillis` → `framerate`, as an EXACT decimal (÷1000 via
 *     bigint/string arithmetic — never `Number`, so wide values stay exact)
 *   - track `template` object → the corpus 6-tuple array form
 *   - every other value is passed through verbatim (decimal-string integers,
 *     booleans, and array/operation order are preserved)
 *
 * It is STRICT: an unrecognized field in any object throws, so a future probe
 * field cannot be silently dropped from the comparison. Pure and side-effect
 * free; unit-tested independently of any subprocess.
 *
 * @module
 */

export type ProbeKind = 'catalog-parse' | 'catalog-delta-parse';

function asObject(v: unknown, ctx: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`probe-normalize: ${ctx} must be an object`);
  return v as Record<string, unknown>;
}
function asArray(v: unknown, ctx: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`probe-normalize: ${ctx} must be an array`);
  return v;
}
function unknownField(ctx: string, key: string): never {
  throw new Error(`probe-normalize: unrecognized probe field "${key}" in ${ctx} (a strict adapter refuses to silently drop it)`);
}

/** Divide a non-negative decimal-integer STRING by 1000, exactly, as a decimal string. */
export function framerateFromMillis(millis: unknown): string {
  if (typeof millis !== 'string' || !/^(0|[1-9][0-9]*)$/.test(millis)) {
    throw new Error(`probe-normalize: framerateMillis must be an unsigned decimal string, got ${JSON.stringify(millis)}`);
  }
  const n = BigInt(millis);
  const whole = n / 1000n;
  const frac = n % 1000n;
  if (frac === 0n) return whole.toString();
  const f = frac.toString().padStart(3, '0').replace(/0+$/, '');
  return `${whole.toString()}.${f}`;
}

const TEMPLATE_KEYS = ['startMediaMs', 'deltaMediaMs', 'startGroup', 'startObject', 'deltaGroup', 'deltaObject', 'startWallclockMs', 'deltaWallclockMs'] as const;

/** Probe template object → corpus 6-tuple array [sMedia,dMedia,[sGrp,sObj],[dGrp,dObj],sWall,dWall]. */
function mapTemplate(v: unknown): unknown {
  const t = asObject(v, 'template');
  for (const k of Object.keys(t)) if (!(TEMPLATE_KEYS as readonly string[]).includes(k)) unknownField('template', k);
  for (const k of TEMPLATE_KEYS) if (!(k in t)) throw new Error(`probe-normalize: template missing "${k}"`);
  return [t['startMediaMs'], t['deltaMediaMs'], [t['startGroup'], t['startObject']], [t['deltaGroup'], t['deltaObject']], t['startWallclockMs'], t['deltaWallclockMs']];
}

/** Track fields that pass through unchanged (framerateMillis and template are handled specially). */
const TRACK_PASSTHROUGH = new Set([
  'altGroup', 'bitrate', 'channelConfig', 'codec', 'contentProtectionRefIDs', 'depends',
  'eventType', 'height', 'initData', 'initRef', 'initTrack', 'isLive', 'label', 'lang',
  'maxGrpSapStartingType', 'maxObjSapStartingType', 'mimeType', 'name', 'namespace',
  'packaging', 'parentName', 'parentNamespace', 'renderGroup', 'role', 'samplerate',
  'targetLatency', 'timescale', 'trackDuration', 'width',
]);

function mapTrack(v: unknown): Record<string, unknown> {
  const t = asObject(v, 'track');
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(t)) {
    if (k === 'framerateMillis') out['framerate'] = framerateFromMillis(val);
    else if (k === 'template') out['template'] = mapTemplate(val);
    else if (TRACK_PASSTHROUGH.has(k)) out[k] = val;
    else unknownField('track', k);
  }
  return out;
}

function mapByAllowlist(v: unknown, ctx: string, allowed: Set<string>): Record<string, unknown> {
  const o = asObject(v, ctx);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(o)) {
    if (!allowed.has(k)) unknownField(ctx, k);
    out[k] = val;
  }
  return out;
}

const URL_KEYS = new Set(['type', 'url']);
function mapUrl(v: unknown): Record<string, unknown> { return mapByAllowlist(v, 'url', URL_KEYS); }

function mapDrmSystem(v: unknown): Record<string, unknown> {
  const d = asObject(v, 'drmSystem');
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(d)) {
    switch (k) {
      case 'systemID': case 'pssh': case 'robustness': out[k] = val; break;
      case 'laURL': out['laURL'] = mapUrl(val); break;
      case 'certURL': out['certURL'] = mapUrl(val); break;
      // The probe spells this authURL; the corpus model spells it authorizationURL.
      case 'authURL': out['authorizationURL'] = mapUrl(val); break;
      default: unknownField('drmSystem', k);
    }
  }
  return out;
}

function mapContentProtection(v: unknown): Record<string, unknown> {
  const c = asObject(v, 'contentProtection');
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(c)) {
    switch (k) {
      case 'refID': case 'scheme': case 'defaultKID': out[k] = val; break;
      case 'drmSystem': out['drmSystem'] = mapDrmSystem(val); break;
      default: unknownField('contentProtection', k);
    }
  }
  return out;
}

const INIT_ENTRY_KEYS = new Set(['data', 'id', 'type']);
function mapInitEntry(v: unknown): Record<string, unknown> { return mapByAllowlist(v, 'initDataList entry', INIT_ENTRY_KEYS); }

function mapCatalog(v: unknown): Record<string, unknown> {
  const c = asObject(v, 'catalog result');
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(c)) {
    switch (k) {
      case 'version': out['catalogVersion'] = val; break;
      case 'generatedAt': case 'isComplete': out[k] = val; break;
      case 'tracks': out['tracks'] = asArray(val, 'tracks').map(mapTrack); break;
      case 'contentProtections': out['contentProtections'] = asArray(val, 'contentProtections').map(mapContentProtection); break;
      case 'initDataList': out['initDataList'] = asArray(val, 'initDataList').map(mapInitEntry); break;
      default: unknownField('catalog result', k);
    }
  }
  return out;
}

function mapDeltaOp(v: unknown): Record<string, unknown> {
  const o = asObject(v, 'delta op');
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(o)) {
    switch (k) {
      case 'op': out['op'] = val; break;
      case 'tracks': out['tracks'] = asArray(val, 'delta op tracks').map(mapTrack); break;
      default: unknownField('delta op', k);
    }
  }
  return out;
}

function mapDelta(v: unknown): Record<string, unknown> {
  const d = asObject(v, 'delta result');
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(d)) {
    switch (k) {
      case 'generatedAt': out['generatedAt'] = val; break;
      case 'deltaUpdate': out['deltaUpdate'] = asArray(val, 'deltaUpdate').map(mapDeltaOp); break; // ORDER preserved
      default: unknownField('delta result', k);
    }
  }
  return out;
}

/** Normalize a probe `result` object into corpus `semantics`, per operation kind. */
export function normalizeProbeResult(result: unknown, kind: ProbeKind): unknown {
  return kind === 'catalog-delta-parse' ? mapDelta(result) : mapCatalog(result);
}
