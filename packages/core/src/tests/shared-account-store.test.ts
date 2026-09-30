/**
 * The shared store as served by the Rust binding. Every test runs on a temp
 * store file and a local mock token endpoint (see support/store-fixture.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { refreshErrorFromSharedAccount } from '../accounts.ts'
import {
  ANTHROPIC_OAUTH_TOKEN_URL_ENV,
  AnthropicAuth,
  addSharedApiKey,
  anthropicAuthConfig,
  backfillSharedIdentities,
  getSharedAccessToken,
  getSharedAccountStorePath,
  getSharedApiKey,
  handleSharedUnauthorized,
  importHostOAuthCredential,
  isAnthropicAuthError,
  listSharedAccounts,
  pickSharedAccount,
  readNativeClaudeStatus,
  recordSharedAccountQuota,
  removeSharedAccount,
  reorderSharedAccounts,
  revokeSharedAccount,
  SHARED_ACCOUNT_STORE_DIR_ENV,
  SHARED_ACCOUNT_STORE_FILE_ENV,
  setSharedAccountEnabled,
  setSharedCurrentAccount,
  sharedKeepAliveOnce,
  startSharedLogin,
} from '../shared-account-store.ts'
import {
  fakeAccessToken,
  fakeRefreshToken,
  type MockTokenServer,
  seedStoreAccount,
  startMockTokenServer,
  type TempStore,
  useTempStore,
} from './support/store-fixture.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR

let store: TempStore
let mock: MockTokenServer

beforeEach(() => {
  store = useTempStore()
  mock = startMockTokenServer()
})

afterEach(() => {
  mock.stop()
  store.dispose()
})

describe('store path', () => {
  test('resolves explicit, file-env, then directory-env paths', () => {
    const file = process.env[SHARED_ACCOUNT_STORE_FILE_ENV]
    expect(getSharedAccountStorePath('/explicit/accounts.json')).toBe(
      '/explicit/accounts.json',
    )
    expect(getSharedAccountStorePath()).toBe(file as string)
    delete process.env[SHARED_ACCOUNT_STORE_FILE_ENV]
    process.env[SHARED_ACCOUNT_STORE_DIR_ENV] = '/tmp/store-dir'
    try {
      expect(getSharedAccountStorePath()).toBe(
        join('/tmp/store-dir', 'accounts.json'),
      )
    } finally {
      delete process.env[SHARED_ACCOUNT_STORE_DIR_ENV]
      process.env[SHARED_ACCOUNT_STORE_FILE_ENV] = file
    }
  })

  test('isolates OpenCode tests beside their temporary sidecar', () => {
    const file = process.env[SHARED_ACCOUNT_STORE_FILE_ENV]
    const testDir = process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR
    const sidecar = process.env.OPENCODE_ANTHROPIC_AUTH_FILE
    delete process.env[SHARED_ACCOUNT_STORE_FILE_ENV]
    process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR = '/tmp/oc-test'
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE =
      '/tmp/oc-test/anthropic-auth.json'
    try {
      expect(getSharedAccountStorePath()).toBe(
        '/tmp/oc-test/shared-anthropic-accounts.json',
      )
    } finally {
      process.env[SHARED_ACCOUNT_STORE_FILE_ENV] = file
      if (testDir === undefined)
        delete process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR
      else process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR = testDir
      if (sidecar === undefined) delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
      else process.env.OPENCODE_ANTHROPIC_AUTH_FILE = sidecar
    }
  })

  test('the binding is always handed the resolved store path and overrides', () => {
    const config = anthropicAuthConfig()
    expect(config.storePath).toBe(store.path)
    expect(config.tokenUrl).toBe(process.env[ANTHROPIC_OAUTH_TOKEN_URL_ENV])
  })
})

describe('listing and import', () => {
  test('imports a host credential once and never returns a token', async () => {
    const first = await importHostOAuthCredential({
      label: 'work',
      accessToken: fakeAccessToken('work'),
      refreshToken: fakeRefreshToken('work'),
      expiresAt: Date.now() + HOUR,
    })
    expect(first.status).toBe('added')
    const again = await importHostOAuthCredential({
      label: 'work',
      accessToken: fakeAccessToken('work'),
      refreshToken: fakeRefreshToken('work'),
      expiresAt: Date.now() + HOUR,
    })
    expect(again.status).toBe('already_present')

    const accounts = await listSharedAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({
      label: 'work',
      kind: 'oauth',
      enabled: true,
      current: true,
      accessLive: true,
      refreshDead: false,
    })
    expect(JSON.stringify(accounts)).not.toContain('sk-ant-')
    // The store file itself is owner-only.
    expect(statSync(store.path).mode & 0o777).toBe(0o600)
  })

  test('the store copy wins over a host copy of the same login', async () => {
    const seeded = await importHostOAuthCredential({
      label: 'work',
      accessToken: fakeAccessToken('storecopy'),
      refreshToken: fakeRefreshToken('storecopy'),
      expiresAt: Date.now() + HOUR,
      accountUuid: 'uuid-work',
      email: 'work@example.com',
    })
    const host = await importHostOAuthCredential({
      label: 'work-from-host',
      accessToken: fakeAccessToken('hostcopy'),
      refreshToken: fakeRefreshToken('hostcopy'),
      expiresAt: Date.now() + 2 * HOUR,
      accountUuid: 'uuid-work',
      email: 'work@example.com',
    })
    expect(host.status).toBe('kept')
    if (host.status === 'invalid' || seeded.status === 'invalid') {
      throw new Error('unexpected invalid import')
    }
    expect(host.accountId).toBe(seeded.accountId)
    const persisted = readFileSync(store.path, 'utf8')
    expect(persisted).toContain(fakeRefreshToken('storecopy'))
    expect(persisted).not.toContain(fakeRefreshToken('hostcopy'))
  })

  test('reports a malformed host credential as invalid instead of storing it', async () => {
    const result = await importHostOAuthCredential({
      label: 'yiyi',
      accessToken: 'yiyi-access',
      refreshToken: 'yiyi-refresh',
      expiresAt: Date.now() + HOUR,
    })
    expect(result.status).toBe('invalid')
    expect(await listSharedAccounts()).toHaveLength(0)
  })

  test('pickSharedAccount prefers an available current row, else the first available', async () => {
    const a = await seedStoreAccount({ label: 'a' })
    const b = await seedStoreAccount({ label: 'b' })
    await setSharedCurrentAccount(b.id)
    expect(pickSharedAccount(await listSharedAccounts())?.id).toBe(b.id)
    await setSharedAccountEnabled(b.id, false)
    expect(pickSharedAccount(await listSharedAccounts())?.id).toBe(a.id)
    await setSharedAccountEnabled(a.id, false)
    expect(pickSharedAccount(await listSharedAccounts())).toBeUndefined()
  })

  test('reorder and remove go through the store', async () => {
    const a = await seedStoreAccount({ label: 'a' })
    const b = await seedStoreAccount({ label: 'b' })
    await reorderSharedAccounts([b.id, a.id])
    expect((await listSharedAccounts()).map((row) => row.id)).toEqual([
      b.id,
      a.id,
    ])
    expect(await removeSharedAccount(a.id)).toBe(true)
    expect((await listSharedAccounts()).map((row) => row.id)).toEqual([b.id])
  })

  test('an exhausted quota reading makes the row unavailable', async () => {
    const a = await seedStoreAccount({ label: 'a' })
    await recordSharedAccountQuota(a.id, {
      fiveHourPercent: 10,
      sevenDayPercent: 100,
    })
    const [row] = await listSharedAccounts()
    expect(row?.quota?.sevenDayPercent).toBe(100)
    expect(row?.available).toBe(false)
  })

  test('an exhausted five-hour window also makes the row unavailable', async () => {
    const a = await seedStoreAccount({ label: 'a' })
    await recordSharedAccountQuota(a.id, { fiveHourPercent: 100 })
    const [row] = await listSharedAccounts()
    expect(row?.available).toBe(false)
  })

  test('an exhausted account neither strands its neighbours nor keeps the pin', async () => {
    const a = await seedStoreAccount({ label: 'a' })
    const b = await seedStoreAccount({ label: 'b' })
    await setSharedCurrentAccount(a.id)
    await recordSharedAccountQuota(a.id, { sevenDayPercent: 100 })
    const rows = await listSharedAccounts()
    expect(rows.find((row) => row.id === b.id)?.available).toBe(true)
    expect(pickSharedAccount(rows)?.id).toBe(b.id)
    await recordSharedAccountQuota(b.id, { sevenDayPercent: 100 })
    // Every account exhausted: nothing is picked rather than a doomed one.
    expect(pickSharedAccount(await listSharedAccounts())).toBeUndefined()
  })

  test('a stale exhausted reading does not strand the account', async () => {
    const a = await seedStoreAccount({ label: 'a' })
    await recordSharedAccountQuota(a.id, {
      sevenDayPercent: 100,
      checkedAt: Date.now() - 2 * HOUR,
    })
    const [row] = await listSharedAccounts()
    expect(row?.available).toBe(true)
  })
})

describe('access tokens', () => {
  test('a live stored token is returned without touching the token endpoint', async () => {
    const a = await seedStoreAccount({ label: 'a' })
    const token = await getSharedAccessToken(a.id)
    expect(token).toMatchObject({
      accountId: a.id,
      accessToken: a.access,
      source: 'store',
    })
    expect(mock.presented).toEqual([])
    expect(JSON.stringify(token)).not.toContain('sk-ant-ort')
  })

  test('an expired token is refreshed once, in Rust, and the rotation is stored', async () => {
    const a = await seedStoreAccount({
      label: 'a',
      expiresAt: Date.now() - HOUR,
    })
    const token = await getSharedAccessToken(a.id)
    expect(token.source).toBe('refreshed')
    expect(token.accessToken).toBe(mock.rotatedAccess(1))
    expect(mock.presented).toEqual([a.refresh])
    const persisted = readFileSync(store.path, 'utf8')
    expect(persisted).toContain(mock.rotatedRefresh(1))
    expect(persisted).not.toContain(a.refresh)

    const again = await getSharedAccessToken(a.id)
    expect(again.source).toBe('store')
    expect(mock.presented).toHaveLength(1)
  })

  test('a dead refresh token is reported once and never re-presented', async () => {
    const a = await seedStoreAccount({
      label: 'a',
      expiresAt: Date.now() - HOUR,
    })
    mock.dead.add(a.refresh)
    const first = await getSharedAccessToken(a.id).catch((error) => error)
    expect(isAnthropicAuthError(first, 'invalid_grant')).toBe(true)
    const second = await getSharedAccessToken(a.id).catch((error) => error)
    expect(isAnthropicAuthError(second, 'invalid_grant')).toBe(true)
    expect(mock.presented).toEqual([a.refresh])

    const [row] = await listSharedAccounts()
    expect(row?.refreshDead).toBe(true)
    expect(refreshErrorFromSharedAccount(row!)).toMatchObject({
      permanent: true,
      status: 400,
    })
  })

  test('refreshes of different accounts do not block each other', async () => {
    const a = await seedStoreAccount({
      label: 'a',
      expiresAt: Date.now() - HOUR,
    })
    const b = await seedStoreAccount({
      label: 'b',
      expiresAt: Date.now() - HOUR,
    })
    const [ta, tb] = await Promise.all([
      getSharedAccessToken(a.id),
      getSharedAccessToken(b.id),
    ])
    expect(ta.source).toBe('refreshed')
    expect(tb.source).toBe('refreshed')
    expect(new Set(mock.presented)).toEqual(new Set([a.refresh, b.refresh]))
    expect(mock.presented).toHaveLength(2)
  })

  test('a 401 on a stored bearer triggers one claimed refresh and a retry', async () => {
    const a = await seedStoreAccount({ label: 'a' })
    const result = await handleSharedUnauthorized(a.access)
    expect(result.retry).toBe(true)
    expect(result.token?.accountId).toBe(a.id)
    expect(result.token?.accessToken).toBe(mock.rotatedAccess(1))
    expect(mock.presented).toEqual([a.refresh])
  })
})

describe('keep-alive', () => {
  test('refreshes only an idle row whose refresh token is about to lapse', async () => {
    const lapsing = await seedStoreAccount({
      label: 'lapsing',
      expiresAt: Date.now() - HOUR,
      refreshExpiresAt: Date.now() + DAY,
    })
    const healthy = await seedStoreAccount({
      label: 'healthy',
      expiresAt: Date.now() - HOUR,
      refreshExpiresAt: Date.now() + 25 * DAY,
    })
    const inSession = await seedStoreAccount({
      label: 'in-session',
      expiresAt: Date.now() + HOUR,
      refreshExpiresAt: Date.now() + DAY,
    })
    const report = await sharedKeepAliveOnce({ spacingMs: 0 })
    expect(report.lease).toBe('acquired')
    expect(report.refreshed.map((entry) => entry.accountId)).toEqual([
      lapsing.id,
    ])
    expect(mock.presented).toEqual([lapsing.refresh])
    const skipped = new Map(
      report.skipped.map((entry) => [entry.accountId, entry.reason]),
    )
    expect(skipped.has(healthy.id)).toBe(true)
    expect(skipped.get(inSession.id)).toBe('session_live')
  })
})

describe('login', () => {
  test('exchanges the code in Rust and stores the account', async () => {
    mock.codes.set('the-code', {
      email: 'new@example.com',
      accountUuid: 'uuid-new',
      tag: 'new',
    })
    const login = startSharedLogin({ mode: 'max' })
    expect(new URL(login.url).searchParams.get('state')).toBe(login.state)
    const account = await login.complete({
      callback: `the-code#${login.state}`,
      label: 'New',
      setCurrent: true,
    })
    expect(account).toMatchObject({
      label: 'New',
      email: 'new@example.com',
      accountUuid: 'uuid-new',
      current: true,
      accessLive: true,
    })
    expect(JSON.stringify(account)).not.toContain('sk-ant-')
    expect(mock.codeExchanges).toHaveLength(1)
    expect(mock.codeExchanges[0]?.code_verifier).toBeTruthy()
    const token = await getSharedAccessToken(account.id)
    expect(token.accessToken).toBe(mock.loginAccess('new'))
  })

  test('a callback with a foreign state is refused before any exchange', async () => {
    mock.codes.set('the-code', {
      email: 'x@example.com',
      accountUuid: 'uuid-x',
      tag: 'x',
    })
    const login = startSharedLogin({ mode: 'max' })
    await expect(
      login.complete({ callback: 'the-code#not-the-state' }),
    ).rejects.toThrow()
    expect(mock.codeExchanges).toHaveLength(0)
    expect(await listSharedAccounts()).toHaveLength(0)
  })

  test('a loopback login advertises its own redirect URI in the authorize URL', () => {
    const login = startSharedLogin({
      mode: 'max',
      redirectUri: 'http://localhost:54545/callback',
    })
    expect(new URL(login.url).searchParams.get('redirect_uri')).toBe(
      'http://localhost:54545/callback',
    )
  })
})

describe('login: console exchange stores nothing', () => {
  test('exchange returns an access token and no account is written', async () => {
    mock.codes.set('console-code', {
      email: 'console@example.com',
      accountUuid: 'uuid-console',
      tag: 'console',
    })
    const login = startSharedLogin({ mode: 'console' })
    const exchanged = await login.exchange(`console-code#${login.state}`)
    expect(exchanged.accessToken).toBe(mock.loginAccess('console'))
    expect(exchanged.email).toBe('console@example.com')
    expect(JSON.stringify(exchanged)).not.toContain('sk-ant-ort')
    expect(await listSharedAccounts()).toHaveLength(0)
    expect(mock.codeExchanges).toHaveLength(1)
    // A tampered state never reaches the token endpoint.
    const second = startSharedLogin({ mode: 'console' })
    await expect(second.exchange('console-code#forged')).rejects.toThrow()
    expect(mock.codeExchanges).toHaveLength(1)
  })
})

describe('revoke and API keys through the binding', () => {
  test('revoke sends the stored refresh token and disables or removes the row', async () => {
    const a = await seedStoreAccount({ label: 'to-disable' })
    const b = await seedStoreAccount({ label: 'to-remove' })
    expect(await revokeSharedAccount(a.id, { disable: true })).toEqual({
      accountId: a.id,
      outcome: 'revoked',
      removed: false,
    })
    expect(await revokeSharedAccount(b.id)).toMatchObject({ removed: true })
    expect(mock.revoked).toEqual([a.refresh, b.refresh])
    const rows = await listSharedAccounts()
    expect(rows.map((row) => row.id)).toEqual([a.id])
    expect(rows[0]).toMatchObject({ enabled: false, refreshDead: true })
    // A disabled, dead row is never refreshed or served.
    await expect(getSharedAccessToken(a.id)).rejects.toThrow()
    expect(mock.presented).toEqual([])
  })

  test('store API keys: added, handed out by id or pin, listed as a suffix only', async () => {
    const key = 'sk-ant-api03-corecorecorecorecorecoreKEY9'
    expect(await addSharedApiKey({ key, label: 'Console key' })).toEqual({
      accountId: 'Console key',
      status: 'added',
    })
    const listed = await listSharedAccounts()
    expect(listed).toEqual([
      expect.objectContaining({
        id: 'Console key',
        kind: 'api_key',
        apiKeySuffix: 'KEY9',
      }),
    ])
    expect(JSON.stringify(listed)).not.toContain(key)
    expect((await getSharedApiKey()).apiKey).toBe(key)
    expect((await getSharedApiKey('Console key')).accountId).toBe('Console key')
    let malformed: unknown
    try {
      await addSharedApiKey({ key: 'not-a-key' })
    } catch (error) {
      malformed = error
    }
    expect(isAnthropicAuthError(malformed, 'invalid_token')).toBe(true)
  })
})

describe('legacy stores and Claude Code publish through the binding', () => {
  const HOUR_MS = 3_600_000

  test('legacyPaths adopts a flat ~/.grok-style store once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-adopt-'))
    try {
      const legacy = join(dir, 'grok', 'anthropic-accounts.json')
      mkdirSync(join(dir, 'grok'))
      writeFileSync(
        legacy,
        JSON.stringify({
          version: 1,
          active_index: 0,
          accounts: [
            {
              uuid: 'grok-login',
              email: 'grok@example.com',
              accessToken: fakeAccessToken('grokadopt'),
              refreshToken: fakeRefreshToken('grokadopt'),
              expiresAt: Date.now() + HOUR_MS,
              addedAt: Date.now() - HOUR_MS,
              scopes: ['user:inference'],
              enabled: true,
            },
          ],
        }),
      )
      const auth = new AnthropicAuth({
        ...anthropicAuthConfig(),
        legacyPaths: [legacy],
      })
      expect((await auth.listAccounts()).map((row) => row.id)).toEqual([
        'grok-login',
      ])
      expect(
        JSON.parse(readFileSync(store.path, 'utf8')).migrated_from,
      ).toEqual([legacy])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a store refresh of the token Claude Code holds is published to its file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-publish-'))
    try {
      const native = join(dir, '.credentials.json')
      const seeded = await seedStoreAccount({
        label: 'claude-code',
        expiresAt: Date.now() - HOUR_MS,
      })
      writeFileSync(
        native,
        JSON.stringify({
          claudeAiOauth: {
            accessToken: seeded.access,
            refreshToken: seeded.refresh,
            expiresAt: Date.now() - HOUR_MS,
            scopes: ['user:inference'],
            subscriptionType: 'max',
          },
        }),
        { mode: 0o600 },
      )
      expect((await readNativeClaudeStatus(native))?.storeAccountId).toBe(
        seeded.id,
      )
      // OAuth test mode never resolves Claude Code's real file, so the test
      // names the (temp) file explicitly.
      const auth = new AnthropicAuth({
        ...anthropicAuthConfig(),
        nativeCredentialsPath: native,
      })
      const token = await auth.getAccessToken({ account: seeded.id })
      expect(token.source).toBe('refreshed')
      const written = JSON.parse(readFileSync(native, 'utf8'))
      expect(written.claudeAiOauth).toMatchObject({
        accessToken: mock.rotatedAccess(1),
        refreshToken: mock.rotatedRefresh(1),
        subscriptionType: 'max',
      })
      expect(statSync(native).mode & 0o777).toBe(0o600)
      expect((await readNativeClaudeStatus(native))?.storeAccountId).toBe(
        seeded.id,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('identity backfill and error codes', () => {
  test('backfill names an imported row from the profile endpoint without refreshing', async () => {
    const bearers: string[] = []
    const profile = Bun.serve({
      port: 0,
      fetch(req) {
        bearers.push(req.headers.get('authorization') ?? '')
        return Response.json({
          account: { uuid: 'uuid-profile', email: 'profile@example.com' },
          organization: { uuid: 'org-profile' },
        })
      },
    })
    const previous = process.env.ANTHROPIC_OAUTH_PROFILE_URL
    // Imported while the profile endpoint was unreachable (the runner's dead
    // loopback): the row has no identity yet.
    const seeded = await seedStoreAccount({ label: 'anonymous' })
    expect((await listSharedAccounts())[0]?.accountUuid).toBeUndefined()
    process.env.ANTHROPIC_OAUTH_PROFILE_URL = `http://127.0.0.1:${profile.port}/api/oauth/profile`
    try {
      expect(await backfillSharedIdentities()).toEqual([
        {
          accountId: seeded.id,
          status: 'filled',
          email: 'profile@example.com',
        },
      ])
      expect(bearers).toEqual([`Bearer ${seeded.access}`])
      expect((await listSharedAccounts())[0]).toMatchObject({
        email: 'profile@example.com',
        accountUuid: 'uuid-profile',
        organizationUuid: 'org-profile',
      })
      expect(mock.presented).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_OAUTH_PROFILE_URL
      else process.env.ANTHROPIC_OAUTH_PROFILE_URL = previous
      profile.stop(true)
    }
  })

  test('an unreadable store is store_corrupt and is left as it is', async () => {
    writeFileSync(store.path, '{ "accounts": [', { mode: 0o600 })
    let caught: unknown
    try {
      await listSharedAccounts()
    } catch (error) {
      caught = error
    }
    expect(isAnthropicAuthError(caught, 'store_corrupt')).toBe(true)
    expect(readFileSync(store.path, 'utf8')).toBe('{ "accounts": [')
    const imported = await importHostOAuthCredential({
      accessToken: 'not-a-token',
      refreshToken: 'not-a-token',
      expiresAt: 0,
    })
    expect(imported.status).toBe('invalid')
  })
})
