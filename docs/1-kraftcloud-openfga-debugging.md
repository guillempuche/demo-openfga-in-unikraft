# OpenFGA on KraftCloud: Debugging Journey

## Problem Statement

Deploying OpenFGA to KraftCloud resulted in immediate instance crashes with no useful error output.

## Initial Symptoms

```bash
kraft cloud deploy --kraftfile infrastructure/kraftcloud/openfga/Kraftfile -M 1G .
# Result: Deployed but instance is not online!
# State: stopped, Stop reason: shutdown
```

Instance logs showed:
```
/usr/bin/openfga[    0.030176] reboot: Restarting system
```

Exit code: **243** (abnormal termination, 102ms uptime)

---

## Investigation

### 1. jq Parse Error

When retrieving instance details:
```bash
kraft cloud instance get $INSTANCE --metro fra -o json | jq -r '.private_ip'
# Error: Cannot index array with string "private_ip"
```

**Cause:** `kraft cloud instance get` returns an array, not an object.

**Fix:** Use `.[0].private_ip` or `.[].private_ip`

### 2. Binary Crash Analysis

Examined the original Dockerfile build configuration:

```dockerfile
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
go build \
  -buildmode=pie \
  -ldflags "-linkmode external -extldflags -static-pie" \
  -tags netgo \
  -o /usr/bin/openfga ./cmd/run
```

**Problems identified:**

| Flag | Issue |
|------|-------|
| `CGO_ENABLED=0` + `-linkmode external` | **Incompatible** - external linking requires CGO |
| `-buildmode=pie` + `-static-pie` without CGO | Produces malformed binary |
| `./cmd/run` | Non-canonical path (official uses `./cmd/openfga`) |

---

## Solutions Attempted

### Attempt 1: Static-PIE with musl (Option A)

```dockerfile
RUN apt-get install -y musl-tools

CGO_ENABLED=1 CC=musl-gcc GOOS=linux GOARCH=amd64 \
go build \
  -buildmode=pie \
  -ldflags "-linkmode external -extldflags '-static-pie' -s -w" \
  -tags 'netgo osusergo static_build' \
  -o /usr/bin/openfga ./cmd/openfga
```

**Result:** Exit code **254**, still crashed at 171ms uptime. No output before crash.

### Attempt 2: Simple Static Build (Option B)

```dockerfile
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
go build \
  -ldflags="-s -w" \
  -tags netgo \
  -o /usr/bin/openfga ./cmd/openfga
```

This matches OpenFGA's official Dockerfile configuration.

**Result:** Binary works! Instance ran for 51 seconds with actual log output.

---

## Final Status

### Binary: Working

The simple static build (`CGO_ENABLED=0`, no PIE) works with KraftCloud's `base-compat` runtime.

### New Issue: Database Connection

```
panic: hostname resolving error: lookup postgres.default on 10.0.1.206:53: no such host
```

OpenFGA starts successfully but cannot connect to PostgreSQL because no postgres instance is deployed on KraftCloud.

---

## Key Findings

### 1. Go Build Flags for Unikraft

| Approach | Works? | Notes |
|----------|--------|-------|
| `CGO_ENABLED=0` + `-linkmode external` | No | Incompatible combination |
| `CGO_ENABLED=1` + musl + static-PIE | No | Crashed with exit 254 |
| `CGO_ENABLED=0` simple static | **Yes** | Matches official OpenFGA build |

### 2. Unikraft Compatibility

The `base-compat` runtime on KraftCloud can run simple statically-linked Go binaries without requiring static-PIE format.

### 3. Exit Codes

| Exit Code | Meaning |
|-----------|---------|
| 243 | Binary format incompatible / crash at load |
| 254 | Binary loaded but crashed during init |
| 2 | Application error (e.g., database connection failed) |

---

## Working Dockerfile

```dockerfile
ARG GO_VERSION=1.24.0
FROM --platform=linux/x86_64 golang:${GO_VERSION}-bookworm AS build

ARG OPENFGA_VERSION=v1.11.0

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
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build \
      -ldflags="-s -w" \
      -tags netgo \
      -o /usr/bin/openfga ./cmd/openfga

FROM scratch

COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /usr/bin/openfga /usr/bin/openfga
COPY infrastructure/kraftcloud/openfga/rootfs/ /
```

---

## Next Steps

1. Deploy PostgreSQL instance on KraftCloud, OR
2. Use external managed PostgreSQL (Neon, Supabase, etc.), OR
3. Use `OPENFGA_DATASTORE_ENGINE=memory` for testing (non-persistent)

---

## References

- [Unikraft Compatibility Docs](https://unikraft.org/docs/concepts/compatibility)
- [Unikraft Static PIE Apps](https://github.com/unikraft/static-pie-apps)
- [OpenFGA Official Dockerfile](https://github.com/openfga/openfga/blob/main/Dockerfile)
- [OpenFGA GoReleaser Config](https://github.com/openfga/openfga/blob/main/.goreleaser.yaml)
