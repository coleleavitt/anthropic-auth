import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listSharedAccounts,
  STORE_MANAGED_REFRESH_PLACEHOLDER,
} from '@cortexkit/anthropic-auth-core'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import {
  fakeAccessToken,
  fakeRefreshToken,
  type MockTokenServer,
  seedStoreAccount,
  startMockTokenServer,
  type TempStore,
  useTempStore,
} from '../../../core/src/tests/support/store-fixture.ts'
import cortexKitPiAnthropicAuth, {
  loginAnthropic,
  refreshAnthropicToken,
} from '../index'

const originalFetch = globalThis.fetch
const originalStorePath = process.env.ANTHROPIC_ACCOUNTS_FILE
const originalCatalogPath = process.env.ANTHROPIC_MODEL_CATALOG_FILE
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
const tempDirectories: string[] = []

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalStorePath === undefined)
    delete process.env.ANTHROPIC_ACCOUNTS_FILE
  else process.env.ANTHROPIC_ACCOUNTS_FILE = originalStorePath
  if (originalCatalogPath === undefined)
    delete process.env.ANTHROPIC_MODEL_CATALOG_FILE
  else process.env.ANTHROPIC_MODEL_CATALOG_FILE = originalCatalogPath
  if (originalClaudeConfigDir === undefined)
    delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function isolateCatalogState() {
  const directory = await mkdtemp(join(tmpdir(), 'pi-catalog-'))
  tempDirectories.push(directory)
  process.env.ANTHROPIC_ACCOUNTS_FILE = join(directory, 'accounts.json')
  process.env.ANTHROPIC_MODEL_CATALOG_FILE = join(directory, 'catalog.json')
}

function mockPi() {
  const providers = new Map<
    string,
    { models?: Array<Record<string, unknown>> }
  >()

  const pi = {
    registerCommand: () => {},
    registerProvider: (
      name: string,
      config: { models?: Array<Record<string, unknown>> },
    ) => {
      providers.set(name, config)
    },
  } as unknown as ExtensionAPI

  return { pi, providers }
}

describe('cortexKitPiAnthropicAuth provider registration', () => {
  test('exposes Claude Sonnet 5 in the Pi Anthropic catalog', async () => {
    await isolateCatalogState()
    globalThis.fetch = (() => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const { pi, providers } = mockPi()

    await cortexKitPiAnthropicAuth(pi)

    const anthropic = providers.get('anthropic')
    expect(anthropic).toBeDefined()

    const sonnet5 = anthropic?.models?.find(
      (model) => model.id === 'claude-sonnet-5',
    )
    expect(sonnet5).toMatchObject({
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    })
  })

  test('exposes Claude Opus 5 in the Pi Anthropic catalog', async () => {
    await isolateCatalogState()
    globalThis.fetch = (() => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const { pi, providers } = mockPi()

    await cortexKitPiAnthropicAuth(pi)

    const opus5 = providers
      .get('anthropic')
      ?.models?.find((model) => model.id === 'claude-opus-5')
    expect(opus5).toMatchObject({
      id: 'claude-opus-5',
      name: 'Claude Opus 5',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    })
  })
})

describe('refreshAnthropicToken answers from the account store', () => {
  let store: TempStore
  let mock: MockTokenServer

  function begin() {
    store = useTempStore()
    mock = startMockTokenServer()
  }

  afterEach(() => {
    mock?.stop()
    store?.dispose()
  })

  test('a placeholder credential gets the live store token without a refresh', async () => {
    begin()
    const seeded = await seedStoreAccount({ label: 'main' })

    const rotated = await refreshAnthropicToken({
      access: '',
      refresh: STORE_MANAGED_REFRESH_PLACEHOLDER,
      expires: 0,
    })

    expect(rotated.access).toBe(seeded.access)
    expect(rotated.refresh).toBe(STORE_MANAGED_REFRESH_PLACEHOLDER)
    expect(rotated.expires).toBeGreaterThan(Date.now())
    expect(mock.presented).toEqual([])
  })

  test('an expired store token is refreshed once, by the store', async () => {
    begin()
    const seeded = await seedStoreAccount({
      label: 'main',
      expiresAt: Date.now() - 60_000,
    })

    const rotated = await refreshAnthropicToken({
      access: '',
      refresh: STORE_MANAGED_REFRESH_PLACEHOLDER,
      expires: 0,
    })

    expect(mock.presented).toEqual([seeded.refresh])
    expect(rotated).toEqual({
      access: mock.rotatedAccess(1),
      refresh: STORE_MANAGED_REFRESH_PLACEHOLDER,
      expires: expect.any(Number),
    })
    // The next ask is served from the store: nothing is spent twice.
    await refreshAnthropicToken({
      access: rotated.access,
      refresh: STORE_MANAGED_REFRESH_PLACEHOLDER,
      expires: rotated.expires,
    })
    expect(mock.presented).toHaveLength(1)
  })

  test('a real refresh token held by Pi moves into the store once', async () => {
    begin()
    const access = fakeAccessToken(`pihost${process.pid}a`)
    const refresh = fakeRefreshToken(`pihost${process.pid}a`)

    const first = await refreshAnthropicToken({
      access,
      refresh,
      expires: Date.now() + 3_600_000,
    })

    // Pi gets the store's (still live) token and never its refresh token back.
    expect(first).toEqual({
      access,
      refresh: STORE_MANAGED_REFRESH_PLACEHOLDER,
      expires: expect.any(Number),
    })
    const rows = await listSharedAccounts()
    expect(rows).toHaveLength(1)
    expect(mock.presented).toEqual([])

    // A second call with the credential Pi now stores imports nothing.
    await refreshAnthropicToken(first)
    expect(await listSharedAccounts()).toHaveLength(1)
  })

  test('the store copy wins over the same login held by Pi', async () => {
    begin()
    const seeded = await seedStoreAccount({
      label: 'main',
      expiresAt: Date.now() + 3_600_000,
    })

    const result = await refreshAnthropicToken({
      access: seeded.access,
      refresh: seeded.refresh,
      expires: Date.now() - 1_000,
    })

    expect(result.access).toBe(seeded.access)
    expect(result.refresh).toBe(STORE_MANAGED_REFRESH_PLACEHOLDER)
    expect(await listSharedAccounts()).toHaveLength(1)
    expect(mock.presented).toEqual([])
  })

  test('a host token the store cannot parse asks for a re-login and spends nothing', async () => {
    begin()
    await expect(
      refreshAnthropicToken({
        access: 'yiyi-access',
        refresh: 'yiyi-refresh',
        expires: Date.now() - 1_000,
      }),
    ).rejects.toThrow('log in again')
    expect(await listSharedAccounts()).toEqual([])
    expect(mock.presented).toEqual([])
  })

  test('a revoked store token is presented once, then refused locally', async () => {
    begin()
    const seeded = await seedStoreAccount({
      label: 'main',
      expiresAt: Date.now() - 60_000,
    })
    mock.dead.add(seeded.refresh)
    const credential = {
      access: '',
      refresh: STORE_MANAGED_REFRESH_PLACEHOLDER,
      expires: 0,
    }

    await expect(refreshAnthropicToken(credential)).rejects.toMatchObject({
      code: 'invalid_grant',
    })
    await expect(refreshAnthropicToken(credential)).rejects.toBeDefined()

    expect(mock.presented).toEqual([seeded.refresh])
    const [row] = await listSharedAccounts()
    expect(row?.refreshDead).toBe(true)
  })

  test('honors the host abort signal before touching the store', async () => {
    begin()
    const seeded = await seedStoreAccount({
      label: 'main',
      expiresAt: Date.now() - 60_000,
    })
    const controller = new AbortController()
    controller.abort(new Error('host aborted'))

    await expect(
      refreshAnthropicToken(
        { access: '', refresh: seeded.refresh, expires: 0 },
        controller.signal,
      ),
    ).rejects.toThrow('host aborted')
    expect(mock.presented).toEqual([])
  })
})

describe('loginAnthropic', () => {
  let store: TempStore
  let mock: MockTokenServer

  afterEach(() => {
    mock?.stop()
    store?.dispose()
  })

  test('the binding exchanges the code and Pi receives only the placeholder refresh', async () => {
    store = useTempStore()
    mock = startMockTokenServer()
    const tag = `pilogin${process.pid}`
    mock.codes.set('the-code', {
      email: 'login@example.com',
      accountUuid: `uuid-${tag}`,
      tag,
    })

    let authUrl = ''
    const credentials = await loginAnthropic({
      onAuth: ({ url }: { url: string }) => {
        authUrl = url
      },
      onPrompt: async () => {
        const state = new URL(authUrl).searchParams.get('state')
        return `the-code#${state}`
      },
    } as never)

    expect(credentials).toEqual({
      access: mock.loginAccess(tag),
      refresh: STORE_MANAGED_REFRESH_PLACEHOLDER,
      expires: expect.any(Number),
    })
    expect(mock.codeExchanges).toHaveLength(1)
    // The redirect URI the exchange used is the loopback one the URL named.
    expect(mock.codeExchanges[0]?.redirect_uri).toBe(
      new URL(authUrl).searchParams.get('redirect_uri') ?? '',
    )
    const rows = await listSharedAccounts()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      email: 'login@example.com',
      current: true,
    })
  })
})

describe('cold fallback catalog', () => {
  test('includes Claude Haiku 4.5 while offline with no cache', async () => {
    await isolateCatalogState()
    globalThis.fetch = (() => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const { pi, providers } = mockPi()
    await cortexKitPiAnthropicAuth(pi)
    expect(
      providers
        .get('anthropic')
        ?.models?.find((model) => model.id === 'claude-haiku-4-5'),
    ).toMatchObject({
      id: 'claude-haiku-4-5',
      name: 'Claude Haiku 4.5',
      contextWindow: 200_000,
      maxTokens: 64_000,
    })
  })
})
