// The bundled API (dist/server.mjs) against a real OpenFGA: the compose stack
// in tests/integration (docker compose -f tests/integration/docker-compose.yaml
// up -d --wait). Each run creates its own stores, pins the API to them with
// FGA_STORE_ID and deletes them afterwards; it never touches the demo-fga store.
// Run with: npm run test:integration (builds first; needs `fga` on PATH).
//
// Target: FGA_API_URL / FGA_API_TOKEN, as in tests/integration/helpers.ts
// (default: the compose stack).

import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CredentialsMethod, OpenFgaClient, type ClientWriteRequest } from '@openfga/sdk'

const BUNDLE = fileURLToPath(new URL('./dist/server.mjs', import.meta.url))
const MANIFEST = fileURLToPath(new URL('../authz/models/fga.mod', import.meta.url))
const OPENFGA_URL = process.env.FGA_API_URL ?? 'http://127.0.0.1:28080'
const OPENFGA_TOKEN = process.env.FGA_API_TOKEN ?? 'integration-key'
// A well-formed store id that no store has.
const MISSING_STORE = '01HX0000000000000000000000'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** SDK client for setting up stores and tuples; no retries. */
const fgaClient = (storeId?: string) =>
  new OpenFgaClient({
    apiUrl: OPENFGA_URL,
    storeId,
    credentials: { method: CredentialsMethod.ApiToken, config: { token: OPENFGA_TOKEN } },
    retryParams: { maxRetry: 0 },
  })

/** The demo model (authz/models), compiled to JSON by the fga CLI, as tests/integration does. */
const demoModel = () =>
  JSON.parse(execFileSync('fga', ['model', 'transform', '--file', MANIFEST, '--output-format', 'json'], { encoding: 'utf8' }))

const createdStores: string[] = []

/** A new store, deleted after the run; with the demo model unless `withModel` is false. */
async function createStore(label: string, withModel = true) {
  const { id } = await fgaClient().createStore({ name: `it-api-${label}-${Date.now()}` })
  createdStores.push(id)
  if (withModel) await fgaClient(id).writeAuthorizationModel(demoModel())
  return { id, fga: fgaClient(id) }
}

// --- the API under test ----------------------------------------------------

type Api = { base: string; proc: ChildProcess }

async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const { port } = s.address() as AddressInfo
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

/** Starts the API pinned to `storeId`; a store name that exists nowhere guards against lookups by name. */
async function startApi(storeId: string): Promise<Api> {
  const port = await freePort()
  let output = ''
  const proc = spawn(process.execPath, [BUNDLE], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      FGA_API_URL: OPENFGA_URL,
      FGA_KEY: OPENFGA_TOKEN,
      FGA_STORE_ID: storeId,
      FGA_STORE_NAME: `it-api-unused-${Date.now()}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout!.on('data', (d) => (output += d))
  proc.stderr!.on('data', (d) => (output += d))
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) break
    try {
      if ((await fetch(`${base}/openapi.json`)).ok) return { base, proc }
    } catch {}
    await sleep(50)
  }
  proc.kill()
  throw new Error(`API didn't start:\n${output}`)
}

async function stopApi(api: Api | undefined) {
  if (!api || api.proc.exitCode !== null) return
  const exited = new Promise((r) => api.proc.once('exit', r))
  api.proc.kill()
  await exited
}

async function withApi<T>(storeId: string, fn: (api: Api) => Promise<T>): Promise<T> {
  const api = await startApi(storeId)
  try {
    return await fn(api)
  } finally {
    await stopApi(api)
  }
}

async function request(api: Api, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(api.base + path, init)
  return { status: res.status, body: await res.json() }
}

const check = (api: Api, q: Record<string, string>) => request(api, `/check?${new URLSearchParams(q)}`)
const batchCheck = (api: Api, checks: unknown[]) =>
  request(api, '/batch-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checks }) })

// --- fixtures ----------------------------------------------------------------

// alice owns project:roadmap, bob has nothing, carol contributes only from the
// office network (a condition that needs the request's user_ip).
const STORED: ClientWriteRequest['writes'] = [
  { user: 'user:alice', relation: 'owner', object: 'project:roadmap' },
  {
    user: 'user:carol',
    relation: 'contributor',
    object: 'project:roadmap',
    condition: { name: 'from_office_network', context: { office_cidr: '10.20.0.0/16' } },
  },
]

let api: Api
let store: Awaited<ReturnType<typeof createStore>>

before(async () => {
  store = await createStore('main')
  await store.fga.write({ writes: STORED })
  api = await startApi(store.id)
})

after(async () => {
  await stopApi(api)
  for (const id of createdStores) await fgaClient(id).deleteStore().catch(() => undefined)
})

describe('GET /check against OpenFGA', () => {
  describe('when a stored tuple grants the relation', () => {
    it('should answer allowed: true', async () => {
      // GIVEN alice owns project:roadmap (owners can edit)
      // WHEN checking alice can_edit project:roadmap
      const { status, body } = await check(api, { user: 'user:alice', relation: 'can_edit', object: 'project:roadmap' })
      // THEN OpenFGA allows it
      assert.equal(status, 200)
      assert.equal(body.allowed, true)
    })
  })

  describe('when no tuple grants the relation', () => {
    it('should answer allowed: false', async () => {
      // GIVEN bob has no tuple on project:roadmap
      // WHEN checking bob can_edit project:roadmap
      const { status, body } = await check(api, { user: 'user:bob', relation: 'can_edit', object: 'project:roadmap' })
      // THEN OpenFGA denies it
      assert.equal(status, 200)
      assert.equal(body.allowed, false)
    })
  })

  describe('when OpenFGA rejects the request', () => {
    const cases: [string, Record<string, string>, RegExp][] = [
      ['the relation is unknown', { user: 'user:alice', relation: 'nope', object: 'project:roadmap' }, /nope/],
      ['the type is unknown', { user: 'user:alice', relation: 'can_edit', object: 'nope:1' }, /nope/],
      ['the user is malformed', { user: 'alice', relation: 'can_edit', object: 'project:roadmap' }, /'user' field/],
      ['a condition is missing its context', { user: 'user:carol', relation: 'can_edit', object: 'project:roadmap' }, /missing context parameters/],
    ]
    for (const [label, tuple, reason] of cases) {
      it(`should answer 400 with OpenFGA's message when ${label}`, async () => {
        // GIVEN a check OpenFGA considers invalid
        // WHEN checking
        const { status, body } = await check(api, tuple)
        // THEN the API answers 400 with OpenFGA's own message
        assert.equal(status, 400)
        assert.equal(body._tag, 'BadRequest')
        assert.match(body.message, /^check: /)
        assert.match(body.message, reason)
      })
    }
  })

  describe('when a tuple was just written', () => {
    const dave = { user: 'user:dave', relation: 'can_edit', object: 'project:roadmap' }
    let cachedAnswer: boolean
    let lowLatency: boolean
    let consistent: boolean

    before(async () => {
      // GIVEN OpenFGA cached "dave can't edit roadmap"
      cachedAnswer = (await check(api, { ...dave, consistency: 'MINIMIZE_LATENCY' })).body.allowed
      // WHEN dave becomes an owner and the API checks right away
      await store.fga.write({ writes: [{ user: 'user:dave', relation: 'owner', object: 'project:roadmap' }] })
      lowLatency = (await check(api, { ...dave, consistency: 'MINIMIZE_LATENCY' })).body.allowed
      consistent = (await check(api, { ...dave, consistency: 'HIGHER_CONSISTENCY' })).body.allowed
    })

    it('should still serve the cached denial with MINIMIZE_LATENCY (the check cache is on)', () => {
      // THEN the low-latency check returns the cached answer
      assert.equal(cachedAnswer, false)
      assert.equal(lowLatency, false)
    })

    it('should see the write with HIGHER_CONSISTENCY', () => {
      // THEN the consistent check bypasses the cache
      assert.equal(consistent, true)
    })
  })

  describe('when a tuple was just deleted', () => {
    it('should see the revocation with HIGHER_CONSISTENCY', async () => {
      // GIVEN erin owned project:wiki and OpenFGA cached "erin can edit wiki"
      const erin = { user: 'user:erin', relation: 'can_edit', object: 'project:wiki' }
      await store.fga.write({ writes: [{ user: 'user:erin', relation: 'owner', object: 'project:wiki' }] })
      assert.equal((await check(api, { ...erin, consistency: 'MINIMIZE_LATENCY' })).body.allowed, true)
      // WHEN the tuple is deleted and the API checks right away
      await store.fga.write({ deletes: [{ user: 'user:erin', relation: 'owner', object: 'project:wiki' }] })
      const { body } = await check(api, { ...erin, consistency: 'HIGHER_CONSISTENCY' })
      // THEN the revocation is seen
      assert.equal(body.allowed, false)
    })
  })

  describe('when the pinned store has no model', () => {
    it('should answer 502 "store or model not found"', async () => {
      // GIVEN a store without an authorization model
      const empty = await createStore('no-model', false)
      await withApi(empty.id, async (fresh) => {
        // WHEN checking
        const { status, body } = await check(fresh, { user: 'user:alice', relation: 'can_edit', object: 'project:roadmap' })
        // THEN the API answers 502
        assert.equal(status, 502)
        assert.deepEqual(body, { _tag: 'UpstreamError', message: 'check: store or model not found' })
      })
    })
  })

  describe('when the pinned store does not exist', () => {
    it('should answer 502', async () => {
      await withApi(MISSING_STORE, async (fresh) => {
        // GIVEN an API pinned to a store id no store has
        // WHEN checking
        const { status, body } = await check(fresh, { user: 'user:alice', relation: 'can_edit', object: 'project:roadmap' })
        // THEN the API answers 502
        assert.equal(status, 502)
        assert.deepEqual(body, { _tag: 'UpstreamError', message: 'check: store or model not found' })
      })
    })
  })
})

describe('POST /batch-check against OpenFGA', () => {
  describe('when the items are valid', () => {
    let res: { status: number; body: any }

    before(async () => {
      // GIVEN alice can edit roadmap, bob can't, and carol's grant needs a context
      // WHEN checking all three in one batch
      res = await batchCheck(api, [
        { correlationId: 'alice', user: 'user:alice', relation: 'can_edit', object: 'project:roadmap' },
        { correlationId: 'bob', user: 'user:bob', relation: 'can_edit', object: 'project:roadmap' },
        { correlationId: 'carol', user: 'user:carol', relation: 'can_edit', object: 'project:roadmap' },
      ])
    })

    it('should answer each decision by correlation id', () => {
      // THEN alice is allowed and bob is denied
      assert.equal(res.status, 200)
      assert.deepEqual(res.body.results.slice(0, 2), [
        { correlationId: 'alice', allowed: true },
        { correlationId: 'bob', allowed: false },
      ])
    })

    it("should report the item OpenFGA couldn't evaluate with its error", () => {
      // THEN carol's item carries the missing-context error and no decision
      const carol = res.body.results[2]
      assert.equal(carol.correlationId, 'carol')
      assert.equal(carol.allowed, undefined)
      assert.match(carol.error, /missing context parameters/)
    })
  })

  describe('when OpenFGA rejects a correlationId', () => {
    it('should answer 400 with its message', async () => {
      // GIVEN a correlationId with a space (OpenFGA allows letters, digits and hyphens)
      // WHEN checking
      const { status, body } = await batchCheck(api, [
        { correlationId: 'not valid', user: 'user:alice', relation: 'can_edit', object: 'project:roadmap' },
      ])
      // THEN the API answers 400 with OpenFGA's message
      assert.equal(status, 400)
      assert.equal(body._tag, 'BadRequest')
      assert.match(body.message, /^batch check: .*correlation/i)
    })
  })
})

describe('GET /list-objects against OpenFGA', () => {
  describe('when the user can reach objects', () => {
    it('should list them', async () => {
      // GIVEN alice owns project:roadmap
      // WHEN listing the projects she can view
      const { status, body } = await request(api, '/list-objects?user=user:alice&relation=can_view&type=project')
      // THEN roadmap is listed
      assert.equal(status, 200)
      assert.ok(body.objects.includes('project:roadmap'), JSON.stringify(body))
    })
  })

  describe('when the user can reach nothing', () => {
    it('should answer an empty list', async () => {
      // GIVEN bob has no tuples
      // WHEN listing the projects he can view
      const { status, body } = await request(api, '/list-objects?user=user:bob&relation=can_view&type=project')
      // THEN the list is empty
      assert.equal(status, 200)
      assert.deepEqual(body, { objects: [] })
    })
  })

  describe('when the type is unknown', () => {
    it("should answer 400 with OpenFGA's message", async () => {
      // GIVEN a type the model doesn't define
      // WHEN listing
      const { status, body } = await request(api, '/list-objects?user=user:alice&relation=can_view&type=nope')
      // THEN the API answers 400
      assert.equal(status, 400)
      assert.match(body.message, /^list objects: .*nope/)
    })
  })
})
