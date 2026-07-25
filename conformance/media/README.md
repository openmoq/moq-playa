# Media Conformance Corpus (`moq-media-corpus/1`)

A language-neutral corpus of media-format conformance vectors — LOC property
blocks, LOC semantics, catalogs, BMFF structures — consumed by two
implementations: this repository (TypeScript, via `runner/`) and an external
LibMoQ (C) build, reached only through the `moq-media-probe/1` JSONL protocol —
neither repository vendors the other. This is **private test infrastructure**:
it lives outside `packages/` and is never published to npm.

Every vector is schema-validated, and a vector is executed only against a seam
that actually exists. A vector kind whose runner API does not exist yet is
capability-marked rather than silently skipped — counted and reported, never run
against a non-existent API. Nothing is marked pending today.

## Layout

```
conformance/media/
  README.md            # this file — governance
  MANIFEST.json        # derived index (schema + per-domain counts + total)
  schema/              # JSON Schema for the manifest + scenario formats
  vectors/
    properties/        # Layer-A property-block-decode (executable)
    loc/               # loc-properties (A+B) + loc-semantics (both executable)
    catalog/           # catalog-parse (executable via parseCatalogAuto)
    bmff/              # bmff-structure (executable via mp4-box utilities)
  runner/              # private TS workspace package: loader, validator, tests
```

## Governance

### Provenance (where the bytes came from)

Every entry carries a mandatory `provenance` block with a `class`:

- **`spec-derived`** — bytes hand-constructed to match a cited draft section
  (e.g. a canonical vi64 encoding). The only class that is *conformance*
  evidence, and only after independent review against the citation.
- **`third-party`** — output of an external tool (ffmpeg, GPAC, moq-rs). Interop
  evidence.
- **`implementation-generated`** — output of Playa or LibMoQ. *Regression pins
  only*, never conformance evidence.

Provenance says where the bytes came from; `expectationBasis` (below) says what
the expectation *claims*. A spec-derived vector can still be an `interpretation`.

### `expectationBasis` (what the expectation claims)

- **`normative`** — a MUST / registry entry with a precise citation.
- **`interpretation`** — a documented Playa policy where the spec is ambiguous,
  silent, or its registry is incomplete (see policies below).
- **`interop`** — matches observed third-party behavior.
- **`regression`** — pins current behavior with no spec claim (e.g. the silent
  audio-level masking and duplicate last-wins the current parser exhibits).

### Oracle independence (the load-bearing rule)

For a `normative` or `interpretation` vector, the `expect` block is an
**independently authored literal** — reasoned from the cited draft, never
captured from the implementation under test. The authoring script then runs
Playa *only* to populate `differential.playa`: absent (⇒ Playa matches the
authored truth) or `diverges` + `currentBehavior` (⇒ it does not). This prevents
an existing bug from being blessed as the normative answer. A `regression`
vector is the sole exception — its `expect` legitimately IS the current
implementation behavior, because that is what a regression pin means.

The eighteen draft-18 divergence drivers (`loc/props-d18-*-diverges`) are the
concrete payoff — every draft-18 value ≥ 64 in both directions (9 decode + 9
encode). They drove the vi64 wiring fix: the `-diverges` id suffix records that
origin, and they now pass against production directly (no differential).

### Canonical ordering / duplicate policy

- **PropertyMap decode** preserves occurrence order and duplicates losslessly
  (dedup / last-wins is a Layer-B *semantic* policy, never a Layer-A behavior).
- **Canonical encode** emits Key-Value-Pairs in **stable ascending-ID order**,
  preserving the relative order of duplicate IDs — matching the current
  encoders. (draft-18 §1.4.3.)
- Trace event order is the **actual emission order** (never re-sorted); JSON key
  order within a record is cosmetic (structural comparison).

### Documented policies (all `interpretation`)

These are exercised by their vectors once the corresponding format support
lands; recorded now so the corpus and its consumers share one reading. Each also becomes an upstream
issue (to be filed).

- **LOC02-P1** — LOC-02 id `0x06` is interpreted as TIMESTAMP per the IANA table
  (§6.1), which registers only TIMESTAMP; the §2.3.3.1 Audio Level prose
  assignment (also `0x06`) is treated as an erratum. No value-magnitude
  heuristics; Audio Level is unavailable in LOC-02; a session-scoped diagnostic
  is emitted; the raw id/value is always preserved.
- **LOC02-P1b** — LOC-02 ids `0x04` (Video Frame Marking) and `0x0D` (Video
  Config) are accepted per their unambiguous prose assignments even though the
  §6.1 registry omits them (the registry resolves conflicts; it does not
  invalidate unambiguous definitions). One session-scoped diagnostic lists the
  prose-only properties accepted.
- **LOC02-P3** — running LOC-02 semantics over transport-18 is an *interop
  profile*, not strict paired-draft conformance (LOC-02 normatively references
  transport-17). Nine-byte Timestamps are accepted.
- **LOC-P2** — a zero Timescale (unspecified in every LOC draft) is a
  construction-time rejection (`invalid-timescale-zero`).

### Stable ids + tombstones

Ids are stable slugs (`domain/name`). They are never renamed. A retired vector
is **tombstoned rather than deleted**: its manifest entry is replaced by
`{ "id": "domain/name", "retired": { "reason": "…" } }`, which the schema
accepts as an inert entry (no execution, no file). This keeps the id reserved
(never reused) and the history diffable. Reviving a retired behavior uses a new
id.

### Canonical encoding

- Every u64/i64-typed field is **always a decimal string** — never a JSON number
  (a JSON number above 2^53-1 silently loses precision). The loader rejects a
  JSON number in a wide-integer field.
- Floats are prohibited. Bytes are lowercase hex; long blobs are
  `{sha256, byteLength}`. Strings compare as exact code points.
- Error comparisons use `error.category`, never message text.

### Read-only + regeneration

The corpus is read-only by default. The runtime `GEN_CORPUS=1` regeneration gate
may rewrite ONLY `implementation-generated` entries produced by this repo;
`assertRegenerable` refuses spec-derived and third-party bytes.

The corpus was authored by `runner/src/build-corpus.ts` (run manually with
`AUTHOR_CORPUS=1`), which constructs spec-derived bytes deterministically and
captures the exact current production behavior for executable vectors. It is
byte-stable across runs.

### Third-party fixture import (LibMoQ)

The 14 LibMoQ MSF fixtures are imported byte-for-byte (5 executable MSF-00,
9 forward-looking MSF-01/CMSF-01) with pinned provenance in
`provenance/libmoq-msf-fixtures.json` (+ a human table in the sibling `.md`).

Normal authoring is **hermetic** — it re-derives from the checked-in snapshot
(`vectors/catalog/libmoq_*.json`), so a fresh clone or CI reproduces the corpus
with no external checkout. The pinned per-fixture SHA-256 gates every byte, so a
tampered snapshot fails authoring.

```
# Hermetic re-author (default; no LibMoQ needed):
AUTHOR_CORPUS=1 tsx conformance/media/runner/src/build-corpus.ts

# Deliberately RE-IMPORT from a LibMoQ worktree (opt-in). Verifies the worktree
# HEAD is the pinned commit before copying, then re-gates every byte by SHA-256:
LIBMOQ_REFRESH=1 LIBMOQ_ROOT=/path/to/libmoq \
  AUTHOR_CORPUS=1 tsx conformance/media/runner/src/build-corpus.ts
```

The pinned commit lives in `build-corpus.ts` (`LIBMOQ_COMMIT`) and the provenance
file. Refresh runs `git rev-parse HEAD` via a direct exec (never a shell), so a
`LIBMOQ_ROOT` containing spaces or metacharacters is handled literally.

## Running

```
pnpm test:corpus       # the runner test suite (loader, validator, per-domain execution)
pnpm test              # includes the corpus lane
```
