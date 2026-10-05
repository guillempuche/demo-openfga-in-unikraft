#!/usr/bin/env bash
# Build and push the unikernel images: ./scripts/build.sh [postgres|openfga|api|all]
#
# Builds to a local OCI archive first and then pushes it with `images copy`.
# A direct `unikraft build --output <org>/<image>` streams the base-compat
# runtime from S3 into the registry upload; on slow or VPN links S3 resets that
# connection ("failed to package kernel ... connection reset by peer"). The
# two-step flow downloads at full speed and only uploads afterwards.
. "$(dirname "$0")/env.sh"

target="${1:-all}"
outdir="$(mktemp -d)"
trap 'rm -rf "$outdir"' EXIT

build_push() {
  local name="$1" dir="$2" image="$3"
  echo "==> building $name ($dir)"
  unikraft build "$dir" --output "$outdir/$name.oci.tar"
  # The archive's index digest is the image's digest in the registry too.
  local digest
  digest="$(tar -xOf "$outdir/$name.oci.tar" index.json | jq -r '.manifests[0].digest')"
  echo "==> pushing unikraft.io/$image ($digest)"
  unikraft images copy "$outdir/$name.oci.tar" "unikraft.io/$image"
  if [[ "$(registry_digest "$image")" != "$digest" ]]; then
    echo "error: the registry doesn't list $image at $digest after the push" >&2
    exit 1
  fi
  # deploy.sh runs this digest from now on (see DIGESTS_FILE in env.sh).
  record_digest "$image" "$digest"
  # Archives are large (the postgres one is several hundred MB); free the space
  # before building the next image.
  rm -f "$outdir/$name.oci.tar"
}

case "$target" in
  postgres | openfga | api | all) ;;
  *) echo "usage: $0 [postgres|openfga|api|all]" >&2; exit 1 ;;
esac

if [[ "$target" == postgres || "$target" == all ]]; then
  build_push postgres "$ROOT/infrastructure/unikraft/postgres" "$POSTGRES_IMAGE"
fi
if [[ "$target" == openfga || "$target" == all ]]; then
  build_push openfga "$ROOT/infrastructure/unikraft/openfga" "$OPENFGA_IMAGE"
fi
if [[ "$target" == api || "$target" == all ]]; then
  build_push api "$ROOT/api" "$API_IMAGE"
fi
