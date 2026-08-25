import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  claimSharedAccountRefresh,
  findSharedAccountByCredential,
  getSharedAccountStoreLegacyPaths,
  getSharedAccountStorePath,
  loadSharedAccountStore,
  pickSharedAccount,
  recordSharedAccountQuota,
  releaseSharedAccountRefresh,
  removeSharedAccount,
  type SharedAnthropicAccount,
  saveSharedAccountStore,
  setSharedAccountEnabled,
  updateSharedAccountStore,
  upsertSharedAccount,
} from '../shared-account-store.ts'

const originalFile = process.env.ANTHROPIC_ACCOUNTS_FILE
const originalDir = process.env.ANTHROPIC_ACCOUNTS_DIR
const originalTestDir = process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR
const originalSidecar = process.env.OPENCODE_ANTHROPIC_AUTH_FILE
const tempDirectories: string[] = []

function apiAccount(
  id: string,
  key = `sk-ant-api01-${'a'.repeat(24)}`,
): SharedAnthropicAccount {
  return {
    id,
    label: id,
    credential: { type: 'api_key', key },
    enabled: true,
    created_at: '2026-08-14T00:00:00.000Z',
  }
}

function oauthAccount(id: string): SharedAnthropicAccount {
  return {
    id,
    email: `${id}@example.com`,
    credential: {
      type: 'oauth',
      access: `sk-ant-oat01-${'a'.repeat(24)}`,
      refresh: `sk-ant-ort01-${'b'.repeat(24)}`,
      expires_at: Date.now() + 60_000,
      refresh_expires_at: Date.now() + 86_400_000,
      scopes: ['user:inference'],
      account: { uuid: id, email_address: `${id}@example.com` },
    },
    enabled: true,
    created_at: '2026-08-14T00:00:00.000Z',
  }
}

async function tempStorePath() {
  const directory = await mkdtemp(join(tmpdir(), 'anthropic-shared-store-'))
  tempDirectories.push(directory)
  return join(directory, 'accounts.json')
}

afterEach(async () => {
  if (originalFile === undefined) delete process.env.ANTHROPIC_ACCOUNTS_FILE
  else process.env.ANTHROPIC_ACCOUNTS_FILE = originalFile
  if (originalDir === undefined) delete process.env.ANTHROPIC_ACCOUNTS_DIR
  else process.env.ANTHROPIC_ACCOUNTS_DIR = originalDir
  if (originalTestDir === undefined)
    delete process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR
  else process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR = originalTestDir
  if (originalSidecar === undefined)
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  else process.env.OPENCODE_ANTHROPIC_AUTH_FILE = originalSidecar
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('shared Anthropic account store', () => {
  test('resolves explicit, file-env, then directory-env paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'anthropic-shared-path-'))
    tempDirectories.push(directory)
    process.env.ANTHROPIC_ACCOUNTS_FILE = join(directory, 'from-file.json')
    process.env.ANTHROPIC_ACCOUNTS_DIR = join(directory, 'from-dir')

    expect(getSharedAccountStorePath('/explicit/accounts.json')).toBe(
      '/explicit/accounts.json',
    )
    expect(getSharedAccountStorePath()).toBe(join(directory, 'from-file.json'))
    delete process.env.ANTHROPIC_ACCOUNTS_FILE
    expect(getSharedAccountStorePath()).toBe(
      join(directory, 'from-dir', 'accounts.json'),
    )
  })

  test('isolates OpenCode tests beside their temporary sidecar', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'anthropic-shared-test-path-'),
    )
    tempDirectories.push(directory)
    delete process.env.ANTHROPIC_ACCOUNTS_FILE
    delete process.env.ANTHROPIC_ACCOUNTS_DIR
    process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR = directory
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(
      directory,
      'case',
      'anthropic-auth.json',
    )

    expect(getSharedAccountStorePath()).toBe(
      join(directory, 'case', 'shared-anthropic-accounts.json'),
    )
    expect((await loadSharedAccountStore()).source).toEqual({ type: 'empty' })
  })

  test('round-trips the Rust-compatible OAuth and API-key schema', async () => {
    const path = await tempStorePath()
    const oauth = oauthAccount('oauth-main')
    const api = apiAccount('api-fallback')
    await saveSharedAccountStore(
      { version: 1, current: oauth.id, accounts: [oauth, api] },
      { path },
    )

    const loaded = await loadSharedAccountStore({ path, legacyPaths: [] })
    expect(loaded.source).toEqual({ type: 'canonical', path })
    expect(loaded.store.current).toBe(oauth.id)
    expect(loaded.store.accounts).toEqual([oauth, api])
    expect(pickSharedAccount(loaded.store)?.id).toBe(oauth.id)
    expect(
      findSharedAccountByCredential(loaded.store, api.credential)?.id,
    ).toBe(api.id)

    if (process.platform !== 'win32') {
      expect((await lstat(path)).mode & 0o777).toBe(0o600)
      expect((await lstat(join(path, '..'))).mode & 0o777).toBe(0o700)
    }
  })

  test('loads a legacy store only when the canonical store is absent', async () => {
    const canonical = await tempStorePath()
    const legacy = join(canonical, '..', 'legacy.json')
    const account = oauthAccount('legacy-oauth')
    await writeFile(
      legacy,
      JSON.stringify({ version: 1, accounts: [account], current: account.id }),
    )

    const loaded = await loadSharedAccountStore({
      path: canonical,
      legacyPaths: [legacy],
    })
    expect(loaded.source).toEqual({ type: 'legacy', path: legacy })
    expect(loaded.store.accounts[0]?.id).toBe(account.id)
  })

  test('skips incompatible legacy schemas and continues to the next candidate', async () => {
    const canonical = await tempStorePath()
    const incompatible = join(canonical, '..', 'old-jfc.json')
    const compatible = join(canonical, '..', 'compatible.json')
    await writeFile(
      incompatible,
      JSON.stringify({
        accounts: [{ uuid: 'legacy', refreshToken: 'secret' }],
      }),
    )
    await writeFile(
      compatible,
      JSON.stringify({ version: 1, accounts: [apiAccount('compatible')] }),
    )

    const loaded = await loadSharedAccountStore({
      path: canonical,
      legacyPaths: [incompatible, compatible],
    })
    expect(loaded.source).toEqual({ type: 'legacy', path: compatible })
    expect(loaded.store.accounts[0]?.id).toBe('compatible')
  })

  test('rejects malformed account entries instead of silently dropping credentials', async () => {
    const path = await tempStorePath()
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        accounts: [apiAccount('valid'), { id: 'broken', credential: {} }],
      }),
    )
    await expect(
      loadSharedAccountStore({ path, legacyPaths: [] }),
    ).rejects.toThrow('entry at index 1')
  })

  test('rejects non-finite expiries and non-RFC3339 timestamps before writing', async () => {
    const path = await tempStorePath()
    const invalidExpiry = oauthAccount('invalid-expiry')
    if (invalidExpiry.credential.type !== 'oauth') {
      throw new Error('expected OAuth fixture')
    }
    invalidExpiry.credential.expires_at = Number.NaN
    await expect(
      saveSharedAccountStore(
        { version: 1, accounts: [invalidExpiry] },
        { path },
      ),
    ).rejects.toThrow('entry at index 0')

    const invalidDate = apiAccount('invalid-date')
    invalidDate.created_at = 'August 14, 2026'
    await expect(
      saveSharedAccountStore({ version: 1, accounts: [invalidDate] }, { path }),
    ).rejects.toThrow('entry at index 0')
  })

  test('upserts and disables accounts without exposing a second storage shape', async () => {
    const path = await tempStorePath()
    const first = oauthAccount('first')
    await upsertSharedAccount(first, {
      path,
      legacyPaths: [],
      setCurrent: true,
    })
    await upsertSharedAccount(apiAccount('second'), {
      path,
      legacyPaths: [],
    })
    await setSharedAccountEnabled('first', false, {
      path,
      legacyPaths: [],
    })

    const loaded = await loadSharedAccountStore({ path, legacyPaths: [] })
    expect(loaded.store.current).toBeUndefined()
    expect(loaded.store.accounts).toHaveLength(2)
    expect(pickSharedAccount(loaded.store)?.id).toBe('second')
  })

  test('explicit account removal can persist a valid empty Rust-compatible store', async () => {
    const path = await tempStorePath()
    await saveSharedAccountStore(
      { version: 1, accounts: [oauthAccount('only')], current: 'only' },
      { path },
    )
    const removed = await removeSharedAccount('only', {
      path,
      legacyPaths: [],
    })
    expect(removed.result).toBe(true)
    const loaded = await loadSharedAccountStore({ path, legacyPaths: [] })
    expect(loaded.store).toEqual({
      version: 1,
      accounts: [],
      current: undefined,
    })
  })

  test('refuses unintentional empty writes and symlinked stores', async () => {
    const path = await tempStorePath()
    await expect(
      saveSharedAccountStore({ version: 1, accounts: [] }, { path }),
    ).rejects.toThrow('delete all Anthropic accounts')

    if (process.platform === 'win32') return
    const target = join(path, '..', 'target.json')
    await writeFile(target, '{}')
    await symlink(target, path)
    await expect(
      loadSharedAccountStore({ path, legacyPaths: [] }),
    ).rejects.toThrow('symlinked Anthropic account store')
    await chmod(target, 0o600)
    expect(await readFile(target, 'utf8')).toBe('{}')
  })
})

describe('shared account store — legacy flat schema adoption', () => {
  /** The pre-shared-store shape written by jfc, grok, and older OpenCode. */
  function flatLegacyAccount(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      uuid: '11111111-2222-3333-4444-555555555555',
      name: 'fallback@example.com',
      email: 'fallback@example.com',
      accessToken: `sk-ant-oat01-${'c'.repeat(24)}`,
      refreshToken: `sk-ant-ort01-${'d'.repeat(24)}`,
      expiresAt: 1_786_603_416_722,
      addedAt: 1_778_606_812_194,
      lastUsed: 1_785_253_979_028,
      scopes: ['user:inference', 'user:profile'],
      organizationUuid: '66666666-7777-8888-9999-000000000000',
      plan: 'claude_max',
      enabled: true,
      ...overrides,
    }
  }

  async function writeFlatLegacy(
    path: string,
    accounts: Record<string, unknown>[],
  ) {
    await writeFile(
      path,
      JSON.stringify({ version: 1, accounts, active_index: 0 }),
    )
  }

  test('adopts flat legacy accounts the canonical schema used to reject', async () => {
    const canonical = await tempStorePath()
    const legacy = join(canonical, '..', 'anthropic-accounts.json')
    await writeFlatLegacy(legacy, [flatLegacyAccount()])

    const loaded = await loadSharedAccountStore({
      path: canonical,
      legacyPaths: [legacy],
    })

    expect(loaded.store.accounts).toHaveLength(1)
    const adopted = loaded.store.accounts[0]!
    expect(adopted.id).toBe('11111111-2222-3333-4444-555555555555')
    expect(adopted.email).toBe('fallback@example.com')
    expect(adopted.enabled).toBe(true)
    expect(adopted.credential.type).toBe('oauth')
    if (adopted.credential.type !== 'oauth') throw new Error('expected oauth')
    expect(adopted.credential.refresh).toBe(`sk-ant-ort01-${'d'.repeat(24)}`)
    expect(adopted.credential.expires_at).toBe(1_786_603_416_722)
    expect(adopted.credential.scopes).toEqual([
      'user:inference',
      'user:profile',
    ])
    expect(adopted.credential.organization?.uuid).toBe(
      '66666666-7777-8888-9999-000000000000',
    )
    expect(adopted.created_at).toBe(new Date(1_778_606_812_194).toISOString())
  })

  test('merges legacy accounts alongside an existing canonical account', async () => {
    // The regression that hid every other login: a canonical store with one
    // account used to end resolution before any legacy path was consulted.
    const canonical = await tempStorePath()
    const legacy = join(canonical, '..', 'anthropic-accounts.json')
    await writeFile(
      canonical,
      JSON.stringify({
        version: 1,
        accounts: [oauthAccount('native-claude')],
        current: 'native-claude',
      }),
    )
    await writeFlatLegacy(legacy, [
      flatLegacyAccount(),
      flatLegacyAccount({
        uuid: '99999999-8888-7777-6666-555555555555',
        email: 'second@example.com',
        name: 'second@example.com',
        refreshToken: `sk-ant-ort01-${'e'.repeat(24)}`,
      }),
    ])

    const loaded = await loadSharedAccountStore({
      path: canonical,
      legacyPaths: [legacy],
    })

    expect(loaded.store.accounts.map((account) => account.id)).toEqual([
      'native-claude',
      '11111111-2222-3333-4444-555555555555',
      '99999999-8888-7777-6666-555555555555',
    ])
    expect(loaded.source).toEqual({
      type: 'canonical',
      path: canonical,
      adoptedFrom: [legacy],
    })
    expect(loaded.store.current).toBe('native-claude')
  })

  test('keeps disabled legacy accounts disabled and carries their reason', async () => {
    const canonical = await tempStorePath()
    const legacy = join(canonical, '..', 'anthropic-accounts.json')
    await writeFlatLegacy(legacy, [
      flatLegacyAccount({ enabled: false, disabledReason: 'invalid_grant' }),
    ])

    const loaded = await loadSharedAccountStore({
      path: canonical,
      legacyPaths: [legacy],
    })

    expect(loaded.store.accounts[0]?.enabled).toBe(false)
    expect(loaded.store.accounts[0]?.last_error).toBe('invalid_grant')
  })

  test('drops a legacy row that has no refresh token instead of adopting a dead account', async () => {
    const canonical = await tempStorePath()
    const legacy = join(canonical, '..', 'anthropic-accounts.json')
    await writeFlatLegacy(legacy, [
      flatLegacyAccount({ refreshToken: '' }),
      flatLegacyAccount({
        uuid: '99999999-8888-7777-6666-555555555555',
        refreshToken: `sk-ant-ort01-${'f'.repeat(24)}`,
      }),
    ])

    const loaded = await loadSharedAccountStore({
      path: canonical,
      legacyPaths: [legacy],
    })

    expect(loaded.store.accounts.map((account) => account.id)).toEqual([
      '99999999-8888-7777-6666-555555555555',
    ])
  })

  test('does not duplicate an account already present under the canonical schema', async () => {
    const canonical = await tempStorePath()
    const legacy = join(canonical, '..', 'anthropic-accounts.json')
    const shared = oauthAccount('native-claude')
    await writeFile(
      canonical,
      JSON.stringify({ version: 1, accounts: [shared] }),
    )
    await writeFlatLegacy(legacy, [
      // Same refresh token, different id: the same login seen through the old
      // schema.
      flatLegacyAccount({
        uuid: 'legacy-view-of-native',
        refreshToken:
          shared.credential.type === 'oauth' ? shared.credential.refresh : '',
      }),
    ])

    const loaded = await loadSharedAccountStore({
      path: canonical,
      legacyPaths: [legacy],
    })

    expect(loaded.store.accounts).toHaveLength(1)
    expect(loaded.store.accounts[0]?.id).toBe('native-claude')
  })

  test('records adoption so a removed account is not resurrected', async () => {
    const canonical = await tempStorePath()
    const legacy = join(canonical, '..', 'anthropic-accounts.json')
    await writeFlatLegacy(legacy, [flatLegacyAccount()])

    const first = await loadSharedAccountStore({
      path: canonical,
      legacyPaths: [legacy],
    })
    expect(first.store.migrated_from).toEqual([legacy])

    // Persist the adoption, then delete the account the way a user would.
    await saveSharedAccountStore(
      { ...first.store, accounts: [oauthAccount('kept')] },
      { path: canonical },
    )

    const second = await loadSharedAccountStore({
      path: canonical,
      legacyPaths: [legacy],
    })
    expect(second.store.accounts.map((account) => account.id)).toEqual(['kept'])
  })

  test('tolerates one unreadable row without losing the accounts beside it', async () => {
    const canonical = await tempStorePath()
    const legacy = join(canonical, '..', 'anthropic-accounts.json')
    await writeFile(
      legacy,
      JSON.stringify({
        version: 1,
        accounts: [{ garbage: true }, flatLegacyAccount()],
      }),
    )

    const loaded = await loadSharedAccountStore({
      path: canonical,
      legacyPaths: [legacy],
    })

    expect(loaded.store.accounts).toHaveLength(1)
    expect(loaded.store.accounts[0]?.id).toBe(
      '11111111-2222-3333-4444-555555555555',
    )
  })

  test('does not admit the same login twice from two legacy stores', async () => {
    // Regression: keying only on the refresh token let a rotated copy of the
    // same login through, putting duplicate ids in the store and making every
    // id-keyed update ambiguous.
    const canonical = await tempStorePath()
    const first = join(canonical, '..', 'anthropic-accounts.json')
    const second = join(canonical, '..', 'grok-anthropic-accounts.json')
    await writeFlatLegacy(first, [flatLegacyAccount()])
    await writeFlatLegacy(second, [
      // Same uuid and email, older refresh token — one tool's stale copy.
      flatLegacyAccount({ refreshToken: `sk-ant-ort01-${'0'.repeat(24)}` }),
    ])

    const loaded = await loadSharedAccountStore({
      path: canonical,
      legacyPaths: [first, second],
    })

    expect(loaded.store.accounts).toHaveLength(1)
    const ids = loaded.store.accounts.map((account) => account.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('an account already stored under its email is not re-added by uuid', async () => {
    // After a re-login the canonical entry is keyed by email while the legacy
    // copy is keyed by the account uuid; they are the same login.
    const canonical = await tempStorePath()
    const legacy = join(canonical, '..', 'anthropic-accounts.json')
    const uuid = '11111111-2222-3333-4444-555555555555'
    await writeFile(
      canonical,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: 'fallback@example.com',
            email: 'fallback@example.com',
            credential: {
              type: 'oauth',
              access: `sk-ant-oat01-${'z'.repeat(24)}`,
              refresh: `sk-ant-ort01-${'z'.repeat(24)}`,
              expires_at: Date.now() + 60_000,
              account: { uuid, email_address: 'fallback@example.com' },
              // Same organization as the legacy row: identity is the
              // (account, organization) pair, so both sides must name it for
              // the rows to be recognised as one login.
              organization: {
                uuid: '66666666-7777-8888-9999-000000000000',
              },
            },
            enabled: true,
            created_at: '2026-08-14T00:00:00.000Z',
          },
        ],
      }),
    )
    await writeFlatLegacy(legacy, [flatLegacyAccount({ uuid })])

    const loaded = await loadSharedAccountStore({
      path: canonical,
      legacyPaths: [legacy],
    })

    expect(loaded.store.accounts).toHaveLength(1)
    expect(loaded.store.accounts[0]?.id).toBe('fallback@example.com')
  })

  test('keeps two organizations of the same person as separate accounts', async () => {
    // One email and one account uuid can hold a grant in several
    // organizations; those are separate routable credentials. Collapsing them
    // would silently drop a working login.
    const canonical = await tempStorePath()
    const legacy = join(canonical, '..', 'anthropic-accounts.json')
    const uuid = '11111111-2222-3333-4444-555555555555'
    await writeFile(
      canonical,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: 'person@example.com (org-a)',
            email: 'person@example.com',
            credential: {
              type: 'oauth',
              access: `sk-ant-oat01-${'a'.repeat(24)}`,
              refresh: `sk-ant-ort01-${'a'.repeat(24)}`,
              expires_at: Date.now() + 60_000,
              account: { uuid, email_address: 'person@example.com' },
              organization: { uuid: 'org-a' },
            },
            enabled: true,
            created_at: '2026-08-14T00:00:00.000Z',
          },
        ],
      }),
    )
    // Same person, same account uuid, same email — different organization.
    await writeFlatLegacy(legacy, [
      flatLegacyAccount({
        uuid,
        email: 'person@example.com',
        organizationUuid: 'org-b',
        refreshToken: `sk-ant-ort01-${'b'.repeat(24)}`,
      }),
    ])

    const loaded = await loadSharedAccountStore({
      path: canonical,
      legacyPaths: [legacy],
    })

    expect(loaded.store.accounts).toHaveLength(2)
    expect(
      loaded.store.accounts.map(
        (a) => a.credential.type === 'oauth' && a.credential.organization?.uuid,
      ),
    ).toEqual(['org-a', 'org-b'])
  })

  test('does not merge a row that never captured its organization', async () => {
    // An unqualified row matches nothing qualified. An unmerged duplicate is a
    // tidy-up; a wrongly merged pair loses an account.
    const canonical = await tempStorePath()
    const legacy = join(canonical, '..', 'anthropic-accounts.json')
    const uuid = '11111111-2222-3333-4444-555555555555'
    await writeFile(
      canonical,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: 'no-org',
            email: 'person@example.com',
            credential: {
              type: 'oauth',
              access: `sk-ant-oat01-${'a'.repeat(24)}`,
              refresh: `sk-ant-ort01-${'a'.repeat(24)}`,
              expires_at: Date.now() + 60_000,
              account: { uuid, email_address: 'person@example.com' },
            },
            enabled: true,
            created_at: '2026-08-14T00:00:00.000Z',
          },
        ],
      }),
    )
    await writeFlatLegacy(legacy, [
      flatLegacyAccount({
        uuid,
        email: 'person@example.com',
        refreshToken: `sk-ant-ort01-${'b'.repeat(24)}`,
      }),
    ])

    const loaded = await loadSharedAccountStore({
      path: canonical,
      legacyPaths: [legacy],
    })

    expect(loaded.store.accounts).toHaveLength(2)
  })

  test('lists the in-directory legacy filename as a migration candidate', async () => {
    const previous = process.env.ANTHROPIC_ACCOUNTS_DIR
    process.env.ANTHROPIC_ACCOUNTS_DIR = '/tmp/anthropic-accounts-fixture'
    try {
      expect(getSharedAccountStoreLegacyPaths()).toContain(
        '/tmp/anthropic-accounts-fixture/anthropic-accounts.json',
      )
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_ACCOUNTS_DIR
      else process.env.ANTHROPIC_ACCOUNTS_DIR = previous
    }
  })
})

describe('shared account store — quota-aware rotation', () => {
  function withQuota(
    id: string,
    quota: {
      five_hour_percent?: number
      seven_day_percent?: number
      checked_at?: string
    },
  ) {
    return { ...oauthAccount(id), quota }
  }

  const fresh = () => new Date().toISOString()

  test('skips an account whose weekly window is exhausted', () => {
    // The regression this guards: exhaustion is reported through quota, not
    // through rate_limited_until, so a 100% account looked perfectly available
    // and stayed pinned as `current` forever.
    const store = {
      version: 1,
      accounts: [
        withQuota('spent', { seven_day_percent: 100, checked_at: fresh() }),
        withQuota('fresh', { seven_day_percent: 0, checked_at: fresh() }),
      ],
      current: 'spent',
    }

    expect(pickSharedAccount(store)?.id).toBe('fresh')
  })

  test('skips an account whose five-hour window is exhausted', () => {
    const store = {
      version: 1,
      accounts: [
        withQuota('spent', { five_hour_percent: 100, checked_at: fresh() }),
        withQuota('fresh', { five_hour_percent: 12, checked_at: fresh() }),
      ],
      current: 'spent',
    }

    expect(pickSharedAccount(store)?.id).toBe('fresh')
  })

  test('keeps an account that still has headroom', () => {
    const store = {
      version: 1,
      accounts: [
        withQuota('warm', { seven_day_percent: 99.9, checked_at: fresh() }),
        oauthAccount('other'),
      ],
      current: 'warm',
    }

    expect(pickSharedAccount(store)?.id).toBe('warm')
  })

  test('ignores a stale reading rather than stranding the account', () => {
    // An hour-old 100% reading may well have reset; failing open is safer than
    // disqualifying an account on evidence that has expired.
    const stale = new Date(Date.now() - 60 * 60_000).toISOString()
    const store = {
      version: 1,
      accounts: [
        withQuota('spent', { seven_day_percent: 100, checked_at: stale }),
      ],
      current: 'spent',
    }

    expect(pickSharedAccount(store)?.id).toBe('spent')
  })

  test('ignores a reading with no timestamp', () => {
    const store = {
      version: 1,
      accounts: [withQuota('spent', { seven_day_percent: 100 })],
    }

    expect(pickSharedAccount(store)?.id).toBe('spent')
  })

  test('returns undefined when every account is exhausted rather than a doomed one', () => {
    const store = {
      version: 1,
      accounts: [
        withQuota('a', { seven_day_percent: 100, checked_at: fresh() }),
        withQuota('b', { five_hour_percent: 100, checked_at: fresh() }),
      ],
      current: 'a',
    }

    expect(pickSharedAccount(store)).toBeUndefined()
  })

  test('a stored quota observation survives a write', async () => {
    // migrated_from was silently dropped by an older serializer; make sure the
    // quota field cannot regress the same way.
    const path = await tempStorePath()
    const account = withQuota('kept', {
      seven_day_percent: 42,
      checked_at: '2026-08-24T00:00:00.000Z',
    })
    await saveSharedAccountStore({ version: 1, accounts: [account] }, { path })

    const loaded = await loadSharedAccountStore({ path, legacyPaths: [] })
    expect(loaded.store.accounts[0]?.quota).toEqual({
      seven_day_percent: 42,
      checked_at: '2026-08-24T00:00:00.000Z',
    })
  })

  test('recordSharedAccountQuota clears a pin it just invalidated', async () => {
    const path = await tempStorePath()
    await saveSharedAccountStore(
      {
        version: 1,
        accounts: [oauthAccount('pinned'), oauthAccount('spare')],
        current: 'pinned',
      },
      { path },
    )

    await recordSharedAccountQuota(
      'pinned',
      { sevenDayPercent: 100 },
      { path, legacyPaths: [] },
    )

    const loaded = await loadSharedAccountStore({ path, legacyPaths: [] })
    expect(loaded.store.current).toBeUndefined()
    expect(pickSharedAccount(loaded.store)?.id).toBe('spare')
  })
})

describe('shared account store — refresh claim', () => {
  const REFRESH = `sk-ant-ort01-${'b'.repeat(24)}`

  async function storeWithOauth() {
    const path = await tempStorePath()
    await saveSharedAccountStore(
      { version: 1, accounts: [oauthAccount('acct')] },
      { path },
    )
    return path
  }

  test('the first caller claims and a second is told to wait', async () => {
    // Anthropic revokes the token family if the same refresh token is posted
    // twice, so only one caller may reach the network.
    const path = await storeWithOauth()

    const first = await claimSharedAccountRefresh('acct', REFRESH, { path })
    expect(first.status).toBe('claimed')

    const second = await claimSharedAccountRefresh('acct', REFRESH, { path })
    expect(second.status).toBe('held')
  })

  test('a caller holding a spent token is handed the winner instead', async () => {
    const path = await storeWithOauth()
    await updateSharedAccountStore(
      (store) => {
        const account = store.accounts[0]
        if (account?.credential.type !== 'oauth') return false
        account.credential.refresh = `sk-ant-ort01-${'c'.repeat(24)}`
        account.credential.access = `sk-ant-oat01-${'c'.repeat(24)}`
        return true
      },
      { path },
    )

    const claim = await claimSharedAccountRefresh('acct', REFRESH, { path })
    expect(claim.status).toBe('already-refreshed')
    if (claim.status !== 'already-refreshed') throw new Error('unreachable')
    // Returning the rotated credential is what keeps the caller from spending
    // the dead token and revoking the family.
    expect(claim.credential.refresh).toBe(`sk-ant-ort01-${'c'.repeat(24)}`)
  })

  test('an expired claim can be taken over', async () => {
    const path = await storeWithOauth()
    const first = await claimSharedAccountRefresh('acct', REFRESH, {
      path,
      ttlMs: -1,
    })
    expect(first.status).toBe('claimed')

    const second = await claimSharedAccountRefresh('acct', REFRESH, { path })
    expect(second.status).toBe('claimed')
  })

  test('releasing lets the next caller claim', async () => {
    const path = await storeWithOauth()
    const first = await claimSharedAccountRefresh('acct', REFRESH, { path })
    if (first.status !== 'claimed') throw new Error('expected a claim')

    await releaseSharedAccountRefresh('acct', first.leaseId, { path })
    const second = await claimSharedAccountRefresh('acct', REFRESH, { path })
    expect(second.status).toBe('claimed')
  })

  test('a foreign lease id cannot release the claim', async () => {
    const path = await storeWithOauth()
    await claimSharedAccountRefresh('acct', REFRESH, { path })

    await releaseSharedAccountRefresh('acct', 'not-the-holder', { path })
    const second = await claimSharedAccountRefresh('acct', REFRESH, { path })
    expect(second.status).toBe('held')
  })

  test('an unknown account is reported rather than claimed', async () => {
    const path = await storeWithOauth()
    const claim = await claimSharedAccountRefresh('missing', REFRESH, { path })
    expect(claim.status).toBe('unknown-account')
  })

  test('a claim survives a write, so another process still sees it', async () => {
    const path = await storeWithOauth()
    await claimSharedAccountRefresh('acct', REFRESH, { path })

    const loaded = await loadSharedAccountStore({ path, legacyPaths: [] })
    expect(loaded.store.accounts[0]?.refresh_lease?.id).toBeString()
  })
})

describe('shared account store — explicit path isolation', () => {
  test('an explicit path never adopts the home-directory legacy stores', async () => {
    // Regression: legacy adoption ran even for a caller that named its own
    // store, merging unrelated home accounts into a scratch file — and then
    // writing them back out to it.
    const path = await tempStorePath()
    await saveSharedAccountStore(
      { version: 1, accounts: [oauthAccount('only-mine')] },
      { path },
    )

    const loaded = await loadSharedAccountStore({ path })

    expect(loaded.store.accounts).toHaveLength(1)
    expect(loaded.store.accounts[0]?.id).toBe('only-mine')
    expect(loaded.store.migrated_from ?? []).toEqual([])
  })

  test('an explicit path still honours legacyPaths when asked', async () => {
    const path = await tempStorePath()
    const legacy = join(path, '..', 'legacy.json')
    await saveSharedAccountStore(
      { version: 1, accounts: [oauthAccount('mine')] },
      { path },
    )
    await writeFile(
      legacy,
      JSON.stringify({ version: 1, accounts: [apiAccount('adopted')] }),
    )

    const loaded = await loadSharedAccountStore({
      path,
      legacyPaths: [legacy],
    })

    expect(loaded.store.accounts.map((account) => account.id)).toEqual([
      'mine',
      'adopted',
    ])
  })
})

describe('shared account store — upsert identity', () => {
  /** The old-schema row a re-login supersedes: keyed by account UUID. */
  function uuidKeyed(
    uuid: string,
    refresh: string,
    email = 'person@example.com',
  ): SharedAnthropicAccount {
    return {
      id: uuid,
      email,
      credential: {
        type: 'oauth',
        access: `sk-ant-oat01-${'x'.repeat(24)}`,
        refresh,
        expires_at: Date.now() + 60_000,
        account: { uuid, email_address: email },
      },
      enabled: true,
      created_at: '2026-08-14T00:00:00.000Z',
    }
  }

  /** What `login` writes: keyed by the email the grant reported. */
  function emailKeyed(uuid: string, refresh: string): SharedAnthropicAccount {
    return {
      id: 'person@example.com',
      email: 'person@example.com',
      credential: {
        type: 'oauth',
        access: `sk-ant-oat01-${'y'.repeat(24)}`,
        refresh,
        expires_at: Date.now() + 60_000,
        account: { uuid, email_address: 'person@example.com' },
      },
      enabled: true,
      created_at: '2026-08-25T00:00:00.000Z',
    }
  }

  test('a re-login replaces the uuid-keyed row instead of duplicating it', async () => {
    // Regression: matching on id alone left both rows behind, so the store grew
    // a duplicate of the same login on every re-login.
    const uuid = '11111111-2222-3333-4444-555555555555'
    const path = await tempStorePath()
    await saveSharedAccountStore(
      { version: 1, accounts: [uuidKeyed(uuid, 'old-refresh')] },
      { path },
    )

    await upsertSharedAccount(emailKeyed(uuid, 'new-refresh'), { path })

    const loaded = await loadSharedAccountStore({ path, legacyPaths: [] })
    expect(loaded.store.accounts).toHaveLength(1)
    expect(loaded.store.accounts[0]?.id).toBe('person@example.com')
  })

  test('the pin follows the row it superseded', async () => {
    const uuid = '11111111-2222-3333-4444-555555555555'
    const path = await tempStorePath()
    await saveSharedAccountStore(
      { version: 1, accounts: [uuidKeyed(uuid, 'old-refresh')], current: uuid },
      { path },
    )

    await upsertSharedAccount(emailKeyed(uuid, 'new-refresh'), { path })

    const loaded = await loadSharedAccountStore({ path, legacyPaths: [] })
    expect(loaded.store.current).toBe('person@example.com')
  })

  test('a genuinely different account is still added', async () => {
    const path = await tempStorePath()
    await saveSharedAccountStore(
      {
        version: 1,
        accounts: [
          uuidKeyed('11111111-2222-3333-4444-555555555555', 'refresh-a'),
        ],
      },
      { path },
    )

    // A different person: distinct uuid, distinct refresh token, and a
    // distinct email — an Anthropic account owns exactly one address, so two
    // rows sharing one are the same login, not two.
    await upsertSharedAccount(
      uuidKeyed(
        '99999999-8888-7777-6666-555555555555',
        'refresh-b',
        'other@example.com',
      ),
      { path },
    )

    const loaded = await loadSharedAccountStore({ path, legacyPaths: [] })
    expect(loaded.store.accounts).toHaveLength(2)
  })
})
