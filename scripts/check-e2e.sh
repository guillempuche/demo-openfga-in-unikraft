#!/usr/bin/env bash
# End-to-end check of the deployed services: a tuple written to OpenFGA
# (through the tunnel) is seen by the public API (over .internal), and so is
# its deletion. Also prints a fingerprint of the demo store (store id, latest
# model id, stored tuples) and compares it with the previous run's, so running
# it before and after a redeploy shows the data survived.
# Needs ./scripts/tunnel.sh running; close it before ./scripts/verify.sh.
. "$(dirname "$0")/env.sh"
require FGA_KEY

export FGA_API_URL="http://localhost:$TUNNEL_PORT"
export FGA_API_TOKEN="$FGA_KEY"
# The CLI also reads FGA_MODEL_ID; this script must use the store's own models.
unset FGA_MODEL_ID

failures=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; failures=$((failures + 1)); }

fqdn="$(unikraft instances get "$API_NAME" -f service.domains -o json 2>/dev/null | jq -r '.[0].service.domains[0].fqdn // empty' || true)"
[[ -n "$fqdn" ]] || { echo "error: $API_NAME has no public domain (is it deployed?)" >&2; exit 1; }
api="https://$fqdn"

FGA_STORE_ID="$(fga store list | jq -r --arg n "$FGA_STORE_NAME" '.stores[] | select(.name == $n) | .id' | head -n1)"
[[ -n "$FGA_STORE_ID" ]] || { echo "error: store $FGA_STORE_NAME not found (run ./scripts/seed.sh)" >&2; exit 1; }
export FGA_STORE_ID

# --- fingerprint, taken before this script writes anything
model_id="$(fga model get --field id --format json | jq -r '.id')"
tuples="$(fga tuple read --max-pages 0 | jq -c '[.tuples[].key] | sort_by(.object, .relation, .user)')"
count="$(jq length <<<"$tuples")"
digest="$(printf '%s' "$tuples" | shasum -a 256 | cut -c1-16)"
fingerprint="store=$FGA_STORE_ID model=$model_id tuples=$count sha256=$digest"
echo "fingerprint: $fingerprint"
fp_file="$ROOT/.cache/e2e-fingerprint"
if [[ -f "$fp_file" ]]; then
  previous="$(cat "$fp_file")"
  if [[ "$previous" == "$fingerprint" ]]; then
    pass "store, model and tuples match the previous run ($(date -r "$fp_file" '+%F %T'))"
  else
    fail "data changed since the previous run: $previous"
  fi
fi
mkdir -p "$ROOT/.cache" && printf '%s\n' "$fingerprint" >"$fp_file"

# --- write -> API sees it -> delete -> API sees that
id="e2e-$(date +%s)-$RANDOM"
user="user:$id" object="project:$id"
delete_tuple() { fga tuple delete "$user" owner "$object" >/dev/null 2>&1 || true; }
trap delete_tuple EXIT

# /check's answer: true, false or error. Pass HIGHER_CONSISTENCY to skip
# OpenFGA's check cache, which can return the pre-write answer for its TTL.
allowed() {
  local query="user=$user&relation=can_edit&object=$object"
  [[ -n "${1:-}" ]] && query+="&consistency=$1"
  curl -sS --max-time 20 "$api/check?$query" | jq -r 'if has("allowed") then .allowed | tostring else "error" end'
}

[[ "$(allowed)" == false ]] && pass "API: $user can't edit $object before the write" || fail "API allowed $user before the write"
fga tuple write "$user" owner "$object" >/dev/null
[[ "$(allowed HIGHER_CONSISTENCY)" == true ]] && pass "API: $user can edit $object right after the write" || fail "API didn't see the written tuple"
echo "info: the same check with the default consistency answered $(allowed) (OpenFGA's check cache may still hold the pre-write answer)"
listed="$(curl -sS --max-time 20 "$api/list-objects?user=$user&relation=can_edit&type=project" | jq -c '.objects')"
[[ "$listed" == "[\"$object\"]" ]] && pass "API: list-objects returns $object" || fail "API list-objects returned $listed"
fga tuple delete "$user" owner "$object" >/dev/null
[[ "$(allowed HIGHER_CONSISTENCY)" == false ]] && pass "API: $user can't edit $object after the delete" || fail "API still allowed $user after the delete"

if ((failures)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
