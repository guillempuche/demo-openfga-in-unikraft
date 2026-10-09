#!/bin/busybox sh
# Starts OpenFGA in the unikernel (the Kraftfile's cmd): `entrypoint.sh run`,
# or `entrypoint.sh migrate` for the one-off schema migration.
#
# OpenFGA reads TLS certificates only from files, but Unikraft instances get
# secrets through environment variables. When scripts/deploy.sh passes PEM
# text, this writes it to /tmp/tls (private to its owner) and points OpenFGA
# at the files:
#   TLS_CERT_PEM, TLS_KEY_PEM  OpenFGA's own certificate and key: its HTTP and
#                              gRPC servers accept only TLS.
#   TLS_CA_PEM                 The CA that signed PostgreSQL's certificate,
#                              which the datastore URI names as
#                              sslrootcert=/tmp/tls/ca.crt.
# Without them OpenFGA starts unchanged, in plain text (INTERNAL_TLS=off).
# Hosts that can mount files (Kubernetes or Docker secrets) don't need this
# script: they set OpenFGA's OPENFGA_HTTP_TLS_CERT and related settings to the
# file paths directly.
set -eu
dir=/tmp/tls
umask 077

if [ -n "${TLS_CERT_PEM:-}" ]; then
  : "${TLS_KEY_PEM:?TLS_CERT_PEM is set, but TLS_KEY_PEM is not}"
  /bin/busybox mkdir -p "$dir"
  printf '%s\n' "$TLS_CERT_PEM" >"$dir/openfga.crt"
  printf '%s\n' "$TLS_KEY_PEM" >"$dir/openfga.key"
  export OPENFGA_HTTP_TLS_ENABLED=true OPENFGA_HTTP_TLS_CERT="$dir/openfga.crt" OPENFGA_HTTP_TLS_KEY="$dir/openfga.key"
  export OPENFGA_GRPC_TLS_ENABLED=true OPENFGA_GRPC_TLS_CERT="$dir/openfga.crt" OPENFGA_GRPC_TLS_KEY="$dir/openfga.key"
fi
if [ -n "${TLS_CA_PEM:-}" ]; then
  /bin/busybox mkdir -p "$dir"
  printf '%s\n' "$TLS_CA_PEM" >"$dir/ca.crt"
fi

# The files are written; OpenFGA doesn't need the PEM text in its environment.
unset TLS_CERT_PEM TLS_KEY_PEM TLS_CA_PEM
exec /usr/bin/openfga "$@"
