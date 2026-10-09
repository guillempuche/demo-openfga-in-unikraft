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
# The deployment caps ListObjects/ListUsers at this value (deploy.sh); the
# truncation tests check it.
export FGA_LIST_MAX_RESULTS

# Fail fast when the tunnel isn't up: the fga CLI retries a refused
# connection with growing delays for minutes.
if ! curl -fsS --max-time 10 "$FGA_API_URL/healthz" >/dev/null; then
  echo "error: OpenFGA doesn't answer at $FGA_API_URL: is ./scripts/tunnel.sh running?" >&2
  exit 1
fi

# Test stores are named it-*; remove any left by an interrupted run, before
# and after, so the deployed instance only keeps demo-fga.
delete_test_stores() {
  local stores
  if ! stores="$(fga store list --max-pages 0)"; then
    echo "error: can't list the stores through the tunnel: is ./scripts/tunnel.sh running?" >&2
    return 1
  fi
  jq -r '.stores[] | select(.name | startswith("it-")) | .id' <<<"$stores" |
    while read -r id; do fga store delete --store-id "$id" --force >/dev/null; done
}
delete_test_stores
trap 'delete_test_stores' EXIT

python3 "$ROOT/scripts/check-api-coverage.py"
