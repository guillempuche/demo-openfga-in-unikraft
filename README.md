# OpenFGA on Unikraft Cloud: private ReBAC authorization with PostgreSQL and a Node.js API

[![CI](https://github.com/guillempuche/demo-openfga-in-unikraft/actions/workflows/ci.yml/badge.svg)](https://github.com/guillempuche/demo-openfga-in-unikraft/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Example deployment of [OpenFGA](https://openfga.dev) (Zanzibar-style, fine-grained, relationship-based authorization) on [Unikraft Cloud](https://unikraft.com) unikernels. OpenFGA and PostgreSQL run as **private** instances with no public service, reached over Unikraft's internal network (`<name>.internal`); a small **public** TypeScript API ([Effect](https://effect.website) 4 and the official OpenFGA SDK, on Node.js) sits in front. Measured on Unikraft Cloud: **~1 ms p50** authorization checks from the API to OpenFGA, under 30 MiB of memory each for OpenFGA and the API, and the model tests passing against the deployed store. The same models run locally with Docker Compose.

## At a glance

| What | Result ([details](docs/RESULTS.md)) |
| --- | --- |
| API → OpenFGA over `.internal`, warm check | p50 0.74–0.87 ms (Effect API; 1.0–1.3 ms before), 100 sequential checks |
| Write through the tunnel → public API sees it → delete → API sees that | ✅ before and after a full redeploy; store, model and tuples unchanged |
| API woken from scale-to-zero standby | p50 +0.21 s over a running instance (10 runs) |
| Same, OpenFGA check cache off (1 Postgres round trip) | p50 1.5–1.8 ms |
| Exposure | No service on OpenFGA or Postgres; ports 8080/8081/3000/2112/5432 don't answer; no key → `401` |
| Redeploy (delete + run, 32 s) | Every private IP changed and was reused by another instance; `.internal` names kept working with no config change |
| `fga model test` against the deployed server (v1.21.0, fresh store) | 28/28 tests: 190 checks, 11 ListObjects, 16 ListUsers |
| OpenFGA API | All 19 core RPCs called and asserted on Unikraft (server metrics as proof); +6 AuthZEN RPCs on the experimental local/CI stack |
| Memory | OpenFGA 17.6 MiB RSS, API 25 MiB RSS idle (512 MiB allocated each) |

## Contents

- [Architecture](#architecture)
- [Quick start (local)](#quick-start-local)
- [Deploy to Unikraft Cloud](#deploy-to-unikraft-cloud)
- [Patterns to copy](#patterns-to-copy)
- [Gotchas](#gotchas)
- [Authorization models](#authorization-models), and the [OpenFGA features guide](docs/openfga-features.md): every feature with its model excerpt, SDK call and tests
- [Integration tests: every OpenFGA RPC](#integration-tests-every-openfga-rpc)
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
- The API ([`api/src/`](api/src), Effect 4 + the official `@openfga/sdk`) finds OpenFGA by `.internal` name and the store by name (`demo-fga`), so it needs no IP or store ID and survives redeploys without config changes.
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

This starts PostgreSQL, runs OpenFGA's migrations, and serves OpenFGA v1.21.0 through Caddy at `http://localhost:8080` (preshared key `dev-key-1`).

The OpenFGA Playground is deprecated and, since v1.14, refuses to run with preshared-key authentication. To use it locally, start the optional profile: a second OpenFGA on the same database, without authentication, bound to this machine only.

```bash
docker compose -f authz/docker-compose.yaml --env-file authz/.env --profile playground up -d
# Playground: http://localhost:8082/playground (its API: http://localhost:8090, no key)
```

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

After each push, `build.sh` checks that the registry lists the archive's digest and records it in `.cache/image-digests` (gitignored).

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

Instances run images by digest (`<org>/demo-fga-api@sha256:…`), not `:latest`: `deploy.sh` uses the digest `build.sh` recorded, so a redeploy runs exactly the images that were built and verified, even if `:latest` has moved since. With nothing recorded (a fresh clone, images built on another machine), it pins and records the registry's current digest. `verify.sh` fails if an instance runs a tag or a digest other than the recorded one.

What it runs, shown as flags (`<digest>` is the pinned one). The script passes the same fields with `unikraft run --load <0600 YAML>` so secrets never appear on the command line:

```bash
unikraft volumes create --metro fra --name demo-fga-pgdata --size 512MiB
unikraft run --metro fra -n demo-fga-postgres --image <org>/demo-fga-postgres@<digest> \
  -m 512MiB --scale-to-zero policy=off --restart on-failure -v demo-fga-pgdata:/volume \
  -e POSTGRES_USER=openfga -e POSTGRES_DB=openfga -e POSTGRES_PASSWORD=... -e PGDATA=/volume/postgres

unikraft run --metro fra -n demo-fga-migrate --image <org>/demo-fga-openfga@<digest> \
  -m 256MiB --restart never --args "/usr/bin/openfga migrate" \
  -e OPENFGA_DATASTORE_ENGINE=postgres \
  -e OPENFGA_DATASTORE_URI=postgres://openfga:...@demo-fga-postgres.internal:5432/openfga?sslmode=disable

unikraft run --metro fra -n demo-fga-openfga --image <org>/demo-fga-openfga@<digest> \
  -m 512MiB --scale-to-zero policy=off --restart on-failure \
  -e OPENFGA_DATASTORE_ENGINE=postgres -e OPENFGA_DATASTORE_URI=... \
  -e OPENFGA_AUTHN_METHOD=preshared -e OPENFGA_AUTHN_PRESHARED_KEYS=... \
  -e OPENFGA_PLAYGROUND_ENABLED=false -e OPENFGA_CHECK_QUERY_CACHE_ENABLED=true

unikraft run --metro fra -n demo-fga-api --image <org>/demo-fga-api@<digest> \
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
./scripts/tunnel.sh                   # terminal 1: localhost:18080 -> 8080 (HTTP), 18081 -> 8081 (gRPC), 12112 -> 2112 (metrics)
./scripts/seed.sh                     # terminal 2: create store "demo-fga", write model + synthetic tuples
./scripts/test-remote.sh              # fga model test against the deployed server, on a fresh store
./scripts/test-integration-remote.sh  # every OpenFGA RPC against the deployed server (see Integration tests)
./scripts/check-e2e.sh                # write a tuple through the tunnel, see it (and its deletion) through the public API
```

`check-e2e.sh` also prints a fingerprint of the `demo-fga` store (store ID, latest model ID, hash of the stored tuples) and compares it with the previous run. Run it before and after a redeploy to show the data survived.

Stop `tunnel.sh` with Ctrl-C: it closes all three tunnels with one signal each, which removes their relay instances.

### Verify

```bash
./scripts/verify.sh
```

It calls the public API and checks the answers (`/health` reaches OpenFGA; `/check`, `/batch-check` and `/list-objects` allow alice and deny mallory; three `/bench` runs). It compares what `demo-fga-openfga.internal` resolves to from inside the API with the instance's current private IP. It also checks that OpenFGA and Postgres have no service, that no `demo-fga-*` instance other than the API and no open tunnel relay has a public domain (other workloads on the account are ignored), and that ports 8080/8081/3000/2112/5432 don't answer. It exits non-zero if any check fails.

To time a wake from scale-to-zero, run `./scripts/measure-wake.sh [runs]`: it waits for the API to go to standby, then times `/health` from standby and while running.

API endpoints:

- `GET /health`: API status, OpenFGA reachability, what `demo-fga-openfga.internal` resolves to, and process memory.
- `GET /check?user=user:alice&relation=can_edit&object=project:roadmap[&consistency=HIGHER_CONSISTENCY]`: one Check. The deployment enables OpenFGA's check cache, so a check right after a write can return the old answer for up to 10 s; `HIGHER_CONSISTENCY` skips the cache.
- `POST /batch-check` with `{"checks":[{"correlationId":"a","user":"…","relation":"…","object":"…"}]}`: 1 to 50 Checks in one call.
- `GET /list-objects?user=user:alice&relation=can_view&type=project`: the objects of a type the user can reach.
- `GET /bench[?n=100&user=&relation=&object=]`: up to 100 sequential Checks after 3 warm-up calls; returns p50/p95/max/min/mean in ms.
- `GET /openapi.json`: the OpenAPI document, generated from the same schemas that validate requests.

Errors are JSON, `{"_tag": "…", "message": "…"}`: `BadRequest` (400, including invalid query or body), `Busy` (429, a bench is already running) and `UpstreamError` (502, OpenFGA failed or timed out after 5 s, with its HTTP status in the message).

### Redeploy

Never restart in place; delete and run again. The volume, and so the store, model and tuples, survives, and the instances come back on the same image digests:

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
| Private service + public API over `<name>.internal` | [`scripts/deploy.sh`](scripts/deploy.sh), [`api/src/config.ts`](api/src/config.ts) | No public port on the backend; names survive redeploys, IPs don't. |
| Secrets through `unikraft run --load` | [`scripts/deploy.sh`](scripts/deploy.sh) | `-e KEY=VALUE` puts secrets in the process list; a 0600 YAML spec doesn't. |
| Pin the CLI profile in scripts | [`scripts/env.sh`](scripts/env.sh) | Scripts can't act on another account just because a different profile is active. |
| Resource-name prefix guard | [`scripts/cleanup.sh`](scripts/cleanup.sh) | Cleanup refuses to touch anything outside `demo-fga-*` on a shared account. |
| Deploy images by digest, recorded at build time | [`scripts/build.sh`](scripts/build.sh), [`scripts/env.sh`](scripts/env.sh) | A redeploy runs what was verified, not whatever `:latest` points at now. |
| Two-step build: local OCI archive, then push | [`scripts/build.sh`](scripts/build.sh) | Avoids `failed to package kernel … connection reset by peer`. |
| One-off migration instance on the private network | [`scripts/deploy.sh`](scripts/deploy.sh) | No database port exposed for migrations; the deploy stops unless it exits 0. |
| `fga model test` against a deployed store | [`scripts/test-remote.sh`](scripts/test-remote.sh) | The same test files run locally and against the deployed server's evaluation (the CLI sends test tuples as contextual tuples, so stored-tuple reads are covered by integration tests instead). |
| Store lookup by name with a short cache | [`api/src/openfga.ts`](api/src/openfga.ts) | Recreated stores are picked up without restarting the API. |
| OpenFGA SDK as an Effect service | [`api/src/openfga.ts`](api/src/openfga.ts) | One retry policy (SDK retries off), a timeout that cancels the request, and SDK errors mapped to typed API errors. |
| One schema per endpoint for validation, errors and OpenAPI | [`api/src/api.ts`](api/src/api.ts) | The OpenAPI document can't drift from what the server accepts. |
| Bundle to one file for a scratch rootfs | [`api/Dockerfile`](api/Dockerfile) | The unikernel ships Node and one `.mjs`, no `node_modules`. |

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

### `ListObjects` fails when a condition is missing context

If any grant reachable from the query has a condition and the request doesn't pass that condition's parameters, `ListObjects` returns an error instead of a shorter list. Pass `context` (here `current_time`) whenever conditional grants are in play.

### `fga model test --tests a.yaml b.yaml` runs only the first file

`--tests` takes one path or glob: `fga model test --tests 'authz/models/*.fga.yaml'`.

### `OpenFgaClient.writeAssertions` drops contextual tuples and context

In `@openfga/sdk` 0.9.7 the client sends only the tuple key and expectation. Use `OpenFgaApi.writeAssertions` (the raw API) to store assertions with `contextual_tuples` or `context`; [`assertions.test.ts`](tests/integration/assertions.test.ts) fails when the SDK starts sending them.

### Deep recursion fails at 25 levels, unless the cache already knows the answer

`viewer from parent` over a chain of folders resolves 24 levels and returns `authorization_model_resolution_too_complex` at 25 (the resolve node limit) on a cold cache, but succeeds deeper once shallower answers are cached. `ListObjects` isn't limited the same way. Don't rely on the cache to rescue deep hierarchies.

### `ReadChanges` `start_time` must come from the server's clock

The server rejects a `start_time` in the future and compares it with its own timestamps. A client clock that's off (it was through the tunnel) silently returns the wrong window; take the cutoff from a change's `timestamp`.

### `ListUsers` also fails when a condition is missing context

Like `ListObjects`, it returns `missing context parameters` instead of a shorter list.

### A deleted OpenFGA store still answers checks

OpenFGA soft-deletes stores, so a cached store ID keeps returning answers from the old store. The API re-resolves the store every 30 s and immediately when OpenFGA reports it has no model.

### The public URL changes on every `unikraft run`

Each run creates a new service with a random FQDN. For a stable name, create the service once with `unikraft services create` and attach instances with `--service`.

### Three targets in one `unikraft instances tunnel` fail

With CLI 0.5.2 the third target answers "internal tunnel error"; `scripts/tunnel.sh` runs one tunnel process per port. Under parallel load the relay also resets connections (`ECONNRESET`), so the integration suite runs its files one at a time.

### Tunnels create publicly addressable relay instances

`unikraft instances tunnel` starts a `utils/tunnel` instance (128 MiB, random `inst-*` name) that counts against your quota and has its own public FQDN while the tunnel is open. Plain HTTPS to that FQDN returns "Service not found", not your service; the tunnel traffic itself uses the CLI's relay protocol, whose authentication this demo didn't examine. The relay is removed when the tunnel process gets one SIGTERM or Ctrl-C; a second signal during that cleanup leaves the relay running (it happened here: delete leftovers by name, image `utils/tunnel`). Close tunnels when you're done; `scripts/verify.sh` fails while a relay is public.

### A Check right after a write can return the old answer

The deployment enables OpenFGA's check cache (`OPENFGA_CHECK_QUERY_CACHE_ENABLED=true`, 10 s TTL). A Check cached before a write keeps its answer until the TTL expires: on Unikraft, `check-e2e.sh` saw `false` right after writing the tuple. Ask with `consistency: HIGHER_CONSISTENCY` (`/check?...&consistency=HIGHER_CONSISTENCY`) when a read must see a write.

### The OpenFGA SDK keeps idle connections open, so the API never scales to zero

With scale-to-zero policy `on`, an instance stays up while any TCP connection is open, including its own outgoing ones. `@openfga/sdk` (0.9.7) creates `http.Agent({ keepAlive: true })` with no idle timeout, so the first Effect API stayed `running` for minutes. [`api/src/openfga.ts`](api/src/openfga.ts) passes agents that close idle sockets after 4 s, and a test checks it; the API now goes to standby about 14 s after its last request.

## Authorization models

The modules live in `authz/models/` and run unchanged locally and on Unikraft:

A project-management domain, org → team → folder → project → list → task, split into modules:

- `fga.mod`: manifest listing the modules.
- `core.fga`: users, organizations (admins, members, blocked users) and nested teams.
- `conditions.fga`: the CEL conditions (expiring grants, office network, allowed regions, plan features).
- `projects.fga`: nested folders, projects (roles, public access, blocking, sharing) and lists. A block on a project, in its org or in its folder's org also overrides direct list and task grants.
- `tasks.fga`: tasks, plus project permissions added with `extend type`.

Each feature has its own test file next to the manifest, all testing the same model. Every test checks one behaviour, is named "… should …" and spells out GIVEN/WHEN/THEN in comments. [docs/openfga-features.md](docs/openfga-features.md) walks through each one with the SDK calls that use it:

| Feature | Where in the model | Tests |
| --- | --- | --- |
| Direct relations, computed relations, inheritance (`from`) | `project`, `list`, `task` | [projects.fga.yaml](authz/models/projects.fga.yaml), [tasks.fga.yaml](authz/models/tasks.fga.yaml) |
| Group membership (`team#member`) and nested teams | `team#member`, folder/project roles | [core.fga.yaml](authz/models/core.fga.yaml) |
| Recursion (folders inside folders) | `folder#parent` | [nesting.fga.yaml](authz/models/nesting.fga.yaml) |
| Exclusion (`but not`) with grouping, passed down to lists and tasks | `project#is_blocked`, `can_edit`/`can_view` on project, list and task | [exclusion.fga.yaml](authz/models/exclusion.fga.yaml) |
| Intersection (`and`) | `project#can_share`, `project#can_export` | [intersection.fga.yaml](authz/models/intersection.fga.yaml) |
| Public access (`user:*`), permanent and expiring | `project#viewer` | [public-access.fga.yaml](authz/models/public-access.fga.yaml) |
| Conditions: timestamp, duration, ipaddress, `list<string>`, `map<string>`; on users, usersets and wildcards; mixed with plain grants | `conditions.fga` | [conditions.fga.yaml](authz/models/conditions.fga.yaml) |
| Modules and `extend type` | `fga.mod`, `tasks.fga` | [tasks.fga.yaml](authz/models/tasks.fga.yaml) |

`scripts/check-model-coverage.py` (run in CI) fails unless every relation has a passing allowed and denied check, every type has `list_objects` and `list_users` assertions, and every single-rule break of the model (a "mutant": a dropped `or` branch, `and` turned into `or`, a dropped `but not`, a dropped allowed type, a negated condition, a moved condition boundary such as `<` → `<=`, a dropped side of a condition's `&&`) makes a test fail. It caught a real bug while the model was written: lists inherited project *membership*, which let a user blocked on a project still view its lists.

With `FGA_API_URL`, `FGA_API_TOKEN` and `FGA_STORE_ID` exported (see [Quick start](#quick-start-local)):

```bash
fga model write --file authz/models/fga.mod     # new authorization_model_id per write
fga model get                                   # the combined model
fga model test --tests 'authz/models/*.fga.yaml'   # expect Tests 109/109, Checks 323/323, ListObjects 14/14, ListUsers 17/17
python3 scripts/check-model-coverage.py          # coverage gate + mutation testing
fga model transform --file authz/models/fga.mod > model.json   # combined model as JSON
```

To add a module: create `authz/models/<name>.fga`, list it in `fga.mod`, add `<name>.fga.yaml` tests beside it (the CLI refuses model files outside the test file's directory), run the coverage gate, and write the model again.

## Repository layout

- `authz/` – local Docker Compose stack (PostgreSQL, OpenFGA, Caddy; optional Playground profile).
- `authz/models/` – FGA modules and their tests.
- `authz/seed/tuples.yaml` – synthetic tuples for the demo store.
- `api/` – public demo API (Effect 4, `@openfga/sdk`, Node.js 24; bundled into one file for the unikernel), its tests, Kraftfile and Dockerfile.
- `infrastructure/unikraft/openfga/` – OpenFGA Kraftfile and Dockerfile (static Go build).
- `infrastructure/unikraft/postgres/` – PostgreSQL Kraftfile and rootfs, from the [Unikraft examples](https://github.com/unikraft-cloud/examples/tree/main/postgres) (see [NOTICE](NOTICE)).
- `scripts/` – `unikraft` CLI wrappers (build, deploy, tunnel, seed, test-remote, test-integration-remote, verify, cleanup) and the coverage gates.
- `tests/integration/` – OpenFGA integration suite (`@openfga/sdk`, `node:test`) and its throwaway compose stack.
- `versions.env` – pinned OpenFGA and fga CLI versions; `scripts/check-versions.sh` (in CI) checks every other pin against it.
- `docs/openfga-features.md` – every OpenFGA feature used here, with model excerpts, SDK calls (plain and Effect) and the tests that cover it.
- `docs/RESULTS.md` – measured results on Unikraft Cloud. `docs/archive/` holds historical notes from the legacy `kraft cloud` setup.
- `AGENTS.md` – context for AI coding agents.

## Integration tests: every OpenFGA RPC

[`tests/integration/`](tests/integration/) uses the official [`@openfga/sdk`](https://github.com/openfga/js-sdk) against a real OpenFGA, with tuples stored in PostgreSQL (and contextual tuples where a test is about them). It covers every RPC in the API definition in 151 BDD-style tests (`[rpc:<Name>] should …`, GIVEN/WHEN/THEN comments, one behaviour each):

| Area | RPCs | Also covered |
| --- | --- | --- |
| Stores | CreateStore, GetStore, ListStores, DeleteStore, UpdateStore (not implemented: asserts `Unimplemented` over gRPC) | name filter, pagination, deleted stores |
| Models | WriteAuthorizationModel, ReadAuthorizationModel, ReadAuthorizationModels | invalid models, newest-first paging, store isolation, an older pinned model answering differently from the latest |
| Tuples | Write, Read, ReadChanges | conditions, duplicate/missing handling, a batch with one bad tuple writing nothing, 409 for the same key with another condition, 100-tuple limit, partial keys, type filter, `start_time`, resuming an exhausted feed, conditional deletes |
| Queries | Check, BatchCheck, Expand, ListObjects, StreamedListObjects, ListUsers | contextual tuples (plain and conditional) on every query, context (stored context wins over the request's, mistyped values fail), consistency modes with the check cache on (grant and revocation), per-item BatchCheck errors, model pinning, 50-check and 100-contextual-tuple limits, recursion limit, missing-context errors, truncation at max results |
| Assertions | WriteAssertions, ReadAssertions | contextual tuples and context, unknown model ids, models without assertions |
| Security | — | HTTP and gRPC without a key or with a wrong key, health and metrics without a key |
| Regressions | — | fixed advisories: conditions with the check cache, duplicate BatchCheck items, conditions on the wrong grant type, ListUsers with `user:*` + `and` + `but not` (CVE-2026-61709) |
| Experimental (local/CI only) | AuthZEN: Evaluation, Evaluations, SubjectSearch, ResourceSearch, ActionSearch, GetConfiguration | inline `$expression` conditions |

```bash
docker compose -f tests/integration/docker-compose.yaml up -d --wait   # OpenFGA v1.21.0 + PostgreSQL 16, experimental tier on, list max results 100
(cd tests/integration && npm ci)
python3 scripts/check-api-coverage.py                                  # runs the suite + the API coverage gate
```

`scripts/check-api-coverage.py` fails unless every RPC has a passing `[rpc:<Name>]` test **and** shows up in OpenFGA's own `grpc_server_handled_total` metric during that run (scraped before and after), with code `OK`, or `Unimplemented` for UpdateStore. On Unikraft, `./scripts/test-integration-remote.sh` runs the same gate through the tunnel; the deployment doesn't enable experimental features, so AuthZEN is reported as excluded.

## Development

```bash
fga model test --tests 'authz/models/*.fga.yaml'
python3 scripts/check-model-coverage.py
cd api && npm ci && npm run typecheck && npm test
python3 scripts/check-api-coverage.py   # needs the tests/integration compose stack
```

CI runs these, plus `shellcheck` on the scripts, the version check, a Compose config check and a build of the API rootfs.

[Renovate](https://docs.renovatebot.com) ([`renovate.json`](renovate.json)) opens update PRs on Monday mornings, for releases at least 3 days old:

- OpenFGA server and fga CLI bumps arrive as one "OpenFGA" PR covering `versions.env`, the unikernel Dockerfile, both compose files, CI and `flake.nix`. The PR notes the manual steps: `git subtree pull` for `docs/repos/` and the `flake.nix` hashes. Until those are done, `check-versions.sh` fails it.
- npm packages (Effect grouped), Docker base images, the PostgreSQL source version, grpcurl and GitHub Actions get their own PRs.
- Major PostgreSQL and Node.js upgrades are never proposed: they need a data migration or engine and CI changes.

## Reference

- [unikraft CLI](https://unikraft.com/docs/cli/unikraft)
- [Migrating from kraft cloud](https://unikraft.com/docs/tutorials/kraftkit-to-unikraft)
- [Unikraft networking](https://unikraft.com/docs/platform/networking)
- [OpenFGA documentation](https://openfga.dev/docs) and [CLI](https://openfga.dev/docs/getting-started/cli)

## License

Apache-2.0, see [LICENSE](LICENSE). Third-party files keep their own terms, see [NOTICE](NOTICE).
