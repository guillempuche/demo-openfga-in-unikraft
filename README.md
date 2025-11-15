# Demo OpenFGA for Unikraft

OpenFGA is one of the most widely adopted relationship-based authorization services, and this project shows how to host that service on the newest cloud tech: Unikraft unikernels. Everything in the repo—from the Docker Compose stack to the Nix dev shell—keeps the container and unikernel story perfectly aligned so you can iterate locally and then push the identical build to Unikraft Cloud.

## Table of Contents

- [Overview](#overview)
- [Development Environment](#development-environment)
  - [Prerequisites](#prerequisites)
  - [Nix Dev Shell](#nix-dev-shell)
- [OpenFGA Local Setup](#openfga-local-setup)
  - [Quick Start](#quick-start)
  - [Runtime Endpoints](#runtime-endpoints)
  - [Using the Playground](#using-the-playground)
  - [Authentication](#authentication)
  - [Additional Resources](#additional-resources)
- [Authorization Models](#authorization-models)
  - [Deploy the Manifest](#deploy-the-manifest)
  - [Inspect the Combined Model](#inspect-the-combined-model)
  - [Test the Models](#test-the-models)
  - [Transform Models](#transform-models)
  - [Add a New Model](#add-a-new-model)
- [Unikraft Cloud Deployment](#unikraft-cloud-deployment)
  - [Directory Layout](#directory-layout)
  - [Getting Started](#getting-started)
  - [Files of Interest](#files-of-interest)
  - [Relationship to `authz/docker-compose.yaml`](#relationship-to-authzdocker-composeyaml)
- [Reference](#reference)

## Overview

- Reproducible tooling powered by `flake.nix`, pinning OpenFGA CLI, KraftKit, and supporting utilities that you need to target a unikernel runtime.
- Local OpenFGA stack (PostgreSQL + OpenFGA + Caddy) that mirrors the same configuration you deploy to Unikraft Cloud unikernels, so debugging never diverges.
- Modular authorization models, tests, and walkthroughs that highlight why OpenFGA remains a popular choice for ReBAC, plus how to ship those models on next-gen infrastructure.

## Development Environment

Use this workflow whenever you need to tweak OpenFGA before packaging it for a Unikraft unikernel. The same tools that publish to kraft cloud are available here so every change can be validated on your laptop first.

### Prerequisites

- **Docker**: Required for running the local OpenFGA stack via Docker Compose.
  - [Install Docker Desktop](https://docs.docker.com/get-docker/) (includes Docker Compose)
  - Verify installation: `docker --version && docker compose version`

### Nix Dev Shell

Everything else you need runs from the Nix dev shell declared at the repo root.

#### Linux & macOS

1. **Install Nix**
   - **Recommended:** [Determinate Systems Nix Installer](https://zero-to-nix.com/start/install/) – single command, works on Linux/macOS/WSL.
   - **Alternative:** [Official NixOS installer](https://nixos.org/download.html).
   - Nix keeps `openfga-cli`, and `kraftkit` in lockstep across the team.
2. **Enter the dev shell**

   ```bash
   nix develop # or for zsh shell: nix develop -c zsh
   ```

   The shell hook prints the OpenFGA CLI version so you can confirm the tooling.

#### Windows

- Follow the [official Unikraft WSL2 instructions](https://unikraft.org/docs/cli/install#windows) to set up KraftKit prerequisites.
- Inside your WSL distribution, install Nix using one of the methods above and run `nix develop`.
- For OpenFGA specifics on Windows/WSL, see the [OpenFGA CLI guide](https://openfga.dev/docs/getting-started/cli).

## OpenFGA Local Setup

This is the reference deployment you can run in containers to prove out model changes, CLI flows, and datastore migrations before shipping the same OpenFGA bits inside a Unikraft unikernel.

### Quick Start

1. **Create the environment configuration**:

   ```bash
   cp authz/.env.example authz/.env
   ```

   The default values are configured for local development and can be used as-is.

2. **Start the local OpenFGA stack** (PostgreSQL + OpenFGA server):

   ```bash
   docker compose -f authz/docker-compose.yaml up -d
   ```

   This starts:
   - PostgreSQL database on port 5435
   - OpenFGA server (internal)
   - Caddy reverse proxy exposing:
     - OpenFGA HTTP API on port 8080
     - OpenFGA Playground UI on port 8082

3. **Verify the services are running**:

   ```bash
   docker compose -f authz/docker-compose.yaml ps
   curl http://localhost:8080/healthz
   ```

4. **Load the demo authorization model into the store** (run from the repo root after the stack is healthy):

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

   The command output includes a new `authorization_model_id` (the version you just wrote). Keep using the same `STORE_ID` for future CLI calls; if the Playground reports "0 types", rerun this step.

5. **Stop the stack when done**:

   ```bash
   docker compose -f authz/docker-compose.yaml down          # stop services
   docker compose -f authz/docker-compose.yaml down -v       # stop and remove volumes
   ```

### Runtime Endpoints

- Playground UI: `http://localhost:8082/playground`
- HTTP API: `http://localhost:8080`

Note: Caddy handles the reverse proxy. For production deployments, configure automatic HTTPS in the `Caddyfile`.

### Using the Playground

When you first open the playground, you'll see a "Create Store" popup. **The store has already been created for you** with ID `01KA43FJDTE8AQCYZ6252ZR9HS`.

To connect to the existing store:

1. Close the "Create Store" popup
2. Click on the store selector (top left)
3. Enter the store ID: `01KA43FJDTE8AQCYZ6252ZR9HS`

Alternatively, if you want to create a new store:

1. Enter a name (e.g., `my-demo-store`) in the popup
2. Copy the generated store ID
3. Update `authz/.env` with the new ID
4. Restart the Docker Compose stack

If the UI shows "0 types" after connecting, the store simply hasn’t been seeded yet—run the `fga model write …` command from the Quick Start section to deploy the demo model.

### Authentication

Local auth uses a preshared key:

```
Authorization: Bearer dev-key-1
```

### Additional Resources

Use the official guide at <https://openfga.dev/docs/cli> to learn more about the OpenFGA CLI workflow (stores, models, tuples, etc.).

## Authorization Models

OpenFGA stays popular because its modeling experience scales, so the repo keeps the canonical modules in `authz/models/` and runs them identically on Docker and Unikraft targets.

- `authz/models/fga.mod`: Manifest that enumerates included modules.
- `authz/models/projects.fga`: Users, projects, and lists with hierarchical sharing.
- `authz/models/tasks.fga`: Tasks that inherit rights from their parent lists.

Export the helper variables once per shell session so the CLI examples just work:

```sh
export STORE_ID=01KA43FJDTE8AQCYZ6252ZR9HS
export FGA_API_URL=http://localhost:8080
export FGA_API_TOKEN=dev-key-1
```

### Deploy the Manifest

```sh
fga model write \
  --store-id=$STORE_ID \
  --api-url=$FGA_API_URL \
  --api-token=$FGA_API_TOKEN \
  --file authz/models/fga.mod
```

The CLI prints the newly created `authorization_model_id`. This is the version identifier for the model you just wrote—keep using the same `STORE_ID` for all other commands, and optionally pass `--authorization-model-id` when you want to inspect an older version.

### Inspect the Combined Model

```sh
fga model get \
  --store-id=$STORE_ID \
  --api-url=$FGA_API_URL \
  --api-token=$FGA_API_TOKEN
```

### Test the Models

Run from the repository root so the relative paths resolve correctly:

```sh
fga model test --tests authz/models/projects.fga.yaml authz/models/tasks.fga.yaml
```

### Transform Models

```sh
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

Hosting OpenFGA on Unikraft unikernels is the whole point of this project. The `infrastructure/kraftcloud/` tree contains the Kraftfiles, rootfs assets, and helper Compose stack that turn the popular authorization service into lightweight unikernel workloads, while keeping PostgreSQL external via the same `authz/.env` settings.

### Directory Layout

- `infrastructure/kraftcloud/openfga/`: builds the OpenFGA v1.11.0 binary as a
  static PIE and provides `infrastructure/kraftcloud/openfga/Kraftfile`.
- `infrastructure/kraftcloud/caddy/`: compiles Caddy plus the templated
  `Caddyfile` that reverse proxies to the OpenFGA service.
- `infrastructure/kraftcloud/docker-compose.yaml`: optional helper Compose
  stack to validate both images locally (Caddy on 8080/8082, direct OpenFGA on
  8085/3080) prior to deploying to the cloud.
- `Dockerfile.openfga` / `Dockerfile.caddy`: stored at the repository root per
  the Unikraft Discord guidance (September 2025:
  <https://discord.com/channels/1143564401060872292/1420877995245179041>),
  ensuring `kraft cloud deploy` resolves `rootfs` paths correctly when run from
  the monorepo root.

### Getting Started

1. Copy the example env file and edit your values:

   ```bash
   cp infrastructure/kraftcloud/.env.example infrastructure/kraftcloud/.env
   ```

   - Keep `OPENFGA_*` secrets synchronized with `authz/.env`.
   - For local testing, keep `OPENFGA_API_HOST=:8080` and
     `CADDY_GLOBAL_OPTIONS=auto_https off`. For production TLS, replace those
     host declarations with real domains and set a valid `CADDY_CONTACT_EMAIL`.
   - The `.env` file is primarily for local Compose or manual `export` usage:
     `kraft cloud deploy` does **not** support `--env-file`, so load variables
     into your shell (see Step 4) or pass them with repeated `-e KEY=value`.
   - Quote any values containing spaces (already reflected in the template via
     `CADDY_GLOBAL_OPTIONS="auto_https off"`) so POSIX `.` semantics work.

2. Sign in to [console.unikraft.cloud](https://console.unikraft.cloud/), open the
   profile **Settings** page, and copy your Unikraft Cloud API token. Export it
   (or run `kraft cloud auth login`) before deploying so the CLI can authenticate:

   ```bash
   export UKC_TOKEN=your-token-from-settings
   export UKC_METRO=fra0   # adjust as needed
   ```

3. (Optional) Validate both unikernel images locally:

   ```bash
   docker compose -f infrastructure/kraftcloud/docker-compose.yaml up --build
   ```

   - `http://localhost:8080` → OpenFGA HTTP API via Caddy.
   - `http://localhost:8082` → Playground via Caddy.
   - `http://localhost:8085` and `http://localhost:3080` expose the raw OpenFGA
     ports for debugging.

4. Deploy to Unikraft Cloud **from the repo root**:

   ```bash
   # Load variables from the .env file (portable POSIX shells: bash, zsh, dash)
   set -a
   . infrastructure/kraftcloud/.env
   set +a

   kraft cloud deploy \
     --kraftfile infrastructure/kraftcloud/openfga/Kraftfile \
     -M 1G \
     .

   kraft cloud deploy \
     --kraftfile infrastructure/kraftcloud/caddy/Kraftfile \
     -p 443:8080 \
     -p 8443:8082 \
     -M 512M \
     .
   ```

   - **Important:** `rootfs` paths in Kraftfiles are resolved relative to the
     current working directory, so always run `kraft cloud deploy … .` from the
     monorepo root (same directory you would run `git status`). This follows the
     Unikraft Discord recommendation from September 2025
     (<https://discord.com/channels/1143564401060872292/1420877995245179041>):
     keep the Dockerfiles (`Dockerfile.openfga`, `Dockerfile.caddy`) at the repo
     root and invoke `kraft` from that same directory so paths resolve cleanly.
   - `kraft cloud deploy` currently lacks a `--env-file` flag
     ([CLI reference](https://unikraft.org/docs/cli/reference/kraft/cloud/deploy)).
     To inject many env vars, either export them beforehand (e.g. `set -a; .
     infrastructure/kraftcloud/.env; set +a` in POSIX-compatible shells such as
     bash/zsh) or pass multiple `-e KEY=value` arguments. Shells without POSIX
     `.` semantics:
     - **fish:** `env (cat infrastructure/kraftcloud/.env | xargs) kraft cloud deploy …`
     - **PowerShell (Windows):**

       ```powershell
       Get-Content infrastructure/kraftcloud/.env |
         Where-Object { $_ -and -not $_.StartsWith('#') } |
         ForEach-Object {
           $name, $value = $_.Split('=', 2)
           [System.Environment]::SetEnvironmentVariable($name, $value, 'Process')
         }

       kraft cloud deploy --kraftfile infrastructure/kraftcloud/openfga/Kraftfile -M 1G .
       ```

     Alternatively, run `bash -lc "set -a; . infrastructure/kraftcloud/.env; set +a; kraft cloud deploy …"`
     or export the needed variables manually. If you prefer `.env` semantics,
     consider `kraft cloud compose up --env-file …` instead.
   - When pointing at real DNS, add `--domain` / `--subdomain`; Caddy will
     handle certificate issuance automatically via Let’s Encrypt using the email
     from `.env`.

### Files of Interest

- `infrastructure/kraftcloud/.env.example`: canonicalizes OpenFGA datastore
  URIs, store IDs, preshared keys, and Caddy knobs for both local and cloud
  stacks.
- `Dockerfile.openfga` / `Dockerfile.caddy`: update the version args here when
  tracking newer OpenFGA or Caddy releases. Both files live at the repo root so
  `kraft cloud deploy` can package them without path gymnastics.
- `infrastructure/kraftcloud/caddy/rootfs/etc/caddy/Caddyfile`: templated via
  environment variables so you can keep local HTTP-only and production TLS
  configs in sync.

### Relationship to `authz/docker-compose.yaml`

- `authz/docker-compose.yaml` is still the canonical local developer stack
  (PostgreSQL + OpenFGA + Caddy) and drives the examples earlier in this README.
- The Unikraft artifacts reuse the same environment variables, letting you swap
  between local Docker and Unikraft Cloud without rewriting CLI commands.
- Whenever you tweak HTTP ports, datastore URIs, or Caddy directives, update
  both stacks so docs, Playgrounds, and scripts stay aligned.

## Reference

- Unikraft CLI install guide: <https://unikraft.org/docs/cli/install>
- OpenFGA CLI docs: <https://openfga.dev/docs/getting-started/cli>
