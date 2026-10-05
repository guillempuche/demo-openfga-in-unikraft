// Experimental tier (OpenFGA v1.21.0): the AuthZEN API (6 RPCs, flag
// `authzen`) and inline `$expression` conditions (flag `inline_expressions`).
// Runs only when the server enables them (FGA_EXPERIMENTAL=1, the default for
// the local/CI stack); the Unikraft deployment doesn't, so it's skipped there.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { API_URL, EXPERIMENTAL, client, freshStore, http, isValidationError, rejection } from './helpers.ts'

const skip = !EXPERIMENTAL && 'experimental features are off (FGA_EXPERIMENTAL=0)'

// GIVEN (file-wide for AuthZEN, the "AuthZEN fixture"): alice owns
// project:roadmap and project:wiki, bob contributes to and carol views
// project:roadmap.
describe('AuthZEN', { skip }, () => {
  let store: Awaited<ReturnType<typeof freshStore>>
  const path = (p: string) => `/stores/${store.storeId}/access/v1/${p}`

  before(async () => {
    store = await freshStore('authzen')
    await store.fga.write({
      writes: [
        { user: 'user:alice', relation: 'owner', object: 'project:roadmap' },
        { user: 'user:bob', relation: 'contributor', object: 'project:roadmap' },
        { user: 'user:carol', relation: 'viewer', object: 'project:roadmap' },
        { user: 'user:alice', relation: 'owner', object: 'project:wiki' },
      ],
    })
  })
  after(() => store.cleanup())

  describe('Evaluation', () => {
    const evaluate = (id: string, action: string) =>
      http('POST', path('evaluation'), {
        subject: { type: 'user', id },
        action: { name: action },
        resource: { type: 'project', id: 'roadmap' },
      })

    it('[rpc:Evaluation] should decide true when the Check behind it allows', async () => {
      // GIVEN the AuthZEN fixture: bob contributes to project:roadmap
      // WHEN bob's can_edit is evaluated
      const res = await evaluate('bob', 'can_edit')
      // THEN the decision is true
      assert.equal(res.status, 200, JSON.stringify(res.body))
      assert.equal(res.body.decision, true)
    })

    it('[rpc:Evaluation] should decide false when the Check behind it denies', async () => {
      // GIVEN the AuthZEN fixture: carol only views project:roadmap
      // WHEN carol's can_edit is evaluated
      const res = await evaluate('carol', 'can_edit')
      // THEN the decision is false
      assert.equal(res.status, 200, JSON.stringify(res.body))
      assert.equal(res.body.decision, false)
    })
  })

  describe('Evaluations', () => {
    describe('when subject and resource are shared defaults', () => {
      it('[rpc:Evaluations] should decide each action in order', async () => {
        // GIVEN the AuthZEN fixture: carol views project:roadmap
        // WHEN can_view and can_edit are evaluated in one batch for carol on the project
        const res = await http('POST', path('evaluations'), {
          subject: { type: 'user', id: 'carol' },
          resource: { type: 'project', id: 'roadmap' },
          evaluations: [{ action: { name: 'can_view' } }, { action: { name: 'can_edit' } }],
        })
        // THEN the decisions are [true, false]
        assert.equal(res.status, 200, JSON.stringify(res.body))
        assert.deepEqual(res.body.evaluations.map((e: any) => e.decision), [true, false])
      })
    })
  })

  describe('SubjectSearch', () => {
    it('[rpc:SubjectSearch] should find the subjects allowed an action (like ListUsers)', async () => {
      // GIVEN the AuthZEN fixture: alice owns and bob contributes to project:roadmap
      // WHEN users who can_edit it are searched
      const res = await http('POST', path('search/subject'), {
        subject: { type: 'user' },
        action: { name: 'can_edit' },
        resource: { type: 'project', id: 'roadmap' },
      })
      // THEN alice and bob are found
      assert.equal(res.status, 200, JSON.stringify(res.body))
      assert.deepEqual(res.body.results.map((s: any) => s.id).sort(), ['alice', 'bob'])
    })
  })

  describe('ResourceSearch', () => {
    it('[rpc:ResourceSearch] should find the resources a subject can reach (like ListObjects)', async () => {
      // GIVEN the AuthZEN fixture: alice owns project:roadmap and project:wiki
      // WHEN projects alice can_manage are searched
      const res = await http('POST', path('search/resource'), {
        subject: { type: 'user', id: 'alice' },
        action: { name: 'can_manage' },
        resource: { type: 'project' },
      })
      // THEN both projects are found
      assert.equal(res.status, 200, JSON.stringify(res.body))
      assert.deepEqual(res.body.results.map((r: any) => r.id).sort(), ['roadmap', 'wiki'])
    })
  })

  describe('ActionSearch', () => {
    const search = async () => {
      const res = await http('POST', path('search/action'), {
        subject: { type: 'user', id: 'carol' },
        resource: { type: 'project', id: 'roadmap' },
      })
      assert.equal(res.status, 200, JSON.stringify(res.body))
      return res.body.results.map((a: any) => a.name) as string[]
    }

    it('[rpc:ActionSearch] should include an action the subject may take', async () => {
      // GIVEN the AuthZEN fixture: carol views project:roadmap
      // WHEN carol's actions on it are searched
      const actions = await search()
      // THEN can_view is included
      assert.ok(actions.includes('can_view'), JSON.stringify(actions))
    })

    it('[rpc:ActionSearch] should leave out an action the subject may not take', async () => {
      // GIVEN the AuthZEN fixture: carol only views project:roadmap
      // WHEN carol's actions on it are searched
      const actions = await search()
      // THEN can_edit is left out
      assert.ok(!actions.includes('can_edit'), JSON.stringify(actions))
    })
  })

  describe('GetConfiguration', () => {
    it('[rpc:GetConfiguration] should publish the per-store policy decision point and endpoints', async () => {
      // GIVEN AUTHZEN_BASE_URL is the server's own URL
      // WHEN the store's discovery document is fetched
      const res = await http('GET', `/.well-known/authzen-configuration/${store.storeId}`)
      // THEN the policy decision point is <base URL>/stores/<id>
      assert.equal(res.status, 200, JSON.stringify(res.body))
      assert.equal(res.body.policy_decision_point, `${API_URL}/stores/${store.storeId}`)
      // AND the evaluation endpoint is under it
      assert.match(res.body.access_evaluation_endpoint, new RegExp(`/stores/${store.storeId}/access/v1/evaluation$`))
    })
  })
})

describe('inline $expression conditions', { skip }, () => {
  let storeId = ''
  let fga: ReturnType<typeof client>

  // GIVEN (for this block): a minimal model whose channel#reader accepts
  // `user with $expression`.
  before(async () => {
    storeId = (await client().createStore({ name: `it-expr-${Date.now()}` })).id
    const { authorization_model_id } = await client({ storeId }).writeAuthorizationModel({
      schema_version: '1.1',
      type_definitions: [
        { type: 'user' },
        {
          type: 'channel',
          relations: { reader: { this: {} } },
          metadata: { relations: { reader: { directly_related_user_types: [{ type: 'user', condition: '$expression' }] } } },
        },
      ],
    } as any)
    fga = client({ storeId, authorizationModelId: authorization_model_id })
  })
  after(() => client({ storeId }).deleteStore().catch(() => undefined))

  const anaReader = {
    user: 'user:ana',
    relation: 'reader',
    object: 'channel:general',
    condition: {
      name: '$expression',
      context: { expression: "region == 'eu' && level >= 2", parameters: { region: 'string', level: 'int' } },
    },
  }
  const ana = (context: object) =>
    fga.check({ user: 'user:ana', relation: 'reader', object: 'channel:eu', context }).then((r) => r.allowed)

  describe('Write', () => {
    it('[rpc:Write] should store a tuple that carries its own CEL expression', async () => {
      // GIVEN a reader tuple with an inline expression
      // WHEN it is written
      await fga.write({ writes: [anaReader] })
      // THEN Read returns the expression
      const { tuples } = await fga.read({ object: 'channel:general' })
      assert.equal(tuples[0].key.condition?.name, '$expression')
      assert.equal((tuples[0].key.condition?.context as any).expression, "region == 'eu' && level >= 2")
    })

    it('[rpc:Write] should reject an invalid expression', async () => {
      // GIVEN a tuple whose expression doesn't parse
      const bad = { ...anaReader, user: 'user:bo', condition: { name: '$expression', context: { expression: 'region ==' } } }
      // WHEN it is written
      const err = await rejection(() => fga.write({ writes: [bad] }))
      // THEN the write fails validation
      assert.ok(isValidationError(err), String(err))
    })
  })

  describe('Check', () => {
    before(() => fga.write({ writes: [{ ...anaReader, object: 'channel:eu' }] }))

    it('[rpc:Check] should allow when the context satisfies the expression', async () => {
      // GIVEN ana reads channel:eu if region == 'eu' && level >= 2
      // WHEN ana reads from the eu at level 3
      // THEN it is allowed
      assert.equal(await ana({ region: 'eu', level: 3 }), true)
    })

    it('[rpc:Check] should deny when a numeric bound fails', async () => {
      // GIVEN ana reads channel:eu if region == 'eu' && level >= 2
      // WHEN ana reads from the eu at level 1
      // THEN it is denied
      assert.equal(await ana({ region: 'eu', level: 1 }), false)
    })

    it('[rpc:Check] should deny when a string comparison fails', async () => {
      // GIVEN ana reads channel:eu if region == 'eu' && level >= 2
      // WHEN ana reads from the us at level 5
      // THEN it is denied
      assert.equal(await ana({ region: 'us', level: 5 }), false)
    })
  })
})
