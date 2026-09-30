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
 * The host's fallback list over the store.
 *
 * Fallback order is routing priority — the router walks `storage.accounts` in
 * order — and the list is written back to the host config, so the configured
 * order is kept: store rows the host already lists stay where they are, rows
 * it has never seen are appended in store order.
 *
 * The store is the only custodian of OAuth credentials, so a host OAuth entry
 * with no store row (removed elsewhere, or never migrated) is dropped, and
 * the `mainId` row is served as main, never as its own fallback. API-key
 * routes stay host-owned: the binding does not hand out API keys, so store
 * `api_key` rows are not materialized.
 */
export function materializeSharedFallbackAccounts(
  legacyAccounts: readonly FallbackAccount[],
  accounts: readonly SharedAnthropicAccount[],
  options: { mainId?: string; now?: number } = {},
): FallbackAccount[] {
  const now = options.now ?? Date.now()
  const sharedById = new Map(
    accounts
      .filter(
        (account) => account.kind === 'oauth' && account.id !== options.mainId,
      )
      .map((account) => [account.id, account] as const),
  )

  const emitted = new Set<string>()
  const ordered: FallbackAccount[] = []
  for (const legacy of legacyAccounts) {
    if (legacy.type === 'api') {
      ordered.push(legacy)
      continue
    }
    const shared = sharedById.get(legacy.id)
    if (!shared || emitted.has(shared.id)) continue
    ordered.push(sharedAccountToFallback(shared, legacy, now))
    emitted.add(shared.id)
  }

  for (const account of sharedById.values()) {
    if (emitted.has(account.id)) continue
    ordered.push(sharedAccountToFallback(account, undefined, now))
  }

  return ordered
}
