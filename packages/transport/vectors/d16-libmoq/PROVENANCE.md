# Vendored draft-16 wire vectors (from LibMoQ)

These binary test vectors are a **verbatim vendored snapshot** of LibMoQ's draft-16 wire-format
corpus, used to cross-validate Playa's draft-16 codec against an independent implementation's bytes.

- **Source:** `LibMoQ/libmoq/tests/vectors/d16/` (`*.bin` + `manifest.json`)
- **Source commit:** `6326152e7961cb5768db61526e6e8be8b8cf0e41`
  ("core: carry draft-18 authorization tokens on requests", 2026-06-04)
- **Contents:** 39 `.bin` fixtures + `manifest.json` (`{ file, type, type_code, wire_hex, expected }`).

Do not edit these files by hand — they are an external artifact. To refresh, re-copy from the LibMoQ
source and update the commit above. The consuming test is
`packages/transport/src/vectors/vectors-d16.test.ts`, which decodes each vector with Playa's draft-16
codec, re-encodes, and asserts byte-identity (or, where canonicalization legitimately differs,
`decode(reencode) ≡ decode(wire)`).
