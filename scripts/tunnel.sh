#!/usr/bin/env bash
# Forward local ports to the private OpenFGA instance:
#   localhost:$TUNNEL_PORT          -> 8080 (HTTP API)
#   localhost:$TUNNEL_GRPC_PORT     -> 8081 (gRPC)
#   localhost:$TUNNEL_METRICS_PORT  -> 2112 (Prometheus metrics)
# Runs in the foreground; Ctrl-C closes all of them. Each tunnel creates a
# short-lived, publicly addressable relay instance (128MiB) while it's open.
#
# With TLS on (INTERNAL_TLS, see env.sh), OpenFGA's HTTP and gRPC ports accept
# only TLS. Their tunnels then listen on $TUNNEL_TLS_PORT and
# $TUNNEL_TLS_GRPC_PORT and carry TLS end to end, and tls-forward.mjs serves
# the two ports above in plain text on the loopback interface, checking
# OpenFGA's certificate. So the fga CLI and the test scripts keep using
# http://localhost:$TUNNEL_PORT, and only that local hop is unencrypted.
# Metrics stay plain HTTP: OpenFGA has no TLS for them.
#
# One `unikraft instances tunnel` process per port: with unikraft CLI 0.5.2, a
# third target in a single tunnel command fails ("internal tunnel error").
. "$(dirname "$0")/env.sh"

target="$UNIKRAFT_METRO/$OPENFGA_NAME"
pids=()
# Stop the tunnels with exactly one SIGTERM: the CLI then deletes its relay
# instance. A second signal during that cleanup leaves the relay running (and
# publicly addressable), so the handler disarms itself first. (SIGINT doesn't
# work: background jobs of a script ignore it.)
cleanup() {
  trap - EXIT INT TERM
  kill -TERM "${pids[@]}" 2>/dev/null
  wait
}
trap cleanup EXIT INT TERM

if tls_on; then
  check_certificates
  http_port="$TUNNEL_TLS_PORT" grpc_port="$TUNNEL_TLS_GRPC_PORT"
else
  http_port="$TUNNEL_PORT" grpc_port="$TUNNEL_GRPC_PORT"
fi
for spec in "$http_port:$target:8080/tcp" "$grpc_port:$target:8081/tcp" "$TUNNEL_METRICS_PORT:$target:2112/tcp"; do
  unikraft instances tunnel "$spec" &
  pids+=("$!")
done
if tls_on; then
  node "$ROOT/scripts/tls-forward.mjs" "$TUNNEL_PORT" "$TUNNEL_TLS_PORT" "$OPENFGA_NAME.internal" "$TLS_CA_FILE" http/1.1 &
  pids+=("$!")
  node "$ROOT/scripts/tls-forward.mjs" "$TUNNEL_GRPC_PORT" "$TUNNEL_TLS_GRPC_PORT" "$OPENFGA_NAME.internal" "$TLS_CA_FILE" h2 &
  pids+=("$!")
fi
wait
