import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import {
  AXIOS_USER_AGENT,
  authorize,
  CLIENT_ID,
  ClaudeOAuthRefreshError,
  ClaudeOAuthRefreshTokenExpiredError,
  CODE_CALLBACK_URL,
  exchange,
  OAUTH_SCOPES,
  REFRESH_SCOPE,
  REVOKE_URL,
  refreshClaudeOAuthToken,
  revokeClaudeOAuthToken,
  TOKEN_URL,
} from '@cortexkit/anthropic-auth-core'

const originalSetTimeout = globalThis.setTimeout
const originalOAuthClientId = process.env.CLAUDE_CODE_OAUTH_CLIENT_ID

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout
  if (originalOAuthClientId === undefined) {
    delete process.env.CLAUDE_CODE_OAUTH_CLIENT_ID
  } else {
    process.env.CLAUDE_CODE_OAUTH_CLIENT_ID = originalOAuthClientId
  }
  mock.restore()
})

describe('authorize', () => {
  test('returns the hosted callback URL for max mode', async () => {
    const result = await authorize('max')

    expect(result.url).toBeString()
    expect(result.redirectUri).toBe(CODE_CALLBACK_URL)
    expect(result.verifier).toBeString()

    const url = new URL(result.url)
    expect(url.origin).toBe('https://claude.com')
    expect(url.pathname).toBe('/cai/oauth/authorize')
    expect(url.searchParams.get('redirect_uri')).toBe(CODE_CALLBACK_URL)
  })

  test('returns the hosted callback URL for console mode', async () => {
    const result = await authorize('console')

    const url = new URL(result.url)
    expect(url.origin).toBe('https://platform.claude.com')
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('redirect_uri')).toBe(CODE_CALLBACK_URL)
  })

  test('sets required OAuth query params', async () => {
    const result = await authorize('max')
    const url = new URL(result.url)

    expect(url.searchParams.get('code')).toBe('true')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe(CODE_CALLBACK_URL)
    expect(url.searchParams.get('scope')).toBe(OAUTH_SCOPES.join(' '))
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe(result.state)
    expect(result.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test('honors the Claude Code OAuth client id override', async () => {
    process.env.CLAUDE_CODE_OAUTH_CLIENT_ID = 'custom-client-id'
    const result = await authorize('max')
    expect(new URL(result.url).searchParams.get('client_id')).toBe(
      'custom-client-id',
    )
  })

  test('binds a caller-provided loopback redirect into the authorization URL', async () => {
    const redirectUri = 'http://localhost:45678/callback'
    const result = await authorize('max', { redirectUri })
    expect(result.redirectUri).toBe(redirectUri)
    expect(new URL(result.url).searchParams.get('redirect_uri')).toBe(
      redirectUri,
    )
  })

  test('does not use localhost by default', async () => {
    const result = await authorize('max')
    expect(result.redirectUri).not.toContain('localhost')
    expect(result.url).not.toContain('localhost')
  })

  test('supports organization and login-hint routing params', async () => {
    const result = await authorize('max', {
      orgUUID: 'org-123',
      loginHint: 'me@example.com',
      loginMethod: 'sso',
    })
    const url = new URL(result.url)
    expect(url.searchParams.get('orgUUID')).toBe('org-123')
    expect(url.searchParams.get('login_hint')).toBe('me@example.com')
    expect(url.searchParams.get('login_method')).toBe('sso')
  })
})

describe('exchange', () => {
  test('accepts code#state format', async () => {
    let capturedBody: string | undefined

    spyOn(globalThis, 'fetch').mockImplementation(((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBody = init?.body as string
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'r',
            access_token: 'a',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as typeof fetch)

    const result = await exchange(
      'mycode#mystate',
      'myverifier',
      CODE_CALLBACK_URL,
      'mystate',
    )

    expect(result.type).toBe('success')
    const body = JSON.parse(capturedBody!)
    expect(body.code).toBe('mycode')
    expect(body.state).toBe('mystate')
    expect(body.redirect_uri).toBe(CODE_CALLBACK_URL)
  })

  test('returns account, organization, and granted-scope metadata', async () => {
    spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.resolve(
        Response.json({
          refresh_token: 'r',
          access_token: 'a',
          expires_in: 3600,
          refresh_token_expires_in: 7200,
          scope: 'user:profile user:inference',
          account: { uuid: 'account-1', email_address: 'me@example.com' },
          organization: { uuid: 'org-1' },
        }),
      )) as unknown as typeof fetch)

    const result = await exchange(
      'mycode#mystate',
      'myverifier',
      CODE_CALLBACK_URL,
      'mystate',
    )

    expect(result).toMatchObject({
      type: 'success',
      refreshTokenExpiresAt: expect.any(Number),
      scopes: ['user:profile', 'user:inference'],
      accountId: 'account-1',
      email: 'me@example.com',
      organizationId: 'org-1',
    })
  })

  test('accepts a full callback URL', async () => {
    let capturedBody: string | undefined

    spyOn(globalThis, 'fetch').mockImplementation(((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBody = init?.body as string
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'r',
            access_token: 'a',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as typeof fetch)

    await exchange(
      'https://platform.claude.com/oauth/code/callback?code=mycode&state=mystate',
      'myverifier',
      CODE_CALLBACK_URL,
      'mystate',
    )

    const body = JSON.parse(capturedBody!)
    expect(body.code).toBe('mycode')
    expect(body.state).toBe('mystate')
  })

  test('returns failed on invalid callback input', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.resolve(new Response(null))) as unknown as typeof fetch)

    const result = await exchange(
      'not-a-callback',
      'verifier',
      CODE_CALLBACK_URL,
    )
    expect(result.type).toBe('failed')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('returns failed on state mismatch', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.resolve(new Response(null))) as unknown as typeof fetch)

    const result = await exchange(
      'code#wrong',
      'verifier',
      CODE_CALLBACK_URL,
      'expected',
    )
    expect(result.type).toBe('failed')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('rejects malformed token responses during initial exchange', async () => {
    spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.resolve(
        Response.json({
          refresh_token: '',
          access_token: 'a',
          expires_in: 3600,
        }),
      )) as unknown as typeof fetch)

    const result = await exchange(
      'mycode#mystate',
      'myverifier',
      CODE_CALLBACK_URL,
      'mystate',
    )
    expect(result.type).toBe('failed')
  })
})

describe('refreshClaudeOAuthToken', () => {
  test('uses Anthropic platform JSON refresh path and preserves omitted refresh rotations', async () => {
    let capturedUrl: string | undefined
    let capturedBody: string | undefined
    let capturedHeaders: Headers | undefined

    const result = await refreshClaudeOAuthToken({
      refreshToken: 'old-refresh',
      authLineageId: 'stable-lineage',
      now: () => 1_000,
      fetchImpl: mock((input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input)
        capturedBody = String(init?.body)
        capturedHeaders = new Headers(init?.headers)
        return Promise.resolve(
          new Response(
            JSON.stringify({ access_token: 'new-access', expires_in: 3600 }),
            { status: 200 },
          ),
        )
      }) as unknown as typeof fetch,
    })

    expect(capturedUrl).toBe(TOKEN_URL)
    expect(capturedUrl).toBe('https://platform.claude.com/v1/oauth/token')
    expect(capturedHeaders?.get('content-type')).toBe('application/json')
    expect(capturedHeaders?.get('accept')).toBe(
      'application/json, text/plain, */*',
    )
    expect(capturedHeaders?.get('user-agent')).toBe(AXIOS_USER_AGENT)
    expect(capturedHeaders?.get('user-agent')).toBe('axios/1.15.2')
    const body = JSON.parse(capturedBody ?? '{}')
    expect(body.grant_type).toBe('refresh_token')
    expect(body.refresh_token).toBe('old-refresh')
    expect(body.client_id).toBe(CLIENT_ID)
    expect(body.scope).toBe(REFRESH_SCOPE)
    expect(body.scope).toBe(
      'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
    )
    expect(result).toEqual({
      access: 'new-access',
      refresh: 'old-refresh',
      expires: 3_601_000,
      expiresIn: 3600,
      authLineageId: 'stable-lineage',
    })
  })

  test('preserves current refresh response metadata and refresh-token expiry', async () => {
    const result = await refreshClaudeOAuthToken({
      refreshToken: 'old-refresh',
      now: () => 1_000,
      fetchImpl: mock(() =>
        Promise.resolve(
          Response.json({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600,
            refresh_token_expires_in: 7200,
            scope: 'user:profile user:inference',
            account: { uuid: 'account-1', email_address: 'me@example.com' },
            organization: { uuid: 'org-1' },
          }),
        ),
      ) as unknown as typeof fetch,
    })

    expect(result).toEqual({
      access: 'new-access',
      refresh: 'new-refresh',
      expires: 3_601_000,
      expiresIn: 3600,
      refreshTokenExpiresAt: 7_201_000,
      scopes: ['user:profile', 'user:inference'],
      accountId: 'account-1',
      email: 'me@example.com',
      organizationId: 'org-1',
    })
  })

  test('preserves a known refresh-token expiry when the server omits it', async () => {
    const result = await refreshClaudeOAuthToken({
      refreshToken: 'old-refresh',
      refreshTokenExpiresAt: 9_999_000,
      now: () => 1_000,
      fetchImpl: mock(() =>
        Promise.resolve(
          Response.json({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600,
          }),
        ),
      ) as unknown as typeof fetch,
    })
    expect(result.refreshTokenExpiresAt).toBe(9_999_000)
  })

  test('fails expired refresh tokens locally without contacting the endpoint', async () => {
    const fetchImpl = mock(() => Promise.reject(new Error('must not fetch')))
    await expect(
      refreshClaudeOAuthToken({
        refreshToken: 'expired-refresh',
        refreshTokenExpiresAt: 999,
        now: () => 1_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(ClaudeOAuthRefreshTokenExpiredError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('retries transient OAuth refresh failures in the shared helper', async () => {
    let calls = 0
    const setTimeoutMock = mock((handler: () => unknown) => {
      handler()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    const result = await refreshClaudeOAuthToken({
      refreshToken: 'old-refresh',
      baseDelayMs: 25,
      setTimeoutImpl: setTimeoutMock,
      fetchImpl: mock(() => {
        calls += 1
        if (calls === 1) {
          return Promise.resolve(new Response('temporary', { status: 500 }))
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'new-access',
              refresh_token: 'new-refresh',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }) as unknown as typeof fetch,
    })

    expect(calls).toBe(2)
    expect(setTimeoutMock).toHaveBeenCalledWith(expect.any(Function), 25)
    expect(result.refresh).toBe('new-refresh')
  })

  test('does not retry OAuth refresh rate limits or invalid grants', async () => {
    for (const status of [400, 429]) {
      let calls = 0
      await expect(
        refreshClaudeOAuthToken({
          refreshToken: 'old-refresh',
          fetchImpl: mock(() => {
            calls += 1
            return Promise.resolve(
              new Response(
                status === 400
                  ? JSON.stringify({ error: 'invalid_grant' })
                  : JSON.stringify({
                      error: {
                        type: 'rate_limit_error',
                        message: 'Rate limited',
                      },
                    }),
                { status },
              ),
            )
          }) as unknown as typeof fetch,
        }),
      ).rejects.toThrow(`Claude OAuth refresh failed: ${status}`)
      expect(calls).toBe(1)
    }
  })
})

describe('refresh timeout', () => {
  test('aborts the entire refresh operation within its configured deadline', async () => {
    let signal: AbortSignal | undefined
    const refresh = refreshClaudeOAuthToken({
      refreshToken: 'old-refresh',
      timeoutMs: 5,
      fetchImpl: mock((_input: string | URL | Request, init?: RequestInit) => {
        signal = init?.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal?.reason), {
            once: true,
          })
        })
      }) as unknown as typeof fetch,
    })
    await expect(refresh).rejects.toThrow()
    expect(signal?.aborted).toBe(true)
  })

  test('honors caller cancellation before the token endpoint settles', async () => {
    const caller = new AbortController()
    let signal: AbortSignal | undefined
    const refresh = refreshClaudeOAuthToken({
      refreshToken: 'old-refresh',
      signal: caller.signal,
      timeoutMs: 1_000,
      fetchImpl: mock((_input: string | URL | Request, init?: RequestInit) => {
        signal = init?.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal?.reason), {
            once: true,
          })
        })
      }) as unknown as typeof fetch,
    })
    caller.abort(new Error('caller stopped'))
    await expect(refresh).rejects.toThrow('caller stopped')
    expect(signal?.aborted).toBe(true)
  })
})

describe('retry-after-ms handling', () => {
  test('prefers retry-after-ms for refresh and revoke failures', async () => {
    const refresh = refreshClaudeOAuthToken({
      refreshToken: 'old-refresh',
      fetchImpl: mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'rate_limited' }), {
            status: 429,
            headers: { 'retry-after-ms': '1500', 'retry-after': '30' },
          }),
        ),
      ) as unknown as typeof fetch,
    })
    await expect(refresh).rejects.toMatchObject({ retryAfter: 2 })

    const revoke = revokeClaudeOAuthToken({
      refreshToken: 'old-refresh',
      fetchImpl: mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'rate_limited' }), {
            status: 429,
            headers: { 'retry-after-ms': '1500', 'retry-after': '30' },
          }),
        ),
      ) as unknown as typeof fetch,
    })
    await expect(revoke).rejects.toMatchObject({ retryAfter: 2 })
  })
})

describe('revokeClaudeOAuthToken', () => {
  test('posts the exact native revocation request', async () => {
    let capturedUrl = ''
    let capturedBody = ''
    let capturedHeaders = new Headers()
    const outcome = await revokeClaudeOAuthToken({
      refreshToken: 'old-refresh',
      fetchImpl: mock((input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input)
        capturedBody = String(init?.body)
        capturedHeaders = new Headers(init?.headers)
        return Promise.resolve(Response.json({}))
      }) as unknown as typeof fetch,
    })
    expect(outcome).toBe('revoked')
    expect(capturedUrl).toBe(REVOKE_URL)
    expect(capturedHeaders.get('user-agent')).toBe(AXIOS_USER_AGENT)
    expect(JSON.parse(capturedBody)).toEqual({
      token: 'old-refresh',
      token_type_hint: 'refresh_token',
      client_id: CLIENT_ID,
    })
  })

  test('treats invalid_grant as already inactive', async () => {
    await expect(
      revokeClaudeOAuthToken({
        refreshToken: 'old-refresh',
        fetchImpl: mock(() =>
          Promise.resolve(
            Response.json({ error: 'invalid_grant' }, { status: 400 }),
          ),
        ) as unknown as typeof fetch,
      }),
    ).resolves.toBe('already-inactive')
  })

  test('redacts a token echoed by an error response', async () => {
    const secret = 'sk-ant-ort01-super-secret-refresh-value'
    await expect(
      revokeClaudeOAuthToken({
        refreshToken: secret,
        fetchImpl: mock(() =>
          Promise.resolve(new Response(`failure ${secret}`, { status: 500 })),
        ) as unknown as typeof fetch,
      }),
    ).rejects.not.toThrow(secret)
  })
})

describe('ClaudeOAuthRefreshError', () => {
  test('captures Retry-After header as seconds', () => {
    const error = new ClaudeOAuthRefreshError(429, 'rate limited', '60')
    expect(error.retryAfter).toBe(60)
  })

  test('captures Retry-After header as HTTP date', () => {
    const futureDate = new Date(Date.now() + 120_000).toUTCString()
    const error = new ClaudeOAuthRefreshError(429, 'rate limited', futureDate)
    expect(error.retryAfter).toBeGreaterThan(0)
    expect(error.retryAfter).toBeLessThanOrEqual(121)
  })

  test('retryAfter is undefined when header missing', () => {
    const error = new ClaudeOAuthRefreshError(429, 'rate limited')
    expect(error.retryAfter).toBeUndefined()
  })

  test('retryAfter is undefined for non-parseable values', () => {
    const error = new ClaudeOAuthRefreshError(429, 'rate limited', 'garbage')
    expect(error.retryAfter).toBeUndefined()
  })
})
