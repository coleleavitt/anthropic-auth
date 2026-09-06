import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveSharedAccountStore } from '@cortexkit/anthropic-auth-core'

import { resolvePiModelCatalog } from '../index.ts'
import {
  forgetDeadRefreshTokens,
  refreshAnthropicToken,
} from '../shared-refresh.ts'
import { streamCortexKitAnthropic } from '../stream.ts'
import {
  errorHttpStatus,
  type SpanAttributes,
  setTraceApiForTests,
  type TraceSpan,
  withAuthSpan,
} from '../trace-bridge.ts'

type RecordedSpan = {
  name: string
  parent: string | undefined
  attrs: SpanAttributes
  status: 'ok' | 'error'
  error?: string
}

/**
 * A stand-in for the host's `withSpan`: async-context aware so a span opened
 * inside another one records its parent, and errors mark the span failed —
 * the two properties the plugin's spans depend on.
 */
function fakeTraceApi(options: { breakSetAttributes?: boolean } = {}) {
  const spans: RecordedSpan[] = []
  const active = new AsyncLocalStorage<string>()
  const withSpan = <T>(
    name: string,
    attrs: SpanAttributes | undefined,
    fn: (span: TraceSpan) => T,
  ): T => {
    const record: RecordedSpan = {
      name,
      parent: active.getStore(),
      attrs: { ...(attrs ?? {}) },
      status: 'ok',
    }
    let ended = false
    const span: TraceSpan = {
      attrs: record.attrs,
      setAttributes(next) {
        if (options.breakSetAttributes) throw new Error('sink exploded')
        for (const [key, value] of Object.entries(next)) {
          if (value !== undefined) record.attrs[key] = value
        }
      },
      recordError(error) {
        record.status = 'error'
        record.error = error instanceof Error ? error.message : String(error)
      },
      end(status) {
        if (ended) return
        ended = true
        if (status) record.status = status
        spans.push(record)
      },
    }
    return active.run(name, () => {
      let result: T
      try {
        result = fn(span)
      } catch (error) {
        span.recordError(error)
        span.end()
        throw error
      }
      if (result instanceof Promise) {
        return result.then(
          (value) => {
            span.end()
            return value
          },
          (error: unknown) => {
            span.recordError(error)
            span.end()
            throw error
          },
        ) as T
      }
      span.end()
      return result
    })
  }
  return { api: { withSpan }, spans, withSpan }
}

afterEach(() => {
  setTraceApiForTests(undefined)
})

describe('trace bridge', () => {
  test('opens a host span and returns the body result', async () => {
    const host = fakeTraceApi()
    setTraceApiForTests(host.api)

    const value = await withAuthSpan(
      'auth.test',
      { 'auth.reason': 'forced', dropped: undefined },
      async (span) => {
        span.setAttributes({ 'auth.outcome': 'ok' })
        return 42
      },
    )

    expect(value).toBe(42)
    expect(host.spans).toEqual([
      {
        name: 'auth.test',
        parent: undefined,
        attrs: { 'auth.reason': 'forced', 'auth.outcome': 'ok' },
        status: 'ok',
      },
    ])
  })

  test('nests under the ambient host span', async () => {
    const host = fakeTraceApi()
    setTraceApiForTests(host.api)

    await host.withSpan('llm.request', undefined, async () => {
      await withAuthSpan('auth.test', undefined, async () => 'inner')
    })

    expect(host.spans.map((span) => [span.name, span.parent])).toEqual([
      ['auth.test', 'llm.request'],
      ['llm.request', undefined],
    ])
  })

  test('runs the body untraced when the host has no withSpan', async () => {
    setTraceApiForTests({})
    const attrs: SpanAttributes[] = []

    const value = await withAuthSpan('auth.test', { seed: 1 }, async (span) => {
      span.setAttributes({ later: true })
      attrs.push({ ...span.attrs })
      return 'plain'
    })

    expect(value).toBe('plain')
    expect(attrs).toEqual([{ seed: 1, later: true }])
  })

  test('runs the body untraced when the host module is unavailable', async () => {
    setTraceApiForTests(null)

    await expect(
      withAuthSpan('auth.test', undefined, async () => 'still runs'),
    ).resolves.toBe('still runs')
  })

  test('propagates the body error unchanged and marks the span failed', async () => {
    const host = fakeTraceApi()
    setTraceApiForTests(host.api)
    const failure = new Error('body failed')

    await expect(
      withAuthSpan('auth.test', undefined, async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(host.spans).toHaveLength(1)
    expect(host.spans[0]).toMatchObject({
      name: 'auth.test',
      status: 'error',
      error: 'body failed',
    })
  })

  test('still runs the body when the host throws before invoking it', async () => {
    setTraceApiForTests({
      withSpan: () => {
        throw new Error('tracing is broken')
      },
    })

    await expect(
      withAuthSpan('auth.test', undefined, async () => 'worked'),
    ).resolves.toBe('worked')
  })

  test('swallows host attribute failures without touching the body', async () => {
    const host = fakeTraceApi({ breakSetAttributes: true })
    setTraceApiForTests(host.api)

    const value = await withAuthSpan('auth.test', undefined, async (span) => {
      span.setAttributes({ 'auth.outcome': 'ok' })
      return span.attrs['auth.outcome']
    })

    expect(value).toBe('ok')
    expect(host.spans).toHaveLength(1)
  })

  test('returns the settled body value when the host fails after it', async () => {
    const host = fakeTraceApi()
    setTraceApiForTests({
      withSpan: <T>(
        name: string,
        attrs: SpanAttributes | undefined,
        fn: (span: TraceSpan) => T,
      ) =>
        (host.withSpan(name, attrs, fn) as Promise<unknown>).then(() => {
          throw new Error('span sink failed')
        }) as T,
    })

    await expect(
      withAuthSpan('auth.test', undefined, async () => 'kept'),
    ).resolves.toBe('kept')
    const failure = new Error('body failed')
    await expect(
      withAuthSpan('auth.test', undefined, async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
  })

  test('reads an HTTP status off an error field or message', () => {
    expect(
      errorHttpStatus(Object.assign(new Error('x'), { status: 429 })),
    ).toBe(429)
    expect(
      errorHttpStatus(new Error('Anthropic model list failed: HTTP 503')),
    ).toBe(503)
    expect(errorHttpStatus(new Error('nothing'))).toBeUndefined()
    expect(errorHttpStatus('string')).toBeUndefined()
  })
})

describe('auth.refresh spans', () => {
  const originalFetch = globalThis.fetch
  const originalStorePath = process.env.ANTHROPIC_ACCOUNTS_FILE
  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  let directory: string

  beforeEach(async () => {
    forgetDeadRefreshTokens()
    directory = await mkdtemp(join(tmpdir(), 'pi-trace-refresh-'))
    process.env.ANTHROPIC_ACCOUNTS_FILE = join(directory, 'accounts.json')
    // Keep the developer's real Claude Code credential out of adoption.
    process.env.CLAUDE_CONFIG_DIR = join(directory, 'claude')
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    if (originalStorePath === undefined)
      delete process.env.ANTHROPIC_ACCOUNTS_FILE
    else process.env.ANTHROPIC_ACCOUNTS_FILE = originalStorePath
    if (originalClaudeConfigDir === undefined)
      delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
    await rm(directory, { recursive: true, force: true })
  })

  const refresh = `sk-ant-ort01-${'t'.repeat(24)}`
  const access = `sk-ant-oat01-${'t'.repeat(24)}`

  async function seedStore() {
    await saveSharedAccountStore({
      version: 1,
      current: 'pi-main',
      accounts: [
        {
          id: 'pi-main',
          credential: {
            type: 'oauth',
            access,
            refresh,
            expires_at: Date.now() - 1_000,
            refresh_expires_at: Date.now() + 86_400_000,
          },
          enabled: true,
          created_at: new Date().toISOString(),
        },
      ],
    })
  }

  function fakeTokenEndpoint(reply: () => Response) {
    let posts = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (url.includes('/v1/oauth/token')) {
        posts += 1
        return reply()
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    return () => posts
  }

  test('records one ok span for a successful refresh', async () => {
    await seedStore()
    const posts = fakeTokenEndpoint(() =>
      Response.json({
        access_token: `sk-ant-oat01-${'n'.repeat(24)}`,
        refresh_token: `sk-ant-ort01-${'n'.repeat(24)}`,
        expires_in: 3600,
      }),
    )
    const host = fakeTraceApi()
    setTraceApiForTests(host.api)

    const rotated = await refreshAnthropicToken({
      refresh,
      access,
      expires: Date.now() - 1_000,
    })

    expect(rotated.access).toContain('n'.repeat(24))
    expect(posts()).toBe(1)
    const refreshes = host.spans.filter((span) => span.name === 'auth.refresh')
    expect(refreshes).toHaveLength(1)
    expect(refreshes[0]).toMatchObject({
      status: 'ok',
      attrs: {
        'auth.account': 'pi-main',
        'auth.reason': 'expired',
        'auth.outcome': 'ok',
        'auth.source': 'refreshed',
      },
    })
    // Attributes carry ids and fingerprints, never token material.
    for (const value of Object.values(refreshes[0]!.attrs)) {
      expect(String(value)).not.toContain('sk-ant-')
    }
  })

  test('records one revoked span with the HTTP status for invalid_grant', async () => {
    await seedStore()
    const posts = fakeTokenEndpoint(
      () =>
        new Response(
          '{"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}',
          { status: 400 },
        ),
    )
    const host = fakeTraceApi()
    setTraceApiForTests(host.api)

    await expect(
      refreshAnthropicToken(
        { refresh, access, expires: Date.now() - 1_000 },
        { reason: 'forced' },
      ),
    ).rejects.toThrow('invalid_grant')

    expect(posts()).toBe(1)
    const refreshes = host.spans.filter((span) => span.name === 'auth.refresh')
    expect(refreshes).toHaveLength(1)
    expect(refreshes[0]).toMatchObject({
      status: 'error',
      attrs: {
        'auth.account': 'pi-main',
        'auth.reason': 'forced',
        'auth.outcome': 'revoked',
        'http.status': 400,
      },
    })
  })

  test('marks a refresh the plugin declined to spend as refused', async () => {
    await seedStore()
    const posts = fakeTokenEndpoint(() => {
      throw new Error('must not fetch')
    })
    const host = fakeTraceApi()
    setTraceApiForTests(host.api)

    await expect(
      refreshAnthropicToken(
        { refresh, access, expires: Date.now() - 1_000 },
        { refreshTimeoutMs: 30_000 },
      ),
    ).rejects.toThrow('below the refresh lease')

    expect(posts()).toBe(0)
    expect(host.spans).toHaveLength(1)
    expect(host.spans[0]!.attrs['auth.outcome']).toBe('refused')
  })

  test('labels a credential the store has never seen by fingerprint only', async () => {
    fakeTokenEndpoint(
      () => new Response('{"error": "invalid_grant"}', { status: 400 }),
    )
    const host = fakeTraceApi()
    setTraceApiForTests(host.api)

    await refreshAnthropicToken({
      refresh: `sk-ant-ort01-${'q'.repeat(24)}`,
      access: `sk-ant-oat01-${'q'.repeat(24)}`,
      expires: Date.now() + 60_000,
    }).catch(() => {})

    expect(host.spans).toHaveLength(1)
    const attrs = host.spans[0]!.attrs
    expect(attrs['auth.reason']).toBe('preemptive')
    expect(attrs['auth.outcome']).toBe('revoked')
    expect(String(attrs['auth.account'])).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('auth.catalog spans', () => {
  const originalFetch = globalThis.fetch
  const originalStorePath = process.env.ANTHROPIC_ACCOUNTS_FILE
  const originalCatalogPath = process.env.ANTHROPIC_MODEL_CATALOG_FILE
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pi-trace-catalog-'))
    process.env.ANTHROPIC_ACCOUNTS_FILE = join(directory, 'accounts.json')
    process.env.ANTHROPIC_MODEL_CATALOG_FILE = join(directory, 'catalog.json')
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    if (originalStorePath === undefined)
      delete process.env.ANTHROPIC_ACCOUNTS_FILE
    else process.env.ANTHROPIC_ACCOUNTS_FILE = originalStorePath
    if (originalCatalogPath === undefined)
      delete process.env.ANTHROPIC_MODEL_CATALOG_FILE
    else process.env.ANTHROPIC_MODEL_CATALOG_FILE = originalCatalogPath
    await rm(directory, { recursive: true, force: true })
  })

  test('records the model count and cache state for a cold offline start', async () => {
    globalThis.fetch = (() => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const host = fakeTraceApi()
    setTraceApiForTests(host.api)

    const models = await resolvePiModelCatalog()

    expect(models.length).toBeGreaterThan(0)
    expect(host.spans).toHaveLength(1)
    expect(host.spans[0]).toMatchObject({
      name: 'auth.catalog',
      status: 'ok',
      attrs: {
        'catalog.models': models.length,
        'catalog.cached': false,
        'catalog.source': 'fallback',
        'catalog.authenticated': false,
      },
    })
  })
})

describe('auth.route spans', () => {
  const originalFetch = globalThis.fetch
  const originalStorePath = process.env.ANTHROPIC_ACCOUNTS_FILE
  const originalTestDir = process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pi-trace-route-'))
    process.env.ANTHROPIC_ACCOUNTS_FILE = join(directory, 'accounts.json')
    process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR = '1'
    process.env.PI_ANTHROPIC_AUTH_FILE = join(directory, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(
      directory,
      'routing-state.json',
    )
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    if (originalStorePath === undefined)
      delete process.env.ANTHROPIC_ACCOUNTS_FILE
    else process.env.ANTHROPIC_ACCOUNTS_FILE = originalStorePath
    if (originalTestDir === undefined)
      delete process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR
    else process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR = originalTestDir
    delete process.env.PI_ANTHROPIC_AUTH_FILE
    delete process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE
    await rm(directory, { recursive: true, force: true })
  })

  test('names the selected shared account under the ambient request span', async () => {
    await saveSharedAccountStore({
      version: 1,
      current: 'shared-main',
      accounts: [
        {
          id: 'shared-main',
          label: 'shared-main',
          credential: {
            type: 'oauth',
            access: `sk-ant-oat01-${'a'.repeat(24)}`,
            refresh: `sk-ant-ort01-${'a'.repeat(24)}`,
            expires_at: Date.now() + 24 * 60 * 60_000,
            scopes: ['user:inference'],
          },
          enabled: true,
          created_at: '2026-08-14T00:00:00.000Z',
        },
      ],
    })
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (!url.includes('/v1/messages')) {
        return new Response('{}', { status: 200 })
      }
      return new Response(
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const host = fakeTraceApi()
    setTraceApiForTests(host.api)

    const terminalTypes: string[] = []
    await host.withSpan('llm.request', undefined, async () => {
      const stream = streamCortexKitAnthropic(
        {
          id: 'claude-fable-5',
          name: 'Claude Fable 5',
          api: 'anthropic-messages',
          provider: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          reasoning: true,
          input: ['text'],
          cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
          contextWindow: 1_000_000,
          maxTokens: 128_000,
        } as never,
        {
          systemPrompt: 'test',
          messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
          tools: [],
        } as never,
        { sessionId: 'ses_pi_trace_route' } as never,
      )
      for await (const event of stream) {
        if (event.type === 'done' || event.type === 'error')
          terminalTypes.push(event.type)
      }
    })

    expect(terminalTypes).toEqual(['done'])
    const routes = host.spans.filter((span) => span.name === 'auth.route')
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({
      parent: 'llm.request',
      status: 'ok',
      attrs: {
        'auth.pool_size': 1,
        'auth.selected': 'shared-main',
        'auth.outcome': 'selected',
      },
    })
  })
})
