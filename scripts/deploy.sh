#!/usr/bin/env bash
# Create the instances: ./scripts/deploy.sh [postgres|migrate|openfga|api|all]
#
# Everything runs on Unikraft Cloud, on the account's private network:
# - demo-fga-postgres: private, persistent volume demo-fga-pgdata, scale-to-zero off.
# - demo-fga-migrate: one-off `openfga migrate` against postgres, deleted when
#   done; the deploy stops unless it exits 0.
# - demo-fga-openfga: private (no published ports), scale-to-zero off,
#   preshared-key auth. Reachable only as demo-fga-openfga.internal:8080.
# - demo-fga-api: public HTTPS, talks to OpenFGA over .internal.
#
# `unikraft run -e` only accepts KEY=VALUE on the command line, which would put
# secrets in the process list. Instead each instance is described in a 0600
# temp YAML passed with --load (same schema as `unikraft run --save`).
#
# Images run by digest: the one build.sh last recorded (see DIGESTS_FILE in
# env.sh), so a redeploy runs exactly what was built and verified.
#
# This never restarts an existing instance: to redeploy, run
# ./scripts/cleanup.sh first. The postgres volume survives cleanup.
. "$(dirname "$0")/env.sh"

target="${1:-all}"
case "$target" in
  postgres | migrate | openfga | api | all) ;;
  *) echo "usage: $0 [postgres|migrate|openfga|api|all]" >&2; exit 1 ;;
esac

tmp="$(umask 077; mktemp)"
trap 'rm -f "$tmp"' EXIT

# OpenFGA's datastore: the private postgres instance unless overridden (e.g.
# with an external Postgres URL). Plain TCP is fine here: the connection never
# leaves the account's private network.
datastore_uri() {
  if [[ -n "${OPENFGA_DATASTORE_URI:-}" ]]; then
    printf '%s' "$OPENFGA_DATASTORE_URI"
  else
    require POSTGRES_PASSWORD
    printf 'postgres://openfga:%s@%s.internal:5432/openfga?sslmode=disable' "$POSTGRES_PASSWORD" "$POSTGRES_NAME"
  fi
}

run_from_yaml() {
  local name="$1"
  if instance_exists "$name"; then
    echo "error: $name already exists; delete it first (scripts/cleanup.sh)" >&2
    exit 1
  fi
  unikraft run --load "$tmp" -o quiet
}

wait_running() {
  unikraft instances wait "$1" --until state==running --timeout 3m -o quiet
  show_instance "$1"
}

if [[ "$target" == postgres || "$target" == all ]]; then
  require POSTGRES_PASSWORD
  if ! unikraft volumes get "$POSTGRES_VOLUME" -f name -o json >/dev/null 2>&1; then
    unikraft volumes create --metro "$UNIKRAFT_METRO" --name "$POSTGRES_VOLUME" --size 512MiB -o quiet
  fi
  image="$(pinned_image "$POSTGRES_IMAGE")"
  cat >"$tmp" <<EOF
name: $POSTGRES_NAME
metro: $UNIKRAFT_METRO
image: $image
autostart: true
resources:
  memory: 512MiB
restart:
  policy: on-failure
scale-to-zero:
  policy: "off"
volumes:
- name: $POSTGRES_VOLUME
  at: /volume
runtime:
  env:
    POSTGRES_USER: openfga
    POSTGRES_DB: openfga
    POSTGRES_PASSWORD: $(yq_str "$POSTGRES_PASSWORD")
    PGDATA: /volume/postgres
EOF
  run_from_yaml "$POSTGRES_NAME"
  wait_running "$POSTGRES_NAME"
fi

if [[ "$target" == migrate || "$target" == all ]]; then
  # Same OpenFGA image, `migrate` instead of `run`, on the private network.
  # restart=never so a failed run stays stopped and its exit code is final;
  # the loop retries a few times because postgres may still be initialising.
  # Plain assignment (not inside the heredoc) so a missing secret aborts here.
  uri="$(datastore_uri)"
  image="$(pinned_image "$OPENFGA_IMAGE")"
  cat >"$tmp" <<EOF
name: $MIGRATE_NAME
metro: $UNIKRAFT_METRO
image: $image
autostart: true
resources:
  memory: 256MiB
restart:
  policy: never
runtime:
  args: [/usr/bin/openfga, migrate]
  env:
    OPENFGA_DATASTORE_ENGINE: postgres
    OPENFGA_DATASTORE_URI: $(yq_str "$uri")
EOF
  migrated=false
  for attempt in 1 2 3 4 5; do
    run_from_yaml "$MIGRATE_NAME"
    unikraft instances wait "$MIGRATE_NAME" --until state==stopped --timeout 5m -o quiet
    code="$(unikraft instances get "$MIGRATE_NAME" -f stop -o json | jq -r '.[0].stop["exit-code"] // "unknown"')"
    unikraft instances logs "$MIGRATE_NAME" 2>&1 | redact | tail -n 15 || true
    unikraft instances delete "$MIGRATE_NAME" -o quiet >/dev/null
    if [[ "$code" == 0 ]]; then
      migrated=true
      break
    fi
    echo "migrate attempt $attempt exited with $code; retrying in 10s" >&2
    sleep 10
  done
  if ! $migrated; then
    echo "error: openfga migrate failed; not deploying OpenFGA on an unmigrated database" >&2
    exit 1
  fi
fi

if [[ "$target" == openfga || "$target" == all ]]; then
  require FGA_KEY
  uri="$(datastore_uri)"
  image="$(pinned_image "$OPENFGA_IMAGE")"
  cat >"$tmp" <<EOF
name: $OPENFGA_NAME
metro: $UNIKRAFT_METRO
image: $image
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
    OPENFGA_DATASTORE_URI: $(yq_str "$uri")
    # Pool sizes from the production guide (min open 5-20, min idle 50-75% of
    # it), with max open at 20 rather than Postgres' max_connections (100): a
    # 512MiB Postgres can't serve 100 busy backends.
    OPENFGA_DATASTORE_MAX_OPEN_CONNS: "20"
    OPENFGA_DATASTORE_MIN_OPEN_CONNS: "5"
    OPENFGA_DATASTORE_MIN_IDLE_CONNS: "3"
    OPENFGA_DATASTORE_METRICS_ENABLED: "true"
    OPENFGA_METRICS_ENABLE_RPC_HISTOGRAMS: "true"
    # The public API forwards any caller's query: bound how much one query can
    # return and how many datastore reads it can run at once.
    OPENFGA_LIST_OBJECTS_MAX_RESULTS: "$FGA_LIST_MAX_RESULTS"
    OPENFGA_LIST_USERS_MAX_RESULTS: "$FGA_LIST_MAX_RESULTS"
    OPENFGA_MAX_CONCURRENT_READS_FOR_CHECK: "10"
    OPENFGA_MAX_CONCURRENT_READS_FOR_LIST_OBJECTS: "10"
    OPENFGA_MAX_CONCURRENT_READS_FOR_LIST_USERS: "10"
    OPENFGA_AUTHN_METHOD: preshared
    OPENFGA_AUTHN_PRESHARED_KEYS: $(yq_str "$FGA_KEY")
    OPENFGA_HTTP_ADDR: 0.0.0.0:8080
    OPENFGA_PLAYGROUND_ENABLED: "false"
    OPENFGA_CHECK_QUERY_CACHE_ENABLED: $(yq_str "${OPENFGA_CHECK_QUERY_CACHE_ENABLED:-true}")
    OPENFGA_LOG_FORMAT: json
    OPENFGA_LOG_LEVEL: info
EOF
  run_from_yaml "$OPENFGA_NAME"
  wait_running "$OPENFGA_NAME"
fi

if [[ "$target" == api || "$target" == all ]]; then
  require FGA_KEY
  image="$(pinned_image "$API_IMAGE")"
  cat >"$tmp" <<EOF
name: $API_NAME
metro: $UNIKRAFT_METRO
image: $image
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
  wait_running "$API_NAME"
fi
