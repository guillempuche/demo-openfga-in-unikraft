# Unikraft Cloud REST API (v1)

The `unikraft` CLI wraps this REST API.
Reach for the API directly — via `unikraft api <endpoint>` or any HTTP client — when you need behavior the CLI doesn't expose, or when building automation/CI.
Official reference: <https://unikraft.com/docs/api/v1/>.

Targets API **`v1`** as exposed by the `unikraft` CLI `0.4.x`.
The API is a platform service, unchanged from the legacy kraftkit era; endpoint shapes and the response envelope have been stable.
Re-verify against the official docs if you're on a different API major.

## Base URL (per metro)

One host per metro, all at path prefix `/v1`:

- `https://api.fra.unikraft.cloud/v1` — Frankfurt
- `https://api.dal.unikraft.cloud/v1` — Dallas
- `https://api.sin.unikraft.cloud/v1` — Singapore
- `https://api.was.unikraft.cloud/v1` — Washington
- `https://api.sfo.unikraft.cloud/v1` — San Francisco

Never call `api.fra0.unikraft.cloud` — that legacy host is deprecated (see the **Metro Names** rule in `SKILL.md`).
Same goes for `dal0`, `sin0`, etc.

## Authentication

Send your Unikraft Cloud token as a bearer token.
`unikraft api <endpoint>` does this for you using the logged-in profile; for a raw client, pass the token yourself:

```bash
# Via the CLI (uses the active `unikraft login` profile):
unikraft api /v1/instances

# Raw, any HTTP client:
curl https://api.fra.unikraft.cloud/v1/instances \
  -H "Authorization: Bearer $UKC_TOKEN" \
  -H "Content-Type: application/json"
```

## Standard response envelope

Every response (success or failure) uses the same shape:

```json
{
  "status": "success" | "error",
  "message": "human-readable summary",
  "data": { "...resource-specific..." },
  "errors": [ { "status": 401, "message": "..." } ],
  "op_time_us": 1234
}
```

Bulk endpoints return `data.<resource>` as an array; each item carries its own per-item `status` so a 200 on the envelope can still contain per-item errors.

## Resources and endpoints

| Resource             | Base path                                       | Typical methods          | Purpose                                            |
| -------------------- | ----------------------------------------------- | ------------------------ | -------------------------------------------------- |
| Instances            | `/v1/instances`                                 | GET, POST, PATCH, DELETE | Unikernel VMs — create, list, inspect, update      |
| Instance control     | `/v1/instances/{start,stop,suspend,wait}`       | PUT (GET for `wait`)     | Lifecycle transitions, optionally with timeouts    |
| Instance telemetry   | `/v1/instances/{log,metrics}` (+ `/{uuid}/...`) | GET                      | Console logs (base64) and CPU/mem/net metrics      |
| Templates            | `/v1/instances/templates`                       | GET, POST, PATCH, DELETE | Snapshot a stopped instance for reuse              |
| Service groups       | `/v1/servicegroups`                             | GET, POST, PATCH, DELETE | Load balancer + port mapping that fronts instances |
| Volumes              | `/v1/volumes`                                   | GET, POST, PATCH, DELETE | Persistent storage                                 |
| Volume attach/detach | `/v1/volumes/{attach,detach}`                   | PUT                      | Wire a volume to a running instance                |
| Images               | `/v1/images`                                    | GET                      | List images available to the account in that metro |
| Certificates         | `/v1/certificates`                              | GET, POST, PATCH, DELETE | TLS certs for custom domains                       |
| Autoscale            | `/v1/autoscale`                                 | GET, POST, DELETE        | Scaling policies bound to a service group          |
| Node                 | `/v1/node`                                      | GET                      | Metro/node health                                  |
| Users / quotas       | `/v1/users`, `/v1/users/quotas`                 | POST, GET                | Account provisioning and quota inspection          |

## How it maps to `unikraft` commands

| CLI command                     | Endpoint(s)                                     |
| ------------------------------- | ----------------------------------------------- |
| `unikraft run`                  | `POST /v1/instances` (often + service group)    |
| `unikraft instances list/get`   | `GET /v1/instances`, `GET /v1/instances/{uuid}` |
| `unikraft instances start/stop` | `PUT /v1/instances/start` or `/stop`            |
| `unikraft instances logs`       | `GET /v1/instances/{uuid}/log`                  |
| `unikraft services list`        | `GET /v1/servicegroups`                         |
| `unikraft volumes ...`          | `/v1/volumes` (+ `attach`/`detach`)             |
| `unikraft images ...`           | `/v1/images`                                    |
| `unikraft certificates ...`     | `/v1/certificates`                              |
| `unikraft quotas`               | `GET /v1/users/quotas`                          |

## Quick examples

Assumes `$UKC_TOKEN` holds your Unikraft Cloud token (see **Authentication**).

```bash
# List instances in Frankfurt
curl -sS https://api.fra.unikraft.cloud/v1/instances \
  -H "Authorization: Bearer $UKC_TOKEN"

# Stop an instance by UUID
curl -sS -X PUT https://api.fra.unikraft.cloud/v1/instances/stop \
  -H "Authorization: Bearer $UKC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"instances":[{"uuid":"123e4567-e89b-12d3-a456-426614174000"}]}'

# Tail logs (base64-encoded in response)
curl -sS "https://api.fra.unikraft.cloud/v1/instances/$UUID/log?limit=256" \
  -H "Authorization: Bearer $UKC_TOKEN"
```

## Gotchas

- **Metro is host-scoped, not a query param.**
  An instance UUID in `fra` is invisible from `api.sfo.unikraft.cloud`.
  Pick the right host first.
- **PATCH works only on stopped instances** for most fields (memory, vCPUs, env, schedule).
  Stop first, then patch.
- **Bulk endpoints never fail atomically.**
  A 200 with per-item `errors[]` is normal — always inspect each item's `status`.
- **FQDNs returned by the API should end in `.<metro>.unikraft.app`.**
  If you ever see `.fra0.unikraft.app` in a response, it's legacy data — don't hard-code it, and don't propagate it into DNS or client configs.
