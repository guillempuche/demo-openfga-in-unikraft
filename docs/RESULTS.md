# Results: private OpenFGA + public API on Unikraft Cloud

Run on 2026-10-04. Org `kybrion` (profile pinned via `UNIKRAFT_PROFILE`), metro `fra`, `unikraft` CLI 0.5.2, PostgreSQL 16.4. Sections 1–6 and the re-verification ran on OpenFGA v1.11.0; the last run section is the upgrade to v1.21.0. Everything (database, OpenFGA, API) runs on Unikraft Cloud; no other hosting provider is involved. Synthetic data only (`authz/seed/tuples.yaml`).

## Summary

| # | Test | Result |
| --- | --- | --- |
| 1 | Instances running, private IP and `.internal` name | ✅ |
| 2 | API → OpenFGA over `.internal`, `/bench` p50 < 10 ms warm | ✅ p50 1.0–1.3 ms |
| 3 | No OpenFGA (or Postgres) port reachable from the internet; no key → rejected | ✅ |
| 4 | Redeploy (delete + run): IPs change, `.internal` keeps working with no config change | ✅ IPs changed and were reused across instances |
| 5 | `fga model test` against the deployed instance through the tunnel | ✅ 10/10 tests, 31/31 checks (before and after redeploy) |
| 6 | Memory and monthly cost | 1.5 GiB allocated, ~1 GiB active; see below |

## 1. Instances, private IPs and `.internal`

```bash
unikraft instances list -f name,state,resources.memory,resources.vcpus,image
unikraft instances get demo-fga-openfga -f name,state,networks,service
```

First deploy:

| Instance | State | Private IP | Public FQDN |
| --- | --- | --- | --- |
| `demo-fga-postgres` | running | 10.0.6.89 | none |
| `demo-fga-openfga` | running | 10.0.6.137 | none |
| `demo-fga-api` | running → standby when idle | 10.0.6.149 | `morning-tree-fun8q86w.fra.unikraft.app` |

`unikraft instances get` shows the private IP (`networks.*.private-ip`), but it has **no field for the private FQDN**, so the `.internal` name never appears in CLI output. The name is `<instance-name>.internal` by platform convention, and the deployment proves it resolves:

- `demo-fga-migrate` and `demo-fga-openfga` reached Postgres at `demo-fga-postgres.internal:5432`.
- The API's `/health` reports `"openfgaHost":"demo-fga-openfga.internal","resolved":"10.0.6.137"`, which is exactly OpenFGA's private IP.

## 2. API → OpenFGA over `.internal`, latency

```bash
./scripts/verify.sh      # /health, /check, 3 × /bench (n=100, 3 warm-up calls)
```

`/bench` times each Check from the API instance to OpenFGA over the internal network (HTTP, keep-alive, preshared key).

| Run | Config | Check | p50 | p95 | max |
| --- | --- | --- | --- | --- | --- |
| first deploy | cache on | alice `can_edit` project:roadmap (direct) | 1.322 | 2.146 | 5.287 |
| first deploy | cache on | same | 1.160 | 2.398 | 2.841 |
| first deploy | cache on | same | 1.108 | 1.802 | 3.196 |
| after redeploy | cache on | same | 1.322 | 2.050 | 7.999 |
| after redeploy | cache on | same | 1.037 | 2.236 | 2.997 |
| after redeploy | cache on | same | 1.074 | 1.612 | 3.439 |
| OpenFGA redeployed | **cache off** | same (1 DB query) | 1.469–1.753 | 2.334–3.955 | 2.834–11.884 |
| OpenFGA redeployed | **cache off** | bob `can_view` list:backlog (multi-hop) | **40.218** | 60.630 | 100.351 (min 3.08) |
| OpenFGA redeployed | cache on | bob `can_view` list:backlog | 1.400 | 4.497 | 9.171 |

All times in ms. `/check`: alice → `allowed: true`, mallory → `allowed: false`.

- **The p50 < 10 ms target holds by a wide margin:** about 1.1 ms warm, and about 1.5 ms even with OpenFGA's check cache off for a direct check, which includes one Postgres round trip over `.internal`.
- **Open item:** an uncached multi-hop check (list → project → role) has a p50 of about 40 ms but a minimum of 3 ms. That pattern looks like a per-round-trip stall such as TCP delayed-ACK rather than slow queries; it's not investigated. With the default check cache, warm multi-hop checks are about 1.4 ms.
- **Public latency from the test machine is about 117 ms per request on a keep-alive connection**, which equals the ping RTT (121–143 ms over a VPN). Server time is negligible next to the client link. A fresh TLS connection adds about 0.3–0.9 s from this machine.

## 3. Exposure and authentication

| Check | Result |
| --- | --- |
| `demo-fga-openfga` service | none (`{"domains":[],"name":""}`) |
| `demo-fga-postgres` service | none |
| Public FQDN `:8080`, `:8081`, `:3000`, `:2112`, `:5432` | no answer (`000`), before and after redeploy |
| OpenFGA through tunnel, no `Authorization` | `401` `bearer_token_missing` |
| OpenFGA through tunnel, wrong key | `401` |

OpenFGA listens on 8080 (HTTP), 8081 (gRPC) and 2112 (metrics); the Playground (3000) is disabled. None of these ports is published, and the API's FQDN is the only public name in the deployment while no tunnel is open (see [section 5](#5-model-tests-through-the-tunnel) for tunnel relays). Private IPs (`10.0.6.x`) aren't routable from the internet.

## 4. Redeploy (delete + run, never restart)

```bash
./scripts/cleanup.sh            # deletes the instances, keeps volume demo-fga-pgdata
./scripts/deploy.sh             # postgres → migrate → openfga → api, 32 s
```

| Instance | IP before | IP after redeploy | After OpenFGA-only redeploys |
| --- | --- | --- | --- |
| `demo-fga-postgres` | 10.0.6.89 | 10.0.6.137 | — |
| `demo-fga-openfga` | 10.0.6.137 | 10.0.6.149 | 10.0.6.89 → 10.0.6.149 |
| `demo-fga-api` | 10.0.6.149 | 10.0.6.93 | — |

- **Private IPs change on every redeploy and are reused across instances.** After the redeploy, OpenFGA's old IP belonged to Postgres, so a hard-coded IP would silently reach the wrong service.
- **`.internal` keeps working with no config change.** `/health` resolved `demo-fga-openfga.internal` to the new IP each time (`10.0.6.149`, then `10.0.6.89`, then `10.0.6.149`). The API kept running across the OpenFGA-only redeploys and picked up the new address immediately.
- **Data persisted on the volume:** the migration found schema version 6 and did nothing, the store ID stayed `01M43PKQXFJA20RGHBE6BJ9DHE`, and all checks returned the same answers.
- **The public FQDN changed** (`morning-tree-fun8q86w` → `old-water-qgiq6eot`) because each `run` creates a new service. For a stable public name, create a service once (`unikraft services create`) and attach with `--service`.

## 5. Model tests through the tunnel

```bash
./scripts/tunnel.sh             # terminal 1: localhost:18080 → fra/demo-fga-openfga:8080
./scripts/seed.sh               # first time only: store demo-fga, model, 5 tuples
./scripts/test-remote.sh
```

| When | Result |
| --- | --- |
| First deploy | Tests 10/10, Checks 31/31 |
| After redeploy | Tests 10/10, Checks 31/31 |

`fga model test` only queries the server when the test file has no `model_file`, so `test-remote.sh` strips that line. Locally, the same command doesn't pass with the server stopped, which confirms remote mode.

The tunnel creates a relay instance (`utils/tunnel`, 128MiB, random name such as `inst-s60mq`) and removes it when the tunnel closes; verified for every tunnel used here. While open, the relay has its own public FQDN: plain HTTPS to it returns the platform's "Service not found" page, not OpenFGA, and the CLI's relay protocol (which carries the tunnel) wasn't examined. Close tunnels when done; `scripts/verify.sh` now fails while one is open.

## 6. Memory and cost

| Instance | Allocated | Measured |
| --- | --- | --- |
| `demo-fga-postgres` | 512MiB, 1 vCPU, volume 512MiB (14% used) | — |
| `demo-fga-openfga` | 512MiB, 1 vCPU | RSS 17.6 MiB, Go heap in use 13.4 MiB (Prometheus metrics via tunnel) |
| `demo-fga-api` | 512MiB, 1 vCPU, scale-to-zero (5 s cooldown) | RSS 26.0 MiB, heap 12.2 MiB (`/health`) |
| tunnel relay (only while tunnelling) | 128MiB | — |

- Quota in steady state: 2 active instances (the API is in standby when idle), 1.0 GiB active of 4.0 GiB, 512MiB of 1 GiB volume space. With the API awake it's 3 instances and 1.5 GiB.
- The allocations are generous: OpenFGA and the API each use under 30 MiB. Both could likely run at 128–256MiB.
- **Cost:** Unikraft prices plans as flat monthly fees with included quotas ([pricing](https://unikraft.com/pricing): Hobby $0 for 2 running instances / 4 GiB; Team $39/month for 8 running / 8 GiB). The `kybrion` quota (16 instances, 4 GiB, 1 vCPU per instance) doesn't match a published plan, so its fee isn't known from here. The demo stays inside that quota, so the expected **marginal cost is $0/month**. Note that on Hobby, the 2-running-instance cap would be hit whenever the API wakes, so Team is the smallest published plan that fits.

## Re-verification after the code-review fixes (2026-10-04, later the same day)

All three images rebuilt from `infrastructure/unikraft/` (after the folder rename) and redeployed from scratch on a new volume, then deleted and run again.

| Check | First deploy | After delete + run |
| --- | --- | --- |
| `deploy.sh` (postgres → migrate → openfga → api) | 31 s; migration from schema version 0, exit 0 on the first attempt | 23 s; migration found version 6, exit 0, no changes |
| Private IPs (postgres / openfga / api) | 10.0.6.137 / 10.0.6.93 / 10.0.6.89 | 10.0.7.241 / 10.0.6.137 / 10.0.6.93 (reused across instances again) |
| `/health` `resolved` for `demo-fga-openfga.internal` | 10.0.6.93 | 10.0.6.137 |
| `/bench` p50 (3 runs) | 1.350 / 1.041 / 1.094 ms | 1.340 / 1.018 / 1.057 ms |
| `/check` alice / mallory | true / false | true / false |
| `verify.sh` (new: exits non-zero on any failure) | all checks passed | all checks passed |
| `test-remote.sh` | 10/10 tests, 31/31 checks | 10/10, 31/31; store ID `01M43VXF…` unchanged |
| No key through the tunnel | `401` | — |
| Postgres `SHOW max_wal_size` (psql through a tunnel to 5432) | `128MB` (default would be 1GB) | — |
| API RSS | 26.1 MiB | 26.1 MiB |

- The rebuilt API runs the restructured module (`createApp`, listen only when run directly) correctly in the unikernel.
- The first-deploy `verify.sh` run happened while a tunnel was open; listing public domains surfaced the relay's public FQDN (see [section 5](#5-model-tests-through-the-tunnel)). That version of `verify.sh` only listed it and passed; it now fails while a relay is public. The after-redeploy run had no tunnel open.
- The Postgres rebuild was fast because the WAL cap lives in the Kraftfile `cmd`, not the Dockerfile: a later local rebuild showed 41 `CACHED` steps and took 19 s. A cold build still compiles PostgreSQL from source (11.5 min).

## Upgrade to OpenFGA v1.21.0 (2026-10-04)

The unikernel image was rebuilt from v1.21.0 (Go 1.26.8, version stamped into the binary, `/tmp` added to the rootfs) and deployed onto the existing `demo-fga-pgdata` volume, which v1.11.0 had written. fga CLI 0.8.1 (embedded OpenFGA v1.21.0) ran the model tests.

| Check | Result |
| --- | --- |
| `deploy.sh` | 22 s; the migration found schema version 6 (unchanged since v1.11), exit 0, no changes |
| Data | Store `demo-fga` kept its ID (`01M43VXF…`), model and tuples |
| OpenFGA logs | `build.version: v1.21.0`; only warnings are the expected "TLS is disabled" ones (no unix-socket fallback) |
| `verify.sh` | all checks passed; `/bench` p50 1.286 / 1.032 / 1.080 ms |
| `test-remote.sh` (fga 0.8.1) | 10/10 tests, 31/31 checks |
| No key through the tunnel | `401` |
| Local stack (compose, v1.21.0) | migrated an existing v1.11 database with no changes; quick start, model tests and the `playground` profile work |

Breaking change handled: since v1.14 the Playground refuses to start with preshared-key authentication, so the local stack runs it as an optional unauthenticated profile on 127.0.0.1 only.

## Build notes

- Building OpenFGA from its Kraftfile failed with `dockerfile context does not exist` until the `rootfs` path was fixed.
- `unikraft build --output <org>/<image>` failed 6/6 times with `failed to package kernel … connection reset by peer`. S3 resets the runtime download while it's streamed into the registry upload (the test machine is on a VPN, MTU 1420). Building to a local OCI archive and then `unikraft images copy` works; `scripts/build.sh` does that.
- The Postgres image compiles PostgreSQL from source under amd64 emulation on Apple Silicon: 11.5 min the first time. Pushing over the VPN took up to about 10 min per image.
- `unikraft instances get`, `wait` and `delete` print `runtime.env` (secrets) unless output is limited. The scripts use `-f` field selection or `-o quiet`.

## Cleanup (only `demo-fga-*`)

```bash
./scripts/cleanup.sh            # instances: demo-fga-api, demo-fga-openfga, demo-fga-postgres
./scripts/cleanup.sh --all      # also volume demo-fga-pgdata and images kybrion/demo-fga-*
unikraft instances list         # confirm nothing (including tunnel relays) is left
```
