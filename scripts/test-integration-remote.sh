#!/usr/bin/env bash
# Run the OpenFGA integration suite and the API coverage gate against the
# deployed instance, through ./scripts/tunnel.sh (run it in another terminal).
# The deployment doesn't enable experimental features, so the AuthZEN and
# $expression tier is skipped and reported as excluded.
. "$(dirname "$0")/env.sh"
require FGA_KEY

(cd "$ROOT/tests/integration" && [[ -d node_modules ]] || npm ci --silent)

export FGA_API_URL="http://localhost:$TUNNEL_PORT"
export FGA_API_TOKEN="$FGA_KEY"
export FGA_GRPC_ADDR="localhost:$TUNNEL_GRPC_PORT"
export FGA_METRICS_URL="http://localhost:$TUNNEL_METRICS_PORT/metrics"
export FGA_EXPERIMENTAL=0

# Test stores are named it-*; remove any left by an interrupted run, before
# and after, so the deployed instance only keeps demo-fga.
delete_test_stores() {
  fga store list --max-pages 0 2>/dev/null | jq -r '.stores[] | select(.name | startswith("it-")) | .id' |
    while read -r id; do fga store delete --store-id "$id" --force >/dev/null; done
}
delete_test_stores
trap 'delete_test_stores' EXIT

python3 "$ROOT/scripts/check-api-coverage.py"
