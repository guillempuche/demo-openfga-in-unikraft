// Tuples: Write (writes, deletes, conditions, duplicate/missing handling,
// atomicity, limits), Read (full and partial keys, pages) and ReadChanges.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  ClientWriteRequestOnDuplicateWrites,
  ClientWriteRequestOnMissingDeletes,
  FgaApiValidationError,
  TupleOperation,
} from '@openfga/sdk'
import { freshStore, isValidationError, rawApi, rejection } from './helpers.ts'

let store: Awaited<ReturnType<typeof freshStore>>

before(async () => {
  store = await freshStore('tuples')
})
after(() => store.cleanup())

const office = (cidr: string) => ({ name: 'from_office_network', context: { office_cidr: cidr } })

describe('Write', () => {
  describe('when the tuples are valid', () => {
    it('[rpc:Write] should store a plain tuple that Read returns', async () => {
      // GIVEN an empty object
      // WHEN an owner tuple is written
      await store.fga.write({ writes: [{ user: 'user:alice', relation: 'owner', object: 'project:w-plain' }] })
      // THEN Read returns it
      const { tuples } = await store.fga.read({ object: 'project:w-plain' })
      assert.deepEqual(tuples.map((t) => `${t.key.user} ${t.key.relation}`), ['user:alice owner'])
    })

    it('[rpc:Write] should store a conditional tuple with its condition name and context', async () => {
      // GIVEN an empty object
      // WHEN a contributor tuple with from_office_network is written
      await store.fga.write({
        writes: [{ user: 'user:remy', relation: 'contributor', object: 'project:w-cond', condition: office('10.20.0.0/16') }],
      })
      // THEN Read returns the condition name and its stored context
      const { tuples } = await store.fga.read({ object: 'project:w-cond' })
      assert.equal(tuples.length, 1)
      assert.equal(tuples[0].key.condition?.name, 'from_office_network')
      assert.deepEqual(tuples[0].key.condition?.context, { office_cidr: '10.20.0.0/16' })
    })

    it('[rpc:Write] should remove a deleted tuple', async () => {
      // GIVEN a stored viewer tuple
      const tuple = { user: 'user:temp', relation: 'viewer', object: 'project:w-del' }
      await store.fga.write({ writes: [tuple] })
      // WHEN it is deleted
      await store.fga.write({ deletes: [tuple] })
      // THEN Read no longer returns it
      const { tuples } = await store.fga.read(tuple)
      assert.equal(tuples.length, 0)
    })
  })

  describe('when the tuple already exists', () => {
    const tuple = { user: 'user:dup', relation: 'viewer', object: 'project:w-dup' }
    before(() => store.fga.write({ writes: [tuple] }))

    it('[rpc:Write] should reject the duplicate by default', async () => {
      // GIVEN user:dup viewer project:w-dup is stored
      // WHEN it is written again
      const err = await rejection(() => store.fga.write({ writes: [tuple] }))
      // THEN the write fails validation
      assert.ok(isValidationError(err), String(err))
    })

    it('[rpc:Write] should accept the duplicate with on_duplicate ignore', async () => {
      // GIVEN user:dup viewer project:w-dup is stored
      // WHEN it is written again with on_duplicate=ignore
      await store.fga.write({ writes: [tuple] }, { conflict: { onDuplicateWrites: ClientWriteRequestOnDuplicateWrites.Ignore } })
      // THEN the write succeeds and the tuple is still stored once
      const { tuples } = await store.fga.read(tuple)
      assert.equal(tuples.length, 1)
    })
  })

  describe('when the same key exists with a different condition', () => {
    const key = { user: 'user:remy', relation: 'contributor', object: 'project:w-cond-dup' }
    before(() => store.fga.write({ writes: [{ ...key, condition: office('10.20.0.0/16') }] }))

    it('[rpc:Write] should answer 409 even with on_duplicate ignore', async () => {
      // GIVEN the key stored with office_cidr 10.20.0.0/16
      // WHEN it is written with another office_cidr and on_duplicate=ignore
      const err = await rejection(() =>
        store.fga.write(
          { writes: [{ ...key, condition: office('10.30.0.0/16') }] },
          { conflict: { onDuplicateWrites: ClientWriteRequestOnDuplicateWrites.Ignore } },
        ),
      )
      // THEN the server reports a conflict (HTTP 409, gRPC Aborted), not a validation error
      assert.equal(err.statusCode, 409, String(err))
      assert.match(err.apiErrorMessage ?? '', /already exists with a different condition/)
      // AND the stored condition is unchanged
      const { tuples } = await store.fga.read(key)
      assert.deepEqual(tuples[0].key.condition?.context, { office_cidr: '10.20.0.0/16' })
    })

    it('[rpc:Write] should answer 409 with on_duplicate ignore when the new tuple has no condition', async () => {
      // GIVEN the key stored with a condition
      // WHEN the same key is written without a condition and on_duplicate=ignore
      const err = await rejection(() =>
        store.fga.write({ writes: [key] }, { conflict: { onDuplicateWrites: ClientWriteRequestOnDuplicateWrites.Ignore } }),
      )
      // THEN it is the same conflict
      assert.equal(err.statusCode, 409, String(err))
    })
  })

  describe('when deleting a tuple that does not exist', () => {
    const tuple = { user: 'user:ghost', relation: 'viewer', object: 'project:w-ghost' }

    it('[rpc:Write] should reject the delete by default', async () => {
      // GIVEN no such tuple
      // WHEN it is deleted
      const err = await rejection(() => store.fga.write({ deletes: [tuple] }))
      // THEN the write fails validation
      assert.ok(isValidationError(err), String(err))
    })

    it('[rpc:Write] should accept the delete with on_missing ignore', async () => {
      // GIVEN no such tuple
      // WHEN it is deleted with on_missing=ignore
      const res = await store.fga.write({ deletes: [tuple] }, { conflict: { onMissingDeletes: ClientWriteRequestOnMissingDeletes.Ignore } })
      // THEN the write succeeds
      assert.equal(res.deletes.length, 1)
    })
  })

  describe('when a tuple breaks the model', () => {
    it('[rpc:Write] should reject a user type the relation does not allow', async () => {
      // GIVEN project#owner accepts only `user`
      // WHEN a team#member owner is written
      const err = await rejection(() =>
        store.fga.write({ writes: [{ user: 'team:x#member', relation: 'owner', object: 'project:w-model' }] }),
      )
      // THEN the write fails validation
      assert.ok(isValidationError(err), String(err))
    })

    it('[rpc:Write] should reject a condition on a grant type that does not allow it (regression, v1.18.1)', async () => {
      // GIVEN project#viewer allows plain `user` and `user:* with non_expired_grant`:
      // the condition belongs to the wildcard only
      // WHEN a single user gets a conditional viewer grant
      const err = await rejection(() =>
        store.fga.write({
          writes: [
            {
              user: 'user:zed',
              relation: 'viewer',
              object: 'project:w-model',
              condition: { name: 'non_expired_grant', context: { grant_time: '2026-10-01T00:00:00Z', grant_duration: '1h' } },
            },
          ],
        }),
      )
      // THEN the write fails validation
      assert.ok(isValidationError(err), String(err))
    })

    it('[rpc:Write] should write nothing when one tuple of the batch is invalid', async () => {
      // GIVEN a batch with one valid and one invalid tuple
      const writes = [
        { user: 'user:at1', relation: 'viewer', object: 'project:w-atomic' },
        { user: 'team:x#member', relation: 'owner', object: 'project:w-atomic' },
      ]
      // WHEN it is written
      const err = await rejection(() => store.fga.write({ writes }))
      assert.ok(isValidationError(err), String(err))
      // THEN not even the valid tuple is stored (the request is one transaction)
      const { tuples } = await store.fga.read({ object: 'project:w-atomic' })
      assert.deepEqual(tuples, [])
    })
  })

  describe('when the request is malformed', () => {
    it('[rpc:Write] should reject more than 100 tuples in one request', async () => {
      // GIVEN 101 tuples (sent through the raw API: the SDK would chunk them)
      const writes = Array.from({ length: 101 }, (_, i) => ({ user: `user:bulk${i}`, relation: 'viewer', object: 'project:w-bulk' }))
      // WHEN they are written in one request
      const err = await rejection(() =>
        rawApi().write(store.storeId, { writes: { tuple_keys: writes }, authorization_model_id: store.modelId }),
      )
      // THEN the server names the limit
      assert.ok(err instanceof FgaApiValidationError, String(err))
      assert.match(err.apiErrorMessage ?? '', /100/)
    })

    it('[rpc:Write] should reject writing and deleting the same key in one request', async () => {
      // GIVEN one key in both writes and deletes
      const key = { user: 'user:wd', relation: 'viewer', object: 'project:w-both' }
      // WHEN the request is sent
      const err = await rejection(() =>
        rawApi().write(store.storeId, {
          writes: { tuple_keys: [key] },
          deletes: { tuple_keys: [key] },
          authorization_model_id: store.modelId,
        }),
      )
      // THEN the server answers 400 cannot_allow_duplicate_tuples_in_one_request
      assert.ok(err instanceof FgaApiValidationError, String(err))
      assert.equal(err.apiErrorCode, 'cannot_allow_duplicate_tuples_in_one_request')
    })
  })
})

describe('Read', () => {
  before(async () => {
    const writes = Array.from({ length: 5 }, (_, i) => ({ user: `user:reader${i}`, relation: 'viewer', object: 'project:docs' }))
    await store.fga.write({
      writes: [
        ...writes,
        { user: 'user:rita', relation: 'owner', object: 'project:atlas' },
        { user: 'user:rita', relation: 'owner', object: 'task:rita' },
      ],
    })
  })

  describe('given 5 viewers on project:docs and rita owning project:atlas and task:rita', () => {
    it('[rpc:Read] should return every tuple of an object', async () => {
      // GIVEN 5 viewer tuples on project:docs
      // WHEN the object is read
      const { tuples } = await store.fga.read({ object: 'project:docs' })
      // THEN all 5 come back
      assert.equal(tuples.length, 5)
    })

    it('[rpc:Read] should return the one tuple matching a full key', async () => {
      // GIVEN user:reader1 viewer project:docs
      // WHEN that exact key is read
      const { tuples } = await store.fga.read({ user: 'user:reader1', relation: 'viewer', object: 'project:docs' })
      // THEN exactly it comes back
      assert.equal(tuples.length, 1)
    })

    it("[rpc:Read] should return a user's tuples on one type with a type-only object", async () => {
      // GIVEN rita owns a project and a task
      // WHEN rita's tuples on `project:` are read
      const { tuples } = await store.fga.read({ user: 'user:rita', object: 'project:' })
      // THEN only the project tuple comes back
      assert.deepEqual(tuples.map((t) => t.key.object), ['project:atlas'])
    })

    describe('when paging', () => {
      it('[rpc:Read] should return page_size tuples and a continuation token for the rest', async () => {
        // GIVEN 5 tuples on project:docs
        // WHEN the first page of 2 is read
        const first = await store.fga.read({ object: 'project:docs' }, { pageSize: 2 })
        assert.equal(first.tuples.length, 2)
        assert.ok(first.continuation_token)
        // AND the rest is read with the token
        const rest = await store.fga.read({ object: 'project:docs' }, { pageSize: 100, continuationToken: first.continuation_token })
        // THEN the remaining 3 come back
        assert.equal(rest.tuples.length, 3)
      })

      it('[rpc:Read] should reject a page size over 100', async () => {
        // GIVEN tuples on project:docs
        // WHEN a page of 101 is requested
        const err = await rejection(() => store.fga.read({ object: 'project:docs' }, { pageSize: 101 }))
        // THEN the request fails validation
        assert.ok(err instanceof FgaApiValidationError, String(err))
      })
    })
  })
})

describe('ReadChanges', () => {
  /** Server timestamp of the latest change on `object` (type-filtered feed). */
  const changeTime = async (type: string, object: string) => {
    const { changes } = await store.fga.readChanges({ type }, { pageSize: 100 })
    return Date.parse(changes.filter((c) => c.tuple_key.object === object).at(-1)!.timestamp)
  }

  describe('when filtering by type', () => {
    it('[rpc:ReadChanges] should list a write and a delete in order, only for that type', async () => {
      // GIVEN a task tuple written and deleted after `since`
      const since = new Date(Date.now() - 1000).toISOString()
      await store.fga.write({ writes: [{ user: 'user:chg', relation: 'owner', object: 'task:t1' }] })
      await store.fga.write({ deletes: [{ user: 'user:chg', relation: 'owner', object: 'task:t1' }] })
      // WHEN task changes since then are read
      const { changes } = await store.fga.readChanges({ type: 'task', startTime: since })
      // THEN the write comes before the delete
      const ops = changes.filter((c) => c.tuple_key.object === 'task:t1').map((c) => c.operation)
      assert.deepEqual(ops, [TupleOperation.Write, TupleOperation.Delete])
      // AND only task changes are listed
      assert.ok(changes.every((c) => c.tuple_key.object.startsWith('task:')))
    })
  })

  describe('when a start time is given', () => {
    it('[rpc:ReadChanges] should exclude changes before it', async () => {
      // GIVEN an early change and a later one, with the cutoff taken from the
      // server's own timestamp (a client clock can differ, e.g. through the
      // Unikraft tunnel, and start_time must not be in the future)
      await store.fga.write({ writes: [{ user: 'user:early', relation: 'owner', object: 'task:t2' }] })
      const cutoff = new Date((await changeTime('task', 'task:t2')) + 1).toISOString()
      await new Promise((r) => setTimeout(r, 20))
      await store.fga.write({ writes: [{ user: 'user:late', relation: 'owner', object: 'task:t3' }] })
      // WHEN changes since the cutoff are read
      const since = await store.fga.readChanges({ type: 'task', startTime: cutoff })
      // THEN only the later change is listed
      assert.deepEqual(since.changes.map((c) => c.tuple_key.object), ['task:t3'])
    })
  })

  describe('when paging', () => {
    it('[rpc:ReadChanges] should return the next change with the continuation token', async () => {
      // GIVEN at least two project changes
      await store.fga.write({
        writes: [
          { user: 'user:p1', relation: 'viewer', object: 'project:rc-page' },
          { user: 'user:p2', relation: 'viewer', object: 'project:rc-page' },
        ],
      })
      // WHEN the feed is read one change per page
      const first = await store.fga.readChanges({ type: 'project' }, { pageSize: 1 })
      assert.equal(first.changes.length, 1)
      assert.ok(first.continuation_token)
      const second = await store.fga.readChanges({ type: 'project' }, { pageSize: 1, continuationToken: first.continuation_token })
      // THEN the second page holds a different change
      assert.equal(second.changes.length, 1)
      assert.notDeepEqual(second.changes[0], first.changes[0])
    })

    it('[rpc:ReadChanges] should return later changes from the token of an exhausted feed', async () => {
      // GIVEN a team feed read to its end
      await store.fga.write({ writes: [{ user: 'user:t1', relation: 'member', object: 'team:rc' }] })
      let page = await store.fga.readChanges({ type: 'team' }, { pageSize: 100 })
      while (page.changes.length > 0) {
        page = await store.fga.readChanges({ type: 'team' }, { pageSize: 100, continuationToken: page.continuation_token })
      }
      // (an exhausted feed still returns a token: the position to resume from)
      const token = page.continuation_token
      assert.ok(token)
      // WHEN a new team change is written and the feed is read from that token
      await store.fga.write({ writes: [{ user: 'user:t2', relation: 'member', object: 'team:rc' }] })
      const next = await store.fga.readChanges({ type: 'team' }, { pageSize: 100, continuationToken: token })
      // THEN only the new change is returned
      assert.deepEqual(next.changes.map((c) => c.tuple_key.user), ['user:t2'])
    })
  })

  describe('when the tuple has a condition', () => {
    const key = { user: 'user:remy', relation: 'contributor', object: 'project:rc-cond' }

    it('[rpc:ReadChanges] should return the condition name and context of the write', async () => {
      // GIVEN a conditional contributor tuple is written
      await store.fga.write({ writes: [{ ...key, condition: office('10.20.0.0/16') }] })
      // WHEN the project feed is read
      const { changes } = await store.fga.readChanges({ type: 'project' }, { pageSize: 100 })
      // THEN the write carries the condition
      const write = changes.find((c) => c.tuple_key.object === key.object && c.operation === TupleOperation.Write)!
      assert.deepEqual(write.tuple_key.condition, { name: 'from_office_network', context: { office_cidr: '10.20.0.0/16' } })
    })

    it('[rpc:ReadChanges] should list its delete, without the condition', async () => {
      // GIVEN a conditional contributor tuple written, then deleted
      const deleted = { ...key, object: 'project:rc-cond-del' }
      await store.fga.write({ writes: [{ ...deleted, condition: office('10.20.0.0/16') }] })
      await store.fga.write({ deletes: [deleted] })
      // WHEN the project feed is read
      const { changes } = await store.fga.readChanges({ type: 'project' }, { pageSize: 100 })
      // THEN the delete is listed
      const del = changes.find((c) => c.tuple_key.object === deleted.object && c.operation === TupleOperation.Delete)
      assert.ok(del, 'delete listed')
      // AND (observed on v1.21.0) a delete names only the key: condition is null
      assert.equal(del.tuple_key.condition ?? null, null)
    })
  })
})
