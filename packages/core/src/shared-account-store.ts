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
}

export type SharedAnthropicAccountStore = {
  version: number
  accounts: SharedAnthropicAccount[]
  current?: string
}

export type SharedAccountStoreSource =
  | { type: 'canonical'; path: string }
  | { type: 'legacy'; path: string }
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
  const paths: string[] = []
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

function normalizeAccount(value: unknown): SharedAnthropicAccount | null {
  if (!isRecord(value)) return null
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
  }
}

function normalizeStore(value: unknown): SharedAnthropicAccountStore {
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
  const accounts = rawAccounts.map((account, index) => {
    const normalized = normalizeAccount(account)
    if (!normalized) {
      throw new Error(`Invalid Anthropic account store entry at index ${index}`)
    }
    return normalized
  })
  return {
    version:
      typeof value.version === 'number' && Number.isInteger(value.version)
        ? value.version
        : 1,
    accounts,
    current,
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

async function readStore(path: string) {
  await assertNotSymlink(path)
  try {
    return normalizeStore(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Failed to read Anthropic account store at ${path}: ${message}`,
      { cause: error },
    )
  }
}

export async function loadSharedAccountStore(
  options: SharedAccountStoreOptions = {},
): Promise<LoadedSharedAccountStore> {
  const canonical = getSharedAccountStorePath(options.path)
  if (await pathExists(canonical)) {
    return {
      store: await readStore(canonical),
      source: { type: 'canonical', path: canonical },
    }
  }
  const legacyPaths =
    options.legacyPaths ??
    (process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR
      ? []
      : getSharedAccountStoreLegacyPaths())
  for (const candidate of legacyPaths) {
    if (!(await pathExists(candidate))) continue
    try {
      return {
        store: await readStore(candidate),
        source: { type: 'legacy', path: candidate },
      }
    } catch {
      // Known legacy paths predate the shared schema in some tools. An
      // incompatible legacy file must not block a valid OpenCode/environment
      // credential or prevent checking the remaining migration candidates.
    }
  }
  return {
    store: { version: 1, accounts: [] },
    source: { type: 'empty' },
  }
}

function accountAvailable(account: SharedAnthropicAccount, now: number) {
  if (!account.enabled) return false
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
    const index = store.accounts.findIndex(
      (candidate) => candidate.id === account.id,
    )
    if (index >= 0) store.accounts[index] = account
    else store.accounts.push(account)
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
