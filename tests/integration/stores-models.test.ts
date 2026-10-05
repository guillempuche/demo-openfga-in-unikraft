// Stores and authorization models: CreateStore, GetStore, ListStores,
// DeleteStore, WriteAuthorizationModel, ReadAuthorizationModel(s), plus store
// isolation and model version pinning across Check, Read, Write and
// assertions. (UpdateStore has no HTTP route and is unimplemented; see
// security.test.ts.)

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { FgaApiValidationError } from '@openfga/sdk'
import { client, demoModel, freshStore, isValidationError, rawApi, rejection } from './helpers.ts'

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/

describe('stores', () => {
  const fga = client()
  const prefix = `it-stores-${Date.now()}`
  const created: string[] = []
  const create = async (suffix: string) => {
    const store = await fga.createStore({ name: `${prefix}-${suffix}` })
    created.push(store.id)
    return store
  }

  after(async () => {
    for (const id of created) await client({ storeId: id }).deleteStore().catch(() => undefined)
  })

  describe('CreateStore', () => {
    describe('when the name is valid', () => {
      it('[rpc:CreateStore] should create a store with a ULID id, the name and a creation time', async () => {
        // GIVEN a valid store name
        const name = `${prefix}-a`
        // WHEN the store is created
        const store = await create('a')
        // THEN it has a ULID id, the name and a creation timestamp
        assert.match(store.id, ULID)
        assert.equal(store.name, name)
        assert.ok(Date.parse(store.created_at))
      })
    })

    describe('when the name is invalid', () => {
      it('[rpc:CreateStore] should reject it with a validation error', async () => {
        // GIVEN a name shorter than the 3 characters OpenFGA requires
        // WHEN the store is created
        const err = await rejection(() => fga.createStore({ name: 'x' }))
        // THEN the server answers 400
        assert.ok(err instanceof FgaApiValidationError, String(err))
        assert.equal(err.statusCode, 400)
      })
    })
  })

  describe('GetStore', () => {
    it('[rpc:GetStore] should return the store by id', async () => {
      // GIVEN an existing store
      const store = await create('get')
      // WHEN it is fetched by id
      const got = await client({ storeId: store.id }).getStore()
      // THEN the id and name match
      assert.equal(got.id, store.id)
      assert.equal(got.name, `${prefix}-get`)
    })
  })

  describe('ListStores', () => {
    describe('when filtering by name', () => {
      it('[rpc:ListStores] should return only the store with that name', async () => {
        // GIVEN two stores with different names
        await create('list-a')
        const b = await create('list-b')
        // WHEN stores are listed by one name
        const res = await fga.listStores({ name: `${prefix}-list-b` } as any)
        // THEN only that store is returned
        assert.deepEqual(res.stores.map((s) => s.id), [b.id])
      })
    })

    describe('when paging one store per page', () => {
      it('[rpc:ListStores] should reach every store through continuation tokens', async () => {
        // GIVEN two stores
        const a = await create('page-a')
        const b = await create('page-b')
        // WHEN every page of size 1 is walked
        const seen = new Set<string>()
        let token: string | undefined
        let pages = 0
        do {
          const page = await fga.listStores({ pageSize: 1, continuationToken: token })
          assert.ok(page.stores.length <= 1)
          page.stores.forEach((s) => seen.add(s.id))
          token = page.continuation_token || undefined
          pages++
        } while (token && pages < 1000)
        // THEN both stores show up, over more than one page
        assert.ok(seen.has(a.id) && seen.has(b.id))
        assert.ok(pages >= 2)
      })
    })
  })

  describe('DeleteStore', () => {
    it('[rpc:DeleteStore] should remove the store from ListStores', async () => {
      // GIVEN an existing store
      const store = await fga.createStore({ name: `${prefix}-del-a` })
      // WHEN it is deleted
      await client({ storeId: store.id }).deleteStore()
      // THEN listing by its name returns nothing
      const listed = await fga.listStores({ name: `${prefix}-del-a` } as any)
      assert.equal(listed.stores.length, 0)
    })

    it('[rpc:DeleteStore] should make GetStore answer 404', async () => {
      // GIVEN an existing store
      const store = await fga.createStore({ name: `${prefix}-del-b` })
      // WHEN it is deleted
      await client({ storeId: store.id }).deleteStore()
      // THEN fetching it fails with 404
      const err = await rejection(() => client({ storeId: store.id }).getStore())
      assert.equal(err.statusCode, 404)
    })
  })
})

describe('authorization models', () => {
  let storeId = ''

  before(async () => {
    storeId = (await client().createStore({ name: `it-models-${Date.now()}` })).id
  })
  after(() => client({ storeId }).deleteStore().catch(() => undefined))

  describe('WriteAuthorizationModel', () => {
    describe('when the model is valid', () => {
      it('[rpc:WriteAuthorizationModel] should store the demo model and return its id', async () => {
        // GIVEN an empty store and the demo model
        // WHEN the model is written
        const { authorization_model_id: id } = await client({ storeId }).writeAuthorizationModel(demoModel())
        // THEN it gets a ULID id
        assert.match(id, ULID)
      })
    })

    describe('when the model is invalid', () => {
      it('[rpc:WriteAuthorizationModel] should reject a relation that points at an unknown type', async () => {
        // GIVEN the demo model with project#owner pointing at a type that doesn't exist
        const bad = demoModel()
        const project = bad.type_definitions.find((t) => t.type === 'project')!
        project.metadata!.relations!.owner.directly_related_user_types = [{ type: 'ghost' }]
        // WHEN it is written
        const err = await rejection(() => client({ storeId }).writeAuthorizationModel(bad))
        // THEN the server rejects it
        assert.ok(err instanceof FgaApiValidationError, String(err))
      })
    })
  })

  describe('ReadAuthorizationModel', () => {
    it('[rpc:ReadAuthorizationModel] should return the model by id with its types and conditions', async () => {
      // GIVEN the demo model written to the store
      const { authorization_model_id: id } = await client({ storeId }).writeAuthorizationModel(demoModel())
      // WHEN it is read by id
      const { authorization_model: model } = await client({ storeId, authorizationModelId: id }).readAuthorizationModel()
      // THEN it has the id, schema 1.2, the demo types and the demo conditions
      assert.equal(model!.id, id)
      assert.equal(model!.schema_version, '1.2')
      assert.deepEqual(
        model!.type_definitions.map((t) => t.type).sort(),
        ['folder', 'list', 'org', 'project', 'task', 'team', 'user'],
      )
      assert.deepEqual(Object.keys(model!.conditions ?? {}).sort(), [
        'from_office_network',
        'in_allowed_regions',
        'non_expired_grant',
        'plan_allows',
      ])
    })
  })

  describe('ReadAuthorizationModels', () => {
    it('[rpc:ReadAuthorizationModels] should list the newest model first', async () => {
      // GIVEN a newly written model on top of earlier ones
      const scoped = client({ storeId })
      await scoped.writeAuthorizationModel(demoModel())
      const newest = (await scoped.writeAuthorizationModel(demoModel())).authorization_model_id
      // WHEN models are listed one per page
      const first = await scoped.readAuthorizationModels({ pageSize: 1 })
      // THEN the first page holds only the newest model
      assert.equal(first.authorization_models.length, 1)
      assert.equal(first.authorization_models[0].id, newest)
    })

    it('[rpc:ReadAuthorizationModels] should page to older models with a continuation token', async () => {
      // GIVEN at least two models in the store, the newest written last
      const scoped = client({ storeId })
      await scoped.writeAuthorizationModel(demoModel())
      const newest = (await scoped.writeAuthorizationModel(demoModel())).authorization_model_id
      const first = await scoped.readAuthorizationModels({ pageSize: 1 })
      assert.ok(first.continuation_token, 'more models remain')
      // WHEN the next page is read
      const next = await scoped.readAuthorizationModels({ pageSize: 1, continuationToken: first.continuation_token })
      // THEN it holds an older model
      assert.notEqual(next.authorization_models[0].id, newest)
    })
  })
})

describe('store isolation', () => {
  let a: Awaited<ReturnType<typeof freshStore>>
  let b: Awaited<ReturnType<typeof freshStore>>
  const tuple = { user: 'user:alice', relation: 'viewer', object: 'project:secret' }

  before(async () => {
    a = await freshStore('iso-a')
    b = await freshStore('iso-b')
    await a.fga.write({ writes: [tuple] })
    await rawApi().writeAssertions(a.storeId, a.modelId, {
      assertions: [{ tuple_key: tuple, expectation: true }],
    })
  })
  after(async () => {
    await a.cleanup()
    await b.cleanup()
  })

  describe('given a tuple and an assertion stored only in store A', () => {
    it('[rpc:Check] should not allow the tuple in store B', async () => {
      // GIVEN user:alice viewer project:secret in store A only
      // WHEN store B is asked
      const res = await b.fga.check(tuple)
      // THEN the tuple doesn't count there
      assert.equal(res.allowed, false)
    })

    it('[rpc:Read] should not return the tuple from store B', async () => {
      // GIVEN user:alice viewer project:secret in store A only
      // WHEN store B is read for that object
      const { tuples } = await b.fga.read({ object: 'project:secret' })
      // THEN nothing comes back
      assert.deepEqual(tuples, [])
    })

    it('[rpc:Check] should reject the model id of store A in store B', async () => {
      // GIVEN store A's model id
      // WHEN store B is checked with it
      const err = await rejection(() => client({ storeId: b.storeId, authorizationModelId: a.modelId }).check(tuple))
      // THEN the model isn't found in store B
      assert.ok(err instanceof FgaApiValidationError, String(err))
      assert.equal(err.apiErrorCode, 'authorization_model_not_found')
    })

    it('[rpc:ReadAssertions] should not return store A assertions for store B model', async () => {
      // GIVEN one assertion for store A's model
      // WHEN store B's model assertions are read
      const res = await b.fga.readAssertions()
      // THEN the list is empty
      assert.deepEqual(res.assertions ?? [], [])
    })

    it('[rpc:ReadAssertions] should reject store A model id in store B', async () => {
      // GIVEN one assertion for store A's model
      // WHEN store B is asked for that model's assertions
      const err = await rejection(() => rawApi().readAssertions(b.storeId, a.modelId))
      // THEN the model isn't found in store B
      assert.equal(err.apiErrorCode, 'authorization_model_not_found', String(err))
    })
  })
})

describe('model versions', () => {
  let storeId = ''
  let v1 = ''
  let v2 = ''
  const publicTuple = { user: 'user:*', relation: 'viewer', object: 'project:handbook' }

  before(async () => {
    storeId = (await client().createStore({ name: `it-versions-${Date.now()}` })).id
    // v1: the demo model without public access (no `user:*` on project#viewer).
    const older = demoModel()
    const viewer = older.type_definitions.find((t) => t.type === 'project')!.metadata!.relations!.viewer
    viewer.directly_related_user_types = viewer.directly_related_user_types!.filter((t: any) => !t.wildcard)
    v1 = (await client({ storeId }).writeAuthorizationModel(older)).authorization_model_id
    v2 = (await client({ storeId }).writeAuthorizationModel(demoModel())).authorization_model_id
    await client({ storeId, authorizationModelId: v2 }).write({ writes: [publicTuple] })
  })
  after(() => client({ storeId }).deleteStore().catch(() => undefined))

  describe('given v1 without public access and v2 (latest) with a public project', () => {
    it('[rpc:Check] should answer with the latest model when no model id is pinned', async () => {
      // GIVEN user:* viewer project:handbook, written under v2
      // WHEN anyone's access is checked without a model id
      const res = await client({ storeId }).check({ user: 'user:zed', relation: 'can_view', object: 'project:handbook' })
      // THEN v2 applies and the project is public
      assert.equal(res.allowed, true)
    })

    it('[rpc:Check] should answer with the pinned older model', async () => {
      // GIVEN user:* viewer project:handbook, written under v2
      // WHEN the same check is pinned to v1
      const res = await client({ storeId, authorizationModelId: v1 }).check({
        user: 'user:zed',
        relation: 'can_view',
        object: 'project:handbook',
      })
      // THEN v1 ignores the wildcard tuple it doesn't allow
      assert.equal(res.allowed, false)
    })

    it('[rpc:Write] should reject, when pinned to v1, a tuple only v2 allows', async () => {
      // GIVEN v1 doesn't allow user:* on project#viewer
      // WHEN a wildcard viewer is written pinned to v1
      const err = await rejection(() =>
        client({ storeId, authorizationModelId: v1 }).write({ writes: [{ ...publicTuple, object: 'project:wiki' }] }),
      )
      // THEN it is rejected as an invalid tuple
      assert.ok(isValidationError(err), String(err))
    })

    it('[rpc:WriteAssertions] should keep assertions per model id', async () => {
      // GIVEN an assertion written for v1 only
      await rawApi().writeAssertions(storeId, v1, {
        assertions: [{ tuple_key: { user: 'user:zed', relation: 'can_view', object: 'project:handbook' }, expectation: false }],
      })
      // WHEN the assertions of both models are read
      const forV1 = await rawApi().readAssertions(storeId, v1)
      const forV2 = await rawApi().readAssertions(storeId, v2)
      // THEN only v1 has it
      assert.equal(forV1.assertions?.length, 1)
      assert.deepEqual(forV2.assertions ?? [], [])
    })
  })
})
