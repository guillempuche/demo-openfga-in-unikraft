#!/usr/bin/env bash
# Fail if any pinned OpenFGA or fga CLI version disagrees with versions.env.
# The server version must match everywhere it runs or is read: the unikernel
# Dockerfile, the local compose stack, the fga CLI's embedded engine (used by
# `fga model test`), and the vendored reference sources in docs/repos.
#
# Doesn't source env.sh: it needs no Unikraft profile or secrets.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
. "$root/versions.env"

failures=0
expect() { # <description> <actual> <expected>
  if [[ "$2" == "$3" ]]; then
    echo "ok   $1: $2"
  else
    echo "FAIL $1: found '${2:-<none>}', expected '$3'"
    failures=$((failures + 1))
  fi
}

# The unikernel copies the binary out of the official image, pinned by digest:
# an unpinned tag doesn't match and fails the check.
expect "unikernel Dockerfile openfga/openfga tag (pinned by digest)" \
  "$(sed -n 's#^FROM .*openfga/openfga:\(v[0-9][^@ ]*\)@sha256:[0-9a-f]\{64\}\( .*\)\{0,1\}$#\1#p' "$root/infrastructure/unikraft/openfga/Dockerfile")" "$OPENFGA_VERSION"

for compose in authz/docker-compose.yaml tests/integration/docker-compose.yaml; do
  while read -r tag; do
    expect "$compose image" "$tag" "$OPENFGA_VERSION"
  done < <(sed -n 's#^ *image: openfga/openfga:##p' "$root/$compose")
done

while read -r v; do
  expect "CI FGA_VERSION" "$v" "$FGA_CLI_VERSION"
done < <(sed -n 's/^ *FGA_VERSION: \([^ ]*\).*/\1/p' "$root/.github/workflows/ci.yml")

expect "flake.nix fga CLI" \
  "$(sed -n 's/^ *fgaVersion = "\([^"]*\)";/\1/p' "$root/flake.nix")" "$FGA_CLI_VERSION"

expect "fga CLI $FGA_CLI_VERSION embedded OpenFGA (docs/repos/cli/go.mod)" \
  "$(sed -n 's#^[[:space:]]*github.com/openfga/openfga \(v[^ ]*\).*#\1#p' "$root/docs/repos/cli/go.mod")" "$OPENFGA_VERSION"

expect "vendored docs/repos/openfga ref" \
  "$(sed -n 's/^| `openfga\/` | .* | `\(v[^`]*\)` |$/\1/p' "$root/docs/repos/README.md")" "$OPENFGA_VERSION"

expect "vendored docs/repos/cli ref" \
  "$(sed -n 's/^| `cli\/` | .* | `v\([^`]*\)` |$/\1/p' "$root/docs/repos/README.md")" "$FGA_CLI_VERSION"

if ((failures > 0)); then
  echo "$failures version mismatch(es); update them to match versions.env" >&2
  exit 1
fi
