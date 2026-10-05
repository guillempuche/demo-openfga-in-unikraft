import { lookup } from 'node:dns/promises'
import { Effect } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { Api } from './api.ts'
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
        }
      }),
    )
  }),
)

export const AuthzLive = HttpApiBuilder.group(Api, 'authz', (handlers) =>
  Effect.gen(function* () {
    const fga = yield* OpenFga
    return handlers
      .handle('check', ({ query: { consistency, ...tuple } }) =>
        fga.check(tuple, { consistency }).pipe(Effect.map(({ allowed, ms }) => ({ ...tuple, allowed, ms: round(ms) }))),
      )
      .handle('batchCheck', ({ payload }) => fga.batchCheck(payload.checks).pipe(Effect.map((results) => ({ results }))))
      .handle('listObjects', ({ query }) =>
        fga.listObjects(query.user, query.relation, query.type).pipe(Effect.map((objects) => ({ objects }))),
      )
  }),
)

const BENCH_MAX = 100

// /bench is public and unauthenticated, so it bounds the work one request can
// cause: at most BENCH_MAX checks, and one run at a time.
export const BenchLive = HttpApiBuilder.group(Api, 'bench', (handlers) =>
  Effect.gen(function* () {
    const fga = yield* OpenFga
    let running = false
    return handlers.handle('bench', ({ query }) => {
      const n = Math.min(Math.max(Math.trunc(Number(query.n ?? BENCH_MAX)) || BENCH_MAX, 1), BENCH_MAX)
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
      const acquire = Effect.suspend(() =>
        running
          ? Effect.fail(new Busy({ message: 'a bench is already running; try again shortly' }))
          : Effect.sync(() => {
              running = true
            }),
      )
      const release = Effect.sync(() => {
        running = false
      })
      return acquire.pipe(Effect.andThen(run.pipe(Effect.ensuring(release))))
    })
  }),
)
