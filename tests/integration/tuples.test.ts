// Tuples: Write (writes, deletes, conditions, duplicate/missing handling,
// limits), Read (full and partial keys, pages) and ReadChanges.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import {
  ClientWriteRequestOnDuplicateWrites,
  ClientWriteRequestOnMissingDeletes,
  FgaApiValidationError,
  TupleOperation,
} from '@openfga/sdk'
import { freshStore, rawApi, rejection } from './helpers.ts'

let store: Awaited<ReturnType<typeof freshStore>>

before(async () => {
  store = await freshStore('tuples')
})
after(() => store.cleanup())

describe('Write', () => {
  test('[rpc:Write] writes tuples, including one with a condition, and Read returns them', async () => {
    await store.fga.write({
      writes: [
        { user: 'user:alice', relation: 'owner', object: 'project:roadmap' },
        { user: 'org:acme', relation: 'org', object: 'project:roadmap' },
        {
          user: 'user:remy',
          relation: 'contributor',
          object: 'project:roadmap',
          condition: { name: 'from_office_network', context: { office_cidr: '10.20.0.0/16' } },
        },
      ],
    })
    const { tuples } = await store.fga.read({ object: 'project:roadmap' })
    const keys = tuples.map((t) => `${t.key.user} ${t.key.relation}`).sort()
    assert.deepEqual(keys, ['org:acme org', 'user:alice owner', 'user:remy contributor'])
    const remy = tuples.find((t) => t.key.user === 'user:remy')!
    assert.equal(remy.key.condition?.name, 'from_office_network')
    assert.deepEqual(remy.key.condition?.context, { office_cidr: '10.20.0.0/16' })
  })

  test('[rpc:Write] deletes tuples', async () => {
    await store.fga.write({ writes: [{ user: 'user:temp', relation: 'viewer', object: 'project:roadmap' }] })
    await store.fga.write({ deletes: [{ user: 'user:temp', relation: 'viewer', object: 'project:roadmap' }] })
    const { tuples } = await store.fga.read({ user: 'user:temp', relation: 'viewer', object: 'project:roadmap' })
    assert.equal(tuples.length, 0)
  })

  test('[rpc:Write] rejects duplicate writes by default and ignores them on request', async () => {
    const tuple = { user: 'user:dup', relation: 'viewer', object: 'project:roadmap' }
    await store.fga.write({ writes: [tuple] })
    const err = await rejection(() => store.fga.write({ writes: [tuple] }))
    assert.ok(err instanceof FgaApiValidationError || err?.cause instanceof FgaApiValidationError, String(err))
    await store.fga.write(
      { writes: [tuple] },
      { conflict: { onDuplicateWrites: ClientWriteRequestOnDuplicateWrites.Ignore } },
    )
  })

  test('[rpc:Write] rejects deleting a missing tuple by default and ignores it on request', async () => {
    const tuple = { user: 'user:ghost', relation: 'viewer', object: 'project:roadmap' }
    const err = await rejection(() => store.fga.write({ deletes: [tuple] }))
    assert.ok(err instanceof FgaApiValidationError || err?.cause instanceof FgaApiValidationError, String(err))
    await store.fga.write(
      { deletes: [tuple] },
      { conflict: { onMissingDeletes: ClientWriteRequestOnMissingDeletes.Ignore } },
    )
  })

  test('[rpc:Write] rejects a tuple the model does not allow', async () => {
    // project#owner only accepts user, not team#member.
    const err = await rejection(() =>
      store.fga.write({ writes: [{ user: 'team:x#member', relation: 'owner', object: 'project:roadmap' }] }),
    )
    assert.ok(err instanceof FgaApiValidationError || err?.cause instanceof FgaApiValidationError, String(err))
  })

  test('[rpc:Write] rejects a condition on a grant type that does not allow it (regression, v1.18.1)', async () => {
    // project#viewer allows plain `user` and `user:* with non_expired_grant`; the
    // condition belongs to the wildcard only, so a conditional grant to a single
    // user must be rejected.
    const err = await rejection(() =>
      store.fga.write({
        writes: [
          {
            user: 'user:zed',
            relation: 'viewer',
            object: 'project:roadmap',
            condition: { name: 'non_expired_grant', context: { grant_time: '2026-10-01T00:00:00Z', grant_duration: '1h' } },
          },
        ],
      }),
    )
    assert.ok(err instanceof FgaApiValidationError || err?.cause instanceof FgaApiValidationError, String(err))
  })

  test('[rpc:Write] rejects more than 100 tuples in one request', async () => {
    const writes = Array.from({ length: 101 }, (_, i) => ({ user: `user:bulk${i}`, relation: 'viewer', object: 'project:bulk' }))
    const err = await rejection(() =>
      rawApi().write(store.storeId, { writes: { tuple_keys: writes }, authorization_model_id: store.modelId }),
    )
    assert.ok(err instanceof FgaApiValidationError, String(err))
    assert.match(err.apiErrorMessage ?? '', /100/)
  })
})

describe('Read', () => {
  before(async () => {
    const writes = Array.from({ length: 5 }, (_, i) => ({ user: `user:reader${i}`, relation: 'viewer', object: 'project:docs' }))
    await store.fga.write({ writes })
  })

  test('[rpc:Read] reads by object, by user and relation, and by type only', async () => {
    const byObject = await store.fga.read({ object: 'project:docs' })
    assert.equal(byObject.tuples.length, 5)

    const exact = await store.fga.read({ user: 'user:reader1', relation: 'viewer', object: 'project:docs' })
    assert.equal(exact.tuples.length, 1)

    // Partial key: every project tuple for this user, without naming the project.
    const typeOnly = await store.fga.read({ user: 'user:alice', object: 'project:' })
    assert.deepEqual(typeOnly.tuples.map((t) => t.key.object), ['project:roadmap'])
  })

  test('[rpc:Read] pages with page_size and continuation tokens', async () => {
    const first = await store.fga.read({ object: 'project:docs' }, { pageSize: 2 })
    assert.equal(first.tuples.length, 2)
    assert.ok(first.continuation_token)
    const rest = await store.fga.read({ object: 'project:docs' }, { pageSize: 100, continuationToken: first.continuation_token })
    assert.equal(rest.tuples.length, 3)
  })

  test('[rpc:Read] rejects a page size over 100', async () => {
    const err = await rejection(() => store.fga.read({ object: 'project:docs' }, { pageSize: 101 }))
    assert.ok(err instanceof FgaApiValidationError, String(err))
  })
})

describe('ReadChanges', () => {
  test('[rpc:ReadChanges] lists writes and deletes in order, filtered by type', async () => {
    const before = new Date(Date.now() - 1000).toISOString()
    await store.fga.write({ writes: [{ user: 'user:chg', relation: 'owner', object: 'task:t1' }] })
    await store.fga.write({ deletes: [{ user: 'user:chg', relation: 'owner', object: 'task:t1' }] })

    const { changes } = await store.fga.readChanges({ type: 'task', startTime: before })
    const ops = changes.filter((c) => c.tuple_key.object === 'task:t1').map((c) => c.operation)
    assert.deepEqual(ops, [TupleOperation.Write, TupleOperation.Delete])
    assert.ok(changes.every((c) => c.tuple_key.object.startsWith('task:')), 'type filter applied')
  })

  test('[rpc:ReadChanges] start_time excludes earlier changes; pages with continuation tokens', async () => {
    // Use the server's own timestamp as the cutoff: a client clock can differ
    // from the server's (it does through the Unikraft tunnel), and start_time
    // must not be in the future.
    await store.fga.write({ writes: [{ user: 'user:early', relation: 'owner', object: 'task:t2' }] })
    const all = await store.fga.readChanges({ type: 'task' })
    const early = all.changes.find((c) => c.tuple_key.object === 'task:t2')!
    const cutoff = new Date(Date.parse(early.timestamp) + 1).toISOString()
    await new Promise((r) => setTimeout(r, 20))
    await store.fga.write({ writes: [{ user: 'user:late', relation: 'owner', object: 'task:t3' }] })
    const since = await store.fga.readChanges({ type: 'task', startTime: cutoff })
    assert.deepEqual(since.changes.map((c) => c.tuple_key.object), ['task:t3'])

    const first = await store.fga.readChanges({ type: 'project' }, { pageSize: 1 })
    assert.equal(first.changes.length, 1)
    assert.ok(first.continuation_token)
    const second = await store.fga.readChanges({ type: 'project' }, { pageSize: 1, continuationToken: first.continuation_token })
    assert.equal(second.changes.length, 1)
    assert.notDeepEqual(second.changes[0], first.changes[0])
  })
})
