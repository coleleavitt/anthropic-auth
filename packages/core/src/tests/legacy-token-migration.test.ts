/**
 * Older versions kept every fallback account's access and refresh token in
 * the host files (`anthropic-auth-state.json`, earlier `anthropic-auth.json`).
 * `loadAccounts` moves them into the Rust store once — the store's copy wins —
 * and no write afterwards carries a token.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getAccountStatePath,
  loadAccounts,
  type OAuthAccount,
  saveAccountState,
  saveAccounts,
} from '../accounts.ts'
import { listSharedAccounts } from '../shared-account-store.ts'
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

let store: TempStore
let mock: MockTokenServer
let hostDir: string
let configPath: string
let statePath: string
let sequence = 0

beforeEach(() => {
  store = useTempStore()
  mock = startMockTokenServer()
  hostDir = mkdtempSync(join(tmpdir(), 'legacy-migration-host-'))
  configPath = join(hostDir, 'anthropic-auth.json')
  statePath = getAccountStatePath(configPath)
})

afterEach(() => {
  mock.stop()
  store.dispose()
  rmSync(hostDir, { recursive: true, force: true })
})

function tokens(tag: string) {
  sequence += 1
  return {
    access: fakeAccessToken(`${tag}m${process.pid}x${sequence}`),
    refresh: fakeRefreshToken(`${tag}m${process.pid}x${sequence}`),
  }
}

function writeHost(config: unknown, state: unknown) {
  writeFileSync(configPath, JSON.stringify(config))
  writeFileSync(statePath, JSON.stringify(state))
}

function hostText() {
  return `${readFileSync(configPath, 'utf8')}\n${readFileSync(statePath, 'utf8')}`
}

describe('one-time import of host-held tokens', () => {
  test('imports a state-file token, follows the store id and scrubs both files', async () => {
    const legacy = tokens('legacy')
    writeHost(
      {
        version: 1,
        accounts: [{ id: 'legacy-1', type: 'oauth', label: 'Legacy' }],
      },
      {
        version: 1,
        accounts: {
          'legacy-1': {
            access: legacy.access,
            refresh: legacy.refresh,
            expires: Date.now() + HOUR,
            refreshExpires: Date.now() + 20 * 24 * HOUR,
            lastUsed: 7,
          },
        },
      },
    )

    const storage = await loadAccounts(configPath)
    const [row] = await listSharedAccounts()
    expect(row).toMatchObject({ label: 'Legacy', kind: 'oauth' })
    expect(storage?.accounts.map((account) => account.id)).toEqual([
      row?.id ?? 'missing',
    ])
    expect(storage?.accounts[0]).toMatchObject({ lastUsed: 7 })
    expect(
      (storage?.accounts[0] as OAuthAccount | undefined)?.access,
    ).toBeUndefined()

    const host = hostText()
    expect(host).not.toContain(legacy.access)
    expect(host).not.toContain(legacy.refresh)
    expect(host).not.toContain('"refresh"')
    expect(readFileSync(store.path, 'utf8')).toContain(legacy.refresh)

    // A second load finds nothing to import.
    await loadAccounts(configPath)
    expect(await listSharedAccounts()).toHaveLength(1)
    expect(mock.presented).toEqual([])
  })

  test('the store copy wins over a host copy of an account it already holds', async () => {
    const seeded = await seedStoreAccount({ label: 'work' })
    const stale = tokens('stale')
    writeHost(
      { version: 1, accounts: [{ id: seeded.id, type: 'oauth' }] },
      {
        version: 1,
        accounts: {
          [seeded.id]: {
            access: stale.access,
            refresh: stale.refresh,
            expires: Date.now() + HOUR,
          },
        },
      },
    )
    await loadAccounts(configPath)
    const persisted = readFileSync(store.path, 'utf8')
    expect(persisted).toContain(seeded.refresh)
    expect(persisted).not.toContain(stale.refresh)
    expect(await listSharedAccounts()).toHaveLength(1)
    expect(hostText()).not.toContain(stale.refresh)
  })

  test('drops malformed fixture tokens instead of storing them', async () => {
    writeHost(
      {
        version: 1,
        accounts: [
          { id: 'yiyi', type: 'oauth' },
          { id: 'fallback-1', type: 'oauth' },
        ],
      },
      {
        version: 1,
        accounts: {
          yiyi: { access: 'yiyi-access', refresh: 'yiyi-refresh' },
          'fallback-1': { access: 'a', refresh: 'b', expires: 1 },
        },
      },
    )
    const storage = await loadAccounts(configPath)
    expect(await listSharedAccounts()).toHaveLength(0)
    expect(hostText()).not.toContain('yiyi-refresh')
    expect(hostText()).not.toContain('yiyi-access')
    expect(storage?.accounts.map((account) => account.id)).toEqual([
      'yiyi',
      'fallback-1',
    ])
  })

  test('does not resurrect an account the config no longer lists', async () => {
    const orphan = tokens('orphan')
    writeHost(
      { version: 1, accounts: [] },
      {
        version: 1,
        accounts: {
          removed: { access: orphan.access, refresh: orphan.refresh },
        },
      },
    )
    await loadAccounts(configPath)
    expect(await listSharedAccounts()).toHaveLength(0)
    expect(hostText()).not.toContain(orphan.refresh)
  })

  test('imports tokens an older version left in the config file itself', async () => {
    const legacy = tokens('configcopy')
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: 'old',
            type: 'oauth',
            label: 'Old',
            access: legacy.access,
            refresh: legacy.refresh,
            expires: Date.now() + HOUR,
          },
        ],
      }),
    )
    await loadAccounts(configPath)
    expect(await listSharedAccounts()).toHaveLength(1)
    expect(readFileSync(configPath, 'utf8')).not.toContain(legacy.refresh)
  })

  test('keeps the tokens (and retries later) when the store cannot be read', async () => {
    const legacy = tokens('deferred')
    writeFileSync(store.path, '{ this is not json')
    writeHost(
      { version: 1, accounts: [{ id: 'later', type: 'oauth' }] },
      {
        version: 1,
        accounts: {
          later: { access: legacy.access, refresh: legacy.refresh },
        },
      },
    )
    await loadAccounts(configPath)
    expect(readFileSync(statePath, 'utf8')).toContain(legacy.refresh)
  })
})

describe('host writes never carry tokens', () => {
  test('saveAccounts and saveAccountState drop runtime tokens', async () => {
    const live = tokens('runtime')
    const account = {
      id: 'acct',
      type: 'oauth',
      label: 'Acct',
      access: live.access,
      expires: Date.now() + HOUR,
      // A caller holding an old-shaped object must not leak it either.
      refresh: live.refresh,
    } as OAuthAccount
    await saveAccounts({ version: 1, accounts: [account] }, configPath)
    await saveAccountState({ version: 1, accounts: [account] }, configPath)
    const host = hostText()
    expect(host).not.toContain(live.access)
    expect(host).not.toContain(live.refresh)
    expect(await listSharedAccounts()).toHaveLength(0)
  })
})
