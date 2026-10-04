# Vendored OpenFGA repositories (reference only)

Read-only copies of upstream OpenFGA repositories, added with `git subtree --squash`
so people and AI agents can read OpenFGA's internals (API definitions, server
behaviour, SDK and CLI code) next to this demo. Nothing here is built or run by
this repository, and the files keep their upstream licenses (Apache-2.0).

| Directory | Upstream | Ref |
| --- | --- | --- |
| `openfga/` | https://github.com/openfga/openfga | `v1.21.0` |
| `api/` | https://github.com/openfga/api (protobuf + OpenAPI) | `main` at vendoring time |
| `js-sdk/` | https://github.com/openfga/js-sdk | `v0.9.7` |
| `cli/` | https://github.com/openfga/cli | `v0.8.1` |
| `language/` | https://github.com/openfga/language (DSL, model tests) | `main` at vendoring time |
| `sample-stores/` | https://github.com/openfga/sample-stores | `main` at vendoring time |

How the rest of the repository keeps away from this folder:

- CI, scripts and tests only touch `authz/`, `api/` and `scripts/`; GitHub runs workflows from the root `.github/` only, so the upstream workflows here never run.
- `.ignore` hides it from `rg` and tools built on it unless you pass the path explicitly.
- `.gitattributes` marks it vendored (excluded from language statistics and code search).
- `.vscode/settings.json` makes it read-only and excludes it from search and file watching.
- Upstream `AGENTS.md`, `CLAUDE.md` and Copilot instruction files in here apply to those projects, not to this repository.

Don't edit these files. To update one, pull a newer ref:

```bash
git subtree pull --prefix=docs/repos/openfga https://github.com/openfga/openfga.git v1.22.0 --squash
```
