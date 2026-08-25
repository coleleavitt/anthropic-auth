import { randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { tokenFingerprint } from './token-fingerprint.ts'

export const SHARED_ACCOUNT_STORE_FILE_ENV = 'ANTHROPIC_ACCOUNTS_FILE'
export const SHARED_ACCOUNT_STORE_DIR_ENV = 'ANTHROPIC_ACCOUNTS_DIR'
export const SHARED_ACCOUNT_STORE_DIR_NAME = '.anthropic-accounts'
export const SHARED_ACCOUNT_STORE_FILE_NAME = 'accounts.json'

const ORPHAN_TEMP_MAX_AGE_MS = 60 * 60_000
const STORE_LOCK_WAIT_MS = 12_000
const STORE_LOCK_STALE_MS = 10_000
const STORE_LOCK_RENEW_MS = 3_000

export type SharedTokenAccount = {
  uuid: string
  email_address?: string
}

export type SharedTokenOrganization = {
  uuid: string
}

export type SharedOAuthCredential = {
  type: 'oauth'
  access: string
  refresh: string
  expires_at: number
  refresh_expires_at?: number
  scopes?: string[]
  account?: SharedTokenAccount
  organization?: SharedTokenOrganization
}

export type SharedApiKeyCredential = {
  type: 'api_key'
  key: string
}

export type SharedAnthropicCredential =
  | SharedOAuthCredential
  | SharedApiKeyCredential

export type SharedAnthropicAccount = {
  id: string
  label?: string
  email?: string
  credential: SharedAnthropicCredential
  enabled: boolean
  created_at: string
  last_used_at?: string
  rate_limited_until?: string
  last_error?: string
  /**
   * Last observed plan-window utilisation, as percentages (0-100). Recorded so
   * selection can skip an exhausted account: Anthropic reports exhaustion
   * through quota, not through `rate_limited_until`, so an account at 100% of
   * its weekly window looks perfectly available without this.
   */
  quota?: {
    five_hour_percent?: number
    seven_day_percent?: number
    checked_at?: string
  }
  /**
   * In-flight refresh claim. Anthropic revokes an entire token family when the
   * same refresh token is presented twice, so concurrent processes must not
   * both POST it — the store CAS alone is too late, because by then both
   * network calls have already happened.
   */
  refresh_lease?: {
    id: string
    until: number
    token_fingerprint: string
  }
}

export type SharedAnthropicAccountStore = {
  version: number
  accounts: SharedAnthropicAccount[]
  current?: string
  /**
   * Legacy store paths whose accounts have already been folded in. Re-reading
   * one would resurrect accounts the user has since removed, so adoption is
   * recorded rather than repeated.
   */
  migrated_from?: string[]
}

export type SharedAccountStoreSource =
  | { type: 'canonical'; path: string; adoptedFrom?: string[] }
  | { type: 'legacy'; path: string; adoptedFrom?: string[] }
  | { type: 'empty' }

export type LoadedSharedAccountStore = {
  store: SharedAnthropicAccountStore
  source: SharedAccountStoreSource
}

export type SharedAccountStoreOptions = {
  path?: string
  legacyPaths?: string[]
  now?: () => number
  /** Explicitly permit an intentional user-driven final-account removal. */
  allowEmpty?: boolean
}

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

export function getSharedAccountStoreLegacyPaths() {
  const paths: string[] = [
    // Predecessors wrote this name into the shared directory itself, so it sits
    // beside the canonical file and is the most likely place to find accounts
    // that were never migrated.
    join(getSharedAccountStoreDirectory(), 'anthropic-accounts.json'),
  ]
  const grokHome = nonEmptyEnvironmentPath('GROK_HOME')
  if (grokHome) paths.push(join(grokHome, 'anthropic-accounts.json'))
  const home = homedir()
  paths.push(
    join(home, '.config', 'jfc', 'anthropic-accounts.json'),
    join(home, '.grok', 'anthropic-accounts.json'),
    join(home, '.config', 'opencode', 'anthropic-accounts.json'),
  )
  return paths
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

const RFC3339_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function validTimestamp(value: unknown) {
  const timestamp = optionalString(value)
  return timestamp &&
    RFC3339_TIMESTAMP.test(timestamp) &&
    Number.isFinite(Date.parse(timestamp))
    ? timestamp
    : undefined
}

function normalizeCredential(value: unknown): SharedAnthropicCredential | null {
  if (!isRecord(value)) return null
  if (value.type === 'api_key') {
    const key = optionalString(value.key)
    return key ? { type: 'api_key', key } : null
  }
  if (value.type !== 'oauth') return null
  const access = optionalString(value.access)
  const refresh = optionalString(value.refresh)
  const expiresAt = value.expires_at
  if (
    !access ||
    !refresh ||
    typeof expiresAt !== 'number' ||
    !Number.isFinite(expiresAt)
  )
    return null
  const refreshExpiresAt = value.refresh_expires_at
  if (
    refreshExpiresAt !== undefined &&
    (typeof refreshExpiresAt !== 'number' || !Number.isFinite(refreshExpiresAt))
  )
    return null
  let scopes: string[] | undefined
  if (value.scopes !== undefined) {
    if (!Array.isArray(value.scopes)) return null
    scopes = []
    for (const rawScope of value.scopes) {
      const scope = optionalString(rawScope)
      if (!scope) return null
      scopes.push(scope)
    }
  }
  let tokenAccount: SharedTokenAccount | undefined
  if (value.account !== undefined) {
    if (!isRecord(value.account)) return null
    const uuid = optionalString(value.account.uuid)
    if (!uuid) return null
    const emailAddress = optionalString(value.account.email_address)
    tokenAccount = {
      uuid,
      ...(emailAddress ? { email_address: emailAddress } : {}),
    }
  }
  let organization: SharedTokenOrganization | undefined
  if (value.organization !== undefined) {
    if (!isRecord(value.organization)) return null
    const uuid = optionalString(value.organization.uuid)
    if (!uuid) return null
    organization = { uuid }
  }
  return {
    type: 'oauth',
    access,
    refresh,
    expires_at: expiresAt,
    ...(typeof refreshExpiresAt === 'number'
      ? { refresh_expires_at: refreshExpiresAt }
      : {}),
    ...(scopes ? { scopes } : {}),
    ...(tokenAccount?.uuid ? { account: tokenAccount } : {}),
    ...(organization?.uuid ? { organization } : {}),
  }
}

/**
 * Legacy `lastAuthError` sometimes held a whole OAuth error body, so scrub
 * token-shaped text before it is carried into the shared store.
 */
function redactStoredError(value: string) {
  return value
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***REDACTED***')
    .slice(0, 512)
}

/** Epoch milliseconds to the RFC3339 form the shared schema stores. */
function timestampFromEpochMs(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined
  }
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString()
}

/**
 * Adopt the flat per-application account schema that predates the shared store.
 *
 * jfc, grok, and older OpenCode builds wrote
 * `{uuid, accessToken, refreshToken, expiresAt, email, enabled, ...}` instead of
 * `{id, credential: {type, access, refresh, expires_at}}`. Without this the
 * canonical loader rejects every such row, so a machine with several logged-in
 * accounts silently presents none of them.
 */
function normalizeLegacyAccount(
  value: Record<string, unknown>,
): SharedAnthropicAccount | null {
  const id = optionalString(value.uuid)
  const access = optionalString(value.accessToken)
  const refresh = optionalString(value.refreshToken)
  // A row stripped of its refresh token cannot be revived; skip it rather than
  // adopting an account that can never obtain a working access token.
  if (!id || !access || !refresh) return null

  const expiresAt =
    typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)
      ? value.expiresAt
      : 0

  let scopes: string[] | undefined
  if (Array.isArray(value.scopes)) {
    const collected: string[] = []
    for (const rawScope of value.scopes) {
      const scope = optionalString(rawScope)
      if (scope) collected.push(scope)
    }
    if (collected.length) scopes = collected
  }

  const email = optionalString(value.email)
  const organizationUuid = optionalString(value.organizationUuid)
  const credential: SharedOAuthCredential = {
    type: 'oauth',
    access,
    refresh,
    expires_at: expiresAt,
    ...(scopes ? { scopes } : {}),
    account: { uuid: id, ...(email ? { email_address: email } : {}) },
    ...(organizationUuid ? { organization: { uuid: organizationUuid } } : {}),
  }

  const label = optionalString(value.name) ?? email
  const lastError =
    optionalString(value.disabledReason) ?? optionalString(value.lastAuthError)

  return {
    id,
    ...(label ? { label } : {}),
    ...(email ? { email } : {}),
    credential,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    created_at:
      timestampFromEpochMs(value.addedAt) ?? new Date(0).toISOString(),
    ...(timestampFromEpochMs(value.lastUsed)
      ? { last_used_at: timestampFromEpochMs(value.lastUsed) }
      : {}),
    ...(timestampFromEpochMs(value.rateLimitResetTime)
      ? { rate_limited_until: timestampFromEpochMs(value.rateLimitResetTime) }
      : {}),
    ...(lastError ? { last_error: redactStoredError(lastError) } : {}),
  }
}

/**
 * Keep a stored quota observation across writes. Anything unparseable is
 * dropped rather than carried forward, so a corrupt reading cannot make an
 * account permanently unselectable.
 */
function normalizeAccountQuota(
  value: unknown,
): SharedAnthropicAccount['quota'] | undefined {
  if (!isRecord(value)) return undefined
  const percent = (input: unknown) =>
    typeof input === 'number' && Number.isFinite(input) && input >= 0
      ? input
      : undefined
  const fiveHour = percent(value.five_hour_percent)
  const sevenDay = percent(value.seven_day_percent)
  const checkedAt = validTimestamp(value.checked_at)
  if (fiveHour === undefined && sevenDay === undefined) return undefined
  return {
    ...(fiveHour !== undefined ? { five_hour_percent: fiveHour } : {}),
    ...(sevenDay !== undefined ? { seven_day_percent: sevenDay } : {}),
    ...(checkedAt ? { checked_at: checkedAt } : {}),
  }
}

/** Keep an in-flight refresh claim across writes; drop anything malformed. */
function normalizeRefreshLease(
  value: unknown,
): SharedAnthropicAccount['refresh_lease'] | undefined {
  if (!isRecord(value)) return undefined
  const id = optionalString(value.id)
  const fingerprint = optionalString(value.token_fingerprint)
  const until = value.until
  if (!id || !fingerprint) return undefined
  if (typeof until !== 'number' || !Number.isFinite(until)) return undefined
  return { id, until, token_fingerprint: fingerprint }
}

function normalizeAccount(value: unknown): SharedAnthropicAccount | null {
  if (!isRecord(value)) return null
  if (value.credential === undefined && value.uuid !== undefined) {
    return normalizeLegacyAccount(value)
  }
  const id = optionalString(value.id)
  const credential = normalizeCredential(value.credential)
  if (!id || !credential) return null
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    return null
  const createdAt =
    value.created_at === undefined
      ? new Date().toISOString()
      : validTimestamp(value.created_at)
  if (!createdAt) return null
  const lastUsedAt = validTimestamp(value.last_used_at)
  if (value.last_used_at !== undefined && !lastUsedAt) return null
  const rateLimitedUntil = validTimestamp(value.rate_limited_until)
  if (value.rate_limited_until !== undefined && !rateLimitedUntil) return null
  const label = optionalString(value.label)
  if (value.label !== undefined && !label) return null
  const email = optionalString(value.email)
  if (value.email !== undefined && !email) return null
  const lastError = optionalString(value.last_error)
  if (value.last_error !== undefined && !lastError) return null
  return {
    id,
    label,
    email,
    credential,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    created_at: createdAt,
    last_used_at: lastUsedAt,
    rate_limited_until: rateLimitedUntil,
    last_error: lastError,
    ...(normalizeAccountQuota(value.quota)
      ? { quota: normalizeAccountQuota(value.quota) }
      : {}),
    ...(normalizeRefreshLease(value.refresh_lease)
      ? { refresh_lease: normalizeRefreshLease(value.refresh_lease) }
      : {}),
  }
}

function normalizeStore(
  value: unknown,
  options: { tolerant?: boolean } = {},
): SharedAnthropicAccountStore {
  if (!isRecord(value)) throw new Error('Invalid Anthropic account store')
  if (value.accounts !== undefined && !Array.isArray(value.accounts)) {
    throw new Error('Invalid Anthropic account list')
  }
  if (
    value.version !== undefined &&
    (typeof value.version !== 'number' ||
      !Number.isInteger(value.version) ||
      !Number.isFinite(value.version))
  ) {
    throw new Error('Invalid Anthropic account store version')
  }
  const current = optionalString(value.current)
  if (value.current !== undefined && !current) {
    throw new Error('Invalid Anthropic current account id')
  }
  const rawAccounts = Array.isArray(value.accounts) ? value.accounts : []
  const accounts: SharedAnthropicAccount[] = []
  for (const [index, account] of rawAccounts.entries()) {
    const normalized = normalizeAccount(account)
    if (normalized) {
      accounts.push(normalized)
      continue
    }
    // A legacy file is a best-effort source: one unreadable row must not cost
    // the caller the working accounts beside it. The canonical store stays
    // strict so corruption is surfaced rather than silently truncated.
    if (options.tolerant) continue
    throw new Error(`Invalid Anthropic account store entry at index ${index}`)
  }

  const migratedFrom = Array.isArray(value.migrated_from)
    ? value.migrated_from.filter(
        (entry): entry is string => typeof entry === 'string' && !!entry.trim(),
      )
    : undefined

  return {
    version:
      typeof value.version === 'number' && Number.isInteger(value.version)
        ? value.version
        : 1,
    accounts,
    current,
    ...(migratedFrom?.length ? { migrated_from: migratedFrom } : {}),
  }
}

async function pathExists(path: string) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function assertNotSymlink(path: string) {
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) {
      throw new Error(`Refusing symlinked Anthropic account store: ${path}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function readStore(path: string, options: { tolerant?: boolean } = {}) {
  await assertNotSymlink(path)
  try {
    return normalizeStore(JSON.parse(await readFile(path, 'utf8')), options)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Failed to read Anthropic account store at ${path}: ${message}`,
      { cause: error },
    )
  }
}

/**
 * Every key under which an account may already be known.
 *
 * One key is not enough. The same login rotates its refresh token, so copies
 * left in different tools' stores carry different tokens, while the Anthropic
 * account UUID and the store id stay put. Matching on any key keeps a merge
 * from admitting the same login twice — which would put duplicate ids in the
 * store and make every id-keyed update ambiguous.
 */
function accountIdentities(account: SharedAnthropicAccount) {
  const keys = [`id:${account.id}`]
  if (account.credential.type === 'api_key') {
    keys.push(`api_key:${account.credential.key}`)
    return keys
  }
  if (account.credential.refresh) {
    keys.push(`refresh:${account.credential.refresh}`)
  }
  const uuid = account.credential.account?.uuid
  if (uuid) keys.push(`uuid:${uuid}`)
  // An Anthropic account has exactly one email, and login now reads it from
  // the profile endpoint rather than inferring it, so it is a dependable
  // identity for a row whose token has already rotated away.
  const email = account.email ?? account.credential.account?.email_address
  if (email) keys.push(`email:${email.trim().toLowerCase()}`)
  return keys
}

/**
 * Read the shared store, folding in any legacy per-application store that has
 * not been adopted yet.
 *
 * Adoption used to stop at the first file that existed, so once the canonical
 * store held a single account every other login on the machine became
 * invisible — leaving a router with nothing to fall back to. Merging keeps
 * them, and the recorded `migrated_from` list stops an adopted file from
 * resurrecting accounts that were later removed on purpose.
 */
export async function loadSharedAccountStore(
  options: SharedAccountStoreOptions = {},
): Promise<LoadedSharedAccountStore> {
  const canonical = getSharedAccountStorePath(options.path)
  const canonicalExists = await pathExists(canonical)
  const base = canonicalExists ? await readStore(canonical) : undefined

  // Legacy adoption is a machine-level migration into the *default* store. An
  // explicit path means "operate on this store", so scanning the home-directory
  // candidates would merge unrelated accounts into it — wrong for tests, and
  // worse for any caller pointing at a scratch or per-project store.
  const legacyPaths =
    options.legacyPaths ??
    (options.path?.trim() || process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR
      ? []
      : getSharedAccountStoreLegacyPaths())

  const alreadyMigrated = new Set(base?.migrated_from ?? [])
  const accounts = [...(base?.accounts ?? [])]
  const seen = new Set(accounts.flatMap(accountIdentities))
  const adoptedFrom: string[] = []

  for (const candidate of legacyPaths) {
    if (candidate === canonical || alreadyMigrated.has(candidate)) continue
    if (!(await pathExists(candidate))) continue
    let legacy: SharedAnthropicAccountStore
    try {
      legacy = await readStore(candidate, { tolerant: true })
    } catch {
      // Known legacy paths predate the shared schema in some tools. An
      // unreadable legacy file must not block a valid canonical/environment
      // credential or prevent checking the remaining migration candidates.
      continue
    }
    // A file whose every row was unreadable contributed nothing, so it is not
    // recorded as adopted and stays eligible if a later version repairs it.
    if (!legacy.accounts.length) continue
    adoptedFrom.push(candidate)
    for (const account of legacy.accounts) {
      const identities = accountIdentities(account)
      if (identities.some((identity) => seen.has(identity))) continue
      for (const identity of identities) seen.add(identity)
      accounts.push(account)
    }
  }

  if (!canonicalExists && !accounts.length) {
    return { store: { version: 1, accounts: [] }, source: { type: 'empty' } }
  }

  const migratedFrom = [...alreadyMigrated, ...adoptedFrom]
  const store: SharedAnthropicAccountStore = {
    version: base?.version ?? 1,
    accounts,
    ...(base?.current ? { current: base.current } : {}),
    ...(migratedFrom.length ? { migrated_from: migratedFrom } : {}),
  }

  if (canonicalExists) {
    return {
      store,
      source: {
        type: 'canonical',
        path: canonical,
        ...(adoptedFrom.length ? { adoptedFrom } : {}),
      },
    }
  }
  const [firstAdopted] = adoptedFrom
  if (!firstAdopted) {
    return { store: { version: 1, accounts: [] }, source: { type: 'empty' } }
  }
  return {
    store,
    source: {
      type: 'legacy',
      path: firstAdopted,
      ...(adoptedFrom.length > 1 ? { adoptedFrom } : {}),
    },
  }
}

/** Utilisation at or above this is treated as no headroom left. */
const QUOTA_EXHAUSTED_PERCENT = 100

/** A quota reading older than this is too stale to disqualify an account. */
const QUOTA_OBSERVATION_MAX_AGE_MS = 30 * 60_000

/**
 * Whether the last quota reading says this account has no headroom.
 *
 * Deliberately fails open: a missing, malformed, or stale reading leaves the
 * account selectable, so a bad snapshot can never strand every account.
 */
function quotaExhausted(account: SharedAnthropicAccount, now: number) {
  const quota = account.quota
  if (!quota) return false
  const checkedAt = quota.checked_at ? Date.parse(quota.checked_at) : Number.NaN
  if (!Number.isFinite(checkedAt)) return false
  if (now - checkedAt > QUOTA_OBSERVATION_MAX_AGE_MS) return false
  return [quota.five_hour_percent, quota.seven_day_percent].some(
    (percent) =>
      typeof percent === 'number' &&
      Number.isFinite(percent) &&
      percent >= QUOTA_EXHAUSTED_PERCENT,
  )
}

function accountAvailable(account: SharedAnthropicAccount, now: number) {
  if (!account.enabled) return false
  if (quotaExhausted(account, now)) return false
  if (!account.rate_limited_until) return true
  const limitedUntil = Date.parse(account.rate_limited_until)
  return !Number.isFinite(limitedUntil) || limitedUntil <= now
}

export function pickSharedAccount(
  store: SharedAnthropicAccountStore,
  now = Date.now(),
) {
  const available = store.accounts.filter((account) =>
    accountAvailable(account, now),
  )
  // `current` is a preference, not a pin: if it is disabled, cooling down, or
  // out of quota it is not in `available`, and selection moves on rather than
  // returning an account that can only fail.
  const current = store.current
    ? available.find((account) => account.id === store.current)
    : undefined
  return current ?? available[0]
}

export function findSharedAccountByCredential(
  store: SharedAnthropicAccountStore,
  credential: SharedAnthropicCredential,
) {
  return store.accounts.find((account) => {
    if (credential.type === 'api_key') {
      return (
        account.credential.type === 'api_key' &&
        account.credential.key === credential.key
      )
    }
    if (account.credential.type !== 'oauth') return false
    return (
      account.credential.refresh === credential.refresh ||
      account.credential.access === credential.access
    )
  })
}

async function sweepOrphanTemps(path: string, now: number) {
  const parent = dirname(path)
  const prefix = `${basename(path)}.tmp-`
  let entries: string[]
  try {
    entries = await readdir(parent)
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix))
      .map(async (entry) => {
        const candidate = join(parent, entry)
        try {
          const metadata = await stat(candidate)
          if (now - metadata.mtimeMs > ORPHAN_TEMP_MAX_AGE_MS) {
            await rm(candidate, { force: true })
          }
        } catch {}
      }),
  )
}

async function writeStoreAtomic(
  path: string,
  store: SharedAnthropicAccountStore,
  now: number,
  allowEmpty = false,
) {
  const normalizedStore = normalizeStore(store)
  if (normalizedStore.accounts.length === 0 && !allowEmpty) {
    throw new Error('Refusing to delete all Anthropic accounts')
  }
  await assertNotSymlink(path)
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await chmod(parent, 0o700).catch(() => {})
  await sweepOrphanTemps(path, now)
  const temporary = join(
    parent,
    `${basename(path)}.tmp-${process.pid}-${randomUUID()}`,
  )
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(
      `${JSON.stringify(normalizedStore, null, 2)}\n`,
      'utf8',
    )
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
    await chmod(path, 0o600).catch(() => {})
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

async function acquireStoreLock(path: string, now: () => number) {
  const lockPath = `${path}.lock`
  const ownerId = randomUUID()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const deadline = now() + STORE_LOCK_WAIT_MS
  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(
          `${JSON.stringify({ ownerId, pid: process.pid, expiresAt: now() + STORE_LOCK_STALE_MS })}\n`,
        )
        await handle.sync()
      } finally {
        await handle.close()
      }
      const acquiredAt = new Date(now())
      await utimes(lockPath, acquiredAt, acquiredAt)
      const renewTimer = setInterval(() => {
        const timestamp = new Date(now())
        void utimes(lockPath, timestamp, timestamp).catch(() => {})
      }, STORE_LOCK_RENEW_MS)
      renewTimer.unref?.()
      return async () => {
        clearInterval(renewTimer)
        try {
          const owner = JSON.parse(await readFile(lockPath, 'utf8')) as {
            ownerId?: unknown
          }
          if (owner.ownerId === ownerId) await rm(lockPath, { force: true })
        } catch {
          // Lost/replaced locks belong to another process; never unlink them.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let stale = false
      try {
        const [owner, metadata] = await Promise.all([
          readFile(lockPath, 'utf8').then(
            (raw) => JSON.parse(raw) as { expiresAt?: unknown },
          ),
          stat(lockPath),
        ])
        stale =
          typeof owner.expiresAt === 'number' &&
          owner.expiresAt <= now() &&
          now() - metadata.mtimeMs >= STORE_LOCK_STALE_MS
      } catch {
        try {
          const metadata = await stat(lockPath)
          stale = now() - metadata.mtimeMs >= STORE_LOCK_STALE_MS
        } catch {}
      }
      if (stale) {
        const stalePath = `${lockPath}.stale-${ownerId}`
        try {
          await rename(lockPath, stalePath)
          await rm(stalePath, { force: true })
        } catch (claimError) {
          if ((claimError as NodeJS.ErrnoException).code !== 'ENOENT') {
            await rm(stalePath, { force: true }).catch(() => {})
          }
        }
        continue
      }
      if (now() >= deadline) {
        throw new Error(
          'Timed out waiting for the Anthropic account store lock',
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

let updateChain: Promise<void> = Promise.resolve()

function enqueueUpdate<T>(operation: () => Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    updateChain = updateChain.then(
      () => operation().then(resolve, reject),
      () => operation().then(resolve, reject),
    )
  })
}

export function saveSharedAccountStore(
  store: SharedAnthropicAccountStore,
  options: SharedAccountStoreOptions = {},
) {
  const path = getSharedAccountStorePath(options.path)
  const now = options.now ?? Date.now
  return enqueueUpdate(async () => {
    const release = await acquireStoreLock(path, now)
    try {
      await writeStoreAtomic(path, store, now())
      return path
    } finally {
      await release()
    }
  })
}

export function updateSharedAccountStore<T>(
  update: (store: SharedAnthropicAccountStore) => T | Promise<T>,
  options: SharedAccountStoreOptions = {},
): Promise<{ result: T; store: SharedAnthropicAccountStore; path: string }> {
  const path = getSharedAccountStorePath(options.path)
  const now = options.now ?? Date.now
  return enqueueUpdate(async () => {
    const release = await acquireStoreLock(path, now)
    try {
      const loaded = await loadSharedAccountStore({
        ...options,
        path,
      })
      const store = loaded.store
      const hadAccounts = store.accounts.length > 0
      const result = await update(store)
      if (store.accounts.length > 0 || hadAccounts) {
        await writeStoreAtomic(path, store, now(), options.allowEmpty === true)
      }
      return { result, store, path }
    } finally {
      await release()
    }
  })
}

export function upsertSharedAccount(
  account: SharedAnthropicAccount,
  options: SharedAccountStoreOptions & { setCurrent?: boolean } = {},
) {
  return updateSharedAccountStore((store) => {
    // Match on identity, not just id. A re-login is keyed by email while the
    // entry it supersedes may be keyed by the account UUID from an older
    // schema — matching on id alone leaves both behind, and duplicate rows make
    // every later id-keyed update ambiguous.
    const incoming = new Set(accountIdentities(account))
    const index = store.accounts.findIndex((candidate) =>
      accountIdentities(candidate).some((key) => incoming.has(key)),
    )
    if (index >= 0) {
      const previous = store.accounts[index]
      store.accounts[index] = account
      // The superseded row may have been pinned or referenced under its old
      // id; move the pin rather than leaving it dangling.
      if (previous && store.current === previous.id) store.current = account.id
    } else {
      store.accounts.push(account)
    }
    if (options.setCurrent) store.current = account.id
  }, options)
}

export function removeSharedAccount(
  id: string,
  options: SharedAccountStoreOptions = {},
) {
  return updateSharedAccountStore(
    (store) => {
      const before = store.accounts.length
      store.accounts = store.accounts.filter((account) => account.id !== id)
      if (store.current === id) store.current = undefined
      return store.accounts.length !== before
    },
    { ...options, allowEmpty: true },
  )
}

export function setSharedAccountEnabled(
  id: string,
  enabled: boolean,
  options: SharedAccountStoreOptions = {},
) {
  return updateSharedAccountStore((store) => {
    const account = store.accounts.find((candidate) => candidate.id === id)
    if (!account) return false
    account.enabled = enabled
    if (!enabled && store.current === id) store.current = undefined
    return true
  }, options)
}

/**
 * Record a quota observation so selection can rotate off an exhausted account.
 *
 * Anthropic signals exhaustion through the usage API, not through a
 * `rate_limited_until` cooldown, so without this an account sitting at 100% of
 * its weekly window still looks available and stays pinned as `current`.
 */
export function recordSharedAccountQuota(
  id: string,
  quota: {
    fiveHourPercent?: number
    sevenDayPercent?: number
    checkedAt?: number
  },
  options: SharedAccountStoreOptions = {},
) {
  return updateSharedAccountStore((store) => {
    const account = store.accounts.find((candidate) => candidate.id === id)
    if (!account) return false
    const checkedAt = new Date(
      quota.checkedAt ?? options.now?.() ?? Date.now(),
    ).toISOString()
    const next: SharedAnthropicAccount['quota'] = {
      ...(typeof quota.fiveHourPercent === 'number' &&
      Number.isFinite(quota.fiveHourPercent)
        ? { five_hour_percent: quota.fiveHourPercent }
        : {}),
      ...(typeof quota.sevenDayPercent === 'number' &&
      Number.isFinite(quota.sevenDayPercent)
        ? { seven_day_percent: quota.sevenDayPercent }
        : {}),
      checked_at: checkedAt,
    }
    if (
      next.five_hour_percent === undefined &&
      next.seven_day_percent === undefined
    ) {
      return false
    }
    account.quota = next
    // An exhausted pin is worse than no pin: leaving it set makes every caller
    // start on an account that can only fail.
    if (store.current === id && !accountAvailable(account, Date.now())) {
      store.current = undefined
    }
    return true
  }, options)
}

/** How long a refresh claim stays valid before another process may take it. */
const REFRESH_LEASE_TTL_MS = 30_000

/** Outcome of trying to claim the right to refresh an account. */
export type SharedRefreshClaim =
  | { status: 'claimed'; leaseId: string }
  /** Another process already rotated the token; use `credential` as-is. */
  | { status: 'already-refreshed'; credential: SharedOAuthCredential }
  /** Another process holds a live claim; wait and re-read. */
  | { status: 'held'; until: number }
  | { status: 'unknown-account' }

/**
 * Claim the exclusive right to refresh `accountId`.
 *
 * Anthropic revokes the whole token family when a refresh token is presented
 * twice, so two processes must never POST the same one. Claude Code guards this
 * with a lock that it re-reads under before deciding to refresh at all; this is
 * the equivalent, expressed as a short lease in the shared store so it works
 * across processes without holding a file lock over a network call.
 */
export function claimSharedAccountRefresh(
  accountId: string,
  refreshToken: string,
  options: SharedAccountStoreOptions & { ttlMs?: number } = {},
): Promise<SharedRefreshClaim> {
  const now = options.now?.() ?? Date.now()
  const ttl = options.ttlMs ?? REFRESH_LEASE_TTL_MS
  const leaseId = randomUUID()
  let outcome: SharedRefreshClaim = { status: 'unknown-account' }

  return updateSharedAccountStore((store) => {
    const account = store.accounts.find(
      (candidate) => candidate.id === accountId,
    )
    if (!account || account.credential.type !== 'oauth') {
      outcome = { status: 'unknown-account' }
      return false
    }

    // Someone already rotated it while we were getting here: the token we were
    // handed is spent, and presenting it would revoke the family.
    if (account.credential.refresh !== refreshToken) {
      outcome = { status: 'already-refreshed', credential: account.credential }
      return false
    }

    const lease = account.refresh_lease
    if (lease && lease.until > now && lease.id !== leaseId) {
      outcome = { status: 'held', until: lease.until }
      return false
    }

    account.refresh_lease = {
      id: leaseId,
      until: now + ttl,
      token_fingerprint: tokenFingerprint(refreshToken),
    }
    outcome = { status: 'claimed', leaseId }
    return true
  }, options).then(() => outcome)
}

/** Release a refresh claim without altering the credential. */
export function releaseSharedAccountRefresh(
  accountId: string,
  leaseId: string,
  options: SharedAccountStoreOptions = {},
) {
  return updateSharedAccountStore((store) => {
    const account = store.accounts.find(
      (candidate) => candidate.id === accountId,
    )
    if (!account?.refresh_lease || account.refresh_lease.id !== leaseId) {
      return false
    }
    account.refresh_lease = undefined
    return true
  }, options)
}

export function reorderSharedAccounts(
  orderedIds: readonly string[],
  options: SharedAccountStoreOptions = {},
) {
  return updateSharedAccountStore((store) => {
    const byId = new Map(store.accounts.map((account) => [account.id, account]))
    const ordered = orderedIds.flatMap((id) => {
      const account = byId.get(id)
      if (!account) return []
      byId.delete(id)
      return [account]
    })
    store.accounts = [...ordered, ...byId.values()]
  }, options)
}
