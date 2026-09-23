/**
 * Refusal-count-based suggestions for content filter recovery.
 *
 * When requests are refused, provide escalating suggestions based on
 * how many refusals have occurred in the current session/context.
 */

export type RefusalSeverity = 'info' | 'warning' | 'critical'
export type SuggestedAction = 'reframe' | 'pivot' | 'split'

export interface RefusalSuggestion {
  message: string
  severity: RefusalSeverity
  suggestedAction: SuggestedAction
  reframeSuggestions?: string[]
}

/**
 * Generate reframe suggestions for a given topic.
 *
 * These alternative phrasings help users approach sensitive topics
 * at a higher abstraction level that may avoid content filters.
 */
export function generateReframeSuggestions(topic: string): string[] {
  const trimmedTopic = topic.trim()
  if (!trimmedTopic) {
    return []
  }

  return [
    `What's the theory behind ${trimmedTopic}?`,
    `How do defenders approach ${trimmedTopic}?`,
    `Compare approaches to ${trimmedTopic}`,
    `What are the tradeoffs of ${trimmedTopic}?`,
  ]
}

/**
 * Get a suggestion based on the current refusal count.
 *
 * @param refusalCount - Number of refusals in the current context (1-indexed)
 * @param topic - Optional topic string for generating reframe suggestions
 * @returns Appropriate suggestion for the refusal count
 */
export function getRefusalSuggestion(
  refusalCount: number,
  topic?: string,
): RefusalSuggestion {
  // Normalize to at least 1
  const count = Math.max(1, Math.floor(refusalCount))

  if (count === 1) {
    return {
      message: 'Try rephrasing at a higher abstraction level',
      severity: 'info',
      suggestedAction: 'reframe',
      reframeSuggestions: topic ? generateReframeSuggestions(topic) : undefined,
    }
  }

  if (count === 2) {
    return {
      message: 'Consider a different approach to this topic',
      severity: 'warning',
      suggestedAction: 'pivot',
    }
  }

  // 3+ refusals
  return {
    message: 'Session is hot. Recommend: /claude-split',
    severity: 'critical',
    suggestedAction: 'split',
  }
}
