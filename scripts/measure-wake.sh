#!/usr/bin/env bash
# Measure how long the public API takes to answer when woken from standby
# (scale-to-zero), compared with an already running instance.
#   ./scripts/measure-wake.sh [runs]   (default 10)
# Each run waits for the API to go to standby, then times GET /health from a
# fresh connection, then once more while it's running. /health includes a call
# to OpenFGA, which is never in standby (scale-to-zero off).
. "$(dirname "$0")/env.sh"

export LC_ALL=C # curl prints decimal points; printf must parse them in any locale
runs="${1:-10}"
[[ "$runs" =~ ^[1-9][0-9]*$ ]] || { echo "usage: $0 [runs]" >&2; exit 1; }

fqdn="$(unikraft instances get "$API_NAME" -f service.domains -o json 2>/dev/null | jq -r '.[0].service.domains[0].fqdn // empty' || true)"
[[ -n "$fqdn" ]] || { echo "error: $API_NAME has no public domain (is it deployed?)" >&2; exit 1; }
url="https://$fqdn/health"

state() { unikraft instances get "$API_NAME" -f state -o json | jq -r '.[0].state'; }
wait_standby() {
  for _ in $(seq 1 60); do
    [[ "$(state)" == standby ]] && return 0
    sleep 2
  done
  return 1
}
# Seconds to first response byte and total, from a new connection (TLS included).
timed() { curl -sS -o /dev/null --max-time 30 -w '%{time_starttransfer} %{time_total}\n' "$url"; }

cold=() warm=()
for i in $(seq 1 "$runs"); do
  wait_standby || { echo "error: $API_NAME didn't go to standby within 2 minutes" >&2; exit 1; }
  read -r _ c < <(timed)
  read -r _ w < <(timed)
  cold+=("$c") warm+=("$w")
  printf 'run %2d: from standby %.3f s, running %.3f s\n' "$i" "$c" "$w"
done

stats() { printf '%s\n' "$@" | sort -n | awk '{v[NR]=$1} END {printf "min %.3f  p50 %.3f  max %.3f s", v[1], v[int((NR+1)/2)], v[NR]}'; }
echo "from standby: $(stats "${cold[@]}")"
echo "running:      $(stats "${warm[@]}")"
