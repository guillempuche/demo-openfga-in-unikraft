# Changelog

Notable changes to this example. Results behind each claim are in [docs/RESULTS.md](docs/RESULTS.md).

## [0.1.0] - 2026-10-05

First tagged version: OpenFGA v1.21.0 and PostgreSQL 16 as private Unikraft Cloud instances, behind a public TypeScript API.

### Deployment

- Deployed with the `unikraft` CLI 0.5 instead of the deprecated `kraft cloud`: OpenFGA, PostgreSQL and the API all run on Unikraft Cloud.
- Kept OpenFGA and PostgreSQL private (no service), reached over `<name>.internal`; only the API is public.
- Built images to a local OCI archive and pushed them with `unikraft images copy`, avoiding upload resets on slow links.
- Passed secrets through a 0600 spec file (`unikraft run --load`), never on the command line, and kept them out of script output.

### API

- Built the API with Effect 4 (`HttpApi`) and `@openfga/sdk` 0.9.7: `/health`, `/check` (with optional `consistency`), `/batch-check`, `/list-objects`, `/bench` and `/openapi.json`, with JSON errors.
- Closed idle connections to OpenFGA after 4 s so the API can scale to zero.
- Bundled the API into a single file for a scratch unikernel rootfs.

### Authorization model and tests

- Modelled org → team → folder → project → list → task in four modules, one test file per OpenFGA feature (28 tests, 190 checks).
- Gated model coverage: an allowed and a denied check per relation, and every single-rule mutant of the model killed.
- Added an integration suite that calls every OpenFGA RPC (19 core, 6 AuthZEN) and confirms each in OpenFGA's own metrics.
- Added end-to-end checks on Unikraft: `.internal` resolution, write → public API → delete, data persistence across redeploys, and wake time from standby.

### Docs

- Added a feature guide ([docs/openfga-features.md](docs/openfga-features.md)) with model excerpts, plain-SDK and Effect calls, and test names.
- Added context for AI coding agents ([AGENTS.md](AGENTS.md)) and the OpenFGA sources under `docs/repos/` for reference.

[0.1.0]: https://github.com/guillempuche/demo-openfga-in-unikraft/releases/tag/v0.1.0
