import { Config } from 'effect'

// Read once at startup and validated there: a missing FGA_KEY or a malformed
// URL stops the process before it serves anything. FGA_KEY is a Redacted
// value, so it never shows up in logs or error messages.
export const AppConfig = Config.all({
  port: Config.Port('PORT').pipe(Config.withDefault(8080)),
  // Private FQDN of the OpenFGA instance on the Unikraft internal network.
  fgaApiUrl: Config.URL('FGA_API_URL').pipe(Config.withDefault(new URL('http://demo-fga-openfga.internal:8080'))),
  fgaKey: Config.Redacted('FGA_KEY'),
  // The store is looked up by name, so redeploys need no store ID; set
  // FGA_STORE_ID to pin one instead.
  storeName: Config.String('FGA_STORE_NAME').pipe(Config.withDefault('demo-fga')),
  pinnedStoreId: Config.option(Config.String('FGA_STORE_ID')),
})
