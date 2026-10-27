import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ANTHROPIC_OAUTH_ORIGIN_REFUSAL,
  CACHE_KEEP_PREWARM_LEAD_MS,
  CACHE_KEEP_TTL_MS,
  CacheKeepSessionRegistry,
  createNativePoolStore,
  resolveNativePoolPaths,
  runNativeMigration,
} from '@cortexkit/anthropic-auth-core'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import type { Plugin } from '@opencode/plugin'
import type { SessionHooks } from '@opencode/plugin/promise/session'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec'
import { setupAnthropicAuth } from '../v2/setup'

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

async function fixture(child = false, brokenRegistry = false) {
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
  }))
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
      integration: { transform: async () => registration },
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
    const live = async (url = 'https://api.anthropic.com/v1/messages') => {
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
  }
}
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

test('OpenCode 2 instances for different account storage never share tracked sessions', async () => {
  const f = await fixture()
  const other = await fixture()
  await f.live()
  expect(other.timers.callbacks.size).toBe(0)
  // The other storage's live instance must not keep these sessions alive.
  await f.dispose()
  expect(f.timers.callbacks.size).toBe(0)
  other.due()
  await other.timers.fire()
  expect(other.sent).toHaveLength(0)
  expect(await other.registry.list()).toEqual([])
})

test('releasing the last OpenCode 2 instance for a storage stops the timer and drops its sessions', async () => {
  const f = await fixture()
  await f.live()
  const next = await f.start()
  await next.dispose()
  expect(f.timers.callbacks.size).toBe(1)
  await f.dispose()
  expect(f.timers.callbacks.size).toBe(0)
  expect(await f.registry.list()).toEqual([])
  const later = await f.start()
  f.due()
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
