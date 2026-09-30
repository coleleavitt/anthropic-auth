/**
 * Tests must never reach a production Anthropic endpoint. The Rust binding
 * talks to the token endpoint itself (JS fetch mocks do not intercept it), so
 * the runner points every OAuth URL at a dead loopback address and the
 * preload refuses any binding handle with a non-loopback token URL and any
 * request to an Anthropic/Claude host. These tests prove each layer without
 * sending anything anywhere.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'

import { FallbackAccountManager, type OAuthAccount } from '../accounts.ts'
import {
  ANTHROPIC_OAUTH_TOKEN_URL_ENV,
  AnthropicAuth,
  anthropicAuthConfig,
  getAnthropicAuth,
  getSharedAccessToken,
  isAnthropicAuthError,
  listSharedAccounts,
  startSharedLogin,
} from '../shared-account-store.ts'
import {
  seedStoreAccount,
  type TempStore,
  useTempStore,
} from './support/store-fixture.ts'

type Guard = {
  withExpectedGuardViolation: <T>(fn: () => Promise<T> | T) => Promise<T>
  DEAD_OAUTH_BASE: string
}
const guard = (globalThis as { __anthropicAuthTestGuard?: Guard })
  .__anthropicAuthTestGuard

const HOUR = 3_600_000

let store: TempStore

beforeEach(() => {
  store = useTempStore()
})

afterEach(() => {
  store.dispose()
})

describe('no test can reach a production OAuth endpoint', () => {
  test('the preload guard is installed and the token URL is a dead loopback', () => {
    expect(guard).toBeDefined()
    const tokenUrl = process.env[ANTHROPIC_OAUTH_TOKEN_URL_ENV] ?? ''
    expect(tokenUrl.startsWith(guard?.DEAD_OAUTH_BASE ?? '-')).toBe(true)
    expect(anthropicAuthConfig().tokenUrl).toBe(tokenUrl)
    expect(new URL(tokenUrl).hostname).toBe('127.0.0.1')
  })

  test('every handle the store layer constructs is in the binding test mode', () => {
    expect(process.env.ANTHROPIC_OAUTH_TEST_MODE).toBe('1')
    expect(getAnthropicAuth().testMode).toBe(true)
    // A loopback login gets its own handle; it must be in test mode too.
    expect(() =>
      startSharedLogin({ redirectUri: 'http://localhost:54546/callback' }),
    ).not.toThrow()
  })

  test('the binding itself refuses a production token host in test mode', async () => {
    const seeded = await seedStoreAccount({
      label: 'rustguard',
      expiresAt: Date.now() - HOUR,
    })
    // A separate process without this preload: only the Rust-side switch
    // (ANTHROPIC_OAUTH_TEST_MODE) stands between it and the production
    // host. (The runner's network namespace would stop the packet anyway.)
    const napiPath = createRequire(import.meta.url).resolve(
      '@coleleavitt/anthropic-napi',
    )
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `const { AnthropicAuth } = require(${JSON.stringify(napiPath)});
         const auth = new AnthropicAuth({ storePath: ${JSON.stringify(store.path)} });
         try { await auth.getAccessToken({ account: ${JSON.stringify(seeded.id)} }); console.log('REFRESHED') }
         catch (e) { console.log(auth.testMode, e.code, e.message) }`,
      ],
      {
        env: {
          ...process.env,
          ANTHROPIC_OAUTH_TEST_MODE: '1',
          ANTHROPIC_OAUTH_TOKEN_URL:
            'https://platform.claude.com/v1/oauth/token',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(await child.exited).toBe(0)
    const output = (await new Response(child.stdout).text()).trim()
    expect(output.startsWith('true config')).toBe(true)
    expect(output).not.toContain('REFRESHED')
  })

  test('an expired row with no mock server fails with a connect error, not a production refresh', async () => {
    const seeded = await seedStoreAccount({
      label: 'unmocked',
      expiresAt: Date.now() - HOUR,
    })
    const error = await getSharedAccessToken(seeded.id).catch(
      (caught: unknown) => caught,
    )
    expect(isAnthropicAuthError(error, 'transient')).toBe(true)
    // A connect failure is not a verdict on the token.
    const [row] = await listSharedAccounts()
    expect(row?.refreshDead).toBe(false)
    expect(row?.accessLive).toBe(false)

    const account: OAuthAccount = { id: seeded.id, type: 'oauth' }
    await expect(
      new FallbackAccountManager().ensureAccessToken(account),
    ).rejects.toThrow()
    expect(account.lastRefreshError?.permanent).toBe(false)
  })

  test('a binding handle with the production default token URL is refused', async () => {
    const error = await guard?.withExpectedGuardViolation(() => {
      try {
        new AnthropicAuth({ storePath: store.path })
      } catch (caught) {
        return caught
      }
      return undefined
    })
    expect((error as Error | undefined)?.name).toBe('TestNetworkGuardError')
  })

  test('a binding handle aimed at platform.claude.com is refused', async () => {
    const error = await guard?.withExpectedGuardViolation(() => {
      try {
        new AnthropicAuth({
          storePath: store.path,
          tokenUrl: 'https://platform.claude.com/v1/oauth/token',
        })
      } catch (caught) {
        return caught
      }
      return undefined
    })
    expect((error as Error | undefined)?.name).toBe('TestNetworkGuardError')
  })

  test("the package's default-handle helpers are unavailable", async () => {
    const napi = createRequire(import.meta.url)(
      '@coleleavitt/anthropic-napi',
    ) as { getAccessToken: () => Promise<unknown> }
    const error = await guard?.withExpectedGuardViolation(() => {
      try {
        return napi.getAccessToken()
      } catch (caught) {
        return caught
      }
    })
    expect((error as Error | undefined)?.name).toBe('TestNetworkGuardError')
  })

  test('fetch to an Anthropic host is blocked in-process', async () => {
    for (const url of [
      'https://platform.claude.com/v1/oauth/token',
      'https://console.anthropic.com/',
      'https://api.anthropic.com/v1/messages',
      'https://claude.ai/',
    ]) {
      const error = await guard?.withExpectedGuardViolation(() =>
        // Already aborted: even without the guard nothing would be sent.
        fetch(url, { signal: AbortSignal.abort() }).catch(
          (caught: unknown) => caught,
        ),
      )
      expect((error as Error | undefined)?.name).toBe('TestNetworkGuardError')
    }
  })
})
