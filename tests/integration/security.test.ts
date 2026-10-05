// Authentication and transports: preshared key on HTTP and gRPC, health and
// metrics endpoints, and UpdateStore (gRPC only, not implemented by OpenFGA).

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, test } from 'node:test'
import { FgaApiAuthenticationError } from '@openfga/sdk'
import { API_TOKEN, API_URL, GRPC_ADDR, METRICS_URL, client, freshStore, http, rejection } from './helpers.ts'

let store: Awaited<ReturnType<typeof freshStore>>

before(async () => {
  store = await freshStore('security')
  await store.fga.write({ writes: [{ user: 'user:alice', relation: 'owner', object: 'project:roadmap' }] })
})
after(() => store.cleanup())

describe('HTTP authentication', () => {
  test('[rpc:ListStores] rejects requests without a key (401)', async () => {
    const res = await http('GET', '/stores', undefined, null)
    assert.equal(res.status, 401)
    assert.equal(res.body.code, 'bearer_token_missing')
  })

  test('[rpc:Check] rejects a wrong key (401) and accepts the right one', async () => {
    const body = { tuple_key: { user: 'user:alice', relation: 'owner', object: 'project:roadmap' } }
    const wrong = await http('POST', `/stores/${store.storeId}/check`, body, 'not-the-key')
    assert.equal(wrong.status, 401)
    const sdkErr = await rejection(() =>
      client({ storeId: store.storeId, token: 'not-the-key' }).check({ user: 'user:alice', relation: 'owner', object: 'project:roadmap' }),
    )
    assert.ok(sdkErr instanceof FgaApiAuthenticationError, String(sdkErr))
    const ok = await http('POST', `/stores/${store.storeId}/check`, body)
    assert.equal(ok.status, 200)
    assert.equal(ok.body.allowed, true)
  })

  test('health checks need no key', async () => {
    const res = await fetch(`${API_URL}/healthz`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { status: 'SERVING' })
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
  test('lists services with the key; reflection needs the key too', () => {
    const withKey = grpcurl([GRPC_ADDR, 'list'])
    assert.ok(withKey.ok, withKey.out)
    assert.match(withKey.out, /^openfga\.v1\.OpenFGAService$/m)
    const noKey = grpcurl([GRPC_ADDR, 'list'], null)
    assert.equal(noKey.ok, false)
    assert.match(noKey.out, /missing bearer token/)
    const wrongKey = grpcurl([GRPC_ADDR, 'list'], 'not-the-key')
    assert.equal(wrongKey.ok, false)
    assert.match(wrongKey.out, /unauthenticated/)
  })

  test('[rpc:Check] answers over gRPC like over HTTP', () => {
    const req = JSON.stringify({
      store_id: store.storeId,
      authorization_model_id: store.modelId,
      tuple_key: { user: 'user:alice', relation: 'owner', object: 'project:roadmap' },
    })
    const res = grpcurl(['-d', req, GRPC_ADDR, 'openfga.v1.OpenFGAService/Check'])
    assert.ok(res.ok, res.out)
    assert.equal(JSON.parse(res.out).allowed, true)
  })

  test('[rpc:UpdateStore] is not implemented by OpenFGA (gRPC only, no HTTP route)', () => {
    const req = JSON.stringify({ store_id: store.storeId, name: 'renamed' })
    const res = grpcurl(['-d', req, GRPC_ADDR, 'openfga.v1.OpenFGAService/UpdateStore'])
    assert.equal(res.ok, false)
    assert.match(res.out, /Code: Unimplemented/)
  })
})

describe('metrics', { skip: !METRICS_URL && 'FGA_METRICS_URL not set' }, () => {
  test('Prometheus metrics count requests per gRPC method and code (no key needed)', async () => {
    const res = await fetch(METRICS_URL)
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.match(text, /^grpc_server_handled_total\{grpc_code="OK",grpc_method="Check",grpc_service="openfga\.v1\.OpenFGAService"/m)
  })
})
