import {
  type ApiKeyAccount,
  applyClaudeCodeHeaders,
  CACHE_KEEP_EXTENDED_TTL_BETA,
  CacheKeepManager,
  CacheKeepSessionRegistry,
  classifyRetry,
  createEmptyStorage,
  createStickyNoRouteResponse,
  DEFAULT_MAX_RETRIES,
  decideStickyQuotaFailure,
  dumpDirectRequest,
  FAST_MODE_BETA,
  FallbackAccountManager,
  getCache1hPersistentMode,
  getDefaultCacheKeepRegistryDirectory,
  getFallbackReauthLabels,
  getRelayConfig,
  getRoutingMode,
  getStickyRoutingStatePath,
  isApiKeyAccount,
  isCache1hPersistentlyEnabled,
  isCacheKeepHybridActive,
  isDumpPersistentlyEnabled,
  isFastModePersistentlyEnabled,
  isKillswitchEnabled,
  isOAuthAccount,
  isPermanentRefreshError,
  isValidApiBaseURL,
  killswitchPassesPolicy,
  loadAccounts,
  loadSharedAccountStore,
  logger,
  materializeSharedFallbackAccounts,
  mergeAnthropicBetas,
  nextRetryDelayMs,
  type OAuthAccount,
  type OAuthQuotaSnapshot,
  pickSharedAccount,
  QuotaManager,
  quotaSnapshotModelScopeIsExhausted,
  quotaSnapshotPassesModelScope,
  quotaSnapshotPassesPolicy,
  recordSharedAccountQuota,
  resolveClaudeCodeIdentity,
  STICKY_ROUTING_MAIN_ACCOUNT_ID,
  type StickyRouteCandidate,
  StickySessionRouter,
  sendViaRelay,
  setDumpEnabled,
  shouldFallbackStatus,
  stickyQuotaSnapshotIsFresh,
  stickyRetryAfterWithJitter,
  stickyRouteFamilyForModel,
} from '@cortexkit/anthropic-auth-core'
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  calculateCost,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from '@earendil-works/pi-ai'

import { buildAnthropicRequest, fromClaudeCodeToolName } from './convert.ts'
import { getPiAccountStoragePath } from './paths.ts'

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

let cacheKeepRegistry: CacheKeepSessionRegistry | undefined
let cacheKeepRegistryDirectory: string | undefined
const stickyRouters = new Map<string, StickySessionRouter>()
const quotaManagers = new Map<string, QuotaManager>()
const fallbackManagers = new Map<string, FallbackAccountManager>()
const PI_SERVICE_CACHE_LIMIT = 16

function setBoundedService<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key)
  map.set(key, value)
  while (map.size > PI_SERVICE_CACHE_LIMIT) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

function getPiRoutingServices(
  storagePath: string,
  storage: Awaited<ReturnType<typeof loadAccounts>>,
) {
  let quotaManager = quotaManagers.get(storagePath)
  let fallbackManager = fallbackManagers.get(storagePath)
  if (!quotaManager || !fallbackManager) {
    quotaManager = new QuotaManager({ storage })
    fallbackManager = new FallbackAccountManager({
      configPath: storagePath,
      quotaManager,
    })
    setBoundedService(quotaManagers, storagePath, quotaManager)
    setBoundedService(fallbackManagers, storagePath, fallbackManager)
  } else {
    quotaManager.updateStorage(storage)
  }
  return { quotaManager, fallbackManager }
}

function getPiStickyRouter(storagePath: string) {
  const path =
    process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE ||
    getStickyRoutingStatePath(storagePath)
  let router = stickyRouters.get(path)
  if (!router) {
    router = new StickySessionRouter({ path })
    setBoundedService(stickyRouters, path, router)
  }
  return router
}

export async function clearPiStickyRoutingSession(
  storagePath: string,
  sessionId: string,
) {
  await getPiStickyRouter(storagePath).clear(sessionId)
}

function getPiCacheKeepRegistry() {
  const directory =
    process.env.PI_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR ||
    getDefaultCacheKeepRegistryDirectory('pi')
  if (!cacheKeepRegistry || cacheKeepRegistryDirectory !== directory) {
    cacheKeepRegistry = new CacheKeepSessionRegistry({ directory })
    cacheKeepRegistryDirectory = directory
  }
  return cacheKeepRegistry
}

const cacheKeepManager = new CacheKeepManager({
  loadStorage: () => loadAccounts(getPiAccountStoragePath()),
  onTrackedSessionsChanged: (sessions) =>
    getPiCacheKeepRegistry().publish(sessions),
  prepareHeaders: async (headers, target) => {
    const authorization = headers.get('authorization') ?? ''
    const match = /^Bearer\s+(.+)$/i.exec(authorization)
    const accessToken = match?.[1]
    if (!accessToken) return headers
    try {
      const body = JSON.parse(target.bodyText) as Record<string, unknown>
      const identity = await resolveClaudeCodeIdentity(
        accessToken,
        typeof body.model === 'string' ? body.model : undefined,
      )
      headers.delete('anthropic-beta')
      applyClaudeCodeHeaders(headers, accessToken, { body, identity })
      headers.set(
        'anthropic-beta',
        mergeAnthropicBetas(headers.get('anthropic-beta'), [
          CACHE_KEEP_EXTENDED_TTL_BETA,
        ]),
      )
      if (body.speed === 'fast') {
        headers.set(
          'anthropic-beta',
          mergeAnthropicBetas(headers.get('anthropic-beta'), [FAST_MODE_BETA]),
        )
      }
    } catch {
      applyClaudeCodeHeaders(headers, accessToken)
    }
    return headers
  },
})

export async function getPiTrackedCacheKeepSessions() {
  return getPiCacheKeepRegistry().list(cacheKeepManager.trackedSessions())
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'pause_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'toolUse'
    default:
      return 'error'
  }
}

// `model_context_window_exceeded` stays a failure instead of mapping to the
// `length` truncation Claude Code reuses for it, because a caller that compacts
// a conversation would accept the truncated response as a complete summary and
// persist it over the original messages.
function describeStopReasonFailure(reason: string): string {
  switch (reason) {
    case 'refusal':
      // A >200k request on a 1M-capable model returns exactly this when
      // `context-1m-2025-08-07` is missing — HTTP 200, no content, input
      // billed in full. With the beta present, 510k answers normally.
      return 'Anthropic refused this request (stop_reason: refusal). Common causes: a context over 200k without the 1M beta, or content the model declined. Note the input is billed even though no output was produced.'
    case 'model_context_window_exceeded':
      return 'Anthropic stopped early: the request exceeded the model context window (stop_reason: model_context_window_exceeded). Compact or split the conversation.'
    default:
      return `Anthropic stream ended with an unhandled stop reason: ${reason}`
  }
}

function createOutput(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

type AnthropicEvent = {
  type?: string
  index?: number
  content_block?: Record<string, unknown>
  delta?: Record<string, unknown>
  message?: { usage?: Record<string, number> }
  usage?: Record<string, number>
}

type Block = (
  | TextContent
  | ThinkingContent
  | (ToolCall & { partialJson?: string })
) & {
  index?: number
}

function updateUsage(
  model: Model<Api>,
  output: AssistantMessage,
  usage?: Record<string, number>,
) {
  if (!usage) return
  output.usage.input = usage.input_tokens ?? output.usage.input
  output.usage.output = usage.output_tokens ?? output.usage.output
  output.usage.cacheRead =
    usage.cache_read_input_tokens ?? output.usage.cacheRead
  output.usage.cacheWrite =
    usage.cache_creation_input_tokens ?? output.usage.cacheWrite
  output.usage.totalTokens =
    output.usage.input +
    output.usage.output +
    output.usage.cacheRead +
    output.usage.cacheWrite
  calculateCost(model, output.usage)
}

export function buildExplicitBaseMessagesUrl(baseURL: string) {
  const url = new URL(baseURL)
  url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/messages`
  url.searchParams.set('beta', 'true')
  return url
}

export function configureApiRouteHeaders(
  account: ApiKeyAccount,
  fastMode: boolean,
) {
  const headers = new Headers()
  headers.set('accept', 'application/json')
  headers.set('content-type', 'application/json')
  headers.set('anthropic-version', '2023-06-01')
  headers.set('anthropic-beta', mergeAnthropicBetas(null, []))
  if (account.authHeader === 'x-api-key') {
    headers.set('x-api-key', account.apiKey ?? '')
  } else {
    headers.set('authorization', `Bearer ${account.apiKey ?? ''}`)
  }
  if (fastMode) {
    headers.set(
      'anthropic-beta',
      mergeAnthropicBetas(headers.get('anthropic-beta'), [FAST_MODE_BETA]),
    )
  }
  return headers
}

export async function* parseSse(
  response: Response,
): AsyncGenerator<AnthropicEvent> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data || data === '[DONE]') continue
          yield JSON.parse(data) as AnthropicEvent
        }
      }
    }
  } finally {
    // Do not cancel the reader on early abandon. `firstStreamingError()` peeks
    // the first SSE event from a `response.clone()` and then abandons this
    // generator; cancelling the cloned (tee'd) reader tears down the shared
    // underlying body, so the real `parseSse(response)` that streams the reply
    // reads zero events and the assistant message comes back empty. Releasing
    // the lock is enough — the abandoned clone branch is garbage-collected.
    reader.releaseLock()
  }
}

async function sendAnthropicRequest(options: {
  model: Model<Api>
  context: Context
  streamOptions?: SimpleStreamOptions
  accessToken?: string
  apiAccount?: ApiKeyAccount
  storagePath: string
  oauthAccountId?: string
  route?: string
}): Promise<Response> {
  const storage = await loadAccounts(options.storagePath)
  setDumpEnabled(isDumpPersistentlyEnabled(storage))
  const identity = options.accessToken
    ? await resolveClaudeCodeIdentity(options.accessToken, options.model.id)
    : undefined
  const { body, bodyText } = await buildAnthropicRequest(
    options.model.id,
    options.context,
    options.streamOptions,
    {
      enabled: isCache1hPersistentlyEnabled(storage),
      mode: getCache1hPersistentMode(storage),
    },
    isFastModePersistentlyEnabled(storage),
    identity,
  )
  const fastMode = body.speed === 'fast'
  const headers = options.apiAccount
    ? configureApiRouteHeaders(options.apiAccount, fastMode)
    : applyClaudeCodeHeaders(new Headers(), options.accessToken ?? '', {
        body,
        identity,
      })
  if (!options.apiAccount && fastMode) {
    headers.set(
      'anthropic-beta',
      mergeAnthropicBetas(headers.get('anthropic-beta'), [FAST_MODE_BETA]),
    )
  }
  const relayAffinity = options.streamOptions?.sessionId ?? null

  const input = options.apiAccount
    ? buildExplicitBaseMessagesUrl(options.apiAccount.baseURL)
    : new URL('/v1/messages?beta=true', options.model.baseUrl)
  const init: RequestInit = {
    method: 'POST',
    headers,
    body: bodyText,
    signal: options.streamOptions?.signal,
  }

  await cacheKeepManager.track({
    sessionId: relayAffinity,
    url: input.toString(),
    headers,
    bodyText,
    storage,
    cacheMode: isCacheKeepHybridActive(storage) ? 'hybrid' : 'disabled',
    oauthAccountId: options.oauthAccountId,
  })

  const directFetch = async () => {
    const startedAt = Date.now()
    logger.debug('pi.send', 'direct fetch start', {
      url: input.toString(),
      route: options.route ?? (options.apiAccount ? 'api' : 'oauth'),
      oauthAccountId: options.oauthAccountId,
      bodyBytes: bodyText.length,
      betas: headers.get('anthropic-beta'),
    })
    try {
      const response = await fetch(input, init)
      logger.debug('pi.send', 'direct fetch done', {
        status: response.status,
        durationMs: Date.now() - startedAt,
        unifiedStatus: response.headers.get(
          'anthropic-ratelimit-unified-status',
        ),
        retryAfter: response.headers.get('retry-after'),
      })
      await dumpDirectRequest({
        affinity: relayAffinity,
        route:
          options.route ??
          (options.apiAccount ? `api:${options.apiAccount.id}` : 'oauth'),
        status: response.status,
        bodyText,
        url: input.toString(),
        method: init.method,
        headers,
      })
      return response
    } catch (error) {
      logger.warn('pi.send', 'direct fetch threw', {
        durationMs: Date.now() - startedAt,
        error: errorText(error),
      })
      await dumpDirectRequest({
        affinity: relayAffinity,
        route:
          options.route ??
          (options.apiAccount ? `api:${options.apiAccount.id}` : 'oauth'),
        error: errorText(error),
        bodyText,
        url: input.toString(),
        method: init.method,
        headers,
      })
      throw error
    }
  }

  if (options.apiAccount) return directFetch()

  return sendViaRelay({
    config: getRelayConfig(storage),
    input,
    init,
    headers,
    body: bodyText,
    fallback: directFetch,
    affinity: relayAffinity,
  })
}

function quotaSnapshotIsExhausted(
  quota: Awaited<ReturnType<QuotaManager['refreshMain']>> | undefined,
) {
  return (['five_hour', 'seven_day'] as const).some(
    (key) => (quota?.[key]?.remainingPercent ?? 1) <= 0,
  )
}

export function primaryResponseAllowsApiFallback(preflight: Response | string) {
  return (
    preflight === 'rate_limit_error' ||
    (preflight instanceof Response && preflight.status === 429)
  )
}

async function firstStreamingError(
  response: Response,
): Promise<Response | string> {
  if (!response.ok) return response
  const clone = response.clone()
  try {
    for await (const event of parseSse(clone as unknown as Response)) {
      if (
        event.type === 'error' &&
        typeof event.delta?.type === 'string' &&
        event.delta.type === 'rate_limit_error'
      ) {
        return 'rate_limit_error'
      }
      return response
    }
  } catch {
    return response
  }
  return response
}

/**
 * Pi's routing view of the accounts: its own config file plus every account in
 * the machine-wide shared store.
 *
 * Pi takes its primary credential from the shared store but used to read its
 * fallback list only from `~/.pi/agent/anthropic-auth.json`. That file is
 * written by `pi` account commands and is simply absent on a machine that
 * logged in through another tool, so `loadAccounts` returned null and the
 * router had nothing to rotate to — every 429 became fatal even with several
 * healthy logins on disk.
 */
/**
 * An access token from the machine-wide store, for when the host has none.
 *
 * Prefers whatever selection would route to, so the credential handed back is
 * the same one the router would have chosen anyway.
 */
async function sharedAccessToken(): Promise<string | undefined> {
  const loaded = await loadSharedAccountStore().catch((error) => {
    logger.warn('pi.stream', 'shared account store unreadable', {
      error: errorText(error),
    })
    return null
  })
  if (!loaded) return undefined
  const account = pickSharedAccount(loaded.store)
  if (account?.credential.type !== 'oauth') return undefined
  logger.info('pi.stream', 'using a shared-store credential', {
    accountId: account.id,
  })
  return account.credential.access || undefined
}

async function loadRoutingStorage(storagePath: string) {
  logger.trace('pi.route', 'loadRoutingStorage: start', { storagePath })
  const storage = await loadAccounts(storagePath)
  logger.trace('pi.route', 'loadRoutingStorage: sidecar read', {
    present: storage !== null,
    sidecarAccounts: storage?.accounts?.length ?? 0,
  })
  const loaded = await loadSharedAccountStore().catch((error) => {
    logger.warn('pi.route', 'shared account store unreadable', {
      error: errorText(error),
    })
    return null
  })
  logger.trace('pi.route', 'loadRoutingStorage: shared store read', {
    source: loaded?.source.type,
    sharedAccounts: loaded?.store.accounts.length ?? 0,
  })
  if (!loaded?.store.accounts.length) {
    logger.debug('pi.route', 'no shared accounts; using sidecar only')
    return { storage, mainAccountId: undefined }
  }

  // Logged for routing visibility only. Deliberately NOT used to attribute a
  // quota reading: selection can move between the read and the write, and
  // stamping one account's usage onto another cascades until every account
  // looks exhausted. Attribution goes by access token instead.
  const mainAccountId = pickSharedAccount(loaded.store)?.id
  logger.debug('pi.route', 'shared main selected', {
    mainAccountId: mainAccountId ?? '(none available)',
    pinned: loaded.store.current ?? '(unpinned)',
  })
  const accounts = materializeSharedFallbackAccounts(
    storage?.accounts ?? [],
    loaded.store,
  )
  logger.debug('pi.route', 'routing pool built', {
    fallbacks: accounts.length,
    ids: accounts.map((account) => account.id),
  })
  if (!accounts.length) return { storage, mainAccountId }
  return {
    storage: { ...(storage ?? createEmptyStorage()), accounts },
    mainAccountId,
  }
}

async function executeWithFallback(options: {
  model: Model<Api>
  context: Context
  streamOptions?: SimpleStreamOptions
  primaryAccessToken: string
  storagePath: string
}): Promise<Response> {
  const { storage } = await loadRoutingStorage(options.storagePath)
  const { quotaManager, fallbackManager: manager } = getPiRoutingServices(
    options.storagePath,
    storage,
  )
  quotaManager.seedMainFromStorage(storage, options.primaryAccessToken)
  quotaManager.seedFallbacksFromAccounts(
    (storage?.accounts ?? []).filter(isOAuthAccount),
  )

  type PiStickyRoute = {
    id: string
    access: string
    quota?: OAuthQuotaSnapshot
    order: number
    account?: OAuthAccount
  }

  async function buildStickyRoutes(modelId: string) {
    const mainEntry = quotaManager.getMain(options.primaryAccessToken)
    let mainQuota = mainEntry?.quota
    if (
      !stickyQuotaSnapshotIsFresh(
        mainEntry?.quota,
        storage,
        Date.now(),
        modelId,
      )
    ) {
      try {
        mainQuota = await quotaManager.refreshMain(options.primaryAccessToken)
      } catch {}
    }
    const usableFallbacks = await manager.getUsableFallbackAccounts(storage, {
      modelId,
    })
    const usableById = new Map(
      usableFallbacks.map((account) => [account.id, account]),
    )
    const allRoutes: PiStickyRoute[] = []
    if (!isPermanentRefreshError(storage?.refresh?.mainLastRefreshError)) {
      allRoutes.push({
        id: STICKY_ROUTING_MAIN_ACCOUNT_ID,
        access: options.primaryAccessToken,
        quota: mainQuota,
        order: 0,
      })
    }
    for (const [index, configured] of (storage?.accounts ?? []).entries()) {
      if (configured.enabled === false || !isOAuthAccount(configured)) continue
      const account = usableById.get(configured.id) ?? configured
      if (!account.access || isPermanentRefreshError(account.lastRefreshError))
        continue
      let accountQuota =
        quotaManager.getFallback(account.id, account.access)?.quota ??
        account.quota
      if (
        !stickyQuotaSnapshotIsFresh(accountQuota, storage, Date.now(), modelId)
      ) {
        try {
          accountQuota = await quotaManager.refreshFallback(
            account.id,
            account.access,
          )
        } catch {}
      }
      allRoutes.push({
        id: account.id,
        access: account.access,
        quota: accountQuota,
        order: index + 1,
        account,
      })
    }
    const retainAccountIds = new Set(
      allRoutes.flatMap((route) => {
        const refreshError =
          route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID
            ? storage?.refresh?.mainLastRefreshError
            : route.account?.lastRefreshError
        if (isPermanentRefreshError(refreshError)) return []
        if (
          stickyQuotaSnapshotIsFresh(
            route.quota,
            storage,
            Date.now(),
            modelId,
          ) &&
          decideStickyQuotaFailure({ quota: route.quota, modelId }).action ===
            'migrate'
        ) {
          return []
        }
        if (
          isKillswitchEnabled(storage) &&
          !killswitchPassesPolicy(
            route.quota,
            storage,
            route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID ? undefined : route.id,
            modelId,
          )
        ) {
          return []
        }
        return [route.id]
      }),
    )
    const usableIds = new Set(usableFallbacks.map((account) => account.id))
    const candidates: StickyRouteCandidate[] = allRoutes.flatMap((route) => {
      if (!route.quota) return []
      const accountId =
        route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID ? undefined : route.id
      const passes =
        quotaSnapshotPassesPolicy(route.quota, storage) &&
        quotaSnapshotPassesModelScope(route.quota, modelId) &&
        (!isKillswitchEnabled(storage) ||
          killswitchPassesPolicy(route.quota, storage, accountId, modelId)) &&
        (route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID || usableIds.has(route.id))
      return passes
        ? [
            {
              accountId: route.id,
              quota: route.quota,
              order: route.order,
            },
          ]
        : []
    })
    return { allRoutes, candidates, retainAccountIds }
  }

  /**
   * Persist a quota reading against the shared account it describes.
   *
   * Selection can only rotate off an exhausted account if something writes the
   * utilisation down; the probe happens on the request path, so this is where
   * the observation exists. Failures are swallowed: a routing decision must not
   * depend on a bookkeeping write.
   */
  async function recordQuotaObservation(
    accessToken: string,
    quota: OAuthQuotaSnapshot | undefined,
  ) {
    if (!quota) return
    // Identify the account by the token the quota was actually read with.
    // Using the router's current pick instead stamps one account's usage onto
    // whichever row selection happens to favour, and because a stamped row is
    // then skipped, the next pick inherits the same figures — an exhausted
    // account cascades until every account looks exhausted.
    const loaded = await loadSharedAccountStore().catch(() => null)
    const accountId = loaded?.store.accounts.find(
      (candidate) =>
        candidate.credential.type === 'oauth' &&
        candidate.credential.access === accessToken,
    )?.id
    if (!accountId) {
      logger.debug('pi.quota', 'no shared account matches this token', {})
      return
    }
    const fiveHour = quota.five_hour?.usedPercent
    const sevenDay = quota.seven_day?.usedPercent
    if (fiveHour === undefined && sevenDay === undefined) return
    logger.info('pi.quota', 'recording quota observation', {
      accountId,
      fiveHourPercent: fiveHour,
      sevenDayPercent: sevenDay,
    })
    await recordSharedAccountQuota(accountId, {
      ...(fiveHour !== undefined ? { fiveHourPercent: fiveHour } : {}),
      ...(sevenDay !== undefined ? { sevenDayPercent: sevenDay } : {}),
    }).catch(() => {})
  }

  async function primaryQuotaRefreshConfirmsExhausted() {
    try {
      const quota = await quotaManager.refreshMain(options.primaryAccessToken)
      await recordQuotaObservation(options.primaryAccessToken, quota)
      const entry = quotaManager.getMain(options.primaryAccessToken)
      return Boolean(
        entry &&
          entry.refreshAfter > Date.now() &&
          quotaSnapshotIsExhausted(quota),
      )
    } catch {
      return false
    }
  }

  async function primaryQuotaRefreshConfirmsModelScopeExhausted() {
    try {
      const quota = await quotaManager.refreshMain(options.primaryAccessToken)
      const entry = quotaManager.getMain(options.primaryAccessToken)
      return Boolean(
        entry &&
          entry.refreshAfter > Date.now() &&
          quotaSnapshotModelScopeIsExhausted(quota, options.model.id),
      )
    } catch {
      return false
    }
  }

  function primaryCachedModelScopeExhausted() {
    const entry = quotaManager.getMain(options.primaryAccessToken)
    return Boolean(
      entry &&
        quotaSnapshotModelScopeIsExhausted(entry.quota, options.model.id),
    )
  }

  function primaryFreshModelScopeExhausted() {
    const entry = quotaManager.getMain(options.primaryAccessToken)
    return Boolean(
      entry &&
        !quotaManager.isMainStale(options.model.id) &&
        quotaSnapshotModelScopeIsExhausted(entry.quota, options.model.id),
    )
  }

  async function tryFallbackAccounts(
    routeOptions: { includeApiRoutes?: boolean; apiOnly?: boolean } = {},
  ) {
    logger.debug('pi.route', 'tryFallbackAccounts: start', {
      apiOnly: routeOptions.apiOnly === true,
      includeApiRoutes: routeOptions.includeApiRoutes === true,
      configured: storage?.accounts?.length ?? 0,
    })
    const usableStartedAt = Date.now()
    const usableOAuth = await manager.getUsableFallbackAccounts(storage, {
      modelId: options.model.id,
    })
    logger.debug('pi.route', 'usable fallbacks resolved', {
      usable: usableOAuth.length,
      ids: usableOAuth.map((account) => account.id),
      durationMs: Date.now() - usableStartedAt,
    })
    const usableOAuthById = new Map(
      usableOAuth.map((account) => [account.id, account]),
    )
    for (const configured of storage?.accounts ?? []) {
      let response: Response | null = null
      const account = isOAuthAccount(configured)
        ? usableOAuthById.get(configured.id)
        : configured
      if (!account) continue

      if (isOAuthAccount(account)) {
        if (routeOptions.apiOnly === true || !account.access) continue
        response = await sendAnthropicRequest({
          ...options,
          accessToken: account.access,
        })
      } else if (
        routeOptions.includeApiRoutes === true &&
        isApiKeyAccount(account) &&
        account.enabled !== false &&
        account.apiKey &&
        isValidApiBaseURL(account.baseURL)
      ) {
        response = await sendAnthropicRequest({
          ...options,
          apiAccount: account,
        })
      }
      if (!response) {
        logger.trace('pi.route', 'fallback candidate skipped', {
          id: configured.id,
        })
        continue
      }

      const preflight = await firstStreamingError(response)
      if (preflight instanceof Response && preflight.ok) {
        logger.info('pi.route', 'fallback served the request', {
          id: account.id,
        })
        await manager.markUsed(account)
        return preflight
      }
      logger.debug('pi.route', 'fallback attempt failed', {
        id: account.id,
        status: preflight instanceof Response ? preflight.status : 'sse-error',
      })
      if (
        preflight instanceof Response &&
        !shouldFallbackStatus(preflight.status, storage)
      ) {
        return preflight
      }
      await response.body?.cancel().catch(() => {})
    }
    logger.debug('pi.route', 'no fallback could serve the request')
    return null
  }

  const routingMode = getRoutingMode(storage)
  if (routingMode === 'sticky-balanced' && options.streamOptions?.sessionId) {
    const sessionId = options.streamOptions.sessionId
    const router = getPiStickyRouter(options.storagePath)
    const initialInputBytes = Math.max(
      1,
      Buffer.byteLength(JSON.stringify(options.context)),
    )
    let routes = await buildStickyRoutes(options.model.id)
    const mainPermanentlyUnavailable = isPermanentRefreshError(
      storage?.refresh?.mainLastRefreshError,
    )
    const incompleteQuotaPool =
      (routes.allRoutes.length === 0 && !mainPermanentlyUnavailable) ||
      routes.allRoutes.some(
        (candidate) =>
          !candidate.quota ||
          !stickyQuotaSnapshotIsFresh(
            candidate.quota,
            storage,
            Date.now(),
            options.model.id,
          ),
      )
    let resolution = await router.resolve({
      sessionId,
      family: stickyRouteFamilyForModel(options.model.id),
      modelId: options.model.id,
      candidates: routes.candidates,
      retainAccountIds: routes.retainAccountIds,
      storage,
      inputBytes: initialInputBytes,
    })
    if (!resolution && incompleteQuotaPool) {
      const error = new Error(
        'Sticky-balanced routing is waiting for current OAuth quota snapshots',
      )
      Object.assign(error, {
        code: 'ECONNRESET',
        syscall: 'sticky-routing',
      })
      throw error
    }
    if (!resolution) {
      return createStickyNoRouteResponse({
        mainRefreshError: storage?.refresh?.mainLastRefreshError,
        fallbackReauthLabels: getFallbackReauthLabels(storage),
        routeQuotas: routes.allRoutes.flatMap((route) =>
          route.quota ? [route.quota] : [],
        ),
        modelId: options.model.id,
      })
    }
    let route = routes.allRoutes.find(
      (candidate) => candidate.id === resolution?.accountId,
    )
    if (resolution && route) {
      const sendRoute = (selected: PiStickyRoute) =>
        sendAnthropicRequest({
          ...options,
          accessToken: selected.access,
          oauthAccountId: selected.id,
          route: `sticky:${selected.id}`,
        })
      const completeRoute = async (
        selected: PiStickyRoute,
        response: Response,
        markUsed = true,
      ) => {
        if (markUsed && selected.account)
          await manager.markUsed(selected.account)
        return response
      }
      const proactiveQuotaDecision = stickyQuotaSnapshotIsFresh(
        route.quota,
        storage,
        Date.now(),
        options.model.id,
      )
        ? decideStickyQuotaFailure({
            quota: route.quota,
            modelId: options.model.id,
          })
        : undefined
      if (proactiveQuotaDecision?.action === 'hold') {
        return completeRoute(
          route,
          new Response(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'rate_limit_error',
                message:
                  'Sticky OAuth account five-hour quota resets shortly; retaining session affinity.',
              },
            }),
            {
              status: 429,
              headers: {
                'content-type': 'application/json',
                'retry-after': String(
                  stickyRetryAfterWithJitter(
                    sessionId,
                    proactiveQuotaDecision.retryAfterSeconds,
                  ),
                ),
              },
            },
          ),
          false,
        )
      }

      let response = await sendRoute(route)
      let preflight = await firstStreamingError(response)
      if (preflight instanceof Response && preflight.ok) {
        return completeRoute(route, preflight)
      }

      let permanentAuthFailure =
        preflight instanceof Response &&
        preflight.status === 401 &&
        route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID
      if (
        preflight instanceof Response &&
        preflight.status === 401 &&
        route.account &&
        storage
      ) {
        const authRouteId = route.id
        try {
          const refreshed = await manager.refreshAccount(
            route.account,
            storage,
            {
              force: true,
            },
          )
          if (refreshed.access) {
            route = { ...route, access: refreshed.access, account: refreshed }
          }
          await preflight.body?.cancel().catch(() => {})
          response = await sendRoute(route)
          preflight = await firstStreamingError(response)
          if (preflight instanceof Response && preflight.ok) {
            return completeRoute(route, preflight)
          }
          permanentAuthFailure =
            preflight instanceof Response && preflight.status === 401
        } catch (error) {
          const latest = await loadAccounts(options.storagePath)
          const refreshError = latest?.accounts.find(
            (account): account is OAuthAccount =>
              account.id === authRouteId && isOAuthAccount(account),
          )?.lastRefreshError
          if (!isPermanentRefreshError(refreshError)) throw error
          permanentAuthFailure = true
        }
      }

      let migrate =
        (preflight instanceof Response && preflight.status === 403) ||
        permanentAuthFailure
      if (primaryResponseAllowsApiFallback(preflight)) {
        let quota: OAuthQuotaSnapshot | undefined
        try {
          quota =
            route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID
              ? await quotaManager.refreshMain(route.access)
              : await quotaManager.refreshFallback(route.id, route.access)
        } catch {
          // Retain affinity when the quota probe itself is unavailable.
          quota = undefined
        }
        const decision = decideStickyQuotaFailure({
          quota,
          modelId: options.model.id,
        })
        if (decision.action === 'hold') {
          const headers = new Headers(
            preflight instanceof Response
              ? preflight.headers
              : response.headers,
          )
          headers.set(
            'retry-after',
            String(
              stickyRetryAfterWithJitter(sessionId, decision.retryAfterSeconds),
            ),
          )
          if (preflight instanceof Response) {
            return completeRoute(
              route,
              new Response(preflight.body, {
                status: preflight.status,
                statusText: preflight.statusText,
                headers,
              }),
            )
          }
          await response.body?.cancel().catch(() => {})
          headers.set('content-type', 'application/json')
          return completeRoute(
            route,
            new Response(
              JSON.stringify({
                type: 'error',
                error: {
                  type: 'rate_limit_error',
                  message:
                    'Sticky OAuth account five-hour quota resets shortly; retaining session affinity.',
                },
              }),
              { status: 429, headers },
            ),
          )
        }
        migrate = decision.action === 'migrate'
      }

      if (migrate) {
        const failedRouteId = route.id
        routes = await buildStickyRoutes(options.model.id)
        if (
          routes.candidates.some(
            (candidate) => candidate.accountId !== failedRouteId,
          )
        ) {
          if (preflight instanceof Response) {
            await preflight.body?.cancel().catch(() => {})
          } else {
            await response.body?.cancel().catch(() => {})
          }
          resolution = await router.resolve({
            sessionId,
            family: stickyRouteFamilyForModel(options.model.id),
            modelId: options.model.id,
            candidates: routes.candidates,
            retainAccountIds: routes.retainAccountIds,
            storage,
            inputBytes: initialInputBytes,
            excludeAccountIds: new Set([failedRouteId]),
          })
          const migrated = routes.allRoutes.find(
            (candidate) => candidate.id === resolution?.accountId,
          )
          if (resolution && migrated) {
            route = migrated
            return completeRoute(route, await sendRoute(route))
          }
        }
        if (
          primaryResponseAllowsApiFallback(preflight) &&
          (await primaryQuotaRefreshConfirmsExhausted())
        ) {
          if (preflight instanceof Response) {
            await preflight.body?.cancel().catch(() => {})
          } else {
            await response.body?.cancel().catch(() => {})
          }
          const apiFallback = await tryFallbackAccounts({
            includeApiRoutes: true,
            apiOnly: true,
          })
          if (apiFallback) return apiFallback
        }
      }
      return completeRoute(
        route,
        preflight instanceof Response ? preflight : response,
      )
    }
  }

  const fallbackFirst = routingMode === 'fallback-first'
  if (fallbackFirst) {
    const fallback = await tryFallbackAccounts()
    if (fallback) return fallback
  } else if (
    primaryFreshModelScopeExhausted() ||
    (primaryCachedModelScopeExhausted() &&
      (await primaryQuotaRefreshConfirmsModelScopeExhausted()))
  ) {
    const fallback = await tryFallbackAccounts()
    if (fallback) return fallback
  }

  logger.debug('pi.route', 'sending on the primary account')
  const primary = await sendAnthropicRequest({
    ...options,
    accessToken: options.primaryAccessToken,
  })
  const primaryPreflight = await firstStreamingError(primary)
  logger.debug('pi.route', 'primary responded', {
    status:
      primaryPreflight instanceof Response ? primaryPreflight.status : 'sse',
    signal: primaryPreflight instanceof Response ? undefined : primaryPreflight,
  })
  if (primaryPreflight instanceof Response) {
    if (!shouldFallbackStatus(primaryPreflight.status, storage))
      return primaryPreflight
  }

  const primaryAllowsQuotaFallback =
    primaryResponseAllowsApiFallback(primaryPreflight)
  logger.debug('pi.route', 'evaluating fallback gates', {
    primaryAllowsQuotaFallback,
    routingMode,
  })
  const allowApiFallback =
    primaryAllowsQuotaFallback && (await primaryQuotaRefreshConfirmsExhausted())
  const allowModelScopedOAuthFallback =
    primaryAllowsQuotaFallback &&
    (await primaryQuotaRefreshConfirmsModelScopeExhausted())
  logger.debug('pi.route', 'fallback gates resolved', {
    allowApiFallback,
    allowModelScopedOAuthFallback,
  })

  if (!fallbackFirst || allowApiFallback || allowModelScopedOAuthFallback) {
    const fallback = await tryFallbackAccounts({
      includeApiRoutes: allowApiFallback,
    })
    if (fallback) {
      if (primaryPreflight instanceof Response) {
        await primaryPreflight.body?.cancel().catch(() => {})
      }
      return fallback
    }
  }

  return primaryPreflight instanceof Response ? primaryPreflight : primary
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('Aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Route a request, retrying the whole routing attempt while the failure looks
 * transient.
 *
 * Retrying at this level rather than around a single `fetch` matters: each
 * attempt re-runs account selection and quota checks, so a retry after a soft
 * 429 can land on a different account than the one that was throttled. A hard
 * rate limit — no billing headroom — is not retried at all, because the next
 * attempt would fail identically and only delay the error the caller needs.
 */
async function executeWithRetry(
  options: Parameters<typeof executeWithFallback>[0],
  maxRetries = DEFAULT_MAX_RETRIES,
): Promise<{ response: Response; bodyText?: string }> {
  const signal = options.streamOptions?.signal
  let attempt = 0

  for (;;) {
    logger.debug('pi.retry', 'attempt start', {
      attempt,
      maxRetries,
      model: options.model.id,
    })
    const attemptStartedAt = Date.now()
    const response = await executeWithFallback(options)
    logger.debug('pi.retry', 'attempt finished', {
      attempt,
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - attemptStartedAt,
    })
    if (response.ok) return { response }

    // Non-OK bodies are small JSON errors and are never streamed, so reading
    // here is cheap and spares the caller a second read of a consumed body.
    const bodyText = await response.text().catch(() => '')
    const classification = classifyRetry(
      response.status,
      response.headers,
      bodyText,
    )
    logger.debug('pi.retry', 'classified failure', {
      attempt,
      status: response.status,
      retryable: classification.retryable,
      hardLimitReason: classification.hardLimitReason,
    })
    if (!classification.retryable || attempt >= maxRetries || signal?.aborted) {
      logger.info('pi.retry', 'giving up', {
        attempt,
        status: response.status,
        reason: !classification.retryable
          ? (classification.hardLimitReason ?? 'not-retryable')
          : signal?.aborted
            ? 'aborted'
            : 'retry-budget-exhausted',
      })
      return { response, bodyText }
    }

    const delayMs = nextRetryDelayMs(response.headers, attempt)
    logger.info('pi.retry', 'backing off before retry', { attempt, delayMs })
    await sleep(delayMs, signal)
    attempt += 1
  }
}

export function streamCortexKitAnthropic(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()

  void (async () => {
    const output = createOutput(model)
    stream.push({ type: 'start', partial: output })

    try {
      // Pi hands us its own stored credential. That store is separate from the
      // machine-wide one, so a host that has never run Pi's own login has
      // nothing to give even when several accounts are logged in and routable.
      // Falling back to the shared store is the whole point of having one —
      // every other path here already reads it.
      const accessToken =
        options?.apiKey?.trim() || (await sharedAccessToken()) || ''
      if (!accessToken) {
        logger.error('pi.stream', 'no usable Anthropic credential', {
          model: model.id,
          sessionId: options?.sessionId,
          hostSuppliedKey: Boolean(options?.apiKey?.trim()),
        })
        throw new Error(
          'Missing Anthropic OAuth access token: neither Pi nor the shared account store at ~/.anthropic-accounts/accounts.json holds a usable credential. Run `/login anthropic` in Pi, or add an account with `opencode-anthropic-auth login`.',
        )
      }

      const storagePath = getPiAccountStoragePath()
      logger.info('pi.stream', 'request start', {
        model: model.id,
        sessionId: options?.sessionId,
        contextWindow: model.contextWindow,
        messages: context.messages?.length ?? 0,
      })
      const requestStartedAt = Date.now()
      const { response, bodyText } = await executeWithRetry({
        model,
        context,
        streamOptions: options,
        primaryAccessToken: accessToken,
        storagePath,
      })

      if (!response.ok) {
        logger.warn('pi.stream', 'request failed', {
          status: response.status,
          durationMs: Date.now() - requestStartedAt,
          body: (bodyText ?? '').slice(0, 300),
        })
        throw new Error(
          `Anthropic request failed: HTTP ${response.status} ${bodyText ?? ''}`,
        )
      }
      logger.info('pi.stream', 'streaming response', {
        durationMs: Date.now() - requestStartedAt,
      })

      const blocks = output.content as Block[]
      for await (const event of parseSse(response)) {
        if (event.type === 'message_start') {
          updateUsage(model, output, event.message?.usage)
        } else if (event.type === 'content_block_start') {
          const block = event.content_block
          if (block?.type === 'text') {
            output.content.push({
              type: 'text',
              text: '',
              index: event.index,
            } as Block)
            stream.push({
              type: 'text_start',
              contentIndex: output.content.length - 1,
              partial: output,
            })
          } else if (block?.type === 'thinking') {
            output.content.push({
              type: 'thinking',
              thinking: '',
              thinkingSignature: '',
              index: event.index,
            } as Block)
            stream.push({
              type: 'thinking_start',
              contentIndex: output.content.length - 1,
              partial: output,
            })
          } else if (block?.type === 'tool_use') {
            output.content.push({
              type: 'toolCall',
              id: String(block.id),
              name: fromClaudeCodeToolName(String(block.name), context.tools),
              arguments: {},
              partialJson: '',
              index: event.index,
            } as Block)
            stream.push({
              type: 'toolcall_start',
              contentIndex: output.content.length - 1,
              partial: output,
            })
          }
        } else if (event.type === 'content_block_delta') {
          const contentIndex = blocks.findIndex(
            (block) => block.index === event.index,
          )
          const block = blocks[contentIndex]
          if (!block || !event.delta) continue
          if (event.delta.type === 'text_delta' && block.type === 'text') {
            const delta = String(event.delta.text ?? '')
            block.text += delta
            stream.push({
              type: 'text_delta',
              contentIndex,
              delta,
              partial: output,
            })
          } else if (
            event.delta.type === 'thinking_delta' &&
            block.type === 'thinking'
          ) {
            const delta = String(event.delta.thinking ?? '')
            block.thinking += delta
            stream.push({
              type: 'thinking_delta',
              contentIndex,
              delta,
              partial: output,
            })
          } else if (
            event.delta.type === 'signature_delta' &&
            block.type === 'thinking'
          ) {
            block.thinkingSignature = `${block.thinkingSignature ?? ''}${String(event.delta.signature ?? '')}`
          } else if (
            event.delta.type === 'input_json_delta' &&
            block.type === 'toolCall'
          ) {
            const delta = String(event.delta.partial_json ?? '')
            block.partialJson = `${block.partialJson ?? ''}${delta}`
            try {
              block.arguments = JSON.parse(block.partialJson)
            } catch {}
            stream.push({
              type: 'toolcall_delta',
              contentIndex,
              delta,
              partial: output,
            })
          }
        } else if (event.type === 'content_block_stop') {
          const contentIndex = blocks.findIndex(
            (block) => block.index === event.index,
          )
          const block = blocks[contentIndex]
          if (!block) continue
          delete block.index
          if (block.type === 'text') {
            stream.push({
              type: 'text_end',
              contentIndex,
              content: block.text,
              partial: output,
            })
          } else if (block.type === 'thinking') {
            stream.push({
              type: 'thinking_end',
              contentIndex,
              content: block.thinking,
              partial: output,
            })
          } else if (block.type === 'toolCall') {
            try {
              block.arguments = JSON.parse(block.partialJson ?? '{}')
            } catch {}
            delete block.partialJson
            stream.push({
              type: 'toolcall_end',
              contentIndex,
              toolCall: block,
              partial: output,
            })
          }
        } else if (event.type === 'message_delta') {
          // A usage-only message_delta carries no stop_reason, so mapping the
          // absent value would report a healthy stream as a failed one.
          const rawStopReason = event.delta?.stop_reason
          if (rawStopReason) {
            output.stopReason = mapStopReason(String(rawStopReason))
            if (output.stopReason === 'error')
              output.errorMessage = describeStopReasonFailure(
                String(rawStopReason),
              )
          }
          updateUsage(model, output, event.usage)
        } else if (event.type === 'error') {
          throw new Error(JSON.stringify(event))
        }
      }

      if (options?.signal?.aborted) throw new Error('Request was aborted')
      // A `done` event only admits stop/length/toolUse, so an error stop reason
      // has to leave through the error path or it reaches the caller unlabelled.
      if (output.stopReason === 'error')
        throw new Error(
          output.errorMessage ?? describeStopReasonFailure('(none reported)'),
        )
      for (const block of output.content as Block[]) delete block.index
      stream.push({
        type: 'done',
        reason: output.stopReason as 'stop' | 'length' | 'toolUse',
        message: output,
      })
      stream.end()
    } catch (error) {
      for (const block of output.content as Block[]) delete block.index
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error'
      output.errorMessage =
        error instanceof Error ? error.message : String(error)
      stream.push({ type: 'error', reason: output.stopReason, error: output })
      stream.end()
    }
  })()

  return stream
}
