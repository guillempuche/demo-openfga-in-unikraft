#!/usr/bin/env bash
# Create the instances: ./scripts/deploy.sh [openfga|api|all]
#
# - demo-fga-openfga: private (no published ports), scale-to-zero off,
#   preshared-key auth, Neon as datastore. Reachable only on the internal
#   network as demo-fga-openfga.internal:8080.
# - demo-fga-api: public HTTPS, talks to OpenFGA over .internal.
#
# `unikraft run -e` only accepts KEY=VALUE on the command line, which would put
# secrets in the process list. Instead each instance is described in a 0600
# temp YAML passed with --load (same schema as `unikraft run --save`).
#
# This never restarts an existing instance: to redeploy, run
# ./scripts/cleanup.sh first.
. "$(dirname "$0")/env.sh"

target="${1:-all}"

tmp="$(umask 077; mktemp)"
trap 'rm -f "$tmp"' EXIT

run_from_yaml() {
  local name="$1"
  if instance_exists "$name"; then
    echo "error: $name already exists; delete it first (scripts/cleanup.sh)" >&2
    exit 1
  fi
  unikraft run --load "$tmp" -o quiet
  unikraft instances wait "$name" --until state==running --timeout 2m
  show_instance "$name"
}

if [[ "$target" == openfga || "$target" == all ]]; then
  require NEON_OPENFGA_DIRECT_URL FGA_KEY
  cat >"$tmp" <<EOF
name: $OPENFGA_NAME
metro: $UNIKRAFT_METRO
image: $OPENFGA_IMAGE
autostart: true
resources:
  memory: 512MiB
restart:
  policy: on-failure
scale-to-zero:
  policy: "off"
runtime:
  env:
    OPENFGA_DATASTORE_ENGINE: postgres
    OPENFGA_DATASTORE_URI: $(yq_str "$NEON_OPENFGA_DIRECT_URL")
    OPENFGA_DATASTORE_MAX_OPEN_CONNS: "10"
    OPENFGA_AUTHN_METHOD: preshared
    OPENFGA_AUTHN_PRESHARED_KEYS: $(yq_str "$FGA_KEY")
    OPENFGA_HTTP_ADDR: 0.0.0.0:8080
    OPENFGA_PLAYGROUND_ENABLED: "false"
    OPENFGA_CHECK_QUERY_CACHE_ENABLED: $(yq_str "${OPENFGA_CHECK_QUERY_CACHE_ENABLED:-true}")
    OPENFGA_LOG_FORMAT: json
    OPENFGA_LOG_LEVEL: info
EOF
  run_from_yaml "$OPENFGA_NAME"
fi

if [[ "$target" == api || "$target" == all ]]; then
  require FGA_KEY
  cat >"$tmp" <<EOF
name: $API_NAME
metro: $UNIKRAFT_METRO
image: $API_IMAGE
autostart: true
resources:
  memory: 512MiB
restart:
  policy: on-failure
scale-to-zero:
  policy: "on"
  cooldown-time: 5s
service:
  services:
  - source: 443
    destination: 8080
    handlers: [http, tls]
  - source: 80
    destination: 443
    handlers: [http, redirect]
runtime:
  env:
    PORT: "8080"
    FGA_API_URL: http://$OPENFGA_NAME.internal:8080
    FGA_STORE_NAME: $(yq_str "$FGA_STORE_NAME")
    FGA_KEY: $(yq_str "$FGA_KEY")
EOF
  run_from_yaml "$API_NAME"
fi
