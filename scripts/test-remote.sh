#!/usr/bin/env bash
# Run the model tests against the deployed OpenFGA through the tunnel.
#
# Uses a fresh, empty store per run (deleted afterwards), so the seeded
# demo-fga store's tuples can't change list_objects/list_users results.
#
# `fga model test` only talks to a server when the test file has no
# model_file (otherwise it runs an embedded OpenFGA), so that line is stripped.
# In this remote mode the CLI sends each test's tuples as contextual tuples:
# this checks the deployed server's evaluation of the model, not reads of
# stored tuples (the integration suite covers those).
. "$(dirname "$0")/env.sh"
require FGA_KEY

export FGA_API_URL="http://localhost:$TUNNEL_PORT"
export FGA_API_TOKEN="$FGA_KEY"
# The CLI also reads FGA_MODEL_ID; this script must use the store's own models.
unset FGA_MODEL_ID

store_name="demo-fga-test-$(date +%Y%m%d%H%M%S)"
FGA_STORE_ID="$(fga store create --name "$store_name" | jq -r '.store.id')"
export FGA_STORE_ID
require FGA_STORE_ID

tmpdir="$(mktemp -d)"
cleanup() {
  fga store delete --store-id "$FGA_STORE_ID" --force >/dev/null 2>&1 || echo "warning: could not delete test store $store_name ($FGA_STORE_ID)" >&2
  rm -rf "$tmpdir"
}
trap cleanup EXIT

fga model write --file "$ROOT/authz/models/fga.mod" | jq -c '{authorization_model_id}'
for f in "$ROOT"/authz/models/*.fga.yaml; do
  sed '/^model_file:/d' "$f" >"$tmpdir/$(basename "$f")"
done

echo "running model tests against $FGA_API_URL (store $store_name)"
fga model test --tests "$tmpdir/*.fga.yaml"
