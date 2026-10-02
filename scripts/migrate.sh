#!/usr/bin/env bash
# Run OpenFGA's schema migrations against Neon (direct, unpooled URL). Once.
. "$(dirname "$0")/env.sh"
require NEON_OPENFGA_DIRECT_URL

# `-e NAME` without a value makes docker read it from this environment, so the
# URI never appears in the process list.
export OPENFGA_DATASTORE_ENGINE=postgres
export OPENFGA_DATASTORE_URI="$NEON_OPENFGA_DIRECT_URL"
docker run --rm \
  -e OPENFGA_DATASTORE_ENGINE \
  -e OPENFGA_DATASTORE_URI \
  "openfga/openfga:$OPENFGA_VERSION" migrate 2>&1 | redact
