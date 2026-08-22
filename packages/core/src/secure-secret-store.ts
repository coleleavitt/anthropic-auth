import { execFile as nodeExecFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, rm, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { inspect } from 'node:util'

export const DEFAULT_SECURE_SECRET_MAX_BYTES = 64 * 1024
export const DEFAULT_SECRET_COMMAND_TIMEOUT_MS = 10_000

export type SecureSecretStoreErrorCode =
  | 'invalid_limit'
  | 'not_regular_file'
  | 'insecure_permissions'
  | 'output_too_large'
  | 'read_failed'
  | 'symlink_refused'
  | 'write_failed'
  | 'delete_failed'
  | 'command_failed'
  | 'command_timed_out'

/** An error that deliberately omits secret values and command stderr. */
export class SecureSecretStoreError extends Error {
  constructor(
    public readonly code: SecureSecretStoreErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SecureSecretStoreError'
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message }
  }

  [inspect.custom]() {
    return `${this.name} [${this.code}]: ${this.message}`
  }
}

/** Minimal contract shared by file stores and read-only keychain adapters. */
export interface SecureSecretReader {
  read(): Promise<string | null>
}

/** Mutable secret-store contract implemented by the atomic file backend. */
export interface SecureSecretStore extends SecureSecretReader {
  write(secret: string): Promise<void>
  delete(): Promise<boolean>
}

export type ExecFileInvocationOptions = {
  encoding: 'utf8'
  timeout: number
  maxBuffer: number
  windowsHide: true
  shell: false
}

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: ExecFileInvocationOptions,
  callback: (
    error: (Error & { code?: unknown; killed?: boolean }) | null,
    stdout: string | Buffer,
    stderr: string | Buffer,
  ) => void,
) => { kill?: () => unknown } | undefined

function validatePositiveLimit(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SecureSecretStoreError(
      'invalid_limit',
      `${label} must be a positive safe integer`,
    )
  }
  return value
}

function errnoCode(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)
    ? code
    : undefined
}

function sanitizeFileFailure(
  operation: 'read' | 'write' | 'delete',
  error: unknown,
): SecureSecretStoreError {
  if (error instanceof SecureSecretStoreError) return error
  const code = errnoCode(error)
  const suffix = code ? ` (${code})` : ''
  const errorCode = `${operation}_failed` as const
  return new SecureSecretStoreError(
    errorCode,
    `Secure secret ${operation} failed${suffix}`,
  )
}

async function assertRegularDestination(path: string) {
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) {
      throw new SecureSecretStoreError(
        'symlink_refused',
        'Refusing a symlinked secure secret file',
      )
    }
    if (!metadata.isFile()) {
      throw new SecureSecretStoreError(
        'not_regular_file',
        'Secure secret path is not a regular file',
      )
    }
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') throw error
  }
}

/** Create (or tighten) a directory used for private state. */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) {
      throw new SecureSecretStoreError(
        'symlink_refused',
        'Refusing a symlinked private directory',
      )
    }
    if (!metadata.isDirectory()) {
      throw new SecureSecretStoreError(
        'not_regular_file',
        'Private state directory path is not a directory',
      )
    }
    if (process.platform !== 'win32') await chmod(path, 0o700)
  } catch (error) {
    throw sanitizeFileFailure('write', error)
  }
}

/**
 * Read a regular file without following a final-component symlink and without
 * ever allocating or returning more than maxBytes.
 */
export async function readBoundedPrivateFile(
  path: string,
  maxBytes = DEFAULT_SECURE_SECRET_MAX_BYTES,
): Promise<string | null> {
  validatePositiveLimit(maxBytes, 'maxBytes')

  try {
    let initial: Awaited<ReturnType<typeof lstat>>
    try {
      initial = await lstat(path)
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return null
      throw error
    }
    if (initial.isSymbolicLink()) {
      throw new SecureSecretStoreError(
        'symlink_refused',
        'Refusing a symlinked secure secret file',
      )
    }
    if (!initial.isFile()) {
      throw new SecureSecretStoreError(
        'not_regular_file',
        'Secure secret path is not a regular file',
      )
    }
    if (initial.size > maxBytes) {
      throw new SecureSecretStoreError(
        'output_too_large',
        'Secure secret file exceeds the configured read limit',
      )
    }

    const noFollow =
      process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0)
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(path, fsConstants.O_RDONLY | noFollow)
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return null
      if (errnoCode(error) === 'ELOOP') {
        throw new SecureSecretStoreError(
          'symlink_refused',
          'Refusing a symlinked secure secret file',
        )
      }
      throw error
    }

    try {
      const opened = await handle.stat()
      if (!opened.isFile()) {
        throw new SecureSecretStoreError(
          'not_regular_file',
          'Secure secret path is not a regular file',
        )
      }
      if (process.platform !== 'win32' && (opened.mode & 0o077) !== 0) {
        throw new SecureSecretStoreError(
          'insecure_permissions',
          'Secure secret file must not be group/world accessible',
        )
      }
      if (
        initial.ino !== 0 &&
        opened.ino !== 0 &&
        (initial.dev !== opened.dev || initial.ino !== opened.ino)
      ) {
        throw new SecureSecretStoreError(
          'read_failed',
          'Secure secret file changed while it was being opened',
        )
      }
      if (opened.size > maxBytes) {
        throw new SecureSecretStoreError(
          'output_too_large',
          'Secure secret file exceeds the configured read limit',
        )
      }

      const output = Buffer.alloc(maxBytes + 1)
      let offset = 0
      while (offset <= maxBytes) {
        const { bytesRead } = await handle.read(
          output,
          offset,
          output.byteLength - offset,
          null,
        )
        if (bytesRead === 0) break
        offset += bytesRead
      }
      if (offset > maxBytes) {
        throw new SecureSecretStoreError(
          'output_too_large',
          'Secure secret file exceeds the configured read limit',
        )
      }
      return output.subarray(0, offset).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch (error) {
    throw sanitizeFileFailure('read', error)
  }
}

async function syncDirectoryBestEffort(path: string) {
  if (process.platform === 'win32') return
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, fsConstants.O_RDONLY)
    await handle.sync()
  } catch {
    // Some filesystems do not permit directory fsync. The file itself was
    // already fsynced, and rename still provides atomic visibility.
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** Atomically replace a private regular file with explicit 0600 permissions. */
export async function writePrivateFileAtomic(
  path: string,
  value: string | Uint8Array,
  options: { maxBytes?: number } = {},
): Promise<void> {
  const maxBytes = validatePositiveLimit(
    options.maxBytes ?? DEFAULT_SECURE_SECRET_MAX_BYTES,
    'maxBytes',
  )
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  if (bytes.byteLength > maxBytes) {
    throw new SecureSecretStoreError(
      'output_too_large',
      'Secure secret value exceeds the configured write limit',
    )
  }

  const parent = dirname(path)
  const temporary = join(
    parent,
    `${basename(path)}.tmp-${process.pid}-${randomUUID()}`,
  )

  try {
    await ensurePrivateDirectory(parent)
    await assertRegularDestination(path)

    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }

    try {
      // A pre-existing symlink is rejected rather than silently replaced.
      await assertRegularDestination(path)
      await rename(temporary, path)
      if (process.platform !== 'win32') await chmod(path, 0o600)
      await syncDirectoryBestEffort(parent)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw sanitizeFileFailure('write', error)
  }
}

async function deletePrivateFile(path: string): Promise<boolean> {
  try {
    let metadata: Awaited<ReturnType<typeof lstat>>
    try {
      metadata = await lstat(path)
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return false
      throw error
    }
    if (metadata.isSymbolicLink()) {
      throw new SecureSecretStoreError(
        'symlink_refused',
        'Refusing to delete a symlinked secure secret file',
      )
    }
    if (!metadata.isFile()) {
      throw new SecureSecretStoreError(
        'not_regular_file',
        'Secure secret path is not a regular file',
      )
    }
    await unlink(path)
    return true
  } catch (error) {
    throw sanitizeFileFailure('delete', error)
  }
}

/** A path-bound, atomic, user-private file secret store. */
export class FileSecureSecretStore implements SecureSecretStore {
  public readonly maxBytes: number

  constructor(
    public readonly path: string,
    options: { maxBytes?: number } = {},
  ) {
    this.maxBytes = validatePositiveLimit(
      options.maxBytes ?? DEFAULT_SECURE_SECRET_MAX_BYTES,
      'maxBytes',
    )
  }

  read() {
    return readBoundedPrivateFile(this.path, this.maxBytes)
  }

  get() {
    return this.read()
  }

  write(secret: string) {
    return writePrivateFileAtomic(this.path, secret, {
      maxBytes: this.maxBytes,
    })
  }

  set(secret: string) {
    return this.write(secret)
  }

  delete() {
    return deletePrivateFile(this.path)
  }

  remove() {
    return this.delete()
  }

  toString() {
    return `FileSecureSecretStore(${this.path}, secret=[REDACTED])`
  }

  [inspect.custom]() {
    return this.toString()
  }
}

export {
  FileSecureSecretStore as AtomicFileSecretStore,
  FileSecureSecretStore as AtomicFileSecureSecretStore,
}

export function createFileSecureSecretStore(
  path: string,
  options: { maxBytes?: number } = {},
) {
  return new FileSecureSecretStore(path, options)
}

function defaultExecFile(
  file: string,
  args: readonly string[],
  options: ExecFileInvocationOptions,
  callback: Parameters<ExecFileLike>[3],
) {
  return nodeExecFile(file, [...args], options, (error, stdout, stderr) => {
    callback(error, stdout, stderr)
  })
}

/** Execute a fixed program/argv pair with no shell and hard output/time caps. */
export function execFileBounded(
  file: string,
  args: readonly string[],
  options: {
    execFile?: ExecFileLike
    timeoutMs?: number
    maxOutputBytes?: number
  } = {},
): Promise<string> {
  const timeoutMs = validatePositiveLimit(
    options.timeoutMs ?? DEFAULT_SECRET_COMMAND_TIMEOUT_MS,
    'timeoutMs',
  )
  const maxOutputBytes = validatePositiveLimit(
    options.maxOutputBytes ?? DEFAULT_SECURE_SECRET_MAX_BYTES,
    'maxOutputBytes',
  )
  const execFile = options.execFile ?? defaultExecFile

  return new Promise((resolve, reject) => {
    let settled = false
    let child: ReturnType<ExecFileLike>
    const finish = (operation: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      operation()
    }
    const timer = setTimeout(() => {
      try {
        child?.kill?.()
      } catch {}
      finish(() =>
        reject(
          new SecureSecretStoreError(
            'command_timed_out',
            'Secure secret command timed out',
          ),
        ),
      )
    }, timeoutMs)
    timer.unref?.()

    try {
      child = execFile(
        file,
        args,
        {
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: maxOutputBytes,
          windowsHide: true,
          shell: false,
        },
        (error, stdout) => {
          if (error) {
            finish(() =>
              reject(
                new SecureSecretStoreError(
                  'command_failed',
                  'Secure secret command failed',
                ),
              ),
            )
            return
          }
          const output =
            typeof stdout === 'string'
              ? stdout
              : Buffer.from(stdout).toString('utf8')
          if (Buffer.byteLength(output, 'utf8') > maxOutputBytes) {
            finish(() =>
              reject(
                new SecureSecretStoreError(
                  'output_too_large',
                  'Secure secret command output exceeded its limit',
                ),
              ),
            )
            return
          }
          finish(() => resolve(output))
        },
      )
    } catch {
      finish(() =>
        reject(
          new SecureSecretStoreError(
            'command_failed',
            'Secure secret command failed',
          ),
        ),
      )
    }
  })
}

export type CommandSecureSecretStoreOptions = {
  command: string
  args?: readonly string[]
  execFile?: ExecFileLike
  timeoutMs?: number
  maxOutputBytes?: number
  trimOutput?: boolean
}

/** Injectable read-only adapter for keychains and other fixed commands. */
export class CommandSecureSecretStore implements SecureSecretReader {
  constructor(private readonly options: CommandSecureSecretStoreOptions) {}

  async read(): Promise<string | null> {
    const output = await execFileBounded(
      this.options.command,
      this.options.args ?? [],
      this.options,
    )
    const value = this.options.trimOutput ? output.trim() : output
    return value.length > 0 ? value : null
  }

  get() {
    return this.read()
  }

  toString() {
    return `CommandSecureSecretStore(${this.options.command}, output=[REDACTED])`
  }

  [inspect.custom]() {
    return this.toString()
  }
}

export function createCommandSecureSecretStore(
  options: CommandSecureSecretStoreOptions,
) {
  return new CommandSecureSecretStore(options)
}
