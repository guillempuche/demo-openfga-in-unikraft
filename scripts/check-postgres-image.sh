#!/usr/bin/env bash
# Check the PostgreSQL image that OpenFGA uses on Unikraft Cloud, before it is
# deployed: build its root file system (infrastructure/unikraft/postgres), start
# it with the Kraftfile's own command as a brand-new database, as on the first
# deploy, and check the PostgreSQL version, that the scale-to-zero extension is
# loaded, that a write can be read back, and that it shuts down cleanly.
#   ./scripts/check-postgres-image.sh [--no-build]   (--no-build: reuse the last build)
#
# It does that twice: with TLS (encrypted connections, what deploy.sh runs by
# default), where only TLS 1.3 connections that verify the server's certificate
# get in, and without (INTERNAL_TLS=off).
#
# It runs the image as a Docker container (x86-64; emulated on Apple Silicon),
# not as a unikernel, so it needs no Unikraft account: it doesn't source env.sh
# and uses only throwaway secrets. CI runs it whenever the image changes.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
postgres_dir="$root/infrastructure/unikraft/postgres"
image="demo-fga-postgres-rootfs:check"
# $$ (this script's process ID) gives each run its own containers.
container_prefix="demo-fga-postgres-check-$$"

if [[ "${1:-}" != --no-build ]]; then
  docker build --platform linux/amd64 --tag "$image" "$postgres_dir"
fi

# The expected version is the text after "ARG PG_VERSION=" in the Dockerfile.
# The Kraftfile's "cmd:" line is a JSON array: jq prints one element per line
# and mapfile reads each line into one element of a bash array.
expected_version="$(sed -n 's/^ARG PG_VERSION=//p' "$postgres_dir/Dockerfile")"
mapfile -t kraftfile_cmd < <(sed -n 's/^cmd: //p' "$postgres_dir/Kraftfile" | jq -r '.[]')
[[ -n "$expected_version" && ${#kraftfile_cmd[@]} -gt 0 ]] || { echo "error: no PG_VERSION in the Dockerfile or no cmd in the Kraftfile" >&2; exit 1; }

# Throwaway certificates for the TLS run, made like the real ones.
tls_dir="$(mktemp -d)"
"$root/scripts/tls.sh" --out "$tls_dir" >/dev/null

containers=()
cleanup() {
  ((${#containers[@]} == 0)) || docker rm -f "${containers[@]}" >/dev/null 2>&1 || true
  rm -rf "$tls_dir"
}
trap cleanup EXIT

# Counts failures instead of exiting, so every check runs and reports.
failures=0
check() {
  local description="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "ok   $description: $actual"
  else
    echo "FAIL $description: got '$actual', expected '$expected'"
    failures=$((failures + 1))
  fi
}

# Start the image as a new database, with the same environment as
# scripts/deploy.sh and a throwaway password, plus any extra `docker run`
# options. Then wait for it: up to 120 tries, a second apart (if it never
# answers, the checks fail and print its log). Over TCP: during initialisation
# the wrapper runs a temporary server on the Unix socket only, so a TCP answer
# means the real server is up.
start() {
  local name="$1"
  shift
  containers+=("$name")
  docker run -d --name "$name" --platform linux/amd64 \
    -e POSTGRES_USER=openfga -e POSTGRES_DB=openfga -e POSTGRES_PASSWORD=check -e PGDATA=/volume/postgres \
    "$@" "$image" "${kraftfile_cmd[@]}" >/dev/null
  for _ in $(seq 1 120); do
    docker exec "$name" pg_isready -q -h 127.0.0.1 && break
    sleep 1
  done
}

# Run one SQL statement in <container> over the connection described by
# <conninfo> (libpq's "key=value" form) and print only the values (-tA: no
# headers, no padding).
sql() {
  docker exec -e PGPASSWORD=check "$1" psql "$2 user=openfga dbname=openfga" -v ON_ERROR_STOP=1 -tAc "$3"
}

# The checks both runs share. 2>&1: when a query fails, its error message is
# shown as the result.
check_database() {
  local name="$1" conninfo="$2"
  check "server version" "$(sql "$name" "$conninfo" 'SHOW server_version' 2>&1)" "$expected_version"
  check "preloaded extension" "$(sql "$name" "$conninfo" 'SHOW shared_preload_libraries' 2>&1)" "pg_ukc_scaletozero"
  # psql prints each statement's status (CREATE TABLE, INSERT 0 1) before the
  # SELECT's value, so the value is the last line.
  check "write and read" "$(sql "$name" "$conninfo" 'CREATE TABLE check_rw (n int); INSERT INTO check_rw VALUES (42); SELECT n FROM check_rw' 2>&1 | tail -1)" "42"
}

# docker stop sends SIGTERM, then SIGKILL after 30 s; exit code 0 means
# PostgreSQL shut down by itself, without being killed.
check_shutdown() {
  docker stop -t 30 "$1" >/dev/null
  check "clean shutdown (exit code)" "$(docker inspect -f '{{.State.ExitCode}}' "$1")" "0"
}

echo "--- with TLS"
tls="$container_prefix-tls"
start "$tls" -e TLS_CERT_PEM="$(<"$tls_dir/postgres.crt")" -e TLS_KEY_PEM="$(<"$tls_dir/postgres.key")"
docker cp "$tls_dir/ca.crt" "$tls:/tmp/ca.crt"
# How OpenFGA connects: by the name in the certificate (host), here reached at
# the container's own address (hostaddr), checking that the certificate is
# signed by the CA and valid for that name (verify-full).
verified="host=demo-fga-postgres.internal hostaddr=127.0.0.1 sslmode=verify-full sslrootcert=/tmp/ca.crt"
check "TLS version" "$(sql "$tls" "$verified" 'SELECT version FROM pg_stat_ssl WHERE pid = pg_backend_pid()' 2>&1)" "TLSv1.3"
check_database "$tls" "$verified"
check "unencrypted connection refused" "$(sql "$tls" "host=127.0.0.1 sslmode=disable" 'SELECT 1' 2>&1 | grep -o 'no encryption' | head -1)" "no encryption"
check_shutdown "$tls"

echo "--- without TLS (INTERNAL_TLS=off)"
plain="$container_prefix-plain"
start "$plain"
check "TLS" "$(sql "$plain" "host=127.0.0.1 sslmode=disable" 'SHOW ssl' 2>&1)" "off"
check_database "$plain" "host=127.0.0.1 sslmode=disable"
check_shutdown "$plain"

if ((failures > 0)); then
  for name in "${containers[@]}"; do
    echo "--- log of $name" >&2
    docker logs "$name" 2>&1 | tail -40 >&2
  done
  exit 1
fi
