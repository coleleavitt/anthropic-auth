/**
 * The machine-wide Anthropic account store, served by the Rust binding
 * (`@coleleavitt/anthropic-napi`).
 *
 * Everything that touches `~/.anthropic-accounts/accounts.json` goes through
 * the binding: listing, selection, refresh (claimed, compare-and-swap,
 * fail-closed), dead-token bookkeeping, keep-alive, login token exchange and
 * the one-time import of host-held credentials. **Refresh tokens never cross
 * into JavaScript**; no value returned here carries one, and the only call
 * that accepts one ({@link importHostOAuthCredential}) moves it into the store.
 *
 * This module used to be a TypeScript reader/writer of the same file with its
 * own lock, refresh claim and legacy-file migration. That code was deleted:
 * two implementations of one protocol drifted apart and together produced the
 * stale `invalid_grant` flags, lost updates and fail-open refreshes described
 * in ckl docs/replacement/23-oauth-store-invalid-grant.md. The store path
 * helpers below remain because hosts show the path and pass it to the binding.
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type {
  AccessToken,
  AccountInfo,
  AuthConfig,
  ErrorCode,
  ImportOAuthAccountOptions,
  ImportResult,
  KeepAliveOnceOptions,
  KeepAliveResult,
  UnauthorizedResult,
} from '@coleleavitt/anthropic-napi'

// The binding is a CommonJS package with a native addon. `createRequire`
// loads it the same way under Bun (OpenCode) and Node ESM (Pi), where named
// ESM imports of a CommonJS module are not guaranteed.
const napi: typeof import('@coleleavitt/anthropic-napi') = createRequire(
  import.meta.url,
)('@coleleavitt/anthropic-napi')

export type {
  AccessToken,
  AccountInfo,
  AuthConfig,
  ImportOAuthAccountOptions,
  ImportResult,
  KeepAliveOnceOptions,
  KeepAliveResult,
  UnauthorizedResult,
}
export type AnthropicAuthErrorCode = ErrorCode
export const AnthropicAuth = napi.AnthropicAuth
export type AnthropicAuth = InstanceType<typeof napi.AnthropicAuth>
export const AnthropicAuthError = napi.AnthropicAuthError
export type AnthropicAuthError = InstanceType<typeof napi.AnthropicAuthError>

export const SHARED_ACCOUNT_STORE_FILE_ENV = 'ANTHROPIC_ACCOUNTS_FILE'
export const SHARED_ACCOUNT_STORE_DIR_ENV = 'ANTHROPIC_ACCOUNTS_DIR'
export const SHARED_ACCOUNT_STORE_DIR_NAME = '.anthropic-accounts'
export const SHARED_ACCOUNT_STORE_FILE_NAME = 'accounts.json'

/** Token endpoint override (tests point it at a local mock server). */
export const ANTHROPIC_OAUTH_TOKEN_URL_ENV = 'ANTHROPIC_OAUTH_TOKEN_URL'
/** Claude.ai authorize URL override. */
export const ANTHROPIC_OAUTH_AUTHORIZE_URL_ENV = 'ANTHROPIC_OAUTH_AUTHORIZE_URL'
/** Console authorize URL override. */
export const ANTHROPIC_OAUTH_CONSOLE_AUTHORIZE_URL_ENV =
  'ANTHROPIC_OAUTH_CONSOLE_AUTHORIZE_URL'

/**
 * One store row, non-secret fields only (the binding's `AccountInfo`). The
 * name is kept from the TS store it replaces; the token fields are gone.
 */
export type SharedAnthropicAccount = AccountInfo

function nonEmptyEnvironmentPath(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value || undefined
}

export function getSharedAccountStoreDirectory() {
  return (
    nonEmptyEnvironmentPath(SHARED_ACCOUNT_STORE_DIR_ENV) ??
    join(homedir(), SHARED_ACCOUNT_STORE_DIR_NAME)
  )
}

export function getSharedAccountStorePath(explicitPath?: string) {
  const explicit = explicitPath?.trim()
  if (explicit) return explicit
  const environment = nonEmptyEnvironmentPath(SHARED_ACCOUNT_STORE_FILE_ENV)
  if (environment) return environment
  const environmentDirectory = nonEmptyEnvironmentPath(
    SHARED_ACCOUNT_STORE_DIR_ENV,
  )
  if (environmentDirectory) {
    return join(environmentDirectory, SHARED_ACCOUNT_STORE_FILE_NAME)
  }
  if (process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR) {
    const testSidecar = nonEmptyEnvironmentPath('OPENCODE_ANTHROPIC_AUTH_FILE')
    if (testSidecar) {
      return join(dirname(testSidecar), 'shared-anthropic-accounts.json')
    }
  }
  return join(getSharedAccountStoreDirectory(), SHARED_ACCOUNT_STORE_FILE_NAME)
}

/**
 * The binding configuration for the current environment. The store path is
 * resolved here and always passed explicitly, so the Rust side never falls
 * back to its own `$HOME` lookup.
 */
export function anthropicAuthConfig(
  overrides: Partial<AuthConfig> = {},
): AuthConfig {
  const config: AuthConfig = { storePath: getSharedAccountStorePath() }
  const tokenUrl = nonEmptyEnvironmentPath(ANTHROPIC_OAUTH_TOKEN_URL_ENV)
  const authorizeUrl = nonEmptyEnvironmentPath(
    ANTHROPIC_OAUTH_AUTHORIZE_URL_ENV,
  )
  const consoleAuthorizeUrl = nonEmptyEnvironmentPath(
    ANTHROPIC_OAUTH_CONSOLE_AUTHORIZE_URL_ENV,
  )
  if (tokenUrl) config.tokenUrl = tokenUrl
  if (authorizeUrl) config.authorizeUrl = authorizeUrl
  if (consoleAuthorizeUrl) config.consoleAuthorizeUrl = consoleAuthorizeUrl
  return { ...config, ...overrides }
}

let cachedAuth: { key: string; auth: AnthropicAuth } | undefined

/** Whether this process is a test run (Bun and Node set NODE_ENV=test). */
function runningUnderTest() {
  return Boolean(
    process.env.ANTHROPIC_AUTH_TEST_ISOLATED ||
      process.env.ANTHROPIC_OAUTH_TEST_MODE ||
      process.env.NODE_ENV === 'test',
  )
}

/**
 * Construct a binding handle. Under test the handle must be in the binding's
 * OAuth test mode (every OAuth call to a non-loopback host is refused before
 * a byte is sent); otherwise construction is refused, so a test can never
 * refresh a fixture token against production.
 */
const inFlightStoreCalls = new Set<Promise<unknown>>()

/**
 * A handle whose async calls are tracked until they settle. Bun (1.4 canary)
 * crashed at process exit (segfault/abort) when a Node-API async call into
 * the binding was still outstanding; hosts and the test preload await
 * {@link settleStoreCalls} before exiting.
 */
function trackedAuth(auth: AnthropicAuth): AnthropicAuth {
  return new Proxy(auth, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(
          target,
          args,
        )
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          const pending = Promise.resolve(result)
          inFlightStoreCalls.add(pending)
          const forget = () => inFlightStoreCalls.delete(pending)
          pending.then(forget, forget)
        }
        return result
      }
    },
  })
}

/** Resolve once no call into the binding is outstanding. */
export async function settleStoreCalls(): Promise<void> {
  while (inFlightStoreCalls.size) {
    await Promise.allSettled([...inFlightStoreCalls])
  }
}

;(globalThis as Record<string, unknown>).__anthropicAuthSettleStoreCalls =
  settleStoreCalls

function createAnthropicAuth(config: AuthConfig): AnthropicAuth {
  const auth = trackedAuth(new AnthropicAuth(config))
  if (runningUnderTest() && auth.testMode !== true) {
    throw new Error(
      'refusing to use the Anthropic account store under test without ANTHROPIC_OAUTH_TEST_MODE=1',
    )
  }
  return auth
}

/**
 * The shared handle. Recreated whenever the resolved configuration changes (a
 * test switching store path or mock endpoint), otherwise reused.
 */
export function getAnthropicAuth(): AnthropicAuth {
  const config = anthropicAuthConfig()
  const key = JSON.stringify(config)
  if (cachedAuth?.key !== key) {
    cachedAuth = { key, auth: createAnthropicAuth(config) }
  }
  return cachedAuth.auth
}

/** Whether `error` is a binding error, optionally of one class. */
export function isAnthropicAuthError(
  error: unknown,
  code?: AnthropicAuthErrorCode,
): error is AnthropicAuthError {
  return (
    error instanceof AnthropicAuthError &&
    (code === undefined || error.code === code)
  )
}

/** Every store row, non-secret fields only. */
export function listSharedAccounts(): Promise<SharedAnthropicAccount[]> {
  return getAnthropicAuth().listAccounts()
}

/**
 * Whether this account can currently serve a request: enabled, not cooling
 * down after a 429 and not quota-exhausted (the binding's `available`).
 */
export function sharedAccountIsAvailable(account: SharedAnthropicAccount) {
  return account.enabled && account.available
}

/**
 * The store's preferred account: the pinned `current` when it can serve,
 * otherwise the first available row. `current` is a preference, not a pin.
 */
export function pickSharedAccount(
  accounts: readonly SharedAnthropicAccount[],
): SharedAnthropicAccount | undefined {
  const available = accounts.filter(sharedAccountIsAvailable)
  return available.find((account) => account.current) ?? available[0]
}

/**
 * A live bearer for `accountId` (or the store's own choice when omitted).
 * Refresh, peer adoption and the dead-token check happen in Rust.
 */
export function getSharedAccessToken(
  accountId?: string,
  options: { allowlist?: string[]; reservePct?: number } = {},
): Promise<AccessToken> {
  return getAnthropicAuth().getAccessToken({
    ...(accountId ? { account: accountId } : {}),
    ...(options.allowlist ? { allowlist: options.allowlist } : {}),
    ...(typeof options.reservePct === 'number'
      ? { reservePct: options.reservePct }
      : {}),
  })
}

/** One claimed refresh after an upstream 401; retry only on a new bearer. */
export function handleSharedUnauthorized(
  accessToken: string,
): Promise<UnauthorizedResult> {
  return getAnthropicAuth().handleUnauthorized({ accessToken })
}

/** One keep-alive pass over idle accounts (one owner per machine). */
export function sharedKeepAliveOnce(
  options?: KeepAliveOnceOptions,
): Promise<KeepAliveResult> {
  return getAnthropicAuth().keepAliveOnce(options ?? null)
}

export function setSharedAccountEnabled(id: string, enabled: boolean) {
  return getAnthropicAuth().setAccountEnabled(id, enabled)
}

export function removeSharedAccount(id: string) {
  return getAnthropicAuth().removeAccount(id)
}

/** Listed ids first, in order, then the rest. */
export function reorderSharedAccounts(orderedIds: string[]) {
  return getAnthropicAuth().reorderAccounts(orderedIds)
}

export function setSharedCurrentAccount(id: string) {
  return getAnthropicAuth().setCurrent(id)
}

export function markSharedAccountUsed(id: string) {
  return getAnthropicAuth().markUsed(id)
}

export function markSharedAccountRateLimited(input: {
  accountId: string
  until?: number
  retryAfterMs?: number
}) {
  return getAnthropicAuth().markRateLimited(input)
}

/**
 * Record a plan-window reading so selection can skip an exhausted account.
 * Resolves the account id the reading landed on, or null.
 */
export function recordSharedAccountQuota(
  id: string,
  quota: {
    fiveHourPercent?: number
    sevenDayPercent?: number
    checkedAt?: number
  },
) {
  return getAnthropicAuth().recordQuota({
    accountId: id,
    ...(Number.isFinite(quota.fiveHourPercent)
      ? { fiveHourPercent: quota.fiveHourPercent }
      : {}),
    ...(Number.isFinite(quota.sevenDayPercent)
      ? { sevenDayPercent: quota.sevenDayPercent }
      : {}),
    ...(Number.isFinite(quota.checkedAt) ? { checkedAt: quota.checkedAt } : {}),
  })
}

/** Record unified rate-limit headers against the row holding `accessToken`. */
export function recordSharedQuotaHeaders(
  accessToken: string,
  headers: Record<string, string>,
) {
  return getAnthropicAuth().recordQuotaHeaders({ accessToken, headers })
}

export type ImportHostCredentialResult =
  | ImportResult
  | { status: 'invalid'; message: string }

/**
 * The store's token shape (`sk-ant-oat<digits>-<20+ url-safe chars>` for
 * access, `sk-ant-ort…` for refresh, at most 500 bytes); mirrors the Rust
 * validator so a malformed token is recognised before the binding is asked.
 */
export function isWellFormedOAuthToken(
  value: string | undefined,
  kind: 'access' | 'refresh',
): boolean {
  if (!value || value.length > 500) return false
  const prefix = kind === 'access' ? 'sk-ant-oat' : 'sk-ant-ort'
  return new RegExp(`^${prefix}\\d+-[A-Za-z0-9_-]{20,}$`).test(value)
}

/**
 * One-time migration of a credential a host still holds. The store is the
 * custodian: when it already has this login, its copy wins (`kept`). A token
 * that is not a well-formed OAuth token is reported as `invalid` without
 * touching the store; every binding failure (an unreadable store included)
 * throws so the caller keeps the credential and retries later.
 */
export async function importHostOAuthCredential(
  options: ImportOAuthAccountOptions,
): Promise<ImportHostCredentialResult> {
  if (
    !isWellFormedOAuthToken(options.accessToken, 'access') ||
    !isWellFormedOAuthToken(options.refreshToken, 'refresh')
  ) {
    return {
      status: 'invalid',
      message: 'not a well-formed OAuth access/refresh token pair',
    }
  }
  return getAnthropicAuth().importOAuthAccount(options)
}

export type SharedLoginMode = 'max' | 'console'

export type SharedLogin = {
  url: string
  state: string
  loginId: string
  /** Exchange the code (in Rust) and store the account. */
  complete: (input: {
    callback: string
    label?: string
    setCurrent?: boolean
  }) => Promise<SharedAnthropicAccount>
}

/**
 * Begin an OAuth PKCE login. The verifier stays in Rust; `complete` exchanges
 * the code and writes the account into the store. A loopback login passes its
 * `redirectUri`, which gets a dedicated handle so the authorize URL and the
 * code exchange agree on it.
 */
export function startSharedLogin(
  options: {
    mode?: SharedLoginMode
    redirectUri?: string
    loginHint?: string
  } = {},
): SharedLogin {
  const auth = options.redirectUri
    ? createAnthropicAuth(
        anthropicAuthConfig({ redirectUri: options.redirectUri }),
      )
    : getAnthropicAuth()
  const started = auth.startLogin({
    mode: options.mode ?? 'max',
    ...(options.loginHint ? { loginHint: options.loginHint } : {}),
  })
  return {
    url: started.url,
    state: started.state,
    loginId: started.loginId,
    complete: (input) =>
      auth.completeLogin({
        loginId: started.loginId,
        callback: input.callback,
        ...(input.label ? { label: input.label } : {}),
        ...(typeof input.setCurrent === 'boolean'
          ? { setCurrent: input.setCurrent }
          : {}),
      }),
  }
}

/**
 * What hosts that insist on a refresh token in their own auth file (OpenCode
 * and Pi `auth.json`) receive instead of the real one. The real refresh token
 * lives only in the store.
 */
export const STORE_MANAGED_REFRESH_PLACEHOLDER = 'managed-by-anthropic-accounts'

export function isStoreManagedRefreshPlaceholder(value: string | undefined) {
  return value === STORE_MANAGED_REFRESH_PLACEHOLDER
}
