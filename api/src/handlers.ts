import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Clock, Duration, Effect, Option, Semaphore } from 'effect'
import type { HttpServerRequest } from 'effect/http'
import { HttpApiBuilder } from 'effect/http-api'
import { Api } from './api.ts'
import { AppConfig } from './config.ts'
import { Busy } from './errors.ts'
import { OpenFga } from './openfga.ts'

const round = (n: number) => Math.round(n * 1000) / 1000
const percentile = (sorted: number[], p: number) =>
  sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))]

export const HealthLive = HttpApiBuilder.group(Api, 'health', (handlers) =>
  Effect.gen(function* () {
    const fga = yield* OpenFga
    return handlers.handle('health', () =>
      Effect.gen(function* () {
        // What the private FQDN points at right now: compare it with the
        // instance's private IP (`unikraft instances get ... -f networks`).
        const resolved = yield* Effect.promise(() =>
          lookup(fga.host).then(
            (a) => a.address,
            (err: Error) => `error: ${err.message}`,
          ),
        ).pipe(Effect.timeoutOrElse({ duration: '2 seconds', orElse: () => Effect.succeed('error: timed out') }))
        const started = performance.now()
        const openfga = yield* fga.health
        const memory = process.memoryUsage()
        return {
          status: 'ok' as const,
          openfga,
          openfgaHost: fga.host,
          resolved,
          openfgaMs: round(performance.now() - started),
          memoryMiB: { rss: round(memory.rss / 1048576), heapUsed: round(memory.heapUsed / 1048576) },
          model: yield* fga.model,
        }
      }),
    )
  }),
)

// The client's address, or undefined when it can't be known. In
// x-forwarded-for mode only the last entry counts (the one the nearest proxy
// added; earlier ones come from the client), and a missing header never falls
// back to the TCP peer, which is then the proxy. An address that isn't
// well-formed is dropped too. An IPv4-mapped one (::ffff:10.0.0.1) is kept:
// OpenFGA unmaps it.
const clientIp = (request: HttpServerRequest.HttpServerRequest, from: 'socket' | 'x-forwarded-for') => {
  const ip =
    from === 'x-forwarded-for'
      ? request.headers['x-forwarded-for']?.split(',').at(-1)?.trim()
      : Option.getOrUndefined(request.remoteAddress)
  return ip && isIP(ip) ? ip : undefined
}

export const AuthzLive = HttpApiBuilder.group(Api, 'authz', (handlers) =>
  Effect.gen(function* () {
    const fga = yield* OpenFga
    const { clientIpFrom, currentTimeStep } = yield* AppConfig
    const stepMs = Duration.toMillis(currentTimeStep)

    // The condition parameters the API vouches for, sent with every check.
    // Callers can't add any: a parameter a condition needs that isn't here
    // (region, plan) stays missing, and OpenFGA refuses to decide that check.
    const conditionContext = (request: HttpServerRequest.HttpServerRequest) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        const userIp = clientIp(request, clientIpFrom)
        return {
          current_time: new Date(Math.floor(now / stepMs) * stepMs).toISOString(),
          ...(userIp ? { user_ip: userIp } : {}),
        }
      })

    return handlers
      .handle('check', ({ request, query: { consistency, ...tuple } }) =>
        conditionContext(request).pipe(
          Effect.flatMap((context) => fga.check(tuple, { consistency, context })),
          Effect.map(({ allowed, ms }) => ({ ...tuple, allowed, ms: round(ms) })),
        ),
      )
      .handle('batchCheck', ({ request, payload }) =>
        conditionContext(request).pipe(
          Effect.flatMap((context) => fga.batchCheck(payload.checks, context)),
          Effect.map((results) => ({ results })),
        ),
      )
      .handle('listObjects', ({ request, query }) =>
        conditionContext(request).pipe(
          Effect.flatMap((context) => fga.listObjects(query.user, query.relation, query.type, context)),
          Effect.map((objects) => ({ objects })),
        ),
      )
  }),
)

const BENCH_MAX = 100

// `n` without a number (missing, empty, `abc`) means BENCH_MAX; a number is
// truncated and clamped to 1..BENCH_MAX, so `n=0` or `n=0.5` runs one check.
const benchSize = (raw: string | undefined) => {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw)
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), BENCH_MAX) : BENCH_MAX
}

// /bench is public and unauthenticated, so it bounds the work one request can
// cause: at most BENCH_MAX checks, and one run at a time. Its checks carry no
// condition context: they measure plain checks.
export const BenchLive = HttpApiBuilder.group(Api, 'bench', (handlers) =>
  Effect.gen(function* () {
    const fga = yield* OpenFga
    const oneAtATime = yield* Semaphore.make(1)
    return handlers.handle('bench', ({ query }) => {
      const n = benchSize(query.n)
      const tuple = {
        user: query.user ?? 'user:alice',
        relation: query.relation ?? 'can_edit',
        object: query.object ?? 'project:roadmap',
      }
      const run = Effect.gen(function* () {
        // A few unmeasured calls so connection setup and store lookup don't
        // skew the numbers; the bench shows warm latency.
        for (let i = 0; i < 3; i++) yield* fga.check(tuple)
        const samples: number[] = []
        let allowed = false
        for (let i = 0; i < n; i++) {
          const r = yield* fga.check(tuple)
          samples.push(r.ms)
          allowed = r.allowed
        }
        const sorted = [...samples].sort((a, b) => a - b)
        return {
          ...tuple,
          allowed,
          n,
          p50: round(percentile(sorted, 50)),
          p95: round(percentile(sorted, 95)),
          max: round(sorted[sorted.length - 1]),
          min: round(sorted[0]),
          mean: round(samples.reduce((a, b) => a + b, 0) / n),
          unit: 'ms' as const,
          target: fga.origin,
        }
      })
      // None when another run holds the permit. The permit is released however
      // the run ends: success, failure, or interruption (client disconnect).
      return Semaphore.withPermitsIfAvailable(oneAtATime, 1)(run).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new Busy({ message: 'a bench is already running; try again shortly' })),
            onSome: Effect.succeed,
          }),
        ),
      )
    })
  }),
)
