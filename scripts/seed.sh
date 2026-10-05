#!/usr/bin/env bash
# Create the demo store, write the model (only if it changed) and the synthetic
# tuples, and record the model id the API pins (.cache/fga-model-id, read by
# deploy.sh). Needs ./scripts/tunnel.sh running in another terminal.
. "$(dirname "$0")/env.sh"
require FGA_KEY

# The fga CLI reads these from the environment, keeping the key off argv.
export FGA_API_URL="http://localhost:$TUNNEL_PORT"
export FGA_API_TOKEN="$FGA_KEY"
# The CLI also reads FGA_MODEL_ID; this script decides the model itself.
unset FGA_MODEL_ID

store_id="$(fga store list | jq -r --arg n "$FGA_STORE_NAME" '.stores[] | select(.name == $n) | .id' | head -n1)"
if [[ -z "$store_id" ]]; then
  store_id="$(fga store create --name "$FGA_STORE_NAME" | jq -r '.store.id')"
  echo "created store $FGA_STORE_NAME ($store_id)"
fi
export FGA_STORE_ID="$store_id"

# Every `fga model write` creates a new model id, so write only when the latest
# model differs from authz/models. The server fills in empty defaults
# (`generic_types: []`, `relations: {}`), so compare without empty values.
normalize='del(.id) | walk(if type == "object" then with_entries(select(.value != [] and .value != {} and .value != null and .value != "")) else . end)'
want="$(fga model transform --file "$ROOT/authz/models/fga.mod" --output-format json | jq -S -c "$normalize")"
model_id="$(fga model get --field id --format json 2>/dev/null | jq -r '.id // empty' || true)"
if [[ -n "$model_id" && "$(fga model get --field model --format json | jq -S -c "$normalize")" == "$want" ]]; then
  echo "model unchanged: $model_id"
else
  model_id="$(fga model write --file "$ROOT/authz/models/fga.mod" | jq -r '.authorization_model_id')"
  echo "wrote model $model_id"
fi

fga tuple write --model-id "$model_id" --file "$ROOT/authz/seed/tuples.yaml" | jq -c '{written: (.successful | length), failed: (.failed | length)}'

mkdir -p "$ROOT/.cache"
printf '%s\n' "$model_id" >"$MODEL_ID_FILE"
echo "recorded $model_id in .cache/fga-model-id; the API pins it from its next deploy (./scripts/cleanup.sh && ./scripts/deploy.sh)"
