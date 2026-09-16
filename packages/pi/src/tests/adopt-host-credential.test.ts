import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveSharedAccountStore } from '@cortexkit/anthropic-auth-core'

import {
  adoptSharedCredentialIntoHostAuth,
  getHostAuthPath,
} from '../adopt-host-credential'

const originalStorePath = process.env.ANTHROPIC_ACCOUNTS_FILE
const originalPiAgentDir = process.env.PI_AGENT_DIR
const originalTestDir = process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR
const temporaryDirectories: string[] = []

afterEach(async () => {
  if (originalStorePath === undefined)
    delete process.env.ANTHROPIC_ACCOUNTS_FILE
  else process.env.ANTHROPIC_ACCOUNTS_FILE = originalStorePath
  if (originalPiAgentDir === undefined) delete process.env.PI_AGENT_DIR
  else process.env.PI_AGENT_DIR = originalPiAgentDir
  if (originalTestDir === undefined)
    delete process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR
  else process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR = originalTestDir
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function setupEnvironment() {
  const directory = await mkdtemp(join(tmpdir(), 'pi-adopt-'))
  temporaryDirectories.push(directory)
  process.env.PI_AGENT_DIR = directory
  process.env.ANTHROPIC_ACCOUNTS_FILE = join(directory, 'accounts.json')
  // Without this the loader also scans the home-directory legacy stores and
  // merges this machine's real accounts into the fixture, so the negative
  // cases below would see accounts they never created.
  process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR = directory
  return { directory, authPath: join(directory, 'auth.json') }
}

function oauthAccount(
  id: string,
  expiresAt: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    email: `${id}@example.test`,
    credential: {
      type: 'oauth' as const,
      access: `${id}-access`,
      refresh: `${id}-refresh`,
      expires_at: expiresAt,
    },
    enabled: true,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

async function readAuth(path: string) {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, any>
}

describe('adoptSharedCredentialIntoHostAuth', () => {
  test('seeds an empty host auth file from the live shared account', async () => {
    const { authPath } = await setupEnvironment()
    const expiresAt = Date.now() + 3_600_000
    await saveSharedAccountStore({
      version: 1,
      current: 'main',
      accounts: [oauthAccount('main', expiresAt)],
    })

    const result = await adoptSharedCredentialIntoHostAuth()

    expect(result.outcome).toBe('adopted')
    expect(result.refreshPending).toBe(false)
    expect(result.account).toBe('main@example.test')
    expect((await readAuth(authPath)).anthropic).toEqual({
      type: 'oauth',
      access: 'main-access',
      refresh: 'main-refresh',
      expires: expiresAt,
    })
  })

  test('never overwrites a credential the host already holds', async () => {
    const { authPath } = await setupEnvironment()
    await writeFile(
      authPath,
      JSON.stringify({
        anthropic: { type: 'oauth', access: 'host', refresh: 'r', expires: 1 },
      }),
    )
    await saveSharedAccountStore({
      version: 1,
      current: 'main',
      accounts: [oauthAccount('main', Date.now() + 3_600_000)],
    })

    const result = await adoptSharedCredentialIntoHostAuth()

    expect(result.outcome).toBe('already-present')
    expect((await readAuth(authPath)).anthropic.access).toBe('host')
  })

  test('adopts an expired account so the host can refresh it', async () => {
    // Pi's stored-credential gate does not check expiry, so seeding an expired
    // entry still lets the run start; Pi then routes through refreshToken.
    const { authPath } = await setupEnvironment()
    const expiredAt = Date.now() - 60_000
    await saveSharedAccountStore({
      version: 1,
      current: 'stale',
      accounts: [oauthAccount('stale', expiredAt)],
    })

    const result = await adoptSharedCredentialIntoHostAuth()

    expect(result.outcome).toBe('adopted')
    expect(result.refreshPending).toBe(true)
    expect((await readAuth(authPath)).anthropic.access).toBe('stale-access')
  })

  test('prefers a live account over an expired one', async () => {
    const { authPath } = await setupEnvironment()
    await saveSharedAccountStore({
      version: 1,
      current: 'stale',
      accounts: [
        oauthAccount('stale', Date.now() - 60_000),
        oauthAccount('live', Date.now() + 3_600_000),
      ],
    })

    const result = await adoptSharedCredentialIntoHostAuth()

    expect(result.outcome).toBe('adopted')
    expect(result.refreshPending).toBe(false)
    expect((await readAuth(authPath)).anthropic.access).toBe('live-access')
  })

  test('skips disabled accounts', async () => {
    await setupEnvironment()
    await saveSharedAccountStore({
      version: 1,
      current: 'off',
      accounts: [
        oauthAccount('off', Date.now() + 3_600_000, { enabled: false }),
      ],
    })

    expect((await adoptSharedCredentialIntoHostAuth()).outcome).toBe(
      'no-usable-account',
    )
  })

  test('reports no usable account when the store holds no OAuth account', async () => {
    // An API-key account cannot seed Pi's OAuth entry; the store guard also
    // refuses a genuinely empty account list, so this is the empty-equivalent.
    await setupEnvironment()
    await saveSharedAccountStore({
      version: 1,
      current: 'key',
      accounts: [
        {
          id: 'key',
          credential: { type: 'api_key', key: 'sk-ant-api-test' },
          enabled: true,
          created_at: new Date().toISOString(),
        },
      ],
    })

    expect((await adoptSharedCredentialIntoHostAuth()).outcome).toBe(
      'no-usable-account',
    )
  })

  test('reports no usable account when the store file is absent', async () => {
    await setupEnvironment()

    expect((await adoptSharedCredentialIntoHostAuth()).outcome).toBe(
      'no-usable-account',
    )
  })

  test('preserves other providers already in the host auth file', async () => {
    const { authPath } = await setupEnvironment()
    await writeFile(
      authPath,
      JSON.stringify({ openai: { type: 'api_key', key: 'sk-other' } }),
    )
    await saveSharedAccountStore({
      version: 1,
      current: 'main',
      accounts: [oauthAccount('main', Date.now() + 3_600_000)],
    })

    await adoptSharedCredentialIntoHostAuth()

    const auth = await readAuth(authPath)
    expect(auth.openai).toEqual({ type: 'api_key', key: 'sk-other' })
    expect(auth.anthropic.access).toBe('main-access')
  })

  test('recovers from a corrupt host auth file', async () => {
    const { authPath } = await setupEnvironment()
    await writeFile(authPath, '{ not json')
    await saveSharedAccountStore({
      version: 1,
      current: 'main',
      accounts: [oauthAccount('main', Date.now() + 3_600_000)],
    })

    expect((await adoptSharedCredentialIntoHostAuth()).outcome).toBe('adopted')
    expect((await readAuth(authPath)).anthropic.access).toBe('main-access')
  })

  test('writes the host auth file with owner-only permissions', async () => {
    const { authPath } = await setupEnvironment()
    await saveSharedAccountStore({
      version: 1,
      current: 'main',
      accounts: [oauthAccount('main', Date.now() + 3_600_000)],
    })

    await adoptSharedCredentialIntoHostAuth()

    expect((await stat(authPath)).mode & 0o777).toBe(0o600)
  })

  test('resolves the host auth path under the Pi agent directory', async () => {
    const { directory, authPath } = await setupEnvironment()
    expect(getHostAuthPath()).toBe(authPath)
    expect(getHostAuthPath().startsWith(directory)).toBe(true)
  })
})
