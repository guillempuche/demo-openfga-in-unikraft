# PostgreSQL Deployment for OpenFGA on KraftCloud

## Overview

Deploy PostgreSQL on KraftCloud and configure OpenFGA to connect to it. Based on [Unikraft Cloud's official PostgreSQL example](https://github.com/unikraft-cloud/examples/tree/main/postgres).

## Architecture

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│     Caddy       │─────▶│    OpenFGA      │─────▶│   PostgreSQL    │
│  (TLS proxy)    │      │   (API server)  │      │   (database)    │
│  public FQDN    │      │  .internal DNS  │      │  .internal DNS  │
└─────────────────┘      └─────────────────┘      └─────────────────┘
```

---

## Deployment Approaches

### Approach 1: Compose (Recommended)

Using `kraft cloud compose` deploys services together with automatic internal DNS (`<container_name>.internal`).

**Status:** 🔄 In Progress

### Approach 2: Individual Deploy with Private IP

Deploy services individually using `kraft cloud deploy` and connect via private IP.

**Status:** ❌ Failed - Private IP connection times out between instances

### Approach 3: Individual Deploy with Public FQDN + TLS

Deploy services individually and connect via public FQDN with TLS.

**Status:** ⚠️ Works but exposes database publicly

---

## Approach 1: Compose Deployment (Recommended)

### Prerequisites

1. Clone PostgreSQL example (already done):
   ```bash
   git clone https://github.com/unikraft-cloud/examples /tmp/ukc-examples
   cp -r /tmp/ukc-examples/postgres infrastructure/kraftcloud/postgres
   ```

2. Compose file: `infrastructure/kraftcloud/compose.yaml`

### Step 1: Deploy PostgreSQL First

```bash
kraft cloud compose --file infrastructure/kraftcloud/compose.yaml up postgres --metro fra
```

**Build time:** First deployment takes 5-10 minutes (compiling PostgreSQL from source).

### Step 2: Get PostgreSQL FQDN

```bash
kraft cloud instance get postgres --metro fra
```

Look for the `fqdn` field (e.g., `xxx-yyy-zzz.fra.unikraft.app`).

### Step 3: Run OpenFGA Migrations

OpenFGA requires database migrations before starting:

```bash
docker run --rm openfga/openfga migrate \
  --datastore-engine postgres \
  --datastore-uri "postgres://openfga:asdf1234@<postgres-fqdn>:5432/openfga?sslmode=require"
```

Replace `<postgres-fqdn>` with the actual FQDN from step 2.

### Step 4: Deploy Full Stack

```bash
kraft cloud compose --file infrastructure/kraftcloud/compose.yaml up --metro fra
```

### Step 5: Verify

```bash
# List services
kraft cloud compose --file infrastructure/kraftcloud/compose.yaml ps --metro fra

# Check OpenFGA logs
kraft cloud instance logs openfga --metro fra
```

**Expected log output:**
```json
{"level":"info","msg":"successfully connected to database"}
{"level":"info","msg":"OpenFGA API server listening on 0.0.0.0:8080"}
```

### Compose File Reference

See `infrastructure/kraftcloud/compose.yaml` for full configuration.

Key points:
- **Internal DNS:** Services use `<container_name>.internal` (e.g., `postgres.internal:5432`)
- **Port format:** Use simple `EXTERNAL:INTERNAL` (e.g., `443:8080`), NOT `/tls` or `/http+tls` suffixes
- **Volumes:** Declared with `driver_opts: size: 512M`
- **Memory:** Set with `mem_reservation: 1024M`

---

## Approach 2: Individual Deploy (Issues Encountered)

This approach was attempted first but encountered issues.

### What We Tried

1. Deploy PostgreSQL with `kraft cloud deploy`:
   ```bash
   kraft cloud deploy \
     --kraftfile infrastructure/kraftcloud/postgres/Kraftfile \
     -e POSTGRES_PASSWORD=asdf1234 \
     -p 5432:5432/tls \
     --name postgres \
     infrastructure/kraftcloud/postgres
   ```

2. Deploy OpenFGA connecting to private IP:
   ```bash
   kraft cloud deploy \
     -e OPENFGA_DATASTORE_URI="postgres://openfga:asdf1234@10.0.1.229:5432/openfga?sslmode=disable" \
     .
   ```

### Issues Encountered

#### Issue 1: Private IP Connection Timeout

**Error:**
```
dial error: timeout: context deadline exceeded
```

OpenFGA couldn't connect to PostgreSQL via private IP (`10.0.1.229:5432`), even though both instances were running in the same metro.

#### Issue 2: Private FQDN Empty

The `private fqdn` field was empty for instances in `fra` metro:
```
kraft cloud instance get postgres --metro fra
# private fqdn: (empty)
```

#### Issue 3: `postgres.internal` DNS Not Resolving

Attempting to use `postgres.internal` as hostname:
```
lookup postgres.internal... no such host
```

**Root Cause:** The `.internal` DNS only works when services are deployed together via `kraft cloud compose`, not when deployed individually.

### Workaround: Public FQDN + TLS

Using the public service FQDN with TLS works but exposes the database:
```bash
OPENFGA_DATASTORE_URI="postgres://openfga:asdf1234@aged-dew-7tdv37m0.fra.unikraft.app:5432/openfga?sslmode=require"
```

**Security concern:** Database is publicly accessible (though TLS encrypted and password protected).

---

## Configuration Reference

### PostgreSQL Environment Variables

| Variable | Value | Description |
|----------|-------|-------------|
| `POSTGRES_PASSWORD` | `asdf1234` | Database password |
| `POSTGRES_USER` | `openfga` | Database user |
| `POSTGRES_DB` | `openfga` | Database name |
| `PGDATA` | `/volume/postgres` | Data directory (on volume) |

### OpenFGA Connection Strings

**Internal (compose):**
```
postgres://openfga:asdf1234@postgres.internal:5432/openfga?sslmode=disable
```

**External (migrations):**
```
postgres://openfga:asdf1234@<fqdn>.fra.unikraft.app:5432/openfga?sslmode=require
```

---

## Troubleshooting

### Compose port format errors

**Error:** `invalid proto: tls` or `invalid proto: http+tls`

**Fix:** Use simple port format in compose files:
```yaml
ports:
  - 443:8080    # Correct
  - 443:8080/http+tls  # Wrong
```

### OpenFGA can't connect to database

1. Check PostgreSQL is running:
   ```bash
   kraft cloud instance get postgres --metro fra
   ```

2. Verify internal DNS (only works with compose):
   ```bash
   kraft cloud instance logs openfga --metro fra
   ```

3. If using individual deploy, use public FQDN with `sslmode=require`

### Migrations fail

Ensure you're using:
- Public FQDN (not private IP or .internal)
- `sslmode=require` (not `sslmode=disable`)

---

## Files

| File | Description |
|------|-------------|
| `infrastructure/kraftcloud/compose.yaml` | Compose file for KraftCloud deployment |
| `infrastructure/kraftcloud/postgres/` | PostgreSQL build files (from examples) |
| `infrastructure/kraftcloud/openfga/Kraftfile` | OpenFGA Kraftfile |
| `Dockerfile.openfga` | OpenFGA Docker build |

---

## References

- [KraftCloud Compose Docs](https://unikraft.org/docs/cli/reference/kraft/cloud/compose)
- [Flask-Redis Example](https://github.com/unikraft-cloud/examples/tree/main/flask-redis) - Shows `.internal` DNS usage
- [Nginx-Flask-Mongo Example](https://github.com/unikraft-cloud/examples/tree/main/nginx-flask-mongo) - Shows volumes in compose
- [PostgreSQL Example](https://github.com/unikraft-cloud/examples/tree/main/postgres)
- [OpenFGA Documentation](https://openfga.dev/docs)
