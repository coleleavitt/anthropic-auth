import { describe, expect, test } from 'bun:test'

import {
  applyWifBearerAuth,
  createWifAuth,
  createWifTokenProvider,
  inspectWifEnvironment,
  resolveWifConfig,
  WIF_FEDERATION_BETA,
  WIF_GRANT_TYPE,
  type WifAccessToken,
  type WifEnvironment,
  WifError,
  WifTokenCache,
  type WifTokenProvider,
} from '../wif.ts'

const BASE_ENV: WifEnvironment = {
  ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_01test',
  ANTHROPIC_ORGANIZATION_ID: 'org_01test',
  ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_01test',
  ANTHROPIC_IDENTITY_TOKEN: 'header.payload.signature',
}

function tokenResponse(
  accessToken: string,
  expiresIn = 3_600,
  extra: Record<string, unknown> = {},
) {
  return Response.json({
    access_token: accessToken,
    expires_in: expiresIn,
    token_type: 'Bearer',
    ...extra,
  })
}

async function flushPromises() {
  for (let index = 0; index < 10; index++) await Promise.resolve()
}

describe('Anthropic WIF environment and wire contract', () => {
  test('sends the exact Claude 2.1.233 service-account JWT-bearer wire contract', async () => {
    let captured:
      | { url: string; init: RequestInit; body: Record<string, unknown> }
      | undefined
    const auth = createWifAuth({
      env: {
        ...BASE_ENV,
        ANTHROPIC_WORKSPACE_ID: 'wrkspc_01test',
      },
      now: () => 1_800_000_000_000,
      fetchImpl: (async (input, init = {}) => {
        captured = {
          url: String(input),
          init,
          body: JSON.parse(String(init.body)),
        }
        return tokenResponse('ant-wif-access')
      }) as typeof fetch,
    })

    expect(auth).not.toBeNull()
    expect(await auth?.getAccessToken()).toBe('ant-wif-access')
    expect(captured?.url).toBe('https://api.anthropic.com/v1/oauth/token')
    expect(captured?.init.method).toBe('POST')
    expect(captured?.body).toEqual({
      grant_type: WIF_GRANT_TYPE,
      assertion: 'header.payload.signature',
      federation_rule_id: 'fdrl_01test',
      organization_id: 'org_01test',
      service_account_id: 'svac_01test',
      workspace_id: 'wrkspc_01test',
    })

    const headers = new Headers(captured?.init.headers)
    expect(headers.get('anthropic-beta')).toBe(
      `oauth-2025-04-20,${WIF_FEDERATION_BETA}`,
    )
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('user-agent')).toBe(
      'anthropic-sdk-typescript/0.112.1 oidcFederationProvider',
    )
    expect(headers.has('authorization')).toBe(false)
    expect(headers.has('x-api-key')).toBe(false)
  })

  test('API key, auth token, and profile env presence shadow WIF even when empty', () => {
    for (const name of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_PROFILE',
    ] as const) {
      const env = { ...BASE_ENV, [name]: '' }
      expect(inspectWifEnvironment(env)).toEqual({
        type: 'shadowed',
        by: name,
      })
      expect(resolveWifConfig(env)).toBeNull()
      expect(createWifAuth({ env })).toBeNull()
    }
  })

  test('requires rule, organization, and identity while allowing organization-level federation', () => {
    const organizationLevel = inspectWifEnvironment({
      ANTHROPIC_FEDERATION_RULE_ID: 'fdrl',
      ANTHROPIC_ORGANIZATION_ID: 'org',
      ANTHROPIC_IDENTITY_TOKEN: 'jwt',
    })
    expect(organizationLevel.type).toBe('configured')
    if (organizationLevel.type === 'configured') {
      expect(organizationLevel.config.serviceAccountId).toBeUndefined()
    }

    expect(() =>
      inspectWifEnvironment({
        ANTHROPIC_FEDERATION_RULE_ID: 'fdrl',
        ANTHROPIC_ORGANIZATION_ID: 'org',
        ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac',
      }),
    ).toThrow('ANTHROPIC_IDENTITY_TOKEN_FILE or ANTHROPIC_IDENTITY_TOKEN')
  })

  test('rereads a file-backed projected identity token for every exchange', async () => {
    let projectedToken = 'projected-one'
    let reads = 0
    const assertions: string[] = []
    const config = resolveWifConfig({
      ...BASE_ENV,
      ANTHROPIC_IDENTITY_TOKEN: undefined,
      ANTHROPIC_IDENTITY_TOKEN_FILE: '/projected/token',
    })
    if (!config) throw new Error('expected WIF config')

    const provider = createWifTokenProvider(config, {
      filesystem: {
        readFile: async (path) => {
          expect(path).toBe('/projected/token')
          reads++
          return `  ${projectedToken}\n`
        },
      },
      now: () => 1_000,
      fetchImpl: (async (_input, init) => {
        assertions.push(
          (JSON.parse(String(init?.body)) as { assertion: string }).assertion,
        )
        return tokenResponse(`access-${assertions.length}`)
      }) as typeof fetch,
    })

    expect((await provider()).accessToken).toBe('access-1')
    projectedToken = 'projected-two'
    expect((await provider()).accessToken).toBe('access-2')
    expect(reads).toBe(2)
    expect(assertions).toEqual(['projected-one', 'projected-two'])
  })

  test('allows HTTP only for exact loopback hosts', async () => {
    expect(() =>
      resolveWifConfig({
        ...BASE_ENV,
        ANTHROPIC_BASE_URL: 'http://api.example.com',
      }),
    ).toThrow('non-HTTPS endpoint')

    const loopback = resolveWifConfig({
      ...BASE_ENV,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8080',
    })
    expect(loopback?.baseURL).toBe('http://127.0.0.1:8080')
  })
})

describe('WIF token cache', () => {
  test('uses fresh/advisory/mandatory windows and keeps a valid token on advisory failure', async () => {
    let now = 0
    let calls = 0
    const advisoryErrors: WifError[] = []
    const provider: WifTokenProvider = async () => {
      calls++
      if (calls === 1) {
        return { accessToken: 'token-one', expiresAt: 1_000_000 }
      }
      throw new Error('SECRET-ASSERTION refresh failure')
    }
    const cache = new WifTokenCache(provider, {
      now: () => now,
      onAdvisoryRefreshError: (error) => advisoryErrors.push(error),
    })

    expect(await cache.getAccessToken()).toBe('token-one')
    now = 800_000
    expect(await cache.getAccessToken()).toBe('token-one')
    expect(calls).toBe(1)

    now = 910_000
    expect(await cache.getAccessToken()).toBe('token-one')
    await flushPromises()
    expect(calls).toBe(2)
    expect(cache.peek()?.accessToken).toBe('token-one')
    expect(advisoryErrors).toHaveLength(1)
    expect(advisoryErrors[0]?.message).not.toContain('SECRET-ASSERTION')

    now = 975_000
    await expect(cache.getAccessToken()).rejects.toThrow(
      'WIF token refresh failed',
    )
    expect(calls).toBe(3)
  })

  test('coalesces concurrent initial and mandatory refreshes', async () => {
    let now = 0
    let calls = 0
    let resolveProvider: ((token: WifAccessToken) => void) | undefined
    const provider: WifTokenProvider = () => {
      calls++
      return new Promise((resolve) => {
        resolveProvider = resolve
      })
    }
    const cache = new WifTokenCache(provider, { now: () => now })

    const first = [
      cache.getAccessToken(),
      cache.getAccessToken(),
      cache.getAccessToken(),
    ]
    await flushPromises()
    expect(calls).toBe(1)
    resolveProvider?.({ accessToken: 'first', expiresAt: 100_000 })
    expect(await Promise.all(first)).toEqual(['first', 'first', 'first'])

    now = 80_000
    const mandatory = [cache.getAccessToken(), cache.getAccessToken()]
    await flushPromises()
    expect(calls).toBe(2)
    resolveProvider?.({ accessToken: 'second', expiresAt: 200_000 })
    expect(await Promise.all(mandatory)).toEqual(['second', 'second'])
  })
})

describe('WIF validation, redaction, and bearer headers', () => {
  test('never exposes assertions, access tokens, or arbitrary fetch errors', async () => {
    const secretAssertion = 'very-secret-assertion'
    const config = resolveWifConfig({
      ...BASE_ENV,
      ANTHROPIC_IDENTITY_TOKEN: secretAssertion,
    })
    if (!config) throw new Error('expected WIF config')

    const rejected = createWifTokenProvider(config, {
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            error: 'invalid_grant',
            assertion: secretAssertion,
            access_token: 'very-secret-access',
          }),
          { status: 400, headers: { 'request-id': 'req_safe' } },
        )) as unknown as typeof fetch,
    })
    let rejection: unknown
    try {
      await rejected()
    } catch (error) {
      rejection = error
    }
    expect(rejection).toBeInstanceOf(WifError)
    expect(String(rejection)).not.toContain(secretAssertion)
    expect(JSON.stringify(rejection)).not.toContain('very-secret-access')
    expect((rejection as WifError).requestId).toBe('req_safe')

    const network = createWifTokenProvider(config, {
      fetchImpl: (async () => {
        throw new Error(`network leaked ${secretAssertion}`)
      }) as unknown as typeof fetch,
    })
    await expect(network()).rejects.toThrow(
      'Failed to reach the Anthropic WIF token endpoint',
    )
    try {
      await network()
    } catch (error) {
      expect(String(error)).not.toContain(secretAssertion)
    }
  })

  test('rejects oversized or control-character credentials before fetch', async () => {
    expect(() =>
      resolveWifConfig({
        ...BASE_ENV,
        ANTHROPIC_IDENTITY_TOKEN: `part\u0000secret`,
      }),
    ).toThrow('control characters')
    expect(() =>
      resolveWifConfig({
        ...BASE_ENV,
        ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac-with-newline\n',
      }),
    ).toThrow('control characters')
    expect(() =>
      resolveWifConfig({
        ...BASE_ENV,
        ANTHROPIC_IDENTITY_TOKEN: 'x'.repeat(16 * 1024 + 1),
      }),
    ).toThrow('exceeds 16 KiB')
  })

  test('applies normal bearer auth without x-api-key or subscription OAuth beta', () => {
    const headers = new Headers({
      'x-api-key': 'remove-me',
      'anthropic-beta':
        'oauth-2025-04-20,feature-one-2026-01-01, oauth-2025-04-20',
      accept: 'application/json',
    })

    expect(applyWifBearerAuth(headers, 'wif-access')).toBe(headers)
    expect(headers.get('authorization')).toBe('Bearer wif-access')
    expect(headers.has('x-api-key')).toBe(false)
    expect(headers.get('anthropic-beta')).toBe('feature-one-2026-01-01')
    expect(headers.get('accept')).toBe('application/json')
  })
})
