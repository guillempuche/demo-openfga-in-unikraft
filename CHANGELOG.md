# Changelog

Notable changes to this example. Results behind each claim are in [docs/RESULTS.md](docs/RESULTS.md).

## [Unreleased]

### Deployment

- Encrypted both private hops with TLS: the API reaches OpenFGA over HTTPS and OpenFGA reaches PostgreSQL with `verify-full`, each checking the server's certificate against a private CA. On by default (`INTERNAL_TLS=off` turns it off); `tls.sh` issues the certificates, or bring your own.
- Checked TLS on the deployment with `check-tls.sh`, in Docker with `check-tls-chain.sh` (CI), and in the PostgreSQL image check; ran the integration suite over TLS.
- Kept the tunnel's local URLs with a local TLS client (`tls-forward.mjs`), and moved the local Compose stack to TLS behind a loopback-only Caddy.
- Pinned the Node.js base image by digest.
- Ran the official, cosign-signed OpenFGA binary (pinned by digest) instead of a source build, checked in CI.
- Applied OpenFGA's production settings: query limits, concurrent-read limits, datastore metrics and RPC histograms.
- Kept the API's public URL across redeploys with a persistent service group; `cleanup.sh --service` deletes it.
- Restarted Postgres, OpenFGA and the API whenever they exit (`restart: always`).
- Let Postgres scale to zero (idle, stateful), with OpenFGA closing idle connections; measured ~82 ms for the first uncached check after a quiet period.
- Baked safe, non-secret OpenFGA defaults into the image, with a CI check that keeps secrets out of Kraftfiles.
- Pinned the authorization model in the API; `seed.sh` writes a model only when it changed.
- Checked pushed digests with `images get` instead of the lagging image listing; added healthchecks to both compose stacks.

### API

- Reported client mistakes as 400 (including duplicate correlation ids) and per-item OpenFGA errors in `/batch-check`.
- Used Effect's schema-error hook (response bugs answer 500), a typed 415, `Cache`, `Semaphore` and JSON fatal logs.
- Sent a trusted `current_time` and the client's `user_ip` with every check, so the model's conditions work through the API.
- Added `/docs`, `FGA_MODEL_ID`, `CLIENT_IP_FROM`, `CURRENT_TIME_STEP` and `FGA_STORE_CACHE_TTL`.
- Exited right after the last in-flight answer on SIGTERM, instead of waiting 3–6 s for clients to close kept-alive connections: answers sent during shutdown carry `Connection: close`.

### Authorization model and tests

- Applied blocks to direct list and task grants and through the folder's org; gave grants a start time; limited exporters to the project's org; let folder owners manage their projects.
- Rewrote every test in BDD style: 109 model tests, 151 integration tests, 157 API tests against a stub and 27 against a real OpenFGA.
- Added condition-boundary mutants to the model coverage gate.
- Added Renovate, grouping OpenFGA server and CLI bumps in one PR.

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
