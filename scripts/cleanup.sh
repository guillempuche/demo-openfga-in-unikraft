#!/usr/bin/env bash
# Delete the demo instances (and, with --images, their images).
# Only ever touches names starting with demo-fga-.
. "$(dirname "$0")/env.sh"

for name in "$API_NAME" "$OPENFGA_NAME"; do
  [[ "$name" == "$PREFIX"* ]] || { echo "refusing to delete $name" >&2; exit 1; }
  if instance_exists "$name"; then
    unikraft instances delete "$name"
  else
    echo "$name: not found"
  fi
done

if [[ "${1:-}" == "--images" ]]; then
  for image in "$API_IMAGE" "$OPENFGA_IMAGE"; do
    [[ "$image" == "$UNIKRAFT_ORG/$PREFIX"* ]] || { echo "refusing to delete $image" >&2; exit 1; }
    unikraft images delete "$image" || true
  done
fi
