/**
 * Low-priority mode for rate-limit bypass.
 *
 * When rate-limited, users can opt into a lower-priority queue using `/claude-low-priority`.
 * This module harvests the slow-* headers from API responses and manages activation state.
 *
 * Feature flag: tengu_toasty_breeze (server-side)
 *
 * Response headers:
 *   anthropic-ratelimit-unified-slow-offer: "treatment" | "control"
 *   anthropic-ratelimit-unified-slow-status: "active" | "not_needed" | "slot_busy" | "weekly_limit" | "budget_exhausted" | "ineligible" | "off"
 *   anthropic-ratelimit-unified-slow-retry-after: seconds until next retry
 *   anthropic-ratelimit-unified-slow-max-wait: maximum wait seconds
 *   anthropic-ratelimit-unified-slow-budget-utilization: 0-1 float
 *   anthropic-ratelimit-unified-slow-budget-reset: budget reset timestamp
 */

const SLOW_PREFIX = 'anthropic-ratelimit-unified-slow-'

export type LowPriorityOffer = 'treatment' | 'control' | 'unknown'

export type LowPriorityStatus =
  | 'active'
  | 'not_needed'
  | 'slot_busy'
  | 'weekly_limit'
  | 'budget_exhausted'
  | 'ineligible'
  | 'off'
  | 'unrecognized'

export interface LowPriorityState {
  /** Whether low-priority mode is available ("treatment" = available) */
  offer: LowPriorityOffer
  /** Current status of the low-priority queue */
  status: LowPriorityStatus
  /** Seconds until next retry allowed */
  retryAfterSeconds?: number
  /** Maximum wait time in seconds */
  maxWaitSeconds?: number
  /** Budget utilization (0-1) */
  budgetUtilization?: number
  /** Budget reset timestamp */
  budgetResetAt?: string
  /** When this state was captured */
  capturedAt: number
}

export interface LowPriorityActivation {
  /** Whether the user has enabled low-priority mode */
  enabled: boolean
  /** When the activation started */
  activatedAt?: number
  /** Total requests served in this activation */
  requestsServed: number
  /** Total wait time in this activation (ms) */
  totalWaitMs: number
  /** Number of retry attempts */
  attempts: number
  /** Last state from server */
  lastState?: LowPriorityState
}

function parseOffer(value: string | null): LowPriorityOffer {
  if (value === 'treatment') return 'treatment'
  if (value === 'control') return 'control'
  return 'unknown'
}

function parseStatus(value: string | null): LowPriorityStatus {
  const valid: LowPriorityStatus[] = [
    'active',
    'not_needed',
    'slot_busy',
    'weekly_limit',
    'budget_exhausted',
    'ineligible',
    'off',
  ]
  if (value && valid.includes(value as LowPriorityStatus)) {
    return value as LowPriorityStatus
  }
  return 'unrecognized'
}

function finiteNumber(value: string | null): number | undefined {
  if (value == null || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Check if response headers contain low-priority mode information.
 */
export function hasLowPriorityHeaders(headers: Headers): boolean {
  return (
    headers.has(`${SLOW_PREFIX}offer`) || headers.has(`${SLOW_PREFIX}status`)
  )
}

/**
 * Extract low-priority state from response headers.
 */
export function extractLowPriorityState(
  headers: Headers,
  now = Date.now(),
): LowPriorityState {
  const offer = parseOffer(headers.get(`${SLOW_PREFIX}offer`))
  const status = parseStatus(headers.get(`${SLOW_PREFIX}status`))
  const retryAfterSeconds = finiteNumber(
    headers.get(`${SLOW_PREFIX}retry-after`),
  )
  const maxWaitSeconds = finiteNumber(headers.get(`${SLOW_PREFIX}max-wait`))
  const budgetUtilization = finiteNumber(
    headers.get(`${SLOW_PREFIX}budget-utilization`),
  )
  const budgetResetRaw = finiteNumber(headers.get(`${SLOW_PREFIX}budget-reset`))
  const budgetResetAt = budgetResetRaw
    ? new Date(budgetResetRaw * 1000).toISOString()
    : undefined

  return {
    offer,
    status,
    retryAfterSeconds,
    maxWaitSeconds,
    budgetUtilization,
    budgetResetAt,
    capturedAt: now,
  }
}

/**
 * Check if low-priority mode is available based on server response.
 */
export function isLowPriorityAvailable(state: LowPriorityState): boolean {
  return state.offer === 'treatment'
}

/**
 * Check if the user should wait in low-priority mode.
 */
export function shouldWaitInLowPriority(state: LowPriorityState): boolean {
  return (
    state.offer === 'treatment' &&
    (state.status === 'active' || state.status === 'slot_busy')
  )
}

/**
 * Get a human-readable description of the low-priority status.
 */
export function describeLowPriorityStatus(state: LowPriorityState): string {
  switch (state.status) {
    case 'active':
      return 'Working at lower priority · waiting for capacity'
    case 'not_needed':
      return 'Low-priority mode available but not needed'
    case 'slot_busy':
      return 'Waiting for a low-priority slot'
    case 'weekly_limit':
      return 'Weekly low-priority budget reached'
    case 'budget_exhausted':
      return 'Low-priority budget exhausted'
    case 'ineligible':
      return 'Not eligible for low-priority mode'
    case 'off':
      return 'Low-priority mode is off'
    default:
      return 'Low-priority status unknown'
  }
}

/**
 * Format budget utilization as a percentage string.
 */
export function formatBudgetUtilization(
  utilization: number | undefined,
): string {
  if (utilization === undefined) return 'unknown'
  return `${Math.round(utilization * 100)}%`
}

// Default activation state
export function createDefaultActivation(): LowPriorityActivation {
  return {
    enabled: false,
    requestsServed: 0,
    totalWaitMs: 0,
    attempts: 0,
  }
}

// Constants from Claude Code binary
export const LOW_PRIORITY_CONSTANTS = {
  /** Default retry interval (ms) */
  DEFAULT_RETRY_INTERVAL_MS: 20000,
  /** Maximum wait time (ms) */
  MAX_WAIT_MS: 1200000, // 20 minutes
  /** Cooloff period (ms) */
  COOLOFF_MS: 600000, // 10 minutes
  /** Jitter factor */
  JITTER_FACTOR: 0.3,
} as const
