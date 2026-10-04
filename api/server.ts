// Tiny public API in front of a private OpenFGA instance.
//
// Runs with plain Node (>= 22.18) using native TypeScript type stripping, so
// there is no build step and no runtime dependency: only node:http and fetch.
//
//   GET /health                                 liveness + OpenFGA reachability
//   GET /check?user=&relation=&object=          one OpenFGA Check
//   GET /bench[?n=100&user=&relation=&object=]  n sequential checks, latency stats

import { lookup } from 'node:dns/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

const PORT = Number(process.env.PORT ?? 8080)
// Private FQDN of the OpenFGA instance on the Unikraft internal network.
const FGA_API_URL = (process.env.FGA_API_URL ?? 'http://demo-fga-openfga.internal:8080').replace(/\/$/, '')
const FGA_KEY = process.env.FGA_KEY ?? ''
const FGA_STORE_NAME = process.env.FGA_STORE_NAME ?? 'demo-fga'

if (!FGA_KEY) {
  console.error('FGA_KEY is required')
  process.exit(1)
}

const authHeaders = {
  authorization: `Bearer ${FGA_KEY}`,
  'content-type': 'application/json',
}

type TupleKey = { user: string; relation: string; object: string }

// The store is looked up by name on first use, so redeploying OpenFGA (or
// recreating the store) needs no config change here. FGA_STORE_ID overrides.
let storeId: string | undefined = process.env.FGA_STORE_ID || undefined

async function resolveStoreId(): Promise<string> {
  if (storeId) return storeId
  let token = ''
  do {
    const url = `${FGA_API_URL}/stores?page_size=100${token ? `&continuation_token=${encodeURIComponent(token)}` : ''}`
    const res = await fetch(url, { headers: authHeaders, signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`list stores: HTTP ${res.status}`)
    const body = (await res.json()) as { stores: { id: string; name: string }[]; continuation_token?: string }
    const match = body.stores.find((s) => s.name === FGA_STORE_NAME)
    if (match) {
      storeId = match.id
      return storeId
    }
    token = body.continuation_token ?? ''
  } while (token)
  throw new Error(`store "${FGA_STORE_NAME}" not found`)
}

async function check(tuple: TupleKey): Promise<{ allowed: boolean; ms: number }> {
  const id = await resolveStoreId()
  const started = performance.now()
  const res = await fetch(`${FGA_API_URL}/stores/${id}/check`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ tuple_key: tuple }),
    signal: AbortSignal.timeout(5000),
  })
  const body = (await res.json()) as { allowed?: boolean; message?: string }
  const ms = performance.now() - started
  if (!res.ok) throw new Error(`check: HTTP ${res.status} ${body.message ?? ''}`.trim())
  return { allowed: body.allowed === true, ms }
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

const round = (n: number) => Math.round(n * 1000) / 1000

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) })
  res.end(json)
}

function tupleFrom(params: URLSearchParams, fallback?: TupleKey): TupleKey | undefined {
  const user = params.get('user') ?? fallback?.user
  const relation = params.get('relation') ?? fallback?.relation
  const object = params.get('object') ?? fallback?.object
  if (!user || !relation || !object) return undefined
  return { user, relation, object }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })

  switch (url.pathname) {
    case '/health': {
      // Also probe OpenFGA over the internal network; the API itself is up
      // either way, so this always answers 200 and reports the upstream state.
      // `resolved` shows what the private FQDN points at right now, which is
      // how we compare it with the private IP across redeploys.
      const host = new URL(FGA_API_URL).hostname
      const resolved = await lookup(host).then((a) => a.address, (err: Error) => `error: ${err.message}`)
      const started = performance.now()
      let upstream: string
      try {
        const r = await fetch(`${FGA_API_URL}/healthz`, { signal: AbortSignal.timeout(2000) })
        upstream = r.ok ? 'ok' : `HTTP ${r.status}`
      } catch (err) {
        upstream = `unreachable: ${(err as Error).message}`
      }
      return send(res, 200, {
        status: 'ok',
        openfga: upstream,
        openfgaHost: host,
        resolved,
        openfgaMs: round(performance.now() - started),
        memoryMiB: {
          rss: round(process.memoryUsage.rss() / 1048576),
          heapUsed: round(process.memoryUsage().heapUsed / 1048576),
        },
      })
    }

    case '/check': {
      const tuple = tupleFrom(url.searchParams)
      if (!tuple) return send(res, 400, { error: 'user, relation and object are required' })
      const { allowed, ms } = await check(tuple)
      return send(res, 200, { ...tuple, allowed, ms: round(ms) })
    }

    case '/bench': {
      const n = Math.min(Math.max(Number(url.searchParams.get('n') ?? 100) || 100, 1), 1000)
      const tuple = tupleFrom(url.searchParams, { user: 'user:alice', relation: 'can_edit', object: 'project:roadmap' })!
      // A few unmeasured calls so connection setup and store lookup don't
      // skew the numbers; the bench is meant to show warm latency.
      for (let i = 0; i < 3; i++) await check(tuple)
      const samples: number[] = []
      let allowed = false
      for (let i = 0; i < n; i++) {
        const r = await check(tuple)
        samples.push(r.ms)
        allowed = r.allowed
      }
      const sorted = [...samples].sort((a, b) => a - b)
      return send(res, 200, {
        ...tuple,
        allowed,
        n,
        p50: round(percentile(sorted, 50)),
        p95: round(percentile(sorted, 95)),
        max: round(sorted[sorted.length - 1]),
        min: round(sorted[0]),
        mean: round(samples.reduce((a, b) => a + b, 0) / n),
        unit: 'ms',
        target: FGA_API_URL,
      })
    }

    default:
      return send(res, 404, { error: 'not found' })
  }
}

createServer((req, res) => {
  handle(req, res).catch((err: Error) => send(res, 502, { error: err.message }))
}).listen(PORT, '0.0.0.0', () => {
  console.log(`demo-fga-api listening on :${PORT}, OpenFGA at ${FGA_API_URL}`)
})
