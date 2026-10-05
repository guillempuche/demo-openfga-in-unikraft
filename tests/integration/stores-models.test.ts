// Stores and authorization models: CreateStore, GetStore, ListStores,
// DeleteStore, WriteAuthorizationModel, ReadAuthorizationModel(s).
// (UpdateStore has no HTTP route and is unimplemented; see grpc.test.ts.)

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { FgaApiValidationError } from '@openfga/sdk'
import { client, demoModel, rejection } from './helpers.ts'

describe('stores', () => {
  const fga = client()
  const prefix = `it-stores-${Date.now()}`
  const created: string[] = []

  after(async () => {
    for (const id of created) await client({ storeId: id }).deleteStore().catch(() => undefined)
  })

  test('[rpc:CreateStore] creates a store with an id and timestamps', async () => {
    const store = await fga.createStore({ name: `${prefix}-a` })
    created.push(store.id)
    assert.match(store.id, /^[0-9A-HJKMNP-TV-Z]{26}$/, 'store ids are ULIDs')
    assert.equal(store.name, `${prefix}-a`)
    assert.ok(Date.parse(store.created_at))
  })

  test('[rpc:CreateStore] rejects an invalid name', async () => {
    const err = await rejection(() => fga.createStore({ name: 'x' }))
    assert.ok(err instanceof FgaApiValidationError, String(err))
    assert.equal(err.statusCode, 400)
  })

  test('[rpc:GetStore] returns the store', async () => {
    const id = created[0]
    const store = await client({ storeId: id }).getStore()
    assert.equal(store.id, id)
    assert.equal(store.name, `${prefix}-a`)
  })

  test('[rpc:ListStores] filters by name and paginates with continuation tokens', async () => {
    const second = await fga.createStore({ name: `${prefix}-b` })
    created.push(second.id)

    const byName = await fga.listStores({ name: `${prefix}-b` } as any)
    assert.deepEqual(byName.stores.map((s) => s.id), [second.id])

    // Walk all stores one per page and make sure both of ours show up.
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
    assert.ok(seen.has(created[0]) && seen.has(second.id))
    assert.ok(pages >= 2)
  })

  test('[rpc:DeleteStore] deletes; the store is gone from lists and GetStore fails', async () => {
    const store = await fga.createStore({ name: `${prefix}-c` })
    await client({ storeId: store.id }).deleteStore()
    const listed = await fga.listStores({ name: `${prefix}-c` } as any)
    assert.equal(listed.stores.length, 0)
    const err = await rejection(() => client({ storeId: store.id }).getStore())
    assert.equal(err.statusCode, 404)
  })
})

describe('authorization models', () => {
  let storeId = ''

  before(async () => {
    storeId = (await client().createStore({ name: `it-models-${Date.now()}` })).id
  })
  after(() => client({ storeId }).deleteStore().catch(() => undefined))

  test('[rpc:WriteAuthorizationModel] writes the demo model and returns its id', async () => {
    const { authorization_model_id: id } = await client({ storeId }).writeAuthorizationModel(demoModel())
    assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  test('[rpc:WriteAuthorizationModel] rejects an invalid model', async () => {
    const bad = demoModel()
    // Point a relation at a type that doesn't exist.
    const project = bad.type_definitions.find((t) => t.type === 'project')!
    project.metadata!.relations!.owner.directly_related_user_types = [{ type: 'ghost' }]
    const err = await rejection(() => client({ storeId }).writeAuthorizationModel(bad))
    assert.ok(err instanceof FgaApiValidationError, String(err))
  })

  test('[rpc:ReadAuthorizationModel] reads a model back by id', async () => {
    const scoped = client({ storeId })
    const { authorization_model_id: id } = await scoped.writeAuthorizationModel(demoModel())
    const { authorization_model: model } = await client({ storeId, authorizationModelId: id }).readAuthorizationModel()
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

  test('[rpc:ReadAuthorizationModels] lists models newest first, one per page', async () => {
    const scoped = client({ storeId })
    const newest = (await scoped.writeAuthorizationModel(demoModel())).authorization_model_id
    const first = await scoped.readAuthorizationModels({ pageSize: 1 })
    assert.equal(first.authorization_models.length, 1)
    assert.equal(first.authorization_models[0].id, newest)
    assert.ok(first.continuation_token, 'more models remain')
    const next = await scoped.readAuthorizationModels({ pageSize: 1, continuationToken: first.continuation_token })
    assert.notEqual(next.authorization_models[0].id, newest)
  })
})
