# Demo OpenFGA for Unikraft

OpenFGA is one of the most widely adopted relationship-based authorization services. This project runs it on Unikraft unikernels: a **private** OpenFGA instance (no public port) backed by Neon Postgres, and a tiny **public** API that reaches it over Unikraft's internal network (`demo-fga-openfga.internal`). The same models and tests run locally with Docker Compose.

## Table of Contents

- [Overview](#overview)
- [Directory Layout](#directory-layout)
- [Prerequisites](#prerequisites)
- [Local Smoke Test](#local-smoke-test)
- [OpenFGA Local Setup](#openfga-local-setup)
- [Authorization Models](#authorization-models)
  - [Deploy the Manifest](#deploy-the-manifest)
  - [Inspect the Combined Model](#inspect-the-combined-model)
  - [Test the Models](#test-the-models)
  - [Transform Models](#transform-models)
  - [Add a New Model](#add-a-new-model)
- [Unikraft Cloud Deployment](#unikraft-cloud-deployment)
  - [Architecture](#architecture)
  - [Configure Secrets](#configure-secrets)
  - [Migrate the Database](#migrate-the-database)
  - [Build the Images](#build-the-images)
  - [Deploy](#deploy)
  - [Seed and Test Through the Tunnel](#seed-and-test-through-the-tunnel)
  - [Verify](#verify)
  - [Redeploy](#redeploy)
  - [Clean Up](#clean-up)
- [Reference](#reference)

## Overview

- **Reproducible tooling** powered by `flake.nix`: OpenFGA CLI, the `unikraft` CLI, Node.js and jq.
- **Local OpenFGA stack** (PostgreSQL + OpenFGA + Caddy + Playground) for model development.
- **Private OpenFGA on Unikraft Cloud** with a public API in front, connected over the internal network.
- **Modular authorization models** and tests that run both locally and against the deployed instance.

## Directory Layout

- `authz/` – Local development stack (Docker Compose, Caddy, Playground) and authorization models.
- `authz/models/` – FGA modules (`projects.fga`, `tasks.fga`) and tests.
- `authz/seed/` – Synthetic tuples loaded into the deployed store.
- `api/` – Public demo API (Node.js, TypeScript run natively) with its Kraftfile and Dockerfile.
- `infrastructure/kraftcloud/openfga/` – OpenFGA Kraftfile and rootfs.
- `infrastructure/kraftcloud/docker-compose.yaml` – Local smoke test of the unikernel Dockerfiles (OpenFGA + Caddy).
- `scripts/` – `unikraft` CLI wrappers: build, migrate, deploy, tunnel, seed, test, verify, cleanup.
- `Dockerfile.openfga` – OpenFGA rootfs (static Go build).
- `Dockerfile.caddy` – Caddy rootfs, used only by the local smoke test.
- `docs/RESULTS.md` – Results of the Unikraft Cloud tests.

## Prerequisites

### Tooling

1. **Docker**: builds root filesystems (BuildKit) and runs the local stacks.
   - Verify: `docker --version && docker compose version`

2. **Nix**: (Recommended) Enter the dev shell for consistent tooling (`fga`, `unikraft`, `node`, `jq`).
   - Install [Nix](https://zero-to-nix.com/start/install/).
   - Run: `nix develop` (or `nix develop -c zsh`).
   - Without Nix: `brew install unikraft/cli/unikraft openfga/tap/fga jq node`.

### Cloud Auth

The `unikraft` CLI keeps credentials in a profile, so there is no token to export:

```bash
unikraft login
unikraft profile list
```

The legacy `UKC_TOKEN`/`UKC_METRO` variables are only read by the deprecated `kraft cloud` CLI. Write commands take an explicit `--metro`; the scripts default to `fra`.

## Local Smoke Test

Use Docker Compose to confirm the unikernel Dockerfiles boot. Caddy and the Playground are local-only.

```bash
cp infrastructure/kraftcloud/.env.local.example infrastructure/kraftcloud/.env

docker compose \
  -f infrastructure/kraftcloud/docker-compose.yaml \
  --env-file infrastructure/kraftcloud/.env \
  up --build
```

Ensure you have a PostgreSQL instance running (e.g., from the `authz/docker-compose.yaml` stack) and configured in `.env` if testing full functionality.

## OpenFGA Local Setup

This is the reference deployment for **development**. It uses standard container images to prove out model changes and CLI flows.

### Quick Start

1. **Create the environment configuration**:

   ```bash
   cp authz/.env.example authz/.env
   ```

2. **Start the stack**:

   ```bash
   docker compose -f authz/docker-compose.yaml up -d
   ```

   - API: `http://localhost:8080`
   - Playground: `http://localhost:8082/playground`

3. **Load the model**:

   ```bash
   export STORE_ID=01KA43FJDTE8AQCYZ6252ZR9HS
   export FGA_API_URL=http://localhost:8080
   export FGA_API_TOKEN=dev-key-1

   fga model write \
     --store-id=$STORE_ID \
     --api-url=$FGA_API_URL \
     --api-token=$FGA_API_TOKEN \
     --file authz/models/fga.mod
   ```

## Authorization Models

OpenFGA stays popular because its modeling experience scales, so the repo keeps the canonical modules in `authz/models/` and runs them identically on Docker and Unikraft targets.

- `authz/models/fga.mod`: Manifest that enumerates included modules.
- `authz/models/projects.fga`: Users, projects, and lists with hierarchical sharing.
- `authz/models/tasks.fga`: Tasks that inherit rights from their parent lists.

Export the helper variables once per shell session so the CLI examples just work:

```bash
export STORE_ID=01KA43FJDTE8AQCYZ6252ZR9HS
export FGA_API_URL=http://localhost:8080
export FGA_API_TOKEN=dev-key-1
```

### Deploy the Manifest

```bash
fga model write \
  --store-id=$STORE_ID \
  --api-url=$FGA_API_URL \
  --api-token=$FGA_API_TOKEN \
  --file authz/models/fga.mod
```

The CLI prints the newly created `authorization_model_id`. This is the version identifier for the model you just wrote—keep using the same `STORE_ID` for all other commands, and optionally pass `--authorization-model-id` when you want to inspect an older version.

### Inspect the Combined Model

```bash
fga model get \
  --store-id=$STORE_ID \
  --api-url=$FGA_API_URL \
  --api-token=$FGA_API_TOKEN
```

### Test the Models

Run from the repository root so the relative paths resolve correctly:

```bash
fga model test --tests authz/models/projects.fga.yaml authz/models/tasks.fga.yaml
```

### Transform Models

```bash
fga model transform \
  --input ./authz/models/projects.fga \
  --output ./authz/models/projects.json
```

### Add a New Model

1. Create a `.fga` module in `authz/models/`.
2. Declare the module and add your relationships.
3. Append the file path to `authz/models/fga.mod`.
4. Add tests (`*.fga.yaml`) beside the module.
5. Redeploy with `fga model write`.

## Unikraft Cloud Deployment

### Architecture

```
internet ──HTTPS──▶ demo-fga-api (public, 443→8080)
                         │  http://demo-fga-openfga.internal:8080
                         │  Authorization: Bearer $FGA_KEY
                         ▼
                    demo-fga-openfga (no published ports, scale-to-zero off)
                         │  TLS
                         ▼
                    Neon Postgres (direct, unpooled URL)
```

- Every instance gets a private IP and a private FQDN `<instance-name>.internal` on the account's internal network ([docs](https://unikraft.com/docs/platform/networking)). OpenFGA publishes no service, so none of its ports (8080 HTTP, 8081 gRPC, 3000 Playground, 2112 metrics) are reachable from the internet.
- OpenFGA requires a preshared key (`OPENFGA_AUTHN_METHOD=preshared`). The Playground is disabled in the cloud.
- The API looks up the store by name (`demo-fga`), so it needs no store ID and no IP, and survives redeploys without config changes.

| Instance           | Image                        | Memory | Public           |
| ------------------ | ---------------------------- | ------ | ---------------- |
| `demo-fga-openfga` | `<org>/demo-fga-openfga`     | 512MiB | no               |
| `demo-fga-api`     | `<org>/demo-fga-api`         | 512MiB | yes (HTTPS 443)  |

### Configure Secrets

Secrets live in a gitignored `.env` at the repo root (or in your shell environment):

```bash
cp .env.example .env
# NEON_OPENFGA_DIRECT_URL=postgresql://...neon.tech/openfga?sslmode=require   (direct, not -pooler)
# FGA_KEY=$(openssl rand -hex 32)
```

The scripts never print them. `unikraft run -e` only accepts `KEY=VALUE` arguments, which would expose secrets in the process list, so `scripts/deploy.sh` writes each instance spec to a `0600` temp file and passes it with `unikraft run --load`. `unikraft instances get` shows `runtime.env` by default; the scripts select fields with `-f` to avoid printing it.

### Migrate the Database

Run once against an empty Neon database:

```bash
./scripts/migrate.sh   # docker run --rm openfga/openfga:v1.11.0 migrate (URI read from env)
```

### Build the Images

`unikraft build` builds the rootfs from the Dockerfile referenced by each Kraftfile and pushes the image:

```bash
./scripts/build.sh            # both
# equivalent to:
unikraft build infrastructure/kraftcloud/openfga --output <org>/demo-fga-openfga:latest
unikraft build api --output <org>/demo-fga-api:latest
```

### Deploy

```bash
./scripts/deploy.sh openfga   # private, 512MiB, --scale-to-zero policy=off
./scripts/deploy.sh api       # public HTTPS, 512MiB, scale-to-zero on (5s cooldown)
```

What it runs, shown as flags (the script passes the same fields via `--load` to keep secrets off argv):

```bash
unikraft run --metro fra -n demo-fga-openfga --image <org>/demo-fga-openfga:latest \
  -m 512MiB --scale-to-zero policy=off --restart on-failure \
  -e OPENFGA_DATASTORE_ENGINE=postgres -e OPENFGA_DATASTORE_URI=... \
  -e OPENFGA_AUTHN_METHOD=preshared -e OPENFGA_AUTHN_PRESHARED_KEYS=... \
  -e OPENFGA_PLAYGROUND_ENABLED=false -e OPENFGA_CHECK_QUERY_CACHE_ENABLED=true

unikraft run --metro fra -n demo-fga-api --image <org>/demo-fga-api:latest \
  -m 512MiB -p 443:8080/http+tls -p 80:443/http+redirect \
  --scale-to-zero policy=on,cooldown-time=5000 --restart on-failure \
  -e FGA_API_URL=http://demo-fga-openfga.internal:8080 -e FGA_KEY=...
```

Inspect them (private IP under `networks`):

```bash
unikraft instances list
unikraft instances get demo-fga-openfga -f name,state,networks,service
unikraft instances logs demo-fga-openfga
```

### Seed and Test Through the Tunnel

`unikraft instances tunnel` forwards a local port to an unexposed instance via a temporary relay instance on the internal network:

```bash
./scripts/tunnel.sh           # terminal 1: localhost:18080 -> demo-fga-openfga:8080
./scripts/seed.sh             # terminal 2: create store "demo-fga", write model + synthetic tuples
./scripts/test-remote.sh      # fga model test against the deployed store
```

`fga model test` only queries a server when the test file has no `model_file` (otherwise it runs an embedded OpenFGA), so `test-remote.sh` strips that line and runs the tests against the store's latest model with the test tuples as contextual tuples.

### Verify

```bash
./scripts/verify.sh
```

It calls the public API:

- `GET /health`: API status, OpenFGA reachability, and what `demo-fga-openfga.internal` resolves to.
- `GET /check?user=user:alice&relation=can_edit&object=project:roadmap`: one Check.
- `GET /bench`: 100 sequential Checks (after 3 warm-up calls), returns p50/p95/max in ms.

It also confirms OpenFGA has no service and that ports 8080/8081/3000/2112 don't answer on the public FQDN. See [docs/RESULTS.md](docs/RESULTS.md) for recorded results.

### Redeploy

Never restart in place; delete and run again:

```bash
./scripts/cleanup.sh && ./scripts/deploy.sh
```

### Clean Up

Removes only `demo-fga-*` instances (add `--images` to also remove the `demo-fga-*` images):

```bash
./scripts/cleanup.sh
# equivalent to:
unikraft instances delete demo-fga-api
unikraft instances delete demo-fga-openfga
```

## Reference

- [unikraft CLI](https://unikraft.com/docs/cli/unikraft)
- [Migrating from kraft cloud](https://unikraft.com/docs/tutorials/kraftkit-to-unikraft)
- [Unikraft networking](https://unikraft.com/docs/platform/networking)
- [OpenFGA CLI docs](https://openfga.dev/docs/getting-started/cli)
