#!/bin/bash
# entrypoint-client.sh — moq-playa interop client.
#
# Maps the runner's standard environment onto the client. MOQT_DRAFT is the
# draft selector and is forwarded verbatim: the old scaffold read DRAFT_VERSION
# while compose sets MOQT_DRAFT, so a planned draft-16 row silently ran the
# client default. The client fails closed on an unsupported value rather than
# defaulting a non-empty one.
set -euo pipefail
exec node --experimental-quic /app/dist/main.js
