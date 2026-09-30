/**
 * Test support for code that runs on the Rust account store.
 *
 * Every helper works on a per-test temp store file and a local mock token
 * endpoint; nothing here can reach `~/.anthropic-accounts` or a real
 * Anthropic endpoint. (The runner in scripts/test-isolated.ts also gives the
 * whole test process a sandbox HOME.)
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ANTHROPIC_OAUTH_TOKEN_URL_ENV,
  importHostOAuthCredential,
  SHARED_ACCOUNT_STORE_FILE_ENV,
} from '../../shared-account-store.ts'

/** A string the store accepts as an access token (`sk-ant-oat01-…`). */
export function fakeAccessToken(tag: string) {
  return `sk-ant-oat01-${tag.replace(/[^A-Za-z0-9_-]/g, '')}${'a'.repeat(24)}`
}

/** A string the store accepts as a refresh token (`sk-ant-ort01-…`). */
export function fakeRefreshToken(tag: string) {
  return `sk-ant-ort01-${tag.replace(/[^A-Za-z0-9_-]/g, '')}${'r'.repeat(24)}`
}

export type TempStore = {
  path: string
  dispose: () => void
}

/** Point the binding at a fresh temp store (via `ANTHROPIC_ACCOUNTS_FILE`). */
export function useTempStore(): TempStore {
  const dir = mkdtempSync(join(tmpdir(), 'anthropic-store-test-'))
  const path = join(dir, 'accounts.json')
  const previous = process.env[SHARED_ACCOUNT_STORE_FILE_ENV]
  process.env[SHARED_ACCOUNT_STORE_FILE_ENV] = path
  return {
    path,
    dispose: () => {
      if (previous === undefined)
        delete process.env[SHARED_ACCOUNT_STORE_FILE_ENV]
      else process.env[SHARED_ACCOUNT_STORE_FILE_ENV] = previous
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export type MockTokenServer = {
  url: string
  /** Refresh tokens presented, in order. */
  presented: string[]
  /** Refresh tokens that answer `invalid_grant`. */
  dead: Set<string>
  /** Refresh tokens that answer 503 (a transient failure). */
  unavailable: Set<string>
  /** Authorization-code exchanges received, in order. */
  codeExchanges: Array<Record<string, string>>
  /** Codes the authorization_code grant accepts, with the login they mint. */
  codes: Map<string, { email: string; accountUuid: string; tag: string }>
  /** The access token the n-th refresh (1-based) of this server returns. */
  rotatedAccess: (n: number) => string
  /** The refresh token the n-th refresh (1-based) of this server returns. */
  rotatedRefresh: (n: number) => string
  /** The access token a login with `codes` entry `tag` returns. */
  loginAccess: (tag: string) => string
  stop: () => void
}

let fixtureSequence = 0

/**
 * A per-call unique token tag. The Rust side remembers dead refresh tokens
 * process-wide, so two tests must never reuse a token string.
 */
function uniqueTag(tag: string) {
  fixtureSequence += 1
  return `${tag}${process.pid}x${fixtureSequence}`
}

/**
 * A mock OAuth token endpoint. The n-th refresh rotates to
 * `rotatedAccess(n)` / `rotatedRefresh(n)` (unique to this server) with an
 * 8 h access lifetime; tokens in `dead` answer 400 `invalid_grant`, tokens in
 * `unavailable` answer 503. The authorization_code grant accepts `codes`.
 */
export function startMockTokenServer(): MockTokenServer {
  const presented: string[] = []
  const dead = new Set<string>()
  const unavailable = new Set<string>()
  const codeExchanges: Array<Record<string, string>> = []
  const codes = new Map<
    string,
    { email: string; accountUuid: string; tag: string }
  >()
  let rotation = 0
  const nonce = uniqueTag('srv')
  const rotatedAccess = (n: number) => fakeAccessToken(`rot${n}${nonce}`)
  const rotatedRefresh = (n: number) => fakeRefreshToken(`rot${n}${nonce}`)
  const loginAccess = (tag: string) => fakeAccessToken(`login${tag}${nonce}`)
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json().catch(() => ({}))) as Record<
        string,
        string
      >
      if (body.grant_type === 'authorization_code') {
        codeExchanges.push(body)
        const login = codes.get(body.code ?? '')
        if (!login) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 })
        }
        return Response.json({
          access_token: loginAccess(login.tag),
          refresh_token: fakeRefreshToken(`login${login.tag}${nonce}`),
          expires_in: 28_800,
          refresh_token_expires_in: 30 * 86_400,
          scope: 'user:inference user:profile',
          account: { uuid: login.accountUuid, email_address: login.email },
          organization: { uuid: `org-${login.tag}` },
        })
      }
      if (body.grant_type !== 'refresh_token') {
        return Response.json(
          { error: 'unsupported_grant_type' },
          { status: 400 },
        )
      }
      const token = body.refresh_token ?? ''
      presented.push(token)
      if (unavailable.has(token)) {
        return new Response('upstream unavailable', { status: 503 })
      }
      if (dead.has(token)) {
        return Response.json(
          {
            error: 'invalid_grant',
            error_description: 'Refresh token not found or invalid',
          },
          { status: 400 },
        )
      }
      rotation += 1
      return Response.json({
        access_token: rotatedAccess(rotation),
        refresh_token: rotatedRefresh(rotation),
        expires_in: 28_800,
        refresh_token_expires_in: 30 * 86_400,
        scope: 'user:inference user:profile',
      })
    },
  })
  const previous = process.env[ANTHROPIC_OAUTH_TOKEN_URL_ENV]
  const url = `http://127.0.0.1:${server.port}/v1/oauth/token`
  process.env[ANTHROPIC_OAUTH_TOKEN_URL_ENV] = url
  return {
    url,
    presented,
    dead,
    unavailable,
    codeExchanges,
    codes,
    rotatedAccess,
    rotatedRefresh,
    loginAccess,
    stop: () => {
      if (previous === undefined)
        delete process.env[ANTHROPIC_OAUTH_TOKEN_URL_ENV]
      else process.env[ANTHROPIC_OAUTH_TOKEN_URL_ENV] = previous
      server.stop(true)
    },
  }
}

/** Add an OAuth row to the current temp store; resolves its store id. */
export async function seedStoreAccount(input: {
  label: string
  tag?: string
  expiresAt?: number
  refreshExpiresAt?: number
  email?: string
  accountUuid?: string
}): Promise<{ id: string; access: string; refresh: string }> {
  const tag = uniqueTag(input.tag ?? input.label.replace(/[^A-Za-z0-9]/g, ''))
  const access = fakeAccessToken(tag)
  const refresh = fakeRefreshToken(tag)
  const result = await importHostOAuthCredential({
    label: input.label,
    accessToken: access,
    refreshToken: refresh,
    expiresAt: input.expiresAt ?? Date.now() + 8 * 3_600_000,
    ...(input.refreshExpiresAt !== undefined
      ? { refreshExpiresAt: input.refreshExpiresAt }
      : {}),
    ...(input.email ? { email: input.email } : {}),
    ...(input.accountUuid ? { accountUuid: input.accountUuid } : {}),
  })
  if (result.status === 'invalid') throw new Error(result.message)
  return { id: result.accountId, access, refresh }
}
