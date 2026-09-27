import type { OAuthAccountProfile, ProviderAccountUuid } from './accounts.ts'
import { assertNotCustodyTombstone } from './claustrum.ts'

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'

export const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export async function fetchOAuthAccountProfile(input: {
  accessToken: string
  accountIdentity?: string
  providerAccountUuid?: ProviderAccountUuid
  fetchImpl?: typeof fetch
  now?: () => number
  signal?: AbortSignal
}): Promise<OAuthAccountProfile> {
  // The bearer value is guarded where it becomes a header, like every other builder.
  assertNotCustodyTombstone(input.accessToken, 'anthropic')
  const response = await (input.fetchImpl ?? fetch)(PROFILE_URL, {
    method: 'GET',
    signal: input.signal,
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      Accept: 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
    },
  })
  if (!response.ok) {
    throw new Error(`Claude profile check failed: ${response.status}`)
  }
  const value = (await response.json()) as {
    organization?: {
      organization_type?: unknown
      rate_limit_tier?: unknown
    }
  }
  const tier = value.organization?.rate_limit_tier
  const orgType = value.organization?.organization_type
  if (
    typeof tier !== 'string' ||
    tier.trim() === '' ||
    typeof orgType !== 'string' ||
    orgType.trim() === ''
  ) {
    throw new Error('Claude profile response is missing account metadata')
  }
  return {
    tier,
    orgType,
    checkedAt: input.now?.() ?? Date.now(),
    ...(input.accountIdentity !== undefined && {
      accountIdentity: input.accountIdentity,
    }),
    ...(input.providerAccountUuid !== undefined && {
      providerAccountUuid: input.providerAccountUuid,
    }),
  }
}

export function oauthProfileMatchesIdentity(
  profile: OAuthAccountProfile | undefined,
  accountIdentity: string | undefined,
) {
  if (!profile) return false
  if (accountIdentity === undefined) return true
  return (
    profile.accountIdentity === undefined ||
    profile.accountIdentity === accountIdentity
  )
}

export function oauthProfileIsFresh(
  profile: OAuthAccountProfile | undefined,
  now = Date.now(),
) {
  return Boolean(
    profile &&
      Number.isFinite(profile.checkedAt) &&
      now >= profile.checkedAt &&
      now - profile.checkedAt < PROFILE_TTL_MS,
  )
}

export function formatOAuthAccountTier(
  profile: OAuthAccountProfile | undefined,
): string | undefined {
  const match = profile?.tier.match(/^default_claude_max_(\d+)x$/)
  if (!match) return undefined
  const label = `Max ${match[1]}x`
  return profile?.orgType === 'claude_team' ? `Team · ${label}` : label
}

/**
 * Who a token belongs to, as reported by Anthropic rather than inferred from
 * the grant.
 *
 * The token response only carries `account.email_address` when the grant
 * happens to include it; this endpoint always does. Deriving the account
 * identity from the API is what lets a login name itself, and lets a re-login
 * collapse onto the row it supersedes instead of adding a duplicate.
 */
export type OAuthAccountIdentity = {
  accountUuid?: string
  email?: string
  displayName?: string
  organizationUuid?: string
  organizationName?: string
  organizationType?: string
  rateLimitTier?: string
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Read the signed-in identity for `accessToken`.
 *
 * Resolves to an empty identity rather than throwing on a transport or shape
 * failure: naming an account is a convenience, and a login that already holds
 * a valid credential must not be discarded because this lookup failed.
 */
export async function fetchOAuthAccountIdentity(input: {
  accessToken: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}): Promise<OAuthAccountIdentity> {
  try {
    const response = await (input.fetchImpl ?? fetch)(PROFILE_URL, {
      method: 'GET',
      signal: input.signal,
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        Accept: 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
      },
    })
    if (!response.ok) return {}
    const value = (await response.json()) as {
      account?: Record<string, unknown>
      organization?: Record<string, unknown>
    }
    return {
      ...(optionalText(value.account?.uuid) && {
        accountUuid: optionalText(value.account?.uuid),
      }),
      ...(optionalText(value.account?.email) && {
        email: optionalText(value.account?.email),
      }),
      ...(optionalText(value.account?.display_name) && {
        displayName: optionalText(value.account?.display_name),
      }),
      ...(optionalText(value.organization?.uuid) && {
        organizationUuid: optionalText(value.organization?.uuid),
      }),
      ...(optionalText(value.organization?.name) && {
        organizationName: optionalText(value.organization?.name),
      }),
      ...(optionalText(value.organization?.organization_type) && {
        organizationType: optionalText(value.organization?.organization_type),
      }),
      ...(optionalText(value.organization?.rate_limit_tier) && {
        rateLimitTier: optionalText(value.organization?.rate_limit_tier),
      }),
    }
  } catch {
    return {}
  }
}
