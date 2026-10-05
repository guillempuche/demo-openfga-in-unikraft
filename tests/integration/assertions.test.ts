// Assertions stored with a model: WriteAssertions and ReadAssertions.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { freshStore, rawApi } from './helpers.ts'

let store: Awaited<ReturnType<typeof freshStore>>

before(async () => {
  store = await freshStore('assertions')
})
after(() => store.cleanup())

const assertions = [
  {
    user: 'user:alice',
    relation: 'can_edit',
    object: 'project:roadmap',
    expectation: true,
    contextualTuples: [{ user: 'user:alice', relation: 'owner', object: 'project:roadmap' }],
  },
  {
    user: 'user:remy',
    relation: 'contributor',
    object: 'project:roadmap',
    expectation: false,
    context: { user_ip: '203.0.113.9' },
  },
]

// OpenFgaClient.writeAssertions (SDK 0.9.7) only sends tuple_key and
// expectation: contextual tuples and context are dropped. The raw API keeps
// them, so full assertions go through OpenFgaApi.
const wire = assertions.map((a) => ({
  tuple_key: { user: a.user, relation: a.relation, object: a.object },
  expectation: a.expectation,
  ...(a.contextualTuples ? { contextual_tuples: a.contextualTuples } : {}),
  ...(a.context ? { context: a.context } : {}),
}))

test('[rpc:WriteAssertions] stores assertions, with contextual tuples and context, for a model', async () => {
  await rawApi().writeAssertions(store.storeId, store.modelId, { assertions: wire })
  const { assertions: saved } = await store.fga.readAssertions()
  assert.equal(saved?.length, 2)
})

test('[rpc:WriteAssertions] OpenFgaClient.writeAssertions drops contextual tuples and context (SDK 0.9.7)', async () => {
  const { storeId, modelId, fga, cleanup } = await freshStore('assertions-sdk')
  try {
    await fga.writeAssertions(assertions)
    const { assertions: saved } = await fga.readAssertions()
    const alice = saved!.find((a) => a.tuple_key.user === 'user:alice')!
    assert.deepEqual(alice.contextual_tuples ?? [], [], 'if this fails, the SDK now sends them: drop the rawApi workaround')
    assert.ok(storeId && modelId)
  } finally {
    await cleanup()
  }
})

test('[rpc:ReadAssertions] returns the stored assertions exactly', async () => {
  const res = await store.fga.readAssertions()
  assert.equal(res.authorization_model_id, store.modelId)
  const byUser = Object.fromEntries((res.assertions ?? []).map((a) => [a.tuple_key.user, a]))
  assert.equal(byUser['user:alice'].expectation, true)
  // The server echoes contextual tuples with `condition: null`; compare the keys.
  const ctx = (byUser['user:alice'].contextual_tuples ?? []).map(({ user, relation, object }) => ({ user, relation, object }))
  assert.deepEqual(ctx, [{ user: 'user:alice', relation: 'owner', object: 'project:roadmap' }])
  assert.equal(byUser['user:remy'].expectation, false)
  assert.deepEqual(byUser['user:remy'].context, { user_ip: '203.0.113.9' })
})

test('[rpc:WriteAssertions] replaces the previous set', async () => {
  await rawApi().writeAssertions(store.storeId, store.modelId, { assertions: [wire[0]] })
  const { assertions: saved } = await store.fga.readAssertions()
  assert.deepEqual(saved?.map((a) => a.tuple_key.user), ['user:alice'])
})
