# AI Agent Context

This document provides context for AI coding assistants working on this project.

## Project Overview

Demo project showcasing the OpenFGA authorization system running both in local containers and on Unikraft unikernels. Currently implements a modular ReBAC (Relationship-Based Access Control) system for managing permissions across projects, lists, and tasks, and includes the Kraftfiles and rootfs assets needed to push the same build to Unikraft Cloud.

## Tech Stack

- **Authorization**: OpenFGA v1.11.0 (FGA DSL models)
- **Database**: PostgreSQL 17.2
- **Infrastructure**: Docker Compose + Unikraft Cloud (kraft cloud workloads)
- **Dev Environment**: Nix Flakes (reproducible tooling)
- **Future**: Additional benchmarks and ReBAC modules

## Architecture

### Authorization Models

Located in `authz/models/`:

- `fga.mod`: Manifest declaring included modules
- `projects.fga`: Project-level permissions (owner, contributor, viewer)
- `tasks.fga`: Task-level permissions with list inheritance

Permission flow: `project → list → task` (hierarchical inheritance)

### Key Concepts

- **ReBAC**: Relationship-based checks (`user:alice` has relation `owner` with `project:roadmap`)
- **Modular models**: Separate bounded contexts that reference each other
- **Cascading permissions**: Child resources inherit parent permissions via `from` clauses

## Development Workflow

### Environment Setup

```bash
nix develop          # Enter dev shell
cd authz
docker compose up -d # Start OpenFGA + PostgreSQL
```

### Common Tasks

**Deploy authorization model:**

```bash
fga model write \
  --store-id=01JKBYH927ZKTK9N0SJWWAAXC0 \
  --api-url=https://localhost:4080 \
  --api-token=dev-key-1 \
  --file authz/models/fga.mod
```

**Run tests:**

```bash
fga model test --tests authz/models/projects.fga.yaml authz/models/tasks.fga.yaml
```

**Check permissions:**

```bash
fga query check user:alice can_edit project:roadmap
```

### Kraft CLI Commands

See the [unikraft skill](.claude/skills/unikraft/SKILL.md) for full Kraft CLI reference.

**Environment Setup (required for cloud commands):**

```bash
export UKC_TOKEN="your-token"   # Unikraft Cloud API token
export UKC_METRO=fra            # Metro/region (e.g., fra, ams, lon)
```

**Quick Reference:**

```bash
kraft build                     # Build unikernels
kraft cloud deploy              # Deploy to Unikraft Cloud
kraft cloud compose up          # Deploy compose project
kraft cloud instance logs       # Get instance console output
kraft cloud service list        # List services
```

## File Structure

```
.
├── authz/
│   ├── docker-compose.yaml      # OpenFGA + PostgreSQL stack
│   ├── .env.example             # Environment variables template
│   └── models/
│       ├── fga.mod              # Model manifest
│       ├── projects.fga         # Project authorization logic
│       ├── projects.fga.yaml    # Project tests
│       ├── tasks.fga            # Task authorization logic
│       └── tasks.fga.yaml       # Task tests
├── flake.nix                    # Nix dev environment
├── flake.lock                   # Pinned dependencies
└── README.md                    # User-facing documentation
```

## Important Notes

- Local server uses self-signed TLS cert (expect certificate warnings)
- Store ID is hard-coded in `.env.example` (create via `fga store create` if needed)
- Playground UI available at `http://localhost:8082/playground`

## Documentation References

For detailed guides, see [README.md](README.md):

- [Local Setup](README.md#openfga-local-setup) – Docker Compose stack for development
- [Authorization Models](README.md#authorization-models) – Deploy, inspect, test, and extend FGA models
- [Unikraft Cloud Deployment](README.md#unikraft-cloud-deployment) – Deploy to Unikraft unikernels
- [Local Smoke Test](README.md#local-smoke-test) – Validate builds before cloud deployment

## Testing Strategy

Each `.fga` module has a corresponding `.fga.yaml` test file:

- Define tuples (relationships)
- Assert expected authorization outcomes
- Cover positive and negative cases
- Test inheritance and cascading permissions

## External References

- [OpenFGA Documentation](https://openfga.dev/docs)
- [Unikraft Documentation](https://unikraft.org/docs)
- [FGA DSL Syntax](https://openfga.dev/docs/modeling/language)
