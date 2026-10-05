// Experimental tier (OpenFGA v1.21.0): the AuthZEN API (6 RPCs, flag
// `authzen`) and inline `$expression` conditions (flag `inline_expressions`).
// Runs only when the server enables them (FGA_EXPERIMENTAL=1, the default for
// the local/CI stack); the Unikraft deployment doesn't, so it's skipped there.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { FgaApiValidationError } from '@openfga/sdk'
import { API_URL, EXPERIMENTAL, client, freshStore, http, rejection } from './helpers.ts'

const skip = !EXPERIMENTAL && 'experimental features are off (FGA_EXPERIMENTAL=0)'

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

  test('[rpc:Evaluation] maps subject/action/resource onto a Check', async () => {
    const ask = (id: string, action: string) =>
      http('POST', path('evaluation'), {
        subject: { type: 'user', id },
        action: { name: action },
        resource: { type: 'project', id: 'roadmap' },
      })
    const yes = await ask('bob', 'can_edit')
    assert.equal(yes.status, 200, JSON.stringify(yes.body))
    assert.equal(yes.body.decision, true)
    assert.equal((await ask('carol', 'can_edit')).body.decision, false)
  })

  test('[rpc:Evaluations] evaluates a batch with shared defaults', async () => {
    const res = await http('POST', path('evaluations'), {
      subject: { type: 'user', id: 'carol' },
      resource: { type: 'project', id: 'roadmap' },
      evaluations: [{ action: { name: 'can_view' } }, { action: { name: 'can_edit' } }],
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.deepEqual(res.body.evaluations.map((e: any) => e.decision), [true, false])
  })

  test('[rpc:SubjectSearch] finds who can do something (like ListUsers)', async () => {
    const res = await http('POST', path('search/subject'), {
      subject: { type: 'user' },
      action: { name: 'can_edit' },
      resource: { type: 'project', id: 'roadmap' },
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.deepEqual(res.body.results.map((s: any) => s.id).sort(), ['alice', 'bob'])
  })

  test('[rpc:ResourceSearch] finds what a subject can reach (like ListObjects)', async () => {
    const res = await http('POST', path('search/resource'), {
      subject: { type: 'user', id: 'alice' },
      action: { name: 'can_manage' },
      resource: { type: 'project' },
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.deepEqual(res.body.results.map((r: any) => r.id).sort(), ['roadmap', 'wiki'])
  })

  test('[rpc:ActionSearch] lists the actions a subject may take on a resource', async () => {
    const res = await http('POST', path('search/action'), {
      subject: { type: 'user', id: 'carol' },
      resource: { type: 'project', id: 'roadmap' },
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const actions = res.body.results.map((a: any) => a.name)
    assert.ok(actions.includes('can_view'), JSON.stringify(actions))
    assert.ok(!actions.includes('can_edit'), JSON.stringify(actions))
  })

  test('[rpc:GetConfiguration] publishes AuthZEN discovery metadata', async () => {
    const res = await http('GET', `/.well-known/authzen-configuration/${store.storeId}`)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    // The policy decision point is published per store: <base URL>/stores/<id>.
    assert.equal(res.body.policy_decision_point, `${API_URL}/stores/${store.storeId}`)
    assert.match(res.body.access_evaluation_endpoint, new RegExp(`/stores/${store.storeId}/access/v1/evaluation$`))
  })
})

describe('inline $expression conditions', { skip }, () => {
  test('[rpc:Write] a tuple carries its own CEL expression; Check evaluates it', async () => {
    const { id: storeId } = await client().createStore({ name: `it-expr-${Date.now()}` })
    try {
      const scoped = client({ storeId })
      const { authorization_model_id } = await scoped.writeAuthorizationModel({
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
      const fga = client({ storeId, authorizationModelId: authorization_model_id })
      await fga.write({
        writes: [
          {
            user: 'user:ana',
            relation: 'reader',
            object: 'channel:general',
            condition: {
              name: '$expression',
              context: { expression: "region == 'eu' && level >= 2", parameters: { region: 'string', level: 'int' } },
            },
          },
        ],
      })
      const check = (context: object) =>
        fga.check({ user: 'user:ana', relation: 'reader', object: 'channel:general', context }).then((r) => r.allowed)
      assert.equal(await check({ region: 'eu', level: 3 }), true)
      assert.equal(await check({ region: 'eu', level: 1 }), false)
      assert.equal(await check({ region: 'us', level: 5 }), false)

      // An invalid expression is rejected at write time.
      const err = await rejection(() =>
        fga.write({
          writes: [
            {
              user: 'user:bo',
              relation: 'reader',
              object: 'channel:general',
              condition: { name: '$expression', context: { expression: 'region ==' } },
            },
          ],
        }),
      )
      assert.ok(err instanceof FgaApiValidationError || err?.cause instanceof FgaApiValidationError, String(err))
    } finally {
      await client({ storeId }).deleteStore().catch(() => undefined)
    }
  })
})
