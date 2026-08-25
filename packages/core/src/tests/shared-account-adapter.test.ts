import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FallbackAccount, OAuthAccount } from '../accounts.ts'
import {
  ANTHROPIC_API_BASE_URL,
  backfillSharedAccountIdentities,
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

describe('backfillSharedAccountIdentities', () => {
  const DIRS: string[] = []
  afterEach(async () => {
    const { rm } = await import('node:fs/promises')
    await Promise.all(
      DIRS.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    )
  })

  async function storeWith(accounts: unknown[]) {
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'backfill-identity-'))
    DIRS.push(dir)
    const path = join(dir, 'accounts.json')
    await writeFile(path, JSON.stringify({ version: 1, accounts }))
    return path
  }

  function bare(id: string, access: string) {
    // What a native-keychain import looks like: tokens only, no identity.
    return {
      id,
      credential: {
        type: 'oauth',
        access,
        refresh: `${access}-refresh`,
        expires_at: Date.now() + 60_000,
      },
      enabled: true,
      created_at: '2026-08-14T00:00:00.000Z',
    }
  }

  test('fills in the identity an imported credential never carried', async () => {
    // Without this the row cannot be matched against the same account added by
    // `login`, so the store holds it twice under two different names — and the
    // import keeps whatever label it was created with, so it can appear to be
    // an account it is not.
    const path = await storeWith([bare('native-claude', 'tok-a')])

    const results = await backfillSharedAccountIdentities({
      fetchIdentity: async () => ({
        accountUuid: 'acct-uuid',
        email: 'person@example.com',
        organizationUuid: 'org-uuid',
      }),
      options: { path, legacyPaths: [] },
    })

    expect(results[0]).toMatchObject({
      id: 'native-claude',
      email: 'person@example.com',
      accountUuid: 'acct-uuid',
    })

    const loaded = await loadSharedAccountStore({ path, legacyPaths: [] })
    const account = loaded.store.accounts[0]!
    if (account.credential.type !== 'oauth') throw new Error('expected oauth')
    expect(account.credential.account?.uuid).toBe('acct-uuid')
    expect(account.credential.organization?.uuid).toBe('org-uuid')
    expect(account.email).toBe('person@example.com')
  })

  test('leaves an already-identified account untouched', async () => {
    // Safe to run repeatedly: one request per unidentified account, none for
    // the rest.
    const path = await storeWith([
      {
        ...bare('known', 'tok-b'),
        credential: {
          ...bare('known', 'tok-b').credential,
          account: { uuid: 'existing-uuid' },
        },
      },
    ])
    let called = 0

    const results = await backfillSharedAccountIdentities({
      fetchIdentity: async () => {
        called += 1
        return { accountUuid: 'should-not-be-used' }
      },
      options: { path, legacyPaths: [] },
    })

    expect(called).toBe(0)
    expect(results[0]?.skipped).toBe('already identified')
  })

  test('leaves the account alone when the profile is unavailable', async () => {
    // A failed lookup must not stamp a guess onto a working credential.
    const path = await storeWith([bare('native-claude', 'tok-c')])

    const results = await backfillSharedAccountIdentities({
      fetchIdentity: async () => ({}),
      options: { path, legacyPaths: [] },
    })

    expect(results[0]?.skipped).toBe('profile unavailable')
    const loaded = await loadSharedAccountStore({ path, legacyPaths: [] })
    const account = loaded.store.accounts[0]!
    if (account.credential.type !== 'oauth') throw new Error('expected oauth')
    expect(account.credential.account).toBeUndefined()
  })

  test('backfilled identity makes a duplicate matchable', async () => {
    // The point of the exercise: two rows for one account become recognisable
    // as the same login only once both carry identity.
    const path = await storeWith([
      bare('native-claude', 'tok-d'),
      {
        ...bare('person@example.com', 'tok-e'),
        email: 'person@example.com',
        credential: {
          ...bare('person@example.com', 'tok-e').credential,
          account: { uuid: 'shared-uuid', email_address: 'person@example.com' },
          organization: { uuid: 'org-uuid' },
        },
      },
    ])

    await backfillSharedAccountIdentities({
      fetchIdentity: async () => ({
        accountUuid: 'shared-uuid',
        email: 'person@example.com',
        organizationUuid: 'org-uuid',
      }),
      options: { path, legacyPaths: [] },
    })

    const loaded = await loadSharedAccountStore({ path, legacyPaths: [] })
    const uuids = loaded.store.accounts.map((a) =>
      a.credential.type === 'oauth' ? a.credential.account?.uuid : undefined,
    )
    expect(uuids).toEqual(['shared-uuid', 'shared-uuid'])
  })
})
