// Queries over stored tuples: Check, BatchCheck, Expand, ListObjects,
// StreamedListObjects, ListUsers — with contextual tuples, conditions,
// consistency modes, request limits and regressions for fixed security bugs.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { ConsistencyPreference, FgaApiValidationError } from '@openfga/sdk'
import { client, freshStore, rawApi, rejection } from './helpers.ts'

let store: Awaited<ReturnType<typeof freshStore>>

const stored = [
  { user: 'org:acme', relation: 'org', object: 'project:roadmap' },
  { user: 'user:alice', relation: 'owner', object: 'project:roadmap' },
  { user: 'user:alice', relation: 'member', object: 'org:acme' },
  { user: 'user:bob', relation: 'contributor', object: 'project:roadmap' },
  { user: 'user:carol', relation: 'viewer', object: 'project:roadmap' },
  { user: 'user:bea', relation: 'blocked', object: 'project:roadmap' },
  { user: 'user:bea', relation: 'viewer', object: 'project:roadmap' },
  { user: 'user:*', relation: 'viewer', object: 'project:handbook' },
  { user: 'project:roadmap', relation: 'project', object: 'list:backlog' },
  {
    user: 'user:remy',
    relation: 'contributor',
    object: 'project:roadmap',
    condition: { name: 'from_office_network', context: { office_cidr: '10.20.0.0/16' } },
  },
]

before(async () => {
  store = await freshStore('queries')
  await store.fga.write({ writes: stored })
})
after(() => store.cleanup())

describe('Check', () => {
  test('[rpc:Check] answers from stored tuples, through inheritance and exclusion', async () => {
    const check = (user: string, relation: string, object: string) =>
      store.fga.check({ user, relation, object }).then((r) => r.allowed)
    assert.equal(await check('user:alice', 'can_share', 'project:roadmap'), true)
    assert.equal(await check('user:bob', 'can_edit', 'list:backlog'), true)
    assert.equal(await check('user:carol', 'can_edit', 'project:roadmap'), false)
    assert.equal(await check('user:bea', 'can_view', 'project:roadmap'), false, 'blocked wins')
    assert.equal(await check('user:anyone', 'can_view', 'project:handbook'), true, 'public')
  })

  test('[rpc:Check] uses contextual tuples without storing them', async () => {
    const res = await store.fga.check({
      user: 'user:dave',
      relation: 'can_view',
      object: 'project:roadmap',
      contextualTuples: [{ user: 'user:dave', relation: 'viewer', object: 'project:roadmap' }],
    })
    assert.equal(res.allowed, true)
    const stored = await store.fga.check({ user: 'user:dave', relation: 'can_view', object: 'project:roadmap' })
    assert.equal(stored.allowed, false)
  })

  test('[rpc:Check] evaluates conditions with request context, also with the check cache on (regression, v1.13.1)', async () => {
    const remy = (ip: string) =>
      store.fga
        .check({ user: 'user:remy', relation: 'can_edit', object: 'project:roadmap', context: { user_ip: ip } })
        .then((r) => r.allowed)
    // Same tuple, different context: a cached answer must not leak across contexts.
    assert.equal(await remy('10.20.1.1'), true)
    assert.equal(await remy('203.0.113.9'), false)
    assert.equal(await remy('10.20.1.1'), true)
  })

  test('[rpc:Check] fails when a condition is missing its context', async () => {
    const err = await rejection(() => store.fga.check({ user: 'user:remy', relation: 'can_edit', object: 'project:roadmap' }))
    assert.ok(err instanceof FgaApiValidationError, String(err))
    assert.match(err.apiErrorMessage ?? '', /missing|context|parameter/i)
  })

  test('[rpc:Check] HIGHER_CONSISTENCY sees a write immediately', async () => {
    const ask = (consistency: ConsistencyPreference) =>
      store.fga
        .check({ user: 'user:late', relation: 'viewer', object: 'project:consistency' }, { consistency })
        .then((r) => r.allowed)
    assert.equal(await ask(ConsistencyPreference.MinimizeLatency), false) // warms the cache
    await store.fga.write({ writes: [{ user: 'user:late', relation: 'viewer', object: 'project:consistency' }] })
    assert.equal(await ask(ConsistencyPreference.HigherConsistency), true)
  })

  test('[rpc:Check] pins a model id; an unknown id is rejected', async () => {
    const pinned = client({ storeId: store.storeId, authorizationModelId: store.modelId })
    assert.equal((await pinned.check({ user: 'user:alice', relation: 'owner', object: 'project:roadmap' })).allowed, true)
    const err = await rejection(() =>
      client({ storeId: store.storeId, authorizationModelId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }).check({
        user: 'user:alice',
        relation: 'owner',
        object: 'project:roadmap',
      }),
    )
    assert.ok(err instanceof FgaApiValidationError, String(err))
  })

  test('[rpc:Check] rejects more than 100 contextual tuples', async () => {
    const contextualTuples = Array.from({ length: 101 }, (_, i) => ({ user: `user:c${i}`, relation: 'viewer', object: 'project:x' }))
    const err = await rejection(() =>
      store.fga.check({ user: 'user:c0', relation: 'viewer', object: 'project:x', contextualTuples }),
    )
    assert.ok(err instanceof FgaApiValidationError, String(err))
  })

  test('[rpc:Check] resolves deep nesting but stops runaway recursion', async () => {
    // folder:f0 <- f1 <- ... <- f60, viewer inherited from the parent folder.
    // Observed on v1.21.0 with a cold cache: 24 levels resolve, 25+ exceed the
    // resolution limit (resolveNodeLimit = 25). Ask the deep one first: once
    // shallower answers are cached, deeper checks can succeed.
    // ListObjects isn't limited the same way and returns every folder.
    const { fga, cleanup } = await freshStore('depth')
    try {
      const chain = Array.from({ length: 60 }, (_, i) => ({ user: `folder:f${i}`, relation: 'parent', object: `folder:f${i + 1}` }))
      await fga.write({ writes: chain })
      await fga.write({ writes: [{ user: 'user:root', relation: 'viewer', object: 'folder:f0' }] })
      const err = await rejection(() => fga.check({ user: 'user:root', relation: 'viewer', object: 'folder:f25' }))
      assert.equal(err.statusCode, 400, String(err))
      assert.equal(err.apiErrorCode, 'authorization_model_resolution_too_complex')
      assert.equal((await fga.check({ user: 'user:root', relation: 'viewer', object: 'folder:f24' })).allowed, true)
      const { objects } = await fga.listObjects({ user: 'user:root', relation: 'viewer', type: 'folder' })
      assert.equal(objects.length, 61)
    } finally {
      await cleanup()
    }
  })
})

describe('BatchCheck', () => {
  test('[rpc:BatchCheck] answers many checks in one call, keyed by correlation id', async () => {
    const res = await store.fga.batchCheck({
      checks: [
        { correlationId: 'a', user: 'user:alice', relation: 'can_edit', object: 'project:roadmap' },
        { correlationId: 'b', user: 'user:carol', relation: 'can_edit', object: 'project:roadmap' },
        // Same tuple twice under different ids (regression, v1.14.0).
        { correlationId: 'c', user: 'user:bob', relation: 'can_edit', object: 'project:roadmap' },
        { correlationId: 'd', user: 'user:bob', relation: 'can_edit', object: 'project:roadmap' },
        {
          correlationId: 'e',
          user: 'user:remy',
          relation: 'can_edit',
          object: 'project:roadmap',
          context: { user_ip: '10.20.0.5' },
        },
      ],
    })
    const byId = Object.fromEntries(res.result.map((r) => [r.correlationId, r.allowed]))
    assert.deepEqual(byId, { a: true, b: false, c: true, d: true, e: true })
  })

  test('[rpc:BatchCheck] rejects duplicate correlation ids and more than 50 checks', async () => {
    const item = (id: string) => ({ correlation_id: id, tuple_key: { user: 'user:alice', relation: 'owner', object: 'project:roadmap' } })
    const dup = await rejection(() =>
      rawApi().batchCheck(store.storeId, { checks: [item('same'), item('same')], authorization_model_id: store.modelId }),
    )
    assert.ok(dup instanceof FgaApiValidationError, String(dup))
    const many = await rejection(() =>
      rawApi().batchCheck(store.storeId, {
        checks: Array.from({ length: 51 }, (_, i) => item(`id${i}`)),
        authorization_model_id: store.modelId,
      }),
    )
    assert.ok(many instanceof FgaApiValidationError, String(many))
  })
})

describe('Expand', () => {
  test('[rpc:Expand] returns the userset tree for a relation', async () => {
    const { tree } = await store.fga.expand({ relation: 'viewer', object: 'project:roadmap' })
    const users = tree?.root?.leaf?.users?.users ?? []
    assert.deepEqual([...users].sort(), ['user:bea', 'user:carol'])
    const member = await store.fga.expand({ relation: 'member', object: 'project:roadmap' })
    assert.ok(member.tree?.root?.union, 'member is a union of owner, contributor and viewer')
    assert.equal(member.tree!.root!.union!.nodes.length, 3)
  })
})

describe('ListObjects', () => {
  test('[rpc:ListObjects] lists objects a user can reach', async () => {
    const { objects } = await store.fga.listObjects({ user: 'user:bob', relation: 'can_edit', type: 'project' })
    assert.deepEqual(objects, ['project:roadmap'])
    const lists = await store.fga.listObjects({ user: 'user:bob', relation: 'can_edit', type: 'list' })
    assert.deepEqual(lists.objects, ['list:backlog'])
  })

  test('[rpc:ListObjects] includes public objects and honours context', async () => {
    const pub = await store.fga.listObjects({ user: 'user:zed', relation: 'can_view', type: 'project' })
    assert.deepEqual(pub.objects, ['project:handbook'])
    const inOffice = await store.fga.listObjects({
      user: 'user:remy',
      relation: 'can_edit',
      type: 'project',
      context: { user_ip: '10.20.9.9' },
    })
    assert.deepEqual(inOffice.objects, ['project:roadmap'])
  })

  test('[rpc:ListObjects] fails when a reachable condition is missing its context', async () => {
    const err = await rejection(() => store.fga.listObjects({ user: 'user:remy', relation: 'can_edit', type: 'project' }))
    assert.ok(err instanceof FgaApiValidationError, String(err))
  })
})

describe('StreamedListObjects', () => {
  test('[rpc:StreamedListObjects] streams the same objects as ListObjects', async () => {
    const streamed: string[] = []
    for await (const item of store.fga.streamedListObjects({ user: 'user:alice', relation: 'can_view', type: 'project' })) {
      streamed.push(item.object)
    }
    const { objects } = await store.fga.listObjects({ user: 'user:alice', relation: 'can_view', type: 'project' })
    assert.deepEqual(streamed.sort(), [...objects].sort())
    assert.deepEqual(streamed, ['project:handbook', 'project:roadmap'])
  })
})

describe('ListUsers', () => {
  test('[rpc:ListUsers] lists users, wildcards and usersets', async () => {
    // remy's grant is conditional, so the request must carry its context.
    const editors = await store.fga.listUsers({
      object: { type: 'project', id: 'roadmap' },
      relation: 'can_edit',
      user_filters: [{ type: 'user' }],
      context: { user_ip: '10.20.0.1' },
    })
    const ids = editors.users.map((u) => u.object?.id).sort()
    assert.deepEqual(ids, ['alice', 'bob', 'remy'])

    const pub = await store.fga.listUsers({
      object: { type: 'project', id: 'handbook' },
      relation: 'viewer',
      user_filters: [{ type: 'user' }],
    })
    assert.deepEqual(pub.users, [{ wildcard: { type: 'user' } }])
  })

  test('[rpc:ListUsers] never returns a blocked user (regression, CVE-2026-61709: wildcard + and + but not)', async () => {
    // A minimal model with exactly the combination from the advisory.
    const { id: storeId } = await client().createStore({ name: `it-cve-${Date.now()}` })
    try {
      const scoped = client({ storeId })
      const { authorization_model_id } = await scoped.writeAuthorizationModel({
        schema_version: '1.1',
        type_definitions: [
          { type: 'user' },
          {
            type: 'doc',
            relations: {
              viewer: { this: {} },
              member: { this: {} },
              blocked: { this: {} },
              can_read: {
                difference: {
                  base: { intersection: { child: [{ computedUserset: { relation: 'viewer' } }, { computedUserset: { relation: 'member' } }] } },
                  subtract: { computedUserset: { relation: 'blocked' } },
                },
              },
            },
            metadata: {
              relations: {
                viewer: { directly_related_user_types: [{ type: 'user', wildcard: {} }] },
                member: { directly_related_user_types: [{ type: 'user' }] },
                blocked: { directly_related_user_types: [{ type: 'user' }] },
              },
            },
          },
        ],
      } as any)
      const fga = client({ storeId, authorizationModelId: authorization_model_id })
      await fga.write({
        writes: [
          { user: 'user:*', relation: 'viewer', object: 'doc:1' },
          { user: 'user:ok', relation: 'member', object: 'doc:1' },
          { user: 'user:bad', relation: 'member', object: 'doc:1' },
          { user: 'user:bad', relation: 'blocked', object: 'doc:1' },
        ],
      })
      const res = await fga.listUsers({ object: { type: 'doc', id: '1' }, relation: 'can_read', user_filters: [{ type: 'user' }] })
      assert.deepEqual(res.users.map((u) => u.object?.id ?? '*'), ['ok'])
      assert.equal((await fga.check({ user: 'user:bad', relation: 'can_read', object: 'doc:1' })).allowed, false)
    } finally {
      await client({ storeId }).deleteStore().catch(() => undefined)
    }
  })

  test('[rpc:ListUsers] fails when a reachable condition is missing its context', async () => {
    const err = await rejection(() =>
      store.fga.listUsers({ object: { type: 'project', id: 'roadmap' }, relation: 'can_edit', user_filters: [{ type: 'user' }] }),
    )
    assert.ok(err instanceof FgaApiValidationError, String(err))
    assert.match(err.apiErrorMessage ?? '', /missing context parameters/)
  })

  test('[rpc:ListUsers] accepts only one user filter', async () => {
    const err = await rejection(() =>
      store.fga.listUsers({
        object: { type: 'project', id: 'roadmap' },
        relation: 'can_edit',
        user_filters: [{ type: 'user' }, { type: 'team', relation: 'member' }],
      }),
    )
    assert.ok(err instanceof FgaApiValidationError, String(err))
  })
})
