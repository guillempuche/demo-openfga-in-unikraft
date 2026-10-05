// demo-fga-api: a public API in front of a private OpenFGA instance.
//
//   GET  /health        API status, OpenFGA reachability, what the private FQDN resolves to, memory
//   GET  /check         ?user=&relation=&object=           one OpenFGA Check
//   POST /batch-check   {"checks":[{correlationId,user,relation,object}]}  up to 50 checks
//   GET  /list-objects  ?user=&relation=&type=              objects the user can reach
//   GET  /bench         [?n=100&user=&relation=&object=]    n (<= 100) sequential checks, latency stats
//   GET  /openapi.json  the OpenAPI document
//
// Built with Effect 4 (HttpApi, typed config and errors) and the official
// OpenFGA SDK. Bundled into one file for the unikernel image (npm run build).

import { createServer } from 'node:http'
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import { Cause, Effect, Layer, Logger } from 'effect'
import { HttpMiddleware, HttpRouter, HttpServerResponse } from 'effect/http'
import { HttpApiBuilder, HttpApiError, OpenApi } from 'effect/http-api'
import { Api } from './api.ts'
import { AppConfig } from './config.ts'
import { AuthzLive, BenchLive, HealthLive } from './handlers.ts'
import { OpenFga } from './openfga.ts'

const ApiLive = HttpApiBuilder.layer(Api).pipe(Layer.provide([HealthLive, AuthzLive, BenchLive]))

const OpenApiJsonLive = HttpRouter.add('GET', '/openapi.json', HttpServerResponse.json(OpenApi.fromApi(Api)))

// Effect answers a request that fails schema validation with an empty 400,
// and a body that isn't JSON with a plain-text 415. Give clients a JSON body in
// the same shape as the API's own errors, saying what was wrong.
const InvalidRequestsAsJson = HttpRouter.middleware(
  HttpMiddleware.make((app) =>
    app.pipe(
      Effect.map((res) =>
        res.status === 415
          ? HttpServerResponse.jsonUnsafe(
              { _tag: 'BadRequest', message: 'unsupported content-type: send application/json' },
              { status: 415 },
            )
          : res,
      ),
      Effect.catchCause((cause): Effect.Effect<HttpServerResponse.HttpServerResponse, unknown> => {
        // The builder reports a schema failure as a defect; squash finds it either way.
        const err = Cause.squash(cause)
        return HttpApiError.HttpApiSchemaError.is(err)
          ? HttpServerResponse.json(
              { _tag: 'BadRequest', message: `invalid ${err.kind.toLowerCase()}: ${err.cause.message}` },
              { status: 400 },
            )
          : Effect.failCause(cause)
      }),
    ),
  ),
  { global: true },
)

const ServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const { port, fgaApiUrl } = yield* AppConfig
    yield* Effect.logInfo(`demo-fga-api listening on :${port}, OpenFGA at ${fgaApiUrl.origin}`)
    return NodeHttpServer.layer(createServer, { port, host: '0.0.0.0' })
  }),
)

// A low-level error that escapes Effect would otherwise leave the process
// running but unresponsive; log it and exit so the platform restarts it.
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (err) => {
    console.error(JSON.stringify({ level: 'FATAL', message: `${event}, exiting for restart`, error: String(err) }))
    process.exit(1)
  })
}

const program = HttpRouter.serve(Layer.mergeAll(ApiLive, OpenApiJsonLive).pipe(Layer.provide(InvalidRequestsAsJson)), {
  disableLogger: true,
}).pipe(
  Layer.provide(OpenFga.layer),
  Layer.provideMerge(ServerLive),
  Layer.provide(Logger.layer([Logger.consoleJson])),
  Layer.launch,
)

NodeRuntime.runMain(program)
