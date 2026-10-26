import {
  type AnthropicOAuthOriginOptions,
  createAnthropicOAuthFetch,
  logger,
  requireAnthropicOAuthOrigin,
} from '@cortexkit/anthropic-auth-core'

/**
 * Test-only escape hatch for the OAuth destination rule.
 *
 * End-to-end suites run a real OpenCode process against a local mock of the
 * Anthropic API, so they need OAuth sends to reach a loopback server. Setting
 * this variable to that server's exact origin (for example
 * `http://127.0.0.1:43123`) allows it in addition to api.anthropic.com. Only
 * an `http://` or `https://` origin on 127.0.0.1, [::1] or localhost, with an
 * explicit port and no user name, password, path, query or fragment, is
 * accepted; any other value is ignored, so OAuth stays limited to
 * api.anthropic.com. ANTHROPIC_BASE_URL never widens the rule. It is not a
 * user setting and is deliberately left out of the public documentation.
 */
export const TEST_OAUTH_LOOPBACK_ORIGIN_ENV =
  'ANTHROPIC_AUTH_TEST_OAUTH_LOOPBACK_ORIGIN'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])

let warnedValue: string | undefined

/** The accepted loopback origin from TEST_OAUTH_LOOPBACK_ORIGIN_ENV, if any. */
export function testOAuthLoopbackOrigin(): string | undefined {
  const raw = process.env[TEST_OAUTH_LOOPBACK_ORIGIN_ENV]
  if (!raw) return undefined
  const accepted = parseLoopbackOrigin(raw)
  // Warn once per distinct value so the hatch is never silently active.
  if (warnedValue !== raw) {
    warnedValue = raw
    if (accepted)
      logger.warn(
        'oauth-destination',
        'test-only loopback origin is allowed for Claude OAuth requests',
        { env: TEST_OAUTH_LOOPBACK_ORIGIN_ENV },
      )
    else
      logger.warn(
        'oauth-destination',
        'ignored an invalid test-only loopback origin; Claude OAuth requests stay limited to https://api.anthropic.com',
        { env: TEST_OAUTH_LOOPBACK_ORIGIN_ENV },
      )
  }
  return accepted
}

function parseLoopbackOrigin(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username || url.password || url.search || url.hash) return undefined
  if (!LOOPBACK_HOSTS.has(url.hostname)) return undefined
  // An explicit port only: `url.port` is empty when none (or the default) is given.
  if (!url.port) return undefined
  // The value must be the bare origin; a path, even "/", is refused.
  if (raw !== url.origin) return undefined
  return url.origin
}

function originOptions(): AnthropicOAuthOriginOptions {
  const extraOrigin = testOAuthLoopbackOrigin()
  return extraOrigin ? { extraOrigin } : {}
}

/**
 * Throws AnthropicOAuthOriginError unless an OAuth token may be sent to
 * `url`. Call it with the final URL, after rewriteUrl has applied any
 * ANTHROPIC_BASE_URL or provider baseURL, so neither can redirect a token.
 */
export function requireOAuthDestination(url: string): URL {
  return requireAnthropicOAuthOrigin(url, originOptions())
}

/** True when an OAuth token may be sent to `url`. */
export function isAllowedOAuthDestination(url: string): boolean {
  try {
    requireOAuthDestination(url)
    return true
  } catch {
    return false
  }
}

/**
 * Fetch for OAuth sends: rechecks the destination on every call and refuses
 * redirects.
 */
export const fetchOAuth: typeof fetch = createAnthropicOAuthFetch(originOptions)
