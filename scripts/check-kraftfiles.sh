#!/usr/bin/env bash
# Fail if a Kraftfile bakes a secret into its image: `env:` values end up in the
# image config, which anyone with registry access can read. Secrets are passed
# at run time by scripts/deploy.sh instead.
#
# Doesn't source env.sh: it needs no Unikraft profile or secrets.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
failures=0
while IFS= read -r kraftfile; do
  # Keys of the top-level `env:` block (indented `KEY: value` lines after it).
  while IFS= read -r key; do
    if [[ "$key" =~ (KEY|PASSWORD|SECRET|TOKEN|URI|CREDENTIAL) ]]; then
      echo "FAIL ${kraftfile#"$root"/}: env $key looks like a secret; pass it at run time (scripts/deploy.sh)"
      failures=$((failures + 1))
    else
      echo "ok   ${kraftfile#"$root"/}: env $key"
    fi
  done < <(awk '/^env:/ {in_env = 1; next} in_env && /^[^[:space:]#]/ {in_env = 0} in_env && /^[[:space:]]+[A-Za-z_][A-Za-z0-9_]*:/ {sub(/^[[:space:]]+/, ""); sub(/:.*/, ""); print}' "$kraftfile")
done < <(find "$root/api" "$root/infrastructure" -name Kraftfile -not -path '*/node_modules/*')

if ((failures > 0)); then
  exit 1
fi
