import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addAccountPersistent,
  getAccountStatePath,
  listSharedAccounts,
  startSharedLoginWithLoopback,
} from '@cortexkit/anthropic-auth-core'
import {
  type MockTokenServer,
  seedStoreAccount,
  startMockTokenServer,
  type TempStore,
  useTempStore,
} from '../../../core/src/tests/support/store-fixture.ts'

import {
  addApiRoute,
  type LoginDeps,
  login,
  relaySetup,
  revokeAccount,
} from '../cli'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'anthropic-cli-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

// addApiRoute / login are exercised IN-PROCESS with injected deps rather than
// via `bun [--preload] src/cli.ts ...`. The subprocess form (Bun.spawn +
// optional --preload fetch stub + stdin pipe) hung indefinitely in CI
// (proc.exited never resolving, 5000ms timeout) while passing locally — the
// failure lived in that harness, not in the command logic, and was
// unreproducible locally. Calling the commands directly with injected prompt
// (and, for login, authorize/exchange) removes the entire fragile surface
// (no spawn, no preload, no readline/stdin race, no real network) while still
// exercising the real logic and asserting the same persisted outcomes.

// Run a command body against a temp account file, restoring any env we touch.
async function withAccountEnv<T>(
  accountPath: string,
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const keys = ['OPENCODE_ANTHROPIC_AUTH_FILE', ...Object.keys(env)]
  const prev = new Map(keys.map((k) => [k, process.env[k]]))
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe('CLI api add', () => {
  test('saves API route config and stores API key in runtime state', async () => {
    const accountPath = join(tempDir, 'anthropic-auth.json')

    await withAccountEnv(
      accountPath,
      {
        OPENCODE_ANTHROPIC_AUTH_API_BASE_URL: 'https://api.kie.ai/claude',
        OPENCODE_ANTHROPIC_AUTH_API_KEY: 'kie-key',
        OPENCODE_ANTHROPIC_AUTH_API_AUTH_HEADER: 'authorization-bearer',
      },
      () =>
        addApiRoute('kie-opus', {
          prompt: async () => {
            throw new Error('prompt should not be called: all inputs from env')
          },
        }),
    )

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.accounts[0]).toMatchObject({
      id: 'kie-opus',
      label: 'kie-opus',
      type: 'api',
      enabled: true,
      baseURL: 'https://api.kie.ai/claude',
      authHeader: 'authorization-bearer',
    })
    expect(storage.accounts[0].apiKey).toBeUndefined()

    const runtimeState = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    )
    expect(runtimeState.accounts['kie-opus'].apiKey).toBe('kie-key')

    // API routes stay host-owned: nothing reaches the shared store.
    expect(await listSharedAccounts()).toEqual([])
  })

  test('rejects invalid API base URL before saving route state', async () => {
    const accountPath = join(tempDir, 'anthropic-auth.json')

    const promise = withAccountEnv(
      accountPath,
      {
        OPENCODE_ANTHROPIC_AUTH_API_BASE_URL: 'https://secret@example.com/v1',
        OPENCODE_ANTHROPIC_AUTH_API_KEY: 'kie-key',
        OPENCODE_ANTHROPIC_AUTH_API_AUTH_HEADER: 'authorization-bearer',
      },
      () =>
        addApiRoute('bad-api', {
          prompt: async () => '',
        }),
    )

    await expect(promise).rejects.toThrow(
      'API fallback base URL must be an http(s) URL',
    )

    // Nothing should have been persisted for the rejected route.
    await expect(readFile(accountPath, 'utf8')).rejects.toThrow()
  })
})

describe('CLI login', () => {
  // The code exchange runs in Rust against a mock token endpoint; the manual
  // (paste) path is used so no loopback listener is involved.
  let tokenServer: MockTokenServer
  let store: TempStore
  beforeEach(() => {
    store = useTempStore()
    tokenServer = startMockTokenServer()
  })
  afterEach(() => {
    tokenServer.stop()
    store.dispose()
  })
  const manualLogin: LoginDeps['startLogin'] = (options) =>
    startSharedLoginWithLoopback({ ...options, loopback: false })

  function loginCode(code: string, email: string, org = 'a') {
    tokenServer.codes.set(code, {
      email,
      accountUuid: `acct-${email}`,
      tag: `${code}${org}`.replace(/[^A-Za-z0-9]/g, ''),
    })
    return code
  }

  async function quietly<T>(fn: () => Promise<T>) {
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    }
    try {
      return { result: await fn(), stdout: logs.join('\n') }
    } finally {
      console.log = origLog
    }
  }

  test('names the account after the signed-in email with no label given', async () => {
    const accountPath = join(tempDir, 'anthropic-auth.json')
    const code = loginCode('cli-code', 'from-grant@example.com')
    const { stdout } = await quietly(() =>
      withAccountEnv(accountPath, {}, () =>
        login(undefined, { prompt: async () => code, startLogin: manualLogin }),
      ),
    )
    expect(stdout).toContain('Saved fallback account "from-grant@example.com"')
    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.accounts[0]).toMatchObject({
      id: 'from-grant@example.com',
      enabled: true,
    })
    expect(tokenServer.codeExchanges.map((entry) => entry.code)).toEqual([code])
  })

  test('a second organization for the same person gets its own account', async () => {
    // One person can hold a grant in several organizations, and those are
    // separate routable credentials; the store keeps both.
    const accountPath = join(tempDir, 'anthropic-auth.json')
    const first = loginCode('code-org-a', 'person@example.com', 'a')
    const second = loginCode('code-org-b', 'person@example.com', 'b')
    await quietly(async () => {
      await withAccountEnv(accountPath, {}, () =>
        login(undefined, {
          prompt: async () => first,
          startLogin: manualLogin,
        }),
      )
      await withAccountEnv(accountPath, {}, () =>
        login(undefined, {
          prompt: async () => second,
          startLogin: manualLogin,
        }),
      )
    })
    const rows = await listSharedAccounts()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.id)).size).toBe(2)
    const orgs = new Set(rows.map((row) => row.organizationUuid))
    expect(orgs.size).toBe(2)
    expect(rows.every((row) => row.email === 'person@example.com')).toBe(true)
  })

  test('saves the login in the store and only a tokenless entry in the host files', async () => {
    const accountPath = join(tempDir, 'anthropic-auth.json')
    const asked: string[] = []
    const code = loginCode('cli-code-2', 'signed-in@example.com')
    const prompt = async (message: string) => {
      asked.push(message)
      return code
    }
    const { stdout } = await quietly(() =>
      withAccountEnv(accountPath, {}, () =>
        login(undefined, { prompt, startLogin: manualLogin }),
      ),
    )

    // The binding's authorize URL was printed and carries a state.
    expect(stdout).toMatch(/[?&]state=[A-Za-z0-9_-]{16,}/)
    // Only the callback-code prompt fired; no label was asked for.
    expect(asked).toEqual([
      'Paste the full callback URL or authorization code here: ',
    ])
    expect(stdout).toContain('Saved fallback account "signed-in@example.com"')

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.accounts).toHaveLength(1)
    expect(storage.accounts[0]).toMatchObject({
      id: 'signed-in@example.com',
      label: 'signed-in@example.com',
      enabled: true,
    })
    expect(storage.accounts[0].access).toBeUndefined()
    expect(storage.accounts[0].refresh).toBeUndefined()

    const runtimeState = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    )
    const entry = runtimeState.accounts['signed-in@example.com']
    expect(entry.access).toBeUndefined()
    expect(entry.refresh).toBeUndefined()
    expect(entry.authLineageId).toMatch(/^[0-9a-f-]{36}$/)
    // The raw state file carries no token at all.
    expect(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    ).not.toContain('sk-ant-')

    const rows = await listSharedAccounts()
    expect(rows.map((row) => row.id)).toEqual(['signed-in@example.com'])
    expect(rows[0]?.accessLive).toBe(true)
  })

  test('preserves an account committed while the interactive OAuth flow is open', async () => {
    const accountPath = join(tempDir, 'anthropic-auth.json')
    const now = Date.now()
    const code = loginCode('cli-code-3', 'yiyi@example.com')
    const prompt = async () => {
      await addAccountPersistent(
        {
          id: 'umut',
          label: 'umut',
          type: 'api',
          apiKey: 'umut-key',
          baseURL: 'https://api.example.com',
          enabled: true,
          addedAt: now,
        },
        accountPath,
      )
      return code
    }

    await quietly(() =>
      withAccountEnv(accountPath, {}, () =>
        login('yiyi', { prompt, startLogin: manualLogin }),
      ),
    )

    const config = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(
      config.accounts.map((account: { id: string }) => account.id),
    ).toEqual(['umut', 'yiyi'])
    const runtimeState = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    )
    expect(Object.keys(runtimeState.accounts)).toEqual(['umut', 'yiyi'])
    expect(runtimeState.accounts.yiyi.refresh).toBeUndefined()
  })

  test('re-login with the same label keeps the entry and drops legacy host tokens', async () => {
    const accountPath = join(tempDir, 'anthropic-auth.json')
    const statePath = getAccountStatePath(accountPath)
    const oldRefreshedAt = Date.now() - 60_000

    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [
          {
            id: 'cli-label',
            label: 'cli-label',
            type: 'oauth',
            enabled: true,
            addedAt: 123,
          },
        ],
      }),
      'utf8',
    )
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        accounts: {
          'cli-label': {
            access: 'old-access',
            refresh: 'old-refresh',
            expires: 1,
            lastRefreshedAt: oldRefreshedAt,
            lastRefreshError: {
              message: 'old invalid_grant',
              checkedAt: oldRefreshedAt,
              nextRetryAt: Date.now() + 3_600_000,
              permanent: true,
            },
          },
        },
      }),
      'utf8',
    )

    const code = loginCode('cli-code-4', 'relogin@example.com')
    await quietly(() =>
      withAccountEnv(accountPath, {}, () =>
        login('cli-label', {
          prompt: async () => code,
          startLogin: manualLogin,
        }),
      ),
    )

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.accounts).toHaveLength(1)
    expect(storage.accounts[0]).toMatchObject({
      id: 'cli-label',
      label: 'cli-label',
      enabled: true,
      addedAt: 123,
    })
    const runtimeState = JSON.parse(await readFile(statePath, 'utf8'))
    const entry = runtimeState.accounts['cli-label']
    // No token, and no refresh verdict: those belong to the store now.
    expect(entry.access).toBeUndefined()
    expect(entry.refresh).toBeUndefined()
    expect(entry.lastRefreshError).toBeUndefined()
    expect(entry.lastRefreshedAt).toBeUndefined()
    const rows = await listSharedAccounts()
    expect(rows.find((row) => row.id === 'cli-label')?.refreshDead).toBe(false)
  })

  test('a failed code exchange reports authentication failure and saves nothing', async () => {
    const accountPath = join(tempDir, 'anthropic-auth.json')
    await expect(
      quietly(() =>
        withAccountEnv(accountPath, {}, () =>
          login('nobody', {
            prompt: async () => 'unknown-code',
            startLogin: manualLogin,
          }),
        ),
      ),
    ).rejects.toThrow('Authentication failed')
    expect(await listSharedAccounts()).toEqual([])
  })
})

describe('CLI OAuth revocation', () => {
  test('refuses remote revocation (no refresh token in TS) and changes nothing', async () => {
    const store = useTempStore()
    try {
      const seeded = await seedStoreAccount({ label: 'revoked-account' })
      await expect(revokeAccount(seeded.id)).rejects.toThrow(
        /Remote revocation .* is unavailable/,
      )
      const rows = await listSharedAccounts()
      expect(rows.find((row) => row.id === seeded.id)?.enabled).toBe(true)
    } finally {
      store.dispose()
    }
  })
})

describe('CLI relay setup', () => {
  // relaySetup is exercised IN-PROCESS with an injected fetch + prompt rather
  // than via `bun --preload ... src/cli.ts relay setup`. The old subprocess
  // form hung indefinitely in CI (timed out at 5000ms with proc.exited never
  // resolving) — the failure lived in the subprocess+--preload+readline/stdin
  // harness, not in relaySetup's logic, and was unreproducible locally. Calling
  // relaySetup directly with injected deps removes that entire fragile surface
  // (no spawn, no preload-stub-application risk, no real network, no stdin/pipe
  // race) while still exercising the real setup logic: KV create, worker
  // upload, enable workers.dev, subdomain lookup, token generation, and config
  // save — the same four Cloudflare calls and the same persisted relay config.
  test('deploys worker resources and saves relay config', async () => {
    const accountPath = join(tempDir, 'anthropic-auth.json')
    const calls: Array<{ url: string; method?: string }> = []
    let accountAddedDuringProvisioning = false

    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = input.toString()
      calls.push({ url, method: init?.method })
      if (!accountAddedDuringProvisioning) {
        accountAddedDuringProvisioning = true
        await addAccountPersistent(
          {
            id: 'added-during-relay',
            label: 'added-during-relay',
            type: 'oauth',
          },
          accountPath,
        )
      }
      if (url.includes('/storage/kv/namespaces'))
        return Response.json({ success: true, result: { id: 'kv-id' } })
      if (url.includes('/workers/scripts/opencode-anthropic-relay/subdomain'))
        return Response.json({ success: true, result: { enabled: true } })
      if (url.includes('/workers/subdomain'))
        return Response.json({
          success: true,
          result: { subdomain: 'user-subdomain' },
        })
      if (url.includes('/workers/scripts/opencode-anthropic-relay'))
        return Response.json({ success: true, result: {} })
      return Response.json(
        { success: false, errors: [{ message: `unexpected ${url}` }] },
        { status: 500 },
      )
    }

    // The worker-name prompt returns '' (→ default name); no other prompt fires
    // because the injected fetch returns a workers.dev subdomain.
    const promptAnswers: Record<string, string> = {
      'Worker name [opencode-anthropic-relay]: ': '',
    }
    const askedPrompts: string[] = []
    const prompt = async (message: string) => {
      askedPrompts.push(message)
      return promptAnswers[message] ?? ''
    }

    const prevFile = process.env.OPENCODE_ANTHROPIC_AUTH_FILE
    const prevToken = process.env.CLOUDFLARE_API_TOKEN
    const prevAccount = process.env.CLOUDFLARE_ACCOUNT_ID
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token'
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account-id'
    try {
      await relaySetup({ fetchImpl, prompt })
    } finally {
      if (prevFile === undefined)
        delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
      else process.env.OPENCODE_ANTHROPIC_AUTH_FILE = prevFile
      if (prevToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN
      else process.env.CLOUDFLARE_API_TOKEN = prevToken
      if (prevAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID
      else process.env.CLOUDFLARE_ACCOUNT_ID = prevAccount
    }

    // Token + account come from env, so the only prompt is the worker name.
    expect(askedPrompts).toEqual(['Worker name [opencode-anthropic-relay]: '])

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.relay).toMatchObject({
      enabled: true,
      url: 'https://opencode-anthropic-relay.user-subdomain.workers.dev',
      fallbackToDirect: true,
      transport: 'http',
    })
    expect(storage.relay.token).toBeString()
    expect(
      storage.accounts.map((account: { id: string }) => account.id),
    ).toEqual(['added-during-relay'])

    expect(calls).toHaveLength(4)
    expect(calls.map((c) => `${c.method ?? 'GET'} ${c.url}`)).toEqual([
      'POST https://api.cloudflare.com/client/v4/accounts/account-id/storage/kv/namespaces',
      'PUT https://api.cloudflare.com/client/v4/accounts/account-id/workers/scripts/opencode-anthropic-relay',
      'POST https://api.cloudflare.com/client/v4/accounts/account-id/workers/scripts/opencode-anthropic-relay/subdomain',
      'GET https://api.cloudflare.com/client/v4/accounts/account-id/workers/subdomain',
    ])
  })
})
