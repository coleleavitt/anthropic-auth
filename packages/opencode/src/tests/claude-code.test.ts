import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  applyClaudeCodeHeaders,
  applyClaudeCodeMetadata,
  CLAUDE_CODE_FULL_AGENT_BETAS,
  type ClaudeCodeIdentity,
  getCachedClaudeCodeVersion,
  orderClaudeCodeBody,
  REQUIRED_BETAS,
  resolveClaudeCodeIdentity,
  selectClaudeCodeBetas,
} from '@cortexkit/anthropic-auth-core'

describe('Claude Code fingerprint helpers', () => {
  test('selects the live-captured full-agent beta set only for tool-bearing agent requests', () => {
    const body = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      system: [{ type: 'text', text: 'system' }],
      tools: [{ name: 'mcp_Read', input_schema: { type: 'object' } }],
      thinking: { type: 'adaptive' },
      context_management: { edits: [] },
      output_config: { effort: 'high' },
      diagnostics: { enabled: true },
      stream: true,
    }

    // Claude Code carries a `[1m]` marker on the model id internally and gates
    // the 1M beta on it, but sends the bare id on the wire — so a capture can
    // never show the marker. We derive the same capability from the model
    // family instead, which means the beta is present here where the capture
    // could not record it.
    expect(selectClaudeCodeBetas(body).split(',')).toEqual([
      ...CLAUDE_CODE_FULL_AGENT_BETAS,
      'context-1m-2025-08-07',
    ])
    const fullBetas = selectClaudeCodeBetas(body).split(',')
    expect(fullBetas[0]).toBe('claude-code-20250219')
    expect(fullBetas).toContain('thinking-token-count-2026-05-13')
    expect(fullBetas).not.toContain('redact-thinking-2026-02-12')
    expect(fullBetas).toContain('claude-code-20250219')
    expect(fullBetas).toContain('context-1m-2025-08-07')
    expect(fullBetas).toContain('effort-2025-11-24')
  })

  test('selects structured-output betas without full-agent private betas', () => {
    const betas = selectClaudeCodeBetas({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'title' }],
      system: [{ type: 'text', text: 'system' }],
      tools: [],
      output_config: { format: { type: 'json_schema' } },
      stream: true,
    }).split(',')

    expect(betas).toContain('structured-outputs-2025-12-15')
    expect(betas).toContain('thinking-token-count-2026-05-13')
    expect(betas).not.toContain('redact-thinking-2026-02-12')
    expect(betas).toContain('claude-code-20250219')
    expect(betas).toContain('effort-2025-11-24')
    expect(betas).not.toContain('advanced-tool-use-2025-11-20')
    expect(betas).not.toContain('context-1m-2025-08-07')
    expect(betas).toContain('extended-cache-ttl-2025-04-11')
  })

  test('does not add full-agent-only betas for tool requests missing captured companion fields', () => {
    const betas = selectClaudeCodeBetas({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      system: [{ type: 'text', text: 'system' }],
      tools: [{ name: 'mcp_Read', input_schema: { type: 'object' } }],
      stream: true,
    }).split(',')

    expect(betas).toEqual([
      'claude-code-20250219',
      'oauth-2025-04-20',
      'interleaved-thinking-2025-05-14',
      'thinking-token-count-2026-05-13',
      'context-management-2025-06-27',
      'prompt-caching-scope-2026-01-05',
      'effort-2025-11-24',
      'extended-cache-ttl-2025-04-11',
      'cache-diagnosis-2026-04-07',
      // sonnet-4-6 is a 1M family, so the beta is derived from the model id.
      'context-1m-2025-08-07',
    ])
    expect(betas).toContain('thinking-token-count-2026-05-13')
    expect(betas).not.toContain('advanced-tool-use-2025-11-20')
    expect(betas).toContain('extended-cache-ttl-2025-04-11')
    expect(betas).toContain('claude-code-20250219')
    expect(betas).toContain('context-1m-2025-08-07')
    expect(betas).toContain('effort-2025-11-24')
    expect(betas).not.toContain('redact-thinking-2026-02-12')
  })

  test('does not add full-agent betas when request shape is unavailable', () => {
    const betas = selectClaudeCodeBetas(null).split(',')

    for (const beta of REQUIRED_BETAS) expect(betas).toContain(beta)
    expect(betas[0]).toBe('claude-code-20250219')
    expect(betas).toContain('thinking-token-count-2026-05-13')
    expect(betas).toContain('effort-2025-11-24')
    expect(betas).not.toContain('redact-thinking-2026-02-12')
    expect(betas).toContain('claude-code-20250219')
  })

  test('applies Claude Code headers and couples session id to metadata', () => {
    const identity: ClaudeCodeIdentity = {
      deviceId: 'a'.repeat(64),
      accountUuid: '11111111-2222-4333-8444-555555555555',
      sessionId: '66666666-7777-4888-9999-aaaaaaaaaaaa',
    }
    const body: Record<string, unknown> = {
      model: 'claude-sonnet-4-6',
      messages: [],
      system: [],
      tools: [{ name: 'mcp_Read' }],
    }

    applyClaudeCodeMetadata(body, identity)
    const headers = applyClaudeCodeHeaders(
      new Headers({ 'anthropic-beta': 'custom-beta' }),
      'sk-ant-oat-test',
      { body, identity },
    )

    expect(headers.get('user-agent')).toBe(
      `claude-cli/${getCachedClaudeCodeVersion()} (external, cli)`,
    )
    expect(headers.get('x-claude-code-session-id')).toBe(identity.sessionId)
    expect(headers.get('x-stainless-package-version')).toBe('0.112.1')
    expect(headers.get('x-stainless-runtime-version')).toBe('v26.3.0')
    expect(headers.get('x-app')).toBe('cli')
    expect(headers.get('anthropic-dangerous-direct-browser-access')).toBe(
      'true',
    )
    expect(headers.get('anthropic-beta')).toContain('custom-beta')

    const userId = JSON.parse(
      (body.metadata as { user_id: string }).user_id,
    ) as Record<string, string>
    expect(userId).toEqual({
      device_id: identity.deviceId,
      account_uuid: '11111111-2222-4333-8444-555555555555',
      session_id: identity.sessionId,
    })
  })

  test('sets the stream helper method only for streaming requests', () => {
    expect(
      applyClaudeCodeHeaders(new Headers(), 'sk-ant-oat-test', {
        body: { stream: true },
      }).get('x-stainless-helper-method'),
    ).toBe('stream')
    expect(
      applyClaudeCodeHeaders(new Headers(), 'sk-ant-oat-test', {
        body: { stream: false },
      }).get('x-stainless-helper-method'),
    ).toBeNull()
    expect(
      applyClaudeCodeHeaders(new Headers(), 'sk-ant-oat-test').get(
        'x-stainless-helper-method',
      ),
    ).toBeNull()
  })

  test('sets agent id headers only when ids are supplied', () => {
    const headers = applyClaudeCodeHeaders(new Headers(), 'sk-ant-oat-test', {
      agentId: 'ses_child',
      parentAgentId: 'ses_parent',
    })
    expect(headers.get('x-claude-code-agent-id')).toBe('ses_child')
    expect(headers.get('x-claude-code-parent-agent-id')).toBe('ses_parent')

    const bare = applyClaudeCodeHeaders(new Headers(), 'sk-ant-oat-test')
    expect(bare.get('x-claude-code-agent-id')).toBeNull()
    expect(bare.get('x-claude-code-parent-agent-id')).toBeNull()
  })

  test('forwards remote/container headers only when their env vars are set', () => {
    expect(
      applyClaudeCodeHeaders(new Headers(), 'sk-ant-oat-test').get(
        'x-claude-remote-container-id',
      ),
    ).toBeNull()

    process.env.CLAUDE_CODE_CONTAINER_ID = 'container-7'
    process.env.CLAUDE_CODE_REMOTE_SESSION_ID = 'remote-9'
    process.env.CLAUDE_AGENT_SDK_CLIENT_APP = 'sdk-app'
    process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION = 'on'
    try {
      const headers = applyClaudeCodeHeaders(new Headers(), 'sk-ant-oat-test')
      expect(headers.get('x-claude-remote-container-id')).toBe('container-7')
      expect(headers.get('x-claude-remote-session-id')).toBe('remote-9')
      expect(headers.get('x-client-app')).toBe('sdk-app')
      expect(headers.get('x-anthropic-additional-protection')).toBe('true')
    } finally {
      delete process.env.CLAUDE_CODE_CONTAINER_ID
      delete process.env.CLAUDE_CODE_REMOTE_SESSION_ID
      delete process.env.CLAUDE_AGENT_SDK_CLIENT_APP
      delete process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION
    }
  })

  test('ignores a falsy additional-protection flag', () => {
    process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION = 'false'
    try {
      expect(
        applyClaudeCodeHeaders(new Headers(), 'sk-ant-oat-test').get(
          'x-anthropic-additional-protection',
        ),
      ).toBeNull()
    } finally {
      delete process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION
    }
  })

  test('percent-encodes agent ids that are invalid in a header value', () => {
    const headers = applyClaudeCodeHeaders(new Headers(), 'sk-ant-oat-test', {
      agentId: 'ses_café\n',
    })
    expect(headers.get('x-claude-code-agent-id')).toBe('ses_caf%C3%A9%0A')
  })

  test('orders serialized body fields like captured Claude Code requests', () => {
    const ordered = orderClaudeCodeBody({
      stream: true,
      diagnostics: {},
      model: 'claude-sonnet-4-6',
      metadata: {},
      messages: [],
      max_tokens: 1024,
      system: [],
      tools: [],
      custom_tail: true,
    })

    expect(JSON.stringify(ordered)).toBe(
      '{"model":"claude-sonnet-4-6","messages":[],"system":[],"tools":[],"metadata":{},"max_tokens":1024,"diagnostics":{},"stream":true,"custom_tail":true}',
    )
  })
})

describe('Claude Code bootstrap identity lookup', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('matches the captured bootstrap request shape enough to resolve account UUID', async () => {
    const fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input.toString())
        expect(url.pathname).toBe('/api/claude_cli/bootstrap')
        expect(url.searchParams.get('entrypoint')).toBe('cli')
        expect(url.searchParams.get('model')).toBe('claude-sonnet-4-6')

        const headers = new Headers(init?.headers)
        expect(headers.get('user-agent')).toBe(
          `claude-code/${getCachedClaudeCodeVersion()}`,
        )
        expect(headers.get('anthropic-beta')).toBe('oauth-2025-04-20')
        expect(headers.get('content-type')).toBe('application/json')

        return new Response(
          JSON.stringify({
            oauth_account: {
              account_uuid: '11111111-2222-4333-8444-555555555555',
            },
          }),
        )
      },
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const identity = await resolveClaudeCodeIdentity(
      'sk-ant-oat-test-bootstrap',
      'claude-sonnet-4-6',
    )

    expect(identity.accountUuid).toBe('11111111-2222-4333-8444-555555555555')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('does not invent account UUID or metadata when bootstrap fails', async () => {
    const fetchMock = mock(async () => new Response('nope', { status: 503 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const identity = await resolveClaudeCodeIdentity(
      'sk-ant-oat-bootstrap-fails',
    )
    const body: Record<string, unknown> = {
      metadata: { user_id: 'stale-user-id', other: 'preserved' },
    }

    expect(identity.accountUuid).toBeUndefined()
    expect(applyClaudeCodeMetadata(body, identity)).toBe(false)
    expect(body.metadata).toEqual({ other: 'preserved' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('negative-caches failed bootstrap lookups briefly', async () => {
    const fetchMock = mock(async () => new Response('nope', { status: 503 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const first = await resolveClaudeCodeIdentity('sk-ant-oat-negative-cache')
    const second = await resolveClaudeCodeIdentity('sk-ant-oat-negative-cache')

    expect(first.accountUuid).toBeUndefined()
    expect(second.accountUuid).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('uses one installation device id across distinct accounts while keeping sessions separate', async () => {
    let calls = 0
    const fetchMock = mock(async () => {
      calls += 1
      return Response.json({
        oauth_account: {
          account_uuid:
            calls === 1
              ? '11111111-2222-4333-8444-555555555555'
              : 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        },
      })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const first = await resolveClaudeCodeIdentity('sk-ant-oat-global-device-a')
    const second = await resolveClaudeCodeIdentity('sk-ant-oat-global-device-b')
    expect(second.deviceId).toBe(first.deviceId)
    expect(second.sessionId).not.toBe(first.sessionId)
  })

  test('keeps identity stable across rotated access tokens for the same account UUID', async () => {
    const accountUuid = 'c7b3bc43-f4d8-48c6-a30f-7fd81a8db03f'
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({ oauth_account: { account_uuid: accountUuid } }),
        ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const first = await resolveClaudeCodeIdentity('sk-ant-oat-rotation-a')
    const second = await resolveClaudeCodeIdentity('sk-ant-oat-rotation-b')

    expect(first.accountUuid).toBe(accountUuid)
    expect(second.accountUuid).toBe(accountUuid)
    expect(second.deviceId).toBe(first.deviceId)
    expect(second.sessionId).toBe(first.sessionId)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
