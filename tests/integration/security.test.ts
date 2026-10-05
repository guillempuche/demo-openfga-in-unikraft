// Authentication and transports: preshared key on HTTP and gRPC, health and
// metrics endpoints, and UpdateStore (gRPC only, not implemented by OpenFGA).

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { FgaApiAuthenticationError } from '@openfga/sdk'
import { API_TOKEN, API_URL, GRPC_ADDR, METRICS_URL, client, freshStore, http, rejection } from './helpers.ts'

let store: Awaited<ReturnType<typeof freshStore>>

// File-wide GIVEN: alice owns project:roadmap.
before(async () => {
  store = await freshStore('security')
  await store.fga.write({ writes: [{ user: 'user:alice', relation: 'owner', object: 'project:roadmap' }] })
})
after(() => store.cleanup())

const aliceOwner = { user: 'user:alice', relation: 'owner', object: 'project:roadmap' }

describe('HTTP authentication', () => {
  describe('when no key is sent', () => {
    it('[rpc:ListStores] should answer 401 bearer_token_missing', async () => {
      // GIVEN no Authorization header
      // WHEN stores are listed
      const res = await http('GET', '/stores', undefined, null)
      // THEN the server refuses with bearer_token_missing
      assert.equal(res.status, 401)
      assert.equal(res.body.code, 'bearer_token_missing')
    })
  })

  describe('when a wrong key is sent', () => {
    it('[rpc:Check] should answer 401', async () => {
      // GIVEN a key the server doesn't know
      // WHEN alice's ownership is checked over HTTP
      const res = await http('POST', `/stores/${store.storeId}/check`, { tuple_key: aliceOwner }, 'not-the-key')
      // THEN the server refuses
      assert.equal(res.status, 401)
    })

    it('[rpc:Check] should make the SDK throw an authentication error', async () => {
      // GIVEN an SDK client with a wrong key
      const wrong = client({ storeId: store.storeId, token: 'not-the-key' })
      // WHEN it checks alice's ownership
      const err = await rejection(() => wrong.check(aliceOwner))
      // THEN it throws FgaApiAuthenticationError
      assert.ok(err instanceof FgaApiAuthenticationError, String(err))
    })
  })

  describe('when the right key is sent', () => {
    it('[rpc:Check] should answer the check', async () => {
      // GIVEN the file fixture: alice owns project:roadmap
      // WHEN her ownership is checked with the right key
      const res = await http('POST', `/stores/${store.storeId}/check`, { tuple_key: aliceOwner })
      // THEN it is allowed
      assert.equal(res.status, 200)
      assert.equal(res.body.allowed, true)
    })
  })

  describe('when the health endpoint is called', () => {
    it('should answer SERVING without a key', async () => {
      // GIVEN no Authorization header
      // WHEN /healthz is called
      const res = await fetch(`${API_URL}/healthz`)
      // THEN it answers SERVING
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { status: 'SERVING' })
    })
  })
})

// gRPC needs grpcurl on PATH (CI installs it; see .github/workflows/ci.yml).
function grpcurl(args: string[], token: string | null = API_TOKEN): { ok: boolean; out: string } {
  const auth = token ? ['-H', `authorization: Bearer ${token}`] : []
  try {
    return { ok: true, out: execFileSync('grpcurl', ['-plaintext', ...auth, ...args], { encoding: 'utf8', stdio: 'pipe' }) }
  } catch (err: any) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe('gRPC', () => {
  describe('when listing services through reflection', () => {
    it('should list OpenFGAService with the key', () => {
      // GIVEN the right key
      // WHEN services are listed
      const res = grpcurl([GRPC_ADDR, 'list'])
      // THEN OpenFGAService is listed
      assert.ok(res.ok, res.out)
      assert.match(res.out, /^openfga\.v1\.OpenFGAService$/m)
    })

    it('should refuse reflection without a key', () => {
      // GIVEN no key
      // WHEN services are listed
      const res = grpcurl([GRPC_ADDR, 'list'], null)
      // THEN the call fails with a missing bearer token
      assert.equal(res.ok, false)
      assert.match(res.out, /missing bearer token/)
    })

    it('should refuse reflection with a wrong key', () => {
      // GIVEN a wrong key
      // WHEN services are listed
      const res = grpcurl([GRPC_ADDR, 'list'], 'not-the-key')
      // THEN the call is unauthenticated
      assert.equal(res.ok, false)
      assert.match(res.out, /unauthenticated/)
    })
  })

  describe('when calling RPCs', () => {
    it('[rpc:Check] should answer over gRPC like over HTTP', () => {
      // GIVEN the file fixture: alice owns project:roadmap
      const req = JSON.stringify({ store_id: store.storeId, authorization_model_id: store.modelId, tuple_key: aliceOwner })
      // WHEN her ownership is checked over gRPC
      const res = grpcurl(['-d', req, GRPC_ADDR, 'openfga.v1.OpenFGAService/Check'])
      // THEN it is allowed
      assert.ok(res.ok, res.out)
      assert.equal(JSON.parse(res.out).allowed, true)
    })

    it('[rpc:UpdateStore] should answer Unimplemented (gRPC only, no HTTP route)', () => {
      // GIVEN an existing store
      const req = JSON.stringify({ store_id: store.storeId, name: 'renamed' })
      // WHEN it is renamed over gRPC
      const res = grpcurl(['-d', req, GRPC_ADDR, 'openfga.v1.OpenFGAService/UpdateStore'])
      // THEN OpenFGA answers Unimplemented
      assert.equal(res.ok, false)
      assert.match(res.out, /Code: Unimplemented/)
    })
  })
})

describe('metrics', { skip: !METRICS_URL && 'FGA_METRICS_URL not set' }, () => {
  describe('when Prometheus scrapes without a key', () => {
    it('should count requests per gRPC method and code', async () => {
      // GIVEN earlier Check calls in this file
      // WHEN the metrics endpoint is read without a key
      const res = await fetch(METRICS_URL)
      // THEN it answers with a per-method, per-code counter for Check
      assert.equal(res.status, 200)
      assert.match(
        await res.text(),
        /^grpc_server_handled_total\{grpc_code="OK",grpc_method="Check",grpc_service="openfga\.v1\.OpenFGAService"/m,
      )
    })
  })
})
