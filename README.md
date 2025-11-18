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

```http
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

- `infrastructure/kraftcloud/openfga/`: OpenFGA Kraftfile and build.
- `infrastructure/kraftcloud/caddy/`: Caddy Kraftfile and config.
- `infrastructure/kraftcloud/docker-compose.yaml`: Local validation stack.
- `Dockerfile.openfga` / `Dockerfile.caddy`: Root-level Dockerfiles for kraft cloud deploy.

### Getting Started

1. Copy and configure `.env` (sync with `authz/.env`):

   ```bash
   cp infrastructure/kraftcloud/.env.prod.example infrastructure/kraftcloud/.env
   # Edit for your subdomain, email, etc.
   ```

2. Export API token and metro:

   ```bash
   export UKC_TOKEN=your-token
   export UKC_METRO=fra
   ```

3. (Optional) Validate locally:

   ```bash
   docker compose -f infrastructure/kraftcloud/docker-compose.yaml up --build
   ```

4. Deploy from repo root (load env first):

   ```bash
   set -a; . infrastructure/kraftcloud/.env; set +a

   # Deploy OpenFGA
   kraft cloud deploy --kraftfile infrastructure/kraftcloud/openfga/Kraftfile -M 1G .

   # Capture OpenFGA IP
   kraft cloud instance ls --metro $UKC_METRO
   OPENFGA_INSTANCE=<name>
   OPENFGA_IP=$(kraft cloud instance get $OPENFGA_INSTANCE --metro $UKC_METRO | awk '/private ip/ {print $4; exit}')
   perl -i -pe "s/^OPENFGA_UPSTREAM_HOST=.*/OPENFGA_UPSTREAM_HOST=$OPENFGA_IP/" infrastructure/kraftcloud/.env
   set -a; . infrastructure/kraftcloud/.env; set +a

   # Initial Caddy deployment (choose subdomain)
   # Subdomain must be DNS-safe (letters, numbers, hyphens) and unique within the metro.
   # This creates: <subdomain>.<metro>.unikraft.app (e.g., myapp.fra.unikraft.app)
   SUBDOMAIN=<your-subdomain>
   DOMAIN=$SUBDOMAIN.$UKC_METRO.unikraft.app
   perl -i -pe "s/^OPENFGA_API_HOST=.*/OPENFGA_API_HOST=$DOMAIN/" infrastructure/kraftcloud/.env # It will replace the old domain with the new domain
   perl -i -pe "s/^OPENFGA_PLAYGROUND_HOST=.*/OPENFGA_PLAYGROUND_HOST=$DOMAIN/" infrastructure/kraftcloud/.env # It will replace the old domain with the new domain
   set -a; . infrastructure/kraftcloud/.env; set +a
   kraft cloud deploy --kraftfile infrastructure/kraftcloud/caddy/Kraftfile --subdomain $SUBDOMAIN -p 443:8080/http+tls -p 8443:8082/tls -M 512M .
   ```

   **Note:**
   - Deploy OpenFGA first. Run from repo root.
   - `--subdomain` creates a subdomain under `*.unikraft.app`. For custom domains you own, use `-d <your-domain.com>` instead.
   - Subdomain must be unique within the metro (deployment fails if already taken).
   - For auto-generated hostname: Update .env with generated FQDN and redeploy (see below).

### Redeploying to an Existing Service

Use `--service` and `--rollout` to update without creating new subdomain.

1. Get service name:

   ```bash
   kraft cloud service ls --metro $UKC_METRO
   SERVICE_NAME=<name>
   ```

2. Redeploy (load env first):

   ```bash
   set -a; . infrastructure/kraftcloud/.env; set +a
   kraft cloud deploy --kraftfile infrastructure/kraftcloud/caddy/Kraftfile --service $SERVICE_NAME --rollout remove -p 443:8080/http+tls -p 8443:8082/tls -M 512M .
   ```

   **Warning:** Avoid `--subdomain` on redeploy to prevent "domain exists" error.

### Removing Services and Instances

**List services and instances:**

```bash
kraft cloud service ls --metro $UKC_METRO
kraft cloud instance ls --metro $UKC_METRO
```

**Remove a specific service:**

```bash
kraft cloud service remove <service-name-or-uuid> --metro $UKC_METRO
```

**Remove a specific instance:**

```bash
kraft cloud instance remove <instance-name-or-uuid> --metro $UKC_METRO
```

**Remove all instances:**

```bash
kraft cloud instance remove --all --metro $UKC_METRO
```

**Remove only stopped instances:**

```bash
kraft cloud instance remove --stopped --metro $UKC_METRO
```

**Note:** Removing a service also removes its associated instances. Remove Caddy service first if you want to keep OpenFGA instances running.

### Verify the Cloud Instance

Export vars:

```bash
export CADDY_REMOTE_HOST=https://<fqdn>
export STORE_ID=01KA43FJDTE8AQCYZ6252ZR9HS
export FGA_API_TOKEN=dev-key-1
```

Check:

```bash
curl -i "$CADDY_REMOTE_HOST/healthz"
curl -s "$CADDY_REMOTE_HOST/stores/$STORE_ID/check" -H "Authorization: Bearer $FGA_API_TOKEN" -H "Content-Type: application/json" -d '{"tuple_key": {"user": "user:alice", "relation": "viewer", "object": "project:roadmap"}}' | jq
```

### Relationship to `authz/docker-compose.yaml`

Reuses same env vars for consistency between local and cloud.

## Reference

- Unikraft CLI install guide: <https://unikraft.org/docs/cli/install>
- OpenFGA CLI docs: <https://openfga.dev/docs/getting-started/cli>
