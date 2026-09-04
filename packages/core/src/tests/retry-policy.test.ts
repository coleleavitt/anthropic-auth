import { describe, expect, test } from 'bun:test'

import {
  backoffDelayMs,
  classifyRateLimit,
  classifyRetry,
  DEFAULT_MAX_RETRIES,
  isLongContextCreditsRequiredError,
  nextRetryDelayMs,
  retryAfterMs,
} from '../retry-policy.ts'

function headers(entries: Record<string, string> = {}) {
  return new Headers(entries)
}

/** The live shape observed on a healthy account: claim headers present. */
const UNIFIED_CLAIM = {
  'anthropic-ratelimit-unified-representative-claim': 'seven_day',
  'anthropic-ratelimit-unified-overage-status': 'rejected',
}

describe('classifyRetry — statuses', () => {
  test('retries the transport statuses the CLI retries', () => {
    for (const status of [408, 409, 500, 502, 503, 504, 520, 529]) {
      expect(classifyRetry(status, headers()).retryable).toBe(true)
    }
  })

  test('does not retry client errors that will not change', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifyRetry(status, headers()).retryable).toBe(false)
    }
  })

  test('x-should-retry overrides the status in both directions', () => {
    expect(
      classifyRetry(400, headers({ 'x-should-retry': 'true' })).retryable,
    ).toBe(true)
    expect(
      classifyRetry(503, headers({ 'x-should-retry': 'false' })).retryable,
    ).toBe(false)
  })
})

describe('classifyRateLimit — hard vs soft 429', () => {
  test('an unattributed 429 is soft and retryable', () => {
    const body = JSON.stringify({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: "This request would exceed your account's rate limit.",
      },
    })
    expect(classifyRateLimit(headers(), body).hard).toBe(false)
    expect(classifyRetry(429, headers(), body).retryable).toBe(true)
  })

  test('out_of_credits without a unified claim is a hard limit', () => {
    const rateLimitHeaders = headers({
      'anthropic-ratelimit-unified-overage-disabled-reason': 'out_of_credits',
    })
    expect(classifyRateLimit(rateLimitHeaders).hard).toBe(true)
    const classified = classifyRetry(429, rateLimitHeaders)
    expect(classified.retryable).toBe(false)
    expect(classified.hardLimitReason).toBe('out_of_credits')
  })

  test('out_of_credits alongside a unified claim stays soft', () => {
    // The claim headers mean the server attributed the block to a plan window,
    // so the overage reason is context rather than the cause.
    const rateLimitHeaders = headers({
      ...UNIFIED_CLAIM,
      'anthropic-ratelimit-unified-overage-disabled-reason': 'out_of_credits',
    })
    expect(classifyRateLimit(rateLimitHeaders).hard).toBe(false)
    expect(classifyRetry(429, rateLimitHeaders).retryable).toBe(true)
  })

  test('org_spend_cap_reached is hard even with a unified claim', () => {
    const rateLimitHeaders = headers({
      ...UNIFIED_CLAIM,
      'anthropic-ratelimit-unified-overage-disabled-reason':
        'org_spend_cap_reached',
    })
    expect(classifyRateLimit(rateLimitHeaders).hard).toBe(true)
  })

  test('a credits-required body is hard regardless of claim headers', () => {
    const body = JSON.stringify({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'Usage credits are required to continue.',
      },
    })
    expect(classifyRateLimit(headers(UNIFIED_CLAIM), body).hard).toBe(true)
  })

  test('a credits-required body stays soft for a transient fetch_error', () => {
    const body = 'usage credits are required'
    const rateLimitHeaders = headers({
      'anthropic-ratelimit-unified-overage-disabled-reason': 'fetch_error',
    })
    expect(classifyRateLimit(rateLimitHeaders, body).hard).toBe(false)
  })

  test('an explicitly rejected unified status is hard', () => {
    // Regression: an exhausted account returns 429 with this header and no
    // overage reason. Treated as soft it was retried ten times with backoff,
    // each attempt re-running full routing — minutes of hanging before a
    // failure that was certain on the first response.
    const rateLimitHeaders = headers({
      'anthropic-ratelimit-unified-status': 'rejected',
    })
    expect(classifyRateLimit(rateLimitHeaders).hard).toBe(true)
    expect(classifyRetry(429, rateLimitHeaders).retryable).toBe(false)
  })

  test('an allowed_warning unified status stays soft', () => {
    const rateLimitHeaders = headers({
      'anthropic-ratelimit-unified-status': 'allowed_warning',
    })
    expect(classifyRateLimit(rateLimitHeaders).hard).toBe(false)
    expect(classifyRetry(429, rateLimitHeaders).retryable).toBe(true)
  })

  test('service_spend_limit_reached in the body is hard', () => {
    expect(
      classifyRateLimit(headers(), 'service_spend_limit_reached').hard,
    ).toBe(true)
  })

  test('an embedded overageDisabledReason on an exceeded_limit body is hard', () => {
    const body =
      '{"error":"exceeded_limit","overageDisabledReason":"out_of_credits"}'
    expect(classifyRateLimit(headers(), body).hard).toBe(true)
  })
})

describe('retryAfterMs', () => {
  test('prefers retry-after-ms over retry-after', () => {
    expect(
      retryAfterMs(headers({ 'retry-after-ms': '250', 'retry-after': '30' })),
    ).toBe(250)
  })

  test('reads retry-after as seconds', () => {
    expect(retryAfterMs(headers({ 'retry-after': '12' }))).toBe(12_000)
  })

  test('reads retry-after as an HTTP date', () => {
    const at = new Date(Date.now() + 5_000).toUTCString()
    const delay = retryAfterMs(headers({ 'retry-after': at }))
    expect(delay).toBeGreaterThan(3_000)
    expect(delay).toBeLessThanOrEqual(6_000)
  })

  test('is undefined when the server offers no pacing', () => {
    expect(retryAfterMs(headers())).toBeUndefined()
  })

  test('ignores a malformed retry-after rather than waiting forever', () => {
    expect(retryAfterMs(headers({ 'retry-after': 'soon' }))).toBeUndefined()
  })
})

describe('backoffDelayMs', () => {
  test('doubles per attempt and saturates at eight seconds', () => {
    const noJitter = () => 0
    expect(backoffDelayMs(0, noJitter)).toBe(500)
    expect(backoffDelayMs(1, noJitter)).toBe(1_000)
    expect(backoffDelayMs(2, noJitter)).toBe(2_000)
    expect(backoffDelayMs(4, noJitter)).toBe(8_000)
    expect(backoffDelayMs(10, noJitter)).toBe(8_000)
  })

  test('jitter only ever shortens the wait, by at most a quarter', () => {
    const fullJitter = () => 1
    expect(backoffDelayMs(1, fullJitter)).toBeCloseTo(750, 5)
    expect(backoffDelayMs(1, () => 0.5)).toBeCloseTo(875, 5)
  })

  test('nextRetryDelayMs lets the server override the backoff', () => {
    expect(nextRetryDelayMs(headers({ 'retry-after': '3' }), 5, () => 0)).toBe(
      3_000,
    )
    expect(nextRetryDelayMs(headers(), 0, () => 0)).toBe(500)
  })
})

test('the default retry budget matches the CLI', () => {
  expect(DEFAULT_MAX_RETRIES).toBe(10)
})

describe('isLongContextCreditsRequiredError', () => {
  test('matches only the native long-context 429 messages', () => {
    for (const message of [
      'Extra usage is required for long context',
      'Usage credits are required for long context requests.',
    ]) {
      expect(isLongContextCreditsRequiredError(429, message)).toBe(true)
    }
  })

  test('does not conflate general extra-usage errors with the 1M latch', () => {
    expect(
      isLongContextCreditsRequiredError(429, "You're out of extra usage"),
    ).toBe(false)
    expect(
      isLongContextCreditsRequiredError(
        429,
        '{"error":{"details":{"error_code":"credits_required"}}}',
      ),
    ).toBe(false)
  })

  test('ignores the long-context message on non-native statuses', () => {
    expect(
      isLongContextCreditsRequiredError(
        400,
        'Usage credits are required for long context',
      ),
    ).toBe(false)
    expect(isLongContextCreditsRequiredError(200, '')).toBe(false)
  })
})
