# moqt to openmoq steps

Rename the nine published `@moqt/*` packages to `@openmoq/*`, and rename `@playa/player` to `@openmoq/playa`. Leave the private package names (`@moqt/examples`, `@moqt/example-node-publisher`, `@moqt/example-node-relay`, `@moqt/media-conformance-runner`) unchanged. Their dependency specifiers still have to change, because they import the renamed libraries.

This migration does not change the supported transport drafts. Land it on `main` (drafts 14/16/18), then merge it into the experimental draft branch. Keep experimental releases separate from the stable npm channel. Publishing, deprecating packages, and pushing release tags each require explicit approval.

The old names remain as thin compatibility packages in `packages/compat-*`.
They re-export the matching canonical version without runtime warnings. See
[package compatibility](../docs/package-compatibility.md) for the release and
verification contract. Existing published versions are not overwritten.

1. **COMPLETE/TA** Create the `@openmoq` organization on npmjs.com and confirm you are an owner of the existing `@moqt/*` packages and of `@playa/player`. Ownership of those packages is what lets you deprecate them later. Keep the `@moqt` and `@playa` npm orgs after the rename so the old names cannot be re-registered.

2. **COMPLETE/TA** In one repo change, rename these packages and every specifier that points at them:

   | Current | New |
   |---|---|
   | `@moqt/browser` | `@openmoq/browser` |
   | `@moqt/loc` | `@openmoq/loc` |
   | `@moqt/locmaf` | `@openmoq/locmaf` |
   | `@moqt/msf` | `@openmoq/msf` |
   | `@moqt/playback` | `@openmoq/playback` |
   | `@moqt/player` | `@openmoq/player` |
   | `@moqt/quic` | `@openmoq/quic` |
   | `@moqt/transport` | `@openmoq/transport` |
   | `@moqt/webtransport` | `@openmoq/webtransport` |
   | `@playa/player` | `@openmoq/playa` |

   `@playa/player` becomes `@openmoq/playa`, not `@openmoq/player`, because that name is the renamed `@moqt/player`. The `packages/playa` directory stays. Update `name` and dependency fields in every workspace `package.json`, including the renamed playa package and the four private packages. Update `description` fields that still say `@moqt/...` or `@playa/player`, because `scripts/generate-package-readmes.mjs` copies those onto the npm page. Update import specifiers, the aliases in `vitest.config.ts` and `examples/vite.config.ts`, and `scripts/smoke-exports.mjs` (the import strings and the `node_modules/@openmoq` directory it creates). Drop the `node_modules/@playa` directory and the `@playa/player` smoke import; `@openmoq/playa` lives under `@openmoq`. Update the root README and the docs that tell people what to install, and add the old-name to new-name note in that same README change. That note includes `@playa/player` → `@openmoq/playa`.

3. Point the interop client's imports and `tools/moq-interop-client/Dockerfile.client` at `@openmoq/{transport,webtransport,quic}`. Keep the existing build order: compile `transport` and copy it into `node_modules` before compiling `webtransport`, then `quic`. The client's npm lockfile contains third-party dependencies only; all three MoQ libraries are built from this checkout. No old-scope package pins or pre-published new-scope packages are needed. The image build rejects leftover old scopes and checks all three new imports. `publish-interop-client.yml` rebuilds this image on every push to `main`.

4. Regenerate the package READMEs with `node scripts/generate-package-readmes.mjs --write`, then run `pnpm install --frozen-lockfile`, `pnpm -r build`, `pnpm test`, `pnpm typecheck:tests`, and `pnpm smoke:exports`, plus the remaining CI typechecks and example builds. Build `tools/moq-interop-client/Dockerfile.client` from the repository root so its mandatory client tests and native QUIC smoke run against the renamed packages. Merge only when these checks pass.

5. **RAY** After the migration commit reaches `origin/main`, use a clean checkout for the one-time bootstrap: `bash _migration/step5_bootstrap_publish_openmoq.sh`. This command publishes to npm and requires npm credentials with access to the new scope. It requires a commit on `origin/main`, a clean tree, and a frozen install; builds and tests; then validates the complete set of ten tarballs and their versions before publishing any of them. At the current root version this publishes `@openmoq/*@0.5.9`, including `@openmoq/playa@0.5.9`. It does not publish new versions under the old names.

> `0.5.9` is used in the above as the version to match current published version. Change as required.

6. **TA** On each of the ten new npm packages, including `@openmoq/playa`, add this repo's `publish.yml` as a trusted publisher, using the same OIDC settings the workflow comments already describe. `_migration/step6_trusted_publisher_check.sh` checks package visibility only; it does not verify the trusted-publisher configuration.

7. **RAY** After trusted publishing is configured, use the normal release process on `main` to bump to the next version and push a new release tag. That tag publishes ten canonical `@openmoq/*` packages and ten compatibility packages under the old names. Keep trusted publishing configured for both sets. Do not move or recreate the existing `v0.5.9` tag: it identifies the pre-migration source.

8. Verify the interop image publication from the migration commit. No follow-up package-pin change is needed: the image already builds its MoQ libraries from source, independently of the npm bootstrap.

9. **RAY** After confirming the canonical and compatibility releases are installable, deprecate the nine old `@moqt/*` packages and `@playa/player`:

```sh
bash _migration/step9_deprecate_old_scopes.sh
```

   Run this while logged in as an owner of the `@moqt` packages and of `@playa/player`. It checks that all replacements are visible before changing any deprecation notices, then uses package specs such as `@moqt/player@*` to deprecate all old versions. Installing the old names still succeeds and prints the warning. Installing `@openmoq/playa` does not. Keep ownership of the `@moqt` and `@playa` npm orgs so those names cannot be re-registered.

10. Confirm the release from step 7 published all twenty packages and that consumers can install them. This check does not require another version bump. Reapply the old-name deprecation notices after future compatibility releases; notices on previously published versions do not automatically cover new uploads.
