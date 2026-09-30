import { randomBytes, timingSafeEqual } from 'node:crypto'

import {
  AUTHORIZE_URLS,
  AXIOS_USER_AGENT,
  CODE_CALLBACK_URL,
  getOAuthClientId,
  OAUTH_SCOPES,
  TOKEN_URL,
} from './constants.ts'
import { generatePKCE } from './pkce.ts'

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

/**
 * Build a PKCE authorize URL in TypeScript.
 *
 * Subscription logins (`max`) go through the Rust binding
 * (`startSharedLogin`), which keeps the verifier and the exchanged tokens out
 * of JavaScript. This remains only for the Console "Create an API Key" flow:
 * its OAuth token is used once to mint an API key and must not become a store
 * account, and the binding has no non-persisting exchange (binding gap).
 */
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

/**
 * Exchange an authorization code in TypeScript. Only for the Console API-key
 * mint; see {@link authorize}.
 */
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
