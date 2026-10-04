# AI Agent Context

Context for AI coding agents (Claude Code, Codex, Cursor, Copilot, and others) working on this repository. User-facing documentation is in [README.md](README.md); measured results are in [docs/RESULTS.md](docs/RESULTS.md).

## Project overview

Example of OpenFGA (ReBAC, fine-grained authorization) running on Unikraft Cloud unikernels: a private OpenFGA instance and a private PostgreSQL instance reached over Unikraft's internal network (`<name>.internal`), with a small public Node.js/TypeScript API in front. The same FGA models run locally with Docker Compose.

## Facts

| | Local (`authz/docker-compose.yaml`) | Unikraft Cloud (`scripts/`) |
| --- | --- | --- |
| OpenFGA | v1.11.0, `http://localhost:8080` (via Caddy), key `dev-key-1` | v1.11.0, `demo-fga-openfga.internal:8080`, no public port; tunnel: `localhost:18080` |
| Playground | `http://localhost:8082/playground` | disabled |
| PostgreSQL | 17.2, host port 5435 | 16.4, `demo-fga-postgres.internal:5432`, volume `demo-fga-pgdata` (512MiB) |
| API | `cd api && FGA_KEY=dev-key-1 FGA_API_URL=http://localhost:8080 PORT=3001 npm start` | `demo-fga-api`, public HTTPS 443→8080: `/health`, `/check`, `/bench` |
| Config | `authz/.env` (from `authz/.env.example`) | root `.env` (from `.env.example`): `UNIKRAFT_PROFILE`, `FGA_KEY`, `POSTGRES_PASSWORD`, optional `OPENFGA_DATASTORE_URI` |
| Store | create with `fga store create` (no fixed ID) | `demo-fga`, created by `scripts/seed.sh`; the API finds it by name |

Tooling: OpenFGA CLI `fga`, `unikraft` CLI 0.5.x (not the deprecated `kraft cloud`), Node.js 24 (runs `.ts` natively), Docker with BuildKit, jq. `nix develop` provides all of them except Docker.

## Layout

```
authz/                      local stack (compose, Caddyfile, .env.example) and FGA models
authz/models/               fga.mod, projects.fga, tasks.fga, *.fga.yaml tests
authz/seed/tuples.yaml      synthetic tuples for the demo store
api/                        server.ts, server.test.ts, Kraftfile, Dockerfile
infrastructure/unikraft/    openfga/ and postgres/ Kraftfiles and Dockerfiles
scripts/                    env.sh (shared), build, deploy, tunnel, seed, test-remote, verify, cleanup
docs/RESULTS.md             measured results; docs/1-*, docs/2-* are historical (legacy CLI)
.github/workflows/ci.yml    CI: model tests, API typecheck + tests, shellcheck, API rootfs build
```

## Local workflow

```bash
cp authz/.env.example authz/.env
docker compose -f authz/docker-compose.yaml --env-file authz/.env up -d

export FGA_API_URL=http://localhost:8080 FGA_API_TOKEN=dev-key-1
export FGA_STORE_ID=$(fga store create --name demo-fga --model authz/models/fga.mod | jq -r .store.id)
fga tuple write --file authz/seed/tuples.yaml
fga query check user:alice can_edit project:roadmap     # allowed: true
```

Checks to run after changes (all run in CI):

```bash
fga model test --tests 'authz/models/*.fga.yaml'   # expect Tests 10/10, Checks 31/31
cd api && npm ci && npm run typecheck && npm test   # node:test against a stub OpenFGA
bash -n scripts/*.sh scripts/env.sh
```

`fga model test --tests` takes one path or glob. Listing two files silently tests only the first.

## Cloud workflow

```bash
./scripts/build.sh            # build each image to a local OCI archive, then `unikraft images copy` it
./scripts/deploy.sh           # postgres → migrate → openfga → api
./scripts/tunnel.sh           # foreground; run it in the background or another terminal
./scripts/seed.sh             # needs the tunnel
./scripts/test-remote.sh      # fga model test against the deployed store (needs the tunnel)
./scripts/verify.sh           # public API + exposure checks; non-zero exit on failure
./scripts/cleanup.sh          # delete demo-fga-* instances (keeps volume and images)
```

Redeploy means `cleanup.sh` then `deploy.sh`; never restart instances in place. Building the postgres image takes about 11 minutes (PostgreSQL compiled under emulation on Apple Silicon).

## Guardrails

- **Use the scripts.** They pin every `unikraft` call to `UNIKRAFT_PROFILE`. For a raw command, set the profile first: `export UNIKRAFT_PROFILE=<profile from .env>`. The account may host other workloads.
- **Touch only `demo-fga-*`** instances, volumes and images. Tunnel relays are named `inst-*` (image `utils/tunnel`); close the tunnel instead of deleting them by name.
- **Never print secrets.** `unikraft instances get`, `wait`, `delete` and `list -o json|yaml` include `runtime.env` (passwords, keys) unless you pass `-f <fields>` or `-o quiet`. `unikraft run --dry-run` also prints env values. Pipe `unikraft instances logs` through the `redact` function in `scripts/env.sh`. Don't `cat .env`, run `env`/`printenv`, or use `set -x`.
- **Keep secrets off argv.** `unikraft run -e` only takes `KEY=VALUE`; `scripts/deploy.sh` writes a 0600 YAML spec and uses `--load` instead. `yq_str` quotes values through stdin.
- **Ask before data loss.** `cleanup.sh --volume` or `--all` deletes the Postgres volume (store, model and tuples).
- **Keep the two-step build.** A direct `unikraft build --output <org>/<image>` fails with `failed to package kernel … connection reset by peer` on slow or VPN links.

## Conventions

- Commit messages: `type(scope): subject` in the imperative, with a bulleted past-tense body; types `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `cicd`, `ai`; scopes `authz`, `api`, `infra`, `nix`. Full rules: [.claude/skills/git-commit-messages/SKILL.md](.claude/skills/git-commit-messages/SKILL.md).
- Shell scripts: `#!/usr/bin/env bash`, source `scripts/env.sh`, pass `shellcheck -x -S warning`.
- The API has no runtime dependencies (only `node:` modules and `fetch`); keep TypeScript to erasable syntax (`erasableSyntaxOnly`).
- Each `.fga` module has a `.fga.yaml` test file beside it, covering positive, negative and inherited cases.

## References

- [OpenFGA documentation](https://openfga.dev/docs) and [FGA DSL](https://openfga.dev/docs/configuration-language)
- [unikraft CLI](https://unikraft.com/docs/cli/unikraft) and [networking](https://unikraft.com/docs/platform/networking)
- Claude Code users can also load the `unikraft:unikraft` plugin skill; everything an agent needs to work safely is in this file.
