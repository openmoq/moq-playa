#!/bin/bash
# Build the interop client image. Not `docker build -q`: quiet mode hides
# compile errors and a failed build leaves the previous image in place.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${IMAGE:-ghcr.io/openmoq/moq-playa-interop-client:latest}"
NODE_BUILD_JOBS="${NODE_BUILD_JOBS:-2}"
case "$NODE_BUILD_JOBS" in
  ''|0*|*[!0-9]*)
    echo "NODE_BUILD_JOBS must be a positive integer" >&2
    exit 2
    ;;
esac
docker build \
  --build-arg "NODE_BUILD_JOBS=$NODE_BUILD_JOBS" \
  -f "$ROOT/tools/moq-interop-client/Dockerfile.client" \
  -t "$IMAGE" \
  "$ROOT"
echo "build ok: $IMAGE"
