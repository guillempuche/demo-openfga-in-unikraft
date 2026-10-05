#!/usr/bin/env bash
# Delete the demo instances: ./scripts/cleanup.sh [--volume] [--images] [--service] [--all]
#   --volume   also delete the postgres volume (drops the OpenFGA data)
#   --images   also delete the demo-fga-* images
#   --service  also delete the API's service group (its public URL is gone for good)
#   --all      all three
# Only ever touches names starting with demo-fga-.
. "$(dirname "$0")/env.sh"

volume=false
images=false
service=false
for arg in "$@"; do
  case "$arg" in
    --volume) volume=true ;;
    --images) images=true ;;
    --service) service=true ;;
    --all) volume=true; images=true; service=true ;;
    *) echo "usage: $0 [--volume] [--images] [--service] [--all]" >&2; exit 1 ;;
  esac
done

guard() {
  [[ "$1" == "$PREFIX"* || "$1" == "$UNIKRAFT_ORG/$PREFIX"* ]] || { echo "refusing to delete $1" >&2; exit 1; }
}

# Deletes that fail are reported and make the script exit non-zero at the end,
# so a leftover volume or image never looks like a clean run.
failures=0
fail() { echo "error: $*" >&2; failures=$((failures + 1)); }

for name in "$API_NAME" "$OPENFGA_NAME" "$MIGRATE_NAME" "$POSTGRES_NAME"; do
  guard "$name"
  if instance_exists "$name"; then
    unikraft instances delete "$name" -o quiet >/dev/null && echo "deleted $name" || fail "could not delete instance $name"
  else
    echo "$name: not found"
  fi
done

if $service; then
  guard "$API_SERVICE"
  if unikraft services get "$API_SERVICE" -f name -o json >/dev/null 2>&1; then
    unikraft services delete "$API_SERVICE" -o quiet >/dev/null && echo "deleted service group $API_SERVICE" ||
      fail "could not delete service group $API_SERVICE"
  else
    echo "$API_SERVICE: not found"
  fi
fi

if $volume; then
  guard "$POSTGRES_VOLUME"
  if unikraft volumes get "$POSTGRES_VOLUME" -f name -o json >/dev/null 2>&1; then
    # The volume detaches asynchronously after its instance is deleted.
    if unikraft volumes wait "$POSTGRES_VOLUME" --until state==available --timeout 2m -o quiet >/dev/null &&
      unikraft volumes delete "$POSTGRES_VOLUME" -o quiet >/dev/null; then
      echo "deleted volume $POSTGRES_VOLUME"
      # The store, and so the model the API pinned, went with the volume.
      rm -f "$MODEL_ID_FILE"
    else
      fail "could not delete volume $POSTGRES_VOLUME (still attached?)"
    fi
  else
    echo "$POSTGRES_VOLUME: not found"
  fi
fi

if $images; then
  for image in "$API_IMAGE" "$OPENFGA_IMAGE" "$POSTGRES_IMAGE"; do
    guard "$image"
    if unikraft images get "$image" -f ref -o json >/dev/null 2>&1; then
      unikraft images delete "$image" -o quiet >/dev/null && echo "deleted image $image" || fail "could not delete image $image"
    else
      echo "$image: not found"
    fi
  done
  # Metros keep cached copies (index.<metro>.unikraft.cloud/<org>/...) that
  # `images list` may still show for a while; they can't be deleted directly.
fi

if ((failures > 0)); then
  echo "cleanup finished with $failures error(s); check: unikraft instances list; unikraft volumes list" >&2
  exit 1
fi
