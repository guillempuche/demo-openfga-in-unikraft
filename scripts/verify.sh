#!/usr/bin/env bash
# Exercise the public API and confirm OpenFGA is not reachable from outside.
. "$(dirname "$0")/env.sh"

fqdn="$(unikraft instances get "$API_NAME" -f service.domains -o json | jq -r '.[0].service.domains[0].fqdn')"
api="https://$fqdn"
echo "API: $api"

echo "--- /health"
curl -sS --max-time 20 "$api/health"; echo
echo "--- /check (allowed)"
curl -sS --max-time 20 "$api/check?user=user:alice&relation=can_edit&object=project:roadmap"; echo
echo "--- /check (denied)"
curl -sS --max-time 20 "$api/check?user=user:mallory&relation=can_edit&object=project:roadmap"; echo
echo "--- /bench x3"
for _ in 1 2 3; do curl -sS --max-time 60 "$api/bench"; echo; done

echo "--- OpenFGA exposure"
echo "services attached to $OPENFGA_NAME:"
unikraft instances get "$OPENFGA_NAME" -f service -o json | jq -c '.[0].service // "none"'
# OpenFGA ports must not answer on the public load balancer (the API's FQDN
# is the only public name in this deployment).
for port in 8080 8081 3000 2112; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "https://$fqdn:$port/" 2>/dev/null || true)"
  echo "https://$fqdn:$port -> ${code:-no answer}"
done
