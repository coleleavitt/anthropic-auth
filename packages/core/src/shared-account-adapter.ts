import type {
  ApiKeyAccount,
  FallbackAccount,
  OAuthAccount,
} from './accounts.ts'
import {
  findSharedAccountByCredential,
  loadSharedAccountStore,
  pickSharedAccount,
  type SharedAccountStoreOptions,
  type SharedAnthropicAccount,
  type SharedAnthropicAccountStore,
  type SharedAnthropicCredential,
  updateSharedAccountStore,
} from './shared-account-store.ts'

export const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com'

export function isFirstPartyAnthropicApiAccount(account: ApiKeyAccount) {
  const baseURL = account.baseURL.trim().replace(/\/+$/, '')
  return (
    (baseURL === ANTHROPIC_API_BASE_URL ||
      baseURL === `${ANTHROPIC_API_BASE_URL}/v1`) &&
    account.authHeader === 'x-api-key'
  )
}

function toIsoString(timestamp: number | undefined, fallback: number) {
  const value =
    typeof timestamp === 'number' && Number.isFinite(timestamp)
      ? timestamp
      : Number.isFinite(fallback)
        ? fallback
        : Date.now()
  return new Date(value).toISOString()
}

export function fallbackAccountToShared(
  account: FallbackAccount,
  existing?: SharedAnthropicAccount,
  now = Date.now(),
): SharedAnthropicAccount {
  let credential: SharedAnthropicCredential
  if (account.type === 'oauth') {
    const access = account.access?.trim()
    if (!access) {
      throw new Error(`OAuth account ${account.id} has no access token`)
    }
    if (
      typeof account.expires !== 'number' ||
      !Number.isFinite(account.expires)
    ) {
      throw new Error(`OAuth account ${account.id} has no expiry`)
    }
    credential = {
      type: 'oauth',
      access,
      refresh: account.refresh,
      expires_at: account.expires,
      refresh_expires_at:
        account.refreshExpires ??
        (existing?.credential.type === 'oauth'
          ? existing.credential.refresh_expires_at
          : undefined),
      ...(existing?.credential.type === 'oauth'
        ? {
            scopes: existing.credential.scopes,
            account: existing.credential.account,
            organization: existing.credential.organization,
          }
        : {}),
    }
  } else {
    const key = account.apiKey?.trim()
    if (!key) throw new Error(`API-key account ${account.id} has no key`)
    if (!isFirstPartyAnthropicApiAccount(account)) {
      throw new Error(
        `API-key account ${account.id} is a custom route, not a first-party Anthropic credential`,
      )
    }
    credential = { type: 'api_key', key }
  }
  return {
    id: account.id,
    label: account.label ?? existing?.label,
    email: existing?.email,
    credential,
    enabled: account.enabled !== false,
    created_at: toIsoString(
      account.addedAt,
      existing?.created_at ? Date.parse(existing.created_at) : now,
    ),
    last_used_at:
      typeof account.lastUsed === 'number'
        ? toIsoString(account.lastUsed, now)
        : existing?.last_used_at,
    rate_limited_until: existing?.rate_limited_until,
    last_error:
      account.type === 'oauth'
        ? (account.lastRefreshError?.message ?? existing?.last_error)
        : existing?.last_error,
  }
}

export function upsertFallbackAccountInSharedStore(
  account: FallbackAccount,
  options: SharedAccountStoreOptions & { expectedRefresh?: string } = {},
) {
  return updateSharedAccountStore((store) => {
    const index = store.accounts.findIndex(
      (candidate) => candidate.id === account.id,
    )
    const existing = index >= 0 ? store.accounts[index] : undefined
    if (
      options.expectedRefresh !== undefined &&
      existing?.credential.type === 'oauth' &&
      existing.credential.refresh !== options.expectedRefresh
    ) {
      return existing
    }
    const shared = fallbackAccountToShared(
      account,
      existing,
      options.now?.() ?? Date.now(),
    )
    if (index >= 0) store.accounts[index] = shared
    else store.accounts.push(shared)
    return shared
  }, options)
}

export function syncRefreshedFallbackAccountInSharedStore(
  account: OAuthAccount,
  expectedRefresh: string,
  options: SharedAccountStoreOptions = {},
) {
  return updateSharedAccountStore((store) => {
    const existing = store.accounts.find(
      (candidate) => candidate.id === account.id,
    )
    if (existing?.credential.type !== 'oauth' || !existing.enabled) {
      return { status: 'rejected' as const }
    }
    if (existing.credential.refresh !== expectedRefresh) {
      const winner = sharedAccountToFallback(existing, account)
      if (winner.type !== 'oauth') return { status: 'rejected' as const }
      return { status: 'superseded' as const, account: winner }
    }
    const shared = fallbackAccountToShared(
      account,
      existing,
      options.now?.() ?? Date.now(),
    )
    const index = store.accounts.findIndex(
      (candidate) => candidate.id === account.id,
    )
    store.accounts[index] = shared
    return { status: 'applied' as const }
  }, options)
}

export function sharedAccountToFallback(
  account: SharedAnthropicAccount,
  existing?: FallbackAccount,
): FallbackAccount {
  const createdAt = Date.parse(account.created_at)
  const lastUsed = account.last_used_at
    ? Date.parse(account.last_used_at)
    : undefined
  if (account.credential.type === 'api_key') {
    const existingApi = existing?.type === 'api' ? existing : undefined
    return {
      id: account.id,
      label: account.label ?? existingApi?.label ?? account.email,
      type: 'api',
      apiKey: account.credential.key,
      baseURL: ANTHROPIC_API_BASE_URL,
      authHeader: 'x-api-key',
      enabled: account.enabled,
      addedAt: Number.isFinite(createdAt) ? createdAt : existingApi?.addedAt,
      lastUsed: Number.isFinite(lastUsed) ? lastUsed : existingApi?.lastUsed,
    } satisfies ApiKeyAccount
  }

  const existingOAuth = existing?.type === 'oauth' ? existing : undefined
  return {
    id: account.id,
    label: account.label ?? existingOAuth?.label ?? account.email,
    type: 'oauth',
    access: account.credential.access,
    refresh: account.credential.refresh,
    expires: account.credential.expires_at,
    refreshExpires: account.credential.refresh_expires_at,
    enabled: account.enabled,
    addedAt: Number.isFinite(createdAt) ? createdAt : existingOAuth?.addedAt,
    lastUsed: Number.isFinite(lastUsed) ? lastUsed : existingOAuth?.lastUsed,
    lastRefreshedAt: existingOAuth?.lastRefreshedAt,
    lastRefreshError: existingOAuth?.lastRefreshError,
    lastQuotaRefreshError: existingOAuth?.lastQuotaRefreshError,
    quota: existingOAuth?.quota,
    profile: existingOAuth?.profile,
  } satisfies OAuthAccount
}

function validLegacyCredential(account: FallbackAccount) {
  if (account.type === 'api') {
    return Boolean(
      account.apiKey?.trim() && isFirstPartyAnthropicApiAccount(account),
    )
  }
  return Boolean(
    account.access?.trim() &&
      account.refresh.trim() &&
      typeof account.expires === 'number' &&
      Number.isFinite(account.expires),
  )
}

export async function reconcileSharedFallbackAccounts(
  legacyAccounts: readonly FallbackAccount[],
  options: SharedAccountStoreOptions = {},
) {
  const loaded = await loadSharedAccountStore(options)
  const migratable = legacyAccounts.filter(validLegacyCredential)
  const hasUnmigrated = migratable.some((legacy) => {
    const candidate = fallbackAccountToShared(legacy)
    return (
      !loaded.store.accounts.some((account) => account.id === candidate.id) &&
      !findSharedAccountByCredential(loaded.store, candidate.credential)
    )
  })
  let store = loaded.store

  if (hasUnmigrated || loaded.source.type === 'legacy') {
    const updated = await updateSharedAccountStore((next) => {
      for (const legacy of migratable) {
        const candidate = fallbackAccountToShared(legacy)
        const byId = next.accounts.find(
          (account) => account.id === candidate.id,
        )
        const byCredential = findSharedAccountByCredential(
          next,
          candidate.credential,
        )
        if (byId || byCredential) continue
        next.accounts.push(candidate)
      }
      if (!next.current && next.accounts.length === 1) {
        next.current = next.accounts[0]?.id
      }
    }, options)
    store = updated.store
  }

  return {
    store,
    source: loaded.source,
    main: pickSharedAccount(store, options.now?.() ?? Date.now()),
    fallbacks: materializeSharedFallbackAccounts(
      legacyAccounts,
      store,
      options.now?.() ?? Date.now(),
    ),
  }
}

export function materializeSharedFallbackAccounts(
  legacyAccounts: readonly FallbackAccount[],
  store: SharedAnthropicAccountStore,
  now = Date.now(),
) {
  const main = pickSharedAccount(store, now)
  const sharedById = new Map(
    store.accounts
      .filter((account) => account.id !== main?.id)
      .map((account) => [account.id, account] as const),
  )

  // Fallback order IS routing priority — the router walks `storage.accounts` in
  // order — and the reconciled list is written back to the account config file,
  // so any reordering here is both live and permanent. Emitting shared-backed
  // accounts first sank every account the shared store cannot carry (a
  // non-first-party API-key route, say) to the end of the user's list and then
  // persisted that demotion. Walk the configured order instead.
  const emitted = new Set<string>()
  const ordered: FallbackAccount[] = []
  for (const legacy of legacyAccounts) {
    const shared = sharedById.get(legacy.id)
    if (shared) {
      ordered.push(sharedAccountToFallback(shared, legacy))
      emitted.add(shared.id)
      continue
    }
    // An entry promoted to the shared main is served as main, never as its own
    // fallback.
    if (main && legacy.id === main.id) continue
    ordered.push(legacy)
  }

  // Shared accounts the config has never seen keep their store order, appended
  // after everything the user explicitly configured.
  for (const account of store.accounts) {
    if (account.id === main?.id || emitted.has(account.id)) continue
    ordered.push(sharedAccountToFallback(account, undefined))
  }

  return ordered
}
