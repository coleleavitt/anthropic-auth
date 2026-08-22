import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'

import {
  discoverNativeClaudeCredentials,
  getNativeClaudeCredentialsPath,
  getNativeClaudeKeychainAccount,
  getNativeClaudeKeychainService,
  importNativeClaudeAccount,
  loadNativeClaudeCredentials,
  NATIVE_CLAUDE_CREDENTIAL_MAX_BYTES,
  NATIVE_CLAUDE_KEYCHAIN_TIMEOUT_MS,
  parseNativeClaudeCredentials,
} from '../native-claude-credentials.ts'
import type {
  ExecFileInvocationOptions,
  ExecFileLike,
} from '../secure-secret-store.ts'
import { loadSharedAccountStore } from '../shared-account-store.ts'

const tempDirectories: string[] = []

async function temporaryDirectory(prefix = 'native-claude-credentials-') {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  tempDirectories.push(directory)
  return directory
}

function credentialPayload(
  marker: string,
  extras: Record<string, unknown> = {},
) {
  return {
    claudeAiOauth: {
      accessToken: `access-${marker}`,
      refreshToken: `refresh-${marker}`,
      expiresAt: 2_000_000_000_000,
      refreshTokenExpiresAt: 2_100_000_000_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_5x',
      clientId: `client-${marker}`,
      ignoredOauthSecret: `oauth-sibling-${marker}`,
    },
    trustedDeviceToken: `device-${marker}`,
    primaryApiKey: `api-${marker}`,
    mcpOauth: { refreshToken: `mcp-${marker}` },
    ...extras,
  }
}

async function writeCredential(directory: string, marker: string) {
  await mkdir(directory, { recursive: true })
  const path = join(directory, '.credentials.json')
  await writeFile(path, `${JSON.stringify(credentialPayload(marker))}\n`, {
    mode: 0o600,
  })
  return path
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('Claude Code 2.1.233 keychain naming', () => {
  test('uses the exact default service and an eight-hex custom-dir suffix', async () => {
    const home = await temporaryDirectory()
    expect(
      getNativeClaudeKeychainService({
        environment: {},
        homeDirectory: home,
      }),
    ).toBe('Claude Code')

    const custom = join(home, 'Claudé-custom').normalize('NFC')
    const suffix = createHash('sha256').update(custom).digest('hex').slice(0, 8)
    expect(
      getNativeClaudeKeychainService({
        environment: { CLAUDE_CONFIG_DIR: custom },
        homeDirectory: home,
      }),
    ).toBe(`Claude Code-${suffix}`)
    expect(
      getNativeClaudeKeychainService({
        environment: {
          CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
          CLAUDE_CONFIG_DIR: custom,
        },
        homeDirectory: home,
      }),
    ).toBe('Claude Code')
  })

  test('uses a safe username or the claude-code-user fallback', () => {
    expect(
      getNativeClaudeKeychainAccount({
        environment: { USER: 'alice.smith' },
        userInfo: () => ({ username: 'ignored' }),
      }),
    ).toBe('alice.smith')
    expect(
      getNativeClaudeKeychainAccount({
        environment: { USER: 'unsafe account name' },
        userInfo: () => ({ username: 'ignored' }),
      }),
    ).toBe('claude-code-user')
    expect(
      getNativeClaudeKeychainAccount({
        environment: {},
        userInfo: () => {
          throw new Error('unavailable')
        },
      }),
    ).toBe('claude-code-user')
  })

  test('calls macOS security with fixed argv, no shell, and hard caps', async () => {
    const home = await temporaryDirectory()
    let invocation:
      | {
          file: string
          args: readonly string[]
          options: ExecFileInvocationOptions
        }
      | undefined
    const execFile: ExecFileLike = (file, args, options, callback) => {
      invocation = { file, args: [...args], options }
      queueMicrotask(() =>
        callback(
          null,
          `${JSON.stringify(credentialPayload('keychain'))}\n`,
          '',
        ),
      )
      return { kill() {} }
    }

    const loaded = await discoverNativeClaudeCredentials({
      platform: 'darwin',
      environment: {},
      homeDirectory: home,
      username: 'alice',
      execFile,
    })

    expect(loaded?.source).toEqual({
      type: 'keychain',
      service: 'Claude Code',
      account: 'alice',
    })
    expect(loaded?.credentials.claudeAiOauth.accessToken).toBe(
      'access-keychain',
    )
    expect(invocation).toEqual({
      file: 'security',
      args: ['find-generic-password', '-a', 'alice', '-w', '-s', 'Claude Code'],
      options: {
        encoding: 'utf8',
        timeout: NATIVE_CLAUDE_KEYCHAIN_TIMEOUT_MS,
        maxBuffer: NATIVE_CLAUDE_CREDENTIAL_MAX_BYTES,
        windowsHide: true,
        shell: false,
      },
    })
  })
})

describe('native Claude credential parsing and redaction', () => {
  test('whitelists OAuth/trusted-device data and preserves refresh expiry', () => {
    const source = credentialPayload('parsed')
    const snapshot = structuredClone(source)
    const credentials = parseNativeClaudeCredentials(source)

    expect(source).toEqual(snapshot)
    expect(credentials?.claudeAiOauth).toEqual({
      accessToken: 'access-parsed',
      refreshToken: 'refresh-parsed',
      expiresAt: 2_000_000_000_000,
      refreshTokenExpiresAt: 2_100_000_000_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_5x',
      clientId: 'client-parsed',
    })
    expect(credentials?.trustedDeviceToken).toBe('device-parsed')
    expect(credentials).not.toHaveProperty('primaryApiKey')
    expect(credentials).not.toHaveProperty('mcpOauth')
    expect(credentials?.claudeAiOauth).not.toHaveProperty('ignoredOauthSecret')
  })

  test('redacts inspect, stringification, and JSON output', () => {
    const credentials = parseNativeClaudeCredentials(
      credentialPayload('redaction'),
    )
    expect(credentials).not.toBeNull()

    for (const rendered of [
      String(credentials),
      inspect(credentials),
      JSON.stringify(credentials),
      String(credentials?.claudeAiOauth),
      inspect(credentials?.claudeAiOauth),
      JSON.stringify(credentials?.claudeAiOauth),
    ]) {
      expect(rendered).not.toContain('access-redaction')
      expect(rendered).not.toContain('refresh-redaction')
      expect(rendered).not.toContain('device-redaction')
      expect(rendered).not.toContain('client-redaction')
      expect(rendered).not.toContain('api-redaction')
    }
    expect(JSON.stringify(credentials)).toContain('[REDACTED]')
  })

  test('returns null for malformed recognized data without reflecting it', () => {
    const secret = 'malformed-secret-value'
    const malformed = `{"claudeAiOauth":{"accessToken":"${secret}"}}`
    expect(parseNativeClaudeCredentials(malformed)).toBeNull()
  })
})

describe('native Claude credential fallback precedence', () => {
  test('prefers a valid injected keychain and falls back when it is unavailable', async () => {
    const home = await temporaryDirectory()
    await writeCredential(join(home, '.claude'), 'plaintext')

    const keychain = await discoverNativeClaudeCredentials({
      platform: 'linux',
      environment: {},
      homeDirectory: home,
      username: 'alice',
      keychainStore: {
        read: async () => JSON.stringify(credentialPayload('keychain')),
      },
    })
    expect(keychain?.source.type).toBe('keychain')
    expect(keychain?.credentials.claudeAiOauth.accessToken).toBe(
      'access-keychain',
    )

    const fallback = await discoverNativeClaudeCredentials({
      platform: 'linux',
      environment: {},
      homeDirectory: home,
      username: 'alice',
      keychainStore: {
        read: async () => null,
      },
    })
    expect(fallback?.source.type).toBe('plaintext')
    expect(fallback?.credentials.claudeAiOauth.accessToken).toBe(
      'access-plaintext',
    )
  })

  test('does not silently fall back from a malformed keychain entry', async () => {
    const home = await temporaryDirectory()
    await writeCredential(join(home, '.claude'), 'plaintext')
    await expect(
      discoverNativeClaudeCredentials({
        platform: 'linux',
        environment: {},
        homeDirectory: home,
        keychainStore: {
          read: async () => '{"claudeAiOauth":{"accessToken":"incomplete"}}',
        },
      }),
    ).rejects.toMatchObject({ code: 'keychain_invalid' })
  })

  test('resolves secure-storage dir, then config dir, then ~/.claude', async () => {
    const root = await temporaryDirectory()
    const home = join(root, 'home')
    const secureDirectory = join(root, 'secure')
    const configDirectory = join(root, 'config')
    await Promise.all([
      writeCredential(secureDirectory, 'secure'),
      writeCredential(configDirectory, 'config'),
      writeCredential(join(home, '.claude'), 'home'),
    ])

    const secure = await discoverNativeClaudeCredentials({
      platform: 'linux',
      environment: {
        CLAUDE_SECURESTORAGE_CONFIG_DIR: secureDirectory,
        CLAUDE_CONFIG_DIR: configDirectory,
      },
      homeDirectory: home,
    })
    expect(secure?.credentials.claudeAiOauth.accessToken).toBe('access-secure')
    expect(secure?.source).toEqual({
      type: 'plaintext',
      path: join(secureDirectory, '.credentials.json'),
    })

    const config = await loadNativeClaudeCredentials({
      platform: 'linux',
      environment: { CLAUDE_CONFIG_DIR: configDirectory },
      homeDirectory: home,
    })
    expect(config?.claudeAiOauth.accessToken).toBe('access-config')

    const defaultCredentials = await loadNativeClaudeCredentials({
      platform: 'linux',
      environment: {},
      homeDirectory: home,
    })
    expect(defaultCredentials?.claudeAiOauth.accessToken).toBe('access-home')
    expect(
      getNativeClaudeCredentialsPath({
        environment: {},
        homeDirectory: home,
      }),
    ).toBe(join(home, '.claude', '.credentials.json'))
  })

  test('explicitly imports OAuth only into the shared schema', async () => {
    const root = await temporaryDirectory()
    const home = join(root, 'home')
    await writeCredential(join(home, '.claude'), 'imported')
    const sharedPath = join(root, 'shared', 'accounts.json')
    const imported = await importNativeClaudeAccount({
      platform: 'linux',
      environment: {},
      homeDirectory: home,
      id: 'native',
      label: 'Imported Claude',
      sharedStore: { path: sharedPath, legacyPaths: [] },
      now: () => 1_700_000_000_000,
    })
    expect(imported?.trustedDeviceToken).toBe('device-imported')
    const loaded = await loadSharedAccountStore({
      path: sharedPath,
      legacyPaths: [],
    })
    expect(loaded.store.current).toBe('native')
    expect(loaded.store.accounts[0]?.credential).toMatchObject({
      type: 'oauth',
      access: 'access-imported',
      refresh: 'refresh-imported',
      refresh_expires_at: 2_100_000_000_000,
    })
    const persisted = await readFile(sharedPath, 'utf8')
    expect(persisted).not.toContain('device-imported')
    expect(persisted).not.toContain('api-imported')
    expect(persisted).not.toContain('mcp-imported')
  })

  test('never modifies the selected plaintext source', async () => {
    const root = await temporaryDirectory()
    const directory = join(root, 'config')
    const path = await writeCredential(directory, 'unchanged')
    const timestamp = new Date('2026-01-02T03:04:05.000Z')
    await utimes(path, timestamp, timestamp)
    const beforeMetadata = await lstat(path)
    const beforeContents = await readFile(path, 'utf8')

    await loadNativeClaudeCredentials({
      platform: 'linux',
      environment: { CLAUDE_CONFIG_DIR: directory },
      homeDirectory: join(root, 'unused-home'),
    })

    const afterMetadata = await lstat(path)
    expect(await readFile(path, 'utf8')).toBe(beforeContents)
    expect(afterMetadata.mode).toBe(beforeMetadata.mode)
    expect(afterMetadata.mtimeMs).toBe(beforeMetadata.mtimeMs)
  })

  test('refuses a plaintext symlink with a redacted error', async () => {
    if (process.platform === 'win32') return
    const root = await temporaryDirectory()
    const directory = join(root, 'config')
    await mkdir(directory)
    const secret = 'symlink-target-secret'
    const target = join(root, 'target.json')
    const path = join(directory, '.credentials.json')
    await writeFile(
      target,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: secret,
          refreshToken: secret,
          expiresAt: 1,
        },
      }),
    )
    await symlink(target, path)

    try {
      await loadNativeClaudeCredentials({
        platform: 'linux',
        environment: { CLAUDE_CONFIG_DIR: directory },
        homeDirectory: join(root, 'unused-home'),
      })
      throw new Error('expected symlink refusal')
    } catch (error) {
      expect(error).toMatchObject({ code: 'plaintext_symlink_refused' })
      expect(String(error)).not.toContain(secret)
      expect(inspect(error)).not.toContain(secret)
      expect(JSON.stringify(error)).not.toContain(secret)
    }
    expect(await readFile(target, 'utf8')).toContain(secret)
  })
})
