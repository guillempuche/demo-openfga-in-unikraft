# Both stages use the same Node.js 24 image, pinned by digest (a hash of its
# exact content) so every build ships the same Node.js; Renovate proposes
# updates when the 24-alpine tag moves.
#
# Bundle the API into one ES module. The output is plain JavaScript, so this
# stage runs on the build machine's own architecture.
FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Same shape as unikraft-cloud/examples httpserver-node26: copy only the Node
# binary, its musl loader and C++ runtime into a scratch rootfs.
FROM --platform=linux/amd64 node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS node

FROM scratch

COPY --from=node /usr/local/bin/node /usr/bin/node
COPY --from=node /lib/ld-musl-x86_64.so.1 /lib/ld-musl-x86_64.so.1
COPY --from=node /usr/lib/libgcc_s.so.1 /usr/lib/libgcc_s.so.1
COPY --from=node /usr/lib/libstdc++.so.6 /usr/lib/libstdc++.so.6

COPY --from=build /src/dist/server.mjs /usr/src/server.mjs
