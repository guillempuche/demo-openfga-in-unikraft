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
# tampered or changed download stops the build. Renovate proposes updates; a
# new PG_VERSION or extension commit also needs its checksum below.

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

# The upstream example hides OpenSSL during the build (it doesn't say why;
# this PostgreSQL is built without TLS, as it only listens on the private
# network). Alpine 3.20 keeps the library in /lib, newer releases in /usr/lib,
# so look in both and move the real file, not a symlink to it.
RUN for lib in /lib/libssl.so.3 /usr/lib/libssl.so.3; do \
        if [ -e "$lib" ] && [ ! -L "$lib" ]; then mv "$lib" "$lib.orig"; fi; \
    done

# Download the sources; the next step checks them before anything is unpacked.
ADD https://ftp.postgresql.org/pub/source/v${PG_VERSION}/postgresql-${PG_VERSION}.tar.bz2 /tmp/postgresql.tar.bz2
ADD https://github.com/unikraft-cloud/pg_ukc_scaletozero/archive/${PG_UKC_SCALETOZERO_COMMIT}.tar.gz /tmp/pg_ukc_scaletozero.tar.gz
COPY allow-root.patch /tmp/

RUN set -eu; \
    echo "${PG_SHA256}  /tmp/postgresql.tar.bz2" | sha256sum -c -; \
    echo "${PG_UKC_SCALETOZERO_SHA256}  /tmp/pg_ukc_scaletozero.tar.gz" | sha256sum -c -; \
    mkdir -p /usr/src/postgresql /usr/src/pg_ukc_scaletozero; \
    tar -xjf /tmp/postgresql.tar.bz2 --strip-components=1 -C /usr/src/postgresql; \
    tar -xzf /tmp/pg_ukc_scaletozero.tar.gz --strip-components=1 -C /usr/src/pg_ukc_scaletozero; \
    rm /tmp/postgresql.tar.bz2 /tmp/pg_ukc_scaletozero.tar.gz

# allow-root.patch lets PostgreSQL run as root, which is how the unikernel
# runs it (PostgreSQL refuses to otherwise).
# The compiler flags keep the binaries small. Everything installs into
# /usr/src/postgresql/dist, which the later stages copy from.
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

RUN set -eu; \
    cd /usr/src/pg_ukc_scaletozero; \
    export CFLAGS="-s -Os -Wl,--strip-all"; \
    make; \
    make install DESTDIR=/usr/src/postgresql/dist

##
## Stage 2: the run-time libraries, installed as Alpine packages. Only the
## files PostgreSQL actually uses are copied out of this stage (stage 3).
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
        openssl \
        krb5-libs \
        libldap \
        cyrus-sasl \
        libcom_err \
        keyutils-libs \
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

# Add bash (wrapper.sh needs it) and the data files PostgreSQL reads (ICU's
# Unicode data, time zones). Then collect the libraries of every program and
# module in /rootfs. ldd prints each one as an absolute path; PostgreSQL's own
# (libpq and others) are found inside /rootfs and need no copy. sort reads all
# of ldd's output before the copying starts writing into /rootfs.
RUN set -eu; \
    mkdir -p /rootfs/bin /rootfs/usr/share; \
    cp "$(command -v bash)" /rootfs/bin/bash; \
    cp -a /usr/share/icu /usr/share/zoneinfo /rootfs/usr/share/; \
    find /rootfs -type f \( -perm -u+x -o -name '*.so*' \) \
        | while read -r f; do LD_LIBRARY_PATH=/rootfs/usr/local/lib ldd "$f" 2>/dev/null || true; done \
        | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^\//) print $i }' \
        | grep -v '^/rootfs/' | sort -u \
        | while read -r lib; do mkdir -p "/rootfs${lib%/*}"; cp -L "$lib" "/rootfs$lib"; done

# Fail the build, not the deployment, if a library file is still missing: for
# every program and every module PostgreSQL loads at run time, resolve its
# libraries inside /rootfs with the dynamic loader of musl, Alpine's C library
# (the same loader ldd runs). Only missing files count: a module's references
# to PostgreSQL's own functions (palloc, errmsg, ...) are resolved by the
# running server when it loads the module, so they show up here as "symbol not
# found" by design. Then start PostgreSQL there once.
RUN set -eu; \
    unresolved=0; \
    for f in $(find /rootfs -type f \( -perm -u+x -o -name '*.so*' \)); do \
        [ "$(head -c 4 "$f" | tail -c 3)" = ELF ] || continue; \
        if chroot /rootfs /lib/ld-musl-x86_64.so.1 --list "${f#/rootfs}" 2>&1 | grep -q 'Error loading shared library'; then \
            chroot /rootfs /lib/ld-musl-x86_64.so.1 --list "${f#/rootfs}" 2>&1 | grep 'Error loading shared library' >&2; \
            unresolved=1; \
        fi; \
    done; \
    [ "$unresolved" = 0 ]; \
    chroot /rootfs /usr/local/bin/postgres --version

##
## Stage 4: the image the unikernel boots. busybox provides the small shell and
## core commands wrapper.sh uses; the rest is the rootfs collected above.
##
FROM busybox:1.38.0@sha256:fd7dc98638c8e305f4dc34e979f1c0fdfdcaeb0fbf8fcff77ae834b6da3d7e6e

# wrapper.sh reads the PostgreSQL version from here.
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
