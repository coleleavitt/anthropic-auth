/**
 * Seed Pi's own credential file from the canonical shared account store.
 *
 * Pi gates every run on `ModelRegistry.hasConfiguredAuth`, which consults only
 * Pi's `AuthStorage` — runtime overrides, `auth.json`, environment keys, and a
 * provider-config `apiKey`. Our request path (`streamCortexKitAnthropic`) reads
 * the canonical shared store directly and picks its own account, so a machine
 * holding several healthy shared accounts could still be refused before
 * `streamSimple` was ever called, with "No API key found for anthropic".
 *
 * Pi's extension OAuth contract exposes only `login`, `refreshToken` and
 * `getApiKey`; there is no hook for "I already hold valid credentials". And the
 * reconciliation that already exists in `shared-refresh.ts`
 * (`adoptableSharedCredential`) runs inside `refreshToken`, which Pi calls only
 * when `auth.json` already holds something to refresh. A cold, empty
 * `auth.json` is therefore the single case nothing covered.
 *
 * Adoption is a seed, not a sync: it never replaces an entry Pi already has.
 * The seed carries the store placeholder, never a real refresh token; once
 * seeded, `refreshAnthropicToken` answers every refresh from the store.
 *
 * The one exception is an entry still carrying a real refresh token (written
 * by Pi's built-in login or an older version of this extension). That token
 * is moved into the store and the entry keeps only the placeholder: left in
 * place, Pi's built-in Anthropic refresh (any session started without this
 * extension) and the store would both spend one rotating refresh token, and
 * whichever rotated first would leave the other with a dead one.
 */
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import {
  getSharedAccessToken,
  importHostOAuthCredential,
  isStoreManagedRefreshPlaceholder,
  listSharedAccounts,
  logger,
  type SharedAnthropicAccount,
  STORE_MANAGED_REFRESH_PLACEHOLDER,
} from '@cortexkit/anthropic-auth-core'

import { getPiConfigDir } from './paths.ts'
import {
  currentSharedAccount,
  sharedCredentialIsLive,
} from './shared-refresh.ts'

/** Owner-only, matching the permissions Pi itself uses for `auth.json`. */
const PRIVATE_FILE_MODE = 0o600

export type AdoptionOutcome =
  /** Pi already had an `anthropic` entry; left untouched. */
  | 'already-present'
  /** The shared store could not be read. */
  | 'store-unavailable'
  /** No enabled OAuth account was usable. */
  | 'no-usable-account'
  /** A credential was written into Pi's `auth.json`. */
  | 'adopted'
  /** Pi's real refresh token was moved into the store and replaced. */
  | 'migrated'

export interface AdoptionResult {
  outcome: AdoptionOutcome
  /** Non-secret label of the adopted account, for logs. */
  account?: string
  /** True when the adopted access token was already expired on arrival. */
  refreshPending?: boolean
}

export function getHostAuthPath(): string {
  return join(getPiConfigDir(), 'auth.json')
}

function readHostAuth(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    // A corrupt or non-object file is treated as empty rather than thrown on:
    // refusing to start over a damaged credential cache helps nobody, and the
    // atomic write below replaces it with a well-formed one.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

function hasHostAnthropicEntry(auth: Record<string, unknown>): boolean {
  const entry = auth.anthropic
  return Boolean(entry) && typeof entry === 'object'
}

type HostOAuthEntry = {
  type: 'oauth'
  access?: unknown
  refresh: string
  expires?: unknown
}

/** The host's Anthropic entry when it still holds a real refresh token. */
function hostRealRefreshEntry(
  auth: Record<string, unknown>,
): HostOAuthEntry | undefined {
  const entry = auth.anthropic as Record<string, unknown> | undefined
  if (!entry || typeof entry !== 'object' || entry.type !== 'oauth') return
  const refresh = typeof entry.refresh === 'string' ? entry.refresh.trim() : ''
  if (!refresh || isStoreManagedRefreshPlaceholder(refresh)) return
  return { ...entry, type: 'oauth', refresh }
}

/**
 * Move a real refresh token out of Pi's `auth.json` into the store, leaving
 * the placeholder behind. A token the store rejects is left untouched: it is
 * not ours to discard, and `/login anthropic` replaces it.
 */
async function migrateHostRefreshToken(
  path: string,
  entry: HostOAuthEntry,
): Promise<AdoptionResult> {
  const expires =
    typeof entry.expires === 'number' && Number.isFinite(entry.expires)
      ? entry.expires
      : 0
  const imported = await importHostOAuthCredential({
    accessToken: typeof entry.access === 'string' ? entry.access : '',
    refreshToken: entry.refresh,
    expiresAt: expires,
  }).catch((error: unknown) => {
    logger.debug('pi-auth', 'host refresh token migration failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  })
  if (!imported || imported.status === 'invalid') {
    return { outcome: 'already-present' }
  }

  // Re-read: replace only the exact token we imported, never a newer login.
  const current = readHostAuth(path)
  if (hostRealRefreshEntry(current)?.refresh !== entry.refresh) {
    return { outcome: 'already-present' }
  }
  current.anthropic = {
    ...(current.anthropic as Record<string, unknown>),
    refresh: STORE_MANAGED_REFRESH_PLACEHOLDER,
  }
  try {
    writeHostAuth(path, current)
  } catch (error) {
    logger.warn('pi-auth', 'failed to replace host refresh token', {
      error: error instanceof Error ? error.message : String(error),
    })
    return { outcome: 'already-present' }
  }
  logger.info('pi-auth', 'moved the host refresh token into the store', {
    accountId: imported.accountId,
    status: imported.status,
  })
  return { outcome: 'migrated', account: imported.accountId }
}

/**
 * Pick the account to seed.
 *
 * A live access token is preferred. Failing that, any enabled OAuth account
 * whose refresh token is not recorded dead still beats adopting nothing: Pi's
 * stored-credential gate does not check expiry, so the seeded (expired) entry
 * lets the run start, and Pi's first `getApiKey` routes through
 * `refreshAnthropicToken`, which asks the store for a live token.
 */
function selectAccountToAdopt(
  accounts: readonly SharedAnthropicAccount[],
  now: number,
) {
  const live = currentSharedAccount(accounts, now)
  if (live && sharedCredentialIsLive(live, now)) {
    return { account: live, refreshPending: false }
  }
  const refreshable = accounts.find(
    (entry) => entry.enabled && entry.kind === 'oauth' && !entry.refreshDead,
  )
  if (refreshable) return { account: refreshable, refreshPending: true }
  return undefined
}

/**
 * Replace `auth.json` atomically and privately.
 *
 * Pi guards its own writes with `proper-lockfile`; we deliberately do not take
 * that lock, because acquiring a foreign lock during extension activation can
 * stall startup behind an unrelated refresh. Instead the window is kept as
 * narrow as possible — the file is re-read and re-checked immediately before
 * the rename — and the rename itself is atomic, so a concurrent writer either
 * wins or loses cleanly and never observes a half-written file.
 */
function writeHostAuth(path: string, auth: Record<string, unknown>): void {
  const temporary = join(
    dirname(path),
    `.auth.json.cortexkit-${process.pid}.tmp`,
  )
  try {
    writeFileSync(temporary, `${JSON.stringify(auth, null, 2)}\n`, {
      mode: PRIVATE_FILE_MODE,
    })
    renameSync(temporary, path)
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary)
    } catch {
      // Best effort; a stray temp file must not mask the original failure.
    }
    throw error
  }
}

/**
 * Seed Pi's `auth.json` from the shared store when Pi has no Anthropic entry.
 *
 * Never throws: a failure here must degrade to the pre-existing behaviour
 * (Pi reports the provider as unconfigured and `/login` still works), not
 * prevent the extension from registering its provider.
 */
export async function adoptSharedCredentialIntoHostAuth(
  now = Date.now(),
): Promise<AdoptionResult> {
  const path = getHostAuthPath()

  const host = readHostAuth(path)
  const realRefresh = hostRealRefreshEntry(host)
  if (realRefresh) return migrateHostRefreshToken(path, realRefresh)
  if (hasHostAnthropicEntry(host)) return { outcome: 'already-present' }

  const accounts = await listSharedAccounts().catch((error: unknown) => {
    logger.debug('pi-auth', 'shared account store unreadable during adoption', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  })
  if (!accounts) return { outcome: 'store-unavailable' }

  const selected = selectAccountToAdopt(accounts, now)
  if (!selected) return { outcome: 'no-usable-account' }

  // A live row's token is handed out as-is (no refresh). An expired one is
  // seeded expired; the store refreshes it when Pi first asks.
  const token = selected.refreshPending
    ? undefined
    : await getSharedAccessToken(selected.account.id).catch(() => undefined)

  // Re-read immediately before writing: a peer Pi may have completed a login
  // while the store was loading, and its credential must win over our seed.
  const current = readHostAuth(path)
  if (hasHostAnthropicEntry(current)) return { outcome: 'already-present' }

  current.anthropic = {
    type: 'oauth',
    access: token?.accessToken ?? '',
    refresh: STORE_MANAGED_REFRESH_PLACEHOLDER,
    expires: token?.expiresAt ?? 0,
  }

  try {
    writeHostAuth(path, current)
  } catch (error) {
    logger.warn('pi-auth', 'failed to seed host auth file', {
      error: error instanceof Error ? error.message : String(error),
    })
    return { outcome: 'store-unavailable' }
  }

  const account =
    selected.account.email ?? selected.account.label ?? selected.account.id
  logger.info('pi-auth', 'seeded host auth from shared account store', {
    account,
    refreshPending: !token,
  })
  return {
    outcome: 'adopted',
    account,
    refreshPending: !token,
  }
}
