import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, lstat, open, rename, rm, utimes } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { inspect } from 'node:util'

import {
  ensurePrivateDirectory,
  readBoundedPrivateFile,
  SecureSecretStoreError,
  writePrivateFileAtomic,
} from './secure-secret-store.ts'

export const DEVICE_IDENTITY_VERSION = 1 as const
export const DEVICE_IDENTITY_DIRECTORY_NAME = '.anthropic-accounts'
export const DEVICE_IDENTITY_FILE_NAME = 'device.json'
export const DEVICE_IDENTITY_MAX_BYTES = 4 * 1024
export const DEVICE_IDENTITY_LOCK_STALE_MS = 10_000
export const DEVICE_IDENTITY_LOCK_WAIT_MS = 12_000
export const DEVICE_IDENTITY_LOCK_POLL_MS = 25

const DEVICE_ID_PATTERN = /^[0-9a-f]{64}$/
const LOCK_MAX_BYTES = 4 * 1024

type Environment = Readonly<Record<string, string | undefined>>

export type DeviceIdentityPathOptions = {
  path?: string
  directory?: string
  environment?: Environment
  homeDirectory?: string
  /** Alias for callers that inject the Node homedir value as homeDir. */
  homeDir?: string
}

export type DeviceIdentityOptions = DeviceIdentityPathOptions & {
  now?: () => number
  randomBytes?: (size: number) => Uint8Array
  sleep?: (milliseconds: number) => Promise<void>
  maxReadBytes?: number
  lockStaleMs?: number
  lockWaitMs?: number
  lockPollMs?: number
}

/**
 * The TypeScript API is camelCase; the persisted version-1 schema uses
 * `device_id` to remain language-neutral alongside accounts.json.
 */
export class DeviceIdentity {
  public readonly version = DEVICE_IDENTITY_VERSION

  constructor(public readonly deviceId: string) {
    if (!DEVICE_ID_PATTERN.test(deviceId)) {
      throw new DeviceIdentityError(
        'invalid_identity',
        'Device identity must be 32 bytes encoded as lowercase hexadecimal',
      )
    }
    Object.freeze(this)
  }

  get id() {
    return this.deviceId
  }

  get device_id() {
    return this.deviceId
  }

  toJSON() {
    return { version: this.version, device_id: this.deviceId }
  }

  toString() {
    return `DeviceIdentity(${this.deviceId})`
  }

  [inspect.custom]() {
    return this.toString()
  }
}

export type DeviceIdentityErrorCode =
  | 'invalid_identity'
  | 'read_failed'
  | 'read_limit_exceeded'
  | 'symlink_refused'
  | 'write_failed'
  | 'lock_timeout'
  | 'random_source_failed'

export class DeviceIdentityError extends Error {
  constructor(
    public readonly code: DeviceIdentityErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'DeviceIdentityError'
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

function nonEmptyEnvironmentPath(environment: Environment, name: string) {
  const value = environment[name]?.trim()
  return value || undefined
}

function selectedHomeDirectory(options: DeviceIdentityPathOptions) {
  return options.homeDirectory ?? options.homeDir ?? homedir()
}

/** Follow the shared account store's explicit/file-env/directory-env ordering. */
export function getDeviceIdentityPath(options: DeviceIdentityPathOptions = {}) {
  const explicit = options.path?.trim()
  if (explicit) return explicit
  const explicitDirectory = options.directory?.trim()
  if (explicitDirectory)
    return join(explicitDirectory, DEVICE_IDENTITY_FILE_NAME)

  const environment = options.environment ?? process.env
  const accountsFile = nonEmptyEnvironmentPath(
    environment,
    'ANTHROPIC_ACCOUNTS_FILE',
  )
  if (accountsFile) {
    return join(dirname(accountsFile), DEVICE_IDENTITY_FILE_NAME)
  }
  const accountsDirectory = nonEmptyEnvironmentPath(
    environment,
    'ANTHROPIC_ACCOUNTS_DIR',
  )
  if (accountsDirectory) {
    return join(accountsDirectory, DEVICE_IDENTITY_FILE_NAME)
  }

  if (environment.OPENCODE_ANTHROPIC_AUTH_TEST_DIR) {
    const sidecar = nonEmptyEnvironmentPath(
      environment,
      'OPENCODE_ANTHROPIC_AUTH_FILE',
    )
    if (sidecar) return join(dirname(sidecar), DEVICE_IDENTITY_FILE_NAME)
  }

  return join(
    selectedHomeDirectory(options),
    DEVICE_IDENTITY_DIRECTORY_NAME,
    DEVICE_IDENTITY_FILE_NAME,
  )
}

export function getDeviceIdentityDirectory(
  options: DeviceIdentityPathOptions = {},
) {
  return dirname(getDeviceIdentityPath(options))
}

export function getDeviceIdentityLockPath(
  options: DeviceIdentityPathOptions = {},
) {
  return `${getDeviceIdentityPath(options)}.lock`
}

/** Parse without mutating the supplied object or source text. */
export function parseDeviceIdentity(input: string | unknown): DeviceIdentity {
  let value = input
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input)
    } catch {
      throw new DeviceIdentityError(
        'invalid_identity',
        'Device identity file contains invalid JSON',
      )
    }
  }
  if (!isRecord(value) || value.version !== DEVICE_IDENTITY_VERSION) {
    throw new DeviceIdentityError(
      'invalid_identity',
      'Device identity file has an unsupported schema',
    )
  }

  const candidates = [value.device_id, value.deviceId, value.id].filter(
    (candidate): candidate is string => candidate !== undefined,
  )
  if (
    candidates.length === 0 ||
    !candidates.every(
      (candidate) =>
        typeof candidate === 'string' && candidate === candidates[0],
    )
  ) {
    throw new DeviceIdentityError(
      'invalid_identity',
      'Device identity file has an invalid identifier',
    )
  }
  return new DeviceIdentity(candidates[0] ?? '')
}

function mapReadError(error: unknown) {
  if (
    error instanceof SecureSecretStoreError &&
    error.code === 'symlink_refused'
  ) {
    return new DeviceIdentityError(
      'symlink_refused',
      'Refusing a symlinked device identity file or directory',
    )
  }
  if (
    error instanceof SecureSecretStoreError &&
    error.code === 'output_too_large'
  ) {
    return new DeviceIdentityError(
      'read_limit_exceeded',
      'Device identity file exceeds the read limit',
    )
  }
  return new DeviceIdentityError(
    'read_failed',
    'Failed to read the device identity file',
  )
}

async function loadDeviceIdentityAtPath(path: string, maxReadBytes: number) {
  let raw: string | null
  try {
    raw = await readBoundedPrivateFile(path, maxReadBytes)
  } catch (error) {
    throw mapReadError(error)
  }
  return raw === null ? null : parseDeviceIdentity(raw)
}

export function loadDeviceIdentity(
  options: DeviceIdentityOptions = {},
): Promise<DeviceIdentity | null> {
  return loadDeviceIdentityAtPath(
    getDeviceIdentityPath(options),
    options.maxReadBytes ?? DEVICE_IDENTITY_MAX_BYTES,
  )
}

export const readDeviceIdentity = loadDeviceIdentity

function positiveOption(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DeviceIdentityError(
      'invalid_identity',
      `${name} must be a positive safe integer`,
    )
  }
  return value
}

function errnoCode(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

function parseLockOwner(raw: string | null) {
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value)) return null
    return {
      ownerId: typeof value.ownerId === 'string' ? value.ownerId : undefined,
      expiresAt:
        typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)
          ? value.expiresAt
          : undefined,
    }
  } catch {
    return null
  }
}

async function lockIsStale(lockPath: string, now: number, staleMs: number) {
  let metadata: Awaited<ReturnType<typeof lstat>>
  try {
    metadata = await lstat(lockPath)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return false
    throw error
  }

  let owner: ReturnType<typeof parseLockOwner> = null
  if (metadata.isFile() && !metadata.isSymbolicLink()) {
    try {
      owner = parseLockOwner(
        await readBoundedPrivateFile(lockPath, LOCK_MAX_BYTES),
      )
    } catch {
      owner = null
    }
  }
  const oldHeartbeat = now - metadata.mtimeMs >= staleMs
  return owner?.expiresAt !== undefined
    ? owner.expiresAt <= now && oldHeartbeat
    : oldHeartbeat
}

async function claimStaleLock(lockPath: string, ownerId: string) {
  const stalePath = `${lockPath}.stale-${ownerId}`
  try {
    await rename(lockPath, stalePath)
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') {
      await rm(stalePath, { force: true }).catch(() => {})
    }
    return false
  }
  await rm(stalePath, { force: true }).catch(() => {})
  return true
}

async function readLockOwnerId(lockPath: string) {
  try {
    return parseLockOwner(
      await readBoundedPrivateFile(lockPath, LOCK_MAX_BYTES),
    )?.ownerId
  } catch {
    return undefined
  }
}

async function acquireDeviceLock(path: string, options: DeviceIdentityOptions) {
  const lockPath = `${path}.lock`
  const now = options.now ?? Date.now
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const staleMs = positiveOption(
    options.lockStaleMs ?? DEVICE_IDENTITY_LOCK_STALE_MS,
    'lockStaleMs',
  )
  const waitMs = positiveOption(
    options.lockWaitMs ?? DEVICE_IDENTITY_LOCK_WAIT_MS,
    'lockWaitMs',
  )
  const pollMs = positiveOption(
    options.lockPollMs ?? DEVICE_IDENTITY_LOCK_POLL_MS,
    'lockPollMs',
  )
  const ownerId = randomUUID()

  await ensurePrivateDirectory(dirname(path))
  const logicalDeadline = now() + waitMs
  const monotonicDeadline = Date.now() + waitMs

  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(
          `${JSON.stringify({
            version: 1,
            ownerId,
            pid: process.pid,
            expiresAt: now() + staleMs,
          })}\n`,
          'utf8',
        )
        await handle.sync()
      } catch (error) {
        await handle.close().catch(() => {})
        await rm(lockPath, { force: true }).catch(() => {})
        throw error
      }
      await handle.close()
      if (process.platform !== 'win32') await chmod(lockPath, 0o600)
      const acquiredAt = new Date(now())
      await utimes(lockPath, acquiredAt, acquiredAt)

      const renewTimer = setInterval(
        () => {
          void (async () => {
            if ((await readLockOwnerId(lockPath)) !== ownerId) return
            const heartbeat = new Date(now())
            await utimes(lockPath, heartbeat, heartbeat)
          })().catch(() => {})
        },
        Math.max(1, Math.min(3_000, Math.floor(staleMs / 3))),
      )
      renewTimer.unref?.()

      return async () => {
        clearInterval(renewTimer)
        if ((await readLockOwnerId(lockPath)) !== ownerId) return
        await rm(lockPath, { force: true }).catch(() => {})
      }
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') {
        if (error instanceof SecureSecretStoreError) throw mapReadError(error)
        throw new DeviceIdentityError(
          'write_failed',
          'Failed to acquire the device identity lock',
        )
      }

      if (await lockIsStale(lockPath, now(), staleMs)) {
        await claimStaleLock(lockPath, ownerId)
        continue
      }
      if (now() >= logicalDeadline || Date.now() >= monotonicDeadline) {
        throw new DeviceIdentityError(
          'lock_timeout',
          'Timed out waiting for the device identity lock',
        )
      }
      await sleep(pollMs)
    }
  }
}

function generateDeviceId(options: DeviceIdentityOptions) {
  let bytes: Uint8Array
  try {
    bytes = (options.randomBytes ?? randomBytes)(32)
  } catch {
    throw new DeviceIdentityError(
      'random_source_failed',
      'Failed to generate a device identity',
    )
  }
  if (bytes.byteLength !== 32) {
    throw new DeviceIdentityError(
      'random_source_failed',
      'Device identity random source returned an invalid byte count',
    )
  }
  return Buffer.from(bytes).toString('hex')
}

/** Get the process/account-independent device identity, creating it once. */
export async function getOrCreateDeviceIdentity(
  options: DeviceIdentityOptions = {},
): Promise<DeviceIdentity> {
  const path = getDeviceIdentityPath(options)
  const maxReadBytes = positiveOption(
    options.maxReadBytes ?? DEVICE_IDENTITY_MAX_BYTES,
    'maxReadBytes',
  )

  try {
    await ensurePrivateDirectory(dirname(path))
  } catch (error) {
    if (error instanceof SecureSecretStoreError) throw mapReadError(error)
    throw new DeviceIdentityError(
      'write_failed',
      'Failed to prepare the device identity directory',
    )
  }

  const existing = await loadDeviceIdentityAtPath(path, maxReadBytes)
  if (existing) return existing

  const release = await acquireDeviceLock(path, options)
  try {
    const createdByPeer = await loadDeviceIdentityAtPath(path, maxReadBytes)
    if (createdByPeer) return createdByPeer

    const identity = new DeviceIdentity(generateDeviceId(options))
    try {
      await writePrivateFileAtomic(path, `${JSON.stringify(identity)}\n`, {
        maxBytes: maxReadBytes,
      })
    } catch (error) {
      if (
        error instanceof SecureSecretStoreError &&
        error.code === 'symlink_refused'
      ) {
        throw new DeviceIdentityError(
          'symlink_refused',
          'Refusing a symlinked device identity file or directory',
        )
      }
      throw new DeviceIdentityError(
        'write_failed',
        'Failed to persist the device identity',
      )
    }
    return identity
  } finally {
    await release()
  }
}

export async function getOrCreateDeviceId(options: DeviceIdentityOptions = {}) {
  return (await getOrCreateDeviceIdentity(options)).deviceId
}
