#!/bin/bash
# Build the interop client image. Not `docker build -q`: quiet mode hides
# compile errors and a failed build leaves the previous image in place.
set -euo pipefail
cd "$(dirname "$0")"
IMAGE="${IMAGE:-ghcr.io/openmoq/moq-playa-interop-client:latest}"
docker build -f Dockerfile.client -t "$IMAGE" .
echo "build ok: $IMAGE"
