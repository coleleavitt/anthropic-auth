/**
 * The shared store as served by the Rust binding. Every test runs on a temp
 * store file and a local mock token endpoint (see support/store-fixture.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { refreshErrorFromSharedAccount } from '../accounts.ts'
import {
  ANTHROPIC_OAUTH_TOKEN_URL_ENV,
  anthropicAuthConfig,
  getSharedAccessToken,
  getSharedAccountStorePath,
  handleSharedUnauthorized,
  importHostOAuthCredential,
  isAnthropicAuthError,
  listSharedAccounts,
  pickSharedAccount,
  recordSharedAccountQuota,
  removeSharedAccount,
  reorderSharedAccounts,
  SHARED_ACCOUNT_STORE_DIR_ENV,
  SHARED_ACCOUNT_STORE_FILE_ENV,
  setSharedAccountEnabled,
  setSharedCurrentAccount,
  sharedKeepAliveOnce,
  startSharedLogin,
} from '../shared-account-store.ts'
import {
  fakeAccessToken,
  fakeRefreshToken,
  type MockTokenServer,
  seedStoreAccount,
  startMockTokenServer,
  type TempStore,
  useTempStore,
} from './support/store-fixture.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR

let store: TempStore
let mock: MockTokenServer

beforeEach(() => {
  store = useTempStore()
  mock = startMockTokenServer()
})

afterEach(() => {
  mock.stop()
  store.dispose()
})

describe('store path', () => {
  test('resolves explicit, file-env, then directory-env paths', () => {
    const file = process.env[SHARED_ACCOUNT_STORE_FILE_ENV]
    expect(getSharedAccountStorePath('/explicit/accounts.json')).toBe(
      '/explicit/accounts.json',
    )
    expect(getSharedAccountStorePath()).toBe(file as string)
    delete process.env[SHARED_ACCOUNT_STORE_FILE_ENV]
    process.env[SHARED_ACCOUNT_STORE_DIR_ENV] = '/tmp/store-dir'
    try {
      expect(getSharedAccountStorePath()).toBe(
        join('/tmp/store-dir', 'accounts.json'),
      )
    } finally {
      delete process.env[SHARED_ACCOUNT_STORE_DIR_ENV]
      process.env[SHARED_ACCOUNT_STORE_FILE_ENV] = file
    }
  })

  test('the binding is always handed the resolved store path and overrides', () => {
    const config = anthropicAuthConfig()
    expect(config.storePath).toBe(store.path)
    expect(config.tokenUrl).toBe(process.env[ANTHROPIC_OAUTH_TOKEN_URL_ENV])
  })
})

describe('listing and import', () => {
  test('imports a host credential once and never returns a token', async () => {
    const first = await importHostOAuthCredential({
      label: 'work',
      accessToken: fakeAccessToken('work'),
      refreshToken: fakeRefreshToken('work'),
      expiresAt: Date.now() + HOUR,
    })
    expect(first.status).toBe('added')
    const again = await importHostOAuthCredential({
      label: 'work',
      accessToken: fakeAccessToken('work'),
      refreshToken: fakeRefreshToken('work'),
      expiresAt: Date.now() + HOUR,
    })
    expect(again.status).toBe('already_present')

    const accounts = await listSharedAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({
      label: 'work',
      kind: 'oauth',
      enabled: true,
      current: true,
      accessLive: true,
      refreshDead: false,
    })
    expect(JSON.stringify(accounts)).not.toContain('sk-ant-')
    // The store file itself is owner-only.
    expect(statSync(store.path).mode & 0o777).toBe(0o600)
  })

  test('the store copy wins over a host copy of the same login', async () => {
    const seeded = await importHostOAuthCredential({
      label: 'work',
      accessToken: fakeAccessToken('storecopy'),
      refreshToken: fakeRefreshToken('storecopy'),
      expiresAt: Date.now() + HOUR,
      accountUuid: 'uuid-work',
      email: 'work@example.com',
    })
    const host = await importHostOAuthCredential({
      label: 'work-from-host',
      accessToken: fakeAccessToken('hostcopy'),
      refreshToken: fakeRefreshToken('hostcopy'),
      expiresAt: Date.now() + 2 * HOUR,
      accountUuid: 'uuid-work',
      email: 'work@example.com',
    })
    expect(host.status).toBe('kept')
    if (host.status === 'invalid' || seeded.status === 'invalid') {
      throw new Error('unexpected invalid import')
    }
    expect(host.accountId).toBe(seeded.accountId)
    const persisted = readFileSync(store.path, 'utf8')
    expect(persisted).toContain(fakeRefreshToken('storecopy'))
    expect(persisted).not.toContain(fakeRefreshToken('hostcopy'))
  })

  test('reports a malformed host credential as invalid instead of storing it', async () => {
    const result = await importHostOAuthCredential({
      label: 'yiyi',
      accessToken: 'yiyi-access',
      refreshToken: 'yiyi-refresh',
      expiresAt: Date.now() + HOUR,
    })
    expect(result.status).toBe('invalid')
    expect(await listSharedAccounts()).toHaveLength(0)
  })

  test('pickSharedAccount prefers an available current row, else the first available', async () => {
    const a = await seedStoreAccount({ label: 'a' })
    const b = await seedStoreAccount({ label: 'b' })
    await setSharedCurrentAccount(b.id)
    expect(pickSharedAccount(await listSharedAccounts())?.id).toBe(b.id)
    await setSharedAccountEnabled(b.id, false)
    expect(pickSharedAccount(await listSharedAccounts())?.id).toBe(a.id)
    await setSharedAccountEnabled(a.id, false)
    expect(pickSharedAccount(await listSharedAccounts())).toBeUndefined()
  })

  test('reorder and remove go through the store', async () => {
    const a = await seedStoreAccount({ label: 'a' })
    const b = await seedStoreAccount({ label: 'b' })
    await reorderSharedAccounts([b.id, a.id])
    expect((await listSharedAccounts()).map((row) => row.id)).toEqual([
      b.id,
      a.id,
    ])
    expect(await removeSharedAccount(a.id)).toBe(true)
    expect((await listSharedAccounts()).map((row) => row.id)).toEqual([b.id])
  })

  test('an exhausted quota reading makes the row unavailable', async () => {
    const a = await seedStoreAccount({ label: 'a' })
    await recordSharedAccountQuota(a.id, {
      fiveHourPercent: 10,
      sevenDayPercent: 100,
    })
    const [row] = await listSharedAccounts()
    expect(row?.quota?.sevenDayPercent).toBe(100)
    expect(row?.available).toBe(false)
  })
})

describe('access tokens', () => {
  test('a live stored token is returned without touching the token endpoint', async () => {
    const a = await seedStoreAccount({ label: 'a' })
    const token = await getSharedAccessToken(a.id)
    expect(token).toMatchObject({
      accountId: a.id,
      accessToken: a.access,
      source: 'store',
    })
    expect(mock.presented).toEqual([])
    expect(JSON.stringify(token)).not.toContain('sk-ant-ort')
  })

  test('an expired token is refreshed once, in Rust, and the rotation is stored', async () => {
    const a = await seedStoreAccount({
      label: 'a',
      expiresAt: Date.now() - HOUR,
    })
    const token = await getSharedAccessToken(a.id)
    expect(token.source).toBe('refreshed')
    expect(token.accessToken).toBe(mock.rotatedAccess(1))
    expect(mock.presented).toEqual([a.refresh])
    const persisted = readFileSync(store.path, 'utf8')
    expect(persisted).toContain(mock.rotatedRefresh(1))
    expect(persisted).not.toContain(a.refresh)

    const again = await getSharedAccessToken(a.id)
    expect(again.source).toBe('store')
    expect(mock.presented).toHaveLength(1)
  })

  test('a dead refresh token is reported once and never re-presented', async () => {
    const a = await seedStoreAccount({
      label: 'a',
      expiresAt: Date.now() - HOUR,
    })
    mock.dead.add(a.refresh)
    const first = await getSharedAccessToken(a.id).catch((error) => error)
    expect(isAnthropicAuthError(first, 'invalid_grant')).toBe(true)
    const second = await getSharedAccessToken(a.id).catch((error) => error)
    expect(isAnthropicAuthError(second, 'invalid_grant')).toBe(true)
    expect(mock.presented).toEqual([a.refresh])

    const [row] = await listSharedAccounts()
    expect(row?.refreshDead).toBe(true)
    expect(refreshErrorFromSharedAccount(row!)).toMatchObject({
      permanent: true,
      status: 400,
    })
  })

  test('a 401 on a stored bearer triggers one claimed refresh and a retry', async () => {
    const a = await seedStoreAccount({ label: 'a' })
    const result = await handleSharedUnauthorized(a.access)
    expect(result.retry).toBe(true)
    expect(result.token?.accountId).toBe(a.id)
    expect(result.token?.accessToken).toBe(mock.rotatedAccess(1))
    expect(mock.presented).toEqual([a.refresh])
  })
})

describe('keep-alive', () => {
  test('refreshes only an idle row whose refresh token is about to lapse', async () => {
    const lapsing = await seedStoreAccount({
      label: 'lapsing',
      expiresAt: Date.now() - HOUR,
      refreshExpiresAt: Date.now() + DAY,
    })
    const healthy = await seedStoreAccount({
      label: 'healthy',
      expiresAt: Date.now() - HOUR,
      refreshExpiresAt: Date.now() + 25 * DAY,
    })
    const inSession = await seedStoreAccount({
      label: 'in-session',
      expiresAt: Date.now() + HOUR,
      refreshExpiresAt: Date.now() + DAY,
    })
    const report = await sharedKeepAliveOnce({ spacingMs: 0 })
    expect(report.lease).toBe('acquired')
    expect(report.refreshed.map((entry) => entry.accountId)).toEqual([
      lapsing.id,
    ])
    expect(mock.presented).toEqual([lapsing.refresh])
    const skipped = new Map(
      report.skipped.map((entry) => [entry.accountId, entry.reason]),
    )
    expect(skipped.has(healthy.id)).toBe(true)
    expect(skipped.get(inSession.id)).toBe('session_live')
  })
})

describe('login', () => {
  test('exchanges the code in Rust and stores the account', async () => {
    mock.codes.set('the-code', {
      email: 'new@example.com',
      accountUuid: 'uuid-new',
      tag: 'new',
    })
    const login = startSharedLogin({ mode: 'max' })
    expect(new URL(login.url).searchParams.get('state')).toBe(login.state)
    const account = await login.complete({
      callback: `the-code#${login.state}`,
      label: 'New',
      setCurrent: true,
    })
    expect(account).toMatchObject({
      label: 'New',
      email: 'new@example.com',
      accountUuid: 'uuid-new',
      current: true,
      accessLive: true,
    })
    expect(JSON.stringify(account)).not.toContain('sk-ant-')
    expect(mock.codeExchanges).toHaveLength(1)
    expect(mock.codeExchanges[0]?.code_verifier).toBeTruthy()
    const token = await getSharedAccessToken(account.id)
    expect(token.accessToken).toBe(mock.loginAccess('new'))
  })

  test('a callback with a foreign state is refused before any exchange', async () => {
    mock.codes.set('the-code', {
      email: 'x@example.com',
      accountUuid: 'uuid-x',
      tag: 'x',
    })
    const login = startSharedLogin({ mode: 'max' })
    await expect(
      login.complete({ callback: 'the-code#not-the-state' }),
    ).rejects.toThrow()
    expect(mock.codeExchanges).toHaveLength(0)
    expect(await listSharedAccounts()).toHaveLength(0)
  })

  test('a loopback login advertises its own redirect URI in the authorize URL', () => {
    const login = startSharedLogin({
      mode: 'max',
      redirectUri: 'http://localhost:54545/callback',
    })
    expect(new URL(login.url).searchParams.get('redirect_uri')).toBe(
      'http://localhost:54545/callback',
    )
  })
})
