# PostgreSQL for Unikraft Cloud: builds the root file system (rootfs) of the
# demo's PostgreSQL unikernel, the database where OpenFGA stores authorization
# data. A unikernel runs a single program in its own lightweight virtual
# machine; Unikraft's base-compat runtime runs ordinary Linux programs, so this
# Dockerfile only has to produce the files to boot (the Kraftfile says how).
#
# Adapted from github.com/unikraft-cloud/examples/tree/main/postgres.
#
# Supply-chain safety: every input is pinned. Base images are referenced by
# digest (a hash of their exact content) and each download is checked against
# its SHA-256 checksum, so this file always builds the same image and a
# tampered or changed download stops the build. Renovate, the dependency-update
# bot (renovate.json), proposes updates; a new PG_VERSION or extension commit
# also needs its checksum below.

# PostgreSQL version, set only here (wrapper.sh reads it from the image), and
# the SHA-256 of its source tarball as published by the PostgreSQL project:
# https://ftp.postgresql.org/pub/source/v<version>/postgresql-<version>.tar.bz2.sha256
ARG PG_VERSION=16.14
ARG PG_SHA256=f6d077142737920858ce958ccdb75c6ee137a63b5b0853c70693d401ac7e3471

# pg_ukc_scaletozero, a PostgreSQL extension from Unikraft: it tells the
# platform a query is running, so scale-to-zero never pauses the database in
# the middle of one. Pinned to a commit of its "stable" branch.
ARG PG_UKC_SCALETOZERO_COMMIT=063f8723b94080c57780bb710511b3b5eb9b0c86
ARG PG_UKC_SCALETOZERO_SHA256=98adeb61bf4b052251f5129488b4d19965ea9d12cc22754a66b1125c8a827755

FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc AS base

##
## Stage 1: compile PostgreSQL and the scale-to-zero extension.
##
FROM base AS pg-build

# The ARGs at the top of the file are visible inside a stage only once the
# stage re-declares them (without a value, so it keeps the one at the top).
ARG PG_VERSION
ARG PG_SHA256
ARG PG_UKC_SCALETOZERO_COMMIT
ARG PG_UKC_SCALETOZERO_SHA256

# Compilers and the development files of the libraries PostgreSQL is built
# with: ICU (Unicode sorting), libxml2 and libxslt (XML), LZ4 (compression).
RUN apk add --no-cache --virtual .build-deps \
        coreutils \
        g++ \
        gcc \
        make \
        tar \
        bzip2 \
        libxml2-dev \
        libxslt-dev \
        libedit-dev \
        zlib-dev \
        lz4-dev \
        zstd-dev \
        e2fsprogs-dev \
        linux-headers \
        git \
        icu-dev \
    ;

# Download the sources; the next step checks them before anything is unpacked.
ADD https://ftp.postgresql.org/pub/source/v${PG_VERSION}/postgresql-${PG_VERSION}.tar.bz2 /tmp/postgresql.tar.bz2
ADD https://github.com/unikraft-cloud/pg_ukc_scaletozero/archive/${PG_UKC_SCALETOZERO_COMMIT}.tar.gz /tmp/pg_ukc_scaletozero.tar.gz
COPY allow-root.patch /tmp/

# sha256sum -c stops the build if a file's checksum differs from the pinned
# one. --strip-components=1 drops each archive's top folder (such as
# postgresql-16.14/), so the sources land in a fixed directory.
RUN set -eu; \
    echo "${PG_SHA256}  /tmp/postgresql.tar.bz2" | sha256sum -c -; \
    echo "${PG_UKC_SCALETOZERO_SHA256}  /tmp/pg_ukc_scaletozero.tar.gz" | sha256sum -c -; \
    mkdir -p /usr/src/postgresql /usr/src/pg_ukc_scaletozero; \
    tar -xjf /tmp/postgresql.tar.bz2 --strip-components=1 -C /usr/src/postgresql; \
    tar -xzf /tmp/pg_ukc_scaletozero.tar.gz --strip-components=1 -C /usr/src/pg_ukc_scaletozero; \
    rm /tmp/postgresql.tar.bz2 /tmp/pg_ukc_scaletozero.tar.gz

# allow-root.patch lets PostgreSQL run as root, which is how the unikernel
# runs it (PostgreSQL refuses to otherwise). The compiler flags keep the
# binaries small. world-bin is everything (server, client tools, contrib
# modules) except the documentation; it installs into /usr/src/postgresql/dist,
# which the later stages copy from. The plain `make install` also installs
# PostgreSQL in this stage's /usr/local, where the extension build below finds
# it.
# There is no --with-ssl, so the server has no TLS (encrypted connections):
# OpenFGA reaches it only over Unikraft's private network (scripts/deploy.sh).
RUN set -eu; \
    cd /usr/src/postgresql; \
    git apply /tmp/allow-root.patch; \
    export CFLAGS="-s -Os -Wl,--strip-all"; \
    export CXXFLAGS="-s -Os -Wl,--strip-all"; \
    ./configure \
        --enable-option-checking=fatal \
        --enable-integer-datetimes \
        --enable-thread-safety \
        --disable-rpath \
        --with-uuid=e2fs \
        --with-pgport=5432 \
        --with-system-tzdata=/usr/share/zoneinfo \
        --prefix=/usr/local \
        --with-includes=/usr/local/include \
        --with-libraries=/usr/local/lib \
        --with-icu \
        --with-libxml \
        --with-libxslt \
        --without-zlib \
        --with-lz4 \
    ; \
    make -j "$(nproc)" world-bin; \
    make install-world-bin DESTDIR=/usr/src/postgresql/dist; \
    make install

# The extension's Makefile uses PGXS, PostgreSQL's build system for extensions,
# which finds PostgreSQL through pg_config (in /usr/local/bin since the step
# above).
RUN set -eu; \
    cd /usr/src/pg_ukc_scaletozero; \
    export CFLAGS="-s -Os -Wl,--strip-all"; \
    make; \
    make install DESTDIR=/usr/src/postgresql/dist

##
## Stage 2: the packages that provide the libraries PostgreSQL, its modules
## and bash load, and tzdata (time zones). Stage 3 copies out only the files
## actually used, and fails the build if one is missing.
##
FROM base AS base-deps

RUN apk add --no-cache \
        libuuid \
        libxml2 \
        libxslt \
        lz4-libs \
        tzdata \
        libgcc \
        libstdc++ \
        icu-libs \
        bash \
        libedit \
    ;

##
## Stage 3: assemble the rootfs in /rootfs.
##
## A program needs its shared libraries (the .so files it links against) at
## run time. Rather than listing them by name, which broke when Alpine moved
## them from /lib to /usr/lib and updated ICU from version 74 to 78, ask ldd
## (the tool that lists a program's libraries) and copy exactly those.
##
FROM base-deps AS runtime

COPY --from=pg-build /usr/src/postgresql/dist/ /rootfs/

# Add the data files PostgreSQL reads (ICU's Unicode data, time zones) and bash,
# which wrapper.sh needs (added first, so its libraries are collected too). Then
# copy in every library that a program or module in /rootfs uses.
RUN set -eu; \
    mkdir -p /rootfs/bin /rootfs/usr/share; \
    cp "$(command -v bash)" /rootfs/bin/bash; \
    cp -a /usr/share/icu /usr/share/zoneinfo /rootfs/usr/share/; \
    # Programs (files the owner can execute) and libraries or modules (*.so*).
    find /rootfs -type f \( -perm -u+x -o -name '*.so*' \) \
        # ldd lists a file's libraries. LD_LIBRARY_PATH lets it find
        # PostgreSQL's own (libpq and others) in /rootfs. ldd fails on a file
        # that isn't a compiled program, such as a script: skip it.
        | while read -r f; do LD_LIBRARY_PATH=/rootfs/usr/local/lib ldd "$f" 2>/dev/null || true; done \
        # Keep only the absolute paths, the library files: the line
        # "libz.so.1 => /lib/libz.so.1 (0x...)" gives /lib/libz.so.1.
        | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^\//) print $i }' \
        # Libraries already in /rootfs (PostgreSQL's own) need no copy. sort
        # outputs nothing until find has finished, so the copying below never
        # writes into /rootfs while find is still reading it.
        | grep -v '^/rootfs/' | sort -u \
        # Copy each to the same path inside /rootfs (${lib%/*} is its directory).
        # Most are symlinks to a file named with the full version; cp -L copies
        # that file under the symlink's name.
        | while read -r lib; do mkdir -p "/rootfs${lib%/*}"; cp -L "$lib" "/rootfs$lib"; done

# Fail the build, not the deployment, if a library file is still missing: every
# program and module must find all its libraries inside /rootfs, and PostgreSQL
# must start there.
RUN set -eu; \
    # Compiled programs and libraries are ELF files, which start with the byte
    # 0x7F and the letters "ELF"; skip anything else, such as scripts.
    is_elf() { [ "$(head -c 4 "$1" | tail -c 3)" = ELF ]; }; \
    # Print the libraries of a file that the dynamic loader of musl (Alpine's C
    # library; ldd runs the same loader) can't find inside /rootfs. Only missing
    # files count: a module's calls into PostgreSQL (palloc, errmsg, ...) are
    # resolved when the server loads it, so "symbol not found" here is expected.
    missing_libraries() { chroot /rootfs /lib/ld-musl-x86_64.so.1 --list "$1" 2>&1 | grep 'Error loading shared library'; }; \
    unresolved=0; \
    for file in $(find /rootfs -type f \( -perm -u+x -o -name '*.so*' \)); do \
        is_elf "$file" || continue; \
        # Inside the chroot, /rootfs/<path> is /<path>.
        if missing_libraries "${file#/rootfs}" >&2; then unresolved=1; fi; \
    done; \
    # Fail only now, so the log lists every missing library, not just the first.
    [ "$unresolved" = 0 ]; \
    chroot /rootfs /usr/local/bin/postgres --version

##
## Stage 4: the image the unikernel boots. busybox provides the small shell and
## core commands wrapper.sh uses; the rest is the rootfs collected above. The
## musl variant is a single static program, so the image has one C library
## (Alpine's musl); the default variant adds glibc's files, which nothing uses.
##
FROM busybox:1.38.0-musl@sha256:ea2b9914a16a4ac1981994af97b318f7c7d4db76b580c56177f08bf76f4a0be8

# wrapper.sh reads the PostgreSQL version from the environment. ARG brings in
# the value from the top of the file (see stage 1); ENV keeps it in the image,
# since an ARG exists only during the build.
ARG PG_VERSION
ENV PG_VERSION=${PG_VERSION}

COPY --from=runtime /rootfs/ /

# The templates initdb copies into a new database (postgresql.conf.sample,
# pg_hba.conf.sample), a passwd entry for root and the empty directories
# PostgreSQL expects.
COPY fs/ /

# Entry point (the Kraftfile's cmd): creates the database on the first boot
# from the POSTGRES_* variables, then starts PostgreSQL.
COPY --chmod=755 wrapper.sh /usr/local/bin/wrapper.sh
