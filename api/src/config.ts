import { X509Certificate } from 'node:crypto'
import { Config, Duration, Schema } from 'effect'

// The ULID pattern the OpenFGA SDK enforces on store and model ids. Checking it
// here makes a mistyped FGA_STORE_ID or FGA_MODEL_ID stop the process instead
// of failing every request.
const Ulid = Schema.String.check(Schema.isPattern(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/))

// Parsed at startup, so a truncated or wrongly pasted certificate stops the
// process instead of failing every call to OpenFGA.
const PemCertificate = Schema.String.check(
  Schema.makeFilter((pem: string) => {
    try {
      new X509Certificate(pem)
      return true
    } catch {
      return 'expected a PEM certificate (-----BEGIN CERTIFICATE-----)'
    }
  }),
)

// Zero or an infinite step would leave nothing to round to.
const TimeStep = Schema.DurationFromString.check(
  Schema.makeFilter(
    (step: Duration.Duration) =>
      (Duration.isFinite(step) && Duration.toMillis(step) >= 1) || 'expected a finite duration of at least 1 millisecond',
  ),
)

// Read once at startup and validated there: a missing or empty FGA_KEY, a
// malformed URL, port, duration or certificate, a non-ULID store or model id,
// or an unknown CLIENT_IP_FROM stops the process before it serves anything.
// FGA_KEY is a Redacted value, so it never shows up in logs or error messages.
export const AppConfig = Config.all({
  port: Config.Port('PORT').pipe(Config.withDefault(8080)),
  // Private FQDN of the OpenFGA instance on the Unikraft internal network, over
  // TLS (https) unless the deployment turns it off (INTERNAL_TLS=off). Only its
  // origin is used: a path in the URL is ignored.
  fgaApiUrl: Config.URL('FGA_API_URL').pipe(Config.withDefault(new URL('https://demo-fga-openfga.internal:8080'))),
  // The certificate authority (CA) that signed OpenFGA's TLS certificate, as
  // PEM text (scripts/tls.sh creates it, deploy.sh passes it). When set, the
  // connection to OpenFGA trusts this CA and no other; when not, the system's
  // public CAs, for an OpenFGA with a public certificate.
  fgaCaCert: Config.option(Config.schema(PemCertificate, 'TLS_CA_PEM')),
  fgaKey: Config.schema(Schema.Redacted(Schema.NonEmptyString), 'FGA_KEY'),
  // The store is looked up by name, so redeploys need no store ID; set
  // FGA_STORE_ID to pin one instead (no lookup by name, no fallback to it).
  storeName: Config.String('FGA_STORE_NAME').pipe(Config.withDefault('demo-fga')),
  pinnedStoreId: Config.option(Config.schema(Ulid, 'FGA_STORE_ID')),
  // Checks use the store's latest model unless FGA_MODEL_ID pins one: then a
  // model written later changes nothing until the API is redeployed with its
  // id, and the models are never read. An id the store doesn't have answers
  // 502 "store or model not found" (no fallback to the latest).
  pinnedModelId: Config.option(Config.schema(Ulid, 'FGA_MODEL_ID')),
  // How long the store id and its latest model id are reused before being
  // looked up again, e.g. "30 seconds" or "500 millis".
  storeCacheTtl: Config.Duration('FGA_STORE_CACHE_TTL').pipe(Config.withDefault(Duration.seconds(30))),
  // Where the user_ip condition parameter comes from:
  // - socket: the TCP peer, for direct connections (local runs).
  // - x-forwarded-for: the header's last entry, the one the nearest proxy
  //   added. On Unikraft Cloud the platform proxy replaces the header with the
  //   caller's address, and the TCP peer is the proxy itself. That holds only
  //   for traffic through the proxy: any instance in the same Unikraft account
  //   can reach the API's port over the internal network and send any
  //   X-Forwarded-For, so the trust boundary is the account.
  // X-Real-IP is never read: Unikraft's proxy passes a caller's value through.
  clientIpFrom: Config.Literals(['socket', 'x-forwarded-for'], 'CLIENT_IP_FROM').pipe(Config.withDefault('socket' as const)),
  // current_time comes from the server clock, rounded down to this step.
  // OpenFGA's check cache is keyed on the request context too, so a timestamp
  // that changed with every request would make every check a cache miss;
  // conditions see time at this granularity instead.
  currentTimeStep: Config.schema(TimeStep, 'CURRENT_TIME_STEP').pipe(Config.withDefault(Duration.seconds(10))),
})
