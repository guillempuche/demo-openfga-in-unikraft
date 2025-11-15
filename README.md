# Demo OpenFGA for Unikraft

## Overview

- Reproducible dev environment powered by `flake.nix` (OpenFGA CLI, KraftKit, TypeScript).
- Local OpenFGA server plus modular authorization models for Unikraft demos.
- Documentation collected here so you can get started from any platform quickly.

## Development Environment

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
   - Nix keeps Node.js, pnpm, TypeScript, `openfga-cli`, and `kraftkit` in lockstep across the team.
2. **Enter the dev shell**

   ```bash
   nix develop # or for zsh: nix develop -c zsh
   ```

   The shell hook prints the OpenFGA CLI version so you can confirm the tooling.

#### Windows

- Follow the [official Unikraft WSL2 instructions](https://unikraft.org/docs/cli/install#windows) to set up KraftKit prerequisites.
- Inside your WSL distribution, install Nix using one of the methods above and run `nix develop`.
- For OpenFGA specifics on Windows/WSL, see the [OpenFGA CLI guide](https://openfga.dev/docs/getting-started/cli).

## OpenFGA Local Setup

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

Use the official guide at <https://openfga.dev/docs/getting-started/cli> to learn more about the OpenFGA CLI workflow (stores, models, tuples, etc.).

## Authorization Models

Models live under `authz/models/` and use OpenFGA’s modular system.

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

## Reference

- Unikraft CLI install guide: <https://unikraft.org/docs/cli/install>
- OpenFGA CLI docs: <https://openfga.dev/docs/getting-started/cli>
