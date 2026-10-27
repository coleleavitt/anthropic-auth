import { afterEach, beforeEach, describe, expect, mock } from 'bun:test'
import {
  type AccountStorage,
  createNativeAccountRuntime,
  isOAuthAccount,
  type OAuthAccount,
} from '@cortexkit/anthropic-auth-core'
import type { getSidebarState } from '../sidebar-state'
import type { createMockClient } from './support/opencode1-client.ts'
import {
  createFallbackStorage,
  getPlugin as getPluginWithCtx,
  syntheticMainHostAuth,
  useTempAccountFile as useTempAccountFileWithCtx,
  withNativeAdmission as withNativeAdmissionWithCtx,
} from './support/opencode1-pool-fixture.ts'
import {
  readAccountStorage as readAccountStorageWithCtx,
  waitForSidebarState as waitForSidebarStateWithCtx,
} from './support/opencode1-state-observers.ts'
import type { PluginRuntimeOverrides } from './support/opencode1-test-context.ts'
import {
  createOpencode1Test,
  createOpencode1TestContext,
  drainBeforeReset,
  EMPTY_POST,
  installOpencode1TestHooks,
} from './support/opencode1-test-context.ts'
import { extractUrl, MESSAGES_URL } from './test-fetch'

const testContext = createOpencode1TestContext()
installOpencode1TestHooks(testContext)
const test = createOpencode1Test(testContext)

function useTempAccountFile(
  storage: AccountStorage,
  mainHostAuth: {
    access: string
    refresh: string
    expires: number
  } = syntheticMainHostAuth(),
) {
  return useTempAccountFileWithCtx(testContext, storage, mainHostAuth)
}
function withNativeAdmission<Input, Init>(
  handler: (input: Input, init: Init) => unknown,
) {
  return withNativeAdmissionWithCtx(testContext, handler)
}
function getPlugin(
  client?: ReturnType<typeof createMockClient>,
  directory?: string,
  runtimeOverrides: PluginRuntimeOverrides = {},
): any {
  return getPluginWithCtx(testContext, client, directory, runtimeOverrides)
}
function waitForSidebarState(
  predicate: (state: Awaited<ReturnType<typeof getSidebarState>>) => boolean,
) {
  return waitForSidebarStateWithCtx(testContext, predicate)
}
function readAccountStorage(): Promise<AccountStorage | null> {
  return readAccountStorageWithCtx(testContext)
}

describe('killswitch fetch gate', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    // Prevent this plugin instance's background intervals from leaking into
    // later tests without mutating process-global timers used by other files.
    testContext.pluginRuntimeOverrides = {
      setInterval: mock(
        () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
      ) as unknown as typeof setInterval,
      clearInterval: mock(() => {}) as unknown as typeof clearInterval,
    }
  })

  afterEach(async () => {
    await drainBeforeReset(testContext.testLifetime, () => {
      globalThis.fetch = originalFetch
      testContext.pluginRuntimeOverrides = {}
      delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    })
  })

  const oauthLoader = () =>
    Promise.resolve({
      type: 'oauth' as const,
      access: 'sk-ant-oat01-main-access',
      refresh: 'main-refresh',
      expires: Date.now() + 100000,
    })

  // Main below the soft routing threshold but ABOVE the killswitch threshold,
  // with no fallbacks: the killswitch must not hard-block — the request falls
  // through to main as it would with the killswitch disabled.
  test('does not 429 when main is only below the routing threshold', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: true,
        },
        killswitch: { enabled: true, main: { five_hour: 5, seven_day: 10 } },
      }),
    )

    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        if (extractUrl(input).includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              // Main has 8% five-hour quota: below the 10% routing minimum,
              // but above the 5% hard-block threshold. Weekly quota is healthy.
              JSON.stringify({
                five_hour: { utilization: 92 },
                seven_day: { utilization: 40 },
              }),
              { status: 200 },
            ),
          )
        }
        return Promise.resolve(new Response('message-ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('message-ok')
  })

  // Main killed (below killswitch threshold) with a non-replayable body and a
  // healthy fallback: the fallback cannot accept the request, so the killswitch
  // must 429 rather than silently serving the killed main account.
  test('429s a non-replayable request when main is killed even if a fallback is alive', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        killswitch: { enabled: true, main: { five_hour: 5, seven_day: 10 } },
      }),
    )

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        if (extractUrl(input).includes('/api/oauth/usage')) {
          const authorization =
            new Headers(init?.headers).get('authorization') ?? ''
          // Main's 2% remaining quota triggers the hard block. The fallback
          // account has 90% remaining and can serve instead.
          const utilization = authorization.includes('sk-ant-oat01-main-access')
            ? 98
            : 10
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization },
                seven_day: { utilization: 10 },
              }),
              { status: 200 },
            ),
          )
        }
        return Promise.resolve(new Response('message-ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hi'))
        controller.close()
      },
    })

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit)

    expect(response.status).toBe(429)
    expect(await response.text()).toContain('Killswitch')
  })

  test('429s a replayable request when main is killed and the only fallback passes killswitch but fails routing quota policy', async () => {
    // The fallback is above its killswitch threshold (so it passes the
    // killswitch quota check) but below the routing minimumRemaining, so
    // getUsableFallbackAccounts — and therefore routing — drops it. The 429
    // decision must be derived from the routable set, not the storage snapshot,
    // so the request is hard-blocked instead of falling through to the killed
    // main account.
    await useTempAccountFile(
      createFallbackStorage({
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: false,
        },
        killswitch: { enabled: true, main: { five_hour: 5, seven_day: 10 } },
        accounts: [
          {
            id: 'fallback-1',
            type: 'oauth',
            access: 'sk-ant-oat01-fallback-access',
            refresh: 'fallback-refresh',
            expires: Date.now() + 5 * 60 * 60 * 1000,
          },
        ],
      }),
    )

    let mainServed = false
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          const authorization =
            new Headers(init?.headers).get('authorization') ?? ''
          // Main's 2% five-hour quota triggers the hard block. The fallback's
          // 7% passes the 5% hard-block threshold but not the 10% routing minimum.
          const fiveHourUtil = authorization.includes(
            'sk-ant-oat01-main-access',
          )
            ? 98
            : 93
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: fiveHourUtil },
                seven_day: { utilization: 50 },
              }),
              { status: 200 },
            ),
          )
        }
        mainServed = true
        return Promise.resolve(new Response('message-ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(429)
    expect(await response.text()).toContain('Killswitch')
    // Must NOT have fallen through to the killswitched main account.
    expect(mainServed).toBe(false)
  })

  test('fallback-first routing does not serve from a killswitch-killed fallback', async () => {
    // killswitch threshold (5h:50) is higher than the routing minimumRemaining
    // (5h:10): a fallback at 30% passes routing policy but is killswitch-killed.
    // fallback-first must NOT serve from it — it should fall through to the
    // healthy main account instead.
    const storage = createFallbackStorage({
      routing: { mode: 'fallback-first' },
      quota: {
        enabled: true,
        checkIntervalMinutes: 5,
        minimumRemaining: { five_hour: 10, seven_day: 20 },
        failClosedOnUnknownQuota: false,
      },
      killswitch: { enabled: true, main: { five_hour: 50, seven_day: 10 } },
      accounts: [
        {
          id: 'fallback-1',
          type: 'oauth',
          access: 'sk-ant-oat01-fallback-access',
          refresh: 'fallback-refresh',
          expires: Date.now() + 5 * 60 * 60 * 1000,
        },
      ],
    })
    const fallback = storage.accounts.find(
      (account) => account.id === 'fallback-1',
    )
    if (!fallback || !isOAuthAccount(fallback))
      throw new Error('Missing killswitch fixture fallback')
    delete fallback.quota
    await useTempAccountFile(storage)
    const initialFallback = (await readAccountStorage())?.accounts.find(
      (account): account is OAuthAccount =>
        account.id === 'fallback-1' && isOAuthAccount(account),
    )
    expect(initialFallback?.quota).toBeUndefined()

    let servedAuth: string | undefined
    const quotaAuthorizations: string[] = []
    const modelAuthorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage')) {
            const authorization =
              new Headers(init?.headers).get('authorization') ?? ''
            quotaAuthorizations.push(authorization)
            const isMain = authorization.includes('sk-ant-oat01-main-access')
            // Main has 80% remaining and can serve. The fallback's 30% passes
            // the 10% routing minimum but fails its 50% hard-block threshold.
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  five_hour: { utilization: isMain ? 20 : 70 },
                  seven_day: { utilization: isMain ? 20 : 50 },
                }),
                { status: 200 },
              ),
            )
          }
          servedAuth = new Headers(init?.headers).get('authorization') ?? ''
          modelAuthorizations.push(servedAuth)
          return Promise.resolve(new Response('message-ok', { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    if (!servedAuth?.includes('sk-ant-oat01-main-access')) {
      // Capture policy state only after a wrong route; diagnostics must not
      // change the ordering of a successful quota preflight.
      if (!testContext.migratedPool)
        throw new Error('Missing native killswitch fixture')
      const reader = createNativeAccountRuntime({
        paths: testContext.migratedPool.paths,
        host: 'opencode',
      })
      try {
        const snapshot = await reader.read()
        console.error('killswitch route mismatch', {
          usageCalls: quotaAuthorizations.map((value) =>
            value.includes('sk-ant-oat01-main-access')
              ? 'main'
              : value.includes('sk-ant-oat01-fallback-access')
                ? 'fallback'
                : 'other',
          ),
          killswitch: snapshot.policyStorage.killswitch,
          accounts: snapshot.accounts.map((account) => ({
            id: account.id,
            fiveHourUsed: account.quota?.five_hour?.usedPercent,
            fiveHourRemaining: account.quota?.five_hour?.remainingPercent,
            quotaCheckedAt: account.quota?.checkedAt,
            state: account.state,
          })),
        })
      } finally {
        reader.close()
      }
    }
    expect(servedAuth).toContain('sk-ant-oat01-main-access')
    expect(servedAuth).not.toContain('sk-ant-oat01-fallback-access')
    const again = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(again.status).toBe(200)
    expect(modelAuthorizations).toEqual([
      'Bearer sk-ant-oat01-main-access',
      'Bearer sk-ant-oat01-main-access',
    ])
    expect(quotaAuthorizations).toEqual([
      'Bearer sk-ant-oat01-fallback-access',
      'Bearer sk-ant-oat01-main-access',
    ])
  })

  test('fail-closed killswitch blocks the first request when main quota is unknown', async () => {
    // failClosedOnUnknownQuota=true: on the first request the quota API is down,
    // so the eager refresh fails and main quota stays unknown. The killswitch
    // must treat main as killed (fail-closed) and 429 rather than fall through
    // to main — even before the quota-API backoff is armed.
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: true,
        },
        killswitch: { enabled: true, main: { five_hour: 5, seven_day: 10 } },
      }),
    )

    let mainServed = false
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          // The failed usage request cannot establish main account quota,
          // so fail-closed policy must keep model dispatch blocked.
          return Promise.resolve(
            new Response('upstream error', { status: 500 }),
          )
        }
        mainServed = true
        return Promise.resolve(new Response('message-ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(429)
    expect(mainServed).toBe(false)
  })

  test('sidebar marks the fallback active when the killswitch routes to it', async () => {
    // killswitch threshold (5h:50) is above the routing minimumRemaining
    // (5h:10): main at 30% passes routing (so the routing writeback optimistically
    // sets the sidebar to 'main') but is killswitch-killed, so the killswitch gate
    // hands off to the healthy fallback. The sidebar's active account must be
    // corrected to that fallback, not left showing 'main'.
    await useTempAccountFile(
      createFallbackStorage({
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: false,
        },
        killswitch: { enabled: true, main: { five_hour: 50, seven_day: 10 } },
        accounts: [
          {
            id: 'fallback-1',
            type: 'oauth',
            access: 'sk-ant-oat01-fallback-access',
            refresh: 'fallback-refresh',
            expires: Date.now() + 5 * 60 * 60 * 1000,
          },
        ],
      }),
    )

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          const authorization =
            new Headers(init?.headers).get('authorization') ?? ''
          const isMain = authorization.includes('sk-ant-oat01-main-access')
          // Main's 30% five-hour quota passes routing but triggers its 50%
          // hard block. The fallback has 90%; both weekly windows are healthy.
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: isMain ? 70 : 10 },
                seven_day: { utilization: 10 },
              }),
              { status: 200 },
            ),
          )
        }
        return Promise.resolve(new Response('message-ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    const state = await waitForSidebarState((s) => s.activeId === 'fallback-1')
    expect(state.activeId).toBe('fallback-1')
  })

  test('killswitch returns the surviving fallback error rather than falling through to the killed main', async () => {
    // main is killswitch-killed; a surviving fallback is tried but returns 429.
    // The killswitch is a hard block, so the request must surface the fallback's
    // real error — never retry on the killed main.
    await useTempAccountFile(
      createFallbackStorage({
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: false,
        },
        killswitch: { enabled: true, main: { five_hour: 50, seven_day: 10 } },
        accounts: [
          {
            id: 'fallback-1',
            type: 'oauth',
            access: 'sk-ant-oat01-fallback-access',
            refresh: 'fallback-refresh',
            expires: Date.now() + 5 * 60 * 60 * 1000,
          },
        ],
      }),
    )

    let mainServed = false
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        if (url.includes('/api/oauth/usage')) {
          const isMain = authorization.includes('sk-ant-oat01-main-access')
          // Main's 30% remaining quota triggers its 50% hard block despite
          // passing routing. The fallback account has 90% and passes both.
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: isMain ? 70 : 10 },
                seven_day: { utilization: 10 },
              }),
              { status: 200 },
            ),
          )
        }
        if (authorization.includes('sk-ant-oat01-main-access')) {
          mainServed = true
          return Promise.resolve(new Response('main-ok', { status: 200 }))
        }
        // The fallback account passes quota policy, but its model request
        // receives a rate limit; the killed main must remain excluded.
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'fallback-limited' }), {
            status: 429,
          }),
        )
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(429)
    const body = await response.text()
    expect(body).toContain('fallback-limited')
    expect(body).not.toContain('Killswitch: no routable')
    expect(mainServed).toBe(false)
  })
})
