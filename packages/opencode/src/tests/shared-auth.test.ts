import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  addSharedApiKey,
  createEmptyStorage,
  type FallbackAccount,
  listSharedAccounts,
  loadAccounts,
  STORE_MANAGED_REFRESH_PLACEHOLDER,
  saveAccounts,
  setSharedAccountEnabled,
  setSharedCurrentAccount,
  WifAuth,
} from '@cortexkit/anthropic-auth-core'
import {
  fakeAccessToken,
  fakeRefreshToken,
  type MockTokenServer,
  seedStoreAccount,
  startMockTokenServer,
  type TempStore,
  useTempStore,
} from '../../../core/src/tests/support/store-fixture.ts'
import {
  reconcileAnthropicAuth,
  resetHostCredentialMigrationForTests,
  type SetOpenCodeAuth,
} from '../shared-auth.ts'

const originalOAuth = process.env.ANTHROPIC_OAUTH_TOKEN
const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN
const originalApiKey = process.env.ANTHROPIC_API_KEY

// Every test runs against a temp store and a mock token endpoint, so any
// refresh the store performs lands on the mock.
let store: TempStore
let tokenServer: MockTokenServer
let hostSequence = 0

function workloadIdentity() {
  return new WifAuth(
    {
      federationRuleId: 'rule',
      organizationId: 'org',
      serviceAccountId: 'service',
      identityToken: { type: 'inline', token: 'header.payload.signature' },
      baseURL: 'https://api.anthropic.com',
    },
    {
      fetchImpl: (() => {
        throw new Error('token exchange should not run during resolution')
      }) as unknown as typeof fetch,
    },
  )
}

/** A well-formed host credential with tokens unique to this test run. */
function hostCredential(
  overrides: { accountId?: string; email?: string } = {},
) {
  hostSequence += 1
  const tag = `host${process.pid}n${hostSequence}`
  return {
    type: 'oauth' as const,
    access: fakeAccessToken(tag),
    refresh: fakeRefreshToken(tag),
    expires: Date.now() + 3_600_000,
    ...overrides,
  }
}

beforeEach(() => {
  delete process.env.ANTHROPIC_OAUTH_TOKEN
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.ANTHROPIC_API_KEY
  resetHostCredentialMigrationForTests()
  store = useTempStore()
  tokenServer = startMockTokenServer()
})

afterEach(() => {
  tokenServer.stop()
  store.dispose()
  if (originalOAuth === undefined) delete process.env.ANTHROPIC_OAUTH_TOKEN
  else process.env.ANTHROPIC_OAUTH_TOKEN = originalOAuth
  if (originalAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
  else process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = originalApiKey
})

describe('OpenCode auth over the account store', () => {
  test('moves OpenCode OAuth into the store once and leaves a placeholder in auth.json', async () => {
    const host = hostCredential()
    const setOpenCodeAuth = mock<SetOpenCodeAuth>(async () => {})

    const first = await reconcileAnthropicAuth({
      openCodeAuth: host,
      legacyAccounts: [],
      setOpenCodeAuth,
    })
    expect(first.auth).toMatchObject({
      type: 'oauth',
      access: host.access,
      source: 'shared',
    })
    expect(first.auth?.sharedAccountId).toBeString()
    const rows = await listSharedAccounts()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.current).toBe(true)

    // The host copy of the refresh token is replaced, never re-imported.
    expect(setOpenCodeAuth).toHaveBeenCalledTimes(1)
    expect(setOpenCodeAuth.mock.calls[0]?.[0]).toEqual({
      type: 'oauth',
      access: host.access,
      refresh: STORE_MANAGED_REFRESH_PLACEHOLDER,
      expires: host.expires,
    })
    await reconcileAnthropicAuth({
      openCodeAuth: host,
      legacyAccounts: [],
      setOpenCodeAuth,
    })
    expect(setOpenCodeAuth).toHaveBeenCalledTimes(1)
    expect(await listSharedAccounts()).toHaveLength(1)
    // No refresh was spent to resolve a live credential.
    expect(tokenServer.presented).toEqual([])
  })

  test("the store's copy wins over a host credential for the same login", async () => {
    const seeded = await seedStoreAccount({
      label: 'work',
      email: 'work@example.com',
      accountUuid: 'acct-work',
    })
    const host = hostCredential({
      accountId: 'acct-work',
      email: 'work@example.com',
    })

    const reconciled = await reconcileAnthropicAuth({
      openCodeAuth: host,
      legacyAccounts: [],
    })
    expect(reconciled.auth).toMatchObject({
      type: 'oauth',
      access: seeded.access,
      sharedAccountId: seeded.id,
      source: 'shared',
    })
    expect(await listSharedAccounts()).toHaveLength(1)
  })

  test('a host credential the store cannot parse is used as a static bearer', async () => {
    const setOpenCodeAuth = mock<SetOpenCodeAuth>(async () => {})
    const reconciled = await reconcileAnthropicAuth({
      openCodeAuth: {
        type: 'oauth',
        access: 'test-access-token',
        refresh: 'test-refresh-token',
        expires: Date.now() + 60_000,
      },
      legacyAccounts: [],
      setOpenCodeAuth,
    })
    expect(reconciled.auth).toMatchObject({
      type: 'oauth',
      access: 'test-access-token',
      source: 'opencode',
    })
    expect(reconciled.auth?.sharedAccountId).toBeUndefined()
    expect(setOpenCodeAuth).not.toHaveBeenCalled()
    expect(await listSharedAccounts()).toEqual([])
  })

  test('an expired store main is refreshed by the store, exactly once', async () => {
    const seeded = await seedStoreAccount({
      label: 'expired',
      expiresAt: Date.now() - 1_000,
    })
    const reconciled = await reconcileAnthropicAuth({
      openCodeAuth: {
        type: 'oauth',
        access: 'stale',
        refresh: STORE_MANAGED_REFRESH_PLACEHOLDER,
      },
      legacyAccounts: [],
    })
    expect(reconciled.auth).toMatchObject({
      type: 'oauth',
      access: tokenServer.rotatedAccess(1),
      sharedAccountId: seeded.id,
    })
    expect(tokenServer.presented).toEqual([seeded.refresh])
  })

  test("a dead store main carries the store's invalid_grant verdict", async () => {
    const seeded = await seedStoreAccount({
      label: 'dead',
      expiresAt: Date.now() - 1_000,
    })
    tokenServer.dead.add(seeded.refresh)
    const reconciled = await reconcileAnthropicAuth({
      openCodeAuth: { type: 'wellknown' },
      legacyAccounts: [],
    })
    expect(reconciled.auth?.type).toBe('oauth')
    if (reconciled.auth?.type !== 'oauth') throw new Error('expected oauth')
    expect(reconciled.auth.access).toBe('')
    expect(reconciled.auth.refreshError?.permanent).toBe(true)
    expect(tokenServer.presented).toEqual([seeded.refresh])
  })

  test('a placeholder host credential is not imported and a disabled store row is not resurrected', async () => {
    const seeded = await seedStoreAccount({ label: 'blocked' })
    await setSharedAccountEnabled(seeded.id, false)
    const reconciled = await reconcileAnthropicAuth({
      openCodeAuth: {
        type: 'oauth',
        access: seeded.access,
        refresh: STORE_MANAGED_REFRESH_PLACEHOLDER,
        expires: Date.now() + 60_000,
      },
      legacyAccounts: [],
    })
    // The access token in auth.json is a copy of the store's: until it
    // expires it is still usable, but nothing refreshes it outside the store.
    expect(reconciled.auth).toMatchObject({
      type: 'oauth',
      access: seeded.access,
      source: 'opencode',
    })
    expect(reconciled.sharedMain).toBeUndefined()
    expect((await listSharedAccounts())[0]?.enabled).toBe(false)
  })

  test('supports environment credentials and WIF only after the store and host', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-api-key'
    const api = await reconcileAnthropicAuth({
      openCodeAuth: { type: 'wellknown' },
      legacyAccounts: [],
    })
    expect(api.auth).toEqual({
      type: 'api',
      key: 'env-api-key',
      source: 'environment',
    })

    delete process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_OAUTH_TOKEN = 'env-oauth'
    const oauth = await reconcileAnthropicAuth({
      openCodeAuth: { type: 'wellknown' },
      legacyAccounts: [],
    })
    expect(oauth.auth).toMatchObject({
      type: 'oauth',
      access: 'env-oauth',
      source: 'environment',
    })

    delete process.env.ANTHROPIC_OAUTH_TOKEN
    const provider = workloadIdentity()
    const wif = await reconcileAnthropicAuth({
      openCodeAuth: { type: 'wellknown' },
      legacyAccounts: [],
      wifAuth: provider,
    })
    expect(wif.auth).toMatchObject({ type: 'wif', provider, source: 'wif' })

    await seedStoreAccount({ label: 'canonical' })
    const canonical = await reconcileAnthropicAuth({
      openCodeAuth: { type: 'wellknown' },
      legacyAccounts: [],
      wifAuth: provider,
    })
    expect(canonical.auth?.source).toBe('shared')
  })

  test('uses an OpenCode API key when the store holds no OAuth account', async () => {
    const reconciled = await reconcileAnthropicAuth({
      openCodeAuth: { type: 'api', key: 'host-key' },
      legacyAccounts: [],
    })
    expect(reconciled.auth).toEqual({
      type: 'api',
      key: 'host-key',
      source: 'opencode',
    })
  })

  test('uses a store API key instead of stale host OAuth', async () => {
    const key = 'sk-ant-api03-storemainstoremainstoremainMAIN'
    await addSharedApiKey({ label: 'api-main', key })
    const reconciled = await reconcileAnthropicAuth({
      openCodeAuth: hostCredential(),
      legacyAccounts: [],
    })
    expect(reconciled.auth).toEqual({
      type: 'api',
      key,
      sharedAccountId: 'api-main',
      source: 'shared',
    })
    expect(reconciled.sharedMain?.kind).toBe('api_key')
    // The listing never carries the key, only its suffix.
    expect(JSON.stringify(reconciled.accounts)).not.toContain(key)
    expect(
      reconciled.accounts.find((row) => row.id === 'api-main')?.apiKeySuffix,
    ).toBe('MAIN')
  })

  test('store API keys are first-party fallbacks and never reach the host files', async () => {
    const main = await seedStoreAccount({ label: 'oauth-main' })
    await setSharedCurrentAccount(main.id)
    const key = 'sk-ant-api03-fallbackfallbackfallbackfbKEY1'
    await addSharedApiKey({ label: 'console-key', key })
    const reconciled = await reconcileAnthropicAuth({
      openCodeAuth: { type: 'wellknown' },
      legacyAccounts: [],
    })
    expect(reconciled.sharedMain?.id).toBe(main.id)
    expect(reconciled.fallbacks).toEqual([
      expect.objectContaining({
        id: 'console-key',
        type: 'api',
        apiKey: key,
        baseURL: 'https://api.anthropic.com',
        authHeader: 'x-api-key',
        storeManaged: true,
      }),
    ])
    const dir = await mkdtemp(join(tmpdir(), 'opencode-store-key-'))
    try {
      const path = join(dir, 'anthropic-auth.json')
      await saveAccounts(
        { ...createEmptyStorage(), accounts: reconciled.fallbacks },
        path,
      )
      const written = [
        await readFile(path, 'utf8'),
        await readFile(join(dir, 'anthropic-auth-state.json'), 'utf8').catch(
          () => '',
        ),
      ].join('\n')
      expect(written).not.toContain(key)
      const reloaded = await loadAccounts(path)
      expect(reloaded?.accounts[0]).toMatchObject({
        id: 'console-key',
        storeManaged: true,
      })
      expect(reloaded?.accounts[0]).not.toHaveProperty('apiKey', key)
      // Reconciling over the reloaded host list hydrates the key again.
      const again = await reconcileAnthropicAuth({
        openCodeAuth: { type: 'wellknown' },
        legacyAccounts: reloaded?.accounts ?? [],
      })
      expect(again.fallbacks[0]).toMatchObject({
        id: 'console-key',
        apiKey: key,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('fallbacks are the host list over the store, minus main', async () => {
    const main = await seedStoreAccount({ label: 'main-acct' })
    const second = await seedStoreAccount({ label: 'second' })
    const third = await seedStoreAccount({ label: 'third' })
    const legacy: FallbackAccount[] = [
      {
        id: 'route',
        type: 'api',
        apiKey: 'route-key',
        baseURL: 'https://api.example.com',
      },
      { id: third.id, type: 'oauth', label: 'Third (host label)' },
      { id: 'gone', type: 'oauth', label: 'removed elsewhere' },
    ]
    const reconciled = await reconcileAnthropicAuth({
      openCodeAuth: { type: 'wellknown' },
      legacyAccounts: legacy,
    })
    expect(reconciled.sharedMain?.id).toBe(main.id)
    expect(reconciled.fallbacks.map((account) => account.id)).toEqual([
      'route',
      third.id,
      second.id,
    ])
    for (const account of reconciled.fallbacks) {
      expect(account).not.toHaveProperty('refresh')
      if (account.type === 'oauth') expect(account.access).toBeUndefined()
    }
  })
})
