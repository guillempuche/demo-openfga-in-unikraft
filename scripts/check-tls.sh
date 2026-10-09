#!/usr/bin/env bash
# Check TLS on the deployed private network, from this machine, through
# short-lived tunnels to the instances:
#   ./scripts/check-tls.sh
#
# - OpenFGA, HTTP and gRPC ports: the TLS handshake verifies its certificate
#   against the CA for the instance's private name, over TLS 1.3; plain HTTP
#   is refused; when the certificate expires.
# - PostgreSQL: the same through its own TLS handshake (STARTTLS); an
#   unencrypted client is refused; every connection OpenFGA holds is
#   encrypted (pg_stat_ssl).
# - The API: /health reports OpenFGA "ok". Since OpenFGA refuses plain text,
#   the API can only get there over TLS, with the CA deploy.sh gave it.
#
# Needs OpenSSL 3 (macOS's LibreSSL lacks -starttls postgres) and psql:
# `nix develop` provides both. Each tunnel creates a relay instance while it's
# open; all of them close with one SIGTERM each, as in tunnel.sh.
. "$(dirname "$0")/env.sh"

if ! tls_on; then
  echo "INTERNAL_TLS=off: the private network uses plain text, nothing to check"
  exit 0
fi
require POSTGRES_PASSWORD FGA_KEY
check_certificates
openssl version | grep -q '^OpenSSL 3' || { echo "error: needs OpenSSL 3, found $(openssl version): run inside nix develop" >&2; exit 1; }
command -v psql >/dev/null || { echo "error: psql not found: run inside nix develop" >&2; exit 1; }

openfga_host="$OPENFGA_NAME.internal" postgres_host="$POSTGRES_NAME.internal"
http_port=19480 grpc_port=19481 pg_port=19432

pids=()
cleanup() {
  trap - EXIT INT TERM
  ((${#pids[@]} == 0)) || kill -TERM "${pids[@]}" 2>/dev/null
  wait
}
trap cleanup EXIT INT TERM
for spec in "$http_port:$UNIKRAFT_METRO/$OPENFGA_NAME:8080/tcp" "$grpc_port:$UNIKRAFT_METRO/$OPENFGA_NAME:8081/tcp" \
  "$pg_port:$UNIKRAFT_METRO/$POSTGRES_NAME:5432/tcp"; do
  unikraft instances tunnel "$spec" >/dev/null 2>&1 &
  pids+=("$!")
done
for port in $http_port $grpc_port $pg_port; do
  for _ in $(seq 1 60); do nc -z 127.0.0.1 "$port" 2>/dev/null && break; sleep 1; done
done
sleep 3 # the relays accept connections shortly after the local ports open

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

# The output of a TLS handshake with <port> as <server name>, verifying the
# certificate against the CA (and failing the handshake if it doesn't verify).
handshake() {
  local port="$1" name="$2"
  shift 2
  openssl s_client -connect "127.0.0.1:$port" -servername "$name" -verify_hostname "$name" \
    -CAfile "$TLS_CA_FILE" -verify_return_error "$@" </dev/null 2>/dev/null || true
}
# The checks every TLS port gets: verified certificate, TLS 1.3, expiry.
check_handshake() {
  local label="$1" out="$2"
  check "$label: certificate" "$(grep -o 'Verify return code: 0 (ok)' <<<"$out" | head -1)" "Verify return code: 0 (ok)"
  check "$label: protocol" "$(sed -n 's/^New, \(TLSv[0-9.]*\),.*/\1/p' <<<"$out" | head -1)" "TLSv1.3"
  if openssl x509 -noout -checkend $((30 * 86400)) <<<"$out" >/dev/null 2>&1; then
    echo "     $label: certificate valid until $(openssl x509 -noout -enddate <<<"$out" | cut -d= -f2)"
  else
    echo "FAIL $label: certificate expires within 30 days ($(openssl x509 -noout -enddate <<<"$out" 2>&1 | cut -d= -f2)): ./scripts/tls.sh --renew, then redeploy"
    failures=$((failures + 1))
  fi
}

echo "--- OpenFGA ($openfga_host)"
check_handshake "HTTP API" "$(handshake "$http_port" "$openfga_host" -alpn http/1.1)"
check "HTTP API: plain HTTP (status)" "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$http_port/healthz")" "400"
grpc="$(handshake "$grpc_port" "$openfga_host" -alpn h2)"
check_handshake "gRPC" "$grpc"
check "gRPC: application protocol" "$(grep -o 'ALPN protocol: h2' <<<"$grpc" | head -1)" "ALPN protocol: h2"

echo "--- PostgreSQL ($postgres_host)"
check_handshake "PostgreSQL" "$(handshake "$pg_port" "$postgres_host" -starttls postgres)"
refused="$(PGPASSWORD="$POSTGRES_PASSWORD" psql "host=127.0.0.1 port=$pg_port sslmode=disable user=openfga dbname=openfga connect_timeout=10" -c 'SELECT 1' 2>&1 || true)"
check "PostgreSQL: unencrypted connection" "$(grep -o 'no encryption' <<<"$refused" | head -1)" "no encryption"
# A call to OpenFGA makes it open a datastore connection (its idle ones close
# after 30 s). The key goes to curl through stdin, never the command line.
printf 'header = "Authorization: Bearer %s"\n' "$FGA_KEY" |
  curl -sS --max-time 10 --config - --cacert "$TLS_CA_FILE" --resolve "$openfga_host:$http_port:127.0.0.1" \
    "https://$openfga_host:$http_port/stores" -o /dev/null
# This session connects like OpenFGA does: by the private name, verify-full.
connections="$(PGPASSWORD="$POSTGRES_PASSWORD" psql "host=$postgres_host hostaddr=127.0.0.1 port=$pg_port sslmode=verify-full sslrootcert=$TLS_CA_FILE user=openfga dbname=openfga connect_timeout=10" -tAc \
  "SELECT count(*) FILTER (WHERE s.ssl) || ' of ' || count(*) || ' ' || coalesce(string_agg(DISTINCT s.version, ','), '')
   FROM pg_stat_activity a JOIN pg_stat_ssl s USING (pid)
   WHERE a.usename = 'openfga' AND a.backend_type = 'client backend' AND a.pid <> pg_backend_pid()" 2>&1)"
total="$(awk '{print $3}' <<<"$connections")"
check "PostgreSQL: OpenFGA's connections encrypted" "$connections" "${total:-?} of ${total:-?} TLSv1.3"

echo "--- API"
fqdn="$(unikraft services get "$API_SERVICE" -f domains -o json 2>/dev/null | jq -r '.[0].domains[0].fqdn // empty' || true)"
check "API health: OpenFGA" "$(curl -sS --max-time 15 "https://$fqdn/health" | jq -r .openfga)" "ok"

if ((failures > 0)); then
  echo "$failures check(s) failed" >&2
  exit 1
fi
