# Demo OpenFGA for Unikraft

OpenFGA is one of the most widely adopted relationship-based authorization services, and this project shows how to host that service on the newest cloud tech: Unikraft unikernels. Everything in the repo—from the Docker Compose stack to the Nix dev shell—keeps the container and unikernel story perfectly aligned so you can iterate locally and then push the identical build to Unikraft Cloud.

## Table of Contents

- [Overview](#overview)
- [Directory Layout](#directory-layout)
- [Prerequisites](#prerequisites)
- [Local Smoke Test](#local-smoke-test)
- [OpenFGA Local Setup](#openfga-local-setup)
- [Authorization Models](#authorization-models)
  - [Deploy the Manifest](#deploy-the-manifest)
  - [Inspect the Combined Model](#inspect-the-combined-model)
  - [Test the Models](#test-the-models)
  - [Transform Models](#transform-models)
  - [Add a New Model](#add-a-new-model)
- [Unikraft Cloud Deployment](#unikraft-cloud-deployment)
  - [Prepare the Environment](#prepare-the-environment)
  - [Deploy OpenFGA](#deploy-openfga)
  - [Deploy Caddy](#deploy-caddy)
  - [Inspect & Troubleshoot](#inspect--troubleshoot)
  - [Clean Up](#clean-up)
- [Reference](#reference)

## Overview

- **Reproducible tooling** powered by `flake.nix`, pinning OpenFGA CLI, KraftKit, and supporting utilities.
- **Local OpenFGA stack** (PostgreSQL + OpenFGA + Caddy) that mirrors the configuration deployed to Unikraft Cloud.
- **Modular authorization models**, tests, and walkthroughs that highlight why OpenFGA remains a popular choice for ReBAC.

## Directory Layout

- `authz/` – Local development stack (Docker Compose) and authorization models.
- `authz/models/` – FGA modules (`projects.fga`, `tasks.fga`) and tests.
- `infrastructure/kraftcloud/` – Kraft Cloud deployment assets.
  - `openfga/` – OpenFGA Kraftfile and rootfs.
  - `caddy/` – Caddy Kraftfile and config.
  - `docker-compose.yaml` – Local validation stack matching the unikernels.
- `Dockerfile.openfga` – Build definition for the OpenFGA unikernel.
- `Dockerfile.caddy` – Build definition for the Caddy unikernel.

## Prerequisites

### Tooling

1. **Docker**: Required for running the local stacks via Docker Compose.
   - Verify: `docker --version && docker compose version`

2. **Nix**: (Recommended) Enter the dev shell for consistent tooling.
   - Install [Nix](https://zero-to-nix.com/start/install/).
   - Run: `nix develop` (or `nix develop -c zsh`).

### Cloud Auth

Export your Unikraft Cloud token and target metro before deploying:

```bash
export UKC_TOKEN="<your-kraftcloud-token>"
export UKC_METRO=fra
```

## Local Smoke Test

Use Docker Compose to confirm the build boots with your `.env` configuration. This uses the same Dockerfiles as the cloud deployment.

```bash
cp infrastructure/kraftcloud/.env.prod.example infrastructure/kraftcloud/.env

docker compose \
  -f infrastructure/kraftcloud/docker-compose.yaml \
  --env-file infrastructure/kraftcloud/.env \
  up --build
```

Ensure you have a PostgreSQL instance running (e.g., from the `authz/docker-compose.yaml` stack) and configured in `.env` if testing full functionality.

## OpenFGA Local Setup

This is the reference deployment for **development**. It uses standard container images to prove out model changes and CLI flows.

### Quick Start

1. **Create the environment configuration**:

   ```bash
   cp authz/.env.example authz/.env
   ```

2. **Start the stack**:

   ```bash
   docker compose -f authz/docker-compose.yaml up -d
   ```

   - API: `http://localhost:8080`
   - Playground: `http://localhost:8082/playground`

3. **Load the model**:

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

## Authorization Models

OpenFGA stays popular because its modeling experience scales, so the repo keeps the canonical modules in `authz/models/` and runs them identically on Docker and Unikraft targets.

- `authz/models/fga.mod`: Manifest that enumerates included modules.
- `authz/models/projects.fga`: Users, projects, and lists with hierarchical sharing.
- `authz/models/tasks.fga`: Tasks that inherit rights from their parent lists.

Export the helper variables once per shell session so the CLI examples just work:

```bash
export STORE_ID=01KA43FJDTE8AQCYZ6252ZR9HS
export FGA_API_URL=http://localhost:8080
export FGA_API_TOKEN=dev-key-1
```

### Deploy the Manifest

```bash
fga model write \
  --store-id=$STORE_ID \
  --api-url=$FGA_API_URL \
  --api-token=$FGA_API_TOKEN \
  --file authz/models/fga.mod
```

The CLI prints the newly created `authorization_model_id`. This is the version identifier for the model you just wrote—keep using the same `STORE_ID` for all other commands, and optionally pass `--authorization-model-id` when you want to inspect an older version.

### Inspect the Combined Model

```bash
fga model get \
  --store-id=$STORE_ID \
  --api-url=$FGA_API_URL \
  --api-token=$FGA_API_TOKEN
```

### Test the Models

Run from the repository root so the relative paths resolve correctly:

```bash
fga model test --tests authz/models/projects.fga.yaml authz/models/tasks.fga.yaml
```

### Transform Models

```bash
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

Deploy the exact same stack to Unikraft Cloud unikernels.

### Prepare the Environment

1. Copy the env file and configure your domain.

   ```bash
   cp infrastructure/kraftcloud/.env.prod.example infrastructure/kraftcloud/.env

   export SUBDOMAIN=iapacte-openfga # Pick a unique subdomain
   export DOMAIN="$SUBDOMAIN.$UKC_METRO.unikraft.app"

   # Update .env with your domain
   perl -i -pe "s|^OPENFGA_API_HOST=.*|OPENFGA_API_HOST=$DOMAIN|" infrastructure/kraftcloud/.env
   perl -i -pe "s|^OPENFGA_PLAYGROUND_HOST=.*|OPENFGA_PLAYGROUND_HOST=$DOMAIN|" infrastructure/kraftcloud/.env
   ```

2. Load the env vars whenever you deploy:

   ```bash
   set -a; . infrastructure/kraftcloud/.env; set +a
   ```

### Deploy OpenFGA

Deploy the backend server first to establish the internal network.

```bash
kraft cloud deploy \
  --kraftfile infrastructure/kraftcloud/openfga/Kraftfile \
  -M 1G \
  .
```

**Capture the OpenFGA IP and update .env:**

```bash
OPENFGA_INSTANCE=$(kraft cloud instance ls --metro $UKC_METRO -o json | jq -r 'sort_by(.created_at) | last | .name')
OPENFGA_IP=$(kraft cloud instance get $OPENFGA_INSTANCE --metro $UKC_METRO -o json | jq -r '.private_ip')

# Update .env
perl -i -pe "s|^OPENFGA_UPSTREAM_HOST=.*|OPENFGA_UPSTREAM_HOST=$OPENFGA_IP|" infrastructure/kraftcloud/.env

# Reload env
set -a; . infrastructure/kraftcloud/.env; set +a
```

### Deploy Caddy

Deploy the reverse proxy to expose the service.

```bash
kraft cloud deploy \
  --kraftfile infrastructure/kraftcloud/caddy/Kraftfile \
  --subdomain "$SUBDOMAIN" \
  -p 80:443/http+redirect \
  -p 443:8080/http+tls \
  -p 8443:8082/tls \
  -M 512M \
  .
```

- `-p 80:443/http+redirect`: Redirects HTTP traffic to HTTPS.
- `-p 443:8080/http+tls`: Exposes the OpenFGA API on the main domain (HTTPS).
- `-p 8443:8082/tls`: Exposes the Playground on port 8443 (TLS).

### Inspect & Troubleshoot

- **View services**: `kraft cloud service ls --metro $UKC_METRO`
- **Tail logs**: `kraft cloud instance logs <instance> --metro $UKC_METRO`
- **Verify Health**:

  ```bash
  curl -i "https://$DOMAIN/healthz"
  ```

### Clean Up

Remove instances and services when you are done to avoid costs.

**Remove instances:**

```bash
# List instances
kraft cloud instance ls --metro $UKC_METRO

# Remove specific instance
kraft cloud instance remove <instance-name> --metro $UKC_METRO
```

**Remove services:**

```bash
# List services
kraft cloud service ls --metro $UKC_METRO

# Remove specific service
kraft cloud service remove <service-name> --metro $UKC_METRO
```

## Reference

- [Unikraft CLI install guide](https://unikraft.org/docs/cli/install)
- [OpenFGA CLI docs](https://openfga.dev/docs/getting-started/cli)
