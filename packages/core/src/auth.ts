import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

import {
  AUTHORIZE_URLS,
  AXIOS_USER_AGENT,
  CODE_CALLBACK_URL,
  getOAuthClientId,
  OAUTH_SCOPES,
  REFRESH_SCOPE,
  REVOKE_URL,
  TOKEN_URL,
} from './constants.ts'
import { logger } from './logger.ts'
import { generatePKCE } from './pkce.ts'
import { tokenFingerprint } from './token-fingerprint.ts'

type CallbackParams = {
  code: string
  state: string
}

export function parseRetryAfterHeader(
  value: string | undefined | null,
): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds)
  const date = Date.parse(value)
  if (Number.isFinite(date)) {
    const delta = Math.ceil((date - Date.now()) / 1000)
    return delta > 0 ? delta : undefined
  }
  return undefined
}

export function parseRetryAfterSeconds(
  retryAfter: string | undefined | null,
  retryAfterMs?: string | undefined | null,
): number | undefined {
  if (retryAfterMs) {
    const milliseconds = Number(retryAfterMs)
    if (Number.isFinite(milliseconds) && milliseconds > 0) {
      return Math.ceil(milliseconds / 1000)
    }
  }
  return parseRetryAfterHeader(retryAfter)
}

export class ClaudeOAuthRefreshError extends Error {
  /** Parsed Retry-After value in seconds, if the server provided one. */
  public readonly retryAfter: number | undefined

  /**
   * Duck-typed marker: any error carrying `isRefreshError: true` arms the
   * refresh backoff in consumers that receive it (recordQuotaRefreshError).
   * Provider-agnostic — shared-core extraction of anthropic-auth and
   * openai-auth relies on this field instead of instanceof.
   */
  public readonly isRefreshError = true

  constructor(
    public readonly status: number,
    public readonly body: string,
    retryAfterHeader?: string | null,
    retryAfterMsHeader?: string | null,
  ) {
    super(`Claude OAuth refresh failed: ${status} — ${body}`)
    this.name = 'ClaudeOAuthRefreshError'
    this.retryAfter = parseRetryAfterSeconds(
      retryAfterHeader ?? undefined,
      retryAfterMsHeader ?? undefined,
    )
  }
}

export class ClaudeOAuthRefreshTokenExpiredError extends Error {
  public readonly code = 'refresh_token_expired'
  public readonly isRefreshError = true
  public readonly permanent = true

  constructor() {
    super(
      'Claude OAuth refresh token has expired; re-authentication is required',
    )
    this.name = 'ClaudeOAuthRefreshTokenExpiredError'
  }
}

export class ClaudeOAuthRevokeError extends Error {
  public readonly retryAfter: number | undefined

  constructor(
    public readonly status: number,
    public readonly body: string,
    retryAfterHeader?: string | null,
    retryAfterMsHeader?: string | null,
  ) {
    super(`Claude OAuth revocation failed: ${status} — ${body}`)
    this.name = 'ClaudeOAuthRevokeError'
    this.retryAfter = parseRetryAfterSeconds(
      retryAfterHeader ?? undefined,
      retryAfterMsHeader ?? undefined,
    )
  }
}

const MAX_OAUTH_ERROR_BODY_BYTES = 64 * 1024

function redactOAuthErrorBody(body: string, additionalSecrets: string[] = []) {
  let redacted = body.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***REDACTED***')
  for (const secret of additionalSecrets) {
    if (secret) redacted = redacted.split(secret).join('***REDACTED***')
  }
  return redacted
}

async function readOAuthErrorBody(
  response: Response,
  additionalSecrets: string[] = [],
) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  let truncated = false
  try {
    while (size < MAX_OAUTH_ERROR_BODY_BYTES) {
      const chunk = await reader.read()
      if (chunk.done) break
      const remaining = MAX_OAUTH_ERROR_BODY_BYTES - size
      const bytes = chunk.value.subarray(0, remaining)
      size += bytes.byteLength
      text += decoder.decode(bytes, { stream: true })
      if (
        chunk.value.byteLength > remaining ||
        size === MAX_OAUTH_ERROR_BODY_BYTES
      ) {
        truncated = true
        await reader.cancel().catch(() => {})
        break
      }
    }
    text += decoder.decode()
  } catch {
    return '<failed to read redacted OAuth response>'
  }
  return `${redactOAuthErrorBody(text, additionalSecrets)}${
    truncated ? '…<truncated>' : ''
  }`
}

export type ClaudeOAuthRefreshResult = {
  access: string
  refresh: string
  expires: number
  expiresIn: number
  refreshTokenExpiresAt?: number
  scopes?: string[]
  accountId?: string
  email?: string
  organizationId?: string
  authLineageId?: string
}

function isTransientNetworkError(error: unknown) {
  if (!(error instanceof Error)) return false
  const code = (error as Error & { code?: unknown }).code
  return (
    error.message.includes('fetch failed') ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  )
}

function abortableWait(
  ms: number,
  signal: AbortSignal,
  setTimeoutImpl: typeof globalThis.setTimeout,
): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeoutImpl(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
  })
}

export async function refreshClaudeOAuthToken(input: {
  refreshToken: string
  refreshTokenExpiresAt?: number
  authLineageId?: string
  fetchImpl?: typeof fetch
  now?: () => number
  maxRetries?: number
  baseDelayMs?: number
  setTimeoutImpl?: typeof globalThis.setTimeout
  signal?: AbortSignal
  /** Whole-operation deadline. Must remain shorter than a refresh lease. */
  timeoutMs?: number
}): Promise<ClaudeOAuthRefreshResult> {
  const fetchImpl = input.fetchImpl ?? fetch
  const maxRetries = input.maxRetries ?? 2
  const baseDelayMs = input.baseDelayMs ?? 500
  const timeoutMs = input.timeoutMs ?? 20_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Claude OAuth refresh timeout must be positive')
  }
  const initialNow = input.now?.() ?? Date.now()

  // Every reach for the token endpoint is recorded, with the caller's stack.
  // Anthropic revokes the whole family when one refresh token is presented
  // twice, so when a family dies the only question that matters is which code
  // paths spent it and in what order — and by then the token itself is gone.
  // A fingerprint plus a call site makes that reconstructable after the fact.
  const spendId = randomUUID().slice(0, 8)
  const refreshFp = tokenFingerprint(input.refreshToken).slice(0, 8)
  logger.info('refresh.spend', 'presenting a refresh token', {
    spendId,
    refreshFp,
    pid: process.pid,
    authLineageId: input.authLineageId,
    maxRetries,
    callSite: new Error().stack
      ?.split('\n')
      .slice(2, 6)
      .map((line) => line.trim())
      .join(' | '),
  })
  if (
    input.refreshTokenExpiresAt !== undefined &&
    !Number.isSafeInteger(input.refreshTokenExpiresAt)
  ) {
    throw new Error('Claude OAuth refresh-token expiry is invalid')
  }
  if (
    typeof input.refreshTokenExpiresAt === 'number' &&
    Number.isFinite(input.refreshTokenExpiresAt) &&
    input.refreshTokenExpiresAt <= initialNow
  ) {
    throw new ClaudeOAuthRefreshTokenExpiredError()
  }
  const setTimeoutImpl = input.setTimeoutImpl ?? globalThis.setTimeout
  const timeoutController = new AbortController()
  const abortTimer = globalThis.setTimeout(
    () => timeoutController.abort(new Error('Claude OAuth refresh timed out')),
    timeoutMs,
  )
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeoutController.signal])
    : timeoutController.signal

  try {
    signal.throwIfAborted()
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = baseDelayMs * 2 ** (attempt - 1)
          await abortableWait(delay, signal, setTimeoutImpl)
        }

        signal.throwIfAborted()
        const response = await fetchImpl(TOKEN_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/plain, */*',
            'User-Agent': AXIOS_USER_AGENT,
          },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: input.refreshToken,
            client_id: getOAuthClientId(),
            scope: REFRESH_SCOPE,
          }),
          signal,
        })

        if (!response.ok) {
          if (response.status >= 500 && attempt < maxRetries) {
            await response.body?.cancel().catch(() => {})
            continue
          }
          const body = await readOAuthErrorBody(response, [input.refreshToken])
          // `invalid_grant` is the family being gone, not a transient failure —
          // the loudest signal that a token was spent twice somewhere. Logged at
          // error so it stands out from ordinary refresh churn.
          const isDeadFamily = body.includes('invalid_grant')
          logger[isDeadFamily ? 'error' : 'warn'](
            'refresh.spend',
            isDeadFamily
              ? 'refresh token rejected — token family is revoked'
              : 'refresh failed',
            {
              spendId,
              refreshFp,
              status: response.status,
              attempt,
              body: body.slice(0, 300),
            },
          )
          throw new ClaudeOAuthRefreshError(
            response.status,
            body,
            response.headers.get('retry-after'),
            response.headers.get('retry-after-ms'),
          )
        }

        const json = (await response.json()) as {
          access_token: string
          refresh_token?: string
          expires_in: number
          refresh_token_expires_in?: number
          scope?: string
          account?: { uuid?: string; email_address?: string }
          organization?: { uuid?: string }
        }
        if (
          typeof json.access_token !== 'string' ||
          !json.access_token ||
          !Number.isFinite(json.expires_in) ||
          json.expires_in <= 0
        ) {
          throw new Error(
            'Claude OAuth refresh returned an invalid token response',
          )
        }
        if (
          json.refresh_token !== undefined &&
          (typeof json.refresh_token !== 'string' || !json.refresh_token)
        ) {
          throw new Error(
            'Claude OAuth refresh returned an invalid refresh token',
          )
        }
        if (
          json.refresh_token_expires_in !== undefined &&
          (typeof json.refresh_token_expires_in !== 'number' ||
            !Number.isFinite(json.refresh_token_expires_in) ||
            json.refresh_token_expires_in <= 0)
        ) {
          throw new Error(
            'Claude OAuth refresh returned an invalid refresh-token expiry',
          )
        }
        const refreshedAt = input.now?.() ?? Date.now()
        const expires = refreshedAt + json.expires_in * 1000
        const refreshTokenExpiresAt =
          typeof json.refresh_token_expires_in === 'number'
            ? refreshedAt + json.refresh_token_expires_in * 1000
            : input.refreshTokenExpiresAt
        if (!Number.isSafeInteger(expires)) {
          throw new Error('Claude OAuth refresh returned an overflowing expiry')
        }
        if (
          refreshTokenExpiresAt !== undefined &&
          !Number.isSafeInteger(refreshTokenExpiresAt)
        ) {
          throw new Error(
            'Claude OAuth refresh returned an overflowing refresh-token expiry',
          )
        }

        // Records the rotation edge: which token was spent and which replaced
        // it. Chained across a log this reconstructs the family's whole lineage,
        // and a fork in it — two spends of the same fingerprint — is exactly the
        // double-spend that gets a family revoked.
        const rotatedTo = json.refresh_token ?? input.refreshToken
        logger.info('refresh.spend', 'refresh succeeded', {
          spendId,
          refreshFp,
          rotatedToFp: tokenFingerprint(rotatedTo).slice(0, 8),
          rotated: rotatedTo !== input.refreshToken,
          expiresInSec: json.expires_in,
          scopes: json.scope,
        })

        return {
          access: json.access_token,
          refresh: json.refresh_token ?? input.refreshToken,
          expires,
          expiresIn: json.expires_in,
          ...(typeof refreshTokenExpiresAt === 'number'
            ? { refreshTokenExpiresAt }
            : {}),
          ...(json.scope
            ? { scopes: json.scope.split(/\s+/).filter(Boolean) }
            : {}),
          ...(json.account?.uuid ? { accountId: json.account.uuid } : {}),
          ...(json.account?.email_address
            ? { email: json.account.email_address }
            : {}),
          ...(json.organization?.uuid
            ? { organizationId: json.organization.uuid }
            : {}),
          authLineageId: input.authLineageId,
        }
      } catch (error) {
        if (error instanceof ClaudeOAuthRefreshError) throw error
        if (attempt < maxRetries && isTransientNetworkError(error)) continue
        throw error
      }
    }

    throw new Error('Token refresh exhausted all retries')
  } finally {
    globalThis.clearTimeout(abortTimer)
  }
}

export type ClaudeOAuthRevokeOutcome = 'revoked' | 'already-inactive'

function parseOAuthErrorCode(body: string) {
  try {
    const parsed = JSON.parse(body) as {
      error?: string | { type?: unknown }
    }
    if (typeof parsed.error === 'string') return parsed.error
    return typeof parsed.error?.type === 'string'
      ? parsed.error.type
      : undefined
  } catch {
    return undefined
  }
}

/** Revoke a Claude OAuth refresh-token family without changing local storage. */
export async function revokeClaudeOAuthToken(input: {
  refreshToken: string
  fetchImpl?: typeof fetch
}): Promise<ClaudeOAuthRevokeOutcome> {
  const fetchImpl = input.fetchImpl ?? fetch
  const response = await fetchImpl(REVOKE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'User-Agent': AXIOS_USER_AGENT,
    },
    body: JSON.stringify({
      token: input.refreshToken,
      token_type_hint: 'refresh_token',
      client_id: getOAuthClientId(),
    }),
  })
  if (response.ok) {
    await response.body?.cancel().catch(() => {})
    return 'revoked'
  }
  const body = await readOAuthErrorBody(response, [input.refreshToken])
  const errorCode = parseOAuthErrorCode(body)
  if (
    response.status === 400 &&
    (errorCode === 'invalid_token' || errorCode === 'invalid_grant')
  ) {
    return 'already-inactive'
  }
  throw new ClaudeOAuthRevokeError(
    response.status,
    body,
    response.headers.get('retry-after'),
    response.headers.get('retry-after-ms'),
  )
}

export type AuthorizationResult = {
  url: string
  redirectUri: string
  state: string
  verifier: string
}

function generateState() {
  return randomBytes(32).toString('base64url')
}

function statesMatch(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  )
}

function parseCallbackInput(input: string) {
  const trimmed = input.trim()

  try {
    const url = new URL(trimmed)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (code && state) {
      return { code, state }
    }
  } catch {
    // Fall through to legacy/manual formats.
  }

  const hashSplits = trimmed.split('#')
  if (hashSplits.length === 2 && hashSplits[0] && hashSplits[1]) {
    return { code: hashSplits[0], state: hashSplits[1] }
  }

  const params = new URLSearchParams(trimmed)
  const code = params.get('code')
  const state = params.get('state')
  if (code && state) {
    return { code, state }
  }

  return null
}

async function exchangeCode(
  callback: CallbackParams,
  verifier: string,
  redirectUri: string,
): Promise<ExchangeResult> {
  const result = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'User-Agent': AXIOS_USER_AGENT,
    },
    body: JSON.stringify({
      code: callback.code,
      state: callback.state,
      grant_type: 'authorization_code',
      client_id: getOAuthClientId(),
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  })

  if (!result.ok) {
    return {
      type: 'failed',
    }
  }

  const json = (await result.json()) as {
    refresh_token: string
    access_token: string
    expires_in: number
    refresh_token_expires_in?: number
    scope?: string
    account?: { uuid?: string; email_address?: string }
    organization?: { uuid?: string }
  }

  if (
    typeof json.access_token !== 'string' ||
    !json.access_token ||
    typeof json.refresh_token !== 'string' ||
    !json.refresh_token ||
    !Number.isFinite(json.expires_in) ||
    json.expires_in <= 0
  ) {
    return { type: 'failed' }
  }
  if (
    json.refresh_token_expires_in !== undefined &&
    (!Number.isFinite(json.refresh_token_expires_in) ||
      json.refresh_token_expires_in <= 0)
  ) {
    return { type: 'failed' }
  }
  const exchangedAt = Date.now()
  const expires = exchangedAt + json.expires_in * 1000
  if (!Number.isSafeInteger(expires)) return { type: 'failed' }
  const refreshTokenExpiresAt =
    typeof json.refresh_token_expires_in === 'number'
      ? exchangedAt + json.refresh_token_expires_in * 1000
      : undefined
  if (
    refreshTokenExpiresAt !== undefined &&
    !Number.isSafeInteger(refreshTokenExpiresAt)
  ) {
    return { type: 'failed' }
  }
  return {
    type: 'success',
    refresh: json.refresh_token,
    access: json.access_token,
    expires,
    ...(typeof refreshTokenExpiresAt === 'number'
      ? { refreshTokenExpiresAt }
      : {}),
    ...(json.scope ? { scopes: json.scope.split(/\s+/).filter(Boolean) } : {}),
    ...(json.account?.uuid ? { accountId: json.account.uuid } : {}),
    ...(json.account?.email_address
      ? { email: json.account.email_address }
      : {}),
    ...(json.organization?.uuid
      ? { organizationId: json.organization.uuid }
      : {}),
  }
}

export async function authorize(
  mode: 'max' | 'console',
  options: {
    redirectUri?: string
    state?: string
    orgUUID?: string
    loginHint?: string
    loginMethod?: string
  } = {},
): Promise<AuthorizationResult> {
  const pkce = await generatePKCE()
  const state = options.state ?? generateState()
  const redirectUri = options.redirectUri?.trim() || CODE_CALLBACK_URL

  const url = new URL(AUTHORIZE_URLS[mode], import.meta.url)
  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', getOAuthClientId())
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', OAUTH_SCOPES.join(' '))
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  if (options.orgUUID?.trim())
    url.searchParams.set('orgUUID', options.orgUUID.trim())
  if (options.loginHint?.trim()) {
    url.searchParams.set('login_hint', options.loginHint.trim())
  }
  if (options.loginMethod?.trim()) {
    url.searchParams.set('login_method', options.loginMethod.trim())
  }

  return {
    url: url.toString(),
    redirectUri,
    state,
    verifier: pkce.verifier,
  }
}

export type ExchangeResult =
  | {
      type: 'success'
      refresh: string
      access: string
      expires: number
      refreshTokenExpiresAt?: number
      scopes?: string[]
      accountId?: string
      email?: string
      organizationId?: string
    }
  | { type: 'failed' }

export async function exchange(
  input: string,
  verifier: string,
  redirectUri: string,
  expectedState?: string,
): Promise<ExchangeResult> {
  const callback = parseCallbackInput(input)
  if (!callback) {
    return {
      type: 'failed',
    }
  }

  if (expectedState && !statesMatch(callback.state, expectedState)) {
    return {
      type: 'failed',
    }
  }

  return exchangeCode(callback, verifier, redirectUri)
}
