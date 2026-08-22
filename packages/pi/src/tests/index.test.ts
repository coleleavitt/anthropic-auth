import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  saveSharedAccountStore,
  updateSharedAccountStore,
} from '@cortexkit/anthropic-auth-core'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import cortexKitPiAnthropicAuth, { refreshAnthropicToken } from '../index'

const originalFetch = globalThis.fetch
const originalStorePath = process.env.ANTHROPIC_ACCOUNTS_FILE
const originalCatalogPath = process.env.ANTHROPIC_MODEL_CATALOG_FILE
const tempDirectories: string[] = []

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalStorePath === undefined)
    delete process.env.ANTHROPIC_ACCOUNTS_FILE
  else process.env.ANTHROPIC_ACCOUNTS_FILE = originalStorePath
  if (originalCatalogPath === undefined)
    delete process.env.ANTHROPIC_MODEL_CATALOG_FILE
  else process.env.ANTHROPIC_MODEL_CATALOG_FILE = originalCatalogPath
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
})
