// Shared setup for the OpenFGA integration suite.
//
// Tests are BDD style: one observable behaviour per `it`, context in nested
// `describe('when …')` / `describe('given …')` blocks, GIVEN/WHEN/THEN comments
// in the body. A test that exercises an OpenFGA RPC is named
// `it('[rpc:<Name>] should …')` (the tag must be the prefix); other tests are
// `it('should …')`. scripts/check-api-coverage.py reads the passing test names
// and the server's own per-method metrics to prove every RPC was called and
// asserted.
//
// Target: FGA_API_URL / FGA_API_TOKEN (default: the local compose stack in this
// folder). Through the Unikraft tunnel: FGA_API_URL=http://localhost:18080.

import { execFileSync } from 'node:child_process'
import { Agent } from 'node:http'
import { fileURLToPath } from 'node:url'
import { CredentialsMethod, FgaApiValidationError, OpenFgaApi, OpenFgaClient, type AuthorizationModel } from '@openfga/sdk'

export const API_URL = process.env.FGA_API_URL ?? 'http://127.0.0.1:28080'
export const API_TOKEN = process.env.FGA_API_TOKEN ?? 'integration-key'
export const GRPC_ADDR = process.env.FGA_GRPC_ADDR ?? '127.0.0.1:28081'
export const METRICS_URL = process.env.FGA_METRICS_URL ?? 'http://127.0.0.1:22112/metrics'
// Experimental features (AuthZEN, inline expressions) are only enabled on the
// local/CI stack; the deployment doesn't turn them on.
export const EXPERIMENTAL = (process.env.FGA_EXPERIMENTAL ?? '1') === '1'
// OPENFGA_LIST_OBJECTS_MAX_RESULTS / OPENFGA_LIST_USERS_MAX_RESULTS of the
// target: 100 on the compose stack in this folder. Other targets (the
// deployment keeps the default, 1000) skip the truncation tests unless
// FGA_LIST_MAX_RESULTS is set.
export const LIST_MAX_RESULTS = Number(process.env.FGA_LIST_MAX_RESULTS ?? (process.env.FGA_API_URL ? 0 : 100))

const MANIFEST = fileURLToPath(new URL('../../authz/models/fga.mod', import.meta.url))

let cachedModel: Omit<AuthorizationModel, 'id'> | undefined

/** The demo model (authz/models), compiled to JSON by the fga CLI. */
export function demoModel(): Omit<AuthorizationModel, 'id'> {
  cachedModel ??= JSON.parse(
    execFileSync('fga', ['model', 'transform', '--file', MANIFEST, '--output-format', 'json'], { encoding: 'utf8' }),
  )
  return structuredClone(cachedModel!)
}

const credentials = { method: CredentialsMethod.ApiToken, config: { token: API_TOKEN } } as const

/** SDK client; no retries, so a failing call fails the test immediately. */
// Through the Unikraft tunnel, reusing a kept-alive connection fails now and
// then (the relay drops idle connections without telling the client: the next
// request stalls until the SDK's 10 s timeout or gets ECONNRESET). Remote runs
// open a connection per request instead; the local stack keeps the SDK's
// keep-alive.
const REMOTE = process.env.FGA_API_URL !== undefined
const baseOptions = REMOTE ? { httpAgent: new Agent({ keepAlive: false }) } : undefined

export function client(opts: { storeId?: string; authorizationModelId?: string; token?: string | null } = {}) {
  return new OpenFgaClient({
    apiUrl: API_URL,
    storeId: opts.storeId,
    authorizationModelId: opts.authorizationModelId,
    credentials:
      opts.token === null
        ? undefined
        : opts.token
          ? { method: CredentialsMethod.ApiToken, config: { token: opts.token } }
          : credentials,
    retryParams: { maxRetry: 0 },
    baseOptions,
  })
}

/** Raw API (no client-side chunking), for testing server-side limits. */
export function rawApi() {
  return new OpenFgaApi({ apiUrl: API_URL, credentials, retryParams: { maxRetry: 0 }, baseOptions })
}

/** A fresh store with the demo model; deleted by the returned cleanup. */
export async function freshStore(label: string) {
  const fga = client()
  const { id: storeId } = await fga.createStore({ name: `it-${label}-${Date.now()}` })
  const scoped = client({ storeId })
  const { authorization_model_id: modelId } = await scoped.writeAuthorizationModel(demoModel())
  return {
    storeId,
    modelId,
    fga: client({ storeId, authorizationModelId: modelId }),
    cleanup: () => client({ storeId }).deleteStore().catch(() => undefined),
  }
}

/** Raw HTTP call with the API key (for endpoints the SDK doesn't cover). */
export async function http(method: string, path: string, body?: unknown, token: string | null = API_TOKEN) {
  const res = await fetch(API_URL + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: res.status, body: json }
}

/** Runs `fn`, expecting it to throw; returns the error for assertions. */
export async function rejection(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn()
  } catch (err) {
    return err
  }
  throw new Error('expected the call to fail, but it succeeded')
}

/**
 * True for a 400 validation error. OpenFgaClient.write in transaction mode
 * wraps the API error in `cause`; other calls throw it directly.
 */
export function isValidationError(err: any): boolean {
  return err instanceof FgaApiValidationError || err?.cause instanceof FgaApiValidationError
}
