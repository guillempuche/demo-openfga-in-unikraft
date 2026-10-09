// The bundled API (dist/server.mjs) against a real OpenFGA: the compose stack
// in tests/integration (docker compose -f tests/integration/docker-compose.yaml
// up -d --wait). Each run creates its own stores, pins the API to them with
// FGA_STORE_ID and deletes them afterwards; it never touches the demo-fga store.
// Run with: npm run test:integration (builds first; needs `fga` on PATH).
//
// Target: FGA_API_URL / FGA_API_TOKEN, as in tests/integration/helpers.ts
// (default: the compose stack).
//
// The API sends every check a context of its own (current_time, user_ip), so
// the fixtures exercise conditions through it: a client address, a time
// window, and a region the API never sends.

import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CredentialsMethod, OpenFgaClient, type ClientWriteRequest } from '@openfga/sdk'

const BUNDLE = fileURLToPath(new URL('./dist/server.mjs', import.meta.url))
const MANIFEST = fileURLToPath(new URL('../authz/models/fga.mod', import.meta.url))
const OPENFGA_URL = process.env.FGA_API_URL ?? 'https://127.0.0.1:28080'
// Over https the API under test gets the stack's CA as deploy.sh gives it to
// the instance (TLS_CA_PEM); `npm run test:integration` points
// NODE_EXTRA_CA_CERTS at the same file for this test's own SDK client.
const TLS_CA_PEM = OPENFGA_URL.startsWith('https:')
  ? readFileSync(process.env.TLS_CA_FILE ?? fileURLToPath(new URL('../.cache/tls/ca.crt', import.meta.url)), 'utf8')
  : undefined
const OPENFGA_TOKEN = process.env.FGA_API_TOKEN ?? 'integration-key'
// Well-formed ids that no store or model has.
const MISSING_STORE = '01HX0000000000000000000000'
const MISSING_MODEL = '01HX00000000000000000000M9'

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

/** A new store, deleted after the run; with the demo model (and its id) unless `withModel` is false. */
async function createStore(label: string, withModel = true) {
  const { id } = await fgaClient().createStore({ name: `it-api-${label}-${Date.now()}` })
  createdStores.push(id)
  const modelId = withModel ? (await fgaClient(id).writeAuthorizationModel(demoModel())).authorization_model_id : undefined
  return { id, modelId, fga: fgaClient(id) }
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

/**
 * Starts the API pinned to `storeId`; a store name that exists nowhere guards
 * against lookups by name. current_time moves in one-hour steps, so a test
 * that relies on OpenFGA's check cache (keyed on the context) can't straddle
 * a step boundary in practice.
 */
async function startApi(storeId: string, env: Record<string, string> = {}): Promise<Api> {
  const port = await freePort()
  let output = ''
  const proc = spawn(process.execPath, [BUNDLE], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      FGA_API_URL: OPENFGA_URL,
      ...(TLS_CA_PEM ? { TLS_CA_PEM } : {}),
      FGA_KEY: OPENFGA_TOKEN,
      FGA_STORE_ID: storeId,
      FGA_STORE_NAME: `it-api-unused-${Date.now()}`,
      CURRENT_TIME_STEP: '1 hour',
      ...env,
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

async function withApi<T>(storeId: string, env: Record<string, string>, fn: (api: Api) => Promise<T>): Promise<T> {
  const api = await startApi(storeId, env)
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

const check = (api: Api, q: Record<string, string>, headers: Record<string, string> = {}) =>
  request(api, `/check?${new URLSearchParams(q)}`, { headers })
const batchCheck = (api: Api, checks: unknown[]) =>
  request(api, '/batch-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checks }) })

// --- fixtures ----------------------------------------------------------------

const HOUR = 3_600_000
const grantFrom = (start: number, duration: string) => ({
  name: 'non_expired_grant',
  context: { grant_time: new Date(start).toISOString(), grant_duration: duration },
})

// alice owns project:roadmap and bob has nothing. Conditional grants:
// - carol contributes to roadmap only from the office network (user_ip);
// - dan is an acme member only from an allowed region, a parameter the API
//   never sends, so OpenFGA can't decide it;
// - frank's team can view folder:launch for a window around now, and could
//   view folder:archive for an hour three days ago (current_time). The window
//   starts two hours back: current_time is rounded down to the hour.
const STORED: ClientWriteRequest['writes'] = [
  { user: 'user:alice', relation: 'owner', object: 'project:roadmap' },
  {
    user: 'user:carol',
    relation: 'contributor',
    object: 'project:roadmap',
    condition: { name: 'from_office_network', context: { office_cidr: '10.20.0.0/16' } },
  },
  {
    user: 'user:dan',
    relation: 'member',
    object: 'org:acme',
    condition: { name: 'in_allowed_regions', context: { allowed_regions: ['eu'] } },
  },
  { user: 'user:frank', relation: 'member', object: 'team:crew' },
  { user: 'team:crew#member', relation: 'viewer', object: 'folder:launch', condition: grantFrom(Date.now() - 2 * HOUR, '4h') },
  { user: 'team:crew#member', relation: 'viewer', object: 'folder:archive', condition: grantFrom(Date.now() - 72 * HOUR, '1h') },
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
      ['a condition needs a parameter the API never sends', { user: 'user:dan', relation: 'member', object: 'org:acme' }, /missing context parameters '\[region\]'/],
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

  describe('when a grant depends on the client address', () => {
    const carol = { user: 'user:carol', relation: 'can_edit', object: 'project:roadmap' }
    let proxied: Api

    before(async () => {
      proxied = await startApi(store.id, { CLIENT_IP_FROM: 'x-forwarded-for' })
    })

    after(async () => {
      await stopApi(proxied)
    })

    it('should deny it to a client outside the office network', async () => {
      // GIVEN the main API, which sends the TCP peer (127.0.0.1) as user_ip
      // WHEN checking carol's office-only grant
      const { status, body } = await check(api, carol)
      // THEN OpenFGA evaluates the condition and denies it
      assert.equal(status, 200)
      assert.equal(body.allowed, false)
    })

    it('should allow it to a client in the office network', async () => {
      // GIVEN an API behind a proxy that reports carol at an office address
      // WHEN checking her grant
      const { status, body } = await check(proxied, carol, { 'x-forwarded-for': '10.20.1.2' })
      // THEN it is allowed
      assert.equal(status, 200)
      assert.equal(body.allowed, true)
    })

    it('should deny it when only a forged earlier entry is in the office network', async () => {
      // GIVEN a client that prepends an office address to what the proxy added
      // WHEN checking carol's grant
      const { body } = await check(proxied, carol, { 'x-forwarded-for': '10.20.1.2, 198.51.100.7' })
      // THEN only the proxy's entry counts, and it is outside the office
      assert.equal(body.allowed, false)
    })
  })

  describe('when a grant is time-limited', () => {
    it('should allow it inside its window', async () => {
      // GIVEN frank's team can view folder:launch from two hours ago for four hours
      // WHEN checking with the API's current_time
      const { status, body } = await check(api, { user: 'user:frank', relation: 'viewer', object: 'folder:launch' })
      // THEN OpenFGA accepts the timestamp and allows it
      assert.equal(status, 200)
      assert.equal(body.allowed, true)
    })

    it('should deny it after its window', async () => {
      // GIVEN frank's team could view folder:archive for an hour, three days ago
      // WHEN checking with the API's current_time
      const { status, body } = await check(api, { user: 'user:frank', relation: 'viewer', object: 'folder:archive' })
      // THEN it is denied
      assert.equal(status, 200)
      assert.equal(body.allowed, false)
    })
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
      await withApi(empty.id, {}, async (fresh) => {
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
      await withApi(MISSING_STORE, {}, async (fresh) => {
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
      // GIVEN alice can edit roadmap, bob can't, and dan's membership needs a region
      // WHEN checking all three in one batch
      res = await batchCheck(api, [
        { correlationId: 'alice', user: 'user:alice', relation: 'can_edit', object: 'project:roadmap' },
        { correlationId: 'bob', user: 'user:bob', relation: 'can_edit', object: 'project:roadmap' },
        { correlationId: 'dan', user: 'user:dan', relation: 'member', object: 'org:acme' },
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
      // THEN dan's item carries the missing-region error and no decision
      const dan = res.body.results[2]
      assert.equal(dan.correlationId, 'dan')
      assert.equal(dan.allowed, undefined)
      assert.match(dan.error, /missing context parameters '\[region\]'/)
    })

  })

  describe('when items have conditions on the API-provided context', () => {
    it('should decide each one with current_time and user_ip', async () => {
      // GIVEN frank's time-limited grant and carol's office-only grant
      // WHEN checking both in one batch from 127.0.0.1
      const { status, body } = await batchCheck(api, [
        { correlationId: 'frank', user: 'user:frank', relation: 'viewer', object: 'folder:launch' },
        { correlationId: 'carol', user: 'user:carol', relation: 'can_edit', object: 'project:roadmap' },
      ])
      // THEN both get a decision: frank is inside his window, carol is outside the office
      assert.equal(status, 200)
      assert.deepEqual(body.results, [
        { correlationId: 'frank', allowed: true },
        { correlationId: 'carol', allowed: false },
      ])
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

  describe('when grants are time-limited', () => {
    it('should list only the objects inside their window', async () => {
      // GIVEN frank's team can view folder:launch now, and could view folder:archive three days ago
      // WHEN listing the folders he can view, with the API's current_time
      const { status, body } = await request(api, '/list-objects?user=user:frank&relation=viewer&type=folder')
      // THEN only launch is listed
      assert.equal(status, 200)
      assert.deepEqual(body, { objects: ['folder:launch'] })
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

describe('a pinned model (FGA_MODEL_ID) against OpenFGA', () => {
  // A newer model in which project has an owner but no can_edit.
  const OWNER_ONLY = {
    schema_version: '1.1',
    type_definitions: [
      { type: 'user' },
      {
        type: 'project',
        relations: { owner: { this: {} } },
        metadata: { relations: { owner: { directly_related_user_types: [{ type: 'user' }] } } },
      },
    ],
  }
  const aliceEdits = { user: 'user:alice', relation: 'can_edit', object: 'project:roadmap' }

  describe('when a newer model is written after the API started', () => {
    let pinnedStore: Awaited<ReturnType<typeof createStore>>
    let pinned: Api

    before(async () => {
      // GIVEN an API pinned to the demo model of a store where alice owns roadmap
      pinnedStore = await createStore('pinned')
      await pinnedStore.fga.write({ writes: [{ user: 'user:alice', relation: 'owner', object: 'project:roadmap' }] })
      pinned = await startApi(pinnedStore.id, { FGA_MODEL_ID: pinnedStore.modelId! })
      assert.equal((await check(pinned, aliceEdits)).body.allowed, true)
      // AND a newer model without can_edit becomes the store's latest
      await pinnedStore.fga.writeAuthorizationModel(OWNER_ONLY as any)
    })

    after(async () => {
      await stopApi(pinned)
    })

    it('should keep answering with the pinned model', async () => {
      // WHEN checking alice can_edit roadmap again
      const { status, body } = await check(pinned, aliceEdits)
      // THEN the pinned model still defines can_edit and allows it
      assert.equal(status, 200)
      assert.equal(body.allowed, true)
    })

    it('should differ from an API that follows the latest model', async () => {
      await withApi(pinnedStore.id, {}, async (latest) => {
        // WHEN an unpinned API checks the same tuple
        const { status, body } = await check(latest, aliceEdits)
        // THEN the latest model has no can_edit and OpenFGA rejects the check
        assert.equal(status, 400)
        assert.match(body.message, /can_edit/)
      })
    })
  })

  describe('when the pinned model does not exist', () => {
    it('should answer 502 "store or model not found"', async () => {
      await withApi(store.id, { FGA_MODEL_ID: MISSING_MODEL }, async (fresh) => {
        // GIVEN an API pinned to a model id the store doesn't have
        // WHEN checking
        const { status, body } = await check(fresh, aliceEdits)
        // THEN the API answers 502 instead of falling back to the latest model
        assert.equal(status, 502)
        assert.deepEqual(body, { _tag: 'UpstreamError', message: 'check: store or model not found' })
      })
    })
  })
})
