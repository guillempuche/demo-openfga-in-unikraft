#!/usr/bin/env bash
# Build and push the unikernel images: ./scripts/build.sh [openfga|api|all]
. "$(dirname "$0")/env.sh"

target="${1:-all}"

if [[ "$target" == openfga || "$target" == all ]]; then
  unikraft build "$ROOT/infrastructure/kraftcloud/openfga" --output "$OPENFGA_IMAGE"
fi
if [[ "$target" == api || "$target" == all ]]; then
  unikraft build "$ROOT/api" --output "$API_IMAGE"
fi
