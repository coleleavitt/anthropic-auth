import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveAccounts, tokenFingerprint } from '@cortexkit/anthropic-auth-core'

import {
  buildExplicitBaseMessagesUrl,
  configureApiRouteHeaders,
  parseSse,
  primaryResponseAllowsApiFallback,
  streamCortexKitAnthropic,
} from '../stream.ts'

let tempDir: string | undefined
const originalFetch = globalThis.fetch

// Routing now consults the machine-wide shared account store, so the suite
// pins it to a path that never exists and disables legacy migration scanning.
// Without this every fixture would be polluted by the developer's real logins.
const originalSharedDir = process.env.ANTHROPIC_ACCOUNTS_DIR
const originalSharedTestDir = process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR
process.env.ANTHROPIC_ACCOUNTS_DIR = join(
  tmpdir(),
  `pi-stream-tests-shared-${process.pid}`,
)
process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR = '1'
const anthropicModel = {
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
} as any
const anthropicContext = {
  systemPrompt: 'test',
  messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
  tools: [],
} as any

afterAll(() => {
  if (originalSharedDir === undefined) delete process.env.ANTHROPIC_ACCOUNTS_DIR
  else process.env.ANTHROPIC_ACCOUNTS_DIR = originalSharedDir
  if (originalSharedTestDir === undefined)
    delete process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR
  else process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR = originalSharedTestDir
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  delete process.env.PI_ANTHROPIC_AUTH_FILE
  delete process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

describe('Pi API fallback routing helpers', () => {
  test('preserves provider base path when building /v1/messages URL', () => {
    const url = buildExplicitBaseMessagesUrl('https://api.kie.ai/claude')

    expect(url.toString()).toBe(
      'https://api.kie.ai/claude/v1/messages?beta=true',
    )
  })

  test('uses bearer auth by default for API fallback routes', () => {
    const headers = configureApiRouteHeaders(
      {
        id: 'kie-opus',
        type: 'api',
        apiKey: 'kie-key',
        baseURL: 'https://api.kie.ai/claude',
        authHeader: 'authorization-bearer',
      },
      false,
    )

    expect(headers.get('authorization')).toBe('Bearer kie-key')
    expect(headers.get('x-api-key')).toBeNull()
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(headers.get('content-type')).toBe('application/json')
  })

  test('only allows API fallback for direct primary quota exhaustion evidence', () => {
    expect(
      primaryResponseAllowsApiFallback(new Response(null, { status: 429 })),
    ).toBe(true)
    expect(primaryResponseAllowsApiFallback('rate_limit_error')).toBe(true)
    expect(
      primaryResponseAllowsApiFallback(new Response(null, { status: 403 })),
    ).toBe(false)
    expect(
      primaryResponseAllowsApiFallback(new Response(null, { status: 401 })),
    ).toBe(false)
    expect(
      primaryResponseAllowsApiFallback(new Response(null, { status: 200 })),
    ).toBe(false)
  })

  test('supports x-api-key auth mode for API fallback routes', () => {
    const headers = configureApiRouteHeaders(
      {
        id: 'provider-route',
        type: 'api',
        apiKey: 'provider-key',
        baseURL: 'https://provider.example/anthropic',
        authHeader: 'x-api-key',
      },
      true,
    )

    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('x-api-key')).toBe('provider-key')
    expect(headers.get('anthropic-beta')).toContain('fast-mode-2026-02-01')
  })

  test('sticky-balanced keeps repeated Pi session requests on the quota-selected account', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-sticky-routing-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(
      tempDir,
      'sticky-routes.json',
    )
    const checkedAt = Date.now()
    const quota = (fableRemaining: number) => ({
      checkedAt,
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        checkedAt,
      },
      seven_day: {
        usedPercent: 100 - fableRemaining,
        remainingPercent: Math.max(40, fableRemaining),
        resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
        checkedAt,
      },
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100 - fableRemaining,
          remainingPercent: fableRemaining,
          resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
          checkedAt,
        },
      ],
    })
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        fallbackOn: [401, 403, 429],
        refresh: {
          enabled: true,
          intervalMinutes: 10,
          refreshBeforeExpiryMinutes: 240,
        },
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
          mainQuota: quota(0),
          mainQuotaCheckedAt: checkedAt,
          mainQuotaToken: tokenFingerprint('main-access'),
        },
        routing: { mode: 'sticky-balanced' },
        accounts: [
          {
            id: 'yiyi',
            type: 'oauth',
            access: 'scarce-access',
            refresh: 'scarce-refresh',
            expires: checkedAt + 5 * 60 * 60_000,
            quota: quota(13),
          },
          {
            id: 'ufuk2',
            type: 'oauth',
            access: 'abundant-access',
            refresh: 'abundant-refresh',
            expires: checkedAt + 5 * 60 * 60_000,
            quota: quota(98),
          },
        ],
      },
      storagePath,
    )

    const authorizations: string[] = []
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        if (!url.includes('/v1/messages')) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        authorizations.push(authorization)
        if (authorization === 'Bearer main-access') {
          return Promise.resolve(new Response('unauthorized', { status: 401 }))
        }
        return Promise.resolve(
          new Response(
            [
              'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ].join(''),
            { status: 200 },
          ),
        )
      },
    ) as unknown as typeof fetch

    for (let request = 0; request < 2; request++) {
      const stream = streamCortexKitAnthropic(
        anthropicModel,
        anthropicContext,
        {
          apiKey: 'main-access',
          sessionId: 'ses_pi_sticky',
        },
      )
      for await (const _event of stream) {
        // Drain the provider stream.
      }
    }

    const directOpus = streamCortexKitAnthropic(
      { ...anthropicModel, id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
      anthropicContext,
      {
        apiKey: 'main-access',
        sessionId: 'ses_pi_direct_opus',
      },
    )
    for await (const _event of directOpus) {
      // Drain the provider stream.
    }

    expect(authorizations).toEqual([
      'Bearer abundant-access',
      'Bearer abundant-access',
      'Bearer main-access',
      'Bearer abundant-access',
    ])
  })

  test('sticky-balanced reports main re-login when no fallback can serve the requested model', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-sticky-no-route-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(
      tempDir,
      'sticky-routes.json',
    )
    const checkedAt = Date.now()
    const quota = (fableRemaining: number) => ({
      checkedAt,
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        checkedAt,
      },
      seven_day: {
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
        checkedAt,
      },
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100 - fableRemaining,
          remainingPercent: fableRemaining,
          resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
          checkedAt,
        },
      ],
    })
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        fallbackOn: [401, 403, 429],
        refresh: {
          enabled: true,
          intervalMinutes: 10,
          refreshBeforeExpiryMinutes: 240,
          mainLastRefreshError: {
            message: 'invalid_grant',
            checkedAt,
            status: 400,
            permanent: true,
          },
        },
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
          mainQuota: quota(88),
          mainQuotaCheckedAt: checkedAt,
          mainQuotaToken: tokenFingerprint('main-access'),
        },
        routing: { mode: 'sticky-balanced' },
        accounts: [
          {
            id: 'fallback-a',
            type: 'oauth',
            access: 'fallback-a-access',
            refresh: 'fallback-a-refresh',
            expires: checkedAt + 5 * 60 * 60_000,
            quota: quota(0),
          },
          {
            id: 'fallback-b',
            type: 'oauth',
            access: 'fallback-b-access',
            refresh: 'fallback-b-refresh',
            expires: checkedAt + 5 * 60 * 60_000,
            quota: quota(0),
          },
        ],
      },
      storagePath,
    )

    let messageRequests = 0
    globalThis.fetch = mock((input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (url.includes('/v1/messages')) messageRequests += 1
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

    const events = []
    const stream = streamCortexKitAnthropic(anthropicModel, anthropicContext, {
      apiKey: 'main-access',
      sessionId: 'ses_pi_sticky_no_fable_route',
    })
    for await (const event of stream) events.push(event)

    const error = events.find((event) => event.type === 'error')
    expect(error?.error.errorMessage).toContain('HTTP 401')
    expect(error?.error.errorMessage).toContain(
      'Main Claude OAuth account requires re-login, and no fallback OAuth account is currently routable for Fable.',
    )
    expect(messageRequests).toBe(0)
  })

  test('sticky-balanced preserves the strict API fallback gate after OAuth exhaustion', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-sticky-api-routing-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(
      tempDir,
      'sticky-routes.json',
    )
    const checkedAt = Date.now()
    const quota = (remainingPercent: number) => ({
      checkedAt,
      five_hour: {
        usedPercent: 100 - remainingPercent,
        remainingPercent,
        checkedAt,
      },
      seven_day: {
        usedPercent: 100 - remainingPercent,
        remainingPercent,
        checkedAt,
      },
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100 - remainingPercent,
          remainingPercent,
          checkedAt,
        },
      ],
    })
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        fallbackOn: [401, 403, 429],
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
          mainQuota: quota(0),
          mainQuotaCheckedAt: checkedAt,
          mainQuotaToken: tokenFingerprint('main-access'),
        },
        routing: { mode: 'sticky-balanced' },
        accounts: [
          {
            id: 'oauth-fallback',
            type: 'oauth',
            access: 'fallback-access',
            refresh: 'fallback-refresh',
            expires: checkedAt + 5 * 60 * 60_000,
            quota: quota(100),
          },
          {
            id: 'api-fallback',
            type: 'api',
            baseURL: 'https://provider.example/anthropic',
            authHeader: 'authorization-bearer',
            apiKey: 'api-key',
          },
        ],
      },
      storagePath,
    )

    const authorizations: string[] = []
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 100 },
                seven_day: { utilization: 100 },
                limits: [
                  {
                    kind: 'weekly_scoped',
                    group: 'weekly',
                    percent: 100,
                    scope: { model: { display_name: 'Fable' } },
                  },
                ],
              }),
              { status: 200 },
            ),
          )
        }
        if (!url.includes('/v1/messages')) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        authorizations.push(authorization)
        if (authorization === 'Bearer fallback-access') {
          return Promise.resolve(new Response('exhausted', { status: 429 }))
        }
        return Promise.resolve(
          new Response(
            [
              'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ].join(''),
            { status: 200 },
          ),
        )
      },
    ) as unknown as typeof fetch

    const stream = streamCortexKitAnthropic(anthropicModel, anthropicContext, {
      apiKey: 'main-access',
      sessionId: 'ses_pi_sticky_api',
    })
    for await (const _event of stream) {
      // Drain the provider stream.
    }

    expect(authorizations).toEqual(['Bearer fallback-access', 'Bearer api-key'])
  })

  async function streamWithMessageDelta(delta: string) {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-stop-reason-'))
    process.env.PI_ANTHROPIC_AUTH_FILE = join(tempDir, 'anthropic-auth.json')

    globalThis.fetch = mock((input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (!url.includes('/v1/messages'))
        return Promise.resolve(new Response('{}', { status: 200 }))
      return Promise.resolve(
        new Response(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
            `event: message_delta\ndata: ${delta}\n\n`,
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join(''),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch

    const stream = streamCortexKitAnthropic(anthropicModel, anthropicContext, {
      apiKey: 'main-access',
      sessionId: 'ses_pi_stop_reason',
    })
    const terminalTypes: string[] = []
    for await (const event of stream) {
      if (event.type === 'done' || event.type === 'error')
        terminalTypes.push(event.type)
    }
    return { message: await stream.result(), terminalTypes }
  }

  test('reports a refusal stop reason with an actionable message', async () => {
    const { message, terminalTypes } = await streamWithMessageDelta(
      '{"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":1}}',
    )

    expect(message.stopReason).toBe('error')
    expect(message.errorMessage).toContain('refusal')
    expect(terminalTypes).toEqual(['error'])
  })

  test('names the context window when Anthropic reports it exceeded', async () => {
    const { message, terminalTypes } = await streamWithMessageDelta(
      '{"type":"message_delta","delta":{"stop_reason":"model_context_window_exceeded"},"usage":{"output_tokens":1}}',
    )

    expect(message.stopReason).toBe('error')
    expect(message.errorMessage).toContain('context window')
    expect(terminalTypes).toEqual(['error'])
  })

  test('names an unrecognized stop reason instead of dropping it', async () => {
    const { message, terminalTypes } = await streamWithMessageDelta(
      '{"type":"message_delta","delta":{"stop_reason":"brand_new_reason"},"usage":{"output_tokens":1}}',
    )

    expect(message.stopReason).toBe('error')
    expect(message.errorMessage).toContain('brand_new_reason')
    expect(terminalTypes).toEqual(['error'])
  })

  test('treats a usage-only message_delta as a healthy stream', async () => {
    const { message, terminalTypes } = await streamWithMessageDelta(
      '{"type":"message_delta","delta":{},"usage":{"output_tokens":1}}',
    )

    expect(message.stopReason).not.toBe('error')
    expect(message.errorMessage).toBeUndefined()
    expect(terminalTypes).toEqual(['done'])
  })

  test('releases early-abandoned SSE readers without cancelling the stream', async () => {
    let cancelled = false
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"message_start"}\n\n'),
        )
      },
      cancel() {
        cancelled = true
      },
    })

    const events = parseSse(new Response(body))
    const first = await events.next()
    expect(first.value?.type).toBe('message_start')

    await events.return(undefined)

    expect(cancelled).toBe(false)
  })
})

describe('Pi transient retry', () => {
  const SSE_OK = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('')

  const RATE_LIMIT_BODY = JSON.stringify({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message:
        "This request would exceed your account's rate limit. Please try again later.",
    },
  })

  /**
   * Serve `messageResponses` in order to /v1/messages; anything else (quota
   * probes) gets an empty 200 so routing decisions stay on the default path.
   */
  async function streamWithResponses(messageResponses: Response[]) {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-retry-'))
    process.env.PI_ANTHROPIC_AUTH_FILE = join(tempDir, 'anthropic-auth.json')

    let messageCalls = 0
    globalThis.fetch = mock((input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (!url.includes('/v1/messages')) {
        return Promise.resolve(new Response('{}', { status: 200 }))
      }
      const response =
        messageResponses[messageCalls] ??
        messageResponses[messageResponses.length - 1]
      messageCalls += 1
      return Promise.resolve(response!.clone())
    }) as unknown as typeof fetch

    const stream = streamCortexKitAnthropic(anthropicModel, anthropicContext, {
      apiKey: 'main-access',
      sessionId: 'ses_pi_retry',
    })
    const terminalTypes: string[] = []
    for await (const event of stream) {
      if (event.type === 'done' || event.type === 'error')
        terminalTypes.push(event.type)
    }
    return {
      message: await stream.result(),
      terminalTypes,
      messageCalls: () => messageCalls,
    }
  }

  test('retries a soft 429 and succeeds on the next attempt', async () => {
    const { message, terminalTypes, messageCalls } = await streamWithResponses([
      new Response(RATE_LIMIT_BODY, {
        status: 429,
        headers: { 'retry-after': '0' },
      }),
      new Response(SSE_OK, { status: 200 }),
    ])

    expect(terminalTypes).toEqual(['done'])
    expect(message.stopReason).not.toBe('error')
    expect(messageCalls()).toBe(2)
  })

  test('does not retry a hard 429 that is out of credits', async () => {
    // No representative-claim header, so out_of_credits is the binding cause:
    // every retry would fail identically and only delay the real error.
    const { message, terminalTypes, messageCalls } = await streamWithResponses([
      new Response(RATE_LIMIT_BODY, {
        status: 429,
        headers: {
          'anthropic-ratelimit-unified-overage-disabled-reason':
            'out_of_credits',
        },
      }),
    ])

    expect(terminalTypes).toEqual(['error'])
    expect(message.errorMessage).toContain('429')
    expect(messageCalls()).toBe(1)
  })

  test('retries an origin 5xx that used to fail on the first response', async () => {
    const { terminalTypes, messageCalls } = await streamWithResponses([
      new Response('<html>504 Gateway Time-out</html>', {
        status: 504,
        headers: { 'retry-after': '0' },
      }),
      new Response(SSE_OK, { status: 200 }),
    ])

    expect(terminalTypes).toEqual(['done'])
    expect(messageCalls()).toBe(2)
  })

  test('stops retrying when the server says not to', async () => {
    const { terminalTypes, messageCalls } = await streamWithResponses([
      new Response('{"type":"error"}', {
        status: 503,
        headers: { 'x-should-retry': 'false' },
      }),
    ])

    expect(terminalTypes).toEqual(['error'])
    expect(messageCalls()).toBe(1)
  })

  test('surfaces the error body rather than an empty message', async () => {
    const { message } = await streamWithResponses([
      new Response(RATE_LIMIT_BODY, {
        status: 429,
        headers: {
          'anthropic-ratelimit-unified-overage-disabled-reason':
            'out_of_credits',
        },
      }),
    ])

    expect(message.errorMessage).toContain('rate_limit_error')
  })
})

describe('Pi routes from the shared account store', () => {
  const sharedStoreDir = process.env.ANTHROPIC_ACCOUNTS_DIR!

  async function writeSharedStore(accounts: unknown[]) {
    await mkdir(sharedStoreDir, { recursive: true })
    await writeFile(
      join(sharedStoreDir, 'accounts.json'),
      JSON.stringify({ version: 1, accounts, current: 'main-shared' }),
    )
  }

  /** A healthy usage payload, in the shape `/api/oauth/usage` returns. */
  const HEALTHY_USAGE = JSON.stringify({
    five_hour: {
      utilization: 1,
      resets_at: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
    },
    seven_day: {
      utilization: 10,
      resets_at: new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString(),
    },
  })

  // A shared store left behind by a previous test would silently supply
  // fallbacks, so clear it before and after each case.
  beforeEach(async () => {
    await rm(join(sharedStoreDir, 'accounts.json'), { force: true })
  })

  afterEach(async () => {
    await rm(join(sharedStoreDir, 'accounts.json'), { force: true })
  })

  function sharedOAuthAccount(id: string, suffix: string) {
    return {
      id,
      label: id,
      email: `${id}@example.com`,
      credential: {
        type: 'oauth',
        access: `sk-ant-oat01-${suffix.repeat(24)}`,
        refresh: `sk-ant-ort01-${suffix.repeat(24)}`,
        // Far enough out that routing does not try a token refresh first.
        expires_at: Date.now() + 24 * 60 * 60_000,
        scopes: ['user:inference'],
      },
      enabled: true,
      created_at: '2026-08-14T00:00:00.000Z',
    }
  }

  test('falls back to a shared-store account when Pi has no config file', async () => {
    // The exact shape of the reported bug: `~/.pi/agent/anthropic-auth.json`
    // never existed, so the router saw zero fallbacks and the first 429 was
    // fatal even though other logins were present on the machine.
    tempDir = await mkdtemp(join(tmpdir(), 'pi-shared-route-'))
    process.env.PI_ANTHROPIC_AUTH_FILE = join(tempDir, 'anthropic-auth.json')
    await writeSharedStore([
      sharedOAuthAccount('main-shared', 'a'),
      sharedOAuthAccount('fallback-shared', 'b'),
    ])

    const seenTokens: string[] = []
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        if (!url.includes('/v1/messages')) {
          return Promise.resolve(new Response(HEALTHY_USAGE, { status: 200 }))
        }
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        seenTokens.push(authorization)
        // The primary token is rate limited; the shared fallback is healthy.
        if (authorization.includes('main-access')) {
          return Promise.resolve(
            new Response(
              '{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}',
              { status: 429, headers: { 'retry-after': '0' } },
            ),
          )
        }
        return Promise.resolve(
          new Response(
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
            { status: 200 },
          ),
        )
      },
    ) as unknown as typeof fetch

    const stream = streamCortexKitAnthropic(anthropicModel, anthropicContext, {
      apiKey: 'main-access',
      sessionId: 'ses_pi_shared_route',
    })
    const terminalTypes: string[] = []
    for await (const event of stream) {
      if (event.type === 'done' || event.type === 'error')
        terminalTypes.push(event.type)
    }

    expect(terminalTypes).toEqual(['done'])
    // A shared-store credential served the request after the primary was
    // limited, rather than the error surfacing to the caller.
    expect(seenTokens.some((token) => token.includes('sk-ant-oat01-'))).toBe(
      true,
    )
  })

  test('leaves routing untouched when the shared store is empty', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-shared-empty-'))
    process.env.PI_ANTHROPIC_AUTH_FILE = join(tempDir, 'anthropic-auth.json')

    let messageCalls = 0
    globalThis.fetch = mock((input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (!url.includes('/v1/messages')) {
        return Promise.resolve(new Response('{}', { status: 200 }))
      }
      messageCalls += 1
      return Promise.resolve(
        new Response(
          '{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}',
          {
            status: 429,
            headers: {
              'anthropic-ratelimit-unified-overage-disabled-reason':
                'out_of_credits',
            },
          },
        ),
      )
    }) as unknown as typeof fetch

    const stream = streamCortexKitAnthropic(anthropicModel, anthropicContext, {
      apiKey: 'main-access',
      sessionId: 'ses_pi_shared_empty',
    })
    const terminalTypes: string[] = []
    for await (const event of stream) {
      if (event.type === 'done' || event.type === 'error')
        terminalTypes.push(event.type)
    }

    expect(terminalTypes).toEqual(['error'])
    expect(messageCalls).toBe(1)
  })
})
