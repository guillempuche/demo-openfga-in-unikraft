# Demo OpenFGA for Unikraft

## Overview

- Reproducible dev environment powered by `flake.nix` (OpenFGA CLI, KraftKit, TypeScript).
- Local OpenFGA server plus modular authorization models for Unikraft demos.
- Documentation collected here so you can get started from any platform quickly.

## Development Environment

Everything you need runs from the Nix dev shell declared at the repo root.

### Linux & macOS

1. **Install Nix**
   - **Recommended:** [Determinate Systems Nix Installer](https://zero-to-nix.com/start/install/) – single command, works on Linux/macOS/WSL.
   - **Alternative:** [Official NixOS installer](https://nixos.org/download.html).
   - Nix keeps Node.js, pnpm, TypeScript, `openfga-cli`, and `kraftkit` in lockstep across the team.
2. **Enter the dev shell**

   ```bash
   nix develop      # or for zsh: nix develop -c zsh
   ```

   The shell hook prints the OpenFGA CLI version so you can confirm the tooling.

### Windows

- Follow the [official Unikraft WSL2 instructions](https://unikraft.org/docs/cli/install#windows) to set up KraftKit prerequisites.
- Inside your WSL distribution, install Nix using one of the methods above and run `nix develop`.
- For OpenFGA specifics on Windows/WSL, see the [OpenFGA CLI guide](https://openfga.dev/docs/getting-started/cli).

## OpenFGA Local Setup

### Installation & Docs

Use the official guide at <https://openfga.dev/docs/getting-started/cli> to install the OpenFGA CLI, start a local server, and learn the basic workflow (stores, models, tuples, etc.).

### Runtime Endpoints

- Playground UI: `http://localhost:4082/playground`
- HTTP API: `https://localhost:4080` (self-signed TLS certificate)

### Authentication

Local auth uses a preshared key:

```
Authorization: Bearer dev-key-1
```

## Authorization Models

Models live under `authz/models/` and use OpenFGA’s modular system.

- `authz/models/fga.mod`: Manifest that enumerates included modules.
- `authz/models/projects.fga`: Users, projects, and lists with hierarchical sharing.
- `authz/models/tasks.fga`: Tasks that inherit rights from their parent lists.

### Deploy the Manifest

```sh
fga model write \
  --store-id=01JKBYH927ZKTK9N0SJWWAAXC0 \
  --api-url=https://localhost:4080 \
  --api-token=dev-key-1 \
  --file authz/models/fga.mod
```

### Inspect the Combined Model

```sh
fga model get --store-id=$STORE_ID
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

### Add a New Bounded Context

1. Create a `.fga` module in `authz/models/`.
2. Declare the module and add your relationships.
3. Append the file path to `authz/models/fga.mod`.
4. Add tests (`*.fga.yaml`) beside the module.
5. Redeploy with `fga model write`.

## Reference

- Unikraft CLI install guide: <https://unikraft.org/docs/cli/install>
- OpenFGA CLI docs: <https://openfga.dev/docs/getting-started/cli>
