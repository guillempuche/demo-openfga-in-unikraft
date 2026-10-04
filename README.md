# OpenFGA on Unikraft Cloud: private ReBAC authorization with PostgreSQL and a Node.js API

[![CI](https://github.com/guillempuche/demo-openfga-in-unikraft/actions/workflows/ci.yml/badge.svg)](https://github.com/guillempuche/demo-openfga-in-unikraft/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Example deployment of [OpenFGA](https://openfga.dev) (Zanzibar-style, fine-grained, relationship-based authorization) on [Unikraft Cloud](https://unikraft.com) unikernels. OpenFGA and PostgreSQL run as **private** instances with no public service, reached over Unikraft's internal network (`<name>.internal`); a small **public** Node.js/TypeScript API sits in front. Measured on Unikraft Cloud: **~1 ms p50** authorization checks from the API to OpenFGA, under 30 MiB of memory each for OpenFGA and the API, and the model tests passing against the deployed store. The same models run locally with Docker Compose.

## At a glance

| What | Result ([details](docs/RESULTS.md)) |
| --- | --- |
| API → OpenFGA over `.internal`, warm check | p50 1.0–1.3 ms, p95 ≤ 2.4 ms (100 sequential checks) |
| Same, OpenFGA check cache off (1 Postgres round trip) | p50 1.5–1.8 ms |
| Exposure | No service on OpenFGA or Postgres; ports 8080/8081/3000/2112/5432 don't answer; no key → `401` |
| Redeploy (delete + run, 32 s) | Every private IP changed and was reused by another instance; `.internal` names kept working with no config change |
| `fga model test` against the deployed store | 10/10 tests, 31/31 checks |
| Memory | OpenFGA 17.6 MiB RSS, API 26 MiB RSS (512 MiB allocated each) |

## Contents

- [Architecture](#architecture)
- [Quick start (local)](#quick-start-local)
- [Deploy to Unikraft Cloud](#deploy-to-unikraft-cloud)
- [Patterns to copy](#patterns-to-copy)
- [Gotchas](#gotchas)
- [Authorization models](#authorization-models)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Reference](#reference)

## Architecture

```
internet ──HTTPS──▶ demo-fga-api (public, 443→8080)
                         │  http://demo-fga-openfga.internal:8080
                         │  Authorization: Bearer $FGA_KEY
                         ▼
                    demo-fga-openfga (no published ports, scale-to-zero off)
                         │  postgres://…@demo-fga-postgres.internal:5432
                         ▼
                    demo-fga-postgres (no published ports, volume demo-fga-pgdata)
```

- Every instance gets a private IP and a private FQDN `<instance-name>.internal` on the account's internal network ([docs](https://unikraft.com/docs/platform/networking)). OpenFGA and Postgres publish no service, so none of their ports (8080 HTTP, 8081 gRPC, 3000 Playground, 2112 metrics, 5432) are reachable from the internet. The exception is an open `unikraft instances tunnel`, whose relay is publicly addressable ([details](#tunnels-create-publicly-addressable-relay-instances)). Internal traffic is unencrypted but never leaves the account's network.
- OpenFGA requires a preshared key (`OPENFGA_AUTHN_METHOD=preshared`). The Playground is disabled in the cloud.
- The API ([`api/server.ts`](api/server.ts)) finds OpenFGA by `.internal` name and the store by name (`demo-fga`), so it needs no IP or store ID and survives redeploys without config changes.
- Postgres keeps its data on a 512 MiB volume that survives instance deletion.

| Instance            | Image                     | Memory | Public          |
| ------------------- | ------------------------- | ------ | --------------- |
| `demo-fga-postgres` | `<org>/demo-fga-postgres` | 512MiB | no              |
| `demo-fga-openfga`  | `<org>/demo-fga-openfga`  | 512MiB | no              |
| `demo-fga-api`      | `<org>/demo-fga-api`      | 512MiB | yes (HTTPS 443) |

The public API is a demo: `/check` answers any authorization question without authentication, and `/bench` is capped at 100 checks with one run at a time. Put real authentication in front before using this shape for anything else.

## Quick start (local)

Needs Docker and the [OpenFGA CLI](https://openfga.dev/docs/getting-started/cli) (`fga`); `nix develop` provides `fga`, `unikraft`, `node` and `jq`.

```bash
cp authz/.env.example authz/.env
docker compose -f authz/docker-compose.yaml --env-file authz/.env up -d
```

This starts PostgreSQL, runs OpenFGA's migrations, and serves OpenFGA through Caddy:

- OpenFGA HTTP API: `http://localhost:8080` (preshared key `dev-key-1`)
- Playground: `http://localhost:8082/playground`

Create a store, load the model and the synthetic tuples, and check a permission:

```bash
export FGA_API_URL=http://localhost:8080
export FGA_API_TOKEN=dev-key-1
export FGA_STORE_ID=$(fga store create --name demo-fga --model authz/models/fga.mod | jq -r .store.id)
fga tuple write --file authz/seed/tuples.yaml
fga query check user:alice can_edit project:roadmap     # {"allowed":true}
fga query check user:mallory can_edit project:roadmap   # {"allowed":false}
```

Run the API against the local OpenFGA:

```bash
cd api && npm ci
FGA_KEY=dev-key-1 FGA_API_URL=http://localhost:8080 PORT=3001 npm start
curl 'http://localhost:3001/check?user=user:bob&relation=can_view&object=list:backlog'
```

Stop the stack with `docker compose -f authz/docker-compose.yaml down` (add `-v` to drop the database volume).

## Deploy to Unikraft Cloud

### Prerequisites

- The [`unikraft` CLI](https://unikraft.com/docs/cli/unikraft) (`brew install unikraft/cli/unikraft`, or `nix develop`), logged in with `unikraft login`. The CLI keeps credentials in a profile; the legacy `UKC_TOKEN`/`UKC_METRO` variables are only read by the deprecated `kraft cloud` CLI.
- Docker with BuildKit, to build the root filesystems.
- A plan with at least **3 running instances** (postgres, openfga, api) plus one short-lived relay while tunnelling. The free Hobby plan allows 2 running instances ([pricing](https://unikraft.com/pricing)); the API scales to zero when idle, so 2 run in steady state.

### Configure secrets

```bash
cp .env.example .env
# UNIKRAFT_PROFILE=<your-profile>             (see `unikraft profile list`)
# FGA_KEY=$(openssl rand -hex 32)
# POSTGRES_PASSWORD=$(openssl rand -hex 24)
```

`.env` is gitignored. The scripts never print secrets and pin every `unikraft` call to `UNIKRAFT_PROFILE`, so they never act on whichever profile happens to be active. Variables you export take precedence over `.env`. To use an external Postgres instead of the private instance, set `OPENFGA_DATASTORE_URI` and skip the `postgres` step.

### Build the images

```bash
./scripts/build.sh            # postgres, openfga, api (or name one)
```

Per image, this builds a local OCI archive and pushes it ([why](#failed-to-package-kernel--connection-reset-by-peer)):

```bash
unikraft build infrastructure/unikraft/openfga --output ./openfga.oci.tar
unikraft images copy ./openfga.oci.tar unikraft.io/<org>/demo-fga-openfga:latest
```

The postgres image compiles PostgreSQL 16.4 from source for x86_64; on Apple Silicon that runs under emulation and took 11.5 minutes the first time.

### Deploy

```bash
./scripts/deploy.sh           # postgres → migrate → openfga → api
# or step by step:
./scripts/deploy.sh postgres  # private, 512MiB, volume demo-fga-pgdata, scale-to-zero off
./scripts/deploy.sh migrate   # one-off `openfga migrate` instance on the private network (retried, must exit 0), then deleted
./scripts/deploy.sh openfga   # private, 512MiB, --scale-to-zero policy=off
./scripts/deploy.sh api       # public HTTPS, 512MiB, scale-to-zero on (5s cooldown)
```

What it runs, shown as flags. The script passes the same fields with `unikraft run --load <0600 YAML>` so secrets never appear on the command line:

```bash
unikraft volumes create --metro fra --name demo-fga-pgdata --size 512MiB
unikraft run --metro fra -n demo-fga-postgres --image <org>/demo-fga-postgres:latest \
  -m 512MiB --scale-to-zero policy=off --restart on-failure -v demo-fga-pgdata:/volume \
  -e POSTGRES_USER=openfga -e POSTGRES_DB=openfga -e POSTGRES_PASSWORD=... -e PGDATA=/volume/postgres

unikraft run --metro fra -n demo-fga-migrate --image <org>/demo-fga-openfga:latest \
  -m 256MiB --restart never --args "/usr/bin/openfga migrate" \
  -e OPENFGA_DATASTORE_ENGINE=postgres \
  -e OPENFGA_DATASTORE_URI=postgres://openfga:...@demo-fga-postgres.internal:5432/openfga?sslmode=disable

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

Inspect without printing secrets (private IP under `networks`):

```bash
unikraft instances list
unikraft instances get demo-fga-openfga -f name,state,networks,service
```

### Seed and test through the tunnel

`unikraft instances tunnel` forwards a local port to an unexposed instance through a temporary relay instance:

```bash
./scripts/tunnel.sh           # terminal 1: localhost:18080 -> demo-fga-openfga:8080
./scripts/seed.sh             # terminal 2: create store "demo-fga", write model + synthetic tuples
./scripts/test-remote.sh      # fga model test against the deployed store
```

### Verify

```bash
./scripts/verify.sh
```

It calls the public API (`/health`, `/check` allowed and denied, three `/bench` runs) and checks that OpenFGA and Postgres have no service, that no `demo-fga-*` instance other than the API and no open tunnel relay has a public domain (other workloads on the account are ignored), and that ports 8080/8081/3000/2112/5432 don't answer. It exits non-zero if any check fails.

API endpoints:

- `GET /health`: API status, OpenFGA reachability, what `demo-fga-openfga.internal` resolves to, and process memory.
- `GET /check?user=user:alice&relation=can_edit&object=project:roadmap`: one Check.
- `GET /bench[?n=100&user=&relation=&object=]`: up to 100 sequential Checks after 3 warm-up calls; returns p50/p95/max/min/mean in ms.

### Redeploy

Never restart in place; delete and run again. The volume, and so the store, model and tuples, survives:

```bash
./scripts/cleanup.sh && ./scripts/deploy.sh
```

To compare against the database path, redeploy OpenFGA alone with its check cache off: delete `demo-fga-openfga`, then `OPENFGA_CHECK_QUERY_CACHE_ENABLED=false ./scripts/deploy.sh openfga`.

### Clean up

Removes only `demo-fga-*` resources and exits non-zero if a delete fails:

```bash
./scripts/cleanup.sh          # instances only (keeps the volume and images)
./scripts/cleanup.sh --all    # also the demo-fga-pgdata volume (drops the data) and the <org>/demo-fga-* images
```

By hand, keep the output quiet: `delete` prints the instance, environment included.

```bash
unikraft instances delete demo-fga-api -o quiet
unikraft instances delete demo-fga-openfga -o quiet
unikraft instances delete demo-fga-postgres -o quiet
unikraft volumes delete demo-fga-pgdata -o quiet
unikraft images delete <org>/demo-fga-api:latest
```

## Patterns to copy

| Pattern | Where | Why |
| --- | --- | --- |
| Private service + public API over `<name>.internal` | [`scripts/deploy.sh`](scripts/deploy.sh), [`api/server.ts`](api/server.ts) | No public port on the backend; names survive redeploys, IPs don't. |
| Secrets through `unikraft run --load` | [`scripts/deploy.sh`](scripts/deploy.sh) | `-e KEY=VALUE` puts secrets in the process list; a 0600 YAML spec doesn't. |
| Pin the CLI profile in scripts | [`scripts/env.sh`](scripts/env.sh) | Scripts can't act on another account just because a different profile is active. |
| Resource-name prefix guard | [`scripts/cleanup.sh`](scripts/cleanup.sh) | Cleanup refuses to touch anything outside `demo-fga-*` on a shared account. |
| Two-step build: local OCI archive, then push | [`scripts/build.sh`](scripts/build.sh) | Avoids `failed to package kernel … connection reset by peer`. |
| One-off migration instance on the private network | [`scripts/deploy.sh`](scripts/deploy.sh) | No database port exposed for migrations; the deploy stops unless it exits 0. |
| `fga model test` against a deployed store | [`scripts/test-remote.sh`](scripts/test-remote.sh) | The same test files run locally and against production data paths. |
| Store lookup by name with a short cache | [`api/server.ts`](api/server.ts) | Recreated stores are picked up without restarting the API. |

## Gotchas

### Private IPs change on every redeploy, and get reused

After a delete-and-run, OpenFGA's old IP belonged to Postgres. Anything pinned to a private IP silently talks to the wrong service. Use `<instance-name>.internal`.

### `unikraft instances get`, `wait`, `delete` and `list -o json` print secrets

They include `runtime.env` (passwords, keys) unless output is limited. Use `-f name,state,networks` or `-o quiet`.

### `unikraft run -e` only accepts `KEY=VALUE`

So the secret is on the command line. Describe the instance in a 0600 YAML file and pass `--load` (generate the schema with `unikraft run … --dry-run --save spec.yaml`, using dummy values). `--load` replaces all flags; it doesn't merge with them.

### `failed to package kernel … connection reset by peer`

`unikraft build --output <org>/<image>` streams the `base-compat` runtime from S3 straight into the registry upload; on slow or VPN links S3 resets the download. Build to a local archive, then `unikraft images copy` it.

### `dockerfile context does not exist`

`rootfs.source` is resolved relative to the Kraftfile. Keep the Dockerfile next to its Kraftfile.

### `fga model test` passes with the server down

If a test file has `model_file`, the CLI runs an embedded OpenFGA and never contacts the server. Remove that line and pass `--store-id` to test a deployed store ([`scripts/test-remote.sh`](scripts/test-remote.sh)).

### `fga model test --tests a.yaml b.yaml` runs only the first file

`--tests` takes one path or glob: `fga model test --tests 'authz/models/*.fga.yaml'`.

### A deleted OpenFGA store still answers checks

OpenFGA soft-deletes stores, so a cached store ID keeps returning answers from the old store. The API re-resolves the store every 30 s and immediately when OpenFGA reports it has no model.

### The public URL changes on every `unikraft run`

Each run creates a new service with a random FQDN. For a stable name, create the service once with `unikraft services create` and attach instances with `--service`.

### Tunnels create publicly addressable relay instances

`unikraft instances tunnel` starts a `utils/tunnel` instance (128 MiB, random `inst-*` name) that counts against your quota and has its own public FQDN while the tunnel is open. Plain HTTPS to that FQDN returns "Service not found", not your service; the tunnel traffic itself uses the CLI's relay protocol, whose authentication this demo didn't examine. The relay is removed when the tunnel closes, so close tunnels when you're done; `scripts/verify.sh` fails while one is open.

## Authorization models

The modules live in `authz/models/` and run unchanged locally and on Unikraft:

- `fga.mod`: manifest listing the modules.
- `projects.fga`: users, projects and lists with hierarchical sharing.
- `tasks.fga`: tasks that inherit rights from their parent lists.

With `FGA_API_URL`, `FGA_API_TOKEN` and `FGA_STORE_ID` exported (see [Quick start](#quick-start-local)):

```bash
fga model write --file authz/models/fga.mod     # new authorization_model_id per write
fga model get                                   # the combined model
fga model test --tests 'authz/models/*.fga.yaml'   # expect Tests 10/10, Checks 31/31
fga model transform --file authz/models/fga.mod > model.json   # combined model as JSON
```

To add a module: create `authz/models/<name>.fga`, list it in `fga.mod`, add `<name>.fga.yaml` tests beside it, and write the model again.

## Repository layout

- `authz/` – local Docker Compose stack (PostgreSQL, OpenFGA, Caddy, Playground).
- `authz/models/` – FGA modules and their tests.
- `authz/seed/tuples.yaml` – synthetic tuples for the demo store.
- `api/` – public demo API (Node.js 24, TypeScript run natively), its tests, Kraftfile and Dockerfile.
- `infrastructure/unikraft/openfga/` – OpenFGA Kraftfile and Dockerfile (static Go build).
- `infrastructure/unikraft/postgres/` – PostgreSQL Kraftfile and rootfs, from the [Unikraft examples](https://github.com/unikraft-cloud/examples/tree/main/postgres) (see [NOTICE](NOTICE)).
- `scripts/` – `unikraft` CLI wrappers: build, deploy, tunnel, seed, test-remote, verify, cleanup.
- `docs/RESULTS.md` – measured results on Unikraft Cloud. `docs/1-*.md` and `docs/2-*.md` are historical notes from the legacy `kraft cloud` setup.
- `AGENTS.md` – context for AI coding agents.

## Development

```bash
fga model test --tests 'authz/models/*.fga.yaml'
cd api && npm ci && npm run typecheck && npm test
```

CI runs these, plus `shellcheck` on the scripts, a Compose config check and a build of the API rootfs.

## Reference

- [unikraft CLI](https://unikraft.com/docs/cli/unikraft)
- [Migrating from kraft cloud](https://unikraft.com/docs/tutorials/kraftkit-to-unikraft)
- [Unikraft networking](https://unikraft.com/docs/platform/networking)
- [OpenFGA documentation](https://openfga.dev/docs) and [CLI](https://openfga.dev/docs/getting-started/cli)

## License

Apache-2.0, see [LICENSE](LICENSE). Third-party files keep their own terms, see [NOTICE](NOTICE).
