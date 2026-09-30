/**
 * OpenCode's view of the machine-wide Anthropic account store.
 *
 * The store (Rust binding, `~/.anthropic-accounts/accounts.json`) is the only
 * custodian of OAuth refresh tokens and of store API keys. This module never
 * writes a token into it except through the one-time
 * `importHostOAuthCredential` migration of the credential OpenCode itself
 * still holds in `auth.json`; after that import the host copy is replaced
 * with {@link STORE_MANAGED_REFRESH_PLACEHOLDER}. Store `api_key` rows are
 * served through the binding's `getApiKey` and never written to host files.
 */
import {
  type AccountOperationError,
  type FallbackAccount,
  getSharedAccessToken,
  getSharedApiKey,
  handleSharedUnauthorized,
  importHostOAuthCredential,
  isStoreManagedRefreshPlaceholder,
  listSharedAccounts,
  logger,
  markSharedAccountUsed,
  materializeSharedFallbackAccounts,
  pickSharedAccount,
  refreshErrorFromSharedAccount,
  type SharedAccountAccess,
  type SharedAnthropicAccount,
  STORE_MANAGED_REFRESH_PLACEHOLDER,
  sharedKeepAliveOnce,
  tokenFingerprint,
  type WifAuth,
} from '@cortexkit/anthropic-auth-core'

/**
 * Everything OpenCode asks of the account store. Production uses the Rust
 * binding; plugin-level tests substitute a fixture store (the store itself is
 * exercised against the real binding in the shared-auth and account tests).
 */
export type StoreAccess = SharedAccountAccess & {
  importCredential: typeof importHostOAuthCredential
  getApiKey: typeof getSharedApiKey
}

const bindingStoreAccess: StoreAccess = {
  getAccessToken: (accountId) => getSharedAccessToken(accountId),
  getApiKey: (accountId) => getSharedApiKey(accountId),
  handleUnauthorized: (accessToken) => handleSharedUnauthorized(accessToken),
  keepAliveOnce: () => sharedKeepAliveOnce(),
  listAccounts: () => listSharedAccounts(),
  markUsed: (accountId) => markSharedAccountUsed(accountId),
  importCredential: (options) => importHostOAuthCredential(options),
}

let storeAccessOverride: Partial<StoreAccess> | undefined

/** Test seam: replace (parts of) the store the plugin talks to. */
export function __setStoreAccessForTests(access?: Partial<StoreAccess>) {
  storeAccessOverride = access
}

export function storeAccess(): StoreAccess {
  return { ...bindingStoreAccess, ...storeAccessOverride }
}

export type OpenCodeAnthropicAuth =
  | {
      type: 'oauth'
      refresh?: string
      access?: string
      expires?: number
      refreshTokenExpiresAt?: number
      scopes?: string[]
      accountId?: string
      email?: string
      organizationId?: string
    }
  | { type: 'api'; key?: string }
  | { type: 'wellknown'; key?: string; token?: string }

export type ResolvedMainAnthropicAuth =
  | {
      type: 'oauth'
      /** Empty when the store could not produce a token (see refreshError). */
      access: string
      expires: number
      key?: undefined
      /** Store row serving as main; absent for static/env credentials. */
      sharedAccountId?: string
      /** The store's verdict when it could not produce a token. */
      refreshError?: AccountOperationError
      source: 'shared' | 'opencode' | 'environment'
    }
  | {
      type: 'api'
      key: string
      access?: undefined
      expires?: undefined
      /** Store `api_key` row serving as main, for `source: 'shared'`. */
      sharedAccountId?: string
      refreshError?: undefined
      source: 'shared' | 'opencode' | 'environment'
    }
  | {
      type: 'wif'
      provider: WifAuth
      key?: undefined
      access?: undefined
      expires?: undefined
      sharedAccountId?: undefined
      refreshError?: undefined
      source: 'wif'
    }

export type ReconciledAnthropicAuth = {
  auth: ResolvedMainAnthropicAuth | null
  fallbacks: FallbackAccount[]
  sharedMain?: SharedAnthropicAccount
  /** The store rows the reconciliation saw (non-secret). */
  accounts: SharedAnthropicAccount[]
}

/** Writes OpenCode's own `auth.json` entry (client.auth.set). */
export type SetOpenCodeAuth = (auth: {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
}) => Promise<void>

function nonEmpty(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed || undefined
}

/**
 * The kind of the store's main credential (`oauth` or `api` for a store API
 * key), or null when the store has none. Cost zeroing follows it.
 */
export async function getSharedAnthropicAuthType() {
  const accounts = await storeAccess().listAccounts()
  const main = pickSharedAccount(accounts)
  if (!main) return null
  return main.kind === 'oauth' ? 'oauth' : 'api'
}

/**
 * The keys of the store `api_key` rows other than main (skipped when the
 * binding cannot hand one out), for materializing them as fallback routes.
 */
async function storeApiKeys(
  accounts: readonly SharedAnthropicAccount[],
  mainId: string | undefined,
): Promise<Map<string, string>> {
  const keys = new Map<string, string>()
  for (const account of accounts) {
    if (account.kind !== 'api_key' || account.id === mainId) continue
    try {
      keys.set(account.id, (await storeAccess().getApiKey(account.id)).apiKey)
    } catch {
      // Disabled or cooling down: not a usable route right now.
    }
  }
  return keys
}

/**
 * Host credentials already handled in this process, keyed by refresh-token
 * fingerprint: `store` when the store now holds the login, `static` when the
 * store rejected it as malformed (then it is used as a fixed bearer).
 */
const hostCredentialOutcomes = new Map<string, 'store' | 'static'>()

/** Test hook: forget which host credentials were already migrated. */
export function resetHostCredentialMigrationForTests() {
  hostCredentialOutcomes.clear()
}

/**
 * One-time move of the credential OpenCode holds in `auth.json` into the store
 * (the store's copy wins when it already has the login). Returns how the host
 * credential should be treated from now on, or undefined when it is not a
 * real OAuth credential.
 */
export async function migrateOpenCodeAuthIntoStore(
  auth: OpenCodeAnthropicAuth,
  setOpenCodeAuth?: SetOpenCodeAuth,
): Promise<'store' | 'static' | undefined> {
  if (auth.type !== 'oauth') return undefined
  const refresh = nonEmpty(auth.refresh)
  const access = nonEmpty(auth.access)
  if (!refresh || isStoreManagedRefreshPlaceholder(refresh)) return undefined
  const key = tokenFingerprint(refresh)
  const known = hostCredentialOutcomes.get(key)
  if (known) return known
  const imported = await storeAccess().importCredential({
    label: nonEmpty(auth.email) ?? 'OpenCode Anthropic',
    accessToken: access ?? '',
    refreshToken: refresh,
    expiresAt:
      typeof auth.expires === 'number' && Number.isFinite(auth.expires)
        ? auth.expires
        : 0,
    ...(typeof auth.refreshTokenExpiresAt === 'number'
      ? { refreshExpiresAt: auth.refreshTokenExpiresAt }
      : {}),
    ...(auth.scopes?.length ? { scopes: auth.scopes } : {}),
    ...(auth.accountId ? { accountUuid: auth.accountId } : {}),
    ...(auth.email ? { email: auth.email } : {}),
    ...(auth.organizationId ? { organizationUuid: auth.organizationId } : {}),
  })
  if (imported.status === 'invalid') {
    hostCredentialOutcomes.set(key, 'static')
    logger.info('auth', 'opencode host credential kept as a static bearer', {
      reason: imported.message,
    })
    return 'static'
  }
  hostCredentialOutcomes.set(key, 'store')
  logger.info('auth', 'opencode host credential moved into the store', {
    status: imported.status,
    accountId: imported.accountId,
  })
  if (setOpenCodeAuth) {
    try {
      await setOpenCodeAuth({
        type: 'oauth',
        access: access ?? '',
        refresh: STORE_MANAGED_REFRESH_PLACEHOLDER,
        expires:
          typeof auth.expires === 'number' && Number.isFinite(auth.expires)
            ? auth.expires
            : 0,
      })
    } catch (error) {
      logger.warn('auth', 'could not replace the opencode host refresh token', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return 'store'
}

function resolveStaticOpenCodeAuth(
  auth: OpenCodeAnthropicAuth,
): ResolvedMainAnthropicAuth | null {
  if (auth.type === 'api') {
    const key = nonEmpty(auth.key)
    return key ? { type: 'api', key, source: 'opencode' } : null
  }
  if (auth.type !== 'oauth') return null
  const access = nonEmpty(auth.access)
  if (!access) return null
  return {
    type: 'oauth',
    access,
    expires:
      typeof auth.expires === 'number' ? auth.expires : Number.MAX_SAFE_INTEGER,
    source: 'opencode',
  }
}

function resolveEnvironmentAuth(): ResolvedMainAnthropicAuth | null {
  const oauth =
    nonEmpty(process.env.ANTHROPIC_OAUTH_TOKEN) ??
    nonEmpty(process.env.ANTHROPIC_AUTH_TOKEN)
  if (oauth) {
    return {
      type: 'oauth',
      access: oauth,
      expires: Number.MAX_SAFE_INTEGER,
      source: 'environment',
    }
  }
  const apiKey = nonEmpty(process.env.ANTHROPIC_API_KEY)
  return apiKey ? { type: 'api', key: apiKey, source: 'environment' } : null
}

/** A live bearer for the store main, or the store's reason it has none. */
async function resolveStoreMain(
  main: SharedAnthropicAccount,
): Promise<ResolvedMainAnthropicAuth> {
  try {
    const token = await storeAccess().getAccessToken(main.id)
    return {
      type: 'oauth',
      access: token.accessToken,
      expires: token.expiresAt,
      sharedAccountId: main.id,
      source: 'shared',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = (error as { code?: unknown }).code
    return {
      type: 'oauth',
      access: '',
      expires: 0,
      sharedAccountId: main.id,
      source: 'shared',
      refreshError: refreshErrorFromSharedAccount(main) ?? {
        message,
        checkedAt: Date.now(),
        permanent: code === 'invalid_grant',
        ...(code === 'invalid_grant' ? { status: 400 } : {}),
      },
    }
  }
}

/**
 * Resolve OpenCode's main credential and fallback list from the store.
 *
 * Order: the store's preferred row (an OAuth account, or a store API key);
 * else OpenCode's own credential when the store could not take it (a static
 * bearer, never refreshed) or it is an API key; else the environment; else
 * workload identity. Fallbacks are the host's configured list over the store
 * rows (store API keys as first-party routes), minus main.
 */
export async function reconcileAnthropicAuth(input: {
  openCodeAuth: OpenCodeAnthropicAuth
  legacyAccounts: readonly FallbackAccount[]
  wifAuth?: WifAuth | null
  setOpenCodeAuth?: SetOpenCodeAuth
}): Promise<ReconciledAnthropicAuth> {
  const hostOutcome = await migrateOpenCodeAuthIntoStore(
    input.openCodeAuth,
    input.setOpenCodeAuth,
  ).catch((error) => {
    logger.warn('auth', 'opencode host credential import deferred', {
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  })
  const accounts = await storeAccess().listAccounts()
  const sharedMain = pickSharedAccount(accounts)

  let auth: ResolvedMainAnthropicAuth | null = null
  if (sharedMain?.kind === 'api_key') {
    auth = await storeAccess()
      .getApiKey(sharedMain.id)
      .then(
        (credential): ResolvedMainAnthropicAuth => ({
          type: 'api',
          key: credential.apiKey,
          sharedAccountId: sharedMain.id,
          source: 'shared',
        }),
      )
      .catch(() => null)
  } else if (sharedMain) {
    auth = await resolveStoreMain(sharedMain)
  } else if (
    input.openCodeAuth.type === 'api' ||
    hostOutcome === 'static' ||
    (input.openCodeAuth.type === 'oauth' &&
      isStoreManagedRefreshPlaceholder(nonEmpty(input.openCodeAuth.refresh)))
  ) {
    auth = resolveStaticOpenCodeAuth(input.openCodeAuth)
  }
  auth ??=
    resolveEnvironmentAuth() ??
    (input.wifAuth
      ? { type: 'wif', provider: input.wifAuth, source: 'wif' }
      : null)

  return {
    auth,
    fallbacks: materializeSharedFallbackAccounts(
      input.legacyAccounts,
      accounts,
      {
        mainId: sharedMain?.id,
        apiKeys: await storeApiKeys(accounts, sharedMain?.id),
      },
    ),
    sharedMain,
    accounts,
  }
}
