import {
  type AnthropicOAuthOriginOptions,
  createAnthropicOAuthFetch,
  requireAnthropicOAuthOrigin,
} from '@cortexkit/anthropic-auth-core'

// Pi keeps its own refusal wording; Core supplies the origin rule itself.
const PI_OAUTH_ORIGIN: AnthropicOAuthOriginOptions = {
  refusal: (reason) =>
    new Error(
      reason === 'unparseable'
        ? 'Native OAuth requires the official Anthropic HTTPS origin'
        : 'Native OAuth requires the official Anthropic HTTPS origin without URL userinfo',
    ),
}

/** Model base URLs and remembered cache-warm URLs must send OAuth tokens only to Anthropic’s HTTPS server. */
export function requirePiOAuthOrigin(value: string): URL {
  return requireAnthropicOAuthOrigin(value, PI_OAUTH_ORIGIN)
}

export function buildPiOAuthMessagesUrl(baseUrl: string): URL {
  return new URL('/v1/messages?beta=true', requirePiOAuthOrigin(baseUrl))
}

/** Reject redirects rather than letting an approved OAuth destination forward the request. */
export const fetchPiOAuth: typeof fetch =
  createAnthropicOAuthFetch(PI_OAUTH_ORIGIN)
