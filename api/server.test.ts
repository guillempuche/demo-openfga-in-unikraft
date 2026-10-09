// Black-box tests for the demo API: they start the bundled server
// (dist/server.mjs, the file that ships in the unikernel) against a stub
// OpenFGA and talk HTTP to it. Run with: npm test (builds first).
//
// Most tests share one API process. A test that depends on the store cache
// (lookups, expiry, a store that disappears) or on startup config gets its own
// process (withFreshApi), so it never sees what earlier tests cached.
//
// Tests marked [slow] wait out a real timeout (2 or 5 seconds); each one runs
// its scenario once in a `before` hook and asserts on the recorded outcome.

import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { Agent, createServer, get as httpGet, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const BUNDLE = fileURLToPath(new URL('./dist/server.mjs', import.meta.url))
const TLS_SCRIPT = fileURLToPath(new URL('../scripts/tls.sh', import.meta.url))
const KEY = 'test-key-that-must-not-be-logged'

// The SDK only accepts ULIDs as store and model ids.
const STORE_1 = '01HX0000000000000000000001'
const STORE_2 = '01HX0000000000000000000002'
const OTHER = '01HX0000000000000000000009'
const MODEL = '01HX00000000000000000000M1'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Polls until `cond` holds: a readiness signal instead of a fixed sleep. */
async function until(cond: () => boolean, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await sleep(5)
  }
}

// --- stub OpenFGA ----------------------------------------------------------

type Reply = { status: number; body: string }
const json = (status: number, body: unknown): Reply => ({ status, body: JSON.stringify(body) })
/** Closes the connection without answering. */
const DROP: Reply = { status: 0, body: '' }

type Route = 'healthz' | 'stores' | 'models' | 'check' | 'batchCheck' | 'listObjects' | 'other'

/** One request the stub received. */
interface Received {
  readonly route: Route
  readonly method: string
  readonly path: string
  readonly query: URLSearchParams
  readonly storeId: string | undefined
  readonly body: any
  readonly authorization: string
}

/** Replaces a route's default answer; returning undefined keeps the default. */
type Hook = (req: Received) => Reply | undefined | Promise<Reply | undefined>

const stub = {
  stores: [] as { id: string; name: string }[],
  // Stores that have no authorization model yet.
  modelless: new Set<string>(),
  hooks: {} as Partial<Record<Route, Hook>>,
  received: [] as Received[],
  // Routes whose request the API cancelled before the stub answered.
  aborted: [] as Route[],
}

const calls = (route: Route) => stub.received.filter((r) => r.route === route)

function routeOf(method: string, path: string): { route: Route; storeId?: string } {
  if (method === 'GET' && path === '/healthz') return { route: 'healthz' }
  if (method === 'GET' && path === '/stores') return { route: 'stores' }
  const m = path.match(/^\/stores\/([^/]+)\/(.+)$/)
  if (!m) return { route: 'other' }
  const [, storeId, rest] = m
  if (method === 'GET' && rest === 'authorization-models') return { route: 'models', storeId }
  if (method === 'POST' && rest === 'check') return { route: 'check', storeId }
  if (method === 'POST' && rest === 'batch-check') return { route: 'batchCheck', storeId }
  if (method === 'POST' && rest === 'list-objects') return { route: 'listObjects', storeId }
  return { route: 'other', storeId }
}

function defaultReply(req: Received): Reply {
  switch (req.route) {
    case 'healthz':
      return json(200, { status: 'SERVING' })
    case 'stores': {
      const name = req.query.get('name')
      return json(200, { stores: stub.stores.filter((s) => !name || s.name === name), continuation_token: '' })
    }
    case 'models':
      return json(200, {
        authorization_models: stub.modelless.has(req.storeId!) ? [] : [{ id: MODEL, schema_version: '1.2', type_definitions: [] }],
        continuation_token: '',
      })
    case 'check':
      // What OpenFGA answers for a store without a model when no model id is sent.
      if (stub.modelless.has(req.storeId!) && !req.body.authorization_model_id) {
        return json(400, { code: 'latest_authorization_model_not_found', message: `No authorization models found for store '${req.storeId}'` })
      }
      return json(200, { allowed: req.body.tuple_key.user === 'user:alice' })
    case 'batchCheck':
      return json(200, {
        result: Object.fromEntries(req.body.checks.map((c: any) => [c.correlation_id, { allowed: c.tuple_key.user === 'user:alice' }])),
      })
    case 'listObjects':
      return json(200, { objects: req.body.user === 'user:alice' ? ['project:roadmap', 'project:wiki'] : [] })
    default:
      return json(404, { code: 'not_found' })
  }
}

// Open TCP connections from the API, to check that idle ones get closed.
let openConnections = 0

async function handleOpenFga(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://stub')
  let raw = ''
  for await (const chunk of req) raw += chunk
  const { route, storeId } = routeOf(req.method ?? '', url.pathname)
  const received: Received = {
    route,
    method: req.method ?? '',
    path: url.pathname,
    query: url.searchParams,
    storeId,
    body: raw ? JSON.parse(raw) : undefined,
    authorization: req.headers.authorization ?? '',
  }
  stub.received.push(received)
  res.on('close', () => {
    if (!res.writableEnded) stub.aborted.push(route)
  })
  const reply = (await stub.hooks[route]?.(received)) ?? defaultReply(received)
  if (res.destroyed) return
  if (reply === DROP) {
    req.socket.destroy()
    return
  }
  res.writeHead(reply.status, { 'content-type': 'application/json' })
  res.end(reply.body)
}

const openfga: Server = createServer(handleOpenFga)
openfga.keepAliveTimeout = 60_000 // only the API may close idle connections
openfga.on('connection', (socket) => {
  openConnections++
  socket.on('close', () => openConnections--)
})

// --- the API under test ----------------------------------------------------

async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const { port } = s.address() as AddressInfo
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

type Env = Record<string, string | undefined>
type Api = { base: string; proc: ChildProcess; output: () => string }

function spawnApi(env: Env, port: number) {
  let output = ''
  const vars = Object.fromEntries(Object.entries({ PATH: process.env.PATH, PORT: String(port), ...env }).filter(([, v]) => v !== undefined))
  const proc = spawn(process.execPath, [BUNDLE], { env: vars as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stdout!.on('data', (d) => (output += d))
  proc.stderr!.on('data', (d) => (output += d))
  return { proc, output: () => output }
}

async function startApi(env: Env): Promise<Api> {
  const port = await freePort()
  const { proc, output } = spawnApi(env, port)
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) break
    try {
      if ((await fetch(`${base}/openapi.json`)).ok) return { base, proc, output }
    } catch {}
    await sleep(50)
  }
  proc.kill()
  throw new Error(`API didn't start:\n${output()}`)
}

async function stopApi(api: Api) {
  if (api.proc.exitCode !== null) return
  const exited = new Promise((r) => api.proc.once('exit', r))
  api.proc.kill()
  await exited
}

/** Starts the API with the given config and waits for it to exit (it should refuse to start). */
async function runUntilExit(env: Env): Promise<{ code: number | null; output: string }> {
  const { proc, output } = spawnApi(env, await freePort())
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      proc.kill()
      resolve(null)
    }, 5000)
    proc.once('exit', (c) => {
      clearTimeout(timer)
      resolve(c)
    })
  })
  return { code, output: output() }
}

let api: Api
let openfgaUrl = ''
// An address nothing listens on, for "OpenFGA is down".
let deadUrl = ''

const defaultEnv = (): Env => ({ FGA_API_URL: openfgaUrl, FGA_KEY: KEY })

/** Runs `fn` against a dedicated API process (empty store cache), then stops it. */
async function withFreshApi<T>(env: Env, fn: (fresh: Api) => Promise<T>): Promise<T> {
  const fresh = await startApi({ ...defaultEnv(), ...env })
  try {
    return await fn(fresh)
  } finally {
    await stopApi(fresh)
  }
}

type Res = { status: number; body: any; contentType: string | null }

async function request(target: Api, path: string, init?: RequestInit): Promise<Res> {
  const res = await fetch(target.base + path, init)
  const text = await res.text()
  let body: any = text
  try {
    body = JSON.parse(text)
  } catch {}
  return { status: res.status, body, contentType: res.headers.get('content-type') }
}

const get = (path: string, target: Api = api) => request(target, path)

const postBatch = (body: unknown, target: Api = api) =>
  request(target, '/batch-check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const checkPath = (q: Record<string, string>) => `/check?${new URLSearchParams(q)}`
const ALICE_EDITS_ROADMAP = { user: 'user:alice', relation: 'can_edit', object: 'project:roadmap' }
const CHECK = checkPath(ALICE_EDITS_ROADMAP)

const item = (correlationId: string, user = 'user:alice') => ({ correlationId, user, relation: 'can_edit', object: 'project:roadmap' })

before(async () => {
  await new Promise<void>((r) => openfga.listen(0, '127.0.0.1', r))
  openfgaUrl = `http://127.0.0.1:${(openfga.address() as AddressInfo).port}`
  deadUrl = `http://127.0.0.1:${await freePort()}`
  api = await startApi(defaultEnv())
})

after(async () => {
  if (api) await stopApi(api)
  openfga.close()
})

/** Back to the default stub: two stores, every store with MODEL, no hooks, nothing received. */
function resetStub() {
  stub.stores = [
    { id: OTHER, name: 'unrelated' },
    { id: STORE_1, name: 'demo-fga' },
  ]
  stub.modelless = new Set()
  stub.hooks = {}
  stub.received = []
  stub.aborted = []
}

// A describe-level `before` runs ahead of this hook, so those call resetStub() themselves.
beforeEach(resetStub)

// --- GET /check ------------------------------------------------------------

describe('GET /check', () => {
  describe('when OpenFGA allows the tuple', () => {
    it('should answer 200 with the tuple, allowed: true and the latency', async () => {
      // GIVEN the default stub, which allows user:alice
      // WHEN checking user:alice can_edit project:roadmap
      const { status, body } = await get(CHECK)
      // THEN the answer echoes the tuple with allowed: true and a numeric ms
      assert.equal(status, 200)
      assert.equal(typeof body.ms, 'number')
      assert.deepEqual({ ...body, ms: 0 }, { ...ALICE_EDITS_ROADMAP, allowed: true, ms: 0 })
    })

    it('should send the latest model id with the check', async () => {
      // GIVEN a store whose latest model is MODEL
      // WHEN checking a tuple
      await get(CHECK)
      // THEN OpenFGA receives that model id and the tuple
      const [check] = calls('check')
      assert.equal(check.body.authorization_model_id, MODEL)
      assert.deepEqual(check.body.tuple_key, ALICE_EDITS_ROADMAP)
    })
  })

  describe('when OpenFGA denies the tuple', () => {
    it('should answer allowed: false', async () => {
      // GIVEN the default stub, which denies everyone but user:alice
      // WHEN checking user:bob
      const { status, body } = await get(checkPath({ ...ALICE_EDITS_ROADMAP, user: 'user:bob' }))
      // THEN the answer is a 200 with allowed: false
      assert.equal(status, 200)
      assert.equal(body.allowed, false)
    })
  })

  describe('when OpenFGA omits allowed from its answer', () => {
    it('should answer allowed: false', async () => {
      // GIVEN OpenFGA answers {} (proto3 drops a false boolean)
      stub.hooks.check = () => json(200, {})
      // WHEN checking a tuple
      const { status, body } = await get(CHECK)
      // THEN the API reports allowed: false
      assert.equal(status, 200)
      assert.equal(body.allowed, false)
    })
  })

  describe('when a consistency preference is given', () => {
    for (const consistency of ['MINIMIZE_LATENCY', 'HIGHER_CONSISTENCY']) {
      it(`should forward ${consistency} to OpenFGA`, async () => {
        // GIVEN a valid consistency preference
        // WHEN checking with it
        await get(checkPath({ ...ALICE_EDITS_ROADMAP, consistency }))
        // THEN OpenFGA receives it
        assert.equal(calls('check')[0].body.consistency, consistency)
      })
    }

    it('should answer 400 with a JSON reason for an unknown value', async () => {
      // GIVEN a consistency value OpenFGA doesn't define
      // WHEN checking with it
      const { status, body } = await get(checkPath({ ...ALICE_EDITS_ROADMAP, consistency: 'STRONG' }))
      // THEN the request is rejected before reaching OpenFGA
      assert.equal(status, 400)
      assert.equal(body._tag, 'BadRequest')
      assert.match(body.message, /^invalid query/)
      assert.equal(calls('check').length, 0)
    })
  })

  describe('when no consistency preference is given', () => {
    it('should not send one to OpenFGA', async () => {
      // GIVEN no consistency parameter
      // WHEN checking a tuple
      await get(CHECK)
      // THEN the check body has no consistency field
      assert.equal(calls('check')[0].body.consistency, undefined)
    })
  })

  describe('when a tuple field is missing or empty', () => {
    const cases: Record<string, string> = {
      'user is missing': '/check?relation=can_edit&object=project:roadmap',
      'relation is missing': '/check?user=user:alice&object=project:roadmap',
      'object is missing': '/check?user=user:alice&relation=can_edit',
      'user is empty': '/check?user=&relation=can_edit&object=project:roadmap',
      'relation is empty': '/check?user=user:alice&relation=&object=project:roadmap',
      'object is empty': '/check?user=user:alice&relation=can_edit&object=',
    }
    for (const [label, path] of Object.entries(cases)) {
      it(`should answer 400 with a JSON reason when ${label}`, async () => {
        // GIVEN a query with that field missing or empty
        // WHEN checking
        const { status, body } = await get(path)
        // THEN the API answers 400 BadRequest naming the query
        assert.equal(status, 400)
        assert.equal(body._tag, 'BadRequest')
        assert.match(body.message, /^invalid query/)
        // AND OpenFGA is never called
        assert.equal(calls('check').length, 0)
      })
    }
  })

  describe('when OpenFGA rejects the check as invalid (400 validation_error)', () => {
    beforeEach(() => {
      stub.hooks.check = () => json(400, { code: 'validation_error', message: "relation 'project#nope' not found" })
    })

    it("should answer 400 BadRequest with OpenFGA's message", async () => {
      // GIVEN OpenFGA rejects the check (see beforeEach)
      // WHEN checking
      const { status, body } = await get(CHECK)
      // THEN the API answers 400 with the message prefixed by the operation
      assert.equal(status, 400)
      assert.deepEqual(body, { _tag: 'BadRequest', message: "check: relation 'project#nope' not found" })
    })

    it('should call OpenFGA exactly once', async () => {
      // GIVEN OpenFGA rejects the check (see beforeEach)
      // WHEN checking
      await get(CHECK)
      // THEN the API doesn't retry
      assert.equal(calls('check').length, 1)
    })

    it('should not look the store up again', async () => {
      await withFreshApi({}, async (fresh) => {
        // GIVEN a fresh API that resolved the store on its first check
        await get(CHECK, fresh)
        // WHEN a second check is rejected as invalid
        await get(CHECK, fresh)
        // THEN the store list was read only once
        assert.equal(calls('stores').length, 1)
      })
    })
  })

  describe('when OpenFGA answers 400 with a non-JSON body', () => {
    it("should answer 400 with the SDK's own message", async () => {
      // GIVEN OpenFGA answers 400 with a plain-text body
      stub.hooks.check = () => ({ status: 400, body: 'bad request' })
      // WHEN checking
      const { status, body } = await get(CHECK)
      // THEN the message falls back to the HTTP client's description
      assert.equal(status, 400)
      assert.deepEqual(body, { _tag: 'BadRequest', message: 'check: Request failed with status code 400' })
    })
  })

  describe('when OpenFGA refuses the key (401)', () => {
    it('should answer 502 with the status after one call', async () => {
      // GIVEN OpenFGA answers 401
      stub.hooks.check = () => json(401, { code: 'unauthenticated', message: 'unauthenticated' })
      // WHEN checking
      const { status, body } = await get(CHECK)
      // THEN the API answers 502 UpstreamError with HTTP 401
      assert.equal(status, 502)
      assert.equal(body._tag, 'UpstreamError')
      assert.match(body.message, /^check: HTTP 401/)
      // AND doesn't retry
      assert.equal(calls('check').length, 1)
    })
  })

  describe('when OpenFGA rate-limits the call (429)', () => {
    it('should answer 502 with the status after one call', async () => {
      // GIVEN OpenFGA answers 429
      stub.hooks.check = () => json(429, { code: 'rate_limit_exceeded', message: 'rate limit exceeded' })
      // WHEN checking
      const { status, body } = await get(CHECK)
      // THEN the API answers 502 with HTTP 429
      assert.equal(status, 502)
      assert.match(body.message, /^check: HTTP 429/)
      // AND doesn't retry
      assert.equal(calls('check').length, 1)
    })
  })

  describe('when OpenFGA keeps failing (503)', () => {
    beforeEach(() => {
      stub.hooks.check = () => ({ status: 503, body: '' })
    })

    it('should answer 502 with the HTTP status', async () => {
      // GIVEN OpenFGA answers 503 with an empty body (see beforeEach)
      // WHEN checking
      const { status, body } = await get(CHECK)
      // THEN the API answers 502 and keeps the status
      assert.equal(status, 502)
      assert.deepEqual(body, { _tag: 'UpstreamError', message: 'check: HTTP 503' })
    })

    it('should retry exactly once', async () => {
      // GIVEN OpenFGA answers 503 (see beforeEach)
      // WHEN checking
      await get(CHECK)
      // THEN OpenFGA saw two calls
      assert.equal(calls('check').length, 2)
    })
  })

  describe('when OpenFGA fails once (503) and then recovers', () => {
    it('should answer 200 from the retry', async () => {
      // GIVEN the first check fails with 503 and the next succeeds
      stub.hooks.check = () => (calls('check').length === 1 ? { status: 503, body: '' } : undefined)
      // WHEN checking
      const { status, body } = await get(CHECK)
      // THEN the retry's answer is returned
      assert.equal(status, 200)
      assert.equal(body.allowed, true)
      assert.equal(calls('check').length, 2)
    })
  })

  describe('when OpenFGA is unreachable', () => {
    it('should answer 502 UpstreamError', async () => {
      await withFreshApi({ FGA_API_URL: deadUrl }, async (fresh) => {
        // GIVEN an API pointing at a port nothing listens on
        // WHEN checking
        const { status, body } = await get(CHECK, fresh)
        // THEN the API answers 502 naming the failed step
        assert.equal(status, 502)
        assert.equal(body._tag, 'UpstreamError')
        assert.match(body.message, /^list stores: /)
      })
    })
  })

  describe('when OpenFGA takes longer than 5 seconds [slow]', () => {
    let res: Res
    let checkCalls = 0
    let aborted: Route[] = []

    before(async () => {
      resetStub()
      // GIVEN OpenFGA answers checks only after 6 seconds
      stub.hooks.check = async () => {
        await sleep(6000)
        return undefined
      }
      // WHEN checking
      res = await get(CHECK)
      // The stub sees the cancelled request close just after the API answers.
      await until(() => stub.aborted.length > 0, 1000).catch(() => undefined)
      checkCalls = calls('check').length
      aborted = [...stub.aborted]
    })

    it('should answer 502 "check: timed out after 5s"', () => {
      // THEN the API gives up after 5 seconds
      assert.equal(res.status, 502)
      assert.deepEqual(res.body, { _tag: 'UpstreamError', message: 'check: timed out after 5s' })
    })

    it('should not retry', () => {
      // THEN OpenFGA saw a single check
      assert.equal(checkCalls, 1)
    })

    it('should cancel the request to OpenFGA', () => {
      // THEN the stub saw the API close the pending request
      assert.deepEqual(aborted, ['check'])
    })
  })

  describe('when the store cache is warm', () => {
    it('should not list the stores again within the TTL', async () => {
      await withFreshApi({}, async (fresh) => {
        // GIVEN a fresh API with the default 30 s TTL
        // WHEN checking twice
        await get(CHECK, fresh)
        await get(CHECK, fresh)
        // THEN the stores and models were read once
        assert.equal(calls('stores').length, 1)
        assert.equal(calls('models').length, 1)
        assert.equal(calls('check').length, 2)
      })
    })

    it('should look the store up again after the TTL', async () => {
      await withFreshApi({ FGA_STORE_CACHE_TTL: '300 millis' }, async (fresh) => {
        // GIVEN a fresh API with a 300 ms TTL that has resolved the store
        await get(CHECK, fresh)
        // WHEN checking again after the TTL
        await sleep(400)
        await get(CHECK, fresh)
        // THEN the store list was read twice
        assert.equal(calls('stores').length, 2)
      })
    })
  })

  describe('when several stores exist', () => {
    it('should use the store whose name matches exactly', async () => {
      await withFreshApi({}, async (fresh) => {
        // GIVEN OpenFGA lists a store with a similar name before the right one
        stub.hooks.stores = () =>
          json(200, { stores: [{ id: OTHER, name: 'demo-fga-old' }, { id: STORE_2, name: 'demo-fga' }], continuation_token: '' })
        // WHEN checking
        await get(CHECK, fresh)
        // THEN the check goes to the exact match
        assert.equal(calls('check')[0].storeId, STORE_2)
      })
    })

    it('should use the first of several stores with the same name', async () => {
      await withFreshApi({}, async (fresh) => {
        // GIVEN two stores named demo-fga
        stub.stores = [
          { id: STORE_2, name: 'demo-fga' },
          { id: STORE_1, name: 'demo-fga' },
        ]
        // WHEN checking
        await get(CHECK, fresh)
        // THEN the first one in OpenFGA's order is used
        assert.equal(calls('check')[0].storeId, STORE_2)
      })
    })
  })

  describe('when no store has the configured name', () => {
    it('should answer 502 after listing the stores once', async () => {
      await withFreshApi({}, async (fresh) => {
        // GIVEN no store named demo-fga
        stub.stores = [{ id: OTHER, name: 'unrelated' }]
        // WHEN checking
        const { status, body } = await get(CHECK, fresh)
        // THEN the API answers 502 naming the store
        assert.equal(status, 502)
        assert.deepEqual(body, { _tag: 'UpstreamError', message: 'store "demo-fga" not found' })
        // AND doesn't retry the lookup
        assert.equal(calls('stores').length, 1)
        assert.equal(calls('check').length, 0)
      })
    })
  })

  describe('when listing the stores fails (503)', () => {
    it('should answer 502 with the error prefixed once', async () => {
      await withFreshApi({}, async (fresh) => {
        // GIVEN GET /stores answers 503
        stub.hooks.stores = () => ({ status: 503, body: '' })
        // WHEN checking
        const { status, body } = await get(CHECK, fresh)
        // THEN the message names the lookup step once
        assert.equal(status, 502)
        assert.deepEqual(body, { _tag: 'UpstreamError', message: 'list stores: HTTP 503' })
        // AND the lookup was retried once
        assert.equal(calls('stores').length, 2)
      })
    })

    it('should not cache the failure', async () => {
      await withFreshApi({}, async (fresh) => {
        // GIVEN a lookup that failed
        stub.hooks.stores = () => ({ status: 503, body: '' })
        await get(CHECK, fresh)
        // WHEN OpenFGA recovers and the client checks again
        stub.hooks.stores = undefined
        const { status } = await get(CHECK, fresh)
        // THEN the lookup runs again and succeeds
        assert.equal(status, 200)
        assert.equal(calls('stores').length, 3)
      })
    })
  })

  describe('when listing the stores takes longer than 5 seconds [slow]', () => {
    let res: Res

    before(async () => {
      resetStub()
      await withFreshApi({}, async (fresh) => {
        // GIVEN GET /stores answers only after 6 seconds
        stub.hooks.stores = async () => {
          await sleep(6000)
          return undefined
        }
        // WHEN checking
        res = await get(CHECK, fresh)
      })
    })

    it('should answer 502 with the timeout prefixed once', () => {
      // THEN the message names the lookup step once
      assert.equal(res.status, 502)
      assert.deepEqual(res.body, { _tag: 'UpstreamError', message: 'list stores: timed out after 5s' })
    })
  })

  describe('when reading the models fails', () => {
    it('should answer 502 with the error prefixed once', async () => {
      await withFreshApi({}, async (fresh) => {
        // GIVEN GET authorization-models answers 500
        stub.hooks.models = () => json(500, { code: 'internal_error', message: 'boom' })
        // WHEN checking
        const { status, body } = await get(CHECK, fresh)
        // THEN the API answers 502 naming the step
        assert.equal(status, 502)
        assert.deepEqual(body, { _tag: 'UpstreamError', message: 'read models: HTTP 500 boom' })
      })
    })
  })

  describe('when the store has no model', () => {
    it('should answer 502 "store or model not found"', async () => {
      await withFreshApi({}, async (fresh) => {
        // GIVEN the store exists but has no authorization model
        stub.modelless.add(STORE_1)
        // WHEN checking
        const { status, body } = await get(CHECK, fresh)
        // THEN the API answers 502 after one fresh lookup
        assert.equal(status, 502)
        assert.deepEqual(body, { _tag: 'UpstreamError', message: 'check: store or model not found' })
      })
    })
  })

  describe('when the cached store is gone', () => {
    const gone: Record<string, Reply> = {
      '404 not found': json(404, { code: 'undefined_endpoint', message: 'Not Found' }),
      '400 store_id_not_found': json(400, { code: 'store_id_not_found', message: 'store not found' }),
      '400 authorization_model_not_found': json(400, { code: 'authorization_model_not_found', message: 'model not found' }),
      '400 latest_authorization_model_not_found': json(400, { code: 'latest_authorization_model_not_found', message: 'no models' }),
    }
    for (const [label, reply] of Object.entries(gone)) {
      it(`should look the store up again after ${label}`, async () => {
        await withFreshApi({}, async (fresh) => {
          // GIVEN an API that cached STORE_1, which was then recreated as STORE_2
          await get(CHECK, fresh)
          stub.stores = [{ id: STORE_2, name: 'demo-fga' }]
          stub.hooks.check = (req) => (req.storeId === STORE_1 ? reply : undefined)
          // WHEN checking again
          const { status } = await get(CHECK, fresh)
          // THEN the check is retried on the new store
          assert.equal(status, 200)
          assert.deepEqual(
            calls('check').map((c) => c.storeId),
            [STORE_1, STORE_1, STORE_2],
          )
        })
      })
    }

    describe('and the new lookup finds it gone too', () => {
      let res: Res
      let checks = 0
      let lookups = 0

      before(async () => {
        resetStub()
        await withFreshApi({}, async (fresh) => {
          // GIVEN every check reports the store gone
          stub.hooks.check = () => json(404, { code: 'store_id_not_found', message: 'gone' })
          // WHEN checking
          res = await get(CHECK, fresh)
          checks = calls('check').length
          lookups = calls('stores').length
        })
      })

      it('should answer 502 "store or model not found"', () => {
        // THEN the API gives up with a clear message
        assert.equal(res.status, 502)
        assert.deepEqual(res.body, { _tag: 'UpstreamError', message: 'check: store or model not found' })
      })

      it('should try once per lookup and not retry further', () => {
        // THEN there were two lookups and two checks
        assert.equal(lookups, 2)
        assert.equal(checks, 2)
      })
    })
  })

  describe('when several requests find the cache cold at once', () => {
    it('should share one store lookup', async () => {
      await withFreshApi({}, async (fresh) => {
        // GIVEN a slow store listing
        stub.hooks.stores = async () => {
          await sleep(100)
          return undefined
        }
        // WHEN five checks arrive together
        const results = await Promise.all(Array.from({ length: 5 }, () => get(CHECK, fresh)))
        // THEN all succeed after a single GET /stores
        assert.deepEqual(
          results.map((r) => r.status),
          [200, 200, 200, 200, 200],
        )
        assert.equal(calls('stores').length, 1)
        assert.equal(calls('models').length, 1)
      })
    })
  })

  describe('when the only request waiting for a store lookup goes away', () => {
    let aborted: Route[] = []
    let next: Res
    let lookups = 0

    before(async () => {
      resetStub()
      await withFreshApi({}, async (fresh) => {
        // GIVEN a slow store listing, awaited by a single check
        stub.hooks.stores = async () => {
          await sleep(500)
          return undefined
        }
        // (A raw request whose socket is destroyed: an aborted fetch leaves its
        // connection open for a few seconds, which delays stopping the API.)
        const first = httpGet(fresh.base + CHECK, { agent: false }).on('error', () => undefined)
        await until(() => calls('stores').length === 1)
        // WHEN its client disconnects
        first.destroy()
        await until(() => stub.aborted.length > 0, 1000).catch(() => undefined)
        aborted = [...stub.aborted]
        // AND a new check arrives once OpenFGA is fast again
        stub.hooks.stores = undefined
        next = await get(CHECK, fresh)
        lookups = calls('stores').length
      })
    })

    it('should cancel the lookup', () => {
      // THEN the stub saw the API close the pending GET /stores
      assert.deepEqual(aborted, ['stores'])
    })

    it('should look the store up again for the next request', () => {
      // THEN the next check ran its own lookup and succeeded
      assert.equal(next.status, 200)
      assert.equal(lookups, 2)
    })
  })

  // With scale-to-zero policy `on`, an open connection keeps the instance up.
  describe('when the connection to OpenFGA is idle [slow]', () => {
    it('should close it within 5 seconds', async () => {
      // GIVEN the API made a call to OpenFGA
      await get(CHECK)
      assert.ok(openConnections > 0)
      // WHEN nothing happens for 5 seconds
      await sleep(5000)
      // THEN no connection is left open
      assert.equal(openConnections, 0)
    })
  })
})

// --- POST /batch-check -----------------------------------------------------

describe('POST /batch-check', () => {
  describe('when every item gets a decision', () => {
    it('should answer per correlation id, in request order', async () => {
      // GIVEN alice is allowed and carol isn't
      // WHEN checking both in one batch
      const { status, body } = await postBatch({ checks: [item('a'), item('b', 'user:carol')] })
      // THEN each id gets its decision
      assert.equal(status, 200)
      assert.deepEqual(body, {
        results: [
          { correlationId: 'a', allowed: true },
          { correlationId: 'b', allowed: false },
        ],
      })
    })

    it('should forward the items with their correlation ids and the model id', async () => {
      // GIVEN two items
      // WHEN checking them
      await postBatch({ checks: [item('a'), item('b', 'user:carol')] })
      // THEN OpenFGA receives both in one call with the model id
      const [batch] = calls('batchCheck')
      assert.equal(batch.body.authorization_model_id, MODEL)
      assert.deepEqual(
        batch.body.checks.map((c: any) => [c.correlation_id, c.tuple_key.user]),
        [
          ['a', 'user:alice'],
          ['b', 'user:carol'],
        ],
      )
    })
  })

  describe('when the batch has exactly 50 items', () => {
    it('should send them to OpenFGA in one call', async () => {
      // GIVEN 50 items
      const checks = Array.from({ length: 50 }, (_, i) => item(`c${i}`))
      // WHEN checking them
      const { status, body } = await postBatch({ checks })
      // THEN one upstream call answers all 50
      assert.equal(status, 200)
      assert.equal(body.results.length, 50)
      assert.equal(calls('batchCheck').length, 1)
    })
  })

  describe('when the request is invalid', () => {
    const cases: Record<string, unknown> = {
      'it has 51 items': { checks: Array.from({ length: 51 }, (_, i) => item(`c${i}`)) },
      'it has no items': { checks: [] },
      'checks is missing': {},
      'an item has no correlationId': { checks: [{ user: 'user:alice', relation: 'can_edit', object: 'project:roadmap' }] },
      'an item has an empty correlationId': { checks: [item('')] },
      'an item has no user': { checks: [{ correlationId: 'a', relation: 'can_edit', object: 'project:roadmap' }] },
      'an item has an empty relation': { checks: [{ ...item('a'), relation: '' }] },
      'an item has an empty object': { checks: [{ ...item('a'), object: '' }] },
      'the body is malformed JSON': '{"checks": [',
    }
    for (const [label, payload] of Object.entries(cases)) {
      it(`should answer 400 with a JSON reason when ${label}`, async () => {
        // GIVEN a request with that defect
        // WHEN posting it
        const { status, body } = await postBatch(payload)
        // THEN the API answers 400 naming the payload
        assert.equal(status, 400)
        assert.equal(body._tag, 'BadRequest')
        assert.match(body.message, /^invalid payload/)
        // AND OpenFGA is never called
        assert.equal(calls('batchCheck').length, 0)
      })
    }
  })

  describe('when two items share a correlationId', () => {
    it('should answer 400 naming the duplicate, without calling OpenFGA', async () => {
      // GIVEN two items with correlationId "a"
      // WHEN posting them
      const { status, body } = await postBatch({ checks: [item('a'), item('a', 'user:carol')] })
      // THEN the API answers 400 and points at the second one
      assert.equal(status, 400)
      assert.equal(body._tag, 'BadRequest')
      assert.match(body.message, /^invalid payload: duplicate correlationId "a"/)
      assert.match(body.message, /\["checks"\]\[1\]\["correlationId"\]/)
      // AND OpenFGA is never called (no retry either)
      assert.equal(calls('batchCheck').length, 0)
    })
  })

  describe('when the body is not declared as JSON', () => {
    it('should answer 415 with a JSON reason', async () => {
      // GIVEN a valid payload sent as text/plain
      // WHEN posting it
      const res = await request(api, '/batch-check', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ checks: [item('a')] }),
      })
      // THEN the API answers 415 in the error shape
      assert.equal(res.status, 415)
      assert.match(res.contentType ?? '', /application\/json/)
      assert.deepEqual(res.body, { _tag: 'UnsupportedMediaType', message: 'unsupported content-type: send application/json' })
      // AND OpenFGA is never called
      assert.equal(calls('batchCheck').length, 0)
    })
  })

  describe('when the content-type header is missing', () => {
    it('should treat the body as JSON', async () => {
      // GIVEN a valid payload without a content-type (a byte body gets none)
      // WHEN posting it
      const res = await request(api, '/batch-check', {
        method: 'POST',
        body: new TextEncoder().encode(JSON.stringify({ checks: [item('a')] })),
      })
      // THEN it is answered normally
      assert.equal(res.status, 200)
      assert.deepEqual(res.body, { results: [{ correlationId: 'a', allowed: true }] })
    })
  })

  describe('when OpenFGA fails to evaluate one item', () => {
    it('should report that item with an error and no decision', async () => {
      // GIVEN OpenFGA answers item "b" with an error
      stub.hooks.batchCheck = () =>
        json(200, {
          result: {
            a: { allowed: true },
            b: { error: { input_error: 'validation_error', message: 'missing context parameters' } },
          },
        })
      // WHEN checking both
      const { status, body } = await postBatch({ checks: [item('a'), item('b')] })
      // THEN "a" has its decision and "b" carries the error instead of allowed: false
      assert.equal(status, 200)
      assert.deepEqual(body, {
        results: [
          { correlationId: 'a', allowed: true },
          { correlationId: 'b', error: 'missing context parameters' },
        ],
      })
    })
  })

  describe('when OpenFGA leaves an item out of its reply', () => {
    it('should report the missing item with an error', async () => {
      // GIVEN OpenFGA answers only item "a"
      stub.hooks.batchCheck = () => json(200, { result: { a: { allowed: true } } })
      // WHEN checking "a" and "b"
      const { status, body } = await postBatch({ checks: [item('a'), item('b')] })
      // THEN "b" is reported, not dropped
      assert.equal(status, 200)
      assert.deepEqual(body, {
        results: [
          { correlationId: 'a', allowed: true },
          { correlationId: 'b', error: 'no result from OpenFGA' },
        ],
      })
    })
  })

  describe('when OpenFGA rejects the batch (400)', () => {
    it("should answer 400 with OpenFGA's message", async () => {
      // GIVEN OpenFGA rejects the request
      stub.hooks.batchCheck = () => json(400, { code: 'validation_error', message: 'invalid correlation id' })
      // WHEN checking
      const { status, body } = await postBatch({ checks: [item('a')] })
      // THEN the API answers 400
      assert.equal(status, 400)
      assert.deepEqual(body, { _tag: 'BadRequest', message: 'batch check: invalid correlation id' })
    })
  })

  describe('when OpenFGA fails (503)', () => {
    it('should answer 502 after one retry', async () => {
      // GIVEN OpenFGA answers 503
      stub.hooks.batchCheck = () => ({ status: 503, body: '' })
      // WHEN checking
      const { status, body } = await postBatch({ checks: [item('a')] })
      // THEN the API answers 502
      assert.equal(status, 502)
      assert.deepEqual(body, { _tag: 'UpstreamError', message: 'batch check: HTTP 503' })
      assert.equal(calls('batchCheck').length, 2)
    })
  })

  describe('when the cached store is gone', () => {
    it('should look the store up again and answer from the new store', async () => {
      await withFreshApi({}, async (fresh) => {
        // GIVEN an API that cached STORE_1, which was then recreated as STORE_2
        await postBatch({ checks: [item('a')] }, fresh)
        stub.stores = [{ id: STORE_2, name: 'demo-fga' }]
        stub.hooks.batchCheck = (req) => (req.storeId === STORE_1 ? json(404, { code: 'store_id_not_found' }) : undefined)
        // WHEN checking again
        const { status } = await postBatch({ checks: [item('a')] }, fresh)
        // THEN the batch is retried on the new store
        assert.equal(status, 200)
        assert.equal(calls('batchCheck').at(-1)!.storeId, STORE_2)
      })
    })
  })
})

// --- GET /list-objects -----------------------------------------------------

describe('GET /list-objects', () => {
  describe('when the user can reach objects', () => {
    it('should answer with those objects', async () => {
      // GIVEN alice can reach two projects
      // WHEN listing her projects
      const { status, body } = await get('/list-objects?user=user:alice&relation=can_view&type=project')
      // THEN both are returned
      assert.equal(status, 200)
      assert.deepEqual(body, { objects: ['project:roadmap', 'project:wiki'] })
    })

    it('should forward the query and the model id to OpenFGA', async () => {
      // GIVEN a list-objects query
      // WHEN listing
      await get('/list-objects?user=user:alice&relation=can_view&type=project')
      // THEN OpenFGA receives it
      const [call] = calls('listObjects')
      assert.deepEqual(
        { user: call.body.user, relation: call.body.relation, type: call.body.type, model: call.body.authorization_model_id },
        { user: 'user:alice', relation: 'can_view', type: 'project', model: MODEL },
      )
    })
  })

  describe('when the user can reach nothing', () => {
    it('should answer an empty list', async () => {
      // GIVEN bob can reach no project
      // WHEN listing his projects
      const { status, body } = await get('/list-objects?user=user:bob&relation=can_view&type=project')
      // THEN the list is empty
      assert.equal(status, 200)
      assert.deepEqual(body, { objects: [] })
    })
  })

  describe('when the type is missing or empty', () => {
    for (const [label, path] of [
      ['missing', '/list-objects?user=user:alice&relation=can_view'],
      ['empty', '/list-objects?user=user:alice&relation=can_view&type='],
    ]) {
      it(`should answer 400 with a JSON reason when it is ${label}`, async () => {
        // GIVEN a query without a usable type
        // WHEN listing
        const { status, body } = await get(path)
        // THEN the API answers 400 without calling OpenFGA
        assert.equal(status, 400)
        assert.match(body.message, /^invalid query/)
        assert.equal(calls('listObjects').length, 0)
      })
    }
  })

  describe('when OpenFGA rejects the query (400)', () => {
    it("should answer 400 with OpenFGA's message", async () => {
      // GIVEN OpenFGA rejects the type
      stub.hooks.listObjects = () => json(400, { code: 'type_not_found', message: "type 'nope' not found" })
      // WHEN listing
      const { status, body } = await get('/list-objects?user=user:alice&relation=can_view&type=nope')
      // THEN the API answers 400
      assert.equal(status, 400)
      assert.deepEqual(body, { _tag: 'BadRequest', message: "list objects: type 'nope' not found" })
    })
  })

  describe('when OpenFGA fails (503)', () => {
    it('should answer 502', async () => {
      // GIVEN OpenFGA answers 503
      stub.hooks.listObjects = () => ({ status: 503, body: '' })
      // WHEN listing
      const { status, body } = await get('/list-objects?user=user:alice&relation=can_view&type=project')
      // THEN the API answers 502
      assert.equal(status, 502)
      assert.deepEqual(body, { _tag: 'UpstreamError', message: 'list objects: HTTP 503' })
    })
  })

  // The SDK doesn't validate OpenFGA's replies, so a malformed one reaches the
  // response schema: the API's own fault, not the client's.
  describe("when the answer doesn't match the response schema", () => {
    let res: Res
    let errorLines: any[] = []

    before(async () => {
      resetStub()
      await withFreshApi({}, async (fresh) => {
        // GIVEN OpenFGA lists objects that aren't strings
        stub.hooks.listObjects = () => json(200, { objects: [1, 2] })
        // WHEN listing
        res = await get('/list-objects?user=user:alice&relation=can_view&type=project', fresh)
        await until(() => fresh.output().includes('"level":"ERROR"'), 1000).catch(() => undefined)
        await sleep(100) // a duplicate line would show up by now
        errorLines = fresh
          .output()
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .filter((line) => line.level === 'ERROR')
      })
    })

    it('should answer 500', () => {
      // THEN the API reports its own failure, not a bad request
      assert.equal(res.status, 500)
    })

    it('should log the defect once, as JSON naming the request', () => {
      // THEN one ERROR line carries the schema failure and the request, without its query
      assert.equal(errorLines.length, 1, JSON.stringify(errorLines))
      const [line] = errorLines
      assert.deepEqual(line.annotations, { 'http.method': 'GET', 'http.url': '/list-objects' })
      assert.match(line.cause, /Expected string/)
    })
  })
})

// --- GET /bench ------------------------------------------------------------

describe('GET /bench', () => {
  describe('when called without parameters', () => {
    it('should run 100 checks of alice can_edit roadmap and report ordered stats', async () => {
      // GIVEN no parameters
      // WHEN benchmarking
      const { status, body } = await get('/bench')
      // THEN 100 measured checks ran with ordered percentiles
      assert.equal(status, 200)
      assert.equal(body.n, 100)
      assert.equal(body.unit, 'ms')
      assert.deepEqual([body.user, body.relation, body.object, body.allowed], ['user:alice', 'can_edit', 'project:roadmap', true])
      assert.ok(body.min <= body.p50 && body.p50 <= body.p95 && body.p95 <= body.max, JSON.stringify(body))
      assert.ok(body.min <= body.mean && body.mean <= body.max)
    })

    it('should report the OpenFGA origin as the target', async () => {
      // GIVEN the shared API, pointed at the stub
      // WHEN benchmarking
      const { body } = await get('/bench?n=1')
      // THEN the target is the stub's origin
      assert.equal(body.target, openfgaUrl)
    })
  })

  describe('when n is given', () => {
    const cases: [string, number][] = [
      ['0', 1],
      ['0.5', 1],
      ['-5', 1],
      ['1', 1],
      ['1.5', 1],
      ['100', 100],
      ['101', 100],
      ['5000', 100],
      ['abc', 100],
      ['', 100],
    ]
    for (const [raw, expected] of cases) {
      it(`should run ${expected} measured checks plus 3 warm-ups for n=${JSON.stringify(raw)}`, async () => {
        // GIVEN that value of n
        // WHEN benchmarking
        const { status, body } = await get(`/bench?n=${encodeURIComponent(raw)}`)
        // THEN the reported n is clamped and OpenFGA saw n + 3 checks
        assert.equal(status, 200)
        assert.equal(body.n, expected)
        assert.equal(calls('check').length, expected + 3)
      })
    }
  })

  describe('when n is 1', () => {
    it('should report the single sample as every statistic', async () => {
      // GIVEN one measured check
      // WHEN benchmarking
      const { body } = await get('/bench?n=1')
      // THEN p50, p95, min, max and mean are equal
      assert.equal(new Set([body.p50, body.p95, body.min, body.max, body.mean]).size, 1)
    })
  })

  describe('when a custom tuple is given', () => {
    const custom = { user: 'user:bob', relation: 'can_view', object: 'project:wiki' }

    it('should check that tuple in OpenFGA', async () => {
      // GIVEN a custom tuple
      // WHEN benchmarking it
      await get(`/bench?n=2&${new URLSearchParams(custom)}`)
      // THEN every upstream check used it
      assert.ok(calls('check').every((c) => JSON.stringify(c.body.tuple_key) === JSON.stringify(custom)))
    })

    it('should echo the tuple and its decision', async () => {
      // GIVEN a tuple the stub denies
      // WHEN benchmarking it
      const { body } = await get(`/bench?n=2&${new URLSearchParams(custom)}`)
      // THEN the tuple is echoed with allowed: false
      assert.deepEqual([body.user, body.relation, body.object, body.allowed], [custom.user, custom.relation, custom.object, false])
    })
  })

  describe('when a tuple parameter is empty', () => {
    for (const field of ['user', 'relation', 'object']) {
      it(`should answer 400 for an empty ${field}`, async () => {
        // GIVEN that parameter with no value
        // WHEN benchmarking
        const { status, body } = await get(`/bench?${field}=`)
        // THEN the API answers 400 without calling OpenFGA
        assert.equal(status, 400)
        assert.match(body.message, /^invalid query/)
        assert.equal(calls('check').length, 0)
      })
    }
  })

  describe('when a bench is already running', () => {
    it('should answer 429 Busy', async () => {
      // GIVEN a bench in progress (each check takes 5 ms)
      stub.hooks.check = async () => {
        await sleep(5)
        return undefined
      }
      const first = get('/bench?n=20')
      await until(() => calls('check').length >= 1)
      // WHEN a second bench starts
      const second = await get('/bench?n=1')
      // THEN it is refused while the first completes normally
      assert.equal(second.status, 429)
      assert.equal(second.body._tag, 'Busy')
      assert.equal((await first).status, 200)
    })
  })

  describe('when the previous bench failed upstream (503)', () => {
    it('should accept a new bench', async () => {
      // GIVEN a bench that failed with 502
      stub.hooks.check = () => ({ status: 503, body: '' })
      assert.equal((await get('/bench?n=1')).status, 502)
      // WHEN OpenFGA recovers and a new bench starts
      stub.hooks.check = undefined
      const { status } = await get('/bench?n=1')
      // THEN it runs
      assert.equal(status, 200)
    })
  })

  describe('when the previous bench was rejected by OpenFGA (400)', () => {
    it('should accept a new bench', async () => {
      // GIVEN a bench that failed with 400
      stub.hooks.check = () => json(400, { code: 'validation_error', message: 'bad tuple' })
      assert.equal((await get('/bench?n=1')).status, 400)
      // WHEN a valid bench starts
      stub.hooks.check = undefined
      const { status } = await get('/bench?n=1')
      // THEN it runs
      assert.equal(status, 200)
    })
  })

  describe('when the client disconnects mid-run', () => {
    it('should accept a new bench', async () => {
      // GIVEN a slow bench whose client goes away after the first check
      stub.hooks.check = async () => {
        await sleep(50)
        return undefined
      }
      const controller = new AbortController()
      const first = fetch(api.base + '/bench?n=100', { signal: controller.signal }).catch(() => undefined)
      await until(() => calls('check').length >= 1)
      controller.abort()
      await first
      await until(() => stub.aborted.includes('check'))
      // WHEN a new bench starts
      stub.hooks.check = undefined
      const { status } = await get('/bench?n=1')
      // THEN it runs instead of answering 429
      assert.equal(status, 200)
    })
  })
})

// --- condition context ------------------------------------------------------

/** The context OpenFGA received with the last call on `route` (a /batch-check item's, for batchCheck). */
const sentContext = (route: 'check' | 'batchCheck' | 'listObjects') => {
  const body = calls(route).at(-1)!.body
  return route === 'batchCheck' ? body.checks[0].context : body.context
}

describe('condition context', () => {
  describe('when checking a tuple', () => {
    it('should send current_time and user_ip with /check', async () => {
      // GIVEN the shared API (default CLIENT_IP_FROM=socket)
      // WHEN checking
      await get(CHECK)
      // THEN OpenFGA receives exactly those two parameters
      assert.deepEqual(Object.keys(sentContext('check')).sort(), ['current_time', 'user_ip'])
    })
  })

  describe('when checking a batch', () => {
    it('should send the same context with every item', async () => {
      // GIVEN three items
      // WHEN checking them in one batch
      await postBatch({ checks: [item('a'), item('b'), item('c')] })
      // THEN each item carries the same current_time and user_ip
      const contexts = calls('batchCheck')[0].body.checks.map((c: any) => c.context)
      assert.equal(contexts.length, 3)
      assert.deepEqual(Object.keys(contexts[0]).sort(), ['current_time', 'user_ip'])
      for (const context of contexts) assert.deepEqual(context, contexts[0])
    })
  })

  describe('when listing objects', () => {
    it('should send current_time and user_ip with /list-objects', async () => {
      // GIVEN a list-objects query
      // WHEN listing
      await get('/list-objects?user=user:alice&relation=can_view&type=project')
      // THEN OpenFGA receives the context
      assert.deepEqual(Object.keys(sentContext('listObjects')).sort(), ['current_time', 'user_ip'])
    })
  })

  describe('when benchmarking', () => {
    it('should send no context', async () => {
      // GIVEN a bench run
      // WHEN it checks
      await get('/bench?n=2')
      // THEN no check carried a context
      assert.ok(calls('check').every((c) => c.body.context === undefined))
    })
  })

  describe('when CURRENT_TIME_STEP is not set', () => {
    it('should send the server time rounded down to 10 seconds', async () => {
      // GIVEN the shared API (default step)
      // WHEN checking
      const before = Date.now()
      await get(CHECK)
      // THEN current_time is on a 10 s boundary, at most 10 s before the request
      const sent = Date.parse(sentContext('check').current_time)
      assert.equal(sent % 10_000, 0)
      assert.ok(sent <= Date.now() && sent > before - 10_000, sentContext('check').current_time)
    })
  })

  describe('when CURRENT_TIME_STEP is set', () => {
    it('should send the server time rounded down to that step', async () => {
      await withFreshApi({ CURRENT_TIME_STEP: '1 hour' }, async (fresh) => {
        // GIVEN a one-hour step
        // WHEN checking
        const before = Date.now()
        await get(CHECK, fresh)
        // THEN current_time is the start of the current UTC hour
        const sent = Date.parse(sentContext('check').current_time)
        assert.equal(sent % 3_600_000, 0)
        assert.ok(sent <= Date.now() && sent > before - 3_600_000, sentContext('check').current_time)
      })
    })
  })

  describe('when CLIENT_IP_FROM is not set (socket)', () => {
    it('should send the TCP peer as user_ip', async () => {
      // GIVEN a client connecting from 127.0.0.1
      // WHEN checking
      await get(CHECK)
      // THEN user_ip is the socket's address
      assert.equal(sentContext('check').user_ip, '127.0.0.1')
    })

    it('should ignore X-Forwarded-For', async () => {
      // GIVEN a client that claims another address
      // WHEN checking
      await request(api, CHECK, { headers: { 'x-forwarded-for': '10.20.1.2' } })
      // THEN user_ip is still the socket's address
      assert.equal(sentContext('check').user_ip, '127.0.0.1')
    })
  })

  describe('when CLIENT_IP_FROM is x-forwarded-for', () => {
    let proxied: Api

    before(async () => {
      proxied = await startApi({ ...defaultEnv(), CLIENT_IP_FROM: 'x-forwarded-for' })
    })

    after(async () => {
      await stopApi(proxied)
    })

    const checkWith = (headers: Record<string, string>) => request(proxied, CHECK, { headers })

    it('should send the last entry as user_ip', async () => {
      // GIVEN a header whose first entry the client forged and whose last the proxy added
      // WHEN checking
      await checkWith({ 'x-forwarded-for': '10.20.1.2, 203.0.113.7' })
      // THEN user_ip is the proxy's entry
      assert.equal(sentContext('check').user_ip, '203.0.113.7')
    })

    it('should send an IPv6 address as is', async () => {
      // GIVEN an IPv6 client
      // WHEN checking
      await checkWith({ 'x-forwarded-for': '2001:db8::1' })
      // THEN user_ip is that address
      assert.equal(sentContext('check').user_ip, '2001:db8::1')
    })

    it('should leave user_ip out when the header is missing', async () => {
      // GIVEN no X-Forwarded-For (the TCP peer would be the proxy)
      // WHEN checking
      await checkWith({})
      // THEN only current_time is sent
      assert.deepEqual(Object.keys(sentContext('check')), ['current_time'])
    })

    it('should leave user_ip out when the last entry is not an IP address', async () => {
      // GIVEN a last entry that isn't an address
      // WHEN checking
      await checkWith({ 'x-forwarded-for': '203.0.113.7, unknown' })
      // THEN only current_time is sent
      assert.deepEqual(Object.keys(sentContext('check')), ['current_time'])
    })

    it('should ignore X-Real-IP', async () => {
      // GIVEN only X-Real-IP, which Unikraft's proxy passes through from the client
      // WHEN checking
      await checkWith({ 'x-real-ip': '10.20.1.2' })
      // THEN user_ip is left out
      assert.equal(sentContext('check').user_ip, undefined)
    })
  })
})

// --- GET /health -----------------------------------------------------------

describe('GET /health', () => {
  describe('when OpenFGA is serving', () => {
    it('should report openfga "ok"', async () => {
      // GIVEN a serving stub
      // WHEN asking for health
      const { status, body } = await get('/health')
      // THEN OpenFGA is ok
      assert.equal(status, 200)
      assert.equal(body.status, 'ok')
      assert.equal(body.openfga, 'ok')
    })

    it('should report the OpenFGA host and what it resolves to', async () => {
      // GIVEN FGA_API_URL on 127.0.0.1
      // WHEN asking for health
      const { body } = await get('/health')
      // THEN host and resolution are both 127.0.0.1
      assert.equal(body.openfgaHost, '127.0.0.1')
      assert.equal(body.resolved, '127.0.0.1')
    })

    it('should report the OpenFGA latency and the memory use as numbers', async () => {
      // GIVEN a serving stub
      // WHEN asking for health
      const { body } = await get('/health')
      // THEN the numbers are present
      assert.equal(typeof body.openfgaMs, 'number')
      assert.ok(body.memoryMiB.rss > 0)
      assert.ok(body.memoryMiB.heapUsed > 0)
    })
  })

  describe('when no model is pinned', () => {
    it('should report no model before the first lookup', async () => {
      await withFreshApi({}, async (fresh) => {
        // GIVEN a fresh API that hasn't looked the store up
        // WHEN asking for health
        const { body } = await get('/health', fresh)
        // THEN the model is unknown, and asking didn't trigger a lookup
        assert.deepEqual(body.model, { id: null, pinned: false })
        assert.equal(calls('stores').length, 0)
      })
    })

    it('should report the latest model once looked up', async () => {
      await withFreshApi({}, async (fresh) => {
        // GIVEN a fresh API that has checked a tuple
        await get(CHECK, fresh)
        // WHEN asking for health
        const { body } = await get('/health', fresh)
        // THEN the store's latest model is reported, not pinned
        assert.deepEqual(body.model, { id: MODEL, pinned: false })
      })
    })
  })

  describe('when OpenFGA answers 503', () => {
    it('should still answer 200 and report "HTTP 503"', async () => {
      // GIVEN /healthz answers 503
      stub.hooks.healthz = () => json(503, { status: 'NOT_SERVING' })
      // WHEN asking for health
      const { status, body } = await get('/health')
      // THEN the API is up and reports OpenFGA's status
      assert.equal(status, 200)
      assert.equal(body.openfga, 'HTTP 503')
    })
  })

  describe('when OpenFGA is down', () => {
    it('should still answer 200 and report it unreachable', async () => {
      await withFreshApi({ FGA_API_URL: deadUrl }, async (fresh) => {
        // GIVEN an API pointing at a port nothing listens on
        // WHEN asking for health
        const { status, body } = await get('/health', fresh)
        // THEN OpenFGA is reported unreachable
        assert.equal(status, 200)
        assert.match(body.openfga, /^unreachable: /)
      })
    })
  })

  describe('when OpenFGA takes longer than 2 seconds [slow]', () => {
    it('should report "unreachable: timed out"', async () => {
      // GIVEN /healthz answers after 3 seconds
      stub.hooks.healthz = async () => {
        await sleep(3000)
        return undefined
      }
      // WHEN asking for health
      const { status, body } = await get('/health')
      // THEN the health check gives up after 2 seconds
      assert.equal(status, 200)
      assert.equal(body.openfga, 'unreachable: timed out')
    })
  })

  describe('when the OpenFGA host does not resolve', () => {
    it('should report the resolution error', async () => {
      await withFreshApi({ FGA_API_URL: 'http://x.invalid:8080' }, async (fresh) => {
        // GIVEN a host under the reserved .invalid TLD
        // WHEN asking for health
        const { status, body } = await get('/health', fresh)
        // THEN resolution and reachability report errors, and the API still answers 200
        assert.equal(status, 200)
        assert.equal(body.openfgaHost, 'x.invalid')
        assert.match(body.resolved, /^error: /)
        assert.match(body.openfga, /^unreachable: /)
      })
    })
  })
})

// --- OpenAPI and routing ---------------------------------------------------

describe('GET /openapi.json', () => {
  describe('when requested', () => {
    let doc: any

    before(async () => {
      // GIVEN the running API
      // WHEN fetching the document
      doc = (await get('/openapi.json')).body
    })

    it('should describe every endpoint', () => {
      // THEN every path is listed
      assert.deepEqual(Object.keys(doc.paths).sort(), ['/batch-check', '/bench', '/check', '/health', '/list-objects'])
    })

    it('should document 400 and 502 for the authorization endpoints', () => {
      // THEN each one lists both error responses
      for (const [path, method] of [
        ['/check', 'get'],
        ['/batch-check', 'post'],
        ['/list-objects', 'get'],
      ]) {
        assert.ok(doc.paths[path][method].responses['400'], `${path} 400`)
        assert.ok(doc.paths[path][method].responses['502'], `${path} 502`)
      }
    })

    it('should document 429 for /bench', () => {
      // THEN /bench lists Busy
      assert.ok(doc.paths['/bench'].get.responses['429'])
    })

    it('should document 415 for /batch-check only', () => {
      // THEN the only endpoint with a body is the only one listing UnsupportedMediaType
      const with415 = Object.entries<any>(doc.paths).flatMap(([path, ops]) =>
        Object.entries<any>(ops)
          .filter(([, op]) => op.responses['415'])
          .map(([method]) => `${method} ${path}`),
      )
      assert.deepEqual(with415, ['post /batch-check'])
    })

    it('should document no 400 for /health', () => {
      // THEN /health, which takes no input, lists no BadRequest
      assert.equal(doc.paths['/health'].get.responses['400'], undefined)
    })

    it('should document the per-item error of /batch-check', () => {
      // THEN a result item is either a decision or an error
      const items = doc.paths['/batch-check'].post.responses['200'].content['application/json'].schema.properties.results.items
      assert.deepEqual(
        items.anyOf.map((s: any) => s.required),
        [
          ['correlationId', 'allowed'],
          ['correlationId', 'error'],
        ],
      )
    })
  })
})

describe('GET /docs', () => {
  describe('when requested', () => {
    it('should answer 200 with an HTML page for the API', async () => {
      // GIVEN the running API
      // WHEN fetching the docs page
      const { status, body, contentType } = await get('/docs')
      // THEN it is the rendered reference for this API
      assert.equal(status, 200)
      assert.match(contentType ?? '', /^text\/html/)
      assert.match(body, /<title>demo-fga-api<\/title>/)
    })
  })
})

describe('routing', () => {
  describe('when the path is unknown', () => {
    it('should answer 404', async () => {
      // GIVEN a path the API doesn't serve
      // WHEN requesting it
      const { status } = await get('/nope')
      // THEN the answer is 404
      assert.equal(status, 404)
    })
  })

  describe('when the method is wrong', () => {
    it('should answer 404 for POST /check', async () => {
      // GIVEN /check only takes GET
      // WHEN posting to it
      const { status } = await request(api, CHECK, { method: 'POST' })
      // THEN the router answers 404 (no 405 in Effect's router)
      assert.equal(status, 404)
      assert.equal(calls('check').length, 0)
    })
  })
})

// --- TLS to OpenFGA ----------------------------------------------------------

// The stub served over HTTPS, as OpenFGA is when deployed, with a certificate
// from scripts/tls.sh (valid for 127.0.0.1) signed by a fresh private CA.
describe('TLS to OpenFGA', () => {
  const dirs: string[] = []
  let ownCa = ''
  let otherCa = ''
  let httpsUrl = ''
  const https = { close: () => {} }

  /** Runs scripts/tls.sh into a new temp dir: a CA and its server certificates. */
  const issue = () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-tls-'))
    dirs.push(dir)
    execFileSync(TLS_SCRIPT, ['--out', dir], { stdio: 'ignore' })
    return dir
  }

  before(async () => {
    const signed = issue()
    ownCa = readFileSync(join(signed, 'ca.crt'), 'utf8')
    otherCa = readFileSync(join(issue(), 'ca.crt'), 'utf8')
    const server = createHttpsServer(
      { cert: readFileSync(join(signed, 'openfga.crt')), key: readFileSync(join(signed, 'openfga.key')) },
      handleOpenFga,
    )
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    https.close = () => server.close()
    httpsUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(() => {
    https.close()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  describe('when TLS_CA_PEM is the CA that signed its certificate', () => {
    it('should report openfga "ok" and answer checks', async () => {
      await withFreshApi({ FGA_API_URL: httpsUrl, TLS_CA_PEM: ownCa }, async (fresh) => {
        // GIVEN an API that trusts the stub's CA
        // WHEN asking for health and checking a tuple
        const health = await get('/health', fresh)
        const check = await get(CHECK, fresh)
        // THEN both reach OpenFGA over TLS
        assert.equal(health.body.openfga, 'ok')
        assert.equal(check.status, 200)
        assert.equal(check.body.allowed, true)
      })
    })
  })

  describe('when TLS_CA_PEM is another CA', () => {
    it('should refuse the certificate: health unreachable, checks 502', async () => {
      await withFreshApi({ FGA_API_URL: httpsUrl, TLS_CA_PEM: otherCa }, async (fresh) => {
        // GIVEN an API that trusts an unrelated CA
        // WHEN asking for health and checking a tuple
        const health = await get('/health', fresh)
        const check = await get(CHECK, fresh)
        // THEN the certificate is rejected and no call gets through
        assert.match(health.body.openfga, /^unreachable: .*certificate/)
        assert.equal(check.status, 502)
        assert.equal(calls('check').length, 0)
      })
    })
  })

  describe('when TLS_CA_PEM is not set', () => {
    it('should not trust a private CA', async () => {
      await withFreshApi({ FGA_API_URL: httpsUrl }, async (fresh) => {
        // GIVEN an API that trusts only the system's public CAs
        // WHEN asking for health
        const { body } = await get('/health', fresh)
        // THEN the stub's private certificate is rejected
        assert.match(body.openfga, /^unreachable: .*certificate/)
      })
    })
  })
})

// --- startup and configuration ----------------------------------------------

describe('startup', () => {
  describe('when the configuration is invalid', () => {
    const cases: [string, Env, string][] = [
      ['FGA_KEY is missing', { FGA_KEY: undefined }, 'FGA_KEY'],
      ['FGA_KEY is empty', { FGA_KEY: '' }, 'FGA_KEY'],
      ['PORT is not a number', { PORT: 'abc' }, 'PORT'],
      ['PORT is out of range', { PORT: '70000' }, 'PORT'],
      ['FGA_API_URL is not a URL', { FGA_API_URL: 'not-a-url' }, 'FGA_API_URL'],
      ['TLS_CA_PEM is not a certificate', { TLS_CA_PEM: 'not a certificate' }, 'TLS_CA_PEM'],
      ['FGA_STORE_ID is not a ULID', { FGA_STORE_ID: 'demo-fga' }, 'FGA_STORE_ID'],
      ['FGA_STORE_ID is a lowercase ULID', { FGA_STORE_ID: STORE_1.toLowerCase() }, 'FGA_STORE_ID'],
      ['FGA_STORE_CACHE_TTL is not a duration', { FGA_STORE_CACHE_TTL: 'soon' }, 'FGA_STORE_CACHE_TTL'],
      ['FGA_MODEL_ID is not a ULID', { FGA_MODEL_ID: 'latest' }, 'FGA_MODEL_ID'],
      ['CLIENT_IP_FROM is not a known source', { CLIENT_IP_FROM: 'x-real-ip' }, 'CLIENT_IP_FROM'],
      ['CURRENT_TIME_STEP is not a duration', { CURRENT_TIME_STEP: 'soon' }, 'CURRENT_TIME_STEP'],
      ['CURRENT_TIME_STEP is zero', { CURRENT_TIME_STEP: '0 millis' }, 'CURRENT_TIME_STEP'],
    ]
    for (const [label, env, name] of cases) {
      it(`should exit non-zero naming ${name} when ${label}`, async () => {
        // GIVEN the default config with that one variable broken
        // WHEN starting the API
        const { code, output } = await runUntilExit({ ...defaultEnv(), ...env })
        // THEN it exits with an error that names the variable
        assert.notEqual(code, null, 'the API kept running')
        assert.notEqual(code, 0)
        assert.match(output, new RegExp(name))
      })
    }
  })

  describe('when the API stops at startup', () => {
    it('should log one JSON FATAL line and exit 1 for invalid config', async () => {
      // GIVEN a config the API refuses
      // WHEN starting the API
      const { code, output } = await runUntilExit({ ...defaultEnv(), PORT: 'abc' })
      // THEN it prints a single JSON line naming the cause, and exits 1
      assert.equal(code, 1)
      const lines = output.trim().split('\n')
      assert.equal(lines.length, 1, output)
      const line = JSON.parse(lines[0])
      assert.equal(line.level, 'FATAL')
      assert.match(line.cause, /PORT/)
    })

    it('should log one JSON FATAL line and exit 1 when the port is taken', async () => {
      // GIVEN a port another server listens on
      const taken = createServer()
      await new Promise<void>((r) => taken.listen(0, '0.0.0.0', r))
      try {
        // WHEN starting the API on it
        const { code, output } = await runUntilExit({ ...defaultEnv(), PORT: String((taken.address() as AddressInfo).port) })
        // THEN the listen failure is logged as one JSON FATAL line, and the exit code is 1
        assert.equal(code, 1)
        const fatal = output
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
          .filter((l) => l.level === 'FATAL')
        assert.equal(fatal.length, 1, output)
        assert.match(fatal[0].cause, /EADDRINUSE/)
      } finally {
        taken.close()
      }
    })
  })

  describe('when FGA_API_URL has a path', () => {
    it('should call OpenFGA at the origin only', async () => {
      await withFreshApi({ FGA_API_URL: `${openfgaUrl}/some/prefix` }, async (fresh) => {
        // GIVEN FGA_API_URL with a path
        // WHEN checking
        const { status } = await get(CHECK, fresh)
        // THEN the stub received the calls at the root
        assert.equal(status, 200)
        assert.deepEqual(
          stub.received.map((r) => r.path),
          ['/stores', `/stores/${STORE_1}/authorization-models`, `/stores/${STORE_1}/check`],
        )
      })
    })

    it('should report the origin as the bench target', async () => {
      await withFreshApi({ FGA_API_URL: `${openfgaUrl}/some/prefix` }, async (fresh) => {
        // GIVEN FGA_API_URL with a path
        // WHEN benchmarking
        const { body } = await get('/bench?n=1', fresh)
        // THEN the target is the origin
        assert.equal(body.target, openfgaUrl)
      })
    })
  })

  describe('when FGA_STORE_ID is set', () => {
    it('should use that store without listing stores', async () => {
      await withFreshApi({ FGA_STORE_ID: STORE_2 }, async (fresh) => {
        // GIVEN a pinned store
        // WHEN checking
        const { status } = await get(CHECK, fresh)
        // THEN no GET /stores was made and the check went to the pinned store
        assert.equal(status, 200)
        assert.equal(calls('stores').length, 0)
        assert.equal(calls('check')[0].storeId, STORE_2)
      })
    })

    it('should answer 502 without falling back to the name when the store is gone', async () => {
      await withFreshApi({ FGA_STORE_ID: STORE_2 }, async (fresh) => {
        // GIVEN the pinned store doesn't exist (a demo-fga store does)
        stub.hooks.check = (req) => (req.storeId === STORE_2 ? json(404, { code: 'store_id_not_found', message: 'gone' }) : undefined)
        // WHEN checking
        const { status, body } = await get(CHECK, fresh)
        // THEN the API answers 502 and never looked a store up by name
        assert.equal(status, 502)
        assert.deepEqual(body, { _tag: 'UpstreamError', message: 'check: store or model not found' })
        assert.equal(calls('stores').length, 0)
      })
    })
  })

  describe('when FGA_MODEL_ID is set', () => {
    const MODEL_2 = '01HX00000000000000000000M2'

    it('should never read the models', async () => {
      await withFreshApi({ FGA_MODEL_ID: MODEL_2 }, async (fresh) => {
        // GIVEN a pinned model
        // WHEN checking, batch-checking and listing
        await get(CHECK, fresh)
        await postBatch({ checks: [item('a')] }, fresh)
        await get('/list-objects?user=user:alice&relation=can_view&type=project', fresh)
        // THEN the store's models were never listed
        assert.equal(calls('models').length, 0)
        assert.equal(calls('stores').length, 1)
      })
    })

    it('should send that model id with every call', async () => {
      await withFreshApi({ FGA_MODEL_ID: MODEL_2 }, async (fresh) => {
        // GIVEN a pinned model (the store's latest is MODEL)
        // WHEN checking, batch-checking and listing
        await get(CHECK, fresh)
        await postBatch({ checks: [item('a')] }, fresh)
        await get('/list-objects?user=user:alice&relation=can_view&type=project', fresh)
        // THEN each call names the pinned model
        assert.deepEqual(
          stub.received.filter((r) => r.method === 'POST').map((r) => [r.route, r.body.authorization_model_id]),
          [
            ['check', MODEL_2],
            ['batchCheck', MODEL_2],
            ['listObjects', MODEL_2],
          ],
        )
      })
    })

    it('should answer 502 without falling back to the latest model when OpenFGA lacks it', async () => {
      await withFreshApi({ FGA_MODEL_ID: MODEL_2 }, async (fresh) => {
        // GIVEN OpenFGA doesn't know the pinned model
        stub.hooks.check = (req) =>
          req.body.authorization_model_id === MODEL_2
            ? json(400, { code: 'authorization_model_not_found', message: `Authorization Model '${MODEL_2}' not found` })
            : undefined
        // WHEN checking
        const { status, body } = await get(CHECK, fresh)
        // THEN the API answers 502 after one fresh lookup, and never used another model
        assert.equal(status, 502)
        assert.deepEqual(body, { _tag: 'UpstreamError', message: 'check: store or model not found' })
        assert.deepEqual(
          calls('check').map((c) => c.body.authorization_model_id),
          [MODEL_2, MODEL_2],
        )
      })
    })

    it('should report the pinned model in /health', async () => {
      await withFreshApi({ FGA_MODEL_ID: MODEL_2 }, async (fresh) => {
        // GIVEN a pinned model
        // WHEN asking for health
        const { body } = await get('/health', fresh)
        // THEN it is reported as pinned, without any lookup
        assert.deepEqual(body.model, { id: MODEL_2, pinned: true })
      })
    })
  })

  describe('when FGA_STORE_NAME is not set', () => {
    it('should look up the store named demo-fga', async () => {
      await withFreshApi({ FGA_STORE_NAME: undefined }, async (fresh) => {
        // GIVEN no FGA_STORE_NAME
        // WHEN checking
        await get(CHECK, fresh)
        // THEN the store list was filtered by demo-fga
        assert.equal(calls('stores')[0].query.get('name'), 'demo-fga')
      })
    })
  })

  describe('when FGA_STORE_NAME is set', () => {
    it('should look up the store with that name', async () => {
      await withFreshApi({ FGA_STORE_NAME: 'unrelated' }, async (fresh) => {
        // GIVEN FGA_STORE_NAME=unrelated
        // WHEN checking
        await get(CHECK, fresh)
        // THEN the check goes to that store
        assert.equal(calls('check')[0].storeId, OTHER)
      })
    })
  })
})

// --- shutdown --------------------------------------------------------------

// Stopping the API means SIGTERM (`docker stop`, `kill`, stopApi). These tests
// use a client that keeps its connection open after each answer (keep-alive),
// as browsers and proxies do; fetch would close it on its own after a few
// seconds, and so hide a shutdown that waits for the client.

/** Stops the API with SIGTERM and returns how long it took to exit, in ms. */
async function timeStop(target: Api): Promise<number> {
  const started = performance.now()
  await stopApi(target)
  return performance.now() - started
}

type KeptAliveRes = { status: number; connection: string | undefined; body: any }

/** A GET sent through `agent`, with the answer's Connection header. */
const getKeptAlive = (target: Api, path: string, agent: Agent) =>
  new Promise<KeptAliveRes>((resolve, reject) => {
    httpGet(target.base + path, { agent }, (res) => {
      let raw = ''
      res.on('data', (chunk) => (raw += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, connection: res.headers.connection, body: JSON.parse(raw) }))
    }).on('error', reject)
  })

describe('shutdown', () => {
  describe('when the API is stopped while idle', () => {
    it('should exit within 1 s of SIGTERM', async () => {
      const agent = new Agent({ keepAlive: true })
      try {
        await withFreshApi({}, async (fresh) => {
          // GIVEN an API that answered a check, its client keeping the connection open
          await getKeptAlive(fresh, CHECK, agent)
          // WHEN it gets SIGTERM
          const ms = await timeStop(fresh)
          // THEN it exits at once
          assert.ok(ms < 1000, `exit took ${Math.round(ms)} ms`)
        })
      } finally {
        agent.destroy()
      }
    })
  })

  describe('when the API is stopped while a request is in flight', () => {
    let res: KeptAliveRes
    let exitMs = 0

    before(async () => {
      resetStub()
      // GIVEN OpenFGA answers checks after 500 ms, and a client that keeps its connection open
      stub.hooks.check = async () => {
        await sleep(500)
        return undefined
      }
      const agent = new Agent({ keepAlive: true })
      try {
        await withFreshApi({}, async (fresh) => {
          const pending = getKeptAlive(fresh, CHECK, agent)
          await until(() => calls('check').length > 0)
          // WHEN it gets SIGTERM before OpenFGA has answered
          exitMs = await timeStop(fresh)
          // A dropped request rejects here, which fails every test below.
          res = await pending
        })
      } finally {
        agent.destroy()
      }
    })

    it('should still answer the request', () => {
      // THEN the client gets OpenFGA's decision
      assert.equal(res.status, 200)
      assert.equal(res.body.allowed, true)
    })

    it('should ask the client to close the connection', () => {
      // THEN the answer says the connection won't take another request
      assert.equal(res.connection, 'close')
    })

    it('should exit within 2 s of SIGTERM, without waiting for the client to close the connection', () => {
      // THEN the API exits right after answering (OpenFGA's 500 ms included;
      // waiting for the client took over 6 s)
      assert.ok(exitMs < 2000, `exit took ${Math.round(exitMs)} ms`)
    })
  })
})

// --- secrets ---------------------------------------------------------------

describe('the OpenFGA key', () => {
  describe('when OpenFGA calls succeed and fail [slow]', () => {
    let logs = ''
    const bodies: string[] = []
    const authorizations = new Set<string>()

    before(async () => {
      resetStub()
      // GIVEN an API that hits a 401, a 503, a timeout and a dropped connection
      await withFreshApi({}, async (fresh) => {
        const failures: Hook[] = [
          () => json(401, { code: 'unauthenticated', message: 'unauthenticated' }),
          () => ({ status: 503, body: '' }),
          async () => {
            await sleep(6000)
            return undefined
          },
          () => DROP,
        ]
        bodies.push(JSON.stringify((await get(CHECK, fresh)).body))
        for (const hook of failures) {
          stub.hooks.check = hook
          bodies.push(JSON.stringify((await get(CHECK, fresh)).body))
        }
        stub.hooks.check = undefined
        bodies.push(JSON.stringify((await postBatch({ checks: [item('a')] }, fresh)).body))
        bodies.push(JSON.stringify((await get('/list-objects?user=user:alice&relation=can_view&type=project', fresh)).body))
        for (const r of stub.received) authorizations.add(`${r.route} ${r.authorization}`)
        logs = fresh.output()
      })
      // AND an API that can't reach OpenFGA at all
      await withFreshApi({ FGA_API_URL: deadUrl }, async (fresh) => {
        bodies.push(JSON.stringify((await get(CHECK, fresh)).body))
        logs += fresh.output()
      })
    })

    it('should be sent as a bearer token on every OpenFGA call', () => {
      // THEN stores, models, check, batch-check and list-objects all carried it
      assert.deepEqual(
        [...authorizations].sort(),
        ['batchCheck', 'check', 'listObjects', 'models', 'stores'].map((route) => `${route} Bearer ${KEY}`),
      )
    })

    it('should write only JSON log lines', () => {
      // THEN every log line parses as JSON
      const lines = logs.trim().split('\n').filter(Boolean)
      assert.ok(lines.length > 0)
      for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), line)
    })

    it('should never appear in the logs', () => {
      // THEN the key is absent from everything the processes printed
      assert.ok(!logs.includes(KEY))
    })

    it('should never appear in response bodies', () => {
      // THEN no answer, successful or failed, contains the key
      assert.ok(bodies.length >= 8)
      for (const body of bodies) assert.ok(!body.includes(KEY), body)
    })
  })
})
