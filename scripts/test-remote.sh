#!/usr/bin/env bash
# Run the model tests against the deployed OpenFGA through the tunnel.
#
# `fga model test` only talks to a server when the test file has no
# model_file; otherwise it spins up an embedded OpenFGA and never touches the
# network. So strip that line and point the CLI at the store: it then uses the
# store's latest model and sends each test's tuples as contextual tuples.
. "$(dirname "$0")/env.sh"
require FGA_KEY

export FGA_API_URL="http://localhost:$TUNNEL_PORT"
export FGA_API_TOKEN="$FGA_KEY"
FGA_STORE_ID="$(fga store list | jq -r --arg n "$FGA_STORE_NAME" '.stores[] | select(.name == $n) | .id' | head -n1)"
export FGA_STORE_ID
require FGA_STORE_ID

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
for f in "$ROOT"/authz/models/*.fga.yaml; do
  sed '/^model_file:/d' "$f" >"$tmpdir/$(basename "$f")"
done

fga model test --tests "$tmpdir/*.fga.yaml"
