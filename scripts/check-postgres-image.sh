#!/usr/bin/env bash
# Check the PostgreSQL image that OpenFGA uses on Unikraft Cloud, before it is
# deployed: build its root file system (infrastructure/unikraft/postgres), start
# it with the Kraftfile's own command as a brand-new database, as on the first
# deploy, and check the PostgreSQL version, that the scale-to-zero extension is
# loaded, that a write can be read back, and that it shuts down cleanly.
#   ./scripts/check-postgres-image.sh [--no-build]   (--no-build: reuse the last build)
#
# It runs the image as a Docker container (x86-64; emulated on Apple Silicon),
# not as a unikernel, so it needs no Unikraft account: it doesn't source env.sh
# and uses no secrets. CI runs it whenever the image changes.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
postgres_dir="$root/infrastructure/unikraft/postgres"
image="demo-fga-postgres-rootfs:check"
# $$ (this script's process ID) gives each run its own container.
container="demo-fga-postgres-check-$$"

if [[ "${1:-}" != --no-build ]]; then
  docker build --platform linux/amd64 --tag "$image" "$postgres_dir"
fi

# The expected version is the text after "ARG PG_VERSION=" in the Dockerfile.
# The Kraftfile's "cmd:" line is a JSON array: jq prints one element per line
# and mapfile reads each line into one element of a bash array.
expected_version="$(sed -n 's/^ARG PG_VERSION=//p' "$postgres_dir/Dockerfile")"
mapfile -t kraftfile_cmd < <(sed -n 's/^cmd: //p' "$postgres_dir/Kraftfile" | jq -r '.[]')
[[ -n "$expected_version" && ${#kraftfile_cmd[@]} -gt 0 ]] || { echo "error: no PG_VERSION in the Dockerfile or no cmd in the Kraftfile" >&2; exit 1; }

cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Same environment as scripts/deploy.sh, with a throwaway password.
docker run -d --name "$container" --platform linux/amd64 \
  -e POSTGRES_USER=openfga -e POSTGRES_DB=openfga -e POSTGRES_PASSWORD=check -e PGDATA=/volume/postgres \
  "$image" "${kraftfile_cmd[@]}" >/dev/null

# Run one SQL statement and print only the values (-tA: no headers, no padding).
sql() { docker exec -e PGPASSWORD=check "$container" psql -h 127.0.0.1 -U openfga -d openfga -v ON_ERROR_STOP=1 -tAc "$1"; }

# Wait for the server: up to 120 tries, a second apart. If it never answers,
# the checks below fail and print its log. Over TCP: during initialisation the
# wrapper runs a temporary server on the Unix socket only, so a TCP answer
# means the real server is up.
for _ in $(seq 1 120); do
  docker exec "$container" pg_isready -q -h 127.0.0.1 -U openfga -d openfga && break
  sleep 1
done

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

# 2>&1: when a query fails, its error message is shown as the result.
check "server version" "$(sql 'SHOW server_version' 2>&1)" "$expected_version"
check "preloaded extension" "$(sql 'SHOW shared_preload_libraries' 2>&1)" "pg_ukc_scaletozero"
# psql prints each statement's status (CREATE TABLE, INSERT 0 1) before the
# SELECT's value, so the value is the last line.
check "write and read" "$(sql 'CREATE TABLE check_rw (n int); INSERT INTO check_rw VALUES (42); SELECT n FROM check_rw' 2>&1 | tail -1)" "42"

# docker stop sends SIGTERM, then SIGKILL after 30 s; exit code 0 means
# PostgreSQL shut down by itself, without being killed.
docker stop -t 30 "$container" >/dev/null
check "clean shutdown (exit code)" "$(docker inspect -f '{{.State.ExitCode}}' "$container")" "0"

if ((failures > 0)); then
  echo "--- container log" >&2
  docker logs "$container" 2>&1 | tail -40 >&2
  exit 1
fi
