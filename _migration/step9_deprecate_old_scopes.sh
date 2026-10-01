#!/usr/bin/env bash
set -euo pipefail

# Step 9: Deprecate old package names after replacements are installable.
# Run while authenticated as an owner of @moqt and @playa/player packages.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$ROOT_DIR/_migration/step6_trusted_publisher_check.sh"

npm deprecate "@moqt/browser@*" "@moqt/browser has moved. Install @openmoq/browser instead."
npm deprecate "@moqt/loc@*" "@moqt/loc has moved. Install @openmoq/loc instead."
npm deprecate "@moqt/locmaf@*" "@moqt/locmaf has moved. Install @openmoq/locmaf instead."
npm deprecate "@moqt/msf@*" "@moqt/msf has moved. Install @openmoq/msf instead."
npm deprecate "@moqt/playback@*" "@moqt/playback has moved. Install @openmoq/playback instead."
npm deprecate "@moqt/player@*" "@moqt/player has moved. Install @openmoq/player instead."
npm deprecate "@moqt/quic@*" "@moqt/quic has moved. Install @openmoq/quic instead."
npm deprecate "@moqt/transport@*" "@moqt/transport has moved. Install @openmoq/transport instead."
npm deprecate "@moqt/webtransport@*" "@moqt/webtransport has moved. Install @openmoq/webtransport instead."
npm deprecate "@playa/player@*" "@playa/player has moved. Install @openmoq/playa instead."

echo "Deprecation commands applied."
