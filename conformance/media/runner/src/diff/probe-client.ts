/**
 * Client for an EXTERNAL `moq-media-probe/1` executable, used by the opt-in
 * differential lane. The probe is a separate program reached only over its
 * stdin/stdout JSONL protocol — this repo never vendors, imports, or searches
 * for it. The absolute path is supplied via MOQ_MEDIA_PROBE_BIN; a missing or
 * relative value is a hard error, never a silent skip.
 *
 * Guarantees: launched with `spawn` and an argv (never a shell string); bounded
 * stdout/stderr; a wall-clock timeout; strict (fatal) UTF-8 decoding; and strict
 * response accounting (exactly one response per request id — no missing,
 * duplicate, unknown, or excess response, and no stderr / nonzero exit).
 *
 * @module
 */

import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { loadDomain } from '../load-corpus.js';
import type { CorpusEntry } from '../schema-types.js';

export const PROBE_PROTOCOL = 'moq-media-probe/1';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_STDOUT = 8 * 1024 * 1024; // 8 MiB
const MAX_STDERR = 64 * 1024;

export class ProbeError extends Error {
  constructor(message: string) { super(message); this.name = 'ProbeError'; }
}

export interface ProbeRequest {
  readonly protocol: string;
  readonly id: string;
  readonly operation: string;
  readonly profile?: string;
  readonly input?: { readonly utf8: string };
}
export interface ProbeResponse {
  readonly protocol?: unknown;
  readonly id?: unknown;
  readonly status?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly diagnostics?: unknown;
}

export interface RunOptions {
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly maxStdout?: number;
}

/**
 * Resolve the probe binary from MOQ_MEDIA_PROBE_BIN. Must be an ABSOLUTE path;
 * this function never searches PATH or a sibling checkout. Throws (never returns
 * a sentinel) when unset or relative, so a missing binary fails loudly.
 */
export function resolveProbeBin(env: NodeJS.ProcessEnv = process.env): string {
  const bin = env['MOQ_MEDIA_PROBE_BIN'];
  if (bin === undefined || bin === '') {
    throw new ProbeError('MOQ_MEDIA_PROBE_BIN is not set — the differential lane requires an absolute path to a built moq_media_probe (it never searches for a sibling checkout).');
  }
  if (!isAbsolute(bin)) {
    throw new ProbeError(`MOQ_MEDIA_PROBE_BIN must be an ABSOLUTE path, got ${JSON.stringify(bin)}.`);
  }
  return bin;
}

/** Spawn the probe (argv only, no shell), send `requests` as one JSONL batch, return raw responses. */
export function runProbeBatch(bin: string, requests: readonly ProbeRequest[], opts: RunOptions = {}): Promise<ProbeResponse[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdout = opts.maxStdout ?? DEFAULT_MAX_STDOUT;
  return new Promise<ProbeResponse[]>((resolve, reject) => {
    const child = spawn(bin, [...(opts.args ?? [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    const out: Buffer[] = []; let outLen = 0;
    const err: Buffer[] = []; let errLen = 0;
    let settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const fail = (msg: string) => finish(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } reject(new ProbeError(msg)); });
    const timer = setTimeout(() => fail(`probe timed out after ${timeoutMs} ms`), timeoutMs);

    child.on('error', (e) => fail(`failed to spawn probe: ${e.message}`));
    child.stdout.on('data', (c: Buffer) => { outLen += c.length; if (outLen > maxStdout) return fail(`probe stdout exceeded ${maxStdout} bytes`); out.push(c); });
    child.stderr.on('data', (c: Buffer) => { errLen += c.length; if (errLen > MAX_STDERR) return fail('probe stderr exceeded its bound'); err.push(c); });
    child.on('close', (code) => finish(() => {
      if (errLen > 0) return reject(new ProbeError(`probe wrote to stderr (machine output must be stdout-only): ${Buffer.concat(err).toString('utf8').slice(0, 400)}`));
      if (code !== 0) return reject(new ProbeError(`probe exited with a nonzero code (${code})`));
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(out)); }
      catch { return reject(new ProbeError('probe stdout is not valid UTF-8')); }
      const lines = text.split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop(); // drop trailing newline's empty tail
      const responses: ProbeResponse[] = [];
      for (const line of lines) {
        if (line === '') return reject(new ProbeError('probe emitted a blank output line'));
        let r: ProbeResponse;
        try { r = JSON.parse(line) as ProbeResponse; } catch { return reject(new ProbeError(`probe emitted a non-JSON output line: ${line.slice(0, 200)}`)); }
        responses.push(r);
      }
      resolve(responses);
    }));

    child.stdin.on('error', () => { /* ignore EPIPE if the child exits early */ });
    child.stdin.write(requests.map((r) => JSON.stringify(r)).join('\n') + '\n');
    child.stdin.end();
  });
}

const OK_KEYS = new Set(['protocol', 'id', 'status', 'result', 'diagnostics']);
const ERROR_KEYS = new Set(['protocol', 'id', 'status', 'error']);
const ERROR_FIELDS = new Set(['stage', 'category', 'message']);

/**
 * Strictly validate one response envelope by its discriminant. An `ok` envelope
 * requires exactly {protocol, id, status, result, diagnostics}; an `error`
 * envelope requires exactly {protocol, id, status, error}. Contradictory,
 * missing, mistyped, or unknown fields are rejected — a malformed envelope must
 * never slip through the gate.
 */
export function validateResponseEnvelope(r: ProbeResponse): void {
  const rec = r as Record<string, unknown>;
  if (rec['protocol'] !== PROBE_PROTOCOL) throw new ProbeError(`response protocol is ${JSON.stringify(rec['protocol'])} (expected ${PROBE_PROTOCOL})`);
  if (typeof rec['id'] !== 'string') throw new ProbeError(`response has a non-string id: ${JSON.stringify(rec['id'])}`);
  const id = rec['id'];
  const status = rec['status'];
  if (status === 'ok') {
    for (const k of Object.keys(rec)) if (!OK_KEYS.has(k)) throw new ProbeError(`ok response for id "${id}" has an unexpected key "${k}"`);
    const result = rec['result'];
    if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new ProbeError(`ok response for id "${id}" must carry a "result" object`);
    const diags = rec['diagnostics'];
    if (!Array.isArray(diags) || !diags.every((d) => typeof d === 'string')) throw new ProbeError(`ok response for id "${id}" must carry a "diagnostics" array of strings`);
  } else if (status === 'error') {
    for (const k of Object.keys(rec)) if (!ERROR_KEYS.has(k)) throw new ProbeError(`error response for id "${id}" has an unexpected key "${k}"`);
    const err = rec['error'];
    if (typeof err !== 'object' || err === null || Array.isArray(err)) throw new ProbeError(`error response for id "${id}" must carry an "error" object`);
    const e = err as Record<string, unknown>;
    for (const k of Object.keys(e)) if (!ERROR_FIELDS.has(k)) throw new ProbeError(`error object for id "${id}" has an unexpected key "${k}"`);
    for (const f of ERROR_FIELDS) if (typeof e[f] !== 'string') throw new ProbeError(`error.${f} for id "${id}" must be a string`);
  } else {
    throw new ProbeError(`response for id "${id}" has an invalid status ${JSON.stringify(status)}`);
  }
}

/** Match responses to requests by id: exactly one per request; no missing/duplicate/unknown/excess. */
export function matchResponses(requests: readonly ProbeRequest[], responses: readonly ProbeResponse[]): Map<string, ProbeResponse> {
  const want = new Set(requests.map((r) => r.id));
  const byId = new Map<string, ProbeResponse>();
  for (const r of responses) {
    validateResponseEnvelope(r); // strict shape (checks protocol, id, status discriminant)
    const id = r.id as string;
    if (!want.has(id)) throw new ProbeError(`response for an unknown id "${id}"`);
    if (byId.has(id)) throw new ProbeError(`duplicate response for id "${id}"`);
    byId.set(id, r);
  }
  if (responses.length !== requests.length) throw new ProbeError(`expected ${requests.length} responses, got ${responses.length}`);
  for (const id of want) if (!byId.has(id)) throw new ProbeError(`missing response for id "${id}"`);
  return byId;
}

/** Validate the capabilities result advertises every operation/profile the lane needs. */
export function validateCapabilities(result: unknown): void {
  const ops = (result as { operations?: unknown } | null)?.operations;
  if (!Array.isArray(ops)) throw new ProbeError('capabilities result is missing an operations array');
  const need: Record<string, readonly string[]> = {
    'catalog.parse': ['msf-00', 'msf-01', 'msf-01-draft', 'cmsf-01'],
    'catalog.delta.parse': ['msf-01'],
  };
  for (const [opName, profiles] of Object.entries(need)) {
    const op = ops.find((o) => (o as { operation?: unknown }).operation === opName) as { supported?: unknown; profiles?: unknown } | undefined;
    if (!op || op.supported !== true) throw new ProbeError(`capabilities: operation "${opName}" is not supported`);
    const list = Array.isArray(op.profiles) ? op.profiles : [];
    for (const p of profiles) {
      const pe = list.find((x) => (x as { profile?: unknown }).profile === p) as { supported?: unknown } | undefined;
      if (!pe || pe.supported !== true) throw new ProbeError(`capabilities: "${opName}" profile "${p}" is not supported`);
    }
  }
}

export type DiffCohort = 'libmoq-import' | 'spec-msf01-success';
export interface DiffVector {
  readonly entry: CorpusEntry;
  readonly request: ProbeRequest;
  readonly cohort: DiffCohort;
}

/**
 * The spec-msf01-success cohort is an EXPLICIT allowlist of the 14 successful
 * MSF-01/CMSF-01 spec vectors — NOT a regex over prefixes. A new successful
 * `msf01-*`/`cmsf01-*` vector is therefore NOT absorbed into the lane until it is
 * added here deliberately.
 */
export const SPEC_MSF01_DIFF_IDS: ReadonlySet<string> = new Set([
  'catalog/msf01-version-string-one',
  'catalog/msf01-version-draft',
  'catalog/msf01-vod-trackduration',
  'catalog/msf01-depends',
  'catalog/msf01-template-wide',
  'catalog/msf01-initdata-initref',
  'catalog/msf01-unknown-fields',
  'catalog/msf01-mimetype-canonical',
  'catalog/cmsf01-clear-cmaf',
  'catalog/cmsf01-simulcast-altgroup',
  'catalog/cmsf01-sap-eventtimeline',
  'catalog/cmsf01-content-protection',
  'catalog/msf01-delta-add-clone',
  'catalog/msf01-delta-remove',
]);

/**
 * The probe profile for a vector's request. Draft routing is EXACT: only the
 * recognized `draft-01` alias maps to the probe's `msf-01-draft` profile. Any
 * other `draft-*` spelling is unsupported and MUST NOT be routed as a successful
 * request — it is rejected here rather than sent.
 */
export function probeProfile(entry: CorpusEntry, utf8: string): string {
  if (entry.kind === 'catalog-delta-parse') return 'msf-01'; // op-array deltas
  if (entry.profile === 'cmsf-01') return 'cmsf-01';
  if (entry.profile === 'msf-00') return 'msf-00';
  // MSF-01 catalog: parse the raw version to route draft vs release form.
  let version: unknown;
  try { version = (JSON.parse(utf8) as { version?: unknown }).version; } catch { version = undefined; }
  if (typeof version === 'string' && /^draft-/.test(version)) {
    if (version !== 'draft-01') {
      throw new ProbeError(`unsupported draft version "${version}" cannot be routed as a successful request (only "draft-01" is recognized)`);
    }
    return 'msf-01-draft';
  }
  return 'msf-01';
}

/**
 * PURE cohort classifier. `libmoq-import` is matched by the LibMoQ import
 * prefix; `spec-msf01-success` is the EXPLICIT allowlist (never a prefix).
 * Anything else is not a lane vector (`null`). This is the single decision point
 * the selection uses, so a discrimination test can feed it a synthetic entry and
 * prove a prefix-only fallback would fail.
 */
export function classifyCohort(entry: CorpusEntry): DiffCohort | null {
  if (entry.id.startsWith('catalog/libmoq-')) return 'libmoq-import';
  if (SPEC_MSF01_DIFF_IDS.has(entry.id)) return 'spec-msf01-success';
  return null;
}

/**
 * Select the live differential cohorts and build their probe requests:
 *   - libmoq-import: the 14 LibMoQ catalog imports.
 *   - spec-msf01-success: the 14 allowlisted successful MSF-01/CMSF-01 spec
 *     vectors (SPEC_MSF01_DIFF_IDS).
 * Spec ERROR vectors (incl. the unsupported-version detectors) are excluded
 * until the probe exposes matching error categories; the numeric MSF-00
 * detection vector is Playa-executable, not a probe cohort. Ids are vector ids.
 */
export function selectDiffVectors(): DiffVector[] {
  const loaded = loadDomain('catalog');
  const decoder = new TextDecoder();
  const out: DiffVector[] = [];
  for (const v of loaded.vectors) {
    const id = v.entry.id;
    const cohort = classifyCohort(v.entry);
    if (cohort === null) continue;
    if (cohort === 'spec-msf01-success' && v.entry.expect.status !== 'ok') throw new ProbeError(`spec allowlist integrity: "${id}" is not an ok-status vector`);
    const utf8 = decoder.decode(v.bytes!);
    const request: ProbeRequest = {
      protocol: PROBE_PROTOCOL,
      id,
      operation: v.entry.kind === 'catalog-delta-parse' ? 'catalog.delta.parse' : 'catalog.parse',
      profile: probeProfile(v.entry, utf8),
      input: { utf8 },
    };
    out.push({ entry: v.entry, request, cohort });
  }
  // Allowlist completeness: every allowlisted id must have been found.
  const foundSpec = new Set(out.filter((v) => v.cohort === 'spec-msf01-success').map((v) => v.entry.id));
  for (const id of SPEC_MSF01_DIFF_IDS) if (!foundSpec.has(id)) throw new ProbeError(`spec allowlist integrity: "${id}" is not present in the corpus`);
  return out;
}
