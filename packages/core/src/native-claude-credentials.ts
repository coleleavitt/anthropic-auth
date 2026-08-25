import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'

import {
  CommandSecureSecretStore,
  DEFAULT_SECRET_COMMAND_TIMEOUT_MS,
  DEFAULT_SECURE_SECRET_MAX_BYTES,
  type ExecFileLike,
  FileSecureSecretStore,
  type SecureSecretStore,
  SecureSecretStoreError,
} from './secure-secret-store.ts'
import {
  findSharedAccountByCredential,
  type SharedAccountStoreOptions,
  type SharedAnthropicAccount,
  updateSharedAccountStore,
} from './shared-account-store.ts'

export const NATIVE_CLAUDE_KEYCHAIN_SERVICE = 'Claude Code'
export const DEFAULT_CLAUDE_KEYCHAIN_SERVICE = NATIVE_CLAUDE_KEYCHAIN_SERVICE
export const NATIVE_CLAUDE_KEYCHAIN_ACCOUNT_FALLBACK = 'claude-code-user'
export const NATIVE_CLAUDE_CREDENTIALS_FILE_NAME = '.credentials.json'
export const NATIVE_CLAUDE_KEYCHAIN_TIMEOUT_MS =
  DEFAULT_SECRET_COMMAND_TIMEOUT_MS
export const NATIVE_CLAUDE_CREDENTIAL_MAX_BYTES =
  DEFAULT_SECURE_SECRET_MAX_BYTES

const KEYCHAIN_ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/
const REDACTED = '[REDACTED]'

type Environment = Readonly<Record<string, string | undefined>>

export type NativeClaudePathOptions = {
  environment?: Environment
  homeDirectory?: string
  /** Alias retained for callers that already inject homedir as homeDir. */
  homeDir?: string
  configDirectory?: string
}

export type NativeClaudeAiOauth = Readonly<{
  accessToken: string
  refreshToken: string
  expiresAt: number
  refreshTokenExpiresAt?: number
  scopes?: readonly string[]
  subscriptionType?: string | null
  rateLimitTier?: string | null
  clientId?: string
}>

function redactedOauthJson(oauth: NativeClaudeAiOauth) {
  return {
    accessToken: REDACTED,
    refreshToken: REDACTED,
    expiresAt: oauth.expiresAt,
    ...(oauth.refreshTokenExpiresAt !== undefined
      ? { refreshTokenExpiresAt: oauth.refreshTokenExpiresAt }
      : {}),
    ...(oauth.scopes ? { scopes: [...oauth.scopes] } : {}),
    ...(oauth.subscriptionType !== undefined
      ? { subscriptionType: oauth.subscriptionType }
      : {}),
    ...(oauth.rateLimitTier !== undefined
      ? { rateLimitTier: oauth.rateLimitTier }
      : {}),
    ...(oauth.clientId !== undefined ? { clientId: REDACTED } : {}),
  }
}

class RedactedNativeClaudeAiOauth implements NativeClaudeAiOauth {
  public readonly accessToken: string
  public readonly refreshToken: string
  public readonly expiresAt: number
  public readonly refreshTokenExpiresAt?: number
  public readonly scopes?: readonly string[]
  public readonly subscriptionType?: string | null
  public readonly rateLimitTier?: string | null
  public readonly clientId?: string

  constructor(input: NativeClaudeAiOauth) {
    this.accessToken = input.accessToken
    this.refreshToken = input.refreshToken
    this.expiresAt = input.expiresAt
    this.refreshTokenExpiresAt = input.refreshTokenExpiresAt
    this.scopes = input.scopes ? Object.freeze([...input.scopes]) : undefined
    this.subscriptionType = input.subscriptionType
    this.rateLimitTier = input.rateLimitTier
    this.clientId = input.clientId
    Object.freeze(this)
  }

  toString() {
    return `NativeClaudeAiOauth(${REDACTED})`
  }

  toJSON() {
    return redactedOauthJson(this)
  }

  [inspect.custom]() {
    return this.toString()
  }
}

export type NativeClaudeCredentialSource =
  | { type: 'keychain'; service: string; account: string }
  | { type: 'plaintext'; path: string }

/** A deliberately redacting view of Claude Code's native credential payload. */
export class NativeClaudeCredentials {
  public readonly claudeAiOauth: NativeClaudeAiOauth
  public readonly trustedDeviceToken?: string

  constructor(input: {
    claudeAiOauth: NativeClaudeAiOauth
    trustedDeviceToken?: string
  }) {
    this.claudeAiOauth = new RedactedNativeClaudeAiOauth(input.claudeAiOauth)
    if (input.trustedDeviceToken !== undefined) {
      this.trustedDeviceToken = input.trustedDeviceToken
    }
    Object.freeze(this)
  }

  toString() {
    return `NativeClaudeCredentials { claudeAiOauth: ${REDACTED}, trustedDeviceToken: ${
      this.trustedDeviceToken === undefined ? 'absent' : REDACTED
    } }`
  }

  toJSON() {
    return {
      claudeAiOauth: redactedOauthJson(this.claudeAiOauth),
      ...(this.trustedDeviceToken === undefined
        ? {}
        : { trustedDeviceToken: REDACTED }),
    }
  }

  [inspect.custom]() {
    return this.toString()
  }
}

export type LoadedNativeClaudeCredentials = {
  credentials: NativeClaudeCredentials
  source: NativeClaudeCredentialSource
}

export type NativeClaudeCredentialErrorCode =
  | 'plaintext_read_failed'
  | 'plaintext_symlink_refused'
  | 'plaintext_insecure_permissions'
  | 'plaintext_too_large'
  | 'keychain_invalid'

/** Native credential errors never retain raw source text or an unsafe cause. */
export class NativeClaudeCredentialError extends Error {
  constructor(
    public readonly code: NativeClaudeCredentialErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'NativeClaudeCredentialError'
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message }
  }

  [inspect.custom]() {
    return `${this.name} [${this.code}]: ${this.message}`
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function optionalNullableString(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined | false {
  const value = record[key]
  if (value === undefined) return undefined
  if (value === null || typeof value === 'string') return value
  return false
}

/**
 * Whitelist Claude Code's OAuth entry and trusted-device token. Other sibling
 * credentials (API keys, MCP OAuth data, and future stores) are never copied.
 */
export function parseNativeClaudeCredentials(
  input: string | unknown,
): NativeClaudeCredentials | null {
  let value = input
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input)
    } catch {
      return null
    }
  }
  if (!isRecord(value) || !isRecord(value.claudeAiOauth)) return null

  const rawOauth = value.claudeAiOauth
  if (
    !nonEmptyString(rawOauth.accessToken) ||
    !nonEmptyString(rawOauth.refreshToken) ||
    !finiteNumber(rawOauth.expiresAt)
  ) {
    return null
  }
  if (
    rawOauth.refreshTokenExpiresAt !== undefined &&
    !finiteNumber(rawOauth.refreshTokenExpiresAt)
  ) {
    return null
  }

  let scopes: readonly string[] | undefined
  if (rawOauth.scopes !== undefined) {
    if (
      !Array.isArray(rawOauth.scopes) ||
      !rawOauth.scopes.every(nonEmptyString)
    ) {
      return null
    }
    scopes = [...rawOauth.scopes]
  }

  const subscriptionType = optionalNullableString(rawOauth, 'subscriptionType')
  const rateLimitTier = optionalNullableString(rawOauth, 'rateLimitTier')
  if (subscriptionType === false || rateLimitTier === false) return null
  if (rawOauth.clientId !== undefined && !nonEmptyString(rawOauth.clientId)) {
    return null
  }
  if (
    value.trustedDeviceToken !== undefined &&
    !nonEmptyString(value.trustedDeviceToken)
  ) {
    return null
  }

  return new NativeClaudeCredentials({
    claudeAiOauth: {
      accessToken: rawOauth.accessToken,
      refreshToken: rawOauth.refreshToken,
      expiresAt: rawOauth.expiresAt,
      ...(typeof rawOauth.refreshTokenExpiresAt === 'number'
        ? { refreshTokenExpiresAt: rawOauth.refreshTokenExpiresAt }
        : {}),
      ...(scopes ? { scopes } : {}),
      ...(subscriptionType !== undefined ? { subscriptionType } : {}),
      ...(rateLimitTier !== undefined ? { rateLimitTier } : {}),
      ...(typeof rawOauth.clientId === 'string'
        ? { clientId: rawOauth.clientId }
        : {}),
    },
    ...(typeof value.trustedDeviceToken === 'string'
      ? { trustedDeviceToken: value.trustedDeviceToken }
      : {}),
  })
}

function selectedHomeDirectory(options: NativeClaudePathOptions) {
  return options.homeDirectory ?? options.homeDir ?? homedir()
}

function hasEnvironmentValue(environment: Environment, name: string) {
  return Object.hasOwn(environment, name)
}

function resolveNativeConfig(options: NativeClaudePathOptions = {}): {
  directory: string
  custom: boolean
} {
  const environment = options.environment ?? process.env
  const defaultDirectory = join(selectedHomeDirectory(options), '.claude')

  if (options.configDirectory !== undefined) {
    return {
      directory: (options.configDirectory || defaultDirectory).normalize('NFC'),
      custom: options.configDirectory.length > 0,
    }
  }

  if (hasEnvironmentValue(environment, 'CLAUDE_SECURESTORAGE_CONFIG_DIR')) {
    const configured = environment.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? ''
    return {
      directory: (configured || defaultDirectory).normalize('NFC'),
      custom: configured.length > 0,
    }
  }

  const configured = environment.CLAUDE_CONFIG_DIR ?? ''
  return {
    directory: (configured || defaultDirectory).normalize('NFC'),
    custom: configured.length > 0,
  }
}

export function getNativeClaudeConfigDirectory(
  options: NativeClaudePathOptions = {},
) {
  return resolveNativeConfig(options).directory
}

export function getNativeClaudeCredentialsPath(
  options: NativeClaudePathOptions = {},
) {
  return join(
    getNativeClaudeConfigDirectory(options),
    NATIVE_CLAUDE_CREDENTIALS_FILE_NAME,
  )
}

/** Claude Code uses an eight-hex SHA-256 suffix for non-default config dirs. */
export function getNativeClaudeKeychainService(
  options: NativeClaudePathOptions = {},
) {
  const config = resolveNativeConfig(options)
  if (!config.custom) return NATIVE_CLAUDE_KEYCHAIN_SERVICE
  const suffix = createHash('sha256')
    .update(config.directory)
    .digest('hex')
    .slice(0, 8)
  return `${NATIVE_CLAUDE_KEYCHAIN_SERVICE}-${suffix}`
}

export type NativeClaudeAccountOptions = NativeClaudePathOptions & {
  username?: string
  userInfo?: () => { username: string }
}

/** Match Claude Code's USER/userInfo lookup and conservative account charset. */
export function getNativeClaudeKeychainAccount(
  options: NativeClaudeAccountOptions = {},
) {
  const environment = options.environment ?? process.env
  let username = options.username || environment.USER
  if (!username) {
    try {
      username = (options.userInfo ?? userInfo)().username
    } catch {
      username = NATIVE_CLAUDE_KEYCHAIN_ACCOUNT_FALLBACK
    }
  }
  return username && KEYCHAIN_ACCOUNT_PATTERN.test(username)
    ? username
    : NATIVE_CLAUDE_KEYCHAIN_ACCOUNT_FALLBACK
}

export type NativeClaudeKeychainReadRequest = {
  service: string
  account: string
  timeoutMs: number
  maxOutputBytes: number
}

export interface NativeClaudeKeychainAdapter {
  read(request: NativeClaudeKeychainReadRequest): Promise<string | null>
}

export type NativeClaudeCredentialOptions = NativeClaudeAccountOptions & {
  platform?: NodeJS.Platform
  execFile?: ExecFileLike
  keychainStore?: Pick<SecureSecretStore, 'read'>
  keychainAdapter?: NativeClaudeKeychainAdapter
  timeoutMs?: number
  maxBytes?: number
}

export function createNativeClaudeKeychainStore(
  options: NativeClaudeCredentialOptions = {},
) {
  const service = getNativeClaudeKeychainService(options)
  const account = getNativeClaudeKeychainAccount(options)
  return new CommandSecureSecretStore({
    command: 'security',
    args: ['find-generic-password', '-a', account, '-w', '-s', service],
    execFile: options.execFile,
    timeoutMs: options.timeoutMs ?? NATIVE_CLAUDE_KEYCHAIN_TIMEOUT_MS,
    maxOutputBytes: options.maxBytes ?? NATIVE_CLAUDE_CREDENTIAL_MAX_BYTES,
    trimOutput: true,
  })
}

function rawWithinLimit(raw: string | null, maxBytes: number) {
  return raw === null || Buffer.byteLength(raw, 'utf8') <= maxBytes
}

async function readKeychain(
  options: NativeClaudeCredentialOptions,
): Promise<string | null> {
  const maxBytes = options.maxBytes ?? NATIVE_CLAUDE_CREDENTIAL_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? NATIVE_CLAUDE_KEYCHAIN_TIMEOUT_MS
  const service = getNativeClaudeKeychainService(options)
  const account = getNativeClaudeKeychainAccount(options)

  try {
    let raw: string | null
    if (options.keychainAdapter) {
      raw = await options.keychainAdapter.read({
        service,
        account,
        timeoutMs,
        maxOutputBytes: maxBytes,
      })
    } else if (options.keychainStore) {
      raw = await options.keychainStore.read()
    } else {
      raw = await createNativeClaudeKeychainStore(options).read()
    }
    return rawWithinLimit(raw, maxBytes) ? raw : null
  } catch {
    // Keychain unavailability, denial, malformed output, and timeout all fall
    // through to Claude Code's plaintext compatibility file.
    return null
  }
}

function plaintextReadError(error: unknown) {
  if (
    error instanceof SecureSecretStoreError &&
    error.code === 'symlink_refused'
  ) {
    return new NativeClaudeCredentialError(
      'plaintext_symlink_refused',
      'Refusing a symlinked native Claude credential file',
    )
  }
  if (
    error instanceof SecureSecretStoreError &&
    error.code === 'insecure_permissions'
  ) {
    return new NativeClaudeCredentialError(
      'plaintext_insecure_permissions',
      'Native Claude credential file must not be group/world accessible',
    )
  }
  if (
    error instanceof SecureSecretStoreError &&
    error.code === 'output_too_large'
  ) {
    return new NativeClaudeCredentialError(
      'plaintext_too_large',
      'Native Claude credential file exceeds the read limit',
    )
  }
  return new NativeClaudeCredentialError(
    'plaintext_read_failed',
    'Failed to read native Claude credentials',
  )
}

/**
 * Discover native credentials without changing either the keychain or the
 * plaintext source. A usable keychain value wins; plaintext is fallback-only.
 */
export async function discoverNativeClaudeCredentials(
  options: NativeClaudeCredentialOptions = {},
): Promise<LoadedNativeClaudeCredentials | null> {
  const platform = options.platform ?? process.platform
  const hasInjectedKeychain = Boolean(
    options.keychainStore || options.keychainAdapter,
  )
  if (platform === 'darwin' || hasInjectedKeychain) {
    const raw = await readKeychain(options)
    if (raw !== null) {
      const credentials = parseNativeClaudeCredentials(raw)
      if (!credentials) {
        throw new NativeClaudeCredentialError(
          'keychain_invalid',
          'Native Claude keychain entry is malformed',
        )
      }
      return {
        credentials,
        source: {
          type: 'keychain',
          service: getNativeClaudeKeychainService(options),
          account: getNativeClaudeKeychainAccount(options),
        },
      }
    }
  }

  const path = getNativeClaudeCredentialsPath(options)
  let raw: string | null
  try {
    raw = await new FileSecureSecretStore(path, {
      maxBytes: options.maxBytes ?? NATIVE_CLAUDE_CREDENTIAL_MAX_BYTES,
    }).read()
  } catch (error) {
    throw plaintextReadError(error)
  }
  if (raw === null) return null
  const credentials = parseNativeClaudeCredentials(raw)
  return credentials
    ? { credentials, source: { type: 'plaintext', path } }
    : null
}

export async function loadNativeClaudeCredentials(
  options: NativeClaudeCredentialOptions = {},
) {
  return (await discoverNativeClaudeCredentials(options))?.credentials ?? null
}

export const readNativeClaudeCredentials = loadNativeClaudeCredentials

/**
 * Explicitly import native Claude OAuth into the project-neutral account store.
 * Discovery itself remains read-only; only this opt-in operation copies the
 * credential. Trusted-device state is returned to the caller and never written
 * into accounts.json.
 */
export async function importNativeClaudeAccount(
  options: NativeClaudeCredentialOptions & {
    id?: string
    label?: string
    setCurrent?: boolean
    sharedStore?: SharedAccountStoreOptions
    now?: () => number
  } = {},
): Promise<{
  account: SharedAnthropicAccount
  source: NativeClaudeCredentialSource
  trustedDeviceToken?: string
} | null> {
  const loaded = await discoverNativeClaudeCredentials(options)
  if (!loaded) return null
  const oauth = loaded.credentials.claudeAiOauth
  const now = options.now?.() ?? Date.now()
  const candidateCredential = {
    type: 'oauth' as const,
    access: oauth.accessToken,
    refresh: oauth.refreshToken,
    expires_at: oauth.expiresAt,
    ...(typeof oauth.refreshTokenExpiresAt === 'number'
      ? { refresh_expires_at: oauth.refreshTokenExpiresAt }
      : {}),
    ...(oauth.scopes?.length ? { scopes: [...oauth.scopes] } : {}),
  }
  const updated = await updateSharedAccountStore((store) => {
    const existing =
      findSharedAccountByCredential(store, candidateCredential) ??
      store.accounts.find(
        (account) => account.id === (options.id?.trim() || 'native-claude'),
      )
    const account: SharedAnthropicAccount = {
      id: existing?.id ?? (options.id?.trim() || 'native-claude'),
      label: options.label?.trim() || existing?.label || 'Native Claude',
      email: existing?.email,
      credential: candidateCredential,
      enabled: true,
      created_at: existing?.created_at ?? new Date(now).toISOString(),
      last_used_at: existing?.last_used_at,
      rate_limited_until: existing?.rate_limited_until,
      last_error: undefined,
    }
    const index = store.accounts.findIndex((entry) => entry.id === account.id)
    if (index >= 0) store.accounts[index] = account
    else store.accounts.push(account)
    if (options.setCurrent !== false) store.current = account.id
    return account
  }, options.sharedStore)
  return {
    account: updated.result,
    source: loaded.source,
    ...(loaded.credentials.trustedDeviceToken
      ? { trustedDeviceToken: loaded.credentials.trustedDeviceToken }
      : {}),
  }
}

/**
 * Whether native-credential access should be suppressed.
 *
 * A test run points the shared store at a temporary directory but has no way to
 * relocate Claude Code's own file, so without this a test would read — and,
 * worse, rewrite — the developer's live credential. An explicit path opts back
 * in, which is how the tests for these helpers exercise them.
 */
function nativeAccessIsSandboxed(options: NativeClaudePathOptions) {
  if (options.configDirectory || options.homeDirectory || options.homeDir) {
    return false
  }
  const environment = options.environment ?? process.env
  return Boolean(
    environment.OPENCODE_ANTHROPIC_AUTH_TEST_DIR ||
      environment.ANTHROPIC_ACCOUNTS_DIR ||
      environment.ANTHROPIC_ACCOUNTS_FILE,
  )
}

/**
 * Publish a rotated OAuth credential back into Claude Code's own store.
 *
 * Anthropic rotates the refresh token on every refresh and revokes the whole
 * family when a superseded one is presented. So when this library refreshes a
 * credential Claude Code also holds, staying silent forks the family: our copy
 * moves forward, the native app keeps the token it had, and the next refresh
 * from either side kills the account for both.
 *
 * Claude Code stats `.credentials.json` and clears its credential cache when
 * the mtime changes (`J8()` in the 2.1.241 bundle), so writing here is how the
 * rotation reaches it — there is no IPC to call.
 *
 * Every field the file already carries is preserved: `subscriptionType` and
 * `rateLimitTier` are written by the login flow and never by a refresh, and
 * dropping them would degrade the native app's own behaviour. Unknown
 * top-level keys survive too, since this file is Claude Code's, not ours.
 */
export async function publishNativeClaudeOAuth(
  oauth: {
    accessToken: string
    refreshToken: string
    expiresAt: number
    refreshTokenExpiresAt?: number
    scopes?: readonly string[]
  },
  options: NativeClaudePathOptions = {},
): Promise<'written' | 'absent' | 'unchanged'> {
  // Never touch the developer's real Claude Code credential from a test run.
  if (nativeAccessIsSandboxed(options)) return 'absent'
  const path = getNativeClaudeCredentialsPath(options)

  let existingRaw: string
  try {
    existingRaw = await readFile(path, 'utf8')
  } catch {
    // No native install, or a keychain-backed one: nothing to keep in step.
    return 'absent'
  }

  let existing: Record<string, unknown>
  try {
    existing = JSON.parse(existingRaw) as Record<string, unknown>
  } catch {
    // Refuse to overwrite a file we cannot parse — it may be mid-write, and a
    // clobbered credential file logs the user out of Claude Code entirely.
    return 'absent'
  }

  const previous = isRecord(existing.claudeAiOauth)
    ? existing.claudeAiOauth
    : {}
  if (previous.refreshToken === oauth.refreshToken) return 'unchanged'

  const next = {
    ...existing,
    claudeAiOauth: {
      ...previous,
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      ...(oauth.refreshTokenExpiresAt !== undefined
        ? { refreshTokenExpiresAt: oauth.refreshTokenExpiresAt }
        : {}),
      ...(oauth.scopes ? { scopes: [...oauth.scopes] } : {}),
    },
  }

  // Write-and-rename so a reader never observes a half-written credential.
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
    mode: 0o600,
  })
  await rename(temporary, path)
  return 'written'
}

/**
 * The OAuth credential Claude Code currently holds, or null when there is no
 * readable file-backed one.
 */
export async function readNativeClaudeOAuth(
  options: NativeClaudePathOptions = {},
): Promise<NativeClaudeAiOauth | null> {
  if (nativeAccessIsSandboxed(options)) return null
  try {
    const raw = await readFile(getNativeClaudeCredentialsPath(options), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const oauth = isRecord(parsed.claudeAiOauth) ? parsed.claudeAiOauth : null
    if (!oauth) return null
    return typeof oauth.accessToken === 'string' &&
      typeof oauth.refreshToken === 'string'
      ? (oauth as unknown as NativeClaudeAiOauth)
      : null
  } catch {
    return null
  }
}
