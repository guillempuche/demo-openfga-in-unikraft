// demo-fga-api: a public API in front of a private OpenFGA instance.
//
//   GET  /health        API status, OpenFGA reachability, what the private FQDN resolves to, memory, model
//   GET  /check         ?user=&relation=&object=           one OpenFGA Check
//   POST /batch-check   {"checks":[{correlationId,user,relation,object}]}  up to 50 checks
//   GET  /list-objects  ?user=&relation=&type=              objects the user can reach
//   GET  /bench         [?n=100&user=&relation=&object=]    n (<= 100) sequential checks, latency stats
//   GET  /openapi.json  the OpenAPI document
//   GET  /docs          the same, rendered (Scalar, loaded by the browser from a CDN)
//
// Built with Effect 4 (HttpApi, typed config and errors) and the official
// OpenFGA SDK. Bundled into one file for the unikernel image (npm run build).

import { createServer } from 'node:http'
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import { Cause, Context, Effect, ErrorReporter, Layer, Logger, Option } from 'effect'
import { HttpRouter, HttpServerRequest } from 'effect/http'
import { HttpApiBuilder, HttpApiMiddleware } from 'effect/http-api'
// A deep import: through the effect/http-api barrel, the bundle also keeps the
// inlined Scalar build (~3 MB) that only HttpApiScalar.layer uses.
import { layerCdn as scalarDocs } from 'effect/http-api/HttpApiScalar'
import { Api, JsonBodyOnly, RequestErrors } from './api.ts'
import { AppConfig } from './config.ts'
import { BadRequest, UnsupportedMediaType } from './errors.ts'
import { AuthzLive, BenchLive, HealthLive } from './handlers.ts'
import { OpenFga } from './openfga.ts'

// A request that fails decoding is the client's mistake: a JSON 400 saying what
// was wrong, instead of Effect's empty one. A response that doesn't match its
// own schema is ours: it dies with the schema error, which answers 500 and is
// logged as a defect.
const RequestErrorsLive = HttpApiMiddleware.layerSchemaErrorTransform(RequestErrors, (error) =>
  error.kind === 'Body' || error.kind === 'ResponseHeaders'
    ? Effect.die(error.cause)
    : Effect.fail(new BadRequest({ message: `invalid ${error.kind.toLowerCase()}: ${error.cause.message}` })),
)

// HttpApiBuilder answers a body that isn't JSON with a plain-text 415 before
// the handler runs; the middleware sees it as a successful response.
const JsonBodyOnlyLive = Layer.succeed(JsonBodyOnly, (httpEffect) =>
  Effect.flatMap(httpEffect, (res) =>
    res.status === 415
      ? Effect.fail(new UnsupportedMediaType({ message: 'unsupported content-type: send application/json' }))
      : Effect.succeed(res),
  ),
)

// The groups need the middleware layers when they're built (provideMerge also
// hands them to HttpApiBuilder.layer); providing them to that layer alone
// isn't enough.
const ApiLive = HttpApiBuilder.layer(Api, { openapiPath: '/openapi.json' }).pipe(
  Layer.provide(
    Layer.mergeAll(HealthLive, AuthzLive, BenchLive).pipe(Layer.provideMerge(Layer.mergeAll(RequestErrorsLive, JsonBodyOnlyLive))),
  ),
)

// Each defect (a 500: a bug, such as a response that doesn't match its schema)
// becomes one JSON log line with its stack and the request's method and path.
// The typed errors opt out (errors.ts): they are answers, not faults. Logging
// every request instead (HttpRouter.serve without disableLogger) would add a
// line per check and bury these in the instance console.
const DefectLogLive = ErrorReporter.layer([
  ErrorReporter.make(({ cause, fiber }) => {
    const request = Context.getOption(fiber.context, HttpServerRequest.HttpServerRequest)
    const annotations = Option.match(request, {
      onNone: () => ({}),
      onSome: (r) => ({ 'http.method': r.method, 'http.url': r.url.split('?')[0] }),
    })
    // Runs with the failed request's services, so it goes through the same JSON logger.
    Effect.runSyncWith(fiber.context)(Effect.logError('request failed', cause).pipe(Effect.annotateLogs(annotations)))
  }),
])

const ServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const { port, fgaApiUrl } = yield* AppConfig
    yield* Effect.logInfo(`demo-fga-api listening on :${port}, OpenFGA at ${fgaApiUrl.origin}`)
    return NodeHttpServer.layer(createServer, { port, host: '0.0.0.0' })
  }),
)

// An exception that escapes Effect (thrown in a callback, an unhandled
// rejection) still crashes the process: Node prints the stack and exits 1, and
// the platform restarts the instance. This logs it first as one JSON line, like
// every other log line.
process.on('uncaughtExceptionMonitor', (err, origin) => {
  const cause = err instanceof Error ? err.stack : String(err)
  console.error(JSON.stringify({ message: `${origin}, exiting`, level: 'FATAL', timestamp: new Date().toISOString(), cause }))
})

const program = HttpRouter.serve(Layer.mergeAll(ApiLive, scalarDocs(Api, { path: '/docs' })), { disableLogger: true }).pipe(
  Layer.provide(OpenFga.layer),
  Layer.provideMerge(ServerLive),
  Layer.provide(DefectLogLive),
  Layer.launch,
  // A failure that stops the API (invalid config, port in use) is logged as one
  // JSON line, and runMain exits 1. Its own report is off: it would print the
  // same failure again, unformatted.
  Effect.tapCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logFatal('demo-fga-api stopped', cause))),
  Effect.provide(Logger.layer([Logger.consoleJson])),
)

NodeRuntime.runMain(program, { disableErrorReporting: true })
