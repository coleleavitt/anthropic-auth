import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import {
  authorize,
  CLIENT_ID,
  CODE_CALLBACK_URL,
  exchange,
  OAUTH_SCOPES,
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
