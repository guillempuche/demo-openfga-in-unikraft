---
name: unikraft
description: Unikraft CLI (`unikraft`) commands for building and deploying unikernels to Unikraft Cloud. Use when working with Kraftfiles, deploying or inspecting instances, tunnels, services or images on Unikraft Cloud.
---

# Unikraft CLI Reference

Build images and run instances on Unikraft Cloud with the `unikraft` CLI. The legacy `kraft cloud` CLI is deprecated; don't use it.

- Docs: <https://unikraft.com/docs/cli/unikraft>
- Migration from kraft: <https://unikraft.com/docs/tutorials/kraftkit-to-unikraft>
- Networking: <https://unikraft.com/docs/platform/networking>
- Examples: <https://github.com/unikraft-cloud/examples> (e.g. `httpserver-node26`)
- `unikraft <command> --help` is the most up-to-date reference.

## Rules

1. **Show commands first** in a copy-paste code block, then ask before running anything that creates, changes or deletes cloud resources. Read-only commands (`list`, `get`, `quotas`) are fine.
2. **Never print or log secrets.** Don't echo `UKC_TOKEN`, keys or connection strings; don't run `env`/`set -x`.
3. **`instances get` prints `runtime.env`** (secrets) unless you select fields: always use `-f name,state,networks,...`.
4. **Avoid secrets on argv.** `unikraft run -e` requires `KEY=VALUE`. For secrets, write the instance spec to a `0600` temp YAML and pass `unikraft run --load <file>`. `--load` replaces all flags; generate the schema with `unikraft run ... --dry-run --save spec.yaml`, using dummy values.
5. **Only touch your own resources.** Check `unikraft instances list` and never stop or delete instances you didn't create; never use `instances delete --all`.

## Auth

```bash
unikraft login              # browser login, stored in a profile
unikraft profile list       # active profile + metros
unikraft quotas             # instance/memory/vCPU usage per metro
```

`UKC_TOKEN`/`UKC_METRO` are only read by the legacy CLI. Write commands need `--metro`.

## Build

```bash
unikraft build <dir|Kraftfile|Dockerfile> --output <org>/<image>:latest   # build + push
unikraft build . --output ./dist/app.oci.tar                               # local OCI archive
```

Kraftfile (spec v0.7). `rootfs.source` is relative to the Kraftfile:

```yaml
spec: v0.7
runtime: base-compat:latest
targets:
  - kraftcloud/x86_64
rootfs:
  source: ./Dockerfile
  format: erofs
cmd: ["/usr/bin/node", "/usr/src/server.js"]
```

## Run

```bash
unikraft run --metro fra -n my-app --image <org>/my-app:latest \
  -m 512MiB \
  -p 443:8080/http+tls -p 80:443/http+redirect \
  --scale-to-zero policy=on,cooldown-time=5000 \
  --restart on-failure \
  -e KEY=VALUE
```

- No `-p` means no public service: the instance is reachable only on the internal network.
- `--scale-to-zero policy=on|idle|off[,cooldown-time=ms][,stateful=true]`; omitting it means no scale-to-zero.
- Memory uses binary units (`512M` = `512MiB`).
- `--dry-run` previews (prints env values!), `-o quiet` suppresses output.

## Instances

```bash
unikraft instances list [--filter 'state==running,metro==fra']
unikraft instances get <name> -f name,state,networks,service.domains
unikraft instances wait <name> --until state==running
unikraft instances logs <name> [-f]
unikraft instances delete <name>
unikraft instances tunnel [LOCAL:]<metro>/<name>:PORT[/tcp]   # reach an unexposed instance
```

## Internal networking

Every instance gets a private IP (`networks.*.private-ip`) and a private FQDN `<instance-name>.internal`, resolvable from other instances of the same account. Traffic is unencrypted and never leaves the account network. `instances tunnel` uses a temporary relay instance to reach private instances from your machine.

## Other resources

```bash
unikraft services list | get | delete
unikraft images list | get | delete
unikraft volumes list | create | delete
unikraft certificates list
unikraft api <path>          # raw authenticated API request
```
