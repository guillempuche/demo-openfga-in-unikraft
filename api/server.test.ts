// Tests for the demo API against a stub OpenFGA (no network, no Docker).
// Run with: npm test   (node --test, Node >= 22.18 for TypeScript stripping)

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, test } from 'node:test'

// --- stub OpenFGA ----------------------------------------------------------

type CheckReply = { status: number; body: string }

const stub = {
  // Stores returned by GET /stores, split into pages of one store each so the
  // API has to follow continuation tokens.
  stores: [] as { id: string; name: string }[],
  // How POST /stores/:id/check answers, per store id; unknown ids get the
  // "no model" error OpenFGA returns for a store that no longer exists.
  checks: new Map<string, () => CheckReply>(),
  checkDelayMs: 0,
  listCalls: 0,
  lastAuthorization: '',
}

function json(status: number, body: unknown): CheckReply {
  return { status, body: JSON.stringify(body) }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw ? JSON.parse(raw) : undefined
}

const openfga: Server = createServer(async (req, res) => {
  stub.lastAuthorization = req.headers.authorization ?? ''
  const url = new URL(req.url ?? '/', 'http://stub')
  let reply: CheckReply = json(404, { code: 'not_found' })

  if (req.method === 'GET' && url.pathname === '/healthz') {
    reply = json(200, { status: 'SERVING' })
  } else if (req.method === 'GET' && url.pathname === '/stores') {
    stub.listCalls++
    const page = Number(url.searchParams.get('continuation_token') ?? 0)
    const next = page + 1 < stub.stores.length ? String(page + 1) : ''
    reply = json(200, { stores: stub.stores.slice(page, page + 1), continuation_token: next })
  } else {
    const m = url.pathname.match(/^\/stores\/([^/]+)\/check$/)
    if (req.method === 'POST' && m) {
      await readJson(req)
      if (stub.checkDelayMs) await new Promise((r) => setTimeout(r, stub.checkDelayMs))
      const handler = stub.checks.get(m[1])
      reply = handler
        ? handler()
        : json(400, { code: 'latest_authorization_model_not_found', message: `No authorization models found for store '${m[1]}'` })
    }
  }
  res.writeHead(reply.status, { 'content-type': 'application/json' })
  res.end(reply.body)
})

// --- API under test ----------------------------------------------------------

let api: Server
let base = ''

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path)
  return { status: res.status, body: await res.json() }
}

before(async () => {
  await new Promise<void>((r) => openfga.listen(0, '127.0.0.1', r))
  process.env.FGA_API_URL = `http://127.0.0.1:${(openfga.address() as AddressInfo).port}`
  process.env.FGA_KEY = 'test-key'
  process.env.FGA_STORE_NAME = 'demo-fga'
  // Import after the env is set: the module reads its config at load time.
  const { createApp } = await import('./server.ts')
  api = createApp()
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
})

after(() => {
  api.close()
  openfga.close()
})

beforeEach(() => {
  stub.stores = [
    { id: 'other', name: 'unrelated' },
    { id: 'store-1', name: 'demo-fga' },
  ]
  stub.checks = new Map([['store-1', () => json(200, { allowed: true })]])
  stub.checkDelayMs = 0
})

describe('GET /check', () => {
  test('finds the store by name across pages and forwards the key', async () => {
    const { status, body } = await get('/check?user=user:alice&relation=can_edit&object=project:roadmap')
    assert.equal(status, 200)
    assert.equal(body.allowed, true)
    assert.equal(stub.lastAuthorization, 'Bearer test-key')
  })

  test('requires user, relation and object', async () => {
    const { status } = await get('/check?user=user:alice')
    assert.equal(status, 400)
  })

  test('looks the store up again when the cached one is gone', async () => {
    await get('/check?user=user:a&relation=owner&object=project:x') // caches store-1
    // The database was recreated: store-1 no longer exists, the store has a new id.
    stub.stores = [{ id: 'store-2', name: 'demo-fga' }]
    stub.checks = new Map([['store-2', () => json(200, { allowed: false })]])
    const { status, body } = await get('/check?user=user:a&relation=owner&object=project:x')
    assert.equal(status, 200)
    assert.equal(body.allowed, false)
  })

  test('keeps the HTTP status when OpenFGA answers with a non-JSON body', async () => {
    stub.checks.set('store-1', () => ({ status: 503, body: '' }))
    const { status, body } = await get('/check?user=user:a&relation=owner&object=project:x')
    assert.equal(status, 502)
    assert.match(body.error, /HTTP 503/)
  })
})

describe('GET /bench', () => {
  test('defaults to 100 checks and reports latency stats', async () => {
    const { status, body } = await get('/bench')
    assert.equal(status, 200)
    assert.equal(body.n, 100)
    assert.equal(body.allowed, true)
    for (const k of ['p50', 'p95', 'max', 'min', 'mean']) assert.equal(typeof body[k], 'number', k)
    assert.ok(body.min <= body.p50 && body.p50 <= body.p95 && body.p95 <= body.max)
  })

  test('caps n at 100 and truncates it to an integer', async () => {
    assert.equal((await get('/bench?n=5000')).body.n, 100)
    assert.equal((await get('/bench?n=1.5')).body.n, 1)
    assert.equal((await get('/bench?n=abc')).body.n, 100)
  })

  test('rejects empty parameters', async () => {
    const { status } = await get('/bench?user=')
    assert.equal(status, 400)
  })

  test('runs one bench at a time', async () => {
    stub.checkDelayMs = 5
    const first = get('/bench?n=20')
    await new Promise((r) => setTimeout(r, 30))
    const second = await get('/bench?n=1')
    assert.equal(second.status, 429)
    assert.equal((await first).status, 200)
  })
})

describe('other routes', () => {
  test('GET /health reports OpenFGA reachability and resolution', async () => {
    const { status, body } = await get('/health')
    assert.equal(status, 200)
    assert.equal(body.openfga, 'ok')
    assert.equal(body.resolved, '127.0.0.1')
  })

  test('unknown paths are 404 and other methods 405', async () => {
    assert.equal((await get('/nope')).status, 404)
    const res = await fetch(base + '/check', { method: 'POST' })
    assert.equal(res.status, 405)
  })
})
