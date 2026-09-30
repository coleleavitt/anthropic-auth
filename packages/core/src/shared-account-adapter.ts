import {
  type ApiKeyAccount,
  type FallbackAccount,
  type OAuthAccount,
  refreshErrorFromSharedAccount,
} from './accounts.ts'
import type { SharedAnthropicAccount } from './shared-account-store.ts'

export const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com'

export function isFirstPartyAnthropicApiAccount(account: ApiKeyAccount) {
  const baseURL = account.baseURL.trim().replace(/\/+$/, '')
  return (
    (baseURL === ANTHROPIC_API_BASE_URL ||
      baseURL === `${ANTHROPIC_API_BASE_URL}/v1`) &&
    account.authHeader === 'x-api-key'
  )
}

/**
 * The host view of a store row: identity, routing flags and the store's
 * refresh verdict, but no token. `access`/`expires` are hydrated just before
 * use (`FallbackAccountManager.ensureAccessToken`); host-only runtime fields
 * (quota, profile, prime counters, lineage) carry over from `existing`.
 */
export function sharedAccountToFallback(
  account: SharedAnthropicAccount,
  existing?: FallbackAccount,
  now = Date.now(),
): OAuthAccount {
  const existingOAuth = existing?.type === 'oauth' ? existing : undefined
  return {
    id: account.id,
    label: account.label ?? existingOAuth?.label ?? account.email,
    type: 'oauth',
    enabled: account.enabled,
    addedAt: existingOAuth?.addedAt,
    lastUsed: account.lastUsedAt ?? existingOAuth?.lastUsed,
    refreshExpires: account.refreshExpiresAt,
    lastRefreshedAt: account.lastRefreshedAt,
    lastRefreshError: refreshErrorFromSharedAccount(account, now),
    authLineageId: existingOAuth?.authLineageId,
    lastQuotaRefreshError: existingOAuth?.lastQuotaRefreshError,
    quota: existingOAuth?.quota,
    profile: existingOAuth?.profile,
    prime: existingOAuth?.prime,
  } satisfies OAuthAccount
}

/**
 * The host view of a store `api_key` row, with the key the binding handed
 * out. It is first-party (`x-api-key` against the Anthropic API) and
 * `storeManaged`, so the key is never written to the host files.
 */
export function sharedApiKeyToFallback(
  account: SharedAnthropicAccount,
  apiKey: string,
  existing?: FallbackAccount,
): ApiKeyAccount {
  const existingApi = existing?.type === 'api' ? existing : undefined
  return {
    id: account.id,
    label: account.label ?? existingApi?.label,
    type: 'api',
    apiKey,
    baseURL: ANTHROPIC_API_BASE_URL,
    authHeader: 'x-api-key',
    enabled: account.enabled,
    addedAt: existingApi?.addedAt,
    lastUsed: account.lastUsedAt ?? existingApi?.lastUsed,
    storeManaged: true,
  } satisfies ApiKeyAccount
}

/**
 * The host's fallback list over the store.
 *
 * Fallback order is routing priority — the router walks `storage.accounts` in
 * order — and the list is written back to the host config, so the configured
 * order is kept: store rows the host already lists stay where they are, rows
 * it has never seen are appended in store order.
 *
 * The store is the only custodian of OAuth credentials, so a host OAuth entry
 * with no store row (removed elsewhere, or never migrated) is dropped, and
 * the `mainId` row is served as main, never as its own fallback. Store
 * `api_key` rows are materialized as first-party `x-api-key` routes when
 * `apiKeys` carries their key (the binding's `getApiKey`); a store-managed
 * host entry whose row is gone is dropped. Host-owned API routes (custom
 * proxies) stay as they are, and a store key is never attached to a host
 * route that happens to share its id.
 */
export function materializeSharedFallbackAccounts(
  legacyAccounts: readonly FallbackAccount[],
  accounts: readonly SharedAnthropicAccount[],
  options: {
    mainId?: string
    now?: number
    apiKeys?: ReadonlyMap<string, string>
  } = {},
): FallbackAccount[] {
  const now = options.now ?? Date.now()
  const hostRoutes = new Set(
    legacyAccounts
      .filter((account) => account.type === 'api' && !account.storeManaged)
      .map((account) => account.id),
  )
  const sharedById = new Map(
    accounts
      .filter(
        (account) =>
          account.id !== options.mainId &&
          (account.kind === 'oauth' ||
            (account.kind === 'api_key' &&
              options.apiKeys?.has(account.id) &&
              !hostRoutes.has(account.id))),
      )
      .map((account) => [account.id, account] as const),
  )
  const materialize = (
    account: SharedAnthropicAccount,
    existing?: FallbackAccount,
  ): FallbackAccount =>
    account.kind === 'api_key'
      ? sharedApiKeyToFallback(
          account,
          options.apiKeys?.get(account.id) ?? '',
          existing,
        )
      : sharedAccountToFallback(account, existing, now)

  const emitted = new Set<string>()
  const ordered: FallbackAccount[] = []
  for (const legacy of legacyAccounts) {
    if (legacy.type === 'api' && !legacy.storeManaged) {
      ordered.push(legacy)
      continue
    }
    const shared = sharedById.get(legacy.id)
    if (!shared || emitted.has(shared.id)) continue
    ordered.push(materialize(shared, legacy))
    emitted.add(shared.id)
  }

  for (const account of sharedById.values()) {
    if (emitted.has(account.id)) continue
    ordered.push(materialize(account))
  }

  return ordered
}
