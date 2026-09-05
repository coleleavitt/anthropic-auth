import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  saveSharedAccountStore,
  updateSharedAccountStore,
} from '@cortexkit/anthropic-auth-core'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import cortexKitPiAnthropicAuth, {
  forgetDeadRefreshTokens,
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

  async function seedRotatedStore(sharedExpiresAt: number) {
    const directory = await mkdtemp(join(tmpdir(), 'pi-refresh-rotated-'))
    tempDirectories.push(directory)
    process.env.ANTHROPIC_ACCOUNTS_FILE = join(directory, 'accounts.json')
    await saveSharedAccountStore({
      version: 1,
      current: 'pi-main',
      accounts: [
        {
          id: 'pi-main',
          credential: {
            type: 'oauth',
            access: 'rotated-access',
            refresh: 'rotated-refresh',
            expires_at: sharedExpiresAt,
            refresh_expires_at: Date.now() + 86_400_000,
          },
          enabled: true,
          created_at: new Date().toISOString(),
        },
      ],
    })
    let refreshCalls = 0
    globalThis.fetch = (async () => {
      refreshCalls += 1
      return Response.json({
        access_token: 'doomed-access',
        refresh_token: 'doomed-refresh',
        expires_in: 3600,
      })
    }) as unknown as typeof fetch
    return { calls: () => refreshCalls }
  }

  test('adopts the rotated shared credential instead of spending a superseded refresh token', async () => {
    const sharedExpiry = Date.now() + 3_600_000
    const refresh = await seedRotatedStore(sharedExpiry)

    await expect(
      refreshAnthropicToken({
        access: 'superseded-access',
        refresh: 'superseded-refresh',
        expires: Date.now() - 1_000,
      }),
    ).resolves.toEqual({
      access: 'rotated-access',
      refresh: 'rotated-refresh',
      expires: sharedExpiry,
    })
    expect(refresh.calls()).toBe(0)
  })

  test('refreshes normally when the rotated shared credential is also expired', async () => {
    const refresh = await seedRotatedStore(Date.now() - 1_000)

    await expect(
      refreshAnthropicToken({
        access: 'superseded-access',
        refresh: 'superseded-refresh',
        expires: Date.now() - 1_000,
      }),
    ).resolves.toMatchObject({ access: 'doomed-access' })
    expect(refresh.calls()).toBe(1)
  })

  test('uses the canonical winner when another process supersedes refresh CAS', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-refresh-cas-'))
    tempDirectories.push(directory)
    const path = join(directory, 'accounts.json')
    process.env.ANTHROPIC_ACCOUNTS_FILE = path
    await saveSharedAccountStore({
      version: 1,
      current: 'pi-main',
      accounts: [
        {
          id: 'pi-main',
          credential: {
            type: 'oauth',
            access: 'old-access',
            refresh: 'old-refresh',
            expires_at: 1,
            refresh_expires_at: Date.now() + 60_000,
          },
          enabled: true,
          created_at: new Date().toISOString(),
        },
      ],
    })
    globalThis.fetch = (async () => {
      await updateSharedAccountStore((store) => {
        const account = store.accounts[0]
        if (account?.credential.type === 'oauth') {
          account.credential.access = 'winner-access'
          account.credential.refresh = 'winner-refresh'
          account.credential.expires_at = 9_999_999
        }
      })
      return Response.json({
        access_token: 'loser-access',
        refresh_token: 'loser-refresh',
        expires_in: 3600,
      })
    }) as unknown as typeof fetch

    await expect(
      refreshAnthropicToken({
        access: 'old-access',
        refresh: 'old-refresh',
        expires: 1,
      }),
    ).resolves.toEqual({
      access: 'winner-access',
      refresh: 'winner-refresh',
      expires: 9_999_999,
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

describe('a revoked refresh token is only presented once', () => {
  test('stops re-presenting a token Anthropic rejected with invalid_grant', async () => {
    // Observed in production: Pi holds its own credential, which is not in the
    // shared store, so the store's dead-token guard could never match it. When
    // that family was revoked the same token was presented on every request —
    // 156 rejected refreshes in one hour — and each failure surfaced to the
    // user as "Authentication failed for anthropic".
    forgetDeadRefreshTokens()
    const directory = await mkdtemp(join(tmpdir(), 'pi-dead-refresh-'))
    tempDirectories.push(directory)
    // A path that does not exist: the store is empty, mirroring a host whose
    // credential Pi holds privately.
    process.env.ANTHROPIC_ACCOUNTS_FILE = join(directory, 'absent.json')

    let tokenPosts = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (url.includes('/v1/oauth/token')) {
        tokenPosts += 1
        return new Response(
          '{"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}',
          { status: 400 },
        )
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const credentials = {
      refresh: `sk-ant-ort01-${'z'.repeat(24)}`,
      access: `sk-ant-oat01-${'z'.repeat(24)}`,
      expires: Date.now() - 60_000,
    }

    const failures: string[] = []
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await refreshAnthropicToken(credentials).catch((error: Error) =>
        failures.push(error.message),
      )
    }

    // Every call still fails — the token really is dead — but only the first
    // one reaches Anthropic.
    expect(failures).toHaveLength(5)
    expect(tokenPosts).toBe(1)
    expect(failures.at(-1)).toContain('revoked')
  })
})

describe('shared credential adoption skips dead accounts', () => {
  test('adopts a live account when the first enabled one has expired', async () => {
    // The chain behind the outage: `current` was unset, so account selection
    // fell back to the first enabled account — whose access token had expired
    // 35 hours earlier. Adoption declined it, and the caller then spent its own
    // revoked refresh token instead of using one of five healthy logins.
    forgetDeadRefreshTokens()
    const directory = await mkdtemp(join(tmpdir(), 'pi-adopt-live-'))
    tempDirectories.push(directory)
    process.env.ANTHROPIC_ACCOUNTS_FILE = join(directory, 'accounts.json')

    const oauth = (id: string, suffix: string, expiresAt: number) => ({
      id,
      label: id,
      email: `${id}@example.com`,
      credential: {
        type: 'oauth' as const,
        access: `sk-ant-oat01-${suffix.repeat(24)}`,
        refresh: `sk-ant-ort01-${suffix.repeat(24)}`,
        expires_at: expiresAt,
        scopes: ['user:inference'],
      },
      enabled: true,
      created_at: '2026-08-27T00:00:00.000Z',
    })

    await saveSharedAccountStore({
      version: 1,
      // No `current`, and the first account is long expired.
      accounts: [
        oauth('expired-first', 'a', Date.now() - 35 * 60 * 60_000),
        oauth('live-second', 'b', Date.now() + 6 * 60 * 60_000),
      ],
    })

    let tokenPosts = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (url.includes('/v1/oauth/token')) {
        tokenPosts += 1
        return new Response('{"error": "invalid_grant"}', { status: 400 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    // A credential Pi holds privately, absent from the store and revoked.
    const adopted = await refreshAnthropicToken({
      refresh: `sk-ant-ort01-${'z'.repeat(24)}`,
      access: `sk-ant-oat01-${'z'.repeat(24)}`,
      expires: Date.now() - 60_000,
    })

    // The live account's credential was adopted; the dead token was never spent.
    expect(adopted.access).toContain('b'.repeat(24))
    expect(tokenPosts).toBe(0)
  })
})

describe('shared refresh lease safety', () => {
  test('honors the host abort signal before spending a refresh token', async () => {
    const controller = new AbortController()
    controller.abort(new Error('host cancelled'))
    let posts = 0
    globalThis.fetch = (async () => {
      posts += 1
      throw new Error('must not fetch')
    }) as unknown as typeof fetch

    await expect(
      refreshAnthropicToken(
        { access: 'old-access', refresh: 'old-refresh', expires: 1 },
        controller.signal,
      ),
    ).rejects.toThrow('host cancelled')
    expect(posts).toBe(0)
  })

  test('never spends a refresh token after claim contention times out', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-refresh-held-'))
    tempDirectories.push(directory)
    process.env.ANTHROPIC_ACCOUNTS_FILE = join(directory, 'accounts.json')
    await saveSharedAccountStore({
      version: 1,
      current: 'pi-main',
      accounts: [
        {
          id: 'pi-main',
          enabled: true,
          created_at: new Date().toISOString(),
          credential: {
            type: 'oauth',
            access: 'old-access',
            refresh: 'old-refresh',
            expires_at: 1,
          },
          refresh_lease: {
            id: 'peer',
            until: Date.now() + 60_000,
            token_fingerprint: 'peer',
            holder_pid: 42,
          },
        },
      ],
    })
    let posts = 0
    globalThis.fetch = (async () => {
      posts += 1
      return Response.json({
        access_token: 'bad',
        refresh_token: 'bad',
        expires_in: 3600,
      })
    }) as unknown as typeof fetch

    await expect(
      refreshAnthropicToken(
        { access: 'old-access', refresh: 'old-refresh', expires: 1 },
        { claimMaxAttempts: 0 },
      ),
    ).rejects.toThrow('refresh claim')
    expect(posts).toBe(0)
  })

  test('rejects a refresh timeout that can outlive the shared lease', async () => {
    let posts = 0
    globalThis.fetch = (async () => {
      posts += 1
      throw new Error('must not fetch')
    }) as unknown as typeof fetch

    await expect(
      refreshAnthropicToken(
        { access: 'old-access', refresh: 'old-refresh', expires: 1 },
        { refreshTimeoutMs: 30_000 },
      ),
    ).rejects.toThrow('below the refresh lease')
    expect(posts).toBe(0)
  })

  test('adopts native rotation into the shared store and releases its lease', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-native-adopt-'))
    tempDirectories.push(directory)
    process.env.ANTHROPIC_ACCOUNTS_FILE = join(directory, 'accounts.json')
    process.env.CLAUDE_CONFIG_DIR = directory
    await saveSharedAccountStore({
      version: 1,
      current: 'missing',
      accounts: [
        {
          id: 'pi-main',
          enabled: true,
          created_at: new Date().toISOString(),
          credential: {
            type: 'oauth',
            access: 'old-access',
            refresh: 'old-refresh',
            expires_at: 1,
          },
        },
      ],
    })
    const expiresAt = Date.now() + 3_600_000
    await writeFile(
      join(directory, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'native-access',
          refreshToken: 'native-refresh',
          expiresAt,
        },
      }),
    )
    let posts = 0
    globalThis.fetch = (async () => {
      posts += 1
      throw new Error('must not fetch')
    }) as unknown as typeof fetch

    await expect(
      refreshAnthropicToken({
        access: 'old-access',
        refresh: 'old-refresh',
        expires: 1,
      }),
    ).resolves.toEqual({
      access: 'native-access',
      refresh: 'native-refresh',
      expires: expiresAt,
    })
    const stored = JSON.parse(
      await readFile(process.env.ANTHROPIC_ACCOUNTS_FILE, 'utf8'),
    )
    expect(stored.current).toBe('pi-main')
    expect(stored.accounts[0].credential).toMatchObject({
      access: 'native-access',
      refresh: 'native-refresh',
      expires_at: expiresAt,
    })
    expect(stored.accounts[0].refresh_lease).toBeUndefined()
    expect(posts).toBe(0)
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
