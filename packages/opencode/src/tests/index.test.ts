import { afterEach, beforeEach, describe, expect, mock, spyOn } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as filesystem from 'node:fs/promises'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PrimeManager } from '@cortexkit/anthropic-auth-core'
import * as Core from '@cortexkit/anthropic-auth-core'
import {
  __setLogTestSink,
  type AccountStorage,
  buildPrimeRequestBody,
  buildRefreshOperationError,
  ClaudeOAuthRefreshError,
  type CommandApplyRequest,
  type CommandApplyResult,
  createNativeAccountRuntime,
  createNativePoolStore,
  custodyTombstoneOAuth,
  extractBillingHeaderCCH,
  getAccountStatePath,
  getClaudeCodeIdentityForVerifiedAccount,
  hashRefreshToken,
  isNativeLocalCredentialValidation,
  isOAuthAccount,
  type LogTestRecord,
  type NativeCustodyClient,
  type OAuthAccount,
  type OAuthQuotaSnapshot,
  PROFILE_TTL_MS,
  type ProviderAccountUuid,
  setLogLevel,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import { withLock } from '@cortexkit/common-auth/fs'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec.ts'
import type { TestLifetime } from '../../../core/src/tests/test-lifetime.ts'
import {
  drainNotifications,
  resetNotificationsForTest,
} from '../rpc/notifications'
import { COMMAND_MODAL_NAMES } from '../rpc/protocol'
import {
  SERVER_FALLBACK_SIGNATURE_PREFIX,
  SERVER_SIDE_FALLBACK_BETA,
} from '../server-fallback'
import {
  __setInitialSidebarRoutingTestHooks,
  drainSidebarWrites,
  getSidebarState,
  getSidebarStateFile,
  resolveActiveAccount,
  setSidebarState,
} from '../sidebar-state'
import { rewriteRequestBody } from '../transform.ts'
import { getPluginTestHandles } from './plugin-test-handles'
import {
  applyMenuAction as applyMenuActionWithCtx,
  createMockClient,
  expectHandledCommandResponse,
  fireConcurrentFetches,
  latestIgnoredReply,
  openClaudeMenu,
} from './support/opencode1-client.ts'
import { installLoaderSetup } from './support/opencode1-loader-setup.ts'
import {
  addPoolOAuthAccount as addPoolOAuthAccountWithCtx,
  bindMainAccount,
  bindMainQuotaToAccount,
  bindPoolAccounts,
  createFallbackStorage,
  expectHostActivationNonSecret as expectHostActivationNonSecretWithCtx,
  expectNoCredentialFragment as expectNoCredentialFragmentWithCtx,
  getPlugin as getPluginWithCtx,
  loginIssues as loginIssuesWithCtx,
  mainAccountIssues as mainAccountIssuesWithCtx,
  migratedHostAuth as migratedHostAuthWithCtx,
  nativeAdmissionAnswer as nativeAdmissionAnswerWithCtx,
  nativeBootstrapAnswer as nativeBootstrapAnswerWithCtx,
  nativeTokenAnswer as nativeTokenAnswerWithCtx,
  poolMainAccess as poolMainAccessWithCtx,
  poolMainIdentity as poolMainIdentityWithCtx,
  publishNativeMainQuota as publishNativeMainQuotaWithCtx,
  publishPoolMetadata as publishPoolMetadataWithCtx,
  publishPoolQuota as publishPoolQuotaWithCtx,
  readNativeRuntimeState as readNativeRuntimeStateWithCtx,
  readNativeSettings as readNativeSettingsWithCtx,
  refreshPoolLoginElsewhere as refreshPoolLoginElsewhereWithCtx,
  refreshPoolMainElsewhere as refreshPoolMainElsewhereWithCtx,
  registerPoolLogins as registerPoolLoginsWithCtx,
  replacePoolMainLogin as replacePoolMainLoginWithCtx,
  requireKnownPoolSubject,
  setupExpiredTokenLoader as setupExpiredTokenLoaderWithCtx,
  syntheticFallbackAccountUuid,
  syntheticMainAccountUuid,
  syntheticMainHostAuth,
  updatePoolRelay as updatePoolRelayWithCtx,
  updatePoolSettings as updatePoolSettingsWithCtx,
  useTempAccountFile as useTempAccountFileWithCtx,
  useUnmigratedAccountFile as useUnmigratedAccountFileWithCtx,
  useVaultAccountFile as useVaultAccountFileWithCtx,
  waitForPoolCredential as waitForPoolCredentialWithCtx,
  withMainAdmission as withMainAdmissionWithCtx,
  withNativeAdmission as withNativeAdmissionWithCtx,
  withNativeBootstrap as withNativeBootstrapWithCtx,
  withNativeTokenExchange as withNativeTokenExchangeWithCtx,
} from './support/opencode1-pool-fixture.ts'
import {
  expectNonOatMainRefused as expectNonOatMainRefusedWithCtx,
  loadMainAndFetch as loadMainAndFetchWithCtx,
  readFeedEntries,
  waitForFeedEntries as waitForFeedEntriesWithCtx,
  waitForLogRecord as waitForLogRecordWithCtx,
} from './support/opencode1-quota-feed.ts'
import {
  readAccountStorage as readAccountStorageWithCtx,
  seedSidebarRouting,
  waitForAccountStorage as waitForAccountStorageWithCtx,
  waitForMockCall,
  waitForNativePoolQuota as waitForNativePoolQuotaWithCtx,
  waitForSidebarState as waitForSidebarStateWithCtx,
} from './support/opencode1-state-observers.ts'
import type {
  MigratedPool,
  PluginRuntimeOverrides,
  PoolLogin,
} from './support/opencode1-test-context.ts'
import {
  cleanupTempConfigDirs as cleanupTempConfigDirsWithCtx,
  createOpencode1Test,
  createOpencode1TestContext,
  EMPTY_POST,
  getBodyLifetime,
  heldResponse as heldResponseWithCtx,
  installOpencode1TestHooks,
  lifetimeSignal as lifetimeSignalWithCtx,
  onSidebarWrite as onSidebarWriteWithCtx,
  recordedCondition as recordedConditionWithCtx,
  setSidebarWriteTestHooks as setSidebarWriteTestHooksWithCtx,
  untilStateOrTestEnd as untilStateOrTestEndWithCtx,
  withDeadlockGuard,
} from './support/opencode1-test-context.ts'
import {
  extractUrl,
  MESSAGES_URL,
  PROFILE_URL,
  QUOTA_URL,
  TOKEN_URL,
} from './test-fetch'

const testContext = createOpencode1TestContext()
installOpencode1TestHooks(testContext)
const test = createOpencode1Test(testContext)

function bodyLifetime(): TestLifetime {
  return getBodyLifetime(testContext)
}
function lifetimeSignal() {
  return lifetimeSignalWithCtx(testContext)
}
function recordedCondition() {
  return recordedConditionWithCtx(testContext)
}
function _untilStateOrTestEnd(pauseMs?: number) {
  return untilStateOrTestEndWithCtx(testContext, pauseMs)
}
function heldResponse() {
  return heldResponseWithCtx(testContext)
}
function _cleanupTempConfigDirs(drainTimeoutMs = 4_000) {
  return cleanupTempConfigDirsWithCtx(testContext, drainTimeoutMs)
}
function __setSidebarStateWriteTestHooks(
  hooks: Parameters<typeof setSidebarWriteTestHooksWithCtx>[1],
  stateFile: string = getSidebarStateFile(),
) {
  return setSidebarWriteTestHooksWithCtx(testContext, hooks, stateFile)
}
function _onSidebarWrite(stateFile: string, listener: () => void) {
  return onSidebarWriteWithCtx(testContext, stateFile, listener)
}
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
function _useVaultAccountFile(
  storage: AccountStorage,
  client: NativeCustodyClient,
) {
  return useVaultAccountFileWithCtx(testContext, storage, client)
}
function _useUnmigratedAccountFile(storage: AccountStorage) {
  return useUnmigratedAccountFileWithCtx(testContext, storage)
}
function _registerPoolLogins(
  storage: AccountStorage,
  main: { access: string; refresh: string },
) {
  return registerPoolLoginsWithCtx(testContext, storage, main)
}
function _nativeTokenAnswer(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  logins?: readonly PoolLogin[],
) {
  return nativeTokenAnswerWithCtx(testContext, input, init, logins)
}
function withNativeTokenExchange<Input, Init>(
  handler: (input: Input, init: Init) => Response | Promise<Response>,
) {
  return withNativeTokenExchangeWithCtx(testContext, handler)
}
function poolMainIdentity(): string {
  return poolMainIdentityWithCtx(testContext)
}
function mainAccountIssues(...accesses: string[]) {
  return mainAccountIssuesWithCtx(testContext, ...accesses)
}
function loginIssues(current: string, ...accesses: string[]) {
  return loginIssuesWithCtx(testContext, current, ...accesses)
}
function nativeAdmissionAnswer(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) {
  return nativeAdmissionAnswerWithCtx(testContext, input, init)
}
function nativeBootstrapAnswer(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  logins?: readonly PoolLogin[],
) {
  return nativeBootstrapAnswerWithCtx(testContext, input, init, logins)
}
function withNativeAdmission<Input, Init>(
  handler: (input: Input, init: Init) => unknown,
) {
  return withNativeAdmissionWithCtx(testContext, handler)
}
function withMainAdmission<Input, Init>(
  handler: (input: Input, init: Init) => Response | Promise<Response>,
) {
  return withMainAdmissionWithCtx(testContext, handler)
}
function withNativeBootstrap<Input, Init>(
  handler: (input: Input, init: Init) => unknown,
) {
  return withNativeBootstrapWithCtx(testContext, handler)
}
function replacePoolMainLogin(
  credential: { access: string; refresh: string; expires: number },
  options?: { sameAccount: boolean; accountIdentity?: string },
) {
  return replacePoolMainLoginWithCtx(
    testContext,
    credential,
    options as { sameAccount: boolean; accountIdentity?: string },
  )
}
function refreshPoolMainElsewhere(successor: {
  access: string
  refresh: string
  expires: number
}) {
  return refreshPoolMainElsewhereWithCtx(testContext, successor)
}
function waitForPoolCredential(routeId: string, access: string) {
  return waitForPoolCredentialWithCtx(testContext, routeId, access)
}
function refreshPoolLoginElsewhere(
  routeId: string,
  successor: { access: string; refresh: string; expires: number },
) {
  return refreshPoolLoginElsewhereWithCtx(testContext, routeId, successor)
}
function updatePoolSettings(
  mutator: (settings: Record<string, unknown>) => Record<string, unknown>,
) {
  return updatePoolSettingsWithCtx(testContext, mutator)
}
function addPoolOAuthAccount(
  routeId: string,
  credential: { access: string; refresh: string; expires: number },
  accountIdentity?: string,
) {
  return accountIdentity === undefined
    ? addPoolOAuthAccountWithCtx(testContext, routeId, credential)
    : addPoolOAuthAccountWithCtx(
        testContext,
        routeId,
        credential,
        accountIdentity,
      )
}
function _updatePoolRelay(
  patch: Parameters<
    ReturnType<
      typeof import('@cortexkit/anthropic-auth-core').createNativeAccountRuntime
    >['updateRelay']
  >[0],
) {
  return updatePoolRelayWithCtx(testContext, patch)
}
function publishPoolQuota(routeId: string, quota: OAuthQuotaSnapshot) {
  return publishPoolQuotaWithCtx(testContext, routeId, quota)
}
function publishPoolMetadata(
  routeId: string,
  patch: (
    identity: string,
  ) => Parameters<
    ReturnType<
      typeof import('@cortexkit/anthropic-auth-core').createNativeAccountRuntime
    >['publishLocal']
  >[1],
) {
  return publishPoolMetadataWithCtx(testContext, routeId, patch)
}
function expectHostActivationNonSecret(...tokens: string[]) {
  return expectHostActivationNonSecretWithCtx(testContext, ...tokens)
}
function poolMainAccess(): Promise<string> {
  return poolMainAccessWithCtx(testContext)
}
function _migratedHostAuth(
  pool: MigratedPool,
  testAuth: () => Promise<Record<string, unknown>>,
) {
  return migratedHostAuthWithCtx(testContext, pool, testAuth)
}
function expectNoCredentialFragment(value: unknown) {
  return expectNoCredentialFragmentWithCtx(testContext, value)
}
function readNativeSettings(): Promise<Record<string, unknown>> {
  return readNativeSettingsWithCtx(testContext)
}
function publishNativeMainQuota(quota: OAuthQuotaSnapshot) {
  return publishNativeMainQuotaWithCtx(testContext, quota)
}
function readNativeRuntimeState() {
  return readNativeRuntimeStateWithCtx(testContext)
}
function getPlugin(
  client?: ReturnType<typeof createMockClient>,
  directory?: string,
  runtimeOverrides: PluginRuntimeOverrides = {},
): any {
  return getPluginWithCtx(testContext, client, directory, runtimeOverrides)
}
function setupExpiredTokenLoader(...issuedAccess: string[]) {
  return setupExpiredTokenLoaderWithCtx(testContext, ...issuedAccess)
}
function waitForSidebarState(
  predicate: (state: Awaited<ReturnType<typeof getSidebarState>>) => boolean,
) {
  return waitForSidebarStateWithCtx(testContext, predicate)
}
function readAccountStorage(): Promise<AccountStorage | null> {
  return readAccountStorageWithCtx(testContext)
}
function waitForAccountStorage(
  predicate: (storage: AccountStorage | null) => boolean,
) {
  return waitForAccountStorageWithCtx(testContext, predicate)
}
function waitForNativePoolQuota(
  routeId: string,
  predicate: (quota: OAuthQuotaSnapshot | undefined) => boolean,
  options?: { keepAliveUntil?: Promise<unknown> },
) {
  return waitForNativePoolQuotaWithCtx(testContext, routeId, predicate, options)
}
function applyMenuAction(
  plugin: any,
  sessionId: string,
  request: Omit<CommandApplyRequest, 'command' | 'sessionId'>,
): Promise<CommandApplyResult> {
  return applyMenuActionWithCtx(testContext, plugin, sessionId, request)
}
function waitForFeedEntries(
  predicate: (entries: Awaited<ReturnType<typeof readFeedEntries>>) => boolean,
  description: string,
) {
  return waitForFeedEntriesWithCtx(testContext, predicate, description)
}
function waitForLogRecord(
  records: LogTestRecord[],
  predicate: (record: LogTestRecord) => boolean,
  description: string,
) {
  return waitForLogRecordWithCtx(testContext, records, predicate, description)
}
function loadMainAndFetch(
  storage: AccountStorage,
  response: Response | (() => Response),
  requestHeaders?: Record<string, string>,
) {
  return loadMainAndFetchWithCtx(testContext, storage, response, requestHeaders)
}
function expectNonOatMainRefused(access: string) {
  return expectNonOatMainRefusedWithCtx(testContext, access)
}
async function assertPrimeWithPublicDiagnostics(
  manager: PrimeManager,
  requestStages: readonly string[],
  assertion: () => void,
): Promise<void> {
  try {
    assertion()
  } catch (error) {
    // Record only request stages and public status. A diagnostic read failure
    // must not replace the original assertion or expose exception text.
    let status: ReturnType<PrimeManager['stats']> | 'unavailable'
    try {
      status = manager.stats(await readAccountStorage())
    } catch {
      status = 'unavailable'
    }
    console.error(
      JSON.stringify({ primeAssertionFailure: { requestStages, status } }),
    )
    throw error
  }
}

async function freshPrimeQuotaResponse(
  body: unknown,
  init: ResponseInit = { status: 200 },
): Promise<Response> {
  await Bun.sleep(2)
  return new Response(JSON.stringify(body), init)
}

async function runStickyDnsBackoffScenario(options: {
  tokenExpiresAt: number
  refreshErrorCheckedAt: number
  refreshErrorNextRetryAt: number
  refreshErrorRetryCount: number
}) {
  const now = Date.now()
  const cachedAt = now - 60 * 60_000
  const fableQuota = (remainingPercent: number, checkedAt: number) => ({
    checkedAt,
    five_hour: {
      usedPercent: 4,
      remainingPercent: 96,
      checkedAt,
      resetsAt: new Date(now + 60 * 60_000).toISOString(),
    },
    seven_day: {
      usedPercent: 18,
      remainingPercent: 82,
      checkedAt,
      resetsAt: new Date(now + 3 * 24 * 60 * 60_000).toISOString(),
    },
    scoped: [
      {
        id: 'claude-weekly-scoped-fable',
        title: 'Fable only',
        modelName: 'Fable',
        usedPercent: 100 - remainingPercent,
        remainingPercent,
        checkedAt,
        resetsAt: new Date(now + 3 * 24 * 60 * 60_000).toISOString(),
      },
    ],
  })
  // Quota and refresh failures are tied to Claude account UUIDs, the only
  // identities migration carries into the native pool.
  const fallbackAccount = '00000000-0000-4000-8000-0000000d0e5f'
  await useTempAccountFile(
    bindMainQuotaToAccount(
      createFallbackStorage({
        routing: { mode: 'sticky-balanced' },
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
          mainQuota: fableQuota(0, now),
          mainQuotaCheckedAt: now,
        },
        accounts: [
          {
            id: 'dns-backed-off',
            type: 'oauth',
            access: 'sk-ant-oat01-initial-fallback-access',
            refresh: 'fallback-refresh',
            expires: options.tokenExpiresAt,
            anthropicAccountUuid: fallbackAccount as ProviderAccountUuid,
            lastRefreshError: {
              message: 'getaddrinfo ENOTFOUND platform.claude.com',
              checkedAt: options.refreshErrorCheckedAt,
              nextRetryAt: options.refreshErrorNextRetryAt,
              retryCount: options.refreshErrorRetryCount,
              accountIdentity: fallbackAccount,
              permanent: false,
            },
            quota: {
              ...fableQuota(64, cachedAt),
              accountIdentity: fallbackAccount,
            },
          },
        ],
      }),
    ),
  )
  const pool = testContext.migratedPool
  if (!pool) throw new Error('DNS routing fixture did not migrate')
  const accountRuntime = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
  })
  try {
    const row = (await accountRuntime.read()).accounts.find(
      (account) => account.id === 'dns-backed-off',
    )
    expect(row?.binding?.identity).toBe(fallbackAccount)
    const stored = await createNativePoolStore({
      paths: pool.paths,
      quota: nativeQuotaCodec,
    }).read()
    const credential =
      stored.status === 'ready'
        ? stored.rows.find((entry) => entry.id === row?.binding?.rowId)
            ?.credential
        : undefined
    if (credential?.type !== 'oauth')
      throw new Error('DNS fixture has no bound OAuth credential')
    expect(credential.expires).toBe(options.tokenExpiresAt)
  } finally {
    accountRuntime.close()
  }
  const tokenRequests: string[] = []
  const messageAuthorizations: string[] = []
  globalThis.fetch = mock(
    withMainAdmission((input: any, init?: RequestInit) => {
      const url = extractUrl(input)
      const authorization =
        new Headers(init?.headers).get('authorization') ?? ''
      if (url.includes('/v1/oauth/token')) {
        tokenRequests.push(url)
        return Promise.resolve(
          Response.json({
            access_token: 'sk-ant-oat01-refreshed-fallback-access',
            refresh_token: 'refreshed-fallback-refresh',
            expires_in: 8 * 60 * 60,
          }),
        )
      }
      if (url.includes('/api/oauth/usage')) {
        return Promise.resolve(
          Response.json({
            five_hour: {
              utilization: 4,
              resets_at: new Date(now + 60 * 60_000).toISOString(),
            },
            seven_day: {
              utilization: 18,
              resets_at: new Date(now + 3 * 24 * 60 * 60_000).toISOString(),
            },
            limits: [
              {
                kind: 'weekly_scoped',
                group: 'weekly',
                percent: 36,
                resets_at: new Date(now + 3 * 24 * 60 * 60_000).toISOString(),
                scope: { model: { display_name: 'Fable' } },
              },
            ],
          }),
        )
      }
      if (url.includes('/claude_cli/bootstrap')) {
        return Promise.resolve(
          Response.json({ oauth_account: { account_uuid: fallbackAccount } }),
        )
      }
      if (url.includes('/v1/messages')) {
        messageAuthorizations.push(authorization)
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    }),
  ) as unknown as typeof fetch

  const plugin = await getPlugin()
  const result = await plugin.auth.loader(
    () =>
      Promise.resolve({
        type: 'oauth' as const,
        access: 'sk-ant-oat01-main-access',
        refresh: 'main-refresh',
        expires: now + 8 * 60 * 60_000,
      }),
    { models: {} },
  )
  const response = await result.fetch(MESSAGES_URL, {
    method: 'POST',
    headers: { 'x-session-affinity': 'dns-backed-off-fable' },
    body: JSON.stringify({
      model: 'claude-fable-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  return { response, tokenRequests, messageAuthorizations }
}

async function expectUnknownQuotaAdmissionBlocked(storage: AccountStorage) {
  const now = Date.now()
  storage.quota = {
    ...storage.quota,
    mainLastQuotaApiError: {
      message: 'quota source unavailable',
      checkedAt: now,
      nextRetryAt: now + 60_000,
      retryCount: 1,
    },
  }
  // Import the configured usage-API failure into shared account storage.
  // Migration retires the old state file; later writes use shared storage.
  await useTempAccountFile(storage)
  globalThis.fetch = mock(
    withNativeAdmission((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/api/oauth/usage'))
        return Promise.reject(new Error('quota source unavailable'))
      return Promise.resolve(new Response('{}', { status: 200 }))
    }),
  ) as unknown as typeof fetch
  const plugin = await getPlugin()
  const result = await plugin.auth.loader(
    () =>
      Promise.resolve({
        type: 'oauth' as const,
        access: 'sk-ant-oat01-main-access',
        refresh: 'main-refresh',
        expires: Date.now() + 100000,
      }),
    { models: {} },
  )
  const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
  expect(response.status).toBe(429)
}
describe('sidebar needsReauth (dead-fallback indicator)', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function fallbackWithRefreshError(status: number) {
    const refresh = 'fallback-refresh'
    const now = Date.now()
    // A genuinely-dead token returns 400 invalid_grant; only that classifies as
    // permanent (a bare 400 / other OAuth errors do not).
    const body = status === 400 ? '{"error":"invalid_grant"}' : 'boom'
    const error = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(status, body),
      now,
      accountIdentity: 'fallback-1',
    })
    return createFallbackStorage({
      accounts: [
        {
          id: 'fallback-1',
          type: 'oauth',
          access: 'sk-ant-oat01-fallback-access',
          refresh,
          expires: now + 5 * 60 * 60 * 1000,
          lastRefreshError: error,
        },
      ],
    })
  }

  test('dead (400 invalid_grant) fallback → needsReauth true', async () => {
    await useTempAccountFile(fallbackWithRefreshError(400))
    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const state = await waitForSidebarState(
      (candidate) => candidate.fallbacks[0]?.needsReauth === true,
    )
    expect(state.fallbacks[0]?.needsReauth).toBe(true)
  })

  test('transient (429 rate-limited) fallback → needsReauth false', async () => {
    await useTempAccountFile(fallbackWithRefreshError(429))
    const defaultFetch = globalThis.fetch
    let tokenCalls = 0
    globalThis.fetch = mock((input: any, init?: RequestInit) => {
      const url = extractUrl(input)
      if (url === TOKEN_URL) {
        tokenCalls += 1
        return Promise.reject(
          new Error('TOKEN_URL is outside this transient quota test'),
        )
      }
      if (url === QUOTA_URL) {
        return Promise.resolve(
          Response.json({
            five_hour: { utilization: 0 },
            seven_day: { utilization: 0 },
            limits: [],
          }),
        )
      }
      return defaultFetch(input, init)
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const state = await waitForSidebarState(
      (candidate) => candidate.fallbacks[0]?.needsReauth === false,
    )
    expect(state.fallbacks[0]?.needsReauth).toBe(false)
    expect(tokenCalls).toBe(0)
  })
})

describe('fallback quota persistence ordering', () => {
  test('does not restore a late quota error older than the persisted success', async () => {
    const successAt = Date.now()
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          accounts: [
            {
              id: 'fallback-late-error',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: successAt + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 10,
                  remainingPercent: 90,
                  checkedAt: successAt,
                },
                seven_day: {
                  usedPercent: 20,
                  remainingPercent: 80,
                  checkedAt: successAt,
                },
              },
            },
          ],
        }),
      ),
    )

    if (!testContext.migratedPool)
      throw new Error('Missing native quota fixture')
    const identity = testContext.poolLogins.find(
      (login) => login.access === 'sk-ant-oat01-fallback-access',
    )?.identity
    if (!identity) throw new Error('Missing fallback fixture identity')
    const runtime = createNativeAccountRuntime({
      paths: testContext.migratedPool.paths,
      host: 'opencode',
      local: {
        refreshToken: async () => ({
          access: 'sk-ant-oat01-fallback-access',
          refresh: 'fallback-refresh',
          expires: successAt + 5 * 60 * 60 * 1_000,
          expiresIn: 5 * 60 * 60,
        }),
        resolveIdentity: async () =>
          getClaudeCodeIdentityForVerifiedAccount(
            'fallback-late-error',
            identity as ProviderAccountUuid,
          ),
        now: () => successAt,
      },
    })
    const plugin = await getPlugin()
    try {
      const authorized = await runtime.authorizeLocal('fallback-late-error')
      expect(authorized.status).toBe('usable')
      if (authorized.status !== 'usable')
        throw new Error(
          `Fallback quota fixture is not authorized: ${authorized.status}`,
        )
      let quotaRequests = 0
      await runtime.fetchQuota(
        'fallback-late-error',
        Object.assign(
          async (input: Parameters<typeof fetch>[0]) => {
            expect(extractUrl(input)).toBe(
              'https://api.anthropic.com/api/oauth/usage',
            )
            quotaRequests++
            return Response.json({
              five_hour: { utilization: 10, resets_at: null },
              seven_day: { utilization: 20, resets_at: null },
            })
          },
          {
            preconnect() {
              throw new Error('Unexpected fixture preconnect')
            },
          },
        ),
      )
      expect(quotaRequests).toBe(1)
      expect(
        (await readAccountStorage())?.accounts.find(
          (account): account is OAuthAccount =>
            account.id === 'fallback-late-error' && isOAuthAccount(account),
        )?.quota?.five_hour?.usedPercent,
      ).toBe(10)
      await runtime.publishLocal(authorized.subject, {
        lastQuotaRefreshError: {
          message: 'older quota failure',
          checkedAt: successAt - 1,
          nextRetryAt: successAt + 60_000,
          retryCount: 1,
          accountIdentity: identity,
        },
      })
    } finally {
      runtime.close()
    }
    await plugin.dispose?.()

    const saved = await readAccountStorage()
    const savedAccount = saved?.accounts[0]
    expect(savedAccount).toBeDefined()
    if (!savedAccount || !isOAuthAccount(savedAccount)) {
      throw new Error('missing persisted fallback account')
    }
    expect(savedAccount.lastQuotaRefreshError).toBeUndefined()
  })
})

describe('quota header feed integration', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test.serial(
    'non-OAT compatibility identity stays a local quota key without a provider uuid',
    async () => {
      // OAuth records without Anthropic's access-token prefix are no longer served natively: the request is
      // refused with guidance and nothing reaches the model or the quota feed.
      await expectNonOatMainRefused('local-adapter-access')
    },
  )

  async function publishFallbackUuid({
    fallbackUuid,
    persistedUuid,
    bootstrapResponse,
  }: {
    fallbackUuid: string
    persistedUuid?: ProviderAccountUuid
    bootstrapResponse: unknown
  }) {
    const fallbackAccess = `sk-ant-oat-${randomUUID()}`
    await useTempAccountFile(
      createFallbackStorage({
        quota: {
          enabled: false,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: true,
        },
        quotaHeaderFeed: { enabled: true },
        accounts: [
          {
            id: 'fallback-1',
            type: 'oauth',
            access: fallbackAccess,
            refresh: 'fallback-refresh',
            expires: Date.now() + 5 * 60 * 60 * 1000,
            ...(persistedUuid && { anthropicAccountUuid: persistedUuid }),
            quota: {
              five_hour: {
                usedPercent: 25,
                remainingPercent: 75,
                checkedAt: Date.now(),
              },
              seven_day: {
                usedPercent: 30,
                remainingPercent: 70,
                checkedAt: Date.now(),
              },
            },
          },
        ],
      }),
    )
    if (persistedUuid) {
      // First confirm the token's account UUID through the bootstrap endpoint.
      // Its saved validation then permits serving when a later account lookup
      // returns no UUID; a stored UUID alone must never authorize the token.
      const answer = withNativeAdmission(() => Response.json({}))
      globalThis.fetch = Object.assign(
        mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const response = await answer(input, init)
          if (!(response instanceof Response))
            throw new Error('Admission fixture must return a Response')
          return response
        }),
        { preconnect: originalFetch.preconnect },
      )
      const runtime = createNativeAccountRuntime({
        paths: testContext.migratedPool!.paths,
        host: 'opencode',
      })
      try {
        expect((await runtime.authorizeLocal('fallback-1')).status).toBe(
          'usable',
        )
      } finally {
        runtime.close()
      }
    }
    // Answer token exchanges and the primary account's bootstrap normally.
    // Let this test control the fallback credential's bootstrap response.
    globalThis.fetch = mock(
      withNativeTokenExchange(
        withMainAdmission((input: any, init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/claude_cli/bootstrap')) {
            return Promise.resolve(Response.json(bootstrapResponse))
          }
          if (url.includes('/v1/messages')) {
            const authorization = new Headers(init?.headers).get(
              'authorization',
            )
            if (authorization === `Bearer ${fallbackAccess}`) {
              return Promise.resolve(
                new Response('{}', {
                  status: 200,
                  headers: {
                    'anthropic-ratelimit-unified-5h-utilization': '0.25',
                  },
                }),
              )
            }
            return Promise.resolve(new Response(null, { status: 429 }))
          }
          return Promise.resolve(Response.json({}))
        }),
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100_000,
        }),
      { models: {} },
    )
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    await response.text()

    const [published] = await waitForFeedEntries(
      (entries) =>
        entries.some(
          (entry: any) => entry.anthropic_account_uuid === fallbackUuid,
        ),
      'a fallback UUID feed entry',
    )
    const persisted = await waitForAccountStorage(
      (candidate) =>
        (
          candidate?.accounts.find(
            (account) => account.id === 'fallback-1',
          ) as any
        )?.anthropicAccountUuid === fallbackUuid,
    )
    return { published, persisted }
  }

  test('does not treat a complete but uncommitted .tmp lease as a published feed entry', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const directory = process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR!
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'pretend.json.uncommitted.tmp'),
      JSON.stringify({
        version: 3,
        entries: { a: { account_ref: 'not-yet-published' } },
      }),
      { mode: 0o600 },
    )
    expect(await readFeedEntries()).toEqual([])
  })

  test('non-oat main feed leaves provider UUID null while retaining its quota slot', async () => {
    // OAuth records without Anthropic's access-token prefix are no longer served natively: the request is
    // refused with guidance and nothing reaches the model or the quota feed.
    await expectNonOatMainRefused('main-access')
  })

  test('oat main feed preserves its bootstrapped Anthropic account UUID', async () => {
    const mainAccountId = 'main-oat-slot'
    const providerAccountUuid = '33333333-3333-3333-3333-333333333333'
    await useTempAccountFile(
      createFallbackStorage({
        mainAccountId,
        quotaHeaderFeed: { enabled: true },
        accounts: [],
      }),
      {
        access: 'sk-ant-oat-main-feed',
        refresh: 'main-refresh',
        expires: Date.now() + 100_000,
      },
    )
    globalThis.fetch = mock(
      withNativeTokenExchange((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/claude_cli/bootstrap')) {
          return Promise.resolve(
            Response.json({
              oauth_account: { account_uuid: providerAccountUuid },
            }),
          )
        }
        return Promise.resolve(
          new Response('{}', {
            status: 200,
            headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.25' },
          }),
        )
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat-main-feed',
          refresh: 'main-refresh',
          expires: Date.now() + 100_000,
        }),
      { models: {} },
    )
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    await response.text()

    const [published] = await waitForFeedEntries(
      (entries) =>
        entries.some(
          (entry: any) => entry.anthropic_account_uuid === providerAccountUuid,
        ),
      'a bootstrapped main UUID feed entry',
    )
    // The native feed keys the main account by its stable Claude account
    // UUID; the configured slot id stays a local name only.
    expect(published).toEqual(
      expect.objectContaining({
        account_ref: providerAccountUuid,
        anthropic_account_uuid: providerAccountUuid,
      }),
    )
    expect((published as { account_ref?: unknown }).account_ref).not.toBe(
      mainAccountId,
    )
  })

  test('main feed drops a cached oat UUID after the current credential becomes non-oat', async () => {
    // OAuth records without Anthropic's access-token prefix are no longer served natively: the request is
    // refused with guidance and nothing reaches the model or the quota feed.
    await expectNonOatMainRefused('main-feed-non-oat-after-rotation')
  })

  test('fresh non-oat main install persists a quota slot and publishes no provider UUID', async () => {
    // OAuth records without Anthropic's access-token prefix are no longer served natively: the request is
    // refused with guidance and nothing reaches the model or the quota feed.
    await expectNonOatMainRefused('fresh-main-non-oat')
  })

  test('publishes and persists a fallback Anthropic account UUID', async () => {
    const fallbackUuid = '11111111-1111-1111-1111-111111111111'
    const { published, persisted } = await publishFallbackUuid({
      fallbackUuid,
      bootstrapResponse: { oauth_account: { account_uuid: fallbackUuid } },
    })
    expect(published).toEqual(
      expect.objectContaining({
        identity_source: 'account_ref',
        account_ref: 'fallback-1',
        anthropic_account_uuid: fallbackUuid,
      }),
    )
    expect(
      (
        persisted?.accounts.find(
          (account) => account.id === 'fallback-1',
        ) as any
      )?.anthropicAccountUuid,
    ).toBe(fallbackUuid)
  })

  test('uses a persisted fallback Anthropic account UUID before bootstrap resolves it', async () => {
    const fallbackUuid = '22222222-2222-2222-2222-222222222222'
    const { published, persisted } = await publishFallbackUuid({
      fallbackUuid,
      persistedUuid: fallbackUuid as ProviderAccountUuid,
      bootstrapResponse: {},
    })
    expect(published).toEqual(
      expect.objectContaining({
        account_ref: 'fallback-1',
        anthropic_account_uuid: fallbackUuid,
      }),
    )
    expect(
      (
        persisted?.accounts.find(
          (account) => account.id === 'fallback-1',
        ) as any
      )?.anthropicAccountUuid,
    ).toBe(fallbackUuid)
  })

  test('cache-seeded poll fields survive a later header harvest into the feed', async () => {
    const originalNow = Date.now
    let clock = 1_000_000
    Date.now = () => clock
    try {
      const mainAccountId = syntheticMainAccountUuid
      const accessToken = 'sk-ant-oat01-cache-seeded'
      const pollCheckedAt = 900_000
      const initialPollQuota: OAuthQuotaSnapshot = {
        source: 'poll',
        accountIdentity: mainAccountId,
        checkedAt: pollCheckedAt,
        five_hour: {
          usedPercent: 4,
          remainingPercent: 96,
          checkedAt: pollCheckedAt,
        },
        seven_day: {
          usedPercent: 52,
          remainingPercent: 48,
          checkedAt: pollCheckedAt,
        },
        bindingWindow: 'claude-weekly-scoped-fable',
        bindingWindowSource: 'poll',
      }
      const scoped = [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 55,
          remainingPercent: 45,
          checkedAt: pollCheckedAt,
        },
      ]
      const extraUsage: NonNullable<OAuthQuotaSnapshot['extraUsage']> = {
        used: { amountMinor: 1261, currency: 'USD', exponent: 2 },
        limit: { amountMinor: 10000, currency: 'USD', exponent: 2 },
        utilizationPercent: 12.61,
        severity: 'normal',
        exhausted: false,
      }
      const storage = bindMainQuotaToAccount(
        createFallbackStorage({
          mainAccountId,
          quotaHeaderFeed: { enabled: true },
          accounts: [],
          quota: {
            ...createFallbackStorage().quota,
            mainQuota: initialPollQuota,
            mainQuotaCheckedAt: pollCheckedAt,
            mainQuotaToken: tokenFingerprint(accessToken),
          },
        }),
        accessToken,
        mainAccountId,
      )
      await useTempAccountFile(storage, {
        access: accessToken,
        refresh: 'main-refresh',
        expires: Date.now() + 8 * 60 * 60_000,
      })
      process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
      let startPollWriter: () => Promise<void> = async () => {
        throw new Error('Poll writer is not ready')
      }
      let modelRequests = 0
      globalThis.fetch = mock(
        withNativeAdmission(async (input: Parameters<typeof fetch>[0]) => {
          if (extractUrl(input).includes('/v1/messages')) {
            if (modelRequests++ === 0) await startPollWriter()
            return new Response('{}', {
              status: 200,
              headers: {
                'anthropic-ratelimit-unified-5h-utilization': '0.04',
                'anthropic-ratelimit-unified-7d-utilization': '0.52',
              },
            })
          }
          throw new Error(`Unexpected test endpoint: ${extractUrl(input)}`)
        }),
      ) as unknown as typeof fetch
      const pollSubject = await publishNativeMainQuota(initialPollQuota)
      if (!testContext.migratedPool) throw new Error('Missing migrated fixture')
      const entered = bodyLifetime().gate()
      const release = bodyLifetime().gate()
      // Pause a real poll flush while a header is accepted. A later harvest
      // must retain the poll's fields once that flush has reached disk.
      const writer = createNativeAccountRuntime({
        paths: testContext.migratedPool.paths,
        host: 'opencode',
        beforePoolWrite: async () => {
          entered.open()
          await release.wait
        },
      })
      let pollWriter: ReturnType<typeof writer.publishLocal> | undefined
      startPollWriter = async () => {
        pollWriter = writer.publishLocal(pollSubject, {
          quota: { ...initialPollQuota, scoped, extraUsage },
        })
        bodyLifetime().trackDetached(pollWriter)
        expect(await pollWriter).toBe(true)
        await entered.wait
      }
      let firstRequest: Promise<Response> | undefined
      const records: LogTestRecord[] = []
      __setLogTestSink((record) => records.push(record))
      try {
        const plugin = await getPlugin()
        const result = await plugin.auth.loader(
          () =>
            Promise.resolve({
              type: 'oauth',
              access: accessToken,
              refresh: 'main-refresh',
              expires: Date.now() + 100000,
            }),
          { models: {} },
        )
        setLogLevel('trace')
        // Release the poll after header receipt. Acceptance need not wait for
        // either store's queued quota to reach disk.
        const pollFieldsWritten = waitForNativePoolQuota(
          'main',
          (quota) =>
            Bun.deepEquals(quota?.scoped, scoped) &&
            Bun.deepEquals(quota?.extraUsage, extraUsage),
        )
        bodyLifetime().trackDetached(pollFieldsWritten)
        firstRequest = Promise.resolve(result.fetch(MESSAGES_URL, EMPTY_POST))
        bodyLifetime().trackDetached(firstRequest)
        await entered.wait
        const cache = getPluginTestHandles(plugin).quotaManager
        await waitForLogRecord(
          records,
          (record) =>
            record.channel === 'quota' &&
            record.message === 'response quota awaiting publication' &&
            record.payload?.account === 'main',
          'header receipt while the poll flush is held',
        )
        expect(cache.getMain(mainAccountId)?.quota.bindingWindow).toBe(
          'claude-weekly-scoped-fable',
        )
        release.open()
        if (!pollWriter)
          throw new Error(
            'First model request did not start the native poll writer',
          )
        expect(await pollWriter).toBe(true)
        await pollFieldsWritten
        await writer.close()
        expect((await readAccountStorage())?.quota?.mainQuota?.scoped).toEqual(
          scoped,
        )
        const firstResponse = await firstRequest
        expect(firstResponse.status).toBe(200)
        await firstResponse.text()
        await waitForNativePoolQuota(
          'main',
          (quota) => quota?.checkedAt === clock,
        )
        expect((await readAccountStorage())?.quota?.mainQuota?.scoped).toEqual(
          scoped,
        )
        clock += 1_000
        const secondResponse = await result.fetch(MESSAGES_URL, EMPTY_POST)
        expect(secondResponse.status).toBe(200)
        await secondResponse.text()
        const secondEntry = (
          await waitForFeedEntries(
            (entries) =>
              entries.length === 1 &&
              entries[0] !== null &&
              typeof entries[0] === 'object' &&
              'observed_at_ms' in entries[0] &&
              entries[0].observed_at_ms === clock,
            'second header observation',
          )
        )[0]
        if (
          secondEntry === null ||
          typeof secondEntry !== 'object' ||
          !('quota' in secondEntry)
        )
          throw new Error('Published feed entry has no quota')
        const quota = secondEntry.quota
        if (quota === null || typeof quota !== 'object')
          throw new Error('Published quota is not an object')
        expect('scoped' in quota ? quota.scoped : undefined).toEqual(scoped)
        expect('extraUsage' in quota ? quota.extraUsage : undefined).toEqual(
          extraUsage,
        )
        expect('bindingWindow' in quota ? quota.bindingWindow : undefined).toBe(
          'claude-weekly-scoped-fable',
        )
      } finally {
        release.open()
        await Promise.allSettled([pollWriter, firstRequest])
        await writer.close()
        __setLogTestSink(null)
        setLogLevel('info')
      }
    } finally {
      Date.now = originalNow
      delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    }
  })

  test('same-account token rotation preserves poll-owned quota during header harvest', async () => {
    const originalNow = Date.now
    const clock = 1_000_000
    Date.now = () => clock
    try {
      const mainAccountId = syntheticMainAccountUuid
      const pollAccessToken = 'sk-ant-oat01-poll-token'
      const rotatedAccessToken = 'sk-ant-oat01-rotated-token'
      const pollCheckedAt = 900_000
      const scoped = [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 55,
          remainingPercent: 45,
          checkedAt: pollCheckedAt,
        },
      ]
      const extraUsage = {
        used: { amountMinor: 1261, currency: 'USD', exponent: 2 },
        limit: { amountMinor: 10000, currency: 'USD', exponent: 2 },
        utilizationPercent: 12.61,
        severity: 'normal',
        exhausted: false,
      }
      const initialPollQuota: OAuthQuotaSnapshot = {
        source: 'poll',
        accountIdentity: mainAccountId,
        checkedAt: pollCheckedAt,
        five_hour: {
          usedPercent: 4,
          remainingPercent: 96,
          checkedAt: pollCheckedAt,
        },
        seven_day: {
          usedPercent: 52,
          remainingPercent: 48,
          checkedAt: pollCheckedAt,
        },
        scoped,
        extraUsage,
        bindingWindow: 'claude-weekly-scoped-fable',
        bindingWindowSource: 'poll',
      }
      const storage = createFallbackStorage({
        mainAccountId,
        accounts: [],
        quota: {
          ...createFallbackStorage().quota,
          mainQuota: initialPollQuota,
          mainQuotaCheckedAt: pollCheckedAt,
          mainQuotaToken: tokenFingerprint(pollAccessToken),
        },
      })
      await useTempAccountFile(
        bindMainQuotaToAccount(storage, pollAccessToken, mainAccountId),
        {
          access: pollAccessToken,
          refresh: 'poll-refresh-token',
          expires: clock + 8 * 60 * 60_000,
        },
      )
      process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
      const served: Array<string | null> = []
      globalThis.fetch = mock(
        withNativeAdmission(
          (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            if (!extractUrl(input).includes('/v1/messages'))
              throw new Error(`Unexpected test endpoint: ${extractUrl(input)}`)
            served.push(new Headers(init?.headers).get('authorization'))
            return new Response('{}', {
              status: 200,
              headers: {
                'anthropic-ratelimit-unified-5h-utilization': '0.11',
                'anthropic-ratelimit-unified-7d-utilization': '0.22',
              },
            })
          },
        ),
      ) as unknown as typeof fetch
      mainAccountIssues(rotatedAccessToken)
      await refreshPoolLoginElsewhere('main', {
        access: rotatedAccessToken,
        refresh: 'rotated-refresh-token',
        expires: clock + 5 * 60 * 60_000,
      })

      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: pollAccessToken,
            refresh: 'poll-refresh-token',
            expires: clock + 8 * 60 * 60_000,
          }),
        { models: {} },
      )
      const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
      await response.text()

      const persisted = await waitForAccountStorage(
        (candidate) => candidate?.quota?.mainQuota?.checkedAt === clock,
      )
      expect(persisted?.quota?.mainQuota?.five_hour?.usedPercent).toBe(11)
      expect(persisted?.quota?.mainQuota?.seven_day?.usedPercent).toBe(22)
      expect(persisted?.quota?.mainQuota?.scoped).toEqual(scoped)
      expect(persisted?.quota?.mainQuota?.extraUsage).toEqual(extraUsage)
      expect(persisted?.quota?.mainQuota?.bindingWindow).toBe(
        'claude-weekly-scoped-fable',
      )
      expect(persisted?.quota?.mainQuotaToken).toBe(mainAccountId)
      expect(served).toEqual([`Bearer ${rotatedAccessToken}`])
    } finally {
      Date.now = originalNow
      delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    }
  })

  test('stale fallback headers do not persist or publish after re-login', async () => {
    const fallbackAccess = 'sk-ant-oat01-fallback-lineage-a-access'
    const fallbackCheckedAt = Date.now()
    const responseGate = bodyLifetime().gate()
    const startedGate = bodyLifetime().gate()
    let fallbackValue = new Response('{}', { status: 503 })
    const fallbackResponse = responseGate.wait.then(() => fallbackValue)
    const releaseFallbackResponse = (response: Response) => {
      fallbackValue = response
      responseGate.open()
    }
    const fallbackStarted = () => startedGate.open()
    const fallbackRequestStarted = startedGate.wait
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          quotaHeaderFeed: { enabled: true },
          quota: {
            ...createFallbackStorage().quota,
            checkIntervalMinutes: 60,
          },
          accounts: [
            {
              id: 'fallback-1',
              type: 'oauth',
              access: fallbackAccess,
              refresh: 'fallback-lineage-a-refresh',
              expires: Date.now() + 5 * 60 * 60 * 1000,
              authLineageId: 'lineage-a',
              quota: {
                five_hour: {
                  usedPercent: 25,
                  remainingPercent: 75,
                  checkedAt: fallbackCheckedAt,
                },
                seven_day: {
                  usedPercent: 30,
                  remainingPercent: 70,
                  checkedAt: fallbackCheckedAt,
                },
              },
            },
          ],
        }),
      ),
    )
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        if (url.includes('/v1/messages')) {
          const token = new Headers(init?.headers).get('authorization')
          if (token === `Bearer ${fallbackAccess}`) {
            fallbackStarted?.()
            return fallbackResponse
          }
          return Promise.resolve(new Response(null, { status: 429 }))
        }
        return Promise.resolve(Response.json({}))
      }),
    ) as unknown as typeof fetch

    const records: LogTestRecord[] = []
    let responsePromise: Promise<Response> | undefined
    let fallbackAtPersistenceReject: unknown
    const sidebarStates: unknown[] = []
    try {
      const plugin = await getPlugin()
      setLogLevel('trace')
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: 'sk-ant-oat01-main-access',
            refresh: 'main-refresh',
            expires: Date.now() + 100_000,
          }),
        { models: {} },
      )
      const quotaManager = getPluginTestHandles(plugin).quotaManager
      __setLogTestSink((record) => {
        records.push(record)
        if (
          record.channel === 'quota' &&
          record.message === 'native quota publication refused'
        ) {
          queueMicrotask(() => {
            fallbackAtPersistenceReject = quotaManager
              .getAllFallbacks()
              .get('fallback-1')
          })
        }
      })
      responsePromise = Promise.resolve(
        result.fetch(MESSAGES_URL, {
          method: 'POST',
          body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
        }),
      )
      bodyLifetime().trackDetached(responsePromise)
      await Promise.race([
        fallbackRequestStarted,
        responsePromise.then(() => {
          throw new Error(
            'Request completed without reaching the expected fallback',
          )
        }),
      ])
      expect(
        quotaManager.getAllFallbacks().get('fallback-1')?.quota.five_hour
          ?.usedPercent,
      ).toBe(25)
      await drainSidebarWrites()
      __setSidebarStateWriteTestHooks({
        beforeRename: async (_stateFile, tempFile) => {
          sidebarStates.push(JSON.parse(await readFile(tempFile, 'utf8')))
        },
      })

      if (!testContext.migratedPool) throw new Error('Missing migrated pool')
      const replacementRuntime = createNativeAccountRuntime({
        paths: testContext.migratedPool.paths,
        host: 'opencode',
      })
      const newAccess = 'sk-ant-oat01-fallback-lineage-b-access'
      loginIssues(fallbackAccess, newAccess)
      try {
        await replacementRuntime.loginOAuth({
          routeId: 'fallback-1',
          accountIdentity: syntheticFallbackAccountUuid(0),
          replace: true,
          credential: {
            access: newAccess,
            refresh: 'fallback-lineage-b-refresh',
            expires: Date.now() + 8 * 60 * 60_000,
          },
        })
        const subject =
          await replacementRuntime.captureLocalSubject('fallback-1')
        if (!isNativeLocalCredentialValidation(subject))
          throw new Error(
            'Replacement subject has no exact account and credential version',
          )
        expect(
          await replacementRuntime.publishLocal(subject, {
            quota: {
              accountIdentity: subject.binding.identity,
              checkedAt: fallbackCheckedAt,
              five_hour: {
                usedPercent: 60,
                remainingPercent: 40,
                checkedAt: fallbackCheckedAt,
              },
              seven_day: {
                usedPercent: 70,
                remainingPercent: 30,
                checkedAt: fallbackCheckedAt,
              },
            },
          }),
        ).toBe(true)
      } finally {
        await replacementRuntime.close()
      }
      const replacedAccount = (await readAccountStorage())?.accounts.find(
        (account) => account.id === 'fallback-1',
      )
      if (!replacedAccount || !isOAuthAccount(replacedAccount))
        throw new Error('Replacement OAuth account is missing')
      expect(replacedAccount.quota?.five_hour?.usedPercent).toBe(60)
      setLogLevel('trace')

      releaseFallbackResponse?.(
        new Response('{}', {
          status: 200,
          headers: {
            'anthropic-ratelimit-unified-5h-utilization': '0.04',
            'anthropic-ratelimit-unified-7d-utilization': '0.12',
          },
        }),
      )
      const response = await responsePromise
      expect(response.status).toBe(200)
      await response.text()

      await waitForLogRecord(
        records,
        (record) =>
          record.level === 'debug' &&
          record.channel === 'quota' &&
          record.message === 'native quota publication refused' &&
          record.payload?.accountId === 'fallback-1',
        'stale fallback quota persistence discard',
      )
      await drainSidebarWrites()
      const settled = await readAccountStorage()
      const settledAccount = settled?.accounts.find(
        (candidate) => candidate.id === 'fallback-1',
      )
      expect(
        settledAccount && isOAuthAccount(settledAccount)
          ? settledAccount.quota?.five_hour?.checkedAt
          : undefined,
      ).toBe(fallbackCheckedAt)
      expect(fallbackAtPersistenceReject).toBeUndefined()
      if (!settledAccount || !isOAuthAccount(settledAccount))
        throw new Error('Settled OAuth account is missing')
      // Route completion may display the replacement's verified quota. The
      // refused old response must not supply its quota to that display.
      expect(sidebarStates).not.toContainEqual(
        expect.objectContaining({
          fallbacks: expect.arrayContaining([
            expect.objectContaining({
              id: 'fallback-1',
              quota: expect.objectContaining({
                five_hour: expect.objectContaining({ usedPercent: 4 }),
              }),
            }),
          ]),
        }),
      )
      expect(settledAccount?.quota?.five_hour?.usedPercent).toBe(60)
      expect(settledAccount?.quota?.seven_day?.usedPercent).toBe(70)
      expect(await readFeedEntries()).toEqual([])
    } finally {
      responseGate.open()
      await Promise.allSettled([responsePromise, fallbackResponse])
      await drainSidebarWrites()
      __setLogTestSink(null)
      __setSidebarStateWriteTestHooks(null)
      setLogLevel('info')
    }
  })

  test('main-route sidebar writes use current fallback storage after re-login', async () => {
    const fallbackCheckedAt = Date.now()
    const fallbackAccess = 'sk-ant-oat01-sidebar-fallback-a'
    const responseGate = bodyLifetime().gate()
    const startedGate = bodyLifetime().gate()
    let mainValue = new Response('{}', { status: 503 })
    const mainResponse = responseGate.wait.then(() => mainValue)
    const releaseMainResponse = (response: Response) => {
      mainValue = response
      responseGate.open()
    }
    const mainStarted = () => startedGate.open()
    const mainRequestStarted = startedGate.wait
    let responsePromise: Promise<Response> | undefined
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          quota: {
            ...createFallbackStorage().quota,
            mainQuota: {
              source: 'poll',
              checkedAt: fallbackCheckedAt,
              five_hour: {
                usedPercent: 4,
                remainingPercent: 96,
                checkedAt: fallbackCheckedAt,
              },
              seven_day: {
                usedPercent: 12,
                remainingPercent: 88,
                checkedAt: fallbackCheckedAt,
              },
            },
            mainQuotaCheckedAt: fallbackCheckedAt,
          },
          accounts: [
            {
              id: 'fallback-1',
              type: 'oauth',
              access: fallbackAccess,
              refresh: 'fallback-lineage-a-refresh',
              expires: Date.now() + 5 * 60 * 60 * 1000,
              authLineageId: 'lineage-a',
              quota: {
                five_hour: {
                  usedPercent: 25,
                  remainingPercent: 75,
                  checkedAt: fallbackCheckedAt,
                },
                seven_day: {
                  usedPercent: 30,
                  remainingPercent: 70,
                  checkedAt: fallbackCheckedAt,
                },
              },
            },
          ],
        }),
      ),
    )
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/v1/messages')) {
            const token = new Headers(init?.headers).get('authorization')
            if (token === 'Bearer sk-ant-oat01-main-access') {
              mainStarted?.()
              return mainResponse
            }
            return Promise.resolve(new Response(null, { status: 429 }))
          }
          return Promise.resolve(Response.json({}))
        },
      ),
    ) as unknown as typeof fetch

    try {
      const plugin = await getPlugin()
      await drainSidebarWrites()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: 'sk-ant-oat01-main-access',
            refresh: 'main-refresh',
            expires: Date.now() + 100_000,
          }),
        { models: {} },
      )
      const quotaManager = getPluginTestHandles(plugin).quotaManager
      responsePromise = Promise.resolve(
        result.fetch(MESSAGES_URL, {
          method: 'POST',
          body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
        }),
      )
      bodyLifetime().trackDetached(responsePromise)
      await Promise.race([
        mainRequestStarted,
        responsePromise.then(() => {
          throw new Error('Request completed without reaching main')
        }),
      ])
      expect(
        quotaManager.getAllFallbacks().get('fallback-1')?.quota.five_hour
          ?.usedPercent,
      ).toBe(25)
      if (!testContext.migratedPool) throw new Error('Missing migrated pool')
      const replacementRuntime = createNativeAccountRuntime({
        paths: testContext.migratedPool.paths,
        host: 'opencode',
      })
      try {
        const replacementAccess = 'sk-ant-oat01-sidebar-fallback-b'
        loginIssues(fallbackAccess, replacementAccess)
        await replacementRuntime.loginOAuth({
          routeId: 'fallback-1',
          replace: true,
          accountIdentity: syntheticFallbackAccountUuid(0),
          credential: {
            access: replacementAccess,
            refresh: 'fallback-lineage-b-refresh',
            expires: Date.now() + 8 * 60 * 60_000,
          },
        })
      } finally {
        replacementRuntime.close()
      }
      releaseMainResponse?.(new Response('{}', { status: 200 }))

      const response = await responsePromise
      expect(response.status).toBe(200)
      await response.text()

      expect(
        quotaManager.getAllFallbacks().get('fallback-1')?.quota.five_hour
          ?.usedPercent,
      ).toBeUndefined()
      await drainSidebarWrites()
    } finally {
      responseGate.open()
      await Promise.allSettled([responsePromise, mainResponse])
      await drainSidebarWrites()
      setLogLevel('info')
    }
  })

  test('does not hold a model response on the display-only sidebar write', async () => {
    await useTempAccountFile(
      createFallbackStorage({ quota: { enabled: false }, accounts: [] }),
    )
    let responseStarted!: () => void
    const responseStartedPromise = new Promise<void>((resolve) => {
      responseStarted = resolve
    })
    let sidebarWriteStarted!: () => void
    const sidebarWriteStartedPromise = new Promise<void>((resolve) => {
      sidebarWriteStarted = resolve
    })
    let releaseSidebarWrite!: () => void
    const sidebarWriteRelease = new Promise<void>((resolve) => {
      releaseSidebarWrite = resolve
    })
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        if (extractUrl(input).includes('/v1/messages')) {
          responseStarted()
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        return Promise.resolve(Response.json({}))
      }),
    ) as unknown as typeof fetch

    try {
      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: 'sk-ant-oat01-main-access',
            refresh: 'main-refresh',
            expires: Date.now() + 100_000,
          }),
        { models: {} },
      )
      await drainSidebarWrites()
      __setSidebarStateWriteTestHooks({
        beforeRename: async () => {
          sidebarWriteStarted()
          await sidebarWriteRelease
        },
      })

      const responsePromise = result.fetch(MESSAGES_URL, EMPTY_POST)
      await responseStartedPromise
      await sidebarWriteStartedPromise
      const settledBeforeRelease = await Promise.race([
        responsePromise.then(() => true),
        Bun.sleep(50).then(() => false),
      ])
      expect(settledBeforeRelease).toBe(true)

      releaseSidebarWrite()
      expect((await responsePromise).status).toBe(200)
    } finally {
      releaseSidebarWrite?.()
      await drainSidebarWrites()
      __setSidebarStateWriteTestHooks(null)
    }
  })

  test('cross-account reload cannot retime a published main observation', async () => {
    const originalNow = Date.now
    const requestCheckedAt = 1_000_000
    Date.now = () => requestCheckedAt
    try {
      const accountIdentity = syntheticMainAccountUuid
      const accessToken = 'sk-ant-oat01-cross-account-timestamp'
      const otherCheckedAt = 2_000_000
      const storage = bindMainQuotaToAccount(
        createFallbackStorage({
          mainAccountId: 'main-slot',
          quotaHeaderFeed: { enabled: true },
          accounts: [],
          quota: {
            ...createFallbackStorage().quota,
            mainQuota: {
              source: 'headers',
              checkedAt: requestCheckedAt,
              five_hour: {
                usedPercent: 4,
                remainingPercent: 96,
                checkedAt: requestCheckedAt,
              },
              seven_day: {
                usedPercent: 52,
                remainingPercent: 48,
                checkedAt: requestCheckedAt,
              },
            },
            mainQuotaCheckedAt: otherCheckedAt,
          },
        }),
        accessToken,
        accountIdentity,
      )
      await useTempAccountFile(storage, {
        access: accessToken,
        refresh: 'main-refresh',
        expires: requestCheckedAt + 8 * 60 * 60_000,
      })
      // Migration orders quota by the account-bound snapshot, not the unrelated
      // standalone clock. The runtime projection must retain that ordering.
      const mixedState = await readAccountStorage()
      expect(mixedState?.quota?.mainQuota?.accountIdentity).toBe(
        accountIdentity,
      )
      expect(mixedState?.quota?.mainQuotaCheckedAt).toBe(requestCheckedAt)
      globalThis.fetch = Object.assign(
        mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const admitted = await nativeAdmissionAnswer(input, init)
          if (admitted) return admitted
          if (extractUrl(input).includes('/v1/messages'))
            return new Response('{}', {
              status: 200,
              headers: {
                'anthropic-ratelimit-unified-5h-utilization': '0.04',
                'anthropic-ratelimit-unified-7d-utilization': '0.52',
              },
            })
          return Response.json({})
        }),
        {
          preconnect() {
            throw new Error('Unexpected preconnect in test fixture')
          },
        },
      )
      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: accessToken,
            refresh: 'main-refresh',
            expires: requestCheckedAt + 8 * 60 * 60_000,
          }),
        { models: {} },
      )
      const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
      expect(response.status).toBe(200)
      await response.text()
      const entries = await waitForFeedEntries(
        (entries) => entries.length === 1,
        'one account-bound header observation',
      )
      expect(entries[0]).toMatchObject({
        account_ref: accountIdentity,
        anthropic_account_uuid: accountIdentity,
        observed_at_ms: requestCheckedAt,
      })
      expect(entries[0]).not.toMatchObject({ observed_at_ms: otherCheckedAt })
    } finally {
      Date.now = originalNow
    }
  })

  test('withholds the main feed entry when bootstrap cannot identify the account', async () => {
    let modelCalls = 0
    let bootstrapCalls = 0
    await useTempAccountFile(
      createFallbackStorage({
        mainAccountId: 'unknown-main',
        quotaHeaderFeed: { enabled: true },
        accounts: [],
      }),
      {
        access: 'sk-ant-oat01-unknown-feed',
        refresh: 'unknown-refresh',
        expires: Date.now() + 8 * 60 * 60_000,
      },
    )
    globalThis.fetch = Object.assign(
      mock((input: Parameters<typeof fetch>[0]) => {
        const url = extractUrl(input)
        if (url.includes('/v1/oauth/token'))
          return Promise.resolve(
            Response.json({
              access_token: 'sk-ant-oat01-unknown-feed-successor',
              refresh_token: 'unknown-refresh-successor',
              expires_in: 28800,
            }),
          )
        if (url.includes('/claude_cli/bootstrap')) bootstrapCalls++
        if (url.includes('/v1/messages')) {
          modelCalls++
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        return Promise.resolve(Response.json({}))
      }),
      {
        preconnect() {
          throw new Error('Unexpected preconnect in test fixture')
        },
      },
    )

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-unknown-feed',
          refresh: 'unknown-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await expect(result.fetch(MESSAGES_URL, EMPTY_POST)).rejects.toThrow(
      'Claude OAuth refresh is backed off',
    )
    expect(bootstrapCalls).toBeGreaterThan(0)
    expect(modelCalls).toBe(0)
    expect(await readFeedEntries()).toEqual([])
  })

  test('main account replacement fences quota, backoff, and feed identity', async () => {
    const uuidA = syntheticMainAccountUuid
    const uuidB = syntheticFallbackAccountUuid(99)
    const accessA = 'sk-ant-oat01-token-a'
    const accessB = 'sk-ant-oat01-token-b'
    const checkedAt = Date.now()
    const oldPollEntered = bodyLifetime().gate()
    const releaseOldPoll = bodyLifetime().gate()
    let priorPoll: Promise<unknown> | undefined
    let modelRequest: Promise<Response> | undefined
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          mainAccountId: 'main-slot',
          accounts: [],
          quotaHeaderFeed: { enabled: true },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            failClosedOnUnknownQuota: false,
            mainQuota: {
              source: 'poll',
              checkedAt,
              five_hour: { usedPercent: 100, remainingPercent: 0, checkedAt },
            },
            mainQuotaCheckedAt: checkedAt,
          },
        }),
        accessA,
        uuidA,
      ),
      {
        access: accessA,
        refresh: 'refresh-a',
        expires: checkedAt + 8 * 60 * 60_000,
      },
    )
    globalThis.fetch = Object.assign(
      mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = extractUrl(input)
        const token = new Headers(init?.headers).get('authorization')
        if (url.includes('/claude_cli/bootstrap'))
          return Response.json({
            oauth_account: {
              account_uuid: token === `Bearer ${accessA}` ? uuidA : uuidB,
            },
          })
        if (url.includes('/api/oauth/usage')) {
          if (token === `Bearer ${accessA}`) {
            oldPollEntered.open()
            await releaseOldPoll.wait
            return new Response('rate limited', { status: 429 })
          }
          return Response.json({
            five_hour: { utilization: 10 },
            seven_day: { utilization: 20 },
          })
        }
        if (url.includes('/v1/messages'))
          return new Response('{}', {
            status: 200,
            headers: {
              'anthropic-ratelimit-unified-5h-utilization': '0.2',
              'anthropic-ratelimit-unified-7d-utilization': '0.3',
            },
          })
        return Response.json({})
      }),
      {
        preconnect() {
          throw new Error('Unexpected preconnect in test fixture')
        },
      },
    )
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: accessA,
          refresh: 'refresh-a',
          expires: checkedAt + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    const quotaManager = getPluginTestHandles(plugin).quotaManager
    try {
      const oldRequest = quotaManager.refreshMain(uuidA, accessA)
      priorPoll = oldRequest
      bodyLifetime().trackDetached(Promise.allSettled([oldRequest]))
      await Promise.race([
        oldPollEntered.wait,
        oldRequest.then(() => {
          throw new Error('Old poll did not reach the usage endpoint')
        }),
      ])
      await replacePoolMainLogin(
        {
          access: accessB,
          refresh: 'refresh-b',
          expires: Date.now() + 8 * 60 * 60_000,
        },
        { sameAccount: false, accountIdentity: uuidB },
      )
      // The old usage request fails after credentials have been replaced.
      // Its error must not impose backoff on the replacement account.
      releaseOldPoll.open()
      await expect(priorPoll).rejects.toThrow('429')
      expect(
        (await readAccountStorage())?.quota?.mainLastQuotaApiError,
      ).toBeUndefined()
      modelRequest = Promise.resolve(result.fetch(MESSAGES_URL, EMPTY_POST))
      bodyLifetime().trackDetached(Promise.allSettled([modelRequest]))
      const response = await modelRequest
      expect(response.status).toBe(200)
      await response.text()
      const entries = await waitForFeedEntries(
        (entries) =>
          entries.some(
            (entry) =>
              entry !== null &&
              typeof entry === 'object' &&
              'anthropic_account_uuid' in entry &&
              entry.anthropic_account_uuid === uuidB,
          ),
        'replacement account quota feed',
      )
      expect(quotaManager.getMain(uuidA)).toBeNull()
      expect(quotaManager.getMain(uuidB)?.quota.accountIdentity).toBe(uuidB)
      await quotaManager.refreshMain(uuidB, accessB)
      expect(
        quotaManager.getMain(uuidB)?.quota.five_hour?.remainingPercent,
      ).toBe(90)
      expect(quotaManager.isBackedOff()).toBe(false)
      expect(
        (await readAccountStorage())?.quota?.mainLastQuotaApiError,
      ).toBeUndefined()
      expect(entries).toContainEqual(
        expect.objectContaining({
          identity_source: 'account_ref',
          anthropic_account_uuid: uuidB,
        }),
      )
      expect(await readFeedEntries()).not.toContainEqual(
        expect.objectContaining({ anthropic_account_uuid: uuidA }),
      )
    } finally {
      releaseOldPoll.open()
      await Promise.allSettled([priorPoll, modelRequest])
    }
  })

  test('sustained unknown account identity retains the fail-closed spend gate', async () => {
    const now = Date.now()
    const access = 'sk-ant-oat01-unknown'
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          mainAccountId: 'main-slot',
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            failClosedOnUnknownQuota: true,
            mainQuota: {
              source: 'poll',
              checkedAt: now,
              five_hour: {
                usedPercent: 100,
                remainingPercent: 0,
                checkedAt: now,
              },
            },
            mainQuotaCheckedAt: now,
            mainLastQuotaApiError: {
              message: 'account A quota backoff',
              checkedAt: now - 1_000,
              nextRetryAt: now + 60_000,
              retryCount: 1,
              accountIdentity: syntheticMainAccountUuid,
            },
          },
        }),
        access,
      ),
      { access, refresh: 'refresh-b', expires: now + 8 * 60 * 60_000 },
    )
    let messageCalls = 0
    let credentialCalls = 0
    globalThis.fetch = Object.assign(
      mock((input: Parameters<typeof fetch>[0]) => {
        const url = extractUrl(input)
        if (
          url.includes('/v1/oauth/token') ||
          url.includes('/claude_cli/bootstrap')
        )
          credentialCalls++
        if (url.includes('/claude_cli/bootstrap'))
          return Promise.resolve(
            new Response('bootstrap unavailable', { status: 503 }),
          )
        if (url.includes('/v1/messages')) {
          messageCalls++
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
      {
        preconnect() {
          throw new Error('Unexpected preconnect in test fixture')
        },
      },
    )
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access,
          refresh: 'refresh-b',
          expires: now + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    const request = Promise.resolve(result.fetch(MESSAGES_URL, EMPTY_POST))
    await expect(request).resolves.toMatchObject({ status: 429 })
    const response = await request
    expect(response.status).toBe(429)
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(messageCalls).toBe(0)
    expect(credentialCalls).toBe(0)
    expect(getPluginTestHandles(plugin).quotaManager.isBackedOff()).toBe(true)
    expect(
      (await readAccountStorage())?.quota?.mainLastQuotaApiError
        ?.accountIdentity,
    ).toBe(syntheticMainAccountUuid)
  })

  test('fresh account-wide exhaustion blocks primary credential acquisition', async () => {
    const now = Date.now()
    const access = 'sk-ant-oat01-fresh-exhaustion'
    const refresh = 'refresh-fresh-exhaustion'
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            failClosedOnUnknownQuota: true,
            mainQuota: {
              source: 'poll',
              checkedAt: now,
              five_hour: {
                usedPercent: 100,
                remainingPercent: 0,
                checkedAt: now,
                resetsAt: new Date(now + 120_000).toISOString(),
              },
              seven_day: {
                usedPercent: 12,
                remainingPercent: 88,
                checkedAt: now,
              },
            },
            mainQuotaCheckedAt: now,
          },
        }),
        access,
      ),
      { access, refresh, expires: now + 8 * 60 * 60_000 },
    )
    let calls = 0
    globalThis.fetch = Object.assign(
      mock(() => {
        calls++
        return Promise.resolve(Response.json({}))
      }),
      {
        preconnect() {
          throw new Error('Unexpected preconnect in test fixture')
        },
      },
    )
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access,
          refresh,
          expires: now + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(429)
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(
      118,
    )
    expect(Number(response.headers.get('retry-after'))).toBeLessThanOrEqual(120)
    expect(calls).toBe(0)
  })

  test('rounded header percentages cannot preempt primary credential acquisition', async () => {
    const now = Date.now()
    const access = 'sk-ant-oat01-rounded-header'
    const refresh = 'refresh-rounded-header'
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            mainQuota: {
              source: 'headers',
              checkedAt: now,
              five_hour: {
                usedPercent: 100,
                remainingPercent: 0,
                checkedAt: now,
              },
              seven_day: {
                usedPercent: 12,
                remainingPercent: 88,
                checkedAt: now,
              },
            },
            mainQuotaCheckedAt: now,
          },
        }),
        access,
      ),
      { access, refresh, expires: now + 8 * 60 * 60_000 },
    )
    let bootstrapCalls = 0
    let modelCalls = 0
    globalThis.fetch = Object.assign(
      mock((input: Parameters<typeof fetch>[0]) => {
        const url = extractUrl(input)
        if (url.includes('/claude_cli/bootstrap')) {
          bootstrapCalls++
          return Promise.resolve(
            Response.json({
              oauth_account: { account_uuid: syntheticMainAccountUuid },
            }),
          )
        }
        if (url.includes('/v1/messages')) modelCalls++
        return Promise.resolve(Response.json({}))
      }),
      {
        preconnect() {
          throw new Error('Unexpected preconnect in test fixture')
        },
      },
    )
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access,
          refresh,
          expires: now + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    const response = await result.fetch(MESSAGES_URL, {
      ...EMPTY_POST,
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1,
        messages: [
          { role: 'user', content: 'synthetic rounded-header control' },
        ],
      }),
    })
    expect(response.status).toBe(200)
    expect(bootstrapCalls).toBeGreaterThan(0)
    expect(modelCalls).toBe(1)
  })

  test('permanent main refresh failure is not masked by active usage backoff', async () => {
    const now = Date.now()
    const access = 'sk-ant-oat01-permanent-refresh-quota'
    const refresh = 'refresh-permanent-quota'
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            failClosedOnUnknownQuota: true,
            mainQuota: {
              source: 'poll',
              checkedAt: now,
              five_hour: {
                usedPercent: 100,
                remainingPercent: 0,
                checkedAt: now,
              },
            },
            mainQuotaCheckedAt: now,
            mainLastQuotaApiError: {
              message: 'usage wait',
              checkedAt: now,
              nextRetryAt: now + 60_000,
              accountIdentity: syntheticMainAccountUuid,
            },
          },
        }),
        access,
      ),
      { access, refresh, expires: now + 8 * 60 * 60_000 },
    )
    if (!testContext.migratedPool)
      throw new Error('This test has no migrated pool')
    let refreshCalls = 0
    globalThis.fetch = Object.assign(
      mock((input: Parameters<typeof fetch>[0]) => {
        if (!extractUrl(input).includes('/v1/oauth/token'))
          throw new Error(
            'Unexpected request while preparing a permanent refresh failure',
          )
        refreshCalls++
        return Promise.resolve(
          Response.json({ error: 'invalid_grant' }, { status: 400 }),
        )
      }),
      {
        preconnect() {
          throw new Error('Unexpected preconnect in test fixture')
        },
      },
    )
    const runtime = createNativeAccountRuntime({
      paths: testContext.migratedPool.paths,
      host: 'opencode',
    })
    try {
      expect(
        (await runtime.authorizeLocal('main', { rejectedAccessToken: access }))
          .status,
      ).toBe('failed')
      expect(refreshCalls).toBe(1)
      expect(
        (await runtime.read()).accounts.find((account) => account.id === 'main')
          ?.lastRefreshError?.permanent,
      ).toBe(true)
    } finally {
      runtime.close()
    }
    let calls = 0
    globalThis.fetch = Object.assign(
      mock(() => {
        calls++
        return Promise.resolve(Response.json({}))
      }),
      {
        preconnect() {
          throw new Error('Unexpected preconnect in test fixture')
        },
      },
    )
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access,
          refresh,
          expires: now + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    await expect(
      result.fetch(MESSAGES_URL, {
        ...EMPTY_POST,
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 1,
          messages: [
            { role: 'user', content: 'synthetic permanent-failure control' },
          ],
        }),
      }),
    ).rejects.toThrow('Claude OAuth refresh is backed off')
    expect(calls).toBe(0)
    expect(
      (await readAccountStorage())?.refresh?.mainLastRefreshError?.permanent,
    ).toBe(true)
    expect(
      (await readAccountStorage())?.refresh?.mainLastRefreshError?.status,
    ).toBe(400)
  })

  test('expired account usage backoff permits credential validation and dispatch', async () => {
    const now = Date.now()
    const access = 'sk-ant-oat01-expired-usage-backoff'
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            failClosedOnUnknownQuota: true,
            mainQuota: {
              source: 'poll',
              checkedAt: now,
              five_hour: {
                usedPercent: 4,
                remainingPercent: 96,
                checkedAt: now,
              },
              seven_day: {
                usedPercent: 12,
                remainingPercent: 88,
                checkedAt: now,
              },
            },
            mainQuotaCheckedAt: now,
            mainLastQuotaApiError: {
              message: 'expired usage backoff',
              checkedAt: now - 60_000,
              nextRetryAt: now - 1,
              retryCount: 1,
              accountIdentity: syntheticMainAccountUuid,
            },
          },
        }),
        access,
      ),
      {
        access,
        refresh: 'refresh-expired-usage-backoff',
        expires: now + 8 * 60 * 60_000,
      },
    )
    let bootstrapCalls = 0
    let modelCalls = 0
    globalThis.fetch = Object.assign(
      mock((input: Parameters<typeof fetch>[0]) => {
        const url = extractUrl(input)
        if (url.includes('/claude_cli/bootstrap')) {
          bootstrapCalls++
          return Promise.resolve(
            Response.json({
              oauth_account: { account_uuid: syntheticMainAccountUuid },
            }),
          )
        }
        if (url.includes('/v1/messages')) modelCalls++
        return Promise.resolve(Response.json({}))
      }),
      {
        preconnect() {
          throw new Error('Unexpected preconnect in test fixture')
        },
      },
    )
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access,
          refresh: 'refresh-expired-usage-backoff',
          expires: now + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    expect((await result.fetch(MESSAGES_URL, EMPTY_POST)).status).toBe(200)
    expect(bootstrapCalls).toBeGreaterThan(0)
    expect(modelCalls).toBe(1)
    expect(getPluginTestHandles(plugin).quotaManager.isBackedOff()).toBe(false)
  })

  test('confirmed account replacement clears the prior account backoff', async () => {
    const now = Date.now()
    const uuidA = syntheticMainAccountUuid
    const uuidB = syntheticFallbackAccountUuid(96)
    const accessA = 'sk-ant-oat01-account-a'
    const accessB = 'sk-ant-oat01-account-b'
    const oldError = {
      message: 'account A quota backoff',
      checkedAt: now - 1_000,
      nextRetryAt: now + 60_000,
      retryCount: 1,
      accountIdentity: uuidA,
    }
    await useTempAccountFile(
      bindMainAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            failClosedOnUnknownQuota: true,
            mainLastQuotaApiError: oldError,
            mainQuotaErrorGeneration: 1,
          },
        }),
        accessA,
        uuidA,
      ),
      { access: accessA, refresh: 'refresh-a', expires: now + 8 * 60 * 60_000 },
    )
    let messageCalls = 0
    globalThis.fetch = Object.assign(
      mock((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = extractUrl(input)
        const token = new Headers(init?.headers).get('authorization')
        if (url.includes('/claude_cli/bootstrap'))
          return Promise.resolve(
            Response.json({
              oauth_account: {
                account_uuid: token === `Bearer ${accessA}` ? uuidA : uuidB,
              },
            }),
          )
        if (url.includes('/api/oauth/usage'))
          return Promise.resolve(
            Response.json({
              five_hour: { utilization: 10 },
              seven_day: { utilization: 20 },
            }),
          )
        if (url.includes('/v1/messages')) messageCalls++
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
      {
        preconnect() {
          throw new Error('Unexpected preconnect in test fixture')
        },
      },
    )
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: accessA,
          refresh: 'refresh-a',
          expires: now + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    expect(
      (await readAccountStorage())?.quota?.mainLastQuotaApiError
        ?.accountIdentity,
    ).toBe(uuidA)
    expect(getPluginTestHandles(plugin).quotaManager.isBackedOff()).toBe(true)
    if (!testContext.migratedPool)
      throw new Error('This test has no migrated pool')
    const runtime = createNativeAccountRuntime({
      paths: testContext.migratedPool.paths,
      host: 'opencode',
    })
    try {
      const oldSubject = await runtime.captureLocalSubject('main')
      if (!isNativeLocalCredentialValidation(oldSubject))
        throw new Error('Main subject is not account and version bound')
      await replacePoolMainLogin(
        {
          access: accessB,
          refresh: 'refresh-b',
          expires: now + 8 * 60 * 60_000,
        },
        { sameAccount: false, accountIdentity: uuidB },
      )
      const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
      expect(response.status).toBe(200)
      expect(messageCalls).toBe(1)
      expect(getPluginTestHandles(plugin).quotaManager.isBackedOff()).toBe(
        false,
      )
      expect(
        (await readAccountStorage())?.quota?.mainLastQuotaApiError,
      ).toBeUndefined()
      expect(
        await runtime.publishLocal(oldSubject, {
          lastQuotaRefreshError: oldError,
        }),
      ).toBe(false)
      expect(
        (await readAccountStorage())?.quota?.mainLastQuotaApiError,
      ).toBeUndefined()
      expect(
        (await runtime.read()).accounts.find((account) => account.id === 'main')
          ?.accountIdentity,
      ).toBe(uuidB)
    } finally {
      runtime.close()
    }
  })

  test('discards main response headers resolved under a replaced identity', async () => {
    const uuidA = syntheticMainAccountUuid
    const uuidB = syntheticFallbackAccountUuid(97)
    const tokenA = 'sk-ant-oat01-race-token-a'
    const tokenB = 'sk-ant-oat01-race-token-b'
    const now = Date.now()
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          mainAccountId: 'main-slot',
          accounts: [],
          quotaHeaderFeed: { enabled: true },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            failClosedOnUnknownQuota: false,
            mainQuota: {
              source: 'poll',
              checkedAt: now,
              five_hour: {
                usedPercent: 4,
                remainingPercent: 96,
                checkedAt: now,
              },
              seven_day: {
                usedPercent: 12,
                remainingPercent: 88,
                checkedAt: now,
              },
            },
            mainQuotaCheckedAt: now,
          },
        }),
        tokenA,
        uuidA,
      ),
      { access: tokenA, refresh: 'refresh-a', expires: now + 8 * 60 * 60_000 },
    )
    const started = bodyLifetime().gate()
    const release = bodyLifetime().gate()
    let inFlight: Promise<Response> | undefined
    globalThis.fetch = Object.assign(
      mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = extractUrl(input)
        const token = new Headers(init?.headers).get('authorization')
        if (url.includes('/claude_cli/bootstrap'))
          return Response.json({
            oauth_account: {
              account_uuid: token === `Bearer ${tokenA}` ? uuidA : uuidB,
            },
          })
        if (url.includes('/api/oauth/usage'))
          return Response.json({
            five_hour: { utilization: 60 },
            seven_day: { utilization: 70 },
          })
        if (url.includes('/v1/messages')) {
          if (token === `Bearer ${tokenA}`) {
            started.open()
            await release.wait
            return new Response('{}', {
              status: 200,
              headers: {
                'anthropic-ratelimit-unified-5h-utilization': '0.1',
                'anthropic-ratelimit-unified-7d-utilization': '0.2',
              },
            })
          }
          return new Response('{}', {
            status: 200,
            headers: {
              'anthropic-ratelimit-unified-5h-utilization': '0.6',
              'anthropic-ratelimit-unified-7d-utilization': '0.7',
            },
          })
        }
        return Response.json({})
      }),
      {
        preconnect() {
          throw new Error('Unexpected preconnect in test fixture')
        },
      },
    )
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: tokenA,
          refresh: 'refresh-a',
          expires: now + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    const records: LogTestRecord[] = []
    __setLogTestSink((record) => records.push(record))
    setLogLevel('trace')
    try {
      inFlight = Promise.resolve(result.fetch(MESSAGES_URL, EMPTY_POST))
      bodyLifetime().trackDetached(Promise.allSettled([inFlight]))
      await Promise.race([
        started.wait,
        inFlight.then(() => {
          throw new Error('Old model request did not reach the expected sender')
        }),
      ])
      await replacePoolMainLogin(
        {
          access: tokenB,
          refresh: 'refresh-b',
          expires: Date.now() + 8 * 60 * 60_000,
        },
        { sameAccount: false, accountIdentity: uuidB },
      )
      const currentResponse = await result.fetch(MESSAGES_URL, EMPTY_POST)
      expect(currentResponse.status).toBe(200)
      await currentResponse.text()
      await waitForFeedEntries(
        (entries) =>
          entries.some(
            (entry) =>
              entry !== null &&
              typeof entry === 'object' &&
              'anthropic_account_uuid' in entry &&
              entry.anthropic_account_uuid === uuidB,
          ),
        'new account observation before old response release',
      )
      expect(
        getPluginTestHandles(plugin).quotaManager.getMain(uuidB)?.quota
          .five_hour?.usedPercent,
      ).toBe(60)
      release.open()
      expect((await inFlight).status).toBe(200)
      await waitForLogRecord(
        records,
        (record) =>
          record.channel === 'quota' &&
          record.message === 'discarded stale main quota headers',
        'old account header discard',
      )
      expect(await readFeedEntries()).not.toContainEqual(
        expect.objectContaining({ anthropic_account_uuid: uuidA }),
      )
      expect(
        getPluginTestHandles(plugin).quotaManager.getMain(uuidA),
      ).toBeNull()
      expect(
        getPluginTestHandles(plugin).quotaManager.getMain(uuidB)?.quota
          .five_hour?.usedPercent,
      ).toBe(60)
      await getPluginTestHandles(plugin).scopedRuntime.close()
      expect(
        (await readAccountStorage())?.quota?.mainQuota?.accountIdentity,
      ).toBe(uuidB)
      expect(
        (await readAccountStorage())?.quota?.mainQuota?.five_hour?.usedPercent,
      ).toBe(60)
    } finally {
      release.open()
      await Promise.allSettled([inFlight])
      await drainSidebarWrites()
      __setLogTestSink(null)
      setLogLevel('info')
    }
  })

  test('coalesces concurrent main identity resolution for the same token', async () => {
    // OAuth records without Anthropic's access-token prefix are no longer served natively: the request is
    // refused with guidance and nothing reaches the model or the quota feed.
    await expectNonOatMainRefused('compat-main-access')
  })

  test('aborts a request whose main identity becomes stale during resolution', async () => {
    // OAuth records without Anthropic's access-token prefix are no longer served natively: the request is
    // refused with guidance and nothing reaches the model or the quota feed.
    await expectNonOatMainRefused('compat-a')
  })
})

describe('main identity boot order', () => {
  afterEach(() => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
  })

  test('publishes main identity before background timers observe storage and preserves it across native token rotation', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({ quota: { enabled: false }, accounts: [] }),
      ),
      { ...syntheticMainHostAuth(), expires: Date.now() + 8 * 60 * 60_000 },
    )
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    const timerCallbacks: (() => void)[] = []
    const observedIds: (string | undefined)[] = []
    const timerObservedIds: (string | undefined)[] = []
    let authCalls = 0
    const auth = () => {
      authCalls += 1
      if (authCalls > 1) {
        bodyLifetime().trackDetached(
          readAccountStorage().then((storage) =>
            observedIds.push(storage?.mainAccountId),
          ),
        )
      }
      return Promise.resolve(custodyTombstoneOAuth('anthropic'))
    }
    const plugin = await getPlugin(undefined, undefined, {
      setInterval: ((callback: () => void) => {
        if (!testContext.migratedPool)
          throw new Error('Missing native main fixture')
        const runtime = JSON.parse(
          readFileSync(testContext.migratedPool.paths.runtime, 'utf8'),
        ) as {
          accounts: Record<
            string,
            { binding: { kind: string; rowId: string; identity?: string } }
          >
        }
        timerObservedIds.push(
          Object.values(runtime.accounts).find(
            (entry) => entry.binding.kind === 'local',
          )?.binding.identity,
        )
        timerCallbacks.push(callback)
        return { unref() {} } as unknown as ReturnType<typeof setInterval>
      }) as typeof setInterval,
      clearInterval: (() => {}) as typeof clearInterval,
    })
    await plugin.auth.loader(auth, { models: {} })
    const first = (await readAccountStorage())?.mainAccountId
    if (!first || !testContext.migratedPool)
      throw new Error('Missing native main identity')
    const runtime = createNativeAccountRuntime({
      paths: testContext.migratedPool.paths,
      host: 'opencode',
      local: {
        refreshToken: async () => ({
          access: 'sk-ant-oat01-main-boot-rotated',
          refresh: 'main-boot-rotated-refresh',
          expires: Date.now() + 8 * 60 * 60_000,
          expiresIn: 8 * 60 * 60,
        }),
        resolveIdentity: async () =>
          getClaudeCodeIdentityForVerifiedAccount(
            'main',
            poolMainIdentity() as ProviderAccountUuid,
          ),
      },
    })
    try {
      const rotated = await runtime.authorizeLocal('main', {
        intent: 'refresh',
      })
      if (rotated.status !== 'usable')
        throw new Error(
          `Native main rotation failed: ${rotated.status} ${'failure' in rotated ? JSON.stringify(rotated.failure) : 'reason' in rotated ? rotated.reason : ''}`,
        )
      expect(rotated.status).toBe('usable')
      expect(rotated.access).toBe('sk-ant-oat01-main-boot-rotated')
    } finally {
      runtime.close()
    }
    const mainLogin = testContext.poolLogins[0]
    if (!mainLogin) throw new Error('Missing main mock account')
    mainLogin.access = 'sk-ant-oat01-main-boot-rotated'
    mainLogin.refresh = 'main-boot-rotated-refresh'
    await plugin.auth.loader(auth, { models: {} })
    await Promise.all(
      timerCallbacks.map((callback) => Promise.resolve(callback())),
    )
    const second = (await readAccountStorage())?.mainAccountId

    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(second).toBe(first)
    expect(timerObservedIds.length).toBeGreaterThan(0)
    expect(timerObservedIds.every((identity) => identity === first)).toBe(true)
    expect(observedIds).toContain(first)
  })
})

describe('quota header feed extended integration', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('disabled quota header feed publishes nothing by default or when explicitly false', async () => {
    for (const enabled of [undefined, false]) {
      const storage = createFallbackStorage({
        quotaHeaderFeed: enabled === undefined ? undefined : { enabled },
        accounts: [],
      })
      const { response } = await loadMainAndFetch(
        storage,
        new Response('{}', {
          status: 200,
          headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.25' },
        }),
      )
      expect(await response.text()).toBe('{}')
      expect(await readFeedEntries()).toEqual([])
    }
  })

  test('feed publication failure does not affect response, quota persistence, or sidebar update', async () => {
    const feedDirectory = process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR!
    await useTempAccountFile(
      createFallbackStorage({
        quotaHeaderFeed: { enabled: true },
        accounts: [],
        quota: { enabled: false },
      }),
    )
    const feedParentFile = join(dirname(feedDirectory), 'feed-parent-file')
    await Bun.write(feedParentFile, 'not a directory')
    process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR = join(
      feedParentFile,
      'quota-header-feed',
    )
    globalThis.fetch = mock(
      withNativeAdmission(() =>
        Promise.resolve(
          new Response('{"ok":true}', {
            status: 200,
            headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.25' },
          }),
        ),
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
    })
    expect(await response.text()).toBe('{"ok":true}')
    const persisted = await waitForAccountStorage((storage) =>
      Boolean(storage?.quota?.mainQuota?.five_hour),
    )
    expect(persisted?.quota?.mainQuota?.five_hour?.usedPercent).toBe(25)
    expect(persisted?.quota?.mainQuota?.accountIdentity).toBe(
      persisted?.mainAccountId,
    )
    const sidebar = await waitForSidebarState(
      (state) => state.main.quota?.five_hour?.usedPercent === 25,
    )
    expect(sidebar.main.quota?.five_hour?.usedPercent).toBe(25)
    expect(await readFeedEntries()).toEqual([])
  })

  test('sidebar quota refresh preserves rotated account metadata without acquiring credentials', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: { enabled: false },
        main: { type: 'opencode', provider: 'anthropic' },
      }),
      {
        access: 'sk-ant-oat01-main-access-before-rotation',
        refresh: 'main-refresh',
        expires: Date.now() + 100_000,
      },
    )
    const currentAccess = 'sk-ant-oat01-main-access-before-rotation'
    const fetchSpy = mock(
      withNativeTokenExchange((input: unknown, init?: RequestInit) => {
        const url = extractUrl(input as string | URL | Request)
        if (url.startsWith(MESSAGES_URL)) {
          return Promise.resolve(
            new Response('{}', {
              status: 200,
              headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.25' },
            }),
          )
        }
        if (url.includes('/claude_cli/bootstrap')) {
          return Promise.resolve(
            Response.json({
              oauth_account: {
                account_uuid: '44444444-4444-4444-4444-444444444444',
              },
            }),
          )
        }
        return Promise.reject(new Error(`Unexpected test fetch: ${url}`))
      }),
    )
    globalThis.fetch = Object.assign(fetchSpy, {
      preconnect: globalThis.fetch.preconnect,
    })
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: currentAccess,
          refresh: 'main-refresh',
          expires: Date.now() + 100_000,
        }),
      { models: {} },
    )
    await drainSidebarWrites()

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)
    // Another OpenCode process refreshes the main login; the pool now holds
    // the rotated access token for the same account.
    await refreshPoolMainElsewhere({
      access: 'sk-ant-oat01-main-access-after-rotation',
      refresh: 'main-refresh-after-rotation',
      expires: Date.now() + 100_000,
    })

    const pool = testContext.migratedPool
    if (!pool) throw new Error('Expected migrated pool')
    const reader = createNativeAccountRuntime({
      paths: pool.paths,
      host: 'opencode',
    })
    bodyLifetime().deferCleanup(() => reader.close())
    expect(
      (await reader.captureLocalSubject('main')).version?.accessFingerprint,
    ).toBe(tokenFingerprint('sk-ant-oat01-main-access-after-rotation'))
    await waitForAccountStorage(
      (storage) => storage?.quota?.mainQuota?.five_hour?.usedPercent === 25,
    )
    const requestsBeforeDisplay = fetchSpy.mock.calls.length
    const resolved =
      await getPluginTestHandles(plugin).resolveSidebarQuotaAccess()
    expect(resolved.access).toBeUndefined()
    expect(resolved.storage?.quota?.mainQuota?.accountIdentity).toBe(
      '44444444-4444-4444-4444-444444444444',
    )
    expect(resolved.storage?.quota?.mainQuota?.five_hour?.usedPercent).toBe(25)
    expect(fetchSpy.mock.calls.length).toBe(requestsBeforeDisplay)
    await plugin.dispose?.()
  })

  test('deduplicates main feed observations across access-token rotation', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        mainAccountId: 'stable-main-account',
        quotaHeaderFeed: { enabled: true },
        accounts: [],
        quota: { enabled: false },
      }),
      {
        access: 'sk-ant-oat01-main-access-a',
        refresh: 'main-refresh',
        expires: Date.now() + 100000,
      },
    )
    let requestCount = 0
    globalThis.fetch = mock(
      withNativeAdmission(() => {
        requestCount += 1
        return Promise.resolve(
          new Response('{}', {
            status: 200,
            headers: {
              'anthropic-ratelimit-unified-5h-utilization': String(
                requestCount / 100,
              ),
            },
          }),
        )
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()

    for (const access of [
      'sk-ant-oat01-main-access-a',
      'sk-ant-oat01-main-access-b',
    ]) {
      // The second generation is a refresh of the same account in another
      // OpenCode process, which rotates the pool's main access token.
      if (access !== 'sk-ant-oat01-main-access-a')
        await refreshPoolMainElsewhere({
          access,
          refresh: `main-refresh-${access}`,
          expires: Date.now() + 100000,
        })
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: 'sk-ant-oat01-main-access-a',
            refresh: 'main-refresh',
            expires: Date.now() + 100000,
          }),
        { models: {} },
      )
      const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
      await response.text()
    }

    const entries = await waitForFeedEntries(
      (candidate) => candidate.length === 1,
      'one published entry',
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual(
      // Quota uses Anthropic's account UUID, not the local identifier used
      // to keep the main login's device identity stable across token rotation.
      expect.objectContaining({
        identity_source: 'account_ref',
        account_ref: poolMainIdentity(),
      }),
    )
  })

  test('ordered fallback admission sends an unknown-quota OAuth account', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        routing: { mode: 'fallback-first' },
        quota: {
          ...createFallbackStorage().quota,
          failClosedOnUnknownQuota: false,
        },
        accounts: [
          {
            id: 'unknown-fallback',
            type: 'oauth',
            access: 'sk-ant-oat01-unknown-fallback-access',
            refresh: 'unknown-fallback-refresh',
            expires: Date.now() + 5 * 60 * 60_000,
          },
        ],
      }),
    )
    const authorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage'))
          return Promise.reject(new Error('quota source unavailable'))
        authorizations.push(
          new Headers(init?.headers).get('authorization') ?? '',
        )
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)
    expect(authorizations).toContain(
      'Bearer sk-ant-oat01-unknown-fallback-access',
    )
  })

  test('ordered fallback admission rejects unknown-quota OAuth under fail-closed', async () => {
    await expectUnknownQuotaAdmissionBlocked(
      createFallbackStorage({
        routing: { mode: 'fallback-first' },
        accounts: [
          {
            id: 'unknown-fallback',
            type: 'oauth',
            access: 'sk-ant-oat01-unknown-fallback-access',
            refresh: 'unknown-fallback-refresh',
            expires: Date.now() + 5 * 60 * 60_000,
          },
        ],
      }),
    )
  })

  test('ordered fallback admission excludes an active refresh-backoff account while admitting an identical account without backoff', async () => {
    const now = Date.now()
    for (const lastRefreshError of [
      {
        message: 'refresh temporarily unavailable',
        checkedAt: now,
        nextRetryAt: now + 60_000,
        retryCount: 1,
        accountIdentity: 'unknown-fallback',
        permanent: false,
        // Old anthropic-auth-state.json errors carry a refresh-token hash.
        // Migration preserves the matching credential's retry restriction.
        tokenHash: hashRefreshToken('unknown-fallback-refresh'),
      },
      undefined,
    ]) {
      const storage = bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          quota: {
            ...createFallbackStorage().quota,
            failClosedOnUnknownQuota: false,
          },
          accounts: [
            {
              id: 'unknown-fallback',
              type: 'oauth',
              access: 'sk-ant-oat01-unknown-fallback-access',
              refresh: 'unknown-fallback-refresh',
              expires: now + 1_000,
              lastRefreshError,
            },
          ],
        }),
      )
      await useTempAccountFile(storage)
      loginIssues(
        'sk-ant-oat01-unknown-fallback-access',
        'sk-ant-oat01-refreshed-fallback-access',
      )
      const messageAuthorizations: string[] = []
      globalThis.fetch = mock(
        withNativeBootstrap((input: any, init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/v1/oauth/token'))
            return Promise.resolve(
              Response.json({
                access_token: 'sk-ant-oat01-refreshed-fallback-access',
                expires_in: 18_000,
              }),
            )
          if (url.includes('/api/oauth/usage'))
            return Promise.reject(new Error('quota source unavailable'))
          if (url.includes('/v1/messages')) {
            messageAuthorizations.push(
              new Headers(init?.headers).get('authorization') ?? '',
            )
          }
          return Promise.resolve(new Response('{}', { status: 200 }))
        }),
      ) as unknown as typeof fetch
      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: 'sk-ant-oat01-main-access',
            refresh: 'main-refresh',
            expires: Date.now() + 100000,
          }),
        { models: {} },
      )

      const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
      if (lastRefreshError) {
        expect(messageAuthorizations).not.toContain(
          'Bearer sk-ant-oat01-unknown-fallback-access',
        )
      } else {
        expect(response.status).toBe(200)
        expect(messageAuthorizations.length).toBeGreaterThan(0)
        // The original bearer is still valid, so dispatch need not wait for
        // proactive rotation. Both bearers belong to the admitted fallback.
        for (const authorization of messageAuthorizations)
          expect([
            'Bearer sk-ant-oat01-unknown-fallback-access',
            'Bearer sk-ant-oat01-refreshed-fallback-access',
          ]).toContain(authorization)
      }
    }
  })

  test('ordered fallback admission rejects unknown-quota OAuth with refresh backoff under fail-closed', async () => {
    const now = Date.now()
    await expectUnknownQuotaAdmissionBlocked(
      createFallbackStorage({
        routing: { mode: 'fallback-first' },
        accounts: [
          {
            id: 'unknown-fallback',
            type: 'oauth',
            access: 'sk-ant-oat01-unknown-fallback-access',
            refresh: 'unknown-fallback-refresh',
            expires: now + 5 * 60 * 60_000,
            lastRefreshError: {
              message: 'refresh temporarily unavailable',
              checkedAt: now,
              nextRetryAt: now + 60_000,
              retryCount: 1,
              accountIdentity: 'unknown-fallback',
              permanent: false,
            },
          },
        ],
      }),
    )
  })

  test('fail-closed quota backoff gate blocks send when main quota is unknown', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
        },
      }),
    )
    const messageRequests: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage'))
          return Promise.reject(new Error('quota source unavailable'))
        if (url.includes('/v1/messages')) messageRequests.push(url)
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(429)
    expect(messageRequests).toEqual([])
  })

  test('fail-closed quota gate sends when failClosedOnUnknownQuota is disabled', async () => {
    const now = Date.now()
    const storage = createFallbackStorage({
      accounts: [],
      quota: {
        enabled: true,
        checkIntervalMinutes: 5,
        minimumRemaining: { five_hour: 1, seven_day: 1 },
        failClosedOnUnknownQuota: false,
        mainLastQuotaApiError: {
          message: 'quota source unavailable',
          checkedAt: now,
          nextRetryAt: now + 60_000,
          retryCount: 1,
        },
      },
    })
    await useTempAccountFile(storage)
    const messageRequests: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage'))
          return Promise.reject(new Error('quota source unavailable'))
        if (url.includes('/v1/messages')) messageRequests.push(url)
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)
    expect(messageRequests).toHaveLength(1)
    expect(messageRequests[0]).toContain(MESSAGES_URL)
  })

  test('fail-closed quota gate sends when main quota is unknown without quota backoff', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: {
          enabled: false,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
        },
      }),
    )
    const messageRequests: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/v1/messages')) messageRequests.push(url)
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)
    expect(messageRequests).toHaveLength(1)
    expect(messageRequests[0]).toContain(MESSAGES_URL)
  })

  test('selects account_ref for main and fallback without leaking credential_id', async () => {
    const main = await loadMainAndFetch(
      createFallbackStorage({
        quotaHeaderFeed: { enabled: true },
        accounts: [],
      }),
      new Response('{}', {
        status: 200,
        headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.25' },
      }),
    )
    await main.response.text()
    const mainEntries = await waitForFeedEntries(
      (entries) => entries.length === 1,
      'one main published entry',
    )
    const mainAccountId = (await readAccountStorage())?.mainAccountId
    expect(mainEntries[0]).toEqual(
      expect.objectContaining({
        identity_source: 'account_ref',
        account_ref: mainAccountId,
      }),
    )
    expect(mainEntries[0]).not.toHaveProperty('credential_id')

    const fallback = await loadMainAndFetch(
      bindPoolAccounts(
        createFallbackStorage({
          quotaHeaderFeed: { enabled: true },
          routing: { mode: 'fallback-first' },
        }),
      ),
      new Response('{}', {
        status: 200,
        headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.25' },
      }),
    )
    await fallback.response.text()
    const fallbackEntry = (
      await waitForFeedEntries(
        (entries) =>
          entries.length === 1 &&
          entries.some((entry: any) => entry.account_ref === 'fallback-1'),
        'one fallback-1 published entry',
      )
    ).find((entry: any) => entry.identity_source === 'account_ref') as any
    expect(fallbackEntry).toEqual(
      expect.objectContaining({
        identity_source: 'account_ref',
        account_ref: 'fallback-1',
      }),
    )
    expect(fallbackEntry).not.toHaveProperty('credential_id')
  })

  test('published configured account count uses live main OAuth plus every OAuth fallback and excludes API keys', async () => {
    const { response } = await loadMainAndFetch(
      createFallbackStorage({
        quotaHeaderFeed: { enabled: true },
        accounts: [
          {
            id: 'disabled-oauth',
            type: 'oauth',
            access: 'sk-ant-oat01-disabled-access',
            refresh: 'disabled-refresh',
            expires: Date.now() + 8 * 60 * 60_000,
            enabled: false,
          },
          {
            id: 'enabled-oauth',
            type: 'oauth',
            access: 'sk-ant-oat01-enabled-access',
            refresh: 'enabled-refresh',
            expires: Date.now() + 8 * 60 * 60_000,
            enabled: true,
          },
          {
            id: 'api-key',
            type: 'api',
            apiKey: 'key',
            baseURL: 'https://example.test',
          },
        ] as AccountStorage['accounts'],
      }),
      new Response('{}', {
        status: 200,
        headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.25' },
      }),
    )
    expect(response.status).toBe(200)
    await response.text()
    const entries = await waitForFeedEntries(
      (candidate) => candidate.length === 1,
      'one configured-account-count entry',
    )
    expect(entries[0]).toEqual(
      expect.objectContaining({ configured_account_count: 3 }),
    )
  })

  test('publishes genuine relay response headers through onResponseHeaders', async () => {
    const { response } = await loadMainAndFetch(
      createFallbackStorage({
        quotaHeaderFeed: { enabled: true },
        relay: {
          enabled: true,
          url: 'https://relay.example.test',
          token: 'relay-token',
          transport: 'http',
        },
      }),
      () =>
        new Response('{}', {
          status: 200,
          headers: {
            'anthropic-ratelimit-unified-5h-utilization': '0.5',
            'x-cortexkit-relay-optimistic': 'true',
          },
        }),
      { 'x-session-affinity': 'feed-relay-session' },
    )
    await response.text()
    const entries = await waitForFeedEntries(
      (candidate) => candidate.length === 1,
      'one relay published entry',
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual(
      expect.objectContaining({
        quota: expect.objectContaining({
          five_hour: expect.objectContaining({ usedPercent: 50 }),
        }),
      }),
    )
  })
})

describe('auth.loader', () => {
  installLoaderSetup(testContext)

  test('boot seeds fallback-first sidebar routing from the first enabled OAuth fallback', async () => {
    await useTempAccountFile(
      createFallbackStorage({ routing: { mode: 'fallback-first' } }),
    )

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await drainSidebarWrites()

    const state = await getSidebarState()
    expect(state.activeId).toBe('fallback-1')
    expect(state.route).toBe('fallback-first')
  })

  test('boot preserves fresh sidebar routing from another live session', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [
          {
            id: 'work-alt',
            type: 'oauth',
            access: 'sk-ant-oat01-work-access',
            refresh: 'work-refresh',
            expires: Date.now() + 100000,
          },
        ],
      }),
    )
    await seedSidebarRouting('work-alt', 'fallback-first', Date.now())

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await drainSidebarWrites()

    const state = await getSidebarState()
    expect(state.activeId).toBe('work-alt')
    expect(state.route).toBe('fallback-first')
  })

  test('boot re-reads sidebar routing written after plugin creation', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [
          {
            id: 'work-alt',
            type: 'oauth',
            access: 'sk-ant-oat01-work-access',
            refresh: 'work-refresh',
            expires: Date.now() + 100000,
          },
        ],
      }),
    )

    const plugin = await getPlugin()
    await seedSidebarRouting('work-alt', 'fallback-first', Date.now())
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await drainSidebarWrites()

    const state = await getSidebarState()
    expect(state.activeId).toBe('work-alt')
    expect(state.route).toBe('fallback-first')
  })

  test('boot reads preserved routing after its asynchronous storage load', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [
          {
            id: 'work-alt',
            type: 'oauth',
            access: 'sk-ant-oat01-work-access',
            refresh: 'work-refresh',
            expires: Date.now() + 100000,
          },
        ],
      }),
    )

    let sequence = 0
    let sidebarReadAt = 0
    let storageLoadedAt = 0
    let storageLoadStarted!: () => void
    const storageLoadPaused = new Promise<void>((resolve) => {
      storageLoadStarted = resolve
    })
    let resumeStorageLoad!: () => void
    const storageLoadResumed = new Promise<void>((resolve) => {
      resumeStorageLoad = resolve
    })
    __setInitialSidebarRoutingTestHooks({
      beforeSidebarRead: () => {
        sidebarReadAt = ++sequence
      },
      beforeStorageLoad: async () => {
        storageLoadStarted()
        await storageLoadResumed
      },
      afterStorageLoad: () => {
        storageLoadedAt = ++sequence
      },
    })

    const plugin = await getPlugin()
    const loaderResult = plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await storageLoadPaused
    await seedSidebarRouting('work-alt', 'fallback-first', Date.now())
    resumeStorageLoad()
    await loaderResult
    await drainSidebarWrites()

    expect(storageLoadedAt).toBeLessThan(sidebarReadAt)
    const state = await getSidebarState()
    expect(state.activeId).toBe('work-alt')
    expect(state.route).toBe('fallback-first')
  })

  test('boot write preserves routing written after its initial resolution', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [
          {
            id: 'work-alt',
            type: 'oauth',
            access: 'sk-ant-oat01-work-access',
            refresh: 'work-refresh',
            expires: Date.now() + 100000,
          },
        ],
      }),
    )
    const foreignUpdatedAt = Date.now()
    const resolvedByBoot = {
      ...(await getSidebarState()),
      activeId: 'main',
      route: 'main',
      lastUpdated: foreignUpdatedAt - 1000,
    }
    await seedSidebarRouting('work-alt', 'fallback-first', foreignUpdatedAt)

    await setSidebarState(resolvedByBoot, getSidebarStateFile(), {
      routingAuthoritative: false,
      resolvePreservedRouting: (current) =>
        current.activeId === 'work-alt'
          ? { activeId: current.activeId, route: current.route }
          : undefined,
    })

    const state = await getSidebarState()
    expect(state.activeId).toBe('work-alt')
    expect(state.route).toBe('fallback-first')
    expect(state.lastUpdated).toBe(foreignUpdatedAt)
  })

  test('boot preserves fresh routing for an account added after plugin creation', async () => {
    const capturedStorage = createFallbackStorage({
      accounts: [],
      routing: { mode: 'fallback-first' },
    })
    expect(
      capturedStorage.accounts.some((account) => account.id === 'work-2'),
    ).toBe(false)
    await useTempAccountFile(capturedStorage)
    const plugin = await getPlugin()
    // An external settings write sets failClosedOnUnknownQuota=false and
    // adds an account. The existing plugin must reread both changes.
    await addPoolOAuthAccount('work-2', {
      access: 'sk-ant-oat01-work-2-access',
      refresh: 'work-2-refresh',
      expires: Date.now() + 100000,
    })
    await updatePoolSettings((settings) => ({
      ...settings,
      quota: {
        ...(settings.quota as Record<string, unknown>),
        failClosedOnUnknownQuota: false,
      },
    }))
    expect(
      (await readAccountStorage())?.accounts.some(
        (account) => account.id === 'work-2',
      ),
    ).toBe(true)
    await seedSidebarRouting('work-2', 'fallback-first', Date.now())

    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await drainSidebarWrites()

    const state = await getSidebarState()
    expect(state.activeId).toBe('work-2')
    expect(state.route).toBe('fallback-first')
    expect(state.fallbacks.map((account) => account.id)).toContain('work-2')
    expect(resolveActiveAccount(state).id).toBe('work-2')
  })

  test('stale main routing write carries forward accounts added after plugin creation', async () => {
    const capturedStorage = createFallbackStorage({ accounts: [] })
    await useTempAccountFile(capturedStorage)
    const plugin = await getPlugin()
    // Add an account through another runtime to verify that an existing plugin rereads shared storage before selecting a fallback.
    await addPoolOAuthAccount('work-fresh', {
      access: 'sk-ant-oat01-work-fresh-access',
      refresh: 'work-fresh-refresh',
      expires: Date.now() + 100000,
    })
    await seedSidebarRouting('main', 'main', Date.now())

    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await drainSidebarWrites()

    const state = await getSidebarState()
    expect(state.activeId).toBe('main')
    expect(state.route).toBe('main')
    expect(state.fallbacks.map((account) => account.id)).toContain('work-fresh')
  })

  test('stale writer does not resurrect a deleted active account', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          quota: { enabled: false },
          accounts: [
            {
              id: 'work-deleted',
              type: 'oauth',
              access: 'sk-ant-oat01-work-deleted-access',
              refresh: 'work-deleted-refresh',
              expires: Date.now() - 1000,
            },
            {
              id: 'work-witness',
              type: 'oauth',
              access: 'sk-ant-oat01-work-witness-stale-access',
              refresh: 'work-witness-stale-refresh',
              expires: Date.now() - 1000,
              lastRefreshedAt: 100,
            },
          ],
        }),
      ),
    )
    const refreshStarted = bodyLifetime().gate()
    const releaseRefresh = bodyLifetime().gate()
    globalThis.fetch = mock((input: Parameters<typeof fetch>[0]) => {
      const url = extractUrl(input)
      if (url === TOKEN_URL) {
        refreshStarted.open()
        return releaseRefresh.wait.then(
          () =>
            new Response(JSON.stringify({ error: 'invalid_grant' }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            }),
        )
      }
      if (url === PROFILE_URL) {
        return Promise.resolve(new Response('unauthorized', { status: 401 }))
      }
      if (url === QUOTA_URL) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              five_hour: { utilization: 0.1 },
              seven_day: { utilization: 0.1 },
              limits: [],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        )
      }
      return Promise.reject(new Error(`Unexpected test fetch: ${url}`))
    }) as unknown as typeof fetch
    const plugin = await getPlugin()
    const backgroundRefreshReady =
      getPluginTestHandles(plugin).fallbackRefreshReady
    expect(backgroundRefreshReady).toBeInstanceOf(Promise)
    try {
      await withDeadlockGuard(
        refreshStarted.wait,
        4_000,
        'fallback refresh never reached the token stub; the eager refresh did not start',
      )
      const pool = testContext.migratedPool
      if (!pool) throw new Error('Expected migrated pool')
      // Sign-in verifies the account behind each new access token; answer
      // that lookup from this map instead of the bootstrap endpoint.
      const signInIdentities = new Map<string, string>([
        [
          'sk-ant-oat01-work-current-access',
          '99999999-2222-4333-8444-555555555555',
        ],
      ])
      const peer = createNativeAccountRuntime({
        paths: pool.paths,
        host: 'opencode',
        local: {
          resolveIdentity: async (access) => {
            const identity = signInIdentities.get(access)
            if (!identity) throw new Error('Unknown synthetic sign-in token')
            return {
              deviceId: 'synthetic-device',
              sessionId: 'synthetic-session',
              accountUuid: identity as ProviderAccountUuid,
            }
          },
        },
      })
      try {
        const witness = (await peer.read()).accounts.find(
          (row) => row.id === 'work-witness',
        )
        if (!witness?.accountIdentity)
          throw new Error('Expected known witness UUID')
        signInIdentities.set(
          'sk-ant-oat01-work-witness-current-access',
          witness.accountIdentity,
        )
        const staleSubject = requireKnownPoolSubject(
          await peer.captureLocalSubject('work-deleted'),
        )
        // Removal shares the refresh lock, so queue it before releasing the
        // provider rather than waiting for removal while holding that lock.
        const removing = peer.remove('work-deleted')
        bodyLifetime().trackDetached(Promise.allSettled([removing]))
        releaseRefresh.open()
        await removing
        expect(
          await peer.publishLocal(staleSubject, { lastUsed: Date.now() }),
        ).toBe(false)
        await peer.loginOAuth({
          routeId: 'work-current',
          replace: false,
          credential: {
            access: 'sk-ant-oat01-work-current-access',
            refresh: 'work-current-refresh',
            expires: Date.now() + 100000,
          },
        })
        await peer.loginOAuth({
          routeId: 'work-witness',
          replace: true,
          credential: {
            access: 'sk-ant-oat01-work-witness-current-access',
            refresh: 'work-witness-current-refresh',
            expires: Date.now() - 1000,
          },
        })
        await peer.reorder(['main', 'work-current', 'work-witness'])
        const witnessFailure = await peer.authorizeLocal('work-witness', {
          intent: 'refresh',
        })
        expect(witnessFailure.status).toBe('failed')
      } finally {
        peer.close()
      }
      await seedSidebarRouting('work-deleted', 'fallback-first', Date.now())

      await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth',
            access: 'sk-ant-oat01-main-access',
            refresh: 'main-refresh',
            expires: Date.now() + 100000,
          }),
        { models: {} },
      )
      releaseRefresh.open()
      await withDeadlockGuard(
        backgroundRefreshReady!,
        4_000,
        'fallback background refresh did not complete after the token stub was released',
      )
      const disk = await readAccountStorage()
      expect(disk?.accounts.map((account) => account.id)).toEqual([
        'work-current',
        'work-witness',
      ])
      const poolRead = await createNativePoolStore({
        paths: pool.paths,
        quota: nativeQuotaCodec,
      }).read()
      expect(poolRead.status).toBe('ready')
      if (poolRead.status !== 'ready')
        throw new Error('Expected ready native pool')
      expect(
        poolRead.rows.find((row) => row.id === 'work-deleted'),
      ).toBeUndefined()
      expect(
        poolRead.rows.find((row) => row.id === 'work-current')?.credential,
      ).toMatchObject({
        access: 'sk-ant-oat01-work-current-access',
        refresh: 'work-current-refresh',
      })
      expect(
        disk?.accounts.find((account) => account.id === 'work-witness'),
      ).toMatchObject({
        lastRefreshError: { status: 400, permanent: true },
      })
      const state = await waitForSidebarState(
        (candidate) => candidate.activeId === 'work-current',
      )
      expect(state.route).toBe('fallback-first')
      expect(state.fallbacks.map((account) => account.id)).toEqual([
        'work-current',
        'work-witness',
      ])
    } finally {
      releaseRefresh.open()
    }
  })

  test('boot ignores stale sidebar routing and derives fallback-first routing', async () => {
    await useTempAccountFile(
      createFallbackStorage({ routing: { mode: 'fallback-first' } }),
    )
    await seedSidebarRouting('main', 'main', Date.now() - 11 * 60 * 1000)

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await drainSidebarWrites()

    const state = await getSidebarState()
    expect(state.activeId).toBe('fallback-1')
    expect(state.route).toBe('fallback-first')
  })

  test('boot ignores fresh sidebar routing for an unknown account', async () => {
    await useTempAccountFile(
      createFallbackStorage({ routing: { mode: 'fallback-first' } }),
    )
    await seedSidebarRouting('removed-account', 'fallback-first', Date.now())

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await drainSidebarWrites()

    const state = await getSidebarState()
    expect(state.activeId).toBe('fallback-1')
    expect(state.route).toBe('fallback-first')
  })

  test('boot keeps main-first sidebar routing on main', async () => {
    await useTempAccountFile(createFallbackStorage())

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await drainSidebarWrites()

    const state = await getSidebarState()
    expect(state.activeId).toBe('main')
    expect(state.route).toBe('main')
  })

  async function runQuotaRefreshWithFailedStorageReload(
    clearExistingRouting: boolean,
  ) {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({ routing: { mode: 'fallback-first' } }),
      ),
    )
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0.25 },
                seven_day: { utilization: 0.3 },
              }),
              { status: 200 },
            ),
          )
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(
      createMockClient(),
      testContext.tempConfigDir,
    )
    const loaded = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    // Establish the plugin's actual route before testing a quota-only write.
    const response = await loaded.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)
    await getPluginTestHandles(plugin).fallbackRefreshReady
    await drainSidebarWrites()
    expect((await getSidebarState()).activeId).toBe('fallback-1')
    if (clearExistingRouting) {
      const current = await getSidebarState()
      await setSidebarState({
        ...current,
        activeId: undefined,
        route: 'main',
        lastUpdated: Date.now(),
      })
    } else {
      await seedSidebarRouting('fallback-1', 'fallback-first', Date.now())
    }

    let signalBlocked!: () => void
    const blocked = new Promise<void>((resolve) => {
      signalBlocked = resolve
    })
    let releaseWrite!: () => void
    const released = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    let shouldBlock = true
    __setSidebarStateWriteTestHooks({
      beforeRename: async () => {
        if (!shouldBlock) return
        shouldBlock = false
        signalBlocked()
        await released
      },
    })

    const blockingWrite = setSidebarState(await getSidebarState())
    await blocked
    try {
      const refreshed = await applyMenuAction(plugin, 'session-1', {
        sectionId: 'Quota',
        actionId: 'quota-refresh',
      })
      expect(refreshed.ok).toBe(true)
      // Quota polls return before publishing to the pool config. Drain those
      // writes so a pending rename cannot recreate the file during the swap.
      await getPluginTestHandles(plugin).scopedRuntime.drainQuotaPublications()
      // Replace the shared pool config JSON file with a directory so later
      // account reads fail instead of returning an outdated snapshot.
      const accountFile = testContext.migratedPool?.paths.config
      if (!accountFile) throw new Error('Expected a migrated pool')
      await rm(accountFile)
      await mkdir(accountFile)
    } finally {
      releaseWrite()
    }
    await blockingWrite
    await drainSidebarWrites()
    __setSidebarStateWriteTestHooks(null)
    return getSidebarState()
  }

  test('quota refresh preserves existing fallback routing when storage reload fails', async () => {
    const state = await runQuotaRefreshWithFailedStorageReload(false)
    expect(state.activeId).toBe('fallback-1')
    expect(state.route).toBe('fallback-first')
  })

  test('quota refresh uses supplied routing when storage reload fails without existing routing', async () => {
    const state = await runQuotaRefreshWithFailedStorageReload(true)
    expect(state.activeId).toBe('fallback-1')
    expect(state.route).toBe('fallback-first')
  })

  test('/claude-quota preserves the last sidebar routing decision', async () => {
    await useTempAccountFile(
      createFallbackStorage({ routing: { mode: 'fallback-first' } }),
    )
    globalThis.fetch = mock((input: string | URL | Request) => {
      if (extractUrl(input).includes('/api/oauth/usage')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              five_hour: { utilization: 0.25 },
              seven_day: { utilization: 0.3 },
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    )
    await drainSidebarWrites()

    const state = await getSidebarState()
    expect(state.activeId).toBe('fallback-1')
    expect(state.route).toBe('fallback-first')
  })

  test('/claude-quota preserves fresher routing from another session', async () => {
    const releaseStartupQuota = bodyLifetime().gate()
    const startupSidebarMerged = bodyLifetime().gate()
    await useTempAccountFile(
      createFallbackStorage({
        routing: { mode: 'fallback-first' },
        accounts: [
          {
            id: 'fallback-a',
            type: 'oauth',
            access: 'sk-ant-oat01-fallback-a-access',
            refresh: 'fallback-a-refresh',
            expires: Date.now() + 100000,
          },
          {
            id: 'fallback-b',
            type: 'oauth',
            access: 'sk-ant-oat01-fallback-b-access',
            refresh: 'fallback-b-refresh',
            expires: Date.now() + 100000,
          },
        ],
      }),
    )
    globalThis.fetch = mock((input: string | URL | Request) => {
      if (extractUrl(input).includes('/api/oauth/usage')) {
        return releaseStartupQuota.wait.then(
          () =>
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0.25 },
                seven_day: { utilization: 0.3 },
              }),
              { status: 200 },
            ),
        )
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await seedSidebarRouting('fallback-b', 'fallback-first', Date.now())

    // The startup fallback-quota sweep publishes routing independently of menu
    // opening. Let its display-only merge learn the sibling's fresh route before
    // aging the file; draining alone cannot join a write not yet enqueued.
    __setSidebarStateWriteTestHooks({
      afterMergeRead: () => startupSidebarMerged.open(),
    })
    releaseStartupQuota.open()
    await startupSidebarMerged.wait
    await drainSidebarWrites()
    __setSidebarStateWriteTestHooks(null)

    await expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    )
    await drainSidebarWrites()

    const state = await getSidebarState()
    expect(state.activeId).toBe('fallback-b')
    expect(state.route).toBe('fallback-first')

    await seedSidebarRouting(
      'fallback-b',
      'fallback-first',
      Date.now() - 11 * 60 * 1000,
    )
    await expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    )
    await drainSidebarWrites()

    const stateAfterStaleFile = await getSidebarState()
    expect(stateAfterStaleFile.activeId).toBe('fallback-b')
    expect(stateAfterStaleFile.route).toBe('fallback-first')
  })

  test('real routing decisions overwrite fresh routing from another session', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        quota: { enabled: false },
        accounts: [
          {
            id: 'work-alt',
            type: 'oauth',
            access: 'sk-ant-oat01-work-access',
            refresh: 'work-refresh',
            expires: Date.now() + 100000,
          },
        ],
      }),
    )
    globalThis.fetch = mock(
      withNativeAdmission(() =>
        Promise.resolve(new Response('{}', { status: 200 })),
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await seedSidebarRouting('work-alt', 'fallback-first', Date.now())

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    await drainSidebarWrites()

    const state = await getSidebarState()
    expect(state.activeId).toBe('main')
    expect(state.route).toBe('main')
  })

  test('sidebar shows persisted main quota written after plugin startup', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: true,
        },
      }),
    )

    const plugin = await getPlugin()
    const storage = await readAccountStorage()
    expect(storage).not.toBeNull()

    let quotaApiCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) quotaApiCalls++
        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch
    // Another OpenCode process records the main account's quota after this
    // plugin has started.
    await publishPoolQuota('main', {
      five_hour: {
        usedPercent: 12,
        remainingPercent: 88,
        checkedAt: Date.now(),
      },
      seven_day: {
        usedPercent: 2,
        remainingPercent: 98,
        checkedAt: Date.now(),
      },
      checkedAt: Date.now(),
    })

    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await drainSidebarWrites()

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    const state = await getSidebarState()
    expect(state.main.quota?.seven_day?.usedPercent).toBe(2)
    expect(quotaApiCalls).toBe(0)
  })

  test('sidebar state records the actual fallback-first route', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({ routing: { mode: 'fallback-first' } }),
      ),
    )
    if (!testContext.migratedPool)
      throw new Error('Sidebar fixture did not migrate')
    const fixtureRuntime = createNativeAccountRuntime({
      paths: testContext.migratedPool.paths,
      host: 'opencode',
    })
    try {
      expect(
        (await fixtureRuntime.read()).accounts.find(
          (row) => row.id === 'fallback-1',
        )?.quota?.five_hour?.usedPercent,
      ).toBe(25)
    } finally {
      fixtureRuntime.close()
    }

    const authorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0.25 },
                seven_day: { utilization: 0.3 },
              }),
              { status: 200 },
            ),
          )
        }

        authorizations.push(
          new Headers(init?.headers).get('authorization') ?? '',
        )
        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    await drainSidebarWrites()

    const state = await waitForSidebarState(
      (candidate) =>
        candidate.activeId === 'fallback-1' &&
        candidate.route === 'fallback-first' &&
        candidate.fallbacks[0]?.quota?.five_hour?.usedPercent === 25,
    )
    expect(state.route).toBe('fallback-first')
    expect(state.fallbacks[0]?.quota?.five_hour?.usedPercent).toBe(25)
    expect(authorizations[0]).toBe('Bearer sk-ant-oat01-fallback-access')
  })

  test('routes Fable requests to OAuth fallback when main scoped Fable quota is exhausted', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                checkedAt: Date.now(),
              },
              seven_day: {
                usedPercent: 0,
                remainingPercent: 100,
                checkedAt: Date.now(),
              },
              scoped: [
                {
                  id: 'claude-weekly-scoped-fable',
                  title: 'Fable only',
                  modelName: 'Fable',
                  usedPercent: 100,
                  remainingPercent: 0,
                  checkedAt: Date.now(),
                },
              ],
            },
            mainQuotaCheckedAt: Date.now(),
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          } as AccountStorage['quota'],
          accounts: [
            {
              id: 'fallback-1',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: Date.now() + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  checkedAt: Date.now(),
                },
                seven_day: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  checkedAt: Date.now(),
                },
                scoped: [
                  {
                    id: 'claude-weekly-scoped-fable',
                    title: 'Fable only',
                    modelName: 'Fable',
                    usedPercent: 25,
                    remainingPercent: 75,
                    checkedAt: Date.now(),
                  },
                ],
              },
            },
          ],
        }),
      ),
    )

    const authorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  five_hour: { utilization: 0 },
                  seven_day: { utilization: 0 },
                }),
                { status: 200 },
              ),
            )
          }
          authorizations.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )
          return Promise.resolve(new Response(null, { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-fable-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(authorizations).toEqual(['Bearer sk-ant-oat01-fallback-access'])
  })

  test('keeps non-Fable requests on main when only main Fable quota is exhausted', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                checkedAt: Date.now(),
              },
              seven_day: {
                usedPercent: 0,
                remainingPercent: 100,
                checkedAt: Date.now(),
              },
              scoped: [
                {
                  id: 'claude-weekly-scoped-fable',
                  title: 'Fable only',
                  modelName: 'Fable',
                  usedPercent: 100,
                  remainingPercent: 0,
                  checkedAt: Date.now(),
                },
              ],
            },
            mainQuotaCheckedAt: Date.now(),
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          } as AccountStorage['quota'],
        }),
      ),
    )

    const authorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  five_hour: { utilization: 0 },
                  seven_day: { utilization: 0 },
                }),
                { status: 200 },
              ),
            )
          }
          authorizations.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )
          return Promise.resolve(new Response(null, { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(authorizations).toEqual(['Bearer sk-ant-oat01-main-access'])
  })

  test.each([
    { killswitch: false, mode: 'main-first' },
    { killswitch: true, mode: 'main-first' },
    { killswitch: false, mode: 'fallback-first' },
    { killswitch: true, mode: 'fallback-first' },
  ] as const)(
    'does not route API-key fallback for scoped Fable exhaustion alone (%s)',
    async ({ killswitch, mode }) => {
      await useTempAccountFile(
        bindPoolAccounts(
          createFallbackStorage({
            routing: { mode },
            ...(killswitch
              ? {
                  killswitch: {
                    enabled: true,
                    main: { five_hour: 0, seven_day: 0, scoped: 10 },
                  },
                }
              : {}),
            quota: {
              enabled: true,
              checkIntervalMinutes: 5,
              minimumRemaining: { five_hour: 10, seven_day: 20 },
              failClosedOnUnknownQuota: true,
              mainQuota: {
                five_hour: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  checkedAt: Date.now(),
                },
                seven_day: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  checkedAt: Date.now(),
                },
                scoped: [
                  {
                    id: 'claude-weekly-scoped-fable',
                    title: 'Fable only',
                    modelName: 'Fable',
                    usedPercent: 100,
                    remainingPercent: 0,
                    checkedAt: Date.now(),
                  },
                ],
              },
              mainQuotaCheckedAt: Date.now(),
              mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
            } as AccountStorage['quota'],
            accounts: [
              {
                id: 'kie-opus',
                label: 'Kie Opus',
                type: 'api',
                apiKey: 'kie-key',
                baseURL: 'https://api.kie.ai/claude',
                authHeader: 'authorization-bearer',
              },
            ],
          }),
        ),
      )

      const requests: Array<{ url: string; authorization: string | null }> = []
      globalThis.fetch = mock(
        withNativeAdmission(
          (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            const url = extractUrl(input)
            if (url.includes('/api/oauth/usage')) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    five_hour: { utilization: 0 },
                    seven_day: { utilization: 0 },
                  }),
                  { status: 200 },
                ),
              )
            }
            requests.push({
              url,
              authorization: new Headers(init?.headers).get('authorization'),
            })
            return Promise.resolve(new Response(null, { status: 200 }))
          },
        ),
      ) as unknown as typeof fetch

      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth',
            access: 'sk-ant-oat01-main-access',
            refresh: 'main-refresh',
            expires: Date.now() + 100000,
          }),
        { models: {} },
      )

      const response = await result.fetch(MESSAGES_URL, {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-fable-5',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })

      expect(response.status).toBe(killswitch ? 429 : 200)
      if (killswitch) {
        expect(requests).toHaveLength(0)
        return
      }
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        url: 'https://api.anthropic.com/v1/messages?beta=true',
        authorization: 'Bearer sk-ant-oat01-main-access',
      })
    },
  )

  test('refreshes stale scoped Fable exhaustion before skipping main', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                checkedAt: Date.now(),
              },
              seven_day: {
                usedPercent: 0,
                remainingPercent: 100,
                checkedAt: Date.now(),
              },
              scoped: [
                {
                  id: 'claude-weekly-scoped-fable',
                  title: 'Fable only',
                  modelName: 'Fable',
                  usedPercent: 100,
                  remainingPercent: 0,
                  checkedAt: Date.now() - 60 * 60 * 1000,
                },
              ],
            },
            mainQuotaCheckedAt: Date.now() - 60 * 60 * 1000,
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          } as AccountStorage['quota'],
        }),
      ),
    )

    const requests: Array<{ url: string; authorization: string | null }> = []
    let quotaCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage')) {
            quotaCalls++
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  five_hour: { utilization: 0 },
                  seven_day: { utilization: 0 },
                  limits: [
                    {
                      kind: 'weekly_scoped',
                      group: 'weekly',
                      percent: 10,
                      resets_at: null,
                      scope: { model: { id: null, display_name: 'Fable' } },
                    },
                  ],
                }),
                { status: 200 },
              ),
            )
          }
          requests.push({
            url,
            authorization: new Headers(init?.headers).get('authorization'),
          })
          return Promise.resolve(new Response(null, { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-fable-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(quotaCalls).toBe(1)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.authorization).toBe('Bearer sk-ant-oat01-main-access')
  })

  test('killswitch fallback handoff filters exhausted matching scoped model quota', async () => {
    const now = Date.now()
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          killswitch: {
            enabled: true,
            main: { five_hour: 50, seven_day: 20 },
          },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 70,
                remainingPercent: 30,
                checkedAt: now,
              },
              seven_day: {
                usedPercent: 10,
                remainingPercent: 90,
                checkedAt: now,
              },
              scoped: [
                {
                  id: 'claude-weekly-scoped-fable',
                  title: 'Fable only',
                  modelName: 'Fable',
                  usedPercent: 10,
                  remainingPercent: 90,
                  checkedAt: now,
                },
              ],
            },
            mainQuotaCheckedAt: now,
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          } as AccountStorage['quota'],
          accounts: [
            {
              id: 'fallback-empty',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-empty-access',
              refresh: 'fallback-empty-refresh',
              expires: now + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  checkedAt: now,
                },
                seven_day: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  checkedAt: now,
                },
                scoped: [
                  {
                    id: 'claude-weekly-scoped-fable',
                    title: 'Fable only',
                    modelName: 'Fable',
                    usedPercent: 100,
                    remainingPercent: 0,
                    checkedAt: now,
                  },
                ],
              },
            },
            {
              id: 'fallback-ok',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-ok-access',
              refresh: 'fallback-ok-refresh',
              expires: now + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  checkedAt: now,
                },
                seven_day: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  checkedAt: now,
                },
                scoped: [
                  {
                    id: 'claude-weekly-scoped-fable',
                    title: 'Fable only',
                    modelName: 'Fable',
                    usedPercent: 25,
                    remainingPercent: 75,
                    checkedAt: now,
                  },
                ],
              },
            },
          ],
        }),
      ),
    )

    const authorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  five_hour: { utilization: 70 },
                  seven_day: { utilization: 10 },
                  limits: [
                    {
                      kind: 'weekly_scoped',
                      group: 'weekly',
                      percent: 10,
                      resets_at: null,
                      scope: { model: { id: null, display_name: 'Fable' } },
                    },
                  ],
                }),
                { status: 200 },
              ),
            )
          }
          authorizations.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )
          return Promise.resolve(new Response(null, { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-fable-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(authorizations).toEqual(['Bearer sk-ant-oat01-fallback-ok-access'])
  })

  test('does not route to API-key fallback when main OAuth quota is low but not exhausted', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 99,
                remainingPercent: 1,
                checkedAt: Date.now(),
              },
              seven_day: {
                usedPercent: 99,
                remainingPercent: 1,
                checkedAt: Date.now(),
              },
            },
            mainQuotaCheckedAt: Date.now(),
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          } as AccountStorage['quota'],
          accounts: [
            {
              id: 'kie-opus',
              label: 'Kie Opus',
              type: 'api',
              apiKey: 'kie-key',
              baseURL: 'https://api.kie.ai/claude',
              authHeader: 'authorization-bearer',
            },
          ],
        }),
      ),
    )

    const requests: Array<{ url: string; authorization: string | null }> = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = extractUrl(input)
          requests.push({
            url,
            authorization: new Headers(init?.headers).get('authorization'),
          })
          return Promise.resolve(new Response(null, { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(
      'https://api.anthropic.com/v1/messages?beta=true',
    )
    expect(requests[0]?.authorization).toBe('Bearer sk-ant-oat01-main-access')
  })

  test('routes to API-key fallback when cached main OAuth quota is exhausted', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              checkedAt: Date.now(),
              five_hour: {
                usedPercent: 100,
                remainingPercent: 0,
                checkedAt: Date.now(),
              },
              seven_day: {
                usedPercent: 50,
                remainingPercent: 50,
                checkedAt: Date.now(),
              },
            },
            mainQuotaCheckedAt: Date.now(),
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          } as AccountStorage['quota'],
          accounts: [
            {
              id: 'kie-opus',
              label: 'Kie Opus',
              type: 'api',
              apiKey: 'kie-key',
              baseURL: 'https://api.kie.ai/claude',
              authHeader: 'authorization-bearer',
            },
          ],
        }),
      ),
    )

    const requests: Array<{ url: string; authorization: string | null }> = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = extractUrl(input)
          requests.push({
            url,
            authorization: new Headers(init?.headers).get('authorization'),
          })
          return Promise.resolve(new Response(null, { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: 'https://api.kie.ai/claude/v1/messages?beta=true',
      authorization: 'Bearer kie-key',
    })
  })

  test('does not route to API-key fallback from stale cached main OAuth exhaustion', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 100,
                remainingPercent: 0,
                checkedAt: Date.now() - 60 * 60_000,
              },
              seven_day: {
                usedPercent: 50,
                remainingPercent: 50,
                checkedAt: Date.now() - 60 * 60_000,
              },
            },
            mainQuotaCheckedAt: Date.now() - 60 * 60 * 1000,
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          } as AccountStorage['quota'],
          accounts: [
            {
              id: 'kie-opus',
              label: 'Kie Opus',
              type: 'api',
              apiKey: 'kie-key',
              baseURL: 'https://api.kie.ai/claude',
              authHeader: 'authorization-bearer',
            },
          ],
        }),
      ),
    )

    const requests: Array<{ url: string; authorization: string | null }> = []
    let quotaCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage')) {
            quotaCalls++
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  five_hour: { utilization: 10 },
                  seven_day: { utilization: 10 },
                }),
                { status: 200 },
              ),
            )
          }
          requests.push({
            url,
            authorization: new Headers(init?.headers).get('authorization'),
          })
          return Promise.resolve(new Response(null, { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(quotaCalls).toBe(1)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      authorization: 'Bearer sk-ant-oat01-main-access',
    })
  })

  test('does not use API-key route in fallback-first before main quota is exhausted', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
          } as AccountStorage['quota'],
          accounts: [
            {
              id: 'kie-opus',
              label: 'Kie Opus',
              type: 'api',
              apiKey: 'kie-key',
              baseURL: 'https://api.kie.ai/claude',
              authHeader: 'authorization-bearer',
            },
            {
              id: 'fallback-1',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: Date.now() + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 25,
                  remainingPercent: 75,
                  checkedAt: Date.now(),
                },
                seven_day: {
                  usedPercent: 30,
                  remainingPercent: 70,
                  checkedAt: Date.now(),
                },
              },
            },
          ],
        }),
      ),
    )

    const requests: Array<{ url: string; authorization: string | null }> = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  five_hour: { utilization: 10 },
                  seven_day: { utilization: 10 },
                }),
                { status: 200 },
              ),
            )
          }
          requests.push({
            url,
            authorization: new Headers(init?.headers).get('authorization'),
          })
          return Promise.resolve(new Response(null, { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      authorization: 'Bearer sk-ant-oat01-fallback-access',
    })
  })

  test('native turnEndNote settings affect OAuth only, not the API-key proxy fallback', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        quota: {
          enabled: false,
          minimumRemaining: { five_hour: 10 },
          failClosedOnUnknownQuota: true,
        },
        accounts: [
          {
            id: 'paid',
            type: 'api',
            apiKey: 'synthetic-paid',
            baseURL: 'https://proxy.invalid',
            authHeader: 'authorization-bearer',
          },
        ],
      }),
    )
    await updatePoolSettings((settings) => ({
      ...settings,
      turnEndNote: { tools: ['my_cleanup'] },
    }))
    const bodies: any[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        if (extractUrl(input).includes('/api/oauth/usage'))
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 100 },
                seven_day: { utilization: 50 },
              }),
            ),
          )
        bodies.push(JSON.parse(String(init?.body)))
        return Promise.resolve(
          new Response(null, { status: bodies.length === 1 ? 429 : 200 }),
        )
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-5-5',
        messages: [
          { role: 'user', content: 'Question' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'A'.repeat(350) },
              { type: 'tool_use', name: 'my_cleanup', id: 'a', input: {} },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'a', content: 'Done' },
            ],
          },
        ],
      }),
    })
    expect(bodies).toHaveLength(2)
    expect(bodies[0].messages.at(-1)).toMatchObject({
      role: 'system',
      clear_at: 'next_user_message',
    })
    expect(bodies[1].messages).toHaveLength(3)
    expect(bodies[1].messages.at(-1).role).toBe('user')
  })

  test('routes to API-key fallback after main OAuth returns 429 and strips server fallback fields from the custom provider request', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE
    await useTempAccountFile(
      createFallbackStorage({
        quota: {
          enabled: false,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: true,
        } as AccountStorage['quota'],
        accounts: [
          {
            id: 'kie-opus',
            label: 'Kie Opus',
            type: 'api',
            apiKey: 'kie-key',
            baseURL: 'https://api.kie.ai/claude',
            authHeader: 'authorization-bearer',
          },
        ],
      }),
    )

    const requests: Array<{
      url: string
      authorization: string | null
      beta: string | null
      body: Record<string, unknown>
    }> = []
    let quotaCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        const headers = new Headers(init?.headers)
        const authorization = headers.get('authorization')
        if (url.includes('/api/oauth/usage')) {
          quotaCalls++
          expect(authorization).toBe('Bearer sk-ant-oat01-main-access')
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 100 },
                seven_day: { utilization: 50 },
              }),
              { status: 200 },
            ),
          )
        }
        requests.push({
          url,
          authorization,
          beta: headers.get('anthropic-beta'),
          body: JSON.parse(String(init?.body)),
        })
        if (requests.length === 1) {
          return Promise.resolve(
            new Response('main exhausted', { status: 429 }),
          )
        }
        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-fable-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(response.status).toBe(200)
    expect(quotaCalls).toBe(1)
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      authorization: 'Bearer sk-ant-oat01-main-access',
      body: expect.objectContaining({ fallbacks: 'default' }),
    })
    expect(requests[0]?.beta?.split(',')).toContain(SERVER_SIDE_FALLBACK_BETA)
    expect(requests[1]).toMatchObject({
      url: 'https://api.kie.ai/claude/v1/messages?beta=true',
      authorization: 'Bearer kie-key',
    })
    expect(requests[1]?.body).not.toHaveProperty('fallbacks')
    expect(requests[1]?.beta?.split(',')).not.toContain(
      SERVER_SIDE_FALLBACK_BETA,
    )
  })

  test('does not route to API-key fallback after main 429 when quota does not confirm exhaustion', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        quota: {
          enabled: false,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: true,
        } as AccountStorage['quota'],
        accounts: [
          {
            id: 'kie-opus',
            label: 'Kie Opus',
            type: 'api',
            apiKey: 'kie-key',
            baseURL: 'https://api.kie.ai/claude',
            authHeader: 'authorization-bearer',
          },
        ],
      }),
    )

    const requests: Array<{ url: string; authorization: string | null }> = []
    let quotaCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        const authorization = new Headers(init?.headers).get('authorization')
        if (url.includes('/api/oauth/usage')) {
          quotaCalls++
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0.25 },
                seven_day: { utilization: 0.25 },
              }),
              { status: 200 },
            ),
          )
        }
        requests.push({ url, authorization })
        return Promise.resolve(
          new Response('transient rate limit', { status: 429 }),
        )
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(response.status).toBe(429)
    expect(quotaCalls).toBe(1)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      authorization: 'Bearer sk-ant-oat01-main-access',
    })
  })

  test('does not route to API-key fallback after non-quota main OAuth fallback status', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        quota: {
          enabled: false,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: true,
        } as AccountStorage['quota'],
        accounts: [
          {
            id: 'kie-opus',
            label: 'Kie Opus',
            type: 'api',
            apiKey: 'kie-key',
            baseURL: 'https://api.kie.ai/claude',
            authHeader: 'authorization-bearer',
          },
        ],
      }),
    )

    const requests: Array<{ url: string; authorization: string | null }> = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        requests.push({
          url: extractUrl(input),
          authorization: new Headers(init?.headers).get('authorization'),
        })
        return Promise.resolve(new Response('auth failure', { status: 403 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(response.status).toBe(403)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      authorization: 'Bearer sk-ant-oat01-main-access',
    })
  })

  for (const bound of [true, false]) {
    test(
      bound
        ? 'fallback-first reuses migrated account-bound main quota for sidebar without refetching'
        : 'fallback-first refuses legacy main quota attributed only to an old access token',
      async () => {
        const checkedAt = Date.now()
        const storage = createFallbackStorage({
          routing: { mode: 'fallback-first' },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: { usedPercent: 6, remainingPercent: 94, checkedAt },
              seven_day: { usedPercent: 75, remainingPercent: 25, checkedAt },
              checkedAt,
            },
            mainQuotaCheckedAt: checkedAt,
          },
        })
        for (const account of storage.accounts) {
          if (account.type !== 'oauth') continue
          account.expires = checkedAt + 8 * 60 * 60_000
          account.quota = {
            checkedAt,
            five_hour: { usedPercent: 30, remainingPercent: 70, checkedAt },
            seven_day: { usedPercent: 40, remainingPercent: 60, checkedAt },
          }
        }
        bindPoolAccounts(storage)
        if (!bound && storage.quota?.mainQuota) {
          storage.quota.mainQuota.accountIdentity = undefined
          storage.quota.mainQuotaToken = tokenFingerprint('old-main-access')
        }
        await useTempAccountFile(storage)
        const imported = await readNativeRuntimeState()
        expect(imported.main?.accountIdentity).toBe(syntheticMainAccountUuid)
        if (bound)
          expect(imported.main?.quota).toMatchObject({
            accountIdentity: syntheticMainAccountUuid,
            five_hour: { usedPercent: 6 },
            seven_day: { usedPercent: 75 },
          })
        else expect(imported.main?.quota).toBeUndefined()

        const authorizations: string[] = []
        let mainQuotaCalls = 0
        globalThis.fetch = mock(
          withNativeAdmission(
            (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
              const url = extractUrl(input)
              if (url.includes('/api/oauth/usage')) {
                mainQuotaCalls++
                expect(new Headers(init?.headers).get('authorization')).toBe(
                  'Bearer sk-ant-oat01-main-access',
                )
                return Promise.resolve(
                  new Response(
                    JSON.stringify({
                      five_hour: { utilization: 12 },
                      seven_day: { utilization: 34 },
                    }),
                    { status: 200 },
                  ),
                )
              }

              authorizations.push(
                new Headers(init?.headers).get('authorization') ?? '',
              )
              return Promise.resolve(new Response(null, { status: 200 }))
            },
          ),
        ) as unknown as typeof fetch

        const plugin = await getPlugin()
        const result = await plugin.auth.loader(
          () =>
            Promise.resolve({
              type: 'oauth',
              access: 'sk-ant-oat01-main-access',
              refresh: 'main-refresh',
              expires: Date.now() + 100000,
            }),
          { models: {} },
        )

        await result.fetch(MESSAGES_URL, {
          method: 'POST',
          body: JSON.stringify({
            model: 'claude-opus-4-8',
            messages: [{ role: 'user', content: 'hello' }],
          }),
        })

        const state = await waitForSidebarState(
          (candidate) =>
            candidate.activeId === 'fallback-1' &&
            (bound
              ? candidate.main.quota?.five_hour?.usedPercent === 6
              : candidate.main.quota === null),
        )
        expect(state.route).toBe('fallback-first')
        if (bound) expect(state.main.quota?.seven_day?.usedPercent).toBe(75)
        else expect(state.main.quota).toBeNull()
        expect(mainQuotaCalls).toBe(0)
        expect(authorizations[0]).toBe('Bearer sk-ant-oat01-fallback-access')
      },
    )
  }

  test('registers /claude and handles cache settings with ignored status replies', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, testContext.tempConfigDir)
    const config: { command?: Record<string, unknown> } = {}

    await plugin.config(config)

    expect(config.command?.claude).toMatchObject({
      template: 'claude',
      description: expect.stringContaining('Claude accounts'),
    })
    for (const command of COMMAND_MODAL_NAMES) {
      expect(config.command?.[command]).toBeUndefined()
    }

    // The menu action's reply is the apply result the TUI shows.
    const enabled = await applyMenuAction(plugin, 'session-menu', {
      sectionId: 'Cache',
      actionId: 'cache-on',
    })
    expect(enabled.ok).toBe(true)
    expect(enabled.text).toContain('## Claude Cache Enabled')

    // Without a connected TUI, /claude replies with an ignored status message.
    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(latestIgnoredReply(mockClient)).toContain('- Enabled: enabled')

    expect((await readNativeSettings()).claudeCache).toEqual({
      enabled: true,
      mode: 'explicit',
    })
  })

  /**
   * Plugin timers that hold back only the two-second wait /claude makes for a
   * TUI to take its menu; every other timer runs for real. The test decides
   * when that wait expires, so no real time has to pass.
   */
  function heldTuiPickupTimers() {
    const held = new Map<object, () => void>()
    let started = Promise.withResolvers<void>()
    const setTimeoutImpl = ((
      handler: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay !== 2_000) return globalThis.setTimeout(handler, delay, ...args)
      const handle = {}
      held.set(handle, () => handler(...args))
      started.resolve()
      return handle
    }) as unknown as typeof setTimeout
    const clearTimeoutImpl = ((handle: ReturnType<typeof setTimeout>) => {
      if (!held.delete(handle as unknown as object))
        globalThis.clearTimeout(handle)
    }) as unknown as typeof clearTimeout
    return {
      // The default wait applies; the shared test overrides set it to zero.
      overrides: {
        setTimeout: setTimeoutImpl,
        clearTimeout: clearTimeoutImpl,
        tuiPickupTimeoutMs: undefined,
      } as PluginRuntimeOverrides,
      /** Resolves once /claude has started waiting for a TUI. */
      async started() {
        await started.promise
        started = Promise.withResolvers<void>()
      },
      get waiting() {
        return held.size
      },
      expire() {
        for (const [handle, run] of [...held]) {
          held.delete(handle)
          run()
        }
      },
    }
  }

  /** Ignored chat replies that carry the missing-TUI notice. */
  function missingTuiNotices(client: ReturnType<typeof createMockClient>) {
    const calls = (
      client.session.promptAsync as unknown as {
        mock: {
          calls: Array<[{ body: { parts: Array<{ text: string }> } }]>
        }
      }
    ).mock.calls
    return calls
      .map((call) => call[0]?.body.parts[0]?.text ?? '')
      .filter((text) => text.includes('tui.json'))
  }

  test('/claude with no TUI says once per session how to add the TUI part, and a later TUI poll restores the menu', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const timers = heldTuiPickupTimers()
    const plugin = await getPlugin(mockClient, undefined, timers.overrides)
    const sessionID = 'session-no-tui'
    const runClaude = () =>
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID,
      })
    const textReplies = () =>
      (
        mockClient.session.promptAsync as unknown as {
          mock: { calls: unknown[] }
        }
      ).mock.calls.length
    const { version } = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string }

    const handled = runClaude()
    handled.catch(() => {})
    await timers.started()
    expect(missingTuiNotices(mockClient)).toEqual([])

    timers.expire()
    await expectHandledCommandResponse(handled)

    const notices = missingTuiNotices(mockClient)
    expect(notices).toHaveLength(1)
    const [notice = ''] = notices
    expect(latestIgnoredReply(mockClient)).toBe(notice)
    expect(notice).toContain(`"@cortexkit/opencode-anthropic-auth@${version}"`)
    expect(notice).toContain('restart OpenCode')
    expect(notice).toContain('In OpenCode Desktop, use the text menu below.')
    // The read-only menu text still follows the notice.
    expect(notice).toContain('## Cache')

    // The same session again: no wait and no second notice, only the menu.
    await expectHandledCommandResponse(runClaude())
    expect(timers.waiting).toBe(0)
    expect(textReplies()).toBe(2)
    expect(missingTuiNotices(mockClient)).toHaveLength(1)
    expect(latestIgnoredReply(mockClient)).toContain('## Cache')

    // A TUI that starts polling now finds no stale menu from either call...
    expect(drainNotifications(0, sessionID)).toEqual([])
    // ...and gets the next /claude as a dialog, with no chat reply.
    await expectHandledCommandResponse(runClaude())
    expect(drainNotifications(0, sessionID).at(-1)?.type).toBe('open-menu')
    expect(textReplies()).toBe(2)
  })

  test('/claude in OpenCode Desktop replies with the text menu at once, without the TUI notice', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const timers = heldTuiPickupTimers()
    const plugin = await getPlugin(mockClient, undefined, timers.overrides)
    const sessionID = 'session-desktop'
    const saved = process.env.OPENCODE_CLIENT
    // OpenCode Desktop starts its server with this variable set.
    process.env.OPENCODE_CLIENT = 'desktop'
    try {
      await expectHandledCommandResponse(
        plugin['command.execute.before']({
          command: 'claude',
          arguments: '',
          sessionID,
        }),
      )
    } finally {
      if (saved === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = saved
    }
    expect(timers.waiting).toBe(0)
    expect(latestIgnoredReply(mockClient)).toContain('## Cache')
    expect(missingTuiNotices(mockClient)).toEqual([])
    expect(drainNotifications(0, sessionID)).toEqual([])
  })

  test('/claude queues its menu for a polling TUI that drains late, with no notice', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const timers = heldTuiPickupTimers()
    const plugin = await getPlugin(mockClient, undefined, timers.overrides)
    const sessionID = 'session-busy-tui'

    // The TUI polled this session recently, so it counts as connected even
    // though it does not take the menu until after the wait would have ended.
    drainNotifications(0, sessionID)
    await expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID,
      }),
    )
    expect(timers.waiting).toBe(0)
    timers.expire()

    const notice = drainNotifications(0, sessionID).at(-1)
    expect(notice?.type).toBe('open-menu')
    expect(missingTuiNotices(mockClient)).toEqual([])
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()
  })

  test('/claude hands its menu to a TUI that first polls during the wait, with no notice', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const timers = heldTuiPickupTimers()
    const plugin = await getPlugin(mockClient, undefined, timers.overrides)
    const sessionID = 'session-starting-tui'

    const handled = plugin['command.execute.before']({
      command: 'claude',
      arguments: '',
      sessionID,
    })
    handled.catch(() => {})
    await timers.started()
    // A TUI that has just started polls before the two seconds are up.
    const notice = drainNotifications(0, sessionID).at(-1)
    await expectHandledCommandResponse(handled)

    expect(notice?.type).toBe('open-menu')
    expect(timers.waiting).toBe(0)
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()
  })

  test('config hook registers only /claude and retires owned aliases without clobbering foreign commands', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const plugin = await getPlugin()
    const preExisting = { template: 'other-plugin-cmd', description: 'foreign' }
    const result: { command?: Record<string, unknown> } = {
      command: {
        'other-plugin-cmd': preExisting,
        ...Object.fromEntries(
          COMMAND_MODAL_NAMES.map((name) => [
            name,
            {
              template: name,
              description: 'previous plugin registration',
            },
          ]),
        ),
      },
    }
    await plugin.config(result)

    expect(result.command?.['other-plugin-cmd']).toEqual(preExisting)
    expect(result.command?.claude).toMatchObject({ template: 'claude' })
    for (const name of COMMAND_MODAL_NAMES) {
      expect(result.command?.[name]).toBeUndefined()
    }
    expect(Object.keys(result.command ?? {}).sort()).toEqual([
      'claude',
      'other-plugin-cmd',
    ])
    await plugin.dispose?.()
  })

  test('handles /claude-start by injecting one visible synthetic prompt', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, testContext.tempConfigDir)

    const result = await applyMenuAction(plugin, 'session-start', {
      sectionId: 'Extras',
      actionId: 'start-fire',
    })
    expect(result.ok).toBe(true)

    const promptCalls = (
      mockClient.session.promptAsync as unknown as {
        mock: {
          calls: Array<[{ body: { parts: Array<Record<string, unknown>> } }]>
        }
      }
    ).mock.calls as Array<
      [
        {
          path: { id: string }
          body: { noReply: boolean; parts: Array<Record<string, unknown>> }
        },
      ]
    >
    const startCall = promptCalls
      .map(([call]) => call)
      .find((call) => call.body.parts[0]?.synthetic === true)
    expect(startCall).toEqual({
      path: { id: 'session-start' },
      body: {
        noReply: false,
        parts: [
          {
            type: 'text',
            text: '[lane start] — automated cache warm; no response needed.',
            synthetic: true,
          },
        ],
      },
    })
  })

  test('handles /claude-cachekeep command and persists window', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: true, mode: 'hybrid' },
      }),
    )
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, testContext.tempConfigDir)

    const windowed = await applyMenuAction(plugin, 'session-1', {
      sectionId: 'Cache',
      actionId: 'cachekeep-window',
      values: { startHour: 9, endHour: 23 },
    })
    expect(windowed.ok).toBe(true)
    expect(windowed.text).toContain('## Claude Cache Keep Enabled')
    expect(windowed.text).toContain('Schedule: 09-23')
    expect(windowed.text).toContain('Hybrid active: yes')

    expect((await readNativeSettings()).cacheKeep).toEqual({
      enabled: true,
      always: false,
      startHour: 9,
      endHour: 23,
    })

    const always = await applyMenuAction(plugin, 'session-1', {
      sectionId: 'Cache',
      actionId: 'cachekeep-always',
    })
    expect(always.ok).toBe(true)
    expect((await readNativeSettings()).cacheKeep).toEqual({
      enabled: true,
      always: true,
    })
  })

  test('registers and handles /claude-fast slash command with ignored status replies', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, testContext.tempConfigDir)

    // The menu action's reply is the apply result the TUI shows.
    const enabled = await applyMenuAction(plugin, 'session-menu', {
      sectionId: 'Extras',
      actionId: 'fast-on',
    })
    expect(enabled.ok).toBe(true)
    expect(enabled.text).toContain('## Claude Fast Mode Enabled')

    // Without a connected TUI, /claude replies with an ignored status message.
    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(latestIgnoredReply(mockClient)).toContain('- Enabled: enabled')

    expect((await readNativeSettings()).claudeFast).toEqual({ enabled: true })
  })

  test('handles /claude-routing slash command and persists routing mode', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, testContext.tempConfigDir)

    const updated = await applyMenuAction(plugin, 'session-menu', {
      sectionId: 'Routing',
      actionId: 'routing-mode',
      values: { mode: 'sticky-balanced' },
    })
    expect(updated.ok).toBe(true)
    expect(updated.text).toContain('Mode updated to `sticky-balanced`.')

    // Without a connected TUI, /claude replies with an ignored status message.
    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
    expect(latestIgnoredReply(mockClient)).toContain(
      '- Mode: `sticky-balanced`',
    )

    const reset = await applyMenuAction(plugin, 'session-menu', {
      sectionId: 'Routing',
      actionId: 'routing-reset',
    })
    expect(reset.ok).toBe(true)
    expect(reset.text).toContain('Claude Routing Assignment Reset')

    expect((await readNativeSettings()).routing).toEqual({
      mode: 'sticky-balanced',
    })
  })

  test('hidden slash-command replies preserve previous assistant model and variant', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient([
      {
        info: {
          role: 'user',
          agent: 'Default Agent',
          model: {
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4-6',
            variant: 'low',
          },
        },
      },
      {
        info: {
          role: 'assistant',
          agent: 'Alfonso - CTO',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-7',
          variant: 'xhigh',
        },
      },
    ])
    const plugin = await getPlugin(mockClient)

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(mockClient.session.messages).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      query: { limit: 100 },
    })
    expect(mockClient.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      body: {
        noReply: true,
        agent: 'Alfonso - CTO',
        model: {
          providerID: 'anthropic',
          modelID: 'claude-opus-4-7',
        },
        variant: 'xhigh',
        parts: [
          {
            type: 'text',
            ignored: true,
            text: expect.stringContaining('## Claude Cache'),
          },
        ],
      },
    })
  })

  test('handles /claude-dump slash command and persists dump capture', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, testContext.tempConfigDir)

    const result = await applyMenuAction(plugin, 'session-1', {
      sectionId: 'Diagnostics',
      actionId: 'dump-on',
    })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('## Claude Dump Enabled')

    expect((await readNativeSettings()).dump).toEqual({ enabled: true })
  })

  test('handles /claude-cache mode command and persists cache strategy', async () => {
    await useTempAccountFile(
      createFallbackStorage({ accounts: [], claudeCache: { enabled: true } }),
    )
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, testContext.tempConfigDir)

    const result = await applyMenuAction(plugin, 'session-1', {
      sectionId: 'Cache',
      actionId: 'cache-mode',
      values: { mode: 'hybrid' },
    })

    expect((await readNativeSettings()).claudeCache).toEqual({
      enabled: true,
      mode: 'hybrid',
    })

    expect(result.ok).toBe(true)
    expect(result.text).toContain('Mode updated to `hybrid`.')
  })

  test('persistent cache, dump, fast and logging replies show the selected settings file', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const plugin = await getPlugin(undefined, testContext.tempConfigDir)
    const settingsPath = testContext.migratedPool!.paths.config
    const actions = [
      { sectionId: 'Cache', actionId: 'cache-on' },
      { sectionId: 'Diagnostics', actionId: 'dump-on' },
      { sectionId: 'Extras', actionId: 'fast-on' },
      {
        sectionId: 'Diagnostics',
        actionId: 'logging-level',
        values: { level: 'debug' },
      },
    ] as const

    for (const action of actions) {
      const result = await applyMenuAction(plugin, 'settings-path', action)
      expect(result.text).toContain(`- Persisted: ${settingsPath}`)
    }
  })

  test('native quota status works before the host auth loader has run', async () => {
    const checkedAt = Date.now()
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: false,
            mainQuota: {
              accountIdentity: syntheticMainAccountUuid,
              checkedAt,
              five_hour: { usedPercent: 25, remainingPercent: 75, checkedAt },
              seven_day: { usedPercent: 50, remainingPercent: 50, checkedAt },
            },
            mainQuotaCheckedAt: checkedAt,
          },
        }),
      ),
    )
    let fetchCalls = 0
    globalThis.fetch = Object.assign(
      mock(async () => {
        fetchCalls++
        throw new Error('Unexpected network call during cached native status')
      }),
      { preconnect() {} },
    )
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(mockClient.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      body: {
        noReply: true,
        parts: [
          {
            type: 'text',
            ignored: true,
            text: expect.stringContaining('5h 75% left'),
          },
        ],
      },
    })
    expect(fetchCalls).toBe(0)
  })

  test('native quota refresh shows live main and fallback quotas', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          quota: { enabled: false },
          accounts: [
            {
              id: 'fallback-1',
              label: 'fallback personal',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: Date.now() + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 99,
                  remainingPercent: 1,
                  checkedAt: 1,
                },
                seven_day: {
                  usedPercent: 99,
                  remainingPercent: 1,
                  checkedAt: 1,
                },
              },
            },
          ],
        }),
      ),
    )
    const mockClient = createMockClient()
    const seenTokens: string[] = []

    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          if (url.includes('/api/oauth/usage')) {
            const authorization = new Headers(init?.headers).get(
              'authorization',
            )
            if (authorization) seenTokens.push(authorization)
            const utilization =
              authorization === 'Bearer sk-ant-oat01-main-access' ? 25 : 40
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  five_hour: { utilization },
                  seven_day: {
                    utilization:
                      authorization === 'Bearer sk-ant-oat01-main-access'
                        ? 50
                        : 60,
                  },
                }),
                { status: 200 },
              ),
            )
          }

          return Promise.resolve(new Response('{}', { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient, testContext.tempConfigDir)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    const refreshed = await applyMenuAction(plugin, 'session-1', {
      sectionId: 'Quota',
      actionId: 'quota-refresh',
    })
    expect(refreshed.ok).toBe(true)
    const freshState = await readNativeRuntimeState()
    expect(freshState.main?.quota?.five_hour?.usedPercent).toBe(25)
    expect(
      freshState.accounts['fallback-1']?.quota?.five_hour?.usedPercent,
    ).toBe(40)
    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
    expect(seenTokens.toSorted()).toEqual([
      'Bearer sk-ant-oat01-fallback-access',
      'Bearer sk-ant-oat01-main-access',
    ])
    // applyMenuAction opens a TUI-connected menu. Inspect its current
    // payload, not the earlier headless notice sent before the refresh.
    const currentMenu = await openClaudeMenu(plugin, 'session-1')
    const text = JSON.stringify(currentMenu)
    expect(refreshed.text).toContain('5h 75% left')
    expect(text).toContain('## Claude Quotas')
    expect(text).toContain('### OpenCode anthropic (main)')
    expect(text).toContain('### fallback personal (fallback)')
    expect(text).toContain('5h 75% left')
    expect(text).toContain('7d 50% left')
  })

  test('/claude-quota bounds stalled profile hydration without hiding quota output', async () => {
    const checkedAt = Date.now()
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          main: {
            type: 'opencode',
            provider: 'anthropic',
            profile: {
              checkedAt: checkedAt - 8 * 24 * 60 * 60_000,
              tier: 'default_claude_free',
              orgType: 'claude_free',
            },
          },
          quota: {
            enabled: true,
            mainQuota: {
              five_hour: { usedPercent: 25, remainingPercent: 75, checkedAt },
              seven_day: { usedPercent: 50, remainingPercent: 50, checkedAt },
              checkedAt,
            },
          },
        }),
      ),
    )
    const mockClient = createMockClient()
    let profileSignal: AbortSignal | undefined
    let usageCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/profile')) {
            profileSignal = init?.signal ?? undefined
            return new Promise<Response>((_resolve, reject) => {
              profileSignal?.addEventListener(
                'abort',
                () => reject(profileSignal?.reason),
                { once: true },
              )
            })
          }
          if (url.includes('/api/oauth/usage')) {
            usageCalls++
            return Promise.resolve(
              Response.json({
                five_hour: { utilization: 25 },
                seven_day: { utilization: 50 },
              }),
            )
          }
          return Promise.resolve(new Response('ok'))
        },
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    const startedAt = performance.now()
    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(performance.now() - startedAt).toBeLessThan(4_000)
    expect(profileSignal?.aborted).toBe(true)
    expect(usageCalls).toBe(0)
    const text = (mockClient.session.promptAsync as any).mock.calls.at(-1)?.[0]
      ?.body.parts[0]?.text as string
    expect(text).toContain('## Claude Quotas')
    expect(text).toContain('5h 75% left')
    expect(text).not.toContain('Max 20x')
  }, 5_000)

  test('/claude-quota renders hydrated profile without waiting for profile persistence', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/profile')) {
          profileCalls++
          return Promise.resolve(
            Response.json({
              organization: {
                organization_type: 'claude_max',
                rate_limit_tier: 'default_claude_max_20x',
              },
            }),
          )
        }
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            Response.json({
              five_hour: { utilization: 25 },
              seven_day: { utilization: 50 },
            }),
          )
        }
        return Promise.resolve(new Response('ok'))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    const pool = testContext.migratedPool
    if (!pool) throw new Error('Expected migrated pool')
    const reader = createNativeAccountRuntime({
      paths: pool.paths,
      host: 'opencode',
    })
    try {
      expect((await reader.authorizeLocal('main')).status).toBe('usable')
    } finally {
      reader.close()
    }
    const locked = bodyLifetime().gate()
    const release = bodyLifetime().gate()
    // Hold the profile's runtime-file lock after credential validation.
    // Status must display the fetched tier without waiting for this writer.
    const writer = withLock(
      pool.paths.runtime,
      {
        name: 'native-runtime',
        ttlMs: 10_000,
        timeoutMs: 15_000,
        renew: true,
      },
      async () => {
        locked.open()
        await release.wait
      },
    )
    bodyLifetime().trackDetached(writer)
    await locked.wait

    const command = expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    )
    let lockReleased = false
    void release.wait.then(() => {
      lockReleased = true
    })
    try {
      // Only teardown opens the release gate before this point. A status that
      // waited for the held writer (whose lock wait outlasts this test)
      // would complete only after teardown frees the lock. Waiting for the
      // command itself, not for a fixed time, keeps this independent of
      // machine speed.
      const rendered = await command.then(() => !lockReleased)

      expect(rendered).toBe(true)
      expect(profileCalls).toBe(1)
      const text = (mockClient.session.promptAsync as any).mock.calls.at(
        -1,
      )?.[0]?.body.parts[0]?.text as string
      expect(text).toContain('Max 20x')
      expect((await readAccountStorage())?.main?.profile).toBeUndefined()
    } finally {
      release.open()
      await writer
      await command
    }

    const persistedStorage = await waitForAccountStorage(
      (storage) => storage?.main?.profile?.tier === 'default_claude_max_20x',
    )
    expect(persistedStorage?.main?.profile?.tier).toBe('default_claude_max_20x')
  })

  test('profile fetch runs once per account per boot and persists the result', async () => {
    await useTempAccountFile(createFallbackStorage())
    const mockClient = createMockClient()
    const profileCalls: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          const auth = new Headers(init?.headers).get('authorization') ?? ''
          if (url.includes('/api/oauth/profile')) {
            profileCalls.push(auth)
            return Promise.resolve(
              Response.json({
                organization: {
                  organization_type: auth.includes('fallback')
                    ? 'claude_team'
                    : 'claude_max',
                  rate_limit_tier: auth.includes('fallback')
                    ? 'default_claude_max_5x'
                    : 'default_claude_max_20x',
                },
              }),
            )
          }
          if (url.includes('/api/oauth/usage')) {
            return Promise.resolve(
              Response.json({
                five_hour: { utilization: 10 },
                seven_day: { utilization: 20 },
              }),
            )
          }
          return Promise.resolve(new Response('ok'))
        },
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    for (let call = 0; call < 2; call++) {
      await expect(
        plugin['command.execute.before']({
          command: 'claude',
          arguments: '',
          sessionID: 'session-1',
        }),
      ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
      if (call === 0) {
        await waitForAccountStorage(
          (storage) =>
            storage?.main?.profile?.tier === 'default_claude_max_20x' &&
            (storage.accounts[0] as OAuthAccount | undefined)?.profile?.tier ===
              'default_claude_max_5x',
        )
      }
    }

    // Independent account hydration may finish in either order. Require
    // exactly one request per account, including after the second status read.
    expect(profileCalls.toSorted()).toEqual([
      'Bearer sk-ant-oat01-fallback-access',
      'Bearer sk-ant-oat01-main-access',
    ])
    const loaded = await readAccountStorage()
    expect(loaded?.main?.profile?.tier).toBe('default_claude_max_20x')
    expect((loaded?.accounts[0] as any)?.profile?.tier).toBe(
      'default_claude_max_5x',
    )
    const text = (mockClient.session.promptAsync as any).mock.calls.at(-1)?.[0]
      ?.body.parts[0]?.text as string
    expect(text).toContain('Max 20x')
    expect(text).toContain('Max 5x')
  })

  test('fresh profile under seven days skips fetch', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        main: {
          type: 'opencode',
          provider: 'anthropic',
          profile: {
            tier: 'default_claude_max_20x',
            orgType: 'claude_max',
            checkedAt: Date.now(),
            tokenFingerprint: tokenFingerprint('sk-ant-oat01-main-access'),
          },
        },
      }),
    )
    let profileCalls = 0
    globalThis.fetch = mock((input: string | URL | Request) => {
      if (extractUrl(input).includes('/api/oauth/profile')) profileCalls++
      return Promise.resolve(
        Response.json({
          five_hour: { utilization: 10 },
          seven_day: { utilization: 20 },
        }),
      )
    }) as unknown as typeof fetch
    const plugin = await getPlugin(createMockClient())
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(profileCalls).toBe(0)
  })

  test('unbound legacy profile is not adopted by a different credential', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        main: {
          type: 'opencode',
          provider: 'anthropic',
          profile: {
            tier: 'default_claude_max_20x',
            orgType: 'claude_max',
            checkedAt: Date.now(),
            tokenFingerprint: tokenFingerprint('sk-ant-oat01-old-access'),
          },
        },
      }),
      {
        access: 'sk-ant-oat01-new-access',
        refresh: 'new-refresh',
        expires: Date.now() + 100000,
      },
    )
    const mockClient = createMockClient()
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) =>
        Promise.resolve(
          (() => {
            if (extractUrl(input).includes('/api/oauth/profile')) {
              profileCalls++
              return new Response('failed', { status: 500 })
            }
            return new Response('ok')
          })(),
        ),
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-new-access',
          refresh: 'new-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
    const text = (mockClient.session.promptAsync as any).mock.calls.at(-1)?.[0]
      ?.body.parts[0]?.text

    // An old access-token fingerprint cannot prove the replacement account's
    // tier. A failed fresh lookup must not restore that unclaimed profile.
    expect(text).not.toContain('Max 20x')
    expect(profileCalls).toBe(1)
    expect((await readAccountStorage())?.main?.profile).toBeUndefined()
  })

  test('in-flight hydration is shared across access-token rotation', async () => {
    const firstLogin = {
      access: 'sk-ant-oat01-token-a',
      refresh: 'refresh-sk-ant-oat01-token-a',
      expires: Date.now() + 100000,
    }
    await useTempAccountFile(
      createFallbackStorage({ accounts: [] }),
      firstLogin,
    )
    const mockClient = createMockClient()
    let profileCalls = 0
    const firstProfile = heldResponse()
    const profileStarted = lifetimeSignal()
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (!extractUrl(input).includes('/api/oauth/profile')) {
          return Promise.resolve(new Response('ok'))
        }
        profileCalls++
        if (profileCalls === 1) {
          profileStarted.raise()
          return firstProfile.response
        }
        return Promise.resolve(
          Response.json({
            organization: {
              organization_type: 'claude_team',
              rate_limit_tier: 'default_claude_max_5x',
            },
          }),
        )
      }),
    ) as unknown as typeof fetch
    // The main login has served before, so the pool already knows which
    // account it belongs to; a refresh elsewhere then stays on that account.
    await poolMainAccess()
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth', ...firstLogin }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    const firstCommand = expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    )
    await profileStarted.raised

    // Another OpenCode process refreshes the main login while the first
    // profile request is still in flight.
    await refreshPoolMainElsewhere({
      access: 'sk-ant-oat01-token-b',
      refresh: 'refresh-sk-ant-oat01-token-b',
      expires: Date.now() + 100000,
    })
    const command = expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    )
    await Bun.sleep(25)
    firstProfile.release(
      Response.json({
        organization: {
          organization_type: 'claude_team',
          rate_limit_tier: 'default_claude_max_5x',
        },
      }),
    )
    await firstCommand
    await command

    expect(profileCalls).toBe(1)
  })

  test('same main token keeps a fresh bound profile without refetching', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        main: {
          type: 'opencode',
          provider: 'anthropic',
          profile: {
            accountIdentity: syntheticMainAccountUuid,
            providerAccountUuid: syntheticMainAccountUuid,
            tier: 'default_claude_max_20x',
            orgType: 'claude_max',
            checkedAt: Date.now(),
            tokenFingerprint: tokenFingerprint('sk-ant-oat01-main-access'),
          },
        },
      }),
    )
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) profileCalls++
        return Promise.resolve(new Response('ok'))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(createMockClient())
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(profileCalls).toBe(0)
    expect((await readAccountStorage())?.main?.profile?.tier).toBe(
      'default_claude_max_20x',
    )
  })

  test('boot profile hydration publishes tier labels to the sidebar', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    expect(
      process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION,
    ).toBeUndefined()
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) {
          profileCalls++
          return Promise.resolve(
            Response.json({
              organization: {
                organization_type: 'claude_max',
                rate_limit_tier: 'default_claude_max_20x',
              },
            }),
          )
        }
        return Promise.resolve(new Response('ok'))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()

    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const state = await waitForSidebarState(
      (value) => value.main.tierLabel === 'Max 20x',
    )

    expect(state.main.tierLabel).toBe('Max 20x')
    expect(profileCalls).toBe(1)
  })

  test('late fallback profile hydration cannot restore rotated credentials', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await useTempAccountFile(
      createFallbackStorage({
        quota: { enabled: false },
        main: {
          type: 'opencode',
          provider: 'anthropic',
          profile: {
            accountIdentity: syntheticMainAccountUuid,
            providerAccountUuid: syntheticMainAccountUuid,
            tier: 'default_claude_max_20x',
            orgType: 'claude_max',
            checkedAt: Date.now(),
            tokenFingerprint: tokenFingerprint('sk-ant-oat01-main-access'),
          },
        },
        accounts: [
          {
            id: 'fb',
            type: 'oauth',
            access: 'sk-ant-oat01-old-access',
            refresh: 'old-refresh',
            expires: Date.now() + 5 * 60 * 60 * 1000,
            lastRefreshedAt: 100,
          },
        ],
      }),
    )
    const profile = heldResponse()
    const profileStarted = lifetimeSignal()
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) {
          profileCalls++
          profileStarted.raise()
          return profile.response
        }
        return Promise.resolve(new Response('ok'))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100_000,
        }),
      { models: {} },
    )
    await profileStarted.raised
    await drainSidebarWrites()

    const pool = testContext.migratedPool
    if (!pool) throw new Error('Expected migrated pool')
    const reader = createNativeAccountRuntime({
      paths: pool.paths,
      host: 'opencode',
    })
    const records: LogTestRecord[] = []
    __setLogTestSink((record) => records.push(record))
    setLogLevel('debug')
    try {
      const before = await reader.captureLocalSubject('fb')
      loginIssues('sk-ant-oat01-old-access', 'sk-ant-oat01-new-access')
      await refreshPoolLoginElsewhere('fb', {
        access: 'sk-ant-oat01-new-access',
        refresh: 'new-refresh',
        expires: Date.now() + 8 * 60 * 60_000,
      })
      const rotated = await reader.captureLocalSubject('fb')
      expect(rotated.binding.identity).toBe(before.binding.identity)
      expect(rotated.binding.credentialEpoch).toBe(
        before.binding.credentialEpoch,
      )
      expect(rotated.version?.accessFingerprint).not.toBe(
        before.version?.accessFingerprint,
      )
      profile.release(
        Response.json({
          organization: {
            organization_type: 'claude_team',
            rate_limit_tier: 'default_claude_max_5x',
          },
        }),
      )
      // Profile metadata still requires its captured token version. The late
      // response must not replace credentials or publish stale metadata.
      await waitForLogRecord(
        records,
        (record) =>
          record.channel === 'quota' &&
          record.message === 'refused account profile publication' &&
          record.payload?.account === 'fb',
        'stale fallback profile publication refusal',
      )
      await drainSidebarWrites()
      const after = await reader.captureLocalSubject('fb')
      expect(after).toEqual(rotated)
      const snapshot = await reader.read()
      expect(
        snapshot.accounts.find((account) => account.id === 'fb')?.profile,
      ).toBeUndefined()
      const stored = await createNativePoolStore({
        paths: pool.paths,
        quota: nativeQuotaCodec,
      }).read()
      expect(stored.status).toBe('ready')
      const credential =
        stored.status === 'ready'
          ? stored.rows.find((row) => row.id === rotated.binding.rowId)
              ?.credential
          : undefined
      expect(credential).toMatchObject({
        type: 'oauth',
        access: 'sk-ant-oat01-new-access',
        refresh: 'new-refresh',
      })
      expect(profileCalls).toBe(1)
    } finally {
      profile.release(new Response('cancelled', { status: 499 }))
      reader.close()
      __setLogTestSink(null)
      setLogLevel('info')
    }
  })

  test('late main profile hydration cannot replace a rotated-token profile', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    const oldLogin = {
      access: 'sk-ant-oat01-old-main-access',
      refresh: 'refresh-sk-ant-oat01-old-main-access',
      expires: Date.now() + 100_000,
    }
    await useTempAccountFile(createFallbackStorage({ accounts: [] }), oldLogin)
    const profile = heldResponse()
    const profileStarted = lifetimeSignal()
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) {
          profileStarted.raise()
          return profile.response
        }
        return Promise.resolve(new Response('ok'))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth', ...oldLogin }),
      { models: {} },
    )
    await profileStarted.raised
    await drainSidebarWrites()
    const initialSidebarUpdatedAt = (await getSidebarState()).lastUpdated

    // Another OpenCode process refreshes the main login, then records a newer
    // profile for the rotated credential, while this plugin's profile request
    // for the old access token is still in flight.
    await refreshPoolMainElsewhere({
      access: 'sk-ant-oat01-new-main-access',
      refresh: 'refresh-sk-ant-oat01-new-main-access',
      expires: Date.now() + 100_000,
    })
    const rotated = await readAccountStorage()
    if (!rotated) throw new Error('expected account storage')
    await publishPoolMetadata('main', (identity) => ({
      profile: {
        tier: 'default_claude_max_20x',
        orgType: 'claude_max',
        checkedAt: Date.now() + 10_000,
        accountIdentity: identity,
      },
    }))
    await Bun.sleep(2)
    profile.release(
      Response.json({
        organization: {
          organization_type: 'claude_team',
          rate_limit_tier: 'default_claude_max_5x',
        },
      }),
    )
    await waitForSidebarState(
      (state) => state.lastUpdated > initialSidebarUpdatedAt,
    )

    expect((await readAccountStorage())?.main?.profile).toMatchObject({
      tier: 'default_claude_max_20x',
      accountIdentity: rotated.mainAccountId,
    })
  })

  test('delayed boot hydration preserves a live fallback sidebar route', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await useTempAccountFile(
      createFallbackStorage({ routing: { mode: 'fallback-first' } }),
    )
    const mainProfile = heldResponse()
    const mainProfileStarted = lifetimeSignal()
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          const authorization = new Headers(init?.headers).get('authorization')
          if (
            url.includes('/api/oauth/profile') &&
            authorization === 'Bearer sk-ant-oat01-main-access'
          ) {
            mainProfileStarted.raise()
            return mainProfile.response
          }
          if (url.includes('/api/oauth/profile')) {
            return Promise.resolve(
              Response.json({
                organization: {
                  organization_type: 'claude_team',
                  rate_limit_tier: 'default_claude_max_5x',
                },
              }),
            )
          }
          return Promise.resolve(new Response('ok'))
        },
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await mainProfileStarted.raised

    await result.fetch(MESSAGES_URL, EMPTY_POST)
    await waitForSidebarState(
      (state) =>
        state.activeId === 'fallback-1' && state.route === 'fallback-first',
    )
    mainProfile.release(
      Response.json({
        organization: {
          organization_type: 'claude_max',
          rate_limit_tier: 'default_claude_max_20x',
        },
      }),
    )

    const hydratedState = await waitForSidebarState(
      (state) => state.main.tierLabel === 'Max 20x',
    )
    expect(hydratedState).toMatchObject({
      activeId: 'fallback-1',
      route: 'fallback-first',
    })
  })

  test('profile hydration keeps its plugin-scoped fetch across test turnover', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await useTempAccountFile(createFallbackStorage())
    const firstProfileStarted = lifetimeSignal()
    const secondLookupArrived = lifetimeSignal()
    const secondLookupReleased = lifetimeSignal()
    const profilesPublished = lifetimeSignal()
    // Profile responses and their persisted sidebar publications settle separately.
    // Observe the committed labels instead of racing metadata writes with a polling budget.
    __setSidebarStateWriteTestHooks({
      afterRename: async () => {
        const state = await getSidebarState()
        if (
          state.main.tierLabel === 'Max 20x' &&
          state.fallbacks[0]?.tierLabel === 'Team · Max 5x'
        )
          profilesPublished.raise()
      },
    })
    const lookupAccounts: string[] = []
    const firstFetchCalls: string[] = []
    const answer = withNativeAdmission(
      (input: string | URL | Request, init?: RequestInit) => {
        const authorization = new Headers(
          input instanceof Request ? input.headers : init?.headers,
        ).get('authorization')
        if (extractUrl(input).includes('/api/oauth/usage')) {
          return Promise.resolve(
            Response.json({
              five_hour: { utilization: 25 },
              seven_day: { utilization: 30 },
            }),
          )
        }
        firstFetchCalls.push(authorization ?? '')
        firstProfileStarted.raise()
        return Promise.resolve(
          Response.json({
            organization:
              authorization === 'Bearer sk-ant-oat01-main-access'
                ? {
                    organization_type: 'claude_max',
                    rate_limit_tier: 'default_claude_max_20x',
                  }
                : {
                    organization_type: 'claude_team',
                    rate_limit_tier: 'default_claude_max_5x',
                  },
          }),
        )
      },
    )
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        // Profiles load one account at a time, in either order, and each
        // account's lookup runs before its profile request. Hold the second
        // account's lookup so its profile request is sent only after the swap.
        if (extractUrl(input).includes('/api/claude_cli/bootstrap')) {
          const account =
            new Headers(
              input instanceof Request ? input.headers : init?.headers,
            ).get('authorization') ?? ''
          if (!lookupAccounts.includes(account)) lookupAccounts.push(account)
          if (lookupAccounts.indexOf(account) === 1) {
            secondLookupArrived.raise()
            await secondLookupReleased.raised
          }
        }
        return answer(input, init)
      },
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await firstProfileStarted.raised
    await secondLookupArrived.raised

    // Simulate the next test installing its own global fetch. The second
    // account's profile request is sent after this point and must still use the fetch
    // the plugin captured. Quota polls use the global fetch of the moment by
    // design, so only profile requests are checked here.
    const nextTestRequests: string[] = []
    const nextTestFetch = mock((input: string | URL | Request) => {
      nextTestRequests.push(extractUrl(input))
      return Promise.resolve(new Response('ok'))
    })
    globalThis.fetch = nextTestFetch as unknown as typeof fetch
    secondLookupReleased.raise()
    await profilesPublished.raised
    const state = await getSidebarState()
    expect(state.main.tierLabel).toBe('Max 20x')
    expect(state.fallbacks[0]?.tierLabel).toBe('Team · Max 5x')

    expect(firstFetchCalls.toSorted()).toEqual([
      'Bearer sk-ant-oat01-fallback-access',
      'Bearer sk-ant-oat01-main-access',
    ])
    expect(
      nextTestRequests.filter((url) => url.includes('/api/oauth/profile')),
    ).toEqual([])
  })

  test('mock-environment opt-out prevents boot profile network calls', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    let profileCalls = 0
    globalThis.fetch = mock((input: string | URL | Request) => {
      if (extractUrl(input).includes('/api/oauth/profile')) profileCalls++
      return Promise.resolve(new Response('ok'))
    }) as unknown as typeof fetch
    const plugin = await getPlugin()

    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await Bun.sleep(20)

    expect(profileCalls).toBe(0)
  })

  test('mock-environment opt-out prevents command profile network calls', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    let profileCalls = 0
    globalThis.fetch = mock((input: string | URL | Request) => {
      if (extractUrl(input).includes('/api/oauth/profile')) profileCalls++
      if (extractUrl(input).includes('/api/oauth/usage')) {
        return Promise.resolve(
          Response.json({
            five_hour: { utilization: 10 },
            seven_day: { utilization: 20 },
          }),
        )
      }
      return Promise.resolve(new Response('ok'))
    }) as unknown as typeof fetch
    const plugin = await getPlugin(createMockClient())
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(profileCalls).toBe(0)
  })

  test('boot hydration publishes storage reloaded after the profile await', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const profile = heldResponse()
    const profileStarted = lifetimeSignal()
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) {
          profileStarted.raise()
          return profile.response
        }
        return Promise.resolve(new Response('ok'))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await profileStarted.raised

    const storage = await readAccountStorage()
    if (!storage?.quota) throw new Error('expected quota storage')
    const backoff = {
      message: 'Claude quota check failed: 429 — rate limited',
      checkedAt: Date.now(),
      nextRetryAt: Date.now() + 60_000,
      retryCount: 1,
    }
    // Another OpenCode process records a quota backoff for the main account
    // while this plugin's boot profile request is still in flight.
    await publishPoolMetadata('main', () => ({
      lastQuotaRefreshError: backoff,
    }))
    profile.release(
      Response.json({
        organization: {
          organization_type: 'claude_max',
          rate_limit_tier: 'default_claude_max_20x',
        },
      }),
    )

    const state = await waitForSidebarState(
      (value) => value.main.tierLabel === 'Max 20x',
    )
    expect(state.main.quotaBackedOff).toBe(true)
    // The stored backoff keeps its retry schedule; free-form provider text is
    // not stored, so no credential fragment can be published with it.
    const stored = (await readAccountStorage())?.quota?.mainLastQuotaApiError
    expect(stored).toEqual(
      expect.objectContaining({
        checkedAt: backoff.checkedAt,
        nextRetryAt: backoff.nextRetryAt,
        retryCount: backoff.retryCount,
      }),
    )
    expectNoCredentialFragment(stored)
  })

  test('token rotation reuses the profile for the same account identity', async () => {
    const firstLogin = {
      access: 'sk-ant-oat01-token-a',
      refresh: 'refresh-sk-ant-oat01-token-a',
      expires: Date.now() + 100000,
    }
    await useTempAccountFile(
      createFallbackStorage({ accounts: [] }),
      firstLogin,
    )
    const mockClient = createMockClient()
    const profileCalls: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          if (extractUrl(input).includes('/api/oauth/profile')) {
            const authorization = new Headers(init?.headers).get(
              'authorization',
            )
            profileCalls.push(authorization ?? '')
            const firstToken = authorization?.includes('token-a')
            return Promise.resolve(
              Response.json({
                organization: {
                  organization_type: firstToken ? 'claude_team' : 'claude_max',
                  rate_limit_tier: firstToken
                    ? 'default_claude_max_5x'
                    : 'default_claude_max_20x',
                },
              }),
            )
          }
          return Promise.resolve(new Response('ok'))
        },
      ),
    ) as unknown as typeof fetch
    // The main login has served before, so the pool already knows which
    // account it belongs to; a refresh elsewhere then stays on that account.
    await poolMainAccess()
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth', ...firstLogin }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    const showAccounts = async () => {
      await expect(
        plugin['command.execute.before']({
          command: 'claude',
          arguments: '',
          sessionID: 'session-1',
        }),
      ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
      return (mockClient.session.promptAsync as any).mock.calls.at(-1)?.[0]
        ?.body.parts[0]?.text as string
    }

    expect(await showAccounts()).toContain('Team · Max 5x')
    await waitForAccountStorage(
      (storage) =>
        storage?.main?.profile?.accountIdentity === storage?.mainAccountId,
    )
    // Another OpenCode process refreshes the main login of the same account.
    await refreshPoolMainElsewhere({
      access: 'sk-ant-oat01-token-b',
      refresh: 'refresh-sk-ant-oat01-token-b',
      expires: Date.now() + 100000,
    })
    expect(await showAccounts()).toContain('Team · Max 5x')
    expect(await showAccounts()).toContain('Team · Max 5x')

    expect(profileCalls).toEqual(['Bearer sk-ant-oat01-token-a'])
    expect((await readAccountStorage())?.main?.profile?.accountIdentity).toBe(
      (await readAccountStorage())?.mainAccountId,
    )
  })

  test('expired profile TTL triggers a fresh hydration in the same process', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const originalDateNow = Date.now
    let now = 1_000_000
    let profileCalls = 0
    Date.now = () => now
    try {
      globalThis.fetch = mock(
        withNativeAdmission((input: string | URL | Request) => {
          if (extractUrl(input).includes('/api/oauth/profile')) {
            profileCalls++
            return Promise.resolve(
              Response.json({
                organization: {
                  organization_type: 'claude_max',
                  rate_limit_tier: 'default_claude_max_20x',
                },
              }),
            )
          }
          return Promise.resolve(new Response('ok'))
        }),
      ) as unknown as typeof fetch
      const plugin = await getPlugin(mockClient)
      await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth',
            access: 'sk-ant-oat01-main-access',
            refresh: 'main-refresh',
            expires: now + PROFILE_TTL_MS * 3,
          }),
        { models: {} },
      )
      delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
      const showAccounts = async () => {
        await expect(
          plugin['command.execute.before']({
            command: 'claude',
            arguments: '',
            sessionID: 'session-1',
          }),
        ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
      }

      await showAccounts()
      await waitForAccountStorage(
        (storage) => storage?.main?.profile?.checkedAt === now,
      )
      now += PROFILE_TTL_MS + 1
      await showAccounts()

      expect(profileCalls).toBe(2)
      const refreshedStorage = await waitForAccountStorage(
        (storage) => storage?.main?.profile?.checkedAt === now,
      )
      expect(refreshedStorage?.main?.profile?.checkedAt).toBe(now)
    } finally {
      Date.now = originalDateNow
    }
  })

  test('completed profile hydration does not refetch later token generations', async () => {
    const firstLogin = {
      access: 'sk-ant-oat01-token-0',
      refresh: 'refresh-sk-ant-oat01-token-0',
      expires: Date.now() + 100000,
    }
    await useTempAccountFile(
      createFallbackStorage({ accounts: [] }),
      firstLogin,
    )
    const mockClient = createMockClient()
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) {
          profileCalls++
          return Promise.resolve(
            Response.json({
              organization: {
                organization_type: 'claude_max',
                rate_limit_tier: 'default_claude_max_20x',
              },
            }),
          )
        }
        return Promise.resolve(new Response('ok'))
      }),
    ) as unknown as typeof fetch
    // The main login has served before, so the pool already knows which
    // account it belongs to; a refresh elsewhere then stays on that account.
    await poolMainAccess()
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth', ...firstLogin }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    const showAccounts = async () => {
      await expect(
        plugin['command.execute.before']({
          command: 'claude',
          arguments: '',
          sessionID: 'session-1',
        }),
      ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
    }

    await showAccounts()
    await waitForAccountStorage(
      (storage) =>
        storage?.main?.profile?.accountIdentity === storage?.mainAccountId,
    )
    // Each iteration simulates another process refreshing the same main
    // account, which only rotates its access token. Profile hydration does
    // not look at tokens: once the stored profile is fresh for this account
    // identity the display skips the account, and a completed check is
    // remembered under the route ID and account identity (storage row and
    // login epoch are only consulted while a route's identity is unknown).
    // Nothing there counts or caps rotations, so three rotations in a row
    // cover what more would: none may cause a further profile fetch.
    for (let generation = 1; generation <= 3; generation++) {
      await refreshPoolMainElsewhere({
        access: `sk-ant-oat01-token-${generation}`,
        refresh: `refresh-sk-ant-oat01-token-${generation}`,
        expires: Date.now() + 100000,
      })
      await showAccounts()
    }
    await showAccounts()

    expect(profileCalls).toBe(1)
  })

  test('stale profile refreshes on display', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        main: {
          type: 'opencode',
          provider: 'anthropic',
          profile: {
            tier: 'old',
            orgType: 'claude_max',
            checkedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
          },
        },
      }),
    )
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) {
          profileCalls++
          return Promise.resolve(
            Response.json({
              organization: {
                organization_type: 'claude_max',
                rate_limit_tier: 'default_claude_max_20x',
              },
            }),
          )
        }
        return Promise.resolve(
          Response.json({
            five_hour: { utilization: 10 },
            seven_day: { utilization: 20 },
          }),
        )
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(createMockClient())
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(profileCalls).toBe(1)
    const refreshedStorage = await waitForAccountStorage(
      (storage) => storage?.main?.profile?.tier === 'default_claude_max_20x',
    )
    expect(refreshedStorage?.main?.profile?.tier).toBe('default_claude_max_20x')
  })

  test('profile fetch failure is silent and label is omitted', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) =>
        Promise.resolve(
          extractUrl(input).includes('/api/oauth/profile')
            ? new Response('failed', { status: 500 })
            : Response.json({
                five_hour: { utilization: 10 },
                seven_day: { utilization: 20 },
              }),
        ),
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    const records: LogTestRecord[] = []
    __setLogTestSink((record) => records.push(record))
    setLogLevel('debug')

    try {
      await expect(
        plugin['command.execute.before']({
          command: 'claude',
          arguments: '',
          sessionID: 'session-1',
        }),
      ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
    } finally {
      __setLogTestSink(null)
      setLogLevel('info')
    }
    const text = (mockClient.session.promptAsync as any).mock.calls.at(-1)?.[0]
      ?.body.parts[0]?.text

    expect(text).not.toContain('Max 20x')
    expect(
      records.filter(
        (record) =>
          record.level === 'debug' &&
          record.channel === 'quota' &&
          record.message === 'failed to hydrate account profile' &&
          record.payload?.account === 'main',
      ),
    ).toHaveLength(1)
  })

  for (const rotate of [false, true]) {
    test(
      rotate
        ? 'profile I/O failure hides a fetched tier after the credential changes'
        : 'profile persistence failure does not block account display',
      async () => {
        await useTempAccountFile(createFallbackStorage({ accounts: [] }))
        const mockClient = createMockClient()
        let profileCalls = 0
        globalThis.fetch = mock(
          withNativeAdmission((input: Parameters<typeof fetch>[0]) => {
            if (extractUrl(input).includes('/api/oauth/profile')) {
              profileCalls++
              return Promise.resolve(
                Response.json({
                  organization: {
                    organization_type: 'claude_max',
                    rate_limit_tier: 'default_claude_max_20x',
                  },
                }),
              )
            }
            return Promise.resolve(new Response('ok'))
          }),
        ) as unknown as typeof fetch
        const plugin = await getPlugin(mockClient)
        await plugin.auth.loader(
          () =>
            Promise.resolve({
              type: 'oauth',
              access: 'sk-ant-oat01-main-access',
              refresh: 'main-refresh',
              expires: Date.now() + 100000,
            }),
          { models: {} },
        )
        const pool = testContext.migratedPool
        if (!pool) throw new Error('Expected migrated pool')
        const reader = createNativeAccountRuntime({
          paths: pool.paths,
          host: 'opencode',
        })
        expect((await reader.authorizeLocal('main')).status).toBe('usable')
        const before = await readFile(pool.paths.runtime)
        const originalRename = filesystem.rename
        let failedWrites = 0
        // Fail only the actual metadata rename after credential admission and
        // production publication guards. Leave credential files untouched.
        const writer = spyOn(filesystem, 'rename').mockImplementation(
          async (from, to) => {
            if (to === pool.paths.runtime) {
              failedWrites++
              throw Object.assign(
                new Error('Synthetic profile rename failure'),
                { code: 'EIO' },
              )
            }
            await originalRename(from, to)
          },
        )
        const records: LogTestRecord[] = []
        __setLogTestSink((record) => records.push(record))
        setLogLevel('debug')
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
        const command = () =>
          expectHandledCommandResponse(
            plugin['command.execute.before']({
              command: 'claude',
              arguments: '',
              sessionID: 'session-1',
            }),
          )
        try {
          await command()
          await waitForLogRecord(
            records,
            (record) =>
              record.level === 'warn' &&
              record.channel === 'quota' &&
              record.message === 'failed to persist account profile',
            'profile I/O failure warning',
          )
          expect(failedWrites).toBe(1)
          expect(await readFile(pool.paths.runtime)).toEqual(before)
          writer.mockRestore()
          if (rotate)
            await refreshPoolMainElsewhere({
              access: 'sk-ant-oat01-profile-io-successor',
              refresh: 'profile-io-successor-refresh',
              expires: Date.now() + 8 * 60 * 60_000,
            })
          // Reopen after the I/O outcome, so this assertion cannot pass merely
          // because the first display raced the failing writer.
          await command()
          const calls = (
            mockClient.session.promptAsync as unknown as {
              mock: {
                calls: Array<[{ body: { parts: Array<{ text: string }> } }]>
              }
            }
          ).mock.calls
          const text = calls.at(-1)?.[0].body.parts[0]?.text
          if (rotate) expect(text).not.toContain('Max 20x')
          else expect(text).toContain('Max 20x')
          expect(profileCalls).toBe(1)
          expect(
            (await reader.read()).accounts.find(
              (account) => account.id === 'main',
            )?.profile,
          ).toBeUndefined()
          expect(
            records.filter(
              (record) =>
                record.level === 'warn' &&
                record.channel === 'quota' &&
                record.message === 'failed to persist account profile',
            ),
          ).toHaveLength(1)
        } finally {
          writer.mockRestore()
          reader.close()
          __setLogTestSink(null)
          setLogLevel('info')
        }
      },
    )
  }

  test('ordinary model request never calls the profile endpoint', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) profileCalls++
        return Promise.resolve(new Response('ok'))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(profileCalls).toBe(0)
  })

  test('background refresh timers include per-process jitter', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: { enabled: false },
        refresh: { enabled: true, refreshBeforeExpiryMinutes: 30 },
      }),
      {
        access: 'sk-ant-oat01-access',
        refresh: 'refresh',
        expires: Date.now() + 8 * 60 * 60_000,
      },
    )
    Math.random = () => 0.5
    const intervalDelays: number[] = []
    const setIntervalMock = mock((handler: () => void, delay?: number) => {
      void handler
      intervalDelays.push(Number(delay))
      return { unref() {} }
    }) as unknown as typeof setInterval

    const plugin = await getPlugin(createMockClient(), undefined, {
      setInterval: setIntervalMock,
      clearInterval: mock(() => {}) as unknown as typeof clearInterval,
    })
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-access',
          refresh: 'refresh',
          expires: Date.now() + 8 * 60 * 60_000,
        }),
      { models: {} },
    )

    expect(intervalDelays).toContain(90_000)
  })

  test('background refresh proactively rotates main oauth before expiry', async () => {
    await useTempAccountFile(
      bindMainAccount(
        createFallbackStorage({
          accounts: [],
          quota: { enabled: false },
          refresh: { enabled: true, refreshBeforeExpiryMinutes: 30 },
        }),
        'sk-ant-oat01-old-access',
      ),
      {
        access: 'sk-ant-oat01-old-access',
        refresh: 'old-refresh',
        expires: Date.now() + 5 * 60_000,
      },
    )
    const intervalHandlers: Array<() => void> = []
    const setIntervalMock = mock((handler: () => void) => {
      intervalHandlers.push(handler)
      return { unref() {} }
    }) as unknown as typeof setInterval

    mainAccountIssues('sk-ant-oat01-background-access-new')
    globalThis.fetch = mock(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const admitted = await nativeBootstrapAnswer(input, init)
        if (admitted) return admitted
        if (extractUrl(input).includes('/v1/oauth/token'))
          return Response.json({
            refresh_token: 'background-refresh-new',
            access_token: 'sk-ant-oat01-background-access-new',
            expires_in: 3600,
          })
        return new Response(null, { status: 200 })
      },
    ) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, undefined, {
      setInterval: setIntervalMock,
      clearInterval: mock(() => {}) as unknown as typeof clearInterval,
    })
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-old-access',
          refresh: 'old-refresh',
          expires: Date.now() + 5 * 60_000,
        }),
      { models: {} },
    )

    expect(intervalHandlers.length).toBeGreaterThanOrEqual(2)
    for (const handler of intervalHandlers) handler()
    const pool = testContext.migratedPool
    if (!pool) throw new Error('Expected migrated pool')
    // Wait for the background refresh's write itself, not a fixed poll count.
    const { subject } = await waitForPoolCredential(
      'main',
      'sk-ant-oat01-background-access-new',
    )
    const stored = await createNativePoolStore({
      paths: pool.paths,
      quota: nativeQuotaCodec,
    }).read()
    expect(stored.status).toBe('ready')
    const credential =
      stored.status === 'ready'
        ? stored.rows.find((row) => row.id === subject.binding.rowId)
            ?.credential
        : undefined
    expect(credential).toMatchObject({
      type: 'oauth',
      refresh: 'background-refresh-new',
      access: 'sk-ant-oat01-background-access-new',
      expires: expect.any(Number),
    })
    expect(subject.binding.identity).toBe(syntheticMainAccountUuid)
    expect(mockClient.auth.set).not.toHaveBeenCalled()
  })

  test('background refresh retries after a permanent main backoff belongs to an older refresh token', async () => {
    const now = Date.now()
    await useTempAccountFile(
      bindMainAccount(
        createFallbackStorage({
          accounts: [],
          mainAccountId: 'main-account-id',
          quota: { enabled: false },
          refresh: {
            enabled: true,
            refreshBeforeExpiryMinutes: 30,
            mainLastRefreshError: {
              message: 'Claude OAuth refresh failed: 400 — invalid_grant',
              checkedAt: now - 1_000,
              nextRetryAt: now + 24 * 60 * 60_000,
              retryCount: 1,
              accountIdentity: 'main-account-id',
              refreshTokenFingerprint: tokenFingerprint('failed-refresh'),
              status: 400,
              permanent: true,
            },
          },
        }),
        'sk-ant-oat01-current-access',
      ),
      {
        access: 'sk-ant-oat01-current-access',
        refresh: 'current-refresh',
        expires: now + 5 * 60_000,
      },
    )
    const intervalHandlers: Array<() => void> = []
    const setIntervalMock = mock((handler: () => void) => {
      intervalHandlers.push(handler)
      return { unref() {} }
    }) as unknown as typeof setInterval
    let tokenRefreshCalls = 0
    mainAccountIssues('sk-ant-oat01-refreshed-access')
    globalThis.fetch = mock(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const admitted = await nativeBootstrapAnswer(input, init)
        if (admitted) return admitted
        if (extractUrl(input).includes('/v1/oauth/token')) {
          tokenRefreshCalls += 1
          return Response.json({
            refresh_token: 'refreshed-refresh',
            access_token: 'sk-ant-oat01-refreshed-access',
            expires_in: 8 * 60 * 60,
          })
        }
        return new Response(null, { status: 200 })
      },
    ) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, undefined, {
      setInterval: setIntervalMock,
      clearInterval: mock(() => {}) as unknown as typeof clearInterval,
    })
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-current-access',
          refresh: 'current-refresh',
          expires: now + 5 * 60_000,
        }),
      { models: {} },
    )

    for (const handler of intervalHandlers) handler()
    const refreshed = await waitForPoolCredential(
      'main',
      'sk-ant-oat01-refreshed-access',
    )
    expect(refreshed.credential.refresh).toBe('refreshed-refresh')
    expect(refreshed.subject.binding.identity).toBe(syntheticMainAccountUuid)
    expect(tokenRefreshCalls).toBe(1)
    expect(mockClient.auth.set).not.toHaveBeenCalled()
    expect(
      (await readAccountStorage())?.refresh?.mainLastRefreshError,
    ).toBeUndefined()
  })

  test('reset-backoff clears an imported main latch before the next background refresh', async () => {
    const now = Date.now()
    await useTempAccountFile(
      bindMainAccount(
        createFallbackStorage({
          accounts: [],
          mainAccountId: 'main-account-id',
          quota: { enabled: false },
          refresh: {
            enabled: true,
            refreshBeforeExpiryMinutes: 30,
            mainLastRefreshError: {
              message: 'Claude OAuth refresh failed: 400 — invalid_grant',
              checkedAt: now - 1_000,
              nextRetryAt: now + 24 * 60 * 60_000,
              retryCount: 1,
              accountIdentity: syntheticMainAccountUuid,
              tokenHash: hashRefreshToken('current-refresh'),
              status: 400,
              permanent: true,
            },
          },
        }),
        'sk-ant-oat01-current-access',
      ),
      {
        access: 'sk-ant-oat01-current-access',
        refresh: 'current-refresh',
        expires: now + 5 * 60_000,
      },
    )
    const intervalHandlers: Array<() => void> = []
    const setIntervalMock = mock((handler: () => void) => {
      intervalHandlers.push(handler)
      return { unref() {} }
    }) as unknown as typeof setInterval
    let tokenRefreshCalls = 0
    mainAccountIssues('sk-ant-oat01-refreshed-access')
    globalThis.fetch = mock(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const admitted = await nativeBootstrapAnswer(input, init)
        if (admitted) return admitted
        if (extractUrl(input).includes('/v1/oauth/token')) {
          tokenRefreshCalls += 1
          return Response.json({
            refresh_token: 'refreshed-refresh',
            access_token: 'sk-ant-oat01-refreshed-access',
            expires_in: 8 * 60 * 60,
          })
        }
        return new Response(null, { status: 200 })
      },
    ) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, testContext.tempConfigDir, {
      setInterval: setIntervalMock,
      clearInterval: mock(() => {}) as unknown as typeof clearInterval,
    })
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-current-access',
          refresh: 'current-refresh',
          expires: now + 5 * 60_000,
        }),
      { models: {} },
    )

    expect(
      (await readNativeRuntimeState()).main?.lastRefreshError?.permanent,
    ).toBe(true)
    expect(tokenRefreshCalls).toBe(0)
    expect(
      (
        await applyMenuAction(plugin, 'session-1', {
          sectionId: 'Accounts',
          actionId: 'reset-backoff',
        })
      ).ok,
    ).toBe(true)
    expect(
      (await readNativeRuntimeState()).main?.lastRefreshError,
    ).toBeUndefined()
    for (const handler of intervalHandlers) handler()
    const refreshed = await waitForPoolCredential(
      'main',
      'sk-ant-oat01-refreshed-access',
    )
    expect(refreshed.credential.refresh).toBe('refreshed-refresh')
    expect(mockClient.auth.set).not.toHaveBeenCalled()
    expect(tokenRefreshCalls).toBe(1)
    expect(
      (await readAccountStorage())?.refresh?.mainLastRefreshError,
    ).toBeUndefined()
  })

  test('background refresh uses a four-hour minimum window for main oauth', async () => {
    await useTempAccountFile(
      bindMainAccount(
        createFallbackStorage({
          accounts: [],
          quota: { enabled: false },
          refresh: { enabled: true, refreshBeforeExpiryMinutes: 30 },
        }),
        'sk-ant-oat01-old-access',
      ),
      {
        access: 'sk-ant-oat01-old-access',
        refresh: 'old-refresh',
        expires: Date.now() + 3 * 60 * 60_000,
      },
    )
    const intervalHandlers: Array<() => void> = []
    const setIntervalMock = mock((handler: () => void) => {
      intervalHandlers.push(handler)
      return { unref() {} }
    }) as unknown as typeof setInterval

    mainAccountIssues('sk-ant-oat01-early-access-new')
    globalThis.fetch = mock(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const admitted = await nativeBootstrapAnswer(input, init)
        if (admitted) return admitted
        if (extractUrl(input).includes('/v1/oauth/token'))
          return Response.json({
            refresh_token: 'early-refresh-new',
            access_token: 'sk-ant-oat01-early-access-new',
            expires_in: 3600,
          })
        return new Response(null, { status: 200 })
      },
    ) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, undefined, {
      setInterval: setIntervalMock,
      clearInterval: mock(() => {}) as unknown as typeof clearInterval,
    })
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-old-access',
          refresh: 'old-refresh',
          expires: Date.now() + 3 * 60 * 60_000,
        }),
      { models: {} },
    )

    for (const handler of intervalHandlers) handler()
    const refreshed = await waitForPoolCredential(
      'main',
      'sk-ant-oat01-early-access-new',
    )
    expect(refreshed.credential).toMatchObject({
      type: 'oauth',
      refresh: 'early-refresh-new',
      access: 'sk-ant-oat01-early-access-new',
      expires: expect.any(Number),
    })
    expect(refreshed.subject.binding.identity).toBe(syntheticMainAccountUuid)
    expect(mockClient.auth.set).not.toHaveBeenCalled()
  })

  test('fetch wrapper backs off main oauth refresh after rate limits', async () => {
    await useTempAccountFile(
      bindMainAccount(
        createFallbackStorage({
          accounts: [],
          quota: { enabled: false },
          refresh: { enabled: true, refreshBeforeExpiryMinutes: 30 },
        }),
        'sk-ant-oat01-expired',
      ),
      {
        access: 'sk-ant-oat01-expired',
        refresh: 'refresh-token',
        expires: Date.now() - 1000,
      },
    )
    let tokenRefreshCalls = 0
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        tokenRefreshCalls += 1
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { type: 'rate_limit_error', message: 'Rate limited' },
            }),
            { status: 429 },
          ),
        )
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin(createMockClient())
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-expired',
          refresh: 'refresh-token',
          expires: Date.now() - 1000,
        }),
      { models: {} },
    )

    await expect(
      result.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow('Claude OAuth refresh failed: 429')
    await expect(
      result.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow('Claude OAuth refresh is backed off')

    expect(tokenRefreshCalls).toBe(1)
    const pool = testContext.migratedPool
    if (!pool) throw new Error('Expected migrated pool')
    const savedConfig = await createNativePoolStore({
      paths: pool.paths,
      quota: nativeQuotaCodec,
    }).readSettings()
    expect(savedConfig.status).toBe('ready')
    if (savedConfig.status !== 'ready')
      throw new Error('Expected ready native pool')
    expect(JSON.stringify(savedConfig.settings)).not.toContain(
      'lastRefreshError',
    )
    const savedState = await readNativeRuntimeState()
    expect(savedState.main?.lastRefreshError?.nextRetryAt).toBeGreaterThan(
      Date.now(),
    )
    expect(savedState.main?.lastRefreshError?.status).toBe(429)
    expect(savedState.main?.accountIdentity).toBe(syntheticMainAccountUuid)
    await expect(readFile(getAccountStatePath(), 'utf8')).rejects.toMatchObject(
      { code: 'ENOENT' },
    )
  })

  for (const sameAccount of [false, true]) {
    test(
      sameAccount
        ? 'successful re-login preserves the current account main quota backoff'
        : 'successful re-login clears a live stale main refresh backoff',
      async () => {
        const now = Date.now()
        const prior = {
          access: 'sk-ant-oat01-prior-login',
          refresh: 'prior-login-refresh',
          expires: now + 8 * 60 * 60_000,
        }
        const quotaRetryAt = now + 60_000
        await useTempAccountFile(
          bindMainAccount(
            createFallbackStorage({
              accounts: [],
              mainAccountId: 'main-account-id',
              quota: {
                enabled: false,
                mainLastQuotaApiError: {
                  message: 'Prior quota failure',
                  status: 429,
                  checkedAt: now - 1000,
                  nextRetryAt: quotaRetryAt,
                  retryCount: 1,
                  accountIdentity: syntheticMainAccountUuid,
                },
              },
              refresh: {
                enabled: true,
                mainLastRefreshError: {
                  message: 'Claude OAuth refresh failed: 400 — invalid_grant',
                  status: 400,
                  checkedAt: now - 1000,
                  nextRetryAt: now + 24 * 60 * 60_000,
                  retryCount: 1,
                  permanent: true,
                  accountIdentity: syntheticMainAccountUuid,
                  tokenHash: hashRefreshToken(prior.refresh),
                },
              },
            }),
            prior.access,
          ),
          prior,
        )
        const successor = {
          access: 'sk-ant-oat01-relogged-main-access',
          refresh: 'relogged-main-refresh',
          expires: now + 8 * 60 * 60_000,
        }
        const identity = sameAccount
          ? syntheticMainAccountUuid
          : ('88888888-2222-4333-8444-555555555555' as ProviderAccountUuid)
        testContext.successorAccess.set(successor.access, identity)
        let tokenRefreshCalls = 0
        const modelAuthorizations: Array<string | null> = []
        globalThis.fetch = mock(
          async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            const url = extractUrl(input)
            if (
              url.includes('/api/claude_cli/bootstrap') &&
              new Headers(init?.headers).get('authorization') ===
                `Bearer ${successor.access}`
            )
              return Response.json({
                oauth_account: { account_uuid: identity },
              })
            const admitted = await nativeBootstrapAnswer(input, init)
            if (admitted) return admitted
            if (url.includes('/v1/oauth/token')) {
              tokenRefreshCalls++
              throw new Error(
                'Unexpected token refresh during known-account re-login',
              )
            }
            if (url.includes('/v1/messages'))
              modelAuthorizations.push(
                new Headers(init?.headers).get('authorization'),
              )
            return Response.json({})
          },
        ) as unknown as typeof fetch
        const mockClient = createMockClient()
        const plugin = await getPlugin(mockClient)
        const result = await plugin.auth.loader(
          () => Promise.resolve({ type: 'oauth', ...prior }),
          { models: {} },
        )
        const before = await readNativeRuntimeState()
        expect(before.main?.lastRefreshError?.permanent).toBe(true)
        expect(before.main?.lastRefreshError?.nextRetryAt).toBeGreaterThan(now)
        expect(before.main?.lastQuotaApiError?.nextRetryAt).toBe(quotaRetryAt)
        await replacePoolMainLogin(successor, {
          sameAccount,
          accountIdentity: identity,
        })
        const response = await result.fetch(MESSAGES_URL, {
          method: 'POST',
          body: '{}',
        })
        expect(response.status).toBe(200)
        expect(modelAuthorizations).toEqual([`Bearer ${successor.access}`])
        expect(tokenRefreshCalls).toBe(0)
        const after = await readNativeRuntimeState()
        expect(after.main?.accountIdentity).toBe(identity)
        expect(after.main?.lastRefreshError).toBeUndefined()
        if (sameAccount) {
          // A refresh restriction belongs to the replaced credentials. Quota
          // backoff belongs to the account UUID and must keep its live deadline.
          expect(after.main?.lastQuotaApiError).toMatchObject({
            accountIdentity: identity,
            status: 429,
            nextRetryAt: quotaRetryAt,
          })
          expect(after.main?.lastQuotaApiError?.nextRetryAt).toBeGreaterThan(
            Date.now(),
          )
        } else expect(after.main?.lastQuotaApiError).toBeUndefined()
        expect(
          (await waitForPoolCredential('main', successor.access)).credential
            .refresh,
        ).toBe(successor.refresh)
        expect(mockClient.auth.set).not.toHaveBeenCalled()
      },
    )
  }

  test('fallback-first uses stale passing fallback quota while quota refresh is in progress even when main refresh is backed off', async () => {
    const now = Date.now()
    const expiredMain = {
      access: 'sk-ant-oat01-main-access',
      refresh: 'main-refresh',
      expires: now - 1_000,
    }
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          refresh: {
            enabled: true,
            intervalMinutes: 10,
            refreshBeforeExpiryMinutes: 240,
            mainLastRefreshError: {
              message:
                'Claude OAuth refresh failed: 400 — {"error":"invalid_grant"}',
              checkedAt: now,
              nextRetryAt: now + 60_000,
              retryCount: 1,
              tokenHash: hashRefreshToken('main-refresh'),
            },
          },
          accounts: [
            {
              id: 'fallback-1',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: now + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 25,
                  remainingPercent: 75,
                  checkedAt: now - 10 * 60_000,
                  resetsAt: '2099-01-01T00:00:00Z',
                },
                seven_day: {
                  usedPercent: 30,
                  remainingPercent: 70,
                  checkedAt: now - 10 * 60_000,
                  resetsAt: '2099-01-01T00:00:00Z',
                },
              },
            },
          ],
        }),
      ),
      expiredMain,
    )
    const authorizations: string[] = []

    globalThis.fetch = mock(
      withNativeBootstrap((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          throw new Error('Quota refresh is already in progress')
        }
        if (url.includes('/v1/oauth/token')) {
          throw new Error('main refresh should not be attempted')
        }
        authorizations.push(
          new Headers(init?.headers).get('authorization') ?? '',
        )
        return Promise.resolve(new Response('fallback-ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(createMockClient())
    const result = await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth', ...expiredMain }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('fallback-ok')
    expect(authorizations).toEqual(['Bearer sk-ant-oat01-fallback-access'])
  })

  test('fetch wrapper refreshes expired token', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }), {
      access: 'sk-ant-oat01-expired-token',
      refresh: 'old-refresh',
      expires: Date.now() - 1000,
    })
    mainAccountIssues('sk-ant-oat01-new-access')
    const fetchCalls: Array<{ url: string; body?: string }> = []

    globalThis.fetch = mock(
      withNativeBootstrap((input: any, init: any) => {
        const url = extractUrl(input)
        fetchCalls.push({ url, body: init?.body })

        if (url.includes('/v1/oauth/token')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                refresh_token: 'new-refresh',
                access_token: 'sk-ant-oat01-new-access',
                expires_in: 3600,
              }),
              { status: 200 },
            ),
          )
        }

        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)

    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-expired-token',
          refresh: 'old-refresh',
          expires: Date.now() - 1000, // expired
        }),
      { models: {} },
    )

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })

    // Should have called token endpoint first
    const tokenCall = fetchCalls.find((c) => c.url.includes('/v1/oauth/token'))
    expect(tokenCall).toBeDefined()
    expect(tokenCall!.url).toBe('https://platform.claude.com/v1/oauth/token')
    const tokenBody = JSON.parse(tokenCall!.body!)
    expect(tokenBody.grant_type).toBe('refresh_token')
    expect(tokenBody.refresh_token).toBe('old-refresh')

    // The new tokens are stored in the native account pool, where the next
    // caller receives them; OpenCode's auth store keeps only the placeholder
    // login and is not written.
    expect(await poolMainAccess()).toBe('sk-ant-oat01-new-access')
    expect(mockClient.auth.set).not.toHaveBeenCalled()
    await expectHostActivationNonSecret(
      'sk-ant-oat01-new-access',
      'new-refresh',
    )
  })

  test('fetch wrapper retries transient token refresh failures', async () => {
    await useTempAccountFile(
      bindMainAccount(
        createFallbackStorage({ accounts: [], quota: { enabled: false } }),
        'sk-ant-oat01-expired',
      ),
      {
        access: 'sk-ant-oat01-expired',
        refresh: 'refresh',
        expires: Date.now() - 1000,
      },
    )
    let tokenRefreshCalls = 0
    const setTimeoutMock = mock((handler: () => unknown) => {
      handler()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    mainAccountIssues('sk-ant-oat01-new-access')
    const modelAuthorizations: Array<string | null> = []
    globalThis.fetch = mock(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const admitted = await nativeBootstrapAnswer(input, init)
        if (admitted) return admitted
        const url = extractUrl(input)
        if (url.includes('/v1/messages'))
          modelAuthorizations.push(
            new Headers(init?.headers).get('authorization'),
          )
        if (url.includes('/v1/oauth/token')) {
          tokenRefreshCalls += 1

          if (tokenRefreshCalls === 1) {
            return Promise.resolve(
              new Response('Temporary failure', { status: 500 }),
            )
          }

          return Promise.resolve(
            new Response(
              JSON.stringify({
                refresh_token: 'new-refresh',
                access_token: 'sk-ant-oat01-new-access',
                expires_in: 3600,
              }),
              { status: 200 },
            ),
          )
        }

        return Promise.resolve(new Response(null, { status: 200 }))
      },
    ) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, undefined, {
      setTimeout: setTimeoutMock,
    })
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-expired',
          refresh: 'refresh',
          expires: Date.now() - 1000,
        }),
      { models: {} },
    )

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })

    expect(tokenRefreshCalls).toBe(2)
    expect(modelAuthorizations).toEqual(['Bearer sk-ant-oat01-new-access'])
    expect(
      (await waitForPoolCredential('main', 'sk-ant-oat01-new-access'))
        .credential.refresh,
    ).toBe('new-refresh')
    // Retry belongs to the shared coordinator. The host must not add another
    // retry loop or write the resulting secret into its activation slot.
    expect(setTimeoutMock).not.toHaveBeenCalled()
    expect(mockClient.auth.set).not.toHaveBeenCalled()
  })

  test('fetch wrapper keeps main oauth retry count bounded when helper also supports retries', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }), {
      access: 'sk-ant-oat01-expired',
      refresh: 'refresh',
      expires: Date.now() - 1000,
    })
    let tokenRefreshCalls = 0
    const setTimeoutMock = mock((handler: () => unknown) => {
      handler()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        tokenRefreshCalls += 1
        return Promise.resolve(
          new Response('Temporary failure', { status: 500 }),
        )
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin(createMockClient(), undefined, {
      setTimeout: setTimeoutMock,
    })
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-expired',
          refresh: 'refresh',
          expires: Date.now() - 1000,
        }),
      { models: {} },
    )

    await expect(
      result.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow('Claude OAuth refresh failed: 500')

    expect(tokenRefreshCalls).toBe(3)
  })

  test('fetch wrapper does not retry non-transient token refresh failures', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }), {
      access: 'sk-ant-oat01-expired',
      refresh: 'refresh',
      expires: Date.now() - 1000,
    })
    let tokenRefreshCalls = 0

    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        tokenRefreshCalls += 1
        return Promise.resolve(new Response('Forbidden', { status: 403 }))
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-expired',
          refresh: 'refresh',
          expires: Date.now() - 1000,
        }),
      { models: {} },
    )

    await expect(
      result.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow('Claude OAuth refresh failed: 403')

    expect(tokenRefreshCalls).toBe(1)
  })

  test('fetch wrapper strips tool prefix from streaming response', async () => {
    await useTempAccountFile(
      createFallbackStorage({ accounts: [], quota: { enabled: false } }),
      {
        access: 'sk-ant-oat01-token',
        refresh: 'refresh',
        expires: Date.now() + 100000,
      },
    )
    const encoder = new TextEncoder()
    const responseStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_bash"}}\n\n',
          ),
        )
        controller.close()
      },
    })

    globalThis.fetch = mock(
      withNativeAdmission(() =>
        Promise.resolve(new Response(responseStream, { status: 200 })),
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          stream: true,
          tools: [
            { name: 'bash', input_schema: { type: 'object', properties: {} } },
          ],
        }),
      },
    )

    const text = await response.text()
    expect(text).toContain('"name":"bash"')
    expect(text).not.toContain('mcp_bash')
  })

  test('concurrent expired token refresh should deduplicate to a single token request', async () => {
    let tokenRefreshCount = 0

    globalThis.fetch = mock(
      withNativeBootstrap((input: any) => {
        const url = extractUrl(input)

        if (url.includes('/v1/oauth/token')) {
          tokenRefreshCount++
          return Promise.resolve(
            new Response(
              JSON.stringify({
                refresh_token: 'new-refresh',
                access_token: 'sk-ant-oat01-new-access',
                expires_in: 3600,
              }),
              { status: 200 },
            ),
          )
        }

        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const { result } = await setupExpiredTokenLoader('sk-ant-oat01-new-access')
    await fireConcurrentFetches(result)

    // With deduplication, only ONE refresh request should be made, not 5
    expect(tokenRefreshCount).toBe(1)
  })

  test('plugin instances sharing main auth join a refresh while auth persistence is delayed', async () => {
    await useTempAccountFile(
      createFallbackStorage({ accounts: [], quota: { enabled: false } }),
      {
        access: 'sk-ant-oat01-expired-token',
        refresh: 'old-refresh',
        expires: Date.now() - 1_000,
      },
    )
    mainAccountIssues('sk-ant-oat01-new-access')
    let tokenRefreshCount = 0
    // Hold the first plugin's exchange open while the second requests
    // credentials. Both must join one refresh, and only the pool stores
    // the returned tokens; OpenCode's activation slot stays unchanged.
    const tokenRequestStarted = lifetimeSignal()
    const tokenResponse = heldResponse()

    globalThis.fetch = mock(
      withNativeBootstrap((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/v1/oauth/token')) {
          tokenRefreshCount += 1
          tokenRequestStarted.raise()
          return tokenResponse.response
        }
        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const firstClient = createMockClient()
    const secondClient = createMockClient()
    let secondTimerCalls = 0
    const secondRefreshWait = mock(() => {
      secondTimerCalls += 1
      throw new Error('second plugin entered the cross-process refresh wait')
    }) as unknown as typeof setTimeout
    const firstPlugin = await getPlugin(firstClient, '/project-a')
    const secondPlugin = await getPlugin(secondClient, '/project-b', {
      setTimeout: secondRefreshWait,
    })
    const expiredAuth = () =>
      Promise.resolve({
        type: 'oauth' as const,
        access: 'sk-ant-oat01-expired-token',
        refresh: 'old-refresh',
        expires: Date.now() - 1_000,
      })
    const firstResult = await firstPlugin.auth.loader(expiredAuth, {
      models: {},
    })
    const secondResult = await secondPlugin.auth.loader(expiredAuth, {
      models: {},
    })

    const firstFetch = firstResult.fetch(MESSAGES_URL, EMPTY_POST)
    await tokenRequestStarted.raised
    const secondFetch = secondResult.fetch(MESSAGES_URL, EMPTY_POST)
    await Bun.sleep(0)
    tokenResponse.release(
      new Response(
        JSON.stringify({
          refresh_token: 'new-refresh',
          access_token: 'sk-ant-oat01-new-access',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    )

    const responses = await Promise.all([firstFetch, secondFetch]).catch(
      (error) => {
        console.error('shared native refresh mismatch', {
          tokenRefreshCount,
          secondTimerCalls,
        })
        throw error
      },
    )
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(tokenRefreshCount).toBe(1)
    expect(secondRefreshWait).not.toHaveBeenCalled()
    // Both instances share the one refreshed login through the pool, and
    // neither writes token material to OpenCode's auth store.
    expect(await poolMainAccess()).toBe('sk-ant-oat01-new-access')
    expect(tokenRefreshCount).toBe(1)
    expect(firstClient.auth.set).not.toHaveBeenCalled()
    expect(secondClient.auth.set).not.toHaveBeenCalled()
    await expectHostActivationNonSecret(
      'sk-ant-oat01-new-access',
      'new-refresh',
    )
  })

  for (const duringRefresh of [false, true]) {
    test(
      duringRefresh
        ? 'sticky 401 retry persists consumed successor but refuses it after host activation changes'
        : 'sticky 401 retry refuses a foreign-provider tombstone before the token endpoint',
      async () => {
        const checkedAt = Date.now()
        const login = {
          access: 'sk-ant-oat01-live-main-access',
          refresh: 'live-main-refresh',
          expires: checkedAt + 8 * 60 * 60_000,
        }
        await useTempAccountFile(
          bindMainQuotaToAccount(
            createFallbackStorage({
              accounts: [],
              routing: { mode: 'sticky-balanced' },
              quota: {
                enabled: true,
                checkIntervalMinutes: 5,
                minimumRemaining: { five_hour: 1, seven_day: 1 },
                failClosedOnUnknownQuota: true,
                mainQuota: {
                  checkedAt,
                  five_hour: {
                    usedPercent: 10,
                    remainingPercent: 90,
                    checkedAt,
                  },
                  seven_day: {
                    usedPercent: 10,
                    remainingPercent: 90,
                    checkedAt,
                  },
                },
                mainQuotaCheckedAt: checkedAt,
              },
            }),
            login.access,
          ),
          login,
        )
        const pool = testContext.migratedPool
        if (!pool) throw new Error('Expected migrated pool')
        const hostAuthPath = pool.hostAuthPath
        const messageAuthorizations: string[] = []
        const tokenEndpointCalls: string[] = []
        const successor = {
          access: 'sk-ant-oat01-consumed-revoked',
          refresh: 'consumed-revoked-refresh',
        }
        mainAccountIssues(successor.access)
        async function revokeActivation() {
          const authFile = JSON.parse(await readFile(hostAuthPath, 'utf8'))
          authFile.anthropic = {
            ...custodyTombstoneOAuth('openai'),
            access: 'claustrum-tombstone:v1:openai',
            expires: 0,
          }
          await writeFile(hostAuthPath, JSON.stringify(authFile), {
            mode: 0o600,
          })
        }
        globalThis.fetch = mock(
          withNativeBootstrap(
            async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
              const url = extractUrl(input)
              if (url === TOKEN_URL) {
                tokenEndpointCalls.push(url)
                if (duringRefresh) {
                  await revokeActivation()
                  return Response.json({
                    access_token: successor.access,
                    refresh_token: successor.refresh,
                    expires_in: 8 * 60 * 60,
                  })
                }
                return Promise.resolve(
                  new Response('unexpected', { status: 200 }),
                )
              }
              if (url.includes('/v1/messages')) {
                messageAuthorizations.push(
                  new Headers(init?.headers).get('authorization') ?? '',
                )
                if (!duringRefresh) await revokeActivation()
                return new Response('unauthorized', { status: 401 })
              }
              return Promise.resolve(new Response('{}', { status: 200 }))
            },
          ),
        ) as unknown as typeof fetch

        const plugin = await getPlugin()
        const result = await plugin.auth.loader(
          () => Promise.resolve({ type: 'oauth', ...login }),
          { models: {} },
        )

        let refusal: unknown
        try {
          await result.fetch(MESSAGES_URL, {
            method: 'POST',
            headers: { 'x-session-affinity': 'tombstone-sticky-401' },
            body: JSON.stringify({
              model: 'claude-opus-5',
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hello' }],
            }),
          })
        } catch (error) {
          refusal = error
        }
        expect(messageAuthorizations).toEqual([
          'Bearer sk-ant-oat01-live-main-access',
        ])
        expect(tokenEndpointCalls).toEqual(duringRefresh ? [TOKEN_URL] : [])
        if (duringRefresh) {
          // The provider already issued replacement credentials, so losing
          // them could leave only an invalid old refresh token. Removing
          // OpenCode's activation blocks model sends, not credential storage.
          expect(
            (await waitForPoolCredential('main', successor.access)).credential
              .refresh,
          ).toBe(successor.refresh)
        }
        expect(
          (await readNativeRuntimeState()).main?.lastRefreshError,
        ).toBeUndefined()
        expect(refusal).toBeInstanceOf(Error)
        expect(
          refusal instanceof Error ? refusal.message : undefined,
        ).toContain('Native OAuth requires inert OpenCode activation')
        await plugin.dispose?.()
      },
    )
  }

  test('physical OAuth authorization refuses host revocation during fresh token validation', async () => {
    const checkedAt = Date.now()
    const login = {
      access: 'sk-ant-oat01-validation-initial',
      refresh: 'validation-refresh',
      expires: checkedAt + 8 * 60 * 60_000,
    }
    const successorAccess = 'sk-ant-oat01-validation-rotated'
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          routing: { mode: 'fallback-first' },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 1, seven_day: 1 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              checkedAt,
              five_hour: { usedPercent: 10, remainingPercent: 90, checkedAt },
              seven_day: { usedPercent: 10, remainingPercent: 90, checkedAt },
            },
            mainQuotaCheckedAt: checkedAt,
          },
        }),
        login.access,
      ),
      login,
    )
    const pool = testContext.migratedPool
    if (!pool) throw new Error('Expected migrated pool')
    const store = createNativePoolStore({
      paths: pool.paths,
      quota: nativeQuotaCodec,
    })
    let rotated = false
    let usableAuthorizations = 0
    const factory = Core.createNativeAccountRuntime
    const factorySpy = spyOn(
      Core,
      'createNativeAccountRuntime',
    ).mockImplementation((options) => {
      const runtime = factory(options)
      const authorize = runtime.authorizeLocal.bind(runtime)
      runtime.authorizeLocal = async (...args) => {
        const authorization = await authorize(...args)
        if (authorization.status === 'usable' && ++usableAuthorizations === 2) {
          rotated = true
          const settings = await store.readSettings()
          if (
            settings.status !== 'ready' ||
            typeof settings.settings.mainAccountId !== 'string'
          )
            throw new Error('Expected primary row')
          // The request reads its credential, then chooses a route before sending.
          // Rotate after both steps have authorized the old pool token. The next
          // authorizeLocal call is the last credential check before dispatch.
          // Its /api/claude_cli/bootstrap mock below replaces the Anthropic auth
          // slot with an OpenAI placeholder, which must prevent the model send.
          // Keep host-auth reads passive so extra reads cannot move this revocation.
          await store.rotate(settings.settings.mainAccountId, {
            type: 'oauth',
            access: successorAccess,
            refresh: login.refresh,
            expires: login.expires + 1000,
          })
        }
        return authorization
      }
      return runtime
    })
    bodyLifetime().deferCleanup(() => {
      factorySpy.mockRestore()
    })
    const bootstraps: Array<string | null> = []
    const modelAuthorizations: Array<string | null> = []
    let tokenCalls = 0
    globalThis.fetch = Object.assign(
      mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = extractUrl(input)
        const bearer = new Headers(init?.headers).get('authorization')
        if (url.includes('/api/claude_cli/bootstrap')) {
          bootstraps.push(bearer)
          if (bearer === `Bearer ${successorAccess}`) {
            const authFile = JSON.parse(
              await readFile(pool.hostAuthPath, 'utf8'),
            )
            authFile.anthropic = {
              ...custodyTombstoneOAuth('openai'),
              access: 'claustrum-tombstone:v1:openai',
              expires: 0,
            }
            await writeFile(pool.hostAuthPath, JSON.stringify(authFile), {
              mode: 0o600,
            })
          } else if (bearer !== `Bearer ${login.access}`)
            throw new Error('Unexpected bootstrap credential')
          return Response.json({
            oauth_account: { account_uuid: syntheticMainAccountUuid },
          })
        }
        if (url === TOKEN_URL) tokenCalls++
        if (url.includes('/v1/messages')) modelAuthorizations.push(bearer)
        return Response.json({})
      }),
      { preconnect() {} },
    )
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      async () => ({ type: 'oauth', ...login }),
      { models: {} },
    )
    let refusal: unknown
    try {
      await result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'revoked-token-validation' },
        body: JSON.stringify({
          model: 'claude-opus-5',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
    } catch (error) {
      refusal = error
    }
    expect(rotated).toBe(true)
    expect(bootstraps).toEqual([
      `Bearer ${login.access}`,
      `Bearer ${successorAccess}`,
    ])
    expect(modelAuthorizations).toEqual([])
    expect(tokenCalls).toBe(0)
    expect(refusal instanceof Error ? refusal.message : undefined).toContain(
      'Native OAuth requires inert OpenCode activation',
    )
    expect(
      (await waitForPoolCredential('main', successorAccess)).credential.refresh,
    ).toBe(login.refresh)
    expect(
      (await readNativeRuntimeState()).main?.lastRefreshError,
    ).toBeUndefined()
  })

  test('sticky 401 retries with a concurrently rotated main access token', async () => {
    const checkedAt = Date.now()
    const oldLogin = {
      access: 'sk-ant-oat01-old-access',
      refresh: 'old-refresh',
      expires: checkedAt + 8 * 60 * 60_000,
    }
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          routing: { mode: 'sticky-balanced' },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 1, seven_day: 1 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              checkedAt,
              five_hour: {
                usedPercent: 10,
                remainingPercent: 90,
                checkedAt,
              },
              seven_day: {
                usedPercent: 10,
                remainingPercent: 90,
                checkedAt,
              },
            },
            mainQuotaCheckedAt: checkedAt,
          },
        }),
        oldLogin.access,
      ),
      oldLogin,
    )
    let tokenRefreshCount = 0
    const messageAuthorizations: string[] = []
    globalThis.fetch = mock(
      withNativeBootstrap(async (input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        if (url.includes('/v1/oauth/token')) {
          tokenRefreshCount += 1
          return new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 400,
          })
        }
        if (url.includes('/v1/messages')) {
          const authorization =
            new Headers(init?.headers).get('authorization') ?? ''
          messageAuthorizations.push(authorization)
          if (authorization === 'Bearer sk-ant-oat01-old-access') {
            // Another OpenCode process refreshes the same account while this
            // request is in flight; the old access token is then rejected.
            await refreshPoolMainElsewhere({
              access: 'sk-ant-oat01-new-access',
              refresh: 'new-refresh',
              expires: checkedAt + 8 * 60 * 60_000,
            })
            return new Response('unauthorized', { status: 401 })
          }
          return new Response('{}', { status: 200 })
        }
        return new Response('{}', { status: 200 })
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth' as const, ...oldLogin }),
      {
        models: {},
      },
    )
    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses-refresh-race' },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(response.status).toBe(200)
    expect(messageAuthorizations).toEqual([
      'Bearer sk-ant-oat01-old-access',
      'Bearer sk-ant-oat01-new-access',
    ])
    expect(tokenRefreshCount).toBe(0)
  })

  test('serves an existing sticky assignment with a live token', async () => {
    const checkedAt = Date.now()
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          routing: { mode: 'sticky-balanced' },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 1, seven_day: 1 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              checkedAt,
              five_hour: {
                usedPercent: 10,
                remainingPercent: 90,
                checkedAt,
              },
              seven_day: {
                usedPercent: 10,
                remainingPercent: 90,
                checkedAt,
              },
            },
            mainQuotaCheckedAt: checkedAt,
          },
        }),
      ),
    )
    const authorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init?: RequestInit) => {
        if (extractUrl(input).includes('/v1/messages')) {
          authorizations.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: checkedAt + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'unknown-identity-sticky' },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }

    const responses = await Promise.all([
      result.fetch(MESSAGES_URL, request),
      result.fetch(MESSAGES_URL, request),
    ])
    expect(authorizations).toEqual([
      'Bearer sk-ant-oat01-main-access',
      'Bearer sk-ant-oat01-main-access',
    ])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
  })

  test('admits and sends an OAuth route when an empty quota snapshot is fail-open', async () => {
    await useTempAccountFile(
      bindMainAccount(
        createFallbackStorage({
          accounts: [],
          routing: { mode: 'sticky-balanced' },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 1, seven_day: 1 },
            failClosedOnUnknownQuota: false,
          },
        }),
      ),
    )
    const usageRequests: string[] = []
    const messageAuthorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          usageRequests.push(url)
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        if (url.includes('/v1/messages')) {
          messageAuthorizations.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'truly-unknown-quota' },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(response.status).toBe(200)
    expect(usageRequests).toHaveLength(1)
    expect(messageAuthorizations).toEqual(['Bearer sk-ant-oat01-main-access'])
  })

  test('unknown identity routes when fail-open, then unknown quota blocks when fail-closed', async () => {
    const storage = createFallbackStorage({
      accounts: [],
      routing: { mode: 'main-first' },
      quota: {
        enabled: true,
        checkIntervalMinutes: 5,
        minimumRemaining: { five_hour: 1, seven_day: 1 },
        failClosedOnUnknownQuota: false,
      },
    })
    await useTempAccountFile(storage)
    const messageAuthorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response('quota unavailable', { status: 500 }),
          )
        }
        if (url.includes('/v1/messages')) {
          messageAuthorizations.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'unknown-identity-routes' },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }
    const routed = await result.fetch(MESSAGES_URL, request)
    expect(routed.status).toBe(200)

    await updatePoolSettings((settings) => ({
      ...settings,
      quota: { ...storage.quota, failClosedOnUnknownQuota: true },
    }))
    const blocked = await result.fetch(MESSAGES_URL, {
      ...request,
      headers: { 'x-session-affinity': 'unknown-quota-blocked' },
    })

    expect(blocked.status).toBe(429)
    expect(await blocked.clone().text()).toContain('Quota API')
    expect(messageAuthorizations).toEqual(['Bearer sk-ant-oat01-main-access'])
  })

  test('keeps a sticky main route excluded during identity-agnostic active refresh backoff', async () => {
    const checkedAt = Date.now()
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          routing: { mode: 'sticky-balanced' },
          refresh: {
            enabled: true,
            intervalMinutes: 10,
            refreshBeforeExpiryMinutes: 30,
            // Without an account UUID, the refresh-token hash identifies which
            // credential failed. Migration preserves that retry restriction.
            mainLastRefreshError: {
              message: 'refresh unavailable',
              checkedAt,
              nextRetryAt: checkedAt + 60_000,
              tokenHash: hashRefreshToken('main-refresh'),
            },
          },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 1, seven_day: 1 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              checkedAt,
              five_hour: {
                usedPercent: 10,
                remainingPercent: 90,
                checkedAt,
              },
              seven_day: {
                usedPercent: 10,
                remainingPercent: 90,
                checkedAt,
              },
            },
            mainQuotaCheckedAt: checkedAt,
          },
        }),
      ),
    )
    const messageRequests: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        if (extractUrl(input).includes('/v1/messages')) {
          messageRequests.push(extractUrl(input))
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: checkedAt + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'restricted-unknown-identity' },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(response.status).toBe(429)
    expect(messageRequests).toEqual([])
  })

  test('sticky-balanced routes with a valid fallback token during transient DNS refresh backoff', async () => {
    const now = Date.now()
    const result = await runStickyDnsBackoffScenario({
      tokenExpiresAt: now + 3 * 60 * 60_000,
      refreshErrorCheckedAt: now,
      refreshErrorNextRetryAt: now + 24 * 60 * 60_000,
      refreshErrorRetryCount: 1,
    })

    expect(result.response.status).toBe(200)
    expect(result.tokenRequests).toEqual([])
    expect(result.messageAuthorizations).toEqual([
      'Bearer sk-ant-oat01-initial-fallback-access',
    ])
  })

  test('sticky-balanced refreshes an expired fallback after repeated DNS failures', async () => {
    const now = Date.now()
    const result = await runStickyDnsBackoffScenario({
      tokenExpiresAt: now - 60_000,
      refreshErrorCheckedAt: now - 6 * 60_000,
      refreshErrorNextRetryAt: now + 54 * 60_000,
      refreshErrorRetryCount: 7,
    })

    expect(result.response.status).toBe(200)
    expect(result.tokenRequests).toHaveLength(1)
    expect(result.messageAuthorizations).toEqual([
      'Bearer sk-ant-oat01-refreshed-fallback-access',
    ])
  })

  test('concurrent refresh with token rotation should not cause cascading failures', async () => {
    const usedRefreshTokens = new Set<string>()

    globalThis.fetch = mock(
      withNativeBootstrap((input: any, init: any) => {
        const url = extractUrl(input)

        if (url.includes('/v1/oauth/token')) {
          const body = JSON.parse(String(init?.body))
          const refreshToken = body.refresh_token ?? ''

          // Simulate refresh token rotation: first use succeeds, subsequent uses
          // return 401 because the old token has been invalidated
          if (usedRefreshTokens.has(refreshToken)) {
            return Promise.resolve(
              new Response(JSON.stringify({ error: 'invalid_grant' }), {
                status: 401,
              }),
            )
          }

          usedRefreshTokens.add(refreshToken)
          return Promise.resolve(
            new Response(
              JSON.stringify({
                refresh_token: 'rotated-refresh',
                access_token: 'sk-ant-oat01-new-access',
                expires_in: 3600,
              }),
              { status: 200 },
            ),
          )
        }

        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const { result } = await setupExpiredTokenLoader('sk-ant-oat01-new-access')

    // Fire 5 concurrent requests — ALL should succeed because only one refresh
    // fires and the rest reuse its result
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        result.fetch(MESSAGES_URL, EMPTY_POST).then(
          () => 'ok' as const,
          () => 'fail' as const,
        ),
      ),
    )

    // With deduplication, all callers share the single successful refresh.
    // Without it, 4 out of 5 get 401 from the rotated-away token → cascading failures.
    expect(outcomes).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
  })

  test('concurrent refresh should persist tokens exactly once', async () => {
    let tokenRefreshCount = 0
    const messageAuthorizations: string[] = []
    globalThis.fetch = mock(
      withNativeBootstrap((input: any, init?: RequestInit) => {
        const url = extractUrl(input)

        if (url.includes('/v1/oauth/token')) {
          tokenRefreshCount++
          return Promise.resolve(
            new Response(
              JSON.stringify({
                refresh_token: 'new-refresh',
                access_token: 'sk-ant-oat01-new-access',
                expires_in: 3600,
              }),
              { status: 200 },
            ),
          )
        }
        if (url.includes('/v1/messages'))
          messageAuthorizations.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )

        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const { mockClient, result } = await setupExpiredTokenLoader(
      'sk-ant-oat01-new-access',
    )
    await fireConcurrentFetches(result)

    // Refreshed main tokens are stored in the native account pool, never in
    // OpenCode's auth store, which keeps only the placeholder login. All five
    // requests use the single refreshed token, and the pool hands that same
    // token to a later caller without another token request: the refresh was
    // persisted once and reused, not repeated per request.
    expect(mockClient.auth.set).not.toHaveBeenCalled()
    await expectHostActivationNonSecret(
      'sk-ant-oat01-new-access',
      'new-refresh',
    )
    expect(messageAuthorizations).toEqual(
      Array.from({ length: 5 }, () => 'Bearer sk-ant-oat01-new-access'),
    )
    expect(await poolMainAccess()).toBe('sk-ant-oat01-new-access')
    expect(tokenRefreshCount).toBe(1)
  })

  test('refresh always reads the latest refresh token, not a stale snapshot', async () => {
    const tokenRequestBodies: string[] = []
    const staleLogin = {
      access: 'sk-ant-oat01-expired-access',
      refresh: 'stale-refresh',
      expires: Date.now() - 1000,
    }
    await useTempAccountFile(
      createFallbackStorage({ accounts: [] }),
      staleLogin,
    )
    mainAccountIssues('sk-ant-oat01-fresh-access')

    globalThis.fetch = mock(
      withNativeBootstrap((input: any, init: any) => {
        const url = extractUrl(input)

        if (url.includes('/v1/oauth/token')) {
          tokenRequestBodies.push(init?.body)
          return Promise.resolve(
            new Response(
              JSON.stringify({
                refresh_token: 'rotated-refresh',
                access_token: 'sk-ant-oat01-fresh-access',
                expires_in: 3600,
              }),
              { status: 200 },
            ),
          )
        }

        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)

    const result = await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth', ...staleLogin }),
      { models: {} },
    )
    // After the loader started, a re-login elsewhere stores a newer refresh
    // token for the same account in the pool. The refresh must use it.
    await replacePoolMainLogin({
      access: 'sk-ant-oat01-expired-access',
      refresh: 'rotated-refresh-from-storage',
      expires: Date.now() - 1000,
    })

    await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(tokenRequestBodies).toHaveLength(1)
    const sentBody = JSON.parse(tokenRequestBodies[0] ?? '{}')
    expect(sentBody.refresh_token).toBe('rotated-refresh-from-storage')
    expect(sentBody.refresh_token).not.toBe('stale-refresh')
  })

  test('fetch wrapper adds beta=true to /v1/messages URL', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }), {
      access: 'sk-ant-oat01-token',
      refresh: 'refresh',
      expires: Date.now() + 100000,
    })
    let capturedUrl: string | undefined

    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        capturedUrl = url
        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })

    expect(capturedUrl).toContain('beta=true')
  })

  test('fetch wrapper retries with a fallback account on configured status', async () => {
    await useTempAccountFile(createFallbackStorage())
    const authorizations: string[] = []

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        if (extractUrl(input).includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        const authHeader = init?.headers?.get('authorization')
        authorizations.push(authHeader)
        if (authHeader === 'Bearer sk-ant-oat01-main-access') {
          return Promise.resolve(new Response('limited', { status: 429 }))
        }
        return Promise.resolve(new Response('ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(authorizations).toEqual([
      'Bearer sk-ant-oat01-main-access',
      'Bearer sk-ant-oat01-fallback-access',
    ])
  })

  test('fetch wrapper uses fallback first when routing mode is fallback-first', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({ routing: { mode: 'fallback-first' } }),
      ),
    )
    const authorizations: string[] = []

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        if (extractUrl(input).includes('/api/oauth/usage')) {
          throw new Error('fallback-first should use cached quota in this test')
        }
        authorizations.push(init?.headers?.get('authorization'))
        return Promise.resolve(new Response('fallback ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('fallback ok')
    expect(authorizations).toEqual(['Bearer sk-ant-oat01-fallback-access'])
  })

  test('main-first tries an OAuth fallback whose quota is unknown after main fails', async () => {
    const expires = Date.now() + 5 * 60 * 60_000
    await useTempAccountFile(
      createFallbackStorage({
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: false,
        },
        accounts: [
          {
            id: 'unknown-fallback',
            type: 'oauth',
            access: 'sk-ant-oat01-unknown-fallback-access',
            refresh: 'unknown-fallback-refresh',
            expires,
          },
        ],
      }),
    )
    const authorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.reject(new Error('quota source unavailable'))
        }
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        authorizations.push(authorization)
        return Promise.resolve(
          new Response(
            authorization === 'Bearer sk-ant-oat01-main-access'
              ? 'limited'
              : 'ok',
            {
              status:
                authorization === 'Bearer sk-ant-oat01-main-access' ? 429 : 200,
            },
          ),
        )
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)
    expect(authorizations).toEqual([
      'Bearer sk-ant-oat01-main-access',
      'Bearer sk-ant-oat01-unknown-fallback-access',
    ])
  })

  test('fallback-first tries an OAuth fallback whose quota is unknown before main', async () => {
    const expires = Date.now() + 5 * 60 * 60_000
    // The account is known; only its quota is unknown.
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          quota: {
            ...createFallbackStorage().quota,
            failClosedOnUnknownQuota: false,
          },
          accounts: [
            {
              id: 'unknown-fallback',
              type: 'oauth',
              access: 'sk-ant-oat01-unknown-fallback-access',
              refresh: 'unknown-fallback-refresh',
              expires,
            },
          ],
        }),
      ),
    )
    const authorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.reject(new Error('quota source unavailable'))
        }
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        authorizations.push(authorization)
        return Promise.resolve(new Response('fallback ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('fallback ok')
    expect(authorizations).toEqual([
      'Bearer sk-ant-oat01-unknown-fallback-access',
    ])
  })

  test('fallback-first rejects an OAuth fallback whose quota is unknown under fail-closed', async () => {
    await expectUnknownQuotaAdmissionBlocked(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          accounts: [
            {
              id: 'unknown-fallback',
              type: 'oauth',
              access: 'sk-ant-oat01-unknown-fallback-access',
              refresh: 'unknown-fallback-refresh',
              expires: Date.now() + 5 * 60 * 60_000,
            },
          ],
        }),
      ),
    )
  })

  test('successful fallback-first request advances the every-N counter and refreshes the served fallback', async () => {
    // The request counter must increment before the fallback-first
    // early return, so a served fallback's active-route every-N refresh fires.
    await useTempAccountFile(
      createFallbackStorage({
        routing: { mode: 'fallback-first' },
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          refreshEveryNRequests: 1,
          mainQuota: {
            five_hour: {
              usedPercent: 0,
              remainingPercent: 100,
              checkedAt: Date.now(),
            },
            seven_day: {
              usedPercent: 0,
              remainingPercent: 100,
              checkedAt: Date.now(),
            },
          },
          mainQuotaCheckedAt: Date.now(),
          mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
        },
      }),
    )
    const usageTokens: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          usageTokens.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 20 },
                seven_day: { utilization: 20 },
              }),
              { status: 200 },
            ),
          )
        }
        return Promise.resolve(new Response('fallback ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('fallback ok')

    // The active-route refresh is fire-and-forget; wait for it to land.
    for (
      let i = 0;
      i < 50 && !usageTokens.includes('Bearer sk-ant-oat01-fallback-access');
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(usageTokens).toContain('Bearer sk-ant-oat01-fallback-access')
  })

  test('fallback-first routing does not refresh expired main oauth when fallback succeeds', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          refresh: { enabled: false },
        }),
      ),
      {
        access: 'sk-ant-oat01-expired-main-access',
        refresh: 'main-refresh',
        expires: Date.now() - 1000,
      },
    )
    let tokenRefreshCalls = 0
    const authorizations: string[] = []

    globalThis.fetch = mock(
      withNativeBootstrap((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/v1/oauth/token')) {
          tokenRefreshCalls += 1
          return Promise.resolve(
            new Response('should not refresh', { status: 500 }),
          )
        }
        if (url.includes('/api/oauth/usage')) {
          throw new Error('fallback-first should use cached quota in this test')
        }
        authorizations.push(init?.headers?.get('authorization'))
        return Promise.resolve(new Response('fallback ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-expired-main-access',
          refresh: 'main-refresh',
          expires: Date.now() - 1000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('fallback ok')
    expect(tokenRefreshCalls).toBe(0)
    expect(authorizations).toEqual(['Bearer sk-ant-oat01-fallback-access'])
  })

  test('fallback-first routing tries main when no fallback account is usable', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          accounts: [
            {
              id: 'fallback-low',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: Date.now() + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 95,
                  remainingPercent: 5,
                  checkedAt: Date.now(),
                },
                seven_day: {
                  usedPercent: 10,
                  remainingPercent: 90,
                  checkedAt: Date.now(),
                },
              },
            },
          ],
        }),
      ),
    )
    const authorizations: string[] = []

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        if (extractUrl(input).includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        authorizations.push(init?.headers?.get('authorization'))
        return Promise.resolve(new Response('main ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('main ok')
    expect(authorizations).toEqual(['Bearer sk-ant-oat01-main-access'])
  })

  test('fetch wrapper skips main account when quota policy is already exhausted', async () => {
    await useTempAccountFile(bindPoolAccounts(createFallbackStorage()))
    const messageAuthorizations: string[] = []

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 100 },
              }),
              { status: 200 },
            ),
          )
        }

        messageAuthorizations.push(init?.headers?.get('authorization'))
        return Promise.resolve(new Response('fallback ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('fallback ok')
    expect(messageAuthorizations).toEqual([
      'Bearer sk-ant-oat01-fallback-access',
    ])
  })

  test('quota refresh toasts are disabled by default', async () => {
    const storage = createFallbackStorage({ accounts: [] })
    await useTempAccountFile(storage)
    const showToast = mock(() => Promise.resolve())
    const mockClient = {
      ...createMockClient(),
      tui: { showToast },
    }

    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0.25 },
                seven_day: { utilization: 0.3 },
              }),
              { status: 200 },
            ),
          )
        }
        return Promise.resolve(new Response('main ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient as any)
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(showToast).not.toHaveBeenCalled()
  })

  test('quota refresh toasts can be enabled explicitly', async () => {
    const storage = createFallbackStorage({ accounts: [] })
    storage.quota = { ...storage.quota, showToasts: true }
    await useTempAccountFile(storage)
    const showToast = mock(() => Promise.resolve())
    const mockClient = {
      ...createMockClient(),
      tui: { showToast },
    }

    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0.25 },
                seven_day: { utilization: 0.3 },
              }),
              { status: 200 },
            ),
          )
        }
        return Promise.resolve(new Response('main ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient as any)
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'Claude Quota',
        message: expect.stringContaining('main · active'),
        variant: 'info',
        duration: 5000,
      },
    })
  })

  test('fetch wrapper caches exhausted main quota until reset time', async () => {
    await useTempAccountFile(bindPoolAccounts(createFallbackStorage()))
    let quotaCalls = 0
    const messageAuthorizations: string[] = []
    const resetAt = new Date(Date.now() + 18 * 60 * 60 * 1000).toISOString()

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          quotaCalls += 1
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 100, resets_at: resetAt },
              }),
              { status: 200 },
            ),
          )
        }

        messageAuthorizations.push(init?.headers?.get('authorization'))
        return Promise.resolve(new Response('fallback ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, EMPTY_POST)
    await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(quotaCalls).toBe(1)
    expect(messageAuthorizations).toEqual([
      'Bearer sk-ant-oat01-fallback-access',
      'Bearer sk-ant-oat01-fallback-access',
    ])
  })

  test('fetch wrapper refreshes stale usable main quota in background', async () => {
    const originalDateNow = Date.now
    let now = originalDateNow()
    Date.now = mock(() => now) as unknown as typeof Date.now
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: {
          enabled: true,
          checkIntervalMinutes: 1,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: true,
        },
      }),
    )

    let quotaCalls = 0
    let messageCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          quotaCalls += 1
          if (quotaCalls > 1) return new Promise<Response>(() => {})
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        messageCalls += 1
        return Promise.resolve(
          new Response(`message-${messageCalls}`, { status: 200 }),
        )
      }),
    ) as unknown as typeof fetch

    try {
      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth',
            access: 'sk-ant-oat01-main-access',
            refresh: 'main-refresh',
            expires: now + 1_000_000,
          }),
        { models: {} },
      )

      expect(await (await result.fetch(MESSAGES_URL, EMPTY_POST)).text()).toBe(
        'message-1',
      )
      now += 120000
      // The second quota fetch never resolves. A correct background refresh
      // still lets the model response settle; a blocking implementation hits
      // this deadlock backstop regardless of machine speed.
      let timeout: ReturnType<typeof setTimeout> | undefined
      const second = await Promise.race([
        result
          .fetch(MESSAGES_URL, EMPTY_POST)
          .then((response: Response) => response.text()),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('model request blocked on quota refresh')),
            2_000,
          )
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout)
      })

      expect(second).toBe('message-2')
      // Background quota refresh involves file-lock I/O; poll until it fires
      // instead of sleeping a fixed interval (flaky under CI load). Date.now
      // is mocked here, so the deadline uses the real clock.
      const refreshDeadline = originalDateNow() + 5000
      while (quotaCalls < 2 && originalDateNow() < refreshDeadline) {
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(quotaCalls).toBe(2)
      expect(messageCalls).toBe(2)
    } finally {
      Date.now = originalDateNow
    }
  })

  test('async main refresh does not clobber the active fallback in the sidebar', async () => {
    const staleCheckedAt = Date.now() - 100 * 60_000 // far past → main quota is stale
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            // The cached five-hour quota is stale, with 5% remaining below the 10% routing minimum.
            mainQuota: {
              five_hour: {
                usedPercent: 95,
                remainingPercent: 5,
                checkedAt: staleCheckedAt,
              },
              seven_day: {
                usedPercent: 10,
                remainingPercent: 90,
                checkedAt: staleCheckedAt,
              },
            },
            mainQuotaCheckedAt: staleCheckedAt,
            // Associate the cached main quota with the fingerprint of the loader's access token.
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          } as AccountStorage['quota'],
        }),
      ),
    )

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0.95 },
                seven_day: { utilization: 0.1 },
              }),
              { status: 200 },
            ),
          )
        }
        // Anthropic messages call — fallback serves 200, main would not be reached.
        return Promise.resolve(new Response('ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    await drainSidebarWrites()

    // Fallback served → active id should be the fallback.
    const state = await waitForSidebarState(
      (candidate) =>
        candidate.activeId === 'fallback-1' && candidate.route === 'fallback',
    )
    expect(state.route).toBe('fallback')

    // The callback must preserve the active fallback instead of selecting main.
    const after = await getSidebarState()
    expect(after.activeId).toBe('fallback-1')
  })

  test('fetch wrapper retries with fallback when main streaming body reports rate limit', async () => {
    await useTempAccountFile(bindPoolAccounts(createFallbackStorage()))
    const authorizations: string[] = []

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        if (extractUrl(input).includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        const authHeader = init?.headers?.get('authorization')
        authorizations.push(authHeader)
        if (authHeader === 'Bearer sk-ant-oat01-main-access') {
          return Promise.resolve(
            new Response(
              'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account rate limit"}}\n\n',
              { status: 200 },
            ),
          )
        }
        return Promise.resolve(
          new Response('data: {"type":"message_stop"}\n\n', { status: 200 }),
        )
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('message_stop')
    expect(authorizations).toEqual([
      'Bearer sk-ant-oat01-main-access',
      'Bearer sk-ant-oat01-fallback-access',
    ])
  })

  test('fetch wrapper returns inspected streaming rate limit response when fallbacks are unavailable', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          accounts: [
            {
              id: 'fallback-low',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: Date.now() + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 95,
                  remainingPercent: 5,
                  checkedAt: Date.now(),
                },
                seven_day: {
                  usedPercent: 10,
                  remainingPercent: 90,
                  checkedAt: Date.now(),
                },
              },
            },
          ],
        }),
      ),
    )
    const authorizations: string[] = []

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        if (extractUrl(input).includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        authorizations.push(init?.headers?.get('authorization'))
        return Promise.resolve(
          new Response(
            'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account rate limit"}}\n\n',
            { status: 200 },
          ),
        )
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('rate_limit_error')
    expect(authorizations).toEqual(['Bearer sk-ant-oat01-main-access'])
  })

  test('fetch wrapper does not use fallback accounts below quota thresholds', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          accounts: [
            {
              id: 'fallback-low',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: Date.now() + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 95,
                  remainingPercent: 5,
                  checkedAt: Date.now(),
                },
                seven_day: {
                  usedPercent: 10,
                  remainingPercent: 90,
                  checkedAt: Date.now(),
                },
              },
            },
          ],
        }),
      ),
    )
    let calls = 0

    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        if (extractUrl(input).includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        calls += 1
        return Promise.resolve(new Response('limited', { status: 429 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(429)
    expect(await response.text()).toBe('limited')
    expect(calls).toBe(1)
  })

  test('fetch wrapper avoids fallback retries for non-replayable request bodies', async () => {
    await useTempAccountFile(bindPoolAccounts(createFallbackStorage()))
    let calls = 0
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello'))
        controller.close()
      },
    })

    globalThis.fetch = mock(
      withNativeAdmission(() => {
        calls += 1
        return Promise.resolve(new Response('limited', { status: 429 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: stream,
      duplex: 'half',
    })

    expect(response.status).toBe(429)
    expect(calls).toBe(1)
  })

  test('sticky-balanced assigns cold Fable to abundant quota and keeps Opus recovery on that account', async () => {
    const checkedAt = Date.now()
    const quota = (fableRemaining: number) => ({
      checkedAt,
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        checkedAt,
      },
      seven_day: {
        usedPercent: 100 - fableRemaining,
        remainingPercent: Math.max(40, fableRemaining),
        resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
        checkedAt,
      },
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100 - fableRemaining,
          remainingPercent: fableRemaining,
          resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
          checkedAt,
        },
      ],
    })
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'sticky-balanced' },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 1, seven_day: 1 },
            failClosedOnUnknownQuota: true,
            mainQuota: quota(0),
            mainQuotaCheckedAt: checkedAt,
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          },
          accounts: [
            {
              id: 'yiyi',
              type: 'oauth',
              access: 'sk-ant-oat01-scarce-access',
              refresh: 'scarce-refresh',
              expires: checkedAt + 5 * 60 * 60_000,
              quota: quota(13),
            },
            {
              id: 'ufuk2',
              type: 'oauth',
              access: 'sk-ant-oat01-abundant-access',
              refresh: 'abundant-refresh',
              expires: checkedAt + 5 * 60 * 60_000,
              quota: quota(98),
            },
          ],
        }),
      ),
    )
    const models: string[] = []
    const authorizations: string[] = []
    let refusal = true
    let rejectMain = false
    const refusalSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_filtered"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":0}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('')
    const successSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_ok"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('')
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        if (!url.includes('/v1/messages')) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        if (body.max_tokens === 0) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        models.push(String(body.model))
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        authorizations.push(authorization)
        if (rejectMain && authorization === 'Bearer sk-ant-oat01-main-access') {
          return Promise.resolve(new Response('forbidden', { status: 403 }))
        }
        if (refusal) {
          refusal = false
          return Promise.resolve(new Response(refusalSse, { status: 200 }))
        }
        return Promise.resolve(new Response(successSse, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(createMockClient())
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: checkedAt + 100_000,
        }),
      { models: {} },
    )
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_sticky_fable' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 128_000,
        stream: true,
        system: [{ type: 'text', text: 'stable system' }],
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }

    const filtered = await result.fetch(MESSAGES_URL, request)
    await expect(filtered.text()).rejects.toThrow()
    const opus = await result.fetch(MESSAGES_URL, request)
    await opus.text()

    expect(models).toEqual(['claude-fable-5', 'claude-opus-4-8'])
    expect(authorizations).toEqual([
      'Bearer sk-ant-oat01-abundant-access',
      'Bearer sk-ant-oat01-abundant-access',
    ])

    const directOpus = await result.fetch(MESSAGES_URL, {
      ...request,
      headers: { 'x-session-affinity': 'ses_direct_opus' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 128_000,
        stream: true,
        messages: [{ role: 'user', content: 'direct Opus' }],
      }),
    })
    await directOpus.text()
    expect(authorizations.at(-1)).toBe('Bearer sk-ant-oat01-main-access')

    rejectMain = true
    const migratedOpus = await result.fetch(MESSAGES_URL, {
      ...request,
      headers: { 'x-session-affinity': 'ses_direct_opus_migration' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        stream: true,
        messages: [{ role: 'user', content: 'migrate Opus' }],
      }),
    })
    await migratedOpus.text()
    expect(authorizations.slice(-2)).toEqual([
      'Bearer sk-ant-oat01-main-access',
      'Bearer sk-ant-oat01-scarce-access',
    ])
  })

  test('sticky-balanced reselects after the user changes the session model', async () => {
    const checkedAt = Date.now()
    const quota = (fableRemaining: number) => ({
      checkedAt,
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        checkedAt,
      },
      seven_day: {
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
        checkedAt,
      },
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100 - fableRemaining,
          remainingPercent: fableRemaining,
          resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
          checkedAt,
        },
      ],
    })
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'sticky-balanced' },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 1, seven_day: 1 },
            failClosedOnUnknownQuota: true,
            mainQuota: quota(0),
            mainQuotaCheckedAt: checkedAt,
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          },
          accounts: [
            {
              id: 'fable-rich',
              type: 'oauth',
              access: 'sk-ant-oat01-fable-rich-access',
              refresh: 'fable-rich-refresh',
              expires: checkedAt + 5 * 60 * 60_000,
              quota: quota(100),
            },
          ],
        }),
      ),
    )
    const authorizations: string[] = []
    const successSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_ok"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('')
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        if (!url.includes('/v1/messages')) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        authorizations.push(
          new Headers(init?.headers).get('authorization') ?? '',
        )
        return Promise.resolve(new Response(successSse, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(createMockClient())
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: checkedAt + 100_000,
        }),
      { models: {} },
    )
    const request = (model: string) => ({
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_user_model_change' },
      body: JSON.stringify({
        model,
        max_tokens: 128_000,
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    await (await result.fetch(MESSAGES_URL, request('claude-fable-5-1'))).text()
    await (await result.fetch(MESSAGES_URL, request('claude-opus-5'))).text()

    expect(authorizations).toEqual([
      'Bearer sk-ant-oat01-fable-rich-access',
      'Bearer sk-ant-oat01-main-access',
    ])
  })

  test('sticky-balanced reports main re-login instead of falling through when no fallback can serve the requested model', async () => {
    const checkedAt = Date.now()
    const quota = (fableRemaining: number) => ({
      checkedAt,
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        checkedAt,
      },
      seven_day: {
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
        checkedAt,
      },
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100 - fableRemaining,
          remainingPercent: fableRemaining,
          resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
          checkedAt,
        },
      ],
    })
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'sticky-balanced' },
          refresh: {
            enabled: true,
            intervalMinutes: 10,
            refreshBeforeExpiryMinutes: 240,
            mainLastRefreshError: {
              message:
                'Claude OAuth refresh failed: 400 — {"error":"invalid_grant"}',
              checkedAt,
              nextRetryAt: checkedAt + 24 * 60 * 60_000,
              retryCount: 1,
              tokenHash: hashRefreshToken('main-refresh'),
              status: 400,
              permanent: true,
            },
          },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 1, seven_day: 1 },
            failClosedOnUnknownQuota: true,
            mainQuota: quota(88),
            mainQuotaCheckedAt: checkedAt,
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          },
          accounts: [
            {
              id: 'fallback-a',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-a-access',
              refresh: 'fallback-a-refresh',
              expires: checkedAt + 5 * 60 * 60_000,
              quota: quota(0),
            },
            {
              id: 'fallback-b',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-b-access',
              refresh: 'fallback-b-refresh',
              expires: checkedAt + 5 * 60 * 60_000,
              quota: quota(0),
            },
          ],
        }),
      ),
      {
        access: 'sk-ant-oat01-main-access',
        refresh: 'main-refresh',
        expires: checkedAt - 1,
      },
    )
    let messageRequests = 0
    let reLoginQuotaPolls = 0
    const servedAuthorizations: Array<string | null> = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage')) {
            reLoginQuotaPolls += 1
            return Promise.resolve(
              Response.json({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
                limits: [
                  {
                    kind: 'weekly_scoped',
                    group: 'weekly',
                    percent: 12,
                    scope: { model: { display_name: 'Fable' } },
                  },
                ],
              }),
            )
          }
          if (url.includes('/v1/messages')) {
            messageRequests += 1
            servedAuthorizations.push(
              new Headers(init?.headers).get('authorization'),
            )
          }
          return Promise.resolve(new Response('{}', { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const currentAuth = {
      type: 'oauth' as const,
      access: 'sk-ant-oat01-main-access',
      refresh: 'main-refresh',
      expires: checkedAt - 1,
    }
    const result = await plugin.auth.loader(
      () => Promise.resolve(currentAuth),
      { models: {} },
    )
    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_sticky_no_fable_route' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      type: 'error',
      error: {
        type: 'authentication_error',
        message:
          'Main Claude OAuth account requires re-login, and no fallback OAuth account is currently routable for Fable.',
      },
    })
    expect(messageRequests).toBe(0)

    await replacePoolMainLogin({
      access: 'sk-ant-oat01-main-access',
      refresh: 'relogged-main-refresh',
      expires: checkedAt + 5 * 60 * 60_000,
    })
    const recovered = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_sticky_no_fable_route' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        stream: true,
        messages: [{ role: 'user', content: 'after re-login' }],
      }),
    })

    expect(recovered.status).toBe(200)
    expect(messageRequests).toBe(1)
    expect(servedAuthorizations).toEqual(['Bearer sk-ant-oat01-main-access'])
    expect(reLoginQuotaPolls).toBe(1)
    const saved = await readAccountStorage()
    expect(saved?.refresh?.mainLastRefreshError).toBeUndefined()
    expect(saved?.quota?.mainQuota?.scoped?.[0]?.remainingPercent).toBe(88)
    expect(saved?.quota?.mainQuota?.accountIdentity).toBe(poolMainIdentity())
  })

  test('sticky-balanced uses API routes only after confirmed OAuth exhaustion', async () => {
    const checkedAt = Date.now()
    const quota = (remainingPercent: number) => ({
      checkedAt,
      five_hour: {
        usedPercent: 100 - remainingPercent,
        remainingPercent,
        checkedAt,
      },
      seven_day: {
        usedPercent: 100 - remainingPercent,
        remainingPercent,
        checkedAt,
      },
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100 - remainingPercent,
          remainingPercent,
          checkedAt,
        },
      ],
    })
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'sticky-balanced' },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 1, seven_day: 1 },
            failClosedOnUnknownQuota: true,
            mainQuota: quota(0),
            mainQuotaCheckedAt: checkedAt,
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          },
          accounts: [
            {
              id: 'oauth-fallback',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: checkedAt + 5 * 60 * 60_000,
              quota: quota(100),
            },
            {
              id: 'api-fallback',
              type: 'api',
              baseURL: 'https://provider.example/anthropic',
              authHeader: 'authorization-bearer',
              apiKey: 'api-key',
            },
          ],
        }),
      ),
    )

    const authorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 100 },
                seven_day: { utilization: 100 },
                limits: [
                  {
                    kind: 'weekly_scoped',
                    group: 'weekly',
                    percent: 100,
                    scope: { model: { display_name: 'Fable' } },
                  },
                ],
              }),
              { status: 200 },
            ),
          )
        }
        if (!url.includes('/v1/messages')) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        authorizations.push(authorization)
        return Promise.resolve(
          authorization === 'Bearer sk-ant-oat01-fallback-access'
            ? new Response('exhausted', { status: 429 })
            : new Response('ok', { status: 200 }),
        )
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: checkedAt + 100_000,
        }),
      { models: {} },
    )
    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_sticky_api' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(authorizations).toEqual([
      'Bearer sk-ant-oat01-fallback-access',
      'Bearer api-key',
    ])
  })

  test('sticky-balanced seeds an already-warm CacheKeep session from its current account', async () => {
    const checkedAt = Date.now()
    const quota = (fableRemaining: number) => ({
      checkedAt,
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        checkedAt,
      },
      seven_day: {
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
        checkedAt,
      },
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100 - fableRemaining,
          remainingPercent: fableRemaining,
          resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
          checkedAt,
        },
      ],
    })
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'main-first' },
          claudeCache: { enabled: true, mode: 'hybrid' },
          cacheKeep: { enabled: true, always: true },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 1, seven_day: 1 },
            failClosedOnUnknownQuota: true,
            mainQuota: quota(13),
            mainQuotaCheckedAt: checkedAt,
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          },
          accounts: [
            {
              id: 'ufuk2',
              type: 'oauth',
              access: 'sk-ant-oat01-abundant-access',
              refresh: 'abundant-refresh',
              expires: checkedAt + 5 * 60 * 60_000,
              quota: quota(98),
            },
          ],
        }),
      ),
    )
    const authorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (!url.includes('/v1/messages')) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        authorizations.push(
          new Headers(init?.headers).get('authorization') ?? '',
        )
        return Promise.resolve(new Response('ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: checkedAt + 100_000,
        }),
      { models: {} },
    )
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_warm_cutover' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        stream: true,
        system: [{ type: 'text', text: 'stable' }],
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }

    await (await result.fetch(MESSAGES_URL, request)).text()
    await updatePoolSettings((settings) => ({
      ...settings,
      routing: { mode: 'sticky-balanced' },
    }))
    await (await result.fetch(MESSAGES_URL, request)).text()

    expect(authorizations).toEqual([
      'Bearer sk-ant-oat01-main-access',
      'Bearer sk-ant-oat01-main-access',
    ])
  })

  for (const window of ['5h', '7d', 'model-scoped'] as const) {
    test(`sticky-balanced retains the assigned account across transient errors and a short ${window} reset`, async () => {
      const checkedAt = Date.now()
      const holdMinutes = window === '5h' ? 14 : 10
      const shortResetAt = new Date(
        checkedAt + holdMinutes * 60_000,
      ).toISOString()
      const longResetAt = new Date(checkedAt + 2 * 60 * 60_000).toISOString()
      let useLongReset = false
      let now = checkedAt
      const quota = (fableRemaining: number) => ({
        checkedAt,
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(checkedAt + 5 * 60 * 60_000).toISOString(),
          checkedAt,
        },
        seven_day: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
          checkedAt,
        },
        scoped: [
          {
            id: 'claude-weekly-scoped-fable',
            title: 'Fable only',
            modelName: 'Fable',
            usedPercent: 100 - fableRemaining,
            remainingPercent: fableRemaining,
            resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
            checkedAt,
          },
        ],
      })
      await useTempAccountFile(
        bindPoolAccounts(
          createFallbackStorage({
            routing: { mode: 'sticky-balanced' },
            quota: {
              enabled: true,
              checkIntervalMinutes: 5,
              minimumRemaining: { five_hour: 1, seven_day: 1 },
              failClosedOnUnknownQuota: true,
              mainQuota: quota(0),
              mainQuotaCheckedAt: checkedAt,
              mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
            },
            accounts: [
              {
                id: 'yiyi',
                type: 'oauth',
                access: 'sk-ant-oat01-scarce-access',
                refresh: 'scarce-refresh',
                expires: checkedAt + 5 * 60 * 60_000,
                quota: quota(13),
              },
              {
                id: 'ufuk2',
                type: 'oauth',
                access: 'sk-ant-oat01-abundant-access',
                refresh: 'abundant-refresh',
                expires: checkedAt + 5 * 60 * 60_000,
                quota: quota(98),
              },
            ],
          }),
        ),
      )
      const authorizations: string[] = []
      let modelRequest = 0
      globalThis.fetch = mock(
        withNativeAdmission((input: any, init: any) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage')) {
            const authorization = new Headers(init?.headers).get(
              'authorization',
            )
            const abundant =
              authorization === 'Bearer sk-ant-oat01-abundant-access'
            const main = authorization === 'Bearer sk-ant-oat01-main-access'
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  five_hour: {
                    utilization: abundant && window === '5h' ? 100 : 0,
                    resets_at: useLongReset ? longResetAt : shortResetAt,
                  },
                  seven_day: {
                    utilization: abundant && window === '7d' ? 100 : 0,
                    resets_at: useLongReset ? longResetAt : shortResetAt,
                  },
                  limits: [
                    {
                      kind: 'weekly_scoped',
                      group: 'weekly',
                      percent:
                        main || (abundant && window === 'model-scoped')
                          ? 100
                          : abundant
                            ? 2
                            : 87,
                      resets_at:
                        abundant && window === 'model-scoped'
                          ? useLongReset
                            ? longResetAt
                            : shortResetAt
                          : new Date(
                              checkedAt + 4 * 24 * 60 * 60_000,
                            ).toISOString(),
                      scope: { model: { display_name: 'Fable' } },
                    },
                  ],
                }),
                { status: 200 },
              ),
            )
          }
          if (!url.includes('/v1/messages')) {
            return Promise.resolve(new Response('{}', { status: 200 }))
          }
          authorizations.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )
          modelRequest += 1
          if (modelRequest === 1) {
            return Promise.resolve(new Response('temporary', { status: 500 }))
          }
          if (modelRequest === 2) {
            return Promise.resolve(
              new Response(
                'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"quota"}}\n\n',
                { status: 200 },
              ),
            )
          }
          return Promise.resolve(new Response('ok', { status: 200 }))
        }),
      ) as unknown as typeof fetch

      Date.now = mock(() => now) as unknown as typeof Date.now
      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth',
            access: 'sk-ant-oat01-main-access',
            refresh: 'main-refresh',
            expires: checkedAt + 10 * 60 * 60_000,
          }),
        { models: {} },
      )
      const request = {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses_sticky_hold' },
        body: JSON.stringify({
          model: 'claude-fable-5',
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }

      expect((await result.fetch(MESSAGES_URL, request)).status).toBe(500)
      const held = await result.fetch(MESSAGES_URL, request)
      expect(held.status).toBe(429)
      expect(Number(held.headers.get('retry-after'))).toBeGreaterThanOrEqual(
        holdMinutes * 60,
      )
      expect(Number(held.headers.get('retry-after'))).toBeLessThanOrEqual(
        holdMinutes * 60 + 20,
      )
      expect(await held.text()).toContain(
        'Sticky OAuth account quota resets shortly; retaining session affinity.',
      )
      const proactive = await result.fetch(MESSAGES_URL, request)
      expect(proactive.status).toBe(429)
      expect(await proactive.text()).toContain(
        'Sticky OAuth account quota resets shortly; retaining session affinity.',
      )
      expect(authorizations).toEqual([
        'Bearer sk-ant-oat01-abundant-access',
        'Bearer sk-ant-oat01-abundant-access',
      ])

      useLongReset = true
      now += 6 * 60_000
      const migrated = await result.fetch(MESSAGES_URL, request)
      expect(migrated.status).toBe(200)
      expect(authorizations).toEqual([
        'Bearer sk-ant-oat01-abundant-access',
        'Bearer sk-ant-oat01-abundant-access',
        'Bearer sk-ant-oat01-scarce-access',
      ])
    })
  }

  test('normalizes a server fallback response even when no session-affinity header is available', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const frame = (event: string, data: unknown) =>
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    const fallbackSse = [
      frame('message_start', {
        type: 'message_start',
        message: { id: 'msg_fallback', model: 'claude-opus-5' },
      }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'fallback',
          from: { model: 'claude-fable-5' },
          to: { model: 'claude-opus-5' },
        },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          output_tokens: 1,
          iterations: [
            {
              type: 'message',
              model: 'claude-fable-5',
              input_tokens: 1,
              output_tokens: 0,
            },
            {
              type: 'fallback_message',
              model: 'claude-opus-5',
              input_tokens: 1,
              output_tokens: 1,
            },
          ],
        },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ].join('')
    let sentBody: Record<string, unknown> | undefined
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          if (!extractUrl(input).includes('/v1/messages')) {
            return Promise.resolve(new Response('{}', { status: 200 }))
          }
          sentBody = JSON.parse(String(init?.body))
          return Promise.resolve(new Response(fallbackSse, { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-fable-5',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    const responseText = await response.text()

    expect(sentBody?.fallbacks).toBe('default')
    expect(responseText).not.toContain('"type":"fallback","from"')
    expect(responseText).toContain(SERVER_FALLBACK_SIGNATURE_PREFIX)
  })

  test('uses Anthropic server-side fallback for Fable 5.1 and reports transitions', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: { enabled: false } as AccountStorage['quota'],
      }),
    )
    const requestBodies: Array<Record<string, unknown>> = []
    const requestBetas: string[] = []
    let modelRequest = 0
    const frame = (event: string, data: unknown) =>
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    const fallbackSse = [
      frame('message_start', {
        type: 'message_start',
        message: { id: 'msg_fallback', model: 'claude-opus-5' },
      }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'fallback',
          from: { model: 'claude-fable-5-1' },
          to: { model: 'claude-opus-5' },
        },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'fallback answer' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 1 }),
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          output_tokens: 2,
          iterations: [
            {
              type: 'message',
              model: 'claude-fable-5-1',
              input_tokens: 100,
              output_tokens: 0,
            },
            {
              type: 'fallback_message',
              model: 'claude-opus-5',
              input_tokens: 100,
              output_tokens: 2,
            },
          ],
        },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ].join('')
    const restoredSse = [
      frame('message_start', {
        type: 'message_start',
        message: { id: 'msg_restored', model: 'claude-fable-5-1' },
      }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'source answer' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          output_tokens: 2,
          iterations: [
            {
              type: 'message',
              model: 'claude-fable-5-1',
              input_tokens: 100,
              output_tokens: 2,
            },
          ],
        },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ].join('')

    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          if (!extractUrl(input).includes('/v1/messages')) {
            return Promise.resolve(new Response('{}', { status: 200 }))
          }
          requestBodies.push(JSON.parse(String(init?.body)))
          requestBetas.push(
            new Headers(init?.headers).get('anthropic-beta') ?? '',
          )
          modelRequest++
          return Promise.resolve(
            new Response(modelRequest === 1 ? fallbackSse : restoredSse, {
              status: 200,
            }),
          )
        },
      ),
    ) as unknown as typeof fetch

    const latestUserMessageId = 'msg_000000000100AAAAAAAAAAAAAA'
    const latestAssistantMessageId = 'msg_000000000200BBBBBBBBBBBBBB'
    const mockClient = createMockClient([
      {
        info: {
          id: latestUserMessageId,
          role: 'user',
          agent: 'Alfonso - CTO',
          model: {
            providerID: 'anthropic',
            modelID: 'claude-fable-5-1',
            variant: 'xhigh',
          },
        },
      },
      {
        info: {
          id: latestAssistantMessageId,
          role: 'assistant',
          agent: 'Alfonso - CTO',
          providerID: 'anthropic',
          modelID: 'claude-fable-5-1',
          variant: 'xhigh',
        },
      },
    ])
    const plugin = await getPlugin(mockClient)
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_server_fallback' },
      body: JSON.stringify({
        model: 'claude-fable-5-1',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }

    const fallbackResponse = await result.fetch(MESSAGES_URL, request)
    const fallbackResponseText = await fallbackResponse.text()
    expect(fallbackResponseText).toContain('fallback answer')
    expect(fallbackResponseText).not.toContain('"type":"fallback","from"')
    expect(fallbackResponseText).toContain(SERVER_FALLBACK_SIGNATURE_PREFIX)
    expect(requestBodies).toHaveLength(1)
    expect(requestBodies[0]?.fallbacks).toBe('default')
    expect(requestBetas[0]?.split(',')).toContain(SERVER_SIDE_FALLBACK_BETA)
    const switched = await waitForSidebarState((state) =>
      Boolean(
        state.fableRecoveries?.some(
          (recovery) =>
            recovery.sessionId === 'ses_server_fallback' &&
            recovery.mode === 'server',
        ),
      ),
    )
    expect(switched.fableRecoveries?.[0]).toMatchObject({
      requestedModelId: 'claude-fable-5-1',
      targetModelId: 'claude-opus-5',
      remaining: 0,
    })
    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: latestAssistantMessageId,
            sessionID: 'ses_server_fallback',
            role: 'assistant',
            finish: 'tool-calls',
            time: { completed: Date.now() },
          },
        },
      },
    })
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()

    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: latestAssistantMessageId,
            sessionID: 'ses_server_fallback',
            role: 'assistant',
            finish: 'stop',
            time: { completed: Date.now() },
          },
        },
      },
    })
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()

    await plugin.event?.({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'ses_server_fallback',
          status: { type: 'idle' },
        },
      },
    })
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()

    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_server_fallback' },
      },
    })
    await waitForMockCall(mockClient.session.promptAsync)
    expect(mockClient.session.promptAsync.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        path: { id: 'ses_server_fallback' },
        body: expect.objectContaining({
          noReply: true,
          parts: [
            expect.objectContaining({
              text: expect.stringContaining('Anthropic safety fallback'),
            }),
          ],
        }),
      }),
    )

    // Model the real host: the first ignored notice becomes the newest user
    // message. A second notice must have a distinct ordered ID, registered
    // before promptAsync emits its user-message event.
    const firstNotice = mockClient.session.promptAsync.mock.calls[0]?.[0] as {
      body: { messageID: string }
    }
    const originalMessages = await mockClient.session.messages!()
    mockClient.session.messages = mock(async () => ({
      data: [
        ...originalMessages.data,
        { info: { id: firstNotice.body.messageID, role: 'user' } },
      ],
    }))
    const noticeWasTrackedAtDispatch: boolean[] = []
    mockClient.session.promptAsync.mockImplementation(
      async (input: unknown) => {
        const notice = input as {
          path: { id: string }
          body: { messageID: string }
        }
        noticeWasTrackedAtDispatch.push(
          typeof notice.body.messageID === 'string' &&
            getPluginTestHandles(plugin).isDesktopNoticeMessage(
              notice.path.id,
              notice.body.messageID,
            ),
        )
        await plugin.event?.({
          event: {
            type: 'message.updated',
            properties: {
              info: {
                id: notice.body.messageID,
                sessionID: notice.path.id,
                role: 'user',
              },
            },
          },
        })
      },
    )

    const restoredResponse = await result.fetch(MESSAGES_URL, request)
    // OpenCode can publish the assistant-completed event before the wrapped
    // response emits its final fallback outcome. The idle event must flush a notice
    // queued after that completion event without requiring a later session update.
    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: latestAssistantMessageId,
            sessionID: 'ses_server_fallback',
            role: 'assistant',
            time: { completed: Date.now() },
          },
        },
      },
    })
    await expect(restoredResponse.text()).resolves.toContain('source answer')
    const restored = await waitForSidebarState((state) =>
      Boolean(
        state.fableRecoveries?.some(
          (recovery) =>
            recovery.sessionId === 'ses_server_fallback' &&
            recovery.mode === 'fable',
        ),
      ),
    )
    expect(restored.fableRecoveries?.[0]?.requestedModelId).toBe(
      'claude-fable-5-1',
    )
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_server_fallback' },
      },
    })
    await waitForMockCall({
      mock: {
        get calls() {
          return mockClient.session.promptAsync.mock.calls.slice(1)
        },
      },
    })
    expect(mockClient.session.promptAsync.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          parts: [
            expect.objectContaining({
              text: expect.stringContaining('Returning to Fable 5.1'),
            }),
          ],
        }),
      }),
    )

    const secondNotice = mockClient.session.promptAsync.mock.calls[1]?.[0] as {
      body: { messageID: string }
    }
    expect(noticeWasTrackedAtDispatch).toEqual([true])
    expect(secondNotice.body.messageID > firstNotice.body.messageID).toBe(true)
    expect(secondNotice.body.messageID < latestAssistantMessageId).toBe(true)

    // The host history still contains only notice 1. Notice 2's own event must
    // leave the idle lease intact, and local allocation must avoid reusing its
    // ID even before session.messages catches up. No new idle event is sent.
    modelRequest = 0
    const thirdTransition = await result.fetch(MESSAGES_URL, request)
    await thirdTransition.text()
    await waitForMockCall({
      mock: {
        get calls() {
          return mockClient.session.promptAsync.mock.calls.slice(2)
        },
      },
    })
    const thirdNotice = mockClient.session.promptAsync.mock.calls[2]?.[0] as {
      body: { messageID: string }
    }
    expect(thirdNotice.body.messageID > secondNotice.body.messageID).toBe(true)
    expect(thirdNotice.body.messageID < latestAssistantMessageId).toBe(true)
    expect(noticeWasTrackedAtDispatch).toEqual([true, true])

    // A rapid fallback cycle can replace the pending switch notice while its
    // asynchronous prompt-context lookup is still in flight. The stale send
    // must stand down and the active flush must continue with the replacement.
    mockClient.session.promptAsync.mockClear()
    modelRequest = 0
    const immediateMessages = mockClient.session.messages
    let releasePromptContext: (() => void) | undefined
    let messageLookups = 0
    mockClient.session.messages = mock(() => {
      messageLookups++
      if (messageLookups > 1) {
        return immediateMessages?.() ?? Promise.resolve({ data: [] })
      }
      return new Promise<{ data: unknown[] }>((resolve) => {
        releasePromptContext = () => {
          void Promise.resolve(immediateMessages?.()).then((response) =>
            resolve(response ?? { data: [] }),
          )
        }
      })
    })
    const overtakenRequest = {
      ...request,
      headers: { 'x-session-affinity': 'ses_server_fallback_overtaken' },
    }
    const overtakenFallback = await result.fetch(MESSAGES_URL, overtakenRequest)
    await overtakenFallback.text()
    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: latestUserMessageId,
            sessionID: 'ses_server_fallback_overtaken',
            role: 'user',
          },
        },
      },
    })
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_server_fallback_overtaken' },
      },
    })
    for (let attempt = 0; attempt < 100 && !releasePromptContext; attempt++) {
      await Bun.sleep(1)
    }
    expect(releasePromptContext).toBeDefined()

    const overtakenRestoration = await result.fetch(
      MESSAGES_URL,
      overtakenRequest,
    )
    await overtakenRestoration.text()
    releasePromptContext?.()
    await waitForMockCall(mockClient.session.promptAsync)

    expect(mockClient.session.promptAsync).toHaveBeenCalledTimes(1)
    expect(mockClient.session.promptAsync.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          parts: [
            expect.objectContaining({
              text: expect.stringContaining('Returning to Fable 5.1'),
            }),
          ],
        }),
      }),
    )
    // Missing ordering context must retain the notice, never send a host-minted
    // user ID. Once the host exposes a safe boundary, the same notice can drain.
    mockClient.session.promptAsync.mockClear()
    mockClient.session.messages = mock(async () => ({ data: [] }))
    modelRequest = 0
    const unplaced = await result.fetch(MESSAGES_URL, {
      ...request,
      headers: { 'x-session-affinity': 'ses_notice_unplaced' },
    })
    await unplaced.text()
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_notice_unplaced' },
      },
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(mockClient.session.messages).toHaveBeenCalled()
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()
    mockClient.session.messages = immediateMessages
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_notice_unplaced' },
      },
    })
    await waitForMockCall(mockClient.session.promptAsync)
    expect(mockClient.session.promptAsync).toHaveBeenCalledTimes(1)
  })

  test('downgrades a filtered Fable session for ten completed Opus responses without source warms', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: true, mode: 'hybrid' },
        cacheKeep: { enabled: false },
      }),
    )
    const normalModels: string[] = []
    let firstFable = true
    const recorded = recordedCondition()
    const successfulSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_ok"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('')
    const refusalSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_filtered"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":0}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('')

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
                limits: [],
              }),
              { status: 200 },
            ),
          )
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(body.max_tokens).not.toBe(0)
        normalModels.push(String(body.model))
        recorded.changed()
        if (body.model === 'claude-fable-5' && firstFable) {
          firstFable = false
          return Promise.resolve(new Response(refusalSse, { status: 200 }))
        }
        return Promise.resolve(new Response(successfulSse, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const latestUserMessageId = 'msg_000000000100AAAAAAAAAAAAAA'
    const latestAssistantMessageId = 'msg_000000000200BBBBBBBBBBBBBB'
    let releaseStaleIdleStatus:
      | ((statuses: Record<string, { type: string }>) => void)
      | undefined
    let noticeStatusChecks = 0
    const mockClient = createMockClient(
      [
        {
          info: {
            id: latestUserMessageId,
            role: 'user',
            agent: 'Alfonso - CTO',
            model: {
              providerID: 'anthropic',
              modelID: 'claude-fable-5',
              variant: 'xhigh',
            },
          },
        },
        {
          info: {
            id: latestAssistantMessageId,
            role: 'assistant',
            agent: 'Alfonso - CTO',
            providerID: 'anthropic',
            modelID: 'claude-fable-5',
            variant: 'xhigh',
          },
        },
      ],
      () => {
        noticeStatusChecks++
        if (noticeStatusChecks === 1) {
          return new Promise<Record<string, { type: string }>>((resolve) => {
            releaseStaleIdleStatus = resolve
            recorded.changed()
          })
        }
        return {}
      },
    )
    // Record each notice the plugin sends so the test can wait for it.
    mockClient.session.promptAsync = mock((_input: unknown) => {
      queueMicrotask(recorded.changed)
      return Promise.resolve()
    })
    const plugin = await getPlugin(mockClient)
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_fable_filter' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 128_000,
        stream: true,
        system: [{ type: 'text', text: 'stable system' }],
        messages: [{ role: 'user', content: 'same session input' }],
      }),
    }

    const filtered = await result.fetch(MESSAGES_URL, request)
    const reader = filtered.body!.getReader()
    let caught: unknown
    try {
      while (!(await reader.read()).done) {}
    } catch (error) {
      caught = error
    }
    expect((caught as { code?: string }).code).toBe('ECONNRESET')
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()
    const switchedState = await waitForSidebarState((state) =>
      Boolean(
        state.fableRecoveries?.some(
          (recovery) =>
            recovery.sessionId === 'ses_fable_filter' &&
            recovery.mode === 'opus',
        ),
      ),
    )
    expect(
      switchedState.fableRecoveries?.find(
        (recovery) => recovery.sessionId === 'ses_fable_filter',
      )?.remaining,
    ).toBe(10)

    // The switch notice is deliberately held until the first successful Opus
    // response proves that OpenCode's internal retry has completed.
    const firstOpus = await result.fetch(MESSAGES_URL, request)
    await firstOpus.text()

    // Seed the user-message identity that produced the upcoming idle event.
    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: latestUserMessageId,
            sessionID: 'ses_fable_filter',
            role: 'user',
          },
        },
      },
    })

    // Reproduce the host race: an idle probe starts, then a new
    // prompt marks the session busy before the asynchronous status response
    // arrives with its now-stale idle snapshot. The notice must remain queued;
    // otherwise OpenCode can adopt that ignored user message as the active retry
    // parent and dispatch an extra provider request.
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_fable_filter' },
      },
    })
    await recorded.until(() => releaseStaleIdleStatus !== undefined)
    expect(releaseStaleIdleStatus).toBeDefined()
    await plugin.event?.({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'ses_fable_filter',
          status: { type: 'busy' },
        },
      },
    })
    releaseStaleIdleStatus?.({})
    await Bun.sleep(10)
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()

    // Also cover the later race window: status was idle, but a new prompt starts
    // while the notification path is resolving message history for placement.
    const immediateMessages = mockClient.session.messages
    let releasePromptContext: (() => void) | undefined
    mockClient.session.messages = mock(
      () =>
        new Promise<{ data: unknown[] }>((resolve) => {
          releasePromptContext = () => {
            void Promise.resolve(immediateMessages?.()).then((response) =>
              resolve(response ?? { data: [] }),
            )
          }
          recorded.changed()
        }),
    )
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_fable_filter' },
      },
    })
    await recorded.until(() => releasePromptContext !== undefined)
    expect(releasePromptContext).toBeDefined()
    await plugin.event?.({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'ses_fable_filter',
          status: { type: 'busy' },
        },
      },
    })
    releasePromptContext?.()
    await Bun.sleep(10)
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()
    mockClient.session.messages = immediateMessages

    // OpenCode can publish the new user message before its busy status update.
    // That earlier event must also revoke the idle-delivery lease.
    let releaseUserMessagePromptContext: (() => void) | undefined
    mockClient.session.messages = mock(
      () =>
        new Promise<{ data: unknown[] }>((resolve) => {
          releaseUserMessagePromptContext = () => {
            void Promise.resolve(immediateMessages?.()).then((response) =>
              resolve(response ?? { data: [] }),
            )
          }
          recorded.changed()
        }),
    )
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_fable_filter' },
      },
    })
    await recorded.until(() => releaseUserMessagePromptContext !== undefined)
    expect(releaseUserMessagePromptContext).toBeDefined()
    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_new_user',
            sessionID: 'ses_fable_filter',
            role: 'user',
          },
        },
      },
    })
    releaseUserMessagePromptContext?.()
    await Bun.sleep(10)
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()
    mockClient.session.messages = immediateMessages

    // A later authoritative idle signal retries the still-queued notice.
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_fable_filter' },
      },
    })
    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_new_user',
            sessionID: 'ses_fable_filter',
            role: 'user',
          },
        },
      },
    })
    await plugin.event?.({
      event: {
        type: 'session.updated',
        properties: { sessionID: 'ses_fable_filter' },
      },
    })
    await recorded.until(
      () => mockClient.session.promptAsync.mock.calls.length > 0,
    )
    expect(mockClient.session.promptAsync).toHaveBeenCalledTimes(1)
    expect(mockClient.session.promptAsync.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        path: { id: 'ses_fable_filter' },
        body: expect.objectContaining({
          messageID: expect.any(String),
          noReply: true,
          agent: 'Alfonso - CTO',
          model: {
            providerID: 'anthropic',
            modelID: 'claude-fable-5',
          },
          variant: 'xhigh',
          parts: [
            expect.objectContaining({
              type: 'text',
              ignored: true,
              text: expect.stringContaining('Switched to Opus 4.8'),
            }),
          ],
        }),
      }),
    )
    const switchNotificationRequest = mockClient.session.promptAsync.mock
      .calls[0]?.[0] as { body: { messageID?: string } } | undefined
    const switchNotificationMessageId =
      switchNotificationRequest?.body.messageID
    expect(switchNotificationMessageId! > latestUserMessageId).toBe(true)
    expect(switchNotificationMessageId! < latestAssistantMessageId).toBe(true)
    expect(normalModels).toHaveLength(2)

    for (let turn = 1; turn < 10; turn++) {
      const response = await result.fetch(MESSAGES_URL, request)
      await response.text()
    }

    expect(normalModels).toEqual([
      'claude-fable-5',
      ...Array.from({ length: 10 }, () => 'claude-opus-4-8'),
    ])
    const restoredState = await waitForSidebarState((state) =>
      Boolean(
        state.fableRecoveries?.some(
          (recovery) =>
            recovery.sessionId === 'ses_fable_filter' &&
            recovery.mode === 'fable' &&
            recovery.remaining === 0,
        ),
      ),
    )
    expect(
      restoredState.fableRecoveries?.find(
        (recovery) => recovery.sessionId === 'ses_fable_filter',
      )?.mode,
    ).toBe('fable')

    // Queue the return-to-Fable notice at the tenth completed Opus response.
    // Delivery must not depend on a source-cache prewarm request.
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_fable_filter' },
      },
    })
    await plugin.event?.({
      event: {
        type: 'session.updated',
        properties: { sessionID: 'ses_fable_filter' },
      },
    })
    // The ignored switch notice is itself stored as a user message. Its event
    // must not revoke the real user's idle-delivery lease for a newer notice.
    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: switchNotificationMessageId,
            sessionID: 'ses_fable_filter',
            role: 'user',
          },
        },
      },
    })
    const restored = await result.fetch(MESSAGES_URL, request)
    await restored.text()
    expect(normalModels.at(-1)).toBe('claude-fable-5')

    await recorded.until(
      () => mockClient.session.promptAsync.mock.calls.length > 1,
    )
    expect(mockClient.session.promptAsync).toHaveBeenCalledTimes(2)
    expect(mockClient.session.promptAsync.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        path: { id: 'ses_fable_filter' },
        body: expect.objectContaining({
          messageID: expect.any(String),
          noReply: true,
          parts: [
            expect.objectContaining({
              type: 'text',
              ignored: true,
              text: expect.stringContaining('Returning to Fable 5'),
            }),
          ],
        }),
      }),
    )
    expect(normalModels).toHaveLength(12)
    expect(
      restoredState.fableRecoveries?.find(
        (recovery) => recovery.sessionId === 'ses_fable_filter',
      )?.remaining,
    ).toBe(0)
  })

  test('server mode — refusal with no server-side handoff downgrades to Opus (wedge regression)', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: false },
        cacheKeep: { enabled: false },
      }),
    )
    const models: string[] = []
    let firstFable = true
    const refusalSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_filtered"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":0}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('')
    const successSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_ok"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('')

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        if (!url.includes('/v1/messages')) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        if (body.max_tokens === 0) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        models.push(String(body.model))
        if (body.model === 'claude-fable-5' && firstFable) {
          firstFable = false
          return Promise.resolve(new Response(refusalSse, { status: 200 }))
        }
        return Promise.resolve(new Response(successSse, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_wedge' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 128_000,
        stream: true,
        system: [{ type: 'text', text: 'stable system' }],
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }

    // First request hits the refusal — onContentFilter fires, stream rejects.
    // The second request must carry the downgraded Opus model.
    const filtered = await result.fetch(MESSAGES_URL, request)
    await expect(filtered.text()).rejects.toThrow()
    const second = await result.fetch(MESSAGES_URL, request)
    await second.text()

    expect(models).toEqual(['claude-fable-5', 'claude-opus-4-8'])
  })

  test('server mode — absorbed server-side fallback does NOT activate client-side downgrade', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: false },
        cacheKeep: { enabled: false },
      }),
    )
    const models: string[] = []
    const frame = (event: string, data: unknown) =>
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    const fallbackSse = [
      frame('message_start', {
        type: 'message_start',
        message: { id: 'msg_fallback', model: 'claude-opus-5' },
      }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'fallback',
          from: { model: 'claude-fable-5' },
          to: { model: 'claude-opus-5' },
        },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'safe answer' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 1 }),
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 2 },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ].join('')

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        if (!url.includes('/v1/messages')) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        if (body.max_tokens === 0) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        models.push(String(body.model))
        return Promise.resolve(new Response(fallbackSse, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_no_double' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 128_000,
        stream: true,
        system: [{ type: 'text', text: 'stable system' }],
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }

    const first = await result.fetch(MESSAGES_URL, request)
    await first.text()
    const second = await result.fetch(MESSAGES_URL, request)
    await second.text()

    // Both requests stayed on Fable — no client-side downgrade triggered.
    expect(models).toEqual(['claude-fable-5', 'claude-fable-5'])
  })

  test('server mode — downgraded Opus request does not carry server-side fallback opt-in', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: false },
        cacheKeep: { enabled: false },
      }),
    )
    const models: string[] = []
    const bodies: Array<Record<string, unknown>> = []
    let firstFable = true
    const refusalSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_filtered"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":0}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('')
    const successSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_ok"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('')

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        if (!url.includes('/v1/messages')) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        if (body.max_tokens === 0) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        models.push(String(body.model))
        bodies.push(body)
        if (body.model === 'claude-fable-5' && firstFable) {
          firstFable = false
          return Promise.resolve(new Response(refusalSse, { status: 200 }))
        }
        return Promise.resolve(new Response(successSse, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_no_optin' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 128_000,
        stream: true,
        system: [{ type: 'text', text: 'stable system' }],
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }

    // First request hits the refusal. onContentFilter fires
    // causing the stream to reject with a ContentFilterError.
    const filtered = await result.fetch(MESSAGES_URL, request)
    await expect(filtered.text()).rejects.toThrow()
    const opus = await result.fetch(MESSAGES_URL, request)
    await opus.text()

    expect(models).toEqual(['claude-fable-5', 'claude-opus-4-8'])
    // The Opus request must NOT carry the server-side fallback opt-in.
    expect(bodies[1]?.fallbacks).toBeUndefined()
  })

  test('uses the sidebar instead of promptAsync when the matching TUI is connected', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: true, mode: 'hybrid' },
      }),
    )
    resetNotificationsForTest()
    drainNotifications(0, 'ses_tui_fable')
    const refusal =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"}}\n\n'

    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        if (extractUrl(input).includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        return Promise.resolve(new Response(refusal, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_tui_fable' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    try {
      await response.text()
    } catch {}
    await plugin.event?.({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'ses_tui_fable',
          status: { type: 'idle' },
        },
      },
    })

    await Bun.sleep(10)
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()
    const state = await waitForSidebarState((candidate) =>
      Boolean(
        candidate.fableRecoveries?.some(
          (recovery) =>
            recovery.sessionId === 'ses_tui_fable' &&
            recovery.mode === 'opus' &&
            recovery.remaining === 10,
        ),
      ),
    )
    expect(state.fableRecoveries).toHaveLength(1)
  })

  test('migrates recovery to an available OAuth account without warming the source', async () => {
    const now = Date.now()
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          claudeCache: { enabled: true, mode: 'hybrid' },
          cacheKeep: { enabled: false },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                checkedAt: now,
              },
              seven_day: {
                usedPercent: 0,
                remainingPercent: 100,
                checkedAt: now,
              },
              checkedAt: now,
              scoped: [
                {
                  id: 'claude-weekly-scoped-fable',
                  title: 'Fable only',
                  modelName: 'Fable',
                  usedPercent: 100,
                  remainingPercent: 0,
                  checkedAt: now,
                },
              ],
            },
            mainQuotaCheckedAt: now,
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          } as AccountStorage['quota'],
          accounts: [
            {
              id: 'fable-fallback',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: now + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  checkedAt: now,
                },
                seven_day: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  checkedAt: now,
                },
                scoped: [
                  {
                    id: 'claude-weekly-scoped-fable',
                    title: 'Fable only',
                    modelName: 'Fable',
                    usedPercent: 25,
                    remainingPercent: 75,
                    checkedAt: now,
                  },
                ],
              },
            },
          ],
        }),
      ),
    )
    const calls: Array<{ model: string; auth: string; warm: boolean }> = []
    let firstFable = true
    const success =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
    const refusal =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"}}\n\n'

    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  five_hour: { utilization: 0 },
                  seven_day: { utilization: 0 },
                }),
                { status: 200 },
              ),
            )
          }
          const body = JSON.parse(String(init?.body)) as {
            model: string
            max_tokens?: number
          }
          const auth = new Headers(init?.headers).get('authorization') ?? ''
          calls.push({
            model: body.model,
            auth,
            warm: body.max_tokens === 0,
          })
          if (body.model === 'claude-fable-5' && firstFable) {
            firstFable = false
            return Promise.resolve(new Response(refusal, { status: 200 }))
          }
          return Promise.resolve(new Response(success, { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_account_bound_fable' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 100,
        system: [{ type: 'text', text: 'stable system' }],
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }

    const filtered = await result.fetch(MESSAGES_URL, request)
    const filteredReader = filtered.body!.getReader()
    try {
      while (!(await filteredReader.read()).done) {}
    } catch {}

    const opus = await result.fetch(MESSAGES_URL, request)
    await opus.text()

    expect(calls).toEqual([
      {
        model: 'claude-fable-5',
        auth: 'Bearer sk-ant-oat01-fallback-access',
        warm: false,
      },
      {
        model: 'claude-opus-4-8',
        auth: 'Bearer sk-ant-oat01-main-access',
        warm: false,
      },
    ])
  })

  test('sidebar refresh reads metadata without authorizing expired main credentials', async () => {
    const main = { ...syntheticMainHostAuth(), expires: Date.now() - 1_000 }
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: { enabled: false },
        refresh: { enabled: false },
      }),
      main,
    )
    const requests: string[] = []
    globalThis.fetch = Object.assign(
      mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests.push(extractUrl(input))
        return (await nativeAdmissionAnswer(input, init)) ?? Response.json({})
      }),
      { preconnect: globalThis.fetch.preconnect },
    )
    const plugin = await getPlugin()
    await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth', ...main }),
      { models: {} },
    )
    const display =
      await getPluginTestHandles(plugin).resolveSidebarQuotaAccess()
    expect(display.storage?.quota?.enabled).toBe(false)
    expect(display.access).toBeUndefined()
    expect(requests).toEqual([])
  })

  test('background fallback refresh updates the sidebar without a request', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          accounts: [
            {
              id: 'fallback-1',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: Date.now() + 5 * 60 * 60 * 1000,
              quota: {
                // Plugin startup polls this OAuth account's usage because its saved reading is old.
                five_hour: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  checkedAt: 1,
                },
                seven_day: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  checkedAt: 1,
                },
              },
            },
          ],
        }),
      ),
    )

    const usageAuthorizations: Array<string | null> = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          if (extractUrl(input).includes('/api/oauth/usage')) {
            usageAuthorizations.push(
              new Headers(init?.headers).get('authorization'),
            )
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  five_hour: { utilization: 0.42 },
                  seven_day: { utilization: 0.1 },
                }),
                { status: 200 },
              ),
            )
          }
          return Promise.resolve(new Response('ok', { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    // Running the loader starts the background refresh (immediate first pass).
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await getPluginTestHandles(plugin).fallbackRefreshReady
    expect(usageAuthorizations).toContain('Bearer sk-ant-oat01-fallback-access')
    expect(
      (await readNativeRuntimeState()).accounts['fallback-1']?.quota?.five_hour
        ?.usedPercent,
    ).toBe(0.42)
    // The background pass refreshes the stale fallback and the hook re-writes the
    // sidebar — without any request to the messages endpoint.
    // utilization: 0.42 → usedPercent: 0.42 (stored as-is, not multiplied by 100)
    const state = await waitForSidebarState(
      (candidate) =>
        candidate.fallbacks[0]?.quota?.five_hour?.usedPercent === 0.42,
    )
    expect(state.fallbacks[0]?.id).toBe('fallback-1')
  })

  describe('quota header harvest', () => {
    const quotaHeaders = {
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-5h-utilization': '0.78',
      'anthropic-ratelimit-unified-5h-reset': '1784246400',
      'anthropic-ratelimit-unified-7d-utilization': '0.4',
      'anthropic-ratelimit-unified-7d-reset': '1784628000',
    }

    const harvestStorage = (
      accounts: AccountStorage['accounts'] = [],
      overrides: Partial<AccountStorage> = {},
    ) =>
      createFallbackStorage({
        accounts,
        quota: { enabled: false },
        ...overrides,
      })

    function pauseHeaderPublication() {
      const lifetime = bodyLifetime()
      const entered = lifetime.gate()
      const release = lifetime.gate()
      const operations: Promise<boolean>[] = []
      const factory = Core.createNativeAccountRuntime
      const factorySpy = spyOn(
        Core,
        'createNativeAccountRuntime',
      ).mockImplementation((options) => {
        const runtime = factory(options)
        const publish = runtime.publishLocal.bind(runtime)
        runtime.publishLocal = (subject, patch) => {
          if (patch.quota?.source !== 'headers') return publish(subject, patch)
          // Pause before the real publisher runs; its ownership and version
          // checks remain unchanged when the test releases it.
          const operation = (async () => {
            entered.open()
            await release.wait
            return publish(subject, patch)
          })()
          operations.push(operation)
          lifetime.trackDetached(Promise.allSettled([operation]))
          return operation
        }
        return runtime
      })
      return { entered, release, operations, factorySpy }
    }
    const apiFallbackForHeaderTests = {
      id: 'header-api',
      type: 'api' as const,
      apiKey: 'header-key',
      baseURL: 'https://example.test/claude',
      authHeader: 'authorization-bearer' as const,
    }

    for (const exhausted of [true, false]) {
      test(`pending seven-day poll ${exhausted ? 'confirms general exhaustion for paid fallback' : 'with quota left cannot license paid fallback'} while runtime sync is held`, async () => {
        await useTempAccountFile(
          harvestStorage([apiFallbackForHeaderTests], {
            routing: { mode: 'fallback-first' },
            quota: { enabled: true },
          }),
        )
        const lifetime = bodyLifetime()
        const entered = lifetime.gate()
        const release = lifetime.gate()
        let servingRuntime:
          | ReturnType<typeof Core.createNativeAccountRuntime>
          | undefined
        const factory = Core.createNativeAccountRuntime
        const factorySpy = spyOn(
          Core,
          'createNativeAccountRuntime',
        ).mockImplementation((options) => {
          servingRuntime = factory(options)
          return servingRuntime
        })
        lifetime.deferCleanup(() => factorySpy.mockRestore())
        const authorizations: Array<string | null> = []
        globalThis.fetch = mock(
          withNativeAdmission(
            (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
              if (extractUrl(input) === QUOTA_URL)
                return Promise.resolve(
                  Response.json({
                    five_hour: { utilization: 20 },
                    seven_day: { utilization: exhausted ? 100 : 20 },
                  }),
                )
              authorizations.push(
                new Headers(init?.headers).get('authorization'),
              )
              return Promise.resolve(new Response('ok'))
            },
          ),
        ) as unknown as typeof fetch
        const result = await loadFetch()
        if (!servingRuntime || !testContext.migratedPool)
          throw new Error('Missing serving pool')
        const runtime = servingRuntime
        const runtimePath = testContext.migratedPool.paths.runtime
        const realOpen = filesystem.open
        let intercepted = false
        const openSpy = spyOn(filesystem, 'open').mockImplementation(
          async (path, flags, mode) => {
            const file = await realOpen(path, flags, mode)
            if (String(path).startsWith(`${runtimePath}.native-runtime.`)) {
              const sync = file.sync.bind(file)
              file.sync = async () => {
                const staged: {
                  accounts: Record<string, { quotaErrorClearedAt?: number }>
                } = JSON.parse(await readFile(path, 'utf8'))
                if (
                  !intercepted &&
                  Object.values(staged.accounts).some(
                    (entry) => entry.quotaErrorClearedAt,
                  )
                ) {
                  intercepted = true
                  entered.open()
                  await release.wait
                }
                return sync()
              }
            }
            return file
          },
        )
        lifetime.deferCleanup(() => openSpy.mockRestore())
        await runtime.fetchQuota('main')
        await entered.wait
        expect((await result.fetch(MESSAGES_URL, EMPTY_POST)).status).toBe(200)
        expect(authorizations).toEqual([
          exhausted ? 'Bearer header-key' : 'Bearer sk-ant-oat01-main-access',
        ])
        // Polls replace the per-account entry also used by response headers.
        // Its exhaustion flag must mean no five-hour or seven-day quota remains;
        // rounding a display to 100% is not permission to spend on an API key.
        expect(runtime.quotaObservations.get('main')?.generalExhausted).toBe(
          exhausted,
        )
        release.open()
        await runtime.drainQuotaPublications()
      })
    }

    test('pending quota routes without waiting for header publication', async () => {
      await useTempAccountFile(
        harvestStorage([apiFallbackForHeaderTests], {
          routing: { mode: 'fallback-first' },
        }),
      )
      const pause = pauseHeaderPublication()
      const authorizations: Array<string | null> = []
      globalThis.fetch = mock(
        withNativeAdmission(
          (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            if (extractUrl(input).includes('/claude_cli/bootstrap'))
              return Promise.resolve(
                Response.json({
                  oauth_account: { account_uuid: poolMainIdentity() },
                }),
              )
            const authorization = new Headers(init?.headers).get(
              'authorization',
            )
            authorizations.push(authorization)
            return Promise.resolve(
              new Response('ok', {
                headers:
                  authorization === 'Bearer sk-ant-oat01-main-access'
                    ? {
                        ...quotaHeaders,
                        'anthropic-ratelimit-unified-5h-utilization': '1',
                      }
                    : undefined,
              }),
            )
          },
        ),
      ) as unknown as typeof fetch
      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: 'sk-ant-oat01-main-access',
            refresh: 'main-refresh',
            expires: Date.now() + 100000,
          }),
        { models: {} },
      )
      try {
        expect((await result.fetch(MESSAGES_URL, EMPTY_POST)).status).toBe(200)
        await pause.entered.wait
        expect(
          getPluginTestHandles(plugin).quotaManager.getMain(poolMainIdentity()),
        ).toBeNull()
        expect((await result.fetch(MESSAGES_URL, EMPTY_POST)).status).toBe(200)
        expect(authorizations).toEqual([
          'Bearer sk-ant-oat01-main-access',
          'Bearer header-key',
        ])
        expect((await readAccountStorage())?.quota?.mainQuota).toBeUndefined()
      } finally {
        pause.release.open()
        await Promise.allSettled(pause.operations)
        pause.factorySpy.mockRestore()
      }
    })

    test('pending rounded header usage cannot license API fallback', async () => {
      await useTempAccountFile(
        harvestStorage([apiFallbackForHeaderTests], {
          routing: { mode: 'fallback-first' },
        }),
      )
      const pause = pauseHeaderPublication()
      const authorizations: Array<string | null> = []
      globalThis.fetch = mock(
        withNativeAdmission((_input: unknown, init?: RequestInit) => {
          authorizations.push(new Headers(init?.headers).get('authorization'))
          return Promise.resolve(
            new Response('ok', {
              headers: {
                ...quotaHeaders,
                'anthropic-ratelimit-unified-5h-utilization': '0.995',
              },
            }),
          )
        }),
      ) as unknown as typeof fetch
      const result = await loadFetch()
      try {
        await result.fetch(MESSAGES_URL, EMPTY_POST)
        await pause.entered.wait
        expect((await result.fetch(MESSAGES_URL, EMPTY_POST)).status).toBe(200)
        expect(authorizations).toEqual([
          'Bearer sk-ant-oat01-main-access',
          'Bearer sk-ant-oat01-main-access',
        ])
      } finally {
        pause.release.open()
        await Promise.allSettled(pause.operations)
        pause.factorySpy.mockRestore()
      }
    })

    test('pending quota from a superseded credential epoch cannot license API fallback', async () => {
      await useTempAccountFile(
        harvestStorage([apiFallbackForHeaderTests], {
          routing: { mode: 'fallback-first' },
        }),
      )
      const pause = pauseHeaderPublication()
      const authorizations: Array<string | null> = []
      globalThis.fetch = mock(
        withNativeAdmission(
          (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            if (extractUrl(input).includes('/claude_cli/bootstrap'))
              return Promise.resolve(
                Response.json({
                  oauth_account: { account_uuid: poolMainIdentity() },
                }),
              )
            const authorization = new Headers(init?.headers).get(
              'authorization',
            )
            authorizations.push(authorization)
            return Promise.resolve(
              new Response('ok', {
                headers:
                  authorization === 'Bearer sk-ant-oat01-main-access'
                    ? {
                        ...quotaHeaders,
                        'anthropic-ratelimit-unified-5h-utilization': '1',
                      }
                    : undefined,
              }),
            )
          },
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch()
      try {
        await result.fetch(MESSAGES_URL, EMPTY_POST)
        await pause.entered.wait
        await replacePoolMainLogin(
          {
            access: 'sk-ant-oat01-new-epoch',
            refresh: 'new-epoch-refresh',
            expires: Date.now() + 8 * 60 * 60_000,
          },
          { sameAccount: false, accountIdentity: poolMainIdentity() },
        )
        expect((await result.fetch(MESSAGES_URL, EMPTY_POST)).status).toBe(200)
        expect(authorizations).toEqual([
          'Bearer sk-ant-oat01-main-access',
          'Bearer sk-ant-oat01-new-epoch',
        ])
      } finally {
        pause.release.open()
        await Promise.allSettled(pause.operations)
        pause.factorySpy.mockRestore()
      }
    })

    test('refused header publication cannot persist superseded-epoch quota', async () => {
      await useTempAccountFile(
        harvestStorage([apiFallbackForHeaderTests], {
          routing: { mode: 'fallback-first' },
        }),
      )
      const pause = pauseHeaderPublication()
      const records: LogTestRecord[] = []
      __setLogTestSink((record) => records.push(record))
      setLogLevel('debug')
      const authorizations: Array<string | null> = []
      globalThis.fetch = mock(
        withNativeAdmission(
          (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            if (extractUrl(input).includes('/claude_cli/bootstrap'))
              return Promise.resolve(
                Response.json({
                  oauth_account: { account_uuid: poolMainIdentity() },
                }),
              )
            const authorization = new Headers(init?.headers).get(
              'authorization',
            )
            authorizations.push(authorization)
            return Promise.resolve(
              new Response('ok', {
                headers:
                  authorization === 'Bearer sk-ant-oat01-main-access'
                    ? {
                        ...quotaHeaders,
                        'anthropic-ratelimit-unified-5h-utilization': '1',
                      }
                    : undefined,
              }),
            )
          },
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch()
      setLogLevel('debug')
      try {
        await result.fetch(MESSAGES_URL, EMPTY_POST)
        await pause.entered.wait
        if (!testContext.migratedPool)
          throw new Error('This test has no migrated pool')
        const reader = createNativeAccountRuntime({
          paths: testContext.migratedPool.paths,
          host: 'opencode',
        })
        try {
          const before = await reader.captureLocalSubject('main')
          await replacePoolMainLogin(
            {
              access: 'sk-ant-oat01-new-epoch-access',
              refresh: 'main-refresh',
              expires: Date.now() + 8 * 60 * 60_000,
            },
            { sameAccount: false, accountIdentity: poolMainIdentity() },
          )
          const after = await reader.captureLocalSubject('main')
          expect(after.binding.credentialEpoch).toBeGreaterThan(
            before.binding.credentialEpoch,
          )
          expect(after.binding.identity).toBe(before.binding.identity)
          expect(after.version?.accessFingerprint).not.toBe(
            before.version?.accessFingerprint,
          )
        } finally {
          reader.close()
        }
        pause.release.open()
        expect(await pause.operations[0]).toBe(false)
        expect((await readNativeRuntimeState()).main?.quota?.source).not.toBe(
          'headers',
        )
        await waitForLogRecord(
          records,
          (record) =>
            record.channel === 'quota' &&
            record.message === 'discarded pending response quota',
          'refused pending observation cleanup',
        )
        expect((await result.fetch(MESSAGES_URL, EMPTY_POST)).status).toBe(200)
        expect(authorizations).toEqual([
          'Bearer sk-ant-oat01-main-access',
          'Bearer sk-ant-oat01-new-epoch-access',
        ])
      } finally {
        pause.release.open()
        await Promise.allSettled(pause.operations)
        pause.factorySpy.mockRestore()
        __setLogTestSink(null)
        setLogLevel('info')
      }
    })

    function installRelayWebSocket(responseHeaders: Record<string, string>) {
      const originalWebSocket = globalThis.WebSocket

      class RelayWebSocket extends EventTarget {
        binaryType = 'arraybuffer'

        constructor() {
          super()
          queueMicrotask(() => {
            this.dispatchEvent(new Event('open'))
            this.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({
                  protocol: 2,
                  type: 'ready',
                  state: null,
                }),
              }),
            )
          })
        }

        send(data: string) {
          const payload = JSON.parse(data)
          queueMicrotask(() => {
            this.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({
                  protocol: 2,
                  type: 'accepted',
                  id: payload.id,
                  hash: payload.next_hash,
                  revision: payload.revision,
                }),
              }),
            )
            this.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({
                  protocol: 2,
                  type: 'response_start',
                  id: payload.id,
                  status: 200,
                  headers: responseHeaders,
                }),
              }),
            )
            this.dispatchEvent(
              new MessageEvent('message', {
                data: Buffer.from('event: message_stop\n\n'),
              }),
            )
            this.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({
                  protocol: 2,
                  type: 'done',
                  id: payload.id,
                }),
              }),
            )
          })
        }

        close() {
          this.dispatchEvent(new Event('close'))
        }
      }

      globalThis.WebSocket = RelayWebSocket as unknown as typeof WebSocket
      return () => {
        globalThis.WebSocket = originalWebSocket
      }
    }

    async function loadFetch(
      getAccessToken: () => string = () => 'sk-ant-oat01-main-access',
    ) {
      const plugin = await getPlugin()
      return plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: getAccessToken(),
            refresh: 'main-refresh',
            expires: Date.now() + 100000,
          }),
        { models: {} },
      )
    }

    // Read the account runtime state that stores response-header quota.
    async function waitForState(predicate: (state: any) => boolean) {
      let lastState: unknown
      for (let attempt = 0; attempt < 200; attempt++) {
        // Each test checks its required fields in the persisted projection.
        const state: any = await readNativeRuntimeState()
        lastState = state
        if (predicate(state)) return state
        await Bun.sleep(10)
      }
      throw new Error(
        `quota state did not persist: ${JSON.stringify(lastState)}`,
      )
    }

    test('main 200 response pushes unified headers before returning the response', async () => {
      await useTempAccountFile(harvestStorage())
      globalThis.fetch = mock(
        withNativeAdmission(() =>
          Promise.resolve(new Response('main-ok', { headers: quotaHeaders })),
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

      expect(await response.text()).toBe('main-ok')
      const state = await waitForState(
        (value) => value.main?.quota?.source === 'headers',
      )
      expect(state.main.quota.five_hour.usedPercent).toBe(78)
      // Header quota belongs to the account UUID, not its rotating token.
      expect(state.main.quota.accountIdentity).toBe(poolMainIdentity())
    })

    test('fresh header exhaustion licenses API-key fallback on the next request', async () => {
      await useTempAccountFile(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          accounts: [
            {
              id: 'kie-opus',
              type: 'api',
              apiKey: 'kie-key',
              baseURL: 'https://api.kie.ai/claude',
              authHeader: 'authorization-bearer',
            },
          ],
          quota: { enabled: false },
        }),
      )
      const authorizations: Array<string | null> = []
      globalThis.fetch = mock(
        withNativeAdmission(
          (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            if (extractUrl(input).includes('/claude_cli/bootstrap'))
              return Promise.resolve(
                Response.json({
                  oauth_account: { account_uuid: poolMainIdentity() },
                }),
              )
            const authorization = new Headers(init?.headers).get(
              'authorization',
            )
            authorizations.push(authorization)
            return Promise.resolve(
              new Response('ok', {
                headers:
                  authorization === 'Bearer sk-ant-oat01-main-access'
                    ? {
                        ...quotaHeaders,
                        'anthropic-ratelimit-unified-5h-utilization': '1',
                      }
                    : undefined,
              }),
            )
          },
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      await result.fetch(MESSAGES_URL, EMPTY_POST)
      await result.fetch(MESSAGES_URL, EMPTY_POST)

      expect(authorizations).toEqual([
        'Bearer sk-ant-oat01-main-access',
        'Bearer kie-key',
      ])
    })

    test('stale header exhaustion does not license API-key fallback', async () => {
      const checkedAt = Date.now() - 60 * 60 * 1000
      await useTempAccountFile(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          accounts: [
            {
              id: 'kie-opus',
              type: 'api',
              apiKey: 'kie-key',
              baseURL: 'https://api.kie.ai/claude',
              authHeader: 'authorization-bearer',
            },
          ],
          quota: {
            enabled: false,
            mainQuota: {
              five_hour: {
                usedPercent: 100,
                remainingPercent: 0,
                checkedAt,
              },
              source: 'headers',
              checkedAt,
            },
            mainQuotaCheckedAt: checkedAt,
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          },
        }),
      )
      const authorizations: Array<string | null> = []
      globalThis.fetch = mock(
        withNativeAdmission((_input: unknown, init?: RequestInit) => {
          authorizations.push(new Headers(init?.headers).get('authorization'))
          return Promise.resolve(new Response('ok'))
        }),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      await result.fetch(MESSAGES_URL, EMPTY_POST)

      expect(authorizations).toEqual(['Bearer sk-ant-oat01-main-access'])
    })
    test('websocket relay response_start pushes unified headers for the served account', async () => {
      await useTempAccountFile(
        harvestStorage([], {
          relay: {
            enabled: true,
            url: 'https://relay.example.test',
            token: 'relay-token',
            fallbackToDirect: true,
            transport: 'websocket',
          },
        }),
      )
      // The relay request travels over the WebSocket; HTTP is used only for
      // the pool's account check of the main login before it serves.
      const providerFetch = globalThis.fetch
      globalThis.fetch = mock(
        withNativeAdmission(providerFetch),
      ) as unknown as typeof fetch
      const restoreWebSocket = installRelayWebSocket(quotaHeaders)
      const result = await loadFetch()

      try {
        const response = await result.fetch(MESSAGES_URL, {
          ...EMPTY_POST,
          body: JSON.stringify({
            ...JSON.parse(EMPTY_POST.body),
            stream: true,
          }),
          headers: { 'x-session-affinity': 'quota-relay-websocket' },
        })
        expect(response.headers.get('x-cortexkit-relay-optimistic')).toBe(
          'true',
        )
        await response.text()
      } finally {
        restoreWebSocket()
      }

      const state = await waitForState(
        (value) => value.main?.quota?.source === 'headers',
      )
      expect(state.main.quota.five_hour.usedPercent).toBe(78)
      // Header quota belongs to the account UUID, not its rotating token.
      expect(state.main.quota.accountIdentity).toBe(poolMainIdentity())
    })

    test('relay fallback to direct harvests quota headers exactly once', async () => {
      await useTempAccountFile(
        harvestStorage([], {
          relay: {
            enabled: true,
            url: 'https://relay.example.test',
            token: 'relay-token',
            fallbackToDirect: true,
            transport: 'http',
          },
        }),
      )
      const records: LogTestRecord[] = []
      const affinity = 'quota-relay-direct-fallback'
      // A marker in this request's body tells its own sends apart from any
      // other request that reaches the mock. When an earlier test overruns
      // Bun's timeouts, its body and its teardown keep running into this test:
      // its own model request can arrive here, and its teardown can re-enable
      // profile hydration, which sends GET /api/oauth/profile. Counting those
      // would report a duplicate send that this request never made.
      const probe = 'relay-direct-fallback-probe'
      let relay503Calls = 0
      let directCalls = 0
      __setLogTestSink((record) => records.push(record))
      globalThis.fetch = mock(
        withNativeAdmission(
          (input: string | URL | Request, init?: RequestInit) => {
            const url = extractUrl(input)
            const body = typeof init?.body === 'string' ? init.body : ''
            if (url === 'https://relay.example.test/') {
              let relayAffinity: unknown
              try {
                relayAffinity = JSON.parse(body).affinity
              } catch {}
              if (relayAffinity === affinity) relay503Calls += 1
              return Promise.resolve(
                new Response('relay unavailable', { status: 503 }),
              )
            }
            if (
              url.startsWith(MESSAGES_URL) &&
              init?.method === 'POST' &&
              body.includes(probe)
            ) {
              directCalls += 1
              return Promise.resolve(
                new Response('direct', { headers: quotaHeaders }),
              )
            }
            return Promise.resolve(new Response('unrelated', { status: 404 }))
          },
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch()
      setLogLevel('debug')

      try {
        const response = await result.fetch(MESSAGES_URL, {
          method: 'POST',
          body: JSON.stringify({
            messages: [{ role: 'user', content: probe }],
          }),
          headers: { 'x-session-affinity': affinity },
        })
        expect(await response.text()).toBe('direct')
        expect(relay503Calls).toBe(1)
        expect(directCalls).toBe(1)
        await waitForState((value) => value.main?.quota?.source === 'headers')
        await waitForLogRecord(
          records,
          (record) =>
            record.channel === 'quota' &&
            record.message === 'harvested response quota',
          'published direct-fallback quota log',
        )
        expect(
          records.filter(
            (record) =>
              record.channel === 'quota' &&
              record.message === 'harvested response quota',
          ),
        ).toHaveLength(1)
      } finally {
        __setLogTestSink(null)
        setLogLevel('info')
      }
    })

    test('websocket optimistic response headers without quota data do not persist', async () => {
      await useTempAccountFile(
        harvestStorage([], {
          relay: {
            enabled: true,
            url: 'https://relay.example.test',
            token: 'relay-token',
            fallbackToDirect: true,
            transport: 'websocket',
          },
        }),
      )
      // The relay request travels over the WebSocket; HTTP is used only for
      // the pool's account check of the main login before it serves.
      const providerFetch = globalThis.fetch
      globalThis.fetch = mock(
        withNativeAdmission(providerFetch),
      ) as unknown as typeof fetch
      const restoreWebSocket = installRelayWebSocket({
        'content-type': 'text/event-stream',
      })
      const result = await loadFetch()

      try {
        const response = await result.fetch(MESSAGES_URL, {
          ...EMPTY_POST,
          body: JSON.stringify({
            ...JSON.parse(EMPTY_POST.body),
            stream: true,
          }),
          headers: { 'x-session-affinity': 'quota-relay-synthetic-only' },
        })
        expect(response.headers.get('x-cortexkit-relay-optimistic')).toBe(
          'true',
        )
        await response.text()
      } finally {
        restoreWebSocket()
      }

      await Bun.sleep(30)
      expect(
        (await readAccountStorage())?.quota?.mainQuota?.source,
      ).toBeUndefined()
    })

    test('quota-only publication survives native token refresh without admitting stale metadata', async () => {
      await useTempAccountFile(harvestStorage())
      globalThis.fetch = mock(
        withNativeAdmission(async () => Response.json({})),
      ) as unknown as typeof fetch
      if (!testContext.migratedPool) throw new Error('Expected migrated pool')
      const reader = createNativeAccountRuntime({
        paths: testContext.migratedPool.paths,
        host: 'opencode',
      })
      try {
        expect((await reader.authorizeLocal('main')).status).toBe('usable')
        const before = requireKnownPoolSubject(
          await reader.captureLocalSubject('main'),
        )
        await refreshPoolMainElsewhere({
          ...syntheticMainHostAuth(),
          access: 'sk-ant-oat01-refreshed-quota-access',
        })
        const after = await reader.captureLocalSubject('main')
        expect(after.binding.credentialEpoch).toBe(
          before.binding.credentialEpoch,
        )
        expect(after.binding.identity).toBe(before.binding.identity)
        expect(after.version?.accessFingerprint).not.toBe(
          before.version?.accessFingerprint,
        )
        const quota: OAuthQuotaSnapshot = {
          accountIdentity: before.binding.identity,
          source: 'headers',
          checkedAt: Date.now(),
          five_hour: {
            usedPercent: 78,
            remainingPercent: 22,
            checkedAt: Date.now(),
          },
        }
        expect(
          await reader.publishLocal(before, { quota, lastUsed: Date.now() }),
        ).toBe(false)
        expect(await reader.publishLocal(before, { quota })).toBe(true)
        expect(
          (await reader.read()).accounts.find(
            (account) => account.id === 'main',
          )?.quota?.five_hour?.usedPercent,
        ).toBe(78)
        expect(
          await reader.publishLocal(before, { lastUsed: Date.now() }),
        ).toBe(false)
      } finally {
        reader.close()
      }
    })

    test('main header push persists after access-token rotation for the same account', async () => {
      const initialAuth = {
        ...syntheticMainHostAuth(),
        access: 'sk-ant-oat01-old-main-access',
      }
      let liveAccessToken = initialAuth.access
      const existingQuota = {
        five_hour: { usedPercent: 11, remainingPercent: 89, checkedAt: 1 },
        source: 'poll' as const,
        checkedAt: 1,
      }
      await useTempAccountFile(
        bindMainQuotaToAccount(
          createFallbackStorage({
            mainAccountId: 'account-x',
            accounts: [],
            quota: {
              enabled: false,
              mainQuota: existingQuota,
              mainQuotaCheckedAt: 1,
            },
          }),
          initialAuth.access,
        ),
        initialAuth,
      )
      const requestStarted = bodyLifetime().gate()
      const releaseResponse = bodyLifetime().gate()
      const requestAuthorizations: Array<string | null> = []
      globalThis.fetch = mock(
        withNativeAdmission(
          async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            if (!extractUrl(input).includes('/v1/messages'))
              return Response.json({})
            requestAuthorizations.push(
              new Headers(init?.headers).get('authorization'),
            )
            requestStarted.open()
            await releaseResponse.wait
            return new Response('main-ok', { headers: quotaHeaders })
          },
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch(() => liveAccessToken)
      const records: LogTestRecord[] = []
      __setLogTestSink((record) => records.push(record))
      setLogLevel('debug')
      const responsePromise = result.fetch(MESSAGES_URL, EMPTY_POST)
      try {
        await Promise.race([
          requestStarted.wait,
          responsePromise.then(() => {
            throw new Error('Expected a held main model request')
          }),
        ])
        if (!testContext.migratedPool) throw new Error('Expected migrated pool')
        const reader = createNativeAccountRuntime({
          paths: testContext.migratedPool.paths,
          host: 'opencode',
        })
        try {
          const before = requireKnownPoolSubject(
            await reader.captureLocalSubject('main'),
          )
          liveAccessToken = 'sk-ant-oat01-new-main-access'
          await refreshPoolMainElsewhere({
            ...initialAuth,
            access: liveAccessToken,
          })
          const after = await reader.captureLocalSubject('main')
          expect(after.binding.credentialEpoch).toBe(
            before.binding.credentialEpoch,
          )
          expect(after.binding.identity).toBe(before.binding.identity)
          expect(after.version?.accessFingerprint).not.toBe(
            before.version?.accessFingerprint,
          )
          expect(
            await reader.publishLocal(before, {
              quota: {
                ...existingQuota,
                accountIdentity: syntheticMainAccountUuid,
                five_hour: {
                  usedPercent: 99,
                  remainingPercent: 1,
                  checkedAt: Date.now(),
                },
                checkedAt: Date.now(),
              },
              lastUsed: Date.now(),
            }),
          ).toBe(false)
          expect(
            (await reader.read()).accounts.find(
              (account) => account.id === 'main',
            )?.quota?.five_hour?.usedPercent,
          ).toBe(11)
        } finally {
          reader.close()
        }
        releaseResponse.open()
        await responsePromise
        const state = await waitForState(
          (value) => value.main?.quota?.source === 'headers',
        )
        const reloaded = await readAccountStorage()
        await waitForLogRecord(
          records,
          (record) =>
            record.channel === 'quota' &&
            record.message === 'harvested response quota',
          'published refreshed-main quota log',
        )
        expect(
          records.some(
            (record) =>
              record.channel === 'quota' &&
              record.message === 'harvested response quota',
          ),
        ).toBe(true)
        expect(requestAuthorizations[0]).toBe(
          'Bearer sk-ant-oat01-old-main-access',
        )
        expect(state.main.quota.five_hour.usedPercent).toBe(78)
        expect(state.main.quota.accountIdentity).toBe(syntheticMainAccountUuid)
        expect(state.main.quotaToken).toBeUndefined()
        expect(reloaded?.quota?.mainQuota?.five_hour?.usedPercent).toBe(78)
        expect(reloaded?.quota?.mainQuota?.accountIdentity).toBe(
          syntheticMainAccountUuid,
        )
        // In the policy view, mainQuotaToken is an account UUID, not a token.
        expect(reloaded?.quota?.mainQuotaToken).toBe(syntheticMainAccountUuid)
        expect(JSON.stringify(reloaded)).not.toContain(initialAuth.access)
        expect(JSON.stringify(reloaded)).not.toContain(liveAccessToken)
      } finally {
        releaseResponse.open()
        await Promise.allSettled([responsePromise])
        __setLogTestSink(null)
        setLogLevel('info')
      }
    })

    test('fallback header push persists after access-token rotation for the same account', async () => {
      const fallbackTemplate = createFallbackStorage()
        .accounts[0] as OAuthAccount
      const oldAccess = 'sk-ant-oat01-old-fallback-access'
      const newAccess = 'sk-ant-oat01-new-fallback-access'
      await useTempAccountFile(
        bindPoolAccounts(
          createFallbackStorage({
            accounts: [
              {
                ...fallbackTemplate,
                access: oldAccess,
                quota: fallbackTemplate.quota,
              },
            ],
            quota: { enabled: false },
          }),
        ),
      )
      let messageCalls = 0
      const fallbackStarted = bodyLifetime().gate()
      const releaseFallback = bodyLifetime().gate()
      const authorizations: Array<string | null> = []
      globalThis.fetch = mock(
        withNativeAdmission(
          async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            const url = extractUrl(input)
            if (url.includes('/api/oauth/usage'))
              return new Response('usage-unavailable', { status: 500 })
            if (!url.includes('/v1/messages')) return Response.json({})
            authorizations.push(new Headers(init?.headers).get('authorization'))
            if (++messageCalls === 1)
              return new Response('limited', { status: 429 })
            fallbackStarted.open()
            await releaseFallback.wait
            return new Response('fallback-ok', { headers: quotaHeaders })
          },
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch()
      const responsePromise = result.fetch(MESSAGES_URL, EMPTY_POST)
      try {
        await Promise.race([
          fallbackStarted.wait,
          responsePromise.then(() => {
            throw new Error('Expected a held fallback request')
          }),
        ])
        if (!testContext.migratedPool) throw new Error('Expected migrated pool')
        const reader = createNativeAccountRuntime({
          paths: testContext.migratedPool.paths,
          host: 'opencode',
        })
        try {
          const before = await reader.captureLocalSubject('fallback-1')
          loginIssues(oldAccess, newAccess)
          await refreshPoolLoginElsewhere('fallback-1', {
            access: newAccess,
            refresh: fallbackTemplate.refresh,
            expires: Date.now() + 8 * 60 * 60_000,
          })
          const after = await reader.captureLocalSubject('fallback-1')
          expect(after.binding.credentialEpoch).toBe(
            before.binding.credentialEpoch,
          )
          expect(after.binding.identity).toBe(before.binding.identity)
          expect(after.version?.accessFingerprint).not.toBe(
            before.version?.accessFingerprint,
          )
        } finally {
          reader.close()
        }
        releaseFallback.open()
        await responsePromise
        const state = await waitForState(
          (value) =>
            value.accounts?.['fallback-1']?.quota?.source === 'headers',
        )
        expect(state.accounts['fallback-1'].quota.accountIdentity).toBe(
          syntheticFallbackAccountUuid(0),
        )
        expect(state.accounts['fallback-1'].quota.five_hour.usedPercent).toBe(
          78,
        )
        expect(authorizations).toEqual([
          'Bearer sk-ant-oat01-main-access',
          `Bearer ${oldAccess}`,
        ])
      } finally {
        releaseFallback.open()
        await Promise.allSettled([responsePromise])
      }
    })

    test('fallback header push does not persist onto a different account identity', async () => {
      const accountXQuota: OAuthQuotaSnapshot = {
        accountIdentity: syntheticFallbackAccountUuid(0),
        five_hour: { usedPercent: 11, remainingPercent: 89, checkedAt: 1 },
      }
      const template = createFallbackStorage().accounts[0] as OAuthAccount
      await useTempAccountFile(
        bindPoolAccounts(
          createFallbackStorage({
            accounts: [
              {
                ...template,
                id: 'account-x',
                lastRefreshError: {
                  message: 'dead fallback',
                  checkedAt: Date.now(),
                  permanent: true,
                  // Import a failure bound to the exact stored refresh token.
                  tokenHash: createHash('sha256')
                    .update(template.refresh)
                    .digest('hex'),
                  accountIdentity: syntheticFallbackAccountUuid(0),
                },
                quota: accountXQuota,
              },
              {
                ...template,
                access: 'sk-ant-oat01-served-account-access',
                refresh: 'served-account-refresh',
                quota: {
                  ...accountXQuota,
                  accountIdentity: syntheticFallbackAccountUuid(1),
                },
              },
            ],
            quota: { enabled: false },
          }),
        ),
      )
      let messageCalls = 0
      globalThis.fetch = mock(
        withNativeAdmission((input: Parameters<typeof fetch>[0]) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage'))
            return Promise.resolve(
              new Response('usage-unavailable', { status: 500 }),
            )
          if (!url.includes('/v1/messages'))
            return Promise.resolve(Response.json({}))
          return Promise.resolve(
            ++messageCalls === 1
              ? new Response('limited', { status: 429 })
              : new Response('fallback-ok', { headers: quotaHeaders }),
          )
        }),
      ) as unknown as typeof fetch
      const before = await readNativeRuntimeState()
      expect(before.accounts['account-x']?.lastRefreshError?.permanent).toBe(
        true,
      )
      const result = await loadFetch()
      await result.fetch(MESSAGES_URL, EMPTY_POST)
      const state = await waitForState(
        (value) => value.accounts?.['fallback-1']?.quota?.source === 'headers',
      )
      expect(state.accounts['account-x'].quota).toEqual(accountXQuota)
      expect(state.accounts['fallback-1'].quota.accountIdentity).toBe(
        syntheticFallbackAccountUuid(1),
      )
      expect(state.accounts['fallback-1'].quota.five_hour.usedPercent).toBe(78)
    })

    test('main header push preserves persisted poll backoff across reload', async () => {
      const pollBackoff = {
        status: 429,
        accountIdentity: syntheticMainAccountUuid,
        message: 'Claude quota check failed: 429 — rate limited',
        checkedAt: Date.now(),
        nextRetryAt: Date.now() + 60_000,
        retryCount: 1,
      }
      await useTempAccountFile(
        bindMainAccount(
          createFallbackStorage({
            accounts: [],
            quota: {
              enabled: false,
              mainLastQuotaApiError: pollBackoff,
            },
          }),
        ),
      )
      globalThis.fetch = mock(
        withNativeAdmission(() =>
          Promise.resolve(new Response('main-ok', { headers: quotaHeaders })),
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      expect(await (await result.fetch(MESSAGES_URL, EMPTY_POST)).text()).toBe(
        'main-ok',
      )
      const state = await waitForState(
        (value) => value.main?.quota?.source === 'headers',
      )
      const reloaded = await readAccountStorage()

      // Public native views retain backoff fields but hide stored error text.
      expect(state.main.lastQuotaApiError).toEqual({
        ...pollBackoff,
        message: 'OAuth operation failed',
      })
      expect(state.main.quota.five_hour.usedPercent).toBe(78)
      expect(reloaded?.quota?.mainLastQuotaApiError).toEqual({
        ...pollBackoff,
        message: 'OAuth operation failed',
      })
      expect(reloaded?.quota?.mainQuota?.source).toBe('headers')
    })

    test('primary adapter harvests one response frame and makes no corroborating usage request', async () => {
      await useTempAccountFile(harvestStorage())
      let messageCalls = 0
      let usageCalls = 0
      const records: LogTestRecord[] = []
      __setLogTestSink((record) => records.push(record))
      globalThis.fetch = mock(
        withNativeAdmission((input: string | URL | Request) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage')) usageCalls++
          if (url.includes('/v1/messages')) messageCalls++
          return Promise.resolve(new Response('ok', { headers: quotaHeaders }))
        }),
      ) as unknown as typeof fetch
      const result = await loadFetch()
      setLogLevel('debug')

      await result.fetch(MESSAGES_URL, EMPTY_POST)
      const state = await waitForState(
        (value) => value.main?.quota?.source === 'headers',
      )

      expect(messageCalls).toBe(1)
      expect(usageCalls).toBe(0)
      await waitForLogRecord(
        records,
        (record) =>
          record.channel === 'quota' &&
          record.message === 'harvested response quota',
        'published primary quota log',
      )
      expect(
        records.filter(
          (record) =>
            record.channel === 'quota' &&
            record.message === 'harvested response quota',
        ),
      ).toHaveLength(1)
      expect(state.main.quota.source).toBe('headers')
      __setLogTestSink(null)
      setLogLevel('info')
    })

    test('fallback-served response updates that fallback and not main', async () => {
      await useTempAccountFile(harvestStorage(createFallbackStorage().accounts))
      let messages = 0
      globalThis.fetch = mock(
        withNativeAdmission((input: string | URL | Request) => {
          if (extractUrl(input).includes('/api/oauth/usage')) {
            return Promise.resolve(
              Response.json({
                five_hour: { utilization: 10 },
                seven_day: { utilization: 10 },
              }),
            )
          }
          messages++
          return Promise.resolve(
            messages === 1
              ? new Response('limited', { status: 429 })
              : new Response('fallback-ok', { headers: quotaHeaders }),
          )
        }),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      expect(await (await result.fetch(MESSAGES_URL, EMPTY_POST)).text()).toBe(
        'fallback-ok',
      )
      const state = await waitForState(
        (value) => value.accounts?.['fallback-1']?.quota?.source === 'headers',
      )
      expect(state.main?.quota?.source).not.toBe('headers')
    })

    test('fallback header push preserves persisted poll backoff across reload', async () => {
      const pollBackoff = {
        status: 429,
        accountIdentity: syntheticFallbackAccountUuid(0),
        message: 'Claude quota check failed: 429 — rate limited',
        checkedAt: Date.now(),
        nextRetryAt: Date.now() + 60_000,
        retryCount: 1,
      }
      const fallback = createFallbackStorage().accounts[0]
      if (fallback?.type !== 'oauth') {
        throw new Error('expected OAuth fallback fixture')
      }
      await useTempAccountFile(
        bindPoolAccounts(
          harvestStorage([{ ...fallback, lastQuotaRefreshError: pollBackoff }]),
        ),
      )
      let messages = 0
      globalThis.fetch = mock(
        withNativeAdmission((input: string | URL | Request) => {
          if (extractUrl(input).includes('/api/oauth/usage')) {
            return Promise.resolve(
              Response.json({
                five_hour: { utilization: 10 },
                seven_day: { utilization: 10 },
              }),
            )
          }
          messages++
          return Promise.resolve(
            messages === 1
              ? new Response('limited', { status: 429 })
              : new Response('fallback-ok', { headers: quotaHeaders }),
          )
        }),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      expect(await (await result.fetch(MESSAGES_URL, EMPTY_POST)).text()).toBe(
        'fallback-ok',
      )
      const state = await waitForState(
        (value) => value.accounts?.['fallback-1']?.quota?.source === 'headers',
      )
      const reloaded = await readAccountStorage()
      const reloadedFallback = reloaded?.accounts.find(
        (account): account is OAuthAccount =>
          account.id === 'fallback-1' && account.type === 'oauth',
      )

      expect(state.accounts['fallback-1'].lastQuotaRefreshError).toEqual({
        ...pollBackoff,
        message: 'OAuth operation failed',
      })
      expect(state.accounts['fallback-1'].quota.five_hour.usedPercent).toBe(78)
      expect(reloadedFallback?.lastQuotaRefreshError).toEqual({
        ...pollBackoff,
        message: 'OAuth operation failed',
      })
      expect(reloadedFallback?.quota?.source).toBe('headers')
    })

    test('sidebar state reflects header-pushed freshness and served fallback attribution', async () => {
      await useTempAccountFile(harvestStorage(createFallbackStorage().accounts))
      let messages = 0
      globalThis.fetch = mock(
        withNativeAdmission((input: string | URL | Request) => {
          if (extractUrl(input).includes('/api/oauth/usage')) {
            return Promise.resolve(
              Response.json({
                five_hour: { utilization: 10 },
                seven_day: { utilization: 10 },
              }),
            )
          }
          messages++
          return Promise.resolve(
            messages === 1
              ? new Response('limited', { status: 429 })
              : new Response('fallback-ok', { headers: quotaHeaders }),
          )
        }),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      await result.fetch(MESSAGES_URL, EMPTY_POST)
      const state = await waitForSidebarState(
        (value) =>
          value.activeId === 'fallback-1' &&
          value.fallbacks[0]?.quota?.five_hour?.usedPercent === 78,
      )

      expect(state.main.quota?.five_hour?.usedPercent).not.toBe(78)
      expect(state.fallbacks[0]?.id).toBe('fallback-1')
      expect(state.lastUpdated).toBeGreaterThan(0)
    })

    test('non-quota response does not push or persist quota', async () => {
      await useTempAccountFile(harvestStorage())
      globalThis.fetch = mock(
        withNativeAdmission(() => Promise.resolve(new Response('ok'))),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      await result.fetch(MESSAGES_URL, EMPTY_POST)
      await Bun.sleep(30)

      expect(
        (await readAccountStorage())?.quota?.mainQuota?.source,
      ).toBeUndefined()
    })

    test('non-finite utilization headers leave stored quota untouched', async () => {
      const existingQuota = {
        accountIdentity: syntheticMainAccountUuid,
        five_hour: {
          usedPercent: 11,
          remainingPercent: 89,
          checkedAt: 1,
        },
        fallbackAdvised: true,
        source: 'poll' as const,
        checkedAt: 1,
      }
      await useTempAccountFile(
        bindMainQuotaToAccount(
          createFallbackStorage({
            accounts: [],
            quota: {
              enabled: false,
              mainQuota: existingQuota,
              mainQuotaCheckedAt: 1,
              mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
            },
          }),
        ),
      )
      globalThis.fetch = mock(
        withNativeAdmission(() =>
          Promise.resolve(
            new Response('ok', {
              headers: {
                'anthropic-ratelimit-unified-5h-utilization': 'garbage',
                'anthropic-ratelimit-unified-7d-utilization': 'NaN',
              },
            }),
          ),
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      await result.fetch(MESSAGES_URL, EMPTY_POST)
      await Bun.sleep(30)

      expect((await readAccountStorage())?.quota?.mainQuota).toEqual(
        existingQuota,
      )
    })

    test('malformed quota headers never reject or replace the original response', async () => {
      await useTempAccountFile(harvestStorage())
      globalThis.fetch = mock(
        withNativeAdmission(() =>
          Promise.resolve(
            new Response('original', {
              status: 202,
              headers: {
                'anthropic-ratelimit-unified-5h-utilization': '0.5',
                'anthropic-ratelimit-unified-5h-reset': '1e308',
              },
            }),
          ),
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

      expect(response.status).toBe(202)
      expect(await response.text()).toBe('original')
    })

    test('header push persists source headers and refreshes sidebar checkedAt without a usage poll', async () => {
      await useTempAccountFile(harvestStorage())
      const published = bodyLifetime().gate()
      const sidebarPath = getSidebarStateFile()
      // Returning the model response does not join quota persistence or its
      // sidebar refresh. Wait for the atomic sidebar publication containing
      // these headers, rather than assuming it fits a polling deadline.
      __setSidebarStateWriteTestHooks(
        {
          afterRename: async () => {
            const state = await getSidebarState(sidebarPath)
            if (state.main.quota?.five_hour?.usedPercent === 78)
              published.open()
          },
        },
        sidebarPath,
      )
      try {
        let usageCalls = 0
        let committedQuota:
          | ReturnType<typeof waitForNativePoolQuota>
          | undefined
        globalThis.fetch = mock(
          withNativeAdmission((input: string | URL | Request) => {
            const url = extractUrl(input)
            if (url.includes('/api/oauth/usage')) usageCalls++
            if (url.includes('/v1/messages'))
              expect(committedQuota).toBeDefined()
            return Promise.resolve(
              new Response('ok', { headers: quotaHeaders }),
            )
          }),
        ) as unknown as typeof fetch
        const result = await loadFetch()
        // Listen before starting the request. Both the quota flush timer and
        // background sidebar work must make progress without sibling tests'
        // handles, even if the pool commit precedes the sidebar publication.
        committedQuota = waitForNativePoolQuota(
          'main',
          (quota) =>
            quota?.source === 'headers' && quota.five_hour?.usedPercent === 78,
          { keepAliveUntil: published.wait },
        )
        bodyLifetime().trackDetached(committedQuota)

        const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
        expect(response.status).toBe(200)
        await published.wait
        await committedQuota
        const state = await getSidebarState(sidebarPath)
        const storage = await readAccountStorage()

        expect(state.main.quota?.five_hour?.usedPercent).toBe(78)
        expect(state.lastUpdated).toBeGreaterThan(0)
        expect(storage?.quota?.mainQuota?.source).toBe('headers')
        expect(storage?.quota?.mainQuotaCheckedAt).toBeGreaterThan(0)
        expect(usageCalls).toBe(0)
        await response.text()
      } finally {
        __setSidebarStateWriteTestHooks(null, sidebarPath)
      }
    })

    test('successful harvest emits one quota debug record without raw headers', async () => {
      await useTempAccountFile(harvestStorage())
      const records: LogTestRecord[] = []
      __setLogTestSink((record) => records.push(record))
      globalThis.fetch = mock(
        withNativeAdmission(() =>
          Promise.resolve(new Response('ok', { headers: quotaHeaders })),
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch()
      setLogLevel('debug')

      await result.fetch(MESSAGES_URL, EMPTY_POST)

      await waitForLogRecord(
        records,
        (record) =>
          record.channel === 'quota' &&
          record.message === 'harvested response quota',
        'published quota log',
      )
      const harvested = records.filter(
        (record) =>
          record.channel === 'quota' &&
          record.message === 'harvested response quota',
      )
      expect(harvested).toHaveLength(1)
      expect(JSON.stringify(harvested[0])).not.toContain('anthropic-ratelimit')
      __setLogTestSink(null)
      setLogLevel('info')
    })

    test('repeated out-of-range resets do not warn and restore log state', async () => {
      await useTempAccountFile(harvestStorage())
      const records: LogTestRecord[] = []
      __setLogTestSink((record) => records.push(record))
      globalThis.fetch = mock(
        withNativeAdmission(() =>
          Promise.resolve(
            new Response('ok', {
              headers: {
                'anthropic-ratelimit-unified-5h-utilization': '0.5',
                'anthropic-ratelimit-unified-5h-reset': '1e308',
              },
            }),
          ),
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      await result.fetch(MESSAGES_URL, EMPTY_POST)
      await result.fetch(MESSAGES_URL, EMPTY_POST)

      expect(
        records.filter(
          (record) =>
            record.channel === 'quota' &&
            record.message === 'failed to normalize response quota headers',
        ),
      ).toHaveLength(0)
      __setLogTestSink(null)
      setLogLevel('info')
    })
  })
})

// -- /claude-prime: direct OAuth sender + quota refresh + accounting ------

describe('claude-prime direct request', () => {
  const originalFetch = globalThis.fetch

  beforeEach(async () => {
    // Marker dir is shared across processes; sweep leftovers so a prior
    // suite's fire doesn't suppress the next suite's claim.
    await rm(join(tmpdir(), 'opencode-anthropic-auth', 'prime'), {
      recursive: true,
      force: true,
    }).catch(() => {})
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('main prime fires a direct messages request with the documented body shape', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                resetsAt: new Date(past).toISOString(),
                checkedAt: 1,
              },
            },
            mainQuotaCheckedAt: 1,
            mainQuotaToken: 'fp-main',
          },
          prime: { enabled: true },
        }),
      ),
    )

    const primeCalls: Array<{
      url: string
      init: RequestInit | undefined
    }> = []
    let quotaCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        if (url.includes('/v1/messages')) {
          primeCalls.push({ url, init })
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: 'msg-test',
                usage: { input_tokens: 20, output_tokens: 1 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          )
        }
        if (url.includes('/api/oauth/usage')) {
          quotaCalls += 1
          return freshPrimeQuotaResponse({
            five_hour: {
              utilization: 0,
              resets_at: new Date(now - 1_000).toISOString(),
            },
          })
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    // Reach into the plugin's internal manager via the auth closure wiring
    // already in place: the manager has been constructed with sendPrime wired
    // to a closure that calls the auth loader. Trigger an explicit tick via
    // the manager factory on `plugin`.
    const mgr = getPluginTestHandles(plugin).primeManager
    expect(mgr).toBeDefined()
    await mgr!.tick()

    expect(primeCalls).toHaveLength(1)
    // The prime request routes through rewriteUrl which appends
    // ?beta=true to /v1/messages URLs (house convention for direct
    // Anthropic calls). Assert the URL is the messages endpoint with
    // the beta param rather than the bare path.
    expect(primeCalls[0]?.url).toBe(`${MESSAGES_URL}?beta=true`)
    const init = primeCalls[0]?.init
    const bodyText =
      typeof init?.body === 'string'
        ? init.body
        : init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : ''
    const body = JSON.parse(bodyText)
    const canonicalBody = await rewriteRequestBody(
      JSON.stringify(buildPrimeRequestBody()),
      {
        identity: getClaudeCodeIdentityForVerifiedAccount(
          syntheticMainAccountUuid,
          syntheticMainAccountUuid,
        ),
      },
    )
    expect(bodyText).toBe(canonicalBody)
    expect(body.model).toBe('claude-haiku-4-5')
    expect(body.max_tokens).toBe(1)
    expect(body.messages).toEqual([{ role: 'user', content: '0' }])
    expect(JSON.stringify(body.system)).toContain(
      'Reply with 1 when you receive 0.',
    )
    expect(extractBillingHeaderCCH(bodyText)).toMatch(/^[a-f0-9]{5}$/)
    expect(body.stream).toBeUndefined()
    expect(body.thinking).toBeUndefined()
    expect(body.tools).toBeUndefined()
    expect(bodyText).not.toContain('cache_control')

    // Quota fresh-check fired before the request
    expect(quotaCalls).toBeGreaterThanOrEqual(1)
  })

  test('main prime uses main OAuth token + Anthropic identity headers', async () => {
    const requestStages: string[] = []
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                resetsAt: new Date(past).toISOString(),
                checkedAt: 1,
              },
            },
            mainQuotaCheckedAt: 1,
            mainQuotaToken: 'fp-main',
          },
          prime: { enabled: true },
        }),
      ),
    )

    let observedAuth: string | undefined
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          requestStages.push(
            url.includes('/api/oauth/usage')
              ? 'quota'
              : url.includes('/v1/messages')
                ? 'model'
                : 'other',
          )
          if (url.includes('/v1/messages')) {
            const headers = new Headers(init?.headers ?? {})
            observedAuth = headers.get('authorization') ?? undefined
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  usage: { input_tokens: 20, output_tokens: 1 },
                }),
                {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                },
              ),
            )
          }
          if (url.includes('/api/oauth/usage')) {
            return freshPrimeQuotaResponse({
              five_hour: {
                utilization: 0,
                resets_at: new Date(now - 1_000).toISOString(),
              },
            })
          }
          return Promise.resolve(new Response('not-mocked', { status: 599 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const mgr = getPluginTestHandles(plugin).primeManager
    if (!(mgr instanceof Core.PrimeManager))
      throw new Error('Expected the native Prime manager')
    await mgr.tick()

    await assertPrimeWithPublicDiagnostics(mgr, requestStages, () => {
      expect(observedAuth).toBeDefined()
      expect(observedAuth).toContain('sk-ant-oat01-main-access')
    })
  })

  test('main host credential replacement keeps the stable lineage in the same reset window', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                resetsAt: new Date(past).toISOString(),
                checkedAt: 1,
              },
            },
            mainQuotaCheckedAt: 1,
            mainQuotaToken: 'fp-main',
          },
          prime: { enabled: true },
        }),
        'sk-ant-oat01-main-access-a',
      ),
      {
        access: 'sk-ant-oat01-main-access-a',
        refresh: 'main-refresh-a',
        expires: Date.now() + 100000,
      },
    )

    let sends = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/v1/messages')) {
          sends += 1
          return Promise.resolve(
            new Response(
              JSON.stringify({
                usage: { input_tokens: 20, output_tokens: 1 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          )
        }
        if (url.includes('/api/oauth/usage')) {
          return freshPrimeQuotaResponse({
            five_hour: {
              utilization: 0,
              resets_at: new Date(now - 1_000).toISOString(),
            },
          })
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
    ) as unknown as typeof fetch

    const firstPlugin = await getPlugin()
    await firstPlugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access-a',
          refresh: 'main-refresh-a',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await getPluginTestHandles(firstPlugin).primeManager.tick()
    const firstLineage = (await readAccountStorage())?.prime?.mainAuthLineageId

    // The main login's tokens rotate for the same account (a refresh in
    // another OpenCode process); a second plugin instance then starts.
    await refreshPoolMainElsewhere({
      access: 'sk-ant-oat01-main-access-b',
      refresh: 'main-refresh-b',
      expires: Date.now() + 100000,
    })
    const secondPlugin = await getPlugin()
    await secondPlugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access-a',
          refresh: 'main-refresh-a',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await getPluginTestHandles(secondPlugin).primeManager.tick()

    expect(sends).toBe(1)
    expect(firstLineage).toMatch(/^[0-9a-f-]{36}$/)
    expect((await readAccountStorage())?.prime?.mainAuthLineageId).toBe(
      firstLineage,
    )
  })

  test('main refresh through the plugin keeps the lineage and prime claim', async () => {
    const past = Date.now() - 180_000
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          accounts: [],
          prime: { enabled: true },
          quota: {
            ...createFallbackStorage().quota,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                resetsAt: new Date(past).toISOString(),
                checkedAt: 1,
              },
            },
          },
        }),
        'sk-ant-oat01-main-access-a',
      ),
      {
        access: 'sk-ant-oat01-main-access-a',
        refresh: 'main-refresh-a',
        expires: Date.now() + 5 * 60 * 60_000,
      },
    )
    mainAccountIssues('sk-ant-oat01-main-access-b')
    let primeSends = 0
    let tokenExchanges = 0
    const foregroundAuthorizations: Array<string | null> = []
    globalThis.fetch = mock(
      withNativeBootstrap(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/v1/oauth/token')) {
            tokenExchanges += 1
            return Promise.resolve(
              Response.json({
                access_token: 'sk-ant-oat01-main-access-b',
                refresh_token: 'main-refresh-b',
                expires_in: 5 * 60 * 60,
              }),
            )
          }
          if (url.includes('/api/oauth/usage'))
            return freshPrimeQuotaResponse({
              five_hour: {
                utilization: 0,
                resets_at: new Date(past).toISOString(),
              },
            })
          if (url.includes('/v1/messages')) {
            const body = JSON.parse(String(init?.body))
            if (body.model === 'claude-haiku-4-5' && body.max_tokens === 1) {
              primeSends += 1
              return Promise.resolve(
                Response.json({
                  usage: { input_tokens: 20, output_tokens: 1 },
                }),
              )
            }
            const authorization = new Headers(init?.headers).get(
              'authorization',
            )
            foregroundAuthorizations.push(authorization)
            return Promise.resolve(
              new Response('{}', {
                status:
                  authorization === 'Bearer sk-ant-oat01-main-access-a'
                    ? 401
                    : 200,
              }),
            )
          }
          throw new Error(`Unexpected test endpoint: ${url}`)
        },
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access-a',
          refresh: 'main-refresh-a',
          expires: Date.now() + 5 * 60 * 60_000,
        }),
      { models: {} },
    )
    const manager = getPluginTestHandles(plugin).primeManager
    await manager.tick()
    const before = (await readAccountStorage())?.prime?.mainAuthLineageId
    expect(before).toMatch(/^[0-9a-f-]{36}$/)
    expect(tokenExchanges).toBe(0)
    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    expect(response.status).toBe(200)
    expect(tokenExchanges).toBe(1)
    expect(foregroundAuthorizations).toEqual([
      'Bearer sk-ant-oat01-main-access-a',
      'Bearer sk-ant-oat01-main-access-b',
    ])
    expect(await poolMainAccess()).toBe('sk-ant-oat01-main-access-b')
    await manager.tick()
    expect(primeSends).toBe(1)
    expect((await readAccountStorage())?.prime?.mainAuthLineageId).toBe(before)
    await expectHostActivationNonSecret(
      'sk-ant-oat01-main-access-a',
      'sk-ant-oat01-main-access-b',
      'main-refresh-a',
      'main-refresh-b',
    )
  })

  test('a late main 401 adopts externally rotated credentials and preserves the imported Prime lineage', async () => {
    const lineage = 'main-lineage-a'
    const refreshToken = 'main-refresh-a'
    await useTempAccountFile(
      bindMainAccount(
        createFallbackStorage({
          accounts: [],
          quota: { ...createFallbackStorage().quota, enabled: false },
          refresh: {
            enabled: true,
            refreshBeforeExpiryMinutes: 30,
            mainRefreshLeaseId: 'other-process',
            mainRefreshLeaseUntil: Date.now() + 60_000,
            mainRefreshLeaseTokenHash: hashRefreshToken(refreshToken),
          },
          prime: {
            enabled: true,
            mainAuthLineageId: lineage,
            mainAuthLineageRefreshTokenFingerprint:
              tokenFingerprint(refreshToken),
          },
        }),
        'sk-ant-oat01-main-access-a',
      ),
      {
        access: 'sk-ant-oat01-main-access-a',
        refresh: refreshToken,
        expires: Date.now() + 5 * 60 * 60_000,
      },
    )
    globalThis.fetch = mock(
      withNativeAdmission(() => Response.json({})),
    ) as unknown as typeof fetch
    expect(await poolMainAccess()).toBe('sk-ant-oat01-main-access-a')
    const firstRequest = bodyLifetime().gate()
    const releaseRejectedResponse = bodyLifetime().gate()
    const controller = new AbortController()
    let reachedModel = false
    const authorizations: Array<string | null> = []
    let pluginTokenExchanges = 0
    globalThis.fetch = mock(
      withNativeBootstrap(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/v1/oauth/token')) {
            pluginTokenExchanges += 1
            throw new Error(
              'The plugin must adopt the externally rotated token',
            )
          }
          if (url.includes('/v1/messages')) {
            const authorization = new Headers(init?.headers).get(
              'authorization',
            )
            authorizations.push(authorization)
            if (authorization === 'Bearer sk-ant-oat01-main-access-a') {
              reachedModel = true
              firstRequest.open()
              return releaseRejectedResponse.wait.then(
                () => new Response('{}', { status: 401 }),
              )
            }
            return Promise.resolve(new Response('{}', { status: 200 }))
          }
          if (url.includes('/api/oauth/usage'))
            return freshPrimeQuotaResponse({
              five_hour: { utilization: 0 },
              seven_day: { utilization: 0 },
            })
          throw new Error(`Unexpected test endpoint: ${url}`)
        },
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access-a',
          refresh: refreshToken,
          expires: Date.now() + 5 * 60 * 60_000,
        }),
      { models: {} },
    )
    const request = result.fetch(MESSAGES_URL, {
      ...EMPTY_POST,
      signal: controller.signal,
    })
    try {
      await Promise.race([
        firstRequest.wait,
        request.then(() => {
          throw new Error('Request completed before the rejection fixture')
        }),
      ])
      if (!reachedModel)
        throw new Error(
          'Model request did not reach the fixture before cancellation',
        )
      await refreshPoolMainElsewhere({
        access: 'sk-ant-oat01-main-access-b',
        refresh: 'main-refresh-b',
        expires: Date.now() + 5 * 60 * 60_000,
      })
      releaseRejectedResponse.open()
      expect((await request).status).toBe(200)
      expect(authorizations).toEqual([
        'Bearer sk-ant-oat01-main-access-a',
        'Bearer sk-ant-oat01-main-access-b',
      ])
      expect(pluginTokenExchanges).toBe(0)
      expect((await readAccountStorage())?.prime?.mainAuthLineageId).toBe(
        lineage,
      )
      await expectHostActivationNonSecret(
        'sk-ant-oat01-main-access-a',
        'sk-ant-oat01-main-access-b',
        refreshToken,
        'main-refresh-b',
      )
    } finally {
      controller.abort()
      releaseRejectedResponse.open()
      await request.catch(() => {})
    }
  })

  test('fallback prime uses fallback OAuth token', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    // Marker dir is shared across tests; sweep any leftover marker for
    // this reset epoch so a prior suite's fire doesn't suppress the
    // claim and the fresh-check is forced through.
    await rm(join(tmpdir(), 'opencode-anthropic-auth', 'prime'), {
      recursive: true,
      force: true,
    }).catch(() => {})
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          accounts: [
            {
              id: 'work-alt',
              type: 'oauth',
              access: 'sk-ant-oat01-fb-access',
              refresh: 'fb-refresh',
              // expires must exceed the refresh-before-expiry window (4h default)
              // so the token is NOT marked as needing refresh and the prime
              // request flows through without the OAuth refresh fetch.
              expires: Date.now() + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  resetsAt: new Date(past).toISOString(),
                  // Recent (1min) so the background refresh's
                  // `isFallbackStale` guard does NOT fire a competing
                  // refresh in the same millisecond — without this the
                  // prime fresh-check's baseline equals the fetched
                  // checkedAt and `fresh` is false. The check-interval
                  // gate is 5min (storage.quota.checkIntervalMinutes),
                  // so a 1min-old checkedAt is comfortably fresh.
                  checkedAt: Date.now() - 60 * 1000,
                },
              },
            },
          ],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
          },
          prime: { enabled: true },
        }),
      ),
    )

    const calls: Array<{ url: string; auth?: string }> = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        const headers = new Headers(init?.headers ?? {})
        calls.push({ url, auth: headers.get('authorization') ?? undefined })
        if (url.includes('/v1/messages')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                usage: { input_tokens: 20, output_tokens: 1 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          )
        }
        if (url.includes('/api/oauth/usage')) {
          return freshPrimeQuotaResponse({
            five_hour: {
              utilization: 0,
              resets_at: new Date(now - 1_000).toISOString(),
            },
          })
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const mgr = getPluginTestHandles(plugin).primeManager
    await mgr!.tick()

    const primeCall = calls.find(
      (c) =>
        c.url === `${MESSAGES_URL}?beta=true` &&
        c.auth?.includes('sk-ant-oat01-fb-access'),
    )
    expect(primeCall).toBeDefined()
    expect(primeCall?.auth).toContain('sk-ant-oat01-fb-access')
  })

  test('fallback refresh-token rotation keeps one prime claim per reset window', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          accounts: [
            {
              id: 'work-rotating',
              type: 'oauth',
              access: 'sk-ant-oat01-fb-access-a',
              refresh: 'fb-refresh-a',
              expires: Date.now() + 5 * 60 * 60 * 1000,
              authLineageId: 'lineage-work',
              quota: {
                five_hour: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  resetsAt: new Date(past).toISOString(),
                  checkedAt: Date.now() - 60 * 1000,
                },
              },
            },
          ],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
          },
          prime: { enabled: true },
        }),
      ),
    )

    let sends = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        if (url.includes('/v1/messages')) {
          const authorization = new Headers(init?.headers).get('authorization')
          if (authorization?.includes('fb-access-')) sends += 1
          return Promise.resolve(
            new Response(
              JSON.stringify({
                usage: { input_tokens: 20, output_tokens: 1 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          )
        }
        if (url.includes('/api/oauth/usage')) {
          return freshPrimeQuotaResponse({
            five_hour: {
              utilization: 0,
              resets_at: new Date(now - 1_000).toISOString(),
            },
          })
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const mgr = getPluginTestHandles(plugin).primeManager

    await mgr!.tick()
    // Another process refreshes the fallback; its refresh token rotates.
    loginIssues('sk-ant-oat01-fb-access-a', 'sk-ant-oat01-fb-access-b')
    await refreshPoolLoginElsewhere('work-rotating', {
      access: 'sk-ant-oat01-fb-access-b',
      refresh: 'fb-refresh-b',
      expires: Date.now() + 5 * 60 * 60 * 1000,
    })
    await mgr!.tick()

    expect(sends).toBe(1)
  })

  test('send failure does not increment prime counters; no retry in same cycle', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                resetsAt: new Date(past).toISOString(),
                checkedAt: 1,
              },
            },
            mainQuotaCheckedAt: 1,
            mainQuotaToken: 'fp-main',
          },
          prime: { enabled: true },
        }),
      ),
    )

    let messageCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/v1/messages')) {
          messageCalls += 1
          return Promise.resolve(new Response('boom', { status: 500 }))
        }
        if (url.includes('/api/oauth/usage')) {
          return freshPrimeQuotaResponse({
            five_hour: {
              utilization: 0,
              resets_at: new Date(now - 1_000).toISOString(),
            },
          })
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const mgr = getPluginTestHandles(plugin).primeManager
    await mgr!.tick()
    await mgr!.tick()

    // Two ticks in the same reset cycle: marker claimed → second tick skips
    expect(messageCalls).toBe(1)

    // No counter incremented (the main account records no prime usage)
    const raw = await readNativeRuntimeState()
    expect(raw.main?.prime).toBeUndefined()
  })

  test('successful send increments main prime counters', async () => {
    const requestStages: string[] = []
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                resetsAt: new Date(past).toISOString(),
                checkedAt: 1,
              },
            },
            mainQuotaCheckedAt: 1,
            mainQuotaToken: 'fp-main',
          },
          prime: { enabled: true },
        }),
      ),
    )

    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        const url = extractUrl(input)
        if (url.includes('/v1/messages')) {
          requestStages.push('model')
          return Promise.resolve(
            new Response(
              JSON.stringify({
                usage: { input_tokens: 20, output_tokens: 1 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          )
        }
        if (url.includes('/api/oauth/usage')) {
          requestStages.push('quota')
          return freshPrimeQuotaResponse({
            five_hour: {
              utilization: 0,
              resets_at: new Date(now - 1_000).toISOString(),
            },
          })
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const mgr = getPluginTestHandles(plugin).primeManager
    if (!(mgr instanceof Core.PrimeManager))
      throw new Error('Expected the native Prime manager')
    await mgr.tick()

    const raw = await readNativeRuntimeState()
    await assertPrimeWithPublicDiagnostics(mgr, requestStages, () => {
      expect(raw.main?.prime).toEqual({
        count: 1,
        inputTokens: 20,
        outputTokens: 1,
        since: expect.any(Number),
      })
    })
  })

  test('main prime refreshes a missing access token before firing (M2)', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                resetsAt: new Date(past).toISOString(),
                checkedAt: 1,
              },
            },
            mainQuotaCheckedAt: 1,
            mainQuotaToken: 'fp-main',
          },
          prime: { enabled: true },
        }),
        'sk-ant-oat01-expired-main-access',
      ),
      // The pool's main access token has expired, so it has no usable
      // access token until it refreshes.
      {
        access: 'sk-ant-oat01-expired-main-access',
        refresh: 'main-refresh',
        expires: Date.now() - 1_000,
      },
    )
    mainAccountIssues('sk-ant-oat01-refreshed-main-access')

    const primeCalls: Array<{ url: string; init: RequestInit | undefined }> = []
    let _quotaCalls = 0
    globalThis.fetch = mock(
      withNativeBootstrap((input: any, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.url
        const _headers = new Headers(init?.headers ?? {})
        if (url.includes('/v1/messages')) {
          primeCalls.push({ url, init })
          return Promise.resolve(
            new Response(
              JSON.stringify({
                usage: { input_tokens: 20, output_tokens: 1 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          )
        }
        if (url.includes('/api/oauth/usage')) {
          _quotaCalls += 1
          return freshPrimeQuotaResponse({
            five_hour: {
              utilization: 0,
              resets_at: new Date(Date.now() - 1_000).toISOString(),
            },
          })
        }
        if (url.includes('/v1/oauth/token')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                access_token: 'sk-ant-oat01-refreshed-main-access',
                refresh_token: 'main-refresh',
                expires_in: 3600,
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          )
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-expired-main-access',
          refresh: 'main-refresh',
          expires: Date.now() - 1_000,
        }),
      { models: {} },
    )
    const mgr = getPluginTestHandles(plugin).primeManager
    expect(mgr).toBeDefined()
    await mgr!.tick()

    // The prime request should have fired with the refreshed token.
    expect(primeCalls).toHaveLength(1)
    const init = primeCalls[0]?.init
    const headers = new Headers(init?.headers ?? {})
    expect(headers.get('authorization')).toContain(
      'sk-ant-oat01-refreshed-main-access',
    )
  })

  test('plugin instances with the same storage path adopt one prime manager', async () => {
    const fixture = createFallbackStorage({
      prime: { enabled: true },
    })
    await useTempAccountFile(fixture)
    const plugin1 = await getPlugin()
    const mgr1 = getPluginTestHandles(plugin1).primeManager
    const firstLoadStorage = mgr1.options.loadStorage
    expect(mgr1).toBeDefined()
    expect(mgr1.isStopped?.()).toBeFalsy()
    const plugin2 = await getPlugin()
    const mgr2 = getPluginTestHandles(plugin2).primeManager
    expect(mgr2).toBeDefined()
    expect(mgr2).toBe(mgr1)
    expect(mgr2.options.loadStorage).not.toBe(firstLoadStorage)
    expect(mgr1.isStopped()).toBe(false)
  })

  test('plugin instances with different storage paths own independent prime managers', async () => {
    const fixture = createFallbackStorage({ prime: { enabled: true } })
    await useTempAccountFile(fixture)
    const plugin1 = await getPlugin(undefined, '/project/one')
    const mgr1 = getPluginTestHandles(plugin1).primeManager

    await useTempAccountFile(fixture)
    const plugin2 = await getPlugin(undefined, '/project/two')
    const mgr2 = getPluginTestHandles(plugin2).primeManager

    expect(mgr2).not.toBe(mgr1)
    expect(mgr1.isStopped()).toBe(false)
    expect(mgr2.isStopped()).toBe(false)
  })
})

describe('claude-prime sidebar on toggle', () => {
  let sidebarStateFile: string | undefined

  beforeEach(async () => {
    await rm(join(tmpdir(), 'opencode-anthropic-auth', 'prime'), {
      recursive: true,
      force: true,
    }).catch(() => {})
  })
  async function readSidebar(): Promise<{
    prime?: { enabled?: boolean; accounts?: unknown }
  }> {
    if (!sidebarStateFile) {
      throw new Error('sidebar state file not configured')
    }
    const fs = await import('node:fs/promises')
    try {
      return JSON.parse(await fs.readFile(sidebarStateFile, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Sidebar file has not been written yet — treat as empty
        // (degenerate) state with no `prime` field.
        return {}
      }
      throw error
    }
  }

  test('/claude-prime on publishes prime section to the sidebar (M7)', async () => {
    const fixture = createFallbackStorage({
      prime: { enabled: false },
    })
    await useTempAccountFile(fixture)
    sidebarStateFile = process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE
    const plugin = await getPlugin(undefined, testContext.tempConfigDir)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 3600_000,
        }),
      { models: {} },
    )
    // Baseline: prime disabled in storage → no prime section in sidebar.
    const before = await readSidebar()
    expect(before.prime).toBeUndefined()

    expect(
      (
        await applyMenuAction(plugin, 'ses_test', {
          sectionId: 'Extras',
          actionId: 'prime-on',
        })
      ).ok,
    ).toBe(true)

    // After on, sidebar has the prime section.
    const afterOn = await readSidebar()
    expect(afterOn.prime?.enabled).toBe(true)
    expect(afterOn.prime?.accounts).toBeDefined()
  })

  test('/claude-prime off removes prime section from the sidebar (M7)', async () => {
    const fixture = createFallbackStorage({
      prime: { enabled: true },
    })
    await useTempAccountFile(fixture)
    sidebarStateFile = process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE
    const plugin = await getPlugin(undefined, testContext.tempConfigDir)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 3600_000,
        }),
      { models: {} },
    )
    // Enable priming and confirm its sidebar row exists before disabling it.
    // Otherwise an absent row after disable could make this test pass vacuously.
    expect(
      (
        await applyMenuAction(plugin, 'ses_test', {
          sectionId: 'Extras',
          actionId: 'prime-on',
        })
      ).ok,
    ).toBe(true)
    const baseline = await readSidebar()
    expect(baseline.prime?.enabled).toBe(true)

    expect(
      (
        await applyMenuAction(plugin, 'ses_test', {
          sectionId: 'Extras',
          actionId: 'prime-off',
        })
      ).ok,
    ).toBe(true)

    // After off, prime section is removed.
    const afterOff = await readSidebar()
    expect(afterOff.prime).toBeUndefined()
  })
})

describe('claude-prime — snapshot-derived freshness (R1/R2)', () => {
  // Before starting an account's five-hour window, PrimeManager must obtain
  // its quota from one current usage request. Cached quota cannot authorize
  // that request, and the fallback quota check must not poll twice.

  const originalFetch = globalThis.fetch

  beforeEach(async () => {
    // Marker dir is shared across processes; sweep leftovers so a prior
    // suite's fire doesn't suppress the next suite's claim.
    await rm(join(tmpdir(), 'opencode-anthropic-auth', 'prime'), {
      recursive: true,
      force: true,
    }).catch(() => {})
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('R1: the manager skips a quota result classified stale', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                resetsAt: new Date(past).toISOString(),
                checkedAt: 10,
              },
            },
            mainQuotaCheckedAt: 10,
            mainQuotaToken: 'fp-main',
          },
          prime: { enabled: true },
        }),
      ),
    )

    const primeCalls: any[] = []
    const cachedQuota = {
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: new Date(past).toISOString(),
        checkedAt: 10,
      },
    }

    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        const url = extractUrl(input)
        if (url.includes('/v1/messages')) {
          primeCalls.push({ url })
          return Promise.resolve(
            new Response(
              JSON.stringify({ usage: { input_tokens: 0, output_tokens: 0 } }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          )
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 3600_000,
        }),
      { models: {} },
    )
    const mgr = getPluginTestHandles(plugin).primeManager
    if (!(mgr instanceof Core.PrimeManager))
      throw new Error('Expected the native Prime manager')
    let freshChecks = 0
    mgr.options.refreshQuota = async () => {
      freshChecks += 1
      return { quota: cachedQuota, fresh: false }
    }
    await mgr.tick()

    expect(freshChecks).toBe(1)
    expect(primeCalls).toHaveLength(0)
  })

  test('R1: the manager fires after a quota result classified fresh', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                resetsAt: new Date(past).toISOString(),
                checkedAt: 10,
              },
            },
            mainQuotaCheckedAt: 10,
            mainQuotaToken: 'fp-main',
          },
          prime: { enabled: true },
        }),
      ),
    )

    const primeCalls: Array<{ url: string }> = []
    const freshQuota = {
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: new Date(past).toISOString(),
        checkedAt: 100,
      },
    }

    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = typeof input === 'string' ? input : input.url
        if (url.includes('/v1/messages')) {
          primeCalls.push({ url })
          return Promise.resolve(
            new Response(
              JSON.stringify({ usage: { input_tokens: 0, output_tokens: 0 } }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          )
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 3600_000,
        }),
      { models: {} },
    )
    const mgr = getPluginTestHandles(plugin).primeManager
    mgr.options.refreshQuota = async () => ({
      quota: freshQuota,
      fresh: true,
    })
    await mgr.tick()

    expect(primeCalls).toHaveLength(1)
  })

  test('R2: refreshPrimeFallbackQuota makes exactly one usage-API call per tick', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    // A marker records that an account's five-hour window was already started.
    // Remove markers from this sandbox so a previous run cannot suppress
    // this test's request or make it check a different reset window.
    await rm(join(tmpdir(), 'opencode-anthropic-auth', 'prime'), {
      recursive: true,
      force: true,
    }).catch(() => {})
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          accounts: [
            {
              id: 'work-alt',
              type: 'oauth',
              access: 'sk-ant-oat01-fb-access',
              refresh: 'fb-refresh',
              // expires must exceed the 4h refresh-before-expiry window so
              // the token is NOT marked as needing refresh (otherwise the
              // refresh path would make a second fetch to /v1/oauth/token).
              expires: Date.now() + 10 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  resetsAt: new Date(past).toISOString(),
                  // A one-minute-old reading is within the five-minute poll
                  // interval. Startup must not start another usage request;
                  // this test counts only the poll triggered by Prime.
                  checkedAt: Date.now() - 60 * 1000,
                },
              },
            },
          ],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                resetsAt: new Date(Date.now() + 5 * 60 * 60_000).toISOString(),
                checkedAt: Date.now(),
              },
            },
            mainQuotaCheckedAt: Date.now(),
            mainQuotaToken: 'sk-ant-oat01-main-access',
          },
          prime: { enabled: true },
        }),
      ),
    )

    let usageCalls = 0
    let primeCalls = 0
    globalThis.fetch = mock(
      withNativeBootstrap((input: Parameters<typeof fetch>[0]) => {
        const url = extractUrl(input)
        if (url.includes('/v1/messages')) {
          primeCalls += 1
          return Promise.resolve(
            new Response(
              JSON.stringify({ usage: { input_tokens: 20, output_tokens: 1 } }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          )
        }
        if (url.includes('/api/oauth/usage')) {
          usageCalls += 1
          return freshPrimeQuotaResponse(
            {
              five_hour: {
                utilization: 0,
                resets_at: new Date(Date.now() - 1_000).toISOString(),
                checked_at: Date.now(),
              },
            },
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 3600_000,
        }),
      { models: {} },
    )
    const mgr = getPluginTestHandles(plugin).primeManager
    await mgr.tick()

    // Exactly ONE usage-API call per tick — the redundant second
    // refreshFallback is collapsed into the single refreshAccountQuota
    // path.
    expect(usageCalls).toBe(1)
    // The fire still happens against the (now-fresh) quota result.
    expect(primeCalls).toBe(1)
  })

  test('R1: fallback 429 backoff classifies a re-stamped cached quota as stale', async () => {
    const now = Date.now()
    const past = now - 120_000
    const cachedQuota = {
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: new Date(past).toISOString(),
        checkedAt: now + 60_000,
      },
    }
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          accounts: [
            {
              id: 'work-alt',
              type: 'oauth',
              access: 'sk-ant-oat01-fb-access',
              refresh: 'fb-refresh',
              expires: now + 10 * 60 * 60_000,
              quota: cachedQuota,
            },
          ],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                resetsAt: new Date(now + 5 * 60 * 60_000).toISOString(),
                checkedAt: now,
              },
            },
            mainQuotaCheckedAt: now,
            mainQuotaToken: 'sk-ant-oat01-main-access',
          },
          prime: { enabled: true },
        }),
      ),
    )

    let primeCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = typeof input === 'string' ? input : input.url
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(new Response('rate limited', { status: 429 }))
        }
        if (url.includes('/v1/messages')) {
          primeCalls += 1
          return Promise.resolve(
            new Response(
              JSON.stringify({ usage: { input_tokens: 20, output_tokens: 1 } }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          )
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: now + 3600_000,
        }),
      { models: {} },
    )
    const quotaManager = getPluginTestHandles(plugin).quotaManager
    const mgr = getPluginTestHandles(plugin).primeManager
    if (
      !(quotaManager instanceof Core.QuotaManager) ||
      !(mgr instanceof Core.PrimeManager)
    )
      throw new Error('Expected the native quota and Prime managers')
    const storage = await mgr.options.loadStorage()
    const account = storage?.accounts.find(
      (candidate) => candidate.id === 'work-alt',
    )
    if (
      account?.type !== 'oauth' ||
      !account.authLineageId ||
      !account.anthropicAccountUuid
    )
      throw new Error('Expected the current native fallback account binding')
    quotaManager.setFallback(
      'work-alt',
      {
        quota: {
          ...cachedQuota,
          accountIdentity: account.anthropicAccountUuid,
        },
        refreshAfter: now,
        checkedAt: now + 60_000,
      },
      account,
    )
    await expect(
      quotaManager.refreshFallback(
        'work-alt',
        'sk-ant-oat01-fb-access',
        account,
      ),
    ).rejects.toThrow('429')

    await mgr.tick()

    expect(primeCalls).toBe(0)
  })
})

async function expirePoolCredentialForPrime(
  runtime: ReturnType<typeof createNativeAccountRuntime>,
  routeId: string,
) {
  if (!testContext.migratedPool) throw new Error('Missing native Prime fixture')
  const before = await runtime.captureLocalSubject(routeId)
  const store = createNativePoolStore({
    paths: testContext.migratedPool.paths,
    quota: nativeQuotaCodec,
  })
  const rotated = await store.refresh(
    before.binding.rowId,
    async (credential) => ({
      access: `sk-ant-oat01-prime-expired-${routeId}`,
      refresh: credential.refresh,
      expires: Date.now() - 1_000,
    }),
  )
  expect(rotated.status).toBe('rotated')
  const after = await runtime.captureLocalSubject(routeId)
  expect(after.binding).toEqual(before.binding)
  expect(after.credentialFingerprint).toBe(before.credentialFingerprint)
}

async function primeWarningsAfterQuotaCheck(
  fallback: boolean,
  change: (
    runtime: ReturnType<typeof createNativeAccountRuntime>,
  ) => Promise<void>,
  getHostAuth = () =>
    Promise.resolve({ type: 'oauth' as const, ...syntheticMainHostAuth() }),
) {
  const dueQuota = {
    five_hour: {
      usedPercent: 0,
      remainingPercent: 100,
      resetsAt: new Date(Date.now() - 180_000).toISOString(),
      checkedAt: Date.now(),
    },
  }
  await useTempAccountFile(
    bindPoolAccounts(
      createFallbackStorage({
        accounts: fallback
          ? [
              {
                id: 'work-alt',
                type: 'oauth',
                access: 'sk-ant-oat01-fb-access',
                refresh: 'fb-refresh',
                expires: Date.now() + 8 * 60 * 60_000,
                quota: dueQuota,
              },
            ]
          : [],
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          mainQuota: fallback
            ? {
                five_hour: {
                  ...dueQuota.five_hour,
                  resetsAt: new Date(
                    Date.now() + 5 * 60 * 60_000,
                  ).toISOString(),
                },
              }
            : dueQuota,
        },
        prime: { enabled: true },
      }),
    ),
  )
  let modelRequests = 0
  let refreshRequests = 0
  globalThis.fetch = mock(
    withNativeBootstrap((input: Parameters<typeof fetch>[0]) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        refreshRequests += 1
        return new Response('temporary refresh failure', { status: 503 })
      }
      if (url.includes('/v1/messages')) {
        modelRequests += 1
        return Response.json({ usage: { input_tokens: 1, output_tokens: 1 } })
      }
      if (url.includes('/api/oauth/usage'))
        return freshPrimeQuotaResponse({
          five_hour: { utilization: 0, resets_at: dueQuota.five_hour.resetsAt },
        })
      throw new Error(`Unexpected test endpoint: ${url}`)
    }),
  ) as unknown as typeof fetch
  const plugin = await getPlugin()
  await plugin.auth.loader(getHostAuth, { models: {} })
  const runtime = createNativeAccountRuntime({
    paths: testContext.migratedPool!.paths,
    host: 'opencode',
  })
  const manager = getPluginTestHandles(plugin).primeManager
  let changed = false
  // Change account availability after the manager obtained its claim identity.
  // Keep the real send adapter to verify its failure classification and logs.
  manager.options.refreshQuota = async () => {
    await change(runtime)
    changed = true
    return { quota: dueQuota, fresh: true }
  }
  const { __setLogTestSink, getLogLevel, setLogLevel } = await import(
    '@cortexkit/anthropic-auth-core'
  )
  const records: LogTestRecord[] = []
  const previousLevel = getLogLevel()
  setLogLevel('warn')
  __setLogTestSink((record) => records.push(record))
  try {
    await manager.tick()
  } finally {
    __setLogTestSink(null)
    setLogLevel(previousLevel)
    runtime.close()
  }
  expect(changed).toBe(true)
  expect(modelRequests).toBe(0)
  return { records, refreshRequests }
}

describe('claude-prime — warn dedup (R3)', () => {
  // PrimeManager sends a minimal model request to start a five-hour window.
  // If refreshing its token fails after quota checking, the adapter must
  // return that failure to the manager. Only the manager logs the warning,
  // so one failed request produces one warning rather than duplicate alerts.

  const originalFetch = globalThis.fetch

  beforeEach(async () => {
    // Marker dir is shared across processes; sweep leftovers so a prior
    // suite's fire doesn't suppress the next suite's claim.
    await rm(join(tmpdir(), 'opencode-anthropic-auth', 'prime'), {
      recursive: true,
      force: true,
    }).catch(() => {})
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('R3: a fire-time main token refresh failure produces exactly one warn·prime·prime token refresh failed record (distinct from the generic fire-failed event)', async () => {
    const { records, refreshRequests } = await primeWarningsAfterQuotaCheck(
      false,
      async (runtime) => {
        await expirePoolCredentialForPrime(runtime, 'main')
      },
    )
    expect(refreshRequests).toBe(3)
    expect(
      records.filter(
        (record) =>
          record.channel === 'prime' &&
          record.level === 'warn' &&
          record.message === 'prime token refresh failed',
      ),
    ).toHaveLength(1)
    expect(
      records.filter((record) => record.message === 'prime fire failed'),
    ).toHaveLength(0)
  })

  test('R3-precision: a fire-time main auth-unavailable (latestGetAuth null) failure logs the GENERIC `prime fire failed` (NOT `prime token refresh failed`)', async () => {
    let activationUnavailable = false
    const { records, refreshRequests } = await primeWarningsAfterQuotaCheck(
      false,
      async () => {
        activationUnavailable = true
      },
      () => {
        if (activationUnavailable)
          return Promise.reject(
            new Error('prime: main auth loader is not available'),
          )
        return Promise.resolve({ type: 'oauth', ...syntheticMainHostAuth() })
      },
    )
    expect(refreshRequests).toBe(0)
    expect(
      records.filter(
        (record) => record.message === 'prime token refresh failed',
      ),
    ).toHaveLength(0)
    expect(
      records.filter((record) => record.message === 'prime fire failed'),
    ).toHaveLength(1)
  })

  test('R3-precision: a fallback removed between fresh-check and fire logs `prime fire failed`', async () => {
    const { records, refreshRequests } = await primeWarningsAfterQuotaCheck(
      true,
      async (runtime) => {
        await runtime.remove('work-alt')
      },
    )
    expect(refreshRequests).toBe(0)
    expect(
      records.filter(
        (record) => record.message === 'prime token refresh failed',
      ),
    ).toHaveLength(0)
    expect(
      records.filter((record) => record.message === 'prime fire failed'),
    ).toHaveLength(1)
  })

  test('R3: a fallback refreshAccount failure logs `prime token refresh failed`', async () => {
    const { records, refreshRequests } = await primeWarningsAfterQuotaCheck(
      true,
      async (runtime) => {
        await expirePoolCredentialForPrime(runtime, 'work-alt')
      },
    )
    expect(refreshRequests).toBe(3)
    expect(
      records.filter(
        (record) => record.message === 'prime token refresh failed',
      ),
    ).toHaveLength(1)
    expect(
      records.filter((record) => record.message === 'prime fire failed'),
    ).toHaveLength(0)
  })
})
