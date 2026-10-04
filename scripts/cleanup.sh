#!/usr/bin/env bash
# Delete the demo instances: ./scripts/cleanup.sh [--volume] [--images] [--all]
#   --volume  also delete the postgres volume (drops the OpenFGA data)
#   --images  also delete the demo-fga-* images
#   --all     both
# Only ever touches names starting with demo-fga-.
. "$(dirname "$0")/env.sh"

volume=false
images=false
for arg in "$@"; do
  case "$arg" in
    --volume) volume=true ;;
    --images) images=true ;;
    --all) volume=true; images=true ;;
    *) echo "usage: $0 [--volume] [--images] [--all]" >&2; exit 1 ;;
  esac
done

guard() {
  [[ "$1" == "$PREFIX"* || "$1" == "$UNIKRAFT_ORG/$PREFIX"* ]] || { echo "refusing to delete $1" >&2; exit 1; }
}

for name in "$API_NAME" "$OPENFGA_NAME" "$MIGRATE_NAME" "$POSTGRES_NAME"; do
  guard "$name"
  if instance_exists "$name"; then
    unikraft instances delete "$name" -o quiet && echo "deleted $name"
  else
    echo "$name: not found"
  fi
done

if $volume; then
  guard "$POSTGRES_VOLUME"
  # The volume detaches asynchronously after its instance is deleted.
  unikraft instances wait "$POSTGRES_NAME" --until state==deleted --timeout 1m -o quiet 2>/dev/null || true
  unikraft volumes delete "$POSTGRES_VOLUME" || true
fi

if $images; then
  for image in "$API_IMAGE" "$OPENFGA_IMAGE" "$POSTGRES_IMAGE"; do
    guard "$image"
    unikraft images delete "$image" || true
  done
fi
