/**
 * Types + enumerations for the `moq-media-corpus/1` manifest schema.
 *
 * These TypeScript types are the authoritative in-repo contract; the JSON
 * Schema files under `conformance/media/schema/` mirror them for external
 * review and are checked against these by a test. {@link validateEntry} is the
 * runtime authority (the CI "corpus schema validation" gate).
 *
 * @module
 */

export const CORPUS_SCHEMA = 'moq-media-corpus/1' as const;

export const VECTOR_KINDS = [
  'property-block-decode',
  'loc-semantics',
  'loc-properties',
  'catalog-parse',
  'catalog-delta-parse',
  'bmff-structure',
  'msfts-validate',
] as const;
export type VectorKind = (typeof VECTOR_KINDS)[number];

export const WIRE_PROFILES = ['d14-absolute-varint', 'd16-delta-varint', 'd18-delta-vi64'] as const;
export type WireProfile = (typeof WIRE_PROFILES)[number];

export const STAGES = ['decode', 'encode', 'semantic'] as const;
export type Stage = (typeof STAGES)[number];

export const STATUSES = ['ok', 'error'] as const;
export type Status = (typeof STATUSES)[number];

export const PROVENANCE_CLASSES = ['spec-derived', 'third-party', 'implementation-generated'] as const;
export type ProvenanceClass = (typeof PROVENANCE_CLASSES)[number];

export const EXPECTATION_BASES = ['normative', 'interpretation', 'interop', 'regression'] as const;
export type ExpectationBasis = (typeof EXPECTATION_BASES)[number];

export const DIFFERENTIAL_STATUSES = ['pass', 'diverges', 'unimplemented', 'forward-looking'] as const;
export type DifferentialStatus = (typeof DIFFERENTIAL_STATUSES)[number];

/**
 * Error taxonomy — comparisons use these CATEGORIES, never human-readable
 * message strings (which vary per implementation). Each implementation maps its
 * internal error types onto one of these in its harness shim.
 */
export const ERROR_CATEGORIES = [
  'malformed-varint',
  'truncated',
  'length-overrun',
  'delta-overflow',
  'value-out-of-range',
  'odd-value-too-long',
  'parity-mismatch',
  'invalid-version',
  'invalid-timescale-zero',
  'dangling-init-ref',
  'dangling-protection-ref',
  'missing-required-field',
  'invalid-packet-size',
  'payload-size-not-multiple',
  'sync-byte-invalid',
  'box-overrun',
  'missing-mdat',
  'timestamp-unsafe-number',
  'mixed-clock-domain',
  'unsupported-profile',
  'unsupported-delta',
  'malformed-json',
  // MSF-01 / CMSF-01 reference + delta integrity.
  'duplicate-init-ref',
  'duplicate-protection-ref',
  'unknown-delta-op',
  'illegal-delta-field',
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export interface Provenance {
  readonly class: ProvenanceClass;
  readonly source: string;
  readonly section: string;
  readonly generator: string;
  readonly generatorVersion: string;
  readonly command: string;
  readonly sourceHash: string;
}

/** A structured PropertyMap entry as it appears inline in corpus JSON. */
export interface PropertyMapEntryJson {
  readonly id: string; // decimal-string u64
  readonly value: string; // decimal-string u64 (even id) OR lowercase hex bytes (odd id)
  readonly valueKind: 'varint' | 'bytes';
}

export interface ExpectBlock {
  readonly status: Status;
  readonly stage: Stage;
  readonly semantics?: unknown; // projection object (decode/semantic direction)
  readonly bytesHex?: string; // canonical minimal bytes (encode direction)
  readonly canonicalHex?: string; // re-encode target for a non-minimal decode vector
  readonly error?: { readonly category: ErrorCategory; readonly note?: string };
  readonly diagnostics?: readonly string[]; // sorted; exact-match
}

export interface DifferentialEntry {
  readonly status: DifferentialStatus;
  readonly reason?: string;
  readonly currentBehavior?: ExpectBlock; // mandatory for diverges/unimplemented
}

/** Byte-file input (`*.bin`) or reviewable catalog input (`*.json`). */
export interface FileInput {
  readonly file: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly hex?: string; // mandatory for *.bin ≤ 512 bytes
}

/** Inline structured PropertyMap input (encode-direction / loc-semantics). */
export interface PropertyMapInput {
  readonly propertyMap: readonly PropertyMapEntryJson[];
}

export type EntryInput = FileInput | PropertyMapInput;

export const BMFF_OPERATIONS = ['trex', 'peek', 'timeRanges'] as const;
export type BmffOperation = (typeof BMFF_OPERATIONS)[number];

/** An active (executable/pending) vector — never carries `retired`. */
export interface ActiveCorpusEntry {
  readonly id: string;
  readonly kind: VectorKind;
  readonly profile: string;
  readonly wireProfile?: WireProfile;
  readonly scope?: 'track' | 'object';
  /**
   * The production operation under test — part of the INPUT contract, never
   * derived from the expected output (so a mistaken expectation cannot silently
   * change which function runs). Required for `bmff-structure`.
   */
  readonly operation?: BmffOperation;
  readonly description: string;
  readonly input: EntryInput;
  readonly expect: ExpectBlock;
  readonly expectationBasis: ExpectationBasis;
  readonly provenance: Provenance;
  readonly differential?: Readonly<Record<string, DifferentialEntry>>;
  readonly retired?: undefined;
}

/** A retired vector, kept for a diffable history. Inert: id is reserved, never reused. */
export interface TombstoneEntry {
  readonly id: string;
  readonly retired: { readonly reason: string };
}

/** A manifest entry is either an active vector or a tombstone. */
export type ManifestEntry = ActiveCorpusEntry | TombstoneEntry;

/** Back-compat alias — an active corpus entry. */
export type CorpusEntry = ActiveCorpusEntry;

export interface DomainManifest {
  readonly corpusSchema: typeof CORPUS_SCHEMA;
  readonly domain: string;
  readonly note?: string;
  readonly vectors: readonly ManifestEntry[];
}

export function isFileInput(input: EntryInput): input is FileInput {
  return typeof (input as FileInput).file === 'string';
}
export function isPropertyMapInput(input: EntryInput): input is PropertyMapInput {
  return Array.isArray((input as PropertyMapInput).propertyMap);
}
/** Type predicate: narrow a manifest entry to a tombstone. */
export function isTombstone(entry: ManifestEntry): entry is TombstoneEntry {
  return (entry as TombstoneEntry).retired !== undefined;
}
