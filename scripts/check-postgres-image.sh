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
dir="$root/infrastructure/unikraft/postgres"
image="demo-fga-postgres-rootfs:check"
container="demo-fga-postgres-check-$$"

if [[ "${1:-}" != --no-build ]]; then
  docker build --platform linux/amd64 --tag "$image" "$dir"
fi

version="$(sed -n 's/^ARG PG_VERSION=//p' "$dir/Dockerfile")"
mapfile -t cmd < <(sed -n 's/^cmd: //p' "$dir/Kraftfile" | jq -r '.[]')
[[ -n "$version" && ${#cmd[@]} -gt 0 ]] || { echo "error: no PG_VERSION in the Dockerfile or no cmd in the Kraftfile" >&2; exit 1; }

cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Same environment as scripts/deploy.sh, with a throwaway password.
docker run -d --name "$container" --platform linux/amd64 \
  -e POSTGRES_USER=openfga -e POSTGRES_DB=openfga -e POSTGRES_PASSWORD=check -e PGDATA=/volume/postgres \
  "$image" "${cmd[@]}" >/dev/null

# Over TCP: during initialisation the wrapper runs a temporary server on the
# Unix socket only, so a TCP answer means the real server is up.
sql() { docker exec -e PGPASSWORD=check "$container" psql -h 127.0.0.1 -U openfga -d openfga -v ON_ERROR_STOP=1 -tAc "$1"; }
for _ in $(seq 1 120); do
  docker exec "$container" pg_isready -q -h 127.0.0.1 -U openfga -d openfga && break
  sleep 1
done

failures=0
check() { # <description> <actual> <expected>
  if [[ "$2" == "$3" ]]; then
    echo "ok   $1: $2"
  else
    echo "FAIL $1: got '${2}', expected '$3'"
    failures=$((failures + 1))
  fi
}

check "server version" "$(sql 'SHOW server_version' 2>&1)" "$version"
check "preloaded extension" "$(sql 'SHOW shared_preload_libraries' 2>&1)" "pg_ukc_scaletozero"
check "write and read" "$(sql 'CREATE TABLE check_rw (n int); INSERT INTO check_rw VALUES (42); SELECT n FROM check_rw' 2>&1 | tail -1)" "42"

docker stop -t 30 "$container" >/dev/null
check "clean shutdown (exit code)" "$(docker inspect -f '{{.State.ExitCode}}' "$container")" "0"

if ((failures > 0)); then
  echo "--- container log" >&2
  docker logs "$container" 2>&1 | tail -40 >&2
  exit 1
fi
