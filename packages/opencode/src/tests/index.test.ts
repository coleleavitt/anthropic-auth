import { afterEach, beforeEach, describe, expect, mock, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import * as filesystem from 'node:fs/promises'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrimeManager } from '@cortexkit/anthropic-auth-core'
import * as Core from '@cortexkit/anthropic-auth-core'
import {
  __setLogTestSink,
  type AccountStorage,
  buildPrimeRequestBody,
  type CommandApplyRequest,
  type CommandApplyResult,
  createNativeAccountRuntime,
  createNativePoolStore,
  extractBillingHeaderCCH,
  getClaudeCodeIdentityForVerifiedAccount,
  hashRefreshToken,
  type LogTestRecord,
  type NativeCustodyClient,
  type OAuthAccount,
  type OAuthQuotaSnapshot,
  setLogLevel,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec.ts'
import type { TestLifetime } from '../../../core/src/tests/test-lifetime.ts'
import { getSidebarState, getSidebarStateFile } from '../sidebar-state'
import { rewriteRequestBody } from '../transform.ts'
import { getPluginTestHandles } from './plugin-test-handles'
import {
  applyMenuAction as applyMenuActionWithCtx,
  type createMockClient,
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
  expectUnknownQuotaAdmissionBlocked as expectUnknownQuotaAdmissionBlockedWithCtx,
  loadMainAndFetch as loadMainAndFetchWithCtx,
  type readFeedEntries,
  waitForFeedEntries as waitForFeedEntriesWithCtx,
  waitForLogRecord as waitForLogRecordWithCtx,
} from './support/opencode1-quota-feed.ts'
import {
  readAccountStorage as readAccountStorageWithCtx,
  waitForAccountStorage as waitForAccountStorageWithCtx,
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
} from './support/opencode1-test-context.ts'
import { extractUrl, MESSAGES_URL, QUOTA_URL } from './test-fetch'

const testContext = createOpencode1TestContext()
installOpencode1TestHooks(testContext)
const test = createOpencode1Test(testContext)

function bodyLifetime(): TestLifetime {
  return getBodyLifetime(testContext)
}
function _lifetimeSignal() {
  return lifetimeSignalWithCtx(testContext)
}
function _recordedCondition() {
  return recordedConditionWithCtx(testContext)
}
function _untilStateOrTestEnd(pauseMs?: number) {
  return untilStateOrTestEndWithCtx(testContext, pauseMs)
}
function _heldResponse() {
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
function _withNativeTokenExchange<Input, Init>(
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
function _nativeAdmissionAnswer(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) {
  return nativeAdmissionAnswerWithCtx(testContext, input, init)
}
function _nativeBootstrapAnswer(
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
function _withMainAdmission<Input, Init>(
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
function _waitForPoolCredential(routeId: string, access: string) {
  return waitForPoolCredentialWithCtx(testContext, routeId, access)
}
function refreshPoolLoginElsewhere(
  routeId: string,
  successor: { access: string; refresh: string; expires: number },
) {
  return refreshPoolLoginElsewhereWithCtx(testContext, routeId, successor)
}
function _updatePoolSettings(
  mutator: (settings: Record<string, unknown>) => Record<string, unknown>,
) {
  return updatePoolSettingsWithCtx(testContext, mutator)
}
function _addPoolOAuthAccount(
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
function _publishPoolQuota(routeId: string, quota: OAuthQuotaSnapshot) {
  return publishPoolQuotaWithCtx(testContext, routeId, quota)
}
function _publishPoolMetadata(
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
function _expectNoCredentialFragment(value: unknown) {
  return expectNoCredentialFragmentWithCtx(testContext, value)
}
function _readNativeSettings(): Promise<Record<string, unknown>> {
  return readNativeSettingsWithCtx(testContext)
}
function _publishNativeMainQuota(quota: OAuthQuotaSnapshot) {
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
function _setupExpiredTokenLoader(...issuedAccess: string[]) {
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
function _waitForAccountStorage(
  predicate: (storage: AccountStorage | null) => boolean,
) {
  return waitForAccountStorageWithCtx(testContext, predicate)
}
function _waitForNativePoolQuota(
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
function _waitForFeedEntries(
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
function _loadMainAndFetch(
  storage: AccountStorage,
  response: Response | (() => Response),
  requestHeaders?: Record<string, string>,
) {
  return loadMainAndFetchWithCtx(testContext, storage, response, requestHeaders)
}
function _expectNonOatMainRefused(access: string) {
  return expectNonOatMainRefusedWithCtx(testContext, access)
}
function _expectUnknownQuotaAdmissionBlocked(storage: AccountStorage) {
  return expectUnknownQuotaAdmissionBlockedWithCtx(testContext, storage)
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

describe('auth.loader', () => {
  installLoaderSetup(testContext)

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
        globalThis.fetch = mock(
          withNativeAdmission((input: string | URL | Request) => {
            if (extractUrl(input).includes('/api/oauth/usage')) usageCalls++
            return Promise.resolve(
              new Response('ok', { headers: quotaHeaders }),
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
              expires: Date.now() + 100000,
            }),
          { models: {} },
        )

        const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
        expect(response.status).toBe(200)
        await response.text()
        await published.wait
        // The plugin's own views take the accepted reading at once: its quota
        // cache and the sidebar it just published.
        expect(
          getPluginTestHandles(plugin).quotaManager.getMain(poolMainIdentity())
            ?.quota.five_hour?.usedPercent,
        ).toBe(78)
        const state = await getSidebarState(sidebarPath)
        expect(state.main.quota?.five_hour?.usedPercent).toBe(78)
        expect(state.lastUpdated).toBeGreaterThan(0)

        // The pool store queues quota readings and commits them to disk later
        // (about 100 ms after the first reading, then at most once per 30 s per
        // store handle), so the file need not hold the reading yet, and a file
        // watcher can miss the commit's final rename. Closing the plugin's
        // account runtime commits the queued readings at once; a fresh reader
        // then finds them on disk.
        await getPluginTestHandles(plugin).scopedRuntime.close()
        const storage = await readAccountStorage()
        expect(storage?.quota?.mainQuota?.source).toBe('headers')
        expect(storage?.quota?.mainQuota?.five_hour?.usedPercent).toBe(78)
        expect(storage?.quota?.mainQuotaCheckedAt).toBeGreaterThan(0)
        expect(usageCalls).toBe(0)
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
