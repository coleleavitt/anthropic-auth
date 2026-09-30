/**
 * Fallback-account credentials on the Rust store: refresh happens only in
 * Rust, at most once per token, and never merely because an idle account's
 * access token expired. Replaces the TS refresh-claim contention suite, whose
 * implementation was deleted.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  type AccountStorage,
  FallbackAccountManager,
  type OAuthAccount,
  saveAccounts,
} from '../accounts.ts'
import {
  ANTHROPIC_OAUTH_TOKEN_URL_ENV,
  listSharedAccounts,
  SHARED_ACCOUNT_STORE_FILE_ENV,
} from '../shared-account-store.ts'
import {
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
let hostDir: string
let configPath: string

beforeEach(() => {
  store = useTempStore()
  mock = startMockTokenServer()
  hostDir = mkdtempSync(join(tmpdir(), 'store-refresh-host-'))
  configPath = join(hostDir, 'anthropic-auth.json')
})

afterEach(() => {
  mock.stop()
  store.dispose()
  rmSync(hostDir, { recursive: true, force: true })
})

async function hostWith(
  ids: string[],
  overrides: Partial<AccountStorage> = {},
): Promise<AccountStorage> {
  const storage: AccountStorage = {
    version: 1,
    quota: { enabled: false },
    ...overrides,
    accounts: ids.map((id) => ({ id, type: 'oauth', label: id })),
  }
  await saveAccounts(storage, configPath)
  return storage
}

function oauth(id: string): OAuthAccount {
  return { id, type: 'oauth', label: id }
}

describe('only one caller spends a refresh token', () => {
  test('concurrent callers in one process share one refresh', async () => {
    const a = await seedStoreAccount({
      label: 'a',
      expiresAt: Date.now() - HOUR,
    })
    const first = new FallbackAccountManager({ configPath })
    const second = new FallbackAccountManager({ configPath })
    const results = await Promise.all([
      first.ensureAccessToken(oauth(a.id)),
      first.ensureAccessToken(oauth(a.id)),
      second.ensureAccessToken(oauth(a.id)),
      second.ensureAccessToken(oauth(a.id)),
    ])
    expect(mock.presented).toEqual([a.refresh])
    expect(new Set(results.map((account) => account.access))).toEqual(
      new Set([mock.rotatedAccess(1)]),
    )
  })

  test('a separate process racing for the same expired account does not spend it twice', async () => {
    const a = await seedStoreAccount({
      label: 'a',
      expiresAt: Date.now() - HOUR,
    })
    const module = resolve(import.meta.dir, '..', 'shared-account-store.ts')
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `const m = await import(${JSON.stringify(module)}); const t = await m.getSharedAccessToken(${JSON.stringify(a.id)}); console.log(t.accessToken)`,
      ],
      {
        env: {
          ...process.env,
          [SHARED_ACCOUNT_STORE_FILE_ENV]: store.path,
          [ANTHROPIC_OAUTH_TOKEN_URL_ENV]: mock.url,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const mine = await new FallbackAccountManager({
      configPath,
    }).ensureAccessToken(oauth(a.id))
    const childExit = await child.exited
    const childToken = (await new Response(child.stdout).text()).trim()
    expect(childExit).toBe(0)
    expect(mock.presented).toEqual([a.refresh])
    expect(childToken).toBe(mock.rotatedAccess(1))
    expect(mine.access).toBe(mock.rotatedAccess(1))
  })
})

describe('dead and failing tokens', () => {
  test('a dead token is excluded from routing and never re-presented', async () => {
    const a = await seedStoreAccount({
      label: 'a',
      expiresAt: Date.now() - HOUR,
    })
    mock.dead.add(a.refresh)
    const storage = await hostWith([a.id])
    const manager = new FallbackAccountManager({ configPath })

    expect(await manager.getUsableFallbackAccounts(storage)).toEqual([])
    expect(storage.accounts[0]).toMatchObject({
      lastRefreshError: { permanent: true },
    })
    expect(await manager.getUsableFallbackAccounts(storage)).toEqual([])
    expect(await manager.getUsableFallbackAccounts()).toEqual([])
    expect(mock.presented).toEqual([a.refresh])
    const [row] = await listSharedAccounts()
    expect(row?.refreshDead).toBe(true)
  })

  test('a transient failure backs off instead of hammering the endpoint', async () => {
    const a = await seedStoreAccount({
      label: 'a',
      expiresAt: Date.now() - HOUR,
    })
    mock.unavailable.add(a.refresh)
    const manager = new FallbackAccountManager({ configPath })
    const account = oauth(a.id)
    await expect(manager.ensureAccessToken(account)).rejects.toThrow()
    expect(account.lastRefreshError).toMatchObject({ permanent: false })
    expect(account.lastRefreshError?.nextRetryAt).toBeGreaterThan(Date.now())
    const presentedAfterFirst = mock.presented.length
    expect(presentedAfterFirst).toBeGreaterThan(0)
    await expect(manager.ensureAccessToken(account)).rejects.toThrow(
      /backed off/,
    )
    expect(mock.presented).toHaveLength(presentedAfterFirst)
    // The store row is untouched by a transient failure: not dead.
    const [row] = await listSharedAccounts()
    expect(row?.refreshDead).toBe(false)
  })
})

describe('keep-alive replaces background rotation', () => {
  test('an idle account with an expired access token is not refreshed by the tick', async () => {
    const idle = await seedStoreAccount({
      label: 'idle',
      expiresAt: Date.now() - HOUR,
      refreshExpiresAt: Date.now() + 25 * DAY,
    })
    await hostWith([idle.id], { quota: { enabled: true } })
    const quotaCalls: string[] = []
    const manager = new FallbackAccountManager({
      configPath,
      fetchImpl: (async (_input: unknown, init?: RequestInit) => {
        quotaCalls.push(String(new Headers(init?.headers).get('authorization')))
        return Response.json({})
      }) as unknown as typeof fetch,
    })
    const report = await manager.keepAliveTick()
    expect(report?.lease).toBe('acquired')
    expect(report?.refreshed).toEqual([])
    expect(mock.presented).toEqual([])
    // Quota polling does not wake the idle account either.
    expect(quotaCalls).toEqual([])
  })

  test('the tick refreshes an idle account whose refresh token is about to lapse', async () => {
    const lapsing = await seedStoreAccount({
      label: 'lapsing',
      expiresAt: Date.now() - HOUR,
      refreshExpiresAt: Date.now() + DAY,
    })
    await hostWith([lapsing.id])
    const report = await new FallbackAccountManager({
      configPath,
    }).keepAliveTick()
    expect(report?.refreshed.map((entry) => entry.accountId)).toEqual([
      lapsing.id,
    ])
    expect(mock.presented).toEqual([lapsing.refresh])
  })

  test('the tick polls quota for an account whose access token is live, without refreshing', async () => {
    const live = await seedStoreAccount({ label: 'live' })
    await hostWith([live.id], { quota: { enabled: true } })
    const bearers: string[] = []
    const manager = new FallbackAccountManager({
      configPath,
      fetchImpl: (async (_input: unknown, init?: RequestInit) => {
        bearers.push(String(new Headers(init?.headers).get('authorization')))
        return Response.json({
          five_hour: { utilization: 10 },
          seven_day: { utilization: 20 },
        })
      }) as unknown as typeof fetch,
    })
    await manager.keepAliveTick()
    expect(bearers).toEqual([`Bearer ${live.access}`])
    expect(mock.presented).toEqual([])
  })

  test('refresh.enabled=false turns the store keep-alive off', async () => {
    await seedStoreAccount({
      label: 'lapsing',
      expiresAt: Date.now() - HOUR,
      refreshExpiresAt: Date.now() + DAY,
    })
    await hostWith([], { refresh: { enabled: false } })
    const report = await new FallbackAccountManager({
      configPath,
    }).keepAliveTick()
    expect(report).toBeUndefined()
    expect(mock.presented).toEqual([])
  })
})

describe('request path', () => {
  test('an expired fallback is refreshed on demand, once, when routing needs it', async () => {
    const a = await seedStoreAccount({
      label: 'a',
      expiresAt: Date.now() - HOUR,
    })
    const storage = await hostWith([a.id])
    const manager = new FallbackAccountManager({ configPath })
    const usable = await manager.getUsableFallbackAccounts(storage)
    expect(usable.map((account) => account.access)).toEqual([
      mock.rotatedAccess(1),
    ])
    await manager.getUsableFallbackAccounts(storage)
    expect(mock.presented).toEqual([a.refresh])
  })

  test('a quota 401 makes the store re-authorize once and retries with the new bearer', async () => {
    const a = await seedStoreAccount({ label: 'a' })
    const storage = await hostWith([a.id], { quota: { enabled: true } })
    const bearers: string[] = []
    const manager = new FallbackAccountManager({
      configPath,
      fetchImpl: (async (_input: unknown, init?: RequestInit) => {
        const bearer = String(new Headers(init?.headers).get('authorization'))
        bearers.push(bearer)
        if (bearer === `Bearer ${a.access}`) {
          return new Response('unauthorized', { status: 401 })
        }
        return Response.json({
          five_hour: { utilization: 1 },
          seven_day: { utilization: 2 },
        })
      }) as unknown as typeof fetch,
    })
    const usable = await manager.getUsableFallbackAccounts(storage)
    expect(usable.map((account) => account.access)).toEqual([
      mock.rotatedAccess(1),
    ])
    expect(bearers).toEqual([
      `Bearer ${a.access}`,
      `Bearer ${mock.rotatedAccess(1)}`,
    ])
    expect(mock.presented).toEqual([a.refresh])
  })

  test('markUsed stamps the store row', async () => {
    const a = await seedStoreAccount({ label: 'a' })
    await hostWith([a.id])
    const before = Date.now()
    await new FallbackAccountManager({ configPath }).markUsed(oauth(a.id))
    const [row] = await listSharedAccounts()
    expect(row?.lastUsedAt).toBeGreaterThanOrEqual(before - 1000)
  })
})
