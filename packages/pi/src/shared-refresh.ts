/**
 * Safe rotation of the machine-wide Anthropic credential.
 *
 * Lives apart from `index.ts` because `stream.ts` needs it too: `index.ts`
 * already imports `stream.ts`, so putting the refresh there and importing it
 * back would close an import cycle. A cycle here would resolve at runtime by
 * accident of hoisting, which is exactly the kind of thing that breaks later
 * under a bundler.
 */
import {
  claimSharedAccountRefresh,
  type LoadedSharedAccountStore,
  loadSharedAccountStore,
  logger,
  markSharedRefreshTokenDead,
  publishNativeClaudeOAuth,
  readNativeClaudeOAuth,
  refreshClaudeOAuthToken,
  releaseSharedAccountRefresh,
  type SharedAnthropicAccount,
  tokenFingerprint,
  updateSharedAccountStore,
} from '@cortexkit/anthropic-auth-core'
import type { OAuthCredentials } from '@earendil-works/pi-ai'

const SHARED_CREDENTIAL_ADOPTION_SKEW_MS = 60_000

export function currentSharedAccount(
  store: LoadedSharedAccountStore['store'],
  now = Date.now(),
): SharedAnthropicAccount | undefined {
  const enabled = store.accounts.filter((entry) => entry.enabled !== false)
  const named = enabled.find((entry) => entry.id === store.current)
  if (named && sharedCredentialIsLive(named, now)) return named
  // `current` was unset or points at a dead credential. The old fallback took
  // the first enabled account regardless of health, which picked an account
  // whose access token had expired 35 hours earlier — so adoption declined it
  // and the caller spent its own (revoked) refresh token instead, on every
  // request. Prefer an account that can actually serve.
  return enabled.find((entry) => sharedCredentialIsLive(entry, now)) ?? named
}

/** An enabled OAuth account whose access token has not expired. */
export function sharedCredentialIsLive(
  account: SharedAnthropicAccount,
  now: number,
) {
  const credential = account.credential
  if (credential.type !== 'oauth' || !credential.access) return false
  return credential.expires_at > now
}

/**
 * Anthropic rotates the refresh token on every refresh, so a peer process that
 * refreshed first leaves this one holding a superseded token whose failure
 * invalidates the whole login, not just one request.
 */
function adoptableSharedCredential(
  store: LoadedSharedAccountStore['store'],
  credentials: OAuthCredentials,
  now: number,
): OAuthCredentials | undefined {
  const credential = currentSharedAccount(store)?.credential
  if (credential?.type !== 'oauth') return undefined
  // An unrotated match means no peer refreshed; this caller still has to.
  if (credential.refresh === credentials.refresh) return undefined
  if (credential.expires_at <= now + SHARED_CREDENTIAL_ADOPTION_SKEW_MS)
    return undefined
  return {
    refresh: credential.refresh,
    access: credential.access,
    expires: credential.expires_at,
  }
}

/** Bounded like the CLI's refresh lock retry (5 attempts, jittered waits). */
const REFRESH_CLAIM_MAX_ATTEMPTS = 5

/**
 * Refresh tokens Anthropic has already rejected with `invalid_grant`.
 *
 * The shared store records this per account, but the host can hand us a
 * credential that is not in the store at all — Pi keeps its own auth file, and
 * calls `refreshToken` before every request. When that token's family is
 * revoked there is nothing to look it up by, so the store's dead-token guard
 * never fires and the same dead token is re-presented on every single request:
 * 156 rejected refreshes in one hour, observed. `invalid_grant` is terminal —
 * no retry can succeed — so remember the fingerprint and fail fast instead.
 *
 * Process-local by design: the store already persists this for accounts it
 * knows, and a token absent from the store has no durable home. That is enough
 * to stop the hammering, which happens within one long-lived agent process.
 */
const deadRefreshFingerprints = new Set<string>()

/** Exposed so tests can assert the guard without a live OAuth endpoint. */
export function forgetDeadRefreshTokens() {
  deadRefreshFingerprints.clear()
}

export async function refreshAnthropicToken(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  const loaded = await loadSharedAccountStore().catch(() => null)
  const sharedAccount = loaded?.store.accounts.find(
    (account) =>
      account.credential.type === 'oauth' &&
      account.credential.refresh === credentials.refresh,
  )
  if (loaded && !sharedAccount) {
    const adopted = adoptableSharedCredential(
      loaded.store,
      credentials,
      Date.now(),
    )
    if (adopted) return adopted
  }
  const refreshExpiry =
    sharedAccount?.credential.type === 'oauth'
      ? sharedAccount.credential.refresh_expires_at
      : undefined

  // Anthropic revokes the whole token family when a refresh token is presented
  // twice, so the network call has to be serialised across processes. Claiming
  // first — and re-reading under the claim — is what stops two agents sharing
  // this store from spending the same token and killing the account. The store
  // CAS below is not enough on its own: by the time it runs, both POSTs have
  // already reached Anthropic.
  let leaseId: string | undefined
  if (sharedAccount) {
    for (let attempt = 0; ; attempt += 1) {
      const claim = await claimSharedAccountRefresh(
        sharedAccount.id,
        credentials.refresh,
        {},
      )
      if (claim.status === 'claimed') {
        leaseId = claim.leaseId
        break
      }
      if (claim.status === 'already-refreshed') {
        logger.info('refresh.spend', 'peer already rotated; adopting', {
          accountId: sharedAccount.id,
          selfPid: process.pid,
        })
        return {
          refresh: claim.credential.refresh,
          access: claim.credential.access,
          expires: claim.credential.expires_at,
        }
      }
      if (claim.status === 'dead-token') {
        // Anthropic already rejected this token; the family is gone.
        logger.error('refresh.spend', 'skipping a known-dead refresh token', {
          accountId: sharedAccount.id,
          selfPid: process.pid,
        })
        throw new Error(
          `Anthropic account ${sharedAccount.id} has a revoked refresh token; re-login is required`,
        )
      }
      if (claim.status === 'unknown-account') break
      if (attempt >= REFRESH_CLAIM_MAX_ATTEMPTS) {
        // Proceeding without the claim is the one path that can still
        // double-spend, so it is logged loudly with both processes named.
        logger.error('refresh.spend', 'claim timed out; refreshing unclaimed', {
          accountId: sharedAccount.id,
          selfPid: process.pid,
          holderPid: claim.status === 'held' ? claim.holderPid : undefined,
          attempts: attempt + 1,
        })
        break
      }
      // Matches the CLI's lock retry: bounded attempts, jittered waits.
      logger.info('refresh.spend', 'claim held by another process', {
        accountId: sharedAccount.id,
        selfPid: process.pid,
        holderPid: claim.holderPid,
        heldForMs: claim.until - Date.now(),
        attempt,
      })
      await new Promise((resolve) =>
        setTimeout(resolve, 1_000 + Math.random() * 1_000),
      )
    }
  }

  // Claude Code may hold this very credential. Anthropic revokes the family
  // when a superseded refresh token is presented, so a rotation that is not
  // published back forks the two copies and the next refresh from either side
  // kills the account for both. Check before spending, and adopt whatever the
  // native app already has rather than racing it.
  const nativeBefore = await readNativeClaudeOAuth().catch(() => null)
  const sharesNativeCredential =
    nativeBefore?.refreshToken === credentials.refresh
  if (nativeBefore && !sharesNativeCredential) {
    // The native app already moved on. Its token is the live one.
    if (
      nativeBefore.accessToken &&
      typeof nativeBefore.expiresAt === 'number' &&
      nativeBefore.expiresAt > Date.now()
    ) {
      logger.info('refresh.spend', 'adopting the native app rotation', {
        selfPid: process.pid,
      })
      return {
        refresh: nativeBefore.refreshToken,
        access: nativeBefore.accessToken,
        expires: nativeBefore.expiresAt,
      }
    }
  }

  const refreshFp = tokenFingerprint(credentials.refresh)
  if (deadRefreshFingerprints.has(refreshFp)) {
    logger.error('refresh.spend', 'skipping a known-dead refresh token', {
      refreshFp: refreshFp.slice(0, 8),
      accountId: sharedAccount?.id,
      selfPid: process.pid,
    })
    if (sharedAccount && leaseId) {
      await releaseSharedAccountRefresh(sharedAccount.id, leaseId).catch(
        () => {},
      )
    }
    throw new Error(
      'Anthropic refresh token was revoked; re-login is required (run `/login anthropic` in Pi, or `opencode-anthropic-auth login`)',
    )
  }

  let refreshed: Awaited<ReturnType<typeof refreshClaudeOAuthToken>>
  try {
    refreshed = await refreshClaudeOAuthToken({
      refreshToken: credentials.refresh,
      refreshTokenExpiresAt: refreshExpiry,
    })
  } catch (error) {
    if (error instanceof Error && error.message.includes('invalid_grant')) {
      // Terminal for this token whether or not the store knows the account.
      deadRefreshFingerprints.add(refreshFp)
      if (sharedAccount) {
        await markSharedRefreshTokenDead(
          sharedAccount.id,
          credentials.refresh,
        ).catch(() => {})
      }
    }
    if (sharedAccount && leaseId) {
      await releaseSharedAccountRefresh(sharedAccount.id, leaseId).catch(
        () => {},
      )
    }
    throw error
  }

  if (sharedAccount) {
    const persisted = await updateSharedAccountStore((store) => {
      const current = store.accounts.find(
        (account) => account.id === sharedAccount.id,
      )
      if (
        current?.credential.type !== 'oauth' ||
        current.credential.refresh !== credentials.refresh
      ) {
        return false
      }
      current.credential.access = refreshed.access
      current.credential.refresh = refreshed.refresh
      current.credential.expires_at = refreshed.expires
      current.credential.refresh_expires_at =
        refreshed.refreshTokenExpiresAt ?? current.credential.refresh_expires_at
      current.last_error = undefined
      current.refresh_lease = undefined
      return true
    })
    if (!persisted.result) {
      const winner = (await loadSharedAccountStore()).store.accounts.find(
        (account) => account.id === sharedAccount.id,
      )
      if (winner?.credential.type !== 'oauth') {
        throw new Error('Anthropic OAuth refresh was superseded')
      }
      return {
        refresh: winner.credential.refresh,
        access: winner.credential.access,
        expires: winner.credential.expires_at,
      }
    }
  }

  if (sharesNativeCredential) {
    // Publish the rotation so Claude Code's mtime watch picks it up; without
    // this its copy is superseded the moment we succeed.
    const outcome = await publishNativeClaudeOAuth({
      accessToken: refreshed.access,
      refreshToken: refreshed.refresh,
      expiresAt: refreshed.expires,
      ...(refreshed.refreshTokenExpiresAt !== undefined
        ? { refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt }
        : {}),
      ...(refreshed.scopes ? { scopes: refreshed.scopes } : {}),
    }).catch(() => 'absent' as const)
    logger.info('refresh.spend', 'published rotation to Claude Code', {
      outcome,
      selfPid: process.pid,
    })
  }

  return {
    refresh: refreshed.refresh,
    access: refreshed.access,
    expires: refreshed.expires,
  }
}
