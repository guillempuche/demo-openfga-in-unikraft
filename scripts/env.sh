# Shared settings for the Unikraft Cloud scripts. Sourced, not executed.
#
# Secrets (NEON_OPENFGA_DIRECT_URL, FGA_KEY) come from the environment or the
# gitignored .env at the repo root. Scripts never echo them and never use
# `set -x`. The unikraft CLI authenticates through its own profile
# (`unikraft login`), so UKC_TOKEN is not read here.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

UNIKRAFT_ORG="${UNIKRAFT_ORG:-gaaaa}"
UNIKRAFT_METRO="${UNIKRAFT_METRO:-fra}"

# Every cloud resource this demo creates is prefixed with demo-fga-; the
# cleanup script refuses to touch anything else.
PREFIX="demo-fga-"
OPENFGA_NAME="${PREFIX}openfga"
API_NAME="${PREFIX}api"
OPENFGA_IMAGE="$UNIKRAFT_ORG/${OPENFGA_NAME}:latest"
API_IMAGE="$UNIKRAFT_ORG/${API_NAME}:latest"
OPENFGA_VERSION="v1.11.0"
FGA_STORE_NAME="${FGA_STORE_NAME:-demo-fga}"
TUNNEL_PORT="${TUNNEL_PORT:-18080}"

require() {
  local v
  for v in "$@"; do
    if [[ -z "${!v:-}" ]]; then
      echo "error: $v is not set (export it or add it to $ROOT/.env)" >&2
      exit 1
    fi
  done
}

# Quote a value as a YAML scalar (a JSON string is valid YAML).
yq_str() { jq -Rn --arg v "$1" '$v'; }

# Mask credentials in anything that might echo a connection string.
redact() { sed -E 's#(postgres(ql)?://)[^@[:space:]]+@#\1***@#g'; }

instance_exists() {
  unikraft instances get "$1" -f name -o json >/dev/null 2>&1
}

# Print only non-secret fields; `instances get` would otherwise include
# runtime.env, which holds the datastore URI and the preshared key.
show_instance() {
  unikraft instances get "$1" -f name,state,image,resources.memory,networks,service.domains,scale-to-zero
}
