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
  isLongContextCreditsRequiredError,
  isOAuthAccount,
  isPermanentRefreshError,
  isValidApiBaseURL,
  killswitchPassesPolicy,
  loadAccounts,
  loadSharedAccountStore,
  logger,
  materializeSharedFallbackAccounts,
  mergeAnthropicBetas,
  modelSupportsContext1m,
  nextRetryDelayMs,
  normalizeQuotaHeaders,
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
  sharedAccountIsAvailable,
  shouldFallbackStatus,
  stickyQuotaSnapshotIsFresh,
  stickyRetryAfterWithJitter,
  stickyRouteFamilyForModel,
  syncRefreshedFallbackAccountInSharedStore,
  tokenFingerprint,
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
import { refreshAnthropicToken } from './shared-refresh.ts'

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
      // Persist every rotation back into the shared store. Without this the new
      // token lands only in Pi's sidecar — which does not exist on a host that
      // has never run Pi's own login — so the next routing pass re-reads the
      // *old* refresh token from the shared store and presents it a second
      // time. Anthropic revokes the whole family on the second presentation,
      // which is a single-process double-spend that no cross-process claim can
      // prevent, because both spends genuinely believe they hold a live token.
      onFallbackCredentialChanged: async (account, expectedRefresh) => {
        const synced = await syncRefreshedFallbackAccountInSharedStore(
          account,
          expectedRefresh,
        )
        return synced.result
      },
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
  /** Present on `type: "error"` frames: `{type, message, details}`. */
  error?: { type?: string; message?: string }
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

/**
 * Access-token fingerprints for which Anthropic directed 1M-context requests
 * to use the standard 200k window.
 *
 * Claude Code 2.1.260 sets an account-local latch after the specific 429 long-
 * context credits response. This is not a claim that 1M context is inherently
 * paid usage; it mirrors the server-directed fallback for this token lineage.
 */
const context1mClampedTokens = new Set<string>()

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
  const relayAffinity = options.streamOptions?.sessionId ?? null
  const input = options.apiAccount
    ? buildExplicitBaseMessagesUrl(options.apiAccount.baseURL)
    : new URL('/v1/messages?beta=true', options.model.baseUrl)

  const harvestQuotaHeaders = (headers: Headers) => {
    if (options.apiAccount || !options.accessToken) return
    try {
      const incoming = normalizeQuotaHeaders(headers)
      if (!incoming.five_hour && !incoming.seven_day) return
      const { quotaManager } = getPiRoutingServices(
        options.storagePath,
        storage,
      )
      if (
        options.oauthAccountId &&
        options.oauthAccountId !== STICKY_ROUTING_MAIN_ACCOUNT_ID
      ) {
        quotaManager.pushFallbackFromHeaders(
          options.oauthAccountId,
          options.accessToken,
          incoming,
        )
      } else {
        quotaManager.pushMainFromHeaders(options.accessToken, incoming)
      }
    } catch (error) {
      logger.debug('pi.quota', 'failed to harvest response quota headers', {
        error: errorText(error),
      })
    }
  }

  const buildHeaders = (suppressContext1m: boolean): Headers => {
    const headers = options.apiAccount
      ? configureApiRouteHeaders(options.apiAccount, fastMode)
      : applyClaudeCodeHeaders(new Headers(), options.accessToken ?? '', {
          body,
          identity,
          suppressContext1m,
        })
    if (!options.apiAccount && fastMode) {
      headers.set(
        'anthropic-beta',
        mergeAnthropicBetas(headers.get('anthropic-beta'), [FAST_MODE_BETA]),
      )
    }
    return headers
  }

  const directFetch = async (headers: Headers, init: RequestInit) => {
    const startedAt = Date.now()
    // Fingerprint the bearer that actually goes out. `oauthAccountId` is only
    // set on some call sites, so without this a 429 in the log cannot be tied
    // to the account that earned it — which is how an exhausted account sat
    // first in the rotation unnoticed.
    const sentToken = /^Bearer\s+(.+)$/i.exec(
      headers.get('authorization') ?? '',
    )?.[1]
    logger.debug('pi.send', 'direct fetch start', {
      url: input.toString(),
      route: options.route ?? (options.apiAccount ? 'api' : 'oauth'),
      oauthAccountId: options.oauthAccountId,
      tokenFp: sentToken ? tokenFingerprint(sentToken) : undefined,
      bodyBytes: bodyText.length,
      betas: headers.get('anthropic-beta'),
    })
    try {
      const response = await fetch(input, init)
      harvestQuotaHeaders(response.headers)
      logger.debug('pi.send', 'direct fetch done', {
        status: response.status,
        durationMs: Date.now() - startedAt,
        oauthAccountId: options.oauthAccountId,
        tokenFp: sentToken ? tokenFingerprint(sentToken) : undefined,
        ...describeRateLimitHeaders(response.headers),
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

  const sendOnce = async (suppressContext1m: boolean): Promise<Response> => {
    const headers = buildHeaders(suppressContext1m)
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

    if (options.apiAccount) return directFetch(headers, init)

    return sendViaRelay({
      config: getRelayConfig(storage),
      input,
      init,
      headers,
      body: bodyText,
      fallback: () => directFetch(headers, init),
      affinity: relayAffinity,
      onResponseHeaders: harvestQuotaHeaders,
    })
  }

  // Mirror Claude Code 2.1.260's account-local long-context credits latch. The
  // first matching 429 is returned to the host; later requests on the same token
  // use the standard 200k path. The SDK/host retry loop owns replay, so this
  // layer must not create a second billed attempt inside one provider call.
  const clampTokenFp =
    !options.apiAccount && options.accessToken
      ? tokenFingerprint(options.accessToken)
      : undefined
  const preClamped = clampTokenFp
    ? context1mClampedTokens.has(clampTokenFp)
    : false
  const response = await sendOnce(preClamped)
  if (
    clampTokenFp &&
    !preClamped &&
    response.status === 429 &&
    modelSupportsContext1m(options.model.id)
  ) {
    const peek = await response
      .clone()
      .text()
      .catch(() => '')
    if (isLongContextCreditsRequiredError(response.status, peek)) {
      context1mClampedTokens.add(clampTokenFp)
      logger.warn(
        'pi.send',
        'Anthropic requires usage credits for this 1M-context route; later requests will use 200k',
        {
          oauthAccountId: options.oauthAccountId,
          tokenFp: clampTokenFp,
          model: options.model.id,
          requestId: response.headers.get('request-id'),
          body: peek.slice(0, 200),
        },
      )
      // Do not replay here. The native client records the latch while returning
      // the rate-limit error; the host's normal retry/next turn uses it.
    }
  }
  return response
}

/** Compact quota rendering for logs: `5h 48% / 7d 55%`, or `unknown`. */
function describeQuota(quota: OAuthQuotaSnapshot | undefined): string {
  if (!quota) return 'unknown'
  const percent = (key: 'five_hour' | 'seven_day') => {
    const used = quota[key]?.usedPercent
    return typeof used === 'number' ? `${Math.round(used)}%` : '?'
  }
  return `5h ${percent('five_hour')} / 7d ${percent('seven_day')}`
}

/**
 * The rate-limit headers that decide whether a 429 is worth retrying. Logged
 * together because reading them one at a time out of a log is how a hard limit
 * gets mistaken for a transient one.
 */
function describeRateLimitHeaders(headers: Headers) {
  return {
    unifiedStatus: headers.get('anthropic-ratelimit-unified-status'),
    overageStatus: headers.get('anthropic-ratelimit-unified-overage-status'),
    overageDisabledReason: headers.get(
      'anthropic-ratelimit-unified-overage-disabled-reason',
    ),
    claim: headers.get('anthropic-ratelimit-unified-representative-claim'),
    retryAfter: headers.get('retry-after'),
    requestId: headers.get('request-id'),
  }
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

/**
 * Streamed error types worth rotating to another account. Anything else is the
 * caller's business and is surfaced as-is rather than burning the pool.
 */
const ROTATABLE_STREAM_ERRORS: ReadonlySet<string> = new Set([
  'rate_limit_error',
  'overloaded_error',
])

async function firstStreamingError(
  response: Response,
): Promise<Response | string> {
  if (!response.ok) return response
  const clone = response.clone()
  try {
    for await (const event of parseSse(clone as unknown as Response)) {
      if (event.type === 'error') {
        // Anthropic reports a rate limit on a *200* whose stream opens with
        // `{"type":"error","error":{"type":"rate_limit_error",...}}`. This read
        // `event.delta.type` — a field that only exists on content deltas — so
        // the match never fired: the 200 was treated as a served request and
        // the error text was streamed to the caller instead of rotating to a
        // healthy account. `retryAfter` is absent on these, and the status
        // never reaches `classifyRetry`, so this peek is the only thing
        // standing between an out-of-credits account and a failed turn.
        const errorType = event.error?.type ?? event.delta?.type
        if (
          typeof errorType === 'string' &&
          ROTATABLE_STREAM_ERRORS.has(errorType)
        ) {
          logger.warn('pi.route', 'stream opened with a rotatable error', {
            errorType,
            message: event.error?.message,
          })
          return errorType
        }
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

  // This token is used as a bearer directly — nothing on this path refreshes
  // it. `pickSharedAccount` only judges quota and cooldown, so it will happily
  // return an account whose access token expired days ago: every request then
  // ships its full body to earn a guaranteed 401. Skip expired credentials and
  // take the next usable account instead.
  const now = Date.now()
  let candidate = pickSharedAccount(loaded.store, now)
  if (candidate && !oauthCredentialIsLive(candidate, now)) {
    logger.warn('pi.stream', 'shared main credential is expired; skipping', {
      accountId: candidate.id,
      expiredForMs:
        candidate.credential.type === 'oauth' &&
        typeof candidate.credential.expires_at === 'number'
          ? now - candidate.credential.expires_at
          : undefined,
    })
    candidate = loaded.store.accounts.find(
      (account) =>
        account.id !== candidate?.id && oauthCredentialIsLive(account, now),
    )
  }
  if (candidate?.credential.type !== 'oauth') {
    // Every access token is expired, which is not the same as having no
    // credential: refresh tokens live for weeks and outlast their access
    // tokens by design, so the store is usually one rotation away from
    // healthy. Giving up here told the user to re-login while six accounts
    // held refresh tokens valid for another three weeks.
    const refreshed = await refreshExpiredSharedAccount(loaded.store, now)
    if (refreshed) return refreshed
    logger.error('pi.stream', 'no shared account has a live access token', {
      accounts: loaded.store.accounts.length,
    })
    return undefined
  }
  logger.info('pi.stream', 'using a shared-store credential', {
    accountId: candidate.id,
  })
  return candidate.credential.access || undefined
}

/**
 * Spend a refresh token to revive the store when no access token is live.
 *
 * Tries accounts in turn because a single revoked login must not strand the
 * healthy ones — that is the failure this exists to prevent. The refresh call
 * carries the cross-process lease, the dead-token guard and the store write,
 * so each attempt here is just a call.
 */
async function refreshExpiredSharedAccount(
  store: Awaited<ReturnType<typeof loadSharedAccountStore>>['store'],
  now: number,
): Promise<string | undefined> {
  const candidates = store.accounts.filter(
    (account) =>
      account.enabled !== false &&
      account.credential.type === 'oauth' &&
      account.credential.refresh &&
      // A refresh token past its own expiry buys a guaranteed rejection.
      (typeof account.credential.refresh_expires_at !== 'number' ||
        account.credential.refresh_expires_at > now),
  )
  for (const account of candidates) {
    if (account.credential.type !== 'oauth') continue
    try {
      const rotated = await refreshAnthropicToken({
        refresh: account.credential.refresh,
        access: account.credential.access,
        expires: account.credential.expires_at,
      })
      if (rotated.access) {
        logger.info('pi.stream', 'revived the shared store by refreshing', {
          accountId: account.id,
        })
        return rotated.access
      }
    } catch (error) {
      logger.warn('pi.stream', 'shared account refresh failed; trying next', {
        accountId: account.id,
        error: errorText(error),
      })
    }
  }
  return undefined
}

/** An OAuth account whose access token is present and not past its expiry. */
function oauthCredentialIsLive(
  account: {
    credential: { type: string; access?: string; expires_at?: unknown }
  },
  now: number,
) {
  const credential = account.credential
  if (credential.type !== 'oauth' || !credential.access) return false
  // A missing expiry is treated as live: the server is the authority, and
  // refusing to try would strand an otherwise usable credential.
  if (typeof credential.expires_at !== 'number') return true
  return credential.expires_at > now
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
  // Drop accounts the store already knows are spent. `accountAvailable` fails
  // open on a missing or stale reading, so only a *freshly observed* exhausted
  // account is skipped — and skipping it here is what stops every request
  // paying a round trip to be told 429 by an account whose weekly window does
  // not reset for days.
  const spent = new Set(
    loaded.store.accounts
      .filter((account) => !sharedAccountIsAvailable(account))
      .map((account) => account.id),
  )
  if (spent.size) {
    logger.debug('pi.route', 'excluding spent accounts from the pool', {
      ids: [...spent],
    })
  }
  const accounts = materializeSharedFallbackAccounts(
    storage?.accounts ?? [],
    loaded.store,
  ).filter((account) => !spent.has(account.id))
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

  /**
   * Which stored account the primary token belongs to, if any.
   *
   * Pi supplies the primary credential itself, so it is frequently *not* in the
   * shared store — and then a 429 on the primary leg names no account at all.
   * Reporting `unknown` explicitly is the point: it says the failing account is
   * one this router cannot rotate away from.
   */
  async function describePrimary() {
    const token = options.primaryAccessToken
    const fp = tokenFingerprint(token)
    try {
      const loaded = await loadSharedAccountStore()
      const match = loaded.store.accounts.find(
        (candidate) =>
          candidate.credential.type === 'oauth' &&
          candidate.credential.access === token,
      )
      return {
        tokenFp: fp,
        accountId: match?.id ?? 'unknown (not in the shared store)',
        storeQuota: match?.quota
          ? `5h ${match.quota.five_hour_percent}% / 7d ${match.quota.seven_day_percent}%`
          : 'none recorded',
      }
    } catch {
      return { tokenFp: fp, accountId: 'unknown (store unreadable)' }
    }
  }

  async function primaryQuotaRefreshConfirmsExhausted() {
    try {
      const quota = await quotaManager.refreshMain(options.primaryAccessToken)
      await recordQuotaObservation(options.primaryAccessToken, quota)
      const entry = quotaManager.getMain(options.primaryAccessToken)
      const exhausted = Boolean(
        entry &&
          entry.refreshAfter > Date.now() &&
          quotaSnapshotIsExhausted(quota),
      )
      logger.debug('pi.quota', 'primary quota refreshed', {
        quota: describeQuota(quota),
        exhausted,
        entryFresh: Boolean(entry && entry.refreshAfter > Date.now()),
      })
      return exhausted
    } catch (error) {
      logger.debug('pi.quota', 'primary quota refresh failed', {
        error: errorText(error),
      })
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

  /**
   * The primary is spent according to a reading we already have.
   *
   * Pi hands us its own credential, which lives outside the shared store, so
   * an exhausted primary can never be rotated away — it is simply retried
   * first on every request, eats a 429, and only then falls back. Checking the
   * cached quota costs nothing and skips that wasted round trip. Deliberately
   * uses the *fresh* reading only: a stale one would strand the primary after
   * its window had already reset.
   */
  function primaryFreshExhausted() {
    const entry = quotaManager.getMain(options.primaryAccessToken)
    return Boolean(
      entry &&
        !quotaManager.isMainStale(options.model.id) &&
        quotaSnapshotIsExhausted(entry.quota),
    )
  }

  /**
   * The primary has no headroom left.
   *
   * Checks the cached reading first and only probes `/api/oauth/usage` when it
   * has gone stale — `refreshMain` caches behind its own `refreshAfter` and
   * dedups in-flight calls, so this costs one small request per staleness
   * window rather than one per message.
   */
  async function primaryExhausted() {
    if (primaryFreshExhausted()) {
      logger.debug('pi.quota', 'primary exhausted: fresh cached reading', {
        quota: describeQuota(
          quotaManager.getMain(options.primaryAccessToken)?.quota,
        ),
      })
      return true
    }
    const stale = quotaManager.isMainStale(options.model.id)
    logger.trace('pi.quota', 'primary headroom check', {
      cached: describeQuota(
        quotaManager.getMain(options.primaryAccessToken)?.quota,
      ),
      stale,
      willProbe: stale,
    })
    if (!stale) return false
    return await primaryQuotaRefreshConfirmsExhausted()
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
    const order = (storage?.accounts ?? []).map((account) => account.id)
    logger.debug('pi.route', 'fallback attempt order', { order })
    for (const [position, configured] of (storage?.accounts ?? []).entries()) {
      let response: Response | null = null
      const account = isOAuthAccount(configured)
        ? usableOAuthById.get(configured.id)
        : configured
      if (!account) {
        // The manager dropped it — expired, disabled, or permanently failed.
        // Saying so here is what distinguishes "never tried" from "tried and
        // failed" when reading the log backwards from a failure.
        logger.debug('pi.route', 'fallback candidate not usable', {
          id: configured.id,
          position,
          reason: 'absent from getUsableFallbackAccounts',
        })
        continue
      }

      if (isOAuthAccount(account)) {
        if (routeOptions.apiOnly === true || !account.access) {
          logger.debug('pi.route', 'fallback candidate skipped', {
            id: account.id,
            position,
            reason:
              routeOptions.apiOnly === true
                ? 'api-only pass'
                : 'no access token',
          })
          continue
        }
        logger.debug('pi.route', 'fallback attempt: sending', {
          id: account.id,
          position,
          route: 'oauth',
          tokenFp: tokenFingerprint(account.access),
          knownQuota: describeQuota(
            quotaManager.getFallback(account.id, account.access)?.quota ??
              account.quota,
          ),
        })
        response = await sendAnthropicRequest({
          ...options,
          accessToken: account.access,
          oauthAccountId: account.id,
        })
      } else if (
        routeOptions.includeApiRoutes === true &&
        isApiKeyAccount(account) &&
        account.enabled !== false &&
        account.apiKey &&
        isValidApiBaseURL(account.baseURL)
      ) {
        logger.debug('pi.route', 'fallback attempt: sending', {
          id: account.id,
          position,
          route: 'api',
          baseURL: account.baseURL,
        })
        response = await sendAnthropicRequest({
          ...options,
          apiAccount: account,
        })
      }
      if (!response) {
        logger.debug('pi.route', 'fallback candidate skipped', {
          id: configured.id,
          position,
          reason: 'no route matched this account shape',
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
        position,
        status: preflight instanceof Response ? preflight.status : 'sse-error',
        ...(preflight instanceof Response
          ? describeRateLimitHeaders(preflight.headers)
          : { sseError: preflight }),
      })
      if (
        preflight instanceof Response &&
        !shouldFallbackStatus(preflight.status, storage)
      ) {
        // A status the router treats as terminal: surface it rather than
        // burning the rest of the pool on a failure that will repeat.
        logger.info('pi.route', 'fallback halted on a terminal status', {
          id: account.id,
          status: preflight.status,
        })
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
    (await primaryExhausted()) ||
    primaryFreshModelScopeExhausted() ||
    (primaryCachedModelScopeExhausted() &&
      (await primaryQuotaRefreshConfirmsModelScopeExhausted()))
  ) {
    logger.debug('pi.route', 'skipping a spent primary', {
      modelScopeExhausted: primaryFreshModelScopeExhausted(),
    })
    // Falling through to the primary when no fallback can serve is deliberate:
    // a 429 from the real account beats a synthesised failure.
    const fallback = await tryFallbackAccounts()
    if (fallback) return fallback
  }

  const primaryIdentity = await describePrimary()
  logger.debug('pi.route', 'sending on the primary account', primaryIdentity)
  const primary = await sendAnthropicRequest({
    ...options,
    accessToken: options.primaryAccessToken,
    oauthAccountId: primaryIdentity.accountId,
  })
  const primaryPreflight = await firstStreamingError(primary)
  logger.debug('pi.route', 'primary responded', {
    ...primaryIdentity,
    status:
      primaryPreflight instanceof Response ? primaryPreflight.status : 'sse',
    signal: primaryPreflight instanceof Response ? undefined : primaryPreflight,
    ...(primaryPreflight instanceof Response
      ? describeRateLimitHeaders(primaryPreflight.headers)
      : {}),
  })
  if (primaryPreflight instanceof Response) {
    if (!shouldFallbackStatus(primaryPreflight.status, storage)) {
      logger.info('pi.route', 'primary status is terminal; not falling back', {
        status: primaryPreflight.status,
        ...primaryIdentity,
      })
      return primaryPreflight
    }
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
  } else {
    logger.debug('pi.route', 'fallback pass not attempted', {
      fallbackFirst,
      allowApiFallback,
      allowModelScopedOAuthFallback,
    })
  }

  // Every account in the pool has now failed. Surfacing the primary's response
  // is the honest answer, but the log has to say that it is a last resort
  // rather than a first-choice result.
  logger.warn('pi.route', 'no account could serve; returning the primary', {
    ...primaryIdentity,
    primaryStatus:
      primaryPreflight instanceof Response ? primaryPreflight.status : 'sse',
  })
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
      // Anthropic returns several different 429 shapes — a plan-window limit,
      // an org-level `{"message":"Rate limited"}`, a credits failure — and the
      // headers alone do not distinguish them. Without the body in the log, a
      // report of "429" cannot be matched to the response that caused it.
      body: bodyText.slice(0, 300),
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
    logger.info('pi.retry', 'backing off before retry', {
      attempt,
      delayMs,
      // Where the wait came from. A server-directed `retry-after` can be days
      // long, so a delay that did not come from the local backoff curve is the
      // first thing to check when a request appears to hang.
      source: response.headers.get('retry-after')
        ? `retry-after: ${response.headers.get('retry-after')}`
        : 'local backoff',
      nextAttempt: attempt + 1,
      remainingRetries: maxRetries - attempt,
    })
    await sleep(delayMs, signal)
    logger.trace('pi.retry', 'backoff elapsed', { attempt, delayMs })
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
      const hostKey = options?.apiKey?.trim()
      const accessToken = hostKey || (await sharedAccessToken()) || ''
      logger.debug('pi.stream', 'primary credential resolved', {
        source: hostKey
          ? 'host-supplied (Pi own store)'
          : accessToken
            ? 'shared account store'
            : 'none',
        tokenFp: accessToken ? tokenFingerprint(accessToken) : undefined,
      })
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
            if (output.stopReason === 'error') {
              output.errorMessage = describeStopReasonFailure(
                String(rawStopReason),
              )
              // `streaming response` is logged before this loop runs, so
              // without this a refused turn is indistinguishable from a served
              // one in the log — the request appears to succeed and the error
              // only ever reaches the caller. Report the token counts too: they
              // are what decide whether a refusal is a context-size problem or
              // a genuine content decline.
              logger.error('pi.stream', 'stream ended with a failing stop', {
                stopReason: String(rawStopReason),
                model: model.id,
                sessionId: options?.sessionId,
                messages: context.messages?.length ?? 0,
                inputTokens: event.usage?.input_tokens,
                outputTokens: event.usage?.output_tokens,
                contextWindow: model.contextWindow,
              })
            }
          }
          updateUsage(model, output, event.usage)
        } else if (event.type === 'error') {
          logger.error('pi.stream', 'stream carried an error frame', {
            model: model.id,
            sessionId: options?.sessionId,
            event: JSON.stringify(event).slice(0, 300),
          })
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
