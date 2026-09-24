/**
 * Refusal guard — the surrogate-driven closed loop.
 *
 * Runs the normal content filter, then asks the trained surrogate for P(refuse)
 * on the resulting wire body. If the body still looks refusal-bound, it RE-FILTERS
 * the ORIGINAL body with progressively lower eviction floors, re-scoring each
 * time, and keeps the lowest-scoring version. This turns eviction from a fixed
 * heuristic into a measured optimization against Anthcode techniqueic's own past decisions.
 *
 * Fail-open: any surrogate error returns the plain filtered body unchanged.
 */
import {
  type ContentFilterSummary,
  type EvictionOverride,
  filterRequestBody,
} from './content-filter'
import { getSurrogateThreshold, predictRefusal } from './refusal-surrogate'

export interface RefusalGuardResult {
  body: Record<string, unknown>
  filtered: boolean
  changes: string[]
  summary: ContentFilterSummary
  surrogate: {
    probabilityBefore: number
    probabilityAfter: number
    threshold: number
    escalations: number
    danger: boolean
  }
}

// Escalation ladder: each step forces a lower eviction floor (chars). The
// tool_use floor tracks at half the text floor (min 60). Ordered most→least
// conservative; the loop stops as soon as P(refuse) clears the threshold.
const FLOOR_LADDER = [800, 400, 200, 120, 60] as const

function guardInner(body: Record<string, unknown>): RefusalGuardResult {
  const base = filterRequestBody(body)
  const threshold = getSurrogateThreshold()

  let before: { probability: number; danger: boolean }
  try {
    before = predictRefusal(base.body)
  } catch {
    // Fail-open: surrogate unavailable -> ship the normally filtered body.
    return {
      ...base,
      surrogate: {
        probabilityBefore: 0,
        probabilityAfter: 0,
        threshold,
        escalations: 0,
        danger: false,
      },
    }
  }

  if (!before.danger) {
    return {
      ...base,
      surrogate: {
        probabilityBefore: before.probability,
        probabilityAfter: before.probability,
        threshold,
        escalations: 0,
        danger: false,
      },
    }
  }

  // Danger: escalate eviction until we clear the threshold or exhaust the ladder.
  let best = base
  let bestP = before.probability
  let escalations = 0
  for (const floor of FLOOR_LADDER) {
    const override: EvictionOverride = {
      evictFloor: floor,
      evictToolUseFloor: Math.max(60, Math.floor(floor / 2)),
    }
    const attempt = filterRequestBody(body, override)
    escalations++
    let p: number
    try {
      p = predictRefusal(attempt.body).probability
    } catch {
      break
    }
    if (p < bestP) {
      best = attempt
      bestP = p
    }
    if (p < threshold) break
  }

  return {
    ...best,
    surrogate: {
      probabilityBefore: before.probability,
      probabilityAfter: bestP,
      threshold,
      escalations,
      danger: bestP >= threshold,
    },
  }
}

/**
 * Content filter + closed-loop surrogate guard.
 *
 * Also copies the surrogate result onto `summary` (surrogateBefore/After/
 * Escalations/Danger), so every host that logs the summary to
 * content-filter-outcomes.jsonl records the surrogate fields without changes
 * to its own code.
 */
export function filterRequestBodyGuarded(
  body: Record<string, unknown>,
): RefusalGuardResult {
  const result = guardInner(body)
  const s = result.surrogate
  if (result.summary) {
    result.summary.surrogateBefore = round4(s.probabilityBefore)
    result.summary.surrogateAfter = round4(s.probabilityAfter)
    result.summary.surrogateEscalations = s.escalations
    result.summary.surrogateDanger = s.danger
  }
  return result
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}
