import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  getCachedClaudeCodeVersion,
  getClaudeCodeUserAgent,
} from './claude-version.ts'
import {
  CLAUDE_CODE_ENTRYPOINT,
  CLAUDE_CODE_STAINLESS_PACKAGE_VERSION,
  CLAUDE_CODE_STAINLESS_RUNTIME_VERSION,
  CONTEXT_1M_BETA,
  EFFORT_BETA,
  FAST_MODE_BETA,
  modelSupportsContext1m,
} from './constants.ts'
import {
  type DeviceIdentityOptions,
  getOrCreateDeviceId,
} from './device-identity.ts'

export type ProviderAccountUuid = string & {
  readonly __providerAccountUuid: unique symbol
}

export type ClaudeCodeIdentity = {
  deviceId: string
  accountIdentity?: string
  accountUuid?: ProviderAccountUuid
  sessionId: string
}

const IDENTITY_CACHE_LIMIT = 1_000
const identityCache = new Map<string, ClaudeCodeIdentity>()
let installationDeviceId = randomBytes(32).toString('hex')
let installationDeviceIdPromise: Promise<string> | null = null
const identitySeeds = new WeakMap<ClaudeCodeIdentity, string>()

/**
 * Per-identity device id. Upstream never shares a device id between distinct
 * account identities; the fork keeps it stable across restarts by deriving it
 * from the persistent installation secret (device-identity.ts) and the
 * identity's cache key instead of minting a random one per process.
 */
function deriveDeviceId(seed: string) {
  return createHash('sha256')
    .update(`${installationDeviceId}\0${seed}`)
    .digest('hex')
}

export function setBounded<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  limit = IDENTITY_CACHE_LIMIT,
) {
  if (!map.has(key) && map.size >= limit) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}

export function configureClaudeCodeInstallationDeviceId(deviceId: string) {
  if (!/^[0-9a-f]{64}$/.test(deviceId)) {
    throw new TypeError(
      'Claude Code device identity must be 32 bytes encoded as lowercase hex',
    )
  }
  installationDeviceId = deviceId
  for (const identity of identityCache.values()) {
    const seed = identitySeeds.get(identity)
    if (seed !== undefined) identity.deviceId = deriveDeviceId(seed)
  }
}

/** Load the project-neutral persistent device identity exactly once per process. */
export async function loadClaudeCodeInstallationDeviceId(
  options: DeviceIdentityOptions = {},
) {
  installationDeviceIdPromise ??= getOrCreateDeviceId(options)
    .then((deviceId) => {
      configureClaudeCodeInstallationDeviceId(deviceId)
      return deviceId
    })
    .catch((error) => {
      installationDeviceIdPromise = null
      throw error
    })
  return installationDeviceIdPromise
}

function clearCachedAccountUuid(
  key: string,
  identity: ClaudeCodeIdentity,
): ClaudeCodeIdentity {
  if (!identity.accountUuid) return identity
  if (identityCache.get(key) !== identity) {
    return { ...identity, accountUuid: undefined }
  }
  const cleared = { ...identity, accountUuid: undefined }
  setBounded(identityCache, key, cleared)
  return cleared
}

export function getClaudeCodeIdentity(seed: string): ClaudeCodeIdentity {
  const cacheKey = seed || 'anonymous'
  const cached = identityCache.get(cacheKey)
  if (cached) return cached

  const identity: ClaudeCodeIdentity = {
    deviceId: deriveDeviceId(cacheKey),
    sessionId: randomUUID(),
  }
  identitySeeds.set(identity, cacheKey)
  setBounded(identityCache, cacheKey, identity)
  return identity
}

const BOOTSTRAP_IDENTITY_CACHE_TTL_MS = 24 * 60 * 60_000
const BOOTSTRAP_IDENTITY_NEGATIVE_TTL_MS = 5 * 60_000
const bootstrapFetches = new Map<string, Promise<ProviderAccountUuid | null>>()
const bootstrapResults = new Map<
  string,
  { accountUuid: ProviderAccountUuid | null; expiresAt: number }
>()

export function resetClaudeCodeIdentityCachesForTest() {
  // Also rotate the installation secret (without reloading it from disk) so a
  // reset slot cannot inherit the previous test's device id.
  installationDeviceId = randomBytes(32).toString('hex')
  installationDeviceIdPromise = Promise.resolve(installationDeviceId)
  identityCache.clear()
  bootstrapFetches.clear()
  bootstrapResults.clear()
}

function compatibilityCacheKey(accessToken: string) {
  return `compat:${accessToken || 'anonymous'}`
}

function explicitCacheKey(accountIdentity: string) {
  return `identity:${accountIdentity}`
}

function accountCacheKey(accountUuid: string, accountIdentity: string) {
  return `account:${accountUuid}:${accountIdentity}`
}

function adoptCachedIdentity(
  cached: ClaudeCodeIdentity | undefined,
  accountIdentity: string,
  accountUuid?: ProviderAccountUuid,
) {
  if (!cached) return undefined
  if (
    cached.accountIdentity !== undefined &&
    cached.accountIdentity !== accountIdentity
  ) {
    return undefined
  }
  if (
    accountUuid !== undefined &&
    cached.accountUuid !== undefined &&
    cached.accountUuid !== accountUuid
  ) {
    return undefined
  }
  if (
    cached.accountIdentity === accountIdentity &&
    (accountUuid === undefined || cached.accountUuid === accountUuid)
  ) {
    return cached
  }
  return {
    ...cached,
    accountIdentity,
    ...(accountUuid !== undefined && { accountUuid }),
  }
}

function cacheAccountIdentity(
  identity: ClaudeCodeIdentity,
  accountIdentity: string,
  accountUuid: ProviderAccountUuid,
) {
  setBounded(identityCache, explicitCacheKey(accountIdentity), identity)
  setBounded(
    identityCache,
    accountCacheKey(accountUuid, accountIdentity),
    identity,
  )
}

async function fetchClaudeCodeAccountUuid(
  accessToken: string,
  model?: string,
): Promise<ProviderAccountUuid | null> {
  if (!accessToken.startsWith('sk-ant-oat')) return null
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5_000)
  try {
    const url = new URL('https://api.anthropic.com/api/claude_cli/bootstrap')
    url.searchParams.set('entrypoint', CLAUDE_CODE_ENTRYPOINT)
    if (model) url.searchParams.set('model', model)

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json, text/plain, */*',
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': `claude-code/${getCachedClaudeCodeVersion()}`,
      },
      signal: controller.signal,
    })
    if (!response.ok) return null
    const data = (await response.json().catch(() => null)) as {
      oauth_account?: { account_uuid?: unknown }
    } | null
    const accountUuid = data?.oauth_account?.account_uuid
    return typeof accountUuid === 'string' && accountUuid
      ? (accountUuid as ProviderAccountUuid)
      : null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/** Use the identity already verified by the credential custodian, without an
 * additional bootstrap request carrying a previously authorized token. */
export function getClaudeCodeIdentityForVerifiedAccount(
  accountIdentity: string,
  accountUuid: ProviderAccountUuid,
): ClaudeCodeIdentity {
  if (!accountIdentity.trim() || !accountUuid.trim()) {
    throw new Error('A verified provider account identity is required')
  }
  const base =
    identityCache.get(accountCacheKey(accountUuid, accountIdentity)) ??
    getClaudeCodeIdentity(explicitCacheKey(accountIdentity))
  const identity = { ...base, accountIdentity, accountUuid }
  cacheAccountIdentity(identity, accountIdentity, accountUuid)
  return identity
}

export async function resolveClaudeCodeIdentity(
  accessToken: string,
  model: string | undefined,
  accountIdentity: string | undefined,
  deviceIdentityOptions: DeviceIdentityOptions = {},
): Promise<ClaudeCodeIdentity> {
  await loadClaudeCodeInstallationDeviceId(deviceIdentityOptions)
  const stableAccountIdentity = accountIdentity?.trim() || undefined
  const cacheKey = stableAccountIdentity
    ? explicitCacheKey(stableAccountIdentity)
    : compatibilityCacheKey(accessToken)
  let identity: ClaudeCodeIdentity
  if (stableAccountIdentity) {
    const cachedIdentity = adoptCachedIdentity(
      identityCache.get(cacheKey) ?? identityCache.get(accessToken),
      stableAccountIdentity,
    )
    identity = cachedIdentity ?? getClaudeCodeIdentity(cacheKey)
    identity = adoptCachedIdentity(identity, stableAccountIdentity) ?? identity
    setBounded(identityCache, cacheKey, identity)
  } else {
    identity =
      identityCache.get(cacheKey) ??
      identityCache.get(accessToken) ??
      getClaudeCodeIdentity(cacheKey)
    setBounded(identityCache, cacheKey, identity)
    setBounded(identityCache, accessToken, identity)
  }

  if (!accessToken.startsWith('sk-ant-oat')) {
    return clearCachedAccountUuid(cacheKey, identity)
  }

  const now = Date.now()
  // A slot-stable identity survives account replacement; bootstrap is the
  // account lookup that must be repeated for each credential presented to it.
  const bootstrapKey = `${cacheKey}:${accessToken}`
  const cachedResult = bootstrapResults.get(bootstrapKey)
  if (cachedResult && cachedResult.expiresAt > now) {
    if (!cachedResult.accountUuid) {
      identity = clearCachedAccountUuid(cacheKey, identity)
      return identity
    }
    if (!stableAccountIdentity) {
      if (identity.accountUuid === cachedResult.accountUuid) return identity
      identity = { ...identity, accountUuid: cachedResult.accountUuid }
      setBounded(identityCache, bootstrapKey, identity)
      return identity
    }
    const cachedAccountIdentity = adoptCachedIdentity(
      identityCache.get(
        accountCacheKey(cachedResult.accountUuid, stableAccountIdentity),
      ) ?? identityCache.get(`account:${cachedResult.accountUuid}`),
      stableAccountIdentity,
      cachedResult.accountUuid,
    )
    if (cachedAccountIdentity) {
      identity = cachedAccountIdentity
      cacheAccountIdentity(
        identity,
        stableAccountIdentity,
        cachedResult.accountUuid,
      )
      return identity
    }
    if (identity.accountUuid === cachedResult.accountUuid) return identity
    identity = {
      ...identity,
      accountIdentity: stableAccountIdentity,
      accountUuid: cachedResult.accountUuid,
    }
    cacheAccountIdentity(
      identity,
      stableAccountIdentity,
      cachedResult.accountUuid,
    )
    return identity
  }

  let fetchPromise = bootstrapFetches.get(bootstrapKey)
  if (!fetchPromise) {
    fetchPromise = fetchClaudeCodeAccountUuid(accessToken, model)
    setBounded(bootstrapFetches, bootstrapKey, fetchPromise)
  }

  const accountUuid = await fetchPromise.finally(() => {
    if (bootstrapFetches.get(bootstrapKey) === fetchPromise) {
      bootstrapFetches.delete(bootstrapKey)
    }
  })
  setBounded(bootstrapResults, bootstrapKey, {
    accountUuid,
    expiresAt:
      now +
      (accountUuid
        ? BOOTSTRAP_IDENTITY_CACHE_TTL_MS
        : BOOTSTRAP_IDENTITY_NEGATIVE_TTL_MS),
  })
  if (!accountUuid) {
    identity = clearCachedAccountUuid(cacheKey, identity)
    return identity
  }
  if (!stableAccountIdentity) {
    identity = { ...identity, accountUuid }
    setBounded(identityCache, bootstrapKey, identity)
    return identity
  }

  const cachedAccountIdentity = adoptCachedIdentity(
    identityCache.get(accountCacheKey(accountUuid, stableAccountIdentity)) ??
      identityCache.get(`account:${accountUuid}`),
    stableAccountIdentity,
    accountUuid,
  )
  if (cachedAccountIdentity) {
    identity = cachedAccountIdentity
    cacheAccountIdentity(identity, stableAccountIdentity, accountUuid)
    return identity
  }

  identity = {
    ...identity,
    accountIdentity: stableAccountIdentity,
    accountUuid,
  }
  cacheAccountIdentity(identity, stableAccountIdentity, accountUuid)
  return identity
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

export function buildClaudeCodeMetadataUserId(
  identity: ClaudeCodeIdentity,
): string | null {
  if (!identity.accountUuid) return null
  return JSON.stringify({
    device_id: identity.deviceId,
    account_uuid: identity.accountUuid,
    session_id: identity.sessionId,
  })
}

export function applyClaudeCodeMetadata(
  body: Record<string, unknown>,
  identity: ClaudeCodeIdentity,
) {
  const userId = buildClaudeCodeMetadataUserId(identity)
  if (!userId) {
    if (isRecord(body.metadata)) delete body.metadata.user_id
    return false
  }

  if (!isRecord(body.metadata)) body.metadata = {}
  const metadata = body.metadata
  if (isRecord(metadata)) metadata.user_id = userId
  return true
}

// Claude Code 2.1.258 sends redact-thinking-2026-02-12, but it suppresses
// thinking-block content that OpenCode displays; deliberately omitted after A/B proof on 2026-09-01.
export const CLAUDE_CODE_FULL_AGENT_BETAS = [
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'claude-code-20250219',
  'advisor-tool-2026-03-01',
  'advanced-tool-use-2025-11-20',
  'mid-conversation-system-2026-04-07',
  'effort-2025-11-24',
  'fallback-credit-2026-06-01',
  'extended-cache-ttl-2025-04-11',
  'cache-diagnosis-2026-04-07',
] as const

const CLAUDE_CODE_STRUCTURED_OUTPUT_BETAS = [
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'advisor-tool-2026-03-01',
  'structured-outputs-2025-12-15',
  'cache-diagnosis-2026-04-07',
] as const

const CLAUDE_CODE_BASE_BETAS = [
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'advisor-tool-2026-03-01',
  'advanced-tool-use-2025-11-20',
  'extended-cache-ttl-2025-04-11',
  'cache-diagnosis-2026-04-07',
] as const

function hasStructuredOutput(body: Record<string, unknown>) {
  const outputConfig = body.output_config as Record<string, unknown> | undefined
  const format = outputConfig?.format as Record<string, unknown> | undefined
  return format?.type === 'json_schema'
}

function hasFullAgentShape(body: Record<string, unknown>) {
  return (
    Array.isArray(body.tools) &&
    body.tools.length > 0 &&
    Array.isArray(body.system) &&
    isRecord(body.thinking) &&
    isRecord(body.context_management) &&
    isRecord(body.output_config) &&
    isRecord(body.diagnostics)
  )
}

export function selectClaudeCodeBetas(
  body?: Record<string, unknown> | null,
  extraBetas: string[] = [],
  options: { suppressContext1m?: boolean } = {},
) {
  const selected: string[] = body
    ? hasFullAgentShape(body)
      ? [...CLAUDE_CODE_FULL_AGENT_BETAS]
      : hasStructuredOutput(body)
        ? [...CLAUDE_CODE_STRUCTURED_OUTPUT_BETAS]
        : [...CLAUDE_CODE_BASE_BETAS]
    : [...CLAUDE_CODE_BASE_BETAS]

  if (body?.speed === 'fast') selected.push(FAST_MODE_BETA)
  // Fork: any request carrying output_config.effort needs the effort beta,
  // even when it does not have the full-agent shape (upstream lists it only
  // in the full-agent tuple).
  const outputConfig = body?.output_config
  if (isRecord(outputConfig) && outputConfig.effort !== undefined)
    selected.push(EFFORT_BETA)
  // A 1M-capable model without this beta uses the standard context window.
  // `suppressContext1m` mirrors Claude Code's account-local fallback after the
  // server specifically reports that usage credits are required for long
  // context. It does not imply that 1M context is inherently paid usage.
  if (!options.suppressContext1m && modelSupportsContext1m(body?.model))
    selected.push(CONTEXT_1M_BETA)
  for (const beta of extraBetas) {
    const trimmed = beta.trim()
    if (trimmed) selected.push(trimmed)
  }
  return [...new Set(selected)].join(',')
}

function stainlessOS() {
  switch (process.platform) {
    case 'darwin':
      return 'MacOS'
    case 'win32':
      return 'Windows'
    case 'linux':
      return 'Linux'
    case 'freebsd':
      return 'FreeBSD'
    default:
      return 'Unknown'
  }
}

function stainlessArch() {
  switch (process.arch) {
    case 'arm64':
      return 'arm64'
    case 'x64':
      return 'x64'
    case 'ia32':
      return 'x32'
    default:
      return process.arch
  }
}

const ENV_FORWARDED_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['x-claude-remote-container-id', 'CLAUDE_CODE_CONTAINER_ID'],
  ['x-claude-remote-session-id', 'CLAUDE_CODE_REMOTE_SESSION_ID'],
  ['x-client-app', 'CLAUDE_AGENT_SDK_CLIENT_APP'],
]

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase().trim())
}

// Escapes `%` first so existing escapes are not double-encoded; \x20-\x7e is
// the printable-ASCII range valid in an HTTP header value.
function encodeHeaderValue(value: string): string {
  return value.replace(/%|[^\x20-\x7e]/gu, (char) => encodeURIComponent(char))
}

export function applyClaudeCodeHeaders(
  headers: Headers,
  accessToken: string,
  options: {
    body?: Record<string, unknown> | null
    identity?: ClaudeCodeIdentity
    extraBetas?: string[]
    agentId?: string
    parentAgentId?: string
    /** Use the standard context path for an account with the native credits latch. */
    suppressContext1m?: boolean
    /** Request classification (compaction, workflow, etc.) */
    requestClass?: string
    /** Previous tool execution durations for scheduling hints */
    prevToolDurations?: string
  } = {},
): Headers {
  const identity = options.identity ?? getClaudeCodeIdentity(accessToken)
  const incomingBetas = (headers.get('anthropic-beta') ?? '')
    .split(',')
    .map((beta) => beta.trim())
    .filter(Boolean)
  const extraBetas = [...incomingBetas, ...(options.extraBetas ?? [])]

  headers.set('accept', 'application/json')
  headers.set('authorization', `Bearer ${accessToken}`)
  headers.set('content-type', 'application/json')
  headers.set('user-agent', getClaudeCodeUserAgent())
  headers.set(
    'anthropic-beta',
    selectClaudeCodeBetas(options.body, extraBetas, {
      suppressContext1m: options.suppressContext1m,
    }),
  )
  headers.set('anthropic-dangerous-direct-browser-access', 'true')
  headers.set('anthropic-version', '2023-06-01')
  headers.set('x-app', 'cli')
  headers.set('x-client-request-id', randomUUID())
  headers.set('x-claude-code-session-id', identity.sessionId)
  headers.set('x-stainless-arch', stainlessArch())
  headers.set('x-stainless-lang', 'js')
  headers.set('x-stainless-os', stainlessOS())
  headers.set(
    'x-stainless-package-version',
    CLAUDE_CODE_STAINLESS_PACKAGE_VERSION,
  )
  headers.set('x-stainless-retry-count', '0')
  headers.set('x-stainless-runtime', 'node')
  headers.set(
    'x-stainless-runtime-version',
    CLAUDE_CODE_STAINLESS_RUNTIME_VERSION,
  )
  headers.set('x-stainless-timeout', '600')
  if (options.body?.stream === true)
    headers.set('x-stainless-helper-method', 'stream')
  for (const [header, envVar] of ENV_FORWARDED_HEADERS) {
    const value = process.env[envVar]
    if (value) headers.set(header, encodeHeaderValue(value))
  }
  if (isTruthyEnvFlag(process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION))
    headers.set('x-anthropic-additional-protection', 'true')
  if (options.agentId)
    headers.set('x-claude-code-agent-id', encodeHeaderValue(options.agentId))
  if (options.parentAgentId) {
    headers.set(
      'x-claude-code-parent-agent-id',
      encodeHeaderValue(options.parentAgentId),
    )
  }
  if (options.requestClass)
    headers.set(
      'x-claude-code-request-class',
      encodeHeaderValue(options.requestClass),
    )
  if (options.prevToolDurations)
    headers.set(
      'x-claude-code-prev-tool-durations',
      encodeHeaderValue(options.prevToolDurations),
    )
  headers.delete('x-api-key')
  return headers
}

const BODY_FIELD_ORDER = [
  'model',
  'messages',
  'system',
  'tools',
  'tool_choice',
  'metadata',
  'max_tokens',
  'temperature',
  'thinking',
  'context_management',
  'output_config',
  'diagnostics',
  'stream',
  'speed',
]

export function orderClaudeCodeBody<T extends Record<string, unknown>>(
  body: T,
): T {
  const ordered: Record<string, unknown> = {}
  for (const key of BODY_FIELD_ORDER) {
    if (Object.hasOwn(body, key)) ordered[key] = body[key]
  }
  for (const [key, value] of Object.entries(body)) {
    if (!Object.hasOwn(ordered, key)) ordered[key] = value
  }
  return ordered as T
}

export function claudeCodeEntrypoint() {
  return CLAUDE_CODE_ENTRYPOINT
}
