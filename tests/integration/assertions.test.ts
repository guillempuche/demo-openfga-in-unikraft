// Assertions stored with a model: WriteAssertions and ReadAssertions.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { FgaApiValidationError } from '@openfga/sdk'
import { client, demoModel, freshStore, rawApi, rejection } from './helpers.ts'

let store: Awaited<ReturnType<typeof freshStore>>

before(async () => {
  store = await freshStore('assertions')
})
after(() => store.cleanup())

const UNKNOWN_MODEL = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

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

describe('WriteAssertions', () => {
  describe('when written through the raw API', () => {
    it('[rpc:WriteAssertions] should store assertions with contextual tuples and context', async () => {
      // GIVEN two full assertions
      // WHEN they are written for the store's model
      await rawApi().writeAssertions(store.storeId, store.modelId, { assertions: wire })
      // THEN both are stored
      const { assertions: saved } = await store.fga.readAssertions()
      assert.equal(saved?.length, 2)
    })

    it('[rpc:WriteAssertions] should replace the previous set', async () => {
      // GIVEN two stored assertions
      await rawApi().writeAssertions(store.storeId, store.modelId, { assertions: wire })
      // WHEN a set with only alice's is written
      await rawApi().writeAssertions(store.storeId, store.modelId, { assertions: [wire[0]] })
      // THEN only alice's remains
      const { assertions: saved } = await store.fga.readAssertions()
      assert.deepEqual(saved?.map((a) => a.tuple_key.user), ['user:alice'])
    })
  })

  describe('when written through OpenFgaClient', () => {
    it('[rpc:WriteAssertions] should drop contextual tuples and context (SDK 0.9.7)', async () => {
      // GIVEN a fresh store and assertions with contextual tuples
      const { fga, cleanup } = await freshStore('assertions-sdk')
      try {
        // WHEN they are written with OpenFgaClient.writeAssertions
        await fga.writeAssertions(assertions)
        // THEN the stored assertion has no contextual tuples
        const { assertions: saved } = await fga.readAssertions()
        const alice = saved!.find((a) => a.tuple_key.user === 'user:alice')!
        assert.deepEqual(alice.contextual_tuples ?? [], [], 'if this fails, the SDK now sends them: drop the rawApi workaround')
      } finally {
        await cleanup()
      }
    })
  })

  describe('when the model id is unknown', () => {
    it('[rpc:WriteAssertions] should reject the write with authorization_model_not_found', async () => {
      // GIVEN a model id that doesn't exist in the store
      // WHEN assertions are written for it
      const err = await rejection(() => rawApi().writeAssertions(store.storeId, UNKNOWN_MODEL, { assertions: wire }))
      // THEN the model isn't found
      assert.ok(err instanceof FgaApiValidationError, String(err))
      assert.equal(err.apiErrorCode, 'authorization_model_not_found')
    })
  })
})

describe('ReadAssertions', () => {
  describe('given two stored assertions with contextual tuples and context', () => {
    before(() => rawApi().writeAssertions(store.storeId, store.modelId, { assertions: wire }))
    const read = async () => {
      const res = await store.fga.readAssertions()
      return { res, byUser: Object.fromEntries((res.assertions ?? []).map((a) => [a.tuple_key.user, a])) }
    }

    it('[rpc:ReadAssertions] should return the model id they belong to', async () => {
      // GIVEN the stored assertions
      // WHEN they are read
      const { res } = await read()
      // THEN the response names the store's model
      assert.equal(res.authorization_model_id, store.modelId)
    })

    it('[rpc:ReadAssertions] should return each expectation', async () => {
      // GIVEN alice's assertion expects true and remy's false
      // WHEN they are read
      const { byUser } = await read()
      // THEN the expectations are kept
      assert.equal(byUser['user:alice'].expectation, true)
      assert.equal(byUser['user:remy'].expectation, false)
    })

    it('[rpc:ReadAssertions] should return the contextual tuples', async () => {
      // GIVEN alice's assertion carries one contextual tuple
      // WHEN they are read
      const { byUser } = await read()
      // THEN the tuple comes back (the server echoes it with `condition: null`; compare the keys)
      const ctx = (byUser['user:alice'].contextual_tuples ?? []).map(({ user, relation, object }) => ({ user, relation, object }))
      assert.deepEqual(ctx, [{ user: 'user:alice', relation: 'owner', object: 'project:roadmap' }])
    })

    it('[rpc:ReadAssertions] should return the context', async () => {
      // GIVEN remy's assertion carries a user_ip context
      // WHEN they are read
      const { byUser } = await read()
      // THEN the context comes back
      assert.deepEqual(byUser['user:remy'].context, { user_ip: '203.0.113.9' })
    })
  })

  describe('when the model has no assertions', () => {
    it('[rpc:ReadAssertions] should return an empty list', async () => {
      // GIVEN a second model with no assertions in the store
      const { authorization_model_id: id } = await client({ storeId: store.storeId }).writeAuthorizationModel(demoModel())
      // WHEN its assertions are read
      const res = await rawApi().readAssertions(store.storeId, id)
      // THEN the list is empty
      assert.equal(res.authorization_model_id, id)
      assert.deepEqual(res.assertions ?? [], [])
    })
  })

  describe('when the model id is unknown', () => {
    it('[rpc:ReadAssertions] should reject the read with authorization_model_not_found', async () => {
      // GIVEN a model id that doesn't exist in the store
      // WHEN its assertions are read
      const err = await rejection(() => rawApi().readAssertions(store.storeId, UNKNOWN_MODEL))
      // THEN the model isn't found
      assert.ok(err instanceof FgaApiValidationError, String(err))
      assert.equal(err.apiErrorCode, 'authorization_model_not_found')
    })
  })
})
