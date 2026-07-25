/**
 * Corpus AUTHORING script (manual, not run by tests/CI).
 *
 *   AUTHOR_CORPUS=1 tsx conformance/media/runner/src/build-corpus.ts
 *
 * ORACLE INDEPENDENCE: for every executable vector with a `normative` or
 * `interpretation` basis, the `expect` block is an INDEPENDENTLY AUTHORED
 * literal (reasoned from the cited draft), NOT captured from Playa. The script
 * then runs Playa purely to populate `differential.playa` — `pass` (omitted)
 * when Playa matches the authored truth, or `diverges` + `currentBehavior` when
 * it does not. Only `regression`-basis vectors derive their `expect` from the
 * implementation (which is what "regression pin" means).
 *
 * Re-running is byte-stable. Provenance `sourceHash` is the real SHA-256 of the
 * cited draft file.
 *
 * @module
 */

import { writeFileSync, mkdirSync, rmSync, renameSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { refVi64, refQuicVarint, refEncodeBlock, type WireProfile as RefWireProfile, type RefPropEntry } from './ref-codec.js';
import { toHex } from './canonical.js';
import { runLocProperties, runLocEncode } from './loc-exec.js';
import { runCatalog } from './catalog-exec.js';
import { runBmff } from './bmff-exec.js';
import { resultMatches, resultToExpect, type ExecResult } from './exec-compare.js';
import type {
  CorpusEntry, DomainManifest, ExpectBlock, Provenance,
  PropertyMapEntryJson, ExpectationBasis, BmffOperation, ErrorCategory,
} from './schema-types.js';
import { validateManifest } from './validate.js';
import { jsonSchemaValidate } from './schema-json.js';
import { commitCorpus } from './commit.js';
import { msf01Project, msf01DeltaProject, readImportedFixture } from './libmoq-import.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(HERE, '../../vectors');

// Real SHA-256 of the cited draft files under ~/Projects/MoQ/Spec.
const DRAFT_SHA: Record<string, string> = {
  'draft-ietf-moq-transport-14': '1e6f59bd6d15c8d372932cfbb00dd1c8db7da10771eb57291b9732ea557582b8',
  'draft-ietf-moq-transport-16': '2174e50090f20801df4d21e16b9ec21abe593e6ba2a84e43142aabdeb47b2c18',
  'draft-ietf-moq-transport-18': '9e6b32cb7797c151e9e127374c1291af3ed546b2d453cd5bbb15946977eeeeb6',
  'draft-ietf-moq-loc-01': '2d2be396d29c442a924b10d21766bbea33349fff39ca49d8f528c33b77a2499f',
  'draft-ietf-moq-msf-00': '55bcc55a4b93a2e8bd707bb9b02a9cc7370a99cd20b493819bf62a50ad0aaf3f',
  'draft-ietf-moq-msf-01': 'c3e68aac09c36ae1db4afde6fd0600a949e7265348f592520304a31e993c35af',
  'draft-ietf-moq-cmsf-00': '8dee5af3d6c028a3be8e808ac2afcf50f4aeaf6074a39f6804b2385814a68a86',
  'draft-ietf-moq-cmsf-01': 'c0ba68d09d6d42540ca0ac7f5df30b66aae7ede11fdc14e8338de977da9cc04d',
  'draft-ietf-moq-catalogformat-01': '65bb99327880b3de33a233331aa724fb60a5c78eb1ce34ab6b52c3351e72c507',
};

// ─── byte builders (INDEPENDENT reference codec — never production) ──

const vi64B = refVi64;
const varintB = refQuicVarint;
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}

type WireProfile = RefWireProfile;
type PropEntry = RefPropEntry;

/** On-wire encoding preserving caller order (for authoring specific decode inputs). */
function encodeBlock(entries: PropEntry[], profile: WireProfile): Uint8Array {
  return refEncodeBlock(entries, profile, { canonical: false });
}
/** Canonical (stable ascending-ID) encoding — the Layer-A encode contract. */
function canonicalBlock(entries: PropEntry[], profile: WireProfile): Uint8Array {
  return refEncodeBlock(entries, profile, { canonical: true });
}

function propMapProjection(entries: PropEntry[]): unknown {
  return {
    properties: entries.map((e) =>
      typeof e.value === 'bigint'
        ? { id: e.id.toString(10), valueKind: 'varint', value: e.value.toString(10) }
        : { id: e.id.toString(10), valueKind: 'bytes', value: e.value.length <= 64 ? toHex(e.value) : { sha256: sha256(e.value), byteLength: e.value.length } }),
  };
}
function propMapInput(entries: PropEntry[]): PropertyMapEntryJson[] {
  return entries.map((e) => typeof e.value === 'bigint'
    ? { id: e.id.toString(10), valueKind: 'varint' as const, value: e.value.toString(10) }
    : { id: e.id.toString(10), valueKind: 'bytes' as const, value: toHex(e.value) });
}

// ─── BMFF builders (from packages/browser/src/mp4-box.test.ts) ───────

const u32 = (n: number): Uint8Array => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
function u64(n: bigint): Uint8Array { const b = new Uint8Array(8); for (let i = 7; i >= 0; i--) { b[i] = Number(n & 0xffn); n >>= 8n; } return b; }
const fourcc = (s: string): Uint8Array => new Uint8Array([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]);
function box(type: string, body: Uint8Array): Uint8Array { return concat(u32(8 + body.byteLength), fourcc(type), body); }
function fullBox(type: string, version: number, flags: number, body: Uint8Array): Uint8Array {
  return box(type, concat(new Uint8Array([version & 0xff, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), body));
}
const tfdtV0 = (bmd: number): Uint8Array => fullBox('tfdt', 0, 0, u32(bmd));
const tfdtV1 = (bmd: bigint): Uint8Array => fullBox('tfdt', 1, 0, u64(bmd));
function tfhd(trackId: number, defaultSampleDuration?: number): Uint8Array {
  let flags = 0; const parts = [u32(trackId)];
  if (defaultSampleDuration !== undefined) { flags |= 0x000008; parts.push(u32(defaultSampleDuration)); }
  return fullBox('tfhd', 0, flags, concat(...parts));
}
const trunNoDur = (sampleCount: number): Uint8Array => fullBox('trun', 0, 0, u32(sampleCount));
const traf = (...c: Uint8Array[]): Uint8Array => box('traf', concat(...c));
const moof = (...c: Uint8Array[]): Uint8Array => box('moof', concat(...c));
const mdat = (size: number): Uint8Array => box('mdat', new Uint8Array(size));
function trex(trackId: number, dur: number): Uint8Array { return fullBox('trex', 0, 0, concat(u32(trackId), u32(1), u32(dur), u32(0), u32(0))); }
const mvex = (...t: Uint8Array[]): Uint8Array => box('mvex', concat(...t));
const moov = (...c: Uint8Array[]): Uint8Array => box('moov', concat(...c));

// ─── provenance ─────────────────────────────────────────────────────

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function specProv(source: string, section: string): Provenance {
  const sourceHash = DRAFT_SHA[source];
  if (sourceHash === undefined) throw new Error(`no recorded SHA-256 for draft "${source}"`);
  return { class: 'spec-derived', source, section, generator: 'hand-authored', generatorVersion: 'n/a', command: 'AUTHOR_CORPUS=1 tsx build-corpus.ts', sourceHash };
}
function implProv(source: string, section: string, bytes: Uint8Array): Provenance {
  return { class: 'implementation-generated', source, section, generator: 'playa:build-corpus', generatorVersion: 'n/a', command: 'AUTHOR_CORPUS=1 tsx build-corpus.ts', sourceHash: sha256(bytes) };
}

// ─── accumulation ───────────────────────────────────────────────────

interface FileWrite { domain: string; file: string; bytes: Uint8Array }
const files: FileWrite[] = [];
const domains = new Map<string, CorpusEntry[]>();
function addEntry(domain: string, entry: CorpusEntry): void {
  if (!domains.has(domain)) domains.set(domain, []);
  domains.get(domain)!.push(entry);
}
function fileInput(domain: string, file: string, bytes: Uint8Array): CorpusEntry['input'] {
  files.push({ domain, file, bytes });
  return bytes.length <= 512 && file.endsWith('.bin')
    ? { file, byteLength: bytes.length, sha256: sha256(bytes), hex: toHex(bytes) }
    : { file, byteLength: bytes.length, sha256: sha256(bytes) };
}

/** Attach a computed differential.playa to an authored expect (oracle-independent). */
function withDifferential(expect: ExpectBlock, actual: ExecResult, reason: string): Pick<CorpusEntry, 'expect' | 'differential'> {
  if (resultMatches(actual, expect)) return { expect };
  return { expect, differential: { playa: { status: 'diverges', reason, currentBehavior: resultToExpect(actual, expect.stage) } } };
}

// ════════════════════════════════════════════════════════════════════
// PROPERTIES (Layer A) — spec-authored
// ════════════════════════════════════════════════════════════════════

const CAP_TS = 2n;
const VIDEO_CONFIG = 13n;
const EQUIV: Array<[string, bigint]> = [
  ['63', 63n], ['64', 64n], ['127', 127n], ['128', 128n],
  ['16383', 16383n], ['16384', 16384n], ['epoch', 1726000000000000n], ['max62', 4611686018427387903n],
];

function buildProperties(): void {
  const p18 = specProv('draft-ietf-moq-transport-18', '1.4.3'); // KVP Structure in draft-18
  const p16 = specProv('draft-ietf-moq-transport-16', '1.4.2'); // KVP Structure in draft-16
  const p14 = specProv('draft-ietf-moq-transport-14', '1.4.2');

  for (const [label, v] of EQUIV) {
    const entries: PropEntry[] = [{ id: CAP_TS, value: v }];
    for (const profile of ['d16-delta-varint', 'd18-delta-vi64'] as const) {
      const tag = profile === 'd16-delta-varint' ? 'd16' : 'd18';
      const bytes = encodeBlock(entries, profile);
      addEntry('properties', {
        id: `properties/equiv-${label}-${tag}`, kind: 'property-block-decode',
        profile: tag === 'd16' ? 'transport-16' : 'transport-18', wireProfile: profile,
        description: `Capture Timestamp (id 2, even) value ${v} under ${profile}; decodes to the identical PropertyMap regardless of wire (QUIC↔vi64 divergence begins at 64).`,
        input: fileInput('properties', `equiv_${label}_${tag}.bin`, bytes),
        expect: { status: 'ok', stage: 'decode', semantics: propMapProjection(entries) },
        expectationBasis: 'normative', provenance: tag === 'd16' ? p16 : p18,
      });
    }
  }

  // Non-minimal decode (d18 0x8025=37, d16 0x4025=37) → canonical minimal 0x25.
  {
    const bytes = concat(vi64B(CAP_TS), Uint8Array.from([0x80, 0x25]));
    addEntry('properties', {
      id: 'properties/non-minimal-d18', kind: 'property-block-decode', profile: 'transport-18', wireProfile: 'd18-delta-vi64',
      description: 'Non-minimal vi64 (0x8025 = 37) is valid on read (§1.4.1); canonical encode is minimal (0x25).',
      input: fileInput('properties', 'non_minimal_d18.bin', bytes),
      expect: { status: 'ok', stage: 'decode', semantics: propMapProjection([{ id: CAP_TS, value: 37n }]), canonicalHex: toHex(encodeBlock([{ id: CAP_TS, value: 37n }], 'd18-delta-vi64')) },
      expectationBasis: 'normative', provenance: specProv('draft-ietf-moq-transport-18', '1.4.1'),
    });
  }
  {
    const bytes = concat(varintB(CAP_TS), Uint8Array.from([0x40, 0x25]));
    addEntry('properties', {
      id: 'properties/non-minimal-d16', kind: 'property-block-decode', profile: 'transport-16', wireProfile: 'd16-delta-varint',
      description: 'Non-minimal QUIC varint (0x4025 = 37) decodes to 37; canonical encode is minimal (0x25).',
      input: fileInput('properties', 'non_minimal_d16.bin', bytes),
      expect: { status: 'ok', stage: 'decode', semantics: propMapProjection([{ id: CAP_TS, value: 37n }]), canonicalHex: toHex(encodeBlock([{ id: CAP_TS, value: 37n }], 'd16-delta-varint')) },
      expectationBasis: 'normative', provenance: p16,
    });
  }

  for (const [label, v] of [['pow62', 4611686018427387904n], ['max64', 18446744073709551615n]] as const) {
    const entries: PropEntry[] = [{ id: CAP_TS, value: v }];
    addEntry('properties', {
      id: `properties/d18-only-${label}`, kind: 'property-block-decode', profile: 'transport-18', wireProfile: 'd18-delta-vi64',
      description: `Value ${v} exceeds the QUIC varint range (2^62-1); only a d18 vi64 form exists.`,
      input: fileInput('properties', `d18_only_${label}.bin`, encodeBlock(entries, 'd18-delta-vi64')),
      expect: { status: 'ok', stage: 'decode', semantics: propMapProjection(entries) },
      expectationBasis: 'normative', provenance: p18,
    });
  }

  // Encode direction: a successful canonical encode, plus the d16 range rejection.
  addEntry('properties', {
    id: 'properties/d18-encode-canonical', kind: 'property-block-decode', profile: 'transport-18', wireProfile: 'd18-delta-vi64',
    description: 'Encoding PropertyMap {id 2, value 100} under d18 produces the canonical minimal vi64 block.',
    input: { propertyMap: propMapInput([{ id: CAP_TS, value: 100n }]) },
    expect: { status: 'ok', stage: 'encode', bytesHex: toHex(encodeBlock([{ id: CAP_TS, value: 100n }], 'd18-delta-vi64')) },
    expectationBasis: 'normative', provenance: p18,
  });
  addEntry('properties', {
    id: 'properties/d16-encode-range-reject', kind: 'property-block-decode', profile: 'transport-16', wireProfile: 'd16-delta-varint',
    description: 'Encoding a value >= 2^62 under the d16 QUIC-varint profile is a typed range error, never a silent truncation.',
    input: { propertyMap: propMapInput([{ id: CAP_TS, value: 4611686018427387904n }]) },
    expect: { status: 'error', stage: 'encode', error: { category: 'value-out-of-range' } },
    expectationBasis: 'normative', provenance: p16,
  });
  // The ID field itself is range-bound too: a d16/d14 id >= 2^62 does not fit the
  // QUIC-varint type field and is a typed value-out-of-range error (categorised,
  // never a bare truncation).
  addEntry('properties', {
    id: 'properties/d16-encode-id-range-reject', kind: 'property-block-decode', profile: 'transport-16', wireProfile: 'd16-delta-varint',
    description: 'Encoding an id (type field) of 2^62 under d16 exceeds the QUIC-varint range and is a typed value-out-of-range error.',
    input: { propertyMap: propMapInput([{ id: 4611686018427387904n, value: 0n }]) },
    expect: { status: 'error', stage: 'encode', error: { category: 'value-out-of-range' } },
    expectationBasis: 'normative', provenance: p16,
  });
  addEntry('properties', {
    id: 'properties/d14-encode-id-range-reject', kind: 'property-block-decode', profile: 'transport-14', wireProfile: 'd14-absolute-varint',
    description: 'Encoding an absolute id of 2^62 under d14 exceeds the QUIC-varint range and is a typed value-out-of-range error.',
    input: { propertyMap: propMapInput([{ id: 4611686018427387904n, value: 0n }]) },
    expect: { status: 'error', stage: 'encode', error: { category: 'value-out-of-range' } },
    expectationBasis: 'normative', provenance: p14,
  });

  addEntry('properties', {
    id: 'properties/d14-absolute-basic', kind: 'property-block-decode', profile: 'transport-14', wireProfile: 'd14-absolute-varint',
    description: 'Draft-14 uses ABSOLUTE (non-delta) type IDs; single Capture Timestamp value 42.',
    input: fileInput('properties', 'd14_absolute_basic.bin', encodeBlock([{ id: CAP_TS, value: 42n }], 'd14-absolute-varint')),
    expect: { status: 'ok', stage: 'decode', semantics: propMapProjection([{ id: CAP_TS, value: 42n }]) },
    expectationBasis: 'normative', provenance: p14,
  });

  // Odd-value length boundary (§1.4.3: max value length is 2^16-1, MUST close over).
  {
    const payload = new Uint8Array(65535);
    addEntry('properties', {
      id: 'properties/odd-value-65535-accepted', kind: 'property-block-decode', profile: 'transport-18', wireProfile: 'd18-delta-vi64',
      description: 'Odd-id (Video Config, id 13) value of exactly 65535 bytes — the maximum permitted value length (§1.4.3).',
      input: fileInput('properties', 'odd_value_65535.bin', encodeBlock([{ id: VIDEO_CONFIG, value: payload }], 'd18-delta-vi64')),
      expect: { status: 'ok', stage: 'decode', semantics: propMapProjection([{ id: VIDEO_CONFIG, value: payload }]) },
      expectationBasis: 'normative', provenance: p18,
    });
  }
  {
    const bytes = concat(vi64B(VIDEO_CONFIG), vi64B(65536n), new Uint8Array(65536));
    addEntry('properties', {
      id: 'properties/odd-value-65536-rejected', kind: 'property-block-decode', profile: 'transport-18', wireProfile: 'd18-delta-vi64',
      description: 'A value length of 65536 exceeds the 2^16-1 maximum; §1.4.3 requires a PROTOCOL_VIOLATION close.',
      input: fileInput('properties', 'odd_value_65536.bin', bytes),
      expect: { status: 'error', stage: 'decode', error: { category: 'odd-value-too-long' } },
      expectationBasis: 'normative', provenance: p18,
    });
  }

  {
    const bytes = concat(vi64B(CAP_TS), Uint8Array.from([0xc0]));
    addEntry('properties', {
      id: 'properties/truncated-value', kind: 'property-block-decode', profile: 'transport-18', wireProfile: 'd18-delta-vi64',
      description: 'The value vi64 (first byte 0xC0 → 3-byte length) runs off the end of the block.',
      input: fileInput('properties', 'truncated_value.bin', bytes),
      expect: { status: 'error', stage: 'decode', error: { category: 'truncated' } },
      expectationBasis: 'normative', provenance: p18,
    });
  }
  {
    const bytes = concat(vi64B(18446744073709551615n), vi64B(0n), vi64B(2n), vi64B(0n));
    addEntry('properties', {
      id: 'properties/delta-overflow', kind: 'property-block-decode', profile: 'transport-18', wireProfile: 'd18-delta-vi64',
      description: 'A second id-delta pushes the accumulated type ID past 2^64-1; §1.4.3 requires a PROTOCOL_VIOLATION close.',
      input: fileInput('properties', 'delta_overflow.bin', bytes),
      expect: { status: 'error', stage: 'decode', error: { category: 'delta-overflow' } },
      expectationBasis: 'normative', provenance: p18,
    });
  }

  // ── Canonical ordering + duplicate + parity contract ──
  // Encode with UNSORTED caller order → canonical stable ascending-ID output.
  {
    const unsorted: PropEntry[] = [{ id: 6n, value: 0x7fn }, { id: 2n, value: 42n }];
    addEntry('properties', {
      id: 'properties/encode-unsorted-canonical', kind: 'property-block-decode', profile: 'transport-18', wireProfile: 'd18-delta-vi64',
      description: 'Encoding an unsorted PropertyMap [id 6, id 2] yields the canonical ascending-ID block [id 2, id 6]. The wire (§1.4.3) requires non-decreasing ids, but sorting arbitrary caller input is a documented Playa canonicalization policy, not a spec MUST.',
      input: { propertyMap: propMapInput(unsorted) },
      expect: { status: 'ok', stage: 'encode', bytesHex: toHex(canonicalBlock(unsorted, 'd18-delta-vi64')) },
      expectationBasis: 'interpretation', provenance: p18,
    });
  }
  // Encode with DUPLICATE ids → canonical preserves their relative (stable) order.
  {
    const dup: PropEntry[] = [{ id: 2n, value: 100n }, { id: 2n, value: 200n }];
    addEntry('properties', {
      id: 'properties/encode-duplicate-ids', kind: 'property-block-decode', profile: 'transport-18', wireProfile: 'd18-delta-vi64',
      description: 'Encoding duplicate id 2 (values 100 then 200) preserves their relative order in the canonical block (delta 0 for the repeat). Duplicate-order preservation is a documented Playa policy, not a spec MUST.',
      input: { propertyMap: propMapInput(dup) },
      expect: { status: 'ok', stage: 'encode', bytesHex: toHex(canonicalBlock(dup, 'd18-delta-vi64')) },
      expectationBasis: 'interpretation', provenance: p18,
    });
  }
  // Decode with DUPLICATE ids → PropertyMap preserves both occurrences in order.
  {
    const bytes = concat(vi64B(2n), vi64B(100n), vi64B(0n), vi64B(200n)); // id 2 = 100, delta 0 (id 2) = 200
    addEntry('properties', {
      id: 'properties/decode-duplicate-ids', kind: 'property-block-decode', profile: 'transport-18', wireProfile: 'd18-delta-vi64',
      description: 'Decoding a block with two id-2 entries preserves BOTH in occurrence order. Representing duplicates in a normalized PropertyMap (rather than deduping) is a documented Playa policy; dedup is a Layer-B semantic concern.',
      input: fileInput('properties', 'decode_duplicate_ids.bin', bytes),
      expect: { status: 'ok', stage: 'decode', semantics: { properties: [{ id: '2', valueKind: 'varint', value: '100' }, { id: '2', valueKind: 'varint', value: '200' }] } },
      expectationBasis: 'interpretation', provenance: p18,
    });
  }
  // Encode with a value type that mismatches the id parity → typed error.
  addEntry('properties', {
    id: 'properties/encode-parity-mismatch', kind: 'property-block-decode', profile: 'transport-18', wireProfile: 'd18-delta-vi64',
    description: 'An even id (2) carrying a byte value violates the parity rule (even ⇒ varint, odd ⇒ length-prefixed bytes); the encoder rejects it.',
    input: { propertyMap: [{ id: '2', valueKind: 'bytes', value: 'aabb' }] },
    expect: { status: 'error', stage: 'encode', error: { category: 'parity-mismatch' } },
    expectationBasis: 'normative', provenance: p18,
  });
}

// ════════════════════════════════════════════════════════════════════
// LOC-SEMANTICS (Layer B)
// ════════════════════════════════════════════════════════════════════

function buildLocSemantics(): void {
  const src = specProv('draft-ietf-moq-loc-01', '2.3');
  const mk = (id: string, entries: PropEntry[], semantics: unknown, description: string, basis: ExpectationBasis): void => {
    addEntry('loc', {
      id, kind: 'loc-semantics', profile: 'loc-01', scope: 'object', description,
      input: { propertyMap: propMapInput(entries) },
      expect: { status: 'ok', stage: 'semantic', semantics }, expectationBasis: basis, provenance: src,
    });
  };

  // Authored Layer-B contract literals (independent of the impl).
  mk('loc/sem-all-four',
    [{ id: 2n, value: 42n }, { id: 4n, value: 0x20n }, { id: 6n, value: 0x7fn }, { id: 13n, value: Uint8Array.from([0x01, 0x02, 0x03]) }],
    { captureTimestamp: '42', videoFrameMarking: VFM_INDEPENDENT, audioLevel: { voiceActivity: false, level: 127 }, videoConfig: '010203' },
    'LOC-01 interpretation of all four known properties from a structured PropertyMap.', 'normative');

  mk('loc/sem-duplicate-last-wins',
    [{ id: 2n, value: 100n }, { id: 2n, value: 200n }],
    { captureTimestamp: '200' },
    'Duplicate Capture Timestamp: current behavior silently keeps the LAST value (regression pin of the Layer-B policy the resolver must reproduce).', 'regression');

  mk('loc/sem-unknown-full-width-id',
    [{ id: 18446744073709551614n, value: 7n }],
    { unknown: [{ id: '18446744073709551614', name: null, value: '7' }] },
    'An unknown even property with a near-2^64 id is preserved losslessly. The unknown map is bigint-keyed so the id survives intact (the Layer-B contract).',
    'interpretation');

  mk('loc/sem-audio-level-high-bits',
    [{ id: 6n, value: 0x1ffn }],
    { audioLevel: { voiceActivity: true, level: 127 } },
    'Audio Level value 0x1FF: current behavior silently masks to the low 8 bits (level 127, voice active) — regression pin.', 'regression');
}

const VFM_INDEPENDENT = { startOfFrame: false, endOfFrame: false, independent: true, discardable: false, baseLayerSync: false, temporalId: 0 };

// ════════════════════════════════════════════════════════════════════
// LOC-PROPERTIES (A+B end-to-end) — executable
// ════════════════════════════════════════════════════════════════════

function buildLocProperties(): void {
  const src = specProv('draft-ietf-moq-loc-01', '2.3');
  const REASON = 'headers.ts encodes AND decodes property blocks with the QUIC-varint codec for all non-draft-14 profiles; draft-18 carries a vi64 block (values >= 64 diverge).';

  // Authored-expect decode vector; differential.playa computed from the run.
  const decode = (id: string, entries: PropEntry[], profile: WireProfile, expectSemantics: unknown, description: string, basis: ExpectationBasis, file: string): void => {
    const bytes = encodeBlock(entries, profile);
    const actual = runLocProperties(bytes, profile);
    addEntry('loc', {
      id, kind: 'loc-properties', profile: 'loc-01', wireProfile: profile, scope: 'object', description,
      input: fileInput('loc', file, bytes),
      ...withDifferential({ status: 'ok', stage: 'semantic', semantics: expectSemantics }, actual, REASON),
      expectationBasis: basis, provenance: src,
    });
  };
  const decodeErr = (id: string, bytes: Uint8Array, category: 'truncated' | 'length-overrun', description: string, file: string): void => {
    const actual = runLocProperties(bytes, 'd16-delta-varint');
    addEntry('loc', {
      id, kind: 'loc-properties', profile: 'loc-01', wireProfile: 'd16-delta-varint', scope: 'object', description,
      input: fileInput('loc', file, bytes),
      ...withDifferential({ status: 'error', stage: 'decode', error: { category } }, actual, REASON),
      expectationBasis: 'normative', provenance: src,
    });
  };

  // 8 correct d16 decodes (Playa handles d16 → no divergence).
  decode('loc/props-capture-ts-zero', [{ id: 2n, value: 0n }], 'd16-delta-varint', { captureTimestamp: '0' }, 'Capture Timestamp of 0.', 'normative', 'props_ts_zero.bin');
  decode('loc/props-capture-ts-above-2p53', [{ id: 2n, value: 9007199254740993n }], 'd16-delta-varint', { captureTimestamp: '9007199254740993' }, 'Capture Timestamp above 2^53-1 (Number-safety probe); kept exact as bigint.', 'normative', 'props_ts_above_2p53.bin');
  decode('loc/props-capture-ts-max62', [{ id: 2n, value: 4611686018427387903n }], 'd16-delta-varint', { captureTimestamp: '4611686018427387903' }, 'Capture Timestamp at the QUIC-varint maximum (2^62-1).', 'normative', 'props_ts_max62.bin');
  decode('loc/props-vfm-varint', [{ id: 4n, value: 0x20n }], 'd16-delta-varint', { videoFrameMarking: VFM_INDEPENDENT }, 'Video Frame Marking (RFC 9626) independent-frame bit set.', 'normative', 'props_vfm.bin');
  decode('loc/props-audio-level', [{ id: 6n, value: 0x7fn }], 'd16-delta-varint', { audioLevel: { voiceActivity: false, level: 127 } }, 'Audio Level (RFC 6464) magnitude 127, no voice activity.', 'normative', 'props_audio.bin');
  decode('loc/props-video-config', [{ id: 13n, value: Uint8Array.from([0x01, 0x64, 0x00, 0x1f]) }], 'd16-delta-varint', { videoConfig: '0164001f' }, 'Video Config (odd id 13) length-prefixed codec extradata.', 'normative', 'props_vconfig.bin');
  decode('loc/props-all-four', [{ id: 2n, value: 42n }, { id: 4n, value: 0x20n }, { id: 6n, value: 0x7fn }, { id: 13n, value: Uint8Array.from([0xaa, 0xbb]) }], 'd16-delta-varint', { captureTimestamp: '42', videoFrameMarking: VFM_INDEPENDENT, audioLevel: { voiceActivity: false, level: 127 }, videoConfig: 'aabb' }, 'All four known LOC-01 properties in one block.', 'normative', 'props_all_four.bin');
  decode('loc/props-unknown-even-and-odd-skip', [{ id: 8n, value: 99n }, { id: 15n, value: Uint8Array.from([0xde, 0xad]) }], 'd16-delta-varint', { unknown: [{ id: '8', name: null, value: '99' }, { id: '15', name: null, value: 'dead' }] }, 'An unknown even id (8, varint) and unknown odd id (15, bytes) are preserved in the unknown map (each with an explicit null name).', 'normative', 'props_unknown.bin');

  decodeErr('loc/props-err-truncated-varint', concat(varintB(2n), Uint8Array.from([0xc0])), 'truncated', 'The value varint (8-byte QUIC form) runs off the end.', 'props_err_truncated.bin');
  decodeErr('loc/props-err-length-overrun', concat(varintB(13n), varintB(10n), Uint8Array.from([0x01, 0x02])), 'length-overrun', 'An odd-id (Video Config) declares length 10 but only 2 value bytes remain.', 'props_err_overrun.bin');

  // ── The complete draft-18 divergence matrix: EVERY value >= 64, both
  //    directions. (63 does NOT diverge — vi64 and QUIC agree below 64.)
  const GE64: Array<[string, bigint]> = [
    ['64', 64n], ['127', 127n], ['128', 128n], ['16383', 16383n], ['16384', 16384n],
    ['epoch', 1726000000000000n], ['max62', 4611686018427387903n],
    ['pow62', 4611686018427387904n], ['max64', 18446744073709551615n],
  ];

  // DECODE drivers: parseLocHeaders reads the vi64 block with the QUIC codec.
  for (const [label, v] of GE64) {
    decode(`loc/props-d18-ts-${label}-diverges`, [{ id: 2n, value: v }], 'd18-delta-vi64', { captureTimestamp: v.toString(10) },
      `DECODE driver: a draft-18 (vi64) Capture Timestamp ${v} (>= 64, where vi64 and QUIC diverge) decodes correctly under the d18 profile. An earlier build read it with the QUIC codec and mis-decoded it; the id suffix records that origin.`,
      'normative', `props_d18_ts_${label}.bin`);
  }

  // ENCODE drivers: encodeLocHeaders emits QUIC bytes for every draft; the
  // canonical d18 (vi64) block differs for values >= 64 (and it THROWS for
  // values above the QUIC range, another current-behavior divergence).
  for (const [label, v] of GE64) {
    const input = propMapInput([{ id: 2n, value: v }]);
    const actual = runLocEncode(input, 'd18-delta-vi64');
    addEntry('loc', {
      id: `loc/props-d18-encode-${label}-diverges`, kind: 'loc-properties', profile: 'loc-01', wireProfile: 'd18-delta-vi64', scope: 'object',
      description: `ENCODE driver: encoding Capture Timestamp ${v} for a draft-18 target yields the canonical vi64 block. An earlier build emitted QUIC varints (or threw above 2^62-1); the id suffix records that origin.`,
      input: { propertyMap: input },
      ...withDifferential({ status: 'ok', stage: 'encode', bytesHex: toHex(canonicalBlock([{ id: 2n, value: v }], 'd18-delta-vi64')) }, actual, REASON),
      expectationBasis: 'normative', provenance: specProv('draft-ietf-moq-loc-01', '2.3.1.1'),
    });
  }
}

// ════════════════════════════════════════════════════════════════════
// CATALOG — executable
// ════════════════════════════════════════════════════════════════════

function buildCatalog(): void {
  // Normative/interpretation: authored expect + computed differential.
  const authored = (id: string, json: string, expect: ExpectBlock, description: string, basis: ExpectationBasis, source: string, section: string, file: string): void => {
    const bytes = new TextEncoder().encode(json);
    const actual = runCatalog(json);
    addEntry('catalog', {
      id, kind: 'catalog-parse', profile: id.includes('cf01') ? 'cf-01' : 'msf-00', description,
      input: fileInput('catalog', file, bytes),
      ...withDifferential(expect, actual, 'current parseCatalogAuto behavior'),
      expectationBasis: basis, provenance: specProv(source, section),
    });
  };
  // Regression: derive expect from the parser (honest pin of current behavior).
  const regression = (id: string, json: string, description: string, source: string, section: string, file: string): void => {
    const bytes = new TextEncoder().encode(json);
    const actual = runCatalog(json);
    addEntry('catalog', {
      id, kind: 'catalog-parse', profile: id.includes('cf01') ? 'cf-01' : 'msf-00', description,
      input: fileInput('catalog', file, bytes),
      expect: resultToExpect(actual, 'semantic'),
      expectationBasis: 'regression', provenance: specProv(source, section),
    });
  };

  const okTracks = (tracks: unknown[], version = '1'): ExpectBlock => ({ status: 'ok', stage: 'semantic', semantics: { catalogVersion: version, tracks } });

  authored('catalog/msf00-minimal', '{"version":1,"tracks":[]}', okTracks([]),
    'MSF-00 minimal catalog: numeric version, empty tracks.', 'normative', 'draft-ietf-moq-msf-00', '5.1.1', 'msf00_minimal.json');
  authored('catalog/msf00-single-loc-video', '{"version":1,"tracks":[{"name":"video","packaging":"loc","isLive":true,"role":"video","codec":"avc1.64001f"}]}',
    okTracks([{ name: 'video', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.64001f' }]),
    'MSF-00 single LOC video track.', 'normative', 'draft-ietf-moq-msf-00', '5.1', 'msf00_single_loc.json');
  authored('catalog/msf00-rendergroup', '{"version":1,"tracks":[{"name":"v","packaging":"loc","isLive":true,"role":"video","renderGroup":1},{"name":"a","packaging":"loc","isLive":true,"role":"audio","renderGroup":1}]}',
    okTracks([{ name: 'v', packaging: 'loc', isLive: true, role: 'video', renderGroup: '1' }, { name: 'a', packaging: 'loc', isLive: true, role: 'audio', renderGroup: '1' }]),
    'MSF-00 two tracks sharing renderGroup 1.', 'normative', 'draft-ietf-moq-msf-00', '5.1.18', 'msf00_rendergroup.json');
  authored('catalog/cmsf00-inline-initdata', '{"version":1,"tracks":[{"name":"hd","packaging":"cmaf","isLive":true,"role":"video","codec":"avc1.640028","initData":"AAAAIGZ0eXBpc281","width":1920,"height":1080}]}',
    okTracks([{ name: 'hd', packaging: 'cmaf', isLive: true, role: 'video', codec: 'avc1.640028', width: '1920', height: '1080', initData: 'AAAAIGZ0eXBpc281' }]),
    'CMSF-00 CMAF track with per-track inline base64 initData (kept as a string, never decoded).', 'normative', 'draft-ietf-moq-cmsf-00', '3.1', 'cmsf00_initdata.json');
  authored('catalog/cf01-triple', '{"version":1,"streamingFormat":1,"streamingFormatVersion":"0.2","commonTrackFields":{"packaging":"cmaf","namespace":"ns"},"tracks":[{"name":"1.m4s","selectionParams":{"codec":"avc1.640028","mimeType":"video/mp4","width":1280,"height":720}}]}',
    okTracks([{ name: '1.m4s', packaging: 'cmaf', isLive: true, namespace: 'ns', role: 'video', codec: 'avc1.640028', mimeType: 'video/mp4', width: '1280', height: '720' }]),
    'CF-01 catalog: the version+streamingFormat+streamingFormatVersion triple routes to the CF-01 parser.', 'normative', 'draft-ietf-moq-catalogformat-01', '3.2', 'cf01_triple.json');
  authored('catalog/msf00-complete-fields',
    '{"version":1,"tracks":[{"name":"a","packaging":"loc","isLive":true,"role":"video","codec":"av01.0.08M.10","temporalId":0,"spatialId":0},{"name":"b","packaging":"loc","isLive":true,"role":"video","codec":"av01.0.08M.10","temporalId":0,"spatialId":1},{"name":"v","packaging":"loc","isLive":true,"role":"video","codec":"av01.0.08M.10","width":1920,"height":1080,"displayWidth":1920,"displayHeight":1080,"depends":["a","b"],"temporalId":1,"spatialId":0,"framerate":30,"bitrate":1000000}]}',
    okTracks([
      { name: 'a', packaging: 'loc', isLive: true, role: 'video', codec: 'av01.0.08M.10', temporalId: '0', spatialId: '0' },
      { name: 'b', packaging: 'loc', isLive: true, role: 'video', codec: 'av01.0.08M.10', temporalId: '0', spatialId: '1' },
      { name: 'v', packaging: 'loc', isLive: true, role: 'video', codec: 'av01.0.08M.10', framerate: '30', bitrate: '1000000', width: '1920', height: '1080', displayWidth: '1920', displayHeight: '1080', depends: ['a', 'b'], temporalId: '1', spatialId: '0' },
    ]),
    'Exercises the newly-projected display/scalability fields (displayWidth, displayHeight, depends, temporalId, spatialId); base-layer tracks a and b are declared so the enhancement track\'s §5.1.21 depends references resolve to real tracks.', 'normative', 'draft-ietf-moq-msf-00', '5.1', 'msf00_complete_fields.json');

  // Error cases (authored).
  authored('catalog/err-version-two', '{"version":2,"tracks":[]}', { status: 'error', stage: 'semantic', error: { category: 'invalid-version' } },
    'MSF-00 unsupported version 2 is rejected.', 'normative', 'draft-ietf-moq-msf-00', '5.1.1', 'err_version_two.json');
  // MSF-01 §5.1.1: the string version "1" is the canonical MSF-01 spelling. Since
  // the MSF-01 parser, an empty-tracks catalog carrying it is ACCEPTED (was
  // invalid-version pre-M1). The id is retained (stable); the sibling numeric
  // rejection err-version-two still pins the unsupported-version path.
  authored('catalog/err-version-string', '{"version":"1","tracks":[]}', okTracks([]),
    'MSF-01 §5.1.1: the string version "1" with an empty tracks array is a valid MSF-01 catalog (accepted by the MSF-01 parser; rejected as invalid-version by the MSF-00-only parser that preceded it).', 'interpretation', 'draft-ietf-moq-msf-01', '5.1.1', 'err_version_string.json');
  authored('catalog/err-malformed-json', '{"version":1,"tracks":[', { status: 'error', stage: 'semantic', error: { category: 'malformed-json' } },
    'Malformed JSON is rejected.', 'normative', 'draft-ietf-moq-msf-00', '5.1', 'err_malformed.json');
  authored('catalog/err-cf01-jsonpatch-array', '[{"op":"add","path":"/tracks/-","value":{"name":"x"}}]', { status: 'error', stage: 'semantic', error: { category: 'unsupported-delta' } },
    'A CF-01 JSON-Patch array (§3.3) is not an independent catalog; parseCatalogAuto rejects it (patches go through applyCf01Patch).', 'interpretation', 'draft-ietf-moq-catalogformat-01', '3.3', 'err_cf01_jsonpatch.json');
  authored('catalog/err-nonfinite-number', '{"version":1,"generatedAt":1e999,"tracks":[{"name":"v","packaging":"loc","isLive":true}]}',
    { status: 'error', stage: 'semantic', error: { category: 'value-out-of-range' } },
    'A numeric field with a JSON overflow exponent (1e999 parses to Infinity) is rejected: a normalized catalog must carry only finite numbers, so it never propagates a non-finite bitrate/generatedAt/width downstream.', 'interpretation', 'draft-ietf-moq-msf-00', '5.1.6', 'err_nonfinite.json');

  // Regression (current tolerant behavior).
  regression('catalog/msf00-unknown-fields', '{"version":1,"unknownRootKey":42,"tracks":[{"name":"v","packaging":"loc","isLive":true,"role":"video","somethingNew":"x"}]}',
    'Unknown root and track fields are silently dropped by the current parser (regression pin).', 'draft-ietf-moq-msf-00', '5.1', 'msf00_unknown_fields.json');
  regression('catalog/msf00-bitrate-above-2p53', '{"version":1,"tracks":[{"name":"v","packaging":"loc","isLive":true,"role":"video","bitrate":9007199254740993}]}',
    'A bitrate above 2^53-1 as a raw JSON number: JSON.parse silently rounds it (bigint-safety hazard, pinned).', 'draft-ietf-moq-msf-00', '5.1.28', 'msf00_bitrate_big.json');
  regression('catalog/cf01-missing-sfversion', '{"version":1,"streamingFormat":1,"commonTrackFields":{"packaging":"cmaf","namespace":"ns"},"tracks":[{"name":"1.m4s","selectionParams":{"codec":"avc1.640028"}}]}',
    'CF-01 without streamingFormatVersion: the current (non-strict) parser tolerates it (regression pin; strict mode would reject).', 'draft-ietf-moq-catalogformat-01', '3.2.2', 'cf01_missing_sfversion.json');
  // A VALID MSF-00 delta OBJECT: deltaUpdate:true, and §5.2 says a delta MUST NOT
  // carry the MSF version field. parseCatalogAuto is the full-catalog parser (deltas
  // go through applyCatalogUpdate), so this pins how it treats a valid delta.
  regression('catalog/msf00-delta-object', '{"deltaUpdate":true,"addTracks":[{"name":"new","packaging":"loc","isLive":true,"role":"video"}]}',
    'A valid MSF-00 delta update (deltaUpdate:true, NO version field per §5.2) routed through parseCatalogAuto: pins current behavior (the full-catalog parser does not apply deltas — applyCatalogUpdate does).', 'draft-ietf-moq-msf-00', '5.2', 'msf00_delta_object.json');
}

// ════════════════════════════════════════════════════════════════════
// BMFF — executable regression (mp4-box utilities are total; never throw)
// ════════════════════════════════════════════════════════════════════

function buildBmff(): void {
  const add = (id: string, bytes: Uint8Array, operation: BmffOperation, description: string, file: string, section = 'Movie Fragments'): void => {
    const actual = runBmff(bytes, operation);
    addEntry('bmff', {
      id, kind: 'bmff-structure', profile: 'cmaf', operation, description,
      input: fileInput('bmff', file, bytes),
      expect: resultToExpect(actual, 'decode'),
      expectationBasis: 'regression', provenance: implProv('mp4-box test builders (ISO/IEC 14496-12 structure)', section, bytes),
    });
  };

  add('bmff/init-minimal-trex', moov(mvex(trex(1, 3000))), 'trex', 'Minimal init (moov+mvex+trex): current utilities expose only the trex sample defaults (no codec/timescale/dims extractor exists).', 'init_minimal_trex.bin');
  add('bmff/frag-tfdt-v0', concat(moof(traf(tfhd(1, 100), tfdtV0(1000), trunNoDur(5))), mdat(10)), 'peek', 'Fragment with a 32-bit tfdt (baseMediaDecodeTime 1000).', 'frag_tfdt_v0.bin');
  add('bmff/frag-tfdt-v1-large', concat(moof(traf(tfhd(1, 100), tfdtV1(9007199254740993n), trunNoDur(5))), mdat(10)), 'peek', 'Fragment with a 64-bit tfdt above 2^53-1 (9007199254740993); kept exact as bigint.', 'frag_tfdt_v1_large.bin');
  add('bmff/trex-defaults-time-ranges', concat(moov(mvex(trex(1, 512))), moof(traf(tfhd(1), tfdtV0(2000), trunNoDur(4))), mdat(8)), 'timeRanges', 'A fragment whose trun omits per-sample durations falls back to the trex default (512) for its time range.', 'trex_defaults_ranges.bin');
  add('bmff/multi-moof', concat(moof(traf(tfhd(1, 100), tfdtV0(1000), trunNoDur(5))), mdat(10), moof(traf(tfhd(1, 100), tfdtV0(1500), trunNoDur(5))), mdat(10)), 'timeRanges', 'A segment carrying two moof+mdat pairs yields one time range per moof.', 'multi_moof.bin');
  add('bmff/moof-without-mdat', moof(traf(tfhd(1, 100), tfdtV0(1000), trunNoDur(5))), 'peek', 'A moof with no following mdat: the total utility reports the bmd but a null mdatSize (it does not throw).', 'moof_no_mdat.bin');

  // Box-overrun: a top-level box whose size field claims more bytes than present.
  {
    const good = concat(moof(traf(tfhd(1, 100), tfdtV0(1000), trunNoDur(5))), mdat(10));
    const overrun = good.slice();
    // Inflate the leading moof box size to overrun the buffer.
    overrun[0] = 0x7f;
    add('bmff/box-overrun', overrun, 'timeRanges', 'A leading box size that overruns the buffer: readSegmentTimeRanges returns null (malformed), it does not throw.', 'box_overrun.bin');
  }
}

// ════════════════════════════════════════════════════════════════════
// LibMoQ MSF fixture import — third-party, byte-exact
// ════════════════════════════════════════════════════════════════════
//
// The 14 committed LibMoQ MSF test fixtures are imported byte-for-byte. The
// source audit (see conformance/media/provenance/LIBMOQ-MSF-FIXTURES.md)
// DISPROVED the planned "13 executable + 1 MSF-01-shaped" split: the fixtures
// resolve to 5 numeric-version MSF-00/CMSF-00 catalogs, 4 MSF-01 catalogs,
// 3 CMSF-01 catalogs, and 2 MSF-01 op-array delta documents. Initially only the
// 5 numeric catalogs were executable (9 forward-looking); the MSF-01/CMSF-01
// parser promoted the 7 later-era catalogs and the op-array delta parser
// promoted the 2 deltas, so all 14 are now executable. The classification is result-driven,
// so a regression that un-implements a path re-pins it automatically.
//
// Rigor: bytes are preserved exactly; the source SHA-256 is PINNED here, so a
// LibMoQ drift fails authoring rather than silently importing new bytes. The
// independently-authored `expect` is the normalization contract; should a path
// ever diverge again, differential.playa.currentBehavior pins the divergence.

const LIBMOQ_REPO = 'openmoq/moq5 (LibMoQ)';
const LIBMOQ_COMMIT = '455318cade7445880a294e2ec6e6a5ccb67cb776';
const LIBMOQ_FIXTURE_DIR = 'media/msf/tests/fixtures';
// Normal authoring is HERMETIC: it re-derives from the checked-in snapshot
// (conformance/media/vectors/catalog/libmoq_*.json), so a fresh clone or CI
// reproduces the corpus with no external path. A deliberate re-import from a
// LibMoQ worktree is opt-in via LIBMOQ_REFRESH=1 + LIBMOQ_ROOT=<path>, and it
// verifies the worktree is at the pinned commit before copying bytes.
const LIBMOQ_REFRESH = process.env['LIBMOQ_REFRESH'] === '1';

interface LibmoqRow {
  readonly fixture: string;
  readonly sha256: string;
  readonly corpusId: string;
  readonly corpusFile: string;
  readonly era: string;
  readonly profile: string;
  readonly capability: 'executable' | 'forward-looking';
  readonly basis: ExpectationBasis;
  readonly section: string;
}
const libmoqRows: LibmoqRow[] = [];

function libmoqProv(section: string, sourceHash: string): Provenance {
  // third-party: the bytes are LibMoQ's hand-authored fixtures; sourceHash is
  // the SHA-256 of the original file at the pinned commit.
  return {
    class: 'third-party',
    source: `${LIBMOQ_REPO}@${LIBMOQ_COMMIT}:${LIBMOQ_FIXTURE_DIR}`,
    section,
    generator: 'LibMoQ MSF test fixtures (hand-authored)',
    generatorVersion: LIBMOQ_COMMIT,
    command: `byte-exact import from ${LIBMOQ_FIXTURE_DIR}`,
    sourceHash,
  };
}

/** Fetch fixture bytes via the shared hermetic/refresh reader (real deps). */
function importedFixtureBytes(corpusFile: string, fixture: string, pinnedSha: string): { text: string; bytes: Uint8Array } {
  return readImportedFixture(
    { refresh: LIBMOQ_REFRESH, root: process.env['LIBMOQ_ROOT'], libmoqCommit: LIBMOQ_COMMIT, fixtureDir: LIBMOQ_FIXTURE_DIR, snapshotDir: join(VECTORS, 'catalog'), corpusFile, fixture, pinnedSha },
    {
      execFile: (cmd, args) => execFileSync(cmd, [...args], { encoding: 'utf8' }),
      readFile: (p) => new Uint8Array(readFileSync(p)),
      sha256,
    },
  );
}

/** An executable MSF-00/CMSF-00 import (Playa parses it today). */
function importExecutable(
  fixture: string, corpusId: string, sha: string, section: string,
  basis: ExpectationBasis, expect: ExpectBlock, description: string,
): void {
  const corpusFile = `libmoq_${fixture}`;
  const { text, bytes } = importedFixtureBytes(corpusFile, fixture, sha);
  const actual = runCatalog(text);
  addEntry('catalog', {
    id: corpusId, kind: 'catalog-parse', profile: 'msf-00', description,
    input: fileInput('catalog', corpusFile, bytes),
    ...withDifferential(expect, actual, 'current parseCatalogAuto behavior'),
    expectationBasis: basis, provenance: libmoqProv(section, sha),
  });
  libmoqRows.push({ fixture, sha256: sha, corpusId, corpusFile, era: 'msf-00', profile: 'msf-00', capability: 'executable', basis, section });
}

/**
 * A later-era import with a RESULT-DRIVEN differential: the independently-authored
 * `expect` is the normalization contract; if production already matches it the
 * vector is executable with no differential, otherwise its current behavior is
 * pinned in differential.playa.currentBehavior. As of M1/M2 every later-era
 * catalog and delta matches, so none is pinned. `kind` distinguishes an
 * independent MSF-01 catalog from an MSF-01 op-array delta document.
 */
function importForwardLooking(
  fixture: string, corpusId: string, sha: string,
  kind: 'catalog-parse' | 'catalog-delta-parse', profile: string, era: string,
  section: string, basis: ExpectationBasis, buildExpect: (text: string) => ExpectBlock, description: string,
  /* Optional: an EXTERNAL implementation's divergence from the canonical expect,
   * keyed by impl name (e.g. "libmoq"). currentBehavior is that impl's exact
   * normalized projection; the differential lane matches it and requires
   * promotion if the impl later matches the canonical expect. */
  extraDifferential?: (text: string) => { impl: string; reason: string; currentBehavior: ExpectBlock },
): void {
  const corpusFile = `libmoq_${fixture}`;
  const { text, bytes } = importedFixtureBytes(corpusFile, fixture, sha);
  const actual = runCatalog(text);
  const expect = buildExpect(text);
  // Promotion: once production parses this later-era document to the authored
  // truth, the differential.playa record is DROPPED and the vector becomes
  // executable. Only genuinely-unimplemented documents (the MSF-01 op-array
  // deltas) keep the unimplemented+currentBehavior pin.
  const playaMatches = resultMatches(actual, expect);
  const reason = kind === 'catalog-delta-parse'
    ? 'unsupported-msf01-delta: Playa implements no MSF-01 op-array delta dialect (deltaUpdate:[{op,tracks}]). '
      + 'The intended result is a successful ordered-operation parse (expect); the observed invalid-version is a '
      + 'mis-routing artifact of the MSF-00 parser, recorded as currentBehavior. Pinned until the MSF-01 delta slice.'
    : `Playa has no ${profile} parser: the MSF-00→MSF-01 version Number→String flip is unimplemented, so this later-era `
      + `catalog is mis-routed to the MSF-00 parser and rejected. The complete normalized projection is the intended `
      + `result (expect); the invalid-version is currentBehavior. Pinned until the MSF-01/CMSF-01 slice.`;
  const differential: Record<string, { status: 'unimplemented' | 'diverges'; reason: string; currentBehavior: ExpectBlock }> = {};
  if (!playaMatches) {
    differential['playa'] = { status: 'unimplemented', reason, currentBehavior: resultToExpect(actual, 'semantic') };
  }
  // The libmoq pin (mediatimeline lowercase-mimetype alias) is INDEPENDENT of
  // Playa's status and always recorded when supplied.
  if (extraDifferential) {
    const d = extraDifferential(text);
    differential[d.impl] = { status: 'diverges', reason: d.reason, currentBehavior: d.currentBehavior };
  }
  addEntry('catalog', {
    id: corpusId, kind, profile, description,
    input: fileInput('catalog', corpusFile, bytes),
    expect,
    expectationBasis: basis, provenance: libmoqProv(section, sha),
    ...(Object.keys(differential).length > 0 ? { differential } : {}),
  });
  libmoqRows.push({ fixture, sha256: sha, corpusId, corpusFile, era, profile, capability: playaMatches ? 'executable' : 'forward-looking', basis, section });
}

function buildLibmoqImports(): void {
  const okCat = (tracks: unknown[], extra: Record<string, unknown> = {}): ExpectBlock =>
    ({ status: 'ok', stage: 'semantic', semantics: { catalogVersion: '1', ...extra, tracks } });
  const GEN_AT = '1746104606044';
  // Complete independently-derived MSF-01/CMSF-01 catalog projection.
  const catExpect = (t: string): ExpectBlock => ({ status: 'ok', stage: 'semantic', semantics: msf01Project(t) });
  // Successful ordered delta-operation projection (§5.3).
  const deltaExpect = (t: string): ExpectBlock => ({ status: 'ok', stage: 'semantic', semantics: msf01DeltaProject(t) });

  // ── 5 executable MSF-00/CMSF-00 (numeric version; Playa parses today) ──
  importExecutable('minimal.json', 'catalog/libmoq-minimal', 'a0bf6eed5a81038492c8ce612698abef5433847511a33f7a8c50005eccbcde06',
    'draft-ietf-moq-msf-00 §5.1', 'normative',
    okCat([{ name: 'video', packaging: 'loc', isLive: true }]),
    'LibMoQ MSF-00 minimal catalog (numeric version, single LOC track). Executable today.');
  importExecutable('empty_tracks.json', 'catalog/libmoq-empty-tracks', 'cc93a54da66ad17da51cbd26aea8a67084dd54b97e525eb1b562e3696a1d242a',
    'draft-ietf-moq-msf-00 §5.1.1', 'normative',
    okCat([]),
    'LibMoQ MSF-00 catalog with an empty tracks array (numeric version).');
  importExecutable('with_init_data.json', 'catalog/libmoq-with-init-data', '6c70626f51fe2fda457cdbabc0f3e77ef1edf22161d72027694c8f141975e197',
    'draft-ietf-moq-msf-00 §5.1.20', 'normative',
    okCat([{ name: 'video', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.42e01e', width: '1280', height: '720', initData: 'AAAB' }]),
    'LibMoQ MSF-00 LOC track carrying inline base64 initData (kept as a string, never decoded).');
  importExecutable('av_single.json', 'catalog/libmoq-av-single', 'f07dd4722601e05bed02b4021a45fdafaa5c423202128700ed5db92b3771a795',
    'draft-ietf-moq-msf-00 §5.1', 'normative',
    okCat(
      [
        { name: '1080p-video', packaging: 'loc', isLive: true, namespace: 'conference.example.com/conference123/alice', role: 'video', codec: 'av01.0.08M.10.0.110.09', renderGroup: '1', framerate: '30', bitrate: '1500000', width: '1920', height: '1080', targetLatency: '2000' },
        { name: 'audio', packaging: 'loc', isLive: true, namespace: 'conference.example.com/conference123/alice', role: 'audio', codec: 'opus', renderGroup: '1', bitrate: '32000', samplerate: '48000', channelConfig: '2', targetLatency: '2000' },
      ],
      { generatedAt: GEN_AT },
    ),
    'LibMoQ MSF-00 conferencing A/V catalog: two render-grouped LOC tracks with targetLatency, codecs, and dimensions.');
  // Regression: unknown-field tolerance is Playa's silent-drop behavior, not a
  // normative requirement — pin it as such rather than labeling it normative.
  importExecutable('unknown_fields.json', 'catalog/libmoq-unknown-fields', '4f3fc0bc4e0e1fbc3d3570d6e2e9981d3632f569b83ad169ab01d72dd740bc37',
    'draft-ietf-moq-msf-00 §5.1', 'regression',
    okCat([{ name: 'video', packaging: 'loc', isLive: true }]),
    'LibMoQ MSF-00 catalog with unknown root and track fields: the current parser silently drops them (regression pin).');

  // ── 4 MSF-01 catalogs (string version; promoted to executable in M1) ──
  // Each `expect` is the COMPLETE normalized projection (§5.1/§5.2), independently
  // derived from the draft — not core-identity only.
  importForwardLooking('vod.json', 'catalog/libmoq-vod', 'e377cfa4e892a3b597e34beec0313ba06b219ea7be40a73c0ec8ddc5a6d4404c',
    'catalog-parse', 'msf-01', 'msf-01', 'draft-ietf-moq-msf-01 §5.2.35', 'interpretation',
    catExpect,
    'LibMoQ MSF-01 VOD catalog (string version "1", isLive:false, trackDuration §5.2.35). Intended: accepted by an MSF-01 parser with the full normalized projection; current Playa: invalid-version (no MSF-01 parser).');
  importForwardLooking('termination.json', 'catalog/libmoq-termination', 'dfdc4e8e565225cb43973fdb648edc76644229f7184fc60a62be680c669998cf',
    'catalog-parse', 'msf-01', 'msf-01', 'draft-ietf-moq-msf-01 §5.1.3', 'interpretation',
    catExpect,
    'LibMoQ MSF-01 termination catalog (string version, isComplete:true §5.1.3, empty tracks). Intended: accepted; current Playa: invalid-version.');
  importForwardLooking('mediatimeline.json', 'catalog/libmoq-mediatimeline', 'b5da1dc96f6ffd59eeb79e8f961ea7f664148c65331315a4580dfe3cc0566633',
    'catalog-parse', 'msf-01', 'msf-01', 'draft-ietf-moq-msf-01 §5.2.14', 'interpretation',
    catExpect,
    'LibMoQ MSF-01 catalog with a mediatimeline track depending (§5.2.14) on LOC tracks. Interpretation: the fixture spells the field "mimetype" (spec is "mimeType" §5.2.19); the canonical interpretation treats it as unknown and drops it — the projected track carries no mimeType. LibMoQ diverges (see differential.libmoq): it accepts the lowercase alias. Current Playa: invalid-version.',
    // LibMoQ accepts the non-standard lowercase "mimetype" as an alias for the
    // mimeType field; the canonical interpretation recognizes only "mimeType" and
    // drops the misspelling. The differential lane pins LibMoQ's divergence: its
    // exact projection additionally carries mimeType on the mediatimeline track.
    (text) => {
      const canon = (catExpect(text).semantics) as { tracks: Array<Record<string, unknown>> };
      const cur = JSON.parse(JSON.stringify(canon)) as { tracks: Array<Record<string, unknown>> };
      const hist = cur.tracks.find((t) => t['name'] === 'history');
      if (!hist) throw new Error('mediatimeline: expected a track named "history"');
      hist['mimeType'] = 'application/json';
      return {
        impl: 'libmoq',
        reason: 'LibMoQ accepts the non-standard lowercase "mimetype" as an alias for mimeType (msf-01 §5.2.19); the canonical interpretation recognizes only "mimeType" and drops the misspelling.',
        currentBehavior: { status: 'ok', stage: 'semantic', semantics: cur },
      };
    });
  importForwardLooking('template.json', 'catalog/libmoq-template', '98d6cb8196bce7c7745434d5a5641427430ddc9c783ab47900a221bb25dd09f8',
    'catalog-parse', 'msf-01', 'msf-01', 'draft-ietf-moq-msf-01 §5.2.15', 'interpretation',
    catExpect,
    'LibMoQ MSF-01 catalog using the per-track template array (§5.2.15). Interpretation: the template is normalized element-wise with numbers as decimal strings (including the wide wallclock anchor), structure preserved. Current Playa: invalid-version.');

  // ── 3 CMSF-01 catalogs (string version + protection/init; executable in M1) ──
  importForwardLooking('cmsf_clearkey.json', 'catalog/libmoq-cmsf-clearkey', '74831a3b1b740ebd67ef7db1681397b8808b01d4a2deda6101850749205ea4ac',
    'catalog-parse', 'cmsf-01', 'cmsf-01', 'draft-ietf-moq-cmsf-01 §4.3', 'interpretation',
    catExpect,
    'LibMoQ CMSF-01 catalog with ClearKey contentProtections (§4.1.1/§4.3) + initDataList (§3.1)/initRef. The projection carries the root contentProtections and initDataList arrays plus the track initRef/contentProtectionRefIDs. Current Playa: invalid-version (no CMSF-01 parser).');
  importForwardLooking('cmsf_cmaf_simulcast.json', 'catalog/libmoq-cmsf-cmaf-simulcast', '9d53c32066d044915d5574a60bf8c8b735908d29a62e2a5f27391417533d1cc4',
    'catalog-parse', 'cmsf-01', 'cmsf-01', 'draft-ietf-moq-cmsf-01 §3.1', 'interpretation',
    catExpect,
    'LibMoQ CMSF-01 simulcast catalog (altGroup renditions + an eventtimeline SAP track with depends), per-rendition initDataList (§3.1). Complete projection incl. altGroup, codecs, dims, initRef, depends. Current Playa: invalid-version.');
  importForwardLooking('cmsf_drm_cbcs.json', 'catalog/libmoq-cmsf-drm-cbcs', '48b036709de7d7e4ae566c39435537bd658895de3e04803b60cacc7461110cc9',
    'catalog-parse', 'cmsf-01', 'cmsf-01', 'draft-ietf-moq-cmsf-01 §5.2', 'interpretation',
    catExpect,
    'LibMoQ CMSF-01 catalog with three cbcs DRM systems (Widevine/PlayReady/FairPlay) in contentProtections (§4.1.1/§5.2). Complete projection carries all three protection entries and the track contentProtectionRefIDs. Current Playa: invalid-version.');

  // ── 2 MSF-01 delta documents (op-array dialect; a distinct delta-parse kind) ──
  // VALID MSF-01 deltas (§5.3): the expect is the successful ordered
  // normalized-operation parse. Production parses the op-array dialect since the
  // M2 delta-parser slice, so these are executable.
  importForwardLooking('delta_add_clone.json', 'catalog/libmoq-delta-add-clone', '9b1f6fa8140fb426395bbc24ba179ce01970468e8433aeaa3d3cd6d5f1672f56',
    'catalog-delta-parse', 'msf-01-delta', 'msf-01-delta', 'draft-ietf-moq-msf-01 §§5.1.6,5.3,5.6.4', 'interpretation',
    deltaExpect,
    'LibMoQ MSF-01 delta document (§5.6.4): an ordered add + clone operation array (§5.1.6/§5.3) — a successful ordered normalized-operation parse (add then clone), document order preserved.');
  importForwardLooking('delta_remove.json', 'catalog/libmoq-delta-remove', '1cc3b8d80da318d071ae521bd7068b53c26aa91519afdfc1c1d2d32f1332a2c4',
    'catalog-delta-parse', 'msf-01-delta', 'msf-01-delta', 'draft-ietf-moq-msf-01 §§5.1.6,5.3,5.6.5', 'interpretation',
    deltaExpect,
    'LibMoQ MSF-01 delta document (§5.6.5): a single remove operation naming two tracks (§5.3) — a successful ordered normalized-operation parse.');
}

// ════════════════════════════════════════════════════════════════════
// MSF-01 / CMSF-01 spec-derived corpus
// ════════════════════════════════════════════════════════════════════
//
// Normative evidence authored INDEPENDENTLY from draft-ietf-moq-msf-01 and
// draft-ietf-moq-cmsf-01 (expects are hand-written literals, never generated
// from Playa's parser or the LibMoQ probe). These are minimal, spec-cited
// vectors that fill the gaps left by the third-party (interop) fixtures.
//
// SCOPE: `catalog-parse`/`catalog-delta-parse` validate the catalog LAYER —
// field presence/typing and reference topology (initRef→initDataList,
// contentProtectionRefIDs→contentProtections, delta op structure). Embedded
// base64 (init data, PSSH) is treated as OPAQUE: carried verbatim, never decoded
// or validated as a CMAF/PSSH structure. So "otherwise valid" throughout means
// "valid at the catalog layer"; a vector never claims its opaque bytes are a
// conforming media/DRM structure.
//
// CAPABILITY is RESULT-DRIVEN: each vector runs against production and its
// differential.playa is DROPPED (executable) when the live result matches the
// authored `expect`, otherwise the exact current behavior is pinned as
// differential.playa {status:"unimplemented"|"diverges"}. As of the M1 parser
// slice (string-version catalogs) and the M2 delta-parser slice (op-array
// deltas), production matches every vector here, so none is pinned — the
// mechanism remains so a future regression re-pins its vector automatically.

function buildSpecMsf01(): void {
  const okc = (tracks: unknown[], extra: Record<string, unknown> = {}, ver = '1'): ExpectBlock =>
    ({ status: 'ok', stage: 'semantic', semantics: { catalogVersion: ver, ...extra, tracks } });
  const errc = (category: ErrorCategory): ExpectBlock => ({ status: 'error', stage: 'semantic', error: { category } });
  const okd = (deltaUpdate: unknown[], extra: Record<string, unknown> = {}): ExpectBlock =>
    ({ status: 'ok', stage: 'semantic', semantics: { ...extra, deltaUpdate } });

  const REASON = 'Playa implements no MSF-01 op-array delta dialect (deltaUpdate:[{op,tracks}]); the '
    + 'string-version document is mis-routed to the MSF-00 parser and rejected with invalid-version before '
    + 'any MSF-01 semantic check. currentBehavior pins that until the MSF-01 delta slice.';
  const MSF00_REASON = 'current parseCatalogAuto behavior (MSF-00 path).';

  type Div = { status: 'unimplemented' | 'diverges' | 'forward-looking'; reason: string; currentBehavior?: ExpectBlock };
  const spec = (
    id: string, kind: 'catalog-parse' | 'catalog-delta-parse', profile: string,
    json: string, expect: ExpectBlock, basis: ExpectationBasis,
    source: string, section: string, file: string, description: string,
    // Optional EXTERNAL-impl divergence pinned alongside differential.playa (e.g.
    // "libmoq"). currentBehavior is that impl's exact projection; the lane matches
    // it and requires promotion if the impl later matches the canonical expect.
    extraDifferential?: { impl: string; reason: string; currentBehavior: ExpectBlock },
  ): void => {
    const bytes = new TextEncoder().encode(json);
    const actual = runCatalog(json);
    const matches = resultMatches(actual, expect);
    // Result-driven promotion: when production now parses the document to the
    // authored truth, the differential.playa record is DROPPED and the vector is
    // executable. Only documents production still cannot handle (the MSF-01
    // op-array deltas) keep a differential.playa with the exact current behavior.
    const differential: Record<string, Div> = {};
    if (!matches) {
      differential['playa'] = {
        status: profile === 'msf-00' ? 'diverges' : 'unimplemented',
        reason: profile === 'msf-00' ? MSF00_REASON : REASON,
        currentBehavior: resultToExpect(actual, 'semantic'),
      };
    }
    if (extraDifferential) differential[extraDifferential.impl] = { status: 'diverges', reason: extraDifferential.reason, currentBehavior: extraDifferential.currentBehavior };
    addEntry('catalog', {
      id, kind, profile, description,
      input: fileInput('catalog', file, bytes),
      expect,
      ...(Object.keys(differential).length ? { differential } : {}),
      expectationBasis: basis, provenance: specProv(source, section),
    });
  };
  const MSF = 'draft-ietf-moq-msf-01';
  const MSF0 = 'draft-ietf-moq-msf-00';
  const CMSF = 'draft-ietf-moq-cmsf-01';
  const OPAQUE = ' (init data / PSSH are OPAQUE base64 carried verbatim per spec, never decoded or validated — no conforming media structure is claimed).';

  // ── Version & detection ──────────────────────────────────────────
  spec('catalog/msf01-version-string-one', 'catalog-parse', 'msf-01',
    '{"version":"1","tracks":[{"name":"v","packaging":"loc","isLive":true}]}',
    okc([{ name: 'v', packaging: 'loc', isLive: true }]), 'interpretation', MSF, '5.1.1', 'msf01_version_one.json',
    'MSF-01 §5.1.1: version is the JSON String "1"; a compliant MSF-01 subscriber accepts it. Current Playa: invalid-version.');
  spec('catalog/msf01-version-draft', 'catalog-parse', 'msf-01',
    '{"version":"draft-01","tracks":[{"name":"v","packaging":"loc","isLive":true}]}',
    okc([{ name: 'v', packaging: 'loc', isLive: true }]), 'interpretation', MSF, '5.1.1', 'msf01_version_draft.json',
    'MSF-01 §5.1.1 draft convention: "draft-XX" names the -XX release; the canonical rule normalizes "draft-01" to catalogVersion "1" (matching the typed model). Current Playa: invalid-version.');
  // Versions unsupported by Playa's MSF-01 profile. §5.1.1 says a subscriber MUST
  // NOT parse a version it does not UNDERSTAND — it does not universally
  // invalidate draft-00/-02/-99; that is implementation-relative. Playa's profile
  // understands only "1"/numeric-1/"draft-01", so every OTHER draft spelling is
  // rejected here as an INTERPRETATION (profile policy), not a normative verdict —
  // and draft-N is NOT decoded to version N. Each rejects with invalid-version;
  // Playa returns the SAME category by accident (it rejects all string versions),
  // so these stay forward-looking with NO currentBehavior.
  for (const [tag, ver] of [['draft-99', 'draft-99'], ['draft-1', 'draft-1'], ['draft-00', 'draft-00'], ['draft-02', 'draft-02'], ['draft-abc', 'draft-abc']] as const) {
    spec(`catalog/msf01-version-${tag}`, 'catalog-parse', 'msf-01',
      `{"version":"${ver}","tracks":[]}`,
      errc('invalid-version'), 'interpretation', MSF, '5.1.1', `msf01_version_${tag.replace('-', '_')}.json`,
      `Playa MSF-01 profile policy (interpretation of §5.1.1 "MUST NOT parse a version it does not understand"): "${ver}" is not among the versions this profile understands ("1"/"draft-01"), so it is rejected — the draft suffix is a draft revision, never decoded to a numeric version. Playa returns the same invalid-version category by ACCIDENT (it rejects all string versions), not by MSF-01 support — forward-looking with no currentBehavior.`);
  }
  spec('catalog/msf00-numeric-unchanged', 'catalog-parse', 'msf-00',
    '{"version":1,"tracks":[{"name":"v","packaging":"loc","isLive":true}]}',
    okc([{ name: 'v', packaging: 'loc', isLive: true }]), 'normative', MSF0, '5.1.1', 'msf00_numeric_unchanged.json',
    'Detection boundary: a NUMERIC version selects legacy MSF-00 (draft-ietf-moq-msf-00 §5.1.1) and parses unchanged today (executable). Contrast the identical-shape string-version vector above.');

  // ── MSF-01 semantics ─────────────────────────────────────────────
  spec('catalog/msf01-vod-trackduration', 'catalog-parse', 'msf-01',
    '{"version":"1","tracks":[{"name":"m","packaging":"loc","isLive":false,"trackDuration":8072340}]}',
    okc([{ name: 'm', packaging: 'loc', isLive: false, trackDuration: '8072340' }]), 'interpretation', MSF, '5.2.35', 'msf01_vod_trackduration.json',
    'MSF-01 §5.2.35: trackDuration (integer ms) on a VOD (isLive:false) loc track. Current Playa: invalid-version.');
  spec('catalog/msf01-depends', 'catalog-parse', 'msf-01',
    '{"version":"1","tracks":[{"name":"a","packaging":"loc","isLive":true},{"name":"b","packaging":"loc","isLive":true},{"name":"t","packaging":"mediatimeline","isLive":true,"mimeType":"application/json","depends":["a","b"]}]}',
    okc([
      { name: 'a', packaging: 'loc', isLive: true },
      { name: 'b', packaging: 'loc', isLive: true },
      { name: 't', packaging: 'mediatimeline', isLive: true, mimeType: 'application/json', depends: ['a', 'b'] },
    ]), 'interpretation', MSF, '5.2.14', 'msf01_depends.json',
    'MSF-01 §5.2.14: depends is an array of track names the track applies to. Self-contained and valid: the mediatimeline track carries mimeType "application/json" (§7.2) and depends on the two loc tracks that exist in this catalog. Current Playa: invalid-version.');
  spec('catalog/msf01-template-wide', 'catalog-parse', 'msf-01',
    '{"version":"1","tracks":[{"name":"v","packaging":"loc","isLive":true,"template":[0,2002,[0,0],[1,0],1759924158381,2002]}]}',
    okc([{ name: 'v', packaging: 'loc', isLive: true, template: ['0', '2002', ['0', '0'], ['1', '0'], '1759924158381', '2002'] }]), 'interpretation', MSF, '5.2.15', 'msf01_template_wide.json',
    'MSF-01 §5.2.15: the template 6-tuple, with the wide wallclock anchor (1759924158381) preserved as a decimal string. Current Playa: invalid-version.');
  spec('catalog/msf01-initdata-initref', 'catalog-parse', 'msf-01',
    '{"version":"1","tracks":[{"name":"v","packaging":"loc","isLive":true,"initRef":"i1"}],"initDataList":[{"id":"i1","type":"inline","data":"AAAB"}]}',
    okc([{ name: 'v', packaging: 'loc', isLive: true, initRef: 'i1' }], { initDataList: [{ id: 'i1', type: 'inline', data: 'AAAB' }] }), 'interpretation', MSF, '5.1.7', 'msf01_initdata_initref.json',
    'MSF-01 §5.1.7/§5.2.13: a root initDataList entry with a loc track whose initRef resolves to it.' + OPAQUE + ' Current Playa: invalid-version.');
  spec('catalog/msf01-dangling-initref', 'catalog-parse', 'msf-01',
    '{"version":"1","tracks":[{"name":"v","packaging":"loc","isLive":true,"initRef":"missing"}],"initDataList":[{"id":"i1","type":"inline","data":"AAAB"}]}',
    errc('dangling-init-ref'), 'interpretation', MSF, '5.2.13', 'msf01_dangling_initref.json',
    'MSF-01 §5.2.13: initRef points at an initDataList id. Interpretation (§5.2.13 states no explicit MUST-reject): a dangling reference is treated as an error; the catalog is otherwise valid at the catalog layer. Current Playa: invalid-version (wrong reason — never reaches the check).');
  spec('catalog/msf01-duplicate-initid', 'catalog-parse', 'msf-01',
    '{"version":"1","tracks":[{"name":"v","packaging":"loc","isLive":true,"initRef":"i1"}],"initDataList":[{"id":"i1","type":"inline","data":"AAAB"},{"id":"i1","type":"inline","data":"AAAC"}]}',
    errc('duplicate-init-ref'), 'interpretation', MSF, '5.1.7', 'msf01_duplicate_initid.json',
    'MSF-01 §5.1.7: an initDataList id is "unique within the scope of the catalog". Interpretation: a duplicate id is treated as an error; the track and its initRef are otherwise valid at the catalog layer. Current Playa: invalid-version (wrong reason).');
  spec('catalog/msf01-unknown-fields', 'catalog-parse', 'msf-01',
    '{"version":"1","futureRoot":42,"tracks":[{"name":"v","packaging":"loc","isLive":true,"futureField":"x"}]}',
    okc([{ name: 'v', packaging: 'loc', isLive: true }]), 'interpretation', MSF, '5.2', 'msf01_unknown_fields.json',
    'MSF-01 forward-compat: unrecognized root/track fields are dropped, not surfaced. Current Playa: invalid-version.');
  spec('catalog/msf01-mimetype-canonical', 'catalog-parse', 'msf-01',
    '{"version":"1","tracks":[{"name":"v","packaging":"loc","isLive":true,"mimeType":"video/mp4","mimetype":"application/json"}]}',
    okc([{ name: 'v', packaging: 'loc', isLive: true, mimeType: 'video/mp4' }]), 'interpretation', MSF, '5.2.19', 'msf01_mimetype_canonical.json',
    'MSF-01 §5.2.19: the canonical key is "mimeType"; the lowercase "mimetype" misspelling is UNKNOWN and dropped. LibMoQ diverges (differential.libmoq): it accepts the lowercase alias, so the trailing "mimetype" value wins (mimeType="application/json"). Current Playa: invalid-version.',
    {
      impl: 'libmoq',
      reason: 'LibMoQ accepts the non-standard lowercase "mimetype" as an alias for mimeType (msf-01 §5.2.19); with both keys present the later "mimetype" value wins, so the projected track carries mimeType "application/json" instead of the canonical "video/mp4".',
      currentBehavior: { status: 'ok', stage: 'semantic', semantics: { catalogVersion: '1', tracks: [{ name: 'v', packaging: 'loc', isLive: true, mimeType: 'application/json' }] } },
    });

  // ── CMSF-01 semantics ────────────────────────────────────────────
  spec('catalog/cmsf01-clear-cmaf', 'catalog-parse', 'cmsf-01',
    '{"version":"1","tracks":[{"name":"v","packaging":"cmaf","isLive":true,"codec":"avc1.640028","initRef":"i1"}],"initDataList":[{"id":"i1","type":"inline","data":"AAAB"}]}',
    okc([{ name: 'v', packaging: 'cmaf', isLive: true, codec: 'avc1.640028', initRef: 'i1' }], { initDataList: [{ id: 'i1', type: 'inline', data: 'AAAB' }] }), 'interpretation', CMSF, '3.1', 'cmsf01_clear_cmaf.json',
    'CMSF-01 §3.1: a clear (unprotected) CMAF catalog; the CMAF track carries an initRef resolving to its initDataList header.' + OPAQUE + ' Current Playa: invalid-version.');
  spec('catalog/cmsf01-simulcast-altgroup', 'catalog-parse', 'cmsf-01',
    '{"version":"1","tracks":[{"name":"hd","packaging":"cmaf","isLive":true,"altGroup":1,"initRef":"i1"},{"name":"sd","packaging":"cmaf","isLive":true,"altGroup":1,"initRef":"i2"}],"initDataList":[{"id":"i1","type":"inline","data":"AAAB"},{"id":"i2","type":"inline","data":"AAAC"}]}',
    okc([
      { name: 'hd', packaging: 'cmaf', isLive: true, altGroup: '1', initRef: 'i1' },
      { name: 'sd', packaging: 'cmaf', isLive: true, altGroup: '1', initRef: 'i2' },
    ], { initDataList: [{ id: 'i1', type: 'inline', data: 'AAAB' }, { id: 'i2', type: 'inline', data: 'AAAC' }] }), 'interpretation', CMSF, '3.2', 'cmsf01_simulcast_altgroup.json',
    'CMSF-01 §3.2 (switching sets): two alternate renditions sharing altGroup 1, each with its own CMAF initRef.' + OPAQUE + ' Current Playa: invalid-version.');
  spec('catalog/cmsf01-sap-eventtimeline', 'catalog-parse', 'cmsf-01',
    '{"version":"1","tracks":[{"name":"v","packaging":"cmaf","isLive":true,"initRef":"i1"},{"name":"sap","packaging":"eventtimeline","isLive":true,"eventType":"org.ietf.moq.cmsf.sap","mimeType":"application/json","depends":["v"]}],"initDataList":[{"id":"i1","type":"inline","data":"AAAB"}]}',
    okc([
      { name: 'v', packaging: 'cmaf', isLive: true, initRef: 'i1' },
      { name: 'sap', packaging: 'eventtimeline', isLive: true, eventType: 'org.ietf.moq.cmsf.sap', mimeType: 'application/json', depends: ['v'] },
    ], { initDataList: [{ id: 'i1', type: 'inline', data: 'AAAB' }] }), 'interpretation', CMSF, '3.6.1', 'cmsf01_sap_eventtimeline.json',
    'CMSF-01 §3.6.1 (SAP-type timeline): an eventtimeline track carrying the inherited MSF §8.2 requirements (eventType, mimeType "application/json", depends); the referenced CMAF track has a valid initRef.' + OPAQUE + ' Current Playa: invalid-version.');
  spec('catalog/cmsf01-content-protection', 'catalog-parse', 'cmsf-01',
    '{"version":"1","tracks":[{"name":"v","packaging":"cmaf","isLive":true,"initRef":"i1","contentProtectionRefIDs":["1"]}],"contentProtections":[{"refID":"1","defaultKID":["01234567-89ab-cdef-0123-456789abcdef"],"scheme":"cbcs","drmSystem":{"systemID":"edef8ba9-79d6-4ace-a3c8-27dcd51d21ed","laURL":{"url":"https://la.example/x"},"pssh":"AAAB"}}],"initDataList":[{"id":"i1","type":"inline","data":"AAAB"}]}',
    okc([{ name: 'v', packaging: 'cmaf', isLive: true, initRef: 'i1', contentProtectionRefIDs: ['1'] }], {
      contentProtections: [{ refID: '1', defaultKID: ['01234567-89ab-cdef-0123-456789abcdef'], scheme: 'cbcs', drmSystem: { systemID: 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', laURL: { url: 'https://la.example/x' }, pssh: 'AAAB' } }],
      initDataList: [{ id: 'i1', type: 'inline', data: 'AAAB' }],
    }), 'interpretation', CMSF, '4.1.1', 'cmsf01_content_protection.json',
    'CMSF-01 §4.1.1/§4.1.2: content-protection METADATA (refID, defaultKID, scheme, drmSystem) is parsed and preserved as opaque metadata only — NO protected-playback support is claimed.' + OPAQUE + ' Current Playa: invalid-version.');
  spec('catalog/cmsf01-dangling-protectionref', 'catalog-parse', 'cmsf-01',
    '{"version":"1","tracks":[{"name":"v","packaging":"cmaf","isLive":true,"initRef":"i1","contentProtectionRefIDs":["missing"]}],"contentProtections":[{"refID":"1","defaultKID":["01234567-89ab-cdef-0123-456789abcdef"],"scheme":"cbcs","drmSystem":{"systemID":"edef8ba9-79d6-4ace-a3c8-27dcd51d21ed","laURL":{"url":"https://la.example/x"}}}],"initDataList":[{"id":"i1","type":"inline","data":"AAAB"}]}',
    errc('dangling-protection-ref'), 'interpretation', CMSF, '4.1.2', 'cmsf01_dangling_protectionref.json',
    'CMSF-01 §4.1.2: contentProtectionRefIDs reference a contentProtections refID. Interpretation: a dangling reference is treated as an error; the catalog is otherwise valid at the catalog layer (valid initRef, one well-formed protection entry). Current Playa: invalid-version (wrong reason).');
  spec('catalog/cmsf01-duplicate-protectionref', 'catalog-parse', 'cmsf-01',
    '{"version":"1","tracks":[{"name":"v","packaging":"cmaf","isLive":true,"initRef":"i1","contentProtectionRefIDs":["1"]}],"contentProtections":[{"refID":"1","defaultKID":["01234567-89ab-cdef-0123-456789abcdef"],"scheme":"cbcs","drmSystem":{"systemID":"edef8ba9-79d6-4ace-a3c8-27dcd51d21ed","laURL":{"url":"https://la.example/x"}}},{"refID":"1","defaultKID":["01234567-89ab-cdef-0123-456789abcdef"],"scheme":"cenc","drmSystem":{"systemID":"1077efec-c0b2-4d02-ace3-3c1e52e2fb4b","laURL":{"url":"https://la.example/y"}}}],"initDataList":[{"id":"i1","type":"inline","data":"AAAB"}]}',
    errc('duplicate-protection-ref'), 'interpretation', CMSF, '4.1.1.1', 'cmsf01_duplicate_protectionref.json',
    'CMSF-01 §4.1.1.1: a content-protection refID is "a unique identifier". Interpretation: a duplicate refID is treated as an error; the track/initRef are otherwise valid at the catalog layer. Current Playa: invalid-version (wrong reason).');

  // ── MSF-01 deltas ────────────────────────────────────────────────
  spec('catalog/msf01-delta-add-clone', 'catalog-delta-parse', 'msf-01-delta',
    '{"deltaUpdate":[{"op":"add","tracks":[{"name":"a","packaging":"loc","isLive":true}]},{"op":"clone","tracks":[{"parentName":"a","name":"b"}]}]}',
    okd([{ op: 'add', tracks: [{ name: 'a', packaging: 'loc', isLive: true }] }, { op: 'clone', tracks: [{ name: 'b', parentName: 'a' }] }]), 'interpretation', MSF, '5.3', 'msf01_delta_add_clone.json',
    'MSF-01 §5.1.6/§5.3: an ordered add→clone delta (the clone parent "a" is declared by the preceding add). Operations apply in document order, which production preserves.');
  spec('catalog/msf01-delta-remove', 'catalog-delta-parse', 'msf-01-delta',
    '{"deltaUpdate":[{"op":"remove","tracks":[{"name":"x"}]}]}',
    okd([{ op: 'remove', tracks: [{ name: 'x' }] }]), 'interpretation', MSF, '5.1.6', 'msf01_delta_remove.json',
    'MSF-01 §5.1.6: a remove operation (track objects carry only name[,namespace]). Parsed as an ordered single-operation delta.');
  spec('catalog/msf01-delta-unknown-op', 'catalog-delta-parse', 'msf-01-delta',
    '{"deltaUpdate":[{"op":"replace","tracks":[{"name":"a"}]}]}',
    errc('unknown-delta-op'), 'interpretation', MSF, '5.3', 'msf01_delta_unknown_op.json',
    'MSF-01 §5.3: a restricted set of operations (add/remove/clone) is allowed. Interpretation: an unknown op ("replace") is rejected as unknown-delta-op.');
  spec('catalog/msf01-delta-illegal-field', 'catalog-delta-parse', 'msf-01-delta',
    '{"deltaUpdate":[{"op":"remove","tracks":[{"name":"x"}]}],"version":"1"}',
    errc('illegal-delta-field'), 'normative', MSF, '5.3', 'msf01_delta_illegal_field.json',
    'MSF-01 §5.3: a delta MUST NOT contain an MSF version (or Tracks) field; a delta carrying "version" is rejected as illegal-delta-field.');
}

/** Stage the pinned provenance table (JSON authority + human MD) into `dir`. */
function stageLibmoqProvenance(dir: string): void {
  const rows = [...libmoqRows].sort((a, b) => a.corpusId.localeCompare(b.corpusId));
  mkdirSync(dir, { recursive: true });

  const doc = {
    corpusSchema: 'moq-media-corpus/1',
    note: 'Pinned provenance for the byte-exact LibMoQ MSF fixture import. Machine-checked by corpus-libmoq-import.test.ts. The source audit disproved the planned "13 executable + 1 MSF-01-shaped" split (landing at 5 executable + 9 forward-looking); the MSF-01/CMSF-01 parser then promoted the 7 later-era catalogs, and the op-array delta parser promoted the final 2 delta documents — all 14 fixtures are now executable.',
    source: { repo: LIBMOQ_REPO, commit: LIBMOQ_COMMIT, path: LIBMOQ_FIXTURE_DIR },
    counts: {
      total: rows.length,
      executable: rows.filter((r) => r.capability === 'executable').length,
      forwardLooking: rows.filter((r) => r.capability === 'forward-looking').length,
      byProfile: rows.reduce<Record<string, number>>((m, r) => { m[r.profile] = (m[r.profile] ?? 0) + 1; return m; }, {}),
    },
    fixtures: rows,
  };
  writeFileSync(join(dir, 'libmoq-msf-fixtures.json'), JSON.stringify(doc, null, 2) + '\n');

  const md = [
    '# LibMoQ MSF fixture import — pinned provenance',
    '',
    `**Source:** \`${LIBMOQ_REPO}\` @ \`${LIBMOQ_COMMIT}\` — path \`${LIBMOQ_FIXTURE_DIR}\``,
    '',
    'The planned **13 executable + 1 MSF-01-shaped** split was **disproved** by the source audit (5 + 9); the',
    'MSF-01/CMSF-01 parser promoted the later-era catalogs and the op-array delta parser',
    `promoted the delta documents. All 14 fixtures now **resolve to ${doc.counts.executable} executable /`,
    `${doc.counts.forwardLooking} forward-looking** (5 numeric MSF-00/CMSF-00 + 7 MSF-01/CMSF-01 catalogs + 2 MSF-01 op-array deltas).`,
    ' Byte-exact profile identities are preserved: '
      + `${doc.counts.byProfile['msf-01'] ?? 0} MSF-01 catalogs, ${doc.counts.byProfile['cmsf-01'] ?? 0} CMSF-01 catalogs, ${doc.counts.byProfile['msf-01-delta'] ?? 0} MSF-01 delta documents.`,
    '',
    'This file is generated by `AUTHOR_CORPUS=1 build-corpus.ts`; the JSON sibling is the machine-checked authority.',
    '',
    '| # | LibMoQ fixture | SHA-256 | Corpus ID | Corpus file | Era/profile | Capability | Basis |',
    '|--:|---|---|---|---|---|---|---|',
    ...rows.map((r, i) => `| ${i + 1} | \`${r.fixture}\` | \`${r.sha256.slice(0, 12)}…\` | \`${r.corpusId}\` | \`${r.corpusFile}\` | ${r.profile} | ${r.capability} | ${r.basis} |`),
    '',
  ].join('\n');
  writeFileSync(join(dir, 'LIBMOQ-MSF-FIXTURES.md'), md);
}

// ─── write everything ───────────────────────────────────────────────

function main(): void {
  if (process.env['AUTHOR_CORPUS'] !== '1') throw new Error('build-corpus is the manual authoring tool; run with AUTHOR_CORPUS=1');
  buildProperties();
  buildLocSemantics();
  buildLocProperties();
  buildCatalog();
  buildLibmoqImports();
  buildSpecMsf01();
  buildBmff();

  // Build every manifest in memory and VALIDATE before touching disk — a
  // validation failure must never leave the canonical corpus deleted or partial.
  const counts: Record<string, number> = {};
  const manifests = new Map<string, DomainManifest>();
  for (const [domain, vectors] of domains) {
    const manifest: DomainManifest = {
      corpusSchema: 'moq-media-corpus/1', domain,
      note: 'Read-only. Authored via AUTHOR_CORPUS=1 build-corpus.ts. Normative/interpretation expectations are independently authored; observed Playa output lives only in differential.playa. Regression expectations pin current behavior.',
      vectors,
    };
    const problems = [...jsonSchemaValidate(manifest).map((s) => `[schema] ${s}`), ...validateManifest(manifest, `${domain}/manifest.json`)];
    if (problems.length > 0) throw new Error(`authoring produced an invalid ${domain} manifest:\n  - ${problems.join('\n  - ')}`);
    manifests.set(domain, manifest);
    counts[domain] = vectors.length;
  }

  // Everything is valid — STAGE the complete result (vectors + top-level index
  // + pinned provenance) in temp trees, then perform ONE backup-and-swap
  // transaction so a failure at any point rolls back ALL three together rather
  // than leaving the corpus deleted/partial or the provenance stale/mismatched.
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const index = { corpusSchema: 'moq-media-corpus/1', domains: Object.fromEntries([...domains.keys()].sort().map((d) => [d, counts[d]])), totalVectors: total };
  const idxPath = join(VECTORS, '..', 'MANIFEST.json');
  const provPath = join(VECTORS, '..', 'provenance');
  const tmp = VECTORS + '.tmp';
  const bak = VECTORS + '.bak';
  const idxTmp = idxPath + '.tmp';
  const idxBak = idxPath + '.bak';
  const provTmp = provPath + '.tmp';
  const provBak = provPath + '.bak';

  // Stage the complete result (non-destructive).
  rmSync(tmp, { recursive: true, force: true });
  rmSync(provTmp, { recursive: true, force: true });
  for (const fw of files) {
    const dir = join(tmp, fw.domain);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fw.file), fw.bytes);
  }
  for (const [domain, manifest] of manifests) {
    const dir = join(tmp, domain);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
  writeFileSync(idxTmp, JSON.stringify(index, null, 2) + '\n');
  // Provenance is staged into its own temp tree and swapped in the SAME
  // transaction as the vectors and index.
  stageLibmoqProvenance(provTmp);

  // Commit transactionally: every mutation has a reverse-order rollback.
  commitCorpus(
    {
      vectors: VECTORS, index: idxPath, provenance: provPath,
      vectorsTmp: tmp, indexTmp: idxTmp, provenanceTmp: provTmp,
      vectorsBak: bak, indexBak: idxBak, provenanceBak: provBak,
    },
    {
      rename: (from, to) => renameSync(from, to),
      rm: (p) => rmSync(p, { recursive: true, force: true }),
      exists: (p) => existsSync(p),
    },
  );

  // eslint-disable-next-line no-console
  console.log(`Authored ${total} vectors:`, counts);
}

main();
