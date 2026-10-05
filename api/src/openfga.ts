// OpenFGA as an Effect service, built on the official SDK (@openfga/sdk).
//
// - The store is found by name and its latest model pinned; both are cached
//   for STORE_TTL and dropped as soon as OpenFGA says the store or model is
//   gone (OpenFGA soft-deletes stores: a deleted store still answers checks,
//   so the TTL also catches a store that was recreated under the same name).
// - One retry policy: the SDK's own retries are off, Effect retries transient
//   failures. Effect's timeout cancels the HTTP call through an AbortSignal.
// - SDK errors become typed errors: invalid requests -> BadRequest, everything
//   else (network, 5xx, auth to OpenFGA) -> UpstreamError with the status.
// - Idle connections to OpenFGA close after IDLE_SOCKET. The SDK's own agents
//   keep them open forever, and with scale-to-zero policy `on` an open TCP
//   connection keeps the API instance from going to standby.

import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import {
  CredentialsMethod,
  FgaApiValidationError,
  FgaApiNotFoundError,
  FgaApiError,
  OpenFgaClient,
  type ClientBatchCheckItem,
} from '@openfga/sdk'
import { Context, Duration, Effect, Layer, Option, Redacted, Schedule } from 'effect'
import { AppConfig } from './config.ts'
import { BadRequest, UpstreamError } from './errors.ts'

const STORE_TTL = Duration.seconds(30)
const CALL_TIMEOUT = Duration.seconds(5)
const IDLE_SOCKET = Duration.seconds(4) // same as fetch's keep-alive default

export interface Tuple {
  readonly user: string
  readonly relation: string
  readonly object: string
}

type Target = { readonly storeId: string; readonly modelId: string | undefined }

/** The cached store/model is gone: look it up again once. */
class StoreGone {
  readonly _tag = 'StoreGone'
}

const isStoreGone = (err: unknown) =>
  err instanceof FgaApiNotFoundError ||
  (err instanceof FgaApiValidationError &&
    ['latest_authorization_model_not_found', 'store_id_not_found', 'authorization_model_not_found'].includes(String(err.apiErrorCode)))

const toError = (what: string, err: unknown): BadRequest | UpstreamError => {
  if (err instanceof FgaApiValidationError) {
    return new BadRequest({ message: `${what}: ${err.apiErrorMessage ?? err.message}` })
  }
  if (err instanceof FgaApiError) {
    return new UpstreamError({ message: `${what}: HTTP ${err.statusCode ?? '?'} ${err.apiErrorMessage ?? ''}`.trim() })
  }
  return new UpstreamError({ message: `${what}: ${err instanceof Error ? err.message : String(err)}` })
}

export class OpenFga extends Context.Service<OpenFga>()('OpenFga', {
  make: Effect.gen(function* () {
    const config = yield* AppConfig
    const pinnedStoreId = Option.getOrUndefined(config.pinnedStoreId)
    const client = new OpenFgaClient({
      apiUrl: config.fgaApiUrl.origin,
      credentials: { method: CredentialsMethod.ApiToken, config: { token: Redacted.value(config.fgaKey) } },
      retryParams: { maxRetry: 0 },
      // Spread into every request's axios config, replacing the SDK's agents.
      baseOptions: {
        httpAgent: new HttpAgent({ keepAlive: true, timeout: Duration.toMillis(IDLE_SOCKET) }),
        httpsAgent: new HttpsAgent({ keepAlive: true, timeout: Duration.toMillis(IDLE_SOCKET) }),
      },
    })

    // Wrap an SDK call: timeout (cancels the request) + typed errors. The SDK
    // passes per-call options through to axios, so `signal` works, but its
    // option types don't declare it: hence the `as any` on each call below.
    const sdk = <A>(what: string, call: (signal: AbortSignal) => Promise<A>) =>
      Effect.tryPromise({ try: call, catch: (err) => err }).pipe(
        Effect.timeoutOrElse({
          duration: CALL_TIMEOUT,
          orElse: () => Effect.fail(new UpstreamError({ message: `${what}: timed out after 5s` })),
        }),
      )

    let cached: (Target & { readonly at: number }) | undefined

    const lookup = Effect.gen(function* () {
      const storeId =
        pinnedStoreId ??
        (yield* sdk('list stores', (signal) => client.listStores({ name: config.storeName, signal } as any)).pipe(
          Effect.mapError((err) => toError('list stores', err)),
          Effect.flatMap((res) => {
            const match = res.stores.find((s) => s.name === config.storeName)
            return match
              ? Effect.succeed(match.id)
              : Effect.fail(new UpstreamError({ message: `store "${config.storeName}" not found` }))
          }),
        ))
      const models = yield* sdk('read models', (signal) =>
        client.readAuthorizationModels({ storeId, pageSize: 1, signal } as any),
      ).pipe(Effect.mapError((err) => toError('read models', err)))
      const target: Target = { storeId, modelId: models.authorization_models[0]?.id }
      cached = { ...target, at: Date.now() }
      return target
    })

    const target = Effect.suspend(() =>
      cached && Date.now() - cached.at < Duration.toMillis(STORE_TTL) ? Effect.succeed(cached as Target) : lookup,
    )

    // Run a call against the current store/model. If OpenFGA says they're gone,
    // drop the cache and try once more; transient upstream failures get one
    // quick retry.
    const withTarget = <A>(what: string, call: (t: Target, signal: AbortSignal) => Promise<A>) => {
      const attempt = Effect.flatMap(target, (t) =>
        sdk(what, (signal) => call(t, signal)).pipe(
          Effect.catch((err) =>
            Effect.fail(isStoreGone(err) ? new StoreGone() : err instanceof UpstreamError ? err : toError(what, err)),
          ),
        ),
      )
      return attempt.pipe(
        Effect.catchTag('StoreGone', () =>
          Effect.sync(() => {
            cached = undefined
          }).pipe(
            Effect.andThen(attempt),
            Effect.catchTag('StoreGone', () => Effect.fail(new UpstreamError({ message: `${what}: store or model not found` }))),
          ),
        ),
        Effect.retry({
          while: (err) => err._tag === 'UpstreamError' && !err.message.includes('not found'),
          schedule: Schedule.exponential('50 millis'),
          times: 1,
        }),
      )
    }

    const check = (tuple: Tuple, context?: object) =>
      Effect.gen(function* () {
        const started = performance.now()
        const res = yield* withTarget('check', (t, signal) =>
          client.check({ ...tuple, context }, { storeId: t.storeId, authorizationModelId: t.modelId, signal } as any),
        )
        return { allowed: res.allowed === true, ms: performance.now() - started }
      })

    const batchCheck = (checks: ReadonlyArray<Tuple & { readonly correlationId: string }>) =>
      withTarget('batch check', (t, signal) =>
        client.batchCheck(
          { checks: checks.map((c) => ({ ...c })) as ClientBatchCheckItem[] },
          { storeId: t.storeId, authorizationModelId: t.modelId, signal } as any,
        ),
      ).pipe(Effect.map((res) => res.result.map((r) => ({ correlationId: r.correlationId, allowed: r.allowed === true }))))

    const listObjects = (user: string, relation: string, type: string) =>
      withTarget('list objects', (t, signal) =>
        client.listObjects({ user, relation, type }, { storeId: t.storeId, authorizationModelId: t.modelId, signal } as any),
      ).pipe(Effect.map((res) => res.objects))

    /** OpenFGA's own health endpoint; it reports SERVING only when its datastore is ready. */
    const health = Effect.tryPromise({
      try: (signal) => fetch(`${config.fgaApiUrl.origin}/healthz`, { signal }),
      catch: (err) => err,
    }).pipe(
      Effect.timeoutOrElse({ duration: Duration.seconds(2), orElse: () => Effect.fail(new Error('timed out')) }),
      Effect.map((res) => (res.ok ? 'ok' : `HTTP ${res.status}`)),
      Effect.catch((err) => Effect.succeed(`unreachable: ${err instanceof Error ? err.message : String(err)}`)),
    )

    return { check, batchCheck, listObjects, health, host: config.fgaApiUrl.hostname, origin: config.fgaApiUrl.origin }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
