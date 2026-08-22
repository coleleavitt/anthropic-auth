import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  loadSharedAccountStore,
  type SharedAnthropicAccount,
  saveSharedAccountStore,
  WifAuth,
} from '@cortexkit/anthropic-auth-core'
import {
  persistConnectedAnthropicAuth,
  persistRefreshedSharedOAuth,
  reconcileAnthropicAuth,
} from '../shared-auth.ts'

const tempDirectories: string[] = []
const originalOAuth = process.env.ANTHROPIC_OAUTH_TOKEN
const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN
const originalApiKey = process.env.ANTHROPIC_API_KEY

async function storePath() {
  const directory = await mkdtemp(join(tmpdir(), 'opencode-shared-auth-'))
  tempDirectories.push(directory)
  return join(directory, 'accounts.json')
}

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

function oauthAccount(
  id: string,
  access = 'shared-access',
): SharedAnthropicAccount {
  return {
    id,
    credential: {
      type: 'oauth',
      access,
      refresh: 'shared-refresh',
      expires_at: 2_000_000_000_000,
      scopes: ['user:inference'],
    },
    enabled: true,
    created_at: '2026-08-14T00:00:00.000Z',
  }
}

afterEach(async () => {
  if (originalOAuth === undefined) delete process.env.ANTHROPIC_OAUTH_TOKEN
  else process.env.ANTHROPIC_OAUTH_TOKEN = originalOAuth
  if (originalAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
  else process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = originalApiKey
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('OpenCode shared Anthropic auth adapter', () => {
  test('adopts OpenCode OAuth as current when the shared store is empty', async () => {
    const path = await storePath()
    const reconciled = await reconcileAnthropicAuth({
      openCodeAuth: {
        type: 'oauth',
        accountId: 'account-1',
        access: 'host-access',
        refresh: 'host-refresh',
        expires: 2_000_000_000_000,
      },
      legacyAccounts: [
        {
          id: 'legacy-fallback',
          type: 'oauth',
          access: 'legacy-access',
          refresh: 'legacy-refresh',
          expires: 2_000_000_000_000,
        },
      ],
      options: { path, legacyPaths: [] },
    })

    expect(reconciled.auth).toMatchObject({
      type: 'oauth',
      access: 'host-access',
      sharedAccountId: 'account-1',
      source: 'shared',
    })
    expect(reconciled.fallbacks).toEqual([
      expect.objectContaining({ id: 'legacy-fallback', type: 'oauth' }),
    ])
    const loaded = await loadSharedAccountStore({ path, legacyPaths: [] })
    expect(loaded.store.current).toBe('account-1')
    expect(loaded.store.accounts.map((account) => account.id)).toEqual([
      'account-1',
      'legacy-fallback',
    ])
  })

  test('honors ordered-first semantics for an unpinned canonical store', async () => {
    const path = await storePath()
    await saveSharedAccountStore(
      {
        version: 1,
        accounts: [oauthAccount('fallback-only', 'fallback-access')],
      },
      { path },
    )

    const reconciled = await reconcileAnthropicAuth({
      openCodeAuth: {
        type: 'oauth',
        access: 'host-access',
        refresh: 'host-refresh',
        expires: 2_100_000_000_000,
      },
      legacyAccounts: [],
      options: { path, legacyPaths: [] },
    })

    expect(reconciled.auth).toMatchObject({
      type: 'oauth',
      access: 'fallback-access',
      source: 'shared',
    })
    expect(reconciled.fallbacks).toEqual([])
  })

  test('uses canonical API-key credentials instead of stale host OAuth', async () => {
    const path = await storePath()
    await saveSharedAccountStore(
      {
        version: 1,
        current: 'api-main',
        accounts: [
          {
            id: 'api-main',
            credential: { type: 'api_key', key: 'canonical-api-key' },
            enabled: true,
            created_at: '2026-08-14T00:00:00.000Z',
          },
        ],
      },
      { path },
    )

    const reconciled = await reconcileAnthropicAuth({
      openCodeAuth: {
        type: 'oauth',
        access: 'stale-host-access',
        refresh: 'stale-host-refresh',
        expires: 2_000_000_000_000,
      },
      legacyAccounts: [],
      options: { path, legacyPaths: [] },
    })
    expect(reconciled.auth).toEqual({
      type: 'api',
      key: 'canonical-api-key',
      sharedAccountId: 'api-main',
      source: 'shared',
    })
  })

  test('synchronizes a newer OpenCode token rotation for an adopted main account', async () => {
    const path = await storePath()
    await reconcileAnthropicAuth({
      openCodeAuth: {
        type: 'oauth',
        access: 'first-access',
        refresh: 'first-refresh',
        expires: 1_900_000_000_000,
      },
      legacyAccounts: [],
      options: { path, legacyPaths: [] },
    })
    const reconciled = await reconcileAnthropicAuth({
      openCodeAuth: {
        type: 'oauth',
        access: 'rotated-access',
        refresh: 'rotated-refresh',
        expires: 2_000_000_000_000,
      },
      legacyAccounts: [],
      options: { path, legacyPaths: [] },
    })

    expect(reconciled.auth).toMatchObject({
      type: 'oauth',
      access: 'rotated-access',
      refresh: 'rotated-refresh',
      source: 'shared',
    })
  })

  test('supports inherited OAuth and API-key environment credentials without persisting them', async () => {
    const oauthPath = await storePath()
    delete process.env.ANTHROPIC_AUTH_TOKEN
    process.env.ANTHROPIC_OAUTH_TOKEN = 'environment-oauth'
    process.env.ANTHROPIC_API_KEY = 'environment-api-key'
    const oauth = await reconcileAnthropicAuth({
      openCodeAuth: { type: 'wellknown' },
      legacyAccounts: [],
      options: { path: oauthPath, legacyPaths: [] },
    })
    expect(oauth.auth).toMatchObject({
      type: 'oauth',
      access: 'environment-oauth',
      source: 'environment',
    })
    expect(
      (await loadSharedAccountStore({ path: oauthPath, legacyPaths: [] }))
        .source.type,
    ).toBe('empty')

    delete process.env.ANTHROPIC_OAUTH_TOKEN
    process.env.ANTHROPIC_AUTH_TOKEN = 'standard-auth-token'
    const authTokenPath = await storePath()
    const authToken = await reconcileAnthropicAuth({
      openCodeAuth: { type: 'wellknown' },
      legacyAccounts: [],
      options: { path: authTokenPath, legacyPaths: [] },
    })
    expect(authToken.auth).toMatchObject({
      type: 'oauth',
      access: 'standard-auth-token',
      source: 'environment',
    })

    delete process.env.ANTHROPIC_AUTH_TOKEN
    const apiPath = await storePath()
    const api = await reconcileAnthropicAuth({
      openCodeAuth: { type: 'wellknown' },
      legacyAccounts: [],
      options: { path: apiPath, legacyPaths: [] },
    })
    expect(api.auth).toEqual({
      type: 'api',
      key: 'environment-api-key',
      source: 'environment',
    })
  })

  test('uses WIF only after canonical, host, and ordinary environment auth', async () => {
    delete process.env.ANTHROPIC_OAUTH_TOKEN
    delete process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    const path = await storePath()
    const provider = workloadIdentity()
    const wif = await reconcileAnthropicAuth({
      openCodeAuth: { type: 'wellknown' },
      legacyAccounts: [],
      wifAuth: provider,
      options: { path, legacyPaths: [] },
    })
    expect(wif.auth).toMatchObject({
      type: 'wif',
      provider,
      source: 'wif',
    })

    await saveSharedAccountStore(
      { version: 1, accounts: [oauthAccount('canonical')] },
      { path },
    )
    const canonical = await reconcileAnthropicAuth({
      openCodeAuth: { type: 'wellknown' },
      legacyAccounts: [],
      wifAuth: provider,
      options: { path, legacyPaths: [] },
    })
    expect(canonical.auth?.type).toBe('oauth')
    expect(canonical.auth?.source).toBe('shared')
  })

  test('a disabled canonical match blocks stale host credential resurrection', async () => {
    const path = await storePath()
    const blocked = oauthAccount('blocked', 'host-access')
    blocked.enabled = false
    if (blocked.credential.type === 'oauth') {
      blocked.credential.refresh = 'host-refresh'
    }
    await saveSharedAccountStore({ version: 1, accounts: [blocked] }, { path })
    const reconciled = await reconcileAnthropicAuth({
      openCodeAuth: {
        type: 'oauth',
        accountId: 'blocked',
        access: 'different-stale-access',
        refresh: 'different-stale-refresh',
        expires: 2_000_000_000_000,
      },
      legacyAccounts: [],
      options: { path, legacyPaths: [] },
    })
    expect(reconciled.auth).toBeNull()
  })

  test('preserves canonical metadata when reconnecting the same OAuth account', async () => {
    const path = await storePath()
    await saveSharedAccountStore(
      {
        version: 1,
        current: 'connected',
        accounts: [
          {
            id: 'connected',
            label: 'Work',
            email: 'me@example.com',
            credential: {
              type: 'oauth',
              access: 'old-access',
              refresh: 'old-refresh',
              expires_at: 1_900_000_000_000,
              scopes: ['user:profile', 'user:inference'],
              account: {
                uuid: 'connected',
                email_address: 'me@example.com',
              },
              organization: { uuid: 'org-1' },
            },
            enabled: true,
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
      { path },
    )

    await persistConnectedAnthropicAuth(
      {
        type: 'oauth',
        accountId: 'connected',
        access: 'new-access',
        refresh: 'new-refresh',
        expires: 2_000_000_000_000,
      },
      { path, legacyPaths: [] },
    )

    const account = (await loadSharedAccountStore({ path, legacyPaths: [] }))
      .store.accounts[0]
    expect(account).toMatchObject({
      label: 'Work',
      email: 'me@example.com',
      created_at: '2026-01-01T00:00:00.000Z',
      credential: {
        access: 'new-access',
        refresh: 'new-refresh',
        scopes: ['user:profile', 'user:inference'],
        account: { uuid: 'connected', email_address: 'me@example.com' },
        organization: { uuid: 'org-1' },
      },
    })
  })

  test('persists explicit connections and rotated OAuth tokens', async () => {
    const path = await storePath()
    await persistConnectedAnthropicAuth(
      {
        type: 'oauth',
        accountId: 'connected',
        access: 'first-access',
        refresh: 'first-refresh',
        expires: 1_900_000_000_000,
        refreshTokenExpiresAt: 2_100_000_000_000,
      },
      { path, legacyPaths: [] },
    )
    await persistRefreshedSharedOAuth({
      accountId: 'connected',
      expectedRefresh: 'first-refresh',
      access: 'rotated-access',
      refresh: 'rotated-refresh',
      expires: 2_000_000_000_000,
      options: { path, legacyPaths: [] },
    })
    const stale = await persistRefreshedSharedOAuth({
      accountId: 'connected',
      expectedRefresh: 'first-refresh',
      access: 'stale-access',
      refresh: 'stale-refresh',
      expires: 2_200_000_000_000,
      options: { path, legacyPaths: [] },
    })
    expect(stale).toBe(false)

    const loaded = await loadSharedAccountStore({ path, legacyPaths: [] })
    expect(loaded.store.current).toBe('connected')
    expect(loaded.store.accounts[0]?.credential).toEqual({
      type: 'oauth',
      access: 'rotated-access',
      refresh: 'rotated-refresh',
      expires_at: 2_000_000_000_000,
      refresh_expires_at: 2_100_000_000_000,
      scopes: ['user:inference'],
      account: { uuid: 'connected' },
    })
  })
})
