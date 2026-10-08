# AI Agent Context

Context for AI coding agents (Claude Code, Codex, OpenCode, Mastra Code, Cursor, Copilot, Gemini CLI, and others) working on this repository. This file is the single source of agent instructions: Codex, OpenCode, Mastra Code, Cursor, Copilot and Claude Code read it directly, and Gemini CLI via `.gemini/settings.json`. User-facing documentation is in [README.md](README.md); measured results are in [docs/RESULTS.md](docs/RESULTS.md).

## Project overview

Example of OpenFGA (ReBAC, fine-grained authorization) running on Unikraft Cloud unikernels: a private OpenFGA instance and a private PostgreSQL instance reached over Unikraft's internal network (`<name>.internal`), with a small public Node.js/TypeScript API in front. The same FGA models run locally with Docker Compose.

## Facts

| | Local (`authz/docker-compose.yaml`) | Unikraft Cloud (`scripts/`) |
| --- | --- | --- |
| OpenFGA | v1.21.0, `http://localhost:8080` (via Caddy), key `dev-key-1` | v1.21.0, `demo-fga-openfga.internal:8080`, no public port; tunnel: `localhost:18080` |
| Playground | optional `--profile playground`: `http://localhost:8082/playground`, its API `localhost:8090` without auth | disabled |
| PostgreSQL | 17.2, host port 5435 | 16.4, `demo-fga-postgres.internal:5432`, volume `demo-fga-pgdata` (512MiB), scales to zero when idle (stateful) |
| API | `cd api && FGA_KEY=dev-key-1 FGA_API_URL=http://localhost:8080 PORT=3001 npm start` | `demo-fga-api`, public HTTPS 443→8080 through the persistent service group `demo-fga-api` (stable URL): `/health`, `/check`, `/batch-check`, `/list-objects`, `/bench`, `/openapi.json`, `/docs` |
| Config | `authz/.env` (from `authz/.env.example`) | root `.env` (from `.env.example`): `UNIKRAFT_PROFILE`, `FGA_KEY`, `POSTGRES_PASSWORD`, optional `OPENFGA_DATASTORE_URI` |
| Store | create with `fga store create` (no fixed ID) | `demo-fga`, created by `scripts/seed.sh`; the API finds it by name and pins the model id `seed.sh` records in `.cache/fga-model-id` (`FGA_MODEL_ID`) |

Versions are pinned in `versions.env` (OpenFGA v1.21.0, fga CLI 0.8.1); `scripts/check-versions.sh` fails CI if the Dockerfile, compose file, CI or `docs/repos` disagree. Upgrade them together. Renovate (`renovate.json`) proposes those bumps as one "OpenFGA" PR via custom regex managers; a new pin location needs a matching regex there and a check in `check-versions.sh`. Tooling: OpenFGA CLI `fga` (0.8.1, which embeds the same OpenFGA version), `unikraft` CLI 0.5.x (not the deprecated `kraft cloud`), Node.js 24 (runs `.ts` natively), Docker with BuildKit, jq, Python 3, shellcheck, grpcurl. `nix develop` provides all of them except Docker.

## Skills

Reusable instructions in the Agent Skills format live in `.agents/skills/` (see [.agents/skills/README.md](.agents/skills/README.md)):

- `unikraft`: the `unikraft` CLI (build, run, instances, tunnels, keeping secrets out of output). Use it before running any `unikraft` command. Vendored from github.com/guillempuche/ai-skill-unikraft; refresh with `./scripts/sync-agent-skills.sh`.
- `git-commit-messages`: the commit format below.
- `write-comments`: how to write code comments.

Codex, OpenCode and Mastra Code load them from `.agents/skills/`. Claude Code loads the repo skills through symlinks in `.claude/skills/` and gets `unikraft` from the `unikraft@ai-standards` plugin. The guardrails below apply whether or not a skill is loaded.

## Layout

```
authz/                      local stack (compose, Caddyfile, .env.example) and FGA models
authz/models/               fga.mod + modules (core, conditions, projects, tasks); one *.fga.yaml test file per feature
authz/seed/tuples.yaml      synthetic tuples for the demo store
api/                        src/ (Effect 4 HttpApi + @openfga/sdk), server.test.ts, Kraftfile, Dockerfile (bundles to dist/server.mjs)
infrastructure/unikraft/    openfga/ and postgres/ Kraftfiles and Dockerfiles
scripts/                    env.sh (shared), build, deploy, tunnel, seed, test-remote, test-integration-remote, check-e2e, verify, measure-wake, cleanup, sync-agent-skills, check-* gates
tests/integration/          OpenFGA integration suite (@openfga/sdk + node:test), its compose stack (ports 28080/28081/22112)
.agents/skills/             agent skills (unikraft, git-commit-messages, write-comments); .claude/skills/ symlinks the repo ones
docs/openfga-features.md    feature guide: model excerpt, SDK call and test names per OpenFGA feature
docs/RESULTS.md             measured results; docs/archive/ is historical (legacy CLI)
docs/repos/                 read-only git subtree copies of OpenFGA repos (server, api, js-sdk, cli, language, sample-stores); see docs/repos/README.md
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
fga model test --tests 'authz/models/*.fga.yaml'   # expect Tests 109/109, Checks 323/323, ListObjects 14/14, ListUsers 17/17
python3 scripts/check-model-coverage.py          # every relation true+false, every type listed, 0 surviving mutants
cd api && npm ci && npm run typecheck && npm test   # builds the bundle, then node:test against a stub OpenFGA
bash -n scripts/*.sh scripts/env.sh
./scripts/check-versions.sh
docker compose -f tests/integration/docker-compose.yaml up -d --wait && (cd tests/integration && npm ci)
python3 scripts/check-api-coverage.py              # integration suite + every RPC tested and seen in server metrics
```

Integration tests are named `[rpc:<Name>] ...` (the API gate counts them) and use a fresh store per file (`freshStore` in `tests/integration/helpers.ts`); never test against the seeded `demo-fga` store. They need `fga` and `grpcurl` on PATH.

`fga model test --tests` takes one path or glob. Listing two files silently tests only the first.

## Cloud workflow

```bash
./scripts/build.sh            # build each image to a local OCI archive, then `unikraft images copy` it
./scripts/deploy.sh           # postgres → migrate → openfga → api (first time: `deploy.sh backend`, tunnel, seed, then `deploy.sh api`)
./scripts/tunnel.sh           # foreground; 3 tunnels (HTTP 18080, gRPC 18081, metrics 12112); stop with Ctrl-C/one SIGTERM
./scripts/seed.sh             # needs the tunnel
./scripts/test-remote.sh      # fga model test against the deployed server on a fresh store (needs the tunnel)
./scripts/test-integration-remote.sh  # integration suite + API gate on the deployment (needs the tunnel)
./scripts/check-e2e.sh        # write → public API sees it → delete; store fingerprint vs the last run (needs the tunnel)
./scripts/verify.sh           # public API answers, .internal = private IP, exposure checks; non-zero exit on failure
./scripts/measure-wake.sh     # API response time from standby vs running (10 runs)
./scripts/cleanup.sh          # delete demo-fga-* instances (keeps volume, images and the API's service group; --service / --all delete more)
```

Redeploy means `cleanup.sh` then `deploy.sh`; never restart instances in place. Instances run images by digest: `build.sh` records each pushed digest in `.cache/image-digests`, `deploy.sh` runs those (or pins the registry's current digest when none is recorded), and `verify.sh` fails on a tag or a different digest. To deploy a newer image, build it; to deploy another machine's build, delete its line from `.cache/image-digests`. Building the postgres image takes about 11 minutes (PostgreSQL compiled under emulation on Apple Silicon).

## Guardrails

- **Use the scripts.** They pin every `unikraft` call to `UNIKRAFT_PROFILE`. For a raw command, set the profile first: `export UNIKRAFT_PROFILE=<profile from .env>`. The account may host other workloads.
- **Touch only `demo-fga-*`** instances, volumes and images. Tunnel relays are named `inst-*` (image `utils/tunnel`); close the tunnel with one signal (a second one orphans the relay, which stays publicly addressable). Delete a relay by name only if its tunnel process is gone, after checking its image is `utils/tunnel`.
- **Never print secrets.** `unikraft instances get`, `wait`, `delete` and `list -o json|yaml` include `runtime.env` (passwords, keys) unless you pass `-f <fields>` or `-o quiet`. `unikraft run --dry-run` also prints env values. Pipe `unikraft instances logs` through the `redact` function in `scripts/env.sh`. Don't `cat .env`, run `env`/`printenv`, or use `set -x`.
- **Keep secrets off argv.** `unikraft run -e` only takes `KEY=VALUE`; `scripts/deploy.sh` writes a 0600 YAML spec and uses `--load` instead. `yq_str` quotes values through stdin.
- **Ask before data loss.** `cleanup.sh --volume` or `--all` deletes the Postgres volume (store, model and tuples); `--service` or `--all` deletes the API's service group, and with it the public URL.
- **No secrets in Kraftfiles.** Kraftfile `env` is baked into the image config, readable with registry access; `scripts/check-kraftfiles.sh` enforces it. Secrets go through `deploy.sh`.
- **Keep `FGA_MODEL_ID` out of the scripts' environment.** The fga CLI reads it too; `seed.sh`, `test-remote.sh` and `check-e2e.sh` unset it. The API gets it only through the deploy spec.
- **Keep the two-step build.** A direct `unikraft build --output <org>/<image>` fails with `failed to package kernel … connection reset by peer` on slow or VPN links.
- **Pin GitHub Actions by commit.** Every `uses:` names a full 40-character commit SHA with its release in a comment (`actions/checkout@<sha> # v7.0.1`), never a movable tag like `@v7`. Renovate (`helpers:pinGitHubActionDigestsToSemver`) keeps both up to date; add new steps in the same form.

## Conventions

- Commit messages: `type(scope): subject` in the imperative, with a bulleted past-tense body; types `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `cicd`, `ai`; scopes `authz`, `api`, `infra`, `nix`. Full rules: [.agents/skills/git-commit-messages/SKILL.md](.agents/skills/git-commit-messages/SKILL.md).
- Shell scripts: `#!/usr/bin/env bash`, source `scripts/env.sh`, pass `shellcheck -x -S warning`.
- The API uses Effect 4 (`effect`, `@effect/platform-node`) and `@openfga/sdk`, pinned to exact versions; `npm run build` bundles them with esbuild into `api/dist/server.mjs`, the only file the unikernel ships. Import `@effect/platform-node/NodeHttpServer` and `/NodeRuntime` directly: the package index re-exports a Redis client, which `npm start` (unbundled) would load; the bundle drops it either way. Keep TypeScript to erasable syntax (`erasableSyntaxOnly`) so `npm start` runs `src/main.ts` without a build. Endpoints, payloads and errors are declared once in `api/src/api.ts`; request-schema errors go through `HttpApiMiddleware.layerSchemaErrorTransform` (`api/src/main.ts`), not a router middleware. Condition context (`current_time`, `user_ip`) is set by the API, never by callers (`api/src/handlers.ts`). `server.test.ts` tests the bundle as a black box against a stub OpenFGA (`npm test`); `integration.test.ts` runs it against the integration compose OpenFGA (`npm run test:integration`).
- Model tests live next to `fga.mod` (the CLI refuses model files outside the test file's directory), one file per feature, marked `# feature:` in both the `.fga` and `.fga.yaml` files. Tests are BDD style: one behaviour per test, named `<actor> should <behaviour>`, with `# GIVEN`/`# WHEN`/`# THEN` comments (shared tuples via YAML anchors). The fga CLI can't express contextual tuples or expected errors in model tests; put those in `tests/integration/`. Any model change must keep `scripts/check-model-coverage.py` green: add tests rather than exemptions; an exemption in `authz/models/coverage-exemptions.txt` needs a reason.
- `docs/repos/` is reference material for reading OpenFGA internals: never edit it; update it with `git subtree pull --squash` (see `docs/repos/README.md`). The `AGENTS.md`, `CLAUDE.md` and Copilot instruction files inside it are upstream contributor rules and don't apply to this repo. It is listed in `.ignore`, so `rg`/search skip it by default; search it on purpose with an explicit path (`rg ListUsers docs/repos/openfga`).

## References

- [OpenFGA documentation](https://openfga.dev/docs) and [FGA DSL](https://openfga.dev/docs/configuration-language)
- [unikraft CLI](https://unikraft.com/docs/cli/unikraft) and [networking](https://unikraft.com/docs/platform/networking)
