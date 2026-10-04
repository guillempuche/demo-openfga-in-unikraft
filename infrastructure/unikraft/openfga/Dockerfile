# Go toolchain required by OpenFGA v1.21.0 (go.mod: go 1.25.7, toolchain go1.26.8).
ARG GO_VERSION=1.26.8
# Compile on the build host's native platform and cross-compile to the target
# architecture; much faster than building under amd64 emulation.
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-bookworm AS build

# Keep in sync with versions.env (checked by scripts/check-versions.sh).
ARG OPENFGA_VERSION=v1.21.0
ARG TARGETARCH=amd64

# Simple static build for Unikraft base-compat runtime
# See: https://unikraft.org/docs/concepts/compatibility
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth=1 --branch ${OPENFGA_VERSION} https://github.com/openfga/openfga.git
WORKDIR /src/openfga

# Build static binary using pure Go (no CGO)
# - CGO_ENABLED=0: Pure Go, no C dependencies
# - netgo: Use Go's net package instead of system resolver
# - -s -w: Strip debug info for smaller binary
# This matches OpenFGA's official build configuration
RUN --mount=type=cache,target=/root/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    set -xe; \
    CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} \
    go build \
      -ldflags="-s -w -X github.com/openfga/openfga/internal/build.Version=${OPENFGA_VERSION} -X github.com/openfga/openfga/internal/build.Commit=$(git rev-parse --short HEAD)" \
      -tags netgo \
      -o /usr/bin/openfga ./cmd/openfga

# OpenFGA serves HTTP-to-gRPC traffic over a unix socket in /tmp when it can
# (falling back to TCP with a warning); scratch has no /tmp, so create one.
RUN mkdir -p /rootfs/tmp && chmod 1777 /rootfs/tmp

FROM scratch

COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /usr/bin/openfga /usr/bin/openfga
COPY --from=build /rootfs/ /
