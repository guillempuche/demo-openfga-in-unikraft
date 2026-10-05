// Black-box tests for the demo API: they start the bundled server
// (dist/server.mjs, the file that ships in the unikernel) against a stub
// OpenFGA and talk HTTP to it. Run with: npm test (builds first).

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const BUNDLE = fileURLToPath(new URL('./dist/server.mjs', import.meta.url))
const KEY = 'test-key-that-must-not-be-logged'

// The SDK only accepts ULIDs as store and model ids.
const STORE_1 = '01HX0000000000000000000001'
const STORE_2 = '01HX0000000000000000000002'
const OTHER = '01HX0000000000000000000009'
const MODEL = '01HX00000000000000000000M1'

// --- stub OpenFGA ----------------------------------------------------------

type Reply = { status: number; body: string }
const json = (status: number, body: unknown): Reply => ({ status, body: JSON.stringify(body) })

const stub = {
  stores: [] as { id: string; name: string }[],
  // Answers for POST /stores/:id/check; unknown stores get OpenFGA's "no model" error.
  checks: new Map<string, () => Reply>(),
  checkDelayMs: 0,
  lastAuthorization: '',
  lastCheckBody: undefined as any,
}

async function readJson(req: IncomingMessage): Promise<any> {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw ? JSON.parse(raw) : undefined
}

const openfga: Server = createServer(async (req, res) => {
  stub.lastAuthorization = req.headers.authorization ?? ''
  const url = new URL(req.url ?? '/', 'http://stub')
  let reply = json(404, { code: 'not_found' })
  const store = url.pathname.match(/^\/stores\/([^/]+)\/(.+)$/)

  if (req.method === 'GET' && url.pathname === '/healthz') {
    reply = json(200, { status: 'SERVING' })
  } else if (req.method === 'GET' && url.pathname === '/stores') {
    const name = url.searchParams.get('name')
    reply = json(200, { stores: stub.stores.filter((s) => !name || s.name === name), continuation_token: '' })
  } else if (store && req.method === 'GET' && store[2] === 'authorization-models') {
    reply = json(200, { authorization_models: [{ id: MODEL, schema_version: '1.2', type_definitions: [] }], continuation_token: '' })
  } else if (store && req.method === 'POST' && store[2] === 'check') {
    stub.lastCheckBody = await readJson(req)
    if (stub.checkDelayMs) await new Promise((r) => setTimeout(r, stub.checkDelayMs))
    const handler = stub.checks.get(store[1])
    reply = handler
      ? handler()
      : json(400, { code: 'latest_authorization_model_not_found', message: `No authorization models found for store '${store[1]}'` })
  } else if (store && req.method === 'POST' && store[2] === 'batch-check') {
    const body = await readJson(req)
    const result = Object.fromEntries(body.checks.map((c: any) => [c.correlation_id, { allowed: c.tuple_key.user === 'user:alice' }]))
    reply = json(200, { result })
  } else if (store && req.method === 'POST' && store[2] === 'list-objects') {
    const body = await readJson(req)
    reply = json(200, { objects: body.user === 'user:alice' ? ['project:roadmap', 'project:wiki'] : [] })
  }
  res.writeHead(reply.status, { 'content-type': 'application/json' })
  res.end(reply.body)
})

// --- the API under test ----------------------------------------------------

async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const { port } = s.address() as AddressInfo
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

type Api = { base: string; proc: ChildProcess; output: () => string }

async function startApi(env: Record<string, string | undefined>): Promise<Api> {
  const port = await freePort()
  let output = ''
  const proc = spawn(process.execPath, [BUNDLE], {
    env: { PATH: process.env.PATH, PORT: String(port), ...env } as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout!.on('data', (d) => (output += d))
  proc.stderr!.on('data', (d) => (output += d))
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) break
    try {
      if ((await fetch(`${base}/openapi.json`)).ok) return { base, proc, output: () => output }
    } catch {}
    await new Promise((r) => setTimeout(r, 50))
  }
  proc.kill()
  throw new Error(`API didn't start:\n${output}`)
}

let api: Api
let openfgaUrl = ''

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(api.base + path)
  return { status: res.status, body: await res.json() }
}

before(async () => {
  await new Promise<void>((r) => openfga.listen(0, '127.0.0.1', r))
  openfgaUrl = `http://127.0.0.1:${(openfga.address() as AddressInfo).port}`
  api = await startApi({ FGA_API_URL: openfgaUrl, FGA_KEY: KEY, FGA_STORE_NAME: 'demo-fga' })
})

after(() => {
  api?.proc.kill()
  openfga.close()
})

beforeEach(() => {
  stub.stores = [
    { id: OTHER, name: 'unrelated' },
    { id: STORE_1, name: 'demo-fga' },
  ]
  stub.checks = new Map([[STORE_1, () => json(200, { allowed: true })]])
  stub.checkDelayMs = 0
})

describe('GET /check', () => {
  test('finds the store by name, pins its latest model and forwards the key', async () => {
    const { status, body } = await get('/check?user=user:alice&relation=can_edit&object=project:roadmap')
    assert.equal(status, 200)
    assert.deepEqual({ ...body, ms: 0 }, { user: 'user:alice', relation: 'can_edit', object: 'project:roadmap', allowed: true, ms: 0 })
    assert.equal(stub.lastAuthorization, `Bearer ${KEY}`)
    assert.equal(stub.lastCheckBody.authorization_model_id, MODEL)
  })

  test('requires user, relation and object (400 with a JSON reason)', async () => {
    for (const path of ['/check?user=user:alice', '/check?user=&relation=r&object=o']) {
      const { status, body } = await get(path)
      assert.equal(status, 400, path)
      assert.equal(body._tag, 'BadRequest')
      assert.match(body.message, /^invalid query/)
    }
  })

  test('looks the store up again when the cached one is gone', async () => {
    await get('/check?user=user:a&relation=owner&object=project:x') // caches STORE_1
    // The database was recreated: STORE_1 no longer exists, the store has a new id.
    stub.stores = [{ id: STORE_2, name: 'demo-fga' }]
    stub.checks = new Map([[STORE_2, () => json(200, { allowed: false })]])
    const { status, body } = await get('/check?user=user:a&relation=owner&object=project:x')
    assert.equal(status, 200)
    assert.equal(body.allowed, false)
  })

  test('reports an OpenFGA failure as 502 and keeps its HTTP status, even with a non-JSON body', async () => {
    stub.checks.set(STORE_1, () => ({ status: 503, body: '' }))
    const { status, body } = await get('/check?user=user:a&relation=owner&object=project:x')
    assert.equal(status, 502)
    assert.equal(body._tag, 'UpstreamError')
    assert.match(body.message, /HTTP 503/)
  })
})

describe('POST /batch-check and GET /list-objects', () => {
  test('batch check answers per correlation id', async () => {
    const res = await fetch(api.base + '/batch-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        checks: [
          { correlationId: 'a', user: 'user:alice', relation: 'can_edit', object: 'project:roadmap' },
          { correlationId: 'b', user: 'user:carol', relation: 'can_edit', object: 'project:roadmap' },
        ],
      }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(Object.fromEntries(body.results.map((r: any) => [r.correlationId, r.allowed])), { a: true, b: false })
  })

  test('batch check accepts at most 50 checks (400)', async () => {
    const checks = Array.from({ length: 51 }, (_, i) => ({ correlationId: `c${i}`, user: 'user:a', relation: 'r', object: 'o:1' }))
    const res = await fetch(api.base + '/batch-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ checks }),
    })
    assert.equal(res.status, 400)
    assert.match((await res.json()).message, /^invalid payload/)
  })

  test('list objects returns what the user can reach', async () => {
    const { status, body } = await get('/list-objects?user=user:alice&relation=can_view&type=project')
    assert.equal(status, 200)
    assert.deepEqual(body, { objects: ['project:roadmap', 'project:wiki'] })
  })
})

describe('GET /bench', () => {
  test('defaults to 100 checks and reports latency stats', async () => {
    const { status, body } = await get('/bench')
    assert.equal(status, 200)
    assert.equal(body.n, 100)
    assert.equal(body.allowed, true)
    assert.ok(body.min <= body.p50 && body.p50 <= body.p95 && body.p95 <= body.max)
  })

  test('caps n at 100 and truncates it to an integer', async () => {
    assert.equal((await get('/bench?n=5000')).body.n, 100)
    assert.equal((await get('/bench?n=1.5')).body.n, 1)
    assert.equal((await get('/bench?n=abc')).body.n, 100)
  })

  test('rejects empty parameters (400)', async () => {
    assert.equal((await get('/bench?user=')).status, 400)
  })

  test('runs one bench at a time (429)', async () => {
    stub.checkDelayMs = 5
    const first = get('/bench?n=20')
    await new Promise((r) => setTimeout(r, 40))
    const second = await get('/bench?n=1')
    assert.equal(second.status, 429)
    assert.equal(second.body._tag, 'Busy')
    assert.equal((await first).status, 200)
  })
})

describe('health, OpenAPI and startup', () => {
  test('GET /health reports OpenFGA reachability, resolution and memory', async () => {
    const { status, body } = await get('/health')
    assert.equal(status, 200)
    assert.equal(body.openfga, 'ok')
    assert.equal(body.resolved, '127.0.0.1')
    assert.ok(body.memoryMiB.rss > 0)
  })

  test('GET /openapi.json describes every endpoint', async () => {
    const { status, body } = await get('/openapi.json')
    assert.equal(status, 200)
    assert.deepEqual(Object.keys(body.paths).sort(), ['/batch-check', '/bench', '/check', '/health', '/list-objects'])
  })

  test('unknown routes are 404', async () => {
    assert.equal((await fetch(api.base + '/nope')).status, 404)
  })

  test('logs are JSON and never contain the OpenFGA key', async () => {
    const lines = api.output().trim().split('\n').filter(Boolean)
    assert.ok(lines.length > 0)
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), line)
    assert.ok(!api.output().includes(KEY))
  })

  test('refuses to start without FGA_KEY', async () => {
    await assert.rejects(startApi({ FGA_API_URL: openfgaUrl }), /didn't start/)
  })
})
