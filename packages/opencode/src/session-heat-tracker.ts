/**
 * Session heat tracking integration for OpenCode.
 * Maintains per-session heat state and integrates with sidebar display.
 */

import {
  createSessionHeatState,
  getRefusalSuggestion,
  type HeatLevel,
  type RefusalSuggestion,
  type SessionHeatState,
  updateSessionHeat,
} from '@cortexkit/anthropic-auth-core'

// Track heat state per session
const sessionHeatStates = new Map<string, SessionHeatState>()

// Maximum sessions to track (LRU-style cleanup)
const MAX_SESSIONS = 100

/**
 * Get or create heat state for a session.
 */
export function getSessionHeat(sessionId: string): SessionHeatState {
  let state = sessionHeatStates.get(sessionId)
  if (!state) {
    state = createSessionHeatState(sessionId)
    sessionHeatStates.set(sessionId, state)

    // LRU cleanup if too many sessions
    if (sessionHeatStates.size > MAX_SESSIONS) {
      const oldest = sessionHeatStates.keys().next().value
      if (oldest) sessionHeatStates.delete(oldest)
    }
  }
  return state
}

/**
 * Record a turn completion and update heat state.
 * Call after each response completes.
 */
export function recordTurn(
  sessionId: string,
  refused: boolean,
): SessionHeatState {
  const current = getSessionHeat(sessionId)
  const updated = updateSessionHeat(current, refused)
  sessionHeatStates.set(sessionId, updated)
  return updated
}

/**
 * Get suggestion for current heat state.
 */
export function getHeatSuggestion(
  state: SessionHeatState,
  topic?: string,
): RefusalSuggestion | undefined {
  if (state.refusalCount > 0) {
    return getRefusalSuggestion(state.refusalCount, topic)
  }

  // Warn at warm level even without refusals
  if (state.level === 'warm') {
    return {
      message: 'Session is warming up. Monitor for refusals.',
      severity: 'info',
      suggestedAction: 'reframe',
    }
  }

  if (state.level === 'hot') {
    return {
      message: 'Session is hot. Consider starting a new session.',
      severity: 'warning',
      suggestedAction: 'split',
    }
  }

  return undefined
}

/**
 * Format heat state for sidebar display.
 */
export function formatHeatForSidebar(state: SessionHeatState): {
  turn: number
  refusalCount: number
  heat: number
  level: HeatLevel
  suggestion?: string
} {
  const suggestion = getHeatSuggestion(state)
  return {
    turn: state.turn,
    refusalCount: state.refusalCount,
    heat: state.heat,
    level: state.level,
    suggestion: suggestion?.message,
  }
}

/**
 * Clear heat state for a session (e.g., on session end).
 */
export function clearSessionHeat(sessionId: string): void {
  sessionHeatStates.delete(sessionId)
}

/**
 * Get all tracked sessions (for debugging).
 */
export function getTrackedSessions(): string[] {
  return Array.from(sessionHeatStates.keys())
}
