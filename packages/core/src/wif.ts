import { readFile as readNodeFile } from 'node:fs/promises'

export const WIF_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
export const WIF_FEDERATION_BETA = 'oidc-federation-2026-04-01'
export const WIF_TOKEN_PATH = '/v1/oauth/token'
export const WIF_DEFAULT_BASE_URL = 'https://api.anthropic.com'
export const WIF_MAX_CREDENTIAL_BYTES = 16 * 1024
export const WIF_ADVISORY_REFRESH_MS = 120_000
export const WIF_MANDATORY_REFRESH_MS = 30_000
export const WIF_ADVISORY_RETRY_MS = 5_000

const CLAUDE_SUBSCRIPTION_OAUTH_BETA = 'oauth-2025-04-20'
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024

export const WIF_SHADOW_ENVIRONMENT_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_PROFILE',
] as const

export type WifShadowEnvironmentVariable =
  (typeof WIF_SHADOW_ENVIRONMENT_VARIABLES)[number]

export type WifEnvironment = Readonly<Record<string, string | undefined>>

export type WifIdentityTokenSource =
  | { type: 'inline'; token: string }
  | { type: 'file'; path: string }

export type WifConfig = {
  federationRuleId: string
  organizationId: string
  serviceAccountId?: string
  workspaceId?: string
  identityToken: WifIdentityTokenSource
  baseURL: string
}

export type WifEnvironmentResolution =
  | { type: 'configured'; config: WifConfig }
  | { type: 'shadowed'; by: WifShadowEnvironmentVariable }
  | { type: 'unconfigured' }

export type WifFileSystem = {
  readFile(path: string): string | Promise<string>
}

export type WifDependencies = {
  env?: WifEnvironment
  fetchImpl?: typeof fetch
  now?: () => number
  filesystem?: WifFileSystem
  signal?: AbortSignal
  onAdvisoryRefreshError?: (error: WifError) => void
}

export type WifAccessToken = {
  accessToken: string
  /** Unix epoch time in milliseconds. */
  expiresAt: number
}

export type WifTokenProvider = () => Promise<WifAccessToken>

export type WifErrorCode =
  | 'configuration'
  | 'identity_token'
  | 'network'
  | 'response'
  | 'token_exchange'

/** A deliberately secret-free WIF failure. */
export class WifError extends Error {
  constructor(
    public readonly code: WifErrorCode,
    message: string,
    public readonly status?: number,
    public readonly requestId?: string,
  ) {
    super(message)
    this.name = 'WifError'
  }
}

/**
 * Resolves the official Anthropic service-account environment contract.
 *
 * Existing API-key, auth-token, or explicit-profile choices shadow WIF by
 * presence, not truthiness. This intentionally means `NAME=` still shadows
 * federation instead of silently changing the selected authentication mode.
 */
export function inspectWifEnvironment(
  env: WifEnvironment = process.env,
): WifEnvironmentResolution {
  for (const name of WIF_SHADOW_ENVIRONMENT_VARIABLES) {
    if (isEnvironmentValueSet(env, name)) {
      return { type: 'shadowed', by: name }
    }
  }

  const wifNames = [
    'ANTHROPIC_FEDERATION_RULE_ID',
    'ANTHROPIC_ORGANIZATION_ID',
    'ANTHROPIC_SERVICE_ACCOUNT_ID',
    'ANTHROPIC_WORKSPACE_ID',
    'ANTHROPIC_IDENTITY_TOKEN',
    'ANTHROPIC_IDENTITY_TOKEN_FILE',
  ] as const
  if (!wifNames.some((name) => isEnvironmentValueSet(env, name))) {
    return { type: 'unconfigured' }
  }

  const federationRuleId = requiredEnvironmentValue(
    env,
    'ANTHROPIC_FEDERATION_RULE_ID',
  )
  const organizationId = requiredEnvironmentValue(
    env,
    'ANTHROPIC_ORGANIZATION_ID',
  )
  const serviceAccountId = optionalEnvironmentValue(
    env,
    'ANTHROPIC_SERVICE_ACCOUNT_ID',
  )
  const workspaceId = optionalEnvironmentValue(env, 'ANTHROPIC_WORKSPACE_ID')
  const tokenFile = optionalEnvironmentValue(
    env,
    'ANTHROPIC_IDENTITY_TOKEN_FILE',
  )
  const inlineToken = optionalEnvironmentValue(env, 'ANTHROPIC_IDENTITY_TOKEN')

  if (!tokenFile && !inlineToken) {
    throw new WifError(
      'configuration',
      'WIF requires ANTHROPIC_IDENTITY_TOKEN_FILE or ANTHROPIC_IDENTITY_TOKEN',
    )
  }

  const rawBaseURL = optionalEnvironmentValue(env, 'ANTHROPIC_BASE_URL')
  const baseURL = normalizeAndValidateBaseURL(
    rawBaseURL ?? WIF_DEFAULT_BASE_URL,
  )

  return {
    type: 'configured',
    config: {
      federationRuleId,
      organizationId,
      ...(serviceAccountId ? { serviceAccountId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      identityToken: tokenFile
        ? { type: 'file', path: tokenFile }
        : { type: 'inline', token: inlineToken ?? '' },
      baseURL,
    },
  }
}

/** Returns a WIF config only when federation wins environment precedence. */
export function resolveWifConfig(
  env: WifEnvironment = process.env,
): WifConfig | null {
  const resolution = inspectWifEnvironment(env)
  return resolution.type === 'configured' ? resolution.config : null
}

/**
 * Creates a fresh-exchange provider. File assertions are read on every call so
 * projected OIDC tokens can rotate without recreating the client.
 */
export function createWifTokenProvider(
  config: WifConfig,
  dependencies: Omit<WifDependencies, 'env' | 'onAdvisoryRefreshError'> = {},
): WifTokenProvider {
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const now = dependencies.now ?? Date.now
  const filesystem = dependencies.filesystem ?? defaultFileSystem
  const normalizedConfig = validateConfig(config)

  return async () => {
    if (dependencies.signal?.aborted) {
      throw new WifError('network', 'WIF token exchange was cancelled')
    }

    const assertion = await readIdentityToken(
      normalizedConfig.identityToken,
      filesystem,
    )
    assertCredential(assertion, 'Identity token', 'identity_token')

    const body: Record<string, string> = {
      grant_type: WIF_GRANT_TYPE,
      assertion,
      federation_rule_id: normalizedConfig.federationRuleId,
      organization_id: normalizedConfig.organizationId,
    }
    if (normalizedConfig.serviceAccountId) {
      body.service_account_id = normalizedConfig.serviceAccountId
    }
    if (normalizedConfig.workspaceId) {
      body.workspace_id = normalizedConfig.workspaceId
    }

    let response: Response
    try {
      response = await fetchImpl(
        `${normalizedConfig.baseURL}${WIF_TOKEN_PATH}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'anthropic-beta': `${CLAUDE_SUBSCRIPTION_OAUTH_BETA},${WIF_FEDERATION_BETA}`,
            'User-Agent':
              'anthropic-sdk-typescript/0.112.1 oidcFederationProvider',
          },
          body: JSON.stringify(body),
          signal: dependencies.signal,
        },
      )
    } catch {
      throw new WifError(
        'network',
        'Failed to reach the Anthropic WIF token endpoint',
      )
    }

    const requestId = safeRequestId(response.headers.get('request-id'))
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new WifError(
        'token_exchange',
        `Anthropic WIF token exchange failed with status ${response.status}${
          requestId ? ` (request-id ${requestId})` : ''
        }`,
        response.status,
        requestId,
      )
    }

    const payload = await parseTokenResponse(response, requestId)
    const expiresIn = Number(payload.expires_in)
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new WifError(
        'response',
        'Anthropic WIF token response has an invalid expires_in',
        response.status,
        requestId,
      )
    }

    const accessToken = payload.access_token
    if (typeof accessToken !== 'string') {
      throw new WifError(
        'response',
        'Anthropic WIF token response is missing access_token',
        response.status,
        requestId,
      )
    }
    assertCredential(accessToken, 'Access token', 'response')

    if (
      payload.token_type !== undefined &&
      (typeof payload.token_type !== 'string' ||
        payload.token_type.toLowerCase() !== 'bearer')
    ) {
      throw new WifError(
        'response',
        'Anthropic WIF token response has an unsupported token_type',
        response.status,
        requestId,
      )
    }

    const expiresAt = now() + expiresIn * 1_000
    if (!Number.isFinite(expiresAt)) {
      throw new WifError(
        'response',
        'Anthropic WIF token response has an invalid expiry',
        response.status,
        requestId,
      )
    }
    return { accessToken, expiresAt }
  }
}

export type WifTokenCacheOptions = {
  now?: () => number
  onAdvisoryRefreshError?: (error: WifError) => void
}

/** Single-flight token cache with Anthropic's 120s/30s refresh windows. */
export class WifTokenCache {
  private readonly now: () => number
  private readonly onAdvisoryRefreshError:
    | ((error: WifError) => void)
    | undefined
  private cached: WifAccessToken | null = null
  private inFlight: Promise<WifAccessToken> | null = null
  private lastAdvisoryFailureAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly provider: WifTokenProvider,
    options: WifTokenCacheOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.onAdvisoryRefreshError = options.onAdvisoryRefreshError
  }

  async getAccessToken(): Promise<string> {
    const cached = this.cached
    if (!cached) return (await this.refresh()).accessToken

    const remaining = cached.expiresAt - this.now()
    if (remaining > WIF_ADVISORY_REFRESH_MS) return cached.accessToken

    if (remaining > WIF_MANDATORY_REFRESH_MS) {
      this.startAdvisoryRefresh()
      return cached.accessToken
    }

    return (await this.refresh()).accessToken
  }

  /** Compatibility-friendly shorthand for callers that call caches `getToken`. */
  getToken(): Promise<string> {
    return this.getAccessToken()
  }

  /** Clears the cached token. Any already-running exchange remains single-flight. */
  invalidate(): void {
    this.cached = null
  }

  /** Returns metadata without exposing mutable cache state. */
  peek(): WifAccessToken | null {
    return this.cached ? { ...this.cached } : null
  }

  private startAdvisoryRefresh(): void {
    if (this.inFlight) return
    if (this.now() - this.lastAdvisoryFailureAt < WIF_ADVISORY_RETRY_MS) {
      return
    }
    void this.refresh().catch(() => {
      this.lastAdvisoryFailureAt = this.now()
      try {
        this.onAdvisoryRefreshError?.(
          new WifError('token_exchange', 'Advisory WIF token refresh failed'),
        )
      } catch {
        // A diagnostic hook must not turn a background refresh into an
        // unhandled rejection or alter authentication behavior.
      }
    })
  }

  private refresh(): Promise<WifAccessToken> {
    if (this.inFlight) return this.inFlight

    const operation = Promise.resolve()
      .then(() => this.provider())
      .then((token) => {
        validateAccessTokenResult(token)
        this.cached = { ...token }
        return token
      })
    this.inFlight = operation.then(
      (token) => {
        this.inFlight = null
        return token
      },
      (error) => {
        this.inFlight = null
        throw safeRefreshError(error)
      },
    )
    return this.inFlight
  }
}

/**
 * Environment-resolved WIF auth suitable for a CLI/TUI host.
 * Returns null when another auth environment variable wins or WIF is absent.
 */
export class WifAuth {
  readonly cache: WifTokenCache

  constructor(
    public readonly config: WifConfig,
    dependencies: Omit<WifDependencies, 'env'> = {},
  ) {
    const provider = createWifTokenProvider(config, dependencies)
    this.cache = new WifTokenCache(provider, {
      now: dependencies.now,
      onAdvisoryRefreshError: dependencies.onAdvisoryRefreshError,
    })
  }

  getAccessToken(): Promise<string> {
    return this.cache.getAccessToken()
  }

  async authorize(headers: Headers): Promise<Headers> {
    return applyWifBearerAuth(headers, await this.getAccessToken())
  }

  invalidate(): void {
    this.cache.invalidate()
  }
}

export function createWifAuth(
  dependencies: WifDependencies = {},
): WifAuth | null {
  const config = resolveWifConfig(dependencies.env ?? process.env)
  return config ? new WifAuth(config, dependencies) : null
}

/**
 * Mutates headers to use a standard bearer token. It explicitly removes API
 * key auth and Claude subscription OAuth's beta while preserving unrelated
 * Anthropic feature betas.
 */
export function applyWifBearerAuth(
  headers: Headers,
  accessToken: string,
): Headers {
  assertCredential(accessToken, 'Access token', 'configuration')
  headers.delete('x-api-key')
  headers.delete('api-key')
  headers.set('authorization', `Bearer ${accessToken}`)
  if (!headers.has('anthropic-version')) {
    headers.set('anthropic-version', '2023-06-01')
  }

  const betaHeader = headers.get('anthropic-beta')
  if (betaHeader !== null) {
    const remaining = betaHeader
      .split(',')
      .map((value) => value.trim())
      .filter(
        (value) =>
          value && value.toLowerCase() !== CLAUDE_SUBSCRIPTION_OAUTH_BETA,
      )
    if (remaining.length) headers.set('anthropic-beta', remaining.join(','))
    else headers.delete('anthropic-beta')
  }
  return headers
}

/** Creates a new `Headers` instance and applies standard WIF bearer auth. */
export function createWifBearerHeaders(
  accessToken: string,
  initial?: RequestInit['headers'],
): Headers {
  return applyWifBearerAuth(new Headers(initial), accessToken)
}

/** Clones a RequestInit while replacing its auth headers with WIF bearer auth. */
export function withWifBearerAuth(
  init: RequestInit | undefined,
  accessToken: string,
): RequestInit {
  return {
    ...init,
    headers: createWifBearerHeaders(accessToken, init?.headers),
  }
}

function isEnvironmentValueSet(env: WifEnvironment, name: string): boolean {
  return Object.hasOwn(env, name) && env[name] !== undefined
}

function requiredEnvironmentValue(env: WifEnvironment, name: string): string {
  const value = optionalEnvironmentValue(env, name)
  if (!value) {
    throw new WifError('configuration', `WIF requires ${name}`)
  }
  return value
}

function optionalEnvironmentValue(
  env: WifEnvironment,
  name: string,
): string | undefined {
  const raw = env[name]
  if (raw === undefined) return undefined
  assertBoundedText(raw, name)
  const value = raw.trim()
  return value || undefined
}

function validateConfig(config: WifConfig): WifConfig {
  assertCredential(
    config.federationRuleId,
    'Federation rule ID',
    'configuration',
  )
  assertCredential(config.organizationId, 'Organization ID', 'configuration')
  if (config.serviceAccountId) {
    assertCredential(
      config.serviceAccountId,
      'Service account ID',
      'configuration',
    )
  }
  if (config.workspaceId) {
    assertCredential(config.workspaceId, 'Workspace ID', 'configuration')
  }
  if (config.identityToken.type === 'inline') {
    assertCredential(
      config.identityToken.token,
      'Identity token',
      'identity_token',
    )
  } else {
    assertCredential(
      config.identityToken.path,
      'Identity token file path',
      'configuration',
    )
  }
  return {
    federationRuleId: config.federationRuleId.trim(),
    organizationId: config.organizationId.trim(),
    ...(config.serviceAccountId?.trim()
      ? { serviceAccountId: config.serviceAccountId.trim() }
      : {}),
    ...(config.workspaceId?.trim()
      ? { workspaceId: config.workspaceId.trim() }
      : {}),
    identityToken:
      config.identityToken.type === 'inline'
        ? { type: 'inline', token: config.identityToken.token.trim() }
        : { type: 'file', path: config.identityToken.path },
    baseURL: normalizeAndValidateBaseURL(config.baseURL),
  }
}

async function readIdentityToken(
  source: WifIdentityTokenSource,
  filesystem: WifFileSystem,
): Promise<string> {
  if (source.type === 'inline') return source.token.trim()
  let value: string
  try {
    value = await filesystem.readFile(source.path)
  } catch {
    throw new WifError(
      'identity_token',
      'Failed to read the WIF identity token file',
    )
  }
  if (typeof value !== 'string') {
    throw new WifError(
      'identity_token',
      'The WIF identity token file did not contain text',
    )
  }
  const token = value.trim()
  if (!token) {
    throw new WifError('identity_token', 'The WIF identity token file is empty')
  }
  return token
}

function normalizeAndValidateBaseURL(input: string): string {
  assertBoundedText(input, 'ANTHROPIC_BASE_URL')
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new WifError(
      'configuration',
      'ANTHROPIC_BASE_URL must be a valid URL',
    )
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new WifError(
      'configuration',
      'ANTHROPIC_BASE_URL must not include credentials, query, or fragment',
    )
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const loopback =
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new WifError(
      'configuration',
      'Refusing to send WIF credentials to a non-HTTPS endpoint',
    )
  }
  return url.toString().replace(/\/+$/, '')
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

function assertBoundedText(value: string, label: string): void {
  if (
    hasControlCharacters(value) ||
    new TextEncoder().encode(value).byteLength > WIF_MAX_CREDENTIAL_BYTES
  ) {
    throw new WifError(
      'configuration',
      `${label} contains control characters or exceeds 16 KiB`,
    )
  }
}

function assertCredential(
  value: string,
  label: string,
  code: WifErrorCode,
): void {
  if (!value?.trim()) {
    throw new WifError(code, `${label} is empty`)
  }
  try {
    assertBoundedText(value, label)
  } catch {
    throw new WifError(
      code,
      `${label} contains control characters or exceeds 16 KiB`,
    )
  }
}

async function parseTokenResponse(
  response: Response,
  requestId: string | undefined,
): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readLimitedText(response, MAX_TOKEN_RESPONSE_BYTES)
  } catch {
    throw new WifError(
      'response',
      'Anthropic WIF token response exceeded the allowed size',
      response.status,
      requestId,
    )
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new WifError(
      'response',
      'Anthropic WIF token endpoint returned invalid JSON',
      response.status,
      requestId,
    )
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WifError(
      'response',
      'Anthropic WIF token endpoint returned an invalid response',
      response.status,
      requestId,
    )
  }
  return value as Record<string, unknown>
}

async function readLimitedText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maximumBytes) {
      await reader.cancel().catch(() => {})
      throw new Error('response too large')
    }
    chunks.push(value)
  }
  const output = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(output)
}

function safeRequestId(value: string | null): string | undefined {
  return value && /^[A-Za-z0-9._:-]{1,200}$/.test(value) ? value : undefined
}

function validateAccessTokenResult(token: WifAccessToken): void {
  if (!token || typeof token !== 'object') {
    throw new WifError(
      'response',
      'WIF token provider returned an invalid token',
    )
  }
  assertCredential(token.accessToken, 'Access token', 'response')
  if (!Number.isFinite(token.expiresAt)) {
    throw new WifError(
      'response',
      'WIF token provider returned an invalid expiry',
    )
  }
}

function safeRefreshError(error: unknown): WifError {
  if (error instanceof WifError) return error
  return new WifError('token_exchange', 'WIF token refresh failed')
}

const defaultFileSystem: WifFileSystem = {
  readFile: (path) => readNodeFile(path, 'utf8'),
}
