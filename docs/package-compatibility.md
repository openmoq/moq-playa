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

## Release Order

1. Choose a new release version, build, test, and review the tarballs.
2. Bootstrap the canonical packages using the existing migration instructions and
   configure their npm trusted publishers. Bootstrap packs only `@openmoq/*`.
3. Publish the compatibility packages through the regular release workflow. Keep
   trusted publishing configured for the existing names too.
4. After verifying both sets are installable, explicitly run
   `bash _migration/step9_deprecate_old_scopes.sh` as an owner of the old packages.
   This applies npm installation warnings directing users to the replacements;
   it does not prevent installation. Repeat after subsequent compatibility releases
   so those new versions also carry the registry deprecation notice.

Publishing and deprecation are separate, explicitly authorized remote actions.
Do not unpublish existing packages or attach runtime/postinstall warning hooks.

## Verification

`pnpm smoke:exports` also runs the compatibility smoke test. It packs all packages,
extracts them into an isolated consumer without workspace library symlinks, and
checks all 19 legacy entry points for identical runtime exports and compatible
types. Packed dependencies must resolve to the exact corresponding release.
