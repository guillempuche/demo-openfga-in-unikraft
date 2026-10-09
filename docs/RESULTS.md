# Results: private OpenFGA + public API on Unikraft Cloud

Run on 2026-10-04. Org `kybrion` (profile pinned via `UNIKRAFT_PROFILE`), metro `fra`, `unikraft` CLI 0.5.2, PostgreSQL 16.4. Sections 1–6 and the re-verification ran on OpenFGA v1.11.0; the last run section is the upgrade to v1.21.0. Everything (database, OpenFGA, API) runs on Unikraft Cloud; no other hosting provider is involved. Synthetic data only (`authz/seed/tuples.yaml`).

## Summary

| # | Test | Result |
| --- | --- | --- |
| 1 | Instances running, private IP and `.internal` name | ✅ |
| 2 | API → OpenFGA over `.internal`, `/bench` p50 < 10 ms warm | ✅ p50 1.0–1.3 ms; 0.74–0.87 ms with the Effect API |
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

## Richer model and coverage gate (2026-10-04)

The model grew to org → team → folder → project → list → task (41 relations, 4 conditions) with one test file per OpenFGA modeling feature. `scripts/check-model-coverage.py` checks every relation for passing allowed and denied checks and runs 79 single-rule mutants of the model; all 79 are caught. While writing it, mutation testing exposed a real exclusion bypass: lists inherited project *membership*, so a user blocked on a project could still view its lists; lists now inherit `can_view`/`can_edit` from the project.

| Run | Result |
| --- | --- |
| Local, fga 0.8.1 (embedded v1.21.0) | 28/28 tests: 190 checks, 11 ListObjects, 16 ListUsers |
| Local stack (compose, v1.21.0), `test-remote.sh` on a fresh store | same |
| Unikraft Cloud (v1.21.0) through the tunnel, fresh store | same |
| `verify.sh` after re-seeding `demo-fga` with the new model | all checks passed; `/bench` p50 1.107–1.368 ms |

## Integration suite and API coverage (2026-10-05)

`tests/integration/` (`@openfga/sdk` 0.9.7, `node:test`) calls every RPC in the API definition with stored tuples; `scripts/check-api-coverage.py` requires a passing `[rpc:X]` test and the server's own `grpc_server_handled_total` growing for each RPC during the run.

| Run | Tests | RPCs proven |
| --- | --- | --- |
| Local/CI stack (v1.21.0, PostgreSQL 16, experimental tier on) | 58/58, 2.4 s | 25/25 (19 core incl. UpdateStore = `Unimplemented`, 6 AuthZEN) |
| Unikraft Cloud through the tunnel (experimental tier off) | 51/51, 53 s | 19/19 core; AuthZEN excluded |

Things the suite surfaced:

- `OpenFgaClient.writeAssertions` (SDK 0.9.7) drops contextual tuples and context; the raw `OpenFgaApi` keeps them.
- The recursion limit is 25 levels on a cold cache (24 resolve) but cached answers let deeper checks succeed; `ListObjects` isn't limited the same way.
- `ListUsers`, like `ListObjects`, errors when a reachable condition is missing context.
- `ReadChanges` compares `start_time` with the server's clock; the tunnel exposed client/server clock skew.
- Over the tunnel: three targets in one `unikraft instances tunnel` fail; parallel load causes `ECONNRESET`, so files run serially (51/51 in 3 consecutive runs). Killing a tunnel with two signals left three relays running and public; they were deleted, and `tunnel.sh` now stops each tunnel with exactly one SIGTERM (relays gone in ~2 s).

## API on Effect 4 and the OpenFGA SDK (2026-10-05)

The API was rebuilt on Effect 4.0.0 (`HttpApi`) and `@openfga/sdk` 0.9.7, bundled into one 976 KB `.mjs` file. Only `demo-fga-api` was replaced; OpenFGA, Postgres and the store stayed up. `verify.sh` now checks the answers, not only the status codes, and calls `/batch-check` and `/list-objects`.

| | Before (`node:http` + `fetch`) | After (Effect + SDK) |
| --- | --- | --- |
| `verify.sh` | all checks passed | all checks passed |
| `/bench` p50 (3 runs, n=100) | 1.378 / 1.111 / 1.166 ms | 0.866 / 0.801 / 0.741 ms |
| `/bench` p95 | 4.669 / 2.173 / 2.677 ms | 1.745 / 5.471 / 1.948 ms |
| RSS idle → after 3 benches | 26.2 → 34.2 MiB | 25.4 → 35.3 MiB |
| Standby after the last request | yes | yes, about 14 s later (after the fix below) |
| `/health` from a fresh connection: woken from standby / warm | n/a | 0.75–0.80 s / 0.49–0.60 s |

The first deployment never went to standby: after 251 s idle it was still `running`. Under scale-to-zero policy `on`, an instance stays up while any TCP connection is open. The SDK creates `http.Agent({ keepAlive: true })` with no idle timeout, so its pooled connections to OpenFGA never closed (the old `fetch` client drops idle ones after about 4 s). The API now passes agents that close idle sockets after 4 s, and `server.test.ts` checks that no idle connection to OpenFGA is left after 5 s; that test fails without the fix.

## Services and connections, end to end (2026-10-05)

Scripted checks with pass/fail output, run against the deployment above:

| Check | Script | Result |
| --- | --- | --- |
| `demo-fga-openfga.internal`, resolved inside the API, equals the instance's current private IP | `verify.sh` | ✅ 10.0.6.149 = 10.0.6.149, before and after a full redeploy |
| Tuple written through the tunnel → public API `/check` and `/list-objects` see it → deleted → `/check` denies | `check-e2e.sh` | ✅ all 5 checks, before and after a full redeploy |
| Store, latest model and stored tuples survive `cleanup.sh` + `deploy.sh` (volume kept) | `check-e2e.sh` fingerprint | ✅ same store ID, model ID and tuple hash; the migration found schema version 6 |
| API answer time from standby vs running (`/health`, new TLS connection, 10 runs) | `measure-wake.sh` | from standby p50 0.760 s (0.673–0.891), running p50 0.550 s (0.436–0.621): waking adds about 0.21 s |
| Tunnel relays left after closing the tunnel with one SIGTERM | `verify.sh` | ✅ none, twice |

The first `check-e2e.sh` run failed in a useful way. The deployment enables OpenFGA's check cache (`OPENFGA_CHECK_QUERY_CACHE_ENABLED=true`, 10 s TTL), so the Check right after the write returned the `false` cached by the Check before it. `/check` now takes `consistency=HIGHER_CONSISTENCY`, which skips the cache, and the script uses it for reads that must see a write. (The same run also had a jq bug: `.allowed // "error"` turns `false` into `"error"`.)

## Official binary, production settings, scale-to-zero and a stable URL (2026-10-06)

Deployed with `cleanup.sh && deploy.sh` (volume kept), then checked with `check-e2e.sh`, `test-remote.sh`, `test-integration-remote.sh` and `verify.sh`.

| Check | Result |
| --- | --- |
| OpenFGA binary | The official `openfga/openfga:v1.21.0` binary (commit `ab557c55`, from the cosign-signed index digest), not a source build |
| Baked defaults | The image config holds only the 6 non-secret settings; the migration found schema version 6 in Postgres with `deploy.sh` no longer setting the engine, and logs are JSON |
| Production settings | OpenFGA's startup config shows preshared authn, max results 100, 10 concurrent reads, max open connections 20, datastore metrics and RPC histograms on |
| Public URL | `demo-fga-api-cux9mlq9.fra.unikraft.app` before and after a full redeploy; with no instance attached the domain answers HTTP 404 |
| Pinned model | `/health` reports `{"id":"01M471HC7HHMGCKMQ097G2RK8D","pinned":true}`; a second `seed.sh` reported "model unchanged" |
| Data across the redeploy | `check-e2e.sh`: same store and tuple hash (only the model id changed, written by `seed.sh` before the redeploy); write → API → delete passed |
| `fga model test` remote | 109/109 tests, 323/323 checks, 14/14 ListObjects, 17/17 ListUsers |
| Integration suite remote | 138/138 twice in a row; API gate 19/19 core RPCs (AuthZEN excluded: experimental tier off) |
| `verify.sh` | All checks passed, including pinned digests, restart policy `always` and the persistent service group |
| `/bench` p50 (3 runs, n=100) | 1.083 / 0.931 / 0.761 ms |
| API memory | 28.7 MiB RSS after the benches |
| API wake from standby (`measure-wake.sh`, 10 runs) | p50 0.946 s from standby vs 0.730 s running (+0.22 s). Maxima of 12 s and 6 s came from this machine's network path, the same VPN that dropped the tunnel during these runs |

### Restart policies (throwaway `demo-fga-restart-test` instances, deleted after)

| Policy | App exits 1 | App exits 0 |
| --- | --- | --- |
| `on-failure` | restarted (start count 2 → 5, back-off 0 / 5 / 10 s) | stays stopped |
| `always` | restarted | restarted |

Postgres, OpenFGA and the API now use `always`; the migration keeps `never`.

### What the platform's HTTP proxy sends (throwaway instance echoing its request)

| Header | Received by the instance |
| --- | --- |
| `X-Forwarded-For` | The caller's public address; a forged `X-Forwarded-For: 1.2.3.4` was replaced, not appended |
| `X-Real-IP` | Passed through unchanged when the caller sends one (so never trusted) |
| TCP peer | The proxy's private address (`::ffff:10.0.10.126`) |

The API reads `user_ip` from `X-Forwarded-For` on Unikraft (`CLIENT_IP_FROM=x-forwarded-for`).

### Postgres scale-to-zero

| OpenFGA pool | Postgres with `idle` + `stateful` |
| --- | --- |
| Production guide's warm pool (min open 5, min idle 3) | Stayed `running` for 6.5 minutes with no traffic |
| No minimum pool, idle connections closed after 30 s | `standby` after ~89 s |

Measured from inside the network (the API's own `ms` for `/check?…&consistency=HIGHER_CONSISTENCY`, which skips OpenFGA's cache):

| Round | First check from Postgres standby | Next 3 checks |
| --- | --- | --- |
| 1 | 83.4 ms | 7.9, 7.5, 8.6 ms |
| 2 | 82.8 ms | 7.9, 7.4, 7.8 ms |
| 3 | 80.9 ms | 7.3, 6.9, 7.5 ms |

The deployment uses scale-to-zero. Checks answered from OpenFGA's 10 s check cache never reach Postgres.

### Two findings from running the suite against the deployment

- **Tunnel connections.** Three remote runs had 117, 131 and 132 of 138–139 tests passing. The failures were 10 s client timeouts and `ECONNRESET`, on different tests each time. OpenFGA's own log showed all 986 requests answered, the slowest in 976 ms (gRPC reflection), with only the response codes the tests expect. With one connection per request instead of kept-alive ones, two runs in a row passed 138/138 with no timeouts.
- **ReadChanges clocks.** A cutoff 1 ms after a change's `timestamp` still returned that change. OpenFGA converts `start_time` to a ULID with its own clock and filters on the changes' ULIDs, but `timestamp` is Postgres's `inserted_at` (`docs/repos/openfga/pkg/server/commands/read_changes.go`, `pkg/storage/postgres/postgres.go`), and the two run on different machines here. The test now takes the cutoff from OpenFGA's `Date` header.

## TLS on both private hops (2026-10-08)

The API reaches OpenFGA over HTTPS and OpenFGA reaches PostgreSQL with `sslmode=verify-full`, each checking the server's certificate against a private CA (`scripts/tls.sh`). Deployed with `deploy.sh` on the existing volume (data written by PostgreSQL 16.4, now served by the 16.14 image built with OpenSSL), then checked with `check-tls.sh`, `verify.sh`, `check-e2e.sh`, `test-remote.sh` and `test-integration-remote.sh`.

Before building on it, a throwaway `demo-fga-tls-probe` instance (deleted after, with its image) answered the one open question: OpenFGA watches its certificate files with inotify, and would stop at startup without it. On Unikraft base-compat it started with HTTP TLS on (`Initial TLS certificate loaded`, `Starting certificate watcher...`); a multi-line PEM passed as an environment variable arrived intact, and `/tmp` kept 0600. Through a tunnel: TLS 1.3 with the CA verified, refused without the CA, plain HTTP 400.

| Check | Result |
| --- | --- |
| Certificates before deploying (`check-certificates.mjs`) | CA, `postgres.crt` and `openfga.crt`: chain, key and hostname OK, 364 days left |
| Migration over `verify-full` | Exit 0 on the first attempt (schema version 6, nothing to migrate) |
| OpenFGA HTTP API (`check-tls.sh`) | Certificate verified for `demo-fga-openfga.internal`, TLS 1.3; plain HTTP answers 400 |
| OpenFGA gRPC | Certificate verified, TLS 1.3, ALPN `h2` |
| PostgreSQL | Certificate verified for `demo-fga-postgres.internal` (STARTTLS), TLS 1.3; an unencrypted client gets "no encryption" |
| OpenFGA's connections to PostgreSQL | 1 of 1 encrypted, TLS 1.3 (`pg_stat_ssl`) |
| API → OpenFGA | `/health` reports OpenFGA `ok`, which with plain text refused can only be over TLS |
| `verify.sh` | All checks passed (exposure, pinned digests, restart policy, service group, `.internal` = private IP) |
| `/bench` p50 (3 runs, n=100) | 1.214 / 0.925 / 0.901 ms (plain text on 2026-10-06: 1.083 / 0.931 / 0.761 ms): kept-alive connections pay the TLS handshake once |
| Data across the change | `check-e2e.sh`: store, model and tuples match the run of 2026-10-06; write through the tunnel → API → delete passed |
| `fga model test` remote | All test files passed (`test-remote.sh` exit 0), through the tunnel's local TLS client |
| Integration suite remote | 138/138 through the tunnel's local TLS client; API gate 19/19 core RPCs (AuthZEN excluded: experimental tier off). A first run stopped when one tunnel's control connection to the relay broke on this machine's VPN (`control relay … broken pipe`, as in the README); its relay was cleaned up, and the script now says when the tunnel is down instead of exiting silently |
| Memory | OpenFGA 20.2 MiB RSS (17.6 MiB in plain text), API 25.1 MiB RSS |
| Tunnel ports | All on `127.0.0.1`: the tunnels' TLS ports (19080, 19081) and `tls-forward.mjs`'s plain ports (18080, 18081) |

Locally and in CI: `check-tls-chain.sh` 11/11 (the API and OpenFGA images under the private names), `check-postgres-image.sh` with and without TLS, the integration suite 151/151 and the API coverage gate (25 RPCs) over TLS, 27/27 API integration tests and 161/161 API tests including the TLS cases.

### Alpine 3.24, and the wake-up paths with TLS (2026-10-09)

Redeployed with the PostgreSQL image rebuilt on Alpine 3.24 (#4; digest `f42e7045…`), then measured the two paths that open new TLS connections: the API waking from standby, and OpenFGA reconnecting to a PostgreSQL that scaled to zero.

| Check | Result |
| --- | --- |
| `check-tls.sh`, `verify.sh` | All checks passed; migration exit 0 on the first attempt |
| `/bench` p50 (3 runs, n=100) | 1.120 / 0.875 / 0.928 ms |
| API wake from standby (`measure-wake.sh`, 10 runs) | p50 0.716 s from standby vs 0.479 s running (+0.24 s; +0.21–0.22 s in plain text) |
| First uncached check after PostgreSQL standby (3 rounds, standby after 102–119 s of quiet) | 122.2 / 121.6 / 119.6 ms (plain text: 80.9–83.4 ms); the next checks 7.2–9.0 ms |

The ~38 ms added after a PostgreSQL wake-up is the TLS handshake on the fresh connection OpenFGA opens (plus SCRAM authentication, as before). Keeping one connection open would avoid it but would also keep PostgreSQL from ever scaling to zero (see "Postgres scale-to-zero" above). Checks answered from OpenFGA's check cache, and every check while the pool is warm, don't pay it.

Later the same day, the API bundled with Rolldown instead of esbuild (787 KB instead of 1,005 KB; locally, 99 ms instead of 126 ms from start to the first answer) and with the shutdown fix: `verify.sh` passed, `/bench` p50 1.101 / 0.877 / 0.856 ms, and two `measure-wake.sh` runs gave p50 0.733 s and 0.694 s from standby (0.716 s with esbuild that morning; fastest 0.610 s against 0.681 s). Over this machine's network the requests to an instance that was already running varied from 0.46 to 1.71 s, more than the 20–27 ms the smaller bundle saves, so the gain isn't visible from here; there is no regression.

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
