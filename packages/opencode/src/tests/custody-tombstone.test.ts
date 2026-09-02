import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertNotCustodyTombstone,
  buildRefreshOperationError,
  CustodyTombstoneRefreshError,
  FallbackAccountManager,
  getAccountStatePath,
  getFallbackReauthLabels,
  isCustodyTombstoneOAuth,
  isCustodyTombstoneValue,
  isPermanentRefreshError,
  loadAccounts,
  readCustodyHandles,
  saveAccounts,
} from '@cortexkit/anthropic-auth-core'
import { AnthropicAuthPlugin } from '../index'
import { extractUrl, TOKEN_URL } from './test-fetch'

const fixtureDir = join(import.meta.dir, 'fixtures', 'claustrum-golden')
const tombstoneFixture = JSON.parse(
  readFileSync(join(fixtureDir, 'tombstone.json'), 'utf8'),
) as {
  fixtures: {
    api: { provider: string; entry: Record<string, unknown> }
    oauth: { provider: string; entry: Record<string, unknown> }
  }
}
const handlesFixture = JSON.parse(
  readFileSync(join(fixtureDir, 'handles.json'), 'utf8'),
)

const oauthFixture = tombstoneFixture.fixtures.oauth
const apiFixture = tombstoneFixture.fixtures.api
const originalFetch = globalThis.fetch

function createMockClient() {
  return {
    auth: { set: mock(() => Promise.resolve()) },
    session: { promptAsync: mock(() => Promise.resolve()) },
  }
}

function disabledTimerOverrides() {
  return {
    setInterval: mock(
      () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
    ) as unknown as typeof setInterval,
    clearInterval: mock(() => {}) as unknown as typeof clearInterval,
  }
}

async function createTempStorage<T>(
  storage: Record<string, unknown>,
  callback: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'anthropic-custody-test-'))
  const path = join(directory, 'anthropic-auth.json')
  const previous = process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = path
  try {
    await saveAccounts(storage as never, path)
    return await callback(path)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
    else process.env.OPENCODE_ANTHROPIC_AUTH_FILE = previous
    await rm(directory, { recursive: true, force: true })
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Claustrum custody tombstones', () => {
  test('recognizes only the provider-bound OAuth golden shape', () => {
    const oauth = oauthFixture.entry
    const oauthRefresh = oauth.refresh as string
    expect(isCustodyTombstoneOAuth(oauth, oauthFixture.provider)).toBe(true)
    expect(isCustodyTombstoneOAuth(oauth, apiFixture.provider)).toBe(false)
    expect(isCustodyTombstoneValue(oauthRefresh)).toBe(true)
    expect(isCustodyTombstoneOAuth(apiFixture.entry, apiFixture.provider)).toBe(
      false,
    )

    expect(
      isCustodyTombstoneOAuth(
        {
          ...oauth,
          refresh: oauthRefresh.replace(':v1:', ':v2:'),
        },
        oauthFixture.provider,
      ),
    ).toBe(false)
    expect(
      isCustodyTombstoneOAuth(
        { ...oauth, access: `${String(oauth.access)}-different` },
        oauthFixture.provider,
      ),
    ).toBe(false)
    expect(
      isCustodyTombstoneOAuth(
        { ...oauth, type: apiFixture.entry.type },
        oauthFixture.provider,
      ),
    ).toBe(false)
  })

  test('rejects sentinel whitespace, provider variants, and split credentials', () => {
    const oauth = oauthFixture.entry
    const oauthRefresh = oauth.refresh as string
    const anthropic2Refresh = oauthRefresh.replace(
      oauthFixture.provider,
      `${oauthFixture.provider}-2`,
    )

    expect(
      isCustodyTombstoneOAuth(
        { ...oauth, refresh: `${oauthRefresh} ` },
        oauthFixture.provider,
      ),
    ).toBe(false)
    expect(isCustodyTombstoneOAuth(oauth, `${oauthFixture.provider}-2`)).toBe(
      false,
    )
    expect(
      isCustodyTombstoneOAuth(
        { ...oauth, refresh: anthropic2Refresh, access: anthropic2Refresh },
        oauthFixture.provider,
      ),
    ).toBe(false)

    const split = {
      ...oauth,
      access: String(oauth.access).replace(oauthRefresh, 'real-access-token'),
    }
    expect(isCustodyTombstoneOAuth(split, oauthFixture.provider)).toBe(false)
    expect(() =>
      assertNotCustodyTombstone(
        (split as Record<string, unknown>).refresh,
        oauthFixture.provider,
      ),
    ).toThrow(CustodyTombstoneRefreshError)
  })

  test('throws a non-provider-refresh error before the token endpoint', () => {
    let thrown: unknown
    try {
      assertNotCustodyTombstone(
        oauthFixture.entry.refresh,
        oauthFixture.provider,
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CustodyTombstoneRefreshError)
    expect(thrown).toMatchObject({
      code: 'custody_tombstone_refresh',
      provider: oauthFixture.provider,
    })
    expect(thrown).not.toHaveProperty('isRefreshError')
    expect(thrown).not.toHaveProperty('permanent')
    expect(thrown).not.toHaveProperty('status')
    expect(String(thrown)).toContain(
      'vault-served main path is not yet implemented',
    )
  })

  test('reads handles while tolerating and dropping superseded entries', () => {
    const anthropicSource = handlesFixture.providers.find(
      (provider: { provider: string }) =>
        provider.provider === oauthFixture.provider,
    )
    const anthropic = readCustodyHandles(handlesFixture, oauthFixture.provider)
    expect(anthropic).toEqual({
      provider: anthropicSource.provider,
      serve: anthropicSource.serve,
      shape: anthropicSource.shape,
      accounts: anthropicSource.accounts.map(
        (account: {
          label: string
          handle: string
          credential_id: string
        }) => ({
          label: account.label,
          handle: account.handle,
          credentialId: account.credential_id,
        }),
      ),
    })
    const deepseek = readCustodyHandles(handlesFixture, apiFixture.provider)
    expect(deepseek.accounts[1]).not.toHaveProperty('superseded')
    expect(deepseek.accounts[1]).toMatchObject({
      handle: handlesFixture.providers[0].accounts[1].handle,
    })
  })

  test('filters malformed handle accounts and tolerates unknown fields', () => {
    const fixture = structuredClone(handlesFixture) as {
      providers: Array<{
        provider: string
        accounts: Array<Record<string, unknown>>
      }>
    }
    const anthropic = fixture.providers.find(
      (provider) => provider.provider === oauthFixture.provider,
    )
    if (!anthropic) throw new Error('missing anthropic fixture')
    const account = anthropic.accounts[0]
    if (!account) throw new Error('missing anthropic account fixture')
    const missingHandle = { ...account }
    delete missingHandle.handle
    const missingCredentialId = { ...account }
    delete missingCredentialId.credential_id
    anthropic.accounts = [
      missingHandle,
      missingCredentialId,
      { ...account, extra: 'ignored' },
    ]

    expect(readCustodyHandles(fixture, oauthFixture.provider).accounts).toEqual(
      [
        {
          label: String(account.label),
          handle: String(account.handle),
          credentialId: String(account.credential_id),
        },
      ],
    )
  })

  test('throws when the requested provider is absent', () => {
    expect(() =>
      readCustodyHandles(handlesFixture, `${oauthFixture.provider}-missing`),
    ).toThrow(
      `Missing custody handles for provider ${oauthFixture.provider}-missing`,
    )
  })

  test('main loader rejects the tombstone without network or refresh state', async () => {
    const fetchCalls: string[] = []
    globalThis.fetch = mock((input: unknown) => {
      const url = extractUrl(input as string | URL | Request)
      fetchCalls.push(url)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

    await createTempStorage(
      {
        version: 1,
        main: { type: 'opencode', provider: oauthFixture.provider },
        refresh: { enabled: false },
        quota: { enabled: false },
        accounts: [],
      },
      async (path) => {
        const plugin = (await AnthropicAuthPlugin(
          // @ts-expect-error: minimal mock for testing
          { client: createMockClient() },
          disabledTimerOverrides(),
        )) as any
        await expect(
          plugin.auth.loader(
            () => Promise.resolve(oauthFixture.entry as never),
            { models: {} } as never,
          ),
        ).rejects.toBeInstanceOf(CustodyTombstoneRefreshError)
        expect(fetchCalls.filter((url) => url === TOKEN_URL)).toHaveLength(0)

        const statePath = getAccountStatePath(path)
        if (existsSync(statePath)) {
          const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<
            string,
            unknown
          >
          expect(state).not.toHaveProperty('permanent')
          expect(state).not.toHaveProperty('needsReauth')
          expect(state).not.toHaveProperty('mainLastRefreshError')
          expect(state).not.toHaveProperty('backoff')
        }
        await plugin.dispose?.()
      },
    )
  })

  test('fallback refresh rejects the tombstone without network or refresh classification', async () => {
    const fetchCalls: string[] = []
    const fetchImpl = mock((input: unknown) => {
      fetchCalls.push(extractUrl(input as string | URL | Request))
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
        }),
      )
    }) as unknown as typeof fetch
    const account = {
      id: 'fallback-tombstone',
      type: 'oauth' as const,
      access: 'expired-access',
      refresh: oauthFixture.entry.refresh as string,
      expires: 0,
    }
    const storage = {
      version: 1,
      main: { type: 'opencode', provider: oauthFixture.provider },
      refresh: {
        enabled: true,
        intervalMinutes: 10,
        refreshBeforeExpiryMinutes: 30,
      },
      quota: {
        enabled: true,
        checkIntervalMinutes: 5,
        minimumRemaining: { five_hour: 0, seven_day: 0 },
        failClosedOnUnknownQuota: false,
      },
      accounts: [account],
    }

    await createTempStorage(storage, async (path) => {
      const manager = new FallbackAccountManager({
        configPath: path,
        fetchImpl,
      })
      const refreshError = await manager
        .refreshAccount(account, storage as never)
        .catch((error: unknown) => error)
      expect(fetchCalls.filter((url) => url === TOKEN_URL)).toHaveLength(0)
      expect(refreshError).toBeInstanceOf(CustodyTombstoneRefreshError)
      await manager.refreshDueAccounts()
      await manager.refreshQuotaForDueAccounts()
      const loaded = await loadAccounts(path)
      expect(loaded?.accounts[0]?.type).toBe('oauth')
      if (loaded?.accounts[0]?.type === 'oauth') {
        expect(loaded.accounts[0].lastRefreshError).toBeUndefined()
        expect(loaded.accounts[0].lastQuotaRefreshError).toBeUndefined()
      }
      expect(getFallbackReauthLabels(loaded)).toEqual([])
      const classification = buildRefreshOperationError({
        error: new CustodyTombstoneRefreshError(oauthFixture.provider),
        now: 1,
        accountIdentity: account.id,
      })
      expect(isPermanentRefreshError(classification)).toBe(false)
      expect(classification.permanent).toBe(false)
    })
  })
})
