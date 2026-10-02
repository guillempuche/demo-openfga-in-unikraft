#!/usr/bin/env bash
# Forward localhost:$TUNNEL_PORT to the private OpenFGA instance (port 8080).
# Runs in the foreground; Ctrl-C closes it. The CLI creates a short-lived relay
# instance for the duration of the tunnel.
. "$(dirname "$0")/env.sh"

exec unikraft instances tunnel "$TUNNEL_PORT:$UNIKRAFT_METRO/$OPENFGA_NAME:8080/tcp"
