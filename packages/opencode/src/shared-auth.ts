import {
  type FallbackAccount,
  fallbackAccountToShared,
  findSharedAccountByCredential,
  isFirstPartyAnthropicApiAccount,
  loadSharedAccountStore,
  materializeSharedFallbackAccounts,
  pickSharedAccount,
  type SharedAccountStoreOptions,
  type SharedAnthropicAccount,
  type SharedAnthropicCredential,
  updateSharedAccountStore,
  type WifAuth,
} from '@cortexkit/anthropic-auth-core'

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
      access: string
      refresh?: string
      expires: number
      refreshTokenExpiresAt?: number
      key?: undefined
      sharedAccountId?: string
      source: 'shared' | 'opencode' | 'environment'
    }
  | {
      type: 'api'
      key: string
      access?: undefined
      refresh?: undefined
      expires?: undefined
      refreshTokenExpiresAt?: undefined
      sharedAccountId?: string
      source: 'shared' | 'opencode' | 'environment'
    }
  | {
      type: 'wif'
      provider: WifAuth
      key?: undefined
      access?: undefined
      refresh?: undefined
      expires?: undefined
      refreshTokenExpiresAt?: undefined
      sharedAccountId?: undefined
      source: 'wif'
    }

export type ReconciledAnthropicAuth = {
  auth: ResolvedMainAnthropicAuth | null
  fallbacks: FallbackAccount[]
  sharedMain?: SharedAnthropicAccount
}

export async function getSharedAnthropicAuthType(
  options: SharedAccountStoreOptions = {},
) {
  const loaded = await loadSharedAccountStore(options)
  const account = pickSharedAccount(loaded.store, options.now?.() ?? Date.now())
  if (!account) return null
  return account.credential.type === 'oauth' ? 'oauth' : 'api'
}

function nonEmpty(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function credentialFromOpenCodeAuth(
  auth: OpenCodeAnthropicAuth,
): SharedAnthropicCredential | null {
  if (auth.type === 'api') {
    const key = nonEmpty(auth.key)
    return key ? { type: 'api_key', key } : null
  }
  if (auth.type !== 'oauth') return null
  const access = nonEmpty(auth.access)
  const refresh = nonEmpty(auth.refresh)
  if (!access || !refresh || typeof auth.expires !== 'number') return null
  return {
    type: 'oauth',
    access,
    refresh,
    expires_at: auth.expires,
    ...(typeof auth.refreshTokenExpiresAt === 'number'
      ? { refresh_expires_at: auth.refreshTokenExpiresAt }
      : {}),
    scopes: auth.scopes?.length ? auth.scopes : ['user:inference'],
    ...(auth.accountId
      ? {
          account: {
            uuid: auth.accountId,
            ...(auth.email ? { email_address: auth.email } : {}),
          },
        }
      : {}),
    ...(auth.organizationId
      ? { organization: { uuid: auth.organizationId } }
      : {}),
  }
}

function sharedAccountFromOpenCodeAuth(
  auth: OpenCodeAnthropicAuth,
  existing: SharedAnthropicAccount | undefined,
  now: number,
): SharedAnthropicAccount | null {
  const credential = credentialFromOpenCodeAuth(auth)
  if (!credential) return null
  if (
    auth.type === 'oauth' &&
    credential.type === 'oauth' &&
    existing?.credential.type === 'oauth'
  ) {
    if (!auth.scopes?.length) credential.scopes = existing.credential.scopes
    credential.refresh_expires_at ??= existing.credential.refresh_expires_at
    credential.account ??= existing.credential.account
    if (
      credential.account &&
      !credential.account.email_address &&
      existing.credential.account?.email_address
    ) {
      credential.account.email_address =
        existing.credential.account.email_address
    }
    credential.organization ??= existing.credential.organization
  }
  const accountId = auth.type === 'oauth' ? nonEmpty(auth.accountId) : undefined
  return {
    id:
      existing?.id ??
      accountId ??
      (auth.type === 'oauth' ? 'opencode-main' : 'anthropic-api-key'),
    label:
      existing?.label ??
      (auth.type === 'oauth' ? 'OpenCode Anthropic' : 'Anthropic API key'),
    email:
      (auth.type === 'oauth' ? nonEmpty(auth.email) : undefined) ??
      existing?.email,
    credential,
    enabled: true,
    created_at: existing?.created_at ?? new Date(now).toISOString(),
    last_used_at: existing?.last_used_at,
    rate_limited_until: existing?.rate_limited_until,
    last_error: existing?.last_error,
  }
}

function resolveSharedAccount(
  account: SharedAnthropicAccount,
): ResolvedMainAnthropicAuth {
  if (account.credential.type === 'api_key') {
    return {
      type: 'api',
      key: account.credential.key,
      sharedAccountId: account.id,
      source: 'shared',
    }
  }
  return {
    type: 'oauth',
    access: account.credential.access,
    refresh: account.credential.refresh,
    expires: account.credential.expires_at,
    refreshTokenExpiresAt: account.credential.refresh_expires_at,
    sharedAccountId: account.id,
    source: 'shared',
  }
}

function resolveOpenCodeAuth(
  auth: OpenCodeAnthropicAuth,
): ResolvedMainAnthropicAuth | null {
  if (auth.type === 'api') {
    const key = nonEmpty(auth.key)
    return key ? { type: 'api', key, source: 'opencode' } : null
  }
  if (auth.type !== 'oauth') return null
  const access = nonEmpty(auth.access)
  const refresh = nonEmpty(auth.refresh)
  // Keep an OAuth credential that carries only a refresh token (no live access
  // token yet): the downstream refresh path mints the access token before use.
  // Dropping it here would strip the credential the prime and refresh flows need.
  if (!access && !refresh) return null
  return {
    type: 'oauth',
    access: access ?? '',
    refresh,
    expires:
      typeof auth.expires === 'number' ? auth.expires : Number.MAX_SAFE_INTEGER,
    refreshTokenExpiresAt: auth.refreshTokenExpiresAt,
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

export async function reconcileAnthropicAuth(input: {
  openCodeAuth: OpenCodeAnthropicAuth
  legacyAccounts: readonly FallbackAccount[]
  wifAuth?: WifAuth | null
  options?: SharedAccountStoreOptions
}): Promise<ReconciledAnthropicAuth> {
  const options = input.options ?? {}
  const now = options.now?.() ?? Date.now()
  const loaded = await loadSharedAccountStore(options)
  const hostCredential = credentialFromOpenCodeAuth(input.openCodeAuth)
  const existingHost = hostCredential
    ? findSharedAccountByCredential(loaded.store, hostCredential)
    : undefined
  const sharedMainBeforeUpdate = pickSharedAccount(loaded.store, now)
  const hostOwnsSharedMain = Boolean(
    sharedMainBeforeUpdate &&
      (sharedMainBeforeUpdate.id === 'opencode-main' ||
        sharedMainBeforeUpdate.id === 'anthropic-api-key' ||
        (input.openCodeAuth.type === 'oauth' &&
          input.openCodeAuth.accountId === sharedMainBeforeUpdate.id) ||
        existingHost?.id === sharedMainBeforeUpdate.id),
  )
  const shouldUpdateSharedMain = Boolean(
    hostCredential &&
      sharedMainBeforeUpdate &&
      hostOwnsSharedMain &&
      ((hostCredential.type === 'oauth' &&
        sharedMainBeforeUpdate.credential.type === 'oauth' &&
        // A different refresh token is a rotation the host performed, not a
        // regression to an older credential, so it is adopted regardless of
        // expiry. Gating it on `expires_at >=` meant a freshly rotated token
        // with a shorter lifetime than the stale stored one was rejected, and
        // the store kept serving a credential the host had already replaced.
        (hostCredential.refresh !== sharedMainBeforeUpdate.credential.refresh ||
          (hostCredential.expires_at >=
            sharedMainBeforeUpdate.credential.expires_at &&
            hostCredential.access !==
              sharedMainBeforeUpdate.credential.access))) ||
        (hostCredential.type === 'api_key' &&
          sharedMainBeforeUpdate.credential.type === 'api_key' &&
          hostCredential.key !== sharedMainBeforeUpdate.credential.key)),
  )
  const shouldAdoptHost = loaded.store.accounts.length === 0 && !!hostCredential
  const migratableLegacy = input.legacyAccounts.filter((account) =>
    account.type === 'oauth'
      ? Boolean(account.access?.trim() && account.refresh.trim())
      : Boolean(
          account.apiKey?.trim() && isFirstPartyAnthropicApiAccount(account),
        ),
  )

  const legacyNeedsSharedUpdate = (legacy: FallbackAccount) => {
    const candidate = fallbackAccountToShared(legacy, undefined, now)
    const byId = loaded.store.accounts.find(
      (account) => account.id === candidate.id,
    )
    if (!byId) {
      return !findSharedAccountByCredential(loaded.store, candidate.credential)
    }
    return (
      candidate.credential.type === 'oauth' &&
      byId.credential.type === 'oauth' &&
      candidate.credential.expires_at > byId.credential.expires_at
    )
  }
  const hasLegacyUpdates = migratableLegacy.some(legacyNeedsSharedUpdate)

  let store = loaded.store
  if (
    shouldAdoptHost ||
    shouldUpdateSharedMain ||
    hasLegacyUpdates ||
    loaded.source.type === 'legacy'
  ) {
    const updated = await updateSharedAccountStore((next) => {
      if (shouldUpdateSharedMain && sharedMainBeforeUpdate) {
        const index = next.accounts.findIndex(
          (account) => account.id === sharedMainBeforeUpdate.id,
        )
        const refreshed = sharedAccountFromOpenCodeAuth(
          input.openCodeAuth,
          sharedMainBeforeUpdate,
          now,
        )
        if (index >= 0 && refreshed) next.accounts[index] = refreshed
      } else if (shouldAdoptHost) {
        const sharedHost = sharedAccountFromOpenCodeAuth(
          input.openCodeAuth,
          existingHost,
          now,
        )
        if (sharedHost) {
          const match =
            findSharedAccountByCredential(next, sharedHost.credential) ??
            next.accounts.find((account) => account.id === sharedHost.id)
          if (!match) next.accounts.unshift(sharedHost)
          next.current = match?.id ?? sharedHost.id
        }
      }
      for (const legacy of migratableLegacy) {
        const candidate = fallbackAccountToShared(legacy, undefined, now)
        const byId = next.accounts.find(
          (account) => account.id === candidate.id,
        )
        if (byId) {
          if (
            candidate.credential.type === 'oauth' &&
            byId.credential.type === 'oauth' &&
            candidate.credential.expires_at > byId.credential.expires_at
          ) {
            byId.credential = {
              ...candidate.credential,
              scopes: byId.credential.scopes,
              account: byId.credential.account,
              organization: byId.credential.organization,
            }
            byId.last_used_at = candidate.last_used_at
            byId.last_error = candidate.last_error
          }
          continue
        }
        if (findSharedAccountByCredential(next, candidate.credential)) continue
        next.accounts.push(candidate)
      }
    }, options)
    store = updated.store
  }

  const sharedMain = pickSharedAccount(store, now)
  const hostStableAccountId =
    input.openCodeAuth.type === 'oauth'
      ? nonEmpty(input.openCodeAuth.accountId)
      : undefined
  const hostBlockedByDisabledSharedAccount = store.accounts.some(
    (account) =>
      !account.enabled &&
      (account.id === existingHost?.id ||
        account.id === hostStableAccountId ||
        (input.openCodeAuth.type === 'oauth' &&
          !hostStableAccountId &&
          account.id === 'opencode-main')),
  )
  // The stored copy of the host's own session drifts from the host in both
  // directions: it keeps the previous expiry after the host's token has aged
  // out, and it keeps a stale one after the host's has moved forward. Either
  // way the host is the authority on its own session, and serving the stored
  // expiry instead makes the request path mis-judge whether a refresh is due.
  //
  // A genuine host rotation has already been written into the store by
  // `shouldUpdateSharedMain` above, so by this point the two agree and this
  // stays false — a rotated credential keeps its canonical `shared` provenance.
  const hostOAuth =
    input.openCodeAuth.type === 'oauth' ? input.openCodeAuth : undefined
  const hostMirrorsSharedMain = Boolean(
    sharedMain &&
      hostOwnsSharedMain &&
      hostOAuth &&
      sharedMain.credential.type === 'oauth' &&
      hostOAuth.refresh === sharedMain.credential.refresh &&
      // A host session carrying no access token at all is the strongest
      // possible statement that its token is gone. `credentialFromOpenCodeAuth`
      // returns null for that shape (it needs access + refresh + a numeric
      // expiry), so read the host auth directly rather than via
      // `hostCredential`, which would be null exactly when it matters most.
      (!hostOAuth.access?.trim() ||
        (typeof hostOAuth.expires === 'number' &&
          hostOAuth.expires !== sharedMain.credential.expires_at)),
  )

  return {
    auth:
      (hostMirrorsSharedMain
        ? resolveOpenCodeAuth(input.openCodeAuth)
        : null) ??
      (sharedMain ? resolveSharedAccount(sharedMain) : null) ??
      (hostBlockedByDisabledSharedAccount
        ? null
        : resolveOpenCodeAuth(input.openCodeAuth)) ??
      resolveEnvironmentAuth() ??
      (input.wifAuth
        ? { type: 'wif', provider: input.wifAuth, source: 'wif' }
        : null),
    fallbacks: materializeSharedFallbackAccounts(
      input.legacyAccounts,
      store,
      now,
    ),
    sharedMain,
  }
}

export async function persistConnectedAnthropicAuth(
  auth: OpenCodeAnthropicAuth,
  options: SharedAccountStoreOptions = {},
) {
  const credential = credentialFromOpenCodeAuth(auth)
  if (!credential) return null
  const now = options.now?.() ?? Date.now()
  const updated = await updateSharedAccountStore((store) => {
    const expectedId =
      auth.type === 'oauth'
        ? (nonEmpty(auth.accountId) ?? 'opencode-main')
        : 'anthropic-api-key'
    const existing =
      findSharedAccountByCredential(store, credential) ??
      store.accounts.find((candidate) => candidate.id === expectedId) ??
      (auth.type === 'oauth' && store.current === 'opencode-main'
        ? store.accounts.find((candidate) => candidate.id === 'opencode-main')
        : undefined)
    const account = sharedAccountFromOpenCodeAuth(auth, existing, now)
    if (!account) return null
    const index = store.accounts.findIndex(
      (candidate) => candidate.id === account.id,
    )
    if (index >= 0) store.accounts[index] = account
    else store.accounts.push(account)
    store.current = account.id
    return account
  }, options)
  return updated.result
}

export async function persistRefreshedSharedOAuth(input: {
  accountId: string
  access: string
  refresh: string
  expires: number
  refreshTokenExpiresAt?: number
  expectedRefresh?: string
  options?: SharedAccountStoreOptions
}) {
  const { result } = await updateSharedAccountStore((store) => {
    const account = store.accounts.find(
      (candidate) => candidate.id === input.accountId,
    )
    if (account?.credential.type !== 'oauth') {
      throw new Error(
        `Unknown shared Anthropic OAuth account: ${input.accountId}`,
      )
    }
    if (
      input.expectedRefresh !== undefined &&
      account.credential.refresh !== input.expectedRefresh
    ) {
      return false
    }
    account.credential.access = input.access
    account.credential.refresh = input.refresh
    account.credential.expires_at = input.expires
    account.credential.refresh_expires_at =
      input.refreshTokenExpiresAt ?? account.credential.refresh_expires_at
    account.last_error = undefined
    return true
  }, input.options)
  return result
}
