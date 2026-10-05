import { Config, Duration, Schema } from 'effect'

// The ULID pattern the OpenFGA SDK enforces on store ids. Checking it here makes
// a mistyped FGA_STORE_ID stop the process instead of failing every request.
const StoreId = Schema.String.check(Schema.isPattern(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/))

// Read once at startup and validated there: a missing or empty FGA_KEY, a
// malformed URL or port, or a non-ULID FGA_STORE_ID stops the process before it
// serves anything. FGA_KEY is a Redacted value, so it never shows up in logs or
// error messages.
export const AppConfig = Config.all({
  port: Config.Port('PORT').pipe(Config.withDefault(8080)),
  // Private FQDN of the OpenFGA instance on the Unikraft internal network. Only
  // its origin is used: a path in the URL is ignored.
  fgaApiUrl: Config.URL('FGA_API_URL').pipe(Config.withDefault(new URL('http://demo-fga-openfga.internal:8080'))),
  fgaKey: Config.schema(Schema.Redacted(Schema.NonEmptyString), 'FGA_KEY'),
  // The store is looked up by name, so redeploys need no store ID; set
  // FGA_STORE_ID to pin one instead (no lookup by name, no fallback to it).
  storeName: Config.String('FGA_STORE_NAME').pipe(Config.withDefault('demo-fga')),
  pinnedStoreId: Config.option(Config.schema(StoreId, 'FGA_STORE_ID')),
  // How long the store id and its latest model id are reused before being
  // looked up again, e.g. "30 seconds" or "500 millis".
  storeCacheTtl: Config.Duration('FGA_STORE_CACHE_TTL').pipe(Config.withDefault(Duration.seconds(30))),
})
