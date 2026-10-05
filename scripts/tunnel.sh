#!/usr/bin/env bash
# Forward local ports to the private OpenFGA instance:
#   localhost:$TUNNEL_PORT          -> 8080 (HTTP API)
#   localhost:$TUNNEL_GRPC_PORT     -> 8081 (gRPC)
#   localhost:$TUNNEL_METRICS_PORT  -> 2112 (Prometheus metrics)
# Runs in the foreground; Ctrl-C closes all of them. Each tunnel creates a
# short-lived, publicly addressable relay instance (128MiB) while it's open.
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
for spec in "$TUNNEL_PORT:$target:8080/tcp" "$TUNNEL_GRPC_PORT:$target:8081/tcp" "$TUNNEL_METRICS_PORT:$target:2112/tcp"; do
  unikraft instances tunnel "$spec" &
  pids+=("$!")
done
wait
