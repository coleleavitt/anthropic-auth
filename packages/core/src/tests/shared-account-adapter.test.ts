import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FallbackAccount, OAuthAccount } from '../accounts.ts'
import {
  ANTHROPIC_API_BASE_URL,
  fallbackAccountToShared,
  materializeSharedFallbackAccounts,
  reconcileSharedFallbackAccounts,
  syncRefreshedFallbackAccountInSharedStore,
  upsertFallbackAccountInSharedStore,
} from '../shared-account-adapter.ts'
import {
  loadSharedAccountStore,
  type SharedAnthropicAccount,
  saveSharedAccountStore,
} from '../shared-account-store.ts'

const tempDirectories: string[] = []

async function storePath() {
  const directory = await mkdtemp(join(tmpdir(), 'anthropic-adapter-'))
  tempDirectories.push(directory)
  return join(directory, 'accounts.json')
}

function existingOAuthAccount(
  id: string,
  enabled = true,
): SharedAnthropicAccount {
  return {
    id,
    credential: {
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      expires_at: 2_000_000_000_000,
    },
    enabled,
    created_at: '2026-01-01T00:00:00.000Z',
  }
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('shared Anthropic account adapter', () => {
  test('migrates OAuth while retaining custom API routes in the sidecar', async () => {
    const path = await storePath()
    const accounts: FallbackAccount[] = [
      {
        id: 'oauth-main',
        type: 'oauth',
        label: 'Personal',
        access: `sk-ant-oat01-${'a'.repeat(24)}`,
        refresh: `sk-ant-ort01-${'b'.repeat(24)}`,
        expires: 2_000_000_000_000,
        enabled: true,
        addedAt: 1_700_000_000_000,
      },
      {
        id: 'api-route',
        type: 'api',
        apiKey: `sk-ant-api01-${'c'.repeat(24)}`,
        baseURL: 'https://api.example.com',
        authHeader: 'authorization-bearer',
      },
    ]

    const reconciled = await reconcileSharedFallbackAccounts(accounts, {
      path,
      legacyPaths: [],
      now: () => 1_800_000_000_000,
    })
    expect(reconciled.main?.id).toBe('oauth-main')
    expect(reconciled.fallbacks).toHaveLength(1)
    expect(reconciled.fallbacks[0]).toMatchObject({
      id: 'api-route',
      type: 'api',
      baseURL: 'https://api.example.com',
      authHeader: 'authorization-bearer',
    })

    const stored = await loadSharedAccountStore({ path, legacyPaths: [] })
    expect(stored.store.accounts).toHaveLength(1)
    expect(stored.store.accounts[0]?.credential.type).toBe('oauth')
  })

  test('preserves canonical OAuth metadata while syncing a fallback rotation', async () => {
    const path = await storePath()
    const existing: SharedAnthropicAccount = {
      id: 'fallback',
      label: 'Work',
      email: 'me@example.com',
      credential: {
        type: 'oauth',
        access: 'old-access',
        refresh: 'old-refresh',
        expires_at: 1_900_000_000_000,
        scopes: ['user:profile', 'user:inference'],
        account: { uuid: 'account-1', email_address: 'me@example.com' },
        organization: { uuid: 'org-1' },
      },
      enabled: true,
      created_at: '2026-01-01T00:00:00.000Z',
      rate_limited_until: '2026-08-15T00:00:00.000Z',
    }
    await saveSharedAccountStore({ version: 1, accounts: [existing] }, { path })

    await upsertFallbackAccountInSharedStore(
      {
        id: 'fallback',
        type: 'oauth',
        access: 'new-access',
        refresh: 'new-refresh',
        expires: 2_000_000_000_000,
        enabled: true,
      },
      { path, legacyPaths: [], expectedRefresh: 'old-refresh' },
    )
    await upsertFallbackAccountInSharedStore(
      {
        id: 'fallback',
        type: 'oauth',
        access: 'stale-access',
        refresh: 'stale-refresh',
        expires: 2_100_000_000_000,
        enabled: true,
      },
      { path, legacyPaths: [], expectedRefresh: 'old-refresh' },
    )

    const loaded = await loadSharedAccountStore({ path, legacyPaths: [] })
    if (existing.credential.type !== 'oauth') {
      throw new Error('expected OAuth fixture')
    }
    expect(loaded.store.accounts[0]).toEqual({
      ...existing,
      credential: {
        ...existing.credential,
        access: 'new-access',
        refresh: 'new-refresh',
        expires_at: 2_000_000_000_000,
      },
    })
  })

  test('refresh sync rejects missing/disabled accounts and returns a canonical winner', async () => {
    const path = await storePath()
    const refreshed: OAuthAccount = {
      id: 'fallback',
      type: 'oauth',
      access: 'loser-access',
      refresh: 'loser-refresh',
      expires: 2_100_000_000_000,
    }
    const missing = await syncRefreshedFallbackAccountInSharedStore(
      refreshed,
      'old-refresh',
      { path, legacyPaths: [] },
    )
    expect(missing.result).toEqual({ status: 'rejected' })

    const disabled = existingOAuthAccount('fallback', false)
    await saveSharedAccountStore({ version: 1, accounts: [disabled] }, { path })
    const rejected = await syncRefreshedFallbackAccountInSharedStore(
      refreshed,
      'old-refresh',
      { path, legacyPaths: [] },
    )
    expect(rejected.result).toEqual({ status: 'rejected' })

    disabled.enabled = true
    if (disabled.credential.type === 'oauth') {
      disabled.credential.access = 'winner-access'
      disabled.credential.refresh = 'winner-refresh'
    }
    await saveSharedAccountStore({ version: 1, accounts: [disabled] }, { path })
    const superseded = await syncRefreshedFallbackAccountInSharedStore(
      refreshed,
      'old-refresh',
      { path, legacyPaths: [] },
    )
    expect(superseded.result).toMatchObject({
      status: 'superseded',
      account: {
        type: 'oauth',
        access: 'winner-access',
        refresh: 'winner-refresh',
      },
    })
  })

  test('never attaches a canonical API key to colliding custom route metadata', () => {
    const shared: SharedAnthropicAccount[] = [
      {
        id: 'main',
        credential: {
          type: 'oauth',
          access: 'shared-main-access',
          refresh: 'shared-main-refresh',
          expires_at: 2_000_000_000_000,
        },
        enabled: true,
        created_at: '2026-08-14T00:00:00.000Z',
      },
      {
        id: 'api-fallback',
        credential: { type: 'api_key', key: 'shared-api-key' },
        enabled: true,
        created_at: '2026-08-14T00:00:00.000Z',
      },
    ]
    const legacy: FallbackAccount[] = [
      {
        id: 'api-fallback',
        type: 'api',
        apiKey: 'stale-key',
        baseURL: 'https://proxy.example.com/anthropic',
        authHeader: 'authorization-bearer',
      },
    ]

    expect(
      materializeSharedFallbackAccounts(legacy, {
        version: 1,
        current: 'main',
        accounts: shared,
      }),
    ).toEqual([
      expect.objectContaining({
        id: 'api-fallback',
        type: 'api',
        apiKey: 'shared-api-key',
        baseURL: ANTHROPIC_API_BASE_URL,
        authHeader: 'x-api-key',
      }),
    ])
  })

  test('refuses to flatten custom API routes into first-party shared credentials', () => {
    expect(() =>
      fallbackAccountToShared({
        id: 'proxy',
        type: 'api',
        apiKey: 'proxy-key',
        baseURL: 'https://proxy.example.com/anthropic',
        authHeader: 'authorization-bearer',
      }),
    ).toThrow('custom route')
  })

  test('defaults shared API-key accounts to the official x-api-key route', () => {
    const fallback = materializeSharedFallbackAccounts([], {
      version: 1,
      current: 'oauth-main',
      accounts: [
        {
          id: 'oauth-main',
          credential: {
            type: 'oauth',
            access: 'access',
            refresh: 'refresh',
            expires_at: 2_000_000_000_000,
          },
          enabled: true,
          created_at: '2026-08-14T00:00:00.000Z',
        },
        {
          id: 'api',
          credential: { type: 'api_key', key: 'key' },
          enabled: true,
          created_at: '2026-08-14T00:00:00.000Z',
        },
      ],
    })[0]

    expect(fallback).toMatchObject({
      type: 'api',
      baseURL: ANTHROPIC_API_BASE_URL,
      authHeader: 'x-api-key',
    })
  })

  test('refuses to migrate legacy OAuth accounts without an expiry', async () => {
    const path = await storePath()
    const reconciled = await reconcileSharedFallbackAccounts(
      [
        {
          id: 'legacy-oauth',
          type: 'oauth',
          access: `sk-ant-oat01-${'a'.repeat(24)}`,
          refresh: `sk-ant-ort01-${'b'.repeat(24)}`,
        },
      ],
      { path, legacyPaths: [], now: () => 1_800_000_000_000 },
    )
    expect(reconciled.store.accounts).toHaveLength(0)
  })
})
