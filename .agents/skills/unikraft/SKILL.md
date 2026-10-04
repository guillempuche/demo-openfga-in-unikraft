---
name: unikraft
description: Unikraft CLI (`unikraft`) commands for building and deploying to Unikraft Cloud. Use when working with Kraftfiles, deploying unikernels, or managing Unikraft Cloud instances/services/images. Covers the new `unikraft` CLI that replaces the legacy kraftkit `kraft`.
license: MIT
metadata:
  version: 2.1.2
---

# Unikraft CLI Reference

Build and deploy unikernels with the `unikraft` CLI.

- Documentation: <https://unikraft.com/docs/cli>
- CLI source & releases: <https://github.com/unikraft-cloud/cli>
- Platform: <https://unikraft.cloud>

**Targets the new `unikraft` CLI `0.5.x`** (verified against `0.5.1`) and the Unikraft Cloud REST API `v1`.
Run `unikraft version` to check; if the major or minor differs, re-verify flags/commands against `--help` before following this skill.

`0.5` renamed the plural resource flags to singular — `--domains` → `--domain`, `--services` → `--service`, `--tags` → `--tag` — on `services create`/`edit`, `run` and `instances`.
Each now repeats instead: `--service 443:8080/http+tls --service 80:443/http+redirect`.
The error names the replacement (`unknown flag --tags, did you mean one of "--tag", "--args"?`), so an upgrade fails loudly rather than silently.

## New CLI vs legacy kraftkit — they are different tools

The binary is **`unikraft`** (from `unikraft-cloud/cli`).
It **replaces the legacy kraftkit `kraft`** (`v0.12.x`).
They are separate programs with:

- a **different command tree** (`unikraft run` / `unikraft build` / `unikraft instances …`, not `kraft cloud deploy`),
- a **separate auth store** — a `kraft login` / `UKC_TOKEN` env from kraftkit does **not** authenticate `unikraft`; you must run `unikraft login` (see below).
  The new CLI writes its own profile under `~/.config/unikraft`, kraftkit uses `~/.config/kraftkit`,
- **packaging split from deploy** — `unikraft build --output <ref>` publishes an image, then `unikraft run --image <ref>` deploys it (kraftkit did both in one `kraft cloud deploy`).

If you see `kraft`, `UKC_TOKEN`, `kraft cloud`, or `--rollout` in a config or runbook, it is the legacy CLI — translate it to the new commands here.

## Important: running commands

When working with `unikraft` commands:

1. **Read-only and local commands can just run** — e.g. `list`, `get`, `logs`, `wait`, `quotas`, `metros list`, `run --dry-run`, `profile use`, `config`, `upgrade`.
1. **Show cloud-changing commands first** — for anything that creates, edits, deletes, or publishes, display the command in a copy-paste code block.
   That includes, e.g., `run`, `services create`/`edit`, `instances delete`/`start`/`stop`/`suspend`/`restart`, `images build`/`delete`, a publishing `build`, volume and certificate mutations, and a POST/PATCH/DELETE through `unikraft api` or `curl`.
   Run it yourself only when the user asked you to and it is not a production deploy; otherwise hand it to the developer to run.
1. **Logins are always the developer's** — `unikraft login` takes a token, so never run it yourself.
   Anything hitting Unikraft Cloud (`run`, `instances`, `services`, `images`, `metros`, `api`, a publishing `build`) fails with `profile not setup` until a login has run in that environment; the AI's shell may not have one, so on that error hand the command to the developer.

## Installation

- **CI (GitHub Actions):** `unikraft/setup-action@v1` — installs the CLI and logs in headlessly.
  Inputs: `version` (`latest`/`stable`, `dev`/`staging`, or a release tag), `token` (login token), `organization`.
  It downloads the release asset `unikraft-cli_<version>_<os>_<arch>.tar.gz` from `unikraft-cloud/cli`.

  ```yaml
  - uses: unikraft/setup-action@v1
    with:
      version: 0.5.1
      token: ${{ secrets.KRAFTCLOUD_TOKEN }}
      organization: my-org
  ```

- **Local:** `unikraft upgrade` self-updates an installed CLI.
  Otherwise pull the tarball for your platform from <https://github.com/unikraft-cloud/cli/releases> (it holds the `unikraft` binary at its root).

- **Nix:** the CLI is not in nixpkgs (only the legacy `kraft` is), but the Unikraft team maintains a NUR flake at `github:unikraft/nur` exposing `packages.<system>.{unikraft-cli, unikraft-cli-staging, kraftkit}` (+ an overlay).
  Add it as a flake input and take `unikraft-cli` — or `unikraft-cli-staging` while the stable attr is being fixed upstream.

## Authentication

The new CLI reads the token from a **file or stdin**, not an env var, and associates the session with an organization.

```bash
# From a file:
unikraft login --token /path/to/token --organization my-org

# From stdin (no token on disk / no token in argv):
printf '%s' "$UKC_TOKEN" | unikraft login --token - --organization my-org
```

`--organization` is resolved from the control plane if omitted.
A successful login stores a **profile** (named after the organization) under `~/.config/unikraft`.
Manage profiles with:

```bash
unikraft profile list          # profiles + their metros + which is active
unikraft profile use <name>    # switch active profile
```

Global flags / env available on every command: `--profile` (`$UNIKRAFT_PROFILE`), `--config` (`$UNIKRAFT_CONFIG`), `--timeout` (`$UNIKRAFT_TIMEOUT`), `--log-level` (`$UNIKRAFT_LOG_LEVEL`), `--log-type`, `--[no-]telemetry`.

### Metros

Most write operations take `--metro <m>`.
List them with `unikraft metros list`:

| Use (current)                     | Endpoint                             |
| --------------------------------- | ------------------------------------ |
| `fra`, `dal`, `sin`, `was`, `sfo` | `https://api.<metro>.unikraft.cloud` |

`unikraft metros list` also shows **legacy** metros `fra0`, `dal0`, `sin0`, `was1` on `api.<metro>.kraft.cloud` — these are the old kraft.cloud endpoints.
**Use the suffix-less names only**; treat any `<metro>0` as legacy.

> [!IMPORTANT]
> **Only the *create* verbs take `--metro`** — `unikraft run` and `unikraft services create`.
> The read/manage verbs (`instances list`/`get`/`delete`/`logs`, `images list`, `services get`) **reject `--metro`** with `unknown flag --metro`; they take a **bare name** (the logged-in profile spans metros) or a `--filter 'metro==<m>'`.
> This bites in CI: piping a failed `instances delete <name> --metro fra` through `|| true` silently skips the delete, and the next `run` then fails with "instance already exists".

## Command tree

```text
Commands
  unikraft run                 # Run an image as an instance (deploy)
  unikraft build               # Build a Unikraft project into a container image
  unikraft tui                 # Browse resources in a TUI

Resources
  unikraft metros              # List/inspect cloud metros
  unikraft quotas              # Show quota usage
  unikraft instances           # Manage instances  (aliases: instance, vm, vms)
  unikraft services            # Manage service groups (svc, svcs)
  unikraft volumes             # Manage persistent volumes (vol, vols)
  unikraft certificates        # Manage TLS certificates (cert, certs)
  unikraft images              # Manage images (image, img, imgs)

Utilities
  unikraft api <endpoint>      # Authenticated raw REST call (e.g. /v1/instances)
  unikraft version             # Version info
  unikraft upgrade             # Self-update the CLI
  unikraft completion          # Shell completions

Config
  unikraft login / logout      # Authentication
  unikraft profile             # get / list / use
  unikraft config              # Manage CLI configuration
```

## Build (package an image)

```bash
# Build the project in the current directory and PUBLISH to the registry.
# The <org> prefix is your organization (see `unikraft profile list`).
unikraft build . --output <org>/my-app:latest

# Build and save to a LOCAL OCI archive (no publish):
unikraft build . --output ./dist/my-app.oci.tar

# Build-time inputs and secrets:
unikraft build . --build-arg VERSION=1.2.3 --secret id=npm,src=$HOME/.npmrc
```

Flags: `-o/--output`, `--arch`, `--build-arg`, `--no-cache`, `--secret`, `--ssh`, `--insecure`, plus the global `--timeout=<duration>`.
The input path defaults to `.`.
`--arch` (`x86_64`, `arm64`) limits which of the Kraftfile's targets are built, and is **required when the Kraftfile declares none**.

## Run (deploy an instance)

```bash
# Deploy a new instance exposing an HTTPS service:
unikraft run --metro fra --image <org>/my-app:latest \
  -p 443:8080/http+tls -p 80:443/http+redirect \
  -m 2048M --restart on-failure -e NODE_ENV=production

# Preview without deploying:
unikraft run --metro fra --image <org>/my-app:latest --dry-run
```

Common flags: `--metro`, `--image`, `-n/--name`, `-e/--env`, `-m/--memory` (binary units, e.g. `2048M`), `--vcpus`, `-p/--publish` (`<src>:<dest>[/<handlers>]`), `--domain`, `--service` (attach to an existing service group), `--restart` (`on-failure` …), `--scale-to-zero`, `-v/--volume`, `--replicas`, `--rm`, `--follow`, `--dry-run`.

> Memory units changed from legacy kraftkit: `-M 2048` (MiB) → `-m 2048M`.

> [!WARNING]
> **A comma inside an `-e` value needs CLI `0.5`+.**
> Below `0.5`, `-e` split its own value at every comma: `-e OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=KEY,x-honeycomb-dataset=my-app"` reached the instance as `OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=KEY` **plus a second variable named `x-honeycomb-dataset`** — and since both halves look like `key=value`, nothing errored.
> It fails silently, at runtime, in whatever reads the truncated value; a check that greps the instance for the variable's *name* finds the stray half and reports success.
> Escaping does not help (`\,` and quotes both still split). `0.5` keeps the value verbatim.
> Any comma-bearing value is affected — OTLP headers, a multi-host Postgres URL, a CSV allow-list.

## Instances, services, images

```bash
unikraft instances list                    # or: ls
unikraft instances get <name>              # inspect
unikraft instances logs <name>             # console output
unikraft instances wait <filter>           # block until instances match (readiness gate)
unikraft instances delete <name>           # remove
unikraft instances start|stop|suspend|restart <name>

unikraft services list                     # service groups (load balancers)
unikraft services get <name>
unikraft services create …                 # create a named service group
unikraft services edit <name>              # change its config / instance set

unikraft images list                       # image refs + digests (--filter 'ref~="my-app"')
unikraft images build                      # same engine as `unikraft build`
unikraft images delete <ref>
```

`volumes` (create/attach/detach/clone/import/…) and `certificates` (create/get/wait/…) follow the same verb pattern.

> [!WARNING]
> **Reading an instance dumps its secrets.**
> `instances list -o json`/`-o yaml` and `instances get` (without `-f`) return the instance's full `runtime.env` — including secret values such as `DATABASE_URL` — in **cleartext**.
> When you only need identifiers, field-limit the output: `unikraft instances list -f name -o quiet` (names only, no env).
> Never pipe an un-limited instance read into shared logs, CI output, or an issue.

## Rolling updates (zero-downtime)

The new CLI has **no single `--rollout` flag** (kraftkit's `kraft cloud deploy --rollout remove_sequential`).
A zero-downtime swap of an instance behind an existing service group is composed from primitives:

1. `unikraft run --service=<group> --image <new-ref> …` — start a **new** instance and attach it to the service group that owns the domain/ports (do **not** re-pass `-p`/`--domain`; the group owns those).
   Omit `--name` so the new instance gets a unique name and can run alongside the old one.
1. `unikraft instances wait <filter>` — wait until the new instance is ready.
1. `unikraft instances delete <old-name>` — remove the previous instance.

Confirm the exact recommended sequence (and whether a built-in rollout exists in your CLI version) with `unikraft run --help` / the Unikraft team before relying on it for a production deploy.

> [!IMPORTANT]
> **Check quota headroom before a rolling update.**
> The overlap briefly runs two instances, so it needs ~2× the instance's memory + vCPUs at once.
> Run `unikraft quotas [--metro <m>]` first (optional `--metro`, no subcommand): if adding a second instance would exceed the memory or instance cap, fall back to delete-then-recreate (accepting a brief gap) or request a quota bump.
> Near the cap, a rolling `run` fails with a quota error mid-deploy.

## Kraftfile (spec v0.7)

Keep the `Kraftfile` (and the `Dockerfile` it references) **at the build context root** — the rootfs path can't reach parent directories, and the Docker build needs the repo root as context to `COPY` sibling folders.

```yaml
spec: v0.7
name: my-server
# base-compat runs the node binary bundled in the image.
runtime: base-compat:latest

labels:
  cloud.unikraft.v1.instances/scale_to_zero.policy: "off"

rootfs:
  source: ./Dockerfile
  format: erofs
cmd: ["/usr/local/bin/node", "/app/dist/main.mjs"]
```

## Deployment example (build once, deploy the image)

```bash
# 1) Log in (once per environment).
printf '%s' "$UKC_TOKEN" | unikraft login --token - --organization my-org

# 2) Build + publish a versioned image.
unikraft build . --output my-org/my-app:2026.7.9 --timeout 10m

# 3) First deploy — create the service group, then run into it.
unikraft services create --name my-app --metro fra \
  --domain my-app.example.com \
  --service 443:8080/http+tls --service 80:443/http+redirect
unikraft run --metro fra --service my-app --image my-org/my-app:2026.7.9 \
  -m 2048M --restart on-failure -e NODE_ENV=production

# 4) Subsequent deploys — see "Rolling updates" above.

# Verify:
unikraft instances list
curl -sf https://my-app.example.com/health
unikraft instances logs my-app-<suffix>
```

## Troubleshooting

| Symptom                                                                  | Cause / fix                                                                                   |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `profile not setup`                                                      | Not logged in — run `unikraft login` (kraftkit's login/`UKC_TOKEN` doesn't count).            |
| `unknown flag --metro` on `*/list`                                       | List/get subcommands scope by profile/`--filter`, not `--metro`.                              |
| Image builds but instance won't boot                                     | Check `runtime`, the `cmd` path, and that env vars the app needs are passed with `-e`.        |
| Env var truncated at a comma, plus a stray variable named after its tail | CLI below `0.5` split `-e` values at commas — pin `0.5`+ (escaping doesn't work).             |
| `unknown flag --domains` / `--services` / `--tags`                       | `0.5` made them singular — `--domain`, `--service`, `--tag`, repeated per value.              |
| `504 Gateway Timeout`                                                    | Scale-to-zero cold start — set the scale-to-zero policy `off` for latency-sensitive services. |
| rootfs / `COPY` build failures                                           | Keep the Kraftfile + Dockerfile at the build-context root; no `../` in the rootfs path.       |
| Legacy `fra0`/`kraft.cloud` host in a ref                                | Replace with the suffix-less metro (`fra`, `api.fra.unikraft.cloud`).                         |

______________________________________________________________________

## Unikraft Cloud REST API (v1)

The CLI wraps a REST API.
Reach for it via `unikraft api <endpoint>` (uses the logged-in profile), or call it directly with a bearer token for automation.

```bash
unikraft api /v1/instances                       # via the CLI (logged-in profile)

curl https://api.fra.unikraft.cloud/v1/instances \
  -H "Authorization: Bearer $UKC_TOKEN"          # raw, any HTTP client
```

- Base URLs are metro-scoped: `https://api.<metro>.unikraft.cloud/v1` for `fra`, `dal`, `sin`, `was`, `sfo`.
  **Never** use a `<metro>0` legacy host.
- Every response uses the `{status, message, data, errors, op_time_us}` envelope; bulk endpoints return per-item `status`.

Full endpoint tables, curl examples, and gotchas: [references/api-v1.md](references/api-v1.md).

______________________________________________________________________

## Examples repository

Reference examples (Kraftfiles + Dockerfiles for many runtimes): <https://github.com/unikraft-cloud/examples>.
