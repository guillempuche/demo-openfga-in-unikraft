#!/usr/bin/env bash
# Rehearse the deployment's private network locally, with TLS on both hops,
# and check every link of the chain: API -> OpenFGA -> PostgreSQL.
#   ./scripts/check-tls-chain.sh
#
# Starts tests/tls-chain/docker-compose.yaml: the API and OpenFGA images that
# ship, given their certificates as scripts/deploy.sh gives them, under the
# instances' private names. Then checks that:
# - OpenFGA migrates and connects to PostgreSQL verifying its certificate, and
#   every one of its connections is encrypted;
# - OpenFGA serves HTTP and gRPC over TLS only (plain text and an unknown CA
#   are refused);
# - the API reaches OpenFGA over TLS and answers a real check, end to end.
#
# Like check-postgres-image.sh it uses Docker only, with throwaway
# certificates and passwords: no Unikraft account (it doesn't source env.sh).
# CI runs it on every change.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose=(docker compose -f "$root/tests/tls-chain/docker-compose.yaml")
openfga_port=38080 grpc_port=38081 api_port=38088

# Throwaway certificates, plus an unrelated CA for the negative checks.
tls_dir="$(mktemp -d)"
other_dir="$(mktemp -d)"
cleanup() {
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$tls_dir" "$other_dir"
}
trap cleanup EXIT
"$root/scripts/tls.sh" --out "$tls_dir" >/dev/null
"$root/scripts/tls.sh" --out "$other_dir" >/dev/null
# Docker must be able to read the mounted directory (mktemp makes it 0700).
chmod 755 "$tls_dir"

# The compose file reads these: the certificate directory PostgreSQL mounts,
# and the PEM text the OpenFGA and API containers get as environment variables.
export TLS_DIR="$tls_dir"
TLS_CA_PEM="$(<"$tls_dir/ca.crt")"
OPENFGA_TLS_CERT_PEM="$(<"$tls_dir/openfga.crt")"
OPENFGA_TLS_KEY_PEM="$(<"$tls_dir/openfga.key")"
export TLS_CA_PEM OPENFGA_TLS_CERT_PEM OPENFGA_TLS_KEY_PEM

"${compose[@]}" up -d --build --wait

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

# Reach OpenFGA from this machine by its private name (--resolve maps it to
# the published port), checking its certificate against <ca file>.
openfga() { # <ca file> <path> [curl options]
  local ca="$1" path="$2"
  shift 2
  curl -sS --max-time 10 --cacert "$ca" --resolve "demo-fga-openfga.internal:$openfga_port:127.0.0.1" \
    -H "Authorization: Bearer chain-key" "$@" "https://demo-fga-openfga.internal:$openfga_port$path"
}

# OpenFGA starts after the migration; wait until it serves (up to 60 s).
for _ in $(seq 1 60); do
  [[ "$(openfga "$tls_dir/ca.crt" /healthz 2>/dev/null | jq -r .status 2>/dev/null)" == SERVING ]] && break
  sleep 1
done

check "migration (exit code)" "$("${compose[@]}" ps -a --format json migrate | jq -r '.ExitCode')" "0"

echo "--- OpenFGA over TLS"
check "HTTPS health" "$(openfga "$tls_dir/ca.crt" /healthz | jq -r .status)" "SERVING"
check "HTTPS with an unknown CA" "$(openfga "$other_dir/ca.crt" /healthz 2>&1 | grep -o 'SSL certificate problem' | head -1)" "SSL certificate problem"
check "plain HTTP (status)" "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$openfga_port/healthz")" "400"
# gRPC is HTTP/2 over TLS: the handshake must verify and agree on h2 (ALPN).
grpc_handshake="$(openssl s_client -connect "127.0.0.1:$grpc_port" -servername demo-fga-openfga.internal \
  -CAfile "$tls_dir/ca.crt" -verify_return_error -alpn h2 </dev/null 2>/dev/null || true)"
check "gRPC TLS (verify)" "$(grep -o 'Verify return code: 0 (ok)' <<<"$grpc_handshake" | head -1)" "Verify return code: 0 (ok)"
check "gRPC TLS (protocol)" "$(grep -o 'ALPN protocol: h2' <<<"$grpc_handshake" | head -1)" "ALPN protocol: h2"

echo "--- API -> OpenFGA"
# A store named demo-fga (the API's default) with a one-relation model and one
# tuple, written over TLS, so the API's check travels the whole chain.
store="$(openfga "$tls_dir/ca.crt" /stores -X POST -d '{"name":"demo-fga"}' | jq -r .id)"
openfga "$tls_dir/ca.crt" "/stores/$store/authorization-models" -X POST -d '{
  "schema_version": "1.1",
  "type_definitions": [
    {"type": "user"},
    {"type": "project", "relations": {"can_edit": {"this": {}}},
     "metadata": {"relations": {"can_edit": {"directly_related_user_types": [{"type": "user"}]}}}}
  ]}' >/dev/null
openfga "$tls_dir/ca.crt" "/stores/$store/write" -X POST \
  -d '{"writes": {"tuple_keys": [{"user": "user:alice", "relation": "can_edit", "object": "project:roadmap"}]}}' >/dev/null
for _ in $(seq 1 30); do
  curl -fsS --max-time 5 "http://127.0.0.1:$api_port/health" >/dev/null 2>&1 && break
  sleep 1
done
check "API health: OpenFGA" "$(curl -sS --max-time 10 "http://127.0.0.1:$api_port/health" | jq -r .openfga)" "ok"
check "API check, end to end" "$(curl -sS --max-time 10 "http://127.0.0.1:$api_port/check?user=user:alice&relation=can_edit&object=project:roadmap" | jq -r .allowed)" "true"

echo "--- OpenFGA -> PostgreSQL"
# psql inside the container connects over the Unix socket; the query counts
# the other connections of the openfga user, which OpenFGA's pool holds open
# after the check above.
pg() { "${compose[@]}" exec -T postgres psql -U openfga -d openfga -tAc "$1"; }
openfga_connections="FROM pg_stat_ssl JOIN pg_stat_activity USING (pid) WHERE usename = 'openfga' AND pid <> pg_backend_pid()"
total="$(pg "SELECT count(*) $openfga_connections")"
encrypted="$(pg "SELECT count(*) $openfga_connections AND ssl")"
check "OpenFGA's connections that use TLS" "$encrypted of $total" "$total of $total"
check "OpenFGA has connections open" "$([[ "$total" -gt 0 ]] && echo yes || echo no)" "yes"
# Over TCP without TLS, as an unencrypted client on the network would connect.
refused="$("${compose[@]}" exec -T postgres psql "host=127.0.0.1 sslmode=disable user=openfga dbname=openfga" -c 'SELECT 1' 2>&1 || true)"
check "unencrypted connection to PostgreSQL" "$(grep -o 'no encryption' <<<"$refused" | head -1)" "no encryption"

if ((failures > 0)); then
  "${compose[@]}" logs --tail 40 >&2
  exit 1
fi
