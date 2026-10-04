# Results: private OpenFGA + public API on Unikraft Cloud

Org `kybrion` (profile pinned via `UNIKRAFT_PROFILE`), metro `fra`. CLI: `unikraft` 0.5.2.

**Status (2026-10-02): code ready and verified locally; the cloud run hasn't been done yet.**
Every cloud item below is **NOT RUN**. Fill each one in from the command next to it.

## Verified locally

| Check | Result |
| --- | --- |
| `unikraft build infrastructure/kraftcloud/openfga` (fixed Kraftfile, spec v0.7) | ✅ built in ~2 min to a local OCI archive. Before the fix: `dockerfile context does not exist`. |
| `fga model test` (embedded, `model_file`) | ✅ projects 5/5 tests, 15/15 checks |
| `fga model test` remote mode against a running OpenFGA (`scripts/test-remote.sh`) | ✅ 10/10 tests, 31/31 checks (projects + tasks). With the server stopped it doesn't pass, which confirms remote mode. |
| OpenFGA (preshared auth) call without the key | ✅ `401` |
| API `/check` allowed / denied | ✅ `alice can_edit project:roadmap` → `true`; `mallory` → `false` |
| API `/bench` (local Docker, check cache on) | p50 0.995 ms, p95 2.383 ms, max 4.363 ms (n=100) |
| `scripts/seed.sh` idempotency | ✅ second run rewrites the model and tuples without errors |
| `scripts/deploy.sh` rendered specs (`unikraft run --load … --dry-run`, dummy secrets) | ✅ OpenFGA: no service, `scale-to-zero policy=off`, 512MiB. API: `443:8080/http+tls`, `80:443/http+redirect`, 512MiB |

The `demo-fga-api` unikernel image hasn't been built with `unikraft build` yet; the server itself ran locally with Node 24. The image follows the official `httpserver-node26` example shape (Node 24 binary + musl in a scratch rootfs).

## Cloud tests

### 1. Both instances running, private IP and `.internal` name: NOT RUN

```bash
./scripts/deploy.sh openfga && ./scripts/deploy.sh api
unikraft instances get demo-fga-openfga -f name,state,networks,service
unikraft instances get demo-fga-api -f name,state,networks,service.domains
```

Note: `unikraft instances get` exposes `networks.*.private-ip` but has **no field for the private FQDN**, so it won't show the `.internal` name. The private FQDN is `<instance-name>.internal` by platform convention ([networking docs](https://unikraft.com/docs/platform/networking)). The API's `/health` returns what `demo-fga-openfga.internal` resolves to from inside the network, so it can be compared with the private IP.

| Field | demo-fga-openfga | demo-fga-api |
| --- | --- | --- |
| state | | |
| private IP | | |
| `.internal` resolves to (from `/health`) | | n/a |
| public FQDN | none | |

### 2. API → OpenFGA over `.internal`; `/bench` p50 < 10 ms warm: NOT RUN

```bash
./scripts/verify.sh
```

| Run | p50 | p95 | max |
| --- | --- | --- | --- |
| 1 | | | |
| 2 | | | |
| 3 | | | |

`OPENFGA_CHECK_QUERY_CACHE_ENABLED=true` is set (default TTL 10 s), so a warm repeated Check is served from OpenFGA's memory and mostly measures the API→OpenFGA hop on the internal network. To measure with a Neon round-trip on every Check, redeploy OpenFGA with `OPENFGA_CHECK_QUERY_CACHE_ENABLED=false ./scripts/deploy.sh openfga`.

### 3. No OpenFGA port reachable from the internet; no key → rejected: NOT RUN

```bash
./scripts/verify.sh                                  # service of demo-fga-openfga + ports 8080/8081/3000/2112 on the public FQDN
./scripts/tunnel.sh &                                # then, without a key:
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:18080/stores/<store-id>/check \
  -d '{"tuple_key":{"user":"user:alice","relation":"owner","object":"project:roadmap"}}'   # expect 401
```

| Check | Result |
| --- | --- |
| `demo-fga-openfga` service | |
| public FQDN :8080 / :8081 / :3000 / :2112 | |
| tunnel call without key | |

### 4. Redeploy (delete + run, never restart): NOT RUN

```bash
unikraft instances get demo-fga-openfga -f networks      # IP before
./scripts/cleanup.sh && ./scripts/deploy.sh
unikraft instances get demo-fga-openfga -f networks      # IP after
curl -s https://<api-fqdn>/health                        # resolved + openfga ok, no config change
```

| Question | Answer |
| --- | --- |
| Private IP before / after | |
| Did it change? | |
| `.internal` resolves after redeploy without config changes? | |

The API holds no IP or store ID; it uses `demo-fga-openfga.internal` and looks up the store by name. Neon keeps the store, model and tuples across redeploys.

### 5. `fga model test` against the deployed instance through the tunnel: NOT RUN

```bash
./scripts/tunnel.sh        # terminal 1
./scripts/seed.sh          # terminal 2 (first time only)
./scripts/test-remote.sh
```

Result:

### 6. Memory and monthly cost estimate

| Item | Value |
| --- | --- |
| Requested memory | 512MiB (OpenFGA) + 512MiB (API) = **1 GiB** |
| Quota after deploy | 6/8 instances, ~6.8/8.0 GiB (was 4 instances, 5.8 GiB). `tunnel` adds a temporary relay instance while it runs. |
| Measured memory use | NOT RUN (check `unikraft quotas` / logs after deploy) |
| Unikraft cost | Team plan is a flat **$39/month** for 8 running instances / 8 vCPU / 8 GiB ([pricing](https://unikraft.com/pricing)). Both instances fit inside that quota, so the expected **marginal cost is $0/month**. The pricing page doesn't state any per-usage billing inside the quota; confirm on the invoice. |
| Neon | Billed separately on the Neon plan (not included above). |

## Cleanup (only `demo-fga-*`)

```bash
./scripts/cleanup.sh            # unikraft instances delete demo-fga-api demo-fga-openfga
./scripts/cleanup.sh --images   # also delete the <org>/demo-fga-* images
unikraft instances list         # confirm no tunnel relay instance is left behind
```
