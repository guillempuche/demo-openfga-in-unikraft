#!/usr/bin/env bash
# Create the certificates that encrypt the private network between the API,
# OpenFGA and PostgreSQL with TLS (the protocol behind HTTPS):
#   ./scripts/tls.sh [--renew | --new-ca] [--out DIR]   (default DIR: .cache/tls)
#
# - ca.crt / ca.key: a private certificate authority (CA). Clients trust
#   ca.crt; ca.key signs the server certificates and never leaves this machine.
# - postgres.crt / postgres.key: valid only for demo-fga-postgres.internal.
# - openfga.crt / openfga.key: valid for demo-fga-openfga.internal, and for
#   localhost, which OpenFGA's HTTP server uses to reach its own gRPC server.
#
# Running it again keeps existing files. --renew issues new server
# certificates from the same CA (clients keep trusting them); --new-ca replaces
# everything. Then redeploy (cleanup.sh, deploy.sh) so the services load them.
#
# Bringing your own certificates (a company CA, Vault, step-ca, cert-manager):
# skip this script and set TLS_CA_FILE, POSTGRES_TLS_CERT_FILE, ... in .env to
# your PEM files (see .env.example). The names they must be valid for are the
# two hostnames above, or TLS_POSTGRES_HOST / TLS_OPENFGA_HOST if you renamed
# the instances.
#
# Works with OpenSSL 3 and with LibreSSL (macOS's openssl). It doesn't source
# env.sh, so CI and the local Compose stacks can run it without a Unikraft
# account.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/.cache/tls"
mode=keep
while (($# > 0)); do
  case "$1" in
    --renew) mode=renew ;;
    --new-ca) mode=new-ca ;;
    --out) out="$2"; shift ;;
    *) echo "usage: $0 [--renew | --new-ca] [--out DIR]" >&2; exit 1 ;;
  esac
  shift
done

postgres_host="${TLS_POSTGRES_HOST:-demo-fga-postgres.internal}"
openfga_host="${TLS_OPENFGA_HOST:-demo-fga-openfga.internal}"
ca_days=1825    # 5 years
server_days=365 # check-tls.sh warns 30 days before a certificate expires

# Private keys are readable by the owner only; certificates by anyone.
umask 077
mkdir -p "$out"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# ECDSA P-256 keys: small, fast and supported by OpenSSL (PostgreSQL), Go
# (OpenFGA) and Node.js (the API). `ecparam -genkey` is used rather than
# `genpkey` because LibreSSL's genpkey writes the curve as explicit parameters,
# which OpenSSL 3, Go and Node.js reject.
new_key() { openssl ecparam -name prime256v1 -genkey -noout -out "$1" 2>/dev/null; }

if [[ "$mode" == new-ca || ! -f "$out/ca.crt" || ! -f "$out/ca.key" ]]; then
  new_key "$out/ca.key"
  openssl req -x509 -new -key "$out/ca.key" -sha256 -days "$ca_days" \
    -subj "/CN=demo-fga internal CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash" \
    -out "$out/ca.crt" 2>/dev/null
  chmod 644 "$out/ca.crt"
  echo "created the CA: $out/ca.crt (valid $ca_days days)"
  mode=new-ca # a new CA invalidates every server certificate
fi

# Issue <name>.crt/.key for the subject alternative names (SANs) given, the
# names a client checks the certificate against.
issue() {
  local name="$1" sans="$2"
  if [[ "$mode" == keep && -f "$out/$name.crt" && -f "$out/$name.key" ]]; then
    echo "kept $out/$name.crt"
    return
  fi
  new_key "$out/$name.key"
  openssl req -new -key "$out/$name.key" -subj "/CN=${sans%%,*}" -out "$work/$name.csr" 2>/dev/null
  # A server certificate (serverAuth) that can't sign other certificates.
  printf '%s\n' \
    "basicConstraints=critical,CA:FALSE" \
    "keyUsage=critical,digitalSignature" \
    "extendedKeyUsage=serverAuth" \
    "subjectKeyIdentifier=hash" \
    "authorityKeyIdentifier=keyid" \
    "subjectAltName=$sans" >"$work/$name.ext"
  openssl x509 -req -in "$work/$name.csr" -CA "$out/ca.crt" -CAkey "$out/ca.key" \
    -set_serial "0x$(openssl rand -hex 16)" -days "$server_days" -sha256 \
    -extfile "$work/$name.ext" -out "$out/$name.crt" 2>/dev/null
  chmod 644 "$out/$name.crt"
  openssl verify -CAfile "$out/ca.crt" "$out/$name.crt" >/dev/null
  echo "issued $out/$name.crt for ${sans//DNS:/} (valid $server_days days)"
}

issue postgres "DNS:$postgres_host"
issue openfga "DNS:$openfga_host,DNS:localhost,IP:127.0.0.1"
