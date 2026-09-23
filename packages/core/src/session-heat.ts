/**
 * Session heat tracking with turn-based hazard model.
 *
 * Uses a Weibull-style cumulative hazard to estimate refusal probability:
 *   H(t) = λ * t^k / k  where λ = 0.000009, k = 2.5
 *   P(refusal) = 1 - exp(-H(t))
 *
 * After a refusal, hazard is boosted 10x for subsequent turns.
 */

export type HeatLevel = 'safe' | 'warm' | 'hot'

export interface SessionHeatState {
  sessionId: string
  turn: number
  refusalCount: number
  heat: number // P(refusal)
  level: HeatLevel
  firstRefusalTurn?: number
}

// Hazard model parameters (tuned from real data)
const LAMBDA = 0.000009
const K = 2.5
const REFUSAL_BOOST = 10

// Level thresholds
const WARM_THRESHOLD = 0.1
const HOT_THRESHOLD = 0.3

/**
 * Compute cumulative hazard H(t) = λ * t^k / k
 */
function cumulativeHazard(turn: number): number {
  if (turn <= 0) return 0
  return (LAMBDA * turn ** K) / K
}

/**
 * Compute heat (refusal probability) from turn count.
 * P(refusal) = 1 - exp(-H(t))
 *
 * @param turn - Current turn number (1-indexed)
 * @param hadRefusal - Whether a refusal occurred (applies 10x boost)
 */
export function computeHeat(turn: number, hadRefusal: boolean): number {
  if (turn <= 0) return 0

  let hazard = cumulativeHazard(turn)
  if (hadRefusal) {
    hazard *= REFUSAL_BOOST
  }

  // P(refusal) = 1 - exp(-H)
  const heat = 1 - Math.exp(-hazard)

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, heat))
}

/**
 * Get heat level from probability value.
 */
export function getHeatLevel(heat: number): HeatLevel {
  if (heat >= HOT_THRESHOLD) return 'hot'
  if (heat >= WARM_THRESHOLD) return 'warm'
  return 'safe'
}

/**
 * Create initial session heat state.
 */
export function createSessionHeatState(sessionId: string): SessionHeatState {
  return {
    sessionId,
    turn: 0,
    refusalCount: 0,
    heat: 0,
    level: 'safe',
  }
}

/**
 * Update session heat state after a turn.
 *
 * @param state - Current session state
 * @param refused - Whether the turn was refused
 * @returns Updated state (immutable update)
 */
export function updateSessionHeat(
  state: SessionHeatState,
  refused: boolean,
): SessionHeatState {
  const turn = state.turn + 1
  const refusalCount = refused ? state.refusalCount + 1 : state.refusalCount
  const hadRefusal = refusalCount > 0
  const firstRefusalTurn =
    refused && state.firstRefusalTurn === undefined
      ? turn
      : state.firstRefusalTurn

  const heat = computeHeat(turn, hadRefusal)
  const level = getHeatLevel(heat)

  return {
    sessionId: state.sessionId,
    turn,
    refusalCount,
    heat,
    level,
    firstRefusalTurn,
  }
}

/**
 * Hazard model constants for testing/inspection.
 */
export const HAZARD_MODEL = {
  lambda: LAMBDA,
  k: K,
  refusalBoost: REFUSAL_BOOST,
  warmThreshold: WARM_THRESHOLD,
  hotThreshold: HOT_THRESHOLD,
} as const
