#!/usr/bin/env bash
# Create the demo store, write the model and the synthetic tuples.
# Needs ./scripts/tunnel.sh running in another terminal.
. "$(dirname "$0")/env.sh"
require FGA_KEY

# The fga CLI reads these from the environment, keeping the key off argv.
export FGA_API_URL="http://localhost:$TUNNEL_PORT"
export FGA_API_TOKEN="$FGA_KEY"

store_id="$(fga store list | jq -r --arg n "$FGA_STORE_NAME" '.stores[] | select(.name == $n) | .id' | head -n1)"
if [[ -z "$store_id" ]]; then
  store_id="$(fga store create --name "$FGA_STORE_NAME" | jq -r '.store.id')"
  echo "created store $FGA_STORE_NAME ($store_id)"
fi
export FGA_STORE_ID="$store_id"

fga model write --file "$ROOT/authz/models/fga.mod" | jq -c '{authorization_model_id}'
fga tuple write --file "$ROOT/authz/seed/tuples.yaml" | jq -c '{written: (.successful | length), failed: (.failed | length)}'
