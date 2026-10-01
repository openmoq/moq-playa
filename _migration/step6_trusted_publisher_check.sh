#!/usr/bin/env bash
set -euo pipefail

# Step 6 helper: checklist + package visibility verification for Trusted Publisher setup.
# npm Trusted Publisher must be configured in the npm UI per package.

packages=(
  "@openmoq/browser"
  "@openmoq/loc"
  "@openmoq/locmaf"
  "@openmoq/msf"
  "@openmoq/playback"
  "@openmoq/player"
  "@openmoq/quic"
  "@openmoq/transport"
  "@openmoq/webtransport"
  "@openmoq/playa"
)

cat <<'EOF'
Configure npm Trusted Publisher for EACH package with:
  - Org/user: GitHub owner of this repository
  - Repository: moq-playa
  - Workflow filename: publish.yml
  - Environment: (leave blank unless workflow adds one)
  - Allowed action: npm publish

After configuring each package, this script verifies package visibility on npm.
EOF

echo
echo "Verifying packages are visible in npm registry:"
for pkg in "${packages[@]}"; do
  name="$(npm view "$pkg" name 2>/dev/null || true)"
  if [[ "$name" == "$pkg" ]]; then
    echo "  OK  $pkg"
  else
    echo "  FAIL $pkg (not visible or access issue)" >&2
    exit 1
  fi
done

echo "All @openmoq packages are visible."
