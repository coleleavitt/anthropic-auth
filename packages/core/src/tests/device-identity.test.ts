import { afterEach, describe, expect, test } from 'bun:test'
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  DEVICE_IDENTITY_FILE_NAME,
  getDeviceIdentityLockPath,
  getDeviceIdentityPath,
  getOrCreateDeviceId,
  getOrCreateDeviceIdentity,
  loadDeviceIdentity,
} from '../device-identity.ts'

const tempDirectories: string[] = []

async function temporaryDirectory(prefix = 'device-identity-') {
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

describe('device identity paths and persistence', () => {
  test('uses account file, account directory, then the private home default', async () => {
    const root = await temporaryDirectory()
    const home = join(root, 'home')
    const accountsFile = join(root, 'file-override', 'accounts.json')
    const accountsDirectory = join(root, 'directory-override')

    expect(
      getDeviceIdentityPath({
        environment: {
          ANTHROPIC_ACCOUNTS_FILE: accountsFile,
          ANTHROPIC_ACCOUNTS_DIR: accountsDirectory,
        },
        homeDirectory: home,
      }),
    ).toBe(join(dirname(accountsFile), DEVICE_IDENTITY_FILE_NAME))
    expect(
      getDeviceIdentityPath({
        environment: { ANTHROPIC_ACCOUNTS_DIR: accountsDirectory },
        homeDirectory: home,
      }),
    ).toBe(join(accountsDirectory, DEVICE_IDENTITY_FILE_NAME))
    expect(
      getDeviceIdentityPath({ environment: {}, homeDirectory: home }),
    ).toBe(join(home, '.anthropic-accounts', 'device.json'))
  })

  test('creates one version-1 32-byte identity and reuses it across callers', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'state', 'device.json')
    let randomCalls = 0
    const first = await getOrCreateDeviceIdentity({
      path,
      environment: {},
      randomBytes(size) {
        randomCalls++
        expect(size).toBe(32)
        return new Uint8Array(size).fill(0xab)
      },
    })
    const second = await getOrCreateDeviceIdentity({
      path,
      environment: {},
      randomBytes() {
        throw new Error('must not rotate an existing identity')
      },
    })

    expect(first.version).toBe(1)
    expect(first.deviceId).toBe('ab'.repeat(32))
    expect(first.id).toBe(first.deviceId)
    expect(first.device_id).toBe(first.deviceId)
    expect(second.deviceId).toBe(first.deviceId)
    expect(await getOrCreateDeviceId({ path, environment: {} })).toBe(
      first.deviceId,
    )
    expect(randomCalls).toBe(1)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: 1,
      device_id: 'ab'.repeat(32),
    })
    expect((await readdir(dirname(path))).sort()).toEqual(['device.json'])

    if (process.platform !== 'win32') {
      expect((await lstat(dirname(path))).mode & 0o777).toBe(0o700)
      expect((await lstat(path)).mode & 0o777).toBe(0o600)
    }
  })

  test('does not rotate a malformed existing identity', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'device.json')
    await writeFile(path, JSON.stringify({ version: 1, device_id: 'ABC' }), {
      mode: 0o600,
    })
    let randomCalls = 0

    await expect(
      getOrCreateDeviceIdentity({
        path,
        environment: {},
        randomBytes(size) {
          randomCalls++
          return new Uint8Array(size)
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_identity' })
    expect(randomCalls).toBe(0)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: 1,
      device_id: 'ABC',
    })
  })
})

describe('device identity filesystem safety', () => {
  test('refuses a symlink without changing its target', async () => {
    if (process.platform === 'win32') return
    const root = await temporaryDirectory()
    const path = join(root, 'device.json')
    const target = join(root, 'target.json')
    await writeFile(
      target,
      JSON.stringify({ version: 1, device_id: 'cd'.repeat(32) }),
    )
    await symlink(target, path)

    await expect(
      getOrCreateDeviceIdentity({ path, environment: {} }),
    ).rejects.toMatchObject({ code: 'symlink_refused' })
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({
      version: 1,
      device_id: 'cd'.repeat(32),
    })
    expect((await lstat(path)).isSymbolicLink()).toBe(true)
  })

  test('bounds reads before parsing an existing identity', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'device.json')
    await writeFile(path, 'x'.repeat(257), { mode: 0o600 })

    await expect(
      loadDeviceIdentity({ path, environment: {}, maxReadBytes: 256 }),
    ).rejects.toMatchObject({ code: 'read_limit_exceeded' })
  })

  test('recovers a stale owner lock and removes it after creation', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'state', 'device.json')
    const lockPath = getDeviceIdentityLockPath({ path, environment: {} })
    const now = Date.now()
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(
      lockPath,
      `${JSON.stringify({
        version: 1,
        ownerId: 'dead-owner',
        pid: 1,
        expiresAt: now - 20_000,
      })}\n`,
      { mode: 0o600 },
    )
    const old = new Date(now - 20_000)
    await utimes(lockPath, old, old)

    const identity = await getOrCreateDeviceIdentity({
      path,
      environment: {},
      now: () => now,
      lockStaleMs: 1_000,
      randomBytes: (size) => new Uint8Array(size).fill(0xef),
    })

    expect(identity.deviceId).toBe('ef'.repeat(32))
    expect(await readdir(dirname(path))).toEqual(['device.json'])
  })
})

describe('device identity concurrency', () => {
  test('concurrent creators all observe one persisted ID', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'state', 'device.json')
    let randomCalls = 0
    const options = {
      path,
      environment: {},
      randomBytes(size: number) {
        randomCalls++
        const bytes = new Uint8Array(size)
        bytes.fill(randomCalls)
        return bytes
      },
    }

    const identities = await Promise.all(
      Array.from({ length: 32 }, () => getOrCreateDeviceIdentity(options)),
    )
    const ids = new Set(identities.map((identity) => identity.deviceId))

    expect(ids.size).toBe(1)
    expect(randomCalls).toBe(1)
    expect((await loadDeviceIdentity(options))?.deviceId).toBe(
      identities[0]?.deviceId,
    )
    expect((await readdir(dirname(path))).sort()).toEqual(['device.json'])
  })
})
