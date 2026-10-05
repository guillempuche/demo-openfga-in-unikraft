# OpenFGA features, by example

Every OpenFGA modeling feature and API call this repository uses, each with the model excerpt, the call, and the tests that prove it works. All examples share one model: a project-management app, org → team → folder → project → list → task ([`authz/models/`](../authz/models)).

Two test suites back this guide:

- **Model tests** (`authz/models/*.fga.yaml`, run with `fga model test`): what the model allows, one behaviour per test, named "… should …" with GIVEN/WHEN/THEN comments. `scripts/check-model-coverage.py` requires an allowed and a denied check for every relation and kills every single-rule mutant of the model, including condition boundaries.
- **Integration tests** (`tests/integration/*.test.ts`, `@openfga/sdk` against a real OpenFGA with PostgreSQL): every RPC, with stored tuples. `scripts/check-api-coverage.py` requires a passing `[rpc:<Name>]` test and OpenFGA's own metrics to show the call.

Test names below are quoted exactly, so you can search for them.

## Contents

- [Modeling](#modeling)
  - [Types, direct and computed relations](#types-direct-and-computed-relations)
  - [Inheritance from a parent object (`from`)](#inheritance-from-a-parent-object-from)
  - [Groups: usersets and nested teams](#groups-usersets-and-nested-teams)
  - [Recursion: folders inside folders](#recursion-folders-inside-folders)
  - [Exclusion (`but not`)](#exclusion-but-not)
  - [Intersection (`and`)](#intersection-and)
  - [Public access (`user:*`)](#public-access-user)
  - [Conditions (ABAC with CEL)](#conditions-abac-with-cel)
  - [Modular models and `extend type`](#modular-models-and-extend-type)
- [Calling OpenFGA from TypeScript](#calling-openfga-from-typescript)
  - [Plain SDK and Effect, side by side](#plain-sdk-and-effect-side-by-side)
  - [Check](#check)
  - [BatchCheck](#batchcheck)
  - [ListObjects and StreamedListObjects](#listobjects-and-streamedlistobjects)
  - [ListUsers](#listusers)
  - [Expand](#expand)
  - [Write, Read and ReadChanges](#write-read-and-readchanges)
  - [Stores, models and assertions](#stores-models-and-assertions)
  - [AuthZEN (experimental)](#authzen-experimental)
- [Operating OpenFGA](#operating-openfga)
  - [Authentication](#authentication)
  - [The check cache and consistency](#the-check-cache-and-consistency)
  - [Limits](#limits)

## Modeling

### Types, direct and computed relations

A **direct** relation lists who can be assigned to it (`[user]`). A **computed** relation is defined from other relations (`owner or contributor`).

```fga
type project
  relations
    define owner: [user]
    define contributor: [user, team#member, user with from_office_network]
    define viewer: [user, team#member, user:*, user:* with non_expired_grant]
    define member: owner or contributor or viewer
```

Tests: [projects.fga.yaml](../authz/models/projects.fga.yaml), "a project owner should have full control", "a contributor should edit but not manage the project", "an outsider should get nothing on the project". Docs: [Configuration language](https://openfga.dev/docs/configuration-language).

### Inheritance from a parent object (`from`)

`X from Y` (tuple-to-userset) follows the `Y` relation to another object and asks for `X` there. Lists inherit from their project, and tasks from their list:

```fga
type list
  relations
    define project: [project]
    define is_blocked: is_blocked from project
    define can_edit: (owner or collaborator or can_edit from project) but not is_blocked
    define can_view: (member or can_view from project) but not is_blocked
```

Lists inherit the project's *permissions* (`can_view`), not its raw roles (`member`). Inheriting `member` would let a user blocked on the project still view its lists; mutation testing found this bug while the model was written. The project's block is also passed down (`is_blocked from project`), so it overrides direct list grants too, and tasks do the same through their list.

Tests: "a project contributor should edit the project's lists", "a block on the project should override a direct list grant", "a list collaborator should edit and comment on the list's tasks but not complete them". Docs: [Parent-child objects](https://openfga.dev/docs/modeling/parent-child).

### Groups: usersets and nested teams

`team#member` assigns a relation to every member of a team at once. A team can include another team's members, so teams nest:

```fga
type team
  relations
    define maintainer: [user]
    define member: [user, team#member] or maintainer
```

```yaml
# authz/models/core.fga.yaml: sre ⊂ infra ⊂ platform, so sam is a member of team:platform
- { user: team:infra#member, relation: member, object: team:platform }
- { user: team:sre#member, relation: member, object: team:infra }
- { user: user:sam, relation: member, object: team:sre }
```

Tests: [core.fga.yaml](../authz/models/core.fga.yaml), "a member two levels down should be a member of every team above", "a membership cycle between teams should resolve without granting outsiders"; [projects.fga.yaml](../authz/models/projects.fga.yaml), "a member of a contributing team should edit the project". Docs: [User groups](https://openfga.dev/docs/modeling/user-groups).

### Recursion: folders inside folders

A relation can follow the same type: a folder's viewers include its parent's viewers, to any depth.

```fga
type folder
  relations
    define parent: [folder]
    define manager: owner or manager from parent
    define editor: [user, team#member] or owner or editor from parent
    define viewer: [user, team#member, team#member with non_expired_grant] or editor or viewer from parent
```

Owners of a folder, or of any folder above it, manage the projects inside (`project#can_manage` includes `manager from folder`).

OpenFGA stops runaway recursion: on a cold cache, a check that has to resolve 25 levels fails with `authorization_model_resolution_too_complex` (24 levels resolve). Once shallower answers are cached, deeper checks can succeed. `ListObjects` isn't limited the same way.

Tests: [nesting.fga.yaml](../authz/models/nesting.fga.yaml), "a folder owner should manage, edit and share projects in any sub-folder", "folder access should carry on to the project's lists and tasks"; integration, "[rpc:Check] should stop runaway recursion at 25 levels with a cold cache", "[rpc:Check] should resolve 24 levels".

### Exclusion (`but not`)

`but not` removes access. A block on the project, in its org, or in the org of its folder overrides every grant, including the owner's. Naming the combined block (`is_blocked`) lets lists and tasks exclude it too:

```fga
# folder: blocked in this folder's org or in the org of any folder above
define blocked_in_org: blocked from org or blocked_in_org from parent
# project
define is_blocked: blocked or blocked from org or blocked_in_org from folder
define can_edit: (contributor or editor from folder or can_manage) but not is_blocked
define can_view: (member or viewer from folder or can_manage) but not is_blocked
```

`can_manage` isn't excluded, so a blocked owner or admin can still unblock.

Tests: [exclusion.fga.yaml](../authz/models/exclusion.fga.yaml), "a blocked owner should lose edit and view but keep can_manage", "a contributor blocked in the org should lose access to the org's projects", "a block in the folder's org should apply to a project without an org", "a block in the org should override a direct task grant". Docs: [Blocklists](https://openfga.dev/docs/modeling/blocklists).

### Intersection (`and`)

`and` requires both sides. Sharing a project needs edit rights *and* membership of the project's org:

```fga
define can_share: can_edit and member from org
```

Tests: [intersection.fga.yaml](../authz/models/intersection.fga.yaml), "an editor who is an org member should share the project", "an editor who isn't an org member should not share the project", "an org member who can't edit should not share the project". The integration suite also has a regression test for a ListUsers bug with this shape, "[rpc:ListUsers] should never return a blocked user (regression, CVE-2026-61709: wildcard + and + but not)".

### Public access (`user:*`)

`user:*` assigns a relation to every user. Here it can also expire:

```fga
define viewer: [user, team#member, user:*, user:* with non_expired_grant]
```

```yaml
# authz/models/public-access.fga.yaml
- { user: user:*, relation: viewer, object: project:handbook }
```

Blocks still apply: `can_view` is `... but not is_blocked`. ListUsers returns the wildcard itself (`{ wildcard: { type: 'user' } }`), not a list of users, and can't say which users are blocked, so check a specific user with Check.

Tests: [public-access.fga.yaml](../authz/models/public-access.fga.yaml), "anyone should view a public project", "a user blocked in the org should not view the org's public project", "nobody should view a time-limited public project before the grant starts", "listing a public project's users should return the wildcard, even with blocked users". Docs: [Public access](https://openfga.dev/docs/modeling/public-access).

### Conditions (ABAC with CEL)

A condition is a CEL expression on a grant. Its parameters come from the tuple (stored when it's written) and from the request's `context` (sent with each check):

```fga
condition non_expired_grant(current_time: timestamp, grant_time: timestamp, grant_duration: duration) {
  current_time >= grant_time && current_time < grant_time + grant_duration
}
condition from_office_network(user_ip: ipaddress, office_cidr: string) {
  user_ip.in_cidr(office_cidr)
}
condition in_allowed_regions(region: string, allowed_regions: list<string>) {
  region in allowed_regions
}
condition plan_allows(plan: map<string>, feature: string) {
  feature in plan && plan[feature] == "enabled"
}
```

The model uses them on users (`user with from_office_network`), on usersets (`team#member with non_expired_grant`, `org#member with plan_allows`), on wildcards (`user:* with non_expired_grant`), and next to unconditional grants of the same type.

Writing a conditional grant and checking it:

```ts
await fga.write({
  writes: [{
    user: 'user:remy', relation: 'contributor', object: 'project:roadmap',
    condition: { name: 'from_office_network', context: { office_cidr: '10.20.0.0/16' } },
  }],
})
await fga.check({ user: 'user:remy', relation: 'can_edit', object: 'project:roadmap', context: { user_ip: '10.20.1.1' } })
// { allowed: true }; with user_ip 203.0.113.9: { allowed: false }
```

A check, ListObjects or ListUsers that reaches a condition without all of its parameters fails with a validation error. It does not answer `false`, so send the context for every condition the query can reach. Parameters stored on the tuple win over the same names in the request: sending `office_cidr: "0.0.0.0/0"` can't widen remy's grant.

Tests: [conditions.fga.yaml](../authz/models/conditions.fga.yaml), "a team's temporary folder access should start exactly at grant_time", "… should end exactly at grant_time plus duration", "the office network should include both ends of its CIDR range", "nobody should export when the plan doesn't mention the feature", "a request should not be able to widen the network stored on the grant", "a team's temporary folder access should reach sub-folders, projects, lists and tasks while live"; integration, "[rpc:Check] should not reuse a cached answer across contexts (regression, v1.13.1)", "[rpc:Check] should keep the tuple's stored context over the same parameter in the request", "[rpc:Check] should fail when the condition is missing its context", "[rpc:ListObjects] should fail when the condition is missing its context", "[rpc:ListUsers] should fail when a reachable condition is missing its context". Docs: [Conditions](https://openfga.dev/docs/modeling/conditions).

### Modular models and `extend type`

A manifest, `fga.mod`, combines modules; a module can add relations to a type another module owns:

```yaml
# authz/models/fga.mod
schema: '1.2'
contents: [core.fga, conditions.fga, projects.fga, tasks.fga]
```

```fga
module tasks
extend type project
  relations
    define can_create_task: can_edit
    define exporter: [org#member with plan_allows]
    define can_export: exporter and can_view and member from org
```

`fga model write --file authz/models/fga.mod` writes the combined model. `fga model test` only accepts model files in the test file's own directory, which is why the tests sit next to the manifest.

Tests: [tasks.fga.yaml](../authz/models/tasks.fga.yaml), "a project editor should create tasks"; [conditions.fga.yaml](../authz/models/conditions.fga.yaml), "an exporter from another org should not export". Docs: [Modular models](https://openfga.dev/docs/modeling/modular-models).

## Calling OpenFGA from TypeScript

### Plain SDK and Effect, side by side

The integration suite calls OpenFGA with the plain [`@openfga/sdk`](https://github.com/openfga/js-sdk). The demo API ([`api/src/openfga.ts`](../api/src/openfga.ts)) wraps the same SDK in an [Effect](https://effect.website) service, adding a timeout that cancels the request, one retry policy and typed errors.

Plain SDK:

```ts
import { CredentialsMethod, OpenFgaClient } from '@openfga/sdk'

const fga = new OpenFgaClient({
  apiUrl: 'http://localhost:8080',
  storeId: process.env.FGA_STORE_ID,
  credentials: { method: CredentialsMethod.ApiToken, config: { token: process.env.FGA_KEY! } },
})

const { allowed } = await fga.check({ user: 'user:alice', relation: 'can_edit', object: 'project:roadmap' })
```

Effect, as in the demo API (simplified):

```ts
// Every SDK call: a 5 s timeout that aborts the HTTP request, and errors as values.
const sdk = <A>(what: string, call: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: call, catch: (err) => err }).pipe(
    Effect.timeoutOrElse({
      duration: '5 seconds',
      orElse: () => Effect.fail(new UpstreamError({ message: `${what}: timed out after 5s` })),
    }),
  )

const check = (tuple: Tuple) =>
  sdk('check', (signal) => client.check(tuple, { storeId, authorizationModelId, signal } as any)).pipe(
    Effect.mapError((err) => toError('check', err)), // FgaApiValidationError -> BadRequest, other -> UpstreamError
    Effect.map((res) => res.allowed === true),
  )
```

The real service also finds the store by name, pins its latest model, and looks both up again when OpenFGA says they're gone. It also closes idle connections after 4 s: the SDK's default agents keep them open forever, which stops a scale-to-zero instance from going to standby. `signal` works because the SDK passes per-call options through to axios, although its option types don't declare it.

### Check

Can this user do this to this object? Options: `contextualTuples` (tuples used for this request only, never stored), `context` (condition parameters), `consistency`, and the model ID.

```ts
await fga.check({
  user: 'user:dave', relation: 'can_view', object: 'project:roadmap',
  contextualTuples: [{ user: 'user:dave', relation: 'viewer', object: 'project:roadmap' }],
})
await fga.check({ user: 'user:late', relation: 'viewer', object: 'project:consistency' },
  { consistency: ConsistencyPreference.HigherConsistency })
```

Demo API: `GET /check?user=&relation=&object=[&consistency=HIGHER_CONSISTENCY]`.

Tests: "[rpc:Check] should let an owner who is an org member share the project", "[rpc:Check] should allow through a contextual tuple", "[rpc:Check] should not store the contextual tuple", "[rpc:Check] should see a write made after a cached denial", "[rpc:Check] should see a revocation made after a cached approval", "[rpc:Check] should answer with that model", "[rpc:Check] should reject an unknown model id", "[rpc:Check] should reject more than 100 contextual tuples", "[rpc:Check] should answer over gRPC like over HTTP".

### BatchCheck

Up to 50 checks in one call, each with a `correlationId` that keys its answer. Each check can carry its own `context`.

```ts
const res = await fga.batchCheck({
  checks: [
    { correlationId: 'a', user: 'user:alice', relation: 'can_edit', object: 'project:roadmap' },
    { correlationId: 'b', user: 'user:carol', relation: 'can_edit', object: 'project:roadmap' },
  ],
})
// res.result: [{ correlationId: 'a', allowed: true, ... }, { correlationId: 'b', allowed: false, ... }]
```

The client splits large batches itself. OpenFGA rejects a request with duplicate correlation IDs or more than 50 checks.

Demo API: `POST /batch-check`. Tests: "[rpc:BatchCheck] should answer each check under its correlation id", "[rpc:BatchCheck] should report the error on that item and answer the others", "[rpc:BatchCheck] should reject duplicate correlation ids", "[rpc:BatchCheck] should reject more than 50 checks".

### ListObjects and StreamedListObjects

Which objects of a type can the user reach? The answer includes objects reachable through public access, and honours conditions.

```ts
const { objects } = await fga.listObjects({ user: 'user:bob', relation: 'can_edit', type: 'project' })

for await (const item of fga.streamedListObjects({ user: 'user:alice', relation: 'can_view', type: 'project' })) {
  console.log(item.object) // same objects, streamed as they're found
}
```

Demo API: `GET /list-objects?user=&relation=&type=`. Tests: "[rpc:ListObjects] should list the projects a contributor can edit", "[rpc:ListObjects] should include public objects for any user", "[rpc:StreamedListObjects] should stream the same objects as ListObjects".

### ListUsers

Who can do this to this object? It returns users, wildcards (`user:*`) and usersets, filtered by exactly one `user_filters` type.

```ts
const { users } = await fga.listUsers({
  object: { type: 'project', id: 'roadmap' },
  relation: 'can_edit',
  user_filters: [{ type: 'user' }],
  context: { user_ip: '10.20.0.1' },
})
// [{ object: { type: 'user', id: 'alice' } }, ...]; a public grant comes back as { wildcard: { type: 'user' } }
```

Tests: "[rpc:ListUsers] should list direct, inherited and conditional editors", "[rpc:ListUsers] should return the wildcard for a public project", "[rpc:ListUsers] should accept only one user filter".

### Expand

The userset tree behind a relation: direct users as leaves, computed relations as unions, intersections and differences. Useful for debugging a model.

```ts
const { tree } = await fga.expand({ relation: 'member', object: 'project:roadmap' })
// tree.root.union.nodes: owner, contributor, viewer
```

Tests: "[rpc:Expand] should return a union node with one branch per relation", "[rpc:Expand] should return a difference whose base reaches the project folder".

### Write, Read and ReadChanges

```ts
await fga.write({ writes: [{ user: 'user:temp', relation: 'viewer', object: 'project:roadmap' }] })
await fga.write({ deletes: [{ user: 'user:temp', relation: 'viewer', object: 'project:roadmap' }] })

await fga.read({ object: 'project:docs' })                                     // every tuple on an object
await fga.read({ user: 'user:alice', object: 'project:' })                      // by user and type
await fga.read({ object: 'project:docs' }, { pageSize: 2 })                     // paged; continuation_token for the rest

await fga.readChanges({ type: 'task', startTime })                              // writes and deletes, in order
```

One Write request is all or nothing, with at most 100 tuples. By default, writing an existing tuple or deleting a missing one fails; you can ask OpenFGA to ignore those instead. `startTime` is compared with the server's clock, so take it from a server timestamp rather than from the client.

Tests: "[rpc:Write] should store a conditional tuple with its condition name and context", "[rpc:Write] should reject the duplicate by default", "[rpc:Write] should accept the duplicate with on_duplicate ignore", "[rpc:Write] should reject a user type the relation does not allow", "[rpc:Write] should write nothing when one tuple of the batch is invalid", "[rpc:Write] should reject more than 100 tuples in one request", "[rpc:Read] should return page_size tuples and a continuation token for the rest", "[rpc:ReadChanges] should exclude changes before it".

### Stores, models and assertions

- **Stores** (CreateStore, GetStore, ListStores with a name filter, DeleteStore). A deleted store disappears from lists and GetStore, but OpenFGA soft-deletes it, so checks against its ID can still answer. UpdateStore is declared in the API but not implemented: it is gRPC-only and returns `Unimplemented`.
- **Models** (WriteAuthorizationModel, ReadAuthorizationModel, ReadAuthorizationModels newest first). Models are immutable: each write creates a new ID, and checks use the latest model unless you pin one.
- **Assertions** (WriteAssertions, ReadAssertions): checks stored with a model, including contextual tuples and context. `OpenFgaClient.writeAssertions` in SDK 0.9.7 drops contextual tuples and context, so the tests use the raw `OpenFgaApi`.

Tests: the `[rpc:CreateStore]`, `[rpc:GetStore]`, `[rpc:ListStores]`, `[rpc:DeleteStore]`, `[rpc:UpdateStore]`, `[rpc:WriteAuthorizationModel]`, `[rpc:ReadAuthorizationModel]`, `[rpc:ReadAuthorizationModels]`, `[rpc:WriteAssertions]` and `[rpc:ReadAssertions]` tests in [`tests/integration/`](../tests/integration).

### AuthZEN (experimental)

OpenFGA v1.21 implements the [AuthZEN](https://openid.github.io/authzen/) authorization API behind the `authzen` experimental flag. Evaluation maps subject, action and resource onto a Check; the search endpoints map onto ListUsers and ListObjects. The local and CI stacks turn the flag on; the Unikraft deployment doesn't.

Tests: "[rpc:Evaluation] should decide true when the Check behind it allows", "[rpc:Evaluations] should decide each action in order", "[rpc:SubjectSearch] should find the subjects allowed an action (like ListUsers)", "[rpc:ResourceSearch] should find the resources a subject can reach (like ListObjects)", "[rpc:ActionSearch] should include an action the subject may take", "[rpc:GetConfiguration] should publish the per-store policy decision point and endpoints". The same flag set also enables inline `$expression` conditions: "[rpc:Write] should store a tuple that carries its own CEL expression".

## Operating OpenFGA

### Authentication

With `OPENFGA_AUTHN_METHOD=preshared`, every HTTP and gRPC call needs `Authorization: Bearer <key>`; health checks and Prometheus metrics don't. The Playground needs authentication off (`none`), so it runs only in the local optional profile.

Tests: "[rpc:ListStores] should answer 401 bearer_token_missing", "[rpc:Check] should answer 401", "[rpc:Check] should answer the check", "should answer SERVING without a key", "should count requests per gRPC method and code".

### The check cache and consistency

With `OPENFGA_CHECK_QUERY_CACHE_ENABLED=true` (the Unikraft deployment turns it on), OpenFGA reuses Check answers for `OPENFGA_CHECK_QUERY_CACHE_TTL`, 10 s by default. A Check right after a write can return the old answer; on Unikraft it did (see [RESULTS.md](RESULTS.md)). Pass `consistency: HIGHER_CONSISTENCY` for reads that must see a write, and keep the default, `MINIMIZE_LATENCY`, for everything else.

Tests: "[rpc:Check] should see a write made after a cached denial", "[rpc:Check] should see a revocation made after a cached approval"; [`scripts/check-e2e.sh`](../scripts/check-e2e.sh) does the same through the public API on Unikraft.

### Limits

| Limit | Value | Test |
| --- | --- | --- |
| Tuples per Write | 100 | "[rpc:Write] should reject more than 100 tuples in one request" |
| Checks per BatchCheck | 50 | "[rpc:BatchCheck] should reject duplicate correlation ids", "[rpc:BatchCheck] should reject more than 50 checks" |
| Contextual tuples per request | 100 | "[rpc:Check] should reject more than 100 contextual tuples" |
| Page size (Read and others) | 100 | "[rpc:Read] should reject a page size over 100" |
| `user_filters` per ListUsers | 1 | "[rpc:ListUsers] should accept only one user filter" |
| Resolution depth (cold cache) | 25 levels fail, 24 resolve | "[rpc:Check] should stop runaway recursion at 25 levels with a cold cache", "[rpc:Check] should resolve 24 levels" |
