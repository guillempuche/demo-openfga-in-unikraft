// OpenFGA as an Effect service, built on the official SDK (@openfga/sdk).
//
// - The store is found by name and its latest model pinned; both are cached
//   for FGA_STORE_CACHE_TTL and dropped as soon as OpenFGA says the store or
//   model is gone (OpenFGA soft-deletes stores: a deleted store still answers
//   checks, so the TTL also catches a store that was recreated under the same
//   name). Concurrent requests on a cold cache share one lookup; a failed
//   lookup isn't cached.
// - One retry policy: the SDK's own retries are off, Effect retries once, and
//   only failures a retry can fix (OpenFGA 5xx, network errors). Timeouts,
//   4xx and invalid requests fail at once. Effect's timeout cancels the HTTP
//   call through an AbortSignal.
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
  FgaError,
  FgaValidationError,
  OpenFgaClient,
  type ClientBatchCheckItem,
} from '@openfga/sdk'
import { Context, Deferred, Duration, Effect, Exit, Layer, Option, Redacted, Schedule } from 'effect'
import { AppConfig } from './config.ts'
import { BadRequest, UpstreamError } from './errors.ts'

const CALL_TIMEOUT = Duration.seconds(5)
const IDLE_SOCKET = Duration.seconds(4) // same as fetch's keep-alive default

export interface Tuple {
  readonly user: string
  readonly relation: string
  readonly object: string
}

/** One /batch-check answer: a decision, or why OpenFGA gave none for that item. */
export type BatchCheckResult =
  | { readonly correlationId: string; readonly allowed: boolean }
  | { readonly correlationId: string; readonly error: string }

type Target = { readonly storeId: string; readonly modelId: string | undefined }

/** A failed OpenFGA call: the error the client sees, and whether one retry may help. */
class Failed {
  readonly _tag = 'Failed'
  readonly error: BadRequest | UpstreamError
  readonly retryable: boolean
  /** The SDK's own error, if any (a timeout has none). */
  readonly cause: unknown
  constructor(error: BadRequest | UpstreamError, retryable = false, cause?: unknown) {
    this.error = error
    this.retryable = retryable
    this.cause = cause
  }
}

/** The cached store/model is gone: look it up again once. */
class StoreGone {
  readonly _tag = 'StoreGone'
}

const isStoreGone = (err: unknown) =>
  err instanceof FgaApiNotFoundError ||
  (err instanceof FgaApiValidationError &&
    ['latest_authorization_model_not_found', 'store_id_not_found', 'authorization_model_not_found'].includes(String(err.apiErrorCode)))

// Decided on the raw SDK error: an FgaApiError carries OpenFGA's HTTP status,
// and a plain FgaError (not client-side validation) wraps a network failure.
const isRetryable = (err: unknown) =>
  err instanceof FgaApiError ? (err.statusCode ?? 0) >= 500 : err instanceof FgaError && !(err instanceof FgaValidationError)

const toError = (what: string, err: unknown): BadRequest | UpstreamError => {
  // FgaValidationError is the SDK rejecting the request before sending it.
  if (err instanceof FgaApiValidationError || err instanceof FgaValidationError) {
    const message = err instanceof FgaApiValidationError ? (err.apiErrorMessage ?? err.message) : err.message
    return new BadRequest({ message: `${what}: ${message}` })
  }
  if (err instanceof FgaApiError) {
    return new UpstreamError({ message: `${what}: HTTP ${err.statusCode ?? '?'} ${err.apiErrorMessage ?? ''}`.trim() })
  }
  return new UpstreamError({ message: `${what}: ${err instanceof Error ? err.message : String(err)}` })
}

const upstream = (message: string) => new Failed(new UpstreamError({ message }))

export class OpenFga extends Context.Service<OpenFga>()('OpenFga', {
  make: Effect.gen(function* () {
    const config = yield* AppConfig
    const pinnedStoreId = Option.getOrUndefined(config.pinnedStoreId)
    const storeTtlMs = Duration.toMillis(config.storeCacheTtl)
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
      Effect.tryPromise({
        try: call,
        catch: (err) => new Failed(toError(what, err), isRetryable(err), err),
      }).pipe(
        Effect.timeoutOrElse({
          duration: CALL_TIMEOUT,
          orElse: () => Effect.fail(upstream(`${what}: timed out after 5s`)),
        }),
      )

    const lookup: Effect.Effect<Target, Failed> = Effect.gen(function* () {
      const storeId =
        pinnedStoreId ??
        (yield* sdk('list stores', (signal) => client.listStores({ name: config.storeName, signal } as any)).pipe(
          Effect.flatMap((res) => {
            // The first store with exactly this name, in OpenFGA's order.
            const match = res.stores.find((s) => s.name === config.storeName)
            return match ? Effect.succeed(match.id) : Effect.fail(upstream(`store "${config.storeName}" not found`))
          }),
        ))
      const models = yield* sdk('read models', (signal) =>
        client.readAuthorizationModels({ storeId, pageSize: 1, signal } as any),
      )
      return { storeId, modelId: models.authorization_models[0]?.id }
    })

    let cached: { readonly target: Target; readonly at: number } | undefined
    let inflight: Deferred.Deferred<Target, Failed> | undefined

    // The cached target, or one shared lookup for every caller that finds the
    // cache cold. The lookup runs detached, so a caller that goes away (client
    // disconnect) doesn't cancel it for the others.
    const target = Effect.suspend((): Effect.Effect<Target, Failed> => {
      if (cached && Date.now() - cached.at < storeTtlMs) return Effect.succeed(cached.target)
      if (inflight) return Deferred.await(inflight)
      const done = Deferred.makeUnsafe<Target, Failed>()
      inflight = done
      const run = Effect.exit(lookup).pipe(
        Effect.flatMap((exit) =>
          Effect.sync(() => {
            inflight = undefined
            if (Exit.isSuccess(exit)) cached = { target: exit.value, at: Date.now() }
          }).pipe(Effect.andThen(Deferred.done(done, exit))),
        ),
      )
      return Effect.forkDetach(run).pipe(Effect.andThen(Deferred.await(done)))
    })

    // Run a call against the current store/model. If OpenFGA says they're gone,
    // drop the cache and try once more; transient upstream failures get one
    // quick retry.
    const withTarget = <A>(what: string, call: (t: Target, signal: AbortSignal) => Promise<A>) => {
      // Only the call itself can report the store gone; a failed lookup is final.
      const attempt = Effect.flatMap(target, (t) =>
        sdk(what, (signal) => call(t, signal)).pipe(
          Effect.catchIf(
            (f) => isStoreGone(f.cause),
            () => Effect.fail(new StoreGone()),
          ),
        ),
      )
      return attempt.pipe(
        Effect.catchTag('StoreGone', () =>
          Effect.sync(() => {
            cached = undefined
          }).pipe(
            Effect.andThen(attempt),
            Effect.catchTag('StoreGone', () => Effect.fail(upstream(`${what}: store or model not found`))),
          ),
        ),
        Effect.retry({ while: (f) => f.retryable, schedule: Schedule.exponential('50 millis'), times: 1 }),
        Effect.mapError((f) => f.error),
      )
    }

    const check = (tuple: Tuple, options: { readonly context?: object; readonly consistency?: string } = {}) =>
      Effect.gen(function* () {
        const started = performance.now()
        const res = yield* withTarget('check', (t, signal) =>
          client.check(
            { ...tuple, context: options.context },
            { storeId: t.storeId, authorizationModelId: t.modelId, consistency: options.consistency, signal } as any,
          ),
        )
        return { allowed: res.allowed === true, ms: performance.now() - started }
      })

    // Answers in request order. An item OpenFGA couldn't evaluate, or left out
    // of its reply, gets an error instead of a decision: reporting it as
    // allowed:false would hide the failure.
    const batchCheck = (checks: ReadonlyArray<Tuple & { readonly correlationId: string }>) =>
      withTarget('batch check', (t, signal) =>
        client.batchCheck(
          { checks: checks.map((c) => ({ ...c })) as ClientBatchCheckItem[] },
          { storeId: t.storeId, authorizationModelId: t.modelId, signal } as any,
        ),
      ).pipe(
        Effect.map((res) => {
          const byId = new Map(res.result.map((r) => [r.correlationId, r]))
          return checks.map(({ correlationId }): BatchCheckResult => {
            const r = byId.get(correlationId)
            if (!r) return { correlationId, error: 'no result from OpenFGA' }
            if (r.error) {
              return { correlationId, error: r.error.message || r.error.input_error || r.error.internal_error || 'check failed' }
            }
            return { correlationId, allowed: r.allowed === true }
          })
        }),
      )

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
