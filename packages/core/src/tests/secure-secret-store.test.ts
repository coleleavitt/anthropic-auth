import { afterEach, describe, expect, test } from 'bun:test'
import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'

import {
  CommandSecureSecretStore,
  type ExecFileInvocationOptions,
  type ExecFileLike,
  FileSecureSecretStore,
  SecureSecretStoreError,
} from '../secure-secret-store.ts'

const tempDirectories: string[] = []

async function temporaryDirectory(prefix = 'secure-secret-store-') {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  tempDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('file secure secret store', () => {
  test('atomically round-trips secrets with explicit private permissions', async () => {
    const root = await temporaryDirectory()
    const directory = join(root, 'private')
    const path = join(directory, 'credential')
    const store = new FileSecureSecretStore(path)

    await store.write('first-secret')
    await store.set('second-secret')

    expect(await store.read()).toBe('second-secret')
    expect(await store.get()).toBe('second-secret')
    expect(await readFile(path, 'utf8')).toBe('second-secret')
    expect((await readdir(directory)).sort()).toEqual(['credential'])
    expect(String(store)).not.toContain('second-secret')
    expect(inspect(store)).not.toContain('second-secret')

    if (process.platform !== 'win32') {
      expect((await lstat(directory)).mode & 0o777).toBe(0o700)
      expect((await lstat(path)).mode & 0o777).toBe(0o600)
    }

    expect(await store.delete()).toBe(true)
    expect(await store.remove()).toBe(false)
  })

  test('refuses to read, replace, or delete a symlinked secret', async () => {
    if (process.platform === 'win32') return
    const root = await temporaryDirectory()
    const target = join(root, 'target.txt')
    const path = join(root, 'credential')
    await writeFile(target, 'target-secret', { mode: 0o600 })
    await symlink(target, path)
    const store = new FileSecureSecretStore(path)

    await expect(store.read()).rejects.toMatchObject({
      code: 'symlink_refused',
    })
    await expect(store.write('replacement')).rejects.toMatchObject({
      code: 'symlink_refused',
    })
    await expect(store.delete()).rejects.toMatchObject({
      code: 'symlink_refused',
    })
    expect(await readFile(target, 'utf8')).toBe('target-secret')
    expect((await lstat(path)).isSymbolicLink()).toBe(true)
  })

  test('bounds both reads and writes without echoing secret data in errors', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'credential')
    const secret = 'do-not-echo-this-secret'
    await writeFile(path, secret)
    const store = new FileSecureSecretStore(path, { maxBytes: 8 })

    for (const operation of [() => store.read(), () => store.write(secret)]) {
      try {
        await operation()
        throw new Error('expected the bounded operation to fail')
      } catch (error) {
        expect(error).toBeInstanceOf(SecureSecretStoreError)
        expect(String(error)).not.toContain(secret)
        expect(inspect(error)).not.toContain(secret)
        expect(JSON.stringify(error)).not.toContain(secret)
      }
    }
    expect(await readFile(path, 'utf8')).toBe(secret)
  })
})

describe('command secure secret adapter', () => {
  test('uses an argv-only execFile call with enforced output and time limits', async () => {
    const calls: Array<{
      file: string
      args: readonly string[]
      options: ExecFileInvocationOptions
    }> = []
    const execFile: ExecFileLike = (file, args, options, callback) => {
      calls.push({ file, args: [...args], options })
      queueMicrotask(() => callback(null, '  stored-value\n', 'ignored'))
      return { kill() {} }
    }
    const store = new CommandSecureSecretStore({
      command: 'security',
      args: ['find-generic-password', '-a', 'user', '-w', '-s', 'service'],
      execFile,
      timeoutMs: 123,
      maxOutputBytes: 456,
      trimOutput: true,
    })

    expect(await store.read()).toBe('stored-value')
    expect(calls).toEqual([
      {
        file: 'security',
        args: ['find-generic-password', '-a', 'user', '-w', '-s', 'service'],
        options: {
          encoding: 'utf8',
          timeout: 123,
          maxBuffer: 456,
          windowsHide: true,
          shell: false,
        },
      },
    ])
  })

  test('redacts command failures and independently rejects oversized injected output', async () => {
    const secret = 'stderr-super-secret'
    const failingExec: ExecFileLike = (_file, _args, _options, callback) => {
      queueMicrotask(() => callback(new Error(secret), '', secret))
      return { kill() {} }
    }
    const failing = new CommandSecureSecretStore({
      command: 'security',
      execFile: failingExec,
    })

    try {
      await failing.read()
      throw new Error('expected command failure')
    } catch (error) {
      expect(error).toBeInstanceOf(SecureSecretStoreError)
      expect(String(error)).not.toContain(secret)
      expect(inspect(error)).not.toContain(secret)
      expect(JSON.stringify(error)).not.toContain(secret)
    }

    const oversizedExec: ExecFileLike = (_file, _args, _options, callback) => {
      queueMicrotask(() => callback(null, 'x'.repeat(9), ''))
      return { kill() {} }
    }
    const oversized = new CommandSecureSecretStore({
      command: 'security',
      execFile: oversizedExec,
      maxOutputBytes: 8,
    })
    await expect(oversized.read()).rejects.toMatchObject({
      code: 'output_too_large',
    })
  })

  test('kills an injected command that exceeds its deadline', async () => {
    let killed = false
    const stalledExec: ExecFileLike = () => ({
      kill() {
        killed = true
      },
    })
    const store = new CommandSecureSecretStore({
      command: 'security',
      execFile: stalledExec,
      timeoutMs: 10,
    })

    await expect(store.read()).rejects.toMatchObject({
      code: 'command_timed_out',
    })
    expect(killed).toBe(true)
  })
})
