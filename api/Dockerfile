# Same shape as unikraft-cloud/examples httpserver-node26: copy only the Node
# binary, its musl loader and C++ runtime into a scratch rootfs.
FROM --platform=linux/amd64 node:24-alpine AS node

FROM scratch

COPY --from=node /usr/local/bin/node /usr/bin/node
COPY --from=node /lib/ld-musl-x86_64.so.1 /lib/ld-musl-x86_64.so.1
COPY --from=node /usr/lib/libgcc_s.so.1 /usr/lib/libgcc_s.so.1
COPY --from=node /usr/lib/libstdc++.so.6 /usr/lib/libstdc++.so.6

# Node runs .ts directly (type stripping); no build step needed.
COPY ./server.ts /usr/src/server.ts
