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
  findSharedAccountByCredential,
  getSharedAccountStorePath,
  loadSharedAccountStore,
  pickSharedAccount,
  removeSharedAccount,
  type SharedAnthropicAccount,
  saveSharedAccountStore,
  setSharedAccountEnabled,
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
