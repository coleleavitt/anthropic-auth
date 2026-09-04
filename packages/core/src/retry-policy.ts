/**
 * Transport retry policy, ported from Claude Code 2.1.241.
 *
 * The official CLI retries 408/409/429/5xx, honouring `retry-after-ms` then
 * `retry-after` and otherwise backing off exponentially. The important part is
 * not the retry itself but the split it makes between a *soft* 429 — transient
 * pressure that clears on its own — and a *hard* 429, where the account has no
 * billing headroom left and every retry is guaranteed to fail the same way.
 *
 * A router treats the two differently: a soft 429 is worth waiting out on the
 * same account, a hard one must rotate or surface immediately.
 */

/** Matches the CLI's default (`btw`); it clamps user overrides to 15. */
export const DEFAULT_MAX_RETRIES = 10

const BASE_BACKOFF_SECONDS = 0.5
const MAX_BACKOFF_SECONDS = 8
const JITTER_RATIO = 0.25

const OVERAGE_DISABLED_REASON_HEADER =
  'anthropic-ratelimit-unified-overage-disabled-reason'
const REPRESENTATIVE_CLAIM_HEADER =
  'anthropic-ratelimit-unified-representative-claim'
const OVERAGE_STATUS_HEADER = 'anthropic-ratelimit-unified-overage-status'
const UNIFIED_STATUS_HEADER = 'anthropic-ratelimit-unified-status'

/**
 * Overage reasons that make a 429 permanent even when the response still
 * carries unified claim headers (the CLI's `G9f`).
 */
const UNCONDITIONAL_HARD_REASONS: ReadonlySet<string> = new Set([
  'org_spend_cap_reached',
  'org_level_disabled_until',
])

/**
 * Overage reasons that make a 429 permanent only when the response carries no
 * unified claim headers to contradict them (the CLI's `$9f`).
 */
const HARD_REASONS: ReadonlySet<string> = new Set([
  ...UNCONDITIONAL_HARD_REASONS,
  'out_of_credits',
  'org_level_disabled',
  'org_service_level_disabled',
])

/** Reasons the CLI explicitly keeps retryable despite a credits-required body. */
const SOFT_CREDIT_REASONS: ReadonlySet<string> = new Set([
  'fetch_error',
  'org_level_disabled_until',
])

const OVERAGE_DISABLED_REASON_PATTERN =
  /\\?"overageDisabledReason\\?":\s*\\?"([a-z_]+)\\?"/

export type RetryClassification = {
  retryable: boolean
  /** Present when a 429 is permanent for this billing period. */
  hardLimitReason?: string
}

function headerValue(headers: Headers, name: string) {
  return headers.get(name)?.trim() || undefined
}

/**
 * True when the response carries a unified claim, meaning the server described
 * which limit is binding rather than leaving it unattributed (the CLI's `mWn`).
 */
function hasUnifiedClaim(headers: Headers) {
  return Boolean(
    headerValue(headers, REPRESENTATIVE_CLAIM_HEADER) ||
      headerValue(headers, OVERAGE_STATUS_HEADER),
  )
}

/**
 * Classify a 429 as permanent (hard) or transient (soft), mirroring the CLI's
 * `Utw` plus its `credits_required` pre-check. `body` is the response text when
 * it has already been read; omitting it only loses body-derived signals.
 */
export function classifyRateLimit(
  headers: Headers,
  body = '',
): { hard: boolean; reason?: string } {
  const reason = headerValue(headers, OVERAGE_DISABLED_REASON_HEADER)
  const lowered = body.toLowerCase()

  if (
    lowered.includes('"credits_required"') ||
    lowered.includes('usage credits are required') ||
    lowered.includes('extra usage is required')
  ) {
    if (!reason || !SOFT_CREDIT_REASONS.has(reason)) {
      return { hard: true, reason: reason ?? 'credits_required' }
    }
  }

  if (body.includes('service_spend_limit_reached')) {
    return { hard: true, reason: 'service_spend_limit_reached' }
  }

  if (reason) {
    if (UNCONDITIONAL_HARD_REASONS.has(reason)) return { hard: true, reason }
    if (!hasUnifiedClaim(headers) && HARD_REASONS.has(reason)) {
      return { hard: true, reason }
    }
  }

  // An explicit `rejected` verdict is the server stating the account has no
  // headroom in the binding window. Retrying that is guaranteed to fail, and
  // ten backed-off attempts turn a fast failure into minutes of hanging — the
  // caller should rotate or surface the limit instead.
  if (headerValue(headers, UNIFIED_STATUS_HEADER) === 'rejected') {
    return { hard: true, reason: 'unified_status_rejected' }
  }

  if (body.includes('exceeded_limit')) {
    const matched = OVERAGE_DISABLED_REASON_PATTERN.exec(body)?.[1]
    if (matched && HARD_REASONS.has(matched)) {
      return { hard: true, reason: matched }
    }
  }

  return { hard: false, ...(reason ? { reason } : {}) }
}

/**
 * Decide whether a response is worth re-sending. `x-should-retry` wins outright
 * in both directions, matching the CLI and letting the server end a retry loop
 * it knows is pointless.
 */
export function classifyRetry(
  status: number,
  headers: Headers,
  body = '',
): RetryClassification {
  const directive = headerValue(headers, 'x-should-retry')
  if (directive === 'true') return { retryable: true }
  if (directive === 'false') return { retryable: false }

  if (status === 429) {
    const { hard, reason } = classifyRateLimit(headers, body)
    return hard
      ? { retryable: false, ...(reason ? { hardLimitReason: reason } : {}) }
      : { retryable: true }
  }

  if (status === 408 || status === 409) return { retryable: true }
  if (status >= 500) return { retryable: true }
  return { retryable: false }
}

/**
 * Whether Anthropic says this 1M-context request requires usage credits.
 *
 * Claude Code 2.1.260 recognizes these two messages only on HTTP 429, sets an
 * account-local `longContext1mCreditsBlocked` latch, and uses the 200k context
 * path afterwards (`context_1m_entitlement=credits_clamp_200k`). This does not
 * mean that 1M context is inherently paid extra usage; it is a server-directed
 * fallback for the account/request state reported by this response.
 */
export function isLongContextCreditsRequiredError(
  status: number,
  body = '',
): boolean {
  if (status !== 429) return false
  const text = body.toLowerCase()
  return (
    text.includes('extra usage is required for long context') ||
    text.includes('usage credits are required for long context')
  )
}

/**
 * Server-directed delay in milliseconds, or undefined when the response leaves
 * the pacing to the client. `retry-after` may be seconds or an HTTP date.
 */
export function retryAfterMs(headers: Headers): number | undefined {
  const explicitMs = headers.get('retry-after-ms')
  if (explicitMs) {
    const parsed = Number.parseFloat(explicitMs)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }

  const retryAfter = headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
    const at = Date.parse(retryAfter)
    if (Number.isFinite(at)) return Math.max(0, at - Date.now())
  }

  return undefined
}

/**
 * Backoff for `attempt` (0-based), matching the CLI's
 * `min(0.5 * 2^n, 8)s` scaled by a 0.75–1.0 jitter factor. Jitter spreads a
 * fleet of clients that were rate-limited by the same upstream event.
 */
export function backoffDelayMs(attempt: number, random = Math.random) {
  const exponential = Math.min(
    BASE_BACKOFF_SECONDS * 2 ** Math.max(0, attempt),
    MAX_BACKOFF_SECONDS,
  )
  return exponential * (1 - random() * JITTER_RATIO) * 1000
}

/** Server-directed delay when offered, otherwise the jittered backoff. */
export function nextRetryDelayMs(
  headers: Headers,
  attempt: number,
  random = Math.random,
) {
  return retryAfterMs(headers) ?? backoffDelayMs(attempt, random)
}
