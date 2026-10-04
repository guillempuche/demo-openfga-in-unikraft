#!/usr/bin/env bash
# Exercise the public API and confirm OpenFGA and Postgres are not reachable
# from outside. Every check runs even if an earlier one fails; the script exits
# non-zero if any check failed.
. "$(dirname "$0")/env.sh"

failures=0
fail() { echo "FAIL: $*"; failures=$((failures + 1)); }

fqdn="$(unikraft instances get "$API_NAME" -f service.domains -o json 2>/dev/null | jq -r '.[0].service.domains[0].fqdn // empty' || true)"
if [[ -z "$fqdn" ]]; then
  echo "error: $API_NAME has no public domain (is it deployed?)" >&2
  exit 1
fi
api="https://$fqdn"
echo "API: $api"

# GET a path and print the body; record a failure instead of aborting.
get() {
  local body
  if body="$(curl -sS --fail-with-body --max-time "${2:-20}" "$api$1")"; then
    echo "$body"
  else
    fail "GET $1: ${body:-no response}"
  fi
}

echo "--- /health"
get /health
echo "--- /check (allowed)"
get "/check?user=user:alice&relation=can_edit&object=project:roadmap"
echo "--- /check (denied)"
get "/check?user=user:mallory&relation=can_edit&object=project:roadmap"
echo "--- /bench x3"
for _ in 1 2 3; do get /bench 60; done

echo "--- exposure of the private instances"
# A private instance has no service group: the CLI returns an empty object
# ({"uuid":"", ...}), so test the uuid rather than null.
for name in "$OPENFGA_NAME" "$POSTGRES_NAME"; do
  svc="$(unikraft instances get "$name" -f service -o json | jq -c '.[0].service')"
  if [[ "$(jq -r '.uuid // ""' <<<"$svc")" == "" ]]; then
    echo "$name: no service (private)"
  else
    fail "$name is published: $svc"
  fi
done
# Only the API may have a public domain in this deployment. Other demo-fga-*
# instances must not, and neither may tunnel relays (`utils/tunnel`): while a
# tunnel is open its relay is publicly addressable and forwards to OpenFGA.
# Unrelated workloads on a shared account are ignored.
while IFS=$'\t' read -r name image domains; do
  [[ -z "$name" ]] && continue
  if [[ "$name" == "$API_NAME" ]]; then
    echo "$name: public at $domains (expected)"
  elif [[ "$name" == "$PREFIX"* ]]; then
    fail "$name is public at $domains"
  elif [[ "$image" == utils/tunnel* ]]; then
    fail "tunnel relay $name is public at $domains; close open tunnels (scripts/tunnel.sh) and re-run"
  fi
done < <(unikraft instances list -f name,image,service.domains -o json |
  jq -r '.[] | select((.service.domains // []) | length > 0) | [.name, (.image // ""), ([.service.domains[].fqdn] | join(","))] | @tsv')
# Ports of OpenFGA (8080 HTTP, 8081 gRPC, 3000 playground, 2112 metrics) and
# postgres (5432) must not answer on the public load balancer either.
for port in 8080 8081 3000 2112 5432; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "https://$fqdn:$port/" 2>/dev/null || true)"
  if [[ "$code" == 000 || -z "$code" ]]; then
    echo "https://$fqdn:$port -> no answer"
  else
    fail "https://$fqdn:$port answered HTTP $code"
  fi
done

if ((failures > 0)); then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all checks passed"
