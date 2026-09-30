/**
 * Pi's view of the machine-wide Anthropic credential.
 *
 * The shared account store (the Rust binding behind
 * `@cortexkit/anthropic-auth-core`) is the only custodian of refresh tokens:
 * it selects, refreshes (claimed, compare-and-swap, fail-closed) and records
 * dead tokens. Pi's own `auth.json` only ever holds the access token plus
 * {@link STORE_MANAGED_REFRESH_PLACEHOLDER} in place of a refresh token, so a
 * refresh Pi asks for is answered from the store and nothing here presents a
 * refresh token to Anthropic.
 *
 * This file used to carry a complete TS refresh (store claim, retries, a
 * process-local dead-token set, native Claude Code publish). That code was
 * deleted with the move to the binding.
 *
 * Lives apart from `index.ts` because `stream.ts` needs it too: `index.ts`
 * already imports `stream.ts`, so putting it there and importing it back
 * would close an import cycle.
 */
import {
  type AccessToken,
  getSharedAccessToken,
  importHostOAuthCredential,
  isAnthropicAuthError,
  isStoreManagedRefreshPlaceholder,
  listSharedAccounts,
  logger,
  pickSharedAccount,
  type SharedAnthropicAccount,
  STORE_MANAGED_REFRESH_PLACEHOLDER,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import type { OAuthCredentials } from '@earendil-works/pi-ai'
import {
  errorHttpStatus,
  type TraceSpan,
  withAuthSpan,
} from './trace-bridge.ts'

/** Why a refresh was attempted; recorded on the `auth.refresh` span. */
export type RefreshReason = 'expired' | 'preemptive' | 'forced' | '401-retry'

export type RefreshOutcome = 'ok' | 'refused' | 'revoked' | 'error'

/**
 * A stable, non-secret handle for an account in span attributes. Store ids
 * are opaque (`pi-main`, an account uuid), but an id that looks like an
 * address is hashed so the trace log never carries an email.
 */
export function accountSpanId(id: string): string {
  return id.includes('@') ? tokenFingerprint(id).slice(0, 8) : id
}

/**
 * Classify a failure for the span. `revoked` is the token family being gone
 * (nothing to retry); `refused` is the store declining to serve (no account,
 * reserve, bad input, a malformed token, an unreadable store); `error` is
 * everything the network did to us.
 */
function classifyRefreshFailure(error: unknown): RefreshOutcome {
  if (isAnthropicAuthError(error, 'invalid_grant')) return 'revoked'
  if (
    isAnthropicAuthError(error, 'auth_required') ||
    isAnthropicAuthError(error, 'quota_reserve') ||
    isAnthropicAuthError(error, 'config') ||
    isAnthropicAuthError(error, 'invalid_token') ||
    isAnthropicAuthError(error, 'store_corrupt')
  ) {
    return 'refused'
  }
  return 'error'
}

/** An enabled OAuth row whose stored access token is live right now. */
export function sharedCredentialIsLive(
  account: SharedAnthropicAccount,
  now: number,
) {
  return (
    account.kind === 'oauth' &&
    account.enabled &&
    account.accessLive &&
    (typeof account.expiresAt !== 'number' || account.expiresAt > now)
  )
}

/**
 * The account Pi should use: the store's preferred available account when its
 * token is live, else any available account with a live token, else the
 * preferred one (the store refreshes it on demand).
 */
export function currentSharedAccount(
  accounts: readonly SharedAnthropicAccount[],
  now = Date.now(),
): SharedAnthropicAccount | undefined {
  const oauth = accounts.filter((account) => account.kind === 'oauth')
  const preferred = pickSharedAccount(oauth)
  if (preferred && sharedCredentialIsLive(preferred, now)) return preferred
  return (
    oauth.find(
      (account) => account.available && sharedCredentialIsLive(account, now),
    ) ?? preferred
  )
}

/**
 * Store account ids by the access token the store handed out, so a quota
 * reading or a 401 can be attributed to the row it belongs to without ever
 * holding a refresh token. Bounded; oldest first out.
 */
const storeAccountByAccessToken = new Map<string, string>()
const REMEMBERED_TOKENS_LIMIT = 64

export function rememberStoreAccessToken(token: AccessToken) {
  storeAccountByAccessToken.delete(token.accessToken)
  storeAccountByAccessToken.set(token.accessToken, token.accountId)
  while (storeAccountByAccessToken.size > REMEMBERED_TOKENS_LIMIT) {
    const oldest = storeAccountByAccessToken.keys().next().value
    if (oldest === undefined) break
    storeAccountByAccessToken.delete(oldest)
  }
}

/** The store row a remembered access token belongs to, if known. */
export function storeAccountIdForAccessToken(accessToken: string) {
  return storeAccountByAccessToken.get(accessToken)
}

/** Pi credentials for a store token: never a real refresh token. */
export function hostCredentialsFor(token: AccessToken): OAuthCredentials {
  rememberStoreAccessToken(token)
  return {
    access: token.accessToken,
    refresh: STORE_MANAGED_REFRESH_PLACEHOLDER,
    expires: token.expiresAt,
  }
}

export interface RefreshAnthropicTokenOptions {
  signal?: AbortSignal
  /** Defaults to `expired` or `preemptive` from the credential's expiry. */
  reason?: RefreshReason
}

/**
 * Pi's `oauth.refreshToken`. Answers from the store:
 *
 * - A credential still carrying a real refresh token (written by an older
 *   version) is moved into the store once with `importOAuthAccount`; when the
 *   store already holds that login its copy wins. The returned credential
 *   carries the placeholder, so Pi never writes the real token again.
 * - The store then hands out a live access token for that account (or its
 *   own preferred account), refreshing it itself when it has expired.
 */
export async function refreshAnthropicToken(
  credentials: OAuthCredentials,
  optionsOrSignal: AbortSignal | RefreshAnthropicTokenOptions = {},
): Promise<OAuthCredentials> {
  const options =
    optionsOrSignal instanceof AbortSignal
      ? { signal: optionsOrSignal }
      : optionsOrSignal
  const reason =
    options.reason ??
    (typeof credentials.expires === 'number' &&
    credentials.expires <= Date.now()
      ? 'expired'
      : 'preemptive')
  return withAuthSpan(
    'auth.refresh',
    { 'auth.reason': reason, 'auth.account': 'store' },
    async (span) => {
      try {
        const rotated = await resolveFromStore(credentials, options, span)
        span.setAttributes({ 'auth.outcome': 'ok' })
        return rotated
      } catch (error) {
        if (span.attrs['auth.outcome'] === undefined) {
          span.setAttributes({ 'auth.outcome': classifyRefreshFailure(error) })
        }
        span.setAttributes({ 'http.status': errorHttpStatus(error) })
        throw error
      }
    },
  )
}

async function resolveFromStore(
  credentials: OAuthCredentials,
  options: RefreshAnthropicTokenOptions,
  span: TraceSpan,
): Promise<OAuthCredentials> {
  options.signal?.throwIfAborted()
  let accountId: string | undefined
  const refresh = credentials.refresh?.trim()
  if (refresh && !isStoreManagedRefreshPlaceholder(refresh)) {
    const imported = await importHostOAuthCredential({
      accessToken: credentials.access ?? '',
      refreshToken: refresh,
      expiresAt:
        typeof credentials.expires === 'number' &&
        Number.isFinite(credentials.expires)
          ? credentials.expires
          : 0,
    })
    if (imported.status === 'invalid') {
      logger.warn('pi-auth', 'host credential rejected by the account store', {
        error: imported.message,
      })
      span.setAttributes({ 'auth.outcome': 'refused' })
      throw new Error(
        'Pi holds an Anthropic credential the account store cannot use; log in again (run `/login anthropic` in Pi)',
      )
    }
    accountId = imported.accountId
    logger.info('pi-auth', 'moved the host credential into the store', {
      accountId,
      status: imported.status,
    })
    span.setAttributes({ 'auth.source': `import-${imported.status}` })
  } else {
    accountId = currentSharedAccount(await listSharedAccounts())?.id
  }
  options.signal?.throwIfAborted()
  const token = await getSharedAccessToken(accountId)
  span.setAttributes({
    'auth.account': accountSpanId(token.accountId),
    'auth.source': span.attrs['auth.source'] ?? `store-${token.source}`,
  })
  return hostCredentialsFor(token)
}
