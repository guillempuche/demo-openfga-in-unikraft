// The public API, declared once with Effect's HttpApi: request validation,
// response shapes, errors and the OpenAPI document (/openapi.json) all come
// from these schemas.

import { Schema } from 'effect'
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from 'effect/http-api'
import { BadRequestError, BusyError, UpstreamErrorError } from './errors.ts'

const TupleFields = {
  user: Schema.NonEmptyString,
  relation: Schema.NonEmptyString,
  object: Schema.NonEmptyString,
}

export const HealthView = Schema.Struct({
  status: Schema.Literal('ok'),
  openfga: Schema.String,
  openfgaHost: Schema.String,
  resolved: Schema.String,
  openfgaMs: Schema.Number,
  memoryMiB: Schema.Struct({ rss: Schema.Number, heapUsed: Schema.Number }),
})

// OpenFGA may answer a Check from its cache (on in the Unikraft deployment),
// so right after a write it can return the old answer for up to the cache TTL.
// HIGHER_CONSISTENCY skips the cache, for reads that must see a recent write.
const Consistency = Schema.Literals(['MINIMIZE_LATENCY', 'HIGHER_CONSISTENCY'])

export const CheckView = Schema.Struct({ ...TupleFields, allowed: Schema.Boolean, ms: Schema.Number })

export const BatchCheckInput = Schema.Struct({
  checks: Schema.Array(Schema.Struct({ ...TupleFields, correlationId: Schema.NonEmptyString })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(50),
  ),
})
export const BatchCheckView = Schema.Struct({
  results: Schema.Array(Schema.Struct({ correlationId: Schema.String, allowed: Schema.Boolean })),
})

export const ListObjectsView = Schema.Struct({ objects: Schema.Array(Schema.String) })

export const BenchView = Schema.Struct({
  ...TupleFields,
  allowed: Schema.Boolean,
  n: Schema.Number,
  p50: Schema.Number,
  p95: Schema.Number,
  max: Schema.Number,
  min: Schema.Number,
  mean: Schema.Number,
  unit: Schema.Literal('ms'),
  target: Schema.String,
})

export const HealthGroup = HttpApiGroup.make('health').add(HttpApiEndpoint.get('health', '/health', { success: HealthView }))

export const AuthzGroup = HttpApiGroup.make('authz')
  .add(
    HttpApiEndpoint.get('check', '/check', {
      query: { ...TupleFields, consistency: Schema.optional(Consistency) },
      success: CheckView,
      error: [BadRequestError, UpstreamErrorError],
    }),
  )
  .add(
    HttpApiEndpoint.post('batchCheck', '/batch-check', {
      payload: BatchCheckInput,
      success: BatchCheckView,
      error: [BadRequestError, UpstreamErrorError],
    }),
  )
  .add(
    HttpApiEndpoint.get('listObjects', '/list-objects', {
      query: { user: Schema.NonEmptyString, relation: Schema.NonEmptyString, type: Schema.NonEmptyString },
      success: ListObjectsView,
      error: [BadRequestError, UpstreamErrorError],
    }),
  )

// Optional query values stay strings and are parsed leniently in the handler
// (`n=abc` means the default, `n=1.5` means 1), as before the rewrite.
export const BenchGroup = HttpApiGroup.make('bench').add(
  HttpApiEndpoint.get('bench', '/bench', {
    query: {
      n: Schema.optional(Schema.String),
      user: Schema.optional(Schema.NonEmptyString),
      relation: Schema.optional(Schema.NonEmptyString),
      object: Schema.optional(Schema.NonEmptyString),
    },
    success: BenchView,
    error: [BadRequestError, UpstreamErrorError, BusyError],
  }),
)

export const Api = HttpApi.make('demo-fga-api')
  .annotateMerge(
    OpenApi.annotations({
      title: 'demo-fga-api',
      version: '1.0.0',
      description: 'Public API in front of a private OpenFGA on Unikraft Cloud: authorization checks and a latency bench.',
    }),
  )
  .add(HealthGroup)
  .add(AuthzGroup)
  .add(BenchGroup)
