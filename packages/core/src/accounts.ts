import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { parseRetryAfterSeconds } from './auth.ts'
import { getCachedClaudeCodeVersion } from './claude-version.ts'
import {
  CACHE_1H_MODES,
  type Cache1hMode,
  DEFAULT_CACHE_1H_MODE,
} from './constants.ts'
import { type LogLevel, log, logger } from './logger.ts'
import {
  type AccessToken,
  getSharedAccessToken,
  handleSharedUnauthorized,
  importHostOAuthCredential,
  type KeepAliveResult,
  listSharedAccounts,
  markSharedAccountUsed,
  type SharedAnthropicAccount,
  sharedKeepAliveOnce,
  type UnauthorizedResult,
} from './shared-account-store.ts'
import { tokenFingerprint } from './token-fingerprint.ts'

const setRefreshLockRenewalTimeout = globalThis.setTimeout.bind(globalThis)
const clearRefreshLockRenewalTimeout = globalThis.clearTimeout.bind(globalThis)

export const ACCOUNT_FILE_NAME = 'anthropic-auth.json'
export const ACCOUNT_STATE_FILE_NAME = 'anthropic-auth-state.json'
export const QUOTA_URL = 'https://api.anthropic.com/api/oauth/usage'

export type QuotaWindowName = 'five_hour' | 'seven_day'

export type AccountBase = {
  id: string
  label?: string
  enabled?: boolean
  addedAt?: number
  lastUsed?: number
}

/**
 * An OAuth account served by the shared store.
 *
 * The refresh token lives only in the store (Rust binding) and never in this
 * object. `access` and `expires` are runtime values: they are hydrated from
 * the store just before use (`FallbackAccountManager.ensureAccessToken`) and
 * are never written to the host config or state file. `refreshExpires`,
 * `lastRefreshedAt` and `lastRefreshError` mirror the store row (non-secret)
 * and are not persisted by the host either.
 */
export type OAuthAccount = AccountBase & {
  type: 'oauth'
  authLineageId?: string
  access?: string
  expires?: number
  refreshExpires?: number
  lastRefreshedAt?: number
  lastRefreshError?: AccountOperationError
  lastQuotaRefreshError?: AccountOperationError
  quota?: OAuthQuotaSnapshot
  profile?: OAuthAccountProfile
  /**
   * Per-fallback cumulative prime counters. Lives in the runtime-state file
   * (scoped under `accounts[id].prime`) and never in `anthropic-auth.json`.
   */
  prime?: PrimeUsageCounters
}

export type ApiKeyAccount = AccountBase & {
  type: 'api'
  apiKey?: string
  baseURL: string
  authHeader?: 'authorization-bearer' | 'x-api-key'
}

export type FallbackAccount = OAuthAccount | ApiKeyAccount

export function isOAuthAccount(
  account: FallbackAccount,
): account is OAuthAccount {
  return account.type === 'oauth'
}

export function isApiKeyAccount(
  account: FallbackAccount,
): account is ApiKeyAccount {
  return account.type === 'api'
}

export function isValidApiBaseURL(value: string | undefined) {
  const raw = value?.trim()
  if (!raw) return false
  try {
    const url = new URL(raw)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

export type AccountOperationError = {
  message: string
  checkedAt: number
  nextRetryAt?: number
  retryCount?: number
  tokenHash?: string
  /**
   * HTTP status of the underlying refresh/quota failure, when known. Lets
   * consumers distinguish a permanently-dead token (400 invalid_grant →
   * re-login) from a transient failure (429/5xx → recovers) without a delay
   * heuristic. Absent on errors persisted before this field existed.
   */
  status?: number
  /**
   * Explicit dead-token discriminator, set at construction. True ONLY when the
   * refresh endpoint returned 400 invalid_grant (token is genuinely dead →
   * re-login). False for transient failures AND for retry-exhausted/network
   * errors that get a long backoff but are NOT dead — so they are not nagged
   * for re-login. Absent on errors persisted before this field existed (those
   * fall back to status / the 24h-delay heuristic).
   */
  permanent?: boolean
}

export type AccountQuotaWindow = {
  usedPercent: number
  remainingPercent: number
  resetsAt?: string
  checkedAt: number
}

export type AccountScopedQuotaWindow = AccountQuotaWindow & {
  id: string
  title: string
  modelId?: string
  modelName: string
}

export type QuotaMoney = {
  amountMinor: number
  currency: string
  exponent: number
}

export type OAuthExtraUsageSnapshot = {
  used: QuotaMoney
  limit: QuotaMoney
  utilizationPercent?: number
  severity?: string
  exhausted: boolean
}

export type OAuthAccountProfile = {
  tier: string
  orgType: string
  checkedAt: number
  tokenFingerprint?: string
}

export type OAuthQuotaSnapshot = Partial<
  Record<QuotaWindowName, AccountQuotaWindow>
> & {
  scoped?: AccountScopedQuotaWindow[]
  extraUsage?: OAuthExtraUsageSnapshot
  bindingWindow?: string
  bindingWindowSource?: 'poll' | 'headers'
  fallbackAdvised?: boolean
  source?: 'poll' | 'headers'
  // Top-level freshness stamp for the whole snapshot. mergeAccountRuntimeState
  // uses this when the snapshot has no per-window checkedAt (e.g. a windowless
  // empty-scoped snapshot) — without it, a windowless refresh gets read as
  // checkedAt=0 and treated as stale, so an old per-window quota resurrects
  // instead of being overwritten.
  checkedAt?: number
}

export type PrimeUsageCounters = {
  count: number
  inputTokens: number
  outputTokens: number
  since: number
}

export type PrimeUsageDelta = {
  inputTokens?: number
  outputTokens?: number
}

export type PrimeRuntimeState = {
  enabled?: boolean
  mainAuthLineageId?: string
  mainAuthLineageRefreshTokenFingerprint?: string
  /**
   * The fingerprint this lineage was bound to immediately before the current
   * one. A rotation rebinds the lineage before the host publishes the new
   * credential, so for a moment the host still reports the old token. Keeping
   * the previous fingerprint lets that window be recognised as the same
   * session instead of a re-login — which would mint a new lineage and let an
   * already-primed window fire a second time.
   */
  mainAuthLineagePreviousRefreshTokenFingerprint?: string
  /**
   * Main account prime counters. Persisted only on the main side of the
   * runtime-state file — `configFromStorage()` never writes them to the config
   * file so they cannot leak into `anthropic-auth.json`.
   */
  main?: PrimeUsageCounters
}

export type RoutingMode = 'main-first' | 'fallback-first' | 'sticky-balanced'

export type KillswitchThresholds = Partial<
  Record<QuotaWindowName | '5h' | '1w' | 'scoped', number>
>

export type KillswitchConfig = {
  enabled?: boolean
  /** Thresholds for the main OAuth account (remaining % below which the account is killed). */
  main?: KillswitchThresholds
  /** Per-account overrides keyed by account ID. Accounts without an entry use the `main` thresholds. */
  accounts?: Record<string, KillswitchThresholds>
}

export type AccountStorage = {
  version: 1
  main?: {
    type: 'opencode'
    provider: 'anthropic'
    profile?: OAuthAccountProfile
  }
  routing?: {
    mode?: RoutingMode
  }
  fallbackOn?: number[]
  refresh?: {
    /** `false` turns the periodic store keep-alive off for this host. */
    enabled?: boolean
    /** Keep-alive cadence (default 10 minutes). */
    intervalMinutes?: number
    /**
     * Unused since refresh moved into the store; kept so existing configs
     * still parse.
     */
    refreshBeforeExpiryMinutes?: number
    /**
     * Runtime only: the store's refresh verdict for the main account, filled
     * in by the host from the store row. Never persisted.
     */
    mainLastRefreshError?: AccountOperationError
  }
  quota?: {
    enabled?: boolean
    checkIntervalMinutes?: number
    refreshEveryNRequests?: number
    minimumRemaining?: Partial<Record<QuotaWindowName | '5h' | '1w', number>>
    failClosedOnUnknownQuota?: boolean
    /** Opt-in OpenCode TUI toast after quota refresh. Default: false. */
    showToasts?: boolean
    mainQuota?: OAuthQuotaSnapshot
    mainQuotaCheckedAt?: number
    // Fingerprint of the access token that produced mainQuota. Used to avoid
    // seeding a different account's persisted quota after a main-account switch.
    mainQuotaToken?: string
    mainLastQuotaApiError?: AccountOperationError
  }
  claudeCache?: {
    enabled?: boolean
    mode?: Cache1hMode
  }
  dump?: {
    enabled?: boolean
  }
  logging?: {
    level?: LogLevel
  }
  claudeFast?: {
    enabled?: boolean
  }
  /**
   * Zero out Anthropic OAuth model costs in the provider hook. Default: enabled
   * (OAuth usage is quota-based, not per-token billed, so costs show as $0).
   * Set `enabled: false` to opt out and display the provider's real model costs.
   */
  costZeroing?: {
    enabled?: boolean
  }
  cacheKeep?: {
    enabled?: boolean
    always?: boolean
    startHour?: number
    endHour?: number
    subagents?: boolean
  }
  /**
   * Opt-in flag and runtime metadata for `/claude-prime`. The `enabled` flag
   * belongs on the config side; counters and main lineage bindings live in the
   * state file and must never appear in `anthropic-auth.json`. See
   * `configFromStorage()` for the write-side filter.
   */
  prime?: PrimeRuntimeState
  relay?: {
    enabled?: boolean
    url?: string
    token?: string
    fallbackToDirect?: boolean
    transport?: 'http' | 'websocket'
  }
  killswitch?: KillswitchConfig
  accounts: FallbackAccount[]
}

/**
 * Whether Anthropic OAuth model costs should be zeroed in the provider hook.
 * Defaults to enabled; only an explicit `costZeroing.enabled === false` opts out
 * (to display the provider's real model costs).
 */
export function isCostZeroingEnabled(
  storage: Pick<AccountStorage, 'costZeroing'>,
): boolean {
  return storage.costZeroing?.enabled !== false
}

/**
 * Per-account runtime state persisted in the host state file. It carries no
 * OAuth token: those live only in the shared store.
 */
export type AccountRuntimeEntry = Partial<
  Pick<
    OAuthAccount,
    | 'authLineageId'
    | 'lastUsed'
    | 'lastQuotaRefreshError'
    | 'quota'
    | 'profile'
    | 'prime'
  > &
    Pick<ApiKeyAccount, 'apiKey' | 'lastUsed'>
>

/**
 * Fields older plugin versions wrote into the host config/state files. They
 * are imported into the store once ({@link loadAccounts}) and never written
 * again.
 */
const LEGACY_TOKEN_FIELDS = [
  'access',
  'refresh',
  'expires',
  'refreshExpires',
  'lastRefreshedAt',
  'lastRefreshError',
] as const

export type AccountRuntimeState = {
  version: 1
  main?: {
    profile?: OAuthAccountProfile
    profileToken?: string
    quota?: OAuthQuotaSnapshot
    quotaCheckedAt?: number
    quotaToken?: string
    lastQuotaApiError?: AccountOperationError
    prime?: PrimeUsageCounters
    primeAuthLineageId?: string
    primeAuthLineageRefreshTokenFingerprint?: string
    primeAuthLineagePreviousRefreshTokenFingerprint?: string
  }
  accounts?: Record<string, AccountRuntimeEntry>
}

export type AccountStateSaveScope = {
  mainProfile?: boolean
  mainQuota?: boolean
  mainPrime?: boolean
  accounts?: true | string[]
}

type OAuthUsageWindow = {
  utilization?: number
  resets_at?: string
}

type OAuthUsageLimit = {
  kind?: string
  group?: string
  percent?: number
  resets_at?: string
  is_active?: boolean
  scope?: {
    model?: {
      id?: string | null
      display_name?: string | null
    } | null
    surface?: unknown
  } | null
}

type OAuthUsageResponse = {
  five_hour?: OAuthUsageWindow
  seven_day?: OAuthUsageWindow
  limits?: OAuthUsageLimit[]
  extra_usage?: {
    is_enabled?: boolean
    monthly_limit?: number | null
    used_credits?: number | null
    utilization?: number | null
  } | null
  spend?: {
    severity?: string | null
    limit?: {
      amount_minor?: number
      currency?: string
      exponent?: number
    } | null
  } | null
}

/**
 * The store operations the account manager needs. Defaults to the Rust
 * binding; tests may substitute parts of it.
 */
export type SharedAccountAccess = {
  getAccessToken: (accountId: string) => Promise<AccessToken>
  handleUnauthorized: (accessToken: string) => Promise<UnauthorizedResult>
  keepAliveOnce: () => Promise<KeepAliveResult>
  listAccounts: () => Promise<SharedAnthropicAccount[]>
  markUsed: (accountId: string) => Promise<boolean>
}

const defaultSharedAccountAccess: SharedAccountAccess = {
  getAccessToken: (accountId) => getSharedAccessToken(accountId),
  handleUnauthorized: (accessToken) => handleSharedUnauthorized(accessToken),
  keepAliveOnce: () => sharedKeepAliveOnce(),
  listAccounts: () => listSharedAccounts(),
  markUsed: (accountId) => markSharedAccountUsed(accountId),
}

export type AccountManagerOptions = {
  now?: () => number
  fetchImpl?: typeof fetch
  configPath?: string
  quotaManager?: import('./quota-manager.ts').QuotaManager
  // Invoked after a background pass persists at least one fallback storage
  // change (quota update or error recording), so consumers (e.g. the OpenCode
  // sidebar) can re-render without a request flowing through the fetch
  // handler.
  onFallbackStorageChanged?: () => void
  /** Store access; defaults to the Rust binding. */
  store?: Partial<SharedAccountAccess>
  setIntervalImpl?: typeof globalThis.setInterval
  clearIntervalImpl?: typeof globalThis.clearInterval
}

export type AccountRefreshError = {
  accountId: string
  message: string
}

// 529 is Anthropic's overload status; Claude Code treats it as the canonical
// capacity signal alongside a mid-stream overloaded_error.
const DEFAULT_FALLBACK_ON = [401, 403, 429, 529]
const DEFAULT_REFRESH_INTERVAL_MINUTES = 10
/**
 * Legacy persisted refresh errors (from before the store owned refresh) used
 * a 24 h backoff to mean "dead token". Only {@link isPermanentRefreshError}
 * still reads that shape.
 */
const LEGACY_PERMANENT_REFRESH_DELAY_MS = 24 * 60 * 60_000
/** Backoff after the store reports a transient refresh failure. */
const MIN_ACCESS_RETRY_DELAY_MS = 60_000
const MAX_ACCESS_RETRY_DELAY_MS = 15 * 60_000
/** An access token this close to expiry is re-read from the store. */
const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 60_000
const MIN_QUOTA_RETRY_DELAY_MS = 60_000
const MAX_QUOTA_RETRY_DELAY_MS = 15 * 60_000
const NON_TRANSIENT_QUOTA_RETRY_DELAY_MS = 5 * 60_000
const DEFAULT_QUOTA_CHECK_INTERVAL_MINUTES = 5
const DEFAULT_MINIMUM_REMAINING: Record<QuotaWindowName, number> = {
  five_hour: 0,
  seven_day: 0,
}
const DEFAULT_FAIL_CLOSED_ON_UNKNOWN_QUOTA = true
const KEEPALIVE_TICK_JITTER_MS = 60_000

function getConfigDir() {
  if (process.env.OPENCODE_CONFIG_DIR?.trim()) {
    return process.env.OPENCODE_CONFIG_DIR.trim()
  }
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'opencode',
  )
}

export function getAccountStoragePath() {
  return (
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE?.trim() ||
    join(getConfigDir(), ACCOUNT_FILE_NAME)
  )
}

export function getAccountStatePath(configPath = getAccountStoragePath()) {
  const explicit = process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE?.trim()
  if (explicit) return explicit
  return configPath.endsWith(ACCOUNT_FILE_NAME)
    ? join(dirname(configPath), ACCOUNT_STATE_FILE_NAME)
    : `${configPath}.state.json`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeAccountBase(value: Record<string, unknown>): AccountBase {
  return {
    id:
      typeof value.id === 'string' && value.id.trim()
        ? value.id.trim()
        : randomUUID(),
    label: typeof value.label === 'string' ? value.label : undefined,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
    addedAt: typeof value.addedAt === 'number' ? value.addedAt : undefined,
    lastUsed: typeof value.lastUsed === 'number' ? value.lastUsed : undefined,
  }
}

function normalizeAccount(value: unknown): FallbackAccount | null {
  if (!isRecord(value)) return null
  if (value.type === 'api') {
    const baseURL =
      typeof value.baseURL === 'string' ? value.baseURL.trim() : ''
    const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : ''
    if (!isValidApiBaseURL(baseURL)) return null
    const authHeader =
      value.authHeader === 'x-api-key' ? 'x-api-key' : 'authorization-bearer'
    return {
      ...normalizeAccountBase(value),
      type: 'api',
      apiKey: apiKey || undefined,
      baseURL,
      authHeader,
    }
  }

  if (value.type !== 'oauth') return null

  // Token fields an older version persisted are deliberately not read: the
  // store owns the credential, and `loadAccounts` has already imported them.
  return {
    ...normalizeAccountBase(value),
    type: 'oauth',
    authLineageId:
      typeof value.authLineageId === 'string' && value.authLineageId.trim()
        ? value.authLineageId
        : undefined,
    lastQuotaRefreshError: normalizeOperationError(value.lastQuotaRefreshError),
    quota: normalizeQuota(value.quota),
    profile: normalizeOAuthAccountProfile(value.profile),
    prime: normalizePrimeUsageCounters(value.prime),
  }
}

function normalizeOAuthAccountProfile(
  value: unknown,
): OAuthAccountProfile | undefined {
  if (!isRecord(value)) return undefined
  if (
    typeof value.tier !== 'string' ||
    !value.tier.trim() ||
    typeof value.orgType !== 'string' ||
    !value.orgType.trim() ||
    typeof value.checkedAt !== 'number' ||
    !Number.isFinite(value.checkedAt)
  ) {
    return undefined
  }
  return {
    tier: value.tier.trim(),
    orgType: value.orgType.trim(),
    checkedAt: value.checkedAt,
    ...(typeof value.tokenFingerprint === 'string' &&
      value.tokenFingerprint.trim() && {
        tokenFingerprint: value.tokenFingerprint.trim(),
      }),
  }
}

function normalizeOperationError(
  value: unknown,
): AccountOperationError | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.message !== 'string') return undefined
  const checkedAt = Number(value.checkedAt)
  if (!Number.isFinite(checkedAt)) return undefined
  const nextRetryAt = Number(value.nextRetryAt)
  const retryCount = Number(value.retryCount)
  const status = Number(value.status)
  return {
    message: value.message,
    checkedAt,
    nextRetryAt: Number.isFinite(nextRetryAt) ? nextRetryAt : undefined,
    retryCount: Number.isFinite(retryCount) ? retryCount : undefined,
    tokenHash:
      typeof value.tokenHash === 'string' ? value.tokenHash : undefined,
    // Preserve the dead-token discriminators across save/load. Without these,
    // a retry-exhausted transient (permanent=false, 24h backoff) would lose its
    // flag on reload and the 24h-delay heuristic would wrongly re-classify it
    // permanent → false "needs re-login" nag.
    status: Number.isFinite(status) ? status : undefined,
    permanent:
      typeof value.permanent === 'boolean' ? value.permanent : undefined,
  }
}

function normalizeQuotaWindow(value: unknown): AccountQuotaWindow | undefined {
  if (!isRecord(value)) return undefined
  const usedPercent = Number(value.usedPercent)
  const remainingPercent = Number(value.remainingPercent)
  const checkedAt = Number(value.checkedAt)
  if (
    !Number.isFinite(usedPercent) ||
    !Number.isFinite(remainingPercent) ||
    !Number.isFinite(checkedAt)
  ) {
    return undefined
  }
  return {
    usedPercent,
    remainingPercent,
    checkedAt,
    resetsAt: typeof value.resetsAt === 'string' ? value.resetsAt : undefined,
  }
}

function normalizePrimeUsageCounters(
  value: unknown,
): PrimeUsageCounters | undefined {
  if (!isRecord(value)) return undefined
  const count = Number(value.count)
  const inputTokens = Number(value.inputTokens)
  const outputTokens = Number(value.outputTokens)
  const since = Number(value.since)
  if (
    ![count, inputTokens, outputTokens, since].every(Number.isFinite) ||
    count < 0 ||
    inputTokens < 0 ||
    outputTokens < 0 ||
    since < 0
  ) {
    return undefined
  }
  return {
    count: Math.floor(count),
    inputTokens: Math.floor(inputTokens),
    outputTokens: Math.floor(outputTokens),
    since: Math.floor(since),
  }
}

function normalizeQuota(value: unknown): OAuthAccount['quota'] {
  if (!isRecord(value)) return undefined
  const quota: OAuthAccount['quota'] = {}
  for (const key of ['five_hour', 'seven_day'] as const) {
    const normalized = normalizeQuotaWindow(value[key])
    if (normalized) quota[key] = normalized
  }

  // Persist a top-level snapshot checkedAt through normalize so the
  // mergeAccountRuntimeState freshness comparison stays meaningful when the
  // snapshot has no per-window checkedAt (e.g. {scoped:[]}). Pre-feature
  // inputs without this key are unaffected — only on-disk snapshots that
  // already carry it reach this branch.
  if (typeof value.checkedAt === 'number' && Number.isFinite(value.checkedAt)) {
    quota.checkedAt = value.checkedAt
  }

  if (Array.isArray(value.scoped)) {
    const scoped = value.scoped
      .map((entry): AccountScopedQuotaWindow | undefined => {
        if (!isRecord(entry)) return undefined
        const window = normalizeQuotaWindow(entry)
        if (!window) return undefined
        if (typeof entry.id !== 'string' || !entry.id.trim()) return undefined
        if (typeof entry.title !== 'string' || !entry.title.trim()) {
          return undefined
        }
        if (typeof entry.modelName !== 'string' || !entry.modelName.trim()) {
          return undefined
        }
        const modelId =
          typeof entry.modelId === 'string' && entry.modelId.trim()
            ? entry.modelId.trim()
            : undefined
        return {
          ...window,
          id: entry.id.trim(),
          title: entry.title.trim(),
          ...(modelId && { modelId }),
          modelName: entry.modelName.trim(),
        }
      })
      .filter((entry): entry is AccountScopedQuotaWindow => entry != null)
    // Preserve empty `[]` so a downstream reader can distinguish "scoped
    // owned by anthropic-auth, none visible" from "no scoped data on this
    // snapshot". Pre-feature inputs without a `scoped` key are not affected
    // — only inputs that already carried an array reach this line.
    quota.scoped = scoped
  }

  if (isRecord(value.extraUsage)) {
    const used = normalizeQuotaMoney(value.extraUsage.used)
    const limit = normalizeQuotaMoney(value.extraUsage.limit)
    if (used && limit && typeof value.extraUsage.exhausted === 'boolean') {
      quota.extraUsage = {
        used,
        limit,
        ...(typeof value.extraUsage.utilizationPercent === 'number' &&
          Number.isFinite(value.extraUsage.utilizationPercent) && {
            utilizationPercent: value.extraUsage.utilizationPercent,
          }),
        ...(typeof value.extraUsage.severity === 'string' && {
          severity: value.extraUsage.severity,
        }),
        exhausted: value.extraUsage.exhausted,
      }
    }
  }

  if (typeof value.bindingWindow === 'string' && value.bindingWindow.trim()) {
    quota.bindingWindow = value.bindingWindow.trim()
  }
  if (
    value.bindingWindowSource === 'poll' ||
    value.bindingWindowSource === 'headers'
  ) {
    quota.bindingWindowSource = value.bindingWindowSource
  }
  if (typeof value.fallbackAdvised === 'boolean') {
    quota.fallbackAdvised = value.fallbackAdvised
  }
  if (value.source === 'poll' || value.source === 'headers') {
    quota.source = value.source
  }

  return Object.keys(quota).length ? quota : undefined
}

function normalizeQuotaMoney(value: unknown): QuotaMoney | undefined {
  if (!isRecord(value)) return undefined
  if (
    typeof value.amountMinor !== 'number' ||
    !Number.isFinite(value.amountMinor) ||
    typeof value.currency !== 'string' ||
    !value.currency.trim() ||
    typeof value.exponent !== 'number' ||
    !Number.isFinite(value.exponent)
  ) {
    return undefined
  }
  return {
    amountMinor: value.amountMinor,
    currency: value.currency.trim(),
    exponent: value.exponent,
  }
}

// Fresh empty storage shell — main OpenCode OAuth account, no fallback
// accounts. Returns a new object each call so mutating callers don't alias.
export function createEmptyStorage(): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    accounts: [],
  }
}

function normalizeStorage(value: unknown): AccountStorage | null {
  if (!isRecord(value) || !Array.isArray(value.accounts)) return null
  return {
    version: 1,
    main: {
      type: 'opencode',
      provider: 'anthropic',
      profile: normalizeOAuthAccountProfile(
        isRecord(value.main) ? value.main.profile : undefined,
      ),
    },
    routing: isRecord(value.routing) ? value.routing : undefined,
    fallbackOn: Array.isArray(value.fallbackOn)
      ? value.fallbackOn.filter((status) => Number.isInteger(status))
      : undefined,
    refresh: isRecord(value.refresh) ? value.refresh : undefined,
    quota: isRecord(value.quota) ? value.quota : undefined,
    claudeCache: isRecord(value.claudeCache) ? value.claudeCache : undefined,
    dump: isRecord(value.dump) ? value.dump : undefined,
    claudeFast: isRecord(value.claudeFast) ? value.claudeFast : undefined,
    costZeroing: isRecord(value.costZeroing) ? value.costZeroing : undefined,
    cacheKeep: isRecord(value.cacheKeep) ? value.cacheKeep : undefined,
    relay: isRecord(value.relay) ? value.relay : undefined,
    logging: isRecord(value.logging) ? value.logging : undefined,
    killswitch: isRecord(value.killswitch) ? value.killswitch : undefined,
    prime: (() => {
      if (!isRecord(value.prime)) return undefined
      const enabled =
        typeof value.prime.enabled === 'boolean'
          ? value.prime.enabled
          : undefined
      const main = normalizePrimeUsageCounters(value.prime.main)
      const mainAuthLineageId =
        typeof value.prime.mainAuthLineageId === 'string' &&
        value.prime.mainAuthLineageId.trim()
          ? value.prime.mainAuthLineageId
          : undefined
      const mainAuthLineageRefreshTokenFingerprint =
        typeof value.prime.mainAuthLineageRefreshTokenFingerprint ===
          'string' && value.prime.mainAuthLineageRefreshTokenFingerprint.trim()
          ? value.prime.mainAuthLineageRefreshTokenFingerprint
          : undefined
      const mainAuthLineagePreviousRefreshTokenFingerprint =
        typeof value.prime.mainAuthLineagePreviousRefreshTokenFingerprint ===
          'string' &&
        value.prime.mainAuthLineagePreviousRefreshTokenFingerprint.trim()
          ? value.prime.mainAuthLineagePreviousRefreshTokenFingerprint
          : undefined
      if (
        enabled === undefined &&
        !main &&
        !mainAuthLineageId &&
        !mainAuthLineageRefreshTokenFingerprint
      )
        return undefined
      return {
        ...(enabled !== undefined && { enabled }),
        ...(main && { main }),
        ...(mainAuthLineageId && { mainAuthLineageId }),
        ...(mainAuthLineageRefreshTokenFingerprint && {
          mainAuthLineageRefreshTokenFingerprint,
        }),
        ...(mainAuthLineagePreviousRefreshTokenFingerprint && {
          mainAuthLineagePreviousRefreshTokenFingerprint,
        }),
      }
    })(),
    accounts: value.accounts
      .map(normalizeAccount)
      .filter((account): account is FallbackAccount => account != null),
  }
}

async function readJsonIfPresent(path: string): Promise<{
  exists: boolean
  value: unknown
}> {
  try {
    return { exists: true, value: JSON.parse(await readFile(path, 'utf8')) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, value: null }
    }
    const cause = error instanceof Error ? error.message : String(error)
    throw new Error(
      `account store at ${path} is corrupt or unreadable (${cause}) — fix or remove it`,
    )
  }
}

function objectWithDefinedEntries(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  )
}

function mergeConfigAccountAndState(
  account: Record<string, unknown>,
  stateAccount: Record<string, unknown>,
): Record<string, unknown> {
  return { ...account, ...stateAccount }
}

function mergeConfigAndState(
  configValue: unknown,
  stateValue: unknown,
): unknown {
  if (!isRecord(configValue)) return configValue
  const state = isRecord(stateValue) ? stateValue : {}
  const mainState = isRecord(state.main) ? state.main : undefined
  const stateAccounts = isRecord(state.accounts) ? state.accounts : {}

  const quotaConfig = isRecord(configValue.quota) ? configValue.quota : {}
  const refreshConfig = isRecord(configValue.refresh) ? configValue.refresh : {}
  const mainQuotaSource = mainState ?? quotaConfig

  const accounts = Array.isArray(configValue.accounts)
    ? configValue.accounts.map((account) => {
        if (!isRecord(account)) return account
        const stateAccount: Record<string, unknown> =
          typeof account.id === 'string' && isRecord(stateAccounts[account.id])
            ? (stateAccounts[account.id] as Record<string, unknown>)
            : {}
        return mergeConfigAccountAndState(account, stateAccount)
      })
    : []

  return {
    ...configValue,
    main: {
      type: 'opencode',
      provider: 'anthropic',
      profile: normalizeOAuthAccountProfile(mainState?.profile),
    },
    refresh: objectWithDefinedEntries({
      enabled: refreshConfig.enabled,
      intervalMinutes: refreshConfig.intervalMinutes,
      refreshBeforeExpiryMinutes: refreshConfig.refreshBeforeExpiryMinutes,
    }),
    quota: objectWithDefinedEntries({
      ...quotaConfig,
      mainQuota: mainQuotaSource.quota,
      mainQuotaCheckedAt: mainQuotaSource.quotaCheckedAt,
      mainQuotaToken: mainQuotaSource.quotaToken,
      mainLastQuotaApiError: mainQuotaSource.lastQuotaApiError,
    }),
    // Carry the main-side prime counters from the state file back into the
    // merged storage so a subsequent read sees the cumulative counters. The
    // `enabled` flag stays sourced from the config side; main-side counters
    // live exclusively on the state file.
    prime: (() => {
      const configPrime = isRecord(configValue.prime)
        ? configValue.prime
        : undefined
      const mainCounters = normalizePrimeUsageCounters(mainState?.prime)
      const mainAuthLineageId =
        typeof mainState?.primeAuthLineageId === 'string' &&
        mainState.primeAuthLineageId.trim()
          ? mainState.primeAuthLineageId
          : undefined
      const mainAuthLineageRefreshTokenFingerprint =
        typeof mainState?.primeAuthLineageRefreshTokenFingerprint ===
          'string' && mainState.primeAuthLineageRefreshTokenFingerprint.trim()
          ? mainState.primeAuthLineageRefreshTokenFingerprint
          : undefined
      const mainAuthLineagePreviousRefreshTokenFingerprint =
        typeof mainState?.primeAuthLineagePreviousRefreshTokenFingerprint ===
          'string' &&
        mainState.primeAuthLineagePreviousRefreshTokenFingerprint.trim()
          ? mainState.primeAuthLineagePreviousRefreshTokenFingerprint
          : undefined
      if (
        !configPrime &&
        !mainCounters &&
        !mainAuthLineageId &&
        !mainAuthLineageRefreshTokenFingerprint
      )
        return undefined
      return {
        ...(configPrime &&
          typeof configPrime.enabled === 'boolean' && {
            enabled: configPrime.enabled,
          }),
        ...(mainCounters && { main: mainCounters }),
        ...(mainAuthLineageId && { mainAuthLineageId }),
        ...(mainAuthLineageRefreshTokenFingerprint && {
          mainAuthLineageRefreshTokenFingerprint,
        }),
        ...(mainAuthLineagePreviousRefreshTokenFingerprint && {
          mainAuthLineagePreviousRefreshTokenFingerprint,
        }),
      }
    })(),
    accounts,
  }
}

export function loadAccounts(path = getAccountStoragePath()) {
  return loadAccountsWith(path, () => migrateLegacyHostTokens(path))
}

/** {@link loadAccounts} for callers already holding both write locks. */
function loadAccountsLocked(path: string) {
  return loadAccountsWith(path, () => migrateLegacyHostTokensLocked(path))
}

async function loadAccountsWith(
  path: string,
  migrate: () => Promise<unknown>,
): Promise<AccountStorage | null> {
  let config = await readJsonIfPresent(path)
  let state = await readJsonIfPresent(getAccountStatePath(path))
  // Runtime-only flows write the state file but never the config file, so the
  // store is absent only when neither exists. Synthesize an empty config to
  // merge state into otherwise.
  if (!config.exists && !state.exists) return null
  if (
    hostFileCarriesTokens(config.value) ||
    hostFileCarriesTokens(state.value)
  ) {
    await migrate()
    config = await readJsonIfPresent(path)
    state = await readJsonIfPresent(getAccountStatePath(path))
  }
  const configValue = config.exists ? config.value : createEmptyStorage()
  return normalizeStorage(mergeConfigAndState(configValue, state.value))
}

// ---------------------------------------------------------------------------
// One-time migration of host-held OAuth tokens into the shared store
// ---------------------------------------------------------------------------

/**
 * `${statePath}#${accountId}` for entries whose import failed transiently.
 * Their tokens stay on disk until a later load retries; every other token is
 * scrubbed on the next write.
 */
const pendingTokenImports = new Set<string>()

/** Earliest next attempt per state file after a failed import. */
const tokenImportRetryAt = new Map<string, number>()
const TOKEN_IMPORT_RETRY_MS = 60_000

function entryCarriesToken(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    ((typeof value.refresh === 'string' && value.refresh.trim() !== '') ||
      (typeof value.access === 'string' && value.access.trim() !== ''))
  )
}

/** Whether a host config (`accounts: []`) or state (`accounts: {}`) holds tokens. */
function hostFileCarriesTokens(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (Array.isArray(value.accounts)) {
    return value.accounts.some(entryCarriesToken)
  }
  if (!isRecord(value.accounts)) return false
  return Object.values(value.accounts).some(entryCarriesToken)
}

export type LegacyTokenMigrationEntry = {
  hostId: string
  status: 'added' | 'already_present' | 'kept' | 'invalid' | 'orphan' | 'retry'
  accountId?: string
}

/**
 * Older versions kept a copy of every fallback account's access and refresh
 * token in the host files (`anthropic-auth-state.json`, and before that
 * `anthropic-auth.json`). Move each one into the shared store once via
 * `importOAuthAccount` — when the store already holds the login its copy wins
 * — then rewrite the host files without tokens. Host account ids are
 * rewritten to the store row that now holds the login.
 *
 * A token the store rejects as malformed cannot be used by anything any more
 * (refresh lives in the store) and is dropped. A transient failure leaves the
 * entry in place for the next load. State entries for accounts the config no
 * longer lists are scrubbed without import, so a removed account is not
 * resurrected.
 */
export function migrateLegacyHostTokens(
  path = getAccountStoragePath(),
): Promise<LegacyTokenMigrationEntry[]> {
  const retryAt = tokenImportRetryAt.get(getAccountStatePath(path))
  if (retryAt && retryAt > Date.now()) return Promise.resolve([])
  return enqueueSave(async () => {
    const configLock = await acquireAccountConfigWriteLock(path)
    try {
      const stateLock = await acquireAccountStateWriteLock(path)
      try {
        return await migrateLegacyHostTokensLocked(path)
      } finally {
        await stateLock.release()
      }
    } finally {
      await configLock.release()
    }
  })
}

async function migrateLegacyHostTokensLocked(
  path: string,
): Promise<LegacyTokenMigrationEntry[]> {
  const statePath = getAccountStatePath(path)
  const config = await readJsonIfPresent(path)
  const state = await readJsonIfPresent(statePath)
  const configValue = isRecord(config.value) ? { ...config.value } : undefined
  const stateValue = isRecord(state.value) ? { ...state.value } : undefined
  const configAccounts: Record<string, unknown>[] = Array.isArray(
    configValue?.accounts,
  )
    ? configValue.accounts.filter(isRecord).map((entry) => ({ ...entry }))
    : []
  const stateAccounts: Record<string, Record<string, unknown>> = {}
  if (stateValue && isRecord(stateValue.accounts)) {
    for (const [id, entry] of Object.entries(stateValue.accounts)) {
      if (isRecord(entry)) stateAccounts[id] = { ...entry }
    }
  }

  const results: LegacyTokenMigrationEntry[] = []
  const renames = new Map<string, string>()
  // Host ids of store-backed accounts were materialized from store ids, so a
  // store row with the same id is this login already: the store's copy wins
  // and the (possibly spent) host copy is never presented to the store.
  let storeIds: Set<string>
  try {
    storeIds = new Set((await listSharedAccounts()).map((row) => row.id))
  } catch (error) {
    logger.warn('accounts.migration', 'store unreadable; import deferred', {
      path,
      error: error instanceof Error ? error.message : String(error),
    })
    tokenImportRetryAt.set(statePath, Date.now() + TOKEN_IMPORT_RETRY_MS)
    return []
  }
  const configIds = new Set(
    configAccounts
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === 'string'),
  )

  for (const entry of configAccounts) {
    const hostId = typeof entry.id === 'string' ? entry.id : undefined
    if (!hostId || entry.type !== 'oauth') continue
    const stateEntry = stateAccounts[hostId]
    // The state file is the runtime copy; the config copy predates it.
    const source = entryCarriesToken(stateEntry)
      ? stateEntry
      : entryCarriesToken(entry)
        ? entry
        : undefined
    if (!source) continue
    const refresh =
      typeof source.refresh === 'string' ? source.refresh.trim() : ''
    const access = typeof source.access === 'string' ? source.access.trim() : ''
    let outcome: LegacyTokenMigrationEntry
    if (storeIds.has(hostId)) {
      pendingTokenImports.delete(`${statePath}#${hostId}`)
      results.push({ hostId, status: 'kept', accountId: hostId })
      continue
    }
    try {
      const imported = await importHostOAuthCredential({
        label:
          typeof entry.label === 'string' && entry.label.trim()
            ? entry.label.trim()
            : hostId,
        accessToken: access,
        refreshToken: refresh,
        expiresAt:
          typeof source.expires === 'number' && Number.isFinite(source.expires)
            ? source.expires
            : 0,
        ...(typeof source.refreshExpires === 'number' &&
        Number.isFinite(source.refreshExpires)
          ? { refreshExpiresAt: source.refreshExpires }
          : {}),
      })
      outcome =
        imported.status === 'invalid'
          ? { hostId, status: 'invalid' }
          : { hostId, status: imported.status, accountId: imported.accountId }
    } catch (error) {
      logger.warn('accounts.migration', 'token import deferred', {
        hostId,
        error: error instanceof Error ? error.message : String(error),
      })
      pendingTokenImports.add(`${statePath}#${hostId}`)
      tokenImportRetryAt.set(statePath, Date.now() + TOKEN_IMPORT_RETRY_MS)
      results.push({ hostId, status: 'retry' })
      continue
    }
    pendingTokenImports.delete(`${statePath}#${hostId}`)
    results.push(outcome)
    if (outcome.accountId && outcome.accountId !== hostId) {
      renames.set(hostId, outcome.accountId)
    }
  }

  for (const [id, entry] of Object.entries(stateAccounts)) {
    if (!configIds.has(id) && entryCarriesToken(entry)) {
      results.push({ hostId: id, status: 'orphan' })
    }
  }

  // Rewrite: no tokens anywhere, host ids follow the store row.
  const seen = new Set<string>()
  const nextConfigAccounts: Record<string, unknown>[] = []
  for (const entry of configAccounts) {
    const hostId = typeof entry.id === 'string' ? entry.id : undefined
    const pending = hostId && pendingTokenImports.has(`${statePath}#${hostId}`)
    const nextId = (hostId && renames.get(hostId)) ?? hostId
    if (nextId && seen.has(nextId)) continue
    if (nextId) seen.add(nextId)
    const next = pending ? { ...entry } : stripLegacyTokenFields(entry)
    if (nextId) next.id = nextId
    nextConfigAccounts.push(next)
  }
  const nextStateAccounts: Record<string, unknown> = {}
  for (const [id, entry] of Object.entries(stateAccounts)) {
    const pending = pendingTokenImports.has(`${statePath}#${id}`)
    const nextId = renames.get(id) ?? id
    if (nextStateAccounts[nextId] !== undefined) continue
    nextStateAccounts[nextId] = pending ? entry : stripLegacyTokenFields(entry)
  }

  if (configValue && config.exists) {
    await writeJsonAtomic(path, {
      ...configValue,
      accounts: nextConfigAccounts,
    })
  }
  if (stateValue && state.exists) {
    await writeJsonAtomic(
      statePath,
      pruneUndefined({ ...stateValue, accounts: nextStateAccounts }),
    )
  }
  if (results.length) {
    logger.info('accounts.migration', 'host tokens moved into the store', {
      path,
      results: results.map((result) => ({
        hostId: result.hostId,
        status: result.status,
        accountId: result.accountId,
      })),
    })
  }
  return results
}

async function loadExistingTopLevelFields(path: string) {
  const existing = await readJsonIfPresent(path)
  return isRecord(existing.value) ? existing.value : {}
}

function omitUndefinedTopLevel(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  )
}

function accountConfig(account: FallbackAccount) {
  return objectWithDefinedEntries({
    id: account.id,
    label: account.label,
    type: account.type,
    enabled: account.enabled,
    addedAt: account.addedAt,
    baseURL: account.type === 'api' ? account.baseURL : undefined,
    authHeader: account.type === 'api' ? account.authHeader : undefined,
  })
}

function accountRuntimeState(account: FallbackAccount) {
  if (account.type === 'api') {
    return objectWithDefinedEntries({
      apiKey: account.apiKey,
      lastUsed: account.lastUsed,
    })
  }
  return objectWithDefinedEntries({
    authLineageId: account.authLineageId,
    lastUsed: account.lastUsed,
    lastQuotaRefreshError: account.lastQuotaRefreshError,
    quota: account.quota,
    profile: account.profile,
    prime: account.prime,
  })
}

/** Returns the latest timestamp carried by any quota snapshot window. */
export function quotaSnapshotCheckedAt(quota: OAuthQuotaSnapshot | undefined) {
  return Math.max(
    quota?.five_hour?.checkedAt ?? 0,
    quota?.seven_day?.checkedAt ?? 0,
    ...(quota?.scoped?.map((window) => window.checkedAt) ?? []),
    quota?.checkedAt ?? 0,
  )
}

function quotaSourcePrecedence(quota: OAuthQuotaSnapshot | undefined) {
  if (quota?.source === 'poll') return 2
  if (quota?.source === 'headers') return 1
  return 0
}

function mergeHeaderScopedQuota(
  existing: OAuthQuotaSnapshot,
  incoming: OAuthQuotaSnapshot,
) {
  if (!('scoped' in existing)) return incoming.scoped
  if (!Array.isArray(existing.scoped) || existing.scoped.length === 0) {
    return existing.scoped
  }
  if (!Array.isArray(incoming.scoped) || incoming.scoped.length === 0) {
    return existing.scoped
  }
  const merged = new Map(incoming.scoped.map((window) => [window.id, window]))
  for (const window of existing.scoped) {
    const candidate = merged.get(window.id)
    if (!candidate || window.checkedAt >= candidate.checkedAt) {
      merged.set(window.id, window)
    }
  }
  return [...merged.values()]
}

function mergeHeaderOwnedWindow(
  existingSnapshot: OAuthQuotaSnapshot,
  incomingSnapshot: OAuthQuotaSnapshot,
  key: QuotaWindowName,
) {
  const existing = existingSnapshot[key]
  const incoming = incomingSnapshot[key]
  if (!incoming) return existing
  if (!existing) return incoming
  if (incoming.checkedAt > existing.checkedAt) return incoming
  if (incoming.checkedAt < existing.checkedAt) return existing
  return quotaSourcePrecedence(existingSnapshot) >
    quotaSourcePrecedence(incomingSnapshot)
    ? existing
    : incoming
}

function mergeHeaderQuotaForPersistence(
  existing: OAuthQuotaSnapshot | undefined,
  incoming: OAuthQuotaSnapshot,
) {
  if (!existing || incoming.source !== 'headers') return incoming
  const preservePollBinding = existing.bindingWindowSource === 'poll'
  return {
    ...existing,
    ...incoming,
    five_hour: mergeHeaderOwnedWindow(existing, incoming, 'five_hour'),
    seven_day: mergeHeaderOwnedWindow(existing, incoming, 'seven_day'),
    scoped: mergeHeaderScopedQuota(existing, incoming),
    extraUsage: existing.extraUsage ?? incoming.extraUsage,
    bindingWindow: preservePollBinding
      ? existing.bindingWindow
      : (incoming.bindingWindow ?? existing.bindingWindow),
    bindingWindowSource: preservePollBinding
      ? 'poll'
      : (incoming.bindingWindowSource ?? existing.bindingWindowSource),
  } satisfies OAuthQuotaSnapshot
}

function mergeAccountRuntimeState(
  existing: unknown,
  incoming: AccountRuntimeEntry,
): AccountRuntimeEntry {
  if (!isRecord(existing)) return incoming
  const existingEntry = stripLegacyTokenFields(existing) as AccountRuntimeEntry
  const mergesHeaderQuota = incoming.quota?.source === 'headers'
  const effectiveIncoming =
    mergesHeaderQuota && incoming.quota
      ? {
          ...incoming,
          quota: mergeHeaderQuotaForPersistence(
            existingEntry.quota,
            incoming.quota,
          ),
        }
      : incoming
  const existingQuotaCheckedAt = quotaSnapshotCheckedAt(existingEntry.quota)
  const incomingQuotaCheckedAt = quotaSnapshotCheckedAt(effectiveIncoming.quota)
  const existingQuotaWinsEqualTimestamp = Boolean(
    existingQuotaCheckedAt === incomingQuotaCheckedAt &&
      quotaSourcePrecedence(existingEntry.quota) >
        quotaSourcePrecedence(effectiveIncoming.quota),
  )

  if (
    !mergesHeaderQuota &&
    (existingQuotaCheckedAt > incomingQuotaCheckedAt ||
      existingQuotaWinsEqualTimestamp)
  ) {
    // A newer reading already on disk (another process) wins over this
    // snapshot's older one.
    return {
      ...existingEntry,
      ...effectiveIncoming,
      quota: existingEntry.quota,
      lastQuotaRefreshError: existingEntry.lastQuotaRefreshError,
    }
  }
  const merged: AccountRuntimeEntry = {
    ...existingEntry,
    ...effectiveIncoming,
  }
  if (!('lastQuotaRefreshError' in effectiveIncoming)) {
    delete merged.lastQuotaRefreshError
  }
  return merged
}

/** A copy of a persisted account entry without any token-era field. */
function stripLegacyTokenFields(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const copy = { ...value }
  for (const field of LEGACY_TOKEN_FIELDS) delete copy[field]
  return copy
}

function configFromStorage(storage: AccountStorage): Record<string, unknown> {
  const refresh = storage.refresh
    ? objectWithDefinedEntries({
        enabled: storage.refresh.enabled,
        intervalMinutes: storage.refresh.intervalMinutes,
        refreshBeforeExpiryMinutes: storage.refresh.refreshBeforeExpiryMinutes,
      })
    : undefined
  const quota = storage.quota
    ? objectWithDefinedEntries({
        enabled: storage.quota.enabled,
        checkIntervalMinutes: storage.quota.checkIntervalMinutes,
        refreshEveryNRequests: storage.quota.refreshEveryNRequests,
        minimumRemaining: storage.quota.minimumRemaining,
        failClosedOnUnknownQuota: storage.quota.failClosedOnUnknownQuota,
        showToasts: storage.quota.showToasts,
      })
    : undefined

  return omitUndefinedTopLevel({
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    routing: storage.routing,
    fallbackOn: storage.fallbackOn,
    refresh,
    quota,
    claudeCache: storage.claudeCache,
    dump: storage.dump,
    logging: storage.logging,
    claudeFast: storage.claudeFast,
    costZeroing: storage.costZeroing,
    cacheKeep: storage.cacheKeep,
    relay: storage.relay,
    killswitch: storage.killswitch,
    prime: (() => {
      // Config side carries ONLY the `enabled` flag — runtime counters and
      // lineage bindings stay on the state file. Write `enabled` whenever it was explicitly set so a
      // toggle off persists `{ enabled: false }` and is visible to a stale
      // reader that only inspects the config.
      if (typeof storage.prime?.enabled !== 'boolean') return undefined
      return { enabled: storage.prime.enabled }
    })(),
    accounts: storage.accounts.map(accountConfig),
  })
}

// ---------------------------------------------------------------------------
// In-process save mutex — serializes all account-store writes so concurrent
// read-modify-write callers (background timers that call saveAccountState with
// different section flags) don't lose each other's updates (#9).
// ---------------------------------------------------------------------------
let saveChain: Promise<void> = Promise.resolve()

function enqueueSave<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    saveChain = saveChain.then(
      () => fn().then(resolve, reject),
      () => fn().then(resolve, reject),
    )
  })
}

async function writeJsonAtomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  try {
    await rename(tempPath, path)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

export interface SaveAccountsOptions {
  /** Account ids intentionally removed by this mutation. */
  removedAccountIds?: readonly string[]
  /** Preserve disk order when a stale snapshot is missing newer accounts. */
  preserveExistingAccountOrder?: boolean
}

function sameAccountIdentity(
  left: FallbackAccount,
  right: FallbackAccount,
): boolean {
  return (
    left.id === right.id ||
    Boolean(left.label && right.label && left.label === right.label)
  )
}

function mergeAccountsForSave(
  existing: readonly FallbackAccount[],
  incoming: readonly FallbackAccount[],
  options: SaveAccountsOptions,
): FallbackAccount[] {
  const removedIds = new Set(options.removedAccountIds ?? [])
  const current = existing.filter((account) => !removedIds.has(account.id))
  const next = incoming.filter((account) => !removedIds.has(account.id))
  const missing = current.filter(
    (account) =>
      !next.some((candidate) => sameAccountIdentity(candidate, account)),
  )
  if (!missing.length) return [...next]
  if (options.preserveExistingAccountOrder === false) {
    return [...next, ...missing]
  }

  const usedIncoming = new Set<number>()
  const merged = current.map((account) => {
    const index = next.findIndex(
      (candidate, candidateIndex) =>
        !usedIncoming.has(candidateIndex) &&
        sameAccountIdentity(candidate, account),
    )
    const candidate = next[index]
    if (!candidate) return account
    usedIncoming.add(index)
    return candidate
  })
  for (let index = 0; index < next.length; index++) {
    const candidate = next[index]
    if (!usedIncoming.has(index) && candidate) merged.push(candidate)
  }
  return merged
}

const ACCOUNT_CONFIG_LOCK_TTL_MS = 10_000
const ACCOUNT_CONFIG_LOCK_WAIT_MS = 12_000
const ACCOUNT_STATE_LOCK_TTL_MS = 10_000
const ACCOUNT_STATE_LOCK_WAIT_MS = 12_000

async function acquireAccountWriteLock(input: {
  path: string
  name: string
  ttlMs: number
  waitMs: number
  description: string
}) {
  const { path, name, ttlMs, waitMs, description } = input
  await mkdir(dirname(path), { recursive: true })
  const deadline = Date.now() + waitMs
  while (true) {
    const lock = await acquireRefreshFileLock({
      name,
      ttlMs,
      path,
      renew: true,
    })
    if (lock) return lock
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for the account ${description} lock`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function acquireAccountConfigWriteLock(path: string) {
  return acquireAccountWriteLock({
    path,
    name: 'config-write',
    ttlMs: ACCOUNT_CONFIG_LOCK_TTL_MS,
    waitMs: ACCOUNT_CONFIG_LOCK_WAIT_MS,
    description: 'configuration write',
  })
}

function acquireAccountStateWriteLock(path: string) {
  return acquireAccountWriteLock({
    path,
    name: 'state-write',
    ttlMs: ACCOUNT_STATE_LOCK_TTL_MS,
    waitMs: ACCOUNT_STATE_LOCK_WAIT_MS,
    description: 'state write',
  })
}

export function saveAccounts(
  storage: AccountStorage,
  path = getAccountStoragePath(),
  options: SaveAccountsOptions = {},
): Promise<void> {
  const resolvedPath = path
  return enqueueSave(() => saveAccountsLocked(storage, resolvedPath, options))
}

async function saveAccountsLocked(
  storage: AccountStorage,
  path: string,
  options: SaveAccountsOptions,
) {
  const lock = await acquireAccountConfigWriteLock(path)
  try {
    // Config precedes state everywhere both locks are needed; reversing this
    // order can deadlock profile mutations against full account saves. Both
    // are held before the read so a pending token migration completes before
    // anything is rewritten without tokens.
    const stateLock = await acquireAccountStateWriteLock(path)
    try {
      const current = await loadAccountsLocked(path)
      const nextStorage: AccountStorage = {
        ...storage,
        accounts: mergeAccountsForSave(
          current?.accounts ?? [],
          storage.accounts,
          options,
        ),
      }
      const existing = await loadExistingTopLevelFields(path)
      const nextConfig = { ...existing, ...configFromStorage(nextStorage) }
      await writeJsonAtomic(path, nextConfig)
      await saveAccountStateUnlocked(nextStorage, path, {
        mainQuota: true,
        accounts: true,
      })
    } finally {
      await stateLock.release()
    }
  } finally {
    await lock.release()
  }
}

function applyMainProfileStatePatch(
  state: AccountRuntimeState,
  storage: AccountStorage,
) {
  state.main = state.main ?? {}
  state.main.profile = storage.main?.profile
}

function applyMainQuotaStatePatch(
  state: AccountRuntimeState,
  storage: AccountStorage,
) {
  state.main = state.main ?? {}
  const incomingQuota = storage.quota?.mainQuota
  const sameToken = Boolean(
    state.main.quotaToken &&
      storage.quota?.mainQuotaToken &&
      state.main.quotaToken === storage.quota.mainQuotaToken,
  )
  const effectiveIncomingQuota =
    sameToken && incomingQuota?.source === 'headers'
      ? mergeHeaderQuotaForPersistence(state.main.quota, incomingQuota)
      : incomingQuota
  const mergesHeaderQuota = Boolean(
    sameToken && incomingQuota?.source === 'headers',
  )
  const existingCheckedAt =
    typeof state.main.quotaCheckedAt === 'number'
      ? state.main.quotaCheckedAt
      : quotaSnapshotCheckedAt(state.main.quota)
  const incomingCheckedAt =
    typeof storage.quota?.mainQuotaCheckedAt === 'number'
      ? storage.quota.mainQuotaCheckedAt
      : quotaSnapshotCheckedAt(effectiveIncomingQuota)
  if (
    !mergesHeaderQuota &&
    (existingCheckedAt > incomingCheckedAt ||
      (existingCheckedAt === incomingCheckedAt &&
        quotaSourcePrecedence(state.main.quota) >
          quotaSourcePrecedence(effectiveIncomingQuota)))
  ) {
    return
  }

  state.main.quota = effectiveIncomingQuota
  state.main.quotaCheckedAt = mergesHeaderQuota
    ? Math.max(existingCheckedAt, incomingCheckedAt)
    : storage.quota?.mainQuotaCheckedAt
  state.main.quotaToken = storage.quota?.mainQuotaToken
  state.main.lastQuotaApiError = storage.quota?.mainLastQuotaApiError
}

function applyMainPrimeStatePatch(
  state: AccountRuntimeState,
  storage: AccountStorage,
) {
  const incoming = storage.prime?.main
  const incomingAuthLineageId = storage.prime?.mainAuthLineageId
  const incomingAuthLineageRefreshTokenFingerprint =
    storage.prime?.mainAuthLineageRefreshTokenFingerprint
  const incomingAuthLineagePreviousRefreshTokenFingerprint =
    storage.prime?.mainAuthLineagePreviousRefreshTokenFingerprint
  if (
    !incoming &&
    !incomingAuthLineageId &&
    !incomingAuthLineageRefreshTokenFingerprint &&
    !incomingAuthLineagePreviousRefreshTokenFingerprint
  )
    return
  state.main = state.main ?? {}
  // Last-writer-wins on prime counters — the only writer is the prime manager
  // itself, monotonically accumulating per success, so there is no race for an
  // older write to overwrite a newer one within this process. Across processes
  // the cross-process claim marker (#1247) keeps the fire exclusive.
  if (incoming) state.main.prime = incoming
  if (incomingAuthLineageId) {
    state.main.primeAuthLineageId = incomingAuthLineageId
  }
  if (incomingAuthLineageRefreshTokenFingerprint) {
    state.main.primeAuthLineageRefreshTokenFingerprint =
      incomingAuthLineageRefreshTokenFingerprint
  }
  if (incomingAuthLineagePreviousRefreshTokenFingerprint) {
    state.main.primeAuthLineagePreviousRefreshTokenFingerprint =
      incomingAuthLineagePreviousRefreshTokenFingerprint
  }
}

function pruneUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneUndefined)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, pruneUndefined(entry)]),
  )
}

export function saveAccountState(
  storage: AccountStorage,
  path = getAccountStoragePath(),
  scope: AccountStateSaveScope = {
    mainProfile: true,
    mainQuota: true,
    accounts: true,
  },
): Promise<void> {
  const resolvedPath = path
  return enqueueSave(async () => {
    const lock = await acquireAccountStateWriteLock(resolvedPath)
    try {
      await saveAccountStateUnlocked(storage, resolvedPath, scope)
    } finally {
      await lock.release()
    }
  })
}

export function saveOAuthProfileState(
  input: {
    accountId: 'main' | string
    profile: OAuthAccountProfile | undefined
    expectedTokenFingerprint: string
  },
  path = getAccountStoragePath(),
): Promise<boolean> {
  const resolvedPath = path
  return enqueueSave(async () => {
    const configLock = await acquireAccountConfigWriteLock(resolvedPath)
    try {
      const stateLock = await acquireAccountStateWriteLock(resolvedPath)
      try {
        const current = await loadAccountsLocked(resolvedPath)
        const statePath = getAccountStatePath(resolvedPath)
        const existing = (await readJsonIfPresent(statePath)).value
        const next: AccountRuntimeState = isRecord(existing)
          ? ({ ...existing, version: 1 } as AccountRuntimeState)
          : { version: 1 }
        const { accountId, expectedTokenFingerprint, profile } = input
        if (
          profile?.tokenFingerprint &&
          profile.tokenFingerprint !== expectedTokenFingerprint
        ) {
          return false
        }

        if (accountId === 'main') {
          next.main = { ...(next.main ?? {}) }
          const existingProfile = normalizeOAuthAccountProfile(
            next.main.profile,
          )
          const persistedToken =
            next.main.profileToken ?? existingProfile?.tokenFingerprint
          if (
            !profile &&
            existingProfile &&
            persistedToken === expectedTokenFingerprint
          ) {
            return false
          }
          if (profile) {
            if (persistedToken && persistedToken !== expectedTokenFingerprint) {
              return false
            }
            if (
              existingProfile &&
              existingProfile.checkedAt > profile.checkedAt
            ) {
              return false
            }
          }
          next.main.profile = profile
          next.main.profileToken = expectedTokenFingerprint
        } else {
          // The access token is not persisted (the store owns it), so the
          // profile is bound by the fingerprint the caller observed; readers
          // compare it with the token they hold.
          const account = current?.accounts.find(
            (candidate): candidate is OAuthAccount =>
              candidate.id === accountId && isOAuthAccount(candidate),
          )
          if (!account) return false
          next.accounts = {
            ...(isRecord(next.accounts) ? next.accounts : {}),
          }
          const existingEntry = isRecord(next.accounts[accountId])
            ? { ...next.accounts[accountId] }
            : {}
          const existingProfile = normalizeOAuthAccountProfile(
            existingEntry.profile,
          )
          if (
            !profile &&
            existingProfile?.tokenFingerprint === expectedTokenFingerprint
          ) {
            return false
          }
          if (
            profile &&
            existingProfile &&
            existingProfile.checkedAt > profile.checkedAt
          ) {
            return false
          }
          existingEntry.profile = profile
          next.accounts[accountId] = existingEntry
        }

        await writeJsonAtomic(statePath, pruneUndefined(next))
        return true
      } finally {
        await stateLock.release()
      }
    } finally {
      await configLock.release()
    }
  })
}

async function saveAccountStateUnlocked(
  storage: AccountStorage,
  path: string,
  scope: AccountStateSaveScope,
) {
  const statePath = getAccountStatePath(path)
  const existing = (await readJsonIfPresent(statePath)).value
  const next: AccountRuntimeState = isRecord(existing)
    ? ({ ...existing, version: 1 } as AccountRuntimeState)
    : { version: 1 }

  if (scope.mainProfile) applyMainProfileStatePatch(next, storage)
  if (scope.mainQuota) applyMainQuotaStatePatch(next, storage)
  if (scope.mainPrime) applyMainPrimeStatePatch(next, storage)

  if (scope.accounts) {
    const ids = scope.accounts === true ? null : new Set(scope.accounts)
    next.accounts = { ...(isRecord(next.accounts) ? next.accounts : {}) }
    for (const account of storage.accounts) {
      if (ids && !ids.has(account.id)) continue
      next.accounts[account.id] = mergeAccountRuntimeState(
        next.accounts[account.id],
        accountRuntimeState(account),
      )
    }
    if (ids) {
      for (const id of ids) {
        if (!storage.accounts.some((account) => account.id === id)) {
          delete next.accounts[id]
        }
      }
    } else {
      // Full save: drop any per-account state whose id is no longer present in
      // storage.accounts. The scoped path above only prunes ids it was asked to
      // save; on a removal the storage is saved with scope.accounts === true
      // (ids === null), so without this branch the removed account's runtime
      // state (quota/lastRefreshError/access/refresh/expires) would be orphaned
      // in the state file and later merged onto a re-added same-id account.
      const present = new Set(storage.accounts.map((account) => account.id))
      for (const id of Object.keys(next.accounts)) {
        if (!present.has(id)) delete next.accounts[id]
      }
    }
  }

  scrubLegacyTokens(next, statePath)
  await writeJsonAtomic(statePath, pruneUndefined(next))
}

/**
 * Remove every token-era field from a state object about to be written, so
 * no write carries an OAuth token. An entry whose one-time import into the
 * store failed transiently keeps its tokens until a later load retries it
 * (see {@link migrateLegacyHostTokens}); dropping them then would lose a
 * login the store has never seen.
 */
function scrubLegacyTokens(state: AccountRuntimeState, statePath: string) {
  const main = state.main as Record<string, unknown> | undefined
  if (main) {
    for (const field of [
      'lastRefreshError',
      'refreshLeaseId',
      'refreshLeaseUntil',
      'refreshLeaseTokenHash',
    ]) {
      delete main[field]
    }
  }
  if (!isRecord(state.accounts)) return
  for (const [id, entry] of Object.entries(state.accounts)) {
    if (!isRecord(entry)) continue
    if (pendingTokenImports.has(`${statePath}#${id}`)) continue
    state.accounts[id] = stripLegacyTokenFields(entry) as AccountRuntimeEntry
  }
}

export async function acquireRefreshFileLock(options: {
  name: string
  ttlMs: number
  path?: string
  now?: () => number
  renew?: boolean
  renewIntervalMs?: number
  onStep?: (
    step:
      | 'stale-marker-stat'
      | 'stale-marker-claimed'
      | 'stale-lock-confirmed'
      | 'eviction-marker-acquired',
  ) => void | Promise<void>
}): Promise<{ release: () => Promise<void> } | null> {
  const accountPath = options.path ?? getAccountStoragePath()
  const lockPath = `${accountPath}.${options.name}.lock`
  const legacyOwnerPath = join(lockPath, 'owner.json')
  const ownerId = randomUUID()
  const now = options.now ?? Date.now
  let renewTimer: ReturnType<typeof setTimeout> | null = null
  let released = false

  async function readOwner() {
    try {
      return JSON.parse(await readFile(lockPath, 'utf8'))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EISDIR') throw error
      return JSON.parse(await readFile(legacyOwnerPath, 'utf8'))
    }
  }

  async function writeOwner() {
    await writeFile(
      lockPath,
      `${JSON.stringify({ ownerId, expiresAt: now() + options.ttlMs })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
  }

  async function tryAcquire() {
    try {
      await writeFile(
        lockPath,
        `${JSON.stringify({ ownerId, expiresAt: now() + options.ttlMs })}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      )
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST' || code === 'EISDIR') return false
      throw error
    }
  }

  function scheduleRenewal() {
    if (!options.renew || released) return
    const intervalMs =
      options.renewIntervalMs ?? Math.max(1_000, Math.floor(options.ttlMs / 3))
    renewTimer = setRefreshLockRenewalTimeout(() => {
      void (async () => {
        try {
          const owner = await readOwner()
          const currentNow = now()
          if (
            released ||
            owner?.ownerId !== ownerId ||
            Number(owner?.expiresAt) <= currentNow
          ) {
            return
          }
          await writeOwner()
          scheduleRenewal()
        } catch {
          // If renewal fails, contenders will wait until the last written expiry.
        }
      })()
    }, intervalMs)
    if ('unref' in renewTimer) renewTimer.unref()
  }

  let acquired = await tryAcquire()
  if (!acquired) {
    const evictPath = `${lockPath}.evicting`
    const evictOwnerPath = join(evictPath, 'owner.json')
    const evictOwnerId = randomUUID()
    const EVICT_TTL = 5_000
    const MAX_STEAL_ATTEMPTS = 8

    async function backoff() {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.floor(Math.random() * 4)),
      )
    }

    async function lockIsLive() {
      try {
        const currentOwner = await readOwner()
        return Number(currentOwner?.expiresAt) > now()
      } catch {
        try {
          const current = await stat(lockPath)
          return current.mtimeMs + options.ttlMs > now()
        } catch {
          // Lock doesn't exist — safe to acquire.
          return false
        }
      }
    }

    async function ownsEvictionMarker() {
      try {
        const owner = JSON.parse(await readFile(evictOwnerPath, 'utf8'))
        return owner?.ownerId === evictOwnerId
      } catch {
        return false
      }
    }

    async function tryAcquireEvictionMarker() {
      await mkdir(evictPath)
      try {
        await writeFile(
          evictOwnerPath,
          `${JSON.stringify({ ownerId: evictOwnerId, createdAt: now() })}\n`,
          { encoding: 'utf8', mode: 0o600, flag: 'wx' },
        )
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        // Another contender can rename the marker directory between mkdir and
        // this exclusive create. Darwin/Bun reports that lost-parent race as
        // either ENOENT or EINVAL; both mean this contender lost the marker.
        if (code === 'ENOENT' || code === 'EINVAL') return false
        await releaseEvictionMarker()
        throw error
      }
      await options.onStep?.('eviction-marker-acquired')
      return true
    }

    async function releaseEvictionMarker() {
      if (await ownsEvictionMarker()) {
        await rm(evictPath, { recursive: true, force: true }).catch(() => {})
      }
    }

    for (let attempt = 0; attempt < MAX_STEAL_ATTEMPTS; attempt++) {
      // After the first failed create, all stale-lock work is serialized by the
      // eviction marker. Retrying the real lock before owning that marker lets
      // a contender enter the remove/rename gap and later be mistaken for the
      // stale owner.
      try {
        if (!(await tryAcquireEvictionMarker())) {
          await backoff()
          continue
        }
      } catch (evictError) {
        const code = (evictError as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') throw evictError

        let evictStat: Awaited<ReturnType<typeof stat>>
        try {
          evictStat = await stat(evictPath)
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') {
            await backoff()
            continue
          }
          throw statError
        }
        if (evictStat.mtimeMs + EVICT_TTL > now()) return null

        await options.onStep?.('stale-marker-stat')
        const claimedPath = `${evictPath}.${randomUUID()}`
        try {
          await rename(evictPath, claimedPath)
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') {
            await backoff()
            continue
          }
          throw renameError
        }
        await options.onStep?.('stale-marker-claimed')
        await rm(claimedPath, { recursive: true, force: true }).catch(() => {})
        await backoff()
        continue
      }

      try {
        acquired = await tryAcquire()
        if (acquired) break
        if (await lockIsLive()) return null
        if (!(await ownsEvictionMarker())) return null
        await options.onStep?.('stale-lock-confirmed')
        if (!(await ownsEvictionMarker())) return null
        // Atomically move the exact stale lock out of the acquisition path.
        // A plain rm creates a gap where an unmarked contender can acquire and
        // then be deleted by this stale owner, allowing two callers to return
        // as winners. After rename, any contender may win the now-empty path;
        // this marker owner simply returns null when its own create loses.
        const staleLockPath = `${lockPath}.stale-${evictOwnerId}`
        try {
          await rename(lockPath, staleLockPath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          return null
        }
        await rm(staleLockPath, { recursive: true, force: true }).catch(
          () => {},
        )
        if (!(await ownsEvictionMarker())) return null
        acquired = await tryAcquire()
        if (!acquired) return null
        if (!(await ownsEvictionMarker())) {
          await rm(lockPath, { recursive: true, force: true }).catch(() => {})
          acquired = false
          return null
        }
        break
      } finally {
        await releaseEvictionMarker()
      }
    }
  }

  if (!acquired) return null

  scheduleRenewal()

  return {
    release: async () => {
      released = true
      if (renewTimer) {
        clearRefreshLockRenewalTimeout(renewTimer)
        renewTimer = null
      }
      try {
        const owner = await readOwner()
        if (owner?.ownerId !== ownerId) return
      } catch {
        return
      }
      await rm(lockPath, { recursive: true, force: true }).catch(() => {})
    },
  }
}

export function isCache1hPersistentlyEnabled(storage: AccountStorage | null) {
  return storage?.claudeCache?.enabled === true
}

function normalizeCache1hMode(value: unknown): Cache1hMode {
  return typeof value === 'string' &&
    CACHE_1H_MODES.includes(value as Cache1hMode)
    ? (value as Cache1hMode)
    : DEFAULT_CACHE_1H_MODE
}

export function getCache1hPersistentMode(
  storage: AccountStorage | null,
): Cache1hMode {
  return normalizeCache1hMode(storage?.claudeCache?.mode)
}

export async function setCache1hPersistentEnabled(
  enabled: boolean,
  mode?: Cache1hMode,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.claudeCache = {
    ...(storage.claudeCache ?? {}),
    enabled,
    mode: mode ?? getCache1hPersistentMode(storage),
  }
  await saveAccounts(storage, path)
  return storage
}

export async function setCache1hPersistentMode(
  mode: Cache1hMode,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.claudeCache = {
    ...(storage.claudeCache ?? {}),
    enabled: storage.claudeCache?.enabled === true,
    mode,
  }
  await saveAccounts(storage, path)
  return storage
}

export function isDumpPersistentlyEnabled(storage: AccountStorage | null) {
  // Dumps are ON by default: request/response capture only turns off when the
  // user explicitly runs `/claude-dump off` (which persists `enabled: false`).
  // An absent flag (never configured) means enabled.
  return storage?.dump?.enabled !== false
}

export async function setDumpPersistentEnabled(
  enabled: boolean,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.dump = {
    ...(storage.dump ?? {}),
    enabled,
  }
  await saveAccounts(storage, path)
  return storage
}

export function isFastModePersistentlyEnabled(storage: AccountStorage | null) {
  return storage?.claudeFast?.enabled === true
}

export async function setFastModePersistentEnabled(
  enabled: boolean,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.claudeFast = {
    ...(storage.claudeFast ?? {}),
    enabled,
  }
  await saveAccounts(storage, path)
  return storage
}

export async function setCacheKeepPersistentWindow(
  startHour: number,
  endHour: number,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.cacheKeep = {
    ...(storage.cacheKeep ?? {}),
    enabled: true,
    always: false,
    startHour,
    endHour,
  }
  await saveAccounts(storage, path)
  return storage
}

export async function setCacheKeepPersistentAlways(
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.cacheKeep = {
    ...(storage.cacheKeep ?? {}),
    enabled: true,
    always: true,
  }
  delete storage.cacheKeep.startHour
  delete storage.cacheKeep.endHour
  await saveAccounts(storage, path)
  return storage
}

export async function setCacheKeepPersistentEnabled(
  enabled: boolean,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.cacheKeep = {
    ...(storage.cacheKeep ?? {}),
    enabled,
  }
  await saveAccounts(storage, path)
  return storage
}

export function isCacheKeepSubagentsEnabled(storage: AccountStorage | null) {
  return storage?.cacheKeep?.subagents === true
}

export async function setCacheKeepSubagentsEnabled(
  enabled: boolean,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.cacheKeep = {
    ...(storage.cacheKeep ?? {}),
    subagents: enabled,
  }
  await saveAccounts(storage, path)
  return storage
}

export function isPrimePersistentlyEnabled(storage: AccountStorage | null) {
  return storage?.prime?.enabled === true
}

export async function setPrimePersistentEnabled(
  enabled: boolean,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.prime = {
    ...(storage.prime ?? {}),
    enabled,
  }
  await saveAccounts(storage, path)
  return storage
}

/**
 * Return the stable prime marker identity for an OAuth account, seeding it in
 * runtime state when older storage has no lineage yet.
 *
 * For `main`, `mainCredentialIdentity` names the credential the host is using
 * now: `store:<accountId>` for a store-backed main (stable across refreshes,
 * which happen in the store), or the static credential itself for one that is
 * not in the store. Only its fingerprint is persisted. A different identity
 * than the bound one is a re-login/replacement and mints a new lineage; the
 * same identity keeps the lineage. Main lookups return undefined when no
 * identity is known and no lineage exists.
 */
export async function getOrCreatePrimeAuthLineageId(
  accountId: 'main' | string,
  path = getAccountStoragePath(),
  mainCredentialIdentity?: string,
): Promise<string | undefined> {
  return enqueueSave(async () => {
    const configLock = await acquireAccountConfigWriteLock(path)
    try {
      const stateLock = await acquireAccountStateWriteLock(path)
      try {
        const storage = (await loadAccountsLocked(path)) ?? createEmptyStorage()
        if (accountId === 'main') {
          const existing = storage.prime?.mainAuthLineageId
          const observedFingerprint = mainCredentialIdentity
            ? tokenFingerprint(mainCredentialIdentity)
            : undefined
          const boundFingerprint =
            storage.prime?.mainAuthLineageRefreshTokenFingerprint
          if (existing) {
            if (
              !observedFingerprint ||
              boundFingerprint === observedFingerprint
            )
              return existing

            if (!boundFingerprint) {
              // Legacy lineages predate credential binding. The first
              // observation attaches the credential without changing markers.
              storage.prime = {
                ...(storage.prime ?? {}),
                mainAuthLineageRefreshTokenFingerprint: observedFingerprint,
              }
              await saveAccountStateUnlocked(storage, path, {
                mainPrime: true,
              })
              return existing
            }
          }

          // Without an identity there is no safe way to bind a new lineage.
          // Skip this tick rather than creating an unbound namespace that
          // could churn or suppress another account.
          if (!observedFingerprint) return undefined

          // A different credential identity is a host credential replacement
          // and needs a fresh marker identity.
          const authLineageId = randomUUID()
          storage.prime = {
            ...(storage.prime ?? {}),
            mainAuthLineageId: authLineageId,
            mainAuthLineageRefreshTokenFingerprint: observedFingerprint,
            ...(boundFingerprint && {
              mainAuthLineagePreviousRefreshTokenFingerprint: boundFingerprint,
            }),
          }
          await saveAccountStateUnlocked(storage, path, { mainPrime: true })
          return authLineageId
        }

        const account = storage.accounts.find(
          (candidate): candidate is OAuthAccount =>
            candidate.id === accountId && isOAuthAccount(candidate),
        )
        if (!account) {
          throw new Error(
            `getOrCreatePrimeAuthLineageId: OAuth account "${accountId}" not found`,
          )
        }
        if (account.authLineageId) return account.authLineageId

        // Upgrading changes the marker namespace once, so an already-primed
        // window may fire again; persisting the seed prevents every later token
        // rotation from repeating that migration cost.
        const authLineageId = randomUUID()
        account.authLineageId = authLineageId
        await saveAccountStateUnlocked(storage, path, {
          accounts: [accountId],
        })
        return authLineageId
      } finally {
        await stateLock.release()
      }
    } finally {
      await configLock.release()
    }
  })
}

/** The prime lineage identity of a store-backed main account. */
export function storeCredentialIdentity(accountId: string) {
  return `store:${accountId}`
}

/**
 * Atomically increment an account's cumulative prime counters and persist via
 * the scoped runtime-state path. The `main` account lives at state.main.prime;
 * every other account lives at state.accounts[id].prime. Config-side writes
 * are intentionally NOT triggered so prime counters cannot leak into
 * `anthropic-auth.json`. Callers should not depend on this function to mutate
 * the caller's storage object.
 */
export async function incrementPrimeUsagePersistent(
  accountId: 'main' | string,
  usage: PrimeUsageDelta,
  path = getAccountStoragePath(),
  now = Date.now(),
): Promise<PrimeUsageCounters> {
  const inputTokens = Number.isFinite(usage?.inputTokens)
    ? Math.max(0, Math.floor(usage.inputTokens as number))
    : 0
  const outputTokens = Number.isFinite(usage?.outputTokens)
    ? Math.max(0, Math.floor(usage.outputTokens as number))
    : 0

  return enqueueSave(async () => {
    // The config-write lock is the repository-wide outer lock for config and
    // runtime-state RMW operations; taking it before the state write preserves
    // saveAccountsLocked's config → state ordering across processes.
    const lock = await acquireAccountConfigWriteLock(path)
    try {
      const stateLock = await acquireAccountStateWriteLock(path)
      try {
        const storage = (await loadAccountsLocked(path)) ?? createEmptyStorage()

        if (accountId === 'main') {
          const existing = storage.prime?.main
          const next: PrimeUsageCounters = {
            count: (existing?.count ?? 0) + 1,
            inputTokens: (existing?.inputTokens ?? 0) + inputTokens,
            outputTokens: (existing?.outputTokens ?? 0) + outputTokens,
            since: existing?.since ?? Math.floor(now),
          }
          storage.prime = { ...(storage.prime ?? {}), main: next }
          await saveAccountStateUnlocked(storage, path, { mainPrime: true })
          return next
        }

        const index = storage.accounts.findIndex(
          (account) => account.id === accountId,
        )
        if (index < 0) {
          throw new Error(
            `incrementPrimeUsagePersistent: account "${accountId}" not found`,
          )
        }
        const account = storage.accounts[index] as OAuthAccount
        const existing = account.prime
        const next: PrimeUsageCounters = {
          count: (existing?.count ?? 0) + 1,
          inputTokens: (existing?.inputTokens ?? 0) + inputTokens,
          outputTokens: (existing?.outputTokens ?? 0) + outputTokens,
          since: existing?.since ?? Math.floor(now),
        }
        storage.accounts[index] = { ...account, prime: next }
        await saveAccountStateUnlocked(storage, path, {
          accounts: [accountId],
        })
        return next
      } finally {
        await stateLock.release()
      }
    } finally {
      await lock.release()
    }
  })
}

function getFallbackStatuses(storage: AccountStorage | null) {
  return storage?.fallbackOn?.length ? storage.fallbackOn : DEFAULT_FALLBACK_ON
}

export function shouldFallbackStatus(
  status: number,
  storage: AccountStorage | null,
) {
  return getFallbackStatuses(storage).includes(status)
}

export function getQuotaMinimumRemainingThresholds(
  storage: AccountStorage | null,
) {
  const configured = storage?.quota?.minimumRemaining || {}
  return {
    five_hour:
      configured.five_hour ??
      configured['5h'] ??
      DEFAULT_MINIMUM_REMAINING.five_hour,
    seven_day:
      configured.seven_day ??
      configured['1w'] ??
      DEFAULT_MINIMUM_REMAINING.seven_day,
  }
}

function quotaEnabled(storage: AccountStorage | null) {
  return storage?.quota?.enabled !== false
}

function keepAliveEnabled(storage: AccountStorage | null) {
  return storage?.refresh?.enabled !== false
}

function jitterMs(maxMs: number) {
  return Math.floor(Math.random() * Math.max(0, maxMs))
}

/** The store keep-alive cadence (`refresh.intervalMinutes`, default 10). */
export function getRefreshIntervalMs(storage: AccountStorage | null) {
  const minutes =
    storage?.refresh?.intervalMinutes ?? DEFAULT_REFRESH_INTERVAL_MINUTES
  return Math.max(1, minutes) * 60_000
}

// Mirrors Claude Code's `M8b`: credential/request failures that retrying can
// never resolve.
const PERMANENT_ERROR_MESSAGES = new Set([
  'OAuth access token has expired. Re-authenticate to continue.',
  'OAuth access token has been revoked.',
  'OAuth access token is invalid.',
  'API key is invalid.',
  'Request exceeds the maximum size',
  'Request not allowed',
])

export function isPermanentProviderError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return PERMANENT_ERROR_MESSAGES.has(error.message.trim())
}

/**
 * The store's refresh verdict for one row as an {@link AccountOperationError}.
 * `refreshDead` means the store holds a refresh token Anthropic rejected with
 * `invalid_grant` (re-login required); `lastError` is reported only while it
 * still describes the row's current token, so a verdict never outlives the
 * token it was about.
 */
export function refreshErrorFromSharedAccount(
  account: Pick<
    SharedAnthropicAccount,
    'refreshDead' | 'lastError' | 'lastRefreshedAt'
  >,
  now = Date.now(),
): AccountOperationError | undefined {
  if (account.refreshDead) {
    return {
      message:
        account.lastError ??
        'invalid_grant: the refresh token is dead; log in again',
      checkedAt: now,
      status: 400,
      permanent: true,
    }
  }
  if (account.lastError) {
    return { message: account.lastError, checkedAt: now, permanent: false }
  }
  return undefined
}

/**
 * True when a refresh error means the token is permanently dead and the account
 * needs a re-login (vs a transient failure that recovers).
 *
 * Precedence:
 *  1. the explicit `permanent` flag (set at construction from 400 invalid_grant)
 *     — the authoritative signal; correctly classifies a retry-exhausted/network
 *     error (long backoff, but NOT dead) as non-permanent;
 *  2. else the captured HTTP `status` — 400 (for errors built before `permanent`
 *     existed but after `status`);
 *  3. else the legacy 24h-delay heuristic — back-compat ONLY for errors persisted
 *     before either field existed (e.g. an operator's already-dead token: no
 *     status, ~24h backoff). It still flags those until the next refresh restamps
 *     the error with the explicit field.
 */
export function isPermanentRefreshError(
  error: AccountOperationError | undefined,
): boolean {
  if (!error) return false
  if (typeof error.permanent === 'boolean') return error.permanent
  if (typeof error.status === 'number') return error.status === 400
  if (typeof error.nextRetryAt === 'number') {
    return (
      error.nextRetryAt - error.checkedAt >= LEGACY_PERMANENT_REFRESH_DELAY_MS
    )
  }
  return false
}

export function getFallbackReauthLabels(
  storage: AccountStorage | null | undefined,
): string[] {
  if (!storage) return []
  return storage.accounts
    .filter(
      (account): account is OAuthAccount =>
        account.enabled !== false &&
        isOAuthAccount(account) &&
        isPermanentRefreshError(account.lastRefreshError),
    )
    .map((account) => account.label?.trim() || account.id)
}

export function isQuotaPolicyAuthError(error: unknown) {
  const status = (error as { status?: unknown }).status
  if (status === 403) return true
  return /Claude quota check failed: 403\b/.test(formatErrorMessage(error))
}

export function buildQuotaOperationError(input: {
  error: unknown
  now: number
  previous?: AccountOperationError
}): AccountOperationError {
  const previousRetryCount = input.previous?.retryCount ?? 0
  const retryCount = previousRetryCount + 1
  const delay = isTransientQuotaError(input.error)
    ? Math.min(
        MAX_QUOTA_RETRY_DELAY_MS,
        MIN_QUOTA_RETRY_DELAY_MS * 2 ** Math.min(retryCount - 1, 6),
      )
    : NON_TRANSIENT_QUOTA_RETRY_DELAY_MS
  return {
    message: formatErrorMessage(input.error),
    checkedAt: input.now,
    nextRetryAt: input.now + delay,
    retryCount,
  }
}

export function quotaBackoffActive(
  error: AccountOperationError | undefined,
  now: number,
): boolean {
  if (!error?.nextRetryAt || error.nextRetryAt <= now) return false
  return true
}

export function formatQuotaBackoffMessage(
  error: AccountOperationError,
  now: number,
): string {
  const seconds = Math.max(
    1,
    Math.ceil(((error.nextRetryAt ?? now) - now) / 1000),
  )
  return `Quota API backed off for ${seconds}s after: ${error.message}`
}

export function getQuotaCheckIntervalMs(storage: AccountStorage | null) {
  const minutes =
    storage?.quota?.checkIntervalMinutes ?? DEFAULT_QUOTA_CHECK_INTERVAL_MINUTES
  return Math.max(1, minutes) * 60_000
}

export function getPersistedLogLevel(
  storage: AccountStorage | null,
): LogLevel | undefined {
  return storage?.logging?.level
}

export async function setLogLevelPersistent(
  level: LogLevel,
  path = getAccountStoragePath(),
) {
  const { setLogLevel } = await import('./logger.ts')
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.logging = {
    ...(storage.logging ?? {}),
    level,
  }
  await saveAccounts(storage, path)
  setLogLevel(level)
}

export function getPersistedMainQuota(storage: AccountStorage | null): {
  quota: OAuthQuotaSnapshot
  checkedAt: number
  tokenFingerprint?: string
} | null {
  if (!storage?.quota?.mainQuota || !storage.quota.mainQuotaCheckedAt)
    return null
  return {
    quota: storage.quota.mainQuota,
    checkedAt: storage.quota.mainQuotaCheckedAt,
    tokenFingerprint: storage.quota.mainQuotaToken,
  }
}

/**
 * How often (in requests) to force a quota refresh, independent of the timer.
 * Returns 0 when disabled (default).
 */
export function getQuotaRefreshEveryNRequests(
  storage: AccountStorage | null,
): number {
  const n = storage?.quota?.refreshEveryNRequests
  return typeof n === 'number' && Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : 0
}

function failClosedOnUnknownQuota(storage: AccountStorage | null) {
  return (
    storage?.quota?.failClosedOnUnknownQuota ??
    DEFAULT_FAIL_CLOSED_ON_UNKNOWN_QUOTA
  )
}

function normalizeScopedQuotaModel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function scopedQuotaModelKey(model: unknown): string | null {
  if (typeof model !== 'string') return null
  const normalized = normalizeScopedQuotaModel(model)
  if (normalized.includes('fable')) return 'fable'
  if (normalized.includes('mythos')) return 'mythos'
  return normalized
}

export function getScopedQuotaWindowForModel(
  quota: OAuthQuotaSnapshot | undefined,
  model: unknown,
): AccountScopedQuotaWindow | undefined {
  const key = scopedQuotaModelKey(model)
  if (!key) return undefined
  return quota?.scoped?.find((window) => {
    const haystack = [window.modelId, window.modelName, window.title]
      .filter((value): value is string => typeof value === 'string')
      .map(normalizeScopedQuotaModel)
      .join(' ')
    return haystack.includes(key)
  })
}

export function quotaSnapshotModelScopeIsExhausted(
  quota: OAuthQuotaSnapshot | undefined,
  model: unknown,
) {
  const window = getScopedQuotaWindowForModel(quota, model)
  return Boolean(
    window &&
      Number.isFinite(window.remainingPercent) &&
      window.remainingPercent <= 0,
  )
}

export function quotaSnapshotPassesModelScope(
  quota: OAuthQuotaSnapshot | undefined,
  model: unknown,
) {
  return !quotaSnapshotModelScopeIsExhausted(quota, model)
}

export function quotaSnapshotPassesPolicy(
  quota: OAuthQuotaSnapshot | undefined,
  storage: AccountStorage | null,
) {
  if (!quotaEnabled(storage)) return true
  const thresholds = getQuotaMinimumRemainingThresholds(storage)
  for (const key of ['five_hour', 'seven_day'] as const) {
    const window = quota?.[key]
    if (!window) return !failClosedOnUnknownQuota(storage)
    if (!Number.isFinite(window.remainingPercent)) {
      return !failClosedOnUnknownQuota(storage)
    }
    if (window.remainingPercent < thresholds[key]) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Killswitch — hard-block requests when remaining quota drops below per-account
// thresholds, even if the API would still accept them.
// ---------------------------------------------------------------------------

export const DEFAULT_KILLSWITCH_THRESHOLDS: Record<
  QuotaWindowName | 'scoped',
  number
> = {
  five_hour: 5,
  seven_day: 10,
  scoped: 0,
}

export function normalizeKillswitchThresholds(
  thresholds: KillswitchThresholds | undefined,
): Record<QuotaWindowName | 'scoped', number> {
  const fiveHour = thresholds?.five_hour ?? thresholds?.['5h']
  const sevenDay = thresholds?.seven_day ?? thresholds?.['1w']
  const scoped = thresholds?.scoped
  return {
    five_hour:
      typeof fiveHour === 'number' && Number.isFinite(fiveHour)
        ? fiveHour
        : DEFAULT_KILLSWITCH_THRESHOLDS.five_hour,
    seven_day:
      typeof sevenDay === 'number' && Number.isFinite(sevenDay)
        ? sevenDay
        : DEFAULT_KILLSWITCH_THRESHOLDS.seven_day,
    scoped:
      typeof scoped === 'number' && Number.isFinite(scoped)
        ? scoped
        : DEFAULT_KILLSWITCH_THRESHOLDS.scoped,
  }
}

export function isKillswitchEnabled(storage: AccountStorage | null) {
  return storage?.killswitch?.enabled === true
}

export function getKillswitchThresholdsForAccount(
  storage: AccountStorage | null,
  accountId?: string,
): Record<QuotaWindowName | 'scoped', number> {
  if (!storage?.killswitch) return DEFAULT_KILLSWITCH_THRESHOLDS
  if (accountId && storage.killswitch.accounts?.[accountId]) {
    return normalizeKillswitchThresholds(storage.killswitch.accounts[accountId])
  }
  return normalizeKillswitchThresholds(storage.killswitch.main)
}

/**
 * Returns true if the account's quota is above its killswitch threshold.
 * When killswitch is disabled, always returns true.
 *
 * When `modelId` is provided, the per-account `scoped` threshold is also
 * evaluated against the quota window matching that model — additive to the
 * 5h/7d check. A model with no matching scoped window is unaffected.
 */
export function killswitchPassesPolicy(
  quota: OAuthQuotaSnapshot | undefined,
  storage: AccountStorage | null,
  accountId?: string,
  modelId?: string,
) {
  if (!isKillswitchEnabled(storage)) return true
  const thresholds = getKillswitchThresholdsForAccount(storage, accountId)
  let sawUnknownWindow = false
  for (const key of ['five_hour', 'seven_day'] as const) {
    const window = quota?.[key]
    // Defer the unknown-window decision: a quota snapshot can legally carry
    // only one window, and a present window below its threshold must still
    // block even if the other window is missing.
    if (!window) {
      sawUnknownWindow = true
      continue
    }
    if (!Number.isFinite(window.remainingPercent)) {
      sawUnknownWindow = true
      continue
    }
    if (window.remainingPercent < thresholds[key]) return false
  }
  // Scoped check is additive to the 5h/7d evaluation above and is an
  // INDEPENDENT block reason — it must run before the unknown-window
  // fail-closed decision, so an exhausted scoped window blocks even when
  // 5h/7d is missing/non-finite (the latter only changes the fall-through
  // for accounts that did not already block on scoped). A missing scoped
  // window (no carve-out for this model) is not "unknown quota" — only a
  // PRESENT window at/below threshold blocks. The comparison is inclusive
  // (`<=`) so the default 0 fires at exhaustion.
  if (modelId) {
    const scopedWindow = getScopedQuotaWindowForModel(quota, modelId)
    if (
      scopedWindow &&
      Number.isFinite(scopedWindow.remainingPercent) &&
      scopedWindow.remainingPercent <= thresholds.scoped
    ) {
      return false
    }
  }
  if (sawUnknownWindow) return !failClosedOnUnknownQuota(storage)
  return true
}

/**
 * Find the earliest reset time across all accounts' quota windows.
 * Returns seconds from `now` until that reset, or 300 as a fallback.
 *
 * When `scopedModelId` is provided, ONLY the matched scoped window's
 * `resetsAt` is considered — the 5h/7d resets are intentionally ignored
 * so the retry hint reflects the weekly reset, not the sooner 5h reset
 * (which would cause a retry-storm against a block that won't clear for
 * days). With `scopedModelId` undefined, the 5h/7d behavior is unchanged.
 */
export function killswitchRetryAfterSeconds(
  mainQuota: OAuthQuotaSnapshot | undefined,
  fallbackAccounts: Array<{ quota?: OAuthQuotaSnapshot }>,
  now: number,
  scopedModelId?: string,
): number {
  const resetTimes: number[] = []
  const allQuotas = [mainQuota, ...fallbackAccounts.map((a) => a.quota)]
  for (const quota of allQuotas) {
    if (scopedModelId) {
      const scopedWindow = getScopedQuotaWindowForModel(quota, scopedModelId)
      const resetStr = scopedWindow?.resetsAt
      if (!resetStr) continue
      const resetTime = Date.parse(resetStr)
      if (Number.isFinite(resetTime) && resetTime > now) {
        resetTimes.push(resetTime)
      }
    } else {
      for (const key of ['five_hour', 'seven_day'] as const) {
        const resetStr = quota?.[key]?.resetsAt
        if (!resetStr) continue
        const resetTime = Date.parse(resetStr)
        if (Number.isFinite(resetTime) && resetTime > now) {
          resetTimes.push(resetTime)
        }
      }
    }
  }
  if (!resetTimes.length) return 300
  return Math.max(1, Math.ceil((Math.min(...resetTimes) - now) / 1000)) + 60
}

export function getKillswitchConfig(
  storage: AccountStorage | null,
): KillswitchConfig {
  return storage?.killswitch ?? { enabled: false }
}

export async function setKillswitchPersistent(
  config: KillswitchConfig,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.killswitch = config
  await saveAccounts(storage, path)
  return storage
}

export async function removeAccountPersistent(
  id: string,
  path = getAccountStoragePath(),
): Promise<boolean> {
  const storage = await loadAccounts(path)
  if (!storage) return false
  const existed = removeAccount(storage, id)
  if (existed) {
    await saveAccounts(storage, path, { removedAccountIds: [id] })
  }
  return existed
}

export async function reorderAccountsPersistent(
  orderedIds: string[],
  path = getAccountStoragePath(),
) {
  const storage = await loadAccounts(path)
  if (!storage) return
  reorderAccounts(storage, orderedIds)
  await saveAccounts(storage, path, { preserveExistingAccountOrder: false })
}

export async function setAccountEnabledPersistent(
  id: string,
  enabled: boolean,
  path = getAccountStoragePath(),
): Promise<boolean> {
  const storage = await loadAccounts(path)
  if (!storage) return false
  const found = setAccountEnabled(storage, id, enabled)
  if (found) await saveAccounts(storage, path)
  return found
}

export async function addAccountPersistent(
  account: FallbackAccount,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  upsertAccount(storage, account)
  await saveAccounts(storage, path)
}

export function getQuotaNextRefreshAt(
  quota: OAuthQuotaSnapshot | undefined,
  storage: AccountStorage | null,
  now: number,
) {
  const intervalMs = getQuotaCheckIntervalMs(storage)
  if (!quotaEnabled(storage)) return now + intervalMs

  const windowFreshnessDeadline = Math.min(
    ...[
      ...(['five_hour', 'seven_day'] as const).map(
        (key) => quota?.[key]?.checkedAt,
      ),
      ...(quota?.scoped ?? []).map((window) => window.checkedAt),
    ]
      .filter((checkedAt): checkedAt is number => Number.isFinite(checkedAt))
      .map((checkedAt) => checkedAt + intervalMs),
  )
  const capAtOldestWindow = (candidate: number) =>
    Number.isFinite(windowFreshnessDeadline)
      ? Math.min(candidate, windowFreshnessDeadline)
      : candidate

  const thresholds = getQuotaMinimumRemainingThresholds(storage)
  const blockedResetTimes: number[] = []
  for (const key of ['five_hour', 'seven_day'] as const) {
    const window = quota?.[key]
    if (!window) return capAtOldestWindow(now + intervalMs)
    if (window.remainingPercent >= thresholds[key]) continue
    const resetTime = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN
    if (!Number.isFinite(resetTime) || resetTime <= now) {
      return capAtOldestWindow(now + intervalMs)
    }
    blockedResetTimes.push(resetTime)
  }

  if (!blockedResetTimes.length) return capAtOldestWindow(now + intervalMs)
  return capAtOldestWindow(Math.min(...blockedResetTimes) + 60_000)
}

/** Whether the hydrated access token can be sent without asking the store. */
function accessTokenIsUsable(account: OAuthAccount, now: number) {
  return Boolean(
    account.access &&
      typeof account.expires === 'number' &&
      account.expires - now > ACCESS_TOKEN_EXPIRY_MARGIN_MS,
  )
}

function quotaSnapshotIsFresh(
  quota: OAuthQuotaSnapshot | undefined,
  storage: AccountStorage | null,
  now: number,
) {
  if (!quotaEnabled(storage)) return true
  const maxAge = getQuotaCheckIntervalMs(storage)
  return (['five_hour', 'seven_day'] as const).every((key) => {
    const window = quota?.[key]
    return Boolean(window && now - window.checkedAt < maxAge)
  })
}

function quotaIsStale(
  account: OAuthAccount,
  storage: AccountStorage | null,
  now: number,
  modelId?: string,
) {
  if (!quotaSnapshotIsFresh(account.quota, storage, now)) return true
  const scoped = getScopedQuotaWindowForModel(account.quota, modelId)
  return Boolean(
    scoped && now - scoped.checkedAt >= getQuotaCheckIntervalMs(storage),
  )
}

function cachedQuotaWindowStillRelevant(
  window: AccountQuotaWindow | undefined,
  now: number,
) {
  if (!window) return false
  if (!window.resetsAt) return true
  const resetTime = Date.parse(window.resetsAt)
  return !Number.isFinite(resetTime) || resetTime > now
}

function cachedQuotaSnapshotStillRelevant(
  quota: OAuthQuotaSnapshot | undefined,
  now: number,
) {
  return (['five_hour', 'seven_day'] as const).every((key) =>
    cachedQuotaWindowStillRelevant(quota?.[key], now),
  )
}

function isTransientQuotaError(error: unknown) {
  const status = (error as { status?: unknown }).status
  if (typeof status === 'number' && Number.isFinite(status)) {
    if (status === 429 || status >= 500) return true
  }

  const formattedMessage = formatErrorMessage(error)
  if (/Claude quota check failed: (429|5\d\d)\b/.test(formattedMessage)) {
    return true
  }
  if (formattedMessage.includes('Quota refresh is already in progress')) {
    return true
  }

  if (!(error instanceof Error)) return false
  const message = error.message
  const code = (error as Error & { code?: unknown }).code
  return (
    message.includes('fetch failed') ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  )
}

function canUseCachedQuotaAfterRefreshError(
  account: OAuthAccount,
  storage: AccountStorage | null,
  error: unknown,
  now: number,
) {
  return (
    isTransientQuotaError(error) &&
    quotaSnapshotPassesPolicy(account.quota, storage) &&
    cachedQuotaSnapshotStillRelevant(account.quota, now)
  )
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 100) return 100
  return value
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function slugForQuotaIdentity(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function mapScopedWeeklyLimits(
  limits: OAuthUsageLimit[] | undefined,
  checkedAt: number,
): AccountScopedQuotaWindow[] {
  if (!Array.isArray(limits)) return []
  const seen = new Set<string>()
  const scoped: AccountScopedQuotaWindow[] = []
  for (const limit of limits) {
    if (limit?.kind !== 'weekly_scoped' || limit.group !== 'weekly') continue
    if (typeof limit.percent !== 'number' || !Number.isFinite(limit.percent)) {
      continue
    }
    const modelName = nonEmptyString(limit.scope?.model?.display_name)
    if (!modelName) continue
    const identity = nonEmptyString(limit.scope?.model?.id) ?? modelName
    const slug = slugForQuotaIdentity(identity)
    if (!slug) continue
    const id = `claude-weekly-scoped-${slug}`
    if (seen.has(id)) continue
    seen.add(id)

    const usedPercent = clampPercent(limit.percent)
    const modelId = nonEmptyString(limit.scope?.model?.id)
    scoped.push({
      id,
      title: `${modelName} only`,
      ...(modelId && { modelId }),
      modelName,
      usedPercent,
      remainingPercent: clampPercent(100 - usedPercent),
      resetsAt: limit.resets_at,
      checkedAt,
    })
  }
  return scoped
}

function mapExtraUsage(
  usage: OAuthUsageResponse,
): OAuthExtraUsageSnapshot | undefined {
  if (usage.extra_usage?.is_enabled !== true) return undefined
  const usedAmount = usage.extra_usage.used_credits
  const limitAmount = usage.extra_usage.monthly_limit
  if (
    typeof usedAmount !== 'number' ||
    !Number.isFinite(usedAmount) ||
    typeof limitAmount !== 'number' ||
    !Number.isFinite(limitAmount)
  ) {
    return undefined
  }
  const rawCurrency = usage.spend?.limit?.currency
  const currency = rawCurrency == null ? 'USD' : nonEmptyString(rawCurrency)
  const rawExponent = usage.spend?.limit?.exponent
  const moneyExponent = rawExponent == null ? 2 : rawExponent
  if (
    !currency ||
    !/^[A-Za-z]{3}$/.test(currency) ||
    !Number.isInteger(moneyExponent) ||
    moneyExponent < 0 ||
    moneyExponent > 20
  ) {
    return undefined
  }
  return {
    used: { amountMinor: usedAmount, currency, exponent: moneyExponent },
    limit: { amountMinor: limitAmount, currency, exponent: moneyExponent },
    ...(typeof usage.extra_usage.utilization === 'number' &&
      Number.isFinite(usage.extra_usage.utilization) && {
        utilizationPercent: usage.extra_usage.utilization,
      }),
    ...(nonEmptyString(usage.spend?.severity) && {
      severity: nonEmptyString(usage.spend?.severity),
    }),
    exhausted: usedAmount >= limitAmount,
  }
}

function mapBindingWindow(limits: OAuthUsageLimit[] | undefined) {
  if (!Array.isArray(limits)) return undefined
  const active = limits.find((limit) => limit?.is_active === true)
  if (!active) return undefined
  if (active.kind === 'session') return 'five_hour'
  if (active.kind === 'weekly_all') return 'seven_day'
  if (active.kind !== 'weekly_scoped' || active.group !== 'weekly') {
    return undefined
  }
  const modelName = nonEmptyString(active.scope?.model?.display_name)
  if (!modelName) return undefined
  const identity = nonEmptyString(active.scope?.model?.id) ?? modelName
  const slug = slugForQuotaIdentity(identity)
  return slug ? `claude-weekly-scoped-${slug}` : undefined
}

function mapUsageWindow(
  window: OAuthUsageWindow | undefined,
  checkedAt: number,
): AccountQuotaWindow | undefined {
  if (typeof window?.utilization !== 'number') return undefined
  if (!Number.isFinite(window.utilization)) return undefined
  const usedPercent = clampPercent(window.utilization)
  return {
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    resetsAt: window.resets_at,
    checkedAt,
  }
}

export async function fetchOAuthQuotaSnapshot(input: {
  accessToken: string
  fetchImpl?: typeof fetch
  now?: () => number
}): Promise<OAuthQuotaSnapshot> {
  const fetchImpl = input.fetchImpl ?? fetch
  const response = await fetchImpl(QUOTA_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': `claude-code/${getCachedClaudeCodeVersion()}`,
    },
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const error = Object.assign(
      new Error(`Claude quota check failed: ${response.status} — ${body}`),
      {
        status: response.status,
        retryAfter: parseRetryAfterSeconds(
          response.headers.get('Retry-After'),
          response.headers.get('Retry-After-Ms'),
        ),
      },
    )
    throw error
  }

  const checkedAt = input.now?.() ?? Date.now()
  const usage = (await response.json()) as OAuthUsageResponse
  const bindingWindow = mapBindingWindow(usage.limits)
  return {
    five_hour: mapUsageWindow(usage.five_hour, checkedAt),
    seven_day: mapUsageWindow(usage.seven_day, checkedAt),
    scoped: mapScopedWeeklyLimits(usage.limits, checkedAt),
    extraUsage: mapExtraUsage(usage),
    ...(bindingWindow && {
      bindingWindow,
      bindingWindowSource: 'poll' as const,
    }),
    source: 'poll',
    checkedAt,
  } satisfies OAuthQuotaSnapshot
}

function updateStoredAccount(
  storage: AccountStorage,
  account: FallbackAccount,
) {
  const index = storage.accounts.findIndex(
    (candidate) => candidate.id === account.id,
  )
  if (index >= 0) storage.accounts[index] = account
}

export function upsertAccount(
  storage: AccountStorage,
  account: FallbackAccount,
) {
  const index = storage.accounts.findIndex(
    (candidate) =>
      candidate.id === account.id ||
      (account.label && candidate.label === account.label),
  )
  if (index >= 0) {
    storage.accounts[index] = {
      ...storage.accounts[index],
      ...account,
      addedAt: storage.accounts[index]?.addedAt ?? account.addedAt,
      ...(account.type === 'oauth' && {
        quota: account.quota,
        profile: account.profile,
        lastRefreshedAt: account.lastRefreshedAt,
        lastRefreshError: account.lastRefreshError,
        lastQuotaRefreshError: account.lastQuotaRefreshError,
      }),
    }
    return
  }
  storage.accounts.push(account)
}

export function removeAccount(storage: AccountStorage, id: string): boolean {
  const index = storage.accounts.findIndex((c) => c.id === id)
  if (index < 0) return false
  storage.accounts.splice(index, 1)
  return true
}

export function reorderAccounts(storage: AccountStorage, orderedIds: string[]) {
  const orderMap = new Map(orderedIds.map((id, i) => [id, i]))
  const known = storage.accounts.filter((a) => orderMap.has(a.id))
  const unknown = storage.accounts.filter((a) => !orderMap.has(a.id))
  known.sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0))
  storage.accounts = [...known, ...unknown]
}

export function setAccountEnabled(
  storage: AccountStorage,
  id: string,
  enabled: boolean,
): boolean {
  const account = storage.accounts.find((c) => c.id === id)
  if (!account) return false
  account.enabled = enabled
  return true
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function recordQuotaRefreshError(
  account: OAuthAccount,
  error: unknown,
  now: number,
) {
  if (isQuotaPolicyAuthError(error) || accessBackoffError(error)) return
  account.lastQuotaRefreshError = buildQuotaOperationError({
    error,
    now,
    previous: account.lastQuotaRefreshError,
  })
}

type AccessBackoffError = Error & { accessBackoff: AccountOperationError }

function accessBackoffError(error: unknown): AccountOperationError | undefined {
  if (!error || typeof error !== 'object') return undefined
  const backoff = (error as Partial<AccessBackoffError>).accessBackoff
  return backoff && typeof backoff.message === 'string' ? backoff : undefined
}

/**
 * The store's refusal to hand out an access token, as the account's refresh
 * error. `invalid_grant` is terminal (re-login); everything else recovers.
 */
function refreshErrorFromAccessFailure(
  error: unknown,
  now: number,
  previous: AccountOperationError | undefined,
): AccountOperationError {
  const message = formatErrorMessage(error)
  // Binding errors (and re-authorization failures) carry the class on `code`.
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'invalid_grant') {
    return { message, checkedAt: now, status: 400, permanent: true }
  }
  const retryCount = (previous?.permanent ? 0 : (previous?.retryCount ?? 0)) + 1
  const delay =
    code === 'transient'
      ? Math.min(
          MAX_ACCESS_RETRY_DELAY_MS,
          MIN_ACCESS_RETRY_DELAY_MS * 2 ** Math.min(retryCount - 1, 6),
        )
      : MIN_ACCESS_RETRY_DELAY_MS
  return {
    message,
    checkedAt: now,
    nextRetryAt: now + delay,
    retryCount,
    permanent: false,
  }
}

/**
 * Routes over the fallback OAuth accounts of one host.
 *
 * Credentials come from the shared store: {@link ensureAccessToken} asks the
 * Rust binding for a live bearer just before an account is used, and the
 * binding refreshes (claimed, compare-and-swap, fail-closed) when the stored
 * one has expired. Nothing here presents a refresh token or writes the store
 * file. The periodic task ({@link startKeepAlive}) calls the store's
 * machine-wide `keepAliveOnce()` — which refreshes only idle accounts whose
 * refresh token is about to lapse — and polls quota for accounts whose access
 * token is already live; it never refreshes an account just because its
 * access token expired.
 */
export class FallbackAccountManager {
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch
  private readonly configPath: string
  private readonly store: SharedAccountAccess
  private readonly accessPromises = new Map<string, Promise<OAuthAccount>>()
  /** Process-local backoff after the store failed to produce a token. */
  private readonly accessBackoff = new Map<string, AccountOperationError>()
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null
  readonly quotaManager: import('./quota-manager.ts').QuotaManager | null
  private readonly onFallbackStorageChanged: (() => void) | undefined
  private readonly setIntervalImpl: typeof globalThis.setInterval
  private readonly clearIntervalImpl: typeof globalThis.clearInterval

  constructor(options: AccountManagerOptions = {}) {
    this.now = options.now ?? Date.now
    this.fetchImpl = options.fetchImpl ?? fetch
    this.configPath = options.configPath ?? getAccountStoragePath()
    this.store = { ...defaultSharedAccountAccess, ...options.store }
    this.quotaManager = options.quotaManager ?? null
    this.onFallbackStorageChanged = options.onFallbackStorageChanged
    this.setIntervalImpl = options.setIntervalImpl ?? globalThis.setInterval
    this.clearIntervalImpl =
      options.clearIntervalImpl ?? globalThis.clearInterval
  }

  /**
   * Seed QuotaManager from persisted account.quota if no cache entry exists
   * yet. Prevents unnecessary API calls when the on-disk snapshot is fresh.
   */
  private seedFallbackQuota(
    account: OAuthAccount,
    storage: AccountStorage,
  ): void {
    if (!this.quotaManager) return
    if (!account.quota) return
    const checkedAt = quotaSnapshotCheckedAt(account.quota)
    if (checkedAt <= 0) return
    const existing = this.quotaManager.getFallback(account.id, account.access)
    if (existing && existing.checkedAt >= checkedAt) return
    const checkInterval = getQuotaCheckIntervalMs(storage)
    this.quotaManager.setFallback(
      account.id,
      {
        quota: account.quota,
        refreshAfter: checkedAt + checkInterval,
        checkedAt,
      },
      account.access,
    )
  }

  async load() {
    return loadAccounts(this.configPath)
  }

  async save(storage: AccountStorage, accountIds?: string[]) {
    await saveAccountState(storage, this.configPath, {
      accounts: accountIds ?? true,
    })
  }

  /**
   * Start the periodic store keep-alive (default every 10 minutes, jittered).
   * Replaces the old background refresh, which rotated every idle fallback
   * account's token about every 8 h whether or not anything used it.
   */
  startKeepAlive() {
    const run = async () => {
      await this.keepAliveTick()
    }
    void run().catch(() => {})
    if (!this.keepAliveTimer) {
      this.keepAliveTimer = this.setIntervalImpl(() => {
        void run().catch(() => {})
      }, getRefreshIntervalMs(null) + jitterMs(KEEPALIVE_TICK_JITTER_MS))
      if ('unref' in this.keepAliveTimer) this.keepAliveTimer.unref()
    }
  }

  stopKeepAlive() {
    if (this.keepAliveTimer) this.clearIntervalImpl(this.keepAliveTimer)
    this.keepAliveTimer = null
  }

  /** One keep-alive pass plus a quota poll of the already-live accounts. */
  async keepAliveTick(): Promise<KeepAliveResult | undefined> {
    const storage = await this.load()
    let report: KeepAliveResult | undefined
    if (keepAliveEnabled(storage)) {
      try {
        report = await this.store.keepAliveOnce()
        if (report.refreshed.length || report.failed.length) {
          logger.info('keepalive', 'store keep-alive pass', {
            lease: report.lease,
            refreshed: report.refreshed.map((entry) => entry.accountId),
            failed: report.failed.map((entry) => ({
              accountId: entry.accountId,
              reason: entry.reason,
            })),
          })
        }
      } catch (error) {
        logger.warn('keepalive', 'store keep-alive pass failed', {
          error: formatErrorMessage(error),
        })
      }
    }
    await this.refreshQuotaForDueAccounts()
    return report
  }

  /**
   * Hydrate `account.access`/`expires` from the store. The binding refreshes
   * (claimed, through the store) only when the stored token has expired. With
   * `force`, the current bearer is treated as rejected (an upstream 401) and
   * the store performs one claimed refresh of it.
   */
  async ensureAccessToken(
    account: OAuthAccount,
    options: { force?: boolean } = {},
  ): Promise<OAuthAccount> {
    if (!options.force && accessTokenIsUsable(account, this.now())) {
      return account
    }
    const inflight = this.accessPromises.get(account.id)
    if (inflight) {
      const hydrated = await inflight
      account.access = hydrated.access
      account.expires = hydrated.expires
      account.lastRefreshError = hydrated.lastRefreshError
      return account
    }
    const promise = this.hydrate(account, options).finally(() => {
      this.accessPromises.delete(account.id)
    })
    this.accessPromises.set(account.id, promise)
    return promise
  }

  private async hydrate(
    account: OAuthAccount,
    options: { force?: boolean },
  ): Promise<OAuthAccount> {
    const now = this.now()
    const backoff = this.accessBackoff.get(account.id)
    if (!options.force && backoff?.nextRetryAt && backoff.nextRetryAt > now) {
      account.lastRefreshError = backoff
      throw Object.assign(
        new Error(
          `Claude OAuth access for ${account.id} is backed off for ${Math.ceil((backoff.nextRetryAt - now) / 1000)}s after: ${backoff.message}`,
        ),
        { accessBackoff: backoff },
      )
    }
    try {
      let token: AccessToken | undefined
      if (options.force && account.access) {
        const recovery = await this.store.handleUnauthorized(account.access)
        if (!recovery.retry || !recovery.token) {
          throw Object.assign(
            new Error(
              `Claude OAuth account ${account.id} could not be re-authorized (${recovery.reason})`,
            ),
            { code: recovery.failureCode ?? 'transient' },
          )
        }
        token = recovery.token
      } else {
        token = await this.store.getAccessToken(account.id)
      }
      account.access = token.accessToken
      account.expires = token.expiresAt
      account.lastRefreshError = undefined
      this.accessBackoff.delete(account.id)
      if (token.source !== 'store') {
        log('[refresh] fallback oauth token from store', {
          accountId: account.id,
          source: token.source,
          expiresInMs: token.expiresAt - this.now(),
        })
      }
      return account
    } catch (error) {
      const verdict = refreshErrorFromAccessFailure(
        error,
        this.now(),
        this.accessBackoff.get(account.id),
      )
      account.lastRefreshError = verdict
      if (!verdict.permanent) this.accessBackoff.set(account.id, verdict)
      logger.warn('refresh', 'fallback oauth token unavailable', {
        accountId: account.id,
        permanent: verdict.permanent,
        error: verdict.message,
      })
      throw error
    }
  }

  async getUsableFallbackAccounts(
    existingStorage?: AccountStorage | null,
    options: { modelId?: string } = {},
  ) {
    const storage =
      existingStorage !== undefined ? existingStorage : await this.load()
    if (!storage) return []
    const usable: OAuthAccount[] = []
    let changed = false

    for (const account of storage.accounts) {
      if (account.enabled === false || !isOAuthAccount(account)) {
        logger.debug('accounts.fallback', 'candidate excluded', {
          id: account.id,
          reason:
            account.enabled === false ? 'disabled' : 'not an oauth account',
        })
        continue
      }
      if (isPermanentRefreshError(account.lastRefreshError)) {
        logger.debug('accounts.fallback', 'candidate excluded', {
          id: account.id,
          reason: 'refresh token is dead; re-login required',
        })
        continue
      }
      try {
        let next = await this.ensureAccessToken(account)
        this.seedFallbackQuota(next, storage)
        const stale = this.quotaManager
          ? this.quotaManager.isFallbackStale(
              next.id,
              next.access,
              options.modelId,
            )
          : quotaIsStale(next, storage, this.now(), options.modelId)
        // Skip the request-time refresh when this account's quota API is
        // backed off (recent 429/5xx). Hitting it again would extend the
        // backoff; evaluate policy on the cached/seeded quota instead.
        if (
          stale &&
          !quotaBackoffActive(next.lastQuotaRefreshError, this.now())
        ) {
          next = (await this.refreshAccountQuota(next, storage)).account
          changed = true
        }
        // Single source of truth: evaluate quota policy from the unified
        // QuotaManager cache (the same source as the staleness check above) so
        // an active-route refresh that updated only the cache is not ignored.
        const passes = this.accountPassesQuotaPolicy(
          this.quotaPolicyAccount(next),
          storage,
          { modelId: options.modelId },
        )
        // The single most consequential verdict in routing: an account
        // rejected here never appears in the pool, so a log that only shows
        // the survivors cannot explain why the request went where it did.
        logger.debug('accounts.fallback', 'quota policy verdict', {
          id: next.id,
          passes,
          staleWhenChecked: stale,
          fiveHourUsedPercent: next.quota?.five_hour?.usedPercent,
          sevenDayUsedPercent: next.quota?.seven_day?.usedPercent,
          modelId: options.modelId,
        })
        if (passes) usable.push(next)
      } catch (error) {
        if (
          account.access &&
          canUseCachedQuotaAfterRefreshError(
            account,
            storage,
            error,
            this.now(),
          )
        ) {
          log('[refresh] fallback quota using cached quota after error', {
            accountId: account.id,
            error: formatErrorMessage(error),
          })
          if (
            this.accountPassesQuotaPolicy(
              this.quotaPolicyAccount(account),
              storage,
              { modelId: options.modelId },
            )
          ) {
            usable.push(account)
          }
        } else if (
          account.access &&
          !failClosedOnUnknownQuota(storage) &&
          quotaSnapshotPassesModelScope(account.quota, options.modelId)
        ) {
          logger.debug('accounts.fallback', 'admitted on unknown quota', {
            id: account.id,
            error: formatErrorMessage(error),
            reason:
              'fail-open: quota unknown and not configured to fail closed',
          })
          usable.push(account)
        } else {
          logger.debug('accounts.fallback', 'candidate excluded', {
            id: account.id,
            reason: 'access token or quota lookup failed',
            error: formatErrorMessage(error),
          })
        }
      }
    }

    logger.debug('accounts.fallback', 'usable pool resolved', {
      considered: storage.accounts.length,
      usable: usable.length,
      ids: usable.map((account) => account.id),
    })

    if (changed) await this.save(storage)
    return usable
  }

  async markUsed(account: FallbackAccount) {
    if (isOAuthAccount(account)) {
      await this.store.markUsed(account.id).catch((error) => {
        logger.debug('accounts.fallback', 'store markUsed failed', {
          id: account.id,
          error: formatErrorMessage(error),
        })
      })
    }
    const storage = await this.load()
    if (!storage) return
    const stored = storage.accounts.find(
      (candidate) => candidate.id === account.id,
    )
    if (!stored) return
    stored.lastUsed = this.now()
    await this.save(storage)
  }

  accountPassesQuotaPolicy(
    account: OAuthAccount,
    storage: AccountStorage | null,
    options: { modelId?: string } = {},
  ) {
    return (
      quotaSnapshotPassesPolicy(account.quota, storage) &&
      quotaSnapshotPassesModelScope(account.quota, options.modelId)
    )
  }

  /**
   * Return the account with its quota overlaid from the unified QuotaManager
   * cache (token-bound) when available, so quota-policy decisions use the same
   * source of truth as the staleness check. Falls back to the stored
   * account.quota when no manager is wired or the cache has no entry.
   */
  private quotaPolicyAccount(account: OAuthAccount): OAuthAccount {
    if (!this.quotaManager) return account
    const cached = this.quotaManager.getFallback(
      account.id,
      account.access,
    )?.quota
    return cached ? { ...account, quota: cached } : account
  }

  /**
   * The store rows whose access token is live right now (well before its
   * expiry). Background quota polling uses only these, so polling never makes
   * the store refresh an idle account.
   */
  private async liveStoreAccountIds(): Promise<Set<string>> {
    const now = this.now()
    const rows = await this.store.listAccounts().catch(() => [])
    return new Set(
      rows
        .filter(
          (row) =>
            row.enabled &&
            row.accessLive &&
            typeof row.expiresAt === 'number' &&
            row.expiresAt - now > ACCESS_TOKEN_EXPIRY_MARGIN_MS,
        )
        .map((row) => row.id),
    )
  }

  /** Quota poll of the fallback accounts whose access token is live. */
  async refreshQuotaForDueAccounts() {
    const storage = await this.load()
    if (!storage || !quotaEnabled(storage)) return
    const live = await this.liveStoreAccountIds()
    let changed = false
    for (const account of storage.accounts) {
      if (account.enabled === false || !isOAuthAccount(account)) continue
      if (!live.has(account.id)) continue
      let next = account
      try {
        if (quotaBackoffActive(next.lastQuotaRefreshError, this.now())) {
          continue
        }
        next = await this.ensureAccessToken(next)
        this.seedFallbackQuota(next, storage)
        // Use QuotaManager staleness when available (shared cache);
        // fall back to per-account on-disk staleness otherwise.
        const stale = this.quotaManager
          ? this.quotaManager.isFallbackStale(next.id, next.access)
          : quotaIsStale(next, storage, this.now())
        if (!stale) continue
        await this.refreshAccountQuota(next, storage)
        changed = true
      } catch (error) {
        recordQuotaRefreshError(account, error, this.now())
        updateStoredAccount(storage, account)
        changed = true
        // Quota probes are advisory; failed probes fail closed at selection time.
      }
    }
    if (changed) {
      await this.save(storage)
      this.onFallbackStorageChanged?.()
    }
  }

  /**
   * Quota for every enabled fallback account whose access token is live (the
   * `/claude-quota` view). An idle account whose token has expired keeps its
   * last reading: fetching a fresh one would spend a refresh token, and only
   * use (or the keep-alive) should do that.
   */
  async refreshQuotaForAllAccounts(options: { force?: boolean } = {}) {
    const storage = await this.load()
    const errors: AccountRefreshError[] = []
    if (!storage || !quotaEnabled(storage)) return { storage, errors }
    const force = options.force ?? false
    const live = await this.liveStoreAccountIds()
    let changed = false
    for (const account of storage.accounts) {
      if (account.enabled === false || !isOAuthAccount(account)) continue
      if (!live.has(account.id)) continue
      let next = account
      try {
        next = await this.ensureAccessToken(next)
        // force (manual /claude-quota) bypasses the staleness skip to fetch
        // fresh numbers on demand. refreshAccountQuota still respects 429
        // backoff via QuotaManager.refreshFallback.
        if (!force && !quotaIsStale(next, storage, this.now())) {
          if (next.lastQuotaRefreshError) {
            next.lastQuotaRefreshError = undefined
            updateStoredAccount(storage, next)
            changed = true
          }
          continue
        }
        await this.refreshAccountQuota(next, storage)
        changed = true
      } catch (error) {
        recordQuotaRefreshError(account, error, this.now())
        updateStoredAccount(storage, account)
        changed = true
        errors.push({
          accountId: account.id,
          message: formatErrorMessage(error),
        })
      }
    }
    if (changed) await this.save(storage)
    return { storage, errors }
  }

  async refreshAccountQuota(account: OAuthAccount, storage: AccountStorage) {
    let target = account
    if (!target.access) {
      throw new Error(`Fallback account ${account.id} has no access token`)
    }
    // Unify on the shared QuotaManager when present: it adds inflight
    // deduplication and 429 backoff gating around the same quota API. Fall back
    // to a direct fetch only when no QuotaManager is wired (e.g. in isolation).
    const fetchSnapshot = (accessToken: string) =>
      this.quotaManager
        ? this.quotaManager.refreshFallbackWithMetadata(target.id, accessToken)
        : fetchOAuthQuotaSnapshot({
            accessToken,
            fetchImpl: this.fetchImpl,
            now: this.now,
          }).then((quota) => ({ quota, fetched: true }))
    let fetched = false
    try {
      const result = await fetchSnapshot(target.access)
      target.quota = result.quota
      fetched = result.fetched
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('Claude quota check failed: 401')) throw error
      // The bearer was rejected: one claimed refresh in the store.
      target = await this.ensureAccessToken(account, { force: true })
      if (!target.access) throw error
      // 401 does not arm QuotaManager backoff, so this retry proceeds.
      const result = await fetchSnapshot(target.access)
      target.quota = result.quota
      fetched = result.fetched
    }

    target.lastQuotaRefreshError = undefined
    updateStoredAccount(storage, target)
    // Sync to shared QuotaManager so all consumers see the same cache. The
    // refreshFallback path already cached the snapshot; re-set here so
    // refreshAfter reflects this storage's check interval consistently.
    if (this.quotaManager && target.quota) {
      const now = this.now()
      this.quotaManager.setFallback(
        target.id,
        {
          quota: target.quota,
          refreshAfter: now + getQuotaCheckIntervalMs(storage),
          checkedAt: now,
        },
        target.access,
      )
    }
    return { account: target, fetched }
  }
}
