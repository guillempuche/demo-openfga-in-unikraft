# The official OpenFGA release image: a static, CGO-free binary built and
# signed (cosign, SLSA provenance) by OpenFGA's release workflow. Production
# runs the same artifact the local and CI stacks test. Pinned by the
# multi-arch index digest, the one OpenFGA signs; --platform picks the amd64
# binary for kraftcloud/x86_64. Keep the tag in sync with versions.env
# (checked by scripts/check-versions.sh).
FROM --platform=linux/amd64 openfga/openfga:v1.21.0@sha256:2113c664a486b5da8d7a2cdab479e0d4e30639c80fd2c000540f645c1dbc1e55 AS openfga

# busybox's musl variant: one static program that gives entrypoint.sh a shell
# (the OpenFGA image has none), to turn TLS certificates passed as environment
# variables into the files OpenFGA reads.
FROM --platform=linux/amd64 busybox:1.38.0-musl@sha256:80e38f9a1b39188b8bdb28879178edb322a4402b081a9aedda1924609decd6f6 AS busybox

FROM scratch

COPY --from=openfga /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=openfga /openfga /usr/bin/openfga
# OpenFGA serves HTTP-to-gRPC traffic over a unix socket in a temp dir when it
# can (falling back to TCP with a warning). The copy is 0755, not 1777, which is
# enough: the unikernel runs the process as root.
COPY --from=openfga /tmp /tmp

COPY --from=busybox /bin/busybox /bin/busybox
COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh
