# Package Compatibility

New integrations should use `@openmoq/*`. The previous `@moqt/*` names and
`@playa/player` remain available as compatibility packages in `packages/compat-*`.
`@playa/player` delegates to `@openmoq/playa`; the other names keep their suffix.

Each wrapper depends on the matching canonical version and re-exports its public
entry points and TypeScript declarations. Nothing is bundled or implemented twice,
and imports emit no runtime warnings. QUIC keeps its Node runtime requirement.

Existing pinned releases keep their original contents. A compatibility release
must use a new version: versions already published under the old names cannot be
replaced. `scripts/sync-versions.mjs` updates wrappers along with the canonical
packages, and the regular release workflow packs and publishes both sets.

## Verification

`pnpm smoke:exports` also runs the compatibility smoke test. It packs all packages,
extracts them into an isolated consumer without workspace library symlinks, and
checks all 19 legacy entry points for identical runtime exports and compatible
types. Packed dependencies must resolve to the exact corresponding release.
