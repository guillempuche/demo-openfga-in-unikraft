// Queries over stored tuples: Check, BatchCheck, Expand, ListObjects,
// StreamedListObjects, ListUsers — with contextual tuples, conditions,
// consistency modes, request limits, result truncation and regressions for
// fixed security bugs.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { ConsistencyPreference, FgaApiValidationError } from '@openfga/sdk'
import { API_TOKEN, API_URL, LIST_MAX_RESULTS, client, freshStore, rawApi, rejection } from './helpers.ts'

let store: Awaited<ReturnType<typeof freshStore>>

const office = (cidr: string) => ({ name: 'from_office_network', context: { office_cidr: cidr } })
const HIGHER = { consistency: ConsistencyPreference.HigherConsistency }
const INSIDE = '10.20.1.1'
const OUTSIDE = '203.0.113.9'
const truncation = { skip: !LIST_MAX_RESULTS && 'max results of the target unknown (set FGA_LIST_MAX_RESULTS)' }

// File-wide GIVEN (the "roadmap fixture" in test comments): project:roadmap in
// org:acme, owned by alice (an acme member), bob and remy (from the office
// network only) contribute, carol and bea view, bea is blocked; anyone views
// project:handbook; list:backlog belongs to project:roadmap.
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
  { user: 'user:remy', relation: 'contributor', object: 'project:roadmap', condition: office('10.20.0.0/16') },
]

before(async () => {
  store = await freshStore('queries')
  await store.fga.write({ writes: stored })
})
after(() => store.cleanup())

const check = (user: string, relation: string, object: string, extra: object = {}) =>
  store.fga.check({ user, relation, object, ...extra }).then((r) => r.allowed)

describe('Check', () => {
  describe('when the answer comes from stored tuples', () => {
    it('[rpc:Check] should let an owner who is an org member share the project', async () => {
      // GIVEN the roadmap fixture: alice owns project:roadmap and is an acme member
      // WHEN alice's can_share is checked
      // THEN it is allowed (can_edit and member from org)
      assert.equal(await check('user:alice', 'can_share', 'project:roadmap'), true)
    })

    it('[rpc:Check] should not let a contributor who is not an org member share the project', async () => {
      // GIVEN the roadmap fixture: bob contributes to project:roadmap but isn't an acme member
      // WHEN bob's can_share is checked
      // THEN it is denied
      assert.equal(await check('user:bob', 'can_share', 'project:roadmap'), false)
    })

    it("[rpc:Check] should let a project contributor edit the project's lists", async () => {
      // GIVEN the roadmap fixture: bob contributes, list:backlog belongs to the project
      // WHEN bob's can_edit on the list is checked
      // THEN it is allowed through the project
      assert.equal(await check('user:bob', 'can_edit', 'list:backlog'), true)
    })

    it('[rpc:Check] should not let a viewer edit', async () => {
      // GIVEN the roadmap fixture: carol only views project:roadmap
      // WHEN carol's can_edit is checked
      // THEN it is denied
      assert.equal(await check('user:carol', 'can_edit', 'project:roadmap'), false)
    })

    it('[rpc:Check] should deny viewing to a blocked viewer', async () => {
      // GIVEN the roadmap fixture: bea is a viewer and blocked
      // WHEN bea's can_view is checked
      // THEN the block wins
      assert.equal(await check('user:bea', 'can_view', 'project:roadmap'), false)
    })

    it('[rpc:Check] should let anyone view a public project', async () => {
      // GIVEN the roadmap fixture: user:* views project:handbook
      // WHEN an unknown user's can_view is checked
      // THEN it is allowed
      assert.equal(await check('user:anyone', 'can_view', 'project:handbook'), true)
    })
  })

  describe('when contextual tuples are sent', () => {
    const daveViewer = { user: 'user:dave', relation: 'viewer', object: 'project:roadmap' }

    it('[rpc:Check] should allow through a contextual tuple', async () => {
      // GIVEN dave has no stored grant on project:roadmap
      // WHEN can_view is checked with a contextual viewer tuple for dave
      // THEN it is allowed
      assert.equal(await check('user:dave', 'can_view', 'project:roadmap', { contextualTuples: [daveViewer] }), true)
    })

    it('[rpc:Check] should not store the contextual tuple', async () => {
      // GIVEN a check that sent dave's viewer tuple as a contextual tuple
      await check('user:dave', 'can_view', 'project:roadmap', { contextualTuples: [daveViewer] })
      // WHEN dave is checked again without it
      // THEN it is denied: nothing was stored
      assert.equal(await check('user:dave', 'can_view', 'project:roadmap'), false)
    })

    it('[rpc:Check] should deny a stored viewer when a contextual blocked tuple is sent', async () => {
      // GIVEN the roadmap fixture: carol is a stored viewer of project:roadmap
      // WHEN can_view is checked with a contextual `blocked` tuple for carol
      const allowed = await check('user:carol', 'can_view', 'project:roadmap', {
        contextualTuples: [{ user: 'user:carol', relation: 'blocked', object: 'project:roadmap' }],
      })
      // THEN the contextual block wins over the stored grant
      assert.equal(allowed, false)
    })

    it('[rpc:Check] should let a contributor share once org membership is sent as a contextual tuple', async () => {
      // GIVEN the roadmap fixture: bob contributes, project:roadmap is in org:acme, bob isn't a member
      // WHEN can_share is checked with a contextual `user:bob member org:acme`
      const allowed = await check('user:bob', 'can_share', 'project:roadmap', {
        contextualTuples: [{ user: 'user:bob', relation: 'member', object: 'org:acme' }],
      })
      // THEN the intersection (can_edit and member from org) is satisfied
      assert.equal(allowed, true)
    })

    describe('given a contextual tuple with a condition', () => {
      const kai = { user: 'user:kai', relation: 'contributor', object: 'project:roadmap', condition: office('10.20.0.0/16') }

      it('[rpc:Check] should allow when the request context satisfies the condition', async () => {
        // GIVEN a contextual contributor tuple for kai, valid from 10.20.0.0/16
        // WHEN can_edit is checked from inside the office network
        // THEN it is allowed
        assert.equal(await check('user:kai', 'can_edit', 'project:roadmap', { contextualTuples: [kai], context: { user_ip: INSIDE } }), true)
      })

      it('[rpc:Check] should deny when the request context fails the condition', async () => {
        // GIVEN a contextual contributor tuple for kai, valid from 10.20.0.0/16
        // WHEN can_edit is checked from outside the office network
        // THEN it is denied
        assert.equal(await check('user:kai', 'can_edit', 'project:roadmap', { contextualTuples: [kai], context: { user_ip: OUTSIDE } }), false)
      })
    })

    it('[rpc:Check] should reject more than 100 contextual tuples', async () => {
      // GIVEN 101 contextual tuples
      const contextualTuples = Array.from({ length: 101 }, (_, i) => ({ user: `user:c${i}`, relation: 'viewer', object: 'project:x' }))
      // WHEN they are sent with a check
      const err = await rejection(() => store.fga.check({ user: 'user:c0', relation: 'viewer', object: 'project:x', contextualTuples }))
      // THEN the request fails validation
      assert.ok(err instanceof FgaApiValidationError, String(err))
    })
  })

  describe('when the stored tuple has a condition', () => {
    const remy = (context?: object) => check('user:remy', 'can_edit', 'project:roadmap', context ? { context } : {})

    it('[rpc:Check] should allow when the request context satisfies it', async () => {
      // GIVEN the roadmap fixture: remy contributes from 10.20.0.0/16 only
      // WHEN remy's can_edit is checked from inside
      // THEN it is allowed
      assert.equal(await remy({ user_ip: INSIDE }), true)
    })

    it('[rpc:Check] should deny when the request context fails it', async () => {
      // GIVEN the roadmap fixture: remy contributes from 10.20.0.0/16 only
      // WHEN remy's can_edit is checked from outside
      // THEN it is denied
      assert.equal(await remy({ user_ip: OUTSIDE }), false)
    })

    it('[rpc:Check] should not reuse a cached answer across contexts (regression, v1.13.1)', async () => {
      // GIVEN the check cache is on and remy's grant depends on the IP
      // WHEN the same tuple is checked inside, outside, then inside again
      const answers = [await remy({ user_ip: INSIDE }), await remy({ user_ip: OUTSIDE }), await remy({ user_ip: INSIDE })]
      // THEN each answer follows its own context
      assert.deepEqual(answers, [true, false, true])
    })

    it('[rpc:Check] should fail when the condition is missing its context', async () => {
      // GIVEN the roadmap fixture: remy's grant needs user_ip
      // WHEN remy is checked without context
      const err = await rejection(() => remy())
      // THEN the server answers a validation error naming the missing parameter
      assert.ok(err instanceof FgaApiValidationError, String(err))
      assert.match(err.apiErrorMessage ?? '', /missing context parameters/)
    })

    it("[rpc:Check] should keep the tuple's stored context over the same parameter in the request", async () => {
      // GIVEN the roadmap fixture: remy's tuple stores office_cidr 10.20.0.0/16
      // WHEN the request sends office_cidr 0.0.0.0/0 and an outside IP
      // THEN the stored office_cidr applies and access is denied
      assert.equal(await remy({ user_ip: OUTSIDE, office_cidr: '0.0.0.0/0' }), false)
    })

    it('[rpc:Check] should reject a context value of the wrong type (ipaddress)', async () => {
      // GIVEN the roadmap fixture: remy's condition takes user_ip as an ipaddress
      // WHEN user_ip is "nope"
      const err = await rejection(() => remy({ user_ip: 'nope' }))
      // THEN it is a validation error, not allowed:false
      assert.ok(err instanceof FgaApiValidationError, String(err))
      assert.match(err.apiErrorMessage ?? '', /user_ip/)
    })

    it('[rpc:Check] should reject a context value of the wrong type (timestamp)', async () => {
      // GIVEN a contextual public grant with non_expired_grant (current_time is a timestamp)
      const grant = {
        user: 'user:*',
        relation: 'viewer',
        object: 'project:typed',
        condition: { name: 'non_expired_grant', context: { grant_time: '2026-01-01T00:00:00Z', grant_duration: '1h' } },
      }
      // WHEN current_time is "yesterday"
      const err = await rejection(() =>
        store.fga.check({ user: 'user:x', relation: 'viewer', object: 'project:typed', contextualTuples: [grant], context: { current_time: 'yesterday' } }),
      )
      // THEN it is a validation error, not allowed:false
      assert.ok(err instanceof FgaApiValidationError, String(err))
      assert.match(err.apiErrorMessage ?? '', /current_time/)
    })
  })

  describe('when HIGHER_CONSISTENCY is requested', () => {
    it('[rpc:Check] should see a write made after a cached denial', async () => {
      // GIVEN a denial cached by a MINIMIZE_LATENCY check
      const tuple = { user: 'user:late', relation: 'viewer', object: 'project:consistency' }
      assert.equal((await store.fga.check(tuple, { consistency: ConsistencyPreference.MinimizeLatency })).allowed, false)
      // WHEN the grant is written and checked with HIGHER_CONSISTENCY
      await store.fga.write({ writes: [tuple] })
      // THEN it is allowed
      assert.equal((await store.fga.check(tuple, HIGHER)).allowed, true)
    })

    it('[rpc:Check] should see a revocation made after a cached approval', async () => {
      // GIVEN a stored viewer whose can_view approval is cached
      const tuple = { user: 'user:rev', relation: 'viewer', object: 'project:revoked' }
      await store.fga.write({ writes: [tuple] })
      assert.equal(await check('user:rev', 'can_view', 'project:revoked'), true)
      // WHEN the tuple is deleted and checked with HIGHER_CONSISTENCY
      // (observed: a MINIMIZE_LATENCY check right after can still answer true from the cache)
      await store.fga.write({ deletes: [tuple] })
      // THEN it is denied
      assert.equal((await store.fga.check({ ...tuple, relation: 'can_view' }, HIGHER)).allowed, false)
    })
  })

  describe('when a model id is pinned', () => {
    it('[rpc:Check] should answer with that model', async () => {
      // GIVEN the store's model id
      const pinned = client({ storeId: store.storeId, authorizationModelId: store.modelId })
      // WHEN alice's ownership is checked with it
      // THEN it is allowed
      assert.equal((await pinned.check({ user: 'user:alice', relation: 'owner', object: 'project:roadmap' })).allowed, true)
    })

    it('[rpc:Check] should reject an unknown model id', async () => {
      // GIVEN a model id that doesn't exist
      const pinned = client({ storeId: store.storeId, authorizationModelId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })
      // WHEN a check is pinned to it
      const err = await rejection(() => pinned.check({ user: 'user:alice', relation: 'owner', object: 'project:roadmap' }))
      // THEN it fails validation
      assert.ok(err instanceof FgaApiValidationError, String(err))
    })
  })

  // folder:f0 <- f1 <- ... <- f60, viewer inherited from the parent folder.
  // Observed on v1.21.0 with a cold cache: 24 levels resolve, 25+ exceed the
  // resolution limit (resolveNodeLimit = 25). The deep check must run first:
  // once shallower answers are cached, deeper checks can succeed.
  describe('given a folder chain 60 levels deep', () => {
    let deep: Awaited<ReturnType<typeof freshStore>>
    before(async () => {
      deep = await freshStore('depth')
      const chain = Array.from({ length: 60 }, (_, i) => ({ user: `folder:f${i}`, relation: 'parent', object: `folder:f${i + 1}` }))
      await deep.fga.write({ writes: chain })
      await deep.fga.write({ writes: [{ user: 'user:root', relation: 'viewer', object: 'folder:f0' }] })
    })
    after(() => deep.cleanup())

    it('[rpc:Check] should stop runaway recursion at 25 levels with a cold cache', async () => {
      // GIVEN user:root views folder:f0 and nothing is cached yet
      // WHEN root's viewer on folder:f25 is checked
      const err = await rejection(() => deep.fga.check({ user: 'user:root', relation: 'viewer', object: 'folder:f25' }))
      // THEN the server refuses with authorization_model_resolution_too_complex
      assert.equal(err.statusCode, 400, String(err))
      assert.equal(err.apiErrorCode, 'authorization_model_resolution_too_complex')
    })

    it('[rpc:Check] should resolve 24 levels', async () => {
      // GIVEN user:root views folder:f0
      // WHEN root's viewer on folder:f24 is checked
      // THEN it is allowed
      assert.equal((await deep.fga.check({ user: 'user:root', relation: 'viewer', object: 'folder:f24' })).allowed, true)
    })

    it('[rpc:ListObjects] should list every folder of the chain (no such limit)', async () => {
      // GIVEN user:root views folder:f0
      // WHEN the folders root can view are listed
      const { objects } = await deep.fga.listObjects({ user: 'user:root', relation: 'viewer', type: 'folder' })
      // THEN all 61 come back
      assert.equal(objects.length, 61)
    })
  })
})

describe('BatchCheck', () => {
  const byId = (res: { result: { correlationId: string; allowed: boolean }[] }) =>
    Object.fromEntries(res.result.map((r) => [r.correlationId, r.allowed]))

  describe('when every check can be answered', () => {
    it('[rpc:BatchCheck] should answer each check under its correlation id', async () => {
      // GIVEN the roadmap fixture: alice owns, carol views
      // WHEN both can_edit checks are batched
      const res = await store.fga.batchCheck({
        checks: [
          { correlationId: 'a', user: 'user:alice', relation: 'can_edit', object: 'project:roadmap' },
          { correlationId: 'b', user: 'user:carol', relation: 'can_edit', object: 'project:roadmap' },
        ],
      })
      // THEN each id carries its own answer
      assert.deepEqual(byId(res), { a: true, b: false })
    })

    it('[rpc:BatchCheck] should answer the same tuple under two correlation ids (regression, v1.14.0)', async () => {
      // GIVEN the roadmap fixture: bob contributes
      // WHEN the same check is batched twice under different ids
      const res = await store.fga.batchCheck({
        checks: [
          { correlationId: 'c', user: 'user:bob', relation: 'can_edit', object: 'project:roadmap' },
          { correlationId: 'd', user: 'user:bob', relation: 'can_edit', object: 'project:roadmap' },
        ],
      })
      // THEN both ids are answered
      assert.deepEqual(byId(res), { c: true, d: true })
    })

    it("[rpc:BatchCheck] should evaluate each check's condition with that check's context", async () => {
      // GIVEN the roadmap fixture: remy contributes from 10.20.0.0/16 only
      // WHEN remy is checked inside and outside in one batch
      const res = await store.fga.batchCheck({
        checks: [
          { correlationId: 'in', user: 'user:remy', relation: 'can_edit', object: 'project:roadmap', context: { user_ip: INSIDE } },
          { correlationId: 'out', user: 'user:remy', relation: 'can_edit', object: 'project:roadmap', context: { user_ip: OUTSIDE } },
        ],
      })
      // THEN each check follows its own context
      assert.deepEqual(byId(res), { in: true, out: false })
    })
  })

  describe('when one check fails', () => {
    it('[rpc:BatchCheck] should report the error on that item and answer the others', async () => {
      // GIVEN the roadmap fixture: remy's grant needs user_ip, carol views
      // WHEN remy is checked without context next to carol
      const res = await store.fga.batchCheck({
        checks: [
          { correlationId: 'remy', user: 'user:remy', relation: 'can_edit', object: 'project:roadmap' },
          { correlationId: 'carol', user: 'user:carol', relation: 'can_view', object: 'project:roadmap' },
        ],
      })
      // THEN the call succeeds and carol is answered
      const items = Object.fromEntries(res.result.map((r) => [r.correlationId, r]))
      assert.equal(items.carol.allowed, true)
      assert.equal(items.carol.error, undefined)
      // AND remy's item carries the validation error (and allowed:false)
      assert.equal(items.remy.allowed, false)
      assert.equal(items.remy.error?.input_error, 'validation_error')
      assert.match(items.remy.error?.message ?? '', /missing context parameters/)
    })
  })

  describe('when a check carries contextual tuples', () => {
    it('[rpc:BatchCheck] should apply them to that check only', async () => {
      // GIVEN dave has no stored grant
      const tuple = { user: 'user:dave', relation: 'viewer', object: 'project:roadmap' }
      // WHEN one item sends dave's viewer tuple contextually and another doesn't
      const res = await store.fga.batchCheck({
        checks: [
          { correlationId: 'with', ...tuple, relation: 'can_view', contextualTuples: { tuple_keys: [tuple] } },
          { correlationId: 'without', ...tuple, relation: 'can_view' },
        ],
      })
      // THEN only the item with the tuple is allowed
      assert.deepEqual(byId(res), { with: true, without: false })
    })
  })

  describe('when HIGHER_CONSISTENCY is requested', () => {
    it('[rpc:BatchCheck] should see a write made after a cached denial', async () => {
      // GIVEN a denial cached by a MINIMIZE_LATENCY check
      const tuple = { user: 'user:batch-late', relation: 'viewer', object: 'project:consistency' }
      assert.equal((await store.fga.check(tuple, { consistency: ConsistencyPreference.MinimizeLatency })).allowed, false)
      // WHEN the grant is written and batch-checked with HIGHER_CONSISTENCY
      await store.fga.write({ writes: [tuple] })
      const res = await store.fga.batchCheck({ checks: [{ correlationId: 'x', ...tuple }] }, HIGHER)
      // THEN it is allowed
      assert.deepEqual(byId(res), { x: true })
    })
  })

  describe('when the request breaks the limits', () => {
    const item = (id: string) => ({ correlation_id: id, tuple_key: { user: 'user:alice', relation: 'owner', object: 'project:roadmap' } })

    it('[rpc:BatchCheck] should reject duplicate correlation ids', async () => {
      // GIVEN two checks with the same correlation id (raw API: the SDK refuses them itself)
      // WHEN they are batched
      const err = await rejection(() =>
        rawApi().batchCheck(store.storeId, { checks: [item('same'), item('same')], authorization_model_id: store.modelId }),
      )
      // THEN the request fails validation
      assert.ok(err instanceof FgaApiValidationError, String(err))
    })

    it('[rpc:BatchCheck] should reject more than 50 checks', async () => {
      // GIVEN 51 checks (raw API: the SDK splits them into batches)
      const checks = Array.from({ length: 51 }, (_, i) => item(`id${i}`))
      // WHEN they are batched in one request
      const err = await rejection(() => rawApi().batchCheck(store.storeId, { checks, authorization_model_id: store.modelId }))
      // THEN the request fails validation
      assert.ok(err instanceof FgaApiValidationError, String(err))
    })
  })
})

describe('Expand', () => {
  describe('when the relation is directly assigned', () => {
    it('[rpc:Expand] should list the users of the relation in a leaf', async () => {
      // GIVEN the roadmap fixture: carol and bea are viewers of project:roadmap
      // WHEN project:roadmap#viewer is expanded
      const { tree } = await store.fga.expand({ relation: 'viewer', object: 'project:roadmap' })
      // THEN the leaf holds exactly them
      assert.deepEqual([...(tree?.root?.leaf?.users?.users ?? [])].sort(), ['user:bea', 'user:carol'])
    })
  })

  describe('when the relation is a union of computed relations', () => {
    it('[rpc:Expand] should return a union node with one branch per relation', async () => {
      // GIVEN project#member is owner or contributor or viewer
      // WHEN project:roadmap#member is expanded
      const { tree } = await store.fga.expand({ relation: 'member', object: 'project:roadmap' })
      // THEN the root is a union of 3 nodes
      assert.equal(tree?.root?.union?.nodes.length, 3)
    })
  })

  describe('when the relation uses tuple-to-userset and difference', () => {
    before(() => store.fga.write({ writes: [{ user: 'folder:exp-parent', relation: 'parent', object: 'folder:exp-child' }] }))

    it('[rpc:Expand] should return a difference whose base reaches the project folder', async () => {
      // GIVEN project#can_view is (member or viewer from folder or can_manage) but not (blocked …)
      // WHEN project:roadmap#can_view is expanded
      const { tree } = await store.fga.expand({ relation: 'can_view', object: 'project:roadmap' })
      const diff = tree?.root?.difference
      // THEN the root is a difference with a base and a subtract
      assert.ok(diff?.base && diff.subtract, JSON.stringify(tree))
      // AND the base contains the `viewer from folder` tuple-to-userset leaf
      const ttu = (diff.base.union?.nodes ?? []).map((n) => n.leaf?.tupleToUserset).filter(Boolean)
      assert.ok(
        ttu.some((t) => t!.tupleset === 'project:roadmap#folder'),
        JSON.stringify(diff.base),
      )
    })

    it('[rpc:Expand] should resolve `viewer from parent` to the parent folder viewer userset', async () => {
      // GIVEN folder:exp-parent is the parent of folder:exp-child
      // WHEN folder:exp-child#viewer is expanded
      const { tree } = await store.fga.expand({ relation: 'viewer', object: 'folder:exp-child' })
      // THEN a tuple-to-userset leaf over #parent points at folder:exp-parent#viewer
      const ttu = (tree?.root?.union?.nodes ?? []).map((n) => n.leaf?.tupleToUserset).find((t) => t?.tupleset === 'folder:exp-child#parent')
      assert.ok(ttu, JSON.stringify(tree))
      assert.deepEqual(ttu.computed.map((c) => c.userset), ['folder:exp-parent#viewer'])
    })
  })
})

describe('ListObjects', () => {
  const list = (user: string, relation: string, type: string, extra: object = {}, opts?: object) =>
    store.fga.listObjects({ user, relation, type, ...extra }, opts).then((r) => [...r.objects].sort())

  describe('when the answer comes from stored tuples', () => {
    it('[rpc:ListObjects] should list the projects a contributor can edit', async () => {
      // GIVEN the roadmap fixture: bob contributes to project:roadmap
      // WHEN bob's editable projects are listed
      // THEN project:roadmap is returned
      assert.deepEqual(await list('user:bob', 'can_edit', 'project'), ['project:roadmap'])
    })

    it("[rpc:ListObjects] should list the lists inherited from a contributor's project", async () => {
      // GIVEN the roadmap fixture: list:backlog belongs to project:roadmap
      // WHEN bob's editable lists are listed
      // THEN list:backlog is returned
      assert.deepEqual(await list('user:bob', 'can_edit', 'list'), ['list:backlog'])
    })

    it('[rpc:ListObjects] should include public objects for any user', async () => {
      // GIVEN the roadmap fixture: user:* views project:handbook
      // WHEN an unknown user's viewable projects are listed
      // THEN only project:handbook is returned
      assert.deepEqual(await list('user:zed', 'can_view', 'project'), ['project:handbook'])
    })
  })

  describe('when a reachable tuple has a condition', () => {
    it('[rpc:ListObjects] should include the object when the context satisfies it', async () => {
      // GIVEN the roadmap fixture: remy contributes from 10.20.0.0/16 only
      // WHEN remy's editable projects are listed from inside
      // THEN project:roadmap is returned
      assert.deepEqual(await list('user:remy', 'can_edit', 'project', { context: { user_ip: '10.20.9.9' } }), ['project:roadmap'])
    })

    it('[rpc:ListObjects] should fail when the condition is missing its context', async () => {
      // GIVEN the roadmap fixture: remy's grant needs user_ip
      // WHEN remy's editable projects are listed without context
      const err = await rejection(() => list('user:remy', 'can_edit', 'project'))
      // THEN the request fails validation
      assert.ok(err instanceof FgaApiValidationError, String(err))
    })
  })

  describe('when contextual tuples are sent', () => {
    const contextualTuples = [
      { user: 'user:kai', relation: 'contributor', object: 'project:lo-plain' },
      { user: 'user:kai', relation: 'contributor', object: 'project:lo-office', condition: office('10.20.0.0/16') },
    ]

    it('[rpc:ListObjects] should include objects granted by plain and satisfied conditional contextual tuples', async () => {
      // GIVEN kai has no stored grants; contextual: a plain grant and an office-only grant
      // WHEN kai's editable projects are listed from inside the office
      // THEN both projects are returned
      assert.deepEqual(await list('user:kai', 'can_edit', 'project', { contextualTuples, context: { user_ip: INSIDE } }), [
        'project:lo-office',
        'project:lo-plain',
      ])
    })

    it('[rpc:ListObjects] should exclude the object of a conditional contextual tuple the context fails', async () => {
      // GIVEN the same contextual tuples
      // WHEN kai's editable projects are listed from outside the office
      // THEN only the plain grant counts
      assert.deepEqual(await list('user:kai', 'can_edit', 'project', { contextualTuples, context: { user_ip: OUTSIDE } }), [
        'project:lo-plain',
      ])
    })

    describe('given a project in a folder that is not yet under the folder a user views', () => {
      before(() =>
        store.fga.write({
          writes: [
            { user: 'folder:lo-child', relation: 'folder', object: 'project:lo-nested' },
            { user: 'user:fay', relation: 'viewer', object: 'folder:lo-top' },
          ],
        }),
      )

      it('[rpc:ListObjects] should return the project once a contextual `parent` tuple links the folders', async () => {
        // GIVEN project:lo-nested is in folder:lo-child; fay views folder:lo-top
        // WHEN fay's viewable projects are listed with a contextual `folder:lo-top parent folder:lo-child`
        const objects = await list('user:fay', 'can_view', 'project', {
          contextualTuples: [{ user: 'folder:lo-top', relation: 'parent', object: 'folder:lo-child' }],
        })
        // THEN the project is reached through the folder hierarchy
        assert.ok(objects.includes('project:lo-nested'), JSON.stringify(objects))
      })

      it('[rpc:ListObjects] should not return the project without the contextual `parent` tuple', async () => {
        // GIVEN the folders aren't linked by any stored tuple
        // WHEN fay's viewable projects are listed
        const objects = await list('user:fay', 'can_view', 'project')
        // THEN the nested project isn't returned
        assert.ok(!objects.includes('project:lo-nested'), JSON.stringify(objects))
      })
    })
  })

  describe('when HIGHER_CONSISTENCY is requested', () => {
    it('[rpc:ListObjects] should include an object right after its tuple is written', async () => {
      // GIVEN lou owns no project (owner, not viewer: project:handbook is public)
      const tuple = { user: 'user:lou', relation: 'owner', object: 'project:lo-hc' }
      assert.deepEqual(await list('user:lou', 'owner', 'project', {}, HIGHER), [])
      // WHEN lou's owner tuple is written
      await store.fga.write({ writes: [tuple] })
      // THEN the next HIGHER_CONSISTENCY list includes the project
      assert.deepEqual(await list('user:lou', 'owner', 'project', {}, HIGHER), ['project:lo-hc'])
    })

    it('[rpc:ListObjects] should drop an object right after its tuple is deleted', async () => {
      // GIVEN lia's owner tuple is listed
      const tuple = { user: 'user:lia', relation: 'owner', object: 'project:lo-hc' }
      await store.fga.write({ writes: [tuple] })
      assert.deepEqual(await list('user:lia', 'owner', 'project', {}, HIGHER), ['project:lo-hc'])
      // WHEN the tuple is deleted
      await store.fga.write({ deletes: [tuple] })
      // THEN the next HIGHER_CONSISTENCY list is empty
      assert.deepEqual(await list('user:lia', 'owner', 'project', {}, HIGHER), [])
    })
  })

  // The compose stack sets OPENFGA_LIST_OBJECTS_MAX_RESULTS=100.
  describe('when more objects match than the server returns', truncation, () => {
    before(async () => {
      const grant = (i: number) => ({ user: 'user:many', relation: 'viewer', object: `project:many-${i}` })
      // max + 1 matches, written 100 tuples per request (the Write limit)
      const all = Array.from({ length: LIST_MAX_RESULTS + 1 }, (_, i) => grant(i))
      for (let i = 0; i < all.length; i += 100) await store.fga.write({ writes: all.slice(i, i + 100) })
    })

    it('[rpc:ListObjects] should return exactly max results objects and no error', async () => {
      // GIVEN user:many views max + 1 projects (max: 100 on the compose stack)
      // WHEN many's projects are listed
      const objects = await list('user:many', 'viewer', 'project')
      // THEN the answer is silently truncated to max
      assert.equal(objects.length, LIST_MAX_RESULTS)
    })
  })
})

describe('StreamedListObjects', () => {
  const stream = async (body: Parameters<typeof store.fga.streamedListObjects>[0]) => {
    const out: string[] = []
    for await (const item of store.fga.streamedListObjects(body)) out.push(item.object)
    return out.sort()
  }

  describe('when the answer comes from stored tuples', () => {
    it('[rpc:StreamedListObjects] should stream the same objects as ListObjects', async () => {
      // GIVEN the roadmap fixture: alice owns project:roadmap, project:handbook is public
      // WHEN alice's viewable projects are streamed and listed
      const streamed = await stream({ user: 'user:alice', relation: 'can_view', type: 'project' })
      const { objects } = await store.fga.listObjects({ user: 'user:alice', relation: 'can_view', type: 'project' })
      // THEN both return the same two projects
      assert.deepEqual(streamed, [...objects].sort())
      assert.deepEqual(streamed, ['project:handbook', 'project:roadmap'])
    })
  })

  describe('when context and contextual tuples are sent', () => {
    it('[rpc:StreamedListObjects] should stream the object of a satisfied conditional contextual tuple', async () => {
      // GIVEN kai has no stored grants; contextual: an office-only contributor grant
      // WHEN kai's editable projects are streamed from inside the office
      const streamed = await stream({
        user: 'user:kai',
        relation: 'can_edit',
        type: 'project',
        context: { user_ip: INSIDE },
        contextualTuples: [{ user: 'user:kai', relation: 'contributor', object: 'project:st-office', condition: office('10.20.0.0/16') }],
      })
      // THEN that project is streamed
      assert.deepEqual(streamed, ['project:st-office'])
    })
  })

  describe('when a reachable condition is missing its context', () => {
    const body = { user: 'user:remy', relation: 'can_edit', type: 'project' }

    it('[rpc:StreamedListObjects] should make the SDK throw a validation error', async () => {
      // GIVEN the roadmap fixture: remy's grant needs user_ip
      // WHEN remy's editable projects are streamed without context
      const err = await rejection(() => stream(body))
      // THEN the SDK throws a 400 validation error
      assert.ok(err instanceof FgaApiValidationError, String(err))
      assert.equal(err.statusCode, 400)
      // AND (SDK 0.9.7) the server's message isn't parsed: responseData is the
      // raw, unread response stream. Reading it also closes the connection,
      // which otherwise keeps the test process alive for ~10 s.
      assert.equal(err.apiErrorMessage, undefined)
      let raw = ''
      for await (const chunk of err.responseData) raw += chunk
      assert.match(JSON.parse(raw).error.message, /missing context parameters/)
    })

    it('[rpc:StreamedListObjects] should answer HTTP 400 with the error as a stream message', async () => {
      // GIVEN the roadmap fixture: remy's grant needs user_ip
      // WHEN the stream is requested over raw HTTP without context
      const res = await fetch(`${API_URL}/stores/${store.storeId}/streamed-list-objects`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, authorization_model_id: store.modelId }),
      })
      // THEN the status is 400 and the body is one `{"error": …}` stream message
      // with gRPC code 3 (InvalidArgument) naming the missing parameter
      assert.equal(res.status, 400)
      const msg = JSON.parse((await res.text()).trim())
      assert.equal(msg.error.code, 3)
      assert.match(msg.error.message, /missing context parameters/)
    })
  })
})

describe('ListUsers', () => {
  const users = (res: { users: any[] }) =>
    res.users
      .map((u) => (u.wildcard ? `${u.wildcard.type}:*` : u.userset ? `${u.userset.type}:${u.userset.id}#${u.userset.relation}` : `${u.object.type}:${u.object.id}`))
      .sort()
  const listUsers = (type: string, id: string, relation: string, filter: { type: string; relation?: string }, extra: object = {}, opts?: object) =>
    store.fga.listUsers({ object: { type, id }, relation, user_filters: [filter], ...extra }, opts).then(users)

  describe('when the answer comes from stored tuples', () => {
    it('[rpc:ListUsers] should list direct, inherited and conditional editors', async () => {
      // GIVEN the roadmap fixture: alice owns, bob contributes, remy contributes from the office
      // WHEN project:roadmap editors are listed from inside the office
      // THEN all three are returned
      assert.deepEqual(await listUsers('project', 'roadmap', 'can_edit', { type: 'user' }, { context: { user_ip: '10.20.0.1' } }), [
        'user:alice',
        'user:bob',
        'user:remy',
      ])
    })

    it('[rpc:ListUsers] should return the wildcard for a public project', async () => {
      // GIVEN the roadmap fixture: user:* views project:handbook
      // WHEN its viewers are listed
      // THEN only the wildcard is returned
      assert.deepEqual(await listUsers('project', 'handbook', 'viewer', { type: 'user' }), ['user:*'])
    })

    it('[rpc:ListUsers] should fail when a reachable condition is missing its context', async () => {
      // GIVEN the roadmap fixture: remy's grant needs user_ip
      // WHEN project:roadmap editors are listed without context
      const err = await rejection(() => listUsers('project', 'roadmap', 'can_edit', { type: 'user' }))
      // THEN the request fails validation naming the missing parameters
      assert.ok(err instanceof FgaApiValidationError, String(err))
      assert.match(err.apiErrorMessage ?? '', /missing context parameters/)
    })

    it('[rpc:ListUsers] should accept only one user filter', async () => {
      // GIVEN two user filters
      // WHEN they are sent together
      const err = await rejection(() =>
        store.fga.listUsers({
          object: { type: 'project', id: 'roadmap' },
          relation: 'can_edit',
          user_filters: [{ type: 'user' }, { type: 'team', relation: 'member' }],
        }),
      )
      // THEN the request fails validation
      assert.ok(err instanceof FgaApiValidationError, String(err))
    })
  })

  describe('given a public project with a blocked user', () => {
    before(() =>
      store.fga.write({
        writes: [
          { user: 'user:*', relation: 'viewer', object: 'project:lu-open' },
          { user: 'user:bo', relation: 'blocked', object: 'project:lu-open' },
        ],
      }),
    )

    // The wildcard can't express "everyone except bo": callers that expand
    // `user:*` must still Check each user.
    it('[rpc:ListUsers] should return only the wildcard, without naming the exception', async () => {
      // GIVEN user:* views project:lu-open and user:bo is blocked on it
      // WHEN its can_view users are listed
      // THEN the answer is just the wildcard
      assert.deepEqual(await listUsers('project', 'lu-open', 'can_view', { type: 'user' }), ['user:*'])
    })

    it('[rpc:Check] should deny the blocked user the wildcard covers', async () => {
      // GIVEN user:* views project:lu-open and user:bo is blocked on it
      // WHEN bo's can_view is checked
      // THEN it is denied
      assert.equal(await check('user:bo', 'can_view', 'project:lu-open'), false)
    })
  })

  describe('given a model with a wildcard, an intersection and an exclusion', () => {
    it('[rpc:ListUsers] should never return a blocked user (regression, CVE-2026-61709: wildcard + and + but not)', async () => {
      // GIVEN a minimal model with exactly the advisory's combination, a public
      // doc, two members, one of them blocked
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
        // WHEN the users who can read the doc are listed
        const res = await fga.listUsers({ object: { type: 'doc', id: '1' }, relation: 'can_read', user_filters: [{ type: 'user' }] })
        // THEN only the unblocked member is returned
        assert.deepEqual(users(res), ['user:ok'])
        // AND Check agrees for the blocked one
        assert.equal((await fga.check({ user: 'user:bad', relation: 'can_read', object: 'doc:1' })).allowed, false)
      } finally {
        await client({ storeId }).deleteStore().catch(() => undefined)
      }
    })
  })

  describe('when contextual tuples are sent', () => {
    const contextualTuples = [
      { user: 'user:lee', relation: 'contributor', object: 'project:lu-ctx' },
      { user: 'user:kai', relation: 'contributor', object: 'project:lu-ctx', condition: office('10.20.0.0/16') },
    ]

    it('[rpc:ListUsers] should include users of plain and satisfied conditional contextual tuples', async () => {
      // GIVEN no stored grants on project:lu-ctx; contextual: lee (plain) and kai (office only)
      // WHEN its editors are listed from inside the office
      // THEN both are returned
      assert.deepEqual(
        await listUsers('project', 'lu-ctx', 'can_edit', { type: 'user' }, { contextualTuples, context: { user_ip: INSIDE } }),
        ['user:kai', 'user:lee'],
      )
    })

    it('[rpc:ListUsers] should exclude the user of a conditional contextual tuple the context fails', async () => {
      // GIVEN the same contextual tuples
      // WHEN its editors are listed from outside the office
      // THEN only lee is returned
      assert.deepEqual(
        await listUsers('project', 'lu-ctx', 'can_edit', { type: 'user' }, { contextualTuples, context: { user_ip: OUTSIDE } }),
        ['user:lee'],
      )
    })
  })

  describe('when HIGHER_CONSISTENCY is requested', () => {
    it('[rpc:ListUsers] should include a user right after the tuple is written', async () => {
      // GIVEN project:lu-hc has no viewers
      assert.deepEqual(await listUsers('project', 'lu-hc', 'viewer', { type: 'user' }, {}, HIGHER), [])
      // WHEN a viewer tuple is written
      await store.fga.write({ writes: [{ user: 'user:hal', relation: 'viewer', object: 'project:lu-hc' }] })
      // THEN the next HIGHER_CONSISTENCY list includes the user
      assert.deepEqual(await listUsers('project', 'lu-hc', 'viewer', { type: 'user' }, {}, HIGHER), ['user:hal'])
    })

    it('[rpc:ListUsers] should drop a user right after the tuple is deleted', async () => {
      // GIVEN a listed viewer of project:lu-hc-del
      const tuple = { user: 'user:hob', relation: 'viewer', object: 'project:lu-hc-del' }
      await store.fga.write({ writes: [tuple] })
      assert.deepEqual(await listUsers('project', 'lu-hc-del', 'viewer', { type: 'user' }, {}, HIGHER), ['user:hob'])
      // WHEN the tuple is deleted
      await store.fga.write({ deletes: [tuple] })
      // THEN the next HIGHER_CONSISTENCY list is empty
      assert.deepEqual(await listUsers('project', 'lu-hc-del', 'viewer', { type: 'user' }, {}, HIGHER), [])
    })
  })

  // folder:lu-child's viewers include `viewer from parent`; the parent grants
  // team:eng#member a temporary view (non_expired_grant, 1h from grant_time).
  // Both request times are after grant_time, so they hold with or without a
  // `current_time >= grant_time` start bound.
  describe('given a conditional team grant inherited from a parent folder', () => {
    const LIVE = { current_time: '2026-01-01T00:30:00Z' }
    const EXPIRED = { current_time: '2026-01-01T02:00:00Z' }
    before(() =>
      store.fga.write({
        writes: [
          {
            user: 'team:eng#member',
            relation: 'viewer',
            object: 'folder:lu-parent',
            condition: { name: 'non_expired_grant', context: { grant_time: '2026-01-01T00:00:00Z', grant_duration: '1h' } },
          },
          { user: 'folder:lu-parent', relation: 'parent', object: 'folder:lu-child' },
          { user: 'user:ann', relation: 'member', object: 'team:eng' },
        ],
      }),
    )

    it('[rpc:ListUsers] should list the team members while the grant is live', async () => {
      // GIVEN ann is in team:eng, whose grant on the parent folder is live
      // WHEN folder:lu-child viewers of type user are listed
      // THEN ann is returned
      assert.deepEqual(await listUsers('folder', 'lu-child', 'viewer', { type: 'user' }, { context: LIVE }), ['user:ann'])
    })

    it('[rpc:ListUsers] should list no team members once the grant expired', async () => {
      // GIVEN the grant on the parent folder has expired
      // WHEN folder:lu-child viewers of type user are listed
      // THEN nobody is returned
      assert.deepEqual(await listUsers('folder', 'lu-child', 'viewer', { type: 'user' }, { context: EXPIRED }), [])
    })

    it('[rpc:ListUsers] should list the team#member userset while the grant is live', async () => {
      // GIVEN team:eng's grant on the parent folder is live
      // WHEN folder:lu-child viewers are listed filtered by team#member
      // THEN the team:eng#member userset is returned
      assert.deepEqual(
        await listUsers('folder', 'lu-child', 'viewer', { type: 'team', relation: 'member' }, { context: LIVE }),
        ['team:eng#member'],
      )
    })

    it('[rpc:ListUsers] should list no userset once the grant expired', async () => {
      // GIVEN the grant on the parent folder has expired
      // WHEN folder:lu-child viewers are listed filtered by team#member
      // THEN nothing is returned
      assert.deepEqual(await listUsers('folder', 'lu-child', 'viewer', { type: 'team', relation: 'member' }, { context: EXPIRED }), [])
    })
  })

  // The compose stack sets OPENFGA_LIST_USERS_MAX_RESULTS=100.
  describe('when more users match than the server returns', truncation, () => {
    before(async () => {
      const grant = (i: number) => ({ user: `user:crowd-${i}`, relation: 'viewer', object: 'project:lu-crowd' })
      // max + 1 matches, written 100 tuples per request (the Write limit)
      const all = Array.from({ length: LIST_MAX_RESULTS + 1 }, (_, i) => grant(i))
      for (let i = 0; i < all.length; i += 100) await store.fga.write({ writes: all.slice(i, i + 100) })
    })

    it('[rpc:ListUsers] should return exactly max results users and no error', async () => {
      // GIVEN max + 1 viewers on project:lu-crowd (max: 100 on the compose stack)
      // WHEN its viewers are listed
      const listed = await listUsers('project', 'lu-crowd', 'viewer', { type: 'user' })
      // THEN the answer is silently truncated to max
      assert.equal(listed.length, LIST_MAX_RESULTS)
    })
  })
})
