import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  __setLogTestSink,
  ANTHROPIC_OAUTH_ORIGIN_REFUSAL,
  CACHE_KEEP_PREWARM_LEAD_MS,
  CACHE_KEEP_TTL_MS,
  CacheKeepSessionRegistry,
  createNativeAccountRuntime,
  createNativePoolStore,
  formatLogLine,
  getLogLevel,
  logger,
  resolveNativePoolPaths,
  runNativeMigration,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import type { Plugin } from '@opencode/plugin'
import type { SessionHooks } from '@opencode/plugin/promise/session'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec'
import { nativeVaultPaths } from '../../../core/src/native-vault-paths.ts'
import { createNativeMenuCapabilities } from '../v2/menu'
import { setupAnthropicAuth } from '../v2/setup'
import type { NativeSource } from '../v2/source'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

class Timers {
  readonly callbacks = new Map<object, () => unknown>()
  readonly setInterval: typeof globalThis.setInterval = ((
    callback: () => unknown,
  ) => {
    const id = { unref() {} }
    this.callbacks.set(id, callback)
    return id
  }) as unknown as typeof globalThis.setInterval
  readonly clearInterval: typeof globalThis.clearInterval = ((id: object) => {
    this.callbacks.delete(id)
  }) as unknown as typeof globalThis.clearInterval
  async fire() {
    await Promise.all(
      [...this.callbacks.values()].map((callback) => callback()),
    )
  }
}

async function fixture(
  child = false,
  brokenRegistry = false,
  savedLevel?: string,
  vaultMode = false,
) {
  const directory = await mkdtemp(join(tmpdir(), 'oc2-cachekeep-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const paths = await resolveNativePoolPaths(
    join(directory, 'accounts.json'),
    join(directory, 'state.json'),
  )
  await writeFile(
    paths.legacyConfig,
    JSON.stringify({ version: 1, accounts: [] }),
  )
  await writeFile(
    paths.legacyState,
    JSON.stringify({ version: 1, accounts: {} }),
  )
  await runNativeMigration({
    paths,
    host: 'opencode',
    hostAuthPath: join(directory, 'auth.json'),
    routingSourcePath: join(directory, 'old-routing.json'),
    routingDestinationPath: join(directory, 'routing.json'),
    env: {},
    processFence: async () => {},
    removePiAnthropicAuth: false,
  })
  const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
  const identity = '11111111-2222-4333-8444-555555555555'
  for (const id of ['first', 'second']) {
    await store.add({
      id,
      identity:
        id === 'first' ? identity : '99999999-2222-4333-8444-555555555555',
      credential: {
        type: 'oauth',
        access: `sk-ant-oat01-${id}`,
        refresh: `refresh-${id}`,
        expires: Date.now() + 10 * 3600_000,
      },
    })
  }
  await store.updateSettings(() => ({
    mainAccountId: 'first',
    quota: { enabled: false },
    routing: { mode: 'main-first' },
    claudeCache: { enabled: true, mode: 'hybrid' },
    cacheKeep: { enabled: true, always: true },
    ...(savedLevel && { logging: { level: savedLevel } }),
  }))
  if (vaultMode) {
    await writeFile(
      join(directory, 'enrollment.json'),
      JSON.stringify({
        token: '01'.repeat(32),
        token_generation: 1,
      }),
      { mode: 0o600 },
    )
    const vaultStore = createNativePoolStore({
      paths: nativeVaultPaths(paths),
      quota: nativeQuotaCodec,
    })
    await vaultStore.initialize()
    await vaultStore.updateSettings((settings) => ({
      ...settings,
      logging: { level: 'debug' },
    }))
  }
  let now = Date.now()
  const timers = new Timers()
  const registryDirectory = join(directory, 'registry')
  if (brokenRegistry) await writeFile(registryDirectory, 'not a directory')
  const registry = new CacheKeepSessionRegistry({
    directory: registryDirectory,
    now: () => now,
  })
  const start = async () => {
    const hooks = new Map<string, Array<(draft: any) => unknown>>()
    const registration = { dispose: async () => {} }
    const ctx = {
      session: {
        get: async () => ({ parentID: child ? 'ses_parent' : undefined }),
        hook: async (name: string, callback: (draft: any) => unknown) => {
          hooks.set(name, [...(hooks.get(name) ?? []), callback])
          return registration
        },
      },
      model: { transform: async () => registration },
      integration: {
        transform: async () => {
          logger.debug('startup-test', 'registering integration')
          return registration
        },
      },
      rpc: {
        register: async () => ({
          ...registration,
          events: { emit: async () => {} },
        }),
      },
      command: { transform: async () => registration },
      event: { subscribe: async function* () {} },
    } as unknown as Plugin.Context
    const sent: Request[] = []
    let send: (request: Request) => Promise<Response> = async () =>
      Response.json({ usage: { cache_read_input_tokens: 1 } })
    const dispose = await setupAnthropicAuth(ctx, {
      paths,
      vault: {
        env: {
          OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
            directory,
            'enrollment.json',
          ),
        },
      },
      local: {
        resolveIdentity: async (access) =>
          ({
            accountUuid: access.endsWith('first')
              ? identity
              : '99999999-2222-4333-8444-555555555555',
          }) as never,
      },
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input as Request, init)
        if (new URL(request.url).pathname !== '/v1/messages')
          return Response.json({})
        sent.push(request.clone() as Request)
        return send(request as Request)
      }) as typeof fetch,
      cacheKeep: {
        now: () => now,
        setIntervalImpl: timers.setInterval,
        clearIntervalImpl: timers.clearInterval,
        registryDirectory,
      },
    })
    cleanups.push(dispose)
    const live = async (
      url = 'https://api.anthropic.com/v1/messages',
      extra: Record<string, unknown> = {},
    ) => {
      const draft = {
        sessionID: 'ses_oc2_keep' as SessionHooks['http.request']['sessionID'],
        agent: 'build',
        model: { providerID: 'anthropic', id: 'claude-sonnet-4-6' },
        kind: 'primary',
        request: new Request(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${placeholderSecret('anthropic')}`,
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 8,
            system: 'Cache me',
            messages: [{ role: 'user', content: 'Hello' }],
            metadata: { user_id: 'untrusted' },
            ...extra,
          }),
        }),
      }
      for (const callback of hooks.get('context') ?? [])
        await callback({
          ...draft,
          messages: [
            {
              id: 'msg_oc2_keep',
              role: 'user',
              content: [{ type: 'text', text: 'Hello' }],
            },
          ],
        })
      const modelDraft = { ...draft, headers: {} as Record<string, string> }
      for (const callback of hooks.get('model.request') ?? [])
        await callback(modelDraft)
      for (const [name, value] of Object.entries(modelDraft.headers))
        draft.request.headers.set(name, value)
      for (const callback of hooks.get('http.request') ?? [])
        await callback(draft)
      return draft.request
    }
    return {
      live,
      sent,
      dispose,
      setSend: (callback: typeof send) => {
        send = callback
      },
    }
  }
  return {
    ...(await start()),
    /** Another plugin instance for the same account storage and clock. */
    start,
    paths,
    store,
    registry,
    timers,
    due: () => {
      now += CACHE_KEEP_TTL_MS - CACHE_KEEP_PREWARM_LEAD_MS
    },
    advance: (ms: number) => {
      now += ms
    },
  }
}

function captureStartupLogs() {
  const previous = getLogLevel()
  const env = process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL
  const lines: string[] = []
  delete process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL
  setLogLevel('info')
  __setLogTestSink(({ level, channel, message, payload }) => {
    lines.push(formatLogLine(level, channel, message, payload))
  })
  cleanups.push(() => {
    __setLogTestSink(null)
    setLogLevel(previous)
    if (env === undefined) delete process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL
    else process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL = env
  })
  return lines
}

test('OpenCode 2 saved debug level emits a debug line during plugin startup', async () => {
  const lines = captureStartupLogs()
  await fixture(false, false, 'debug')
  expect(
    lines.some(
      (line) =>
        line.includes('DEBUG') && line.includes('registering integration'),
    ),
  ).toBe(true)
  expect(getLogLevel()).toBe('debug')
})

test('OpenCode 2 startup preserves the environment log-level override', async () => {
  const lines = captureStartupLogs()
  process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL = 'warn'
  // The logger reads the environment on module load, before host startup.
  setLogLevel('warn')
  await fixture(false, false, 'debug')
  expect(getLogLevel()).toBe('warn')
  expect(lines.some((line) => line.includes('registering integration'))).toBe(
    false,
  )
})

test('OpenCode 2 startup reads saved logging from vault rather than local settings', async () => {
  const lines = captureStartupLogs()
  await fixture(false, false, 'warn', true)
  expect(getLogLevel()).toBe('debug')
  expect(
    lines.some(
      (line) =>
        line.includes('DEBUG') && line.includes('registering integration'),
    ),
  ).toBe(true)
})

test('OpenCode 2 menu re-picking the saved log level repairs live drift', async () => {
  const lines = captureStartupLogs()
  const f = await fixture(false, false, 'debug')
  const runtime = createNativeAccountRuntime({
    paths: f.paths,
    host: 'opencode',
  })
  cleanups.push(() => runtime.close())
  const capabilities = createNativeMenuCapabilities({
    runtime,
    source: {} as NativeSource,
    start: async () => {},
  })
  cleanups.push(() => capabilities.close())
  setLogLevel('info')
  await capabilities.dispatch(
    { action: 'logging-level', values: { level: 'debug' } },
    {},
  )
  logger.debug('menu-test', 'debug after re-pick')
  expect(getLogLevel()).toBe('debug')
  expect(
    lines.some(
      (line) => line.includes('DEBUG') && line.includes('debug after re-pick'),
    ),
  ).toBe(true)
  expect((await runtime.read()).settings.logging).toEqual({ level: 'debug' })
})
test('OpenCode 2 hybrid requests publish a CacheKeep lease and dispose removes its timer', async () => {
  const f = await fixture()
  await f.live()
  expect((await f.registry.list()).map((session) => session.id)).toEqual([
    'ses_oc2_keep',
  ])
  expect(f.timers.callbacks.size).toBe(1)
  await f.dispose()
  expect(f.timers.callbacks.size).toBe(0)
  expect(await f.registry.list()).toEqual([])
})

test('OpenCode 2 records its use of the pool at setup and serves a request as before', async () => {
  const f = await fixture()
  const holders = JSON.parse(
    await readFile(
      join(dirname(f.paths.runtime), 'anthropic-auth-holders.json'),
      'utf8',
    ),
  ) as { entries: Array<{ pid: number; role: string; files: string[] }> }
  expect(holders.entries).toEqual([
    expect.objectContaining({ pid: process.pid, role: 'opencode2' }),
  ])
  expect(holders.entries[0]?.files).toContain(f.paths.runtime)
  const request = await f.live()
  expect(request.headers.get('authorization')).toBe('Bearer sk-ant-oat01-first')
})

test('OpenCode 2 registry publication failure never rejects the live request', async () => {
  const f = await fixture(false, true)
  const request = await f.live()
  expect(request.headers.get('authorization')).toBe('Bearer sk-ant-oat01-first')
  expect(f.timers.callbacks.size).toBe(1)
})

test('a due OpenCode 2 prewarm sends once with the original account and no billing lineage', async () => {
  const f = await fixture()
  expect(await (await f.live()).text()).toContain('prompt_id')
  await f.store.rotate('first', {
    type: 'oauth',
    access: 'sk-ant-oat01-rotated-first',
    refresh: 'refresh-first',
    expires: Date.now() + 12 * 3600_000,
  })
  await f.store.updateSettings((settings) => ({
    ...settings,
    mainAccountId: 'second',
  }))
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(1)
  expect(f.sent[0]!.headers.get('authorization')).toBe(
    'Bearer sk-ant-oat01-rotated-first',
  )
  const body = (await f.sent[0]!.json()) as Record<string, any>
  expect(body.max_tokens).toBe(0)
  expect(body.stream).toBeUndefined()
  expect(JSON.stringify(body)).not.toMatch(/prompt_id|previous_request_id/)
  expect(
    body.system.some((block: any) => block.cache_control?.ttl === '1h'),
  ).toBe(true)
  await f.timers.fire()
  expect(f.sent).toHaveLength(1)
})

test('an OpenCode 2 prewarm sends the live request prefix as it was sent, without rewriting it again', async () => {
  const f = await fixture()
  // The stored body is the one already sent: tool names prefixed, billing
  // and identity blocks added. Rewriting it again changes that prefix, so the
  // prewarm would write a new cache entry instead of reading the session's.
  const sentLive = JSON.parse(
    await (
      await f.live(undefined, {
        tools: [
          {
            name: 'read',
            description: 'Read a file',
            input_schema: { type: 'object', properties: {} },
          },
        ],
      })
    ).text(),
  ) as Record<string, any>
  expect(sentLive.tools[0].name).toBe('mcp_Read')
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(1)
  const warm = (await f.sent[0]!.json()) as Record<string, any>
  expect(warm.tools).toEqual(sentLive.tools)
  // Only the first system block, the billing header, may differ: it carries
  // the signature over the changed prewarm body.
  expect(warm.system).toHaveLength(sentLive.system.length)
  expect(warm.system.slice(1)).toEqual(sentLive.system.slice(1))
  expect(warm.messages).toEqual(sentLive.messages)
})

test('turning OpenCode 2 cache keepalive off prevents due prewarms', async () => {
  const f = await fixture()
  await f.live()
  expect(f.timers.callbacks.size).toBe(1)
  await f.store.updateSettings((settings) => ({
    ...settings,
    cacheKeep: { enabled: false },
  }))
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(0)
})

test('OpenCode 2 only keeps child sessions warm when subagent tracking is enabled', async () => {
  const f = await fixture(true)
  await f.live()
  expect(await f.registry.list()).toEqual([])
  expect(f.timers.callbacks.size).toBe(0)
  await f.store.updateSettings((settings) => ({
    ...settings,
    cacheKeep: { enabled: true, always: true, subagents: true },
  }))
  await f.live()
  expect(f.timers.callbacks.size).toBe(1)
  expect(await f.registry.list()).toHaveLength(1)
})

test('OpenCode 2 never prewarms a replacement login in the same account row', async () => {
  const f = await fixture()
  await f.live()
  expect(f.timers.callbacks.size).toBe(1)
  await f.store.replace(
    'first',
    {
      type: 'oauth',
      access: 'sk-ant-oat01-replaced-first',
      refresh: 'replacement-refresh',
      expires: Date.now() + 12 * 3600_000,
    },
    { identity: '11111111-2222-4333-8444-555555555555' },
  )
  await f.store.updateSettings((settings) => ({
    ...settings,
    mainAccountId: 'first',
  }))
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(0)
})

test('OpenCode 2 dispose aborts and joins an in-flight prewarm', async () => {
  const f = await fixture()
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let finish!: () => void
  const ended = new Promise<void>((resolve) => {
    finish = resolve
  })
  f.setSend(async (request) => {
    entered()
    await new Promise<void>((resolve) =>
      request.signal.addEventListener('abort', () => resolve(), { once: true }),
    )
    await ended
    throw new Error('cancelled prewarm')
  })
  await f.live()
  expect(f.timers.callbacks.size).toBe(1)
  f.due()
  const tick = f.timers.fire()
  await started
  let disposed = false
  const closing = Promise.resolve(f.dispose()).then(() => {
    disposed = true
  })
  await Promise.resolve()
  expect(disposed).toBe(false)
  finish()
  await closing
  await tick
  expect(f.timers.callbacks.size).toBe(0)
})

test('a later OpenCode 2 instance for the same storage keeps warming a session the disposed one tracked', async () => {
  const f = await fixture()
  await f.live()
  const next = await f.start()
  await f.dispose()
  expect(f.timers.callbacks.size).toBe(1)
  expect((await f.registry.list()).map((session) => session.id)).toEqual([
    'ses_oc2_keep',
  ])
  // A token refreshed after the reload must be the one the prewarm carries.
  await f.store.rotate('first', {
    type: 'oauth',
    access: 'sk-ant-oat01-reloaded-first',
    refresh: 'refresh-first',
    expires: Date.now() + 12 * 3600_000,
  })
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(0)
  expect(next.sent).toHaveLength(1)
  expect(next.sent[0]!.headers.get('authorization')).toBe(
    'Bearer sk-ant-oat01-reloaded-first',
  )
})

test('a late OpenCode 2 dispose of the predecessor leaves its successor warming', async () => {
  const f = await fixture()
  await f.live()
  const next = await f.start()
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const aborted: boolean[] = []
  next.setSend(async (request) => {
    entered()
    await gate
    aborted.push(request.signal.aborted)
    return Response.json({ usage: { cache_read_input_tokens: 1 } })
  })
  f.due()
  const tick = f.timers.fire()
  await started
  // The predecessor is disposed while its successor's prewarm is in flight.
  await f.dispose()
  release()
  await tick
  expect(aborted).toEqual([false])
  expect(f.timers.callbacks.size).toBe(1)
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(0)
  expect(next.sent).toHaveLength(2)
  expect(aborted).toEqual([false, false])
})

test('an OpenCode 2 prewarm never goes through a disposed instance, even the newest', async () => {
  const f = await fixture()
  const newer = await f.start()
  await newer.live()
  await newer.dispose()
  f.due()
  await f.timers.fire()
  expect(newer.sent).toHaveLength(0)
  expect(f.sent).toHaveLength(1)
  expect(f.sent[0]!.headers.get('authorization')).toBe(
    'Bearer sk-ant-oat01-first',
  )
})

test('an OpenCode 2 instance for different account storage adopts nothing a disposed instance retained', async () => {
  const f = await fixture()
  await f.live()
  await f.dispose()
  const other = await fixture()
  // Adoption would restart the retained sessions' timer, which runs on the
  // first fixture's timers, and list them in the first fixture's registry.
  expect(f.timers.callbacks.size).toBe(0)
  expect(other.timers.callbacks.size).toBe(0)
  f.due()
  other.due()
  await f.timers.fire()
  await other.timers.fire()
  expect(other.sent).toHaveLength(0)
  expect(await f.registry.list()).toEqual([])
  expect(await other.registry.list()).toEqual([])
})

test('an OpenCode 2 instance that boots after the last one was disposed keeps warming its sessions', async () => {
  const f = await fixture()
  await f.live()
  await f.dispose()
  expect(f.timers.callbacks.size).toBe(0)
  const next = await f.start()
  expect(f.timers.callbacks.size).toBe(1)
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(0)
  expect(next.sent).toHaveLength(1)
  expect(next.sent[0]!.headers.get('authorization')).toBe(
    'Bearer sk-ant-oat01-first',
  )
})

test('nothing is sent while no OpenCode 2 instance exists, and the next one sends with the current token', async () => {
  const f = await fixture()
  await f.live()
  const next = await f.start()
  await next.dispose()
  await f.dispose()
  expect(f.timers.callbacks.size).toBe(0)
  expect(await f.registry.list()).toEqual([])
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(0)
  expect(next.sent).toHaveLength(0)
  // The prewarm must read the token current when it is sent, never one held
  // from an instance that has gone.
  await f.store.rotate('first', {
    type: 'oauth',
    access: 'sk-ant-oat01-rebooted-first',
    refresh: 'refresh-first',
    expires: Date.now() + 12 * 3600_000,
  })
  const later = await f.start()
  await f.timers.fire()
  expect(f.sent).toHaveLength(0)
  expect(next.sent).toHaveLength(0)
  expect(later.sent).toHaveLength(1)
  expect(later.sent[0]!.headers.get('authorization')).toBe(
    'Bearer sk-ant-oat01-rebooted-first',
  )
})

test('an OpenCode 2 instance that boots after the cache expired adopts nothing', async () => {
  const f = await fixture()
  await f.live()
  await f.dispose()
  f.advance(CACHE_KEEP_TTL_MS)
  const later = await f.start()
  expect(f.timers.callbacks.size).toBe(0)
  await f.timers.fire()
  expect(later.sent).toHaveLength(0)
  expect(await f.registry.list()).toEqual([])
})

/** Sets the test-only loopback OAuth origin until the test's cleanup. */
function admitLoopbackOrigin(origin: string) {
  const saved = process.env.ANTHROPIC_AUTH_TEST_OAUTH_LOOPBACK_ORIGIN
  process.env.ANTHROPIC_AUTH_TEST_OAUTH_LOOPBACK_ORIGIN = origin
  cleanups.push(() => {
    if (saved === undefined)
      delete process.env.ANTHROPIC_AUTH_TEST_OAUTH_LOOPBACK_ORIGIN
    else process.env.ANTHROPIC_AUTH_TEST_OAUTH_LOOPBACK_ORIGIN = saved
  })
}

const LOOPBACK = 'http://127.0.0.1:9'

test('an OpenCode 2 request to a provider baseURL elsewhere is refused and never kept warm', async () => {
  const f = await fixture()
  await expect(f.live(`${LOOPBACK}/v1/messages`)).rejects.toThrow(
    ANTHROPIC_OAUTH_ORIGIN_REFUSAL,
  )
  expect(await f.registry.list()).toEqual([])
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(0)
})

for (const stillAdmitted of [true, false]) {
  test(`an OpenCode 2 prewarm to a remembered loopback URL ${stillAdmitted ? 'is sent while the test origin admits it' : 'is refused once the origin is no longer allowed'}`, async () => {
    const f = await fixture()
    admitLoopbackOrigin(LOOPBACK)
    await (await f.live(`${LOOPBACK}/v1/messages`)).text()
    expect((await f.registry.list()).map((session) => session.id)).toEqual([
      'ses_oc2_keep',
    ])
    if (!stillAdmitted)
      delete process.env.ANTHROPIC_AUTH_TEST_OAUTH_LOOPBACK_ORIGIN
    f.due()
    await f.timers.fire()
    expect(f.sent.map((request) => new URL(request.url).origin)).toEqual(
      stillAdmitted ? [LOOPBACK] : [],
    )
  })
}
