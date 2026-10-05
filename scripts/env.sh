# shellcheck shell=bash
# shellcheck disable=SC2034 # variables here are used by the scripts that source this file
# Shared settings for the Unikraft Cloud scripts. Sourced, not executed.
#
# Secrets (FGA_KEY, POSTGRES_PASSWORD, optional OPENFGA_DATASTORE_URI) come
# from the environment or the gitignored .env at the repo root; variables that
# are already set win over .env. Scripts never echo them and never use
# `set -x`. The unikraft CLI authenticates through its own profile
# (`unikraft login`), so UKC_TOKEN is not read here.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load .env without overriding anything the caller already exported, so
# `UNIKRAFT_PROFILE=other ./scripts/x.sh` does what it says. Only plain
# KEY=VALUE lines are read (optionally quoted); nothing in .env is executed.
if [[ -f "$ROOT/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    [[ -n "${!key+set}" ]] && continue
    if [[ "$value" != [\"\']* ]]; then
      value="${value%%[[:space:]]#*}" # unquoted: drop a trailing comment
    fi
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    export "$key=$value"
  done <"$ROOT/.env"
  unset line key value
fi

# Pin the CLI profile explicitly so these scripts never act on whichever
# profile happens to be active (the CLI reads $UNIKRAFT_PROFILE).
if [[ -z "${UNIKRAFT_PROFILE:-}" ]]; then
  echo "error: UNIKRAFT_PROFILE is not set (add it to $ROOT/.env, see .env.example)" >&2
  exit 1
fi
export UNIKRAFT_PROFILE
if ! unikraft profile list 2>/dev/null | awk 'NR > 1 {print $1}' | grep -qx "$UNIKRAFT_PROFILE"; then
  echo "error: unikraft profile '$UNIKRAFT_PROFILE' not found; run: unikraft login --organization $UNIKRAFT_PROFILE --token -" >&2
  exit 1
fi
UNIKRAFT_ORG="${UNIKRAFT_ORG:-$UNIKRAFT_PROFILE}"
UNIKRAFT_METRO="${UNIKRAFT_METRO:-fra}"

# Every cloud resource this demo creates is prefixed with demo-fga-; the
# cleanup script refuses to touch anything else.
PREFIX="demo-fga-"
POSTGRES_NAME="${PREFIX}postgres"
POSTGRES_VOLUME="${PREFIX}pgdata"
MIGRATE_NAME="${PREFIX}migrate"
OPENFGA_NAME="${PREFIX}openfga"
API_NAME="${PREFIX}api"
POSTGRES_IMAGE="$UNIKRAFT_ORG/${POSTGRES_NAME}:latest"
OPENFGA_IMAGE="$UNIKRAFT_ORG/${OPENFGA_NAME}:latest"
API_IMAGE="$UNIKRAFT_ORG/${API_NAME}:latest"
FGA_STORE_NAME="${FGA_STORE_NAME:-demo-fga}"
# ListObjects/ListUsers max results on the deployment (default 1000). The
# integration suite needs at least 61 and tests the truncation at this value.
FGA_LIST_MAX_RESULTS="${FGA_LIST_MAX_RESULTS:-100}"
TUNNEL_PORT="${TUNNEL_PORT:-18080}"
TUNNEL_GRPC_PORT="${TUNNEL_GRPC_PORT:-18081}"
TUNNEL_METRICS_PORT="${TUNNEL_METRICS_PORT:-12112}"

require() {
  local v
  for v in "$@"; do
    if [[ -z "${!v:-}" ]]; then
      echo "error: $v is not set (export it or add it to $ROOT/.env)" >&2
      exit 1
    fi
  done
}

# Quote a value as a YAML scalar (a JSON string is valid YAML). The value goes
# to jq on stdin (printf is a builtin), never on jq's argv, so secrets don't
# show up in the process list.
yq_str() { printf '%s' "$1" | jq -Rs .; }

# Mask credentials in anything that might echo a connection string.
redact() { sed -E 's#(postgres(ql)?://)[^@[:space:]]+@#\1***@#g'; }

instance_exists() {
  unikraft instances get "$1" -f name -o json >/dev/null 2>&1
}

# Deploys pin images by digest, not :latest. build.sh records the digest of
# each image it pushes; deploy.sh runs exactly that image, even if :latest
# moves later (a newer build, another machine). One "<org>/<name> <digest>"
# line per image.
DIGESTS_FILE="$ROOT/.cache/image-digests"

# The registry's current digest of <org>/<name>:latest.
registry_digest() {
  unikraft images list -o json | jq -r --arg r "${1%:latest}" '.[] | select(.ref == $r) | .digest' | head -n1
}

# Record <digest> as the one to deploy for <org>/<name>:latest.
record_digest() {
  local repo="${1%:latest}"
  mkdir -p "$(dirname "$DIGESTS_FILE")"
  { grep -v "^$repo " "$DIGESTS_FILE" 2>/dev/null || true; echo "$repo $2"; } >"$DIGESTS_FILE.tmp"
  mv "$DIGESTS_FILE.tmp" "$DIGESTS_FILE"
}

# The reference to deploy: <org>/<name>@<recorded digest>. With nothing
# recorded (a fresh clone, images built elsewhere), pin and record the
# registry's current digest.
pinned_image() {
  local repo="${1%:latest}" digest
  digest="$(awk -v r="$repo" '$1 == r {print $2}' "$DIGESTS_FILE" 2>/dev/null || true)"
  if [[ -z "$digest" ]]; then
    digest="$(registry_digest "$1")"
    [[ -n "$digest" ]] || { echo "error: $repo not found in the registry; run ./scripts/build.sh" >&2; exit 1; }
    record_digest "$1" "$digest"
    echo "no recorded build of $repo; pinned the registry's current digest" >&2
  fi
  echo "$repo@$digest"
}

# Print only non-secret fields; `instances get` would otherwise include
# runtime.env, which holds the datastore URI and the preshared key.
show_instance() {
  unikraft instances get "$1" -f name,state,image,resources.memory,networks,service.domains,scale-to-zero
}
