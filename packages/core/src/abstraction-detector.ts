/**
 * Abstraction level detector for query classification.
 * Classifies queries into concrete, procedural, conceptual, or meta levels.
 */

export type AbstractionLevel = 'concrete' | 'procedural' | 'conceptual' | 'meta'

export interface AbstractionAnalysis {
  level: AbstractionLevel
  confidence: number // 0-1
  suggestedReframe?: string // If concrete, suggest higher abstraction
  riskScore: number // concrete=0.9, procedural=0.6, conceptual=0.3, meta=0.1
}

// Pattern definitions for each abstraction level
// Higher weight patterns should come first within each level
const CONCRETE_PATTERNS = [
  /\b(show\s+me|give\s+me|write|implement|create|build|code\s+for|generate|make|add)\b/i,
  /\b(the\s+code\s+for|snippet|example\s+code)\b/i,
  /\bfix\s+(this|the|my)\b/i,
  /\b(refactor|modify|change|update|edit)\s+(the|this|my)?\s*(code|file|function|class)?\b/i,
]

const PROCEDURAL_PATTERNS = [
  /\b(step\s+by\s+step|steps?\s+to|steps?\s+for)\b/i,
  /\bprocedure\s+(for|to)\b/i,
  /\bprocess\s+for\b/i,
  /\b(how\s+do\s+I|how\s+can\s+I|how\s+to|how\s+would\s+I)\b/i,
  /\b(walk\s+(me\s+)?through|guide\s+me|instructions?)\b/i,
  /\b(workflow|sequence|order\s+of)\b/i,
]

const CONCEPTUAL_PATTERNS = [
  /\b(how\s+does|what\s+is|what\s+are|explain|describe|tell\s+me\s+about)\b/i,
  /\b(works?|meaning|definition|purpose|role\s+of)\b/i,
  /\b(understand|concept|idea|principle|fundamentals?)\b/i,
  /\bwhy\s+(does|is|do|are)\b/i,
]

const META_PATTERNS = [
  /\b(tradeoffs?|trade-offs?|pros\s+and\s+cons|advantages?\s+and\s+disadvantages?)\b/i,
  /\b(compare|comparison|versus|vs\.?|alternatives?)\b/i,
  /\b(approaches?\s+(to|for|can)|strategies?\s+for|options?\s+for|ways?\s+to)\b/i,
  /\b(best\s+practices?|when\s+to\s+use|when\s+should|considerations?)\b/i,
  /\b(implications?|consequences?|impact\s+of)\b/i,
]

const RISK_SCORES: Record<AbstractionLevel, number> = {
  concrete: 0.9,
  procedural: 0.6,
  conceptual: 0.3,
  meta: 0.1,
}

// Priority weights for tie-breaking (higher = preferred when counts are equal)
const LEVEL_PRIORITY: Record<AbstractionLevel, number> = {
  meta: 4,
  procedural: 3, // procedural beats conceptual in ties (more specific intent)
  conceptual: 2,
  concrete: 1,
}

interface PatternMatch {
  level: AbstractionLevel
  matchCount: number
  patterns: RegExp[]
  priority: number
}

function countPatternMatches(query: string, patterns: RegExp[]): number {
  return patterns.filter((p) => p.test(query)).length
}

function getAllMatches(query: string): PatternMatch[] {
  return [
    {
      level: 'meta',
      matchCount: countPatternMatches(query, META_PATTERNS),
      patterns: META_PATTERNS,
      priority: LEVEL_PRIORITY.meta,
    },
    {
      level: 'procedural',
      matchCount: countPatternMatches(query, PROCEDURAL_PATTERNS),
      patterns: PROCEDURAL_PATTERNS,
      priority: LEVEL_PRIORITY.procedural,
    },
    {
      level: 'conceptual',
      matchCount: countPatternMatches(query, CONCEPTUAL_PATTERNS),
      patterns: CONCEPTUAL_PATTERNS,
      priority: LEVEL_PRIORITY.conceptual,
    },
    {
      level: 'concrete',
      matchCount: countPatternMatches(query, CONCRETE_PATTERNS),
      patterns: CONCRETE_PATTERNS,
      priority: LEVEL_PRIORITY.concrete,
    },
  ]
}

/**
 * Detect the abstraction level of a query.
 * Uses pattern matching to classify queries into concrete, procedural, conceptual, or meta levels.
 */
export function detectAbstractionLevel(query: string): AbstractionAnalysis {
  const normalizedQuery = query.trim().toLowerCase()

  if (!normalizedQuery) {
    return {
      level: 'conceptual',
      confidence: 0,
      riskScore: RISK_SCORES.conceptual,
    }
  }

  const matches = getAllMatches(normalizedQuery)
  const totalMatches = matches.reduce((sum, m) => sum + m.matchCount, 0)

  // Default fallback in case matches is empty
  const defaultMatch: PatternMatch = {
    level: 'conceptual',
    matchCount: 0,
    patterns: [],
    priority: LEVEL_PRIORITY.conceptual,
  }

  // Find the level with the most matches, using priority for tie-breaking
  let bestMatch: PatternMatch = matches[0] ?? defaultMatch
  for (const match of matches) {
    if (match.matchCount > bestMatch.matchCount) {
      bestMatch = match
    } else if (
      match.matchCount === bestMatch.matchCount &&
      match.matchCount > 0
    ) {
      // Tie-break by priority (meta > procedural > conceptual > concrete)
      if (match.priority > bestMatch.priority) {
        bestMatch = match
      }
    }
  }

  // Calculate confidence based on match strength
  let confidence: number
  if (totalMatches === 0) {
    // No patterns matched — default to conceptual with low confidence
    bestMatch = defaultMatch
    confidence = 0.3
  } else if (bestMatch.matchCount === 0) {
    confidence = 0.3
  } else {
    // Confidence based on how dominant the winning pattern is
    const dominance = bestMatch.matchCount / Math.max(totalMatches, 1)
    const patternCoverage =
      bestMatch.matchCount / Math.max(bestMatch.patterns.length, 1)
    confidence = Math.min(0.95, 0.5 + dominance * 0.3 + patternCoverage * 0.2)
  }

  const result: AbstractionAnalysis = {
    level: bestMatch.level,
    confidence: Math.round(confidence * 100) / 100,
    riskScore: RISK_SCORES[bestMatch.level],
  }

  // Add suggested reframe for concrete queries
  if (bestMatch.level === 'concrete') {
    const reframe = suggestHigherAbstraction(query, 'concrete')
    if (reframe) {
      result.suggestedReframe = reframe
    }
  }

  return result
}

/**
 * Suggest how to reframe a query at a higher abstraction level.
 * Returns null if already at meta level or if no good reframe is available.
 */
export function suggestHigherAbstraction(
  query: string,
  currentLevel: AbstractionLevel,
): string | null {
  if (currentLevel === 'meta') {
    return null
  }

  const normalizedQuery = query.trim()
  if (!normalizedQuery) {
    return null
  }

  // Extract the core topic from the query
  const topic = extractCoreTopic(normalizedQuery)
  if (!topic) {
    return null
  }

  switch (currentLevel) {
    case 'concrete':
      // Suggest procedural or conceptual framing
      return `What are the key considerations when implementing ${topic}?`

    case 'procedural':
      // Suggest conceptual framing
      return `What is the underlying principle behind ${topic}?`

    case 'conceptual':
      // Suggest meta framing
      return `What are the tradeoffs and alternatives when approaching ${topic}?`

    default:
      return null
  }
}

/**
 * Extract the core topic from a query by removing common imperative/question phrases.
 */
function extractCoreTopic(query: string): string | null {
  // Remove common prefixes
  const prefixPatterns = [
    /^(show\s+me\s+(the\s+)?(code\s+for\s+)?)/i,
    /^(give\s+me\s+(the\s+)?)/i,
    /^(write\s+(me\s+)?)/i,
    /^(implement\s+)/i,
    /^(create\s+(a\s+)?)/i,
    /^(build\s+(a\s+)?)/i,
    /^(how\s+do\s+I\s+)/i,
    /^(how\s+can\s+I\s+)/i,
    /^(how\s+to\s+)/i,
    /^(how\s+does\s+)/i,
    /^(what\s+is\s+(a\s+|an\s+|the\s+)?)/i,
    /^(what\s+are\s+(the\s+)?)/i,
    /^(explain\s+(the\s+)?)/i,
    /^(describe\s+(the\s+)?)/i,
    /^(tell\s+me\s+about\s+(the\s+)?)/i,
  ]

  let topic = query
  for (const pattern of prefixPatterns) {
    topic = topic.replace(pattern, '')
  }

  // Remove trailing punctuation
  topic = topic.replace(/[?.!]+$/, '').trim()

  // Return null if topic is too short or unchanged
  if (topic.length < 3 || topic === query) {
    // Try to extract quoted or emphasized text
    const quotedMatch = query.match(/["']([^"']+)["']/)
    if (quotedMatch?.[1]) {
      return quotedMatch[1].trim()
    }

    // Fall back to last few words if the query is long enough
    const words = query.split(/\s+/)
    if (words.length >= 3) {
      return words
        .slice(-3)
        .join(' ')
        .replace(/[?.!]+$/, '')
    }

    return null
  }

  return topic
}
