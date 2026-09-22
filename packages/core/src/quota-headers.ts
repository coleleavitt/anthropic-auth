import type {
  AccountQuotaWindow,
  OAuthQuotaSnapshot,
  QuotaWindowName,
} from './accounts.ts'

const PREFIX = 'anthropic-ratelimit-unified-'
const WINDOW_KEYS: Record<string, QuotaWindowName> = {
  '5h': 'five_hour',
  '7d': 'seven_day',
}

export function isQuotaBearingHeaderFrame(headers: Headers): boolean {
  return Object.keys(WINDOW_KEYS).some((suffix) =>
    Number.isFinite(
      finiteHeaderNumber(headers, `${PREFIX}${suffix}-utilization`),
    ),
  )
}

function finiteHeaderNumber(headers: Headers, name: string) {
  const value = headers.get(name)
  if (value == null || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeWindow(
  headers: Headers,
  suffix: string,
  checkedAt: number,
): AccountQuotaWindow | undefined {
  const utilization = finiteHeaderNumber(
    headers,
    `${PREFIX}${suffix}-utilization`,
  )
  if (utilization == null) return undefined
  const usedPercent = Math.min(100, Math.max(0, Math.round(utilization * 100)))
  const resetSeconds = finiteHeaderNumber(headers, `${PREFIX}${suffix}-reset`)
  const resetDate =
    resetSeconds == null ? undefined : new Date(resetSeconds * 1000)
  const resetsAt =
    resetDate && Number.isFinite(resetDate.getTime())
      ? resetDate.toISOString()
      : undefined
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    ...(resetsAt && { resetsAt }),
    checkedAt,
  }
}

// ============================================================================
// Overage/Grace Status Headers
// ============================================================================

export type OverageStatus = 'active' | 'available' | 'disabled' | 'unknown'
export type OverageScope = 'org' | 'user' | 'unknown'

export interface OverageState {
  /** Current overage status */
  status: OverageStatus
  /** Why overage is disabled (if applicable) */
  disabledReason?: string
  /** Scope of overage (org or user level) */
  scope: OverageScope
  /** Whether overage is currently in use */
  inUse: boolean
}

function parseOverageStatus(value: string | null): OverageStatus {
  if (value === 'active') return 'active'
  if (value === 'available') return 'available'
  if (value === 'disabled') return 'disabled'
  return 'unknown'
}

function parseOverageScope(value: string | null): OverageScope {
  if (value === 'org') return 'org'
  if (value === 'user') return 'user'
  return 'unknown'
}

export function extractOverageState(
  headers: Headers,
): OverageState | undefined {
  const status = headers.get(`${PREFIX}overage-status`)
  if (!status) return undefined

  return {
    status: parseOverageStatus(status),
    disabledReason:
      headers.get(`${PREFIX}overage-disabled-reason`) ?? undefined,
    scope: parseOverageScope(headers.get(`${PREFIX}overage-scope`)),
    inUse: headers.get(`${PREFIX}overage-in-use`) === 'true',
  }
}

// ============================================================================
// Grace Period Headers
// ============================================================================

export interface GraceState {
  /** Whether grace period is active */
  active: boolean
  /** Grace utilization (0-1) */
  utilization?: number
  /** Grace reset timestamp */
  resetsAt?: string
}

export function extractGraceState(headers: Headers): GraceState | undefined {
  // Check for any grace-related headers
  const utilization = finiteHeaderNumber(headers, `${PREFIX}grace-utilization`)
  const resetSeconds = finiteHeaderNumber(headers, `${PREFIX}grace-reset`)

  if (utilization === undefined && resetSeconds === undefined) {
    return undefined
  }

  const resetDate =
    resetSeconds == null ? undefined : new Date(resetSeconds * 1000)
  const resetsAt =
    resetDate && Number.isFinite(resetDate.getTime())
      ? resetDate.toISOString()
      : undefined

  return {
    active: utilization !== undefined && utilization > 0,
    utilization,
    resetsAt,
  }
}

// ============================================================================
// Main Quota Header Normalization
// ============================================================================

export function normalizeQuotaHeaders(
  headers: Headers,
  now = Date.now(),
): OAuthQuotaSnapshot {
  const snapshot: OAuthQuotaSnapshot = {
    fallbackAdvised: headers.get(`${PREFIX}fallback`) === 'available',
    source: 'headers',
    checkedAt: now,
  }
  for (const [suffix, key] of Object.entries(WINDOW_KEYS)) {
    const window = normalizeWindow(headers, suffix, now)
    if (window) snapshot[key] = window
  }
  const representativeClaim = headers.get(`${PREFIX}representative-claim`)
  if (representativeClaim) {
    snapshot.bindingWindow = representativeClaim
    snapshot.bindingWindowSource = 'headers'
  }
  return snapshot
}

export function mergeHeaderQuotaSnapshot(
  existing: OAuthQuotaSnapshot | undefined,
  incoming: OAuthQuotaSnapshot,
): OAuthQuotaSnapshot {
  return {
    ...existing,
    ...incoming,
    scoped: existing && 'scoped' in existing ? existing.scoped : undefined,
    extraUsage: existing?.extraUsage,
    bindingWindow:
      existing?.bindingWindowSource === 'poll'
        ? existing.bindingWindow
        : (incoming.bindingWindow ?? existing?.bindingWindow),
    bindingWindowSource:
      existing?.bindingWindowSource === 'poll'
        ? 'poll'
        : (incoming.bindingWindowSource ?? existing?.bindingWindowSource),
    // Source tracks 5h/7d freshness; preserved scoped and credit fields remain poll-owned.
    source: 'headers',
  }
}
