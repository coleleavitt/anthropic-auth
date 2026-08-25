import { describe, expect, test } from 'bun:test'

import { fetchOAuthAccountIdentity } from '../oauth-profile.ts'

/** The shape the live endpoint returns, trimmed to the fields we read. */
const PROFILE = {
  account: {
    uuid: '364d55bc-abfb-4ff2-b3c4-630bbbbe6ef8',
    display_name: 'Cole',
    email: 'cole@unwrap.rs',
  },
  organization: {
    uuid: '38720c59-b1e1-459b-b88d-54a6b5c9ba93',
    name: "cole@unwrap.rs's Organization",
    organization_type: 'claude_max',
    rate_limit_tier: 'default_claude_max_20x',
  },
}

function jsonFetch(body: unknown, status = 200) {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

describe('fetchOAuthAccountIdentity', () => {
  test('reads the signed-in identity from the profile endpoint', async () => {
    const identity = await fetchOAuthAccountIdentity({
      accessToken: 'sk-ant-oat01-token',
      fetchImpl: jsonFetch(PROFILE),
    })

    expect(identity).toEqual({
      accountUuid: '364d55bc-abfb-4ff2-b3c4-630bbbbe6ef8',
      email: 'cole@unwrap.rs',
      displayName: 'Cole',
      organizationUuid: '38720c59-b1e1-459b-b88d-54a6b5c9ba93',
      organizationName: "cole@unwrap.rs's Organization",
      organizationType: 'claude_max',
      rateLimitTier: 'default_claude_max_20x',
    })
  })

  test('sends the OAuth bearer and beta header', async () => {
    let seen: Headers | undefined
    await fetchOAuthAccountIdentity({
      accessToken: 'sk-ant-oat01-token',
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        seen = new Headers(init?.headers)
        return new Response(JSON.stringify(PROFILE), { status: 200 })
      }) as unknown as typeof fetch,
    })

    expect(seen?.get('authorization')).toBe('Bearer sk-ant-oat01-token')
    expect(seen?.get('anthropic-beta')).toBe('oauth-2025-04-20')
  })

  test('resolves empty rather than throwing on a non-OK response', async () => {
    // Naming an account is a convenience; a login holding a valid credential
    // must not be discarded because this lookup failed.
    expect(
      await fetchOAuthAccountIdentity({
        accessToken: 'sk-ant-oat01-token',
        fetchImpl: jsonFetch({}, 403),
      }),
    ).toEqual({})
  })

  test('resolves empty rather than throwing on a transport failure', async () => {
    expect(
      await fetchOAuthAccountIdentity({
        accessToken: 'sk-ant-oat01-token',
        fetchImpl: (async () => {
          throw new Error('ECONNRESET')
        }) as unknown as typeof fetch,
      }),
    ).toEqual({})
  })

  test('omits fields the profile leaves blank instead of storing empties', async () => {
    const identity = await fetchOAuthAccountIdentity({
      accessToken: 'sk-ant-oat01-token',
      fetchImpl: jsonFetch({
        account: { uuid: 'acct-uuid', email: '   ' },
        organization: {},
      }),
    })

    expect(identity).toEqual({ accountUuid: 'acct-uuid' })
  })
})
